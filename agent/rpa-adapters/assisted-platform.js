import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { chromium } from 'playwright-core';
import { forceStopProfileProcesses, listWindowsProcesses, profileProcessTreeIds } from '../platform-process-cleanup.js';
import { resolveUploadTimeoutMs } from '../publish-upload-timeout.js';
import { RpaAdapter } from './base.js';
import { analyzePublishReadiness, contentDeclarationLabels, normalizeContentOrigin } from './publish-guard.js';
import { assessDouyinPrivatePreview } from '../../src/services/message-precision.js';
import { douyinPrivateOccurrenceAnchor } from '../../src/services/douyin-message-identity.js';
import { douyinCommentOccurrenceAnchor } from '../../src/services/comment-identity.js';
import { assessAutoReplyEligibility } from '../../src/services/auto-reply-eligibility.js';
import { isGreetingOnlyMessage } from '../../src/services/conversation-intent.js';
import { normalizeReplyTextForComparison, validateReplyTextLength } from '../../src/services/platform-reply-policy.js';

const channelPageScope = new AsyncLocalStorage();

export function operationLaneForJob(job = {}) {
  const type = String(job.job_type || job.jobType || '').trim().toUpperCase();
  const payload = job.payload || {};
  if (['PUBLISH', 'VERIFY_PUBLISH'].includes(type)) return 'COMMENT';
  if (['REPLY', 'DETECT_MANUAL_REPLY'].includes(type)) return String(payload.messageType || payload.channelType || 'PRIVATE_MESSAGE').trim().toUpperCase();
  if (type === 'COLLECT_MESSAGES') {
    const explicit = String(payload.channelType || payload.queueLane || '').trim().toUpperCase();
    if (['COMMENT', 'PRIVATE_MESSAGE'].includes(explicit)) return explicit;
    const types = Array.isArray(payload.types) ? payload.types.map(value => String(value).toUpperCase()) : [];
    if (types.length === 1 && ['COMMENT', 'PRIVATE_MESSAGE'].includes(types[0])) return types[0];
  }
  return 'GENERAL';
}

export function recoveryCollectionTargets(payload = {}) {
  const recovery = payload.recoveryScan === true || payload.oldConversationScan === true;
  if (!recovery) return null;
  const sourceTargets = Array.isArray(payload.recoveryTargets) ? payload.recoveryTargets : [];
  if (!sourceTargets.length) {
    return { recovery: true, ok: false, code: 'RECOVERY_STABLE_TARGET_REQUIRED', targets: [] };
  }
  const targets = [];
  const seen = new Set();
  for (const source of sourceTargets) {
    const externalConversationKey = clean(source?.externalConversationKey);
    if (!externalConversationKey) {
      return { recovery: true, ok: false, code: 'RECOVERY_STABLE_TARGET_REQUIRED', targets: [] };
    }
    const normalizedKey = externalConversationKey.toLowerCase();
    if (seen.has(normalizedKey)) continue;
    seen.add(normalizedKey);
    targets.push({
      conversationId: Number(source?.conversationId) > 0 ? Number(source.conversationId) : null,
      conversationNamespace: clean(source?.conversationNamespace) || null,
      externalConversationKey,
      userName: clean(source?.userName) || null
    });
  }
  if (!targets.length) {
    return { recovery: true, ok: false, code: 'RECOVERY_STABLE_TARGET_REQUIRED', targets: [] };
  }
  return {
    recovery: true,
    ok: true,
    targets: targets.slice(0, 2),
    requestedTargetCount: targets.length,
    truncatedTargetCount: Math.max(0, targets.length - 2)
  };
}

export function recoveryCollectionFailure(code = 'RECOVERY_TARGET_NOT_FOUND', message = '旧会话恢复任务无法可靠定位目标会话') {
  return {
    status: 'NEEDS_CONFIRMATION',
    result: {
      message,
      code,
      messages: [],
      recoveryTargeted: true
    }
  };
}

export function filterRecoveryCollectionOutput(output, payload = {}) {
  const recovery = recoveryCollectionTargets(payload);
  if (!recovery) return output;
  if (!recovery.ok) return recoveryCollectionFailure(recovery.code, '旧会话恢复任务缺少平台稳定会话标识，已禁止泛扫历史会话');
  const targets = recovery.targets;
  const accepted = new Set(targets.map(item => String(item.externalConversationKey).trim().toLowerCase()));
  const sourceMessages = Array.isArray(output?.result?.messages) ? output.result.messages : [];
  const messages = sourceMessages.filter(message => {
    const context = message?.context || message?.messageContext || {};
    const keys = [context.conversationKey, context.conversationId, context.chatId, context.sessionId, context.talkerId, message.externalConversationKey]
      .map(value => String(value || '').trim().toLowerCase()).filter(Boolean);
    return keys.some(key => accepted.has(key));
  });
  return { ...output, result: { ...(output?.result || {}), messages, recoveryTargetCount: targets.length, recoveryRequestedTargetCount: recovery.requestedTargetCount, recoveryTruncatedTargetCount: recovery.truncatedTargetCount, recoveryAcceptedCount: messages.length, recoveryDroppedCount: Math.max(0, sourceMessages.length - messages.length), recoveryTargeted: true } };
}

const DEFAULT_LOGIN_RE = /登录|扫码|二维码|验证码|手机号|sign\s*in|log\s*in|continue with/i;
const DEFAULT_SUCCESS_RE = /\u53d1\u5e03\u6210\u529f|\u4f5c\u54c1\u5df2\u53d1\u5e03|\u4e0a\u4f20\u6210\u529f|post published|published successfully|your video has been uploaded/i;
const DEFAULT_REJECTED_RE = /审核未通过|未通过|已拒绝|违规|rejected|not approved/i;
const DEFAULT_REVIEWING_RE = /审核中|处理中|正在处理|reviewing|processing|under review/i;
const VERIFY_RE = /captcha|verify|challenge|\u5b89\u5168\u9a8c\u8bc1|\u6ed1\u5757|\u4eba\u8138|\u5f02\u5e38\u9a8c\u8bc1|\u8bbf\u95ee\u8fc7\u4e8e\u9891\u7e41|\u73af\u5883\u5f02\u5e38/i;
const PAGE_ERROR_RE = /\u65e0\u6cd5\u8bbf\u95ee\u6b64\u7f51\u7ad9|\u7f51\u9875\u65e0\u6cd5\u6253\u5f00|\u8fde\u63a5\u5df2\u91cd\u7f6e|ERR_[A-Z_]+|404\s*not\s*found|502\s*bad\s*gateway|\u670d\u52a1\u6682\u4e0d\u53ef\u7528|\u7cfb\u7edf\u7e41\u5fd9|\u5f88\u62b1\u6b49[\uff0c,]?\s*\u672a\u627e\u5230\u76f8\u5173\u9875\u9762|\u672a\u627e\u5230\u76f8\u5173\u9875\u9762|\u9875\u9762\u4e0d\u5b58\u5728|\u5f53\u524d\u9875\u9762\u4e0d\u5b58\u5728|\u9875\u9762\u4e0d\u89c1\u5566/i;

export function clean(value) {
  return String(value ?? '').normalize('NFC').replace(/\s+/g, ' ').trim();
}

export function normalizePrivateReceiptTextForComparison(value = '') {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/[\u200B\uFEFF\uFE0E\uFE0F]/g, '')
    .replace(/[～〜]/g, '~')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, '')
    .trim();
}

export function selectPrivateConversationHeaderEvidence(candidates = [], userName = '', editorBox = null) {
  const expected = clean(userName);
  if (!expected) return { ok: false, reason: 'CONVERSATION_NAME_MISSING', candidates: [] };
  const editor = editorBox && Number.isFinite(Number(editorBox.x)) && Number.isFinite(Number(editorBox.y))
    ? {
        x: Number(editorBox.x),
        y: Number(editorBox.y),
        width: Math.max(0, Number(editorBox.width) || 0),
        height: Math.max(0, Number(editorBox.height) || 0)
      }
    : null;
  const accepted = [];
  for (const [index, item] of candidates.entries()) {
    const text = clean(item?.text);
    const className = clean(item?.className);
    const dataE2e = clean(item?.dataE2e);
    const rect = item?.rect && Number.isFinite(Number(item.rect.x)) && Number.isFinite(Number(item.rect.y))
      ? {
          x: Number(item.rect.x),
          y: Number(item.rect.y),
          width: Math.max(0, Number(item.rect.width) || 0),
          height: Math.max(0, Number(item.rect.height) || 0)
        }
      : null;
    if (text !== expected || item?.visible === false || item?.insideConversationRow === true) continue;
    const semantic = /(?:StackLayoutStackChatHeadertitle|RightPanelHeadertitle|StackChatHeader[^ ]*title|RightPanelHeader[^ ]*title)/i.test(className)
      || /(?:chat|conversation).*(?:title|header)|(?:title|header).*(?:chat|conversation)/i.test(dataE2e)
      || item?.configuredMatch === true;
    if (!semantic) continue;
    let spatial = true;
    let horizontalOverlap = null;
    if (editor && rect) {
      const left = Math.max(editor.x, rect.x);
      const right = Math.min(editor.x + editor.width, rect.x + rect.width);
      horizontalOverlap = Math.max(0, right - left);
      const candidateCenterX = rect.x + rect.width / 2;
      spatial = rect.y + rect.height <= editor.y + 24
        && candidateCenterX >= editor.x - 120
        && candidateCenterX <= editor.x + editor.width + 120
        && horizontalOverlap > 0;
    }
    if (!spatial) continue;
    let score = 0;
    if (/StackLayoutStackChatHeadertitle$/i.test(className) || /RightPanelHeadertitle$/i.test(className)) score += 100;
    else if (/(?:StackChatHeader|RightPanelHeader)[^ ]*title/i.test(className)) score += 70;
    if (item?.configuredMatch === true) score += 30;
    if (dataE2e) score += 10;
    if (editor && rect) score += 20;
    accepted.push({ index, text, className, dataE2e, rect, score, horizontalOverlap });
  }
  if (!accepted.length) return { ok: false, reason: 'CONVERSATION_HEADER_MISMATCH', candidates: [] };
  const bestScore = Math.max(...accepted.map(item => item.score));
  const best = accepted.filter(item => item.score === bestScore);
  if (best.length !== 1) return { ok: false, reason: 'CONVERSATION_HEADER_AMBIGUOUS', candidates: accepted };
  return { ok: true, headerName: best[0].text, evidence: best[0], candidates: accepted };
}

export function composePlatformPublishDescription(payload = {}, { titleFilled = false } = {}) {
  const body = clean(payload.body);
  if (titleFilled) return body;
  return clean([payload.title, body].filter(Boolean).join('\n'));
}

export function constrainPlatformTitle(value, maxLength = 0, unsupportedPattern = null) {
  const original = clean(value);
  let normalized = original;
  if (unsupportedPattern instanceof RegExp) {
    const flags = unsupportedPattern.flags.includes('g') ? unsupportedPattern.flags : unsupportedPattern.flags + 'g';
    normalized = clean(original.replace(new RegExp(unsupportedPattern.source, flags), ' '));
  }
  const characters = Array.from(normalized);
  const originalLength = Array.from(original).length;
  const sanitized = normalized !== original;
  const limit = Number(maxLength);
  if (!Number.isFinite(limit) || limit <= 0 || characters.length <= limit) {
    return { value: normalized, sanitized, truncated: false, originalLength, length: characters.length };
  }
  const constrained = characters.slice(0, Math.floor(limit)).join('');
  return { value: constrained, sanitized, truncated: true, originalLength, length: Array.from(constrained).length };
}
export function isPrivateSendControlEvidence(evidence = {}) {
  const value = clean([evidence.text, evidence.ariaLabel, evidence.title, evidence.dataAction, evidence.className].filter(Boolean).join(' '));
  if (!value || /upload|file|attachment|choose file|\u9009\u62e9\u6587\u4ef6|\u4e0a\u4f20|\u9644\u4ef6/i.test(value)) return false;
  return /(^|[^a-z])send([^a-z]|$)|\u53d1\u9001|sendbutton|send-btn|message-send/i.test(value);
}

export function digest(parts) {
  return crypto.createHash('sha256').update(parts.map(clean).join('|')).digest('hex').slice(0, 24);
}

function privatePreviewIdentity(message = {}) {
  const context = message.context || message.messageContext || {};
  const occurrenceAnchor = clean(context.occurrenceAnchor) || douyinPrivateOccurrenceAnchor(context.eventTime);
  return [
    clean(message.userName || context.conversationName),
    clean(message.content),
    clean(context.conversationKey) || occurrenceAnchor
  ].join('|');
}

export function mergeDouyinPrivateInboxMessages(mainMessages = [], strangerMessages = []) {
  const stranger = [];
  const strangerKeys = new Set();
  for (const message of strangerMessages) {
    const key = privatePreviewIdentity(message);
    if (!key || strangerKeys.has(key)) continue;
    strangerKeys.add(key);
    stranger.push(message);
  }
  const main = [];
  const mainKeys = new Set();
  for (const message of mainMessages) {
    const key = privatePreviewIdentity(message);
    if (!key || strangerKeys.has(key) || mainKeys.has(key)) continue;
    mainKeys.add(key);
    main.push(message);
  }
  return {
    messages: [...main, ...stranger],
    mainMessages: main,
    strangerMessages: stranger,
    droppedDuplicateCount: Math.max(0, mainMessages.length + strangerMessages.length - main.length - stranger.length)
  };
}

function douyinRelativeCommentMinutes(value = '') {
  const normalized = clean(value);
  if (!normalized) return null;
  if (/^(?:\u521a\u521a|\u521a\u624d)$/.test(normalized)) return 0;
  if (/^\u534a\u5c0f\u65f6\u524d$/.test(normalized)) return 30;
  let match = normalized.match(/^(\d+)\s*\u5206\u949f\u524d$/);
  if (match) return Number(match[1]);
  match = normalized.match(/^(\d+)\s*\u5c0f\u65f6\u524d$/);
  if (match) return Number(match[1]) * 60;
  return null;
}

function isSafeDouyinRelativeTimeDrift(expectedValue = '', actualValue = '', maxDriftMinutes = 5) {
  const expected = douyinRelativeCommentMinutes(expectedValue);
  const actual = douyinRelativeCommentMinutes(actualValue);
  return expected !== null && actual !== null && actual >= expected && actual - expected <= maxDriftMinutes;
}

export function matchDouyinCommentIdentity(candidate = {}, payload = {}) {
  const context = payload.messageContext || payload.context || {};
  const expected = {
    userName: clean(payload.userName),
    content: clean(payload.sourceContent),
    eventTime: clean(context.eventTime),
    fingerprint: clean(context.commentFingerprint),
    commentStableId: clean(context.commentStableId || context.commentId || context.cid),
    sourceVideoKey: clean(context.sourceVideoKey || context.postId || context.awemeId || context.itemId)
  };
  const actual = {
    userName: clean(candidate.userName),
    content: clean(candidate.content),
    eventTime: clean(candidate.eventTime),
    commentStableId: clean(candidate.commentStableId || candidate.commentId || candidate.cid),
    sourceVideoKey: clean(candidate.sourceVideoKey || candidate.postId || candidate.awemeId || candidate.itemId)
  };
  actual.fingerprint = digest([actual.userName, actual.content, actual.eventTime]);
  if (!expected.userName || !expected.content) return { matched: false, reason: 'COMMENT_IDENTITY_FIELDS_MISSING', expected, actual };
  if (!expected.eventTime && !expected.fingerprint && !expected.commentStableId) return { matched: false, reason: 'COMMENT_TIME_OR_FINGERPRINT_MISSING', expected, actual };
  if (expected.sourceVideoKey && actual.sourceVideoKey !== expected.sourceVideoKey) return { matched: false, reason: actual.sourceVideoKey ? 'COMMENT_POST_ID_MISMATCH' : 'COMMENT_POST_ID_MISSING', expected, actual };
  if (expected.commentStableId && actual.commentStableId !== expected.commentStableId) return { matched: false, reason: actual.commentStableId ? 'COMMENT_ID_MISMATCH' : 'COMMENT_ID_MISSING', expected, actual };
  if (actual.userName !== expected.userName) return { matched: false, reason: 'COMMENT_USER_MISMATCH', expected, actual };
  if (actual.content !== expected.content) return { matched: false, reason: 'COMMENT_CONTENT_MISMATCH', expected, actual };
  const stableTargetIdsMatched = Boolean(
    expected.sourceVideoKey
    && expected.commentStableId
    && actual.sourceVideoKey === expected.sourceVideoKey
    && actual.commentStableId === expected.commentStableId
  );
  // Platform display time and Vue raw time can use different formats (for
  // example "2026/08/17 23:05" versus a seconds timestamp). Once both the
  // stable work ID and stable comment ID match, time/fingerprint are only
  // descriptive evidence and must not reject the uniquely identified row.
  if (stableTargetIdsMatched) return { matched: true, reason: 'COMMENT_IDENTITY_STABLE_IDS', expected, actual };
  const relativeTimeDriftAccepted = expected.eventTime && actual.eventTime !== expected.eventTime
    && isSafeDouyinRelativeTimeDrift(expected.eventTime, actual.eventTime);
  if (expected.eventTime && actual.eventTime !== expected.eventTime && !relativeTimeDriftAccepted) {
    return { matched: false, reason: 'COMMENT_TIME_MISMATCH', expected, actual };
  }
  if (expected.fingerprint && actual.fingerprint !== expected.fingerprint && !relativeTimeDriftAccepted) {
    return { matched: false, reason: 'COMMENT_FINGERPRINT_MISMATCH', expected, actual };
  }
  return { matched: true, reason: relativeTimeDriftAccepted ? 'COMMENT_IDENTITY_RELATIVE_TIME_DRIFT' : 'COMMENT_IDENTITY_EXACT', expected, actual };
}

export function matchPrivateConversationIdentity(candidate = {}, payload = {}, { requirePreview = true } = {}) {
  const context = payload.messageContext || payload.context || {};
  const expectedName = clean(payload.userName || context.conversationName);
  const expectedPreview = clean(payload.sourceContent);
  const actualName = clean(candidate.userName || candidate.name);
  const actualPreview = clean(candidate.preview || candidate.content);
  if (!expectedName) return { matched: false, reason: 'CONVERSATION_NAME_MISSING', expectedName, expectedPreview, actualName, actualPreview };
  if (actualName !== expectedName) return { matched: false, reason: 'CONVERSATION_NAME_MISMATCH', expectedName, expectedPreview, actualName, actualPreview };
  if (requirePreview && (!expectedPreview || actualPreview !== expectedPreview)) return { matched: false, reason: 'SOURCE_PREVIEW_CHANGED', expectedName, expectedPreview, actualName, actualPreview };
  return { matched: true, reason: requirePreview ? 'CONVERSATION_AND_PREVIEW_EXACT' : 'CONVERSATION_NAME_EXACT', expectedName, expectedPreview, actualName, actualPreview };
}

export function toRegex(value, fallback) {
  if (value instanceof RegExp) return value;
  return value ? new RegExp(value, 'i') : fallback;
}

export function isNavigationTimeoutError(error) {
  const name = clean(error?.name);
  const message = String(error?.message || error || '');
  return name === 'TimeoutError'
    || /(?:page\.goto:\s*)?Timeout\s+\d+ms\s+exceeded|navigation timeout|net::ERR_TIMED_OUT/i.test(message);
}


const SOURCE_GONE_REASONS = new Set([
  'COMMENT_TARGET_NOT_FOUND',
  'MESSAGE_TARGET_NOT_FOUND',
  'COMMENT_VIDEO_TARGET_NOT_FOUND'
]);

const DEFERRED_PAGE_REASONS = new Set([
  'COMMENT_TARGET_NOT_FOUND',
  'MESSAGE_TARGET_NOT_FOUND',
  'COMMENT_VIDEO_TARGET_NOT_FOUND',
  'CONVERSATION_NOT_FOUND',
  'SOURCE_PREVIEW_CHANGED',
  'SOURCE_MESSAGE_NOT_IN_CONVERSATION',
  'SOURCE_INCOMING_MESSAGE_NOT_IN_CONVERSATION',
  'PAGE_ERROR',
  'PAGE_UNVERIFIED',
  'MESSAGE_PAGE_UNVERIFIED',
  'COMMENT_CONTENT_UNREADY',
  'PRIVATE_MESSAGE_CONTENT_UNREADY',
  'COMMENT_VIDEO_COUNT_UNAVAILABLE',
  'COMMENT_VIDEO_SEARCH_TIMEOUT',
  'COMMENT_VIDEO_SELECTION_TIMEOUT',
  'COMMENT_VIDEO_ITEMS_TIMEOUT',
  'COMMENT_VIDEO_EMPTY_UNVERIFIED',
  'PRIVATE_PAGE_LOCATOR_UNAVAILABLE',
  'CONVERSATION_HEADER_UNVERIFIED'
]);

export function classifyReplyTargetState(target = {}) {
  const reason = clean(target.reason || target.pageReason || target.readiness?.reason);
  const listVerifiedComplete = target.listVerifiedComplete === true;
  if (target.pageCheck?.valid === false || target.readiness?.ready === false) {
    return { sourceState: 'DEFERRED_PAGE_UNAVAILABLE', decision: 'DEFERRED_PAGE_UNAVAILABLE', retrySafe: true, reason: reason || 'PAGE_UNAVAILABLE', listVerifiedComplete: false };
  }
  if (SOURCE_GONE_REASONS.has(reason) && listVerifiedComplete) {
    return { sourceState: 'SOURCE_GONE', decision: 'SKIP_SOURCE_GONE', retrySafe: false, reason, listVerifiedComplete: true };
  }
  if (DEFERRED_PAGE_REASONS.has(reason)) {
    return { sourceState: 'DEFERRED_PAGE_UNAVAILABLE', decision: 'DEFERRED_PAGE_UNAVAILABLE', retrySafe: true, reason: reason || 'PAGE_UNAVAILABLE', listVerifiedComplete: false };
  }
  return { sourceState: null, decision: null, retrySafe: false, reason: reason || 'TARGET_UNVERIFIED', listVerifiedComplete: false };
}

export function isolatedCollectionFailure(type, error) {
  const message = clean(error?.message || error || 'MESSAGE_COLLECTION_FAILED');
  return {
    type: String(type || '').toUpperCase(),
    status: 'DEFERRED_PAGE_UNAVAILABLE',
    reason: isNavigationTimeoutError(error) ? 'NAVIGATION_TIMEOUT' : 'COLLECTION_TYPE_FAILED',
    sourceState: 'DEFERRED_PAGE_UNAVAILABLE',
    decision: 'DEFERRED_PAGE_UNAVAILABLE',
    count: 0,
    retrySafe: true,
    error: message
  };
}

async function locatorInnerTexts(locator, timeoutMs = 8000) {
  if (typeof locator?.allInnerTexts === 'function') return locator.allInnerTexts().catch(() => []);
  if (typeof locator?.innerText === 'function') {
    const value = await locator.innerText({ timeout: timeoutMs }).catch(() => '');
    return value ? [value] : [];
  }
  return [];
}

async function bodyText(page) {
  const texts = [];
  for (const frame of pageFrames(page)) {
    if (typeof frame?.locator !== 'function') continue;
    texts.push(...await locatorInnerTexts(frame.locator('body'), 8000));
  }
  return clean(texts.filter(Boolean).join(' '));
}

async function visibleControlText(page) {
  if (typeof page?.locator !== 'function') return '';
  return clean(await page.locator('a,button,input,textarea,[role="button"],[role="menuitem"],[role="tab"],nav').evaluateAll(elements => elements.slice(0, 500).filter(element => {
    const style = getComputedStyle(element);
    return style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity || 1) > 0 && element.getClientRects().length > 0;
  }).map(element => [
    element.innerText || element.textContent || '',
    element.getAttribute('placeholder') || '',
    element.getAttribute('aria-label') || '',
    element.getAttribute('title') || ''
  ].join(' '))).catch(() => ''));
}

export async function pageEvidenceText(page) {
  return clean([await bodyText(page), await visibleControlText(page)].filter(Boolean).join(' '));
}

async function visiblePublishSignalText(page) {
  const selectors = [
    '[role="alert"]', '[role="status"]', '[aria-live="assertive"]', '[aria-live="polite"]',
    '[class*="toast" i]', '[class*="message" i]', '[class*="notice" i]',
    '[class*="result" i]', '[class*="success" i]', '[class*="modal" i]', '[class*="dialog" i]'
  ];
  const values = [];
  for (const frame of pageFrames(page)) {
    const text = await frame.locator(selectors.join(',')).evaluateAll(elements => elements.slice(0, 200).filter(element => {
      const style = getComputedStyle(element);
      return style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity || 1) > 0 && element.getClientRects().length > 0;
    }).map(element => element.innerText || element.textContent || '')).catch(() => []);
    values.push(...text);
  }
  return clean(values.join(' '));
}

export function reliablePublishSuccessEvidence({ url = '', signalText = '', pageText = '', spec = {} } = {}) {
  const successUrlPattern = spec.publishSuccessUrlPattern ? toRegex(spec.publishSuccessUrlPattern, null) : null;
  if (successUrlPattern && successUrlPattern.test(String(url || ''))) return { confirmed: true, source: 'success-url' };
  const successPattern = toRegex(spec.successPattern, DEFAULT_SUCCESS_RE);
  const scopedText = spec.successTextScope === 'signals' ? clean(signalText) : clean([signalText, pageText].filter(Boolean).join(' '));
  if (!scopedText || !successPattern.test(scopedText)) return { confirmed: false, source: null };
  return { confirmed: true, source: spec.successTextScope === 'signals' ? 'visible-success-signal' : 'page-success-text' };
}

export function managementRecordStatus({ recordText = '', tabStatus = '', spec = {} } = {}) {
  const normalizedRecord = clean(recordText);
  if (['PUBLISHED', 'REVIEWING', 'REJECTED'].includes(tabStatus)) return tabStatus;
  if (toRegex(spec.rejectedPattern, DEFAULT_REJECTED_RE).test(normalizedRecord)) return 'REJECTED';
  if (toRegex(spec.reviewingPattern, DEFAULT_REVIEWING_RE).test(normalizedRecord)) return 'REVIEWING';
  if (toRegex(spec.publishedRecordPattern, /\u5df2\u53d1\u5e03|\u53d1\u5e03\u65f6\u95f4|\u64ad\u653e\u91cf|\u70b9\u8d5e|\u8bc4\u8bba|\u5206\u4eab/i).test(normalizedRecord)) return 'PUBLISHED';
  return 'UNKNOWN';
}

function managementBodyPrefix(body = '', length = 28) {
  const normalized = clean(body).replace(/[^\p{L}\p{N}]+/gu, '');
  return normalized.length >= 8 ? normalized.slice(0, Math.max(8, Number(length) || 28)) : '';
}

function compactManagementIdentity(value = '') {
  return clean(value).replace(/[^\p{L}\p{N}]+/gu, '');
}

export function managementRecordIdentityCandidates({ platformCode = '', title = '', body = '', spec = {} } = {}) {
  const configuredSources = Array.isArray(spec.managementIdentitySources) && spec.managementIdentitySources.length
    ? spec.managementIdentitySources
    : ['TITLE'];
  const sources = new Set(configuredSources.map(value => String(value || '').toUpperCase()));
  const candidates = [];
  const seen = new Set();
  const append = (kind, value, minimumCompactLength = 1) => {
    const candidateText = clean(value);
    const compact = compactManagementIdentity(candidateText);
    if (!candidateText || compact.length < minimumCompactLength || seen.has(compact)) return;
    seen.add(compact);
    candidates.push({ kind, text: candidateText, compact });
  };

  if (sources.has('TITLE')) append('TITLE', title);
  if (sources.has('BODY')) {
    const bodyMinimumLength = Math.max(8, Number(spec.managementBodyIdentityMinLength || 8));
    append('BODY', body, bodyMinimumLength);
  }
  return candidates;
}

function parseManagementRecordTime(recordText = '', reference = new Date()) {
  const text = clean(recordText);
  let match = text.match(/(20\d{2})[\u5e74./-](\d{1,2})[\u6708./-](\d{1,2})\u65e5?(?:\s+(\d{1,2}):(\d{2}))?/);
  if (match) return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4] || 12), Number(match[5] || 0)).getTime();
  match = text.match(/(?:\u4eca\u5929)\s*(\d{1,2}):(\d{2})/);
  if (match) return new Date(reference.getFullYear(), reference.getMonth(), reference.getDate(), Number(match[1]), Number(match[2])).getTime();
  match = text.match(/(?:\u6628\u5929)\s*(\d{1,2}):(\d{2})/);
  if (match) return new Date(reference.getFullYear(), reference.getMonth(), reference.getDate() - 1, Number(match[1]), Number(match[2])).getTime();
  return null;
}

