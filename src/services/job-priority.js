export const JOB_PRIORITY = Object.freeze({
  PRIVATE_REPLY: 10,
  PRIVATE_INCREMENTAL_COLLECTION: 20,
  MANUAL_REPLY_DETECTION: 25,
  COMMENT_REPLY: 30,
  COMMENT_COLLECTION: 40,
  PUBLISH: 50,
  PUBLISH_VERIFICATION: 60,
  OLD_CONVERSATION_RECOVERY: 80,
  BACKGROUND: 100
});

function normalizedChannel(payload = {}) {
  return String(payload.channelType || payload.messageType || payload.queueLane || '').trim().toUpperCase();
}

export function isOldConversationRecoveryJob(jobType, payload = {}) {
  const type = String(jobType || '').trim().toUpperCase();
  const scanMode = String(payload.scanMode || payload.collectionScope || payload.recoveryMode || '').trim().toUpperCase();
  return type === 'SCAN_OLD_CONVERSATIONS'
    || payload.oldConversationScan === true
    || payload.recoveryScan === true
    || ['OLD_CONVERSATIONS', 'CONVERSATION_RECOVERY', 'STALE_CONVERSATION_RECOVERY'].includes(scanMode);
}

export function priorityForJob(jobType, payload = {}) {
  const type = String(jobType || '').trim().toUpperCase();
  const channel = normalizedChannel(payload);
  if (isOldConversationRecoveryJob(type, payload)) return JOB_PRIORITY.OLD_CONVERSATION_RECOVERY;
  if (type === 'REPLY') return channel === 'COMMENT' ? JOB_PRIORITY.COMMENT_REPLY : JOB_PRIORITY.PRIVATE_REPLY;
  if (type === 'DETECT_MANUAL_REPLY') return JOB_PRIORITY.MANUAL_REPLY_DETECTION;
  if (type === 'COLLECT_MESSAGES') {
    if (channel === 'COMMENT') return JOB_PRIORITY.COMMENT_COLLECTION;
    // COMBINED 同时承担发现新增私信的职责，按私信增量采集优先级领取。
    return JOB_PRIORITY.PRIVATE_INCREMENTAL_COLLECTION;
  }
  if (type === 'PUBLISH') return JOB_PRIORITY.PUBLISH;
  if (type === 'VERIFY_PUBLISH' || type === 'PUBLISH_STATUS_CHECK') return JOB_PRIORITY.PUBLISH_VERIFICATION;
  return JOB_PRIORITY.BACKGROUND;
}
