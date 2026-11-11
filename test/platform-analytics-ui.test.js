import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { cleanupDir, startServer, stopChild, tempRuntimeDir } from './helpers/runtime.js';

function installedChromePath() {
  return [process.env.CHROME_EXECUTABLE_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'
  ].filter(Boolean).find(candidate => fs.existsSync(candidate)) || null;
}
const chromePath = installedChromePath();
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
const channels = [{ code: 'douyin', name: '抖音', published: 0 }, { code: 'bilibili', name: 'B站', published: 0 }];
function dashboard(platformCode = 'all') {
  const platform = platformCode === 'bilibili' ? 'bilibili' : 'douyin';
  return { platformCode, updatedAt: '2026-11-02T04:00:00Z', channels,
    kpis: [{ key: 'exposure', label: '曝光量', icon: 'dashboard', value: null, status: 'PENDING_SOURCE', pendingNote: '周期曝光待接入' }],
    content: [], trend: [], funnel: [], recommendations: [],
    analytics: { accounts: [{ accountId: platform === 'douyin' ? 1001 : 1002, platformCode: platform,
      status: 'READY', capturedAt: '2026-11-02T04:00:00Z', accountIdentity: { name: platform === 'douyin' ? '隔离抖音账号' : '隔离B站账号' },
      metrics: [{ key: 'plays', label: '播放量', value: 0, rawValue: '0', scope: 'SNAPSHOT' },
        { key: 'netFollowers', label: '净增粉丝', value: 0, rawValue: '0', scope: 'PERIOD',
          periodStart: '2026-10-26T16:00:00.000Z', periodEnd: '2026-11-01T16:00:00.000Z' }] }],
      coverage: { supportedAccounts: 1, connectedAccounts: 1, missing: [] } } };
}

async function fixture(t, handleDashboard) {
  const dir = tempRuntimeDir('platform-analytics-ui-');
  let runtime, browser;
  t.after(async () => { await browser?.close(); await stopChild(runtime?.child); cleanupDir(dir); });
  runtime = await startServer({ dir, env: {
    RPA_MODE: 'simulated', OPERATIONS_ANALYTICS_ENABLED: 'false', LOGIN_STATUS_POLL_ENABLED: 'false',
    LOCAL_AGENT_AUTO_START: 'false', AUTO_COLLECT_ENABLED: 'false', ISSUE_DIAGNOSIS_ENABLED: 'false',
    RAG_BASE_URL: '', RAG_AUTO_START: 'false', RAG_ADMIN_ENABLED: 'false', RAG_FORMAL_ROUTING_ENABLED: 'false',
    CONTENT_LIBRARY_DIR: path.join(dir, 'content-library'), CONTENT_LIBRARY_SEED_ENABLED: 'false',
    CONTENT_LIBRARY_SIGNAL_ROOT: '', CONTENT_LIBRARY_EDITING_ROOT: '', CONTENT_LIBRARY_CREATION_ROOT: '',
    SETTINGS_KEY_PATH: path.join(dir, 'settings-key'), VIDEO_STUDIO_ENABLED: 'false'
  } });
  browser = await chromium.launch({ headless: true, executablePath: chromePath });
  // A UTC browser makes the expected Shanghai day depend on the UI's explicit timezone.
  const page = await browser.newPage({ viewport: { width: 1440, height: 1080 }, timezoneId: 'UTC' });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, []));
  await page.route('**/app.js?*', async route => {
    const response = await route.fetch();
    await route.fulfill({ response, body: (await response.text()) +
      '\nwindow.analyticsUiTest = { snapshot: () => ({ selected: state.dashboardPlatform, loaded: state.operationsDashboard?.platformCode }), redraw: renderDashboard };' });
  });
  await page.route('**/api/operations-dashboard?**', async route => {
    const platform = new URL(route.request().url()).searchParams.get('platform') || 'all';
    if (handleDashboard) await handleDashboard(platform);
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, dashboard: dashboard(platform) }) });
  });
  await page.goto(runtime.base);
  await page.locator('.operations-analytics-account').waitFor();
  return { page };
}

test('平台运营数据保留真实零值，周期按上海日期显示且累计读数不填充周期KPI', { skip: !chromePath }, async t => {
  const { page } = await fixture(t);
  const card = page.locator('.operations-analytics-account');
  assert.match(await card.innerText(), /隔离抖音账号/);
  const plays = card.locator('dl > div').filter({ has: page.locator('dt', { hasText: '播放量' }) });
  const followers = card.locator('dl > div').filter({ has: page.locator('dt', { hasText: '净增粉丝' }) });
  assert.equal(await plays.locator('dd').innerText(), '0');
  assert.equal(await followers.locator('dd').innerText(), '0');
  assert.equal(await plays.locator('small').innerText(), '平台页面最新读数');
  assert.equal(await followers.locator('small').innerText(), '2026/10/27 至 2026/11/02');
  assert.doesNotMatch(await followers.innerText(), /2026\/10\/26/);
  assert.equal(await card.locator('.operations-pending').count(), 0);
  assert.equal(await page.locator('.operations-kpi-grid').count(), 0);
  assert.equal(await page.locator('.operations-source-notice').count(), 0);
});

test('快速切换平台后迟到响应不能覆盖当前平台数据或随后的重绘', { skip: !chromePath, timeout: 20_000 }, async t => {
  const entered = deferred(), release = deferred();
  t.after(() => release.resolve());
  const { page } = await fixture(t, async platform => {
    if (platform === 'douyin') { entered.resolve(); await release.promise; }
  });
  await page.locator('#operationsPlatformFilter').selectOption('douyin');
  await entered.promise;
  await page.locator('#operationsPlatformFilter').selectOption('bilibili');
  await page.waitForFunction(() => document.querySelector('.operations-analytics-account')?.textContent.includes('隔离B站账号'));
  assert.equal(await page.locator('#operationsPlatformFilter').inputValue(), 'bilibili');

  const oldResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/operations-dashboard'
    && new URL(response.url()).searchParams.get('platform') === 'douyin');
  release.resolve();
  await (await oldResponse).finished();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.deepEqual(await page.evaluate(() => window.analyticsUiTest.snapshot()), { selected: 'bilibili', loaded: 'bilibili' });
  await page.evaluate(() => window.analyticsUiTest.redraw());
  assert.equal(await page.locator('#operationsPlatformFilter').inputValue(), 'bilibili');
  assert.match(await page.locator('.operations-analytics-account').innerText(), /隔离B站账号/);
  assert.doesNotMatch(await page.locator('.operations-analytics-account').innerText(), /隔离抖音账号/);
});
