import { immediateTransaction, now, row, rows, run } from '../db.js';
import { automationDisabledForHandlingMode, CONVERSATION_HANDLING_MODE, normalizeHandlingMode } from './operation-state.js';

export function conversationHandlingMode(conversation) {
  if (!conversation) return CONVERSATION_HANDLING_MODE.BOT_ACTIVE;
  return normalizeHandlingMode(conversation.handling_mode, conversation.human_followup_state);
}

export function conversationAutomationDisabled(conversation) {
  return automationDisabledForHandlingMode(conversation?.handling_mode, conversation?.human_followup_state);
}

export function cancelConversationAutomation(conversationId, { reason = 'CONVERSATION_HANDOFF', exceptMessageId = null } = {}) {
  const numericConversationId = Number(conversationId);
  if (!Number.isInteger(numericConversationId) || numericConversationId <= 0) return { jobs: 0, messages: 0, batches: 0, callbacks: 0 };
  return immediateTransaction(() => {
    const stamp = now();
    const messageFilter = exceptMessageId ? ' AND id<>?' : '';
    const messageParams = exceptMessageId ? [reason, stamp, numericConversationId, Number(exceptMessageId)] : [reason, stamp, numericConversationId];
    const jobs = run(`UPDATE agent_jobs SET status='CANCELLED',completed_at=?,lease_expires_at=NULL,result=?
      WHERE job_type='REPLY' AND status='QUEUED' AND CAST(json_extract(payload,'$.messageId') AS INTEGER) IN
        (SELECT id FROM messages WHERE conversation_id=?)`, stamp, JSON.stringify({ reason, conversationId: numericConversationId }), numericConversationId);
    const messages = run(`UPDATE messages SET status='MANUAL_REQUIRED',decision='HUMAN_HANDOFF',reason=?,reply_job_id=NULL,updated_at=?
      WHERE conversation_id=? AND handled_at IS NULL AND status IN ('NEW','REPLY_QUEUED')${messageFilter}`,
      ...messageParams);
    const batches = run(`UPDATE reply_batches SET status='CANCELLED',invalidation_reason=?,completed_at=?,updated_at=?
      WHERE conversation_id=? AND status IN ('PENDING','GENERATING','READY')`, reason, stamp, stamp, numericConversationId);
    const callbacks = run(`UPDATE mini_program_callback_outbox
      SET status='CANCELLED',error_message=?,claimed_at=NULL,lease_expires_at=NULL,available_at=NULL,updated_at=?
      WHERE conversation_id=? AND status IN ('PENDING','RETRY_WAIT','NOT_CONFIGURED')`, reason, stamp, numericConversationId);
    return { jobs: Number(jobs.changes || 0), messages: Number(messages.changes || 0), batches: Number(batches.changes || 0), callbacks: Number(callbacks.changes || 0) };
  });
}

export function beginConversationHandoff({ conversationId, messageId = null, reason = 'MANUAL_HANDOFF' } = {}) {
  const numericConversationId = Number(conversationId);
  if (!Number.isInteger(numericConversationId) || numericConversationId <= 0) throw new Error('conversationId 无效');
  return immediateTransaction(() => {
    const current = row('SELECT * FROM conversations WHERE id=?', numericConversationId);
    if (!current) throw new Error('会话不存在');
    const stamp = now();
    const currentMode = conversationHandlingMode(current);
    if (currentMode !== CONVERSATION_HANDLING_MODE.HUMAN_MANAGED) {
      run(`UPDATE conversations SET handling_mode='HANDOFF_PENDING',human_followup_state='WAITING',handoff_reason=?,
        handoff_source_message_id=COALESCE(?,handoff_source_message_id),handoff_requested_at=COALESCE(handoff_requested_at,?),updated_at=? WHERE id=?`,
        String(reason || 'MANUAL_HANDOFF').slice(0, 1000), messageId ? Number(messageId) : null, stamp, stamp, numericConversationId);
    }
    cancelConversationAutomation(numericConversationId, { reason: String(reason || 'MANUAL_HANDOFF'), exceptMessageId: messageId });
    return row('SELECT * FROM conversations WHERE id=?', numericConversationId);
  });
}

