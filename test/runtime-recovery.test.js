import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { acquireInstanceLock } from '../src/services/instance-lock.js';
import { cleanupDir, freePort, spawnNode, startServer, stopChild, tempRuntimeDir, waitForHttp } from './helpers/runtime.js';

async function waitForExit(child, timeoutMs = 3000) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await Promise.race([
    new Promise(resolve => child.once('exit', resolve)),
    new Promise((_, reject) => setTimeout(() => reject(new Error('进程未按预期退出')), timeoutMs))
  ]);
}

test('实例锁拒绝同一活动进程并能回收 stale lock', () => {
  const dir = tempRuntimeDir('tianhe-lock-');
  try {
    const lockPath = path.join(dir, 'runtime.lock');
    const first = acquireInstanceLock(lockPath, { label: 'lock-test' });
    assert.equal(first.acquired, true);
    assert.throws(() => acquireInstanceLock(lockPath, { label: 'lock-test' }), error => error.code === 'INSTANCE_ALREADY_RUNNING');
    first.release();
    assert.equal(fs.existsSync(lockPath), false);

    fs.writeFileSync(lockPath, JSON.stringify({ pid: 99999999, label: 'stale', startedAt: '2026-01-01T00:00:00.000Z' }));
    const recovered = acquireInstanceLock(lockPath, { label: 'lock-test' });
    assert.equal(recovered.acquired, true);
    recovered.release();
    assert.equal(fs.existsSync(lockPath), false);
  } finally {
    cleanupDir(dir);
  }
});

test('实例锁不会删除同 PID 的替代所有者记录', () => {
  const dir = tempRuntimeDir('tianhe-lock-owner-');
  try {
    const lockPath = path.join(dir, 'runtime.lock');
    const first = acquireInstanceLock(lockPath, { label: 'lock-owner-test' });
    const replacement = JSON.stringify({ pid: process.pid, token: 'replacement-owner' });
    fs.writeFileSync(lockPath, replacement);
    first.release();
    assert.equal(fs.readFileSync(lockPath, 'utf8'), replacement);
  } finally {
    cleanupDir(dir);
  }
});

test('等待型实例锁会在宽限期后忽略损坏的旧锁记录', () => {
  const dir = tempRuntimeDir('tianhe-lock-malformed-');
  try {
    const lockPath = path.join(dir, 'runtime.lock');
    fs.writeFileSync(lockPath, '');
    const startedAt = Date.now();
    const recovered = acquireInstanceLock(lockPath, { label: 'lock-malformed-test', waitMs: 500, retryDelayMs: 10, malformedGraceMs: 100 });
    assert.equal(recovered.acquired, true);
    assert.ok(Date.now() - startedAt >= 75);
    recovered.release();
    assert.equal(fs.existsSync(lockPath), false);
  } finally {
    cleanupDir(dir);
  }
});

test('多个进程争抢同一 stale 锁时关键区保持互斥', async t => {
  const dir = tempRuntimeDir('tianhe-lock-contenders-');
  const lockPath = path.join(dir, 'runtime.lock');
  const criticalPath = path.join(dir, 'critical.marker');
  fs.writeFileSync(lockPath, JSON.stringify({ pid: 99999999, label: 'stale' }));
  const startAt = Date.now() + 1_000;
  const workers = Array.from({ length: 8 }, () => spawnNode([
    'test/helpers/instance-lock-contender.mjs', lockPath, criticalPath, String(startAt)
  ]));
  t.after(async () => {
    await Promise.all(workers.map(worker => stopChild(worker)));
    cleanupDir(dir);
  });

  await Promise.all(workers.map(worker => waitForExit(worker, 12_000)));
  for (const worker of workers) {
    assert.equal(worker.exitCode, 0, `${worker.stdoutText}\n${worker.stderrText}`);
  }
});

test('同一数据库的第二个服务实例被拒绝', async t => {
  const runtime = await startServer();
  t.after(async () => { await stopChild(runtime.child); cleanupDir(runtime.dir); });
  const secondPort = await freePort();
  const second = spawnNode(['src/server.js'], { env: {
    PORT: String(secondPort),
    SERVER_HOST: '127.0.0.1',
    DATABASE_PATH: runtime.dbPath,
    QWEN_MODE: 'mock',
    RPA_MODE: 'simulated',
    AUTO_COLLECT_ENABLED: 'false',
    LOCAL_AGENT_AUTO_START: 'false',
    SMOKE_TEST_ENABLED: 'false',
    INSTANCE_LOCK_ENABLED: 'true'
  } });
  t.after(() => stopChild(second));
  await waitForExit(second);
  assert.notEqual(second.exitCode, 0);
  assert.match(second.stderrText, /already running|INSTANCE_ALREADY_RUNNING|lock:/i);
});

test('同一端口的第二个 Local Agent 实例被拒绝', async t => {
  const port = await freePort();
  const commonEnv = {
    AGENT_PORT: String(port),
    AGENT_HOST: '127.0.0.1',
    CLOUD_BASE_URL: 'http://127.0.0.1:1',
    QWEN_MODE: 'mock',
    RPA_MODE: 'simulated',
    INSTANCE_LOCK_ENABLED: 'true',
    AGENT_PLATFORM_ALLOWLIST: 'douyin,wechat_channels,bilibili,weibo'
  };
  const first = spawnNode(['agent/local-agent.js'], { env: commonEnv });
  t.after(() => stopChild(first));
  await waitForHttp(`http://127.0.0.1:${port}`, '/health', first);
  const second = spawnNode(['agent/local-agent.js'], { env: commonEnv });
  t.after(() => stopChild(second));
  await waitForExit(second);
  assert.notEqual(second.exitCode, 0);
  assert.match(second.stderrText, /already running|INSTANCE_ALREADY_RUNNING|lock:/i);
});