export function platformPostIdentity(platformCode = '', href = '') {
  const url = String(href || '');
  const patterns = {
    bilibili: /\/(BV[0-9A-Za-z]+)(?:[/?#]|$)/i,
    douyin: /\/(?:video|manage\/video)\/(\d{8,})(?:[/?#]|$)/i,
    wechat_channels: /[?&](?:id|exportid|objectid)=([^&#]+)/i,
    xiaohongshu: /\/(?:explore|discovery\/item)\/([0-9a-f]{12,})(?:[/?#]|$)/i,
    weibo: /\/\d+\/([0-9A-Za-z]+)(?:[/?#]|$)/i
  };
  return url.match(patterns[String(platformCode || '').toLowerCase()])?.[1] || null;
}

export function assessManagementPublishRecord({ platformCode = '', title = '', body = '', identityText = '', identityKind = 'TITLE', recordText = '', href = '', submittedAt = '', tabStatus = '', spec = {}, exactTitleLabel = false, titleLabelStartsRecord = false, exactIdentityLabel = false, identityLabelStartsRecord = false } = {}) {
  const normalizedTitle = clean(title);
  const normalizedIdentityKind = String(identityKind || 'TITLE').toUpperCase() === 'BODY' ? 'BODY' : 'TITLE';
  const normalizedIdentity = clean(identityText || normalizedTitle);
  const normalizedRecord = clean(recordText);
  const compactRecord = normalizedRecord.replace(/[^\p{L}\p{N}]+/gu, '');
  const compactIdentity = compactManagementIdentity(normalizedIdentity);
  const identityMatched = Boolean(compactIdentity && compactRecord.includes(compactIdentity));
  if (!identityMatched) return { matched: false, reason: normalizedIdentityKind === 'BODY' ? 'BODY_NOT_MATCHED' : 'TITLE_NOT_MATCHED', reviewStatus: 'UNKNOWN', score: 0, confidence: 'LOW', matchedBy: [] };

  const matchedBy = [normalizedIdentityKind];
  let score = normalizedIdentityKind === 'BODY' ? 55 : 50;
  const exactLabel = exactIdentityLabel || exactTitleLabel;
  const labelStartsRecord = identityLabelStartsRecord || titleLabelStartsRecord;
  if (exactLabel) { matchedBy.push(normalizedIdentityKind === 'BODY' ? 'EXACT_BODY_LABEL' : 'EXACT_TITLE_LABEL'); score += 20; }
  else if (labelStartsRecord || compactRecord.startsWith(compactIdentity)) { matchedBy.push(normalizedIdentityKind === 'BODY' ? 'BODY_LABEL_PREFIX' : 'TITLE_PREFIX'); score += 12; }

  const bodyPrefix = managementBodyPrefix(body, spec.managementBodyPrefixLength || 28);
  if (normalizedIdentityKind !== 'BODY' && bodyPrefix && compactRecord.includes(bodyPrefix)) { matchedBy.push('BODY_PREFIX'); score += 18; }

  const submittedMs = Date.parse(submittedAt || '');
  const eventMs = parseManagementRecordTime(normalizedRecord, Number.isFinite(submittedMs) ? new Date(submittedMs) : new Date());
  let timeVerified = null;
  if (Number.isFinite(submittedMs) && Number.isFinite(eventMs)) {
    const toleranceMs = Number(spec.managementTimeToleranceMs || 15 * 60 * 1000);
    timeVerified = eventMs >= submittedMs - toleranceMs;
    if (!timeVerified) return { matched: false, reason: 'RECORD_BEFORE_SUBMISSION', reviewStatus: 'UNKNOWN', score, confidence: 'LOW', matchedBy, eventTime: new Date(eventMs).toISOString(), timeVerified };
    matchedBy.push('PUBLISHED_AT');
    score += 15;
  }

  const reviewStatus = managementRecordStatus({ recordText: normalizedRecord, tabStatus, spec });
  if (reviewStatus !== 'UNKNOWN') { matchedBy.push('STATUS_TAB'); score += 10; }
  const platformPostId = platformPostIdentity(platformCode, href);
  if (href) { matchedBy.push('PLATFORM_URL'); score += 8; }
  if (platformPostId) { matchedBy.push('PLATFORM_POST_ID'); score += 10; }
  const confidence = score >= 85 ? 'HIGH' : score >= 65 ? 'MEDIUM' : 'LOW';
  return { matched: true, reason: null, reviewStatus, score, confidence, matchedBy, identityKind: normalizedIdentityKind, identityText: normalizedIdentity, platformPostId, platformUrl: href || null, eventTime: Number.isFinite(eventMs) ? new Date(eventMs).toISOString() : null, timeVerified };
}

export function classifyManagementReviewEvidence({ title = '', body = '', recordText = '', href = '', submittedAt = '', tabStatus = '', platformCode = '', spec = {} } = {}) {
  return assessManagementPublishRecord({ platformCode, title, body, recordText, href, submittedAt, tabStatus, spec }).reviewStatus;
}

export async function findVisibleTitleRecord(page, title, options = {}) {
  const identityCandidates = managementRecordIdentityCandidates({
    platformCode: options.platformCode,
    title,
    body: options.body,
    spec: options.spec || {}
  });
  if (!identityCandidates.length) return null;
  const records = new Map();
  for (const [frameIndex, frame] of pageFrames(page).entries()) {
    for (const identity of identityCandidates) {
      const matches = frame.getByText(identity.text, { exact: false });
      const count = Math.min(await matches.count().catch(() => 0), 100);
      for (let index = 0; index < count; index += 1) {
        const item = matches.nth(index);
        if (!await item.isVisible().catch(() => false)) continue;
        const detail = await item.evaluate((element, expectedIdentity) => {
          const cleanText = value => String(value || '').replace(/\s+/g, ' ').trim();
          const exactLabels = [element.innerText, element.textContent, element.getAttribute('title'), element.getAttribute('aria-label')].map(cleanText).filter(Boolean);
          const exactIdentityLabel = exactLabels.includes(expectedIdentity);
          const identityLabelStartsRecord = exactLabels.some(label => label.startsWith(expectedIdentity));
          if (!exactIdentityLabel && !identityLabelStartsRecord) return null;
          const recordSignalPattern = /\u5df2\u53d1\u5e03|\u53d1\u5e03\u65f6\u95f4|\u5ba1\u6838\u4e2d|\u5ba1\u6838\u672a\u901a\u8fc7|\u672a\u901a\u8fc7|\u64ad\u653e\u91cf|\u70b9\u8d5e|\u8bc4\u8bba|\u5206\u4eab|\d{4}[\u5e74./-]\d{1,2}[\u6708./-]\d{1,2}\u65e5?(?:\s+\d{1,2}:\d{2})?/i;
          const structuralPattern = /(?:^|[\s_-])(row|item|card|list-item|table-row|feed|post|works?|video-item)(?:$|[\s_-])/i;
          const candidates = [];
          let node = element;
          for (let depth = 0; depth < 10 && node; depth += 1, node = node.parentElement) {
            const text = cleanText(node.innerText || node.textContent || '');
            if (!text.includes(expectedIdentity) || text.length > 1600) continue;
            const marker = `${node.tagName} ${node.getAttribute('role') || ''} ${node.className || ''}`;
            const hasRecordSignal = recordSignalPattern.test(text);
            const hasRecordStructure = structuralPattern.test(marker);
            if (!hasRecordSignal && !hasRecordStructure) continue;
            candidates.push({ node, text, depth, hasRecordSignal, hasRecordStructure });
          }
          candidates.sort((left, right) => Number(right.hasRecordSignal) - Number(left.hasRecordSignal)
            || Number(right.hasRecordStructure) - Number(left.hasRecordStructure)
            || left.text.length - right.text.length
            || left.depth - right.depth);
          const best = candidates[0];
          if (!best) return null;
          const directLink = best.node.closest('a[href]') || element.closest('a[href]');
          const descendantLink = best.node.querySelector('a[href]');
          const plausiblePostLinkPattern = /bilibili\.com\/video\/BV|douyin\.com\/(?:video|manage\/video)\/|channels\.weixin\.qq\.com\/platform\/post\/(?!list)|xiaohongshu\.com\/(?:explore|discovery\/item)\/|weibo\.com\/\d+\//i;
          const link = directLink || (descendantLink && plausiblePostLinkPattern.test(String(descendantLink.href || '')) ? descendantLink : null);
          const explicitKey = ['data-id', 'data-key', 'data-row-key', 'data-record-id'].map(name => best.node.getAttribute(name)).find(Boolean);
          const path = [];
          let pathNode = best.node;
          for (let depth = 0; depth < 8 && pathNode?.parentElement; depth += 1, pathNode = pathNode.parentElement) {
            path.push(Array.prototype.indexOf.call(pathNode.parentElement.children, pathNode));
          }
          return {
            text: best.text,
            href: link?.href || null,
            recordKey: explicitKey ? `id:${explicitKey}` : (path.length ? `path:${path.reverse().join('.')}` : null),
            hasRecordSignal: best.hasRecordSignal,
            hasRecordStructure: best.hasRecordStructure,
            exactIdentityLabel,
            identityLabelStartsRecord
          };
        }, identity.text).catch(() => null);
        if (!detail?.text?.includes(identity.text)) continue;
        const assessment = assessManagementPublishRecord({
          platformCode: options.platformCode,
          title,
          body: options.body,
          identityText: identity.text,
          identityKind: identity.kind,
          recordText: detail.text,
          href: detail.href,
          submittedAt: options.submittedAt,
          tabStatus: options.tabStatus,
          spec: options.spec || {},
          exactIdentityLabel: detail.exactIdentityLabel,
          identityLabelStartsRecord: detail.identityLabelStartsRecord
        });
        if (!assessment.matched) continue;
        const key = `${frameIndex}:${detail.recordKey || `fallback:${index}:${detail.text}\n${detail.href || ''}`}`;
        const record = { ...detail, ...assessment, frameIndex };
        const existing = records.get(key);
        if (!existing || Number(record.score || 0) > Number(existing.score || 0)) records.set(key, record);
      }
    }
  }
  const values = [...records.values()];
  if (values.length === 1) return values[0];
  const signaled = values.filter(record => record.hasRecordSignal);
  if (signaled.length === 1) return signaled[0];
  if (values.length > 1) {
    const ranked = [...values].sort((left, right) => Number(right.score || 0) - Number(left.score || 0));
    if (Number(ranked[0]?.score || 0) - Number(ranked[1]?.score || 0) >= 25) return ranked[0];
    return { ambiguous: true, candidateCount: values.length, signaledCandidateCount: signaled.length, candidates: ranked.slice(0, 10), text: '', href: null, reviewStatus: 'UNKNOWN', confidence: 'LOW', matchedBy: [] };
  }
  return null;
}

export async function firstUsable(locators, { visible = true, enabled = false } = {}) {
  for (const locator of locators) {
    const count = await locator.count().catch(() => 0);
    for (let index = 0; index < count; index += 1) {
      const item = locator.nth(index);
      if (visible && !await item.isVisible().catch(() => false)) continue;
      if (enabled && !await isControlEnabled(item)) continue;
      return item;
    }
  }
  return null;
}

function pageFrames(page) {
  return typeof page.frames === 'function' ? page.frames() : [page];
}

async function isControlEnabled(locator) {
  if (!await locator.isEnabled().catch(() => true)) return false;
  return locator.evaluate(element => {
    const target = element.closest('button,[role="button"],a') || element;
    const chain = [target, target.parentElement, target.parentElement?.parentElement].filter(Boolean);
    return !chain.some(item => item.disabled === true
      || item.getAttribute('aria-disabled') === 'true'
      || item.getAttribute('data-disabled') === 'true'
      || /(^|\s)(disabled|is-disabled|weui-desktop-btn_disabled)(\s|$)/i.test(String(item.className || ''))
      || getComputedStyle(item).pointerEvents === 'none');
  }).catch(() => false);
}

async function fillLocator(locator, value) {
  await locator.click().catch(() => {});
  const tagName = await locator.evaluate(element => element.tagName.toLowerCase()).catch(() => '');
  if (tagName === 'input' || tagName === 'textarea') await locator.fill(String(value));
  else {
    await locator.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A').catch(() => {});
    await locator.fill(String(value)).catch(async () => locator.type(String(value)));
  }
}

async function fillFirstWithWait(page, selectors = [], labels = [], value = '', timeoutMs = 180000) {
  if (!clean(value)) return false;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const frame of pageFrames(page)) {
      const locators = selectors.map(selector => frame.locator(selector));
      for (const label of labels) {
        locators.push(frame.getByPlaceholder(label, { exact: false }));
        locators.push(frame.getByLabel(label, { exact: false }));
      }
      const locator = await firstUsable(locators);
      if (!locator) continue;
      await fillLocator(locator, value);
      return true;
    }
    await page.waitForTimeout(1000);
  }
  return false;
}

async function findLabeledControl(page, labels = [], { enabled = true } = {}) {
  for (const frame of pageFrames(page)) {
    for (const label of labels) {
      const candidates = [
        frame.getByRole('button', { name: label, exact: true }),
        frame.getByRole('button', { name: label, exact: false }),
        frame.getByText(label, { exact: true })
      ];
      const locator = await firstUsable(candidates, { enabled });
      if (locator) return { locator, label };
    }
  }
  return null;
}

async function clickByLabels(page, labels = [], options = {}) {
  const found = await findLabeledControl(page, labels, options);
  if (!found) return false;
  await found.locator.click();
  return true;
}

async function findUniqueLabeledButton(page, labels = [], { enabled = true } = {}) {
  const matches = [];
  for (const frame of pageFrames(page)) {
    for (const label of labels) {
      const locator = frame.getByRole('button', { name: label, exact: true });
      const count = await locator.count().catch(() => 0);
      for (let index = 0; index < count; index += 1) {
        const candidate = locator.nth(index);
        if (!await candidate.isVisible().catch(() => false)) continue;
        if (enabled && !await candidate.isEnabled().catch(() => false)) continue;
        matches.push({ locator: candidate, label });
      }
    }
  }
  if (matches.length !== 1) return { status: matches.length ? 'AMBIGUOUS' : 'MISSING', count: matches.length, match: null };
  return { status: 'UNIQUE', count: 1, match: matches[0] };
}

async function dismissSafeInformationalOverlays(page) {
  const safeLabels = ['\u77e5\u9053\u4e86', '\u6211\u77e5\u9053\u4e86', '\u5173\u95ed'];
  for (let pass = 0; pass < 3; pass += 1) {
    const found = await findLabeledControl(page, safeLabels, { enabled: true });
    if (!found || !await found.locator.isVisible().catch(() => false)) return;
    await found.locator.click().catch(() => {});
    await page.waitForTimeout(350);
  }
}

function materialAccepts(accept, materialPath) {
  const sample = clean(accept).toLowerCase();
  if (!sample) return true;
  const extension = path.extname(materialPath).toLowerCase();
  const isVideo = ['.mp4', '.mov', '.mkv', '.avi', '.webm', '.flv', '.m4v', '.3gp', '.ts', '.mts', '.m2ts'].includes(extension);
  const isImage = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.heic', '.heif'].includes(extension);
  if (isVideo) return sample.includes('video') || sample.split(',').map(item => item.trim()).includes(extension);
  if (isImage) return sample.includes('image') || sample.split(',').map(item => item.trim()).includes(extension);
  return sample.split(',').map(item => item.trim()).includes(extension);
}

async function findFileInputs(page, selectors = [], materialPath = '', { allowGenericFileInputFallback = true } = {}) {
  const requestedSelectors = Array.isArray(selectors) ? selectors.filter(Boolean) : [];
  const uniqueSelectors = [...new Set(allowGenericFileInputFallback
    ? [...requestedSelectors, 'input[type="file"]']
    : requestedSelectors)];
  const candidates = [];
  const seen = new Set();
  for (const frame of pageFrames(page)) {
    for (let selectorIndex = 0; selectorIndex < uniqueSelectors.length; selectorIndex += 1) {
      const locator = frame.locator(uniqueSelectors[selectorIndex]);
      const count = await locator.count().catch(() => 0);
      for (let index = 0; index < count; index += 1) {
        const input = locator.nth(index);
        if (!await input.isEnabled().catch(() => false)) continue;
        const meta = await input.evaluate(element => {
          const ancestors = [];
          let current = element.parentElement;
          for (let depth = 0; current && depth < 4; depth += 1, current = current.parentElement) {
            ancestors.push(`${current.className || ''} ${current.innerText || ''}`);
          }
          return {
            accept: element.getAttribute('accept') || '',
            name: element.getAttribute('name') || '',
            parentClass: element.parentElement?.className || '',
            parentId: element.parentElement?.id || '',
            insidePrimaryWrapper: Boolean(element.closest('.bcc-upload-wrapper')),
            visible: Boolean(element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden' && getComputedStyle(element).display !== 'none'),
            context: ancestors.join(' ').replace(/\s+/g, ' ').slice(0, 1200)
          };
        }).catch(() => ({ accept: '', name: '', parentClass: '', parentId: '', insidePrimaryWrapper: false, visible: false, context: '' }));
        if (!materialAccepts(meta.accept, materialPath)) continue;
        const key = `${frame.url()}|${meta.accept}|${meta.context}|${index}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const uploadContext = /(?:upload|drag|drop|\u4e0a\u4f20|\u62d6\u62fd)/i.test(meta.context);
        const score = (uploadContext ? 100 : 0) + (meta.visible ? 10 : 0) + Math.max(0, 5 - selectorIndex);
        candidates.push({ input, score, selector: uniqueSelectors[selectorIndex], selectorIndex, index, meta });
      }
    }
  }
  candidates.sort((left, right) => right.score - left.score);
  return candidates;
}

async function firstVisibleSelector(page, selectors = []) {
  for (const frame of pageFrames(page)) {
    const locator = await firstUsable(selectors.map(selector => frame.locator(selector)));
    if (locator) return locator;
  }
  return null;
}

function materialNameMatched(text, materialPath = '') {
  const name = clean(path.basename(materialPath)).toLowerCase();
  if (!name) return false;
  const sample = clean(text).toLowerCase();
  if (sample.includes(name)) return true;
  const extension = path.extname(name);
  const stem = path.basename(name, extension);
  // Upload cards often ellipsize the middle of long names. Require both a useful
  // prefix and the extension so a generic word such as "video" cannot match.
  const prefix = stem.slice(0, Math.min(12, stem.length));
  return prefix.length >= 6 && sample.includes(prefix) && (!extension || sample.includes(extension));
}

async function pageUploadEvidence(page, spec, baselineText = '', materialPath = '') {
  const text = await allFrameText(page);
  const selector = await firstVisibleSelector(page, spec.uploadEvidenceSelectors || []);
  const textMatched = Boolean(spec.uploadEvidenceTextPattern && toRegex(spec.uploadEvidenceTextPattern, null)?.test(text));
  const fileNameMatched = materialNameMatched(text, materialPath);
  const initialPattern = spec.uploadInitialTextPattern ? toRegex(spec.uploadInitialTextPattern, null) : null;
  const initialVisible = Boolean(initialPattern && initialPattern.test(text));
  const initialGone = Boolean(initialPattern && initialPattern.test(baselineText) && !initialVisible);
  return { confirmed: Boolean(selector || textMatched || fileNameMatched || initialGone), selectorMatched: Boolean(selector), textMatched, fileNameMatched, initialGone, initialVisible, text: text.slice(0, 4000) };
}

async function waitForUploadEvidence(page, spec, baselineText, materialPath, timeoutMs = 15000) {
  if (!spec.requireUploadEvidence) return { confirmed: true, method: 'file-input-accepted' };
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await pageUploadEvidence(page, spec, baselineText, materialPath);
    if (last.confirmed) return last;
    await page.waitForTimeout(500);
  }
  return last || { confirmed: false };
}

export function materialAttachOutcome({ commandAccepted = false, selectionCount = 0, evidenceConfirmed = false } = {}) {
  if (!commandAccepted) return 'TRY_NEXT';
  if (selectionCount > 0 || evidenceConfirmed) return 'ATTACHED';
  // Once the browser has accepted setFiles/setInputFiles we must never try a
  // second input: modern upload widgets commonly consume and clear the input.
  return 'STOP_UNCONFIRMED';
}

async function fileSelectionState(input) {
  return input.evaluate(element => ({
    count: element.files?.length || 0,
    names: Array.from(element.files || []).map(file => file.name),
    value: element.value || ''
  })).catch(() => ({ count: 0, names: [], value: '' }));
}

const LARGE_REMOTE_FILE_TRANSFER_RE = /Cannot transfer files larger than\s*50\s*Mb\s*to a browser not co-located with the server/i;

export function isLargeRemoteFileTransferError(error) {
  return LARGE_REMOTE_FILE_TRANSFER_RE.test(clean(error?.message || error));
}

function cdpNodeHasAttribute(node, attributeName, expectedValue) {
  const attributes = Array.isArray(node?.attributes) ? node.attributes : [];
  for (let index = 0; index < attributes.length; index += 2) {
    if (attributes[index] === attributeName && attributes[index + 1] === expectedValue) return true;
  }
  return false;
}

async function findCdpNodeByUploadToken(session, attributeName, token) {
  let flattenedError = null;
  try {
    const flattened = await session.send('DOM.getFlattenedDocument', { depth: -1, pierce: true });
    const node = (flattened?.nodes || []).find(item => cdpNodeHasAttribute(item, attributeName, token));
    if (node) return node.backendNodeId ? { backendNodeId: node.backendNodeId } : { nodeId: node.nodeId };
  } catch (error) {
    flattenedError = error;
  }

  let searchId = null;
  try {
    const search = await session.send('DOM.performSearch', {
      query: `[${attributeName}=\"${token}\"]`,
      includeUserAgentShadowDOM: true
    });
    searchId = search?.searchId || null;
    if (searchId && Number(search?.resultCount) > 0) {
      const results = await session.send('DOM.getSearchResults', {
        searchId,
        fromIndex: 0,
        toIndex: Math.min(10, Number(search.resultCount))
      });
      const nodeId = (results?.nodeIds || []).find(Boolean);
      if (nodeId) return { nodeId };
    }
  } catch (searchError) {
    if (flattenedError) searchError.cause = flattenedError;
    throw searchError;
  } finally {
    if (searchId) await session.send('DOM.discardSearchResults', { searchId }).catch(() => {});
  }

  if (flattenedError) throw flattenedError;
  return null;
}

export async function setFileInputFilesViaLocalCdp(page, input, materialPath) {
  const absoluteMaterialPath = path.resolve(materialPath);
  const attributeName = 'data-codex-upload-token';
  const token = crypto.randomUUID();
  let session = null;
  let tokenApplied = false;
  try {
    await input.evaluate((element, marker) => {
      // Do not use instanceof HTMLInputElement here. For an input inside an iframe,
      // the element belongs to that frame's realm while Playwright may evaluate the
      // helper with another realm's constructor, making instanceof incorrectly false.
      const tagName = String(element?.tagName || '').toLowerCase();
      const inputType = String(element?.getAttribute?.('type') || element?.type || '').toLowerCase();
      if (tagName !== 'input' || inputType !== 'file') throw new Error('Target element is not a file input');
      element.setAttribute(marker.attributeName, marker.token);
    }, { attributeName, token });
    tokenApplied = true;

    const context = page.context();
    if (!context?.newCDPSession) throw new Error('当前浏览器上下文不支持本机 CDP 文件注入');
    session = await context.newCDPSession(page);
    await session.send('DOM.enable');
    const targetNode = await findCdpNodeByUploadToken(session, attributeName, token);
    if (!targetNode) throw new Error('CDP 未找到已定位的文件上传控件');
    await session.send('DOM.setFileInputFiles', {
      ...targetNode,
      files: [absoluteMaterialPath]
    });
    return { method: 'cdp-local-file-path', largeFileFallback: true, absoluteMaterialPath };
  } finally {
    if (tokenApplied) {
      await input.evaluate((element, marker) => {
        if (element.getAttribute(marker.attributeName) === marker.token) element.removeAttribute(marker.attributeName);
      }, { attributeName, token }).catch(() => {});
    }
    if (session) await session.detach().catch(() => {});
  }
}

function materialInjectionError(sourceLabel, error, fallbackError = null) {
  const primary = clean(error?.message || error) || '未知错误';
  const fallback = fallbackError ? `；本机 CDP 回退也失败：${clean(fallbackError?.message || fallbackError) || '未知错误'}` : '';
  const wrapped = new Error(`已找到${sourceLabel}，但素材文件注入失败：${primary}${fallback}`);
  wrapped.code = 'MATERIAL_FILE_INJECTION_FAILED';
  wrapped.cause = fallbackError || error;
  wrapped.originalError = primary;
  wrapped.largeFileFallbackAttempted = Boolean(fallbackError) || isLargeRemoteFileTransferError(error);
  return wrapped;
}

function materialInjectionTimeoutError(sourceLabel, stage, timeoutMs) {
  const wrapped = new Error(`已找到${sourceLabel}，但${stage}超过 ${timeoutMs}ms 仍未完成，已中止本次上传以避免任务永久卡住`);
  wrapped.code = 'MATERIAL_FILE_INJECTION_TIMEOUT';
  wrapped.stage = stage;
  wrapped.timeoutMs = timeoutMs;
  return wrapped;
}

async function withMaterialInjectionTimeout(operation, timeoutMs, sourceLabel, stage) {
  const effectiveTimeoutMs = Math.max(1, Math.floor(Number(timeoutMs) || 1));
  let timer = null;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(materialInjectionTimeoutError(sourceLabel, stage, effectiveTimeoutMs)), effectiveTimeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function uploadStage(spec, stage, details = {}) {
  const platform = clean(spec?.name || spec?.platformCode || 'platform');
  const suffix = Object.keys(details).length ? ` ${JSON.stringify(details)}` : '';
  console.log(`[RPA:${platform}] upload:${stage}${suffix}`);
}

async function injectMaterialFile(page, targetOrProvider, materialPath, standardSetFiles, standardMethod, sourceLabel, timeoutMs) {
  try {
    await withMaterialInjectionTimeout(
      () => standardSetFiles(materialPath, timeoutMs),
      timeoutMs,
      sourceLabel,
      `${standardMethod} 文件挂载`
    );
    const input = typeof targetOrProvider === 'function' ? null : targetOrProvider;
    return { method: standardMethod, largeFileFallback: false, input };
  } catch (error) {
    if (error?.code === 'MATERIAL_FILE_INJECTION_TIMEOUT') throw error;
    if (!isLargeRemoteFileTransferError(error)) throw materialInjectionError(sourceLabel, error);
    try {
      const target = typeof targetOrProvider === 'function'
        ? await withMaterialInjectionTimeout(targetOrProvider, timeoutMs, sourceLabel, '取得文件输入框')
        : targetOrProvider;
      if (!target) throw new Error('未能取得文件选择器对应的 input 元素');
      const fallback = await withMaterialInjectionTimeout(
        () => setFileInputFilesViaLocalCdp(page, target, materialPath),
        timeoutMs,
        sourceLabel,
        '本机 CDP 文件挂载'
      );
      return { ...fallback, input: target, originalMethod: standardMethod };
    } catch (fallbackError) {
      if (fallbackError?.code === 'MATERIAL_FILE_INJECTION_TIMEOUT') throw fallbackError;
      throw materialInjectionError(sourceLabel, error, fallbackError);
    }
  }
}

export async function uploadFile(page, materialPath, spec = {}, timeoutMs = 180000) {
  const deadline = Date.now() + timeoutMs;
  const configuredInjectionTimeoutMs = Math.max(10, Number(spec.materialFileInjectionTimeoutMs || 45000));
  const nextInjectionTimeoutMs = () => Math.max(1, Math.min(configuredInjectionTimeoutMs, deadline - Date.now()));
  let lastEntryClickAt = 0;
  let chooserAttempted = false;
  let attachStarted = false;
  let attachAttempts = 0;
  while (Date.now() < deadline) {
    await dismissSafeInformationalOverlays(page);

    // If the page already displays this material or a real upload/processing
    // signal, continue the existing upload instead of navigating or selecting it again.
    const existingEvidence = await pageUploadEvidence(page, spec, '', materialPath);
    if (existingEvidence.confirmed) return { attached: true, attachAttempts, resumedExisting: true, method: 'existing-page-evidence', evidence: { selectorMatched: existingEvidence.selectorMatched, textMatched: existingEvidence.textMatched, fileNameMatched: existingEvidence.fileNameMatched } };

    if (!attachStarted && !chooserAttempted && (spec.fileChooserLabels?.length || spec.fileChooserSelectors?.length)) {
      chooserAttempted = true;
      const baselineText = await allFrameText(page);
      const selectorTrigger = await firstVisibleSelector(page, spec.fileChooserSelectors || []);
      const labeledTrigger = selectorTrigger ? null : await findLabeledControl(page, spec.fileChooserLabels || [], { enabled: true });
      const trigger = selectorTrigger || labeledTrigger?.locator;
      if (trigger) {
        const chooserPromise = page.waitForEvent('filechooser', { timeout: 6000 }).catch(() => null);
        await trigger.click().catch(() => {});
        const chooser = await chooserPromise;
        if (chooser) {
          const injectionTimeoutMs = nextInjectionTimeoutMs();
          uploadStage(spec, 'filechooser-injection-start', { timeoutMs: injectionTimeoutMs, material: path.basename(materialPath) });
          const injection = await injectMaterialFile(
            page,
            () => chooser.element(),
            materialPath,
            (value, operationTimeoutMs) => chooser.setFiles(value, { timeout: operationTimeoutMs }),
            'filechooser',
            '文件选择器',
            injectionTimeoutMs
          );
          uploadStage(spec, 'filechooser-injection-complete', { method: injection.method });
          const commandAccepted = true;
          attachStarted = true;
          attachAttempts += 1;
          const immediateSelection = injection.input ? await fileSelectionState(injection.input) : { count: 0, names: [], value: '' };
          const evidence = await waitForUploadEvidence(page, spec, baselineText, materialPath, 30000);
          const finalSelection = immediateSelection.count > 0 || !injection.input ? immediateSelection : await fileSelectionState(injection.input);
          const outcome = materialAttachOutcome({ commandAccepted, selectionCount: finalSelection.count, evidenceConfirmed: evidence.confirmed });
          if (outcome === 'ATTACHED') return {
            attached: true,
            attachAttempts,
            resumedExisting: false,
            method: injection.method,
            originalMethod: injection.originalMethod,
            largeFileFallback: injection.largeFileFallback,
            fileSelectionCount: finalSelection.count,
            evidence: { selectorMatched: evidence.selectorMatched, textMatched: evidence.textMatched, fileNameMatched: evidence.fileNameMatched, initialGone: evidence.initialGone }
          };
          throw new Error('\u7d20\u6750\u9009\u62e9\u5df2\u63d0\u4ea4\uff0c\u4f46\u5e73\u53f0\u672a\u7ed9\u51fa\u53ef\u9760\u6302\u8f7d\u8bc1\u636e\uff1b\u4e3a\u9632\u6b62\u91cd\u590d\u4e0a\u4f20\uff0c\u5df2\u505c\u6b62\u518d\u6b21\u9009\u62e9\u6587\u4ef6');
        }
      }
    }

    if (!attachStarted) {
      const candidates = await findFileInputs(page, spec.fileSelectors || [], materialPath, {
        allowGenericFileInputFallback: spec.allowGenericFileInputFallback !== false
      });
      if (candidates.length) uploadStage(spec, 'file-input-found', { count: candidates.length, material: path.basename(materialPath) });
      for (const candidate of candidates) {
        const baselineText = await allFrameText(page);
        const injectionTimeoutMs = nextInjectionTimeoutMs();
        uploadStage(spec, 'file-input-injection-start', {
          timeoutMs: injectionTimeoutMs,
          selector: candidate.selector,
          inputIndex: candidate.index,
          insidePrimaryWrapper: candidate.meta?.insidePrimaryWrapper === true
        });
        const injection = await injectMaterialFile(
          page,
          candidate.input,
          materialPath,
          (value, operationTimeoutMs) => candidate.input.setInputFiles(value, { timeout: operationTimeoutMs }),
          'file-input',
          '素材上传控件',
          injectionTimeoutMs
        );
        uploadStage(spec, 'file-input-injection-complete', { method: injection.method });
        const commandAccepted = true;
        attachStarted = true;
        attachAttempts += 1;

        // Read immediately because Douyin consumes and clears input.files very quickly.
        const immediateSelection = await fileSelectionState(candidate.input);
        const evidenceTimeoutMs = Math.max(1, Math.min(Number(spec.uploadEvidenceTimeoutMs || 30000), deadline - Date.now()));
        let evidence = await waitForUploadEvidence(page, spec, baselineText, materialPath, evidenceTimeoutMs);
        let finalSelection = immediateSelection.count > 0 ? immediateSelection : await fileSelectionState(candidate.input);
        let finalInjection = injection;

        // Bilibili occasionally accepts input.files without dispatching the upload widget's
        // change pipeline. A second selection is safe only when the page still shows the
        // exact initial upload area and there is no filename/progress/editor evidence.
        if (!evidence.confirmed && evidence.initialVisible && spec.retryInitialFileInputOnce === true) {
          uploadStage(spec, 'initial-page-unchanged-retry-start', { material: path.basename(materialPath), attachAttempts });
          const clearTimeoutMs = nextInjectionTimeoutMs();
          await withMaterialInjectionTimeout(
            () => candidate.input.setInputFiles([], { timeout: clearTimeoutMs }),
            clearTimeoutMs,
            '素材上传控件',
            '重试前清空文件输入框'
          );
          const retryTimeoutMs = nextInjectionTimeoutMs();
          finalInjection = await injectMaterialFile(
            page,
            candidate.input,
            materialPath,
            (value, operationTimeoutMs) => candidate.input.setInputFiles(value, { timeout: operationTimeoutMs }),
            'file-input-retry',
            '素材上传控件',
            retryTimeoutMs
          );
          attachAttempts += 1;
          uploadStage(spec, 'initial-page-unchanged-retry-complete', { method: finalInjection.method, attachAttempts });
          const retryImmediateSelection = await fileSelectionState(candidate.input);
          const retryEvidenceTimeoutMs = Math.max(1, Math.min(Number(spec.uploadEvidenceTimeoutMs || 30000), deadline - Date.now()));
          evidence = await waitForUploadEvidence(page, spec, baselineText, materialPath, retryEvidenceTimeoutMs);
          finalSelection = retryImmediateSelection.count > 0 ? retryImmediateSelection : await fileSelectionState(candidate.input);
          if (!evidence.confirmed && evidence.initialVisible) {
            const error = new Error('素材文件已重新选择一次，但B站仍停留在初始上传区域，确认本次上传没有启动；可安全重新发送');
            error.code = 'MATERIAL_UPLOAD_NOT_STARTED';
            error.uploadDefinitelyNotStarted = true;
            error.attachAttempts = attachAttempts;
            error.materialAttachment = {
              attached: false,
              selectionAttempted: true,
              attachAttempts,
              method: finalInjection.method,
              fileSelectionCount: finalSelection.count,
              evidence: { selectorMatched: evidence.selectorMatched, textMatched: evidence.textMatched, fileNameMatched: evidence.fileNameMatched, initialGone: evidence.initialGone, initialVisible: evidence.initialVisible }
            };
            throw error;
          }
        }

        const outcome = materialAttachOutcome({
          commandAccepted,
          selectionCount: finalSelection.count,
          evidenceConfirmed: evidence.confirmed
        });
        const inputDiagnostics = {
          selector: candidate.selector,
          selectorIndex: candidate.selectorIndex,
          inputIndex: candidate.index,
          accept: candidate.meta?.accept || '',
          name: candidate.meta?.name || '',
          parentClass: candidate.meta?.parentClass || '',
          parentId: candidate.meta?.parentId || '',
          insidePrimaryWrapper: candidate.meta?.insidePrimaryWrapper === true
        };
        if (outcome === 'ATTACHED') return { attached: true, attachAttempts, resumedExisting: false, method: finalInjection.method, originalMethod: finalInjection.originalMethod, largeFileFallback: finalInjection.largeFileFallback, fileSelectionCount: finalSelection.count, inputDiagnostics, evidence: { selectorMatched: evidence.selectorMatched, textMatched: evidence.textMatched, fileNameMatched: evidence.fileNameMatched, initialGone: evidence.initialGone, initialVisible: evidence.initialVisible } };
        throw new Error('素材选择指令已执行，但文件输入框已被页面消费且未检测到可靠上传证据；为防止重复上传，已停止自动重试');
      }
    }

    // This entry may navigate away from an in-progress editor. It is allowed only
    // before any chooser/input has accepted the current material.
    if (!attachStarted && spec.publishEntryLabels?.length && Date.now() - lastEntryClickAt >= 3000) {
      if (await clickByLabels(page, spec.publishEntryLabels, { enabled: true }).catch(() => false)) {
        lastEntryClickAt = Date.now();
        await page.waitForTimeout(900);
        continue;
      }
    }

    const text = await pageEvidenceText(page);
    if (PAGE_ERROR_RE.test(text)) throw new Error('\u5e73\u53f0\u53d1\u5e03\u9875\u9762\u52a0\u8f7d\u5931\u8d25\uff0c\u5df2\u505c\u6b62\u53d1\u5e03');
    if (VERIFY_RE.test(text)) throw new Error('\u5e73\u53f0\u8981\u6c42\u4eba\u5de5\u5b89\u5168\u9a8c\u8bc1\uff0c\u5df2\u505c\u6b62\u53d1\u5e03');
    await page.waitForTimeout(1000);
  }
  return false;
}

async function allFrameText(page) {
  const texts = [];
  for (const frame of pageFrames(page)) {
    texts.push(...await locatorInnerTexts(frame.locator('body'), 3000));
  }
  return clean(texts.filter(Boolean).join(' '));
}

function defaultSpecs() {
  return {
    douyin: {
      name: '抖音',
      hostHints: ['creator.douyin.com', 'douyin.com'],
      publishUrl: 'https://creator.douyin.com/creator-micro/content/upload',
      checkUrl: 'https://creator.douyin.com/creator-micro/content/manage',
      authenticatedUrlPattern: /creator\.douyin\.com\/creator-micro\//i,
      authenticatedTextPattern: /\u5185\u5bb9\u7ba1\u7406|\u4f5c\u54c1\u7ba1\u7406|\u6570\u636e\u4e2d\u5fc3|\u4e92\u52a8\u7ba1\u7406|\u521b\u4f5c\u670d\u52a1/i,
      authenticatedSelectors: ['input[type="file"]', '[class*="user-avatar"]', '[class*="creator-nav"]'],
      loggedOutSelectors: ['input[placeholder*="\u624b\u673a\u53f7"]', 'input[placeholder*="\u9a8c\u8bc1\u7801"]'],
      manageUrl: 'https://creator.douyin.com/creator-micro/content/manage',
      commentUrl: 'https://creator.douyin.com/creator-micro/data/following/comment',
      messageUrl: 'https://www.douyin.com/user/self',
      commentPageUrlPattern: /creator\.douyin\.com\/creator-micro\/data\/following\/comment(?:[/?#]|$)/i,
      commentPageTextPattern: /\u8bc4\u8bba\u7ba1\u7406(?=[\s\S]{0,3000}(?:\u9009\u62e9\u4f5c\u54c1|\u8bf7\u9009\u62e9\u6392\u5e8f\u65b9\u5f0f|\u6682\u65e0\u8bc4\u8bba|\u6709\u7231\u8bc4\u8bba\uff0c\u8bf4\u70b9\u513f\u597d\u542c\u7684))/i,
      privateMessageEntrySelectors: ['[data-e2e="im-entry"]'],
      privateMessagePageUrlPattern: /www\.douyin\.com\/user\/self(?:[/?#]|$)/i,
      privateMessagePageTextPattern: /\u4e0b\u8f7d\u5ba2\u6237\u7aef\uff0c\u5b9e\u65f6\u63a5\u6536\u597d\u53cb\u6d88\u606f(?=[\s\S]{0,6000}(?:\u964c\u751f\u4eba\u6d88\u606f|\u6536\u8d77\u4f1a\u8bdd|\u5bf9\u65b9\u56de\u590d\u6216\u5173\u6ce8\u4f60\u4e4b\u524d))/i,
      privateMessagePanelSelectors: ['[data-e2e="conversation-item"]', '[class*="conversationStrangerBoxwrapper"]'],
      privateUnreadSelectors: ['[class*="ConversationItemUnReadCount"]'],
      privateRequireUnreadForReply: true,
      privateStrangerBoxSelectors: ['[class*="conversationStrangerBoxwrapper"]'],
      privateStrangerListTitleSelectors: ['.conversationStrangerConversationListtitle'],
      privateStrangerListSelectors: ['.conversationStrangerConversationListlistWrapper'],
      privateConversationNameSelectors: ['.conversationConversationItemtitle'],
      privateConversationContentSelectors: ['pre.ConversationItemHinttextBox'],
      privateConversationTimeSelectors: ['[class*="ConversationItemTagNextToTitletimeStr"]'],
      privateMessageEditorSelectors: ['[class*="messageEditorinputArea"][contenteditable="true"]', '[data-placeholder="\u53d1\u9001\u6d88\u606f"]', 'textarea[placeholder*="\u53d1\u9001\u6d88\u606f"]', 'textarea[placeholder*="\u6d88\u606f"]'],
      privateConversationHeaderSelectors: ['.RightPanelHeadertitle', '.StackLayoutStackChatHeadertitle', '[class*="StackLayoutStackChatHeadertitle"]'],
      privateChatMessageTextSelectors: ['.TextMessageTextpureText'],
      privateMessageSendSelectors: ['.e2e-send-msg-btn'],
      commentRowSelector: '[class*="cmt-li-"]',
      commentNameSelector: 'h4[class*="cmt-name-"]',
      commentTimeSelector: 'p[class*="cmt-time-"]',
      commentTextSelector: 'pre[class*="cmt-text-"]',
      commentEditorRootSelector: '[class*="cmt-editor-"]',
      loginUrlPattern: /\/login|passport\.douyin\.com/i,
      loginTextPattern: /创作者登录|机构登录|扫码登录|验证码登录/i,
      fileSelectors: ['input[type="file"][accept*="video"]', 'input[type="file"][accept*="image"]'],
      requireUploadEvidence: true,
      uploadInitialTextPattern: /\u70b9\u51fb\u4e0a\u4f20|\u9009\u62e9\u89c6\u9891|\u4e0a\u4f20\u89c6\u9891|\u62d6\u62fd\u89c6\u9891/i,
      uploadEvidenceTextPattern: /\u53d6\u6d88\u4e0a\u4f20|\u5f53\u524d\u901f\u5ea6|\u5269\u4f59\u65f6\u95f4|\u4e0a\u4f20\u4e2d|\u5df2\u4e0a\u4f20[\uff1a:]|\u89c6\u9891\u5904\u7406\u4e2d|\u8f6c\u7801\u4e2d|\u5c01\u9762\u751f\u6210\u4e2d|\u667a\u80fd\u63a8\u8350\u5c01\u9762\u751f\u6210\u4e2d|\u91cd\u65b0\u4e0a\u4f20|\u9009\u62e9\u5c01\u9762|\u4f5c\u54c1\u63cf\u8ff0|\b\d{1,3}%/i,
      uploadEvidenceSelectors: ['[class*="upload"][class*="progress"]', '[class*="video"][class*="preview"]', '[class*="cover"][class*="recommend"]'],
      publishEntryLabels: ['高清发布', '发布视频', '上传视频', '发布作品'],
      titleSelectors: ['input[placeholder*="标题"]', 'textarea[placeholder*="标题"]'],
      titleLabels: ['作品标题', '标题'],
      captionSelectors: ['textarea[placeholder*="简介"]', 'textarea[placeholder*="描述"]', '[contenteditable="true"]'],
      captionLabels: ['作品简介', '作品描述', '描述'],
      publishLabels: ['发布', '确认发布'],
      successPattern: /\u53d1\u5e03\u6210\u529f|\u4f5c\u54c1\u5df2\u53d1\u5e03/i,
      successTextScope: 'signals',
      publishSuccessUrlPattern: /\/creator-micro\/content\/manage(?:[/?#]|$)/i,
      verifyTabs: [
        { label: '\u5df2\u53d1\u5e03', reviewStatus: 'PUBLISHED' },
        { label: '\u5ba1\u6838\u4e2d', reviewStatus: 'REVIEWING' },
        { label: '\u672a\u901a\u8fc7', reviewStatus: 'REJECTED' }
      ],
      messageCardSelectors: ['[class*="cmt-li-"]', '[data-e2e*="comment-item"]', '.comment-item', '[class*="commentItem"]'],
      commentReadySelectors: ['[class*="cmt-li-"]'],
      commentEmptyTextPattern: /\u6682\u65e0\u8bc4\u8bba|\u6709\u7231\u8bc4\u8bba\uff0c\u8bf4\u70b9\u513f\u597d\u542c\u7684|\u8fd1\s*\d+\s*\u5929/i,
      messageCardSelectorsByType: {
        COMMENT: ['[class*="cmt-li-"]', '[data-e2e*="comment-item"]', '.comment-item', '[class*="commentItem"]'],
        PRIVATE_MESSAGE: ['[data-e2e="conversation-item"]']
      }
    },
    wechat_channels: {
      name: '视频号',
      hostHints: ['channels.weixin.qq.com'],
      publishUrl: 'https://channels.weixin.qq.com/platform/post/create',
      checkUrl: 'https://channels.weixin.qq.com/platform/post/list',
      authenticatedUrlPattern: /channels\.weixin\.qq\.com\/platform\//i,
      authenticatedTextPattern: /\u5185\u5bb9\u7ba1\u7406|\u52a8\u6001\u7ba1\u7406|\u4e92\u52a8\u7ba1\u7406|\u6570\u636e\u4e2d\u5fc3|\u53d1\u8868\u52a8\u6001|\u76f4\u64ad\u7ba1\u7406/i,
      authenticatedSelectors: ['input[type="file"]', 'input[placeholder*="\u641c\u7d22\u89c6\u9891"]', '[class*="finder-avatar"]', '[class*="account-avatar"]'],
      loggedOutSelectors: ['[class*="login_qrcode"]', '[class*="qrcode"]'],
      manageUrl: 'https://channels.weixin.qq.com/platform/post/list',
      commentUrl: 'https://channels.weixin.qq.com/platform/interaction/comment',
      messageUrl: 'https://channels.weixin.qq.com/platform/private_msg',
      commentPageUrlPattern: /channels\.weixin\.qq\.com\/platform\/interaction\/comment(?:[/?#]|$)/i,
      commentPageTextPattern: /\u8bc4\u8bba\u7ba1\u7406(?=[\s\S]{0,6000}(?:\u5168\u90e8\u89c6\u9891|\u5171\s*\d+\s*\u4e2a|\u89c6\u9891\u53f7\s*[\u00b7\u30fb]?\s*\u52a9\u624b|\u8bc4\u8bba\u6743\u9650|\u5199\u8bc4\u8bba|\u6682\u65e0\u8bc4\u8bba|\u4f60\u8fd8\u6ca1\u6709\u53d1\u8868\u8fc7\u89c6\u9891))/i,
      commentReadySelectors: ['.comment-item'],
      commentEmptyTextPattern: /\u6682\u65e0\u8bc4\u8bba|\u4f60\u8fd8\u6ca1\u6709\u53d1\u8868\u8fc7\u89c6\u9891|\u6682\u65e0\u5185\u5bb9/i,
      commentOverviewSelector: '.main-body-wrap.comment-view.interaction-wrap',
      commentVideoTotalSelector: '.feeds .feeds-nums',
      commentVideoFilterSelector: '.feeds .controls .weui-desktop-form__dropdown__value',
      commentVideoRowSelector: '.feeds-container .comment-feed-wrap',
      commentVideoCountSelector: '.feed-comment-total',
      commentVideoTimeSelector: '.feed-time',
      commentVideoTitleSelector: '.feed-title',
      privateMessagePageUrlPattern: /channels\.weixin\.qq\.com\/platform\/private_msg(?:[/?#]|$)/i,
      privateMessagePageTextPattern: /\u79c1\u4fe1\u7ba1\u7406(?=[\s\S]{0,6000}(?:\u5168\u90e8\u79c1\u4fe1|\u672a\u8bfb\u79c1\u4fe1|\u6682\u65e0\u79c1\u4fe1|\u6253\u62db\u547c\u6d88\u606f|\u89c6\u9891\u53f7\u52a9\u624b))/i,
      privateMessagePanelSelectors: ['.private-msg-wrapper', '.private-msg-list', '.session-dialog'],
      privateMessageTotalSelectors: ['.private-msg-wrapper .msg-nums', '.controls .msg-nums', '.msg-nums'],
      privateConversationRowSelectors: ['.private-msg-list .session-wrap', '.session-container .session-wrap'],
      privateEmptySelectors: ['.private-msg-wrapper .empty-text'],
      privateSyncTextPattern: /\u6d88\u606f\u540c\u6b65\u4e2d/i,
      privateEmptyTextPattern: /\u6682\u65e0\u79c1\u4fe1|\u6682\u65e0\u6253\u62db\u547c\u6d88\u606f|\u6682\u65e0\u6d88\u606f|\u8fd8\u6ca1\u6709\u79c1\u4fe1|\u6ca1\u6709\u79c1\u4fe1/i,
      privateUnreadSelectors: ['.dot'],
      privateConversationNameSelectors: ['.feed-title .name'],
      privateConversationContentSelectors: ['.feed-info'],
      privateConversationTimeSelectors: ['.feed-title .date'],
      privateConversationHeaderSelectors: ['.session-dialog .header .left'],
      privateMessageEditorSelectors: ['.session-dialog textarea.edit_area'],
      // The wrapper spans the footer; its center is blank. Only the nested
      // button owns the send event and exposes the actual disabled state.
      privateMessageSendSelectors: ['.default.btn button', '.btn button'],
      privateEditorScopeSelector: '.footer',
      privateChatMessageTextSelectors: ['.session-dialog .message-plain'],
      privateOutgoingMessageContainerSelector: '.content-right',
      privateOutgoingMessageBubbleSelectors: ['.session-dialog .content-right'],
      privateReplyEvidenceTimeoutMs: 20000,
      privateRequireUnreadForReply: true,
      privatePhoneCheckTextPattern: /\u4f60\u9700\u8981\u7ed1\u5b9a\u624b\u673a\u53f7[\s\S]{0,120}\u624d\u53ef\u4ee5\u5728\u89c6\u9891\u53f7\u53d1\u8868\u8bc4\u8bba|\u53d1\u9001\u672a\u6210\u529f/i,
      strictCommentIdentity: true,
      strictScopedReply: true,
      commentRowSelector: '.comment-item',
      commentNameSelector: '.comment-user-name',
      commentTextSelector: '.comment-content',
      commentTimeSelector: '.comment-time',
      commentReplyTriggerSelectors: [':scope > .comment-item-main .comment-actions .weui-icon-outlined-comment'],
      commentEditorRootSelector: '.comment-reply-list .comment-create-wrap',
      commentEditorSelectors: ['textarea.create-input'],
      commentSendSelectors: ['.create-ft .primary'],
      loginUrlPattern: /\/login\.html|\/login(?:[/?#]|$)/i,
      loginTextPattern: /登录视频号助手|扫码登录|请使用微信扫描二维码/i,
      fileSelectors: ['input[type="file"][accept*="video"]', 'input[type="file"][accept*="image"]'],
      requireUploadEvidence: true,
      uploadInitialTextPattern: /上传时长8小时内，大小不超过20GB/i,
      uploadEvidenceTextPattern: /取消上传|正在处理文件|文件处理中|封面预览|删除/i,
      uploadEvidenceSelectors: ['.upload-progress', 'video#previewVideo', 'video#fullScreenVideo', '.post-media-preview-wrap video'],
      titleSelectors: ['input[placeholder="填写短标题有机会获得更多流量"]', 'input[placeholder*="短标题"]'],
      titleLabels: ['短标题', '视频标题', '标题'],
      titleMaxLength: 16,
      titleUnsupportedPattern: /[^\p{L}\p{N}\s《》〈〉“”‘’"'：:+＋?？%％℃，,]/gu,
      captionSelectors: ['.input-editor[contenteditable]', '[data-placeholder="添加描述"][contenteditable]', '[contenteditable]'],
      captionLabels: ['视频描述', '添加描述', '描述', '正文'],
      publishLabels: ['发表'],
      publishConfirmLabels: ['确认发表'],
      strictPublishButton: true,
      publishPageSettleMs: 8000,
      publishConfirmationSettleMs: 800,
      verifyReadyTimeoutMs: 15000,
      verifyRecordTimeoutMs: 15000,
      managementIdentitySources: ['TITLE', 'BODY'],
      managementBodyIdentityMinLength: 8,
      draftRequiresPublishEnabled: true,
      successPattern: /发表成功|发布成功|已发表/i,
      successTextScope: 'signals',
      publishedRecordPattern: /\u5df2\u53d1\u5e03|\u53d1\u5e03\u65f6\u95f4|\u64ad\u653e\u91cf|\u70b9\u8d5e|\u8bc4\u8bba|\u5206\u4eab|\d{4}\u5e74\d{1,2}\u6708\d{1,2}\u65e5\s+\d{1,2}:\d{2}/i,
      publishSuccessUrlPattern: /\/platform\/post\/list(?:[/?#]|$)/i,
      publishBlockedTextPattern: /绑定手机号|安全验证|扫码验证|人脸验证|验证码|环境异常|操作频繁/i,
      verifyTabs: [
        { label: '已发表', reviewStatus: 'PUBLISHED' },
        { label: '审核中', reviewStatus: 'REVIEWING' },
        { label: '未通过', reviewStatus: 'REJECTED' }
      ],
      messageCardSelectorsByType: { COMMENT: ['.comment-item'], PRIVATE_MESSAGE: ['.private-msg-list .session-wrap'] }
    },
    bilibili: {
      name: 'B站',
      hostHints: ['member.bilibili.com', 'message.bilibili.com'],
      publishUrl: 'https://member.bilibili.com/platform/upload/video/frame',
      checkUrl: 'https://member.bilibili.com/platform/upload-manager/article',
      authenticatedUrlPattern: /member\.bilibili\.com\/platform\//i,
      authenticatedTextPattern: /\u521b\u4f5c\u4e2d\u5fc3|\u7a3f\u4ef6\u7ba1\u7406|\u6570\u636e\u4e2d\u5fc3|\u6536\u76ca\u7ba1\u7406|\u6295\u7a3f\u7ba1\u7406|\u5185\u5bb9\u7ba1\u7406/i,
      authenticatedSelectors: ['input[type="file"]', '.nav-upload-btn', '[class*="user-avatar"]'],
      loggedOutSelectors: ['input[placeholder*="\u624b\u673a\u53f7"]', '.login-scan-box'],
      manageUrl: 'https://member.bilibili.com/platform/upload-manager/article',
      commentUrl: 'https://message.bilibili.com/#/reply',
      messageUrl: 'https://message.bilibili.com/#/whisper',
      loginUrlPattern: /passport\.bilibili\.com|\/login(?:[/?#]|$)/i,
      loginTextPattern: /登录|扫码登录|短信登录|密码登录|请先登录/i,
      fileSelectors: ['input[type="file"][accept*="video"]', 'input[type="file"]'],
      fileChooserLabels: ['\u4e0a\u4f20\u89c6\u9891', '\u70b9\u51fb\u4e0a\u4f20'],
      fileChooserSelectors: ['.bcc-upload-wrapper'],
      requireUploadEvidence: true,
      uploadInitialTextPattern: /\u70b9\u51fb\u4e0a\u4f20\u6216\u5c06\u89c6\u9891\u62d6\u62fd\u5230\u6b64\u533a\u57df/i,
      uploadEvidenceTextPattern: /\u89c6\u9891\u4e0a\u4f20\u4e2d|\u4e0a\u4f20\u5b8c\u6210|\u91cd\u65b0\u4e0a\u4f20|\u7a3f\u4ef6\u6807\u9898|\u89c6\u9891\u7b80\u4ecb|\u57fa\u7840\u8bbe\u7f6e/i,
      uploadEvidenceSelectors: ['input[placeholder*="\u6807\u9898"]', 'textarea[placeholder*="\u6807\u9898"]', '[class*="upload"] [class*="progress"]'],
      titleSelectors: ['input[placeholder*="标题"]', 'textarea[placeholder*="标题"]'],
      titleLabels: ['稿件标题', '标题'],
      captionSelectors: ['textarea[placeholder*="简介"]', 'textarea[placeholder*="描述"]', '[contenteditable="true"]'],
      captionLabels: ['视频简介', '稿件简介', '简介'],
      publishLabels: ['\u7acb\u5373\u6295\u7a3f', '\u63d0\u4ea4\u7a3f\u4ef6', '\u786e\u8ba4\u6295\u7a3f'],
      successPattern: /投稿成功|发布成功|稿件已提交|提交成功/i,
      publishSuccessUrlPattern: /\/platform\/upload-manager(?:[/?#]|$)/i,
      messageCardSelectors: ['[class*="reply-item"]', '[class*="message-item"]', '[class*="list-item"]']
    },
    weibo: {
      name: '微博',
      hostHints: ['weibo.com', 'api.weibo.com'],
      publishUrl: 'https://weibo.com/',
      checkUrl: 'https://weibo.com/',
      authenticatedUrlPattern: /^https:\/\/(?:www\.)?weibo\.com\/(?:$|u\/|profile|mygroups|hot|messages|at\/)/i,
      authenticatedTextPattern: /\u9996\u9875|\u70ed\u95e8\u5fae\u535a|\u6d88\u606f|\u6536\u85cf|\u521b\u4f5c\u4e2d\u5fc3|\u4e2a\u4eba\u4e3b\u9875/i,
      authenticatedSelectors: ['[class*="woo-avatar-main"]', '[class*="Avatar"] img', 'a[href*="/u/"]'],
      loggedOutSelectors: ['input[placeholder*="\u624b\u673a\u53f7"]', 'input[placeholder*="\u5bc6\u7801"]', '[class*="Login"]'],
      manageUrl: 'https://weibo.com/',
      commentUrl: 'https://weibo.com/at/weibo',
      messageUrl: 'https://api.weibo.com/chat/#/',
      loginUrlPattern: /passport\.weibo\.com|\/login(?:[/?#]|$)/i,
      loginTextPattern: /登录|扫码登录|短信登录|账号登录|安全验证/i,
      fileSelectors: ['input[type="file"][accept*="video"]', 'input[type="file"][accept*="image"]', 'input[type="file"]'],
      titleSelectors: [],
      titleLabels: [],
      captionSelectors: ['textarea[placeholder*="分享"]', 'textarea[placeholder*="新鲜事"]', '[contenteditable="true"]'],
      captionLabels: ['有什么新鲜事想告诉大家', '分享新鲜事', '正文'],
      publishLabels: ['发送', '发布'],
      contentDeclarationRequired: true,
      successPattern: /发布成功|发送成功|已发布/i,
      messageCardSelectors: ['[class*="comment-item"]', '[class*="message-item"]', '[class*="wbpro-list"]']
    }
  };
}

export const PLATFORM_ASSISTED_SPECS = Object.freeze(defaultSpecs());

export function classifyAssistedLoginEvidence({ url = '', text = '', visibleSelectors = [], spec = {} }) {
  const sample = `${url} ${text}`.slice(0, 24000); const evidence = []; let hostname = '';
  try { hostname = new URL(url).hostname.toLowerCase(); } catch {}
  if (!url || url === 'about:blank' || !hostname) return { state: 'UNKNOWN', evidence: ['missing-or-blank-url'] };
  if (VERIFY_RE.test(sample)) return { state: 'VERIFY_REQUIRED', evidence: ['verification-challenge'] };
  if (PAGE_ERROR_RE.test(sample)) return { state: 'ERROR', evidence: ['page-error'] };
  const targetHost = (spec.hostHints || []).some(host => hostname === host || hostname.endsWith(`.${host}`));
  const loginUrlPattern = toRegex(spec.loginUrlPattern, /\/login/i); const loginTextPattern = toRegex(spec.loginTextPattern, DEFAULT_LOGIN_RE);
  const loggedOutSelector = (spec.loggedOutSelectors || []).find(selector => visibleSelectors.includes(selector));
  if (loginUrlPattern.test(url) || loggedOutSelector || loginTextPattern.test(text.slice(0, 12000))) {
    if (loginUrlPattern.test(url)) evidence.push('login-url'); if (loggedOutSelector) evidence.push(`logged-out-selector:${loggedOutSelector}`); if (loginTextPattern.test(text.slice(0, 12000))) evidence.push('login-text');
    return { state: 'LOGIN', evidence };
  }
  if (!targetHost) return { state: 'UNKNOWN', evidence: ['non-target-domain'] };
  const authenticatedUrlPattern = toRegex(spec.authenticatedUrlPattern, null); const urlMatched = authenticatedUrlPattern ? authenticatedUrlPattern.test(url) : false;
  const authenticatedSelector = (spec.authenticatedSelectors || []).find(selector => visibleSelectors.includes(selector)); const authenticatedTextPattern = toRegex(spec.authenticatedTextPattern, null); const textMatched = authenticatedTextPattern ? authenticatedTextPattern.test(text.slice(0, 16000)) : false;
  if (urlMatched && (authenticatedSelector || textMatched)) { evidence.push('authenticated-url'); if (authenticatedSelector) evidence.push(`authenticated-selector:${authenticatedSelector}`); if (textMatched) evidence.push('authenticated-text'); return { state: 'READY', evidence }; }
  return { state: 'UNKNOWN', evidence: ['no-authenticated-evidence'] };
}

export function assessWechatCommentOverviewEvidence({
  url = '',
  text = '',
  overviewVisible = false,
  allVideoFilterVisible = false,
  totalVideoCount = null,
  videoRows = [],
  commentRowCount = 0
} = {}) {
  const normalizedText = clean(text);
  const urlMatched = /channels\.weixin\.qq\.com\/platform\/interaction\/comment(?:[/?#]|$)/i.test(String(url || ''));
  const titleMatched = /\u8bc4\u8bba\u7ba1\u7406/i.test(normalizedText);
  const allVideoMatched = allVideoFilterVisible || /\u5168\u90e8\u89c6\u9891/i.test(normalizedText);
  const parsedTotal = Number.isInteger(totalVideoCount) && totalVideoCount >= 0
    ? totalVideoCount
    : Number(normalizedText.match(/\u5171\s*(\d+)\s*\u4e2a/i)?.[1]);
  const totalKnown = Number.isInteger(parsedTotal) && parsedTotal >= 0;
  const rows = Array.isArray(videoRows) ? videoRows.map((row, index) => {
    const rawCount = row?.count;
    const count = typeof rawCount === 'number'
      ? rawCount
      : (clean(rawCount) ? Number(rawCount) : Number.NaN);
    return {
      index,
      time: clean(row?.time),
      count,
      visible: row?.visible !== false
    };
  }).filter(row => row.visible && Number.isInteger(row.count) && row.count >= 0) : [];
  const structuralPageMatched = Boolean(overviewVisible && allVideoMatched && totalKnown);
  const textualPageMatched = Boolean(titleMatched && allVideoMatched && totalKnown);
  const base = {
    confirmedEmpty: false,
    urlMatched,
    titleMatched,
    allVideoMatched,
    overviewVisible: Boolean(overviewVisible),
    totalVideoCount: totalKnown ? parsedTotal : null,
    videoRowCount: rows.length,
    commentRowCount: Math.max(0, Number(commentRowCount) || 0),
    videoRows: rows
  };
  if (!urlMatched) return { ...base, reason: 'COMMENT_OVERVIEW_URL_MISMATCH' };
  if (!structuralPageMatched && !textualPageMatched) return { ...base, reason: 'COMMENT_OVERVIEW_UNVERIFIED' };
  if (base.commentRowCount > 0) return { ...base, reason: 'COMMENT_ROWS_PRESENT' };
  if (parsedTotal === 0 && rows.length === 0) return { ...base, confirmedEmpty: true, reason: 'COMMENT_EMPTY_NO_VIDEOS' };
  if (!rows.length || rows.length !== parsedTotal) return { ...base, reason: 'COMMENT_VIDEO_LIST_INCOMPLETE' };
  if (rows.some(row => row.count > 0)) return { ...base, reason: 'COMMENT_COUNTS_PRESENT' };
  return { ...base, confirmedEmpty: true, reason: 'COMMENT_EMPTY_ALL_VIDEO_COUNTS_ZERO' };
}

export function assessWechatPrivateMessageEvidence({
  url = '',
  text = '',
  panelVisible = false,
  sessionRows = [],
  explicitEmptyVisible = false,
  declaredSessionTotal = null,
  totalText = ''
} = {}) {
  const normalizedText = clean(text);
  const urlMatched = /channels\.weixin\.qq\.com\/(?:platform\/private_msg|micro\/interaction\/private_msg)(?:[/?#]|$)/i.test(String(url || ''));
  const syncing = /\u6d88\u606f\u540c\u6b65\u4e2d/i.test(normalizedText);
  const visibleSessions = Array.isArray(sessionRows)
    ? sessionRows.filter(row => row?.visible !== false)
    : [];
  const hasDeclaredTotal = declaredSessionTotal !== null
    && declaredSessionTotal !== undefined
    && clean(declaredSessionTotal) !== '';
  const parsedDeclaredTotal = hasDeclaredTotal
    && Number.isInteger(Number(declaredSessionTotal))
    && Number(declaredSessionTotal) >= 0
    ? Number(declaredSessionTotal)
    : null;
  const explicitEmpty = Boolean(explicitEmptyVisible || /\u6682\u65e0\u79c1\u4fe1|\u6682\u65e0\u6253\u62db\u547c\u6d88\u606f|\u6682\u65e0\u6d88\u606f|\u8fd8\u6ca1\u6709\u79c1\u4fe1|\u6ca1\u6709\u79c1\u4fe1/i.test(normalizedText));
  const base = {
    ready: false,
    empty: false,
    urlMatched,
    panelVisible: Boolean(panelVisible),
    syncing,
    explicitEmpty,
    sessionCount: visibleSessions.length,
    declaredSessionTotal: parsedDeclaredTotal,
    totalText: clean(totalText) || null
  };
  if (!urlMatched) return { ...base, reason: 'PRIVATE_URL_MISMATCH' };
  if (!panelVisible) return { ...base, reason: 'PRIVATE_PANEL_MISSING' };
  if (syncing) return { ...base, reason: 'PRIVATE_SYNC_IN_PROGRESS' };
  if (visibleSessions.length > 0) return { ...base, ready: true, reason: 'PRIVATE_SESSIONS_READY' };
  if (parsedDeclaredTotal > 0) return { ...base, reason: 'PRIVATE_SESSION_LIST_INCOMPLETE' };
  if (explicitEmpty && parsedDeclaredTotal === 0) return { ...base, ready: true, empty: true, reason: 'PRIVATE_EMPTY_CONFIRMED' };
  if (explicitEmpty) return { ...base, ready: true, empty: true, reason: 'PRIVATE_EMPTY_UNCOUNTED' };
  return { ...base, reason: 'PRIVATE_CONTENT_UNRESOLVED' };
}

export function classifyMessagePageEvidence({ messageType = '', url = '', text = '', spec = {} } = {}) {
  const type = String(messageType || '').toUpperCase();
  const sample = clean(text).slice(0, 24000);
  if (PAGE_ERROR_RE.test(`${url} ${sample}`)) {
    return { valid: false, reason: 'PAGE_ERROR', evidence: ['page-error'] };
  }
  const isPrivate = type === 'PRIVATE_MESSAGE';
  const urlPattern = toRegex(isPrivate ? spec.privateMessagePageUrlPattern : spec.commentPageUrlPattern, null);
  const textPattern = toRegex(isPrivate ? spec.privateMessagePageTextPattern : spec.commentPageTextPattern, null);
  if (!urlPattern || !textPattern) {
    return { valid: false, reason: isPrivate ? 'OFFICIAL_APP_REQUIRED' : 'PAGE_SIGNALS_UNCONFIGURED', evidence: ['page-signals-unconfigured'] };
  }
  const urlMatched = urlPattern.test(String(url || ''));
  const textMatched = textPattern.test(sample);
  if (!urlMatched || !textMatched) {
    return {
      valid: false,
      reason: !urlMatched ? 'URL_MISMATCH' : 'PAGE_SIGNAL_MISSING',
      evidence: [urlMatched ? 'message-url-matched' : 'message-url-mismatch', textMatched ? 'message-text-matched' : 'message-text-missing']
    };
  }
  return { valid: true, reason: 'VERIFIED', evidence: ['message-url-matched', 'message-text-matched'] };
}

export class AssistedPlatformRpaAdapter extends RpaAdapter {
  constructor({ platformCode, logsDir, profileDir, executablePath, loginTimeoutMs, sendTimeoutMs, uploadTimeoutOptions = {}, authorizeSubmit = null, browserRuntimeManager = null, spec = {} }) {
    super({ platformCode });
    const builtIn = PLATFORM_ASSISTED_SPECS[platformCode];
    if (!builtIn) throw new Error(`缺少平台配置：${platformCode}`);
    this.spec = { ...builtIn, ...spec };
    this.logsDir = logsDir;
    this.profileDir = profileDir;
    this.executablePath = executablePath;
    this.loginTimeoutMs = loginTimeoutMs;
    this.sendTimeoutMs = sendTimeoutMs;
    this.uploadTimeoutOptions = uploadTimeoutOptions;
    this.submitAuthorizer = typeof authorizeSubmit === 'function' ? authorizeSubmit : null;
    this.browserRuntimeManager = browserRuntimeManager;
    this.browserExecution = { providerRequested: 'web_access_cdp', providerUsed: null, fallbackUsed: false, fallbackReason: null };
    this.context = null;
    this.activePage = null;
    this.channelPages = new Map();
    this.launching = null;
    this.profileProcessIds = [];
    fs.mkdirSync(logsDir, { recursive: true });
  }


  setSubmitAuthorizer(authorizer) {
    this.submitAuthorizer = typeof authorizer === 'function' ? authorizer : null;
  }

  async authorizeFinalSubmit(payload = {}, context = {}) {
    if (typeof this.submitAuthorizer !== 'function') {
      const error = new Error(`${this.spec.name} \u6295\u7a3f\u9501\u670d\u52a1\u4e0d\u53ef\u7528\uff0c\u7981\u6b62\u6267\u884c\u6700\u7ec8\u53d1\u5e03`);
      error.code = 'SUBMIT_LOCK_UNAVAILABLE';
      throw error;
    }
    const authorization = await this.submitAuthorizer({ ...payload, platformCode: this.platformCode }, context);
    if (authorization?.authorized !== true || authorization?.submitLock !== 'LOCKED') {
      const error = new Error(authorization?.message || `${this.spec.name} \u6295\u7a3f\u9501\u672a\u83b7\u6388\u6743\uff0c\u7981\u6b62\u6267\u884c\u6700\u7ec8\u53d1\u5e03`);
      error.code = authorization?.code || 'SUBMIT_LOCK_DENIED';
      error.authorization = authorization || null;
      throw error;
    }
    return authorization;
  }

  async ensureContext() {
    await this.assertRuntimeAllowed();
    if (this.context) return this.context;
    const lifecycleGeneration = this.lifecycleGeneration;
    if (this.launching) return this.launching;
    if (lifecycleGeneration !== this.lifecycleGeneration) throw this.platformStoppedError();
    await this.assertRuntimeAllowed();
    if (lifecycleGeneration !== this.lifecycleGeneration) throw this.platformStoppedError();

    const launching = (async () => {
      if (this.browserRuntimeManager?.isPrimaryMode?.()) {
        try {
          const runtime = await this.browserRuntimeManager.acquirePlatformContext({
            platformCode: this.platformCode,
            profileDir: this.profileDir,
            executablePath: this.executablePath
          });
          await this.assertRuntimeAllowed();
          if (lifecycleGeneration !== this.lifecycleGeneration) throw this.platformStoppedError();
          this.context = runtime.context;
          this.browserExecution = {
            providerRequested: 'web_access_cdp',
            providerUsed: 'web_access_cdp',
            fallbackUsed: false,
            fallbackReason: null,
            compatibilityLayer: runtime.compatibilityLayer || 'playwright_connect_over_cdp',
            proxyPort: runtime.proxyPort,
            browserDebugPort: runtime.browserDebugPort
          };
          this.context.on('close', () => { if (this.context === runtime.context) this.context = null; });
          return this.context;
        } catch (error) {
          if (!this.browserRuntimeManager.shouldUseLegacyFallback?.(error)) throw error;
          this.browserExecution = {
            providerRequested: 'web_access_cdp',
            providerUsed: 'playwright',
            fallbackUsed: true,
            fallbackReason: { code: error.code || 'WEB_ACCESS_START_FAILED', message: error.message },
            compatibilityLayer: 'playwright_launch_persistent_context'
          };
          console.warn(`[WebAccess] ${this.platformCode} 主控启动失败，业务浏览器临时回退到原 Playwright：${error.message}`);
        }
      } else {
        this.browserExecution = {
          providerRequested: 'playwright',
          providerUsed: 'playwright',
          fallbackUsed: false,
          fallbackReason: null,
          compatibilityLayer: 'playwright_launch_persistent_context'
        };
      }

      fs.mkdirSync(this.profileDir, { recursive: true });
      const processSnapshot = await listWindowsProcesses().catch(() => []);
      const preexistingProfileProcessIds = profileProcessTreeIds(processSnapshot, this.profileDir);
      const context = await chromium.launchPersistentContext(this.profileDir, {
        headless: false,
        executablePath: this.executablePath,
        viewport: null,
        acceptDownloads: true,
        args: ['--start-maximized'],
        locale: 'zh-CN'
      });
      try {
        await this.assertRuntimeAllowed();
        if (lifecycleGeneration !== this.lifecycleGeneration) throw this.platformStoppedError();
        this.context = context;
        this.profileProcessIds = profileProcessTreeIds(await listWindowsProcesses().catch(() => []), this.profileDir)
          .filter(processId => !preexistingProfileProcessIds.includes(processId));
        context.on('close', () => { if (this.context === context) this.context = null; });
        return context;
      } catch (error) {
        await context.close().catch(() => {});
        throw error;
      }
    })().finally(() => {
      if (this.launching === launching) this.launching = null;
    });
    this.launching = launching;
    return launching;
  }

  async stop() {
    this.invalidatePendingOperations();
    const context = this.context;
    const launching = this.launching;
    const webAccessOwned = this.browserExecution?.providerUsed === 'web_access_cdp';
    this.context = null;
    if ('activePage' in this) this.activePage = null;
    if (this.channelPages) this.channelPages.clear();
    if (webAccessOwned && this.browserRuntimeManager) {
      await this.browserRuntimeManager.stopPlatform(this.platformCode).catch(() => {});
      this.profileProcessIds = [];
      return { stopped: true, browserClosed: Boolean(context || launching), providerUsed: 'web_access_cdp' };
    }
    if (context) await context.close().catch(() => {});
    const fallbackWasActive = this.browserExecution?.fallbackUsed === true;
    const knownProcessIds = this.profileProcessIds || [];
    const killedProcessIds = await forceStopProfileProcesses(this.profileDir, { knownProcessIds });
    this.profileProcessIds = [];
    if (launching) {
      void launching.catch(() => null)
        .then(() => forceStopProfileProcesses(this.profileDir, { knownProcessIds }))
        .catch(error => console.error(`[Agent] Failed to clean late ${this.platformCode} browser processes: ${error.message}`));
    }
    if (fallbackWasActive && typeof this.browserRuntimeManager?.prepareForWebAccessTakeover === 'function') {
      await this.browserRuntimeManager.prepareForWebAccessTakeover({
        platformCode: this.platformCode,
        releaseFallback: async () => {},
        timeoutMs: 750
      }).catch(error => console.warn(`[WebAccess] ${this.platformCode} fallback 已释放，但清除 Runtime 占用标记失败：${error.message}`));
    }
    return { stopped: true, browserClosed: Boolean(context || launching || killedProcessIds.length), killedProcessIds, providerUsed: this.browserExecution?.providerUsed || 'playwright' };
  }

  normalizeChannelPageKey(channelType) {
    const normalized = String(channelType || 'GENERAL').trim().toUpperCase();
    return ['COMMENT', 'PRIVATE_MESSAGE'].includes(normalized) ? normalized : 'GENERAL';
  }

  async getChannelPage(channelType, { bringToFront = false } = {}) {
    const key = this.normalizeChannelPageKey(channelType);
    const context = await this.ensureContext();
    const current = this.channelPages.get(key);
    if (current && !current.isClosed()) {
      if (bringToFront) await current.bringToFront();
      return current;
    }
    const assigned = new Set([...this.channelPages.values()].filter(page => page && !page.isClosed()));
    const page = context.pages().find(item => !item.isClosed() && !assigned.has(item) && this.spec.hostHints.some(host => item.url().includes(host)))
      || context.pages().find(item => !item.isClosed() && !assigned.has(item) && item.url() === 'about:blank')
      || await context.newPage();
    this.channelPages.set(key, page);
    if (typeof page.once === 'function') {
      page.once('close', () => { if (this.channelPages.get(key) === page) this.channelPages.delete(key); });
    }
    this.activePage = page;
    if (bringToFront) await page.bringToFront();
    return page;
  }

  async getPage({ bringToFront = false } = {}) {
    return this.getChannelPage(channelPageScope.getStore() || 'GENERAL', { bringToFront });
  }

  async inspectLoginState(page) {
    const text = (await pageEvidenceText(page)).slice(0, 20000);
    const url = page.url();
    const visibleSelectors = [];
    for (const selector of [...(this.spec.loggedOutSelectors || []), ...(this.spec.authenticatedSelectors || [])]) {
      if (await page.locator(selector).first().isVisible().catch(() => false)) visibleSelectors.push(selector);
    }
    return classifyAssistedLoginEvidence({ url, text, visibleSelectors, spec: this.spec });
  }

  async detectPageState(page) { return (await this.inspectLoginState(page)).state; }

  async waitForDetectedPageState(page, timeoutMs = 5000) {
    const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0);
    let state = 'UNKNOWN';
    do {
      state = await this.detectPageState(page);
      if (state !== 'UNKNOWN') return state;
      if (Date.now() >= deadline) break;
      await page.waitForTimeout(Math.min(500, Math.max(1, deadline - Date.now())));
    } while (Date.now() < deadline);
    return state;
  }

  async status(page = null, { checked = false } = {}) {
    const checkedAt = checked ? new Date().toISOString() : null;
    try {
      const current = page || (this.context ? this.context.pages().find(item => this.spec.hostHints.some(host => item.url().includes(host))) : null);
      if (!current) return { platformCode: this.platformCode, browser: 'CLOSED', loggedIn: false, state: 'CLOSED', confidence: 'UNCONFIRMED', evidence: [], checkedAt, url: null, message: `${this.spec.name}\u4e13\u7528\u6d4f\u89c8\u5668\u5c1a\u672a\u6253\u5f00` };
      const result = await this.inspectLoginState(current);
      const state = result.state;
      return { platformCode: this.platformCode, browser: 'OPEN', loggedIn: state === 'READY', state, confidence: ['READY','LOGIN','VERIFY_REQUIRED'].includes(state) ? 'CONFIRMED' : 'UNCONFIRMED', evidence: result.evidence, checkedAt, url: current.url(), message: state === 'READY' ? `${this.spec.name}\u5df2\u786e\u8ba4\u767b\u5f55` : state === 'LOGIN' ? `${this.spec.name}\u5df2\u786e\u8ba4\u672a\u767b\u5f55` : state === 'VERIFY_REQUIRED' ? `${this.spec.name}\u9700\u8981\u4eba\u5de5\u5b8c\u6210\u5e73\u53f0\u9a8c\u8bc1` : state === 'ERROR' ? `${this.spec.name}\u9875\u9762\u5f02\u5e38\uff0c\u65e0\u6cd5\u786e\u8ba4\u767b\u5f55\u72b6\u6001` : `${this.spec.name}\u767b\u5f55\u72b6\u6001\u65e0\u6cd5\u786e\u8ba4` };
    } catch (error) { return { platformCode: this.platformCode, browser: this.context ? 'OPEN' : 'CLOSED', loggedIn: false, state: 'ERROR', confidence: 'UNCONFIRMED', evidence: ['exception'], checkedAt, url: null, message: error.message }; }
  }

  async openLogin() {
    const page = await this.getPage({ bringToFront: true });
    await page.goto(this.spec.publishUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(1200);
    return this.status(page);
  }

  async checkLogin({ preserveInteractiveLogin = false } = {}) {
    const page = await this.getPage();
    if (preserveInteractiveLogin) {
      const currentStatus = await this.status(page, { checked: true });
      if (['LOGIN', 'VERIFY_REQUIRED'].includes(currentStatus.state) && currentStatus.confidence === 'CONFIRMED') {
        return this.recheckLogin(page);
      }
    }
    await page.goto(this.spec.checkUrl || this.spec.manageUrl || this.spec.publishUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(1800);
    return this.recheckLogin(page);
  }

  async recheckLogin(existingPage = null) {
    const page = existingPage || await this.getPage();
    let status = await this.status(page, { checked: true });
    const deadline = Date.now() + 8_000;
    while (status.state === 'UNKNOWN' && Date.now() < deadline) {
      await page.waitForTimeout(1000);
      status = await this.status(page, { checked: true });
    }
    return status;
  }

  async debug() {
    const page = await this.getPage();
    const status = await this.status(page);
    const text = await pageEvidenceText(page);
    const controls = await page.locator('button,input,textarea,[contenteditable],[role="button"],a').evaluateAll(elements => elements.slice(0, 200).map(element => ({
      tag: element.tagName.toLowerCase(),
      text: (element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 160),
      placeholder: element.getAttribute('placeholder'),
      ariaLabel: element.getAttribute('aria-label'),
      type: element.getAttribute('type'),
      href: element.getAttribute('href'),
      accept: element.getAttribute('accept'),
      disabled: element.disabled === true || element.getAttribute('aria-disabled') === 'true',
      visible: getComputedStyle(element).display !== 'none' && getComputedStyle(element).visibility !== 'hidden' && element.getClientRects().length > 0,
      className: String(element.className || '').slice(0, 240),
      parentClassName: String(element.parentElement?.className || '').slice(0, 240),
      parentText: String(element.parentElement?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 240),
      outerHTML: String(element.outerHTML || '').slice(0, 600),
      contentEditable: element.isContentEditable === true
    })).filter(item => item.text || item.placeholder || item.ariaLabel || item.type === 'file' || item.contentEditable));
    const scripts = await page.locator('script[src]').evaluateAll(elements => elements.map(element => element.src).filter(Boolean));
    const frames = await Promise.all(pageFrames(page).map(async frame => ({
      url: frame.url(),
      title: await frame.title().catch(() => ''),
      bodyText: clean(await frame.locator('body').innerText({ timeout: 3000 }).catch(() => '')).slice(0, 20000),
      scripts: await frame.locator('script[src]').evaluateAll(elements => elements.map(element => element.src).filter(Boolean)).catch(() => [])
    })));
    const resources = await page.evaluate(() => performance.getEntriesByType('resource').map(entry => entry.name).filter(Boolean));
    return { status, title: await page.title(), url: page.url(), bodyText: text.slice(0, 20000), controls, scripts, frames, resources };
  }

  async inspectText(targetText) {
    const query = clean(targetText);
    if (!query) throw new Error('\u7f3a\u5c11\u9700\u8981\u68c0\u67e5\u7684\u9875\u9762\u6587\u5b57');
    const page = await this.getPage();
    const locator = page.getByText(query, { exact: false });
    const count = Math.min(await locator.count().catch(() => 0), 30);
    const matches = [];
    for (let index = 0; index < count; index += 1) {
      const item = locator.nth(index);
      if (!await item.isVisible().catch(() => false)) continue;
      matches.push(await item.evaluate(element => {
        const chain = [];
        let current = element;
        for (let depth = 0; current && depth < 6; depth += 1, current = current.parentElement) {
          chain.push({
            tag: current.tagName?.toLowerCase?.() || null,
            text: String(current.innerText || current.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 500),
            href: current.getAttribute?.('href') || null,
            role: current.getAttribute?.('role') || null,
            className: String(current.className || '').slice(0, 400),
            outerHTML: String(current.outerHTML || '').slice(0, 12000)
          });
        }
        return { chain };
      }));
    }
    return { query, url: page.url(), title: await page.title(), count, matches };
  }

  async clickNavigationText(targetText) {
    const query = clean(targetText);
    if (!/^(\u4e92\u52a8\u7ba1\u7406|\u8bc4\u8bba|\u8bc4\u8bba\u7ba1\u7406|\u4f5c\u54c1\u8bc4\u8bba|\u79c1\u4fe1|\u79c1\u4fe1\u7ba1\u7406|\u6d88\u606f\u7ba1\u7406|\u66f4\u591a\u670d\u52a1|\u67e5\u770b\u5168\u90e8|\u6d88\u606f|\u7ee7\u7eed\u7f16\u8f91)$/.test(query)) throw new Error('Navigation label is not allowlisted');
    const page = await this.getPage();
    const candidates = [page.getByText(query, { exact: true }), page.getByText(query, { exact: false })];
    const target = await firstUsable(candidates);
    if (!target) throw new Error(`\u672a\u627e\u5230\u53ef\u70b9\u51fb\u7684\u5bfc\u822a\u5165\u53e3\uff1a${query}`);
    const clickable = target.locator('xpath=ancestor-or-self::a[1]');
    await (await clickable.count().catch(() => 0) ? clickable.first() : target).click();
    await page.waitForTimeout(1800);
    const debug = await this.debug();
    const screenshotPath = path.join(this.logsDir, `${this.platformCode}-navigation-${Date.now()}.png`);
    await page.screenshot({ path: screenshotPath, fullPage: false }).catch(() => {});
    return { ...debug, screenshotPath: fs.existsSync(screenshotPath) ? screenshotPath : null };
  }


  async inspectConversation(userName) {
    if (this.platformCode === 'douyin' && channelPageScope.getStore() !== 'PRIVATE_MESSAGE') {
      return channelPageScope.run('PRIVATE_MESSAGE', () => this.inspectConversation(userName));
    }
    const query = clean(userName);
    if (!query) throw new Error('\u7f3a\u5c11\u9700\u8981\u68c0\u67e5\u7684\u79c1\u4fe1\u4f1a\u8bdd\u540d\u79f0');
    const page = await this.getPage();
    let targetResult = null;

    if (query === '__LIST_ONLY__' && this.platformCode === 'douyin') {
      const navigation = await this.prepareMessagePage(page, { type: 'PRIVATE_MESSAGE', label: '\u79c1\u4fe1', url: this.spec.messageUrl });
      const text = await pageEvidenceText(page);
      const pageCheck = await this.classifyLiveMessagePage(page, 'PRIVATE_MESSAGE', text);
      const rows = page.locator('[data-e2e="conversation-item"]');
      const count = await rows.count().catch(() => 0);
      const conversations = [];
      for (let index = 0; index < count; index += 1) {
        const row = rows.nth(index);
        if (!await row.isVisible().catch(() => false)) continue;
        const title = await firstUsable((this.spec.privateConversationNameSelectors || []).map(selector => row.locator(selector)));
        const preview = await firstUsable((this.spec.privateConversationContentSelectors || []).map(selector => row.locator(selector)));
        conversations.push({
          index,
          name: clean(await title?.innerText().catch(() => '')),
          preview: clean(await preview?.innerText().catch(() => '')),
          outerHTML: await row.evaluate(element => String(element.outerHTML || '').slice(0, 8000)).catch(() => '')
        });
      }
      const screenshotPath = path.join(this.logsDir, `${this.platformCode}-conversation-list-${Date.now()}.png`);
      await page.screenshot({ path: screenshotPath, fullPage: false }).catch(() => {});
      return {
        url: page.url(),
        title: await page.title(),
        navigation,
        pageCheck,
        conversations,
        screenshotPath: fs.existsSync(screenshotPath) ? screenshotPath : null,
        inspectionOnly: true,
        sent: false
      };
    }

    if (this.platformCode === 'douyin' && this.spec.privateMessageEntrySelectors?.length) {
      targetResult = await this.openPrivateConversationForPayload(page, { userName: query }, { requireSourcePreview: false, requireUnreadEvidence: false });
      if (!targetResult.ok) throw new Error(`\u65e0\u6cd5\u7cbe\u786e\u6253\u5f00\u79c1\u4fe1\u4f1a\u8bdd\uff1a${query}（${targetResult.reason}）`);
    } else {
      const rows = page.locator('[data-e2e="conversation-item"]');
      const count = await rows.count().catch(() => 0);
      let target = null;
      for (let index = 0; index < count; index += 1) {
        const row = rows.nth(index);
        const exactTitle = row.getByText(query, { exact: true });
        if (await exactTitle.first().isVisible().catch(() => false)) { target = row; break; }
      }
      if (!target || !await target.isVisible().catch(() => false)) throw new Error(`\u672a\u5728\u5f53\u524d\u79c1\u4fe1\u5217\u8868\u627e\u5230\u4f1a\u8bdd\uff1a${query}`);
      await target.click();
      await page.waitForTimeout(1800);
    }

    const editor = await this.findReplyEditor(page, true);
    const editorEvidence = editor ? await editor.evaluate(element => ({
      tag: element.tagName.toLowerCase(),
      placeholder: element.getAttribute('placeholder'),
      ariaLabel: element.getAttribute('aria-label'),
      className: String(element.className || '').slice(0, 300),
      parentClassName: String(element.parentElement?.className || '').slice(0, 300),
      contentEditable: element.isContentEditable === true,
      visible: getComputedStyle(element).display !== 'none' && getComputedStyle(element).visibility !== 'hidden' && element.getClientRects().length > 0,
      outerHTML: String(element.outerHTML || '').slice(0, 1000),
      containerOuterHTML: String(element.parentElement?.parentElement?.outerHTML || element.parentElement?.outerHTML || '').slice(0, 12000)
    })).catch(() => null) : null;
    const editorBox = editor ? await editor.boundingBox().catch(() => null) : null;
    const nearbyControls = editorBox ? await page.locator('button,[role="button"]').evaluateAll((elements, box) => elements.map((element, index) => {
      const rect = element.getBoundingClientRect();
      const visible = getComputedStyle(element).display !== 'none' && getComputedStyle(element).visibility !== 'hidden' && element.getClientRects().length > 0;
      const centerY = rect.y + rect.height / 2;
      const editorCenterY = box.y + box.height / 2;
      const dx = rect.x - (box.x + box.width);
      const dy = Math.abs(centerY - editorCenterY);
      if (!visible || dx < -80 || dx > 260 || dy > 130) return null;
      return {
        index,
        text: String(element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120),
        ariaLabel: element.getAttribute('aria-label'),
        title: element.getAttribute('title'),
        className: String(element.className || '').slice(0, 300),
        disabled: element.disabled === true || element.getAttribute('aria-disabled') === 'true',
        dx: Math.round(dx),
        dy: Math.round(dy),
        outerHTML: String(element.outerHTML || '').slice(0, 1000)
      };
    }).filter(Boolean).sort((a, b) => (Math.abs(a.dx) + a.dy) - (Math.abs(b.dx) + b.dy)).slice(0, 20), editorBox).catch(() => []) : [];

    const privateTimeline = this.platformCode === 'douyin'
      ? await this.inspectStablePrivateConversationTimeline(page)
      : null;
    const debug = await this.debug();
    const screenshotPath = path.join(this.logsDir, `${this.platformCode}-conversation-${Date.now()}.png`);
    await page.screenshot({ path: screenshotPath, fullPage: false }).catch(() => {});
    return {
      ...debug,
      screenshotPath: fs.existsSync(screenshotPath) ? screenshotPath : null,
      conversation: query,
      navigation: targetResult?.navigation || null,
      pageCheck: targetResult?.pageCheck || null,
      previewText: targetResult?.previewText || null,
      editorEvidence,
      nearbyControls,
      privateTimeline,
      inspectionOnly: true,
      sent: false
    };
  }

  async inspectReplyTarget(payload = {}) {
    const page = await this.getPage();
    const isPrivate = String(payload.messageType || '').toUpperCase() === 'PRIVATE_MESSAGE';
    let target = null;
    let editorEvidence = null;
    let sendEvidence = null;
    if (isPrivate) {
      target = await this.openPrivateConversationForPayload(page, payload, { requireSourcePreview: true, requireUnreadEvidence: false });
      if (target.ok) {
        const editor = await this.findReplyEditor(page, true);
        editorEvidence = editor ? await editor.evaluate(element => ({
          className: String(element.className || ''),
          placeholder: element.getAttribute('placeholder') || element.getAttribute('data-placeholder'),
          contentEditable: element.isContentEditable === true
        })).catch(() => null) : null;
        if (editor) {
          const row = editor.locator('xpath=ancestor::*[contains(@class,"messageMsgInputinputRow")][1]');
          const control = await firstUsable((this.spec.privateMessageSendSelectors || []).map(selector => row.locator(selector)));
          const rawSendEvidence = control ? await control.evaluate(element => ({
            className: String(element.className?.baseVal || element.className || ''),
            ariaLabel: element.getAttribute('aria-label'),
            title: element.getAttribute('title')
          })).catch(() => null) : null;
          sendEvidence = rawSendEvidence ? { ...rawSendEvidence, accepted: isPrivateSendControlEvidence(rawSendEvidence) } : null;
        }
      }
    } else {
      const targetUrl = isDouyin ? this.spec.commentUrl : (clean(payload.externalUrl) || this.spec.commentUrl);
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      const readiness = await this.waitForMessageContentReady(page, 'COMMENT');
      target = readiness.ready ? await this.locateMessageContainerWithRetry(page, payload) : { ok: false, reason: readiness.reason, readiness };
      if (target.ok) {
        const trigger = await firstUsable([
          target.locator.getByText(/^\u56de\u590d$/, { exact: true }),
          target.locator.getByRole('button', { name: /^\u56de\u590d$/ })
        ]);
        if (!trigger) target = { ...target, ok: false, reason: 'REPLY_TRIGGER_MISSING' };
        else {
          await this.assertRuntimeAllowed();
          await trigger.click();
          await page.waitForTimeout(500);
          const editor = await this.findDouyinCommentEditor(page, payload, target.locator);
          editorEvidence = editor.ok
            ? { ...editor.contextEvidence, rootCount: editor.rootCount, editorCount: editor.editorCount }
            : { reason: editor.reason, count: editor.count, rootCount: editor.rootCount, editorCount: editor.editorCount, candidates: editor.editorCandidates };
          if (editor.ok) {
            const send = await this.findDouyinCommentSend(editor.root, { requireEnabled: false });
            sendEvidence = send.ok ? send.evidence : { reason: send.reason, count: send.count, candidateCount: send.candidateCount, candidates: send.candidates };
          }
        }
      }
    }
    const screenshotPath = path.join(this.logsDir, `${this.platformCode}-reply-target-inspection-${Date.now()}.png`);
    await page.screenshot({ path: screenshotPath, fullPage: false }).catch(() => {});
    return {
      target: target ? { ...target, locator: undefined } : null,
      editorEvidence,
      sendEvidence,
      url: page.url(),
      screenshotPath: fs.existsSync(screenshotPath) ? screenshotPath : null,
      inspectionOnly: true,
      sent: false
    };
  }

  async inspectUrl(url) {
    const target = new URL(String(url || '').trim());
    if (target.protocol !== 'https:' || !(this.spec.hostHints || []).some(host => target.hostname === host || target.hostname.endsWith('.' + host))) {
      throw new Error(`\u53ea\u5141\u8bb8\u68c0\u67e5${this.spec.name}\u5e73\u53f0\u7684 HTTPS \u9875\u9762`);
    }
    const page = await this.getPage();
    await page.goto(target.href, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(1800);
    const debug = await this.debug();
    const screenshotPath = path.join(this.logsDir, `${this.platformCode}-url-inspection-${Date.now()}.png`);
    await page.screenshot({ path: screenshotPath, fullPage: false }).catch(() => {});
    return { ...debug, screenshotPath: fs.existsSync(screenshotPath) ? screenshotPath : null };
  }

  async waitForReady(page) {
    const deadline = Date.now() + this.loginTimeoutMs;
    while (Date.now() < deadline) {
      if (await this.detectPageState(page) === 'READY') return true;
      await page.waitForTimeout(1000);
    }
    return false;
  }

  async runIssueDiagnosis(payload = {}) {
    await this.assertRuntimeAllowed();
    const requestedPages = Array.isArray(payload.pages) ? payload.pages : [];
    if (!requestedPages.length) return { status: 'FAILED', result: { message: 'AI 自检未配置只读取证页面', safeReadOnly: true, pages: [] } };
    const screenshotDir = path.resolve(String(payload.screenshotDir || path.join(this.logsDir, 'issue-diagnosis', this.platformCode, String(Date.now()))));
    fs.mkdirSync(screenshotDir, { recursive: true });
    const captured = [];
    try {
      const page = await this.getPage();
      for (let index = 0; index < requestedPages.length; index += 1) {
        await this.assertRuntimeAllowed();
        const item = requestedPages[index] || {};
        const target = new URL(String(item.url || ''));
        if (target.protocol !== 'https:' || !this.spec.hostHints.some(host => target.hostname === host || target.hostname.endsWith('.' + host) || target.hostname.includes(host))) {
          throw new Error('Smoke Test 仅允许访问平台配置的 HTTPS 页面');
        }
        await page.goto(target.href, { waitUntil: 'domcontentloaded', timeout: 60_000 });
        await page.waitForTimeout(Math.max(500, Number(payload.settleMs) || 2_000));
        const selectors = [...new Set((Array.isArray(item.selectors) ? item.selectors : []).map(value => String(value || '').trim()).filter(Boolean))].slice(0, 80);
        const selectorHits = {};
        for (const selector of selectors) selectorHits[selector] = await page.locator(selector).first().count().then(count => count > 0).catch(() => false);
        const evidence = await page.evaluate(() => {
          const visible = element => {
            const style = getComputedStyle(element);
            return style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity || 1) > 0 && element.getClientRects().length > 0;
          };
          const cleanText = value => String(value || '').replace(/\s+/g, ' ').trim();
          const keyText = [...document.querySelectorAll('h1,h2,h3,[role="heading"],label,button,[role="button"],[role="tab"],nav a')]
            .filter(visible).map(element => cleanText(element.innerText || element.textContent || element.getAttribute('aria-label') || ''))
            .filter(value => value.length >= 2 && value.length <= 160).slice(0, 240);
          const controls = [...document.querySelectorAll('button,a,input,textarea,select,[role="button"],[role="tab"],[role="menuitem"]')]
            .filter(visible).map(element => cleanText(element.innerText || element.textContent || element.getAttribute('placeholder') || element.getAttribute('aria-label') || element.getAttribute('title') || element.tagName.toLowerCase()))
            .filter(value => value.length >= 1 && value.length <= 120).slice(0, 240);
          const count = selector => document.querySelectorAll(selector).length;
          return {
            keyText: [...new Set(keyText)], controls: [...new Set(controls)],
            structure: { body: count('body'), main: count('main'), nav: count('nav'), form: count('form'), dialog: count('[role="dialog"]'), button: count('button,[role="button"]'), input: count('input'), textarea: count('textarea'), link: count('a'), iframe: count('iframe') }
          };
        });
        const key = String(item.key || 'page-' + (index + 1)).replace(/[^a-z0-9_-]+/gi, '-').slice(0, 80) || 'page-' + (index + 1);
        const screenshotPath = path.join(screenshotDir, key + '.png');
        await page.screenshot({ path: screenshotPath, fullPage: false });
        captured.push({ key, name: String(item.name || key), url: page.url(), title: await page.title(), keyText: evidence.keyText, controls: evidence.controls, selectorHits, structure: evidence.structure, screenshotPath, capturedAt: new Date().toISOString() });
      }
      return { status: 'SUCCESS', result: { platformCode: this.platformCode, capturedAt: new Date().toISOString(), safeReadOnly: true, mode: 'READ_ONLY', pages: captured } };
    } catch (error) {
      return { status: 'FAILED', result: { platformCode: this.platformCode, capturedAt: new Date().toISOString(), safeReadOnly: true, mode: 'READ_ONLY', pages: captured, message: error.message, code: error.code || 'DIAGNOSIS_EVIDENCE_FAILED' } };
    }
  }

  async execute(job) {
    const lane = operationLaneForJob(job);
    return channelPageScope.run(lane, async () => {
      if (job.job_type === 'DIAGNOSE_ISSUE') return this.runIssueDiagnosis({ ...job.payload, safeReadOnly: true, mode: 'READ_ONLY' });
      if (job.job_type === 'RUN_SMOKE_TEST') return { status: 'CANCELLED', result: { message: '页面巡检功能已下线', safeReadOnly: true } };
      if (job.job_type === 'PUBLISH') return this.publish(job.payload);
      if (job.job_type === 'VERIFY_PUBLISH') return this.verifyPublish(job.payload);
      if (job.job_type === 'COLLECT_MESSAGES') return filterRecoveryCollectionOutput(await this.collectMessages(job.payload), job.payload);
      if (job.job_type === 'REPLY') return this.replyToMessage(job.payload);
      if (job.job_type === 'DETECT_MANUAL_REPLY') return this.detectManualReply(job.payload);
      throw new Error(`不支持的${this.spec.name} RPA任务类型：${job.job_type}`);
    });
  }

  async applyContentDeclaration(page, payload) {
    if (!this.spec.contentDeclarationRequired) return { applied: false };
    const origin = normalizeContentOrigin(payload.contentOrigin);
    if (!origin) throw new Error('平台要求内容声明（必填），但任务未明确内容来源；已禁止系统猜测');

    const declaration = await findLabeledControl(page, ['请进行内容声明（必填）', '内容声明（必填）', '内容声明'], { enabled: true });
    if (!declaration) throw new Error('页面要求内容声明，但未找到可可靠操作的声明入口');
    await declaration.locator.click();
    await page.waitForTimeout(500);

    const labels = contentDeclarationLabels(origin);
    const option = await findLabeledControl(page, labels, { enabled: true });
    if (!option) throw new Error(`未找到与任务内容来源 ${origin} 精确匹配的平台声明选项，已停止发布`);
    await option.locator.click();
    await page.waitForTimeout(500);
    return { applied: true, contentOrigin: origin, selectedLabel: option.label };
  }

  async waitForUploadAndPublishReady(page, timeoutMs = 180000, { allowDisabled = false } = {}) {
    const deadline = Date.now() + timeoutMs;
    let last = null;
    let stableReadySamples = 0;
    while (Date.now() < deadline) {
      await this.assertRuntimeAllowed();
      const button = await findLabeledControl(page, this.spec.publishLabels || [], { enabled: false });
      const buttonVisible = Boolean(button && await button.locator.isVisible().catch(() => false));
      const buttonEnabled = Boolean(button && await isControlEnabled(button.locator));
      const text = await allFrameText(page);
      last = analyzePublishReadiness({ text, publishButtonVisible: buttonVisible, publishButtonEnabled: buttonEnabled });
      if (last.uploadFailed) {
        const error = new Error(`${this.spec.name}视频上传失败，平台提示重新上传`);
        error.code = 'PLATFORM_UPLOAD_FAILED';
        error.retryable = true;
        error.platformState = 'UPLOAD_FAILED';
        error.platformMessage = last.failureText;
        throw error;
      }
      const acceptable = last.ready || (allowDisabled && !last.busy && buttonVisible);
      stableReadySamples = acceptable ? stableReadySamples + 1 : 0;
      // Several consecutive samples prevent a stale ready form from winning the race
      // before a newly selected file starts reporting upload progress.
      if (stableReadySamples >= 5) {
        return { ...last, publishLabel: button.label, manualRequired: !last.ready, stableReadySamples };
      }
      if (PAGE_ERROR_RE.test(text)) throw new Error('平台发布页面发生错误，已停止提交');
      if (VERIFY_RE.test(text)) throw new Error('平台要求人工安全验证，已停止提交');
      await page.waitForTimeout(1000);
    }
    const reason = last?.busy ? '素材仍在上传、处理或生成封面' : last?.publishButtonVisible ? '最终发布按钮仍不可用，可能有平台必填项未完成' : '未找到最终发布按钮';
    throw new Error(`${reason}，等待超时后已停止提交`);
  }

  async prepareDraft(page, payload, materialPath) {
    const uploadTimeoutMs = resolveUploadTimeoutMs(materialPath, this.uploadTimeoutOptions);
    const metadataFieldTimeoutMs = Math.max(1000, Math.min(uploadTimeoutMs, Number(this.spec.metadataFieldTimeoutMs || uploadTimeoutMs)));
    let materialAttachment = null;
    let draftPrepareStage = 'material-attachment-start';
    const reportStage = (stage, details = {}) => {
      draftPrepareStage = stage;
      const suffix = Object.keys(details).length ? ` ${JSON.stringify(details)}` : '';
      console.log(`[RPA:${clean(this.spec.name || this.platformCode || 'platform')}] draft:${stage}${suffix}`);
    };

    try {
      reportStage('material-attachment-start', { uploadTimeoutMs });
      materialAttachment = await uploadFile(page, materialPath, this.spec, uploadTimeoutMs);
      if (!materialAttachment?.attached) throw new Error('等待发布页面加载超时，仍未找到可用的素材上传控件');
      reportStage('material-attachment-complete', { method: materialAttachment.method, attachAttempts: materialAttachment.attachAttempts, evidence: materialAttachment.evidence });

      const preparedTitle = constrainPlatformTitle(payload.title, this.spec.titleMaxLength, this.spec.titleUnsupportedPattern);
      const title = preparedTitle.value;
      reportStage('title-fill-start', { timeoutMs: metadataFieldTimeoutMs });
      const titleFilled = await fillFirstWithWait(page, this.spec.titleSelectors || [], this.spec.titleLabels || [], title, metadataFieldTimeoutMs);
      reportStage('title-fill-complete', { filled: titleFilled });
      const description = composePlatformPublishDescription(payload, { titleFilled });
      reportStage('caption-fill-start', { timeoutMs: metadataFieldTimeoutMs });
      const captionFilled = await fillFirstWithWait(page, this.spec.captionSelectors || [], this.spec.captionLabels || [], description, metadataFieldTimeoutMs);
      reportStage('caption-fill-complete', { filled: captionFilled });
      if (!titleFilled && !captionFilled) throw new Error('素材已选择，但等待后仍未找到标题/正文输入框，已停止在草稿页面');
      reportStage('declaration-start');
      const declaration = await this.applyContentDeclaration(page, payload);
      reportStage('declaration-complete', { applied: declaration?.applied === true });
      reportStage('upload-readiness-start', { timeoutMs: uploadTimeoutMs });
      const readiness = await this.waitForUploadAndPublishReady(page, uploadTimeoutMs, { allowDisabled: payload.publishMode !== 'AUTO' && !this.spec.draftRequiresPublishEnabled });
      reportStage('upload-readiness-complete', { ready: readiness?.ready === true });
      if (payload.publishMode !== 'AUTO' || payload.keepBrowserForeground === true) await page.bringToFront();
      return {
        materialAttachment,
        titleFilled,
        titleValue: titleFilled ? title : null,
        titleSanitized: titleFilled && preparedTitle.sanitized,
        titleTruncated: titleFilled && preparedTitle.truncated,
        titleOriginalLength: preparedTitle.originalLength,
        titleLength: titleFilled ? preparedTitle.length : 0,
        captionFilled,
        declaration,
        readiness
      };
    } catch (error) {
      // Preserve the upload evidence and exact preparation stage for platform-specific
      // reporting. A populated file input is not proof that the platform upload began.
      if (error && typeof error === 'object') {
        if (!error.materialAttachment && materialAttachment) error.materialAttachment = materialAttachment;
        if (!error.draftPrepareStage) error.draftPrepareStage = draftPrepareStage;
      }
      throw error;
    }
  }

  async waitForPublishSignal(page) {
    const deadline = Date.now() + this.sendTimeoutMs;
    while (Date.now() < deadline) {
      const url = page.url();
      const signalText = await visiblePublishSignalText(page);
      const pageText = this.spec.successTextScope === 'signals' ? '' : await bodyText(page);
      const evidence = reliablePublishSuccessEvidence({ url, signalText, pageText, spec: this.spec });
      if (evidence.confirmed) return { ...evidence, url, signalText: signalText.slice(0, 500) };
      await page.waitForTimeout(1000);
    }
    return { confirmed: false, source: null, url: page.url() };
  }

  async clickFinalPublish(page) {
    await this.assertRuntimeAllowed();
    if (!this.spec.strictPublishButton) {
      const clicked = await clickByLabels(page, this.spec.publishLabels || [], { enabled: true });
      return { clicked, primary: clicked ? 'CLICKED' : 'MISSING', confirmation: 'NOT_CONFIGURED' };
    }
    const primary = await findUniqueLabeledButton(page, this.spec.publishLabels || [], { enabled: true });
    if (primary.status !== 'UNIQUE') return { clicked: false, primary: primary.status, primaryCount: primary.count, confirmation: 'NOT_ATTEMPTED' };
    await primary.match.locator.click();
    await page.waitForTimeout(this.spec.publishConfirmationSettleMs || 500);
    const confirmationLabels = this.spec.publishConfirmLabels || [];
    if (!confirmationLabels.length) return { clicked: true, primary: 'CLICKED', confirmation: 'NOT_CONFIGURED' };
    const confirmation = await findUniqueLabeledButton(page, confirmationLabels, { enabled: true });
    if (confirmation.status === 'AMBIGUOUS') return { clicked: true, primary: 'CLICKED', confirmation: 'AMBIGUOUS', confirmationCount: confirmation.count };
    if (confirmation.status === 'UNIQUE') {
      await confirmation.match.locator.click();
      return { clicked: true, primary: 'CLICKED', confirmation: 'CLICKED', confirmationLabel: confirmation.match.label };
    }
    return { clicked: true, primary: 'CLICKED', confirmation: 'NOT_PRESENT' };
  }

  async preserveDraftForManualAction(page, payload, message, originalStage, extra = {}) {
    let draftSaved = false;
    let draftSaveMethod = null;
    let draftSaveError = null;
    if (page) {
      try {
        const saveControl = await findUniqueLabeledButton(page, this.spec.saveDraftLabels || ['保存草稿', '存草稿', '保存并退出'], { enabled: true });
        if (saveControl.status === 'UNIQUE') {
          await saveControl.match.locator.click();
          await page.waitForTimeout(this.spec.draftSaveSettleMs || 800);
          draftSaved = true;
          draftSaveMethod = saveControl.match.label;
        }
      } catch (error) {
        draftSaveError = error.message;
      }
    }
    const fallbackMessage = draftSaved
      ? `${message}；草稿已保存，请打开平台人工发布`
      : `${message}；当前浏览器/Profile 已保留，请打开平台检查草稿并人工发布`;
    return this.evidence(payload, fallbackMessage, page, draftSaved ? 'draft_saved_manual_required' : originalStage, {
      ...extra,
      originalStage,
      manualActionRequired: true,
      draftSaved,
      draftPreservedInBrowser: Boolean(page),
      draftSaveMethod,
      draftSaveError
    });
  }

  async publish(payload) {
    const materialPath = path.resolve(payload.materialPath || '');
    if (!fs.existsSync(materialPath)) return { status: 'FAILED', result: await this.evidence(payload, `本地素材不存在，无法准备${this.spec.name}草稿`, null, 'material_missing') };
    const page = await this.getPage();
    await page.goto(this.spec.publishUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    if (!await this.waitForReady(page)) return { status: 'NEEDS_CONFIRMATION', result: await this.evidence(payload, `等待人工登录${this.spec.name}超时；浏览器页面已保留`, page, 'login_required') };
    if (this.spec.publishPageSettleMs) await page.waitForTimeout(this.spec.publishPageSettleMs);
    let finalPublishCallEntered = false;
    try {
      const prepared = await this.prepareDraft(page, payload, materialPath);
      const draftEvidence = await this.evidence(payload, `${this.spec.name}草稿已准备完成`, page, 'draft_ready', prepared);
      if (payload.publishMode !== 'AUTO') return { status: 'NEEDS_CONFIRMATION', result: await this.preserveDraftForManualAction(page, payload, `${this.spec.name}草稿已准备，等待人工检查并提交`, 'draft_ready', prepared) };
      if (payload.managementConfirmed !== true) return { status: 'NEEDS_CONFIRMATION', result: await this.preserveDraftForManualAction(page, payload, `${this.spec.name}草稿已准备，但缺少本次最终发表确认，未点击发表`, 'draft_ready', { ...prepared, finalActionAuthorized: false }) };
      await this.assertRuntimeAllowed();
      finalPublishCallEntered = true;
      const clickResult = await this.clickFinalPublish(page);
      if (!clickResult.clicked) return { status: 'NEEDS_CONFIRMATION', result: await this.preserveDraftForManualAction(page, payload, `${this.spec.name}自动发布未成功：最终发表按钮不是唯一可用按钮，未执行点击`, 'publish_button_unavailable', { ...prepared, clickResult, submitAttempted: false }) };
      if (clickResult.confirmation === 'AMBIGUOUS') return { status: 'NEEDS_CONFIRMATION', result: await this.evidence(payload, `已点击${this.spec.name}发表入口，但二次确认按钮不唯一；为防止误操作或重复发布，请人工核对`, page, 'publish_confirmation_ambiguous', { clickResult, submitAttempted: true, manualActionRequired: true, draftSaved: false }) };
      const postClickText = await pageEvidenceText(page);
      if (VERIFY_RE.test(postClickText) || toRegex(this.spec.publishBlockedTextPattern, /$^/).test(postClickText)) {
        return { status: 'NEEDS_CONFIRMATION', result: await this.evidence(payload, `${this.spec.name}要求人工完成账号或安全验证，系统未绕过验证，也不会自动重试`, page, 'publish_verification_required', { clickResult, submitAttempted: true, manualActionRequired: true, draftSaved: false }) };
      }
      const publishSignal = await this.waitForPublishSignal(page);
      if (publishSignal.confirmed === true) return { status: 'SUCCESS', result: await this.evidence(payload, `${this.spec.name}发布已提交，并检测到平台成功信号`, page, 'published', { submissionStatus: 'SUBMITTED', publishSignal, clickResult }) };
      return { status: 'NEEDS_CONFIRMATION', result: await this.evidence(payload, `已点击${this.spec.name}发布，但未检测到可靠成功信号；为防止重复发布，请人工核对`, page, 'publish_unconfirmed', { submitAttempted: true, manualActionRequired: true, draftSaved: false, submissionStatus: 'UNKNOWN', publishSignal, clickResult }) };
    } catch (error) {
      if (['PLATFORM_STOPPED', 'PLATFORM_OPERATION_CANCELLED'].includes(error.code)) {
        if (error.writeAttempted == null) error.writeAttempted = finalPublishCallEntered;
        throw error;
      }
      if (error.code === 'PLATFORM_UPLOAD_FAILED') {
        return {
          status: 'FAILED',
          result: await this.evidence(payload, `${this.spec.name}视频尚未提交平台：上传过程中出现网络异常，请检查网络后重新发送`, page, 'upload_failed', {
            submitAttempted: false,
            submissionStatus: 'NOT_SUBMITTED',
            reviewStatus: 'UNKNOWN',
            uploadFailed: true,
            platformState: 'UPLOAD_FAILED',
            errorCode: error.code,
            platformMessage: error.platformMessage || null,
            retrySafe: true,
            safeToRetry: true,
            manualActionRequired: false,
            draftSaved: false,
            draftPreservedInBrowser: false
          })
        };
      }
      return { status: 'FAILED', result: await this.preserveDraftForManualAction(page, payload, `${this.spec.name}自动发布准备失败：${error.message}`, 'prepare_failed', { submitAttempted: false }) };
    }
  }

  async verifyPublish(payload) {
    const manageUrl = String(this.spec.manageUrl || '').trim();
    let manageTarget = null;
    try { manageTarget = new URL(manageUrl); } catch {}
    const manageHostAllowed = Boolean(manageTarget
      && manageTarget.protocol === 'https:'
      && (this.spec.hostHints || []).some(host => manageTarget.hostname === host || manageTarget.hostname.endsWith(`.${host}`)));
    if (!manageHostAllowed) {
      return {
        status: 'NEEDS_CONFIRMATION',
        result: await this.evidence(payload, `${this.spec.name}核验地址不属于当前平台，已停止状态读取`, null, 'verify_configuration_scope_mismatch', {
          reviewStatus: 'UNKNOWN',
          confidence: 'LOW',
          verificationPolicyId: this.spec.verificationPolicyId || null,
          configuredManageUrl: manageUrl || null,
          observedAt: new Date().toISOString()
        })
      };
    }
    const page = await this.getPage();
    await page.goto(manageUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    const state = await this.waitForDetectedPageState(page, this.spec.verifyReadyTimeoutMs || 5000);
    if (state !== 'READY') {
      const detail = state === 'LOGIN' ? `${this.spec.name}\u767b\u5f55\u5931\u6548\uff0c\u65e0\u6cd5\u590d\u6838\u53d1\u5e03\u72b6\u6001`
        : state === 'VERIFY_REQUIRED' ? `${this.spec.name}\u8981\u6c42\u4eba\u5de5\u5b8c\u6210\u5b89\u5168\u9a8c\u8bc1\uff0c\u65e0\u6cd5\u590d\u6838\u53d1\u5e03\u72b6\u6001`
          : state === 'ERROR' ? `${this.spec.name}\u9875\u9762\u5f02\u5e38\uff0c\u65e0\u6cd5\u590d\u6838\u53d1\u5e03\u72b6\u6001`
            : `${this.spec.name}\u7ba1\u7406\u9875\u5728\u7b49\u5f85\u65f6\u95f4\u5185\u672a\u5b8c\u6210\u52a0\u8f7d\uff0c\u65e0\u6cd5\u590d\u6838\u53d1\u5e03\u72b6\u6001`;
      return { status: 'NEEDS_CONFIRMATION', result: await this.evidence(payload, detail, page, state === 'LOGIN' ? 'verify_login_required' : state === 'VERIFY_REQUIRED' ? 'verify_verification_required' : state === 'ERROR' ? 'verify_page_error' : 'verify_page_not_ready', { pageState: state, reviewStatus: 'UNKNOWN', confidence: 'LOW', verificationPolicyId: this.spec.verificationPolicyId || null, observedAt: new Date().toISOString() }) };
    }
    const verifyPagePattern = toRegex(this.spec.verifyPageUrlPattern, null);
    const currentVerifyUrl = typeof page?.url === 'function'
      ? page.url()
      : manageUrl;
    const verifyPageMatched = Boolean(verifyPagePattern && new RegExp(verifyPagePattern.source, verifyPagePattern.flags.replace('g', '')).test(currentVerifyUrl));
    if (!verifyPageMatched) {
      return {
        status: 'NEEDS_CONFIRMATION',
        result: await this.evidence(payload, `${this.spec.name}当前页面不是该平台自己的投稿管理页，已停止状态读取`, page, 'verify_platform_scope_mismatch', {
          reviewStatus: 'UNKNOWN',
          confidence: 'LOW',
          verificationPolicyId: this.spec.verificationPolicyId || null,
          configuredManageUrl: manageUrl,
          currentVerifyUrl,
          observedAt: new Date().toISOString()
        })
      };
    }
    const title = constrainPlatformTitle(payload.title, this.spec.titleMaxLength, this.spec.titleUnsupportedPattern).value;
    const lookupOptions = { platformCode: this.platformCode, body: payload.body || '', submittedAt: payload.submittedAt || '', spec: this.spec };
    let reviewStatus = 'UNKNOWN';
    let matchedRecord = null;
    let matchedTab = null;
    const directRecordDeadline = Date.now() + Number(this.spec.verifyRecordTimeoutMs || 2000);
    do {
      matchedRecord = await findVisibleTitleRecord(page, title, lookupOptions);
      if (matchedRecord || Date.now() >= directRecordDeadline) break;
      await page.waitForTimeout(500);
    } while (Date.now() < directRecordDeadline);
    reviewStatus = matchedRecord?.reviewStatus || classifyManagementReviewEvidence({ title, body: payload.body, recordText: matchedRecord?.text || '', href: matchedRecord?.href, submittedAt: payload.submittedAt, platformCode: this.platformCode, spec: this.spec });
    for (const tab of reviewStatus === 'UNKNOWN' && !matchedRecord?.ambiguous ? (this.spec.verifyTabs || []) : []) {
      const found = await findLabeledControl(page, tab.labels || [tab.label], { enabled: true });
      if (!found) continue;
      await found.locator.click().catch(() => {});
      await page.waitForTimeout(1200);
      const recordDeadline = Date.now() + Number(this.spec.verifyRecordTimeoutMs || 2000);
      let record = null;
      do {
        record = await findVisibleTitleRecord(page, title, { ...lookupOptions, tabStatus: tab.reviewStatus });
        if (record || Date.now() >= recordDeadline) break;
        await page.waitForTimeout(500);
      } while (Date.now() < recordDeadline);
      const classified = record?.reviewStatus || classifyManagementReviewEvidence({ title, body: payload.body, recordText: record?.text || '', href: record?.href, submittedAt: payload.submittedAt, tabStatus: tab.reviewStatus, platformCode: this.platformCode, spec: this.spec });
      if (classified === 'UNKNOWN') continue;
      reviewStatus = classified;
      matchedRecord = record;
      matchedTab = tab.label;
      break;
    }
    if (reviewStatus === 'UNKNOWN' && !matchedRecord?.ambiguous) {
      matchedRecord = await findVisibleTitleRecord(page, title, lookupOptions);
      reviewStatus = matchedRecord?.reviewStatus || classifyManagementReviewEvidence({ title, body: payload.body, recordText: matchedRecord?.text || '', href: matchedRecord?.href, submittedAt: payload.submittedAt, platformCode: this.platformCode, spec: this.spec });
    }

    const observedAt = new Date().toISOString();
    const submissionPreviouslyConfirmed = payload.submissionConfirmed === true || String(payload.submissionStatus || '').toUpperCase() === 'SUBMITTED';
    const syncPending = reviewStatus === 'UNKNOWN' && !matchedRecord?.ambiguous && Boolean(payload.submittedAt)
      && submissionPreviouslyConfirmed && payload.reconciliationMode !== 'PRE_SUBMIT';
    if (syncPending) reviewStatus = 'SYNCING';
    const message = reviewStatus === 'PUBLISHED' ? `${this.spec.name}\u5185\u5bb9\u5df2\u5728\u201c${matchedTab || '\u7ba1\u7406\u9875'}\u201d\u627e\u5230\u5e76\u786e\u8ba4\u53d1\u5e03`
      : reviewStatus === 'REJECTED' ? `${this.spec.name}\u5185\u5bb9\u5df2\u5728\u201c${matchedTab || '\u7ba1\u7406\u9875'}\u201d\u627e\u5230\u5e76\u786e\u8ba4\u5ba1\u6838\u672a\u901a\u8fc7`
        : reviewStatus === 'REVIEWING' ? `${this.spec.name}\u5185\u5bb9\u5df2\u5728\u201c${matchedTab || '\u7ba1\u7406\u9875'}\u201d\u627e\u5230\uff0c\u4ecd\u5728\u5ba1\u6838\u6216\u5904\u7406\u4e2d`
          : reviewStatus === 'SYNCING' ? `${this.spec.name}\u5df2\u63d0\u4ea4\uff0c\u7ba1\u7406\u9875\u6682\u672a\u540c\u6b65\u5230\u76ee\u6807\u8bb0\u5f55\uff0c\u5c06\u7ee7\u7eed\u590d\u6838\uff0c\u4e0d\u4f1a\u91cd\u590d\u6295\u7a3f`
            : matchedRecord?.ambiguous ? `${this.spec.name}\u7ba1\u7406\u9875\u627e\u5230 ${matchedRecord.candidateCount} \u6761\u5019\u9009\u8bb0\u5f55\uff0c\u65e0\u6cd5\u552f\u4e00\u590d\u6838`
              : `${this.spec.name}\u7ba1\u7406\u9875\u672a\u627e\u5230\u6807\u9898\u5339\u914d\u7684\u53ef\u9760\u53d1\u5e03\u8bb0\u5f55`;
    const status = ['UNKNOWN'].includes(reviewStatus) ? 'NEEDS_CONFIRMATION' : 'SUCCESS';
    const confidence = matchedRecord?.confidence || (reviewStatus === 'SYNCING' ? 'MEDIUM' : 'LOW');
    const platformUrl = matchedRecord?.platformUrl || matchedRecord?.href || null;
    const platformPostId = matchedRecord?.platformPostId || platformPostIdentity(this.platformCode, platformUrl);
    return {
      status,
      result: {
        ...(await this.evidence(payload, message, page, 'verify', { matchedTab, matchedRecord, verificationPolicyId: this.spec.verificationPolicyId || null })),
        verificationPolicyId: this.spec.verificationPolicyId || null,
        reviewStatus,
        submissionStatus: ['PUBLISHED', 'REVIEWING', 'SYNCING', 'REJECTED'].includes(reviewStatus)
          ? 'SUBMITTED'
          : (payload.submissionStatus || 'UNKNOWN'),
        syncPending,
        confidence,
        matchedBy: matchedRecord?.matchedBy || [],
        platformPostId,
        platformUrl,
        observedAt
      }
    };
  }


  messageCardSelectors(messageType) {
    const type = String(messageType || '').toUpperCase();
    return this.spec.messageCardSelectorsByType?.[type] || this.spec.messageCardSelectors || [];
  }

  async firstVisibleSelector(page, selectors = []) {
    if (typeof page?.locator !== 'function') return null;
    for (const selector of selectors) {
      const locator = page.locator(selector);
      if (typeof locator?.count !== 'function' || typeof locator?.nth !== 'function') continue;
      const count = Math.min(await locator.count().catch(() => 0), 50);
      for (let index = 0; index < count; index += 1) {
        if (await locator.nth(index).isVisible().catch(() => false)) return selector;
      }
    }
    return null;
  }

  async classifyLiveMessagePage(page, messageType, text = null) {
    const evidenceText = text == null ? await pageEvidenceText(page) : text;
    const base = classifyMessagePageEvidence({ messageType, url: page.url(), text: evidenceText, spec: this.spec });
    if (base.valid || base.reason === 'PAGE_ERROR' || base.reason === 'URL_MISMATCH') return base;
    const type = String(messageType || '').toUpperCase();
    const selectors = type === 'PRIVATE_MESSAGE'
      ? (this.spec.privateMessagePanelSelectors || [])
      : (this.spec.commentReadySelectors || []);
    const visibleSelector = await this.firstVisibleSelector(page, selectors);
    if (!visibleSelector) return base;
    return {
      valid: true,
      reason: 'VERIFIED_DOM',
      evidence: [...base.evidence.filter(item => item !== 'message-text-missing'), `message-dom:${visibleSelector}`]
    };
  }



  async waitForMessageContentReady(page, messageType, timeoutMs = 18000) {
    const type = String(messageType || '').toUpperCase();
    const effectiveTimeoutMs = this.platformCode === 'wechat_channels' && type === 'PRIVATE_MESSAGE' && timeoutMs === 18000 ? 60000 : timeoutMs;
    const deadline = Date.now() + effectiveTimeoutMs;
    const refreshPattern = /\u6682\u65e0\u8bc4\u8bba[\s\S]{0,120}\u70b9\u51fb\u5237\u65b0|\u70b9\u51fb\u5237\u65b0[\s\S]{0,120}\u6682\u65e0\u8bc4\u8bba/i;
    let lastCheck = null;
    let refreshEvidence = null;
    let recoveryEvidence = null;
    let wechatCommentEvidence = null;
    let wechatPrivateEvidence = null;
    let privateTerminalKey = '';
    let privateTerminalCount = 0;
    while (Date.now() < deadline) {
      const text = await pageEvidenceText(page);
      lastCheck = await this.classifyLiveMessagePage(page, type, text);
      if (!lastCheck.valid) {
        if (['PAGE_ERROR', 'URL_MISMATCH'].includes(lastCheck.reason)) return { ready: false, pageCheck: lastCheck, reason: lastCheck.reason, refreshEvidence };
        await page.waitForTimeout(700);
        continue;
      }
      if (type === 'PRIVATE_MESSAGE') {
        if (this.platformCode !== 'wechat_channels') return { ready: true, pageCheck: lastCheck, reason: 'PRIVATE_PANEL_READY' };
        const privateEvidence = await this.inspectWechatPrivateMessageState(page, text);
        const terminalKey = privateEvidence.ready ? `${privateEvidence.reason}:${privateEvidence.sessionCount}` : '';
        if (terminalKey && terminalKey === privateTerminalKey) privateTerminalCount += 1;
        else { privateTerminalKey = terminalKey; privateTerminalCount = terminalKey ? 1 : 0; }
        wechatPrivateEvidence = privateEvidence;
        if (privateEvidence.ready && (!privateEvidence.empty || privateTerminalCount >= 2)) {
          return { ready: true, pageCheck: lastCheck, reason: privateEvidence.reason, empty: privateEvidence.empty, privateEvidence };
        }
        await page.waitForTimeout(700);
        continue;
      }
      const rowSelector = await this.firstVisibleSelector(page, this.spec.commentReadySelectors || []);
      if (rowSelector) return { ready: true, pageCheck: lastCheck, reason: refreshEvidence?.loaded ? 'COMMENT_ROWS_READY_AFTER_REFRESH' : 'COMMENT_ROWS_READY', rowSelector, refreshEvidence };
      if (this.platformCode === 'wechat_channels') {
        wechatCommentEvidence = await this.inspectWechatCommentEmptyState(page, text);
        if (wechatCommentEvidence.confirmedEmpty) {
          return { ready: true, pageCheck: lastCheck, reason: wechatCommentEvidence.reason, empty: true, refreshEvidence, wechatCommentEvidence };
        }
        if (wechatCommentEvidence.reason === 'COMMENT_COUNTS_PRESENT') {
          return { ready: true, pageCheck: lastCheck, reason: wechatCommentEvidence.reason, empty: false, refreshEvidence, wechatCommentEvidence };
        }
      }
      if (this.platformCode === 'douyin' && refreshPattern.test(text)) {
        if (!refreshEvidence) refreshEvidence = await this.refreshDouyinCommentListIfOffered(page, { maxAttempts: 1, settleTimeoutMs: Math.min(5000, Math.max(1000, deadline - Date.now())) });
        if (refreshEvidence.loaded) return { ready: true, pageCheck: lastCheck, reason: 'COMMENT_ROWS_READY_AFTER_REFRESH', rowSelector: refreshEvidence.rowSelector, refreshEvidence, recoveryEvidence };
        if (refreshEvidence.stateCleared) {
          await page.waitForTimeout(500);
          continue;
        }
        if (!recoveryEvidence && refreshEvidence.clicked) {
          recoveryEvidence = await this.recoverDouyinCommentListAfterRefresh(page, { settleTimeoutMs: Math.min(5000, Math.max(1000, deadline - Date.now())), refreshOffered: refreshEvidence.offered, refreshClicked: refreshEvidence.clicked });
          if (recoveryEvidence.loaded) return { ready: true, pageCheck: recoveryEvidence.pageCheck || lastCheck, reason: recoveryEvidence.reason, rowSelector: recoveryEvidence.rowSelector, refreshEvidence, recoveryEvidence };
          if (recoveryEvidence.reason === 'COMMENT_EMPTY_CONFIRMED_AFTER_RELOAD') {
            return { ready: true, pageCheck: recoveryEvidence.pageCheck || lastCheck, reason: recoveryEvidence.reason, empty: true, refreshEvidence, recoveryEvidence };
          }
          if (recoveryEvidence.stateCleared) {
            await page.waitForTimeout(500);
            continue;
          }
        }
        return { ready: false, pageCheck: recoveryEvidence?.pageCheck || lastCheck, reason: recoveryEvidence?.reason || refreshEvidence.reason || 'COMMENT_REFRESH_UNRESOLVED', refreshEvidence, recoveryEvidence };
      }
      const emptyPattern = toRegex(this.spec.commentEmptyTextPattern, null);
      if (emptyPattern && emptyPattern.test(text)) return { ready: true, pageCheck: lastCheck, reason: 'COMMENT_EMPTY_CONFIRMED', refreshEvidence };
      await page.waitForTimeout(700);
    }
    return { ready: false, pageCheck: lastCheck || await this.classifyLiveMessagePage(page, type), reason: 'MESSAGE_CONTENT_TIMEOUT', refreshEvidence, recoveryEvidence, wechatCommentEvidence, privateEvidence: wechatPrivateEvidence };
  }
  async navigateMessagePageAttempt(page, item, attempt) {
    const startedAt = Date.now();
    const result = {
      attempt,
      requestedUrl: item.url,
      urlBefore: typeof page?.url === 'function' ? page.url() : null,
      finalUrl: null,
      status: 'SUCCESS',
      timeout: false,
      domReadable: false,
      pageCheck: null,
      elapsedMs: 0
    };
    try {
      await page.goto(item.url, { waitUntil: 'domcontentloaded', timeout: Number(this.spec.messageNavigationTimeoutMs || 30000) });
    } catch (error) {
      if (!isNavigationTimeoutError(error)) throw error;
      result.status = 'TIMEOUT_CONTINUING_WITH_PAGE_VERIFICATION';
      result.timeout = true;
      result.error = clean(error?.message || error).slice(0, 500);
    }
    await page.waitForTimeout(result.timeout ? 750 : 1500).catch(() => {});
    result.finalUrl = typeof page?.url === 'function' ? page.url() : null;
    const pageText = await pageEvidenceText(page).catch(() => '');
    result.domReadable = Boolean(clean(pageText));
    result.pageCheck = classifyMessagePageEvidence({
      messageType: item.type,
      url: result.finalUrl,
      text: pageText,
      spec: this.spec
    });
    result.elapsedMs = Date.now() - startedAt;
    return { result, pageText };
  }

  async prepareMessagePage(page, item) {
    if (item.type === 'PRIVATE_MESSAGE' && item.reuseCurrent && typeof page?.url === 'function') {
      const pageCheck = await this.classifyLiveMessagePage(page, item.type).catch(() => null);
      let inboxMatches = true;
      if (pageCheck?.valid && this.platformCode === 'douyin' && clean(item.inboxType || 'MAIN').toUpperCase() === 'MAIN') {
        const strangerView = await this.inspectDouyinStrangerInboxView(page).catch(() => null);
        inboxMatches = strangerView?.signalVisible === false;
      }
      if (pageCheck?.valid && inboxMatches) return {
        requestedUrl: item.url, attempts: 0, entryOpened: false, entryAction: 'already-open',
        firstUrl: page.url(), finalUrl: page.url(), attemptResults: [], timeoutCount: 0,
        degradedAfterTimeout: false, finalPageCheck: pageCheck, reusedCurrentPage: true
      };
    }
    const navigation = { requestedUrl: item.url, attempts: 1, entryOpened: false, firstUrl: null, finalUrl: null, attemptResults: [] };
    const firstNavigation = await this.navigateMessagePageAttempt(page, item, 1);
    navigation.attemptResults.push(firstNavigation.result);
    navigation.firstUrl = firstNavigation.result.finalUrl;

    if (item.type === 'COMMENT' && this.platformCode === 'douyin') {
      const firstText = firstNavigation.pageText;
      const firstCheck = firstNavigation.result.pageCheck
        || classifyMessagePageEvidence({ messageType: item.type, url: page.url(), text: firstText, spec: this.spec });
      const firstLogin = await this.inspectLoginState(page);
      const safeToRetry = !firstNavigation.result.timeout
        && !firstCheck.valid
        && !['LOGIN', 'VERIFY_REQUIRED'].includes(firstLogin.state)
        && firstCheck.reason !== 'PAGE_ERROR';
      if (safeToRetry) {
        navigation.attempts = 2;
        navigation.retryReason = firstCheck.reason;
        await page.waitForTimeout(800);
        const retryNavigation = await this.navigateMessagePageAttempt(page, item, 2);
        navigation.attemptResults.push(retryNavigation.result);
      }
    }

    if (item.type === 'PRIVATE_MESSAGE' && this.spec.privateMessageEntrySelectors?.length) {
      const deadline = Date.now() + 8_000;
      let waitAttempts = 0;
      while (Date.now() < deadline) {
        waitAttempts += 1;
        const currentText = await pageEvidenceText(page);
        const currentCheck = await this.classifyLiveMessagePage(page, item.type, currentText);
        if (currentCheck.valid) {
          navigation.entryAction = 'already-open';
          break;
        }
        const entry = await firstUsable(this.spec.privateMessageEntrySelectors.map(selector => page.locator(selector)));
        if (entry) {
          await entry.click();
          await page.waitForTimeout(1800);
          navigation.entryOpened = true;
          navigation.entryAction = 'clicked';
          break;
        }
        await page.waitForTimeout(1000);
      }
      navigation.entryWaitAttempts = waitAttempts;
      if (!navigation.entryAction) navigation.entryAction = 'entry-missing';
    }
    navigation.finalUrl = page.url();
    navigation.timeoutCount = navigation.attemptResults.filter(result => result.timeout).length;
    navigation.degradedAfterTimeout = navigation.timeoutCount > 0;
    navigation.finalPageCheck = item.type === 'PRIVATE_MESSAGE'
      ? await this.classifyLiveMessagePage(page, item.type)
      : navigation.attemptResults.at(-1)?.pageCheck || null;
    return navigation;
  }

  async inspectPrivateMessageCoverage(page) {
    if (!this.spec.privateStrangerBoxSelectors?.length) return { strangerInboxVisible: false, strangerUnread: false, evidence: [] };
    const visible = [];
    for (const selector of this.spec.privateStrangerBoxSelectors) {
      const boxes = page.locator(selector);
      const count = await boxes.count().catch(() => 0);
      for (let index = 0; index < count; index += 1) {
        const box = boxes.nth(index);
        if (!await box.isVisible().catch(() => false)) continue;
        const unread = await firstUsable((this.spec.privateUnreadSelectors || []).map(unreadSelector => box.locator(unreadSelector)));
        const unreadEvidence = unread ? await unread.evaluate(element => ({
          className: String(element.className || ''),
          text: String(element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim(),
          ariaLabel: element.getAttribute('aria-label'),
          title: element.getAttribute('title')
        })).catch(() => null) : null;
        visible.push({ selector, index, unread: Boolean(unread), unreadEvidence });
      }
    }
    if (visible.length !== 1) return {
      strangerInboxVisible: visible.length > 0,
      strangerUnread: false,
      ambiguous: visible.length > 1,
      visibleCount: visible.length,
      evidence: visible.length > 1 ? ['stranger-inbox-ambiguous'] : []
    };
    return {
      strangerInboxVisible: true,
      strangerUnread: visible[0].unread,
      unreadEvidence: visible[0].unreadEvidence,
      evidence: visible[0].unread ? ['stranger-inbox-visible', 'stranger-unread-indicator-visible'] : ['stranger-inbox-visible']
    };
  }

  async extractMessages(page, messageType, payload, { inboxType = 'MAIN', sourceContext = {}, scope = page } = {}) {
    const selectors = this.messageCardSelectors(messageType);
    if (!selectors.length) return [];
    const isPrivate = String(messageType).toUpperCase() === 'PRIVATE_MESSAGE';
    const candidates = [];
    for (const selector of selectors) {
      const rows = await scope.locator(selector).evaluateAll((elements, options) => elements.slice(0, 50).map((element, index) => {
        const visible = getComputedStyle(element).display !== 'none'
          && getComputedStyle(element).visibility !== 'hidden'
          && Number(getComputedStyle(element).opacity || 1) > 0
          && element.getClientRects().length > 0;
        if (!visible) return null;
        const pick = selectorsToTry => selectorsToTry.map(item => element.querySelector(item)).find(Boolean) || null;
        const unreadNode = pick(options.unreadSelectors);
        const unread = Boolean(unreadNode && getComputedStyle(unreadNode).display !== 'none'
          && getComputedStyle(unreadNode).visibility !== 'hidden'
          && unreadNode.getClientRects().length > 0);
        if (options.isPrivate) {
          if (options.platformCode === 'douyin') {
            const strangerList = element.closest?.('.conversationStrangerConversationListlistWrapper,[class*="conversationStrangerConversationListlistWrapper"]');
            const strangerEntry = element.closest?.('[class*="conversationStrangerBoxwrapper"]');
            if (options.inboxType === 'MAIN' && (strangerList || strangerEntry)) return null;
            if (options.inboxType === 'STRANGER' && !strangerList) return null;
          }
          const nameNode = pick(options.nameSelectors);
          const contentNode = pick(options.contentSelectors);
          const timeNode = pick(options.timeSelectors);
          const conversationKey = element.getAttribute('data-conversation-id')
            || element.getAttribute('data-conversationid')
            || element.getAttribute('data-session-id')
            || element.getAttribute('data-sessionid')
            || element.getAttribute('data-chat-id')
            || element.getAttribute('data-chatid')
            || element.getAttribute('data-id')
            || element.getAttribute('id')
            || null;
          return {
            index,
            text: (contentNode?.innerText || contentNode?.textContent || '').replace(/\s+/g, ' ').trim(),
            href: null,
            userName: (nameNode?.innerText || nameNode?.textContent || '').replace(/\s+/g, ' ').trim(),
            eventTime: timeNode?.getAttribute('datetime') || (timeNode?.innerText || timeNode?.textContent || '').trim(),
            unread,
            unreadEvidence: unread ? `${String(unreadNode.className || '').trim()} ${String(unreadNode.innerText || unreadNode.textContent || '').trim()}`.trim() : null,
            unreadCount: unread ? (Number.parseInt(String(unreadNode.innerText || unreadNode.textContent || '').trim(), 10) || 1) : 0,
            conversationKey,
            type: options.messageType
          };
        }
        const link = element.querySelector('a[href]');
        if (options.structuredComment) {
          const contentNode = element.querySelector(options.commentTextSelector);
          const userNode = element.querySelector(options.commentNameSelector);
          const timeNode = element.querySelector(options.commentTimeSelector);
          const identityNodes = [];
          for (let node = element, depth = 0; node && depth < 12; node = node.parentElement, depth += 1) identityNodes.push(node);
          const firstStableAttribute = names => {
            for (const node of identityNodes) {
              for (const name of names) {
                const value = String(node.getAttribute?.(name) || '').trim();
                if (value && !/^(?:true|false|0|1)$/.test(value)) return value;
              }
            }
            return '';
          };
          const reactIdentity = (() => {
            const result = {};
            const wanted = new Map([
              ['comment_id', 'commentStableId'], ['commentid', 'commentStableId'], ['cid', 'commentStableId'],
              ['item_id_plain', 'sourceVideoKey'], ['aweme_id', 'sourceVideoKey'], ['video_id', 'sourceVideoKey'],
              ['item_id', 'sourceVideoOpaqueKey'], ['item_link', 'sourceVideoUrl'],
              ['title', 'sourceVideoTitle'], ['create_time', 'sourceVideoPublishedAt']
            ]);
            const seen = new WeakSet();
            const assignPrimitive = (key, value) => {
              const target = wanted.get(String(key || '').toLowerCase());
              if (!target || result[target] || !['string', 'number'].includes(typeof value)) return;
              const normalized = String(value || '').trim();
              if (normalized && !/^(?:true|false|0|1)$/.test(normalized)) result[target] = normalized;
            };
            const inspect = (value, depth = 0) => {
              if (!value || depth > 7 || (typeof value !== 'object' && typeof value !== 'function') || seen.has(value)) return;
              seen.add(value);
              for (const [key, child] of Object.entries(value)) {
                if (['return', 'child', 'sibling', 'stateNode', '_owner'].includes(key)) continue;
                assignPrimitive(key, child);
                if (key === 'key' && typeof child === 'string' && child.trim().startsWith('{')) {
                  try { inspect(JSON.parse(child), depth + 1); } catch {}
                }
                if (depth < 2 || /props|item|video|comment|data|state|key/i.test(key)) inspect(child, depth + 1);
              }
            };
            for (const node of identityNodes) {
              const fiberName = Object.getOwnPropertyNames(node).find(key => key.startsWith('__reactFiber$'));
              let fiber = fiberName ? node[fiberName] : null;
              for (let depth = 0; fiber && depth < 12; depth += 1, fiber = fiber.return) inspect(fiber, 0);
            }
            if (!result.sourceVideoKey && result.sourceVideoOpaqueKey) result.sourceVideoKey = result.sourceVideoOpaqueKey;
            return result;
          })();
          const vueIdentity = (() => {
            const vm = element.__vue__;
            const dataSource = vm?.dataSource || vm?._props?.dataSource || vm?.$props?.dataSource || vm?.$options?.propsData?.dataSource;
            const store = vm?.store || vm?._props?.store || vm?.$props?.store || vm?.$options?.propsData?.store;
            const stringId = value => value === null || value === undefined ? '' : String(value).trim();
            const commentIds = [dataSource?.commentId, vm?.$props?.dataSource?.commentId, vm?.$options?.propsData?.dataSource?.commentId, vm?.$vnode?.key, vm?.$vnode?.data?.key]
              .map(stringId).filter(Boolean);
            const objectId = stringId(store?.currentFeed?.objectId);
            const exportId = stringId(store?.currentFeed?.exportId);
            const currentExportId = stringId(store?.currentExportId);
            const sourceVideoKey = currentExportId || objectId || exportId;
            const storeCommentIds = Array.isArray(store?.commentList) ? store.commentList.map(item => stringId(item?.commentId)).filter(Boolean) : [];
            const commentStableId = commentIds[0] || '';
            const commentIdentityConsistent = commentIds.length >= 3 && commentIds.every(value => value === commentStableId);
            const workIdentityConsistent = Boolean(objectId && exportId && currentExportId && objectId === exportId && objectId === currentExportId);
            return {
              commentStableId,
              sourceVideoKey,
              sourceVideoOpaqueKey: stringId(store?.currentFeed?.objectNonce),
              sourceVideoPublishedAt: stringId(store?.currentFeed?.createTime),
              actorPlatformId: stringId(dataSource?.username),
              commentCreateTime: stringId(dataSource?.commentCreatetime),
              sourceVerified: Boolean(commentStableId && sourceVideoKey && commentIdentityConsistent && workIdentityConsistent && storeCommentIds.includes(commentStableId) && store?.isFeedLoading !== true && store?.isCommentLoading !== true)
            };
          })();
          const commentStableId = firstStableAttribute(['data-comment-id', 'data-commentid', 'data-cid']) || vueIdentity.commentStableId || reactIdentity.commentStableId || '';
          const sourceVideoKey = firstStableAttribute(['data-aweme-id', 'data-item-id', 'data-video-id', 'data-group-id', 'data-object-id']) || vueIdentity.sourceVideoKey || reactIdentity.sourceVideoKey || '';
          const badgeText = options.commentSelfBadgeSelectors
            .map(selector => element.querySelector(selector))
            .filter(Boolean)
            .map(node => String(node.innerText || node.textContent || '').replace(/\s+/g, ' ').trim())
            .filter(Boolean)
            .join(' ');
          const explicitSelfValue = [element.getAttribute('data-is-self'), element.getAttribute('data-self'), element.getAttribute('data-owner'), element.getAttribute('data-author')]
            .map(value => String(value || '').trim().toLowerCase())
            .find(value => ['1', 'true', 'self', 'owner', 'author', 'creator'].includes(value));
          const direction = element.getAttribute('data-direction') || element.getAttribute('data-message-direction') || null;
          const visibleNode = node => {
            if (!node) return false;
            const style = getComputedStyle(node);
            const rects = typeof node.getClientRects === 'function' ? node.getClientRects() : [];
            return style.display !== 'none'
              && style.visibility !== 'hidden'
              && Number(style.opacity || 1) > 0
              && rects.length > 0;
          };
          const nodeText = node => String(node?.innerText || node?.textContent || '').replace(/\s+/g, ' ').trim();
          const queryAll = (root, selector) => typeof root?.querySelectorAll === 'function' ? [...root.querySelectorAll(selector)] : [];
          const visibleChildren = node => Array.from(node?.children || []).filter(visibleNode);
          const threadControls = queryAll(element, '*')
            .filter(visibleNode)
            .map(node => ({ node, text: nodeText(node) }))
            .filter(item => /^(?:展开\s*\d+\s*条回复|收起回复)$/.test(item.text))
            .filter(item => !visibleChildren(item.node).some(child => nodeText(child) === item.text));
          const expandControls = threadControls.filter(item => /^展开\s*\d+\s*条回复$/.test(item.text));
          const collapseControls = threadControls.filter(item => /^收起回复$/.test(item.text));
          const collapsedReplyCount = expandControls.reduce((maximum, item) => {
            const matched = item.text.match(/(\d+)/);
            return Math.max(maximum, Number(matched?.[1] || 0));
          }, 0);
          const nestedReplyRows = queryAll(element, options.commentRowSelector || '[class*="cmt-li-"]')
            .filter(node => node !== element && visibleNode(node));
          const authorBadges = queryAll(element, '*')
            .filter(node => visibleNode(node) && nodeText(node) === '作者')
            .filter(node => !visibleChildren(node).some(child => nodeText(child) === '作者'));
          const authorReplies = [];
          const authorReplyKeys = new Set();
          for (const badge of authorBadges) {
            let replyRoot = badge;
            let replyContentNode = null;
            for (let depth = 0; replyRoot && replyRoot !== element && depth < 10; depth += 1, replyRoot = replyRoot.parentElement) {
              const textNodes = queryAll(replyRoot, options.commentTextSelector).filter(node => node !== contentNode && visibleNode(node));
              if (textNodes.length === 1) { replyContentNode = textNodes[0]; break; }
            }
            if (!replyContentNode || !replyRoot || replyRoot === element || (typeof element.contains === 'function' && !element.contains(replyRoot))) continue;
            const replyText = nodeText(replyContentNode);
            if (!replyText) continue;
            const replyUserNode = replyRoot.querySelector(options.commentNameSelector);
            const key = [nodeText(replyUserNode), replyText].join('|');
            if (authorReplyKeys.has(key)) continue;
            authorReplyKeys.add(key);
            authorReplies.push({ userName: nodeText(replyUserNode) || null, text: replyText });
          }
          const replyThreadCollapsed = expandControls.length > 0;
          const replyThreadExpanded = collapseControls.length > 0;
          return {
            index,
            text: (contentNode?.innerText || contentNode?.textContent || '').replace(/\s+/g, ' ').trim(),
            href: link?.href || null,
            userName: (userNode?.innerText || userNode?.textContent || '').replace(/\s+/g, ' ').trim(),
            eventTime: timeNode?.getAttribute('datetime') || (timeNode?.innerText || timeNode?.textContent || '').trim(),
            unread: null,
            unreadEvidence: null,
            conversationKey: null,
            commentStableId: commentStableId || null,
            sourceVideoKey: sourceVideoKey || null,
            sourceVideoOpaqueKey: vueIdentity.sourceVideoOpaqueKey || reactIdentity.sourceVideoOpaqueKey || null,
            sourceVideoUrl: reactIdentity.sourceVideoUrl || null,
            sourceVideoTitle: reactIdentity.sourceVideoTitle || null,
            sourceVideoPublishedAt: vueIdentity.sourceVideoPublishedAt || reactIdentity.sourceVideoPublishedAt || null,
            actorPlatformId: vueIdentity.actorPlatformId || null,
            commentCreateTime: vueIdentity.commentCreateTime || null,
            sourceVerified: vueIdentity.sourceVerified === true,
            containerClassName: String(element.className || ''),
            badgeText,
            direction,
            actorIsSelf: Boolean(explicitSelfValue) || /^(?:\u4f5c\u8005|\u535a\u4e3b|UP\u4e3b|\u81ea\u5df1|\u672c\u4eba|\u4e3b\u53f7)$/.test(badgeText),
            replyThreadCollapsed,
            collapsedReplyCount,
            replyThreadExpanded,
            nestedReplyCount: nestedReplyRows.length,
            platformAuthorReplyDetected: authorReplies.length > 0,
            platformAuthorReplyText: authorReplies[0]?.text || null,
            platformAuthorReplyUserName: authorReplies[0]?.userName || null,
            type: options.messageType
          };
        }
        const text = (element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim();
        const userNode = element.querySelector('[class*="user" i],[class*="name" i],[data-e2e*="user" i],strong,b');
        const timeNode = element.querySelector('time,[class*="time" i]');
        return {
          index,
          text,
          href: link?.href || null,
          userName: (userNode?.innerText || userNode?.textContent || '').replace(/\s+/g, ' ').trim(),
          eventTime: timeNode?.getAttribute('datetime') || (timeNode?.innerText || timeNode?.textContent || '').trim(),
          unread: null,
          unreadEvidence: null,
          conversationKey: null,
          type: options.messageType
        };
      }), {
        isPrivate,
        structuredComment: (this.platformCode === 'douyin' || Boolean(this.spec.strictCommentIdentity)) && String(messageType).toUpperCase() === 'COMMENT',
        commentNameSelector: this.spec.commentNameSelector || 'h4[class*="cmt-name-"]',
        commentTextSelector: this.spec.commentTextSelector || 'pre[class*="cmt-text-"]',
        commentTimeSelector: this.spec.commentTimeSelector || 'p[class*="cmt-time-"]',
        commentSelfBadgeSelectors: this.spec.commentSelfBadgeSelectors || ['[data-is-self="true"]', '[class*="author-badge" i]', '[class*="creator-badge" i]', '[class*="owner-badge" i]'],
        commentRowSelector: this.spec.commentRowSelector || '[class*="cmt-li-"]',
        messageType,
        platformCode: this.platformCode,
        inboxType,
        unreadSelectors: this.spec.privateUnreadSelectors || [],
        nameSelectors: this.spec.privateConversationNameSelectors || [],
        contentSelectors: this.spec.privateConversationContentSelectors || [],
        timeSelectors: this.spec.privateConversationTimeSelectors || [],
        expectedSourceVideoKey: clean(sourceContext.sourceVideoKey) || null
      }).catch(() => []);
      const validRows = rows.filter(Boolean).filter(item => item.text.length >= 2
        && (!isPrivate || (item.unread && item.userName))
        && (!isPrivate || !/\u5bf9\u65b9\u56de\u590d\u6216\u5173\u6ce8\u4f60\u4e4b\u524d/.test(item.text)));
      if (validRows.length) { candidates.push(...validRows); break; }
    }
    const observedAt = new Date();
    return candidates.map(item => {
      const content = clean(item.text).slice(0, 1000);
      const externalUrl = item.href || page.url();
      const privateOccurrenceAnchor = this.platformCode === 'douyin' && isPrivate
        ? douyinPrivateOccurrenceAnchor(item.eventTime, observedAt)
        : null;
      const commentSourceKey = clean(item.commentStableId) || clean(item.sourceVideoKey) || clean(sourceContext.sourceVideoKey);
      const commentOccurrenceAnchor = this.platformCode === 'douyin' && !isPrivate
        ? douyinCommentOccurrenceAnchor(item.eventTime, observedAt)
        : null;
      const stableParts = isPrivate
        ? (this.platformCode === 'douyin'
            ? [externalUrl, item.userName, content, item.conversationKey, privateOccurrenceAnchor]
            : [externalUrl, inboxType, item.userName, content, item.eventTime, item.conversationKey])
        : (this.platformCode === 'douyin'
            ? [externalUrl, commentSourceKey || commentOccurrenceAnchor, item.userName, content]
            : (this.spec.strictCommentIdentity && clean(item.commentStableId) && (clean(item.sourceVideoKey) || clean(sourceContext.sourceVideoKey))
                ? [externalUrl, clean(item.sourceVideoKey) || clean(sourceContext.sourceVideoKey), clean(item.commentStableId)]
                : [externalUrl, clean(sourceContext.sourceVideoKey), item.userName, content, item.eventTime]));
      return {
        messageType,
        externalId: `${this.platformCode}-${messageType.toLowerCase()}-${digest(stableParts)}`,
        userName: clean(item.userName) || '\u672a\u77e5\u7528\u6237',
        content,
        externalUrl,
        context: {
          platformCode: this.platformCode,
          sourcePage: page.url(),
          eventTime: clean(item.eventTime) || null,
          selectorVersion: isPrivate
            ? (this.platformCode === 'douyin' ? 'douyin-web-im-2026.08.06.6' : `${this.platformCode}-web-im-2026.08.06.1`)
            : (this.platformCode === 'douyin'
                ? 'douyin-comment-2026.08.06.2'
                : (this.spec.strictCommentIdentity ? `${this.platformCode}-comment-2026.08.07.2` : 'assisted-2026.08.04.1')),
          rawText: content,
          ...(!isPrivate ? sourceContext : {}),
          ...(!isPrivate ? {
            actorUserName: clean(item.userName) || null,
            actorPlatformId: clean(item.actorPlatformId) || null,
            commentCreateTime: clean(item.commentCreateTime) || null,
            accountPlatformId: clean(sourceContext.accountPlatformId) || null,
            accountUserName: clean(sourceContext.accountUserName) || null,
            accountIdentitySource: clean(sourceContext.accountIdentitySource) || null,
            direction: clean(item.direction) || null,
            actorBadge: clean(item.badgeText) || null,
            actorIsSelf: item.actorIsSelf === true ? true : null
          } : {}),
          noteCandidates: payload.noteCandidates || [],
          ...(!isPrivate ? {
            commentRowIndex: Number.isInteger(item.index) ? item.index : null,
            commentStableId: clean(item.commentStableId) || null,
            sourceVideoKey: clean(item.sourceVideoKey) || clean(sourceContext.sourceVideoKey) || null,
            sourceVideoOpaqueKey: clean(item.sourceVideoOpaqueKey) || clean(sourceContext.sourceVideoOpaqueKey) || null,
            sourceVideoUrl: clean(item.sourceVideoUrl) || clean(sourceContext.sourceVideoUrl) || null,
            sourceVideoTitle: clean(item.sourceVideoTitle) || clean(sourceContext.sourceVideoTitle) || null,
            sourceVideoPublishedAt: clean(item.sourceVideoPublishedAt) || clean(sourceContext.sourceVideoPublishedAt) || null,
            sourceVerified: this.platformCode === 'wechat_channels'
              ? Boolean(
                  clean(item.commentStableId)
                  && clean(item.sourceVideoKey)
                  && clean(sourceContext.sourceVideoKey)
                  && clean(item.sourceVideoKey) === clean(sourceContext.sourceVideoKey)
                  && (item.sourceVerified === true || sourceContext.sourceVerified === true)
                )
              : (Boolean(
                  clean(item.commentStableId)
                  && (clean(item.sourceVideoKey) || clean(sourceContext.sourceVideoKey))
                  && /creator\.douyin\.com\/creator-micro\/data\/following\/comment/i.test(page.url())
                ) || sourceContext.sourceVerified === true),
            occurrenceAnchor: commentOccurrenceAnchor,
            replyThreadCollapsed: item.replyThreadCollapsed === true,
            collapsedReplyCount: Math.max(0, Number(item.collapsedReplyCount) || 0),
            replyThreadExpanded: item.replyThreadExpanded === true,
            nestedReplyCount: Math.max(0, Number(item.nestedReplyCount) || 0),
            platformAuthorReplyDetected: item.platformAuthorReplyDetected === true,
            platformAuthorReplyText: clean(item.platformAuthorReplyText) || null,
            platformAuthorReplyUserName: clean(item.platformAuthorReplyUserName) || null,
            replyThreadVerification: item.platformAuthorReplyDetected === true ? 'VERIFIED_AUTHOR_REPLY' : null,
            commentContainerClassName: clean(item.containerClassName) || null,
            commentFingerprint: digest([item.userName, content, item.eventTime])
          } : {}),
          ...(isPrivate ? {
            unread: true,
            unreadCount: Math.max(1, Number(item.unreadCount) || 1),
            unreadEvidence: clean(item.unreadEvidence) || 'visible-unread-badge',
            inboxType,
            conversationName: clean(item.userName),
            conversationKey: clean(item.conversationKey) || null,
            occurrenceAnchor: privateOccurrenceAnchor,
            previewOnly: true
          } : {})
        }
      };
    });
  }

  async advanceHistoricalCommentList(page, { selectors = [], settleMs = 200 } = {}) {
    await this.assertRuntimeAllowed();
    if (!page) return { attempted: false, moved: false, verifiedList: false, reason: 'PAGE_MISSING' };
    const broadSelectorPattern = /(?:\[class\*=["']?(?:scroll|list|container|wrapper)|(?:^|[\s.#>+~])(?:feeds-container|wbpro-scroller)(?:$|[\s.#>+~:[\]])|(?:scroll|scroller|container|wrapper)(?:["'\]\s.#>:]|$))/i;
    const rowSelectors = [...new Set([...selectors, ...(this.spec.commentScrollSelectors || [])].filter(selector => selector && !broadSelectorPattern.test(selector)))];
    const fallbackSelectors = ['.feeds-container', '.wbpro-scroller', '[class*="scroll"]', '[class*="list"]']
      .filter(selector => !rowSelectors.includes(selector));
    const candidates = [
      ...rowSelectors.map(selector => ({ selector, trusted: true })),
      ...fallbackSelectors.map(selector => ({ selector, trusted: false }))
    ];
    if (typeof page.evaluate !== 'function') return { attempted: false, moved: false, verifiedList: false, reason: 'PAGE_EVALUATE_UNAVAILABLE' };
    const inspect = (options) => page.evaluate(({ entries, proofSelectors, confirm }) => {
      const visible = element => {
        if (!element) return false;
        const style = getComputedStyle(element);
        return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) > 0 && element.getClientRects().length > 0;
      };
      const scrollable = element => visible(element) && element.scrollHeight > element.clientHeight + 4;
      const blockerVisible = root => {
        const nodes = [...root.querySelectorAll('[aria-busy="true"],[class*="loading"],[class*="spinner"],[class*="load-more"],[class*="loadMore"],[class*="load_more"],button')];
        return nodes.some(node => visible(node) && (/loading|spinner|load-more|loadmore|load_more/i.test(String(node.className || '')) || /加载中|正在加载|加载更多|展开更多|更多评论|load more|loading/i.test(String(node.innerText || node.textContent || ''))));
      };
      const rowSnapshot = root => {
        const rows = [];
        for (const selector of proofSelectors) {
          let elements = [];
          try { elements = [...document.querySelectorAll(selector)]; } catch {}
          elements.forEach((element, index) => {
            if (!root.contains(element) || !visible(element)) return;
            const key = element.getAttribute('data-id') || element.getAttribute('data-key') || element.id || '';
            const text = String(element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 180);
            rows.push(`${selector}:${index}:${key}:${text}`);
          });
        }
        return [...new Set(rows)].sort();
      };
      const snapshot = node => {
        const rows = rowSnapshot(node);
        return {
          scrollTop: node.scrollTop,
          scrollHeight: node.scrollHeight,
          clientHeight: node.clientHeight,
          atEnd: node.scrollTop + node.clientHeight >= node.scrollHeight - 4,
          visibleRowCount: rows.length,
          visibleRowSignature: rows.join('|'),
          loadingOrLoadMoreVisible: blockerVisible(node)
        };
      };
      const resolveConfirmedNode = () => {
        if (!confirm) return null;
        let elements = [];
        try { elements = [...document.querySelectorAll(confirm.selector)]; } catch {}
        let node = elements[confirm.elementIndex] || null;
        for (let depth = 0; node && depth < confirm.ancestorDepth; depth += 1) node = node.parentElement;
        return node && scrollable(node) ? node : null;
      };
      if (confirm) {
        const node = resolveConfirmedNode();
        if (!node) return { attempted: true, moved: false, verifiedList: false, reason: 'LIST_CONFIRMATION_CONTAINER_CHANGED' };
        return { attempted: true, moved: false, verifiedList: false, ...snapshot(node), selector: confirm.selector, elementIndex: confirm.elementIndex, ancestorDepth: confirm.ancestorDepth };
      }
      for (const entry of entries) {
        let elements = [];
        try { elements = [...document.querySelectorAll(entry.selector)]; } catch {}
        for (let elementIndex = 0; elementIndex < elements.length; elementIndex += 1) {
          let node = elements[elementIndex];
          for (let ancestorDepth = 0; node && ancestorDepth < 6; ancestorDepth += 1, node = node.parentElement) {
            if (!scrollable(node)) continue;
            const before = node.scrollTop;
            node.scrollTop = Math.min(node.scrollHeight, before + Math.max(240, node.clientHeight * 0.8));
            const state = snapshot(node);
            return {
              attempted: true,
              moved: node.scrollTop > before,
              verifiedList: false,
              proofCandidate: entry.trusted === true && state.atEnd && state.visibleRowCount > 0 && !state.loadingOrLoadMoreVisible,
              selector: entry.selector,
              elementIndex,
              ancestorDepth,
              before,
              after: node.scrollTop,
              ...state,
              reason: node.scrollTop > before ? 'SCROLLED_CONTAINER' : 'CONTAINER_AT_END_PENDING_CONFIRMATION'
            };
          }
        }
      }
      const root = document.scrollingElement || document.documentElement;
      if (!root) return { attempted: false, moved: false, verifiedList: false, reason: 'SCROLL_ROOT_MISSING' };
      const before = root.scrollTop;
      root.scrollTop = Math.min(root.scrollHeight, before + Math.max(320, window.innerHeight * 0.8));
      return { attempted: true, moved: root.scrollTop > before, verifiedList: false, before, after: root.scrollTop, scrollHeight: root.scrollHeight, clientHeight: root.clientHeight, reason: root.scrollTop > before ? 'SCROLLED_PAGE' : 'PAGE_AT_END' };
    }, options).catch(error => ({ attempted: false, moved: false, verifiedList: false, reason: 'SCROLL_FAILED', error: error.message }));

    const first = await inspect({ entries: candidates, proofSelectors: rowSelectors, confirm: null });
    if (first.moved || !first.proofCandidate) return first;
    const delay = Math.max(0, Math.min(250, Number(settleMs) || 0));
    if (delay < 100 || typeof page.waitForTimeout !== 'function') return { ...first, verifiedList: false, reason: 'LIST_END_CONFIRMATION_BUDGET_UNAVAILABLE' };
    await page.waitForTimeout(delay);
    const second = await inspect({
      entries: candidates,
      proofSelectors: rowSelectors,
      confirm: { selector: first.selector, elementIndex: first.elementIndex, ancestorDepth: first.ancestorDepth }
    });
    const stable = second.atEnd === true
      && second.loadingOrLoadMoreVisible !== true
      && second.scrollHeight === first.scrollHeight
      && second.visibleRowCount === first.visibleRowCount
      && second.visibleRowSignature === first.visibleRowSignature;
    return {
      ...second,
      before: first.before,
      firstSnapshot: first,
      verifiedList: stable,
      confirmationCount: stable ? 2 : 1,
      reason: stable ? 'CONTAINER_END_STABLE_CONFIRMED' : 'CONTAINER_END_UNSTABLE'
    };
  }

  async collectHistoricalCommentMessages(page, payload, { maxRounds = 4, settleMs = 500, sourceContext = {} } = {}) {
    const messages = [];
    const seen = new Set();
    let rounds = 0;
    let stagnantRounds = 0;
    let stopReason = 'MAX_ROUNDS';
    for (let round = 1; round <= Math.max(1, Number(maxRounds) || 4); round += 1) {
      await this.assertRuntimeAllowed();
      rounds = round;
      const extracted = await this.extractMessages(page, 'COMMENT', payload, { inboxType: 'MAIN', sourceContext });
      const enrichment = typeof this.enrichDouyinFoldedCommentReplies === 'function'
        ? await this.enrichDouyinFoldedCommentReplies(page, extracted, payload)
        : { messages: extracted, results: [] };
      const current = Array.isArray(enrichment) ? enrichment : (enrichment.messages || extracted);
      let added = 0;
      for (const message of current) {
        const key = clean(message?.externalId);
        if (!key || seen.has(key)) continue;
        seen.add(key); messages.push(message); added += 1;
      }
      stagnantRounds = added > 0 ? 0 : stagnantRounds + 1;
      if (round >= Math.max(1, Number(maxRounds) || 4)) break;
      const advance = await this.advanceHistoricalCommentList(page, { selectors: this.spec.commentScrollSelectors || [] });
      if (!advance.attempted || !advance.moved) { stopReason = advance.reason || 'LIST_EXHAUSTED'; break; }
      if (stagnantRounds >= 2) { stopReason = 'NO_NEW_MESSAGES'; break; }
      await page.waitForTimeout(Math.max(100, Number(settleMs) || 500));
    }
    return { messages, rounds, uniqueCount: messages.length, stopReason };
  }

  async enrichDouyinUnreadPrivateMessages(page, messages = [], payload = {}) {
    if (this.platformCode !== 'douyin') return { messages, attemptedCount: 0, verifiedCount: 0, results: [] };
    const results = [];
    const enriched = [];
    for (const message of messages) {
      const context = message.context && typeof message.context === 'object' ? message.context : {};
      if (context.unread !== true) {
        enriched.push(message);
        results.push({ userName: message.userName, status: 'SKIPPED', reason: 'PRIVATE_UNREAD_EVIDENCE_REQUIRED' });
        continue;
      }
      if (Math.max(1, Number(context.unreadCount) || 1) !== 1) {
        enriched.push({ ...message, context: { ...context, fullSource: false, sourceVerified: false, privateVerificationReason: 'PRIVATE_PREVIEW_MULTIPLE_UNREAD' } });
        results.push({ userName: message.userName, status: 'SKIPPED', reason: 'PRIVATE_PREVIEW_MULTIPLE_UNREAD' });
        continue;
      }
      const target = await this.openPrivateConversationForPayload(page, {
        platformCode: this.platformCode,
        messageType: 'PRIVATE_MESSAGE',
        userName: message.userName,
        sourceContent: message.content,
        externalUrl: message.externalUrl,
        messageContext: context
      }, { requireSourcePreview: true, requireUnreadEvidence: true }).catch(error => ({ ok: false, reason: 'PRIVATE_CONVERSATION_ENRICH_FAILED', error: clean(error?.message || error) }));
      if (!target.ok) {
        if (target.deferred === true && target.reason === 'CONVERSATION_LIST_LOADING_TIMEOUT') {
          results.push({ userName: message.userName, status: 'DEFERRED', reason: target.reason });
          continue;
        }
        enriched.push({ ...message, context: { ...context, fullSource: false, sourceVerified: false, chatTitleVerified: false, privateVerificationReason: target.reason || 'PRIVATE_CONVERSATION_ENRICH_FAILED' } });
        results.push({ userName: message.userName, status: 'UNVERIFIED', reason: target.reason || 'PRIVATE_CONVERSATION_ENRICH_FAILED' });
        continue;
      }
      const conversationId = clean(target.conversationId);
      const messageId = clean(target.messageId);
      const direction = clean(target.direction).toLowerCase();
      let reason = null;
      if (target.timelineStable === false) reason = 'PRIVATE_TIMELINE_UNSTABLE';
      else if (target.sourceIsLatest !== true) reason = 'SOURCE_MESSAGE_NOT_LATEST_IN_CONVERSATION';
      else if (direction !== 'incoming' || Number(target.sourceIncomingMessageCount) < 1) reason = 'SOURCE_INCOMING_MESSAGE_NOT_IN_CONVERSATION';
      else if (!conversationId) reason = 'STABLE_CONVERSATION_ID_REQUIRED';
      else if (!messageId) reason = 'STABLE_MESSAGE_ID_REQUIRED';
      if (reason) {
        enriched.push({
          ...message,
          context: {
            ...context,
            conversationKey: conversationId || clean(context.conversationKey) || null,
            conversationId: conversationId || null,
            messageId: messageId || null,
            direction: direction || null,
            previewOnly: true,
            fullSource: false,
            sourceVerified: false,
            chatTitleVerified: true,
            privateVerificationReason: reason,
            sourceMessageCount: target.sourceMessageCount,
            sourceIncomingMessageCount: target.sourceIncomingMessageCount
          }
        });
        results.push({ userName: message.userName, status: 'UNVERIFIED', reason, conversationId: conversationId || null, messageId: messageId || null });
        continue;
      }
      enriched.push({
        ...message,
        externalId: `${this.platformCode}-private_message-${digest([message.externalUrl, conversationId, messageId])}`,
        context: {
          ...context,
          conversationKey: conversationId,
          conversationId,
          messageId,
          direction: 'incoming',
          previewOnly: false,
          fullSource: true,
          sourceVerified: true,
          chatTitleVerified: true,
          privateVerificationReason: 'UNREAD_CHAT_LATEST_INCOMING_VERIFIED',
          privateVerificationVersion: 'douyin-unread-chat-2026.08.19.1',
          sourceMessageCount: target.sourceMessageCount,
          sourceIncomingMessageCount: target.sourceIncomingMessageCount,
          messageIdEvidence: target.sourceMessage?.messageIdEvidence || null,
          conversationIdEvidence: target.rowIdentity?.evidence || target.sourceMessage?.conversationIdEvidence || null
        }
      });
      results.push({ userName: message.userName, status: 'VERIFIED', reason: 'UNREAD_CHAT_LATEST_INCOMING_VERIFIED', conversationId, messageId });
    }
    return {
      messages: enriched,
      attemptedCount: results.filter(item => !['SKIPPED', 'DEFERRED'].includes(item.status)).length,
      verifiedCount: results.filter(item => item.status === 'VERIFIED').length,
      deferredCount: results.filter(item => item.status === 'DEFERRED').length,
      results
    };
  }

  async collectMessages(payload) {
    const requested = new Set((payload.types || ['COMMENT', 'PRIVATE_MESSAGE']).map(value => String(value).toUpperCase()));
    const targetedRecovery = recoveryCollectionTargets(payload);
    if (targetedRecovery && !targetedRecovery.ok) return recoveryCollectionFailure(targetedRecovery.code, '旧会话恢复任务缺少平台稳定会话标识，已禁止泛扫历史会话');
    if (targetedRecovery && (requested.size !== 1 || !requested.has('PRIVATE_MESSAGE'))) {
      return recoveryCollectionFailure('RECOVERY_PRIVATE_MESSAGE_ONLY', '旧会话恢复任务只允许定向采集私信');
    }
    const page = await this.getPage();
    const messages = [];
    const typeResults = [];
    const contentInventory = [];
    for (const item of [
      { type: 'PRIVATE_MESSAGE', label: '\u79c1\u4fe1', url: this.spec.messageUrl, reuseCurrent: this.platformCode === 'douyin' },
      { type: 'COMMENT', label: '\u8bc4\u8bba', url: this.spec.commentUrl }
    ]) {
      if (!requested.has(item.type)) continue;
      if (!item.url) {
        typeResults.push({ type: item.type, status: 'NEEDS_CONFIRMATION', reason: 'ENTRY_URL_MISSING', count: 0 });
        continue;
      }
      try {
      const navigation = await this.prepareMessagePage(page, item);
      const pageText = await pageEvidenceText(page);
      const login = await this.inspectLoginState(page);
      if (login.state === 'LOGIN' || login.state === 'VERIFY_REQUIRED') {
        const failure = await this.evidence(payload, `${this.spec.name}${item.label}\u9875\u9762\u9700\u8981\u4eba\u5de5\u767b\u5f55\u6216\u9a8c\u8bc1\uff0c\u672a\u6267\u884c\u91c7\u96c6`, page, 'collect_login_required', {
          messages,
          messageType: item.type,
          navigation,
          pageCheck: { valid: false, reason: login.state, evidence: login.evidence }
        });
        typeResults.push({ type: item.type, status: 'NEEDS_CONFIRMATION', reason: login.state, count: 0, url: page.url(), navigation, evidencePath: failure.evidencePath, screenshotPath: failure.screenshotPath });
        continue;
      }
      if (item.type === 'PRIVATE_MESSAGE'
        && this.platformCode === 'wechat_channels'
        && typeof this.collectWechatPrivateMessages === 'function') {
        const privateCollection = await this.collectWechatPrivateMessages(page, payload, { navigation });
        messages.push(...(privateCollection.messages || []));
        typeResults.push({
          type: item.type,
          status: privateCollection.ok ? 'SUCCESS' : 'NEEDS_CONFIRMATION',
          reason: privateCollection.reason || (privateCollection.ok ? 'VERIFIED_WECHAT_PRIVATE_INBOXES_UNREAD_ONLY' : 'WECHAT_PRIVATE_INBOX_COLLECTION_INCOMPLETE'),
          count: privateCollection.messages?.length || 0,
          mainCount: privateCollection.mainMessages?.length || 0,
          greetingCount: privateCollection.greetingMessages?.length || 0,
          droppedDuplicateCount: privateCollection.droppedDuplicateCount || 0,
          url: page.url(),
          pageCheck: privateCollection.pageCheck || null,
          navigation,
          inboxes: privateCollection.inboxes || [],
          empty: Boolean(privateCollection.empty)
        });
        continue;
      }
      const readiness = await this.waitForMessageContentReady(page, item.type);
      const pageCheck = readiness.pageCheck || await this.classifyLiveMessagePage(page, item.type, pageText);
      if (!readiness.ready || !pageCheck.valid) {
        const reasonText = pageCheck.reason === 'PAGE_ERROR'
          ? '\u9875\u9762\u660e\u786e\u663e\u793a\u4e0d\u5b58\u5728\u6216\u52a0\u8f7d\u5931\u8d25'
          : pageCheck.reason === 'OFFICIAL_APP_REQUIRED'
            ? '\u5f53\u524d\u5c1a\u672a\u786e\u8ba4\u53ef\u7528\u7684\u7f51\u9875\u7248\u79c1\u4fe1\u5165\u53e3\uff0c\u53ef\u80fd\u9700\u8981\u6296\u97f3\u5b98\u65b9 App'
            : '\u5f53\u524d\u9875\u9762\u7f3a\u5c11\u53ef\u8bc1\u660e\u5176\u4e3a\u76ee\u6807\u6d88\u606f\u9875\u7684\u53ef\u9760\u4fe1\u53f7';
        const failure = await this.evidence(payload, `${this.spec.name}${item.label}\u91c7\u96c6\u672a\u6267\u884c\uff1a${reasonText}`, page, 'message_page_unverified', {
          messages,
          messageType: item.type,
          navigation,
          pageCheck,
          readiness
        });
        typeResults.push({
          type: item.type,
          status: 'NEEDS_CONFIRMATION',
          reason: readiness.reason || pageCheck.reason,
          pageReason: pageCheck.reason,
          count: 0,
          url: page.url(),
          navigation,
          refreshEvidence: readiness.refreshEvidence || null,
          recoveryEvidence: readiness.recoveryEvidence || null,
          evidencePath: failure.evidencePath,
          screenshotPath: failure.screenshotPath
        });
        continue;
      }
      if (item.type === 'COMMENT' && this.platformCode === 'wechat_channels') {
        const commentCollection = await this.collectWechatChannelComments(page, payload, { readiness });
        messages.push(...commentCollection.messages);
        const observedInventory = new Map();
        const rememberWechatWork = (context = {}, verificationStatus = 'OBSERVED', evidence = {}) => {
          const platformPostId = clean(context.sourceVideoKey);
          if (!platformPostId || context.sourceIdentityConflict === true) return;
          const previous = observedInventory.get(platformPostId);
          const rank = { UNVERIFIED: 0, OBSERVED: 1, VERIFIED: 2 };
          const candidate = {
            platformCode: 'wechat_channels',
            platformAccountKey: String(payload.accountId ?? payload.profileName ?? 'unknown'),
            platformPostId,
            title: clean(context.sourceVideoTitle) || null,
            description: clean(context.sourceVideoDescription) || null,
            publishedAtRaw: clean(context.sourceVideoPublishedAt || context.sourceVideoTime) || null,
            opaqueKey: clean(context.sourceVideoOpaqueKey) || null,
            verificationStatus,
            evidenceJson: {
              source: 'wechat_channels_comment_collection',
              sourceVerified: context.sourceVerified === true,
              sourceIdentityBinding: clean(context.sourceIdentityBinding) || null,
              sourceIdentityEvidence: context.sourceIdentityEvidence || null,
              ...evidence
            }
          };
          if (!previous || rank[candidate.verificationStatus] >= rank[previous.verificationStatus]) observedInventory.set(platformPostId, candidate);
        };
        for (const videoResult of commentCollection.videoResults || []) {
          const context = videoResult.sourceContext || {};
          rememberWechatWork(context, context.sourceVerified === true && context.sourceIdentityBinding === 'LIVE_SELECTED_WORK' && videoResult.status === 'SUCCESS' ? 'VERIFIED' : 'OBSERVED', {
            collectionStatus: videoResult.status || null,
            collectionReason: videoResult.reason || null,
            runtimeState: videoResult.runtimeState ? {
              currentExportId: videoResult.runtimeState.currentExportId || null,
              activeVNodeKey: videoResult.runtimeState.activeVNodeKey || null,
              activeIndex: Number.isInteger(videoResult.runtimeState.activeIndex) ? videoResult.runtimeState.activeIndex : null,
              currentFeedIndex: Number.isInteger(videoResult.runtimeState.currentFeedIndex) ? videoResult.runtimeState.currentFeedIndex : null,
              selectionIdentityConsistent: videoResult.runtimeState.selectionIdentityConsistent === true
            } : null
          });
        }
        for (const row of commentCollection.rows || []) {
          const context = this.wechatCommentVideoContext(row);
          if (context.sourceVerified === true) rememberWechatWork(context, 'OBSERVED', { collectionStatus: 'ROW_OBSERVED' });
        }
        contentInventory.push(...observedInventory.values());
        typeResults.push({
          type: item.type,
          status: commentCollection.ok ? 'SUCCESS' : 'NEEDS_CONFIRMATION',
          reason: commentCollection.reason,
          count: commentCollection.messages.length,
          url: page.url(),
          pageCheck,
          navigation,
          empty: Boolean(commentCollection.empty),
          readinessReason: readiness.reason || null,
          wechatCommentEvidence: readiness.wechatCommentEvidence || null,
          positiveRowCount: commentCollection.positiveRowCount || 0,
          videoResults: commentCollection.videoResults
        });
        continue;
      }
      const historicalCollection = item.type === 'COMMENT' && this.platformCode === 'douyin'
        ? await this.collectHistoricalCommentMessages(page, payload)
        : null;
      const collected = historicalCollection?.messages || await this.extractMessages(page, item.type, payload, { inboxType: 'MAIN', scope: readiness.scope || page });
      if (item.type === 'PRIVATE_MESSAGE') {
        const mainEnrichment = this.platformCode === 'douyin'
          ? await this.enrichDouyinUnreadPrivateMessages(page, collected, payload)
          : { messages: collected, attemptedCount: 0, verifiedCount: 0, results: [] };
        const mainMessages = mainEnrichment.messages;
        const coverage = await this.inspectPrivateMessageCoverage(page);
        if (coverage.ambiguous) {
          messages.push(...mainMessages);
          typeResults.push({ type: item.type, status: 'NEEDS_CONFIRMATION', reason: 'STRANGER_INBOX_AMBIGUOUS', count: mainMessages.length, url: page.url(), pageCheck, navigation, coverage, privateEnrichment: { main: mainEnrichment } });
          continue;
        }
        let strangerMessages = [];
        let strangerEnrichment = { messages: [], attemptedCount: 0, verifiedCount: 0, results: [] };
        let strangerInbox = null;
        if (coverage.strangerInboxVisible) {
          strangerInbox = await this.openDouyinStrangerInbox(page);
          if (!strangerInbox.ok) {
            messages.push(...mainMessages);
            typeResults.push({ type: item.type, status: 'NEEDS_CONFIRMATION', reason: strangerInbox.reason, count: mainMessages.length, url: page.url(), pageCheck, navigation, coverage, strangerInbox, privateEnrichment: { main: mainEnrichment } });
            continue;
          }
          const strangerPreviews = await this.extractMessages(page, item.type, payload, { inboxType: 'STRANGER' });
          strangerEnrichment = this.platformCode === 'douyin'
            ? await this.enrichDouyinUnreadPrivateMessages(page, strangerPreviews, payload)
            : { messages: strangerPreviews, attemptedCount: 0, verifiedCount: 0, results: [] };
          strangerMessages = strangerEnrichment.messages;
        }
        const merged = this.platformCode === 'douyin'
          ? mergeDouyinPrivateInboxMessages(mainMessages, strangerMessages)
          : { messages: [...mainMessages, ...strangerMessages], mainMessages, strangerMessages, droppedDuplicateCount: 0 };
        messages.push(...merged.messages);
        typeResults.push({
          type: item.type,
          status: 'SUCCESS',
          reason: readiness.empty && readiness.reason ? readiness.reason : 'VERIFIED_MAIN_AND_STRANGER_UNREAD_ONLY',
          count: merged.messages.length,
          mainCount: merged.mainMessages.length,
          strangerCount: merged.strangerMessages.length,
          droppedDuplicateCount: merged.droppedDuplicateCount,
          url: page.url(),
          pageCheck,
          navigation,
          coverage,
          strangerInbox,
          empty: Boolean(readiness.empty),
          privateEvidence: readiness.privateEvidence || null,
          privateEnrichment: {
            main: { attemptedCount: mainEnrichment.attemptedCount, verifiedCount: mainEnrichment.verifiedCount, results: mainEnrichment.results },
            stranger: { attemptedCount: strangerEnrichment.attemptedCount, verifiedCount: strangerEnrichment.verifiedCount, results: strangerEnrichment.results }
          }
        });
        continue;
      }
      messages.push(...collected);
      const verifiedReason = item.type === 'COMMENT' && readiness.empty && readiness.reason
        ? readiness.reason
        : 'VERIFIED_PAGE';
      typeResults.push({
        type: item.type,
        status: 'SUCCESS',
        reason: verifiedReason,
        count: collected.length,
        url: page.url(),
        pageCheck,
        navigation,
        ...(item.type === 'COMMENT' ? {
          empty: Boolean(readiness.empty),
          readinessReason: readiness.reason || null,
          wechatCommentEvidence: readiness.wechatCommentEvidence || null,
          historicalScanRounds: historicalCollection?.rounds || 1,
          historicalScanStopReason: historicalCollection?.stopReason || null
        } : {})
      });
      } catch (error) {
        typeResults.push({ ...isolatedCollectionFailure(item.type, error), url: typeof page.url === 'function' ? page.url() : null });
      }
    }
    if (typeResults.some(item => item.status !== 'SUCCESS')) {
      return {
        status: 'NEEDS_CONFIRMATION',
        result: await this.evidence(payload, `${this.spec.name}\u5b58\u5728\u672a\u5b8c\u6210\u6821\u51c6\u7684\u6d88\u606f\u533a\u57df\uff0c\u672a\u62a5\u544a\u6574\u4f53\u91c7\u96c6\u6210\u529f`, page, 'message_page_unverified', { messages, typeResults, contentInventory })
      };
    }
    const summary = typeResults.map(item => `${item.type === 'COMMENT' ? '\u8bc4\u8bba' : '\u79c1\u4fe1'} ${item.count} \u6761`).join('\uff0c');
    return {
      status: 'SUCCESS',
      result: {
        ...(await this.evidence(payload, `${this.spec.name}\u6d88\u606f\u91c7\u96c6\u5b8c\u6210\uff1a${summary || '\u672a\u8bf7\u6c42\u4efb\u4f55\u6d88\u606f\u7c7b\u578b'}`, page, 'messages_collected', { typeResults })),
        messages,
        typeResults,
        contentInventory
      }
    };
  }

  async locateMessageContainer(page, payload) {
    const sourceContent = clean(payload.sourceContent);
    const userName = clean(payload.userName);
    if ((this.platformCode === 'douyin' || this.spec.strictCommentIdentity) && String(payload.messageType).toUpperCase() === 'COMMENT') {
      const rowSelectors = [...new Set([
        this.spec.commentRowSelector,
        ...(this.spec.messageCardSelectorsByType?.COMMENT || []),
        '[class*="cmt-li-"]'
      ].filter(Boolean))];
      const rows = page.locator(rowSelectors.join(','));
      const count = Math.min(await rows.count().catch(() => 0), 100);
      const candidates = [];
      for (let index = 0; index < count; index += 1) {
        const row = rows.nth(index);
        if (!await row.isVisible().catch(() => false)) continue;
        const candidate = await this.readDouyinCommentCandidate(row);
        const identity = matchDouyinCommentIdentity(candidate || {}, payload);
        candidates.push({ index, identity });
      }
      const matches = candidates.filter(item => item.identity.matched);
      if (matches.length !== 1) {
        return { ok: false, reason: matches.length ? 'COMMENT_TARGET_AMBIGUOUS' : 'COMMENT_TARGET_NOT_FOUND', candidates: candidates.map(item => ({ index: item.index, reason: item.identity.reason, actual: item.identity.actual })) };
      }
      return { ok: true, locator: rows.nth(matches[0].index), identity: matches[0].identity, index: matches[0].index };
    }

    if (!sourceContent || !userName) return { ok: false, reason: 'MESSAGE_IDENTITY_FIELDS_MISSING' };
    const exactTexts = page.getByText(sourceContent, { exact: true });
    const count = Math.min(await exactTexts.count().catch(() => 0), 100);
    const matches = [];
    for (let index = 0; index < count; index += 1) {
      const text = exactTexts.nth(index);
      if (!await text.isVisible().catch(() => false)) continue;
      const container = text.locator('xpath=ancestor::*[self::li or self::article or @role="listitem" or contains(@class,"comment")][1]');
      if (!await container.count().catch(() => 0)) continue;
      const exactUser = container.getByText(userName, { exact: true });
      if (await exactUser.first().isVisible().catch(() => false)) matches.push(container);
    }
    if (matches.length !== 1) return { ok: false, reason: matches.length ? 'MESSAGE_TARGET_AMBIGUOUS' : 'MESSAGE_TARGET_NOT_FOUND' };
    return { ok: true, locator: matches[0], identity: { matched: true, reason: 'MESSAGE_USER_AND_CONTENT_EXACT' } };
  }

  async locateMessageContainerWithRetry(page, payload, { attempts = null, delayMs = 450, timeBudgetMs = 12000 } = {}) {
    const requestedAttempts = Number(attempts);
    const historicalComment = (this.platformCode === 'douyin' || this.platformCode === 'wechat_channels')
      && String(payload.messageType || '').toUpperCase() === 'COMMENT';
    const maxAttempts = Number.isFinite(requestedAttempts) && requestedAttempts > 0 ? Math.floor(requestedAttempts) : (historicalComment ? 4 : 1);
    const deadline = Date.now() + Math.max(1000, Number(timeBudgetMs) || 12000);
    let result = null;
    let lastAdvance = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      await this.assertRuntimeAllowed();
      result = await this.locateMessageContainer(page, payload);
      if (result.ok || !['COMMENT_TARGET_NOT_FOUND', 'MESSAGE_TARGET_NOT_FOUND'].includes(result.reason)) {
        return { ...result, locateAttempts: attempt, historicalScan: historicalComment, lastAdvance, listVerifiedComplete: false };
      }
      if (historicalComment) {
        const trustedScrollSelectors = [
          ...(this.spec.commentScrollSelectors || []),
          ...(typeof this.messageCardSelectors === 'function' ? this.messageCardSelectors('COMMENT') : []),
          this.spec.commentRowSelector
        ].filter(Boolean);
        lastAdvance = await this.advanceHistoricalCommentList(page, { selectors: trustedScrollSelectors });
        if (lastAdvance.attempted && !lastAdvance.moved && lastAdvance.verifiedList === true) {
          return { ...result, locateAttempts: attempt, historicalScan: true, lastAdvance, exhausted: true, listVerifiedComplete: true };
        }
      }
      if (attempt >= maxAttempts || Date.now() >= deadline) {
        return { ...result, locateAttempts: attempt, historicalScan: historicalComment, lastAdvance, exhausted: false, listVerifiedComplete: false, timeBudgetExhausted: Date.now() >= deadline };
      }
      await page.waitForTimeout(Math.max(100, Number(delayMs) || 450));
    }
    return { ...(result || { ok: false, reason: 'COMMENT_TARGET_NOT_FOUND' }), locateAttempts: maxAttempts, historicalScan: historicalComment, lastAdvance, exhausted: false, listVerifiedComplete: false };
  }

  async locatePrivateConversationHeader(page, userName) {
    const configuredSelectors = [...new Set((this.spec.privateConversationHeaderSelectors || []).filter(Boolean))];
    const selectors = [...new Set([
      ...configuredSelectors,
      '[class*="StackChatHeader"][class*="title"]',
      '[class*="RightPanelHeader"][class*="title"]',
      '[data-e2e*="chat"][data-e2e*="title"]',
      '[data-e2e*="conversation"][data-e2e*="title"]'
    ])];
    const editor = await this.findReplyEditor(page, true);
    const editorBox = editor && typeof editor.boundingBox === 'function' ? await editor.boundingBox().catch(() => null) : null;
    const rowSelector = (this.spec.privateConversationRowSelectors || ['[data-e2e="conversation-item"]']).join(',');
    if (!page || typeof page.locator !== 'function') {
      return { ok: false, reason: 'PRIVATE_PAGE_LOCATOR_UNAVAILABLE', editorFound: Boolean(editor), editorBox, inspectedCandidateCount: 0 };
    }
    const candidates = selectors.length ? await page.locator(selectors.join(',')).evaluateAll((elements, options) => {
      const normalize = value => String(value || '').normalize('NFC').replace(/[\u200B\uFEFF\uFE0E\uFE0F]/g, '').replace(/\s+/g, ' ').trim();
      const configured = options.configuredSelectors || [];
      return elements.slice(0, 80).map((element, index) => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        let configuredMatch = false;
        for (const selector of configured) {
          try {
            if (element.matches(selector)) { configuredMatch = true; break; }
          } catch {}
        }
        let insideConversationRow = false;
        if (options.rowSelector) {
          try { insideConversationRow = Boolean(element.closest(options.rowSelector)); } catch {}
        }
        return {
          index,
          text: normalize(element.innerText || element.textContent),
          className: String(element.className?.baseVal || element.className || '').slice(0, 500),
          dataE2e: element.getAttribute('data-e2e') || '',
          role: element.getAttribute('role') || '',
          title: element.getAttribute('title') || '',
          ariaLabel: element.getAttribute('aria-label') || '',
          configuredMatch,
          insideConversationRow,
          visible: style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) > 0 && element.getClientRects().length > 0,
          rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
        };
      });
    }, { configuredSelectors, rowSelector }).catch(() => []) : [];
    return {
      ...selectPrivateConversationHeaderEvidence(candidates, userName, editorBox),
      editorFound: Boolean(editor),
      editorBox,
      inspectedCandidateCount: candidates.length
    };
  }

  async readPrivateConversationRowSnapshot(row) {
    if (!row || typeof row.isVisible !== 'function' || !await row.isVisible().catch(() => false)) {
      return { visible: false, userName: '', preview: '', unread: false, readSources: [] };
    }
    const title = await firstUsable((this.spec.privateConversationNameSelectors || []).map(selector => row.locator(selector)));
    const preview = await firstUsable((this.spec.privateConversationContentSelectors || []).map(selector => row.locator(selector)));
    let unread = false;
    for (const selector of this.spec.privateUnreadSelectors || []) {
      if (await row.locator(selector).first().isVisible().catch(() => false)) {
        unread = true;
        break;
      }
    }
    const rowIdentity = await this.readPrivateConversationRowIdentity(row);
    return {
      visible: true,
      userName: title ? clean(await title.innerText().catch(() => '')) : '',
      preview: preview ? clean(await preview.innerText().catch(() => '')) : '',
      unread: Boolean(unread),
      conversationId: clean(rowIdentity?.conversationId) || null,
      conversationIdEvidence: rowIdentity?.evidence || [],
      readSources: ['visible-child-locators']
    };
  }

  async inspectPrivateConversationRows(privateScope, payload, { requireSourcePreview = true } = {}) {
    const rowSelector = (this.spec.privateConversationRowSelectors || ['[data-e2e="conversation-item"]']).join(',');
    const rows = privateScope.locator(rowSelector);
    const count = await rows.count().catch(() => 0);
    const rowSnapshots = [];
    const namedRows = [];
    const exactRows = [];
    const expectedConversationId = clean(payload?.messageContext?.conversationId || payload?.messageContext?.conversationKey);
    for (let index = 0; index < count; index += 1) {
      const snapshot = await this.readPrivateConversationRowSnapshot(rows.nth(index));
      if (!snapshot?.visible) continue;
      const candidate = {
        userName: clean(snapshot.userName),
        preview: clean(snapshot.preview),
        unread: snapshot.unread === true,
        conversationId: clean(snapshot.conversationId) || null
      };
      const item = { index, candidate, snapshot };
      rowSnapshots.push(item);
      if (expectedConversationId) {
        if (candidate.conversationId) {
          if (candidate.conversationId !== expectedConversationId) continue;
          namedRows.push(item);
          if (!requireSourcePreview || !clean(payload?.sourceContent) || candidate.preview === clean(payload.sourceContent)) {
            exactRows.push({ ...item, identity: { matched: true, reason: 'STABLE_CONVERSATION_ID' } });
          }
          continue;
        }

        // 抖音会话列表的 React 节点并不总会暴露 conversationId。此时不能把
        // “页面没有提供 ID”误判成“ID 不一致”，但也不能只按用户名盲点。
        // 这里只把“用户名完全一致 + 原消息预览完全一致”的唯一行列为临时候选，
        // 点击后还会通过右侧标题、稳定时间线、消息 ID、会话 ID 和来消息方向再次核验。
        if (this.platformCode !== 'douyin') continue;
        const nameIdentity = matchPrivateConversationIdentity(candidate, payload, { requirePreview: false });
        if (!nameIdentity.matched) continue;
        namedRows.push({ ...item, identity: { ...nameIdentity, stableConversationIdUnavailable: true } });
        const exactIdentity = matchPrivateConversationIdentity(candidate, payload, { requirePreview: requireSourcePreview });
        if (exactIdentity.matched) {
          exactRows.push({
            ...item,
            identity: {
              ...exactIdentity,
              reason: requireSourcePreview ? 'STABLE_ID_UNAVAILABLE_NAME_PREVIEW_EXACT' : exactIdentity.reason,
              stableConversationIdUnavailable: true
            }
          });
        }
        continue;
      }
      const nameIdentity = matchPrivateConversationIdentity(candidate, payload, { requirePreview: false });
      if (!nameIdentity.matched) continue;
      namedRows.push(item);
      const exactIdentity = matchPrivateConversationIdentity(candidate, payload, { requirePreview: requireSourcePreview });
      if (exactIdentity.matched) exactRows.push({ ...item, identity: exactIdentity });
    }
    return { rowSelector, count, rowSnapshots, namedRows, exactRows };
  }

  async waitForPrivateConversationRows(privateScope, payload, options = {}) {
    return this.inspectPrivateConversationRows(privateScope, payload, options);
  }

  async waitForPrivateConversationHeader(page, userName) {
    return this.locatePrivateConversationHeader(page, userName);
  }

  async readPrivateConversationRowIdentity(row) {
    if (!row || typeof row.evaluate !== 'function') return { conversationId: null, evidence: [] };
    return row.evaluate((element, rowSelector) => {
      const valid = value => {
        const text = String(value ?? '').trim();
        return text && !/^(?:true|false|null|undefined)$/i.test(text) ? text : null;
      };
      const nodes = [];
      for (let node = element, depth = 0; node && depth < 8; node = node.parentElement, depth += 1) {
        if (node !== element && rowSelector && node.querySelectorAll?.(rowSelector).length > 1) break;
        nodes.push(node);
      }
      // Ordinary DOM ids identify containers or display positions, not recipients.
      const attributeNames = ['data-conversation-id', 'data-conversationid', 'data-session-id', 'data-sessionid', 'data-chat-id', 'data-chatid'];
      for (const node of nodes) {
        for (const name of attributeNames) {
          const value = valid(node.getAttribute?.(name));
          if (value) return { conversationId: value, evidence: [`attribute:${name}`] };
        }
      }
      const wanted = new Set(['conversationid', 'conversationkey', 'sessionid', 'chatid']);
      const seen = new WeakSet();
      const inspect = (value, depth = 0) => {
        if (!value || depth > 6 || (typeof value !== 'object' && typeof value !== 'function') || seen.has(value)) return null;
        seen.add(value);
        for (const [key, child] of Object.entries(value)) {
          const normalizedKey = String(key || '').replace(/[^a-z0-9]/gi, '').toLowerCase();
          if (['return', 'sibling', 'child', 'alternate', 'statenode'].includes(normalizedKey)) continue;
          if (wanted.has(normalizedKey) && ['string', 'number'].includes(typeof child)) {
            const candidate = valid(child);
            if (candidate) return { conversationId: candidate, evidence: [`react:${key}`] };
          }
          if (depth < 2 || /props|conversation|session|chat|data|state/i.test(key)) {
            const nested = inspect(child, depth + 1);
            if (nested) return nested;
          }
        }
        return null;
      };
      for (const node of nodes) {
        for (const key of Object.getOwnPropertyNames(node)) {
          if (!/^__(?:reactFiber|reactProps)\$/.test(key)) continue;
          const result = inspect(node[key], 0);
          if (result) return result;
        }
      }
      return { conversationId: null, evidence: [] };
    }, (this.spec.privateConversationRowSelectors || []).join(',')).catch(() => ({ conversationId: null, evidence: [] }));
  }

  privateConversationIdFromUrl(page) {
    try {
      const url = new URL(typeof page?.url === 'function' ? page.url() : '');
      for (const key of ['conversation_id', 'conversationId', 'conversationid', 'session_id', 'sessionId', 'chat_id', 'chatId']) {
        const value = clean(url.searchParams.get(key));
        if (value) return value;
      }
      const match = url.pathname.match(/\/(?:conversation|session|chat)\/([^/?#]+)/i);
      return clean(match?.[1]) || null;
    } catch {
      return null;
    }
  }

  async inspectPrivateConversationTimeline(page, { editor = null } = {}) {
    const selector = (this.spec.privateChatMessageTextSelectors || ['.TextMessageTextpureText']).join(',');
    if (!page || typeof page.locator !== 'function') return { messages: [], reason: 'PRIVATE_PAGE_LOCATOR_UNAVAILABLE' };
    const effectiveEditor = editor || await this.findReplyEditor(page, true).catch(() => null);
    const editorBox = effectiveEditor && typeof effectiveEditor.boundingBox === 'function'
      ? await effectiveEditor.boundingBox().catch(() => null)
      : null;
    const messages = await page.locator(selector).evaluateAll((elements, options) => {
      const normalize = value => String(value || '').normalize('NFC').replace(/[\u200B\uFEFF\uFE0E\uFE0F]/g, '').replace(/\s+/g, ' ').trim();
      const stable = value => {
        const text = String(value ?? '').trim();
        return text && !/^(?:true|false|null|undefined)$/i.test(text) ? text : null;
      };
      const reactNodes = container => {
        const nodes = [];
        for (let node = container, depth = 0; node && depth < 12; node = node.parentElement, depth += 1) nodes.push(node);
        return nodes;
      };
      const inspectReactValue = (container, wanted, { acceptBoolean = false } = {}) => {
        const seen = new WeakSet();
        const inspect = (value, depth = 0) => {
          if (!value || depth > 12 || (typeof value !== 'object' && typeof value !== 'function') || seen.has(value)) return null;
          seen.add(value);
          let entries = [];
          try { entries = Object.entries(value); } catch { return null; }
          for (const [key, child] of entries) {
            const normalizedKey = String(key || '').replace(/[^a-z0-9]/gi, '').toLowerCase();
            const primitive = ['string', 'number'].includes(typeof child) || (acceptBoolean && typeof child === 'boolean');
            if (wanted.has(normalizedKey) && primitive) return { value: child, evidence: `react:${key}`, key: normalizedKey };
            if (depth < 3 || /props|memoized|pending|children|next|message|conversation|session|chat|data|state|item|record|model|content/i.test(key)) {
              const nested = inspect(child, depth + 1);
              if (nested) return nested;
            }
          }
          return null;
        };
        for (const node of reactNodes(container)) {
          for (const key of Object.getOwnPropertyNames(node)) {
            if (!/^__(?:reactFiber|reactProps)\$/.test(key)) continue;
            const result = inspect(node[key], 0);
            if (result) return result;
          }
        }
        return null;
      };
      const readIdentity = (container, kind) => {
        const nodes = reactNodes(container);
        const attributes = kind === 'message'
          ? ['data-message-id', 'data-messageid', 'data-msg-id', 'data-msgid', 'data-message-key', 'data-messagekey']
          : ['data-conversation-id', 'data-conversationid', 'data-session-id', 'data-sessionid', 'data-chat-id', 'data-chatid'];
        for (const node of nodes) {
          for (const name of attributes) {
            const value = stable(node.getAttribute?.(name));
            if (value) return { value, evidence: `attribute:${name}` };
          }
        }
        const wanted = kind === 'message'
          ? new Set(['messageid', 'msgid', 'servermessageid', 'clientmessageid', 'messagekey', 'msgkey', 'servermessagekey', 'clientmessagekey'])
          : new Set(['conversationid', 'conversationkey', 'sessionid', 'chatid']);
        const result = inspectReactValue(container, wanted);
        if (!result) return { value: null, evidence: null };
        let candidate = stable(result.value);
        if (kind === 'message' && /(?:messagekey|msgkey)$/.test(result.key || '') && candidate.includes('|')) candidate = stable(candidate.split('|', 1)[0]);
        return { value: candidate || null, evidence: candidate ? result.evidence : null };
      };
      const readDirection = container => {
        const result = inspectReactValue(container, new Set(['selfsend', 'isselfsend', 'sendbyself', 'outgoing', 'isoutgoing', 'incoming', 'isincoming', 'direction', 'messagedirection']), { acceptBoolean: true });
        if (!result) return { value: null, evidence: null };
        if (['selfsend', 'isselfsend', 'sendbyself', 'outgoing', 'isoutgoing'].includes(result.key)) {
          if (typeof result.value === 'boolean') return { value: result.value ? 'outgoing' : 'incoming', evidence: result.evidence };
          if (/^(?:true|1|outgoing|sent|self)$/i.test(String(result.value))) return { value: 'outgoing', evidence: result.evidence };
          if (/^(?:false|0|incoming|received|other)$/i.test(String(result.value))) return { value: 'incoming', evidence: result.evidence };
        }
        if (['incoming', 'isincoming'].includes(result.key)) {
          if (typeof result.value === 'boolean') return { value: result.value ? 'incoming' : 'outgoing', evidence: result.evidence };
        }
        const text = stable(result.value).toLowerCase();
        if (/^(?:incoming|received|other|left)$/.test(text)) return { value: 'incoming', evidence: result.evidence };
        if (/^(?:outgoing|sent|self|right)$/.test(text)) return { value: 'outgoing', evidence: result.evidence };
        return { value: null, evidence: null };
      };
      const seenContainers = new Set();
      const viewportWidth = typeof window !== 'undefined'
        ? Number(window.innerWidth || document?.documentElement?.clientWidth || 0)
        : 0;
      const viewportHeight = typeof window !== 'undefined'
        ? Number(window.innerHeight || document?.documentElement?.clientHeight || 0)
        : 0;
      return elements.map((element, index) => {
        const style = getComputedStyle(element);
        if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity || 1) <= 0 || !element.getClientRects().length) return null;
        const closest = value => {
          if (!value) return null;
          try { return element.closest(value); } catch { return null; }
        };
        const container = closest(options.messageContainerSelector)
          || closest('[class*="MessageItem"],li,[role="listitem"]')
          || element;
        if (seenContainers.has(container)) return null;
        seenContainers.add(container);
        const containerStyle = getComputedStyle(container);
        if (containerStyle.display === 'none' || containerStyle.visibility === 'hidden' || Number(containerStyle.opacity || 1) <= 0 || !container.getClientRects().length) return null;
        const rect = container.getBoundingClientRect();
        const x = Number(rect.x ?? rect.left ?? 0);
        const top = Number(rect.top ?? rect.y ?? 0);
        const width = Number(rect.width || 0);
        const height = Number(rect.height || 0);
        const right = Number.isFinite(Number(rect.right)) ? Number(rect.right) : x + width;
        const bottom = Number.isFinite(Number(rect.bottom)) ? Number(rect.bottom) : top + height;
        if (!(width > 0) || !(height > 0)) return null;
        if (viewportWidth > 0 && (right <= 0 || x >= viewportWidth)) return null;
        if (viewportHeight > 0 && (bottom <= 0 || top >= viewportHeight)) return null;
        if (options.editorBox && Number(options.editorBox.width) > 0) {
          const editorLeft = Number(options.editorBox.x ?? options.editorBox.left ?? 0);
          const editorRight = editorLeft + Number(options.editorBox.width || 0);
          if (right <= editorLeft || x >= editorRight) return null;
        }
        const text = normalize(element.innerText || element.textContent);
        if (!text) return null;
        const classes = [];
        for (let node = container, depth = 0; node && depth < 5; node = node.parentElement, depth += 1) classes.push(String(node.className?.baseVal || node.className || ''));
        const classEvidence = classes.join(' ');
        let direction = null;
        let directionEvidence = null;
        const reactDirection = readDirection(container);
        if (reactDirection.value) {
          direction = reactDirection.value; directionEvidence = reactDirection.evidence;
        } else if (options.outgoingContainerSelector && closest(options.outgoingContainerSelector)) {
          direction = 'outgoing'; directionEvidence = `selector:${options.outgoingContainerSelector}`;
        } else if (/(?:right|self|mine|outgoing|sent|sender)/i.test(classEvidence)) {
          direction = 'outgoing'; directionEvidence = 'class:outgoing';
        } else if (/(?:left|other|incoming|received|receiver)/i.test(classEvidence)) {
          direction = 'incoming'; directionEvidence = 'class:incoming';
        } else {
          const alignmentContainer = closest('[class*="MessageBoxContentrowBox"]')
            || (() => {
              for (let node = container.parentElement, depth = 0; node && depth < 6; node = node.parentElement, depth += 1) {
                const box = node.getBoundingClientRect();
                if (box.width >= width + 40) return node;
              }
              return null;
            })();
          const alignmentBox = alignmentContainer?.getBoundingClientRect?.() || null;
          if (alignmentBox && alignmentBox.width > width) {
            const leftGap = x - alignmentBox.x;
            const rightGap = alignmentBox.x + alignmentBox.width - (x + width);
            const threshold = Math.max(16, Math.min(48, alignmentBox.width * 0.08));
            if (rightGap - leftGap >= threshold) { direction = 'incoming'; directionEvidence = 'geometry:left-aligned-in-message-row'; }
            else if (leftGap - rightGap >= threshold) { direction = 'outgoing'; directionEvidence = 'geometry:right-aligned-in-message-row'; }
          }
          if (!direction && options.editorBox && Number(options.editorBox.width) > 0) {
            const messageCenter = x + width / 2;
            const editorCenter = options.editorBox.x + options.editorBox.width / 2;
            const threshold = Math.max(12, options.editorBox.width * 0.05);
            if (messageCenter >= editorCenter + threshold) { direction = 'outgoing'; directionEvidence = 'geometry:right-of-editor-center'; }
            else if (messageCenter <= editorCenter - threshold) { direction = 'incoming'; directionEvidence = 'geometry:left-of-editor-center'; }
          }
        }
        const messageIdentity = readIdentity(container, 'message');
        const conversationIdentity = readIdentity(container, 'conversation');
        return {
          index,
          text,
          direction,
          outgoing: direction === 'outgoing',
          directionEvidence,
          messageId: messageIdentity.value,
          messageIdEvidence: messageIdentity.evidence,
          conversationId: conversationIdentity.value,
          conversationIdEvidence: conversationIdentity.evidence,
          x: Math.round(x),
          top: Math.round(top),
          right: Math.round(right),
          bottom: Math.round(bottom),
          width: Math.round(width),
          height: Math.round(height),
          className: String(container.className?.baseVal || container.className || '')
        };
      }).filter(Boolean);
    }, {
      editorBox,
      outgoingContainerSelector: this.spec.privateOutgoingMessageContainerSelector || '',
      messageContainerSelector: this.spec.privateMessageContainerSelector || ''
    }).catch(() => []);
    const ordered = [...messages].sort((left, right) => (
      Number(left.bottom || 0) - Number(right.bottom || 0)
      || Number(left.top || 0) - Number(right.top || 0)
      || Number(left.index || 0) - Number(right.index || 0)
    ));
    const deduplicated = [];
    const identityIndex = new Map();
    for (const message of ordered) {
      const normalizedText = normalizeReplyTextForComparison(message.text);
      const key = clean(message.messageId)
        ? `id:${clean(message.messageId)}`
        : `visual:${normalizedText}|${clean(message.direction).toLowerCase()}|${Math.round(Number(message.top || 0) / 6)}|${Math.round(Number(message.bottom || 0) / 6)}`;
      if (!identityIndex.has(key)) {
        identityIndex.set(key, deduplicated.length);
        deduplicated.push(message);
        continue;
      }
      const existingIndex = identityIndex.get(key);
      const existing = deduplicated[existingIndex];
      if (Number(message.bottom || 0) >= Number(existing.bottom || 0)) deduplicated[existingIndex] = message;
    }
    deduplicated.sort((left, right) => (
      Number(left.bottom || 0) - Number(right.bottom || 0)
      || Number(left.top || 0) - Number(right.top || 0)
      || Number(left.index || 0) - Number(right.index || 0)
    ));
    return {
      messages: deduplicated,
      latestMessage: deduplicated.at(-1) || null,
      editorFound: Boolean(effectiveEditor),
      editorBox,
      rawMessageCount: messages.length,
      deduplicatedMessageCount: deduplicated.length
    };
  }

  privateTimelineSignature(timeline = {}) {
    const messages = Array.isArray(timeline.messages) ? timeline.messages : [];
    return JSON.stringify({
      count: messages.length,
      tail: messages.slice(-5).map(message => ({
        messageId: clean(message.messageId),
        text: normalizeReplyTextForComparison(message.text),
        direction: clean(message.direction).toLowerCase(),
        top: Number(message.top || 0),
        bottom: Number(message.bottom || 0)
      }))
    });
  }

  async inspectStablePrivateConversationTimeline(page, { attempts = 3, settleMs = 400 } = {}) {
    const snapshots = [];
    let previousSignature = null;
    const maxAttempts = Math.max(2, Math.min(8, Number(attempts) || 3));
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const timeline = await this.inspectPrivateConversationTimeline(page);
      const signature = this.privateTimelineSignature(timeline);
      snapshots.push({ attempt, signature, messageCount: timeline.messages?.length || 0, timeline });
      if (signature === previousSignature) {
        return {
          ...timeline,
          stable: true,
          confirmationCount: 2,
          attempts: attempt,
          snapshotSummaries: snapshots.map(item => ({ attempt: item.attempt, signature: item.signature, messageCount: item.messageCount }))
        };
      }
      previousSignature = signature;
      if (attempt < maxAttempts && typeof page?.waitForTimeout === 'function') {
        await page.waitForTimeout(Math.max(200, Math.min(700, Number(settleMs) || 400)));
      }
    }
    const latest = snapshots.at(-1)?.timeline || { messages: [], latestMessage: null };
    return {
      ...latest,
      stable: false,
      confirmationCount: 1,
      attempts: snapshots.length,
      reason: 'PRIVATE_TIMELINE_UNSTABLE',
      snapshotSummaries: snapshots.map(item => ({ attempt: item.attempt, signature: item.signature, messageCount: item.messageCount }))
    };
  }

  async inspectPrivateOutgoingReplyBubbles(page, text, { editor = null } = {}) {
    const expectedExact = normalizeReplyTextForComparison(text);
    const expectedCanonical = normalizePrivateReceiptTextForComparison(text);
    const selectors = Array.isArray(this.spec.privateOutgoingMessageBubbleSelectors)
      ? this.spec.privateOutgoingMessageBubbleSelectors.map(clean).filter(Boolean)
      : [];
    if (!expectedExact || !expectedCanonical || !selectors.length) {
      return { count: 0, matches: [], pendingCount: 0, failedCount: 0, selector: selectors.join(',') || null };
    }
    if (!page || typeof page.locator !== 'function') {
      return { count: 0, matches: [], pendingCount: 0, failedCount: 0, selector: selectors.join(','), reason: 'PRIVATE_PAGE_LOCATOR_UNAVAILABLE' };
    }
    const editorBox = editor && typeof editor.boundingBox === 'function'
      ? await editor.boundingBox().catch(() => null)
      : null;
    const selector = selectors.join(',');
    const result = await page.locator(selector).evaluateAll((elements, options) => {
      const exact = value => String(value || '')
        .normalize('NFC')
        .replace(/[\u200B\uFEFF\uFE0E\uFE0F]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
      const canonical = value => String(value || '')
        .normalize('NFKC')
        .replace(/[\u200B\uFEFF\uFE0E\uFE0F]/g, '')
        .replace(/[～〜]/g, '~')
        .replace(/[“”]/g, '"')
        .replace(/[‘’]/g, "'")
        .replace(/\s+/g, '')
        .trim();
      const failedPattern = /发送失败|未发送成功|重新发送|点击重试|网络(?:异常|错误)|send\s*failed/i;
      const pendingPattern = /发送中|正在发送|sending/i;
      const seen = new Set();
      const matches = [];
      let pendingCount = 0;
      let failedCount = 0;
      for (const [index, element] of elements.entries()) {
        if (seen.has(element)) continue;
        seen.add(element);
        const style = getComputedStyle(element);
        if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity || 1) <= 0 || !element.getClientRects().length) continue;
        const rect = element.getBoundingClientRect();
        if (!(Number(rect.width) > 0) || !(Number(rect.height) > 0)) continue;
        if (options.editorBox && Number(options.editorBox.width) > 0) {
          const messageCenter = Number(rect.x || rect.left || 0) + Number(rect.width || 0) / 2;
          const editorCenter = Number(options.editorBox.x || 0) + Number(options.editorBox.width || 0) / 2;
          if (messageCenter < editorCenter - Math.max(16, Number(options.editorBox.width || 0) * 0.08)) continue;
        }
        const containerText = exact(element.innerText || element.textContent);
        if (!containerText) continue;
        if (failedPattern.test(containerText)) { failedCount += 1; continue; }
        if (pendingPattern.test(containerText)) { pendingCount += 1; continue; }
        const candidates = [containerText];
        const descendants = element.querySelectorAll('.message-plain,[class*="message-plain"],[class*="message-content"],[class*="message-text"],p,span');
        for (const child of descendants) {
          const childText = exact(child.innerText || child.textContent);
          if (childText) candidates.push(childText);
        }
        let matchMode = null;
        for (const candidate of candidates) {
          const candidateExact = exact(candidate);
          const candidateCanonical = canonical(candidate);
          if (candidateExact === options.expectedExact) { matchMode = 'EXACT_TEXT'; break; }
          if (candidateCanonical === options.expectedCanonical) { matchMode = 'CANONICAL_TEXT'; break; }
          const extraLength = candidateCanonical.length - options.expectedCanonical.length;
          if (options.expectedCanonical.length >= 8
            && extraLength >= 0
            && extraLength <= 12
            && candidateCanonical.includes(options.expectedCanonical)) {
            matchMode = 'CANONICAL_TEXT_WITH_PLATFORM_STATUS';
            break;
          }
        }
        if (!matchMode) continue;
        matches.push({
          index,
          matchMode,
          x: Math.round(Number(rect.x || rect.left || 0)),
          top: Math.round(Number(rect.top || rect.y || 0)),
          right: Math.round(Number(rect.right || 0)),
          bottom: Math.round(Number(rect.bottom || 0)),
          width: Math.round(Number(rect.width || 0)),
          height: Math.round(Number(rect.height || 0)),
          textLength: options.expectedExact.length,
          className: String(element.className?.baseVal || element.className || '')
        });
      }
      return { matches, pendingCount, failedCount };
    }, { expectedExact, expectedCanonical, editorBox }).catch(() => ({ matches: [], pendingCount: 0, failedCount: 0 }));
    const matches = Array.isArray(result?.matches) ? result.matches : [];
    return {
      count: matches.length,
      matches,
      pendingCount: Number(result?.pendingCount || 0),
      failedCount: Number(result?.failedCount || 0),
      selector
    };
  }

  async countExactPrivateMessages(page, text, { outgoingOnly = false, editor = null } = {}) {
    const exactText = normalizeReplyTextForComparison(text);
    if (!exactText) return { count: 0, matches: [] };
    const editorBox = editor && typeof editor.boundingBox === 'function' ? await editor.boundingBox().catch(() => null) : null;
    const selector = (this.spec.privateChatMessageTextSelectors || ['.TextMessageTextpureText']).join(',');
    if (!page || typeof page.locator !== 'function') return { count: 0, matches: [], reason: 'PRIVATE_PAGE_LOCATOR_UNAVAILABLE' };
    const matches = await page.locator(selector).evaluateAll((elements, options) => {
      const normalize = value => String(value || '').normalize('NFC').replace(/[\u200B\uFEFF\uFE0E\uFE0F]/g, '').replace(/\s+/g, ' ').trim();
      const seen = new Set();
      return elements.map((element, index) => {
        const style = getComputedStyle(element);
        if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity || 1) <= 0 || !element.getClientRects().length) return null;
        if (normalize(element.innerText || element.textContent) !== options.exactText) return null;
        const closest = selector => {
          if (!selector) return null;
          try { return element.closest(selector); } catch { return null; }
        };
        const container = closest(options.messageContainerSelector) || closest('[class*="MessageItemTextcontainer"]') || element;
        if (seen.has(container)) return null;
        seen.add(container);
        const rect = container.getBoundingClientRect();
        const outgoing = options.outgoingContainerSelector
          ? Boolean(element.closest(options.outgoingContainerSelector))
          : (options.editorBox ? rect.x + rect.width / 2 >= options.editorBox.x + options.editorBox.width / 2 : false);
        if (options.outgoingOnly && !outgoing) return null;
        return { index, outgoing, x: Math.round(rect.x), width: Math.round(rect.width), className: String(container.className || '') };
      }).filter(Boolean);
    }, {
      exactText,
      outgoingOnly,
      editorBox,
      outgoingContainerSelector: this.spec.privateOutgoingMessageContainerSelector || '',
      messageContainerSelector: this.spec.privateMessageContainerSelector || ''
    }).catch(() => []);
    if (outgoingOnly && Array.isArray(this.spec.privateOutgoingMessageBubbleSelectors) && this.spec.privateOutgoingMessageBubbleSelectors.length) {
      const bubbleEvidence = await this.inspectPrivateOutgoingReplyBubbles(page, text, { editor });
      if (bubbleEvidence.count > matches.length) {
        return {
          count: bubbleEvidence.count,
          matches: bubbleEvidence.matches,
          detector: 'OUTGOING_BUBBLE',
          legacyCount: matches.length,
          bubbleEvidence
        };
      }
      return {
        count: matches.length,
        matches,
        detector: matches.length ? 'MESSAGE_TEXT' : 'NONE',
        legacyCount: matches.length,
        bubbleEvidence
      };
    }
    return { count: matches.length, matches, detector: matches.length ? 'MESSAGE_TEXT' : 'NONE' };
  }

  async openPrivateConversationForPayload(page, payload, {
    requireSourcePreview = true,
    requireUnreadEvidence = Boolean(this.spec.privateRequireUnreadForReply)
  } = {}) {
    const navigation = await this.prepareMessagePage(page, {
      type: 'PRIVATE_MESSAGE', label: '\u79c1\u4fe1', url: this.spec.messageUrl,
      reuseCurrent: true, inboxType: payload.messageContext?.inboxType || 'MAIN'
    });
    const login = await this.inspectLoginState(page);
    if (login.state === 'LOGIN' || login.state === 'VERIFY_REQUIRED') {
      return { ok: false, reason: login.state, navigation, pageCheck: { valid: false, reason: login.state, evidence: login.evidence } };
    }
    const inboxType = clean(payload.messageContext?.inboxType || 'MAIN').toUpperCase();
    if (this.platformCode === 'wechat_channels'
      && requireUnreadEvidence
      && this.spec.privateRequireUnreadForReply
      && payload.messageContext?.unread !== true) {
      return { ok: false, reason: 'PRIVATE_UNREAD_EVIDENCE_REQUIRED', navigation, pageCheck: { valid: true, reason: 'PRECHECK' }, inboxType };
    }
    let preparedInbox = null;
    if (typeof this.preparePrivateInbox === 'function') {
      preparedInbox = await this.preparePrivateInbox(page, { inboxType, payload, purpose: 'REPLY' });
      if (!preparedInbox?.ok) {
        return {
          ok: false,
          reason: preparedInbox?.reason || 'PRIVATE_INBOX_PREPARATION_FAILED',
          navigation,
          pageCheck: preparedInbox?.pageCheck || { valid: false, reason: preparedInbox?.reason || 'PRIVATE_INBOX_PREPARATION_FAILED' },
          inboxType,
          preparedInbox
        };
      }
    }
    const readiness = await this.waitForMessageContentReady(page, 'PRIVATE_MESSAGE');
    const pageCheck = readiness.pageCheck || await this.classifyLiveMessagePage(page, 'PRIVATE_MESSAGE');
    if (!readiness.ready || !pageCheck.valid) return { ok: false, reason: readiness.reason || pageCheck.reason, navigation, pageCheck };

    const privateScope = readiness.scope || preparedInbox?.scope || page;

    const userName = clean(payload.userName || payload.messageContext?.conversationName);
    const expectedConversationId = clean(payload.messageContext?.conversationId || payload.messageContext?.conversationKey);
    const sourceContent = clean(payload.sourceContent);
    if (!userName && !expectedConversationId) return { ok: false, reason: 'CONVERSATION_NAME_OR_STABLE_ID_MISSING', navigation, pageCheck };
    let strangerInbox = null;
    if (this.platformCode !== 'douyin' && inboxType !== 'MAIN' && preparedInbox?.handled !== true) return { ok: false, reason: 'INBOX_TYPE_UNSUPPORTED', navigation, pageCheck, inboxType };
    // 正常列表采集的回复也可能仍停留在已打开的聊天面板。
    // 核验稳定会话/消息身份后复用，避免点击被聊天面板覆盖的列表行。
    let currentConversationCheck = null;
    const collectedFromOpenConversation = this.platformCode === 'douyin'
      && (inboxType === 'OPEN_CONVERSATION'
        || clean(payload.messageContext?.collectionSource).toUpperCase() === 'OPEN_CONVERSATION_TIMELINE');
    const canReuseOpenConversation = !requireUnreadEvidence && (collectedFromOpenConversation || (this.platformCode === 'douyin'
      && expectedConversationId
      && clean(payload.platformMessageId || payload.messageContext?.messageId)
      && await this.findReplyEditor(privateScope, true).catch(() => null)));
    if (canReuseOpenConversation) {
      currentConversationCheck = await this.revalidatePrivateReplyTarget(privateScope, payload).catch(error => ({
        ok: false,
        reason: 'OPEN_CONVERSATION_REVALIDATION_FAILED',
        error: clean(error?.message || error)
      }));
      if (currentConversationCheck?.ok) {
        const headerName = clean(currentConversationCheck.header?.headerName) || userName;
        return {
          ok: true,
          navigation,
          pageCheck,
          inboxType,
          strangerInbox,
          conversationName: userName || headerName,
          headerName,
          previewText: sourceContent,
          sourceMessageCount: Number(currentConversationCheck.sourceMessageCount || 0),
          sourceIncomingMessageCount: currentConversationCheck.direction === 'incoming' ? 1 : null,
          sourceMatches: currentConversationCheck.sourceMessage ? [currentConversationCheck.sourceMessage] : [],
          latestMessage: currentConversationCheck.latestMessage || null,
          sourceMessage: currentConversationCheck.sourceMessage || null,
          sourceIsLatest: currentConversationCheck.sourceIsLatest === true,
          timelineStable: currentConversationCheck.timeline?.stable === true,
          conversationId: clean(currentConversationCheck.conversationId) || expectedConversationId || null,
          messageId: clean(currentConversationCheck.messageId) || clean(payload.messageContext?.messageId) || null,
          direction: clean(currentConversationCheck.direction).toLowerCase() || null,
          rowIdentity: null,
          timeline: currentConversationCheck.timeline || null,
          reusedOpenConversation: true,
          currentConversationCheck
        };
      }
    }

    if (typeof this.preparePrivateConversationList === 'function') {
      const listPreparation = await this.preparePrivateConversationList(privateScope, payload);
      if (!listPreparation.ok) return { ok: false, reason: listPreparation.reason, navigation, pageCheck, listPreparation, currentConversationCheck };
    }
    if (this.platformCode === 'douyin') {
      if (inboxType === 'STRANGER') {
        strangerInbox = await this.openDouyinStrangerInbox(page);
        if (!strangerInbox.ok) return { ok: false, reason: strangerInbox.reason, navigation, pageCheck, strangerInbox };
      } else {
        const strangerView = await this.inspectDouyinStrangerInboxView(page);
        if (strangerView.signalVisible) return { ok: false, reason: 'MAIN_INBOX_VIEW_UNVERIFIED', navigation, pageCheck, inboxType, strangerView };
      }
    }
    if (requireUnreadEvidence && this.spec.privateRequireUnreadForReply && payload.messageContext?.unread !== true) {
      return { ok: false, reason: 'PRIVATE_UNREAD_EVIDENCE_REQUIRED', navigation, pageCheck, inboxType };
    }
    const conversationRows = await this.waitForPrivateConversationRows(privateScope, payload, { requireSourcePreview, requireUnreadEvidence });
    if (conversationRows?.deferred === true) {
      return {
        ok: false,
        reason: conversationRows.reason || 'CONVERSATION_LIST_LOADING_TIMEOUT',
        deferred: true,
        navigation,
        pageCheck,
        conversationName: userName,
        listDiagnostics: conversationRows
      };
    }
    const rowSelector = conversationRows.rowSelector || (this.spec.privateConversationRowSelectors || ['[data-e2e="conversation-item"]']).join(',');
    const rows = privateScope.locator(rowSelector);
    const namedRows = conversationRows.namedRows || [];
    const exactRows = conversationRows.exactRows || [];
    if (!namedRows.length) return { ok: false, reason: 'CONVERSATION_NOT_FOUND', navigation, pageCheck, conversationName: userName, currentConversationCheck };
    if (requireSourcePreview && !exactRows.length) return { ok: false, reason: 'SOURCE_PREVIEW_CHANGED', navigation, pageCheck, conversationName: userName, previews: namedRows.map(item => item.candidate.preview) };
    const targets = requireSourcePreview ? exactRows : namedRows;
    if (requireUnreadEvidence && this.spec.privateRequireUnreadForReply && targets.length === 1 && !targets[0].candidate.unread) {
      return { ok: false, reason: 'CONVERSATION_NO_LONGER_UNREAD', navigation, pageCheck, conversationName: userName };
    }
    if (targets.length !== 1) return { ok: false, reason: 'CONVERSATION_TARGET_AMBIGUOUS', navigation, pageCheck, conversationName: userName, matchCount: targets.length };
    const target = targets[0];
    const rowLocator = rows.nth(target.index);
    // Pin the DOM node before the final identity read: a live nth locator can
    // silently point at another recipient when a new message reorders the list.
    const rowHandle = typeof rowLocator.elementHandle === 'function' ? await rowLocator.elementHandle() : null;
    if (typeof rowLocator.elementHandle === 'function' && !rowHandle) {
      return { ok: false, reason: 'CONVERSATION_TARGET_CHANGED', navigation, pageCheck };
    }
    const row = rowHandle || rowLocator;
    let rowIdentity;
    let stableIdFallbackUsed;
    try {
      rowIdentity = await this.readPrivateConversationRowIdentity(row);
      const actualRowConversationId = clean(rowIdentity?.conversationId);
      if (expectedConversationId && actualRowConversationId && actualRowConversationId !== expectedConversationId) {
        return { ok: false, reason: 'CONVERSATION_STABLE_ID_MISMATCH', navigation, pageCheck, expectedConversationId, actualConversationId: actualRowConversationId };
      }
      stableIdFallbackUsed = Boolean(expectedConversationId && !actualRowConversationId);
      await row.click();
    } finally {
      if (rowHandle) await rowHandle.dispose();
    }
    await privateScope.waitForTimeout(1200);

    const expectedHeaderName = clean(target.candidate?.userName) || userName;
    const header = await this.waitForPrivateConversationHeader(privateScope, expectedHeaderName);
    const headerName = clean(header.headerName);
    if (!header.ok) return { ok: false, reason: header.reason, navigation, pageCheck, conversationName: userName, headerName, previewText: target.candidate.preview, headerEvidence: header, rowIdentity };

    // 通过“用户名 + 预览”点开的抖音会话必须在右侧做最终稳定身份核验。
    // 只有原消息 ID、会话 ID、消息文本、来消息方向和当前会话标题全部一致，
    // 才允许后续进入输入与发送环节。
    if (this.platformCode === 'douyin' && stableIdFallbackUsed && requireSourcePreview && sourceContent) {
      const openedConversationCheck = await this.revalidatePrivateReplyTarget(privateScope, payload).catch(error => ({
        ok: false,
        reason: 'OPENED_CONVERSATION_REVALIDATION_FAILED',
        error: clean(error?.message || error)
      }));
      if (!openedConversationCheck?.ok) {
        return {
          ok: false,
          reason: openedConversationCheck?.reason || 'OPENED_CONVERSATION_REVALIDATION_FAILED',
          navigation,
          pageCheck,
          conversationName: userName,
          headerName,
          previewText: target.candidate.preview,
          rowIdentity,
          stableIdFallbackUsed: true,
          openedConversationCheck
        };
      }
      return {
        ok: true,
        navigation,
        pageCheck,
        inboxType,
        strangerInbox,
        conversationName: expectedHeaderName,
        headerName,
        previewText: target.candidate.preview,
        sourceMessageCount: Number(openedConversationCheck.sourceMessageCount || 0),
        sourceIncomingMessageCount: openedConversationCheck.direction === 'incoming' ? 1 : 0,
        sourceMatches: openedConversationCheck.sourceMessage ? [openedConversationCheck.sourceMessage] : [],
        latestMessage: openedConversationCheck.latestMessage || null,
        sourceMessage: openedConversationCheck.sourceMessage || null,
        sourceIsLatest: openedConversationCheck.sourceIsLatest === true,
        timelineStable: openedConversationCheck.timeline?.stable === true,
        conversationId: clean(openedConversationCheck.conversationId) || null,
        messageId: clean(openedConversationCheck.messageId) || null,
        direction: clean(openedConversationCheck.direction).toLowerCase() || null,
        rowIdentity,
        timeline: openedConversationCheck.timeline || null,
        stableIdFallbackUsed: true,
        openedConversationCheck
      };
    }
    let sourceMessageCount = null;
    let sourceIncomingMessageCount = null;
    let sourceMatches = [];
    let latestMessage = null;
    const timeline = await this.inspectStablePrivateConversationTimeline(privateScope);
    if (Array.isArray(timeline.messages) && timeline.messages.length) {
      const exactSource = normalizeReplyTextForComparison(sourceContent);
      sourceMatches = timeline.messages.filter(message => normalizeReplyTextForComparison(message.text) === exactSource);
      sourceMessageCount = sourceMatches.length;
      sourceIncomingMessageCount = sourceMatches.filter(message => message.direction === 'incoming').length;
      latestMessage = timeline.latestMessage || null;
    }
    if (requireSourcePreview && sourceContent) {
      if (sourceMessageCount === null) sourceMessageCount = (await this.countExactPrivateMessages(privateScope, sourceContent)).count;
      if (sourceMessageCount < 1) return { ok: false, reason: 'SOURCE_MESSAGE_NOT_IN_CONVERSATION', navigation, pageCheck, conversationName: userName, headerName, previewText: target.candidate.preview, sourceMessageCount, sourceIncomingMessageCount, timeline };
    }
    const exactLatestSource = timeline.stable === true
      && latestMessage
      && normalizeReplyTextForComparison(latestMessage.text) === normalizeReplyTextForComparison(sourceContent);
    const sourceMessage = exactLatestSource ? latestMessage : sourceMatches.at(-1) || null;
    const conversationId = clean(rowIdentity.conversationId)
      || clean(sourceMessage?.conversationId)
      || this.privateConversationIdFromUrl(privateScope)
      || null;
    return {
      ok: true,
      navigation,
      pageCheck,
      inboxType,
      strangerInbox,
      conversationName: expectedHeaderName,
      headerName,
      previewText: target.candidate.preview,
      sourceMessageCount,
      sourceIncomingMessageCount,
      sourceMatches,
      latestMessage,
      sourceMessage,
      sourceIsLatest: Boolean(exactLatestSource),
      timelineStable: timeline.stable === true,
      conversationId,
      messageId: clean(sourceMessage?.messageId) || null,
      direction: clean(sourceMessage?.direction).toLowerCase() || null,
      rowIdentity,
      timeline
    };
  }

  async resolvePrivateReplyScope(page) {
    return page;
  }

  async findReplyEditor(page, isPrivate) {
    const selectors = isPrivate
      ? (this.spec.privateMessageEditorSelectors || ['[contenteditable="true"]'])
      : ['textarea[placeholder*="\u56de\u590d"]', 'textarea[placeholder*="\u6d88\u606f"]', 'textarea[placeholder*="message" i]', 'textarea[placeholder*="reply" i]', '[contenteditable="true"]'];
    const candidates = selectors.map(selector => page.locator(selector));
    candidates.push(page.getByRole('textbox'));
    return firstUsable(candidates);
  }

  async clickPrivateSend(page, editor) {
    const scopeClass = clean(this.spec.privateEditorScopeSelector || '');
    const row = scopeClass
      ? editor.locator(`xpath=ancestor::*[contains(concat(' ', normalize-space(@class), ' '), ' ${scopeClass.replace(/^\./, '')} ')][1]`)
      : editor.locator('xpath=ancestor::*[contains(@class,"messageMsgInputinputRow")][1]');
    if (!await row.count().catch(() => 0)) return { clicked: false, method: null, reason: 'PRIVATE_EDITOR_ROW_MISSING' };
    for (const selector of this.spec.privateMessageSendSelectors || ['.e2e-send-msg-btn']) {
      const control = await firstUsable([row.locator(selector)], { enabled: true });
      if (!control) continue;
      const evidence = await control.evaluate(element => ({
        text: element.innerText || element.textContent || '',
        ariaLabel: element.getAttribute('aria-label'),
        title: element.getAttribute('title'),
        dataAction: element.getAttribute('data-apm-action'),
        className: String(element.className?.baseVal || element.className || '')
      })).catch(() => ({}));
      if (!isPrivateSendControlEvidence(evidence)) continue;
      await control.click();
      return { clicked: true, method: `scoped-selector:${selector}`, evidence };
    }
    return { clicked: false, method: null, reason: 'PRIVATE_SCOPED_SEND_MISSING' };
  }

  async countExactCommentEchoes(container, text) {
    const exactText = normalizeReplyTextForComparison(text);
    if (!exactText) return 0;
    return container.locator('pre,span,p,div').evaluateAll((elements, value) => {
      const normalize = input => String(input || '').normalize('NFC').replace(/[\u200B\uFEFF\uFE0E\uFE0F]/g, '').replace(/\s+/g, ' ').trim();
      const seen = new Set();
      return elements.filter(element => {
        const style = getComputedStyle(element);
        if (style.display === 'none' || style.visibility === 'hidden' || !element.getClientRects().length) return false;
        if (element.isContentEditable || ['TEXTAREA', 'INPUT'].includes(element.tagName)) return false;
        if (normalize(element.innerText || element.textContent) !== value) return false;
        const identity = element.closest('li,article,[class*="reply" i],[class*="comment" i]') || element;
        if (seen.has(identity)) return false;
        seen.add(identity);
        return true;
      }).length;
    }, exactText).catch(() => 0);
  }

  async editorRemainingValue(editor) {
    const value = await editor.inputValue().catch(async () => await editor.innerText().catch(async () => await editor.textContent().catch(() => '')));
    return clean(String(value || '').normalize('NFC').replace(/[\u200B\uFEFF\uFE0E\uFE0F]/g, ''));
  }

  async waitForReplyEvidence(check, timeoutMs = 10000) {
    const deadline = Date.now() + timeoutMs;
    let last = await check();
    while (!last.confirmed && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 500));
      last = await check();
    }
    return last;
  }

  async replyTargetFailure(payload, page, stage, target, message) {
    const classification = classifyReplyTargetState(target);
    const sourceGone = classification.sourceState === 'SOURCE_GONE';
    const effectiveStage = sourceGone ? 'reply_source_gone' : (classification.sourceState === 'DEFERRED_PAGE_UNAVAILABLE' ? 'reply_page_deferred' : stage);
    return {
      status: sourceGone ? 'CANCELLED' : 'NEEDS_CONFIRMATION',
      result: await this.evidence(payload, sourceGone ? `${this.spec.name}平台当前完整列表中已不存在目标内容，本次回复已永久跳过` : message, page, effectiveStage, {
        target,
        status: classification.sourceState,
        sourceState: classification.sourceState,
        decision: classification.decision,
        retrySafe: classification.retrySafe,
        listVerifiedComplete: classification.listVerifiedComplete
      })
    };
  }

  async revalidatePrivateReplyTarget(page, payload) {
    const userName = clean(payload.userName || payload.messageContext?.conversationName);
    const header = await this.locatePrivateConversationHeader(page, userName);
    if (!header.ok) return { ok: false, reason: header.reason || 'CONVERSATION_HEADER_UNVERIFIED', header };
    if (typeof this.verifyWechatIncomingSource === 'function' && this.platformCode === 'wechat_channels') {
      const incoming = await this.verifyWechatIncomingSource(page, payload);
      if (!incoming.ok) return { ok: false, ...incoming, header };
      return { ok: true, header, incoming };
    }
    const sourceContent = clean(payload.sourceContent);
    if (!sourceContent) return { ok: false, reason: 'SOURCE_MESSAGE_REQUIRED', header };
    if (this.platformCode === 'douyin') {
      const expectedConversationId = clean(payload.conversationId || payload.messageContext?.conversationId || payload.messageContext?.conversationKey);
      const expectedMessageId = clean(payload.platformMessageId || payload.messageContext?.messageId);
      const greetingOnly = isGreetingOnlyMessage(sourceContent);
      if (!expectedConversationId && !greetingOnly) return { ok: false, reason: 'STABLE_CONVERSATION_ID_REQUIRED', header };
      if (!expectedMessageId && !greetingOnly) return { ok: false, reason: 'STABLE_MESSAGE_ID_REQUIRED', header };
      const timeline = await this.inspectStablePrivateConversationTimeline(page);
      const messages = Array.isArray(timeline.messages) ? timeline.messages : [];
      if (timeline.stable !== true) return { ok: false, reason: 'PRIVATE_TIMELINE_UNSTABLE', header, expectedMessageId, timeline };

      // 抖音部分问候私信只能拿到“用户名 + 当前完整消息”，拿不到会话 ID。
      // 这类消息不依赖历史上下文，可以用已校验的会话标题、完整原文和“最新一条来消息”
      // 做一次性发送前核验；普通业务消息仍然必须走稳定会话 ID分支。
      if (!expectedConversationId && greetingOnly) {
        const exactMessages = messages.filter(message => normalizeReplyTextForComparison(message.text) === normalizeReplyTextForComparison(sourceContent));
        const latestMessage = timeline.latestMessage || messages.at(-1) || null;
        if (!latestMessage || normalizeReplyTextForComparison(latestMessage.text) !== normalizeReplyTextForComparison(sourceContent)) {
          return { ok: false, reason: 'SOURCE_MESSAGE_NOT_LATEST_IN_CONVERSATION', header, latestMessage, sourceContent, timeline };
        }
        if (clean(latestMessage.direction).toLowerCase() !== 'incoming') {
          return { ok: false, reason: 'SOURCE_MESSAGE_NOT_INCOMING', header, latestMessage, timeline };
        }
        return {
          ok: true,
          header,
          sourceMessageCount: exactMessages.length,
          conversationId: clean(latestMessage.conversationId) || null,
          messageId: clean(latestMessage.messageId) || null,
          direction: 'incoming',
          sourceIsLatest: true,
          sourceMessage: latestMessage,
          latestMessage,
          timeline,
          greetingOnly: true,
          conversationIdentity: 'VERIFIED_NAME_SOURCE_AND_LATEST_INCOMING'
        };
      }
      const sourceMessage = messages.find(message => clean(message.messageId) === expectedMessageId) || null;
      if (!sourceMessage) return { ok: false, reason: 'SOURCE_MESSAGE_ID_NOT_IN_CONVERSATION', header, expectedMessageId, timeline };
      if (normalizeReplyTextForComparison(sourceMessage.text) !== normalizeReplyTextForComparison(sourceContent)) {
        return { ok: false, reason: 'SOURCE_MESSAGE_TEXT_CHANGED', header, expectedMessageId, sourceMessage, timeline };
      }
      if (clean(sourceMessage.direction).toLowerCase() !== 'incoming') {
        return { ok: false, reason: 'SOURCE_MESSAGE_NOT_INCOMING', header, expectedMessageId, sourceMessage, timeline };
      }
      const liveConversationId = clean(sourceMessage.conversationId) || this.privateConversationIdFromUrl(page);
      if (!liveConversationId || liveConversationId !== expectedConversationId) {
        return { ok: false, reason: 'CONVERSATION_ID_MISMATCH', header, expectedConversationId, liveConversationId: liveConversationId || null, sourceMessage, timeline };
      }
      const latestMessage = timeline.latestMessage || messages.at(-1) || null;
      if (!latestMessage || clean(latestMessage.messageId) !== expectedMessageId || clean(latestMessage.direction).toLowerCase() !== 'incoming') {
        return { ok: false, reason: 'SOURCE_MESSAGE_NOT_LATEST_IN_CONVERSATION', header, expectedMessageId, latestMessage, sourceMessage, timeline };
      }
      return {
        ok: true,
        header,
        sourceMessageCount: 1,
        conversationId: liveConversationId,
        messageId: expectedMessageId,
        direction: 'incoming',
        sourceIsLatest: true,
        sourceMessage,
        latestMessage,
        timeline
      };
    }
    const sourceMessageCount = (await this.countExactPrivateMessages(page, sourceContent)).count;
    if (sourceMessageCount < 1) return { ok: false, reason: 'SOURCE_MESSAGE_NOT_IN_CONVERSATION', header, sourceMessageCount };
    return { ok: true, header, sourceMessageCount };
  }

  async replyToMessage(payload) {
    const eligibility = assessAutoReplyEligibility(payload, { phase: 'send' });
    if (!eligibility.allowed) return { status: 'NEEDS_CONFIRMATION', result: await this.evidence(payload, `自动回复目标证据不足：${eligibility.reason}`, null, 'reply_eligibility_blocked', { eligibility }) };
    const replyText = clean(payload.replyText);
    if (!replyText) return { status: 'NEEDS_CONFIRMATION', result: await this.evidence(payload, '\u81ea\u52a8\u56de\u590d\u5185\u5bb9\u4e3a\u7a7a\uff0c\u5df2\u7981\u6b62\u53d1\u9001', null, 'reply_empty') };
    const isPrivate = String(payload.messageType).toUpperCase() === 'PRIVATE_MESSAGE';
    const lengthCheck = validateReplyTextLength({ platformCode: this.platformCode, messageType: payload.messageType, text: replyText });
    if (!lengthCheck.ok) {
      return {
        status: 'NEEDS_CONFIRMATION',
        result: await this.evidence(payload, lengthCheck.message, null, 'reply_length_blocked', {
          characterCount: lengthCheck.count,
          characterLimit: lengthCheck.limit,
          replyPolicy: lengthCheck.policy
        })
      };
    }
    const isDouyin = this.platformCode === 'douyin';
    const isScopedPrecision = Boolean(this.spec.strictScopedReply) || isDouyin;
    const precision = assessDouyinPrivatePreview({ platformCode: this.platformCode, messageType: payload.messageType, messageContext: payload.messageContext });
    if (!precision.ok) return { status: 'NEEDS_CONFIRMATION', result: await this.evidence(payload, precision.message, null, 'reply_private_preview_blocked', { precision }) };
    const page = await this.getPage();
    let privateScope = page;
    let privateTarget = null;
    let commentTarget = null;
    let editor = null;
    let commentEditor = null;
    let commentSearchDeadline = null;
    let baselineEchoCount = 0;

    if (isPrivate) {
      privateTarget = await this.openPrivateConversationForPayload(page, payload, { requireSourcePreview: true, requireUnreadEvidence: false });
      if (!privateTarget.ok) return this.replyTargetFailure(payload, page, 'reply_target_missing', privateTarget, `\u672a\u53ef\u9760\u5b9a\u4f4d${this.spec.name}\u79c1\u4fe1\u4f1a\u8bdd\uff0c\u5df2\u505c\u6b62\u81ea\u52a8\u56de\u590d`);
      privateScope = await this.resolvePrivateReplyScope(page, privateTarget);
      editor = await this.findReplyEditor(privateScope, true);
      if (!editor) return { status: 'NEEDS_CONFIRMATION', result: await this.evidence(payload, `\u672a\u627e\u5230${this.spec.name}\u79c1\u4fe1\u56de\u590d\u8f93\u5165\u6846\uff0c\u5df2\u505c\u6b62\u53d1\u9001`, page, 'reply_editor_missing', { privateTarget }) };
      if (isScopedPrecision) baselineEchoCount = (await this.countExactPrivateMessages(privateScope, replyText, { outgoingOnly: true, editor })).count;
    } else {
      const targetUrl = isDouyin ? this.spec.commentUrl : (clean(payload.externalUrl) || this.spec.commentUrl);
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      const replyPageState = await this.waitForDetectedPageState(page, this.spec.replyReadyTimeoutMs || 10000);
      if (replyPageState !== 'READY') return { status: 'NEEDS_CONFIRMATION', result: await this.evidence(payload, `${this.spec.name}\u767b\u5f55\u72b6\u6001\u672a\u53ef\u9760\u786e\u8ba4\uff0c\u65e0\u6cd5\u53d1\u9001\u56de\u590d`, page, 'reply_login_required', { pageState: replyPageState }) };
      if (isScopedPrecision) {
        const readiness = await this.waitForMessageContentReady(page, 'COMMENT');
        if (!readiness.ready) return this.replyTargetFailure(payload, page, 'reply_comment_list_unready', { reason: readiness.reason, readiness }, `${this.spec.name}\u8bc4\u8bba\u5217\u8868\u672a\u53ef\u9760\u52a0\u8f7d\uff0c\u5df2\u505c\u6b62\u81ea\u52a8\u56de\u590d`);
        const commentPageCheck = readiness.pageCheck || (typeof page.url === 'function'
          ? await this.classifyLiveMessagePage(page, 'COMMENT')
          : { valid: true, reason: 'PAGE_URL_API_UNAVAILABLE' });
        if (isDouyin && !commentPageCheck.valid) return { status: 'NEEDS_CONFIRMATION', result: await this.evidence(payload, `${this.spec.name}\u8bc4\u8bba\u9875\u8eab\u4efd\u6821\u9a8c\u5931\u8d25\uff0c\u5df2\u505c\u6b62\u81ea\u52a8\u56de\u590d`, page, 'reply_comment_page_mismatch', { readiness, commentPageCheck, expectedUrl: this.spec.commentUrl }) };
        if (isDouyin && typeof page.locator === 'function' && typeof this.openDouyinCommentVideoForPayload === 'function') {
          commentSearchDeadline = Date.now() + 16000;
          const videoTarget = await this.openDouyinCommentVideoForPayload(page, payload, { deadlineAt: commentSearchDeadline });
          if (!videoTarget.ok) return this.replyTargetFailure(payload, page, 'reply_comment_video_missing', videoTarget, '\u672a\u53ef\u9760\u5b9a\u4f4d\u6296\u97f3\u8bc4\u8bba\u6240\u5c5e\u4f5c\u54c1\uff0c\u5df2\u505c\u6b62\u81ea\u52a8\u56de\u590d');
        }
        if (this.platformCode === 'wechat_channels') {
          commentSearchDeadline = Date.now() + 12000;
          const videoTarget = await this.openWechatCommentVideoForPayload(page, payload, { deadlineAt: commentSearchDeadline });
          if (!videoTarget.ok) return this.replyTargetFailure(payload, page, 'reply_comment_video_missing', videoTarget, '\u672a\u53ef\u9760\u5b9a\u4f4d\u89c6\u9891\u53f7\u8bc4\u8bba\u6240\u5c5e\u4f5c\u54c1\uff0c\u5df2\u505c\u6b62\u81ea\u52a8\u56de\u590d');
        }
      }
      const commentLocateOptions = commentSearchDeadline
        ? { timeBudgetMs: Math.max(1000, commentSearchDeadline - Date.now()) }
        : {};
      commentTarget = await this.locateMessageContainerWithRetry(page, payload, commentLocateOptions);
      if (!commentTarget.ok || !commentTarget.locator) {
        return this.replyTargetFailure(payload, page, 'reply_target_missing', commentTarget, `\u672a\u53ef\u9760\u5b9a\u4f4d${this.spec.name}\u76ee\u6807\u6d88\u606f\uff0c\u5df2\u505c\u6b62\u81ea\u52a8\u56de\u590d`);
      }
      const container = commentTarget.locator;
      const configuredReplyTriggers = (this.spec.commentReplyTriggerSelectors || []).map(selector => container.locator(selector));
      const replyTrigger = await firstUsable([
        ...configuredReplyTriggers,
        container.getByText(/^\u56de\u590d$/, { exact: true }),
        container.getByRole('button', { name: /^\u56de\u590d$/ })
      ]);
      if (!replyTrigger) return { status: 'NEEDS_CONFIRMATION', result: await this.evidence(payload, `${this.spec.name}\u76ee\u6807\u8bc4\u8bba\u7f3a\u5c11\u5c40\u90e8\u56de\u590d\u5165\u53e3\uff0c\u5df2\u505c\u6b62\u53d1\u9001`, page, 'reply_trigger_missing', { commentTarget }) };
      baselineEchoCount = isScopedPrecision ? await this.countExactCommentEchoes(container, replyText) : 0;
      if (isScopedPrecision && baselineEchoCount > 0) {
        return {
          status: 'SUCCESS',
          result: await this.evidence(payload, `${this.spec.name}目标评论线程已存在完全相同的己方回复，本次未再次点击发送`, page, 'reply_already_replied', {
            alreadyReplied: true, sent: false, scopedEchoCount: baselineEchoCount, baselineEchoCount,
            commentTarget: { ok: commentTarget.ok, identity: commentTarget.identity, index: commentTarget.index }
          })
        };
      }
      await this.assertRuntimeAllowed();
      await replyTrigger.click();
      await page.waitForTimeout(500);
      if (isScopedPrecision) {
        const afterClickIdentity = matchDouyinCommentIdentity(await this.readDouyinCommentCandidate(container) || {}, payload);
        if (!afterClickIdentity.matched) return { status: 'NEEDS_CONFIRMATION', result: await this.evidence(payload, '\u70b9\u51fb\u56de\u590d\u540e\u76ee\u6807\u8bc4\u8bba\u8eab\u4efd\u53d1\u751f\u53d8\u5316\uff0c\u5df2\u505c\u6b62\u53d1\u9001', page, 'reply_target_changed', { afterClickIdentity }) };
        commentEditor = await this.findDouyinCommentEditor(page, payload, container);
        if (!commentEditor.ok) return { status: 'NEEDS_CONFIRMATION', result: await this.evidence(payload, `${this.spec.name}\u8bc4\u8bba\u56de\u590d\u8f93\u5165\u6846\u65e0\u6cd5\u7cbe\u786e\u6821\u9a8c\uff0c\u5df2\u505c\u6b62\u53d1\u9001`, page, 'reply_editor_missing', { commentEditor }) };
        editor = commentEditor.editor;
        const expandedEchoCount = await this.countExactCommentEchoes(container, replyText);
        if (expandedEchoCount > 0) {
          return {
            status: 'SUCCESS',
            result: await this.evidence(payload, `${this.spec.name}展开目标评论回复区后发现完全相同的己方回复，本次未再次点击发送`, page, 'reply_already_replied', {
              alreadyReplied: true, sent: false, scopedEchoCount: expandedEchoCount, baselineEchoCount,
              commentTarget: { ok: commentTarget.ok, identity: commentTarget.identity, index: commentTarget.index }
            })
          };
        }
      } else editor = await this.findReplyEditor(page, false);
    }

    if (!editor) return { status: 'NEEDS_CONFIRMATION', result: await this.evidence(payload, `\u672a\u627e\u5230${this.spec.name}\u56de\u590d\u8f93\u5165\u6846\uff0c\u5df2\u505c\u6b62\u81ea\u52a8\u53d1\u9001`, page, 'reply_editor_missing', { privateTarget, commentTarget }) };
    let fillResult = { method: 'fill' };
    try {
      if (isPrivate && typeof this.fillPrivateReplyEditor === 'function') {
        fillResult = await this.fillPrivateReplyEditor(editor, replyText) || { method: 'private-editor-hook' };
      } else {
        await fillLocator(editor, replyText);
      }
    } catch (error) {
      return {
        status: 'NEEDS_CONFIRMATION',
        result: await this.evidence(payload, `${this.spec.name}\u56de\u590d\u8f93\u5165\u5931\u8d25\uff0c\u5df2\u7981\u6b62\u70b9\u51fb\u53d1\u9001`, page, 'reply_fill_failed', {
          privateTarget,
          commentTarget,
          fillMethod: clean(fillResult?.method) || null,
          error: clean(error?.message)
        })
      };
    }
    const filledValue = await this.editorRemainingValue(editor);
    if (normalizeReplyTextForComparison(filledValue) !== normalizeReplyTextForComparison(replyText)) return { status: 'NEEDS_CONFIRMATION', result: await this.evidence(payload, `${this.spec.name}\u56de\u590d\u8f93\u5165\u5185\u5bb9\u6821\u9a8c\u5931\u8d25\uff0c\u5df2\u7981\u6b62\u70b9\u51fb\u53d1\u9001`, page, 'reply_fill_mismatch', { expected: replyText, actual: filledValue, fillMethod: clean(fillResult?.method) || null }) };
    const liveTarget = isPrivate
      ? await this.revalidatePrivateReplyTarget(privateScope, payload)
      : (isScopedPrecision ? matchDouyinCommentIdentity(await this.readDouyinCommentCandidate(commentTarget.locator) || {}, payload) : { matched: true });
    const liveTargetOk = isPrivate ? liveTarget.ok === true : liveTarget.matched === true;
    if (!liveTargetOk) {
      await fillLocator(editor, '').catch(() => {});
      return this.replyTargetFailure(payload, page, 'reply_target_changed_before_send', { ...liveTarget, reason: liveTarget.reason || 'TARGET_CHANGED_BEFORE_SEND' }, `${this.spec.name}\u56de\u590d\u76ee\u6807\u5728\u53d1\u9001\u524d\u65e0\u6cd5\u518d\u6b21\u7cbe\u786e\u786e\u8ba4\uff0c\u5df2\u6e05\u7a7a\u8f93\u5165\u5e76\u7981\u6b62\u53d1\u9001`);
    }
    const send = isPrivate
      ? await this.clickPrivateSend(privateScope, editor)
      : (isScopedPrecision ? await this.clickDouyinCommentSend(commentEditor.root) : { clicked: await clickByLabels(page, ['\u53d1\u9001', '\u56de\u590d', 'Send', 'Reply']), method: 'label' });
    if (!send.clicked) return { status: 'NEEDS_CONFIRMATION', result: await this.evidence(payload, `${this.spec.name}\u56de\u590d\u5185\u5bb9\u5df2\u586b\u5165\uff0c\u4f46\u672a\u627e\u5230\u4e0e\u8be5\u8f93\u5165\u6846\u540c\u533a\u57df\u7684\u53d1\u9001\u63a7\u4ef6`, page, 'reply_send_missing', { privateTarget, commentTarget, send, fillMethod: clean(fillResult?.method) || null }) };

    if (isScopedPrecision) {
      const phoneCheckPattern = toRegex(this.spec.privatePhoneCheckTextPattern, null);
      const confirmation = await this.waitForReplyEvidence(async () => {
        const remaining = await this.editorRemainingValue(editor);
        const scoped = isPrivate
          ? await this.countExactPrivateMessages(privateScope, replyText, { outgoingOnly: true, editor })
          : { count: await this.countExactCommentEchoes(commentTarget.locator, replyText), matches: [] };
        const pageText = phoneCheckPattern ? await pageEvidenceText(privateScope) : '';
        const phoneCheckBlocked = Boolean(phoneCheckPattern && phoneCheckPattern.test(pageText));
        return {
          confirmed: !phoneCheckBlocked && !remaining && scoped.count > baselineEchoCount,
          phoneCheckBlocked,
          editorCleared: !remaining,
          scopedEchoCount: scoped.count,
          baselineEchoCount,
          echoDetector: scoped.detector || (isPrivate ? 'MESSAGE_TEXT' : 'COMMENT_THREAD'),
          bubbleEvidence: scoped.bubbleEvidence || null,
          matches: scoped.matches || []
        };
      }, isPrivate ? (this.spec.privateReplyEvidenceTimeoutMs || 10000) : 10000);
      if (confirmation.phoneCheckBlocked) return { status: 'NEEDS_CONFIRMATION', result: await this.evidence(payload, `${this.spec.name}\u89e6\u53d1\u624b\u673a\u53f7\u7ed1\u5b9a\u6216\u53d1\u9001\u9650\u5236\uff0c\u672a\u786e\u8ba4\u53d1\u9001\u6210\u529f\uff0c\u8bf7\u4eba\u5de5\u5904\u7406\u4e14\u4e0d\u8981\u81ea\u52a8\u91cd\u8bd5`, page, 'reply_phone_binding_required', { privateTarget, sendMethod: send.method, sendEvidence: send.evidence || null, fillMethod: clean(fillResult?.method) || null, ...confirmation }) };
      if (confirmation.confirmed) {
        const successEvidence = await this.evidence(payload, `${this.spec.name}\u81ea\u52a8\u56de\u590d\u5df2\u53d1\u9001\uff0c\u4e14\u5df2\u5728\u76ee\u6807${isPrivate ? '\u79c1\u4fe1\u4f1a\u8bdd\u7684\u5df1\u65b9\u6d88\u606f\u6c14\u6ce1' : '\u8bc4\u8bba\u7ebf\u7a0b'}\u4e2d\u68c0\u6d4b\u5230\u7cbe\u786e\u56de\u663e`, page, 'reply_sent', { privateTarget, commentTarget: commentTarget ? { ok: commentTarget.ok, identity: commentTarget.identity, index: commentTarget.index } : null, sendMethod: send.method, sendEvidence: send.evidence || null, ...confirmation });
        const postReplyExit = isPrivate && typeof this.afterPrivateReplyConfirmed === 'function'
          ? await this.afterPrivateReplyConfirmed(page, { payload, privateScope, privateTarget, confirmation }).catch(error => ({ attempted: true, exited: false, reason: 'POST_REPLY_EXIT_FAILED', error: clean(error?.message || error) }))
          : null;
        return { status: 'SUCCESS', result: { ...successEvidence, ...(postReplyExit ? { postReplyExit } : {}) } };
      }
      return { status: 'NEEDS_CONFIRMATION', result: await this.evidence(payload, `\u5df2\u70b9\u51fb${this.spec.name}\u53d1\u9001\uff0c\u4f46\u76ee\u6807${isPrivate ? '\u79c1\u4fe1\u4f1a\u8bdd' : '\u8bc4\u8bba\u7ebf\u7a0b'}\u5185\u6ca1\u6709\u68c0\u6d4b\u5230\u65b0\u589e\u7cbe\u786e\u56de\u663e\uff0c\u8bf7\u4eba\u5de5\u6838\u5bf9\u4e14\u4e0d\u8981\u81ea\u52a8\u91cd\u8bd5`, page, 'reply_unconfirmed', { privateTarget, sendMethod: send.method, sendEvidence: send.evidence || null, fillMethod: clean(fillResult?.method) || null, ...confirmation }) };
    }

    await page.waitForTimeout(1500);
    const remaining = await this.editorRemainingValue(editor);
    const pageText = await bodyText(page);
    const exactEchoes = page.getByText(replyText, { exact: true });
    const echoCount = await exactEchoes.count().catch(() => 0);
    let sentEcho = false;
    for (let index = 0; index < echoCount; index += 1) {
      if (await exactEchoes.nth(index).isVisible().catch(() => false)) { sentEcho = true; break; }
    }
    const replySuccessPattern = this.spec.replySuccessPattern ? toRegex(this.spec.replySuccessPattern, null) : null;
    if ((!remaining && sentEcho) || (replySuccessPattern && replySuccessPattern.test(pageText))) return { status: 'SUCCESS', result: await this.evidence(payload, `${this.spec.name}\u81ea\u52a8\u56de\u590d\u5df2\u53d1\u9001\uff0c\u5e76\u68c0\u6d4b\u5230\u53ef\u9760\u56de\u663e`, page, 'reply_sent', { sendMethod: send.method, editorCleared: !remaining, exactEchoVisible: sentEcho }) };
    return { status: 'NEEDS_CONFIRMATION', result: await this.evidence(payload, `\u5df2\u70b9\u51fb${this.spec.name}\u53d1\u9001\uff0c\u4f46\u672a\u68c0\u6d4b\u5230\u53ef\u9760\u6210\u529f\u4fe1\u53f7\uff0c\u8bf7\u4eba\u5de5\u6838\u5bf9\u4e14\u4e0d\u8981\u81ea\u52a8\u91cd\u8bd5`, page, 'reply_unconfirmed', { sendMethod: send.method, editorCleared: !remaining, exactEchoVisible: sentEcho }) };
  }

  async detectManualReply(payload) {
    const expectedReply = clean(payload.expectedReply);
    if (!expectedReply) return { status: 'NEEDS_CONFIRMATION', result: { handled: false, message: '\u7f3a\u5c11\u9700\u8981\u6838\u9a8c\u7684\u4eba\u5de5\u56de\u590d\u5185\u5bb9' } };
    const page = await this.getPage();
    const isPrivate = String(payload.messageType).toUpperCase() === 'PRIVATE_MESSAGE';
    if (isPrivate) {
      const privateTarget = await this.openPrivateConversationForPayload(page, payload, { requireSourcePreview: false, requireUnreadEvidence: false });
      if (!privateTarget.ok) return { status: 'NEEDS_CONFIRMATION', result: await this.evidence(payload, `\u672a\u53ef\u9760\u5b9a\u4f4d${this.spec.name}\u79c1\u4fe1\u4f1a\u8bdd\uff0c\u65e0\u6cd5\u68c0\u6d4b\u4eba\u5de5\u56de\u590d`, page, 'manual_detect_target_missing', { handled: false, privateTarget }) };
    } else {
      const targetUrl = this.platformCode === 'douyin' ? this.spec.commentUrl : (clean(payload.externalUrl) || this.spec.commentUrl);
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(1200);
      if (await this.detectPageState(page) !== 'READY') return { status: 'NEEDS_CONFIRMATION', result: await this.evidence(payload, `${this.spec.name}\u767b\u5f55\u5931\u6548\uff0c\u65e0\u6cd5\u68c0\u6d4b\u4eba\u5de5\u56de\u590d`, page, 'manual_detect_login_required', { handled: false }) };
    }
    const exact = page.getByText(expectedReply, { exact: true });
    const count = await exact.count().catch(() => 0);
    let handled = false;
    for (let index = 0; index < count; index += 1) {
      if (await exact.nth(index).isVisible().catch(() => false)) { handled = true; break; }
    }
    const result = await this.evidence(payload, handled ? `\u5df2\u5728${this.spec.name}\u9875\u9762\u68c0\u6d4b\u5230\u6307\u5b9a\u4eba\u5de5\u56de\u590d` : `\u672a\u5728${this.spec.name}\u5f53\u524d\u4f1a\u8bdd\u68c0\u6d4b\u5230\u6307\u5b9a\u4eba\u5de5\u56de\u590d`, page, 'manual_reply_detected', { handled });
    return { status: 'SUCCESS', result };
  }

  async evidence(payload, message, page, stage, extra = {}) {
    const stamp = new Date().toISOString();
    const safeStamp = stamp.replace(/[:.]/g, '-');
    let screenshotPath = null;
    if (page) {
      screenshotPath = path.join(this.logsDir, `${this.platformCode}-${stage}-${safeStamp}.png`);
      await page.screenshot({ path: screenshotPath, fullPage: false }).catch(() => { screenshotPath = null; });
    }
    const record = {
      stamp,
      stage,
      message,
      platformCode: this.platformCode,
      profileName: payload.profileName,
      url: page?.url?.() || null,
      screenshotPath,
      ...extra,
      payload: { ...payload, replyText: payload.replyText ? '[REDACTED_REPLY_TEXT]' : undefined }
    };
    const evidencePath = path.join(this.logsDir, `${this.platformCode}-rpa-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
    fs.writeFileSync(evidencePath, JSON.stringify(record, null, 2), 'utf8');
    return { message, stage, evidencePath, screenshotPath, platformCode: this.platformCode, profileName: payload.profileName, completedAt: stamp, ...extra };
  }
}















