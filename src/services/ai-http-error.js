export async function aiHttpError(response, { operation = 'AI 服务', code = 'AI_HTTP_ERROR' } = {}) {
  const body = (await response.text().catch(() => '')).slice(0, 4096);
  const status = response.status;
  let detail = '';
  try { const data = JSON.parse(body); detail = [data.error?.code, data.error?.type, data.error?.message, data.code, data.message].filter(Boolean).join(' '); } catch {}
  const balance = status === 402 || /insufficient[_\s-]*(balance|quota)|余额不足|额度不足/i.test(detail);
  const reason = balance ? 'AI 服务余额或额度不足，请充值，或到系统设置更换可用接口后重试'
    : status === 401 ? 'AI 密钥无效或已过期，请在系统设置检查密钥'
    : status === 403 ? '当前账号没有该模型的使用权限，请在系统设置更换可用模型'
    : status === 429 ? 'AI 服务请求过多，请稍后重试'
    : status >= 500 ? 'AI 服务暂时不可用，请稍后重试'
    : 'AI 服务拒绝请求，请在系统设置检查接口和模型';
  return Object.assign(new Error(`${operation}失败：${reason}（HTTP ${status}）`), { code: balance ? 'AI_BALANCE_INSUFFICIENT' : code, status });
}
