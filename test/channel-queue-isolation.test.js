import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { buildCollectionChannelPlans, collectionPlanAlreadyActive } from '../src/services/channel-job-scheduler.js';

const root = path.resolve(import.meta.dirname, '..');

const splitConfig = {
  channelSplitEnabled: true,
  platformChannelSplitDouyin: true
};

test('平台灰度开关开启后，私信与评论生成互不覆盖的逻辑采集任务', () => {
  const plans = buildCollectionChannelPlans({ platformCode: 'douyin', requestedTypes: ['COMMENT', 'PRIVATE_MESSAGE'], featureConfig: splitConfig });
  assert.deepEqual(plans.map(item => item.channelType), ['COMMENT', 'PRIVATE_MESSAGE']);
  assert.deepEqual(plans.map(item => item.types), [['COMMENT'], ['PRIVATE_MESSAGE']]);
  assert.notEqual(plans[0].idempotencySuffix, plans[1].idempotencySuffix);
  assert.equal(collectionPlanAlreadyActive([{ accountId: 1, channelType: 'COMMENT' }], 1, plans[0]), true);
  assert.equal(collectionPlanAlreadyActive([{ accountId: 1, channelType: 'COMMENT' }], 1, plans[1]), false);
});

test('总开关或平台开关关闭时保持原合并采集架构', () => {
  const plans = buildCollectionChannelPlans({ platformCode: 'douyin', requestedTypes: ['COMMENT', 'PRIVATE_MESSAGE'], featureConfig: { channelSplitEnabled: false, platformChannelSplitDouyin: true } });
  assert.equal(plans.length, 1);
  assert.equal(plans[0].channelType, null);
  assert.deepEqual(plans[0].types, ['COMMENT', 'PRIVATE_MESSAGE']);
});

