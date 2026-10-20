import crypto from 'node:crypto';
import { run } from '../db.js';

export const MINI_PROGRAM_MESSAGE_PATH = '/open-api/v1/mini-program/messages';
export const MINI_PROGRAM_BODY_MAX_BYTES = 32 * 1024;
export const MINI_PROGRAM_CLOCK_SKEW_SECONDS = 300;
export const MINI_PROGRAM_NONCE_TTL_MS = 10 * 60_000;

const MESSAGE_FIELDS = Object.freeze([
  'appId',
  'conversationId',
  'messageId',
  'userId',
  'text',
  'sentAt'
]);
const HEADER_TIMESTAMP_MAX_CHARACTERS = 16;
const HEADER_VALUE_MAX_CHARACTERS = 128;
const MINIMUM_SECRET_CHARACTERS = 32;

let nonceCleanupTimer = null;

function serviceError(statusCode, code, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function authInvalid() {
  return serviceError(401, 'MINI_PROGRAM_AUTH_INVALID', '小程序请求鉴权信息无效');
}

function configurationIncomplete() {
  return serviceError(503, 'MINI_PROGRAM_CONFIGURATION_INCOMPLETE', '小程序接口配置不完整');
}

function codePointLength(value) {
  return Array.from(value).length;
}

function normalizeId(value) {
  return value.trim().normalize('NFC');
}

function validBoundedId(value, { boundRaw = false } = {}) {
  if (typeof value !== 'string') return false;
  const normalizedLength = codePointLength(normalizeId(value));
  return (!boundRaw || codePointLength(value) <= HEADER_VALUE_MAX_CHARACTERS)
    && normalizedLength >= 1
    && normalizedLength <= HEADER_VALUE_MAX_CHARACTERS;
}

function requireRawBody(rawBody) {
  if (!Buffer.isBuffer(rawBody)) {
    throw serviceError(400, 'MINI_PROGRAM_RAW_BODY_INVALID', '小程序请求体必须保留原始字节');
  }
  return rawBody;
}

function requireCompleteConfiguration(appId, secret) {
  if (!validBoundedId(appId)
    || typeof secret !== 'string'
    || codePointLength(secret) < MINIMUM_SECRET_CHARACTERS) {
    throw configurationIncomplete();
  }
  return { appId: normalizeId(appId), secret };
}

function headerValue(headers, name) {
  if (!headers || typeof headers !== 'object') throw authInvalid();
  let value;
  if (typeof headers.get === 'function') {
    value = headers.get(name);
  } else {
    const matches = Object.entries(headers)
      .filter(([key]) => String(key).toLowerCase() === name.toLowerCase())
      .map(([, item]) => item);
    if (matches.length !== 1) throw authInvalid();
    [value] = matches;
  }
  if (typeof value !== 'string') throw authInvalid();
  return value;
}

function validatedHeaders(headers) {
  const suppliedAppId = headerValue(headers, 'x-mini-app-id');
  const timestamp = headerValue(headers, 'x-timestamp');
  const nonce = headerValue(headers, 'x-nonce');
  const signature = headerValue(headers, 'x-signature');

  if (!validBoundedId(suppliedAppId, { boundRaw: true })
    || !/^\d{1,16}$/.test(timestamp)
    || !Number.isSafeInteger(Number(timestamp))
    || codePointLength(nonce) < 1
    || codePointLength(nonce) > HEADER_VALUE_MAX_CHARACTERS
    || !/^[0-9a-f]{64}$/.test(signature)) {
    throw authInvalid();
  }

  return {
    appId: normalizeId(suppliedAppId),
    timestamp,
    nonce,
    signature
  };
}

export function buildMiniProgramCanonicalRequest({ method, pathname, timestamp, nonce, rawBody }) {
  requireRawBody(rawBody);
  const bodyHash = crypto.createHash('sha256').update(rawBody).digest('hex');
  return [method, pathname, timestamp, nonce, bodyHash].map(value => String(value)).join('\n');
}

export function signMiniProgramRequest({ method, pathname, timestamp, nonce, rawBody, secret }) {
  if (typeof secret !== 'string' || codePointLength(secret) < MINIMUM_SECRET_CHARACTERS) {
    throw configurationIncomplete();
  }
  const canonical = buildMiniProgramCanonicalRequest({ method, pathname, timestamp, nonce, rawBody });
  return crypto.createHmac('sha256', secret).update(canonical).digest('hex');
}

export function verifyMiniProgramSignature({
  method,
  pathname,
  headers,
  rawBody,
  appId,
  secret,
  nowMs = Date.now()
}) {
  requireRawBody(rawBody);
  if (rawBody.length > MINI_PROGRAM_BODY_MAX_BYTES) {
    throw serviceError(413, 'MINI_PROGRAM_BODY_TOO_LARGE', '小程序请求体超过大小限制');
  }

  const configured = requireCompleteConfiguration(appId, secret);
  const supplied = validatedHeaders(headers);
  if (supplied.appId !== configured.appId) {
    throw serviceError(401, 'MINI_PROGRAM_AUTH_FAILED', '小程序请求鉴权失败');
  }

  const currentTime = Math.floor(Number(nowMs) / 1000);
  const suppliedTime = Number(supplied.timestamp);
  if (!Number.isFinite(currentTime)
    || Math.abs(currentTime - suppliedTime) > MINI_PROGRAM_CLOCK_SKEW_SECONDS) {
    throw serviceError(401, 'MINI_PROGRAM_TIMESTAMP_EXPIRED', '小程序请求已过期');
  }

  const canonical = buildMiniProgramCanonicalRequest({
    method,
    pathname,
    timestamp: supplied.timestamp,
    nonce: supplied.nonce,
    rawBody
  });
  const expectedSignature = crypto.createHmac('sha256', configured.secret).update(canonical).digest();
  const suppliedSignature = Buffer.from(supplied.signature, 'hex');
  if (expectedSignature.length !== 32
    || suppliedSignature.length !== 32
    || !crypto.timingSafeEqual(expectedSignature, suppliedSignature)) {
    throw serviceError(401, 'MINI_PROGRAM_AUTH_FAILED', '小程序请求鉴权失败');
  }

  return {
    appId: supplied.appId,
    timestamp: supplied.timestamp,
    nonce: supplied.nonce
  };
}

function isNonceUniqueViolation(error) {
  const message = String(error?.message || '');
  return [1555, 2067].includes(Number(error?.errcode))
    && message === 'UNIQUE constraint failed: mini_program_request_nonces.app_id, mini_program_request_nonces.nonce';
}

export function consumeMiniProgramNonce({ appId, nonce, nowMs = Date.now() }) {
  if (!validBoundedId(appId)
    || typeof nonce !== 'string'
    || codePointLength(nonce) < 1
    || codePointLength(nonce) > HEADER_VALUE_MAX_CHARACTERS
    || !Number.isFinite(Number(nowMs))) {
    throw authInvalid();
  }

  const createdAt = new Date(Number(nowMs)).toISOString();
  const expiresAt = new Date(Number(nowMs) + MINI_PROGRAM_NONCE_TTL_MS).toISOString();
  try {
    run(
      'INSERT INTO mini_program_request_nonces(app_id,nonce,expires_at,created_at) VALUES(?,?,?,?)',
      normalizeId(appId),
      nonce,
      expiresAt,
      createdAt
    );
  } catch (error) {
    if (!isNonceUniqueViolation(error)) throw error;
    throw serviceError(401, 'MINI_PROGRAM_NONCE_REPLAY', '小程序请求已被处理');
  }
  return { expiresAt };
}

export function cleanupExpiredMiniProgramNonces(nowIso = new Date().toISOString()) {
  const nowMs = Date.parse(nowIso);
  if (!Number.isFinite(nowMs)) {
    throw serviceError(500, 'MINI_PROGRAM_NONCE_CLEANUP_TIME_INVALID', 'Nonce 清理时间无效');
  }
  const result = run(
    'DELETE FROM mini_program_request_nonces WHERE expires_at <= ?',
    new Date(nowMs).toISOString()
  );
  return Number(result.changes);
}

export function startMiniProgramNonceCleanupWorker({ intervalMs = 60_000 } = {}) {
  if (nonceCleanupTimer) return nonceCleanupTimer;
  const delayMs = Number.isFinite(Number(intervalMs)) && Number(intervalMs) > 0
    ? Math.max(1, Number(intervalMs))
    : 60_000;
  nonceCleanupTimer = setInterval(() => {
    try { cleanupExpiredMiniProgramNonces(); } catch {}
  }, delayMs);
  nonceCleanupTimer.unref?.();
  return nonceCleanupTimer;
}

export function stopMiniProgramNonceCleanupWorker() {
  if (!nonceCleanupTimer) return;
  clearInterval(nonceCleanupTimer);
  nonceCleanupTimer = null;
}

export function validIso8601(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match || !Number.isFinite(Date.parse(value))) return false;

  const [, yearText, monthText, dayText, hourText, minuteText, secondText, , zone] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysByMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12
    || day < 1 || day > daysByMonth[month - 1]
    || hour > 23
    || minute > 59
    || second > 59) return false;

  if (zone !== 'Z') {
    const zoneHour = Number(zone.slice(1, 3));
    const zoneMinute = Number(zone.slice(4, 6));
    if (zoneHour > 14 || zoneMinute > 59 || (zoneHour === 14 && zoneMinute !== 0)) return false;
  }
  return true;
}

