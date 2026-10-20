import crypto from 'node:crypto';
import { isGreetingOnlyMessage } from './conversation-intent.js';
import { resolveVerifiedWeiboCommentTarget } from './weibo-comment-target.js';

export const AUTO_REPLY_ELIGIBILITY_VERSION = 'auto-reply-eligibility-2026.08.24.2';

const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();
const truthy = value => value === true || String(value ?? '').trim().toLowerCase() === 'true';
const first = (...values) => values.map(clean).find(Boolean) || '';
const hash = value => crypto.createHash('sha256').update(clean(value), 'utf8').digest('hex');

function denied(reason, detail = {}) {
  return {
    allowed: false,
    status: 'NEEDS_CONFIRMATION',
    aiDirectSendAllowed: false,
    retryable: false,
    reason,
    version: AUTO_REPLY_ELIGIBILITY_VERSION,
    detail
  };
}

function allowed(target, detail = {}) {
  return {
    allowed: true,
    status: 'ELIGIBLE',
    aiDirectSendAllowed: false,
    retryable: false,
    reason: 'DETERMINISTIC_TARGET_VERIFIED',
    version: AUTO_REPLY_ELIGIBILITY_VERSION,
    target,
    detail
  };
}

export function assessAutoReplyEligibility(input = {}, { phase = 'creation' } = {}) {
  if (String(input.replyMode || '').toUpperCase() === 'MANUAL') {
    return allowed({ kind: 'MANUAL_OPERATOR_ACTION' }, { phase, deterministicAutoGateApplied: false });
  }
  const context = input.messageContext && typeof input.messageContext === 'object'
    ? input.messageContext
    : input.context && typeof input.context === 'object' ? input.context : {};
  const platformCode = clean(input.platformCode || input.platform_code);
  const accountId = clean(input.accountId || input.account_id);
  const messageType = clean(input.messageType || input.message_type).toUpperCase();
  const sourceContent = clean(input.sourceContent || input.content);
  const userName = clean(input.userName || input.user_name);
  if (!platformCode) return denied('PLATFORM_ID_REQUIRED', { phase });
  if (!accountId) return denied('ACCOUNT_ID_REQUIRED', { phase });
  if (!sourceContent) return denied('FULL_SOURCE_TEXT_REQUIRED', { phase });
  if (!userName && !first(context.authorId, context.senderId, context.userId, context.actorUserId)) return denied('SENDER_IDENTITY_REQUIRED', { phase });
  if (context.sourceTextHash && clean(context.sourceTextHash).toLowerCase() !== hash(sourceContent)) return denied('SOURCE_TEXT_HASH_MISMATCH', { phase });
  if (context.candidateCount != null && Number(context.candidateCount) !== 1) return denied('TARGET_NOT_UNIQUE', { phase, candidateCount: Number(context.candidateCount) });
  if (truthy(context.targetChangedAfterLocate) || context.domStable === false) return denied('TARGET_DOM_CHANGED', { phase });
  if (context.editorBoundToTarget === false) return denied('EDITOR_NOT_BOUND_TO_TARGET', { phase });
  if (truthy(context.captcha) || truthy(context.securityChallenge) || truthy(context.pageError) || truthy(context.abnormalRedirect)) return denied('PAGE_SECURITY_OR_ERROR_STATE', { phase });

  if (messageType === 'COMMENT') {
    const commentId = first(input.commentId, context.commentId, context.commentStableId, context.cid);
    let postId = first(input.postId, context.postId, context.noteId, context.videoId, context.awemeId, context.itemId, context.sourceVideoKey, context.sourcePostId);
    let targetEvidence = postId ? 'MESSAGE_CONTEXT' : '';
    // 微博评论采集页本身会给出 https://weibo.com/{uid}/{postId}?cid={commentId}。
    // 仅在来源已核验、域名/路径严格匹配、且 URL 中 cid 与消息 commentId 完全一致时，
    // 才允许用该 URL 补回作品 ID；其他平台和未验证链接仍保持原安全门槛。
    if (!postId && platformCode.toLowerCase() === 'weibo') {
      const verifiedTarget = resolveVerifiedWeiboCommentTarget({ ...input, platformCode, messageType, messageContext: context, commentId });
      if (verifiedTarget.ok) {
        postId = verifiedTarget.postId;
        targetEvidence = verifiedTarget.evidence;
      }
    }
    if (!postId) return denied('STABLE_POST_ID_REQUIRED', { phase });
    if (!commentId) return denied('STABLE_COMMENT_ID_REQUIRED', { phase });
    if (!truthy(context.sourceVerified)) return denied('SOURCE_PAGE_NOT_VERIFIED', { phase });
    const contentOwnership = input.contentOwnership && typeof input.contentOwnership === 'object' ? input.contentOwnership : null;
    if (platformCode.toLowerCase() === 'bilibili' && contentOwnership?.verified !== true) {
      return denied('COMMENT_CONTENT_NOT_MANAGED', { phase, ownershipReason: contentOwnership?.reason || 'OWNERSHIP_EVIDENCE_REQUIRED' });
    }
    return allowed({ kind: 'COMMENT', platformCode, accountId, postId, commentId, sourceTextHash: hash(sourceContent) }, { phase, targetEvidence, contentOwnership });
  }

  if (messageType === 'PRIVATE_MESSAGE') {
    if (platformCode === 'mini_program') {
      const appId = first(context.appId);
      const conversationId = first(context.conversationId);
      const messageId = first(context.messageId);
      const userId = first(context.userId);
      if (!truthy(context.serverSignatureVerified)) return denied('SERVER_SIGNATURE_NOT_VERIFIED', { phase });
      if (!appId || !conversationId || !messageId || !userId) return denied('SERVER_MESSAGE_IDENTITY_REQUIRED', { phase });
      if (clean(context.direction).toLowerCase() !== 'incoming') return denied('INCOMING_DIRECTION_REQUIRED', { phase });
      return allowed({ kind: 'SERVER_CALLBACK', platformCode, accountId, appId, conversationId, messageId, userId }, { phase });
    }
    const conversationId = first(input.conversationId, context.conversationId, context.conversationKey);
    const messageId = first(input.platformMessageId, context.messageId);
    if (!messageId) return denied('STABLE_MESSAGE_ID_REQUIRED', { phase });
    if (clean(context.direction).toLowerCase() !== 'incoming') return denied('INCOMING_DIRECTION_REQUIRED', { phase });
    if (truthy(context.previewOnly) || context.fullSource === false) return denied('SIDEBAR_PREVIEW_NOT_SENDABLE', { phase });
    if (!truthy(context.sourceVerified)) return denied('FULL_MESSAGE_SOURCE_NOT_VERIFIED', { phase });
    if (!truthy(context.chatTitleVerified)) return denied('CONVERSATION_TITLE_NOT_VERIFIED', { phase });
    // 纯问候不需要依赖历史上下文来判断意图，但发送前仍必须具备：
    // 完整原文、消息 ID、来向、已验证会话标题和唯一页面目标。
    // 这样可以解决抖音偶尔拿不到会话 ID时“哈喽/你好呀”被无意义转人工，
    // 同时不会把普通业务问题的会话串线风险放开。
    const greetingOnly = isGreetingOnlyMessage(sourceContent);
    if (!conversationId && !greetingOnly) return denied('STABLE_CONVERSATION_ID_REQUIRED', { phase });
    if (!conversationId) {
      return allowed({ kind: 'PRIVATE_MESSAGE_GREETING', platformCode, accountId, conversationId: null, messageId, sourceTextHash: hash(sourceContent) }, {
        phase,
        greetingOnly: true,
        conversationIdentity: 'VERIFIED_NAME_AND_SOURCE_PREVIEW'
      });
    }
    return allowed({ kind: 'PRIVATE_MESSAGE', platformCode, accountId, messageType, conversationId, messageId, sourceTextHash: hash(sourceContent) }, { phase });
  }

  return denied('UNSUPPORTED_MESSAGE_TYPE', { phase, messageType });
}
