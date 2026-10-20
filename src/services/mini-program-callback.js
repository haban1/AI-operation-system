import crypto from 'node:crypto';
import { config } from '../config.js';
import { immediateTransaction, now, row, run } from '../db.js';
import { signMiniProgramRequest, validateMiniProgramCallbackUrl } from './mini-program-auth.js';
import { conversationHandlingMode } from './conversation-control.js';
import { withConversationSerial } from './conversation-store.js';

export const MINI_PROGRAM_CALLBACK_RETRY_DELAYS_MS = Object.freeze([
  5_000, 30_000, 120_000, 600_000, 3_600_000,
  21_600_000, 21_600_000, 21_600_000, 21_600_000
]);

const DEFAULT_LEASE_MS = 30_000;
const RESPONSE_READ_LIMIT_BYTES = 8 * 1024;
const RESPONSE_EXCERPT_LIMIT_CHARACTERS = 1_000;
const TRUNCATED_SENSITIVE_PREFIX_CHARACTERS = 32;
const RETRYABLE_STATUSES = new Set(['PENDING', 'RETRY_WAIT']);
const MANUALLY_RETRYABLE_STATUSES = new Set(['FAILED', 'NOT_CONFIGURED']);

let workerTimer = null;
let workerBusy = false;

function serviceError(statusCode, code, message) {
  return Object.assign(new Error(message), { statusCode, code });
}

function callbackById(id) {
  return row('SELECT * FROM mini_program_callback_outbox WHERE id=?', Number(id));
}

function ownsSendingClaim(claim, current) {
  return Boolean(claim?.claimed_at)
    && current?.status === 'SENDING'
    && Number(current.attempt_count) === Number(claim.attempt_count)
    && current.claimed_at === claim.claimed_at;
}

function futureIso(stamp, delayMs) {
  return new Date(Date.parse(stamp) + Math.max(0, Number(delayMs) || 0)).toISOString();
}

function retryDelayMs(attemptCount) {
  const index = Math.max(0, Math.min(
    MINI_PROGRAM_CALLBACK_RETRY_DELAYS_MS.length - 1,
    Number(attemptCount || 1) - 1
  ));
  return MINI_PROGRAM_CALLBACK_RETRY_DELAYS_MS[index];
}

function parseMessageContext(message) {
  try {
    return JSON.parse(message?.context_json || '{}') || {};
  } catch {
    return {};
  }
}

function normalizeCreatedAt(value) {
  const date = new Date(value || now());
  if (Number.isNaN(date.getTime())) throw new Error('小程序回调创建时间无效');
  return date.toISOString();
}

function callbackIdentity(message) {
  const context = parseMessageContext(message);
  const appId = String(context.appId || config.miniProgramAppId || '').trim();
  const conversationId = String(context.conversationId || '').trim();
  const userId = String(context.userId || message?.user_name || '').trim();
  const sourceMessageId = String(context.messageId || context.platformMessageId || '').trim();
  if (!appId || !conversationId || !userId || !sourceMessageId) {
    throw new Error('小程序消息缺少回调身份信息');
  }
  return { appId, conversationId, userId, sourceMessageId };
}

function redactSensitive(value, sensitiveValues) {
  let sanitized = String(value ?? '');
  for (const sensitive of sensitiveValues) {
    const text = String(sensitive || '');
    if (text) sanitized = sanitized.split(text).join('[REDACTED]');
  }
  return sanitized
    .replace(/\b[0-9a-f]{64}\b/gi, '[REDACTED]')
    .replace(/(x-signature\s*[:=]\s*)\S+/gi, '$1[REDACTED]');
}

function replaceSensitive(value, sensitiveValues) {
  return redactSensitive(value, sensitiveValues).slice(0, RESPONSE_EXCERPT_LIMIT_CHARACTERS);
}

function responseSensitiveRepresentations(sensitiveValues) {
  const representations = new Set();
  for (const sensitive of sensitiveValues) {
    const text = String(sensitive || '');
    if (!text) continue;
    const boundedText = text.slice(0, RESPONSE_READ_LIMIT_BYTES);
    representations.add(boundedText);
    const jsonString = JSON.stringify(boundedText);
    const completeJsonString = text.length <= RESPONSE_READ_LIMIT_BYTES
      && jsonString.length <= RESPONSE_READ_LIMIT_BYTES;
    representations.add(jsonString.slice(0, RESPONSE_READ_LIMIT_BYTES));
    representations.add(completeJsonString
      ? jsonString.slice(1, -1)
      : jsonString.slice(1, RESPONSE_READ_LIMIT_BYTES + 1));
  }
  return [...representations];
}

