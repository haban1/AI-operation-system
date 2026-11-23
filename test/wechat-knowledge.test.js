import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { buildWechatKnowledgeRequest, createWechatKnowledgeQuery } from '../src/services/wechat-knowledge.js';
import { handleModelGateway } from '../src/services/model-gateway.js';

const input = () => ({ text: '公司简介', accountId: 'a'.repeat(64), conversationId: 'b'.repeat(64), messageId: '12', context: [] });
const answer = request => ({ status: 'ANSWERED', requestId: request.requestId, snapshot: request.snapshot,
  answer: { text: '这是来自公司原文的答复。' }, grounding: { sourceReferences: [{ verificationStatus: 'VERIFIED' }] },
  meta: { knowledgeBaseId: 'main-test' }, traceId: request.traceId });

test('WeChat knowledge fixes scope and preserves original question and paired history', () => {
  const data = { ...input(), context: [{ role: 'USER', text: '你们是谁' }, { role: 'ASSISTANT', text: '公司介绍' }] };
  const request = buildWechatKnowledgeRequest(data, 'main-test');
  assert.deepEqual(request.knowledgeScope, { tenantId: 'local-default', knowledgeBaseId: 'main-test' });
  assert.equal(request.source.platform, 'WECHAT_ROBOT');
  assert.equal(request.query.text, data.text);
  assert.deepEqual(request.context, data.context);
  assert.equal(request.constraints.requireGrounding, true);
  const same = buildWechatKnowledgeRequest(data, 'main-test');
  assert.deepEqual(request.snapshot, same.snapshot);
  for (const changed of [{ accountId: 'c'.repeat(64) }, { conversationId: 'd'.repeat(64) }]) {
    assert.notEqual(buildWechatKnowledgeRequest({ ...data, ...changed }, 'main-test').snapshot.conversationKey, request.snapshot.conversationKey);
  }
});

test('WeChat knowledge rejects scope overrides, incomplete/oversize history and unsafe versions', () => {
  for (const changed of [{ knowledgeBaseId: 'other' }, { baseUrl: 'https://evil.test' }, { model: 'other' },
    { text: '' }, { text: '文'.repeat(4001) }, { accountId: 'wxid_private' }, { messageId: '9007199254740993' },
    { context: [{ role: 'USER', text: 'orphan' }] }, { context: [{ role: 'ASSISTANT', text: 'a' }, { role: 'USER', text: 'b' }] },
    { context: Array.from({ length: 6 }, (_, i) => ({ role: i % 2 ? 'ASSISTANT' : 'USER', text: '文'.repeat(3000) })) }]) {
    assert.throws(() => buildWechatKnowledgeRequest({ ...input(), ...changed }, 'main-test'), { statusCode: 400 });
  }
});

test('WeChat knowledge returns only grounded, matching answers and fails closed', async () => {
  for (const mutate of [null, result => { result.snapshot = { ...result.snapshot, conversationKey: 'other' }; },
    result => { result.snapshot = { ...result.snapshot, inputFingerprint: 'other' }; },
    result => { result.snapshot = { ...result.snapshot, conversationVersion: 13 }; },
    result => { result.meta.knowledgeBaseId = 'other'; }, result => { result.requestId = 'other'; },
    result => { result.grounding.sourceReferences = []; }, result => { result.grounding.sourceReferences[0].verificationStatus = 'UNVERIFIED'; },
    result => { result.answer.text = ''; }]) {
    const query = createWechatKnowledgeQuery({ knowledgeBaseId: 'main-test', ragClient: {
      async queryFormalKnowledge(request) { const result = answer(request); mutate?.(result); return result; },
    } });
    const result = await query(input());
    assert.equal(result.status, mutate ? 'UNAVAILABLE' : 'ANSWERED');
    assert.equal('grounding' in result, false, 'Do not return raw source excerpts');
  }
  for (const outcome of ['NO_ANSWER', 'UNAVAILABLE', 'INVALID_RESPONSE', 'THROW']) {
    const query = createWechatKnowledgeQuery({ knowledgeBaseId: 'main-test', ragClient: {
      async queryFormalKnowledge(request) {
        if (outcome === 'THROW') throw new Error('private upstream-secret');
        return { ...answer(request), status: outcome, answer: null };
      },
    } });
    const result = await query(input());
    assert.equal(result.status, outcome === 'NO_ANSWER' ? outcome : 'UNAVAILABLE');
    if (outcome === 'NO_ANSWER') assert.equal(result.text, '这个问题建议向人工客服咨询一下。');
    assert.doesNotMatch(JSON.stringify(result), /secret|private|公司原文/);
  }
});

test('knowledge gateway authenticates before query, enforces size and hides exceptions', async t => {
  const calls = [];
  const server = http.createServer((req, res) => handleModelGateway(req, res, {
    token: 'internal-test', getSettings: () => { throw new Error('not a model request'); },
    knowledgeQuery: async data => {
      calls.push(data);
      if (data.throw) throw new Error('private-secret');
      return { status: 'NO_ANSWER', text: '没有依据' };
    },
  }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const post = (payload, token = 'internal-test') => fetch(`http://127.0.0.1:${server.address().port}/api/model/v1/knowledge/query`, {
    method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: payload,
  });
  assert.equal((await post(JSON.stringify(input()), '')).status, 401);
  assert.equal(calls.length, 0);
  assert.equal((await post('{')).status, 400);
  assert.equal((await post('a'.repeat(96 * 1024 + 1))).status, 413);
  assert.equal(calls.length, 0);
  assert.equal((await post(JSON.stringify(input()))).status, 200);
  const failure = await post('{"throw":true}');
  assert.equal(failure.status, 503);
  assert.doesNotMatch(await failure.text(), /private|secret/);
});

test('WeChat conversation presentation skips retrieval only after strict input validation', async () => {
  let calls = 0;
  const query = createWechatKnowledgeQuery({ knowledgeBaseId: 'main-test', ragClient: {
    async queryFormalKnowledge(request) { calls++; return { ...answer(request), status:'NO_ANSWER', answer:null }; }
  } });
  for (const [text, status, replyKind] of [['好厉害','SOCIAL_REPLY','SOCIAL'],['你是谁','SOCIAL_REPLY','SOCIAL'],['在那里参加','NEED_CLARIFICATION','CLARIFICATION']]) {
    const result=await query({...input(),text});assert.equal(result.status,status);assert.equal(result.replyKind,replyKind);assert.equal(result.traceId,undefined);
  }
  assert.equal(calls,0);
  await assert.rejects(query({...input(),text:'好厉害',accountId:'invalid'}));assert.equal(calls,0);
  const result=await query({...input(),text:'好厉害，示例公开课怎么报名'});
  assert.equal(calls,1);assert.equal(result.status,'NO_ANSWER');assert.equal(result.replyKind,'CONSULTATION');assert.match(result.text,/报名方式/);
  await query({...input(),text:'在那里参加',context:[{role:'USER',text:'示例公开课在哪举办'},{role:'ASSISTANT',text:'隔离地点'}]});
  assert.equal(calls,2);
});
