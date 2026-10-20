import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chromium } from 'playwright-core';
import { cleanupDir, startServer, stopChild, openWorkspacePage } from './helpers/runtime.js';

function installedChromePath() {
  const candidates = [
    process.env.CHROME_EXECUTABLE_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser'
  ].filter(Boolean);
  return candidates.find(candidate => fs.existsSync(candidate)) || null;
}

const chromePath = installedChromePath();
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

test('发布历史随主操作列同步高度，并在窄屏和离开页面时清理', { skip: !chromePath }, async t => {
  const runtime = await startServer();
  t.after(async () => { await stopChild(runtime.child); cleanupDir(runtime.dir); });

  const browser = await chromium.launch({ headless: true, executablePath: chromePath });
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addInitScript(() => {
    const NativeResizeObserver = window.ResizeObserver;
    window.__publishResizeObserver = { created: 0, observed: 0, disconnected: 0 };
    window.ResizeObserver = class InstrumentedResizeObserver {
      constructor(callback) {
        window.__publishResizeObserver.created += 1;
        this.observer = new NativeResizeObserver(callback);
      }
      observe(target, options) {
        window.__publishResizeObserver.observed += 1;
        this.observer.observe(target, options);
      }
      unobserve(target) { this.observer.unobserve(target); }
      disconnect() {
        window.__publishResizeObserver.disconnected += 1;
        this.observer.disconnect();
      }
    };
  });
  const page = await context.newPage();

  await page.goto(runtime.base);
  await openWorkspacePage(page, 'publish');
  await page.locator('#publishHistory').waitFor();
  await page.waitForFunction(() => document.querySelector('#publishHistory')?.classList.contains('is-height-limited'), null, { timeout: 4000 });

  const desktop = await page.evaluate(() => {
    const mainPanel = document.querySelector('.publish-main-column > .panel');
    const sideColumn = document.querySelector('.publish-side-column');
    const sidePanel = document.querySelector('.publish-side-column > .panel:not(.publish-history-panel)');
    const history = document.querySelector('#publishHistory');
    const gap = Number.parseFloat(getComputedStyle(sideColumn).rowGap || getComputedStyle(sideColumn).gap) || 18;
    const expected = Math.floor(mainPanel.getBoundingClientRect().height - sidePanel.getBoundingClientRect().height - gap);
    const applied = Number.parseFloat(history.style.getPropertyValue('--publish-history-max-height'));
    return {
      expected,
      applied,
      maxHeight: getComputedStyle(history).maxHeight,
      classApplied: history.classList.contains('is-height-limited'),
      stats: { ...window.__publishResizeObserver }
    };
  });
  assert.ok(desktop.expected > 0, JSON.stringify(desktop));
  assert.ok(Math.abs(desktop.applied - desktop.expected) <= 1, JSON.stringify(desktop));
  assert.equal(desktop.maxHeight, `${desktop.applied}px`);
  assert.equal(desktop.classApplied, true);
  assert.ok(desktop.stats.created >= 1 && desktop.stats.observed >= 2, JSON.stringify(desktop.stats));

  await page.setViewportSize({ width: 900, height: 1000 });
  await page.waitForFunction(() => {
    const history = document.querySelector('#publishHistory');
    return history && !history.classList.contains('is-height-limited') && !history.style.getPropertyValue('--publish-history-max-height');
  });
  assert.equal(await page.locator('#publishHistory').evaluate(node => getComputedStyle(node).maxHeight), 'none');

  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.waitForFunction(() => document.querySelector('#publishHistory')?.classList.contains('is-height-limited'));
  const historyHandle = await page.locator('#publishHistory').elementHandle();
  const disconnectedBefore = await page.evaluate(() => window.__publishResizeObserver.disconnected);
  await openWorkspacePage(page, 'dashboard');
  await page.locator('.operations-dashboard').waitFor();
  const cleanup = await historyHandle.evaluate(node => ({
    connected: node.isConnected,
    classApplied: node.classList.contains('is-height-limited'),
    heightVariable: node.style.getPropertyValue('--publish-history-max-height')
  }));
  assert.deepEqual(cleanup, { connected: false, classApplied: false, heightVariable: '' });
  assert.ok(await page.evaluate(() => window.__publishResizeObserver.disconnected) > disconnectedBefore);
});

