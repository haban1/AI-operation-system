import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { PLATFORM_ANALYTICS_SCHEMA, createPlatformAnalytics } from '../src/services/platform-analytics.js';

const CAPTURE = '2026-11-02T04:00:00.000Z';
const snapshotMetric = (changes = {}) => ({ key: 'plays', label: '播放量', value: 1234, rawValue: '1,234', scope: 'SNAPSHOT', ...changes });
const analytics = (changes = {}) => ({ schemaVersion: 1, capturedAt: CAPTURE,
  sourceUrl: 'https://creator.douyin.com/creator-micro/home', sourceVerified: true, identityVerified: true,
  accountIdentity: { id: 'dy-account-1', name: '草帽蓝胖企' }, metrics: [snapshotMetric()],
  evidence: { pageTitle: '创作者服务中心', accountHeader: '草帽蓝胖企', metricLabels: ['播放量'] }, ...changes });
const code = expected => error => error?.code === expected;

function fixture(t, { bound = false } = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE accounts(id INTEGER PRIMARY KEY,platform_code TEXT NOT NULL,display_name TEXT,
    profile_name TEXT,enabled INTEGER NOT NULL DEFAULT 1,login_status TEXT NOT NULL DEFAULT 'READY',
    platform_user_id TEXT,platform_user_name TEXT);`);
  db.exec(PLATFORM_ANALYTICS_SCHEMA);
  db.prepare('INSERT INTO accounts(id,platform_code,display_name,profile_name,platform_user_id,platform_user_name) VALUES(1,?,?,?,?,?)')
    .run('douyin', '港澳社区-抖音', 'douyin-local', bound ? 'dy-account-1' : null, bound ? '草帽蓝胖企' : null);
  t.after(() => db.close());
  const f = { db, time: Date.parse(CAPTURE) + 60_000 };
  f.service = createPlatformAnalytics({ db, now: () => f.time });
  f.record = (value = analytics(), jobId = 1, accountId = 1, platformCode = 'douyin') => f.service.record({ accountId, platformCode, jobId, analytics: value });
  f.summary = options => f.service.summary(options);
  f.rows = () => db.prepare('SELECT * FROM platform_analytics_snapshots ORDER BY id').all();
  return f;
}

test('verified first capture establishes only the module baseline, without modifying account identity', t => {
  const f = fixture(t);
  const before = f.db.prepare('SELECT * FROM accounts WHERE id=1').get();
  assert.deepEqual(f.record(), { recorded: true, reused: false, snapshotId: 1, accountId: 1,
    platformCode: 'douyin', capturedAt: CAPTURE, identityBound: false, metricCount: 1 });
  assert.deepEqual(f.db.prepare('SELECT * FROM accounts WHERE id=1').get(), before);
  assert.equal(f.rows()[0].source_verified, 1);
  assert.equal(f.rows()[0].identity_verified, 1);
  assert.equal(f.summary().accounts[0].accountName, '草帽蓝胖企');
  assert.equal(f.summary().accounts[0].identityBound, false);
});

test('account labels are independent from real platform names and stable IDs', t => {
  const f = fixture(t, { bound: true });
  f.record();
  const account = f.summary().accounts[0];
  assert.equal(account.accountName, '草帽蓝胖企');
  assert.equal(account.identityBound, true);
  assert.notEqual(account.accountName, '港澳社区-抖音');
  f.record(analytics({ accountIdentity: { id: 'dy-account-1', name: '平台改名' } }), 2);
  assert.equal(f.summary().accounts[0].accountName, '平台改名');
  assert.throws(() => f.record(analytics({ accountIdentity: { id: 'different-account', name: '草帽蓝胖企' } }), 3), code('ACCOUNT_IDENTITY_CHANGED'));
});

test('unbound baseline rejects an account switch and preserves the learned stable ID after name-only captures', t => {
  const f = fixture(t);
  f.record();
  f.record(analytics({ accountIdentity: { name: '草帽蓝胖企' } }), 2);
  assert.throws(() => f.record(analytics({ accountIdentity: { id: 'switched', name: '草帽蓝胖企' } }), 3), code('ACCOUNT_IDENTITY_CHANGED'));
  assert.throws(() => f.record(analytics({ accountIdentity: { name: '另一账号' } }), 4), code('ACCOUNT_IDENTITY_CHANGED'));
  assert.equal(f.rows().length, 2);
});

test('name-only initial baseline can learn a stable ID without allowing later ID conflicts', t => {
  const f = fixture(t);
  f.record(analytics({ accountIdentity: { name: '草帽蓝胖企' } }));
  f.record(analytics(), 2);
  assert.throws(() => f.record(analytics({ accountIdentity: { id: 'new-account', name: '草帽蓝胖企' } }), 3), code('ACCOUNT_IDENTITY_CHANGED'));
});

test('explicit account binding takes priority and summary excludes snapshots from the former account', t => {
  const f = fixture(t);
  f.record();
  f.db.prepare('UPDATE accounts SET platform_user_id=?,platform_user_name=? WHERE id=1').run('new-account', '新的真实账号');
  let summary = f.summary();
  assert.equal(summary.accounts.length, 0);
  assert.equal(summary.coverage.missing[0].reason, 'ACCOUNT_IDENTITY_CHANGED');
  assert.throws(() => f.record(analytics(), 2), code('ACCOUNT_IDENTITY_CHANGED'));
  f.record(analytics({ accountIdentity: { id: 'new-account', name: '新的真实账号' },
    capturedAt: '2026-11-02T04:00:30.000Z', metrics: [snapshotMetric({ value: 9, rawValue: '9' })] }), 3);
  summary = f.summary();
  assert.equal(summary.accounts[0].accountName, '新的真实账号');
  assert.equal(summary.accounts[0].metrics[0].value, 9);
  assert.equal(summary.accounts[0].identityBound, true);
});

test('missing identity cannot be replaced by the backend display label or invalid ID types', t => {
  const f = fixture(t, { bound: true });
  for (const accountIdentity of [null, {}, { name: '港澳社区-抖音' }, { id: 123, name: '草帽蓝胖企' }, { id: 'a'.repeat(301) }]) {
    assert.throws(() => f.record(analytics({ accountIdentity })));
  }
  assert.equal(f.rows().length, 0);
});

test('late results for disabled, deleted, wrong-platform or not-ready accounts are rejected', t => {
  const f = fixture(t);
  f.db.prepare('UPDATE accounts SET enabled=0 WHERE id=1').run();
  assert.throws(() => f.record(), code('ACCOUNT_DISABLED'));
  f.db.prepare("UPDATE accounts SET enabled=1,login_status='UNKNOWN' WHERE id=1").run();
  assert.throws(() => f.record(), code('ACCOUNT_NOT_READY'));
  f.db.prepare("UPDATE accounts SET login_status='READY' WHERE id=1").run();
  assert.throws(() => f.record(analytics({ sourceUrl: 'https://member.bilibili.com/platform/home' }), 1, 1, 'bilibili'), code('ACCOUNT_DISABLED'));
  assert.throws(() => f.record(analytics(), 1, 999), code('ACCOUNT_DISABLED'));
  assert.equal(f.rows().length, 0);
});

test('source verification, identity verification and real mode are all required', t => {
  const f = fixture(t);
  for (const changes of [{ schemaVersion: 2 }, { sourceVerified: false }, { sourceVerified: undefined },
    { identityVerified: false }, { identityVerified: undefined }, { simulated: true }, { mode: 'mock' },
    { mode: 'SIMULATED' }, { source: 'simulated' }, { sourceType: 'MOCK' }, { evidence: { simulated: true } }]) {
    assert.throws(() => f.record(analytics(changes)), code('UNVERIFIED_ANALYTICS'));
  }
  assert.equal(f.rows().length, 0);
});

test('source URLs enforce HTTPS exact host, credential and port rules and omit query secrets', t => {
  const f = fixture(t);
  for (const sourceUrl of ['http://creator.douyin.com/home', 'https://creator.douyin.com.attacker.test/home',
    'https://attacker.test/?creator.douyin.com', 'https://creator.xiaohongshu.com/home',
    'https://user:password@creator.douyin.com/home', 'https://creator.douyin.com:444/home',
    'file:///C:/page.html', 'not a URL']) assert.throws(() => f.record(analytics({ sourceUrl })), code('INVALID_ANALYTICS_SOURCE'));
  f.record(analytics({ sourceUrl: 'https://creator.douyin.com/home?ticket=example-secret#token' }));
  assert.equal(f.rows()[0].source_url, 'https://creator.douyin.com/home');
  assert.equal(f.summary().accounts[0].sourceUrl, 'https://creator.douyin.com/home');
});

test('each supported platform accepts its own creator origin and remains isolated by account', t => {
  const f = fixture(t);
  const sources = { xiaohongshu: 'https://creator.xiaohongshu.com/home', wechat_channels: 'https://channels.weixin.qq.com/platform',
    bilibili: 'https://member.bilibili.com/platform/home', weibo: 'https://weibo.com/u/123' };
  let id = 2;
  for (const [platformCode, sourceUrl] of Object.entries(sources)) {
    f.db.prepare('INSERT INTO accounts(id,platform_code,display_name,profile_name) VALUES(?,?,?,?)').run(id, platformCode, `${platformCode}账号`, platformCode);
    f.record(analytics({ sourceUrl, accountIdentity: { id: `${platformCode}-1`, name: `${platformCode}用户` } }), id, id, platformCode);
    id += 1;
  }
  assert.equal(f.summary().coverage.supportedAccounts, 5);
  assert.equal(f.summary().coverage.connectedAccounts, 4);
  assert.deepEqual(f.summary({ platformCode: 'bilibili' }).accounts.map(item => item.platformCode), ['bilibili']);
  assert.equal(f.summary({ platformCode: 'bilibili' }).coverage.supportedAccounts, 1);
});

test('real zero remains zero while absent exposure and follower data remain absent', t => {
  const f = fixture(t);
  f.record(analytics({ metrics: [snapshotMetric({ value: 0, rawValue: '0' }),
    snapshotMetric({ key: 'followersTotal', label: '粉丝总数', value: 0, rawValue: '0' })] }));
  const snapshot = f.summary({ rangeDays: 7 }).accounts[0];
  assert.deepEqual(snapshot.metrics.map(item => item.value), [0, 0]);
  assert.ok(snapshot.missingMetricKeys.includes('impressions'));
  assert.ok(snapshot.missingMetricKeys.includes('newFollowers'));
  assert.ok(!snapshot.metrics.some(item => item.key === 'impressions'));
  assert.equal(f.summary({ rangeDays: 7 }).requestedRangeDays, 7);
  assert.equal(f.summary({ rangeDays: 7 }).scope, 'LATEST_VERIFIED_SNAPSHOT');
});

test('plays, impressions, total followers, new followers and signed net followers keep distinct meanings', t => {
  const f = fixture(t);
  const period = { scope: 'PERIOD', periodStart: '2026-10-26T16:00:00+08:00', periodEnd: '2026-11-02T12:00:00+08:00' };
  f.record(analytics({ metrics: [snapshotMetric(), snapshotMetric({ key: 'impressions', label: '曝光量', value: 5000, rawValue: '5,000' }),
    snapshotMetric({ key: 'followersTotal', label: '粉丝总数', value: 100, rawValue: '100' }),
    snapshotMetric({ key: 'newFollowers', label: '新增关注', value: 5, rawValue: '5', ...period }),
    snapshotMetric({ key: 'netFollowers', label: '净增关注', value: -3, rawValue: '-3', ...period })] }));
  const values = Object.fromEntries(f.summary().accounts[0].metrics.map(metric => [metric.key, metric.value]));
  assert.deepEqual(values, { plays: 1234, impressions: 5000, followersTotal: 100, newFollowers: 5, netFollowers: -3 });
  assert.equal(f.summary().accounts[0].metrics.find(item => item.key === 'netFollowers').scope, 'PERIOD');
});

test('period metrics require valid explicit boundaries and total followers cannot masquerade as period growth', t => {
  const f = fixture(t);
  for (const metric of [snapshotMetric({ key: 'newFollowers' }), snapshotMetric({ key: 'netFollowers' }),
    snapshotMetric({ key: 'newFollowers', scope: 'PERIOD' }),
    snapshotMetric({ key: 'newFollowers', scope: 'PERIOD', periodStart: CAPTURE, periodEnd: CAPTURE }),
    snapshotMetric({ key: 'newFollowers', scope: 'PERIOD', periodStart: '2026-10-26', periodEnd: CAPTURE }),
    snapshotMetric({ key: 'followersTotal', scope: 'PERIOD', periodStart: '2026-10-26T00:00:00Z', periodEnd: CAPTURE }),
    snapshotMetric({ periodStart: '2026-10-26T00:00:00Z' })]) {
    assert.throws(() => f.record(analytics({ metrics: [metric] })));
  }
  assert.equal(f.rows().length, 0);
});

test('invalid values, missing raw labels, unknown and repeated metrics cannot silently become zero', t => {
  const f = fixture(t);
  for (const value of [null, undefined, '0', -1, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => f.record(analytics({ metrics: [snapshotMetric({ value })] })), code('INVALID_ANALYTICS_VALUE'));
  }
  for (const values of [[], [snapshotMetric({ key: 'revenue' })], [snapshotMetric(), snapshotMetric()],
    [snapshotMetric({ rawValue: '' })], [snapshotMetric({ label: '' })], [snapshotMetric({ approximate: 'yes' })]]) {
    assert.throws(() => f.record(analytics({ metrics: values })), code('INVALID_ANALYTICS_METRICS'));
  }
  assert.equal(f.rows().length, 0);
});

test('approximate source values are preserved as approximate and never presented as exact', t => {
  const f = fixture(t);
  f.record(analytics({ metrics: [snapshotMetric({ value: 12000, rawValue: '1.2万', approximate: true })] }));
  assert.equal(f.summary().accounts[0].metrics[0].approximate, true);
  assert.equal(f.summary().accounts[0].metrics[0].rawValue, '1.2万');
});

test('duplicate task delivery is idempotent and conflicting task results cannot overwrite data', t => {
  const f = fixture(t);
  const original = analytics({ metrics: [snapshotMetric(), snapshotMetric({ key: 'likes', label: '点赞量', value: 2, rawValue: '2' })] });
  f.record(original);
  f.time += 5000;
  assert.equal(f.record({ ...original, metrics: [...original.metrics].reverse() }).reused, true);
  assert.equal(f.rows().length, 1);
  assert.throws(() => f.record(analytics({ metrics: [snapshotMetric({ value: 7, rawValue: '7' })] })), code('ANALYTICS_JOB_CONFLICT'));
  assert.equal(f.rows().length, 1);
  assert.equal(f.summary().accounts[0].metrics.find(metric => metric.key === 'plays').value, 1234);
});

test('latest snapshot wins without summing captures, merging older metrics or replacing newer data with late older results', t => {
  const f = fixture(t);
  f.record(analytics({ metrics: [snapshotMetric(), snapshotMetric({ key: 'impressions', label: '曝光量', value: 5000, rawValue: '5000' })] }));
  f.record(analytics({ capturedAt: '2026-11-02T04:00:30Z', metrics: [snapshotMetric({ value: 6, rawValue: '6' })] }), 2);
  f.record(analytics({ capturedAt: '2026-11-01T04:00:00Z', metrics: [snapshotMetric({ value: 9999, rawValue: '9999' })] }), 3);
  const summary = f.summary({ rangeDays: 30 });
  assert.equal(summary.accounts[0].metrics[0].value, 6);
  assert.equal(summary.accounts[0].metrics.length, 1);
  assert.ok(summary.accounts[0].missingMetricKeys.includes('impressions'));
  assert.equal(summary.accounts[0].capturedAt, '2026-11-02T04:00:30.000Z');
  assert.equal(summary.coverage.connectedAccounts, 1);
});

test('capture evidence and explicit timestamp validation reject malformed snapshots', t => {
  const f = fixture(t);
  for (const changes of [{ capturedAt: '2026-11-02 12:00:00' }, { capturedAt: 'invalidZ' },
    { capturedAt: '2036-11-02T04:00:00Z' }, { metrics: [snapshotMetric({ asOf: '2036-11-02T04:00:00Z' })] },
    { evidence: null }, { evidence: {} }, { evidence: '   ' }, { evidence: 'x'.repeat(8193) }]) {
    assert.throws(() => f.record(analytics(changes)));
  }
  assert.equal(f.rows().length, 0);
});

test('summary reports missing coverage, keeps dated historical snapshots stale and excludes disabled accounts', t => {
  const f = fixture(t);
  f.db.prepare("INSERT INTO accounts(id,platform_code,display_name,profile_name,login_status) VALUES(2,'bilibili','B站','bilibili','UNKNOWN')").run();
  f.db.prepare("INSERT INTO accounts(id,platform_code,display_name,profile_name) VALUES(3,'weibo','微博','weibo')").run();
  f.record();
  f.time += 24 * 60 * 60 * 1000 + 1;
  let summary = f.summary();
  assert.equal(summary.accounts[0].status, 'STALE');
  assert.equal(summary.coverage.supportedAccounts, 3);
  assert.equal(summary.coverage.connectedAccounts, 1);
  assert.deepEqual(summary.coverage.missing.map(item => item.reason), ['ACCOUNT_NOT_READY', 'NEVER_COLLECTED']);
  f.db.prepare("UPDATE accounts SET login_status='UNKNOWN' WHERE id=1").run();
  assert.equal(f.summary().accounts[0].status, 'STALE');
  f.db.prepare('UPDATE accounts SET enabled=0 WHERE id=1').run();
  summary = f.summary();
  assert.equal(summary.accounts.length, 0);
  assert.equal(summary.coverage.supportedAccounts, 2);
  assert.throws(() => f.record(analytics(), 2), code('ACCOUNT_DISABLED'));
});

test('record uses a savepoint and rolls back with its parent transaction', t => {
  const f = fixture(t);
  f.db.exec('BEGIN');
  f.record();
  assert.equal(f.rows().length, 1);
  f.db.exec('ROLLBACK');
  assert.equal(f.rows().length, 0);
  assert.equal(f.summary().coverage.connectedAccounts, 0);
});
