import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { cleanupDir, jsonRequest, startServer, stopChild } from './helpers/runtime.js';

function prepareRuntimeRecord(db, suffix, { replyStatus = 'QUEUED', includeDetectionPurpose = false, replyMode = null } = {}) {
  const stamp = new Date().toISOString();
  const account = db.prepare("SELECT * FROM accounts WHERE platform_code='weibo' ORDER BY id LIMIT 1").get();
  assert.ok(account);
  db.prepare("UPDATE accounts SET enabled=1 WHERE id=?").run(account.id);
  db.prepare("UPDATE platforms SET desired_state='RUNNING',lifecycle_state='ACTIVE' WHERE code='weibo'").run();
  const expectedReply = `只读核验回复-${suffix}`;
  const messageId = Number(db.prepare(`INSERT INTO messages(
      platform_code,account_id,message_type,external_id,user_name,content,status,decision,reply_text,context_json,created_at,updated_at,collected_at
    ) VALUES('weibo',?,'COMMENT',?,?,?,'MANUAL_REQUIRED','TECHNICAL_ERROR',?,'{}',?,?,?)`)
    .run(account.id, `readonly-comment-${suffix}`, `用户-${suffix}`, `问题-${suffix}`, expectedReply, stamp, stamp, stamp).lastInsertRowid);
  const replyPayload = {
    messageId,
    platformCode: 'weibo',
    accountId: account.id,
    messageType: 'COMMENT',
    sourceContent: `问题-${suffix}`,
    expectedReply,
    replyText: expectedReply,
    ...(replyMode ? { replyMode } : {})
  };
  const replyResult = { sendAttempted: true, submitAttempted: true, message: '发送动作已发生但回执不确定' };
  const replyJobId = Number(db.prepare(`INSERT INTO agent_jobs(device_id,job_type,payload,status,result,attempts,created_at,completed_at,idempotency_key,available_at)
    VALUES(?,'REPLY',?,?,?,?,?,?,?,?)`).run(
      account.device_id,
      JSON.stringify(replyPayload),
      replyStatus,
      JSON.stringify(replyResult),
      replyStatus === 'QUEUED' ? 0 : 1,
      stamp,
      replyStatus === 'QUEUED' ? null : stamp,
      `readonly-reply-${suffix}`,
      stamp
    ).lastInsertRowid);
  db.prepare('UPDATE messages SET reply_job_id=?,reason=? WHERE id=?').run(replyJobId, '微博已尝试发布，但未观察到本次动作产生的唯一回执；禁止自动重发，请人工核对', messageId);
  const issueId = Number(db.prepare(`INSERT INTO issues(source,category,level,title,detail,status,related_type,related_id,created_at,updated_at,occurrences,last_seen_at,retryable,block_scope,block_key)
    VALUES('RPA','REPLY','ERROR','微博自动回复回执不可信','等待只读核验','OPEN','MESSAGE',?,?,?,1,?,1,'TASK',?)`)
    .run(String(messageId), stamp, stamp, stamp, `MESSAGE:${messageId}`).lastInsertRowid);
  const blockId = Number(db.prepare(`INSERT INTO runtime_blocks(issue_id,scope,block_key,feature,reason,status,created_at)
    VALUES(?,'TASK',?,'reply','微博自动回复回执不可信','ACTIVE',?)`).run(issueId, `MESSAGE:${messageId}`, stamp).lastInsertRowid);
  const detectionPayload = {
    messageId,
    platformCode: 'weibo',
    accountId: account.id,
    messageType: 'COMMENT',
    sourceContent: `问题-${suffix}`,
    expectedReply,
    replyJobIdAtCreation: replyJobId,
    latestReplyJobIdAtCreation: replyJobId,
    messageUpdatedAtAtCreation: stamp,
    ...(includeDetectionPurpose ? { detectionPurpose: 'CONFIRM_UNCERTAIN_AUTO_REPLY', sourceReplyJobId: replyJobId } : {})
  };
  const detectionJobId = Number(db.prepare(`INSERT INTO agent_jobs(device_id,job_type,payload,status,attempts,created_at,idempotency_key,available_at)
    VALUES(?,'DETECT_MANUAL_REPLY',?,'QUEUED',0,?,?,?)`).run(
      account.device_id,
      JSON.stringify(detectionPayload),
      `readonly-detect-${suffix}`,
      stamp,
      stamp
    ).lastInsertRowid);
  return { account, messageId, replyJobId, issueId, blockId, detectionJobId, expectedReply };
}

