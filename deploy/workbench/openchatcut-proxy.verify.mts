import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { createMiniConnect } from '../desktop/mini-connect.ts';
import { proxyMiddleware } from '../server/proxy.ts';
import { requestShapeGatePlugin } from '../server/plugins/request-shape-gate.ts';

async function listen(server: Server): Promise<string> {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
}
async function close(server: Server) {
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
}

const observed: { headers: Record<string, unknown>; body: string; url?: string }[] = [];
const events = 'data: {"choices":[{"delta":{"content":"connected"}}]}\n\ndata: [DONE]\n\n';
const upstream = createServer(async (req, res) => {
  let body = '';
  for await (const chunk of req) body += chunk;
  observed.push({ headers: req.headers, body, url: req.url });
  // Reproduce Tianhe's CORS-before-token check, followed by independent auth.
  if (req.headers.origin) { res.writeHead(403).end(); return; }
  if (req.headers.authorization !== 'Bearer internal-test-token') {
    res.writeHead(401).end(); return;
  }
  if (JSON.parse(body).stream) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(events);
  } else {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"choices":[{"message":{"content":"connected"}}]}');
  }
});
const upstreamOrigin = await listen(upstream);
const app = createMiniConnect(error => { throw error; });
const gate = requestShapeGatePlugin().configureServer;
assert.equal(typeof gate, 'function');
await (gate as Function).call({}, { middlewares: app });
let token = 'internal-test-token';
app.use('/llm', proxyMiddleware({
  target: () => upstreamOrigin + '/api/model/v1',
  headers: () => ({ authorization: 'Bearer ' + token }),
}));
const proxy = createServer(app.handle);
const origin = await listen(proxy);
const headers = {
  origin, referer: origin + '/editor', cookie: 'session=private',
  'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors',
  'sec-fetch-dest': 'empty', 'sec-fetch-user': '?1',
  'x-openchatcut-provider': 'openai', 'content-type': 'application/json',
  authorization: 'Bearer browser-placeholder',
};
try {
  for (const stream of [false, true]) {
    const body = JSON.stringify({ model: 'tianhe-workbench-chat', messages: [{ role: 'user', content: 'test' }], stream });
    const response = await fetch(origin + '/llm/chat/completions', { method: 'POST', headers, body });
    assert.equal(response.status, 200, 'Editor request must reach the authenticated gateway');
    if (stream) assert.equal(await response.text(), events);
    else assert.equal((await response.json()).choices[0].message.content, 'connected');
    const seen = observed.at(-1)!;
    assert.equal(seen.url, '/api/model/v1/chat/completions');
    assert.equal(seen.body, body);
    assert.equal(seen.headers.authorization, 'Bearer internal-test-token');
    for (const name of ['origin', 'referer', 'cookie', 'sec-fetch-site', 'sec-fetch-mode', 'sec-fetch-dest', 'sec-fetch-user', 'x-openchatcut-provider']) {
      assert.equal(seen.headers[name], undefined, `${name} must remain local to the editor`);
    }
  }
  for (const override of [{ origin: 'https://other.example' }, { 'sec-fetch-site': 'cross-site' }]) {
    const response = await fetch(origin + '/llm/chat/completions', { method: 'POST', headers: { ...headers, ...override }, body: '{}' });
    assert.equal(response.status, 403, 'Editor origin protection must remain in effect');
    await response.body?.cancel();
  }
  assert.equal(observed.length, 2, 'Untrusted editor requests must not reach Tianhe');
  token = 'invalid';
  const denied = await fetch(origin + '/llm/chat/completions', { method: 'POST', headers, body: '{}' });
  assert.equal(denied.status, 401, 'Gateway token protection must remain in effect');
  await denied.body?.cancel();
  console.log('Tianhe OpenChatCut proxy: JSON, SSE, origin protection and token authentication passed');
} finally {
  await close(proxy);
  await close(upstream);
}
