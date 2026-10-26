export const aiSignalPath = '/integrations/ai-signal/';

export function safeWorkbenchHttpUrl(value) {
  const text = String(value || '').trim();
  if (!text || /[\s?#]/.test(text)) throw new Error('Invalid URL');
  const url = new URL(text);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid URL');
  return url;
}

// A relative browser entry is only supported by the authenticated Signal mount.
// It always needs a separately configured, absolute internal health endpoint.
export function resolveWorkbenchUrls(value, healthValue, healthPath, { allowSignalPath = false } = {}) {
  const text = String(value || '').trim();
  const relative = allowSignalPath && text === aiSignalPath;
  const browser = relative ? null : safeWorkbenchHttpUrl(text);
  const health = safeWorkbenchHttpUrl(healthValue || (browser && new URL(healthPath, browser).href));
  if (health.pathname !== healthPath) throw new Error('Invalid health endpoint');
  return {
    browserUrl: relative ? aiSignalPath : browser.href,
    health,
    healthHost: relative ? `127.0.0.1:${health.port || (health.protocol === 'https:' ? '443' : '80')}` : browser.host,
  };
}
