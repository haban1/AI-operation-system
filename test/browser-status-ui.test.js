import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { startServer, stopChild, cleanupDir } from './helpers/runtime.js';

const chrome = [
  process.env.CHROME_EXECUTABLE_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/chromium'
].filter(Boolean).find(file => fs.existsSync(file));
const candidatePublic = process.env.BROWSER_UI_CANDIDATE_DIR ? path.resolve(process.env.BROWSER_UI_CANDIDATE_DIR) : null;
const evidenceDir = process.env.BROWSER_UI_EVIDENCE_DIR ? path.resolve(process.env.BROWSER_UI_EVIDENCE_DIR) : null;
const mimeTypes = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

async function openBrowserPage(browser, runtime, bootstrap, { hash = 'browser-tools', width = 1440, pollMilliseconds = null, configure = () => {} } = {}) {
  const context = await browser.newContext({ viewport: { width, height: 1000 } });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  const fixture = {
    bootstrap: structuredClone(bootstrap), reads: [], writes: [], commandWrites: [], allowCommandWrites: false, external: [], errors: [],
    summary: { enabled: true, enabledPlatforms: ['douyin'], mode: 'WEB_ACCESS_PRIMARY', primaryProvider: 'web_access_cdp', queued: 0, running: 0, needsConfirmation: 0, platformRuntimes: [] },
    commands: [{ id: 8123, platform_code: 'douyin', account_id: 2, action: 'READ_PAGE_STATE', provider: 'web_access_cdp', status: 'COMPLETED', session_id: 'isolated-browser-session', created_at: new Date().toISOString(), result: { message: '隔离诊断记录' } }]
  };
  fixture.bootstrap.config = { ...fixture.bootstrap.config, masterSwitch: { enabled: true } };
  fixture.bootstrap.platforms = [{ code: 'douyin', name: '抖音', desired_state: 'RUNNING', lifecycle_state: 'ACTIVE' }];
  fixture.bootstrap.accounts = [{ id: 2, platform_code: 'douyin', display_name: '隔离账号', enabled: 1, login_status: 'READY', login_source: 'LOCAL_AGENT', login_checked_at: new Date().toISOString() }];
  fixture.bootstrap.devices = [];
  fixture.bootstrap.localAgent = { online: true };
  configure(fixture);
  page.on('pageerror', error => fixture.errors.push(error.message));
  await page.addInitScript(pollMilliseconds => {
    const original = window.setInterval;
    window.setInterval = (fn, milliseconds, ...rest) => original(fn, milliseconds === 5000 && pollMilliseconds ? pollMilliseconds : milliseconds === 1000 ? 1000 : 600000, ...rest);
  }, pollMilliseconds);
  await context.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const json = (value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify({ ok: status < 400, ...value }) });
    if (url.origin !== runtime.base) {
      fixture.external.push(request.url());
      return route.abort();
    }
    if (!['GET', 'HEAD'].includes(request.method())) {
      fixture.writes.push({ method: request.method(), pathname: url.pathname });
      if (fixture.allowCommandWrites && request.method() === 'POST' && url.pathname === '/api/browser-control/commands') {
        fixture.commandWrites.push(request.postDataJSON());
        return json({ command: { id: 9000 + fixture.commandWrites.length }, reused: false });
      }
      return json({ message: 'UI 验证禁止写操作' }, 405);
    }
    if (url.pathname.startsWith('/api/')) fixture.reads.push(url.pathname);
    if (url.pathname === '/api/bootstrap') return json(fixture.bootstrap);
    if (url.pathname === '/api/browser-control/summary') return json({ browserControl: fixture.summary });
    if (url.pathname === '/api/browser-control/commands') return json({ commands: fixture.commands });
    if (candidatePublic && !url.pathname.startsWith('/api/')) {
      const file = path.resolve(candidatePublic, '.' + decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
      const relative = path.relative(candidatePublic, file);
      if (relative && !relative.startsWith('..') && !path.isAbsolute(relative) && fs.existsSync(file) && fs.statSync(file).isFile()) {
        return route.fulfill({ contentType: mimeTypes[path.extname(file)] || 'application/octet-stream', body: fs.readFileSync(file) });
      }
    }
    return route.continue();
  });
  await page.goto(`${runtime.base}/#${hash}`);
  await page.locator('#browserStatusPanel').waitFor({ state: 'visible' });
  return { page, context, fixture };
}