test('发布请求挂起后离开页面，晚到响应不能建立布局观察器、监听器或轮询', { skip: !chromePath }, async t => {
  const runtime = await startServer();
  t.after(async () => { await stopChild(runtime.child); cleanupDir(runtime.dir); });
  const browser = await chromium.launch({ headless: true, executablePath: chromePath });
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addInitScript(() => {
    const NativeResizeObserver = window.ResizeObserver;
    const nativeAddEventListener = window.addEventListener.bind(window);
    const nativeRemoveEventListener = window.removeEventListener.bind(window);
    const nativeSetInterval = window.setInterval.bind(window);
    const nativeClearInterval = window.clearInterval.bind(window);
    const trackedIntervals = new Set();
    window.__trackLatePublish = false;
    window.__latePublishLifecycle = { created: 0, observed: 0, disconnected: 0, resizeAdded: 0, resizeRemoved: 0, intervalsCreated: 0, intervalsCleared: 0 };
    window.ResizeObserver = class InstrumentedResizeObserver {
      constructor(callback) {
        if (window.__trackLatePublish) window.__latePublishLifecycle.created += 1;
        this.tracked = window.__trackLatePublish;
        this.observer = new NativeResizeObserver(callback);
      }
      observe(target, options) {
        if (this.tracked) window.__latePublishLifecycle.observed += 1;
        this.observer.observe(target, options);
      }
      unobserve(target) { this.observer.unobserve(target); }
      disconnect() {
        if (this.tracked) window.__latePublishLifecycle.disconnected += 1;
        this.observer.disconnect();
      }
    };
    window.addEventListener = function(type, listener, options) {
      if (window.__trackLatePublish && type === 'resize') window.__latePublishLifecycle.resizeAdded += 1;
      return nativeAddEventListener(type, listener, options);
    };
    window.removeEventListener = function(type, listener, options) {
      if (window.__trackLatePublish && type === 'resize') window.__latePublishLifecycle.resizeRemoved += 1;
      return nativeRemoveEventListener(type, listener, options);
    };
    window.setInterval = function(callback, timeout, ...args) {
      const id = nativeSetInterval(callback, timeout, ...args);
      if (window.__trackLatePublish && timeout === 2000) {
        trackedIntervals.add(id);
        window.__latePublishLifecycle.intervalsCreated += 1;
      }
      return id;
    };
    window.clearInterval = function(id) {
      if (trackedIntervals.delete(id)) window.__latePublishLifecycle.intervalsCleared += 1;
      return nativeClearInterval(id);
    };
  });
  const page = await context.newPage();
  const historyEntered = deferred();
  const releaseHistory = deferred();
  const dashboardBootstrapEntered = deferred();
  const releaseDashboardBootstrap = deferred();
  let bootstrapCount = 0;

  await page.route('**/api/bootstrap', async route => {
    bootstrapCount += 1;
    if (bootstrapCount === 3) {
      dashboardBootstrapEntered.resolve();
      await releaseDashboardBootstrap.promise;
    }
    const response = await route.fetch();
    return route.fulfill({ response });
  });
  await page.route('**/api/publish/history?**', async route => {
    historyEntered.resolve();
    await releaseHistory.promise;
    const response = await route.fetch();
    return route.fulfill({ response });
  });

  await page.goto(runtime.base);
  await page.locator('.operations-dashboard').waitFor();
  await openWorkspacePage(page, 'publish');
  await historyEntered.promise;
  assert.equal(await page.locator('#publishHistory').count(), 1);
  await openWorkspacePage(page, 'dashboard');
  await dashboardBootstrapEntered.promise;
  await page.evaluate(() => { window.__trackLatePublish = true; });
  releaseHistory.resolve();
  await delay(250);

  assert.deepEqual(await page.evaluate(() => ({ ...window.__latePublishLifecycle })), {
    created: 0, observed: 0, disconnected: 0, resizeAdded: 0, resizeRemoved: 0, intervalsCreated: 0, intervalsCleared: 0
  });
  releaseDashboardBootstrap.resolve();
  await page.locator('.operations-dashboard').waitFor();
  await delay(100);
  assert.equal(await page.locator('#publishHistory').count(), 0);
  assert.deepEqual(await page.evaluate(() => ({ ...window.__latePublishLifecycle })), {
    created: 0, observed: 0, disconnected: 0, resizeAdded: 0, resizeRemoved: 0, intervalsCreated: 0, intervalsCleared: 0
  });
});