export function validateMiniProgramMessagePayload(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw serviceError(400, 'MINI_PROGRAM_PAYLOAD_INVALID', '小程序消息格式无效');
  }
  const enumerableKeys = Reflect.ownKeys(value)
    .filter(key => Object.prototype.propertyIsEnumerable.call(value, key));
  if (enumerableKeys.length !== MESSAGE_FIELDS.length
    || enumerableKeys.some(key => typeof key !== 'string' || !MESSAGE_FIELDS.includes(key))
    || MESSAGE_FIELDS.some(field => !enumerableKeys.includes(field))
    || MESSAGE_FIELDS.some(field => typeof value[field] !== 'string')) {
    throw serviceError(400, 'MINI_PROGRAM_PAYLOAD_INVALID', '小程序消息格式无效');
  }

  const normalized = {
    appId: normalizeId(value.appId),
    conversationId: normalizeId(value.conversationId),
    messageId: normalizeId(value.messageId),
    userId: normalizeId(value.userId),
    text: value.text.trim().normalize('NFC'),
    sentAt: value.sentAt
  };
  if (['appId', 'conversationId', 'messageId', 'userId'].some(field => {
    const length = codePointLength(normalized[field]);
    return length < 1 || length > 128;
  })) {
    throw serviceError(400, 'MINI_PROGRAM_PAYLOAD_INVALID', '小程序消息格式无效');
  }
  const textLength = codePointLength(normalized.text);
  if (textLength < 1 || textLength > 2_000 || !validIso8601(normalized.sentAt)) {
    throw serviceError(400, 'MINI_PROGRAM_PAYLOAD_INVALID', '小程序消息格式无效');
  }
  return normalized;
}

export function validateMiniProgramCallbackUrl(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw serviceError(503, 'MINI_PROGRAM_CALLBACK_URL_INVALID', '小程序回调地址无效');
  }

  const rawValue = value.trim();
  let target;
  try {
    target = new URL(rawValue);
  } catch {
    throw serviceError(503, 'MINI_PROGRAM_CALLBACK_URL_INVALID', '小程序回调地址无效');
  }
  const explicitLoopbackHttp = /^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/|$)/i.test(rawValue);
  const validProtocol = target.protocol === 'https:'
    || (target.protocol === 'http:' && explicitLoopbackHttp);
  if (!validProtocol
    || target.username
    || target.password
    || target.href.includes('?')
    || target.href.includes('#')) {
    throw serviceError(503, 'MINI_PROGRAM_CALLBACK_URL_INVALID', '小程序回调地址无效');
  }
  return target;
}
