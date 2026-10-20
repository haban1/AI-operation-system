import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFormalRagRequest } from '../src/services/formal-rag-routing.js';

const current = {
  id: 10, platform_code: 'douyin', account_id: 1, message_type: 'PRIVATE_MESSAGE',
  content: '那需要什么材料？', conversation_key_snapshot: 'private:customer-a', conversation_version: 10
};

test('已发送的私信历史同时保留用户问题和对应回复，当前问题只放在 query', () => {
  const request = buildFormalRagRequest({ message: current, recentMessages: [
    { id: 9, content: '我想入驻港澳服务社区', reply_text: '可以了解入驻条件和流程。', status: 'AUTO_REPLIED', created_at: '2026-09-09T00:00:00Z', handled_at: '2026-09-09T00:01:00Z' },
    current
  ] });
  assert.deepEqual(request.context, [
    { messageId: '9', role: 'USER', text: '我想入驻港澳服务社区', sentAt: '2026-09-09T00:00:00.000Z' },
    { messageId: '9:reply', role: 'ASSISTANT', text: '可以了解入驻条件和流程。', sentAt: '2026-09-09T00:01:00.000Z' }
  ]);
  assert.equal(request.query.text, '那需要什么材料？');
  assert.deepEqual(request.query.messageIds, ['9', '10']);
});

test('排队、失败、取消和仅标记人工处理的回复不冒充已发送的历史', () => {
  for (const status of ['REPLY_QUEUED', 'REPLY_RUNNING', 'MANUAL_REQUIRED', 'SUPERSEDED', 'MANUAL_HANDLED', 'CLOSED']) {
    const request = buildFormalRagRequest({ message: current, recentMessages: [
      { id: 9, content: '我想入驻', reply_text: '未确认发送的草稿', status }
    ] });
    assert.deepEqual(request.context.map(({ role, text }) => ({ role, text })), [{ role: 'USER', text: '我想入驻' }], status);
  }
});

test('历史窗口最多保留最近三轮完整问答，当前问题独立于三轮历史', () => {
  const recentMessages = Array.from({ length: 8 }, (_, index) => ({
    id: index + 1, content: `第${index + 1}轮问题`, reply_text: `第${index + 1}轮回复`, status: 'AUTO_REPLIED'
  }));
  const request = buildFormalRagRequest({ message: current, recentMessages });
  assert.equal(request.context.length, 6);
  assert.equal(request.context[0].text, '第6轮问题');
  assert.equal(request.context.at(-1).text, '第8轮回复');
  assert.deepEqual(request.query.messageIds, ['6', '7', '8', '10']);
});

test('未发送回复的用户提问同样按三轮限制，不把六条用户消息当作三轮', () => {
  const recentMessages = Array.from({ length: 5 }, (_, index) => ({
    id: index + 1, content: `提问${index + 1}`, reply_text: '尚未发送', status: 'REPLY_QUEUED'
  }));
  const request = buildFormalRagRequest({ message: current, recentMessages });
  assert.deepEqual(request.context.map(item => [item.role, item.text]), [
    ['USER', '提问3'], ['USER', '提问4'], ['USER', '提问5']
  ]);
});

test('超长历史按整轮缩减到合同预算，保留最近问题及其回答', () => {
  const recentMessages = Array.from({ length: 6 }, (_, index) => ({
    id: index + 1, content: `问题${index}` + '问'.repeat(3997), reply_text: `回答${index}` + '答'.repeat(3997), status: 'AUTO_REPLIED'
  }));
  const request = buildFormalRagRequest({ message: current, recentMessages });
  assert.ok(request.context.reduce((sum, item) => sum + [...item.text].length, 0) <= 12000);
  assert.equal(request.context[0].role, 'USER');
  assert.equal(request.context.at(-2).text, recentMessages[5].content);
  assert.equal(request.context.at(-1).text, recentMessages[5].reply_text);
});

test('字符串消息 ID 去重且重新处理当前消息时不把旧草稿送入上下文', () => {
  const message = { ...current, id: 'chat-message-new', reply_text: '已作废的当前草稿' };
  const prior = { id: 'chat-message-old', content: '上一轮问题', reply_text: '上一轮回复', status: 'AUTO_REPLIED' };
  const request = buildFormalRagRequest({ message, recentMessages: [prior, prior, message] });
  assert.deepEqual(request.context.map(item => item.text), ['上一轮问题', '上一轮回复']);
  assert.deepEqual(request.query.messageIds, ['chat-message-old', 'chat-message-new']);
});
