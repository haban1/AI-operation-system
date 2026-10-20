import { immediateTransaction, now, row, rows, run } from '../db.js';
import { getWecomWebhookUrl, redactWecomSecrets } from './settings.js';
import { confirmConversationHandoff } from './conversation-control.js';
import { NOTIFICATION_STATUS } from './operation-state.js';
import { markMiniProgramHandoffConfirmed } from './mini-program-handoff-state.js';

const DEFAULT_LEASE_MS = 30_000;
const DEFAULT_RETRY_BASE_MS = 15_000;
let workerTimer = null;
let workerBusy = false;

function safeJson(value) {
  try { return JSON.stringify(value); } catch { return null; }
}

function futureIso(ms) {
  return new Date(Date.now() + Math.max(0, Number(ms) || 0)).toISOString();
}

function retryDelayMs(attemptCount) {
  const power = Math.max(0, Math.min(8, Number(attemptCount || 1) - 1));
  return Math.min(30 * 60_000, DEFAULT_RETRY_BASE_MS * (2 ** power));
}

function notificationById(id) {
  return row('SELECT * FROM notifications WHERE id=?', Number(id));
}

function ownsSendingClaim(claim, current) {
  return Boolean(claim?.claimed_at) && current?.status === 'SENDING'
    && current.attempt_count === claim.attempt_count && current.claimed_at === claim.claimed_at;
}

function deliveryState(id) {
  const current = notificationById(id);
  const confirmed = ['CONFIRMED', 'SENT'].includes(current?.status);
  return { ...current, delivered: confirmed, confirmed };
}

export function enqueueNotification({
  type,
  title,
  content,
  channel = 'WECOM',
  conversationId = null,
  messageId = null,
  idempotencyKey = null,
  maxAttempts = 20,
  metadata = null,
  availableAt = null
} = {}) {
  if (!String(type || '').trim()) throw new Error('通知 type 不能为空');
  if (!String(title || '').trim()) throw new Error('通知 title 不能为空');
  if (!String(content || '').trim()) throw new Error('通知 content 不能为空');
  const key = String(idempotencyKey || '').trim() || null;
  const cleanMetadata = metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? { ...metadata } : null;
  if (cleanMetadata) {
    delete cleanMetadata.miniProgramHistoryConfirmedAt;
    delete cleanMetadata.miniProgramHistoryReceipt;
  }
  return immediateTransaction(() => {
    if (key) {
      const existing = row('SELECT * FROM notifications WHERE idempotency_key=?', key);
      if (existing) return { notification: existing, created: false };
    }
    const stamp = now();
    const info = run(`INSERT INTO notifications(channel,type,title,content,status,created_at,conversation_id,message_id,idempotency_key,
      attempt_count,max_attempts,available_at,updated_at,metadata_json)
      VALUES(?,?,?,?,?,?,?,?,?,0,?,?,?,?)`,
      String(channel || 'WECOM').toUpperCase(), type, title, content, NOTIFICATION_STATUS.PENDING, stamp,
      conversationId ? Number(conversationId) : null, messageId ? Number(messageId) : null, key,
      Math.max(1, Number(maxAttempts) || 20), availableAt || stamp, stamp, cleanMetadata ? safeJson(cleanMetadata) : null);
    return { notification: notificationById(Number(info.lastInsertRowid)), created: true };
  });
}

export function claimPendingNotification({ leaseMs = DEFAULT_LEASE_MS } = {}) {
  return immediateTransaction(() => {
    const stamp = now();
    run(`UPDATE notifications SET status='RETRY_WAIT',claimed_at=NULL,lease_expires_at=NULL,available_at=COALESCE(available_at,?),updated_at=?
      WHERE status='SENDING' AND lease_expires_at IS NOT NULL AND lease_expires_at<=?`, stamp, stamp, stamp);
    const candidate = row(`SELECT * FROM notifications WHERE channel='WECOM'
      AND status IN ('PENDING','RETRY_WAIT') AND COALESCE(available_at,created_at)<=?
      AND attempt_count<max_attempts ORDER BY COALESCE(available_at,created_at),id LIMIT 1`, stamp);
    if (!candidate) return null;
    const claimed = run(`UPDATE notifications SET status='SENDING',attempt_count=attempt_count+1,claimed_at=?,lease_expires_at=?,last_attempt_at=?,updated_at=?
      WHERE id=? AND status IN ('PENDING','RETRY_WAIT')`, stamp, futureIso(leaseMs), stamp, stamp, candidate.id);
    return claimed.changes === 1 ? notificationById(candidate.id) : null;
  });
}

