function clean(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function validDate(value) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function minuteAnchor(date, bucketMinutes = 5) {
  const bucketMs = bucketMinutes * 60 * 1000;
  return new Date(Math.floor(date.getTime() / bucketMs) * bucketMs).toISOString().slice(0, 16) + 'Z';
}

export function douyinPrivateOccurrenceAnchor(eventTime, observedAt = new Date()) {
  const text = clean(eventTime);
  const reference = validDate(observedAt);
  if (!text || !reference) return null;

  if (/^(?:刚刚|片刻前|刚才)$/.test(text)) return minuteAnchor(reference);

  let match = text.match(/^(\d+)\s*分钟前$/);
  if (match) return minuteAnchor(new Date(reference.getTime() - Number(match[1]) * 60 * 1000));

  match = text.match(/^昨天\s*(\d{1,2}):(\d{2})$/);
  if (match) {
    const date = new Date(reference);
    date.setDate(date.getDate() - 1);
    date.setHours(Number(match[1]), Number(match[2]), 0, 0);
    return minuteAnchor(date, 1);
  }

  match = text.match(/^(\d{1,2}):(\d{2})$/);
  if (match) {
    const date = new Date(reference);
    date.setHours(Number(match[1]), Number(match[2]), 0, 0);
    if (date.getTime() > reference.getTime() + 5 * 60 * 1000) date.setDate(date.getDate() - 1);
    return minuteAnchor(date, 1);
  }

  match = text.match(/^(\d{1,2})[\/-](\d{1,2})$/);
  if (match) {
    const date = new Date(reference);
    date.setMonth(Number(match[1]) - 1, Number(match[2]));
    date.setHours(0, 0, 0, 0);
    if (date.getTime() > reference.getTime() + 24 * 60 * 60 * 1000) date.setFullYear(date.getFullYear() - 1);
    return date.toISOString().slice(0, 10);
  }

  const absolute = validDate(text);
  return absolute ? minuteAnchor(absolute, 1) : null;
}

function messageContext(value = {}) {
  if (value.context && typeof value.context === 'object') return value.context;
  if (value.messageContext && typeof value.messageContext === 'object') return value.messageContext;
  if (typeof value.context_json === 'string') {
    try { return JSON.parse(value.context_json) || {}; } catch { return {}; }
  }
  return {};
}

function observedAt(value = {}, fallback = new Date()) {
  return value.collected_at || value.updated_at || value.created_at || fallback;
}

export function isSameDouyinPrivateOccurrence(existing = {}, incoming = {}, incomingObservedAt = new Date()) {
  const existingUser = clean(existing.user_name || existing.userName);
  const incomingUser = clean(incoming.user_name || incoming.userName);
  const existingContent = clean(existing.content);
  const incomingContent = clean(incoming.content);
  if (!existingUser || existingUser !== incomingUser || !existingContent || existingContent !== incomingContent) return false;

  const existingContext = messageContext(existing);
  const incomingContext = messageContext(incoming);
  const existingConversationKey = clean(existingContext.conversationKey);
  const incomingConversationKey = clean(incomingContext.conversationKey);
  if (existingConversationKey && incomingConversationKey && existingConversationKey !== incomingConversationKey) return false;

  const existingMessageId = clean(existingContext.messageId);
  const incomingMessageId = clean(incomingContext.messageId);
  if (existingMessageId && incomingMessageId) return existingMessageId === incomingMessageId;

  const existingAnchor = clean(existingContext.occurrenceAnchor)
    || douyinPrivateOccurrenceAnchor(existingContext.eventTime, observedAt(existing));
  const incomingAnchor = clean(incomingContext.occurrenceAnchor)
    || douyinPrivateOccurrenceAnchor(incomingContext.eventTime, incomingObservedAt);
  if (existingAnchor && incomingAnchor) {
    if (existingAnchor === incomingAnchor) return true;
    const existingAnchorDate = validDate(existingAnchor);
    const incomingAnchorDate = validDate(incomingAnchor);
    if (existingAnchorDate && incomingAnchorDate) {
      return Math.abs(incomingAnchorDate.getTime() - existingAnchorDate.getTime()) <= 15 * 60 * 1000;
    }
    return false;
  }

  const existingObserved = validDate(observedAt(existing));
  const incomingObserved = validDate(incomingObservedAt);
  if (!existingObserved || !incomingObserved) return false;
  return Math.abs(incomingObserved.getTime() - existingObserved.getTime()) <= 15 * 60 * 1000;
}
