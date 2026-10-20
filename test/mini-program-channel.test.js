import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mini-program-channel-'));
process.env.DATABASE_PATH = path.join(dir, 'channel.db');
process.env.INSTANCE_LOCK_ENABLED = 'false';

const { db, immediateTransaction, now, row, run } = await import('../src/db.js');
const {
  MINI_PROGRAM_PLATFORM_CODE,
  ingestMiniProgramMessage,
  miniProgramAccount,
  miniProgramContext,
  requestMiniProgramHandoff
} = await import('../src/services/mini-program-channel.js');

const BASE_PAYLOAD = Object.freeze({
  appId: 'app-1',
  conversationId: 'conversation-1',
  messageId: 'm-1',
  userId: 'user-1',
  text: '请问办理流程是什么？',
  sentAt: '2026-09-05T01:00:00.000Z'
});

function payload(overrides = {}) {
  return { ...BASE_PAYLOAD, ...overrides };
}

function clearChannelRows() {
  db.exec(`
    UPDATE conversations SET handoff_source_message_id=NULL,handoff_notification_id=NULL,last_incoming_message_id=NULL;
    DELETE FROM mini_program_callback_outbox;
    DELETE FROM mini_program_processing_jobs;
    DELETE FROM notifications;
    DELETE FROM mini_program_users;
    DELETE FROM messages;
    DELETE FROM conversations;
    DELETE FROM agent_jobs;
  `);
}

function conversation(namespace) {
  return row('SELECT * FROM conversations WHERE namespace=?', namespace);
}

function storedMessage(messageId) {
  return row('SELECT * FROM messages WHERE external_id=?', `mini-program:app-1:message:${messageId}`);
}

function setConversationMode(namespace, mode) {
  run('UPDATE conversations SET handling_mode=?,human_followup_state=?,updated_at=? WHERE namespace=?',
    mode, mode === 'BOT_ACTIVE' ? 'NONE' : 'WAITING', now(), namespace);
}

test.beforeEach(clearChannelRows);

test('exports the canonical channel account and verified transport context', () => {
  const account = miniProgramAccount();
  assert.equal(MINI_PROGRAM_PLATFORM_CODE, 'mini_program');
  assert.equal(account.platform_code, 'mini_program');
  assert.equal(account.profile_name, 'mini-program-api-main');
  assert.equal(account.enabled, 1);
  assert.equal(account.login_status, 'NOT_REQUIRED');
  assert.deepEqual(miniProgramContext(BASE_PAYLOAD), {
    transport: 'MINI_PROGRAM',
    appId: 'app-1',
    conversationId: 'conversation-1',
    conversationKey: 'mini-program:app-1:conversation-1',
    messageId: 'm-1',
    platformMessageId: 'm-1',
    userId: 'user-1',
    sentAt: '2026-09-05T01:00:00.000Z',
    direction: 'incoming',
    sourceVerified: true,
    serverSignatureVerified: true,
    fullSource: true,
    previewOnly: false,
    chatTitleVerified: true,
    candidateCount: 1
  });
});

