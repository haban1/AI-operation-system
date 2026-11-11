import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { chromium } from 'playwright-core';
import { createSessionRevocationStore, createSessionToken, parseCookies, revokeSessionToken, sessionCookie, verifySessionToken } from '../src/services/auth.js';
import { cleanupDir, jsonRequest, root, startServer, stopChild } from './helpers/runtime.js';

const credentials = { username: 'admin', secret: 'persistent-session-test-secret-at-least-32-characters' };
const password = 'Persistent-Admin-Password-2026!';
const runtimeEnv = { AUTH_ENABLED: 'true', ADMIN_USERNAME: credentials.username, ADMIN_PASSWORD: password, SESSION_SECRET: credentials.secret, SESSION_TTL_MS: '1' };
const cookiePair = header => String(header || '').split(';')[0];
const tokenFromCookie = cookie => parseCookies(cookie).tianhe_admin_session;
const cookieFromToken = token => cookiePair(sessionCookie(token));
const login = runtime => jsonRequest(runtime.base, '/api/auth/login', { method: 'POST', body: { username: credentials.username, password } });

// Advancing the verification clock exercises expiry without waiting in real time.
test('persistent admin login remains valid beyond the former 12-hour limit and after years', () => {
  const nowMs = Date.UTC(2026, 9, 22);
  const token = createSessionToken({ ...credentials, nowMs });
  for (const elapsed of [13 * 60 * 60 * 1000, 5 * 365 * 24 * 60 * 60 * 1000]) {
    const session = verifySessionToken(token, { ...credentials, nowMs: nowMs + elapsed });
    assert.equal(session?.sub, credentials.username);
    assert.equal(session.exp, null);
    assert.equal(session.persistent, true);
  }
  assert.match(sessionCookie(token), /HttpOnly; SameSite=Strict; Max-Age=34560000/);
  assert.match(sessionCookie(token, { secure: true }), /; Secure$/);
});

test('expired legacy sessions, tampering, and malformed cookies still require login', () => {
  const nowMs = Date.now();
  const expired = createSessionToken({ ...credentials, ttlMs: 1000, nowMs: nowMs - 1001 });
  const valid = createSessionToken(credentials);
  assert.equal(verifySessionToken(expired, { ...credentials, nowMs }), null);
  assert.equal(verifySessionToken(valid + '.extra', credentials), null);
  assert.equal(verifySessionToken(valid.slice(0, -4) + 'xxxx', credentials), null);
  assert.equal(verifySessionToken(valid, { ...credentials, username: 'someone-else' }), null);
  assert.equal(verifySessionToken(valid, { ...credentials, secret: 'different-secret' }), null);
  assert.equal(parseCookies('tianhe_admin_session=%invalid').tianhe_admin_session, '');
});

test('logout revokes both legacy and upgraded tokens sharing the same login', () => {
  const database = new DatabaseSync(':memory:');
  try {
    const revocationStore = createSessionRevocationStore(database);
    const options = { ...credentials, revocationStore };
    const legacy = createSessionToken({ ...credentials, ttlMs: 12 * 60 * 60 * 1000 });
    const session = verifySessionToken(legacy, options);
    const upgraded = createSessionToken({ ...credentials, nowMs: session.iat, nonce: session.nonce });
    assert.ok(verifySessionToken(upgraded, options));
    assert.equal(revokeSessionToken(upgraded, options), true);
    assert.equal(verifySessionToken(legacy, options), null);
    assert.equal(verifySessionToken(upgraded, options), null);
    assert.equal(revokeSessionToken('invalid', options), false);
    assert.equal(database.prepare('SELECT COUNT(*) AS n FROM admin_session_revocations').get().n, 1);
    assert.ok(verifySessionToken(createSessionToken(credentials), options));
  } finally { database.close(); }
});

test('a temporary session store failure is not mistaken for an expired login', () => {
  const token = createSessionToken(credentials);
  assert.throws(() => verifySessionToken(token, { ...credentials, revocationStore: { has() { throw new Error('database unavailable'); } } }), /database unavailable/);
});

test('HTTP login survives a service restart; manual logout and its revocation survive another restart', async t => {
  let runtime = await startServer({ env: runtimeEnv });
  const dir = runtime.dir;
  const port = runtime.port;
  t.after(async () => { await stopChild(runtime.child); cleanupDir(dir); });
  const signedIn = await login(runtime);
  assert.equal(signedIn.response.status, 200);
  const cookie = cookiePair(signedIn.response.headers.get('set-cookie'));
  assert.equal(verifySessionToken(tokenFromCookie(cookie), credentials)?.persistent, true);
  await stopChild(runtime.child);
  runtime = await startServer({ dir, port, env: runtimeEnv });
  const afterRestart = await jsonRequest(runtime.base, '/api/auth/session', { headers: { Cookie: cookie } });
  assert.equal(afterRestart.data.authenticated, true);
  assert.match(afterRestart.response.headers.get('set-cookie'), /Max-Age=34560000/);
  assert.equal((await jsonRequest(runtime.base, '/api/accounts', { headers: { Cookie: cookie } })).response.status, 200);
  const logout = await jsonRequest(runtime.base, '/api/auth/logout', { method: 'POST', headers: { Cookie: cookie }, body: {} });
  assert.equal(logout.response.status, 200);
  assert.match(logout.response.headers.get('set-cookie'), /Max-Age=0/);
  await stopChild(runtime.child);
  runtime = await startServer({ dir, port, env: runtimeEnv });
  assert.equal((await jsonRequest(runtime.base, '/api/auth/session', { headers: { Cookie: cookie } })).data.authenticated, false);
  assert.equal((await jsonRequest(runtime.base, '/api/accounts', { headers: { Cookie: cookie } })).response.status, 401);
  assert.equal((await login(runtime)).response.status, 200);
});

