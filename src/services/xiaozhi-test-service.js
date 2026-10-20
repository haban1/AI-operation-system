import crypto from 'node:crypto';
import { config } from '../config.js';
import { rows } from '../db.js';
import { evaluateReply } from './reply-engine.js';
import { CONVERSATION_HISTORY_MAX_TURNS, enforceBusinessGuidanceLimit, nextBusinessGuidanceAttempt, businessGuidanceProgress } from './conversation-policy.js';
import { testConversationNamespace } from './conversation-identity.js';
import { RagClient, RAG_RESULT } from './rag-client.js';
import { formalRagReplyResult, routeBusinessClarification } from './formal-rag-routing.js';
import { outerRouteReplyResult, routeIncomingMessage } from './message-router.js';
import { enabledManualHandoffPhrases } from './manual-handoff-phrases.js';
import { createXiaozhiTestAnswer, getDisabledXiaozhiKnowledgeIds, getXiaozhiTestAnswer, listXiaozhiTestAnswers, listXiaozhiTestAnswerHistory, setXiaozhiTestAnswerDecision } from './xiaozhi-test-decisions.js';

const sessions = new Map();
const SESSION_TTL_MS = 4 * 60 * 60_000;
const supportedPlatforms = new Set(['douyin', 'wechat_channels', 'xiaohongshu', 'weibo', 'bilibili']);
const ragClient = new RagClient();

function clean(value = '') { return String(value || '').trim(); }
function ragModeEnabled() { return config.ragAdminEnabled === true; }
function cleanup() { const cutoff = Date.now() - SESSION_TTL_MS; for (const [id, session] of sessions) if (session.updatedAt < cutoff) sessions.delete(id); }
function ragError(result, fallback = 'RAG 管理服务请求失败') {
  const error = new Error(result?.error?.message || result?.raw?.detail?.message || fallback);
  error.code = result?.error?.code || 'RAG_ADMIN_REQUEST_FAILED';
  error.statusCode = Number(result?.httpStatus) || (result?.status === RAG_RESULT.NOT_CONFIGURED ? 503 : 502);
  error.detail = result?.raw || result?.error || null;
  error.ragResult = result;
  return error;
}
function requireRagResult(result, fallback) {
  if (!result || [RAG_RESULT.NOT_CONFIGURED, RAG_RESULT.UNAVAILABLE, RAG_RESULT.INVALID_RESPONSE].includes(result.status)) throw ragError(result, fallback);
  return result;
}
function normalizedCandidateDocuments({ candidateDocuments = [], selectedDocumentId = null, selectedDocumentVersion = null } = {}) {
  const values = Array.isArray(candidateDocuments) ? [...candidateDocuments] : [];
  if (clean(selectedDocumentId)) values.push({ documentId: clean(selectedDocumentId), documentVersion: Number(selectedDocumentVersion) || 1 });
  const unique = new Map();
  for (const item of values) {
    const documentId = clean(item?.documentId);
    if (!documentId) continue;
    const documentVersion = Number(item?.documentVersion) || 1;
    unique.set(`${documentId}:${documentVersion}`, { documentId, documentVersion });
  }
  return [...unique.values()];
}
function normalizedScope(value) { return ['pre_release', 'single_document'].includes(value) ? value : 'published'; }
function publicSession(session) {
  return {
    id: session.id, namespace: session.namespace, platformCode: session.platformCode, messageType: session.messageType,
    script: session.script, contextEnabled: session.contextEnabled, scope: session.scope, importBatchId: session.importBatchId,
    selectedDocumentId: session.selectedDocumentId || null, selectedDocumentVersion: session.selectedDocumentVersion || null,
    candidateDocuments: session.candidateDocuments || [], mode: session.mode || null, backend: session.backend,
    ragTestSessionId: session.ragTestSessionId || null,
    createdAt: new Date(session.createdAt).toISOString(), updatedAt: new Date(session.updatedAt).toISOString()
  };
}
function applySessionSettings(session, input = {}) {
  // RAG 测试使用统一知识范围，不再按平台区分；仅保留旧模式的平台兼容字段。
  if (!ragModeEnabled() && supportedPlatforms.has(input.platformCode)) session.platformCode = input.platformCode;
  if (input.messageType) session.messageType = String(input.messageType).toUpperCase() === 'COMMENT' ? 'COMMENT' : 'PRIVATE_MESSAGE';
  if (['auto', 'simplified', 'traditional'].includes(input.script)) session.script = input.script;
  if (typeof input.contextEnabled === 'boolean') session.contextEnabled = input.contextEnabled;
  if (input.scope) session.scope = ragModeEnabled() ? normalizedScope(input.scope) : (input.scope === 'import_batch' ? 'import_batch' : 'published');
  if (input.importBatchId !== undefined) session.importBatchId = Number(input.importBatchId) || null;
  if (ragModeEnabled() && session.scope === 'published') {
    session.selectedDocumentId = null;
    session.selectedDocumentVersion = null;
    session.candidateDocuments = [];
  } else {
    if (input.selectedDocumentId !== undefined) session.selectedDocumentId = clean(input.selectedDocumentId) || null;
    if (input.selectedDocumentVersion !== undefined) session.selectedDocumentVersion = Number(input.selectedDocumentVersion) || null;
    if (input.candidateDocuments !== undefined || input.selectedDocumentId !== undefined || input.selectedDocumentVersion !== undefined) {
      const candidateDocuments = input.candidateDocuments !== undefined ? input.candidateDocuments : [];
      session.candidateDocuments = normalizedCandidateDocuments({
        candidateDocuments,
        selectedDocumentId: session.selectedDocumentId,
        selectedDocumentVersion: session.selectedDocumentVersion
      });
    }
  }
  session.mode = session.scope === 'single_document' ? 'SINGLE_DOCUMENT' : 'PRE_RELEASE';
}
function scopeSignature(session) { return JSON.stringify({ mode: session.mode, candidates: session.candidateDocuments || [] }); }

