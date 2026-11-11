import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startServer, stopChild, cleanupDir, tempRuntimeDir, jsonRequest } from './helpers/runtime.js';

async function fixture(t, { enabled = true } = {}) {
  const dir = tempRuntimeDir('platform-analytics-integration-');
  let runtime, db;
  t.after(async () => { db?.close(); await stopChild(runtime?.child); cleanupDir(dir); });
  runtime = await startServer({ dir, env: {
    RPA_MODE: 'five_platform_assisted', OPERATIONS_ANALYTICS_ENABLED: String(enabled),
    LOCAL_AGENT_AUTO_START: 'false', AUTO_COLLECT_ENABLED: 'false', LOGIN_STATUS_POLL_ENABLED: 'false',
    RAG_BASE_URL: '', RAG_AUTO_START: 'false', RAG_ADMIN_ENABLED: 'false', RAG_FORMAL_ROUTING_ENABLED: 'false',
    CONTENT_LIBRARY_DIR: path.join(dir, 'content-library'), CONTENT_LIBRARY_SEED_ENABLED: 'false',
    CONTENT_LIBRARY_SIGNAL_ROOT: '', CONTENT_LIBRARY_EDITING_ROOT: '', CONTENT_LIBRARY_CREATION_ROOT: '',
    VIDEO_STUDIO_ENABLED: 'false', CHANNEL_SPLIT_ENABLED: 'true', PLATFORM_CHANNEL_SPLIT_DOUYIN: 'true',
    SETTINGS_KEY_PATH: path.join(dir, 'settings-key'), ISSUE_DIAGNOSIS_ENABLED: 'false',
  } });
  db = new DatabaseSync(runtime.dbPath);
  db.exec('PRAGMA busy_timeout=15000');
  db.prepare("UPDATE accounts SET enabled=0,login_status='UNKNOWN'").run();
  const account = db.prepare("SELECT * FROM accounts WHERE platform_code='douyin' ORDER BY id LIMIT 1").get();
  assert.ok(account);
  db.prepare("UPDATE accounts SET enabled=1,login_status='READY',platform_user_id='analytics-test-account',platform_user_name='真实运营账号' WHERE id=?").run(account.id);
  db.prepare("UPDATE platforms SET desired_state='RUNNING',lifecycle_state='ACTIVE' WHERE code='douyin'").run();
  db.prepare("INSERT INTO system_settings(setting_key,encrypted_value,updated_at) VALUES('operations.master_enabled','true',?) ON CONFLICT(setting_key) DO UPDATE SET encrypted_value='true'").run(new Date().toISOString());
  const request = (pathname, body) => jsonRequest(runtime.base, pathname, body === undefined ? {} : { method: 'POST', body });
  const enqueue = async () => {
    const response = await request('/api/operations-dashboard/collect', { platformCode: 'douyin' });
    assert.equal(response.response.status, 200, response.text);
    assert.equal(response.data.jobs.length, 1, response.text);
    return response.data.jobs[0].jobId;
  };
  const claim = async (queueLanes = ['GENERAL']) => {
    const response = await request('/api/agent/jobs/claim', { deviceId: account.device_id, platformCodes: ['douyin'], queueLanes });
    assert.equal(response.response.status, 200, response.text);
    return response.data.job;
  };
  const data = (changes = {}) => ({ schemaVersion: 1, capturedAt: new Date().toISOString(),
    sourceUrl: 'https://creator.douyin.com/creator-micro/home', sourceVerified: true, identityVerified: true,
    accountIdentity: { id: 'analytics-test-account', name: '真实运营账号' },
    metrics: [{ key: 'plays', label: '播放量', value: 0, rawValue: '0', scope: 'SNAPSHOT' },
      { key: 'followersTotal', label: '粉丝总数', value: 12, rawValue: '12', scope: 'SNAPSHOT' }],
    evidence: { pageTitle: '创作者中心', accountHeader: '真实运营账号', visibleLabels: ['播放量', '粉丝总数'] }, ...changes });
  const complete = (job, analytics = data(), extra = {}) => request(`/api/agent/jobs/${job.id}/complete`, {
    status: 'SUCCESS', analyticsClaimToken: job.payload.analyticsClaimToken,
    result: { platformCode: 'douyin', analytics, ...extra }
  });
  const snapshots = () => db.prepare('SELECT * FROM platform_analytics_snapshots ORDER BY id').all();
  const jobRow = id => db.prepare('SELECT * FROM agent_jobs WHERE id=?').get(id);
  const businessCounts = () => Object.fromEntries(['messages', 'knowledge', 'hot_topic_knowledge_jobs', 'publish_tasks', 'publish_targets', 'runtime_blocks']
    .map(table => [table, db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n]));
  return { ...runtime, db, account, request, enqueue, claim, data, complete, snapshots, jobRow, businessCounts };
}

