import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { cleanupDir, jsonRequest, startServer, stopChild } from './helpers/runtime.js';

function insertConversation(db, account, overrides = {}) {
  const stamp = new Date().toISOString();
  return Number(db.prepare(`INSERT INTO conversations(namespace,platform_code,account_id,message_type,external_conversation_key,user_name,
    identity_confidence,identity_source,entry_type,context_enabled,version,last_message_at,handling_mode,human_followup_state,created_at,updated_at)
    VALUES(?,?,?,?,?,?,'HIGH','test','PRIVATE_MESSAGE',1,1,?,?,?,?,?)`).run(
    `claim-guard:${account.id}:${Date.now()}:${Math.random()}`,
    account.platform_code,
    account.id,
    'PRIVATE_MESSAGE',
    `user-${Date.now()}-${Math.random()}`,
    overrides.userName || '测试用户',
    overrides.lastMessageAt || stamp,
    overrides.handlingMode || 'BOT_ACTIVE',
    overrides.humanFollowupState || 'NONE',
    stamp,
    stamp
  ).lastInsertRowid);
}

function insertMessageAndReplyJob(db, account, conversationId) {
  const stamp = new Date().toISOString();
  const messageId = Number(db.prepare(`INSERT INTO messages(platform_code,account_id,message_type,external_id,user_name,content,status,decision,reply_text,
    conversation_id,conversation_version,created_at,updated_at)
    VALUES(?,?,?,?,?,?,'REPLY_QUEUED','AUTO_REPLY','测试自动回复',?,1,?,?)`).run(
    account.platform_code, account.id, 'PRIVATE_MESSAGE', `handoff-claim-${Date.now()}-${Math.random()}`, '测试用户', '测试问题', conversationId, stamp, stamp
  ).lastInsertRowid);
  const payload = JSON.stringify({ messageId, platformCode: account.platform_code, accountId: account.id, messageType: 'PRIVATE_MESSAGE', channelType: 'PRIVATE_MESSAGE', queueLane: 'PRIVATE_MESSAGE' });
  const jobId = Number(db.prepare(`INSERT INTO agent_jobs(device_id,job_type,payload,status,attempts,created_at,available_at,channel_type,queue_lane,priority)
    VALUES(?,'REPLY',?,'QUEUED',0,?,?, 'PRIVATE_MESSAGE','PRIVATE_MESSAGE',10)`).run(account.device_id, payload, stamp, stamp).lastInsertRowid);
  db.prepare('UPDATE messages SET reply_job_id=? WHERE id=?').run(jobId, messageId);
  return { messageId, jobId };
}

function insertCollectionJob(db, account, payload, priority) {
  const stamp = new Date().toISOString();
  return Number(db.prepare(`INSERT INTO agent_jobs(device_id,job_type,payload,status,attempts,created_at,available_at,channel_type,queue_lane,priority)
    VALUES(?,'COLLECT_MESSAGES',?,'QUEUED',0,?,?, 'PRIVATE_MESSAGE','PRIVATE_MESSAGE',?)`).run(
    account.device_id, JSON.stringify(payload), stamp, stamp, priority
  ).lastInsertRowid);
}

