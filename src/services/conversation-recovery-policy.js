export const RECOVERY_SCAN_MIN_INTERVAL_MS = 30 * 60 * 1000;
export const RECOVERY_SCAN_MAX_IDLE_MS = 2 * 24 * 60 * 60 * 1000;
export const RECOVERY_SCAN_BATCH_LIMIT = 2;

function timeMs(value) {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizedChannel(payload = {}) {
  return String(payload.channelType || payload.messageType || payload.queueLane || '').trim().toUpperCase();
}

export function isRecoveryScanPayload(payload = {}) {
  const mode = String(payload.scanMode || payload.collectionScope || payload.recoveryMode || '').trim().toUpperCase();
  return payload.oldConversationScan === true
    || payload.recoveryScan === true
    || ['OLD_CONVERSATIONS', 'CONVERSATION_RECOVERY', 'STALE_CONVERSATION_RECOVERY'].includes(mode);
}

export function isIncrementalConversationWork(jobType, payload = {}) {
  const type = String(jobType || '').trim().toUpperCase();
  if (isRecoveryScanPayload(payload) || type === 'SCAN_OLD_CONVERSATIONS') return false;
  if (type === 'REPLY') return normalizedChannel(payload) !== 'COMMENT';
  if (type !== 'COLLECT_MESSAGES') return false;
  const channel = normalizedChannel(payload);
  return channel === '' || channel === 'PRIVATE_MESSAGE' || channel === 'COMBINED';
}

export function hasIncrementalConversationWork(jobs = [], { excludeJobId = null } = {}) {
  return (Array.isArray(jobs) ? jobs : []).some(job => {
    if (excludeJobId != null && Number(job?.id) === Number(excludeJobId)) return false;
    const status = String(job?.status || 'QUEUED').trim().toUpperCase();
    if (!['QUEUED', 'RUNNING', 'PENDING', 'LEASED', 'RETRY_WAIT'].includes(status)) return false;
    return isIncrementalConversationWork(job?.job_type || job?.jobType, job?.payload || {});
  });
}

export function recoveryConversationIds(payload = {}) {
  const values = [payload.conversationId, ...(Array.isArray(payload.conversationIds) ? payload.conversationIds : [])];
  return [...new Set(values.map(Number).filter(value => Number.isInteger(value) && value > 0))]
    .slice(0, RECOVERY_SCAN_BATCH_LIMIT);
}

export function eligibleForRecoveryScan(conversation, referenceTime = Date.now(), {
  minIntervalMs = RECOVERY_SCAN_MIN_INTERVAL_MS,
  maxIdleMs = RECOVERY_SCAN_MAX_IDLE_MS
} = {}) {
  if (!conversation) return { eligible: false, reason: 'CONVERSATION_NOT_FOUND' };
  if (String(conversation.message_type || '').trim().toUpperCase() !== 'PRIVATE_MESSAGE') {
    return { eligible: false, reason: 'NOT_PRIVATE_MESSAGE_CONVERSATION' };
  }
  const handlingMode = String(conversation.handling_mode || 'BOT_ACTIVE').trim().toUpperCase();
  const legacyState = String(conversation.human_followup_state || 'NONE').trim().toUpperCase();
  if (handlingMode !== 'BOT_ACTIVE' || ['WAITING', 'NOTIFIED', 'HUMAN_MANAGED', 'PENDING', 'NOTIFY_QUEUED', 'HANDOFF_PENDING'].includes(legacyState)) {
    return { eligible: false, reason: 'AUTOMATION_DISABLED' };
  }
  const nowMs = timeMs(referenceTime);
  const lastMessageMs = timeMs(conversation.last_message_at);
  if (nowMs == null || lastMessageMs == null) return { eligible: false, reason: 'INVALID_TIME' };
  const idleMs = Math.max(0, nowMs - lastMessageMs);
  if (idleMs > maxIdleMs) return { eligible: false, reason: 'CONVERSATION_IDLE_OVER_TWO_DAYS', idleMs };
  const lastScanMs = timeMs(conversation.last_recovery_scan_at);
  if (lastScanMs != null && nowMs - lastScanMs < minIntervalMs) {
    return { eligible: false, reason: 'RECOVERY_SCAN_INTERVAL_NOT_REACHED', idleMs, elapsedSinceScanMs: Math.max(0, nowMs - lastScanMs) };
  }
  return { eligible: true, reason: 'ELIGIBLE', idleMs };
}

export function limitRecoveryBatch(conversations = [], limit = RECOVERY_SCAN_BATCH_LIMIT) {
  const safeLimit = Math.max(1, Math.min(RECOVERY_SCAN_BATCH_LIMIT, Number(limit) || RECOVERY_SCAN_BATCH_LIMIT));
  return (Array.isArray(conversations) ? conversations : []).slice(0, safeLimit);
}