test('collect endpoint, claim token, completion and dashboard expose one real latest snapshot without touching business tables', async t => {
  const f = await fixture(t);
  const before = f.businessCounts();
  const id = await f.enqueue();
  const repeated = await f.enqueue();
  assert.equal(repeated, id);
  const job = await f.claim();
  assert.equal(job.id, id);
  assert.equal(job.job_type, 'COLLECT_ANALYTICS');
  assert.equal(job.payload.queueLane, 'GENERAL');
  assert.ok(job.payload.analyticsClaimToken);
  assert.equal(JSON.parse(f.jobRow(id).payload).analyticsClaimToken, job.payload.analyticsClaimToken);
  const result = await f.complete(job, f.data(), { messages: [{ content: '此字段不能进入互动消息' }], knowledge: [{ answer: '不能进入知识库' }] });
  assert.equal(result.response.status, 200, result.text);
  assert.equal(result.data.status, 'SUCCESS');
  assert.equal(f.snapshots().length, 1);
  const dashboard = await f.request('/api/operations-dashboard?range=7d&platform=douyin');
  assert.equal(dashboard.response.status, 200, dashboard.text);
  assert.equal(dashboard.data.dashboard.analytics.accounts.length, 1);
  assert.equal(dashboard.data.dashboard.analytics.accounts[0].metrics.find(item => item.key === 'plays').value, 0);
  assert.equal(dashboard.data.dashboard.analytics.coverage.connectedAccounts, 1);
  assert.ok(dashboard.data.dashboard.kpis.every(item => item.status === 'PENDING_SOURCE' && item.value === null));
  assert.deepEqual(f.businessCounts(), before);
  const late = await f.complete(job);
  assert.equal(late.data.ignored, true);
  assert.equal(f.snapshots().length, 1);
});

test('manual collect respects disabled mode and rejects an unsupported platform', async t => {
  const f = await fixture(t, { enabled: false });
  assert.equal((await f.request('/api/operations-dashboard/collect', { platformCode: 'douyin' })).data.paused, true);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM agent_jobs WHERE job_type='COLLECT_ANALYTICS'").get().n, 0);
  assert.equal((await f.request('/api/operations-dashboard/collect', { platformCode: 'xiaohongshu' })).response.status, 400);
});

test('analytics queued before new private work yields at claim and cannot block private collection', async t => {
  const f = await fixture(t);
  const analyticsId = await f.enqueue();
  const stamp = new Date().toISOString();
  const privateId = Number(f.db.prepare(`INSERT INTO agent_jobs(device_id,job_type,payload,status,attempts,created_at,available_at,queue_lane,channel_type,priority)
    VALUES(?,'COLLECT_MESSAGES',?,'QUEUED',0,?,?,'PRIVATE_MESSAGE','PRIVATE_MESSAGE',20)`).run(f.account.device_id,
    JSON.stringify({ platformCode: 'douyin', accountId: f.account.id, profileName: f.account.profile_name,
      queueLane: 'PRIVATE_MESSAGE', channelType: 'PRIVATE_MESSAGE', types: ['PRIVATE_MESSAGE'] }), stamp, stamp).lastInsertRowid);
  assert.equal(await f.claim(['GENERAL']), null);
  assert.equal(f.jobRow(analyticsId).status, 'QUEUED');
  const privateJob = await f.claim(['PRIVATE_MESSAGE']);
  assert.equal(privateJob.id, privateId);
  assert.equal(await f.claim(['GENERAL']), null);
  const completed = await f.request(`/api/agent/jobs/${privateId}/complete`, {
    status: 'SUCCESS', result: { messages: [], typeResults: [{ type: 'PRIVATE_MESSAGE', status: 'SUCCESS', count: 0 }] }
  });
  assert.equal(completed.response.status, 200, completed.text);
  assert.equal((await f.claim(['GENERAL'])).id, analyticsId);
});

