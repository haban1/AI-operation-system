// Only contact the explicitly configured endpoint; never probe other providers.
export function validateAiBaseUrl(value) {
  let parsed;
  try { parsed = new URL(String(value || '').trim()); } catch { throw invalid('AI Base URL 格式无效'); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port || parsed.search || parsed.hash) {
    throw invalid('AI Base URL 必须是不含账号、端口、查询参数和锚点的 HTTPS 地址');
  }
  return parsed.toString().replace(/\/+$/, '');
}
function invalid(message) { return Object.assign(new Error(message), { code: 'INVALID_AI_SETTINGS' }); }
function failure(message, code = 'AI_MODELS_FAILED') { return Object.assign(new Error(message), { code }); }
export function resolveDiscoverySettings(input = {}, current = {}) {
  const baseUrl = validateAiBaseUrl(input.baseUrl ?? current.baseUrl);
  const suppliedKey = String(input.apiKey || '').trim();
  if (!suppliedKey && current.apiKey && new URL(baseUrl).origin !== new URL(current.baseUrl).origin) {
    throw invalid('接口域名已更换，请重新输入该平台的 Key；不会将已保存的 Key 发送到新平台。');
  }
  const apiKey = suppliedKey || current.apiKey || '';
  if (!apiKey) throw invalid('请先填写 AI Key 和接口地址');
  if (apiKey.length < 8 || apiKey.length > 500 || /\s/.test(apiKey)) throw invalid('AI Key 格式无效');
  return { baseUrl, apiKey };
}

async function readJson(response) {
  // Bound memory usage even when the upstream omits Content-Length.
  const reader = response.body?.getReader();
  if (!reader) throw failure('模型列表响应为空，可手动填写模型。');
  let size = 0;
  const chunks = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 2 * 1024 * 1024) {
        await reader.cancel();
        throw failure('模型列表过大，请手动填写模型。');
      }
      chunks.push(Buffer.from(value));
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw failure('平台未返回有效的模型列表，请核对接口地址或手动填写模型。'); }
  } finally { reader.releaseLock(); }
}

export async function discoverAiModels(input, current, { fetchImpl = globalThis.fetch, timeoutMs = 15000 } = {}) {
  const settings = resolveDiscoverySettings(input, current);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(settings.baseUrl + '/models', {
      method: 'GET', headers: { Authorization: 'Bearer ' + settings.apiKey, Accept: 'application/json' },
      redirect: 'manual', signal: controller.signal
    });
    if (!response.ok) {
      await response.body?.cancel();
      if ([401, 403].includes(response.status)) throw failure('模型列表访问被拒绝，请核对 Key、接口地址及查询权限。', 'AI_MODELS_AUTH_FAILED');
      if ([404, 405, 501].includes(response.status)) throw failure('该平台或地址不支持获取模型列表，可手动填写模型后测试连接。', 'AI_MODELS_UNSUPPORTED');
      if (response.status >= 300 && response.status < 400) throw failure('接口返回跳转，已停止请求以保护 Key；请填写最终接口地址。');
      if (response.status === 429) throw failure('平台请求过于频繁，请稍后再试。');
      throw failure('获取模型列表失败（HTTP ' + response.status + '），请稍后重试或手动填写。');
    }
    const data = await readJson(response);
    if (!Array.isArray(data?.data)) throw failure('该平台未返回兼容的模型列表，可手动填写模型后测试连接。', 'AI_MODELS_UNSUPPORTED');
    const ids = data.data.map(item => item?.id).filter(id => typeof id === 'string' && /^[A-Za-z0-9._:/-]{2,100}$/.test(id) && !id.includes(settings.apiKey));
    const unique = [...new Set(ids)].sort((a, b) => a.localeCompare(b));
    const models = unique.slice(0, 2000);
    return { models, truncated: unique.length > models.length, message: models.length
      ? '已获取 ' + models.length + ' 个模型。列表不代表调用权限或图片能力，请选择后保存并测试。'
      : '平台未返回可选模型，可手动填写模型后测试连接。' };
  } catch (error) {
    if (error.code?.startsWith('AI_MODELS_')) throw error;
    if (controller.signal.aborted) throw failure('获取模型列表超时，请稍后重试或手动填写。');
    // Never echo upstream bodies or transport errors: they may contain credentials.
    throw failure('无法连接模型列表接口，请核对地址和网络，或手动填写模型。');
  } finally { clearTimeout(timer); }
}
