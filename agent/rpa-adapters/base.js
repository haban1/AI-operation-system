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
