import crypto from 'node:crypto';
import { db, immediateTransaction, now, row, run } from '../db.js';
import { ingestMiniProgramMessage } from './mini-program-channel.js';
import { signMiniProgramRequest, validateMiniProgramMessagePayload } from './mini-program-auth.js';
import { getMiniProgramConnection, saveMiniProgramConnection, bridgeEndpoint, validateBridgeUrl, BRIDGE_PROTOCOL, MiniProgramConnectionError } from './mini-program-connection.js';

// Receipts are committed in the same transaction as message intake. A lost ACK is safe to retry after restart.
db.exec(`CREATE TABLE IF NOT EXISTS mini_program_bridge_receipts (
  app_id TEXT NOT NULL, gateway_url TEXT NOT NULL, delivery_id TEXT NOT NULL,
  message_id TEXT NOT NULL, status TEXT NOT NULL, code TEXT,
  created_at TEXT NOT NULL, acked_at TEXT,
  PRIMARY KEY(app_id,gateway_url,delivery_id)
);
CREATE INDEX IF NOT EXISTS idx_mini_bridge_pending ON mini_program_bridge_receipts(acked_at,created_at);`);

let timer = null;
let running = false;
let flight = null;
let controller = null;
let generation = 0;
const runtime = { state: 'STOPPED', lastConnectedAt: null, lastReceivedAt: null, lastAckAt: null,
  lastError: null, consecutiveFailures: 0, nextAttemptAt: null };
const permanentErrors = new Set(['MINI_PROGRAM_PAYLOAD_INVALID', 'CONVERSATION_USER_MISMATCH']);
const connectionError = (text, code = 'MINI_PROGRAM_BRIDGE_ERROR') => new MiniProgramConnectionError(text, 502, code);

async function boundedJson(response) {
  if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') || '')) {
    await response.body?.cancel(); throw connectionError('服务器返回的不是 JSON，请检查连接地址和协议');
  }
  const reader = response.body?.getReader();
  if (!reader) throw connectionError('服务器响应为空');
  const chunks = []; let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      length += value.byteLength;
      if (length > 40 * 1024) throw connectionError('服务器响应过大，单次仅允许领取一条文字消息');
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  } catch (error) {
    await reader.cancel().catch(() => {});
    if (error instanceof MiniProgramConnectionError) throw error;
    throw connectionError('服务器响应格式无效');
  } finally { reader.releaseLock(); }
}

export async function requestMiniProgramBridge(settings, operation, data, { fetchImpl = fetch, signal, timeoutMs = 30_000 } = {}) {
  validateBridgeUrl(settings.gatewayUrl);
  const url = new URL(bridgeEndpoint(settings, operation));
  const rawBody = Buffer.from(JSON.stringify(data));
  const timestamp = String(Math.floor(Date.now() / 1000)), nonce = crypto.randomUUID();
  const signature = signMiniProgramRequest({ method: 'POST', pathname: url.pathname, timestamp, nonce, rawBody, secret: settings.sharedSecret });
  let response;
  try {
    response = await fetchImpl(url.href, { method: 'POST', redirect: 'manual',
      headers: { 'Content-Type': 'application/json', 'X-Mini-App-Id': settings.appId,
        'X-Timestamp': timestamp, 'X-Nonce': nonce, 'X-Signature': signature }, body: rawBody,
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs) });
    if (response.status !== 200) {
      await response.body?.cancel();
      throw connectionError(`连接请求失败（HTTP ${response.status}），请检查地址、鉴权和服务状态`);
    }
    const result = await boundedJson(response);
    if (!result || result.ok !== true || result.protocol !== BRIDGE_PROTOCOL || result.appId !== settings.appId
      || result.requestNonce !== nonce) throw connectionError('服务器协议或应用身份不匹配，未接收消息');
    return result;
  } catch (error) {
    if (error instanceof MiniProgramConnectionError) throw error;
    throw connectionError(signal?.aborted ? '连接已暂停' : '无法连接服务器或请求超时，将自动重试');
  }
}

