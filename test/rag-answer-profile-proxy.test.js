import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { cleanupDir, jsonRequest, startServer, stopChild } from './helpers/runtime.js';

test('回答风格沿用管理员认证、固定知识库和 RAG 错误语义', async t => {
  let observed = [];
  let invalid = false;
  const profile = { assistantName: '智慧驱动答疑助手', companyName: '智慧驱动', stylePrompt: '简短自然地回答。', greeting: '你好。' };
  const rag = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    observed.push({ method: req.method, path: req.url, token: req.headers.authorization, body: raw ? JSON.parse(raw) : null });
    res.writeHead(invalid ? 422 : 200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(invalid ? { error: { code: 'VALIDATION_ERROR', message: '回答风格字段无效' } } : {
      knowledgeBaseId: 'main-business-kb', profile: raw ? JSON.parse(raw) : profile,
      scope: 'answer_presentation_only', promptVersion: 'grounded-conversation-v1'
    }));
  });
  await new Promise(resolve => rag.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => rag.close(resolve)));
  const runtime = await startServer({ env: {
    AUTH_ENABLED: 'true', ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'test-profile-admin-password',
    SESSION_SECRET: 'test-profile-session-secret-at-least-32-characters',
    RAG_BASE_URL: `http://127.0.0.1:${rag.address().port}`, RAG_TOKEN: 'test-rag-secret',
    RAG_ADMIN_ENABLED: 'true', RAG_FORMAL_ROUTING_ENABLED: 'false', RAG_AUTO_START: 'false',
    CONTENT_LIBRARY_SEED_ENABLED: 'false'
  } });
  t.after(async () => { await stopChild(runtime.child); cleanupDir(runtime.dir); });
  for (const method of ['GET', 'PUT']) {
    const result = await jsonRequest(runtime.base, '/api/rag/answer-profile', { method, ...(method === 'PUT' ? { body: profile } : {}) });
    assert.equal(result.response.status, 401);
  }
  assert.equal(observed.length, 0, '未经认证不得访问内部 RAG');
  const login = await jsonRequest(runtime.base, '/api/auth/login', { method: 'POST', body: { username: 'admin', password: 'test-profile-admin-password' } });
  assert.equal(login.response.status, 200);
  const headers = { Cookie: login.response.headers.get('set-cookie').split(';')[0] };
  const read = await jsonRequest(runtime.base, '/api/rag/answer-profile?knowledgeBaseId=other-tenant', { headers });
  assert.equal(read.response.status, 200);
  assert.deepEqual(read.data.profile, profile);
  assert.equal(observed[0].path, '/rag-admin-api/v1/knowledge-bases/main-business-kb/answer-profile');
  assert.equal(observed[0].token, 'Bearer test-rag-secret');
  const updated = { ...profile, stylePrompt: '先给直接答案，再按需解释。' };
  const write = await jsonRequest(runtime.base, '/api/rag/answer-profile', { method: 'PUT', headers, body: updated });
  assert.equal(write.response.status, 200);
  assert.deepEqual(observed[1].body, updated);
  assert.equal(observed[1].method, 'PUT');
  assert.deepEqual(write.data.profile, updated);
  invalid = true;
  const rejected = await jsonRequest(runtime.base, '/api/rag/answer-profile', { method: 'PUT', headers, body: { ...updated, extra: 'forbidden' } });
  assert.equal(rejected.response.status, 422);
  assert.equal(rejected.data.code, 'VALIDATION_ERROR');
});
