import test from 'node:test';
import assert from 'node:assert/strict';
import { RagClient } from '../src/services/rag-client.js';

test('persona admin calls use the existing RAG transport, auth and fixed knowledge-base path', async () => {
  const calls = [];
  const profile = { assistantName: '智慧驱动答疑助手', companyName: '智慧驱动', stylePrompt: '简短自然', greeting: '你好' };
  const client = new RagClient({
    baseUrl: 'http://rag.test', token: 'test-admin',
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return new Response(JSON.stringify({ knowledgeBaseId: 'kb/a', profile }), { status: 200 });
    },
  });
  assert.deepEqual((await client.getAnswerProfile({ knowledgeBaseId: 'kb/a' })).profile, profile);
  assert.deepEqual((await client.saveAnswerProfile({ knowledgeBaseId: 'kb/a', profile })).profile, profile);
  assert.equal(calls[0].url, 'http://rag.test/rag-admin-api/v1/knowledge-bases/kb%2Fa/answer-profile');
  assert.equal(calls[0].options.method, 'GET');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer test-admin');
  assert.equal(calls[1].options.method, 'PUT');
  assert.deepEqual(JSON.parse(calls[1].options.body), profile);
});
