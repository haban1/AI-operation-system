import { config } from '../../src/config.js';
import { BrowserController } from './controller.js';
import { createEvidenceStore } from './evidence.js';
import { BrowserProviderRegistry } from './provider-registry.js';
import { WebAccessCdpProvider } from './providers/web-access-cdp-provider.js';
import { PlaywrightBrowserProvider } from './providers/playwright-provider.js';
import { PlatformWebAccessManager } from './platform-web-access-manager.js';

export function platformProfiles() {
  return {
    xiaohongshu: config.xhsProfileDir,
    ...Object.fromEntries(Object.entries(config.platformRpa || {}).map(([code, item]) => [code, item.profileDir]))
  };
}

export function createPlatformWebAccessManager({ logger = console } = {}) {
  return new PlatformWebAccessManager({
    enabled: config.browserControlEnabled,
    mode: config.browserControlMode,
    legacyFallbackEnabled: config.browserControlLegacyFallbackEnabled,
    executablePath: config.chromeExecutablePath,
    platformProfiles: platformProfiles(),
    platformOrder: config.activePlatformCodes,
    proxyBasePort: config.browserControlCdpProxyPort,
    browserDebugBasePort: config.browserControlBrowserDebugBasePort,
    browser: config.browserControlBrowser,
    proxyAutoStart: config.browserControlProxyAutoStart,
    requestTimeoutMs: config.browserControlRequestTimeoutMs,
    tabIdleTimeoutMs: config.browserControlTabIdleTimeoutMs,
    fileRoots: config.browserControlFileRoots,
    riskAcknowledged: config.browserControlRiskAcknowledged,
    logger
  });
}

export function createBrowserController({ logger = console, webAccessManager = null } = {}) {
  const primaryWebAccess = webAccessManager || createPlatformWebAccessManager({ logger });
  const registry = new BrowserProviderRegistry([
    primaryWebAccess,
    new PlaywrightBrowserProvider({
      executablePath: config.chromeExecutablePath,
      platformProfiles: platformProfiles(),
      requestTimeoutMs: config.browserControlRequestTimeoutMs,
      fileRoots: config.browserControlFileRoots
    })
  ]);
  return new BrowserController({ config, registry, evidenceStore: createEvidenceStore({ rootDir: config.browserControlEvidenceDir }), logger });
}

export { BrowserController } from './controller.js';
export { BrowserProviderRegistry } from './provider-registry.js';
export { WebAccessCdpProvider } from './providers/web-access-cdp-provider.js';
export { PlaywrightBrowserProvider } from './providers/playwright-provider.js';
export { PlatformWebAccessManager } from './platform-web-access-manager.js';