async function freePort() {
  const server = http.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function waitFor(base) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { if ((await fetch(`${base}/api/health`)).ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('测试服务启动超时');
}

async function post(base, pathname, body) {
  const response = await fetch(base + pathname, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { response, data: await response.json() };
}

test('服务端按通道创建两个采集 Job，回复任务按最早等待时间领取', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'channel-queue-isolation-'));
  const dbPath = path.join(dir, 'test.db');
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port), DATABASE_PATH: dbPath,
      AUTH_ENABLED: 'false', AGENT_SHARED_TOKEN: '', QWEN_MODE: 'mock', RPA_MODE: 'simulated',
      AUTO_COLLECT_ENABLED: 'false', LOCAL_AGENT_AUTO_START: 'false', INSTANCE_LOCK_ENABLED: 'false',
      CHANNEL_SPLIT_ENABLED: 'true', PLATFORM_CHANNEL_SPLIT_DOUYIN: 'true'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await Promise.race([new Promise(resolve => child.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 3000))]);
    }
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  await waitFor(base);
  const bootstrap = await (await fetch(`${base}/api/bootstrap`)).json();
  const account = bootstrap.accounts.find(item => item.platform_code === 'douyin');
  assert.ok(account, stderr);

  const queued = await post(base, '/api/platforms/douyin/collect', { accountId: account.id, types: ['COMMENT', 'PRIVATE_MESSAGE'] });
  assert.equal(queued.response.status, 200, stderr);
  assert.equal(queued.data.jobIds.length, 2);
  let runtimeResponse = await (await fetch(`${base}/api/messages`)).json();
  const queuedStates = runtimeResponse.channelRuntimeStates.filter(item => item.platform_code === 'douyin' && Number(item.account_id) === Number(account.id));
  assert.deepEqual(queuedStates.map(item => item.channel_type).sort(), ['COMMENT', 'PRIVATE_MESSAGE']);
  assert.ok(queuedStates.every(item => item.state === 'QUEUED'));

  let db = new DatabaseSync(dbPath);
  const collectionJobs = db.prepare(`SELECT id,channel_type,queue_lane,payload FROM agent_jobs WHERE id IN (?,?) ORDER BY id`).all(...queued.data.jobIds);
  assert.deepEqual(collectionJobs.map(item => item.channel_type), ['COMMENT', 'PRIVATE_MESSAGE']);
  assert.deepEqual(collectionJobs.map(item => JSON.parse(item.payload).types), [['COMMENT'], ['PRIVATE_MESSAGE']]);
  db.prepare("UPDATE agent_jobs SET status='RUNNING',claimed_at=? WHERE id IN (?,?)").run(new Date().toISOString(), ...queued.data.jobIds);
  db.close();

  const commentCompleted = await post(base, `/api/agent/jobs/${queued.data.jobIds[0]}/complete`, {
    status: 'SUCCESS',
    result: { messages: [], message: '评论同步完成', typeResults: [{ type: 'COMMENT', status: 'SUCCESS', count: 0 }] }
  });
  assert.equal(commentCompleted.response.status, 200, stderr);
  const privateCompleted = await post(base, `/api/agent/jobs/${queued.data.jobIds[1]}/complete`, {
    status: 'NEEDS_CONFIRMATION',
    result: { messages: [], message: '私信页面未可靠加载', typeResults: [{ type: 'PRIVATE_MESSAGE', status: 'NEEDS_CONFIRMATION', reason: 'PAGE_UNAVAILABLE', message: '私信页面未可靠加载', count: 0 }] }
  });
  assert.equal(privateCompleted.response.status, 200, stderr);

  runtimeResponse = await (await fetch(`${base}/api/messages`)).json();
  const commentRuntime = runtimeResponse.channelRuntimeStates.find(item => item.platform_code === 'douyin' && Number(item.account_id) === Number(account.id) && item.channel_type === 'COMMENT');
  const privateRuntime = runtimeResponse.channelRuntimeStates.find(item => item.platform_code === 'douyin' && Number(item.account_id) === Number(account.id) && item.channel_type === 'PRIVATE_MESSAGE');
  assert.equal(commentRuntime.state, 'IDLE');
  assert.ok(commentRuntime.last_scan_completed_at);
  assert.equal(privateRuntime.state, 'DEGRADED');
  assert.equal(privateRuntime.last_error_code, 'PAGE_UNAVAILABLE');
  assert.match(privateRuntime.last_error_message, /私信页面未可靠加载/);

  db = new DatabaseSync(dbPath);
  const stamp = new Date().toISOString();
  const firstMessageId = Number(db.prepare(`INSERT INTO messages(platform_code,account_id,message_type,external_id,user_name,content,status,decision,reply_text,created_at,updated_at)
    VALUES(?,?,?,?,?,?,'REPLY_QUEUED','AUTO_REPLY','回复A',?,?)`).run('douyin', account.id, 'PRIVATE_MESSAGE', `queue-first-${Date.now()}`, '用户A', '内容A', stamp, stamp).lastInsertRowid);
  const secondMessageId = Number(db.prepare(`INSERT INTO messages(platform_code,account_id,message_type,external_id,user_name,content,status,decision,reply_text,created_at,updated_at)
    VALUES(?,?,?,?,?,?,'REPLY_QUEUED','AUTO_REPLY','回复B',?,?)`).run('douyin', account.id, 'PRIVATE_MESSAGE', `queue-second-${Date.now()}`, '用户B', '内容B', stamp, stamp).lastInsertRowid);
  const laterWaitingJob = Number(db.prepare(`INSERT INTO agent_jobs(device_id,job_type,payload,status,attempts,created_at,available_at,channel_type,first_pending_at)
    VALUES(?,'REPLY',?,'QUEUED',0,?,?,?,?)`).run(account.device_id, JSON.stringify({ messageId: firstMessageId, platformCode: 'douyin', accountId: account.id, messageType: 'PRIVATE_MESSAGE' }), stamp, stamp, 'PRIVATE_MESSAGE', '2026-08-24T12:00:00.000Z').lastInsertRowid);
  const earliestWaitingJob = Number(db.prepare(`INSERT INTO agent_jobs(device_id,job_type,payload,status,attempts,created_at,available_at,channel_type,first_pending_at)
    VALUES(?,'REPLY',?,'QUEUED',0,?,?,?,?)`).run(account.device_id, JSON.stringify({ messageId: secondMessageId, platformCode: 'douyin', accountId: account.id, messageType: 'PRIVATE_MESSAGE' }), stamp, stamp, 'PRIVATE_MESSAGE', '2026-08-24T10:00:00.000Z').lastInsertRowid);
  db.prepare('UPDATE messages SET reply_job_id=? WHERE id=?').run(laterWaitingJob, firstMessageId);
  db.prepare('UPDATE messages SET reply_job_id=? WHERE id=?').run(earliestWaitingJob, secondMessageId);
  db.close();

  const claimed = await post(base, '/api/agent/jobs/claim', { deviceId: account.device_id });
  assert.equal(claimed.response.status, 200, stderr);
  assert.equal(claimed.data.job.id, earliestWaitingJob);
});


