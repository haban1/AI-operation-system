export class BrowserProviderRegistry {
  constructor(providers = []) {
    this.providers = new Map();
    for (const provider of providers) this.register(provider);
  }

  register(provider) {
    if (!provider?.name || typeof provider.execute !== 'function') throw new Error('浏览器 Provider 必须提供 name 和 execute()');
    this.providers.set(provider.name, provider);
    return provider;
  }

  get(name) {
    const provider = this.providers.get(name);
    if (!provider) {
      const error = new Error(`浏览器 Provider 未注册：${name}`);
      error.code = 'BROWSER_PROVIDER_UNAVAILABLE';
      throw error;
    }
    return provider;
  }

  list() {
    return [...this.providers.values()].map(provider => ({ name: provider.name, available: provider.available !== false }));
  }

  async stop() {
    await Promise.allSettled([...this.providers.values()].map(provider => typeof provider.stop === 'function' ? provider.stop() : null));
  }
}