export function createXiaozhiSession(input = {}) {
  cleanup();
  const id = crypto.randomUUID();
  const session = {
    id, namespace: testConversationNamespace(input.operatorId || 'admin', id), operatorId: clean(input.operatorId) || 'admin',
    platformCode: 'douyin', messageType: 'PRIVATE_MESSAGE', script: 'auto', contextEnabled: true,
    scope: 'published', importBatchId: null, selectedDocumentId: null, selectedDocumentVersion: null,
    candidateDocuments: [], mode: 'PRE_RELEASE', backend: ragModeEnabled() ? 'RAG' : 'LEGACY',
    ragTestSessionId: null, ragScopeSignature: null, history: [], clarificationAttempts: 0, nextSequenceNo: 0, createdAt: Date.now(), updatedAt: Date.now()
  };
  applySessionSettings(session, input);
  sessions.set(id, session);
  return publicSession(session);
}

export function getXiaozhiSession(sessionId, operatorId = 'admin') {
  cleanup(); const session = sessions.get(sessionId);
  if (!session || session.operatorId !== clean(operatorId)) return null;
  return publicSession(session);
}
export function deleteXiaozhiSession(sessionId, operatorId = 'admin') {
  const session = sessions.get(sessionId); if (!session || session.operatorId !== clean(operatorId)) return false; return sessions.delete(sessionId);
}

export async function getXiaozhiOptions() {
  const base = {
    // 统一 RAG 模式不需要平台选项；旧模式保留该字段以兼容历史调用方。
    platforms: ragModeEnabled() ? [] : rows("SELECT code,name FROM platforms WHERE code IN ('douyin','wechat_channels','xiaohongshu','weibo','bilibili') ORDER BY sort_order"),
    messageTypes: [{ code: 'PRIVATE_MESSAGE', name: '私信' }, { code: 'COMMENT', name: '评论' }],
    scripts: [{ code: 'auto', name: '自动跟随' }, { code: 'simplified', name: '简体中文' }, { code: 'traditional', name: '繁体中文' }],
    backend: ragModeEnabled() ? 'RAG' : 'LEGACY'
  };
  if (!ragModeEnabled()) return { ...base, importBatches: rows('SELECT id,file_name,status,total_rows,valid_rows,imported_rows,created_at,committed_at FROM knowledge_import_batches ORDER BY id DESC LIMIT 50'), ragDocuments: [] };
  const [documentResult, releaseResult] = await Promise.all([
    ragClient.listDocuments({ knowledgeBaseId: config.ragKnowledgeBaseId }),
    ragClient.listReleases({ knowledgeBaseId: config.ragKnowledgeBaseId })
  ]);
  requireRagResult(documentResult, '读取 RAG 文档列表失败');
  requireRagResult(releaseResult, '读取 RAG 发布版本失败');
  return {
    ...base, importBatches: [], activeRelease: releaseResult.active || null,
    ragDocuments: (documentResult.documents || []).filter(item => item.status === 'READY_FOR_TEST').map(item => ({
      documentId: item.documentId, documentVersion: item.documentVersion, title: item.title, filename: item.filename,
      status: item.status, createdAt: item.createdAt, updatedAt: item.updatedAt
    }))
  };
}

