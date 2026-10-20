const PLATFORM_DEFINITIONS = Object.freeze({
  douyin: { name: '抖音', focus: '开场吸引力、节奏感、完播潜力、标题钩子与互动触发' },
  wechat_channels: { name: '视频号', focus: '信息可信度、社交传播价值、熟人分享意愿与社区适配度' },
  bilibili: { name: 'B站', focus: '内容深度、标题信息量、观看时长潜力、讨论价值与知识获得感' },
  weibo: { name: '微博', focus: '话题性、时效表达、转发讨论潜力与信息密度' },
  xiaohongshu: { name: '小红书', focus: '搜索关键词、收藏价值、经验感、实用性与视觉主题表达' }
});

export const TRAFFIC_PREDICTION_DISCLAIMER = 'AI 根据平台公开内容趋势及通用大数据规律推测，仅作为参考，非平台官方结论，具体内容表现以平台实际数据为准。';

const PLATFORM_ALIASES = Object.freeze({
  '抖音': 'douyin', douyin: 'douyin',
  '视频号': 'wechat_channels', '微信视频号': 'wechat_channels', wechat_channels: 'wechat_channels', channels: 'wechat_channels',
  'B站': 'bilibili', '哔哩哔哩': 'bilibili', bilibili: 'bilibili',
  '微博': 'weibo', weibo: 'weibo',
  '小红书': 'xiaohongshu', xiaohongshu: 'xiaohongshu'
});

function text(value, maxLength = 300) {
  return [...String(value ?? '').replace(/\r/g, '').replace(/[\t ]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim()].slice(0, maxLength).join('');
}

function stringList(value, { maxItems = 4, maxLength = 80 } = {}) {
  const source = Array.isArray(value) ? value : value ? [value] : [];
  const seen = new Set();
  const output = [];
  for (const item of source) {
    const normalized = text(typeof item === 'object' ? item?.text || item?.message || '' : item, maxLength);
    const key = normalized.toLowerCase();
    if (!normalized || seen.has(key)) continue;
    seen.add(key);
    output.push(normalized);
    if (output.length >= maxItems) break;
  }
  return output;
}

function platformCode(value) {
  const raw = String(value || '').trim();
  return PLATFORM_ALIASES[raw] || PLATFORM_ALIASES[raw.toLowerCase()] || '';
}

export function normalizeTrafficPlatformCodes(value = []) {
  const source = Array.isArray(value) ? value : [value];
  return [...new Set(source.map(platformCode).filter(code => PLATFORM_DEFINITIONS[code]))];
}

export function trafficPlatformDefinitions() {
  return PLATFORM_DEFINITIONS;
}

export function parseTrafficPredictionJson(content) {
  const raw = Array.isArray(content)
    ? content.map(item => typeof item === 'string' ? item : item?.text || '').join('\n')
    : String(content || '');
  const unfenced = raw.trim().replace(/^\x60\x60\x60(?:json)?\s*/i, '').replace(/\s*\x60\x60\x60$/i, '').trim();
  const candidates = [unfenced];
  const start = unfenced.indexOf('{');
  const end = unfenced.lastIndexOf('}');
  if (start >= 0 && end > start) candidates.push(unfenced.slice(start, end + 1));
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch {}
  }
  const error = new Error('AI 返回的内容潜力结果不是有效 JSON');
  error.code = 'TRAFFIC_PREDICTION_INVALID_JSON';
  throw error;
}

export function trafficPotentialLevel(score) {
  if (score >= 85) return '极高潜力';
  if (score >= 75) return '高潜力';
  if (score >= 60) return '中等潜力';
  if (score >= 40) return '一般潜力';
  return '偏低潜力';
}

export function normalizeTrafficPredictionResult(raw = {}, context = {}) {
  const requestedCodes = normalizeTrafficPlatformCodes(context.platformCodes);
  if (!requestedCodes.length) {
    const error = new Error('至少需要选择一个平台才能生成内容适配潜力评分');
    error.code = 'TRAFFIC_PLATFORM_REQUIRED';
    throw error;
  }
  const source = Array.isArray(raw.platformPredictions) ? raw.platformPredictions : Array.isArray(raw.predictions) ? raw.predictions : [];
  const byCode = new Map();
  for (const item of source) {
    const code = platformCode(item?.platformCode || item?.platform || item?.platformName);
    if (!code || !requestedCodes.includes(code) || byCode.has(code)) continue;
    const numericScore = Number(item?.score);
    if (!Number.isFinite(numericScore)) continue;
    const score = Math.max(0, Math.min(100, Math.round(numericScore)));
    const strengths = stringList(item?.strengths || item?.advantages, { maxItems: 3, maxLength: 72 });
    if (!strengths.length) continue;
    byCode.set(code, {
      platformCode: code,
      platformName: PLATFORM_DEFINITIONS[code].name,
      score,
      level: trafficPotentialLevel(score),
      strengths
    });
  }
  const missing = requestedCodes.filter(code => !byCode.has(code));
  if (missing.length) {
    const error = new Error('AI 未完整返回所选平台的内容适配潜力评分');
    error.code = 'TRAFFIC_PREDICTION_INCOMPLETE';
    throw error;
  }
  const platformPredictions = requestedCodes.map(code => byCode.get(code));
  const overallScore = Math.round(platformPredictions.reduce((sum, item) => sum + item.score, 0) / platformPredictions.length);
  return {
    status: 'SUCCESS',
    mock: context.mock === true,
    mode: context.mode || 'online',
    overallScore,
    overallLevel: trafficPotentialLevel(overallScore),
    platformPredictions,
    disclaimer: TRAFFIC_PREDICTION_DISCLAIMER,
    model: context.model || '',
    usage: context.usage || null,
    elapsedMs: Number(context.elapsedMs || 0),
    materialSha256: String(context.materialSha256 || '').toLowerCase(),
    inputHash: context.inputHash || '',
    checkedAt: new Date().toISOString(),
    cached: context.cached === true,
    ruleVersion: 'platform-traffic-potential-2026.08.24.2'
  };
}

export function buildMockTrafficPrediction({ platformCodes = [], materialSha256 = '' } = {}) {
  const codes = normalizeTrafficPlatformCodes(platformCodes);
  const mockScores = { douyin: 76, wechat_channels: 81, bilibili: 72, weibo: 74, xiaohongshu: 79 };
  return normalizeTrafficPredictionResult({
    platformPredictions: codes.map(code => ({
      platformCode: code,
      score: mockScores[code] || 70,
      strengths: ['主题表达较清晰', '标题与正文结构完整', '具备基础平台适配空间']
    }))
  }, { platformCodes: codes, materialSha256, mode: 'mock', model: 'mock-traffic-prediction', mock: true });
}

export function buildFailedTrafficPrediction({ platformCodes = [], materialSha256 = '', model = '', message = '平台内容适配潜力评估失败', code = 'TRAFFIC_PREDICTION_FAILED', elapsedMs = 0 } = {}) {
  return {
    status: 'FAILED',
    mock: false,
    mode: 'online',
    overallScore: null,
    overallLevel: '',
    platformPredictions: [],
    disclaimer: TRAFFIC_PREDICTION_DISCLAIMER,
    model,
    usage: null,
    elapsedMs,
    materialSha256: String(materialSha256 || '').toLowerCase(),
    checkedAt: new Date().toISOString(),
    cached: false,
    code,
    message: text(message, 300)
  };
}

