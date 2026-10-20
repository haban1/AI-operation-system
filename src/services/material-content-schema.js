const TITLE_MAX_CODE_POINTS = 20;

function text(value) {
  return String(value ?? '').replace(/\r/g, '').replace(/[\t ]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

function shortText(value, maxLength) {
  return [...text(value)].slice(0, maxLength).join('');
}

function stringList(value, { maxItems = 8, maxLength = 80 } = {}) {
  const source = Array.isArray(value) ? value : value ? [value] : [];
  const seen = new Set();
  const output = [];
  for (const item of source) {
    const normalized = shortText(typeof item === 'object' ? item?.message || item?.text || '' : item, maxLength);
    const key = normalized.toLowerCase();
    if (!normalized || seen.has(key)) continue;
    seen.add(key);
    output.push(normalized);
    if (output.length >= maxItems) break;
  }
  return output;
}

export function parseModelJson(content) {
  const raw = Array.isArray(content)
    ? content.map(item => typeof item === 'string' ? item : item?.text || '').join('\n')
    : String(content || '');
  const unfenced = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
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
  const error = new Error('AI 返回内容不是有效 JSON');
  error.code = 'CONTENT_INVALID_JSON';
  throw error;
}

export function normalizeGeneratedCopy(raw = {}, context = {}) {
  const title = shortText(raw.title, TITLE_MAX_CODE_POINTS);
  const body = text(raw.body || raw.content || raw.copy);
  if (!title || !body) {
    const error = new Error('AI 返回的标题或正文为空');
    error.code = 'CONTENT_REQUIRED_FIELDS_MISSING';
    throw error;
  }
  const confidenceValue = Number(raw.confidence);
  const sourceType = text(context.sourceType || raw.sourceType || '');
  const sourceSummary = shortText(raw.sourceSummary || raw.imageSummary || raw.audioSummary || raw.summary, 240);
  return {
    coreTheme: shortText(raw.coreTheme || sourceSummary || title, 80),
    contentAngle: shortText(raw.contentAngle || '', 120),
    keyPoints: stringList(raw.keyPoints, { maxItems: 6, maxLength: 120 }),
    audioSummary: shortText(raw.audioSummary || (sourceType === 'image' ? '' : raw.summary), 240),
    imageSummary: shortText(raw.imageSummary || (sourceType === 'image' ? raw.summary : ''), 240),
    sourceSummary,
    sourceType,
    title,
    body,
    hashtags: [...new Set(stringList(raw.hashtags, { maxItems: 8, maxLength: 30 }).map(item => item.replace(/^#+/, '')).filter(Boolean))],
    confirmedFacts: stringList(raw.confirmedFacts, { maxItems: 12, maxLength: 120 }),
    uncertainFacts: stringList(raw.uncertainFacts, { maxItems: 12, maxLength: 120 }),
    riskFlags: stringList(raw.riskFlags, { maxItems: 12, maxLength: 120 }),
    confidence: Number.isFinite(confidenceValue) ? Math.max(0, Math.min(1, confidenceValue)) : 0,
    platformCodes: stringList(context.platformCodes, { maxItems: 10, maxLength: 40 })
  };
}

export function buildMockAudioContentGeneration({ materialSha256 = '', platformCodes = [] } = {}) {
  return {
    status: 'SUCCESS',
    mock: true,
    mode: 'mock',
    materialSha256,
    transcript: {
      text: 'Mock 演示模式未读取或分析视频音频。',
      model: 'mock-asr',
      usage: null,
      elapsedMs: 0,
      cached: false
    },
    result: normalizeGeneratedCopy({
      coreTheme: 'Mock 演示数据（未分析视频）',
      contentAngle: '仅用于验证页面链路，不代表真实视频内容',
      keyPoints: [],
      audioSummary: '当前未读取或分析视频音频',
      title: '演示文案（未分析视频）',
      body: '当前为 Mock 演示模式，本段内容并非根据所选视频生成。请配置千问 API Key 并切换为 online 模式后重新生成。',
      hashtags: [],
      confirmedFacts: [],
      uncertainFacts: [],
      riskFlags: [],
      confidence: 0.9
    }, { platformCodes }),
    calls: {
      asr: { status: 'SUCCESS', model: 'mock-asr', usage: null, elapsedMs: 0, errorCode: null, errorMessage: null },
      content: { status: 'SUCCESS', model: 'mock-content', usage: null, elapsedMs: 0, errorCode: null, errorMessage: null },
      knowledge: { status: 'SKIPPED', model: 'mock-content', usage: null, elapsedMs: 0, errorCode: 'MOCK_MODE', errorMessage: 'Mock 模式不生成知识草稿' }
    },
    knowledgeDraft: null,
    transmittedBytes: 0,
    originalVideoUploaded: false,
    elapsedMs: 0,
    checkedAt: new Date().toISOString(),
    cached: false
  };
}


export function buildMockImageContentGeneration({ materialSha256 = '', platformCodes = [] } = {}) {
  return {
    status: 'SUCCESS',
    mock: true,
    mode: 'mock',
    sourceType: 'image',
    materialSha256,
    result: normalizeGeneratedCopy({
      sourceType: 'image',
      coreTheme: 'Mock 演示数据（未分析图片）',
      contentAngle: '仅用于验证页面链路，不代表真实图片内容',
      keyPoints: [],
      imageSummary: '当前未读取或分析图片内容',
      title: '演示文案（未分析图片）',
      body: '当前为 Mock 演示模式，本段内容并非根据所选图片生成。请使用已配置的千问 API Key 并切换为 online 模式后重新生成。',
      hashtags: [],
      confirmedFacts: [],
      uncertainFacts: [],
      riskFlags: [],
      confidence: 0.9
    }, { platformCodes, sourceType: 'image' }),
    calls: {
      content: { status: 'SUCCESS', model: 'mock-image-content', usage: null, elapsedMs: 0, errorCode: null, errorMessage: null }
    },
    transmittedBytes: 0,
    originalImageUploaded: false,
    originalVideoUploaded: false,
    elapsedMs: 0,
    checkedAt: new Date().toISOString(),
    cached: false
  };
}