test('manual analytics queues once behind verification without preempting queued or running business work', async t => {
  const f = await fixture(t);
  const stamp = new Date().toISOString();
  const verificationId = Number(f.db.prepare(`INSERT INTO agent_jobs(device_id,job_type,payload,status,attempts,created_at,available_at,queue_lane,priority)
    VALUES(?,'VERIFY_PUBLISH',?,'QUEUED',0,?,?,'COMMENT',60)`).run(f.account.device_id,
    JSON.stringify({ platformCode: 'douyin', accountId: f.account.id, queueLane: 'COMMENT' }), stamp, stamp).lastInsertRowid);
  const scheduled = await f.request('/api/operations-dashboard/collect', { platformCode: 'douyin' });
  assert.equal(scheduled.response.status, 200);
  assert.equal(scheduled.data.jobs.length, 1);
  const analytics = scheduled.data.jobs[0];
  assert.equal(analytics.reused, false);
  assert.equal(f.jobRow(analytics.jobId).priority, 100);
  assert.equal(f.jobRow(analytics.jobId).status, 'QUEUED');
  const repeated = await f.request('/api/operations-dashboard/collect', { platformCode: 'douyin' });
  assert.equal(repeated.response.status, 200, repeated.text);
  assert.deepEqual(repeated.data.jobs, [{ ...analytics, reused: true }]);
  assert.equal(await f.claim(['GENERAL']), null, 'manual enqueue must still yield to queued work in another lane');
  assert.equal((await f.claim(['COMMENT'])).id, verificationId);
  assert.equal(await f.claim(['GENERAL']), null, 'running business work must retain exclusive use of the platform');
  assert.equal(f.jobRow(analytics.jobId).status, 'QUEUED');
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM agent_jobs WHERE job_type='COLLECT_ANALYTICS'").get().n, 1);
});

test('runtime-blocked and disallowed queued business jobs do not starve analytics while running work still blocks it', async t => {
  const f = await fixture(t);
  const stamp = new Date().toISOString();
  const issueId = Number(f.db.prepare(`INSERT INTO issues(source,category,title,detail,created_at,updated_at)
    VALUES('RPA','MESSAGE_COLLECTION','测试采集暂停','仅阻止业务采集',?,?)`).run(stamp, stamp).lastInsertRowid);
  f.db.prepare(`INSERT INTO runtime_blocks(issue_id,scope,block_key,feature,reason,status,created_at)
    VALUES(?,'PLATFORM_FEATURE','douyin:collect','collect','测试采集暂停','ACTIVE',?)`).run(issueId, stamp);
  const addBusiness = type => Number(f.db.prepare(`INSERT INTO agent_jobs(device_id,job_type,payload,status,attempts,created_at,available_at,queue_lane,channel_type,priority)
    VALUES(?,?,?,'QUEUED',0,?,?,'PRIVATE_MESSAGE','PRIVATE_MESSAGE',20)`).run(f.account.device_id, type,
    JSON.stringify({ platformCode: 'douyin', accountId: f.account.id, queueLane: 'PRIVATE_MESSAGE', channelType: 'PRIVATE_MESSAGE' }), stamp, stamp).lastInsertRowid);
  const privateId = addBusiness('COLLECT_MESSAGES');
  const disallowedId = addBusiness('PUBLISH_STATUS_CHECK');
  const analyticsId = await f.enqueue();
  assert.equal((await f.claim(['GENERAL'])).id, analyticsId);
  assert.equal(f.jobRow(privateId).status, 'QUEUED');
  assert.equal(f.jobRow(disallowedId).status, 'QUEUED');

  f.db.prepare("UPDATE agent_jobs SET status='QUEUED',claimed_at=NULL,lease_expires_at=NULL WHERE id=?").run(analyticsId);
  f.db.prepare("UPDATE agent_jobs SET status='RUNNING' WHERE id=?").run(privateId);
  assert.equal(await f.claim(['GENERAL']), null, 'RUNNING work must block analytics even if its runtime feature is currently blocked');
  const scheduled = await f.request('/api/operations-dashboard/collect', { platformCode: 'douyin' });
  assert.equal(scheduled.response.status, 200, scheduled.text);
  assert.deepEqual(scheduled.data.jobs, [{ accountId: f.account.id, platformCode: 'douyin', jobId: analyticsId, reused: true }]);
  assert.equal(await f.claim(['GENERAL']), null, 'reusing the manual task must not bypass running work');
});