function ready(settings) {
  return settings.mode === 'pull' && settings.enabled && settings.gatewayUrl && settings.appId
    && settings.clientId && settings.sharedSecret?.length >= 32;
}

export function getMiniProgramBridgeStatus() {
  const settings = getMiniProgramConnection();
  const pending = row('SELECT COUNT(*) AS n FROM mini_program_bridge_receipts WHERE acked_at IS NULL')?.n || 0;
  let state = runtime.state;
  if (settings.mode !== 'pull') state = 'PUSH_MODE';
  else if (!settings.enabled) state = 'PAUSED';
  else if (!ready(settings)) state = 'NOT_CONFIGURED';
  else if (!running) state = 'STOPPED';
  return { ...runtime, state, pendingReceipts: Number(pending) };
}

export async function testMiniProgramBridge({ fetchImpl = fetch } = {}) {
  const settings = getMiniProgramConnection();
  if (settings.mode !== 'pull' || !settings.gatewayUrl || !settings.clientId || !settings.appId || !settings.sharedSecret) {
    throw new MiniProgramConnectionError('请先保存主动连接配置，再检查连通性');
  }
  const result = await requestMiniProgramBridge(settings, 'health', { appId: settings.appId, clientId: settings.clientId,
    protocol: BRIDGE_PROTOCOL }, { fetchImpl, timeoutMs: 10_000 });
  if (!Array.isArray(result.capabilities) || !['pull', 'ack', 'replies'].every(item => result.capabilities.includes(item))) {
    throw connectionError('服务器缺少消息领取、收件确认或回复接收能力');
  }
  return { reachable: true, checkedAt: now(), message: '连接及协议检查通过；尚不代表真实消息与 AI 回复已完成联调' };
}

async function ackReceipt(settings, receipt, options) {
  const result = await requestMiniProgramBridge(settings, 'ack', { appId: settings.appId, clientId: settings.clientId,
    deliveryId: receipt.delivery_id, messageId: receipt.message_id, status: receipt.status, code: receipt.code }, options);
  if (result.deliveryId !== receipt.delivery_id || result.acknowledged !== true) throw connectionError('服务器未确认收件结果，将重试确认');
  run('UPDATE mini_program_bridge_receipts SET acked_at=? WHERE app_id=? AND gateway_url=? AND delivery_id=?',
    now(), settings.appId, settings.gatewayUrl, receipt.delivery_id);
  runtime.lastAckAt = now();
}

