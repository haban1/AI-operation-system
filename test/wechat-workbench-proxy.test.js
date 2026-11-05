import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { gzipSync } from 'node:zlib';
import { createWechatWorkbenchProxy, isWechatWorkbenchPath } from '../src/services/wechat-workbench-proxy.js';

const prefix = '/wechat-workbench/';
const browserCookie = 'tianhe_admin_session=test-only';
const loginToken = 'test-only-server-login';

async function serve(t, handler) {
  const instance = createServer((req, res) => Promise.resolve(handler(req, res)).catch(error => {
    res.writeHead(500); res.end(error.message);
  }));
  await new Promise((resolve, reject) => { instance.once('error', reject); instance.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise(resolve => { instance.close(resolve); instance.closeAllConnections(); }));
  return `http://127.0.0.1:${instance.address().port}`;
}

async function proxy(t, upstreamUrl, options = {}) {
  const handle = createWechatWorkbenchProxy({ upstreamUrl, loginToken, authorize: req => req.headers.cookie === browserCookie, ...options });
  return serve(t, (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (isWechatWorkbenchPath(url.pathname)) return handle(req, res, url);
    res.writeHead(404); res.end();
  });
}

function request(base, path = prefix, { method = 'GET', headers = {}, body = '', authenticated = true } = {}) {
  return new Promise((resolve, reject) => {
    if (body.length && !Object.keys(headers).some(name => ['content-length', 'transfer-encoding'].includes(name.toLowerCase()))) headers = { ...headers, 'Content-Length': Buffer.byteLength(body) };
    const req = httpRequest(base, { path, method, headers: { ...(authenticated ? { Cookie: browserCookie } : {}), ...headers } }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.once('error', reject);
      res.once('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.once('error', reject);
    req.end(body);
  });
}

async function bytes(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function json(res, value, status = 200, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(value));
}

async function robot(t, handler, options = {}) {
  const logins = [];
  const hits = [];
  const upstream = await serve(t, async (req, res) => {
    if (req.url === '/api/v1/login') {
      logins.push({ headers: req.headers, body: JSON.parse((await bytes(req)).toString()) });
      if (options.login) return options.login(req, res, logins.length);
      return json(res, { code: 200, data: { success: true } }, 200, { 'Set-Cookie': `session=server-${logins.length}; HttpOnly; Path=/` });
    }
    hits.push({ path: req.url, method: req.method, headers: req.headers, body: await bytes(req) });
    return handler(req, res, hits.at(-1), hits.length);
  });
  return { upstream, logins, hits };
}

test('WeChat page, assets, API and canonical mount all require Tianhe authentication', async t => {
  const fixture = await robot(t, (_req, res) => res.end('private'));
  const base = await proxy(t, fixture.upstream);
  for (const path of [prefix.slice(0, -1), prefix, prefix + 'static/js/app.js', prefix + 'api/v1/support?id=3']) {
    assert.equal((await request(base, path, { authenticated: false })).status, 401);
    assert.equal((await request(base, path, { headers: { Cookie: 'invalid' } })).status, 401);
  }
  assert.equal(fixture.hits.length, 0);
  assert.equal(fixture.logins.length, 0);
  const canonical = await request(base, prefix.slice(0, -1) + '?view=chat');
  assert.equal(canonical.status, 308);
  assert.equal(canonical.headers.location, prefix + '?view=chat');
  assert.equal((await request(base, '/wechat-workbench-extra/')).status, 404);
});

test('Concurrent APIs share one server login, isolate credentials, and reject access after Tianhe logout', async t => {
  const fixture = await robot(t, (_req, res) => json(res, { code: 200, data: 'ok' }, 200, {
    'Set-Cookie': 'session=server-1; HttpOnly', 'X-Internal-Token': 'private', 'Access-Control-Allow-Origin': '*',
  }));
  let authorized = true;
  const base = await proxy(t, fixture.upstream, { authorize: req => authorized && req.headers.cookie === browserCookie });
  const results = await Promise.all(Array.from({ length: 6 }, () => request(base, prefix + 'api/v1/contact/list?id=3', { headers: {
    Authorization: 'Bearer browser-secret', 'X-API-Token': 'browser-token', 'X-Real-IP': '203.0.113.5',
    'X-Forwarded-Host': 'foreign.example', 'X-Forwarded-Proto': 'https', 'X-Forwarded-For': '203.0.113.6',
    'X-Api-Key': 'private-browser-key', Origin: base, Referer: base + '/private',
  } })));
  assert.ok(results.every(value => value.status === 200));
  assert.equal(fixture.logins.length, 1);
  assert.deepEqual(fixture.logins[0].body, { token: loginToken });
  assert.equal(fixture.logins[0].headers.cookie, undefined);
  for (const hit of fixture.hits) {
    assert.equal(hit.headers.cookie, 'session=server-1');
    for (const name of ['authorization', 'x-api-token', 'x-real-ip', 'x-forwarded-host', 'x-forwarded-proto', 'x-forwarded-for', 'x-api-key', 'origin', 'referer']) assert.equal(hit.headers[name], undefined, name);
    assert.equal(hit.headers.host, new URL(fixture.upstream).host);
  }
  for (const result of results) {
    for (const name of ['set-cookie', 'x-internal-token', 'access-control-allow-origin']) assert.equal(result.headers[name], undefined, name);
    assert.equal(result.headers['cache-control'], 'no-store');
    assert.equal(result.headers['x-frame-options'], 'SAMEORIGIN');
    assert.doesNotMatch(result.body.toString(), /server-1|browser-secret|test-only-server-login/);
  }
  authorized = false;
  assert.equal((await request(base, prefix + 'api/v1/contact/list?id=3')).status, 401);
  assert.equal(fixture.hits.length, 6);
});

test('Static assets do not log into the robot or forward either session', async t => {
  const fixture = await robot(t, (_req, res) => res.end('asset'));
  const base = await proxy(t, fixture.upstream);
  assert.equal((await request(base, prefix + 'static/app.js')).body.toString(), 'asset');
  assert.equal(fixture.logins.length, 0);
  assert.equal(fixture.hits[0].headers.cookie, undefined);
});

test('External origins, unsafe paths, credential queries and standalone auth endpoints are denied before upstream', async t => {
  const fixture = await robot(t, (_req, res) => res.end('unexpected'));
  const base = await proxy(t, fixture.upstream);
  for (const headers of [{ Origin: 'https://foreign.example' }, { 'Sec-Fetch-Site': 'cross-site' }, { Origin: base + '/path' }]) {
    assert.equal((await request(base, prefix + 'api/v1/support?id=3', { headers })).status, 403);
  }
  for (const suffix of ['%2e%2e/private', '%252e%252e/private', '%5cprivate', '%00private', '%7fprivate', '%ZZ', '/foreign.example/api/v1/support']) {
    const handle = createWechatWorkbenchProxy({ upstreamUrl: fixture.upstream, loginToken, authorize: () => true });
    // Dispatch directly so URL normalization in a production router cannot hide traversal tests.
    const rawBase = await serve(t, (req, res) => handle(req, res, new URL(prefix, 'http://local')));
    assert.equal((await request(rawBase, prefix + suffix)).status, 400, suffix);
  }
  for (const suffix of ['api/other', 'api/v1/login', 'api/v1/oauth/wechat', 'api/v1/oauth/official-account/url', 'api/v1/user/logout', 'api/v1/user/api-token/refresh']) {
    assert.equal((await request(base, prefix + suffix, { method: 'POST' })).status, 403, suffix);
  }
  for (const query of ['api_token=secret', 'token=secret', 'access_token=secret', 'API_TOKEN=secret']) {
    assert.equal((await request(base, prefix + 'api/v1/support?' + query)).status, 400);
  }
  assert.equal((await request(base, prefix, { method: 'OPTIONS' })).status, 405);
  assert.equal(fixture.logins.length + fixture.hits.length, 0);
});

test('Encoded path delimiters cannot inject an unvalidated credential query upstream', async t => {
  const fixture = await robot(t, (_req, res) => json(res, { code: 200 }));
  const base = await proxy(t, fixture.upstream);
  assert.equal((await request(base, prefix + 'api/v1/contact%3Fapi_token=hidden%23fragment')).status, 200);
  assert.equal(fixture.hits[0].path, '/api/v1/contact%3Fapi_token%3Dhidden%23fragment');
});

test('HTTP and Gin JSON 401 expire the robot session and retry a GET once', async t => {
  for (const mode of ['http', 'json']) {
    const fixture = await robot(t, (req, res) => {
      if (req.headers.cookie === 'session=server-1') return json(res, { code: 401, message: 'expired' }, mode === 'http' ? 401 : 200);
      json(res, { code: 200, data: 'refreshed' });
    });
    const base = await proxy(t, fixture.upstream);
    const result = await request(base, prefix + 'api/v1/contact/list?id=3');
    assert.equal(result.status, 200, mode);
    assert.equal(JSON.parse(result.body).data, 'refreshed');
    assert.equal(fixture.logins.length, 2);
    assert.equal(fixture.hits.length, 2);
  }
});

test('Repeated 401 stops after one GET retry and never replays mutation or side-effect GET requests', async t => {
  const fixture = await robot(t, (_req, res) => json(res, { code: 401, message: 'expired' }));
  const base = await proxy(t, fixture.upstream);
  assert.equal((await request(base, prefix + 'api/v1/contact/list?id=3')).status, 503);
  assert.equal(fixture.logins.length, 2);
  assert.equal(fixture.hits.length, 2);
  for (const [method, path] of [['POST', 'support/broadcasts'], ['PUT', 'robot/update'], ['PATCH', 'settings'], ['DELETE', 'contact/friend'], ['GET', 'robot/docker/image/pull'], ['GET', 'robot/login/slider-verify-submit']]) {
    const before = fixture.hits.length;
    assert.equal((await request(base, prefix + 'api/v1/' + path + '?id=3', { method, body: method === 'GET' ? '' : '{}' })).status, 503);
    assert.equal(fixture.hits.length, before + 1, method + ' ' + path);
  }
});

test('Account API tokens are removed from self and settings, including compressed responses', async t => {
  const fixture = await robot(t, (_req, res) => {
    const body = gzipSync(JSON.stringify({ code: 200, data: { id: 3, api_token: 'never-leak', api_token_enabled: true, chat_api_key: 'business-setting' } }));
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip', 'Content-Length': body.length });
    res.end(body);
  });
  const base = await proxy(t, fixture.upstream);
  for (const suffix of ['user/self', 'system-settings?id=3']) {
    const result = await request(base, prefix + 'api/v1/' + suffix);
    assert.equal(result.status, 200);
    const body = JSON.parse(result.body);
    assert.equal(body.data.api_token, undefined);
    assert.equal(body.data.api_token_enabled, true);
    assert.equal(body.data.chat_api_key, 'business-setting');
    assert.equal(result.headers['content-encoding'], undefined);
    assert.doesNotMatch(result.body.toString(), /never-leak/);
    if (result.headers['content-length']) assert.equal(Number(result.headers['content-length']), result.body.length);
  }
});

test('Multipart uploads preserve exact bytes and do not repeat group-send submissions', async t => {
  const fixture = await robot(t, (_req, res) => json(res, { code: 200, data: { id: 'broadcast-one' } }));
  const base = await proxy(t, fixture.upstream);
  const boundary = 'test-only-boundary';
  const body = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="a.png"\r\nContent-Type: image/png\r\n\r\n`), Buffer.from([0, 255, 13, 10, 72, 128]), Buffer.from(`\r\n--${boundary}--\r\n`)]);
  const result = await request(base, prefix + 'api/v1/support/broadcasts?id=3', { method: 'POST', body, headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` } });
  assert.equal(result.status, 200);
  assert.equal(fixture.hits.length, 1);
  assert.deepEqual(fixture.hits[0].body, body);
  assert.equal(fixture.hits[0].headers['content-type'], `multipart/form-data; boundary=${boundary}`);
  assert.equal(Number(fixture.hits[0].headers['content-length']), body.length);
});

