import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { executeClaimedJobWithPlatformGuard } from '../agent/platform-runtime-guard.js';

process.env.AUTH_ENABLED = 'false';
process.env.AGENT_SHARED_TOKEN = '';
process.env.SMOKE_TEST_ENABLED = 'false';

const root = path.resolve(import.meta.dirname, '..');

async function freePort() {
  const server = http.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function request(base, pathname, options = {}) {
  const response = await fetch(base + pathname, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }
  });
  return { response, data: await response.json() };
}

async function waitFor(base) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(base + '/api/health');
      if (response.ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('测试服务启动超时');
}

test('微博智能回复关闭时不创建或领取回复任务，开启后才允许领取', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smart-reply-control-'));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      DATABASE_PATH: path.join(dir, 'test.db'),
      QWEN_MODE: 'mock',
      RPA_MODE: 'simulated',
      AUTO_COLLECT_ENABLED: 'false',
      LOCAL_AGENT_AUTO_START: 'false'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await Promise.race([new Promise(resolve => child.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 2000))]);
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await waitFor(base);
  const bootstrap = (await request(base, '/api/bootstrap')).data;
  const account = bootstrap.accounts.find(item => item.platform_code === 'weibo');
  assert.ok(account, stderr);

  const disabled = await request(base, '/api/platforms/weibo/smart-reply', {
    method: 'POST',
    body: JSON.stringify({ enabled: false, updatedBy: '自动化测试' })
  });
  assert.equal(disabled.response.status, 200);
  assert.equal(disabled.data.smartReply.enabled, false);
  assert.equal(disabled.data.platform.smart_reply_enabled, false);

  const collected = await request(base, '/api/messages/simulate', {
    method: 'POST',
    body: JSON.stringify({
      platformCode: 'weibo',
      accountId: account.id,
      messageType: 'COMMENT',
      externalId: `smart-reply-off-${Date.now()}`,
      userName: '智能回复开关测试用户',
      content: '社区服务中心的办公时间是什么？',
      context: { postId: `post-${Date.now()}`, commentId: `comment-${Date.now()}`, sourceVerified: true }
    })
  });
  assert.equal(collected.response.status, 201);
  assert.equal(collected.data.message.status, 'NEW');
  assert.equal(collected.data.message.decision, 'SMART_REPLY_PAUSED');
  assert.equal(collected.data.message.reply_job_id, null);

  const blockedClaim = await request(base, '/api/agent/jobs/claim', {
    method: 'POST',
    body: JSON.stringify({ deviceId: account.device_id, platformCodes: ['weibo'] })
  });
  assert.equal(blockedClaim.response.status, 200);
  assert.equal(blockedClaim.data.job, null);

  const enabled = await request(base, '/api/platforms/weibo/smart-reply', {
    method: 'POST',
    body: JSON.stringify({ enabled: true, updatedBy: '自动化测试' })
  });
  assert.equal(enabled.response.status, 200);
  assert.equal(enabled.data.smartReply.enabled, true);
  assert.equal(enabled.data.platform.smart_reply_effective_state, 'RUNNING');

  const retried = await request(base, `/api/messages/${collected.data.message.id}/retry`, { method: 'POST', body: '{}' });
  assert.equal(retried.response.status, 200);
  assert.equal(retried.data.message.status, 'REPLY_QUEUED');
  assert.ok(retried.data.message.reply_job_id);

  const claimed = await request(base, '/api/agent/jobs/claim', {
    method: 'POST',
    body: JSON.stringify({ deviceId: account.device_id, platformCodes: ['weibo'] })
  });
  assert.equal(claimed.response.status, 200);
  assert.equal(claimed.data.job.job_type, 'REPLY');
  assert.equal(claimed.data.job.payload.messageId, collected.data.message.id);
});


