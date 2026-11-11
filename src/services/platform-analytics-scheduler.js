const supportedPlatforms = ['douyin', 'wechat_channels', 'bilibili', 'weibo'];

// Analytics shares the existing platform locks and stays below operational
// work in priority. It never creates a publish, reply or login operation.
export function createPlatformAnalyticsScheduler({ db, createJob, canRunAccount, canRunBusinessJob = () => true,
  enabled = true, now = () => Date.now(), intervalMs = 30 * 60_000,
  setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let timer = null, started = false;
  function enqueue({ platformCode = null, force = false } = {}) {
    if (!enabled) return { jobs: [], paused: true, skipped: [] };
    const jobs = [], skipped = [], time = now();
    for (const account of db.prepare("SELECT * FROM accounts WHERE enabled=1 AND login_status='READY' ORDER BY id").all()) {
      if (!supportedPlatforms.includes(account.platform_code) || (platformCode && platformCode !== account.platform_code)) continue;
      if (!canRunAccount(account)) { skipped.push({ accountId: account.id, reason: 'PLATFORM_PAUSED' }); continue; }
      const active = db.prepare("SELECT id FROM agent_jobs WHERE job_type='COLLECT_ANALYTICS' AND status IN ('QUEUED','RUNNING') AND CAST(json_extract(payload,'$.accountId') AS INTEGER)=? LIMIT 1").get(account.id);
      if (active) { jobs.push({ accountId: account.id, platformCode: account.platform_code, jobId: active.id, reused: true }); continue; }
      const urgent = db.prepare("SELECT * FROM agent_jobs WHERE (status='RUNNING' OR (status='QUEUED' AND COALESCE(available_at,created_at)<=?)) AND job_type<>'COLLECT_ANALYTICS' AND json_extract(payload,'$.platformCode')=?").all(new Date(time).toISOString(), account.platform_code)
        .find(job => job.status === 'RUNNING' || canRunBusinessJob(job));
      if (urgent && !force) { skipped.push({ accountId: account.id, reason: 'BUSINESS_OPERATION_PENDING' }); continue; }
      const last = db.prepare("SELECT created_at FROM agent_jobs WHERE job_type='COLLECT_ANALYTICS' AND CAST(json_extract(payload,'$.accountId') AS INTEGER)=? ORDER BY id DESC LIMIT 1").get(account.id);
      // A manual click can retry stale data but cannot create a burst of scans.
      const minimumGap = force ? 60_000 : intervalMs;
      if (last && time - Date.parse(last.created_at) < minimumGap) { skipped.push({ accountId: account.id, reason: 'RECENTLY_COLLECTED' }); continue; }
      const jobId = createJob(account.device_id, 'COLLECT_ANALYTICS', { platformCode: account.platform_code,
        accountId: account.id, profileName: account.profile_name, queueLane: 'GENERAL', safeReadOnly: true },
      { priority: 100, idempotencyKey: `analytics:${account.id}:${Math.floor(time / minimumGap)}` });
      jobs.push({ accountId: account.id, platformCode: account.platform_code, jobId, reused: false });
    }
    return { jobs, skipped, paused: false };
  }
  function schedule(delay) {
    if (!started) return;
    timer = setTimer(() => {
      timer = null;
      try { enqueue(); } catch (error) { console.warn('[platform analytics] scheduling failed:', error.message); }
      schedule(Math.min(intervalMs, 60_000));
    }, delay);
    timer?.unref?.();
  }
  return { enqueue,
    start() { if (started || !enabled) return; started = true; schedule(15_000); },
    stop() { started = false; if (timer !== null) clearTimer(timer); timer = null; }
  };
}
