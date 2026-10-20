import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'notification-outbox-'));
const databasePath = path.join(tempDir, 'outbox.db');

// 模拟旧版本数据库：WAITING 可能来自未配置 Webhook 的模拟成功，迁移时不能直接视为已送达。
{
  const legacy = new DatabaseSync(databasePath);
  legacy.exec(`CREATE TABLE conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    namespace TEXT NOT NULL UNIQUE,
    platform_code TEXT NOT NULL,
    account_id INTEGER NOT NULL,
    message_type TEXT NOT NULL,
    external_conversation_key TEXT,
    user_name TEXT,
    identity_confidence TEXT NOT NULL DEFAULT 'LOW',
    identity_source TEXT,
    entry_type TEXT,
    context_enabled INTEGER NOT NULL DEFAULT 0,
    version INTEGER NOT NULL DEFAULT 0,
    last_incoming_message_id INTEGER,
    last_message_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    human_followup_state TEXT NOT NULL DEFAULT 'NONE'
  );`);
  const stamp = new Date().toISOString();
  legacy.prepare(`INSERT INTO conversations(namespace,platform_code,account_id,message_type,external_conversation_key,user_name,
    created_at,updated_at,human_followup_state) VALUES(?,?,?,?,?,?,?,?,?)`)
    .run('legacy:douyin:private:user-1', 'douyin', 1, 'PRIVATE_MESSAGE', 'user-1', '旧用户', stamp, stamp, 'WAITING');
  legacy.close();
}

process.env.DATABASE_PATH = databasePath;
process.env.WECOM_WEBHOOK_URL = '';
process.env.SETTINGS_ENCRYPTION_KEY = '11'.repeat(32);
process.env.INSTANCE_LOCK_ENABLED = 'false';

const { config } = await import('../src/config.js');
const { db, now, row, run } = await import('../src/db.js');
const { beginConversationHandoff, markHumanFollowupMessage } = await import('../src/services/conversation-control.js');
const { deliverNotification, enqueueNotification } = await import('../src/services/notification.js');
const notificationService = await import('../src/services/notification.js');
const { ingestMiniProgramMessage, requestMiniProgramHandoff } = await import('../src/services/mini-program-channel.js');
const { markMiniProgramHandoffConfirmed } = await import('../src/services/mini-program-handoff-state.js');

let conversationId;
let messageId;

test('旧 WAITING 会话保守迁移为 HANDOFF_PENDING', () => {
  const legacy = row("SELECT handling_mode FROM conversations WHERE namespace='legacy:douyin:private:user-1'");
  assert.equal(legacy.handling_mode, 'HANDOFF_PENDING');
});

