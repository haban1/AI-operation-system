export class LoginPollingGate {
  constructor({ intervalMs, initialDelayMs = 15_000, now = () => Date.now() } = {}) {
    this.intervalMs = Math.max(1, Number(intervalMs) || 1);
    this.initialDelayMs = Math.max(0, Number(initialDelayMs) || 0);
    this.now = now;
    this.platformCodes = new Set();
    this.nextPollAtMs = null;
  }

  activate(platformCode) {
    const code = String(platformCode || '').trim();
    if (!code) return false;
    const added = !this.platformCodes.has(code);
    this.platformCodes.add(code);
    if (added || this.nextPollAtMs == null) {
      const candidate = this.now() + this.initialDelayMs;
      if (this.nextPollAtMs == null || candidate < this.nextPollAtMs) this.nextPollAtMs = candidate;
    }
    return added;
  }

  sync(platformCodes = []) {
    const desired = new Set(platformCodes.map(platformCode => String(platformCode || '').trim()).filter(Boolean));
    this.deactivate([...this.platformCodes].filter(platformCode => !desired.has(platformCode)));
    for (const platformCode of desired) this.activate(platformCode);
    return this.snapshot();
  }

  deactivate(platformCodes = []) {
    for (const platformCode of platformCodes) this.platformCodes.delete(String(platformCode || '').trim());
    if (!this.platformCodes.size) this.nextPollAtMs = null;
  }

  clear() {
    this.platformCodes.clear();
    this.nextPollAtMs = null;
  }

  eligible(platformCodes = []) {
    return platformCodes.filter(platformCode => this.platformCodes.has(platformCode));
  }

  isDue(at = this.now()) {
    return this.platformCodes.size > 0 && this.nextPollAtMs != null && at >= this.nextPollAtMs;
  }

  markPolled(at = this.now()) {
    this.nextPollAtMs = this.platformCodes.size ? at + this.intervalMs : null;
  }

  snapshot() {
    return {
      platformCodes: [...this.platformCodes],
      nextPollAt: this.nextPollAtMs == null ? null : new Date(this.nextPollAtMs).toISOString()
    };
  }
}
