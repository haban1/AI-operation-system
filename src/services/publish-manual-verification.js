export function isPublishSecurityChallenge(result = {}) {
  if (result.manualSecurityVerificationRequired === false) return false;
  return result.manualSecurityVerificationRequired === true
    || ['PLATFORM_SECURITY_VERIFICATION_REQUIRED', 'PUBLISH_SECURITY_VERIFICATION_REQUIRED'].includes(result.errorCode || result.code)
    || result.stage === 'publish_verification_required'
    || /平台要求人工安全验证|要求人工完成(?:账号或)?安全验证/.test(String(result.message || ''));
}

export function manualSecurityWaitResult(result = {}, submitAttempted = false) {
  return {
    ...result,
    originalStage: result.originalStage || result.stage || null,
    stage: 'publish_verification_required',
    errorCode: 'PLATFORM_SECURITY_VERIFICATION_REQUIRED',
    manualSecurityVerificationRequired: true,
    manualActionRequired: true,
    verificationRequired: false,
    submitAttempted,
    submissionStatus: submitAttempted ? 'UNKNOWN' : 'NOT_SUBMITTED',
    reviewStatus: 'UNKNOWN',
    safeToRetry: false,
    doNotRetry: true,
    message: '待人工安全验证发布：请在原平台完成安全验证并发布，再点击“我已发布，开始核验”。'
  };
}