test('服务重启只重排安全任务，发布和回复进入人工确认', async t => {
  const dir = tempRuntimeDir('tianhe-recovery-');
  const port1 = await freePort();
  const first = await startServer({ dir, port: port1 });
  await stopChild(first.child);

  const db = new DatabaseSync(first.dbPath);
  const stamp = new Date().toISOString();
  const smokeRun = db.prepare(`INSERT INTO smoke_test_runs(platform_code,trigger_type,status,started_at,created_at,updated_at)
    VALUES('douyin','MANUAL','RUNNING',?,?,?)`).run(stamp, stamp, stamp);
  const issue = db.prepare(`INSERT INTO issues(source,category,level,title,detail,status,related_type,related_id,created_at,updated_at,occurrences,last_seen_at,retryable)
    VALUES('RPA','MESSAGE_COLLECTION','ERROR','restart diagnosis','network timeout','DIAGNOSING','ACCOUNT','2',?,?,1,?,1)`).run(stamp, stamp, stamp);
  const diagnosis = db.prepare(`INSERT INTO issue_diagnoses(issue_id,mode,status,requested_by,started_at,created_at,updated_at)
    VALUES(?,'READ_ONLY','RUNNING','recovery-test',?,?,?)`).run(Number(issue.lastInsertRowid), stamp, stamp, stamp);
  const insertJob = db.prepare(`INSERT INTO agent_jobs(device_id,job_type,payload,status,created_at,claimed_at,available_at,lease_expires_at)
    VALUES('device-rpa-01',?,?,'RUNNING',?,?,?,?)`);
  const expiry = new Date(Date.now() + 600_000).toISOString();
  insertJob.run('COLLECT_MESSAGES', JSON.stringify({ platformCode: 'weibo' }), stamp, stamp, stamp, expiry);
  insertJob.run('RUN_SMOKE_TEST', JSON.stringify({ platformCode: 'douyin', smokeRunId: Number(smokeRun.lastInsertRowid) }), stamp, stamp, stamp, expiry);
  const diagnosisJob = insertJob.run('DIAGNOSE_ISSUE', JSON.stringify({ platformCode: 'douyin', accountId: 2, issueId: Number(issue.lastInsertRowid), diagnosisId: Number(diagnosis.lastInsertRowid), safeReadOnly: true, mode: 'READ_ONLY' }), stamp, stamp, stamp, expiry);
  db.prepare('UPDATE issue_diagnoses SET agent_job_id=? WHERE id=?').run(Number(diagnosisJob.lastInsertRowid), Number(diagnosis.lastInsertRowid));
  insertJob.run('PUBLISH', JSON.stringify({ platformCode: 'bilibili' }), stamp, stamp, stamp, expiry);
  insertJob.run('REPLY', JSON.stringify({ platformCode: 'wechat_channels' }), stamp, stamp, stamp, expiry);
  db.close();

  const second = await startServer({ dir, port: await freePort() });
  t.after(async () => { await stopChild(second.child); cleanupDir(dir); });

  const verifyDb = new DatabaseSync(first.dbPath, { readOnly: true });
  const jobs = verifyDb.prepare('SELECT job_type,status,result,claimed_at,lease_expires_at FROM agent_jobs ORDER BY id').all();
  const byType = Object.fromEntries(jobs.map(item => [item.job_type, item]));
  assert.equal(byType.COLLECT_MESSAGES.status, 'QUEUED');
  assert.equal(byType.COLLECT_MESSAGES.claimed_at, null);
  assert.equal(byType.COLLECT_MESSAGES.lease_expires_at, null);
  assert.equal(JSON.parse(byType.COLLECT_MESSAGES.result).reason, 'PROCESS_RESTART_SAFE_REQUEUE');
  assert.equal(byType.RUN_SMOKE_TEST.status, 'CANCELLED');
  assert.equal(JSON.parse(byType.RUN_SMOKE_TEST.result).reason, 'SMOKE_TEST_REMOVED');
  assert.equal(byType.DIAGNOSE_ISSUE.status, 'QUEUED');
  assert.equal(byType.DIAGNOSE_ISSUE.claimed_at, null);
  assert.equal(byType.DIAGNOSE_ISSUE.lease_expires_at, null);
  assert.equal(byType.PUBLISH.status, 'NEEDS_CONFIRMATION');
  assert.equal(byType.REPLY.status, 'NEEDS_CONFIRMATION');
  assert.equal(JSON.parse(byType.PUBLISH.result).reason, 'PROCESS_RESTART_NON_IDEMPOTENT');
  assert.equal(JSON.parse(byType.REPLY.result).reason, 'PROCESS_RESTART_NON_IDEMPOTENT');
  const run = verifyDb.prepare('SELECT status,started_at,error_message FROM smoke_test_runs WHERE id=?').get(Number(smokeRun.lastInsertRowid));
  assert.equal(run.status, 'CANCELLED');
  assert.ok(run.error_message);
  const recoveredDiagnosis = verifyDb.prepare('SELECT status,started_at,completed_at FROM issue_diagnoses WHERE id=?').get(Number(diagnosis.lastInsertRowid));
  assert.equal(recoveredDiagnosis.status, 'QUEUED');
  assert.equal(recoveredDiagnosis.started_at, null);
  assert.equal(recoveredDiagnosis.completed_at, null);
  verifyDb.close();
});