test('消息重新判断不再依赖AI自检，并仅在明确未发送时自动释放问题阻断', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'message-operator-safe-retry-'));
  const dbPath = path.join(dir, 'test.db');
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      DATABASE_PATH: dbPath,
      QWEN_MODE: 'mock',
      RPA_MODE: 'simulated',
      AUTO_COLLECT_ENABLED: 'false',
      LOCAL_AGENT_AUTO_START: 'false',
      ISSUE_DIAGNOSIS_ENABLED: 'false'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await Promise.race([new Promise(resolve => child.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 2000))]);
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await waitFor(base);
  const bootstrap = (await request(base, '/api/bootstrap')).data;
  const account = bootstrap.accounts.find(item => item.platform_code === 'weibo');
  assert.ok(account, stderr);
  await request(base, '/api/platforms/weibo/smart-reply', {
    method: 'POST',
    body: JSON.stringify({ enabled: false, updatedBy: '自动化测试' })
  });

  async function collectPausedMessage(label) {
    const result = await request(base, '/api/messages/simulate', {
      method: 'POST',
      body: JSON.stringify({
        platformCode: 'weibo',
        accountId: account.id,
        messageType: 'COMMENT',
        externalId: `operator-retry-${label}-${Date.now()}-${Math.random()}`,
        userName: `重新判断测试-${label}`,
        content: '社区服务中心的办公时间是什么？',
        context: { postId: `post-${label}`, commentId: `comment-${label}`, sourceVerified: true }
      })
    });
    assert.equal(result.response.status, 201, JSON.stringify(result.data));
    return result.data.message;
  }

  const safeMessage = await collectPausedMessage('safe');
  const missingEvidenceMessage = await collectPausedMessage('missing-evidence');
  const uncertainReplyMessage = await collectPausedMessage('uncertain-reply');
  await request(base, '/api/platforms/weibo/smart-reply', {
    method: 'POST',
    body: JSON.stringify({ enabled: true, updatedBy: '自动化测试' })
  });

  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA busy_timeout=15000');
  const stamp = new Date().toISOString();
  const setTechnicalFailure = (messageId, replyContext) => db.prepare(`UPDATE messages
    SET status='MANUAL_REQUIRED',decision='TECHNICAL_ERROR',reason='模型请求失败',reply_job_id=NULL,reply_context_json=?,updated_at=?
    WHERE id=?`).run(JSON.stringify(replyContext), stamp, messageId);
  const insertIssue = (messageId, issueSource, category, title) => Number(db.prepare(`INSERT INTO issues(
    source,category,level,title,detail,status,related_type,related_id,created_at,updated_at,occurrences,last_seen_at,retryable
  ) VALUES(?,?,'ERROR',?,'定向测试','OPEN','MESSAGE',?,?,?,1,?,1)`).run(
    issueSource, category, title, String(messageId), stamp, stamp, stamp
  ).lastInsertRowid);
  const insertBlock = (messageId, issueId) => db.prepare(`INSERT INTO runtime_blocks(issue_id,scope,block_key,feature,reason,status,created_at)
    VALUES(?,'TASK',?,'reply','消息处理失败','ACTIVE',?)`).run(issueId, `MESSAGE:${messageId}`, stamp);

  setTechnicalFailure(safeMessage.id, {
    errorCode: 'AI_REQUEST_FAILED',
    errorStage: 'KNOWLEDGE_OR_REPLY',
    retrySafe: true,
    platformSendTaskCreated: false
  });
  const safeIssueId = insertIssue(safeMessage.id, 'QWEN', 'MODEL_API', '模型请求失败');
  insertBlock(safeMessage.id, safeIssueId);

  setTechnicalFailure(missingEvidenceMessage.id, {
    errorCode: 'AI_REQUEST_FAILED',
    errorStage: 'KNOWLEDGE_OR_REPLY',
    retrySafe: true
  });
  const missingEvidenceIssueId = insertIssue(missingEvidenceMessage.id, 'QWEN', 'MODEL_API', '模型请求失败但发送证据缺失');
  insertBlock(missingEvidenceMessage.id, missingEvidenceIssueId);

  const uncertainJobId = Number(db.prepare(`INSERT INTO agent_jobs(
    device_id,job_type,payload,status,result,created_at,completed_at,idempotency_key,available_at
  ) VALUES(?,'REPLY',?,'NEEDS_CONFIRMATION',?,?,?,?,?)`).run(
    account.device_id,
    JSON.stringify({ messageId: uncertainReplyMessage.id, platformCode: 'weibo' }),
    JSON.stringify({ message: '平台提交后结果不明确', sendAttempted: true }),
    stamp,
    stamp,
    `reply:uncertain:${uncertainReplyMessage.id}`,
    stamp
  ).lastInsertRowid);
  db.prepare(`UPDATE messages SET status='MANUAL_REQUIRED',decision='TECHNICAL_ERROR',reason='回复结果不明确',reply_job_id=?,updated_at=? WHERE id=?`)
    .run(uncertainJobId, stamp, uncertainReplyMessage.id);
  const uncertainIssueId = insertIssue(uncertainReplyMessage.id, 'RPA', 'REPLY', '回复结果不明确');
  insertBlock(uncertainReplyMessage.id, uncertainIssueId);
  db.close();

  const safeRetry = await request(base, `/api/messages/${safeMessage.id}/retry`, { method: 'POST', body: '{}' });
  assert.equal(safeRetry.response.status, 200, JSON.stringify(safeRetry.data));
  assert.doesNotMatch(JSON.stringify(safeRetry.data), /AI\s*自检/);

  const verifySafeDb = new DatabaseSync(dbPath, { readOnly: true });
  const resolvedIssue = verifySafeDb.prepare('SELECT status,resolution_type,resolved_by FROM issues WHERE id=?').get(safeIssueId);
  const releasedBlock = verifySafeDb.prepare('SELECT status,released_by FROM runtime_blocks WHERE issue_id=?').get(safeIssueId);
  const diagnosisCount = verifySafeDb.prepare('SELECT COUNT(*) AS count FROM issue_diagnoses WHERE issue_id=?').get(safeIssueId).count;
  verifySafeDb.close();
  assert.equal(resolvedIssue.status, 'RESOLVED');
  assert.equal(resolvedIssue.resolution_type, 'OPERATOR_SAFE_RETRY');
  assert.equal(resolvedIssue.resolved_by, 'WEB_OPERATOR');
  assert.equal(releasedBlock.status, 'RELEASED');
  assert.equal(releasedBlock.released_by, 'WEB_OPERATOR');
  assert.equal(diagnosisCount, 0);

  const missingEvidenceRetry = await request(base, `/api/messages/${missingEvidenceMessage.id}/retry`, { method: 'POST', body: '{}' });
  assert.equal(missingEvidenceRetry.response.status, 409);
  assert.doesNotMatch(JSON.stringify(missingEvidenceRetry.data), /AI\s*自检/);
  assert.match(JSON.stringify(missingEvidenceRetry.data), /人工确认/);

  const uncertainReplyRetry = await request(base, `/api/messages/${uncertainReplyMessage.id}/retry`, { method: 'POST', body: '{}' });
  assert.equal(uncertainReplyRetry.response.status, 409);
  assert.doesNotMatch(JSON.stringify(uncertainReplyRetry.data), /AI\s*自检/);
  assert.match(JSON.stringify(uncertainReplyRetry.data), /重复回复|结果不可确定|人工核对/);

  const verifyBlockedDb = new DatabaseSync(dbPath, { readOnly: true });
  assert.equal(verifyBlockedDb.prepare('SELECT status FROM issues WHERE id=?').get(missingEvidenceIssueId).status, 'OPEN');
  assert.equal(verifyBlockedDb.prepare('SELECT status FROM runtime_blocks WHERE issue_id=?').get(missingEvidenceIssueId).status, 'ACTIVE');
  assert.equal(verifyBlockedDb.prepare('SELECT status FROM issues WHERE id=?').get(uncertainIssueId).status, 'OPEN');
  assert.equal(verifyBlockedDb.prepare('SELECT status FROM runtime_blocks WHERE issue_id=?').get(uncertainIssueId).status, 'ACTIVE');
  verifyBlockedDb.close();
});
test('AI安全重试会先释放消息回复阻断，结果不明确时仍保持阻断', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'safe-retry-release-'));
  const dbPath = path.join(dir, 'test.db');
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      DATABASE_PATH: dbPath,
      QWEN_MODE: 'mock',
      RPA_MODE: 'simulated',
      AUTO_COLLECT_ENABLED: 'false',
      LOCAL_AGENT_AUTO_START: 'false'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await Promise.race([new Promise(resolve => child.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 2000))]);
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await waitFor(base);
  const bootstrap = (await request(base, '/api/bootstrap')).data;
  const account = bootstrap.accounts.find(item => item.platform_code === 'weibo');
  assert.ok(account, stderr);

  await request(base, '/api/platforms/weibo/smart-reply', {
    method: 'POST',
    body: JSON.stringify({ enabled: false, updatedBy: '自动化测试' })
  });
  const collected = await request(base, '/api/messages/simulate', {
    method: 'POST',
    body: JSON.stringify({
      platformCode: 'weibo',
      accountId: account.id,
      messageType: 'COMMENT',
      externalId: `safe-retry-${Date.now()}`,
      userName: '安全重试测试用户',
      content: '社区服务中心的办公时间是什么？',
      context: { postId: `post-${Date.now()}`, commentId: `comment-${Date.now()}`, sourceVerified: true }
    })
  });
  assert.equal(collected.response.status, 201);
  await request(base, '/api/platforms/weibo/smart-reply', {
    method: 'POST',
    body: JSON.stringify({ enabled: true, updatedBy: '自动化测试' })
  });

  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA busy_timeout=15000');
  const stamp = new Date().toISOString();
  const cancelledReplyKey = `reply:message:${collected.data.message.id}`;
  const cancelledJobResult = db.prepare(`INSERT INTO agent_jobs(device_id,job_type,payload,status,result,created_at,completed_at,idempotency_key,available_at)
    VALUES(?,'REPLY',?,'CANCELLED',?,?,?, ?,?)`).run(
      account.device_id, JSON.stringify({ messageId: collected.data.message.id, platformCode: 'weibo' }),
      JSON.stringify({ message: '旧候选回复已安全取消' }), stamp, stamp, cancelledReplyKey, stamp
    );
  const cancelledJobId = Number(cancelledJobResult.lastInsertRowid);
  const issueResult = db.prepare(`INSERT INTO issues(source,category,level,title,detail,status,related_type,related_id,created_at,updated_at,occurrences,last_seen_at,retryable)
    VALUES('MODEL_API','SYSTEM_ERROR','ERROR','回复故障','定向测试','DIAGNOSED','MESSAGE',?,?,?,1,?,1)`).run(String(collected.data.message.id), stamp, stamp, stamp);
  const issueId = Number(issueResult.lastInsertRowid);
  const diagnosisResult = db.prepare(`INSERT INTO issue_diagnoses(issue_id,mode,status,category,safe_to_retry,summary,requested_by,completed_at,created_at,updated_at)
    VALUES(?,'READ_ONLY','COMPLETED','SYSTEM_ERROR',1,'确认可安全重试','自动化测试',?,?,?)`).run(issueId, stamp, stamp, stamp);
  const diagnosisId = Number(diagnosisResult.lastInsertRowid);
  db.prepare('UPDATE issues SET latest_diagnosis_id=?,diagnosis_status=? WHERE id=?').run(diagnosisId, 'COMPLETED', issueId);
  db.prepare(`INSERT INTO runtime_blocks(issue_id,scope,block_key,feature,reason,status,created_at)
    VALUES(?,'TASK',?,'reply','回复故障','ACTIVE',?)`).run(issueId, `MESSAGE:${collected.data.message.id}`, stamp);
  db.close();

  const retried = await request(base, `/api/issues/${issueId}/retry`, { method: 'POST', body: '{}' });
  assert.equal(retried.response.status, 200, JSON.stringify(retried.data));

  const verifyDb = new DatabaseSync(dbPath, { readOnly: true });
  const released = verifyDb.prepare('SELECT status,released_by,release_reason FROM runtime_blocks WHERE issue_id=?').get(issueId);
  const message = verifyDb.prepare('SELECT status,reply_job_id FROM messages WHERE id=?').get(collected.data.message.id);
  const cancelledJob = verifyDb.prepare('SELECT status,idempotency_key FROM agent_jobs WHERE id=?').get(cancelledJobId);
  const replacementJob = verifyDb.prepare('SELECT status,idempotency_key FROM agent_jobs WHERE id=?').get(message.reply_job_id);
  verifyDb.close();
  assert.equal(released.status, 'RELEASED');
  assert.equal(released.released_by, 'AI_SAFE_RETRY');
  assert.match(released.release_reason, new RegExp(`Diagnosis#${diagnosisId}`));
  assert.equal(message.status, 'REPLY_QUEUED');
  assert.ok(message.reply_job_id);
  assert.notEqual(message.reply_job_id, cancelledJobId);
  assert.equal(cancelledJob.status, 'CANCELLED');
  assert.equal(cancelledJob.idempotency_key, null);
  assert.equal(replacementJob.status, 'QUEUED');
  assert.equal(replacementJob.idempotency_key, cancelledReplyKey);

  const claimed = await request(base, '/api/agent/jobs/claim', {
    method: 'POST',
    body: JSON.stringify({ deviceId: account.device_id, platformCodes: ['weibo'] })
  });
  assert.equal(claimed.response.status, 200);
  assert.equal(claimed.data.job.job_type, 'REPLY');
  assert.equal(claimed.data.job.payload.messageId, collected.data.message.id);

  const uncertainDb = new DatabaseSync(dbPath);
  uncertainDb.exec('PRAGMA busy_timeout=15000');
  const uncertainIssue = uncertainDb.prepare(`INSERT INTO issues(source,category,level,title,detail,status,related_type,related_id,created_at,updated_at,occurrences,last_seen_at,retryable)
    VALUES('RPA','RESULT_UNCERTAIN','ERROR','发送结果不明确','定向测试','DIAGNOSED','MESSAGE',?,?,?,1,?,1)`).run(String(collected.data.message.id), stamp, stamp, stamp);
  const uncertainIssueId = Number(uncertainIssue.lastInsertRowid);
  uncertainDb.prepare(`INSERT INTO issue_diagnoses(issue_id,mode,status,category,safe_to_retry,summary,requested_by,completed_at,created_at,updated_at)
    VALUES(?,'READ_ONLY','COMPLETED','RESULT_UNCERTAIN',1,'必须人工确认','自动化测试',?,?,?)`).run(uncertainIssueId, stamp, stamp, stamp);
  uncertainDb.prepare(`INSERT INTO runtime_blocks(issue_id,scope,block_key,feature,reason,status,created_at)
    VALUES(?,'TASK',?,'reply','结果不明确','ACTIVE',?)`).run(uncertainIssueId, `MESSAGE:${collected.data.message.id}`, stamp);
  uncertainDb.close();

  const rejected = await request(base, `/api/issues/${uncertainIssueId}/retry`, { method: 'POST', body: '{}' });
  assert.equal(rejected.response.status, 409);
  const finalDb = new DatabaseSync(dbPath, { readOnly: true });
  assert.equal(finalDb.prepare('SELECT status FROM runtime_blocks WHERE issue_id=?').get(uncertainIssueId).status, 'ACTIVE');
  finalDb.close();
});
test('Local Agent执行前发现智能回复关闭时不解析或调用适配器', async () => {
  let deferred = false;
  let adapterResolved = false;
  let adapterCalled = false;
  const result = await executeClaimedJobWithPlatformGuard({
    job: { id: 91, job_type: 'REPLY', payload: { platformCode: 'weibo', messageId: 12 } },
    getRuntime: async () => ({ code: 'weibo', effective_state: 'RUNNING', smart_reply_enabled: false }),
    deferJob: async (_job, runtime) => {
      deferred = true;
      assert.equal(runtime.blocked_reason, 'SMART_REPLY_STOPPED');
    },
    resolveAdapter: () => {
      adapterResolved = true;
      return {};
    },
    executeAdapter: async () => {
      adapterCalled = true;
      return { status: 'SUCCESS', result: {} };
    }
  });
  assert.equal(result.deferred, true);
  assert.equal(deferred, true);
  assert.equal(adapterResolved, false);
  assert.equal(adapterCalled, false);
});

test('前端平台启停页展示并调用真实的智能回复接口', () => {
  const source = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
  assert.match(source, /smartReplyText/);
  assert.match(source, /\/api\/platforms\/\$\{platformCode\}\/smart-reply/);
  assert.match(source, /platform-smart-reply-toggle/);
  assert.match(source, /task_execution_state==='RUNNING'/);
  assert.doesNotMatch(source, /runtimeByPlatform\.get\(account\.platform_code\)\?\.effective_state==='RUNNING'/);
});

test('frontend master switch exposes Local Agent lifecycle status', () => {
  const source = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
  assert.match(source, /result\.agentShutdown\?\.stopped/);
  assert.equal(source.includes('Local Agent \\u5df2\\u5173\\u95ed'), true);
  assert.equal(source.includes('\\u6b63\\u5728\\u5173\\u95ed Local Agent'), true);
  assert.equal(source.includes('\\u542f\\u52a8 Agent \\u5e76\\u6062\\u590d\\u8fd0\\u884c'), true);
});