test('通知 Outbox 幂等、失败保持待转人工、成功回执后才进入人工管理', async () => {
  const account = row("SELECT id FROM accounts WHERE platform_code='douyin' ORDER BY id LIMIT 1");
  assert.ok(account?.id);
  const stamp = now();
  conversationId = Number(run(`INSERT INTO conversations(namespace,platform_code,account_id,message_type,external_conversation_key,user_name,
    identity_confidence,context_enabled,version,last_message_at,created_at,updated_at,handling_mode,human_followup_state)
    VALUES(?,?,?,?,?,?, 'HIGH',1,1,?,?,?,'BOT_ACTIVE','NONE')`,
    'test:douyin:private:user-2', 'douyin', account.id, 'PRIVATE_MESSAGE', 'user-2', '测试用户', stamp, stamp, stamp).lastInsertRowid);
  messageId = Number(run(`INSERT INTO messages(platform_code,account_id,message_type,external_id,user_name,content,status,created_at,updated_at,
    conversation_id,conversation_key_snapshot,wecom_notification_status) VALUES(?,?,?,?,?,?,'NEW',?,?,?,?, 'NOT_REQUIRED')`,
    'douyin', account.id, 'PRIVATE_MESSAGE', 'outbox-message-1', '测试用户', '我要转人工', stamp, stamp, conversationId, 'test:douyin:private:user-2').lastInsertRowid);

  beginConversationHandoff({ conversationId, messageId, reason: '用户明确要求转人工' });
  markHumanFollowupMessage(messageId, { reason: '等待企业微信送达' });

  const first = enqueueNotification({
    type: 'MANUAL_HANDOFF', title: '转人工', content: '请处理用户消息', conversationId, messageId,
    idempotencyKey: `handoff:message:${messageId}`, metadata: { handoff: true, reason: '用户明确要求转人工' }
  });
  const duplicate = enqueueNotification({
    type: 'MANUAL_HANDOFF', title: '转人工', content: '重复请求', conversationId, messageId,
    idempotencyKey: `handoff:message:${messageId}`, metadata: { handoff: true }
  });
  assert.equal(first.created, true);
  assert.equal(duplicate.created, false);
  assert.equal(duplicate.notification.id, first.notification.id);

  const failed = await deliverNotification(first.notification);
  assert.equal(failed.confirmed, false);
  assert.equal(failed.status, 'RETRY_WAIT');
  assert.equal(row('SELECT handling_mode FROM conversations WHERE id=?', conversationId).handling_mode, 'HANDOFF_PENDING');
  assert.equal(row('SELECT wecom_notification_status FROM messages WHERE id=?', messageId).wecom_notification_status, 'PENDING');

  config.wecomWebhookUrl = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abcdefgh12345678';
  const confirmed = await deliverNotification(row('SELECT * FROM notifications WHERE id=?', first.notification.id), {
    fetchImpl: async () => new Response(JSON.stringify({ errcode: 0, errmsg: 'ok' }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  });
  assert.equal(confirmed.confirmed, true);
  assert.equal(row('SELECT status FROM notifications WHERE id=?', first.notification.id).status, 'CONFIRMED');
  assert.equal(row('SELECT handling_mode FROM conversations WHERE id=?', conversationId).handling_mode, 'HUMAN_MANAGED');
  assert.equal(row('SELECT wecom_notification_status FROM messages WHERE id=?', messageId).wecom_notification_status, 'SENT');
});

let miniSequence = 0;
function miniHandoff() {
  config.wecomWebhookUrl = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abcdefgh12345678';
  miniSequence += 1;
  ingestMiniProgramMessage({ appId: 'history-app', conversationId: `history-c-${miniSequence}`, messageId: `history-m-${miniSequence}`, userId: `history-u-${miniSequence}`, text: '转人工', sentAt: now() });
  const message = row('SELECT * FROM messages WHERE external_id=?', `mini-program:history-app:message:history-m-${miniSequence}`);
  const handoff = requestMiniProgramHandoff({ conversationId: message.conversation_id });
  return { message, notification: handoff.notification };
}
function userFor(message) { return row('SELECT * FROM mini_program_users WHERE account_id=? AND external_user_id=?', message.account_id, message.user_name); }
const wecomSuccess = async () => new Response(JSON.stringify({ errcode: 0, errmsg: 'ok' }), { status: 200 });

test('mini history stays pending on WeCom failure and is recorded exactly once after confirmed delivery', async () => {
  const { message, notification } = miniHandoff();
  await deliverNotification(notification, { fetchImpl: async () => { throw new Error('offline'); } });
  assert.equal(userFor(message).first_handoff_at, null);
  assert.equal(userFor(message).last_conversation_id, null);
  assert.equal(userFor(message).handoff_count, 0);
  assert.equal(row('SELECT handling_mode FROM conversations WHERE id=?', message.conversation_id).handling_mode, 'HANDOFF_PENDING');
  const confirmed = await deliverNotification(notification.id, { fetchImpl: wecomSuccess });
  const history = userFor(message);
  assert.equal(history.first_handoff_at, confirmed.confirmed_at);
  assert.equal(history.last_handoff_at, confirmed.confirmed_at);
  assert.equal(history.last_conversation_id, message.conversation_id);
  assert.equal(history.handoff_count, 1);
  await deliverNotification(notification, { fetchImpl: () => assert.fail('stale pending object must not send twice') });
  await deliverNotification(confirmed, { fetchImpl: () => assert.fail('confirmed notification must not resend') });
  requestMiniProgramHandoff({ conversationId: message.conversation_id });
  assert.deepEqual(userFor(message), history);
});

test('history database failure rolls back notification, conversation and message confirmation together', async () => {
  const { message, notification } = miniHandoff();
  db.exec("CREATE TEMP TRIGGER fail_history BEFORE UPDATE OF handoff_count ON mini_program_users BEGIN SELECT RAISE(ABORT,'HISTORY_FAILURE'); END");
  const delivered = await deliverNotification(notification, { fetchImpl: wecomSuccess });
  assert.equal(delivered.confirmed, false);
  assert.equal(row('SELECT status FROM notifications WHERE id=?', notification.id).status, 'RETRY_WAIT');
  assert.equal(row('SELECT handling_mode FROM conversations WHERE id=?', message.conversation_id).handling_mode, 'HANDOFF_PENDING');
  assert.equal(row('SELECT wecom_notification_status FROM messages WHERE id=?', message.id).wecom_notification_status, 'PENDING');
  assert.equal(userFor(message).handoff_count, 0);
  db.exec('DROP TRIGGER fail_history');
  await deliverNotification(notification.id, { fetchImpl: wecomSuccess });
  assert.equal(userFor(message).handoff_count, 1);
});

test('ignored history receipt write rolls back the increment and remains retryable', async () => {
  const { message, notification } = miniHandoff();
  db.exec("CREATE TEMP TRIGGER ignore_history_receipt BEFORE UPDATE OF metadata_json ON notifications BEGIN SELECT RAISE(IGNORE); END");
  const result = await deliverNotification(notification.id, { fetchImpl: wecomSuccess });
  assert.equal(result.confirmed, false);
  assert.equal(userFor(message).handoff_count, 0);
  assert.equal(row('SELECT status FROM notifications WHERE id=?', notification.id).status, 'RETRY_WAIT');
  assert.equal(row('SELECT handling_mode FROM conversations WHERE id=?', message.conversation_id).handling_mode, 'HANDOFF_PENDING');
  db.exec('DROP TRIGGER ignore_history_receipt');
  await deliverNotification(notification.id, { fetchImpl: wecomSuccess });
  assert.equal(userFor(message).handoff_count, 1);
});

test('a second conversation increments history only on confirmation and preserves first handoff time', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-09-06T03:00:00.000Z') });
  const { message, notification } = miniHandoff();
  await deliverNotification(notification.id, { fetchImpl: wecomSuccess });
  const first = userFor(message);
  t.mock.timers.tick(1000);
  ingestMiniProgramMessage({ appId: 'history-app', conversationId: 'second-history', messageId: 'second-history', userId: message.user_name, text: '再次咨询', sentAt: now() });
  const second = row("SELECT * FROM messages WHERE external_id='mini-program:history-app:message:second-history'");
  const secondNotification = row('SELECT * FROM notifications WHERE message_id=?', second.id);
  assert.equal(userFor(message).handoff_count, 1);
  assert.equal(userFor(message).last_conversation_id, message.conversation_id);
  await deliverNotification(secondNotification.id, { fetchImpl: wecomSuccess });
  const history = userFor(message);
  assert.equal(history.handoff_count, 2);
  assert.equal(history.first_handoff_at, first.first_handoff_at);
  assert.equal(history.last_handoff_at, '2026-09-06T03:00:01.000Z');
  assert.equal(history.last_conversation_id, second.conversation_id);
  requestMiniProgramHandoff({ conversationId: message.conversation_id });
  assert.deepEqual(userFor(message), history);
});

for (const corruption of ['missing', 'null', 'string', 'app', 'user', 'account', 'conversation', 'source', 'unverified']) test(`malformed mini metadata cannot confirm the wrong history: ${corruption}`, async () => {
  const { message, notification } = miniHandoff();
  const metadata = JSON.parse(notification.metadata_json);
  if (corruption === 'missing') delete metadata.miniProgram;
  if (corruption === 'null') metadata.miniProgram = null;
  if (corruption === 'string') metadata.miniProgram = 'wrong';
  if (corruption === 'app') metadata.miniProgram.appId = 'wrong';
  if (corruption === 'user') metadata.miniProgram.userId = 'wrong';
  if (corruption === 'account') metadata.miniProgram.accountId = -1;
  if (corruption === 'conversation') metadata.miniProgram.conversationId = 'wrong';
  if (corruption === 'source') run('UPDATE notifications SET message_id=NULL WHERE id=?', notification.id);
  if (corruption === 'unverified') {
    const context = JSON.parse(message.context_json); context.serverSignatureVerified = false;
    run('UPDATE messages SET context_json=? WHERE id=?', JSON.stringify(context), message.id);
  }
  run('UPDATE notifications SET metadata_json=? WHERE id=?', JSON.stringify(metadata), notification.id);
  const result = await deliverNotification(notification.id, { fetchImpl: wecomSuccess });
  assert.equal(result.confirmed, false);
  assert.equal(row('SELECT handling_mode FROM conversations WHERE id=?', message.conversation_id).handling_mode, 'HANDOFF_PENDING');
  assert.equal(userFor(message).handoff_count, 0);
});

for (const outcome of ['success', 'failure']) test(`stale WeCom ${outcome} cannot overwrite a newer delivery or confirm history`, async () => {
  const { message, notification } = miniHandoff();
  const started = Promise.withResolvers(); const release = Promise.withResolvers();
  const pending = deliverNotification(notification.id, { fetchImpl: async () => { started.resolve(); await release.promise; if (outcome === 'failure') throw new Error('late failure'); return wecomSuccess(); } });
  await started.promise;
  run("UPDATE notifications SET attempt_count=attempt_count+1,claimed_at='new-generation',lease_expires_at='2099-01-01' WHERE id=?", notification.id);
  const replacement = row('SELECT * FROM notifications WHERE id=?', notification.id);
  release.resolve(); const result = await pending;
  assert.equal(result.confirmed, false);
  assert.deepEqual(row('SELECT * FROM notifications WHERE id=?', notification.id), replacement);
  assert.equal(userFor(message).handoff_count, 0);
});

test('changed notification status makes zero-row success update a no-op for conversation and history', async () => {
  const { message, notification } = miniHandoff();
  const result = await deliverNotification(notification.id, { fetchImpl: async () => {
    run("UPDATE notifications SET status='FAILED',claimed_at=NULL,lease_expires_at=NULL WHERE id=?", notification.id);
    return wecomSuccess();
  } });
  assert.equal(result.confirmed, false);
  assert.equal(row('SELECT status FROM notifications WHERE id=?', notification.id).status, 'FAILED');
  assert.equal(row('SELECT handling_mode FROM conversations WHERE id=?', message.conversation_id).handling_mode, 'HANDOFF_PENDING');
  assert.equal(userFor(message).handoff_count, 0);
});

for (const status of ['SENT', 'CONFIRMED']) test(`legacy ${status} handoff replay repairs history once from durable confirmation`, () => {
  const { message, notification } = miniHandoff();
  const stamp = '2026-09-05T12:00:00.000Z';
  run('UPDATE notifications SET status=?,sent_at=?,confirmed_at=? WHERE id=?', status, stamp, status === 'CONFIRMED' ? stamp : null, notification.id);
  requestMiniProgramHandoff({ conversationId: message.conversation_id });
  assert.equal(userFor(message).first_handoff_at, stamp);
  assert.equal(userFor(message).handoff_count, 1);
  requestMiniProgramHandoff({ conversationId: message.conversation_id });
  assert.equal(userFor(message).handoff_count, 1);
});

test('manual notification requeue accepts only FAILED/RETRY_WAIT, extends budget and never confirms history', () => {
  const { message, notification } = miniHandoff();
  assert.equal(typeof notificationService.requeueNotification, 'function');
  for (const status of ['PENDING', 'SENDING', 'CONFIRMED', 'SENT', 'CANCELLED']) {
    run('UPDATE notifications SET status=? WHERE id=?', status, notification.id);
    assert.throws(() => notificationService.requeueNotification(notification.id), error => error.statusCode === 409);
  }
  for (const status of ['FAILED', 'RETRY_WAIT']) {
    run("UPDATE notifications SET status=?,attempt_count=23,max_attempts=20,claimed_at='old',lease_expires_at='2099-01-01',available_at='2099-01-01',error_message='old' WHERE id=?", status, notification.id);
    const result = notificationService.requeueNotification(notification.id);
    assert.equal(result.status, 'PENDING'); assert.equal(result.max_attempts, 43);
    assert.equal(result.attempt_count, 23); assert.equal(result.claimed_at, null); assert.equal(result.lease_expires_at, null);
    assert.ok(Date.parse(result.available_at) <= Date.now());
    assert.equal(userFor(message).handoff_count, 0);
  }
  assert.throws(() => notificationService.requeueNotification(-1), error => error.statusCode === 404);
});

test('notification creation strips reserved history receipts supplied by a caller', () => {
  const notification = enqueueNotification({ type: 'TEST', title: 'receipt', content: 'receipt', metadata: {
    origin: 'caller', miniProgramHistoryConfirmedAt: true, miniProgramHistoryReceipt: { notificationId: 123, confirmedAt: now() }
  } }).notification;
  assert.deepEqual(JSON.parse(notification.metadata_json), { origin: 'caller' });
});

for (const forged of [true, 'forged-time', { notificationId: 1, confirmedAt: 'forged-time' }]) test(`forged durable history receipt cannot skip confirmation: ${JSON.stringify(forged)}`, async () => {
  const { message, notification } = miniHandoff();
  const metadata = JSON.parse(notification.metadata_json);
  run('UPDATE notifications SET metadata_json=? WHERE id=?', JSON.stringify({ ...metadata, miniProgramHistoryConfirmedAt: forged, miniProgramHistoryReceipt: forged }), notification.id);
  await deliverNotification(notification.id, { fetchImpl: wecomSuccess });
  assert.equal(userFor(message).handoff_count, 1);
  assert.equal(userFor(message).last_conversation_id, message.conversation_id);
  requestMiniProgramHandoff({ conversationId: message.conversation_id });
  assert.equal(userFor(message).handoff_count, 1);
});

test('reverse chronological legacy reconciliation counts each notification once and preserves newest history', () => {
  const { message, notification } = miniHandoff();
  ingestMiniProgramMessage({ appId: 'history-app', conversationId: 'newest-history', messageId: 'newest-history', userId: message.user_name, text: '再次咨询', sentAt: now() });
  const newerMessage = row("SELECT * FROM messages WHERE external_id='mini-program:history-app:message:newest-history'");
  const newerNotification = requestMiniProgramHandoff({ conversationId: newerMessage.conversation_id }).notification;
  run("UPDATE notifications SET status='CONFIRMED',sent_at=?,confirmed_at=? WHERE id=?", '2026-09-06T12:00:00.000Z', '2026-09-06T12:00:00.000Z', newerNotification.id);
  run("UPDATE notifications SET status='SENT',sent_at=? WHERE id=?", '2026-09-05T12:00:00.000Z', notification.id);
  requestMiniProgramHandoff({ conversationId: newerMessage.conversation_id });
  const newest = userFor(message);
  requestMiniProgramHandoff({ conversationId: message.conversation_id });
  const history = userFor(message);
  assert.equal(history.handoff_count, 2);
  assert.equal(history.last_handoff_at, newest.last_handoff_at);
  assert.equal(history.last_conversation_id, newerMessage.conversation_id);
  assert.equal(history.first_handoff_at, newest.first_handoff_at);
  requestMiniProgramHandoff({ conversationId: message.conversation_id });
  requestMiniProgramHandoff({ conversationId: newerMessage.conversation_id });
  assert.deepEqual(userFor(message), history);
});

function timestampOnlyReceipt(notificationId, marker) {
  const notification = row('SELECT * FROM notifications WHERE id=?', notificationId);
  const metadata = JSON.parse(notification.metadata_json);
  delete metadata.miniProgramHistoryReceipt;
  metadata.miniProgramHistoryConfirmedAt = marker ?? notification.confirmed_at ?? notification.sent_at;
  run('UPDATE notifications SET metadata_json=? WHERE id=?', JSON.stringify(metadata), notificationId);
}

function confirmHistoryDirect(message, notificationId) {
  const notification = row('SELECT * FROM notifications WHERE id=?', notificationId);
  return markMiniProgramHandoffConfirmed({
    ...JSON.parse(notification.metadata_json).miniProgram,
    conversationId: message.conversation_id, notificationId,
    confirmedAt: notification.confirmed_at || notification.sent_at
  });
}

for (const status of ['SENT', 'CONFIRMED']) test(`valid timestamp-only ${status} receipt upgrades without incrementing history`, async () => {
  const { message, notification } = miniHandoff();
  await deliverNotification(notification.id, { fetchImpl: wecomSuccess });
  if (status === 'SENT') run("UPDATE notifications SET status='SENT',confirmed_at=NULL WHERE id=?", notification.id);
  timestampOnlyReceipt(notification.id);
  const before = userFor(message);
  confirmHistoryDirect(message, notification.id);
  assert.deepEqual(userFor(message), before);
  const receipt = JSON.parse(row('SELECT metadata_json FROM notifications WHERE id=?', notification.id).metadata_json).miniProgramHistoryReceipt;
  assert.equal(receipt.notificationId, notification.id);
  assert.equal(receipt.handoffCount, before.handoff_count);
  requestMiniProgramHandoff({ conversationId: message.conversation_id });
  assert.deepEqual(userFor(message), before);
});

for (const mismatch of ['boolean', 'forged timestamp', 'missing history', 'first timestamp', 'last timestamp', 'last conversation', 'confirmation identity', 'newer unrelated user']) test(`timestamp-only receipt repairs rather than trusts ${mismatch}`, async t => {
  if (mismatch === 'newer unrelated user') t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-09-06T13:00:00.000Z') });
  const { message, notification } = miniHandoff();
  await deliverNotification(notification.id, { fetchImpl: wecomSuccess });
  timestampOnlyReceipt(notification.id, mismatch === 'boolean' ? true : mismatch === 'forged timestamp' ? '2000-01-01T00:00:00.000Z' : undefined);
  const original = userFor(message);
  if (mismatch === 'missing history') run('UPDATE mini_program_users SET handoff_count=0,first_handoff_at=NULL,last_handoff_at=NULL,last_conversation_id=NULL WHERE id=?', original.id);
  if (mismatch === 'first timestamp') run("UPDATE mini_program_users SET first_handoff_at='2099-01-01T00:00:00.000Z' WHERE id=?", original.id);
  if (mismatch === 'last timestamp') run("UPDATE mini_program_users SET last_handoff_at='2000-01-01T00:00:00.000Z' WHERE id=?", original.id);
  if (mismatch === 'last conversation') run('UPDATE mini_program_users SET last_conversation_id=NULL WHERE id=?', original.id);
  if (mismatch === 'confirmation identity') run('UPDATE conversations SET handoff_notification_id=NULL WHERE id=?', message.conversation_id);
  if (mismatch === 'newer unrelated user') {
    t.mock.timers.tick(1000);
    const other = miniHandoff();
    await deliverNotification(other.notification.id, { fetchImpl: wecomSuccess });
    run('UPDATE mini_program_users SET handoff_count=2,last_handoff_at=?,last_conversation_id=? WHERE id=?', userFor(other.message).last_handoff_at, other.message.conversation_id, original.id);
  }
  const before = userFor(message);
  confirmHistoryDirect(message, notification.id);
  const repaired = userFor(message);
  assert.equal(repaired.handoff_count, before.handoff_count + 1);
  const receipt = JSON.parse(row('SELECT metadata_json FROM notifications WHERE id=?', notification.id).metadata_json).miniProgramHistoryReceipt;
  assert.equal(receipt.handoffCount, repaired.handoff_count);
  confirmHistoryDirect(message, notification.id);
  assert.equal(userFor(message).handoff_count, repaired.handoff_count);
});

test('timestamp-only old receipt upgrades without changing newer successful history', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-09-06T14:00:00.000Z') });
  const { message, notification } = miniHandoff();
  await deliverNotification(notification.id, { fetchImpl: wecomSuccess });
  timestampOnlyReceipt(notification.id);
  t.mock.timers.tick(1000);
  ingestMiniProgramMessage({ appId: 'history-app', conversationId: 'legacy-receipt-newer', messageId: 'legacy-receipt-newer', userId: message.user_name, text: '再次咨询', sentAt: now() });
  const newer = row("SELECT * FROM messages WHERE external_id='mini-program:history-app:message:legacy-receipt-newer'");
  const newerNotification = row('SELECT * FROM notifications WHERE message_id=?', newer.id);
  await deliverNotification(newerNotification.id, { fetchImpl: wecomSuccess });
  const before = userFor(message);
  confirmHistoryDirect(message, notification.id);
  assert.deepEqual(userFor(message), before);
  requestMiniProgramHandoff({ conversationId: message.conversation_id });
  assert.deepEqual(userFor(message), before);
  assert.equal(userFor(message).last_conversation_id, newer.conversation_id);
});

