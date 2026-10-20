import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { pathInsideRoots } from '../../../src/services/browser-control-policy.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PROXY_ENTRY = path.resolve(__dirname, '../vendor/web-access/cdp-proxy.mjs');

function providerError(code, message, detail = null) {
  const error = new Error(message);
  error.code = code;
  error.detail = detail;
  return error;
}

function query(pathname, params = {}) {
  const url = new URL(pathname, 'http://127.0.0.1');
  for (const [key, value] of Object.entries(params)) if (value !== null && value !== undefined && value !== '') url.searchParams.set(key, String(value));
  return `${url.pathname}${url.search}`;
}

async function stopTrackedChild(child, logger = console) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  const exited = await new Promise(resolve => {
    const timer = setTimeout(() => { cleanup(); resolve(false); }, 2_000);
    const onExit = () => { cleanup(); resolve(true); };
    const cleanup = () => { clearTimeout(timer); child.off('exit', onExit); };
    child.once('exit', onExit);
  });
  if (exited) return;
  if (process.platform === 'win32' && Number.isInteger(child.pid)) {
    await new Promise(resolve => {
      const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      killer.once('exit', resolve);
      killer.once('error', error => { logger.warn(`[BrowserControl] 无法回收 CDP Proxy PID ${child.pid}: ${error.message}`); resolve(); });
    });
  } else child.kill('SIGKILL');
}

export class WebAccessCdpProvider {
  constructor({ port = 3456, browser = 'chrome', browserDebugPort = null, autoStart = true, requestTimeoutMs = 30_000, tabIdleTimeoutMs = 900_000, fileRoots = [], riskAcknowledged = false, proxyEntry = DEFAULT_PROXY_ENTRY, logger = console } = {}) {
    this.name = 'web_access_cdp';
    this.port = port;
    this.browser = browser;
    this.browserDebugPort = Number(browserDebugPort) || null;
    this.autoStart = autoStart;
    this.requestTimeoutMs = requestTimeoutMs;
    this.tabIdleTimeoutMs = tabIdleTimeoutMs;
    this.fileRoots = fileRoots.map(item => path.resolve(item));
    this.riskAcknowledged = riskAcknowledged;
    this.proxyEntry = proxyEntry;
    this.logger = logger;
    this.child = null;
    this.startPromise = null;
  }

  get baseUrl() { return `http://127.0.0.1:${this.port}`; }