function replaceTruncatedSensitivePrefixes(value, sensitiveValues) {
  const original = String(value ?? '');
  let cutoff = original.length;
  for (const sensitive of sensitiveValues) {
    if (sensitive.length < TRUNCATED_SENSITIVE_PREFIX_CHARACTERS) continue;
    if (original.includes(sensitive)) continue;
    const index = original.indexOf(sensitive.slice(0, TRUNCATED_SENSITIVE_PREFIX_CHARACTERS));
    if (index !== -1) cutoff = Math.min(cutoff, index);
  }
  const captured = cutoff < original.length ? `${original.slice(0, cutoff)}[REDACTED]` : original;
  const sanitized = redactSensitive(captured, sensitiveValues);
  return sanitized.slice(0, RESPONSE_EXCERPT_LIMIT_CHARACTERS);
}

function safeFailureMessage(error, callback, extraSensitive = []) {
  let payload = {};
  try { payload = JSON.parse(callback?.payload_json || '{}') || {}; } catch {}
  const timeout = ['AbortError', 'TimeoutError'].includes(String(error?.name || ''));
  const source = timeout ? '小程序回调请求超时' : (error?.message || error || '小程序回调发送失败');
  return replaceSensitive(source, [
    config.miniProgramSharedSecret,
    config.miniProgramCallbackUrl,
    callback?.payload_json,
    payload.text,
    ...extraSensitive
  ]);
}

function safeResponseExcerpt(value, callback, signature) {
  let payload = {};
  try { payload = JSON.parse(callback?.payload_json || '{}') || {}; } catch {}
  const sensitiveValues = responseSensitiveRepresentations([
    config.miniProgramSharedSecret,
    config.miniProgramCallbackUrl,
    callback?.payload_json,
    payload.text,
    signature
  ]);
  return replaceTruncatedSensitivePrefixes(value, sensitiveValues);
}

async function readResponseExcerpt(response) {
  const reader = response?.body?.getReader?.();
  if (!reader) return '';
  const chunks = [];
  let totalBytes = 0;
  while (totalBytes < RESPONSE_READ_LIMIT_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    const bytes = Buffer.from(value);
    const remaining = RESPONSE_READ_LIMIT_BYTES - totalBytes;
    chunks.push(bytes.subarray(0, remaining));
    totalBytes += Math.min(bytes.length, remaining);
    if (bytes.length >= remaining) {
      await reader.cancel();
      break;
    }
  }
  return Buffer.concat(chunks).toString('utf8');
}

function markNotConfigured(callback) {
  const stamp = now();
  const updated = run(`UPDATE mini_program_callback_outbox
    SET status='NOT_CONFIGURED',available_at=NULL,claimed_at=NULL,lease_expires_at=NULL,
      http_status=NULL,response_excerpt=NULL,error_message=?,updated_at=?
    WHERE id=? AND status='SENDING' AND attempt_count=? AND claimed_at=?`,
  '小程序回调地址未配置', stamp, callback.id, callback.attempt_count, callback.claimed_at);
  if (updated.changes !== 1) return { ...callbackById(callback.id), delivered: false };
  return { ...callbackById(callback.id), delivered: false, notConfigured: true };
}

function markDeliveryFailure(callback, error, { httpStatus = null, responseExcerpt = null, sensitive = [] } = {}) {
  const current = callbackById(callback.id);
  if (!ownsSendingClaim(callback, current)) {
    return current ? { ...current, delivered: false } : null;
  }
  const exhausted = Number(current.attempt_count) >= Number(current.max_attempts);
  const stamp = now();
  const errorMessage = safeFailureMessage(error, current, sensitive);
  run(`UPDATE mini_program_callback_outbox
    SET status=?,available_at=?,claimed_at=NULL,lease_expires_at=NULL,http_status=?,response_excerpt=?,error_message=?,updated_at=?
    WHERE id=? AND status='SENDING' AND attempt_count=? AND claimed_at=?`,
  exhausted ? 'FAILED' : 'RETRY_WAIT',
  exhausted ? null : futureIso(stamp, retryDelayMs(current.attempt_count)),
  httpStatus === null ? null : Number(httpStatus),
  responseExcerpt === null ? null : String(responseExcerpt).slice(0, RESPONSE_EXCERPT_LIMIT_CHARACTERS),
  errorMessage,
  stamp,
  current.id,
  callback.attempt_count,
  callback.claimed_at);
  return { ...callbackById(current.id), delivered: false };
}

