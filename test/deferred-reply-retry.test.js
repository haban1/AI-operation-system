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
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(base + '/api/health');
      if (response.ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('测试服务启动超时');
}

async function api(base, pathname, { method = 'GET', body } = {}) {
  const response = await fetch(base + pathname, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { response, data: await response.json() };
}

function incomingGreeting(account, externalId, suffix = '') {
  return {
    platformCode: 'douyin',
    accountId: account.id,
    messageType: 'PRIVATE_MESSAGE',
    externalId,
    userName: `安全重试用户${suffix}`,
    content: '你好啊',
    externalUrl: 'https://www.douyin.com/user/self',
    context: {
      inboxType: 'OPEN_CONVERSATION',
      collectionSource: 'OPEN_CONVERSATION_TIMELINE',
      conversationName: `安全重试用户${suffix}`,
      conversationId: `conversation-${suffix || 'safe'}`,
      conversationKey: `conversation-${suffix || 'safe'}`,
      messageId: `message-${suffix || 'safe'}`,
      direction: 'incoming',
      previewOnly: false,
      fullSource: true,
      sourceVerified: true,
      chatTitleVerified: true,
      privateVerificationReason: 'OPEN_CHAT_LATEST_INCOMING_VERIFIED'
    }
  };
}

test('页面未发送的抖音回复可创建新任务，结果不明确的旧任务禁止自动重发，Web 显示真实任务状态', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deferred-reply-retry-'));
  const databasePath = path.join(dir, 'test.db');
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port), DATABASE_PATH: databasePath,
      AUTH_ENABLED: 'false', AGENT_SHARED_TOKEN: '', QWEN_MODE: 'mock', RPA_MODE: 'simulated',
      AUTO_COLLECT_ENABLED: 'false', LOCAL_AGENT_AUTO_START: 'false', INSTANCE_LOCK_ENABLED: 'false',
      MESSAGE_EVENT_LEDGER_ENABLED: 'false'
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
  const bootstrap = (await api(base, '/api/bootstrap')).data;
  const account = bootstrap.accounts.find(item => item.platform_code === 'douyin');
  assert.ok(account, stderr);

  const safePayload = incomingGreeting(account, `safe-deferred-${Date.now()}`);
  const first = await api(base, '/api/agent/messages/upsert', { method: 'POST', body: safePayload });
  assert.equal(first.response.status, 200, stderr);
  const firstMessage = first.data.results[0].message;
  const oldJobId = Number(firstMessage.reply_job_id);
  assert.equal(firstMessage.status, 'REPLY_QUEUED');
  assert.ok(oldJobId > 0);
  const oldKey = db.prepare('SELECT idempotency_key FROM agent_jobs WHERE id=?').get(oldJobId).idempotency_key;
  assert.ok(oldKey);

  db.prepare("UPDATE agent_jobs SET status='RUNNING',claimed_at=?,attempts=1 WHERE id=?").run(new Date().toISOString(), oldJobId);
  db.prepare("UPDATE messages SET status='REPLY_RUNNING' WHERE id=?").run(firstMessage.id);
  const completed = await api(base, `/api/agent/jobs/${oldJobId}/complete`, {
    method: 'POST',
    body: {
      status: 'NEEDS_CONFIRMATION',
      result: {
        message: '未可靠定位抖音私信会话，已停止自动回复',
        stage: 'reply_page_deferred',
        status: 'DEFERRED_PAGE_UNAVAILABLE',
        sourceState: 'DEFERRED_PAGE_UNAVAILABLE',
        decision: 'DEFERRED_PAGE_UNAVAILABLE',
        retrySafe: true,
        target: { ok: false, reason: 'CONVERSATION_NOT_FOUND' }
      }
    }
  });
  assert.equal(completed.response.status, 200, stderr);
  const deferredMessage = db.prepare('SELECT status,reply_job_id FROM messages WHERE id=?').get(firstMessage.id);
  assert.equal(deferredMessage.status, 'DEFERRED_PAGE_UNAVAILABLE');
  assert.equal(deferredMessage.reply_job_id, null);

  const retried = await api(base, '/api/agent/messages/upsert', { method: 'POST', body: safePayload });
  assert.equal(retried.response.status, 200, stderr);
  const retriedMessage = retried.data.results[0].message;
  const newJobId = Number(retriedMessage.reply_job_id);
  assert.equal(retriedMessage.status, 'REPLY_QUEUED');
  assert.ok(newJobId > oldJobId);
  assert.notEqual(newJobId, oldJobId);
  const jobs = db.prepare('SELECT id,status,idempotency_key FROM agent_jobs WHERE id IN (?,?) ORDER BY id').all(oldJobId, newJobId);
  assert.equal(jobs[0].status, 'NEEDS_CONFIRMATION');
  assert.equal(jobs[0].idempotency_key, null);
  assert.equal(jobs[1].status, 'QUEUED');
  assert.equal(jobs[1].idempotency_key, oldKey);

  const unsafePayload = incomingGreeting(account, `unsafe-deferred-${Date.now()}`, 'unsafe');
  const unsafeFirst = await api(base, '/api/agent/messages/upsert', { method: 'POST', body: unsafePayload });
  const unsafeMessage = unsafeFirst.data.results[0].message;
  const unsafeJobId = Number(unsafeMessage.reply_job_id);
  const unsafeKey = db.prepare('SELECT idempotency_key FROM agent_jobs WHERE id=?').get(unsafeJobId).idempotency_key;
  db.prepare("UPDATE agent_jobs SET status='NEEDS_CONFIRMATION',result=?,completed_at=? WHERE id=?")
    .run(JSON.stringify({ message: '平台可能已经发送但回执不明确', stage: 'reply_result_uncertain', sourceState: 'SEND_UNCERTAIN', retrySafe: false }), new Date().toISOString(), unsafeJobId);
  db.prepare("UPDATE messages SET status='DEFERRED_PAGE_UNAVAILABLE',decision='DEFERRED_PAGE_UNAVAILABLE',reply_job_id=NULL WHERE id=?").run(unsafeMessage.id);

  const unsafeRetry = await api(base, '/api/agent/messages/upsert', { method: 'POST', body: unsafePayload });
  assert.equal(unsafeRetry.response.status, 200, stderr);
  const blockedMessage = unsafeRetry.data.results[0].message;
  assert.equal(blockedMessage.status, 'MANUAL_REQUIRED');
  assert.equal(blockedMessage.decision, 'TECHNICAL_ERROR');
  assert.equal(blockedMessage.reply_job_id, null);
  assert.match(blockedMessage.reason, /防止平台重复发送/);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM agent_jobs WHERE idempotency_key=?').get(unsafeKey).count, 1);

  db.prepare("UPDATE messages SET status='REPLY_QUEUED',decision='AUTO_REPLY',reply_job_id=? WHERE id=?").run(unsafeJobId, unsafeMessage.id);
  const webMessages = (await api(base, '/api/messages')).data.messages;
  const webUnsafe = webMessages.find(item => item.id === unsafeMessage.id);
  assert.equal(webUnsafe.reply_job_status, 'NEEDS_CONFIRMATION');
  assert.equal(webUnsafe.reply_status.ai.state, 'FAILED');
  assert.equal(webUnsafe.reply_status.ai.replied, false);
  assert.equal(stderr.includes('SyntaxError'), false, stderr);
});
