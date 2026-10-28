import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config, ROOT } from './config.js';
import { db, immediateTransaction, json, now, row, rows } from './db.js';
import { miniProgramProcessingLockHeld, miniProgramProcessingTransaction, runWithMiniProgramProcessingClaim as run, safeMiniProgramProcessingError } from './services/mini-program-processing-context.js';
import { searchKnowledge } from './services/knowledge.js';
import { composeReply, selectKnowledgeForReply, testAiConnection } from './services/qwen.js';
import { detectRisk, validateReply } from './services/decision.js';
import { assessDouyinPrivatePreview } from './services/message-precision.js';
import { isSameDouyinPrivateOccurrence } from './services/douyin-message-identity.js';
import { assessCollectedPrivatePlatformReply } from './services/private-platform-reply-evidence.js';
import { assessWeiboMessagePrecision } from './services/weibo-message-precision.js';
import { assessWeiboConversationSource } from './services/weibo-message-source.js';
import { hasReliableWeiboReplyEvidence } from './services/weibo-reply-evidence.js';
import { countHandoffNotifications, listHandoffNotifications, notify, startNotificationOutboxWorker, stopNotificationOutboxWorker } from './services/notification.js';
import { beginConversationHandoff, conversationAutomationDisabled, markHumanFollowupMessage } from './services/conversation-control.js';
import { buildManualNotification, resolveRelatedNote } from './services/manual-notification.js';
import { MINI_PROGRAM_PLATFORM_CODE, requestMiniProgramHandoff } from './services/mini-program-channel.js';
import { proxyWechatAdmin } from './services/wechat-admin-proxy.js';
import { handleModelGateway } from './services/model-gateway.js';
import { getAiSignalIntegration } from './services/ai-signal-integration.js';
import { createAiSignalProxy, isAiSignalProxyPath } from './services/ai-signal-proxy.js';
import { getCreativeWorkbenchStatus } from './services/creative-workbench.js';
import { createContentLibrary, ContentLibraryError } from './services/content-library.js';
import { createStudioOutputLibrary, createStudioOutputSource } from './services/content-library-studio.js';
import { createVideoStudioProxy } from './services/video-studio-proxy.js';
import { enqueueMiniProgramReply, startMiniProgramCallbackWorker, stopMiniProgramCallbackWorker } from './services/mini-program-callback.js';
import { MINI_PROGRAM_MESSAGE_PATH, cleanupExpiredMiniProgramNonces, startMiniProgramNonceCleanupWorker, stopMiniProgramNonceCleanupWorker } from './services/mini-program-auth.js';
import { startMiniProgramProcessingWorker, stopMiniProgramProcessingWorker } from './services/mini-program-processing.js';
import { handleMiniProgramOpenMessage } from './services/mini-program-http.js';
import { MiniProgramAdminError, getMiniProgramStatus, listMiniProgramConversations, getMiniProgramConversationMessages, handoffMiniProgramConversation, retryMiniProgramNotification, retryMiniProgramCallback } from './services/mini-program-admin.js';
import { describeAiReplyFailure, isAiReplyTimeout } from './services/ai-reply-error.js';
import { randomIntervalMs } from './services/polling.js';
import { clearAiApiKey, clearWecomWebhookUrl, getAiSettings, getAiSettingsSummary, getMasterSwitch, getMessageCollectionSettings, getPlatformSmartReply, getPlatformSmartReplyMap, getWecomSettingsSummary, saveAiSettings, saveMasterSwitch, saveMessageCollectionSettings, savePlatformSmartReply, saveWecomWebhookUrl } from './services/settings.js';
import { aiUsageOverview, listAiCallLogs, recordAiCall } from './services/ai-usage.js';
import { deleteMaterialKnowledgeDraft, getMaterialKnowledgeDraft, listMaterialKnowledgeDrafts, markMaterialKnowledgeDraftFailed, markMaterialKnowledgeDraftImported, markMaterialKnowledgeDraftImporting, saveMaterialKnowledgeDraft, updateMaterialKnowledgeDraft } from './services/material-knowledge-drafts.js';
import { validatePublishPrecheck } from './services/publish-validation.js';
import { reviewPublishContent } from './services/content-compliance.js';
import { buildMockAiReview, validateAiReviewApproval } from './services/ai-compliance.js';
import { buildPublishIdempotencyKey, deriveTaskStatus, hashString } from './services/workflow.js';
import { commitKnowledgeImport, knowledgeImportTemplateCsv, listKnowledgeImports, previewKnowledgeImport } from './services/knowledge-import.js';
import { getKnowledgeImportPreview, queueKnowledgeImportMetadataEnrichment } from './services/knowledge-import-enrichment.js';
import { suggestKnowledgeMetadata } from './services/knowledge-metadata-suggestion.js';
import { DEFAULT_KNOWLEDGE_SUBCATEGORY, PUBLIC_KNOWLEDGE_CATEGORY, SYSTEM_KNOWLEDGE_CATEGORIES, knowledgeCategoryForPlatform, knowledgeCategorySortIndex, resolveKnowledgeCategory, resolveKnowledgeSubcategory, validateKnowledgeCategoryName, validateKnowledgeSubcategoryName } from './services/knowledge-category.js';
import { listKnowledgeSubcategoryCache, removeKnowledgeSubcategoryCache, touchKnowledgeSubcategory } from './services/knowledge-subcategory-cache.js';
import { PLATFORM_REPLY_LIMITS, countUnicodeCharacters, getReplyLimit, validateKnowledgeAnswerLength, validateReplyTextLength } from './services/platform-reply-policy.js';
import { isRepeatedCommentOccurrence, repeatedExternalId, sameStableCommentIdentity } from './services/message-occurrence.js';
import { buildMessageProcessingIdentity } from './services/message-processing-identity.js';
import { buildReplyIdempotencyKey, isSameDouyinCommentSemanticCandidate } from './services/comment-identity.js';
import { checkLocalAgentHealth, ensureLocalAgentOnline, shutdownLocalAgent } from './services/local-agent-process.js';
import { isConfirmedLoginExpired, buildLoginExpiredNotification } from './services/login-alert.js';
import { normalizeContentOrigin } from './services/content-origin.js';
import { hasReliablePublishEvidence } from './services/publish-attestation.js';
import {
  publishVerificationPolicy,
  shouldScheduleUnconfirmedPublishVerification,
  validatePlatformResultProvenance,
  validatePublishTargetIdentity
} from './services/publish-verification-policy.js';
import { isPlatformRuntimeEnabled, platformRuntimeMap, platformRuntimeRows } from './services/platform-runtime.js';
import { ensureIssueBlock, issueContext, jobBlockedByRuntime, parsedDiagnosis, releaseIssueBlocks, runtimeBlockSummary } from './services/runtime-blocks.js';
import { diagnoseIssue } from './services/issue-diagnosis.js';
import { assessCollectedMessageIdentity } from './services/message-sender-identity.js';
import { clearSessionCookie, createSessionToken, credentialsMatch, revokeSessionFromRequest, sessionCookie, sessionFromRequest } from './services/auth.js';
import { acquireInstanceLock } from './services/instance-lock.js';
import { browserControlSummary, completeBrowserCommand, createBrowserCommand, deferBrowserCommand, getBrowserCommand, listBrowserCommands, markBrowserCommandClaimed } from './services/browser-command.js';
import { isBrowserCommandNonIdempotent } from './services/browser-control-policy.js';
import { assessAutoReplyEligibility } from './services/auto-reply-eligibility.js';
import { isRecoveryJobTypeClaimable } from './services/recovery-publish-safety.js';
import { isOldConversationRecoveryJob, priorityForJob } from './services/job-priority.js';
import { eligibleForRecoveryScan, hasIncrementalConversationWork, recoveryConversationIds } from './services/conversation-recovery-policy.js';
import { buildRecoveryGroups, recoveryTargets } from './services/conversation-recovery-scheduler.js';
import { upsertPlatformContentInventory } from './services/platform-content-inventory.js';
import { resolveManagedCommentTarget } from './services/managed-comment-target.js';
import { buildMessageReplyCsv, messageReplyExportFilename } from './services/message-export.js';
import { composeGroundedMultiReply, detectGreetingIntent, detectManualHandoffCommand, GREETING_REPLY, HANDOFF_NOT_FOUND_REPLY, knowledgeGapReply, normalizeManualHandoffPhrase, splitUserQuestions } from './services/conversation-intent.js';
import { deleteKnowledgeAlias, listKnowledgeAliases, listKnowledgeAliasTasks, queueKnowledgeAliasGeneration, setKnowledgeAliasSelections, setKnowledgeAliasStatus, startKnowledgeAliasWorker } from './services/knowledge-alias.js';
import { deleteManualHandoffAlias, listManualHandoffAliases, listManualHandoffAliasTasks, queueManualHandoffAliasGeneration, setManualHandoffAliasSelections, setManualHandoffAliasStatus, startManualHandoffAliasWorker } from './services/manual-handoff-alias.js';
import { evaluateReply } from './services/reply-engine.js';
import { MESSAGE_ROUTE, outerRouteReplyResult, routeIncomingMessage } from './services/message-router.js';
import { enabledManualHandoffPhrases } from './services/manual-handoff-phrases.js';
import { RagClient } from './services/rag-client.js';
import { buildFormalRagRequest, formalRagReplyResult, routeBusinessClarification, validateFormalRagResponseSnapshot } from './services/formal-rag-routing.js';
import { enforceBusinessGuidanceLimit, nextBusinessGuidanceAttempt, businessGuidanceProgress } from './services/conversation-policy.js';
import { backfillMessageConversations, conversationForMessage, ensureMessageConversation, isMessageConversationCurrent, recentConversationMessages, withConversationSerial } from './services/conversation-store.js';
import { buildCollectionChannelPlans, collectionPlanAlreadyActive, platformChannelSplitEnabled } from './services/channel-job-scheduler.js';
import { collectionLedgerChannels, persistCollectedMessageLedger, persistCollectedMessageRuntimeStates } from './services/collection-message-ledger.js';
import { claimPendingReplyBatchForGeneration, replyBatchSourceEvents, requeueReplyBatchGeneration } from './services/message-event-store.js';
import { createXiaozhiSession, deleteXiaozhiSession, getXiaozhiOptions, getXiaozhiTestAnswerHistory, getXiaozhiTestAnswers, runXiaozhiChat, updateXiaozhiTestAnswerDecision } from './services/xiaozhi-test-service.js';
import { getDisabledXiaozhiKnowledgeIds, getXiaozhiProductionKnowledgePolicy } from './services/xiaozhi-test-decisions.js';

const BUILTIN_MANUAL_HANDOFF_EXAMPLES = Object.freeze([
  '转人工', '帮我转人工', '帮我转个人工', '我要人工回复', '请帮我转接一下客服', '给我找一位工作人员'
]);


function manualHandoffPhraseInput(value) {
  const phrase = String(value || '').normalize('NFC').replace(/\s+/g, ' ').trim();
  if (!phrase) throw new Error('转人工说法不能为空');
  const characterCount = countUnicodeCharacters(phrase);
  if (characterCount < 2) throw new Error('转人工说法至少需要2个字符');
  if (characterCount > 80) throw new Error('转人工说法不能超过80个字符');
  const normalizedPhrase = normalizeManualHandoffPhrase(phrase);
  if (normalizedPhrase.length < 2) throw new Error('转人工说法不能只包含标点或空格');
  return { phrase, normalizedPhrase, characterCount };
}

const publicDir = path.join(ROOT, 'public');
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };
const terminalMessageStatuses = new Set(['AUTO_REPLIED', 'MANUAL_HANDLED', 'CLOSED', 'IGNORED_SELF', 'IGNORED_OFFICIAL', 'SOURCE_GONE', 'SUPERSEDED']);


function v2ReplyChannelEnabled(platformCode, channelType) {
  const normalizedChannel = String(channelType || '').trim().toUpperCase();
  if (!config.messageEventLedgerEnabled || !platformChannelSplitEnabled(platformCode, config)) return false;
  if (normalizedChannel === 'PRIVATE_MESSAGE') {
    return config.privateReconciliationEnabled
      && config.privateLiveRecheckEnabled
      && config.privateAutoSendV2Enabled;
  }
  if (normalizedChannel === 'COMMENT') return config.commentChannelV2Enabled;
  return false;
}

function numericJsonArray(value) {
  const parsed = json(value, []);
  if (!Array.isArray(parsed)) return [];
  return [...new Set(parsed.map(Number).filter(Number.isInteger).filter(item => item > 0))];
}

function registryStatusForMessage(message = {}) {
  if (message.handled_at || terminalMessageStatuses.has(String(message.status || '').toUpperCase())) return String(message.status || 'HANDLED').toUpperCase();
  return String(message.status || 'SEEN').toUpperCase();
}

function touchMessageProcessingRegistry(identity, message, stamp = now(), { incrementSeen = true, preferCanonical = false } = {}) {
  if (!identity?.identityKey || !message?.id) return null;
  const existing = row('SELECT * FROM message_processing_registry WHERE identity_key=?', identity.identityKey);
  const metadata = { ...json(existing?.metadata_json, {}), ...(identity.metadata || {}), userName: message.user_name || null, contentPreview: String(message.content || '').slice(0, 200) };
  let canonicalMessageId = Number(existing?.canonical_message_id || 0) || Number(message.id);
  let canonical = canonicalMessageId ? row('SELECT * FROM messages WHERE id=?', canonicalMessageId) : null;
  if (!canonical || (preferCanonical && !terminalMessageStatuses.has(String(canonical.status || '').toUpperCase()) && (message.handled_at || terminalMessageStatuses.has(String(message.status || '').toUpperCase())))) {
    canonicalMessageId = Number(message.id);
    canonical = message;
  }
  const status = registryStatusForMessage(canonical || message);
  if (!existing) {
    run(`INSERT INTO message_processing_registry(identity_key,identity_source,platform_code,account_id,message_type,canonical_message_id,canonical_external_id,processing_status,handled_at,handled_by,first_seen_at,last_seen_at,seen_count,metadata_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, identity.identityKey, identity.identitySource, message.platform_code, message.account_id, message.message_type, canonicalMessageId, canonical?.external_id || message.external_id || null, status, canonical?.handled_at || null, canonical?.handled_by || null, stamp, stamp, 1, JSON.stringify(metadata));
  } else {
    run(`UPDATE message_processing_registry SET identity_source=?,canonical_message_id=?,canonical_external_id=?,processing_status=?,handled_at=?,handled_by=?,last_seen_at=?,seen_count=seen_count+?,metadata_json=? WHERE identity_key=?`, identity.identitySource, canonicalMessageId, canonical?.external_id || message.external_id || null, status, canonical?.handled_at || null, canonical?.handled_by || null, stamp, incrementSeen ? 1 : 0, JSON.stringify(metadata), identity.identityKey);
  }
  return row('SELECT * FROM message_processing_registry WHERE identity_key=?', identity.identityKey);
}

export async function processMessageWithRegistry(messageId, options = {}) {
  const result = await processMessage(messageId, options);
  syncMessageProcessingRegistry(messageId);
  return result;
}

function syncMessageProcessingRegistry(messageId, stamp = now()) {
  const message = row('SELECT * FROM messages WHERE id=?', Number(messageId));
  if (!message) return null;
  return touchMessageProcessingRegistry(buildMessageProcessingIdentity(message, stamp), message, stamp, { incrementSeen: false, preferCanonical: true });
}

function backfillMessageProcessingRegistry() {
  const stamp = now();
  const messages = rows(`SELECT * FROM messages ORDER BY CASE WHEN handled_at IS NOT NULL OR status IN ('AUTO_REPLIED','MANUAL_HANDLED','CLOSED','IGNORED_SELF','IGNORED_OFFICIAL','SOURCE_GONE','SUPERSEDED') THEN 0 ELSE 1 END,id ASC`);
  // 每次启动都补齐缺失登记，并修复“未处理重复记录抢占 canonical”的历史数据；
  // 已存在登记不增加 seen_count，避免单纯重启服务被误算成再次采集。
  for (const message of messages) touchMessageProcessingRegistry(
    buildMessageProcessingIdentity(message, message.collected_at || message.created_at || stamp),
    message,
    message.collected_at || message.created_at || stamp,
    { incrementSeen: false, preferCanonical: true }
  );
  return messages.length;
}

function handledDouyinCommentStableIds(accountId, limit = 1000) {
  return rows(`SELECT json_extract(metadata_json,'$.commentStableId') AS stable_id FROM message_processing_registry WHERE platform_code='douyin' AND account_id=? AND message_type='COMMENT' AND processing_status IN ('AUTO_REPLIED','MANUAL_HANDLED','CLOSED','IGNORED_SELF','IGNORED_OFFICIAL','SOURCE_GONE','SUPERSEDED') AND json_extract(metadata_json,'$.commentStableId') IS NOT NULL ORDER BY last_seen_at DESC LIMIT ?`, Number(accountId), Math.max(1, Number(limit) || 1000)).map(item => String(item.stable_id || '').trim()).filter(Boolean);
}

backfillMessageConversations();
backfillMessageProcessingRegistry();
function isNonIdempotentAgentJob(jobType, payload = {}) {
  return ['PUBLISH', 'REPLY'].includes(jobType) || (jobType === 'BROWSER_COMMAND' && isBrowserCommandNonIdempotent(payload));
}

function hasReliableReplyEvidence(payload, result, outerStatus) {
  if (outerStatus !== 'SUCCESS') return false;
  if (payload.platformCode === 'douyin') {
    if (result.stage === 'reply_already_replied') {
      return result.alreadyReplied === true
        && result.sent === false
        && Boolean(result.evidencePath)
        && Boolean(result.screenshotPath)
        && Number(result.scopedEchoCount) > 0;
    }
    if (result.stage !== 'reply_sent' || !result.evidencePath || !result.screenshotPath || !result.sendMethod) return false;
    if (result.editorCleared !== true) return false;
    const scopedEchoCount = Number(result.scopedEchoCount);
    const baselineEchoCount = Number(result.baselineEchoCount);
    return Number.isFinite(scopedEchoCount) && Number.isFinite(baselineEchoCount) && scopedEchoCount > baselineEchoCount;
  }
  if (payload.platformCode === 'bilibili') {
    return result.stage === 'reply_sent'
      && Boolean(result.evidencePath)
      && Boolean(result.screenshotPath)
      && String(result.sendMethod || '').startsWith('bilibili-api:')
      && Number(result.apiCode) === 0
      && Boolean(result.platformMessageId)
      && result.verified === true;
  }
  if (payload.platformCode === 'wechat_channels') {
    const scopedEchoCount = Number(result.scopedEchoCount);
    const baselineEchoCount = Number(result.baselineEchoCount);
    return result.stage === 'reply_sent'
      && Boolean(result.evidencePath)
      && Boolean(result.screenshotPath)
      && String(result.sendMethod || '').startsWith('wechat-channels:')
      && result.editorCleared === true
      && Number.isFinite(scopedEchoCount)
      && Number.isFinite(baselineEchoCount)
      && scopedEchoCount > baselineEchoCount;
  }
  if (payload.platformCode === 'xiaohongshu') {
    const scopedEchoCount = Number(result.scopedEchoCount);
    const baselineEchoCount = Number(result.baselineEchoCount);
    return ['reply_sent', 'private_reply_sent'].includes(result.stage)
      && Boolean(result.evidencePath)
      && Boolean(result.screenshotPath)
      && String(result.sendMethod || '').startsWith('xiaohongshu:')
      && result.sendAttempted === true
      && result.editorCleared === true
      && result.verified === true
      && Number.isFinite(scopedEchoCount)
      && Number.isFinite(baselineEchoCount)
      && scopedEchoCount > baselineEchoCount;
  }
  if (payload.platformCode === 'weibo') {
    return hasReliableWeiboReplyEvidence(result, outerStatus);
  }
  return false;
}
const activePlatformCodes = Object.freeze(config.activePlatformCodes);
const activePlatformPlaceholders = activePlatformCodes.map(() => '?').join(',');
const supportedPlatformCodes = Object.freeze(config.supportedPlatformCodes);
const supportedPlatformPlaceholders = supportedPlatformCodes.map(() => '?').join(',');
let automaticMessageCollectionTimer = null;
let nextAutomaticMessageCollectionAt = null;
let conversationRecoveryTimer = null;
let scheduledPublishTimer = null;
let scheduledPublishTickRunning = false;

function sha256LocalFile(file) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytes;
    let position = 0;
    while ((bytes = fs.readSync(fd, buffer, 0, buffer.length, position)) > 0) {
      hash.update(buffer.subarray(0, bytes));
      position += bytes;
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

function send(res, status, data, headers = {}) {
  const responseBody = typeof data === 'string' || Buffer.isBuffer(data) ? data : JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(responseBody);
}
function ok(res, data = {}) { send(res, 200, { ok: true, ...data }); }
function fail(res, status, message, detail = null, code = 'REQUEST_FAILED') { send(res, status, { ok: false, code, message, detail }); }
function httpError(statusCode, code, message, detail = null) {
  const error = new Error(message); error.statusCode = statusCode; error.code = code; error.detail = detail; return error;
}
async function body(req, maxBytes = config.requestBodyMaxBytes) {
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw httpError(413, 'REQUEST_BODY_TOO_LARGE', '请求体过大', { maxBytes });
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  const contentType = String(req.headers['content-type'] || '').toLowerCase();
  if (!contentType.startsWith('application/json')) throw httpError(415, 'JSON_CONTENT_TYPE_REQUIRED', '请求体必须使用 application/json');
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw httpError(400, 'INVALID_JSON', '请求体不是有效 JSON'); }
}
function requireRagAdminEnabled() {
  if (config.ragAdminEnabled && formalRagClient.configured) return;
  throw httpError(503, 'RAG_ADMIN_DISABLED', 'RAG 管理接口尚未启用或未配置', { enabled: config.ragAdminEnabled, configured: formalRagClient.configured });
}
function requireRagAdminResult(result, fallbackMessage = 'RAG 管理服务请求失败') {
  const status = String(result?.status || '').toUpperCase();
  const failed = ['NOT_CONFIGURED', 'UNAVAILABLE', 'INVALID_RESPONSE'].includes(status) || Number(result?.httpStatus || 0) >= 400;
  if (!failed) return result;
  const statusCode = status === 'NOT_CONFIGURED' ? 503 : (Number(result?.httpStatus) || 502);
  throw httpError(statusCode, result?.error?.code || 'RAG_ADMIN_REQUEST_FAILED', result?.error?.message || fallbackMessage, result?.raw || result?.error || null);
}
function decodeRagUploadContent(contentBase64) {
  const normalized = String(contentBase64 || '').replace(/^data:[^;]+;base64,/i, '').replace(/\s+/g, '');
  if (!normalized || normalized.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)) {
    throw httpError(400, 'INVALID_FILE_BASE64', 'contentBase64 不是有效的 Base64 文件内容');
  }
  const content = Buffer.from(normalized, 'base64');
  if (!content.length) throw httpError(400, 'EMPTY_FILE', '上传文件不能为空');
  if (content.length > config.ragUploadMaxBytes) throw httpError(413, 'RAG_FILE_TOO_LARGE', '上传文件超过允许大小', { maxBytes: config.ragUploadMaxBytes });
  return content;
}
function secureTokenMatch(supplied, expected) {
  const left = Buffer.from(String(supplied || '')); const right = Buffer.from(String(expected || ''));
  return left.length === right.length && left.length > 0 && crypto.timingSafeEqual(left, right);
}
function adminSession(req) {
  if (!config.authEnabled) return { sub: config.adminUsername, disabled: true };
  return sessionFromRequest(req, { username: config.adminUsername, secret: config.sessionSecret });
}
function requireAdminSession(req, res) {
  const session = adminSession(req);
  if (session) return session;
  fail(res, 401, '管理员登录已过期或尚未登录', null, 'AUTH_REQUIRED');
  return null;
}
function requireAgentToken(req, res) {
  if (!config.agentToken) return true;
  const authorization = String(req.headers.authorization || '');
  const supplied = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
  if (secureTokenMatch(supplied, config.agentToken)) return true;
  fail(res, 401, 'Agent 鉴权失败', null, 'AGENT_AUTH_REQUIRED');
  return false;
}
function parseId(pathname, pattern) { const match = pathname.match(pattern); return match ? Number(match[1]) : null; }

// 知识缺口页只展示确实存在未回答业务问题的记录。
// 旧版本曾把采集延迟、页面不可用等状态也写入 knowledge_gaps，需要在读取时兜底过滤。
const KNOWLEDGE_GAP_DECISIONS = new Set(['KNOWLEDGE_GAP', 'KNOWLEDGE_GAP_GUIDANCE', 'AUTO_REPLY_PARTIAL_KNOWLEDGE']);
const NON_KNOWLEDGE_GAP_DECISIONS = new Set(['AUTO_REPLY', 'SMALL_TALK', 'DEFERRED_PAGE_UNAVAILABLE', 'SOURCE_GONE', 'SKIP_SOURCE_GONE', 'TECHNICAL_ERROR']);
function knowledgeGapHasUnknownQuestions(item) {
  try {
    const parsed = JSON.parse(item.subquestions_json || '{}');
    return Array.isArray(parsed.unknownQuestions) && parsed.unknownQuestions.some(question => String(question || '').trim());
  } catch {
    return false;
  }
}
function isActualKnowledgeGap(item) {
  const decision = String(item.decision || '').trim().toUpperCase();
  const status = String(item.message_status || '').trim().toUpperCase();
  if (decision === 'DEFERRED_PAGE_UNAVAILABLE' || status === 'DEFERRED_PAGE_UNAVAILABLE') return false;
  if (KNOWLEDGE_GAP_DECISIONS.has(decision)) return true;
  if (NON_KNOWLEDGE_GAP_DECISIONS.has(decision)) return false;
  // AUTO_REPLY_INELIGIBLE 可能是规则先拦截、但知识匹配仍确认存在未知业务问题，不能因“需人工”状态把缺口隐藏。
  if (knowledgeGapHasUnknownQuestions(item)) return true;
  return status === 'KNOWLEDGE_GAP';
}
function futureIso(ms) { return new Date(Date.now() + ms).toISOString(); }
const PUBLISH_REVIEW_INITIAL_DELAY_MS = 2 * 60 * 1000;
const PUBLISH_REVIEW_FAST_WINDOW_MS = 30 * 60 * 1000;
const PUBLISH_REVIEW_FAST_INTERVAL_MS = 3 * 60 * 1000;
const PUBLISH_REVIEW_STEADY_INTERVAL_MS = 5 * 60 * 1000;

function publishSubmittedTimestamp(targetOrValue) {
  if (typeof targetOrValue === 'string') return targetOrValue;
  return targetOrValue?.submit_attempted_at || targetOrValue?.submitted_at || null;
}

function initialPublishReviewAvailableAt(submittedAt) {
  const submittedMs = Date.parse(submittedAt || '');
  const scheduledMs = Number.isFinite(submittedMs)
    ? submittedMs + PUBLISH_REVIEW_INITIAL_DELAY_MS
    : Date.now() + PUBLISH_REVIEW_INITIAL_DELAY_MS;
  return new Date(Math.max(Date.now(), scheduledMs)).toISOString();
}

function nextPublishReviewDelayMs(submittedAt) {
  const submittedMs = Date.parse(submittedAt || '');
  const elapsedMs = Number.isFinite(submittedMs) ? Math.max(0, Date.now() - submittedMs) : 0;
  return elapsedMs < PUBLISH_REVIEW_FAST_WINDOW_MS
    ? PUBLISH_REVIEW_FAST_INTERVAL_MS
    : PUBLISH_REVIEW_STEADY_INTERVAL_MS;
}
function operationsEnabled() { return getMasterSwitch().enabled; }
let localAgentWatchdogBusy = false;
let lastLocalAgentWatchdogError = '';
let lastLocalAgentWatchdogErrorAt = 0;
async function reconcileLocalAgentLifecycle() {
  if (!config.localAgentAutoStart || !operationsEnabled() || localAgentWatchdogBusy) return;
  localAgentWatchdogBusy = true;
  try {
    const result = await ensureLocalAgentOnline();
    if (result.started) console.log('[Local Agent] watchdog 已恢复 Local Agent 连接');
    lastLocalAgentWatchdogError = '';
    lastLocalAgentWatchdogErrorAt = 0;
  } catch (error) {
    const message = String(error?.message || error);
    const nowMs = Date.now();
    if (message !== lastLocalAgentWatchdogError || nowMs - lastLocalAgentWatchdogErrorAt >= 30_000) {
      console.error(`[Local Agent] watchdog 恢复失败：${message}`);
      lastLocalAgentWatchdogError = message;
      lastLocalAgentWatchdogErrorAt = nowMs;
    }
  } finally {
    localAgentWatchdogBusy = false;
  }
}
function startLocalAgentWatchdog() {
  if (!config.localAgentAutoStart) return null;
  const timer = setInterval(() => { void reconcileLocalAgentLifecycle(); }, config.localAgentWatchdogIntervalMs);
  timer.unref?.();
  return timer;
}
async function refreshLocalAgentPlatformControl() {
  if (!config.localAgentAutoStart) return { notified: false, reason: 'LOCAL_AGENT_AUTO_START_DISABLED' };
  try {
    const response = await fetch(`http://127.0.0.1:${config.agentPort}/control/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(config.agentToken ? { 'X-Agent-Token': config.agentToken } : {}) },
      body: '{}',
      signal: AbortSignal.timeout(1500)
    });
    if (!response.ok) return { notified: false, status: response.status, reason: 'LOCAL_AGENT_CONTROL_REJECTED' };
    const data = await response.json();
    return { notified: true, masterSwitch: data.masterSwitch, platforms: data.platforms };
  } catch (error) {
    return { notified: false, reason: 'LOCAL_AGENT_OFFLINE', message: error.message };
  }
}

const localAgentProxyJsonRoutes = Object.freeze([
  { method: 'POST', pattern: /^\/pick-file$/ },
  { method: 'POST', pattern: /^\/precheck$/ },
  { method: 'POST', pattern: /^\/ai-review$/ },
  { method: 'POST', pattern: /^\/traffic-prediction$/ },
  { method: 'POST', pattern: /^\/ocr$/ },
  { method: 'POST', pattern: /^\/audio-content-generation$/ },
  { method: 'POST', pattern: /^\/material-content-generation$/ },
  { method: 'GET', pattern: /^\/platforms\/status$/ },
  { method: 'POST', pattern: /^\/platforms\/(?:open-login|check-login)$/ },
  { method: 'POST', pattern: /^\/platforms\/[a-z_]+\/(?:open-login|check-login|open-manual-action)$/ },
  { method: 'POST', pattern: /^\/platforms\/bilibili\/submit-existing-draft$/ }
]);
function localAgentProxyPath(pathname) {
  const prefix = '/api/local-agent';
  if (!pathname.startsWith(`${prefix}/`)) return null;
  return pathname.slice(prefix.length);
}
function localAgentProxyRouteAllowed(method, agentPath) {
  return localAgentProxyJsonRoutes.some(route => route.method === method && route.pattern.test(agentPath));
}
function localAgentStatus(health) {
  return {
    managed: config.localAgentAutoStart,
    online: health.online,
    reachable: health.reachable,
    deviceId: health.health?.deviceId || null,
    expectedDeviceId: config.deviceId,
    version: health.health?.version || null,
    masterSwitchEnabled: health.health?.masterSwitchEnabled === true,
    bindingVerified: health.bindingMatches !== false,
    message: health.message
  };
}
async function ensureLocalAgentAvailableForProxy() {
  if (!operationsEnabled()) throw httpError(409, 'OPERATIONS_PAUSED', '全局运行已暂停，请先开启总开关');
  if (config.localAgentAutoStart) await ensureLocalAgentOnline();
  const health = await checkLocalAgentHealth();
  if (!health.online) throw httpError(503, 'LOCAL_AGENT_OFFLINE', health.message);
  return health;
}
async function proxyLocalAgentJson(req, res, url, agentPath) {
  if (!localAgentProxyRouteAllowed(req.method, agentPath)) return fail(res, 404, 'Local Agent 代理接口不存在', null, 'LOCAL_AGENT_PROXY_ROUTE_NOT_ALLOWED');
  try { await ensureLocalAgentAvailableForProxy(); }
  catch (error) { return fail(res, Number(error.statusCode) || 503, error.message, error.detail || null, error.code || 'LOCAL_AGENT_OFFLINE'); }
  const payload = req.method === 'GET' ? null : await body(req);
  let response;
  try {
    response = await fetch(`http://127.0.0.1:${config.agentPort}${agentPath}${url.search}`, {
      method: req.method,
      headers: {
        ...(payload === null ? {} : { 'Content-Type': 'application/json' }),
        ...(config.agentToken ? { 'X-Agent-Token': config.agentToken } : {})
      },
      ...(payload === null ? {} : { body: JSON.stringify(payload) }),
      signal: AbortSignal.timeout(120_000)
    });
  } catch (error) {
    return fail(res, 502, 'Local Agent 连接失败，请确认总开关已开启', error.message, 'LOCAL_AGENT_PROXY_FAILED');
  }
  const responseText = await response.text();
  let responseData;
  try { responseData = responseText ? JSON.parse(responseText) : {}; }
  catch { return fail(res, 502, 'Local Agent 返回了无法识别的数据', null, 'LOCAL_AGENT_INVALID_RESPONSE'); }
  return send(res, response.status, responseData);
}
async function proxyLocalAgentMaterial(req, res, url, agentPath) {
  if (!['GET', 'HEAD'].includes(req.method) || !/^\/material-preview\/[0-9a-f-]+$/i.test(agentPath)) {
    return fail(res, 404, '本地素材预览接口不存在', null, 'LOCAL_AGENT_PREVIEW_NOT_ALLOWED');
  }
  try { await ensureLocalAgentAvailableForProxy(); }
  catch (error) { return fail(res, Number(error.statusCode) || 503, error.message, error.detail || null, error.code || 'LOCAL_AGENT_OFFLINE'); }
  const upstream = http.request({
    host: '127.0.0.1',
    port: config.agentPort,
    method: req.method,
    path: `${agentPath}${url.search}`,
    headers: {
      ...(req.headers.range ? { Range: req.headers.range } : {}),
      ...(config.agentToken ? { 'X-Agent-Token': config.agentToken } : {})
    }
  }, upstreamResponse => {
    const headers = {};
    for (const name of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'cache-control']) {
      const value = upstreamResponse.headers[name];
      if (value !== undefined) headers[name] = value;
    }
    res.writeHead(upstreamResponse.statusCode || 502, headers);
    upstreamResponse.pipe(res);
  });
  upstream.setTimeout(30_000, () => upstream.destroy(new Error('Local Agent 素材预览超时')));
  upstream.on('error', error => {
    if (!res.headersSent) fail(res, 502, 'Local Agent 素材预览连接失败', error.message, 'LOCAL_AGENT_PREVIEW_FAILED');
    else res.destroy(error);
  });
  upstream.end();
}
function getPlatformRuntime() {
  const masterEnabled = operationsEnabled();
  const smartReply = getPlatformSmartReplyMap(activePlatformCodes);
  return platformRuntimeRows({ rows, activePlatformCodes: supportedPlatformCodes }).map(item => {
    const blockSummary = runtimeBlockSummary(item.code);
    const runtimeBlocked = blockSummary.blocked === true;
    const taskExecutionState = item.task_execution_state === 'RUNNING' && !runtimeBlocked ? 'RUNNING' : 'PAUSED';
    return {
      ...item,
      ...blockSummary,
      task_execution_state: taskExecutionState,
      task_blocked_reason: runtimeBlocked ? 'ACTIVE_ISSUE_BLOCK' : item.task_blocked_reason,
      smart_reply_enabled: smartReply[item.code]?.enabled === true,
      smart_reply_effective_state: masterEnabled && taskExecutionState === 'RUNNING' && smartReply[item.code]?.enabled === true ? 'RUNNING' : 'STOPPED',
      smart_reply_updated_at: smartReply[item.code]?.updatedAt || null,
      smart_reply_updated_by: smartReply[item.code]?.updatedBy || null
    };
  });
}
function getPlatformRuntimeMap() { return Object.fromEntries(getPlatformRuntime().map(item => [item.code, item])); }
function platformRuntime(platformCode) { return getPlatformRuntimeMap()[platformCode] || null; }
function requirePlatformOperationsEnabled(res, platformCode) {
  if (!activePlatformCodes.includes(platformCode)) { fail(res, 400, '\u4e0d\u652f\u6301\u7684\u5e73\u53f0'); return false; }
  if (!operationsEnabled()) return requireOperationsEnabled(res);
  const runtime = platformRuntime(platformCode);
  if (isPlatformRuntimeEnabled(runtime) && runtime?.task_execution_state === 'RUNNING') return true;
  const message = runtime?.task_blocked_reason === 'ACTIVE_ISSUE_BLOCK'
    ? '该平台存在尚未处理的运行问题，请在“问题汇总”中完成处置'
    : runtime?.blocked_reason === 'NO_ENABLED_ACCOUNT'
      ? '\u5e73\u53f0\u6ca1\u6709\u542f\u7528\u8d26\u53f7\uff0c\u4efb\u52a1\u5c06\u4fdd\u6301\u7b49\u5f85'
      : runtime?.blocked_reason === 'PLATFORM_PLANNED'
        ? '\u8be5\u5e73\u53f0\u4ecd\u5728\u89c4\u5212\u4e2d\uff0c\u5f53\u524d\u4e0d\u53c2\u4e0e\u4efb\u52a1\u6267\u884c'
        : '\u5e73\u53f0\u8fd0\u884c\u5f00\u5173\u5df2\u5173\u95ed\uff0c\u4efb\u52a1\u5c06\u4fdd\u6301\u7b49\u5f85';
  fail(res, 409, message, runtime);
  return false;
}
function requireOperationsEnabled(res) {
  if (operationsEnabled()) return true;
  fail(res, 409, '全局运行已暂停，请先开启总开关');
  return false;
}
function stopAutomaticMessageCollectionSchedule() {
  if (!automaticMessageCollectionTimer) return;
  clearTimeout(automaticMessageCollectionTimer);
  automaticMessageCollectionTimer = null;
  nextAutomaticMessageCollectionAt = null;
}
function syncAutomaticMessageCollectionSchedule() {
  if (!config.autoCollectEnabled || !operationsEnabled()) { stopAutomaticMessageCollectionSchedule(); return; }
  scheduleNextAutomaticMessageCollection();
}

function issue({ source, category, title, detail, relatedType = null, relatedId = null, level = 'ERROR', screenshotPath = null, retryable = false }) {
  const stamp = now();
  const existing = row(`SELECT * FROM issues WHERE status IN ('OPEN','DIAGNOSING','DIAGNOSED','RETRYING') AND source=? AND category=? AND COALESCE(related_type,'')=COALESCE(?,'') AND COALESCE(related_id,'')=COALESCE(?,'') ORDER BY id DESC LIMIT 1`, source, category, relatedType, relatedId == null ? null : String(relatedId));
  let issueId;
  if (existing) {
    run('UPDATE issues SET title=?,detail=?,level=?,occurrences=occurrences+1,last_seen_at=?,updated_at=?,screenshot_path=COALESCE(?,screenshot_path),retryable=? WHERE id=?', title, detail, level, stamp, stamp, screenshotPath, retryable ? 1 : 0, existing.id);
    issueId = Number(existing.id);
  } else {
    issueId = Number(run(`INSERT INTO issues(source,category,level,title,detail,status,related_type,related_id,created_at,updated_at,occurrences,last_seen_at,screenshot_path,retryable)
      VALUES(?,?,?,?,?,'OPEN',?,?,?,?,1,?,?,?)`, source, category, level, title, detail, relatedType, relatedId == null ? null : String(relatedId), stamp, stamp, stamp, screenshotPath, retryable ? 1 : 0).lastInsertRowid);
  }
  if (source !== 'SMOKE_TEST') ensureIssueBlock(issueId);
  return issueId;
}

function isSafeDeferredReplyJob(job) {
  if (!job || String(job.job_type || '').toUpperCase() !== 'REPLY') return false;
  if (!['NEEDS_CONFIRMATION', 'FAILED'].includes(String(job.status || '').toUpperCase())) return false;
  const result = json(job.result, {});
  const deferred = [result.sourceState, result.status, result.decision]
    .some(value => String(value || '').toUpperCase() === 'DEFERRED_PAGE_UNAVAILABLE');
  const explicitlyBeforeSend = result.sendAttempted === false
    || String(result.stage || '').toLowerCase() === 'reply_page_deferred';
  return deferred && result.retrySafe === true && explicitlyBeforeSend;
}

function createJob(deviceId, jobType, payload, { idempotencyKey = null, availableAt = null, replaceCancelled = false, priority = null } = {}) {
  if (['PUBLISH', 'VERIFY_PUBLISH'].includes(String(jobType || '').toUpperCase()) && !payload?.queueLane && !payload?.channelType) {
    payload = { ...payload, channelType: 'COMMENT', queueLane: 'COMMENT' };
  }
  if (idempotencyKey) {
    const existing = row('SELECT id,job_type,status,result FROM agent_jobs WHERE idempotency_key=?', idempotencyKey);
    if (existing) {
      const replaceSafeDeferred = String(jobType || '').toUpperCase() === 'REPLY' && isSafeDeferredReplyJob(existing);
      const replaceExplicitlyCancelled = replaceCancelled && existing.status === 'CANCELLED';
      if (!replaceSafeDeferred && !replaceExplicitlyCancelled) return Number(existing.id);
      const released = run('UPDATE agent_jobs SET idempotency_key=NULL WHERE id=? AND idempotency_key=?', existing.id, idempotencyKey);
      if (released.changes !== 1) {
        const concurrent = row('SELECT id FROM agent_jobs WHERE idempotency_key=?', idempotencyKey);
        if (concurrent) return Number(concurrent.id);
      }
    }
  }
  const rawChannelType = String(payload?.channelType || payload?.messageType || '').trim().toUpperCase();
  const channelType = ['PRIVATE_MESSAGE', 'COMMENT'].includes(rawChannelType) ? rawChannelType : null;
  const queueLane = String(payload?.queueLane || channelType || '').trim().toUpperCase() || null;
  const conversationNamespace = String(payload?.conversationNamespace || '').trim() || null;
  const createdAt = now();
  const firstPendingAt = payload?.firstPendingAt || payload?.occurredAt || createdAt;
  const resolvedPriority = Number.isFinite(Number(priority)) ? Number(priority) : priorityForJob(jobType, payload);
  return Number(run(`INSERT INTO agent_jobs(device_id,job_type,payload,status,created_at,idempotency_key,available_at,channel_type,queue_lane,conversation_namespace,first_pending_at,priority)
    VALUES(?,?,?,'QUEUED',?,?,?,?,?,?,?,?)`, deviceId, jobType, JSON.stringify(payload), createdAt, idempotencyKey, availableAt || createdAt,
    channelType, queueLane, conversationNamespace, firstPendingAt, resolvedPriority).lastInsertRowid);
}

function cancelQueuedPublishVerificationJobs(targetId, {
  reason = 'PUBLISH_REVIEW_TERMINAL',
  exceptJobId = null,
  automaticOnly = false
} = {}) {
  const stamp = now();
  const params = [stamp, JSON.stringify({ message: '发布状态核验已取消', reason }), Number(targetId)];
  let sql = `UPDATE agent_jobs SET status='CANCELLED',completed_at=?,lease_expires_at=NULL,result=?
    WHERE job_type='VERIFY_PUBLISH' AND status='QUEUED'
      AND CAST(json_extract(payload,'$.targetId') AS INTEGER)=?`;
  if (automaticOnly) sql += ` AND COALESCE(CAST(json_extract(payload,'$.manualRequested') AS INTEGER),0)<>1`;
  if (exceptJobId != null) {
    sql += ' AND id<>?';
    params.push(Number(exceptJobId));
  }
  return Number(run(sql, ...params).changes || 0);
}

function activePublishVerificationJob(targetId) {
  const job = row(`SELECT id,status,available_at,claimed_at,created_at,payload
    FROM agent_jobs
    WHERE job_type='VERIFY_PUBLISH' AND status IN ('RUNNING','QUEUED')
      AND CAST(json_extract(payload,'$.targetId') AS INTEGER)=?
    ORDER BY CASE status WHEN 'RUNNING' THEN 0 ELSE 1 END,COALESCE(available_at,created_at),id
    LIMIT 1`, Number(targetId));
  if (!job) return null;
  const payload = json(job.payload, {});
  return {
    verification_job_id: Number(job.id),
    verification_job_status: job.status,
    verification_source: payload.manualRequested === true || payload.verificationSource === 'MANUAL' ? 'MANUAL' : 'AUTOMATIC',
    next_verification_at: job.status === 'QUEUED' ? (job.available_at || job.created_at) : null
  };
}

function decoratePublishTarget(target) {
  return {
    ...target,
    ...activePublishVerificationJob(target.id),
    draft_fingerprint: json(target.draft_fingerprint, null),
    result: json(target.result, target.result),
    evidence: json(target.evidence_json, {})
  };
}

function diagnosticPagesForPlatform(platformCode, feature = null) {
  const platform = platformCode === 'xiaohongshu'
    ? { publishUrl: config.xhsCreatorUrl, manageUrl: config.xhsManageUrl, commentUrl: config.xhsCommentUrl, messageUrl: config.xhsMessageUrl }
    : config.platformRpa[platformCode] || {};
  const commonSelectors = ['body', 'main', 'nav', 'button', 'input', 'textarea', '[role="dialog"]', '[role="button"]', '[contenteditable="true"]'];
  const platformSelectors = {
    douyin: ['[class*="publish"]', '[class*="upload"]', '[class*="comment"]', '[class*="message"]'],
    wechat_channels: ['[class*="post"]', '[class*="publish"]', '[class*="comment"]', '[class*="private"]'],
    bilibili: ['[class*="upload"]', '[class*="archive"]', '[class*="comment"]', '[class*="message"]'],
    weibo: ['[class*="publish"]', '[class*="manage"]', '[class*="comment"]', '[class*="message"]'],
    xiaohongshu: ['[class*="publish"]', '[class*="upload"]', '[class*="notification"]', '[class*="chat"]', '[class*="message"]']
  };
  const selectors = [...new Set([...commonSelectors, ...(platformSelectors[platformCode] || [])])];
  const pages = [
    { key: 'publish', name: '内容发布页', url: platform.publishUrl, selectors },
    { key: 'manage', name: '内容管理页', url: platform.manageUrl, selectors },
    { key: 'comment', name: '评论管理页', url: platform.commentUrl, selectors },
    { key: 'message', name: '私信管理页', url: platform.messageUrl, selectors }
  ].filter(item => String(item.url || '').toLowerCase().startsWith('https://'));
  if (feature === 'publish') return pages.filter(item => ['publish', 'manage'].includes(item.key));
  if (feature === 'reply' || feature === 'collect') return pages.filter(item => ['comment', 'message'].includes(item.key));
  return pages;
}
function smokeRunView(item) {
  if (!item) return null;
  return { ...item, snapshot: json(item.snapshot_json, null), diff: json(item.diff_json, null), screenshot_paths: json(item.screenshot_paths_json, []), baseline_snapshot: json(item.baseline_snapshot_json, null), baseline_screenshot_paths: json(item.baseline_screenshot_paths_json, []) };
}
function getSmokeRun(id) {
  return smokeRunView(row(`SELECT r.*,b.snapshot_json AS baseline_snapshot_json,b.screenshot_paths_json AS baseline_screenshot_paths_json,b.fingerprint_hash AS baseline_fingerprint
    FROM smoke_test_runs r LEFT JOIN smoke_test_baselines b ON b.id=r.baseline_id WHERE r.id=?`, Number(id)));
}
function originalContextForDiagnosis(issueOrId) {
  const context = issueContext(issueOrId);
  if (!context.issue) return context;
  let originalJob = null;
  let businessResult = null;
  if (context.targetId) {
    const target = row('SELECT * FROM publish_targets WHERE id=?', context.targetId);
    originalJob = row(`SELECT * FROM agent_jobs WHERE job_type IN ('PUBLISH','VERIFY_PUBLISH') AND CAST(json_extract(payload,'$.targetId') AS INTEGER)=? ORDER BY id DESC LIMIT 1`, context.targetId);
    businessResult = json(target?.result, null);
  } else if (context.messageId) {
    const message = row('SELECT * FROM messages WHERE id=?', context.messageId);
    originalJob = message?.reply_job_id ? row('SELECT * FROM agent_jobs WHERE id=?', message.reply_job_id) : null;
    if (!originalJob) originalJob = row(`SELECT * FROM agent_jobs WHERE job_type IN ('REPLY','DETECT_MANUAL_REPLY') AND CAST(json_extract(payload,'$.messageId') AS INTEGER)=? ORDER BY id DESC LIMIT 1`, context.messageId);
    businessResult = message ? { status: message.status, decision: message.decision, reason: message.reason, handlerNote: message.handler_note } : null;
  } else if (context.accountId) {
    originalJob = row(`SELECT * FROM agent_jobs WHERE job_type='COLLECT_MESSAGES' AND CAST(json_extract(payload,'$.accountId') AS INTEGER)=? ORDER BY id DESC LIMIT 1`, context.accountId);
  }
  const jobResult = json(originalJob?.result, null);
  return {
    ...context,
    originalJob: originalJob ? { ...originalJob, payload: json(originalJob.payload, {}), result: jobResult } : null,
    originalResult: jobResult || businessResult || null
  };
}

function latestDiagnosis(issueId) {
  return parsedDiagnosis(row('SELECT * FROM issue_diagnoses WHERE issue_id=? ORDER BY id DESC LIMIT 1', Number(issueId)));
}

function issueView(item) {
  if (!item) return null;
  const activeBlock = row("SELECT * FROM runtime_blocks WHERE issue_id=? AND status='ACTIVE' ORDER BY id DESC LIMIT 1", item.id) || null;
  return { ...item, latest_diagnosis: latestDiagnosis(item.id), active_block: activeBlock };
}

function reconcileRecoveredAccountLoginIssues(accountId, { resolvedBy = 'LOGIN_MONITOR', resolution = '账号已重新确认登录正常' } = {}) {
  const activeIssues = rows(`SELECT * FROM issues
    WHERE source='LOGIN_MONITOR' AND category='ACCOUNT_LOGIN'
      AND related_type='ACCOUNT' AND related_id=?
      AND status IN ('OPEN','DIAGNOSING','DIAGNOSED','RETRYING')
    ORDER BY id`, String(accountId));
  if (!activeIssues.length) return 0;
  const stamp = now();
  for (const item of activeIssues) {
    run(`UPDATE issues SET status='RESOLVED',resolution_type='AUTO_RECOVERED',resolution=?,assignee=?,resolved_by=?,resolved_at=?,updated_at=? WHERE id=?`,
      resolution, resolvedBy, resolvedBy, stamp, stamp, item.id);
    releaseIssueBlocks(item.id, { releasedBy: resolvedBy, reason: resolution });
    run("UPDATE agent_jobs SET status='CANCELLED',completed_at=?,result=? WHERE job_type='DIAGNOSE_ISSUE' AND status='QUEUED' AND CAST(json_extract(payload,'$.issueId') AS INTEGER)=?",
      stamp, JSON.stringify({ message: '账号登录已自动恢复，取消排队中的只读诊断' }), item.id);
    run("UPDATE issue_diagnoses SET status='CANCELLED',error_message=?,completed_at=?,updated_at=? WHERE issue_id=? AND status='QUEUED'",
      '账号登录已自动恢复', stamp, stamp, item.id);
  }
  return activeIssues.length;
}

function reconcileReadyAccountLoginIssues() {
  let resolved = 0;
  for (const account of rows("SELECT id FROM accounts WHERE login_status='READY'")) {
    resolved += reconcileRecoveredAccountLoginIssues(account.id, {
      resolvedBy: 'LOGIN_MONITOR',
      resolution: '服务启动对账：账号当前已确认登录正常'
    });
  }
  return resolved;
}

async function completeIssueDiagnosis({ diagnosisId, issueId, evidence = {}, outerStatus = 'SUCCESS', stamp = now() }) {
  const diagnosis = row('SELECT * FROM issue_diagnoses WHERE id=? AND issue_id=?', Number(diagnosisId), Number(issueId));
  if (!diagnosis) return null;
  try {
    const context = originalContextForDiagnosis(issueId);
    const combinedEvidence = { ...evidence, evidenceCollectionStatus: outerStatus };
    const result = await diagnoseIssue(context, combinedEvidence);
    run(`UPDATE issue_diagnoses SET status='COMPLETED',category=?,failed_stage=?,confidence=?,page_changed=?,safe_to_retry=?,suggested_block_scope=?,summary=?,evidence_json=?,recommendations_json=?,error_message=NULL,completed_at=?,updated_at=? WHERE id=?`,
      result.category, result.failedStage, Number(result.confidence || 0), result.pageChanged ? 1 : 0, result.safeToRetry ? 1 : 0,
      result.suggestedBlockScope || context.issue?.block_scope || null, result.summary,
      JSON.stringify(result.evidence || []), JSON.stringify(result.recommendations || []), stamp, stamp, diagnosis.id);
    const current = row('SELECT status FROM issues WHERE id=?', Number(issueId));
    if (current && ['OPEN','DIAGNOSING','DIAGNOSED','RETRYING'].includes(current.status)) {
      run("UPDATE issues SET status='DIAGNOSED',diagnosis_status='COMPLETED',diagnosis_summary=?,latest_diagnosis_id=?,updated_at=? WHERE id=?", result.summary, diagnosis.id, stamp, Number(issueId));
    }
    return latestDiagnosis(issueId);
  } catch (error) {
    run("UPDATE issue_diagnoses SET status='FAILED',error_message=?,completed_at=?,updated_at=? WHERE id=?", String(error.message || error).slice(0, 2000), stamp, stamp, diagnosis.id);
    const current = row('SELECT status FROM issues WHERE id=?', Number(issueId));
    if (current?.status === 'DIAGNOSING') run("UPDATE issues SET status='OPEN',diagnosis_status='FAILED',diagnosis_summary=?,updated_at=? WHERE id=?", 'AI 自检未完成：' + String(error.message || error).slice(0, 500), stamp, Number(issueId));
    return latestDiagnosis(issueId);
  }
}

function resolveIssueManually(issueId, { resolutionType, resolution, resolvedBy, actualOutcome = null, platformUrl = null, platformPostId = null }) {
  const item = row('SELECT * FROM issues WHERE id=?', Number(issueId));
  if (!item) return null;
  const stamp = now();
  db.exec('BEGIN IMMEDIATE');
  try {
    const status = resolutionType === 'FALSE_POSITIVE' ? 'FALSE_POSITIVE' : 'RESOLVED';
    run(`UPDATE issues SET status=?,resolution_type=?,resolution=?,assignee=?,resolved_by=?,resolved_at=?,updated_at=? WHERE id=?`, status, resolutionType, resolution, resolvedBy, resolvedBy, stamp, stamp, item.id);
    releaseIssueBlocks(item.id, { releasedBy: resolvedBy, reason: resolution });
    run("UPDATE agent_jobs SET status='CANCELLED',completed_at=?,result=? WHERE job_type='DIAGNOSE_ISSUE' AND status='QUEUED' AND CAST(json_extract(payload,'$.issueId') AS INTEGER)=?", stamp, JSON.stringify({ message: '问题已人工处置，取消排队中的只读诊断' }), item.id);
    run("UPDATE issue_diagnoses SET status='CANCELLED',error_message=?,completed_at=?,updated_at=? WHERE issue_id=? AND status='QUEUED'", '消息已人工处理', stamp, stamp, item.id);
    if (resolutionType === 'FALSE_POSITIVE' && item.related_type === 'PUBLISH_TARGET' && String(actualOutcome || '').toUpperCase() === 'PUBLISHED') {
      const targetId = Number(item.related_id);
      const target = row('SELECT * FROM publish_targets WHERE id=?', targetId);
      if (target) {
        run(`UPDATE publish_targets SET status='PUBLISHED',submission_status='SUBMITTED',review_status='PUBLISHED',publish_attempt_state='PUBLISHED',submit_lock='LOCKED',submitted_at=COALESCE(submitted_at,?),reviewed_at=COALESCE(reviewed_at,?),platform_url=COALESCE(?,platform_url),platform_post_id=COALESCE(?,platform_post_id),result=?,updated_at=? WHERE id=?`, stamp, stamp, platformUrl, platformPostId, JSON.stringify({ manuallyConfirmed: true, actualOutcome: 'PUBLISHED', issueId: item.id, note: resolution }), stamp, targetId);
        cancelQueuedPublishVerificationJobs(targetId, { reason: 'ISSUE_MANUAL_PUBLISHED_CONFIRMATION' });
        updateTaskAggregate(target.task_id);
      }
    }
    if (item.related_type === 'MESSAGE' && String(actualOutcome || '').toUpperCase() === 'SENT') {
      run("UPDATE messages SET status='MANUAL_HANDLED',decision='MANUAL_HANDLED',handled_at=COALESCE(handled_at,?),handled_by=?,handler_note=?,updated_at=? WHERE id=?", stamp, resolvedBy, resolution + '；已确认平台侧已发送，禁止自动补发', stamp, Number(item.related_id));
    }
    db.exec('COMMIT');
    return issueView(row('SELECT * FROM issues WHERE id=?', item.id));
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    throw error;
  }
}

function normalizeDetectedReplyText(value) {
  return String(value || '').trim().normalize('NFC');
}

function classifyDetectedReply(payload = {}) {
  const sourceReplyJobId = Number(payload.sourceReplyJobId || payload.replyJobIdAtCreation || 0);
  const sourceReplyJob = sourceReplyJobId > 0 ? row("SELECT * FROM agent_jobs WHERE id=? AND job_type='REPLY'", sourceReplyJobId) : null;
  const sourcePayload = json(sourceReplyJob?.payload, {});
  const sourceResult = json(sourceReplyJob?.result, {});
  const expectedReply = normalizeDetectedReplyText(payload.expectedReply);
  const sourceReplyText = normalizeDetectedReplyText(sourcePayload.replyText);
  const explicitAutoConfirmation = payload.detectionPurpose === 'CONFIRM_UNCERTAIN_AUTO_REPLY';
  const inferredAutoConfirmation = Boolean(
    sourceReplyJob
    && sourcePayload.replyMode !== 'MANUAL'
    && expectedReply
    && sourceReplyText === expectedReply
    && sourceResult.sendAttempted === true
    && ['NEEDS_CONFIRMATION', 'SUCCESS', 'FAILED'].includes(String(sourceReplyJob.status || '').toUpperCase())
  );
  const automatic = explicitAutoConfirmation || inferredAutoConfirmation;
  return {
    automatic,
    sourceReplyJobId: sourceReplyJob?.id || sourceReplyJobId || null,
    status: automatic ? 'AUTO_REPLIED' : 'MANUAL_HANDLED',
    decision: automatic ? 'AUTO_REPLY' : 'MANUAL_HANDLED',
    handledBy: automatic ? 'AI_RPA_CONFIRMED' : 'PLATFORM_DETECTED',
    defaultNote: automatic
      ? `已通过只读复核确认${payload.platformCode || '平台'}上的自动回复实际发送成功`
      : `已在${payload.platformCode || '平台'}检测到人工回复`
  };
}

function resolveReplyReceiptIssues(messageId, { stamp = now(), detectionJobId = null, note = '已通过只读复核确认平台回复实际存在' } = {}) {
  const activeIssues = rows(`SELECT * FROM issues WHERE source='RPA' AND category='REPLY'
    AND related_type='MESSAGE' AND related_id=?
    AND status IN ('OPEN','DIAGNOSING','DIAGNOSED','RETRYING')`, String(messageId));
  for (const item of activeIssues) {
    const resolution = `${note}${detectionJobId ? `；核验任务 #${detectionJobId}` : ''}`;
    run(`UPDATE issues SET status='RESOLVED',resolution_type='PLATFORM_REPLY_CONFIRMED',resolution=?,assignee='SYSTEM_READ_ONLY_VERIFY',resolved_by='SYSTEM_READ_ONLY_VERIFY',resolved_at=?,updated_at=? WHERE id=?`, resolution, stamp, stamp, item.id);
    releaseIssueBlocks(item.id, { releasedBy: 'SYSTEM_READ_ONLY_VERIFY', reason: resolution });
  }
  return activeIssues.length;
}

function messageIssueRetrySafety(issueItem, message) {
  const category = String(issueItem?.category || '').toUpperCase();
  const retryContext = json(message?.reply_context_json, {});
  if (category === 'MODEL_API') {
    const safe = Number(issueItem?.retryable) === 1
      && retryContext.retrySafe === true
      && retryContext.platformSendTaskCreated === false
      && !message?.reply_job_id;
    return {
      allowed: safe,
      reason: safe ? '模型判断阶段失败，已明确未创建平台发送任务' : '模型异常缺少“未创建平台发送任务”的明确证据'
    };
  }
  if (category === 'REPLY') return { allowed: true, requiresReplyJobSafety: true };
  return { allowed: false, reason: '该问题类型需要人工核对后处置' };
}

function resolveMessageIssuesForOperatorRetry(issues, reason, stamp = now()) {
  for (const item of issues) {
    run(`UPDATE issues SET status='RESOLVED',resolution_type='OPERATOR_SAFE_RETRY',resolution=?,assignee='WEB_OPERATOR',resolved_by='WEB_OPERATOR',resolved_at=?,updated_at=? WHERE id=?`, reason, stamp, stamp, item.id);
    releaseIssueBlocks(item.id, { releasedBy: 'WEB_OPERATOR', reason });
    run("UPDATE agent_jobs SET status='CANCELLED',completed_at=?,result=? WHERE job_type='DIAGNOSE_ISSUE' AND status='QUEUED' AND CAST(json_extract(payload,'$.issueId') AS INTEGER)=?", stamp, JSON.stringify({ message: '运营人员已发起安全重新判断，取消历史诊断任务' }), item.id);
    run("UPDATE issue_diagnoses SET status='CANCELLED',error_message=?,completed_at=?,updated_at=? WHERE issue_id=? AND status='QUEUED'", '运营人员已发起安全重新判断', stamp, stamp, item.id);
  }
  return issues.length;
}

function prepareSafeReplyRetry(message) {
  if (!message?.reply_job_id) return { allowed: true, previousJob: null };
  const previousJob = row('SELECT * FROM agent_jobs WHERE id=?', message.reply_job_id);
  if (!previousJob || previousJob.job_type !== 'REPLY') return { allowed: true, previousJob };
  const result = json(previousJob.result, {});
  const safeDeferredBeforeSend = isSafeDeferredReplyJob(previousJob);
  const safeFailedBeforeSend = previousJob.status === 'FAILED' && result.sendAttempted === false;
  if (safeDeferredBeforeSend || safeFailedBeforeSend) {
    if (previousJob.idempotency_key) {
      const archivedKey = `${previousJob.idempotency_key}:${safeDeferredBeforeSend ? 'deferred-pre-send' : 'failed-pre-send'}:${previousJob.id}`;
      run('UPDATE agent_jobs SET idempotency_key=? WHERE id=?', archivedKey, previousJob.id);
    }
    return {
      allowed: true,
      previousJob,
      safePreSendFailure: true,
      safeDeferredBeforeSend
    };
  }
  if (['QUEUED', 'RUNNING'].includes(previousJob.status)) {
    return { allowed: false, previousJob, message: '\u8be5\u6d88\u606f\u5df2\u6709\u56de\u590d\u4efb\u52a1\u6392\u961f\u6216\u6267\u884c\u4e2d\uff0c\u7981\u6b62\u91cd\u590d\u521b\u5efa' };
  }
  return {
    allowed: false,
    previousJob,
    message: result.sendAttempted === true
      ? '\u4e0a\u4e00\u6b21\u56de\u590d\u5df2\u53d1\u8d77\u5e73\u53f0\u8bf7\u6c42\uff0c\u7ed3\u679c\u4e0d\u53ef\u786e\u5b9a\uff1b\u4e3a\u9632\u6b62\u91cd\u590d\u56de\u590d\uff0c\u7981\u6b62\u81ea\u52a8\u91cd\u8bd5'
      : '\u4e0a\u4e00\u6b21\u56de\u590d\u6ca1\u6709\u660e\u786e\u7684\u672a\u53d1\u9001\u8bc1\u636e\uff1b\u4e3a\u9632\u6b62\u91cd\u590d\u56de\u590d\uff0c\u7981\u6b62\u81ea\u52a8\u91cd\u8bd5'
  };
}

function buildDraftFingerprint({ taskId, targetId, title, materialPath, materialSha256, durationSeconds, createdAt, accountId, platformCode }) {
  const fingerprint = {
    version: 1,
    taskId: Number(taskId),
    targetId: Number(targetId),
    title: String(title || '').trim(),
    materialName: path.basename(String(materialPath || '')),
    materialSha256: String(materialSha256 || '').toLowerCase(),
    durationSeconds: Number.isFinite(Number(durationSeconds)) ? Number(durationSeconds) : null,
    createdAt,
    accountId: Number(accountId),
    platformCode: String(platformCode || '')
  };
  return { ...fingerprint, fingerprintHash: hashString(JSON.stringify(fingerprint)) };
}

function publishAttemptStateForReview(reviewStatus, fallback = 'SUBMITTED') {
  if (reviewStatus === 'PUBLISHED') return 'PUBLISHED';
  if (reviewStatus === 'REJECTED') return 'REJECTED';
  if (['REVIEWING', 'SYNCING'].includes(reviewStatus)) return 'SUBMITTED';
  return fallback;
}

function getAccounts() {
  return rows(`SELECT a.*, p.name AS platform_name,COALESCE(p.desired_state,'RUNNING') AS platform_desired_state,
      p.runtime_updated_at AS platform_runtime_updated_at,p.runtime_updated_by AS platform_runtime_updated_by,
      COALESCE(p.lifecycle_state,'ACTIVE') AS platform_lifecycle_state,
      d.name AS device_name,d.status AS device_status
    FROM accounts a
    JOIN platforms p ON p.code=a.platform_code
    JOIN devices d ON d.id=a.device_id
    WHERE a.platform_code IN (${supportedPlatformPlaceholders})
    ORDER BY p.sort_order, a.id`, ...supportedPlatformCodes).map(account => ({
      ...account,
      platform_effective_state: account.enabled === 1 && account.platform_desired_state === 'RUNNING' && account.platform_lifecycle_state === 'ACTIVE' ? 'RUNNING' : 'STOPPED'
    }));
}
function getKnowledgeCategories() {
  const grouped = rows(`SELECT COALESCE(NULLIF(TRIM(category),''),?) AS name,
      COALESCE(NULLIF(TRIM(subcategory),''),?) AS subcategory,
      COUNT(*) AS total,
      SUM(CASE WHEN status='PUBLISHED' THEN 1 ELSE 0 END) AS published,
      SUM(CASE WHEN status='DRAFT' THEN 1 ELSE 0 END) AS draft,
      SUM(CASE WHEN status='DISABLED' THEN 1 ELSE 0 END) AS disabled
    FROM knowledge
    GROUP BY COALESCE(NULLIF(TRIM(category),''),?), COALESCE(NULLIF(TRIM(subcategory),''),?)`, PUBLIC_KNOWLEDGE_CATEGORY, DEFAULT_KNOWLEDGE_SUBCATEGORY, PUBLIC_KNOWLEDGE_CATEGORY, DEFAULT_KNOWLEDGE_SUBCATEGORY);
  const categories = new Map(SYSTEM_KNOWLEDGE_CATEGORIES.map(name => [name, { name, total: 0, published: 0, draft: 0, disabled: 0, subcategories: [], recentSubcategories: [] }]));
  for (const item of grouped) {
    if (!categories.has(item.name)) continue;
    const values = { name: item.subcategory, total: Number(item.total), published: Number(item.published), draft: Number(item.draft), disabled: Number(item.disabled) };
    const category = categories.get(item.name);
    category.total += values.total; category.published += values.published; category.draft += values.draft; category.disabled += values.disabled;
    category.subcategories.push(values);
  }
  return [...categories.values()]
    .map(category => ({
      ...category,
      recentSubcategories: listKnowledgeSubcategoryCache(category.name).map(item => item.subcategory),
      subcategories: category.subcategories.sort((a, b) => (a.name === DEFAULT_KNOWLEDGE_SUBCATEGORY ? -1 : b.name === DEFAULT_KNOWLEDGE_SUBCATEGORY ? 1 : a.name.localeCompare(b.name, 'zh-CN')))
    }))
    .sort((a, b) => knowledgeCategorySortIndex(a.name) - knowledgeCategorySortIndex(b.name));
}

function deleteKnowledgeScope(whereSql, params) {
  const targets = rows(`SELECT id FROM knowledge WHERE ${whereSql}`, ...params);
  if (!targets.length) return 0;
  db.exec('BEGIN IMMEDIATE');
  try {
    run(`UPDATE messages SET knowledge_question_snapshot=COALESCE(knowledge_question_snapshot,(SELECT question FROM knowledge WHERE knowledge.id=messages.knowledge_id)),knowledge_answer_snapshot=COALESCE(knowledge_answer_snapshot,(SELECT answer FROM knowledge WHERE knowledge.id=messages.knowledge_id)) WHERE knowledge_id IN (SELECT id FROM knowledge WHERE ${whereSql})`, ...params);
    run(`UPDATE messages SET knowledge_id=NULL WHERE knowledge_id IN (SELECT id FROM knowledge WHERE ${whereSql})`, ...params);
    run(`UPDATE knowledge SET matched_knowledge_id=NULL WHERE matched_knowledge_id IN (SELECT id FROM knowledge WHERE ${whereSql})`, ...params);
    const result = run(`DELETE FROM knowledge WHERE ${whereSql}`, ...params);
    db.exec('COMMIT');
    return Number(result.changes);
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function retryTargetKey(target) {
  return `${target.platform_code}:${Number(target.account_id)}`;
}

function retryEvidenceTime(candidate) {
  return candidate.reviewed_at || candidate.submitted_at || candidate.target_updated_at || candidate.retry_task_updated_at || candidate.retry_task_created_at || null;
}

function compareRetryCandidates(left, right) {
  const timeOrder = String(retryEvidenceTime(right) || '').localeCompare(String(retryEvidenceTime(left) || ''));
  return timeOrder || Number(right.retry_task_id) - Number(left.retry_task_id) || Number(right.retry_target_id) - Number(left.retry_target_id);
}

function decorateTaskRetryRecovery(tasks) {
  if (!tasks.length) return tasks;
  const retryTasks = rows(`SELECT id,retry_of_task_id,status,created_at,updated_at
    FROM publish_tasks
    WHERE retry_of_task_id IS NOT NULL
    ORDER BY id`);
  if (!retryTasks.length) return tasks;

  const childrenByTask = new Map();
  for (const retryTask of retryTasks) {
    const sourceId = Number(retryTask.retry_of_task_id);
    if (!childrenByTask.has(sourceId)) childrenByTask.set(sourceId, []);
    childrenByTask.get(sourceId).push(Number(retryTask.id));
  }
  const retryTargetsByTask = new Map();
  for (const candidate of rows(`SELECT rt.id AS retry_task_id,rt.retry_of_task_id,rt.status AS retry_task_status,
      rt.created_at AS retry_task_created_at,rt.updated_at AS retry_task_updated_at,
      target.id AS retry_target_id,target.platform_code,target.account_id,target.status,
      target.submission_status,target.review_status,target.publish_attempt_state,target.submitted_at,target.reviewed_at,
      target.updated_at AS target_updated_at
    FROM publish_tasks rt
    JOIN publish_targets target ON target.task_id=rt.id
    WHERE rt.retry_of_task_id IS NOT NULL
    ORDER BY rt.id DESC,target.id DESC`)) {
    const retryTaskId = Number(candidate.retry_task_id);
    if (!retryTargetsByTask.has(retryTaskId)) retryTargetsByTask.set(retryTaskId, []);
    retryTargetsByTask.get(retryTaskId).push(candidate);
  }

  const descendantsFor = sourceTaskId => {
    const found = [];
    const seen = new Set();
    const pending = [...(childrenByTask.get(Number(sourceTaskId)) || [])];
    while (pending.length) {
      const taskId = Number(pending.shift());
      if (!taskId || seen.has(taskId)) continue;
      seen.add(taskId);
      found.push(taskId);
      pending.push(...(childrenByTask.get(taskId) || []));
    }
    return found;
  };

  return tasks.map(task => {
    if (!['FAILED', 'PARTIAL_FAILED'].includes(task.status)) return task;
    const failedTargets = (task.targets || []).filter(target => ['FAILED', 'REJECTED'].includes(target.status));
    if (!failedTargets.length) return task;
    const descendantIds = descendantsFor(task.id);
    if (!descendantIds.length) return task;
    const candidatesByKey = new Map();
    for (const retryTaskId of descendantIds) {
      for (const candidate of retryTargetsByTask.get(retryTaskId) || []) {
        const key = retryTargetKey(candidate);
        if (!candidatesByKey.has(key)) candidatesByKey.set(key, []);
        candidatesByKey.get(key).push(candidate);
      }
    }

    let recoveredTargetCount = 0;
    let pendingTargetCount = 0;
    let failedRetryTargetCount = 0;
    const relevantRetryTaskIds = new Set();
    const successfulRetryTaskIds = new Set();
    const enrichedTargets = (task.targets || []).map(target => {
      if (!['FAILED', 'REJECTED'].includes(target.status)) return target;
      const candidates = (candidatesByKey.get(retryTargetKey(target)) || []).sort(compareRetryCandidates);
      if (!candidates.length) return target;
      for (const candidate of candidates) relevantRetryTaskIds.add(Number(candidate.retry_task_id));
      const recoveredCandidate = candidates.find(candidate => candidate.status === 'PUBLISHED');
      if (recoveredCandidate) {
        recoveredTargetCount += 1;
        successfulRetryTaskIds.add(Number(recoveredCandidate.retry_task_id));
        return {
          ...target,
          retryRecovery: {
            status: 'RECOVERED',
            recovered: true,
            retryTaskId: Number(recoveredCandidate.retry_task_id),
            retryTargetId: Number(recoveredCandidate.retry_target_id),
            recoveredAt: retryEvidenceTime(recoveredCandidate)
          }
        };
      }
      const pendingCandidate = candidates.find(candidate => ['QUEUED', 'EXECUTING', 'RUNNING', 'SUBMITTED', 'REVIEWING', 'SYNCING', 'NEEDS_CONFIRMATION'].includes(candidate.status));
      if (pendingCandidate) {
        pendingTargetCount += 1;
        return {
          ...target,
          retryRecovery: {
            status: 'IN_PROGRESS',
            recovered: false,
            retryTaskId: Number(pendingCandidate.retry_task_id),
            retryTargetId: Number(pendingCandidate.retry_target_id),
            recoveredAt: null
          }
        };
      }
      failedRetryTargetCount += 1;
      const failedCandidate = candidates[0];
      return {
        ...target,
        retryRecovery: {
          status: 'FAILED',
          recovered: false,
          retryTaskId: Number(failedCandidate.retry_task_id),
          retryTargetId: Number(failedCandidate.retry_target_id),
          recoveredAt: null
        }
      };
    });

    if (!relevantRetryTaskIds.size) return task;
    const allRecovered = recoveredTargetCount === failedTargets.length;
    const recoveryStatus = allRecovered ? 'RECOVERED' : recoveredTargetCount > 0 ? 'PARTIAL' : pendingTargetCount > 0 ? 'IN_PROGRESS' : 'FAILED';
    const successfulCandidates = [...successfulRetryTaskIds].sort((a, b) => b - a);
    const allCandidates = [...relevantRetryTaskIds].sort((a, b) => b - a);
    const recoveredTimes = enrichedTargets.map(target => target.retryRecovery?.recoveredAt).filter(Boolean).sort();
    return {
      ...task,
      targets: enrichedTargets,
      displayStatus: allRecovered ? 'RECOVERED_BY_RETRY' : task.status,
      retryRecovery: {
        status: recoveryStatus,
        recovered: allRecovered,
        failedTargetCount: failedTargets.length,
        recoveredTargetCount,
        pendingTargetCount,
        failedRetryTargetCount,
        retryTaskId: successfulCandidates[0] || allCandidates[0] || null,
        retryTaskIds: allCandidates,
        recoveredAt: allRecovered ? (recoveredTimes.at(-1) || null) : null
      }
    };
  });
}

function getTasks(platformCode = null) {
  const tasks = platformCode
    ? rows(`SELECT pt.* FROM publish_tasks pt
        WHERE EXISTS (SELECT 1 FROM publish_targets target WHERE target.task_id=pt.id AND target.platform_code=?)
        ORDER BY pt.id DESC LIMIT 100`, platformCode)
    : rows('SELECT * FROM publish_tasks ORDER BY id DESC LIMIT 100');
  const targetStmt = platformCode
    ? db.prepare(`SELECT t.*, p.name AS platform_name, a.display_name AS account_name, a.profile_name
        FROM publish_targets t JOIN platforms p ON p.code=t.platform_code JOIN accounts a ON a.id=t.account_id
        WHERE t.task_id=? AND t.platform_code=? ORDER BY p.sort_order`)
    : db.prepare(`SELECT t.*, p.name AS platform_name, a.display_name AS account_name, a.profile_name
        FROM publish_targets t JOIN platforms p ON p.code=t.platform_code JOIN accounts a ON a.id=t.account_id
        WHERE t.task_id=? ORDER BY p.sort_order`);
  return decorateTaskRetryRecovery(tasks.map(task => {
    const targets = platformCode ? targetStmt.all(task.id, platformCode) : targetStmt.all(task.id);
    return { ...task, material_meta: json(task.material_meta, {}), compliance: json(task.compliance_json, {}), targets: targets.map(decoratePublishTarget) };
  }));
}

function getTask(taskId) {
  const task = row('SELECT * FROM publish_tasks WHERE id=?', Number(taskId));
  if (!task) return null;
  const targets = rows(`SELECT t.*, p.name AS platform_name, a.display_name AS account_name, a.profile_name
    FROM publish_targets t JOIN platforms p ON p.code=t.platform_code JOIN accounts a ON a.id=t.account_id
    WHERE t.task_id=? ORDER BY p.sort_order`, task.id);
  return decorateTaskRetryRecovery([{ ...task, material_meta: json(task.material_meta, {}), compliance: json(task.compliance_json, {}), targets: targets.map(decoratePublishTarget) }])[0];
}

function deletePublishTask(taskId) {
  const id = Number(taskId);
  const stamp = now();
  db.exec('BEGIN IMMEDIATE');
  try {
    const task = row('SELECT id,title,status FROM publish_tasks WHERE id=?', id);
    if (!task) {
      db.exec('ROLLBACK');
      return { notFound: true };
    }
    const runningJobs = rows(`SELECT id FROM agent_jobs
      WHERE job_type='PUBLISH' AND status='RUNNING'
        AND CAST(json_extract(payload,'$.taskId') AS INTEGER)=?
      ORDER BY id`, id);
    if (runningJobs.length) {
      db.exec('ROLLBACK');
      return { blocked: true, task, runningJobIds: runningJobs.map(item => Number(item.id)) };
    }
    const targetCount = Number(row('SELECT COUNT(*) AS c FROM publish_targets WHERE task_id=?', id).c || 0);
    const cancelled = run(`UPDATE agent_jobs
      SET status='CANCELLED',result=?,completed_at=?,lease_expires_at=NULL
      WHERE job_type IN ('PUBLISH','VERIFY_PUBLISH') AND status='QUEUED'
        AND CAST(json_extract(payload,'$.taskId') AS INTEGER)=?`,
      JSON.stringify({ message: '发布任务已由管理员删除，排队执行及状态核验已取消', reason: 'PUBLISH_TASK_DELETED' }), stamp, id);
    run('UPDATE publish_tasks SET retry_of_task_id=NULL,updated_at=? WHERE retry_of_task_id=?', stamp, id);
    const deleted = run('DELETE FROM publish_tasks WHERE id=?', id);
    if (!deleted.changes) throw new Error('发布任务删除失败');
    db.exec('COMMIT');
    return { task, targetCount, cancelledJobs: Number(cancelled.changes || 0) };
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    throw error;
  }
}

function getTaskPlatformCounts() {
  return rows(`SELECT p.code,p.name,p.sort_order,COUNT(DISTINCT t.task_id) AS task_count
    FROM platforms p
    LEFT JOIN publish_targets t ON t.platform_code=p.code
    WHERE p.code IN (${activePlatformPlaceholders})
    GROUP BY p.code,p.name,p.sort_order
    ORDER BY p.sort_order`, ...activePlatformCodes).map(item => ({ ...item, task_count: Number(item.task_count || 0) }));
}
function publishRequestError(statusCode, message, detail = null, code = 'PUBLISH_REQUEST_INVALID') {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.detail = detail;
  error.code = code;
  return error;
}

function preparePublishRequest(data, { complianceMaxAgeMs = config.aiReviewMaxAgeMs, checkDuplicate = true } = {}) {
  const title = String(data.title || '').trim();
  const bodyText = String(data.body || '').trim();
  const materialPath = String(data.materialPath || '').trim();
  if (!title || !bodyText || !materialPath) throw publishRequestError(400, '标题、正文和本地素材路径不能为空');
  if (!Array.isArray(data.targets) || !data.targets.length) throw publishRequestError(400, '至少选择一个平台账号');
  const targets = data.targets.map(target => ({ platformCode: String(target?.platformCode || '').trim(), accountId: Number(target?.accountId) }));
  const contentOrigin = normalizeContentOrigin(data.contentOrigin);
  if (targets.some(target => target.platformCode === 'weibo') && !contentOrigin) throw publishRequestError(400, '发布到微博前必须明确选择内容来源，系统不会猜测内容声明');
  const retryOfTaskId = Number(data.retryOfTaskId) > 0 ? Number(data.retryOfTaskId) : null;
  if (retryOfTaskId) {
    const sourceTask = row('SELECT id,status FROM publish_tasks WHERE id=?', retryOfTaskId);
    if (!sourceTask) throw publishRequestError(404, '再次发送的原任务不存在');
    if (!['FAILED','PARTIAL_FAILED'].includes(sourceTask.status)) throw publishRequestError(409, '只有发送失败或部分失败的任务可以再次发送');
    const failedTargets = rows("SELECT platform_code,account_id FROM publish_targets WHERE task_id=? AND status IN ('FAILED','REJECTED') AND submit_lock='UNLOCKED' AND submit_attempted_at IS NULL", retryOfTaskId);
    const retryableTargetKeys = new Set(failedTargets.map(item => `${item.platform_code}:${item.account_id}`));
    if (!retryableTargetKeys.size) throw publishRequestError(409, '原任务没有可再次发送的失败平台');
    const invalidRetryTarget = targets.find(target => !retryableTargetKeys.has(`${target.platformCode}:${target.accountId}`));
    if (invalidRetryTarget) throw publishRequestError(409, '再次发送只能选择原任务中发送失败的平台账号');
  }
  const normalizedData = { ...data, title, body: bodyText, materialPath, targets, contentOrigin };
  const precheckValidation = validatePublishPrecheck(normalizedData);
  if (!precheckValidation.ok) throw publishRequestError(400, precheckValidation.message);
  let materialSha;
  try { materialSha = sha256LocalFile(materialPath); }
  catch { throw publishRequestError(400, '本地素材不存在或不可读取，请重新检测素材'); }
  contentLibrary.assertPublishMaterial(materialPath, materialSha);
  const precheckSha = String(data.precheck?.meta?.sha256 || '').toLowerCase();
  if (!precheckSha || precheckSha !== materialSha) throw publishRequestError(409, '素材文件已发生变化，请重新检测素材并执行 AI 审核');
  let compliance = data.aiReview;
  if (!compliance && getAiSettingsSummary().mode !== 'online') compliance = buildMockAiReview({
    title, body: bodyText, contentOrigin, materialSha256: materialSha,
    sourceType: data.precheck?.meta?.type || '', frameCount: data.precheck?.meta?.type === 'video' ? config.ocrVideoFrameCount : 1
  });
  const complianceValidation = validateAiReviewApproval(compliance, {
    title, body: bodyText, contentOrigin, materialSha256: materialSha,
    confirmed: data.complianceConfirmed === true, maxAgeMs: complianceMaxAgeMs
  });
  if (!complianceValidation.ok) {
    const statusCode = compliance?.overall === 'BLOCKED' || compliance?.status === 'FAILED' ? 422 : 409;
    throw publishRequestError(statusCode, complianceValidation.message, compliance, 'PUBLISH_COMPLIANCE_REJECTED');
  }
  const verified = [];
  const runtimeByPlatform = getPlatformRuntimeMap();
  for (const target of targets) {
    if (!activePlatformCodes.includes(target.platformCode)) throw publishRequestError(400, `发布平台不存在：${target.platformCode}`);
    const runtime = runtimeByPlatform[target.platformCode];
    if (!isPlatformRuntimeEnabled(runtime)) throw publishRequestError(409, `平台 ${runtime?.name || target.platformCode} 已停止，不能创建发布任务`, runtime);
    const account = row('SELECT * FROM accounts WHERE id=? AND platform_code=? AND enabled=1', target.accountId, target.platformCode);
    if (!account) throw publishRequestError(400, `平台账号配置不匹配：${target.platformCode}`);
    if (account.login_status !== 'READY') throw publishRequestError(409, `账号 ${account.display_name} 登录状态不是 READY，请先在 RPA 电脑人工恢复登录`);
    verified.push({ target, account });
  }
  const idempotencyKey = buildPublishIdempotencyKey({ targets: verified.map(item => ({ accountId: item.account.id, platformCode: item.target.platformCode })), materialSha, title, body: bodyText, retryOfTaskId });
  if (checkDuplicate) {
    const duplicate = row('SELECT id,status,created_at FROM publish_tasks WHERE idempotency_key=?', idempotencyKey);
    if (duplicate) throw publishRequestError(409, `检测到相同账号、素材和文案的发布任务 #${duplicate.id}，为防止重复发布已拒绝创建`, { existingTaskId: duplicate.id, status: duplicate.status }, 'PUBLISH_DUPLICATE');
  }
  const publishMode = data.publishMode === 'AUTO' && data.managementConfirmed === true ? 'AUTO' : 'DRAFT_ONLY';
  const effectiveMaterialMeta = data.materialMeta || data.precheck.meta || {};
  return {
    data: { ...normalizedData, aiReview: compliance }, title, bodyText, materialPath, targets, contentOrigin, retryOfTaskId,
    compliance, verified, materialSha, idempotencyKey, publishMode, effectiveMaterialMeta
  };
}

function createPreparedPublishTask(prepared, { idempotencyKey = prepared.idempotencyKey, onCreated = null } = {}) {
  const stamp = now();
  db.exec('BEGIN IMMEDIATE');
  try {
    const taskId = Number(run(`INSERT INTO publish_tasks(title,body,material_path,material_meta,retry_of_task_id,status,created_at,updated_at,idempotency_key,compliance_json,compliance_rule_version,confirmed_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`, prepared.title, prepared.bodyText, prepared.materialPath, JSON.stringify({ meta: prepared.effectiveMaterialMeta, precheck: prepared.data.precheck, publishMode: prepared.publishMode, contentOrigin: prepared.contentOrigin, imageText: prepared.data.imageText || '', retryOfTaskId: prepared.retryOfTaskId }), prepared.retryOfTaskId, 'QUEUED', stamp, stamp, idempotencyKey, JSON.stringify(prepared.compliance), prepared.compliance.ruleVersion, prepared.compliance.overall === 'WARNING' ? stamp : null).lastInsertRowid);
    for (const { target, account } of prepared.verified) {
      const targetId = Number(run(`INSERT INTO publish_targets(task_id,platform_code,account_id,status,submission_status,review_status,publish_attempt_state,submit_lock,updated_at) VALUES(?,?,?,'QUEUED','NOT_SUBMITTED','UNKNOWN','NOT_ATTEMPTED','UNLOCKED',?)`, taskId, target.platformCode, account.id, stamp).lastInsertRowid);
      const draftFingerprint = buildDraftFingerprint({ taskId, targetId, title: prepared.title, materialPath: prepared.materialPath, materialSha256: prepared.materialSha, durationSeconds: prepared.effectiveMaterialMeta.durationSeconds, createdAt: stamp, accountId: account.id, platformCode: target.platformCode });
      run('UPDATE publish_targets SET draft_fingerprint=? WHERE id=?', JSON.stringify(draftFingerprint), targetId);
      createJob(account.device_id, 'PUBLISH', { taskId, targetId, retryOfTaskId: prepared.retryOfTaskId, platformCode: target.platformCode, accountId: account.id, accountName: account.display_name, profileName: account.profile_name, title: prepared.title, body: prepared.bodyText, materialPath: prepared.materialPath, materialMeta: prepared.effectiveMaterialMeta, materialSha256: prepared.materialSha, draftFingerprint, taskCreatedAt: stamp, precheck: prepared.data.precheck, compliance: prepared.compliance, publishMode: prepared.publishMode, managementConfirmed: prepared.data.managementConfirmed === true, contentOrigin: prepared.contentOrigin }, { idempotencyKey: `publish:target:${targetId}` });
    }
    if (typeof onCreated === 'function') onCreated({ taskId, stamp });
    db.exec('COMMIT');
    return { taskId, task: getTask(taskId), compliance: prepared.compliance };
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    throw error;
  }
}

function validateScheduledLocalTime(data) {
  const localText = String(data.scheduledLocal || '').trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/.exec(localText);
  if (!match) throw publishRequestError(400, '请选择完整的年月日、时分秒');
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number);
  const check = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day || check.getUTCHours() !== hour || check.getUTCMinutes() !== minute || check.getUTCSeconds() !== second) throw publishRequestError(400, '选择的日期时间不存在，请重新选择');
  const timezoneOffsetMinutes = Number(data.timezoneOffsetMinutes);
  if (!Number.isInteger(timezoneOffsetMinutes) || timezoneOffsetMinutes < -840 || timezoneOffsetMinutes > 840) throw publishRequestError(400, '电脑时区信息无效，请刷新页面后重试');
  const expectedMs = Date.UTC(year, month - 1, day, hour, minute, second) + timezoneOffsetMinutes * 60_000;
  const scheduledDate = new Date(String(data.scheduledAt || ''));
  if (Number.isNaN(scheduledDate.getTime()) || Math.abs(scheduledDate.getTime() - expectedMs) > 1000) throw publishRequestError(400, '发布时间与电脑本地时间不一致，请重新选择');
  const delayMs = scheduledDate.getTime() - Date.now();
  if (delayMs < 3000) throw publishRequestError(400, '定时发布时间至少需要晚于电脑当前时间 3 秒');
  if (delayMs > 5 * 366 * 24 * 60 * 60 * 1000) throw publishRequestError(400, '定时发布时间不能超过未来 5 年');
  return { scheduledAt: scheduledDate.toISOString(), scheduledLocalText: localText, timezoneOffsetMinutes };
}

function scheduledPublishView(record) {
  const payload = json(record.payload, {});
  const targets = Array.isArray(payload.targets) ? payload.targets.map(target => {
    const account = row(`SELECT a.display_name,a.platform_code,p.name AS platform_name FROM accounts a JOIN platforms p ON p.code=a.platform_code WHERE a.id=?`, Number(target.accountId));
    return { platformCode: target.platformCode, platformName: account?.platform_name || target.platformCode, accountId: Number(target.accountId), accountName: account?.display_name || `账号 #${target.accountId}` };
  }) : [];
  const { payload: ignoredPayload, ...visible } = record;
  return { ...visible, target_count: Number(record.target_count || targets.length), targets };
}

function syncScheduledPublishStatuses() {
  const stamp = now();
  run(`UPDATE scheduled_publish_tasks SET status='COMPLETED',completed_at=COALESCE(completed_at,?),updated_at=?,error_code=NULL,error_message=NULL WHERE status IN ('TRIGGERING','RUNNING') AND publish_task_id IN (SELECT id FROM publish_tasks WHERE status='PUBLISHED')`, stamp, stamp);
  run(`UPDATE scheduled_publish_tasks SET status='FAILED',completed_at=COALESCE(completed_at,?),updated_at=?,error_code='PUBLISH_TASK_FAILED',error_message=COALESCE(error_message,'关联发布任务执行失败，请到任务中心查看各平台原因') WHERE status IN ('TRIGGERING','RUNNING') AND publish_task_id IN (SELECT id FROM publish_tasks WHERE status IN ('FAILED','PARTIAL_FAILED'))`, stamp, stamp);
}

function listScheduledPublishes(limit = 50) {
  syncScheduledPublishStatuses();
  const safeLimit = Math.min(100, Math.max(1, Number(limit) || 50));
  const records = rows(`SELECT * FROM scheduled_publish_tasks ORDER BY CASE status WHEN 'PENDING' THEN 0 WHEN 'TRIGGERING' THEN 1 WHEN 'RUNNING' THEN 2 ELSE 3 END, CASE WHEN status='PENDING' THEN scheduled_at END ASC, created_at DESC LIMIT ?`, safeLimit).map(scheduledPublishView);
  return { records, total: Number(row('SELECT COUNT(*) AS c FROM scheduled_publish_tasks').c || 0), computerTime: now() };
}

function claimDueScheduledPublishes(batchSize = 10) {
  const stamp = now();
  const claimed = [];
  db.exec('BEGIN IMMEDIATE');
  try {
    const due = rows(`SELECT id FROM scheduled_publish_tasks WHERE status='PENDING' AND scheduled_at<=? ORDER BY scheduled_at,id LIMIT ?`, stamp, Math.max(1, Number(batchSize) || 10));
    for (const item of due) {
      const result = run(`UPDATE scheduled_publish_tasks SET status='TRIGGERING',claimed_at=?,updated_at=?,error_code=NULL,error_message=NULL WHERE id=? AND status='PENDING'`, stamp, stamp, Number(item.id));
      if (result.changes) claimed.push(Number(item.id));
    }
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    throw error;
  }
  return claimed.map(id => row('SELECT * FROM scheduled_publish_tasks WHERE id=?', id)).filter(Boolean);
}

function failScheduledPublish(id, error) {
  const stamp = now();
  run(`UPDATE scheduled_publish_tasks SET status='FAILED',error_code=?,error_message=?,completed_at=?,updated_at=? WHERE id=? AND status IN ('TRIGGERING','PENDING')`, String(error.code || 'SCHEDULE_TRIGGER_FAILED'), String(error.message || '定时发布任务执行失败'), stamp, stamp, Number(id));
}

function triggerScheduledPublish(schedule) {
  if (!operationsEnabled()) throw publishRequestError(409, '到达发布时间时系统处于暂停状态，未创建发布任务', null, 'OPERATIONS_PAUSED');
  const payload = json(schedule.payload, null);
  if (!payload) throw publishRequestError(500, '定时发布任务数据损坏', null, 'SCHEDULE_PAYLOAD_INVALID');
  const prepared = preparePublishRequest(payload, { complianceMaxAgeMs: Number.MAX_SAFE_INTEGER, checkDuplicate: false });
  const scheduledTaskKey = hashString(`scheduled-publish:${schedule.id}:${prepared.idempotencyKey}`);
  return createPreparedPublishTask(prepared, {
    idempotencyKey: scheduledTaskKey,
    onCreated: ({ taskId, stamp }) => {
      const updated = run(`UPDATE scheduled_publish_tasks SET status='RUNNING',publish_task_id=?,triggered_at=?,updated_at=?,error_code=NULL,error_message=NULL WHERE id=? AND status='TRIGGERING'`, taskId, stamp, stamp, Number(schedule.id));
      if (!updated.changes) throw publishRequestError(409, '定时发布任务状态已变化，已停止重复执行', null, 'SCHEDULE_STATE_CHANGED');
    }
  });
}

function processDueScheduledPublishes() {
  if (scheduledPublishTickRunning) return;
  scheduledPublishTickRunning = true;
  try {
    syncScheduledPublishStatuses();
    for (const schedule of claimDueScheduledPublishes()) {
      try { triggerScheduledPublish(schedule); }
      catch (error) { failScheduledPublish(schedule.id, error); console.error(`[scheduled publish] #${schedule.id} failed: ${error.message}`); }
    }
  } catch (error) {
    console.error(`[scheduled publish] scheduler tick failed: ${error.message}`);
  } finally { scheduledPublishTickRunning = false; }
}

function startScheduledPublishScheduler() {
  if (scheduledPublishTimer) return;
  const stamp = now();
  run(`UPDATE scheduled_publish_tasks SET status='PENDING',claimed_at=NULL,updated_at=?,error_code=NULL,error_message=NULL WHERE status='TRIGGERING' AND publish_task_id IS NULL`, stamp);
  processDueScheduledPublishes();
  scheduledPublishTimer = setInterval(processDueScheduledPublishes, 500);
  scheduledPublishTimer.unref();
}

function stopScheduledPublishScheduler() {
  if (scheduledPublishTimer) clearInterval(scheduledPublishTimer);
  scheduledPublishTimer = null;
}

function getPublishHistory(page = 1, pageSize = 5) {
  const safePageSize = Math.min(20, Math.max(1, Number(pageSize) || 5));
  const total = Number(row("SELECT COUNT(*) AS c FROM publish_tasks WHERE status IN ('PUBLISHED','FAILED','PARTIAL_FAILED')").c || 0);
  const totalPages = Math.max(1, Math.ceil(total / safePageSize));
  const safePage = Math.min(totalPages, Math.max(1, Number(page) || 1));
  const offset = (safePage - 1) * safePageSize;
  const records = rows(`SELECT pt.*,
      CASE WHEN pt.status='PUBLISHED'
        THEN COALESCE(MAX(CASE WHEN t.status='PUBLISHED' THEN COALESCE(t.reviewed_at,t.updated_at) END),pt.updated_at,pt.created_at)
        ELSE COALESCE(MAX(CASE WHEN t.status IN ('FAILED','REJECTED') THEN COALESCE(t.reviewed_at,t.updated_at) END),pt.updated_at,pt.created_at)
      END AS publish_time
    FROM publish_tasks pt
    LEFT JOIN publish_targets t ON t.task_id=pt.id
    WHERE pt.status IN ('PUBLISHED','FAILED','PARTIAL_FAILED')
    GROUP BY pt.id
    ORDER BY publish_time DESC,pt.id DESC
    LIMIT ? OFFSET ?`, safePageSize, offset);
  const targetStmt = db.prepare(`SELECT t.*,p.name AS platform_name,a.display_name AS account_name,a.profile_name
    FROM publish_targets t JOIN platforms p ON p.code=t.platform_code JOIN accounts a ON a.id=t.account_id
    WHERE t.task_id=? ORDER BY p.sort_order,t.id`);
  return {
    records: records.map(task => ({
      ...task,
      publish_status: task.status === 'PUBLISHED' ? 'SUCCESS' : 'FAILED',
      material_meta: json(task.material_meta, {}),
      compliance: json(task.compliance_json, {}),
      targets: targetStmt.all(task.id).map(target => ({ ...target, result: json(target.result, target.result), evidence: json(target.evidence_json, {}) }))
    })),
    page: safePage,
    pageSize: safePageSize,
    total,
    totalPages
  };
}

function messageReplyStatus(item) {
  const platformDetected = item.message_type === 'PRIVATE_MESSAGE' && item.handled_by === 'PLATFORM_DETECTED'
    && Boolean(item.handled_at) && json(item.context_json, {}).platformReplyDetected === true;
  const aiReplied = !platformDetected && (item.status === 'AUTO_REPLIED' || item.handled_by === 'AI_RPA');
  const manualReplied = !platformDetected && Boolean(item.handled_at && item.handled_by && item.handled_by !== 'AI_RPA');
  const replyJobStatus = String(item.reply_job_status || '').toUpperCase();
  const messageQueued = ['REPLY_QUEUED', 'REPLY_RUNNING'].includes(item.status);
  const manualQueued = item.decision === 'MANUAL_REPLY' && messageQueued;
  const activeState = replyJobStatus === 'QUEUED'
    ? 'QUEUED'
    : replyJobStatus === 'RUNNING'
      ? 'SENDING'
      : replyJobStatus
        ? 'FAILED'
        : 'PROCESSING';

  let aiState = 'NOT_REPLIED';
  if (aiReplied) aiState = 'REPLIED';
  else if (!manualQueued && messageQueued) aiState = activeState;
  else if (item.decision === 'TECHNICAL_ERROR' || (item.decision === 'AUTO_REPLY' && item.status === 'MANUAL_REQUIRED')) aiState = 'FAILED';

  let manualState = 'NOT_REPLIED';
  if (manualReplied) manualState = 'REPLIED';
  else if (manualQueued) manualState = activeState;
  else if (item.decision === 'MANUAL_REPLY' && item.status === 'MANUAL_REQUIRED') manualState = 'FAILED';
  else if (['MANUAL_REQUIRED', 'KNOWLEDGE_GAP'].includes(item.status)) manualState = 'PENDING';

  return {
    ai: { replied: aiReplied, state: aiState, jobStatus: replyJobStatus || null },
    manual: { replied: manualReplied, state: manualState, jobStatus: replyJobStatus || null },
    ...(platformDetected ? { platform: { replied: true, state: 'DETECTED' } } : {})
  };
}

function getMessageReplyExportItems(platformCodes = []) {
  const placeholders = platformCodes.map(() => '?').join(',');
  if (!placeholders) return [];
  const items = rows(`SELECT m.*,p.name AS platform_name,a.display_name AS account_name
    FROM messages m JOIN platforms p ON p.code=m.platform_code JOIN accounts a ON a.id=m.account_id
    WHERE m.platform_code IN (${placeholders}) AND m.handled_at IS NOT NULL
      AND m.deleted_at IS NULL
      AND COALESCE(m.decision,'') <> 'SELF_MESSAGE'
      AND COALESCE(m.status,'') <> 'IGNORED_SELF'
      AND (m.status IN ('AUTO_REPLIED','MANUAL_HANDLED') OR m.handled_by IS NOT NULL)
    ORDER BY COALESCE(m.handled_at,m.updated_at) DESC,m.id DESC`, ...platformCodes);
  const candidateCache = new Map();
  return items.map(item => {
    if (item.message_type !== 'COMMENT') return item;
    const cacheKey = `${item.platform_code}:${item.account_id}`;
    if (!candidateCache.has(cacheKey)) candidateCache.set(cacheKey, messageNoteCandidates(item.platform_code, item.account_id));
    const post = resolveRelatedNote(json(item.context_json, {}), candidateCache.get(cacheKey));
    return { ...item, post_title: post.title || '未识别关联帖子', post_url: post.url || '' };
  });
}

function softDeleteMessage(messageId, { deletedBy = '运营人员', deleteReason = '运营人员从评论与私信列表中移除' } = {}) {
  const stamp = now();
  const actor = String(deletedBy || '运营人员').trim().slice(0, 100) || '运营人员';
  const reason = String(deleteReason || '运营人员从评论与私信列表中移除').trim().slice(0, 500) || '运营人员从评论与私信列表中移除';
  db.exec('BEGIN IMMEDIATE');
  try {
    const message = row('SELECT * FROM messages WHERE id=?', Number(messageId));
    if (!message) { db.exec('ROLLBACK'); return { notFound: true }; }
    if (message.deleted_at) { db.exec('COMMIT'); return { message, alreadyDeleted: true, cancelledJobs: 0 }; }
    const runningReply = row(`SELECT id FROM agent_jobs
      WHERE job_type='REPLY' AND status='RUNNING'
        AND (id=? OR CAST(json_extract(payload,'$.messageId') AS INTEGER)=?)
      ORDER BY id DESC LIMIT 1`, Number(message.reply_job_id || 0), Number(messageId));
    if (runningReply) { db.exec('ROLLBACK'); return { runningReplyJobId: runningReply.id }; }

    const cancelled = run(`UPDATE agent_jobs SET status='CANCELLED',completed_at=COALESCE(completed_at,?),lease_expires_at=NULL,result=?
      WHERE status='QUEUED' AND job_type IN ('REPLY','DETECT_MANUAL_REPLY')
        AND (id=? OR CAST(json_extract(payload,'$.messageId') AS INTEGER)=?)`,
      stamp, JSON.stringify({ message: '消息已软删除，取消后续自动处理', decision: 'MESSAGE_SOFT_DELETED' }), Number(message.reply_job_id || 0), Number(messageId));
    run(`UPDATE reply_batches SET status='COMPLETED',invalidation_reason='MESSAGE_SOFT_DELETED',completed_at=COALESCE(completed_at,?),updated_at=?
      WHERE status IN ('PENDING','GENERATING','READY') AND (generation_message_id=? OR agent_job_id=?
        OR EXISTS (SELECT 1 FROM json_each(reply_batches.source_message_ids_json) source_message WHERE CAST(source_message.value AS INTEGER)=?))`,
      stamp, stamp, Number(messageId), Number(message.reply_job_id || 0), Number(messageId));

    const unfinished = !message.handled_at && !terminalMessageStatuses.has(String(message.status || '').toUpperCase());
    if (unfinished) {
      run(`UPDATE messages SET status='CLOSED',decision='OPERATOR_DISMISSED',handled_at=?,handled_by=?,handler_note=?,reply_job_id=NULL,
        deleted_at=?,deleted_by=?,delete_reason=?,updated_at=? WHERE id=?`,
        stamp, actor, '运营人员已移除该消息，系统停止后续自动处理；平台原消息及本地审计记录保留', stamp, actor, reason, stamp, Number(messageId));
    } else {
      run('UPDATE messages SET deleted_at=?,deleted_by=?,delete_reason=?,updated_at=? WHERE id=?', stamp, actor, reason, stamp, Number(messageId));
    }
    syncMessageProcessingRegistry(messageId, stamp);
    const deletedMessage = row('SELECT * FROM messages WHERE id=?', Number(messageId));
    db.exec('COMMIT');
    return { message: deletedMessage, alreadyDeleted: false, cancelledJobs: Number(cancelled.changes || 0), processingClosed: unfinished };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function getMessageChannelRuntimeStates() {
  const stateMap = new Map(rows(`SELECT platform_code,account_id,channel_type,state,consecutive_failures,
      last_scan_started_at,last_scan_completed_at,last_success_at,last_error_code,last_error_message,last_result_json,updated_at
    FROM channel_runtime_states`).map(item => {
      const normalized = {
        ...item,
        account_id: Number(item.account_id),
        consecutive_failures: Number(item.consecutive_failures || 0),
        last_result: json(item.last_result_json, null)
      };
      delete normalized.last_result_json;
      return [`${normalized.platform_code}:${normalized.account_id}:${normalized.channel_type}`, normalized];
    }));

  // 运行中的采集任务覆盖持久化终态，避免页面在采集期间仍显示上一次“成功/失败”。
  // 合并采集任务会映射到私信、评论两个通道；拆分任务只覆盖自己的通道。
  for (const job of rows(`SELECT id,status,payload,created_at,claimed_at FROM agent_jobs
    WHERE job_type='COLLECT_MESSAGES' AND status IN ('QUEUED','RUNNING') ORDER BY id ASC`)) {
    const payload = json(job.payload, {});
    const platformCode = String(payload.platformCode || '').trim().toLowerCase();
    const accountId = Number(payload.accountId);
    if (!platformCode || !Number.isInteger(accountId) || accountId <= 0) continue;
    for (const channelType of collectionLedgerChannels(payload, {})) {
      const key = `${platformCode}:${accountId}:${channelType}`;
      const previous = stateMap.get(key) || {
        platform_code: platformCode,
        account_id: accountId,
        channel_type: channelType,
        consecutive_failures: 0,
        last_scan_started_at: null,
        last_scan_completed_at: null,
        last_success_at: null,
        last_error_code: null,
        last_error_message: null,
        last_result: null,
        updated_at: null
      };
      stateMap.set(key, {
        ...previous,
        state: job.status === 'RUNNING' ? 'RUNNING' : 'QUEUED',
        active_job_id: Number(job.id),
        active_job_status: job.status,
        last_scan_started_at: job.claimed_at || job.created_at || previous.last_scan_started_at
      });
    }
  }
  return [...stateMap.values()].sort((a, b) =>
    String(a.platform_code).localeCompare(String(b.platform_code))
      || Number(a.account_id) - Number(b.account_id)
      || String(a.channel_type).localeCompare(String(b.channel_type))
  );
}

function getMessages() {
  const messages = rows(`SELECT m.*, p.name AS platform_name, a.display_name AS account_name,
      reply_job.status AS reply_job_status, reply_job.result AS reply_job_result
    FROM messages m JOIN platforms p ON p.code=m.platform_code JOIN accounts a ON a.id=m.account_id
    LEFT JOIN agent_jobs reply_job ON reply_job.id=m.reply_job_id
    WHERE m.deleted_at IS NULL
      AND m.platform_code <> 'mini_program'
      AND COALESCE(m.decision,'') <> 'SELF_MESSAGE'
      AND COALESCE(m.status,'') <> 'IGNORED_SELF'
      AND NOT (m.status='SUPERSEDED' AND m.decision='DUPLICATE_PROCESSED_MESSAGE')
      AND NOT (m.decision IN ('HANDOFF_SUBMITTED','HANDOFF_NOTIFY_FAILED')
        AND COALESCE(m.wecom_notification_status,'NOT_REQUIRED') <> 'SENT')
    ORDER BY m.id DESC LIMIT 200`);
  const candidateCache = new Map();
  return messages.map(item => {
    const context = json(item.context_json, {});
    let post = null;
    if (item.message_type === 'COMMENT') {
      const cacheKey = `${item.platform_code}:${item.account_id}`;
      if (!candidateCache.has(cacheKey)) candidateCache.set(cacheKey, messageNoteCandidates(item.platform_code, item.account_id));
      post = resolveRelatedNote(context, candidateCache.get(cacheKey));
      post.key = post.id || post.url || post.title || item.parent_external_id || 'UNMATCHED_POST';
      post.title ||= '未识别关联帖子';
    }
    const aiReplyTimeout = item.decision === 'AI_REPLY_TIMEOUT'
      || (item.decision === 'TECHNICAL_ERROR' && isAiReplyTimeout({ message: item.reason }));
    let wecomNotificationStatus = item.wecom_notification_status;
    let wecomNotificationId = item.wecom_notification_id;
    if (aiReplyTimeout && (!wecomNotificationStatus || wecomNotificationStatus === 'NOT_REQUIRED')) {
      const notification = row(`SELECT id,status FROM notifications
        WHERE channel='WECOM' AND type IN ('AI_REPLY_TIMEOUT','TECHNICAL_MANUAL') AND content LIKE ?
        ORDER BY id DESC LIMIT 1`, `%Web消息编号：#${item.id}%`);
      if (notification) {
        wecomNotificationStatus = notification.status;
        wecomNotificationId = notification.id;
      }
    }
    return {
      ...item,
      decision: aiReplyTimeout ? 'AI_REPLY_TIMEOUT' : item.decision,
      reason: aiReplyTimeout ? describeAiReplyFailure({ code: 'AI_TIMEOUT', message: item.reason }).reason : item.reason,
      wecom_notification_status: wecomNotificationStatus,
      wecom_notification_id: wecomNotificationId,
      context,
      post,
      reply_status: messageReplyStatus(item)
    };
  });
}

/**
 * 运营总览看板数据（智慧驱动）
 *
 * 口径原则：只统计系统真实拥有的数据。平台侧的曝光量、新增关注、有效引流、
 * 活动报名、实际到场、入群在当前架构下没有数据源，因此一律标记为
 * PENDING_SOURCE，由前端显示「待接入」，不使用任何估算或示例数值。
 */
const OPERATIONS_PENDING_NOTE = '曝光量、新增关注、有效引流、活动报名、实际到场、入群需要接入平台数据源与活动报名系统后才能统计';

function operationsSafeCount(sql, ...params) {
  try {
    return Number(row(sql, ...params)?.c || 0);
  } catch {
    return 0;
  }
}

function operationsPublishedCount(sinceIso, platformCode) {
  const publishTime = 'COALESCE(t.reviewed_at,t.submitted_at,t.updated_at)';
  const params = [sinceIso];
  let clause = '';
  if (platformCode) {
    clause = ' AND t.platform_code=?';
    params.push(platformCode);
  }
  return operationsSafeCount(
    `SELECT COUNT(*) c FROM publish_targets t WHERE t.status='PUBLISHED' AND ${publishTime} >= ?${clause}`,
    ...params
  );
}

function operationsChannelRows(sinceIso) {
  const publishTime = 'COALESCE(t.reviewed_at,t.submitted_at,t.updated_at)';
  let rowsRaw = [];
  try {
    rowsRaw = rows(
      `SELECT p.code AS code,p.name AS name,
        (SELECT COUNT(*) FROM publish_targets t WHERE t.platform_code=p.code AND t.status='PUBLISHED' AND ${publishTime} >= ?) AS published
       FROM platforms p WHERE p.code <> 'mini_program' ORDER BY p.sort_order,p.code`,
      sinceIso
    );
  } catch {
    rowsRaw = [];
  }
  return rowsRaw.map(item => ({ code: item.code, name: item.name, published: Number(item.published || 0) }));
}

function operationsContentRows(sinceIso, platformCode, limit = 8) {
  const publishTime = 'COALESCE(t.reviewed_at,t.submitted_at,t.updated_at)';
  const params = [sinceIso];
  let clause = '';
  if (platformCode) {
    clause = ' AND t.platform_code=?';
    params.push(platformCode);
  }
  params.push(limit);
  let rowsRaw = [];
  try {
    rowsRaw = rows(
      `SELECT t.id AS id,t.platform_code AS platformCode,COALESCE(p.name,t.platform_code) AS platformName,
        COALESCE(pt.title,'未命名内容') AS title,t.status AS status,${publishTime} AS publishedAt
       FROM publish_targets t
       LEFT JOIN platforms p ON p.code=t.platform_code
       LEFT JOIN publish_tasks pt ON pt.id=t.task_id
       WHERE t.status='PUBLISHED' AND ${publishTime} >= ?${clause}
       ORDER BY publishedAt DESC,t.id DESC LIMIT ?`,
      ...params
    );
  } catch {
    rowsRaw = [];
  }
  return rowsRaw.map(item => ({
    id: item.id,
    platformCode: item.platformCode,
    platformName: item.platformName,
    title: item.title,
    statusLabel: item.status === 'PUBLISHED' ? '已发布' : item.status,
    publishedAt: item.publishedAt
  }));
}

function operationsRecommendations({ pendingManual, knowledgeGaps, failedPublish, loginIssues, openIssues, publishedCount }) {
  const list = [];
  if (failedPublish > 0) {
    list.push({
      type: '修复发布断点',
      priority: '优先处理',
      title: `复核 ${failedPublish} 条发布失败记录`,
      description: '发布失败会阻塞内容曝光与后续互动统计。请到任务中心确认失败阶段，必要时重新创建发布任务。',
      actionLabel: '去任务中心',
      target: 'tasks'
    });
  }
  if (pendingManual > 0) {
    list.push({
      type: '人工接管积压',
      priority: '优先处理',
      title: `处理 ${pendingManual} 条待人工会话`,
      description: '转人工与知识不足的会话未处理会直接影响用户响应时效，建议今天优先清理。',
      actionLabel: '去转人工记录',
      target: 'handoffs'
    });
  }
  if (knowledgeGaps > 0) {
    list.push({
      type: '补齐知识覆盖',
      priority: '需跟进',
      title: `补齐 ${knowledgeGaps} 条知识缺口`,
      description: '知识缺口会持续产生转人工。把已确认答案加入知识库后，同类问题可以自动回复。',
      actionLabel: '去知识库',
      target: 'knowledge'
    });
  }
  if (loginIssues > 0) {
    list.push({
      type: '平台登录异常',
      priority: '需跟进',
      title: `${loginIssues} 个账号登录状态需要确认`,
      description: '账号未登录或登录失效时不会领取任务。请到平台启停页重新登录或检查执行设备。',
      actionLabel: '检查账号',
      target: 'platforms'
    });
  }
  if (openIssues > 0) {
    list.push({
      type: '运行异常',
      priority: '需跟进',
      title: `${openIssues} 条运行问题未关闭`,
      description: '未关闭的问题会持续影响采集、回复与发布链路，建议按级别依次处理。',
      actionLabel: '查看问题汇总',
      target: 'issues'
    });
  }
  if (publishedCount === 0) {
    list.push({
      type: '内容供给不足',
      priority: '增长机会',
      title: '当前周期还没有已确认发布的内容',
      description: '曝光、引流与转化都依赖持续发布。可以先从本地素材生成标题正文，再创建发布任务。',
      actionLabel: '创建内容',
      target: 'publish'
    });
  }
  if (!list.length) {
    list.push({
      type: '运行平稳',
      priority: '保持',
      title: '当前没有需要立即处理的运营问题',
      description: '发布、互动与知识链路均无积压。可以继续扩充知识库或安排下一批内容发布。',
      actionLabel: '去内容创作',
      target: 'create'
    });
  }
  return list.slice(0, 4);
}

function buildOperationsDashboard({ rangeDays = 7, platformCode = null } = {}) {
  const safeRangeDays = Math.min(90, Math.max(1, Number(rangeDays) || 7));
  const selectedPlatform = platformCode && platformCode !== 'all' ? String(platformCode) : null;
  const sinceIso = new Date(Date.now() - safeRangeDays * 24 * 60 * 60 * 1000).toISOString();

  const publishedCount = operationsPublishedCount(sinceIso, selectedPlatform);
  const channels = operationsChannelRows(sinceIso);
  const content = operationsContentRows(sinceIso, selectedPlatform);

  const platformClause = selectedPlatform ? ' AND platform_code=?' : '';
  const platformParams = selectedPlatform ? [selectedPlatform] : [];
  const pendingManual = operationsSafeCount(
    `SELECT COUNT(*) c FROM messages WHERE deleted_at IS NULL AND status IN ('MANUAL_REQUIRED','KNOWLEDGE_GAP')${platformClause}`,
    ...platformParams
  );
  const failedPublish = operationsSafeCount(
    `SELECT COUNT(*) c FROM publish_targets WHERE status IN ('FAILED','REJECTED')${platformClause}`,
    ...platformParams
  );
  const knowledgeGaps = operationsSafeCount(
    'SELECT COUNT(*) c FROM knowledge_gaps WHERE deleted_at IS NULL AND COALESCE(status,\'OPEN\') NOT IN (\'RESOLVED\',\'IGNORED\',\'CLOSED\')'
  );
  const loginIssues = operationsSafeCount(
    'SELECT COUNT(*) c FROM accounts WHERE enabled<>0 AND COALESCE(login_status,\'\') <> \'READY\''
  );
  const openIssues = operationsSafeCount('SELECT COUNT(*) c FROM issues WHERE status=\'OPEN\'');

  const pendingKpi = (key, label, icon, pendingNote) => ({ key, label, value: null, icon, status: 'PENDING_SOURCE', pendingNote });
  const pendingFunnel = (key, label, pendingNote) => ({ key, label, value: null, status: 'PENDING_SOURCE', pendingNote });

  return {
    updatedAt: now(),
    rangeDays: safeRangeDays,
    platformCode: selectedPlatform || 'all',
    pendingNote: OPERATIONS_PENDING_NOTE,
    // 6 个核心 KPI 与设计稿严格一致：曝光量 / 新增关注 / 有效引流 / 活动报名 / 实际到场 / 入群。
    // 这 6 项在接入平台数据源与活动报名系统前一律为 PENDING_SOURCE，前端显示「待接入」，不使用估算值。
    kpis: [
      pendingKpi('exposure', '曝光量', 'dashboard', '需要平台曝光数据源'),
      pendingKpi('followers', '新增关注', 'accounts', '需要平台粉丝数据源'),
      pendingKpi('leads', '有效引流', 'browser', '需要引流归因数据源'),
      pendingKpi('registrations', '活动报名', 'tasks', '需要活动报名系统'),
      pendingKpi('attendance', '实际到场', 'knowledge', '需要现场签到系统'),
      pendingKpi('groups', '入群', 'messages', '需要社群入群数据')
    ],
    // 本系统已真实统计的指标，单独返回，不占用设计稿的 6 个 KPI 位置。
    published: {
      key: 'published',
      label: '发布量',
      value: publishedCount,
      icon: 'publish',
      status: 'READY',
      scope: `近 ${safeRangeDays} 天`,
      note: selectedPlatform ? '单平台已确认发布数' : '五平台已确认发布合计'
    },
    // 趋势需要曝光、关注、引流三条序列，均无数据源；接入后在此返回每日点位。
    trend: [],
    channels,
    content,
    funnel: [
      pendingFunnel('exposure', '曝光', '需要平台曝光数据源'),
      pendingFunnel('registrations', '报名', '需要活动报名系统'),
      pendingFunnel('attendance', '到场', '需要现场签到系统'),
      pendingFunnel('groups', '入群', '需要社群入群数据')
    ],
    recommendations: operationsRecommendations({ pendingManual, knowledgeGaps, failedPublish, loginIssues, openIssues, publishedCount })
  };
}

function countAiReplies() {
  return row(`SELECT COUNT(*) c FROM (
      SELECT m.status,m.handled_by,m.message_type,m.handled_at,m.context_json
      FROM messages m
      WHERE m.deleted_at IS NULL
        AND m.platform_code <> 'mini_program'
        AND COALESCE(m.decision,'') <> 'SELF_MESSAGE'
        AND COALESCE(m.status,'') <> 'IGNORED_SELF'
        AND NOT (m.status='SUPERSEDED' AND m.decision='DUPLICATE_PROCESSED_MESSAGE')
        AND NOT (m.decision IN ('HANDOFF_SUBMITTED','HANDOFF_NOTIFY_FAILED')
          AND COALESCE(m.wecom_notification_status,'NOT_REQUIRED') <> 'SENT')
      ORDER BY m.id DESC
      LIMIT 200
    ) visible
    WHERE (visible.status='AUTO_REPLIED' OR visible.handled_by='AI_RPA')
      AND NOT (
        visible.message_type='PRIVATE_MESSAGE'
        AND visible.handled_by='PLATFORM_DETECTED'
        AND visible.handled_at IS NOT NULL
        AND json_extract(visible.context_json,'$.platformReplyDetected')=1
      )`).c;
}

function updateTaskAggregate(taskId) {
  const statuses = rows('SELECT status FROM publish_targets WHERE task_id=?', taskId).map(item => item.status);
  if (!statuses.length) return;
  run('UPDATE publish_tasks SET status=?,updated_at=? WHERE id=?', deriveTaskStatus(statuses), now(), taskId);
}

export async function notifyManual(message, type, _manualTitle, reason, notificationOptions = {}) {
  const platform = row('SELECT name FROM platforms WHERE code=?', message.platform_code);
  const context = json(message.context_json, {});
  const relatedNote = resolveRelatedNote(context, rows(`SELECT t.title,pt.platform_post_id,pt.platform_url,pt.submitted_at,pt.reviewed_at,pt.updated_at
    FROM publish_targets pt JOIN publish_tasks t ON t.id=pt.task_id
    WHERE pt.platform_code=? AND pt.account_id=?`, message.platform_code, message.account_id));
  const notification = buildManualNotification({ message, platformName: platform?.name, note: relatedNote, reason, ...notificationOptions });
  if (message.platform_code === MINI_PROGRAM_PLATFORM_CODE) {
    try {
      const identity = { appId: context.appId, userId: context.userId, accountId: message.account_id, conversationId: context.conversationId };
      const queued = requestMiniProgramHandoff({
        conversationId: message.conversation_id, messageId: message.id, reason, type,
        notificationDetails: { ...notification, metadata: { ...notificationOptions.metadata, platformCode: message.platform_code, userName: message.user_name, ...identity } }
      });
      const confirmed = ['CONFIRMED', 'SENT'].includes(queued.notification.status);
      return { ok: confirmed, delivered: confirmed, simulated: false, status: queued.notification.status, notificationId: queued.notification.id, error: null };
    } catch (error) { throw safeMiniProgramProcessingError(error); }
  }
  try {
    const relatedMessageId = Number(notificationOptions.messageId || message.id) || null;
    const isMiniProgram = message.platform_code === MINI_PROGRAM_PLATFORM_CODE;
    const relatedConversationId = Number(isMiniProgram ? message.conversation_id : (notificationOptions.conversationId || message.conversation_id)) || null;
    const verifiedContext = context.serverSignatureVerified === true || String(context.serverSignatureVerified).toLowerCase() === 'true' ? context : {};
    const miniProgramIdentity = isMiniProgram
      ? { appId: verifiedContext.appId || null, userId: verifiedContext.userId || null, accountId: message.account_id, conversationId: verifiedContext.conversationId || null }
      : null;
    const result = await notify({
      type,
      ...notification,
      conversationId: relatedConversationId,
      messageId: relatedMessageId,
      idempotencyKey: isMiniProgram
        ? `wecom:mini-program:handoff:conversation:${relatedConversationId}`
        : notificationOptions.idempotencyKey || (relatedMessageId ? `wecom:${type}:message:${relatedMessageId}` : null),
      metadata: {
        ...notificationOptions.metadata,
        handoff: notificationOptions.handoff !== false, reason, platformCode: message.platform_code, userName: message.user_name,
        ...(miniProgramIdentity ? { ...miniProgramIdentity, miniProgram: miniProgramIdentity } : {})
      }
    });
    const delivered = result.status === 'CONFIRMED';
    const simulated = result.status === 'NOT_CONFIGURED' && config.rpaMode === 'simulated';
    return {
      // 无论是否为模拟 RPA，只有企业微信明确返回成功并落库为 CONFIRMED 才算通知成功。
      ok: delivered,
      delivered,
      simulated,
      status: result.status,
      notificationId: result.id,
      error: delivered ? null : '企业微信通知未成功发送'
    };
  } catch (error) {
    issue({ source: 'WECOM', category: 'NOTIFICATION', title: '企微通知发送失败', detail: error.message, relatedType: 'MESSAGE', relatedId: message.id, retryable: true });
    return { ok: false, status: 'FAILED', notificationId: null, error: error.message };
  }
}

function markMessageWecomStatus(messageId, status, notificationId = null) {
  if (!messageId) return;
  run(`UPDATE messages SET wecom_notification_status=?,wecom_notification_id=?,updated_at=? WHERE id=?`, status || 'NOT_REQUIRED', notificationId, now(), messageId);
}

function messageConversationKey(message) {
  if (message.conversation_key_snapshot) return message.conversation_key_snapshot;
  const context = json(message.context_json, {});
  const conversationId = context.conversationKey || context.conversation_key || context.conversationId || context.conversation_id || context.chatId || context.chat_id || context.sessionId || context.session_id || context.userId || context.user_id || context.senderId || context.sender_id || message.external_id;
  return [message.platform_code, message.account_id, message.message_type, String(conversationId || message.id || 'unknown').trim().toLowerCase()].join(':');
}

function activeHandoffIntent(message) {
  return row(`SELECT * FROM manual_handoff_intents WHERE conversation_key=? AND status IN ('WAITING_USER_CONFIRMATION','REQUESTED','NOTIFY_QUEUED','NOTIFIED') AND expires_at>? ORDER BY id DESC LIMIT 1`, messageConversationKey(message), now());
}

function rememberHandoffIntent(message, unresolvedQuestions) {
  const conversationKey = messageConversationKey(message);
  const stamp = now();
  const expiresAt = new Date(Date.now() + 30 * 60_000).toISOString();
  const active = row(`SELECT * FROM manual_handoff_intents WHERE conversation_key=? AND status IN ('WAITING_USER_CONFIRMATION','REQUESTED','NOTIFY_QUEUED') ORDER BY id DESC LIMIT 1`, conversationKey);
  if (active) {
    run(`UPDATE manual_handoff_intents SET source_message_id=?,unresolved_questions_json=?,expires_at=?,updated_at=? WHERE id=?`, message.id, JSON.stringify(unresolvedQuestions), expiresAt, stamp, active.id);
    return row('SELECT * FROM manual_handoff_intents WHERE id=?', active.id);
  }
  const id = Number(run(`INSERT INTO manual_handoff_intents(conversation_key,platform_code,account_id,message_type,user_name,source_message_id,unresolved_questions_json,status,expires_at,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,'WAITING_USER_CONFIRMATION',?,?,?)`, conversationKey, message.platform_code, message.account_id, message.message_type, message.user_name, message.id, JSON.stringify(unresolvedQuestions), expiresAt, stamp, stamp).lastInsertRowid);
  return row('SELECT * FROM manual_handoff_intents WHERE id=?', id);
}

function assessMessageAutoReplyEligibility(input = {}, options = {}) {
  const contentOwnership = resolveManagedCommentTarget(input);
  return assessAutoReplyEligibility({ ...input, contentOwnership }, options);
}

export async function queueStaticReply(message, replyText, { decision, reason, confidence = 1, knowledge = null, handoffIntentId = null, responseMode = 'STATIC', replaceCancelledReplyJob = false, replyContext = null, replyBatch = null } = {}) {
  const currentMessage = row('SELECT * FROM messages WHERE id=?', Number(message?.id));
  if (!currentMessage || currentMessage.deleted_at || currentMessage.handled_at || terminalMessageStatuses.has(String(currentMessage.status || '').toUpperCase()) || ['REPLY_QUEUED','REPLY_RUNNING'].includes(String(currentMessage.status || '').toUpperCase())) return null;
  message = currentMessage;
  if (!isMessageConversationCurrent(message)) {
    run(`UPDATE messages SET status='SUPERSEDED',decision='SUPERSEDED_BY_NEW_MESSAGE',reason='生成期间同一会话收到更新消息，旧回复已作废',reply_job_id=NULL,reply_context_json=?,updated_at=? WHERE id=?`, JSON.stringify(replyContext || {}), now(), message.id);
    if (replyBatch?.id) requeueReplyBatchGeneration(replyBatch.id, 'MESSAGE_CONVERSATION_VERSION_CHANGED');
    return null;
  }
  const eligibility = assessMessageAutoReplyEligibility({
    platformCode: message.platform_code, accountId: message.account_id, messageType: message.message_type,
    externalId: message.external_id, externalUrl: message.external_url, sourceContent: message.content,
    userName: message.user_name, messageContext: json(message.context_json, {})
  }, { phase: 'creation' });
  if (!eligibility.allowed) {
    if (message.platform_code === MINI_PROGRAM_PLATFORM_CODE) {
      await notifyManual(message, 'MESSAGE_PRECISION_MANUAL', '自动回复目标证据不足', eligibility.reason);
    }
    const stamp = now();
    run(`UPDATE messages SET status='MANUAL_REQUIRED',decision='AUTO_REPLY_INELIGIBLE',confidence=?,reason=?,knowledge_id=?,knowledge_question_snapshot=?,knowledge_answer_snapshot=?,manual_handoff_intent_id=?,response_mode=?,rule_version=?,reply_job_id=NULL,updated_at=? WHERE id=?`,
      confidence, eligibility.reason, knowledge?.id || null, knowledge?.question || null, knowledge?.answer || null, handoffIntentId, responseMode, eligibility.version, stamp, message.id);
    if (replyBatch?.id) run(`UPDATE reply_batches SET status='MANUAL_REQUIRED',invalidation_reason='AUTO_REPLY_INELIGIBLE',completed_at=?,updated_at=? WHERE id=? AND status='GENERATING'`, stamp, stamp, Number(replyBatch.id));
    if (message.platform_code !== MINI_PROGRAM_PLATFORM_CODE) {
      await notifyManual(message, 'MESSAGE_PRECISION_MANUAL', '自动回复目标证据不足', eligibility.reason);
    }
    return null;
  }
  const length = validateReplyTextLength({ platformCode: message.platform_code, messageType: message.message_type, text: replyText });
  if (!length.ok) throw new Error(length.message);
  const account = row('SELECT * FROM accounts WHERE id=?', message.account_id);
  if (!account) throw new Error('消息账号不存在');

  if (message.platform_code === MINI_PROGRAM_PLATFORM_CODE) {
    return miniProgramProcessingTransaction(() => {
      const stamp = now();
      const callback = enqueueMiniProgramReply({ message, replyText, createdAt: stamp });
      run(`UPDATE messages SET status='REPLY_QUEUED',decision=?,confidence=?,reply_text=?,reason=?,knowledge_id=?,
        knowledge_question_snapshot=?,knowledge_answer_snapshot=?,manual_handoff_intent_id=?,response_mode=?,
        rule_version='mini-program-callback-2026.09.05.1',reply_job_id=NULL,updated_at=? WHERE id=?`,
      decision, confidence, replyText, reason, knowledge?.id || null, knowledge?.question || null,
      knowledge?.answer || null, handoffIntentId, responseMode, stamp, message.id);
      return callback.id;
    });
  }

  if (replyBatch?.id) {
    const stamp = now();
    db.exec('BEGIN IMMEDIATE');
    try {
      const currentBatch = row('SELECT * FROM reply_batches WHERE id=?', Number(replyBatch.id));
      const conversation = currentBatch
        ? row('SELECT ledger_version FROM conversations WHERE id=?', Number(currentBatch.conversation_id))
        : null;
      const versionMatches = currentBatch?.status === 'GENERATING'
        && Number(currentBatch.conversation_version) === Number(conversation?.ledger_version);
      if (!versionMatches) {
        if (currentBatch?.status === 'GENERATING') {
          run(`UPDATE reply_batches SET status='PENDING',claimed_at=NULL,generation_started_at=NULL,reply_text=NULL,agent_job_id=NULL,generation_message_id=NULL,
            invalidation_reason='CONVERSATION_VERSION_CHANGED_BEFORE_QUEUE',updated_at=? WHERE id=? AND status='GENERATING'`, stamp, currentBatch.id);
        }
        run(`UPDATE messages SET status='NEW',decision=NULL,reason='生成完成前同一会话收到新消息，旧答案未创建发送任务',reply_job_id=NULL,updated_at=?
          WHERE id=? AND handled_at IS NULL AND reply_job_id IS NULL`, stamp, message.id);
        db.exec('COMMIT');
        return null;
      }

      const sourceEventIds = numericJsonArray(currentBatch.source_event_ids_json);
      const sourceMessageIds = numericJsonArray(currentBatch.source_message_ids_json);
      const payload = {
        messageId: message.id, platformCode: message.platform_code, accountId: message.account_id,
        platformUserId: account.platform_user_id || null, profileName: account.profile_name,
        externalId: message.external_id, externalUrl: message.external_url, sourceContent: message.content, userName: message.user_name,
        messageType: message.message_type, channelType: message.message_type, queueLane: message.message_type,
        conversationNamespace: currentBatch.conversation_namespace || message.conversation_key_snapshot || null,
        firstPendingAt: currentBatch.first_pending_at || message.collected_at || message.created_at || stamp,
        messageContext: json(message.context_json, {}), replyEligibility: eligibility, replyText,
        replyBatchId: Number(currentBatch.id), replyBatchVersion: Number(currentBatch.conversation_version),
        sourceEventIds, sourceMessageIds
      };
      const jobId = createJob(account.device_id, 'REPLY', payload, {
        idempotencyKey: `reply-batch:${currentBatch.id}:version:${currentBatch.conversation_version}`,
        replaceCancelled: true
      });
      run(`UPDATE messages SET status='REPLY_QUEUED',decision=?,confidence=?,reply_text=?,reason=?,knowledge_id=?,knowledge_question_snapshot=?,knowledge_answer_snapshot=?,manual_handoff_intent_id=?,response_mode=?,rule_version='conversation-semantic-2026.08.20.2',reply_job_id=?,updated_at=? WHERE id=?`,
        decision, confidence, replyText, reason, knowledge?.id || null, knowledge?.question || null, knowledge?.answer || null, handoffIntentId, responseMode, jobId, stamp, message.id);
      const supersededIds = sourceMessageIds.filter(id => id !== Number(message.id));
      if (supersededIds.length) {
        run(`UPDATE messages SET status='SUPERSEDED',decision='MERGED_INTO_REPLY_BATCH',reason='同一会话连续消息已合并到较新的统一回复',reply_job_id=NULL,updated_at=?
          WHERE id IN (${supersededIds.map(() => '?').join(',')}) AND handled_at IS NULL AND reply_job_id IS NULL`, stamp, ...supersededIds);
      }
      const batchUpdated = run(`UPDATE reply_batches SET status='READY',reply_text=?,agent_job_id=?,generation_message_id=?,invalidation_reason=NULL,updated_at=?
        WHERE id=? AND status='GENERATING' AND conversation_version=?`, replyText, jobId, message.id, stamp, currentBatch.id, currentBatch.conversation_version);
      if (batchUpdated.changes !== 1) throw new Error('回复批次状态已变化，禁止创建发送任务');
      db.exec('COMMIT');
      return jobId;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  const jobId = createJob(account.device_id, 'REPLY', {
    messageId: message.id, platformCode: message.platform_code, accountId: message.account_id, platformUserId: account.platform_user_id || null, profileName: account.profile_name,
    externalId: message.external_id, externalUrl: message.external_url, sourceContent: message.content, userName: message.user_name,
    messageType: message.message_type, channelType: message.message_type, conversationNamespace: message.conversation_key_snapshot || null,
    firstPendingAt: message.collected_at || message.created_at || now(), messageContext: json(message.context_json, {}), replyEligibility: eligibility, replyText
  }, { idempotencyKey: buildReplyIdempotencyKey(message), replaceCancelled: replaceCancelledReplyJob });
  const replyJob = row('SELECT status FROM agent_jobs WHERE id=?', jobId);
  if (!replyJob || !['QUEUED', 'RUNNING'].includes(String(replyJob.status || '').toUpperCase())) {
    const blockedReason = '此前同一消息的发送任务已经结束且不满足安全重试条件，为防止平台重复发送，已停止自动重试';
    run(`UPDATE messages SET status='MANUAL_REQUIRED',decision='TECHNICAL_ERROR',confidence=?,reply_text=?,reason=?,knowledge_id=?,knowledge_question_snapshot=?,knowledge_answer_snapshot=?,manual_handoff_intent_id=?,response_mode=?,rule_version='reply-idempotency-guard-2026.09.02.1',reply_job_id=NULL,updated_at=? WHERE id=?`,
      confidence, replyText, blockedReason, knowledge?.id || null, knowledge?.question || null, knowledge?.answer || null, handoffIntentId, responseMode, now(), message.id);
    return null;
  }
  run(`UPDATE messages SET status='REPLY_QUEUED',decision=?,confidence=?,reply_text=?,reason=?,knowledge_id=?,knowledge_question_snapshot=?,knowledge_answer_snapshot=?,manual_handoff_intent_id=?,response_mode=?,rule_version='conversation-semantic-2026.08.20.2',reply_job_id=?,updated_at=? WHERE id=?`,
    decision, confidence, replyText, reason, knowledge?.id || null, knowledge?.question || null, knowledge?.answer || null, handoffIntentId, responseMode, jobId, now(), message.id);
  return jobId;
}

function recoverPendingClarificationIntent(recentMessages = []) {
  for (let index = (recentMessages || []).length - 1; index >= 0; index -= 1) {
    const item = recentMessages[index] || {};
    const context = json(item.reply_context_json, {});
    const candidate = context?.clarificationCandidate;
    const candidateQuestion = String(candidate?.candidateQuestion || '').trim();
    if (!candidateQuestion || context.clarificationConfirmed === true || context.clarificationDenied === true) continue;
    return {
      ...candidate,
      candidateQuestion,
      source_message_id: Number(item.id) || null,
      recovered_from: 'reply_context_json',
      recovered_at: now()
    };
  }
  return null;
}

async function processMessageInternal(messageId, { replaceCancelledReplyJob = false, replyBatch = null } = {}) {
  const message = row('SELECT * FROM messages WHERE id=?', messageId);
  if (!message) throw new Error('消息不存在');
  if (message.handled_at || terminalMessageStatuses.has(message.status) || ['REPLY_QUEUED', 'REPLY_RUNNING'].includes(message.status)) return message;
  const stamp = now();
  const storedSourceAssessment = assessStoredWeiboSource(message);
  if (storedSourceAssessment?.isOfficial === true && storedSourceAssessment.confidence === 'HIGH') {
    return markMessageIgnoredOfficial(messageId, storedSourceAssessment, json(message.context_json, {}), stamp);
  }
  const isPrivateMessage = String(message.message_type || '').toUpperCase() === 'PRIVATE_MESSAGE';
  const handlingConversation = conversationForMessage(message);
  if (isPrivateMessage && conversationAutomationDisabled(handlingConversation)) {
    const handlingReason = handlingConversation?.handoff_reason || '该用户已进入人工处理流程';
    if (message.platform_code === MINI_PROGRAM_PLATFORM_CODE) {
      await notifyManual(message, 'HUMAN_FOLLOWUP_MESSAGE', '', handlingReason);
      return row('SELECT * FROM messages WHERE id=?', messageId);
    }
    beginConversationHandoff({ conversationId: handlingConversation.id, messageId: message.id, reason: handlingReason });
    markHumanFollowupMessage(message.id, { reason: handlingReason });
    const notification = await notifyManual(
      message,
      'HUMAN_FOLLOWUP_MESSAGE',
      '人工会话收到新消息',
      handlingReason,
      { handoff: true, conversationId: handlingConversation.id, messageId: message.id, idempotencyKey: `wecom:human-followup:message:${message.id}` }
    );
    markHumanFollowupMessage(message.id, { notificationId: notification.notificationId, confirmed: notification.delivered, reason: handlingReason });
    return row('SELECT * FROM messages WHERE id=?', messageId);
  }
  if (message.platform_code !== MINI_PROGRAM_PLATFORM_CODE && !getPlatformSmartReply(message.platform_code).enabled) {
    run(`UPDATE messages SET status='NEW',decision='SMART_REPLY_PAUSED',reason='该平台智能回复已关闭，消息保留等待且未创建发送任务',reply_job_id=NULL,updated_at=? WHERE id=?`, stamp, messageId);
    return row('SELECT * FROM messages WHERE id=?', messageId);
  }
  const existingIntent = isPrivateMessage ? activeHandoffIntent(message) : null;
  // 兼容旧数据：人工意图已通知但会话状态尚未迁移时，也必须直接交给人工，禁止再发等待话术。
  if (existingIntent?.status === 'NOTIFIED') {
    const handlingReason = `人工请求#${existingIntent.id}已通知，后续消息继续交由人工处理`;
    if (message.platform_code === MINI_PROGRAM_PLATFORM_CODE) {
      await notifyManual(message, 'HUMAN_FOLLOWUP_MESSAGE', '', handlingReason);
      return row('SELECT * FROM messages WHERE id=?', messageId);
    }
    beginConversationHandoff({ conversationId: message.conversation_id, messageId: message.id, reason: handlingReason });
    markHumanFollowupMessage(message.id, { reason: handlingReason });
    const notification = await notifyManual(message, 'HUMAN_FOLLOWUP_MESSAGE', '人工会话收到新消息', handlingReason, {
      handoff: true,
      conversationId: message.conversation_id,
      messageId: message.id,
      idempotencyKey: `wecom:human-followup:message:${message.id}`
    });
    markHumanFollowupMessage(message.id, { notificationId: notification.notificationId, confirmed: notification.delivered, reason: handlingReason });
    return row('SELECT * FROM messages WHERE id=?', messageId);
  }
  // 私信保留用户确认指令；评论未命中知识时由下方知识判断直接转人工。
  const routeDecision = routeIncomingMessage({ message, conversation: handlingConversation, sourceAssessment: storedSourceAssessment, customHandoffPhrases: isPrivateMessage ? enabledManualHandoffPhrases() : [] });
  const handoffCommand = routeDecision.handoffCommand;
  if (handoffCommand?.matched) {
    if (message.platform_code === MINI_PROGRAM_PLATFORM_CODE) {
      await notifyManual(message, 'KNOWLEDGE_GAP_CONFIRMED', '', handoffCommand.reason || '用户明确要求转人工');
      return row('SELECT * FROM messages WHERE id=?', messageId);
    }
    // 明确发送“转人工”本身就是用户的转接确认，不应再被近期知识缺口条件拦截。
    // 没有前置知识缺口时，仍创建一条以当前消息为来源的人工意图，后续走同一套企微通知与幂等流程。
    const intent = existingIntent || rememberHandoffIntent(message, [message.content]);
    run('UPDATE messages SET manual_handoff_intent_id=?,updated_at=? WHERE id=?', intent.id, stamp, message.id);
    beginConversationHandoff({ conversationId: message.conversation_id, messageId: message.id, reason: handoffCommand.reason || '用户明确要求转人工' });
    run("UPDATE manual_handoff_intents SET status='NOTIFY_QUEUED',request_message_id=?,requested_at=COALESCE(requested_at,?),updated_at=? WHERE id=? AND status IN ('WAITING_USER_CONFIRMATION','REQUESTED','NOTIFY_QUEUED','NOTIFIED')", message.id, stamp, stamp, intent.id);
    const sourceMessage = row('SELECT * FROM messages WHERE id=?', intent.source_message_id) || message;
    const unresolved = json(intent.unresolved_questions_json, []);
    const notificationMessage = { ...sourceMessage, content: unresolved.length ? unresolved.join('\n') : sourceMessage.content };
    markMessageWecomStatus(message.id, 'PENDING');
    const notification = await notifyManual(notificationMessage, 'KNOWLEDGE_GAP_CONFIRMED', '用户明确要求转人工', `用户输入“${message.content}”，请人工处理此前无法确认的问题`, { handoff: true, conversationId: message.conversation_id, messageId: message.id, idempotencyKey: `wecom:handoff:message:${message.id}` });
    const wecomStatus = notification.delivered ? 'SENT' : (notification.simulated ? 'SIMULATED' : 'PENDING');
    markMessageWecomStatus(message.id, wecomStatus, notification.notificationId);
    if (sourceMessage.id && sourceMessage.id !== message.id) markMessageWecomStatus(sourceMessage.id, wecomStatus, notification.notificationId);
    run(`UPDATE manual_handoff_intents SET status=?,notified_at=?,notification_error=?,updated_at=? WHERE id=?`, notification.delivered ? 'NOTIFIED' : 'NOTIFY_QUEUED', notification.delivered ? now() : null, notification.delivered ? null : (notification.error || '企微通知尚未确认，等待Outbox重试'), now(), intent.id);
    const handlingReason = notification.delivered
      ? `人工请求#${intent.id}已成功通知企业微信`
      : `人工请求#${intent.id}正在通过Outbox重试通知企业微信`;
    markHumanFollowupMessage(message.id, { notificationId: notification.notificationId, confirmed: notification.delivered, reason: handlingReason });
    return row('SELECT * FROM messages WHERE id=?', messageId);
  }


  if (routeDecision.route === MESSAGE_ROUTE.HUMAN_HANDOFF) {
    if (message.platform_code === MINI_PROGRAM_PLATFORM_CODE) {
      await notifyManual(message, 'RISK_MANUAL', '', routeDecision.reason);
      return row('SELECT * FROM messages WHERE id=?', messageId);
    }
    if (message.conversation_id) beginConversationHandoff({ conversationId: message.conversation_id, messageId: message.id, reason: routeDecision.reason });
    run(`UPDATE messages SET status='MANUAL_REQUIRED',decision='MANUAL_RISK',reason=?,rule_version='outer-router-2026.08.27.1',updated_at=? WHERE id=?`, routeDecision.reason, stamp, messageId);
    markMessageWecomStatus(message.id, 'PENDING');
    const notification = await notifyManual(message, 'RISK_MANUAL', '风险或恶意消息需人工处理', routeDecision.reason, {
      handoff: true, conversationId: message.conversation_id, messageId: message.id,
      idempotencyKey: `wecom:risk-handoff:message:${message.id}`
    });
    markHumanFollowupMessage(message.id, { notificationId: notification.notificationId, confirmed: notification.delivered, reason: routeDecision.reason });
    return row('SELECT * FROM messages WHERE id=?', messageId);
  }
  if (routeDecision.route === MESSAGE_ROUTE.IGNORE) {
    run(`UPDATE messages SET status='CLOSED',decision='ROUTER_IGNORED',reason=?,rule_version='outer-router-2026.08.27.1',updated_at=? WHERE id=?`, routeDecision.reason, stamp, messageId);
    return row('SELECT * FROM messages WHERE id=?', messageId);
  }
  const precision = assessDouyinPrivatePreview({ platformCode: message.platform_code, messageType: message.message_type, context: json(message.context_json, {}) });
  if (!precision.ok) {
    run(`UPDATE messages SET status='MANUAL_REQUIRED',decision='PRIVATE_PREVIEW_INCOMPLETE',reason=?,rule_version='douyin-private-preview-2026.08.06.1',reply_job_id=NULL,updated_at=? WHERE id=?`, precision.message, stamp, messageId);
    await notifyManual(message, 'MESSAGE_PRECISION_MANUAL', '抖音私信需逐条人工确认', precision.message);
    return row('SELECT * FROM messages WHERE id=?', messageId);
  }
  const weiboPrecision = assessWeiboMessagePrecision({ platformCode: message.platform_code, messageType: message.message_type, context: json(message.context_json, {}) });
  if (!weiboPrecision.ok) {
    run(`UPDATE messages SET status='MANUAL_REQUIRED',decision='WEIBO_MESSAGE_PRECISION',reason=?,rule_version='weibo-message-precision-2026.08.06.1',reply_job_id=NULL,updated_at=? WHERE id=?`, weiboPrecision.message, stamp, messageId);
    await notifyManual(message, 'MESSAGE_PRECISION_MANUAL', '微博消息需人工确认', weiboPrecision.message);
    return row('SELECT * FROM messages WHERE id=?', messageId);
  }

  if (routeDecision.route === MESSAGE_ROUTE.DIRECT_REPLY) {
    const result = outerRouteReplyResult(routeDecision);
    await queueStaticReply(message, result.replyText, { decision: result.decision, reason: result.reason, confidence: result.confidence, responseMode: result.responseMode, replaceCancelledReplyJob, replyBatch });
    return row('SELECT * FROM messages WHERE id=?', messageId);
  }

  const conversation = conversationForMessage(message);
  // 不再按消息时间差强制切断私信上下文，避免用户稍后继续提问时丢失已确认的问题和答案。
  // 仍由 recentConversationMessages 的数量上限控制模型输入规模。
  const contextExpired = false;
  const recentMessages = recentConversationMessages(message);
  // 优先读取会话级待确认状态；若旧消息已经把候选问题写入 reply_context_json，
  // 则从同一私信会话的最近一轮确认话术恢复，避免用户回复“对的”后重新开题。
  let pendingIntent = !contextExpired && conversation?.pending_intent_json ? json(conversation.pending_intent_json, null) : null;
  let pendingIntentRecovered = false;
  if (!pendingIntent && isPrivateMessage) {
    pendingIntent = recoverPendingClarificationIntent(recentMessages);
    pendingIntentRecovered = Boolean(pendingIntent);
  }
  const nextClarificationAttempt = nextBusinessGuidanceAttempt(contextExpired ? 0 : conversation?.clarification_attempts, config.businessGuidanceMaxAttempts);
  let replyResult;
  try {
    if ((message.platform_code === MINI_PROGRAM_PLATFORM_CODE || config.ragFormalRoutingEnabled) && routeDecision.route === MESSAGE_ROUTE.RAG_QUERY) {
      const ragRequest = buildFormalRagRequest({ message, conversation, recentMessages });
      const preflight = routeBusinessClarification({ question: message.content, context: ragRequest.context, messageType: message.message_type, guidanceAttempt: nextClarificationAttempt, maxGuidanceAttempts: config.businessGuidanceMaxAttempts });
      const ragResponse = preflight ? null : await formalRagClient.queryFormalKnowledge(ragRequest);
      const ragAnswered = ['ANSWERED', 'NO_ANSWER'].includes(String(ragResponse?.status || ragResponse?.result || '').toUpperCase());
      if (!isMessageConversationCurrent(message)) {
        run(`UPDATE messages SET status='NEW',decision=NULL,reason='RAG返回前同一会话收到新消息，旧结果已丢弃',reply_job_id=NULL,updated_at=? WHERE id=? AND handled_at IS NULL`, now(), messageId);
        return row('SELECT * FROM messages WHERE id=?', messageId);
      }
      const snapshotValidation = ragAnswered ? validateFormalRagResponseSnapshot(ragRequest, ragResponse) : { ok: true };
      const checkedRagResponse = snapshotValidation.ok
        ? ragResponse
        : { status: 'INVALID_RESPONSE', retryable: false, error: { code: snapshotValidation.code, message: snapshotValidation.reason } };
      const formalResult = preflight || formalRagReplyResult(checkedRagResponse, { platformCode: message.platform_code, messageType: message.message_type, question: message.content, context: ragRequest.context, guidanceAttempt: nextClarificationAttempt, maxGuidanceAttempts: config.businessGuidanceMaxAttempts });
      if (formalResult.action === 'HANDOFF') {
        const reason = formalResult.reason;
        const notificationTypes = {
          AI_REPLY_TIMEOUT: ['AI_REPLY_TIMEOUT', 'AI回复超时'],
          RAG_REPLY_TOO_LONG: ['RAG_REPLY_TOO_LONG', '知识库回复超长，需人工处理'],
          COMMENT_KNOWLEDGE_GAP: ['COMMENT_KNOWLEDGE_GAP', '评论知识库未命中，需人工处理'],
          RAG_CLARIFICATION_LIMIT: ['RAG_CLARIFICATION_LIMIT', '引导已达上限，需人工处理'],
          KNOWLEDGE_GUIDANCE_LIMIT: ['KNOWLEDGE_GUIDANCE_LIMIT', '引导已达上限，需人工处理']
        };
        const [notificationType, notificationTitle] = notificationTypes[formalResult.decision] || ['RAG_UNAVAILABLE_MANUAL', 'RAG 服务不可用，消息转人工'];
        if (message.conversation_id) {
          const progress = businessGuidanceProgress(formalResult, conversation?.clarification_attempts, { messageType: message.message_type, maxGuidanceAttempts: config.businessGuidanceMaxAttempts });
          run('UPDATE conversations SET clarification_attempts=?,pending_intent_json=NULL,updated_at=? WHERE id=?', progress.attempts, now(), message.conversation_id);
        }
        const handoffContext = { ragStatus: formalResult.ragStatus, errorCode: formalResult.errorCode || null, retryable: formalResult.retryable === true, guidanceAttempt: formalResult.guidanceAttempt || 0, maxGuidanceAttempts: formalResult.maxGuidanceAttempts, handoffOffered: false, handoffRequested: true };
        run('UPDATE messages SET reply_context_json=?,updated_at=? WHERE id=?', JSON.stringify(handoffContext), now(), messageId);
        if (message.platform_code === MINI_PROGRAM_PLATFORM_CODE) {
          await notifyManual(message, notificationType, notificationTitle, reason);
          return row('SELECT * FROM messages WHERE id=?', messageId);
        }
        if (message.conversation_id) beginConversationHandoff({ conversationId: message.conversation_id, messageId: message.id, reason });
        run(`UPDATE messages SET status='MANUAL_REQUIRED',decision=?,confidence=0,reason=?,reply_text=NULL,response_mode=?,rule_version='formal-rag-2026.08.27.1',reply_job_id=NULL,updated_at=? WHERE id=?`, formalResult.decision, reason, formalResult.responseMode, now(), messageId);
        markMessageWecomStatus(message.id, 'PENDING');
        const notification = await notifyManual(message, notificationType, notificationTitle, reason, { handoff: true, conversationId: message.conversation_id, messageId: message.id, idempotencyKey: `wecom:rag-handoff:message:${message.id}` });
        markHumanFollowupMessage(message.id, { notificationId: notification.notificationId, confirmed: notification.delivered, reason });
        return row('SELECT * FROM messages WHERE id=?', messageId);
      }
      replyResult = {
        ...formalResult, matches: [], unknownQuestions: formalResult.ragStatus === 'ANSWERED' ? [] : [message.content],
        bestKnowledge: null, contextUsed: ragRequest.context.length > 0 || ragRequest.query.text !== String(message.content || '').trim(), resolvedQuestions: [message.content],
        topicSwitched: false, matchMethod: formalResult.matchMethod || 'FORMAL_RAG', diagnostics: [], truncated: false
      };
    } else {
      replyResult = await evaluateReply({
        message, platformCode: message.platform_code, messageType: message.message_type, recentMessages, pendingIntent,
        searchOptions: { excludedKnowledgeIds: getDisabledXiaozhiKnowledgeIds() }, taskId: messageId,
        minimumConfidence: config.autoReplyThreshold, maxGuidanceAttempts: config.businessGuidanceMaxAttempts,
        guidanceAttemptOverride: isPrivateMessage ? nextClarificationAttempt : null
      });
      replyResult = enforceBusinessGuidanceLimit(replyResult, { messageType: message.message_type, maxGuidanceAttempts: config.businessGuidanceMaxAttempts });
    }
  } catch (error) {
    if (message.platform_code === MINI_PROGRAM_PLATFORM_CODE) throw error;
    const failure = describeAiReplyFailure(error);
    const failureContext = {
      errorCode: failure.errorCode,
      errorStage: 'KNOWLEDGE_OR_REPLY',
      retrySafe: true,
      platformSendTaskCreated: false,
      rawMessage: failure.rawMessage
    };
    run(`UPDATE messages SET status='MANUAL_REQUIRED',decision=?,confidence=0,reason=?,reply_context_json=?,rule_version='ai-reply-failure-2026.08.24.1',reply_job_id=NULL,updated_at=? WHERE id=?`, failure.decision, failure.reason, JSON.stringify(failureContext), now(), messageId);
    issue({ source: 'QWEN', category: 'MODEL_API', title: failure.issueTitle, detail: error.stack || error.message, relatedType: 'MESSAGE', relatedId: messageId, retryable: true });

    const notificationState = row('SELECT wecom_notification_status FROM messages WHERE id=?', messageId);
    if (notificationState?.wecom_notification_status !== 'SENT') {
      markMessageWecomStatus(messageId, 'PENDING');
      const notification = await notifyManual(
        { ...message, decision: failure.decision, reason: failure.reason },
        failure.notificationType,
        failure.notificationTitle,
        failure.reason,
        {
          titleSuffix: `｜${failure.notificationTitle}`,
          actionText: failure.notificationAction,
          reasonLabel: failure.notificationReasonLabel
        }
      );
      const wecomStatus = notification.ok ? (notification.status === 'SIMULATED' ? 'SIMULATED' : 'SENT') : 'FAILED';
      markMessageWecomStatus(messageId, wecomStatus, notification.notificationId);
    }
    return row('SELECT * FROM messages WHERE id=?', messageId);
  }

  // Older knowledge and generators may count code points; enforce the actual channel budget
  // before queueStaticReply so an oversized answer follows the normal human handoff flow.
  if (replyResult.replyText) {
    const length = validateReplyTextLength({ platformCode: message.platform_code, messageType: message.message_type, text: replyResult.replyText });
    if (!length.ok) {
      // Match queueStaticReply's freshness gate: an old result must not take over a newer
      // conversation or revive a message already handled/deleted while generation awaited.
      const currentMessage = row('SELECT * FROM messages WHERE id=?', message.id);
      if (!currentMessage || currentMessage.deleted_at || currentMessage.handled_at || terminalMessageStatuses.has(String(currentMessage.status || '').toUpperCase()) || ['REPLY_QUEUED','REPLY_RUNNING'].includes(String(currentMessage.status || '').toUpperCase())) return currentMessage;
      if (!isMessageConversationCurrent(currentMessage)) {
        run(`UPDATE messages SET status='SUPERSEDED',decision='SUPERSEDED_BY_NEW_MESSAGE',reason='生成期间同一会话收到更新消息，旧回复已作废',reply_job_id=NULL,updated_at=? WHERE id=?`, now(), message.id);
        if (replyBatch?.id) requeueReplyBatchGeneration(replyBatch.id, 'MESSAGE_CONVERSATION_VERSION_CHANGED');
        return row('SELECT * FROM messages WHERE id=?', message.id);
      }
      replyResult = { ...replyResult, action: 'HANDOFF', decision: 'REPLY_TOO_LONG', replyText: null, responseMode: 'REPLY_LENGTH_HANDOFF', handoffOffered: false, reason: `${length.message}；为保留完整业务信息，转人工处理` };
    }
  }
  const compactMatches = (replyResult.matches || []).map(item => ({ question: item.question, resolvedQuestion: item.resolvedQuestion, knowledgeId: item.knowledge?.id, confidence: item.confidence, matchMethod: item.matchMethod, contextUsed: item.contextUsed }));
  run(`UPDATE messages SET subquestions_json=?,message_group_id=?,reply_context_json=?,updated_at=? WHERE id=?`,
    JSON.stringify({ questions: replyResult.resolvedQuestions || [], matches: compactMatches, unknownQuestions: replyResult.unknownQuestions || [], truncated: replyResult.truncated === true }),
    (replyResult.resolvedQuestions || []).length > 1 ? `message-${message.id}` : null,
    JSON.stringify({ contextUsed: replyResult.contextUsed, topicSwitched: replyResult.topicSwitched, matchMethod: replyResult.matchMethod, guidanceAttempt: replyResult.guidanceAttempt || 0, maxGuidanceAttempts: replyResult.maxGuidanceAttempts || config.businessGuidanceMaxAttempts, handoffOffered: replyResult.handoffOffered === true, handoffRequested: replyResult.handoffRequested === true, clarificationCandidate: replyResult.clarificationCandidate || null, clarificationConfirmed: replyResult.clarificationConfirmed === true, clarificationDenied: replyResult.clarificationDenied === true, pendingIntentRecovered, contextExpired, identityConfidence: message.identity_confidence, recentMessageIds: recentMessages.map(item => item.id) }),
    now(), message.id);

  if (replyResult.action === 'HANDOFF' && (message.message_type === 'COMMENT' || replyResult.decision === 'REPLY_TOO_LONG' || replyResult.handoffRequested)) {
    const reason = replyResult.reason;
    const replyTooLong = replyResult.decision === 'REPLY_TOO_LONG';
    if (replyResult.handoffRequested && message.conversation_id) {
      run('UPDATE conversations SET clarification_attempts=?,pending_intent_json=NULL,updated_at=? WHERE id=?', replyResult.guidanceAttempt, now(), message.conversation_id);
    }
    if (message.conversation_id) beginConversationHandoff({ conversationId: message.conversation_id, messageId: message.id, reason });
    run(`UPDATE messages SET status='MANUAL_REQUIRED',decision=?,confidence=0,reason=?,reply_text=NULL,response_mode=?,rule_version='comment-knowledge-2026.09.07.1',reply_job_id=NULL,updated_at=? WHERE id=?`, replyResult.decision, reason, replyResult.responseMode, now(), messageId);
    markMessageWecomStatus(message.id, 'PENDING');
    const notificationType = replyResult.handoffRequested ? 'KNOWLEDGE_GUIDANCE_LIMIT' : (replyTooLong ? 'REPLY_TOO_LONG' : 'COMMENT_KNOWLEDGE_GAP');
    const notificationTitle = replyResult.handoffRequested ? '引导已达上限，需人工处理' : (replyTooLong ? '知识库回复超长，需人工处理' : '评论知识库未命中，需人工处理');
    const notificationKey = `wecom:${replyResult.handoffRequested ? 'guidance-limit' : replyTooLong ? 'reply-length' : 'comment-knowledge'}-handoff:message:${message.id}`;
    const notification = await notifyManual(message, notificationType, notificationTitle, reason, { handoff: true, conversationId: message.conversation_id, messageId: message.id, idempotencyKey: notificationKey });
    markHumanFollowupMessage(message.id, { notificationId: notification.notificationId, confirmed: notification.delivered, reason });
    return row('SELECT * FROM messages WHERE id=?', messageId);
  }

  let handoffIntent = null;
  const formalRagResult = replyResult.matchMethod === 'FORMAL_RAG';
  const unresolvedQuestions = formalRagResult ? [] : (replyResult.unknownQuestions || []);
  const guidanceProgress = businessGuidanceProgress(replyResult, conversation?.clarification_attempts, { messageType: message.message_type, maxGuidanceAttempts: config.businessGuidanceMaxAttempts });
  if (conversation) {
    if (guidanceProgress.answered) {
      run(`UPDATE conversations SET clarification_attempts=0,pending_intent_json=NULL,handoff_offered_at=NULL,human_followup_state=CASE WHEN human_followup_state='WAITING' THEN human_followup_state ELSE 'NONE' END,updated_at=? WHERE id=?`, now(), conversation.id);
    } else if (guidanceProgress.guiding && !replyResult.handoffOffered) {
      const candidate = replyResult.clarificationCandidate || null;
      run(`UPDATE conversations SET clarification_attempts=?,pending_intent_json=?,updated_at=? WHERE id=?`, guidanceProgress.attempts, candidate ? JSON.stringify({ ...candidate, original_user_message: message.content, source_message_id: message.id, attempt: guidanceProgress.attempts, created_at: now() }) : null, now(), conversation.id);
    } else if (replyResult.handoffOffered) {
      run(`UPDATE conversations SET clarification_attempts=?,pending_intent_json=NULL,handoff_offered_at=COALESCE(handoff_offered_at,?),updated_at=? WHERE id=?`, config.businessGuidanceMaxAttempts, now(), now(), conversation.id);
    }
  }
  if (unresolvedQuestions.length) {
    const gapReason = `以下问题没有可靠知识答案：${unresolvedQuestions.join('；')}`;
    replyResult.reason = `${replyResult.reason} / ${gapReason}`;
  } else if ((replyResult.matches || []).length) {
    // 命中可靠知识后结束此前尚未确认的人工意图，新的模糊咨询将重新计数。
    run(`UPDATE manual_handoff_intents SET status='RESOLVED_BY_KNOWLEDGE',updated_at=? WHERE conversation_key=? AND status='WAITING_USER_CONFIRMATION'`, now(), messageConversationKey(message));
  }
  const handoffQuestions = unresolvedQuestions.length
    ? unresolvedQuestions
    : (replyResult.handoffOffered ? [`连续${replyResult.guidanceAttempt || config.businessGuidanceMaxAttempts}轮仍未明确具体业务：${message.content}`] : []);
  // 私信在存在未解决问题时保留人工意图；纯闲聊只有达到配置轮次并明确展示转人工入口后才建立。
  if (isPrivateMessage && handoffQuestions.length && (replyResult.handoffOffered || existingIntent)) handoffIntent = rememberHandoffIntent(message, handoffQuestions);

  await queueStaticReply(message, replyResult.replyText, {
    decision: replyResult.decision,
    reason: replyResult.reason,
    confidence: replyResult.confidence,
    knowledge: replyResult.bestKnowledge,
    handoffIntentId: handoffIntent?.id || null,
    responseMode: replyResult.responseMode,
    replaceCancelledReplyJob,
    replyBatch,
    replyContext: { contextUsed: replyResult.contextUsed, resolvedQuestions: replyResult.resolvedQuestions, topicSwitched: replyResult.topicSwitched, matchMethod: replyResult.matchMethod, guidanceAttempt: replyResult.guidanceAttempt || 0, maxGuidanceAttempts: replyResult.maxGuidanceAttempts || config.businessGuidanceMaxAttempts, handoffOffered: replyResult.handoffOffered === true, clarificationCandidate: replyResult.clarificationCandidate || null, clarificationConfirmed: replyResult.clarificationConfirmed === true, clarificationDenied: replyResult.clarificationDenied === true, elapsedMs: replyResult.elapsedMs }
  });
  return row('SELECT * FROM messages WHERE id=?', messageId);
}

export async function processMessage(messageId, options = {}) {
  let message = row('SELECT * FROM messages WHERE id=?', messageId);
  if (!message) throw new Error('消息不存在');
  const lockHeld = miniProgramProcessingLockHeld(message);
  const binding = miniProgramProcessingTransaction(() => ensureMessageConversation(message));
  message = binding.message;
  const work = async () => {
    try { return await processMessageInternal(messageId, options); }
    catch (error) { throw message.platform_code === MINI_PROGRAM_PLATFORM_CODE ? safeMiniProgramProcessingError(error) : error; }
  };
  return lockHeld ? work() : withConversationSerial(message.conversation_id || `message-${messageId}`, work);
}


function settleUnqueuedV2ReplyBatch(replyBatchId, message) {
  const batch = row('SELECT * FROM reply_batches WHERE id=?', Number(replyBatchId));
  if (!batch || batch.status !== 'GENERATING') return batch;
  const stamp = now();
  const status = String(message?.status || '').toUpperCase();
  const decision = String(message?.decision || '').toUpperCase();
  if (status === 'NEW' || status === 'SUPERSEDED' || decision === 'SMART_REPLY_PAUSED') {
    requeueReplyBatchGeneration(batch.id, decision || status || 'GENERATION_NOT_QUEUED');
  } else if (status === 'SOURCE_GONE') {
    run(`UPDATE reply_batches SET status='SOURCE_GONE',invalidation_reason=?,completed_at=?,updated_at=? WHERE id=? AND status='GENERATING'`, decision || status, stamp, stamp, batch.id);
  } else if (status === 'MANUAL_REQUIRED' || status === 'DEFERRED_PAGE_UNAVAILABLE') {
    run(`UPDATE reply_batches SET status='MANUAL_REQUIRED',invalidation_reason=?,completed_at=?,updated_at=? WHERE id=? AND status='GENERATING'`, decision || status, stamp, stamp, batch.id);
  } else if (message?.handled_at || terminalMessageStatuses.has(status)) {
    run(`UPDATE reply_batches SET status='COMPLETED',invalidation_reason=?,completed_at=?,updated_at=? WHERE id=? AND status='GENERATING'`, decision || status || 'MESSAGE_ALREADY_HANDLED', stamp, stamp, batch.id);
  } else {
    run(`UPDATE reply_batches SET status='MANUAL_REQUIRED',invalidation_reason='GENERATION_FINISHED_WITHOUT_REPLY_JOB',completed_at=?,updated_at=? WHERE id=? AND status='GENERATING'`, stamp, stamp, batch.id);
  }
  return row('SELECT * FROM reply_batches WHERE id=?', batch.id);
}

async function processNextV2ReplyBatch(channelType, { platformCode = null } = {}) {
  const batch = claimPendingReplyBatchForGeneration(channelType, { platformCode });
  if (!batch) return null;
  const source = replyBatchSourceEvents(batch.id);
  const candidates = source.messages
    .filter(item => Number(item.conversation_id) === Number(batch.conversation_id))
    .sort((left, right) => Number(left.conversation_version || left.id) - Number(right.conversation_version || right.id));
  const message = candidates.at(-1) || null;
  if (!message) {
    const stamp = now();
    run(`UPDATE reply_batches SET status='MANUAL_REQUIRED',invalidation_reason='SOURCE_MESSAGE_NOT_FOUND',completed_at=?,updated_at=? WHERE id=? AND status='GENERATING'`, stamp, stamp, batch.id);
    return { batch: row('SELECT * FROM reply_batches WHERE id=?', batch.id), message: null };
  }
  try {
    const processed = await processMessageWithRegistry(message.id, { replyBatch: batch });
    return { batch: settleUnqueuedV2ReplyBatch(batch.id, processed), message: processed };
  } catch (error) {
    requeueReplyBatchGeneration(batch.id, 'GENERATION_EXCEPTION');
    issue({
      source: 'SYSTEM', category: 'REPLY', title: `${batch.platform_code} V2 回复批次生成失败`,
      detail: String(error?.stack || error?.message || error), relatedType: 'MESSAGE', relatedId: message.id, retryable: true
    });
    return { batch: row('SELECT * FROM reply_batches WHERE id=?', batch.id), message, error: String(error?.message || error) };
  }
}

async function drainV2ReplyBatches(channelType, { platformCode = null, limit = 20 } = {}) {
  const safeLimit = Math.max(1, Math.min(100, Number(limit) || 20));
  const results = [];
  const seenBatchIds = new Set();
  for (let index = 0; index < safeLimit; index += 1) {
    const result = await processNextV2ReplyBatch(channelType, { platformCode });
    if (!result) break;
    const batchId = Number(result.batch?.id || 0);
    results.push(result);
    if (!batchId || seenBatchIds.has(batchId)) break;
    seenBatchIds.add(batchId);
    if (result.batch?.status === 'PENDING') break;
  }
  return results;
}


function recordV2ReplyCompletion(payload, {
  batchStatus,
  attemptState,
  result = {},
  reason = null,
  stamp = now(),
  safeToRegenerate = false,
  jobId = null
} = {}) {
  if (!payload?.replyBatchId) return null;
  const batch = row('SELECT * FROM reply_batches WHERE id=?', Number(payload.replyBatchId));
  if (!batch || (jobId != null && Number(batch.agent_job_id) !== Number(jobId))) return batch;
  const conversation = row('SELECT ledger_version FROM conversations WHERE id=?', Number(batch.conversation_id));
  const completedAt = ['COMPLETED', 'SOURCE_GONE'].includes(String(batchStatus || '').toUpperCase()) ? stamp : null;
  if (safeToRegenerate) {
    run(`UPDATE reply_batches SET status='PENDING',reply_text=NULL,agent_job_id=NULL,generation_message_id=NULL,claimed_at=NULL,generation_started_at=NULL,send_started_at=NULL,
      invalidation_reason=?,completed_at=NULL,updated_at=? WHERE id=? AND status='SENDING'`, reason || attemptState || batchStatus, stamp, batch.id);
  } else {
    run(`UPDATE reply_batches SET status=?,invalidation_reason=?,completed_at=?,updated_at=? WHERE id=? AND status='SENDING'`,
      batchStatus, reason || null, completedAt, stamp, batch.id);
  }
  if (payload.replyAttemptId) {
    const sentAt = attemptState === 'VERIFIED' || attemptState === 'SEND_UNCERTAIN' ? stamp : null;
    const verifiedAt = attemptState === 'VERIFIED' ? stamp : null;
    run(`UPDATE reply_attempts SET state=?,post_send_version=?,result_json=?,error_message=?,sent_at=COALESCE(sent_at,?),verified_at=COALESCE(verified_at,?),updated_at=?
      WHERE id=? AND reply_batch_id=?`, attemptState, Number(conversation?.ledger_version || 0), JSON.stringify(result || {}), reason || null,
      sentAt, verifiedAt, stamp, Number(payload.replyAttemptId), batch.id);
  }
  return row('SELECT * FROM reply_batches WHERE id=?', batch.id);
}

function deferCollectedMessageReplyProcessing(messageId) {
  const binding = ensureMessageConversation(row('SELECT * FROM messages WHERE id=?', Number(messageId)));
  syncMessageProcessingRegistry(messageId);
  return binding.message;
}

function finishCollectedMessageUpsert(messageId, metadata, deferReplyProcessing) {
  if (deferReplyProcessing) {
    return { message: deferCollectedMessageReplyProcessing(messageId), ...metadata, deferredReplyProcessing: true };
  }
  return processMessageWithRegistry(messageId).then(message => ({ message, ...metadata, deferredReplyProcessing: false }));
}

function updateCollectedAccountIdentity(account, data, context, stamp) {
  const identity = data.accountIdentity || context.accountIdentity || {};
  const platformUserId = String(context.accountPlatformId || context.selfPlatformId || context.selfUid || identity.platformUserId || identity.userId || '').trim();
  const platformUserName = String(context.accountUserName || context.selfUserName || identity.platformUserName || identity.userName || '').trim();
  if (!platformUserId && !platformUserName) return account;
  const aliases = [platformUserName || account.platform_user_name].filter(Boolean);
  run(`UPDATE accounts SET
    platform_user_id=CASE WHEN platform_user_id IS NULL OR TRIM(platform_user_id)='' THEN NULLIF(?,'') ELSE platform_user_id END,
    platform_user_name=COALESCE(NULLIF(?,''),platform_user_name),platform_user_aliases=?,identity_updated_at=?,identity_source=?
    WHERE id=?`, platformUserId, platformUserName, JSON.stringify(aliases), stamp, context.accountIdentitySource || identity.source || 'COLLECTED_MESSAGE', account.id);
  return row('SELECT * FROM accounts WHERE id=?', account.id);
}

function recentOutgoingReplies(platformCode, accountId, messageType) {
  return rows(`SELECT id,message_type,reply_text,parent_external_id,context_json,created_at,updated_at,handled_at
    FROM messages
    WHERE platform_code=? AND account_id=? AND message_type=? AND status='AUTO_REPLIED' AND reply_text IS NOT NULL
    ORDER BY COALESCE(handled_at,updated_at,created_at) DESC,id DESC LIMIT 100`, platformCode, accountId, messageType);
}

function markMessageIgnoredSelf(messageId, assessment, context, stamp) {
  const reason = `\u5df2\u5ffd\u7565\u5df1\u65b9\u6d88\u606f\uff1a${assessment.reason}`;
  const existing = row('SELECT reply_job_id FROM messages WHERE id=?', messageId);
  run(`UPDATE messages SET status='IGNORED_SELF',decision='SELF_MESSAGE',reason=?,rule_version='sender-identity-2026.08.08.1',
    reply_job_id=NULL,context_json=?,collected_at=COALESCE(collected_at,?),updated_at=? WHERE id=?`, reason, JSON.stringify(context), stamp, stamp, messageId);
  run('DELETE FROM knowledge_gaps WHERE message_id=?', messageId);
  if (existing?.reply_job_id) run(`UPDATE agent_jobs SET status='CANCELLED',completed_at=?,result=? WHERE id=? AND status IN ('QUEUED','RUNNING')`, stamp, JSON.stringify({ message: reason }), existing.reply_job_id);
  return row('SELECT * FROM messages WHERE id=?', messageId);
}

function markMessageIgnoredOfficial(messageId, assessment, context, stamp) {
  const reason = `\u5df2\u6392\u9664\u5fae\u535a\u5b98\u65b9/\u7cfb\u7edf\u4f1a\u8bdd\uff1a${assessment.reason}`;
  const existing = row('SELECT reply_job_id FROM messages WHERE id=?', messageId);
  const nextContext = { ...context, sourceType: 'OFFICIAL_OR_SYSTEM', officialSource: true, sourceAssessment: assessment };
  run(`UPDATE messages SET status='IGNORED_OFFICIAL',decision='OFFICIAL_MESSAGE',reason=?,rule_version='weibo-source-2026.08.22.1',
    reply_job_id=NULL,context_json=?,collected_at=COALESCE(collected_at,?),updated_at=? WHERE id=?`, reason, JSON.stringify(nextContext), stamp, stamp, messageId);
  run('DELETE FROM knowledge_gaps WHERE message_id=?', messageId);
  if (existing?.reply_job_id) run(`UPDATE agent_jobs SET status='CANCELLED',completed_at=?,result=? WHERE id=? AND status IN ('QUEUED','RUNNING')`, stamp, JSON.stringify({ message: reason }), existing.reply_job_id);
  return row('SELECT * FROM messages WHERE id=?', messageId);
}


function cancelReplyJob(replyJobId, stamp, reason, decision) {
  if (!replyJobId) return;
  run(`UPDATE agent_jobs SET status='CANCELLED',completed_at=COALESCE(completed_at,?),lease_expires_at=NULL,result=?
    WHERE id=? AND job_type='REPLY' AND status IN ('QUEUED','RUNNING')`, stamp, JSON.stringify({ message: reason, decision }), Number(replyJobId));
}

function settleCollectedPlatformReplyBatches(messageId, verified, stamp) {
  const batches = rows(`SELECT * FROM reply_batches WHERE status IN ('PENDING','GENERATING','READY','SENDING','NEEDS_CONFIRMATION','SEND_UNCERTAIN')
    AND (generation_message_id=? OR EXISTS (SELECT 1 FROM json_each(source_message_ids_json) WHERE CAST(value AS INTEGER)=?))`, messageId, messageId);
  for (const batch of batches) {
    const sourceIds = numericJsonArray(batch.source_message_ids_json);
    const latestSource = sourceIds.length ? row(`SELECT id FROM messages WHERE id IN (${sourceIds.map(() => '?').join(',')})
      ORDER BY COALESCE(conversation_version,id) DESC,id DESC LIMIT 1`, ...sourceIds) : null;
    // An observation for an older source must not close a batch answering a
    // newer incoming message in the same conversation.
    if (Number(latestSource?.id || batch.generation_message_id) !== Number(messageId)) continue;
    const decision = verified ? 'PLATFORM_REPLY_DETECTED' : 'PLATFORM_REPLY_UNVERIFIED';
    cancelReplyJob(batch.agent_job_id, stamp, '平台已观察到回复或回复待核验，禁止自动补发', decision);
    run(`UPDATE reply_batches SET status=?,invalidation_reason=?,completed_at=?,updated_at=? WHERE id=?`,
      verified ? 'COMPLETED' : 'MANUAL_REQUIRED', decision, verified ? stamp : null, stamp, batch.id);
    // Keep reply_attempts unchanged: an observed outgoing message is not proof
    // that this application's earlier send attempt produced it.
  }
}

function applyCollectedPrivatePlatformReply(message, context, stamp, created) {
  if (message.deleted_at || message.handled_at) return null;
  const assessment = assessCollectedPrivatePlatformReply({ platformCode: message.platform_code, messageType: message.message_type, context });
  if (!assessment.requested) return null;
  if (terminalMessageStatuses.has(message.status) && !(message.status === 'SUPERSEDED' && assessment.verified)) return null;
  const decision = assessment.verified ? 'PLATFORM_REPLY_DETECTED' : 'PLATFORM_REPLY_UNVERIFIED';
  const note = assessment.verified
    ? '已检测到平台回复，发送方式未确认；为避免重复，未再次发送。'
    : `采集报告平台已有回复，但稳定身份或时间线证据不足，暂停自动回复等待核验：${assessment.reason}`;
  return immediateTransaction(() => {
    cancelReplyJob(message.reply_job_id, stamp, note, decision);
    if (assessment.verified) {
      run(`UPDATE messages SET status='MANUAL_HANDLED',decision='MANUAL_HANDLED',handled_at=?,handled_by='PLATFORM_DETECTED',
        handler_note=?,reason=?,reply_text=?,reply_job_id=NULL,context_json=?,collected_at=?,updated_at=? WHERE id=? AND handled_at IS NULL`,
      stamp, note, note, assessment.replyText, JSON.stringify(context), stamp, stamp, message.id);
      run('DELETE FROM knowledge_gaps WHERE message_id=?', message.id);
    } else {
      run(`UPDATE messages SET status='MANUAL_REQUIRED',decision='PLATFORM_REPLY_UNVERIFIED',reason=?,reply_job_id=NULL,
        context_json=?,collected_at=?,updated_at=? WHERE id=? AND handled_at IS NULL`,
      note, JSON.stringify(context), stamp, stamp, message.id);
    }
    const binding = ensureMessageConversation(row('SELECT * FROM messages WHERE id=?', message.id), { advanceIncoming: !assessment.verified });
    syncMessageProcessingRegistry(message.id, stamp);
    run(`UPDATE message_events SET reply_disposition=?,updated_at=? WHERE source_message_id=? AND direction='INBOUND'`,
      assessment.verified ? 'ALREADY_HANDLED' : 'MANUAL_REVIEW', stamp, message.id);
    settleCollectedPlatformReplyBatches(message.id, assessment.verified, stamp);
    return { message: binding.message, created, conversationBound: true,
      ...(assessment.verified ? { platformReplyDetected: true } : { platformReplyUnverified: true }) };
  });
}

function releaseMessageIssues(messageId, stamp, reason) {
  const activeIssues = rows(`SELECT id FROM issues WHERE related_type='MESSAGE' AND related_id=?
    AND category IN ('REPLY','MODEL_API') AND status IN ('OPEN','DIAGNOSING','DIAGNOSED','RETRYING')`, String(messageId));
  for (const item of activeIssues) {
    run(`UPDATE issues SET status='RESOLVED',resolution_type='SOURCE_GONE',resolution=?,resolved_by='PLATFORM_SOURCE_CHECK',resolved_at=?,updated_at=? WHERE id=?`, reason, stamp, stamp, item.id);
    releaseIssueBlocks(item.id, { releasedBy: 'PLATFORM_SOURCE_CHECK', reason });
  }
}

function markMessageSourceGone(messageId, replyJobId, result, stamp) {
  const reason = result.message || '平台当前完整列表已确认目标内容不存在，永久跳过回复且不再重试';
  cancelReplyJob(replyJobId, stamp, reason, 'SKIP_SOURCE_GONE');
  const updated = run(`UPDATE messages SET status='SOURCE_GONE',decision='SKIP_SOURCE_GONE',reason=?,rule_version='source-state-2026.08.17.1',
    reply_job_id=NULL,handled_at=COALESCE(handled_at,?),handled_by=COALESCE(handled_by,'PLATFORM_SOURCE_CHECK'),handler_note=?,updated_at=?
    WHERE id=? AND reply_job_id=? AND handled_at IS NULL`, reason, stamp, reason, stamp, Number(messageId), Number(replyJobId));
  if (updated.changes === 1) {
    run('DELETE FROM knowledge_gaps WHERE message_id=?', Number(messageId));
    releaseMessageIssues(messageId, stamp, reason);
    syncMessageProcessingRegistry(messageId, stamp);
  }
  return row('SELECT * FROM messages WHERE id=?', Number(messageId));
}

function markMessagePageDeferred(messageId, replyJobId, result, stamp) {
  const reason = result.message || '平台页面当前无法可靠加载或目标列表未完成验证，本次未发送且不判定内容已删除';
  cancelReplyJob(replyJobId, stamp, reason, 'DEFERRED_PAGE_UNAVAILABLE');
  const updated = run(`UPDATE messages SET status='DEFERRED_PAGE_UNAVAILABLE',decision='DEFERRED_PAGE_UNAVAILABLE',reason=?,rule_version='source-state-2026.08.17.1',
    reply_job_id=NULL,updated_at=? WHERE id=? AND reply_job_id=? AND handled_at IS NULL`, reason, stamp, Number(messageId), Number(replyJobId));
  if (updated.changes === 1) syncMessageProcessingRegistry(messageId, stamp);
  return row('SELECT * FROM messages WHERE id=?', Number(messageId));
}

function collectionFailureCreatesAccountBlock(result = {}) {
  return result.createAccountCollectBlock === true
    && !['SOURCE_GONE', 'DEFERRED_PAGE_UNAVAILABLE'].includes(String(result.sourceState || result.status || '').toUpperCase());
}

function assessStoredWeiboSource(message, context = json(message?.context_json, {})) {
  if (message?.platform_code !== 'weibo' || String(message?.message_type || '').toUpperCase() !== 'PRIVATE_MESSAGE') return null;
  return assessWeiboConversationSource({
    messageType: message.message_type,
    userName: message.user_name,
    content: message.content,
    verifiedAccount: context.verifiedAccount === true || context.sourceAssessment?.signals?.includes?.('VERIFIED_BADGE')
  });
}

function upsertCollectedMessage(data, simulated = false, { deferReplyProcessing = false } = {}) {
  if (data.platformCode === MINI_PROGRAM_PLATFORM_CODE) {
    throw Object.assign(new Error('小程序消息必须通过签名接口接收'), { code: 'MINI_PROGRAM_SIGNED_ENDPOINT_REQUIRED' });
  }
  let account = row('SELECT * FROM accounts WHERE id=? AND platform_code=? AND enabled=1', Number(data.accountId), data.platformCode);
  if (!account || !data.content?.trim() || !data.externalId) throw new Error('\u5e73\u53f0\u3001\u8d26\u53f7\u3001externalId \u548c\u6d88\u606f\u5185\u5bb9\u4e0d\u80fd\u4e3a\u7a7a\u6216\u4e0d\u5339\u914d');
  const type = String(data.messageType || 'COMMENT').toUpperCase();
  const baseExternalId = String(data.externalId).split('--repeat-', 1)[0];
  let externalId = baseExternalId;
  let existing = row(`SELECT * FROM messages
    WHERE platform_code=? AND account_id=? AND message_type=? AND (external_id=? OR external_id LIKE ?)
    ORDER BY created_at DESC,id DESC LIMIT 1`, data.platformCode, account.id, type, baseExternalId, `${baseExternalId}--repeat-%`);
  const stamp = now();
  const baseContext = { ...(data.context || {}), simulated };
  account = updateCollectedAccountIdentity(account, data, baseContext, stamp);
  const assessment = assessCollectedMessageIdentity({
    data: { ...data, messageType: type, context: baseContext },
    account,
    recentOutgoingReplies: recentOutgoingReplies(data.platformCode, account.id, type),
    collectedAt: stamp
  });
  const officialAssessment = data.platformCode === 'weibo' && type === 'PRIVATE_MESSAGE'
    ? assessWeiboConversationSource({ messageType: type, userName: data.userName, content: data.content, verifiedAccount: baseContext.verifiedAccount === true || baseContext.sourceAssessment?.signals?.includes?.('VERIFIED_BADGE') })
    : null;
  const context = { ...baseContext, actorUserName: baseContext.actorUserName || data.userName || null, identityAssessment: assessment, ...(officialAssessment ? { sourceAssessment: officialAssessment } : {}) };
  const processingIdentity = buildMessageProcessingIdentity({ ...data, platformCode: data.platformCode, accountId: account.id, messageType: type, externalId: baseExternalId, context }, stamp);
  const registryEntry = processingIdentity ? row('SELECT * FROM message_processing_registry WHERE identity_key=?', processingIdentity.identityKey) : null;
  if (registryEntry?.canonical_message_id) {
    const canonical = row('SELECT * FROM messages WHERE id=? AND platform_code=? AND account_id=? AND message_type=?', Number(registryEntry.canonical_message_id), data.platformCode, account.id, type);
    if (canonical) existing = canonical;
  }
  if (existing?.deleted_at) return { message: existing, created: false };
  if (officialAssessment?.isOfficial === true && officialAssessment.confidence === 'HIGH' && existing) {
    const message = markMessageIgnoredOfficial(existing.id, officialAssessment, context, stamp);
    syncMessageProcessingRegistry(existing.id, stamp);
    return { message, created: false, ignoredOfficial: true };
  }
  if (!existing && data.platformCode === 'douyin' && type === 'COMMENT') {
    existing = rows(`SELECT * FROM messages
      WHERE platform_code='douyin' AND account_id=? AND message_type='COMMENT' AND user_name=? AND content=?
      ORDER BY collected_at DESC,created_at DESC,id DESC LIMIT 50`, account.id, data.userName || '\u672a\u77e5\u7528\u6237', data.content.trim())
      .find(candidate => isSameDouyinCommentSemanticCandidate(candidate, data, stamp)) || null;
  }
  if (!existing && data.platformCode === 'douyin' && type === 'PRIVATE_MESSAGE') {
    existing = rows(`SELECT * FROM messages
      WHERE platform_code='douyin' AND account_id=? AND message_type='PRIVATE_MESSAGE' AND user_name=? AND content=?
      ORDER BY collected_at DESC,created_at DESC,id DESC LIMIT 20`, account.id, data.userName || '\u672a\u77e5\u7528\u6237', data.content.trim())
      .find(candidate => isSameDouyinPrivateOccurrence(candidate, data, stamp)) || null;
  }
  if (type === 'COMMENT' && existing && !sameStableCommentIdentity(existing, data.context) && isRepeatedCommentOccurrence(existing, data.context, stamp)) {
    externalId = repeatedExternalId(baseExternalId, stamp);
    existing = null;
  }
  if (existing) {
    if (existing.deleted_at) return { message: existing, created: false };
    if (existing.handled_at && existing.handled_by === 'PLATFORM_DETECTED') {
      const previousContext = json(existing.context_json, {});
      if (assessCollectedPrivatePlatformReply({ platformCode: existing.platform_code, messageType: existing.message_type, context: previousContext }).verified) {
        for (const key of ['alreadyHandled', 'platformReplyDetected', 'platformReplyText', 'platformReplyEvidence',
          'conversationId', 'conversationKey', 'messageId', 'direction', 'collectionSource', 'fullSource',
          'sourceVerified', 'chatTitleVerified', 'previewOnly']) context[key] = previousContext[key];
      }
    }
    touchMessageProcessingRegistry(processingIdentity, existing, stamp, { incrementSeen: true });
    if (assessment.isSelf) {
      run('UPDATE messages SET external_url=COALESCE(?,external_url),parent_external_id=COALESCE(?,parent_external_id),collected_at=?,updated_at=? WHERE id=?', data.externalUrl || null, data.parentExternalId || null, stamp, stamp, existing.id);
      const message = markMessageIgnoredSelf(existing.id, assessment, context, stamp);
      syncMessageProcessingRegistry(existing.id, stamp);
      return { message, created: false, ignoredSelf: true };
    }
    const privatePlatformReply = applyCollectedPrivatePlatformReply(existing, context, stamp, false);
    if (privatePlatformReply) return privatePlatformReply;
    if (type === 'COMMENT' && context.platformAuthorReplyDetected === true && !existing.handled_at) {
      const note = context.platformAuthorReplyText ? `抖音目标评论折叠线程内检测到作者回复：${String(context.platformAuthorReplyText).slice(0, 500)}` : '抖音目标评论折叠线程内检测到作者回复，禁止重复回复';
      run("UPDATE messages SET status='MANUAL_HANDLED',decision='MANUAL_HANDLED',handled_at=?,handled_by='PLATFORM_DETECTED',handler_note=?,context_json=?,collected_at=?,updated_at=? WHERE id=? AND handled_at IS NULL", stamp, note, JSON.stringify(context), stamp, stamp, existing.id);
      cancelReplyJob(existing.reply_job_id, stamp, '平台评论线程已存在作者回复，禁止自动补发', 'PLATFORM_REPLY_DETECTED');
      syncMessageProcessingRegistry(existing.id, stamp);
      return { message: row('SELECT * FROM messages WHERE id=?', existing.id), created: false, platformReplyDetected: true };
    }
    if (existing.status === 'IGNORED_SELF' && existing.decision === 'SELF_MESSAGE' && !existing.handled_at
      && json(existing.context_json, {}).identityAssessment?.evidence === 'EXACT_ACCOUNT_NAME_MATCH') {
      const restoredContext = { ...context, identityReclassifiedAt: stamp };
      run(`UPDATE messages SET status='MANUAL_REQUIRED',decision='MANUAL_REQUIRED',reason=?,rule_version='sender-identity-2026.09.09.1',
        reply_job_id=NULL,external_url=COALESCE(?,external_url),parent_external_id=COALESCE(?,parent_external_id),context_json=?,collected_at=?,updated_at=? WHERE id=?`,
      '已按当前登录账号恢复此前误过滤的留言，请重新判断后处理', data.externalUrl || null, data.parentExternalId || null, JSON.stringify(restoredContext), stamp, stamp, existing.id);
      syncMessageProcessingRegistry(existing.id, stamp);
      return { message: row('SELECT * FROM messages WHERE id=?', existing.id), created: false, restoredFromSelfFilter: true };
    }
    if (existing.status === 'DEFERRED_PAGE_UNAVAILABLE' && !existing.handled_at) {
      run(`UPDATE messages SET status='NEW',decision=NULL,reason=NULL,rule_version=NULL,reply_job_id=NULL,
        external_url=COALESCE(?,external_url),parent_external_id=COALESCE(?,parent_external_id),context_json=?,collected_at=?,updated_at=? WHERE id=?`,
      data.externalUrl || null, data.parentExternalId || null, JSON.stringify(context), stamp, stamp, existing.id);
      return finishCollectedMessageUpsert(existing.id, { created: false, resumedFromDeferred: true }, deferReplyProcessing);
    }
    if (existing.decision === 'FOLDED_REPLY_UNVERIFIED' && !existing.handled_at) {
      const verification = String(context.replyThreadVerification || '').toUpperCase();
      if (verification === 'VERIFIED_NO_AUTHOR_REPLY' || context.replyThreadCollapsed !== true) {
        run(`UPDATE messages SET status='NEW',decision=NULL,reason=NULL,rule_version=NULL,reply_job_id=NULL,
          external_url=COALESCE(?,external_url),parent_external_id=COALESCE(?,parent_external_id),context_json=?,collected_at=?,updated_at=? WHERE id=?`,
        data.externalUrl || null, data.parentExternalId || null, JSON.stringify(context), stamp, stamp, existing.id);
        return finishCollectedMessageUpsert(existing.id, { created: false, resumedAfterFoldedReplyVerification: true }, deferReplyProcessing);
      }
    }
    const refreshedEligibility = assessMessageAutoReplyEligibility({
      platformCode: data.platformCode,
      accountId: account.id,
      messageType: type,
      externalId,
      externalUrl: data.externalUrl,
      sourceContent: data.content.trim(),
      userName: data.userName || existing.user_name,
      messageContext: context
    }, { phase: 'creation' });
    const resumePausedSmartReply = existing.decision === 'SMART_REPLY_PAUSED' && getPlatformSmartReply(data.platformCode).enabled;
    const resumeIdentityUpgrade = existing.decision === 'AUTO_REPLY_INELIGIBLE' && refreshedEligibility.allowed;
    if (!existing.handled_at && !existing.reply_job_id && (resumePausedSmartReply || resumeIdentityUpgrade)) {
      run(`UPDATE messages SET status='NEW',decision=NULL,reason=NULL,rule_version=NULL,reply_job_id=NULL,
        external_id=?,external_url=COALESCE(?,external_url),parent_external_id=COALESCE(?,parent_external_id),context_json=?,collected_at=?,updated_at=? WHERE id=?`,
      externalId, data.externalUrl || null, data.parentExternalId || null, JSON.stringify(context), stamp, stamp, existing.id);
      return finishCollectedMessageUpsert(existing.id, { created: false, resumedAfterEvidenceUpgrade: true }, deferReplyProcessing);
    }
    run('UPDATE messages SET external_url=COALESCE(?,external_url),parent_external_id=COALESCE(?,parent_external_id),context_json=?,collected_at=?,updated_at=? WHERE id=?', data.externalUrl || null, data.parentExternalId || null, JSON.stringify(context), stamp, stamp, existing.id);
    syncMessageProcessingRegistry(existing.id, stamp);
    return { message: row('SELECT * FROM messages WHERE id=?', existing.id), created: false, conversationBound: Boolean(existing.conversation_key_snapshot) };
  }
  const ignoredOfficial = officialAssessment?.isOfficial === true && officialAssessment.confidence === 'HIGH';
  const status = ignoredOfficial ? 'IGNORED_OFFICIAL' : assessment.isSelf ? 'IGNORED_SELF' : 'NEW';
  const decision = ignoredOfficial ? 'OFFICIAL_MESSAGE' : assessment.isSelf ? 'SELF_MESSAGE' : null;
  const reason = ignoredOfficial ? `\u5df2\u6392\u9664\u5fae\u535a\u5b98\u65b9/\u7cfb\u7edf\u4f1a\u8bdd\uff1a${officialAssessment.reason}` : assessment.isSelf ? `\u5df2\u5ffd\u7565\u5df1\u65b9\u6d88\u606f\uff1a${assessment.reason}` : null;
  const id = Number(run(`INSERT INTO messages(platform_code,account_id,message_type,external_id,user_name,content,status,decision,reason,rule_version,external_url,parent_external_id,context_json,collected_at,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, data.platformCode, account.id, type, externalId, data.userName || (simulated ? '\u6a21\u62df\u7528\u6237' : '\u672a\u77e5\u7528\u6237'), data.content.trim(), status, decision, reason, ignoredOfficial ? 'weibo-source-2026.08.22.1' : assessment.isSelf ? 'sender-identity-2026.08.08.1' : null, data.externalUrl || null, data.parentExternalId || null, JSON.stringify(context), stamp, stamp, stamp).lastInsertRowid);
  if (ignoredOfficial) {
    syncMessageProcessingRegistry(id, stamp);
    return { message: row('SELECT * FROM messages WHERE id=?', id), created: true, ignoredOfficial: true };
  }
  if (assessment.isSelf) {
    syncMessageProcessingRegistry(id, stamp);
    return { message: row('SELECT * FROM messages WHERE id=?', id), created: true, ignoredSelf: true };
  }
  const privatePlatformReply = applyCollectedPrivatePlatformReply(row('SELECT * FROM messages WHERE id=?', id), context, stamp, true);
  if (privatePlatformReply) return privatePlatformReply;
  if (type === 'COMMENT' && context.platformAuthorReplyDetected === true) {
    const note = context.platformAuthorReplyText
      ? `抖音目标评论回复线程内检测到作者回复：${String(context.platformAuthorReplyText).slice(0, 500)}`
      : '抖音目标评论回复线程内检测到作者回复，禁止重复回复';
    run("UPDATE messages SET status='MANUAL_HANDLED',decision='MANUAL_HANDLED',handled_at=?,handled_by='PLATFORM_DETECTED',handler_note=?,updated_at=? WHERE id=?", stamp, note, stamp, id);
    syncMessageProcessingRegistry(id, stamp);
    return { message: row('SELECT * FROM messages WHERE id=?', id), created: true, platformReplyDetected: true };
  }
  if (type === 'COMMENT' && context.replyThreadCollapsed === true && String(context.replyThreadVerification || '').toUpperCase() === 'UNVERIFIED') {
    const foldReason = '该评论存在折叠回复，但本轮无法可靠展开并确认是否已有作者回复；为防止重复发送，已暂停自动回复并等待重新采集校验';
    run("UPDATE messages SET status='MANUAL_REQUIRED',decision='FOLDED_REPLY_UNVERIFIED',reason=?,rule_version='douyin-folded-reply-2026.08.21.1',updated_at=? WHERE id=?", foldReason, stamp, id);
    syncMessageProcessingRegistry(id, stamp);
    return { message: row('SELECT * FROM messages WHERE id=?', id), created: true, foldedReplyUnverified: true };
  }
  return finishCollectedMessageUpsert(id, { created: true }, deferReplyProcessing);
}

function reportPublishPlatformIsolation({ phase, payload = {}, target = {}, result = {}, validation = {} }) {
  const platformCode = target.platform_code || payload.platformCode || 'unknown';
  const detail = JSON.stringify({
    phase,
    validation,
    request: {
      taskId: payload.taskId ?? null,
      targetId: payload.targetId ?? null,
      platformCode: payload.platformCode || null,
      accountId: payload.accountId ?? null,
      verificationPolicyId: payload.verificationPolicyId || null
    },
    target: {
      taskId: target.task_id ?? null,
      targetId: target.id ?? null,
      platformCode: target.platform_code || null,
      accountId: target.account_id ?? null
    },
    result: {
      platformCode: result.platformCode || null,
      verificationPolicyId: result.verificationPolicyId || null,
      stage: result.stage || null,
      reviewStatus: result.reviewStatus || null,
      matchedTab: result.matchedTab || null,
      platformUrl: result.platformUrl || result.url || null
    }
  }, null, 2).slice(0, 4000);
  issue({
    source: 'PUBLISH_GUARD',
    category: 'PUBLISH_PLATFORM_ISOLATION',
    title: `${platformCode} 发布状态结果已被平台隔离规则拦截`,
    detail,
    relatedType: 'PUBLISH_TARGET',
    relatedId: target.id || payload.targetId || null,
    screenshotPath: result.screenshotPath || null,
    retryable: false
  });
}

function applyReviewResult(payload, result, outerStatus, { sourceJobId = null } = {}) {
  const target = row('SELECT * FROM publish_targets WHERE id=?', payload.targetId); if (!target) return;
  const resultObject = result && typeof result === 'object' ? result : {};
  const identityValidation = validatePublishTargetIdentity(payload, target);
  if (!identityValidation.ok) {
    reportPublishPlatformIsolation({ phase: 'VERIFY_REQUEST_IDENTITY', payload, target, result: resultObject, validation: identityValidation });
    updateTaskAggregate(target.task_id);
    return;
  }
  const provenanceValidation = validatePlatformResultProvenance(target.platform_code, resultObject);
  if (!provenanceValidation.ok) {
    reportPublishPlatformIsolation({ phase: 'VERIFY_RESULT_PROVENANCE', payload, target, result: resultObject, validation: provenanceValidation });
    updateTaskAggregate(target.task_id);
    return;
  }
  if (publishTargetHasManualPublishedLock(target)) {
    cancelQueuedPublishVerificationJobs(target.id, { reason: 'MANUAL_PUBLISHED_LOCK', exceptJobId: sourceJobId });
    updateTaskAggregate(target.task_id);
    return;
  }
  const stamp = now();
  const reviewStatus = String(resultObject.reviewStatus || (outerStatus === 'NEEDS_CONFIRMATION' ? 'UNKNOWN' : '')).toUpperCase();
  let status = 'NEEDS_CONFIRMATION';
  if (reviewStatus === 'PUBLISHED') status = 'PUBLISHED';
  else if (reviewStatus === 'REVIEWING') status = 'REVIEWING';
  else if (reviewStatus === 'SYNCING') status = 'SYNCING';
  else if (reviewStatus === 'REJECTED') status = 'REJECTED';
  else if (outerStatus === 'FAILED') status = 'FAILED';
  const confirmsSubmission = ['PUBLISHED', 'REVIEWING', 'SYNCING', 'REJECTED'].includes(reviewStatus);
  const submissionStatus = confirmsSubmission ? 'SUBMITTED' : target.submission_status;
  const submittedAt = confirmsSubmission ? (target.submitted_at || stamp) : target.submitted_at;
  const attemptState = confirmsSubmission
    ? publishAttemptStateForReview(reviewStatus)
    : (target.submit_lock === 'LOCKED' ? 'SUBMIT_ATTEMPTED_UNCONFIRMED' : target.publish_attempt_state);
  const submitLock = confirmsSubmission ? 'LOCKED' : target.submit_lock;
  const submitAttemptedAt = confirmsSubmission ? (target.submit_attempted_at || submittedAt || stamp) : target.submit_attempted_at;
  const submitAttemptCount = confirmsSubmission ? Math.max(Number(target.submit_attempt_count || 0), 1) : Number(target.submit_attempt_count || 0);
  run(`UPDATE publish_targets SET status=?,submission_status=?,review_status=?,submitted_at=?,platform_post_id=COALESCE(?,platform_post_id),platform_url=COALESCE(?,platform_url),reviewed_at=CASE WHEN ? IN ('PUBLISHED','REJECTED') THEN ? ELSE reviewed_at END,last_checked_at=?,review_message=?,result=?,evidence_json=?,publish_attempt_state=?,submit_lock=?,submit_attempted_at=?,submit_attempt_count=?,submit_lock_reason=CASE WHEN ? THEN COALESCE(submit_lock_reason,'PLATFORM_RECONCILIATION') ELSE submit_lock_reason END,updated_at=? WHERE id=?`, status, submissionStatus, reviewStatus || 'UNKNOWN', submittedAt, resultObject.platformPostId || null, resultObject.platformUrl || resultObject.url || null, reviewStatus, stamp, stamp, resultObject.message || null, JSON.stringify(resultObject), JSON.stringify({ evidencePath: resultObject.evidencePath || null, screenshotPath: resultObject.screenshotPath || null }), attemptState, submitLock, submitAttemptedAt, submitAttemptCount, confirmsSubmission ? 1 : 0, stamp, target.id);
  if (status === 'REJECTED' || status === 'FAILED') issue({ source: 'PLATFORM_REVIEW', category: 'PUBLISH_REVIEW', title: `${target.platform_code} 平台审核异常`, detail: resultObject.message || '平台审核异常', relatedType: 'PUBLISH_TARGET', relatedId: target.id, screenshotPath: resultObject.screenshotPath, retryable: status === 'FAILED' && target.submit_lock !== 'LOCKED' });

  const terminal = ['PUBLISHED', 'REJECTED'].includes(reviewStatus);
  if (terminal) {
    cancelQueuedPublishVerificationJobs(target.id, { reason: `PUBLISH_REVIEW_${reviewStatus}`, exceptJobId: sourceJobId });
  } else if (sourceJobId) {
    const scheduleSubmittedAt = submitAttemptedAt || submittedAt || publishSubmittedTimestamp(payload.submittedAt);
    const submissionWasAttempted = submissionStatus === 'SUBMITTED' || submitLock === 'LOCKED' || Boolean(scheduleSubmittedAt);
    if (submissionWasAttempted) {
      const account = row('SELECT device_id,profile_name FROM accounts WHERE id=?', target.account_id);
      const task = row('SELECT title,body FROM publish_tasks WHERE id=?', target.task_id);
      if (account?.device_id) {
        const reviewAttempt = Math.max(0, Number(payload.reviewAttempt || 0));
        const nextAttempt = reviewAttempt + 1;
        const delayMs = nextPublishReviewDelayMs(scheduleSubmittedAt);
        createJob(account.device_id, 'VERIFY_PUBLISH', {
          taskId: target.task_id,
          targetId: target.id,
          platformCode: target.platform_code,
          accountId: target.account_id,
          profileName: payload.profileName || account.profile_name,
          title: payload.title || task?.title,
          body: payload.body || task?.body || '',
          platformPostId: payload.platformPostId || target.platform_post_id || null,
          platformUrl: payload.platformUrl || target.platform_url || null,
          submittedAt: scheduleSubmittedAt,
          submissionStatus,
          submissionConfirmed: submissionStatus === 'SUBMITTED',
          reviewAttempt: nextAttempt,
          verificationPolicyId: publishVerificationPolicy(target.platform_code)?.verificationPolicyId || null,
          verificationSource: 'AUTOMATIC',
          manualRequested: false
        }, { idempotencyKey: `verify:target:${target.id}:after:${sourceJobId}:attempt:${nextAttempt}`, availableAt: futureIso(delayMs) });
      }
    }
  }
  updateTaskAggregate(target.task_id);
}

function publishTargetHasManualPublishedLock(target) {
  const storedResult = json(target?.result, {});
  return target?.status === 'PUBLISHED'
    && target?.publish_attempt_state === 'PUBLISHED'
    && target?.submit_lock === 'LOCKED'
    && storedResult?.manuallyConfirmed === true;
}

function isExplicitUploadNotStarted(result = {}) {
  const stage = String(result.stage || '').toLowerCase();
  const errorCode = String(result.errorCode || '').toUpperCase();
  const submissionStatus = String(result.submissionStatus || '').toUpperCase();
  return result.submitAttempted !== true
    && result.uploadDefinitelyNotStarted === true
    && result.uploadMayHaveStarted === false
    && submissionStatus === 'NOT_SUBMITTED'
    && (stage === 'upload_not_started' || errorCode === 'MATERIAL_UPLOAD_NOT_STARTED');
}

function isExplicitUploadFailure(result = {}) {
  const stage = String(result.stage || '').toLowerCase();
  const platformState = String(result.platformState || '').toUpperCase();
  const errorCode = String(result.errorCode || '').toUpperCase();
  return result.uploadFailed === true || stage === 'upload_failed' || platformState === 'UPLOAD_FAILED' || errorCode === 'PLATFORM_UPLOAD_FAILED';
}

function isExplicitWeiboPlatformFailure(platformCode, result = {}) {
  return String(platformCode || '').trim() === 'weibo'
    && result.explicitPlatformFailure === true
    && result.networkEvidence?.kind === 'FAILURE'
    && result.networkEvidence?.confirmed === true
    && String(result.submissionStatus || '').toUpperCase() === 'NOT_SUBMITTED';
}

function applyPublishCompletion(job, payload, result, outerStatus, stamp, jobId) {
  const target = row('SELECT * FROM publish_targets WHERE id=?', payload.targetId);
  if (!target) return;
  const resultObject = result && typeof result === 'object' ? result : {};
  const identityValidation = validatePublishTargetIdentity(payload, target);
  if (!identityValidation.ok) {
    reportPublishPlatformIsolation({ phase: 'PUBLISH_REQUEST_IDENTITY', payload, target, result: resultObject, validation: identityValidation });
    updateTaskAggregate(target.task_id);
    return;
  }
  const provenanceValidation = validatePlatformResultProvenance(target.platform_code, resultObject);
  if (!provenanceValidation.ok) {
    reportPublishPlatformIsolation({ phase: 'PUBLISH_RESULT_PROVENANCE', payload, target, result: resultObject, validation: provenanceValidation });
    updateTaskAggregate(target.task_id);
    return;
  }
  if (publishTargetHasManualPublishedLock(target)) {
    updateTaskAggregate(target.task_id);
    return;
  }
  if (isExplicitWeiboPlatformFailure(target.platform_code, resultObject)) {
    const effectiveResult = {
      ...resultObject,
      stage: 'publish_rejected',
      submissionStatus: 'NOT_SUBMITTED',
      reviewStatus: 'UNKNOWN',
      submitAttempted: true,
      retrySafe: resultObject.retrySafe !== false,
      safeToRetry: resultObject.safeToRetry !== false,
      manualActionRequired: false
    };
    cancelQueuedPublishVerificationJobs(target.id, { reason: 'WEIBO_EXPLICIT_PLATFORM_FAILURE' });
    run(`UPDATE publish_targets SET status='FAILED',submission_status='NOT_SUBMITTED',review_status='UNKNOWN',submitted_at=NULL,reviewed_at=NULL,last_checked_at=?,review_message=?,result=?,evidence_json=?,publish_attempt_state='PUBLISH_REJECTED',submit_lock='UNLOCKED',submit_authorized_at=NULL,submit_attempted_at=NULL,submit_attempt_count=CASE WHEN submit_attempt_count>0 THEN submit_attempt_count-1 ELSE 0 END,submit_lock_reason='WEIBO_EXPLICIT_PLATFORM_FAILURE',updated_at=? WHERE id=?`, stamp, effectiveResult.message || '微博平台明确拒绝本次发布', JSON.stringify(effectiveResult), JSON.stringify({ evidencePath: resultObject.evidencePath || null, screenshotPath: resultObject.screenshotPath || null, networkEvidence: resultObject.networkEvidence || null }), stamp, target.id);
    issue({ source: 'RPA', category: 'PUBLISH', title: '微博发布被平台明确拒绝', detail: effectiveResult.message || '微博平台明确拒绝本次发布', relatedType: 'PUBLISH_TARGET', relatedId: target.id, screenshotPath: resultObject.screenshotPath, retryable: effectiveResult.safeToRetry === true });
    updateTaskAggregate(target.task_id);
    return;
  }
  const reliable = hasReliablePublishEvidence(payload, resultObject, outerStatus);
  const reviewStatus = String(resultObject.reviewStatus || 'UNKNOWN').toUpperCase();
  if (reliable) {
    const status = reviewStatus === 'PUBLISHED' ? 'PUBLISHED'
      : reviewStatus === 'REJECTED' ? 'REJECTED'
        : reviewStatus === 'REVIEWING' ? 'REVIEWING' : 'SUBMITTED';
    const attemptState = publishAttemptStateForReview(reviewStatus, 'SUBMITTED');
    const submittedAt = target.submitted_at || resultObject.submittedAt || stamp;
    const reviewScheduleBase = target.submit_attempted_at || resultObject.submittedAt || submittedAt;
    const submitAuthorizedAt = resultObject.reconciledBeforeSubmit === true ? null : stamp;
    run(`UPDATE publish_targets SET status=?,submission_status='SUBMITTED',review_status=?,submitted_at=?,reviewed_at=CASE WHEN ? IN ('PUBLISHED','REJECTED') THEN COALESCE(reviewed_at,?) ELSE reviewed_at END,last_checked_at=?,review_message=?,result=?,evidence_json=?,platform_post_id=COALESCE(?,platform_post_id),platform_url=COALESCE(?,platform_url),publish_attempt_state=?,submit_lock='LOCKED',submit_authorized_at=COALESCE(submit_authorized_at,?),submit_attempted_at=COALESCE(submit_attempted_at,?),submit_attempt_count=MAX(submit_attempt_count,1),submit_lock_reason=COALESCE(submit_lock_reason,?),updated_at=? WHERE id=?`, status, reviewStatus, submittedAt, reviewStatus, stamp, stamp, resultObject.message || '平台已确认稿件提交', JSON.stringify(resultObject), JSON.stringify({ evidencePath: resultObject.evidencePath || null, screenshotPath: resultObject.screenshotPath || null }), resultObject.platformPostId || null, resultObject.platformUrl || resultObject.url || null, attemptState, submitAuthorizedAt, submittedAt, resultObject.reconciledBeforeSubmit === true ? 'MANAGEMENT_PRECHECK_RECONCILIATION' : 'FINAL_PUBLISH_CLICK', stamp, target.id);
    if (['PUBLISHED','REJECTED'].includes(reviewStatus)) {
      cancelQueuedPublishVerificationJobs(target.id, { reason: `PUBLISH_COMPLETED_${reviewStatus}` });
    } else {
      createJob(job.device_id, 'VERIFY_PUBLISH', {
        taskId: target.task_id,
        targetId: target.id,
        platformCode: target.platform_code,
        accountId: target.account_id,
        profileName: payload.profileName,
        title: payload.title,
        body: payload.body || '',
        platformPostId: resultObject.platformPostId || target.platform_post_id || null,
        platformUrl: resultObject.platformUrl || resultObject.url || target.platform_url || null,
        submittedAt: reviewScheduleBase,
        submissionStatus: 'SUBMITTED',
        submissionConfirmed: true,
        reviewAttempt: 0,
        verificationPolicyId: publishVerificationPolicy(target.platform_code)?.verificationPolicyId || null,
        verificationSource: 'AUTOMATIC',
        manualRequested: false
      }, { idempotencyKey: `verify:target:${target.id}:initial`, availableAt: initialPublishReviewAvailableAt(reviewScheduleBase) });
    }
  } else {
    const explicitUploadNotStarted = isExplicitUploadNotStarted(resultObject);
    if (explicitUploadNotStarted) {
      const effectiveResult = {
        ...resultObject,
        stage: 'upload_not_started',
        submissionStatus: 'NOT_SUBMITTED',
        reviewStatus: 'UNKNOWN',
        submitAttempted: false,
        uploadMayHaveStarted: false,
        uploadDefinitelyNotStarted: true,
        retrySafe: true,
        safeToRetry: true,
        manualActionRequired: false,
        draftSaved: false,
        draftPreservedInBrowser: false,
        draftExists: false
      };
      cancelQueuedPublishVerificationJobs(target.id, { reason: 'UPLOAD_NOT_STARTED' });
      run(`UPDATE publish_targets SET status='FAILED',submission_status='NOT_SUBMITTED',review_status='UNKNOWN',submitted_at=NULL,reviewed_at=NULL,last_checked_at=NULL,review_message=?,result=?,evidence_json=?,publish_attempt_state='UPLOAD_NOT_STARTED',submit_lock='UNLOCKED',submit_authorized_at=NULL,submit_attempted_at=NULL,submit_attempt_count=CASE WHEN submit_attempt_count>0 THEN submit_attempt_count-1 ELSE 0 END,submit_lock_reason='UPLOAD_NOT_STARTED',updated_at=? WHERE id=?`, effectiveResult.message || '文件选择动作已执行，但平台上传未启动', JSON.stringify(effectiveResult), JSON.stringify({ evidencePath: resultObject.evidencePath || null, screenshotPath: resultObject.screenshotPath || null }), stamp, target.id);
      issue({ source: 'RPA', category: 'PUBLISH', title: `${target.platform_code} 上传未启动`, detail: effectiveResult.message || '文件选择动作已执行，但平台上传未启动', relatedType: 'PUBLISH_TARGET', relatedId: target.id, screenshotPath: resultObject.screenshotPath, retryable: true });
      updateTaskAggregate(target.task_id);
      return;
    }
    const explicitUploadFailure = isExplicitUploadFailure(resultObject) && resultObject.submitAttempted !== true;
    if (explicitUploadFailure) {
      const effectiveResult = {
        ...resultObject,
        stage: 'upload_failed',
        uploadFailed: true,
        submissionStatus: 'NOT_SUBMITTED',
        reviewStatus: 'UNKNOWN',
        submitAttempted: false,
        retrySafe: resultObject.retrySafe !== false,
        safeToRetry: resultObject.safeToRetry !== false,
        manualActionRequired: false,
        draftSaved: false,
        draftPreservedInBrowser: false
      };
      cancelQueuedPublishVerificationJobs(target.id, { reason: 'UPLOAD_FAILED_BEFORE_SUBMISSION' });
      run(`UPDATE publish_targets SET status='FAILED',submission_status='NOT_SUBMITTED',review_status='UNKNOWN',submitted_at=NULL,reviewed_at=NULL,last_checked_at=NULL,review_message=?,result=?,evidence_json=?,publish_attempt_state='UPLOAD_FAILED',submit_lock='UNLOCKED',submit_authorized_at=NULL,submit_attempted_at=NULL,submit_attempt_count=CASE WHEN submit_attempt_count>0 THEN submit_attempt_count-1 ELSE 0 END,submit_lock_reason='UPLOAD_FAILED_BEFORE_SUBMISSION',updated_at=? WHERE id=?`, effectiveResult.message || '视频尚未提交平台，上传过程中出现网络异常', JSON.stringify(effectiveResult), JSON.stringify({ evidencePath: resultObject.evidencePath || null, screenshotPath: resultObject.screenshotPath || null }), stamp, target.id);
      issue({ source: 'RPA', category: 'PUBLISH', title: `${target.platform_code} 视频上传失败`, detail: effectiveResult.message || '视频尚未提交平台，上传过程中出现网络异常', relatedType: 'PUBLISH_TARGET', relatedId: target.id, screenshotPath: resultObject.screenshotPath, retryable: true });
      updateTaskAggregate(target.task_id);
      return;
    }
    const submitAttempted = resultObject.submitAttempted === true || target.submit_lock === 'LOCKED' || Boolean(target.submit_attempted_at);
    const explicitDraftBlocked = resultObject.stage === 'existing_draft_blocked' || resultObject.stage === 'existing_draft_mismatch'
      || resultObject.stage === 'existing_draft_fingerprint_mismatch' || resultObject.stage === 'draft_prepare_unconfirmed'
      || resultObject.stage === 'draft_saved_manual_required' || resultObject.stage === 'publish_button_unavailable'
      || resultObject.stage === 'draft_ready' || resultObject.uploadMayHaveStarted === true;
    const draftReadyOrPreserved = explicitDraftBlocked || resultObject.draftSaved === true || resultObject.draftPreservedInBrowser === true;
    const manualActionRequired = resultObject.manualActionRequired === true || submitAttempted || draftReadyOrPreserved
      || outerStatus === 'FAILED' || outerStatus === 'NEEDS_CONFIRMATION';
    const effectiveStatus = submitAttempted || draftReadyOrPreserved || outerStatus === 'SUCCESS' ? 'NEEDS_CONFIRMATION' : outerStatus;
    const baseResult = outerStatus === 'SUCCESS'
      ? { ...resultObject, attestationRejected: true, attestationReason: '适配器报告成功，但缺少服务端认可的可靠投稿凭据' }
      : resultObject;
    const effectiveResult = manualActionRequired
      ? { ...baseResult, manualActionRequired: true, draftSaved: resultObject.draftSaved === true, draftPreservedInBrowser: resultObject.draftPreservedInBrowser === true }
      : baseResult;
    if (outerStatus === 'SUCCESS') run("UPDATE agent_jobs SET status='NEEDS_CONFIRMATION',result=? WHERE id=?", JSON.stringify(effectiveResult), jobId);
    const attemptState = submitAttempted ? 'SUBMIT_ATTEMPTED_UNCONFIRMED' : draftReadyOrPreserved ? 'DRAFT_BLOCKED' : 'NOT_ATTEMPTED';
    run(`UPDATE publish_targets SET status=?,result=?,evidence_json=?,publish_attempt_state=?,submit_lock=CASE WHEN ? THEN 'LOCKED' ELSE submit_lock END,submit_attempted_at=CASE WHEN ? THEN COALESCE(submit_attempted_at,?) ELSE submit_attempted_at END,submit_attempt_count=CASE WHEN ? THEN MAX(submit_attempt_count,1) ELSE submit_attempt_count END,submit_lock_reason=CASE WHEN ? THEN COALESCE(submit_lock_reason,'SUBMIT_RESULT_UNCONFIRMED') ELSE submit_lock_reason END,updated_at=? WHERE id=?`, effectiveStatus, JSON.stringify(effectiveResult), JSON.stringify({ evidencePath: resultObject.evidencePath || null, screenshotPath: resultObject.screenshotPath || null }), attemptState, submitAttempted ? 1 : 0, submitAttempted ? 1 : 0, stamp, submitAttempted ? 1 : 0, submitAttempted ? 1 : 0, stamp, target.id);
    if (effectiveStatus === 'FAILED') issue({ source: 'RPA', category: 'PUBLISH', title: `${target.platform_code} 发布执行失败`, detail: resultObject.message || 'RPA 执行失败', relatedType: 'PUBLISH_TARGET', relatedId: target.id, screenshotPath: resultObject.screenshotPath, retryable: !manualActionRequired && !submitAttempted && !draftReadyOrPreserved });

    const updatedTarget = row('SELECT * FROM publish_targets WHERE id=?', target.id) || target;
    if (shouldScheduleUnconfirmedPublishVerification({
      platformCode: target.platform_code,
      outerStatus,
      result: resultObject,
      target: updatedTarget
    })) {
      const account = row('SELECT device_id,profile_name FROM accounts WHERE id=?', target.account_id);
      const task = row('SELECT title,body FROM publish_tasks WHERE id=?', target.task_id);
      const scheduleSubmittedAt = updatedTarget.submit_attempted_at || resultObject.submittedAt || stamp;
      const deviceId = account?.device_id || job.device_id;
      if (deviceId) {
        createJob(deviceId, 'VERIFY_PUBLISH', {
          taskId: target.task_id,
          targetId: target.id,
          platformCode: target.platform_code,
          accountId: target.account_id,
          profileName: payload.profileName || account?.profile_name,
          title: payload.title || task?.title,
          body: payload.body || task?.body || '',
          platformPostId: payload.platformPostId || target.platform_post_id || null,
          platformUrl: payload.platformUrl || target.platform_url || null,
          submittedAt: scheduleSubmittedAt,
          submissionStatus: 'UNKNOWN',
          submissionConfirmed: false,
          reviewAttempt: 0,
          verificationPolicyId: publishVerificationPolicy(target.platform_code)?.verificationPolicyId || null,
          verificationSource: 'AUTOMATIC_UNCONFIRMED_SUBMIT',
          manualRequested: false
        }, {
          idempotencyKey: `verify:target:${target.id}:initial-unconfirmed-bilibili`,
          availableAt: initialPublishReviewAvailableAt(scheduleSubmittedAt)
        });
      }
    }
  }
  updateTaskAggregate(target.task_id);
}

function markPublishTargetManualPublished(targetId, data = {}) {
  const target = row('SELECT * FROM publish_targets WHERE id=?', Number(targetId));
  if (!target) return null;
  const stamp = now();
  const handledBy = String(data.handledBy || '运营人员').trim().slice(0, 100) || '运营人员';
  const message = String(data.message || '用户确认已在平台草稿/发布页面人工发布').trim().slice(0, 1000);
  const previousResult = json(target.result, {});
  const effectiveResult = {
    ...previousResult,
    manuallyConfirmed: true,
    manualActionRequired: false,
    manualAction: 'PUBLISHED_ON_PLATFORM',
    handledBy,
    handledAt: stamp,
    message
  };
  db.exec('BEGIN IMMEDIATE');
  try {
    run(`UPDATE publish_targets SET status='PUBLISHED',submission_status='SUBMITTED',review_status='PUBLISHED',publish_attempt_state='PUBLISHED',submit_lock='LOCKED',submit_authorized_at=COALESCE(submit_authorized_at,?),submit_attempted_at=COALESCE(submit_attempted_at,?),submit_attempt_count=MAX(submit_attempt_count,1),submit_lock_reason='MANUAL_PLATFORM_PUBLISH_CONFIRMED',submitted_at=COALESCE(submitted_at,?),reviewed_at=?,last_checked_at=?,review_message=?,result=?,updated_at=? WHERE id=?`, stamp, stamp, stamp, stamp, stamp, message, JSON.stringify(effectiveResult), stamp, Number(targetId));
    run(`UPDATE agent_jobs SET status='CANCELLED',completed_at=?,lease_expires_at=NULL,result=?
      WHERE status='QUEUED' AND job_type IN ('PUBLISH','VERIFY_PUBLISH')
        AND CAST(json_extract(payload,'$.targetId') AS INTEGER)=?`, stamp, JSON.stringify({ message: '用户已确认平台侧人工发布，取消排队任务并禁止自动重投', handledBy, handledAt: stamp }), Number(targetId));
    const activeIssues = rows(`SELECT id FROM issues WHERE related_type='PUBLISH_TARGET' AND related_id=? AND status IN ('OPEN','DIAGNOSING','DIAGNOSED','RETRYING')`, String(targetId));
    for (const activeIssue of activeIssues) {
      run(`UPDATE issues SET status='RESOLVED',resolution_type='MANUAL_HANDLED',resolution=?,assignee=?,resolved_by=?,resolved_at=?,updated_at=? WHERE id=?`, message, handledBy, handledBy, stamp, stamp, activeIssue.id);
      releaseIssueBlocks(activeIssue.id, { releasedBy: handledBy, reason: message });
      run("UPDATE agent_jobs SET status='CANCELLED',completed_at=?,result=? WHERE job_type='DIAGNOSE_ISSUE' AND status='QUEUED' AND CAST(json_extract(payload,'$.issueId') AS INTEGER)=?", stamp, JSON.stringify({ message: '发布问题已人工处理，取消排队中的只读诊断' }), activeIssue.id);
      run("UPDATE issue_diagnoses SET status='CANCELLED',error_message=?,completed_at=?,updated_at=? WHERE issue_id=? AND status='QUEUED'", '发布问题已人工处理', stamp, stamp, activeIssue.id);
    }
    updateTaskAggregate(target.task_id);
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    throw error;
  }
  return row('SELECT * FROM publish_targets WHERE id=?', Number(targetId));
}

function messageNoteCandidates(platformCode, accountId) {
  const publishedTargets = rows(`SELECT t.id AS taskId,t.title,t.material_path AS materialPath,
      pt.platform_post_id AS platformPostId,pt.platform_url AS platformUrl,
      COALESCE(pt.submitted_at,pt.reviewed_at,pt.updated_at) AS publishedAt,
      NULL AS opaqueKey,'PUBLISH_TARGET' AS candidateSource
    FROM publish_targets pt JOIN publish_tasks t ON t.id=pt.task_id
    WHERE pt.platform_code=? AND pt.account_id=?
      AND pt.submission_status='SUBMITTED'
      AND pt.status NOT IN ('FAILED','REJECTED')
    ORDER BY COALESCE(pt.submitted_at,pt.reviewed_at,pt.updated_at) DESC, pt.id DESC`, platformCode, Number(accountId));
  const inventoryItems = rows(`SELECT NULL AS taskId,COALESCE(title,description) AS title,NULL AS materialPath,
      platform_post_id AS platformPostId,NULL AS platformUrl,published_at_raw AS publishedAt,
      opaque_key AS opaqueKey,'PLATFORM_INVENTORY' AS candidateSource
    FROM platform_content_inventory
    WHERE platform_code=? AND platform_account_key=? AND deleted_at IS NULL
    ORDER BY last_seen_at DESC,id DESC`, platformCode, String(accountId));
  return [...inventoryItems, ...publishedTargets];
}

function getBilibiliCollectionWatermarks(accountId) {
  const id = Number(accountId);
  if (!Number.isInteger(id) || id <= 0) return {};
  const result = {};
  for (const item of rows(`SELECT scope,cursor_json
      FROM platform_collection_cursors
      WHERE platform_code='bilibili' AND account_id=?`, id)) {
    const scope = String(item.scope || '').toUpperCase();
    if (!['COMMENT', 'PRIVATE_MESSAGE'].includes(scope)) continue;
    const cursor = json(item.cursor_json, {});
    if (cursor && typeof cursor === 'object') result[scope] = cursor;
  }
  return result;
}

function positiveCursorNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function normalizeBilibiliCursor(scope, value) {
  if (scope === 'COMMENT') {
    const notificationIds = Array.isArray(value?.notificationIds)
      ? [...new Set(value.notificationIds.map(item => String(item || '').trim()).filter(Boolean))].slice(-100)
      : [];
    return notificationIds.length ? { notificationIds } : null;
  }
  if (scope === 'PRIVATE_MESSAGE') {
    const sessions = {};
    for (const [talkerId, item] of Object.entries(value?.sessions || {})) {
      if (!/^[1-9]\d*$/.test(String(talkerId))) continue;
      const seqno = positiveCursorNumber(item?.seqno);
      const msgKey = positiveCursorNumber(item?.msgKey);
      const timestamp = positiveCursorNumber(item?.timestamp);
      if (seqno === null && msgKey === null && timestamp === null) continue;
      sessions[String(talkerId)] = { talkerId: String(talkerId), seqno, msgKey, timestamp };
    }
    return Object.keys(sessions).length ? { sessions } : null;
  }
  return null;
}

function mergeBilibiliCursor(scope, previous, incoming) {
  if (scope === 'COMMENT') {
    const ids = [...new Set([
      ...(Array.isArray(previous?.notificationIds) ? previous.notificationIds : []),
      ...(Array.isArray(incoming?.notificationIds) ? incoming.notificationIds : [])
    ].map(item => String(item || '').trim()).filter(Boolean))].slice(-100);
    return ids.length ? { notificationIds: ids } : null;
  }
  if (scope === 'PRIVATE_MESSAGE') {
    const sessions = { ...(previous?.sessions || {}) };
    for (const [talkerId, item] of Object.entries(incoming?.sessions || {})) {
      const prior = sessions[talkerId] || {};
      sessions[talkerId] = {
        talkerId,
        seqno: positiveCursorNumber(Math.max(Number(prior.seqno || 0), Number(item?.seqno || 0))) || null,
        msgKey: positiveCursorNumber(Math.max(Number(prior.msgKey || 0), Number(item?.msgKey || 0))) || null,
        timestamp: positiveCursorNumber(Math.max(Number(prior.timestamp || 0), Number(item?.timestamp || 0))) || null
      };
    }
    return Object.keys(sessions).length ? { sessions } : null;
  }
  return null;
}

function saveBilibiliCollectionWatermarks(accountId, collectionWatermarks, { successfulScopes = [], partialScopes = [], stamp = now() } = {}) {
  const id = Number(accountId);
  if (!Number.isInteger(id) || id <= 0 || !collectionWatermarks || typeof collectionWatermarks !== 'object') return { savedScopes: [], skippedScopes: [] };
  const successSet = new Set((Array.isArray(successfulScopes) ? successfulScopes : []).map(scope => String(scope).toUpperCase()));
  const partialSet = new Set((Array.isArray(partialScopes) ? partialScopes : []).map(scope => String(scope).toUpperCase()));
  const savedScopes = [];
  const skippedScopes = [];
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const scope of ['COMMENT', 'PRIVATE_MESSAGE']) {
      const incoming = normalizeBilibiliCursor(scope, collectionWatermarks[scope]);
      if (!incoming) {
        skippedScopes.push(scope);
        continue;
      }
      const current = row(`SELECT id,cursor_json,last_success_at,created_at
        FROM platform_collection_cursors
        WHERE platform_code='bilibili' AND account_id=? AND scope=?`, id, scope);
      const merged = mergeBilibiliCursor(scope, json(current?.cursor_json, {}), incoming);
      if (!merged) {
        skippedScopes.push(scope);
        continue;
      }
      const completed = successSet.has(scope) && !partialSet.has(scope);
      if (current) {
        run(`UPDATE platform_collection_cursors
          SET cursor_json=?,last_success_at=CASE WHEN ? THEN ? ELSE last_success_at END,updated_at=?
          WHERE id=?`, JSON.stringify(merged), completed ? 1 : 0, stamp, stamp, current.id);
      } else {
        run(`INSERT INTO platform_collection_cursors
          (platform_code,account_id,scope,cursor_json,last_success_at,created_at,updated_at)
          VALUES ('bilibili',?,?,?,?,?,?)`, id, scope, JSON.stringify(merged), completed ? stamp : null, stamp, stamp);
      }
      savedScopes.push(scope);
    }
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    throw error;
  }
  return { savedScopes, skippedScopes };
}

function getWeiboCollectionWatermarks(accountId) {
  const id = Number(accountId);
  if (!Number.isInteger(id) || id <= 0) return {};
  const result = {};
  for (const item of rows(`SELECT scope,cursor_json
      FROM platform_collection_cursors
      WHERE platform_code='weibo' AND account_id=?`, id)) {
    const scope = String(item.scope || '').toUpperCase();
    if (!['COMMENT', 'PRIVATE_MESSAGE'].includes(scope)) continue;
    const cursor = normalizeWeiboCursor(scope, json(item.cursor_json, {}));
    if (cursor) result[scope] = cursor;
  }
  return result;
}

function validCursorIso(value) {
  const parsed = Date.parse(String(value || '').trim());
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function newestCursorIso(...values) {
  const valid = values.map(validCursorIso).filter(Boolean);
  if (!valid.length) return null;
  return valid.sort((left, right) => Date.parse(right) - Date.parse(left))[0];
}

function normalizeWeiboStableIds(values, limit) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map(item => String(item || '').trim())
    .filter(item => /^\d{6,}$/.test(item)))].slice(-Math.max(1, Number(limit) || 1));
}

function normalizeWeiboCursor(scope, value) {
  if (!value || typeof value !== 'object') return null;
  if (scope === 'COMMENT') {
    const recentCommentIds = [...new Set((Array.isArray(value.recentCommentIds) ? value.recentCommentIds : [])
      .map(item => String(item || '').trim())
      .filter(item => /^\d{6,}$/.test(item)))].slice(0, 300);
    const lastFullSweepAt = validCursorIso(value.lastFullSweepAt);
    const lastSeenEventTimeMs = positiveCursorNumber(value.lastSeenEventTimeMs);
    return recentCommentIds.length || lastFullSweepAt || lastSeenEventTimeMs
      ? { recentCommentIds, lastFullSweepAt, lastSeenEventTimeMs }
      : null;
  }
  if (scope === 'PRIVATE_MESSAGE') {
    const sessions = {};
    for (const [rawKey, item] of Object.entries(value.sessions || {})) {
      if (!item || typeof item !== 'object') continue;
      const conversationKey = String(item.conversationKey || rawKey || '').trim().slice(0, 300);
      if (!conversationKey) continue;
      const recentMessageIds = normalizeWeiboStableIds(item.recentMessageIds, 120);
      const lastMessageId = /^\d{6,}$/.test(String(item.lastMessageId || '').trim()) ? String(item.lastMessageId).trim() : null;
      const normalized = {
        conversationKey,
        userName: String(item.userName || '').trim().slice(0, 300) || null,
        lastMessageId,
        recentMessageIds,
        lastPreviewHash: String(item.lastPreviewHash || '').trim().slice(0, 128) || null,
        lastEventTimeMs: positiveCursorNumber(item.lastEventTimeMs),
        lastCheckedAt: validCursorIso(item.lastCheckedAt),
        initializedAt: validCursorIso(item.initializedAt),
        extractionIncomplete: item.extractionIncomplete === true
      };
      if (normalized.lastMessageId || normalized.recentMessageIds.length || normalized.lastPreviewHash || normalized.lastEventTimeMs || normalized.lastCheckedAt || normalized.initializedAt || normalized.extractionIncomplete) {
        sessions[conversationKey] = normalized;
      }
    }
    const lastFullSweepAt = validCursorIso(value.lastFullSweepAt);
    return Object.keys(sessions).length || lastFullSweepAt ? { sessions, lastFullSweepAt } : null;
  }
  return null;
}

function mergeWeiboCursor(scope, previous, incoming) {
  if (scope === 'COMMENT') {
    const previousIds = Array.isArray(previous?.recentCommentIds) ? previous.recentCommentIds : [];
    const incomingIds = Array.isArray(incoming?.recentCommentIds) ? incoming.recentCommentIds : [];
    const recentCommentIds = [...new Set([...incomingIds, ...previousIds]
      .map(item => String(item || '').trim())
      .filter(item => /^\d{6,}$/.test(item)))].slice(0, 300);
    return normalizeWeiboCursor(scope, {
      recentCommentIds,
      lastFullSweepAt: newestCursorIso(previous?.lastFullSweepAt, incoming?.lastFullSweepAt),
      lastSeenEventTimeMs: Math.max(Number(previous?.lastSeenEventTimeMs || 0), Number(incoming?.lastSeenEventTimeMs || 0)) || null
    });
  }
  if (scope === 'PRIVATE_MESSAGE') {
    const sessions = { ...(previous?.sessions || {}) };
    for (const [conversationKey, item] of Object.entries(incoming?.sessions || {})) {
      const prior = sessions[conversationKey] || {};
      sessions[conversationKey] = {
        conversationKey,
        userName: item.userName || prior.userName || null,
        lastMessageId: item.lastMessageId || prior.lastMessageId || null,
        recentMessageIds: normalizeWeiboStableIds([...(prior.recentMessageIds || []), ...(item.recentMessageIds || [])], 120),
        lastPreviewHash: item.lastPreviewHash || prior.lastPreviewHash || null,
        lastEventTimeMs: Math.max(Number(prior.lastEventTimeMs || 0), Number(item.lastEventTimeMs || 0)) || null,
        lastCheckedAt: newestCursorIso(prior.lastCheckedAt, item.lastCheckedAt),
        initializedAt: validCursorIso(prior.initializedAt) || validCursorIso(item.initializedAt),
        extractionIncomplete: item.extractionIncomplete === true
      };
    }
    return normalizeWeiboCursor(scope, {
      sessions,
      lastFullSweepAt: newestCursorIso(previous?.lastFullSweepAt, incoming?.lastFullSweepAt)
    });
  }
  return null;
}

function saveWeiboCollectionWatermarks(accountId, collectionWatermarks, { successfulScopes = [], partialScopes = [], stamp = now() } = {}) {
  const id = Number(accountId);
  if (!Number.isInteger(id) || id <= 0 || !collectionWatermarks || typeof collectionWatermarks !== 'object') return { savedScopes: [], skippedScopes: [] };
  const successSet = new Set((Array.isArray(successfulScopes) ? successfulScopes : []).map(scope => String(scope).toUpperCase()));
  const partialSet = new Set((Array.isArray(partialScopes) ? partialScopes : []).map(scope => String(scope).toUpperCase()));
  const savedScopes = [];
  const skippedScopes = [];
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const scope of ['COMMENT', 'PRIVATE_MESSAGE']) {
      const incoming = normalizeWeiboCursor(scope, collectionWatermarks[scope]);
      if (!incoming) {
        skippedScopes.push(scope);
        continue;
      }
      const current = row(`SELECT id,cursor_json,last_success_at,created_at
        FROM platform_collection_cursors
        WHERE platform_code='weibo' AND account_id=? AND scope=?`, id, scope);
      const merged = mergeWeiboCursor(scope, normalizeWeiboCursor(scope, json(current?.cursor_json, {})), incoming);
      if (!merged) {
        skippedScopes.push(scope);
        continue;
      }
      const completed = successSet.has(scope) && !partialSet.has(scope);
      if (current) {
        run(`UPDATE platform_collection_cursors
          SET cursor_json=?,last_success_at=CASE WHEN ? THEN ? ELSE last_success_at END,updated_at=?
          WHERE id=?`, JSON.stringify(merged), completed ? 1 : 0, stamp, stamp, current.id);
      } else {
        run(`INSERT INTO platform_collection_cursors
          (platform_code,account_id,scope,cursor_json,last_success_at,created_at,updated_at)
          VALUES ('weibo',?,?,?,?,?,?)`, id, scope, JSON.stringify(merged), completed ? stamp : null, stamp, stamp);
      }
      savedScopes.push(scope);
    }
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    throw error;
  }
  return { savedScopes, skippedScopes };
}

function collectionModeForPlatform(platformCode) {
  if (platformCode === 'bilibili') return 'SAFE_INCREMENTAL_OBSERVATION';
  if (platformCode === 'weibo') return 'WEIBO_SAFE_INCREMENTAL';
  return null;
}

function collectionWatermarksForPlatform(platformCode, accountId) {
  if (platformCode === 'bilibili') return getBilibiliCollectionWatermarks(accountId);
  if (platformCode === 'weibo') return getWeiboCollectionWatermarks(accountId);
  return null;
}

export function enqueueAutomaticMessageCollections() {
  if (!config.autoCollectEnabled || !operationsEnabled()) return [];
  const activeJobs = rows("SELECT payload FROM agent_jobs WHERE job_type='COLLECT_MESSAGES' AND status IN ('QUEUED','RUNNING')")
    .map(item => json(item.payload, {}));
  const accounts = rows(`SELECT a.id,a.platform_code,a.device_id,a.profile_name,a.platform_user_id
    FROM accounts a
    JOIN platforms p ON p.code=a.platform_code
    WHERE a.enabled=1 AND a.login_status='READY' AND COALESCE(p.desired_state,'RUNNING')='RUNNING'
      AND COALESCE(p.lifecycle_state,'ACTIVE')='ACTIVE'
      AND a.platform_code IN (${activePlatformPlaceholders})`, ...activePlatformCodes);
  const bucket = Math.floor(Date.now() / getMessageCollectionSettings().minMs);
  const created = [];
  for (const account of accounts) {
    const plans = buildCollectionChannelPlans({ platformCode: account.platform_code, requestedTypes: ['COMMENT', 'PRIVATE_MESSAGE'] });
    for (const plan of plans) {
      if (collectionPlanAlreadyActive(activeJobs, account.id, plan)) continue;
      const jobId = createJob(account.device_id, 'COLLECT_MESSAGES', {
        platformCode: account.platform_code,
        accountId: account.id,
        profileName: account.profile_name,
        platformUserId: account.platform_user_id || null,
        collectionMode: collectionModeForPlatform(account.platform_code),
        collectionWatermarks: collectionWatermarksForPlatform(account.platform_code, account.id),
        channelType: plan.channelType,
        queueLane: plan.queueLane,
        types: plan.types,
        ...(['douyin', 'xiaohongshu'].includes(account.platform_code) ? { noteCandidates: messageNoteCandidates(account.platform_code, account.id) } : {}),
        processedCommentStableIds: account.platform_code === 'douyin' ? handledDouyinCommentStableIds(account.id) : [],
        automatic: true
      }, { idempotencyKey: `auto-collect:${account.platform_code}:${account.id}:${bucket}${plan.idempotencySuffix}` });
      created.push(jobId);
      activeJobs.push({ accountId: account.id, channelType: plan.channelType, queueLane: plan.queueLane });
    }
  }
  return created;
}
export function enqueueConversationRecoveryJobs() {
  if (!config.autoCollectEnabled || !operationsEnabled()) return [];
  const pendingJobs = rows(`SELECT id,job_type,payload,status FROM agent_jobs WHERE status IN ('QUEUED','RUNNING')`)
    .map(item => ({ ...item, payload: json(item.payload, {}) }));
  if (hasIncrementalConversationWork(pendingJobs)) return [];
  const conversations = rows(`SELECT c.*,a.device_id,a.profile_name,a.platform_user_id,a.enabled AS account_enabled,p.desired_state,p.lifecycle_state
    FROM conversations c JOIN accounts a ON a.id=c.account_id JOIN platforms p ON p.code=c.platform_code
    WHERE c.message_type='PRIVATE_MESSAGE' AND COALESCE(c.handling_mode,'BOT_ACTIVE')='BOT_ACTIVE'
      AND a.enabled=1 AND a.login_status='READY' AND COALESCE(p.desired_state,'RUNNING')='RUNNING' AND COALESCE(p.lifecycle_state,'ACTIVE')='ACTIVE'
      AND a.platform_code IN (${activePlatformPlaceholders})
      AND c.last_message_at>=? ORDER BY COALESCE(c.last_recovery_scan_at,''),c.last_message_at DESC`, ...activePlatformCodes, new Date(Date.now() - 2 * 24 * 60 * 60_000).toISOString());
  const created = [];
  for (const group of buildRecoveryGroups(conversations, Date.now())) {
    const selected = group.conversations;
    const first = selected[0];
    const targets = recoveryTargets(selected);
    if (!first || !targets.length) continue;
    const alreadyActive = pendingJobs.some(job => isOldConversationRecoveryJob(job.job_type, job.payload) && Number(job.payload.accountId) === Number(first.account_id));
    if (alreadyActive) continue;
    const bucket = Math.floor(Date.now() / (30 * 60_000));
    const payload = {
      platformCode: first.platform_code, accountId: Number(first.account_id), profileName: first.profile_name, platformUserId: first.platform_user_id || null,
      recoveryScan: true, oldConversationScan: true, scanMode: 'OLD_CONVERSATIONS', collectionScope: 'CONVERSATION_RECOVERY',
      channelType: 'PRIVATE_MESSAGE', queueLane: 'PRIVATE_MESSAGE', types: ['PRIVATE_MESSAGE'],
      conversationId: targets[0].conversationId, conversationIds: targets.map(item => item.conversationId), recoveryTargets: targets, maxPrivateSessions: targets.length
    };
    created.push(createJob(first.device_id, 'COLLECT_MESSAGES', payload, { idempotencyKey: `recovery:${first.platform_code}:${first.account_id}:${bucket}` }));
  }
  return created;
}

function startConversationRecoverySchedule() {
  if (conversationRecoveryTimer || !config.autoCollectEnabled) return;
  conversationRecoveryTimer = setInterval(() => {
    try { enqueueConversationRecoveryJobs(); } catch (error) { console.error('[conversation recovery] scheduling failed:', error); }
  }, 30 * 60_000);
  conversationRecoveryTimer.unref();
}

function stopConversationRecoverySchedule() {
  if (conversationRecoveryTimer) clearInterval(conversationRecoveryTimer);
  conversationRecoveryTimer = null;
}

const contentLibrary = createContentLibrary(config);
let embeddedVideoStudio;
const videoStudioUpstreamUrl = process.env.VIDEO_STUDIO_UPSTREAM_URL || '';
const videoStudioSource = videoStudioUpstreamUrl ? createStudioOutputSource({ upstreamUrl: videoStudioUpstreamUrl }) : {
  async list({ actor }) { return (await getEmbeddedVideoStudio()).listOutputs({ actor }); },
  async open(item) {
    const output = await (await getEmbeddedVideoStudio()).resolveOutput(item.id);
    if (!output || output.sha256 !== item.sha256 || output.bytes !== item.bytes) {
      throw new ContentLibraryError(409, 'CONTENT_FILE_CHANGED', '成片在确认期间已改变，请刷新后重新确认');
    }
    return { stream: fs.createReadStream(output.absolutePath || output.filePath, { flags: fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW }), contentLength: output.bytes };
  },
};
const studioOutputLibrary = createStudioOutputLibrary({ library: contentLibrary, source: videoStudioSource });
async function getEmbeddedVideoStudio() {
  if (!embeddedVideoStudio) {
    const { createVideoStudio } = await import('../engines/video-studio/server.mjs');
    embeddedVideoStudio = createVideoStudio({
      stateDir: process.env.VIDEO_STUDIO_DATA_DIR || path.join(ROOT, 'runtime', 'video-studio'),
      automaticUrl: '/integrations/ai-signal/',
      publishingLibrary: studioOutputLibrary.publishingLibrary,
    });
  }
  return embeddedVideoStudio;
}
const proxyVideoStudio = createVideoStudioProxy({ upstreamUrl: videoStudioUpstreamUrl, authorize: requireAdminSession, allowedOrigins: config.allowedOrigins });
async function studioOutputsRequest(req, res, pathname, session) {
  if (!['/api/studio/outputs', '/api/studio/outputs/confirm'].includes(pathname)) return false;
  try {
    if (req.method === 'GET' && pathname === '/api/studio/outputs') { ok(res, await studioOutputLibrary.list({ actor: session.sub })); return true; }
    if (req.method === 'POST' && pathname === '/api/studio/outputs/confirm') {
      const input = await body(req);
      if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => key !== 'ids')) {
        fail(res, 400, '确认请求只接受成片 ids，不接受文件路径或来源地址', null, 'STUDIO_CONFIRM_INVALID'); return true;
      }
      ok(res, await studioOutputLibrary.confirmBatch(input.ids, session.sub)); return true;
    }
    fail(res, 405, '此成片接口不支持该请求方法', null, 'METHOD_NOT_ALLOWED'); return true;
  } catch (error) {
    if (!(error instanceof ContentLibraryError)) throw error;
    fail(res, error.statusCode, error.message, null, error.code); return true;
  }
}
async function videoStudioRequest(req, res) {
  const session = requireAdminSession(req, res);
  if (!session) return;
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const localPath = url.pathname.slice('/video-workbench'.length);
  if (await studioOutputsRequest(req, res, localPath, session)) return;
  if (videoStudioUpstreamUrl) return proxyVideoStudio(req, res, url);
  return (await getEmbeddedVideoStudio()).handle(req, res, { mountPath: '/video-workbench', actor: session.sub });
}
const proxyAiSignal = createAiSignalProxy({
  upstreamUrl: config.aiSignalStudioInternalUrl,
  authorize: requireAdminSession,
  allowedOrigins: config.allowedOrigins,
  maxBodyBytes: config.requestBodyMaxBytes,
});

async function api(req, res, url) {
  const { pathname } = url;
  if (pathname.startsWith('/api/model/v1/')) return handleModelGateway(req, res, {
    token: config.modelGatewayToken, getSettings: getAiSettings, recordUsage: recordAiCall,
    localEmbeddings: { url: config.ragBaseUrl + '/rag-admin-api/v1/embeddings', token: config.ragToken },
  });
  if (req.method === 'GET' && pathname === '/api/health') return ok(res, { service: 'cloud-web', time: now(), qwenMode: getAiSettingsSummary().mode });
  if (req.method === 'GET' && pathname === '/api/auth/session') {
    const session = adminSession(req);
    return ok(res, { authenticated: Boolean(session), username: session?.sub || null, authEnabled: config.authEnabled });
  }
  if (req.method === 'POST' && pathname === '/api/auth/login') {
    if (!config.authEnabled) return ok(res, { authenticated: true, username: config.adminUsername, authEnabled: false });
    const data = await body(req);
    if (!credentialsMatch(data.username, data.password, config.adminUsername, config.adminPassword)) return fail(res, 401, '用户名或密码错误', null, 'INVALID_CREDENTIALS');
    const token = createSessionToken({ username: config.adminUsername, secret: config.sessionSecret, ttlMs: config.sessionTtlMs });
    return send(res, 200, { ok: true, authenticated: true, username: config.adminUsername }, { 'Set-Cookie': sessionCookie(token, { ttlMs: config.sessionTtlMs, secure: config.sessionCookieSecure }) });
  }
  if (req.method === 'POST' && pathname === '/api/auth/logout') {
    revokeSessionFromRequest(req);
    return send(res, 200, { ok: true, authenticated: false }, { 'Set-Cookie': clearSessionCookie({ secure: config.sessionCookieSecure }) });
  }
  if (pathname.startsWith('/api/agent/')) {
    if (!requireAgentToken(req, res)) return;
  } else if (!requireAdminSession(req, res)) return;
  if (pathname === '/api/studio/outputs' || pathname === '/api/studio/outputs/confirm') {
    const session = requireAdminSession(req, res);
    if (!session) return;
    return await studioOutputsRequest(req, res, pathname, session);
  }
  if (req.method === 'GET' && pathname === '/api/integrations/ai-signal') {
    return ok(res, { data: await getAiSignalIntegration({ url: config.aiSignalStudioUrl, healthUrl: config.aiSignalStudioHealthUrl }) });
  }
  if (req.method === 'GET' && pathname === '/api/creative-workbench/status') return ok(res, await getCreativeWorkbenchStatus(config));
  if (pathname === '/api/content-library' || pathname.startsWith('/api/content-library/')) {
    try {
      if (req.method === 'GET' && pathname === '/api/content-library') return ok(res, await contentLibrary.list());
      if (req.method === 'POST' && pathname === '/api/content-library/receive') {
        try {
          const allowed = ['source', 'filename', 'title', 'artifactType'];
          if ([...url.searchParams.keys()].some(key => !allowed.includes(key) || url.searchParams.getAll(key).length !== 1)) {
            return fail(res, 400, '接收请求只接受 source、filename、title 和 artifactType，且不可重复', null, 'CONTENT_RECEIVE_INVALID');
          }
          if (String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase() !== 'application/octet-stream') {
            return fail(res, 415, '请以 application/octet-stream 上传媒体文件', null, 'CONTENT_RECEIVE_TYPE_REQUIRED');
          }
          const session = requireAdminSession(req, res);
          if (!session) return;
          return ok(res, await contentLibrary.receive(req, Object.fromEntries(url.searchParams), session.sub, { contentLength: req.headers['content-length'] }));
        } finally {
          if (!req.readableEnded && !req.destroyed) req.resume();
        }
      }
      if (req.method === 'POST' && pathname === '/api/content-library/sync') {
        const input = await body(req);
        if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length) return fail(res, 400, '同步请求不接受来源地址或文件路径', null, 'CONTENT_SYNC_INVALID');
        return ok(res, await contentLibrary.sync({ force: true }));
      }
      const media = pathname.match(/^\/api\/content-library\/([a-f0-9]{32})\/media$/);
      if (['GET', 'HEAD'].includes(req.method) && media) return await contentLibrary.streamMedia(req, res, media[1]);
      const draft = pathname.match(/^\/api\/content-library\/([a-f0-9]{32})\/publish-draft$/);
      if (req.method === 'GET' && draft) return ok(res, await contentLibrary.publishDraft(draft[1]));
      const admission = pathname.match(/^\/api\/content-library\/([a-f0-9]{32})\/admission$/);
      if (req.method === 'POST' && admission) {
        const input = await body(req);
        if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => key !== 'decision')) return fail(res, 400, '审核请求只接受 decision', null, 'CONTENT_ADMISSION_INVALID');
        const session = requireAdminSession(req, res);
        if (!session) return;
        return ok(res, await contentLibrary.setAdmission(admission[1], input.decision, session.sub));
      }
      return fail(res, 404, '成片库接口不存在', null, 'CONTENT_LIBRARY_NOT_FOUND');
    } catch (error) {
      if (res.headersSent) { if (!res.destroyed) res.destroy(); return; }
      if (error instanceof ContentLibraryError) return fail(res, error.statusCode, error.message, null, error.code);
      return fail(res, 503, '成片库暂时不可用，请稍后重试', null, 'CONTENT_LIBRARY_UNAVAILABLE');
    }
  }
  if (pathname.startsWith('/api/wechat/')) return proxyWechatAdmin(req, res, url);
  if (pathname.startsWith('/api/mini-program/')) {
    try {
      if (req.method === 'GET' && pathname === '/api/mini-program/status') return ok(res, { status: getMiniProgramStatus() });
      if (req.method === 'GET' && pathname === '/api/mini-program/conversations') {
        if (url.searchParams.getAll('status').length > 1 || url.searchParams.getAll('limit').length > 1) {
          throw new MiniProgramAdminError(400, 'MINI_PROGRAM_ADMIN_INVALID_INPUT', '小程序管理参数无效');
        }
        return ok(res, { conversations: listMiniProgramConversations({ status: url.searchParams.get('status') ?? 'ALL', limit: url.searchParams.get('limit') ?? 200 }) });
      }
      const messages = pathname.match(/^\/api\/mini-program\/conversations\/([^/]+)\/messages$/);
      if (req.method === 'GET' && messages) return ok(res, getMiniProgramConversationMessages(messages[1]));
      const handoff = pathname.match(/^\/api\/mini-program\/conversations\/([^/]+)\/handoff$/);
      const notification = pathname.match(/^\/api\/mini-program\/notifications\/([^/]+)\/retry$/);
      const callback = pathname.match(/^\/api\/mini-program\/callbacks\/([^/]+)\/retry$/);
      if (req.method === 'POST' && (handoff || notification || callback)) {
        const data = await body(req);
        const keys = data && typeof data === 'object' && !Array.isArray(data) ? Object.keys(data) : null;
        if (!keys || (handoff ? keys.length !== 1 || keys[0] !== 'idempotencyKey' : keys.length !== 0)) {
          throw new MiniProgramAdminError(400, 'MINI_PROGRAM_ADMIN_INVALID_INPUT', '小程序管理参数无效');
        }
        if (handoff) return ok(res, await handoffMiniProgramConversation({ conversationId: handoff[1], idempotencyKey: data.idempotencyKey }));
        if (notification) return ok(res, { notification: retryMiniProgramNotification({ notificationId: notification[1] }) });
        return ok(res, { callback: retryMiniProgramCallback({ callbackId: callback[1] }) });
      }
      return fail(res, 404, '接口不存在', null, 'MINI_PROGRAM_ADMIN_NOT_FOUND');
    } catch (error) {
      if (error instanceof MiniProgramAdminError) return fail(res, error.statusCode, error.message, null, error.code);
      if (['INVALID_JSON', 'JSON_CONTENT_TYPE_REQUIRED', 'REQUEST_BODY_TOO_LARGE'].includes(error.code)) {
        return fail(res, error.statusCode, '小程序管理请求格式无效', null, error.code);
      }
      return fail(res, 500, '小程序管理服务暂时不可用', null, 'MINI_PROGRAM_ADMIN_INTERNAL_ERROR');
    }
  }
  if (req.method === 'GET' && pathname === '/api/manual-handoffs') {
    return ok(res, {
      handoffs: listHandoffNotifications({ limit: Number(url.searchParams.get('limit') || 200) }),
      totalHandoffs: countHandoffNotifications()
    });
  }
  if (req.method === 'GET' && pathname === '/api/local-agent/health') {
    const health = await checkLocalAgentHealth();
    return ok(res, { localAgent: localAgentStatus(health) });
  }
  const proxiedAgentPath = localAgentProxyPath(pathname);
  if (proxiedAgentPath) {
    if (proxiedAgentPath.startsWith('/material-preview/')) return proxyLocalAgentMaterial(req, res, url, proxiedAgentPath);
    return proxyLocalAgentJson(req, res, url, proxiedAgentPath);
  }
  if (req.method === 'GET' && pathname === '/api/agent/settings/ai') {
    const settings = getAiSettings();
    return ok(res, { settings: { mode: settings.mode, apiKey: settings.apiKey, baseUrl: settings.baseUrl, model: settings.model, visionModel: settings.visionModel, asrModel: settings.asrModel, contentModel: settings.contentModel, imageContentModel: settings.imageContentModel, trafficPredictionModel: settings.trafficPredictionModel } });
  }
  if (req.method === 'POST' && pathname === '/api/agent/ai-usage') {
    const data = await body(req);
    return ok(res, { log: recordAiCall(data) });
  }
  if (req.method === 'GET' && pathname === '/api/bootstrap') {
    const stats = { queuedTasks: row(`SELECT COUNT(*) c FROM publish_tasks WHERE status IN ('QUEUED','EXECUTING','SUBMITTED','REVIEWING')`).c, openIssues: row("SELECT COUNT(*) c FROM issues WHERE status='OPEN'").c, autoReplies: countAiReplies(), manualRequired: row("SELECT COUNT(*) c FROM messages WHERE status IN ('MANUAL_REQUIRED','KNOWLEDGE_GAP')").c, handoffRecords: countHandoffNotifications(), aiUsageToday: aiUsageOverview({ days: 1 }).summary };
    const aiSettings = getAiSettingsSummary();
    const messageCollection = { ...getMessageCollectionSettings(), enabled: config.autoCollectEnabled, nextCollectionAt: nextAutomaticMessageCollectionAt };
    const localAgentHealth = await checkLocalAgentHealth();
    return ok(res, { platforms: getPlatformRuntime(), devices: rows('SELECT * FROM devices ORDER BY id'), accounts: getAccounts(), stats, localAgent: localAgentStatus(localAgentHealth), config: { qwenMode: aiSettings.mode, aiConfigured: aiSettings.configured, autoReplyThreshold: config.autoReplyThreshold, rpaMode: config.rpaMode, localAgentBaseUrl: '/api/local-agent', audioContentGenerationEnabled: config.audioContentGenerationEnabled, audioContentAutoTrigger: config.audioContentAutoTrigger, autoCollectEnabled: config.autoCollectEnabled, messageCollectMinIntervalMs: messageCollection.minMs, messageCollectMaxIntervalMs: messageCollection.maxMs, messageCollection, loginStatusPoll: { enabled: config.loginStatusPollEnabled, intervalMs: config.loginStatusPollIntervalMs, logoutConfirmations: config.loginStatusLogoutConfirmations, confirmDelayMs: config.loginStatusConfirmDelayMs }, masterSwitch: getMasterSwitch(), activePlatformCodes, plannedPlatformCodes: config.plannedPlatformCodes } });
  }
  if (req.method === 'GET' && pathname === '/api/operations-dashboard') {
    const rangeParam = url.searchParams.get('range') === '30d' ? 30 : 7;
    return ok(res, { dashboard: buildOperationsDashboard({ rangeDays: rangeParam, platformCode: url.searchParams.get('platform') }) });
  }
  if (req.method === 'GET' && pathname === '/api/material-knowledge-drafts') {
    return ok(res, { drafts: listMaterialKnowledgeDrafts({ includeImported: url.searchParams.get('includeImported') === 'true', limit: url.searchParams.get('limit') || 100 }) });
  }
  if (req.method === 'POST' && pathname === '/api/material-knowledge-drafts') {
    const data = await body(req);
    return send(res, 201, { ok: true, draft: saveMaterialKnowledgeDraft(data) });
  }
  const materialKnowledgeDraftImportMatch = pathname.match(/^\/api\/material-knowledge-drafts\/(\d+)\/import$/);
  if (req.method === 'POST' && materialKnowledgeDraftImportMatch) {
    requireRagAdminEnabled();
    const draftId = Number(materialKnowledgeDraftImportMatch[1]);
    const draft = markMaterialKnowledgeDraftImporting(draftId);
    if (!draft) throw httpError(404, 'KNOWLEDGE_DRAFT_NOT_FOUND', '知识草稿不存在');
    if (draft.status === 'IMPORTED') return ok(res, { draft, document: { documentId: draft.ragDocumentId, documentVersion: draft.ragDocumentVersion, status: 'IMPORTED' } });
    const safeTitle = String(draft.title || '视频知识内容').replace(/[\/:*?"<>|]+/g, '-').slice(0, 80) || '视频知识内容';
    try {
      const operatorId = adminSession(req)?.sub || 'admin';
      const result = requireRagAdminResult(await formalRagClient.uploadDocument({
        content: Buffer.from(draft.contentMarkdown, 'utf8'),
        filename: `AI知识草稿-${safeTitle}.md`,
        mimeType: 'text/markdown',
        metadata: { knowledgeBaseId: config.ragKnowledgeBaseId, uploadedBy: operatorId }
      }), '知识草稿加入 RAG 失败');
      const saved = markMaterialKnowledgeDraftImported(draftId, result);
      return send(res, 202, { ok: true, draft: saved, document: result });
    } catch (error) {
      markMaterialKnowledgeDraftFailed(draftId, error);
      throw error;
    }
  }
  const materialKnowledgeDraftRegenerateMatch = pathname.match(/^\/api\/material-knowledge-drafts\/(\d+)\/regenerate$/);
  if (req.method === 'POST' && materialKnowledgeDraftRegenerateMatch) {
    const draftId = Number(materialKnowledgeDraftRegenerateMatch[1]);
    const draft = getMaterialKnowledgeDraft(draftId);
    if (!draft) throw httpError(404, 'KNOWLEDGE_DRAFT_NOT_FOUND', '知识草稿不存在');
    if (!draft.materialPath) throw httpError(409, 'KNOWLEDGE_DRAFT_SOURCE_MISSING', '原视频路径未保存，无法重新生成；请回到内容发布页重新选择视频');
    await ensureLocalAgentAvailableForProxy();
    let response;
    try {
      response = await fetch(`http://127.0.0.1:${config.agentPort}/material-content-generation`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(config.agentToken ? { 'X-Agent-Token': config.agentToken } : {}) },
        body: JSON.stringify({ materialPath: draft.materialPath, materialSha256: draft.materialSha256, platformCodes: [], force: true, knowledgeOnly: true, generationNonce: crypto.randomUUID() }),
        signal: AbortSignal.timeout(120_000)
      });
    } catch (error) {
      throw httpError(502, 'LOCAL_AGENT_PROXY_FAILED', '本地服务连接失败，暂时无法重新生成知识草稿', error.message);
    }
    const data = await response.json().catch(() => null);
    if (!response.ok || !data?.generation || data.generation.status === 'FAILED' || !data.generation.knowledgeDraft) {
      const generationFailure = response.ok && data?.generation;
      const code = (generationFailure ? data.generation.code || data.generation.calls?.knowledge?.errorCode : data?.code) || 'KNOWLEDGE_REGENERATION_FAILED';
      const failureMessages = {
        KNOWLEDGE_ONLINE_REQUIRED: '请开启在线 AI 后重新生成视频知识草稿。',
        AI_KEY_MISSING: '请先在 AI 设置中配置 API Key，再重新生成知识草稿。',
        ASR_TRANSCRIPT_UNUSABLE: '视频音频未能识别出有效内容，请检查音轨后重试。',
        AI_AUDIO_TOTAL_TIMEOUT: '知识草稿生成超时，请重新生成或拆分视频后重试。'
      };
      const message = Object.hasOwn(failureMessages, code) ? failureMessages[code] : '知识草稿生成失败，请稍后重试；原草稿已保留。';
      throw httpError(generationFailure ? 422 : response.status >= 400 ? response.status : 502, code, message);
    }
    const saved = saveMaterialKnowledgeDraft({ ...data.generation.knowledgeDraft, materialPath: draft.materialPath, materialFilename: draft.materialFilename });
    return ok(res, { draft: saved });
  }
  const materialKnowledgeDraftMatch = pathname.match(/^\/api\/material-knowledge-drafts\/(\d+)$/);
  if (req.method === 'GET' && materialKnowledgeDraftMatch) {
    const draft = getMaterialKnowledgeDraft(Number(materialKnowledgeDraftMatch[1]));
    if (!draft) throw httpError(404, 'KNOWLEDGE_DRAFT_NOT_FOUND', '知识草稿不存在');
    return ok(res, { draft });
  }
  if (req.method === 'PUT' && materialKnowledgeDraftMatch) {
    const data = await body(req);
    const draft = updateMaterialKnowledgeDraft(Number(materialKnowledgeDraftMatch[1]), data);
    if (!draft) throw httpError(404, 'KNOWLEDGE_DRAFT_NOT_FOUND', '知识草稿不存在');
    return ok(res, { draft });
  }
  if (req.method === 'DELETE' && materialKnowledgeDraftMatch) {
    if (!deleteMaterialKnowledgeDraft(Number(materialKnowledgeDraftMatch[1]))) throw httpError(404, 'KNOWLEDGE_DRAFT_NOT_FOUND', '知识草稿不存在');
    return ok(res, { deleted: true });
  }
  if (req.method === 'GET' && pathname === '/api/rag/status') {
    if (!config.ragAdminEnabled || !formalRagClient.configured) {
      return ok(res, { rag: { enabled: config.ragAdminEnabled, configured: formalRagClient.configured, knowledgeBaseId: config.ragKnowledgeBaseId, status: 'DISABLED' } });
    }
    const result = requireRagAdminResult(await formalRagClient.systemStatus(), '读取 RAG 系统状态失败');
    return ok(res, { rag: { enabled: true, configured: true, knowledgeBaseId: config.ragKnowledgeBaseId, ...result } });
  }
  if (req.method === 'GET' && pathname === '/api/rag/documents') {
    requireRagAdminEnabled();
    const result = requireRagAdminResult(await formalRagClient.listDocuments({ knowledgeBaseId: config.ragKnowledgeBaseId }), '读取 RAG 文档失败');
    return ok(res, { documents: result.documents || [] });
  }
  if (req.method === 'POST' && pathname === '/api/rag/documents') {
    requireRagAdminEnabled();
    const data = await body(req, Math.ceil(config.ragUploadMaxBytes * 4 / 3) + 512 * 1024);
    const filename = String(data.filename || '').trim();
    if (!filename) throw httpError(400, 'RAG_FILENAME_REQUIRED', 'filename 不能为空');
    // Web 上传只接收文件本身，不接收客户端自定义标题、部门、来源、平台或分类元数据。
    // 服务端仅补充统一知识库 ID 和当前操作人，避免其他调用方重新形成知识范围或运营必填字段。
    const content = decodeRagUploadContent(data.contentBase64);
    const operatorId = adminSession(req)?.sub || 'admin';
    const result = requireRagAdminResult(await formalRagClient.uploadDocument({
      content,
      filename,
      mimeType: String(data.mimeType || 'application/octet-stream'),
      // 运营上传统一进入业务 RAG；忽略客户端传入的其他知识库 ID，避免再次形成平台库。
      metadata: { knowledgeBaseId: config.ragKnowledgeBaseId, uploadedBy: operatorId }
    }), '上传 RAG 文档失败');
    return send(res, 202, { ok: true, document: result });
  }
  const ragDocumentChunksMatch = pathname.match(/^\/api\/rag\/documents\/([^/]+)\/chunks$/);
  if (req.method === 'GET' && ragDocumentChunksMatch) {
    requireRagAdminEnabled();
    const result = requireRagAdminResult(await formalRagClient.getDocumentChunks({ documentId: decodeURIComponent(ragDocumentChunksMatch[1]), version: url.searchParams.get('version') || null }), '读取 RAG 文档内容失败');
    return ok(res, { documentId: result.documentId || decodeURIComponent(ragDocumentChunksMatch[1]), documentVersion: result.documentVersion || Number(url.searchParams.get('version')) || null, chunks: result.chunks || [] });
  }
  const ragDocumentMatch = pathname.match(/^\/api\/rag\/documents\/([^/]+)$/);
  if (req.method === 'GET' && ragDocumentMatch) {
    requireRagAdminEnabled();
    const result = requireRagAdminResult(await formalRagClient.getDocument({ documentId: decodeURIComponent(ragDocumentMatch[1]), version: url.searchParams.get('version') || null }), '读取 RAG 文档状态失败');
    return ok(res, { document: result });
  }
  if (req.method === 'DELETE' && ragDocumentMatch) {
    requireRagAdminEnabled();
    const result = requireRagAdminResult(await formalRagClient.deleteDocument({ documentId: decodeURIComponent(ragDocumentMatch[1]) }), '删除 RAG 文档失败');
    return ok(res, { document: result });
  }
  if (req.method === 'POST' && pathname === '/api/rag/releases') {
    requireRagAdminEnabled();
    const data = await body(req);
    if (!String(data.testSessionId || '').trim()) throw httpError(400, 'RAG_TEST_SESSION_REQUIRED', '发布前必须提供 testSessionId');
    const result = requireRagAdminResult(await formalRagClient.createRelease({
      knowledgeBaseId: config.ragKnowledgeBaseId,
      testSessionId: data.testSessionId,
      baseReleaseId: data.baseReleaseId || null,
      candidateDocuments: Array.isArray(data.candidateDocuments) ? data.candidateDocuments : [],
      publishedBy: adminSession(req)?.sub || 'admin',
      publishNote: String(data.publishNote || '')
    }), '创建 RAG 发布版本失败');
    return send(res, 202, { ok: true, release: result });
  }
  if (req.method === 'GET' && pathname === '/api/rag/releases') {
    requireRagAdminEnabled();
    const result = requireRagAdminResult(await formalRagClient.listReleases({ knowledgeBaseId: config.ragKnowledgeBaseId }), '读取 RAG 发布版本失败');
    return ok(res, { active: result.active || null, releases: result.releases || [] });
  }
  const ragRollbackMatch = pathname.match(/^\/api\/rag\/releases\/([^/]+)\/rollback$/);
  if (req.method === 'POST' && ragRollbackMatch) {
    requireRagAdminEnabled();
    const data = await body(req);
    const releaseId = decodeURIComponent(ragRollbackMatch[1]);
    const result = requireRagAdminResult(await formalRagClient.rollbackRelease({ releaseId, operatorId: adminSession(req)?.sub || 'admin', note: String(data.note || '') }), '回滚 RAG 发布版本失败');
    return ok(res, { release: result });
  }
  const ragReleaseMembersMatch = pathname.match(/^\/api\/rag\/releases\/([^/]+)\/members$/);
  if (req.method === 'GET' && ragReleaseMembersMatch) {
    requireRagAdminEnabled();
    const result = requireRagAdminResult(await formalRagClient.getReleaseMembers({ releaseId: decodeURIComponent(ragReleaseMembersMatch[1]) }), '读取 RAG 已应用文件失败');
    return ok(res, { releaseId: result.releaseId || decodeURIComponent(ragReleaseMembersMatch[1]), members: result.members || [] });
  }
  const ragReleaseDocumentsMatch = pathname.match(/^\/api\/rag\/releases\/([^/]+)\/documents$/);
  if (req.method === 'GET' && ragReleaseDocumentsMatch) {
    requireRagAdminEnabled();
    const releaseId = decodeURIComponent(ragReleaseDocumentsMatch[1]);
    const result = requireRagAdminResult(await formalRagClient.getReleaseMembers({ releaseId }), '读取 RAG 发布版本文档失败');
    const documentReferences = [];
    const seenDocuments = new Set();
    for (const member of result.members || []) {
      const documentId = String(member.documentId || member.document_id || '').trim();
      const documentVersion = Number(member.documentVersion || member.document_version) || null;
      if (!documentId || !documentVersion) continue;
      const key = `${documentId}:${documentVersion}`;
      if (seenDocuments.has(key)) continue;
      seenDocuments.add(key);
      documentReferences.push({ documentId, documentVersion });
    }
    const documents = await Promise.all(documentReferences.map(async reference => {
      const document = requireRagAdminResult(await formalRagClient.getDocument({ documentId: reference.documentId, version: reference.documentVersion }), '读取 RAG 发布版本文档信息失败');
      return {
        documentId: reference.documentId,
        documentVersion: reference.documentVersion,
        filename: String(document.filename || document.title || '知识文档'),
        uploadedAt: document.createdAt || document.created_at || document.versionCreatedAt || document.version_created_at || document.updatedAt || document.updated_at || null
      };
    }));
    return ok(res, { releaseId: result.releaseId || result.release_id || releaseId, documents });
  }
  const ragReleaseMatch = pathname.match(/^\/api\/rag\/releases\/([^/]+)$/);
  if (req.method === 'GET' && ragReleaseMatch) {
    requireRagAdminEnabled();
    const result = requireRagAdminResult(await formalRagClient.getRelease({ releaseId: decodeURIComponent(ragReleaseMatch[1]) }), '读取 RAG 发布版本失败');
    return ok(res, { release: result });
  }  if (req.method === 'GET' && pathname === '/api/xiaozhi/options') return ok(res, { options: await getXiaozhiOptions() });
  if (req.method === 'POST' && pathname === '/api/xiaozhi/sessions') {
    const data = await body(req);
    return ok(res, { session: createXiaozhiSession({ ...data, operatorId: adminSession(req)?.sub || 'admin' }) });
  }
  if (req.method === 'POST' && pathname === '/api/xiaozhi/chat') {
    const data = await body(req);
    return ok(res, await runXiaozhiChat({ ...data, operatorId: adminSession(req)?.sub || 'admin' }));
  }
  const xiaozhiAnswersMatch = pathname.match(/^\/api\/xiaozhi\/sessions\/([0-9a-f-]+)\/answers$/i);
  if (req.method === 'GET' && xiaozhiAnswersMatch) return ok(res, { answers: await getXiaozhiTestAnswers(xiaozhiAnswersMatch[1], adminSession(req)?.sub || 'admin') });
  const xiaozhiDecisionMatch = pathname.match(/^\/api\/xiaozhi\/sessions\/([0-9a-f-]+)\/answers\/([^/]+)\/decision$/i);
  if (req.method === 'PUT' && xiaozhiDecisionMatch) {
    const data = await body(req);
    const answer = await updateXiaozhiTestAnswerDecision({ sessionId: xiaozhiDecisionMatch[1], answerId: xiaozhiDecisionMatch[2], ...data, operatorId: adminSession(req)?.sub || 'admin' });
    return ok(res, { answer });
  }
  const xiaozhiHistoryMatch = pathname.match(/^\/api\/xiaozhi\/sessions\/([0-9a-f-]+)\/answers\/([^/]+)\/history$/i);
  if (req.method === 'GET' && xiaozhiHistoryMatch) return ok(res, { history: await getXiaozhiTestAnswerHistory(xiaozhiHistoryMatch[2], xiaozhiHistoryMatch[1], adminSession(req)?.sub || 'admin') });
  const xiaozhiSessionMatch = pathname.match(/^\/api\/xiaozhi\/sessions\/([0-9a-f-]+)$/i);
  if (req.method === 'DELETE' && xiaozhiSessionMatch) return ok(res, { deleted: deleteXiaozhiSession(xiaozhiSessionMatch[1], adminSession(req)?.sub || 'admin') });
  if (req.method === 'GET' && pathname === '/api/browser-control/summary') return ok(res, { browserControl: browserControlSummary() });
  if (req.method === 'GET' && pathname === '/api/browser-control/commands') {
    return ok(res, { commands: listBrowserCommands({ limit: url.searchParams.get('limit'), platformCode: url.searchParams.get('platformCode'), status: url.searchParams.get('status') }) });
  }
  if (req.method === 'POST' && pathname === '/api/browser-control/commands') {
    const data = await body(req);
    const created = createBrowserCommand(data, { createdBy: adminSession(req)?.sub || '\u8fd0\u8425\u5e2d\u4f4d' });
    return send(res, created.reused ? 200 : 201, { ok: true, ...created });
  }
  if (req.method === 'GET' && /^\/api\/browser-control\/commands\/\d+$/.test(pathname)) {
    const id = parseId(pathname, /^\/api\/browser-control\/commands\/(\d+)$/);
    const detail = getBrowserCommand(id);
    if (!detail) return fail(res, 404, '\u6d4f\u89c8\u5668\u547d\u4ee4\u4e0d\u5b58\u5728', null, 'BROWSER_COMMAND_NOT_FOUND');
    return ok(res, detail);
  }
  if (req.method === 'GET' && pathname === '/api/settings/operations') {
    return ok(res, { settings: getMasterSwitch() });
  }
  if (req.method === 'POST' && pathname === '/api/settings/operations') {
    const data = await body(req);
    try {
      if (typeof data.enabled !== 'boolean') return fail(res, 400, 'enabled \u5fc5\u987b\u662f\u5e03\u5c14\u503c');
      let agent = null;
      if (data.enabled && config.localAgentAutoStart) {
        try {
          agent = await ensureLocalAgentOnline();
        } catch (error) {
          return fail(res, 503, 'Local Agent \u542f\u52a8\u6216\u8fde\u63a5\u5931\u8d25\uff0c\u5168\u5c40\u8fd0\u884c\u672a\u5f00\u542f', error.message);
        }
      }
      const settings = saveMasterSwitch(data.enabled, data.updatedBy || '\u8fd0\u8425\u5e2d\u4f4d');
      if (settings.enabled) syncAutomaticMessageCollectionSchedule(); else stopAutomaticMessageCollectionSchedule();
      const agentControl = await refreshLocalAgentPlatformControl();
      let agentShutdown = null;
      if (!settings.enabled && config.localAgentAutoStart) {
        agentShutdown = await shutdownLocalAgent({ reason: 'MASTER_SWITCH_OFF' });
        if (agentShutdown.stopped) run("UPDATE devices SET status='OFFLINE' WHERE id=?", config.deviceId);
      }
      return ok(res, { settings, agent, agentControl, agentShutdown });
    } catch (error) {
      if (error.code === 'INVALID_MASTER_SWITCH') return fail(res, 400, error.message);
      throw error;
    }
  }
  if (req.method === 'GET' && pathname === '/api/agent/platform-runtime') {
    return ok(res, { platforms: getPlatformRuntime(), masterSwitch: getMasterSwitch() });
  }
  const smartReplyMatch = pathname.match(/^\/api\/platforms\/([a-z_]+)\/smart-reply$/);
  if (req.method === 'GET' && smartReplyMatch) {
    const platformCode = smartReplyMatch[1];
    if (!activePlatformCodes.includes(platformCode)) return fail(res, 404, '\u5e73\u53f0\u4e0d\u5b58\u5728');
    return ok(res, { smartReply: getPlatformSmartReply(platformCode), platform: platformRuntime(platformCode), masterSwitch: getMasterSwitch() });
  }
  if (req.method === 'POST' && smartReplyMatch) {
    const platformCode = smartReplyMatch[1];
    if (!activePlatformCodes.includes(platformCode)) return fail(res, 404, '\u5e73\u53f0\u4e0d\u5b58\u5728');
    const data = await body(req);
    if (typeof data.enabled !== 'boolean') return fail(res, 400, 'enabled \u5fc5\u987b\u662f\u5e03\u5c14\u503c');
    const smartReply = savePlatformSmartReply(platformCode, data.enabled, data.updatedBy || '\u8fd0\u8425\u5e2d\u4f4d');
    const agentControl = await refreshLocalAgentPlatformControl();
    return ok(res, {
      smartReply,
      platform: platformRuntime(platformCode),
      agentControl,
      message: data.enabled ? '\u667a\u80fd\u56de\u590d\u5df2\u5f00\u542f\uff1b\u4ec5\u5728\u5168\u5c40\u548c\u5e73\u53f0\u5747\u8fd0\u884c\u65f6\u751f\u6548' : '\u667a\u80fd\u56de\u590d\u5df2\u5173\u95ed\uff1b\u5df2\u6392\u961f\u56de\u590d\u4efb\u52a1\u4fdd\u7559\u7b49\u5f85\uff0c\u4e0d\u4f1a\u88ab\u9886\u53d6\u6216\u8c03\u7528\u9002\u914d\u5668'
    });
  }
  if (req.method === 'POST' && pathname === '/api/platforms/runtime/start-all') {
    const data = await body(req);
    let agent = null;
    if (operationsEnabled() && config.localAgentAutoStart) {
      try { agent = await ensureLocalAgentOnline(); }
      catch (error) { return fail(res, 503, 'Local Agent \u542f\u52a8\u6216\u8fde\u63a5\u5931\u8d25\uff0c\u5168\u90e8\u5e73\u53f0\u672a\u5f00\u542f', error.message); }
    }
    const stamp = now();
    const updatedBy = String(data.updatedBy || '\u8fd0\u8425\u5e2d\u4f4d');
    db.exec('BEGIN IMMEDIATE');
    try {
      run(`UPDATE accounts
        SET enabled=1,login_status='UNKNOWN',login_checked_at=NULL,
            login_message='\u8d26\u53f7\u5df2\u4e00\u952e\u542f\u7528\uff1b\u4ec5\u5728\u7528\u6237\u4e3b\u52a8\u6253\u5f00\u767b\u5f55\u9875\u540e\u5141\u8bb8\u767b\u5f55\u8f6e\u8be2',
            login_url=NULL,login_source=NULL,login_evidence=NULL
        WHERE platform_code IN (${activePlatformPlaceholders})`, ...activePlatformCodes);
      run(`UPDATE platforms SET desired_state='RUNNING',runtime_updated_at=?,runtime_updated_by=? WHERE code IN (${activePlatformPlaceholders})`, stamp, updatedBy, ...activePlatformCodes);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    const platforms = getPlatformRuntime();
    const accounts = getAccounts().filter(account => activePlatformCodes.includes(account.platform_code));
    const agentControl = await refreshLocalAgentPlatformControl();
    return ok(res, {
      accounts,
      platforms,
      agent,
      agentControl,
      message: '\u5df2\u542f\u7528\u4e94\u4e2a\u5e73\u53f0\u8d26\u53f7\u5e76\u5f00\u542f\u5e73\u53f0\uff1b\u767b\u5f55\u9875\u4ecd\u53ea\u80fd\u7531\u7528\u6237\u4e3b\u52a8\u64cd\u4f5c\u663e\u5f0f\u6253\u5f00'
    });
  }
  if (req.method === 'POST' && pathname === '/api/platforms/runtime/stop-all') {
    const data = await body(req);
    const stamp = now();
    db.exec('BEGIN IMMEDIATE');
    try {
      run(`UPDATE platforms SET desired_state='STOPPED',runtime_updated_at=?,runtime_updated_by=? WHERE code IN (${activePlatformPlaceholders})`, stamp, String(data.updatedBy || '\u8fd0\u8425\u5e2d\u4f4d'), ...activePlatformCodes);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    const platforms = getPlatformRuntime();
    const agentControl = await refreshLocalAgentPlatformControl();
    return ok(res, {
      platforms,
      agentControl,
      shutdown: {
        acceptingNewJobs: false,
        queuedJobsRemainWaiting: true,
        runningJobs: platforms.reduce((sum, item) => sum + Number(item.running_job_count || 0), 0),
        message: '\u5df2\u505c\u6b62\u6240\u6709\u5e73\u53f0\u9886\u53d6\u65b0\u4efb\u52a1\uff0c\u6392\u961f\u4efb\u52a1\u4fdd\u6301\u7b49\u5f85'
      }
    });
  }
  const platformRuntimeMatch = pathname.match(/^\/api\/platforms\/([a-z_]+)\/runtime$/);
  if (req.method === 'GET' && platformRuntimeMatch) {
    const platformCode = platformRuntimeMatch[1];
    if (!activePlatformCodes.includes(platformCode)) return fail(res, 404, '\u5e73\u53f0\u4e0d\u5b58\u5728');
    return ok(res, { platform: platformRuntime(platformCode), masterSwitch: getMasterSwitch() });
  }
  if (req.method === 'POST' && platformRuntimeMatch) {
    const platformCode = platformRuntimeMatch[1];
    if (!activePlatformCodes.includes(platformCode)) return fail(res, 404, '\u4efb\u52a1\u4e0d\u5b58\u5728');
    const data = await body(req);
    if (typeof data.enabled !== 'boolean') return fail(res, 400, 'enabled \u5fc5\u987b\u662f\u5e03\u5c14\u503c');
    if (data.enabled) {
      const enabledAccount = row('SELECT id FROM accounts WHERE platform_code=? AND enabled=1 ORDER BY id LIMIT 1', platformCode);
      if (!enabledAccount) return fail(res, 409, '请先显式启用平台账号，再开启平台；当前操作不会唤醒本地浏览器', { code: 'NO_ENABLED_ACCOUNT' }, 'NO_ENABLED_ACCOUNT');
    }
    let agent = null;
    if (data.enabled && operationsEnabled() && config.localAgentAutoStart) {
      try { agent = await ensureLocalAgentOnline(); }
      catch (error) { return fail(res, 503, 'Local Agent \u542f\u52a8\u6216\u8fde\u63a5\u5931\u8d25\uff0c\u5e73\u53f0\u672a\u5f00\u542f', error.message); }
    }
    const desiredState = data.enabled ? 'RUNNING' : 'STOPPED';
    const stamp = now();
    run('UPDATE platforms SET desired_state=?,runtime_updated_at=?,runtime_updated_by=? WHERE code=?', desiredState, stamp, String(data.updatedBy || '\u8fd0\u8425\u5e2d\u4f4d'), platformCode);
    const platform = platformRuntime(platformCode);
    const agentControl = await refreshLocalAgentPlatformControl();
    return ok(res, {
      platform,
      agent,
      agentControl,
      shutdown: data.enabled ? null : {
        acceptingNewJobs: false,
        queuedJobsRemainWaiting: true,
        runningJobs: platform?.running_job_count || 0,
        message: platform?.running_job_count ? '已停止领取新任务；本地执行端将协作中断，发布/回复若结果不确定会转人工核对且不自动重试' : '\u5df2\u505c\u6b62\u9886\u53d6\u65b0\u4efb\u52a1\uff0c\u6392\u961f\u4efb\u52a1\u4fdd\u6301\u7b49\u5f85'
      }
    });
  }
  if (req.method === 'GET' && pathname === '/api/smoke-tests') {
    const platformCode = String(url.searchParams.get('platformCode') || '').trim();
    const status = String(url.searchParams.get('status') || '').trim().toUpperCase();
    if (platformCode && !activePlatformCodes.includes(platformCode)) return fail(res, 400, 'Smoke Test 仅支持已正式接入的平台', null, 'SMOKE_PLATFORM_UNSUPPORTED');
    const page = Math.max(1, Number(url.searchParams.get('page')) || 1);
    const pageSize = Math.max(1, Math.min(100, Number(url.searchParams.get('pageSize')) || 30));
    const filters = []; const params = [];
    if (platformCode) { filters.push('r.platform_code=?'); params.push(platformCode); }
    if (status) { filters.push('r.status=?'); params.push(status); }
    const where = filters.length ? 'WHERE ' + filters.join(' AND ') : '';
    const total = Number(row(`SELECT COUNT(*) AS count FROM smoke_test_runs r ${where}`, ...params).count || 0);
    const items = rows(`SELECT r.*,b.snapshot_json AS baseline_snapshot_json,b.screenshot_paths_json AS baseline_screenshot_paths_json,b.fingerprint_hash AS baseline_fingerprint
      FROM smoke_test_runs r LEFT JOIN smoke_test_baselines b ON b.id=r.baseline_id ${where}
      ORDER BY r.id DESC LIMIT ? OFFSET ?`, ...params, pageSize, (page - 1) * pageSize).map(smokeRunView);
    const latest = activePlatformCodes.map(code => {
      const run = row(`SELECT r.*,b.snapshot_json AS baseline_snapshot_json,b.screenshot_paths_json AS baseline_screenshot_paths_json,b.fingerprint_hash AS baseline_fingerprint
        FROM smoke_test_runs r LEFT JOIN smoke_test_baselines b ON b.id=r.baseline_id WHERE r.platform_code=? ORDER BY r.id DESC LIMIT 1`, code);
      return { platform: platformRuntime(code), run: smokeRunView(run) };
    });
    return ok(res, { items, page, pageSize, total, latest });
  }
  if (req.method === 'POST' && (pathname === '/api/smoke-tests/run' || /^\/api\/smoke-tests\/\d+\/(review|retest)$/.test(pathname))) {
    return fail(res, 410, '页面巡检功能已下线，请在问题汇总中使用 AI 自检', null, 'SMOKE_TEST_REMOVED');
  }
  const smokeShotMatch = pathname.match(/^\/api\/smoke-tests\/(\d+)\/screenshot$/);
  if (req.method === 'GET' && smokeShotMatch) {
    const smokeRun = getSmokeRun(Number(smokeShotMatch[1])); if (!smokeRun) return fail(res, 404, 'Smoke Test 记录不存在');
    const kind = url.searchParams.get('kind') === 'baseline' ? 'baseline' : 'current';
    const pageKey = String(url.searchParams.get('pageKey') || '').trim();
    const snapshot = kind === 'baseline' ? smokeRun.baseline_snapshot : smokeRun.snapshot;
    const pageItem = snapshot?.pages?.find(item => item.key === pageKey) || snapshot?.pages?.[0];
    const candidate = pageItem?.screenshotPath;
    if (!candidate) return fail(res, 404, '截图不存在');
    const resolved = path.resolve(candidate); const root = path.resolve(config.smokeTestScreenshotDir) + path.sep;
    if (!resolved.startsWith(root) || !fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) return fail(res, 404, '截图路径无效或文件已丢失');
    return send(res, 200, fs.readFileSync(resolved), { 'Content-Type': 'image/png', 'Content-Disposition': 'inline' });
  }
  if (req.method === 'GET' && pathname === '/api/settings/ai') {
    const usage = aiUsageOverview({ days: url.searchParams.get('days') || 7 });
    return ok(res, { settings: getAiSettingsSummary(), ...usage, logs: listAiCallLogs(url.searchParams.get('limit')) });
  }
  if (req.method === 'POST' && pathname === '/api/settings/ai') {
    const data = await body(req);
    try { return ok(res, { settings: saveAiSettings(data, data.updatedBy || '运营席位') }); }
    catch (error) { if (error.code === 'INVALID_AI_SETTINGS') return fail(res, 400, error.message); throw error; }
  }
  if (req.method === 'POST' && pathname === '/api/settings/ai/test') {
    try { return ok(res, { result: await testAiConnection() }); }
    catch (error) { return fail(res, 502, 'AI 连接测试失败', error.message); }
  }
  if (req.method === 'POST' && pathname === '/api/settings/ai/clear-key') return ok(res, { settings: clearAiApiKey() });
  if (req.method === 'GET' && pathname === '/api/settings/message-collection') return ok(res, { settings: { ...getMessageCollectionSettings(), enabled: config.autoCollectEnabled, nextCollectionAt: nextAutomaticMessageCollectionAt } });
  if (req.method === 'POST' && pathname === '/api/settings/message-collection') {
    const data = await body(req);
    try {
      const settings = saveMessageCollectionSettings(data.interval, data.updatedBy || '运营席位');
      stopAutomaticMessageCollectionSchedule();
      syncAutomaticMessageCollectionSchedule();
      return ok(res, { settings: { ...settings, enabled: config.autoCollectEnabled, nextCollectionAt: nextAutomaticMessageCollectionAt } });
    } catch (error) { if (error.code === 'INVALID_MESSAGE_COLLECTION_INTERVAL') return fail(res, 400, error.message); throw error; }
  }
  if (req.method === 'GET' && pathname === '/api/settings/wecom') {
    return ok(res, {
      settings: getWecomSettingsSummary(),
      notifications: rows(`SELECT id,channel,type,title,content,status,created_at,sent_at,error_message
        FROM notifications WHERE channel='WECOM' ORDER BY id DESC LIMIT 50`)
    });
  }
  if (req.method === 'POST' && pathname === '/api/settings/wecom') {
    const data = await body(req);
    try {
      const settings = saveWecomWebhookUrl(data.webhookUrl, data.updatedBy || '技术部');
      return ok(res, { settings });
    } catch (error) {
      if (error.code === 'INVALID_WECOM_WEBHOOK') return fail(res, 400, error.message);
      throw error;
    }
  }
  if (req.method === 'POST' && pathname === '/api/settings/wecom/test') {
    const settings = getWecomSettingsSummary();
    if (!settings.configured) return fail(res, 409, '请先保存企业微信群机器人 Webhook');
    try {
      const notification = await notify({
        type: 'CONFIG_TEST',
        title: 'AI 数字员工运营平台测试通知',
        content: `企微机器人连接测试成功。发送时间：${new Date().toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' })}`
      });
      return ok(res, { notification });
    } catch (error) {
      return fail(res, 502, '企微测试消息发送失败', error.message);
    }
  }
  if (req.method === 'POST' && pathname === '/api/settings/wecom/clear') {
    return ok(res, { settings: clearWecomWebhookUrl() });
  }
  if (req.method === 'GET' && ['/api/accounts', '/api/agent/accounts'].includes(pathname)) return ok(res, { accounts: getAccounts() });
  const accountLoginStateMatch = pathname.match(/^\/api\/(?:agent\/)?accounts\/(\d+)\/login-state$/);
  if (req.method === 'POST' && accountLoginStateMatch) {
    const id = Number(accountLoginStateMatch[1]); const data = await body(req);
    if (!['READY','LOGIN','EXPIRED','VERIFY_REQUIRED','UNKNOWN','ERROR','UNAVAILABLE'].includes(data.state)) return fail(res, 400, '\u767b\u5f55\u72b6\u6001\u65e0\u6548');
    if (!data.checkedAt || Number.isNaN(Date.parse(data.checkedAt))) return fail(res, 400, '\u68c0\u67e5\u65f6\u95f4\u65e0\u6548');
    const previous = row(`SELECT a.*, p.name AS platform_name, d.name AS device_name
      FROM accounts a
      LEFT JOIN platforms p ON p.code=a.platform_code
      LEFT JOIN devices d ON d.id=a.device_id
      WHERE a.id=?`, id);
    if (!previous) return fail(res, 404, '\u5e73\u53f0\u8d26\u53f7\u4e0d\u5b58\u5728');
    if (previous.platform_code === MINI_PROGRAM_PLATFORM_CODE) return fail(res, 409, '小程序账号不使用浏览器登录状态', null, 'MINI_PROGRAM_DEDICATED_API_REQUIRED');
    const loginStatus = data.state === 'READY' ? 'READY' : data.state === 'LOGIN' || data.state === 'EXPIRED' ? 'EXPIRED' : data.state === 'VERIFY_REQUIRED' ? 'VERIFY_REQUIRED' : 'UNKNOWN';
    const confirmedExpired = previous.login_status === 'READY' && isConfirmedLoginExpired(data, config.loginStatusLogoutConfirmations);
    run(`UPDATE accounts SET login_status=?,login_checked_at=?,login_message=?,login_url=?,login_source='LOCAL_AGENT',login_evidence=? WHERE id=?`, loginStatus, data.checkedAt, String(data.message || ''), String(data.url || ''), JSON.stringify(data.evidence || []), id);
    let alert = null;
    if (loginStatus === 'READY') {
      reconcileRecoveredAccountLoginIssues(id, {
        resolvedBy: 'LOGIN_MONITOR',
        resolution: data.message ? `账号已恢复登录：${String(data.message).slice(0, 500)}` : '账号已重新确认登录正常'
      });
    }
    if (confirmedExpired) {
      issue({
        source: 'LOGIN_MONITOR',
        category: 'ACCOUNT_LOGIN',
        level: 'ERROR',
        title: `${previous.platform_name || previous.platform_code}\u767b\u5f55\u72b6\u6001\u5df2\u8fc7\u671f`,
        detail: `${previous.display_name || '\u5e73\u53f0\u8d26\u53f7'}\u8fde\u7eed ${Number(data.confirmedSamples || 0)} \u6b21\u68c0\u6d4b\u5230\u660e\u786e\u9000\u51fa\u8bc1\u636e\uff0c\u8bf7\u4eba\u5de5\u5904\u7406`,
        relatedType: 'ACCOUNT',
        relatedId: previous.id,
        retryable: false
      });
      try {
        alert = await notify(buildLoginExpiredNotification({ account: previous, data }));
      } catch (error) {
        console.error(`[Server] \u53d1\u9001\u767b\u5f55\u8fc7\u671f\u901a\u77e5\u5931\u8d25\uff1a${error.message}`);
        alert = { status: 'FAILED', error: error.message };
      }
    }
    return ok(res, { account: row('SELECT * FROM accounts WHERE id=?', id), alert });
  }
  const accountRuntimeMatch = pathname.match(/^\/api\/accounts\/(\d+)\/runtime$/);
  if (req.method === 'POST' && accountRuntimeMatch) {
    const id = Number(accountRuntimeMatch[1]);
    const data = await body(req);
    if (typeof data.enabled !== 'boolean') return fail(res, 400, 'enabled 必须是布尔值');
    const account = row(`SELECT a.*,p.desired_state,p.lifecycle_state,p.name AS platform_name
      FROM accounts a JOIN platforms p ON p.code=a.platform_code WHERE a.id=?`, id);
    if (!account || !activePlatformCodes.includes(account.platform_code)) return fail(res, 404, '平台账号不存在');
    const stamp = now();
    db.exec('BEGIN IMMEDIATE');
    try {
      if (data.enabled) {
        run(`UPDATE accounts SET enabled=1,login_status='UNKNOWN',login_checked_at=NULL,login_message='账号已启用；平台仍保持停止，需显式开启后才允许登录或任务执行',login_url=NULL,login_source=NULL,login_evidence=NULL WHERE id=?`, id);
        run(`UPDATE platforms SET desired_state='STOPPED',runtime_updated_at=?,runtime_updated_by=? WHERE code=?`, stamp, String(data.updatedBy || '运营席位'), account.platform_code);
      } else {
        run(`UPDATE accounts SET enabled=0,login_status='DISABLED',login_checked_at=NULL,login_message='账号已停用，不会执行登录检查、采集或任务',login_url=NULL,login_source=NULL,login_evidence=NULL WHERE id=?`, id);
        const remaining = Number(row('SELECT COUNT(*) AS count FROM accounts WHERE platform_code=? AND enabled=1', account.platform_code).count || 0);
        if (!remaining) run(`UPDATE platforms SET desired_state='STOPPED',runtime_updated_at=?,runtime_updated_by=? WHERE code=?`, stamp, String(data.updatedBy || '运营席位'), account.platform_code);
      }
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    const agentControl = data.enabled ? { notified: false, reason: 'ACCOUNT_ENABLE_DOES_NOT_WAKE_AGENT' } : await refreshLocalAgentPlatformControl();
    return ok(res, {
      account: getAccounts().find(item => Number(item.id) === id) || null,
      platform: platformRuntime(account.platform_code),
      agentControl,
      message: data.enabled
        ? '账号已启用，平台仍保持停止；请再显式开启平台后进行登录或执行任务'
        : '账号已停用；若无其他启用账号，平台已停止并通知本地执行端关闭浏览器上下文'
    });
  }
  if (req.method === 'GET' && /^\/api\/jobs\/\d+$/.test(pathname)) {
    const id = parseId(pathname, /^\/api\/jobs\/(\d+)$/);
    const job = row('SELECT id,job_type,status,result,channel_type,queue_lane,created_at,available_at,claimed_at,completed_at,attempts FROM agent_jobs WHERE id=?', id);
    if (!job) return fail(res, 404, '任务不存在');
    return ok(res, { job: { ...job, result: json(job.result, null) } });
  }
  if (req.method === 'PATCH' && /^\/api\/accounts\/\d+$/.test(pathname)) {
    const id = parseId(pathname, /^\/api\/accounts\/(\d+)$/); const data = await body(req);
    if (!['UNKNOWN', 'DISABLED'].includes(data.loginStatus)) return fail(res, 400, '\u767b\u5f55\u72b6\u6001\u53ea\u80fd\u7531 Local Agent \u5b9e\u9645\u68c0\u67e5\u540e\u66f4\u65b0');
    run(`UPDATE accounts SET login_status=?,login_checked_at=NULL,login_message=NULL,login_url=NULL,login_source=NULL,login_evidence=NULL WHERE id=?`, data.loginStatus, id);
    return ok(res, { account: row('SELECT * FROM accounts WHERE id=?', id) });
  }
  if (req.method === 'POST' && pathname === '/api/compliance/review') { const data = await body(req); return ok(res, { review: reviewPublishContent(data) }); }
  if (req.method === 'GET' && pathname === '/api/tasks') {
    const platformCode = String(url.searchParams.get('platformCode') || '').trim();
    if (platformCode && !activePlatformCodes.includes(platformCode)) return fail(res, 400, '发布平台不存在');
    const platformCounts = getTaskPlatformCounts();
    return ok(res, {
      tasks: getTasks(platformCode || null),
      platformCounts,
      total: Number(row('SELECT COUNT(*) AS c FROM publish_tasks').c || 0),
      selectedPlatform: platformCode || 'ALL'
    });
  }
  if (req.method === 'GET' && /^\/api\/tasks\/\d+$/.test(pathname)) {
    const taskId = parseId(pathname, /^\/api\/tasks\/(\d+)$/);
    const task = getTask(taskId);
    if (!task) return fail(res, 404, '发布任务不存在');
    return ok(res, { task });
  }
  if (req.method === 'DELETE' && /^\/api\/tasks\/\d+$/.test(pathname)) {
    const taskId = parseId(pathname, /^\/api\/tasks\/(\d+)$/);
    const result = deletePublishTask(taskId);
    if (result.notFound) return fail(res, 404, '发布任务不存在', null, 'TASK_NOT_FOUND');
    if (result.blocked) return fail(res, 409, '任务正在执行，不能删除。请等待执行结束后再删除，避免平台操作与管理记录失去对应关系。', { runningJobIds: result.runningJobIds }, 'TASK_DELETE_RUNNING');
    return ok(res, { deleted: { id: result.task.id, title: result.task.title, status: result.task.status, targets: result.targetCount, cancelledJobs: result.cancelledJobs } });
  }
  if (req.method === 'GET' && pathname === '/api/publish/history') return ok(res, getPublishHistory(url.searchParams.get('page'), url.searchParams.get('pageSize')));
  if (req.method === 'GET' && pathname === '/api/publish/schedules') return ok(res, listScheduledPublishes(url.searchParams.get('limit')));
  if (req.method === 'POST' && pathname === '/api/publish/schedules') {
    if (!requireOperationsEnabled(res)) return;
    const data = await body(req);
    try {
      const scheduleTime = validateScheduledLocalTime(data);
      const prepared = preparePublishRequest(data, { checkDuplicate: false });
      const scheduleKey = hashString(`scheduled:${scheduleTime.scheduledAt}:${prepared.idempotencyKey}`);
      const duplicate = row('SELECT id,status,scheduled_at FROM scheduled_publish_tasks WHERE schedule_key=?', scheduleKey);
      if (duplicate) return fail(res, 409, `相同内容、平台和时间的定时任务 #${duplicate.id} 已存在`, { existingScheduleId: duplicate.id, status: duplicate.status }, 'SCHEDULE_DUPLICATE');
      const stamp = now();
      const storedPayload = { ...prepared.data, materialMeta: prepared.effectiveMaterialMeta, aiReview: prepared.compliance, complianceConfirmed: prepared.data.complianceConfirmed === true, publishMode: prepared.publishMode, managementConfirmed: prepared.data.managementConfirmed === true };
      const scheduleId = Number(run(`INSERT INTO scheduled_publish_tasks(schedule_key,scheduled_at,scheduled_local_text,timezone_offset_minutes,status,title,target_count,payload,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`, scheduleKey, scheduleTime.scheduledAt, scheduleTime.scheduledLocalText, scheduleTime.timezoneOffsetMinutes, 'PENDING', prepared.title, prepared.verified.length, JSON.stringify(storedPayload), String(data.createdBy || '运营席位'), stamp, stamp).lastInsertRowid);
      const schedule = scheduledPublishView(row('SELECT * FROM scheduled_publish_tasks WHERE id=?', scheduleId));
      return send(res, 201, { ok: true, schedule, computerTime: stamp });
    } catch (error) {
      return fail(res, Number(error.statusCode) || 500, Number(error.statusCode) ? error.message : '创建定时发布任务失败', error.detail || null, error.code || 'SCHEDULE_CREATE_FAILED');
    }
  }
  if (req.method === 'POST' && /^\/api\/publish\/schedules\/\d+\/cancel$/.test(pathname)) {
    const id = parseId(pathname, /^\/api\/publish\/schedules\/(\d+)\/cancel$/);
    const stamp = now();
    const changed = run(`UPDATE scheduled_publish_tasks SET status='CANCELLED',completed_at=?,updated_at=?,error_code=NULL,error_message=NULL WHERE id=? AND status='PENDING'`, stamp, stamp, id);
    if (!changed.changes) {
      const schedule = row('SELECT id,status FROM scheduled_publish_tasks WHERE id=?', id);
      if (!schedule) return fail(res, 404, '定时发布任务不存在');
      return fail(res, 409, '只有待执行的定时任务可以取消', { status: schedule.status });
    }
    return ok(res, { schedule: scheduledPublishView(row('SELECT * FROM scheduled_publish_tasks WHERE id=?', id)) });
  }
  if (req.method === 'POST' && pathname === '/api/publish/tasks') {
    if (!requireOperationsEnabled(res)) return;
    const data = await body(req);
    try {
      const prepared = preparePublishRequest(data);
      const created = createPreparedPublishTask(prepared);
      return send(res, 201, { ok: true, task: created.task, compliance: created.compliance });
    } catch (error) {
      return fail(res, Number(error.statusCode) || 500, Number(error.statusCode) ? error.message : '创建发布任务失败', error.detail || null, error.code || 'PUBLISH_CREATE_FAILED');
    }
  }
  if (req.method === 'POST' && /^\/api\/publish\/targets\/\d+\/verify$/.test(pathname)) {
    if (!requireOperationsEnabled(res)) return;
    const id = parseId(pathname, /^\/api\/publish\/targets\/(\d+)\/verify$/);
    const target = row(`SELECT t.*,a.device_id,a.profile_name,pt.title,pt.body FROM publish_targets t JOIN accounts a ON a.id=t.account_id JOIN publish_tasks pt ON pt.id=t.task_id WHERE t.id=?`, id);
    if (!target) return fail(res, 404, '发布目标不存在');
    if (['PUBLISHED','REJECTED','CANCELLED'].includes(target.status) || ['PUBLISHED','REJECTED'].includes(target.review_status)) {
      return fail(res, 409, '该发布目标已进入终态，无需重新校验');
    }

    const stamp = now();
    const cancelledAutomaticJobs = cancelQueuedPublishVerificationJobs(id, { reason: 'MANUAL_REVERIFY_REQUESTED', automaticOnly: true });
    const running = row(`SELECT id,payload FROM agent_jobs
      WHERE job_type='VERIFY_PUBLISH' AND status='RUNNING'
        AND CAST(json_extract(payload,'$.targetId') AS INTEGER)=?
      ORDER BY id LIMIT 1`, id);
    if (running) {
      return ok(res, {
        jobId: Number(running.id),
        action: 'ALREADY_RUNNING',
        message: '平台状态正在核验，无需重复创建',
        cancelledAutomaticJobs,
        waitingForPlatform: false
      });
    }

    const queuedManual = row(`SELECT id,payload FROM agent_jobs
      WHERE job_type='VERIFY_PUBLISH' AND status='QUEUED'
        AND CAST(json_extract(payload,'$.targetId') AS INTEGER)=?
        AND (CAST(json_extract(payload,'$.manualRequested') AS INTEGER)=1 OR json_extract(payload,'$.verificationSource')='MANUAL')
      ORDER BY id LIMIT 1`, id);
    let jobId;
    let action;
    if (queuedManual) {
      run('UPDATE agent_jobs SET available_at=? WHERE id=?', stamp, queuedManual.id);
      jobId = Number(queuedManual.id);
      action = 'ALREADY_QUEUED';
    } else {
      jobId = createJob(target.device_id, 'VERIFY_PUBLISH', {
        taskId: target.task_id,
        targetId: target.id,
        platformCode: target.platform_code,
        accountId: target.account_id,
        profileName: target.profile_name,
        title: target.title,
        body: target.body || '',
        platformPostId: target.platform_post_id || null,
        platformUrl: target.platform_url || null,
        submittedAt: publishSubmittedTimestamp(target),
        submissionStatus: target.submission_status,
        submissionConfirmed: target.submission_status === 'SUBMITTED',
        reviewAttempt: 0,
        verificationPolicyId: publishVerificationPolicy(target.platform_code)?.verificationPolicyId || null,
        verificationSource: 'MANUAL',
        manualRequested: true,
        manualRequestedAt: stamp
      }, { idempotencyKey: `verify:target:${id}:manual:${Date.now()}`, availableAt: stamp });
      action = 'CREATED';
    }
    const blockingJob = row(`SELECT id,job_type FROM agent_jobs
      WHERE device_id=? AND status='RUNNING' AND id<>?
        AND COALESCE(json_extract(payload,'$.platformCode'),'')=?
      ORDER BY id LIMIT 1`, target.device_id, jobId, target.platform_code);
    return ok(res, {
      jobId,
      action,
      message: action === 'CREATED' ? '人工核验已立即排队' : '已有人工核验任务，已调整为立即执行',
      cancelledAutomaticJobs,
      waitingForPlatform: Boolean(blockingJob),
      blockingJobType: blockingJob?.job_type || null
    });
  }
  if (req.method === 'POST' && /^\/api\/publish\/targets\/\d+\/manual-published$/.test(pathname)) {
    const id = parseId(pathname, /^\/api\/publish\/targets\/(\d+)\/manual-published$/);
    const data = await body(req);
    const target = row('SELECT * FROM publish_targets WHERE id=?', id);
    if (!target) return fail(res, 404, '发布目标不存在');
    if (target.status === 'PUBLISHED' && target.publish_attempt_state === 'PUBLISHED') {
      const task = getTask(target.task_id);
      return ok(res, { target: task?.targets.find(item => Number(item.id) === Number(id)) || target, idempotent: true });
    }
    if (!['FAILED','NEEDS_CONFIRMATION','REVIEWING','SYNCING','SUBMITTED'].includes(target.status)) {
      return fail(res, 409, '当前状态不允许人工标记为已发布；请先确认自动发布流程已停止');
    }
    markPublishTargetManualPublished(id, data);
    const task = getTask(target.task_id);
    return ok(res, { target: task?.targets.find(item => Number(item.id) === Number(id)) || row('SELECT * FROM publish_targets WHERE id=?', id) });
  }
  if (req.method === 'POST' && /^\/api\/publish\/targets\/\d+\/review$/.test(pathname)) {
    const id = parseId(pathname, /^\/api\/publish\/targets\/(\d+)\/review$/); const data = await body(req); const target = row('SELECT * FROM publish_targets WHERE id=?', id); if (!target) return fail(res, 404, '发布目标不存在');
    const reviewStatus = String(data.reviewStatus || '').toUpperCase(); if (!['PUBLISHED','REVIEWING','REJECTED','UNKNOWN'].includes(reviewStatus)) return fail(res, 400, '审核状态无效');
    applyReviewResult({ taskId: target.task_id, targetId: id, platformCode: target.platform_code }, { reviewStatus, message: data.message || 'Web端人工确认', platformPostId: data.platformPostId, platformUrl: data.platformUrl }, reviewStatus === 'UNKNOWN' ? 'NEEDS_CONFIRMATION' : 'SUCCESS'); return ok(res);
  }
  if (req.method === 'GET' && pathname === '/api/messages/export') {
    const requestedCodes = [...new Set(String(url.searchParams.get('platforms') || '').split(',').map(value => value.trim()).filter(Boolean))];
    if (!requestedCodes.length) return fail(res, 400, '请至少选择一个需要导出的平台');
    const invalidCodes = requestedCodes.filter(code => !activePlatformCodes.includes(code));
    if (invalidCodes.length) return fail(res, 400, `包含不可导出的平台：${invalidCodes.join('、')}`);
    const exportItems = getMessageReplyExportItems(requestedCodes);
    if (!exportItems.length) return fail(res, 404, '所选平台暂无已完成的回复记录');
    const filename = messageReplyExportFilename();
    return send(res, 200, buildMessageReplyCsv(exportItems), {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="message-replies.csv"; filename*=UTF-8''${encodeURIComponent(filename)}`,
      'X-Export-Count': String(exportItems.length)
    });
  }
  const genericMessageMutation = pathname.match(/^\/api\/messages\/(\d+)(?:\/(handled|retry|manual-reply|detect-manual))?$/);
  if (genericMessageMutation && (req.method === 'DELETE' && !genericMessageMutation[2] || req.method === 'POST' && genericMessageMutation[2])) {
    const message = row('SELECT platform_code FROM messages WHERE id=?', Number(genericMessageMutation[1]));
    if (message?.platform_code === MINI_PROGRAM_PLATFORM_CODE) return fail(res, 409, '小程序消息请使用专用管理接口', null, 'MINI_PROGRAM_DEDICATED_API_REQUIRED');
  }
  if (req.method === 'DELETE' && /^\/api\/messages\/\d+$/.test(pathname)) {
    const id = parseId(pathname, /^\/api\/messages\/(\d+)$/);
    const data = await body(req);
    const session = adminSession(req);
    const result = softDeleteMessage(id, {
      deletedBy: data.deletedBy || session?.sub || '运营人员',
      deleteReason: data.reason || '运营人员从评论与私信列表中移除'
    });
    if (result.notFound) return fail(res, 404, '消息不存在');
    if (result.runningReplyJobId) return fail(res, 409, '该消息正在向平台发送回复，当前不能删除；请等待发送完成或转人工确认后再操作', { jobId: result.runningReplyJobId }, 'MESSAGE_DELETE_RUNNING');
    return ok(res, { deleted: true, alreadyDeleted: result.alreadyDeleted, cancelledJobs: result.cancelledJobs, processingClosed: result.processingClosed, message: result.message });
  }
  if (req.method === 'GET' && pathname === '/api/messages') return ok(res, { messages: getMessages(), channelRuntimeStates: getMessageChannelRuntimeStates(), replyLimits: PLATFORM_REPLY_LIMITS });
  if (req.method === 'POST' && pathname === '/api/messages/simulate') {
    if (!requireOperationsEnabled(res)) return;
    const data = await body(req); data.externalId ||= `mvp-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    try { const result = await upsertCollectedMessage(data, true); return send(res, result.created ? 201 : 200, { ok: true, ...result }); } catch (error) { return fail(res, 400, error.message, null, error.code === 'MINI_PROGRAM_SIGNED_ENDPOINT_REQUIRED' ? error.code : 'REQUEST_FAILED'); }
  }
  if (req.method === 'POST' && pathname === '/api/agent/messages/upsert') {
    const data = await body(req); const items = Array.isArray(data.messages) ? data.messages : [data]; const results = [];
    for (const item of items) { try { results.push(await upsertCollectedMessage(item, false)); } catch (error) { results.push({ created: false, error: error.message, externalId: item.externalId, ...(error.code === 'MINI_PROGRAM_SIGNED_ENDPOINT_REQUIRED' ? { code: error.code } : {}) }); } }
    return ok(res, { results });
  }
  if (req.method === 'POST' && /^\/api\/messages\/\d+\/handled$/.test(pathname)) {
    const id = parseId(pathname, /^\/api\/messages\/(\d+)\/handled$/); const data = await body(req); const message = row('SELECT * FROM messages WHERE id=?', id); if (!message) return fail(res, 404, '消息不存在');
    const stamp = now(); run(`UPDATE messages SET status='MANUAL_HANDLED',decision='MANUAL_HANDLED',handled_at=?,handled_by=?,handler_note=?,updated_at=? WHERE id=?`, stamp, data.handledBy || '人工', data.note || '', stamp, id);
    run(`UPDATE agent_jobs SET status='CANCELLED',completed_at=?,result=? WHERE id=? AND status IN ('QUEUED','RUNNING')`, stamp, JSON.stringify({ message: '人工已处理，禁止自动补发' }), message.reply_job_id || -1);
    syncMessageProcessingRegistry(id, stamp);
    return ok(res, { message: row('SELECT * FROM messages WHERE id=?', id) });
  }
  if (req.method === 'POST' && /^\/api\/messages\/\d+\/retry$/.test(pathname)) {
    if (!requireOperationsEnabled(res)) return;
    const id = parseId(pathname, /^\/api\/messages\/(\d+)\/retry$/); const message = row('SELECT * FROM messages WHERE id=?', id); if (!message) return fail(res, 404, '消息不存在');
    if (message.handled_at || terminalMessageStatuses.has(String(message.status || '').toUpperCase())) return fail(res, 409, '该消息已经处理完成或已被归并，不能自动重试');
    const activeIssues = rows(`SELECT * FROM issues WHERE related_type='MESSAGE' AND related_id=? AND status IN ('OPEN','DIAGNOSING','DIAGNOSED','RETRYING') ORDER BY id DESC`, String(id));
    const issueSafety = activeIssues.map(item => ({ item, safety: messageIssueRetrySafety(item, message) }));
    const unsafeIssue = issueSafety.find(entry => !entry.safety.allowed);
    if (unsafeIssue) return fail(res, 409, '该消息存在需要人工确认的活动问题，请先在“问题汇总”中选择“人工已处理”或“误判”后再操作', { issueId: unsafeIssue.item.id, reason: unsafeIssue.safety.reason }, 'ACTIVE_ISSUE_REQUIRES_MANUAL_RESOLUTION');
    const retrySafety = prepareSafeReplyRetry(message);
    if (!retrySafety.allowed) return fail(res, 409, retrySafety.message);
    const replyIssueWithoutSafeEvidence = issueSafety.find(entry => entry.safety.requiresReplyJobSafety && retrySafety.safePreSendFailure !== true);
    if (replyIssueWithoutSafeEvidence) return fail(res, 409, '上一回复任务缺少明确的“发送前失败”证据；为防止重复回复，请先人工核对并处理该问题', { issueId: replyIssueWithoutSafeEvidence.item.id }, 'ACTIVE_REPLY_ISSUE_REQUIRES_MANUAL_RESOLUTION');
    if (activeIssues.length) {
      const reason = retrySafety.safePreSendFailure
        ? '运营人员重新判断：上一回复任务已明确在发送前失败，允许安全重试'
        : '运营人员重新判断：模型处理阶段失败且未创建平台发送任务，允许重新决策';
      resolveMessageIssuesForOperatorRetry(activeIssues, reason);
    }
    run("UPDATE messages SET status='NEW',decision=NULL,reason=NULL,reply_job_id=NULL,updated_at=? WHERE id=?", now(), id); return ok(res, { message: await processMessageWithRegistry(id) });
  }
  if (req.method === 'POST' && /^\/api\/messages\/\d+\/manual-reply$/.test(pathname)) {
    const id = parseId(pathname, /^\/api\/messages\/(\d+)\/manual-reply$/); const data = await body(req);
    const message = row(`SELECT m.*,a.device_id,a.profile_name,a.platform_user_id FROM messages m JOIN accounts a ON a.id=m.account_id WHERE m.id=?`, id);
    if (!message) return fail(res, 404, '消息不存在');
    if (!requirePlatformOperationsEnabled(res, message.platform_code)) return;
    if (message.platform_code !== 'weibo') return fail(res, 409, '当前 Web 端直接人工回复仅对微博开放');
    if (message.handled_at || terminalMessageStatuses.has(message.status)) return fail(res, 409, '该消息已经处理完成');
    if (['REPLY_QUEUED','REPLY_RUNNING'].includes(message.status)) return fail(res, 409, '该消息已有回复任务执行中');
    const replyText = String(data.replyText || '').trim().normalize('NFC');
    if (!replyText) return fail(res, 400, '人工回复不能为空');
    const replyLength = validateReplyTextLength({ platformCode: message.platform_code, messageType: message.message_type, text: replyText });
    if (!replyLength.ok) return fail(res, 400, replyLength.message, { characterCount: replyLength.count, characterLimit: replyLength.limit });
    const messageContext = json(message.context_json, {});
    if (messageContext.simulated) return fail(res, 409, '模拟消息不能发送到真实平台');
    const sourceAssessment = assessStoredWeiboSource(message, messageContext);
    if (sourceAssessment?.isOfficial === true && sourceAssessment.confidence === 'HIGH') return fail(res, 409, '微博官方或系统会话已被排除，不允许回复');
    const precision = assessWeiboMessagePrecision({ platformCode: message.platform_code, messageType: message.message_type, context: messageContext });
    if (!precision.ok) return fail(res, 409, precision.message || '原消息定位信息不完整，无法安全回复');
    const handledBy = String(data.handledBy || '运营人员').trim().slice(0, 100) || '运营人员';
    const jobId = createJob(message.device_id, 'REPLY', {
      messageId: id, platformCode: message.platform_code, accountId: message.account_id, platformUserId: message.platform_user_id || null, profileName: message.profile_name,
      externalId: message.external_id, externalUrl: message.external_url, sourceContent: message.content,
      userName: message.user_name, messageType: message.message_type, messageContext, replyText, replyMode: 'MANUAL', handledBy
    }, { idempotencyKey: `manual-reply:${id}:${hashString(replyText)}:${Date.now()}` });
    run(`UPDATE messages SET status='REPLY_QUEUED',decision='MANUAL_REPLY',reply_text=?,reason=?,reply_job_id=?,updated_at=? WHERE id=?`, replyText, '运营人员已在 Web 端提交人工回复', jobId, now(), id);
    return ok(res, { jobId, message: row('SELECT * FROM messages WHERE id=?', id) });
  }
  if (req.method === 'POST' && /^\/api\/messages\/\d+\/detect-manual$/.test(pathname)) {
    if (!requireOperationsEnabled(res)) return;
    const id = parseId(pathname, /^\/api\/messages\/(\d+)\/detect-manual$/); const data = await body(req);
    const message = row(`SELECT m.*,a.device_id,a.profile_name,a.platform_user_id FROM messages m JOIN accounts a ON a.id=m.account_id WHERE m.id=?`, id);
    if (!message) return fail(res, 404, '消息不存在');
    if (message.handled_at || terminalMessageStatuses.has(message.status)) return fail(res, 409, '该消息已经处理完成');
    const expectedReply = String(data.expectedReply || '').trim();
    if (!expectedReply) return fail(res, 400, '请填写在原平台 App 中实际发送的回复内容');
    const messageContext = json(message.context_json, {});
    if (messageContext.simulated) return fail(res, 409, '模拟消息不能检测真实平台回复');
    const latestReplyJob = row(`SELECT * FROM agent_jobs WHERE job_type='REPLY'
      AND CAST(json_extract(payload,'$.messageId') AS INTEGER)=? ORDER BY id DESC LIMIT 1`, id);
    const latestReplyPayload = json(latestReplyJob?.payload, {});
    const latestReplyResult = json(latestReplyJob?.result, {});
    const confirmsUncertainAutoReply = Boolean(
      latestReplyJob
      && latestReplyPayload.replyMode !== 'MANUAL'
      && normalizeDetectedReplyText(latestReplyPayload.replyText) === normalizeDetectedReplyText(expectedReply)
      && latestReplyResult.sendAttempted === true
    );
    const jobId = createJob(message.device_id, 'DETECT_MANUAL_REPLY', {
      messageId: id, platformCode: message.platform_code, accountId: message.account_id, profileName: message.profile_name,
      externalId: message.external_id, externalUrl: message.external_url, sourceContent: message.content,
      userName: message.user_name, messageType: message.message_type, messageContext, expectedReply,
      detectionPurpose: confirmsUncertainAutoReply ? 'CONFIRM_UNCERTAIN_AUTO_REPLY' : 'CONFIRM_MANUAL_REPLY',
      sourceReplyJobId: latestReplyJob?.id || message.reply_job_id || null,
      replyJobIdAtCreation: message.reply_job_id || null,
      latestReplyJobIdAtCreation: latestReplyJob?.id || null,
      messageUpdatedAtAtCreation: message.updated_at || null
    }, { idempotencyKey: `detect-manual:${id}:${hashString(expectedReply)}:${hashString(message.updated_at || '')}` });
    return ok(res, { jobId });
  }
  const platformCollectMatch = pathname.match(/^\/api\/platforms\/([a-z_]+)\/collect$/);
  if (req.method === 'POST' && platformCollectMatch) {
    const platformCode = platformCollectMatch[1];
    if (!requirePlatformOperationsEnabled(res, platformCode)) return;
    const data = await body(req);
    const account = row('SELECT * FROM accounts WHERE platform_code=? AND id=? AND enabled=1', platformCode, Number(data.accountId));
    if (!account) return fail(res, 400, '平台账号不存在或账号与平台不匹配');
    const bucket = new Date().toISOString().slice(0,16);
    const plans = buildCollectionChannelPlans({ platformCode, requestedTypes: data.types || ['COMMENT','PRIVATE_MESSAGE'] });
    const jobIds = plans.map(plan => createJob(account.device_id, 'COLLECT_MESSAGES', {
      platformCode,
      accountId: account.id,
      profileName: account.profile_name,
      platformUserId: account.platform_user_id || null,
      collectionMode: collectionModeForPlatform(platformCode),
      collectionWatermarks: collectionWatermarksForPlatform(platformCode, account.id),
      channelType: plan.channelType,
      queueLane: plan.queueLane,
      types: plan.types,
      ...(['douyin', 'xiaohongshu'].includes(platformCode) ? { noteCandidates: messageNoteCandidates(platformCode, account.id) } : {}),
      processedCommentStableIds: platformCode === 'douyin' ? handledDouyinCommentStableIds(account.id) : []
    }, { idempotencyKey: `collect:${platformCode}:${account.id}:${bucket}${plan.idempotencySuffix}` }));
    return ok(res, { jobId: jobIds[0], jobIds });
  }
  if (req.method === 'POST' && pathname === '/api/xiaohongshu/collect') {
    if (!requirePlatformOperationsEnabled(res, 'xiaohongshu')) return;
    const data = await body(req); const account = row("SELECT * FROM accounts WHERE platform_code='xiaohongshu' AND id=? AND enabled=1", Number(data.accountId)); if (!account) return fail(res, 400, '小红书账号不存在');
    const bucket = new Date().toISOString().slice(0,16);
    const plans = buildCollectionChannelPlans({ platformCode: 'xiaohongshu', requestedTypes: data.types || ['COMMENT','PRIVATE_MESSAGE'] });
    const jobIds = plans.map(plan => createJob(account.device_id, 'COLLECT_MESSAGES', { platformCode: 'xiaohongshu', accountId: account.id, profileName: account.profile_name, channelType: plan.channelType, queueLane: plan.queueLane, types: plan.types, noteCandidates: messageNoteCandidates('xiaohongshu', account.id) }, { idempotencyKey: `collect:xhs:${account.id}:${bucket}${plan.idempotencySuffix}` }));
    return ok(res, { jobId: jobIds[0], jobIds });
  }
  if (req.method === 'GET' && pathname === '/api/knowledge/import/template') {
    const csv = knowledgeImportTemplateCsv();
    return send(res, 200, Buffer.from(csv, 'utf8'), {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="knowledge-import-template.csv"; filename*=UTF-8''${encodeURIComponent('知识库导入模板.csv')}`
    });
  }
  if (req.method === 'GET' && pathname === '/api/knowledge/imports') return ok(res, { imports: listKnowledgeImports() });
  if (req.method === 'POST' && pathname === '/api/knowledge/import/preview') {
    const data = await body(req, 12_000_000);
    const preview = await previewKnowledgeImport(data);
    const enrichment = queueKnowledgeImportMetadataEnrichment(preview.batchId);
    return ok(res, { ...preview, enrichment });
  }
  if (req.method === 'GET' && /^\/api\/knowledge\/import\/\d+$/.test(pathname)) {
    const batchId = parseId(pathname, /^\/api\/knowledge\/import\/(\d+)$/);
    const preview = getKnowledgeImportPreview(batchId);
    if (!preview) return fail(res, 404, '导入批次不存在');
    return ok(res, preview);
  }
  if (req.method === 'POST' && /^\/api\/knowledge\/import\/\d+\/enrich$/.test(pathname)) {
    const batchId = parseId(pathname, /^\/api\/knowledge\/import\/(\d+)\/enrich$/);
    const data = await body(req);
    try { return ok(res, { enrichment: queueKnowledgeImportMetadataEnrichment(batchId, { force: data.force === true }) }); }
    catch (error) { return fail(res, 409, error.message); }
  }
  if (req.method === 'POST' && pathname === '/api/knowledge/metadata-suggestions') {
    const data = await body(req);
    const platformCategory = knowledgeCategoryForPlatform(data.platformCode);
    const allowedCategories = Array.isArray(data.allowedCategories) && data.allowedCategories.length
      ? data.allowedCategories
      : platformCategory ? [PUBLIC_KNOWLEDGE_CATEGORY, platformCategory] : SYSTEM_KNOWLEDGE_CATEGORIES;
    try {
      return ok(res, { suggestion: await suggestKnowledgeMetadata({
        question: data.question,
        answer: data.answer,
        originalMessage: data.originalMessage || '',
        platformCode: data.platformCode || '',
        allowedCategories,
        preferredCategory: data.currentCategory || platformCategory || PUBLIC_KNOWLEDGE_CATEGORY,
        taskId: data.taskId || null
      }) });
    } catch (error) { return fail(res, 400, error.message); }
  }
  if (req.method === 'POST' && pathname === '/api/knowledge/import/commit') {
    const data = await body(req);
    const result = commitKnowledgeImport(data);
    for (const knowledgeId of result.knowledgeIds || []) queueKnowledgeAliasGeneration(knowledgeId, { requestedBy: data.importedBy || '知识导入' });
    return ok(res, result);
  }
  if (req.method === 'GET' && pathname === '/api/manual-handoff-phrases') {
    return ok(res, {
      phrases: rows(`SELECT p.*,
        (SELECT COUNT(*) FROM manual_handoff_phrase_aliases a WHERE a.phrase_id=p.id AND a.phrase_version=p.version) AS alias_count,
        (SELECT COUNT(*) FROM manual_handoff_phrase_aliases a WHERE a.phrase_id=p.id AND a.phrase_version=p.version AND a.status='ENABLED' AND a.validation_status='VALID') AS enabled_alias_count,
        (SELECT t.status FROM manual_handoff_alias_generation_tasks t WHERE t.phrase_id=p.id ORDER BY t.id DESC LIMIT 1) AS alias_task_status,
        (SELECT t.error_message FROM manual_handoff_alias_generation_tasks t WHERE t.phrase_id=p.id ORDER BY t.id DESC LIMIT 1) AS alias_task_error
        FROM manual_handoff_phrases p ORDER BY CASE p.status WHEN 'ENABLED' THEN 0 ELSE 1 END,p.id DESC`),
      builtinExamples: BUILTIN_MANUAL_HANDOFF_EXAMPLES,
      matchRule: '完整句匹配，忽略空格和常见标点；仅私信生效；AI 相似说法需人工勾选启用'
    });
  }
  if (req.method === 'POST' && pathname === '/api/manual-handoff-phrases') {
    const data = await body(req);
    let input;
    try { input = manualHandoffPhraseInput(data.phrase); }
    catch (error) { return fail(res, 400, error.message); }
    if (detectManualHandoffCommand(input.phrase).matched) return fail(res, 409, '该说法已由系统内置规则支持，无需重复添加');
    if (row('SELECT id FROM manual_handoff_phrases WHERE normalized_phrase=?', input.normalizedPhrase)) return fail(res, 409, '该转人工说法已经存在');
    const stamp = now();
    const operator = String(data.createdBy || '运营人员').trim() || '运营人员';
    const id = Number(run('INSERT INTO manual_handoff_phrases(phrase,normalized_phrase,status,version,created_by,updated_by,created_at,updated_at) VALUES(?,?,\'ENABLED\',1,?,?,?,?)', input.phrase, input.normalizedPhrase, operator, operator, stamp, stamp).lastInsertRowid);
    const generationTask = queueManualHandoffAliasGeneration(id, { requestedBy: operator });
    return send(res, 201, { ok: true, phrase: row('SELECT * FROM manual_handoff_phrases WHERE id=?', id), generationTask });
  }
  if (req.method === 'PUT' && /^\/api\/manual-handoff-phrases\/\d+$/.test(pathname)) {
    const id = parseId(pathname, /^\/api\/manual-handoff-phrases\/(\d+)$/);
    if (!row('SELECT id FROM manual_handoff_phrases WHERE id=?', id)) return fail(res, 404, '转人工说法不存在');
    const data = await body(req);
    let input;
    try { input = manualHandoffPhraseInput(data.phrase); }
    catch (error) { return fail(res, 400, error.message); }
    if (detectManualHandoffCommand(input.phrase).matched) return fail(res, 409, '该说法已由系统内置规则支持，无需重复保存');
    const duplicate = row('SELECT id FROM manual_handoff_phrases WHERE normalized_phrase=? AND id<>?', input.normalizedPhrase, id);
    if (duplicate) return fail(res, 409, '该转人工说法已经存在');
    const operator = String(data.updatedBy || '运营人员').trim() || '运营人员';
    run('UPDATE manual_handoff_phrases SET phrase=?,normalized_phrase=?,version=version+1,updated_by=?,updated_at=? WHERE id=?', input.phrase, input.normalizedPhrase, operator, now(), id);
    const generationTask = queueManualHandoffAliasGeneration(id, { requestedBy: operator, force: true });
    return ok(res, { phrase: row('SELECT * FROM manual_handoff_phrases WHERE id=?', id), generationTask });
  }
  if (req.method === 'POST' && /^\/api\/manual-handoff-phrases\/\d+\/(enable|disable)$/.test(pathname)) {
    const match = pathname.match(/^\/api\/manual-handoff-phrases\/(\d+)\/(enable|disable)$/);
    const id = Number(match[1]);
    if (!row('SELECT id FROM manual_handoff_phrases WHERE id=?', id)) return fail(res, 404, '转人工说法不存在');
    const data = await body(req);
    const status = match[2] === 'enable' ? 'ENABLED' : 'DISABLED';
    run('UPDATE manual_handoff_phrases SET status=?,updated_by=?,updated_at=? WHERE id=?', status, String(data.updatedBy || '运营人员').trim() || '运营人员', now(), id);
    return ok(res, { phrase: row('SELECT * FROM manual_handoff_phrases WHERE id=?', id) });
  }
  if (req.method === 'DELETE' && /^\/api\/manual-handoff-phrases\/\d+$/.test(pathname)) {
    const id = parseId(pathname, /^\/api\/manual-handoff-phrases\/(\d+)$/);
    const item = row('SELECT * FROM manual_handoff_phrases WHERE id=?', id);
    if (!item) return fail(res, 404, '转人工说法不存在');
    run('DELETE FROM manual_handoff_phrases WHERE id=?', id);
    return ok(res, { deleted: { id: item.id, phrase: item.phrase } });
  }
  if (req.method === 'GET' && /^\/api\/manual-handoff-phrases\/\d+\/aliases$/.test(pathname)) {
    const id = parseId(pathname, /^\/api\/manual-handoff-phrases\/(\d+)\/aliases$/);
    if (!row('SELECT id FROM manual_handoff_phrases WHERE id=?', id)) return fail(res, 404, '转人工说法不存在');
    return ok(res, { aliases: listManualHandoffAliases(id) });
  }
  if (req.method === 'GET' && pathname === '/api/manual-handoff-alias-generation-tasks') {
    return ok(res, { tasks: listManualHandoffAliasTasks(url.searchParams.get('limit') || 500) });
  }
  if (req.method === 'POST' && /^\/api\/manual-handoff-phrases\/\d+\/aliases\/regenerate$/.test(pathname)) {
    const id = parseId(pathname, /^\/api\/manual-handoff-phrases\/(\d+)\/aliases\/regenerate$/);
    if (!row('SELECT id FROM manual_handoff_phrases WHERE id=?', id)) return fail(res, 404, '转人工说法不存在');
    const data = await body(req);
    const task = queueManualHandoffAliasGeneration(id, { requestedBy: String(data.requestedBy || '运营人员').trim() || '运营人员', force: true });
    return send(res, 202, { ok: true, task });
  }
  if (req.method === 'POST' && /^\/api\/manual-handoff-phrases\/\d+\/aliases\/selections$/.test(pathname)) {
    const id = parseId(pathname, /^\/api\/manual-handoff-phrases\/(\d+)\/aliases\/selections$/);
    const data = await body(req);
    const selection = setManualHandoffAliasSelections(id, data.enabledIds || []);
    if (!selection) return fail(res, 404, '转人工说法不存在');
    return ok(res, { selection });
  }
  if (req.method === 'POST' && /^\/api\/manual-handoff-aliases\/\d+\/(enable|disable)$/.test(pathname)) {
    const match = pathname.match(/^\/api\/manual-handoff-aliases\/(\d+)\/(enable|disable)$/);
    try {
      const alias = setManualHandoffAliasStatus(Number(match[1]), match[2] === 'enable' ? 'ENABLED' : 'DISABLED');
      if (!alias) return fail(res, 404, '转人工相似说法不存在');
      return ok(res, { alias });
    } catch (error) { return fail(res, 409, error.message); }
  }
  if (req.method === 'DELETE' && /^\/api\/manual-handoff-aliases\/\d+$/.test(pathname)) {
    const id = parseId(pathname, /^\/api\/manual-handoff-aliases\/(\d+)$/);
    const deleted = deleteManualHandoffAlias(id);
    if (!deleted) return fail(res, 404, '转人工相似说法不存在');
    return ok(res, { deleted });
  }
  if (req.method === 'GET' && pathname === '/api/knowledge-aliases') {
    return ok(res, { aliases: listKnowledgeAliases({ search: url.searchParams.get('search') || '', status: url.searchParams.get('status') || '', category: url.searchParams.get('category') || '', knowledgeId: url.searchParams.get('knowledgeId'), limit: url.searchParams.get('limit') || 500 }) });
  }
  if (req.method === 'GET' && pathname === '/api/knowledge-alias-generation-tasks') return ok(res, { tasks: listKnowledgeAliasTasks(url.searchParams.get('limit') || 200) });
  if (req.method === 'POST' && /^\/api\/knowledge\/\d+\/aliases\/regenerate$/.test(pathname)) {
    const id = parseId(pathname, /^\/api\/knowledge\/(\d+)\/aliases\/regenerate$/);
    if (!row('SELECT id FROM knowledge WHERE id=?', id)) return fail(res, 404, '知识不存在或已删除');
    return ok(res, { task: queueKnowledgeAliasGeneration(id, { requestedBy: '管理员手动重新生成', force: true }) });
  }
  if (req.method === 'POST' && pathname === '/api/knowledge-aliases/generate-all') {
    const items = rows("SELECT id FROM knowledge WHERE status IN ('DRAFT','PUBLISHED') ORDER BY id");
    const tasks = items.map(item => queueKnowledgeAliasGeneration(item.id, { requestedBy: '管理员批量生成' })).filter(Boolean);
    return ok(res, { queued: tasks.length, tasks });
  }

  if (req.method === 'POST' && /^\/api\/knowledge\/\d+\/aliases\/selections$/.test(pathname)) {
    const id = parseId(pathname, /^\/api\/knowledge\/(\d+)\/aliases\/selections$/);
    const data = await body(req);
    const result = setKnowledgeAliasSelections(id, data.enabledIds || []);
    if (!result) return fail(res, 404, '知识不存在或已删除');
    return ok(res, { selection: result, aliases: listKnowledgeAliases({ knowledgeId: id, limit: 1000 }) });
  }
  if (req.method === 'POST' && /^\/api\/knowledge-aliases\/\d+\/(enable|disable)$/.test(pathname)) {
    const match = pathname.match(/^\/api\/knowledge-aliases\/(\d+)\/(enable|disable)$/);
    const alias = setKnowledgeAliasStatus(Number(match[1]), match[2] === 'enable' ? 'ENABLED' : 'DISABLED');
    if (!alias) return fail(res, 404, '相似问法不存在');
    return ok(res, { alias });
  }
  if (req.method === 'DELETE' && /^\/api\/knowledge-aliases\/\d+$/.test(pathname)) {
    const id = parseId(pathname, /^\/api\/knowledge-aliases\/(\d+)$/);
    const deleted = deleteKnowledgeAlias(id);
    if (!deleted) return fail(res, 404, '相似问法不存在');
    return ok(res, { deleted });
  }
  if (req.method === 'DELETE' && pathname === '/api/knowledge/categories') return fail(res, 405, '六个系统知识大类为固定框架，不能删除；可删除其中的小类或单条知识');
  if (req.method === 'DELETE' && pathname === '/api/knowledge/subcategories') {
    const requestedCategory = url.searchParams.get('category');
    const requestedSubcategory = url.searchParams.get('subcategory');
    const categoryValidation = validateKnowledgeCategoryName(requestedCategory);
    if (!categoryValidation.ok) return fail(res, 400, categoryValidation.message);
    const subcategoryValidation = validateKnowledgeSubcategoryName(requestedSubcategory);
    if (!subcategoryValidation.ok) return fail(res, 400, subcategoryValidation.message);
    const data = await body(req);
    if (String(data.confirmText || '').trim() !== '删除') return fail(res, 409, '请输入“删除”确认操作');
    const whereSql = "COALESCE(NULLIF(TRIM(category),''),?)=? AND COALESCE(NULLIF(TRIM(subcategory),''),?)=?";
    const params = [PUBLIC_KNOWLEDGE_CATEGORY, categoryValidation.name, DEFAULT_KNOWLEDGE_SUBCATEGORY, subcategoryValidation.name];
    const count = Number(row(`SELECT COUNT(*) AS c FROM knowledge WHERE ${whereSql}`, ...params).c);
    if (!count) return fail(res, 404, '小类不存在或已删除');
    const deleted = deleteKnowledgeScope(whereSql, params);
    removeKnowledgeSubcategoryCache(categoryValidation.name, subcategoryValidation.name);
    return ok(res, { deleted, category: categoryValidation.name, subcategory: subcategoryValidation.name });
  }
  if (req.method === 'GET' && pathname === '/api/knowledge/categories') {
    const categories = getKnowledgeCategories();
    return ok(res, {
      categories,
      systemCategories: SYSTEM_KNOWLEDGE_CATEGORIES,
      defaultSubcategory: DEFAULT_KNOWLEDGE_SUBCATEGORY,
      replyLimits: PLATFORM_REPLY_LIMITS,
      total: categories.reduce((sum, item) => sum + item.total, 0)
    });
  }
  if (req.method === 'GET' && pathname === '/api/knowledge') {
    const requestedCategory = url.searchParams.get('category');
    const requestedSubcategory = url.searchParams.get('subcategory');
    if (requestedCategory === null && requestedSubcategory !== null) return fail(res, 400, '选择小类前必须先选择大类');
    if (requestedCategory === null) return ok(res, { knowledge: rows('SELECT * FROM knowledge ORDER BY id DESC') });
    const categoryValidation = validateKnowledgeCategoryName(requestedCategory);
    if (!categoryValidation.ok) return fail(res, 400, categoryValidation.message);
    if (requestedSubcategory === null) return ok(res, { knowledge: rows("SELECT * FROM knowledge WHERE COALESCE(NULLIF(TRIM(category),''),?)=? ORDER BY id DESC", PUBLIC_KNOWLEDGE_CATEGORY, categoryValidation.name), category: categoryValidation.name });
    const subcategoryValidation = validateKnowledgeSubcategoryName(requestedSubcategory);
    if (!subcategoryValidation.ok) return fail(res, 400, subcategoryValidation.message);
    return ok(res, { knowledge: rows("SELECT * FROM knowledge WHERE COALESCE(NULLIF(TRIM(category),''),?)=? AND COALESCE(NULLIF(TRIM(subcategory),''),?)=? ORDER BY id DESC", PUBLIC_KNOWLEDGE_CATEGORY, categoryValidation.name, DEFAULT_KNOWLEDGE_SUBCATEGORY, subcategoryValidation.name), category: categoryValidation.name, subcategory: subcategoryValidation.name });
  }
  if (req.method === 'POST' && pathname === '/api/knowledge') {
    const data = await body(req);
    if (!data.question?.trim() || !data.answer?.trim()) return fail(res, 400, '标准问题和标准答案不能为空');
    let category; let subcategory;
    try { category = resolveKnowledgeCategory(data); subcategory = resolveKnowledgeSubcategory(data); }
    catch (error) { return fail(res, 400, error.message); }
    const question = String(data.question || '').trim().normalize('NFC');
    const answer = String(data.answer || '').trim().normalize('NFC');
    if (countUnicodeCharacters(question) > 500) return fail(res, 400, '标准问题不能超过500个Unicode字符');
    const answerLength = validateKnowledgeAnswerLength({ category, answer });
    if (!answerLength.ok) return fail(res, 400, answerLength.message, { characterCount: answerLength.count, characterLimit: answerLength.limit });
    const stamp = now();
    const id = Number(run(`INSERT INTO knowledge(question,answer,keywords,status,version,source,review_status,category,subcategory,created_at,updated_at) VALUES(?,?,?,'DRAFT',1,?,'PENDING_REVIEW',?,?,?,?)`, question, answer, data.keywords?.trim() || '', data.source || 'MANUAL', category, subcategory, stamp, stamp).lastInsertRowid);
    touchKnowledgeSubcategory(category, subcategory, stamp);
    const aliasTask = queueKnowledgeAliasGeneration(id, { requestedBy: data.createdBy || '知识新建' });
    return send(res, 201, { ok: true, knowledge: row('SELECT * FROM knowledge WHERE id=?', id), aliasTask });
  }
  if (req.method === 'PUT' && /^\/api\/knowledge\/\d+$/.test(pathname)) {
    const id = parseId(pathname, /^\/api\/knowledge\/(\d+)$/);
    const item = row('SELECT * FROM knowledge WHERE id=?', id);
    if (!item) return fail(res, 404, '知识不存在或已删除');
    const data = await body(req);
    const question = String(data.question || '').trim().normalize('NFC');
    const answer = String(data.answer || '').trim().normalize('NFC');
    const keywords = String(data.keywords || '').trim();
    if (!question || !answer) return fail(res, 400, '标准问题和标准答案不能为空');
    if (countUnicodeCharacters(question) > 500) return fail(res, 400, '标准问题不能超过500个Unicode字符');
    let category; let subcategory;
    try { category = resolveKnowledgeCategory(data); subcategory = resolveKnowledgeSubcategory(data); }
    catch (error) { return fail(res, 400, error.message); }
    const answerLength = validateKnowledgeAnswerLength({ category, answer });
    if (!answerLength.ok) return fail(res, 400, answerLength.message, { characterCount: answerLength.count, characterLimit: answerLength.limit });
    const stamp = now();
    const editor = String(data.editedBy || '').trim() || item.reviewed_by || null;
    const reviewedAt = item.status === 'PUBLISHED' ? stamp : item.reviewed_at;
    run(`UPDATE knowledge SET question=?,answer=?,keywords=?,category=?,subcategory=?,version=COALESCE(version,1)+1,reviewed_by=?,reviewed_at=?,updated_at=? WHERE id=?`, question, answer, keywords, category, subcategory, editor, reviewedAt, stamp, id);
    touchKnowledgeSubcategory(category, subcategory, stamp);
    run(`UPDATE knowledge_gaps SET normalized_question=?,suggested_answer=?,updated_at=? WHERE message_id IN (SELECT id FROM messages WHERE knowledge_id=?)`, question, answer, stamp, id);
    const aliasTask = queueKnowledgeAliasGeneration(id, { requestedBy: data.editedBy || '知识修改', force: true });
    return ok(res, { knowledge: row('SELECT * FROM knowledge WHERE id=?', id), aliasTask });
  }
  if (req.method === 'DELETE' && /^\/api\/knowledge\/\d+$/.test(pathname)) {
    const id = parseId(pathname, /^\/api\/knowledge\/(\d+)$/);
    const item = row('SELECT * FROM knowledge WHERE id=?', id);
    if (!item) return fail(res, 404, '知识不存在或已删除');
    const deleted = deleteKnowledgeScope('id=?', [id]);
    return ok(res, { deleted, knowledge: { id: item.id, question: item.question, category: item.category, subcategory: item.subcategory } });
  }
  if (req.method === 'POST' && /^\/api\/knowledge\/\d+\/publish$/.test(pathname)) {
    const id = parseId(pathname, /^\/api\/knowledge\/(\d+)\/publish$/); const data = await body(req); const item = row('SELECT * FROM knowledge WHERE id=?', id); if (!item) return fail(res, 404, '知识不存在');
    const answerLength = validateKnowledgeAnswerLength({ category: item.category, answer: item.answer });
    if (!answerLength.ok) return fail(res, 409, answerLength.message, { characterCount: answerLength.count, characterLimit: answerLength.limit });
    const stamp = now();
    run("UPDATE knowledge SET status='PUBLISHED',review_status='APPROVED',reviewed_by=?,reviewed_at=?,published_at=?,updated_at=? WHERE id=?", data.reviewedBy || '技术部审核', stamp, stamp, stamp, id);
    const aliasTask = queueKnowledgeAliasGeneration(id, { requestedBy: data.reviewedBy || '知识发布' });
    return ok(res, { knowledge: row('SELECT * FROM knowledge WHERE id=?', id), aliasTask });
  }
  if (req.method === 'POST' && /^\/api\/knowledge\/\d+\/disable$/.test(pathname)) { const id = parseId(pathname, /^\/api\/knowledge\/(\d+)\/disable$/); const item = row('SELECT id FROM knowledge WHERE id=?', id); if (!item) return fail(res, 404, '知识不存在'); run("UPDATE knowledge SET status='DISABLED',updated_at=? WHERE id=?", now(), id); return ok(res); }
  if (req.method === 'GET' && pathname === '/api/knowledge-gaps') {
    const gaps = rows(`SELECT g.*,m.platform_code,m.user_name,m.content,m.external_url,m.created_at AS message_created_at,m.status AS message_status,m.decision,m.knowledge_id,m.reply_text,m.subquestions_json,k.category AS knowledge_category,k.subcategory AS knowledge_subcategory,(SELECT COUNT(*) FROM knowledge_aliases a WHERE a.knowledge_id=m.knowledge_id AND a.knowledge_version=k.version) AS alias_count,(SELECT t.status FROM knowledge_alias_generation_tasks t WHERE t.knowledge_id=m.knowledge_id ORDER BY t.id DESC LIMIT 1) AS alias_task_status,(SELECT t.error_message FROM knowledge_alias_generation_tasks t WHERE t.knowledge_id=m.knowledge_id ORDER BY t.id DESC LIMIT 1) AS alias_task_error FROM knowledge_gaps g JOIN messages m ON m.id=g.message_id LEFT JOIN knowledge k ON k.id=m.knowledge_id WHERE g.deleted_at IS NULL ORDER BY g.id DESC`)
      .filter(isActualKnowledgeGap)
      .map(item => ({ ...item, suggested_category: knowledgeCategoryForPlatform(item.platform_code) || PUBLIC_KNOWLEDGE_CATEGORY }));
    return ok(res, { gaps });
  }
  if (req.method === 'DELETE' && /^\/api\/knowledge-gaps\/\d+$/.test(pathname)) {
    const id = parseId(pathname, /^\/api\/knowledge-gaps\/(\d+)$/);
    const data = await body(req);
    const session = adminSession(req);
    const gap = row('SELECT * FROM knowledge_gaps WHERE id=?', id);
    if (!gap) return fail(res, 404, '知识缺口不存在或已删除');
    if (gap.deleted_at) return ok(res, { deleted: true, alreadyDeleted: true, gapId: id });
    const stamp = now();
    const deletedBy = String(data.deletedBy || session?.sub || '运营人员').trim().slice(0, 100) || '运营人员';
    const reason = String(data.reason || '运营人员从知识库列表中移除').trim().slice(0, 500) || '运营人员从知识库列表中移除';
    run('UPDATE knowledge_gaps SET deleted_at=?,deleted_by=?,delete_reason=?,updated_at=? WHERE id=? AND deleted_at IS NULL', stamp, deletedBy, reason, stamp, id);
    return ok(res, { deleted: true, alreadyDeleted: false, gapId: id, deletedAt: stamp, deletedBy });
  }  if (req.method === 'POST' && /^\/api\/knowledge-gaps\/\d+\/publish$/.test(pathname)) {
    const id = parseId(pathname, /^\/api\/knowledge-gaps\/(\d+)\/publish$/); const data = await body(req); const gap = row('SELECT g.*,m.platform_code FROM knowledge_gaps g JOIN messages m ON m.id=g.message_id WHERE g.id=?', id); if (!gap || gap.deleted_at) return fail(res, 404, '待补充知识不存在或已删除'); if (!data.answer?.trim()) return fail(res, 400, '标准答案不能为空');
    let category; let subcategory;
    try { category = resolveKnowledgeCategory(data); subcategory = resolveKnowledgeSubcategory(data); }
    catch (error) { return fail(res, 400, error.message); }
    const stamp = now();
    const knowledgeId = Number(run(`INSERT INTO knowledge(question,answer,keywords,status,version,source,review_status,reviewed_by,reviewed_at,published_at,category,subcategory,created_at,updated_at) VALUES(?,?,?,'PUBLISHED',1,'KNOWLEDGE_GAP','APPROVED',?,?,?,?,?,?,?)`, data.question?.trim() || gap.normalized_question, data.answer.trim(), data.keywords?.trim() || '', data.reviewedBy || '技术部审核', stamp, stamp, category, subcategory, stamp, stamp).lastInsertRowid);
    touchKnowledgeSubcategory(category, subcategory, stamp);
    run("UPDATE knowledge_gaps SET suggested_answer=?,status='PUBLISHED',review_note=?,reviewed_by=?,reviewed_at=?,resolved_at=?,updated_at=? WHERE id=?", data.answer.trim(), data.reviewNote || '', data.reviewedBy || '技术部审核', stamp, stamp, stamp, id);
    run('UPDATE messages SET knowledge_id=?,knowledge_question_snapshot=?,knowledge_answer_snapshot=?,updated_at=? WHERE id=?', knowledgeId, data.question?.trim() || gap.normalized_question, data.answer.trim(), stamp, gap.message_id);
    const aliasTask = queueKnowledgeAliasGeneration(knowledgeId, { requestedBy: data.reviewedBy || '知识缺口发布' });
    return ok(res, { knowledgeId, knowledge: row('SELECT * FROM knowledge WHERE id=?', knowledgeId), aliasTask });
  }
  if (req.method === 'GET' && pathname === '/api/issues') {
    return ok(res, { issues: rows('SELECT * FROM issues ORDER BY id DESC LIMIT 300').map(issueView) });
  }
  const issueDiagnosesMatch = pathname.match(/^\/api\/issues\/(\d+)\/diagnoses$/);
  if (req.method === 'GET' && issueDiagnosesMatch) {
    const issueId = Number(issueDiagnosesMatch[1]);
    if (!row('SELECT id FROM issues WHERE id=?', issueId)) return fail(res, 404, '问题不存在');
    return ok(res, { diagnoses: rows('SELECT * FROM issue_diagnoses WHERE issue_id=? ORDER BY id DESC', issueId).map(parsedDiagnosis) });
  }
  const diagnoseIssueMatch = pathname.match(/^\/api\/issues\/(\d+)\/diagnose$/);
  if (req.method === 'POST' && diagnoseIssueMatch) {
    const issueId = Number(diagnoseIssueMatch[1]);
    const data = await body(req);
    const item = row('SELECT * FROM issues WHERE id=?', issueId);
    if (!config.issueDiagnosisEnabled) return fail(res, 503, '\u5f53\u524d\u672a\u5f00\u542f AI \u81ea\u68c0\u529f\u80fd', null, 'ISSUE_DIAGNOSIS_DISABLED');
    if (!item) return fail(res, 404, '问题不存在');
    const active = row("SELECT * FROM issue_diagnoses WHERE issue_id=? AND status IN ('QUEUED','RUNNING')", issueId);
    if (active) return fail(res, 409, '\u8be5\u95ee\u9898\u5df2\u6709 AI \u81ea\u68c0\u6b63\u5728\u6267\u884c', parsedDiagnosis(active), 'DIAGNOSIS_ALREADY_ACTIVE');
    if (!['OPEN','DIAGNOSED','RETRYING'].includes(item.status)) return fail(res, 409, '\u5f53\u524d\u95ee\u9898\u72b6\u6001\u4e0d\u5141\u8bb8\u53d1\u8d77 AI \u81ea\u68c0');
    const context = originalContextForDiagnosis(item);
    if (context.platformCode) {
      const runtime = platformRuntime(context.platformCode);
      if (!isPlatformRuntimeEnabled(runtime)) return fail(res, 409, '关联平台尚未开启或账号未启用，AI 自检不会唤醒该平台', runtime, 'DIAGNOSIS_PLATFORM_STOPPED');
    }
    const stamp = now();
    const diagnosisId = Number(run(`INSERT INTO issue_diagnoses(issue_id,mode,status,requested_by,created_at,updated_at) VALUES(?,'READ_ONLY','QUEUED',?,?,?)`, issueId, data.requestedBy || '管理员', stamp, stamp).lastInsertRowid);
    run("UPDATE issues SET status='DIAGNOSING',diagnosis_status='QUEUED',latest_diagnosis_id=?,updated_at=? WHERE id=?", diagnosisId, stamp, issueId);
    if (context.deviceId && context.platformCode && context.accountId) {
      const screenshotDir = path.join(config.issueDiagnosisEvidenceDir, String(issueId), String(diagnosisId));
      const jobId = createJob(context.deviceId, 'DIAGNOSE_ISSUE', {
        issueId, diagnosisId, platformCode: context.platformCode, accountId: context.accountId,
        profileName: context.profileName, feature: context.feature || 'all', safeReadOnly: true,
        mode: 'READ_ONLY', pages: diagnosticPagesForPlatform(context.platformCode, context.feature),
        settleMs: config.issueDiagnosisPageSettleMs, screenshotDir
      }, { idempotencyKey: `issue-diagnosis:${diagnosisId}` });
      run('UPDATE issue_diagnoses SET agent_job_id=?,updated_at=? WHERE id=?', jobId, now(), diagnosisId);
      return send(res, 202, { ok: true, issue: issueView(row('SELECT * FROM issues WHERE id=?', issueId)), diagnosis: latestDiagnosis(issueId), agentJobId: jobId });
    }
    const diagnosis = await completeIssueDiagnosis({ diagnosisId, issueId, evidence: { message: '该问题没有可关联的平台浏览器上下文，已执行本地规则与 AI 文本诊断', safeReadOnly: true }, stamp });
    return ok(res, { issue: issueView(row('SELECT * FROM issues WHERE id=?', issueId)), diagnosis });
  }
  const manualResolveMatch = pathname.match(/^\/api\/issues\/(\d+)\/manual-resolve$/);
  if (req.method === 'POST' && manualResolveMatch) {
    const data = await body(req);
    const issueItem = resolveIssueManually(Number(manualResolveMatch[1]), { resolutionType: 'MANUAL_HANDLED', resolution: String(data.resolution || '已人工核对并处理').slice(0, 2000), resolvedBy: String(data.resolvedBy || data.assignee || '管理员').slice(0, 100), actualOutcome: data.actualOutcome });
    if (!issueItem) return fail(res, 404, '问题不存在');
    return ok(res, { issue: issueItem });
  }
  const falsePositiveMatch = pathname.match(/^\/api\/issues\/(\d+)\/false-positive$/);
  if (req.method === 'POST' && falsePositiveMatch) {
    const data = await body(req);
    const issueItem = resolveIssueManually(Number(falsePositiveMatch[1]), { resolutionType: 'FALSE_POSITIVE', resolution: String(data.resolution || '已人工确认属于误判').slice(0, 2000), resolvedBy: String(data.resolvedBy || '管理员').slice(0, 100), actualOutcome: data.actualOutcome, platformUrl: data.platformUrl || null, platformPostId: data.platformPostId || null });
    if (!issueItem) return fail(res, 404, '问题不存在');
    return ok(res, { issue: issueItem });
  }
  if (req.method === 'POST' && /^\/api\/issues\/\d+\/close$/.test(pathname)) {
    const id = parseId(pathname, /^\/api\/issues\/(\d+)\/close$/); const data = await body(req);
    const issueItem = resolveIssueManually(id, { resolutionType: 'MANUAL_HANDLED', resolution: data.resolution || '已处理', resolvedBy: data.assignee || '技术部' });
    if (!issueItem) return fail(res, 404, '问题不存在');
    return ok(res, { issue: issueItem });
  }
  if (req.method === 'POST' && /^\/api\/issues\/\d+\/retry$/.test(pathname)) {
    if (!requireOperationsEnabled(res)) return;
    const id = parseId(pathname, /^\/api\/issues\/(\d+)\/retry$/); const item = row('SELECT * FROM issues WHERE id=?', id); if (!item) return fail(res, 404, '问题不存在');
    const diagnosis = latestDiagnosis(id);
    if (!item.retryable || !diagnosis || diagnosis.status !== 'COMPLETED' || diagnosis.safe_to_retry !== 1) return fail(res, 409, 'AI 自检未确认可安全重试，禁止自动重试');
    if (diagnosis.category === 'RESULT_UNCERTAIN') return fail(res, 409, '写操作结果不明确，必须人工确认，禁止自动重试');
    if (item.related_type === 'MESSAGE') {
      const messageId = Number(item.related_id);
      const message = row('SELECT * FROM messages WHERE id=?', messageId);
      if (message?.handled_at) return fail(res, 409, '消息已人工处理');
      releaseIssueBlocks(item.id, {
        releasedBy: 'AI_SAFE_RETRY',
        reason: `Diagnosis#${diagnosis.id} confirmed safe retry`
      });
      run("UPDATE messages SET status='NEW',reply_job_id=NULL,updated_at=? WHERE id=?", now(), messageId);
      await processMessage(messageId, { replaceCancelledReplyJob: true });
    }
    else if (item.related_type === 'PUBLISH_TARGET') {
      const target = row('SELECT * FROM publish_targets WHERE id=?', Number(item.related_id));
      if (target) {
        const account = row('SELECT * FROM accounts WHERE id=?', target.account_id);
        const task = row('SELECT title,body FROM publish_tasks WHERE id=?', target.task_id);
        createJob(account.device_id, 'VERIFY_PUBLISH', {
          taskId: target.task_id,
          targetId: target.id,
          platformCode: target.platform_code,
          accountId: target.account_id,
          profileName: account.profile_name,
          title: task?.title || '',
          body: task?.body || '',
          platformPostId: target.platform_post_id || null,
          platformUrl: target.platform_url || null,
          submittedAt: target.submitted_at,
          submissionStatus: target.submission_status,
          submissionConfirmed: target.submission_status === 'SUBMITTED',
          verificationPolicyId: publishVerificationPolicy(target.platform_code)?.verificationPolicyId || null
        }, { idempotencyKey: `retry-verify:${id}:${Date.now()}` });
      }
    }
    run("UPDATE issues SET status='RETRYING',updated_at=? WHERE id=?", now(), id); return ok(res);
  }
  if (req.method === 'POST' && /^\/api\/agent\/publish-targets\/\d+\/acquire-submit-lock$/.test(pathname)) {
    const id = parseId(pathname, /^\/api\/agent\/publish-targets\/(\d+)\/acquire-submit-lock$/);
    const data = await body(req);
    const stamp = now();
    db.exec('BEGIN IMMEDIATE');
    try {
      const target = row(`SELECT pt.*,a.device_id,t.title,t.material_path,t.created_at AS task_created_at
        FROM publish_targets pt JOIN accounts a ON a.id=pt.account_id JOIN publish_tasks t ON t.id=pt.task_id
        WHERE pt.id=?`, id);
      if (!target) { db.exec('ROLLBACK'); return fail(res, 404, '\u53d1\u5e03\u76ee\u6807\u4e0d\u5b58\u5728'); }
      const identityMismatch = (data.deviceId && data.deviceId !== target.device_id)
        || (Number(data.taskId || target.task_id) !== Number(target.task_id))
        || (Number(data.accountId || target.account_id) !== Number(target.account_id))
        || (data.platformCode && data.platformCode !== target.platform_code);
      if (identityMismatch) { db.exec('ROLLBACK'); return fail(res, 409, '\u6295\u7a3f\u9501\u8bf7\u6c42\u4e0e\u53d1\u5e03\u76ee\u6807\u8eab\u4efd\u4e0d\u5339\u914d'); }
      const expectedFingerprint = json(target.draft_fingerprint, null);
      const suppliedFingerprint = data.draftFingerprint || null;
      if (!expectedFingerprint?.fingerprintHash || !suppliedFingerprint?.fingerprintHash || suppliedFingerprint.fingerprintHash !== expectedFingerprint.fingerprintHash) {
        db.exec('ROLLBACK');
        return fail(res, 409, '\u8349\u7a3f\u6307\u7eb9\u4e0e\u53d1\u5e03\u76ee\u6807\u4e0d\u5339\u914d\uff0c\u7981\u6b62\u6295\u7a3f', { code: 'DRAFT_FINGERPRINT_MISMATCH' });
      }
      const locked = target.submit_lock === 'LOCKED' || target.submit_attempted_at || target.submission_status === 'SUBMITTED'
        || ['SUBMITTING','SUBMIT_ATTEMPTED_UNCONFIRMED','SUBMITTED','PUBLISHED','REJECTED'].includes(target.publish_attempt_state);
      if (locked) {
        db.exec('ROLLBACK');
        return fail(res, 409, '\u8be5\u53d1\u5e03\u76ee\u6807\u5df2\u83b7\u53d6\u8fc7\u6295\u7a3f\u9501\u6216\u5df2\u6709\u63d0\u4ea4\u51ed\u636e\uff0c\u7981\u6b62\u518d\u6b21\u6295\u7a3f', {
          code: 'SUBMIT_ALREADY_LOCKED', submitLock: target.submit_lock, publishAttemptState: target.publish_attempt_state,
          submitAttemptedAt: target.submit_attempted_at, submitAttemptCount: target.submit_attempt_count
        });
      }
      const result = run(`UPDATE publish_targets SET submit_lock='LOCKED',submit_authorized_at=?,submit_attempted_at=?,submit_attempt_count=submit_attempt_count+1,submit_lock_reason=?,publish_attempt_state='SUBMITTING',updated_at=?
        WHERE id=? AND submit_lock='UNLOCKED' AND submit_attempted_at IS NULL AND submission_status='NOT_SUBMITTED' AND publish_attempt_state IN ('NOT_ATTEMPTED','DRAFT_BLOCKED','PUBLISH_REJECTED')`, stamp, stamp, String(data.reason || 'FINAL_PUBLISH_CLICK'), stamp, id);
      if (Number(result.changes || 0) !== 1) {
        db.exec('ROLLBACK');
        return fail(res, 409, '\u6295\u7a3f\u9501\u5df2\u88ab\u5176\u4ed6\u6267\u884c\u5360\u7528\uff0c\u7981\u6b62\u518d\u6b21\u6295\u7a3f', { code: 'SUBMIT_LOCK_RACE' });
      }
      db.exec('COMMIT');
      return ok(res, { authorized: true, targetId: id, submitLock: 'LOCKED', publishAttemptState: 'SUBMITTING', submitAuthorizedAt: stamp, submitAttemptedAt: stamp, submitAttemptCount: Number(target.submit_attempt_count || 0) + 1 });
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch {}
      throw error;
    }
  }
  if (req.method === 'POST' && /^\/api\/agent\/publish-targets\/\d+\/record-submit-result$/.test(pathname)) {
    const id = parseId(pathname, /^\/api\/agent\/publish-targets\/(\d+)\/record-submit-result$/);
    const data = await body(req);
    const target = row(`SELECT pt.*,a.device_id,t.title FROM publish_targets pt JOIN accounts a ON a.id=pt.account_id JOIN publish_tasks t ON t.id=pt.task_id WHERE pt.id=?`, id);
    if (!target) return fail(res, 404, '\u53d1\u5e03\u76ee\u6807\u4e0d\u5b58\u5728');
    const outerStatus = ['SUCCESS','FAILED','NEEDS_CONFIRMATION','CANCELLED'].includes(data.status) ? data.status : 'NEEDS_CONFIRMATION';
    const result = data.result || {};
    const reconciledBeforeSubmit = outerStatus === 'SUCCESS'
      && result.reconciledBeforeSubmit === true
      && result.stage === 'management_precheck_reconciled'
      && ['PUBLISHED','REVIEWING','REJECTED'].includes(String(result.reviewStatus || '').toUpperCase());
    const hasSubmitLock = target.submit_lock === 'LOCKED' && Boolean(target.submit_attempted_at);
    if (!hasSubmitLock && !reconciledBeforeSubmit) return fail(res, 409, '\u8be5\u76ee\u6807\u5c1a\u672a\u83b7\u53d6\u6295\u7a3f\u9501\uff0c\u7981\u6b62\u56de\u5199\u6700\u7ec8\u6295\u7a3f\u7ed3\u679c');
    if (reconciledBeforeSubmit) {
      const expectedFingerprint = json(target.draft_fingerprint, null);
      const suppliedFingerprint = data.draftFingerprint || null;
      if (!expectedFingerprint?.fingerprintHash || suppliedFingerprint?.fingerprintHash !== expectedFingerprint.fingerprintHash) {
        return fail(res, 409, '\u7ba1\u7406\u9875\u5bf9\u8d26\u56de\u5199\u7684\u8349\u7a3f\u6307\u7eb9\u4e0d\u5339\u914d', { code: 'DRAFT_FINGERPRINT_MISMATCH' });
      }
    }
    applyPublishCompletion({ device_id: target.device_id }, { taskId: target.task_id, targetId: target.id, platformCode: target.platform_code, accountId: target.account_id, profileName: data.profileName || null, title: target.title }, result, outerStatus, now(), -1);
    return ok(res, { target: row('SELECT * FROM publish_targets WHERE id=?', id) });
  }
  if (req.method === 'POST' && pathname === '/api/agent/heartbeat') {
    const data = await body(req);
    const device = row('SELECT * FROM devices WHERE id=?', data.deviceId);
    if (!device) return fail(res, 404, '\u8bbe\u5907\u4e0d\u5b58\u5728');
    run("UPDATE devices SET status='ONLINE',agent_version=?,last_heartbeat=?,browser_control_json=COALESCE(?,browser_control_json) WHERE id=?", data.version || 'unknown', now(), data.browserControl ? JSON.stringify(data.browserControl) : null, data.deviceId);
    return ok(res, { serverTime: now(), platforms: getPlatformRuntime(), masterSwitch: getMasterSwitch() });
  }
  if (req.method === 'POST' && pathname === '/api/agent/jobs/claim') {
    const data = await body(req);
    if (!data.deviceId) return fail(res, 400, 'deviceId \u4e0d\u80fd\u4e3a\u7a7a');
    const runtimeList = getPlatformRuntime();
    if (!operationsEnabled()) return ok(res, { job: null, paused: true, platforms: runtimeList });
    const requestedPlatformCodes = Array.isArray(data.platformCodes)
      ? [...new Set(data.platformCodes.map(item => String(item || '').trim().toLowerCase()).filter(Boolean))]
      : [];
    if (requestedPlatformCodes.some(code => !activePlatformCodes.includes(code))) return fail(res, 400, 'platformCodes contains an unsupported platform');
    const requestedQueueLaneSource = Array.isArray(data.queueLanes)
      ? data.queueLanes
      : (Array.isArray(data.channelTypes) ? data.channelTypes : []);
    const requestedQueueLanes = [...new Set(requestedQueueLaneSource.map(item => String(item || '').trim().toUpperCase()).filter(Boolean))];
    const supportedQueueLanes = new Set(['PRIVATE_MESSAGE', 'COMMENT', 'COMBINED', 'GENERAL']);
    if (requestedQueueLanes.some(lane => !supportedQueueLanes.has(lane))) return fail(res, 400, 'queueLanes contains an unsupported lane');
    const platformFilterSql = requestedPlatformCodes.length
      ? ` AND LOWER(TRIM(CAST(json_extract(j.payload,'$.platformCode') AS TEXT))) IN (${requestedPlatformCodes.map(() => '?').join(',')})`
      : '';
    const effectiveQueueLaneSql = `UPPER(COALESCE(
      NULLIF(TRIM(j.queue_lane),''),
      NULLIF(TRIM(j.channel_type),''),
      NULLIF(TRIM(CAST(json_extract(j.payload,'$.queueLane') AS TEXT)),''),
      NULLIF(TRIM(CAST(json_extract(j.payload,'$.channelType') AS TEXT)),''),
      NULLIF(TRIM(CAST(json_extract(j.payload,'$.messageType') AS TEXT)),''),
      CASE WHEN j.job_type='COLLECT_MESSAGES' THEN 'COMBINED' ELSE 'GENERAL' END
    ))`;
    const queueLaneFilterSql = requestedQueueLanes.length
      ? ` AND ${effectiveQueueLaneSql} IN (${requestedQueueLanes.map(() => '?').join(',')})`
      : '';
    const runnableSql = ` AND j.job_type <> 'PUBLISH_STATUS_CHECK' AND (
      j.job_type <> 'REPLY' OR COALESCE((
        SELECT smart_reply_setting.encrypted_value FROM system_settings smart_reply_setting
        WHERE smart_reply_setting.setting_key='smart_reply.' || json_extract(j.payload,'$.platformCode') || '.enabled'
      ),'true')='true'
    ) AND (
      json_extract(j.payload,'$.platformCode') IS NULL OR EXISTS (
        SELECT 1 FROM platforms p
        WHERE p.code=json_extract(j.payload,'$.platformCode')
          AND COALESCE(p.desired_state,'RUNNING')='RUNNING'
          AND COALESCE(p.lifecycle_state,'ACTIVE')='ACTIVE'
          AND EXISTS (SELECT 1 FROM accounts enabled_account WHERE enabled_account.platform_code=p.code AND enabled_account.enabled=1)
      )
    ) AND (
      json_extract(j.payload,'$.accountId') IS NULL OR EXISTS (
        SELECT 1 FROM accounts job_account
        WHERE job_account.id=CAST(json_extract(j.payload,'$.accountId') AS INTEGER)
          AND job_account.enabled=1
          AND job_account.platform_code=json_extract(j.payload,'$.platformCode')
      )
    )`;
    const stamp = now();
    db.exec('BEGIN IMMEDIATE');
    try {
      const expiredJobs = rows("SELECT * FROM agent_jobs WHERE device_id=? AND status='RUNNING' AND lease_expires_at IS NOT NULL AND lease_expires_at<? AND attempts<3", data.deviceId, stamp);
      for (const expired of expiredJobs) {
        const expiredPayload = json(expired.payload, {});
        if (isNonIdempotentAgentJob(expired.job_type, expiredPayload)) {
          const result = { message: expired.job_type === 'BROWSER_COMMAND' ? 'Interactive browser command lease expired; the operation may have occurred and requires manual verification.' : '\u975e\u5e42\u7b49\u53d1\u5e03/\u56de\u590d\u4efb\u52a1\u79df\u7ea6\u5df2\u8fc7\u671f\uff0c\u9700\u4eba\u5de5\u6838\u5bf9\u5e73\u53f0\u5b9e\u9645\u7ed3\u679c\uff0c\u7981\u6b62\u81ea\u52a8\u91cd\u8bd5', reason: 'NON_IDEMPOTENT_LEASE_EXPIRED' };
          run("UPDATE agent_jobs SET status='NEEDS_CONFIRMATION',result=?,completed_at=?,lease_expires_at=NULL WHERE id=?", JSON.stringify(result), stamp, expired.id);
          completeBrowserCommand(expired, 'NEEDS_CONFIRMATION', result, stamp);
          if (expired.job_type === 'PUBLISH' && expiredPayload.targetId) {
            const expiredTarget = row('SELECT submit_lock,submit_attempted_at FROM publish_targets WHERE id=?', expiredPayload.targetId);
            const submitMayHaveStarted = expiredTarget?.submit_lock === 'LOCKED' || Boolean(expiredTarget?.submit_attempted_at);
            run(`UPDATE publish_targets SET status='NEEDS_CONFIRMATION',result=?,publish_attempt_state=?,submit_lock=CASE WHEN ? THEN 'LOCKED' ELSE submit_lock END,submit_attempted_at=CASE WHEN ? THEN COALESCE(submit_attempted_at,?) ELSE submit_attempted_at END,submit_attempt_count=CASE WHEN ? THEN MAX(submit_attempt_count,1) ELSE submit_attempt_count END,submit_lock_reason=CASE WHEN ? THEN COALESCE(submit_lock_reason,'NON_IDEMPOTENT_LEASE_EXPIRED') ELSE submit_lock_reason END,updated_at=? WHERE id=?`, JSON.stringify(result), submitMayHaveStarted ? 'SUBMIT_ATTEMPTED_UNCONFIRMED' : 'DRAFT_BLOCKED', submitMayHaveStarted ? 1 : 0, submitMayHaveStarted ? 1 : 0, stamp, submitMayHaveStarted ? 1 : 0, submitMayHaveStarted ? 1 : 0, stamp, expiredPayload.targetId);
            updateTaskAggregate(expiredPayload.taskId);
          }
          if (expired.job_type === 'REPLY' && expiredPayload.messageId) {
            run("UPDATE messages SET status='MANUAL_REQUIRED',decision='TECHNICAL_ERROR',reason=?,updated_at=? WHERE id=? AND reply_job_id=? AND handled_at IS NULL", result.message, stamp, expiredPayload.messageId, expired.id);
            if (expiredPayload.replyBatchId) {
              run(`UPDATE reply_batches SET status='SEND_UNCERTAIN',invalidation_reason='NON_IDEMPOTENT_LEASE_EXPIRED',completed_at=NULL,updated_at=?
                WHERE id=? AND status='SENDING' AND agent_job_id=?`, stamp, Number(expiredPayload.replyBatchId), expired.id);
              if (expiredPayload.replyAttemptId) {
                run(`UPDATE reply_attempts SET state='SEND_UNCERTAIN',result_json=?,error_message=?,updated_at=?
                  WHERE id=? AND reply_batch_id=? AND state='PREPARED'`, JSON.stringify(result), result.message, stamp, Number(expiredPayload.replyAttemptId), Number(expiredPayload.replyBatchId));
              }
            }
          }
        } else {
          run("UPDATE agent_jobs SET status='QUEUED',claimed_at=NULL,lease_expires_at=NULL WHERE id=?", expired.id);
          deferBrowserCommand(expired, { reason: 'LEASE_EXPIRED_SAFE_REQUEUE', message: 'Browser command lease expired and was safely requeued.' }, stamp);
        }
      }
      const lockedQueuedPublishJobs = rows(`SELECT j.id,j.payload FROM agent_jobs j JOIN publish_targets target ON target.id=CAST(json_extract(j.payload,'$.targetId') AS INTEGER)
        WHERE j.device_id=? AND j.status='QUEUED' AND j.job_type='PUBLISH' AND (target.submit_lock='LOCKED' OR target.submit_attempted_at IS NOT NULL OR target.submission_status='SUBMITTED')`, data.deviceId);
      for (const guardedJob of lockedQueuedPublishJobs) {
        const guardedPayload = json(guardedJob.payload, {});
        const guardedResult = { message: '\u68c0\u6d4b\u5230\u8be5\u76ee\u6807\u5df2\u6709\u6295\u7a3f\u9501\u6216\u63d0\u4ea4\u51ed\u636e\uff0c\u5df2\u9694\u79bb\u6392\u961f\u4e2d\u7684\u91cd\u590d\u6295\u7a3f\u4efb\u52a1', reason: 'SUBMIT_LOCK_PREVENTED_RETRY' };
        run("UPDATE agent_jobs SET status='NEEDS_CONFIRMATION',result=?,completed_at=?,lease_expires_at=NULL WHERE id=?", JSON.stringify(guardedResult), stamp, guardedJob.id);
        if (guardedPayload.targetId) run(`UPDATE publish_targets SET status=CASE WHEN submission_status='SUBMITTED' THEN status ELSE 'NEEDS_CONFIRMATION' END,publish_attempt_state=CASE WHEN review_status='PUBLISHED' THEN 'PUBLISHED' WHEN review_status='REJECTED' THEN 'REJECTED' WHEN submission_status='SUBMITTED' THEN 'SUBMITTED' ELSE 'SUBMIT_ATTEMPTED_UNCONFIRMED' END,result=?,updated_at=? WHERE id=?`, JSON.stringify(guardedResult), stamp, guardedPayload.targetId);
        if (guardedPayload.taskId) updateTaskAggregate(guardedPayload.taskId);
      }
      // Let active collection/reply jobs finish, then reserve the platform for
      // an exclusive publish job that has been runnable for at least a minute.
      // All workers must see this reservation, including the private-message
      // worker, or fresh collection jobs can keep publication waiting forever.
      const publishWaitCutoff = new Date(Date.parse(stamp) - 60_000).toISOString();
      const waitingPublishJobs = rows(`SELECT j.* FROM agent_jobs j
        WHERE j.device_id=? AND j.status='QUEUED'
          AND j.job_type IN ('PUBLISH','VERIFY_PUBLISH')
          AND COALESCE(j.available_at,j.created_at)<=?
        ${runnableSql}${platformFilterSql}
        ORDER BY COALESCE(j.available_at,j.created_at),j.id`, data.deviceId, publishWaitCutoff, ...requestedPlatformCodes);
      const publishReservations = new Map();
      for (const waiting of waitingPublishJobs) {
        const waitingPayload = json(waiting.payload, {});
        const platformCode = String(waitingPayload.platformCode || '').trim().toLowerCase();
        if (!platformCode || publishReservations.has(platformCode) || jobBlockedByRuntime(waitingPayload, waiting.job_type)) continue;
        publishReservations.set(platformCode, waiting.id);
      }
      const reservedPublishIds = [...publishReservations.values()];
      const reservedPlatformCodes = [...publishReservations.keys()];
      // Filter held jobs before LIMIT so a busy platform cannot hide another
      // platform's runnable job beyond the first hundred candidates.
      const publishReservationFilter = reservedPublishIds.length
        ? `AND (LOWER(TRIM(COALESCE(CAST(json_extract(j.payload,'$.platformCode') AS TEXT),''))) NOT IN (${reservedPlatformCodes.map(() => '?').join(',')})
            OR j.id IN (${reservedPublishIds.map(() => '?').join(',')}))`
        : '';
      const publishReservationOrder = reservedPublishIds.length
        ? `CASE WHEN j.id IN (${reservedPublishIds.map(() => '?').join(',')}) THEN 0 ELSE 1 END,`
        : '';
      const candidates = rows(`SELECT j.* FROM agent_jobs j
        WHERE j.device_id=? AND j.status='QUEUED' AND COALESCE(j.available_at,j.created_at)<=?
        ${runnableSql}${platformFilterSql}${queueLaneFilterSql}${publishReservationFilter}
        ORDER BY
          ${publishReservationOrder}
          COALESCE(j.priority,100),
          COALESCE(j.first_pending_at,j.created_at),
          j.id
        LIMIT 100`, data.deviceId, stamp, ...requestedPlatformCodes, ...requestedQueueLanes,
        ...reservedPlatformCodes, ...reservedPublishIds, ...reservedPublishIds);
      const pendingConversationJobs = rows(`SELECT id,job_type,payload,status FROM agent_jobs
        WHERE device_id=? AND status IN ('QUEUED','RUNNING')`, data.deviceId)
        .map(item => ({ ...item, payload: json(item.payload, {}) }));
      let job = null;
      for (const candidate of candidates) {
        let candidatePayload = json(candidate.payload, {});
        if (!isRecoveryJobTypeClaimable(candidate.job_type) || jobBlockedByRuntime(candidatePayload, candidate.job_type)) continue;
        if (isOldConversationRecoveryJob(candidate.job_type, candidatePayload)) {
          if (hasIncrementalConversationWork(pendingConversationJobs, { excludeJobId: candidate.id })) continue;
          let targetIds = recoveryConversationIds(candidatePayload);
          if (!targetIds.length && candidatePayload.conversationNamespace) {
            const target = row('SELECT id FROM conversations WHERE namespace=?', String(candidatePayload.conversationNamespace));
            if (target?.id) targetIds = [Number(target.id)];
          }
          const eligibleIds = targetIds.filter(conversationId => {
            const conversation = row('SELECT * FROM conversations WHERE id=?', conversationId);
            return eligibleForRecoveryScan(conversation, stamp).eligible;
          });
          if (!eligibleIds.length) {
            run("UPDATE agent_jobs SET status='CANCELLED',completed_at=?,lease_expires_at=NULL,result=? WHERE id=? AND status='QUEUED'",
              stamp, JSON.stringify({ ignored: true, ignoreReason: targetIds.length ? 'RECOVERY_CONVERSATION_NOT_ELIGIBLE' : 'RECOVERY_CONVERSATION_TARGET_REQUIRED' }), candidate.id);
            continue;
          }
          candidatePayload = {
            ...candidatePayload,
            recoveryScan: true,
            oldConversationScan: true,
            scanMode: 'OLD_CONVERSATIONS',
            collectionScope: 'CONVERSATION_RECOVERY',
            channelType: 'PRIVATE_MESSAGE',
            queueLane: 'PRIVATE_MESSAGE',
            types: ['PRIVATE_MESSAGE'],
            conversationId: eligibleIds[0],
            conversationIds: eligibleIds,
            maxPrivateSessions: Math.min(2, Math.max(1, Number(candidatePayload.maxPrivateSessions) || 2))
          };
          run("UPDATE agent_jobs SET payload=?,channel_type='PRIVATE_MESSAGE',queue_lane='PRIVATE_MESSAGE' WHERE id=? AND status='QUEUED'", JSON.stringify(candidatePayload), candidate.id);
          candidate.payload = JSON.stringify(candidatePayload);
          candidate.channel_type = 'PRIVATE_MESSAGE';
          candidate.queue_lane = 'PRIVATE_MESSAGE';
        }
        const candidatePlatformCode = String(candidatePayload.platformCode || '').trim().toLowerCase();
        if (candidatePlatformCode) {
          const candidateLane = String(candidatePayload.queueLane || candidatePayload.channelType || candidatePayload.messageType || (candidate.job_type === 'COLLECT_MESSAGES' ? 'COMBINED' : 'GENERAL')).trim().toUpperCase();
          const runningPlatformJobs = rows(`SELECT id,job_type,payload FROM agent_jobs
            WHERE device_id=? AND status='RUNNING' AND id<>?
              AND LOWER(TRIM(CAST(json_extract(payload,'$.platformCode') AS TEXT)))=?`, data.deviceId, candidate.id, candidatePlatformCode);
          const candidateRequiresExclusivePlatform = ['PUBLISH', 'VERIFY_PUBLISH'].includes(String(candidate.job_type || '').toUpperCase());
          const laneConflict = runningPlatformJobs.some(runningJob => {
            const runningPayload = json(runningJob.payload, {});
            const runningLane = String(runningPayload.queueLane || runningPayload.channelType || runningPayload.messageType || (runningJob.job_type === 'COLLECT_MESSAGES' ? 'COMBINED' : 'GENERAL')).trim().toUpperCase();
            const runningRequiresExclusivePlatform = ['PUBLISH', 'VERIFY_PUBLISH'].includes(String(runningJob.job_type || '').toUpperCase());
            if (candidateRequiresExclusivePlatform || runningRequiresExclusivePlatform) return true;
            if (['GENERAL', 'COMBINED'].includes(candidateLane) || ['GENERAL', 'COMBINED'].includes(runningLane)) return true;
            return candidateLane === runningLane;
          });
          if (laneConflict) continue;
        }
        if (candidate.job_type === 'REPLY') {
          const currentMessage = row(`SELECT m.reply_job_id,m.handled_at,m.conversation_id,c.handling_mode,c.human_followup_state
            FROM messages m LEFT JOIN conversations c ON c.id=m.conversation_id WHERE m.id=?`, candidatePayload.messageId);
          if (currentMessage?.conversation_id && conversationAutomationDisabled(currentMessage)) {
            const reason = '发送任务领取前检测到会话已转人工或正在通知人工，禁止机器人继续回复';
            run("UPDATE agent_jobs SET status='CANCELLED',completed_at=?,lease_expires_at=NULL,result=? WHERE id=? AND status='QUEUED'",
              stamp, JSON.stringify({ ignored: true, ignoreReason: 'CONVERSATION_AUTOMATION_DISABLED', conversationId: currentMessage.conversation_id }), candidate.id);
            run("UPDATE messages SET status='MANUAL_REQUIRED',decision='HUMAN_HANDOFF',reason=?,reply_job_id=NULL,updated_at=? WHERE id=? AND reply_job_id=? AND handled_at IS NULL",
              reason, stamp, candidatePayload.messageId, candidate.id);
            if (candidatePayload.replyBatchId) {
              run(`UPDATE reply_batches SET status='CANCELLED',invalidation_reason='CONVERSATION_AUTOMATION_DISABLED',completed_at=?,updated_at=?
                WHERE id=? AND agent_job_id=? AND status IN ('PENDING','GENERATING','READY')`, stamp, stamp, Number(candidatePayload.replyBatchId), candidate.id);
            }
            continue;
          }
          const ownsMessage = currentMessage && currentMessage.handled_at == null && Number(currentMessage.reply_job_id) === Number(candidate.id);
          if (!ownsMessage) {
            run("UPDATE agent_jobs SET status='CANCELLED',completed_at=?,lease_expires_at=NULL,result=? WHERE id=? AND status='QUEUED'", stamp, JSON.stringify({ ignored: true, ignoreReason: 'STALE_REPLY_JOB_CLAIM', currentReplyJobId: currentMessage?.reply_job_id || null }), candidate.id);
            continue;
          }
          if (candidatePayload.replyBatchId) {
            const batch = row('SELECT * FROM reply_batches WHERE id=?', Number(candidatePayload.replyBatchId));
            const conversation = batch ? row('SELECT ledger_version FROM conversations WHERE id=?', Number(batch.conversation_id)) : null;
            const validBatch = batch?.status === 'READY'
              && Number(batch.agent_job_id) === Number(candidate.id)
              && Number(batch.conversation_version) === Number(candidatePayload.replyBatchVersion)
              && Number(batch.conversation_version) === Number(conversation?.ledger_version);
            if (!validBatch) {
              run("UPDATE agent_jobs SET status='CANCELLED',completed_at=?,lease_expires_at=NULL,result=? WHERE id=? AND status='QUEUED'", stamp, JSON.stringify({ ignored: true, ignoreReason: 'V2_REPLY_BATCH_VERSION_CHANGED', replyBatchId: candidatePayload.replyBatchId }), candidate.id);
              run("UPDATE messages SET status='NEW',decision=NULL,reason='发送任务领取前检测到同一会话版本变化，旧答案已作废',reply_job_id=NULL,updated_at=? WHERE id=? AND reply_job_id=? AND handled_at IS NULL", stamp, candidatePayload.messageId, candidate.id);
              if (batch?.status === 'READY' && Number(batch.agent_job_id) === Number(candidate.id)) {
                run(`UPDATE reply_batches SET status='PENDING',claimed_at=NULL,generation_started_at=NULL,reply_text=NULL,agent_job_id=NULL,generation_message_id=NULL,
                  invalidation_reason='VERSION_CHANGED_BEFORE_SEND_CLAIM',updated_at=? WHERE id=? AND status='READY'`, stamp, batch.id);
              }
              continue;
            }
          }
        }
        job = candidate;
        break;
      }
      if (!job) {
        db.exec('COMMIT');
        return ok(res, { job: null, platformCodes: requestedPlatformCodes, queueLanes: requestedQueueLanes, platforms: getPlatformRuntime() });
      }
      let payload = json(job.payload, {});
      const leaseMs = job.job_type === 'PUBLISH' ? config.agentPublishJobLeaseMs : config.agentJobLeaseMs;
      run("UPDATE agent_jobs SET status='RUNNING',attempts=attempts+1,claimed_at=?,lease_expires_at=? WHERE id=?", stamp, futureIso(leaseMs), job.id);
      if (isOldConversationRecoveryJob(job.job_type, payload)) {
        for (const conversationId of recoveryConversationIds(payload)) {
          run("UPDATE conversations SET last_recovery_scan_at=?,updated_at=? WHERE id=? AND handling_mode='BOT_ACTIVE'", stamp, stamp, conversationId);
        }
      }
      if (job.job_type === 'REPLY' && payload.replyBatchId) {
        const batch = row('SELECT * FROM reply_batches WHERE id=?', Number(payload.replyBatchId));
        const conversation = batch ? row('SELECT ledger_version FROM conversations WHERE id=?', Number(batch.conversation_id)) : null;
        const transitioned = batch?.status === 'READY'
          && Number(batch.agent_job_id) === Number(job.id)
          && Number(batch.conversation_version) === Number(payload.replyBatchVersion)
          && Number(batch.conversation_version) === Number(conversation?.ledger_version)
          ? run(`UPDATE reply_batches SET status='SENDING',send_started_at=?,updated_at=?
              WHERE id=? AND status='READY' AND agent_job_id=? AND conversation_version=?`, stamp, stamp, batch.id, job.id, batch.conversation_version)
          : { changes: 0 };
        if (transitioned.changes !== 1) throw new Error('V2 回复批次领取前版本校验失败');
        const attemptNo = Number(row('SELECT COALESCE(MAX(attempt_no),0)+1 AS attempt_no FROM reply_attempts WHERE reply_batch_id=?', batch.id)?.attempt_no || 1);
        const attemptKey = `reply-batch:${batch.id}:attempt:${attemptNo}`;
        const attemptId = Number(run(`INSERT INTO reply_attempts(reply_batch_id,attempt_no,idempotency_key,state,pre_send_version,prepared_at,created_at,updated_at)
          VALUES(?,?,?,'PREPARED',?,?,?,?)`, batch.id, attemptNo, attemptKey, Number(conversation.ledger_version), stamp, stamp, stamp).lastInsertRowid);
        run('UPDATE reply_batches SET last_attempt_id=?,updated_at=? WHERE id=?', attemptId, stamp, batch.id);
        payload = { ...payload, replyAttemptId: attemptId, preSendVersion: Number(conversation.ledger_version), replyAttemptKey: attemptKey };
        run("UPDATE agent_jobs SET payload=? WHERE id=? AND status='RUNNING'", JSON.stringify(payload), job.id);
      }
      markBrowserCommandClaimed(job, stamp);
      if (job.job_type === 'DIAGNOSE_ISSUE' && payload.diagnosisId) {
        run("UPDATE issue_diagnoses SET status='RUNNING',started_at=COALESCE(started_at,?),updated_at=? WHERE id=? AND status='QUEUED'", stamp, stamp, payload.diagnosisId);
        run("UPDATE issues SET diagnosis_status='RUNNING',updated_at=? WHERE id=? AND status='DIAGNOSING'", stamp, payload.issueId);
      }
      if (job.job_type === 'PUBLISH' && payload.targetId) {
        run("UPDATE publish_targets SET status='RUNNING',updated_at=? WHERE id=?", stamp, payload.targetId);
        run("UPDATE publish_tasks SET status='EXECUTING',updated_at=? WHERE id=?", stamp, payload.taskId);
      }
      if (job.job_type === 'REPLY' && payload.messageId) run("UPDATE messages SET status='REPLY_RUNNING',updated_at=? WHERE id=? AND reply_job_id=? AND handled_at IS NULL", stamp, payload.messageId, job.id);
      db.exec('COMMIT');
      return ok(res, { job: { ...job, status: 'RUNNING', payload }, platformCodes: requestedPlatformCodes, queueLanes: requestedQueueLanes, platforms: getPlatformRuntime() });
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  if (req.method === 'POST' && /^\/api\/agent\/jobs\/\d+\/defer$/.test(pathname)) {
    const id = parseId(pathname, /^\/api\/agent\/jobs\/(\d+)\/defer$/);
    const data = await body(req);
    const job = row('SELECT * FROM agent_jobs WHERE id=?', id);
    if (!job) return fail(res, 404, '\u4efb\u52a1\u4e0d\u5b58\u5728');
    const payload = json(job.payload, {});
    const stamp = now();
    if (job.job_type === 'REPLY') {
      db.exec('BEGIN IMMEDIATE');
      try {
        const currentJob = row('SELECT status FROM agent_jobs WHERE id=?', id);
        const currentMessage = row('SELECT reply_job_id,handled_at FROM messages WHERE id=?', payload.messageId);
        const currentBatch = payload.replyBatchId ? row('SELECT status,agent_job_id FROM reply_batches WHERE id=?', Number(payload.replyBatchId)) : null;
        const ownsBatch = !payload.replyBatchId || (currentBatch?.status === 'SENDING' && Number(currentBatch.agent_job_id) === Number(id));
        const ownsMessage = currentJob?.status === 'RUNNING' && currentMessage?.handled_at == null && Number(currentMessage?.reply_job_id) === Number(id) && ownsBatch;
        if (!ownsMessage) {
          if (currentJob?.status === 'RUNNING') {
            run("UPDATE agent_jobs SET status='CANCELLED',result=?,completed_at=?,lease_expires_at=NULL WHERE id=? AND status='RUNNING'", JSON.stringify({ ignored: true, ignoreReason: 'STALE_REPLY_JOB_DEFER', currentReplyJobId: currentMessage?.reply_job_id || null }), stamp, id);
          }
          db.exec('COMMIT');
          return ok(res, { ignored: true, reason: 'STALE_REPLY_JOB_DEFER', job: row('SELECT * FROM agent_jobs WHERE id=?', id) });
        }
        deferBrowserCommand(job, data, stamp);
        run("UPDATE agent_jobs SET status='QUEUED',attempts=MAX(attempts-1,0),claimed_at=NULL,lease_expires_at=NULL,available_at=?,result=? WHERE id=? AND status='RUNNING'", stamp, JSON.stringify({ deferred: true, reason: data.reason || 'PLATFORM_STOPPED_PRE_EXECUTION', message: data.message || '\u5e73\u53f0\u5df2\u505c\u6b62\uff0c\u4efb\u52a1\u4fdd\u6301\u6392\u961f' }), id);
        run("UPDATE messages SET status='REPLY_QUEUED',updated_at=? WHERE id=? AND reply_job_id=? AND handled_at IS NULL", stamp, payload.messageId, id);
        if (payload.replyBatchId) {
          run(`UPDATE reply_batches SET status='READY',send_started_at=NULL,updated_at=? WHERE id=? AND status='SENDING' AND agent_job_id=?`, stamp, Number(payload.replyBatchId), id);
          if (payload.replyAttemptId) {
            run(`UPDATE reply_attempts SET state='DEFERRED_BEFORE_SEND',result_json=?,error_message=?,updated_at=?
              WHERE id=? AND reply_batch_id=? AND state='PREPARED'`, JSON.stringify({ deferred: true, reason: data.reason || 'PLATFORM_STOPPED_PRE_EXECUTION' }), data.message || null, stamp, Number(payload.replyAttemptId), Number(payload.replyBatchId));
          }
        }
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
      return ok(res, { job: row('SELECT * FROM agent_jobs WHERE id=?', id), platform: platformRuntime(payload.platformCode) });
    }
    if (job.status !== 'RUNNING') return fail(res, 409, '\u4efb\u52a1\u5df2\u4e0d\u5728\u6267\u884c\u4e2d\uff0c\u65e0\u9700\u5ef6\u540e');
    deferBrowserCommand(job, data, stamp);
    run("UPDATE agent_jobs SET status='QUEUED',attempts=MAX(attempts-1,0),claimed_at=NULL,lease_expires_at=NULL,available_at=?,result=? WHERE id=?", stamp, JSON.stringify({ deferred: true, reason: data.reason || 'PLATFORM_STOPPED_PRE_EXECUTION', message: data.message || '\u5e73\u53f0\u5df2\u505c\u6b62\uff0c\u4efb\u52a1\u4fdd\u6301\u6392\u961f' }), id);
    if (job.job_type === 'PUBLISH' && payload.targetId) {
      run("UPDATE publish_targets SET status='QUEUED',updated_at=? WHERE id=?", stamp, payload.targetId);
      updateTaskAggregate(payload.taskId);
    }
    return ok(res, { job: row('SELECT * FROM agent_jobs WHERE id=?', id), platform: platformRuntime(payload.platformCode) });
  }
  if (req.method === 'POST' && /^\/api\/agent\/jobs\/\d+\/complete$/.test(pathname)) {
    const id = parseId(pathname, /^\/api\/agent\/jobs\/(\d+)\/complete$/);
    const data = await body(req);
    const job = row('SELECT * FROM agent_jobs WHERE id=?', id);
    if (!job) return fail(res, 404, '任务不存在');
    const payload = json(job.payload, {});
    const outerStatus = ['SUCCESS','PARTIAL_SUCCESS','FAILED','NEEDS_CONFIRMATION','CANCELLED'].includes(data.status) ? data.status : 'FAILED';
    const result = data.result || {};
    const stamp = now();
    let collectedMessageWrites = [];
    let collectionCompletionCommitted = false;
    if (job.job_type === 'COLLECT_MESSAGES') {
      try {
        db.exec('BEGIN IMMEDIATE');
        const collectedMessages = Array.isArray(result.messages) ? result.messages : [];
        for (const message of collectedMessages) {
          // Every collected message is persisted without starting reply work.
          // The whole batch, event ledger and terminal Job state commit together;
          // reply generation is allowed only after that commit succeeds.
          const write = upsertCollectedMessage(
            { ...message, platformCode: payload.platformCode, accountId: payload.accountId },
            false,
            { deferReplyProcessing: true }
          );
          if (write && typeof write.then === 'function') throw new Error('COLLECTION_PERSISTENCE_MUST_BE_SYNCHRONOUS');
          collectedMessageWrites.push(write);
        }
        if (config.messageEventLedgerEnabled) {
          result.messageLedger = persistCollectedMessageLedger({
            payload,
            result,
            outerStatus,
            persistedMessages: collectedMessageWrites,
            jobId: id,
            collectedAt: stamp
          });
        } else {
          // 通道健康状态不依赖 V2 消息账本开关。即使仍使用旧回复链路，
          // Web 也必须能区分“同步成功但为空”和“同步失败导致看起来为空”。
          result.channelRuntimeStates = persistCollectedMessageRuntimeStates({
            payload,
            result,
            outerStatus,
            jobId: id,
            completedAt: stamp
          });
        }
        run('UPDATE agent_jobs SET status=?,result=?,completed_at=?,lease_expires_at=NULL WHERE id=?', outerStatus, JSON.stringify(result), stamp, id);
        db.exec('COMMIT');
        collectionCompletionCommitted = true;
      } catch (error) {
        try { db.exec('ROLLBACK'); } catch {}
        const failureResult = {
          ...result,
          messageLedger: result.messageLedger || null,
          persistenceError: String(error?.message || error),
          originalCompletionStatus: outerStatus,
          message: `采集结果持久化失败：${String(error?.message || error)}`
        };
        run("UPDATE agent_jobs SET status='FAILED',result=?,completed_at=?,lease_expires_at=NULL WHERE id=?", JSON.stringify(failureResult), stamp, id);
        completeBrowserCommand(job, 'FAILED', failureResult, stamp);
        issue({ source: 'SYSTEM', category: 'MESSAGE_COLLECTION', title: `${payload.platformCode} 采集结果持久化失败`, detail: failureResult.message, relatedType: 'ACCOUNT', relatedId: payload.accountId, screenshotPath: result.screenshotPath, retryable: true });
        return fail(res, 500, failureResult.message);
      }

      // Reply scheduling is deliberately outside the persistence transaction.
      // A failure here must not turn a durably collected batch into a fake
      // collection failure or leave only half of the messages committed.
      result.replyBatchDrain = {};
      result.replyProcessingErrors = [];
      if (config.messageEventLedgerEnabled) {
        for (const ledgerResult of result.messageLedger || []) {
          if (!v2ReplyChannelEnabled(payload.platformCode, ledgerResult.channelType)) continue;
          try {
            result.replyBatchDrain[ledgerResult.channelType] = await drainV2ReplyBatches(ledgerResult.channelType, {
              platformCode: payload.platformCode,
              limit: 20
            });
          } catch (error) {
            result.replyProcessingErrors.push({ channelType: ledgerResult.channelType, stage: 'V2_BATCH_DRAIN', error: String(error?.message || error) });
          }
        }
      }
      for (const write of collectedMessageWrites) {
        const stored = write?.message;
        if (write?.deferredReplyProcessing !== true || !stored?.id) continue;
        if (v2ReplyChannelEnabled(payload.platformCode, stored.message_type)) continue;
        try {
          write.message = await processMessageWithRegistry(stored.id);
        } catch (error) {
          const reason = `采集已安全入库，但回复决策启动失败：${String(error?.message || error)}`;
          run(`UPDATE messages SET status='MANUAL_REQUIRED',decision='REPLY_PROCESSING_FAILED',reason=?,reply_job_id=NULL,updated_at=?
            WHERE id=? AND handled_at IS NULL AND status NOT IN ('AUTO_REPLIED','MANUAL_HANDLED','CLOSED','IGNORED_SELF','IGNORED_OFFICIAL','SOURCE_GONE','SUPERSEDED')`, reason, now(), stored.id);
          syncMessageProcessingRegistry(stored.id);
          result.replyProcessingErrors.push({ messageId: stored.id, channelType: stored.message_type, stage: 'LEGACY_REPLY_PROCESSING', error: String(error?.message || error) });
          issue({ source: 'SYSTEM', category: 'REPLY', title: `${payload.platformCode} 消息已入库但回复决策启动失败`, detail: reason, relatedType: 'MESSAGE', relatedId: stored.id, retryable: true });
        }
      }
      run('UPDATE agent_jobs SET result=? WHERE id=?', JSON.stringify(result), id);
    }
    if (job.job_type === 'REPLY') {
      db.exec('BEGIN IMMEDIATE');
      try {
        const currentJob = row('SELECT status FROM agent_jobs WHERE id=?', id);
        const currentMessage = row('SELECT reply_job_id FROM messages WHERE id=?', payload.messageId);
        const currentBatch = payload.replyBatchId ? row('SELECT status,agent_job_id FROM reply_batches WHERE id=?', Number(payload.replyBatchId)) : null;
        const ownsBatch = !payload.replyBatchId || (currentBatch?.status === 'SENDING' && Number(currentBatch.agent_job_id) === Number(id));
        const ownsMessage = currentJob?.status === 'RUNNING' && Number(currentMessage?.reply_job_id) === Number(id) && ownsBatch;
        if (!ownsMessage) {
          if (currentJob?.status === 'RUNNING') {
            run("UPDATE agent_jobs SET status='CANCELLED',result=?,completed_at=?,lease_expires_at=NULL WHERE id=? AND status='RUNNING'", JSON.stringify({ ...result, ignored: true, ignoreReason: 'STALE_REPLY_JOB_COMPLETION', currentReplyJobId: currentMessage?.reply_job_id || null }), stamp, id);
          }
          db.exec('COMMIT');
          return ok(res, { ignored: true, reason: 'STALE_REPLY_JOB_COMPLETION' });
        }
        run("UPDATE agent_jobs SET status=?,result=?,completed_at=?,lease_expires_at=NULL WHERE id=? AND status='RUNNING'", outerStatus, JSON.stringify(result), stamp, id);
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    } else if (job.job_type === 'DETECT_MANUAL_REPLY') {
      const completed = run("UPDATE agent_jobs SET status=?,result=?,completed_at=?,lease_expires_at=NULL WHERE id=? AND status='RUNNING'", outerStatus, JSON.stringify(result), stamp, id);
      if (completed.changes !== 1) return ok(res, { ignored: true, reason: 'STALE_MANUAL_REPLY_DETECTION' });
    } else if (job.job_type === 'COLLECT_MESSAGES' && collectionCompletionCommitted) {
      // Collection terminal state was committed atomically with messages and ledger.
    } else {
      run('UPDATE agent_jobs SET status=?,result=?,completed_at=?,lease_expires_at=NULL WHERE id=?', outerStatus, JSON.stringify(result), stamp, id);
    }
    completeBrowserCommand(job, outerStatus, result, stamp);
    if (job.job_type === 'DIAGNOSE_ISSUE') {
      await completeIssueDiagnosis({ diagnosisId: payload.diagnosisId, issueId: payload.issueId, evidence: result, outerStatus, stamp });
    }
    else if (job.job_type === 'RUN_SMOKE_TEST') {
      run("UPDATE agent_jobs SET status='CANCELLED',result=?,completed_at=? WHERE id=?", JSON.stringify({ message: '\u9875\u9762\u5de1\u68c0\u529f\u80fd\u5df2\u79fb\u9664\uff0c\u5386\u53f2\u4efb\u52a1\u5df2\u53d6\u6d88' }), stamp, id);
    }
    else if (job.job_type === 'PUBLISH') applyPublishCompletion(job, payload, result, outerStatus, stamp, id);
    else if (job.job_type === 'VERIFY_PUBLISH') applyReviewResult(payload, result, outerStatus, { sourceJobId: id });
    else if (job.job_type === 'COLLECT_MESSAGES') {
      // The content inventory is a sidecar index only. A malformed or stale
      // observation must never change collection/reply completion semantics.
      for (const observation of result.contentInventory || []) {
        try {
          const evidence = observation?.evidenceJson && typeof observation.evidenceJson === 'object' ? observation.evidenceJson : {};
          const requestedStatus = String(observation?.verificationStatus || 'OBSERVED').toUpperCase();
          const verificationStatus = requestedStatus === 'VERIFIED' && evidence.sourceVerified === true ? 'VERIFIED' : 'OBSERVED';
          upsertPlatformContentInventory({
            ...observation,
            platformCode: payload.platformCode,
            platformAccountKey: String(payload.accountId),
            verificationStatus,
            lastSeenAt: stamp,
            evidenceJson: { ...evidence, collectionJobId: id, accountId: payload.accountId, platformCode: payload.platformCode }
          });
        } catch (error) {
          console.warn('[platform-content-inventory] ignored invalid sidecar observation', {
            jobId: id,
            platformCode: payload.platformCode,
            accountId: payload.accountId,
            error: String(error?.message || error)
          });
        }
      }
      if (['bilibili', 'weibo'].includes(payload.platformCode) && outerStatus !== 'FAILED') {
        try {
          const saveCursor = payload.platformCode === 'bilibili' ? saveBilibiliCollectionWatermarks : saveWeiboCollectionWatermarks;
          const cursorResult = saveCursor(payload.accountId, result.collectionWatermarks, {
            successfulScopes: result.successfulScopeNames || [],
            partialScopes: result.partialScopeNames || [],
            stamp
          });
          result.collectionWatermarksSaved = cursorResult.savedScopes;
        } catch (error) {
          // Cursor persistence is a read-only sidecar. It must never turn a
          // successfully collected message batch into a failed collection job.
          console.warn(`[${payload.platformCode} collection cursor] save failed`, { jobId: id, accountId: payload.accountId, error: String(error?.message || error) });
          result.collectionWatermarkSaveError = '水位保存失败，下轮采集将继续使用旧水位';
        }
        run('UPDATE agent_jobs SET result=? WHERE id=?', JSON.stringify(result), id);
      }
      if (outerStatus === 'FAILED' && collectionFailureCreatesAccountBlock(result)) issue({ source: 'RPA', category: 'MESSAGE_COLLECTION', title: `${payload.platformCode} \u91c7\u96c6\u57fa\u7840\u8bbe\u65bd\u5931\u8d25`, detail: result.message || '\u91c7\u96c6\u5931\u8d25', relatedType: 'ACCOUNT', relatedId: payload.accountId, screenshotPath: result.screenshotPath, retryable: true });
    }
    else if (job.job_type === 'REPLY') {
      const message = row('SELECT * FROM messages WHERE id=?', payload.messageId);
      const sourceState = String(result.sourceState || result.status || '').toUpperCase();
      const isV2Reply = Boolean(payload.replyBatchId);
      let shouldDrainV2 = isV2Reply;
      if (message?.handled_at || terminalMessageStatuses.has(message?.status)) {
        const uncertainReason = '回复执行期间消息已被其他流程处理，平台实际发送结果需要人工核对';
        run("UPDATE agent_jobs SET status='CANCELLED',result=? WHERE id=?", JSON.stringify({ message: '人工已处理，自动回复结果忽略' }), id);
        if (isV2Reply) recordV2ReplyCompletion(payload, {
          batchStatus: 'SEND_UNCERTAIN', attemptState: 'SEND_UNCERTAIN', result,
          reason: uncertainReason, stamp, jobId: id
        });
      } else if (sourceState === 'SOURCE_GONE' || result.decision === 'SKIP_SOURCE_GONE') {
        markMessageSourceGone(payload.messageId, id, result, stamp);
        if (isV2Reply) recordV2ReplyCompletion(payload, {
          batchStatus: 'SOURCE_GONE', attemptState: 'CANCELLED_SOURCE_GONE', result,
          reason: result.message || 'SOURCE_GONE', stamp, jobId: id
        });
      } else if (sourceState === 'DEFERRED_PAGE_UNAVAILABLE' || result.decision === 'DEFERRED_PAGE_UNAVAILABLE') {
        markMessagePageDeferred(payload.messageId, id, result, stamp);
        if (isV2Reply) recordV2ReplyCompletion(payload, {
          batchStatus: 'PENDING', attemptState: 'NOT_SENT', result,
          reason: result.message || 'DEFERRED_PAGE_UNAVAILABLE', stamp, safeToRegenerate: true, jobId: id
        });
        shouldDrainV2 = false;
      } else if (hasReliableReplyEvidence(payload, result, outerStatus)) {
        if (payload.replyMode === 'MANUAL') {
          run("UPDATE messages SET status='MANUAL_HANDLED',decision='MANUAL_HANDLED',handled_at=?,handled_by=?,handler_note=?,updated_at=? WHERE id=? AND reply_job_id=? AND handled_at IS NULL", stamp, payload.handledBy || '\u8fd0\u8425\u4eba\u5458', result.message || '\u4eba\u5de5\u56de\u590d\u5df2\u53d1\u9001\uff0c\u5e76\u5df2\u9a8c\u8bc1\u5e73\u53f0\u56de\u6267', stamp, payload.messageId, id);
        } else {
          run("UPDATE messages SET status='AUTO_REPLIED',handled_at=?,handled_by='AI_RPA',handler_note=?,updated_at=? WHERE id=? AND reply_job_id=? AND handled_at IS NULL", stamp, result.message || '\u81ea\u52a8\u56de\u590d\u6210\u529f\uff0c\u5e76\u5df2\u9a8c\u8bc1\u5e73\u53f0\u56de\u6267', stamp, payload.messageId, id);
        }
        syncMessageProcessingRegistry(payload.messageId, stamp);
        if (isV2Reply) recordV2ReplyCompletion(payload, {
          batchStatus: 'COMPLETED', attemptState: 'VERIFIED', result,
          reason: null, stamp, jobId: id
        });
      } else {
        const reason = outerStatus === 'SUCCESS'
          ? 'RPA \u8fd4\u56de\u6210\u529f\uff0c\u4f46\u7f3a\u5c11\u53ef\u9a8c\u8bc1\u7684\u5e73\u53f0\u53d1\u9001\u56de\u6267\uff0c\u5df2\u8f6c\u4eba\u5de5\u9632\u6b62\u8bef\u5224\u6216\u91cd\u590d\u53d1\u9001'
          : (result.message || 'RPA \u56de\u590d\u53d1\u9001\u672a\u786e\u8ba4\uff0c\u5df2\u8f6c\u4eba\u5de5\u5904\u7406');
        if (outerStatus === 'SUCCESS' || isV2Reply) {
          run("UPDATE agent_jobs SET status='NEEDS_CONFIRMATION',result=? WHERE id=?", JSON.stringify({ ...result, attestationRejected: outerStatus === 'SUCCESS', attestationReason: reason }), id);
        }
        const failedDecision = payload.replyMode === 'MANUAL' ? 'MANUAL_REPLY' : 'TECHNICAL_ERROR';
        const timeoutFailure = payload.replyMode !== 'MANUAL' && isAiReplyTimeout(reason) ? describeAiReplyFailure(reason) : null;
        const messageUpdated = run("UPDATE messages SET status='MANUAL_REQUIRED',decision=?,reason=?,updated_at=? WHERE id=? AND reply_job_id=? AND handled_at IS NULL", failedDecision, timeoutFailure?.reason || reason, stamp, payload.messageId, id);
        if (isV2Reply) recordV2ReplyCompletion(payload, {
          batchStatus: 'SEND_UNCERTAIN', attemptState: 'SEND_UNCERTAIN', result,
          reason, stamp, jobId: id
        });
        if (messageUpdated.changes === 1) {
          issue({ source: 'RPA', category: 'REPLY', title: `${payload.platformCode} ${payload.replyMode === 'MANUAL' ? '\u4eba\u5de5' : '\u81ea\u52a8'}\u56de\u590d\u56de\u6267\u4e0d\u53ef\u4fe1`, detail: reason, relatedType: 'MESSAGE', relatedId: payload.messageId, screenshotPath: result.screenshotPath, retryable: outerStatus !== 'SUCCESS' });
          if (message && payload.replyMode !== 'MANUAL') await notifyManual(
            message, 'TECHNICAL_MANUAL', '\u81ea\u52a8\u56de\u590d\u9700\u4eba\u5de5\u6838\u5bf9', timeoutFailure?.reason || reason,
            timeoutFailure ? {
              titleSuffix: `｜${timeoutFailure.notificationTitle}`,
              actionText: timeoutFailure.notificationAction,
              reasonLabel: timeoutFailure.notificationReasonLabel
            } : {}
          );
        }
      }
      if (shouldDrainV2 && v2ReplyChannelEnabled(payload.platformCode, payload.channelType || payload.messageType)) {
        await drainV2ReplyBatches(payload.channelType || payload.messageType, { platformCode: payload.platformCode, limit: 20 });
      }
    }
    else if (job.job_type === 'DETECT_MANUAL_REPLY') {
      const hasOwnershipSnapshot = Object.prototype.hasOwnProperty.call(payload, 'replyJobIdAtCreation')
        && Object.prototype.hasOwnProperty.call(payload, 'latestReplyJobIdAtCreation')
        && Object.prototype.hasOwnProperty.call(payload, 'messageUpdatedAtAtCreation');
      const snapshotReplyJobId = Number(payload.replyJobIdAtCreation || 0);
      const snapshotLatestReplyJobId = Number(payload.latestReplyJobIdAtCreation || 0);
      const snapshotUpdatedAt = String(payload.messageUpdatedAtAtCreation || '');
      let messageUpdated = { changes: 0 };
      let detectedReply = null;
      if (hasOwnershipSnapshot && outerStatus === 'SUCCESS' && result.handled === true) {
        detectedReply = classifyDetectedReply(payload);
        const successNote = result.message || detectedReply.defaultNote;
        messageUpdated = run(`UPDATE messages SET status=?,decision=?,handled_at=?,handled_by=?,reason=?,handler_note=?,updated_at=?
          WHERE id=? AND handled_at IS NULL AND COALESCE(reply_job_id,0)=? AND COALESCE(updated_at,'')=?
            AND NOT EXISTS (SELECT 1 FROM agent_jobs newer_reply WHERE newer_reply.job_type='REPLY'
              AND CAST(json_extract(newer_reply.payload,'$.messageId') AS INTEGER)=? AND newer_reply.id>?)`,
          detectedReply.status, detectedReply.decision, stamp, detectedReply.handledBy, successNote, successNote, stamp,
          payload.messageId, snapshotReplyJobId, snapshotUpdatedAt, payload.messageId, snapshotLatestReplyJobId);
      } else if (hasOwnershipSnapshot) {
        messageUpdated = run(`UPDATE messages SET handler_note=?,updated_at=?
          WHERE id=? AND handled_at IS NULL AND COALESCE(reply_job_id,0)=? AND COALESCE(updated_at,'')=?
            AND NOT EXISTS (SELECT 1 FROM agent_jobs newer_reply WHERE newer_reply.job_type='REPLY'
              AND CAST(json_extract(newer_reply.payload,'$.messageId') AS INTEGER)=? AND newer_reply.id>?)`,
          result.message || '\u672a检测到指定人工回复', stamp, payload.messageId, snapshotReplyJobId, snapshotUpdatedAt, payload.messageId, snapshotLatestReplyJobId);
      }
      if (messageUpdated.changes === 1) syncMessageProcessingRegistry(payload.messageId, stamp);
      if (messageUpdated.changes !== 1) {
        run("UPDATE agent_jobs SET status='CANCELLED',result=?,lease_expires_at=NULL WHERE id=?", JSON.stringify({ ...result, ignored: true, ignoreReason: 'STALE_MANUAL_REPLY_DETECTION' }), id);
        return ok(res, { ignored: true, reason: 'STALE_MANUAL_REPLY_DETECTION' });
      }
      if (outerStatus === 'SUCCESS' && result.handled === true) {
        if (snapshotReplyJobId > 0) run("UPDATE agent_jobs SET status='CANCELLED',completed_at=?,result=? WHERE id=? AND status IN ('QUEUED','RUNNING')", stamp, JSON.stringify({ message: '已检测到目标回复，禁止自动补发' }), snapshotReplyJobId);
        resolveReplyReceiptIssues(payload.messageId, {
          stamp,
          detectionJobId: id,
          note: detectedReply?.automatic
            ? '已通过只读复核确认原自动回复实际发送成功'
            : '已通过只读复核确认平台侧回复实际存在'
        });
      } else if (outerStatus === 'FAILED') {
        issue({ source: 'RPA', category: 'MANUAL_REPLY_DETECTION', title: `${payload.platformCode} \u4eba工回复检测失败`, detail: result.message || 'RPA \u8fd4回失败', relatedType: 'MESSAGE', relatedId: payload.messageId, screenshotPath: result.screenshotPath, retryable: true });
      }
    }
    return ok(res);
  }
  return fail(res, 404, '接口不存在');
}

function staticFile(req, res, pathname) {
  let relative = pathname === '/' ? 'index.html' : pathname.replace(/^\//, ''); relative = path.normalize(relative).replace(/^(\.\.(\/|\\|$))+/, ''); const file = path.join(publicDir, relative);
  if (!file.startsWith(publicDir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { const fallback = path.join(publicDir, 'index.html'); res.writeHead(200, { 'Content-Type': mime['.html'], 'Cache-Control': 'no-store' }); return fs.createReadStream(fallback).pipe(res); }
  res.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' }); return fs.createReadStream(file).pipe(res);
}
function reconcileStuckSafeDeferredReplyMessages() {
  const stamp = now();
  let updated = 0;
  const candidates = rows(`SELECT m.id AS message_id,m.reply_job_id,j.job_type,j.status,j.result
    FROM messages m JOIN agent_jobs j ON j.id=m.reply_job_id
    WHERE m.handled_at IS NULL AND m.status IN ('REPLY_QUEUED','REPLY_RUNNING')
      AND j.status IN ('NEEDS_CONFIRMATION','FAILED')`);
  for (const candidate of candidates) {
    if (!isSafeDeferredReplyJob(candidate)) continue;
    const result = json(candidate.result, {});
    const changed = run(`UPDATE messages SET status='DEFERRED_PAGE_UNAVAILABLE',decision='DEFERRED_PAGE_UNAVAILABLE',
      reason=?,reply_job_id=NULL,updated_at=? WHERE id=? AND reply_job_id=? AND handled_at IS NULL`,
    result.message || '平台页面暂不可用，本次未发送，等待下次可靠采集后安全重试', stamp, candidate.message_id, candidate.reply_job_id);
    updated += Number(changed.changes || 0);
  }
  return updated;
}

const reconciledSafeDeferredReplies = reconcileStuckSafeDeferredReplyMessages();
if (reconciledSafeDeferredReplies > 0) console.log(`[reply recovery] restored ${reconciledSafeDeferredReplies} safely deferred message(s) for recollection`);
const reconciledOfficialMessages = reconcileExistingWeiboOfficialMessages();
if (reconciledOfficialMessages > 0) console.log(`[weibo messages] ignored ${reconciledOfficialMessages} existing official/system conversations`);
const reconciledLoginIssues = reconcileReadyAccountLoginIssues();
if (reconciledLoginIssues > 0) console.log(`[login monitor] auto-resolved ${reconciledLoginIssues} stale login issue(s) for accounts already READY`);

function applyCors(req, res) {
  const origin = String(req.headers.origin || '');
  if (!origin) return true;
  let sameOrigin = false;
  try {
    const parsed = new URL(origin);
    const requestProtocol = req.socket.encrypted ? 'https:' : 'http:';
    sameOrigin = parsed.protocol === requestProtocol && parsed.host.toLowerCase() === String(req.headers.host || '').toLowerCase();
  } catch {}
  if (!sameOrigin && !config.allowedOrigins.includes(origin)) return false;
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  return true;
}

if (config.authEnabled && (!config.adminPassword || !config.sessionSecret)) {
  throw new Error('AUTH_ENABLED=true 时必须配置 ADMIN_PASSWORD 和 SESSION_SECRET');
}
function isServerMainModule() {
  if (!process.argv[1]) return false;
  try {
    const entry = fs.realpathSync(process.argv[1]);
    const serverFile = fs.realpathSync(path.join(ROOT, 'src', 'server.js'));
    return process.platform === 'win32' ? entry.toLowerCase() === serverFile.toLowerCase() : entry === serverFile;
  } catch { return false; }
}
const formalRagClient = new RagClient();
const serverInstanceLock = acquireInstanceLock(config.databasePath + '.server.lock', { enabled: config.instanceLockEnabled, label: 'cloud-web' });
const server = http.createServer(async (req, res) => {
  if (!applyCors(req, res)) return fail(res, 403, '请求来源不在允许列表中', null, 'CORS_ORIGIN_DENIED');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Mini-App-Id, X-Timestamp, X-Nonce, X-Signature');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,PUT,DELETE,OPTIONS');
  try {
    let url;
    try { url = new URL(req.url, `http://${req.headers.host || 'localhost'}`); }
    catch {
      res.setHeader('Connection', 'close');
      req.resume();
      throw httpError(400, 'INVALID_REQUEST_TARGET', '请求地址无效');
    }
    if (url.pathname === MINI_PROGRAM_MESSAGE_PATH) {
      if (req.method !== 'POST') res.setHeader('Allow', 'POST');
      try {
        const result = await handleMiniProgramOpenMessage(req, url);
        return send(res, result.statusCode, result.body);
      } catch (error) {
        if (!req.complete) {
          res.setHeader('Connection', 'close');
          req.resume();
        }
        throw error;
      }
    }
    if (req.method === 'OPTIONS') return send(res, 204, '');
    if (isAiSignalProxyPath(url.pathname)) return await proxyAiSignal(req, res, url);
    if (url.pathname === '/video-workbench' || url.pathname.startsWith('/video-workbench/')) {
      if (url.pathname === '/video-workbench') { res.writeHead(302, { Location: '/video-workbench/' }); return res.end(); }
      return await videoStudioRequest(req, res);
    }
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    return staticFile(req, res, url.pathname);
  } catch (error) {
    const status = Number(error.statusCode) || 500;
    const code = error.code || (status === 500 ? 'INTERNAL_ERROR' : 'REQUEST_FAILED');
    if (status >= 500) console.error(error);
    return fail(res, status, status >= 500 ? '服务器处理失败' : error.message, status >= 500 ? null : error.detail, code);
  }
});
if (!operationsEnabled()) run("UPDATE devices SET status='OFFLINE' WHERE id=?", config.deviceId);
server.on('error', error => { stopMiniProgramWorkers(); serverInstanceLock.release(); console.error(`[cloud-web] 启动失败：${error.message}`); });
server.listen(config.port, config.host, () => {
  console.log(`Web MVP 已启动：http://${config.host}:${config.port}`);
  console.log(`\u6570\u636e\u5e93\uff1a${config.databasePath}`);
  const aiSettings = getAiSettingsSummary();
  const messageCollection = getMessageCollectionSettings();
  console.log(`AI 调用模式：${aiSettings.mode}`);
  startKnowledgeAliasWorker({ backfill: true });
  startManualHandoffAliasWorker({ backfill: true });
  startNotificationOutboxWorker();
  startScheduledPublishScheduler();
  if (isServerMainModule()) {
    startMiniProgramProcessingWorker({ processMessage: processMessageWithRegistry });
    startMiniProgramCallbackWorker();
    startMiniProgramNonceCleanupWorker();
    try { cleanupExpiredMiniProgramNonces(); } catch {}
  }
  console.log(`消息自动采集：${config.autoCollectEnabled ? `开启（每轮随机 ${Math.round(messageCollection.minMs / 60_000)}–${Math.round(messageCollection.maxMs / 60_000)} 分钟）` : '关闭'}`);
  startLocalAgentWatchdog();
  if (config.localAgentAutoStart && operationsEnabled()) {
    ensureLocalAgentOnline().then(result => {
      console.log(`[Local Agent] ${result.message}`);
    }).catch(error => {
      console.error(`[Local Agent] \u81ea\u52a8\u8fde\u63a5\u5931\u8d25\uff1a${error.message}`);
      saveMasterSwitch(false, '\u7cfb\u7edf\u542f\u52a8\u4fdd\u62a4');
      stopAutomaticMessageCollectionSchedule();
      console.error('[Local Agent] \u4e3a\u907f\u514d\u5168\u5c40\u8fd0\u884c\u4e0e\u6267\u884c\u7aef\u72b6\u6001\u4e0d\u4e00\u81f4\uff0c\u5df2\u81ea\u52a8\u5207\u6362\u4e3a\u5168\u5c40\u6682\u505c');
    });
  }
});

function reconcileExistingWeiboOfficialMessages() {
  const stamp = now();
  let updated = 0;
  for (const message of rows(`SELECT * FROM messages WHERE platform_code='weibo' AND message_type='PRIVATE_MESSAGE'
    AND handled_at IS NULL AND status NOT IN ('AUTO_REPLIED','MANUAL_HANDLED','CLOSED','IGNORED_SELF','IGNORED_OFFICIAL')`)) {
    const assessment = assessStoredWeiboSource(message);
    if (assessment?.isOfficial === true && assessment.confidence === 'HIGH') {
      markMessageIgnoredOfficial(message.id, assessment, json(message.context_json, {}), stamp);
      updated += 1;
    }
  }
  return updated;
}

function scheduleNextAutomaticMessageCollection() {
  if (!config.autoCollectEnabled || !operationsEnabled() || automaticMessageCollectionTimer) return;
  const interval = getMessageCollectionSettings();
  const delayMs = randomIntervalMs(interval.minMs, interval.maxMs);
  const scheduledAt = new Date(Date.now() + delayMs).toISOString();
  nextAutomaticMessageCollectionAt = scheduledAt;
  console.log(`[message collection] next automatic check in ${(delayMs / 60_000).toFixed(2)} min at ${scheduledAt}`);
  automaticMessageCollectionTimer = setTimeout(() => {
    automaticMessageCollectionTimer = null;
    nextAutomaticMessageCollectionAt = null;
    try {
      enqueueAutomaticMessageCollections();
    } catch (error) {
      console.error('[message collection] scheduling failed:', error);
    } finally {
      // Schedule the next cycle independently. An active or blocked account is
      // skipped by enqueueAutomaticMessageCollections without stopping other accounts.
      scheduleNextAutomaticMessageCollection();
    }
  }, delayMs);
  automaticMessageCollectionTimer.unref();
}

if (config.autoCollectEnabled && operationsEnabled()) { scheduleNextAutomaticMessageCollection(); startConversationRecoverySchedule(); }







let serverShuttingDown = false;
function stopMiniProgramWorkers() {
  stopMiniProgramProcessingWorker();
  stopMiniProgramCallbackWorker();
  stopMiniProgramNonceCleanupWorker();
}
async function shutdownServer(signal) {
  if (serverShuttingDown) return;
  serverShuttingDown = true;
  stopAutomaticMessageCollectionSchedule();
  stopConversationRecoverySchedule();
  stopNotificationOutboxWorker();
  stopScheduledPublishScheduler();
  stopMiniProgramWorkers();
  await new Promise(resolve => server.close(resolve));
  if (config.localAgentAutoStart) {
    const agentShutdown = await shutdownLocalAgent({ reason: `WEB_${signal}` });
    if (!agentShutdown.stopped) console.error(`[cloud-web] Local Agent did not fully stop: ${agentShutdown.error || agentShutdown.message}`);
  }
  serverInstanceLock.release();
  console.log(`[cloud-web] 已响应 ${signal} 并安全退出`);
}
process.on('exit', () => { stopMiniProgramWorkers(); serverInstanceLock.release(); });
process.on('SIGINT', () => { shutdownServer('SIGINT').then(() => process.exit(0)).catch(error => { console.error(error); process.exit(1); }); });
process.on('SIGTERM', () => { shutdownServer('SIGTERM').then(() => process.exit(0)).catch(error => { console.error(error); process.exit(1); }); });

