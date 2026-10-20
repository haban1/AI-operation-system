import crypto from 'node:crypto';
import { config } from '../config.js';
import { RAG_RESULT } from './rag-client.js';
import { getReplyLimit, validateReplyTextLength } from './platform-reply-policy.js';
import { BUSINESS_GUIDANCE_MAX_ATTEMPTS, CONVERSATION_HISTORY_MAX_TURNS, enforceBusinessGuidanceLimit } from './conversation-policy.js';
import { detectSmallTalkIntent, isAffirmativeReply, isNegativeReply } from './conversation-intent.js';
import { businessSubjectClarificationReply, ragClarificationReply } from './rag-clarification.js';
import { ragQuestionForMessage } from './message-source-context.js';
import { isAiReplyTimeout } from './ai-reply-error.js';

const PLATFORM_MAP = Object.freeze({
  douyin: 'DOUYIN',
  weibo: 'WEIBO',
  bilibili: 'BILIBILI',
  wechat_channels: 'WECHAT_CHANNELS'
});

function normalizePlatformCode(value) {
  const code = String(value || '').trim().toLowerCase();
  return PLATFORM_MAP[code] || 'DOUYIN';
}

function normalizeChannelType(value) {
  return String(value || '').trim().toUpperCase() === 'COMMENT' ? 'COMMENT' : 'DIRECT_MESSAGE';
}

