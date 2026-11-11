import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { startServer, stopChild, cleanupDir } from './helpers/runtime.js';

const chrome = [process.env.CHROME_EXECUTABLE_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/chromium'].filter(Boolean).find(file => fs.existsSync(file));
const signalBase = '/integrations/ai-signal/';

for (const width of [1440, 390]) test(`创作导航与系统设置迁移 ${width}px`, { skip: !chrome }, async t => {
  const runtime = await startServer({ env: { RAG_AUTO_START: 'false', RAG_ADMIN_ENABLED: 'false', OPERATIONS_ANALYTICS_ENABLED: 'false', LOGIN_STATUS_POLL_ENABLED: 'false', ISSUE_DIAGNOSIS_ENABLED: 'false', VIDEO_STUDIO_DATA_DIR: '', VIDEO_STUDIO_UPSTREAM_URL: '' } });
  t.after(async () => { await stopChild(runtime.child); cleanupDir(runtime.dir); });
  const browser = await chromium.launch({ executablePath: chrome, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width, height: 1000 } });
  page.setDefaultTimeout(10000);
  const errors = [], writes = [];
  page.on('pageerror', error => errors.push(error.message));
  const signalState = { config: { llm: { provider: 'ollama', base_url: 'http://model.invalid/v1', model: 'test-model' }, tts: { provider: 'edge', edge_voice: 'zh-CN-YunjianNeural', rate: '+15%' } }, job: { status: 'idle', step: '' }, feed: { collected_at: 'isolated', candidates: [], discussions: [], sources: [] }, runs: [], comparisons: [], styles: [] };
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    const json = data => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, ...data }) });
    if (url.origin !== runtime.base) return route.abort();
    if (!['GET', 'HEAD'].includes(request.method())) {
      writes.push({ url: url.pathname, body: request.postDataJSON() });
      if (url.pathname === signalBase + 'api/config') { Object.assign(signalState.config.llm, request.postDataJSON().llm); return json({}); }
      if (url.pathname === signalBase + 'api/test-model') return json({ model: 'test-model' });
      return route.fulfill({ status: 400, contentType: 'application/json', body: '{"error":"unexpected isolated write"}' });
    }
    if (url.pathname === '/video-workbench/api/studio/bootstrap') return json({ videos: [], skills: Array.from({ length: 6 }, (_, index) => ({ id: 'style-' + index, title: '方案 ' + index })), tools: [], sessions: [], collections: [], automaticUrl: signalBase });
    if (/\/api\/studio\/(materials|outputs)$/.test(url.pathname)) return json({ items: [] });
    if (url.pathname === signalBase + 'api/state') return json(signalState);
    if (url.pathname.startsWith(signalBase)) {
      const name = url.pathname.slice(signalBase.length) || 'index.html';
      if (['index.html', 'app.js', 'style.css', 'hot-sources.js'].includes(name)) {
        let body = fs.readFileSync(path.join('engines/ai-signal-studio/web', name));
        if (name === 'index.html') body = body.toString().replace('__SIGNAL_BASE_PATH__', signalBase);
        return route.fulfill({ contentType: name.endsWith('.html') ? 'text/html' : name.endsWith('.css') ? 'text/css' : 'application/javascript', body });
      }
      return route.abort();
    }
    return route.continue();
  });
  await page.goto(runtime.base + '/#studio');
  const studio = page.frameLocator('#hotTopicWorkspace > iframe');
  const automatic = studio.frameLocator('#automaticFrame');
  await studio.locator('#creationHome').waitFor();
  assert.deepEqual(await studio.locator('.method-nav a').allTextContents(), ['创作方式', '素材库']);
  assert.deepEqual(await studio.locator('.creation-route h3').allTextContents(), ['自动成片', '素材智剪']);
  assert.equal(await studio.locator('#creationHome a[href="#creation"]').count(), 0);
  if (process.env.CREATION_NAV_EVIDENCE_DIR) {
    fs.mkdirSync(process.env.CREATION_NAV_EVIDENCE_DIR, { recursive: true });
    await page.screenshot({ path: path.join(process.env.CREATION_NAV_EVIDENCE_DIR, `content-${width}.png`), fullPage: true });
  }
  const frameHandle = await page.locator('#hotTopicWorkspace > iframe').elementHandle();
  await studio.locator('.creation-route a[href="#automatic/create"]').click();
  await automatic.locator('#topics.active').waitFor();
  assert.equal(await studio.locator('[data-studio-route=overview]').getAttribute('class'), 'method-link active');
  await studio.locator('.method-nav [data-studio-route=overview]').click();
  await studio.locator('.creation-route a[href="#editing"]').click();
  await studio.locator('#chatInput').fill('保留制作草稿');
  await studio.locator('.method-nav [data-studio-route=overview]').click();
  await studio.locator('.creation-route a[href="#editing"]').click();
  assert.equal(await studio.locator('#chatInput').inputValue(), '保留制作草稿');
  await studio.locator('.method-nav [data-studio-route=materials]').click();
  await studio.locator('#videoSearch').fill('保留素材筛选');
  await page.locator('#nav [data-workspace=settings]').click();
  await page.locator('[data-workspace-item=creation-settings]').click();
  await automatic.locator('#settings.active').waitFor();
  await automatic.locator('#model').fill('unsaved-creation-model');
  assert.equal(await page.locator('#pageTitle').innerText(), '创作设置');
  assert.equal(await page.locator('#nav [data-workspace=settings]').getAttribute('aria-current'), 'page');
  assert.equal(await page.locator('#workspaceSubnav').isVisible(), true);
  assert.equal(await studio.locator('.studio-topbar').isVisible(), false);
  assert.equal(await automatic.locator('aside').isVisible(), false);
  const settingsFrameBounds = await page.locator('#hotTopicWorkspace>iframe').boundingBox();
  assert.ok(settingsFrameBounds.height >= 1000 - settingsFrameBounds.y - 2, JSON.stringify(settingsFrameBounds));
  if (process.env.CREATION_NAV_EVIDENCE_DIR) {
    const bounds = {
      root: await page.locator('.shell>main,#hotTopicWorkspace,#hotTopicWorkspace>iframe').evaluateAll(items => items.map(item => ({ name: item.id || item.tagName, height: item.getBoundingClientRect().height, flex: getComputedStyle(item).flex, display: getComputedStyle(item).display }))),
      studio: await studio.locator('.app-shell,.workspace-shell,#main,#automaticWorkspace,#automaticFrame').evaluateAll(items => items.map(item => ({ name: item.id || item.className, height: item.getBoundingClientRect().height })))
    };
    fs.writeFileSync(path.join(process.env.CREATION_NAV_EVIDENCE_DIR, `bounds-${width}.json`), JSON.stringify(bounds, null, 2));
  }
  await page.locator('#nav [data-workspace=content]').click();
  await studio.locator('#panel-library').waitFor();
  assert.equal(await studio.locator('#videoSearch').inputValue(), '保留素材筛选');
  assert.equal(await frameHandle.evaluate(element => element === document.querySelector('#hotTopicWorkspace > iframe')), true);
  assert.equal(await studio.locator('.studio-topbar').isVisible(), true);
  await page.locator('#nav [data-workspace=settings]').click();
  await automatic.locator('#settings.active').waitFor();
  assert.equal(await automatic.locator('#model').inputValue(), 'unsaved-creation-model');
  await automatic.locator('#settings-form').evaluate(form => form.requestSubmit());
  await automatic.locator('#toast').filter({ hasText: '创作设置已保存' }).waitFor({ state: 'visible' });
  assert.equal(writes[0].url, signalBase + 'api/config');
  assert.equal(writes[0].body.llm.model, 'unsaved-creation-model');
  await automatic.locator('#test-model').click();
  await automatic.locator('#model-test-status').filter({ hasText: '连接成功' }).waitFor();
  assert.deepEqual(writes.map(item => item.url), [signalBase + 'api/config', signalBase + 'api/config', signalBase + 'api/test-model']);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.equal(await automatic.locator('body').evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  if (process.env.CREATION_NAV_EVIDENCE_DIR) {
    await automatic.locator('#provider').scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(process.env.CREATION_NAV_EVIDENCE_DIR, `settings-${width}.png`), fullPage: true });
  }
  await page.locator('#nav [data-workspace=content]').click();
  await studio.locator('.method-nav').waitFor();
  await studio.locator('body').evaluate(() => { location.hash = 'settings'; });
  await page.waitForURL('**/#creation-settings');
  assert.equal(await page.locator('#nav [data-workspace=settings]').getAttribute('aria-current'), 'page');
  await page.goto(runtime.base + '/#creation-settings');
  await page.frameLocator('#hotTopicWorkspace > iframe').frameLocator('#automaticFrame').locator('#settings.active').waitFor();
  assert.equal(await page.locator('#nav [data-workspace=settings]').getAttribute('aria-current'), 'page');
  assert.deepEqual(errors, []);
});
