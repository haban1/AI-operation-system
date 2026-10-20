import { persistMessageEventBatch, recordChannelRuntimeState } from './message-event-store.js';
import { normalizeChannelType } from './message-channel.js';

const SUCCESS_STATUSES = new Set(['SUCCESS']);
const PARTIAL_STATUSES = new Set(['PARTIAL', 'PARTIAL_SUCCESS', 'NEEDS_CONFIRMATION', 'DEGRADED']);
const MANUAL_MESSAGE_STATUSES = new Set([
  'MANUAL_REQUIRED', 'SMART_REPLY_PAUSED', 'IGNORED_OFFICIAL', 'SOURCE_GONE',
  'DEFERRED_PAGE_UNAVAILABLE', 'REPLY_UNCERTAIN', 'NEEDS_CONFIRMATION'
]);

function clean(value) {
  return String(value ?? '').trim();
}

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function addChannel(target, value) {
  try {
    const channel = normalizeChannelType(value);
    if (!target.includes(channel)) target.push(channel);
  } catch {}
}

export function collectionLedgerChannels(payload = {}, result = {}) {
  const channels = [];
  addChannel(channels, payload.channelType);
  for (const value of Array.isArray(payload.types) ? payload.types : []) addChannel(channels, value);
  for (const item of Array.isArray(result.typeResults) ? result.typeResults : []) addChannel(channels, item?.type || item?.channelType);
  for (const message of Array.isArray(result.messages) ? result.messages : []) addChannel(channels, message?.messageType || message?.channelType);
  return channels;
}

export function collectionLedgerScanStatus({ channelType, outerStatus, typeResults = [] } = {}) {
  const channel = normalizeChannelType(channelType);
  const typed = (Array.isArray(typeResults) ? typeResults : []).find(item => {
    try { return normalizeChannelType(item?.type || item?.channelType) === channel; } catch { return false; }
  });
  const raw = clean(typed?.status || outerStatus || 'FAILED').toUpperCase();
  if (SUCCESS_STATUSES.has(raw)) return { status: 'SUCCESS', typeResult: typed || null };
  if (PARTIAL_STATUSES.has(raw)) return { status: 'PARTIAL', typeResult: typed || null };
  return { status: 'FAILED', typeResult: typed || null };
}

function normalizedDirection(message, persisted) {
  const context = object(message?.context);
  const direct = clean(message?.direction || context.direction).toUpperCase();
  if (['OUTBOUND', 'OUTGOING', 'SENT', 'SELF'].includes(direct) || persisted?.ignoredSelf === true) return 'OUTBOUND';
  if (['INBOUND', 'INCOMING', 'RECEIVED', 'USER'].includes(direct)) return 'INBOUND';
  return 'INBOUND';
}

function replyDisposition(message, persisted, direction) {
  const context = object(message?.context);
  const stored = persisted?.message || null;
  if (direction === 'OUTBOUND') return 'OUTGOING';
  if (persisted?.platformReplyUnverified === true) return 'MANUAL_REVIEW';
  if (message?.alreadyHandled === true || context.alreadyHandled === true || stored?.handled_at) return 'ALREADY_HANDLED';
  // Shadow-ledger mode must not race the existing reply pipeline. If V1 already
  // owns this message, record the event/context but do not create a second batch.
  if (stored?.reply_job_id) return 'LEGACY_PIPELINE_OWNED';
  if (persisted?.ignoredOfficial === true || persisted?.foldedReplyUnverified === true || MANUAL_MESSAGE_STATUSES.has(clean(stored?.status).toUpperCase())) return 'MANUAL_REVIEW';
  return 'PENDING_REPLY';
}

