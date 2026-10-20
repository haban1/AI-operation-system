export function isStrongConfirmedState(status, expectedState) {
  if (!status || status.state !== expectedState || status.confidence !== 'CONFIRMED') return false;
  const evidence = Array.isArray(status.evidence) ? status.evidence : [];
  if (expectedState === 'LOGIN') {
    return evidence.some(item => item === 'login-url' || item === 'login-text' || String(item).startsWith('logged-out-selector:'));
  }
  if (expectedState === 'READY') {
    return evidence.includes('authenticated-url') && evidence.some(item => item === 'authenticated-text' || String(item).startsWith('authenticated-selector:'));
  }
  return true;
}

function uniqueEvidence(samples) {
  return [...new Set(samples.flatMap(item => Array.isArray(item?.evidence) ? item.evidence : []))];
}

export async function checkLoginPrecisely({
  check,
  recheck = check,
  mode = 'MANUAL',
  logoutConfirmations = 3,
  confirmDelayMs = 2_000,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
}) {
  const first = await check();
  const base = { ...first, checkMode: mode, confirmedSamples: isStrongConfirmedState(first, first.state) ? 1 : 0 };
  if (first.state !== 'LOGIN' || !isStrongConfirmedState(first, 'LOGIN')) return base;

  const required = Math.max(2, Math.min(5, Number(logoutConfirmations) || 3));
  const samples = [first];
  while (samples.length < required) {
    await sleep(Math.max(250, Number(confirmDelayMs) || 2_000));
    // The first check may navigate to a protected page to verify whether the
    // session is still valid. Follow-up samples must only inspect the page
    // already on screen; navigating again would continuously regenerate a QR
    // code and make manual scanning impossible.
    const next = await recheck();
    samples.push(next);
    if (!isStrongConfirmedState(next, 'LOGIN')) {
      return {
        ...next,
        loggedIn: false,
        state: 'UNKNOWN',
        confidence: 'UNCONFIRMED',
        evidence: [...uniqueEvidence(samples), `unstable-login-samples:${samples.map(item => item?.state || 'ERROR').join('>')}`],
        checkedAt: next?.checkedAt || new Date().toISOString(),
        message: '连续复核结果不一致，登录状态暂不下结论',
        checkMode: mode,
        confirmedSamples: 0
      };
    }
  }

  const last = samples.at(-1);
  return {
    ...last,
    evidence: [...uniqueEvidence(samples), `consecutive-login-confirmations:${required}`],
    checkMode: mode,
    confirmedSamples: required,
    message: `${last.message || '已确认未登录'}（连续 ${required} 次证据一致）`
  };
}
