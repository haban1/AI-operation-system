import { config } from '../config.js';
import { db, immediateTransaction } from '../db.js';
import { miniProgramAccount, requestMiniProgramHandoff } from './mini-program-channel.js';
import { validIso8601 } from './mini-program-auth.js';
import { withConversationSerial } from './conversation-store.js';
import { requeueMiniProgramCallback } from './mini-program-callback.js';
import { requeueNotification } from './notification.js';

const PROCESSING = ['PENDING', 'RUNNING', 'RETRY_WAIT'];
const CALLBACK_PENDING = ['PENDING', 'SENDING', 'RETRY_WAIT', 'NOT_CONFIGURED'];
const FILTERS = ['ALL', 'PROCESSING', 'CALLBACK_PENDING', 'HANDOFF_PENDING', 'HUMAN_MANAGED', 'ERROR'];
const MODES = ['BOT_ACTIVE', 'HANDOFF_PENDING', 'HUMAN_MANAGED'];
const MESSAGE_STATUSES = ['NEW', 'REPLY_QUEUED', 'REPLY_RUNNING', 'AUTO_REPLIED', 'MANUAL_REQUIRED', 'MANUAL_HANDLED', 'CLOSED', 'SUPERSEDED'];
const MESSAGE_DECISIONS = [
  'AUTO_REPLY', 'AUTO_REPLY_PARTIAL_KNOWLEDGE', 'SMALL_TALK', 'GREETING_GUIDANCE', 'KNOWLEDGE_GAP_GUIDANCE',
  'SIMPLE_GREETING', 'ROUTER_IGNORED', 'AUTO_REPLY_INELIGIBLE', 'SUPERSEDED_BY_NEW_MESSAGE',
  'RAG_ANSWERED', 'RAG_NEED_CLARIFICATION', 'RAG_CLARIFICATION_LIMIT', 'RAG_SERVICE_UNAVAILABLE',
  'HUMAN_HANDOFF', 'HUMAN_FOLLOWUP_NOTIFIED', 'HUMAN_FOLLOWUP_NOTIFICATION_PENDING', 'MANUAL_HANDLED'
];

// SQLite permits non-integer values and integers outside JavaScript's exact range.
function readStatement(sql) { const statement = db.prepare(sql); statement.setReadBigInts(true); return statement; }
function readRecord(value) {
  return value && Object.fromEntries(Object.entries(value).map(([key, field]) => [key,
    typeof field === 'bigint' ? (Number.isSafeInteger(Number(field)) ? Number(field) : null) : field]));
}
function rows(sql, ...params) { return readStatement(sql).all(...params).map(readRecord); }
function row(sql, ...params) { return readRecord(readStatement(sql).get(...params)); }
function safeInteger(value, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum ? value : null;
}
function enumValue(value, allowed) { return allowed.includes(value) ? value : 'UNKNOWN'; }

export class MiniProgramAdminError extends Error {
  constructor(statusCode, code, message) { super(message); this.statusCode = statusCode; this.code = code; }
}
function invalidInput() { return new MiniProgramAdminError(400, 'MINI_PROGRAM_ADMIN_INVALID_INPUT', '小程序管理参数无效'); }
function notFound() { return new MiniProgramAdminError(404, 'MINI_PROGRAM_ADMIN_NOT_FOUND', '小程序记录不存在'); }
function invalidState() { return new MiniProgramAdminError(409, 'MINI_PROGRAM_ADMIN_INVALID_STATE', '当前状态不允许此操作'); }
function numericId(value) {
  if (!/^[1-9]\d*$/.test(String(value)) || !Number.isSafeInteger(Number(value))) throw invalidInput();
  return Number(value);
}
function objectJson(value) {
  try { const result = JSON.parse(value); return result && typeof result === 'object' && !Array.isArray(result) ? result : {}; }
  catch { return {}; }
}
function externalId(value) { return typeof value === 'string' && value.length > 0 && [...value].length <= 128 && value.trim() === value; }
function timestamp(value) {
  if (typeof value !== 'string' || !validIso8601(value)) return null;
  return new Date(value).toISOString();
}
function displayText(value, redactSignatures = true) {
  if (value == null) return null;
  let result = String(value);
  for (const secret of [config.miniProgramSharedSecret, config.miniProgramCallbackUrl]) {
    if (secret) result = result.split(secret).join('[REDACTED]');
  }
  return redactSignatures ? result.replace(/\b[0-9a-f]{64}\b/gi, '[REDACTED]') : result;
}

