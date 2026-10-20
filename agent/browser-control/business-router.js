import { resolveRpaAdapter } from '../rpa-adapters/registry.js';

export class BusinessBrowserRouter {
  constructor({ adapters, webAccessManager } = {}) {
    this.adapters = adapters;
    this.webAccessManager = webAccessManager;
  }

  async execute(job = {}) {
    const adapter = resolveRpaAdapter(this.adapters, job);
    const output = await adapter.execute(job);
    const expectedPlatformCode = job?.payload?.platformCode;
    const resultPlatformCode = output?.result?.platformCode;
    if (resultPlatformCode && resultPlatformCode !== expectedPlatformCode) {
      const error = new Error(`任务平台 ${expectedPlatformCode || 'unknown'} 与适配器结果平台 ${resultPlatformCode} 不一致，已禁止回传`);
      error.code = 'RPA_RESULT_PLATFORM_MISMATCH';
      throw error;
    }
    const execution = adapter.browserExecution || {};
    const managerInfo = this.webAccessManager?.executionInfo?.(job?.payload?.platformCode) || {};
    return {
      ...output,
      result: {
        ...(output?.result || {}),
        browserControl: {
          mode: managerInfo.mode || 'LEGACY',
          primaryProvider: managerInfo.primaryProvider || 'web_access_cdp',
          fallbackProvider: managerInfo.fallbackProvider || null,
          providerRequested: execution.providerRequested || managerInfo.primaryProvider || 'web_access_cdp',
          providerUsed: execution.providerUsed || managerInfo.actual || null,
          fallbackUsed: Boolean(execution.fallbackUsed),
          fallbackReason: execution.fallbackReason || null,
          compatibilityLayer: execution.compatibilityLayer || null,
          proxyPort: execution.proxyPort || managerInfo.runtime?.proxyPort || null,
          browserDebugPort: execution.browserDebugPort || managerInfo.runtime?.browserDebugPort || null,
          profileIsolated: true
        }
      }
    };
  }
}
