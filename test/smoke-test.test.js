import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { cleanupDir, jsonRequest, startServer, stopChild } from './helpers/runtime.js';

const platforms = ['xiaohongshu','douyin','wechat_channels','bilibili','weibo'];

async function enableAndStart(base, account) {
  if (!account.enabled) {
    const enabled = await jsonRequest(base, `/api/accounts/${account.id}/runtime`, { method: 'POST', body: { enabled: true, updatedBy: 'diagnosis-test' } });
    assert.equal(enabled.response.status, 200);
  }
  const started = await jsonRequest(base, `/api/platforms/${account.platform_code}/runtime`, { method: 'POST', body: { enabled: true, updatedBy: 'diagnosis-test' } });
  assert.equal(started.response.status, 200);
}

function insertAccountIssue(dbPath, account, suffix = '') {
  const db = new DatabaseSync(dbPath);
  const stamp = new Date().toISOString();
  const result = db.prepare(`INSERT INTO issues(source,category,level,title,detail,status,related_type,related_id,created_at,updated_at,occurrences,last_seen_at,retryable,block_scope,block_key)
    VALUES('RPA','MESSAGE_COLLECTION','ERROR',?,'network timeout before any write','OPEN','ACCOUNT',?,?,?,1,?,1,'ACCOUNT',?)`)
    .run(`${account.platform_code} collection failed${suffix}`, String(account.id), stamp, stamp, stamp, String(account.id));
  const issueId = Number(result.lastInsertRowid);
  db.prepare(`INSERT INTO runtime_blocks(issue_id,scope,block_key,feature,reason,status,created_at)
    VALUES(?,'ACCOUNT',?,'collect',?,'ACTIVE',?)`).run(issueId, String(account.id), `${account.platform_code} collection failed${suffix}`, stamp);
  db.close();
  return issueId;
}

test('页面巡检写接口永久下线且启动后不创建 Smoke 任务', async t => {
  const runtime = await startServer();
  t.after(async () => { await stopChild(runtime.child); cleanupDir(runtime.dir); });
  for (const [pathname, body] of [
    ['/api/smoke-tests/run', { platformCode: 'douyin' }],
    ['/api/smoke-tests/1/review', { action: 'NO_CHANGE' }],
    ['/api/smoke-tests/1/retest', {}]
  ]) {
    const response = await jsonRequest(runtime.base, pathname, { method: 'POST', body });
    assert.equal(response.response.status, 410);
    assert.equal(response.data.code, 'SMOKE_TEST_REMOVED');
  }
  const db = new DatabaseSync(runtime.dbPath, { readOnly: true });
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM agent_jobs WHERE job_type='RUN_SMOKE_TEST'").get().count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM smoke_test_runs').get().count, 0);
  db.close();
});

