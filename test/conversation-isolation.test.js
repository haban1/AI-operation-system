import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveConversationIdentity } from '../src/services/conversation-identity.js';
import { analyzeContextNeed } from '../src/services/reply-engine.js';
import { filterConversationContextWindow } from '../src/services/conversation-store.js';

test('稳定会话ID隔离不同用户，同一用户保持同一命名空间', () => {
  const base = { platform_code: 'douyin', account_id: 1, message_type: 'PRIVATE_MESSAGE', user_name: '同名用户' };
  const first = resolveConversationIdentity({ ...base, external_id: 'm1', context_json: JSON.stringify({ conversationId: 'conversation-a' }) });
  const repeated = resolveConversationIdentity({ ...base, external_id: 'm2', context_json: JSON.stringify({ conversationId: 'conversation-a' }) });
  const another = resolveConversationIdentity({ ...base, external_id: 'm3', context_json: JSON.stringify({ conversationId: 'conversation-b' }) });
  assert.equal(first.confidence, 'HIGH');
  assert.equal(first.contextEnabled, true);
  assert.equal(first.namespace, repeated.namespace);
  assert.notEqual(first.namespace, another.namespace);
});

test('只有昵称时不建立长期上下文，同名消息不会被合并', () => {
  const base = { platform_code: 'wechat_channels', account_id: 2, message_type: 'PRIVATE_MESSAGE', user_name: '张先生', context_json: '{}' };
  const first = resolveConversationIdentity({ ...base, external_id: 'video-message-1' });
  const second = resolveConversationIdentity({ ...base, external_id: 'video-message-2' });
  assert.equal(first.confidence, 'LOW');
  assert.equal(first.contextEnabled, false);
  assert.notEqual(first.namespace, second.namespace);
});

test('上下文只补全省略追问，完整问题和话题切换不受旧话题干扰', () => {
  const history = [{ id: 1, content: '参加志愿者活动需要带什么材料？', knowledge_question_snapshot: '参加志愿者活动需要携带什么材料？' }];
  const followup = analyzeContextNeed('那需要什么？', history);
  assert.equal(followup.elliptical, true);
  assert.equal(followup.anchor.sourceMessageId, 1);

  const explicit = analyzeContextNeed('支付宝怎么绑定银行卡？', history);
  assert.equal(explicit.elliptical, false);

  const switched = analyzeContextNeed('另外问一下，支付宝怎么绑定银行卡？', history);
  assert.equal(switched.topicSwitched, true);
  assert.equal(switched.anchor, null);
});


test('私信上下文不因消息时间差超过2小时而截断', () => {
  const current = { message_type: 'PRIVATE_MESSAGE', created_at: '2026-08-24T05:30:00.000Z' };
  const history = [
    { id: 1, content: '旧主题', created_at: '2026-08-24T01:00:00.000Z' },
    { id: 2, content: '当前会话起点', created_at: '2026-08-24T04:00:00.000Z' },
    { id: 3, content: '当前会话追问', created_at: '2026-08-24T05:00:00.000Z' }
  ];
  const result = filterConversationContextWindow(current, history);
  assert.deepEqual(result.map(item => item.id), [1, 2, 3]);
});

test('私信与上一条消息间隔很久仍保留旧上下文', () => {
  const current = { message_type: 'PRIVATE_MESSAGE', created_at: '2026-08-24T06:00:00.001Z' };
  const history = [{ id: 1, content: '旧消息', created_at: '2026-08-24T04:00:00.000Z' }];
  assert.deepEqual(filterConversationContextWindow(current, history).map(item => item.id), [1]);
});

test('评论上下文继续保留历史消息', () => {
  const current = { message_type: 'COMMENT', created_at: '2026-08-24T08:00:00.000Z' };
  const history = [{ id: 1, content: '父评论', created_at: '2026-08-23T08:00:00.000Z' }];
  assert.deepEqual(filterConversationContextWindow(current, history).map(item => item.id), [1]);
});
