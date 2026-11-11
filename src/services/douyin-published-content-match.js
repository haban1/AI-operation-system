function normalize(value) { return String(value || '').normalize('NFC').replace(/\s+/g, ' ').trim(); }

// Only enrich an already-published target. This never authorizes a submission
// or changes publication status from a comment picker observation.
export function matchPublishedDouyinContent(observation, targets = []) {
  if (observation?.verificationStatus !== 'VERIFIED' || observation.evidenceJson?.sourceVerified !== true
    || !/^\d{15,22}$/.test(String(observation.platformPostId || ''))) return null;
  const observed = normalize(observation.title);
  const date = String(observation.publishedAtRaw || '').match(/(\d{4})年(\d{1,2})月(\d{1,2})日\s*(\d{1,2}):(\d{2})/);
  if (!date) return null;
  const [, year, month, day, hour, minute] = date;
  const publishedAt = Date.parse(`${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}T${hour.padStart(2, '0')}:${minute}:00+08:00`);
  if (!Number.isFinite(publishedAt)) return null;
  const matches = targets.filter(target => {
    if (target.platform_code !== 'douyin' || target.status !== 'PUBLISHED') return false;
    if (target.platform_post_id && String(target.platform_post_id) !== String(observation.platformPostId)) return false;
    const title = normalize(target.title), body = normalize(target.body);
    if (!title || body.length < 30) return false;
    const expected = normalize(`${title} ${body}`);
    if (!observed.startsWith(expected.slice(0, title.length + 1 + Math.min(60, body.length)))) return false;
    const submittedAt = Date.parse(target.submitted_at || '');
    return Number.isFinite(submittedAt) && Math.abs(publishedAt - submittedAt) <= 10 * 60 * 1000;
  });
  if (matches.length !== 1) return null;
  return { targetId: matches[0].id, platformPostId: String(observation.platformPostId), platformUrl: `https://www.douyin.com/video/${observation.platformPostId}` };
}
