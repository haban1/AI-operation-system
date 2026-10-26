import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createAiSignalProxy, isAiSignalProxyPath } from '../src/services/ai-signal-proxy.js';
import { createSessionToken, sessionCookie, sessionFromRequest } from '../src/services/auth.js';

const auth = { username: 'proxy-test', secret: 'test-only-signal-session-secret' };
const cookie = sessionCookie(createSessionToken({ ...auth, ttlMs: 60_000 }), { ttlMs: 60_000 }).split(';')[0];
const prefix = '/integrations/ai-signal/';

async function serve(t, handler) {
  const instance = createServer(handler);
  await new Promise((resolve, reject) => { instance.once('error', reject); instance.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise(resolve => { instance.close(resolve); instance.closeAllConnections(); }));
  return `http://127.0.0.1:${instance.address().port}`;
}

async function proxy(t, upstreamUrl, options = {}) {
  const handle = createAiSignalProxy({ upstreamUrl, authorize: req => sessionFromRequest(req, auth), ...options });
  return serve(t, (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (isAiSignalProxyPath(url.pathname)) return handle(req, res, url);
    res.writeHead(404); res.end('not a Signal route');
  });
}

function request(base, path, { method = 'GET', headers = {}, body = '' } = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(base, { path, method, headers }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.once('error', reject);
      res.once('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.once('error', reject);
    req.end(body);
  });
}

test('Signal HTML, API and media all require a valid administrator session', async t => {
  let hits = 0;
  const upstream = await serve(t, (_req, res) => { hits++; res.end('private engine'); });
  const base = await proxy(t, upstream);
  for (const path of ['', 'app.js', 'api/state', 'api/health', 'runs/example/video.mp4']) {
    for (const value of ['', 'tianhe_admin_session=invalid']) {
      const result = await request(base, prefix + path, { headers: { Cookie: value } });
      assert.equal(result.status, 401, path);
      assert.doesNotMatch(result.body, /private engine/);
    }
  }
  const deniedPost = await request(base, prefix + 'api/generate', { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } });
  assert.equal(deniedPost.status, 401);
  assert.equal(hits, 0);
  assert.equal((await request(base, prefix, { headers: { Cookie: cookie } })).body, 'private engine');
});