export function collectedMessageLedgerEvent(message, persisted = null) {
  const context = object(message?.context);
  const stored = persisted?.message || null;
  const direction = normalizedDirection(message, persisted);
  const conversationKey = message?.conversationKey || message?.conversationId || context.conversationKey || context.conversationId || context.chatId || context.sessionId || context.threadId || null;
  const platformUserId = message?.platformUserId || message?.senderId || context.platformUserId || context.userId || context.senderId || context.talkerId || null;
  const identityConfidence = message?.identityConfidence || context.identityConfidence || context.identityAssessment?.confidence || null;
  return {
    ...message,
    platformMessageId: message?.platformMessageId || message?.externalId || message?.messageId || context.platformMessageId || context.messageId || null,
    conversationNamespace: persisted?.deferredReplyProcessing === true || persisted?.conversationBound === true
      ? (stored?.conversation_key_snapshot || message?.conversationNamespace || context.conversationNamespace || null)
      : (message?.conversationNamespace || context.conversationNamespace || null),
    conversationKey,
    platformUserId,
    direction,
    occurredAt: message?.occurredAt || message?.messageTime || context.messageTime || context.eventTime || context.timestamp || null,
    identityConfidence,
    identitySource: message?.identitySource || context.identitySource || context.identityAssessment?.reason || null,
    alreadyHandled: persisted?.platformReplyUnverified === true ? false : message?.alreadyHandled === true || context.alreadyHandled === true || Boolean(stored?.handled_at),
    replyDisposition: replyDisposition(message, persisted, direction),
    sourceMessageId: stored?.id || null
  };
}

function checkpointValue(result, typeResult, channelType) {
  const candidates = [
    typeResult?.checkpointValue,
    typeResult?.cursorValue,
    typeResult?.cursor,
    result?.collectionCheckpoints?.[channelType],
    result?.collectionCheckpoints?.[channelType.toLowerCase()]
  ];
  const value = candidates.find(item => item !== undefined && item !== null && item !== '');
  if (value === undefined) return null;
  return typeof value === 'string' ? value : JSON.stringify(value);
}

export function persistCollectedMessageLedger({ payload = {}, result = {}, outerStatus = 'FAILED', persistedMessages = [], jobId = null, collectedAt } = {}) {
  const channels = collectionLedgerChannels(payload, result);
  const messages = Array.isArray(result.messages) ? result.messages : [];
  return channels.map(channelType => {
    const scan = collectionLedgerScanStatus({ channelType, outerStatus, typeResults: result.typeResults });
    const events = messages.flatMap((message, index) => {
      try {
        if (normalizeChannelType(message?.messageType || message?.channelType) !== channelType) return [];
        return [collectedMessageLedgerEvent(message, persistedMessages[index] || null)];
      } catch {
        return [];
      }
    });
    const errorCode = scan.status === 'SUCCESS' ? null : clean(scan.typeResult?.reason || scan.typeResult?.status || outerStatus || 'COLLECTION_INCOMPLETE');
    const errorMessage = scan.status === 'SUCCESS' ? null : clean(scan.typeResult?.message || result.message || '消息通道扫描未完整成功');
    const ledger = persistMessageEventBatch({
      platformCode: payload.platformCode,
      accountId: payload.accountId,
      channelType,
      events,
      checkpointScope: clean(payload.collectionMode) || 'default',
      checkpointValue: checkpointValue(result, scan.typeResult, channelType),
      advanceCheckpoint: scan.status === 'SUCCESS',
      scanStatus: scan.status,
      errorCode,
      errorMessage,
      scanResult: {
        collectionJobId: jobId,
        outerStatus,
        channelType,
        messageCount: events.length,
        typeResult: scan.typeResult || null
      },
      collectedAt
    });
    return { channelType, scanStatus: scan.status, ...ledger };
  });
}

export function persistCollectedMessageRuntimeStates({ payload = {}, result = {}, outerStatus = 'FAILED', jobId = null, completedAt } = {}) {
  const channels = collectionLedgerChannels(payload, result);
  return channels.map(channelType => {
    const scan = collectionLedgerScanStatus({ channelType, outerStatus, typeResults: result.typeResults });
    const errorCode = scan.status === 'SUCCESS' ? null : clean(scan.typeResult?.reason || scan.typeResult?.status || outerStatus || 'COLLECTION_INCOMPLETE');
    const errorMessage = scan.status === 'SUCCESS' ? null : clean(scan.typeResult?.message || result.message || '消息通道扫描未完整成功');
    const runtimeState = recordChannelRuntimeState({
      platformCode: payload.platformCode,
      accountId: payload.accountId,
      channelType,
      scanStatus: scan.status,
      errorCode,
      errorMessage,
      result: {
        collectionJobId: jobId,
        outerStatus,
        channelType,
        messageCount: (Array.isArray(result.messages) ? result.messages : []).filter(message => {
          try { return normalizeChannelType(message?.messageType || message?.channelType) === channelType; } catch { return false; }
        }).length,
        typeResult: scan.typeResult || null
      },
      completedAt
    });
    return { channelType, scanStatus: scan.status, runtimeState };
  });
}