test('a valid existing login upgrades without signing in again, and logout also rejects its original cookie', async t => {
  const runtime = await startServer({ env: runtimeEnv });
  t.after(async () => { await stopChild(runtime.child); cleanupDir(runtime.dir); });
  const legacy = createSessionToken({ ...credentials, ttlMs: 12 * 60 * 60 * 1000 });
  const oldCookie = cookieFromToken(legacy);
  const session = await jsonRequest(runtime.base, '/api/auth/session', { headers: { Cookie: oldCookie } });
  assert.equal(session.data.authenticated, true);
  const upgradedCookie = cookiePair(session.response.headers.get('set-cookie'));
  assert.equal(verifySessionToken(tokenFromCookie(upgradedCookie), credentials)?.persistent, true);
  assert.equal((await jsonRequest(runtime.base, '/api/accounts', { headers: { Cookie: oldCookie } })).response.status, 200);
  await jsonRequest(runtime.base, '/api/auth/logout', { method: 'POST', headers: { Cookie: upgradedCookie }, body: {} });
  for (const cookie of [oldCookie, upgradedCookie]) {
    assert.equal((await jsonRequest(runtime.base, '/api/accounts', { headers: { Cookie: cookie } })).response.status, 401);
  }
  const expiredCookie = cookieFromToken(createSessionToken({ ...credentials, ttlMs: 1000, nowMs: Date.now() - 2000 }));
  const expiredSession = await jsonRequest(runtime.base, '/api/auth/session', { headers: { Cookie: expiredCookie } });
  assert.equal(expiredSession.data.authenticated, false);
  assert.equal(expiredSession.response.headers.get('set-cookie'), null);
});

const chrome = [process.env.CHROME_EXECUTABLE_PATH, path.join(root, 'runtime/browser/chrome.exe'), 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe', '/usr/bin/chromium', '/usr/bin/google-chrome'].filter(Boolean).find(file => fs.existsSync(file));
test('browser close and reopen preserves login; the logout button clears it and a failed logout stays signed in', { skip: !chrome }, async t => {
  const runtime = await startServer({ env: runtimeEnv });
  let context;
  t.after(async () => { if (context) await context.close(); await stopChild(runtime.child); cleanupDir(runtime.dir); });
  const profile = path.join(runtime.dir, 'admin-browser-profile');
  const options = { headless: true, executablePath: chrome, viewport: { width: 1366, height: 900 } };
  context = await chromium.launchPersistentContext(profile, options);
  let page = await context.newPage();
  await page.goto(runtime.base);
  await page.locator('#loginForm input[name="username"]').fill(credentials.username);
  await page.locator('#loginForm input[name="password"]').fill(password);
  await page.locator('#loginSubmit').click();
  await page.locator('#logoutBtn').waitFor({ state: 'visible' });
  const originalToken = (await context.cookies(runtime.base)).find(cookie => cookie.name === 'tianhe_admin_session');
  assert.ok(originalToken.expires * 1000 > Date.now() + 390 * 24 * 60 * 60 * 1000);
  await context.close();
  context = await chromium.launchPersistentContext(profile, options);
  page = await context.newPage();
  await page.route('**/app.js*', async route => {
    const response = await route.fetch();
    await route.fulfill({ response, body: (await response.text()) + '\nwindow.__testAdminApi = api;' });
  });
  await page.goto(runtime.base);
  await page.locator('#logoutBtn').waitFor({ state: 'visible' });
  await page.route('**/api/session-persistence-probe', route => route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ ok: false, code: 'AGENT_AUTH_REQUIRED', message: 'module login unavailable' }) }));
  const moduleError = await page.evaluate(async () => {
    try { await window.__testAdminApi('/api/session-persistence-probe'); }
    catch (error) { return error.code; }
  });
  assert.equal(moduleError, 'AGENT_AUTH_REQUIRED');
  assert.equal(await page.locator('#loginScreen').isVisible(), false, 'A module login error must not log out the administrator');
  await page.unroute('**/api/session-persistence-probe');
  assert.equal(await page.locator('#loginScreen').isVisible(), false);
  await page.route('**/api/auth/logout', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ ok: false, message: 'temporary failure' }) }));
  await page.locator('#logoutBtn').click();
  await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('temporary failure'));
  assert.equal(await page.locator('#loginScreen').isVisible(), false);
  await page.unroute('**/api/auth/logout');
  await page.locator('#logoutBtn').click();
  await page.locator('#loginScreen').waitFor({ state: 'visible' });
  await page.reload();
  await page.locator('#loginScreen').waitFor({ state: 'visible' });
  assert.equal((await jsonRequest(runtime.base, '/api/accounts', { headers: { Cookie: `tianhe_admin_session=${originalToken.value}` } })).response.status, 401);
});
