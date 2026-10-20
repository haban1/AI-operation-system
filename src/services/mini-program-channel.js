import { immediateTransaction, now, row, run } from '../db.js';
import {
  beginConversationHandoff,
  confirmConversationHandoff,
  conversationHandlingMode,
  markHumanFollowupMessage
} from './conversation-control.js';
import { enqueueNotification } from './notification.js';
import { markMiniProgramHandoffConfirmed } from './mini-program-handoff-state.js';
import { miniProgramProcessingTransaction } from './mini-program-processing-context.js';
import { CONVERSATION_HANDLING_MODE, isNotificationConfirmed } from './operation-state.js';

export const MINI_PROGRAM_PLATFORM_CODE = 'mini_program';

const MINI_PROGRAM_ACCOUNT_PROFILE = 'mini-program-api-main';
const MINI_PROGRAM_MESSAGE_TYPE = 'PRIVATE_MESSAGE';

function acceptedResult(messageId, { duplicate = false } = {}) {
  return { accepted: true, messageId, status: 'ACCEPTED', duplicate };
}

function terminalResult(messageId) {
  return { accepted: true, messageId, status: 'IGNORED_HANDOFF_COMPLETED', duplicate: false };
}

function conversationNamespace({ appId, conversationId }) {
  return `mini-program:${appId}:${conversationId}`;
}

function messageExternalId({ appId, messageId }) {
  return `mini-program:${appId}:message:${messageId}`;
}

function conversationUserMismatch() {
  return Object.assign(new Error('会话已绑定其他用户'), {
    statusCode: 409,
    code: 'CONVERSATION_USER_MISMATCH'
  });
}

function parseContext(message) {
  if (!message || typeof message !== 'object') return {};
  if (message.context_json && typeof message.context_json === 'string') {
    try { return JSON.parse(message.context_json) || {}; } catch { return {}; }
  }
  return message;
}

function parseNotificationMetadata(notification) {
  try { return JSON.parse(notification?.metadata_json || '{}') || {}; } catch { return {}; }
}

function formatReceivedAt(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value || '-');
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(date).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

function reconcileExistingHandoff(conversation, notification) {
  const sourceMessage = row('SELECT * FROM messages WHERE id=? AND conversation_id=?',
    Number(notification.message_id), conversation.id);
  if (!sourceMessage) throw new Error('小程序转人工消息不存在');

  const metadata = parseNotificationMetadata(notification);
  const originalReason = String(metadata.reason || sourceMessage.reason || conversation.handoff_reason || '用户请求转人工')
    .trim().slice(0, 1000) || '用户请求转人工';
  const confirmed = isNotificationConfirmed(notification.status);
  const currentMode = conversationHandlingMode(conversation);
  const modeNeedsRepair = confirmed
    ? currentMode !== CONVERSATION_HANDLING_MODE.HUMAN_MANAGED
    : currentMode === CONVERSATION_HANDLING_MODE.BOT_ACTIVE;
  const conversationNeedsRepair = modeNeedsRepair
    || conversation.human_followup_state !== 'WAITING'
    || conversation.handoff_reason !== originalReason
    || Number(conversation.handoff_source_message_id) !== sourceMessage.id
    || (confirmed && Number(conversation.handoff_notification_id) !== notification.id);

  if (conversationNeedsRepair) {
    beginConversationHandoff({
      conversationId: conversation.id,
      messageId: sourceMessage.id,
      reason: originalReason
    });
    run(`UPDATE conversations SET human_followup_state='WAITING',handoff_reason=?,handoff_source_message_id=?,updated_at=? WHERE id=?`,
      originalReason, sourceMessage.id, now(), conversation.id);
    if (confirmed) {
      confirmConversationHandoff({
        conversationId: conversation.id,
        notificationId: notification.id,
        confirmedAt: notification.confirmed_at || notification.sent_at || notification.created_at
      });
    }
  }

  const expectedDecision = confirmed ? 'HUMAN_FOLLOWUP_NOTIFIED' : 'HUMAN_FOLLOWUP_NOTIFICATION_PENDING';
  const expectedNotificationStatus = confirmed ? 'SENT' : 'PENDING';
  const messageNeedsRepair = sourceMessage.status !== 'MANUAL_REQUIRED'
    || sourceMessage.decision !== expectedDecision
    || sourceMessage.reason !== originalReason
    || sourceMessage.wecom_notification_status !== expectedNotificationStatus
    || Number(sourceMessage.wecom_notification_id) !== notification.id;
  if (messageNeedsRepair) {
    markHumanFollowupMessage(sourceMessage.id, {
      notificationId: notification.id,
      confirmed,
      reason: originalReason
    });
  }

  if (confirmed) markMiniProgramHandoffConfirmed({
    ...metadata.miniProgram,
    conversationId: conversation.id,
    confirmedAt: notification.confirmed_at || notification.sent_at,
    notificationId: notification.id
  });
  return row('SELECT * FROM conversations WHERE id=?', conversation.id);
}

