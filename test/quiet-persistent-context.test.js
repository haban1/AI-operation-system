import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chromium } from 'playwright-core';
import { launchQuietPersistentContext } from '../agent/browser-control/quiet-persistent-context.js';
import { tempRuntimeDir, cleanupDir } from './helpers/runtime.js';

const executablePath = [process.env.CHROME_EXECUTABLE_PATH, process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/chromium', chromium.executablePath()]
  .find(candidate => candidate && fs.existsSync(candidate));

test('quiet cold start creates no page and reuses the same persistent profile', { skip: !executablePath }, async () => {
  const dir = tempRuntimeDir('quiet-persistent-');
  const options = { executablePath, headless: true, timeout: 15000 };
  let context;
  try {
    context = await chromium.launchPersistentContext(dir, options);
    await context.addCookies([{ name: 'synthetic', value: 'ok', url: 'https://quiet.invalid',
      expires: Math.floor(Date.now() / 1000) + 3600 }]);
    await context.close();
    context = await launchQuietPersistentContext(dir, options);
    assert.deepEqual(context.pages(), []);
    assert.ok((await context.cookies('https://quiet.invalid')).some(c => c.name === 'synthetic' && c.value === 'ok'));
    const cdp = await context.browser().newBrowserCDPSession();
    const { arguments: args } = await cdp.send('Browser.getBrowserCommandLine');
    assert.ok(args.includes('--no-startup-window') && args.includes('--remote-debugging-pipe'));
    assert.ok(!args.some(arg => arg === 'about:blank' || arg.startsWith('--remote-debugging-port')));
    if (process.platform === 'win32') assert.ok(!args.includes('--no-sandbox'));
    const { targetInfos } = await cdp.send('Target.getTargets');
    assert.ok(!targetInfos.some(item => item.type === 'page'));
    await cdp.detach();
    await context.setOffline(true);
    const page = await context.newPage();
    await page.setContent('<button>Go</button>');
    assert.equal(await page.locator('button').textContent(), 'Go');
    await context.close();
    context = await launchQuietPersistentContext(dir, options);
    assert.equal(context.pages().length, 0);
    assert.ok((await context.cookies('https://quiet.invalid')).some(c => c.name === 'synthetic' && c.value === 'ok'));
  } finally {
    try { await context?.close(); } finally { cleanupDir(dir); }
  }
});