function cancelMiniProgramCallback(id, reason = 'CONVERSATION_HANDOFF') {
  const callback = typeof id === 'object' ? id : callbackById(id);
  if (!callback) return null;
  const stamp = now();
  const updated = run(`UPDATE mini_program_callback_outbox
    SET status='CANCELLED',available_at=NULL,claimed_at=NULL,lease_expires_at=NULL,error_message=?,updated_at=?
    WHERE id=? AND status='SENDING' AND attempt_count=? AND claimed_at=?`,
  replaceSensitive(reason, [config.miniProgramSharedSecret, config.miniProgramCallbackUrl]), stamp,
  callback.id, callback.attempt_count, callback.claimed_at);
  if (updated.changes !== 1) return { ...callbackById(callback.id), delivered: false };
  return { ...callbackById(callback.id), delivered: false, cancelled: true };
}

function claimCallbackById(id, leaseMs = DEFAULT_LEASE_MS) {
  return immediateTransaction(() => {
    const callback = callbackById(id);
    if (!callback || !RETRYABLE_STATUSES.has(callback.status)) return callback;
    const stamp = now();
    if (Date.parse(callback.available_at || callback.created_at) > Date.parse(stamp)
      || Number(callback.attempt_count) >= Number(callback.max_attempts)) return callback;
    const blocker = row(`SELECT id FROM mini_program_callback_outbox
      WHERE conversation_id=? AND id<? AND status NOT IN ('SENT','CANCELLED') LIMIT 1`,
    callback.conversation_id, callback.id);
    if (blocker) return callback;
    const claimed = run(`UPDATE mini_program_callback_outbox
      SET status='SENDING',attempt_count=attempt_count+1,claimed_at=?,lease_expires_at=?,last_attempt_at=?,updated_at=?
      WHERE id=? AND status IN ('PENDING','RETRY_WAIT')`,
    stamp, futureIso(stamp, leaseMs), stamp, stamp, callback.id);
    return claimed.changes === 1 ? callbackById(callback.id) : callbackById(callback.id);
  });
}

export function enqueueMiniProgramReply({ message, replyText, createdAt } = {}) {
  if (!message?.id) throw new Error('小程序回调消息无效');
  const text = String(replyText || '');
  if (!text) throw new Error('小程序回调回复不能为空');
  return immediateTransaction(() => {
    const storedMessage = row('SELECT * FROM messages WHERE id=?', Number(message.id));
    if (!storedMessage || storedMessage.platform_code !== 'mini_program') throw new Error('小程序回调消息不存在');
    const existing = row('SELECT * FROM mini_program_callback_outbox WHERE message_id=?', storedMessage.id);
    if (existing) return existing;

    const identity = callbackIdentity(storedMessage);
    const eventId = crypto.randomUUID();
    const callbackCreatedAt = normalizeCreatedAt(createdAt);
    const payloadJson = JSON.stringify({
      eventId,
      type: 'assistant.message',
      appId: identity.appId,
      conversationId: identity.conversationId,
      userId: identity.userId,
      inReplyToMessageId: identity.sourceMessageId,
      text,
      createdAt: callbackCreatedAt
    });
    const stamp = now();
    const inserted = run(`INSERT INTO mini_program_callback_outbox(
      event_id,app_id,conversation_id,message_id,payload_json,status,attempt_count,max_attempts,available_at,created_at,updated_at)
      VALUES(?,?,?,?,?,'PENDING',0,10,?,?,?)`,
    eventId, identity.appId, storedMessage.conversation_id, storedMessage.id, payloadJson, stamp, stamp, stamp);
    return callbackById(Number(inserted.lastInsertRowid));
  });
}