export async function pollMiniProgramBridgeOnce({ fetchImpl = fetch, signal } = {}) {
  const settings = getMiniProgramConnection();
  if (!ready(settings)) return { skipped: true };
  const options = { fetchImpl, signal };
  const pending = row(`SELECT * FROM mini_program_bridge_receipts WHERE app_id=? AND gateway_url=? AND acked_at IS NULL ORDER BY created_at LIMIT 1`, settings.appId, settings.gatewayUrl);
  if (pending) { await ackReceipt(settings, pending, options); return { acknowledged: true }; }
  const result = await requestMiniProgramBridge(settings, 'pull', { appId: settings.appId, clientId: settings.clientId,
    limit: 1, waitSeconds: 20 }, options);
  if (signal?.aborted) return { skipped: true };
  runtime.lastConnectedAt = now();
  if (result.delivery === null) return { idle: true };
  const delivery = result.delivery;
  if (!delivery || typeof delivery.id !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(delivery.id)
    || !delivery.message || typeof delivery.message.messageId !== 'string'
    || !delivery.message.messageId.trim() || Array.from(delivery.message.messageId).length > 128) {
    throw connectionError('消息领取响应格式不符合约定，未确认收件');
  }
  // App mismatch is never acknowledged to prevent cross-application queue loss.
  if (delivery.message.appId !== settings.appId) throw connectionError('领取消息的应用身份不匹配，未确认收件');
  const receipt = immediateTransaction(() => {
    const existing = row('SELECT * FROM mini_program_bridge_receipts WHERE app_id=? AND gateway_url=? AND delivery_id=?', settings.appId, settings.gatewayUrl, delivery.id);
    if (existing) {
      if (existing.message_id !== delivery.message.messageId.trim().normalize('NFC')) throw connectionError('投递标识被复用，未确认收件');
      return existing;
    }
    let status, code = null, messageId = delivery.message.messageId.trim().normalize('NFC');
    try {
      if (Buffer.byteLength(JSON.stringify(delivery.message)) > 32768) throw Object.assign(new Error(), { code: 'MINI_PROGRAM_PAYLOAD_INVALID' });
      const payload = validateMiniProgramMessagePayload(delivery.message);
      const accepted = ingestMiniProgramMessage(payload); status = accepted.status; messageId = accepted.messageId;
    } catch (error) {
      if (!permanentErrors.has(error.code)) throw error;
      status = 'REJECTED'; code = error.code;
    }
    run(`INSERT INTO mini_program_bridge_receipts(app_id,gateway_url,delivery_id,message_id,status,code,created_at) VALUES(?,?,?,?,?,?,?)`,
      settings.appId, settings.gatewayUrl, delivery.id, messageId, status, code, now());
    return row('SELECT * FROM mini_program_bridge_receipts WHERE app_id=? AND gateway_url=? AND delivery_id=?', settings.appId, settings.gatewayUrl, delivery.id);
  });
  runtime.lastReceivedAt = now();
  await ackReceipt(settings, receipt, options);
  // Bounded metadata retention; durable message IDs continue providing business idempotency.
  run("DELETE FROM mini_program_bridge_receipts WHERE acked_at IS NOT NULL AND acked_at < ?", new Date(Date.now() - 30 * 86400_000).toISOString());
  return { received: true, status: receipt.status };
}

export function startMiniProgramBridgeWorker({ fetchImpl = fetch } = {}) {
  if (running) return;
  running = true; const owner = ++generation;
  const tick = async () => {
    if (!running || owner !== generation) return;
    let delay = 5000;
    try {
      const settings = getMiniProgramConnection(); delay = Math.max(2000, settings.pollSeconds * 1000);
      if (ready(settings)) {
        controller = new AbortController(); runtime.state = 'CONNECTING'; runtime.nextAttemptAt = null;
        flight = pollMiniProgramBridgeOnce({ fetchImpl, signal: controller.signal });
        const result = await flight;
        runtime.state = 'CONNECTED'; runtime.lastError = null; runtime.consecutiveFailures = 0;
        if (result.received || result.acknowledged) delay = 250;
      }
    } catch (error) {
      runtime.state = 'RETRYING'; runtime.consecutiveFailures++;
      runtime.lastError = error instanceof MiniProgramConnectionError ? error.message : '本地收件处理失败，消息未确认，将自动重试';
      delay = Math.min(60_000, 2000 * 2 ** Math.min(runtime.consecutiveFailures, 5)) + Math.floor(Math.random() * 1000);
    } finally {
      flight = null; controller = null;
      if (running && owner === generation) {
        runtime.nextAttemptAt = new Date(Date.now() + delay).toISOString();
        timer = setTimeout(tick, delay); timer.unref?.();
      }
    }
  };
  timer = setTimeout(tick, 0); timer.unref?.();
}

export async function stopMiniProgramBridgeWorker() {
  running = false; generation++; clearTimeout(timer); timer = null;
  controller?.abort();
  if (flight) await flight.catch(() => {});
  runtime.state = 'STOPPED'; runtime.nextAttemptAt = null;
}

let configuring = false;
export async function configureMiniProgramBridge(input) {
  if (configuring) throw new MiniProgramConnectionError('连接配置正在更新，请稍后再试', 409);
  configuring = true; const restart = running;
  try {
    await stopMiniProgramBridgeWorker();
    const result = saveMiniProgramConnection(input);
    Object.assign(runtime, { lastConnectedAt: null, lastReceivedAt: null, lastAckAt: null, lastError: null, consecutiveFailures: 0 });
    return result;
  } finally {
    configuring = false;
    if (restart) startMiniProgramBridgeWorker();
  }
}
