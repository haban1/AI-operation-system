import { createHash } from 'node:crypto';

export const PLATFORM_ANALYTICS_SCHEMA = `
CREATE TABLE IF NOT EXISTS platform_analytics_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL UNIQUE CHECK(typeof(job_id)='integer' AND job_id>0),
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  platform_code TEXT NOT NULL,
  profile_name TEXT,
  captured_at TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  source_url TEXT NOT NULL,
  source_verified INTEGER NOT NULL CHECK(source_verified=1),
  identity_verified INTEGER NOT NULL CHECK(identity_verified=1),
  account_identity_json TEXT NOT NULL CHECK(json_valid(account_identity_json)),
  metrics_json TEXT NOT NULL CHECK(json_valid(metrics_json)),
  evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)),
  payload_hash TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_platform_analytics_account_capture
  ON platform_analytics_snapshots(account_id,platform_code,captured_at DESC,id DESC);
`;

const SOURCE_HOSTS = Object.freeze({
  douyin: ['creator.douyin.com'],
  xiaohongshu: ['creator.xiaohongshu.com'],
  wechat_channels: ['channels.weixin.qq.com'],
  bilibili: ['member.bilibili.com'],
  weibo: ['weibo.com', 'www.weibo.com', 'data.weibo.com']
});
const METRIC_KEYS = Object.freeze(['plays', 'impressions', 'followersTotal', 'newFollowers', 'netFollowers', 'likes', 'comments', 'shares', 'reads']);
const PERIOD_ONLY = new Set(['newFollowers', 'netFollowers']);
let savepointSequence = 0;

