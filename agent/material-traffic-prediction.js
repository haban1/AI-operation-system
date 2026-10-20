import crypto from 'node:crypto';
import { config } from '../src/config.js';
import {
  buildFailedTrafficPrediction,
  buildMockTrafficPrediction,
  normalizeTrafficPlatformCodes,
  normalizeTrafficPredictionResult,
  parseTrafficPredictionJson,
  trafficPlatformDefinitions
} from '../src/services/material-traffic-schema.js';

const cache = new Map();
const inflight = new Map();
const PROMPT_VERSION = 'platform-traffic-potential-prompt-2026.08.24.2';

function hash(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function cleanText(value, maxLength = 600) {
  return [...String(value ?? '').replace(/\r/g, '').replace(/[\t ]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim()].slice(0, maxLength).join('');
}

function contentContextText(context = {}) {
  const keyPoints = Array.isArray(context.keyPoints) ? context.keyPoints.map(item => cleanText(item, 100)).filter(Boolean).slice(0, 5) : [];
  return {
    coreTheme: cleanText(context.coreTheme, 120),
    contentAngle: cleanText(context.contentAngle, 160),
    sourceSummary: cleanText(context.sourceSummary || context.imageSummary || context.audioSummary, 280),
    keyPoints
  };
}

function predictionPrompt({ title, body, contentOrigin, platformCodes, materialMeta = {}, contentContext = {}, aiReview = {} }) {
  const definitions = trafficPlatformDefinitions();
  const platformLines = platformCodes.map(code => '- ' + definitions[code].name + '（' + code + '）：重点参考' + definitions[code].focus).join('\n');
  const duration = Number(materialMeta.durationSeconds);
  const materialSummary = [
    materialMeta.type ? '素材类型：' + materialMeta.type : '',
    materialMeta.format ? '格式：' + materialMeta.format : '',
    Number.isFinite(duration) && duration > 0 ? '时长：' + duration + '秒' : ''
  ].filter(Boolean).join('；') || '未提供额外素材参数';
  const points = contentContext.keyPoints?.length ? contentContext.keyPoints.join('；') : '未提供';
  return `你是一名中文社交媒体发布前“平台流量潜力评估员”。请只结合当前标题、正文、素材摘要与所选平台的公开内容趋势、内容生态和通用流量规律，给出相对潜力评分。

重要边界：
1. 不读取、不假设、不引用账号近期流量、粉丝量或历史发布表现。
2. 你无法访问平台实时内部大数据、推荐算法参数或未来真实流量，因此不得声称是平台官方预测。
3. 不预测具体播放量、曝光量、点赞量或收益；只输出0～100的潜力分和优势因素。
4. 各平台必须独立评分，不能把同一分数和同一理由机械复制到所有平台。
5. 评分要保守且拉开合理差异：内容普通时应落在55～75分，只有平台适配非常突出时才可超过85分。
6. AI审核结果只用于理解内容是否完整清晰，不得因为合规通过就直接给高分，也不得让流量评分影响发布阻断。

通用评价维度：核心主题是否明确、标题信息量、正文表达与信息密度、平台适配度、用户停留/完读/完播动机、分享讨论或收藏价值、内容是否具有具体对象和利益点。

所选平台与侧重点：
${platformLines}

请只返回一个JSON对象，不要输出Markdown。结构必须为：
{"platformPredictions":[{"platformCode":"平台代码","score":0,"strengths":["优势1","优势2","优势3"]}]}

要求：只返回所选平台；每个平台必须有整数score和2～3条具体优势；优势必须针对当前内容，不要写“平台用户多”“算法推荐强”等空话。

标题：${title}
正文：${body}
内容来源：${contentOrigin || '未声明'}
素材参数：${materialSummary}
核心主题：${contentContext.coreTheme || '未提供'}
内容角度：${contentContext.contentAngle || '未提供'}
素材摘要：${contentContext.sourceSummary || '未提供'}
内容重点：${points}
AI审核结论：${cleanText(aiReview.summary, 180) || aiReview.overall || '未提供'}`;
}

export async function callQwenTrafficPrediction({
  title,
  body,
  contentOrigin = '',
  platformCodes = [],
  materialMeta = {},
  contentContext = {},
  aiReview = {},
  model,
  apiKey,
  baseUrl = config.qwenBaseUrl,
  timeoutMs = config.trafficPredictionTimeoutMs,
  fetchImpl = fetch
} = {}) {
  if (!apiKey) throw Object.assign(new Error('未配置千问 API Key'), { code: 'TRAFFIC_API_KEY_MISSING' });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();
  try {
    const response = await fetchImpl(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        enable_thinking: false,
        max_tokens: 1800,
        response_format: { type: 'json_object' },
        messages: [{
          role: 'user',
          content: predictionPrompt({ title, body, contentOrigin, platformCodes, materialMeta, contentContext, aiReview })
        }]
      }),
      signal: controller.signal
    });
    if (!response.ok) throw Object.assign(new Error(`千问内容潜力 API 返回 ${response.status}: ${(await response.text()).slice(0, 500)}`), { code: 'TRAFFIC_API_ERROR' });
    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content;
    if (!content) throw Object.assign(new Error('千问未返回内容潜力评估结果'), { code: 'TRAFFIC_EMPTY_RESPONSE' });
    return { content, model: data.model || model, usage: data.usage || null, elapsedMs: Date.now() - startedAt };
  } finally {
    clearTimeout(timer);
  }
}

