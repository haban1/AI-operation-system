import crypto from 'node:crypto';
import { config } from '../config.js';
import { row } from '../db.js';
import { getStoredSetting, saveEncryptedSetting } from './settings.js';

const KEY = 'mini_program.connection.v1';
export const BRIDGE_PROTOCOL = 'tianhe-mini-program/1';
export class MiniProgramConnectionError extends Error {
  constructor(message, statusCode = 400, code = 'MINI_PROGRAM_CONNECTION_INVALID') {
    super(message); Object.assign(this, { statusCode, code });
  }
}

export function bridgeEndpoint(settings, operation) {
  return `${settings.gatewayUrl.replace(/\/+$/, '')}/${operation}`;
}

export function getMiniProgramConnection() {
  let saved;
  try { saved = getStoredSetting(KEY); }
  catch { throw new MiniProgramConnectionError('连接配置无法解密，请检查本地配置密钥', 503); }
  if (saved) {
    try { return JSON.parse(saved.value); }
    catch { throw new MiniProgramConnectionError('连接配置损坏，请重新保存', 503); }
  }
  const mode = config.miniProgramConnectionMode || (config.miniProgramApiEnabled ? 'push' : 'pull');
  const gatewayUrl = config.miniProgramGatewayUrl || '';
  return {
    mode, enabled: Boolean(config.miniProgramApiEnabled), appId: config.miniProgramAppId,
    sharedSecret: config.miniProgramSharedSecret, gatewayUrl,
    clientId: config.miniProgramClientId || '',
    callbackUrl: mode === 'pull' && gatewayUrl ? `${gatewayUrl.replace(/\/+$/, '')}/replies` : config.miniProgramCallbackUrl,
    pollSeconds: 5
  };
}

export function miniProgramConnectionSummary() {
  const s = getMiniProgramConnection();
  return { mode: s.mode, enabled: s.enabled, appId: s.appId, clientId: s.clientId,
    gatewayUrl: s.gatewayUrl, callbackUrl: s.callbackUrl, pollSeconds: s.pollSeconds,
    secretConfigured: Boolean(s.sharedSecret), configured: Boolean(s.appId && s.sharedSecret?.length >= 32
      && (s.mode === 'pull' ? s.gatewayUrl && s.clientId : s.callbackUrl)) };
}

export function validateBridgeUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new MiniProgramConnectionError('服务器地址格式无效'); }
  const localTest = process.env.NODE_ENV === 'test' && url.protocol === 'http:' && url.hostname === '127.0.0.1';
  if ((!localTest && url.protocol !== 'https:') || url.username || url.password || url.search || url.hash
    || value.includes('?') || value.includes('#') || value.length > 2048) {
    throw new MiniProgramConnectionError('服务器地址必须是 HTTPS，且不能包含账号、密码、查询参数或锚点');
  }
  return url.href.replace(/\/+$/, '');
}

export function saveMiniProgramConnection(input) {
  const allowed = ['mode', 'enabled', 'appId', 'sharedSecret', 'gatewayUrl', 'callbackUrl', 'pollSeconds'];
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !allowed.includes(k))
    || !['pull', 'push'].includes(input.mode) || typeof input.enabled !== 'boolean'
    || !['appId', 'sharedSecret', 'gatewayUrl', 'callbackUrl'].every(k => typeof input[k] === 'string')
    || !Number.isInteger(input.pollSeconds) || input.pollSeconds < 2 || input.pollSeconds > 60) {
    throw new MiniProgramConnectionError('连接配置格式无效，拉取间隔为 2–60 秒');
  }
  const old = getMiniProgramConnection();
  const appId = input.appId.trim();
  if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(appId)) throw new MiniProgramConnectionError('应用标识需为 1–128 位字母、数字或 . _ : -');
  const sharedSecret = input.sharedSecret || old.sharedSecret;
  if (typeof sharedSecret !== 'string' || Array.from(sharedSecret).length < 32 || sharedSecret.length > 4096) {
    throw new MiniProgramConnectionError('首次保存需填写至少 32 字符的共享密钥；密钥由双方约定，不使用简单口令');
  }
  const gatewayUrl = input.mode === 'pull' ? validateBridgeUrl(input.gatewayUrl.trim()) : '';
  const callbackUrl = input.mode === 'pull' ? `${gatewayUrl}/replies` : validateBridgeUrl(input.callbackUrl.trim());
  const next = { mode: input.mode, enabled: input.enabled, appId, sharedSecret, gatewayUrl, callbackUrl,
    clientId: old.clientId || crypto.randomUUID(), pollSeconds: input.pollSeconds };
  const rerouted = ['mode', 'appId', 'sharedSecret', 'gatewayUrl', 'callbackUrl'].some(k => old[k] !== next[k]);
  if (old.appId && old.appId !== appId && row("SELECT id FROM messages WHERE platform_code='mini_program' LIMIT 1")) {
    throw new MiniProgramConnectionError('已有小程序消息，不能直接更换应用标识；请使用独立实例接入其他应用', 409);
  }
  if (rerouted && (row("SELECT id FROM mini_program_callback_outbox WHERE status NOT IN ('SENT','CANCELLED') LIMIT 1")
    || row("SELECT id FROM mini_program_processing_jobs WHERE status IN ('PENDING','RUNNING','RETRY_WAIT') LIMIT 1")
    || (row("SELECT name FROM sqlite_master WHERE type='table' AND name='mini_program_bridge_receipts'")
      && row("SELECT delivery_id FROM mini_program_bridge_receipts WHERE acked_at IS NULL LIMIT 1")))) {
    throw new MiniProgramConnectionError('还有待处理消息、待发送回复或待确认收件；请先完成这些任务，再更换连接身份或地址', 409);
  }
  saveEncryptedSetting(KEY, JSON.stringify(next), '小程序连接管理');
  return miniProgramConnectionSummary();
}
