import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { cleanupDir, jsonRequest, startServer, stopChild } from './helpers/runtime.js';

function cookiePair(setCookie) {
  return String(setCookie || '').split(';')[0];
}

test('管理员 Cookie、Agent Token、CORS 和请求体安全策略有效', async t => {
  const adminPassword = 'Test-Admin-Password-2026!';
  const agentToken = 'test-agent-token-2026-very-secret';
  const allowedOrigin = 'http://127.0.0.1:3100';
  const runtime = await startServer({ env: {
    AUTH_ENABLED: 'true',
    ADMIN_USERNAME: 'admin',
    ADMIN_PASSWORD: adminPassword,
    SESSION_SECRET: 'test-session-secret-with-at-least-32-characters',
    AGENT_SHARED_TOKEN: agentToken,
    ALLOWED_ORIGINS: `${allowedOrigin},http://localhost:3100`,
    REQUEST_BODY_MAX_BYTES: '65536',
    MINI_PROGRAM_API_ENABLED: 'true',
    MINI_PROGRAM_APP_ID: 'security-test-app',
    MINI_PROGRAM_SHARED_SECRET: 'security-test-mini-program-secret-at-least-32-characters',
    MINI_PROGRAM_CALLBACK_URL: ''
  } });
  t.after(async () => { await stopChild(runtime.child); cleanupDir(runtime.dir); });

  const health = await jsonRequest(runtime.base, '/api/health');
  assert.equal(health.response.status, 200);

  const sessionBefore = await jsonRequest(runtime.base, '/api/auth/session');
  assert.equal(sessionBefore.response.status, 200);
  assert.equal(sessionBefore.data.authenticated, false);
  assert.equal(sessionBefore.data.authEnabled, true);

  const unauthenticated = await jsonRequest(runtime.base, '/api/bootstrap');
  assert.equal(unauthenticated.response.status, 401);
  assert.equal(unauthenticated.data.code, 'AUTH_REQUIRED');
  const unauthenticatedHandoffs = await jsonRequest(runtime.base, '/api/manual-handoffs');
  assert.equal(unauthenticatedHandoffs.response.status, 401);
  assert.equal(unauthenticatedHandoffs.data.code, 'AUTH_REQUIRED');
  const miniProgramStatus = await jsonRequest(runtime.base, '/api/mini-program/status');
  assert.equal(miniProgramStatus.response.status, 401);
  assert.equal(miniProgramStatus.data.code, 'AUTH_REQUIRED');

  const deniedOrigin = await jsonRequest(runtime.base, '/api/health', { headers: { Origin: 'https://evil.example' } });
  assert.equal(deniedOrigin.response.status, 403);
  assert.equal(deniedOrigin.data.code, 'CORS_ORIGIN_DENIED');
  assert.equal(deniedOrigin.response.headers.get('access-control-allow-origin'), null);

  const acceptedOrigin = await jsonRequest(runtime.base, '/api/health', { headers: { Origin: allowedOrigin } });
  assert.equal(acceptedOrigin.response.status, 200);
  assert.equal(acceptedOrigin.response.headers.get('access-control-allow-origin'), allowedOrigin);
  assert.equal(acceptedOrigin.response.headers.get('access-control-allow-credentials'), 'true');
  const preflight = await jsonRequest(runtime.base, '/api/health', { method: 'OPTIONS', headers: { Origin: allowedOrigin } });
  const allowedHeaders = preflight.response.headers.get('access-control-allow-headers').toLowerCase().split(',').map(value => value.trim());
  for (const header of ['x-mini-app-id', 'x-timestamp', 'x-nonce', 'x-signature']) assert.ok(allowedHeaders.includes(header));

  const sameOrigin = await jsonRequest(runtime.base, '/app.js', { headers: { Origin: runtime.base } });
  assert.equal(sameOrigin.response.status, 200);
  assert.equal(sameOrigin.response.headers.get('access-control-allow-origin'), runtime.base);
  assert.equal(sameOrigin.response.headers.get('access-control-allow-credentials'), 'true');

  const wrongLogin = await jsonRequest(runtime.base, '/api/auth/login', { method: 'POST', body: { username: 'admin', password: 'wrong' } });
  assert.equal(wrongLogin.response.status, 401);
  assert.equal(wrongLogin.data.code, 'INVALID_CREDENTIALS');

  const nonJson = await jsonRequest(runtime.base, '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'username=admin'
  });
  assert.equal(nonJson.response.status, 415);
  assert.equal(nonJson.data.code, 'JSON_CONTENT_TYPE_REQUIRED');

  const invalidJson = await jsonRequest(runtime.base, '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{not-valid-json'
  });
  assert.equal(invalidJson.response.status, 400);
  assert.equal(invalidJson.data.code, 'INVALID_JSON');

  const oversized = await jsonRequest(runtime.base, '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'x'.repeat(70_000) })
  });
  assert.equal(oversized.response.status, 413);
  assert.equal(oversized.data.code, 'REQUEST_BODY_TOO_LARGE');
  assert.equal('stack' in oversized.data, false);

  const login = await jsonRequest(runtime.base, '/api/auth/login', { method: 'POST', body: { username: 'admin', password: adminPassword } });
  assert.equal(login.response.status, 200);
  const cookie = cookiePair(login.response.headers.get('set-cookie'));
  assert.match(cookie, /^tianhe_admin_session=/);
  assert.match(login.response.headers.get('set-cookie'), /HttpOnly/);
  assert.match(login.response.headers.get('set-cookie'), /SameSite=Strict/);
  const cookieCannotSign = await jsonRequest(runtime.base, '/open-api/v1/mini-program/messages', {
    method: 'POST', headers: { Cookie: cookie },
    body: { appId: 'security-test-app', conversationId: 'c-1', messageId: 'm-1', userId: 'u-1', text: 'hello', sentAt: new Date().toISOString() }
  });
  assert.equal(cookieCannotSign.response.status, 401);
  assert.equal(cookieCannotSign.data.code, 'MINI_PROGRAM_AUTH_INVALID');
  const signedBody = JSON.stringify({ appId: 'security-test-app', conversationId: 'signed-c-1', messageId: 'signed-m-1', userId: 'signed-u-1', text: 'hello', sentAt: new Date().toISOString() });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = crypto.randomUUID();
  const canonical = ['POST', '/open-api/v1/mini-program/messages', timestamp, nonce, crypto.createHash('sha256').update(Buffer.from(signedBody)).digest('hex')].join('\n');
  const signature = crypto.createHmac('sha256', 'security-test-mini-program-secret-at-least-32-characters').update(canonical).digest('hex');
  const signedWithoutCookie = await jsonRequest(runtime.base, '/open-api/v1/mini-program/messages', {
    method: 'POST', body: signedBody, headers: { 'Content-Type': 'application/json', 'X-Mini-App-Id': 'security-test-app', 'X-Timestamp': timestamp, 'X-Nonce': nonce, 'X-Signature': signature }
  });
  assert.equal(signedWithoutCookie.response.status, 202);
  const hmacCannotAuthorizeAdmin = await jsonRequest(runtime.base, '/api/mini-program/status', {
    headers: { 'X-Mini-App-Id': 'security-test-app', 'X-Timestamp': String(Math.floor(Date.now() / 1000)), 'X-Nonce': 'admin-probe', 'X-Signature': '0'.repeat(64) }
  });
  assert.equal(hmacCannotAuthorizeAdmin.response.status, 401);
  assert.equal(hmacCannotAuthorizeAdmin.data.code, 'AUTH_REQUIRED');

  const authenticated = await jsonRequest(runtime.base, '/api/bootstrap', { headers: { Cookie: cookie } });
  assert.equal(authenticated.response.status, 200);
  assert.equal(Object.hasOwn(authenticated.data.config, 'localAgentToken'), false);
  assert.equal(authenticated.data.config.localAgentBaseUrl, '/api/local-agent');
  assert.equal(JSON.stringify(authenticated.data).includes(agentToken), false);
  const authenticatedHandoffs = await jsonRequest(runtime.base, '/api/manual-handoffs', { headers: { Cookie: cookie } });
  assert.equal(authenticatedHandoffs.response.status, 200);
  assert.ok(Array.isArray(authenticatedHandoffs.data.handoffs));

  const noAgentToken = await jsonRequest(runtime.base, '/api/agent/heartbeat', { method: 'POST', body: { deviceId: 'device-rpa-01' } });
  assert.equal(noAgentToken.response.status, 401);
  assert.equal(noAgentToken.data.code, 'AGENT_AUTH_REQUIRED');

  const validAgentToken = await jsonRequest(runtime.base, '/api/agent/heartbeat', {
    method: 'POST', headers: { Authorization: `Bearer ${agentToken}` }, body: { deviceId: 'device-rpa-01', agentVersion: 'security-test' }
  });
  assert.equal(validAgentToken.response.status, 200);

  const adminAccountsWithoutCookie = await jsonRequest(runtime.base, '/api/accounts');
  assert.equal(adminAccountsWithoutCookie.response.status, 401);
  assert.equal(adminAccountsWithoutCookie.data.code, 'AUTH_REQUIRED');

  const agentAccountsWithoutToken = await jsonRequest(runtime.base, '/api/agent/accounts');
  assert.equal(agentAccountsWithoutToken.response.status, 401);
  assert.equal(agentAccountsWithoutToken.data.code, 'AGENT_AUTH_REQUIRED');

  const agentAccounts = await jsonRequest(runtime.base, '/api/agent/accounts', {
    headers: { Authorization: `Bearer ${agentToken}` }
  });
  assert.equal(agentAccounts.response.status, 200);
  const douyinAccount = agentAccounts.data.accounts.find(item => item.platform_code === 'douyin');
  assert.ok(douyinAccount);

  const loginStateSync = await jsonRequest(runtime.base, `/api/agent/accounts/${douyinAccount.id}/login-state`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${agentToken}` },
    body: {
      state: 'READY',
      checkedAt: new Date().toISOString(),
      message: 'Agent 专用接口同步成功',
      url: 'https://creator.douyin.com/creator-micro/content/upload',
      evidence: ['authenticated-url'],
      confidence: 'CONFIRMED',
      confirmedSamples: 1,
      checkMode: 'POLL'
    }
  });
  assert.equal(loginStateSync.response.status, 200);
  assert.equal(loginStateSync.data.account.login_status, 'READY');
  assert.equal(loginStateSync.data.account.login_source, 'LOCAL_AGENT');

  const adminAccounts = await jsonRequest(runtime.base, '/api/accounts', { headers: { Cookie: cookie } });
  assert.equal(adminAccounts.response.status, 200);

  const logout = await jsonRequest(runtime.base, '/api/auth/logout', { method: 'POST', headers: { Cookie: cookie }, body: {} });
  assert.equal(logout.response.status, 200);
  assert.match(logout.response.headers.get('set-cookie'), /Max-Age=0/);

  const replayAfterLogout = await jsonRequest(runtime.base, '/api/bootstrap', { headers: { Cookie: cookie } });
  assert.equal(replayAfterLogout.response.status, 401);
  const sessionAfter = await jsonRequest(runtime.base, '/api/auth/session', { headers: { Cookie: cookie } });
  assert.equal(sessionAfter.data.authenticated, false);
});
