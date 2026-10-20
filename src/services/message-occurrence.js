const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

function parseReference(reference) {
  const value = reference instanceof Date ? reference : new Date(reference || Date.now());
  return Number.isFinite(value.getTime()) ? value : new Date();
}

function parseContext(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return {}; }
}

function stableCommentId(value) {
  const context = parseContext(value);
  return String(context.commentStableId || context.commentId || context.cid || '').trim();
}

export function sameStableCommentIdentity(existing, incomingContext) {
  const previousId = stableCommentId(existing?.context_json ?? existing?.context);
  const incomingId = stableCommentId(incomingContext);
  return Boolean(previousId && incomingId && previousId === incomingId);
}

export function platformEventAgeMs(label, reference = new Date()) {
  const text = String(label || '').trim().replace(/\s+/g, '');
  if (!text) return null;
  if (/^(刚刚|刚才|片刻前|now)$/i.test(text)) return 0;

  const relativeUnits = [
    { pattern: /^(\d+(?:\.\d+)?)秒前$/, factor: SECOND_MS },
    { pattern: /^(\d+(?:\.\d+)?)分钟前$/, factor: MINUTE_MS },
    { pattern: /^(\d+(?:\.\d+)?)小时前$/, factor: HOUR_MS },
    { pattern: /^(\d+(?:\.\d+)?)天前$/, factor: DAY_MS },
    { pattern: /^(\d+(?:\.\d+)?)周前$/, factor: 7 * DAY_MS }
  ];
  for (const { pattern, factor } of relativeUnits) {
    const match = text.match(pattern);
    if (match) return Number(match[1]) * factor;
  }
  if (text === '昨天') return DAY_MS;
  if (text === '前天') return 2 * DAY_MS;

  const ref = parseReference(reference);
  let match = text.match(/^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})(?:日)?(?:T?(\d{1,2}):(\d{2}))?$/);
  let eventDate;
  if (match) {
    eventDate = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4] || 0), Number(match[5] || 0));
  } else {
    match = text.match(/^(\d{1,2})[-/.月](\d{1,2})(?:日)?(?:T?(\d{1,2}):(\d{2}))?$/);
    if (match) {
      eventDate = new Date(ref.getFullYear(), Number(match[1]) - 1, Number(match[2]), Number(match[3] || 0), Number(match[4] || 0));
      if (eventDate.getTime() - ref.getTime() > DAY_MS) eventDate.setFullYear(eventDate.getFullYear() - 1);
    }
  }
  if (!eventDate || !Number.isFinite(eventDate.getTime())) return null;
  return Math.max(0, ref.getTime() - eventDate.getTime());
}

export function isRepeatedCommentOccurrence(existing, incomingContext, reference = new Date()) {
  if (!existing) return false;
  // 平台稳定评论 ID 是最高优先级身份。相对时间显示变化时仍视为同一条评论。
  if (sameStableCommentIdentity(existing, incomingContext)) return false;
  const ref = parseReference(reference);
  const previousContext = parseContext(existing.context_json ?? existing.context);
  const previousAge = platformEventAgeMs(previousContext.eventTime, ref);
  const incomingAge = platformEventAgeMs(parseContext(incomingContext).eventTime, ref);
  if (incomingAge === null) return false;

  // 同一条评论的相对时间只会逐渐变大；突然变得更“新”，说明相同内容再次发生。
  if (previousAge !== null && previousAge - incomingAge >= 30 * MINUTE_MS) return true;

  // 兼容旧版本已把 context_json 覆盖成新时间的漏单：记录创建时间明显早于页面事件时间。
  const createdAt = new Date(existing.created_at || 0).getTime();
  const recordAge = Number.isFinite(createdAt) ? ref.getTime() - createdAt : null;
  return recordAge !== null && recordAge >= 0 && recordAge - incomingAge >= 2 * HOUR_MS;
}

export function repeatedExternalId(baseExternalId, stamp = new Date()) {
  const base = String(baseExternalId || '').split('--repeat-', 1)[0];
  const value = parseReference(stamp).toISOString().replace(/[-:.TZ]/g, '');
  return `${base}--repeat-${value}`;
}