export function miniProgramAccount() {
  const account = row(`SELECT a.* FROM mini_program_channel_identity i
    JOIN accounts a ON a.id=i.account_id
    WHERE i.id=1 AND a.platform_code=? AND a.profile_name=?`, MINI_PROGRAM_PLATFORM_CODE, MINI_PROGRAM_ACCOUNT_PROFILE);
  if (!account) {
    throw Object.assign(new Error('小程序渠道账号不可用'), {
      statusCode: 503,
      code: 'MINI_PROGRAM_ACCOUNT_UNAVAILABLE'
    });
  }
  return account;
}

export function miniProgramContext(message) {
  const source = parseContext(message);
  const appId = source.appId;
  const externalConversationId = source.conversationId;
  const platformMessageId = source.messageId || source.platformMessageId;
  const userId = source.userId || message?.user_name;
  const sentAt = source.sentAt || message?.created_at;
  return {
    transport: 'MINI_PROGRAM',
    appId,
    conversationId: externalConversationId,
    conversationKey: `mini-program:${appId}:${externalConversationId}`,
    messageId: platformMessageId,
    platformMessageId,
    userId,
    sentAt,
    direction: 'incoming',
    sourceVerified: true,
    serverSignatureVerified: true,
    fullSource: true,
    previewOnly: false,
    chatTitleVerified: true,
    candidateCount: 1
  };
}

export function requestMiniProgramHandoff({
  conversationId,
  messageId = null,
  reason = '用户请求转人工',
  type = 'MINI_PROGRAM_HANDOFF',
  notificationDetails = null
} = {}) {
  const numericConversationId = Number(conversationId);
  if (!Number.isInteger(numericConversationId) || numericConversationId <= 0) {
    throw new Error('conversationId 无效');
  }
  return miniProgramProcessingTransaction(() => {
    const conversation = row('SELECT * FROM conversations WHERE id=?', numericConversationId);
    if (!conversation || conversation.platform_code !== MINI_PROGRAM_PLATFORM_CODE) throw new Error('小程序会话不存在');
    const idempotencyKey = `wecom:mini-program:handoff:conversation:${numericConversationId}`;
    const existingNotification = row('SELECT * FROM notifications WHERE idempotency_key=?', idempotencyKey);
    if (existingNotification) {
      return {
        conversation: reconcileExistingHandoff(conversation, existingNotification),
        notification: existingNotification,
        created: false
      };
    }
    const sourceMessage = messageId
      ? row('SELECT * FROM messages WHERE id=? AND conversation_id=?', Number(messageId), numericConversationId)
      : row('SELECT * FROM messages WHERE id=? AND conversation_id=?', conversation.last_incoming_message_id, numericConversationId);
    if (!sourceMessage) throw new Error('小程序转人工消息不存在');

    const context = miniProgramContext(sourceMessage);
    const normalizedReason = String(reason || '用户请求转人工').trim().slice(0, 1000) || '用户请求转人工';
    beginConversationHandoff({
      conversationId: numericConversationId,
      messageId: sourceMessage.id,
      reason: normalizedReason
    });
    const queued = enqueueNotification({
      type: String(type || 'MINI_PROGRAM_HANDOFF').trim() || 'MINI_PROGRAM_HANDOFF',
      title: notificationDetails?.title || `【小程序·私信】${context.userId}需要转人工`,
      content: notificationDetails?.content || [
        `用户 ID：${context.userId}`,
        `会话 ID：${context.conversationId}`,
        `消息内容：“${sourceMessage.content}”`,
        `收到时间：${formatReceivedAt(sourceMessage.collected_at || sourceMessage.created_at)}`,
        `转人工原因：${normalizedReason}`,
        '处理要求：请在小程序客服系统中继续对接。'
      ].join('\n'),
      conversationId: numericConversationId,
      messageId: sourceMessage.id,
      idempotencyKey,
      metadata: {
        ...notificationDetails?.metadata,
        handoff: true,
        reason: normalizedReason,
        miniProgram: {
          appId: context.appId,
          userId: context.userId,
          accountId: Number(sourceMessage.account_id),
          conversationId: context.conversationId
        }
      }
    });
    markHumanFollowupMessage(sourceMessage.id, {
      notificationId: queued.notification.id,
      reason: normalizedReason
    });
    return {
      conversation: row('SELECT * FROM conversations WHERE id=?', numericConversationId),
      notification: queued.notification,
      created: queued.created
    };
  });
}

