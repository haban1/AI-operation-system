import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRecoveryGroups, recoveryTargets } from '../src/services/conversation-recovery-scheduler.js';

const now = Date.parse('2026-08-27T10:00:00.000Z');
function conversation(id, overrides = {}) { return { id, namespace: `n${id}`, platform_code: 'douyin', account_id: 1, message_type: 'PRIVATE_MESSAGE', handling_mode: 'BOT_ACTIVE', human_followup_state: 'NONE', last_message_at: '2026-08-27T09:00:00.000Z', last_recovery_scan_at: null, external_conversation_key: `platform-${id}`, ...overrides }; }

test('recovery scheduler groups at most two stable targeted bot conversations', () => {
  const groups = buildRecoveryGroups([conversation(1), conversation(2), conversation(3), conversation(4, { handling_mode: 'HUMAN_MANAGED' }), conversation(5, { external_conversation_key: null })], now);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].conversations.map(item => item.id), [1, 2]);
  assert.deepEqual(recoveryTargets(groups[0].conversations).map(item => item.externalConversationKey), ['platform-1', 'platform-2']);
});
