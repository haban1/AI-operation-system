import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createPlatformAnalyticsScheduler } from '../src/services/platform-analytics-scheduler.js';

function fixture(t, options = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE accounts(id INTEGER PRIMARY KEY,platform_code TEXT,enabled INTEGER,login_status TEXT,device_id TEXT,profile_name TEXT);
    CREATE TABLE agent_jobs(id INTEGER PRIMARY KEY AUTOINCREMENT,job_type TEXT,status TEXT,payload TEXT,created_at TEXT,available_at TEXT);`);
  t.after(() => db.close());
  const f = { db, time: Date.parse('2026-11-02T04:00:00Z'), calls: [], timers: [], cleared: [] };
  f.account = (id = 1, platform = 'douyin', enabled = 1, login = 'READY') => db.prepare('INSERT INTO accounts VALUES(?,?,?,?,?,?)')
    .run(id, platform, enabled, login, 'device-1', `profile-${platform}-main`);
  f.job = (type = 'COLLECT_ANALYTICS', status = 'SUCCESS', payload = { accountId: 1, platformCode: 'douyin' }, createdAt = new Date(f.time).toISOString()) => Number(
    db.prepare('INSERT INTO agent_jobs(job_type,status,payload,created_at) VALUES(?,?,?,?)').run(type, status, JSON.stringify(payload), createdAt).lastInsertRowid);
  f.scheduler = createPlatformAnalyticsScheduler({ db, now: () => f.time, canRunAccount: () => true,
    createJob(deviceId, type, payload, jobOptions) {
      f.calls.push({ deviceId, type, payload, options: jobOptions });
      return f.job(type, 'QUEUED', payload);
    },
    setTimer(callback, delay) { const timer = { callback, delay, unref() {} }; f.timers.push(timer); return timer; },
    clearTimer(timer) { f.cleared.push(timer); }, ...options });
  return f;
}

test('scheduler queues only ready enabled supported accounts as low priority read-only GENERAL work', t => {
  const f = fixture(t);
  f.account(); f.account(2, 'bilibili'); f.account(3, 'weibo', 0); f.account(4, 'wechat_channels', 1, 'UNKNOWN');
  f.account(5, 'xiaohongshu'); f.account(6, 'mini_program');
  const result = f.scheduler.enqueue();
  assert.deepEqual(result.jobs.map(item => item.accountId), [1, 2]);
  assert.equal(f.calls.length, 2);
  for (const call of f.calls) {
    assert.equal(call.type, 'COLLECT_ANALYTICS');
    assert.equal(call.payload.queueLane, 'GENERAL');
    assert.equal(call.payload.safeReadOnly, true);
    assert.equal(call.options.priority, 100);
    assert.equal(call.payload.profileName, `profile-${call.payload.platformCode}-main`);
    assert.match(call.options.idempotencyKey, /^analytics:/);
  }
});

test('scheduler respects disabled mode, platform runtime and manual platform filtering', t => {
  const disabled = fixture(t, { enabled: false }); disabled.account();
  assert.deepEqual(disabled.scheduler.enqueue(), { jobs: [], paused: true, skipped: [] });
  disabled.scheduler.start(); assert.equal(disabled.timers.length, 0);
  const stopped = fixture(t, { canRunAccount: () => false }); stopped.account();
  assert.equal(stopped.scheduler.enqueue().skipped[0].reason, 'PLATFORM_PAUSED');
  assert.equal(stopped.calls.length, 0);
  const active = fixture(t); active.account(); active.account(2, 'bilibili');
  assert.deepEqual(active.scheduler.enqueue({ platformCode: 'bilibili' }).jobs.map(item => item.platformCode), ['bilibili']);
});

test('automatic collection skips busy business work while manual collection queues once at low priority', async t => {
  for (const type of ['PUBLISH', 'VERIFY_PUBLISH', 'COLLECT_MESSAGES', 'DETECT_MANUAL_REPLY', 'REPLY']) await t.test(type, t => {
    const f = fixture(t); f.account();
    f.job(type, 'QUEUED', { platformCode: 'douyin', accountId: 1, queueLane: 'PRIVATE_MESSAGE' });
    const result = f.scheduler.enqueue();
    assert.equal(result.jobs.length, 0);
    assert.equal(result.skipped[0].reason, 'BUSINESS_OPERATION_PENDING');
    assert.equal(f.calls.length, 0);
    const manual = f.scheduler.enqueue({ force: true });
    assert.equal(manual.jobs.length, 1);
    assert.equal(manual.jobs[0].reused, false);
    assert.equal(f.calls[0].options.priority, 100);
    assert.equal(f.calls[0].payload.queueLane, 'GENERAL');
    const repeated = f.scheduler.enqueue({ force: true });
    assert.deepEqual(repeated.jobs, [{ ...manual.jobs[0], reused: true }]);
    assert.equal(f.calls.length, 1, 'repeated manual collection must reuse the waiting task');
  });
});

test('pending business work on another platform does not block the requested platform', t => {
  const f = fixture(t); f.account();
  f.job('PUBLISH', 'RUNNING', { platformCode: 'bilibili', accountId: 2 });
  assert.equal(f.scheduler.enqueue().jobs.length, 1);
  const future = fixture(t); future.account();
  const later = future.job('VERIFY_PUBLISH', 'QUEUED', { platformCode: 'douyin', accountId: 1 });
  future.db.prepare('UPDATE agent_jobs SET available_at=? WHERE id=?').run(new Date(future.time + 3600_000).toISOString(), later);
  assert.equal(future.scheduler.enqueue().jobs.length, 1, 'a future scheduled check must not block current analytics');
});

test('scheduler ignores unclaimable queued business work but still yields to runnable and running work', t => {
  const checked = [];
  const blocked = fixture(t, { canRunBusinessJob: job => { checked.push(job); return false; } });
  blocked.account();
  const blockedId = blocked.job('COLLECT_MESSAGES', 'QUEUED');
  assert.equal(blocked.scheduler.enqueue().jobs.length, 1);
  assert.equal(checked[0].id, blockedId);
  assert.equal(checked[0].job_type, 'COLLECT_MESSAGES');
  assert.equal(JSON.parse(checked[0].payload).accountId, 1);

  const mixed = fixture(t, { canRunBusinessJob: job => job.job_type === 'REPLY' });
  mixed.account(); mixed.job('COLLECT_MESSAGES', 'QUEUED'); mixed.job('REPLY', 'QUEUED');
  assert.equal(mixed.scheduler.enqueue().skipped[0].reason, 'BUSINESS_OPERATION_PENDING', 'a blocked first row must not hide later runnable work');

  const running = fixture(t, { canRunBusinessJob() { assert.fail('RUNNING work must be respected without checking claimability'); } });
  running.account(); running.job('COLLECT_MESSAGES', 'RUNNING');
  assert.equal(running.scheduler.enqueue().skipped[0].reason, 'BUSINESS_OPERATION_PENDING');
});

test('already queued or running analytics is reused per account without another scan', t => {
  for (const status of ['QUEUED', 'RUNNING']) {
    const f = fixture(t); f.account();
    const id = f.job('COLLECT_ANALYTICS', status);
    const result = f.scheduler.enqueue({ force: true });
    assert.deepEqual(result.jobs, [{ accountId: 1, platformCode: 'douyin', jobId: id, reused: true }]);
    assert.equal(f.calls.length, 0);
  }
});

test('automatic scans wait thirty minutes while manual retries still enforce a one-minute gap', t => {
  const f = fixture(t); f.account(); f.job();
  f.time += 59_999;
  assert.equal(f.scheduler.enqueue({ force: true }).skipped[0].reason, 'RECENTLY_COLLECTED');
  f.time += 1;
  assert.equal(f.scheduler.enqueue().jobs.length, 0);
  assert.equal(f.scheduler.enqueue({ force: true }).jobs.length, 1);
  f.db.prepare("UPDATE agent_jobs SET status='SUCCESS'").run();
  f.time += 30 * 60_000;
  assert.equal(f.scheduler.enqueue().jobs.length, 1);
});

test('start is idempotent and stop cancels the current timer without scheduling another', t => {
  const f = fixture(t); f.account();
  f.scheduler.start(); f.scheduler.start();
  assert.equal(f.timers.length, 1);
  assert.equal(f.timers[0].delay, 15_000);
  f.timers[0].callback();
  assert.equal(f.calls.length, 1);
  assert.equal(f.timers.length, 2);
  assert.equal(f.timers[1].delay, 60_000);
  f.scheduler.stop();
  assert.deepEqual(f.cleared, [f.timers[1]]);
});

test('a busy first poll retries on the next minute without weakening per-account collection throttling', t => {
  const f = fixture(t); f.account();
  const businessId = f.job('COLLECT_MESSAGES', 'RUNNING');
  f.scheduler.start();
  f.timers[0].callback();
  assert.equal(f.calls.length, 0);
  assert.equal(f.timers[1].delay, 60_000);
  f.time += 60_000;
  f.db.prepare("UPDATE agent_jobs SET status='SUCCESS' WHERE id=?").run(businessId);
  f.timers[1].callback();
  assert.equal(f.calls.length, 1);
  f.db.prepare("UPDATE agent_jobs SET status='SUCCESS' WHERE job_type='COLLECT_ANALYTICS'").run();
  f.time += 60_000;
  f.timers[2].callback();
  assert.equal(f.calls.length, 1, 'minute polling must still respect the thirty-minute per-account gap');
});
