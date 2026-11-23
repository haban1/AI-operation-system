import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { chromium } from 'playwright-core';
import sharp from 'sharp';
import { capturePageEvidence, createBackgroundPage, focusInteractivePage, isBackgroundPage } from '../agent/browser-control/collection-pages.js';
import { launchQuietPersistentContext } from '../agent/browser-control/quiet-persistent-context.js';
import { createRpaRegistry, supportedPlatforms } from '../agent/rpa-adapters/registry.js';
import { cleanupDir, tempRuntimeDir } from './helpers/runtime.js';

const executablePath = [
  process.env.CHROME_EXECUTABLE_PATH, chromium.executablePath(),
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/usr/bin/chromium', '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
].find(file => file && fs.existsSync(file));
const origin = 'https://collection.test';

async function windowState(page) {
  const session = await page.context().newCDPSession(page);
  try { return await session.send('Browser.getWindowForTarget'); } finally { await session.detach(); }
}

for (const platformCode of supportedPlatforms) {
  test(`${platformCode}: concurrent background collection preserves the operator's draft and login`, { skip: !executablePath }, async t => {
    const dir = tempRuntimeDir('quiet-collection-');
    const context = await chromium.launchPersistentContext(dir, { executablePath, headless: true, viewport: null })
      .catch(error => { cleanupDir(dir); throw error; });
    t.after(async () => { try { await context.close(); } finally { cleanupDir(dir); } });
    await context.route('**/*', route => {
      if (new URL(route.request().url()).origin !== origin) return route.abort();
      return route.fulfill({ contentType: 'text/html', body:
        '<body style="margin:0;background:#c15a92"><textarea aria-label="Draft"></textarea><button onclick="document.title=document.cookie">Read data</button></body>'
      });
    });
    const registry = createRpaRegistry({ mode: 'five_platform_assisted', logsDir: dir, xiaohongshu: { profileDir: dir } });
    const adapter = registry.get(platformCode);
    adapter.ensureContext = async () => context;
    const operator = await adapter.getPage({ bringToFront: true });
    await operator.goto(origin + '/operator');
    await operator.getByRole('textbox', { name: 'Draft' }).fill('unsaved draft');
    await operator.evaluate(() => { document.cookie = 'fixture=local; path=/'; });
    const operatorWindow = await windowState(operator);

    const activations = [];
    const watchActivation = page => {
      const activate = page.bringToFront.bind(page);
      t.mock.method(page, 'bringToFront', async () => { activations.push(page); return activate(); });
    };
    context.pages().forEach(watchActivation);
    context.on('page', watchActivation);
    const pages = await Promise.all([
      ...(platformCode === 'xiaohongshu'
        ? [adapter.getPage(), adapter.getMainSitePage()]
        : [adapter.getChannelPage('COMMENT'), adapter.getChannelPage('PRIVATE_MESSAGE')]),
      adapter.createBackgroundPage(context),
      ...(platformCode === 'weibo' ? [adapter.getLoginInspectionPage()] : [])
    ]);
    assert.equal(new Set([operator, ...pages]).size, 1 + pages.length);
    assert.ok(pages.every(isBackgroundPage));
    const windows = await Promise.all(pages.map(windowState));
    assert.equal(new Set([operatorWindow, ...windows].map(w => w.windowId)).size, 1 + pages.length);
    assert.ok(windows.every(w => w.bounds.windowState === 'minimized'));
    await Promise.all(pages.map(async (page, i) => {
      await page.goto(origin + '/collection/' + i);
      await page.getByRole('button', { name: 'Read data' }).click({ timeout: 5000 });
      assert.equal(await page.title(), 'fixture=local');
    }));
    const png = await capturePageEvidence(pages[0]);
    const pixel = await sharp(png).extract({ left: 5, top: 60, width: 1, height: 1 }).removeAlpha().raw().toBuffer();
    assert.deepEqual([...pixel], [193, 90, 146]);
    const reused = platformCode === 'xiaohongshu' ? await adapter.getPage() : await adapter.getChannelPage('COMMENT');
    assert.equal(reused, pages[0]);
    assert.deepEqual(activations, []);
    await focusInteractivePage(pages[0]);
    assert.deepEqual(activations, []);
    await pages[2].close();
    assert.equal(operator.url(), origin + '/operator');
    assert.equal(await operator.getByRole('textbox', { name: 'Draft' }).inputValue(), 'unsaved draft');
    assert.equal(await operator.evaluate(() => document.activeElement?.tagName), 'TEXTAREA');
    assert.equal(await adapter.getPage({ bringToFront: true }), operator);
    assert.deepEqual(activations, [operator]);
  });
}

test('cold collection opens minimized, while explicit handoff restores the matching window', { skip: !executablePath }, async t => {
  const dir = tempRuntimeDir('quiet-cold-');
  const context = await launchQuietPersistentContext(dir, { executablePath, headless: true })
    .catch(error => { cleanupDir(dir); throw error; });
  t.after(async () => { try { await context.close(); } finally { cleanupDir(dir); } });
  assert.equal(context.pages().length, 0);
  const [worker, handoff] = await Promise.all([createBackgroundPage(context), createBackgroundPage(context, { forHandoff: true })]);
  const workingWindow = await windowState(worker);
  const challengeWindow = await windowState(handoff);
  assert.notEqual(workingWindow.windowId, challengeWindow.windowId);
  assert.equal(workingWindow.bounds.windowState, 'minimized');
  assert.equal(challengeWindow.bounds.windowState, 'minimized');
  await handoff.setContent('<p>Fixture verification</p>');
  await focusInteractivePage(handoff);
  assert.equal((await windowState(handoff)).windowId, challengeWindow.windowId);
  assert.equal((await windowState(handoff)).bounds.windowState, 'normal');
  assert.equal(await handoff.locator('p').textContent(), 'Fixture verification');
  assert.equal((await windowState(worker)).bounds.windowState, 'minimized');
});

test('when a minimized window cannot be confirmed, the agent closes only its target and does not open a normal tab', async () => {
  const calls = [];
  const browserSession = {
    async send(name, params) {
      calls.push([name, params]);
      if (name === 'Target.createTarget') return { targetId: 'own-target' };
      if (name === 'Browser.getWindowForTarget') return { bounds: { windowState: 'normal' } };
    },
    async detach() {}
  };
  const context = { pages: () => [], browser: () => ({ newBrowserCDPSession: async () => browserSession }) };
  await assert.rejects(createBackgroundPage(context));
  const [open, inspect, close] = calls;
  assert.equal(calls.length, 3);
  assert.equal(open[0], 'Target.createTarget');
  assert.deepEqual({ ...open[1], url: '' }, { url: '', newWindow: true, windowState: 'minimized', background: true, focus: false });
  assert.deepEqual(inspect, ['Browser.getWindowForTarget', { targetId: 'own-target' }]);
  assert.deepEqual(close, ['Target.closeTarget', { targetId: 'own-target' }]);
});