export function claimMiniProgramCallback({ leaseMs = DEFAULT_LEASE_MS } = {}) {
  return immediateTransaction(() => {
    const stamp = now();
    run(`UPDATE mini_program_callback_outbox
      SET status=CASE WHEN attempt_count>=max_attempts THEN 'FAILED' ELSE 'RETRY_WAIT' END,
        available_at=CASE WHEN attempt_count>=max_attempts THEN NULL ELSE ? END,
        claimed_at=NULL,lease_expires_at=NULL,
        error_message=CASE WHEN attempt_count>=max_attempts
          THEN COALESCE(error_message,'小程序回调发送租约已过期') ELSE error_message END,
        updated_at=?
      WHERE status='SENDING' AND lease_expires_at IS NOT NULL AND lease_expires_at<=?`, stamp, stamp, stamp);
    const candidate = row(`SELECT candidate.* FROM mini_program_callback_outbox candidate
      WHERE candidate.status IN ('PENDING','RETRY_WAIT')
        AND COALESCE(candidate.available_at,candidate.created_at)<=?
        AND candidate.attempt_count<candidate.max_attempts
        AND NOT EXISTS (
          SELECT 1 FROM mini_program_callback_outbox earlier
          WHERE earlier.conversation_id=candidate.conversation_id
            AND earlier.id<candidate.id
            AND earlier.status NOT IN ('SENT','CANCELLED')
        )
      ORDER BY COALESCE(candidate.available_at,candidate.created_at),candidate.id
      LIMIT 1`, stamp);
    if (!candidate) return null;
    const claimed = run(`UPDATE mini_program_callback_outbox
      SET status='SENDING',attempt_count=attempt_count+1,claimed_at=?,lease_expires_at=?,last_attempt_at=?,updated_at=?
      WHERE id=? AND status IN ('PENDING','RETRY_WAIT')`,
    stamp, futureIso(stamp, leaseMs), stamp, stamp, candidate.id);
    return claimed.changes === 1 ? callbackById(candidate.id) : null;
  });
}