function fail(code, message) { return Object.assign(new Error(message), { code, statusCode: 422 }); }
function text(value, max = 300) {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : '';
}
function name(value) { return text(value).normalize('NFKC').replace(/\s+/gu, ' '); }
function object(value) { return Boolean(value && typeof value === 'object' && !Array.isArray(value)); }
function identity(value) {
  if (!object(value)) throw fail('ACCOUNT_IDENTITY_MISSING', '平台运营采集缺少真实账号身份');
  if ((value.id !== undefined && value.id !== null && typeof value.id !== 'string')
      || (value.name !== undefined && value.name !== null && typeof value.name !== 'string')
      || (typeof value.id === 'string' && value.id.length > 300)
      || (typeof value.name === 'string' && value.name.length > 300)) throw fail('INVALID_ACCOUNT_IDENTITY', '平台账号 ID 和名称必须为完整、长度受限的文本');
  const id = typeof value.id === 'string' ? text(value.id, 300) : '';
  const displayName = name(value.name);
  if (!id && !displayName) throw fail('ACCOUNT_IDENTITY_MISSING', '平台运营采集缺少真实账号名称或平台 ID');
  return { ...(id ? { id } : {}), ...(displayName ? { name: displayName } : {}) };
}
function matchesIdentity(expected, observed) {
  if (expected.id && observed.id) return expected.id === observed.id;
  return Boolean(expected.name && observed.name && name(expected.name) === name(observed.name));
}
function accountIdentity(account) {
  const id = text(account.platform_user_id);
  const displayName = name(account.platform_user_name);
  return { ...(id ? { id } : {}), ...(displayName ? { name: displayName } : {}) };
}
function dateTime(value, field) {
  // An explicit offset avoids interpreting the same capture in the server's and
  // the browser's different local time zones.
  if (typeof value !== 'string' || !/(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) throw fail('INVALID_ANALYTICS_TIME', `${field} 必须包含明确时区`);
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw fail('INVALID_ANALYTICS_TIME', `${field} 不是有效时间`);
  return date.toISOString();
}
function sourceUrl(value, platformCode) {
  let url;
  try { url = new URL(value); } catch { throw fail('INVALID_ANALYTICS_SOURCE', '平台运营采集来源 URL 无效'); }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')
      || !SOURCE_HOSTS[platformCode]?.includes(url.hostname)) throw fail('INVALID_ANALYTICS_SOURCE', '平台运营采集来源不属于该平台受信任的 HTTPS 管理页面');
  // URLs can contain session tokens. The host and pathname are enough to locate
  // the source page; do not persist or return its query string or fragment.
  return `${url.origin}${url.pathname}`;
}
function evidence(value) {
  if (!(object(value) || typeof value === 'string')) throw fail('ANALYTICS_EVIDENCE_MISSING', '平台运营采集缺少页面证据');
  if (typeof value === 'string' && !value.trim()) throw fail('INVALID_ANALYTICS_EVIDENCE', '页面证据不能为空白');
  let serialized;
  try { serialized = JSON.stringify(value); } catch { throw fail('INVALID_ANALYTICS_EVIDENCE', '页面证据无法序列化'); }
  if (!serialized || serialized === '{}' || serialized === '""' || Buffer.byteLength(serialized, 'utf8') > 8192) throw fail('INVALID_ANALYTICS_EVIDENCE', '页面证据应为简短且非空的可序列化内容');
  return JSON.parse(serialized);
}
function metrics(values, capturedAt) {
  if (!Array.isArray(values) || !values.length || values.length > METRIC_KEYS.length) throw fail('INVALID_ANALYTICS_METRICS', '平台运营采集没有有效指标');
  const seen = new Set();
  return values.map(item => {
    if (!object(item) || !METRIC_KEYS.includes(item.key) || seen.has(item.key)) throw fail('INVALID_ANALYTICS_METRICS', '平台运营指标类型无效或重复');
    seen.add(item.key);
    if (typeof item.value !== 'number' || !Number.isFinite(item.value) || (item.value < 0 && item.key !== 'netFollowers')
        || Math.abs(item.value) > Number.MAX_SAFE_INTEGER) throw fail('INVALID_ANALYTICS_VALUE', '平台运营指标必须是有限数值，只有净增关注允许为负');
    const label = text(item.label, 100), rawValue = text(item.rawValue, 200);
    if (!label || !rawValue) throw fail('INVALID_ANALYTICS_METRICS', '平台运营指标缺少原始标签或显示值');
    if (!['SNAPSHOT', 'PERIOD'].includes(item.scope)) throw fail('INVALID_ANALYTICS_SCOPE', '平台运营指标必须注明快照或周期口径');
    if (item.key === 'followersTotal' && item.scope !== 'SNAPSHOT') throw fail('INVALID_ANALYTICS_SCOPE', '粉丝总数只能作为累计快照，不能当作周期新增');
    if (PERIOD_ONLY.has(item.key) && item.scope !== 'PERIOD') throw fail('INVALID_ANALYTICS_PERIOD', '新增关注和净增关注必须包含明确统计周期');
    if (item.approximate !== undefined && typeof item.approximate !== 'boolean') throw fail('INVALID_ANALYTICS_METRICS', '约数标记必须为布尔值');
    const normalized = { key: item.key, label, value: item.value, rawValue, scope: item.scope,
      asOf: item.asOf === undefined ? capturedAt : dateTime(item.asOf, 'asOf'), approximate: item.approximate === true };
    if (Date.parse(normalized.asOf) > Date.parse(capturedAt) + 300_000) throw fail('INVALID_ANALYTICS_TIME', '指标时间不能晚于实际采集时间');
    if (item.scope === 'PERIOD') {
      normalized.periodStart = dateTime(item.periodStart, 'periodStart');
      normalized.periodEnd = dateTime(item.periodEnd, 'periodEnd');
      if (normalized.periodStart >= normalized.periodEnd) throw fail('INVALID_ANALYTICS_PERIOD', '指标统计周期的开始时间必须早于结束时间');
    } else if (item.periodStart !== undefined || item.periodEnd !== undefined) throw fail('INVALID_ANALYTICS_SCOPE', '累计快照不能伪装成周期增量');
    return normalized;
  }).sort((a, b) => METRIC_KEYS.indexOf(a.key) - METRIC_KEYS.indexOf(b.key));
}
function readJson(value) { try { return JSON.parse(value); } catch { return null; } }
function expectedIdentity(account, history) {
  const bound = accountIdentity(account);
  const previous = history.map(item => readJson(item.account_identity_json)).filter(object);
  const expected = bound.id || bound.name ? bound : previous[0];
  if (!expected) return null;
  // A later page may expose only the nickname. Keep the learned stable ID for
  // subsequent checks instead of weakening the baseline after that capture.
  const known = !expected.id && previous.find(item => item.id && matchesIdentity(expected, item));
  return known ? { ...expected, id: known.id } : expected;
}

