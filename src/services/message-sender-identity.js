const SELF_DIRECTIONS = new Set(['OUTGOING', 'OUTBOUND', 'SENT', 'SELF', 'OWN']);
const SELF_ROLES = new Set(['SELF', 'OWNER', 'AUTHOR', 'CREATOR', 'UP主', '博主', '作者', '主号', '自己', '本人']);

function firstValue(...values) {
  for (const value of values.flat()) {
    if (value === null || value === undefined) continue;
    const text = String(value).trim();
    if (text) return text;
  }
  return '';
}

export function normalizeIdentityValue(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLocaleLowerCase('zh-CN');
}

export function normalizeEchoContent(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseJson(value, fallback = {}) {
  if (!value) return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

function actorPlatformId(data, context) {
  return firstValue(
    context.actorPlatformId,
    context.actorUserId,
    context.actorUid,
    context.actorMid,
    context.senderPlatformId,
    context.senderUid,
    data.actorPlatformId
  );
}

function accountPlatformId(data, context, account) {
  const identity = data.accountIdentity || context.accountIdentity || {};
  return firstValue(
    context.accountPlatformId,
    context.selfPlatformId,
    context.selfUid,
    identity.platformUserId,
    identity.userId,
    account?.platform_user_id
  );
}

function scopeEntries(type, data, context) {
  const values = [];
  const add = (key, value) => {
    const normalized = normalizeIdentityValue(value);
    if (normalized) values.push(`${key}:${normalized}`);
  };
  if (type === 'COMMENT') {
    add('parentExternalId', data.parentExternalId ?? data.parent_external_id);
    add('sourceVideoKey', context.sourceVideoKey);
    add('sourcePostKey', context.sourcePostKey);
    add('oid', context.oid);
    add('subjectId', context.subjectId ?? context.subject_id);
    add('postId', context.postId ?? context.noteId ?? context.awemeId);
  } else if (type === 'PRIVATE_MESSAGE') {
    add('conversationKey', context.conversationKey);
    add('conversationId', context.conversationId);
    add('talkerId', context.talkerId);
    add('peerUid', context.peerUid);
  }
  return new Set(values);
}

function scopesMatch(type, data, context, outgoing) {
  const outgoingContext = parseJson(outgoing.context_json ?? outgoing.context, {});
  const incomingScope = scopeEntries(type, data, context);
  const outgoingScope = scopeEntries(type, {
    parentExternalId: outgoing.parent_external_id ?? outgoing.parentExternalId
  }, outgoingContext);
  if (!incomingScope.size || !outgoingScope.size) return false;
  return [...incomingScope].some(value => outgoingScope.has(value));
}

function outgoingPrecedesCollection(outgoing, collectedAt) {
  const sentAt = Date.parse(firstValue(outgoing.handled_at, outgoing.updated_at, outgoing.created_at));
  const observedAt = Date.parse(collectedAt);
  if (!Number.isFinite(sentAt) || !Number.isFinite(observedAt)) return true;
  return sentAt <= observedAt && observedAt - sentAt <= 14 * 24 * 60 * 60 * 1000;
}

function explicitSelfEvidence(context) {
  if (context.actorIsSelf === true || context.isSelf === true || context.isOwnMessage === true) return '平台明确标记 actorIsSelf=true';
  const direction = normalizeIdentityValue(firstValue(context.direction, context.messageDirection, context.flowDirection)).toUpperCase();
  if (SELF_DIRECTIONS.has(direction)) return `平台方向标记为 ${direction}`;
  const role = normalizeIdentityValue(firstValue(context.actorRole, context.role, context.authorRole));
  if (SELF_ROLES.has(role) || SELF_ROLES.has(role.toUpperCase())) return `平台角色标记为 ${firstValue(context.actorRole, context.role, context.authorRole)}`;
  const badge = normalizeIdentityValue(firstValue(context.actorBadge, context.badgeText, context.identityBadge));
  if (/^(作者|博主|up主|自己|本人|主号)$/.test(badge)) return `平台身份徽标为 ${badge}`;
  return '';
}

export function assessCollectedMessageIdentity({ data = {}, account = {}, recentOutgoingReplies = [], collectedAt = new Date().toISOString() } = {}) {
  const context = parseJson(data.context, {});
  const explicit = explicitSelfEvidence(context);
  if (explicit) return { isSelf: true, classification: 'SELF', evidence: 'EXPLICIT_PLATFORM_MARKER', reason: explicit };

  const actorId = normalizeIdentityValue(actorPlatformId(data, context));
  const ownId = normalizeIdentityValue(accountPlatformId(data, context, account));
  if (actorId && ownId) {
    if (actorId === ownId) {
      return { isSelf: true, classification: 'SELF', evidence: 'PLATFORM_USER_ID_MATCH', reason: `发言者平台ID与当前账号ID一致（${actorId}）` };
    }
    return { isSelf: false, classification: 'AUDIENCE', evidence: 'PLATFORM_USER_ID_CONFLICT', reason: '发言者平台ID与当前账号ID不同，稳定ID优先于昵称' };
  }

  const identity = data.accountIdentity || context.accountIdentity || {};
  const actorName = normalizeIdentityValue(firstValue(context.actorUserName, context.senderUserName, data.userName));
  // A previous login's nickname is not evidence of the current account's identity.
  const ownName = normalizeIdentityValue(firstValue(
    context.accountUserName,
    context.selfUserName,
    identity.platformUserName,
    identity.userName,
    account.platform_user_name
  ));
  if (actorName && actorName === ownName) {
    return { isSelf: true, classification: 'SELF', evidence: 'EXACT_ACCOUNT_NAME_MATCH', reason: `发言者昵称与当前登录账号昵称精确一致（${firstValue(context.actorUserName, data.userName)}）` };
  }

  const type = String(data.messageType || data.message_type || 'COMMENT').toUpperCase();
  const content = normalizeEchoContent(data.content);
  if (content) {
    const echo = recentOutgoingReplies.find(outgoing => normalizeEchoContent(outgoing.reply_text ?? outgoing.replyText) === content
      && String((outgoing.message_type ?? outgoing.messageType) || type).toUpperCase() === type
      && outgoingPrecedesCollection(outgoing, collectedAt)
      && scopesMatch(type, data, context, outgoing));
    if (echo) {
      return {
        isSelf: true,
        classification: 'SELF',
        evidence: 'RECENT_OUTGOING_REPLY_ECHO',
        matchedMessageId: Number(echo.id) || null,
        reason: `内容与同账号、同消息范围内近期已发送回复一致${echo.id ? `（消息#${echo.id}）` : ''}`
      };
    }
  }

  return { isSelf: false, classification: 'AUDIENCE', evidence: 'NO_SELF_EVIDENCE', reason: '未发现可靠的主号身份或出站回声证据' };
}

