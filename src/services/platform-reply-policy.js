import { PLATFORM_KNOWLEDGE_CATEGORY_MAP, PUBLIC_KNOWLEDGE_CATEGORY } from './knowledge-category.js';

// Source audit: docs/五平台回复字数规则-20260908.md. Unverified caps remain project defaults.
function replyLimit(publishedMax, { sourceType = 'PROJECT_FALLBACK', countingMode = 'CODE_POINTS', sourceUrl = null } = {}) {
  return Object.freeze({ publishedMax, safeMax: publishedMax - 20, sourceType, countingMode, countingVerified: sourceType === 'OFFICIAL_WEB', sourceUrl, checkedAt: '2026-09-08' });
}

export const PLATFORM_REPLY_LIMITS = Object.freeze({
  xiaohongshu: Object.freeze({
    label: '小红书',
    // Deferred by the operator: preserve existing budgets; this platform is not accepted in this release.
    acceptanceStatus: 'DEFERRED',
    acceptanceNote: '暂缓调试，未验收',
    COMMENT: replyLimit(300),
    PRIVATE_MESSAGE: replyLimit(500)
  }),
  douyin: Object.freeze({
    label: '抖音',
    COMMENT: replyLimit(500, { sourceType: 'OFFICIAL_WEB', countingMode: 'UTF16', sourceUrl: 'https://lf-fe-creator.douyinstatic.com/obj/douyn-creator-scm-cdn/douyin-creator-interactive/static/js/main.058a4db3.js' }),
    PRIVATE_MESSAGE: replyLimit(500, { sourceType: 'OFFICIAL_WEB', countingMode: 'UTF16', sourceUrl: 'https://lf-douyin-pc-web.douyinstatic.com/obj/douyin-pc-web/ies/douyin_web/async/87108.01cb9e97.js' })
  }),
  weibo: Object.freeze({
    label: '微博',
    // The official help page specifies 140, but does not define its counting algorithm.
    COMMENT: replyLimit(140, { sourceType: 'OFFICIAL_DOC', sourceUrl: 'https://kefu.weibo.com/faqdetail?id=21510' }),
    PRIVATE_MESSAGE: replyLimit(300)
  }),
  wechat_channels: Object.freeze({
    label: '视频号',
    COMMENT: replyLimit(200),
    PRIVATE_MESSAGE: replyLimit(500)
  }),
  bilibili: Object.freeze({
    label: 'B站',
    // The official 1000-character guide covers App image comments, not this web reply entrance.
    COMMENT: replyLimit(1000, { countingMode: 'UTF16', sourceUrl: 'https://www.bilibili.com/opus/752428294212681795' }),
    PRIVATE_MESSAGE: replyLimit(500, { sourceType: 'OFFICIAL_WEB', countingMode: 'UTF16', sourceUrl: 'https://s1.hdslb.com/bfs/static/2233-monorepo/message-pc/static/js/index.072ddb26.js' })
  })
});

const PLATFORM_CODES = Object.freeze(Object.keys(PLATFORM_REPLY_LIMITS));
const CATEGORY_PLATFORM_MAP = Object.freeze(Object.fromEntries(
  Object.entries(PLATFORM_KNOWLEDGE_CATEGORY_MAP).map(([platformCode, category]) => [category, platformCode])
));

export function normalizeReplyMessageType(value = '') {
  return String(value || '').trim().toUpperCase() === 'PRIVATE_MESSAGE' ? 'PRIVATE_MESSAGE' : 'COMMENT';
}

export function countUnicodeCharacters(value = '') {
  return Array.from(String(value ?? '').normalize('NFC')).length;
}

export function countReplyCharacters(value = '', countingMode = 'CODE_POINTS') {
  return countingMode === 'UTF16' ? String(value ?? '').normalize('NFC').length : countUnicodeCharacters(value);
}

function graphemeSegments(value = '') {
  const text = String(value ?? '').normalize('NFC');
  if (typeof Intl?.Segmenter === 'function') {
    return [...new Intl.Segmenter('zh-CN', { granularity: 'grapheme' }).segment(text)].map(item => item.segment);
  }
  return Array.from(text);
}

