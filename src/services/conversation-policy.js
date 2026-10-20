// One historical round is a collected user question and its visible reply, if any.
// The current question is separate; this limit never counts clarification attempts.
export const CONVERSATION_HISTORY_MAX_TURNS = 3;
export const BUSINESS_GUIDANCE_MAX_ATTEMPTS = 3;

const GUIDANCE_DECISIONS = new Set(['SMALL_TALK', 'GREETING_GUIDANCE', 'KNOWLEDGE_GAP_GUIDANCE', 'AUTO_REPLY_PARTIAL_KNOWLEDGE', 'RAG_NEED_CLARIFICATION', 'RAG_CLARIFICATION_LIMIT', 'KNOWLEDGE_GUIDANCE_LIMIT']);

export function nextBusinessGuidanceAttempt(attempts = 0, limit = BUSINESS_GUIDANCE_MAX_ATTEMPTS) {
  return Math.min(Math.max(1, Number(limit) || BUSINESS_GUIDANCE_MAX_ATTEMPTS), Math.max(0, Number(attempts) || 0) + 1);
}

// Direct greetings preserve the counter. Only a business guidance advances it;
// an actual knowledge answer resets it. Both live and test sessions use this rule.
export function businessGuidanceProgress(result, currentAttempts = 0, { messageType = 'PRIVATE_MESSAGE', maxGuidanceAttempts = BUSINESS_GUIDANCE_MAX_ATTEMPTS } = {}) {
  const answered = result.action !== 'HANDOFF' && Boolean(result.replyText)
    && (result.ragStatus === 'ANSWERED' || ((result.matches || []).length > 0 && !(result.unknownQuestions || []).length));
  const guiding = String(messageType).toUpperCase() === 'PRIVATE_MESSAGE' && GUIDANCE_DECISIONS.has(result.decision);
  const attempts = answered ? 0 : guiding
    ? Math.min(maxGuidanceAttempts, Math.max(1, Number(result.guidanceAttempt) || nextBusinessGuidanceAttempt(currentAttempts, maxGuidanceAttempts)))
    : Math.max(0, Number(currentAttempts) || 0);
  return { answered, guiding, attempts };
}

// The business layer owns escalation; finding a grounded answer ends the guidance cycle.
export function enforceBusinessGuidanceLimit(result, { messageType = 'PRIVATE_MESSAGE', maxGuidanceAttempts = BUSINESS_GUIDANCE_MAX_ATTEMPTS } = {}) {
  const limit = Math.max(1, Number(maxGuidanceAttempts) || BUSINESS_GUIDANCE_MAX_ATTEMPTS);
  if (String(messageType).toUpperCase() !== 'PRIVATE_MESSAGE'
    || !result.handoffOffered || Number(result.guidanceAttempt || 0) < limit
    || (result.matches?.length && !result.unknownQuestions?.length) || result.ragStatus === 'ANSWERED') return result;
  return {
    ...result, action: 'HANDOFF',
    decision: result.decision === 'RAG_CLARIFICATION_LIMIT' ? result.decision : 'KNOWLEDGE_GUIDANCE_LIMIT',
    replyText: null, confidence: 0,
    reason: `连续${limit}轮引导后仍没有可靠知识答案，转人工处理`,
    responseMode: 'BUSINESS_GUIDANCE_HANDOFF', guidanceAttempt: limit, maxGuidanceAttempts: limit,
    handoffOffered: false, handoffRequested: true
  };
}
