import crypto from 'node:crypto';
import { immediateTransaction, now, row, rows } from '../db.js';
import { normalizeChannelType } from './message-channel.js';

export { normalizeChannelType } from './message-channel.js';

const PRE_SEND_BATCH_STATES = ['PENDING', 'GENERATING', 'READY'];
const VALID_DIRECTIONS = new Set(['INBOUND', 'OUTBOUND', 'UNKNOWN']);
const VALID_CONFIDENCE = new Set(['HIGH', 'MEDIUM', 'LOW']);

function clean(value) {
  return String(value ?? '').trim();
}

function jsonObject(value, fallback = {}) {
  if (!value) return fallback;
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function jsonArray(value) {
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function uniqueNumbers(values) {
  return [...new Set(values.map(Number).filter(Number.isInteger).filter(value => value > 0))];
}

function normalizeDirection(value) {
  const direction = clean(value || 'INBOUND').toUpperCase();
  if (['INBOUND', 'INCOMING', 'RECEIVED', 'USER'].includes(direction)) return 'INBOUND';
  if (['OUTBOUND', 'OUTGOING', 'SENT', 'SELF'].includes(direction)) return 'OUTBOUND';
  return VALID_DIRECTIONS.has(direction) ? direction : 'UNKNOWN';
}

function normalizeConfidence(value, event) {
  const explicit = clean(value).toUpperCase();
  if (VALID_CONFIDENCE.has(explicit)) return explicit;
  if (clean(event.platformUserId || event.senderId || event.conversationKey || event.conversationId)) return 'HIGH';
  const context = jsonObject(event.context);
  if (clean(context.conversationId || context.chatId || context.threadId || context.userId || context.senderId)) return 'HIGH';
  if (clean(event.userName) && clean(event.avatarUrl || context.avatarUrl)) return 'MEDIUM';
  return 'LOW';
}

function eventFingerprint({ platformCode, accountId, channelType, event, direction }) {
  const context = jsonObject(event.context);
  const evidence = [
    platformCode,
    accountId,
    channelType,
    clean(event.conversationNamespace || event.conversationKey || event.conversationId || context.conversationId || context.chatId || context.threadId),
    clean(event.platformUserId || event.senderId || context.platformUserId || context.userId || context.senderId),
    direction,
    clean(event.userName),
    clean(event.content),
    clean(event.occurredAt || event.messageTime || context.messageTime || context.timestamp)
  ];
  return `fingerprint:v1:${crypto.createHash('sha256').update(JSON.stringify(evidence)).digest('hex')}`;
}

export function normalizeMessageEvent({ platformCode, accountId, channelType, event, collectedAt = now() }) {
  if (!clean(platformCode)) throw new Error('platformCode 不能为空');
  const numericAccountId = Number(accountId);
  if (!Number.isInteger(numericAccountId) || numericAccountId <= 0) throw new Error('accountId 无效');
  const normalizedChannel = normalizeChannelType(channelType || event?.channelType || event?.messageType);
  const source = event && typeof event === 'object' ? event : {};
  const context = jsonObject(source.context);
  const direction = normalizeDirection(source.direction || context.direction || 'INBOUND');
  const directMessageId = clean(source.platformMessageId || source.externalId || source.messageId || context.platformMessageId || context.messageId);
  const platformMessageId = directMessageId || eventFingerprint({ platformCode, accountId: numericAccountId, channelType: normalizedChannel, event: source, direction });
  const identityConfidence = normalizeConfidence(source.identityConfidence || context.identityConfidence, source);
  const conversationKey = clean(source.conversationKey || source.conversationId || context.conversationId || context.chatId || context.sessionId || context.threadId);
  const platformUserId = clean(source.platformUserId || source.senderId || context.platformUserId || context.userId || context.senderId);
  const explicitNamespace = clean(source.conversationNamespace || context.conversationNamespace);
  const stableConversationKey = conversationKey || platformUserId;
  const conversationNamespace = explicitNamespace || [
    clean(platformCode).toLowerCase(),
    numericAccountId,
    normalizedChannel,
    stableConversationKey ? `conversation:${stableConversationKey}` : `event:${platformMessageId}`
  ].join(':');
  let replyDisposition = clean(source.replyDisposition).toUpperCase();
  if (!replyDisposition) {
    if (direction === 'OUTBOUND') replyDisposition = 'OUTGOING';
    else if (source.alreadyHandled === true || context.alreadyHandled === true) replyDisposition = 'ALREADY_HANDLED';
    else if (identityConfidence === 'LOW') replyDisposition = 'MANUAL_REVIEW';
    else replyDisposition = 'PENDING_REPLY';
  }
  return {
    platformCode: clean(platformCode).toLowerCase(),
    accountId: numericAccountId,
    channelType: normalizedChannel,
    platformMessageId,
    usedFingerprint: !directMessageId,
    conversationNamespace,
    externalConversationKey: stableConversationKey || null,
    platformUserId: platformUserId || null,
    userName: clean(source.userName) || null,
    direction,
    content: clean(source.content),
    occurredAt: clean(source.occurredAt || source.messageTime || context.messageTime || context.timestamp) || null,
    collectedAt: clean(source.collectedAt || collectedAt) || now(),
    identityConfidence,
    identitySource: clean(source.identitySource || context.identitySource || (stableConversationKey ? 'PLATFORM_CONVERSATION_KEY' : 'EVENT_FINGERPRINT')) || null,
    contextEnabled: identityConfidence !== 'LOW' && Boolean(stableConversationKey),
    replyDisposition,
    sourceMessageId: Number.isInteger(Number(source.sourceMessageId)) && Number(source.sourceMessageId) > 0 ? Number(source.sourceMessageId) : null,
    raw: source
  };
}

function ensureLedgerConversation(tx, event, stamp) {
  tx.prepare(`INSERT OR IGNORE INTO conversations(namespace,platform_code,account_id,message_type,external_conversation_key,user_name,identity_confidence,identity_source,entry_type,context_enabled,version,ledger_version,last_message_at,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,0,0,?,?,?)`).run(
    event.conversationNamespace, event.platformCode, event.accountId, event.channelType,
    event.externalConversationKey, event.userName, event.identityConfidence, event.identitySource,
    event.externalConversationKey ? 'PLATFORM_ID' : 'EVENT_ISOLATED', event.contextEnabled ? 1 : 0,
    event.occurredAt || event.collectedAt, stamp, stamp
  );
  tx.prepare(`UPDATE conversations SET
    external_conversation_key=COALESCE(NULLIF(?,''),external_conversation_key),
    user_name=COALESCE(NULLIF(?,''),user_name),
    identity_confidence=CASE
      WHEN identity_confidence='HIGH' THEN identity_confidence
      WHEN ?='HIGH' THEN 'HIGH'
      WHEN identity_confidence='MEDIUM' THEN identity_confidence
      ELSE ? END,
    identity_source=COALESCE(NULLIF(?,''),identity_source),
    context_enabled=MAX(context_enabled,?),last_message_at=MAX(COALESCE(last_message_at,''),?),updated_at=?
    WHERE namespace=?`).run(
    event.externalConversationKey || '', event.userName || '', event.identityConfidence, event.identityConfidence,
    event.identitySource || '', event.contextEnabled ? 1 : 0, event.occurredAt || event.collectedAt, stamp, event.conversationNamespace
  );
  const conversation = tx.prepare('SELECT * FROM conversations WHERE namespace=?').get(event.conversationNamespace);
  if (!conversation) throw new Error('会话写入失败');
  return conversation;
}

function appendToReplyBatch(tx, event, conversation, eventId, conversationVersion, stamp) {
  if (event.direction !== 'INBOUND' || event.replyDisposition !== 'PENDING_REPLY') return null;
  const placeholders = PRE_SEND_BATCH_STATES.map(() => '?').join(',');
  let batch = tx.prepare(`SELECT * FROM reply_batches WHERE platform_code=? AND account_id=? AND channel_type=? AND conversation_namespace=?
    AND status IN (${placeholders}) ORDER BY id DESC LIMIT 1`).get(
    event.platformCode, event.accountId, event.channelType, event.conversationNamespace, ...PRE_SEND_BATCH_STATES
  );
  const sourceEventIds = uniqueNumbers([...(batch ? jsonArray(batch.source_event_ids_json) : []), eventId]);
  const sourceMessageIds = uniqueNumbers([...(batch ? jsonArray(batch.source_message_ids_json) : []), event.sourceMessageId]);
  const firstPendingAt = batch && clean(batch.first_pending_at) < clean(event.occurredAt || event.collectedAt)
    ? batch.first_pending_at
    : event.occurredAt || event.collectedAt;
  if (!batch) {
    const inserted = tx.prepare(`INSERT INTO reply_batches(platform_code,account_id,channel_type,conversation_id,conversation_namespace,status,first_pending_at,source_event_ids_json,source_message_ids_json,conversation_version,created_at,updated_at)
      VALUES(?,?,?,?,?,'PENDING',?,?,?,?,?,?)`).run(
      event.platformCode, event.accountId, event.channelType, conversation.id, event.conversationNamespace,
      firstPendingAt, JSON.stringify(sourceEventIds), JSON.stringify(sourceMessageIds), conversationVersion, stamp, stamp
    );
    return tx.prepare('SELECT * FROM reply_batches WHERE id=?').get(Number(inserted.lastInsertRowid));
  }

  // READY 表示旧答案已经生成但尚未领取。此时来了新消息，必须在同一个
  // 事务里取消旧发送 Job 并释放消息归属，避免旧答案抢先发出去。
  if (batch.status === 'READY' && Number(batch.agent_job_id || 0) > 0) {
    tx.prepare(`UPDATE agent_jobs SET status='CANCELLED',completed_at=?,lease_expires_at=NULL,result=?
      WHERE id=? AND job_type='REPLY' AND status='QUEUED'`).run(
      stamp, JSON.stringify({ ignored: true, ignoreReason: 'V2_NEW_INBOUND_INVALIDATED_READY_REPLY', replyBatchId: batch.id }), Number(batch.agent_job_id)
    );
    if (Number(batch.generation_message_id || 0) > 0) {
      tx.prepare(`UPDATE messages SET status='NEW',decision=NULL,reason='同一会话收到更新消息，旧答案已作废并等待重新生成',reply_job_id=NULL,updated_at=?
        WHERE id=? AND reply_job_id=? AND handled_at IS NULL`).run(stamp, Number(batch.generation_message_id), Number(batch.agent_job_id));
    }
  }

  tx.prepare(`UPDATE reply_batches SET first_pending_at=?,source_event_ids_json=?,source_message_ids_json=?,conversation_version=?,
    status='PENDING',reply_text=NULL,agent_job_id=NULL,generation_message_id=NULL,generation_started_at=NULL,claimed_at=NULL,
    invalidation_reason=CASE WHEN status IN ('GENERATING','READY') THEN 'NEW_INBOUND_EVENT' ELSE invalidation_reason END,updated_at=? WHERE id=?`).run(
    firstPendingAt, JSON.stringify(sourceEventIds), JSON.stringify(sourceMessageIds), conversationVersion, stamp, batch.id
  );
  return tx.prepare('SELECT * FROM reply_batches WHERE id=?').get(batch.id);
}

function updateRuntimeState(tx, { platformCode, accountId, channelType, scanStatus, errorCode, errorMessage, result }, stamp) {
  const normalizedStatus = clean(scanStatus || 'SUCCESS').toUpperCase();
  const successful = normalizedStatus === 'SUCCESS';
  const state = successful ? 'IDLE' : normalizedStatus === 'PARTIAL' ? 'DEGRADED' : 'ERROR';
  tx.prepare(`INSERT INTO channel_runtime_states(platform_code,account_id,channel_type,state,consecutive_failures,last_scan_completed_at,last_success_at,last_error_code,last_error_message,last_result_json,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(platform_code,account_id,channel_type) DO UPDATE SET
      state=excluded.state,
      consecutive_failures=CASE WHEN excluded.state='IDLE' THEN 0 ELSE channel_runtime_states.consecutive_failures+1 END,
      last_scan_completed_at=excluded.last_scan_completed_at,
      last_success_at=CASE WHEN excluded.state='IDLE' THEN excluded.last_success_at ELSE channel_runtime_states.last_success_at END,
      last_error_code=excluded.last_error_code,last_error_message=excluded.last_error_message,last_result_json=excluded.last_result_json,updated_at=excluded.updated_at`).run(
    platformCode, accountId, channelType, state, successful ? 0 : 1, stamp, successful ? stamp : null,
    successful ? null : clean(errorCode || normalizedStatus), successful ? null : clean(errorMessage || '消息通道扫描未完整成功'),
    JSON.stringify(result || {}), stamp, stamp
  );
}


export function recordChannelRuntimeState({
  platformCode,
  accountId,
  channelType,
  scanStatus = 'SUCCESS',
  errorCode = null,
  errorMessage = null,
  result = null,
  completedAt = now()
} = {}) {
  const normalizedPlatform = clean(platformCode).toLowerCase();
  const numericAccountId = Number(accountId);
  const normalizedChannel = normalizeChannelType(channelType);
  if (!normalizedPlatform) throw new Error('platformCode 不能为空');
  if (!Number.isInteger(numericAccountId) || numericAccountId <= 0) throw new Error('accountId 无效');
  return immediateTransaction(tx => {
    updateRuntimeState(tx, {
      platformCode: normalizedPlatform,
      accountId: numericAccountId,
      channelType: normalizedChannel,
      scanStatus,
      errorCode,
      errorMessage,
      result
    }, completedAt);
    return tx.prepare(`SELECT * FROM channel_runtime_states
      WHERE platform_code=? AND account_id=? AND channel_type=?`).get(
      normalizedPlatform, numericAccountId, normalizedChannel
    );
  });
}

/**
 * 原子持久化一次通道扫描：会话 -> 消息事件 -> 回复批次 -> 检查点 -> 健康状态。
 * 只有完整 SUCCESS 扫描才前移检查点；任一步失败都会整体回滚。
 */
export function persistMessageEventBatch({
  platformCode,
  accountId,
  channelType,
  events = [],
  checkpointScope = 'default',
  checkpointValue = null,
  advanceCheckpoint = true,
  scanStatus = 'SUCCESS',
  errorCode = null,
  errorMessage = null,
  scanResult = null,
  collectedAt = now()
} = {}) {
  const normalizedChannel = normalizeChannelType(channelType);
  const normalizedPlatform = clean(platformCode).toLowerCase();
  const numericAccountId = Number(accountId);
  if (!normalizedPlatform) throw new Error('platformCode 不能为空');
  if (!Number.isInteger(numericAccountId) || numericAccountId <= 0) throw new Error('accountId 无效');
  const normalizedEvents = (Array.isArray(events) ? events : []).map(event => normalizeMessageEvent({
    platformCode: normalizedPlatform, accountId: numericAccountId, channelType: normalizedChannel, event, collectedAt
  }));
  return immediateTransaction(tx => {
    const stamp = now();
    const insertedEvents = [];
    const duplicateEvents = [];
    const batchIds = new Set();
    for (const event of normalizedEvents) {
      const conversation = ensureLedgerConversation(tx, event, stamp);
      const inserted = tx.prepare(`INSERT OR IGNORE INTO message_events(platform_code,account_id,channel_type,platform_message_id,conversation_id,conversation_namespace,platform_user_id,direction,content,occurred_at,collected_at,first_seen_at,last_seen_at,seen_count,identity_confidence,identity_source,reply_disposition,conversation_version,source_message_id,raw_json,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?,?,?,?,?,?,?)`).run(
        event.platformCode, event.accountId, event.channelType, event.platformMessageId, conversation.id,
        event.conversationNamespace, event.platformUserId, event.direction, event.content, event.occurredAt,
        event.collectedAt, event.collectedAt, event.collectedAt, event.identityConfidence, event.identitySource,
        event.replyDisposition, Number(conversation.ledger_version || 0), event.sourceMessageId, JSON.stringify(event.raw), stamp, stamp
      );
      if (inserted.changes !== 1) {
        tx.prepare(`UPDATE message_events SET last_seen_at=?,seen_count=seen_count+1,raw_json=?,updated_at=?
          WHERE platform_code=? AND account_id=? AND channel_type=? AND platform_message_id=?`).run(
          event.collectedAt, JSON.stringify(event.raw), stamp, event.platformCode, event.accountId, event.channelType, event.platformMessageId
        );
        duplicateEvents.push(event.platformMessageId);
        continue;
      }
      const eventId = Number(inserted.lastInsertRowid);
      let conversationVersion = Number(conversation.ledger_version || 0);
      if (event.direction === 'INBOUND' && event.replyDisposition !== 'ALREADY_HANDLED') {
        tx.prepare(`UPDATE conversations SET ledger_version=ledger_version+1,last_incoming_event_id=?,last_message_at=?,updated_at=? WHERE id=?`).run(
          eventId, event.occurredAt || event.collectedAt, stamp, conversation.id
        );
        conversationVersion += 1;
        tx.prepare('UPDATE message_events SET conversation_version=?,updated_at=? WHERE id=?').run(conversationVersion, stamp, eventId);
      }
      const batch = appendToReplyBatch(tx, event, conversation, eventId, conversationVersion, stamp);
      if (batch) batchIds.add(Number(batch.id));
      insertedEvents.push({ id: eventId, platformMessageId: event.platformMessageId, conversationId: Number(conversation.id), conversationVersion, replyDisposition: event.replyDisposition, usedFingerprint: event.usedFingerprint });
    }
    const normalizedScanStatus = clean(scanStatus || 'SUCCESS').toUpperCase();
    if (advanceCheckpoint && normalizedScanStatus === 'SUCCESS') {
      const latestEventAt = normalizedEvents.map(event => event.occurredAt || event.collectedAt).sort().at(-1) || null;
      tx.prepare(`INSERT INTO collection_checkpoints(platform_code,account_id,channel_type,scope_key,cursor_value,last_complete_scan_at,last_event_at,scan_generation,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,1,?,?)
        ON CONFLICT(platform_code,account_id,channel_type,scope_key) DO UPDATE SET
          cursor_value=excluded.cursor_value,last_complete_scan_at=excluded.last_complete_scan_at,
          last_event_at=COALESCE(excluded.last_event_at,collection_checkpoints.last_event_at),
          scan_generation=collection_checkpoints.scan_generation+1,updated_at=excluded.updated_at`).run(
        normalizedPlatform, numericAccountId, normalizedChannel, clean(checkpointScope) || 'default',
        checkpointValue === null || checkpointValue === undefined ? null : String(checkpointValue), stamp, latestEventAt, stamp, stamp
      );
    }
    updateRuntimeState(tx, {
      platformCode: normalizedPlatform, accountId: numericAccountId, channelType: normalizedChannel,
      scanStatus: normalizedScanStatus, errorCode, errorMessage, result: scanResult || { eventCount: normalizedEvents.length }
    }, stamp);
    return {
      insertedCount: insertedEvents.length,
      duplicateCount: duplicateEvents.length,
      insertedEvents,
      duplicateEvents,
      replyBatchIds: [...batchIds],
      checkpointAdvanced: Boolean(advanceCheckpoint && normalizedScanStatus === 'SUCCESS')
    };
  });
}

export function channelCheckpoint(platformCode, accountId, channelType, checkpointScope = 'default') {
  return row(`SELECT * FROM collection_checkpoints WHERE platform_code=? AND account_id=? AND channel_type=? AND scope_key=?`,
    clean(platformCode).toLowerCase(), Number(accountId), normalizeChannelType(channelType), clean(checkpointScope) || 'default');
}

export function channelRuntimeState(platformCode, accountId, channelType) {
  return row(`SELECT * FROM channel_runtime_states WHERE platform_code=? AND account_id=? AND channel_type=?`,
    clean(platformCode).toLowerCase(), Number(accountId), normalizeChannelType(channelType));
}


export function claimPendingReplyBatchForGeneration(channelType, { platformCode = null } = {}) {
  const normalizedChannel = normalizeChannelType(channelType);
  const normalizedPlatform = clean(platformCode).toLowerCase();
  return immediateTransaction(tx => {
    const stamp = now();
    const params = [normalizedChannel];
    let platformSql = '';
    if (normalizedPlatform) {
      platformSql = ' AND b.platform_code=?';
      params.push(normalizedPlatform);
    }
    const batch = tx.prepare(`SELECT b.* FROM reply_batches b
      JOIN accounts a ON a.id=b.account_id AND a.platform_code=b.platform_code
      JOIN platforms p ON p.code=b.platform_code
      WHERE b.channel_type=?${platformSql} AND b.status='PENDING'
        AND a.enabled=1
        AND COALESCE(p.desired_state,'RUNNING')='RUNNING'
        AND COALESCE(p.lifecycle_state,'ACTIVE')='ACTIVE'
        AND COALESCE((SELECT s.encrypted_value FROM system_settings s WHERE s.setting_key='smart_reply.' || b.platform_code || '.enabled'),'true')='true'
        AND NOT EXISTS (
          SELECT 1 FROM reply_batches blocker
          WHERE blocker.platform_code=b.platform_code AND blocker.account_id=b.account_id
            AND blocker.channel_type=b.channel_type AND blocker.conversation_namespace=b.conversation_namespace
            AND blocker.id<>b.id AND blocker.status IN ('SENDING','NEEDS_CONFIRMATION','SEND_UNCERTAIN')
        )
      ORDER BY b.first_pending_at ASC,b.id ASC LIMIT 1`).get(...params);
    if (!batch) return null;
    const claimed = tx.prepare(`UPDATE reply_batches SET status='GENERATING',claimed_at=?,generation_started_at=?,invalidation_reason=NULL,updated_at=?
      WHERE id=? AND status='PENDING'`).run(stamp, stamp, stamp, batch.id);
    if (claimed.changes !== 1) return null;
    return tx.prepare('SELECT * FROM reply_batches WHERE id=?').get(batch.id);
  });
}

export function replyBatchSourceEvents(replyBatchId) {
  const batch = row('SELECT * FROM reply_batches WHERE id=?', Number(replyBatchId));
  if (!batch) return { batch: null, events: [], messages: [] };
  const eventIds = uniqueNumbers(jsonArray(batch.source_event_ids_json));
  const messageIds = uniqueNumbers(jsonArray(batch.source_message_ids_json));
  const events = eventIds.length
    ? rows(`SELECT * FROM message_events WHERE id IN (${eventIds.map(() => '?').join(',')}) ORDER BY conversation_version ASC,id ASC`, ...eventIds)
    : [];
  const messages = messageIds.length
    ? rows(`SELECT * FROM messages WHERE id IN (${messageIds.map(() => '?').join(',')}) ORDER BY id ASC`, ...messageIds)
    : [];
  return { batch, events, messages };
}

export function requeueReplyBatchGeneration(replyBatchId, reason = 'GENERATION_RETRY') {
  const stamp = now();
  return run(`UPDATE reply_batches SET status='PENDING',claimed_at=NULL,generation_started_at=NULL,reply_text=NULL,agent_job_id=NULL,generation_message_id=NULL,
    invalidation_reason=?,updated_at=? WHERE id=? AND status='GENERATING'`, clean(reason) || 'GENERATION_RETRY', stamp, Number(replyBatchId));
}

export function pendingReplyBatches(channelType, { limit = 100 } = {}) {
  const safeLimit = Math.max(1, Math.min(500, Number(limit) || 100));
  return rows(`SELECT * FROM reply_batches WHERE channel_type=? AND status='PENDING' ORDER BY first_pending_at ASC,id ASC LIMIT ?`,
    normalizeChannelType(channelType), safeLimit);
}


