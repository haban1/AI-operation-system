const SERVICE = 'AI Signal Studio';
const HEALTH_TIMEOUT_MS = 3000;

function safeHttpUrl(value) {
  const raw = String(value || '').trim();
  if (!raw || /[\s?#]/.test(raw)) throw new Error('Invalid integration URL');
  const url = new URL(raw);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Invalid integration URL');
  }
  return url;
}

// Only server configuration selects the target. This integration reads health;
// it never forwards browser input, credentials, generation or publishing calls.
export async function getAiSignalIntegration({ url = '', healthUrl = '' } = {}, { fetchImpl = fetch } = {}) {
  const result = { enabled: false, url: '', online: false, service: SERVICE, message: '热点工作台尚未接入' };
  if (!String(url || '').trim()) return result;

  let browserUrl;
  let health;
  try {
    browserUrl = safeHttpUrl(url);
    health = safeHttpUrl(healthUrl || new URL('/api/health', browserUrl).href);
    if (health.pathname !== '/api/health') throw new Error('Invalid health URL');
  } catch {
    return { ...result, message: '热点工作台地址配置无效' };
  }

  result.enabled = true;
  result.url = browserUrl.href;
  try {
    const response = await fetchImpl(health.href, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      credentials: 'omit',
      redirect: 'error',
      cache: 'no-store',
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });
    if (!response.ok || response.redirected) throw new Error('Health unavailable');
    const healthData = await response.json();
    if (healthData?.ok !== true || healthData?.service !== SERVICE) throw new Error('Invalid health response');
    return { ...result, online: true, message: '热点工作台已连接' };
  } catch {
    // Upstream bodies and exception text may include private configuration.
    return { ...result, message: '热点工作台暂时无法连接，请确认服务已启动' };
  }
}
