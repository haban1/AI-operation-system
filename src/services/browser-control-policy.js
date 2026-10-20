import path from 'node:path';

export const BROWSER_ACTIONS = Object.freeze([
  'HEALTH_CHECK',
  'OPEN_PAGE',
  'NAVIGATE',
  'READ_PAGE_STATE',
  'READ_TEXT',
  'CLICK',
  'CLICK_AT',
  'SCROLL',
  'SET_FILES',
  'SCREENSHOT',
  'CLOSE_TAB'
]);

export const BROWSER_PROVIDERS = Object.freeze(['web_access_cdp', 'playwright']);
export const BROWSER_PURPOSES = Object.freeze(['DIAGNOSTIC', 'ASSISTED_NAVIGATION', 'FILE_PREP']);
export const INTERACTIVE_BROWSER_ACTIONS = Object.freeze(['CLICK', 'CLICK_AT', 'SET_FILES']);

const ACTION_SET = new Set(BROWSER_ACTIONS);
const PROVIDER_SET = new Set(BROWSER_PROVIDERS);
const PURPOSE_SET = new Set(BROWSER_PURPOSES);
const INTERACTIVE_SET = new Set(INTERACTIVE_BROWSER_ACTIONS);
const RISKY_SELECTOR = /(publish|submit|send|reply|comment|delete|remove|pay|purchase|checkout|confirm|approve|reject|post|发布|发送|回复|删除|支付|付款|确认|审核)/i;
const FORBIDDEN_PARAM_KEYS = new Set(['eval', 'expression', 'javascript', 'script', 'cookie', 'cookies', 'localstorage', 'sessionstorage', 'password', 'verificationcode', 'captcha']);

function normalizedParamKey(value) {
  return String(value || '').replace(/[-_\s]/g, '').toLowerCase();
}

function policyError(code, message, detail = null) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = 400;
  error.detail = detail;
  return error;
}

function plainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function assertNoForbiddenKeys(value, parent = 'params') {
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) {
    if (FORBIDDEN_PARAM_KEYS.has(normalizedParamKey(key))) throw policyError('BROWSER_COMMAND_FORBIDDEN_FIELD', `浏览器命令禁止包含字段 ${parent}.${key}`);
    if (item && typeof item === 'object') assertNoForbiddenKeys(item, `${parent}.${key}`);
  }
}

