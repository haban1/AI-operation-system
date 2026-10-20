export function isPlatformRunnable(runtime) {
  return runtime?.effective_state === 'RUNNING';
}

export function stoppedPlatformStatus(platformCode, runtime = null) {
  const accountDisabled = runtime?.blocked_reason === 'NO_ENABLED_ACCOUNT';
  return {
    platformCode,
    browser: 'STOPPED',
    loggedIn: false,
    state: 'STOPPED',
    confidence: 'CONFIRMED',
    evidence: [accountDisabled ? 'no-enabled-account' : 'platform-runtime-stopped'],
    checkedAt: null,
    url: null,
    message: accountDisabled ? '平台没有启用账号，未打开浏览器或 Profile' : '平台运行开关已关闭，未打开浏览器或 Profile，也未执行登录检查',
    desiredState: runtime?.desired_state || 'STOPPED',
    effectiveState: runtime?.effective_state || 'STOPPED'
  };
}

export async function executeClaimedJobWithPlatformGuard({
  job,
  getRuntime,
  deferJob,
  resolveAdapter,
  executeAdapter
}) {
  const platformCode = job?.payload?.platformCode;
  let runtime;
  try {
    runtime = await getRuntime(platformCode);
  } catch (error) {
    runtime = { code: platformCode, desired_state: 'UNKNOWN', effective_state: 'STOPPED', blocked_reason: 'CONTROL_UNAVAILABLE', message: error.message };
  }
  const smokeJob = job?.job_type === 'RUN_SMOKE_TEST';
  const taskPaused = !smokeJob && runtime?.task_execution_state && runtime.task_execution_state !== 'RUNNING';
  if (!isPlatformRunnable(runtime) || taskPaused) {
    const blockedRuntime = taskPaused ? { ...runtime, blocked_reason: runtime.task_blocked_reason || 'PLATFORM_TASKS_PAUSED' } : runtime;
    await deferJob(job, blockedRuntime);
    return { deferred: true, runtime: blockedRuntime, output: null };
  }
  if (job?.job_type === 'REPLY' && runtime?.smart_reply_enabled === false) {
    const smartReplyRuntime = { ...runtime, blocked_reason: 'SMART_REPLY_STOPPED', smart_reply_effective_state: 'STOPPED' };
    await deferJob(job, smartReplyRuntime);
    return { deferred: true, runtime: smartReplyRuntime, output: null };
  }
  const adapter = resolveAdapter(job);
  const output = await executeAdapter(adapter, job);
  return { deferred: false, runtime, output };
}