async function ensureRemoteTestSession(session) {
  const signature = scopeSignature(session);
  if (session.ragTestSessionId && session.ragScopeSignature === signature) return session.ragTestSessionId;
  if (session.scope !== 'published' && !(session.candidateDocuments || []).length) {
    const error = new Error('请选择一个待测试文档后再开始测试'); error.code = 'RAG_TEST_DOCUMENT_REQUIRED'; error.statusCode = 400; throw error;
  }
  if (session.mode === 'SINGLE_DOCUMENT' && session.candidateDocuments.length !== 1) {
    const error = new Error('单文档测试必须且只能选择一个文档'); error.code = 'RAG_SINGLE_DOCUMENT_REQUIRED'; error.statusCode = 400; throw error;
  }
  const result = requireRagResult(await ragClient.createTestSession({
    knowledgeBaseId: config.ragKnowledgeBaseId, mode: session.mode, candidateDocuments: session.candidateDocuments,
    operatorId: session.operatorId
  }), '创建 RAG 测试会话失败');
  session.ragTestSessionId = result.testSessionId;
  session.ragScopeSignature = signature;
  return session.ragTestSessionId;
}

async function runRagXiaozhiChat(session, content) {
  const startedAt = Date.now();
  const context = session.contextEnabled ? session.history.slice(-CONVERSATION_HISTORY_MAX_TURNS).flatMap(item => [
    { role: 'USER', messageId: `${item.id}:user`, text: item.content, sentAt: item.created_at },
    ...(item.reply_text ? [{ role: 'ASSISTANT', messageId: `${item.id}:assistant`, text: item.reply_text, sentAt: item.created_at }] : [])
  ]) : [];
  const guidanceOptions = {
    question: clean(content), context, messageType: session.messageType, script: session.script,
    guidanceAttempt: nextBusinessGuidanceAttempt(session.contextEnabled ? session.clarificationAttempts : 0, config.businessGuidanceMaxAttempts),
    maxGuidanceAttempts: config.businessGuidanceMaxAttempts
  };
  const preflight = routeXiaozhiMessage(session, content) || routeBusinessClarification(guidanceOptions);
  let result = null;
  if (!preflight) {
    try {
      const testSessionId = await ensureRemoteTestSession(session);
      result = await ragClient.queryTestKnowledge({ testSessionId, question: clean(content), context });
    } catch (error) {
      // Invalid test settings still need correction; service failures use the same
      // handoff decision as a live message, including remote session creation errors.
      if (!error.ragResult) throw error;
      result = error.ragResult;
    }
  }
  const queryAnalysis = result?.meta?.queryAnalysis || null;
  const retrievalConfidence = typeof result?.grounding?.confidence === 'number' && Number.isFinite(result.grounding.confidence) ? result.grounding.confidence : null;
  const answered = result?.status === RAG_RESULT.ANSWERED && clean(result.answer?.text);
  // 统一知识测试保留完整答案；无答案时复用正式消息的澄清/转人工判断。
  const fallback = preflight || (answered ? null : formalRagReplyResult(result, guidanceOptions));
  const replyText = answered ? clean(result.answer.text) : (fallback.replyText || fallback.reason);
  const responseMode = fallback?.responseMode || 'RAG_TEST';
  const guidanceAttempt = fallback?.guidanceAttempt || 0;
  const historyItem = {
    id: result?.answerId || crypto.randomUUID(), answer_id: result?.answerId || null, content: clean(content), reply_text: replyText,
    decision: answered ? 'RAG_ANSWERED' : fallback.decision, response_mode: responseMode, knowledge_id: null,
    approval_decision: result?.decision || 'ENABLED', decision_version: 1, decision_reason_code: null, decision_reason: null,
    source_references: result?.sourceReferences || result?.grounding?.sourceReferences || [], created_at: new Date().toISOString()
  };
  session.history.push(historyItem); if (session.history.length > 20) session.history.splice(0, session.history.length - 20); session.updatedAt = Date.now();
  return {
    session: publicSession(session), replyText, decision: historyItem.decision,
    confidence: answered ? Number(result.grounding?.confidence || 0) : fallback.confidence, reason: result?.reasonCode || (answered ? 'RAG 返回可靠答案' : fallback.reason),
    matchedKnowledgeIds: [], matches: [], sourceReferences: historyItem.source_references, unknownQuestions: answered ? [] : [clean(content)],
    responseMode, contextUsed: queryAnalysis?.contextUsed ?? context.length > 0, topicSwitched: false, matchMethod: preflight ? 'OUTER_ROUTER' : 'RAG', guidanceAttempt,
    queryAnalysis, retrievalConfidence, confidenceType: result?.grounding?.confidenceType || null, ragStatus: result?.status || 'NOT_QUERIED',
    maxGuidanceAttempts: config.businessGuidanceMaxAttempts, handoffOffered: fallback?.handoffOffered === true,
    clarificationCandidate: fallback?.clarificationCandidate || null,
    action: fallback?.action || 'REPLY', handoffRequested: fallback?.action === 'HANDOFF', answerId: result?.answerId || null,
    errorCode: fallback?.errorCode || null,
    approvalDecision: result?.decision || 'ENABLED', decisionVersion: 1, decisionReasonCode: null, decisionReason: null,
    knowledgeVersion: result?.meta?.knowledgeVersion || null, elapsedMs: Date.now() - startedAt, testOnly: true
  };
}

