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
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(base + '/api/health');
      if (response.ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('测试服务启动超时');
}

async function request(base, pathname, body) {
  const response = await fetch(base + pathname, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return { response, data: await response.json() };
}

function insertMessage(db, account, suffix) {
  const stamp = new Date().toISOString();
  return Number(db.prepare(`INSERT INTO messages(platform_code,account_id,message_type,external_id,user_name,content,status,decision,reply_text,context_json,created_at,updated_at)
    VALUES(?,?,?,?,?,?,'REPLY_RUNNING','AUTO_REPLY','测试回复','{}',?,?)`).run(
    account.platform_code, account.id, 'COMMENT', `reply-race-${suffix}-${Date.now()}-${Math.random()}`, '测试用户', '测试内容', stamp, stamp
  ).lastInsertRowid);
}

function insertReplyJob(db, account, messageId, status) {
  const stamp = new Date().toISOString();
  const payload = JSON.stringify({ messageId, platformCode: account.platform_code, accountId: account.id, messageType: 'COMMENT' });
  return Number(db.prepare(`INSERT INTO agent_jobs(device_id,job_type,payload,status,attempts,created_at,claimed_at)
    VALUES(?,'REPLY',?,?,1,?,?)`).run(account.device_id, payload, status, stamp, status === 'RUNNING' ? stamp : null).lastInsertRowid);
}

test('迟到回复结果不能覆盖消息或取消后续回复 Job', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reply-job-race-'));
  const databasePath = path.join(dir, 'test.db');
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port), DATABASE_PATH: databasePath,
      AUTH_ENABLED: 'false', AGENT_SHARED_TOKEN: '', QWEN_MODE: 'mock', RPA_MODE: 'simulated',
      AUTO_COLLECT_ENABLED: 'false', LOCAL_AGENT_AUTO_START: 'false', INSTANCE_LOCK_ENABLED: 'false'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stderr = '';
  let db;
  child.stderr.on('data', chunk => { stderr += chunk; });
  t.after(async () => {
    try { db?.close(); } catch {}
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await Promise.race([new Promise(resolve => child.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 3000))]);
    }
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  await waitFor(base);
  db = new DatabaseSync(databasePath);
  const bootstrap = await (await fetch(base + '/api/bootstrap')).json();
  const account = bootstrap.accounts.find(item => item.platform_code === 'douyin');
  assert.ok(account, stderr);

  const expiredMessageId = insertMessage(db, account, 'expired');
  const expiredJobId = insertReplyJob(db, account, expiredMessageId, 'NEEDS_CONFIRMATION');
  const replacementJobId = insertReplyJob(db, account, expiredMessageId, 'RUNNING');
  db.prepare('UPDATE messages SET reply_job_id=? WHERE id=?').run(replacementJobId, expiredMessageId);
  const expiredResult = await request(base, `/api/agent/jobs/${expiredJobId}/complete`, {
    status: 'CANCELLED', result: { sourceState: 'SOURCE_GONE', decision: 'SKIP_SOURCE_GONE', message: '迟到删除结果' }
  });
  assert.equal(expiredResult.response.status, 200, stderr);
  assert.equal(expiredResult.data.ignored, true);
  assert.equal(db.prepare('SELECT status FROM agent_jobs WHERE id=?').get(expiredJobId).status, 'NEEDS_CONFIRMATION');
  assert.equal(db.prepare('SELECT status FROM agent_jobs WHERE id=?').get(replacementJobId).status, 'RUNNING');
  const expiredMessage = db.prepare('SELECT status,decision,reply_job_id FROM messages WHERE id=?').get(expiredMessageId);
  assert.equal(expiredMessage.status, 'REPLY_RUNNING');
  assert.equal(expiredMessage.decision, 'AUTO_REPLY');
  assert.equal(expiredMessage.reply_job_id, replacementJobId);

  const staleMessageId = insertMessage(db, account, 'running-stale');
  const staleJobId = insertReplyJob(db, account, staleMessageId, 'RUNNING');
  const currentJobId = insertReplyJob(db, account, staleMessageId, 'RUNNING');
  db.prepare('UPDATE messages SET reply_job_id=? WHERE id=?').run(currentJobId, staleMessageId);
  const staleResult = await request(base, `/api/agent/jobs/${staleJobId}/complete`, {
    status: 'NEEDS_CONFIRMATION', result: { sourceState: 'DEFERRED_PAGE_UNAVAILABLE', decision: 'DEFERRED_PAGE_UNAVAILABLE', message: '迟到页面结果' }
  });
  assert.equal(staleResult.response.status, 200, stderr);
  assert.equal(staleResult.data.ignored, true);
  const staleJob = db.prepare('SELECT status,result FROM agent_jobs WHERE id=?').get(staleJobId);
  assert.equal(staleJob.status, 'CANCELLED');
  assert.equal(JSON.parse(staleJob.result).ignoreReason, 'STALE_REPLY_JOB_COMPLETION');
  assert.equal(db.prepare('SELECT status FROM agent_jobs WHERE id=?').get(currentJobId).status, 'RUNNING');
  const staleMessage = db.prepare('SELECT status,decision,reply_job_id FROM messages WHERE id=?').get(staleMessageId);
  assert.equal(staleMessage.status, 'REPLY_RUNNING');
  assert.equal(staleMessage.decision, 'AUTO_REPLY');
  assert.equal(staleMessage.reply_job_id, currentJobId);

  for (const [suffix, completion] of [
    ['source-gone', { status: 'CANCELLED', result: { sourceState: 'SOURCE_GONE', decision: 'SKIP_SOURCE_GONE', message: '当前内容已删除' } }],
    ['deferred', { status: 'NEEDS_CONFIRMATION', result: { sourceState: 'DEFERRED_PAGE_UNAVAILABLE', decision: 'DEFERRED_PAGE_UNAVAILABLE', message: '当前页面不可用' } }]
  ]) {
    const messageId = insertMessage(db, account, suffix);
    const activeJobId = insertReplyJob(db, account, messageId, 'RUNNING');
    const laterJobId = insertReplyJob(db, account, messageId, 'QUEUED');
    db.prepare('UPDATE messages SET reply_job_id=? WHERE id=?').run(activeJobId, messageId);
    const completed = await request(base, `/api/agent/jobs/${activeJobId}/complete`, completion);
    assert.equal(completed.response.status, 200, stderr);
    assert.equal(db.prepare('SELECT status FROM agent_jobs WHERE id=?').get(laterJobId).status, 'QUEUED');
  }
  await t.test('REPLY 租约过期只修改仍归属旧 Job 的消息', async () => {
    db.prepare("UPDATE agent_jobs SET status='CANCELLED' WHERE status='QUEUED'").run();
    const messageId = insertMessage(db, account, 'lease-expired-stale');
    const expiredJobId = insertReplyJob(db, account, messageId, 'RUNNING');
    const replacementJobId = insertReplyJob(db, account, messageId, 'RUNNING');
    db.prepare("UPDATE agent_jobs SET lease_expires_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(expiredJobId);
    db.prepare("UPDATE messages SET status='REPLY_RUNNING',decision='AUTO_REPLY',reply_job_id=? WHERE id=?").run(replacementJobId, messageId);

    const claimed = await request(base, '/api/agent/jobs/claim', { deviceId: account.device_id });
    assert.equal(claimed.response.status, 200, stderr);
    assert.equal(db.prepare('SELECT status FROM agent_jobs WHERE id=?').get(expiredJobId).status, 'NEEDS_CONFIRMATION');
    assert.equal(db.prepare('SELECT status FROM agent_jobs WHERE id=?').get(replacementJobId).status, 'RUNNING');
    const message = db.prepare('SELECT status,decision,reply_job_id FROM messages WHERE id=?').get(messageId);
    assert.equal(message.status, 'REPLY_RUNNING');
    assert.equal(message.decision, 'AUTO_REPLY');
    assert.equal(message.reply_job_id, replacementJobId);
  });

  await t.test('claim 会取消孤立 REPLY Job 并只返回当前归属 Job', async () => {
    // 新的同平台运行锁要求上一场景留下的合成 RUNNING Job 先进入终态；生产链路同样不会并行领取它们。
    db.prepare("UPDATE agent_jobs SET status='CANCELLED',completed_at=?,lease_expires_at=NULL WHERE status IN ('QUEUED','RUNNING')").run(new Date().toISOString());
    const messageId = insertMessage(db, account, 'claim-orphan');
    const orphanJobId = insertReplyJob(db, account, messageId, 'QUEUED');
    const ownedJobId = insertReplyJob(db, account, messageId, 'QUEUED');
    db.prepare("UPDATE messages SET status='REPLY_QUEUED',reply_job_id=? WHERE id=?").run(ownedJobId, messageId);

    const claimed = await request(base, '/api/agent/jobs/claim', { deviceId: account.device_id });
    assert.equal(claimed.response.status, 200, stderr);
    assert.equal(claimed.data.job.id, ownedJobId);
    const orphan = db.prepare('SELECT status,result FROM agent_jobs WHERE id=?').get(orphanJobId);
    assert.equal(orphan.status, 'CANCELLED');
    assert.equal(JSON.parse(orphan.result).ignoreReason, 'STALE_REPLY_JOB_CLAIM');
    assert.equal(db.prepare('SELECT status FROM agent_jobs WHERE id=?').get(ownedJobId).status, 'RUNNING');
    const message = db.prepare('SELECT status,reply_job_id FROM messages WHERE id=?').get(messageId);
    assert.equal(message.status, 'REPLY_RUNNING');
    assert.equal(message.reply_job_id, ownedJobId);
  });

  await t.test('/defer 对失去消息归属的 REPLY Job 只取消旧 Job', async () => {
    const messageId = insertMessage(db, account, 'defer-stale');
    const staleJobId = insertReplyJob(db, account, messageId, 'RUNNING');
    const currentJobId = insertReplyJob(db, account, messageId, 'RUNNING');
    db.prepare("UPDATE messages SET status='REPLY_RUNNING',decision='AUTO_REPLY',reply_job_id=? WHERE id=?").run(currentJobId, messageId);

    const deferred = await request(base, `/api/agent/jobs/${staleJobId}/defer`, { reason: 'TEST_STALE_DEFER', message: '迟到 defer' });
    assert.equal(deferred.response.status, 200, stderr);
    assert.equal(deferred.data.ignored, true);
    assert.equal(deferred.data.reason, 'STALE_REPLY_JOB_DEFER');
    const staleJob = db.prepare('SELECT status,result FROM agent_jobs WHERE id=?').get(staleJobId);
    assert.equal(staleJob.status, 'CANCELLED');
    assert.equal(JSON.parse(staleJob.result).ignoreReason, 'STALE_REPLY_JOB_DEFER');
    assert.equal(db.prepare('SELECT status FROM agent_jobs WHERE id=?').get(currentJobId).status, 'RUNNING');
    const message = db.prepare('SELECT status,decision,reply_job_id FROM messages WHERE id=?').get(messageId);
    assert.equal(message.status, 'REPLY_RUNNING');
    assert.equal(message.decision, 'AUTO_REPLY');
    assert.equal(message.reply_job_id, currentJobId);
  });

  await t.test('迟到 DETECT_MANUAL_REPLY 不覆盖消息且不取消后来 REPLY Job', async () => {
    // 各子场景独立，避免前一场景的人造 RUNNING Job 触发同平台互斥锁。
    db.prepare("UPDATE agent_jobs SET status='CANCELLED',completed_at=?,lease_expires_at=NULL WHERE status IN ('QUEUED','RUNNING')").run(new Date().toISOString());
    const messageId = insertMessage(db, account, 'detect-manual-stale');
    db.prepare("UPDATE messages SET status='MANUAL_REQUIRED',decision='MANUAL_REPLY',reply_job_id=NULL WHERE id=?").run(messageId);
    const detection = await request(base, `/api/messages/${messageId}/detect-manual`, { expectedReply: '平台人工回复测试' });
    assert.equal(detection.response.status, 200, stderr);
    const detectionJobId = detection.data.jobId;
    const claimed = await request(base, '/api/agent/jobs/claim', { deviceId: account.device_id });
    assert.equal(claimed.response.status, 200, stderr);
    assert.equal(claimed.data.job.id, detectionJobId);
    assert.equal(claimed.data.job.job_type, 'DETECT_MANUAL_REPLY');

    const laterReplyJobId = insertReplyJob(db, account, messageId, 'RUNNING');
    db.prepare("UPDATE messages SET status='REPLY_RUNNING',decision='AUTO_REPLY',reply_job_id=?,updated_at=? WHERE id=?")
      .run(laterReplyJobId, new Date(Date.now() + 1000).toISOString(), messageId);
    const completed = await request(base, `/api/agent/jobs/${detectionJobId}/complete`, {
      status: 'SUCCESS', result: { handled: true, message: '迟到检测声称已回复' }
    });
    assert.equal(completed.response.status, 200, stderr);
    assert.equal(completed.data.ignored, true);
    assert.equal(completed.data.reason, 'STALE_MANUAL_REPLY_DETECTION');
    const detectionJob = db.prepare('SELECT status,result FROM agent_jobs WHERE id=?').get(detectionJobId);
    assert.equal(detectionJob.status, 'CANCELLED');
    assert.equal(JSON.parse(detectionJob.result).ignoreReason, 'STALE_MANUAL_REPLY_DETECTION');
    assert.equal(db.prepare('SELECT status FROM agent_jobs WHERE id=?').get(laterReplyJobId).status, 'RUNNING');
    const message = db.prepare('SELECT status,decision,reply_job_id,handled_at FROM messages WHERE id=?').get(messageId);
    assert.equal(message.status, 'REPLY_RUNNING');
    assert.equal(message.decision, 'AUTO_REPLY');
    assert.equal(message.reply_job_id, laterReplyJobId);
    assert.equal(message.handled_at, null);
  });
});