function ownedConversations(id = null) {
  let account;
  try { account = miniProgramAccount(); }
  catch (error) {
    if (error.statusCode === 503 && error.code === 'MINI_PROGRAM_ACCOUNT_UNAVAILABLE') {
      throw new MiniProgramAdminError(503, 'MINI_PROGRAM_ACCOUNT_UNAVAILABLE', '小程序渠道账号不可用');
    }
    throw error;
  }
  return rows(`SELECT c.*,u.app_id AS admin_app_id,u.first_handoff_at AS admin_first_handoff_at
    FROM conversations c JOIN accounts a ON a.id=c.account_id
    JOIN mini_program_users u ON u.account_id=c.account_id AND u.external_user_id=c.user_name
    WHERE c.platform_code='mini_program' AND c.message_type='PRIVATE_MESSAGE'
      AND a.platform_code='mini_program' AND c.account_id=?
      AND c.namespace='mini-program:' || u.app_id || ':' || c.external_conversation_key
      ${id === null ? '' : 'AND c.id=?'}
    ORDER BY c.last_message_at DESC,c.id DESC`, account.id, ...(id === null ? [] : [id]))
    .filter(item => externalId(item.admin_app_id) && externalId(item.external_conversation_key) && externalId(item.user_name));
}
function ownedConversation(id) {
  if (!Number.isSafeInteger(id) || id <= 0) throw notFound();
  const conversation = ownedConversations(id)[0];
  if (!conversation) throw notFound();
  return conversation;
}
function ownsMessage(conversation, message) {
  if (!message || message.platform_code !== 'mini_program' || message.message_type !== 'PRIVATE_MESSAGE'
    || message.account_id !== conversation.account_id || message.conversation_id !== conversation.id
    || message.user_name !== conversation.user_name) return false;
  const context = objectJson(message.context_json);
  return context.transport === 'MINI_PROGRAM' && context.serverSignatureVerified === true
    && context.appId === conversation.admin_app_id && context.userId === conversation.user_name
    && context.conversationId === conversation.external_conversation_key
    && externalId(context.messageId) && message.external_id === `mini-program:${context.appId}:message:${context.messageId}`
    && message.conversation_key_snapshot === conversation.namespace;
}
function ownsNotification(conversation, notification, message) {
  if (!notification || notification.channel !== 'WECOM' || !ownsMessage(conversation, message) || notification.message_id !== message.id
    || notification.conversation_id !== conversation.id
    || notification.idempotency_key !== `wecom:mini-program:handoff:conversation:${conversation.id}`) return false;
  const metadata = objectJson(notification.metadata_json);
  const identity = metadata.miniProgram;
  return metadata.handoff === true && identity && identity.appId === conversation.admin_app_id
    && identity.accountId === conversation.account_id && identity.userId === conversation.user_name
    && identity.conversationId === conversation.external_conversation_key;
}
function ownsCallback(conversation, callback, message) {
  if (!callback || !ownsMessage(conversation, message) || callback.message_id !== message.id
    || callback.conversation_id !== conversation.id || callback.app_id !== conversation.admin_app_id) return false;
  const payload = objectJson(callback.payload_json);
  return payload.type === 'assistant.message' && payload.appId === conversation.admin_app_id
    && payload.eventId === callback.event_id && payload.conversationId === conversation.external_conversation_key
    && payload.userId === conversation.user_name && payload.inReplyToMessageId === objectJson(message.context_json).messageId
    && typeof payload.text === 'string';
}
function verifyHandoffChildren(conversation) {
  const messages = rows('SELECT * FROM messages WHERE conversation_id=?', conversation.id);
  if (messages.some(message => !ownsMessage(conversation, message))) throw notFound();
  const byId = new Map(messages.map(message => [message.id, message]));
  const notifications = rows('SELECT * FROM notifications WHERE conversation_id=?', conversation.id);
  if (notifications.some(notification => !ownsNotification(conversation, notification, byId.get(notification.message_id)))) throw notFound();
  const callbacks = rows('SELECT * FROM mini_program_callback_outbox WHERE conversation_id=?', conversation.id);
  if (callbacks.some(callback => !ownsCallback(conversation, callback, byId.get(callback.message_id)))) throw notFound();
  const batches = rows('SELECT platform_code,account_id,channel_type,conversation_namespace FROM reply_batches WHERE conversation_id=?', conversation.id);
  if (batches.some(batch => batch.platform_code !== 'mini_program' || batch.account_id !== conversation.account_id
    || batch.channel_type !== 'PRIVATE_MESSAGE' || batch.conversation_namespace !== conversation.namespace)) throw notFound();
}
function entries(conversation) {
  return rows('SELECT * FROM messages WHERE conversation_id=? ORDER BY id', conversation.id)
    .filter(message => ownsMessage(conversation, message)).map(message => {
      const processing = row('SELECT * FROM mini_program_processing_jobs WHERE message_id=? AND conversation_id=?', message.id, conversation.id);
      const callback = row('SELECT * FROM mini_program_callback_outbox WHERE message_id=?', message.id);
      const notification = row('SELECT * FROM notifications WHERE message_id=? AND idempotency_key=?', message.id, `wecom:mini-program:handoff:conversation:${conversation.id}`);
      return { message, processing, callback: ownsCallback(conversation, callback, message) ? callback : null,
        notification: ownsNotification(conversation, notification, message) ? notification : null };
    });
}

