import crypto from 'node:crypto';

function clean(value) { return String(value ?? '').trim(); }
function contextValue(context, keys) {
  for (const key of keys) {
    const value = clean(context?.[key]);
    if (value) return { key, value };
  }
  return null;
}
function safePart(value) { return clean(value).toLowerCase().replace(/\s+/g, ' ').slice(0, 500); }
function digest(value) { return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 24); }

export function resolveConversationIdentity(message = {}) {
  const context = message.context && typeof message.context === 'object'
    ? message.context
    : (() => { try { return JSON.parse(message.context_json || '{}'); } catch { return {}; } })();
  const platformCode = clean(message.platform_code || message.platformCode || 'unknown');
  const accountId = Number(message.account_id || message.accountId || 0);
  const messageType = clean(message.message_type || message.messageType || 'PRIVATE_MESSAGE').toUpperCase();
  const entry = clean(context.messageEntry || context.entryType || context.sourceTab || context.inboxType || context.listType || messageType).toUpperCase();
  const stable = contextValue(context, [
    'conversationKey', 'conversation_key', 'conversationId', 'conversation_id', 'chatId', 'chat_id',
    'sessionId', 'session_id', 'threadId', 'thread_id', 'userId', 'user_id', 'senderId', 'sender_id'
  ]);
  if (stable) {
    const externalKey = `${stable.key}:${safePart(stable.value)}`;
    return {
      namespace: `REAL:${platformCode}:${accountId}:${messageType}:${digest(externalKey)}`,
      externalKey,
      confidence: 'HIGH',
      source: stable.key,
      contextEnabled: true,
      entry
    };
  }
  const avatarHash = clean(context.avatarHash || context.avatar_hash);
  const userName = clean(message.user_name || message.userName);
  if (avatarHash && userName) {
    const externalKey = `avatar:${safePart(userName)}:${safePart(avatarHash)}:${entry}`;
    return {
      namespace: `REAL:${platformCode}:${accountId}:${messageType}:${digest(externalKey)}`,
      externalKey,
      confidence: 'MEDIUM',
      source: 'nickname_avatar_entry',
      contextEnabled: true,
      entry
    };
  }
  const perMessageKey = clean(message.external_id || message.externalId || crypto.randomUUID());
  return {
    namespace: `REAL:${platformCode}:${accountId}:${messageType}:LOW:${digest(`${entry}:${perMessageKey}`)}`,
    externalKey: `message:${perMessageKey}`,
    confidence: 'LOW',
    source: userName ? 'nickname_current_message_only' : 'current_message_only',
    contextEnabled: false,
    entry
  };
}

export function testConversationNamespace(operatorId, sessionId) {
  return `TEST:xiaozhi:${digest(operatorId || 'operator')}:${digest(sessionId)}`;
}
