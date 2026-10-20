export const PLATFORM_DESIRED_RUNNING = 'RUNNING';
export const PLATFORM_DESIRED_STOPPED = 'STOPPED';

export function normalizePlatformDesiredState(value) {
  return String(value || '').toUpperCase() === PLATFORM_DESIRED_STOPPED
    ? PLATFORM_DESIRED_STOPPED
    : PLATFORM_DESIRED_RUNNING;
}

export function platformRuntimeRows({ rows, activePlatformCodes }) {
  const placeholders = activePlatformCodes.map(() => '?').join(',');
  return rows(`SELECT p.code,p.name,p.sort_order,
      COALESCE(p.desired_state,'RUNNING') AS desired_state,
      p.runtime_updated_at,p.runtime_updated_by,
      COALESCE(p.lifecycle_state,'ACTIVE') AS lifecycle_state,
      SUM(CASE WHEN a.enabled=1 THEN 1 ELSE 0 END) AS enabled_account_count,
      SUM(CASE WHEN a.enabled=1 AND a.login_status='READY' THEN 1 ELSE 0 END) AS ready_account_count,
      (SELECT COUNT(*) FROM agent_jobs j
        WHERE json_extract(j.payload,'$.platformCode')=p.code AND j.status='QUEUED') AS queued_job_count,
      (SELECT COUNT(*) FROM agent_jobs j
        WHERE json_extract(j.payload,'$.platformCode')=p.code AND j.status='RUNNING') AS running_job_count
    FROM platforms p
    LEFT JOIN accounts a ON a.platform_code=p.code
    WHERE p.code IN (${placeholders})
    GROUP BY p.code,p.name,p.sort_order,p.desired_state,p.runtime_updated_at,p.runtime_updated_by,p.lifecycle_state
    ORDER BY p.sort_order`, ...activePlatformCodes).map(item => {
    const desiredState = normalizePlatformDesiredState(item.desired_state);
    const accountEnabled = Number(item.enabled_account_count || 0) > 0;
    const lifecycleActive = item.lifecycle_state === 'ACTIVE';
    return {
      ...item,
      desired_state: desiredState,
      enabled_account_count: Number(item.enabled_account_count || 0),
      ready_account_count: Number(item.ready_account_count || 0),
      queued_job_count: Number(item.queued_job_count || 0),
      running_job_count: Number(item.running_job_count || 0),
      effective_state: desiredState === PLATFORM_DESIRED_RUNNING && accountEnabled && lifecycleActive ? 'RUNNING' : 'STOPPED',
      blocked_reason: !lifecycleActive ? 'PLATFORM_PLANNED' : desiredState === PLATFORM_DESIRED_STOPPED ? 'PLATFORM_STOPPED' : accountEnabled ? null : 'NO_ENABLED_ACCOUNT',
      task_execution_state: desiredState === PLATFORM_DESIRED_RUNNING && accountEnabled && lifecycleActive ? 'RUNNING' : 'PAUSED',
      task_blocked_reason: !lifecycleActive ? 'PLATFORM_PLANNED' : desiredState === PLATFORM_DESIRED_STOPPED ? 'PLATFORM_STOPPED' : accountEnabled ? null : 'NO_ENABLED_ACCOUNT'
    };
  });
}

export function platformRuntimeMap(options) {
  return Object.fromEntries(platformRuntimeRows(options).map(item => [item.code, item]));
}

export function isPlatformRuntimeEnabled(item) {
  return item?.effective_state === 'RUNNING';
}