export function confirmConversationHandoff({ conversationId, notificationId, confirmedAt = now() } = {}) {
  const numericConversationId = Number(conversationId);
  if (!Number.isInteger(numericConversationId) || numericConversationId <= 0) return null;
  run(`UPDATE conversations SET handling_mode='HUMAN_MANAGED',human_followup_state='WAITING',wecom_notified_at=?,
    handoff_confirmed_at=?,handoff_notification_id=?,updated_at=? WHERE id=?`,
    confirmedAt, confirmedAt, notificationId ? Number(notificationId) : null, confirmedAt, numericConversationId);
  return row('SELECT * FROM conversations WHERE id=?', numericConversationId);
}

export function markHumanFollowupMessage(messageId, { notificationId = null, confirmed = false, reason = '已进入人工处理流程' } = {}) {
  if (!messageId) return null;
  const stamp = now();
  run(`UPDATE messages SET status='MANUAL_REQUIRED',decision=?,reason=?,reply_job_id=NULL,
    wecom_notification_status=?,wecom_notification_id=COALESCE(?,wecom_notification_id),updated_at=? WHERE id=?`,
    confirmed ? 'HUMAN_FOLLOWUP_NOTIFIED' : 'HUMAN_FOLLOWUP_NOTIFICATION_PENDING', reason,
    confirmed ? 'SENT' : 'PENDING', notificationId, stamp, Number(messageId));
  return row('SELECT * FROM messages WHERE id=?', Number(messageId));
}

const ACTIVE_INTENT_STATUSES = "('WAITING_USER_CONFIRMATION','REQUESTED','NOTIFY_QUEUED','NOTIFIED')";

function conversationIdOrThrow(conversationId) {
  const id = Number(conversationId);
  if (!Number.isInteger(id) || id <= 0) throw Object.assign(new Error('conversationId 无效'), { statusCode: 400 });
  return id;
}

function ownedPlatformConversation(id) {
  const conversation = row('SELECT * FROM conversations WHERE id=?', id);
  if (!conversation) throw Object.assign(new Error('会话不存在'), { statusCode: 404 });
  // 小程序有独立的转人工状态机与回调，不能从这里改。
  if (conversation.platform_code === 'mini_program') throw Object.assign(new Error('小程序会话请在小程序对话管理中处理'), { statusCode: 409, code: 'MINI_PROGRAM_DEDICATED_API_REQUIRED' });
  return conversation;
}

/**
 * 运营主动接管：立即进入人工处理，取消排队中的机器人回复，不再发企微通知（接管人就是人工）。
 */
export function takeOverConversation({ conversationId, operator = '运营人员', reason = '运营人员手动接管' } = {}) {
  const id = conversationIdOrThrow(conversationId);
  return immediateTransaction(() => {
    ownedPlatformConversation(id);
    const stamp = now();
    run(`UPDATE conversations SET handling_mode='HUMAN_MANAGED',human_followup_state='WAITING',handoff_reason=?,
      handoff_requested_at=COALESCE(handoff_requested_at,?),handoff_confirmed_at=COALESCE(handoff_confirmed_at,?),
      handoff_taken_over_by=?,handoff_released_at=NULL,handoff_release_reason=NULL,updated_at=? WHERE id=?`,
      String(reason).slice(0, 1000), stamp, stamp, String(operator || '运营人员').slice(0, 100), stamp, id);
    const cancelled = cancelConversationAutomation(id, { reason: 'OPERATOR_TAKEOVER' });
    return { conversation: row('SELECT * FROM conversations WHERE id=?', id), cancelled };
  });
}

/**
 * 交还 AI：结束本次人工会话，新的消息重新由机器人处理。
 * 已经在待人工列表里的旧消息保持原状，由人工标记处理，避免机器人回复早已过时的问题。
 */
