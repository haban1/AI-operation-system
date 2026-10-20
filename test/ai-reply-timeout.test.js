import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { DatabaseSync } from 'node:sqlite';
import { describeAiReplyFailure, isAiReplyTimeout } from '../src/services/ai-reply-error.js';
import { buildManualNotification, humanizeManualReason } from '../src/services/manual-notification.js';
import { cleanupDir, jsonRequest, startServer, stopChild } from './helpers/runtime.js';

const clickTimeout = 'locator.click: Timeout 30000ms exceeded.\nCall log:\n  - waiting for locator(\'.conversation\').filter({ hasText: \'测试会话\' })\n  - element is not visible\n  - retrying click action';
const legacyTimeoutReason = 'AI 知识理解或回复生成超时，尚未生成回复且未创建平台发送任务，需要人工处理。';
const misleadingOrTechnicalText = /未生成回复|未创建平台发送任务|locator\.click|Call log|waiting for locator|retrying click action/;

test('AI AbortError has a concise timeout reason while retaining internal diagnostics', () => {
  const error = new Error('This operation was aborted');
  error.name = 'AbortError';
  assert.equal(isAiReplyTimeout(error), true);
  const failure = describeAiReplyFailure(error);
  assert.equal(failure.decision, 'AI_REPLY_TIMEOUT');
  assert.equal(failure.errorCode, 'AI_TIMEOUT');
  assert.equal(failure.reason, 'AI回复超时');
  assert.equal(failure.notificationType, 'AI_REPLY_TIMEOUT');
  assert.equal(failure.rawMessage, error.message);
  assert.doesNotMatch(failure.notificationAction, misleadingOrTechnicalText);
});

test('browser click timeout does not claim that no reply or send job was created', () => {
  const failure = describeAiReplyFailure(new Error(clickTimeout));
  assert.equal(failure.timeout, true);
  assert.equal(failure.reason, 'AI回复超时');
  assert.equal(failure.rawMessage, clickTimeout);
  assert.doesNotMatch(failure.notificationAction, misleadingOrTechnicalText);
});

test('ordinary AI failure remains a technical error', () => {
  const failure = describeAiReplyFailure(new Error('AI API 返回 500'));
  assert.equal(failure.timeout, false);
  assert.equal(failure.decision, 'TECHNICAL_ERROR');
  assert.equal(failure.reason, 'AI API 返回 500');
});

