import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

function request(base, pathname, { method = 'GET', headers = {}, body = '' } = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(base, { path: pathname, method, headers }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.once('error', reject);
      res.once('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.once('error', reject);
    req.end(body);
  });
}

test('Main server protects WeChat HTML, static assets and APIs with the Tianhe session, including after logout', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'wechat-workbench-server-'));
  let hits = 0;
  let logins = 0;
  let browserSession;
  const upstream = createServer(async (req, res) => {
    hits++;
    if (req.url === '/api/v1/login') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      assert.equal(req.method, 'POST');
      assert.deepEqual(JSON.parse(Buffer.concat(chunks)), { token: 'test-only-robot-login-token' });
      assert.equal(req.headers.cookie, undefined);
      logins++;
      res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': 'session=server-only-robot-session; HttpOnly; Path=/' });
      return res.end('{"code":200,"data":{"success":true}}');
    }
    if (req.url === '/api/v1/user/self') {
      assert.equal(req.headers.cookie, 'session=server-only-robot-session');
      assert.ok(!req.headers.cookie.includes(browserSession));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end('{"code":200,"data":{"id":1,"display_name":"测试微信管理员","api_token":"must-not-reach-browser"}}');
    }
    if (req.url === '/static/js/app.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript' });
      return res.end('window.wechatEmbedded = true;');
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><div id="root">微信助手</div>');
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { upstream.close(resolve); upstream.closeAllConnections(); }));
  const available = createServer();
  await new Promise(resolve => available.listen(0, '127.0.0.1', resolve));
  const port = available.address().port;
  await new Promise(resolve => available.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: path.resolve(import.meta.dirname, '..'),
    env: {
      ...process.env, TIANHE_SKIP_DOTENV: 'true', NODE_ENV: 'test', SERVER_HOST: '127.0.0.1', PORT: String(port),
      DATABASE_PATH: path.join(dir, 'test.db'), AUTH_ENABLED: 'true', ADMIN_USERNAME: 'wechat-integration-test',
      ADMIN_PASSWORD: 'test-only-tianhe-password', SESSION_SECRET: 'test-only-tianhe-session-secret',
      LOCAL_AGENT_AUTO_START: 'false', AUTO_COLLECT_ENABLED: 'false', SMOKE_TEST_ENABLED: 'false',
      RAG_AUTO_START: 'false', QWEN_MODE: 'mock', RPA_MODE: 'simulated', RAG_BASE_URL: '',
      WECHAT_ROBOT_ADMIN_INTERNAL_URL: `http://127.0.0.1:${upstream.address().port}`,
      WECHAT_ROBOT_ADMIN_LOGIN_TOKEN: 'test-only-robot-login-token',
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
  const paths = ['/wechat-workbench/', '/wechat-workbench/static/js/app.js', '/wechat-workbench/api/v1/user/self', '/api/wechat/robot-admin'];
  for (const pathname of paths) assert.equal((await request(base, pathname)).status, 401, pathname);
  assert.equal(hits, 0);
  const login = await request(base, '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'wechat-integration-test', password: 'test-only-tianhe-password' }),
  });
  assert.equal(login.status, 200);
  browserSession = login.headers['set-cookie'][0].split(';')[0];
  const headers = { Cookie: browserSession };
  const embeddedConfig = await request(base, '/api/wechat/robot-admin', { headers });
  assert.deepEqual(JSON.parse(embeddedConfig.body), { url: '/wechat-workbench/', embedded: true });
  assert.match((await request(base, paths[0], { headers })).body, /微信助手/);
  assert.equal((await request(base, paths[1], { headers })).body, 'window.wechatEmbedded = true;');
  const self = await request(base, paths[2], { headers });
  assert.equal(self.status, 200);
  assert.equal(JSON.parse(self.body).data.display_name, '测试微信管理员');
  assert.doesNotMatch(self.body, /api_token|server-only-robot-session|must-not-reach-browser|test-only-robot-login-token/);
  assert.ok(!JSON.stringify(self.headers).includes('server-only-robot-session'));
  assert.equal(logins, 1);
  const previousHits = hits;
  assert.equal((await request(base, '/api/auth/logout', { method: 'POST', headers })).status, 200);
  for (const pathname of paths) assert.equal((await request(base, pathname, { headers })).status, 401, pathname);
  assert.equal(hits, previousHits);
});