test('领取接口按通道并发，同通道与平台独占任务保持互斥', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'channel-claim-lock-'));
  const dbPath = path.join(dir, 'test.db');
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port), DATABASE_PATH: dbPath,
      AUTH_ENABLED: 'false', AGENT_SHARED_TOKEN: '', QWEN_MODE: 'mock', RPA_MODE: 'simulated',
      AUTO_COLLECT_ENABLED: 'false', LOCAL_AGENT_AUTO_START: 'false', INSTANCE_LOCK_ENABLED: 'false',
      CHANNEL_SPLIT_ENABLED: 'true', PLATFORM_CHANNEL_SPLIT_DOUYIN: 'true'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await Promise.race([new Promise(resolve => child.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 3000))]);
    }
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  await waitFor(base);
  const bootstrap = await (await fetch(`${base}/api/bootstrap`)).json();
  const account = bootstrap.accounts.find(item => item.platform_code === 'douyin');
  assert.ok(account, stderr);

  const queued = await post(base, '/api/platforms/douyin/collect', { accountId: account.id, types: ['COMMENT', 'PRIVATE_MESSAGE'] });
  assert.equal(queued.response.status, 200, stderr);
  assert.equal(queued.data.jobIds.length, 2);

  const privateClaim = await post(base, '/api/agent/jobs/claim', {
    deviceId: account.device_id,
    platformCodes: ['DOUYIN'],
    queueLanes: ['private_message']
  });
  assert.equal(privateClaim.response.status, 200, stderr);
  assert.equal(privateClaim.data.job.channel_type, 'PRIVATE_MESSAGE');
  assert.deepEqual(privateClaim.data.queueLanes, ['PRIVATE_MESSAGE']);

  const commentClaim = await post(base, '/api/agent/jobs/claim', {
    deviceId: account.device_id,
    platformCodes: ['douyin'],
    channelTypes: ['COMMENT']
  });
  assert.equal(commentClaim.response.status, 200, stderr);
  assert.equal(commentClaim.data.job.channel_type, 'COMMENT');

  let db = new DatabaseSync(dbPath);
  const runningJobs = db.prepare("SELECT channel_type,status FROM agent_jobs WHERE id IN (?,?) ORDER BY channel_type").all(privateClaim.data.job.id, commentClaim.data.job.id);
  assert.deepEqual(runningJobs.map(item => ({ channel_type: item.channel_type, status: item.status })), [
    { channel_type: 'COMMENT', status: 'RUNNING' },
    { channel_type: 'PRIVATE_MESSAGE', status: 'RUNNING' }
  ]);
  const stamp = new Date().toISOString();
  const secondCommentJobId = Number(db.prepare(`INSERT INTO agent_jobs(device_id,job_type,payload,status,created_at,available_at,channel_type,queue_lane,first_pending_at,priority)
    VALUES(?, 'COLLECT_MESSAGES', ?, 'QUEUED', ?, ?, 'COMMENT', 'COMMENT', ?, 100)`).run(
      account.device_id,
      JSON.stringify({ platformCode: 'douyin', accountId: account.id, channelType: 'COMMENT', queueLane: 'COMMENT', types: ['COMMENT'] }),
      stamp, stamp, stamp
    ).lastInsertRowid);
  db.prepare(`INSERT INTO agent_jobs(device_id,job_type,payload,status,created_at,available_at,queue_lane,first_pending_at,priority)
    VALUES(?, 'DIAGNOSE', ?, 'QUEUED', ?, ?, 'GENERAL', ?, 100)`).run(
      account.device_id,
      JSON.stringify({ platformCode: 'douyin', accountId: account.id, queueLane: 'GENERAL' }),
      stamp, stamp, stamp
    );
  db.close();

  const sameLaneBlocked = await post(base, '/api/agent/jobs/claim', {
    deviceId: account.device_id,
    platformCodes: ['douyin'],
    queueLanes: ['COMMENT']
  });
  assert.equal(sameLaneBlocked.response.status, 200, stderr);
  assert.equal(sameLaneBlocked.data.job, null);

  const generalBlocked = await post(base, '/api/agent/jobs/claim', {
    deviceId: account.device_id,
    platformCodes: ['douyin'],
    queueLanes: ['GENERAL']
  });
  assert.equal(generalBlocked.response.status, 200, stderr);
  assert.equal(generalBlocked.data.job, null);

  const commentCompleted = await post(base, `/api/agent/jobs/${commentClaim.data.job.id}/complete`, {
    status: 'SUCCESS',
    result: { messages: [], message: '评论同步完成', typeResults: [{ type: 'COMMENT', status: 'SUCCESS', count: 0 }] }
  });
  assert.equal(commentCompleted.response.status, 200, stderr);

  const secondCommentClaim = await post(base, '/api/agent/jobs/claim', {
    deviceId: account.device_id,
    platformCodes: ['douyin'],
    queueLanes: ['COMMENT']
  });
  assert.equal(secondCommentClaim.response.status, 200, stderr);
  assert.equal(secondCommentClaim.data.job.id, secondCommentJobId);

  const secondCommentCompleted = await post(base, `/api/agent/jobs/${secondCommentJobId}/complete`, {
    status: 'SUCCESS',
    result: { messages: [], message: '第二次评论同步完成', typeResults: [{ type: 'COMMENT', status: 'SUCCESS', count: 0 }] }
  });
  assert.equal(secondCommentCompleted.response.status, 200, stderr);

  db = new DatabaseSync(dbPath);
  const publishStamp = new Date(Date.now() + 1).toISOString();
  const publishJobId = Number(db.prepare(`INSERT INTO agent_jobs(device_id,job_type,payload,status,created_at,available_at,channel_type,queue_lane,first_pending_at,priority)
    VALUES(?, 'PUBLISH', ?, 'QUEUED', ?, ?, 'COMMENT', 'COMMENT', ?, 0)`).run(
      account.device_id,
      JSON.stringify({ platformCode: 'douyin', accountId: account.id, channelType: 'COMMENT', queueLane: 'COMMENT' }),
      publishStamp, publishStamp, publishStamp
    ).lastInsertRowid);
  db.close();

  const publishBlockedByPrivateLane = await post(base, '/api/agent/jobs/claim', {
    deviceId: account.device_id,
    platformCodes: ['douyin'],
    queueLanes: ['COMMENT']
  });
  assert.equal(publishBlockedByPrivateLane.response.status, 200, stderr);
  assert.equal(publishBlockedByPrivateLane.data.job, null);

  const privateCompleted = await post(base, `/api/agent/jobs/${privateClaim.data.job.id}/complete`, {
    status: 'SUCCESS',
    result: { messages: [], message: '私信同步完成', typeResults: [{ type: 'PRIVATE_MESSAGE', status: 'SUCCESS', count: 0 }] }
  });
  assert.equal(privateCompleted.response.status, 200, stderr);

  const publishClaim = await post(base, '/api/agent/jobs/claim', {
    deviceId: account.device_id,
    platformCodes: ['douyin'],
    queueLanes: ['COMMENT']
  });
  assert.equal(publishClaim.response.status, 200, stderr);
  assert.equal(publishClaim.data.job.id, publishJobId);
  assert.equal(publishClaim.data.job.job_type, 'PUBLISH');

  const invalidLane = await post(base, '/api/agent/jobs/claim', {
    deviceId: account.device_id,
    platformCodes: ['douyin'],
    queueLanes: ['UNKNOWN_LANE']
  });
  assert.equal(invalidLane.response.status, 400);
});

