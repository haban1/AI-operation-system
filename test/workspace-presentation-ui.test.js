import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chromium } from 'playwright-core';
import { startServer, stopChild, cleanupDir } from './helpers/runtime.js';

const chrome = [
  process.env.CHROME_EXECUTABLE_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/chromium'
].filter(Boolean).find(file => fs.existsSync(file));
const itemId = '0123456789abcdef0123456789abcdef';

async function mockPage(browser, runtime, hash, options = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  const fixture = {
    failAi: false, aiReads: 0, writes: [], errors: [],
    ai: { configured: true, source: 'DATABASE', mode: 'mock', baseUrl: 'https://example.invalid/v1', model: 'saved-model', visionModel: 'saved-vision', maskedApiKey: '***' },
    ...options
  };
  page.on('pageerror', error => fixture.errors.push(error.message));
  page.on('dialog', dialog => dialog.accept());
  await page.addInitScript(() => {
    const original = window.setInterval;
    window.setInterval = (fn, milliseconds, ...rest) => original(fn, milliseconds === 1000 ? 1000 : 600000, ...rest);
  });
  await context.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const json = (data, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify({ ok: status < 400, ...data }) });
    if (url.origin !== runtime.base) return route.abort();
    if (!['GET', 'HEAD'].includes(request.method())) {
      fixture.writes.push(url.pathname);
      if (url.pathname === '/api/settings/ai') {
        const { apiKey, ...values } = request.postDataJSON();
        fixture.ai = { ...fixture.ai, ...values, configured: true };
      }
      return json({ result: { message: '模拟测试完成' } });
    }
    if (url.pathname === '/api/settings/ai') {
      fixture.aiReads += 1;
      return fixture.failAi ? json({ message: '模拟加载失败' }, 503) : json({ settings: fixture.ai, summary: {}, logs: [] });
    }
    if (url.pathname === '/api/settings/wecom') return json({ settings: { configured: true, source: 'DATABASE', maskedUrl: '***' }, notifications: [] });
    if (url.pathname === `/api/content-library/${itemId}/publish-draft`) return json({ title: '素材库的新标题', body: '素材库的新正文', materialPath: 'review-library.mp4', mediaType: 'video', mediaUrl: '/review-library.mp4', meta: { name: 'review-library.mp4' } });
    if (url.pathname === '/api/creative-workbench/status') return json({ services: [] });
    if (url.pathname === '/video-workbench/index.html') {
      const body = url.searchParams.has('picker')
        ? `<button id="select" onclick="parent.postMessage({type:'content-library:publish',id:'${itemId}'},location.origin)">使用隔离素材</button>`
        : '<script>setTimeout(()=>parent.postMessage({type:"content-workbench:view-changed",title:"AI生成"},location.origin),50)</script>';
      return route.fulfill({ contentType: 'text/html', body });
    }
    if (url.pathname === '/review-library.mp4') return route.fulfill({ status: 204, body: '' });
    return route.continue();
  });
  await page.goto(`${runtime.base}/#${hash}`);
  return { page, context, fixture };
}

async function replaceSettingsForm(page, trigger) {
  const oldForm = await page.locator('#aiSettingsForm').elementHandle();
  await trigger();
  await page.waitForFunction(form => !form.isConnected, oldForm);
  await page.locator('#aiSettingsForm').waitFor({ state: 'attached' });
  await oldForm.dispose();
}