test('persists a first inbound message and exactly one dedicated processing job', () => {
  const first = ingestMiniProgramMessage(BASE_PAYLOAD);

  assert.deepEqual(first, { accepted: true, messageId: 'm-1', status: 'ACCEPTED', duplicate: false });
  const message = storedMessage('m-1');
  assert.ok(message);
  assert.equal(message.platform_code, 'mini_program');
  assert.equal(message.message_type, 'PRIVATE_MESSAGE');
  assert.equal(message.user_name, 'user-1');
  assert.equal(message.content, BASE_PAYLOAD.text);
  assert.deepEqual(JSON.parse(message.context_json), miniProgramContext(BASE_PAYLOAD));

  const savedConversation = conversation('mini-program:app-1:conversation-1');
  assert.ok(savedConversation);
  assert.equal(savedConversation.external_conversation_key, 'conversation-1');
  assert.equal(savedConversation.user_name, 'user-1');
  assert.equal(savedConversation.identity_confidence, 'HIGH');
  assert.equal(savedConversation.context_enabled, 1);
  assert.equal(savedConversation.handling_mode, 'BOT_ACTIVE');
  assert.equal(savedConversation.version, 1);
  assert.equal(savedConversation.ledger_version, 1);
  assert.equal(savedConversation.last_incoming_message_id, message.id);
  assert.equal(message.conversation_id, savedConversation.id);
  assert.equal(message.conversation_key_snapshot, savedConversation.namespace);
  assert.equal(message.conversation_version, 1);

  assert.equal(row("SELECT COUNT(*) AS count FROM messages WHERE external_id='mini-program:app-1:message:m-1'").count, 1);
  assert.equal(row('SELECT COUNT(*) AS count FROM mini_program_processing_jobs').count, 1);
  assert.equal(row("SELECT COUNT(*) AS count FROM agent_jobs WHERE job_type='REPLY'").count, 0);
  const user = row("SELECT * FROM mini_program_users WHERE app_id='app-1' AND external_user_id='user-1'");
  assert.equal(user.last_conversation_id, null);
  assert.equal(user.first_handoff_at, null);
  assert.equal(user.last_handoff_at, null);
});

test('a duplicate message preserves its original accepted result and creates no second side effect', () => {
  ingestMiniProgramMessage(BASE_PAYLOAD);
  const savedConversation = conversation('mini-program:app-1:conversation-1');
  setConversationMode(savedConversation.namespace, 'HUMAN_MANAGED');
  run("UPDATE messages SET status='MANUAL_REQUIRED',updated_at=? WHERE external_id=?", now(), 'mini-program:app-1:message:m-1');

  const duplicate = ingestMiniProgramMessage(payload({ userId: 'different-user', text: '不同正文' }));

  assert.deepEqual(duplicate, { accepted: true, messageId: 'm-1', status: 'ACCEPTED', duplicate: true });
  assert.equal(row('SELECT COUNT(*) AS count FROM messages').count, 1);
  assert.equal(row('SELECT COUNT(*) AS count FROM conversations').count, 1);
  assert.equal(row('SELECT COUNT(*) AS count FROM mini_program_processing_jobs').count, 1);
  assert.equal(row('SELECT COUNT(*) AS count FROM notifications').count, 0);
  assert.equal(storedMessage('m-1').content, BASE_PAYLOAD.text);
});

test('conversation ownership mismatch wins before every handoff short-circuit', async t => {
  for (const mode of ['BOT_ACTIVE', 'HANDOFF_PENDING', 'HUMAN_MANAGED']) {
    await t.test(mode, () => {
      clearChannelRows();
      ingestMiniProgramMessage(payload({ messageId: `owner-${mode}` }));
      setConversationMode('mini-program:app-1:conversation-1', mode);
      const before = row('SELECT COUNT(*) AS count FROM messages').count;

      assert.throws(
        () => ingestMiniProgramMessage(payload({ messageId: `intruder-${mode}`, userId: 'user-2' })),
        error => {
          assert.equal(error?.statusCode, 409);
          assert.equal(error?.code, 'CONVERSATION_USER_MISMATCH');
          assert.equal(typeof error?.message, 'string');
          assert.ok(error.message.length > 0);
          return true;
        }
      );
      assert.equal(row('SELECT COUNT(*) AS count FROM messages').count, before);
      assert.equal(row("SELECT COUNT(*) AS count FROM mini_program_users WHERE external_user_id='user-2'").count, 0);
    });
  }
});

test('HANDOFF_PENDING stores and versions new text without processing or notification', () => {
  ingestMiniProgramMessage(payload({ messageId: 'pending-1' }));
  const namespace = 'mini-program:app-1:conversation-1';
  setConversationMode(namespace, 'HANDOFF_PENDING');
  run('DELETE FROM mini_program_processing_jobs');

  const result = ingestMiniProgramMessage(payload({ messageId: 'pending-2', text: '还有一个补充' }));

  assert.deepEqual(result, { accepted: true, messageId: 'pending-2', status: 'ACCEPTED', duplicate: false });
  const savedConversation = conversation(namespace);
  const message = storedMessage('pending-2');
  assert.equal(message.content, '还有一个补充');
  assert.equal(savedConversation.version, 2);
  assert.equal(savedConversation.ledger_version, 2);
  assert.equal(savedConversation.last_incoming_message_id, message.id);
  assert.equal(message.conversation_version, 2);
  assert.equal(row('SELECT COUNT(*) AS count FROM mini_program_processing_jobs').count, 0);
  assert.equal(row('SELECT COUNT(*) AS count FROM notifications').count, 0);
  assert.equal(row("SELECT COUNT(*) AS count FROM agent_jobs WHERE job_type='REPLY'").count, 0);
});

