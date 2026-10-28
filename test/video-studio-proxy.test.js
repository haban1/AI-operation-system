import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { createVideoStudioProxy } from '../src/services/video-studio-proxy.js';

async function serve(t, handler) {
  const server = createServer(handler);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return `http://127.0.0.1:${server.address().port}`;
}
async function gateway(t, upstreamUrl, options = {}) {
  const handle = createVideoStudioProxy({ upstreamUrl, authorize: req => req.headers.cookie === 'session=test-only', ...options });
  return serve(t, (req, res) => handle(req, res));
}
function request(base, suffix, { method = 'GET', headers = {}, body = '' } = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(base, { path: '/video-workbench/' + suffix, method, headers }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.once('error', reject);
      res.once('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.once('error', reject); req.end(body);
  });
}
const authenticated = { Cookie: 'session=test-only' };

test('companion HTML, APIs and media stay behind main system authentication', async t => {
  let hits = 0;
  const upstream = await serve(t, (_req, res) => { hits++; res.end('private'); });
  const base = await gateway(t, upstream);
  for (const suffix of ['index.html', 'api/studio/bootstrap', 'api/chat/sessions', 'bundled/videos/sample.mp4']) {
    assert.equal((await request(base, suffix)).status, 401);
  }
  assert.equal(hits, 0);
  assert.equal((await request(base, 'index.html', { headers: authenticated })).status, 200);
});

test('bootstrap keeps videos and rewrites only the embedded hotspot entry to the same origin', async t => {
  let seen;
  const upstream = await serve(t, (req, res) => {
    seen = req.headers;
    res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': 'private=internal', 'Access-Control-Allow-Origin': '*', 'Content-Security-Policy': "default-src 'self'" });
    res.end(JSON.stringify({ automaticUrl: 'http://127.0.0.1:8892/', videos: [{ id: 'sample', videoPath: '/bundled/sample.mp4' }] }));
  });
  const base = await gateway(t, upstream);
  const result = await request(base, 'api/studio/bootstrap', { headers: { ...authenticated, Origin: base, Authorization: 'Bearer private', 'X-Api-Key': 'private', 'X-Forwarded-Host': 'foreign.example' } });
  assert.equal(result.status, 200);
  assert.equal(JSON.parse(result.body).automaticUrl, '/integrations/ai-signal/');
  assert.deepEqual(JSON.parse(result.body).videos, [{ id: 'sample', videoPath: '/bundled/sample.mp4' }]);
  for (const name of ['cookie', 'origin', 'authorization', 'x-api-key', 'x-forwarded-host']) assert.equal(seen[name], undefined, name);
  assert.equal(seen.host, new URL(upstream).host);
  assert.equal(result.headers['set-cookie'], undefined);
  assert.equal(result.headers['access-control-allow-origin'], undefined);
  assert.equal(result.headers['x-frame-options'], 'SAMEORIGIN');
  assert.match(result.headers['content-security-policy'], /default-src 'self'/);
  assert.match(result.headers['content-security-policy'], /frame-ancestors 'self'/);
});

test('video Range/HEAD responses and editing bodies keep their bytes', async t => {
  let received;
  const upstream = await serve(t, async (req, res) => {
    if (req.method === 'POST') {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      received = { path: req.url, body: Buffer.concat(chunks).toString() };
      res.writeHead(202, { 'Content-Type': 'application/json' }); res.end('{"accepted":true}'); return;
    }
    assert.equal(req.headers.range, 'bytes=2-5');
    res.writeHead(206, { 'Content-Type': 'video/mp4', 'Content-Length': '4', 'Content-Range': 'bytes 2-5/10', 'Accept-Ranges': 'bytes' });
    res.end(req.method === 'HEAD' ? undefined : '2345');
  });
  const base = await gateway(t, upstream);
  for (const method of ['GET', 'HEAD']) {
    const result = await request(base, 'bundled/videos/sample.mp4', { method, headers: { ...authenticated, Range: 'bytes=2-5' } });
    assert.equal(result.status, 206); assert.equal(result.headers['content-range'], 'bytes 2-5/10');
    assert.equal(result.body, method === 'HEAD' ? '' : '2345');
  }
  const result = await request(base, 'api/chat/sessions/demo/messages?mode=edit', { method: 'POST', headers: { ...authenticated, Origin: base, 'Content-Type': 'application/json' }, body: '{"message":"keep this exact text"}' });
  assert.equal(result.status, 202);
  assert.deepEqual(received, { path: '/api/chat/sessions/demo/messages?mode=edit', body: '{"message":"keep this exact text"}' });
});

test('chat events stream before the editing session finishes', async t => {
  const upstream = await serve(t, (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: {"type":"running"}\n\n');
  });
  const base = await gateway(t, upstream);
  const abort = new AbortController(); t.after(() => abort.abort());
  const response = await fetch(base + '/video-workbench/api/chat/sessions/demo/events', { headers: authenticated, signal: abort.signal });
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  const chunk = await reader.read();
  assert.equal(chunk.done, false);
  assert.match(new TextDecoder().decode(chunk.value), /running/);
  abort.abort();
});

test('foreign origins, malformed paths, oversized bodies and upstream redirects fail closed', async t => {
  let hits = 0;
  const upstream = await serve(t, (_req, res) => { hits++; res.writeHead(302, { Location: 'https://foreign.example/' }); res.end(); });
  const base = await gateway(t, upstream, { maxBodyBytes: 8 });
  assert.equal((await request(base, 'api/chat/sessions', { method: 'POST', headers: { ...authenticated, Origin: 'https://foreign.example' }, body: '{}' })).status, 403);
  for (const suffix of ['%2e%2e/private', '%5cprivate', '%00private', '%ZZ', '/foreign.example']) assert.equal((await request(base, suffix, { headers: authenticated })).status, 400, suffix);
  assert.equal((await request(base, 'api/chat/sessions', { method: 'POST', headers: authenticated, body: '123456789' })).status, 413);
  assert.equal(hits, 0);
  const result = await request(base, 'index.html', { headers: authenticated });
  assert.equal(result.status, 502); assert.equal(result.headers.location, undefined);
});
