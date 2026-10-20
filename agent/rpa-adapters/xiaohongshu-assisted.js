import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { forceStopProfileProcesses, listWindowsProcesses, profileProcessTreeIds } from '../platform-process-cleanup.js';
import { resolveUploadTimeoutMs } from '../publish-upload-timeout.js';
import { RpaAdapter } from './base.js';
import { analyzePublishReadiness } from './publish-guard.js';
import { findVisibleTitleRecord, platformPostIdentity } from './assisted-platform.js';

const imageExt = new Set(['.jpg', '.jpeg', '.png', '.webp']);
const videoExt = new Set(['.mp4', '.mov']);

function privateConversationSelector(conversationId) {
  const escaped = String(conversationId).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n\f]/g, char => `\\${char.charCodeAt(0).toString(16)} `);
  return `.xhs-im-conv-item[data-conv-id="${escaped}"]`;
}

function platformTime(label, reference = new Date()) {
  const text = String(label || '').trim();
  if (!text) return null;
  if (/刚刚/.test(text)) return reference;
  let match = text.match(/(\d+)\s*分钟前/);
  if (match) return new Date(reference.getTime() - Number(match[1]) * 60 * 1000);
  match = text.match(/(\d+)\s*小时前/);
  if (match) return new Date(reference.getTime() - Number(match[1]) * 60 * 60 * 1000);
  match = text.match(/^今天\s*(\d{1,2}):(\d{2})$/);
  if (match) return new Date(reference.getFullYear(), reference.getMonth(), reference.getDate(), Number(match[1]), Number(match[2]));
  match = text.match(/^昨天(?:\s*(\d{1,2}):(\d{2}))?$/);
  if (match) return new Date(reference.getFullYear(), reference.getMonth(), reference.getDate() - 1, Number(match[1] || 23), Number(match[2] || 59), 59);
  match = text.match(/^前天(?:\s*(\d{1,2}):(\d{2}))?$/);
  if (match) return new Date(reference.getFullYear(), reference.getMonth(), reference.getDate() - 2, Number(match[1] || 23), Number(match[2] || 59), 59);
  match = text.match(/^(\d{1,2}):(\d{2})$/);
  if (match) return new Date(reference.getFullYear(), reference.getMonth(), reference.getDate(), Number(match[1]), Number(match[2]));
  match = text.match(/^(\d{1,2})[-/](\d{1,2})(?:\s+(\d{1,2}):(\d{2}))?$/) || text.match(/^(\d{1,2})月(\d{1,2})日(?:\s+(\d{1,2}):(\d{2}))?$/);
  if (match) {
    let value = new Date(reference.getFullYear(), Number(match[1]) - 1, Number(match[2]), Number(match[3] || 23), Number(match[4] || 59), 59);
    if (value.getTime() > reference.getTime() + 24 * 60 * 60 * 1000) value = new Date(reference.getFullYear() - 1, Number(match[1]) - 1, Number(match[2]), Number(match[3] || 23), Number(match[4] || 59), 59);
    return value;
  }
  match = text.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:\s+(\d{1,2}):(\d{2}))?$/);
  if (match) return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4] || 23), Number(match[5] || 59), 59);
  return null;
}

function recentPlatformTime(label, maxAgeHours = 24 * 7) {
  const value = platformTime(label);
  if (!value) return false;
  const age = Date.now() - value.getTime();
  return age >= -24 * 60 * 60 * 1000 && age <= maxAgeHours * 60 * 60 * 1000;
}

