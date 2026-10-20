import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright-core';
import { pathInsideRoots } from '../../../src/services/browser-control-policy.js';

function providerError(code, message, detail = null) {
  const error = new Error(message);
  error.code = code;
  error.detail = detail;
  return error;
}

export class PlaywrightBrowserProvider {
  constructor({ executablePath, platformProfiles = {}, requestTimeoutMs = 30_000, fileRoots = [] } = {}) {
    this.name = 'playwright';
    this.executablePath = executablePath;
    this.platformProfiles = platformProfiles;
    this.requestTimeoutMs = requestTimeoutMs;
    this.fileRoots = fileRoots.map(item => path.resolve(item));
    this.contexts = new Map();
    this.pages = new Map();
  }

  async contextFor(platformCode) {
    if (this.contexts.has(platformCode)) return this.contexts.get(platformCode);
    const profileDir = this.platformProfiles[platformCode];
    if (!profileDir) throw providerError('PLAYWRIGHT_PROFILE_NOT_CONFIGURED', `平台 ${platformCode} 未配置 Playwright Profile`);
    const context = await chromium.launchPersistentContext(profileDir, {
      executablePath: this.executablePath,
      headless: false,
      timeout: this.requestTimeoutMs
    });
    this.contexts.set(platformCode, context);
    context.on('close', () => {
      this.contexts.delete(platformCode);
      for (const [id, item] of this.pages.entries()) if (item.platformCode === platformCode) this.pages.delete(id);
    });
    return context;
  }

  pageFor(id) {
    const item = this.pages.get(id);
    if (!item || item.page.isClosed()) throw providerError('BROWSER_MANAGED_TAB_NOT_FOUND', `受管标签页不存在或已关闭：${id || 'EMPTY'}`);
    return item.page;
  }

  assertFiles(files = []) {
    for (const file of files) {
      if (!pathInsideRoots(file, this.fileRoots)) throw providerError('BROWSER_FILE_PATH_BLOCKED', `文件不在允许目录中：${file}`, { roots: this.fileRoots });
      if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw providerError('BROWSER_FILE_NOT_FOUND', `文件不存在：${file}`);
    }
  }

  async execute(command, context = {}) {
    if (command.action === 'HEALTH_CHECK') {
      return { status: 'ok', connected: true, provider: this.name, contexts: this.contexts.size, managedTabs: this.pages.size };
    }
    if (command.action === 'OPEN_PAGE') {
      const browserContext = await this.contextFor(command.platformCode);
      const page = await browserContext.newPage();
      page.setDefaultTimeout(this.requestTimeoutMs);
      await page.goto(command.params.url, { waitUntil: 'domcontentloaded', timeout: this.requestTimeoutMs });
      const managedTabId = randomUUID();
      this.pages.set(managedTabId, { page, platformCode: command.platformCode, sessionId: context.sessionId });
      page.once('close', () => this.pages.delete(managedTabId));
      return { opened: true, managedTabId, url: page.url(), title: await page.title() };
    }
    const page = this.pageFor(context.managedTabId);
    switch (command.action) {
      case 'NAVIGATE':
        await page.goto(command.params.url, { waitUntil: 'domcontentloaded', timeout: this.requestTimeoutMs });
        return { managedTabId: context.managedTabId, url: page.url(), title: await page.title() };
      case 'READ_PAGE_STATE':
        return { managedTabId: context.managedTabId, title: await page.title(), url: page.url(), ready: await page.evaluate(() => document.readyState) };
      case 'READ_TEXT': {
        const selector = command.params.selector || 'body';
        const locator = page.locator(selector).first();
        const found = await locator.count() > 0;
        const text = found ? String(await locator.innerText({ timeout: this.requestTimeoutMs })).slice(0, command.params.maxChars) : '';
        return { managedTabId: context.managedTabId, selector, found, text };
      }
      case 'CLICK':
        await page.locator(command.params.selector).first().click({ timeout: this.requestTimeoutMs });
        return { managedTabId: context.managedTabId, clicked: true, method: 'playwright' };
      case 'CLICK_AT': {
        const box = await page.locator(command.params.selector).first().boundingBox();
        if (!box) throw providerError('BROWSER_SELECTOR_NOT_VISIBLE', `元素不可见：${command.params.selector}`);
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        return { managedTabId: context.managedTabId, clicked: true, method: 'playwright-mouse' };
      }
      case 'SCROLL': {
        const { direction, y } = command.params;
        await page.evaluate(({ direction, y }) => {
          if (direction === 'top') window.scrollTo(0, 0);
          else if (direction === 'bottom') window.scrollTo(0, document.body.scrollHeight);
          else window.scrollBy(0, direction === 'up' ? -y : y);
        }, { direction, y });
        return { managedTabId: context.managedTabId, scrolled: true, direction, y };
      }
      case 'SET_FILES':
        this.assertFiles(command.params.files);
        await page.locator(command.params.selector).first().setInputFiles(command.params.files);
        return { managedTabId: context.managedTabId, files: command.params.files.length };
      case 'SCREENSHOT':
        await page.screenshot({ path: context.evidencePath, fullPage: false });
        return { managedTabId: context.managedTabId, evidenceRef: context.evidencePath };
      case 'CLOSE_TAB':
        await page.close();
        return { closed: true, managedTabId: null };
      default:
        throw providerError('BROWSER_ACTION_NOT_IMPLEMENTED', `Playwright Provider 尚未实现动作 ${command.action}`);
    }
  }

  async stopPlatform(platformCode) {
    const context = this.contexts.get(platformCode);
    if (context) await context.close();
  }

  async stop() {
    await Promise.allSettled([...this.contexts.values()].map(context => context.close()));
    this.contexts.clear();
    this.pages.clear();
  }
}