export async function predictMaterialTraffic({
  title = '',
  body = '',
  contentOrigin = '',
  platformCodes = [],
  materialMeta = {},
  contentContext = {},
  aiReview = {},
  mode = config.qwenMode,
  model = config.trafficPredictionModel,
  apiKey = config.qwenApiKey,
  baseUrl = config.qwenBaseUrl,
  force = false,
  invokeModel = callQwenTrafficPrediction
} = {}) {
  const startedAt = Date.now();
  const normalizedTitle = cleanText(title, 100);
  const normalizedBody = cleanText(body, 3000);
  const normalizedPlatforms = normalizeTrafficPlatformCodes(platformCodes);
  const materialSha256 = String(materialMeta?.sha256 || '').toLowerCase();
  const normalizedContext = contentContextText(contentContext);
  const inputHash = hash(JSON.stringify({
    promptVersion: PROMPT_VERSION,
    title: normalizedTitle,
    body: normalizedBody,
    contentOrigin: cleanText(contentOrigin, 80),
    platformCodes: normalizedPlatforms,
    materialSha256,
    materialType: materialMeta?.type || '',
    durationSeconds: Number(materialMeta?.durationSeconds || 0),
    contentContext: normalizedContext
  }));
  const cacheKey = model + ':' + inputHash;

  if (!normalizedTitle || !normalizedBody) return buildFailedTrafficPrediction({ platformCodes: normalizedPlatforms, materialSha256, model, code: 'TRAFFIC_CONTENT_REQUIRED', message: '标题和正文不能为空', elapsedMs: Date.now() - startedAt });
  if (!normalizedPlatforms.length) return buildFailedTrafficPrediction({ platformCodes: normalizedPlatforms, materialSha256, model, code: 'TRAFFIC_PLATFORM_REQUIRED', message: '请至少选择一个发布平台', elapsedMs: Date.now() - startedAt });
  if (!config.trafficPredictionEnabled) return buildFailedTrafficPrediction({ platformCodes: normalizedPlatforms, materialSha256, model, code: 'TRAFFIC_PREDICTION_DISABLED', message: 'AI平台内容适配潜力评分功能已关闭', elapsedMs: Date.now() - startedAt });
  if (mode !== 'online') return buildMockTrafficPrediction({ platformCodes: normalizedPlatforms, materialSha256 });
  if (!apiKey) return buildFailedTrafficPrediction({ platformCodes: normalizedPlatforms, materialSha256, model, code: 'TRAFFIC_API_KEY_MISSING', message: '未配置千问 API Key，无法生成AI平台内容适配潜力评分', elapsedMs: Date.now() - startedAt });
  if (!force && cache.has(cacheKey)) return { ...cache.get(cacheKey), cached: true, elapsedMs: 0, checkedAt: new Date().toISOString() };
  if (!force && inflight.has(cacheKey)) return inflight.get(cacheKey);

  const task = (async () => {
    let response;
    try {
      response = await invokeModel({
        title: normalizedTitle,
        body: normalizedBody,
        contentOrigin: cleanText(contentOrigin, 80),
        platformCodes: normalizedPlatforms,
        materialMeta,
        contentContext: normalizedContext,
        aiReview,
        model,
        apiKey,
        baseUrl
      });
      const normalized = normalizeTrafficPredictionResult(parseTrafficPredictionJson(response.content), {
        platformCodes: normalizedPlatforms,
        materialSha256,
        inputHash,
        mode: 'online',
        model: response.model || model,
        usage: response.usage || null,
        elapsedMs: response.elapsedMs ?? Date.now() - startedAt
      });
      cache.set(cacheKey, normalized);
      while (cache.size > 80) cache.delete(cache.keys().next().value);
      return normalized;
    } catch (error) {
      const reason = error?.name === 'AbortError' ? '请求超时' : error?.message || '未知错误';
      return buildFailedTrafficPrediction({
        platformCodes: normalizedPlatforms,
        materialSha256,
        model: response?.model || model,
        code: error?.code || 'TRAFFIC_PREDICTION_FAILED',
        message: '平台内容适配潜力评估失败：' + reason,
        elapsedMs: response?.elapsedMs || Date.now() - startedAt
      });
    }
  })();

  if (!force) inflight.set(cacheKey, task);
  try { return await task; }
  finally { if (!force) inflight.delete(cacheKey); }
}

export { predictionPrompt };