test('离开发布页后的预检响应不能写入新页面或触发内容生成', { skip: !chromePath }, async t => {
  const runtime = await startServer();
  t.after(async () => { await stopChild(runtime.child); cleanupDir(runtime.dir); });
  const browser = await chromium.launch({ headless: true, executablePath: chromePath });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const precheckEntered = deferred();
  const releasePrecheck = deferred();
  let generationRequests = 0;

  await page.route('**/api/local-agent/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/local-agent/precheck') {
      precheckEntered.resolve();
      await releasePrecheck.promise;
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
        ok: true,
        precheck: { overall: 'PASSED', meta: { type: 'image', format: 'png', extension: '.png', sha256: 'stale-precheck-sha' }, results: [] },
        previewUrl: null
      }) });
    }
    if (url.pathname === '/api/local-agent/material-content-generation') {
      generationRequests += 1;
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, generation: { status: 'SUCCESS', materialSha256: 'stale-precheck-sha', sourceType: 'image', mock: true } }) });
    }
    return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ ok: false }) });
  });

  await page.goto(runtime.base);
  await openWorkspacePage(page, 'publish');
  await page.locator('#publishForm').waitFor();
  await page.locator('#materialPath').fill('C:\\old-page-image.png');
  await page.locator('#runPrecheck').click();
  await precheckEntered.promise;

  await openWorkspacePage(page, 'dashboard');
  await page.locator('.operations-dashboard').waitFor();
  await openWorkspacePage(page, 'publish');
  await page.locator('#publishForm').waitFor();
  await page.locator('#materialPath').fill('C:\\new-page-image.png');
  assert.match(await page.locator('#precheckBox').innerText(), /等待上传/);

  releasePrecheck.resolve();
  await delay(350);
  assert.match(await page.locator('#precheckBox').innerText(), /等待上传/);
  assert.equal(await page.locator('#materialPreview').getAttribute('class'), 'material-preview material-preview-empty material-picker');
  assert.equal(generationRequests, 0);
  assert.equal(await page.locator('#toast').innerText(), '');
});

test('同一发布页较慢的旧预检不能覆盖较新的素材与平台选择', { skip: !chromePath }, async t => {
  const runtime = await startServer();
  t.after(async () => { await stopChild(runtime.child); cleanupDir(runtime.dir); });
  const browser = await chromium.launch({ headless: true, executablePath: chromePath });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const slowPrecheckEntered = deferred();
  const releaseSlowPrecheck = deferred();
  const fastGenerationEntered = deferred();
  const generationMaterials = [];

  await page.route('**/api/bootstrap', async route => {
    const response = await route.fetch();
    const payload = await response.json();
    payload.platforms = [{
      code: 'douyin', name: '抖音', lifecycle_state: 'ACTIVE', task_execution_state: 'RUNNING',
      desired_state: 'RUNNING', active_block_count: 0
    }];
    payload.accounts = [{
      id: 1, platform_code: 'douyin', platform_name: '抖音', display_name: '预检账号',
      profile_name: 'precheck-profile', enabled: 1, login_status: 'LOGGED_IN'
    }];
    payload.config = {
      ...payload.config,
      activePlatformCodes: ['douyin'],
      audioContentGenerationEnabled: true,
      audioContentAutoTrigger: true
    };
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(payload) });
  });
  await page.route('**/api/local-agent/**', async route => {
    const url = new URL(route.request().url());
    const body = route.request().postDataJSON();
    if (url.pathname === '/api/local-agent/precheck') {
      const slow = body.materialPath === 'C:\\slow-a.png';
      if (slow) {
        slowPrecheckEntered.resolve();
        await releaseSlowPrecheck.promise;
      }
      const meta = slow
        ? { type: 'image', name: 'slow-a.png', format: 'png', extension: '.png', sha256: 'slow-a-sha', width: 800, height: 600 }
        : { type: 'image', name: 'fast-b.jpg', format: 'jpeg', extension: '.jpg', sha256: 'fast-b-sha', width: 800, height: 600 };
      const results = slow ? [{ platformCode: 'douyin', status: 'PASSED' }] : [];
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, precheck: { overall: 'PASSED', meta, results }, previewUrl: null }) });
    }
    if (url.pathname === '/api/local-agent/material-content-generation') {
      generationMaterials.push(body.materialPath);
      if (body.materialPath === 'C:\\fast-b.jpg') fastGenerationEntered.resolve();
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
        ok: true,
        generation: { status: 'SUCCESS', materialSha256: body.materialSha256, sourceType: 'image', mock: true }
      }) });
    }
    return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ ok: false }) });
  });

  await page.goto(runtime.base);
  await openWorkspacePage(page, 'publish');
  await page.locator('#publishForm').waitFor();
  const platform = page.locator('.platform-check[data-platform="douyin"]');
  await platform.check();
  await page.locator('#materialPath').fill('C:\\slow-a.png');
  await page.locator('#runPrecheck').click();
  await slowPrecheckEntered.promise;

  await page.locator('#materialPath').fill('C:\\fast-b.jpg');
  await platform.uncheck();
  await fastGenerationEntered.promise;
  await page.waitForFunction(() => document.querySelector('#precheckBox')?.textContent.includes('JPEG'));
  assert.match(await page.locator('#precheckBox').innerText(), /待选择平台/);
  assert.match(await page.locator('#toast').innerText(), /素材基础检测完成/);

  releaseSlowPrecheck.resolve();
  await delay(300);
  assert.match(await page.locator('#precheckBox').innerText(), /JPEG/);
  assert.match(await page.locator('#precheckBox').innerText(), /待选择平台/);
  assert.match(await page.locator('#toast').innerText(), /素材基础检测完成/);
  assert.deepEqual(generationMaterials, ['C:\\fast-b.jpg']);
});
