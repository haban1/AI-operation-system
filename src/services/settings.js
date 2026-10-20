import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config, ROOT } from '../config.js';
import { now, row, run } from '../db.js';

const WECOM_SETTING_KEY = 'wecom.webhook_url';
const MASTER_SWITCH_KEY = 'operations.master_enabled';
const AI_SETTING_KEYS = Object.freeze({
  mode: 'ai.mode', apiKey: 'ai.api_key', baseUrl: 'ai.base_url', model: 'ai.model', visionModel: 'ai.vision_model',
  asrModel: 'ai.asr_model', contentModel: 'ai.content_model', imageContentModel: 'ai.image_content_model',
  trafficPredictionModel: 'ai.traffic_prediction_model', embeddingModel: 'ai.embedding_model'
});
const EXTRA_MODEL_FIELDS = ['asrModel', 'contentModel', 'imageContentModel', 'trafficPredictionModel', 'embeddingModel'];
const MESSAGE_COLLECTION_INTERVAL_KEY = 'message_collection.interval';
export const MESSAGE_COLLECTION_INTERVAL_OPTIONS = Object.freeze([
  { value: '1-2', label: '1\uff5e2 \u5206\u949f', minMs: 60_000, maxMs: 120_000 },
  { value: '2-3', label: '2\uff5e3 \u5206\u949f', minMs: 120_000, maxMs: 180_000 },
  { value: '3-4', label: '3\uff5e4 \u5206\u949f', minMs: 180_000, maxMs: 240_000 },
  { value: '4-5', label: '4\uff5e5 \u5206\u949f', minMs: 240_000, maxMs: 300_000 }
]);
const SMART_REPLY_PREFIX = 'smart_reply.';
const SMART_REPLY_SUFFIX = '.enabled';
const SMART_REPLY_PLATFORMS = new Set(['xiaohongshu', 'douyin', 'wechat_channels', 'bilibili', 'weibo']);
const KEY_FILE = path.join(ROOT, 'data', '.settings-key');

function encryptionKey() {
  const supplied = String(process.env.SETTINGS_ENCRYPTION_KEY || '').trim();
  if (supplied) {
    if (/^[0-9a-f]{64}$/i.test(supplied)) return Buffer.from(supplied, 'hex');
    try {
      const decoded = Buffer.from(supplied, 'base64');
      if (decoded.length === 32) return decoded;
    } catch {}
    return crypto.createHash('sha256').update(supplied).digest();
  }
  fs.mkdirSync(path.dirname(KEY_FILE), { recursive: true });
  if (fs.existsSync(KEY_FILE)) {
    const stored = fs.readFileSync(KEY_FILE, 'utf8').trim();
    if (/^[0-9a-f]{64}$/i.test(stored)) return Buffer.from(stored, 'hex');
  }
  const generated = crypto.randomBytes(32);
  fs.writeFileSync(KEY_FILE, generated.toString('hex'), { encoding: 'utf8', mode: 0o600 });
  return generated;
}