test('AI 自检仅唤醒关联且已开启的平台，并以只读 payload 完成诊断', async t => {
  const runtime = await startServer({ env: { ISSUE_DIAGNOSIS_ENABLED: 'true' } });
  t.after(async () => { await stopChild(runtime.child); cleanupDir(runtime.dir); });
  const bootstrap = await jsonRequest(runtime.base, '/api/bootstrap');
  const douyin = bootstrap.data.accounts.find(item => item.platform_code === 'douyin');
  const weibo = bootstrap.data.accounts.find(item => item.platform_code === 'weibo');
  const issueId = insertAccountIssue(runtime.dbPath, douyin);

  const stopped = await jsonRequest(runtime.base, `/api/platforms/douyin/runtime`, { method: 'POST', body: { enabled: false, updatedBy: 'diagnosis-test' } });
  assert.equal(stopped.response.status, 200);
  const denied = await jsonRequest(runtime.base, `/api/issues/${issueId}/diagnose`, { method: 'POST', body: { requestedBy: 'tester' } });
  assert.equal(denied.response.status, 409);
  assert.equal(denied.data.code, 'DIAGNOSIS_PLATFORM_STOPPED');
  let db = new DatabaseSync(runtime.dbPath, { readOnly: true });
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM issue_diagnoses WHERE issue_id=?').get(issueId).count, 0);
  db.close();

  await enableAndStart(runtime.base, douyin);
  const started = await jsonRequest(runtime.base, `/api/issues/${issueId}/diagnose`, { method: 'POST', body: { requestedBy: 'tester' } });
  assert.equal(started.response.status, 202);
  assert.equal(started.data.issue.status, 'DIAGNOSING');
  const duplicate = await jsonRequest(runtime.base, `/api/issues/${issueId}/diagnose`, { method: 'POST', body: { requestedBy: 'tester' } });
  assert.equal(duplicate.response.status, 409);
  assert.equal(duplicate.data.code, 'DIAGNOSIS_ALREADY_ACTIVE');

  const wrongPlatformClaim = await jsonRequest(runtime.base, '/api/agent/jobs/claim', { method: 'POST', body: { deviceId: weibo.device_id, platformCodes: ['weibo'] } });
  assert.equal(wrongPlatformClaim.data.job, null);
  const claim = await jsonRequest(runtime.base, '/api/agent/jobs/claim', { method: 'POST', body: { deviceId: douyin.device_id, platformCodes: ['douyin'] } });
  assert.equal(claim.data.job.job_type, 'DIAGNOSE_ISSUE');
  assert.equal(claim.data.job.payload.platformCode, 'douyin');
  assert.equal(claim.data.job.payload.accountId, douyin.id);
  assert.equal(claim.data.job.payload.safeReadOnly, true);
  assert.equal(claim.data.job.payload.mode, 'READ_ONLY');
  assert.equal(claim.data.job.payload.pages.every(page => String(page.url).startsWith('https://')), true);

  const completed = await jsonRequest(runtime.base, `/api/agent/jobs/${claim.data.job.id}/complete`, { method: 'POST', body: {
    status: 'SUCCESS', result: { safeReadOnly: true, mode: 'READ_ONLY', message: 'network timeout before any write', failedStage: 'page_open', pages: [] }
  } });
  assert.equal(completed.response.status, 200);
  const issues = await jsonRequest(runtime.base, '/api/issues');
  const finalIssue = issues.data.issues.find(item => item.id === issueId);
  assert.equal(finalIssue.status, 'DIAGNOSED');
  assert.equal(finalIssue.latest_diagnosis.status, 'COMPLETED');
  assert.equal(finalIssue.latest_diagnosis.safe_to_retry, 1);
  assert.equal(finalIssue.active_block.status, 'ACTIVE');
});

test('人工已处理只释放本问题阻断；五平台问题和诊断任务相互隔离', async t => {
  const runtime = await startServer({ env: { ISSUE_DIAGNOSIS_ENABLED: 'true' } });
  t.after(async () => { await stopChild(runtime.child); cleanupDir(runtime.dir); });
  const bootstrap = await jsonRequest(runtime.base, '/api/bootstrap');
  const accounts = Object.fromEntries(bootstrap.data.accounts.filter(item => platforms.includes(item.platform_code)).map(item => [item.platform_code, item]));
  for (const account of Object.values(accounts)) await enableAndStart(runtime.base, account);

  const ids = Object.fromEntries(platforms.map(code => [code, insertAccountIssue(runtime.dbPath, accounts[code], '-isolated')]));
  const secondDouyin = insertAccountIssue(runtime.dbPath, accounts.douyin, '-second');
  for (const id of Object.values(ids)) {
    const response = await jsonRequest(runtime.base, `/api/issues/${id}/diagnose`, { method: 'POST', body: { requestedBy: 'isolation-test' } });
    assert.equal(response.response.status, 202);
  }

  const db = new DatabaseSync(runtime.dbPath, { readOnly: true });
  const queued = db.prepare("SELECT payload FROM agent_jobs WHERE job_type='DIAGNOSE_ISSUE' AND status='QUEUED' ORDER BY id").all().map(item => JSON.parse(item.payload));
  assert.deepEqual(new Set(queued.map(item => item.platformCode)), new Set(platforms));
  assert.equal(queued.every(item => Number(item.accountId) === Number(accounts[item.platformCode].id)), true);
  db.close();

  const resolved = await jsonRequest(runtime.base, `/api/issues/${ids.douyin}/manual-resolve`, { method: 'POST', body: { resolvedBy: 'operator', resolution: '人工检查完成' } });
  assert.equal(resolved.response.status, 200);
  assert.equal(resolved.data.issue.status, 'RESOLVED');
  assert.equal(resolved.data.issue.active_block, null);
  const allIssues = await jsonRequest(runtime.base, '/api/issues');
  const stillBlocked = allIssues.data.issues.find(item => item.id === secondDouyin);
  assert.equal(stillBlocked.status, 'OPEN');
  assert.equal(stillBlocked.active_block.status, 'ACTIVE');
  for (const code of platforms.filter(code => code !== 'douyin')) {
    assert.equal(allIssues.data.issues.find(item => item.id === ids[code]).active_block.status, 'ACTIVE');
  }
});
