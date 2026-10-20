import { immediateTransaction, row, run } from '../db.js';
import { isNotificationConfirmed } from './operation-state.js';

function objectJson(value) {
  try {
    const parsed = JSON.parse(value || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch { return {}; }
}

function latestConfirmedHistoryMatches(user) {
  const latest = row(`SELECT c.namespace,c.external_conversation_key,c.handoff_confirmed_at,c.handling_mode,
      n.status,n.confirmed_at,n.sent_at,n.metadata_json,m.context_json
    FROM conversations c JOIN notifications n ON n.id=c.handoff_notification_id
      JOIN messages m ON m.id=n.message_id
    WHERE c.id=? AND c.platform_code='mini_program' AND c.account_id=? AND c.user_name=?
      AND n.conversation_id=c.id AND m.conversation_id=c.id AND m.account_id=c.account_id
      AND m.user_name=c.user_name AND m.platform_code='mini_program'`,
  user.last_conversation_id, user.account_id, user.external_user_id);
  if (!latest) return false;
  const metadata = objectJson(latest.metadata_json);
  const identity = metadata.miniProgram;
  const context = objectJson(latest.context_json);
  return isNotificationConfirmed(latest.status) && metadata.handoff === true
    && latest.handling_mode === 'HUMAN_MANAGED' && latest.handoff_confirmed_at === user.last_handoff_at
    && (latest.confirmed_at || latest.sent_at) === user.last_handoff_at
    && identity?.appId === user.app_id && identity?.accountId === user.account_id && identity?.userId === user.external_user_id
    && identity?.conversationId === latest.external_conversation_key
    && context.serverSignatureVerified === true && context.appId === user.app_id && context.userId === user.external_user_id
    && context.conversationId === latest.external_conversation_key
    && latest.namespace === `mini-program:${user.app_id}:${latest.external_conversation_key}`;
}

export function markMiniProgramHandoffConfirmed({ appId, userId, accountId, conversationId, confirmedAt, notificationId } = {}) {
  return immediateTransaction(() => {
    const notification = row('SELECT * FROM notifications WHERE id=?', Number(notificationId));
    const conversation = row('SELECT * FROM conversations WHERE id=?', Number(conversationId));
    const source = notification && row('SELECT * FROM messages WHERE id=?', Number(notification.message_id));
    const metadata = objectJson(notification?.metadata_json);
    const identity = metadata.miniProgram;
    const context = objectJson(source?.context_json);
    const stamp = notification?.confirmed_at || notification?.sent_at;
    const valid = notification && isNotificationConfirmed(notification.status) && metadata.handoff === true
      && conversation?.platform_code === 'mini_program' && source?.platform_code === 'mini_program'
      && notification.conversation_id === conversation.id && source.conversation_id === conversation.id
      && Number.isInteger(accountId) && accountId > 0 && source.account_id === accountId && conversation.account_id === accountId
      && typeof appId === 'string' && appId.length > 0 && typeof userId === 'string' && userId.length > 0
      && identity && typeof identity === 'object' && !Array.isArray(identity)
      && identity.appId === appId && identity.userId === userId && identity.accountId === accountId
      && identity.conversationId === conversation.external_conversation_key
      && context.appId === appId && context.userId === userId && context.serverSignatureVerified === true
      && context.conversationId === conversation.external_conversation_key && source.user_name === userId && conversation.user_name === userId
      && conversation.namespace === `mini-program:${appId}:${context.conversationId}`
      && stamp === confirmedAt && Number.isFinite(Date.parse(stamp));
    if (!valid) throw Object.assign(new Error('小程序转人工确认身份无效'), { code: 'MINI_PROGRAM_HANDOFF_IDENTITY_INVALID' });
    const user = row('SELECT * FROM mini_program_users WHERE app_id=? AND account_id=? AND external_user_id=?', appId, accountId, userId);
    if (!user) throw new Error('小程序转人工用户不存在');
    const existingReceipt = metadata.miniProgramHistoryReceipt;
    const validReceipt = existingReceipt && typeof existingReceipt === 'object' && !Array.isArray(existingReceipt)
      && Object.keys(existingReceipt).length === 7
      && existingReceipt.notificationId === notification.id && existingReceipt.confirmedAt === stamp
      && existingReceipt.appId === appId && existingReceipt.accountId === accountId && existingReceipt.userId === userId
      && existingReceipt.conversationId === conversation.id
      && Number.isInteger(existingReceipt.handoffCount) && existingReceipt.handoffCount > 0
      && user.handoff_count >= existingReceipt.handoffCount && Number.isFinite(Date.parse(user.first_handoff_at))
      && Date.parse(user.last_handoff_at) >= Date.parse(stamp)
      && (user.handoff_count > existingReceipt.handoffCount || user.last_handoff_at > stamp || user.last_conversation_id === conversation.id
        || (user.last_handoff_at === stamp && user.handoff_count > 1 && latestConfirmedHistoryMatches(user)));
    if (validReceipt) return user;
    const legacyReceipt = !Object.hasOwn(metadata, 'miniProgramHistoryReceipt')
      && typeof metadata.miniProgramHistoryConfirmedAt === 'string' && metadata.miniProgramHistoryConfirmedAt === stamp
      && Number.isInteger(user.handoff_count) && user.handoff_count > 0
      && Number.isFinite(Date.parse(user.first_handoff_at)) && Date.parse(user.first_handoff_at) <= Date.parse(stamp)
      && Date.parse(user.last_handoff_at) >= Date.parse(stamp)
      && conversation.handling_mode === 'HUMAN_MANAGED' && conversation.handoff_notification_id === notification.id
      && conversation.handoff_confirmed_at === stamp && source.wecom_notification_id === notification.id && source.wecom_notification_status === 'SENT'
      && ((user.last_handoff_at === stamp && user.last_conversation_id === conversation.id)
        || (user.handoff_count > 1 && latestConfirmedHistoryMatches(user)));
    // Upgrade proven timestamp-only receipts; otherwise count this confirmation without replacing newer history.
    if (!legacyReceipt) {
      const updated = run(`UPDATE mini_program_users SET first_handoff_at=COALESCE(first_handoff_at,?),
        last_conversation_id=CASE WHEN last_handoff_at IS NULL OR last_handoff_at<=? THEN ? ELSE last_conversation_id END,
        last_handoff_at=CASE WHEN last_handoff_at IS NULL OR last_handoff_at<? THEN ? ELSE last_handoff_at END,
        handoff_count=handoff_count+1,updated_at=MAX(updated_at,?) WHERE id=?`,
      stamp, stamp, conversation.id, stamp, stamp, stamp, user.id);
      if (updated.changes !== 1) throw new Error('小程序转人工历史更新失败');
    }
    const receipt = run('UPDATE notifications SET metadata_json=? WHERE id=?', JSON.stringify({
      ...metadata, miniProgramHistoryConfirmedAt: stamp,
      miniProgramHistoryReceipt: { notificationId: notification.id, confirmedAt: stamp, appId, accountId, userId, conversationId: conversation.id, handoffCount: user.handoff_count + (legacyReceipt ? 0 : 1) }
    }), notification.id);
    if (receipt.changes !== 1) throw new Error('小程序转人工历史回执更新失败');
    return row('SELECT * FROM mini_program_users WHERE id=?', user.id);
  });
}