function encrypt(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${encrypted.toString('base64')}`;
}

function decrypt(value) {
  const [version, ivText, tagText, encryptedText] = String(value || '').split(':');
  if (version !== 'v1' || !ivText || !tagText || !encryptedText) throw new Error('企微配置密文格式无效');
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(ivText, 'base64'));
  decipher.setAuthTag(Buffer.from(tagText, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(encryptedText, 'base64')), decipher.final()]).toString('utf8');
}

export function validateWecomWebhookUrl(value) {
  const input = String(value || '').trim();
  if (!input) return { ok: false, message: '机器人 Webhook 地址不能为空' };
  let parsed;
  try { parsed = new URL(input); } catch { return { ok: false, message: '\u673a\u5668\u4eba Webhook \u5730\u5740\u683c\u5f0f\u65e0\u6548' }; }
  if (parsed.protocol !== 'https:') return { ok: false, message: '机器人 Webhook 必须使用 HTTPS' };
  if (parsed.hostname.toLowerCase() !== 'qyapi.weixin.qq.com') return { ok: false, message: '仅允许企业微信官方域名 qyapi.weixin.qq.com' };
  if (parsed.port) return { ok: false, message: '机器人 Webhook 不允许自定义端口' };
  if (parsed.pathname !== '/cgi-bin/webhook/send') return { ok: false, message: '机器人 Webhook 路径不正确' };
  const key = parsed.searchParams.get('key');
  if (!key || !/^[A-Za-z0-9_-]{8,}$/.test(key)) return { ok: false, message: '机器人 Webhook 缺少有效的 key' };
  if ([...parsed.searchParams.keys()].some(name => name !== 'key')) return { ok: false, message: '机器人 Webhook 含有不支持的查询参数' };
  parsed.hash = '';
  return { ok: true, url: parsed.toString() };
}

export function maskWecomWebhookUrl(value) {
  const validation = validateWecomWebhookUrl(value);
  if (!validation.ok) return '';
  const parsed = new URL(validation.url);
  const key = parsed.searchParams.get('key');
  parsed.searchParams.set('key', `******${key.slice(-6)}`);
  return parsed.toString();
}

export function encryptSettingValue(value) { return encrypt(String(value)); }
export function decryptSettingValue(value) { return decrypt(value); }

export function getWecomWebhookUrl() {
  const setting = row('SELECT encrypted_value FROM system_settings WHERE setting_key=?', WECOM_SETTING_KEY);
  if (setting?.encrypted_value) return { url: decrypt(setting.encrypted_value), source: 'DATABASE' };
  const fallback = validateWecomWebhookUrl(config.wecomWebhookUrl);
  if (fallback.ok) return { url: fallback.url, source: 'ENVIRONMENT' };
  return { url: '', source: 'NONE' };
}

export function getWecomSettingsSummary() {
  const setting = row('SELECT updated_at,updated_by FROM system_settings WHERE setting_key=?', WECOM_SETTING_KEY);
  const current = getWecomWebhookUrl();
  return {
    configured: Boolean(current.url),
    maskedUrl: current.url ? maskWecomWebhookUrl(current.url) : '',
    source: current.source,
    updatedAt: setting?.updated_at || null,
    updatedBy: setting?.updated_by || null
  };
}

export function saveWecomWebhookUrl(value, updatedBy = '技术部') {
  const validation = validateWecomWebhookUrl(value);
  if (!validation.ok) {
    const error = new Error(validation.message);
    error.code = 'INVALID_WECOM_WEBHOOK';
    throw error;
  }
  const stamp = now();
  run(`INSERT INTO system_settings(setting_key,encrypted_value,updated_at,updated_by) VALUES(?,?,?,?)
    ON CONFLICT(setting_key) DO UPDATE SET encrypted_value=excluded.encrypted_value,updated_at=excluded.updated_at,updated_by=excluded.updated_by`,
    WECOM_SETTING_KEY, encrypt(validation.url), stamp, String(updatedBy || '技术部').slice(0, 100));
  return getWecomSettingsSummary();
}

export function clearWecomWebhookUrl() {
  run('DELETE FROM system_settings WHERE setting_key=?', WECOM_SETTING_KEY);
  return getWecomSettingsSummary();
}

export function getMasterSwitch() {
  const setting = row('SELECT encrypted_value,updated_at,updated_by FROM system_settings WHERE setting_key=?', MASTER_SWITCH_KEY);
  return {
    enabled: setting ? setting.encrypted_value !== 'false' : true,
    updatedAt: setting?.updated_at || null,
    updatedBy: setting?.updated_by || null
  };
}

export function saveMasterSwitch(enabled, updatedBy = '运营席位') {
  if (typeof enabled !== 'boolean') {
    const error = new Error('enabled 必须是布尔值');
    error.code = 'INVALID_MASTER_SWITCH';
    throw error;
  }
  const stamp = now();
  run(`INSERT INTO system_settings(setting_key,encrypted_value,updated_at,updated_by) VALUES(?,?,?,?)
    ON CONFLICT(setting_key) DO UPDATE SET encrypted_value=excluded.encrypted_value,updated_at=excluded.updated_at,updated_by=excluded.updated_by`,
    MASTER_SWITCH_KEY, String(enabled), stamp, String(updatedBy || '运营席位').slice(0, 100));
  return getMasterSwitch();
}

export function getPlatformSmartReply(platformCode) {
  const code = String(platformCode || '').trim();
  if (!SMART_REPLY_PLATFORMS.has(code)) {
    const error = new Error('\u4e0d\u652f\u6301\u7684\u5e73\u53f0');
    error.code = 'INVALID_SMART_REPLY_PLATFORM';
    throw error;
  }
  const settingKey = `${SMART_REPLY_PREFIX}${code}${SMART_REPLY_SUFFIX}`;
  const setting = row('SELECT encrypted_value,updated_at,updated_by FROM system_settings WHERE setting_key=?', settingKey);
  return {
    platformCode: code,
    enabled: setting ? setting.encrypted_value === 'true' : true,
    updatedAt: setting?.updated_at || null,
    updatedBy: setting?.updated_by || null
  };
}

export function getPlatformSmartReplyMap(platformCodes = [...SMART_REPLY_PLATFORMS]) {
  return Object.fromEntries(platformCodes.map(code => [code, getPlatformSmartReply(code)]));
}

export function savePlatformSmartReply(platformCode, enabled, updatedBy = '\u8fd0\u8425\u5e2d\u4f4d') {
  const current = getPlatformSmartReply(platformCode);
  if (typeof enabled !== 'boolean') {
    const error = new Error('enabled \u5fc5\u987b\u662f\u5e03\u5c14\u503c');
    error.code = 'INVALID_SMART_REPLY_SWITCH';
    throw error;
  }
  const stamp = now();
  const settingKey = `${SMART_REPLY_PREFIX}${current.platformCode}${SMART_REPLY_SUFFIX}`;
  run(`INSERT INTO system_settings(setting_key,encrypted_value,updated_at,updated_by) VALUES(?,?,?,?)
    ON CONFLICT(setting_key) DO UPDATE SET encrypted_value=excluded.encrypted_value,updated_at=excluded.updated_at,updated_by=excluded.updated_by`,
    settingKey, String(enabled), stamp, String(updatedBy || '\u8fd0\u8425\u5e2d\u4f4d').slice(0, 100));
  return getPlatformSmartReply(current.platformCode);
}

export function redactWecomSecrets(value) {
  return String(value || '').replace(/(https:\/\/qyapi\.weixin\.qq\.com\/cgi-bin\/webhook\/send\?key=)[A-Za-z0-9_-]+/gi, '$1******');
}

function getStoredSetting(settingKey) {
  const setting = row('SELECT encrypted_value,updated_at,updated_by FROM system_settings WHERE setting_key=?', settingKey);
  if (!setting) return null;
  return { value: decrypt(setting.encrypted_value), updatedAt: setting.updated_at || null, updatedBy: setting.updated_by || null };
}

function saveEncryptedSetting(settingKey, value, updatedBy) {
  const stamp = now();
  run(`INSERT INTO system_settings(setting_key,encrypted_value,updated_at,updated_by) VALUES(?,?,?,?)
    ON CONFLICT(setting_key) DO UPDATE SET encrypted_value=excluded.encrypted_value,updated_at=excluded.updated_at,updated_by=excluded.updated_by`,
    settingKey, encrypt(String(value)), stamp, String(updatedBy || '运营席位').slice(0, 100));
}

function validateAiBaseUrl(value) {
  let parsed;
  try { parsed = new URL(String(value || '').trim()); } catch { throw Object.assign(new Error('AI Base URL 格式无效'), { code: 'INVALID_AI_SETTINGS' }); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port || parsed.search || parsed.hash) {
    throw Object.assign(new Error('AI Base URL 必须是不含账号、端口、查询参数和锚点的 HTTPS 地址'), { code: 'INVALID_AI_SETTINGS' });
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, '');
  return parsed.toString().replace(/\/$/, '');
}

function validateAiModel(value, fieldName) {
  const model = String(value || '').trim();
  if (!/^[A-Za-z0-9._:/-]{2,100}$/.test(model)) throw Object.assign(new Error(`${fieldName}格式无效`), { code: 'INVALID_AI_SETTINGS' });
  return model;
}

export function maskAiApiKey(value) {
  const key = String(value || '').trim();
  if (!key) return '';
  return `******${key.slice(-6)}`;
}

export function redactAiSecrets(value) {
  let text = redactWecomSecrets(value);
  const current = getAiSettings();
  if (current.apiKey) text = text.split(current.apiKey).join('******');
  return text.replace(/(Bearer\s+)[A-Za-z0-9._~+\/-]{8,}/gi, '$1******').replace(/((?:api[_-]?key|dashscope[_-]?api[_-]?key)\s*[=:]\s*)[^\s,;]+/gi, '$1******');
}

export function getAiSettings() {
  const modeSetting = getStoredSetting(AI_SETTING_KEYS.mode);
  const keySetting = getStoredSetting(AI_SETTING_KEYS.apiKey);
  const baseUrlSetting = getStoredSetting(AI_SETTING_KEYS.baseUrl);
  const modelSetting = getStoredSetting(AI_SETTING_KEYS.model);
  const visionSetting = getStoredSetting(AI_SETTING_KEYS.visionModel);
  const extraSettings = Object.fromEntries(EXTRA_MODEL_FIELDS.map(field => [field, getStoredSetting(AI_SETTING_KEYS[field])]));
  const apiKey = keySetting?.value || config.qwenApiKey || '';
  const updated = [modeSetting,keySetting,baseUrlSetting,modelSetting,visionSetting,...Object.values(extraSettings)].filter(Boolean).sort((a,b)=>String(b.updatedAt).localeCompare(String(a.updatedAt)))[0];
  const model = modelSetting?.value || config.qwenModel;
  return {
    mode: modeSetting?.value || config.qwenMode,
    apiKey,
    baseUrl: baseUrlSetting?.value || config.qwenBaseUrl,
    model,
    visionModel: visionSetting?.value || config.qwenVisionModel,
    asrModel: extraSettings.asrModel?.value || config.audioAsrModel,
    contentModel: extraSettings.contentModel?.value || process.env.QWEN_CONTENT_MODEL || model,
    imageContentModel: extraSettings.imageContentModel?.value || process.env.QWEN_IMAGE_CONTENT_MODEL || model,
    trafficPredictionModel: extraSettings.trafficPredictionModel?.value || process.env.QWEN_TRAFFIC_PREDICTION_MODEL || model,
    embeddingModel: extraSettings.embeddingModel?.value || '',
    modelOverrides: Object.fromEntries(EXTRA_MODEL_FIELDS.map(field => [field, extraSettings[field]?.value || ''])),
    configured: Boolean(apiKey),
    maskedApiKey: maskAiApiKey(apiKey),
    source: keySetting ? 'DATABASE' : apiKey ? 'ENVIRONMENT' : 'NONE',
    updatedAt: updated?.updatedAt || null,
    updatedBy: updated?.updatedBy || null
  };
}

export function getAiSettingsSummary() {
  const { apiKey, ...summary } = getAiSettings();
  return summary;
}

export function saveAiSettings(input = {}, updatedBy = '运营席位') {
  const current = getAiSettings();
  const mode = String(input.mode ?? current.mode).trim().toLowerCase();
  if (!['mock','online'].includes(mode)) throw Object.assign(new Error('AI 调用模式只允许 mock 或 online'), { code: 'INVALID_AI_SETTINGS' });
  const baseUrl = validateAiBaseUrl(input.baseUrl ?? current.baseUrl);
  const model = validateAiModel(input.model ?? current.model, '对话模型');
  const visionModel = validateAiModel(input.visionModel ?? current.visionModel, '视觉/OCR 模型');
  const suppliedKey = String(input.apiKey || '').trim();
  const extraModels = Object.fromEntries(EXTRA_MODEL_FIELDS.filter(field => Object.hasOwn(input, field)).map(field => {
    const value = String(input[field] || '').trim();
    return [field, value ? validateAiModel(value, '专用模型') : ''];
  }));
  if (suppliedKey && (suppliedKey.length < 8 || suppliedKey.length > 500 || /\s/.test(suppliedKey))) {
    throw Object.assign(new Error('AI Key 格式无效'), { code: 'INVALID_AI_SETTINGS' });
  }
  if (mode === 'online' && !suppliedKey && !current.apiKey) throw Object.assign(new Error('在线模式必须配置 AI Key'), { code: 'INVALID_AI_SETTINGS' });
  saveEncryptedSetting(AI_SETTING_KEYS.mode, mode, updatedBy);
  saveEncryptedSetting(AI_SETTING_KEYS.baseUrl, baseUrl, updatedBy);
  saveEncryptedSetting(AI_SETTING_KEYS.model, model, updatedBy);
  saveEncryptedSetting(AI_SETTING_KEYS.visionModel, visionModel, updatedBy);
  for (const [field, value] of Object.entries(extraModels)) {
    if (value) saveEncryptedSetting(AI_SETTING_KEYS[field], value, updatedBy);
    else run('DELETE FROM system_settings WHERE setting_key=?', AI_SETTING_KEYS[field]);
  }
  if (suppliedKey) saveEncryptedSetting(AI_SETTING_KEYS.apiKey, suppliedKey, updatedBy);
  return getAiSettingsSummary();
}

export function clearAiApiKey() {
  run('DELETE FROM system_settings WHERE setting_key=?', AI_SETTING_KEYS.apiKey);
  return getAiSettingsSummary();
}

function intervalOptionByBounds(minMs, maxMs) {
  return MESSAGE_COLLECTION_INTERVAL_OPTIONS.find(item => item.minMs === Number(minMs) && item.maxMs === Number(maxMs));
}

export function getMessageCollectionSettings() {
  const setting = getStoredSetting(MESSAGE_COLLECTION_INTERVAL_KEY);
  let selected = null;
  if (setting?.value) {
    try { const parsed = JSON.parse(setting.value); selected = intervalOptionByBounds(parsed.minMs, parsed.maxMs); } catch {}
  }
  selected ||= intervalOptionByBounds(config.messageCollectMinIntervalMs, config.messageCollectMaxIntervalMs) || MESSAGE_COLLECTION_INTERVAL_OPTIONS[3];
  return { ...selected, options: MESSAGE_COLLECTION_INTERVAL_OPTIONS, updatedAt: setting?.updatedAt || null, updatedBy: setting?.updatedBy || null };
}

export function saveMessageCollectionSettings(value, updatedBy = '运营席位') {
  const selected = MESSAGE_COLLECTION_INTERVAL_OPTIONS.find(item => item.value === String(value || ''));
  if (!selected) throw Object.assign(new Error('轮询区间只允许选择页面提供的四个选项'), { code: 'INVALID_MESSAGE_COLLECTION_INTERVAL' });
  saveEncryptedSetting(MESSAGE_COLLECTION_INTERVAL_KEY, JSON.stringify({ minMs: selected.minMs, maxMs: selected.maxMs }), updatedBy);
  return getMessageCollectionSettings();
}