function routeXiaozhiMessage(session, content) {
  return outerRouteReplyResult(routeIncomingMessage({
    message: { content: clean(content), message_type: session.messageType },
    customHandoffPhrases: enabledManualHandoffPhrases()
  }));
}

async function runLegacyXiaozhiChat(session, content) {
  const startedAt = Date.now();
  const result = routeXiaozhiMessage(session, content) || enforceBusinessGuidanceLimit(await evaluateReply({
    message: { content: clean(content) }, platformCode: session.platformCode, messageType: session.messageType,
    recentMessages: session.contextEnabled ? session.history.slice(-CONVERSATION_HISTORY_MAX_TURNS) : [],
    guidanceAttemptOverride: nextBusinessGuidanceAttempt(session.contextEnabled ? session.clarificationAttempts : 0, config.businessGuidanceMaxAttempts),
    searchOptions: { ...(session.scope === 'import_batch' ? { importBatchId: session.importBatchId, includeDraftBatch: true } : {}), excludedKnowledgeIds: getDisabledXiaozhiKnowledgeIds() },
    taskId: `xiaozhi:${session.id}:${session.history.length + 1}`, script: session.script, maxGuidanceAttempts: config.businessGuidanceMaxAttempts
  }), { messageType: session.messageType, maxGuidanceAttempts: config.businessGuidanceMaxAttempts });
  const replyText = result.action === 'HANDOFF' ? result.reason : result.replyText;
  const answer = createXiaozhiTestAnswer({
    sessionId: session.id, operatorId: session.operatorId, sequenceNo: ++session.nextSequenceNo, question: clean(content), replyText,
    routeDecision: result.decision, responseMode: result.responseMode, platformCode: session.platformCode, messageType: session.messageType,
    scope: session.scope, importBatchId: session.importBatchId, matchedKnowledgeIds: (result.matches || []).map(item => Number(item.knowledge?.id)).filter(Boolean), sourceReferences: result.sourceReferences || []
  });
  const historyItem = {
    id: answer.answerId, answer_id: answer.answerId, content: clean(content), reply_text: replyText, decision: result.decision,
    response_mode: result.responseMode, knowledge_id: result.bestKnowledge?.id || null, knowledge_question_snapshot: result.bestKnowledge?.question || null,
    knowledge_answer_snapshot: result.bestKnowledge?.answer || null, approval_decision: answer.decision, decision_version: answer.decisionVersion,
    decision_reason_code: answer.reasonCode, decision_reason: answer.reason, created_at: new Date().toISOString()
  };
  session.history.push(historyItem); if (session.history.length > 20) session.history.splice(0, session.history.length - 20); session.updatedAt = Date.now();
  return {
    session: publicSession(session), replyText, decision: result.decision, confidence: result.confidence, reason: result.reason,
    matchedKnowledgeIds: (result.matches || []).map(item => Number(item.knowledge.id)),
    matches: (result.matches || []).map(item => ({ knowledgeId: Number(item.knowledge.id), question: item.knowledge.question, answer: item.knowledge.answer, confidence: item.confidence, matchedQuestion: item.question, resolvedQuestion: item.resolvedQuestion, matchMethod: item.matchMethod, contextUsed: item.contextUsed })),
    unknownQuestions: result.unknownQuestions || [], responseMode: result.responseMode, contextUsed: result.contextUsed, topicSwitched: result.topicSwitched,
    matchMethod: result.matchMethod, guidanceAttempt: result.guidanceAttempt || 0, maxGuidanceAttempts: result.maxGuidanceAttempts || config.businessGuidanceMaxAttempts,
    handoffOffered: result.handoffOffered === true, action: result.action || 'REPLY', handoffRequested: result.action === 'HANDOFF',
    answerId: answer.answerId, approvalDecision: answer.decision, decisionVersion: answer.decisionVersion,
    decisionReasonCode: answer.reasonCode, decisionReason: answer.reason, elapsedMs: Date.now() - startedAt, testOnly: true
  };
}

