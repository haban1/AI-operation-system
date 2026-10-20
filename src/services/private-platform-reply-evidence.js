function clean(value) {
  return String(value ?? '').trim();
}

// This records an observed platform reply, without attributing its sender or
// claiming that the reply answered the user's question correctly.
export function assessCollectedPrivatePlatformReply({ platformCode, messageType, context = {} } = {}) {
  if (platformCode !== 'douyin' || String(messageType || '').toUpperCase() !== 'PRIVATE_MESSAGE') return { requested: false, verified: false };
  const requested = context.platformReplyDetected === true || context.alreadyHandled === true || Boolean(context.platformReplyEvidence);
  if (!requested) return { requested: false, verified: false };
  const fail = reason => ({ requested: true, verified: false, reason });
  const evidence = context.platformReplyEvidence || {};
  const conversationId = clean(context.conversationId || context.conversationKey);
  const messageId = clean(context.messageId);
  const replyText = clean(context.platformReplyText);
  if (context.platformReplyDetected !== true || context.alreadyHandled !== true
      || clean(context.direction).toLowerCase() !== 'incoming'
      || context.collectionSource !== 'OPEN_CONVERSATION_TIMELINE'
      || context.fullSource !== true || context.sourceVerified !== true
      || context.chatTitleVerified !== true || context.previewOnly !== false) return fail('PRIVATE_SOURCE_NOT_VERIFIED');
  if (!conversationId || !messageId || clean(evidence.conversationId) !== conversationId
      || (clean(context.conversationKey) && clean(context.conversationKey) !== conversationId)
      || clean(evidence.incomingMessageId) !== messageId) return fail('PLATFORM_REPLY_IDENTITY_MISMATCH');
  if (!clean(evidence.outgoingMessageId) || clean(evidence.outgoingMessageId) === messageId
      || clean(evidence.outgoingDirection).toLowerCase() !== 'outgoing' || !replyText) return fail('PLATFORM_OUTGOING_MESSAGE_NOT_VERIFIED');
  if (evidence.timelineStable !== true || !Number.isInteger(evidence.incomingIndex) || evidence.incomingIndex < 0
      || !Number.isInteger(evidence.outgoingIndex) || evidence.outgoingIndex <= evidence.incomingIndex) return fail('PLATFORM_REPLY_ORDER_NOT_VERIFIED');
  return { requested: true, verified: true, replyText, reason: 'PLATFORM_REPLY_DETECTED' };
}