test('HUMAN_MANAGED returns the terminal status before storing message text or user state', () => {
  ingestMiniProgramMessage(payload({ messageId: 'managed-1' }));
  const namespace = 'mini-program:app-1:conversation-1';
  setConversationMode(namespace, 'HUMAN_MANAGED');
  run('DELETE FROM mini_program_processing_jobs');
  const beforeMessages = row('SELECT COUNT(*) AS count FROM messages').count;
  const beforeVersion = conversation(namespace).version;

  const result = ingestMiniProgramMessage(payload({ messageId: 'managed-2', text: '这段不应保存' }));

  assert.deepEqual(result, { accepted: true, messageId: 'managed-2', status: 'IGNORED_HANDOFF_COMPLETED', duplicate: false });
  assert.equal(row('SELECT COUNT(*) AS count FROM messages').count, beforeMessages);
  assert.equal(storedMessage('managed-2'), undefined);
  assert.equal(conversation(namespace).version, beforeVersion);
  assert.equal(row('SELECT COUNT(*) AS count FROM mini_program_processing_jobs').count, 0);
  assert.equal(row('SELECT COUNT(*) AS count FROM notifications').count, 0);
});

test('a historical human-managed user starts a pending conversation with one deterministic notification', () => {
  const account = miniProgramAccount();
  const firstHandoffAt = '2026-08-01T02:00:00.000Z';
  const stamp = now();
  run(`INSERT INTO mini_program_users(app_id,account_id,external_user_id,first_handoff_at,last_handoff_at,handoff_count,created_at,updated_at)
    VALUES(?,?,?,?,?,1,?,?)`, 'app-1', account.id, 'historical-user', firstHandoffAt, firstHandoffAt, stamp, stamp);

  const first = ingestMiniProgramMessage(payload({
    conversationId: 'historical-conversation',
    messageId: 'historical-1',
    userId: 'historical-user',
    text: '我又来咨询了'
  }));

  assert.deepEqual(first, { accepted: true, messageId: 'historical-1', status: 'ACCEPTED', duplicate: false });
  const savedConversation = conversation('mini-program:app-1:historical-conversation');
  const message = storedMessage('historical-1');
  assert.equal(savedConversation.handling_mode, 'HANDOFF_PENDING');
  assert.equal(savedConversation.handoff_reason, '历史人工用户再次咨询');
  assert.equal(savedConversation.handoff_source_message_id, message.id);
  assert.equal(message.status, 'MANUAL_REQUIRED');
  assert.equal(message.wecom_notification_status, 'PENDING');
  assert.equal(row('SELECT COUNT(*) AS count FROM messages').count, 1);
  assert.equal(row('SELECT COUNT(*) AS count FROM mini_program_processing_jobs').count, 0);
  assert.equal(row("SELECT COUNT(*) AS count FROM agent_jobs WHERE job_type='REPLY'").count, 0);

  const notification = row('SELECT * FROM notifications');
  assert.ok(notification.content.includes('历史人工用户再次咨询'));
  const receivedAt = notification.content.match(/^收到时间：(.+)$/m)?.[1];
  assert.match(receivedAt, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  assert.equal(
    Date.parse(`${receivedAt.replace(' ', 'T')}+08:00`),
    Math.floor(Date.parse(message.collected_at) / 1000) * 1000
  );
  assert.equal(notification.channel, 'WECOM');
  assert.equal(notification.conversation_id, savedConversation.id);
  assert.equal(notification.message_id, message.id);
  assert.equal(notification.idempotency_key, `wecom:mini-program:handoff:conversation:${savedConversation.id}`);
  assert.deepEqual(JSON.parse(notification.metadata_json), {
    handoff: true,
    reason: '历史人工用户再次咨询',
    miniProgram: {
      appId: 'app-1',
      userId: 'historical-user',
      accountId: account.id,
      conversationId: 'historical-conversation'
    }
  });

  const unchangedHistory = row("SELECT * FROM mini_program_users WHERE external_user_id='historical-user'");
  assert.equal(unchangedHistory.first_handoff_at, firstHandoffAt);
  assert.equal(unchangedHistory.last_handoff_at, firstHandoffAt);
  assert.equal(unchangedHistory.handoff_count, 1);
  assert.equal(unchangedHistory.last_conversation_id, null);

  const repeated = requestMiniProgramHandoff({
    conversationId: savedConversation.id,
    messageId: message.id,
    reason: '后来的重复请求',
    type: 'DIFFERENT_TYPE'
  });
  assert.equal(repeated.created, false);
  assert.equal(repeated.notification.id, notification.id);
  assert.equal(row('SELECT COUNT(*) AS count FROM notifications').count, 1);
  assert.ok(row('SELECT content FROM notifications').content.includes('历史人工用户再次咨询'));
  assert.equal(conversation(savedConversation.namespace).handoff_reason, '历史人工用户再次咨询');
  assert.equal(storedMessage('historical-1').reason, '历史人工用户再次咨询');
});

test('handoff replay repairs a reset conversation and source message from the durable notification', () => {
  ingestMiniProgramMessage(payload({ messageId: 'repair-all-1' }));
  const savedConversation = conversation('mini-program:app-1:conversation-1');
  const message = storedMessage('repair-all-1');
  run('UPDATE messages SET collected_at=NULL,created_at=? WHERE id=?', '2026-09-05T01:02:03.456Z', message.id);

  const first = requestMiniProgramHandoff({
    conversationId: savedConversation.id,
    messageId: message.id,
    reason: '原始转人工原因',
    type: 'MINI_PROGRAM_REPAIR_TEST'
  });
  assert.ok(first.notification.content.includes('收到时间：2026-09-05 09:02:03'));
  const originalNotification = row('SELECT * FROM notifications WHERE id=?', first.notification.id);

  run(`UPDATE conversations SET handling_mode='BOT_ACTIVE',human_followup_state='NONE',handoff_reason=NULL,
    handoff_source_message_id=NULL,handoff_requested_at=NULL,updated_at=? WHERE id=?`, now(), savedConversation.id);
  run(`UPDATE messages SET status='NEW',decision=NULL,reason=NULL,wecom_notification_status='NOT_REQUIRED',
    wecom_notification_id=NULL,updated_at=? WHERE id=?`, now(), message.id);

  const replay = requestMiniProgramHandoff({
    conversationId: savedConversation.id,
    reason: '不应覆盖的重放原因',
    type: 'DIFFERENT_TYPE'
  });

  assert.equal(replay.created, false);
  assert.equal(replay.notification.id, originalNotification.id);
  assert.deepEqual(row('SELECT * FROM notifications WHERE id=?', originalNotification.id), originalNotification);
  const repairedConversation = conversation(savedConversation.namespace);
  assert.equal(repairedConversation.handling_mode, 'HANDOFF_PENDING');
  assert.equal(repairedConversation.handoff_reason, '原始转人工原因');
  assert.equal(repairedConversation.handoff_source_message_id, message.id);
  const repairedMessage = storedMessage('repair-all-1');
  assert.equal(repairedMessage.status, 'MANUAL_REQUIRED');
  assert.equal(repairedMessage.decision, 'HUMAN_FOLLOWUP_NOTIFICATION_PENDING');
  assert.equal(repairedMessage.reason, '原始转人工原因');
  assert.equal(repairedMessage.wecom_notification_status, 'PENDING');
  assert.equal(repairedMessage.wecom_notification_id, originalNotification.id);
  assert.equal(row('SELECT COUNT(*) AS count FROM notifications').count, 1);
});

test('handoff replay repairs only the source message without downgrading a delivered notification', () => {
  for (const notificationStatus of ['SENT', 'CONFIRMED']) {
    clearChannelRows();
    const externalMessageId = `repair-message-${notificationStatus}`;
    ingestMiniProgramMessage(payload({ messageId: externalMessageId }));
    const savedConversation = conversation('mini-program:app-1:conversation-1');
    const message = storedMessage(externalMessageId);
    const first = requestMiniProgramHandoff({
      conversationId: savedConversation.id,
      messageId: message.id,
      reason: '已发送的原始原因'
    });
    const sentAt = '2026-09-05T02:03:04.000Z';
    run('UPDATE notifications SET status=?,sent_at=?,confirmed_at=?,updated_at=? WHERE id=?',
      notificationStatus, sentAt, sentAt, sentAt, first.notification.id);
    run(`UPDATE conversations SET handling_mode='HUMAN_MANAGED',human_followup_state='WAITING',wecom_notified_at=?,
      handoff_confirmed_at=?,handoff_notification_id=?,updated_at=? WHERE id=?`,
    sentAt, sentAt, first.notification.id, sentAt, savedConversation.id);
    const originalNotification = row('SELECT * FROM notifications WHERE id=?', first.notification.id);
    const originalConversation = conversation(savedConversation.namespace);
    run(`UPDATE messages SET status='NEW',decision=NULL,reason=NULL,wecom_notification_status='NOT_REQUIRED',
      wecom_notification_id=NULL,updated_at=? WHERE id=?`, now(), message.id);

    const replay = requestMiniProgramHandoff({
      conversationId: savedConversation.id,
      messageId: message.id + 999,
      reason: '不应覆盖已发送原因'
    });

    assert.equal(replay.created, false);
    const reconciledNotification = row('SELECT * FROM notifications WHERE id=?', originalNotification.id);
    assert.deepEqual({ ...reconciledNotification, metadata_json: originalNotification.metadata_json }, { ...originalNotification });
    assert.deepEqual(JSON.parse(reconciledNotification.metadata_json), {
      ...JSON.parse(originalNotification.metadata_json), miniProgramHistoryConfirmedAt: sentAt,
      miniProgramHistoryReceipt: { notificationId: originalNotification.id, confirmedAt: sentAt, appId: 'app-1', accountId: message.account_id, userId: 'user-1', conversationId: savedConversation.id, handoffCount: 1 }
    });
    const repairedConversation = conversation(savedConversation.namespace);
    assert.deepEqual(repairedConversation, originalConversation);
    const repairedMessage = storedMessage(externalMessageId);
    assert.equal(repairedMessage.status, 'MANUAL_REQUIRED');
    assert.equal(repairedMessage.decision, 'HUMAN_FOLLOWUP_NOTIFIED');
    assert.equal(repairedMessage.reason, '已发送的原始原因');
    assert.equal(repairedMessage.wecom_notification_status, 'SENT');
    assert.equal(repairedMessage.wecom_notification_id, originalNotification.id);
    assert.equal(row('SELECT COUNT(*) AS count FROM notifications').count, 1);
  }
});

test('handoff effects called in an immediate transaction roll back together', () => {
  ingestMiniProgramMessage(payload({ messageId: 'rollback-1' }));
  const savedConversation = conversation('mini-program:app-1:conversation-1');
  const message = storedMessage('rollback-1');

  assert.throws(() => immediateTransaction(() => {
    requestMiniProgramHandoff({
      conversationId: savedConversation.id,
      messageId: message.id,
      reason: '测试回滚',
      type: 'MINI_PROGRAM_TEST_HANDOFF'
    });
    throw new Error('ROLL_BACK_OUTER_TRANSACTION');
  }), /ROLL_BACK_OUTER_TRANSACTION/);

  assert.equal(conversation(savedConversation.namespace).handling_mode, 'BOT_ACTIVE');
  assert.equal(storedMessage('rollback-1').status, 'NEW');
  assert.equal(storedMessage('rollback-1').wecom_notification_status, 'NOT_REQUIRED');
  assert.equal(row('SELECT COUNT(*) AS count FROM notifications').count, 0);
});

test.after(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
