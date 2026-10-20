import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { handleModelGateway } from '../src/services/model-gateway.js';

async function gateway(t, options = {}) {
  let settings = { mode: 'online', apiKey: 'upstream-secret', baseUrl: 'https://provider.test/v1', model: 'chat-a', visionModel: 'vision-a' };
  const calls = [], logs = [];
  const server = http.createServer((req, res) => handleModelGateway(req, res, {
    token: 'internal-secret', getSettings: () => settings, recordUsage: entry => logs.push(entry),
    fetchImpl: async (url, request) => {
      calls.push({ url, request, payload: JSON.parse(request.body) });
      return options.response ? options.response() : Response.json({ choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 3 } });
    }, ...options,
  }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}/api/model/v1/`;
  return { calls, logs, set: value => { settings = { ...settings, ...value }; },
    request: (payload, { token = 'internal-secret', route = 'chat/completions' } = {}) => fetch(base + route, {
      method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    }), base };
}

test('native robot local embeddings stay authenticated and use only the configured local service', async t => {
  const g = await gateway(t, { localEmbeddings: {url:'http://rag/rag-admin-api/v1/embeddings',token:'local-secret'} });
  g.set({embeddingModel:'local:BAAI/bge-small-zh-v1.5'});
  assert.equal((await g.request({model:'tianhe-robot-embedding',input:['hello'],dimensions:512},{route:'embeddings',token:''})).status,401);
  assert.equal(g.calls.length,0);
  assert.equal((await g.request({model:'tianhe-robot-embedding',input:['hello'],dimensions:512},{route:'embeddings'})).status,200);
  assert.equal(g.calls[0].url,'http://rag/rag-admin-api/v1/embeddings');
  assert.equal(g.calls[0].request.headers.Authorization,'Bearer local-secret');
  assert.equal(g.calls[0].payload.model,'BAAI/bge-small-zh-v1.5');
  assert.equal(g.calls[0].payload.dimensions,512);
});

test('model gateway fails closed and does not expose settings or call upstream', async t => {
  const g = await gateway(t);
  const request = { model: 'tianhe-wechat-chat', messages: [] };
  assert.equal((await g.request(request, { token: '' })).status, 401);
  assert.equal((await fetch(g.base + 'status')).status, 401);
  assert.equal((await g.request({ ...request, model: 'unapproved-model' })).status, 400);
  assert.equal((await g.request(request, { route: 'embeddings' })).status, 400);
  g.set({ mode: 'mock' });
  assert.equal((await (await g.request(request)).json()).error.code, 'AI_MODE_DISABLED');
  g.set({ mode: 'online', apiKey: '' });
  assert.equal((await (await g.request(request)).json()).error.code, 'AI_KEY_MISSING');
  assert.equal(g.calls.length, 0);
});

test('all chat consumers follow new settings on the next request and preserve native tools', async t => {
  const g = await gateway(t);
  const tools = [{ type: 'function', function: { name: 'search_knowledge', parameters: { type: 'object' } } }];
  const messages = [{ role: 'tool', tool_call_id: 'call-1', content: 'evidence' }];
  for (const model of ['tianhe-wechat-chat', 'tianhe-rag-chat', 'tianhe-robot-chat']) {
    assert.equal((await g.request({ model, messages, tools, tool_choice: 'auto' })).status, 200);
    assert.equal(g.calls.at(-1).payload.model, 'chat-a');
    assert.deepEqual(g.calls.at(-1).payload.tools, tools);
    assert.deepEqual(g.calls.at(-1).payload.messages, messages);
  }
  g.set({ model: 'chat-b', visionModel: 'vision-b', apiKey: 'rotated-secret', baseUrl: 'https://other.test/v1' });
  await g.request({ model: 'tianhe-wechat-chat', messages });
  assert.equal(g.calls.at(-1).payload.model, 'chat-b');
  assert.equal(g.calls.at(-1).request.headers.Authorization, 'Bearer rotated-secret');
  assert.equal(g.calls.at(-1).url, 'https://other.test/v1/chat/completions');
  await g.request({ model: 'tianhe-robot-vision', messages });
  assert.equal(g.calls.at(-1).payload.model, 'vision-b');
  assert.ok(g.logs.some(entry => entry.sourceModule === 'rag-generation' && entry.usage.prompt_tokens === 3));
  assert.ok(!JSON.stringify(g.logs).includes('secret'));
});

test('upstream 429 remains actionable without leaking provider response secrets', async t => {
  const g = await gateway(t, { response: () => Response.json({ error: { message: 'upstream-secret internal-secret private prompt' } }, { status: 429 }) });
  const response = await g.request({ model: 'tianhe-wechat-chat', messages: [] });
  assert.equal(response.status, 429);
  const body = await response.text();
  assert.match(body, /AI_RATE_LIMITED/);
  assert.doesNotMatch(body + JSON.stringify(g.logs), /secret|private prompt/);
});

test('robot streaming and embeddings preserve their protocol', async t => {
  const events = 'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n';
  const g = await gateway(t, { response: () => new Response(events, { headers: { 'Content-Type': 'text/event-stream' } }) });
  const response = await g.request({ model: 'tianhe-robot-chat', messages: [], stream: true });
  assert.equal(await response.text(), events);
  const e = await gateway(t);
  assert.equal((await e.request({ model: 'tianhe-robot-embedding', input: ['test'] }, { route: 'embeddings' })).status, 503);
  e.set({ embeddingModel: 'embedding-a' });
  assert.equal((await e.request({ model: 'tianhe-robot-embedding', input: ['test'] }, { route: 'embeddings' })).status, 200);
  assert.equal(e.calls[0].payload.model, 'embedding-a');
});
