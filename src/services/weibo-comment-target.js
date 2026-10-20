const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();
const truthy = value => value === true || clean(value).toLowerCase() === 'true';
const stableCommentId = value => /^\d{6,}$/.test(clean(value));
const stablePostId = value => /^[A-Za-z0-9_-]{5,}$/.test(clean(value));

export function parseWeiboCommentUrl(value) {
  const raw = clean(value);
  if (!raw) return { ok: false, reason: 'WEIBO_COMMENT_URL_REQUIRED' };
  try {
    const url = new URL(raw);
    const host = url.hostname.toLowerCase();
    if (url.protocol !== 'https:') return { ok: false, reason: 'WEIBO_COMMENT_URL_HTTPS_REQUIRED' };
    if (!['weibo.com', 'www.weibo.com'].includes(host)) return { ok: false, reason: 'WEIBO_COMMENT_URL_HOST_INVALID' };
    const match = url.pathname.match(/^\/(\d{5,})\/([A-Za-z0-9_-]{5,})\/?$/);
    if (!match || !stablePostId(match[2])) return { ok: false, reason: 'WEIBO_COMMENT_URL_PATH_INVALID' };
    const commentId = clean(url.searchParams.get('cid'));
    if (!stableCommentId(commentId)) return { ok: false, reason: 'WEIBO_COMMENT_URL_CID_INVALID' };
    return {
      ok: true,
      reason: 'VERIFIED_WEIBO_COMMENT_URL',
      url: url.href,
      uid: match[1],
      postId: match[2],
      commentId
    };
  } catch {
    return { ok: false, reason: 'WEIBO_COMMENT_URL_INVALID' };
  }
}

export function resolveVerifiedWeiboCommentTarget(input = {}) {
  const context = input.messageContext && typeof input.messageContext === 'object'
    ? input.messageContext
    : input.context && typeof input.context === 'object' ? input.context : {};
  if (clean(input.platformCode || input.platform_code).toLowerCase() !== 'weibo') return { ok: false, reason: 'NOT_WEIBO' };
  if (clean(input.messageType || input.message_type).toUpperCase() !== 'COMMENT') return { ok: false, reason: 'NOT_COMMENT' };
  if (!truthy(context.sourceVerified)) return { ok: false, reason: 'SOURCE_PAGE_NOT_VERIFIED' };
  const expectedCommentId = clean(input.commentId || context.commentId || context.commentStableId || context.cid);
  if (!stableCommentId(expectedCommentId)) return { ok: false, reason: 'STABLE_COMMENT_ID_REQUIRED' };
  const parsed = parseWeiboCommentUrl(input.externalUrl || input.external_url || context.externalUrl || context.external_url || context.postUrl || context.post_url);
  if (!parsed.ok) return parsed;
  if (parsed.commentId !== expectedCommentId) {
    return { ok: false, reason: 'WEIBO_COMMENT_URL_CID_MISMATCH', expectedCommentId, actualCommentId: parsed.commentId };
  }
  return { ...parsed, evidence: 'VERIFIED_EXTERNAL_URL' };
}