for (const mismatch of [null, 'timestamp', 'appId', 'accountId', 'userId']) test(`tied confirmation legacy receipt ${mismatch ? `rejects mismatched ${mismatch}` : 'upgrades once without changing latest history'}`, async t => {
  const stamp = '2026-09-06T15:00:00.000Z';
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(stamp) });
  const { message, notification } = miniHandoff();
  await deliverNotification(notification.id, { fetchImpl: wecomSuccess });
  timestampOnlyReceipt(notification.id, mismatch === 'timestamp' ? '2026-09-06T14:59:59.999Z' : undefined);
  const externalId = `tied-receipt-${miniSequence}`;
  ingestMiniProgramMessage({ appId: 'history-app', conversationId: externalId, messageId: externalId, userId: message.user_name, text: '再次咨询', sentAt: now() });
  const latest = row('SELECT * FROM messages WHERE external_id=?', `mini-program:history-app:message:${externalId}`);
  const latestNotification = row('SELECT * FROM notifications WHERE message_id=?', latest.id);
  await deliverNotification(latestNotification.id, { fetchImpl: wecomSuccess });
  const before = userFor(message);
  assert.equal(before.handoff_count, 2);
  assert.equal(before.first_handoff_at, stamp);
  assert.equal(before.last_handoff_at, stamp);
  assert.equal(before.last_conversation_id, latest.conversation_id);
  if (['appId', 'accountId', 'userId'].includes(mismatch)) {
    const metadata = JSON.parse(row('SELECT metadata_json FROM notifications WHERE id=?', latestNotification.id).metadata_json);
    metadata.miniProgram[mismatch] = mismatch === 'accountId' ? -1 : 'unrelated-identity';
    run('UPDATE notifications SET metadata_json=? WHERE id=?', JSON.stringify(metadata), latestNotification.id);
  }
  confirmHistoryDirect(message, notification.id);
  if (mismatch) assert.equal(userFor(message).handoff_count, 3, 'invalid legacy evidence must not skip confirmation');
  else assert.deepEqual(userFor(message), before, 'equal confirmation times must not replace the later recorded conversation');
  const upgradedMetadata = row('SELECT metadata_json FROM notifications WHERE id=?', notification.id).metadata_json;
  assert.equal(JSON.parse(upgradedMetadata).miniProgramHistoryReceipt.handoffCount, mismatch ? 3 : 2);
  const afterUpgrade = userFor(message);
  confirmHistoryDirect(message, notification.id);
  requestMiniProgramHandoff({ conversationId: message.conversation_id });
  assert.deepEqual(userFor(message), afterUpgrade);
  assert.equal(row('SELECT metadata_json FROM notifications WHERE id=?', notification.id).metadata_json, upgradedMetadata);
});

test.after(() => {
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});