export function truncateUnicodeSafely(value = '', maxCharacters = 0) {
  const limit = Math.max(0, Number(maxCharacters) || 0);
  if (!limit) return '';
  let used = 0;
  let result = '';
  for (const segment of graphemeSegments(value)) {
    const size = countUnicodeCharacters(segment);
    if (used + size > limit) break;
    result += segment;
    used += size;
  }
  return result;
}

export function normalizeReplyTextForComparison(value = '') {
  return String(value ?? '')
    .normalize('NFC')
    .replace(/[\u200B\uFEFF]/g, '')
    .replace(/[\uFE0E\uFE0F]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function getReplyLimit(platformCode = '', messageType = 'COMMENT') {
  const platform = PLATFORM_REPLY_LIMITS[String(platformCode || '').trim()];
  if (!platform) return null;
  const normalizedType = normalizeReplyMessageType(messageType);
  const limit = platform[normalizedType];
  return {
    platformCode: String(platformCode || '').trim(),
    platformLabel: platform.label,
    messageType: normalizedType,
    messageLabel: normalizedType === 'PRIVATE_MESSAGE' ? '私信' : '评论/评论回复',
    publishedMax: limit.publishedMax,
    safeMax: limit.safeMax,
    countingMode: limit.countingMode,
    countingVerified: limit.countingVerified,
    sourceType: limit.sourceType,
    sourceUrl: limit.sourceUrl,
    checkedAt: limit.checkedAt
  };
}

export function validateReplyTextLength({ platformCode, messageType, text, usePublishedMax = false } = {}) {
  const policy = getReplyLimit(platformCode, messageType);
  const count = countReplyCharacters(text, policy?.countingMode);
  if (!policy) return { ok: true, count, limit: null, policy: null };
  const limit = usePublishedMax ? policy.publishedMax : policy.safeMax;
  return {
    ok: count <= limit,
    count,
    limit,
    policy,
    message: count <= limit ? '' : `${policy.platformLabel}${policy.messageLabel}内容共 ${count} 个字符，超过允许的 ${limit} 个字符，已禁止发送`
  };
}

export function knowledgeAnswerPolicy(category = PUBLIC_KNOWLEDGE_CATEGORY) {
  const normalizedCategory = String(category || '').trim() || PUBLIC_KNOWLEDGE_CATEGORY;
  const platformCodes = normalizedCategory === PUBLIC_KNOWLEDGE_CATEGORY
    ? [...PLATFORM_CODES]
    : [CATEGORY_PLATFORM_MAP[normalizedCategory]].filter(Boolean);
  if (!platformCodes.length) return null;
  const constraints = platformCodes.flatMap(platformCode => [
    getReplyLimit(platformCode, 'COMMENT'),
    getReplyLimit(platformCode, 'PRIVATE_MESSAGE')
  ]).filter(Boolean);
  const safeMax = Math.min(...constraints.map(item => item.safeMax));
  const strictest = constraints.filter(item => item.safeMax === safeMax);
  return {
    category: normalizedCategory,
    platformCodes,
    safeMax,
    strictest,
    countingMode: strictest.some(item => item.countingMode === 'UTF16') ? 'UTF16' : 'CODE_POINTS',
    label: normalizedCategory === PUBLIC_KNOWLEDGE_CATEGORY
      ? `公共知识库需同时适配五个平台，当前最严格限制为${[...new Set(strictest.map(item => `${item.platformLabel}${item.messageLabel}`))].join('、')}`
      : `${normalizedCategory}需同时适配评论回复和私信，当前最严格限制为${[...new Set(strictest.map(item => item.messageLabel))].join('、')}`
  };
}

export function validateKnowledgeAnswerLength({ category, answer } = {}) {
  const policy = knowledgeAnswerPolicy(category);
  const count = countReplyCharacters(answer, policy?.countingMode);
  if (!policy) return { ok: true, count, limit: null, policy: null, message: '' };
  return {
    ok: count <= policy.safeMax,
    count,
    limit: policy.safeMax,
    policy,
    message: count <= policy.safeMax ? '' : `标准答案共 ${count} 个字符，超过可入库上限 ${policy.safeMax} 个字符（${policy.label}），请在预览中修改后再入库`
  };
}