test('消息回复写阻塞仍拦截REPLY，但允许同一消息的DETECT_MANUAL_REPLY只读核验', async t => {
  const runtime = await startServer();
  t.after(async () => { await stopChild(runtime.child); cleanupDir(runtime.dir); });
  const db = new DatabaseSync(runtime.dbPath);
  db.exec('PRAGMA busy_timeout=15000');
  const record = prepareRuntimeRecord(db, 'block-policy', { replyStatus: 'QUEUED', includeDetectionPurpose: true });
  db.close();

  const claimed = await jsonRequest(runtime.base, '/api/agent/jobs/claim', { method: 'POST', body: { deviceId: record.account.device_id } });
  assert.equal(claimed.response.status, 200);
  assert.equal(claimed.data.job.id, record.detectionJobId);
  assert.equal(claimed.data.job.job_type, 'DETECT_MANUAL_REPLY');

  const verifyDb = new DatabaseSync(runtime.dbPath, { readOnly: true });
  verifyDb.exec('PRAGMA busy_timeout=15000');
  assert.equal(verifyDb.prepare('SELECT status FROM agent_jobs WHERE id=?').get(record.replyJobId).status, 'QUEUED');
  assert.equal(verifyDb.prepare('SELECT status FROM runtime_blocks WHERE id=?').get(record.blockId).status, 'ACTIVE');
  verifyDb.close();
});

test('只读核验找到不确定自动回复后标记AUTO_REPLIED，并关闭对应问题与任务阻塞', async t => {
  const runtime = await startServer();
  t.after(async () => { await stopChild(runtime.child); cleanupDir(runtime.dir); });
  const db = new DatabaseSync(runtime.dbPath);
  db.exec('PRAGMA busy_timeout=15000');
  // 不写 detectionPurpose，覆盖升级前已经排队的 #3566 兼容路径。
  const record = prepareRuntimeRecord(db, 'legacy-auto-confirm', { replyStatus: 'NEEDS_CONFIRMATION', includeDetectionPurpose: false });
  db.close();

  const claimed = await jsonRequest(runtime.base, '/api/agent/jobs/claim', { method: 'POST', body: { deviceId: record.account.device_id } });
  assert.equal(claimed.response.status, 200);
  assert.equal(claimed.data.job.id, record.detectionJobId);
  const completed = await jsonRequest(runtime.base, `/api/agent/jobs/${record.detectionJobId}/complete`, {
    method: 'POST',
    body: { status: 'SUCCESS', result: { handled: true, message: '已在微博唯一目标范围内检测到指定回复', scopedEchoCount: 1 } }
  });
  assert.equal(completed.response.status, 200);

  const verifyDb = new DatabaseSync(runtime.dbPath, { readOnly: true });
  verifyDb.exec('PRAGMA busy_timeout=15000');
  const message = verifyDb.prepare('SELECT status,decision,handled_by,handled_at,reason,handler_note FROM messages WHERE id=?').get(record.messageId);
  assert.equal(message.status, 'AUTO_REPLIED');
  assert.equal(message.decision, 'AUTO_REPLY');
  assert.equal(message.handled_by, 'AI_RPA_CONFIRMED');
  assert.ok(message.handled_at);
  assert.equal(message.reason, '已在微博唯一目标范围内检测到指定回复');
  assert.equal(message.handler_note, '已在微博唯一目标范围内检测到指定回复');
  const issue = verifyDb.prepare('SELECT status,resolution_type,resolved_by FROM issues WHERE id=?').get(record.issueId);
  assert.equal(issue.status, 'RESOLVED');
  assert.equal(issue.resolution_type, 'PLATFORM_REPLY_CONFIRMED');
  assert.equal(issue.resolved_by, 'SYSTEM_READ_ONLY_VERIFY');
  const block = verifyDb.prepare('SELECT status,released_by FROM runtime_blocks WHERE id=?').get(record.blockId);
  assert.equal(block.status, 'RELEASED');
  assert.equal(block.released_by, 'SYSTEM_READ_ONLY_VERIFY');
  verifyDb.close();
});

