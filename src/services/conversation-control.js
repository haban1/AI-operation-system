import { immediateTransaction, now, row, run } from '../db.js';
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
