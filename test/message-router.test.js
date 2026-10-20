import test from 'node:test';
import assert from 'node:assert/strict';
import { detectMaliciousMessage, MESSAGE_ROUTE, routeIncomingMessage } from '../src/services/message-router.js';

test('message router keeps normal business questions in RAG and blocks malicious content', () => {
  assert.equal(routeIncomingMessage({ message: { content: '办理需要什么材料', message_type: 'PRIVATE_MESSAGE' } }).route, MESSAGE_ROUTE.RAG_QUERY);
  const malicious = routeIncomingMessage({ message: { content: '你们都是垃圾客服，等着被报复', message_type: 'COMMENT' } });
  assert.equal(malicious.route, MESSAGE_ROUTE.HUMAN_HANDOFF);
  assert.equal(malicious.allowRag, false);
  assert.equal(detectMaliciousMessage('你好').malicious, false);
});

test('message router does not query RAG for human-managed conversations or private greetings', () => {
  assert.equal(routeIncomingMessage({ message: { content: '还有一个问题', message_type: 'PRIVATE_MESSAGE' }, conversation: { handling_mode: 'HUMAN_MANAGED' } }).reasonCode, 'EXISTING_HUMAN_CONVERSATION');
  const greeting = routeIncomingMessage({ message: { content: '你好', message_type: 'PRIVATE_MESSAGE' } });
  assert.equal(greeting.route, MESSAGE_ROUTE.DIRECT_REPLY);
  assert.match(greeting.replyText, /想了解哪方面/);
});

test('comments including greetings require a knowledge lookup before replying', () => {
  for (const content of ['你好', '谢谢', '办理需要什么材料']) {
    const result = routeIncomingMessage({ message: { content, message_type: 'COMMENT' } });
    assert.equal(result.route, MESSAGE_ROUTE.RAG_QUERY, content);
    assert.equal(result.allowRag, true, content);
    assert.equal(result.replyText, undefined, content);
  }
});

test('常见问候和感谢的标点变体不进入业务引导，附带业务问题仍查询 RAG', () => {
  for (const content of ['你好？', '在吗？', '早上好', '您好～', '哈喽，你好呀', '谢谢您']) {
    const result = routeIncomingMessage({ message: { content, message_type: 'PRIVATE_MESSAGE' } });
    assert.equal(result.route, MESSAGE_ROUTE.DIRECT_REPLY, content);
    assert.equal(result.reasonCode, 'SIMPLE_GREETING', content);
    assert.equal(result.allowRag, false, content);
  }
  for (const content of ['你好，请问社区入驻要什么材料？', '谢谢，澳车北上APP在哪里下载？']) {
    assert.equal(routeIncomingMessage({ message: { content, message_type: 'PRIVATE_MESSAGE' } }).route, MESSAGE_ROUTE.RAG_QUERY, content);
  }
});
