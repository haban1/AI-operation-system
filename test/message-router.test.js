import test from 'node:test';
import assert from 'node:assert/strict';
import { detectMaliciousMessage, MESSAGE_ROUTE, outerRouteReplyResult, routeIncomingMessage } from '../src/services/message-router.js';
import { enforceBusinessGuidanceLimit } from '../src/services/conversation-policy.js';

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
  assert.match(greeting.replyText, /想了解什么/);
});

test('私信按问候、在场询问和感谢分别接话，感谢不重新盘问业务', () => {
  const reply = content => routeIncomingMessage({ message: { content, message_type: 'PRIVATE_MESSAGE' } });
  assert.match(reply('在吗？').replyText, /^在的/);
  const thanks = reply('谢谢您');
  assert.equal(thanks.route, MESSAGE_ROUTE.DIRECT_REPLY);
  assert.match(thanks.replyText, /^不客气/);
  assert.doesNotMatch(thanks.replyText, /[？?]|您好|请问|具体业务|想了解/);
  assert.equal(thanks.allowRag, false);
});

test('纯日常私信直接接话，不因缺少业务知识或多次闲聊转人工', () => {
  for (const content of ['好的', '好', 'OK', '收到', '嗯嗯', '赞', '不错', '再见', '抱歉', '哈哈', '你是谁', '你能做什么', '我有点难过']) {
    const route = routeIncomingMessage({ message: { content, message_type: 'PRIVATE_MESSAGE' } });
    const result = enforceBusinessGuidanceLimit(outerRouteReplyResult(route), { messageType: 'PRIVATE_MESSAGE', maxGuidanceAttempts: 3 });
    assert.equal(route.route, MESSAGE_ROUTE.DIRECT_REPLY, content);
    assert.equal(route.allowRag, false, content);
    assert.ok(route.replyText, content);
    assert.doesNotMatch(route.replyText, /转人工|工作人员|具体业务|活动或办理/, content);
    assert.equal(result.action, 'REPLY', content);
    assert.equal(result.guidanceAttempt, 0, content);
    assert.equal(result.handoffRequested, false, content);
  }
  assert.match(routeIncomingMessage({ message: { content: '你是机器人吗', message_type: 'PRIVATE_MESSAGE' } }).replyText, /智能助手/);
});

test('日常用语不掩盖业务问题、风险或明确转人工，真正接管的会话保持人工优先', () => {
  for (const content of ['好的，课程多少钱？', '赞，你们几点上课', '抱歉，地址在哪', '哈哈，材料怎么准备', '你好，能学AI吗', '谢谢，请问报名方式']) {
    assert.equal(routeIncomingMessage({ message: { content, message_type: 'PRIVATE_MESSAGE' } }).route, MESSAGE_ROUTE.RAG_QUERY, content);
  }
  for (const content of ['好的，请转人工', '我要退款', '哈哈，去死']) {
    assert.equal(routeIncomingMessage({ message: { content, message_type: 'PRIVATE_MESSAGE' } }).route, MESSAGE_ROUTE.HUMAN_HANDOFF, content);
  }
  for (const content of ['你好', '好的', '谢谢', '哈哈']) {
    assert.equal(routeIncomingMessage({ message: { content, message_type: 'PRIVATE_MESSAGE' }, conversation: { handling_mode: 'HUMAN_MANAGED' } }).reasonCode, 'EXISTING_HUMAN_CONVERSATION', content);
  }
});

test('comments including greetings require a knowledge lookup before replying', () => {
  for (const content of ['你好', '谢谢', '办理需要什么材料']) {
    const result = routeIncomingMessage({ message: { content, message_type: 'COMMENT' } });
    assert.equal(result.route, MESSAGE_ROUTE.RAG_QUERY, content);
    assert.equal(result.allowRag, true, content);
    assert.equal(result.replyText, undefined, content);
  }
});

test('评论支持明确转人工，否定、疑问和引用不算转接确认', () => {
  for (const content of ['转人工', '请转人工', '帮我转人工', '轉人工']) {
    const result = routeIncomingMessage({ message: { content, message_type: 'COMMENT' } });
    assert.equal(result.route, MESSAGE_ROUTE.HUMAN_HANDOFF, content);
    assert.equal(result.handoffCommand.matched, true);
  }
  for (const content of ['不用转人工', '转人工是什么意思？', '为什么让我回复“转人工”？', '好的', '需要']) {
    assert.equal(routeIncomingMessage({ message: { content, message_type: 'COMMENT' } }).route, MESSAGE_ROUTE.RAG_QUERY, content);
  }
});

test('Douyin pure social comments receive natural replies while questions remain grounded', () => {
  for (const content of ['学到了', '学到了[666][666][666]', '谢谢！', '不错', '涨知识了', '你好', '哈哈']) {
    const result = routeIncomingMessage({ message: { platform_code: 'douyin', content, message_type: 'COMMENT' } });
    assert.equal(result.route, MESSAGE_ROUTE.DIRECT_REPLY, content);
    assert.equal(result.reasonCode, 'COMMENT_SOCIAL_REPLY');
    assert.equal(result.allowRag, false);
    assert.ok(result.replyText);
  }
  for (const content of ['学到了，社区几点开放？', '谢谢，怎么报名', '不错，多少钱', '这个结论是真的吗', '今天的天气', '学到了吗？', '谢谢[怎么报名]', '不错[赞]，多少钱']) {
    assert.equal(routeIncomingMessage({ message: { platform_code: 'douyin', content, message_type: 'COMMENT' } }).route, MESSAGE_ROUTE.RAG_QUERY, content);
  }
  assert.equal(routeIncomingMessage({ message: { platform_code: 'douyin', content: '学到了', message_type: 'COMMENT' }, conversation: { handling_mode: 'HUMAN_MANAGED' } }).route, MESSAGE_ROUTE.HUMAN_HANDOFF);
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