test('只读核验找到人工回复后标记MANUAL_HANDLED，并覆盖旧失败原因', async t => {
  const runtime = await startServer();
  t.after(async () => { await stopChild(runtime.child); cleanupDir(runtime.dir); });
  const db = new DatabaseSync(runtime.dbPath);
  db.exec('PRAGMA busy_timeout=15000');
  const record = prepareRuntimeRecord(db, 'manual-confirm', { replyStatus: 'SUCCESS', replyMode: 'MANUAL' });
  db.close();

  const claimed = await jsonRequest(runtime.base, '/api/agent/jobs/claim', { method: 'POST', body: { deviceId: record.account.device_id } });
  assert.equal(claimed.response.status, 200);
  assert.equal(claimed.data.job.id, record.detectionJobId);
  const successNote = '已在微博“发出的评论”中唯一确认运营人员回复成功';
  const completed = await jsonRequest(runtime.base, `/api/agent/jobs/${record.detectionJobId}/complete`, {
    method: 'POST',
    body: { status: 'SUCCESS', result: { handled: true, message: successNote, matchCount: 1 } }
  });
  assert.equal(completed.response.status, 200);

  const verifyDb = new DatabaseSync(runtime.dbPath, { readOnly: true });
  verifyDb.exec('PRAGMA busy_timeout=15000');
  const message = verifyDb.prepare('SELECT status,decision,handled_by,handled_at,reason,handler_note FROM messages WHERE id=?').get(record.messageId);
  assert.equal(message.status, 'MANUAL_HANDLED');
  assert.equal(message.decision, 'MANUAL_HANDLED');
  assert.equal(message.handled_by, 'PLATFORM_DETECTED');
  assert.ok(message.handled_at);
  assert.equal(message.reason, successNote);
  assert.equal(message.handler_note, successNote);
  verifyDb.close();
});


test('只读核验未找到回复后允许再次点击重新校验并创建新任务', async t => {
  const runtime = await startServer();
  t.after(async () => { await stopChild(runtime.child); cleanupDir(runtime.dir); });
  const db = new DatabaseSync(runtime.dbPath);
  db.exec('PRAGMA busy_timeout=15000');
  const record = prepareRuntimeRecord(db, 'repeat-detection', { replyStatus: 'NEEDS_CONFIRMATION', includeDetectionPurpose: true });
  db.prepare("UPDATE agent_jobs SET status='CANCELLED',completed_at=? WHERE id=?").run(new Date().toISOString(), record.detectionJobId);
  db.close();

  const first = await jsonRequest(runtime.base, `/api/messages/${record.messageId}/detect-manual`, {
    method: 'POST',
    body: { expectedReply: record.expectedReply }
  });
  assert.equal(first.response.status, 200);
  const firstJobId = Number(first.data.jobId);
  assert.ok(firstJobId > 0);

  const claimed = await jsonRequest(runtime.base, '/api/agent/jobs/claim', { method: 'POST', body: { deviceId: record.account.device_id } });
  assert.equal(claimed.response.status, 200);
  assert.equal(claimed.data.job.id, firstJobId);
  const completed = await jsonRequest(runtime.base, `/api/agent/jobs/${firstJobId}/complete`, {
    method: 'POST',
    body: { status: 'SUCCESS', result: { handled: false, message: '本次尚未检测到回复' } }
  });
  assert.equal(completed.response.status, 200);

  const second = await jsonRequest(runtime.base, `/api/messages/${record.messageId}/detect-manual`, {
    method: 'POST',
    body: { expectedReply: record.expectedReply }
  });
  assert.equal(second.response.status, 200);
  assert.notEqual(Number(second.data.jobId), firstJobId);
});