test('任务领取最终守卫禁止人工会话回复，并确保旧会话恢复让位于新增私信', async t => {
  const runtime = await startServer({ env: {
    AUTH_ENABLED: 'false', AGENT_SHARED_TOKEN: '', QWEN_MODE: 'mock', RPA_MODE: 'simulated',
    AUTO_COLLECT_ENABLED: 'false', LOCAL_AGENT_AUTO_START: 'false', INSTANCE_LOCK_ENABLED: 'false'
  } });
  let db;
  t.after(async () => {
    try { db?.close(); } catch {}
    await stopChild(runtime.child);
    cleanupDir(runtime.dir);
  });

  db = new DatabaseSync(runtime.dbPath);
  db.exec('PRAGMA busy_timeout=5000');
  const bootstrap = await jsonRequest(runtime.base, '/api/bootstrap');
  const account = bootstrap.data.accounts.find(item => item.platform_code === 'douyin');
  assert.ok(account, runtime.child.stderrText);

  await t.test('HANDOFF_PENDING 会话排队中的回复在领取前被取消', async () => {
    db.prepare("UPDATE agent_jobs SET status='CANCELLED',completed_at=? WHERE status IN ('QUEUED','RUNNING')").run(new Date().toISOString());
    const conversationId = insertConversation(db, account, { handlingMode: 'HANDOFF_PENDING', humanFollowupState: 'WAITING' });
    const { messageId, jobId } = insertMessageAndReplyJob(db, account, conversationId);

    const claimed = await jsonRequest(runtime.base, '/api/agent/jobs/claim', { method: 'POST', body: { deviceId: account.device_id } });
    assert.equal(claimed.response.status, 200, runtime.child.stderrText);
    assert.equal(claimed.data.job, null);
    const job = db.prepare('SELECT status,result FROM agent_jobs WHERE id=?').get(jobId);
    assert.equal(job.status, 'CANCELLED');
    assert.equal(JSON.parse(job.result).ignoreReason, 'CONVERSATION_AUTOMATION_DISABLED');
    const message = db.prepare('SELECT status,decision,reply_job_id FROM messages WHERE id=?').get(messageId);
    assert.equal(message.status, 'MANUAL_REQUIRED');
    assert.equal(message.decision, 'HUMAN_HANDOFF');
    assert.equal(message.reply_job_id, null);
  });

  await t.test('新增私信任务先领取，完成后旧会话恢复才可领取并记录扫描时间', async () => {
    db.prepare("UPDATE agent_jobs SET status='CANCELLED',completed_at=? WHERE status IN ('QUEUED','RUNNING')").run(new Date().toISOString());
    const conversationId = insertConversation(db, account);
    const recoveryJobId = insertCollectionJob(db, account, {
      platformCode: account.platform_code,
      accountId: account.id,
      recoveryScan: true,
      oldConversationScan: true,
      scanMode: 'OLD_CONVERSATIONS',
      conversationId,
      types: ['PRIVATE_MESSAGE'],
      channelType: 'PRIVATE_MESSAGE',
      queueLane: 'PRIVATE_MESSAGE'
    }, 80);
    const incrementalJobId = insertCollectionJob(db, account, {
      platformCode: account.platform_code,
      accountId: account.id,
      types: ['PRIVATE_MESSAGE'],
      channelType: 'PRIVATE_MESSAGE',
      queueLane: 'PRIVATE_MESSAGE'
    }, 20);

    const first = await jsonRequest(runtime.base, '/api/agent/jobs/claim', { method: 'POST', body: { deviceId: account.device_id } });
    assert.equal(first.response.status, 200, runtime.child.stderrText);
    assert.equal(first.data.job.id, incrementalJobId);
    assert.equal(db.prepare('SELECT status FROM agent_jobs WHERE id=?').get(recoveryJobId).status, 'QUEUED');

    db.prepare("UPDATE agent_jobs SET status='SUCCESS',completed_at=?,lease_expires_at=NULL WHERE id=?").run(new Date().toISOString(), incrementalJobId);
    const second = await jsonRequest(runtime.base, '/api/agent/jobs/claim', { method: 'POST', body: { deviceId: account.device_id } });
    assert.equal(second.response.status, 200, runtime.child.stderrText);
    assert.equal(second.data.job.id, recoveryJobId);
    assert.deepEqual(second.data.job.payload.types, ['PRIVATE_MESSAGE']);
    assert.equal(second.data.job.payload.maxPrivateSessions, 2);
    assert.deepEqual(second.data.job.payload.conversationIds, [conversationId]);
    assert.ok(db.prepare('SELECT last_recovery_scan_at FROM conversations WHERE id=?').get(conversationId).last_recovery_scan_at);
  });
});