export async function deliverMiniProgramCallback(callbackOrId, { fetchImpl = globalThis.fetch } = {}) {
  const supplied = typeof callbackOrId === 'object' ? callbackOrId : null;
  const id = supplied ? supplied.id : callbackOrId;
  let callback = callbackById(id);
  if (!callback) throw serviceError(404, 'MINI_PROGRAM_CALLBACK_NOT_FOUND', '小程序回调不存在');
  if (callback.status === 'SENT') return { ...callback, delivered: true };
  let ownedClaim = null;
  if (supplied?.status === 'SENDING') {
    if (!ownsSendingClaim(supplied, callback)) return { ...callback, delivered: false };
    ownedClaim = supplied;
  } else if (callback.status === 'SENDING' && supplied) {
    return { ...callback, delivered: false };
  } else if (callback.status !== 'SENDING') {
    callback = claimCallbackById(callback.id);
    if (callback?.status === 'SENDING') ownedClaim = callback;
  }
  if (!callback || callback.status !== 'SENDING') return { ...callback, delivered: false };

  return withConversationSerial(callback.conversation_id, async () => {
    callback = callbackById(callback.id);
    if (!callback || callback.status !== 'SENDING') return callback ? { ...callback, delivered: callback.status === 'SENT' } : null;
    if (ownedClaim && !ownsSendingClaim(ownedClaim, callback)) return { ...callback, delivered: false };
    const conversation = row('SELECT handling_mode,human_followup_state FROM conversations WHERE id=?', callback.conversation_id);
    if (!conversation || conversationHandlingMode(conversation) !== 'BOT_ACTIVE') {
      return cancelMiniProgramCallback(callback, 'CONVERSATION_HANDOFF');
    }
    if (!String(config.miniProgramCallbackUrl || '').trim()) return markNotConfigured(callback);

    let signature = '';
    try {
      const rawBody = Buffer.from(callback.payload_json, 'utf8');
      const target = validateMiniProgramCallbackUrl(config.miniProgramCallbackUrl);
      const timestamp = String(Math.floor(Date.now() / 1000));
      const nonce = crypto.randomUUID();
      signature = signMiniProgramRequest({
        method: 'POST',
        pathname: target.pathname,
        timestamp,
        nonce,
        rawBody,
        secret: config.miniProgramSharedSecret
      });
      const response = await fetchImpl(target.href, {
        method: 'POST',
        redirect: 'manual',
        headers: {
          'Content-Type': 'application/json',
          'X-Mini-App-Id': config.miniProgramAppId,
          'X-Timestamp': timestamp,
          'X-Nonce': nonce,
          'X-Signature': signature
        },
        body: rawBody,
        signal: AbortSignal.timeout(config.miniProgramCallbackTimeoutMs)
      });
      const httpStatus = Number(response.status);
      const accepted = httpStatus >= 200 && httpStatus <= 299;
      let responseExcerpt = '';
      try {
        responseExcerpt = safeResponseExcerpt(await readResponseExcerpt(response), callback, signature);
      } catch (error) {
        if (!accepted) {
          return markDeliveryFailure(callback, new Error(`小程序回调请求失败（HTTP ${httpStatus}，响应读取失败）`), {
            httpStatus,
            responseExcerpt,
            sensitive: [signature]
          });
        }
      }
      if (!accepted) {
        return markDeliveryFailure(callback, new Error(`小程序回调请求失败（HTTP ${httpStatus}）`), {
          httpStatus,
          responseExcerpt,
          sensitive: [signature]
        });
      }

      const stamp = now();
      try {
        immediateTransaction(() => {
          const updated = run(`UPDATE mini_program_callback_outbox
            SET status='SENT',available_at=NULL,claimed_at=NULL,lease_expires_at=NULL,http_status=?,response_excerpt=?,
              error_message=NULL,sent_at=?,updated_at=?
            WHERE id=? AND status='SENDING' AND attempt_count=? AND claimed_at=?`,
          httpStatus, responseExcerpt, stamp, stamp, callback.id, callback.attempt_count, callback.claimed_at);
          if (updated.changes !== 1) throw new Error('小程序回调状态已变化');
          const messageUpdated = run(`UPDATE messages
            SET status='AUTO_REPLIED',handled_at=?,handled_by='MINI_PROGRAM_CALLBACK',handler_note=?,updated_at=?
            WHERE id=?`, stamp, '小程序回调已接收', stamp, callback.message_id);
          if (messageUpdated.changes !== 1) throw new Error('小程序回调消息不存在');
        });
      } catch (error) {
        return markDeliveryFailure(callback, error, {
          httpStatus,
          responseExcerpt,
          sensitive: [signature]
        });
      }
      return { ...callbackById(callback.id), delivered: true };
    } catch (error) {
      if (error?.code === 'MINI_PROGRAM_CALLBACK_URL_INVALID') return markNotConfigured(callback);
      return markDeliveryFailure(callback, error, { sensitive: [signature] });
    }
  });
}

export async function processMiniProgramCallbackOnce(options = {}) {
  const callback = claimMiniProgramCallback(options);
  if (!callback) return null;
  return deliverMiniProgramCallback(callback, options);
}

export function requeueMiniProgramCallback(id) {
  return immediateTransaction(() => {
    const callback = callbackById(id);
    if (!callback) throw serviceError(404, 'MINI_PROGRAM_CALLBACK_NOT_FOUND', '小程序回调不存在');
    if (!MANUALLY_RETRYABLE_STATUSES.has(callback.status)) {
      throw serviceError(409, 'MINI_PROGRAM_CALLBACK_NOT_RETRYABLE', '当前小程序回调状态不可重试');
    }
    const stamp = now();
    run(`UPDATE mini_program_callback_outbox
      SET status='PENDING',max_attempts=MAX(max_attempts,attempt_count+10),available_at=?,claimed_at=NULL,
        lease_expires_at=NULL,http_status=NULL,response_excerpt=NULL,error_message=NULL,updated_at=?
      WHERE id=?`, stamp, stamp, callback.id);
    return callbackById(callback.id);
  });
}

export function startMiniProgramCallbackWorker({ intervalMs = 5_000 } = {}) {
  if (workerTimer) return workerTimer;
  const delayMs = Math.max(1_000, Number(intervalMs) || 5_000);
  workerTimer = setInterval(async () => {
    if (workerBusy) return;
    workerBusy = true;
    try { await processMiniProgramCallbackOnce(); } catch {}
    finally { workerBusy = false; }
  }, delayMs);
  workerTimer.unref?.();
  return workerTimer;
}

export function stopMiniProgramCallbackWorker() {
  if (!workerTimer) return;
  clearInterval(workerTimer);
  workerTimer = null;
}