async function assertNoPageOverflow(page) {
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, '页面不应横向溢出');
}

function assertReadOnly(fixture) {
  assert.deepEqual(fixture.writes, [], '状态查看和修复说明不能提交业务操作');
  assert.deepEqual(fixture.errors, []);
}

async function captureEvidence(page, name) {
  if (evidenceDir) await page.screenshot({ path: path.join(evidenceDir, name + '.png'), fullPage: true, animations: 'disabled' });
}

test('browser status stays read only and keeps maintenance tools available', { skip: !chrome }, async t => {
  if (candidatePublic) assert.equal(fs.statSync(candidatePublic).isDirectory(), true);
  if (evidenceDir) fs.mkdirSync(evidenceDir, { recursive: true });
  const runtime = await startServer({ env: {
    OPERATIONS_ANALYTICS_ENABLED: 'false', LOGIN_STATUS_POLL_ENABLED: 'false', ISSUE_DIAGNOSIS_ENABLED: 'false',
    RAG_BASE_URL: '', RAG_AUTO_START: 'false', RAG_ADMIN_ENABLED: 'false', RAG_FORMAL_ROUTING_ENABLED: 'false',
    CONTENT_LIBRARY_SIGNAL_ROOT: '', CONTENT_LIBRARY_EDITING_ROOT: '', CONTENT_LIBRARY_CREATION_ROOT: '', CONTENT_LIBRARY_SEED_ENABLED: 'false'
  } });
  t.after(async () => { await stopChild(runtime.child); cleanupDir(runtime.dir); });
  const bootstrap = await (await fetch(runtime.base + '/api/bootstrap')).json();
  const browser = await chromium.launch({ executablePath: chrome, headless: true });
  t.after(() => browser.close());

  for (const hash of ['browser', 'browser-tools']) {
    await t.test(`#${hash} opens browser status under settings`, async child => {
      const { page, context, fixture } = await openBrowserPage(browser, runtime, bootstrap, { hash });
      child.after(() => context.close());
      assert.equal(await page.locator('body').getAttribute('data-workspace'), 'settings');
      assert.equal(await page.locator('#pageTitle').textContent(), '浏览器状态');
      assert.equal(await page.locator('#nav [data-workspace=settings]').getAttribute('aria-current'), 'page');
      assert.equal(await page.locator('[data-workspace-item=browser-tools]').getAttribute('aria-current'), 'page');
      assert.equal(await page.locator('#browserMaintenance').evaluate(element => element.tagName === 'DETAILS' && !element.open), true);
      assert.equal(await page.locator('#browserCommandForm').count(), 1);
      assert.equal(await page.locator('#browserCommandForm').isVisible(), false);
      if (hash === 'browser-tools') await captureEvidence(page, 'desktop-status');
      await page.locator('#browserMaintenance > summary').click();
      assert.equal(await page.locator('#browserCommandForm').isVisible(), true);
      assert.match(await page.locator('.browser-command-table').textContent(), /8123/);
      assert.match(await page.locator('.browser-command-table').textContent(), /isolated-browser-session/);
      assertReadOnly(fixture);
    });
  }

  for (const scenario of [
    { name: 'a stopped platform is not a connection failure', label: '未运行', title: '暂无运行中的平台', configure: fixture => { fixture.bootstrap.platforms[0].desired_state = 'STOPPED'; fixture.bootstrap.localAgent.online = false; } },
    { name: 'a planned platform does not require repair', label: '未接入', title: '暂无运行中的平台', configure: fixture => { fixture.bootstrap.platforms[0].lifecycle_state = 'PLANNED'; fixture.bootstrap.localAgent.online = false; } },
    { name: 'a disabled account is not a browser failure', label: '账号未启用', title: '暂无运行中的平台', configure: fixture => { fixture.bootstrap.accounts[0].enabled = 0; fixture.bootstrap.localAgent.online = false; } },
    { name: 'paused operations stay paused instead of showing a fault', label: '已暂停', title: '已暂停', configure: fixture => { fixture.bootstrap.config.masterSwitch.enabled = false; fixture.bootstrap.localAgent.online = false; } },
    { name: 'the diagnostic switch does not invalidate a healthy business browser', label: '最近检查正常', title: '暂未发现异常', configure: fixture => { fixture.summary.enabled = false; } },
    { name: 'no current heartbeat overrides an older connected runtime', label: '连接中断', title: '需要处理', warning: true, configure: fixture => { fixture.bootstrap.localAgent.online = false; fixture.summary.platformRuntimes = [{ platformCode: 'douyin', runtime: { connected: true } }]; } },
    { name: 'an expired login needs login', label: '需要登录', title: '需要处理', warning: true, configure: fixture => { fixture.bootstrap.accounts[0].login_status = 'EXPIRED'; } },
    { name: 'a verification challenge needs verification', label: '需要验证', title: '需要处理', warning: true, configure: fixture => { fixture.bootstrap.accounts[0].login_status = 'VERIFY_REQUIRED'; } },
    { name: 'a recent ready result is shown as a recent check', label: '最近检查正常', title: '暂未发现异常', configure: () => {} },
    { name: 'an account without check evidence stays unchecked', label: '待检查', title: '部分状态待检查', configure: fixture => { delete fixture.bootstrap.accounts[0].login_checked_at; } },
    { name: 'a result without a local-agent source stays unchecked', label: '待检查', title: '部分状态待检查', configure: fixture => { delete fixture.bootstrap.accounts[0].login_source; } },
    { name: 'an old ready login result stays unchecked', label: '待检查', title: '部分状态待检查', configure: fixture => { fixture.bootstrap.accounts[0].login_checked_at = new Date(Date.now() - 16 * 60 * 1000).toISOString(); } },
    { name: 'summary runtimes cannot mark an unchecked account healthy', label: '待检查', title: '部分状态待检查', configure: fixture => {
      delete fixture.bootstrap.accounts[0].login_checked_at;
      fixture.summary.platformRuntimes = [{ platformCode: 'douyin', runtime: { connected: true } }];
    } },
    { name: 'a stale device runtime cannot mark an unchecked account healthy', label: '待检查', title: '部分状态待检查', configure: fixture => {
      delete fixture.bootstrap.accounts[0].login_checked_at;
      fixture.bootstrap.accounts[0].device_id = 'bound-device';
      fixture.bootstrap.localAgent.deviceId = 'bound-device';
      fixture.bootstrap.devices = [{ id: 'bound-device', status: 'ONLINE', last_heartbeat: new Date(Date.now() - 60000).toISOString(), browser_control_json: JSON.stringify({ platformRuntimes: [{ platformCode: 'douyin', runtime: { connected: true } }] }) }];
    } },
    { name: 'another device runtime cannot mark the bound account healthy', label: '待检查', title: '部分状态待检查', configure: fixture => {
      delete fixture.bootstrap.accounts[0].login_checked_at;
      fixture.bootstrap.accounts[0].device_id = 'bound-device';
      fixture.bootstrap.localAgent.deviceId = 'bound-device';
      fixture.bootstrap.devices = [{ id: 'other-device', status: 'ONLINE', last_heartbeat: new Date().toISOString(), browser_control_json: JSON.stringify({ platformRuntimes: [{ platformCode: 'douyin', runtime: { connected: true } }] }) }];
    } },
    { name: 'a remote bound device needs its own fresh heartbeat', label: '连接中断', title: '需要处理', warning: true, configure: fixture => {
      fixture.bootstrap.accounts[0].device_id = 'remote-device';
      fixture.bootstrap.localAgent.deviceId = 'local-device';
      fixture.bootstrap.devices = [{ id: 'remote-device', status: 'ONLINE', last_heartbeat: new Date(Date.now() - 60000).toISOString(), browser_control_json: JSON.stringify({ platformRuntimes: [{ platformCode: 'douyin', runtime: { connected: true } }] }) }];
    } },
    { name: 'a fresh bound device can report its connected runtime', label: '浏览器已连接', title: '暂未发现异常', configure: fixture => {
      delete fixture.bootstrap.accounts[0].login_checked_at;
      fixture.bootstrap.accounts[0].device_id = 'bound-device';
      fixture.bootstrap.localAgent.expectedDeviceId = 'bound-device';
      fixture.bootstrap.devices = [{ id: 'bound-device', status: 'ONLINE', last_heartbeat: new Date().toISOString(), browser_control_json: JSON.stringify({ platformRuntimes: [{ platformCode: 'douyin', runtime: { contextConnected: true } }] }) }];
    } }
  ]) {
    await t.test(scenario.name, async child => {
      const { page, context, fixture } = await openBrowserPage(browser, runtime, bootstrap, { configure: scenario.configure });
      child.after(() => context.close());
      const card = page.locator('[data-browser-platform=douyin]');
      assert.equal(await card.locator('.browser-status-label').textContent(), scenario.label);
      assert.equal(await page.locator('#browserStatusPanel h2').textContent(), scenario.title);
      assert.equal(await card.locator('.browser-status-label').evaluate(element => element.classList.contains('warning')), Boolean(scenario.warning));
      assertReadOnly(fixture);
    });
  }

  await t.test('a second enabled account reports its own expired login', async child => {
    const { page, context, fixture } = await openBrowserPage(browser, runtime, bootstrap, { configure: fixture => {
      fixture.bootstrap.accounts.push({ ...fixture.bootstrap.accounts[0], id: 3, display_name: '第二个隔离账号', login_status: 'EXPIRED' });
    } });
    child.after(() => context.close());
    assert.equal(await page.locator('[data-browser-platform=douyin]').count(), 2);
    assert.equal(await page.locator('[data-browser-account="2"] .browser-status-label').textContent(), '最近检查正常');
    assert.equal(await page.locator('[data-browser-account="3"] .browser-status-label').textContent(), '需要登录');
    assert.match(await page.locator('[data-browser-account="3"]').textContent(), /第二个隔离账号/);
    assert.equal(await page.locator('#browserStatusPanel h2').textContent(), '需要处理');
    await page.locator('[data-browser-help="douyin:3"]').click();
    await page.locator('dialog.browser-repair-dialog').waitFor({ state: 'visible' });
    assert.match(await page.locator('dialog.browser-repair-dialog h2').textContent(), /重新登录/);
    await page.keyboard.press('Escape');
    assertReadOnly(fixture);
  });

  await t.test('bootstrap polling updates status while preserving the maintenance draft', async child => {
    const { page, context, fixture } = await openBrowserPage(browser, runtime, bootstrap, { pollMilliseconds: 100 });
    child.after(() => context.close());
    await page.locator('#browserMaintenance > summary').click();
    const form = page.locator('#browserCommandForm');
    await form.locator('[name=action]').selectOption('READ_TEXT');
    await form.locator('[name=sessionId]').fill('unsaved-maintenance-session');
    await form.locator('[name=selector]').fill('main .unsaved-selector');
    const originalForm = await form.elementHandle();
    const previousReads = fixture.reads.length;
    fixture.bootstrap.localAgent.online = false;
    await page.waitForFunction(() => document.querySelector('[data-browser-platform="douyin"] .browser-status-label')?.textContent === '连接中断');
    assert.equal(await originalForm.evaluate(element => element.isConnected), true);
    assert.equal(await page.locator('#browserMaintenance').evaluate(element => element.open), true);
    assert.equal(await form.locator('[name=action]').inputValue(), 'READ_TEXT');
    assert.equal(await form.locator('[name=sessionId]').inputValue(), 'unsaved-maintenance-session');
    assert.equal(await form.locator('[name=selector]').inputValue(), 'main .unsaved-selector');
    assert.ok(fixture.reads.slice(previousReads).includes('/api/bootstrap'));
    assert.equal(fixture.reads.slice(previousReads).some(pathname => pathname.startsWith('/api/browser-control/')), false, '轮询只刷新bootstrap和状态面板');
    await originalForm.dispose();
    assertReadOnly(fixture);
  });

  await t.test('refresh reads new bootstrap and redraws summary and commands', async child => {
    const { page, context, fixture } = await openBrowserPage(browser, runtime, bootstrap);
    child.after(() => context.close());
    const previous = Object.fromEntries(['/api/bootstrap', '/api/browser-control/summary', '/api/browser-control/commands'].map(pathname => [pathname, fixture.reads.filter(value => value === pathname).length]));
    fixture.bootstrap.localAgent.online = false;
    fixture.bootstrap.accounts[0].display_name = '刷新后的隔离账号';
    fixture.commands = [{ ...fixture.commands[0], id: 8124, session_id: 'refreshed-browser-session' }];
    await page.locator('#browserRefresh').click();
    await page.waitForFunction(() => document.querySelector('[data-browser-platform="douyin"] .browser-status-label')?.textContent === '连接中断');
    assert.match(await page.locator('[data-browser-platform=douyin]').textContent(), /刷新后的隔离账号/);
    assert.match(await page.locator('.browser-command-table').textContent(), /8124/);
    assert.match(await page.locator('.browser-command-table').textContent(), /refreshed-browser-session/);
    for (const [pathname, count] of Object.entries(previous)) assert.equal(fixture.reads.filter(value => value === pathname).length, count + 1, `刷新必须重新读取 ${pathname}`);
    assertReadOnly(fixture);
  });

  await t.test('repair instructions open in a native dialog and Escape closes it', async child => {
    const { page, context, fixture } = await openBrowserPage(browser, runtime, bootstrap, { configure: fixture => { fixture.bootstrap.localAgent.online = false; } });
    child.after(() => context.close());
    await page.locator('[data-browser-help=douyin]').click();
    const dialog = page.locator('dialog.browser-repair-dialog');
    await dialog.waitFor({ state: 'visible' });
    assert.equal(await dialog.evaluate(element => element.open), true);
    assert.ok((await dialog.textContent()).trim().length > 10);
    assert.equal(await dialog.locator('[data-browser-accounts]').isVisible(), true);
    assert.equal(await dialog.locator('form[action],input[type=password]').count(), 0);
    await captureEvidence(page, 'desktop-repair');
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'hidden' });
    await page.locator('[data-browser-help=douyin]').click();
    await page.locator('dialog.browser-repair-dialog [data-browser-accounts]').click();
    await page.locator('[data-workspace-item=accounts][aria-current=page]').waitFor({ state: 'attached' });
    assert.equal(await page.locator('body').getAttribute('data-workspace'), 'channels');
    assertReadOnly(fixture);
  });

  await t.test('maintenance keeps the existing diagnostic command request contract', async child => {
    const { page, context, fixture } = await openBrowserPage(browser, runtime, bootstrap, { configure: fixture => { fixture.allowCommandWrites = true; } });
    child.after(() => context.close());
    assert.deepEqual(await page.locator('#browserCommandForm [name=action] option').evaluateAll(options => options.map(option => option.value)), ['HEALTH_CHECK', 'OPEN_PAGE', 'NAVIGATE', 'READ_PAGE_STATE', 'READ_TEXT', 'SCROLL', 'SCREENSHOT', 'CLOSE_TAB']);
    const cases = [
      { action: 'OPEN_PAGE', fields: { url: 'https://creator.douyin.com/creator-micro/content/manage' }, params: { url: 'https://creator.douyin.com/creator-micro/content/manage' }, sessionId: 'mock-open-session' },
      { action: 'READ_TEXT', fields: { selector: 'main .review-content' }, params: { selector: 'main .review-content', maxChars: 8000 }, sessionId: 'mock-read-session' },
      { action: 'SCROLL', fields: { direction: 'up' }, params: { direction: 'up', y: 1200 }, sessionId: 'mock-scroll-session' },
      { action: 'HEALTH_CHECK', fields: {}, params: {} }
    ];
    for (const scenario of cases) {
      assert.equal(await page.locator('#browserMaintenance').evaluate(element => element.open), false);
      await page.locator('#browserMaintenance > summary').click();
      const form = page.locator('#browserCommandForm');
      await form.locator('[name=platformCode]').selectOption('douyin');
      await form.locator('[name=accountId]').selectOption('2');
      await form.locator('[name=action]').selectOption(scenario.action);
      await form.locator('[name=sessionId]').fill(scenario.sessionId ? ` ${scenario.sessionId} ` : '');
      for (const [name, value] of Object.entries(scenario.fields)) {
        const field = form.locator(`[name=${name}]`);
        if (name === 'direction') await field.selectOption(value);
        else await field.fill(value);
      }
      const previousForm = await form.elementHandle();
      await form.locator('button[type=submit]').click();
      await page.waitForFunction(element => !element.isConnected, previousForm);
      await previousForm.dispose();
      const payload = fixture.commandWrites.at(-1);
      assert.equal(payload.action, scenario.action);
      assert.equal(payload.platformCode, 'douyin');
      assert.equal(payload.accountId, 2);
      assert.equal(payload.provider, 'web_access_cdp');
      assert.equal(payload.purpose, 'DIAGNOSTIC');
      assert.deepEqual(payload.params, scenario.params);
      if (scenario.sessionId) assert.equal(payload.sessionId, scenario.sessionId);
      else assert.equal(Object.hasOwn(payload, 'sessionId'), false);
      assert.match(payload.idempotencyKey, /^web-console-/);
    }
    assert.equal(fixture.commandWrites.length, cases.length);
    assert.equal(new Set(fixture.commandWrites.map(payload => payload.idempotencyKey)).size, cases.length);
    assert.deepEqual(fixture.writes, cases.map(() => ({ method: 'POST', pathname: '/api/browser-control/commands' })));
    assert.deepEqual(fixture.errors, []);
  });

  await t.test('390px keeps status, maintenance and repair instructions within the viewport', async child => {
    const { page, context, fixture } = await openBrowserPage(browser, runtime, bootstrap, { width: 390, configure: fixture => { fixture.bootstrap.localAgent.online = false; } });
    child.after(() => context.close());
    await assertNoPageOverflow(page);
    await captureEvidence(page, 'mobile-status');
    await page.locator('#browserMaintenance > summary').click();
    await assertNoPageOverflow(page);
    await page.locator('#browserMaintenance > summary').click();
    await page.locator('[data-browser-help=douyin]').click();
    const dialog = page.locator('dialog.browser-repair-dialog');
    await dialog.waitFor({ state: 'visible' });
    const rect = await dialog.boundingBox();
    assert.ok(rect.x >= 0 && rect.x + rect.width <= 391, '修复弹窗应在窄屏内');
    await assertNoPageOverflow(page);
    await captureEvidence(page, 'mobile-repair');
    await page.keyboard.press('Escape');
    assertReadOnly(fixture);
  });
});
