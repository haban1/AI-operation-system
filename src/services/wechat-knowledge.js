import crypto from 'node:crypto';
import { validateFormalRagResponseSnapshot } from './formal-rag-routing.js';

const unavailable = '知识库暂时无法查询，请稍后再试。';
import { knowledgeConversationPreflight } from './knowledge-conversation.js';
import { knowledgeConsultationReply } from './knowledge-reply-text.js';
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

// The caller supplies conversation data, never a knowledge scope, model or URL.
export function buildWechatKnowledgeRequest(data, knowledgeBaseId) {
  const invalid = () => { throw Object.assign(new Error('微信知识查询格式无效'), { statusCode: 400 }); };
  if (!data || typeof data !== 'object' || Array.isArray(data)) invalid();
  const allowed = new Set(['text', 'accountId', 'conversationId', 'messageId', 'context']);
  if (Object.keys(data).some(key => !allowed.has(key))) invalid();
  const { text, accountId, conversationId, messageId, context = [] } = data;
  if (typeof text !== 'string' || !text.trim() || [...text].length > 4000) invalid();
  if (![accountId, conversationId].every(id => typeof id === 'string' && /^[a-f0-9]{64}$/.test(id))) invalid();
  if (typeof messageId !== 'string' || !/^\d{1,16}$/.test(messageId) || !Number.isSafeInteger(Number(messageId))) invalid();
  if (!Array.isArray(context) || context.length > 6 || context.length % 2) invalid();
  const history = context.map((item, i) => {
    if (!item || item.role !== (i % 2 ? 'ASSISTANT' : 'USER') || typeof item.text !== 'string'
        || !item.text.trim() || [...item.text].length > 4000) invalid();
    return { role: item.role, text: item.text.trim() };
  });
  if (history.reduce((n, item) => n + [...item.text].length, 0) > 12000) invalid();
  const id = 'wechat-kb-' + crypto.randomUUID();
  return {
    contractVersion: '1.0', requestId: id, traceId: id,
    snapshot: {
      conversationKey: `WECHAT_ROBOT:${digest([accountId, conversationId])}`,
      conversationVersion: Number(messageId),
      inputFingerprint: 'sha256:' + digest({ text: text.trim(), history, messageId }),
    },
    source: { platform: 'WECHAT_ROBOT', channelType: 'DIRECT_MESSAGE', accountId },
    knowledgeScope: { tenantId: 'local-default', knowledgeBaseId },
    query: { text: text.trim(), messageIds: [messageId] }, context: history,
    constraints: { language: 'zh-CN', answerFormat: 'PLAIN_TEXT', maxAnswerChars: 600, requireGrounding: true },
  };
}

export function createWechatKnowledgeQuery({ ragClient, knowledgeBaseId }) {
  return async data => {
    const request = buildWechatKnowledgeRequest(data, knowledgeBaseId);
    const presentation = knowledgeConversationPreflight(request);
    if (presentation) return { status: presentation.kind === 'SOCIAL' ? 'SOCIAL_REPLY' : 'NEED_CLARIFICATION', text: presentation.text, replyKind: presentation.kind };
    let result;
    try { result = await ragClient.queryFormalKnowledge(request); }
    catch { return { status: 'UNAVAILABLE', text: unavailable }; }
    if (!['ANSWERED', 'NO_ANSWER'].includes(result?.status)) return { status: 'UNAVAILABLE', text: unavailable };
    const snapshot = validateFormalRagResponseSnapshot(request, result);
    if (!snapshot.ok || result.meta?.knowledgeBaseId !== knowledgeBaseId
        || result.requestId !== request.requestId) return { status: 'UNAVAILABLE', text: unavailable };
    if (result.status === 'NO_ANSWER') return { status: 'NO_ANSWER', text: knowledgeConsultationReply(request.query.text, { context: request.context }), replyKind: 'CONSULTATION' };
    const text = result.answer?.text?.trim();
    const refs = result.grounding?.sourceReferences;
    if (!text || [...text].length > 4000 || !Array.isArray(refs) || !refs.length
        || refs.some(ref => !['VERIFIED', 'REPAIRED'].includes(ref.verificationStatus))) {
      return { status: 'UNAVAILABLE', text: unavailable };
    }
    return { status: 'ANSWERED', text, traceId: result.traceId };
  };
}