test('Range and HEAD media responses preserve headers and bytes', async t => {
  const fixture = await robot(t, (req, res) => {
    res.writeHead(206, { 'Content-Type': 'image/png', 'Content-Length': '4', 'Content-Range': 'bytes 2-5/10', 'Accept-Ranges': 'bytes' });
    res.end(req.method === 'HEAD' ? undefined : Buffer.from([0, 255, 10, 128]));
  });
  const base = await proxy(t, fixture.upstream);
  for (const method of ['GET', 'HEAD']) {
    const result = await request(base, prefix + 'api/v1/support/broadcasts/image?id=3&position=0', { method, headers: { Range: 'bytes=2-5', 'If-Range': 'test-etag' } });
    assert.equal(result.status, 206);
    assert.equal(result.headers['content-range'], 'bytes 2-5/10');
    assert.equal(result.headers['content-length'], '4');
    assert.deepEqual(result.body, method === 'HEAD' ? Buffer.alloc(0) : Buffer.from([0, 255, 10, 128]));
    assert.equal(fixture.hits.at(-1).headers.range, 'bytes=2-5');
    assert.equal(fixture.hits.at(-1).headers['if-range'], 'test-etag');
  }
});

test('Unconfigured upstreams, invalid addresses and oversize bodies fail before login', async t => {
  for (const upstream of ['', 'javascript:alert(1)', 'http://user:pass@localhost', 'http://localhost/path', 'http://localhost/?secret=1']) {
    assert.equal((await request(await proxy(t, upstream))).status, 503, upstream);
  }
  assert.equal((await request(await proxy(t, 'http://localhost', { loginToken: '' }))).status, 503);
  const fixture = await robot(t, (_req, res) => res.end('unexpected'));
  const base = await proxy(t, fixture.upstream, { maxBodyBytes: 8 });
  for (const headers of [{ 'Content-Length': '9' }, { 'Transfer-Encoding': 'chunked' }]) {
    assert.equal((await request(base, prefix + 'api/v1/support/broadcasts?id=3', { method: 'POST', headers, body: '123456789' })).status, 413);
  }
  assert.equal(fixture.logins.length + fixture.hits.length, 0);
});

