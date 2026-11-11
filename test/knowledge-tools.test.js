import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { buildLocalRagTestRequest } from '../src/services/rag-local-test.js';
import { startServer, stopChild, cleanupDir, jsonRequest } from './helpers/runtime.js';

test('local RAG test fixes scope, separates operators, validates bounded paired context and ignores client authority', () => {
  const data = { text: '服务费用多少？', sessionId: 'test-session', knowledgeBaseId: 'other', releaseId: 'old', constraints: { requireGrounding: false }, context: [{ role: 'USER', text: '了解服务' }, { role: 'ASSISTANT', text: '请问具体内容' }] };
  const request = buildLocalRagTestRequest(data, { knowledgeBaseId: 'fixed', operatorId: 'a' });
  assert.deepEqual(request.knowledgeScope, { tenantId: 'local-default', knowledgeBaseId: 'fixed' });
  assert.equal(request.constraints.requireGrounding, true);
  assert.equal(request.source.accountId, 'local-test');
  assert.match(request.snapshot.conversationKey, /^LOCAL_TEST:/);
  assert.equal(request.context.length, 2);
  assert.notEqual(request.snapshot.conversationKey, buildLocalRagTestRequest(data, { knowledgeBaseId: 'fixed', operatorId: 'b' }).snapshot.conversationKey);
  assert.equal(buildLocalRagTestRequest({ ...data, channelType: 'COMMENT' }, { knowledgeBaseId: 'fixed' }).context.length, 0);
  for (const invalid of [null, [], { text: '' }, { text: 'x'.repeat(4001) }, { text: 'x', platform: 'OTHER' }, { text: 'x', channelType: 'SEND' }, { text: 'x', sessionId: '../real' }, { text: 'x', context: [{ role: 'USER', text: 'x' }] }, { text: 'x', context: Array(8).fill({ role: 'USER', text: 'x' }) }, { text: 'x', context: [{ role: 'SYSTEM', text: 'x' }, { role: 'ASSISTANT', text: 'x' }] }]) {
    assert.throws(() => buildLocalRagTestRequest(invalid, { knowledgeBaseId: 'fixed' }), error => error.statusCode === 400);
  }
});

test('authenticated local tests use formal RAG only, expose citations/no-answer/errors and never create business work', async t => {
  const calls = [];
  let mismatch = false;
  const upstream = http.createServer(async (req, res) => {
    let raw = ''; for await (const part of req) raw += part;
    const data = JSON.parse(raw);
    calls.push({ path: req.url, token: req.headers.authorization, data });
    res.setHeader('Content-Type', 'application/json');
    if (data.query.text === 'error') { res.statusCode = 503; return res.end(JSON.stringify({ error: { code: 'MODEL_UNAVAILABLE', message: '模型暂不可用' } })); }
    res.end(JSON.stringify({ result: data.query.text === 'missing' ? 'NO_ANSWER' : 'ANSWERED', answer: data.query.text === 'missing' ? null : { text: '隔离测试答案' }, reasonCode: data.query.text === 'missing' ? 'INSUFFICIENT_EVIDENCE' : null, snapshot: { ...data.snapshot, ...(mismatch ? { inputFingerprint: 'wrong' } : {}) }, grounding: { sourceReferences: [{ title: '测试资料', chunkId: 'chunk-1' }] }, traceId: data.traceId, meta: { latencyMs: 10 } }));
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => upstream.close(resolve)));
  const runtime = await startServer({ env: { AUTH_ENABLED: 'true', ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'test-tools-password', SESSION_SECRET: 'test-tools-session-secret-long-enough-32', RAG_BASE_URL: `http://127.0.0.1:${upstream.address().port}`, RAG_TOKEN: 'test-token', RAG_ADMIN_ENABLED: 'true', RAG_AUTO_START: 'false', OPERATIONS_ANALYTICS_ENABLED: 'false' } });
  t.after(async () => { await stopChild(runtime.child); cleanupDir(runtime.dir); });
  assert.equal((await jsonRequest(runtime.base, '/api/rag/test-query', { method: 'POST', body: { text: 'question' } })).response.status, 401);
  assert.equal(calls.length, 0);
  const login = await jsonRequest(runtime.base, '/api/auth/login', { method: 'POST', body: { username: 'admin', password: 'test-tools-password' } });
  const headers = { Cookie: login.response.headers.get('set-cookie').split(';')[0] };
  const db = new DatabaseSync(runtime.dbPath, { readOnly: true }); t.after(() => db.close());
  const counts = () => Object.fromEntries(['messages', 'agent_jobs', 'conversations', 'notifications', 'mini_program_processing_jobs'].map(name => [name, db.prepare('SELECT count(*) AS n FROM ' + name).get().n]));
  const before = counts();
  const query = body => jsonRequest(runtime.base, '/api/rag/test-query', { method: 'POST', headers, body });
  const answered = await query({ text: 'question', knowledgeBaseId: 'other' });
  assert.equal(answered.response.status, 200);
  assert.equal(answered.data.mode, 'LOCAL_TEST');
  assert.equal(answered.data.response.grounding.sourceReferences[0].chunkId, 'chunk-1');
  assert.equal(calls[0].path, '/rag-api/v1/query');
  assert.equal(calls[0].token, 'Bearer test-token');
  assert.equal(calls[0].data.knowledgeScope.knowledgeBaseId, 'main-business-kb');
  assert.equal((await query({ text: 'missing' })).data.response.result, 'NO_ANSWER');
  assert.equal((await query({ text: '' })).response.status, 400);
  assert.equal((await query({ text: 'error' })).response.status, 503);
  mismatch = true;
  assert.equal((await query({ text: 'question' })).response.status, 502);
  assert.deepEqual(counts(), before);
  assert.ok(calls.every(call => call.path === '/rag-api/v1/query'));
});