function stableUrlPath(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const parsed = new URL(raw);
    return parsed.hostname.toLowerCase() + parsed.pathname.replace(/\/+$/, '');
  } catch {
    return raw.split(/[?#]/, 1)[0];
  }
}

function stableDigest(parts) {
  return crypto.createHash('sha256')
    .update(parts.map(value => String(value || '').trim()).join('|'))
    .digest('hex')
    .slice(0, 32);
}

export function buildXhsCommentExternalId(item = {}) {
  return 'xhs-comment-' + stableDigest([
    item.eventType,
    stableUrlPath(item.profileUrl),
    item.userName,
    item.content,
    item.quote,
    stableUrlPath(item.thumbnailUrl)
  ]);
}

export function buildXhsPrivateExternalId(item = {}) {
  return 'xhs-private-' + stableDigest([item.conversationId, item.content]);
}


export function selectThumbnailNoteCandidate(scoredCandidates = [], { maxScore = 0.025, minMargin = 0.01 } = {}) {
  const ranked = scoredCandidates
    .filter(item => Number.isFinite(Number(item?.score)))
    .map(item => ({ ...item, score: Number(item.score) }))
    .sort((a, b) => a.score - b.score);
  const best = ranked[0];
  if (!best || best.score > maxScore) return null;
  const second = ranked[1];
  if (second && second.score - best.score < minMargin) return null;
  return best;
}


export class XiaohongshuAssistedRpaAdapter extends RpaAdapter {
  constructor({ logsDir, profileDir, executablePath, creatorUrl, loginTimeoutMs, sendTimeoutMs, uploadTimeoutOptions = {}, authorizeSubmit, browserRuntimeManager = null }) {
    super({ platformCode: 'xiaohongshu' });
    this.logsDir = logsDir;
    this.profileDir = profileDir;
    this.executablePath = executablePath;
    this.creatorUrl = creatorUrl;
    this.loginTimeoutMs = loginTimeoutMs;
    this.sendTimeoutMs = sendTimeoutMs;
    this.uploadTimeoutOptions = uploadTimeoutOptions;
    this.submitAuthorizer = typeof authorizeSubmit === 'function' ? authorizeSubmit : null;
    this.browserRuntimeManager = browserRuntimeManager;
    this.browserExecution = { providerRequested: 'web_access_cdp', providerUsed: null, fallbackUsed: false, fallbackReason: null };
    this.context = null;
    this.launching = null;
    this.profileProcessIds = [];
    fs.mkdirSync(logsDir, { recursive: true });
  }

  setSubmitAuthorizer(authorizer) {
    this.submitAuthorizer = typeof authorizer === 'function' ? authorizer : null;
  }

  async authorizeFinalSubmit(payload = {}, context = {}) {
    if (typeof this.submitAuthorizer !== 'function') {
      const error = new Error('小红书投稿锁服务不可用，禁止执行最终发布');
      error.code = 'SUBMIT_LOCK_UNAVAILABLE';
      throw error;
    }
    const authorization = await this.submitAuthorizer({ ...payload, platformCode: this.platformCode }, context);
    if (authorization?.authorized !== true || authorization?.submitLock !== 'LOCKED') {
      const error = new Error(authorization?.message || '小红书投稿锁未获授权，禁止执行最终发布');
      error.code = authorization?.code || 'SUBMIT_LOCK_DENIED';
      error.authorization = authorization || null;
      throw error;
    }
    return authorization;
  }

  async ensureContext() {
    await this.assertRuntimeAllowed();
    if (this.context) return this.context;
    const lifecycleGeneration = this.lifecycleGeneration;
    if (this.launching) return this.launching;
    if (lifecycleGeneration !== this.lifecycleGeneration) throw this.platformStoppedError();
    await this.assertRuntimeAllowed();
    if (lifecycleGeneration !== this.lifecycleGeneration) throw this.platformStoppedError();

    const launching = (async () => {
      if (this.browserRuntimeManager?.isPrimaryMode?.()) {
        try {
          const runtime = await this.browserRuntimeManager.acquirePlatformContext({
            platformCode: this.platformCode,
            profileDir: this.profileDir,
            executablePath: this.executablePath
          });
          await this.assertRuntimeAllowed();
          if (lifecycleGeneration !== this.lifecycleGeneration) throw this.platformStoppedError();
          this.context = runtime.context;
          this.browserExecution = {
            providerRequested: 'web_access_cdp',
            providerUsed: 'web_access_cdp',
            fallbackUsed: false,
            fallbackReason: null,
            compatibilityLayer: runtime.compatibilityLayer || 'playwright_connect_over_cdp',
            proxyPort: runtime.proxyPort,
            browserDebugPort: runtime.browserDebugPort
          };
          this.context.on('close', () => { if (this.context === runtime.context) this.context = null; });
          return this.context;
        } catch (error) {
          if (!this.browserRuntimeManager.shouldUseLegacyFallback?.(error)) throw error;
          this.browserExecution = {
            providerRequested: 'web_access_cdp',
            providerUsed: 'playwright',
            fallbackUsed: true,
            fallbackReason: { code: error.code || 'WEB_ACCESS_START_FAILED', message: error.message },
            compatibilityLayer: 'playwright_launch_persistent_context'
          };
          console.warn(`[WebAccess] ${this.platformCode} 主控启动失败，业务浏览器临时回退到原 Playwright：${error.message}`);
        }
      } else {
        this.browserExecution = {
          providerRequested: 'playwright',
          providerUsed: 'playwright',
          fallbackUsed: false,
          fallbackReason: null,
          compatibilityLayer: 'playwright_launch_persistent_context'
        };
      }

      fs.mkdirSync(this.profileDir, { recursive: true });
      const processSnapshot = await listWindowsProcesses().catch(() => []);
      const preexistingProfileProcessIds = profileProcessTreeIds(processSnapshot, this.profileDir);
      const context = await chromium.launchPersistentContext(this.profileDir, {
        headless: false,
        executablePath: this.executablePath,
        viewport: null,
        acceptDownloads: true,
        args: ['--start-maximized']
      });
      try {
        await this.assertRuntimeAllowed();
        if (lifecycleGeneration !== this.lifecycleGeneration) throw this.platformStoppedError();
        this.context = context;
        this.profileProcessIds = profileProcessTreeIds(await listWindowsProcesses().catch(() => []), this.profileDir)
          .filter(processId => !preexistingProfileProcessIds.includes(processId));
        context.on('close', () => { if (this.context === context) this.context = null; });
        return context;
      } catch (error) {
        await context.close().catch(() => {});
        throw error;
      }
    })().finally(() => {
      if (this.launching === launching) this.launching = null;
    });
    this.launching = launching;
    return launching;
  }

  async stop() {
    this.invalidatePendingOperations();
    const context = this.context;
    const launching = this.launching;
    const webAccessOwned = this.browserExecution?.providerUsed === 'web_access_cdp';
    this.context = null;
    if ('activePage' in this) this.activePage = null;
    if (webAccessOwned && this.browserRuntimeManager) {
      await this.browserRuntimeManager.stopPlatform(this.platformCode).catch(() => {});
      this.profileProcessIds = [];
      return { stopped: true, browserClosed: Boolean(context || launching), providerUsed: 'web_access_cdp' };
    }
    if (context) await context.close().catch(() => {});
    const knownProcessIds = this.profileProcessIds || [];
    const killedProcessIds = await forceStopProfileProcesses(this.profileDir, { knownProcessIds });
    this.profileProcessIds = [];
    if (launching) {
      void launching.catch(() => null)
        .then(() => forceStopProfileProcesses(this.profileDir, { knownProcessIds }))
        .catch(error => console.error(`[Agent] Failed to clean late ${this.platformCode} browser processes: ${error.message}`));
    }
    return { stopped: true, browserClosed: Boolean(context || launching || killedProcessIds.length), killedProcessIds, providerUsed: this.browserExecution?.providerUsed || 'playwright' };
  }

  async getPage() {
    const context = await this.ensureContext();
    const pages = context.pages();
    const page = pages.find(item => item.url().includes('creator.xiaohongshu.com')) || pages[0] || await context.newPage();
    await page.bringToFront();
    return page;
  }

  async openLogin() {
    const page = await this.getPage();
    await page.goto(this.creatorUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    return this.status(page);
  }

  async mainSiteStatus(page = null) {
    try {
      const current = page || (this.context ? this.context.pages().find(item => item.url().includes('www.xiaohongshu.com')) : null);
      if (!current) {
        return { browser: 'CLOSED', loggedIn: false, state: 'CLOSED', url: null, message: '小红书主站专用浏览器尚未打开' };
      }
      const bodyText = await current.locator('body').innerText({ timeout: 5000 }).catch(() => '');
      const phoneInputVisible = await current.locator('input[placeholder*="手机号"], input[placeholder*="手机号码"]').first().isVisible().catch(() => false);
      const needsLogin = /\/login(?:[/?#]|$)/i.test(current.url())
        || phoneInputVisible
        || /扫码登录|登录后查看|登录即可查看|手机号登录|验证码登录/.test(bodyText);
      return {
        browser: 'OPEN',
        loggedIn: !needsLogin,
        state: needsLogin ? 'LOGIN' : 'READY',
        url: current.url(),
        message: needsLogin ? '等待工作人员人工登录小红书主站' : '已进入小红书主站通知页'
      };
    } catch (error) {
      return { browser: this.context ? 'OPEN' : 'CLOSED', loggedIn: false, state: 'ERROR', url: null, message: error.message };
    }
  }

  async openMainSite() {
    const page = await this.getMainSitePage();
    await page.goto('https://www.xiaohongshu.com/notification', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(1500);
    return this.mainSiteStatus(page);
  }

  async debugMain(page = null) {
    const current = page || await this.getMainSitePage();
    const status = await this.mainSiteStatus(current);
    const bodyText = await current.locator('body').innerText({ timeout: 5000 }).catch(() => '');
    const dom = await current.evaluate(() => {
      const visible = element => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
      };
      const candidates = Array.from(document.querySelectorAll('div,li,article,section'))
        .filter(element => visible(element))
        .map(element => ({ element, text: String(element.innerText || '').trim().replace(/\n{3,}/g, '\n\n') }))
        .filter(item => /评论了你的笔记|回复了你的评论|回复了你|评论了你/.test(item.text) && item.text.length >= 8 && item.text.length <= 1500)
        .sort((a, b) => a.text.length - b.text.length)
        .slice(0, 30)
        .map(item => ({
          tag: item.element.tagName.toLowerCase(),
          className: String(item.element.className || '').slice(0, 500),
          text: item.text.slice(0, 1200),
          anchors: Array.from(item.element.querySelectorAll('a[href]')).slice(0, 8).map(anchor => ({ href: anchor.href, text: String(anchor.innerText || '').trim().slice(0, 200) })),
          buttons: Array.from(item.element.querySelectorAll('button,[role="button"]')).slice(0, 8).map(button => String(button.innerText || button.textContent || '').trim().slice(0, 120)),
          html: item.element.outerHTML.slice(0, 2500)
        }));
      const chatCandidates = Array.from(document.querySelectorAll('div,li,section,article'))
        .filter(element => visible(element))
        .map(element => ({ element, text: String(element.innerText || '').trim().replace(/\n{3,}/g, '\n\n'), className: String(element.className || '') }))
        .filter(item => /chat|message|conversation|session|im-/i.test(item.className) && item.text.length >= 1 && item.text.length <= 1200)
        .sort((a, b) => a.text.length - b.text.length)
        .slice(0, 80)
        .map(item => ({ tag: item.element.tagName.toLowerCase(), className: item.className.slice(0, 500), text: item.text.slice(0, 1000), html: item.element.outerHTML.slice(0, 3000) }));
      return {
        candidates,
        chatCandidates,
        links: Array.from(document.querySelectorAll('a[href]')).filter(visible).slice(0, 120).map(anchor => ({ href: anchor.href, text: String(anchor.innerText || '').trim().slice(0, 200), className: String(anchor.className || '').slice(0, 300) })),
        buttons: Array.from(document.querySelectorAll('button,[role="button"]')).filter(visible).slice(0, 120).map(button => ({ text: String(button.innerText || button.textContent || '').trim().slice(0, 200), className: String(button.className || '').slice(0, 300) }))
      };
    }).catch(error => ({ error: error.message, candidates: [], links: [], buttons: [] }));
    return { ...status, title: await current.title().catch(() => ''), bodyText: bodyText.slice(0, 6000), dom };
  }

  async inspectMainUrl(targetUrl) {
    const parsed = new URL(String(targetUrl || ''));
    if (!/(^|\.)xiaohongshu\.com$/i.test(parsed.hostname)) throw new Error('Only xiaohongshu.com URLs are allowed');
    const page = await this.getMainSitePage();
    await page.goto(parsed.toString(), { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(1800);
    return this.debugMain(page);
  }

  async inspectCommentReply({ userName, content, eventTime } = {}) {
    const page = await this.getMainSitePage();
    await page.goto('https://www.xiaohongshu.com/notification', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(1200);
    const containers = page.locator('.container').filter({ has: page.locator('.interaction-hint') });
    const count = await containers.count();
    let target = null;
    for (let index = 0; index < count; index += 1) {
      const item = containers.nth(index);
      const data = await item.evaluate(element => ({
        userName: String(element.querySelector('.user-info')?.innerText || '').trim(),
        content: String(element.querySelector('.interaction-content')?.innerText || '').trim(),
        eventTime: String(element.querySelector('.interaction-time')?.innerText || '').trim()
      })).catch(() => null);
      if (!data) continue;
      if (userName && data.userName !== userName) continue;
      if (content && data.content !== content) continue;
      if (eventTime && data.eventTime !== eventTime) continue;
      target = item;
      break;
    }
    if (!target) throw new Error('未找到指定评论通知');
    const reply = target.locator('.action-reply').first();
    if (!await reply.isVisible().catch(() => false)) throw new Error('指定评论没有可见回复按钮');
    await reply.click();
    await page.waitForTimeout(500);
    return target.evaluate(element => ({
      text: String(element.innerText || '').trim().slice(0, 1600),
      inputs: Array.from(element.querySelectorAll('input,textarea,[contenteditable="true"]')).map(input => ({ tag: input.tagName.toLowerCase(), type: input.getAttribute('type'), placeholder: input.getAttribute('placeholder'), contenteditable: input.getAttribute('contenteditable'), className: String(input.className || '').slice(0, 400) })),
      buttons: Array.from(element.querySelectorAll('button,[role="button"],[class*=submit],[class*=send]')).map(button => ({ text: String(button.innerText || button.textContent || '').trim(), className: String(button.className || '').slice(0, 400), tag: button.tagName.toLowerCase() })),
      html: element.outerHTML.slice(0, 9000)
    }));
  }

  async inspectConversation({ conversationId } = {}) {
    const page = await this.getMainSitePage();
    await page.goto('https://www.xiaohongshu.com/chat', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(1200);
    const selector = conversationId ? privateConversationSelector(conversationId) : '.xhs-im-conv-item';
    const item = page.locator(selector).first();
    if (!await item.isVisible().catch(() => false)) throw new Error('未找到指定私信会话');
    await item.click();
    await page.waitForTimeout(1000);
    return page.evaluate(() => ({
      inputs: Array.from(document.querySelectorAll('input,textarea,[contenteditable="true"]')).filter(element => { const rect = element.getBoundingClientRect(); return rect.width > 0 && rect.height > 0; }).map(input => ({ tag: input.tagName.toLowerCase(), type: input.getAttribute('type'), placeholder: input.getAttribute('placeholder'), contenteditable: input.getAttribute('contenteditable'), className: String(input.className || '').slice(0, 500) })),
      buttons: Array.from(document.querySelectorAll('button,[role="button"],[class*=send]')).filter(element => { const rect = element.getBoundingClientRect(); return rect.width > 0 && rect.height > 0; }).map(button => ({ text: String(button.innerText || button.textContent || '').trim().slice(0, 200), className: String(button.className || '').slice(0, 500), tag: button.tagName.toLowerCase() })).slice(0, 120),
      structures: Array.from(document.querySelectorAll('[class*=message],[class*=chat],[class*=bubble],[class*=input],[class*=editor]')).filter(element => { const rect = element.getBoundingClientRect(); return rect.width > 0 && rect.height > 0; }).map(element => ({ tag: element.tagName.toLowerCase(), className: String(element.className || '').slice(0, 500), text: String(element.innerText || '').trim().slice(0, 300) })).filter((item,index,array)=>array.findIndex(other=>other.tag===item.tag&&other.className===item.className)===index).slice(0, 120)
    }));
  }

  async status(page = null, { checked = false } = {}) {
    const checkedAt = checked ? new Date().toISOString() : null;
    try {
      const current = page || (this.context ? this.context.pages().find(item => item.url().includes('creator.xiaohongshu.com')) : null);
      if (!current) return { platformCode: 'xiaohongshu', browser: 'CLOSED', loggedIn: false, state: 'CLOSED', confidence: 'UNCONFIRMED', evidence: [], checkedAt, url: null, message: '\u5c0f\u7ea2\u4e66\u4e13\u7528\u6d4f\u89c8\u5668\u5c1a\u672a\u6253\u5f00' };
      const result = await this.inspectLoginState(current); const state = result.state;
      return { platformCode: 'xiaohongshu', browser: 'OPEN', loggedIn: state === 'READY', state, confidence: ['READY','LOGIN','VERIFY_REQUIRED'].includes(state) ? 'CONFIRMED' : 'UNCONFIRMED', evidence: result.evidence, checkedAt, url: current.url(), message: state === 'LOGIN' ? '\u5c0f\u7ea2\u4e66\u5df2\u786e\u8ba4\u672a\u767b\u5f55' : state === 'READY' ? '\u5c0f\u7ea2\u4e66\u5df2\u786e\u8ba4\u767b\u5f55' : state === 'VERIFY_REQUIRED' ? '\u5c0f\u7ea2\u4e66\u9700\u8981\u4eba\u5de5\u9a8c\u8bc1' : '\u5c0f\u7ea2\u4e66\u767b\u5f55\u72b6\u6001\u65e0\u6cd5\u786e\u8ba4' };
    } catch (error) { return { platformCode: 'xiaohongshu', browser: this.context ? 'OPEN' : 'CLOSED', loggedIn: false, state: 'ERROR', confidence: 'UNCONFIRMED', evidence: ['exception'], checkedAt, url: null, message: error.message }; }
  }

  async inspectLoginState(page) {
    const url = page.url();
    if (!url || url === 'about:blank') return { state: 'UNKNOWN', evidence: ['missing-or-blank-url'] };
    let hostname = ''; try { hostname = new URL(url).hostname; } catch {}
    if (!/(^|\.)creator\.xiaohongshu\.com$/i.test(hostname)) return { state: 'UNKNOWN', evidence: ['non-target-domain'] };
    const bodyText = await page.locator('body').innerText({ timeout: 5000 }).catch(() => '');
    if (/captcha|verify|challenge|\u5b89\u5168\u9a8c\u8bc1|\u6ed1\u5757|\u4eba\u8138|\u5f02\u5e38\u9a8c\u8bc1/i.test(`${url} ${bodyText}`)) return { state: 'VERIFY_REQUIRED', evidence: ['verification-challenge'] };
    const phone = page.locator('input[placeholder*="\u624b\u673a\u53f7"], input[placeholder*="\u624b\u673a\u53f7\u7801"]');
    if (/\/login(?:[/?#]|$)/i.test(url) || ((await phone.count()) > 0 && await phone.first().isVisible().catch(() => false)) || /\u626b\u7801\u767b\u5f55|\u9a8c\u8bc1\u7801\u767b\u5f55|\u521b\u4f5c\u8005\u767b\u5f55/.test(bodyText)) return { state: 'LOGIN', evidence: [/\/login/i.test(url) ? 'login-url' : 'login-control'] };
    const fileInputs = await this.fileInputLocators(page);
    if (fileInputs.length) return { state: 'READY', evidence: ['authenticated-url', 'authenticated-selector:file-input'] };
    const publishPage = /\/publish\/publish(?:[/?#]|$)/i.test(url);
    const publishBodyReady = /\u4e0a\u4f20\u56fe\u6587|\u4e0a\u4f20\u89c6\u9891|\u62d6\u62fd(?:\u89c6\u9891|\u56fe\u7247)|\u70b9\u51fb\u4e0a\u4f20/.test(bodyText);
    if (publishPage) {
      // The navigation shell (for example "创作服务平台/发布笔记") appears while
      // the editor is still a skeleton. Only editor-specific upload evidence may
      // mark the publish page ready.
      if (publishBodyReady) return { state: 'READY', evidence: ['authenticated-url', 'publish-editor-ready-text'] };
      return { state: 'UNKNOWN', evidence: ['publish-editor-loading'] };
    }
    if (/\u53d1\u5e03\u7b14\u8bb0|\u53d1\u5e03\u5185\u5bb9|\u521b\u4f5c\u670d\u52a1\u5e73\u53f0/.test(bodyText)) return { state: 'READY', evidence: ['authenticated-url', 'authenticated-text'] };
    return { state: 'UNKNOWN', evidence: ['no-authenticated-evidence'] };
  }

  async detectPageState(page) { return (await this.inspectLoginState(page)).state; }

  async checkLogin() {
    const page = await this.getPage();
    await page.goto(this.creatorUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(1800);
    return this.status(page, { checked: true });
  }

  async waitForReady(page) {
    const deadline = Date.now() + this.loginTimeoutMs;
    while (Date.now() < deadline) {
      if (await this.detectPageState(page) === 'READY') return true;
      await page.waitForTimeout(1000);
    }
    return false;
  }

  async fileInputLocators(page, kind = null) {
    const results = [];
    for (const frame of page.frames()) {
      const inputs = frame.locator('input[type="file"]');
      const count = await inputs.count();
      for (let index = 0; index < count; index += 1) {
        const input = inputs.nth(index);
        const accept = String(await input.getAttribute('accept') || '').toLowerCase();
        if (kind === 'image' && !/image|jpg|jpeg|png|webp/.test(accept)) continue;
        if (kind === 'video' && !/video|mp4|mov/.test(accept)) continue;
        results.push(input);
      }
    }
    return results;
  }

  async debug() {
    const page = await this.getPage();
    const status = await this.status(page);
    const bodyText = await page.locator('body').innerText({ timeout: 5000 }).catch(() => '');
    const inputs = await page.locator('input,textarea,[contenteditable="true"]').evaluateAll(elements => elements.slice(0, 40).map(element => ({
      tag: element.tagName.toLowerCase(), type: element.getAttribute('type'), placeholder: element.getAttribute('placeholder'), accept: element.getAttribute('accept'), contenteditable: element.getAttribute('contenteditable')
    }))).catch(() => []);
    const publishControl = await this.inspectPublishControl(page, true);
    return { ...status, title: await page.title().catch(() => ''), bodyText: bodyText.slice(0, 6000), inputs, frames: page.frames().map(frame => frame.url()), publishControl };
  }

  async inspectUrl(targetUrl) {
    const page = await this.getPage();
    const parsed = new URL(String(targetUrl || ''));
    if (!/(^|\.)xiaohongshu\.com$/i.test(parsed.hostname)) throw new Error('Only xiaohongshu.com URLs are allowed');
    await page.goto(parsed.toString(), { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(1800);
    return this.debug();
  }

  async inspectSection(targetText) {
    const page = await this.getPage();
    const label = String(targetText || '').trim();
    if (!label) throw new Error('targetText 不能为空');
    const locator = page.getByText(label, { exact: true }).first();
    if (!await locator.isVisible().catch(() => false)) throw new Error(`未找到页面入口：${label}`);
    await locator.click();
    await page.waitForTimeout(1800);
    return this.debug();
  }

  async runIssueDiagnosis(payload = {}) {
    await this.assertRuntimeAllowed();
    const requestedPages = Array.isArray(payload.pages) ? payload.pages : [];
    if (!requestedPages.length) return { status: 'FAILED', result: { message: 'AI 自检未配置只读取证页面', safeReadOnly: true, pages: [] } };
    const screenshotDir = path.resolve(String(payload.screenshotDir || path.join(this.logsDir, 'issue-diagnosis', this.platformCode, String(Date.now()))));
    fs.mkdirSync(screenshotDir, { recursive: true });
    const captured = [];
    try {
      const page = await this.getPage();
      for (let index = 0; index < requestedPages.length; index += 1) {
        await this.assertRuntimeAllowed();
        const item = requestedPages[index] || {};
        const target = new URL(String(item.url || ''));
        if (target.protocol !== 'https:' || !/(^|\.)xiaohongshu\.com$/i.test(target.hostname)) {
          throw new Error('AI 自检只允许访问 xiaohongshu.com 的 HTTPS 页面');
        }
        await page.goto(target.href, { waitUntil: 'domcontentloaded', timeout: 60_000 });
        await page.waitForTimeout(Math.max(500, Number(payload.settleMs) || 2_000));
        await this.assertRuntimeAllowed();
        const selectors = [...new Set((Array.isArray(item.selectors) ? item.selectors : []).map(value => String(value || '').trim()).filter(Boolean))].slice(0, 80);
        const selectorHits = {};
        for (const selector of selectors) selectorHits[selector] = await page.locator(selector).first().count().then(count => count > 0).catch(() => false);
        const evidence = await page.evaluate(() => {
          const visible = element => {
            const style = getComputedStyle(element);
            return style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity || 1) > 0 && element.getClientRects().length > 0;
          };
          const cleanText = value => String(value || '').replace(/\s+/g, ' ').trim();
          const keyText = [...document.querySelectorAll('h1,h2,h3,[role="heading"],label,button,[role="button"],[role="tab"],nav a')]
            .filter(visible).map(element => cleanText(element.innerText || element.textContent || element.getAttribute('aria-label') || ''))
            .filter(value => value.length >= 2 && value.length <= 160).slice(0, 240);
          const controls = [...document.querySelectorAll('button,a,input,textarea,select,[role="button"],[role="tab"],[role="menuitem"]')]
            .filter(visible).map(element => cleanText(element.innerText || element.textContent || element.getAttribute('placeholder') || element.getAttribute('aria-label') || element.getAttribute('title') || element.tagName.toLowerCase()))
            .filter(value => value.length >= 1 && value.length <= 120).slice(0, 240);
          const count = selector => document.querySelectorAll(selector).length;
          return {
            keyText: [...new Set(keyText)], controls: [...new Set(controls)],
            structure: { body: count('body'), main: count('main'), nav: count('nav'), form: count('form'), dialog: count('[role="dialog"]'), button: count('button,[role="button"]'), input: count('input'), textarea: count('textarea'), link: count('a'), iframe: count('iframe') }
          };
        });
        const key = String(item.key || 'page-' + (index + 1)).replace(/[^a-z0-9_-]+/gi, '-').slice(0, 80) || 'page-' + (index + 1);
        const screenshotPath = path.join(screenshotDir, key + '.png');
        await page.screenshot({ path: screenshotPath, fullPage: false });
        captured.push({ key, name: String(item.name || key), url: page.url(), title: await page.title(), keyText: evidence.keyText, controls: evidence.controls, selectorHits, structure: evidence.structure, screenshotPath, capturedAt: new Date().toISOString() });
      }
      return { status: 'SUCCESS', result: { platformCode: this.platformCode, capturedAt: new Date().toISOString(), safeReadOnly: true, mode: 'READ_ONLY', pages: captured } };
    } catch (error) {
      return { status: 'FAILED', result: { platformCode: this.platformCode, capturedAt: new Date().toISOString(), safeReadOnly: true, mode: 'READ_ONLY', pages: captured, message: error.message, code: error.code || 'DIAGNOSIS_EVIDENCE_FAILED' } };
    }
  }

  async execute(job) {
    if (job.job_type === 'DIAGNOSE_ISSUE') return this.runIssueDiagnosis({ ...job.payload, safeReadOnly: true, mode: 'READ_ONLY' });
    if (job.job_type === 'RUN_SMOKE_TEST') return { status: 'CANCELLED', result: { message: '\u9875\u9762\u5de1\u68c0\u529f\u80fd\u5df2\u4e0b\u7ebf', safeReadOnly: true } };
    if (job.job_type === 'PUBLISH') return this.publish(job.payload);
    if (job.job_type === 'VERIFY_PUBLISH') return this.verifyPublish(job.payload);
    if (job.job_type === 'COLLECT_MESSAGES') return this.collectMessages(job.payload);
    if (job.job_type === 'REPLY') return this.replyToMessage(job.payload);
    if (job.job_type === 'DETECT_MANUAL_REPLY') return this.detectManualReply(job.payload);
    throw new Error(`不支持的小红书 RPA 任务类型：${job.job_type}`);
  }
  async publish(payload) {
    const materialPath = path.resolve(payload.materialPath || '');
    if (!fs.existsSync(materialPath)) {
      return { status: 'FAILED', result: await this.evidence(payload, '本地素材不存在，无法准备小红书草稿', null, 'material_missing', { submitAttempted: false }) };
    }

    const page = await this.getPage();
    await page.goto(this.creatorUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    const loggedIn = await this.waitForReady(page);
    if (!loggedIn) {
      return { status: 'NEEDS_CONFIRMATION', result: await this.evidence(payload, '等待人工登录超时；浏览器页面已保留，可登录后重新提交任务', page, 'login_required', { submitAttempted: false }) };
    }

    let submitAuthorization = null;
    let submitAttempted = false;
    try {
      const prepared = await this.prepareDraft(page, payload, materialPath);
      const preparedResult = await this.evidence(payload, '小红书草稿已准备完成', page, 'draft_ready', {
        ...prepared,
        draftFingerprint: payload.draftFingerprint || null,
        submitAttempted: false
      });
      if (payload.publishMode !== 'AUTO') {
        return { status: 'NEEDS_CONFIRMATION', result: { ...preparedResult, message: '小红书草稿已准备，等待人工检查并提交', finalActionAuthorized: false, manualActionRequired: true, draftSaved: false, draftPreservedInBrowser: true } };
      }
      if (payload.managementConfirmed !== true) {
        return { status: 'NEEDS_CONFIRMATION', result: { ...preparedResult, message: '小红书草稿已准备，但缺少本次最终发布确认，未点击发布', finalActionAuthorized: false, manualActionRequired: true, draftSaved: false, draftPreservedInBrowser: true } };
      }
      if (!payload.draftFingerprint?.fingerprintHash) {
        return { status: 'NEEDS_CONFIRMATION', result: await this.evidence(payload, '小红书草稿缺少服务端签发的草稿指纹，已禁止最终发布', page, 'draft_fingerprint_missing', { submitAttempted: false }) };
      }

      await this.assertRuntimeAllowed();
      const publishBaseline = await this.capturePublishBaseline(page);
      submitAuthorization = await this.authorizeFinalSubmit(payload, {
        reason: 'XIAOHONGSHU_FINAL_PUBLISH_CLICK',
        source: 'PUBLISH_JOB'
      });
      // 服务端授予永久提交锁时会记录 submit_attempted_at，此后任何异常都不得自动重发。
      submitAttempted = true;
      await this.assertRuntimeAllowed();
      const clickResult = await this.clickFinalPublish(page);
      if (!clickResult.clicked) {
        return { status: 'NEEDS_CONFIRMATION', result: await this.evidence(payload, '小红书投稿锁已获取，但最终发布按钮不唯一或不可用；请人工核对，禁止自动重试', page, 'publish_click_blocked_after_lock', { submitAttempted: true, submissionStatus: 'UNKNOWN', submitAuthorization, clickResult, manualActionRequired: true, draftSaved: false }) };
      }
      if (clickResult.confirmation === 'AMBIGUOUS') {
        return { status: 'NEEDS_CONFIRMATION', result: await this.evidence(payload, '已点击小红书发布入口，但二次确认按钮不唯一；请人工核对，禁止自动重试', page, 'publish_confirmation_ambiguous', { submitAttempted: true, submissionStatus: 'UNKNOWN', submitAuthorization, clickResult, manualActionRequired: true, draftSaved: false }) };
      }

      const publishSignal = await this.waitForPublishSuccess(page, publishBaseline);
      if (publishSignal.confirmed === true) {
        return { status: 'SUCCESS', result: await this.evidence(payload, '小红书发布已提交，并检测到本次动作产生的成功信号', page, 'published', { submitAttempted: true, submissionStatus: 'SUBMITTED', submitAuthorization, clickResult, publishSignal }) };
      }
      return { status: 'NEEDS_CONFIRMATION', result: await this.evidence(payload, '已点击小红书发布，但未检测到本次动作产生的可靠成功信号；请人工核对，禁止自动重试', page, 'publish_unconfirmed', { submitAttempted: true, submissionStatus: 'UNKNOWN', submitAuthorization, clickResult, publishSignal, manualActionRequired: true, draftSaved: false }) };
    } catch (error) {
      if (['PLATFORM_STOPPED', 'PLATFORM_OPERATION_CANCELLED'].includes(error.code) && !submitAttempted) {
        error.writeAttempted = false;
        throw error;
      }
      if (submitAttempted) {
        return { status: 'NEEDS_CONFIRMATION', result: await this.evidence(payload, `小红书投稿锁已获取后执行中断：${error.message}；结果可能不确定，禁止自动重试`, page, 'publish_interrupted_after_lock', { submitAttempted: true, submissionStatus: 'UNKNOWN', submitAuthorization, errorCode: error.code || null, manualActionRequired: true, draftSaved: false }) };
      }
      const authorizationBlocked = String(error.code || '').startsWith('SUBMIT_');
      return {
        status: authorizationBlocked ? 'NEEDS_CONFIRMATION' : 'FAILED',
        result: await this.evidence(payload, authorizationBlocked ? `小红书最终发布已被投稿锁阻断：${error.message}` : `小红书草稿准备失败：${error.message}`, page, authorizationBlocked ? 'submit_authorization_blocked' : 'prepare_failed', { submitAttempted: false, errorCode: error.code || null, authorization: error.authorization || null, manualActionRequired: true, draftSaved: false, draftPreservedInBrowser: true })
      };
    }
  }

  async verifyPublish(payload) {
    const page = await this.getPage();
    await page.goto('https://creator.xiaohongshu.com/new/note-manager', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(1800);
    const state = await this.detectPageState(page);
    if (state !== 'READY') {
      const message = state === 'LOGIN' ? '\u5c0f\u7ea2\u4e66\u521b\u4f5c\u670d\u52a1\u5e73\u53f0\u767b\u5f55\u5df2\u5931\u6548\uff0c\u65e0\u6cd5\u590d\u6838\u53d1\u5e03\u5ba1\u6838\u72b6\u6001'
        : state === 'VERIFY_REQUIRED' ? '\u5c0f\u7ea2\u4e66\u8981\u6c42\u4eba\u5de5\u5b8c\u6210\u5b89\u5168\u9a8c\u8bc1\uff0c\u5df2\u505c\u6b62\u81ea\u52a8\u590d\u6838'
          : '\u5c0f\u7ea2\u4e66\u7b14\u8bb0\u7ba1\u7406\u9875\u72b6\u6001\u65e0\u6cd5\u786e\u8ba4';
      return { status: 'NEEDS_CONFIRMATION', result: await this.evidence(payload, message, page, state === 'LOGIN' ? 'verify_login_required' : state === 'VERIFY_REQUIRED' ? 'verify_verification_required' : 'verify_page_not_ready', { reviewStatus: 'UNKNOWN', pageState: state, confidence: 'LOW', observedAt: new Date().toISOString() }) };
    }
    const title = String(payload.title || '').trim();
    if (!title) return { status: 'NEEDS_CONFIRMATION', result: await this.evidence(payload, '\u53d1\u5e03\u4efb\u52a1\u6807\u9898\u4e3a\u7a7a\uff0c\u65e0\u6cd5\u552f\u4e00\u590d\u6838\u5c0f\u7ea2\u4e66\u7b14\u8bb0', page, 'verify_title_missing', { reviewStatus: 'UNKNOWN', confidence: 'LOW', observedAt: new Date().toISOString() }) };
    const reviewSpec = {
      publishedRecordPattern: /\u5df2\u53d1\u5e03|\u53d1\u5e03\u65f6\u95f4|\u66dd\u5149|\u70b9\u8d5e|\u6536\u85cf|\u8bc4\u8bba/i,
      reviewingPattern: /\u5ba1\u6838\u4e2d|\u5904\u7406\u4e2d/i,
      rejectedPattern: /\u672a\u901a\u8fc7|\u8fdd\u89c4|\u5df2\u62d2\u7edd/i,
      managementBodyPrefixLength: 24,
      managementTimeToleranceMs: 20 * 60 * 1000
    };
    const tabs = [
      { label: '\u5df2\u53d1\u5e03', reviewStatus: 'PUBLISHED' },
      { label: '\u5ba1\u6838\u4e2d', reviewStatus: 'REVIEWING' },
      { label: '\u672a\u901a\u8fc7', reviewStatus: 'REJECTED' },
      { label: '\u4ec5\u81ea\u5df1\u53ef\u89c1', reviewStatus: 'PUBLISHED', visibility: 'PRIVATE' },
      { label: '\u8349\u7a3f\u7bb1', reviewStatus: 'DRAFT_READY' }
    ];
    let matchedRecord = null;
    let matchedTab = null;
    for (const tab of tabs) {
      const controls = page.getByText(tab.label, { exact: true });
      const count = Math.min(await controls.count().catch(() => 0), 20);
      const visibleControls = [];
      for (let index = 0; index < count; index += 1) {
        const control = controls.nth(index);
        if (await control.isVisible().catch(() => false)) visibleControls.push(control);
      }
      if (visibleControls.length === 1) {
        await visibleControls[0].click().catch(() => {});
        await page.waitForTimeout(1000);
      } else if (visibleControls.length > 1) {
        return { status: 'NEEDS_CONFIRMATION', result: await this.evidence(payload, `\u5c0f\u7ea2\u4e66\u201c${tab.label}\u201d\u72b6\u6001\u5165\u53e3\u4e0d\u552f\u4e00\uff0c\u5df2\u505c\u6b62\u590d\u6838`, page, 'verify_tab_ambiguous', { reviewStatus: 'UNKNOWN', confidence: 'LOW', observedAt: new Date().toISOString() }) };
      }
      const record = await findVisibleTitleRecord(page, title, {
        platformCode: 'xiaohongshu',
        body: payload.body || '',
        submittedAt: payload.submittedAt || '',
        tabStatus: ['PUBLISHED', 'REVIEWING', 'REJECTED'].includes(tab.reviewStatus) ? tab.reviewStatus : '',
        spec: reviewSpec
      });
      if (!record) continue;
      if (record.ambiguous) {
        return { status: 'NEEDS_CONFIRMATION', result: await this.evidence(payload, `\u5c0f\u7ea2\u4e66\u201c${tab.label}\u201d\u5217\u8868\u627e\u5230 ${record.candidateCount} \u6761\u5019\u9009\u7b14\u8bb0\uff0c\u65e0\u6cd5\u552f\u4e00\u590d\u6838`, page, 'verify_ambiguous', { reviewStatus: 'UNKNOWN', matchedRecord: record, confidence: 'LOW', observedAt: new Date().toISOString() }) };
      }
      matchedRecord = { ...record, reviewStatus: tab.reviewStatus, visibility: tab.visibility || 'PUBLIC_OR_PLATFORM_DEFAULT' };
      matchedTab = tab;
      break;
    }

    const observedAt = new Date().toISOString();
    if (!matchedRecord) {
      const syncPending = Boolean(payload.submittedAt);
      const reviewStatus = syncPending ? 'SYNCING' : 'UNKNOWN';
      const evidence = await this.evidence(payload, syncPending
        ? '\u5c0f\u7ea2\u4e66\u5df2\u63d0\u4ea4\uff0c\u7b14\u8bb0\u7ba1\u7406\u5217\u8868\u6682\u672a\u540c\u6b65\u5230\u76ee\u6807\u8bb0\u5f55\uff0c\u5c06\u7ee7\u7eed\u590d\u6838\uff0c\u4e0d\u4f1a\u91cd\u590d\u6295\u7a3f'
        : '\u7b14\u8bb0\u7ba1\u7406\u5404\u72b6\u6001\u5217\u8868\u5747\u672a\u627e\u5230\u76ee\u6807\u6807\u9898\uff0c\u4e3a\u9632\u6b62\u91cd\u590d\u53d1\u5e03\u9700\u4eba\u5de5\u786e\u8ba4', page, syncPending ? 'verify_syncing' : 'verify_not_found');
      return { status: syncPending ? 'SUCCESS' : 'NEEDS_CONFIRMATION', result: { ...evidence, reviewStatus, submissionStatus: syncPending ? 'SUBMITTED' : undefined, syncPending, confidence: syncPending ? 'MEDIUM' : 'LOW', matchedBy: [], observedAt } };
    }

    const reviewStatus = matchedRecord.reviewStatus;
    const platformUrl = matchedRecord.platformUrl || matchedRecord.href || null;
    const platformPostId = matchedRecord.platformPostId || platformPostIdentity('xiaohongshu', platformUrl);
    const message = reviewStatus === 'PUBLISHED' ? `\u5df2\u5728\u201c${matchedTab.label}\u201d\u5217\u8868\u627e\u5230\u5e76\u786e\u8ba4\u5c0f\u7ea2\u4e66\u7b14\u8bb0\uff1a${title}`
      : reviewStatus === 'REVIEWING' ? `\u5c0f\u7ea2\u4e66\u7b14\u8bb0\u5df2\u63d0\u4ea4\uff0c\u5f53\u524d\u5728\u201c${matchedTab.label}\u201d\u5217\u8868\uff1a${title}`
        : reviewStatus === 'REJECTED' ? `\u5c0f\u7ea2\u4e66\u7b14\u8bb0\u5ba1\u6838\u672a\u901a\u8fc7\uff1a${title}`
          : `\u5c0f\u7ea2\u4e66\u7b14\u8bb0\u4ecd\u5728\u8349\u7a3f\u7bb1\uff0c\u672a\u786e\u8ba4\u63d0\u4ea4\uff1a${title}`;
    const evidence = await this.evidence(payload, message, page, `verify_${reviewStatus.toLowerCase()}`, { matchedTab: matchedTab.label, matchedRecord });
    return {
      status: reviewStatus === 'DRAFT_READY' ? 'NEEDS_CONFIRMATION' : 'SUCCESS',
      result: {
        ...evidence,
        reviewStatus,
        submissionStatus: reviewStatus === 'DRAFT_READY' ? 'NOT_SUBMITTED' : 'SUBMITTED',
        syncPending: false,
        confidence: matchedRecord.confidence || 'MEDIUM',
        matchedBy: matchedRecord.matchedBy || ['TITLE', 'STATUS_TAB'],
        platformPostId,
        platformUrl,
        reviewDetail: matchedRecord.text,
        visibility: matchedRecord.visibility,
        observedAt
      }
    };
  }

  async getMainSitePage() {
    const context = await this.ensureContext();
    const page = context.pages().find(item => item.url().includes('www.xiaohongshu.com')) || await context.newPage();
    await page.bringToFront();
    return page;
  }

  async matchNoteCandidateByThumbnail(page, thumbnailUrl, candidates = []) {
    const available = candidates.filter(candidate => candidate?.title && candidate?.materialPath && fs.existsSync(candidate.materialPath) && imageExt.has(path.extname(candidate.materialPath).toLowerCase()));
    if (!thumbnailUrl || !available.length) return null;
    try {
      const response = await fetch(thumbnailUrl, { signal: AbortSignal.timeout(10000) });
      if (!response.ok) return null;
      const contentType = response.headers.get('content-type') || 'image/jpeg';
      const targetDataUrl = `data:${contentType};base64,${Buffer.from(await response.arrayBuffer()).toString('base64')}`;
      const materialData = [];
      const seen = new Set();
      for (const candidate of available) {
        const materialPath = path.resolve(candidate.materialPath);
        if (seen.has(materialPath)) continue;
        seen.add(materialPath);
        const extension = path.extname(materialPath).toLowerCase();
        const mime = extension === '.png' ? 'image/png' : extension === '.webp' ? 'image/webp' : 'image/jpeg';
        materialData.push({ materialPath, dataUrl: `data:${mime};base64,${fs.readFileSync(materialPath).toString('base64')}` });
      }
      const materialScores = await page.evaluate(async ({ targetDataUrl, materialData }) => {
        const load = src => new Promise((resolve, reject) => {
          const image = new Image();
          image.onload = () => resolve(image);
          image.onerror = () => reject(new Error('image decode failed'));
          image.src = src;
        });
        const size = 32;
        const sample = image => {
          const canvas = document.createElement('canvas');
          canvas.width = size;
          canvas.height = size;
          const context = canvas.getContext('2d', { willReadFrequently: true });
          context.drawImage(image, 0, 0, size, size);
          return context.getImageData(0, 0, size, size).data;
        };
        const target = sample(await load(targetDataUrl));
        const results = [];
        for (const material of materialData) {
          const pixels = sample(await load(material.dataUrl));
          let difference = 0;
          for (let index = 0; index < target.length; index += 4) {
            difference += Math.abs(target[index] - pixels[index]);
            difference += Math.abs(target[index + 1] - pixels[index + 1]);
            difference += Math.abs(target[index + 2] - pixels[index + 2]);
          }
          results.push({ materialPath: material.materialPath, score: difference / (size * size * 3 * 255) });
        }
        return results;
      }, { targetDataUrl, materialData });
      const scoreByPath = new Map(materialScores.map(item => [path.resolve(item.materialPath), item.score]));
      return selectThumbnailNoteCandidate(available.map(candidate => ({ ...candidate, score: scoreByPath.get(path.resolve(candidate.materialPath)) })));
    } catch {
      return null;
    }
  }

  async collectMessages(payload) {
    const page = await this.getMainSitePage();
    const requested = new Set((payload.types || ['COMMENT', 'PRIVATE_MESSAGE']).map(value => String(value).toUpperCase()));
    const messages = [];
    const skipped = { staleComments: 0, deletedComments: 0, readPrivateMessages: 0, stalePrivateMessages: 0 };

    if (requested.has('COMMENT')) {
      await page.goto('https://www.xiaohongshu.com/notification', { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(1800);
      const bodyText = await page.locator('body').innerText({ timeout: 5000 }).catch(() => '');
      if (/\/login(?:[/?#]|$)/i.test(page.url()) || /扫码登录|登录后查看|手机号登录/.test(bodyText)) {
        return { status: 'NEEDS_CONFIRMATION', result: await this.evidence(payload, '小红书主站尚未登录，评论通知采集需要工作人员扫码登录一次', page, 'collect_login_required') };
      }
      const rawComments = await page.evaluate(() => Array.from(document.querySelectorAll('.container')).map(element => {
        const eventType = String(element.querySelector('.interaction-hint span:first-child')?.innerText || '').trim();
        if (!/评论了你的笔记|回复了你的评论|回复了你|评论了你/.test(eventType)) return null;
        const userName = String(element.querySelector('.user-info')?.innerText || '').trim();
        const content = String(element.querySelector('.interaction-content')?.innerText || '').trim();
        const eventTime = String(element.querySelector('.interaction-time')?.innerText || '').trim();
        const quote = String(element.querySelector('.quote-info')?.innerText || '').trim();
        const profileUrl = element.querySelector('.user-info a[href],a.user-avatar[href]')?.href || null;
        const extra = element.querySelector('.extra');
        const noteAnchor = extra?.querySelector('a[href]') || extra?.closest('a[href]') || element.querySelector('a[href*="/explore/"],a[href*="/discovery/item/"]');
        const noteImage = extra?.querySelector('img');
        const noteTitleNode = extra?.querySelector('[data-note-title],[class*=title],[class*=name]');
        const rawNoteTitle = String(noteTitleNode?.getAttribute('data-note-title') || noteTitleNode?.innerText || noteAnchor?.getAttribute('title') || noteAnchor?.getAttribute('aria-label') || noteImage?.alt || '').trim();
        const noteTitle = /^(图片|笔记封面|封面)$/i.test(rawNoteTitle) ? '' : rawNoteTitle;
        const noteTimeNode = extra?.querySelector('[data-published-at],[class*=publish-time],[class*=publish_time],[class*=date]');
        const notePublishedAt = String(noteTimeNode?.getAttribute('data-published-at') || noteTimeNode?.innerText || '').trim();
        const noteUrl = noteAnchor?.href || null;
        let noteId = null;
        if (noteUrl) {
          try {
            const pathname = new URL(noteUrl).pathname;
            noteId = pathname.match(/\/(?:explore|discovery\/item)\/([^/?#]+)/i)?.[1] || null;
          } catch {}
        }
        const thumbnailUrl = noteImage?.src || null;
        const canReply = Boolean(element.querySelector('.action-reply'));
        return { userName, content, eventType, eventTime, quote, profileUrl, thumbnailUrl, noteId, noteUrl, noteTitle, notePublishedAt, canReply };
      }).filter(Boolean));
      const noteMatchCache = new Map();
      for (const item of rawComments) {
        if (!item.noteTitle && item.thumbnailUrl) {
          if (!noteMatchCache.has(item.thumbnailUrl)) noteMatchCache.set(item.thumbnailUrl, await this.matchNoteCandidateByThumbnail(page, item.thumbnailUrl, payload.noteCandidates));
          const matchedNote = noteMatchCache.get(item.thumbnailUrl);
          if (matchedNote) Object.assign(item, {
            noteId: item.noteId || matchedNote.platformPostId || null,
            noteUrl: item.noteUrl || matchedNote.platformUrl || null,
            noteTitle: matchedNote.title,
            notePublishedAt: matchedNote.publishedAt || '',
            noteMatch: 'thumbnail',
            noteMatchScore: matchedNote.score
          });
        }
        if (!item.content || /原评论已删除/.test(item.content)) { skipped.deletedComments += 1; continue; }
        if (!recentPlatformTime(item.eventTime)) { skipped.staleComments += 1; continue; }
        const externalId = buildXhsCommentExternalId(item);
        messages.push({ messageType: 'COMMENT', externalId, externalUrl: 'https://www.xiaohongshu.com/notification', userName: item.userName || '未知用户', content: item.content, context: { ...item, locatorVersion: 'xhs-notification-v1' } });
      }
    }

    if (requested.has('PRIVATE_MESSAGE')) {
      await page.goto('https://www.xiaohongshu.com/chat', { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(1800);
      const bodyText = await page.locator('body').innerText({ timeout: 5000 }).catch(() => '');
      if (/\/login(?:[/?#]|$)/i.test(page.url()) || /扫码登录|登录后查看|手机号登录/.test(bodyText)) {
        return { status: 'NEEDS_CONFIRMATION', result: await this.evidence(payload, '小红书主站尚未登录，私信采集需要工作人员扫码登录一次', page, 'collect_private_login_required') };
      }
      const rawPrivateMessages = await page.evaluate(() => Array.from(document.querySelectorAll('.xhs-im-conv-item[data-conv-id]')).map(element => {
        const conversationId = element.getAttribute('data-conv-id');
        const userName = String(element.querySelector('.xhs-im-conv-item__name')?.innerText || '').trim();
        const eventTime = String(element.querySelector('.xhs-im-conv-item__time')?.innerText || '').trim();
        const summaryNode = element.querySelector('.xhs-im-conv-item__summary-text');
        const content = String(summaryNode?.innerText || summaryNode?.querySelector('img')?.alt || '').trim();
        const bottomRight = element.querySelector('.xhs-im-conv-item__bottom-right');
        const unreadNode = bottomRight?.querySelector('[class*=unread],[class*=badge],[class*=red-dot],[class*=notice-dot],[aria-label*=未读],[data-unread]')
          || element.querySelector('[class*=unread],[class*=red-dot],[class*=notice-dot],[aria-label*=未读],[data-unread]');
        const unread = Boolean(unreadNode) || Boolean(bottomRight?.children?.length) || /unread|new-message/i.test(String(element.className || ''));
        return { conversationId, userName, eventTime, content, unread, unreadEvidence: unreadNode ? String(unreadNode.className || unreadNode.getAttribute('aria-label') || 'marker') : (bottomRight?.children?.length ? 'bottom-right-child' : '') };
      }).filter(item => item.conversationId && item.content));
      for (const item of rawPrivateMessages) {
        if (!item.unread) { skipped.readPrivateMessages += 1; continue; }
        if (!recentPlatformTime(item.eventTime)) { skipped.stalePrivateMessages += 1; continue; }
        const externalId = buildXhsPrivateExternalId(item);
        messages.push({ messageType: 'PRIVATE_MESSAGE', externalId, externalUrl: 'https://www.xiaohongshu.com/chat', userName: item.userName || '未知用户', content: item.content, context: { ...item, locatorVersion: 'xhs-chat-v1' } });
      }
    }

    const evidence = await this.evidence(payload, '小红书消息采集完成，共解析 ' + messages.length + ' 条新消息', page, 'collect_messages');
    return { status: 'SUCCESS', result: { ...evidence, messages, skipped, commentSupported: true, privateMessageSupported: true, note: '评论按通知卡片定位；私信仅采集近期未读会话，历史和已读消息不会自动进入回复流程' } };
  }

  async findCommentNotification(page, payload) {
    const context = payload.messageContext || {};
    const expectedUser = String(context.userName || payload.userName || '').trim();
    const expectedContent = String(payload.sourceContent || context.content || '').trim();
    const expectedQuote = String(context.quote || '').trim();
    const expectedThumbnail = stableUrlPath(context.thumbnailUrl);
    const containers = page.locator('.container').filter({ has: page.locator('.interaction-hint') });
    const count = await containers.count();
    const matches = [];
    for (let index = 0; index < count; index += 1) {
      const item = containers.nth(index);
      const data = await item.evaluate(element => ({
        userName: String(element.querySelector('.user-info')?.innerText || '').trim(),
        content: String(element.querySelector('.interaction-content')?.innerText || '').trim(),
        quote: String(element.querySelector('.quote-info')?.innerText || '').trim(),
        thumbnailUrl: element.querySelector('.extra img')?.src || null
      })).catch(() => null);
      if (!data) continue;
      if (expectedUser && data.userName !== expectedUser) continue;
      if (expectedContent && data.content !== expectedContent) continue;
      if (expectedQuote && data.quote !== expectedQuote) continue;
      if (expectedThumbnail && stableUrlPath(data.thumbnailUrl) !== expectedThumbnail) continue;
      matches.push(item);
    }
    return matches.length === 1 ? matches[0] : null;
  }

  async countVisibleMatches(locator) {
    const count = await locator.count().catch(() => 0);
    let visibleCount = 0;
    for (let index = 0; index < count; index += 1) {
      if (await locator.nth(index).isVisible().catch(() => false)) visibleCount += 1;
    }
    return visibleCount;
  }

  async replyEditorCleared(editor, kind = 'input') {
    const visible = await editor.isVisible().catch(() => false);
    if (!visible) return true;
    if (kind === 'contenteditable') {
      const value = await editor.evaluate(element => String(element.innerText || element.textContent || '')).catch(() => null);
      return value !== null && !value.trim();
    }
    const value = await editor.inputValue().catch(() => null);
    return value !== null && !value.trim();
  }

  async inspectPrivateReplyScope(page, editor, payload, requireSource = true) {
    const context = payload.messageContext || {};
    const inspected = await editor.evaluate((element, options) => {
      const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
      const shown = node => node && getComputedStyle(node).display !== 'none' && getComputedStyle(node).visibility !== 'hidden' && node.getClientRects().length > 0;
      if (!shown(element)) return { ok: false, reason: 'PRIVATE_EDITOR_NOT_VISIBLE' };
      let scope = element.parentElement;
      while (scope && scope !== document.body && !scope.querySelector('[class*="chat-item"]')) scope = scope.parentElement;
      if (!scope || scope === document.body || scope.querySelector('.xhs-im-conv-item')) return { ok: false, reason: 'PRIVATE_CHAT_SCOPE_MISSING' };
      const identityNode = scope.closest('[data-conv-id],[data-conversation-id]');
      const scopeId = identityNode?.getAttribute('data-conv-id') || identityNode?.getAttribute('data-conversation-id') || '';
      const rows = Array.from(document.querySelectorAll('.xhs-im-conv-item[data-conv-id]')).filter(shown);
      const selected = rows.filter(row => row.getAttribute('aria-selected') === 'true' || row.getAttribute('aria-current') === 'true' || row.getAttribute('data-active') === 'true' || /(?:^|\s)(?:active|selected|xhs-im-conv-item--(?:active|selected))(?:$|\s)/.test(String(row.className || '')));
      if (selected.length && (selected.length !== 1 || selected[0].getAttribute('data-conv-id') !== options.conversationId)) return { ok: false, reason: 'PRIVATE_CHAT_IDENTITY_CONFLICT' };
      if (scopeId ? scopeId !== options.conversationId : selected.length !== 1 || selected[0].getAttribute('data-conv-id') !== options.conversationId) return { ok: false, reason: 'PRIVATE_CHAT_IDENTITY_UNVERIFIED' };
      if (options.requireSource) {
        if (!options.sourceContent) return { ok: false, reason: 'PRIVATE_SOURCE_MISSING' };
        const incoming = Array.from(scope.querySelectorAll('[class*="chat-item__body"],[class*="chat-item__bubble"]')).filter(node => shown(node) && !node.closest('.chat-item__body--right,.chat-item__bubble--self') && !node.querySelector('.chat-item__body--right,.chat-item__bubble--self'));
        const messageText = node => {
          const clone = node.cloneNode(true);
          clone.querySelectorAll('time,[datetime],[class*="time" i]').forEach(time => time.remove());
          clone.querySelectorAll('img').forEach(image => image.replaceWith(document.createTextNode(image.getAttribute('alt') || image.getAttribute('title') || '')));
          return clean(clone.innerText || clone.textContent);
        };
        if (!incoming.some(node => messageText(node) === options.sourceContent)) return { ok: false, reason: 'PRIVATE_SOURCE_NOT_VISIBLE' };
      }
      const marker = scope.getAttribute('data-codex-xhs-private-scope') || options.marker;
      scope.setAttribute('data-codex-xhs-private-scope', marker);
      return { ok: true, marker, conversationId: options.conversationId, identitySource: scopeId ? 'chat-attribute' : 'selected-conversation' };
    }, { conversationId: String(context.conversationId || ''), sourceContent: String(payload.sourceContent || context.content || '').replace(/\s+/g, ' ').trim(), requireSource, marker: crypto.randomUUID() }).catch(() => ({ ok: false, reason: 'PRIVATE_CHAT_SCOPE_UNAVAILABLE' }));
    if (!inspected.ok) return inspected;
    return { ...inspected, scope: page.locator(`[data-codex-xhs-private-scope="${inspected.marker}"]`) };
  }

  async openPrivateReplyConversation(page, payload, requireSource = true) {
    const context = payload.messageContext || {};
    const conversationId = String(context.conversationId || '');
    if (!conversationId) return { ok: false, reason: 'PRIVATE_CONVERSATION_MISSING' };
    if (!/^https:\/\/www\.xiaohongshu\.com\/chat(?:[/?#]|$)/i.test(page.url())) {
      await page.goto('https://www.xiaohongshu.com/chat', { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(1200);
    }
    const conversations = page.locator(privateConversationSelector(conversationId));
    const candidates = [];
    for (let index = 0, count = await conversations.count(); index < count; index += 1) if (await conversations.nth(index).isVisible().catch(() => false)) candidates.push(conversations.nth(index));
    if (candidates.length !== 1) return { ok: false, reason: candidates.length ? 'PRIVATE_CONVERSATION_AMBIGUOUS' : 'PRIVATE_CONVERSATION_NOT_FOUND', candidateCount: candidates.length };
    const expectedUser = String(payload.userName || context.userName || '').replace(/\s+/g, ' ').trim();
    const candidateUser = await candidates[0].locator('.xhs-im-conv-item__name').innerText().catch(() => '');
    if (expectedUser && candidateUser.replace(/\s+/g, ' ').trim() !== expectedUser) return { ok: false, reason: 'PRIVATE_CONVERSATION_USER_MISMATCH' };
    const inspectCurrent = async () => {
      const editors = page.locator('.xhs-im-input-bar-editor[contenteditable="true"]');
      const visible = [];
      for (let index = 0, count = await editors.count(); index < count; index += 1) if (await editors.nth(index).isVisible().catch(() => false)) visible.push(editors.nth(index));
      if (visible.length !== 1) return { ok: false, reason: visible.length ? 'PRIVATE_EDITOR_AMBIGUOUS' : 'PRIVATE_EDITOR_NOT_FOUND', candidateCount: visible.length };
      const inspected = await this.inspectPrivateReplyScope(page, visible[0], payload, requireSource);
      return inspected.ok ? { ...inspected, editor: inspected.scope.locator('.xhs-im-input-bar-editor[contenteditable="true"]').filter({ visible: true }) } : inspected;
    };
    const current = await inspectCurrent();
    if (current.ok) return { ...current, reusedCurrentConversation: true };
    await candidates[0].click({ timeout: 5000 });
    await page.waitForTimeout(700);
    return inspectCurrent();
  }

  async countPrivateReplyEchoes(scope, replyText) {
    return scope.locator('.chat-item__body--right,.chat-item__bubble--self').evaluateAll((nodes, expected) => {
      const matching = nodes.filter(node => {
        const style = getComputedStyle(node);
        return style.display !== 'none' && style.visibility !== 'hidden' && node.getClientRects().length > 0 && String(node.innerText || node.textContent || '').replace(/\s+/g, ' ').trim() === expected;
      });
      return matching.filter(node => !matching.some(other => other !== node && node.contains(other))).length;
    }, String(replyText || '').replace(/\s+/g, ' ').trim()).catch(() => 0);
  }

  async replyToMessage(payload) {
    const replyText = String(payload.replyText || '').trim();
    if (!replyText) {
      return { status: 'NEEDS_CONFIRMATION', result: await this.evidence(payload, '自动回复内容为空，已禁止发送', null, 'reply_empty', { sendAttempted: false }) };
    }
    const messageType = String(payload.messageType || '').toUpperCase();
    if (!['COMMENT', 'PRIVATE_MESSAGE'].includes(messageType)) {
      return { status: 'NEEDS_CONFIRMATION', result: await this.evidence(payload, `不支持的小红书消息类型：${messageType || 'unknown'}`, null, 'reply_type_unsupported', { sendAttempted: false }) };
    }

    let page = null;
    let sendAttempted = false;
    let sendMethod = null;
    let baselineEchoCount = 0;

    try {
      page = await this.getMainSitePage();

      if (messageType === 'PRIVATE_MESSAGE') {
        const target = await this.openPrivateReplyConversation(page, payload);
        if (!target.ok) return { status: 'NEEDS_CONFIRMATION', result: await this.evidence(payload, '未能核验小红书私信会话和原消息，已禁止发送', page, 'private_target_unverified', { sendAttempted: false, reason: target.reason, candidateCount: target.candidateCount }) };
        const { editor, scope } = target;
        baselineEchoCount = await this.countPrivateReplyEchoes(scope, replyText);
        await editor.fill(replyText);

        // Enter 是非幂等写动作；只有紧邻写动作的 Runtime Check 通过后才能执行。
        await this.assertRuntimeAllowed();
        const beforeSend = await this.inspectPrivateReplyScope(page, editor, payload);
        const filled = await editor.innerText().catch(() => '');
        if (!beforeSend.ok || filled.trim() !== replyText) return { status: 'NEEDS_CONFIRMATION', result: await this.evidence(payload, '小红书私信会话或回复输入内容在发送前发生变化，已停止发送', page, 'private_target_changed', { sendAttempted: false, reason: beforeSend.reason || 'PRIVATE_EDITOR_CHANGED' }) };
        sendMethod = 'xiaohongshu:private-enter';
        sendAttempted = true;
        await editor.press('Enter');
        await page.waitForTimeout(1200);

        const afterSend = await this.inspectPrivateReplyScope(page, editor, payload, false);
        const scopedEchoCount = await this.countPrivateReplyEchoes(scope, replyText);
        const editorCleared = await this.replyEditorCleared(editor, 'contenteditable');
        const confirmed = afterSend.ok && scopedEchoCount > baselineEchoCount && editorCleared;
        const evidenceExtra = { sendAttempted: true, sendMethod, baselineEchoCount, scopedEchoCount, editorCleared, targetIdentityVerified: afterSend.ok, verified: confirmed };
        if (!confirmed) {
          return { status: 'NEEDS_CONFIRMATION', result: await this.evidence(payload, '私信已尝试发送，但未检测到本次新增的己方消息气泡或输入框未清空；请人工确认且不要自动重试', page, 'private_reply_unconfirmed', evidenceExtra) };
        }
        return { status: 'SUCCESS', result: await this.evidence(payload, '小红书私信自动回复已发送，并检测到本次新增的己方消息气泡', page, 'private_reply_sent', evidenceExtra) };
      }

      await page.goto('https://www.xiaohongshu.com/notification', { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(1200);
      const target = await this.findCommentNotification(page, payload);
      if (!target) return { status: 'NEEDS_CONFIRMATION', result: await this.evidence(payload, '未能唯一定位原评论通知，已禁止误回复', page, 'reply_source_not_found', { sendAttempted: false }) };
      const replyTriggers = target.locator('.action-reply');
      const triggerCount = await replyTriggers.count().catch(() => 0);
      if (triggerCount !== 1 || !await replyTriggers.first().isVisible().catch(() => false)) {
        return { status: 'NEEDS_CONFIRMATION', result: await this.evidence(payload, triggerCount > 1 ? '原评论通知存在多个回复入口，已禁止误发送' : '原评论通知没有可确认的回复按钮，已禁止误发送', page, triggerCount > 1 ? 'reply_trigger_ambiguous' : 'reply_trigger_not_found', { sendAttempted: false, candidateCount: triggerCount }) };
      }
      await replyTriggers.first().click();
      const editors = target.locator('textarea.comment-input,textarea[placeholder*="回复"]');
      const editorCount = await editors.count().catch(() => 0);
      if (editorCount !== 1 || !await editors.first().isVisible().catch(() => false)) {
        return { status: 'NEEDS_CONFIRMATION', result: await this.evidence(payload, editorCount > 1 ? '评论回复输入框不唯一，已禁止误发送' : '未找到可确认的评论回复输入框，已禁止误发送', page, editorCount > 1 ? 'reply_editor_ambiguous' : 'reply_editor_not_found', { sendAttempted: false, candidateCount: editorCount }) };
      }
      const editor = editors.first();
      const scopedReplyEcho = target.getByText(replyText, { exact: false });
      baselineEchoCount = await this.countVisibleMatches(scopedReplyEcho);
      await editor.fill(replyText);
      const sends = target.locator('button.submit').filter({ hasText: '发送' });
      const sendCount = await sends.count().catch(() => 0);
      if (sendCount !== 1 || !await sends.first().isVisible().catch(() => false)) {
        return { status: 'NEEDS_CONFIRMATION', result: await this.evidence(payload, sendCount > 1 ? '评论发送按钮不唯一，已禁止误发送' : '回复内容已填入但未找到明确发送按钮，已保留页面供人工确认', page, sendCount > 1 ? 'reply_send_ambiguous' : 'reply_send_not_found', { sendAttempted: false, candidateCount: sendCount }) };
      }
      const replyResponse = page.waitForResponse(response => response.request().method() === 'POST' && /comment|reply|notification/i.test(response.url()), { timeout: 5000 }).catch(() => null);

      // 点击发送是非幂等写动作；平台一旦停止，写前必须中止并安全退回队列。
      await this.assertRuntimeAllowed();
      sendMethod = 'xiaohongshu:comment-click';
      sendAttempted = true;
      await sends.first().click();
      const networkResult = await replyResponse;
      await page.waitForTimeout(900);

      const editorCleared = await this.replyEditorCleared(editor, 'input');
      const successToast = await page.getByText(/回复成功|发送成功/, { exact: false }).last().isVisible().catch(() => false);
      const scopedEchoCount = await this.countVisibleMatches(scopedReplyEcho);
      const networkConfirmed = Boolean(networkResult?.ok());
      const confirmed = scopedEchoCount > baselineEchoCount && editorCleared;
      const evidenceExtra = { sendAttempted: true, sendMethod, baselineEchoCount, scopedEchoCount, editorCleared, networkConfirmed, toastConfirmed: successToast, verified: confirmed };
      if (!confirmed) {
        return { status: 'NEEDS_CONFIRMATION', result: await this.evidence(payload, '已点击评论发送，但未检测到本次新增的回复回显或输入框未清空；请人工核对且不要自动重试', page, 'reply_unconfirmed', evidenceExtra) };
      }
      return { status: 'SUCCESS', result: await this.evidence(payload, '小红书评论自动回复已发送，并检测到本次新增的回复回显', page, 'reply_sent', evidenceExtra) };
    } catch (error) {
      if (['PLATFORM_STOPPED', 'PLATFORM_OPERATION_CANCELLED'].includes(error?.code) && !sendAttempted) {
        error.writeAttempted = false;
        throw error;
      }
      if (sendAttempted) {
        return { status: 'NEEDS_CONFIRMATION', result: await this.evidence(payload, `小红书回复写动作执行后发生中断：${error.message}；结果可能不确定，禁止自动重试`, page, 'reply_unconfirmed', { sendAttempted: true, sendMethod, baselineEchoCount, verified: false, errorCode: error.code || null, interruptedByPlatformStop: ['PLATFORM_STOPPED', 'PLATFORM_OPERATION_CANCELLED'].includes(error?.code) }) };
      }
      throw error;
    }
  }

  async detectManualReply(payload) {
    const expectedReply = String(payload.expectedReply || '').trim();
    if (!expectedReply) return { status: 'NEEDS_CONFIRMATION', result: { handled: false, message: '缺少需要核验的人工回复内容' } };
    const messageType = String(payload.messageType || '').toUpperCase();
    const page = await this.getMainSitePage();
    if (messageType === 'PRIVATE_MESSAGE') {
      const target = await this.openPrivateReplyConversation(page, payload, false);
      if (!target.ok) return { status: 'NEEDS_CONFIRMATION', result: { handled: false, message: '未能唯一核验私信会话', reason: target.reason } };
      const handled = await this.countPrivateReplyEchoes(target.scope, expectedReply) > 0;
      return { status: 'SUCCESS', result: { handled, message: handled ? '检测到小红书私信中已有指定人工回复' : '未检测到指定人工回复内容', platformUrl: page.url() } };
    }
    await page.goto('https://www.xiaohongshu.com/notification', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(1000);
    const target = await this.findCommentNotification(page, payload);
    if (!target) return { status: 'NEEDS_CONFIRMATION', result: { handled: false, message: '未找到原评论通知' } };
    const handled = await target.getByText(expectedReply, { exact: false }).last().isVisible().catch(() => false);
    return { status: 'SUCCESS', result: { handled, message: handled ? '检测到评论通知中已有指定人工回复' : '未检测到指定人工回复内容', platformUrl: page.url() } };
  }

  async selectUploadTab(page, isVideo, timeoutMs = 60_000) {
    const tabNames = isVideo
      ? ['\u4e0a\u4f20\u89c6\u9891', '\u53d1\u5e03\u89c6\u9891']
      : ['\u4e0a\u4f20\u56fe\u6587', '\u53d1\u5e03\u56fe\u6587'];
    const wantedKind = isVideo ? 'video' : 'image';
    const attempts = [];
    const clickedCandidates = new Set();
    const deadline = Date.now() + Math.max(1_000, Number(timeoutMs) || 60_000);
    let lastBodyText = '';

    while (Date.now() < deadline) {
      await this.assertRuntimeAllowed();
      if ((await this.fileInputLocators(page, wantedKind)).length) return { selected: false, method: 'existing-file-input', attempts };

      for (const [frameIndex, frame] of page.frames().entries()) {
        for (const name of tabNames) {
          const tabs = frame.getByText(name, { exact: true });
          const count = await tabs.count().catch(() => 0);
          const candidates = [];

          for (let index = 0; index < count; index += 1) {
            const tab = tabs.nth(index);
            const info = await tab.evaluate(element => {
              const rect = element.getBoundingClientRect();
              const style = window.getComputedStyle(element);
              return {
                width: rect.width,
                height: rect.height,
                inViewport: rect.bottom > 0 && rect.right > 0 && rect.top < window.innerHeight && rect.left < window.innerWidth,
                displayed: style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0'
              };
            }).catch(() => null);
            if (info?.displayed && info.width > 0 && info.height > 0) candidates.push({ tab, index, ...info });
          }

          candidates.sort((a, b) => Number(b.inViewport) - Number(a.inViewport));
          for (const candidate of candidates) {
            const frameUrl = typeof frame.url === 'function' ? frame.url() : '';
            const candidateKey = `${frameIndex}|${frameUrl}|${name}|${candidate.index}`;
            if (clickedCandidates.has(candidateKey)) continue;
            clickedCandidates.add(candidateKey);
            attempts.push(`${name}#${candidate.index}:${candidate.inViewport ? 'viewport' : 'offscreen'}`);
            await candidate.tab.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
            await candidate.tab.evaluate(element => element.click()).catch(async () => {
              await candidate.tab.click({ force: true, timeout: 5000 });
            });

            const verifyDeadline = Math.min(Date.now() + 12_000, deadline);
            while (Date.now() < verifyDeadline) {
              await this.assertRuntimeAllowed();
              if ((await this.fileInputLocators(page, wantedKind)).length) {
                return { selected: true, method: 'upload-tab', label: name, attempts };
              }
              await page.waitForTimeout(500);
            }
          }
        }
      }

      lastBodyText = await page.locator('body').innerText({ timeout: 3000 }).catch(() => '');
      await page.waitForTimeout(750);
    }

    const pageHint = String(lastBodyText || '').replace(/\s+/g, ' ').trim().slice(0, 240);
    throw new Error(`Could not switch to ${isVideo ? 'video' : 'image'} upload tab after waiting for the editor; attempts: ${attempts.join(', ') || 'no candidates'}${pageHint ? `; page: ${pageHint}` : ''}`);
  }

  async prepareDraft(page, payload, materialPath) {
    const ext = path.extname(materialPath).toLowerCase();
    const isVideo = videoExt.has(ext);
    if (!isVideo && !imageExt.has(ext)) throw new Error(`不支持的素材格式：${ext || '无扩展名'}`);

    const wantedKind = isVideo ? 'video' : 'image';
    const uploadTimeoutMs = resolveUploadTimeoutMs(materialPath, this.uploadTimeoutOptions);
    let fileInputs = await this.fileInputLocators(page, wantedKind);
    if (!fileInputs.length) {
      await this.selectUploadTab(page, isVideo);
    }

    const inputDeadline = Date.now() + 90000;
    while (Date.now() < inputDeadline) {
      fileInputs = await this.fileInputLocators(page, wantedKind);
      if (fileInputs.length) break;
      await page.waitForTimeout(1000);
    }
    if (!fileInputs.length) throw new Error('未找到素材上传控件，可能是小红书页面仍在加载或页面结构发生变化');
    await fileInputs[0].setInputFiles(materialPath);

    const title = String(payload.title || '').trim();
    const body = String(payload.body || '').trim();
    const titleInput = page.locator('input[placeholder*="标题"], textarea[placeholder*="标题"]').first();
    await titleInput.waitFor({ state: 'visible', timeout: isVideo ? uploadTimeoutMs : Math.min(uploadTimeoutMs, 60000) });
    await titleInput.fill(title.slice(0, 20));

    const bodySelectors = [
      'textarea[placeholder*="正文"]',
      'textarea[placeholder*="描述"]',
      '[contenteditable="true"][data-placeholder*="正文"]',
      '[contenteditable="true"][data-placeholder*="描述"]',
      '.ql-editor[contenteditable="true"]',
      '[contenteditable="true"]'
    ];
    let bodyInput = null;
    for (const selector of bodySelectors) {
      const candidate = page.locator(selector);
      if ((await candidate.count()) && await candidate.first().isVisible().catch(() => false)) {
        bodyInput = candidate.first();
        break;
      }
    }
    if (!bodyInput) throw new Error('未找到正文编辑区域，可能是小红书页面结构发生变化');
    const tagName = await bodyInput.evaluate(element => element.tagName.toLowerCase());
    if (tagName === 'textarea' || tagName === 'input') await bodyInput.fill(body);
    else {
      await bodyInput.click();
      await bodyInput.press('Control+A').catch(() => {});
      await bodyInput.fill(body).catch(async () => { await bodyInput.pressSequentially(body, { delay: 8 }); });
    }
    const readiness = await this.waitForUploadAndPublishReady(page, uploadTimeoutMs);
    await page.bringToFront();
    return { readiness };
  }

  async inspectPublishControl(page, diagnostics = false) {
    const markerAttribute = 'data-codex-xhs-publish-candidate';
    const markerToken = `xhs-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const frameResults = [];
    for (const [frameIndex, frame] of page.frames().entries()) {
      const result = await frame.evaluate(({ includeDiagnostics, markerAttribute: markerName, markerToken: markerValue }) => {
        const normalize = value => String(value || '').replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\s+/g, '').trim();
        const visible = element => {
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth
            && style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
        };
        const composedParent = element => element.parentElement || element.getRootNode?.()?.host || null;
        const collect = root => {
          const output = [];
          const visit = node => {
            for (const child of Array.from(node.children || [])) {
              output.push(child);
              if (child.shadowRoot) visit(child.shadowRoot);
              visit(child);
            }
          };
          visit(root);
          return output;
        };
        const all = collect(document);
        for (const element of all) element.removeAttribute?.(markerName);
        const details = (element, source) => {
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          const before = getComputedStyle(element, '::before').content;
          const after = getComputedStyle(element, '::after').content;
          return {
            source, tag: element.tagName.toLowerCase(), role: element.getAttribute('role'),
            text: String(element.innerText || '').trim().slice(0, 160), textContent: String(element.textContent || '').trim().slice(0, 160),
            ariaLabel: element.getAttribute('aria-label'), title: element.getAttribute('title'), className: String(element.className || '').slice(0, 500),
            before: before && before !== 'none' ? before.slice(0, 120) : '', after: after && after !== 'none' ? after.slice(0, 120) : '',
            cursor: style.cursor, pointerEvents: style.pointerEvents, backgroundColor: style.backgroundColor,
            rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height), top: Math.round(rect.top), right: Math.round(rect.right), bottom: Math.round(rect.bottom), left: Math.round(rect.left) },
            outerHTML: element.outerHTML.slice(0, 1800)
          };
        };
        const disabledState = element => {
          let current = element;
          for (let depth = 0; current && depth < 6; depth += 1, current = composedParent(current)) {
            const style = getComputedStyle(current);
            if (current.disabled === true) return { disabled: true, reason: depth === 0 ? 'NATIVE_DISABLED' : 'ANCESTOR_NATIVE_DISABLED' };
            if (current.getAttribute('aria-disabled') === 'true') return { disabled: true, reason: depth === 0 ? 'ARIA_DISABLED' : 'ANCESTOR_ARIA_DISABLED' };
            if (current.getAttribute('data-disabled') === 'true') return { disabled: true, reason: depth === 0 ? 'DATA_DISABLED' : 'ANCESTOR_DATA_DISABLED' };
            if (/(^|\s)(disabled|is-disabled)(\s|$)/i.test(String(current.className || ''))) {
              return { disabled: true, reason: depth === 0 ? 'DISABLED_CLASS' : 'ANCESTOR_DISABLED_CLASS' };
            }
            // CSS allows a descendant to restore hit testing with pointer-events:auto even when a
            // wrapper uses pointer-events:none. Only the resolved click target's computed value is
            // authoritative; treating every ancestor as disabled rejects Xiaohongshu's fixed footer.
            if (depth === 0 && style.pointerEvents === 'none') return { disabled: true, reason: 'POINTER_EVENTS_NONE' };
          }
          return { disabled: false, reason: null };
        };
        const labels = element => {
          const pseudo = [getComputedStyle(element, '::before').content, getComputedStyle(element, '::after').content]
            .map(value => value && value !== 'none' ? value.replace(/^['"]|['"]$/g, '') : '');
          return [element.innerText, element.textContent, element.getAttribute('aria-label'), element.getAttribute('title'), element.getAttribute('value'), ...pseudo]
            .map(normalize).filter(Boolean);
        };
        const interactive = element => {
          let current = element;
          let styled = null;
          for (let depth = 0; current && depth < 7; depth += 1, current = composedParent(current)) {
            const style = getComputedStyle(current);
            const semantic = /^(BUTTON|A)$/.test(current.tagName) || current.getAttribute('role') === 'button' || current.hasAttribute('onclick')
              || Number(current.getAttribute('tabindex')) >= 0 || /publish|submit|primary/i.test(String(current.className || ''));
            if (!styled && (style.cursor === 'pointer' || style.backgroundColor !== 'rgba(0, 0, 0, 0)')) styled = current;
            if (semantic) return current;
          }
          return styled || element;
        };
        const candidates = [];
        const add = (element, source) => {
          if (!element || !visible(element) || candidates.some(item => item.element === element)) return;
          candidates.push({ element, source });
        };
        for (const element of all) {
          if (visible(element) && labels(element).some(label => label === '\u53d1\u5e03')) add(interactive(element), 'exact-label');
        }
        const leaveElements = all.filter(element => visible(element) && labels(element).some(label => label === '\u6682\u5b58\u79bb\u5f00'));
        for (const leaveElement of leaveElements) {
          const leaveTarget = interactive(leaveElement);
          const leaveRect = leaveTarget.getBoundingClientRect();
          let scope = composedParent(leaveTarget);
          for (let depth = 0; scope && depth < 6; depth += 1, scope = composedParent(scope)) {
            const scoped = [scope, ...collect(scope.shadowRoot || scope)];
            const rowCandidates = scoped.filter(element => {
              if (element === leaveTarget || !visible(element)) return false;
              const rect = element.getBoundingClientRect();
              const style = getComputedStyle(element);
              const color = style.backgroundColor.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
              const red = color && Number(color[1]) >= 180 && Number(color[2]) <= 120 && Number(color[3]) <= 150;
              const sameRow = Math.abs((rect.top + rect.height / 2) - (leaveRect.top + leaveRect.height / 2)) <= Math.max(45, leaveRect.height);
              return red && sameRow && rect.left >= leaveRect.left && rect.width >= 50 && rect.height >= 24 && rect.width * rect.height <= 80000;
            }).sort((a, b) => {
              const ar = a.getBoundingClientRect(); const br = b.getBoundingClientRect();
              return (ar.width * ar.height) - (br.width * br.height) || ar.left - br.left;
            });
            if (rowCandidates[0]) { add(interactive(rowCandidates[0]), 'adjacent-to-draft-button'); break; }
          }
        }
        const resolvedWithElements = candidates.map(({ element, source }) => {
          const state = disabledState(element);
          return { element, detail: { ...details(element, source), enabled: !state.disabled, disabledReason: state.reason } };
        });
        const exactCandidates = resolvedWithElements.filter(item => item.detail.source === 'exact-label');
        const fallbackCandidates = resolvedWithElements.filter(item => item.detail.source === 'adjacent-to-draft-button');
        const primaryPool = exactCandidates.length ? exactCandidates : fallbackCandidates;
        const selectedEntry = primaryPool.length === 1 ? primaryPool[0] : null;
        if (selectedEntry) selectedEntry.element.setAttribute(markerName, markerValue);
        const bottomInteractive = includeDiagnostics ? all.filter(element => {
          if (!visible(element)) return false;
          const rect = element.getBoundingClientRect(); const style = getComputedStyle(element);
          return rect.top >= innerHeight * 0.72 && (style.cursor === 'pointer' || /^(BUTTON|A)$/.test(element.tagName) || element.getAttribute('role') === 'button');
        }).sort((a, b) => {
          const ar = a.getBoundingClientRect(); const br = b.getBoundingClientRect(); return ar.top - br.top || ar.left - br.left;
        }).slice(0, 80).map(element => details(element, 'bottom-interactive')) : [];
        return {
          selected: selectedEntry ? { ...selectedEntry.detail, marker: markerValue } : null,
          candidates: resolvedWithElements.map(item => item.detail),
          primaryCandidateCount: primaryPool.length,
          primarySource: exactCandidates.length ? 'exact-label' : fallbackCandidates.length ? 'adjacent-to-draft-button' : null,
          bottomInteractive
        };
      }, { includeDiagnostics: diagnostics, markerAttribute, markerToken }).catch(error => ({ error: error.message, selected: null, candidates: [], primaryCandidateCount: 0, bottomInteractive: [] }));
      frameResults.push({ frameIndex, url: frame.url(), ...result });
    }
    let accessibility = [];
    if (diagnostics) {
      try {
        const session = await page.context().newCDPSession(page);
        await session.send('Accessibility.enable');
        const tree = await session.send('Accessibility.getFullAXTree');
        accessibility = (tree.nodes || []).filter(node => /\u53d1\u5e03|\u6682\u5b58\u79bb\u5f00/.test(String(node.name?.value || ''))).slice(0, 80).map(node => ({
          nodeId: node.nodeId, backendDOMNodeId: node.backendDOMNodeId || null, ignored: node.ignored === true,
          role: node.role?.value || '', name: node.name?.value || '',
          disabled: (node.properties || []).some(property => property.name === 'disabled' && property.value?.value === true)
        }));
        await session.detach();
      } catch {}
    }
    const selectedFrames = frameResults.filter(result => result.selected && result.primaryCandidateCount === 1);
    const primaryCount = frameResults.reduce((sum, result) => sum + Number(result.primaryCandidateCount || 0), 0);
    const selected = primaryCount === 1 && selectedFrames.length === 1
      ? { ...selectedFrames[0].selected, frameIndex: selectedFrames[0].frameIndex, frameUrl: selectedFrames[0].url, markerAttribute }
      : null;
    return {
      visible: Boolean(selected),
      enabled: Boolean(selected?.enabled),
      selected,
      primaryCount,
      reason: primaryCount > 1 ? 'AMBIGUOUS_PRIMARY' : primaryCount === 0 ? 'PRIMARY_NOT_FOUND' : selected && !selected.enabled ? 'PRIMARY_DISABLED' : null,
      frames: diagnostics ? frameResults : undefined,
      accessibility: diagnostics ? accessibility : undefined
    };
  }

  async waitForUploadAndPublishReady(page, timeoutMs = 180000) {
    const deadline = Date.now() + timeoutMs;
    const requiredStableSamples = 5;
    let last = null;
    let stableReadySamples = 0;
    while (Date.now() < deadline) {
      const publishControl = await this.inspectPublishControl(page);
      const publishButtonVisible = publishControl.visible;
      const publishButtonEnabled = publishControl.enabled;
      const text = await page.locator('body').innerText({ timeout: 5000 }).catch(() => '');
      last = analyzePublishReadiness({ text, publishButtonVisible, publishButtonEnabled });
      // Only observe readiness here. Never click while sampling: Xiaohongshu's
      // final publish control must stay ready across several consecutive checks.
      stableReadySamples = last.ready ? stableReadySamples + 1 : 0;
      if (stableReadySamples >= requiredStableSamples) return { ...last, stableReadySamples };
      await page.waitForTimeout(1000);
    }
    const reason = last?.busy ? '素材仍在上传、处理或生成封面' : last?.publishButtonVisible ? '发布按钮仍不可用，可能存在未完成的必填项' : '未找到发布按钮';
    throw new Error(`${reason}，等待超时后已停止提交`);
  }

  async clickFinalPublish(page) {
    await this.assertRuntimeAllowed();
    const pageState = await this.inspectLoginState(page).catch(() => ({ state: 'UNKNOWN' }));
    if (pageState.state === 'VERIFY_REQUIRED') return { clicked: false, reason: 'VERIFY_REQUIRED', primaryCount: 0 };
    await page.keyboard.press('Escape').catch(() => {});

    const firstInspection = await this.inspectPublishControl(page, true);
    if (!firstInspection.visible || !firstInspection.enabled) {
      return { clicked: false, reason: firstInspection.reason || 'PRIMARY_NOT_FOUND', primaryCount: Number(firstInspection.primaryCount || 0), inspection: firstInspection };
    }
    await page.waitForTimeout(120);
    await this.assertRuntimeAllowed();
    const secondInspection = await this.inspectPublishControl(page, true);
    if (!secondInspection.visible || !secondInspection.enabled) {
      return { clicked: false, reason: secondInspection.reason || 'PRIMARY_CHANGED_BEFORE_CLICK', primaryCount: Number(secondInspection.primaryCount || 0), inspection: secondInspection };
    }

    const stableCandidate = (before, after) => {
      const left = before?.selected; const right = after?.selected;
      if (!left || !right) return false;
      const normalize = value => String(value || '').replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\s+/g, '').trim();
      const leftLabel = normalize(left.text || left.textContent || left.ariaLabel || left.title);
      const rightLabel = normalize(right.text || right.textContent || right.ariaLabel || right.title);
      const leftRect = left.rect || {}; const rightRect = right.rect || {};
      const centerDelta = Math.abs((Number(leftRect.x || 0) + Number(leftRect.width || 0) / 2) - (Number(rightRect.x || 0) + Number(rightRect.width || 0) / 2))
        + Math.abs((Number(leftRect.y || 0) + Number(leftRect.height || 0) / 2) - (Number(rightRect.y || 0) + Number(rightRect.height || 0) / 2));
      return left.source === right.source && left.frameIndex === right.frameIndex && left.tag === right.tag
        && leftLabel === rightLabel && centerDelta <= 30;
    };
    if (!stableCandidate(firstInspection, secondInspection)) {
      return { clicked: false, reason: 'PRIMARY_CHANGED_BEFORE_CLICK', primaryCount: Number(secondInspection.primaryCount || 0), firstInspection, secondInspection };
    }

    const selected = secondInspection.selected;
    const frame = page.frames()[selected.frameIndex];
    if (!frame || typeof frame.locator !== 'function') return { clicked: false, reason: 'PRIMARY_FRAME_MISSING', primaryCount: 1 };
    const selector = `[${selected.markerAttribute}="${selected.marker}"]`;
    const target = frame.locator(selector);
    const targetCount = await target.count().catch(() => 0);
    if (targetCount !== 1) return { clicked: false, reason: targetCount ? 'AMBIGUOUS_PRIMARY' : 'PRIMARY_CHANGED_BEFORE_CLICK', primaryCount: targetCount };
    const locator = target.first();
    const targetReady = await locator.isVisible().catch(() => false)
      && await locator.isEnabled().catch(() => true)
      && await locator.evaluate(element => element.getAttribute('aria-disabled') !== 'true'
        && element.getAttribute('data-disabled') !== 'true'
        && !/(^|\s)(disabled|is-disabled)(\s|$)/i.test(String(element.className || ''))).catch(() => false);
    if (!targetReady) return { clicked: false, reason: 'PRIMARY_DISABLED_BEFORE_CLICK', primaryCount: 1 };

    await this.assertRuntimeAllowed();
    await locator.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
    await locator.click({ timeout: 8000 });
    const clickDetail = {
      clicked: true,
      strategy: 'shared-inspection-locator',
      primaryCount: 1,
      source: selected.source,
      tag: selected.tag,
      role: selected.role,
      className: selected.className,
      frameUrl: selected.frameUrl
    };

    await page.waitForTimeout(1500);
    const dialogs = page.getByRole('dialog').filter({ hasText: /\u53d1\u5e03|\u786e\u8ba4/ });
    const dialogCount = await dialogs.count().catch(() => 0);
    const visibleDialogs = [];
    for (let index = 0; index < dialogCount; index += 1) {
      const dialog = dialogs.nth(index);
      if (await dialog.isVisible().catch(() => false)) visibleDialogs.push(dialog);
    }
    if (!visibleDialogs.length) return { ...clickDetail, confirmation: 'NOT_PRESENT' };
    if (visibleDialogs.length !== 1) return { ...clickDetail, confirmation: 'AMBIGUOUS', confirmationDialogCount: visibleDialogs.length };

    const confirmCandidates = visibleDialogs[0].getByText(/\u786e\u8ba4\u53d1\u5e03|\u786e\u8ba4|\u7ee7\u7eed\u53d1\u5e03/, { exact: true });
    const confirmCount = await confirmCandidates.count().catch(() => 0);
    const visibleConfirms = [];
    for (let index = 0; index < confirmCount; index += 1) {
      const confirm = confirmCandidates.nth(index);
      if (await confirm.isVisible().catch(() => false) && await confirm.isEnabled().catch(() => true)) visibleConfirms.push(confirm);
    }
    if (visibleConfirms.length !== 1) return { ...clickDetail, confirmation: 'AMBIGUOUS', confirmationCount: visibleConfirms.length };
    await this.assertRuntimeAllowed();
    await visibleConfirms[0].click({ timeout: 8000 });
    return { ...clickDetail, confirmation: 'CLICKED', confirmationCount: 1 };
  }

  async capturePublishBaseline(page) {
    const successTextCount = await page.getByText(/发布成功|发布完成/, { exact: false }).count().catch(() => 0);
    return { url: page.url(), successTextCount, capturedAt: new Date().toISOString() };
  }

  async waitForPublishSuccess(page, baseline = {}) {
    const deadline = Date.now() + this.sendTimeoutMs;
    const baselineUrl = String(baseline.url || '');
    const baselineTextCount = Number(baseline.successTextCount || 0);
    while (Date.now() < deadline) {
      await this.assertRuntimeAllowed();
      const url = page.url();
      const successText = page.getByText(/发布成功|发布完成/, { exact: false });
      const successTextCount = await successText.count().catch(() => 0);
      let visibleSuccessCount = 0;
      for (let index = 0; index < successTextCount; index += 1) {
        if (await successText.nth(index).isVisible().catch(() => false)) visibleSuccessCount += 1;
      }
      if (visibleSuccessCount > baselineTextCount) {
        return { confirmed: true, source: 'new-visible-success-signal', url, baselineUrl, visibleSuccessCount, baselineTextCount };
      }
      if (url !== baselineUrl && /\/publish\/success(?:[/?#]|$)/i.test(url)) {
        return { confirmed: true, source: 'new-success-url', url, baselineUrl, visibleSuccessCount, baselineTextCount };
      }
      await page.waitForTimeout(1000);
    }
    return { confirmed: false, source: null, url: page.url(), baselineUrl, baselineTextCount };
  }

  async evidence(payload, message, page, stage, extra = {}) {
    const stamp = new Date().toISOString();
    const safeStamp = stamp.replace(/[:.]/g, '-');
    let screenshotPath = null;
    if (page) {
      screenshotPath = path.join(this.logsDir, `xhs-${stage}-${safeStamp}.png`);
      await page.screenshot({ path: screenshotPath, fullPage: false }).catch(() => { screenshotPath = null; });
    }
    const record = {
      stamp,
      stage,
      message,
      platformCode: payload.platformCode,
      profileName: payload.profileName,
      url: page?.url?.() || null,
      screenshotPath,
      payload: {
        taskId: payload.taskId || null,
        targetId: payload.targetId || null,
        messageId: payload.messageId || null,
        platformCode: payload.platformCode || this.platformCode,
        accountId: payload.accountId || null,
        profileName: payload.profileName || null,
        materialPath: payload.materialPath || null,
        draftFingerprintHash: payload.draftFingerprint?.fingerprintHash || null
      },
      extra
    };
    const evidencePath = path.join(this.logsDir, `xhs-rpa-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
    fs.writeFileSync(evidencePath, JSON.stringify(record, null, 2), 'utf8');
    return { message, stage, evidencePath, screenshotPath, platformCode: payload.platformCode || this.platformCode, profileName: payload.profileName, completedAt: stamp, ...extra };
  }
}