test('消息页等待全部采集 Job，并区分同步成功为空与同步失败', () => {
  const app = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
  const styles = fs.readFileSync(path.join(root, 'public', 'styles.css'), 'utf8');
  assert.match(app, /async function waitForCollectionJobs\(jobIds/);
  assert.match(app, /d\.jobIds\?\.length\?d\.jobIds:\[d\.jobId\]/);
  assert.match(app, /jobs\.every\(job=>String\(job\.status\|\|''\)\.toUpperCase\(\)==='SUCCESS'\)/);
  assert.doesNotMatch(app, /const job=await waitForCollectionJob\(d\.jobId\)/);
  assert.match(app, /最近一次\$\{label\}同步失败/);
  assert.match(app, /同步完成，当前暂无\$\{label\}/);
  assert.match(styles, /\.message-sync-state\.error/);
  const localAgent = fs.readFileSync(path.join(root, 'agent', 'local-agent.js'), 'utf8');
  assert.match(localAgent, /async function claim\(requestedPlatformCodes = null, \{ queueLanes = null \} = \{\}\)/);
  assert.match(localAgent, /normalizedQueueLanes\.length \? \{ queueLanes: normalizedQueueLanes \} : \{\}/);
});

test('等待发布时让正在执行的采集结束，后续采集不能让发布一直等不到空闲窗口', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-claim-fairness-'));
  const dbPath = path.join(dir, 'test.db');
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: root, windowsHide: true,
    env: {
      ...process.env, PORT: String(port), DATABASE_PATH: dbPath,
      AUTH_ENABLED: 'false', AGENT_SHARED_TOKEN: '', QWEN_MODE: 'mock', RPA_MODE: 'simulated',
      AUTO_COLLECT_ENABLED: 'false', LOCAL_AGENT_AUTO_START: 'false', INSTANCE_LOCK_ENABLED: 'false',
      CHANNEL_SPLIT_ENABLED: 'true', PLATFORM_CHANNEL_SPLIT_DOUYIN: 'true', PLATFORM_CHANNEL_SPLIT_WECHAT_CHANNELS: 'true'
    },
    stdio: ['ignore', 'ignore', 'pipe']
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await Promise.race([new Promise(resolve => child.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 3000))]);
    }
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  await waitFor(base);
  const bootstrap = await (await fetch(`${base}/api/bootstrap`)).json();
  for (const platformCode of ['douyin', 'wechat_channels']) {
    await t.test(platformCode, async () => {
      const account = bootstrap.accounts.find(item => item.platform_code === platformCode);
      const claim = async lane => {
        const result = await post(base, '/api/agent/jobs/claim', { deviceId: account.device_id, platformCodes: [platformCode], queueLanes: [lane] });
        assert.equal(result.response.status, 200, stderr);
        return result.data.job;
      };
      const collect = await post(base, `/api/platforms/${platformCode}/collect`, { accountId: account.id, types: ['COMMENT', 'PRIVATE_MESSAGE'] });
      assert.equal(collect.response.status, 200, stderr);
      const currentPrivate = await claim('PRIVATE_MESSAGE');
      assert.ok(currentPrivate);

      const db = new DatabaseSync(dbPath);
      let publishId;
      try {
        const earlier = new Date(Date.now() - 5 * 60_000).toISOString();
        publishId = Number(db.prepare(`INSERT INTO agent_jobs(device_id,job_type,payload,status,created_at,available_at,channel_type,queue_lane,first_pending_at,priority)
          VALUES(?,'PUBLISH',?,'QUEUED',?,?,'COMMENT','COMMENT',?,50)`).run(account.device_id,
          JSON.stringify({ platformCode, accountId: account.id, channelType: 'COMMENT', queueLane: 'COMMENT' }), earlier, earlier, earlier).lastInsertRowid);
      } finally { db.close(); }

      assert.equal(await claim('COMMENT'), null, '已有私信采集时，不再让新的评论采集抢占等待发布所需的空闲窗口');
      const complete = await post(base, `/api/agent/jobs/${currentPrivate.id}/complete`, {
        status: 'SUCCESS', result: { messages: [], typeResults: [{ type: 'PRIVATE_MESSAGE', status: 'SUCCESS', count: 0 }] }
      });
      assert.equal(complete.response.status, 200, stderr);
      // Start the next polling round without waiting for the minute-based key.
      const nextRoundDb = new DatabaseSync(dbPath);
      try { nextRoundDb.prepare('UPDATE agent_jobs SET idempotency_key=NULL WHERE id=?').run(currentPrivate.id); }
      finally { nextRoundDb.close(); }
      const nextCollect = await post(base, `/api/platforms/${platformCode}/collect`, { accountId: account.id, types: ['PRIVATE_MESSAGE'] });
      assert.equal(nextCollect.response.status, 200, stderr);
      assert.notEqual(nextCollect.data.jobId, currentPrivate.id);
      assert.equal(await claim('PRIVATE_MESSAGE'), null, '采集结束后，先为等候中的发布保留执行机会');
      const published = await claim('COMMENT');
      assert.equal(published?.id, publishId, '即使采集优先级较高，已经等待的发布也能够被领取');
      assert.equal(await claim('PRIVATE_MESSAGE'), null, '发布执行时仍保持平台互斥');
      // This fixture exercises scheduling, not the platform submission receipt.
      const finishedDb = new DatabaseSync(dbPath);
      try { finishedDb.prepare("UPDATE agent_jobs SET status='SUCCESS',completed_at=? WHERE id=?").run(new Date().toISOString(), publishId); }
      finally { finishedDb.close(); }
      assert.equal((await claim('PRIVATE_MESSAGE'))?.id, nextCollect.data.jobId, '发布结束后，私信采集自动继续');
    });
  }

  for (const scenario of ['future', 'fresh', 'cancelled', 'runtime-blocked', 'disabled-account', 'other-device']) {
    await t.test(`不能执行的发布不阻断采集：${scenario}`, async () => {
      const account = bootstrap.accounts.find(item => item.platform_code === 'douyin');
      const db = new DatabaseSync(dbPath);
      try {
        db.exec('DELETE FROM agent_jobs; DELETE FROM runtime_blocks;');
        const earlier = new Date(Date.now() - 5 * 60_000).toISOString();
        const availableAt = scenario === 'future' ? new Date(Date.now() + 5 * 60_000).toISOString()
          : scenario === 'fresh' ? new Date().toISOString() : earlier;
        let accountId = account.id;
        if (scenario === 'disabled-account') {
          accountId = Number(db.prepare(`INSERT INTO accounts(platform_code,display_name,device_id,profile_name,enabled,login_status,created_at)
            VALUES('douyin','停用账号',?,'disabled-publish-account',0,'DISABLED',?)`).run(account.device_id, earlier).lastInsertRowid);
        }
        const status = scenario === 'cancelled' ? 'CANCELLED' : 'QUEUED';
        const deviceId = scenario === 'other-device' ? 'different-device' : account.device_id;
        if (scenario === 'other-device') db.prepare(`INSERT INTO devices(id,name,status,created_at) VALUES(?,'另一台设备','OFFLINE',?)`).run(deviceId, earlier);
        db.prepare(`INSERT INTO agent_jobs(device_id,job_type,payload,status,created_at,available_at,channel_type,queue_lane,first_pending_at,priority)
          VALUES(?,'PUBLISH',?,?,?,?,'COMMENT','COMMENT',?,50)`).run(deviceId,
          JSON.stringify({ platformCode: 'douyin', accountId, targetId: 90001, channelType: 'COMMENT', queueLane: 'COMMENT' }), status, earlier, availableAt, earlier);
        if (scenario === 'runtime-blocked') {
          const issueId = Number(db.prepare(`INSERT INTO issues(source,category,title,detail,created_at,updated_at)
            VALUES('RPA','PUBLISH','待处理发布问题','测试问题',?,?)`).run(earlier, earlier).lastInsertRowid);
          db.prepare(`INSERT INTO runtime_blocks(issue_id,scope,block_key,feature,reason,status,created_at)
            VALUES(?,'TASK','PUBLISH_TARGET:90001','publish','待处理发布问题','ACTIVE',?)`).run(issueId, earlier);
        }
      } finally { db.close(); }
      const queued = await post(base, '/api/platforms/douyin/collect', { accountId: account.id, types: ['PRIVATE_MESSAGE'] });
      assert.equal(queued.response.status, 200, stderr);
      const claimed = await post(base, '/api/agent/jobs/claim', { deviceId: account.device_id, platformCodes: ['douyin'], queueLanes: ['PRIVATE_MESSAGE'] });
      assert.equal(claimed.response.status, 200, stderr);
      assert.equal(claimed.data.job?.id, queued.data.jobId, '不可领取或尚未等候的发布，不应暂停正常采集');
    });
  }
  await t.test('一个平台积压超过一百条采集时，不挡住另一个平台领取任务', async () => {
    const douyin = bootstrap.accounts.find(item => item.platform_code === 'douyin');
    const channels = bootstrap.accounts.find(item => item.platform_code === 'wechat_channels');
    const db = new DatabaseSync(dbPath);
    let channelsJobId;
    try {
      db.exec('DELETE FROM agent_jobs; DELETE FROM runtime_blocks;');
      const earlier = new Date(Date.now() - 5 * 60_000).toISOString();
      const stamp = new Date().toISOString();
      const insert = db.prepare(`INSERT INTO agent_jobs(device_id,job_type,payload,status,created_at,available_at,channel_type,queue_lane,first_pending_at,priority)
        VALUES(?,?,?,'QUEUED',?,?,?,?,?,?)`);
      insert.run(douyin.device_id, 'PUBLISH', JSON.stringify({ platformCode: 'douyin', accountId: douyin.id, channelType: 'COMMENT', queueLane: 'COMMENT' }),
        earlier, earlier, 'COMMENT', 'COMMENT', earlier, 50);
      for (let i = 0; i < 101; i++) insert.run(douyin.device_id, 'COLLECT_MESSAGES',
        JSON.stringify({ platformCode: 'douyin', accountId: douyin.id, channelType: 'PRIVATE_MESSAGE', queueLane: 'PRIVATE_MESSAGE', types: ['PRIVATE_MESSAGE'] }),
        stamp, stamp, 'PRIVATE_MESSAGE', 'PRIVATE_MESSAGE', stamp, 20);
      channelsJobId = Number(insert.run(channels.device_id, 'COLLECT_MESSAGES',
        JSON.stringify({ platformCode: 'wechat_channels', accountId: channels.id, channelType: 'PRIVATE_MESSAGE', queueLane: 'PRIVATE_MESSAGE', types: ['PRIVATE_MESSAGE'] }),
        stamp, stamp, 'PRIVATE_MESSAGE', 'PRIVATE_MESSAGE', stamp, 20).lastInsertRowid);
    } finally { db.close(); }
    const claimed = await post(base, '/api/agent/jobs/claim', { deviceId: channels.device_id, queueLanes: ['PRIVATE_MESSAGE'] });
    assert.equal(claimed.response.status, 200, stderr);
    assert.equal(claimed.data.job?.id, channelsJobId);
  });
});
