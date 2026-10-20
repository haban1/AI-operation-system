import { normalizeBrowserCommand, isBrowserCommandNonIdempotent } from '../../src/services/browser-control-policy.js';

const FALLBACK_SAFE_ACTIONS = new Set(['HEALTH_CHECK', 'OPEN_PAGE']);

export class BrowserController {
  constructor({ config, registry, evidenceStore, logger = console } = {}) {
    this.config = config;
    this.registry = registry;
    this.evidenceStore = evidenceStore;
    this.logger = logger;
    this.sessions = new Map();
  }

  mode() {
    return String(this.config.browserControlMode || 'web_access_primary').toLowerCase();
  }

  primaryProvider() {
    return this.config.browserControlPrimaryProvider || this.config.browserControlProvider || 'web_access_cdp';
  }

  fallbackProvider() {
    return this.config.browserControlFallbackProvider || 'playwright';
  }

  capabilities() {
    const primary = this.primaryProvider();
    const fallbackEnabled = this.config.browserControlLegacyFallbackEnabled !== false;
    const webAccess = this.registry.providers.get(primary);
    return {
      enabled: this.config.browserControlEnabled,
      mode: this.mode() === 'web_access_primary' ? 'WEB_ACCESS_PRIMARY' : this.mode().toUpperCase(),
      defaultProvider: primary,
      primaryProvider: primary,
      fallbackProvider: fallbackEnabled ? this.fallbackProvider() : null,
      legacyFallbackEnabled: fallbackEnabled,
      businessRouting: this.mode() === 'web_access_primary' ? 'WEB_ACCESS_PRIMARY_WITH_PLAYWRIGHT_CDP_COMPATIBILITY' : 'LEGACY',
      enabledPlatforms: this.config.browserControlEnabledPlatforms,
      interactiveEnabled: this.config.browserControlInteractiveEnabled,
      riskAcknowledged: this.config.browserControlRiskAcknowledged,
      platformRuntimes: typeof webAccess?.listPlatformStates === 'function' ? webAccess.listPlatformStates() : [],
      providers: this.registry.list()
    };
  }

  normalize(payload = {}) {
    if (!this.config.browserControlEnabled) {
      const error = new Error('浏览器控制体系尚未启用（BROWSER_CONTROL_ENABLED=false）');
      error.code = 'BROWSER_CONTROL_DISABLED';
      throw error;
    }
    const normalized = normalizeBrowserCommand(payload, {
      defaultProvider: this.primaryProvider(),
      activePlatformCodes: this.config.activePlatformCodes,
      enabledPlatformCodes: this.config.browserControlEnabledPlatforms,
      interactiveEnabled: this.config.browserControlInteractiveEnabled,
      config: this.config
    });
    const providerRequested = normalized.provider;
    if (this.mode() === 'web_access_primary') normalized.provider = this.primaryProvider();
    return { ...normalized, providerRequested };
  }

  sessionFor(command, payload = {}) {
    const sessionId = command.sessionId || String(payload.sessionId || '').trim();
    if (!sessionId) {
      const error = new Error('浏览器命令缺少 sessionId');
      error.code = 'BROWSER_SESSION_REQUIRED';
      throw error;
    }
    const existing = this.sessions.get(sessionId) || {
      sessionId,
      platformCode: command.platformCode,
      accountId: command.accountId,
      providerRequested: command.providerRequested,
      providerUsed: null,
      managedTabId: payload.managedTabId || null,
      managedTabs: {},
      createdAt: new Date().toISOString()
    };
    if (existing.platformCode !== command.platformCode || Number(existing.accountId || 0) !== Number(command.accountId || 0)) {
      const error = new Error('浏览器 session 与平台或账号绑定不一致');
      error.code = 'BROWSER_SESSION_BINDING_MISMATCH';
      throw error;
    }
    if (!existing.managedTabId && payload.managedTabId) existing.managedTabId = payload.managedTabId;
    this.sessions.set(sessionId, existing);
    return existing;
  }

  shouldFallback({ command, session, providerName, error }) {
    if (this.config.browserControlLegacyFallbackEnabled === false) return false;
    if (providerName !== this.primaryProvider()) return false;
    if (isBrowserCommandNonIdempotent(command)) return false;
    if (!FALLBACK_SAFE_ACTIONS.has(command.action)) return false;
    if (session.managedTabId && command.action !== 'HEALTH_CHECK') return false;
    if (['BROWSER_CONTROL_RISK_ACK_REQUIRED', 'WEB_ACCESS_PROFILE_PORT_MISMATCH', 'BROWSER_DEBUG_PORT_IN_USE'].includes(error?.code)) return false;
    return this.registry.providers.has(this.fallbackProvider());
  }