test('workspace presentation preserves existing flows and unsaved settings', { skip: !chrome }, async t => {
  const runtime = await startServer({ env: {
    OPERATIONS_ANALYTICS_ENABLED: 'false', LOGIN_STATUS_POLL_ENABLED: 'false', ISSUE_DIAGNOSIS_ENABLED: 'false',
    RAG_BASE_URL: '', RAG_AUTO_START: 'false', RAG_ADMIN_ENABLED: 'false', RAG_FORMAL_ROUTING_ENABLED: 'false',
    CONTENT_LIBRARY_SIGNAL_ROOT: '', CONTENT_LIBRARY_EDITING_ROOT: '', CONTENT_LIBRARY_CREATION_ROOT: '', CONTENT_LIBRARY_SEED_ENABLED: 'false'
  } });
  t.after(async () => { await stopChild(runtime.child); cleanupDir(runtime.dir); });
  const browser = await chromium.launch({ executablePath: chrome, headless: true });
  t.after(() => browser.close());

  await t.test('selecting library content replaces an already open publish draft', async child => {
    const { page, context, fixture } = await mockPage(browser, runtime, 'publishing');
    child.after(() => context.close());
    await page.locator('#publishTitle').fill('未替换的旧标题');
    await page.locator('#publishBody').fill('未替换的旧正文');
    await page.locator('#pickFromContentLibrary').click();
    await page.frameLocator('dialog.content-library-picker iframe').locator('#select').click();
    await page.waitForFunction(() => document.querySelector('#publishTitle')?.value === '素材库的新标题');
    assert.equal(await page.locator('#publishBody').inputValue(), '素材库的新正文');
    assert.equal(await page.locator('#materialPath').inputValue(), 'review-library.mp4');
    assert.equal(await page.locator('dialog.content-library-picker').count(), 0);
    assert.deepEqual(fixture.writes, []);
    assert.deepEqual(fixture.errors, []);
  });

  await t.test('cross-section actions keep drafts and saving clears only the saved secret', async child => {
    const { page, context, fixture } = await mockPage(browser, runtime, 'services');
    child.after(() => context.close());
    await page.locator('#aiSettingsForm [name=model]').fill('unsaved-model');
    await page.locator('#aiSettingsForm [name=apiKey]').fill('fake-unsaved-key');
    assert.equal(await page.locator('#aiConnectionTest').isDisabled(), true);
    await page.locator('[data-workspace-item=notifications]').click();
    await page.locator('#wecomForm [name=webhookUrl]').fill('https://example.invalid/fake-unsaved-webhook');
    await replaceSettingsForm(page, () => page.locator('#wecomTest').click());
    assert.equal(await page.locator('#aiSettingsForm [name=model]').inputValue(), 'unsaved-model');
    assert.equal(await page.locator('#aiSettingsForm [name=apiKey]').inputValue(), 'fake-unsaved-key');
    assert.equal(await page.locator('#aiConnectionTest').isDisabled(), true, '恢复的未保存草稿仍不能测试服务端旧配置');
    assert.match(await page.locator('#aiConnectionTestNote').textContent(), /尚未保存/);
    await page.locator('[data-workspace-item=services]').click();
    await replaceSettingsForm(page, () => page.locator('#aiSettingsForm button[type=submit]').click());
    assert.equal(await page.locator('#aiSettingsForm [name=apiKey]').inputValue(), '');
    assert.equal(await page.locator('#aiSettingsForm [name=model]').inputValue(), 'unsaved-model');
    assert.equal(await page.locator('#wecomForm [name=webhookUrl]').inputValue(), 'https://example.invalid/fake-unsaved-webhook');
    assert.equal(await page.locator('#aiConnectionTest').isDisabled(), false);
    await replaceSettingsForm(page, () => page.locator('#aiConnectionTest').click());
    assert.equal(await page.locator('#wecomForm [name=webhookUrl]').inputValue(), 'https://example.invalid/fake-unsaved-webhook');
    assert.equal(await page.locator('#aiSettingsForm [name=apiKey]').inputValue(), '', '保存的 Key 不得在后续刷新回填');
    await page.locator('#aiSettingsForm [name=model]').fill('second-unsaved-model');
    await page.locator('#aiSettingsForm [name=apiKey]').fill('second-fake-key');
    await page.locator('[data-workspace-item=notifications]').click();
    await replaceSettingsForm(page, () => page.locator('#wecomForm button[type=submit]').click());
    assert.equal(await page.locator('#wecomForm [name=webhookUrl]').inputValue(), '');
    assert.equal(await page.locator('#aiSettingsForm [name=model]').inputValue(), 'second-unsaved-model');
    assert.equal(await page.locator('#aiSettingsForm [name=apiKey]').inputValue(), 'second-fake-key');
    assert.equal(await page.locator('#aiConnectionTest').isDisabled(), true);
    assert.deepEqual(fixture.writes, ['/api/settings/wecom/test', '/api/settings/ai', '/api/settings/ai/test', '/api/settings/wecom']);
    assert.deepEqual(fixture.errors, []);
  });

  await t.test('clicking the failed section retries its read request', async child => {
    const { page, context, fixture } = await mockPage(browser, runtime, 'services', { failAi: true });
    child.after(() => context.close());
    await page.getByText('页面加载失败：模拟加载失败', { exact: true }).waitFor();
    const reads = fixture.aiReads;
    fixture.failAi = false;
    await page.locator('[data-workspace-item=services]').click();
    await page.locator('#aiSettingsForm').waitFor({ state: 'visible' });
    assert.equal(fixture.aiReads, reads + 1);
    assert.doesNotMatch(await page.locator('#content').textContent(), /页面加载失败/);
    assert.deepEqual(fixture.writes, []);
    assert.deepEqual(fixture.errors, []);
  });

  await t.test('the cached creation workspace keeps its current page title', async child => {
    const { page, context, fixture } = await mockPage(browser, runtime, 'studio');
    child.after(() => context.close());
    await page.waitForFunction(() => document.querySelector('#pageTitle')?.textContent === 'AI生成');
    const frame = await page.locator('#hotTopicWorkspace iframe').elementHandle();
    await page.locator('[data-workspace=publishing]').click();
    await page.locator('#publishForm').waitFor({ state: 'visible' });
    await page.locator('[data-workspace=content]').click();
    await page.waitForFunction(() => !document.querySelector('#content').hasAttribute('aria-busy'));
    assert.equal(await page.locator('#pageTitle').textContent(), 'AI生成');
    assert.equal(await frame.evaluate(element => element.isConnected && !element.parentElement.hidden), true);
    await frame.dispose();
    assert.deepEqual(fixture.writes, []);
    assert.deepEqual(fixture.errors, []);
  });
});
