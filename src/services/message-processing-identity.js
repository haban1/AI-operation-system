import { commentSourceIdentity, douyinCommentOccurrenceAnchor, normalizeCommentIdentityText } from './comment-identity.js';
import { hashString } from './workflow.js';

function parseContext(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return {}; }
}

function clean(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

export function stableCommentId(contextValue = {}) {
  const context = parseContext(contextValue);
  return clean(context.commentStableId || context.commentId || context.cid);
}

export function buildMessageProcessingIdentity(message = {}, reference = new Date()) {
  const platformCode = clean(message.platformCode || message.platform_code).toLowerCase();
  const accountId = Number(message.accountId || message.account_id || 0);
  const messageType = clean(message.messageType || message.message_type || 'COMMENT').toUpperCase();
  const context = parseContext(message.context || message.context_json);
  const externalId = clean(message.externalId || message.external_id).split('--repeat-', 1)[0];
  const userName = normalizeCommentIdentityText(message.userName || message.user_name);
  const content = normalizeCommentIdentityText(message.content);
  let identitySource = 'EXTERNAL_ID';
  let identityParts = [platformCode, accountId, messageType, externalId];
  const metadata = {};

  if (messageType === 'COMMENT') {
    const commentId = stableCommentId(context);
    if (commentId) {
      identitySource = 'COMMENT_STABLE_ID';
      identityParts = [platformCode, accountId, messageType, normalizeCommentIdentityText(commentId)];
      metadata.commentStableId = commentId;
    } else {
      const source = commentSourceIdentity(context)
        || normalizeCommentIdentityText(message.externalUrl || message.external_url)
        || 'unknown-source';
      const eventAnchor = platformCode === 'douyin'
        ? douyinCommentOccurrenceAnchor(context.eventTime, reference)
        : normalizeCommentIdentityText(context.eventTime);
      identitySource = 'COMMENT_SEMANTIC_OCCURRENCE';
      identityParts = [platformCode, accountId, messageType, source, userName, content, eventAnchor || externalId];
      metadata.commentSource = source;
      metadata.eventAnchor = eventAnchor || null;
    }
  } else if (messageType === 'PRIVATE_MESSAGE') {
    const conversationKey = clean(context.conversationKey || context.conversationId || context.chatId);
    const messageId = clean(context.messageId || context.platformMessageId);
    if (conversationKey && messageId) {
      identitySource = 'PRIVATE_CONVERSATION_MESSAGE_ID';
      identityParts = [platformCode, accountId, messageType, conversationKey, messageId];
      metadata.conversationKey = conversationKey;
      metadata.messageId = messageId;
    } else if (externalId) {
      identitySource = 'EXTERNAL_ID';
    } else {
      identitySource = 'PRIVATE_SEMANTIC';
      identityParts = [platformCode, accountId, messageType, conversationKey, userName, content, normalizeCommentIdentityText(context.eventTime)];
    }
  }

  if (!platformCode || !accountId || !messageType || identityParts.every(value => !String(value || '').trim())) return null;
  return {
    identityKey: `message:${hashString(identityParts.join('|'))}`,
    identitySource,
    metadata
  };
}
