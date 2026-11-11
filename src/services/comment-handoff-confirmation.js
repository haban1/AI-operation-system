function clean(value) { return String(value ?? '').trim(); }
function contextOf(message) {
  if (message?.context && typeof message.context === 'object') return message.context;
  try {
    const context = JSON.parse(message?.context_json || '{}');
    return context && typeof context === 'object' ? context : {};
  } catch { return {}; }
}
function replyContextOf(message) {
  if (message?.reply_context_json && typeof message.reply_context_json === 'object') return message.reply_context_json;
  try { return JSON.parse(message?.reply_context_json || '{}') || {}; } catch { return {}; }
}
function messageType(message) { return clean(message?.message_type || message?.messageType).toUpperCase(); }
function platformOf(message) { return clean(message?.platform_code || message?.platformCode).toLowerCase(); }
function accountOf(message) { return clean(message?.account_id ?? message?.accountId); }
const ACTOR_KEYS = ['actorPlatformId', 'actorMid', 'actorId', 'actor_id', 'userId', 'user_id', 'senderId', 'sender_id'];
const WORK_KEYS = ['sourceVideoKey', 'sourceVideoId', 'sourceAwemeId', 'awemeId', 'itemId', 'videoId', 'postId', 'post_id', 'sourcePostId', 'contentId', 'oid', 'noteId'];
const CONVERSATION_SOURCES = new Set(['conversationKey', 'conversation_key', 'conversationId', 'conversation_id', 'chatId', 'chat_id', 'sessionId', 'session_id', 'userId', 'user_id', 'senderId', 'sender_id']);
function valuesFor(context, keys) { return new Set(keys.map(key => clean(context[key])).filter(Boolean)); }
function intersects(first, second) { return [...first].some(value => second.has(value)); }
function timestamp(value) {
  if (!clean(value)) return NaN;
  const milliseconds = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(milliseconds) ? milliseconds : NaN;
}
function incomingTimestamp(message) {
  // A later collection must not make an earlier acknowledgement look new.
  const times = [timestamp(message.created_at), timestamp(message.collected_at)].filter(Number.isFinite);
  const context = contextOf(message);
  if (context.sourceVerified === true || clean(context.sourceVerified).toLowerCase() === 'true') {
    const platformTime = Number(context.eventTimeMs);
    if (Number.isFinite(platformTime) && platformTime > 0) times.push(platformTime);
    // Relative labels are not precise event timestamps and cannot override arrival time.
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/u.test(clean(context.eventTime))) {
      const eventTime = timestamp(context.eventTime);
      if (Number.isFinite(eventTime)) times.push(eventTime);
    }
  }
  return times.length ? Math.min(...times) : NaN;
}
function sameStableConversation(message, sourceMessage) {
  // A shared thread or nickname/avatar namespace does not prove the same user.
  const sources = [message, sourceMessage].map(item => clean(item.identity_source || item.identitySource));
  const confidences = [message, sourceMessage].map(item => clean(item.identity_confidence || item.identityConfidence).toUpperCase());
  const namespace = clean(message.conversation_key_snapshot);
  return Boolean(namespace && namespace === clean(sourceMessage.conversation_key_snapshot)
    && confidences.every(value => value === 'HIGH')
    && sources.every(value => CONVERSATION_SOURCES.has(value)));
}
function sameCommentUserAndWork(message, sourceMessage) {
  const current = contextOf(message), source = contextOf(sourceMessage);
  const actors = valuesFor(current, ACTOR_KEYS), sourceActors = valuesFor(source, ACTOR_KEYS);
  const works = valuesFor(current, WORK_KEYS), sourceWorks = valuesFor(source, WORK_KEYS);
  // Conflicting stable evidence cannot be overridden by a broad conversation key.
  if (actors.size && sourceActors.size && (actors.size !== 1 || sourceActors.size !== 1 || !intersects(actors, sourceActors))) return false;
  if (works.size && sourceWorks.size && !intersects(works, sourceWorks)) return false;
  if (WORK_KEYS.some(key => clean(current[key]) && clean(source[key]) && clean(current[key]) !== clean(source[key]))) return false;
  if (actors.size === 1 && sourceActors.size === 1 && works.size && sourceWorks.size) return true;
  return sameStableConversation(message, sourceMessage);
}
function parentIdsFor(message) {
  const ids = valuesFor(contextOf(message), ['parentCommentId', 'parent_comment_id', 'parentCommentStableId', 'replyToCommentId', 'reply_to_comment_id', 'replyToCommentStableId', 'parent', 'replyToMessageId', 'reply_to_message_id']);
  return new Set([...ids].filter(value => !/^0+$/u.test(value) && value.toLowerCase() !== 'root'));
}
function pointsToOffer(parentIds, sourceMessage) {
  const source = contextOf(sourceMessage);
  const sourceIds = valuesFor(source, ['commentId', 'comment_id', 'commentStableId', 'cid', 'sourceReplyId']);
  if (clean(sourceMessage.external_id || sourceMessage.externalId)) sourceIds.add(clean(sourceMessage.external_id || sourceMessage.externalId));
  return intersects(parentIds, sourceIds);
}

