import { routeIncomingMessage, MESSAGE_ROUTE } from './message-router.js';
import { routeBusinessClarification, formalRagReplyResult } from './formal-rag-routing.js';
import { knowledgeConsultationReply } from './knowledge-reply-text.js';

// Presentation stays separate from grounded RAG output; no fabricated sources/results.
export function knowledgeConversationPreflight(request) {
  const comment = request.source.channelType === 'COMMENT';
  const message = { content: request.query.text, message_type: comment ? 'COMMENT' : 'PRIVATE_MESSAGE', platform_code: request.source.platform.toLowerCase() };
  const route = routeIncomingMessage({ message });
  if (route.route === MESSAGE_ROUTE.DIRECT_REPLY) return { kind: 'SOCIAL', text: route.replyText };
  // The local tester/knowledge tool never executes risk or human handoff actions.
  // The actual channel retains its own reception/risk gates before this boundary.
  if (route.route === MESSAGE_ROUTE.HUMAN_HANDOFF) return { kind: 'HUMAN_GUIDANCE', text: '这个问题请联系人工客服协助处理。' };
  const clarification = routeBusinessClarification({ question: request.query.text, context: request.context, messageType: message.message_type });
  if (clarification?.action === 'REPLY') return { kind: 'CLARIFICATION', text: clarification.replyText };
  return null;
}

export function knowledgeAnswerPresentation(request, response) {
  if (response.result === 'ANSWERED' || response.status === 'ANSWERED') return { kind: 'GROUNDED', text: response.answer?.text || '' };
  const result = formalRagReplyResult(response, { question: request.query.text, context: request.context, platformCode: request.source.platform.toLowerCase(), messageType: request.source.channelType === 'COMMENT' ? 'COMMENT' : 'PRIVATE_MESSAGE' });
  return { kind: 'CONSULTATION', text: result.replyText || knowledgeConsultationReply(request.query.text, { context: request.context }) };
}
