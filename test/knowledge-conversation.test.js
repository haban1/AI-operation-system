import test from 'node:test';
import assert from 'node:assert/strict';
import { knowledgeConversationPreflight, knowledgeAnswerPresentation } from '../src/services/knowledge-conversation.js';
import { knowledgeConsultationReply } from '../src/services/knowledge-reply-text.js';
import { buildLocalRagTestRequest } from '../src/services/rag-local-test.js';
const request = (text, context = [], extra = {}) => buildLocalRagTestRequest({ text, context, ...extra }, { knowledgeBaseId: 'test-kb' });
const history = [{ role: 'USER', text: '示例公开课在哪里举办' }, { role: 'ASSISTANT', text: '隔离地点' }];
test('social and missing-subject replies do not masquerade as grounded answers', () => {
  for (const text of ['你是谁', '好厉害', '太厉害了', '谢谢']) {
    const reply = knowledgeConversationPreflight(request(text));
    assert.equal(reply.kind, 'SOCIAL', text);
    assert.ok(reply.text);
    assert.equal(reply.response, undefined);
  }
  for (const text of ['在那里参加', '在哪里参加', '咋参加', '请问怎么参加呀']) {
    assert.deepEqual(knowledgeConversationPreflight(request(text)), { kind: 'CLARIFICATION', text: '你想参加哪个活动或课程呀？' }, text);
  }
  for (const text of ['好厉害，示例公开课在哪举办', '示例公开课咋参加', '你们在哪', '咋过去']) {
    assert.equal(knowledgeConversationPreflight(request(text)), null, text);
  }
  assert.equal(knowledgeConversationPreflight(request('在那里参加', history)), null);
  assert.equal(knowledgeConversationPreflight(request('转人工')).kind, 'HUMAN_GUIDANCE');
});
test('consultation text follows the current topic without revealing retrieval internals or invented facts', () => {
  for (const [text, expected] of [['报名方式是什么', '报名方式'], ['你们的电话呢', '联系方式'], ['在几楼', '楼层或房间'], ['这期还有名额吗', '具体安排'], ['还有吗', '这个问题']]) {
    const reply = knowledgeConsultationReply(text);
    assert.ok(reply.includes(expected), text);
    assert.doesNotMatch(reply, /检索|知识库|资料不足|查不到|已转接|已通知|\d{7,}/);
  }
  assert.match(knowledgeConsultationReply('那具体怎么操作', { context: [{role:'USER',text:'示例公开课怎么报名'}] }), /报名方式/);
  assert.match(knowledgeConsultationReply('那这期还有名额吗', { context: [{role:'USER',text:'示例公开课怎么报名'}] }), /具体安排/);
  assert.match(knowledgeConsultationReply('電話呢', {script:'traditional'}), /聯繫方式/);
});
test('grounded text stays unchanged and comment fallback follows platform rules', () => {
  assert.deepEqual(knowledgeAnswerPresentation(request('地点'), { result: 'ANSWERED', answer: { text: '已核实原文' } }), { kind: 'GROUNDED', text: '已核实原文' });
  const privateReply = knowledgeAnswerPresentation(request('电话是多少'), {result:'NO_ANSWER'});
  assert.equal(privateReply.kind, 'CONSULTATION');
  assert.match(privateReply.text, /联系方式/);
  const comment = knowledgeAnswerPresentation(request('电话是多少', [], {channelType:'COMMENT'}), {result:'NO_ANSWER'});
  assert.doesNotMatch(comment.text, /人工|客服/);
});
