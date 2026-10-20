export function jobQueueLane(job = {}) {
  const payload = job.payload || {};
  const explicit = String(payload.queueLane || payload.channelType || payload.messageType || '').trim().toUpperCase();
  if (['COMMENT', 'PRIVATE_MESSAGE', 'COMBINED', 'GENERAL'].includes(explicit)) return explicit;
  const type = String(job.job_type || job.jobType || '').trim().toUpperCase();
  if (['PUBLISH', 'VERIFY_PUBLISH'].includes(type)) return 'COMMENT';
  if (type === 'COLLECT_MESSAGES') return 'COMBINED';
  return 'GENERAL';
}

export function jobOperationLockMode(job = {}) {
  const type = String(job.job_type || job.jobType || '').trim().toUpperCase();
  const lane = jobQueueLane(job);
  if (type === 'COLLECT_MESSAGES') {
    if (lane === 'COMMENT') return 'READ_COMMENT';
    if (lane === 'PRIVATE_MESSAGE') return 'READ_PRIVATE';
  }
  if (type === 'DETECT_MANUAL_REPLY') return lane === 'COMMENT' ? 'READ_COMMENT' : 'READ_PRIVATE';
  if (type === 'REPLY') return lane === 'COMMENT' ? 'WRITE_COMMENT' : 'WRITE_PRIVATE';
  return 'EXCLUSIVE';
}

export function platformWorkerPlans(platformCode, { splitEnabled = false } = {}) {
  if (!splitEnabled) return [{ platformCode, name: platformCode, queueLanes: null }];
  return [
    { platformCode, name: `${platformCode}:private`, queueLanes: ['PRIVATE_MESSAGE'] },
    { platformCode, name: `${platformCode}:comment`, queueLanes: ['COMMENT'] },
    { platformCode, name: `${platformCode}:general`, queueLanes: ['GENERAL', 'COMBINED'] }
  ];
}
