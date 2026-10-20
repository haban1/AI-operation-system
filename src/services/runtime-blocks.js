import { json, row, rows, run, now } from '../db.js';

export const ACTIVE_ISSUE_STATUSES = ['OPEN', 'DIAGNOSING', 'DIAGNOSED', 'RETRYING'];

function contextForIssue(issue) {
  const relatedId = Number(issue?.related_id);
  if (!issue) return {};
  if (issue.related_type === 'PUBLISH_TARGET' && relatedId > 0) {
    const target = row(`SELECT pt.*,a.device_id,a.profile_name FROM publish_targets pt JOIN accounts a ON a.id=pt.account_id WHERE pt.id=?`, relatedId);
    return target ? { platformCode: target.platform_code, accountId: target.account_id, deviceId: target.device_id, profileName: target.profile_name, taskId: target.task_id, targetId: target.id, feature: 'publish' } : {};
  }
  if (issue.related_type === 'MESSAGE' && relatedId > 0) {
    const message = row(`SELECT m.*,a.device_id,a.profile_name FROM messages m JOIN accounts a ON a.id=m.account_id WHERE m.id=?`, relatedId);
    return message ? { platformCode: message.platform_code, accountId: message.account_id, deviceId: message.device_id, profileName: message.profile_name, messageId: message.id, feature: 'reply' } : {};
  }
  if (issue.related_type === 'ACCOUNT' && relatedId > 0) {
    const account = row('SELECT * FROM accounts WHERE id=?', relatedId);
    return account ? { platformCode: account.platform_code, accountId: account.id, deviceId: account.device_id, profileName: account.profile_name, feature: issue.category === 'MESSAGE_COLLECTION' ? 'collect' : 'account' } : {};
  }
  return {};
}

export function issueContext(issueOrId) {
  const issue = typeof issueOrId === 'object' ? issueOrId : row('SELECT * FROM issues WHERE id=?', Number(issueOrId));
  return { issue, ...contextForIssue(issue) };
}

export function inferIssueBlock(issueOrId) {
  const context = issueContext(issueOrId);
  const issue = context.issue;
  if (!issue || issue.source === 'SMOKE_TEST') return null;
  if (issue.related_type === 'PUBLISH_TARGET' && context.targetId) return { scope: 'TASK', blockKey: `PUBLISH_TARGET:${context.targetId}`, feature: 'publish', reason: issue.title };
  if (issue.related_type === 'MESSAGE' && context.messageId) return { scope: 'TASK', blockKey: `MESSAGE:${context.messageId}`, feature: 'reply', reason: issue.title };
  if (issue.related_type === 'ACCOUNT' && context.accountId) return { scope: 'ACCOUNT', blockKey: String(context.accountId), feature: context.feature, reason: issue.title };
  if (context.platformCode && ['LOCATOR_MISMATCH', 'PAGE_CHANGED'].includes(issue.category)) return { scope: 'PLATFORM_FEATURE', blockKey: `${context.platformCode}:${context.feature || 'all'}`, feature: context.feature || 'all', reason: issue.title };
  return null;
}

export function ensureIssueBlock(issueId) {
  const issue = row('SELECT * FROM issues WHERE id=?', Number(issueId));
  if (!issue || !ACTIVE_ISSUE_STATUSES.includes(issue.status)) return null;
  const existing = row("SELECT * FROM runtime_blocks WHERE issue_id=? AND status='ACTIVE'", issue.id);
  if (existing) return existing;
  const inferred = inferIssueBlock(issue);
  if (!inferred) return null;
  const stamp = now();
  const id = Number(run(`INSERT INTO runtime_blocks(issue_id,scope,block_key,feature,reason,status,created_at) VALUES(?,?,?,?,?,'ACTIVE',?)`, issue.id, inferred.scope, inferred.blockKey, inferred.feature || null, inferred.reason, stamp).lastInsertRowid);
  run('UPDATE issues SET block_scope=?,block_key=?,updated_at=? WHERE id=?', inferred.scope, inferred.blockKey, stamp, issue.id);
  return row('SELECT * FROM runtime_blocks WHERE id=?', id);
}

export function releaseIssueBlocks(issueId, { releasedBy = '管理员', reason = '问题已处理' } = {}) {
  const stamp = now();
  run("UPDATE runtime_blocks SET status='RELEASED',released_at=?,released_by=?,release_reason=? WHERE issue_id=? AND status='ACTIVE'", stamp, releasedBy, reason, Number(issueId));
  return rows('SELECT * FROM runtime_blocks WHERE issue_id=? ORDER BY id DESC', Number(issueId));
}

export function activeBlocksForPlatform(platformCode) {
  return rows(`SELECT rb.*,i.title,i.category FROM runtime_blocks rb JOIN issues i ON i.id=rb.issue_id
    WHERE rb.status='ACTIVE' AND (rb.scope='SYSTEM' OR (rb.scope='PLATFORM' AND rb.block_key=?) OR (rb.scope='PLATFORM_FEATURE' AND rb.block_key LIKE ?))
    ORDER BY rb.id`, String(platformCode), `${platformCode}:%`);
}

export function runtimeBlockSummary(platformCode) {
  const blocks = activeBlocksForPlatform(platformCode);
  return { active_block_count: blocks.length, active_blocks: blocks, blocked: blocks.length > 0 };
}

export function jobBlockedByRuntime(payload = {}, jobType = '') {
  if (jobType === 'DIAGNOSE_ISSUE') return null;
  const checks = [{ scope: 'SYSTEM', key: null }];
  if (payload.platformCode) {
    checks.push({ scope: 'PLATFORM', key: String(payload.platformCode) });
    const feature = jobType === 'PUBLISH' || jobType === 'VERIFY_PUBLISH' ? 'publish' : jobType === 'REPLY' ? 'reply' : jobType === 'COLLECT_MESSAGES' ? 'collect' : 'all';
    checks.push({ scope: 'PLATFORM_FEATURE', key: `${payload.platformCode}:${feature}` });
    checks.push({ scope: 'PLATFORM_FEATURE', key: `${payload.platformCode}:all` });
  }
  if (payload.accountId) checks.push({ scope: 'ACCOUNT', key: String(payload.accountId) });
  if (payload.targetId) checks.push({ scope: 'TASK', key: `PUBLISH_TARGET:${payload.targetId}` });
  // DETECT_MANUAL_REPLY only re-opens the already identified target and reads
  // whether an exact reply echo exists. A MESSAGE:* reply block protects
  // against another write, but must not prevent this read-only reconciliation.
  // System/platform/account blocks still apply, so a stopped or unhealthy
  // runtime cannot be bypassed by the detector.
  if (payload.messageId && jobType !== 'DETECT_MANUAL_REPLY') checks.push({ scope: 'TASK', key: `MESSAGE:${payload.messageId}` });
  for (const check of checks) {
    const block = check.key == null
      ? row("SELECT * FROM runtime_blocks WHERE status='ACTIVE' AND scope=? ORDER BY id LIMIT 1", check.scope)
      : row("SELECT * FROM runtime_blocks WHERE status='ACTIVE' AND scope=? AND block_key=? ORDER BY id LIMIT 1", check.scope, check.key);
    if (block) return block;
  }
  return null;
}

export function parsedDiagnosis(item) {
  if (!item) return null;
  return { ...item, evidence: json(item.evidence_json, []), recommendations: json(item.recommendations_json, []) };
}
