import test from 'node:test';
import { revealControl } from './helpers/ui-details.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chromium } from 'playwright-core';
import { startServer, stopChild, cleanupDir, openWorkspacePage } from './helpers/runtime.js';

const chrome = [
  process.env.CHROME_EXECUTABLE_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/chromium'
].filter(Boolean).find(candidate => fs.existsSync(candidate));
const groups = ['overview', 'content', 'publishing', 'inbox', 'wechat', 'knowledge', 'channels', 'settings'];
const mockReads = {
  '/video-workbench/api/studio/bootstrap': {
    videos: [], collections: [], sessions: [], slogans: [], automaticUrl: '/workspace-test-automatic/',
    skills: Array.from({ length: 6 }, (_, index) => ({ id: `workflow-${index}`, title: `制作工作流${index + 1}` })),
    tools: ['codex', 'chatcut', 'remotion', 'hyperframe'].map(id => ({ id, name: id, status: 'ready' }))
  },
  '/video-workbench/api/studio/outputs': { items: [] },
  '/video-workbench/api/studio/materials': { items: [] },
  '/api/knowledge-aliases': { aliases: [] },
  '/api/knowledge-alias-generation-tasks': { tasks: [] },
  '/api/knowledge': { knowledge: [] },
  '/api/browser-control/summary': { browserControl: { enabled: false, enabledPlatforms: [] } },
  '/api/browser-control/commands': { commands: [] },
  '/api/issues': { issues: [] }
};

async function assertVisibleLabel(locator, expected) {
  await locator.waitFor({ state: 'visible' });
  await locator.scrollIntoViewIfNeeded();
  const actual = await locator.evaluate(element => {
    const rect = element.getBoundingClientRect();
    let visible = rect.width > 0 && rect.height > 0;
    for (let ancestor = element; ancestor; ancestor = ancestor.parentElement) {
      const style = getComputedStyle(ancestor);
      if (style.display === 'none' || style.visibility !== 'visible' || Number(style.opacity) === 0) visible = false;
    }
    return {
      text: element.innerText.trim(),
      visible: visible && rect.right > 0 && rect.bottom > 0 && rect.left < innerWidth && rect.top < innerHeight
    };
  });
  assert.match(actual.text, /[\u3400-\u9fff]/);
  if (expected) assert.equal(actual.text, expected);
  assert.equal(actual.visible, true, `标签必须实际可见：${actual.text}`);
}

for (const width of [1440, 390]) {
  test(`workspace controls and navigation remain readable at ${width}px`, { skip: !chrome }, async t => {
    const runtime = await startServer({ env: {
      OPERATIONS_ANALYTICS_ENABLED: 'false', LOGIN_STATUS_POLL_ENABLED: 'false', ISSUE_DIAGNOSIS_ENABLED: 'false',
      RAG_BASE_URL: '', RAG_AUTO_START: 'false', RAG_ADMIN_ENABLED: 'false', RAG_FORMAL_ROUTING_ENABLED: 'false',
      CONTENT_LIBRARY_SIGNAL_ROOT: '', CONTENT_LIBRARY_EDITING_ROOT: '', CONTENT_LIBRARY_CREATION_ROOT: '',
      CONTENT_LIBRARY_SEED_ENABLED: 'false'
    } });
    t.after(async () => { await stopChild(runtime.child); cleanupDir(runtime.dir); });
    const browser = await chromium.launch({ executablePath: chrome, headless: true });
    t.after(() => browser.close());
    const context = await browser.newContext({ viewport: { width, height: 1000 } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await context.route('**/*', async route => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin !== runtime.base) return route.abort();
      if (request.method() === 'GET' && Object.hasOwn(mockReads, url.pathname)) {
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, ...mockReads[url.pathname] }) });
      }
      return route.continue();
    });
    await page.goto(runtime.base);
    await page.locator('.operations-dashboard').waitFor();
    assert.deepEqual(await page.locator('#nav button[data-workspace]').evaluateAll(buttons => buttons.map(button => button.dataset.workspace)), groups);
    for (const group of groups) await assertVisibleLabel(page.locator(`#nav [data-workspace="${group}"] .ws-primary-label`));

    await openWorkspacePage(page, 'wecom');
    await page.locator('#aiSettingsForm').waitFor({state:'visible'});
    await revealControl(page.locator('[data-settings-config-toggle="wecom"]'));
    await assertVisibleLabel(page.locator('[data-settings-config-toggle="wecom"] .settings-toggle-copy b'), '企业微信通知');
    await assertVisibleLabel(page.locator('[data-settings-config-toggle="ai"] .settings-toggle-copy b'), 'AI 服务配置');
    await page.locator('details.side-status > summary').click();
    assert.equal(await page.locator('details.side-status').getAttribute('open'), '');
    await assertVisibleLabel(page.locator('#masterSwitch b'), '全局运行');

    for (const [name, key, ready] of [
      ['aliases', 'aliases', '#aliasRefresh'],
      ['browser', 'browser-tools', '#browserRefresh'],
      ['issues', 'diagnostics', '#content h2']
    ]) {
      await openWorkspacePage(page, name);
      await page.locator(ready).first().waitFor({ state: 'visible' });
      await assertVisibleLabel(page.locator(`#workspaceSubnav [data-workspace-item="${key}"] span`));
      assert.doesNotMatch(await page.locator('#content').innerText(), /页面加载失败/);
    }

    await page.goto(`${runtime.base}/video-workbench/index.html`);
    assert.equal(await page.locator('.studio-topbar').count(), 1, '验证实际内容引擎 dist 页面');
    for (const [method, label] of [['automatic', '自动成片'], ['mix', '素材智剪'], ['materials', '素材库']]) {
      await assertVisibleLabel(page.locator(`[data-method="${method}"]`), label);
    }
    await page.locator('[data-method="mix"]').click();
    for (const tab of ['library', 'create', 'assets']) await assertVisibleLabel(page.locator(`[data-tab="${tab}"]`));
    await page.locator('[data-tab="create"]').click();
    await page.locator('[data-skill]').first().waitFor();
    assert.equal(await page.locator('[data-skill]').count(), 6);
    for (const id of ['moduleText', 'modulePip', 'moduleTransitions', 'moduleMusic', 'moduleVoice', 'chatInput', 'sendMessage', 'sessionSelect', 'pickAssets']) {
      await page.locator(`#${id}`).scrollIntoViewIfNeeded();
      assert.equal(await page.locator(`#${id}`).isVisible(), true, `原制作功能仍应可达：${id}`);
    }
    for (const tool of await page.locator('#toolList .tool-row').all()) {
      await tool.scrollIntoViewIfNeeded();
      assert.equal(await tool.evaluate(element => {
        const rect = element.getBoundingClientRect();
        const clip = document.querySelector('.creation-config').getBoundingClientRect();
        return rect.top >= Math.max(0, clip.top) && rect.bottom <= Math.min(innerHeight, clip.bottom);
      }), true, '工具状态应可在制作配置区内滚动查看');
    }
    await page.locator('[data-tab="assets"]').click();
    await assertVisibleLabel(page.locator('#addCollection'), '映射目录');
    await page.locator('[data-asset-kind="company"]').click();
    await assertVisibleLabel(page.locator('#addSlogan'), '添加标语');
    await page.locator('[data-method="materials"]').click();
    await page.locator('#outputSourceFilter').waitFor({ state: 'visible' });
    await page.locator('#outputStatusFilter').waitFor({ state: 'visible' });
    assert.deepEqual(errors, []);
  });
}