// External service and legacy error strings are untrusted. Project fixed summaries, never their raw text.
function deliverySummary(value, kind) {
  if (!value) return null;
  const statuses = kind === 'callback'
    ? [...CALLBACK_PENDING, 'FAILED', 'SENT', 'CANCELLED']
    : ['PENDING', 'SENDING', 'RETRY_WAIT', 'FAILED', 'SENT', 'CONFIRMED'];
  const status = enumValue(value.status, statuses);
  return {
    id: safeInteger(value.id, 1), status, attemptCount: safeInteger(value.attempt_count),
    error: status === 'CANCELLED' ? null : status === 'NOT_CONFIGURED' ? '回调尚未配置'
      : value.error_message ? (kind === 'callback' ? '回调发送失败，请检查回调服务后重试' : '企微通知发送失败，请检查通知服务后重试') : null,
    httpStatus: kind === 'callback' ? safeInteger(value.http_status, 100, 599) : null,
    sentAt: timestamp(value.sent_at),
    confirmedAt: kind === 'notification' ? timestamp(value.confirmed_at) : null,
    retryable: kind === 'callback' ? ['FAILED', 'NOT_CONFIGURED'].includes(status) : ['FAILED', 'RETRY_WAIT'].includes(status)
  };
}
function processingSummary(value) {
  if (!value) return null;
  return { id: safeInteger(value.id, 1), status: enumValue(value.status, [...PROCESSING, 'COMPLETED', 'FAILED']),
    attemptCount: safeInteger(value.attempt_count), error: value.last_error_message ? '消息处理失败，请检查处理服务' : null };
}
function conversationSummary(conversation, items = entries(conversation)) {
  const latest = items.at(-1);
  const notification = items.find(item => item.notification)?.notification;
  return {
    id: safeInteger(conversation.id, 1), platformCode: 'mini_program', appId: displayText(conversation.admin_app_id, false),
    conversationId: displayText(conversation.external_conversation_key, false), userId: displayText(conversation.user_name, false),
    lastTextPreview: [...(displayText(latest?.message.content) || '')].slice(0, 120).join(''),
    lastActivityAt: timestamp(latest && objectJson(latest.message.context_json).sentAt),
    handlingMode: enumValue(conversation.handling_mode, MODES),
    historicalUser: Boolean(conversation.admin_first_handoff_at),
    processingStatus: processingSummary(latest?.processing)?.status || null,
    callbackStatus: deliverySummary(latest?.callback, 'callback')?.status || null,
    notificationId: safeInteger(notification?.id, 1),
    notificationStatus: deliverySummary(notification, 'notification')?.status || null
  };
}

export function getMiniProgramStatus() {
  const counts = { processing: 0, processingFailed: 0, callbackPending: 0, callbackFailed: 0, notificationFailed: 0 };
  let lastReceivedAt = null;
  for (const conversation of ownedConversations()) for (const item of entries(conversation)) {
    const receivedAt = timestamp(item.message.collected_at);
    if (receivedAt > (lastReceivedAt || '')) lastReceivedAt = receivedAt;
    if (PROCESSING.includes(item.processing?.status)) counts.processing++;
    if (item.processing?.status === 'FAILED') counts.processingFailed++;
    if (CALLBACK_PENDING.includes(item.callback?.status)) counts.callbackPending++;
    if (item.callback?.status === 'FAILED') counts.callbackFailed++;
    if (item.notification?.status === 'FAILED') counts.notificationFailed++;
  }
  return { apiEnabled: Boolean(config.miniProgramApiEnabled), appConfigured: Boolean(config.miniProgramAppId),
    secretConfigured: Boolean(config.miniProgramSharedSecret), callbackConfigured: Boolean(config.miniProgramCallbackUrl), lastReceivedAt, counts };
}

export function listMiniProgramConversations({ status = 'ALL', limit = 200 } = {}) {
  if (!FILTERS.includes(status) || !/^[1-9]\d*$/.test(String(limit)) || !Number.isSafeInteger(Number(limit)) || Number(limit) > 1000) throw invalidInput();
  const result = [];
  for (const conversation of ownedConversations()) {
    const items = entries(conversation);
    const matches = status === 'ALL'
      || (status === 'PROCESSING' && items.some(item => PROCESSING.includes(item.processing?.status)))
      || (status === 'CALLBACK_PENDING' && items.some(item => CALLBACK_PENDING.includes(item.callback?.status)))
      || (['HANDOFF_PENDING', 'HUMAN_MANAGED'].includes(status) && conversation.handling_mode === status)
      || (status === 'ERROR' && items.some(item => item.processing?.status === 'FAILED' || item.callback?.status === 'FAILED' || item.notification?.status === 'FAILED'));
    if (matches) result.push(conversationSummary(conversation, items));
    if (result.length >= Number(limit)) break;
  }
  return result;
}