function normalizeSelector(value, { required = true, allowRisky = false } = {}) {
  const selector = String(value || '').trim();
  if (!selector && required) throw policyError('BROWSER_SELECTOR_REQUIRED', 'selector 不能为空');
  if (!selector) return null;
  if (selector.length > 500) throw policyError('BROWSER_SELECTOR_TOO_LONG', 'selector 长度不能超过 500');
  if (/javascript:|<script|\beval\s*\(/i.test(selector)) throw policyError('BROWSER_SELECTOR_FORBIDDEN', 'selector 包含禁止内容');
  if (!allowRisky && RISKY_SELECTOR.test(selector)) {
    throw policyError('BROWSER_HIGH_RISK_SELECTOR_BLOCKED', '低级浏览器命令禁止直接点击发布、发送、回复、删除、支付或审核类控件；请使用现有 PUBLISH/REPLY/VERIFY 业务流程');
  }
  return selector;
}

function normalizeUrl(value, allowedHosts) {
  let parsed;
  try { parsed = new URL(String(value || '').trim()); }
  catch { throw policyError('BROWSER_URL_INVALID', 'url 必须是有效的 HTTPS 地址'); }
  if (parsed.protocol !== 'https:') throw policyError('BROWSER_URL_PROTOCOL_BLOCKED', '浏览器控制仅允许 HTTPS 地址');
  if (parsed.username || parsed.password) throw policyError('BROWSER_URL_CREDENTIALS_BLOCKED', 'url 中禁止携带用户名或密码');
  const hostname = parsed.hostname.toLowerCase();
  const allowed = allowedHosts.some(host => hostname === host || hostname.endsWith(`.${host}`));
  if (!allowed) throw policyError('BROWSER_DOMAIN_NOT_ALLOWED', `域名 ${hostname} 不在当前平台白名单中`, { hostname, allowedHosts });
  return parsed.toString();
}

function normalizeConfirmedAt(value) {
  const confirmedAt = String(value || '').trim();
  if (!confirmedAt || Number.isNaN(Date.parse(confirmedAt))) {
    throw policyError('BROWSER_OPERATOR_CONFIRMATION_REQUIRED', '交互式浏览器动作必须提供有效的 operatorConfirmedAt');
  }
  const ageMs = Date.now() - Date.parse(confirmedAt);
  if (ageMs < -5 * 60 * 1000) throw policyError('BROWSER_OPERATOR_CONFIRMATION_FUTURE', 'operatorConfirmedAt 不能晚于当前时间超过 5 分钟');
  if (ageMs > 30 * 60 * 1000) throw policyError('BROWSER_OPERATOR_CONFIRMATION_EXPIRED', 'operatorConfirmedAt 已超过 30 分钟，请重新确认');
  return new Date(confirmedAt).toISOString();
}

export function platformAllowedHosts(platformCode, config = {}) {
  const platform = platformCode === 'xiaohongshu'
    ? { publishUrl: config.xhsCreatorUrl, manageUrl: config.xhsManageUrl, commentUrl: config.xhsCommentUrl, messageUrl: config.xhsMessageUrl }
    : (config.platformRpa?.[platformCode] || {});
  const hosts = new Set((config.browserControlAllowedHosts || []).map(item => String(item).trim().toLowerCase()).filter(Boolean));
  for (const value of Object.values(platform)) {
    try { hosts.add(new URL(value).hostname.toLowerCase()); } catch {}
  }
  return [...hosts];
}

export function normalizeBrowserCommand(input = {}, policy = {}) {
  const action = String(input.action || '').trim().toUpperCase();
  if (!ACTION_SET.has(action)) throw policyError('BROWSER_ACTION_NOT_ALLOWED', `不支持浏览器动作：${action || 'EMPTY'}`);
  const provider = String(input.provider || policy.defaultProvider || 'web_access_cdp').trim().toLowerCase();
  if (!PROVIDER_SET.has(provider)) throw policyError('BROWSER_PROVIDER_NOT_ALLOWED', `不支持浏览器 Provider：${provider}`);
  const purpose = String(input.purpose || 'DIAGNOSTIC').trim().toUpperCase();
  if (!PURPOSE_SET.has(purpose)) throw policyError('BROWSER_PURPOSE_NOT_ALLOWED', `不支持浏览器命令用途：${purpose}`);
  const platformCode = String(input.platformCode || '').trim();
  if (!platformCode || !(policy.activePlatformCodes || []).includes(platformCode)) {
    throw policyError('BROWSER_PLATFORM_NOT_ALLOWED', `浏览器命令必须绑定已支持的平台：${platformCode || 'EMPTY'}`);
  }
  if (Array.isArray(policy.enabledPlatformCodes) && !policy.enabledPlatformCodes.includes(platformCode)) {
    throw policyError('BROWSER_PLATFORM_FEATURE_DISABLED', `平台 ${platformCode} 尚未启用新浏览器控制体系`);
  }

  const accountId = Number(input.accountId);
  if (!Number.isInteger(accountId) || accountId <= 0) throw policyError('BROWSER_ACCOUNT_REQUIRED', '浏览器命令必须绑定有效的 accountId');

  const params = { ...plainObject(input.params) };
  assertNoForbiddenKeys(params);
  const allowedHosts = platformAllowedHosts(platformCode, policy.config || {});
  if (!allowedHosts.length && ['OPEN_PAGE', 'NAVIGATE'].includes(action)) {
    throw policyError('BROWSER_DOMAIN_ALLOWLIST_EMPTY', `平台 ${platformCode} 未配置可访问域名`);
  }

  if (['OPEN_PAGE', 'NAVIGATE'].includes(action)) params.url = normalizeUrl(params.url, allowedHosts);
  if (['CLICK', 'CLICK_AT'].includes(action)) params.selector = normalizeSelector(params.selector);
  if (action === 'READ_TEXT') {
    params.selector = normalizeSelector(params.selector, { required: false, allowRisky: true });
    params.maxChars = Math.max(200, Math.min(20_000, Number(params.maxChars) || 8_000));
  }
  if (action === 'SCROLL') {
    params.direction = ['up', 'down', 'top', 'bottom'].includes(String(params.direction || '').toLowerCase()) ? String(params.direction).toLowerCase() : 'down';
    params.y = Math.max(1, Math.min(10_000, Math.abs(Number(params.y) || 1200)));
  }
  if (action === 'SET_FILES') {
    params.selector = normalizeSelector(params.selector, { allowRisky: true });
    if (!Array.isArray(params.files) || !params.files.length || params.files.length > 10) throw policyError('BROWSER_FILES_INVALID', 'files 必须包含 1-10 个本地文件路径');
    params.files = params.files.map(item => path.resolve(String(item || '')));
    const allowedRoots = policy.config?.browserControlFileRoots || [];
    for (const file of params.files) {
      if (!pathInsideRoots(file, allowedRoots)) throw policyError('BROWSER_FILE_PATH_BLOCKED', `文件不在允许目录中：${file}`, { roots: allowedRoots });
    }
  }

  let operatorConfirmedAt = null;
  if (INTERACTIVE_SET.has(action)) {
    if (!policy.interactiveEnabled) throw policyError('BROWSER_INTERACTIVE_DISABLED', '交互式浏览器动作默认关闭；请先启用 BROWSER_CONTROL_INTERACTIVE_ENABLED');
    if (action === 'CLICK' || action === 'CLICK_AT') {
      if (purpose !== 'ASSISTED_NAVIGATION') throw policyError('BROWSER_PURPOSE_MISMATCH', `${action} 仅允许用于 ASSISTED_NAVIGATION`);
    }
    if (action === 'SET_FILES' && purpose !== 'FILE_PREP') throw policyError('BROWSER_PURPOSE_MISMATCH', 'SET_FILES 仅允许用于 FILE_PREP');
    operatorConfirmedAt = normalizeConfirmedAt(input.operatorConfirmedAt);
  }

  return {
    action,
    provider,
    purpose,
    platformCode,
    accountId,
    sessionId: input.sessionId ? String(input.sessionId).trim().slice(0, 200) : null,
    params,
    allowedHosts,
    interactive: INTERACTIVE_SET.has(action),
    confirmationRequired: INTERACTIVE_SET.has(action),
    operatorConfirmedAt
  };
}

export function isBrowserCommandNonIdempotent(command = {}) {
  return INTERACTIVE_SET.has(String(command.action || '').toUpperCase());
}

export function pathInsideRoots(filePath, roots = []) {
  const resolved = path.resolve(filePath);
  return roots.some(root => {
    const base = path.resolve(root);
    const relative = path.relative(base, resolved);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  });
}
