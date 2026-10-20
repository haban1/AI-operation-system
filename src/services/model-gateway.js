import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const PREFIX = '/api/model/v1/';
const ROLES = Object.freeze({
  'tianhe-wechat-chat': ['model', 'wechat-agent'],
  'tianhe-rag-chat': ['model', 'rag-generation'],
  'tianhe-robot-chat': ['model', 'wechat-robot'],
  'tianhe-robot-summary': ['model', 'wechat-robot'],
  'tianhe-robot-vision': ['visionModel', 'wechat-robot'],
  'tianhe-robot-embedding': ['embeddingModel', 'wechat-robot'],
});
const ERROR_MESSAGES = Object.freeze({
  AI_MODE_DISABLED: '天河 AI 处于模拟模式，请启用在线模式后重试',
  AI_KEY_MISSING: '天河尚未配置模型 API Key',
  AI_MODEL_MISSING: '天河尚未配置此用途的模型',
  AI_RATE_LIMITED: '模型服务限流，请稍后重试或检查服务商账号状态',
  AI_UPSTREAM_ERROR: '模型服务返回错误，请检查接口配置及服务商状态',
  AI_REQUEST_TIMEOUT: '模型服务请求超时',
  AI_UPSTREAM_UNAVAILABLE: '模型服务暂时无法连接或返回格式无效',
});

function reply(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

function failure(res, status, code, message) {
  reply(res, status, { error: { type: code, code, message } });
}

// Internal OpenAI-compatible endpoint. Only role aliases are accepted: callers
// cannot select arbitrary models, upstream URLs or upstream credentials.
export async function handleModelGateway(req, res, {
  token, getSettings, recordUsage = () => {}, fetchImpl = fetch, timeoutMs = 60_000, localEmbeddings,
}) {
  const supplied = Buffer.from(String(req.headers.authorization || '').replace(/^Bearer /, ''));
  const expected = Buffer.from(token || '');
  if (!expected.length || supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) {
    return failure(res, 401, 'MODEL_AUTH_REQUIRED', '模型服务鉴权失败');
  }
  const url = new URL(req.url, 'http://localhost');
  const route = url.pathname.slice(PREFIX.length);
  const settings = getSettings();
  if (req.method === 'GET' && route === 'status' && !url.search) {
    return reply(res, 200, { source: 'tianhe', mode: settings.mode, configured: Boolean(settings.apiKey),
      model: settings.model, visionModel: settings.visionModel });
  }
  if (req.method !== 'POST' || !['chat/completions', 'embeddings'].includes(route) || url.search) {
    return failure(res, 404, 'MODEL_ROUTE_NOT_FOUND', '模型接口不存在');
  }
  let payload;
  try {
    let size = 0;
    const chunks = [];
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 12 * 1024 * 1024) return failure(res, 413, 'MODEL_REQUEST_TOO_LARGE', '模型请求过大');
      chunks.push(chunk);
    }
    payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return failure(res, 400, 'MODEL_INVALID_REQUEST', '模型请求格式无效');
  }
  const role = ROLES[payload?.model];
  if (!role || (route === 'embeddings') !== (role[0] === 'embeddingModel')
      || (route === 'chat/completions' && !Array.isArray(payload.messages))) {
    return failure(res, 400, 'MODEL_INVALID_ROLE', '模型用途无效');
  }
  const [field, source] = role;
  const started = Date.now();
  const log = (status, errorCode = null, usage = null) => recordUsage({
    taskType: 'UNIFIED_MODEL_CALL', sourceModule: source, mode: settings.mode,
    model: settings[field] || '', status, errorCode, errorMessage: ERROR_MESSAGES[errorCode] || errorCode,
    usage, durationMs: Date.now() - started,
  });
  if (settings.mode !== 'online' || !settings.apiKey) {
    const code = settings.mode !== 'online' ? 'AI_MODE_DISABLED' : 'AI_KEY_MISSING';
    log('SKIPPED', code);
    return failure(res, 503, code, '请在天河「企微及 AI」中启用在线模式并配置 API Key');
  }
  if (!settings[field]) {
    log('FAILED', 'AI_MODEL_MISSING');
    return failure(res, 503, 'AI_MODEL_MISSING', '请在天河 AI 服务配置中填写此用途的模型');
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onClose = () => { if (!res.writableEnded) controller.abort(); };
  res.on('close', onClose);
  try {
    const local = route === 'embeddings' && settings.embeddingModel === 'local:BAAI/bge-small-zh-v1.5';
    if (local && (!localEmbeddings?.url || !localEmbeddings?.token)) {
      log('FAILED', 'AI_MODEL_MISSING');
      return failure(res, 503, 'AI_MODEL_MISSING', '本地向量模型服务尚未连接');
    }
    const upstream = await fetchImpl(local ? localEmbeddings.url : settings.baseUrl.replace(/\/+$/, '') + '/' + route, {
      method: 'POST', redirect: 'error', signal: controller.signal,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (local ? localEmbeddings.token : settings.apiKey) },
      body: JSON.stringify({ ...payload, model: local ? 'BAAI/bge-small-zh-v1.5' : settings[field] }),
    });
    if (!upstream.ok) {
      // Never relay upstream error bodies: some gateways echo credentials or
      // entire prompts. Preserve the actionable HTTP status instead.
      await upstream.body?.cancel();
      const code = upstream.status === 429 ? 'AI_RATE_LIMITED' : 'AI_UPSTREAM_ERROR';
      log('FAILED', code);
      return failure(res, upstream.status, code, upstream.status === 429
        ? '天河配置的模型服务当前限流，请稍后重试或检查服务商账号状态'
        : `天河配置的模型服务返回 HTTP ${upstream.status}`);
    }
    if (payload.stream === true) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
      await pipeline(Readable.fromWeb(upstream.body), res);
      log('SUCCESS');
    } else {
      const result = await upstream.json();
      log('SUCCESS', null, result.usage);
      reply(res, 200, result);
    }
  } catch (error) {
    const code = controller.signal.aborted ? 'AI_REQUEST_TIMEOUT' : 'AI_UPSTREAM_UNAVAILABLE';
    log('FAILED', code);
    if (!res.headersSent && !res.destroyed) failure(res, controller.signal.aborted ? 504 : 502, code, '天河模型服务暂不可用');
    else if (!res.destroyed) res.destroy();
  } finally {
    clearTimeout(timer);
    res.off('close', onClose);
  }
}