function markDeliveryFailure(notification, error, { notConfigured = false } = {}) {
  const message = redactWecomSecrets(error?.message || String(error || '企业微信通知发送失败')).slice(0, 1000);
  const exhausted = Number(notification.attempt_count || 0) >= Number(notification.max_attempts || 20);
  const status = exhausted ? NOTIFICATION_STATUS.FAILED : NOTIFICATION_STATUS.RETRY_WAIT;
  const stamp = now();
  const updated = run(`UPDATE notifications SET status=?,error_message=?,response_json=NULL,available_at=?,claimed_at=NULL,lease_expires_at=NULL,updated_at=?
    WHERE id=? AND status='SENDING' AND attempt_count=? AND claimed_at=?`,
    status, message, exhausted ? null : futureIso(notConfigured ? 5 * 60_000 : retryDelayMs(notification.attempt_count)), stamp, notification.id,
    notification.attempt_count, notification.claimed_at);
  if (updated.changes !== 1) return deliveryState(notification.id);
  return { ...notificationById(notification.id), delivered: false, confirmed: false, notConfigured, error: message };
}

export async function deliverNotification(notificationOrId, { fetchImpl = globalThis.fetch } = {}) {
  const supplied = typeof notificationOrId === 'object' ? notificationOrId : null;
  let notification = notificationById(supplied ? supplied.id : notificationOrId);
  if (!notification) throw new Error('通知不存在');
  if (['CONFIRMED', 'SENT'].includes(String(notification.status || '').toUpperCase())) return { ...notification, delivered: true, confirmed: true };
  if (supplied?.status === 'SENDING' && !ownsSendingClaim(supplied, notification)) return deliveryState(notification.id);
  if (notification.status === 'SENDING' && !ownsSendingClaim(supplied, notification)) return deliveryState(notification.id);
  if (notification.status !== NOTIFICATION_STATUS.SENDING) {
    const stamp = now();
    const claimed = run(`UPDATE notifications SET status='SENDING',attempt_count=attempt_count+1,claimed_at=?,lease_expires_at=?,last_attempt_at=?,updated_at=?
      WHERE id=? AND status IN ('PENDING','RETRY_WAIT')`, stamp, futureIso(DEFAULT_LEASE_MS), stamp, stamp, notification.id);
    if (claimed.changes !== 1) return { ...notificationById(notification.id), delivered: false, confirmed: false };
    notification = notificationById(notification.id);
  }
  const webhook = getWecomWebhookUrl();
  if (!webhook.url) return markDeliveryFailure(notification, new Error('企业微信 Webhook 未配置'), { notConfigured: true });
  try {
    const response = await fetchImpl(webhook.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ msgtype: 'text', text: { content: `${notification.title}\n${notification.content}` } }),
      signal: AbortSignal.timeout(12_000)
    });
    const raw = await response.text();
    let result = null;
    try { result = raw ? JSON.parse(raw) : {}; } catch { throw new Error(`企业微信返回格式异常（HTTP ${response.status}）`); }
    if (!response.ok) throw new Error(`企业微信请求失败（HTTP ${response.status}）`);
    if (Number(result.errcode) !== 0) throw new Error(`企业微信发送失败：${result.errmsg || '未知错误'}（errcode ${result.errcode}）`);
    const stamp = now();
    const confirmed = immediateTransaction(() => {
      const updated = run(`UPDATE notifications SET status='CONFIRMED',sent_at=?,confirmed_at=?,response_json=?,error_message=NULL,
        claimed_at=NULL,lease_expires_at=NULL,available_at=NULL,updated_at=? WHERE id=? AND status='SENDING' AND attempt_count=? AND claimed_at=?`,
      stamp, stamp, safeJson(result), stamp, notification.id, notification.attempt_count, notification.claimed_at);
      if (updated.changes !== 1) return false;
      if (notification.message_id) {
        run(`UPDATE messages SET wecom_notification_status='SENT',wecom_notification_id=?,updated_at=? WHERE id=?`, notification.id, stamp, notification.message_id);
      }
      const metadata = (() => { try { return JSON.parse(notificationById(notification.id).metadata_json || '{}') || {}; } catch { return {}; } })();
      const conversation = notification.conversation_id && row('SELECT platform_code FROM conversations WHERE id=?', notification.conversation_id);
      if (notification.conversation_id && metadata.handoff === true) {
        confirmConversationHandoff({ conversationId: notification.conversation_id, notificationId: notification.id, confirmedAt: stamp });
      }
      if (conversation?.platform_code === 'mini_program' || metadata.miniProgram !== undefined) {
        markMiniProgramHandoffConfirmed({
          appId: metadata.miniProgram?.appId, userId: metadata.miniProgram?.userId, accountId: metadata.miniProgram?.accountId,
          conversationId: notification.conversation_id, confirmedAt: stamp, notificationId: notification.id
        });
      }
      return true;
    });
    if (!confirmed) return deliveryState(notification.id);
    return { ...notificationById(notification.id), delivered: true, confirmed: true, result };
  } catch (error) {
    return markDeliveryFailure(notification, error);
  }
}