export function releaseConversationToBot({ conversationId, operator = '运营人员', reason = 'OPERATOR_RELEASE' } = {}) {
  const id = conversationIdOrThrow(conversationId);
  return immediateTransaction(() => {
    const conversation = ownedPlatformConversation(id);
    const stamp = now();
    const wasHuman = normalizeHandlingMode(conversation.handling_mode, conversation.human_followup_state) !== CONVERSATION_HANDLING_MODE.BOT_ACTIVE;
    run(`UPDATE conversations SET handling_mode='BOT_ACTIVE',human_followup_state='NONE',clarification_attempts=0,pending_intent_json=NULL,
      handoff_offered_at=NULL,handoff_source_message_id=NULL,handoff_requested_at=NULL,handoff_confirmed_at=NULL,handoff_notification_id=NULL,
      handoff_ack_job_id=NULL,handoff_taken_over_by=NULL,handoff_released_at=?,handoff_release_reason=?,updated_at=? WHERE id=?`,
      stamp, String(reason).slice(0, 200), stamp, id);
    const ackJobs = run(`UPDATE agent_jobs SET status='CANCELLED',completed_at=?,result=? WHERE job_type='REPLY' AND status='QUEUED'
      AND json_extract(payload,'$.auxiliaryKind')='HANDOFF_ACK' AND CAST(json_extract(payload,'$.conversationId') AS INTEGER)=?`,
      stamp, JSON.stringify({ ignored: true, ignoreReason: 'CONVERSATION_RELEASED' }), id).changes;
    // 意图按消息的会话键登记；不关闭的话，“已通知”的兼容分支仍会把新消息转给人工。
    const intents = run(`UPDATE manual_handoff_intents SET status='CLOSED_BY_RELEASE',updated_at=?
      WHERE status IN ${ACTIVE_INTENT_STATUSES} AND conversation_key IN (
        SELECT conversation_key_snapshot FROM messages WHERE conversation_id=? AND conversation_key_snapshot IS NOT NULL
        UNION SELECT ?)`, stamp, id, String(conversation.namespace || '')).changes;
    // 停止仍在重试的转人工通知，已送达的保留记录。
    const notifications = run(`UPDATE notifications SET
      metadata_json=json_set(COALESCE(metadata_json,'{}'),'$.archivedAt',?,'$.archiveReason','CONVERSATION_RELEASED'),
      status=CASE WHEN status IN ('PENDING','RETRY_WAIT','SENDING','FAILED') THEN 'CANCELLED' ELSE status END,
      claimed_at=NULL,lease_expires_at=NULL,available_at=NULL,updated_at=?
      WHERE conversation_id=? AND json_extract(COALESCE(metadata_json,'{}'),'$.handoff')=1
        AND json_extract(COALESCE(metadata_json,'{}'),'$.archivedAt') IS NULL`, stamp, stamp, id).changes;
    return { conversation: row('SELECT * FROM conversations WHERE id=?', id), wasHuman, operator, cancelled: { ackJobs, intents, notifications } };
  });
}

/**
 * 闲置自动交还：人工会话在 idleHours 内没有新来信、也没有人工处理记录时交还 AI。
 * 只改会话状态，不给用户发任何消息。
 */
export function releaseIdleHandoffConversations({ idleHours, stamp = now() } = {}) {
  const hours = Number(idleHours);
  if (!Number.isFinite(hours) || hours <= 0) return [];
  const cutoff = new Date(new Date(stamp).getTime() - hours * 3_600_000).toISOString();
  const candidates = rows(`SELECT c.id FROM conversations c
    WHERE c.handling_mode IN ('HANDOFF_PENDING','HUMAN_MANAGED') AND c.platform_code<>'mini_program'
      AND MAX(COALESCE(c.last_message_at,''),COALESCE(c.handoff_requested_at,''),COALESCE(c.handoff_confirmed_at,''),
        COALESCE((SELECT MAX(m.handled_at) FROM messages m WHERE m.conversation_id=c.id),'')) < ?
    ORDER BY c.id LIMIT 200`, cutoff);
  return candidates.map(item => releaseConversationToBot({ conversationId: item.id, operator: 'SYSTEM', reason: 'IDLE_TIMEOUT' }).conversation.id);
}
