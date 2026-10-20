const TIMEOUT_MESSAGE_PATTERN = /(?:operation was aborted|request aborted|timed?\s*out|timeout|超时)/i;

export function isAiReplyTimeout(error) {
  const name = String(error?.name || '').trim();
  const code = String(error?.code || error?.cause?.code || '').trim().toUpperCase();
  const message = String(error?.message || error || '').trim();
  return ['AbortError', 'TimeoutError'].includes(name) || ['AI_TIMEOUT', 'RAG_EXECUTION_TIMEOUT', 'RAG_TIMEOUT'].includes(code) || TIMEOUT_MESSAGE_PATTERN.test(message);
}

export function describeAiReplyFailure(error) {
  const timeout = isAiReplyTimeout(error);
  const rawMessage = String(error?.message || error || 'AI 服务处理异常').trim();
  if (timeout) {
    return {
      timeout: true,
      decision: 'AI_REPLY_TIMEOUT',
      errorCode: 'AI_TIMEOUT',
      reason: 'AI回复超时',
      issueTitle: 'AI 回复超时',
      notificationType: 'AI_REPLY_TIMEOUT',
      notificationTitle: 'AI回复超时',
      notificationAction: '请人工核对并处理',
      notificationReasonLabel: '超时说明',
      rawMessage
    };
  }
  return {
    timeout: false,
    decision: 'TECHNICAL_ERROR',
    errorCode: 'AI_REQUEST_FAILED',
    reason: rawMessage || 'AI 服务处理异常，需要人工处理。',
    issueTitle: '知识库语义匹配或回复生成异常',
    notificationType: 'TECHNICAL_MANUAL',
    notificationTitle: '模型异常需人工处理',
    notificationAction: '需要转人工',
    notificationReasonLabel: '转人工原因',
    rawMessage
  };
}