test('Signal proxy strips only its prefix and isolates browser and internal headers', async t => {
  let seen;
  const upstream = await serve(t, async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    seen = { path: req.url, method: req.method, headers: req.headers, body: Buffer.concat(chunks).toString() };
    res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': 'internal=private', 'X-Internal-Token': 'private', 'Access-Control-Allow-Origin': '*' });
    res.end('{"ok":true}');
  });
  const base = await proxy(t, upstream);
  const result = await request(base, prefix + 'api/settings?mode=write', {
    method: 'POST', body: '{"model":"example"}', headers: {
      Cookie: cookie, Authorization: 'Bearer must-stay-at-web', Origin: base, Referer: base + '/private',
      'X-Forwarded-For': '203.0.113.1', 'X-Forwarded-Host': 'foreign.example', 'X-Forwarded-Proto': 'https',
      'X-Real-IP': '203.0.113.2', 'X-Api-Key': 'must-not-forward', 'Content-Type': 'application/json',
    },
  });
  assert.equal(result.status, 200);
  assert.equal(seen.path, '/api/settings?mode=write');
  assert.equal(seen.method, 'POST');
  assert.equal(seen.body, '{"model":"example"}');
  assert.equal(seen.headers.host, new URL(upstream).host);
  assert.equal(seen.headers['content-type'], 'application/json');
  for (const name of ['cookie', 'authorization', 'origin', 'referer', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-real-ip', 'x-api-key']) assert.equal(seen.headers[name], undefined, name);
  for (const name of ['set-cookie', 'x-internal-token', 'access-control-allow-origin']) assert.equal(result.headers[name], undefined, name);
  assert.equal(result.headers['x-frame-options'], 'SAMEORIGIN');
});

test('Signal media preserves Range and HEAD without buffering or changing response bytes', async t => {
  const seen = [];
  const upstream = await serve(t, (req, res) => {
    seen.push({ method: req.method, path: req.url, range: req.headers.range });
    res.writeHead(206, { 'Content-Type': 'video/mp4', 'Content-Length': '4', 'Content-Range': 'bytes 2-5/10', 'Accept-Ranges': 'bytes' });
    res.end(req.method === 'HEAD' ? undefined : '2345');
  });
  const base = await proxy(t, upstream);
  for (const method of ['GET', 'HEAD']) {
    const result = await request(base, prefix + 'runs/demo/video.mp4', { method, headers: { Cookie: cookie, Range: 'bytes=2-5' } });
    assert.equal(result.status, 206);
    assert.equal(result.headers['content-range'], 'bytes 2-5/10');
    assert.equal(result.headers['content-length'], '4');
    assert.equal(result.body, method === 'HEAD' ? '' : '2345');
  }
  assert.deepEqual(seen.map(x => x.path), ['/runs/demo/video.mp4', '/runs/demo/video.mp4']);
  assert.ok(seen.every(x => x.range === 'bytes=2-5'));
});

test('Signal rejects foreign origins, malformed paths and unsupported methods before upstream', async t => {
  let hits = 0;
  const upstream = await serve(t, (_req, res) => { hits++; res.end('unexpected'); });
  const base = await proxy(t, upstream);
  assert.equal((await request(base, prefix + 'api/settings', { method: 'POST', body: '{}', headers: { Cookie: cookie, Origin: 'https://foreign.example' } })).status, 403);
  assert.equal((await request(base, prefix + 'api/settings', { method: 'DELETE', headers: { Cookie: cookie } })).status, 405);
  for (const suffix of ['/foreign.example/api/state', '%5cprivate', '%00private', '%ZZ']) {
    assert.equal((await request(base, prefix + suffix, { headers: { Cookie: cookie } })).status, 400, suffix);
  }
  assert.equal((await request(base, '/integrations/ai-signal-extra/api/state', { headers: { Cookie: cookie } })).status, 404);
  assert.equal(hits, 0);
});

test('Signal canonical entry redirects locally only after authentication', async t => {
  const base = await proxy(t, 'http://127.0.0.1:1');
  assert.equal((await request(base, prefix.slice(0, -1))).status, 401);
  const response = await request(base, prefix.slice(0, -1) + '?view=topics', { headers: { Cookie: cookie } });
  assert.equal(response.status, 308);
  assert.equal(response.headers.location, prefix + '?view=topics');
});

test('Signal upstream failure, timeout and redirect return safe 502 responses', async t => {
  const unavailable = await proxy(t, 'http://127.0.0.1:1');
  assert.equal((await request(unavailable, prefix, { headers: { Cookie: cookie } })).status, 502);
  for (const status of [302, 503]) {
    const upstream = await serve(t, (_req, res) => {
      res.writeHead(status, { Location: 'http://internal.example/secret' }); res.end('private diagnostic');
    });
    const base = await proxy(t, upstream);
    const result = await request(base, prefix, { headers: { Cookie: cookie } });
    assert.equal(result.status, 502);
    assert.equal(result.headers.location, undefined);
    assert.doesNotMatch(result.body, /internal|secret|private|127\.0\.0\.1/);
  }
  const stalled = await serve(t, () => {});
  const timed = await proxy(t, stalled, { timeoutMs: 40 });
  assert.equal((await request(timed, prefix, { headers: { Cookie: cookie } })).status, 502);
});

test('Signal rejects unconfigured upstreams and oversized request bodies', async t => {
  const missing = await proxy(t, '');
  assert.equal((await request(missing, prefix, { headers: { Cookie: cookie } })).status, 503);
  let hits = 0;
  const upstream = await serve(t, (_req, res) => { hits++; res.end('unexpected'); });
  const base = await proxy(t, upstream, { maxBodyBytes: 8 });
  for (const headers of [{ 'Content-Length': '9' }, { 'Transfer-Encoding': 'chunked' }]) {
    const result = await request(base, prefix + 'api/settings', { method: 'POST', headers: { Cookie: cookie, ...headers }, body: '123456789' });
    assert.equal(result.status, 413);
  }
  assert.equal(hits, 0);
});

test('main server authenticates the Signal mount before static fallback and revokes access on logout', { timeout: 20_000 }, async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'signal-server-proxy-'));
  let hits = 0;
  const upstream = await serve(t, (req, res) => {
    hits++;
    if (req.url === '/api/health') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ ok: true, service: 'AI Signal Studio' })); }
    else if (req.url === '/api/state') { res.setHeader('Content-Type', 'application/json'); res.end('{"engine":"signal"}'); }
    else { res.setHeader('Content-Type', 'video/mp4'); res.end('media'); }
  });
  const available = createServer();
  await new Promise(resolve => available.listen(0, '127.0.0.1', resolve));
  const port = available.address().port;
  await new Promise(resolve => available.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: path.resolve(import.meta.dirname, '..'),
    env: {
      ...process.env, SERVER_HOST: '127.0.0.1', PORT: String(port), DATABASE_PATH: path.join(dir, 'test.db'),
      AUTH_ENABLED: 'true', ADMIN_USERNAME: auth.username, ADMIN_PASSWORD: 'test-only-password', SESSION_SECRET: auth.secret,
      LOCAL_AGENT_AUTO_START: 'false', AUTO_COLLECT_ENABLED: 'false', SMOKE_TEST_ENABLED: 'false',
      RAG_AUTO_START: 'false', QWEN_MODE: 'mock', RPA_MODE: 'simulated',
      AI_SIGNAL_STUDIO_URL: prefix, AI_SIGNAL_STUDIO_INTERNAL_URL: upstream, AI_SIGNAL_STUDIO_HEALTH_URL: upstream + '/api/health',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  t.after(async () => {
    if (child.exitCode === null) {
      child.kill();
      await new Promise(resolve => {
        const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 2000);
        child.once('exit', () => { clearTimeout(timer); resolve(); });
      });
    }
    await rm(dir, { recursive: true, force: true });
  });
  let ready = false;
  for (let attempt = 0; attempt < 80; attempt++) {
    if (child.exitCode !== null) throw new Error(`Main server exited: ${stderr}`);
    try { if ((await request(base, '/api/health')).status === 200) { ready = true; break; } } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(ready, `Main server startup failed: ${stderr}`);
  for (const suffix of ['', 'api/state', 'runs/demo/video.mp4']) assert.equal((await request(base, prefix + suffix)).status, 401);
  assert.equal(hits, 0);
  const login = await request(base, '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: auth.username, password: 'test-only-password' }) });
  assert.equal(login.status, 200);
  const session = login.headers['set-cookie'][0].split(';')[0];
  const headers = { Cookie: session };
  assert.equal((await request(base, prefix + 'api/state', { headers })).body, '{"engine":"signal"}');
  const media = await request(base, prefix + 'runs/demo/video.mp4', { headers });
  assert.equal(media.headers['content-type'], 'video/mp4');
  assert.equal(media.body, 'media');
  const status = JSON.parse((await request(base, '/api/creative-workbench/status', { headers })).body);
  assert.equal(status.services[0].url, prefix);
  assert.equal(status.services[0].online, true);
  assert.equal((await request(base, '/api/auth/logout', { method: 'POST', headers })).status, 200);
  assert.equal((await request(base, prefix + 'api/state', { headers })).status, 401);
});
