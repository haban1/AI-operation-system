import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RECOVERY_SCAN_BATCH_LIMIT,
  eligibleForRecoveryScan,
  hasIncrementalConversationWork,
  isIncrementalConversationWork,
  limitRecoveryBatch,
  recoveryConversationIds
} from '../src/services/conversation-recovery-policy.js';

const NOW = Date.parse('2026-08-27T08:00:00.000Z');

function conversation(overrides = {}) {
  return {
    id: 1,
    message_type: 'PRIVATE_MESSAGE',
    handling_mode: 'BOT_ACTIVE',
    human_followup_state: 'NONE',
    last_message_at: new Date(NOW - 60 * 60 * 1000).toISOString(),
    last_recovery_scan_at: null,
    ...overrides
  };
}

test('旧会话恢复只处理两天内、间隔满 30 分钟且仍由机器人处理的私信会话', () => {
  assert.equal(eligibleForRecoveryScan(conversation(), NOW).eligible, true);
  assert.equal(eligibleForRecoveryScan(conversation({ last_recovery_scan_at: new Date(NOW - 29 * 60 * 1000).toISOString() }), NOW).reason, 'RECOVERY_SCAN_INTERVAL_NOT_REACHED');
  assert.equal(eligibleForRecoveryScan(conversation({ last_message_at: new Date(NOW - 2 * 24 * 60 * 60 * 1000 - 1).toISOString() }), NOW).reason, 'CONVERSATION_IDLE_OVER_TWO_DAYS');
  assert.equal(eligibleForRecoveryScan(conversation({ handling_mode: 'HANDOFF_PENDING' }), NOW).reason, 'AUTOMATION_DISABLED');
  assert.equal(eligibleForRecoveryScan(conversation({ handling_mode: 'HUMAN_MANAGED' }), NOW).reason, 'AUTOMATION_DISABLED');
  assert.equal(eligibleForRecoveryScan(conversation({ message_type: 'COMMENT' }), NOW).reason, 'NOT_PRIVATE_MESSAGE_CONVERSATION');
});

test('新增私信采集和私信回复会阻止旧会话恢复，评论和发布不会被误判', () => {
  assert.equal(isIncrementalConversationWork('COLLECT_MESSAGES', { channelType: 'PRIVATE_MESSAGE' }), true);
  assert.equal(isIncrementalConversationWork('REPLY', { messageType: 'PRIVATE_MESSAGE' }), true);
  assert.equal(isIncrementalConversationWork('COLLECT_MESSAGES', { recoveryScan: true, channelType: 'PRIVATE_MESSAGE' }), false);
  assert.equal(isIncrementalConversationWork('COLLECT_MESSAGES', { channelType: 'COMMENT' }), false);
  assert.equal(isIncrementalConversationWork('PUBLISH', {}), false);
  assert.equal(hasIncrementalConversationWork([{ status: 'QUEUED', job_type: 'REPLY', payload: { messageType: 'PRIVATE_MESSAGE' } }]), true);
  assert.equal(hasIncrementalConversationWork([{ status: 'SUCCESS', job_type: 'REPLY', payload: { messageType: 'PRIVATE_MESSAGE' } }]), false);
});

test('旧会话恢复批次最多保留两个会话且去重', () => {
  assert.equal(RECOVERY_SCAN_BATCH_LIMIT, 2);
  assert.deepEqual(recoveryConversationIds({ conversationId: 3, conversationIds: [3, 4, 5] }), [3, 4]);
  assert.deepEqual(limitRecoveryBatch([{ id: 1 }, { id: 2 }, { id: 3 }]).map(item => item.id), [1, 2]);
});