export async function processNotificationOutboxOnce(options = {}) {
  const notification = claimPendingNotification(options);
  if (!notification) return null;
  return deliverNotification(notification, options);
}

export function requeueNotification(id) {
  return immediateTransaction(() => {
    const notification = notificationById(id);
    if (!notification) throw Object.assign(new Error('通知不存在'), { statusCode: 404, code: 'NOTIFICATION_NOT_FOUND' });
    if (!['FAILED', 'RETRY_WAIT'].includes(notification.status)) {
      throw Object.assign(new Error('当前通知状态不可重试'), { statusCode: 409, code: 'NOTIFICATION_NOT_RETRYABLE' });
    }
    const stamp = now();
    run(`UPDATE notifications SET status='PENDING',max_attempts=MAX(max_attempts,attempt_count+20),available_at=?,
      claimed_at=NULL,lease_expires_at=NULL,error_message=NULL,updated_at=? WHERE id=? AND status IN ('FAILED','RETRY_WAIT')`,
    stamp, stamp, notification.id);
    return notificationById(notification.id);
  });
}

export function listHandoffNotifications({ limit = 200 } = {}) {
  return rows(`SELECT n.id,n.created_at,n.confirmed_at,n.status AS notification_status,
      c.platform_code,COALESCE(m.user_name,c.user_name,'未知用户') AS user_name,
      COALESCE(
        json_extract(m.context_json,'$.platformUserId'),json_extract(m.context_json,'$.platform_user_id'),
        json_extract(m.context_json,'$.userId'),json_extract(m.context_json,'$.user_id'),
        json_extract(m.context_json,'$.senderId'),json_extract(m.context_json,'$.sender_id'),
        c.external_conversation_key
      ) AS user_id,
      COALESCE(json_extract(n.metadata_json,'$.reason'),c.handoff_reason,n.type) AS handoff_reason,
      COALESCE(m.content,n.content) AS conversation_content,c.handling_mode
    FROM notifications n
    LEFT JOIN conversations c ON c.id=n.conversation_id
    LEFT JOIN messages m ON m.id=n.message_id
    WHERE json_extract(COALESCE(n.metadata_json,'{}'),'$.handoff')=1
    ORDER BY n.id DESC LIMIT ?`, Math.max(1, Math.min(1000, Number(limit) || 200))).map(item => ({
      ...item,
      handoff_succeeded: String(item.notification_status || '').toUpperCase() === 'CONFIRMED'
    }));
}

export function countHandoffNotifications() {
  return Number(row(`SELECT COUNT(*) AS count
    FROM notifications
    WHERE json_extract(COALESCE(metadata_json,'{}'),'$.handoff')=1`).count || 0);
}

export function startNotificationOutboxWorker({ intervalMs = 5_000 } = {}) {
  if (workerTimer) return workerTimer;
  workerTimer = setInterval(async () => {
    if (workerBusy) return;
    workerBusy = true;
    try { await processNotificationOutboxOnce(); }
    catch (error) { console.error(`[NotificationOutbox] ${redactWecomSecrets(error?.message || String(error))}`); }
    finally { workerBusy = false; }
  }, Math.max(1_000, Number(intervalMs) || 5_000));
  workerTimer.unref?.();
  return workerTimer;
}

export function stopNotificationOutboxWorker() {
  if (!workerTimer) return;
  clearInterval(workerTimer);
  workerTimer = null;
}

// 兼容旧调用：先可靠落库，再立即尝试一次。失败记录保留在 Outbox 中由 Worker 重试。
export async function notify(input) {
  const queued = enqueueNotification(input);
  const current = queued.notification;
  if (['CONFIRMED', 'SENT'].includes(String(current.status || '').toUpperCase())) return { id: current.id, status: 'CONFIRMED', delivered: true, confirmed: true, duplicate: true };
  const delivered = await deliverNotification(current);
  if (delivered.confirmed) return { id: delivered.id, status: 'CONFIRMED', delivered: true, confirmed: true, result: delivered.result, duplicate: !queued.created };
  return {
    id: delivered.id,
    status: delivered.notConfigured ? 'NOT_CONFIGURED' : delivered.status,
    delivered: false,
    confirmed: false,
    simulated: delivered.notConfigured,
    retryScheduled: delivered.status === 'RETRY_WAIT',
    error: delivered.error,
    duplicate: !queued.created
  };
}