test('unverified, empty, mismatched, disabled and changed-profile results fail safely without a runtime block', async t => {
  for (const kind of ['unverified', 'empty', 'identity', 'disabled', 'profile']) await t.test(kind, async t => {
    const f = await fixture(t);
    await f.enqueue();
    const job = await f.claim();
    const before = f.businessCounts();
    let analytics = f.data();
    if (kind === 'unverified') analytics.sourceVerified = false;
    if (kind === 'empty') analytics.metrics = [];
    if (kind === 'identity') analytics.accountIdentity = { id: 'another-account', name: '真实运营账号' };
    if (kind === 'disabled') f.db.prepare('UPDATE accounts SET enabled=0 WHERE id=?').run(f.account.id);
    if (kind === 'profile') f.db.prepare("UPDATE accounts SET profile_name='changed-profile' WHERE id=?").run(f.account.id);
    const response = await f.complete(job, analytics);
    assert.equal(response.response.status, 200, response.text);
    assert.equal(response.data.status, 'FAILED');
    assert.equal(f.jobRow(job.id).status, 'FAILED');
    assert.equal(f.snapshots().length, 0);
    assert.deepEqual(f.businessCounts(), before);
  });
});

test('cancelled or unclaimed completion cannot create or replace a snapshot', async t => {
  const f = await fixture(t);
  const id = await f.enqueue();
  const queued = f.jobRow(id);
  const response = await f.complete({ ...queued, payload: JSON.parse(queued.payload) });
  assert.equal(response.data.ignored, true);
  assert.equal(f.jobRow(id).status, 'QUEUED');
  const job = await f.claim();
  f.db.prepare("UPDATE agent_jobs SET status='CANCELLED',result=? WHERE id=?").run(JSON.stringify({ cancelledBy: 'operator' }), id);
  const cancelled = await f.complete(job);
  assert.equal(cancelled.data.ignored, true);
  assert.equal(f.jobRow(id).status, 'CANCELLED');
  assert.equal(JSON.parse(f.jobRow(id).result).cancelledBy, 'operator');
  assert.equal(f.snapshots().length, 0);
});

test('expired lease or an old claim token is ignored while the current attempt can complete', async t => {
  const f = await fixture(t);
  await f.enqueue();
  const first = await f.claim();
  f.db.prepare('UPDATE agent_jobs SET lease_expires_at=? WHERE id=?').run(new Date(Date.now() - 1000).toISOString(), first.id);
  const expired = await f.complete(first);
  assert.equal(expired.data.ignored, true);
  assert.equal(f.snapshots().length, 0);
  const second = await f.claim();
  assert.equal(second.id, first.id);
  assert.notEqual(second.payload.analyticsClaimToken, first.payload.analyticsClaimToken);
  const stale = await f.complete(first);
  assert.equal(stale.data.ignored, true);
  assert.equal(f.jobRow(second.id).status, 'RUNNING');
  assert.equal(f.snapshots().length, 0);
  const current = await f.complete(second);
  assert.equal(current.data.status, 'SUCCESS');
  assert.equal(f.snapshots().length, 1);
});

test('missing or incorrect claim tokens cannot poison a running analytics attempt', async t => {
  const f = await fixture(t);
  await f.enqueue();
  const job = await f.claim();
  for (const analyticsClaimToken of [undefined, 'other-token']) {
    const response = await f.request(`/api/agent/jobs/${job.id}/complete`, { status: 'SUCCESS', analyticsClaimToken, result: { analytics: f.data() } });
    assert.equal(response.data.ignored, true);
    assert.equal(f.jobRow(job.id).status, 'RUNNING');
    assert.equal(f.snapshots().length, 0);
  }
});