function isoTimestamp(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function fingerprintPayload({ conversationKey, conversationVersion, queryText, messageIds, context }) {
  return JSON.stringify({ conversationKey, conversationVersion, queryText, messageIds, context });
}

export function buildFormalRagRequest({ message, conversation, recentMessages = [] } = {}) {
  const conversationKey = String(message?.conversation_key_snapshot || conversation?.namespace || `message:${message?.id || 'unknown'}`);
  const conversationVersion = Number(message?.conversation_version ?? conversation?.version ?? 0);
  const queryText = ragQuestionForMessage(message);
  // Comments are single-turn; a verified source topic stays in query.text only.
  const history = (message?.message_type === 'COMMENT' ? [] : (Array.isArray(recentMessages) ? recentMessages : []))
    .filter(item => item && item !== message && (item.id == null || String(item.id) !== String(message?.id)))
    .filter((item, index, list) => item.id == null || list.findIndex(candidate => String(candidate.id) === String(item.id)) === index)
    .slice(-CONVERSATION_HISTORY_MAX_TURNS);
  // Product policy keeps three rounds (at most six entries); the current question
  // belongs only in query so it cannot replace the preceding USER during retrieval.
  const turns = history.map(item => {
    const messageId = item.id == null ? null : String(item.id);
    const text = [...String(item.content || '').trim()].slice(0, 4000).join('');
    if (!text) return [];
    const turn = [{ messageId, role: 'USER', text, sentAt: isoTimestamp(item.created_at || item.collected_at) }];
    // reply_text exists while a send is still queued or failed. Only a confirmed
    // automatic reply is part of the conversation the customer actually saw.
    const reply = item.status === 'AUTO_REPLIED' ? [...String(item.reply_text || '').trim()].slice(0, 4000).join('') : '';
    if (reply) turn.push({ messageId: messageId == null ? null : `${messageId}:reply`, role: 'ASSISTANT', text: reply, sentAt: isoTimestamp(item.handled_at || item.updated_at) });
    return turn;
  }).filter(turn => turn.length);
  let contextChars = turns.flat().reduce((sum, item) => sum + [...item.text].length, 0);
  while (turns.length && contextChars > 12000) {
    contextChars -= turns.shift().reduce((sum, item) => sum + [...item.text].length, 0);
  }
  const context = turns.flat();
  const messageIds = [...turns.map(turn => turn[0].messageId), message?.id].filter(id => id != null).map(String);
  const maxAnswerChars = getReplyLimit(message?.platform_code, message?.message_type)?.safeMax ?? 600;
  const inputFingerprint = `sha256:${crypto.createHash('sha256').update(fingerprintPayload({ conversationKey, conversationVersion, queryText, messageIds, context })).digest('hex')}`;
  const runId = crypto.randomUUID();
  return {
    contractVersion: '1.0',
    requestId: `formal-rag-${runId}`,
    traceId: `message-${message?.id || 'unknown'}:${runId}`,
    snapshot: { conversationKey, conversationVersion, inputFingerprint },
    source: {
      platform: normalizePlatformCode(message?.platform_code),
      accountId: String(message?.account_id ?? 'local-default'),
      channelType: normalizeChannelType(message?.message_type)
    },
    // 平台仅作为来源元数据，不参与知识范围过滤；所有正式问答固定查询同一个 RAG 知识库。
    knowledgeScope: { tenantId: 'local-default', knowledgeBaseId: config.ragKnowledgeBaseId },
    query: {
      text: queryText,
      messageIds,
      lastMessageAt: isoTimestamp(message?.created_at || message?.collected_at || message?.updated_at)
    },
    context,
    constraints: { language: 'zh-CN', answerFormat: 'PLAIN_TEXT', maxAnswerChars, requireGrounding: true }
  };
}

export function validateFormalRagResponseSnapshot(request, response) {
  const expected = request?.snapshot;
  const actual = response?.snapshot;
  if (!actual) return { ok: false, code: 'RAG_SNAPSHOT_MISSING', reason: 'RAG 返回结果缺少会话快照' };
  if (String(actual.conversationKey || '') !== String(expected?.conversationKey || '')) return { ok: false, code: 'RAG_CONVERSATION_KEY_MISMATCH', reason: 'RAG 返回的会话标识与请求不一致' };
  if (Number(actual.conversationVersion) !== Number(expected?.conversationVersion)) return { ok: false, code: 'RAG_CONVERSATION_VERSION_MISMATCH', reason: 'RAG 返回的会话版本与请求不一致' };
  if (String(actual.inputFingerprint || '') !== String(expected?.inputFingerprint || '')) return { ok: false, code: 'RAG_INPUT_FINGERPRINT_MISMATCH', reason: 'RAG 返回的输入指纹与请求不一致' };
  return { ok: true, code: null, reason: null };
}

export function routeBusinessClarification({ question = '', context = [], messageType = 'PRIVATE_MESSAGE', script = 'auto', guidanceAttempt = 1, maxGuidanceAttempts = BUSINESS_GUIDANCE_MAX_ATTEMPTS } = {}) {
  if (String(messageType).toUpperCase() !== 'PRIVATE_MESSAGE') return null;
  const replyText = businessSubjectClarificationReply(question, { script });
  if (!replyText) return null;
  // Repeated vague requests and greetings do not establish a subject. Only the user's
  // history can supply it; a model's guessed business must never reset the counter.
  const hasSubject = context.some(item => {
    if (String(item.role).toUpperCase() !== 'USER') return false;
    const text = String(item.text || '').trim();
    if (!text || businessSubjectClarificationReply(text) || detectSmallTalkIntent(text).smallTalkOnly || isAffirmativeReply(text) || isNegativeReply(text)) return false;
    const compact = text.normalize('NFKC').replace(/[\s\p{P}\p{S}]+/gu, '');
    // An acknowledgement, uncertainty, or a request to ask something supplies no
    // business name. Keep arbitrary named businesses eligible for contextual RAG.
    return !/^(?:我)?(?:(?:也)?(?:不知道|不清楚|不明白|不了解|没有|沒有)|(?:想|要)?(?:咨询|諮詢|咨詢|问|問|了解)(?:一下|下)?(?:问题|問題|事情)?)$/u.test(compact);
  });
  if (hasSubject) return null;
  const limit = Math.max(1, Number(maxGuidanceAttempts) || BUSINESS_GUIDANCE_MAX_ATTEMPTS);
  const attempt = Math.min(limit, Math.max(1, Number(guidanceAttempt) || 1));
  return enforceBusinessGuidanceLimit({
    action: 'REPLY', decision: 'KNOWLEDGE_GAP_GUIDANCE', replyText, confidence: 0,
    reason: '业务对象尚未明确，需要补充业务或政策名称', responseMode: 'BUSINESS_CLARIFICATION',
    guidanceAttempt: attempt, maxGuidanceAttempts: limit, handoffOffered: attempt >= limit,
    ragStatus: 'NOT_QUERIED', matchMethod: 'OUTER_ROUTER'
  }, { messageType, maxGuidanceAttempts: limit });
}

export function formalRagReplyResult(response, { platformCode = '', messageType = 'PRIVATE_MESSAGE', question = '', context = [], script = 'auto', guidanceAttempt = 1, maxGuidanceAttempts = BUSINESS_GUIDANCE_MAX_ATTEMPTS } = {}) {
  const status = String(response?.status || response?.result || RAG_RESULT.INVALID_RESPONSE).toUpperCase();
  const isComment = String(messageType).toUpperCase() === 'COMMENT';
  const safeMax = Math.max(1, Number(maxGuidanceAttempts) || BUSINESS_GUIDANCE_MAX_ATTEMPTS);
  const safeAttempt = Math.min(safeMax, Math.max(1, Number(guidanceAttempt) || 1));
  const text = String(response?.answer?.text || '').trim();
  const length = validateReplyTextLength({ platformCode, messageType, text });
  const rejectedForLength = status === RAG_RESULT.NO_ANSWER && response?.reasonCode === 'ANSWER_TOO_LONG';
  if ((status === RAG_RESULT.ANSWERED && text && !length.ok) || rejectedForLength) {
    return {
      action: 'HANDOFF', decision: 'RAG_REPLY_TOO_LONG', replyText: null, confidence: 0,
      reason: rejectedForLength
        ? `知识库未能在当前回复上限${length.limit ? `（${length.limit} 字符）` : ''}内生成完整答案，转人工处理`
        : `${length.message}；为避免截断答案中的办理条件和步骤，转人工处理`,
      responseMode: 'FORMAL_RAG_HANDOFF', guidanceAttempt: 0, maxGuidanceAttempts: safeMax,
      handoffOffered: false, handoffRequested: true, ragStatus: status
    };
  }
  if (status === RAG_RESULT.ANSWERED && text) {
    return {
      action: 'REPLY', decision: 'RAG_ANSWERED', replyText: text,
      confidence: Number(response.grounding?.confidence ?? response.answer?.confidence ?? response.confidence ?? 1), reason: 'RAG 返回可靠答案',
      responseMode: 'FORMAL_RAG', guidanceAttempt: 0, maxGuidanceAttempts: safeMax, handoffOffered: false,
      ragStatus: status, sourceReferences: response.grounding?.sourceReferences || response.sourceReferences || response.answer?.sources || []
    };
  }
  if ([RAG_RESULT.NO_ANSWER, RAG_RESULT.NEED_CLARIFICATION, RAG_RESULT.REJECTED].includes(status)) {
    if (isComment) return { action: 'HANDOFF', decision: 'COMMENT_KNOWLEDGE_GAP', replyText: null, confidence: 0, reason: `评论知识库未提供可靠答案，直接转人工：${status}`, responseMode: 'COMMENT_HANDOFF', guidanceAttempt: 0, maxGuidanceAttempts: safeMax, handoffOffered: false, handoffRequested: true, ragStatus: status };
    const handoffOffered = safeAttempt >= safeMax;
    const clarification = handoffOffered ? null : ragClarificationReply(response, { question, context, script });
    return enforceBusinessGuidanceLimit({
      action: 'REPLY', decision: handoffOffered ? 'RAG_CLARIFICATION_LIMIT' : 'RAG_NEED_CLARIFICATION',
      replyText: clarification?.replyText || null,
      clarificationCandidate: clarification?.clarificationCandidate || null,
      confidence: 0, reason: `RAG 无可靠答案：${status}`, responseMode: 'RAG_CLARIFICATION', guidanceAttempt: safeAttempt,
      maxGuidanceAttempts: safeMax, handoffOffered, ragStatus: status
    }, { messageType, maxGuidanceAttempts: safeMax });
  }
  const timeout = isAiReplyTimeout(response?.error || {});
  return {
    action: 'HANDOFF', decision: timeout ? 'AI_REPLY_TIMEOUT' : 'RAG_SERVICE_UNAVAILABLE', replyText: null, confidence: 0,
    reason: timeout ? 'AI回复超时' : 'AI暂时无法提供有效回复，需要人工处理', responseMode: 'RAG_FAILURE', guidanceAttempt: 0,
    errorCode: timeout ? 'AI_TIMEOUT' : (response?.error?.code || 'RAG_INVALID_ANSWER'),
    maxGuidanceAttempts: safeMax, handoffOffered: false, handoffRequested: true, ragStatus: status, retryable: response?.retryable === true
  };
}