  async executeWithProvider(providerName, command, session, context) {
    const provider = this.registry.get(providerName);
    const managedTabId = session.managedTabs?.[providerName] || (session.providerUsed === providerName ? session.managedTabId : null);
    const providerResult = await provider.execute({ ...command, provider: providerName }, { ...context, managedTabId });
    if (Object.prototype.hasOwnProperty.call(providerResult || {}, 'managedTabId')) {
      session.managedTabs = { ...(session.managedTabs || {}), [providerName]: providerResult.managedTabId || null };
      session.managedTabId = providerResult.managedTabId || null;
    }
    session.providerUsed = providerName;
    session.updatedAt = new Date().toISOString();
    this.sessions.set(session.sessionId, session);
    return providerResult;
  }

  async execute(job = {}) {
    const payload = job.payload || {};
    let command;
    try { command = this.normalize(payload); }
    catch (error) { return { status: 'FAILED', result: { message: error.message, code: error.code || 'BROWSER_COMMAND_INVALID', detail: error.detail || null } }; }

    let session;
    try { session = this.sessionFor(command, payload); }
    catch (error) { return { status: 'FAILED', result: { message: error.message, code: error.code || 'BROWSER_SESSION_INVALID' } }; }

    const evidencePath = command.action === 'SCREENSHOT'
      ? this.evidenceStore.screenshotPath({ platformCode: command.platformCode, sessionId: session.sessionId, commandId: payload.browserCommandId || job.id })
      : null;
    const context = {
      sessionId: session.sessionId,
      evidencePath,
      platformCode: command.platformCode,
      accountId: command.accountId
    };
    const providerRequested = command.providerRequested || command.provider;
    const initialProvider = session.providerUsed || command.provider;
    let providerUsed = initialProvider;
    let fallbackUsed = false;
    let fallbackReason = null;
    let operationStarted = false;

    try {
      operationStarted = true;
      let providerResult;
      try {
        providerResult = await this.executeWithProvider(initialProvider, command, session, context);
      } catch (error) {
        if (!this.shouldFallback({ command, session, providerName: initialProvider, error })) throw error;
        providerUsed = this.fallbackProvider();
        fallbackUsed = true;
        fallbackReason = { code: error.code || 'WEB_ACCESS_PRIMARY_FAILED', message: error.message };
        this.logger.warn(`[BrowserControl] Web Access 主控不可用，安全动作 ${command.action} 临时回退到 ${providerUsed}: ${error.message}`);
        providerResult = await this.executeWithProvider(providerUsed, command, session, context);
      }
      return {
        status: 'SUCCESS',
        result: {
          commandId: payload.browserCommandId || null,
          sessionId: session.sessionId,
          platformCode: command.platformCode,
          accountId: command.accountId,
          provider: providerUsed,
          providerRequested,
          providerUsed,
          primaryProvider: this.primaryProvider(),
          fallbackUsed,
          fallbackReason,
          action: command.action,
          managedTabId: session.managedTabId,
          evidenceRef: providerResult?.evidenceRef || evidencePath || null,
          ...providerResult
        }
      };
    } catch (error) {
      const uncertain = operationStarted && isBrowserCommandNonIdempotent(command);
      return {
        status: uncertain ? 'NEEDS_CONFIRMATION' : 'FAILED',
        result: {
          commandId: payload.browserCommandId || null,
          sessionId: session.sessionId,
          platformCode: command.platformCode,
          accountId: command.accountId,
          provider: providerUsed,
          providerRequested,
          providerUsed,
          primaryProvider: this.primaryProvider(),
          fallbackUsed,
          fallbackReason,
          action: command.action,
          managedTabId: session.managedTabId,
          message: error.message,
          code: error.code || 'BROWSER_PROVIDER_ERROR',
          detail: error.detail || null,
          operationMayHaveOccurred: uncertain,
          evidenceRef: evidencePath
        }
      };
    }
  }

  async stopPlatform(platformCode) {
    const matching = [...this.sessions.values()].filter(item => item.platformCode === platformCode);
    for (const session of matching) {
      try {
        if (session.managedTabId && session.providerUsed) {
          const provider = this.registry.get(session.providerUsed);
          await provider.execute({ action: 'CLOSE_TAB', params: {}, platformCode, accountId: session.accountId }, { sessionId: session.sessionId, managedTabId: session.managedTabId });
        }
      } catch (error) {
        this.logger.warn(`[BrowserControl] 关闭 ${platformCode} 受管标签页失败：${error.message}`);
      } finally {
        this.sessions.delete(session.sessionId);
      }
    }
    for (const provider of this.registry.providers.values()) {
      if (typeof provider.stopPlatform === 'function') await provider.stopPlatform(platformCode);
    }
  }

  async stop() {
    this.sessions.clear();
    await this.registry.stop();
  }
}