/** Find an offer the same user actually saw; never infer identity from a nickname. */
export function findCommentHandoffOffer(message, candidates, referenceTime = Date.now()) {
  if (messageType(message) !== 'COMMENT' || !platformOf(message) || !accountOf(message)) return null;
  const reference = referenceTime instanceof Date ? referenceTime.getTime() : Number(referenceTime);
  if (!Number.isFinite(reference)) return null;
  const incomingAt = incomingTimestamp(message);
  if (!Number.isFinite(incomingAt)) return null;
  const offers = [];
  const seen = new Set();
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    const { intent, sourceMessage } = candidate || {};
    if (!intent || !sourceMessage || clean(intent.status) !== 'WAITING_USER_CONFIRMATION') continue;
    if (messageType(sourceMessage) !== 'COMMENT' || (intent.message_type && messageType(intent) !== 'COMMENT')) continue;
    if (clean(sourceMessage.status) !== 'AUTO_REPLIED' || replyContextOf(sourceMessage).handoffOffered !== true) continue;
    const offeredAt = timestamp(sourceMessage.handled_at);
    if (!Number.isFinite(offeredAt) || incomingAt <= offeredAt) continue;
    const expiresAt = new Date(intent.expires_at).getTime();
    if (!Number.isFinite(expiresAt) || expiresAt <= reference) continue;
    if (platformOf(message) !== platformOf(sourceMessage) || accountOf(message) !== accountOf(sourceMessage)) continue;
    if ((platformOf(intent) && platformOf(intent) !== platformOf(message)) || (accountOf(intent) && accountOf(intent) !== accountOf(message))) continue;
    if (intent.source_message_id != null && clean(intent.source_message_id) !== clean(sourceMessage.id)) continue;
    if (message.id != null && sourceMessage.id != null && clean(message.id) === clean(sourceMessage.id)) continue;
    if (!sameCommentUserAndWork(message, sourceMessage)) continue;
    const identity = intent.id != null ? `intent:${intent.id}` : sourceMessage.id != null ? `message:${sourceMessage.id}` : candidate;
    if (seen.has(identity)) continue;
    seen.add(identity);
    offers.push(candidate);
  }
  const parentIds = parentIdsFor(message);
  const targeted = offers.filter(candidate => pointsToOffer(parentIds, candidate.sourceMessage));
  if (targeted.length) return targeted.length === 1 ? targeted[0] : null;
  if (parentIds.size) return null;
  return offers.length === 1 ? offers[0] : null;
}

/** Only a complete answer to the handoff offer counts; mixed questions keep routing. */
export function commentHandoffConfirmation(content) {
  const text = clean(content).normalize('NFKC').replace(/[!！。.,，~～\s]+$/gu, '');
  const thanks = '(?:[,，]?谢谢(?:你|您)?|[,，]?謝謝(?:你|您)?)?';
  if (new RegExp(`^(?:不用(?:了)?|不需要(?:了)?|不要(?:了)?|(?:暂时|暫時|先)(?:不用|不需要|不要)(?:了)?|不用麻烦了|不用麻煩了|不麻烦了|不麻煩了)${thanks}$`, 'u').test(text)) return 'DECLINE';
  if (new RegExp(`^(?:详情|詳情|了解(?:一下)?(?:详情|詳情)|(?:我)?想了解(?:一下)?(?:详情|詳情)|查看(?:详情|詳情)|想看(?:详情|詳情))${thanks}$`, 'u').test(text)) return 'ACCEPT';
  if (new RegExp(`^(?:好|好的|好呀|好啊|好嘞|行|行的|可以|可以的|是|是的|对|對|对的|對的|需要|需要的|要|要的|麻烦了|麻煩了|麻烦你了|麻煩你了|麻烦您了|麻煩您了|那就麻烦了|那就麻煩了)${thanks}$`, 'u').test(text)) return 'ACCEPT';
  return null;
}
