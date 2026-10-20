import { RAG_CONTRACT_VERSION, RAG_RESULT } from './rag-client.js';

export { RAG_CONTRACT_VERSION, RAG_RESULT };

export function validateFormalRagRequest(request = {}) {
  const errors = [];
  if (request.contractVersion !== RAG_CONTRACT_VERSION) errors.push('contractVersion 必须为 1.0');
  if (!String(request.requestId || '').trim()) errors.push('requestId 不能为空');
  if (!String(request.traceId || '').trim()) errors.push('traceId 不能为空');
  if (!String(request.snapshot?.conversationKey || '').trim()) errors.push('snapshot.conversationKey 不能为空');
  if (!Number.isInteger(Number(request.snapshot?.conversationVersion))) errors.push('snapshot.conversationVersion 必须是整数');
  if (!String(request.snapshot?.inputFingerprint || '').startsWith('sha256:')) errors.push('snapshot.inputFingerprint 必须是 sha256 指纹');
  if (!['DOUYIN', 'WEIBO', 'BILIBILI', 'WECHAT_CHANNELS'].includes(request.source?.platform)) errors.push('source.platform 不合法');
  if (!String(request.source?.accountId || '').trim()) errors.push('source.accountId 不能为空');
  if (!['COMMENT', 'DIRECT_MESSAGE'].includes(request.source?.channelType)) errors.push('source.channelType 不合法');
  if (!String(request.knowledgeScope?.tenantId || '').trim()) errors.push('knowledgeScope.tenantId 不能为空');
  if (!String(request.knowledgeScope?.knowledgeBaseId || '').trim()) errors.push('knowledgeScope.knowledgeBaseId 不能为空');
  if (!String(request.query?.text || '').trim()) errors.push('query.text 不能为空');
  if (request.constraints?.requireGrounding !== true) errors.push('constraints.requireGrounding 必须为 true');
  return { ok: errors.length === 0, errors };
}

export function normalizeRagAnswer(response = {}) {
  const status = String(response.result || response.status || '').trim().toUpperCase();
  return {
    status: status || RAG_RESULT.INVALID_RESPONSE,
    answerable: status === RAG_RESULT.ANSWERED && Boolean(String(response.answer?.text || '').trim()),
    answerText: String(response.answer?.text || '').trim() || null,
    sourceReferences: Array.isArray(response.grounding?.sourceReferences)
      ? response.grounding.sourceReferences
      : (Array.isArray(response.sourceReferences) ? response.sourceReferences : []),
    knowledgeVersion: response.knowledgeVersion || response.meta?.knowledgeVersion || null,
    raw: response
  };
}
