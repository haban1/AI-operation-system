const POLICY_BY_PLATFORM = Object.freeze({
  bilibili: Object.freeze({
    code: 'bilibili',
    verificationPolicyId: 'bilibili-publish-status-v1',
    allowedHosts: Object.freeze(['member.bilibili.com', 'www.bilibili.com', 'bilibili.com']),
    tabByStatus: Object.freeze({
      PUBLISHED: Object.freeze(['已通过']),
      REVIEWING: Object.freeze(['进行中']),
      REJECTED: Object.freeze(['未通过'])
    })
  }),
  douyin: Object.freeze({
    code: 'douyin',
    verificationPolicyId: 'douyin-publish-status-v1',
    allowedHosts: Object.freeze(['creator.douyin.com', 'www.douyin.com', 'douyin.com']),
    tabByStatus: Object.freeze({
      PUBLISHED: Object.freeze(['已发布']),
      REVIEWING: Object.freeze(['审核中']),
      REJECTED: Object.freeze(['未通过'])
    })
  }),
  wechat_channels: Object.freeze({
    code: 'wechat_channels',
    verificationPolicyId: 'wechat-channels-publish-status-v1',
    allowedHosts: Object.freeze(['channels.weixin.qq.com']),
    tabByStatus: Object.freeze({
      PUBLISHED: Object.freeze(['已发表']),
      REVIEWING: Object.freeze(['审核中']),
      REJECTED: Object.freeze(['未通过'])
    })
  }),
  weibo: Object.freeze({
    code: 'weibo',
    verificationPolicyId: 'weibo-publish-status-v1',
    allowedHosts: Object.freeze(['weibo.com', 'www.weibo.com']),
    tabByStatus: Object.freeze({})
  })
});

function clean(value) {
  return String(value || '').trim();
}

function integerOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : null;
}

function absoluteHostname(value) {
  const text = clean(value);
  if (!/^https?:\/\//i.test(text)) return null;
  try {
    return new URL(text).hostname.toLowerCase();
  } catch {
    return '__INVALID_URL__';
  }
}

function hostAllowed(hostname, allowedHosts = []) {
  return allowedHosts.some(host => hostname === host || hostname.endsWith(`.${host}`));
}

export function publishVerificationPolicy(platformCode) {
  return POLICY_BY_PLATFORM[clean(platformCode)] || null;
}

export function validatePublishTargetIdentity(payload = {}, target = {}) {
  const expectedPlatformCode = clean(target.platform_code);
  const payloadPlatformCode = clean(payload.platformCode);
  if (!expectedPlatformCode || !payloadPlatformCode || expectedPlatformCode !== payloadPlatformCode) {
    return {
      ok: false,
      reason: 'PLATFORM_CODE_MISMATCH',
      expectedPlatformCode,
      payloadPlatformCode
    };
  }

  const policy = publishVerificationPolicy(expectedPlatformCode);
  const payloadPolicyId = clean(payload.verificationPolicyId);
  if (payloadPolicyId && policy && payloadPolicyId !== policy.verificationPolicyId) {
    return {
      ok: false,
      reason: 'REQUEST_VERIFICATION_POLICY_MISMATCH',
      expectedPlatformCode,
      expectedPolicyId: policy.verificationPolicyId,
      payloadPolicyId
    };
  }

  const expectedTaskId = integerOrNull(target.task_id);
  const payloadTaskId = integerOrNull(payload.taskId);
  if (payloadTaskId !== null && expectedTaskId !== payloadTaskId) {
    return { ok: false, reason: 'TASK_ID_MISMATCH', expectedTaskId, payloadTaskId, expectedPlatformCode };
  }

  const expectedAccountId = integerOrNull(target.account_id);
  const payloadAccountId = integerOrNull(payload.accountId);
  if (payloadAccountId !== null && expectedAccountId !== payloadAccountId) {
    return { ok: false, reason: 'ACCOUNT_ID_MISMATCH', expectedAccountId, payloadAccountId, expectedPlatformCode };
  }

  return { ok: true, platformCode: expectedPlatformCode, taskId: expectedTaskId, accountId: expectedAccountId };
}

export function validatePlatformResultProvenance(platformCode, result = {}) {
  const expectedPlatformCode = clean(platformCode);
  const resultPlatformCode = clean(result.platformCode);
  if (resultPlatformCode && resultPlatformCode !== expectedPlatformCode) {
    return { ok: false, reason: 'RESULT_PLATFORM_MISMATCH', expectedPlatformCode, resultPlatformCode };
  }

  const policy = publishVerificationPolicy(expectedPlatformCode);
  if (!policy) return { ok: true, platformCode: expectedPlatformCode, policyId: null };

  const resultPolicyId = clean(result.verificationPolicyId);
  if (resultPolicyId && resultPolicyId !== policy.verificationPolicyId) {
    return {
      ok: false,
      reason: 'VERIFICATION_POLICY_MISMATCH',
      expectedPlatformCode,
      expectedPolicyId: policy.verificationPolicyId,
      resultPolicyId
    };
  }

  const hostname = absoluteHostname(result.platformUrl || result.url);
  if (hostname === '__INVALID_URL__' || (hostname && !hostAllowed(hostname, policy.allowedHosts))) {
    return {
      ok: false,
      reason: 'PLATFORM_URL_SCOPE_MISMATCH',
      expectedPlatformCode,
      hostname,
      allowedHosts: [...policy.allowedHosts]
    };
  }

  const reviewStatus = clean(result.reviewStatus).toUpperCase();
  const matchedRecordStatus = clean(result.matchedRecord?.reviewStatus).toUpperCase();
  if (reviewStatus && matchedRecordStatus && reviewStatus !== matchedRecordStatus) {
    return {
      ok: false,
      reason: 'REVIEW_STATUS_EVIDENCE_MISMATCH',
      expectedPlatformCode,
      reviewStatus,
      matchedRecordStatus
    };
  }

  const matchedTab = clean(result.matchedTab);
  const allowedTabs = policy.tabByStatus[reviewStatus] || [];
  if (matchedTab && allowedTabs.length && !allowedTabs.includes(matchedTab)) {
    return {
      ok: false,
      reason: 'REVIEW_TAB_STATUS_MISMATCH',
      expectedPlatformCode,
      reviewStatus,
      matchedTab,
      allowedTabs: [...allowedTabs]
    };
  }

  return { ok: true, platformCode: expectedPlatformCode, policyId: policy.verificationPolicyId };
}

export function shouldScheduleUnconfirmedPublishVerification({ platformCode, outerStatus, result = {}, target = {} } = {}) {
  if (clean(platformCode) !== 'bilibili') return false;
  if (clean(outerStatus).toUpperCase() !== 'NEEDS_CONFIRMATION') return false;
  if (clean(result.stage) !== 'publish_unconfirmed') return false;
  if (result.submitAttempted !== true || result.finalActionAuthorized !== true) return false;
  if (result.uploadFailed === true || clean(result.submissionStatus).toUpperCase() === 'NOT_SUBMITTED') return false;
  if (clean(target.platform_code) !== 'bilibili') return false;
  if (clean(target.submit_lock).toUpperCase() !== 'LOCKED') return false;
  const provenance = validatePlatformResultProvenance('bilibili', result);
  return provenance.ok;
}

export const PLATFORM_PUBLISH_VERIFICATION_POLICIES = POLICY_BY_PLATFORM;

