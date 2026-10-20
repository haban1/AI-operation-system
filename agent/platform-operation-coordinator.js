import { AsyncLocalStorage } from 'node:async_hooks';
import { isPlatformRunnable, stoppedPlatformStatus } from './platform-runtime-guard.js';

const operationTokenScope = new AsyncLocalStorage();

function stoppedError(platformCode, runtime, reason = 'PLATFORM_STOPPED') {
  const error = new Error(stoppedPlatformStatus(platformCode, runtime).message);
  error.code = reason;
  error.runtime = runtime;
  return error;
}

export function normalizeOperationLockMode(value) {
  const mode = String(value || 'EXCLUSIVE').trim().toUpperCase();
  return ['READ_COMMENT', 'READ_PRIVATE', 'WRITE_COMMENT', 'WRITE_PRIVATE'].includes(mode) ? mode : 'EXCLUSIVE';
}

export function operationModesCompatible(left, right) {
  const a = normalizeOperationLockMode(left);
  const b = normalizeOperationLockMode(right);
  if (a === 'EXCLUSIVE' || b === 'EXCLUSIVE') return false;
  const laneA = a.endsWith('_COMMENT') ? 'COMMENT' : 'PRIVATE';
  const laneB = b.endsWith('_COMMENT') ? 'COMMENT' : 'PRIVATE';
  return laneA !== laneB;
}

export class PlatformOperationCoordinator {
  constructor({ fetchControl, onStopped = async () => {} }) {
    this.fetchControl = fetchControl;
    this.onStopped = onStopped;
    this.runtimeByCode = new Map();
    this.allowedByCode = new Map();
    this.generationByCode = new Map();
    this.masterSwitchEnabled = false;
    this.lockStates = new Map();
  }

  effectiveRuntime(platformCode) {
    const runtime = this.runtimeByCode.get(platformCode) || null;
    if (this.masterSwitchEnabled) return runtime;
    return runtime ? { ...runtime, effective_state: 'STOPPED', blocked_reason: 'MASTER_SWITCH_STOPPED' }
      : { code: platformCode, desired_state: 'STOPPED', effective_state: 'STOPPED', blocked_reason: 'MASTER_SWITCH_STOPPED' };
  }

  generation(platformCode) { return this.generationByCode.get(platformCode) || 0; }
  isAllowed(platformCode) { return this.masterSwitchEnabled && isPlatformRunnable(this.runtimeByCode.get(platformCode)); }
  runnablePlatformCodes() { return this.masterSwitchEnabled ? [...this.runtimeByCode.keys()].filter(code => this.isAllowed(code)) : []; }

  async update(control = {}) {
    const nextMasterSwitchEnabled = control.masterSwitch?.enabled === true;
    const nextRuntimeByCode = new Map((Array.isArray(control.platforms) ? control.platforms : []).map(item => [item.code, item]));
    const allCodes = new Set([...this.runtimeByCode.keys(), ...nextRuntimeByCode.keys()]);
    const stoppedCodes = [];
    for (const platformCode of allCodes) {
      const previousAllowed = this.allowedByCode.get(platformCode);
      const nextAllowed = nextMasterSwitchEnabled && isPlatformRunnable(nextRuntimeByCode.get(platformCode));
      if (previousAllowed === undefined || previousAllowed !== nextAllowed) this.generationByCode.set(platformCode, this.generation(platformCode) + 1);
      if (nextAllowed === false && previousAllowed !== false) stoppedCodes.push(platformCode);
      this.allowedByCode.set(platformCode, nextAllowed);
    }
    this.masterSwitchEnabled = nextMasterSwitchEnabled;
    this.runtimeByCode = nextRuntimeByCode;
    if (stoppedCodes.length) await this.onStopped(stoppedCodes);
    return this.runtimeByCode;
  }

  async refresh() { return this.update(await this.fetchControl()); }

  assertRunning(platformCode, expectedGeneration = null) {
    const runtime = this.effectiveRuntime(platformCode);
    if (!this.isAllowed(platformCode)) throw stoppedError(platformCode, runtime);
    if (expectedGeneration != null && expectedGeneration !== this.generation(platformCode)) throw stoppedError(platformCode, runtime, 'PLATFORM_OPERATION_CANCELLED');
    return runtime;
  }

  async requireRunning(platformCode, { refresh = true, expectedGeneration = null } = {}) {
    if (refresh) await this.refresh();
    return this.assertRunning(platformCode, expectedGeneration);
  }

  async prepare(platformCode, { lockMode = 'EXCLUSIVE' } = {}) {
    await this.requireRunning(platformCode, { refresh: true });
    return { platformCode, generation: this.generation(platformCode), lockMode: normalizeOperationLockMode(lockMode) };
  }

  lockState(platformCode) {
    if (!this.lockStates.has(platformCode)) this.lockStates.set(platformCode, { active: new Set(), waiting: [] });
    return this.lockStates.get(platformCode);
  }

  canAcquire(state, token) {
    return [...state.active].every(active => operationModesCompatible(active.lockMode, token.lockMode));
  }

  drain(platformCode) {
    const state = this.lockStates.get(platformCode);
    if (!state) return;
    let progressed = true;
    while (progressed && state.waiting.length) {
      progressed = false;
      const next = state.waiting[0];
      if (this.canAcquire(state, next.token)) {
        state.waiting.shift();
        state.active.add(next.token);
        next.resolve(() => this.release(platformCode, next.token));
        progressed = true;
      }
    }
    if (!state.active.size && !state.waiting.length) this.lockStates.delete(platformCode);
  }

  acquire(token) {
    const state = this.lockState(token.platformCode);
    return new Promise(resolve => {
      state.waiting.push({ token, resolve });
      this.drain(token.platformCode);
    });
  }

  release(platformCode, token) {
    const state = this.lockStates.get(platformCode);
    if (!state) return;
    state.active.delete(token);
    this.drain(platformCode);
  }

  async executePrepared(token, task) {
    const release = await this.acquire(token);
    try {
      await this.requireRunning(token.platformCode, { refresh: true, expectedGeneration: token.generation });
      return await operationTokenScope.run(token, () => task(token));
    } catch (error) {
      error.platformOperationStarted = true;
      throw error;
    } finally { release(); }
  }

  queuePrepared(token, task) {
    return this.executePrepared(token, task);
  }

  async run(platformCode, task, { lockMode = 'EXCLUSIVE' } = {}) {
    const token = await this.prepare(platformCode, { lockMode });
    return this.executePrepared(token, task);
  }

  async guardBrowserLaunch(platformCode) {
    const activeToken = operationTokenScope.getStore();
    const expectedGeneration = activeToken?.platformCode === platformCode ? activeToken.generation : this.generation(platformCode);
    return this.requireRunning(platformCode, { refresh: true, expectedGeneration });
  }
}
