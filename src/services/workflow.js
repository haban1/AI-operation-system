import crypto from 'node:crypto';

export function hashString(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

export function buildPublishIdempotencyKey({ targets = [], materialSha = '', title = '', body = '', retryOfTaskId = null } = {}) {
  const targetKey = targets.map(item => `${item.accountId}:${item.platformCode}`).sort().join('|');
  const parts = [targetKey, materialSha, String(title).trim(), String(body).trim()];
  if (Number(retryOfTaskId) > 0) parts.unshift(`retry:${Number(retryOfTaskId)}`);
  return hashString(parts.join('\n'));
}

export function deriveTaskStatus(statuses = []) {
  if (!statuses.length) return 'QUEUED';
  if (statuses.every(value => value === 'PUBLISHED')) return 'PUBLISHED';
  if (statuses.some(value => value === 'NEEDS_CONFIRMATION')) return 'NEEDS_CONFIRMATION';
  if (statuses.some(value => ['QUEUED', 'RUNNING'].includes(value))) return 'EXECUTING';
  if (statuses.some(value => value === 'REVIEWING')) return 'REVIEWING';
  if (statuses.some(value => value === 'SYNCING')) return 'SYNCING';
  if (statuses.some(value => value === 'SUBMITTED')) return 'SUBMITTED';
  if (statuses.every(value => ['FAILED', 'REJECTED'].includes(value))) return 'FAILED';
  if (statuses.some(value => ['FAILED', 'REJECTED'].includes(value))) return 'PARTIAL_FAILED';
  return 'EXECUTING';
}
