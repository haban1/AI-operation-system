import { createBackgroundPage, focusInteractivePage, isBackgroundPage } from '../browser-control/collection-pages.js';

export class RpaAdapter {
  constructor({ platformCode }) {
    this.platformCode = platformCode;
    this.runtimeGuard = null;
    this.lifecycleGeneration = 0;
  }

  setRuntimeGuard(runtimeGuard) { this.runtimeGuard = runtimeGuard; }
  async assertRuntimeAllowed() {
    if (typeof this.runtimeGuard === 'function') await this.runtimeGuard(this.platformCode);
  }
  createBackgroundPage(context, options) { return createBackgroundPage(context, options); }
  openWorkspace(key) {
    const page = key ? this.channelPages?.get(key) : this.activePage;
    return page && !page.isClosed() ? page : null;
  }

  async getWorkspacePage(key, { hostHints = [], bringToFront = false, visible = false } = {}) {
    const context = await this.ensureContext();
    const pages = this.channelPages ||= new Map();
    let page = pages.get(key);
    if (!page || page.isClosed()) {
      this.pendingWorkspaces ||= new WeakMap();
      let pending = this.pendingWorkspaces.get(context);
      if (!pending) this.pendingWorkspaces.set(context, pending = new Map());
      if (!pending.has(key)) {
        const opening = (async () => {
          let created;
          if (bringToFront) {
            const assigned = new Set(pages.values());
            const available = context.pages().filter(p => !p.isClosed() && !isBackgroundPage(p) && !assigned.has(p));
            created = available.find(p => hostHints.some(host => p.url().includes(host)))
              || available.find(p => p.url() === 'about:blank') || await context.newPage();
          } else {
            created = await this.createBackgroundPage(context, visible ? { forHandoff: true } : undefined);
          }
          pages.set(key, created);
          created.once?.('close', () => { if (pages.get(key) === created) pages.delete(key); });
          return created;
        })().finally(() => pending.delete(key));
        pending.set(key, opening);
      }
      page = await pending.get(key);
    }
    if (bringToFront || visible) this.activePage = page;
    if (bringToFront) await focusInteractivePage(page);
    return page;
  }
  invalidatePendingOperations() { this.lifecycleGeneration += 1; return this.lifecycleGeneration; }
  platformStoppedError() {
    const error = new Error(`平台 ${this.platformCode} 已停止，当前操作已取消`);
    error.code = 'PLATFORM_OPERATION_CANCELLED';
    return error;
  }
  async execute(_job) { throw new Error('平台 ' + this.platformCode + ' 尚未实现 RPA 适配器'); }
  async stop() { return { stopped: true, browserClosed: true }; }
}

export function assertRpaOutput(output) {
  const allowed = new Set(['SUCCESS', 'PARTIAL_SUCCESS', 'FAILED', 'NEEDS_CONFIRMATION']);
  if (!output || !allowed.has(output.status)) throw new Error('RPA 适配器返回了无效状态');
  return { status: output.status, result: output.result || {} };
}
