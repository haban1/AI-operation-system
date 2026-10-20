import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const root = path.resolve(import.meta.dirname, '..');

async function freePort() {
  const server = http.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function waitFor(base) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try { if ((await fetch(`${base}/api/health`)).ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('V2 测试服务启动超时');
}

async function request(base, pathname, { method = 'GET', body } = {}) {
  const response = await fetch(base + pathname, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { response, data: await response.json() };
}

async function withV2Server(t, operation, envOverrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reply-batch-v2-'));
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
      LOGIN_STATUS_POLL_ENABLED: 'false', ISSUE_DIAGNOSIS_ENABLED: 'false',
      CHANNEL_SPLIT_ENABLED: 'true', PLATFORM_CHANNEL_SPLIT_DOUYIN: 'true',
      MESSAGE_EVENT_LEDGER_ENABLED: 'true', PRIVATE_RECONCILIATION_ENABLED: 'true',
      PRIVATE_LIVE_RECHECK_ENABLED: 'true', PRIVATE_AUTO_SEND_V2_ENABLED: 'true',
      COMMENT_CHANNEL_V2_ENABLED: 'false',
      ...envOverrides
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
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA busy_timeout=15000');
  try { await operation({ base, db, stderr: () => stderr }); }
  finally { db.close(); }
}

function markRunning(db, jobId) {
  const stamp = new Date().toISOString();
  db.prepare("UPDATE agent_jobs SET status='RUNNING',attempts=attempts+1,claimed_at=?,lease_expires_at=? WHERE id=?")
    .run(stamp, new Date(Date.now() + 600_000).toISOString(), Number(jobId));
}

async function collectPrivate({ base, db, account, messages, stderr }) {
  const queued = await request(base, '/api/platforms/douyin/collect', {
    method: 'POST', body: { accountId: account.id, types: ['PRIVATE_MESSAGE'] }
  });
  assert.equal(queued.response.status, 200, stderr());
  markRunning(db, queued.data.jobId);
  const completed = await request(base, `/api/agent/jobs/${queued.data.jobId}/complete`, {
    method: 'POST',
    body: {
      status: 'SUCCESS',
      result: {
        messages,
        typeResults: [{ type: 'PRIVATE_MESSAGE', status: 'SUCCESS', count: messages.length }]
      }
    }
  });
  assert.equal(completed.response.status, 200, stderr());
  return completed.data;
}

function privateMessage({ externalId, conversationId, userName, content, eventTime }) {
  return {
    externalId,
    messageType: 'PRIVATE_MESSAGE',
    userName,
    content,
    externalUrl: 'https://www.douyin.com/messages',
    context: {
      conversationId,
      userId: `user-${conversationId}`,
      messageId: externalId,
      direction: 'incoming',
      previewOnly: false,
      sourceVerified: true,
      chatTitleVerified: true,
      eventTime
    }
  };
}

test('V2 私信批次闭环：连续消息合并、旧答案失效、发送互斥和不确定结果禁重发', async t => {
  await withV2Server(t, async ({ base, db, stderr }) => {
    const bootstrap = (await request(base, '/api/bootstrap')).data;
    const account = bootstrap.accounts.find(item => item.platform_code === 'douyin');
    assert.ok(account, stderr());

    const conversationId = `v2-conversation-${Date.now()}`;
    const firstExternalId = `v2-first-${Date.now()}`;
    await collectPrivate({
      base, db, account, stderr,
      messages: [privateMessage({
        externalId: firstExternalId,
        conversationId,
        userName: 'V2用户甲',
        content: '我想了解社区服务',
        eventTime: '2026-08-24T12:00:00.000Z'
      })]
    });

    const firstBatch = db.prepare("SELECT * FROM reply_batches WHERE conversation_namespace LIKE 'REAL:douyin:%' ORDER BY id DESC LIMIT 1").get();
    assert.ok(firstBatch, stderr());
    assert.equal(firstBatch.status, 'READY');
    const firstJobId = Number(firstBatch.agent_job_id);
    assert.ok(firstJobId > 0);
    assert.equal(db.prepare('SELECT status FROM agent_jobs WHERE id=?').get(firstJobId).status, 'QUEUED');

    const secondExternalId = `v2-second-${Date.now()}`;
    await collectPrivate({
      base, db, account, stderr,
      messages: [privateMessage({
        externalId: secondExternalId,
        conversationId,
        userName: 'V2用户甲',
        content: '具体怎么申请？',
        eventTime: '2026-08-24T12:00:05.000Z'
      })]
    });

    const mergedBatch = db.prepare('SELECT * FROM reply_batches WHERE id=?').get(firstBatch.id);
    assert.equal(mergedBatch.status, 'READY');
    assert.equal(JSON.parse(mergedBatch.source_message_ids_json).length, 2);
    assert.ok(Number(mergedBatch.conversation_version) > Number(firstBatch.conversation_version));
    const replacementJobId = Number(mergedBatch.agent_job_id);
    assert.ok(replacementJobId > 0 && replacementJobId !== firstJobId);
    assert.equal(db.prepare('SELECT status FROM agent_jobs WHERE id=?').get(firstJobId).status, 'CANCELLED');
    assert.equal(db.prepare('SELECT status FROM agent_jobs WHERE id=?').get(replacementJobId).status, 'QUEUED');

    const sourceMessages = db.prepare('SELECT external_id,status,reply_job_id FROM messages WHERE external_id IN (?,?) ORDER BY id').all(firstExternalId, secondExternalId);
    assert.deepEqual(sourceMessages.map(item => item.status), ['SUPERSEDED', 'REPLY_QUEUED']);
    assert.equal(Number(sourceMessages[1].reply_job_id), replacementJobId);

    const claimed = await request(base, '/api/agent/jobs/claim', {
      method: 'POST', body: { deviceId: account.device_id, platformCodes: ['douyin'] }
    });
    assert.equal(claimed.response.status, 200, stderr());
    assert.equal(claimed.data.job.id, replacementJobId);
    assert.equal(claimed.data.job.payload.replyBatchId, mergedBatch.id);
    assert.ok(claimed.data.job.payload.replyAttemptId > 0);
    assert.equal(db.prepare('SELECT status FROM reply_batches WHERE id=?').get(mergedBatch.id).status, 'SENDING');
    assert.equal(db.prepare('SELECT state FROM reply_attempts WHERE id=?').get(claimed.data.job.payload.replyAttemptId).state, 'PREPARED');

    const deferred = await request(base, `/api/agent/jobs/${replacementJobId}/defer`, {
      method: 'POST', body: { reason: 'TEST_PRE_SEND_DEFER', message: '平台暂停，尚未发送' }
    });
    assert.equal(deferred.response.status, 200, stderr());
    assert.equal(db.prepare('SELECT status FROM reply_batches WHERE id=?').get(mergedBatch.id).status, 'READY');
    assert.equal(db.prepare('SELECT state FROM reply_attempts WHERE id=?').get(claimed.data.job.payload.replyAttemptId).state, 'DEFERRED_BEFORE_SEND');

    const reclaimed = await request(base, '/api/agent/jobs/claim', {
      method: 'POST', body: { deviceId: account.device_id, platformCodes: ['douyin'] }
    });
    assert.equal(reclaimed.data.job.id, replacementJobId);
    assert.notEqual(reclaimed.data.job.payload.replyAttemptId, claimed.data.job.payload.replyAttemptId);

    const uncertain = await request(base, `/api/agent/jobs/${replacementJobId}/complete`, {
      method: 'POST',
      body: { status: 'SUCCESS', result: { stage: 'reply_sent', message: '适配器声称成功但没有可靠回执' } }
    });
    assert.equal(uncertain.response.status, 200, stderr());
    assert.equal(db.prepare('SELECT status FROM agent_jobs WHERE id=?').get(replacementJobId).status, 'NEEDS_CONFIRMATION');
    const uncertainBatch = db.prepare('SELECT status,completed_at FROM reply_batches WHERE id=?').get(mergedBatch.id);
    assert.equal(uncertainBatch.status, 'SEND_UNCERTAIN');
    assert.equal(uncertainBatch.completed_at, null);
    assert.equal(db.prepare('SELECT state FROM reply_attempts WHERE id=?').get(reclaimed.data.job.payload.replyAttemptId).state, 'SEND_UNCERTAIN');

    const thirdExternalId = `v2-third-${Date.now()}`;
    await collectPrivate({
      base, db, account, stderr,
      messages: [privateMessage({
        externalId: thirdExternalId,
        conversationId,
        userName: 'V2用户甲',
        content: '我再补充一个问题',
        eventTime: '2026-08-24T12:01:00.000Z'
      })]
    });
    const blockedPending = db.prepare("SELECT * FROM reply_batches WHERE conversation_namespace=? AND status='PENDING' ORDER BY id DESC LIMIT 1").get(mergedBatch.conversation_namespace);
    assert.ok(blockedPending, stderr());
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM agent_jobs WHERE job_type='REPLY' AND status='QUEUED' AND json_extract(payload,'$.replyBatchId')=?").get(blockedPending.id).count, 0);

    const otherConversation = `v2-other-${Date.now()}`;
    await collectPrivate({
      base, db, account, stderr,
      messages: [privateMessage({
        externalId: `v2-other-message-${Date.now()}`,
        conversationId: otherConversation,
        userName: 'V2用户乙',
        content: '另一个用户咨询办理流程',
        eventTime: '2026-08-24T12:02:00.000Z'
      })]
    });
    const otherBatch = db.prepare("SELECT * FROM reply_batches WHERE conversation_namespace<>? AND status='READY' ORDER BY id DESC LIMIT 1").get(mergedBatch.conversation_namespace);
    assert.ok(otherBatch, stderr());
    assert.ok(Number(otherBatch.agent_job_id) > 0);
  });
});


test('V2 可靠平台回执完成批次，且只在确认成功后写完成时间', async t => {
  await withV2Server(t, async ({ base, db, stderr }) => {
    const bootstrap = (await request(base, '/api/bootstrap')).data;
    const account = bootstrap.accounts.find(item => item.platform_code === 'douyin');
    const conversationId = `v2-verified-${Date.now()}`;
    const externalId = `v2-verified-message-${Date.now()}`;
    await collectPrivate({
      base, db, account, stderr,
      messages: [privateMessage({
        externalId, conversationId, userName: 'V2可靠回执用户', content: '请介绍办理条件',
        eventTime: '2026-08-24T13:00:00.000Z'
      })]
    });

    const batch = db.prepare("SELECT * FROM reply_batches WHERE status='READY' ORDER BY id DESC LIMIT 1").get();
    const claimed = await request(base, '/api/agent/jobs/claim', {
      method: 'POST', body: { deviceId: account.device_id, platformCodes: ['douyin'] }
    });
    assert.equal(claimed.data.job.id, Number(batch.agent_job_id), stderr());
    const attemptId = claimed.data.job.payload.replyAttemptId;

    const completed = await request(base, `/api/agent/jobs/${claimed.data.job.id}/complete`, {
      method: 'POST',
      body: {
        status: 'SUCCESS',
        result: {
          stage: 'reply_sent',
          message: '平台已确认回复成功',
          evidencePath: 'D:/evidence/reply.json',
          screenshotPath: 'D:/evidence/reply.png',
          sendMethod: 'scoped-selector:.e2e-send-msg-btn',
          editorCleared: true,
          baselineEchoCount: 0,
          scopedEchoCount: 1
        }
      }
    });
    assert.equal(completed.response.status, 200, stderr());
    const finishedBatch = db.prepare('SELECT status,completed_at FROM reply_batches WHERE id=?').get(batch.id);
    const attempt = db.prepare('SELECT state,verified_at FROM reply_attempts WHERE id=?').get(attemptId);
    const message = db.prepare('SELECT status,handled_at FROM messages WHERE external_id=?').get(externalId);
    assert.equal(finishedBatch.status, 'COMPLETED');
    assert.ok(finishedBatch.completed_at);
    assert.equal(attempt.state, 'VERIFIED');
    assert.ok(attempt.verified_at);
    assert.equal(message.status, 'AUTO_REPLIED');
    assert.ok(message.handled_at);
  });
});

test('V2 领取前会话版本变化会取消旧 READY Job，禁止旧答案发送', async t => {
  await withV2Server(t, async ({ base, db, stderr }) => {
    const bootstrap = (await request(base, '/api/bootstrap')).data;
    const account = bootstrap.accounts.find(item => item.platform_code === 'douyin');
    const externalId = `v2-version-change-${Date.now()}`;
    await collectPrivate({
      base, db, account, stderr,
      messages: [privateMessage({
        externalId, conversationId: `v2-version-conversation-${Date.now()}`, userName: 'V2版本用户',
        content: '先问第一个问题', eventTime: '2026-08-24T13:10:00.000Z'
      })]
    });

    const batch = db.prepare("SELECT * FROM reply_batches WHERE status='READY' ORDER BY id DESC LIMIT 1").get();
    const jobId = Number(batch.agent_job_id);
    db.prepare('UPDATE conversations SET ledger_version=ledger_version+1,updated_at=? WHERE id=?')
      .run(new Date().toISOString(), batch.conversation_id);

    const claimed = await request(base, '/api/agent/jobs/claim', {
      method: 'POST', body: { deviceId: account.device_id, platformCodes: ['douyin'] }
    });
    assert.equal(claimed.response.status, 200, stderr());
    assert.equal(claimed.data.job, null);
    assert.equal(db.prepare('SELECT status FROM agent_jobs WHERE id=?').get(jobId).status, 'CANCELLED');
    const invalidated = db.prepare('SELECT status,agent_job_id,invalidation_reason FROM reply_batches WHERE id=?').get(batch.id);
    assert.equal(invalidated.status, 'PENDING');
    assert.equal(invalidated.agent_job_id, null);
    assert.equal(invalidated.invalidation_reason, 'VERSION_CHANGED_BEFORE_SEND_CLAIM');
    const message = db.prepare('SELECT status,reply_job_id FROM messages WHERE external_id=?').get(externalId);
    assert.equal(message.status, 'NEW');
    assert.equal(message.reply_job_id, null);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM reply_attempts WHERE reply_batch_id=?').get(batch.id).count, 0);
  });
});

test('V2 发送过程中收到新消息会建立第二个待处理批次，不会混入正在发送的旧批次', async t => {
  await withV2Server(t, async ({ base, db, stderr }) => {
    const bootstrap = (await request(base, '/api/bootstrap')).data;
    const account = bootstrap.accounts.find(item => item.platform_code === 'douyin');
    const conversationId = `v2-sending-conversation-${Date.now()}`;
    const firstExternalId = `v2-sending-first-${Date.now()}`;
    await collectPrivate({
      base, db, account, stderr,
      messages: [privateMessage({
        externalId: firstExternalId, conversationId, userName: 'V2发送中用户', content: '第一条问题',
        eventTime: '2026-08-24T13:20:00.000Z'
      })]
    });
    const sendingBatch = db.prepare("SELECT * FROM reply_batches WHERE status='READY' ORDER BY id DESC LIMIT 1").get();
    const claimed = await request(base, '/api/agent/jobs/claim', {
      method: 'POST', body: { deviceId: account.device_id, platformCodes: ['douyin'] }
    });
    assert.equal(claimed.data.job.id, Number(sendingBatch.agent_job_id), stderr());

    const secondExternalId = `v2-sending-second-${Date.now()}`;
    await collectPrivate({
      base, db, account, stderr,
      messages: [privateMessage({
        externalId: secondExternalId, conversationId, userName: 'V2发送中用户', content: '发送时补充的新问题',
        eventTime: '2026-08-24T13:20:05.000Z'
      })]
    });

    const batches = db.prepare('SELECT * FROM reply_batches WHERE conversation_namespace=? ORDER BY id').all(sendingBatch.conversation_namespace);
    assert.equal(batches.length, 2);
    assert.equal(batches[0].status, 'SENDING');
    assert.equal(batches[1].status, 'PENDING');
    assert.deepEqual(JSON.parse(batches[0].source_message_ids_json).length, 1);
    assert.deepEqual(JSON.parse(batches[1].source_message_ids_json).length, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM agent_jobs WHERE job_type='REPLY' AND status='QUEUED' AND json_extract(payload,'$.replyBatchId')=?").get(batches[1].id).count, 0);

    const completed = await request(base, `/api/agent/jobs/${claimed.data.job.id}/complete`, {
      method: 'POST',
      body: {
        status: 'SUCCESS',
        result: {
          stage: 'reply_sent', evidencePath: 'D:/evidence/sending.json', screenshotPath: 'D:/evidence/sending.png',
          sendMethod: 'scoped-selector:.e2e-send-msg-btn', editorCleared: true, baselineEchoCount: 0, scopedEchoCount: 1
        }
      }
    });
    assert.equal(completed.response.status, 200, stderr());
    const drainedSecond = db.prepare('SELECT status,agent_job_id FROM reply_batches WHERE id=?').get(batches[1].id);
    assert.equal(drainedSecond.status, 'READY');
    assert.ok(Number(drainedSecond.agent_job_id) > 0);
  });
});

test('V2 回复租约过期会进入发送不确定并阻止自动重发', async t => {
  await withV2Server(t, async ({ base, db, stderr }) => {
    const bootstrap = (await request(base, '/api/bootstrap')).data;
    const account = bootstrap.accounts.find(item => item.platform_code === 'douyin');
    await collectPrivate({
      base, db, account, stderr,
      messages: [privateMessage({
        externalId: `v2-lease-${Date.now()}`, conversationId: `v2-lease-conversation-${Date.now()}`,
        userName: 'V2租约用户', content: '测试租约保护', eventTime: '2026-08-24T13:30:00.000Z'
      })]
    });
    const batch = db.prepare("SELECT * FROM reply_batches WHERE status='READY' ORDER BY id DESC LIMIT 1").get();
    const claimed = await request(base, '/api/agent/jobs/claim', {
      method: 'POST', body: { deviceId: account.device_id, platformCodes: ['douyin'] }
    });
    const jobId = claimed.data.job.id;
    const attemptId = claimed.data.job.payload.replyAttemptId;
    db.prepare("UPDATE agent_jobs SET lease_expires_at='2026-08-24T00:00:00.000Z' WHERE id=?").run(jobId);

    const nextClaim = await request(base, '/api/agent/jobs/claim', {
      method: 'POST', body: { deviceId: account.device_id, platformCodes: ['douyin'] }
    });
    assert.equal(nextClaim.response.status, 200, stderr());
    assert.equal(nextClaim.data.job, null);
    assert.equal(db.prepare('SELECT status FROM agent_jobs WHERE id=?').get(jobId).status, 'NEEDS_CONFIRMATION');
    const uncertainBatch = db.prepare('SELECT status,completed_at,invalidation_reason FROM reply_batches WHERE id=?').get(batch.id);
    assert.equal(uncertainBatch.status, 'SEND_UNCERTAIN');
    assert.equal(uncertainBatch.completed_at, null);
    assert.equal(uncertainBatch.invalidation_reason, 'NON_IDEMPOTENT_LEASE_EXPIRED');
    assert.equal(db.prepare('SELECT state FROM reply_attempts WHERE id=?').get(attemptId).state, 'SEND_UNCERTAIN');
  });
});

test('V2 自动发送开关关闭时继续走 V1 回复任务，不绑定 replyBatchId', async t => {
  await withV2Server(t, async ({ base, db, stderr }) => {
    const bootstrap = (await request(base, '/api/bootstrap')).data;
    const account = bootstrap.accounts.find(item => item.platform_code === 'douyin');
    const externalId = `v1-fallback-${Date.now()}`;
    await collectPrivate({
      base, db, account, stderr,
      messages: [privateMessage({
        externalId, conversationId: `v1-fallback-conversation-${Date.now()}`, userName: 'V1兼容用户',
        content: '开关关闭时继续原流程', eventTime: '2026-08-24T13:40:00.000Z'
      })]
    });
    const message = db.prepare('SELECT status,reply_job_id FROM messages WHERE external_id=?').get(externalId);
    assert.equal(message.status, 'REPLY_QUEUED');
    const job = db.prepare('SELECT payload,status FROM agent_jobs WHERE id=?').get(message.reply_job_id);
    const payload = JSON.parse(job.payload);
    assert.equal(job.status, 'QUEUED');
    assert.equal(Object.prototype.hasOwnProperty.call(payload, 'replyBatchId'), false);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM message_events WHERE channel_type='PRIVATE_MESSAGE'").get().count, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM agent_jobs WHERE job_type='REPLY' AND json_extract(payload,'$.replyBatchId') IS NOT NULL").get().count, 0);
  }, { PRIVATE_AUTO_SEND_V2_ENABLED: 'false' });
});
