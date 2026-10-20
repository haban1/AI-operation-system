import { db } from '../db.js';

const clean = value => String(value ?? '').trim();

function bilibiliContentIds(...values) {
  const ids = new Set();
  for (const value of values) {
    const text = clean(value);
    if (!text) continue;
    for (const match of text.matchAll(/\b(BV[0-9A-Za-z]{6,})\b/gi)) ids.add(match[1].toUpperCase());
    for (const match of text.matchAll(/(?:^|\b|\/)(?:av)?([1-9]\d*)(?=$|\b|[/?#])/gi)) ids.add(String(match[1]));
    if (/^[1-9]\d*$/.test(text)) ids.add(text);
  }
  return ids;
}

/**
 * Automatic Bilibili comment replies are restricted to content that has a
 * successful publish target for the same local account. A notification's oid
 * is often numeric while publish_targets stores a BV id, so verified URLs are
 * also normalized before comparing the identities.
 */
export function resolveManagedCommentTarget(input = {}, { database = db } = {}) {
  const platformCode = clean(input.platformCode || input.platform_code).toLowerCase();
  const messageType = clean(input.messageType || input.message_type).toUpperCase();
  if (messageType !== 'COMMENT' || platformCode !== 'bilibili') {
    return { required: false, verified: true, reason: 'OWNERSHIP_GATE_NOT_REQUIRED' };
  }

  const accountId = Number(input.accountId || input.account_id);
  const context = input.messageContext && typeof input.messageContext === 'object'
    ? input.messageContext
    : input.context && typeof input.context === 'object' ? input.context : {};
  const observedIds = bilibiliContentIds(
    input.postId,
    input.externalUrl,
    context.postId,
    context.oid,
    context.aid,
    context.bvid,
    context.videoId,
    context.sourcePostId,
    context.sourceVideoKey,
    context.platformUrl,
    context.sourceUrl
  );
  if (!Number.isInteger(accountId) || accountId <= 0 || observedIds.size === 0) {
    return { required: true, verified: false, reason: 'MANAGED_CONTENT_ID_REQUIRED', observedIds: [...observedIds] };
  }

  const targets = database.prepare(`
    SELECT id,platform_post_id,platform_url,status,submission_status,review_status
    FROM publish_targets
    WHERE platform_code='bilibili' AND account_id=?
      AND submission_status='SUBMITTED'
      AND status NOT IN ('FAILED','REJECTED')
      AND (platform_post_id IS NOT NULL OR platform_url IS NOT NULL)
    ORDER BY id DESC
  `).all(accountId);

  for (const target of targets) {
    const managedIds = bilibiliContentIds(target.platform_post_id, target.platform_url);
    const matchedId = [...observedIds].find(id => managedIds.has(id));
    if (matchedId) {
      return {
        required: true,
        verified: true,
        reason: 'PUBLISH_TARGET_MATCHED',
        publishTargetId: Number(target.id),
        matchedId,
        observedIds: [...observedIds]
      };
    }
  }

  return { required: true, verified: false, reason: 'COMMENT_CONTENT_NOT_MANAGED', observedIds: [...observedIds] };
}