test('AI timeout manual notification states the timeout and required action', () => {
  const failure = describeAiReplyFailure(new Error(clickTimeout));
  const notification = buildManualNotification({
    message: { id: 116, platform_code: 'douyin', message_type: 'PRIVATE_MESSAGE', user_name: '我叫Amy', content: '有什么政策' },
    reason: failure.reason,
    titleSuffix: `｜${failure.notificationTitle}`,
    actionText: failure.notificationAction,
    reasonLabel: failure.notificationReasonLabel
  });
  assert.equal(notification.title, '【抖音·私信】我叫Amy｜AI回复超时');
  assert.match(notification.content, /处理要求：请人工核对并处理/);
  assert.match(notification.content, /超时说明：AI回复超时\n/);
  assert.match(notification.content, /Web消息编号：#116/);
  assert.doesNotMatch(notification.content, misleadingOrTechnicalText);
});

test('manual notification cleans raw and legacy timeout reasons without changing other reasons', () => {
  for (const reason of [clickTimeout, legacyTimeoutReason, 'This operation was aborted', 'AI_TIMEOUT']) {
    assert.equal(humanizeManualReason(reason), 'AI回复超时');
    const notification = buildManualNotification({ message: { id: 117 }, reason });
    assert.match(notification.content, /转人工原因：AI回复超时\n/);
    assert.doesNotMatch(notification.content, misleadingOrTechnicalText);
  }
  assert.equal(humanizeManualReason('平台页面提交失败'), '平台页面提交失败');
  assert.equal(humanizeManualReason('TARGET_NOT_UNIQUE'), '平台页面中存在多个相似目标，无法确保回复到正确消息');
});

test('message details hide stale timeout diagnostics while preserving the generated reply', () => {
  // Keep app initialization pending at its HTTP boundary; execute the actual render functions.
  const app = vm.createContext({ fetch: () => new Promise(() => {}) });
  vm.runInContext(fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8'), app);
  for (const reason of [clickTimeout, legacyTimeoutReason, 'AI回复超时']) {
    const html = app.messageDecisionDetail({
      decision: 'AI_REPLY_TIMEOUT', reason, reply_text: '已经生成的回复', wecom_notification_status: 'SENT'
    });
    assert.match(html, /<b>AI回复超时<\/b>/);
    assert.match(html, /原因：AI回复超时<\/span>/);
    assert.match(html, /AI回复内容：已经生成的回复/);
    assert.match(html, /已通知人工/);
    assert.doesNotMatch(html, misleadingOrTechnicalText);
  }
  const ordinaryHtml = app.messageDecisionDetail({ decision: 'TECHNICAL_ERROR', reason: '平台页面提交失败' });
  assert.match(ordinaryHtml, /原因：平台页面提交失败/);
  assert.doesNotMatch(ordinaryHtml, /ai-timeout-alert/);
});

test('message API and new reply failures show concise timeouts and retain job and issue diagnostics', async t => {
  const runtime = await startServer({ env: { WECOM_WEBHOOK_URL: '' } });
  const db = new DatabaseSync(runtime.dbPath);
  db.exec('PRAGMA busy_timeout=15000');
  t.after(async () => { db.close(); await stopChild(runtime.child); cleanupDir(runtime.dir); });
  const account = db.prepare("SELECT * FROM accounts WHERE platform_code='douyin' ORDER BY id LIMIT 1").get();
  const stamp = new Date().toISOString();
  const insertMessage = (suffix, decision, reason, status = 'MANUAL_REQUIRED') => Number(db.prepare(`INSERT INTO messages(
      platform_code,account_id,message_type,external_id,user_name,content,status,decision,reason,reply_text,context_json,created_at,updated_at
    ) VALUES('douyin',?,'PRIVATE_MESSAGE',?,'测试用户','有什么政策',?,?,?,'已经生成的回复','{}',?,?)`)
    .run(account.id, `timeout-notice-${suffix}`, status, decision, reason, stamp, stamp).lastInsertRowid);
  const legacyIds = [
    insertMessage('legacy-click', 'TECHNICAL_ERROR', clickTimeout),
    insertMessage('legacy-model', 'AI_REPLY_TIMEOUT', legacyTimeoutReason)
  ];
  const ordinaryId = insertMessage('ordinary', 'TECHNICAL_ERROR', '平台页面提交失败');

  const listed = await jsonRequest(runtime.base, '/api/messages');
  assert.equal(listed.response.status, 200);
  for (const id of legacyIds) {
    const message = listed.data.messages.find(item => item.id === id);
    assert.equal(message.decision, 'AI_REPLY_TIMEOUT');
    assert.equal(message.reason, 'AI回复超时');
    assert.equal(message.reply_text, '已经生成的回复');
  }
  const ordinary = listed.data.messages.find(item => item.id === ordinaryId);
  assert.equal(ordinary.decision, 'TECHNICAL_ERROR');
  assert.equal(ordinary.reason, '平台页面提交失败');
  assert.equal(db.prepare('SELECT reason FROM messages WHERE id=?').get(legacyIds[0]).reason, clickTimeout);

  const messageId = insertMessage('new-click', 'AUTO_REPLY', null, 'REPLY_RUNNING');
  const payload = { messageId, platformCode: 'douyin', accountId: account.id, messageType: 'PRIVATE_MESSAGE', replyText: '已经生成的回复' };
  const jobId = Number(db.prepare(`INSERT INTO agent_jobs(device_id,job_type,payload,status,attempts,created_at,claimed_at)
    VALUES(?,'REPLY',?,'RUNNING',1,?,?)`).run(account.device_id, JSON.stringify(payload), stamp, stamp).lastInsertRowid);
  db.prepare('UPDATE messages SET reply_job_id=? WHERE id=?').run(jobId, messageId);
  const completed = await jsonRequest(runtime.base, `/api/agent/jobs/${jobId}/complete`, {
    method: 'POST', body: { status: 'FAILED', result: { message: clickTimeout, sendAttempted: false } }
  });
  assert.equal(completed.response.status, 200);
  const message = db.prepare('SELECT status,reason,reply_text,reply_job_id FROM messages WHERE id=?').get(messageId);
  assert.equal(message.status, 'MANUAL_REQUIRED');
  assert.equal(message.reason, 'AI回复超时');
  assert.equal(message.reply_text, '已经生成的回复');
  assert.equal(message.reply_job_id, jobId);
  assert.equal(JSON.parse(db.prepare('SELECT result FROM agent_jobs WHERE id=?').get(jobId).result).message, clickTimeout);
  assert.equal(db.prepare("SELECT detail FROM issues WHERE source='RPA' AND category='REPLY' AND related_id=? ORDER BY id DESC LIMIT 1").get(String(messageId)).detail, clickTimeout);
  const notification = db.prepare('SELECT title,content,idempotency_key FROM notifications WHERE message_id=? ORDER BY id DESC LIMIT 1').get(messageId);
  assert.ok(notification);
  assert.match(notification.title, /AI回复超时$/);
  assert.match(notification.content, /超时说明：AI回复超时\n/);
  assert.doesNotMatch(notification.content, misleadingOrTechnicalText);
  assert.equal(notification.idempotency_key, `wecom:TECHNICAL_MANUAL:message:${messageId}`);
});