export function getMiniProgramConversationMessages(conversationId) {
  const conversation = ownedConversation(numericId(conversationId));
  const items = entries(conversation);
  return { conversation: conversationSummary(conversation, items), messages: items.map(({ message, processing, callback, notification }) => ({
    id: safeInteger(message.id, 1), messageId: displayText(objectJson(message.context_json).messageId, false), text: displayText(message.content),
    replyText: displayText(message.reply_text || (callback && objectJson(callback.payload_json).text)),
    status: enumValue(message.status, MESSAGE_STATUSES), decision: message.decision == null ? null : enumValue(message.decision, MESSAGE_DECISIONS),
    knowledgeId: safeInteger(message.knowledge_id, 1),
    knowledgeQuestionSnapshot: displayText(message.knowledge_question_snapshot), receivedAt: timestamp(message.collected_at),
    sentAt: timestamp(objectJson(message.context_json).sentAt), processing: processingSummary(processing),
    callback: callback ? { ...deliverySummary(callback, 'callback'), retryable: conversation.handling_mode === 'BOT_ACTIVE' && ['FAILED', 'NOT_CONFIGURED'].includes(callback.status) } : null,
    notification: deliverySummary(notification, 'notification')
  })) };
}

export async function handoffMiniProgramConversation({ conversationId, idempotencyKey } = {}) {
  const id = numericId(conversationId);
  if (typeof idempotencyKey !== 'string' || idempotencyKey.length > 128 || idempotencyKey !== `mini-program-handoff:${id}`) throw invalidInput();
  return withConversationSerial(id, () => immediateTransaction(() => {
    const conversation = ownedConversation(id);
    if (!MODES.includes(conversation.handling_mode)) throw invalidState();
    verifyHandoffChildren(conversation);
    const existing = row('SELECT * FROM notifications WHERE idempotency_key=?', `wecom:mini-program:handoff:conversation:${id}`);
    const sourceId = existing?.message_id || conversation.handoff_source_message_id || conversation.last_incoming_message_id;
    const source = row('SELECT * FROM messages WHERE id=?', sourceId);
    if (!ownsMessage(conversation, source) || (existing && !ownsNotification(conversation, existing, source))) throw notFound();
    if (conversation.handling_mode === 'HUMAN_MANAGED' && (!existing || !['SENT', 'CONFIRMED'].includes(existing.status))) throw invalidState();
    // Match the shared helper's authoritative evidence selection; created_at is not delivery proof.
    if (existing && ['SENT', 'CONFIRMED'].includes(existing.status) && !timestamp(existing.confirmed_at || existing.sent_at)) throw invalidState();
    const result = requestMiniProgramHandoff({ conversationId: id, messageId: source.id,
      reason: conversation.handoff_reason || '后台发起转人工' });
    return { conversation: conversationSummary(ownedConversation(id)), notification: deliverySummary(result.notification, 'notification'), created: result.created };
  }));
}

export function retryMiniProgramNotification({ notificationId } = {}) {
  const id = numericId(notificationId);
  return immediateTransaction(() => {
    const notification = row('SELECT * FROM notifications WHERE id=?', id);
    if (!notification) throw notFound();
    const conversation = ownedConversation(notification.conversation_id);
    const message = row('SELECT * FROM messages WHERE id=?', notification.message_id);
    if (!ownsNotification(conversation, notification, message)) throw notFound();
    if (conversation.handling_mode !== 'HANDOFF_PENDING' || !['FAILED', 'RETRY_WAIT'].includes(notification.status)) throw invalidState();
    return deliverySummary(requeueNotification(id), 'notification');
  });
}

export function retryMiniProgramCallback({ callbackId } = {}) {
  const id = numericId(callbackId);
  return immediateTransaction(() => {
    const callback = row('SELECT * FROM mini_program_callback_outbox WHERE id=?', id);
    if (!callback) throw notFound();
    const conversation = ownedConversation(callback.conversation_id);
    const message = row('SELECT * FROM messages WHERE id=?', callback.message_id);
    if (!ownsCallback(conversation, callback, message)) throw notFound();
    if (conversation.handling_mode !== 'BOT_ACTIVE' || !['FAILED', 'NOT_CONFIGURED'].includes(callback.status)) throw invalidState();
    return deliverySummary(requeueMiniProgramCallback(id), 'callback');
  });
}