export function ingestMiniProgramMessage(payload) {
  return immediateTransaction(() => {
    const account = miniProgramAccount();
    const externalId = messageExternalId(payload);
    const duplicate = row('SELECT id FROM messages WHERE external_id=?', externalId);
    if (duplicate) return acceptedResult(payload.messageId, { duplicate: true });

    const namespace = conversationNamespace(payload);
    let conversation = row('SELECT * FROM conversations WHERE namespace=?', namespace);
    if (conversation && String(conversation.user_name || '') !== payload.userId) throw conversationUserMismatch();
    if (conversationHandlingMode(conversation) === CONVERSATION_HANDLING_MODE.HUMAN_MANAGED) {
      return terminalResult(payload.messageId);
    }

    const stamp = now();
    const existingUser = row(`SELECT * FROM mini_program_users
      WHERE app_id=? AND account_id=? AND external_user_id=?`, payload.appId, account.id, payload.userId);
    const historicalUser = Boolean(existingUser?.first_handoff_at);
    run(`INSERT INTO mini_program_users(app_id,account_id,external_user_id,created_at,updated_at)
      VALUES(?,?,?,?,?)
      ON CONFLICT(account_id,external_user_id) DO UPDATE SET app_id=excluded.app_id,updated_at=excluded.updated_at`,
    payload.appId, account.id, payload.userId, stamp, stamp);

    const isNewConversation = !conversation;
    if (!conversation) {
      const inserted = run(`INSERT INTO conversations(namespace,platform_code,account_id,message_type,external_conversation_key,user_name,
        identity_confidence,identity_source,entry_type,context_enabled,version,ledger_version,last_message_at,created_at,updated_at,
        handling_mode,human_followup_state)
        VALUES(?,?,?,?,?,?,'HIGH','MINI_PROGRAM_VERIFIED','PLATFORM_ID',1,0,0,?,?,?,'BOT_ACTIVE','NONE')`,
      namespace, MINI_PROGRAM_PLATFORM_CODE, account.id, MINI_PROGRAM_MESSAGE_TYPE, payload.conversationId, payload.userId,
      payload.sentAt, stamp, stamp);
      conversation = row('SELECT * FROM conversations WHERE id=?', Number(inserted.lastInsertRowid));
    }

    const insertedMessage = run(`INSERT INTO messages(platform_code,account_id,message_type,external_id,user_name,content,status,
      context_json,collected_at,conversation_id,conversation_key_snapshot,identity_confidence,identity_source,created_at,updated_at)
      VALUES(?,?,?,?,?,?,'NEW',?,?,?,?,?,'MINI_PROGRAM_VERIFIED',?,?)`,
    MINI_PROGRAM_PLATFORM_CODE, account.id, MINI_PROGRAM_MESSAGE_TYPE, externalId, payload.userId, payload.text,
    JSON.stringify(miniProgramContext(payload)), stamp, conversation.id, namespace, 'HIGH', stamp, stamp);
    const messageId = Number(insertedMessage.lastInsertRowid);

    const changed = run(`UPDATE conversations SET version=version+1,ledger_version=ledger_version+1,
      last_incoming_message_id=?,last_message_at=?,updated_at=? WHERE id=?`,
    messageId, payload.sentAt, stamp, conversation.id);
    if (changed.changes !== 1) throw new Error('更新小程序会话版本失败');
    conversation = row('SELECT * FROM conversations WHERE id=?', conversation.id);
    run(`UPDATE messages SET conversation_version=?,updated_at=? WHERE id=?`,
      Number(conversation.ledger_version), stamp, messageId);
    if (conversationHandlingMode(conversation) === CONVERSATION_HANDLING_MODE.HANDOFF_PENDING) {
      return acceptedResult(payload.messageId);
    }
    if (isNewConversation && historicalUser) {
      requestMiniProgramHandoff({
        conversationId: conversation.id,
        messageId,
        reason: '历史人工用户再次咨询',
        type: 'MINI_PROGRAM_HISTORICAL_USER_HANDOFF'
      });
      return acceptedResult(payload.messageId);
    }

    run(`INSERT INTO mini_program_processing_jobs(message_id,conversation_id,status,available_at,created_at,updated_at)
      VALUES(?,?,'PENDING',?,?,?)`, messageId, conversation.id, stamp, stamp, stamp);
    return acceptedResult(payload.messageId);
  });
}