export async function runXiaozhiChat(input = {}) {
  cleanup(); let session = sessions.get(input.sessionId);
  if (!session || session.operatorId !== clean(input.operatorId || 'admin')) { const created = createXiaozhiSession(input); session = sessions.get(created.id); }
  if (!clean(input.content)) throw new Error('请输入要测试的问题');
  applySessionSettings(session, input);
  if (session.contextEnabled && session.handoffResult) {
    session.updatedAt = Date.now();
    return {
      ...session.handoffResult, session: publicSession(session), answerId: null, elapsedMs: 0, contextUsed: true,
      replyText: '本测试会话已判定转人工，请新建对话后再测试自动回复。'
    };
  }
  const result = await (ragModeEnabled() ? runRagXiaozhiChat(session, input.content) : runLegacyXiaozhiChat(session, input.content));
  if (session.contextEnabled) {
    session.clarificationAttempts = businessGuidanceProgress(result, session.clarificationAttempts, { messageType: session.messageType, maxGuidanceAttempts: config.businessGuidanceMaxAttempts }).attempts;
    if (result.action === 'HANDOFF') session.handoffResult = result;
  }
  return result;
}

export async function updateXiaozhiTestAnswerDecision({ sessionId, answerId, operatorId = 'admin', decision, reasonCode = null, reason = null } = {}) {
  const publicValue = getXiaozhiSession(sessionId, operatorId);
  if (!publicValue) { const error = new Error('小智测试会话不存在或已过期'); error.code = 'XIAOZHI_SESSION_NOT_FOUND'; error.statusCode = 404; throw error; }
  const session = sessions.get(sessionId);
  if (ragModeEnabled()) {
    const result = requireRagResult(await ragClient.updateTestDecision({ testSessionId: session.ragTestSessionId, answerId, decision, reasonCode, note: reason, operatorId }), '更新 RAG 测试答案状态失败');
    return { answerId: result.answerId, sessionId, decision: result.decision, reasonCode: result.reasonCode || null, reason: result.note || null, decisionVersion: result.decisionVersion, operatorId: result.operatorId || operatorId, updatedAt: result.updatedAt };
  }
  const answer = getXiaozhiTestAnswer(answerId);
  if (!answer || answer.sessionId !== sessionId) { const error = new Error('测试答案不属于当前会话'); error.code = 'XIAOZHI_ANSWER_NOT_FOUND'; error.statusCode = 404; throw error; }
  return setXiaozhiTestAnswerDecision(answerId, { operatorId, decision, reasonCode, reason });
}

export async function getXiaozhiTestAnswers(sessionId, operatorId = 'admin') {
  const publicValue = getXiaozhiSession(sessionId, operatorId);
  if (!publicValue) { const error = new Error('小智测试会话不存在或已过期'); error.code = 'XIAOZHI_SESSION_NOT_FOUND'; error.statusCode = 404; throw error; }
  const session = sessions.get(sessionId);
  if (ragModeEnabled()) {
    if (!session.ragTestSessionId) return [];
    const result = requireRagResult(await ragClient.listTestAnswers({ testSessionId: session.ragTestSessionId }), '读取 RAG 测试答案失败');
    return result.answers || [];
  }
  return listXiaozhiTestAnswers(sessionId, operatorId);
}

export async function getXiaozhiTestAnswerHistory(answerId, sessionId, operatorId = 'admin') {
  const publicValue = getXiaozhiSession(sessionId, operatorId);
  if (!publicValue) { const error = new Error('小智测试会话不存在或已过期'); error.code = 'XIAOZHI_SESSION_NOT_FOUND'; error.statusCode = 404; throw error; }
  const session = sessions.get(sessionId);
  if (ragModeEnabled()) {
    const result = requireRagResult(await ragClient.getTestAnswerHistory({ testSessionId: session.ragTestSessionId, answerId }), '读取 RAG 决策历史失败');
    return result.history || [];
  }
  const answer = getXiaozhiTestAnswer(answerId);
  if (!answer || answer.sessionId !== sessionId) { const error = new Error('测试答案不属于当前会话'); error.code = 'XIAOZHI_ANSWER_NOT_FOUND'; error.statusCode = 404; throw error; }
  return listXiaozhiTestAnswerHistory(answerId);
}