  async request(pathname, { method = 'GET', body = null, binary = false, timeoutMs = this.requestTimeoutMs } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}${pathname}`, {
        method,
        body,
        headers: body == null ? undefined : { 'Content-Type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8' },
        signal: controller.signal
      });
      const payload = binary ? Buffer.from(await response.arrayBuffer()) : await response.text();
      if (!response.ok) {
        let parsed = payload;
        if (!binary) { try { parsed = JSON.parse(payload); } catch {} }
        throw providerError('WEB_ACCESS_PROXY_REQUEST_FAILED', parsed?.error || `CDP Proxy 请求失败：HTTP ${response.status}`, { status: response.status, pathname, response: parsed });
      }
      if (binary) return payload;
      if (!payload) return {};
      try { return JSON.parse(payload); } catch { return { value: payload }; }
    } catch (error) {
      if (error.name === 'AbortError') throw providerError('WEB_ACCESS_PROXY_TIMEOUT', `CDP Proxy 请求超时（${timeoutMs}ms）`, { pathname });
      if (error.code) throw error;
      throw providerError('WEB_ACCESS_PROXY_UNREACHABLE', `无法连接本机 CDP Proxy：${error.message}`, { baseUrl: this.baseUrl, pathname });
    } finally {
      clearTimeout(timer);
    }
  }

  async health({ start = false } = {}) {
    try { return await this.request('/health', { timeoutMs: 2_000 }); }
    catch (error) {
      if (!start) return { status: 'unavailable', connected: false, error: error.message, code: error.code };
      await this.start();
      return this.request('/health', { timeoutMs: 3_000 });
    }
  }

  async start() {
    if (!this.autoStart) throw providerError('WEB_ACCESS_PROXY_AUTOSTART_DISABLED', 'CDP Proxy 未运行，且自动启动已关闭');
    if (!this.riskAcknowledged) {
      throw providerError('BROWSER_CONTROL_RISK_ACK_REQUIRED', '启动 web-access 前必须确认账号风控风险，并设置 BROWSER_CONTROL_RISK_ACKNOWLEDGED=true');
    }
    if (this.startPromise) return this.startPromise;
    this.startPromise = (async () => {
      const existing = await this.health({ start: false });
      if (existing.status === 'ok') return existing;
      if (!fs.existsSync(this.proxyEntry)) throw providerError('WEB_ACCESS_PROXY_MISSING', `CDP Proxy 文件不存在：${this.proxyEntry}`);
      this.logger.warn('[BrowserControl] 即将通过 CDP 控制已登录浏览器。高频自动化可能触发平台风控或账号限制；请保持低频、人工审核和平台白名单。');
      this.child = spawn(process.execPath, [this.proxyEntry, `--browser=${this.browser}`], {
        cwd: path.dirname(this.proxyEntry),
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, CDP_PROXY_PORT: String(this.port), CDP_TAB_IDLE_TIMEOUT: String(this.tabIdleTimeoutMs), ...(this.browserDebugPort ? { CDP_BROWSER_PORT: String(this.browserDebugPort) } : {}) }
      });
      this.child.stdout?.on('data', chunk => this.logger.log(`[CDP Proxy] ${String(chunk).trimEnd()}`));
      this.child.stderr?.on('data', chunk => this.logger.error(`[CDP Proxy] ${String(chunk).trimEnd()}`));
      this.child.once('exit', code => { this.logger.warn(`[BrowserControl] CDP Proxy exited with code ${code}`); this.child = null; });
      const deadline = Date.now() + 8_000;
      while (Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 250));
        const state = await this.health({ start: false });
        if (state.status === 'ok') return state;
        if (this.child?.exitCode !== null && this.child?.exitCode !== undefined) break;
      }
      throw providerError('WEB_ACCESS_PROXY_START_FAILED', 'CDP Proxy 启动失败或未在规定时间内就绪');
    })();
    try { return await this.startPromise; }
    finally { this.startPromise = null; }
  }

  async ensureReady() {
    let health = await this.health({ start: this.autoStart });
    if (health.status !== 'ok') throw providerError('WEB_ACCESS_PROXY_UNAVAILABLE', health.error || 'CDP Proxy 不可用', health);
    if (!health.connected) {
      // /health intentionally does not connect to Chrome. Trigger one read-only CDP request so a
      // newly started proxy can establish and pin its configured browser before declaring failure.
      try { await this.request('/targets', { timeoutMs: Math.min(this.requestTimeoutMs, 5_000) }); }
      catch (error) {
        throw providerError(error.code || 'BROWSER_REMOTE_DEBUGGING_REQUIRED', `Web Access 无法连接平台浏览器：${error.message}`, { health, cause: error.detail || null });
      }
      health = await this.health({ start: false });
    }
    if (health.status !== 'ok' || !health.connected) {
      throw providerError('BROWSER_REMOTE_DEBUGGING_REQUIRED', 'Web Access Proxy 已启动，但尚未连接到项目托管浏览器', health);
    }
    return health;
  }

  assertFiles(files = []) {
    for (const file of files) {
      if (!pathInsideRoots(file, this.fileRoots)) throw providerError('BROWSER_FILE_PATH_BLOCKED', `文件不在允许目录中：${file}`, { roots: this.fileRoots });
      if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw providerError('BROWSER_FILE_NOT_FOUND', `文件不存在：${file}`);
    }
  }

  async execute(command, context = {}) {
    if (command.action === 'HEALTH_CHECK') return { ...(await this.health({ start: false })), provider: this.name };
    await this.ensureReady();
    const target = context.managedTabId || null;
    switch (command.action) {
      case 'OPEN_PAGE': {
        const result = await this.request('/new', { method: 'POST', body: command.params.url });
        return { opened: true, managedTabId: result.targetId, url: command.params.url };
      }
      case 'NAVIGATE':
        if (!target) throw providerError('BROWSER_MANAGED_TAB_REQUIRED', 'NAVIGATE 需要 session 中已存在 managedTabId');
        return { ...(await this.request(query('/navigate', { target }), { method: 'POST', body: command.params.url })), managedTabId: target, url: command.params.url };
      case 'READ_PAGE_STATE':
        if (!target) throw providerError('BROWSER_MANAGED_TAB_REQUIRED', 'READ_PAGE_STATE 需要 managedTabId');
        return { ...(await this.request(query('/info', { target }))), managedTabId: target };
      case 'READ_TEXT': {
        if (!target) throw providerError('BROWSER_MANAGED_TAB_REQUIRED', 'READ_TEXT 需要 managedTabId');
        const selector = command.params.selector || 'body';
        const expression = `(() => { const el = document.querySelector(${JSON.stringify(selector)}); return JSON.stringify({ selector: ${JSON.stringify(selector)}, found: Boolean(el), text: (el?.innerText || el?.textContent || '').slice(0, ${Number(command.params.maxChars)}) }); })()`;
        const evaluated = await this.request(query('/eval', { target }), { method: 'POST', body: expression });
        let value = evaluated.value;
        if (typeof value === 'string') { try { value = JSON.parse(value); } catch {} }
        return { managedTabId: target, ...(value && typeof value === 'object' ? value : { text: String(value || '') }) };
      }
      case 'CLICK':
      case 'CLICK_AT': {
        if (!target) throw providerError('BROWSER_MANAGED_TAB_REQUIRED', `${command.action} 需要 managedTabId`);
        const endpoint = command.action === 'CLICK_AT' ? '/clickAt' : '/click';
        return { ...(await this.request(query(endpoint, { target }), { method: 'POST', body: command.params.selector })), managedTabId: target };
      }
      case 'SCROLL':
        if (!target) throw providerError('BROWSER_MANAGED_TAB_REQUIRED', 'SCROLL 需要 managedTabId');
        return { ...(await this.request(query('/scroll', { target, direction: command.params.direction, y: command.params.y }))), managedTabId: target };
      case 'SET_FILES':
        if (!target) throw providerError('BROWSER_MANAGED_TAB_REQUIRED', 'SET_FILES 需要 managedTabId');
        this.assertFiles(command.params.files);
        return { ...(await this.request(query('/setFiles', { target }), { method: 'POST', body: JSON.stringify({ selector: command.params.selector, files: command.params.files }) })), managedTabId: target };
      case 'SCREENSHOT':
        if (!target) throw providerError('BROWSER_MANAGED_TAB_REQUIRED', 'SCREENSHOT 需要 managedTabId');
        return { ...(await this.request(query('/screenshot', { target, file: context.evidencePath }))), managedTabId: target, evidenceRef: context.evidencePath };
      case 'CLOSE_TAB':
        if (!target) return { closed: false, reason: 'NO_MANAGED_TAB' };
        return { ...(await this.request(query('/close', { target }))), closed: true, managedTabId: null };
      default:
        throw providerError('BROWSER_ACTION_NOT_IMPLEMENTED', `web-access Provider 尚未实现动作 ${command.action}`);
    }
  }

  async stop() {
    const child = this.child;
    this.child = null;
    await stopTrackedChild(child, this.logger);
  }
}
