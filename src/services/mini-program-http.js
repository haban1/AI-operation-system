import { MIMEType } from 'node:util';
import { config } from '../config.js';
import {
  MINI_PROGRAM_BODY_MAX_BYTES, MINI_PROGRAM_MESSAGE_PATH, consumeMiniProgramNonce,
  validateMiniProgramMessagePayload, verifyMiniProgramSignature
} from './mini-program-auth.js';
import { ingestMiniProgramMessage } from './mini-program-channel.js';

const publicErrors = new Set([
  'MINI_PROGRAM_PATH_NOT_FOUND', 'MINI_PROGRAM_METHOD_NOT_ALLOWED', 'MINI_PROGRAM_API_DISABLED',
  'MINI_PROGRAM_CONFIGURATION_INCOMPLETE', 'MINI_PROGRAM_JSON_CONTENT_TYPE_REQUIRED',
  'MINI_PROGRAM_BODY_TOO_LARGE', 'MINI_PROGRAM_REQUEST_INVALID', 'MINI_PROGRAM_AUTH_INVALID',
  'MINI_PROGRAM_AUTH_FAILED', 'MINI_PROGRAM_TIMESTAMP_EXPIRED', 'MINI_PROGRAM_NONCE_REPLAY',
  'MINI_PROGRAM_PAYLOAD_INVALID', 'CONVERSATION_USER_MISMATCH', 'MINI_PROGRAM_ACCOUNT_UNAVAILABLE'
]);

function serviceError(statusCode, code, message) {
  return Object.assign(new Error(message), { statusCode, code });
}

function invalidRequest() {
  return serviceError(400, 'MINI_PROGRAM_REQUEST_INVALID', '小程序请求格式无效');
}

function tooLarge() {
  return serviceError(413, 'MINI_PROGRAM_BODY_TOO_LARGE', '小程序请求体超过大小限制');
}

function requireConfiguration() {
  if (!config.miniProgramApiEnabled) throw serviceError(503, 'MINI_PROGRAM_API_DISABLED', '小程序接口尚未开启');
  const appId = config.miniProgramAppId.trim().normalize('NFC');
  if (Array.from(appId).length < 1 || Array.from(appId).length > 128
    || Array.from(config.miniProgramSharedSecret).length < 32) {
    throw serviceError(503, 'MINI_PROGRAM_CONFIGURATION_INCOMPLETE', '小程序接口配置不完整');
  }
  return appId;
}

function requireJsonContentType(req) {
  const values = req.headersDistinct['content-type'];
  let mime;
  try { if (values?.length === 1) mime = new MIMEType(values[0]); } catch {}
  // MIMEType folds duplicate parameters; require the original parameter count to agree.
  const parameters = mime ? [...mime.params] : [];
  if (!mime || mime.essence !== 'application/json'
    || values[0].split(';').length !== parameters.length + 1
    || parameters.some(([name, value]) => name !== 'charset' || value.toLowerCase() !== 'utf-8')
    || req.headersDistinct['content-encoding']) {
    throw serviceError(415, 'MINI_PROGRAM_JSON_CONTENT_TYPE_REQUIRED', '小程序请求体必须使用 UTF-8 application/json');
  }
}

function readRawBody(req) {
  const lengths = req.headersDistinct['content-length'];
  const transfers = req.headersDistinct['transfer-encoding'];
  if (req.headersDistinct.host?.length !== 1
    || (lengths && (lengths.length !== 1 || !/^\d+$/.test(lengths[0])))
    || (transfers && (transfers.length !== 1 || transfers[0].toLowerCase() !== 'chunked' || lengths))) {
    throw invalidRequest();
  }
  if (lengths && Number(lengths[0]) > MINI_PROGRAM_BODY_MAX_BYTES) throw tooLarge();
  if (req.aborted || req.destroyed) throw invalidRequest();

  return new Promise((resolve, reject) => {
    let chunks = [];
    let size = 0;
    let settled = false;
    const finish = error => {
      if (settled) return;
      settled = true;
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('aborted', onAbort);
      req.off('error', onAbort);
      req.off('close', onClose);
      if (error) {
        chunks = [];
        // Preserve the safe HTTP rejection while discarding any unread bytes without buffering.
        req.once('error', () => {});
        req.resume();
        reject(error);
      } else {
        resolve(Buffer.concat(chunks, size));
      }
    };
    const onData = chunk => {
      size += chunk.length;
      if (size > MINI_PROGRAM_BODY_MAX_BYTES) return finish(tooLarge());
      chunks.push(chunk);
    };
    const onEnd = () => finish(req.complete ? null : invalidRequest());
    const onAbort = () => finish(invalidRequest());
    const onClose = () => { if (!req.complete) onAbort(); };
    req.on('data', onData);
    req.once('end', onEnd);
    req.once('aborted', onAbort);
    req.once('error', onAbort);
    req.once('close', onClose);
  });
}

function signatureHeaders(req) {
  return Object.fromEntries(Object.entries(req.headersDistinct)
    .map(([name, values]) => [name, values.length === 1 ? values[0] : values]));
}

export async function handleMiniProgramOpenMessage(req, url) {
  try {
    if (url.pathname !== MINI_PROGRAM_MESSAGE_PATH || req.url !== MINI_PROGRAM_MESSAGE_PATH) {
      throw serviceError(404, 'MINI_PROGRAM_PATH_NOT_FOUND', '小程序接口不存在');
    }
    if (req.method !== 'POST') throw serviceError(405, 'MINI_PROGRAM_METHOD_NOT_ALLOWED', '小程序接口仅接受 POST');
    const appId = requireConfiguration();
    requireJsonContentType(req);
    const rawBody = await readRawBody(req);
    const verified = verifyMiniProgramSignature({
      method: req.method, pathname: MINI_PROGRAM_MESSAGE_PATH, headers: signatureHeaders(req), rawBody,
      appId, secret: config.miniProgramSharedSecret
    });
    consumeMiniProgramNonce(verified);
    let parsed;
    try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(rawBody)); }
    catch { throw serviceError(400, 'MINI_PROGRAM_PAYLOAD_INVALID', '小程序消息格式无效'); }
    const payload = validateMiniProgramMessagePayload(parsed);
    if (payload.appId !== verified.appId || payload.appId !== appId) {
      throw serviceError(401, 'MINI_PROGRAM_AUTH_FAILED', '小程序请求鉴权失败');
    }
    const result = ingestMiniProgramMessage(payload);
    return { statusCode: 202, body: { ok: true, accepted: result.accepted, messageId: result.messageId, status: result.status } };
  } catch (error) {
    if ([5, 6].includes(Number(error?.errcode) & 0xff) || /^SQLITE_(?:BUSY|LOCKED)(?:_|$)/.test(String(error?.code || ''))) {
      throw serviceError(503, 'MINI_PROGRAM_TEMPORARILY_UNAVAILABLE', '小程序接口暂时不可用，请稍后重试');
    }
    if (publicErrors.has(error?.code)) throw serviceError(error.statusCode, error.code, error.message);
    throw serviceError(500, 'MINI_PROGRAM_INTERNAL_ERROR', '小程序消息处理失败');
  }
}
