import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'message-event-ledger-'));
process.env.DATABASE_PATH = path.join(tempDir, 'ledger.db');
process.env.INSTANCE_LOCK_ENABLED = 'false';
process.env.LOCAL_AGENT_AUTO_START = 'false';
process.env.MESSAGE_EVENT_LEDGER_ENABLED = 'false';

const dbModule = await import('../src/db.js');
const store = await import('../src/services/message-event-store.js');
const { db, row, rows } = dbModule;
const account = row("SELECT * FROM accounts WHERE platform_code='douyin' ORDER BY id LIMIT 1");

function event(overrides = {}) {
  return {
    externalId: 'douyin-private-message-001',
    conversationId: 'conversation-user-001',
    platformUserId: 'user-001',
    userName: '测试用户',
    content: '你好，请问服务时间？',
    occurredAt: '2026-08-24T10:00:00.000Z',
    direction: 'INBOUND',
    ...overrides
  };
}

test('消息事件账本按平台消息 ID 幂等，并且完整扫描才推进检查点', () => {
  const first = store.persistMessageEventBatch({
    platformCode: account.platform_code,
    accountId: account.id,
    channelType: 'PRIVATE_MESSAGE',
    events: [event()],
    checkpointValue: 'cursor-001',
    scanStatus: 'SUCCESS'
  });
  assert.equal(first.insertedCount, 1);
  assert.equal(first.duplicateCount, 0);
  assert.equal(first.checkpointAdvanced, true);
  assert.equal(first.replyBatchIds.length, 1);

  const second = store.persistMessageEventBatch({
    platformCode: account.platform_code,
    accountId: account.id,
    channelType: 'PRIVATE_MESSAGE',
    events: [event({ collectedAt: '2026-08-24T10:01:00.000Z' })],
    checkpointValue: 'cursor-002',
    scanStatus: 'SUCCESS'
  });
  assert.equal(second.insertedCount, 0);
  assert.equal(second.duplicateCount, 1);
  assert.equal(row('SELECT COUNT(*) AS count FROM message_events').count, 1);
  assert.equal(row('SELECT seen_count FROM message_events').seen_count, 2);
  assert.equal(row('SELECT COUNT(*) AS count FROM reply_batches').count, 1);
  assert.equal(store.channelCheckpoint(account.platform_code, account.id, 'PRIVATE_MESSAGE').cursor_value, 'cursor-002');
});

test('同一会话连续入站消息合并为一个批次，并使生成中的旧答案失效', () => {
  const batch = row("SELECT * FROM reply_batches WHERE channel_type='PRIVATE_MESSAGE' ORDER BY id LIMIT 1");
  db.prepare("UPDATE reply_batches SET status='GENERATING' WHERE id=?").run(batch.id);
  const result = store.persistMessageEventBatch({
    platformCode: account.platform_code,
    accountId: account.id,
    channelType: 'PRIVATE_MESSAGE',
    events: [event({ externalId: 'douyin-private-message-002', content: '另外，周末营业吗？', occurredAt: '2026-08-24T10:02:00.000Z' })],
    checkpointValue: 'cursor-003'
  });
  assert.equal(result.insertedCount, 1);
  assert.deepEqual(result.replyBatchIds, [Number(batch.id)]);
  const updated = row('SELECT * FROM reply_batches WHERE id=?', batch.id);
  assert.equal(updated.status, 'PENDING');
  assert.equal(updated.invalidation_reason, 'NEW_INBOUND_EVENT');
  assert.deepEqual(JSON.parse(updated.source_event_ids_json).length, 2);
  const conversation = row('SELECT * FROM conversations WHERE id=?', updated.conversation_id);
  assert.equal(conversation.ledger_version, 2);
});

test('出站消息和低置信度指纹事件会入账，但不会生成自动回复批次', () => {
  const before = row('SELECT COUNT(*) AS count FROM reply_batches').count;
  const outgoing = store.persistMessageEventBatch({
    platformCode: account.platform_code,
    accountId: account.id,
    channelType: 'PRIVATE_MESSAGE',
    events: [event({ externalId: 'douyin-private-outgoing-001', direction: 'OUTBOUND', content: '您好，工作时间为……' })]
  });
  assert.equal(outgoing.insertedEvents[0].replyDisposition, 'OUTGOING');

  const low = store.persistMessageEventBatch({
    platformCode: account.platform_code,
    accountId: account.id,
    channelType: 'PRIVATE_MESSAGE',
    events: [{ userName: '同名用户', content: '重复内容', occurredAt: '2026-08-24T10:03:00.000Z' }]
  });
  assert.equal(low.insertedEvents[0].usedFingerprint, true);
  assert.equal(low.insertedEvents[0].replyDisposition, 'MANUAL_REVIEW');
  assert.equal(row('SELECT COUNT(*) AS count FROM reply_batches').count, before);
});

test('失败或不完整扫描不推进检查点，并记录独立通道健康状态', () => {
  const before = store.channelCheckpoint(account.platform_code, account.id, 'COMMENT');
  assert.equal(before, undefined);
  const result = store.persistMessageEventBatch({
    platformCode: account.platform_code,
    accountId: account.id,
    channelType: 'COMMENT',
    events: [],
    checkpointValue: 'must-not-save',
    scanStatus: 'PARTIAL',
    errorCode: 'PAGE_TIMEOUT',
    errorMessage: '评论页暂不可用'
  });
  assert.equal(result.checkpointAdvanced, false);
  assert.equal(store.channelCheckpoint(account.platform_code, account.id, 'COMMENT'), undefined);
  const state = store.channelRuntimeState(account.platform_code, account.id, 'COMMENT');
  assert.equal(state.state, 'DEGRADED');
  assert.equal(state.consecutive_failures, 1);
});

test('事件持久化失败时事件、批次和检查点整体回滚', () => {
  const eventsBefore = row('SELECT COUNT(*) AS count FROM message_events').count;
  const batchesBefore = row('SELECT COUNT(*) AS count FROM reply_batches').count;
  assert.throws(() => store.persistMessageEventBatch({
    platformCode: account.platform_code,
    accountId: 999999,
    channelType: 'PRIVATE_MESSAGE',
    events: [event({ externalId: 'invalid-account-event' })],
    checkpointValue: 'must-rollback'
  }), /FOREIGN KEY|constraint/i);
  assert.equal(row('SELECT COUNT(*) AS count FROM message_events').count, eventsBefore);
  assert.equal(row('SELECT COUNT(*) AS count FROM reply_batches').count, batchesBefore);
  assert.equal(rows("SELECT * FROM collection_checkpoints WHERE account_id=999999").length, 0);
});

test.after(() => {
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});
