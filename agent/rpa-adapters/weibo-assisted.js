import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { AssistedPlatformRpaAdapter, recoveryCollectionFailure, recoveryCollectionTargets } from './assisted-platform.js';
import { resolveUploadTimeoutMs } from '../publish-upload-timeout.js';
import { normalizeContentOrigin } from './publish-guard.js';
import { assessWeiboConversationSource } from '../../src/services/weibo-message-source.js';

const VERIFY_URL_RE = /(?:captcha|challenge|verify|security-check|risk-check)/i;
const VERIFY_TEXT_RE = /请(?:先)?(?:完成|进行).{0,12}(?:安全|身份|人脸|滑块)?验证|(?:拖动|按住).{0,12}滑块|访问(?:过于)?频繁.{0,20}(?:验证|稍后再试)|账号.{0,12}(?:异常|风险).{0,12}(?:验证|解封)|环境异常.{0,12}(?:验证|重试)/i;
const VERIFY_SELECTORS = ['iframe[src*="captcha" i]', 'iframe[src*="verify" i]', 'iframe[src*="challenge" i]', '[id*="captcha" i]', '[class*="captcha" i]', '[class*="geetest" i]', '[role="dialog"] [class*="verify" i]', '[role="dialog"] [class*="challenge" i]'];
const PAGE_ERROR_RE = /无法访问此网站|网页无法打开|连接已重置|ERR_[A-Z_]+|404\s*not\s*found|502\s*bad\s*gateway|服务暂不可用|系统繁忙|页面不存在/i;
const CHAT_RE = /^https:\/\/api\.weibo\.com\/chat\/#\/(?:chat)?(?:[/?]|$)/i;
const LOGIN_URL_RE = /passport\.weibo\.com|\/(?:new)?login(?:[/?#]|$)/i;
const COMMENT_INBOX_RE = /^https:\/\/(?:www\.)?weibo\.com\/comment\/inbox(?:[/?#]|$)/i;
const COMMENT_INBOX_TEXT_RE = /收到的评论.{0,20}关注人的评论.{0,20}发出的评论/i;
const HOME_RE = /^https:\/\/(?:www\.)?weibo\.com\/(?:$|u\/|profile|mygroups|hot|messages|comment\/inbox|at\/)/i;
const WEIBO_PUBLISH_ENDPOINT_RE = /\/(?:ajax\/)?statuses\/(?:update|create)(?:[/?]|$)|\/2\/statuses\/update\.json(?:[/?]|$)/i;
const WEIBO_COMMENT_CURSOR_LIMIT = 300;
const WEIBO_PRIVATE_MESSAGE_CURSOR_LIMIT = 120;
const WEIBO_COMMENT_FULL_SWEEP_MS = 30 * 60 * 1000;
const WEIBO_PRIVATE_FULL_SWEEP_MS = 20 * 60 * 1000;

function clean(value) { return String(value ?? '').replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\s+/g, ' ').trim(); }
function digest(parts) { return crypto.createHash('sha256').update(parts.map(clean).join('|')).digest('hex').slice(0, 24); }
function normalizeUrl(value, base = 'https://weibo.com/') {
  const raw = clean(value); if (!raw) return null;
  try { return new URL(raw.startsWith('//') ? `https:${raw}` : raw, base).href; } catch { return null; }
}
function commentIdFromUrl(value) { try { return clean(new URL(normalizeUrl(value)).searchParams.get('cid')) || null; } catch { return null; } }
function weiboPostIdFromUrl(value) {
  try {
    const url = new URL(normalizeUrl(value));
    const parts = url.pathname.split('/').map(clean).filter(Boolean);
    const candidate = parts.at(-1);
    return /^[A-Za-z0-9_-]{5,}$/.test(candidate || '') ? candidate : null;
  } catch { return null; }
}

function weiboCommentDetailIdentity(payload = {}) {
  const context = payload.messageContext || payload.context || {};
  const externalUrl = normalizeUrl(payload.externalUrl || context.postUrl);
  const commentId = clean(context.commentId || context.cid || commentIdFromUrl(externalUrl));
  const postId = clean(context.postId || context.contentId || context.sourcePostId || weiboPostIdFromUrl(externalUrl));
  let ownerUid = null;
  try {
    const parsed = new URL(externalUrl);
    const parts = parsed.pathname.split('/').map(clean).filter(Boolean);
    if (parts.length >= 2 && /^\d{5,}$/.test(parts[0])) ownerUid = parts[0];
  } catch {}
  return { externalUrl, commentId, postId, ownerUid };
}

export function assessWeiboCommentDetailReplyEvidence({
  requestedUrl = '', finalUrl = '', expectedCommentId = '', expectedPostId = '', ownerUid = null,
  sourceMatchCount = 0, authoredReplyCount = 0
} = {}) {
  const requested = normalizeUrl(requestedUrl);
  const final = normalizeUrl(finalUrl);
  if (!requested || !final) return { handled: false, reason: 'COMMENT_DETAIL_URL_MISSING' };
  let requestedParsed;
  let finalParsed;
  try { requestedParsed = new URL(requested); finalParsed = new URL(final); }
  catch { return { handled: false, reason: 'COMMENT_DETAIL_URL_INVALID' }; }
  const weiboHost = hostname => /(^|\.)weibo\.com$/i.test(clean(hostname));
  if (!weiboHost(requestedParsed.hostname) || !weiboHost(finalParsed.hostname)) return { handled: false, reason: 'COMMENT_DETAIL_HOST_MISMATCH' };
  const commentId = clean(expectedCommentId);
  const postId = clean(expectedPostId);
  if (!stableNumericId(commentId)) return { handled: false, reason: 'COMMENT_ID_MISSING' };
  if (!postId) return { handled: false, reason: 'STABLE_POST_ID_REQUIRED' };
  if (clean(requestedParsed.searchParams.get('cid')) !== commentId || clean(finalParsed.searchParams.get('cid')) !== commentId) {
    return { handled: false, reason: 'COMMENT_DETAIL_ANCHOR_MISMATCH' };
  }
  if (weiboPostIdFromUrl(requested) !== postId || weiboPostIdFromUrl(final) !== postId) {
    return { handled: false, reason: 'COMMENT_DETAIL_POST_MISMATCH' };
  }
  if (!/^\d{5,}$/.test(clean(ownerUid))) return { handled: false, reason: 'COMMENT_DETAIL_OWNER_MISSING' };
  if (Number(sourceMatchCount) < 1) return { handled: false, reason: 'COMMENT_DETAIL_SOURCE_NOT_VISIBLE' };
  if (Number(authoredReplyCount) < 1) return { handled: false, reason: 'COMMENT_DETAIL_REPLY_NOT_VISIBLE' };
  return {
    handled: true,
    reason: 'COMMENT_DETAIL_AUTHORED_REPLY_EXACT',
    targetIdentityVerified: true,
    uniqueTargetMatch: true
  };
}
function normalizeSentCommentText(value) {
  return clean(value)
    .replace(/\s*([:：])\s*/g, ':')
    .replace(/回复\s+@/g, '回复@');
}

export function assessWeiboSentCommentReplyEvidence({
  expectedUserName = '', expectedSourceContent = '', expectedReply = '', expectedPostId = '', candidates = []
} = {}) {
  const userName = clean(expectedUserName);
  const sourceContent = clean(expectedSourceContent);
  const replyText = clean(expectedReply);
  const postId = clean(expectedPostId);
  if (!userName) return { handled: false, reason: 'SENT_COMMENT_USER_MISSING', matchCount: 0 };
  if (!sourceContent) return { handled: false, reason: 'SENT_COMMENT_SOURCE_MISSING', matchCount: 0 };
  if (!replyText) return { handled: false, reason: 'SENT_COMMENT_REPLY_MISSING', matchCount: 0 };
  if (!postId) return { handled: false, reason: 'STABLE_POST_ID_REQUIRED', matchCount: 0 };
  const replyMarker = normalizeSentCommentText(`回复@${userName}:${replyText}`);
  const sourceMarker = normalizeSentCommentText(`@${userName}:${sourceContent}`);
  const matches = (Array.isArray(candidates) ? candidates : []).filter(candidate => {
    const rowText = normalizeSentCommentText(candidate?.rowText);
    const postIds = [...new Set((Array.isArray(candidate?.postIds) ? candidate.postIds : [candidate?.postId]).map(clean).filter(Boolean))];
    return rowText.includes(replyMarker) && rowText.includes(sourceMarker) && postIds.includes(postId);
  });
  if (matches.length !== 1) {
    return {
      handled: false,
      reason: matches.length ? 'SENT_COMMENT_TARGET_AMBIGUOUS' : 'SENT_COMMENT_TARGET_REPLY_NOT_VISIBLE',
      matchCount: matches.length,
      targetIdentityVerified: false,
      uniqueTargetMatch: false
    };
  }
  return {
    handled: true,
    reason: 'SENT_COMMENT_TARGET_REPLY_EXACT',
    matchCount: 1,
    targetIdentityVerified: true,
    uniqueTargetMatch: true,
    match: matches[0]
  };
}
function validIso(value) { const parsed = Date.parse(clean(value)); return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null; }
function positiveNumber(value) { const number = Number(value); return Number.isFinite(number) && number > 0 ? number : null; }
function uniqueStableIds(values = [], limit = WEIBO_PRIVATE_MESSAGE_CURSOR_LIMIT) {
  return [...new Set((Array.isArray(values) ? values : []).map(clean).filter(stableNumericId))].slice(-Math.max(1, Number(limit) || 1));
}
function privateCursorKey(conversation = {}) {
  const stable = clean(conversation.conversationKey);
  return stable || `name-${digest([conversation.userName])}`;
}
function privatePreviewHash(conversation = {}) { return digest([conversation.userName, conversation.preview, conversation.eventTime]); }
function fullSweepDue(lastFullSweepAt, intervalMs, nowMs = Date.now()) {
  const previous = Date.parse(clean(lastFullSweepAt));
  return !Number.isFinite(previous) || nowMs - previous >= Math.max(60_000, Number(intervalMs) || 0);
}
async function visible(locator) { return Boolean(locator && await locator.isVisible().catch(() => false)); }
async function firstVisible(locators, enabled = false) {
  for (const locator of locators) {
    const count = Math.min(await locator?.count?.().catch(() => 0) || 0, 30);
    for (let i = 0; i < count; i += 1) {
      const item = locator.nth(i);
      if (await visible(item) && (!enabled || await item.isEnabled().catch(() => true))) return item;
    }
  }
  return null;
}

async function firstAttached(locators) {
  for (const locator of locators) {
    const count = Math.min(await locator?.count?.().catch(() => 0) || 0, 30);
    if (count > 0) return locator.first();
  }
  return null;
}

async function uniqueVisibleExact(page, labels = []) {
  for (const label of labels) {
    for (const locator of [
      page.getByRole?.('option', { name: label, exact: true }),
      page.getByRole?.('button', { name: label, exact: true }),
      page.getByText?.(label, { exact: true })
    ].filter(Boolean)) {
      const matches = [];
      const count = Math.min(await locator.count().catch(() => 0), 30);
      for (let index = 0; index < count; index += 1) {
        const candidate = locator.nth(index);
        if (await visible(candidate) && await candidate.isEnabled().catch(() => true)) matches.push(candidate);
      }
      if (matches.length === 1) return { status: 'UNIQUE', locator: matches[0], label };
      if (matches.length > 1) return { status: 'AMBIGUOUS', locator: null, label, count: matches.length };
    }
  }
  return { status: 'MISSING', locator: null, label: null, count: 0 };
}

async function visibleExactCount(page, labels = []) {
  let total = 0;
  for (const label of labels) {
    const locator = page.getByText?.(label, { exact: true });
    const count = Math.min(await locator?.count?.().catch(() => 0) || 0, 30);
    for (let index = 0; index < count; index += 1) if (await visible(locator.nth(index))) total += 1;
  }
  return total;
}

export function dedupeWeiboPublishMatches(values = []) {
  const normalized = values.map(item => ({
    ...item,
    text: clean(item?.text),
    externalUrl: normalizeUrl(item?.externalUrl || item?.href),
    eventTime: clean(item?.eventTime)
  })).filter(item => item.text);
  const result = [];
  const urls = new Set();
  for (const item of normalized.filter(candidate => candidate.externalUrl)) {
    if (urls.has(item.externalUrl)) continue;
    urls.add(item.externalUrl);
    result.push(item);
  }
  for (const item of normalized.filter(candidate => !candidate.externalUrl)) {
    // ????????? article ?????????????????????????
    // ??????????????????????????????????
    const nestedDuplicate = result.some(candidate => candidate.externalUrl && Math.min(candidate.text.length, item.text.length) >= 12
      && (candidate.text.includes(item.text) || item.text.includes(candidate.text)));
    if (!nestedDuplicate) result.push(item);
  }
  return result;
}
export function weiboContentDeclarationLabels(origin) {
  const normalized = normalizeContentOrigin(origin);
  if (normalized === 'AI_GENERATED') return ['\u5185\u5bb9\u7531\u0041\u0049\u751f\u6210', '\u0041\u0049\u751f\u6210\u6216\u5305\u542b\u0041\u0049\u751f\u6210\u5185\u5bb9', '\u542b\u0041\u0049\u751f\u6210\u5185\u5bb9', '\u0041\u0049\u751f\u6210\u5185\u5bb9', '\u7531\u0041\u0049\u751f\u6210', '\u5305\u542b\u0041\u0049\u751f\u6210\u5185\u5bb9'];
  if (normalized === 'HUMAN_ORIGINAL') return ['\u6211\u7684\u5185\u5bb9\u65e0\u9700\u58f0\u660e', '\u4e2a\u4eba\u539f\u521b', '\u672c\u4eba\u539f\u521b', '\u539f\u521b\u5185\u5bb9', '\u975e\u0041\u0049\u751f\u6210\u5185\u5bb9', '\u771f\u4eba\u539f\u521b'];
  return [];
}
async function fillEditor(editor, text) {
  const tag = await editor.evaluate(el => el.tagName.toLowerCase()).catch(() => '');
  if (tag === 'textarea' || tag === 'input') return editor.fill(text);
  await editor.click(); await editor.press('Control+A').catch(() => {}); await editor.press('Backspace').catch(() => {});
  await editor.fill(text).catch(() => editor.evaluate((el, value) => {
    el.focus(); el.textContent = value; el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
  }, text));
}
async function editorValue(editor) { return clean(await editor.inputValue().catch(async () => await editor.innerText().catch(async () => await editor.textContent().catch(() => '')))); }

export function matchWeiboCommentIdentity(candidate = {}, payload = {}) {
  const context = payload.messageContext || payload.context || {};
  const expected = { userName: clean(payload.userName), content: clean(payload.sourceContent), commentId: clean(context.commentId || context.cid || commentIdFromUrl(payload.externalUrl)), eventTime: clean(context.eventTime) };
  const actual = { userName: clean(candidate.userName), content: clean(candidate.content), commentId: clean(candidate.commentId), eventTime: clean(candidate.eventTime) };
  if (!expected.userName || !expected.content) return { matched: false, reason: 'IDENTITY_FIELDS_MISSING', expected, actual };
  if (actual.userName !== expected.userName) return { matched: false, reason: 'USER_MISMATCH', expected, actual };
  if (actual.content !== expected.content) return { matched: false, reason: 'CONTENT_MISMATCH', expected, actual };
  if (expected.commentId ? actual.commentId !== expected.commentId : (!expected.eventTime || actual.eventTime !== expected.eventTime)) return { matched: false, reason: 'STABLE_IDENTITY_MISMATCH', expected, actual };
  return { matched: true, reason: 'WEIBO_COMMENT_IDENTITY_EXACT', expected, actual };
}

export function parseWeiboEventTime(value, nowMs = Date.now()) {
  const text = clean(value); if (!text) return null;
  if (/刚刚/.test(text)) return nowMs;
  let m = text.match(/(\d+)\s*分钟前/); if (m) return nowMs - Number(m[1]) * 60_000;
  m = text.match(/(\d+)\s*小时前/); if (m) return nowMs - Number(m[1]) * 3_600_000;
  m = text.match(/今天\s*(\d{1,2}):(\d{2})/); if (m) { const d = new Date(nowMs); d.setHours(+m[1], +m[2], 0, 0); return d.getTime(); }
  m = text.match(/昨天\s*(\d{1,2}):(\d{2})/); if (m) { const d = new Date(nowMs); d.setDate(d.getDate() - 1); d.setHours(+m[1], +m[2], 0, 0); return d.getTime(); }
  m = text.match(/(?:(\d{4})[-年\/])?(\d{1,2})[-月\/](\d{1,2})(?:日)?(?:\s+(\d{1,2}):(\d{2}))?/);
  if (m) { const d = new Date(nowMs); return new Date(m[1] ? +m[1] : d.getFullYear(), +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0)).getTime(); }
  const parsed = Date.parse(text); return Number.isFinite(parsed) ? parsed : null;
}

export function matchWeiboPrivateMessageIdentity(candidate = {}, payload = {}) {
  const context = payload.messageContext || payload.context || {};
  const expected = { content: clean(payload.sourceContent), messageId: clean(context.messageId), direction: 'incoming' };
  const actual = { content: clean(candidate.content), messageId: clean(candidate.messageId), direction: clean(candidate.direction).toLowerCase() };
  if (!expected.content || !expected.messageId) return { matched: false, reason: 'PRIVATE_SOURCE_MISSING', expected, actual };
  if (actual.direction !== 'incoming') return { matched: false, reason: 'PRIVATE_DIRECTION_MISMATCH', expected, actual };
  if (expected.messageId && actual.messageId !== expected.messageId) return { matched: false, reason: 'PRIVATE_MESSAGE_ID_MISMATCH', expected, actual };
  if (actual.content !== expected.content) return { matched: false, reason: 'PRIVATE_CONTENT_MISMATCH', expected, actual };
  return { matched: true, reason: expected.messageId ? 'WEIBO_PRIVATE_MESSAGE_ID_EXACT' : 'WEIBO_PRIVATE_CONTENT_EXACT', expected, actual };
}


function stableNumericId(value) { return /^\d{6,}$/.test(clean(value)); }

export function validateWeiboReplyPayload(payload = {}) {
  const messageType = String(payload.messageType || '').trim().toUpperCase();
  const context = payload.messageContext || payload.context || {};
  if (!clean(payload.replyText)) return { ok: false, reason: 'REPLY_TEXT_EMPTY', message: 'Reply text is empty; sending is blocked.' };
  if (context.historical === true) return { ok: false, reason: 'HISTORICAL_MESSAGE', message: 'Historical messages cannot be auto-replied.' };
  if (!clean(payload.userName) || !clean(payload.sourceContent)) return { ok: false, reason: 'SOURCE_IDENTITY_MISSING', message: 'Source user or source content is missing.' };
  if (messageType === 'COMMENT') {
    if (!stableNumericId(context.commentId || context.cid || commentIdFromUrl(payload.externalUrl))) return { ok: false, reason: 'COMMENT_ID_MISSING', message: 'A stable commentId is required.' };
    if (context.sourceVerified !== true) return { ok: false, reason: 'COMMENT_SOURCE_UNVERIFIED', message: 'The comment source is not verified.' };
    return { ok: true, reason: 'COMMENT_SOURCE_VERIFIED', messageType };
  }
  if (messageType === 'PRIVATE_MESSAGE') {
    if (context.sourceType === 'OFFICIAL_OR_SYSTEM' || context.officialSource === true) return { ok: false, reason: 'PRIVATE_OFFICIAL_SOURCE', message: 'Official or system conversations cannot be replied to automatically.' };
    if (context.previewOnly === true) return { ok: false, reason: 'PRIVATE_PREVIEW_ONLY', message: 'Conversation previews cannot be auto-replied.' };
    if (!stableNumericId(context.messageId)) return { ok: false, reason: 'PRIVATE_MESSAGE_ID_MISSING', message: 'A stable private messageId is required.' };
    if (clean(context.direction).toLowerCase() !== 'incoming' || context.sourceVerified !== true || context.chatTitleVerified !== true) return { ok: false, reason: 'PRIVATE_SOURCE_UNVERIFIED', message: 'The incoming private message source is not verified.' };
    return { ok: true, reason: 'PRIVATE_SOURCE_VERIFIED', messageType };
  }
  return { ok: false, reason: 'MESSAGE_TYPE_UNSUPPORTED', message: `Unsupported message type: ${messageType || 'UNKNOWN'}` };
}

export function classifyWeiboPublishNetworkEvidence({ url = '', status = 0, body = null } = {}) {
  const requestUrl = clean(url);
  if (!WEIBO_PUBLISH_ENDPOINT_RE.test(requestUrl)) return { kind: 'IGNORED', confirmed: false, requestUrl, status: Number(status) || 0 };
  const httpStatus = Number(status) || 0;
  const root = body && typeof body === 'object' ? body : {};
  const data = root.data && typeof root.data === 'object' ? root.data : {};
  const code = clean(root.code ?? root.error_code ?? root.errno);
  const message = clean(root.message ?? root.msg ?? root.error ?? data.message ?? data.msg);
  const platformPostId = clean(data.idstr ?? data.mblogid ?? data.mid ?? data.id ?? root.idstr ?? root.mblogid ?? root.mid ?? root.id) || null;
  const rawUrl = clean(data.url ?? data.scheme ?? root.url ?? root.scheme);
  const platformUrl = normalizeUrl(rawUrl) || (platformPostId ? `https://weibo.com/detail/${platformPostId}` : null);
  const explicitFailure = httpStatus >= 400 || root.ok === 0 || root.success === false || Boolean(root.error_code)
    || (code && !['0', '100000', '200'].includes(code) && /失败|错误|异常|拒绝|频繁|上限|error|fail|invalid|denied/i.test(`${code} ${message}`));
  if (explicitFailure) {
    return { kind: 'FAILURE', confirmed: true, requestUrl, status: httpStatus, code: code || null, message: message || `HTTP ${httpStatus}`, platformPostId: null, platformUrl: null };
  }
  const explicitSuccess = httpStatus >= 200 && httpStatus < 300
    && (root.ok === 1 || root.success === true || ['0', '100000', '200'].includes(code) || Boolean(platformPostId));
  if (!explicitSuccess) return { kind: 'UNCONFIRMED', confirmed: false, requestUrl, status: httpStatus, code: code || null, message: message || null, platformPostId, platformUrl };
  return { kind: 'SUCCESS', confirmed: true, requestUrl, status: httpStatus, code: code || null, message: message || null, platformPostId, platformUrl };
}

export function assessWeiboPublishReceipt({ baselineEchoCount = 0, scopedEchoCount = 0, baselineSuccessSignalCount = 0, successSignalCount = 0, editorCleared = false, networkEvidence = null } = {}) {
  const newFeedEcho = Number(scopedEchoCount) > Number(baselineEchoCount);
  const newSuccessSignal = Number(successSignalCount) > Number(baselineSuccessSignalCount);
  const networkConfirmed = networkEvidence?.kind === 'SUCCESS' && networkEvidence?.confirmed === true;
  const explicitFailure = networkEvidence?.kind === 'FAILURE' && networkEvidence?.confirmed === true;
  return {
    confirmed: !explicitFailure && (networkConfirmed || (editorCleared === true && (newFeedEcho || newSuccessSignal))),
    explicitFailure,
    networkConfirmed,
    networkEvidence: networkEvidence || null,
    editorCleared: editorCleared === true,
    baselineEchoCount: Number(baselineEchoCount) || 0,
    scopedEchoCount: Number(scopedEchoCount) || 0,
    baselineSuccessSignalCount: Number(baselineSuccessSignalCount) || 0,
    successSignalCount: Number(successSignalCount) || 0,
    newFeedEcho,
    newSuccessSignal
  };
}

async function uniqueVisibleFromLocator(locator, { enabled = false } = {}) {
  const matches = [];
  for (let index = 0, count = Math.min(await locator?.count?.().catch(() => 0) || 0, 50); index < count; index += 1) {
    const candidate = locator.nth(index);
    if (await visible(candidate) && (!enabled || await candidate.isEnabled().catch(() => true))) matches.push(candidate);
  }
  return { locator: matches.length === 1 ? matches[0] : null, count: matches.length };
}

function eventMetadata(value, nowMs = Date.now(), maxAgeMs = 7 * 24 * 60 * 60 * 1000) {
  const eventTimeMs = parseWeiboEventTime(value, nowMs);
  return { eventTimeMs: Number.isFinite(eventTimeMs) ? eventTimeMs : null, historical: Number.isFinite(eventTimeMs) ? nowMs - eventTimeMs > maxAgeMs : false };
}


export class WeiboAssistedRpaAdapter extends AssistedPlatformRpaAdapter {
  constructor(options = {}) {
    super({ ...options, platformCode: 'weibo', spec: {
      ...(options.spec || {}), name: '微博', hostHints: ['weibo.com', 'api.weibo.com'],
      publishUrl: options.spec?.publishUrl || 'https://weibo.com/', manageUrl: options.spec?.manageUrl || 'https://weibo.com/',
      commentUrl: options.spec?.commentUrl || 'https://weibo.com/comment/inbox', messageUrl: options.spec?.messageUrl || 'https://api.weibo.com/chat/#/chat',
      verificationPolicyId: 'weibo-publish-status-v1',
      verifyPageUrlPattern: /^https:\/\/(?:www\.)?weibo\.com\//i,
      contentDeclarationRequired: true
    } });
    this.conversationSourceOptions = options.conversationSourceOptions || {};
    this.loginInspectionPage = null;
    this.loginRecheckPage = null;
  }

  async stop() {
    this.loginInspectionPage = null;
    this.loginRecheckPage = null;
    return super.stop();
  }

  async assertWeiboOperationAllowed(operationGeneration = this.lifecycleGeneration) {
    await this.assertRuntimeAllowed();
    if (operationGeneration !== this.lifecycleGeneration) throw this.platformStoppedError();
    return true;
  }

  async inspectLoginState(page) {
    const url = page.url(); const text = clean(await page.locator('body').innerText({ timeout: 5000 }).catch(() => '')).slice(0, 30000);
    const visibleChallengeSelectors = [];
    for (const selector of VERIFY_SELECTORS) if (await visible(page.locator(selector).first())) visibleChallengeSelectors.push(selector);
    if (visibleChallengeSelectors.length) return { state: 'VERIFY_REQUIRED', evidence: visibleChallengeSelectors.map(selector => `verification-selector:${selector}`) };
    if (LOGIN_URL_RE.test(url)) return { state: 'LOGIN', evidence: ['login-url'] };
    for (const selector of ['input[placeholder*="手机号"]', 'input[placeholder*="密码"]', 'form[action*="login" i]', '[class*="LoginModal"]', '[class*="loginBox"]']) if (await visible(page.locator(selector).first())) return { state: 'LOGIN', evidence: [`logged-out-selector:${selector}`] };
    if (CHAT_RE.test(url)) {
      for (const selector of ['ul.contactslist', 'li.sessionlist', '.one-line.username', '.lastmsg', 'textarea', '[contenteditable="true"]']) {
        if (await visible(page.locator(selector).first())) return { state: 'READY', evidence: ['authenticated-url:weibo-chat', `authenticated-selector:${selector}`] };
      }
      if (/您还未选中或发起聊天|查找联系人或群|联系人|群发消息/.test(text)) return { state: 'READY', evidence: ['authenticated-url:weibo-chat', 'authenticated-text'] };
      if (VERIFY_URL_RE.test(url) || VERIFY_TEXT_RE.test(text)) return { state: 'VERIFY_REQUIRED', evidence: ['verification-challenge'] };
      if (PAGE_ERROR_RE.test(`${url} ${text}`)) return { state: 'ERROR', evidence: ['page-error'] };
      return { state: 'UNKNOWN', evidence: ['weibo-chat-shell-unconfirmed'] };
    }
    if (PAGE_ERROR_RE.test(`${url} ${text}`)) return { state: 'ERROR', evidence: ['page-error'] };
    if (COMMENT_INBOX_RE.test(url)) {
      if (VERIFY_URL_RE.test(url) || VERIFY_TEXT_RE.test(text)) return { state: 'VERIFY_REQUIRED', evidence: ['verification-challenge'] };
      if (COMMENT_INBOX_TEXT_RE.test(text) && await visible(page.locator('.wbpro-tab2').first())) {
        return { state: 'READY', evidence: ['authenticated-url:weibo-comment', 'authenticated-selector:.wbpro-tab2', 'authenticated-text:weibo-comment-tabs'] };
      }
    }
    if (HOME_RE.test(url)) {
      for (const selector of ['header [class*="woo-avatar-main"]', 'nav [class*="woo-avatar-main"]', '[class*="Frame_top"] [class*="woo-avatar-main"]', '[class*="Header"] [class*="woo-avatar-main"]']) if (await visible(page.locator(selector).first())) return { state: 'READY', evidence: ['authenticated-url', `authenticated-selector:${selector}`] };
      if (VERIFY_URL_RE.test(url) || VERIFY_TEXT_RE.test(text)) return { state: 'VERIFY_REQUIRED', evidence: ['verification-challenge'] };
      return { state: 'UNKNOWN', evidence: ['weibo-home-identity-unconfirmed'] };
    }
    if (VERIFY_URL_RE.test(url) || VERIFY_TEXT_RE.test(text)) return { state: 'VERIFY_REQUIRED', evidence: ['verification-challenge'] };
    return { state: 'UNKNOWN', evidence: ['no-authenticated-evidence'] };
  }

  async findExistingLoginEvidence() {
    const pages = this.context?.pages?.() || [];
    let authenticated = null;
    let verification = null;
    let loggedOut = null;
    let pageError = null;
    for (const page of pages) {
      if (!page || page.isClosed?.()) continue;
      const url = page.url?.() || '';
      if (!this.spec.hostHints.some(host => url.includes(host))) continue;
      const inspection = await this.inspectLoginState(page);
      if (inspection.state === 'READY' && !authenticated) authenticated = { page, inspection };
      else if (inspection.state === 'VERIFY_REQUIRED' && !verification) verification = { page, inspection };
      else if (inspection.state === 'LOGIN' && !loggedOut) loggedOut = { page, inspection };
      else if (inspection.state === 'ERROR' && !pageError) pageError = { page, inspection };
    }
    return authenticated || verification || loggedOut || pageError;
  }

  async findInteractiveLoginPage() {
    const candidate = await this.findExistingLoginEvidence();
    return candidate && ['LOGIN', 'VERIFY_REQUIRED'].includes(candidate.inspection.state) ? candidate : null;
  }

  async getLoginInspectionPage() {
    const context = await this.ensureContext();
    if (this.loginInspectionPage && !this.loginInspectionPage.isClosed?.()) return this.loginInspectionPage;
    this.loginInspectionPage = await context.newPage();
    return this.loginInspectionPage;
  }

  async inspectCapabilityOnCurrentPage(page, capability) {
    const login = await this.inspectLoginState(page);
    if (['LOGIN', 'VERIFY_REQUIRED', 'ERROR'].includes(login.state)) return { state: login.state === 'LOGIN' ? 'LOGIN_REQUIRED' : login.state, evidence: login.evidence || [], url: page.url() };
    const selectorGroups = {
      publish: ['textarea[placeholder*="新鲜事"]', 'input[type="file"]'],
      comment: ['.wbpro-scroller-item', '.wbpro-scroller', '.wbpro-tab2'],
      privateMessage: ['li.sessionlist', 'ul.contactslist', '.message', 'textarea', '[contenteditable="true"]']
    };
    const matched = [];
    for (const selector of selectorGroups[capability] || []) {
      if (await visible(page.locator(selector).first())) matched.push(selector);
    }
    if (matched.length) return { state: 'READY', evidence: [...new Set([...(login.evidence || []), ...matched])], url: page.url() };
    if (login.state === 'READY') return { state: 'REACHABLE', evidence: login.evidence || [], url: page.url() };
    return { state: login.state, evidence: login.evidence || [], url: page.url() };
  }

  async inspectFunctionalCapabilities(page) {
    const capabilities = {};
    const targets = [
      ['publish', this.spec.publishUrl],
      ['comment', this.spec.commentUrl],
      ['privateMessage', this.spec.messageUrl]
    ];
    for (const [name, url] of targets) {
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
        await page.waitForTimeout(700);
        capabilities[name] = await this.inspectCapabilityOnCurrentPage(page, name);
      } catch (error) {
        capabilities[name] = { state: 'ERROR', evidence: ['capability-probe-error'], url: page.url?.() || url, message: error.message };
      }
    }
    return capabilities;
  }

  async checkLogin({ preserveInteractiveLogin = true } = {}) {
    await this.ensureContext();
    let page = null;
    if (preserveInteractiveLogin) {
      const existing = await this.findExistingLoginEvidence();
      if (existing?.inspection.state === 'READY') page = existing.page;
      else if (existing && ['LOGIN', 'VERIFY_REQUIRED'].includes(existing.inspection.state)) {
        this.loginRecheckPage = existing.page;
        return this.status(existing.page, { checked: true });
      }
    }
    page ||= await this.getLoginInspectionPage();
    await page.goto(this.spec.messageUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForTimeout(1_200);
    let base = await this.status(page, { checked: true });
    this.loginRecheckPage = page;
    if (base.state === 'UNKNOWN') base = await this.recheckLogin(page);
    if (base.state !== 'READY') return base;
    const capabilities = await this.inspectFunctionalCapabilities(page);
    const labels = { publish: '发布', comment: '评论', privateMessage: '私信' };
    const capabilitySummary = Object.entries(capabilities).map(([name, item]) => `${labels[name]}${item.state === 'READY' ? '可用' : item.state === 'REACHABLE' ? '页面可访问' : item.state === 'VERIFY_REQUIRED' ? '需要验证' : item.state === 'LOGIN_REQUIRED' ? '未登录' : item.state === 'ERROR' ? '检查失败' : '无法确认'}`).join('，');
    const evidence = [...new Set([...(base.evidence || []), ...Object.entries(capabilities).map(([name, item]) => `functional-capability:${name}:${item.state}`)])];
    const messagingEntries = [['comment', capabilities.comment], ['privateMessage', capabilities.privateMessage]];
    const challenged = messagingEntries.find(([, item]) => item?.state === 'VERIFY_REQUIRED');
    if (challenged) return { ...base, loggedIn: false, identityLoggedIn: true, operational: false, state: 'VERIFY_REQUIRED', confidence: 'CONFIRMED', capabilities, evidence, message: `微博账号身份有效，但${labels[challenged[0]]}功能需要人工验证；${capabilitySummary}` };
    const loggedOut = messagingEntries.find(([, item]) => ['LOGIN', 'LOGIN_REQUIRED'].includes(item?.state));
    if (loggedOut) return { ...base, loggedIn: false, identityLoggedIn: false, operational: false, state: 'LOGIN', confidence: 'CONFIRMED', capabilities, evidence, message: `微博${labels[loggedOut[0]]}页面已确认退出登录；${capabilitySummary}` };
    const failed = messagingEntries.find(([, item]) => item?.state === 'ERROR');
    if (failed) return { ...base, loggedIn: false, identityLoggedIn: true, operational: false, state: 'ERROR', confidence: 'UNCONFIRMED', capabilities, evidence, message: `微博账号身份有效，但${labels[failed[0]]}功能检查失败；${capabilitySummary}` };
    const privateReady = capabilities.privateMessage?.state === 'READY';
    const commentReachable = ['READY', 'REACHABLE'].includes(capabilities.comment?.state);
    if (!privateReady || !commentReachable) return { ...base, loggedIn: false, identityLoggedIn: true, operational: false, state: 'UNKNOWN', confidence: 'UNCONFIRMED', capabilities, evidence, message: `微博账号身份有效，但采集和回复能力尚未确认；${capabilitySummary}` };
    return { ...base, loggedIn: true, identityLoggedIn: true, operational: true, capabilities, evidence, message: `微博已确认登录且采集回复可用；${capabilitySummary}` };
  }

  async recheckLogin(existingPage = null) {
    const page = existingPage || (this.loginRecheckPage && !this.loginRecheckPage.isClosed?.() ? this.loginRecheckPage : null) || await this.getLoginInspectionPage();
    return super.recheckLogin(page);
  }

  async readConversationRow(row, index = null) {
    return row.evaluate((el, i) => {
      const t = v => String(v || '').replace(/\s+/g, ' ').trim(); const shown = n => n && getComputedStyle(n).display !== 'none' && getComputedStyle(n).visibility !== 'hidden' && n.getClientRects().length;
      const unread = [...el.querySelectorAll('.num')].find(shown);
      const stableKey = [...el.querySelectorAll('.hidden')].map(node => t(node.textContent)).find(value => /^\d{6,}$/.test(value));
      const verifiedAccount = [...el.querySelectorAll('.m-icon,[class*="verify"],[class*="verified"]')].some(shown);
      return { index: i, userName: t(el.querySelector('.one-line.username')?.textContent), preview: t(el.querySelector('.lastmsg')?.textContent), eventTime: t(el.querySelector('.time')?.textContent), unreadCount: unread ? (parseInt(t(unread.textContent), 10) || 1) : 0, conversationKey: stableKey || el.getAttribute('data-id') || el.getAttribute('data-key') || el.getAttribute('data-datas'), verifiedAccount, outerHTML: String(el.outerHTML || '').slice(0, 10000) };
    }, index).catch(() => ({ index, userName: '', preview: '', eventTime: '', unreadCount: 0, conversationKey: null, verifiedAccount: false }));
  }

  async inspectConversation(userName) {
    const query = clean(userName); const page = await this.getPage();
    await page.goto(this.spec.messageUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }); await page.waitForTimeout(1800);
    const rows = page.locator('li.sessionlist'); const count = Math.min(await rows.count().catch(() => 0), 100); const conversations = []; const matches = [];
    for (let i = 0; i < count; i += 1) { const row = rows.nth(i); if (!await visible(row)) continue; const data = await this.readConversationRow(row, i); data.sourceAssessment = assessWeiboConversationSource(data, this.conversationSourceOptions); conversations.push(data); if (query && query !== '__LIST_ONLY__' && data.userName === query) matches.push(row); }
    if (matches.length === 1) { await matches[0].click(); await page.waitForTimeout(1200); }
    const openChat = await page.locator('body').evaluate(() => {
      const t = v => String(v || '').replace(/\s+/g, ' ').trim();
      const shown = el => { const s = getComputedStyle(el); return s.display !== 'none' && s.visibility !== 'hidden' && el.getClientRects().length; };
      const textWithImages = el => { if (!el) return ''; const clone = el.cloneNode(true); clone.querySelectorAll('img').forEach(img => img.replaceWith(document.createTextNode(img.getAttribute('alt') || img.getAttribute('title') || ''))); return t(clone.innerText || clone.textContent); };
      const chat = document.querySelector('.message');
      const messageRows = chat ? [...chat.querySelectorAll('ul.chat-content > li')].map((li, index) => {
        const item = li.querySelector('.message-item.other, .message-item.me');
        const contentNode = item?.querySelector('.puretext, .card1, .bubble_cont');
        const timeNode = li.querySelector(':scope > div > p.time, p.time');
        return { index, messageId: li.id || li.getAttribute('data-id') || null, direction: item?.classList.contains('other') ? 'incoming' : item?.classList.contains('me') ? 'outgoing' : 'unknown', content: textWithImages(contentNode), eventTime: t(timeNode?.textContent), className: String(item?.className || ''), outerHTML: String(li.outerHTML || '').slice(0, 12000) };
      }) : [];
      const exactSendControls = chat ? [...chat.querySelectorAll('button,[role="button"],div,span,a')].filter(el => shown(el) && t(el.innerText || el.textContent) === '\u53d1\u9001').map(el => ({ tag: el.tagName.toLowerCase(), text: t(el.innerText || el.textContent), role: el.getAttribute('role'), className: String(el.className || '').slice(0, 500), outerHTML: String(el.outerHTML || '').slice(0, 5000), parentHTML: String(el.parentElement?.outerHTML || '').slice(0, 10000) })) : [];
      const controls = [...document.querySelectorAll('button,input,textarea,[contenteditable="true"],[role="button"]')].filter(shown).slice(0, 150).map(el => ({ tag: el.tagName.toLowerCase(), text: t(el.textContent).slice(0, 200), placeholder: el.getAttribute('placeholder'), title: el.getAttribute('title'), className: String(el.className || '').slice(0, 500), outerHTML: String(el.outerHTML || '').slice(0, 4000) }));
      const editor = document.querySelector('#webchat-textarea'); const editorAncestors = []; let parent = editor; for (let i = 0; parent && i < 5; i += 1, parent = parent.parentElement) editorAncestors.push({ tag: parent.tagName.toLowerCase(), className: String(parent.className || ''), outerHTML: String(parent.outerHTML || '').slice(0, 20000) });
      return { bodyText: t(document.body.innerText).slice(0, 30000), chatTitle: t(chat?.querySelector('.header .friendname')?.textContent), chatClassName: String(chat?.className || ''), messageRows, exactSendControls, controls, editorAncestors };
    }).catch(() => ({ bodyText: '', chatTitle: '', messageRows: [], exactSendControls: [], controls: [] }));
    const replyTarget = matches.length === 1 ? await this.inspectOpenPrivateConversation(page, { userName: query }, false) : { ok: false, reason: 'PRIVATE_TARGET_NOT_UNIQUE' };
    const replyEditor = replyTarget.ok ? await this.findPrivateEditor(replyTarget.scope) : null;
    const replyPreparation = { chatTitleVerified: replyTarget.ok, editorFound: Boolean(replyEditor), editorEditable: Boolean(replyEditor && await replyEditor.isEditable().catch(() => false)), reason: replyTarget.reason || (replyEditor ? null : 'PRIVATE_EDITOR_MISSING') };
    const screenshotPath = path.join(this.logsDir, `weibo-conversation-inspection-${Date.now()}.png`); await page.screenshot({ path: screenshotPath, fullPage: false }).catch(() => {});
    return { login: await this.inspectLoginState(page), query, matchCount: matches.length, conversations, openChat, replyPreparation, url: page.url(), screenshotPath: fs.existsSync(screenshotPath) ? screenshotPath : null, inspectionOnly: true, sent: false };
  }

  async findPublishButton(page, editor) {
    const buttons = page.getByRole('button', { name: /^发送$/, exact: true }); const usable = []; const editorBox = await editor.boundingBox().catch(() => null);
    for (let i = 0, n = await buttons.count().catch(() => 0); i < n; i += 1) { const item = buttons.nth(i); if (!await visible(item)) continue; const box = await item.boundingBox().catch(() => null); if (!editorBox || !box || (box.y >= editorBox.y - 100 && box.y <= editorBox.y + editorBox.height + 500)) usable.push(item); }
    return usable.length === 1 ? usable[0] : null;
  }

  async countFeedEchoes(page, content) {
    return page.locator('article,[class*="Feed_body"],[class*="wbpro-feed-content"],[class*="_content_"]').evaluateAll((els, target) => els.filter(el => {
      const s = getComputedStyle(el); const value = String(el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
      return s.display !== 'none' && s.visibility !== 'hidden' && el.getClientRects().length && value.includes(target);
    }).length, clean(content)).catch(() => 0);
  }

  async waitForWeiboUploadReady(page, editor, operationGeneration, timeoutMs = 180_000) {
    const roots = editor.locator('xpath=ancestor::div[.//input[@type="file"] and .//button[normalize-space()="\u53d1\u9001"]][1]');
    const rootCount = Math.min(await roots.count().catch(() => 0), 3);
    if (rootCount !== 1) throw new Error(`Weibo publisher root is ambiguous (${rootCount}).`);
    const root = roots.first();
    const deadline = Date.now() + timeoutMs;
    let lastState = { spinnerCount: 0, previewCount: 0 };
    while (Date.now() < deadline) {
      await this.assertWeiboOperationAllowed(operationGeneration);
      const spinnerCount = await root.locator('.woo-spinner-main').evaluateAll(els => els.filter(el => {
        const style = getComputedStyle(el);
        return style.display !== 'none' && style.visibility !== 'hidden' && el.getClientRects().length;
      }).length).catch(() => 0);
      const previewCount = await root.locator('.woo-picture-img').evaluateAll(els => els.filter(el => {
        const style = getComputedStyle(el);
        return style.display !== 'none' && style.visibility !== 'hidden' && el.getClientRects().length;
      }).length).catch(() => 0);
      lastState = { spinnerCount, previewCount };
      if (previewCount > 0 && spinnerCount === 0) return { ready: true, ...lastState };
      const errorText = clean(await root.innerText().catch(() => ''));
      if (/\u4e0a\u4f20\u5931\u8d25|\u5904\u7406\u5931\u8d25|\u8f6c\u7801\u5931\u8d25|upload failed/i.test(errorText)) throw new Error('Weibo material upload failed.');
      await page.waitForTimeout(500);
    }
    throw new Error(`Weibo material upload did not become ready (${JSON.stringify(lastState)}).`);
  }

  async waitForStableWeiboPublishButton(page, editor, operationGeneration, timeoutMs = 180_000, requiredStableSamples = 5) {
    const deadline = Date.now() + timeoutMs;
    let stableReadySamples = 0;
    let lastState = { publishButtonFound: false, publishButtonEnabled: false, stableReadySamples: 0 };
    while (Date.now() < deadline) {
      await this.assertWeiboOperationAllowed(operationGeneration);
      const button = await this.findPublishButton(page, editor);
      const publishButtonFound = Boolean(button);
      const publishButtonEnabled = Boolean(button && await button.isEnabled().catch(() => false));
      stableReadySamples = publishButtonFound && publishButtonEnabled ? stableReadySamples + 1 : 0;
      lastState = { publishButtonFound, publishButtonEnabled, stableReadySamples };
      // This loop is read-only. It never clicks the publish button; the caller
      // receives the single stable locator and performs at most one final click.
      if (stableReadySamples >= requiredStableSamples) return { ready: true, button, ...lastState };
      await page.waitForTimeout(1000);
    }
    return { ready: false, button: null, ...lastState };
  }

  async applyWeiboContentDeclaration(page, payload) {
    const origin = normalizeContentOrigin(payload.contentOrigin);
    if (!origin) throw new Error('A verified content-origin declaration is required.');
    const labels = weiboContentDeclarationLabels(origin);
    if (!labels.length) throw new Error(`No verified content declaration labels are configured for ${origin}.`);

    const triggerLabels = ['\u5185\u5bb9\u58f0\u660e', '\u5185\u5bb9\u6765\u6e90\u58f0\u660e', '\u58f0\u660e', '\u8bf7\u9009\u62e9'];
    const normalizedTriggerText = value => clean(value).replace(/[\uff08(]\u5fc5\u586b[\uff09)]$/, '').trim();
    const isTriggerText = value => {
      const label = normalizedTriggerText(value);
      return triggerLabels.includes(label)
        || /^\u8bf7(?:\u8fdb\u884c|\u9009\u62e9)?\u5185\u5bb9(?:\u6765\u6e90)?\u58f0\u660e$/.test(label)
        || labels.includes(label);
    };
    const locateTrigger = async () => {
      const controls = page.locator('.wbpro-form .woo-pop-ctrl, .woo-pop-wrap[class*="statement"] .woo-pop-ctrl, .woo-pop-ctrl');
      const matches = [];
      for (let index = 0, count = Math.min(await controls.count().catch(() => 0), 50); index < count; index += 1) {
        const candidate = controls.nth(index);
        const label = clean(await candidate.innerText().catch(async () => await candidate.textContent().catch(() => '')));
        if (isTriggerText(label) && await visible(candidate)) matches.push({ locator: candidate, label: normalizedTriggerText(label) });
      }
      if (matches.length === 1) return { status: 'UNIQUE', ...matches[0] };
      if (matches.length > 1) return { status: 'AMBIGUOUS', count: matches.length };
      const fallback = await uniqueVisibleExact(page, triggerLabels);
      return fallback.status === 'UNIQUE'
        ? { status: 'UNIQUE', locator: fallback.locator, label: normalizedTriggerText(fallback.label) }
        : fallback;
    };
    const locateOption = async () => {
      for (const label of labels) {
        const button = await uniqueVisibleFromLocator(page.getByRole?.('button', { name: label, exact: true }), { enabled: true });
        if (button.count === 1) return { status: 'UNIQUE', locator: button.locator, label };
        if (button.count > 1) return { status: 'AMBIGUOUS', count: button.count, label };
      }
      const controls = page.locator('.woo-pop-main button, .woo-pop-main [role="option"], .woo-pop-main .woo-pop-item, .woo-pop-main li, .woo-pop-main label');
      const matches = [];
      for (let index = 0, count = Math.min(await controls.count().catch(() => 0), 80); index < count; index += 1) {
        const candidate = controls.nth(index);
        const label = clean(await candidate.innerText().catch(async () => await candidate.textContent().catch(() => '')));
        if (labels.includes(label) && await visible(candidate) && await candidate.isEnabled().catch(() => true)) matches.push({ locator: candidate, label });
      }
      if (matches.length === 1) return { status: 'UNIQUE', ...matches[0] };
      if (matches.length > 1) return { status: 'AMBIGUOUS', count: matches.length };
      return { status: 'MISSING', count: 0 };
    };

    const locateConfirm = async () => {
      const roleButton = await uniqueVisibleFromLocator(page.getByRole?.('button', { name: '\u786e\u5b9a', exact: true }), { enabled: true });
      if (roleButton.count === 1) return { status: 'UNIQUE', locator: roleButton.locator };
      if (roleButton.count > 1) return { status: 'AMBIGUOUS', count: roleButton.count };
      const controls = page.locator('.woo-pop-main button, .woo-pop-main [role="button"]');
      const matches = [];
      for (let index = 0, count = Math.min(await controls.count().catch(() => 0), 50); index < count; index += 1) {
        const candidate = controls.nth(index);
        const label = clean(await candidate.innerText().catch(async () => await candidate.textContent().catch(() => '')));
        if (label === '\u786e\u5b9a' && await visible(candidate) && await candidate.isEnabled().catch(() => true)) matches.push(candidate);
      }
      if (matches.length === 1) return { status: 'UNIQUE', locator: matches[0] };
      if (matches.length > 1) return { status: 'AMBIGUOUS', count: matches.length };
      return { status: 'MISSING', count: 0 };
    };
    let lastOptionStatus = { status: 'MISSING', count: 0 };
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const trigger = await locateTrigger();
      if (trigger.status === 'AMBIGUOUS') throw new Error(`Content declaration trigger is ambiguous (${trigger.count}).`);
      if (trigger.status !== 'UNIQUE') {
        if (attempt < 3) { await page.waitForTimeout(350); continue; }
        throw new Error('Content declaration trigger was not found.');
      }
      if (labels.includes(trigger.label)) return { applied: true, contentOrigin: origin, selectedLabel: trigger.label, alreadySelected: true };
      await trigger.locator.click().catch(() => {});
      const optionDeadline = Date.now() + 5_000;
      do {
        lastOptionStatus = await locateOption();
        if (lastOptionStatus.status === 'UNIQUE') break;
        if (lastOptionStatus.status === 'AMBIGUOUS') throw new Error(`Content declaration option is ambiguous (${lastOptionStatus.count}).`);
        await page.waitForTimeout(200);
      } while (Date.now() < optionDeadline);
      if (lastOptionStatus.status !== 'UNIQUE') {
        await page.waitForTimeout(300);
        continue;
      }

      await lastOptionStatus.locator.click();

      // Some Weibo variants apply immediately; the current production UI requires an explicit confirmation.
      const autoCommitDeadline = Date.now() + 800;
      do {
        const selectedTrigger = await locateTrigger();
        if (selectedTrigger.status === 'UNIQUE' && selectedTrigger.label === lastOptionStatus.label) {
          return { applied: true, contentOrigin: origin, selectedLabel: lastOptionStatus.label };
        }
        await page.waitForTimeout(100);
      } while (Date.now() < autoCommitDeadline);

      let confirmStatus = { status: 'MISSING', count: 0 };
      const confirmDeadline = Date.now() + 3_000;
      do {
        const selectedTrigger = await locateTrigger();
        if (selectedTrigger.status === 'UNIQUE' && selectedTrigger.label === lastOptionStatus.label) {
          return { applied: true, contentOrigin: origin, selectedLabel: lastOptionStatus.label };
        }
        confirmStatus = await locateConfirm();
        if (confirmStatus.status === 'UNIQUE') break;
        if (confirmStatus.status === 'AMBIGUOUS') throw new Error(`Content declaration confirm button is ambiguous (${confirmStatus.count}).`);
        await page.waitForTimeout(150);
      } while (Date.now() < confirmDeadline);
      if (confirmStatus.status !== 'UNIQUE') throw new Error('Content declaration selection was not confirmed.');

      await confirmStatus.locator.click();
      const confirmationDeadline = Date.now() + 5_000;
      do {
        const selectedTrigger = await locateTrigger();
        if (selectedTrigger.status === 'UNIQUE' && selectedTrigger.label === lastOptionStatus.label) {
          return { applied: true, contentOrigin: origin, selectedLabel: lastOptionStatus.label };
        }
        await page.waitForTimeout(200);
      } while (Date.now() < confirmationDeadline);
      throw new Error('Content declaration selection was not confirmed.');
    }
    throw new Error(lastOptionStatus.status === 'AMBIGUOUS'
      ? `Content declaration option is ambiguous (${lastOptionStatus.count}).`
      : `No content declaration option matches ${origin}.`);
  }

  async countPublishSuccessSignals(page) {
    return page.locator('[role="alert"], [role="status"], [aria-live="assertive"], [aria-live="polite"], .woo-toast-main, [class*="toast"], [class*="message-success"]').evaluateAll(els => els.filter(el => {
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || !el.getClientRects().length) return false;
      const text = String(el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
      return /^(?:\u5fae\u535a)?(?:\u53d1\u5e03|\u53d1\u9001)\u6210\u529f[\uff01!\u3002.]?$/.test(text);
    }).length).catch(() => 0);
  }

  startPublishNetworkObserver(page) {
    const records = [];
    const pending = new Set();
    if (typeof page?.on !== 'function') return { available: false, async snapshot() { return null; }, stop() {} };
    const handler = response => {
      const task = (async () => {
        const request = response.request?.();
        if (request?.method?.() !== 'POST') return;
        const url = response.url?.() || '';
        if (!WEIBO_PUBLISH_ENDPOINT_RE.test(url)) return;
        const body = await response.json().catch(async () => {
          const text = await response.text().catch(() => '');
          try { return JSON.parse(text); } catch { return text ? { message: text.slice(0, 500) } : null; }
        });
        records.push({ ...classifyWeiboPublishNetworkEvidence({ url, status: response.status?.(), body }), observedAt: new Date().toISOString() });
      })().finally(() => pending.delete(task));
      pending.add(task);
    };
    page.on('response', handler);
    return {
      available: true,
      async snapshot() {
        if (pending.size) await Promise.allSettled([...pending]);
        return [...records].reverse().find(item => item.kind === 'FAILURE')
          || [...records].reverse().find(item => item.kind === 'SUCCESS')
          || records.at(-1)
          || null;
      },
      stop() { if (typeof page?.off === 'function') page.off('response', handler); }
    };
  }

  async waitForPublishReceipt(page, editor, content, baseline, networkObserver = null) {
    let proof = assessWeiboPublishReceipt({ ...baseline, scopedEchoCount: baseline.baselineEchoCount, successSignalCount: baseline.baselineSuccessSignalCount, editorCleared: false, networkEvidence: await networkObserver?.snapshot?.() });
    const until = Date.now() + Math.max(10_000, Number(this.sendTimeoutMs) || 30_000);
    while (Date.now() < until) {
      const scopedEchoCount = await this.countFeedEchoes(page, content);
      const successSignalCount = await this.countPublishSuccessSignals(page);
      const remaining = await editorValue(editor);
      const networkEvidence = await networkObserver?.snapshot?.();
      proof = assessWeiboPublishReceipt({ ...baseline, scopedEchoCount, successSignalCount, editorCleared: !remaining, networkEvidence });
      if (proof.confirmed || proof.explicitFailure) break;
      await page.waitForTimeout(700);
    }
    return proof;
  }

  async publish(payload) {
    const operationGeneration = this.lifecycleGeneration;
    const materialPath = path.resolve(payload.materialPath || '');
    const content = clean([payload.title, payload.body].filter(Boolean).join('\n'));
    if (!fs.existsSync(materialPath)) return { status: 'FAILED', result: await this.evidence(payload, 'Material file does not exist.', null, 'material_missing') };
    if (!content) return { status: 'FAILED', result: await this.evidence(payload, 'Publish content is empty.', null, 'publish_content_empty') };
    const page = await this.getPage();
    let sendAttempted = false;
    try {
      await page.goto(this.spec.publishUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(1500);
      if (!await this.waitForReady(page)) return { status: 'NEEDS_CONFIRMATION', result: await this.evidence(payload, 'Weibo login is not ready.', page, 'login_required') };
      const editor = await firstVisible([page.locator('textarea[placeholder="\u6709\u4ec0\u4e48\u65b0\u9c9c\u4e8b\u60f3\u5206\u4eab\u7ed9\u5927\u5bb6\uff1f"]'), page.locator('textarea[placeholder*="\u65b0\u9c9c\u4e8b"]')]);
      const fileInput = await firstAttached([page.locator('input[type="file"][class*="_file_"]'), page.locator('input[type="file"][accept*="video"]'), page.locator('input[type="file"][accept*="image"]')]);
      if (!editor || !fileInput) throw new Error(!editor ? 'Weibo publish editor was not found.' : 'Weibo upload input was not found.');
      await fileInput.setInputFiles(materialPath);
      await fillEditor(editor, content);
      if (await editorValue(editor) !== content) throw new Error('Publish editor content verification failed.');
      const uploadTimeoutMs = resolveUploadTimeoutMs(materialPath, this.uploadTimeoutOptions);
      const upload = await this.waitForWeiboUploadReady(page, editor, operationGeneration, uploadTimeoutMs);
      let declaration = await this.applyWeiboContentDeclaration(page, payload);
      let button = await this.findPublishButton(page, editor);
      const draft = await this.evidence(payload, 'Weibo draft is ready.', page, 'draft_ready', { content, materialPath, upload, declaration, publishButtonFound: Boolean(button) });
      if (payload.publishMode !== 'AUTO') return { status: 'NEEDS_CONFIRMATION', result: await this.preserveDraftForManualAction(page, payload, '微博草稿已准备，等待人工检查并提交', 'draft_ready', { content, materialPath, upload, declaration, submitAttempted: false }) };

      let publishReadiness = await this.waitForStableWeiboPublishButton(page, editor, operationGeneration, 180_000);
      if (!publishReadiness.ready) return { status: 'NEEDS_CONFIRMATION', result: await this.preserveDraftForManualAction(page, payload, '微博自动发布未成功：发布按钮未连续保持唯一可用', 'publish_button_unavailable', { content, materialPath, upload, declaration, publishReadiness, submitAttempted: false }) };

      declaration = await this.applyWeiboContentDeclaration(page, payload);
      if (declaration.alreadySelected !== true) {
        publishReadiness = await this.waitForStableWeiboPublishButton(page, editor, operationGeneration, 30_000);
        if (!publishReadiness.ready) return { status: 'NEEDS_CONFIRMATION', result: await this.preserveDraftForManualAction(page, payload, '微博内容声明重新应用后，发布按钮未连续保持唯一可用', 'publish_button_unavailable', { content, materialPath, upload, declaration, publishReadiness, submitAttempted: false }) };
      }
      button = await this.findPublishButton(page, editor);
      if (!button || !await button.isEnabled().catch(() => false)) return { status: 'NEEDS_CONFIRMATION', result: await this.preserveDraftForManualAction(page, payload, '微博自动发布未成功：最终校验后发布按钮未保持唯一可用', 'publish_button_unavailable', { content, materialPath, upload, declaration, publishReadiness, submitAttempted: false }) };
      const baseline = {
        baselineEchoCount: await this.countFeedEchoes(page, content),
        baselineSuccessSignalCount: await this.countPublishSuccessSignals(page)
      };
      await this.assertWeiboOperationAllowed(operationGeneration);
      const networkObserver = this.startPublishNetworkObserver(page);
      sendAttempted = true;
      let proof;
      try {
        await button.click();
        proof = await this.waitForPublishReceipt(page, editor, content, baseline, networkObserver);
      } finally {
        networkObserver.stop();
      }
      if (proof.explicitFailure) return { status: 'FAILED', result: await this.evidence(payload, `微博明确返回发布失败：${proof.networkEvidence?.message || proof.networkEvidence?.code || '平台拒绝了本次发布'}`, page, 'publish_rejected', { ...proof, explicitPlatformFailure: true, submissionStatus: 'NOT_SUBMITTED', reviewStatus: 'UNKNOWN', sendAttempted: true, submitAttempted: true, retrySafe: true, safeToRetry: true, manualActionRequired: false, draftSaved: false }) };
      if (!proof.confirmed) return { status: 'NEEDS_CONFIRMATION', result: await this.evidence(payload, '微博已尝试发布，但未观察到本次动作产生的唯一回执；禁止自动重发，请人工核对', page, 'publish_unconfirmed', { ...proof, sendAttempted: true, submitAttempted: true, manualActionRequired: true, draftSaved: false }) };
      return { status: 'SUCCESS', result: await this.evidence(payload, '微博已通过平台网络回执或页面新增回执确认提交成功', page, 'published', { ...proof, submissionStatus: 'SUBMITTED', reviewStatus: 'UNKNOWN', submitAttempted: true, platformPostId: proof.networkEvidence?.platformPostId || null, platformUrl: proof.networkEvidence?.platformUrl || null, publishSignal: { confirmed: true, source: proof.networkConfirmed ? 'weibo-network-response' : proof.newSuccessSignal ? 'weibo-success-signal' : 'weibo-new-feed-echo' } }) };
    } catch (error) {
      if (['PLATFORM_STOPPED', 'PLATFORM_OPERATION_CANCELLED'].includes(error.code)) throw error;
      if (sendAttempted) return { status: 'NEEDS_CONFIRMATION', result: await this.evidence(payload, `微博发布结果不确定：${error.message}；禁止自动重发，请人工核对`, page, 'publish_unconfirmed', { sendAttempted: true, submitAttempted: true, manualActionRequired: true, draftSaved: false }) };
      return { status: 'FAILED', result: await this.preserveDraftForManualAction(page, payload, `微博自动发布准备失败：${error.message}`, 'publish_failed', { sendAttempted: false, submitAttempted: false }) };
    }
  }

  async resolveManageUrl(page) {
    if (/weibo\.com\/u\/\d+/i.test(this.spec.manageUrl || '')) return this.spec.manageUrl;
    await page.goto(this.spec.publishUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }); await page.waitForTimeout(900);
    const anchors = page.locator('a[href^="/u/"][title], a[href^="https://weibo.com/u/"][title]');
    const matches = [];
    for (let index = 0, count = Math.min(await anchors.count().catch(() => 0), 20); index < count; index += 1) {
      const candidate = anchors.nth(index);
      if (!await visible(candidate)) continue;
      const box = await candidate.boundingBox().catch(() => null);
      if (!box || box.y > 100) continue;
      const url = normalizeUrl(await candidate.getAttribute('href').catch(() => null));
      if (/weibo\.com\/u\/\d+/i.test(url || '')) matches.push(url);
    }
    const unique = [...new Set(matches)];
    return unique.length === 1 ? unique[0] : null;
  }

  async verifyPublish(payload) {
    const page = await this.getPage();
    const expectedPostId = clean(payload.platformPostId || weiboPostIdFromUrl(payload.platformUrl));
    const expectedPlatformUrl = normalizeUrl(payload.platformUrl);
    const title = clean(payload.title);
    const body = clean(payload.body);
    const bodySnippet = body.slice(0, 80);
    const submittedAt = Date.parse(payload.submittedAt || '');

    if (expectedPostId && expectedPlatformUrl && /^https:\/\/(?:www\.)?weibo\.com\//i.test(expectedPlatformUrl)) {
      await page.goto(expectedPlatformUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(1200);
      if (await this.detectPageState(page) === 'READY') {
        const currentUrl = normalizeUrl(page.url());
        const currentPostId = weiboPostIdFromUrl(currentUrl) || weiboPostIdFromUrl(expectedPlatformUrl);
        const urlIdentityMatched = Boolean(currentUrl && expectedPlatformUrl && new URL(currentUrl).pathname === new URL(expectedPlatformUrl).pathname);
        const pageText = clean(await page.locator('body').innerText({ timeout: 5000 }).catch(() => '')).slice(0, 30000);
        const contentMatches = (!title || pageText.includes(title)) && (!bodySnippet || pageText.includes(bodySnippet));
        if ((currentPostId === expectedPostId || urlIdentityMatched) && (contentMatches || (!title && !bodySnippet))) {
          return { status: 'SUCCESS', result: await this.evidence(payload, '微博已通过发布回执中的帖子链接精确确认发布成功', page, 'reviewed_by_post_id', {
            reviewStatus: 'PUBLISHED',
            platformPostId: expectedPostId,
            platformUrl: expectedPlatformUrl,
            verificationPolicyId: this.spec.verificationPolicyId,
            matchStrategy: 'PLATFORM_POST_ID_AND_URL'
          }) };
        }
      }
    }

    const manageUrl = await this.resolveManageUrl(page);
    if (!manageUrl) return { status: 'NEEDS_CONFIRMATION', result: await this.evidence(payload, '无法唯一定位当前微博账号主页，禁止用信息流中的其他账号误判发布结果', page, 'verify_profile_ambiguous', { reviewStatus: 'UNKNOWN', verificationPolicyId: this.spec.verificationPolicyId }) };
    await page.goto(manageUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(1500);
    if (await this.detectPageState(page) !== 'READY') return { status: 'NEEDS_CONFIRMATION', result: await this.evidence(payload, '微博登录失效，无法复核发布状态', page, 'verify_login_required', { reviewStatus: 'UNKNOWN', verificationPolicyId: this.spec.verificationPolicyId }) };
    if (!expectedPostId && !title && !bodySnippet) return { status: 'NEEDS_CONFIRMATION', result: await this.evidence(payload, '发布任务缺少帖子ID、标题和正文，无法唯一复核微博记录', page, 'verify_identity_missing', { reviewStatus: 'UNKNOWN', verificationPolicyId: this.spec.verificationPolicyId }) };

    const cards = page.locator('article,[class*="Feed_wrap"],[class*="wbpro-feed-content"]');
    const rawMatches = [];
    for (let index = 0, count = Math.min(await cards.count().catch(() => 0), 100); index < count; index += 1) {
      const card = cards.nth(index);
      if (!await visible(card)) continue;
      const item = await card.evaluate(el => {
        const t = value => String(value || '').replace(/\s+/g, ' ').trim();
        const text = t(el.innerText || el.textContent);
        const links = [...el.querySelectorAll('a[href]')];
        const link = links.find(anchor => /\/\d+\/[A-Za-z0-9_-]+/.test(anchor.getAttribute('href') || anchor.href || ''));
        const time = [...el.querySelectorAll('a,time')].find(node => /刚刚|分钟前|小时前|今天|昨天|\d{1,4}[-年\/月]\d{1,2}/.test(t(node.textContent)));
        return { text: text.slice(0, 3000), href: link?.href || link?.getAttribute('href'), eventTime: t(time?.textContent) };
      }).catch(() => null);
      if (!item) continue;
      const externalUrl = normalizeUrl(item.href);
      const candidatePostId = weiboPostIdFromUrl(externalUrl);
      const idMatched = Boolean(expectedPostId && candidatePostId === expectedPostId);
      const urlMatched = Boolean(expectedPlatformUrl && externalUrl && new URL(externalUrl).pathname === new URL(expectedPlatformUrl).pathname);
      const titleMatched = Boolean(title && item.text.includes(title));
      const bodyMatched = Boolean(bodySnippet && item.text.includes(bodySnippet));
      const contentMatched = title && bodySnippet ? titleMatched && bodyMatched : titleMatched || bodyMatched;
      if (idMatched || urlMatched || (!expectedPostId && contentMatched)) rawMatches.push({ index, text: item.text, externalUrl, eventTime: item.eventTime, platformPostId: candidatePostId, idMatched, urlMatched, titleMatched, bodyMatched });
    }
    const matches = dedupeWeiboPublishMatches(rawMatches);
    if (matches.length !== 1) return { status: 'NEEDS_CONFIRMATION', result: await this.evidence(payload, matches.length ? `微博主页找到 ${matches.length} 条候选记录，无法唯一复核` : '微博主页未找到与本次任务匹配的发布记录', page, 'review_unknown', { reviewStatus: 'UNKNOWN', matches, verificationPolicyId: this.spec.verificationPolicyId }) };
    const eventMs = parseWeiboEventTime(matches[0].eventTime);
    const timeVerified = !Number.isFinite(submittedAt) || (Number.isFinite(eventMs) && eventMs >= submittedAt - 120_000);
    if (!timeVerified) return { status: 'NEEDS_CONFIRMATION', result: await this.evidence(payload, '微博匹配记录发布时间早于本次任务，禁止误判', page, 'review_time_mismatch', { reviewStatus: 'UNKNOWN', match: matches[0], verificationPolicyId: this.spec.verificationPolicyId }) };
    return { status: 'SUCCESS', result: await this.evidence(payload, expectedPostId ? '微博主页已按帖子ID唯一确认发布成功' : '微博主页已按标题、正文和提交时间唯一确认发布成功', page, 'reviewed', {
      reviewStatus: 'PUBLISHED',
      platformPostId: matches[0].platformPostId || expectedPostId || null,
      platformUrl: matches[0].externalUrl,
      match: matches[0],
      timeVerified,
      verificationPolicyId: this.spec.verificationPolicyId,
      matchStrategy: expectedPostId ? 'PLATFORM_POST_ID' : 'TITLE_BODY_AND_TIME'
    }) };
  }

  async openCommentInbox(page, { waitMs = 900 } = {}) {
    await page.goto(this.spec.commentUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(waitMs);
    const login = await this.inspectLoginState(page);
    if (login.state !== 'READY') return { ok: false, reason: login.state, login, url: page.url() };
    const received = await uniqueVisibleFromLocator(page.getByText(/^\u6536\u5230\u7684\u8bc4\u8bba$/, { exact: true }));
    if (received.count !== 1) return { ok: false, reason: received.count ? 'COMMENT_INBOX_TAB_AMBIGUOUS' : 'COMMENT_INBOX_TAB_MISSING', login, url: page.url(), matchCount: received.count };
    await received.locator.click();
    await page.waitForTimeout(700);
    return { ok: true, reason: 'RECEIVED_COMMENT_INBOX_OPEN', login, url: page.url() };
  }

  async openSentCommentInbox(page, { waitMs = 900 } = {}) {
    await page.goto(this.spec.commentUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(waitMs);
    const login = await this.inspectLoginState(page);
    if (login.state !== 'READY') return { ok: false, reason: login.state, login, url: page.url() };
    const sent = await uniqueVisibleFromLocator(page.getByText(/^发出的评论$/, { exact: true }));
    if (sent.count !== 1) return { ok: false, reason: sent.count ? 'SENT_COMMENT_TAB_AMBIGUOUS' : 'SENT_COMMENT_TAB_MISSING', login, url: page.url(), matchCount: sent.count };
    await sent.locator.click();
    await page.waitForTimeout(700);
    return { ok: true, reason: 'SENT_COMMENT_INBOX_OPEN', login, url: page.url() };
  }

  async readSentCommentRow(row, index = null) {
    return row.evaluate((el, i) => {
      const text = value => String(value || '').normalize('NFC').replace(/[​-‍﻿]/g, '').replace(/\s+/g, ' ').trim();
      const links = [...el.querySelectorAll('a[href]')].map(link => ({ text: text(link.innerText || link.textContent), href: link.getAttribute('href') || link.href || '' }));
      return {
        index: i,
        rowText: text(el.innerText || el.textContent),
        links
      };
    }, index).then(item => {
      const postUrls = [...new Set(item.links.map(link => normalizeUrl(link.href)).filter(Boolean))];
      const postIds = [...new Set(postUrls.map(weiboPostIdFromUrl).filter(Boolean))];
      return { ...item, postUrls, postIds };
    }).catch(error => ({ index, rowText: '', links: [], postUrls: [], postIds: [], evaluationError: error.message }));
  }

  async inspectSentCommentReply(page, payload, expectedReply, { maxRounds = 10 } = {}) {
    const operationGeneration = this.lifecycleGeneration;
    const identity = weiboCommentDetailIdentity(payload);
    const expectedUserName = clean(payload.userName);
    const expectedSourceContent = clean(payload.sourceContent);
    const replyText = clean(expectedReply);
    if (!expectedUserName || !expectedSourceContent || !replyText || !identity.postId) {
      return { handled: false, reason: 'SENT_COMMENT_INPUT_MISSING', ...identity, matchCount: 0, candidates: [], detectionSource: 'SENT_COMMENT_INBOX', readOnly: true };
    }
    await this.assertWeiboOperationAllowed(operationGeneration);
    const sentInbox = await this.openSentCommentInbox(page, { waitMs: 900 });
    if (!sentInbox.ok) return { handled: false, reason: sentInbox.reason, ...identity, matchCount: 0, candidates: [], sentInbox, detectionSource: 'SENT_COMMENT_INBOX', readOnly: true };
    const candidates = [];
    const seen = new Set();
    let scanRounds = 0;
    let exhausted = false;
    let lastAdvance = null;
    for (let round = 1; round <= Math.max(1, Number(maxRounds) || 10); round += 1) {
      await this.assertWeiboOperationAllowed(operationGeneration);
      scanRounds = round;
      const rows = page.locator('.wbpro-scroller-item');
      for (let index = 0, count = Math.min(await rows.count().catch(() => 0), 100); index < count; index += 1) {
        const candidate = await this.readSentCommentRow(rows.nth(index), index);
        if (!candidate.rowText) continue;
        const key = digest([candidate.rowText, ...(candidate.postIds || [])]);
        if (seen.has(key)) continue;
        seen.add(key);
        candidates.push(candidate);
      }
      const assessment = assessWeiboSentCommentReplyEvidence({
        expectedUserName,
        expectedSourceContent,
        expectedReply: replyText,
        expectedPostId: identity.postId,
        candidates
      });
      if (assessment.handled || assessment.reason === 'SENT_COMMENT_TARGET_AMBIGUOUS') {
        return { ...identity, ...assessment, candidates, scanRounds, exhausted: false, detectionSource: 'SENT_COMMENT_INBOX', readOnly: true };
      }
      if (round >= Math.max(1, Number(maxRounds) || 10)) break;
      lastAdvance = await this.advanceHistoricalCommentList(page, { selectors: ['.wbpro-scroller'] });
      if (!lastAdvance.attempted || !lastAdvance.moved) { exhausted = true; break; }
      await page.waitForTimeout(500);
    }
    const assessment = assessWeiboSentCommentReplyEvidence({
      expectedUserName,
      expectedSourceContent,
      expectedReply: replyText,
      expectedPostId: identity.postId,
      candidates
    });
    return { ...identity, ...assessment, candidates, scanRounds, exhausted, lastAdvance, detectionSource: 'SENT_COMMENT_INBOX', readOnly: true };
  }

  async readCommentRow(row, index = null) {
    return row.evaluate((el, i) => {
      const t = v => String(v || '').replace(/\s+/g, ' ').trim();
      const user = [...el.querySelectorAll('a[href^="/u/"]')].find(a => t(a.textContent));
      const link = [...el.querySelectorAll('a[href]')].find(a => /[?&]cid=\d+/.test(a.getAttribute('href') || a.href || ''));
      const texts = [...el.querySelectorAll('div[class*="_wbtext_"]')]; const content = texts.find(n => /_textImg_/.test(String(n.className || ''))) || texts.sort((a, b) => t(b.textContent).length - t(a.textContent).length)[0];
      return { index: i, userName: t(user?.textContent), content: t(content?.textContent), href: link?.getAttribute('href') || link?.href, eventTime: t(link?.textContent) };
    }, index).then(item => {
      const externalUrl = normalizeUrl(item.href);
      return { ...item, externalUrl, commentId: commentIdFromUrl(externalUrl), postId: weiboPostIdFromUrl(externalUrl) };
    }).catch(() => ({ index, userName: '', content: '', externalUrl: null, commentId: null, postId: null, eventTime: '' }));
  }

  async collectComments(page, { maxRounds = 10, watermark = null, fullSweepIntervalMs = WEIBO_COMMENT_FULL_SWEEP_MS } = {}) {
    try {
      const operationGeneration = this.lifecycleGeneration;
      const inbox = await this.openCommentInbox(page, { waitMs: 1400 });
      if (!inbox.ok) return { messages: [], watermark: null, summary: { type: 'COMMENT', status: 'NEEDS_CONFIRMATION', reason: inbox.reason, count: 0, url: page.url() } };
      const previousIds = [...new Set((Array.isArray(watermark?.recentCommentIds) ? watermark.recentCommentIds : []).map(clean).filter(stableNumericId))].slice(0, WEIBO_COMMENT_CURSOR_LIMIT);
      const previousIdSet = new Set(previousIds);
      const observedIds = [];
      const messages = [];
      const seenIds = new Set();
      const collectedAtMs = Date.now();
      const performFullSweep = fullSweepDue(watermark?.lastFullSweepAt, fullSweepIntervalMs, collectedAtMs);
      const requestedRounds = Math.max(1, Number(maxRounds) || 10);
      const roundLimit = performFullSweep ? requestedRounds : Math.min(requestedRounds, 3);
      let scanRounds = 0;
      let stopReason = 'MAX_ROUNDS';
      let knownStreak = 0;
      let maxEventTimeMs = positiveNumber(watermark?.lastSeenEventTimeMs);
      for (let round = 1; round <= roundLimit; round += 1) {
        await this.assertWeiboOperationAllowed(operationGeneration);
        scanRounds = round;
        const rows = page.locator('.wbpro-scroller-item');
        let added = 0;
        for (let index = 0, count = Math.min(await rows.count().catch(() => 0), 100); index < count; index += 1) {
          await this.assertWeiboOperationAllowed(operationGeneration);
          const item = await this.readCommentRow(rows.nth(index), index);
          if (!item.userName || !item.content || !stableNumericId(item.commentId) || seenIds.has(item.commentId)) continue;
          seenIds.add(item.commentId);
          observedIds.push(item.commentId);
          const alreadyKnown = previousIdSet.has(item.commentId);
          knownStreak = alreadyKnown ? knownStreak + 1 : 0;
          const timing = eventMetadata(item.eventTime, collectedAtMs);
          if (positiveNumber(timing.eventTimeMs)) maxEventTimeMs = Math.max(maxEventTimeMs || 0, timing.eventTimeMs);
          if (alreadyKnown) continue;
          added += 1;
          messages.push({
            messageType: 'COMMENT',
            externalId: `weibo-comment-${item.commentId}`,
            userName: item.userName,
            content: item.content.slice(0, 1000),
            externalUrl: item.externalUrl,
            context: {
              platformCode: 'weibo',
              eventTime: item.eventTime,
              ...timing,
              commentId: item.commentId,
              postId: item.postId,
              contentId: item.postId,
              sourcePostId: item.postId,
              postUrl: item.externalUrl,
              commentFingerprint: digest([item.userName, item.content, item.eventTime, item.commentId]),
              rowIndex: index,
              sourceVerified: true
            }
          });
        }
        if (!performFullSweep && knownStreak >= 20) { stopReason = 'KNOWN_COMMENT_WATERMARK_REACHED'; break; }
        if (round >= roundLimit) break;
        const advance = await this.advanceHistoricalCommentList(page, { selectors: ['.wbpro-scroller'] });
        if (!advance.attempted || !advance.moved) { stopReason = advance.reason || 'COMMENT_INBOX_EXHAUSTED'; break; }
        await page.waitForTimeout(500);
        if (added === 0 && round > 1 && !performFullSweep) { stopReason = 'NO_NEW_COMMENT_IDS'; break; }
      }
      const recentCommentIds = [...new Set([...observedIds, ...previousIds])].slice(0, WEIBO_COMMENT_CURSOR_LIMIT);
      const nextWatermark = {
        recentCommentIds,
        lastFullSweepAt: performFullSweep ? new Date(collectedAtMs).toISOString() : validIso(watermark?.lastFullSweepAt),
        lastSeenEventTimeMs: maxEventTimeMs || null
      };
      return { messages, watermark: nextWatermark, summary: { type: 'COMMENT', status: 'SUCCESS', reason: 'VERIFIED_RECEIVED_COMMENT_INBOX', count: messages.length, observedCount: observedIds.length, knownCount: observedIds.length - messages.length, url: page.url(), scanRounds, stopReason, fullSweep: performFullSweep } };
    } catch (error) {
      if (['PLATFORM_STOPPED', 'PLATFORM_OPERATION_CANCELLED'].includes(error.code)) throw error;
      return { messages: [], watermark: null, summary: { type: 'COMMENT', status: 'NEEDS_CONFIRMATION', reason: error.message, count: 0, url: page.url() } };
    }
  }

  async extractOpenIncomingMessages(page, conversation, scope = null) {
    const raw = await (scope || page).locator(scope ? 'ul.chat-content > li' : '.message ul.chat-content > li').evaluateAll((els, options) => {
      const t = v => String(v || '').replace(/\s+/g, ' ').trim();
      const textWithImages = el => { if (!el) return ''; const clone = el.cloneNode(true); clone.querySelectorAll('img').forEach(img => img.replaceWith(document.createTextNode(img.getAttribute('alt') || img.getAttribute('title') || ''))); return t(clone.innerText || clone.textContent); };
      let inheritedTime = '';
      return els.map((el, index) => {
        const timeNode = el.querySelector(':scope > div > p.time, p.time');
        const ownTime = t(timeNode?.getAttribute('datetime') || timeNode?.textContent);
        if (ownTime) inheritedTime = ownTime;
        const item = el.querySelector('.message-item.other');
        if (!item) return null;
        const contentNode = item.querySelector('.puretext, .card1, .bubble_cont');
        const content = textWithImages(contentNode);
        const messageId = t(el.id || el.getAttribute('data-id') || el.getAttribute('data-mid'));
        if (!content || content.length > 2000 || content === options.userName) return null;
        return { index, content, eventTime: ownTime || inheritedTime, messageId: /^\d{6,}$/.test(messageId) ? messageId : null, direction: 'incoming', sourceVerified: /^\d{6,}$/.test(messageId) };
      }).filter(Boolean);
    }, { userName: conversation.userName }).catch(() => []);
    const seen = new Set();
    return raw.filter(message => {
      const key = message.messageId || `${message.index}|${message.eventTime}|${message.content}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  async locateConversationRow(page, conversation) {
    // Element handles keep the verified DOM node when new messages reorder the list.
    const rows = await page.locator('li.sessionlist').elementHandles();
    const matches = [];
    for (let index = 0, count = Math.min(rows.length, 100); index < count; index += 1) {
      const locator = rows[index];
      const candidate = await this.readConversationRow(locator, index);
      const keyMatched = clean(conversation.conversationKey) && clean(candidate.conversationKey) === clean(conversation.conversationKey);
      const fallbackMatched = !clean(conversation.conversationKey) && candidate.userName === conversation.userName && candidate.preview === conversation.preview;
      if (keyMatched || fallbackMatched) matches.push(locator);
    }
    const selected = matches.length === 1 ? matches[0] : null;
    await Promise.all(rows.filter(row => row !== selected).map(row => row.dispose()));
    return selected;
  }

  async locateRecoveryConversationByStableKey(page, externalConversationKey) {
    const stableKey = clean(externalConversationKey);
    if (!stableKey) return { ok: false, reason: 'RECOVERY_STABLE_TARGET_REQUIRED', matches: [] };
    const rows = page.locator('li.sessionlist');
    const matches = [];
    for (let index = 0, count = Math.min(await rows.count().catch(() => 0), 100); index < count; index += 1) {
      const locator = rows.nth(index);
      const conversation = await this.readConversationRow(locator, index);
      if (clean(conversation.conversationKey) === stableKey) matches.push({ locator, conversation, index });
    }
    if (matches.length !== 1) {
      return { ok: false, reason: matches.length ? 'RECOVERY_TARGET_AMBIGUOUS' : 'RECOVERY_TARGET_NOT_FOUND', matches: matches.map(item => ({ index: item.index, conversation: item.conversation })) };
    }
    return { ok: true, ...matches[0], matches: [{ index: matches[0].index, conversation: matches[0].conversation }] };
  }

  async collectTargetedPrivateMessages(page, payload, recovery) {
    const operationGeneration = this.lifecycleGeneration;
    await page.goto(this.spec.messageUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(1600);
    const login = await this.inspectLoginState(page);
    if (login.state !== 'READY') {
      return { messages: [], watermark: null, summary: { type: 'PRIVATE_MESSAGE', status: 'NEEDS_CONFIRMATION', reason: login.state, code: login.state, count: 0, recoveryTargeted: true, url: page.url() } };
    }
    const previousSessions = payload?.collectionWatermarks?.PRIVATE_MESSAGE?.sessions && typeof payload.collectionWatermarks.PRIVATE_MESSAGE.sessions === 'object'
      ? payload.collectionWatermarks.PRIVATE_MESSAGE.sessions
      : {};
    const sessions = { ...previousSessions };
    const messages = [];
    const targetResults = [];
    const collectedAtMs = Date.now();
    for (const target of recovery.targets) {
      await this.assertWeiboOperationAllowed(operationGeneration);
      const stableId = target.externalConversationKey;
      const located = await this.locateRecoveryConversationByStableKey(page, stableId);
      if (!located.ok) {
        targetResults.push({ externalConversationKey: stableId, status: 'NEEDS_CONFIRMATION', reason: located.reason });
        continue;
      }
      const conversation = located.conversation;
      const sourceAssessment = assessWeiboConversationSource(conversation, this.conversationSourceOptions);
      if (sourceAssessment.isOfficial === true && sourceAssessment.confidence === 'HIGH') {
        targetResults.push({ externalConversationKey: stableId, status: 'NEEDS_CONFIRMATION', reason: 'PRIVATE_OFFICIAL_SOURCE' });
        continue;
      }
      const row = await this.locateConversationRow(page, conversation);
      if (!row) {
        targetResults.push({ externalConversationKey: stableId, status: 'NEEDS_CONFIRMATION', reason: 'RECOVERY_TARGET_CHANGED' });
        continue;
      }
      try { await row.click(); } finally { await row.dispose(); }
      await page.waitForTimeout(800);
      const chatTitle = clean(await page.locator('.message .header .friendname').first().innerText().catch(() => ''));
      if (!chatTitle || chatTitle !== clean(conversation.userName)) {
        targetResults.push({ externalConversationKey: stableId, status: 'NEEDS_CONFIRMATION', reason: 'PRIVATE_CHAT_TITLE_MISMATCH', chatTitle });
        continue;
      }
      const opened = await this.extractOpenIncomingMessages(page, conversation);
      const stableOpened = opened.filter(item => stableNumericId(item.messageId) && item.direction === 'incoming' && item.sourceVerified === true);
      if (!stableOpened.length) {
        targetResults.push({ externalConversationKey: stableId, status: 'NEEDS_CONFIRMATION', reason: 'PRIVATE_BUBBLE_EXTRACTION_INCOMPLETE' });
        continue;
      }
      const cursorKey = privateCursorKey(conversation);
      const previous = previousSessions[cursorKey] && typeof previousSessions[cursorKey] === 'object' ? previousSessions[cursorKey] : null;
      const previousIds = new Set(uniqueStableIds(previous?.recentMessageIds));
      const lastIndex = clean(previous?.lastMessageId) ? stableOpened.findIndex(item => item.messageId === clean(previous.lastMessageId)) : -1;
      let selected = [];
      if (lastIndex >= 0) selected = stableOpened.slice(lastIndex + 1);
      else if (previous) selected = stableOpened.filter(item => !previousIds.has(item.messageId));
      else if (conversation.unreadCount >= 1) selected = stableOpened.slice(-Math.max(1, conversation.unreadCount));
      selected = selected.filter(item => !previousIds.has(item.messageId));
      for (const message of selected) {
        const timing = eventMetadata(message.eventTime || conversation.eventTime, collectedAtMs);
        messages.push({
          messageType: 'PRIVATE_MESSAGE',
          externalId: 'weibo-private-' + message.messageId,
          userName: conversation.userName,
          content: message.content.slice(0, 1000),
          externalUrl: this.spec.messageUrl,
          context: {
            platformCode: 'weibo',
            previewOnly: false,
            unreadCount: conversation.unreadCount,
            eventTime: message.eventTime || conversation.eventTime,
            ...timing,
            conversationKey: stableId,
            conversationId: stableId,
            messageId: message.messageId,
            direction: 'incoming',
            chatTitleVerified: true,
            sourceVerified: true,
            sourceType: 'USER',
            officialSource: false,
            sourceAssessment
          }
        });
      }
      const openedEventMax = Math.max(...stableOpened.map(item => positiveNumber(eventMetadata(item.eventTime, collectedAtMs).eventTimeMs) || 0), 0);
      sessions[cursorKey] = {
        conversationKey: stableId,
        userName: conversation.userName,
        lastMessageId: stableOpened.at(-1)?.messageId || clean(previous?.lastMessageId) || null,
        recentMessageIds: uniqueStableIds([...(previous?.recentMessageIds || []), ...stableOpened.map(item => item.messageId)]),
        lastPreviewHash: privatePreviewHash(conversation),
        lastEventTimeMs: Math.max(positiveNumber(previous?.lastEventTimeMs) || 0, openedEventMax) || null,
        lastCheckedAt: new Date(collectedAtMs).toISOString(),
        initializedAt: validIso(previous?.initializedAt) || new Date(collectedAtMs).toISOString(),
        extractionIncomplete: false
      };
      targetResults.push({ externalConversationKey: stableId, status: 'SUCCESS', reason: selected.length ? 'TARGETED_RECOVERY_NEW_MESSAGES' : 'TARGETED_RECOVERY_NO_NEW_MESSAGE', recoveredCount: selected.length });
    }
    const unresolved = targetResults.filter(item => item.status === 'NEEDS_CONFIRMATION');
    return {
      messages,
      watermark: { sessions, lastFullSweepAt: validIso(payload?.collectionWatermarks?.PRIVATE_MESSAGE?.lastFullSweepAt) },
      summary: {
        type: 'PRIVATE_MESSAGE',
        status: unresolved.length ? 'NEEDS_CONFIRMATION' : 'SUCCESS',
        reason: unresolved[0]?.reason || 'TARGETED_RECOVERY_COMPLETED',
        code: unresolved.length ? 'RECOVERY_TARGET_NOT_FOUND' : null,
        count: messages.length,
        recoveryTargeted: true,
        recoveryTargetCount: recovery.targets.length,
        targetResults,
        url: page.url()
      }
    };
  }

  async collectPrivateMessages(page, { watermark = null, fullSweepIntervalMs = WEIBO_PRIVATE_FULL_SWEEP_MS } = {}) {
    try {
      const operationGeneration = this.lifecycleGeneration;
      await page.goto(this.spec.messageUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(1600);
      const login = await this.inspectLoginState(page);
      if (login.state !== 'READY') return { messages: [], watermark: null, summary: { type: 'PRIVATE_MESSAGE', status: 'NEEDS_CONFIRMATION', reason: login.state, count: 0, url: page.url() } };
      const rows = page.locator('li.sessionlist');
      const snapshots = [];
      for (let index = 0, count = Math.min(await rows.count().catch(() => 0), 100); index < count; index += 1) {
        const locator = rows.nth(index);
        const conversation = await this.readConversationRow(locator, index);
        if (conversation.userName && conversation.preview) snapshots.push({ ...conversation, locator });
      }
      const previousSessions = watermark?.sessions && typeof watermark.sessions === 'object' ? watermark.sessions : {};
      const sessions = { ...previousSessions };
      const messages = [];
      const ignoredConversations = [];
      let incomplete = false;
      let baselineCount = 0;
      let candidateCount = 0;
      const collectedAtMs = Date.now();
      const performFullSweep = fullSweepDue(watermark?.lastFullSweepAt, fullSweepIntervalMs, collectedAtMs);
      for (const conversation of snapshots) {
        await this.assertWeiboOperationAllowed(operationGeneration);
        const cursorKey = privateCursorKey(conversation);
        const previous = previousSessions[cursorKey] && typeof previousSessions[cursorKey] === 'object' ? previousSessions[cursorKey] : null;
        const previewHash = privatePreviewHash(conversation);
        const conversationTiming = eventMetadata(conversation.eventTime, collectedAtMs);
        const eventTimeMs = positiveNumber(conversationTiming.eventTimeMs);
        const sourceAssessment = assessWeiboConversationSource(conversation, this.conversationSourceOptions);
        const baseCursor = {
          conversationKey: cursorKey,
          userName: conversation.userName,
          lastMessageId: clean(previous?.lastMessageId) || null,
          recentMessageIds: uniqueStableIds(previous?.recentMessageIds),
          lastPreviewHash: previewHash,
          lastEventTimeMs: Math.max(positiveNumber(previous?.lastEventTimeMs) || 0, eventTimeMs || 0) || null,
          lastCheckedAt: new Date(collectedAtMs).toISOString(),
          initializedAt: validIso(previous?.initializedAt) || new Date(collectedAtMs).toISOString(),
          extractionIncomplete: previous?.extractionIncomplete === true
        };
        if (sourceAssessment.isOfficial === true && sourceAssessment.confidence === 'HIGH') {
          ignoredConversations.push({ index: conversation.index, userName: conversation.userName, conversationKey: conversation.conversationKey, reason: sourceAssessment.reason, signals: sourceAssessment.signals });
          sessions[cursorKey] = { ...baseCursor, extractionIncomplete: false };
          continue;
        }
        const previewChanged = Boolean(previous && clean(previous.lastPreviewHash) !== previewHash);
        const eventAdvanced = Boolean(previous && eventTimeMs && eventTimeMs > (positiveNumber(previous.lastEventTimeMs) || 0));
        const periodicCandidate = Boolean(previous && performFullSweep && conversation.index < 25);
        const shouldOpen = conversation.unreadCount >= 1 || previous?.extractionIncomplete === true || previewChanged || eventAdvanced || periodicCandidate;
        if (!previous && conversation.unreadCount < 1) {
          baselineCount += 1;
          sessions[cursorKey] = { ...baseCursor, extractionIncomplete: false };
          continue;
        }
        if (!shouldOpen) {
          sessions[cursorKey] = { ...baseCursor, extractionIncomplete: false };
          continue;
        }
        candidateCount += 1;
        const targetRow = await this.locateConversationRow(page, conversation);
        if (!targetRow) {
          incomplete = true;
          sessions[cursorKey] = { ...baseCursor, extractionIncomplete: true };
          continue;
        }
        try { await targetRow.click(); } finally { await targetRow.dispose(); }
        await page.waitForTimeout(800);
        const chatTitle = clean(await page.locator('.message .header .friendname').first().innerText().catch(() => ''));
        const titleVerified = chatTitle === conversation.userName;
        const opened = titleVerified ? await this.extractOpenIncomingMessages(page, conversation) : [];
        const stableOpened = opened.filter(item => stableNumericId(item.messageId) && item.direction === 'incoming' && item.sourceVerified === true);
        if (!stableOpened.length) {
          incomplete = true;
          messages.push({ messageType: 'PRIVATE_MESSAGE', externalId: `weibo-private-preview-${digest([conversation.conversationKey, conversation.userName, conversation.preview, conversation.eventTime])}`, userName: conversation.userName, content: conversation.preview.slice(0, 1000), externalUrl: this.spec.messageUrl, context: { platformCode: 'weibo', previewOnly: true, unreadCount: conversation.unreadCount, eventTime: conversation.eventTime, ...conversationTiming, conversationKey: conversation.conversationKey, chatTitleVerified: titleVerified, sourceVerified: false, sourceType: 'USER', officialSource: false, sourceAssessment } });
          sessions[cursorKey] = { ...baseCursor, extractionIncomplete: true };
          continue;
        }
        const previousIds = new Set(uniqueStableIds(previous?.recentMessageIds));
        const lastIndex = clean(previous?.lastMessageId) ? stableOpened.findIndex(item => item.messageId === clean(previous.lastMessageId)) : -1;
        let selected = [];
        if (lastIndex >= 0) selected = stableOpened.slice(lastIndex + 1);
        else if (!previous) selected = stableOpened.slice(-Math.max(1, conversation.unreadCount));
        else if (previewChanged || eventAdvanced || conversation.unreadCount >= 1) {
          const unseen = stableOpened.filter(item => !previousIds.has(item.messageId));
          selected = previousIds.size ? unseen : unseen.slice(-Math.max(1, conversation.unreadCount || 1));
        }
        selected = selected.filter(item => !previousIds.has(item.messageId));
        if (conversation.unreadCount > selected.length && !previewChanged && lastIndex < 0) incomplete = true;
        for (const message of selected) {
          const timing = eventMetadata(message.eventTime || conversation.eventTime, collectedAtMs);
          messages.push({ messageType: 'PRIVATE_MESSAGE', externalId: `weibo-private-${message.messageId}`, userName: conversation.userName, content: message.content.slice(0, 1000), externalUrl: this.spec.messageUrl, context: { platformCode: 'weibo', previewOnly: false, unreadCount: conversation.unreadCount, eventTime: message.eventTime || conversation.eventTime, ...timing, conversationKey: conversation.conversationKey, messageId: message.messageId, direction: 'incoming', chatTitleVerified: true, sourceVerified: true, sourceType: 'USER', officialSource: false, sourceAssessment } });
        }
        const allKnownIds = uniqueStableIds([...(previous?.recentMessageIds || []), ...stableOpened.map(item => item.messageId)]);
        const lastOpened = stableOpened.at(-1);
        const openedEventMax = Math.max(...stableOpened.map(item => positiveNumber(eventMetadata(item.eventTime, collectedAtMs).eventTimeMs) || 0), 0);
        sessions[cursorKey] = {
          ...baseCursor,
          lastMessageId: lastOpened?.messageId || baseCursor.lastMessageId,
          recentMessageIds: allKnownIds,
          lastEventTimeMs: Math.max(baseCursor.lastEventTimeMs || 0, openedEventMax) || null,
          extractionIncomplete: false
        };
      }
      const nextWatermark = { sessions, lastFullSweepAt: performFullSweep ? new Date(collectedAtMs).toISOString() : validIso(watermark?.lastFullSweepAt) };
      return { messages, watermark: nextWatermark, summary: { type: 'PRIVATE_MESSAGE', status: incomplete ? 'NEEDS_CONFIRMATION' : 'SUCCESS', reason: incomplete ? 'PRIVATE_BUBBLE_EXTRACTION_INCOMPLETE' : 'VERIFIED_INCREMENTAL_USER_CONVERSATIONS', count: messages.length, baselineCount, candidateCount, fullSweep: performFullSweep, ignoredCount: ignoredConversations.length, ignoredConversations, url: page.url() } };
    } catch (error) {
      if (['PLATFORM_STOPPED', 'PLATFORM_OPERATION_CANCELLED'].includes(error.code)) throw error;
      return { messages: [], watermark: null, summary: { type: 'PRIVATE_MESSAGE', status: 'NEEDS_CONFIRMATION', reason: error.message, count: 0, url: page.url() } };
    }
  }

  async collectMessages(payload) {
    const requested = new Set((payload.types || ['COMMENT', 'PRIVATE_MESSAGE']).map(v => String(v).toUpperCase()));
    const targetedRecovery = recoveryCollectionTargets(payload);
    if (targetedRecovery && !targetedRecovery.ok) return recoveryCollectionFailure(targetedRecovery.code, '微博旧会话恢复任务缺少平台稳定会话标识，已禁止泛扫历史会话');
    if (targetedRecovery && (requested.size !== 1 || !requested.has('PRIVATE_MESSAGE'))) {
      return recoveryCollectionFailure('RECOVERY_PRIVATE_MESSAGE_ONLY', '微博旧会话恢复任务只允许定向采集私信');
    }
    const page = await this.getPage();
    const messages = [];
    const typeResults = [];
    const collectionWatermarks = {};
    if (requested.has('COMMENT')) {
      const result = await this.collectComments(page, { watermark: payload.collectionWatermarks?.COMMENT });
      messages.push(...result.messages);
      typeResults.push(result.summary);
      if (result.watermark) collectionWatermarks.COMMENT = result.watermark;
    }
    if (requested.has('PRIVATE_MESSAGE')) {
      const result = targetedRecovery
        ? await this.collectTargetedPrivateMessages(page, payload, targetedRecovery)
        : await this.collectPrivateMessages(page, { watermark: payload.collectionWatermarks?.PRIVATE_MESSAGE });
      messages.push(...result.messages);
      typeResults.push(result.summary);
      if (result.watermark) collectionWatermarks.PRIVATE_MESSAGE = result.watermark;
    }
    const successfulScopeNames = typeResults.filter(item => item.status === 'SUCCESS').map(item => item.type);
    const partialScopeNames = typeResults.filter(item => item.status !== 'SUCCESS' && collectionWatermarks[item.type]).map(item => item.type);
    const failed = typeResults.some(item => item.status !== 'SUCCESS');
    const evidence = await this.evidence(payload, failed ? '微博存在未可靠完成的消息采集区域' : `微博消息采集完成：${typeResults.map(item => `${item.type === 'COMMENT' ? '评论' : '私信'} ${item.count} 条`).join('，')}`, page, failed ? 'message_page_unverified' : 'messages_collected', { typeResults });
    return { status: failed ? 'NEEDS_CONFIRMATION' : 'SUCCESS', result: { ...evidence, messages, typeResults, collectionWatermarks, successfulScopeNames, partialScopeNames } };
  }

  async locateCommentTarget(page, payload, { maxRounds = 10 } = {}) {
    const operationGeneration = this.lifecycleGeneration;
    const expectedId = clean(payload?.messageContext?.commentId || payload?.context?.commentId || commentIdFromUrl(payload?.externalUrl));
    if (!stableNumericId(expectedId)) return { ok: false, reason: 'COMMENT_ID_MISSING', matchCount: 0 };
    for (let round = 1; round <= Math.max(1, Number(maxRounds) || 10); round += 1) {
      await this.assertWeiboOperationAllowed(operationGeneration);
      const rows = page.locator('.wbpro-scroller-item');
      const matches = [];
      for (let i = 0, n = Math.min(await rows.count().catch(() => 0), 100); i < n; i += 1) {
        const locator = rows.nth(i); const candidate = await this.readCommentRow(locator, i); const identity = matchWeiboCommentIdentity(candidate, payload);
        if (identity.matched) matches.push({ locator, candidate, identity, index: i });
      }
      if (matches.length === 1) return { ok: true, ...matches[0], uniqueTargetMatch: true, targetIdentityVerified: true, scanRounds: round };
      if (matches.length > 1) return { ok: false, reason: 'COMMENT_TARGET_AMBIGUOUS', matchCount: matches.length, scanRounds: round };
      if (round >= Math.max(1, Number(maxRounds) || 10)) break;
      const advance = await this.advanceHistoricalCommentList(page, { selectors: ['.wbpro-scroller'] });
      if (!advance.attempted || !advance.moved) return { ok: false, reason: 'COMMENT_TARGET_MISSING', matchCount: 0, scanRounds: round, exhausted: true, lastAdvance: advance };
      await page.waitForTimeout(500);
    }
    return { ok: false, reason: 'COMMENT_TARGET_MISSING', matchCount: 0, scanRounds: Math.max(1, Number(maxRounds) || 10) };
  }

  async inspectReplyTarget(payload = {}) {
    const page = await this.getPage();
    const inbox = await this.openCommentInbox(page, { waitMs: 1200 });
    const login = inbox.login || await this.inspectLoginState(page);
    if (!inbox.ok) return { login, inspectionOnly: true, sent: false, target: { ok: false, reason: inbox.reason }, url: page.url() };
    const target = await this.locateCommentTarget(page, payload);
    if (!target.ok) return { login, inspectionOnly: true, sent: false, target, url: page.url() };
    const trigger = await firstVisible([target.locator.locator('i.woo-font--comment'), target.locator.getByText(/^\u56de\u590d$/, { exact: true })]);
    if (trigger) { await trigger.click().catch(() => {}); await page.waitForTimeout(650); }
    const debug = await target.locator.evaluate(el => {
      const t = value => String(value || '').replace(/\s+/g, ' ').trim();
      const shown = node => { const style = getComputedStyle(node); return style.display !== 'none' && style.visibility !== 'hidden' && node.getClientRects().length; };
      const controls = [...document.querySelectorAll('textarea,input,[contenteditable="true"],button,[role="button"],div,span')].filter(node => shown(node) && (['TEXTAREA','INPUT','BUTTON'].includes(node.tagName) || node.getAttribute('contenteditable') === 'true' || /^(\u56de\u590d|\u53d1\u9001|\u8bc4\u8bba)$/.test(t(node.innerText || node.textContent)))).slice(0, 150).map(node => ({ tag: node.tagName.toLowerCase(), text: t(node.innerText || node.textContent).slice(0, 300), placeholder: node.getAttribute('placeholder'), role: node.getAttribute('role'), contenteditable: node.getAttribute('contenteditable'), className: String(node.className || '').slice(0, 500), outerHTML: String(node.outerHTML || '').slice(0, 8000), parentHTML: String(node.parentElement?.outerHTML || '').slice(0, 12000) }));
      return { rowHTML: String(el.outerHTML || '').slice(0, 30000), controls };
    }).catch(() => ({ rowHTML: '', controls: [] }));
    const screenshotPath = path.join(this.logsDir, `weibo-comment-reply-inspection-${Date.now()}.png`); await page.screenshot({ path: screenshotPath, fullPage: false }).catch(() => {});
    return { login, inspectionOnly: true, sent: false, target: { ok: true, candidate: target.candidate, identity: target.identity, index: target.index }, triggerFound: Boolean(trigger), debug, url: page.url(), screenshotPath: fs.existsSync(screenshotPath) ? screenshotPath : null };
  }

  async inspectOpenPrivateConversation(page, payload, requireSource = true, candidate = {}) {
    const chats = await uniqueVisibleFromLocator(page.locator('.message'));
    if (chats.count !== 1) return { ok: false, reason: chats.count ? 'PRIVATE_CHAT_AMBIGUOUS' : 'PRIVATE_CHAT_MISSING' };
    const scope = chats.locator;
    const chatTitle = clean(await scope.locator('.header .friendname').first().innerText().catch(() => ''));
    if (!chatTitle || chatTitle !== clean(payload.userName)) return { ok: false, reason: 'PRIVATE_CHAT_TITLE_MISMATCH', expectedUserName: clean(payload.userName), chatTitle };
    let sourceMessage = null;
    if (requireSource) {
      const context = payload.messageContext || {};
      if (context.previewOnly === true) return { ok: false, reason: 'PRIVATE_PREVIEW_ONLY' };
      const candidates = await this.extractOpenIncomingMessages(page, { ...candidate, userName: chatTitle }, scope);
      const sourceMatches = candidates.filter(item => matchWeiboPrivateMessageIdentity(item, payload).matched);
      if (sourceMatches.length !== 1) return { ok: false, reason: sourceMatches.length ? 'PRIVATE_SOURCE_AMBIGUOUS' : 'PRIVATE_SOURCE_NOT_VISIBLE', sourceMatchCount: sourceMatches.length, expectedMessageId: clean(context.messageId) || null };
      sourceMessage = sourceMatches[0];
    }
    return { ok: true, candidate, sourceMessage, chatTitle, scope, uniqueTargetMatch: true, targetIdentityVerified: true };
  }

  async openPrivateConversation(page, payload, requireSource = true) {
    const context = payload.messageContext || {};
    if (context.sourceType === 'OFFICIAL_OR_SYSTEM' || context.officialSource === true) return { ok: false, reason: 'PRIVATE_OFFICIAL_SOURCE' };
    const requestedSource = assessWeiboConversationSource({ userName: payload.userName }, this.conversationSourceOptions);
    if (requestedSource.isOfficial === true && requestedSource.confidence === 'HIGH') return { ok: false, reason: 'PRIVATE_OFFICIAL_SOURCE', sourceAssessment: requestedSource };
    let currentConversation = null;
    if (CHAT_RE.test(page.url())) {
      if ((await this.inspectLoginState(page)).state !== 'READY') return { ok: false, reason: 'LOGIN_REQUIRED' };
      // A matching stable incoming message proves an already open chat without a reload.
      if (requireSource) {
        currentConversation = await this.inspectOpenPrivateConversation(page, payload, true);
      }
    } else {
      await page.goto(this.spec.messageUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(1100);
      if ((await this.inspectLoginState(page)).state !== 'READY') return { ok: false, reason: 'LOGIN_REQUIRED' };
    }
    const rows = page.locator('li.sessionlist'); const matches = []; const officialMatches = [];
    for (let i = 0, n = Math.min(await rows.count().catch(() => 0), 100); i < n; i += 1) {
      const row = rows.nth(i); const candidate = await this.readConversationRow(row, i);
      if (candidate.userName !== clean(payload.userName) || (clean(context.conversationKey) && clean(candidate.conversationKey) !== clean(context.conversationKey))) continue;
      const sourceAssessment = assessWeiboConversationSource(candidate, this.conversationSourceOptions);
      if (sourceAssessment.isOfficial === true && sourceAssessment.confidence === 'HIGH') officialMatches.push({ candidate, sourceAssessment, index: i });
      else matches.push({ row, candidate: { ...candidate, sourceAssessment }, index: i });
    }
    if (officialMatches.length) return { ok: false, reason: 'PRIVATE_OFFICIAL_SOURCE', matchCount: officialMatches.length, sourceAssessment: officialMatches[0].sourceAssessment };
    if (currentConversation?.ok) return { ...currentConversation, reusedCurrentConversation: true };
    if (matches.length !== 1) return { ok: false, reason: matches.length ? 'PRIVATE_TARGET_AMBIGUOUS' : 'PRIVATE_TARGET_MISSING', matchCount: matches.length };
    const row = await this.locateConversationRow(page, matches[0].candidate);
    if (!row) return { ok: false, reason: 'PRIVATE_TARGET_CHANGED' };
    try { await row.click(); } finally { await row.dispose(); }
    await page.waitForTimeout(900);
    const opened = await this.inspectOpenPrivateConversation(page, payload, requireSource, matches[0].candidate);
    return { ...opened, index: matches[0].index };
  }

  async findPrivateEditor(messageScope) {
    // Weibo's composer is a sibling of .message inside the same .textbox.
    // Resolve only that direct parent; unrelated page editors must stay excluded.
    const textbox = await uniqueVisibleFromLocator(messageScope.locator('xpath=parent::*[contains(concat(" ", normalize-space(@class), " "), " textbox ")]'));
    if (textbox.count > 1) return null;
    const scope = textbox.locator || messageScope;
    const editors = await uniqueVisibleFromLocator(scope.locator('textarea#webchat-textarea.editor.textarea-content'));
    return editors.locator;
  }

  async openCommentReplyComposer(page, target) {
    const iconTrigger = target.locator.locator('i.woo-font--comment').locator('xpath=ancestor::*[contains(concat(" ", normalize-space(@class), " "), " _wrap_")][1]');
    const icon = await uniqueVisibleFromLocator(iconTrigger, { enabled: true });
    let trigger = icon.count === 1 ? icon.locator : null;
    if (!trigger && icon.count === 0) {
      const textTrigger = await uniqueVisibleFromLocator(target.locator.getByText(/^\u56de\u590d$/, { exact: true }), { enabled: true });
      if (textTrigger.count === 1) trigger = textTrigger.locator;
      else return { ok: false, reason: textTrigger.count ? 'COMMENT_REPLY_TRIGGER_AMBIGUOUS' : 'COMMENT_REPLY_TRIGGER_MISSING', matchCount: textTrigger.count };
    } else if (icon.count > 1) return { ok: false, reason: 'COMMENT_REPLY_TRIGGER_AMBIGUOUS', matchCount: icon.count };
    await trigger.click();
    await page.waitForTimeout(500);
    const editors = await uniqueVisibleFromLocator(page.locator('textarea[placeholder="\u53d1\u5e03\u4f60\u7684\u56de\u590d"]'));
    if (editors.count !== 1) return { ok: false, reason: editors.count ? 'COMMENT_EDITOR_AMBIGUOUS' : 'COMMENT_EDITOR_MISSING', matchCount: editors.count };
    const expectedTitles = [`\u56de\u590d @${target.candidate.userName}`, `\u56de\u590d@${target.candidate.userName}`];
    const title = await uniqueVisibleExact(page, expectedTitles);
    if (title.status !== 'UNIQUE') return { ok: false, reason: title.status === 'AMBIGUOUS' ? 'COMMENT_COMPOSER_TITLE_AMBIGUOUS' : 'COMMENT_COMPOSER_TITLE_MISMATCH', matchCount: title.count, expectedTitles };
    const scope = editors.locator.locator('xpath=ancestor::*[.//button[normalize-space(.)="\u56de\u590d"]][1]');
    const composerScope = await scope.count().catch(() => 0) === 1 ? scope.first() : page;
    return { ok: true, editor: editors.locator, scope: composerScope, title: title.label, triggerMethod: icon.count === 1 ? 'comment-icon' : 'reply-text' };
  }

  async countScopedEchoes(scope, replyText, outgoingOnly = false) {
    const locator = outgoingOnly
      ? scope.locator('ul.chat-content > li .message-item.me .puretext')
      : scope.locator('[class*="_replyComment_"], [class*="_wbtext_"], p, pre, li');
    return locator.evaluateAll((els, options) => els.filter(el => {
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || !el.getClientRects().length) return false;
      return String(el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim() === options.target;
    }).length, { target: clean(replyText) }).catch(() => 0);
  }


  async inspectCommentDetailReply(page, payload, expectedReply, { timeoutMs = 10_000 } = {}) {
    const operationGeneration = this.lifecycleGeneration;
    const identity = weiboCommentDetailIdentity(payload);
    const replyText = clean(expectedReply);
    const sourceContent = clean(payload.sourceContent);
    if (!identity.externalUrl || !replyText || !sourceContent) {
      return { handled: false, reason: 'COMMENT_DETAIL_INPUT_MISSING', ...identity, sourceMatchCount: 0, authoredReplyCount: 0 };
    }
    await this.assertWeiboOperationAllowed(operationGeneration);
    try {
      await page.goto(identity.externalUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    } catch (error) {
      return { handled: false, reason: 'COMMENT_DETAIL_NAVIGATION_FAILED', message: error.message, ...identity, sourceMatchCount: 0, authoredReplyCount: 0 };
    }
    const deadline = Date.now() + Math.max(2_000, Number(timeoutMs) || 10_000);
    let domEvidence = { sourceMatchCount: 0, authoredReplyCount: 0, sourceSnippets: [], replySnippets: [] };
    do {
      await this.assertWeiboOperationAllowed(operationGeneration);
      domEvidence = await page.evaluate(({ sourceContent: source, expectedReply: reply, ownerUid }) => {
        const text = value => String(value || '').normalize('NFC').replace(/[​-‍﻿]/g, '').replace(/\s+/g, ' ').trim();
        const visible = element => {
          if (!element || !(element instanceof Element)) return false;
          const style = getComputedStyle(element);
          return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) > 0 && element.getClientRects().length > 0;
        };
        const nodes = [...document.querySelectorAll('div,span,p,pre,li')].filter(visible);
        const sourceNodes = nodes.filter(element => {
          if (text(element.innerText || element.textContent) !== source) return false;
          return ![...element.children].some(child => visible(child) && text(child.innerText || child.textContent) === source);
        });
        const replyContainers = new Set();
        const replySnippets = [];
        const selfLinks = [...document.querySelectorAll('a[href]')].filter(link => {
          if (!visible(link)) return false;
          try { return new URL(link.href, location.href).pathname === `/u/${ownerUid}`; } catch { return false; }
        });
        for (const link of selfLinks) {
          let current = link.parentElement;
          for (let depth = 0; current && depth < 6; depth += 1, current = current.parentElement) {
            if (!visible(current)) continue;
            const currentText = text(current.innerText || current.textContent);
            if (!currentText.includes(reply) || currentText.length > reply.length + 180) continue;
            replyContainers.add(current);
            replySnippets.push({ text: currentText.slice(0, reply.length + 180), className: String(current.className || '').slice(0, 300) });
            break;
          }
        }
        return {
          sourceMatchCount: sourceNodes.length,
          authoredReplyCount: replyContainers.size,
          sourceSnippets: sourceNodes.slice(0, 5).map(element => ({ text: text(element.innerText || element.textContent).slice(0, 500), className: String(element.className || '').slice(0, 300) })),
          replySnippets: replySnippets.slice(0, 5),
          selfAuthorLinkCount: selfLinks.length,
          bodyHasExactReply: text(document.body?.innerText || '').includes(reply)
        };
      }, { sourceContent, expectedReply: replyText, ownerUid: identity.ownerUid }).catch(error => ({
        sourceMatchCount: 0,
        authoredReplyCount: 0,
        sourceSnippets: [],
        replySnippets: [],
        evaluationError: error.message
      }));
      if (domEvidence.sourceMatchCount > 0 && domEvidence.authoredReplyCount > 0) break;
      if (Date.now() >= deadline) break;
      await page.waitForTimeout(500);
    } while (Date.now() < deadline);
    const assessment = assessWeiboCommentDetailReplyEvidence({
      requestedUrl: identity.externalUrl,
      finalUrl: page.url(),
      expectedCommentId: identity.commentId,
      expectedPostId: identity.postId,
      ownerUid: identity.ownerUid,
      sourceMatchCount: domEvidence.sourceMatchCount,
      authoredReplyCount: domEvidence.authoredReplyCount
    });
    return {
      ...identity,
      ...domEvidence,
      ...assessment,
      finalUrl: page.url(),
      detectionSource: 'COMMENT_DETAIL_THREAD',
      readOnly: true
    };
  }

  async sendPrivateReply(editor) {
    await editor.press('Enter');
    return { clicked: true, method: 'weibo-chat:enter-key' };
  }

  async clickCommentReply(scope) {
    const locator = scope.getByRole('button', { name: /^\u56de\u590d$/, exact: true }); const deadline = Date.now() + 3000; let visibleCount = 0; let enabled = [];
    do {
      visibleCount = 0; enabled = [];
      for (let i = 0, n = await locator.count().catch(() => 0); i < n; i += 1) {
        const item = locator.nth(i); if (!await visible(item)) continue; visibleCount += 1;
        if (await item.isEnabled().catch(() => false)) enabled.push(item);
      }
      if (visibleCount === 1 && enabled.length === 1) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    } while (Date.now() < deadline);
    if (visibleCount !== 1) return { clicked: false, reason: visibleCount ? 'COMMENT_SEND_AMBIGUOUS' : 'COMMENT_SEND_MISSING', count: visibleCount };
    if (enabled.length !== 1) return { clicked: false, reason: 'COMMENT_SEND_DISABLED', count: enabled.length };
    await enabled[0].click(); return { clicked: true, method: 'weibo-comment:scoped-reply-button' };
  }

  async replyToMessage(payload) {
    const validation = validateWeiboReplyPayload(payload);
    if (!validation.ok) return { status: 'NEEDS_CONFIRMATION', result: await this.evidence(payload, validation.message, null, 'reply_source_blocked', { reason: validation.reason }) };
    const operationGeneration = this.lifecycleGeneration;
    const replyText = clean(payload.replyText);
    const page = await this.getPage();
    const isPrivate = validation.messageType === 'PRIVATE_MESSAGE';
    let target;
    let scope;
    let editor;
    let composer = null;
    let sendAttempted = false;
    try {
      if (isPrivate) {
        target = await this.openPrivateConversation(page, payload, true);
        if (!target.ok) return { status: 'NEEDS_CONFIRMATION', result: await this.evidence(payload, 'The private-message target could not be uniquely verified.', page, 'reply_target_missing', { privateTarget: target }) };
        scope = target.scope || page.locator('.message');
        editor = await this.findPrivateEditor(scope);
      } else {
        const inbox = await this.openCommentInbox(page, { waitMs: 1100 });
        if (!inbox.ok) return { status: 'NEEDS_CONFIRMATION', result: await this.evidence(payload, 'The received-comment inbox is not ready.', page, 'reply_login_required', { inbox }) };
        target = await this.locateCommentTarget(page, payload);
        if (!target.ok) return { status: 'NEEDS_CONFIRMATION', result: await this.evidence(payload, 'The comment target could not be uniquely verified.', page, 'reply_target_missing', { commentTarget: target }) };
        scope = target.locator;
        composer = await this.openCommentReplyComposer(page, target);
        if (!composer.ok) return { status: 'NEEDS_CONFIRMATION', result: await this.evidence(payload, 'The scoped comment reply composer could not be verified.', page, 'reply_editor_missing', { composer }) };
        editor = composer.editor;
      }
      if (!editor) return { status: 'NEEDS_CONFIRMATION', result: await this.evidence(payload, 'The reply editor was not found.', page, 'reply_editor_missing') };
      const baselineEchoCount = await this.countScopedEchoes(scope, replyText, isPrivate);
      await fillEditor(editor, replyText);
      const filled = await editorValue(editor);
      if (filled !== replyText) return { status: 'NEEDS_CONFIRMATION', result: await this.evidence(payload, 'Reply editor content verification failed.', page, 'reply_fill_mismatch', { expected: replyText, actual: filled }) };
      await this.assertWeiboOperationAllowed(operationGeneration);
      if (isPrivate && target.scope) {
        const current = await this.inspectOpenPrivateConversation(page, payload, true, target.candidate);
        if (!current.ok || await editorValue(editor) !== replyText) return { status: 'NEEDS_CONFIRMATION', result: await this.evidence(payload, 'The private conversation changed before sending.', page, 'reply_target_changed', { sendAttempted: false, reason: current.reason || 'PRIVATE_EDITOR_CHANGED' }) };
      }
      sendAttempted = true;
      const send = isPrivate ? await this.sendPrivateReply(editor) : await this.clickCommentReply(composer.scope);
      if (!send.clicked) return { status: 'NEEDS_CONFIRMATION', result: await this.evidence(payload, 'The unique scoped reply control was not available.', page, 'reply_send_missing', { send }) };
      let proof = { confirmed: false, editorCleared: false, scopedEchoCount: baselineEchoCount, baselineEchoCount };
      const until = Date.now() + Math.max(10_000, Number(this.sendTimeoutMs) || 30_000);
      if (isPrivate) {
        while (Date.now() < until) {
          if (target.scope) {
            const current = await this.inspectOpenPrivateConversation(page, payload, true, target.candidate);
            if (!current.ok) { proof = { ...proof, reason: current.reason, targetIdentityVerified: false }; break; }
          }
          const remaining = await editorValue(editor);
          const scopedEchoCount = await this.countScopedEchoes(scope, replyText, true);
          proof = { confirmed: !remaining && scopedEchoCount > baselineEchoCount, editorCleared: !remaining, scopedEchoCount, baselineEchoCount, detectionSource: 'PRIVATE_CONVERSATION' };
          if (proof.confirmed) break;
          await page.waitForTimeout(500);
        }
      } else {
        while (Date.now() < until) {
          const remaining = await editorValue(editor);
          proof = { ...proof, editorCleared: !remaining };
          if (!remaining) break;
          await page.waitForTimeout(300);
        }
        let sentReceipt = { handled: false, reason: 'SENT_COMMENT_RECEIPT_NOT_CHECKED', matchCount: 0 };
        if (proof.editorCleared) {
          do {
            sentReceipt = await this.inspectSentCommentReply(page, payload, replyText, { maxRounds: 3 });
            if (sentReceipt.handled === true || sentReceipt.reason === 'SENT_COMMENT_TARGET_AMBIGUOUS' || Date.now() >= until) break;
            await page.waitForTimeout(800);
          } while (Date.now() < until);
        }
        let detail = null;
        if (sentReceipt.handled !== true) detail = await this.inspectCommentDetailReply(page, payload, replyText);
        const receiptHandled = sentReceipt.handled === true || detail?.handled === true;
        proof = {
          ...proof,
          confirmed: proof.editorCleared && receiptHandled,
          scopedEchoCount: sentReceipt.handled === true ? sentReceipt.matchCount : (detail?.authoredReplyCount || 0),
          detectionSource: sentReceipt.handled === true ? 'SENT_COMMENT_INBOX' : (detail?.handled === true ? 'COMMENT_DETAIL_THREAD' : null),
          sentReceipt,
          detail
        };
      }
      const identity = { targetIdentityVerified: target.targetIdentityVerified === true, uniqueTargetMatch: target.uniqueTargetMatch === true };
      if (isPrivate && !proof.confirmed) return { status: 'NEEDS_CONFIRMATION', result: await this.evidence(payload, '微博私信已尝试发送，但未在已核验会话中确认本次新增回复；禁止自动重发，请人工核对', page, 'reply_unconfirmed', { ...proof, sendAttempted: true, manualActionRequired: true }) };
      if (!proof.confirmed) return { status: 'NEEDS_CONFIRMATION', result: await this.evidence(payload, '微博已尝试发布，但未在“发出的评论”或对应帖子详情中确认四项一致的唯一回复；禁止自动重发，请人工核对', page, 'publish_unconfirmed', { ...proof, sendAttempted: true, submitAttempted: true, manualActionRequired: true, draftSaved: false }) };
      return { status: 'SUCCESS', result: await this.evidence(payload, isPrivate ? '已在微博私信会话中确认本次回复' : '已在微博“发出的评论”中按帖子、用户名、原评论和回复正文唯一确认回复成功', page, 'reply_sent', { sendMethod: send.method, ...identity, ...proof }) };
    } catch (error) {
      if (['PLATFORM_STOPPED', 'PLATFORM_OPERATION_CANCELLED'].includes(error.code) && !sendAttempted) { error.writeAttempted = false; throw error; }
      return { status: 'NEEDS_CONFIRMATION', result: await this.evidence(payload, sendAttempted ? `Reply outcome is uncertain: ${error.message}; do not retry automatically.` : `Reply preparation failed safely: ${error.message}`, page, sendAttempted ? 'reply_unconfirmed' : 'reply_failed_safe', { sendAttempted }) };
    }
  }

  async detectManualReply(payload) {
    const expectedReply = clean(payload.expectedReply);
    if (!expectedReply) return { status: 'NEEDS_CONFIRMATION', result: { handled: false, message: '缺少需要检测的人工回复内容' } };
    const page = await this.getPage();
    const isPrivate = String(payload.messageType).toUpperCase() === 'PRIVATE_MESSAGE';
    if (isPrivate) {
      const target = await this.openPrivateConversation(page, payload, false);
      const scope = target?.scope || page.locator('.message');
      if (!target?.ok || !scope) return { status: 'NEEDS_CONFIRMATION', result: await this.evidence(payload, '未可靠定位微博私信会话，无法检测回复', page, 'manual_detect_target_missing', { handled: false, target }) };
      const count = await this.countScopedEchoes(scope, expectedReply, true);
      if (count > 0) {
        return { status: 'SUCCESS', result: await this.evidence(payload, '已在微博唯一私信会话范围内检测到指定回复', page, 'manual_reply_detected', { handled: true, scopedEchoCount: count, detectionSource: 'PRIVATE_CONVERSATION', targetIdentityVerified: true, uniqueTargetMatch: true }) };
      }
      return { status: 'SUCCESS', result: await this.evidence(payload, '未在微博唯一私信会话范围内检测到指定回复', page, 'manual_reply_detected', { handled: false, scopedEchoCount: 0, detectionSource: 'PRIVATE_CONVERSATION', targetIdentityVerified: true, uniqueTargetMatch: true }) };
    }

    const inbox = await this.openCommentInbox(page, { waitMs: 900 });
    const incomingTarget = inbox.ok ? await this.locateCommentTarget(page, payload) : { ok: false, reason: inbox.reason };
    const sentReceipt = await this.inspectSentCommentReply(page, payload, expectedReply);
    if (sentReceipt.handled === true) {
      return { status: 'SUCCESS', result: await this.evidence(payload, '已在微博“发出的评论”中按帖子、用户名、原评论和回复正文唯一确认回复成功', page, 'manual_reply_detected', { handled: true, scopedEchoCount: sentReceipt.matchCount, detectionSource: 'SENT_COMMENT_INBOX', targetIdentityVerified: true, uniqueTargetMatch: true, incomingTarget, sentReceipt }) };
    }
    const detail = await this.inspectCommentDetailReply(page, payload, expectedReply);
    if (detail.handled === true) {
      return { status: 'SUCCESS', result: await this.evidence(payload, '“发出的评论”暂未命中，但已在对应微博详情页检测到账号发出的完整回复', page, 'manual_reply_detected', { handled: true, scopedEchoCount: detail.authoredReplyCount, detectionSource: 'COMMENT_DETAIL_THREAD', targetIdentityVerified: true, uniqueTargetMatch: true, incomingTarget, sentReceipt, detail }) };
    }
    return { status: 'SUCCESS', result: await this.evidence(payload, '微博“发出的评论”和对应帖子详情均未检测到四项一致的唯一回复', page, 'manual_reply_detected', { handled: false, scopedEchoCount: 0, detectionSource: 'SENT_COMMENT_INBOX', targetIdentityVerified: false, uniqueTargetMatch: false, incomingTarget, sentReceipt, detail }) };
  }
}
