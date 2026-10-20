import { row, rows, run, now } from '../db.js';
import { resolveConversationIdentity } from './conversation-identity.js';
import { CONVERSATION_HISTORY_MAX_TURNS } from './conversation-policy.js';

const serialQueues = new Map();

/**
 * 返回可用于回复的会话上下文。
 *
 * 私信上下文不再按消息时间差强制截断，避免用户隔一段时间继续提问时，
 * 丢失之前已经确认过的问题和答案。上下文数量仍由 recentConversationMessages
 * 的 limit 控制，避免把整个无限增长的会话一次性发送给模型。
 */
export function filterConversationContextWindow(message, recentMessages = []) {
  return Array.isArray(recentMessages) ? recentMessages.slice(-CONVERSATION_HISTORY_MAX_TURNS) : [];
}

export function ensureMessageConversation(message, { advanceIncoming = true } = {}) {
  if (!message?.id) throw new Error('消息缺少 id，无法绑定会话');
  message = row('SELECT * FROM messages WHERE id=?', message.id) || message;
  if (message.conversation_id) {
    const existing = row('SELECT * FROM conversations WHERE id=?', message.conversation_id);
    if (existing) return { conversation: existing, message, created: false };
  }
  const identity = resolveConversationIdentity(message);
  const stamp = now();
  let conversation = row('SELECT * FROM conversations WHERE namespace=?', identity.namespace);
  if (!conversation) {
    const inserted = run(`INSERT INTO conversations(namespace,platform_code,account_id,message_type,external_conversation_key,user_name,identity_confidence,identity_source,entry_type,context_enabled,version,last_message_at,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,0,?,?,?)`, identity.namespace, message.platform_code, message.account_id, message.message_type, identity.externalKey, message.user_name || null, identity.confidence, identity.source, identity.entry, identity.contextEnabled ? 1 : 0, stamp, stamp, stamp);
    conversation = row('SELECT * FROM conversations WHERE id=?', Number(inserted.lastInsertRowid));
  } else {
    run(`UPDATE conversations SET user_name=COALESCE(NULLIF(?,''),user_name),external_conversation_key=COALESCE(NULLIF(?,''),external_conversation_key),identity_confidence=?,identity_source=?,entry_type=?,context_enabled=?,last_message_at=?,updated_at=? WHERE id=?`,
      message.user_name || '', identity.externalKey, identity.confidence, identity.source, identity.entry, identity.contextEnabled ? 1 : 0, stamp, stamp, conversation.id);
  }
  // Already-replied history belongs to the conversation, but must not invalidate
  // a newer incoming message whose response is being generated or sent.
  if (advanceIncoming) {
    const changed = run(`UPDATE conversations SET version=version+1,last_incoming_message_id=?,last_message_at=?,updated_at=? WHERE id=?`, message.id, stamp, stamp, conversation.id);
    if (changed.changes !== 1) throw new Error('更新会话版本失败');
  }
  conversation = row('SELECT * FROM conversations WHERE id=?', conversation.id);
  run(`UPDATE messages SET conversation_id=?,conversation_key_snapshot=?,conversation_version=?,identity_confidence=?,identity_source=?,updated_at=? WHERE id=?`,
    conversation.id, conversation.namespace, conversation.version, identity.confidence, identity.source, stamp, message.id);
  return { conversation, message: row('SELECT * FROM messages WHERE id=?', message.id), created: true };
}

export function conversationForMessage(message) {
  if (!message) return null;
  if (message.conversation_id) return row('SELECT * FROM conversations WHERE id=?', message.conversation_id) || null;
  return null;
}


export function recentConversationMessages(message, { limit = CONVERSATION_HISTORY_MAX_TURNS, includeCurrent = false } = {}) {
  const conversation = conversationForMessage(message);
  if (!conversation || !conversation.context_enabled || conversation.identity_confidence === 'LOW') return [];
  const comparison = includeCurrent ? '<=' : '<';
  const safeLimit = Math.max(1, Math.min(CONVERSATION_HISTORY_MAX_TURNS, Number(limit) || CONVERSATION_HISTORY_MAX_TURNS));
  const candidates = rows(`SELECT id,content,user_name,reply_text,decision,status,knowledge_id,knowledge_question_snapshot,knowledge_answer_snapshot,reply_context_json,created_at,updated_at,handled_at,conversation_version
    FROM messages WHERE conversation_id=? AND deleted_at IS NULL AND id ${comparison} ? ORDER BY id DESC LIMIT ?`, conversation.id, message.id, safeLimit).reverse();
  return filterConversationContextWindow(message, candidates).slice(-safeLimit);
}

export function isMessageConversationCurrent(message) {
  if (!message?.conversation_id || !message?.conversation_version) return true;
  const current = row('SELECT version,last_incoming_message_id FROM conversations WHERE id=?', message.conversation_id);
  return Boolean(current) && Number(current.version) === Number(message.conversation_version) && Number(current.last_incoming_message_id) === Number(message.id);
}

export function withConversationSerial(conversationId, work) {
  const key = String(conversationId || 'unbound');
  const previous = serialQueues.get(key) || Promise.resolve();
  const current = previous.catch(() => {}).then(work);
  serialQueues.set(key, current);
  return current.finally(() => {
    if (serialQueues.get(key) === current) serialQueues.delete(key);
  });
}

export function backfillMessageConversations({ limit = 5000 } = {}) {
  const pending = rows('SELECT * FROM messages WHERE conversation_id IS NULL ORDER BY id LIMIT ?', Math.max(1, Number(limit) || 5000));
  let count = 0;
  for (const message of pending) {
    ensureMessageConversation(message);
    count += 1;
  }
  return count;
}

