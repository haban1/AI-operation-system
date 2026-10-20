import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { chromium } from 'playwright-core';
import { WebAccessCdpProvider } from './providers/web-access-cdp-provider.js';

const DEFAULT_PLATFORM_ORDER = Object.freeze(['xiaohongshu', 'douyin', 'wechat_channels', 'bilibili', 'weibo']);

function runtimeError(code, message, detail = null) {
  const error = new Error(message);
  error.code = code;
  error.detail = detail;
  return error;
}

async function fetchJson(url, timeoutMs = 1_500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function readDevToolsMarker(profileDir) {
  const markerPath = path.join(profileDir, 'DevToolsActivePort');
  if (!fs.existsSync(markerPath)) return { exists: false, markerPath, port: null, webSocketPath: null };
  try {
    const [portText = '', webSocketPath = ''] = fs.readFileSync(markerPath, 'utf8').split(/\r?\n/);
    const port = Number(portText);
    return {
      exists: true,
      markerPath,
      port: Number.isInteger(port) && port > 0 ? port : null,
      webSocketPath: String(webSocketPath || '').trim() || null
    };
  } catch (error) {
    return { exists: true, markerPath, port: null, webSocketPath: null, readError: error.message };
  }
}

function profileLockDetails(profileDir) {
  const names = ['SingletonLock', 'SingletonCookie', 'SingletonSocket'];
  const locks = [];
  for (const name of names) {
    const lockPath = path.join(profileDir, name);
    try {
      if (!fs.existsSync(lockPath)) continue;
      const stat = fs.lstatSync(lockPath);
      locks.push({ name, path: lockPath, type: stat.isSymbolicLink() ? 'symlink' : stat.isDirectory() ? 'directory' : 'file' });
    } catch (error) {
      locks.push({ name, path: lockPath, type: 'unknown', error: error.message });
    }
  }
  return locks;
}

async function waitForProfileRelease(profileDir, timeoutMs = 10_000) {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  do {
    const locks = profileLockDetails(profileDir);
    if (locks.length === 0) return { released: true, locks: [] };
    if (Date.now() >= deadline) return { released: false, locks };
    await sleep(100);
  } while (true);
}

async function tcpPortListening(port, timeoutMs = 500) {
  return await new Promise(resolve => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    const finish = value => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

function readLogTail(logPath, maxBytes = 12_000) {
  try {
    if (!logPath || !fs.existsSync(logPath)) return null;
    const stat = fs.statSync(logPath);
    const start = Math.max(0, stat.size - maxBytes);
    const length = stat.size - start;
    if (length <= 0) return null;
    const fd = fs.openSync(logPath, 'r');
    try {
      const buffer = Buffer.alloc(length);
      fs.readSync(fd, buffer, 0, length, start);
      return buffer.toString('utf8').trim() || null;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

async function waitForWriteStreamOpen(stream) {
  if (!stream) throw new Error('日志流未创建');
  if (Number.isInteger(stream.fd)) return;
  await new Promise((resolve, reject) => {
    const cleanup = () => {
      stream.off('open', onOpen);
      stream.off('error', onError);
    };
    const onOpen = () => { cleanup(); resolve(); };
    const onError = error => { cleanup(); reject(error); };
    stream.once('open', onOpen);
    stream.once('error', onError);
  });
}

async function closeWriteStream(stream) {
  if (!stream || stream.closed || stream.destroyed) return;
  await new Promise(resolve => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      stream.off('close', done);
      stream.off('error', done);
      resolve();
    };
    stream.once('close', done);
    stream.once('error', done);
    stream.end();
    if (stream.closed || stream.destroyed) done();
  });
}

async function waitForProcessExit(child, timeoutMs = 2_000) {
  if (!child || child.exitCode !== null) return true;
  return await new Promise(resolve => {
    const timer = setTimeout(() => { cleanup(); resolve(false); }, timeoutMs);
    const onExit = () => { cleanup(); resolve(true); };
    const cleanup = () => { clearTimeout(timer); child.off('exit', onExit); };
    child.once('exit', onExit);
  });
}

async function terminateTrackedProcessTree(child, logger = console, spawnProcess = spawn) {
  if (!child || child.exitCode !== null) return true;
  if (process.platform === 'win32' && Number.isInteger(child.pid)) {
    await new Promise(resolve => {
      const killer = spawnProcess('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      killer.once('exit', resolve);
      killer.once('error', error => { logger.warn(`[WebAccess] 无法回收本 Agent 启动的浏览器进程树 PID ${child.pid}: ${error.message}`); resolve(); });
    });
    return await waitForProcessExit(child, 2_000);
  }
  child.kill('SIGTERM');
  if (await waitForProcessExit(child)) return true;
  child.kill('SIGKILL');
  return await waitForProcessExit(child, 1_000);
}

function trackedLaunchOwnership(state) {
  const child = state?.browserProcess;
  const proof = state?.browserLaunchOwnership;
  const childAlive = Boolean(child && child.exitCode === null && Number.isInteger(child.pid));
  const valid = childAlive
    && proof?.preLaunchPortConfirmedFree === true
    && proof.pid === child.pid
    && proof.browserDebugPort === state.browserDebugPort;
  return {
    valid,
    childAlive,
    pid: childAlive ? child.pid : null,
    preLaunchPortConfirmedFree: proof?.preLaunchPortConfirmedFree === true,
    browserDebugPort: proof?.browserDebugPort ?? null,
    launchedAt: proof?.launchedAt || null
  };
}

function validBrowserWebSocketPath(endpoint) {
  return typeof endpoint?.path === 'string' && /^\/devtools\/browser\/[^/?#]+$/i.test(endpoint.path);
}

function serializeState(state) {
  if (!state) return null;
  return {
    platformCode: state.platformCode,
    provider: 'web_access_cdp',
    proxyPort: state.proxyPort,
    browserDebugPort: state.browserDebugPort,
    profileDir: state.profileDir,
    connected: Boolean(state.browser?.isConnected?.()),
    contextConnected: Boolean(state.context),
    browserStartedByManager: Boolean(state.browserProcess),
    trackedLaunchOwnership: trackedLaunchOwnership(state),
    compatibilityLayer: state.context ? 'playwright_connect_over_cdp' : null,
    startedAt: state.startedAt || null,
    logPath: state.logPath || null,
    lastBrowserExit: state.lastBrowserExit || null,
    fallbackActive: Boolean(state.fallbackActive),
    retryNotBefore: state.retryNotBefore ? new Date(state.retryNotBefore).toISOString() : null,
    lastError: state.lastError || null
  };
}

export class PlatformWebAccessManager {
  constructor({
    enabled = false,
    mode = 'web_access_primary',
    legacyFallbackEnabled = true,
    executablePath,
    platformProfiles = {},
    platformOrder = DEFAULT_PLATFORM_ORDER,
    proxyBasePort = 3456,
    browserDebugBasePort = 9310,
    browser = 'chrome',
    proxyAutoStart = true,
    requestTimeoutMs = 30_000,
    tabIdleTimeoutMs = 900_000,
    fileRoots = [],
    riskAcknowledged = false,
    fallbackRetryCooldownMs = 300_000,
    profileReleaseTimeoutMs = 10_000,
    spawnProcess = spawn,
    logger = console
  } = {}) {
    this.name = 'web_access_cdp';
    this.available = true;
    this.enabled = enabled;
    this.mode = String(mode || 'web_access_primary').toLowerCase();
    this.legacyFallbackEnabled = legacyFallbackEnabled;
    this.executablePath = executablePath;
    this.platformProfiles = platformProfiles;
    this.platformOrder = [...platformOrder];
    this.proxyBasePort = proxyBasePort;
    this.browserDebugBasePort = browserDebugBasePort;
    this.browser = browser;
    this.proxyAutoStart = proxyAutoStart;
    this.requestTimeoutMs = requestTimeoutMs;
    this.tabIdleTimeoutMs = tabIdleTimeoutMs;
    this.fileRoots = fileRoots;
    this.riskAcknowledged = riskAcknowledged;
    this.fallbackRetryCooldownMs = Math.max(1_000, Number(fallbackRetryCooldownMs) || 300_000);
    this.profileReleaseTimeoutMs = Math.max(500, Number(profileReleaseTimeoutMs) || 10_000);
    this.spawnProcess = spawnProcess;
    this.logger = logger;
    this.states = new Map();
    this.launches = new Map();
  }

  isPrimaryMode() {
    return this.enabled && this.mode === 'web_access_primary';
  }

  portsFor(platformCode) {
    const index = this.platformOrder.indexOf(platformCode);
    if (index < 0) throw runtimeError('WEB_ACCESS_PLATFORM_NOT_CONFIGURED', `平台 ${platformCode} 未配置 Web Access 隔离运行时`);
    return { proxyPort: this.proxyBasePort + index, browserDebugPort: this.browserDebugBasePort + index };
  }

  providerFor(platformCode) {
    const existing = this.states.get(platformCode);
    if (existing?.provider) return existing.provider;
    const { proxyPort, browserDebugPort } = this.portsFor(platformCode);
    const provider = new WebAccessCdpProvider({
      port: proxyPort,
      browser: this.browser,
      browserDebugPort,
      autoStart: this.proxyAutoStart,
      requestTimeoutMs: this.requestTimeoutMs,
      tabIdleTimeoutMs: this.tabIdleTimeoutMs,
      fileRoots: this.fileRoots,
      riskAcknowledged: this.riskAcknowledged,
      logger: this.logger
    });
    const state = {
      platformCode,
      proxyPort,
      browserDebugPort,
      profileDir: path.resolve(this.platformProfiles[platformCode] || ''),
      provider,
      browserProcess: null,
      browserLaunchOwnership: null,
      browser: null,
      context: null,
      startedAt: null,
      lastError: null,
      logPath: null,
      browserLogStream: null,
      lastBrowserExit: null,
      spawnError: null,
      fallbackActive: false,
      fallbackSince: null,
      retryNotBefore: 0
    };
    this.states.set(platformCode, state);
    return provider;
  }

  stateFor(platformCode) {
    this.providerFor(platformCode);
    return this.states.get(platformCode);
  }

  async debugEndpointStatus(state) {
    const marker = readDevToolsMarker(state.profileDir);
    const ownership = trackedLaunchOwnership(state);
    const portListening = await tcpPortListening(state.browserDebugPort, 500);
    const version = portListening
      ? await fetchJson(`http://127.0.0.1:${state.browserDebugPort}/json/version`, 1_500)
      : null;
    const webSocketDebuggerUrl = version?.webSocketDebuggerUrl || null;
    let endpoint = null;
    if (webSocketDebuggerUrl) {
      try {
        const parsed = new URL(webSocketDebuggerUrl);
        endpoint = { host: parsed.hostname, port: Number(parsed.port), path: parsed.pathname };
      } catch {
        endpoint = { invalid: true };
      }
    }
    const detail = {
      platformCode: state.platformCode,
      profileDir: state.profileDir,
      browserDebugPort: state.browserDebugPort,
      portListening,
      marker,
      webSocketDebuggerUrl,
      endpoint,
      ownership
    };

    if (!portListening) return { ready: false, detail };
    if (!webSocketDebuggerUrl) {
      if (ownership.valid) return { ready: false, detail };
      throw runtimeError(
        'BROWSER_DEBUG_PORT_IN_USE',
        `调试端口 ${state.browserDebugPort} 已被既有进程占用，但未返回有效 /json/version；禁止启动或连接以避免串号`,
        detail
      );
    }
    if (endpoint?.host !== '127.0.0.1' && endpoint?.host !== 'localhost') {
      throw runtimeError('WEB_ACCESS_DEBUG_HOST_MISMATCH', `平台 ${state.platformCode} 的调试端点不是本机地址`, detail);
    }
    if (endpoint?.port !== state.browserDebugPort) {
      throw runtimeError('WEB_ACCESS_DEBUG_ENDPOINT_PORT_MISMATCH', `平台 ${state.platformCode} 的 WebSocket 调试端口与预期不一致`, detail);
    }
    if (!validBrowserWebSocketPath(endpoint)) {
      throw runtimeError('WEB_ACCESS_DEBUG_ENDPOINT_PATH_INVALID', `平台 ${state.platformCode} 的 WebSocket 调试路径无效`, detail);
    }

    // Chrome 152 使用固定 --remote-debugging-port 时可能不写 DevToolsActivePort。
    // 只有“本管理器本轮亲自 spawn、spawn 前端口已确认空闲、子进程仍存活”时，
    // 才允许以受跟踪子进程 + 有效 /json/version 作为替代所有权证明。
    if (ownership.valid) {
      return { ready: true, detail: { ...detail, ownershipProof: 'TRACKED_CHILD_AND_PRELAUNCH_PORT_FREE' } };
    }

    // 对任何外部或既有端口，仍严格要求 Profile 内完整两行 marker 并逐项匹配。
    if (!marker.exists || !marker.port || !marker.webSocketPath) {
      throw runtimeError(
        'BROWSER_DEBUG_PORT_IN_USE',
        `调试端口 ${state.browserDebugPort} 正在监听，但平台 ${state.platformCode} 的 Profile 没有完整有效的 DevToolsActivePort，禁止连接以避免账号串号`,
        detail
      );
    }
    if (marker.port !== state.browserDebugPort) {
      throw runtimeError(
        'WEB_ACCESS_PROFILE_PORT_MISMATCH',
        `平台 ${state.platformCode} Profile 的 DevToolsActivePort=${marker.port}，与预期端口 ${state.browserDebugPort} 不一致`,
        detail
      );
    }
    if (endpoint.path !== marker.webSocketPath) {
      throw runtimeError(
        'WEB_ACCESS_PROFILE_WEBSOCKET_MISMATCH',
        `平台 ${state.platformCode} 的 /json/version WebSocket 与该 Profile 的 DevToolsActivePort 不匹配，禁止接管`,
        detail
      );
    }
    return { ready: true, detail: { ...detail, ownershipProof: 'PROFILE_DEVTOOLS_ACTIVE_PORT' } };
  }

  async debugEndpointReady(state) {
    return (await this.debugEndpointStatus(state)).ready;
  }

  browserFailureDetail(state, extra = {}) {
    return {
      platformCode: state.platformCode,
      browserDebugPort: state.browserDebugPort,
      profileDir: state.profileDir,
      logPath: state.logPath,
      logTail: readLogTail(state.logPath),
      spawnError: state.spawnError,
      lastBrowserExit: state.lastBrowserExit,
      profileLocks: profileLockDetails(state.profileDir),
      ...extra
    };
  }

  async launchBrowser(state) {
    if (!this.riskAcknowledged) throw runtimeError('BROWSER_CONTROL_RISK_ACK_REQUIRED', 'Web Access 主控模式需要设置 BROWSER_CONTROL_RISK_ACKNOWLEDGED=true');
    if (!this.executablePath || !fs.existsSync(this.executablePath)) {
      throw runtimeError('BROWSER_EXECUTABLE_NOT_FOUND', `浏览器程序不存在：${this.executablePath || 'EMPTY'}`);
    }
    if (!state.profileDir) throw runtimeError('BROWSER_PROFILE_NOT_CONFIGURED', `平台 ${state.platformCode} 未配置独立 Profile`);
    fs.mkdirSync(state.profileDir, { recursive: true });

    const preLaunchStatus = await this.debugEndpointStatus(state);
    // 已有端点只有在“本轮受跟踪子进程”或“完整且与当前 Profile 匹配的 marker”
    // 两种所有权证明之一成立时才会 ready；其余既有端口会在状态检查中直接拒绝。
    if (preLaunchStatus.ready) return;
    if (preLaunchStatus.detail?.portListening !== false) {
      throw runtimeError(
        'BROWSER_DEBUG_PORT_IN_USE',
        `调试端口 ${state.browserDebugPort} 未能确认空闲，禁止启动新的 Chrome`,
        preLaunchStatus.detail
      );
    }
    const locks = profileLockDetails(state.profileDir);
    if (locks.length > 0) {
      throw runtimeError(
        'WEB_ACCESS_PROFILE_IN_USE_BY_FALLBACK',
        `平台 ${state.platformCode} 的 Profile 正被现有浏览器占用；本轮不重复启动 Web Access，请先安全关闭该平台 fallback 浏览器后再接管`,
        this.browserFailureDetail(state, { profileLocks: locks })
      );
    }

    const logDir = path.join(state.profileDir, 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    state.logPath = path.join(logDir, `web-access-${state.platformCode}-chrome.log`);
    fs.appendFileSync(
      state.logPath,
      `\n[${new Date().toISOString()}] launch platform=${state.platformCode} debugPort=${state.browserDebugPort} profile=${state.profileDir}\n`,
      'utf8'
    );
    const logStream = fs.createWriteStream(state.logPath, { flags: 'a' });
    state.browserLogStream = logStream;
    try {
      await waitForWriteStreamOpen(logStream);
    } catch (error) {
      await closeWriteStream(logStream).catch(() => {});
      state.browserLogStream = null;
      throw runtimeError(
        'BROWSER_LOG_OPEN_FAILED',
        `平台 ${state.platformCode} 的 Chrome 日志文件无法打开：${error.message}`,
        this.browserFailureDetail(state)
      );
    }
    state.spawnError = null;
    state.lastBrowserExit = null;

    const args = [
      `--user-data-dir=${state.profileDir}`,
      `--remote-debugging-port=${state.browserDebugPort}`,
      '--remote-debugging-address=127.0.0.1',
      '--remote-allow-origins=*',
      '--no-first-run',
      '--no-default-browser-check',
      '--start-maximized',
      'about:blank'
    ];
    let launchedProcess;
    try {
      launchedProcess = this.spawnProcess(this.executablePath, args, {
        cwd: path.dirname(this.executablePath),
        windowsHide: true,
        detached: false,
        stdio: ['ignore', logStream, logStream]
      });
    } catch (error) {
      state.spawnError = { code: error.code || null, message: error.message };
      await closeWriteStream(logStream);
      state.browserLogStream = null;
      throw runtimeError(
        'BROWSER_PROCESS_SPAWN_FAILED',
        `平台 ${state.platformCode} 的 Chrome 进程创建失败：${error.message}`,
        this.browserFailureDetail(state)
      );
    }
    state.browserProcess = launchedProcess;
    state.browserLaunchOwnership = {
      pid: Number.isInteger(launchedProcess.pid) ? launchedProcess.pid : null,
      browserDebugPort: state.browserDebugPort,
      preLaunchPortConfirmedFree: preLaunchStatus.detail?.portListening === false,
      launchedAt: new Date().toISOString()
    };
    launchedProcess.once('error', error => {
      state.spawnError = { code: error.code || null, message: error.message };
      this.logger.warn(`[WebAccess] ${state.platformCode} 浏览器进程启动错误：${error.message}`);
    });
    launchedProcess.once('exit', (code, signal) => {
      state.lastBrowserExit = { code, signal: signal || null, at: new Date().toISOString() };
      this.logger.warn(`[WebAccess] ${state.platformCode} 浏览器进程已退出（code=${code}, signal=${signal || 'none'}），日志：${state.logPath}`);
      if (state.browserProcess === launchedProcess) state.browserProcess = null;
      if (state.browserLaunchOwnership?.pid === launchedProcess.pid) state.browserLaunchOwnership = null;
      if (state.browserLogStream === logStream) {
        void closeWriteStream(logStream);
        state.browserLogStream = null;
      }
    });

    const deadline = Date.now() + Math.max(10_000, this.requestTimeoutMs);
    let lastStatus = null;
    while (Date.now() < deadline) {
      lastStatus = await this.debugEndpointStatus(state);
      if (lastStatus.ready) return;
      if (launchedProcess.exitCode !== null || state.spawnError) break;
      await sleep(250);
    }

    if (launchedProcess.exitCode !== null || state.spawnError) {
      await closeWriteStream(logStream);
      if (state.browserLogStream === logStream) state.browserLogStream = null;
    }
    const detail = this.browserFailureDetail(state, {
      endpointStatus: lastStatus?.detail || null,
      processExitCode: launchedProcess.exitCode,
      processSignalCode: launchedProcess.signalCode || null
    });
    if (state.spawnError) {
      throw runtimeError('BROWSER_PROCESS_SPAWN_FAILED', `平台 ${state.platformCode} 的 Chrome 启动失败：${state.spawnError.message}`, detail);
    }
    if (launchedProcess.exitCode !== null) {
      throw runtimeError(
        'BROWSER_PROCESS_EXITED_EARLY',
        `平台 ${state.platformCode} 的 Chrome 在调试端口就绪前退出（code=${launchedProcess.exitCode}）；请查看平台独立日志`,
        detail
      );
    }
    throw runtimeError(
      'BROWSER_REMOTE_DEBUGGING_TIMEOUT',
      `平台 ${state.platformCode} 的 Chrome 进程仍在运行，但 ${state.browserDebugPort} 端口、DevToolsActivePort 或 /json/version 在限定时间内未同时通过验证`,
      detail
    );
  }

  async acquirePlatformContext({ platformCode, profileDir = null, executablePath = null } = {}) {
    if (!this.isPrimaryMode()) throw runtimeError('WEB_ACCESS_PRIMARY_DISABLED', 'Web Access 主控模式未启用');
    if (profileDir) this.platformProfiles[platformCode] = profileDir;
    if (executablePath) this.executablePath = executablePath;
    const state = this.stateFor(platformCode);
    state.profileDir = path.resolve(profileDir || this.platformProfiles[platformCode] || state.profileDir || '');
    if (state.context && state.browser?.isConnected?.()) return { context: state.context, ...serializeState(state) };
    if (this.launches.has(platformCode)) return this.launches.get(platformCode);
    if (state.fallbackActive) {
      throw runtimeError(
        'WEB_ACCESS_RETRY_SUPPRESSED_WHILE_FALLBACK_ACTIVE',
        `平台 ${platformCode} 当前由 fallback 浏览器占用同一 Profile；在显式执行安全释放与接管前不重复启动 Web Access`,
        this.browserFailureDetail(state, {
          fallbackSince: state.fallbackSince,
          retryNotBefore: state.retryNotBefore ? new Date(state.retryNotBefore).toISOString() : null
        })
      );
    }

    const launch = (async () => {
      try {
        await this.launchBrowser(state);
        await state.provider.ensureReady();
        state.browser = await chromium.connectOverCDP(`http://127.0.0.1:${state.browserDebugPort}`, { timeout: this.requestTimeoutMs });
        state.context = state.browser.contexts()[0] || null;
        if (!state.context) throw runtimeError('WEB_ACCESS_CONTEXT_UNAVAILABLE', `平台 ${platformCode} 未返回可用浏览器 Context`, { platformCode });
        state.startedAt = new Date().toISOString();
        state.lastError = null;
        state.fallbackActive = false;
        state.fallbackSince = null;
        state.retryNotBefore = 0;
        state.browser.once('disconnected', () => {
          state.browser = null;
          state.context = null;
        });
        this.logger.log(`[WebAccess] ${platformCode} 已由 Web Access 主控；平台业务逻辑通过 Playwright CDP 兼容层执行`);
        return { context: state.context, ...serializeState(state) };
      } catch (error) {
        let finalError = error;
        const cleanup = await this.stopPlatform(platformCode).catch(cleanupError => ({
          stopped: false,
          processExited: false,
          cleanupError: cleanupError.message
        }));
        if (cleanup.processExited === false) {
          finalError = runtimeError(
            'WEB_ACCESS_BROWSER_EXIT_TIMEOUT',
            `平台 ${platformCode} 的 Web Access 启动失败后，本 Agent 启动的 Chrome 子进程未确认退出；为避免 Profile 竞争，禁止进入 fallback`,
            this.browserFailureDetail(state, {
              originalError: { code: error.code || 'WEB_ACCESS_START_FAILED', message: error.message },
              cleanup
            })
          );
        }
        finalError.detail = {
          platformCode,
          ...(finalError.detail || {})
        };
        state.lastError = {
          code: finalError.code || 'WEB_ACCESS_START_FAILED',
          message: finalError.message,
          detail: finalError.detail,
          at: new Date().toISOString()
        };
        throw finalError;
      } finally {
        this.launches.delete(platformCode);
      }
    })();
    this.launches.set(platformCode, launch);
    return launch;
  }

  shouldUseLegacyFallback(error) {
    if (!this.legacyFallbackEnabled) return false;
    const neverFallbackCodes = [
      'BROWSER_CONTROL_RISK_ACK_REQUIRED',
      'WEB_ACCESS_PROFILE_PORT_MISMATCH',
      'WEB_ACCESS_PROFILE_WEBSOCKET_MISMATCH',
      'WEB_ACCESS_DEBUG_HOST_MISMATCH',
      'WEB_ACCESS_DEBUG_ENDPOINT_PORT_MISMATCH',
      'BROWSER_DEBUG_PORT_IN_USE',
      'WEB_ACCESS_BROWSER_EXIT_TIMEOUT'
    ];
    if (neverFallbackCodes.includes(error?.code)) return false;
    const platformCode = error?.detail?.platformCode;
    if (platformCode && this.states.has(platformCode)) {
      const state = this.states.get(platformCode);
      state.fallbackActive = true;
      state.fallbackSince ||= new Date().toISOString();
      if (error.code !== 'WEB_ACCESS_RETRY_SUPPRESSED_WHILE_FALLBACK_ACTIVE') {
        state.retryNotBefore = Date.now() + this.fallbackRetryCooldownMs;
      }
    }
    return true;
  }

  async prepareForWebAccessTakeover({ platformCode, releaseFallback = null, timeoutMs = this.profileReleaseTimeoutMs } = {}) {
    const state = this.stateFor(platformCode);
    if (state.browserProcess && state.browserProcess.exitCode == null) {
      const stopped = await this.stopPlatform(platformCode);
      if (!stopped.processExited) {
        throw runtimeError(
          'WEB_ACCESS_BROWSER_EXIT_TIMEOUT',
          `平台 ${platformCode} 的旧 Web Access 子进程未退出，不能开始新的 Profile 接管`,
          this.browserFailureDetail(state, { stopped })
        );
      }
    }
    if (state.fallbackActive && typeof releaseFallback !== 'function') {
      throw runtimeError(
        'WEB_ACCESS_FALLBACK_RELEASE_REQUIRED',
        `平台 ${platformCode} 当前标记为 fallback 占用；必须先提供并完成 releaseFallback 回调，禁止直接抢占 Profile`,
        this.browserFailureDetail(state)
      );
    }
    if (typeof releaseFallback === 'function') await releaseFallback();
    const release = await waitForProfileRelease(state.profileDir, timeoutMs);
    if (!release.released) {
      throw runtimeError(
        'WEB_ACCESS_PROFILE_RELEASE_TIMEOUT',
        `平台 ${platformCode} 的 fallback 浏览器已请求关闭，但 Profile 锁在 ${timeoutMs}ms 内未释放；未强杀任何非本 Agent 浏览器`,
        this.browserFailureDetail(state, { profileLocks: release.locks, timeoutMs })
      );
    }
    state.fallbackActive = false;
    state.fallbackSince = null;
    state.retryNotBefore = 0;
    return { readyForTakeover: true, platformCode, profileDir: state.profileDir };
  }

  executionInfo(platformCode) {
    const state = this.states.get(platformCode);
    return {
      platformCode,
      mode: this.isPrimaryMode() ? 'WEB_ACCESS_PRIMARY' : 'LEGACY',
      primaryProvider: 'web_access_cdp',
      fallbackProvider: this.legacyFallbackEnabled ? 'playwright' : null,
      legacyFallbackEnabled: this.legacyFallbackEnabled,
      actual: state?.context ? 'web_access_cdp' : null,
      runtime: serializeState(state)
    };
  }

  listPlatformStates() {
    return this.platformOrder.map(platformCode => this.executionInfo(platformCode));
  }

  async execute(command, context = {}) {
    const state = this.stateFor(command.platformCode);
    if (command.action !== 'HEALTH_CHECK') {
      await this.acquirePlatformContext({ platformCode: command.platformCode, profileDir: state.profileDir, executablePath: this.executablePath });
    }
    const result = await state.provider.execute(command, context);
    return {
      ...result,
      provider: this.name,
      proxyPort: state.proxyPort,
      browserDebugPort: state.browserDebugPort,
      compatibilityLayer: 'web_access_cdp'
    };
  }

  async stopPlatform(platformCode) {
    const state = this.states.get(platformCode);
    if (!state) return { stopped: true, browserClosed: false, processExited: true };
    const browser = state.browser;
    const child = state.browserProcess;
    const logStream = state.browserLogStream;
    state.context = null;
    state.browser = null;
    await state.provider.stop().catch(error => this.logger.warn(`[WebAccess] ${platformCode} Proxy 停止失败：${error.message}`));

    let browserClosed = false;
    if (browser?.isConnected?.() && child) {
      await browser.close().then(() => { browserClosed = true; }).catch(error => this.logger.warn(`[WebAccess] ${platformCode} CDP 连接关闭失败：${error.message}`));
    } else if (browser?.isConnected?.() && !child) {
      this.logger.warn(`[WebAccess] ${platformCode} 连接的是非本 Agent 启动的浏览器，仅释放管理器引用，不发送 Browser.close 或强杀命令`);
    }

    const processExited = await terminateTrackedProcessTree(child, this.logger, this.spawnProcess);
    if (processExited && state.browserProcess === child) state.browserProcess = null;
    if (processExited && (!child || state.browserLaunchOwnership?.pid === child.pid)) state.browserLaunchOwnership = null;
    if (processExited && logStream && state.browserLogStream === logStream) {
      await closeWriteStream(logStream);
      state.browserLogStream = null;
    }
    return {
      stopped: processExited,
      browserClosed,
      trackedBrowserProcess: Boolean(child),
      processExited
    };
  }

  async stop() {
    await Promise.allSettled([...this.states.keys()].map(platformCode => this.stopPlatform(platformCode)));
  }
}