test('Login denial, missing session, invalid JSON, interrupted login and timeouts return safe errors', async t => {
  for (const login of [
    (_req, res) => json(res, { code: 500, message: 'private-login-detail' }),
    (_req, res) => json(res, { code: 200, data: { success: true } }),
    (_req, res) => res.end('private-invalid-json'),
    (_req, res) => { res.writeHead(200, { 'Content-Length': 100 }); res.write('{'); res.destroy(); },
    () => {},
  ]) {
    const fixture = await robot(t, (_req, res) => res.end('unexpected'), { login });
    const base = await proxy(t, fixture.upstream, { timeoutMs: 40 });
    const result = await request(base, prefix + 'api/v1/user/self');
    assert.equal(result.status, 502);
    assert.doesNotMatch(result.body.toString(), /private|test-only|session=/);
    assert.equal(fixture.hits.length, 0);
  }
});

test('Upstream connection, redirects, errors and timeouts return safe errors without replay', async t => {
  assert.equal((await request(await proxy(t, 'http://127.0.0.1:1'))).status, 502);
  for (const handler of [
    (_req, res) => { res.writeHead(302, { Location: 'http://private/secret' }); res.end('private'); },
    (_req, res) => { res.writeHead(503); res.end('private-diagnostic'); },
    () => {},
  ]) {
    const fixture = await robot(t, handler);
    const base = await proxy(t, fixture.upstream, { timeoutMs: 40 });
    const result = await request(base, prefix + 'api/v1/contact/list?id=3');
    assert.equal(result.status, 502);
    assert.equal(result.headers.location, undefined);
    assert.doesNotMatch(result.body.toString(), /private|secret|test-only|session=/);
    assert.equal(fixture.hits.length, 1);
  }
});
