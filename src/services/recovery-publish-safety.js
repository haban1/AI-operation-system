export const RECOVERY_PUBLISH_SAFETY_VERSION = 'recovery-publish-safety-2026.08.16.1';
export const BLOCKED_RECOVERY_JOB_TYPES = Object.freeze(new Set(['PUBLISH_STATUS_CHECK']));

export function isRecoveryJobTypeClaimable(jobType) {
  return !BLOCKED_RECOVERY_JOB_TYPES.has(String(jobType || '').trim().toUpperCase());
}

export function recoveryPublishPolicy(config = {}) {
  return Object.freeze({
    aiPageAdjudicationMode: String(config.aiPageAdjudicationMode || 'shadow').toLowerCase() === 'shadow' ? 'shadow' : 'shadow',
    aiDirectPublishAllowed: false,
    aiFinalClickAllowed: false,
    publishStatusPollingEnabled: false,
    version: RECOVERY_PUBLISH_SAFETY_VERSION
  });
}

export async function observePublishStateInShadow({ deterministicResult, observeWithAi } = {}) {
  let aiAudit = { status: 'SKIPPED', reason: 'AI_OBSERVER_NOT_CONFIGURED' };
  if (typeof observeWithAi === 'function') {
    try {
      const observation = await observeWithAi();
      aiAudit = { status: 'OBSERVED', observation };
    } catch (error) {
      aiAudit = { status: 'FAILED', reason: error?.name === 'AbortError' ? 'AI_TIMEOUT' : 'AI_SHADOW_FAILED', message: String(error?.message || error) };
    }
  }
  return {
    deterministicResult,
    aiAudit,
    aiAuthority: { mayBlock: false, maySetPublishSuccess: false, mayClickFinalPublish: false, mayRetry: false },
    policy: recoveryPublishPolicy()
  };
}

export function recoveryReplyPostActionPolicy({ exactReplyExists = false, writeAttempted = false, failureAfterWrite = false } = {}) {
  if (exactReplyExists) return Object.freeze({ action: 'SKIP_ALREADY_REPLIED', maySend: false, retryable: false });
  if (writeAttempted && failureAfterWrite) return Object.freeze({ action: 'NEEDS_CONFIRMATION', maySend: false, retryable: false });
  return Object.freeze({ action: 'PROCEED_DETERMINISTICALLY', maySend: true, retryable: false });
}