/** Caller initializes the schema. This service performs no network or account writes. */
export function createPlatformAnalytics({ db, now = () => Date.now() } = {}) {
  if (!db?.prepare || !db?.exec) throw new TypeError('db is required');
  const clock = () => {
    const date = new Date(typeof now === 'function' ? now() : now);
    if (!Number.isFinite(date.getTime())) throw new TypeError('now must return a valid time');
    return date.toISOString();
  };
  const snapshots = (accountId, platformCode) => db.prepare(`SELECT * FROM platform_analytics_snapshots
    WHERE account_id=? AND platform_code=? ORDER BY captured_at DESC,id DESC`).all(accountId, platformCode);

  function record({ accountId, platformCode, jobId, analytics } = {}) {
    if (!Number.isSafeInteger(Number(accountId)) || Number(accountId) < 1 || !Number.isSafeInteger(Number(jobId)) || Number(jobId) < 1) throw fail('INVALID_ANALYTICS_JOB', '采集任务和账号标识无效');
    const platform = text(platformCode).toLowerCase();
    if (!SOURCE_HOSTS[platform]) throw fail('UNSUPPORTED_ANALYTICS_PLATFORM', '该平台尚未支持运营数据采集');
    if (!object(analytics) || analytics.schemaVersion !== 1 || analytics.sourceVerified !== true || analytics.identityVerified !== true
        || analytics.simulated === true || analytics.evidence?.simulated === true
        || [analytics.source, analytics.mode, analytics.sourceType].some(value => /^(?:mock|simulated)$/i.test(String(value || '')))) throw fail('UNVERIFIED_ANALYTICS', '运营数据必须来自已核验身份的真实平台页面');
    const observedIdentity = identity(analytics.accountIdentity);
    const recordedAt = clock();
    const capturedAt = dateTime(analytics.capturedAt, 'capturedAt');
    if (Date.parse(capturedAt) > Date.parse(recordedAt) + 300_000) throw fail('INVALID_ANALYTICS_TIME', '采集时间不能位于未来');
    const normalized = { accountId: Number(accountId), platformCode: platform, capturedAt,
      sourceUrl: sourceUrl(analytics.sourceUrl, platform), accountIdentity: observedIdentity,
      metrics: metrics(analytics.metrics, capturedAt), evidence: evidence(analytics.evidence) };
    const payloadHash = createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
    const savepoint = `platform_analytics_${++savepointSequence}`;
    db.exec(`SAVEPOINT ${savepoint}`);
    try {
      const account = db.prepare('SELECT * FROM accounts WHERE id=? AND platform_code=?').get(Number(accountId), platform);
      if (!account || Number(account.enabled) !== 1) throw fail('ACCOUNT_DISABLED', '账号已停用或不属于该平台，忽略晚到采集结果');
      if (account.login_status !== 'READY') throw fail('ACCOUNT_NOT_READY', '当前账号尚未确认登录，不能接收运营快照');
      const bound = accountIdentity(account);
      const expected = expectedIdentity(account, snapshots(Number(accountId), platform));
      if (expected && !matchesIdentity(expected, observedIdentity)) throw fail('ACCOUNT_IDENTITY_CHANGED', '采集账号与当前账号身份或首采身份基线不一致');
      const inserted = db.prepare(`INSERT OR IGNORE INTO platform_analytics_snapshots
        (job_id,account_id,platform_code,profile_name,captured_at,recorded_at,source_url,source_verified,identity_verified,
         account_identity_json,metrics_json,evidence_json,payload_hash) VALUES(?,?,?,?,?,?,?,1,1,?,?,?,?)`).run(
        Number(jobId), Number(accountId), platform, text(account.profile_name) || null, capturedAt, recordedAt,
        normalized.sourceUrl, JSON.stringify(observedIdentity), JSON.stringify(normalized.metrics), JSON.stringify(normalized.evidence), payloadHash);
      const saved = db.prepare('SELECT id,account_id,platform_code,captured_at,payload_hash FROM platform_analytics_snapshots WHERE job_id=?').get(Number(jobId));
      if (!saved || saved.payload_hash !== payloadHash) throw fail('ANALYTICS_JOB_CONFLICT', '同一任务已经记录了另一份运营快照，禁止覆盖');
      db.exec(`RELEASE SAVEPOINT ${savepoint}`);
      return { recorded: Boolean(inserted.changes), reused: !inserted.changes, snapshotId: Number(saved.id),
        accountId: Number(saved.account_id), platformCode: saved.platform_code, capturedAt: saved.captured_at,
        identityBound: Boolean(bound.id || bound.name), metricCount: normalized.metrics.length };
    } catch (error) {
      try { db.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`); } catch {}
      try { db.exec(`RELEASE SAVEPOINT ${savepoint}`); } catch {}
      throw error;
    }
  }

  function summary({ platformCode = null, rangeDays = null } = {}) {
    const selectedPlatform = platformCode && platformCode !== 'all' ? text(platformCode).toLowerCase() : null;
    const supportedPlatforms = Object.keys(SOURCE_HOSTS);
    const accounts = db.prepare(`SELECT * FROM accounts WHERE enabled=1
      AND platform_code IN (${supportedPlatforms.map(() => '?').join(',')})${selectedPlatform ? ' AND platform_code=?' : ''}
      ORDER BY platform_code,id`).all(...supportedPlatforms, ...(selectedPlatform ? [selectedPlatform] : []));
    const result = [], missing = [];
    for (const account of accounts) {
      const history = snapshots(account.id, account.platform_code);
      const bound = accountIdentity(account);
      const identityBound = Boolean(bound.id || bound.name);
      const baseline = expectedIdentity(account, history);
      const latest = history.find(snapshot => {
        const observedIdentity = readJson(snapshot.account_identity_json);
        return observedIdentity && baseline && matchesIdentity(baseline, observedIdentity);
      });
      if (!latest) {
        missing.push({ accountId: Number(account.id), platformCode: account.platform_code,
          reason: history.length ? 'ACCOUNT_IDENTITY_CHANGED' : account.login_status !== 'READY' ? 'ACCOUNT_NOT_READY' : 'NEVER_COLLECTED' });
        continue;
      }
      const observedIdentity = readJson(latest.account_identity_json);
      const capturedMetrics = readJson(latest.metrics_json) || [];
      result.push({ accountId: Number(account.id), platformCode: account.platform_code,
        accountName: observedIdentity.name || bound.name || text(account.display_name),
        accountIdentity: observedIdentity, identityBound, loginStatus: account.login_status,
        status: account.login_status === 'READY' && Date.parse(clock()) - Date.parse(latest.captured_at) <= 24 * 60 * 60 * 1000 ? 'READY' : 'STALE', capturedAt: latest.captured_at,
        recordedAt: latest.recorded_at, sourceUrl: latest.source_url, sourceVerified: true, identityVerified: true,
        metrics: capturedMetrics, missingMetricKeys: METRIC_KEYS.filter(key => !capturedMetrics.some(metric => metric.key === key)) });
    }
    return { accounts: result, coverage: { supportedAccounts: accounts.length, connectedAccounts: result.length, missing },
      updatedAt: clock(), platformCode: selectedPlatform || 'all',
      requestedRangeDays: Number.isFinite(Number(rangeDays)) && Number(rangeDays) > 0 ? Number(rangeDays) : null,
      scope: 'LATEST_VERIFIED_SNAPSHOT' };
  }
  return { record, summary };
}
