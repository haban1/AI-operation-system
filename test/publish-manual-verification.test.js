import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { DatabaseSync } from 'node:sqlite';
import { AssistedPlatformRpaAdapter } from '../agent/rpa-adapters/assisted-platform.js';
import { DouyinAssistedRpaAdapter } from '../agent/rpa-adapters/douyin-assisted.js';
import { isPublishSecurityChallenge } from '../src/services/publish-manual-verification.js';
import { root, tempRuntimeDir, cleanupDir, startServer, stopChild, jsonRequest } from './helpers/runtime.js';

for (const kind of ['generic', 'douyin']) {
  for (const stage of ['login_check', 'preparation', 'after_submit']) {
    const afterClick = stage === 'after_submit';
    test(`${kind}: security challenge at ${stage} preserves the page and waits for the operator`, async t => {
      const dir = tempRuntimeDir('publish-security-adapter-');
      t.after(() => cleanupDir(dir));
      const materialPath = path.join(dir, 'fixture.mp4');
      fs.writeFileSync(materialPath, 'fixture');
      const options = { platformCode: 'douyin', logsDir: path.join(dir, 'logs'), profileDir: path.join(dir, 'profile'), loginTimeoutMs: 10, sendTimeoutMs: 10 };
      const adapter = kind === 'douyin' ? new DouyinAssistedRpaAdapter(options) : new AssistedPlatformRpaAdapter(options);
      let clicks = 0;
      let saves = 0;
      let navigations = 0;
      let fronts = 0;
      const page = {
        goto: async () => { navigations += 1; }, waitForTimeout: async () => {},
        bringToFront: async () => { fronts += 1; }, isClosed: () => false,
        locator: selector => selector === 'body' ? { allInnerTexts: async () => ['请完成安全验证'] } : { evaluateAll: async () => [] }
      };
      adapter.getPage = async () => page;
      adapter.waitForReady = async () => stage !== 'login_check';
      adapter.assertRuntimeAllowed = async () => {};
      adapter.evidence = async (_payload, message, _page, stage, extra) => ({ message, stage, ...extra });
      adapter.preserveDraftForManualAction = async () => { saves += 1; throw new Error('must preserve the current security page'); };
      adapter.prepareDraft = async () => {
        if (!afterClick) throw Object.assign(new Error('平台要求人工安全验证，已停止提交'), { code: 'PLATFORM_SECURITY_VERIFICATION_REQUIRED' });
        return { prepared: true };
      };
      adapter.clickFinalPublish = async () => { clicks += 1; adapter.douyinPublishAttempted = true; return { clicked: true }; };
      const output = await adapter.publish({ materialPath, publishMode: 'AUTO', managementConfirmed: true });
      assert.equal(output.status, 'NEEDS_CONFIRMATION');
      assert.equal(output.result.manualSecurityVerificationRequired, true);
      assert.equal(output.result.submitAttempted, afterClick);
      assert.equal(output.result.draftPreservedInBrowser, true);
      assert.equal(output.result.safeToRetry, false);
      assert.equal(output.result.verificationRequired, false);
      assert.equal(clicks, afterClick ? 1 : 0);
      assert.equal(saves, 0);
      adapter.status = async () => ({ state: 'VERIFY_REQUIRED' });
      await adapter.openManualAction();
      assert.equal(navigations, 1, 'opening the manual action must not reload the challenge');
      assert.equal(fronts, 2);
    });
  }
}

test('ordinary upload/network errors are not security challenges', () => {
  assert.equal(isPublishSecurityChallenge({ code: 'PLATFORM_UPLOAD_FAILED', message: '上传网络中断' }), false);
  assert.equal(isPublishSecurityChallenge({ stage: 'material_missing' }), false);
  assert.equal(isPublishSecurityChallenge({ stage: 'publish_verification_required', manualSecurityVerificationRequired: false }), false);
});

function seedTarget(db, { status = 'RUNNING', result = {} } = {}) {
  const stamp = new Date().toISOString();
  const account = db.prepare("SELECT * FROM accounts WHERE platform_code='douyin' LIMIT 1").get();
  const taskId = Number(db.prepare("INSERT INTO publish_tasks(title,body,material_path,status,created_at,updated_at) VALUES('manual security fixture','body','fixture.mp4','EXECUTING',?,?)").run(stamp, stamp).lastInsertRowid);
  const targetId = Number(db.prepare("INSERT INTO publish_targets(task_id,platform_code,account_id,status,submission_status,review_status,publish_attempt_state,submit_lock,result,updated_at) VALUES(?,'douyin',?,?,'NOT_SUBMITTED','UNKNOWN','NOT_ATTEMPTED','UNLOCKED',?,?)").run(taskId, account.id, status, JSON.stringify(result), stamp).lastInsertRowid);
  const payload = { taskId, targetId, platformCode: 'douyin', accountId: account.id, title: 'manual security fixture' };
  const jobId = Number(db.prepare("INSERT INTO agent_jobs(device_id,job_type,payload,status,created_at,available_at,lease_expires_at) VALUES(?,'PUBLISH',?,'RUNNING',?,?,?)").run(account.device_id, JSON.stringify(payload), stamp, stamp, new Date(Date.now() + 60000).toISOString()).lastInsertRowid);
  return { taskId, targetId, account, payload, jobId, stamp };
}

test('security wait pauses platform jobs; manual confirmation schedules only idempotent read-only verification', async t => {
  const runtime = await startServer();
  const db = new DatabaseSync(runtime.dbPath);
  db.exec('PRAGMA busy_timeout=15000');
  t.after(async () => { db.close(); await stopChild(runtime.child); cleanupDir(runtime.dir); });
  const fixture = seedTarget(db);
  const { targetId, taskId, account, payload, jobId, stamp } = fixture;
  const complete = (id, status, result) => jsonRequest(runtime.base, `/api/agent/jobs/${id}/complete`, { method: 'POST', body: { status, result } });
  const target = () => db.prepare('SELECT * FROM publish_targets WHERE id=?').get(targetId);
  const response = await complete(jobId, 'FAILED', { message: '平台要求人工安全验证，已停止提交' });
  assert.equal(response.response.status, 200, response.text);
  assert.equal(target().status, 'NEEDS_CONFIRMATION');
  assert.equal(JSON.parse(target().result).manualSecurityVerificationRequired, true);
  assert.equal(db.prepare('SELECT status FROM agent_jobs WHERE id=?').get(jobId).status, 'NEEDS_CONFIRMATION');
  assert.notEqual(db.prepare('SELECT status FROM publish_tasks WHERE id=?').get(taskId).status, 'FAILED');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM issues WHERE related_type='PUBLISH_TARGET' AND related_id=? AND status='OPEN'").get(String(targetId)).n, 0);
  assert.deepEqual(response.data.manualPublishWaitPlatforms, ['douyin']);
  const runtimeResponse = await jsonRequest(runtime.base, '/api/agent/platform-runtime');
  assert.deepEqual(runtimeResponse.data.manualPublishWaitPlatforms, ['douyin']);
  const collectId = Number(db.prepare("INSERT INTO agent_jobs(device_id,job_type,payload,status,created_at,available_at) VALUES(?,'COLLECT_MESSAGES',?,'QUEUED',?,?)").run(account.device_id, JSON.stringify({ platformCode: 'douyin', accountId: account.id }), stamp, stamp).lastInsertRowid);
  const claim = await jsonRequest(runtime.base, '/api/agent/jobs/claim', { method: 'POST', body: { deviceId: account.device_id, platformCodes: ['douyin'] } });
  assert.equal(claim.response.status, 200, claim.text);
  assert.equal(claim.data.job, null);
  assert.equal(db.prepare('SELECT status FROM agent_jobs WHERE id=?').get(collectId).status, 'QUEUED');
  db.prepare("UPDATE agent_jobs SET status='CANCELLED' WHERE id=?").run(collectId);

  const confirm = () => jsonRequest(runtime.base, `/api/publish/targets/${targetId}/manual-published`, { method: 'POST', body: { handledBy: 'test operator' } });
  const confirmed = await confirm();
  assert.equal(confirmed.response.status, 200, confirmed.text);
  assert.equal(target().status, 'SUBMITTED');
  assert.equal(target().review_status, 'UNKNOWN');
  assert.equal(target().submit_lock, 'LOCKED');
  assert.equal(JSON.parse(target().result).manuallyConfirmed, false);
  assert.equal(JSON.parse(target().result).manualSubmissionConfirmed, true);
  const duplicate = await confirm();
  assert.equal(duplicate.data.idempotent, true);
  let queued = db.prepare("SELECT * FROM agent_jobs WHERE status='QUEUED' AND CAST(json_extract(payload,'$.targetId') AS INTEGER)=?").all(targetId);
  assert.equal(queued.length, 1);
  assert.equal(queued[0].job_type, 'VERIFY_PUBLISH');
  const releasedRuntime = await jsonRequest(runtime.base, '/api/agent/platform-runtime');
  assert.deepEqual(releasedRuntime.data.manualPublishWaitPlatforms, []);

  const verification = await jsonRequest(runtime.base, '/api/agent/jobs/claim', { method: 'POST', body: { deviceId: account.device_id, platformCodes: ['douyin'] } });
  assert.equal(verification.data.job?.id, queued[0].id, verification.text);
  await complete(queued[0].id, 'NEEDS_CONFIRMATION', { reviewStatus: 'UNKNOWN', message: '尚未找到已发布作品' });
  assert.notEqual(target().status, 'PUBLISHED');
  assert.equal(JSON.parse(target().result).manualSubmissionConfirmed, true);
  queued = db.prepare("SELECT * FROM agent_jobs WHERE status='QUEUED' AND CAST(json_extract(payload,'$.targetId') AS INTEGER)=?").all(targetId);
  assert.equal(queued.length, 1);
  assert.equal(queued[0].job_type, 'VERIFY_PUBLISH');
  db.prepare("UPDATE agent_jobs SET status='RUNNING' WHERE id=?").run(queued[0].id);
  await complete(queued[0].id, 'SUCCESS', { reviewStatus: 'PUBLISHED', platformPostId: '1234567890', platformUrl: 'https://www.douyin.com/video/1234567890', message: '作品管理已核验发布成功' });
  assert.equal(target().status, 'PUBLISHED');
  assert.equal(target().platform_post_id, '1234567890');
  assert.equal(JSON.parse(target().result).manualAction, 'PUBLISHED_VERIFIED_ON_PLATFORM');
  assert.equal(JSON.parse(target().result).manuallyConfirmed, true);
  await complete(jobId, 'FAILED', { message: 'late failed publish' });
  await complete(queued[0].id, 'NEEDS_CONFIRMATION', { reviewStatus: 'UNKNOWN', message: 'late unknown verification' });
  assert.equal(target().status, 'PUBLISHED');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM agent_jobs WHERE status='QUEUED' AND CAST(json_extract(payload,'$.targetId') AS INTEGER)=?").get(targetId).n, 0);

  const ordinary = seedTarget(db);
  await complete(ordinary.jobId, 'FAILED', { stage: 'material_missing', submitAttempted: false, message: '本地素材不存在' });
  assert.equal(db.prepare('SELECT status FROM publish_targets WHERE id=?').get(ordinary.targetId).status, 'FAILED');
  const postClick = seedTarget(db);
  await complete(postClick.jobId, 'NEEDS_CONFIRMATION', { stage: 'publish_verification_required', submitAttempted: true });
  const postClickTarget = db.prepare('SELECT * FROM publish_targets WHERE id=?').get(postClick.targetId);
  assert.equal(postClickTarget.status, 'NEEDS_CONFIRMATION');
  assert.equal(postClickTarget.submit_lock, 'LOCKED');
  assert.equal(postClickTarget.publish_attempt_state, 'SUBMIT_ATTEMPTED_UNCONFIRMED');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM agent_jobs WHERE status='QUEUED' AND job_type='VERIFY_PUBLISH' AND CAST(json_extract(payload,'$.targetId') AS INTEGER)=?").get(postClick.targetId).n, 0);
});

test('startup upgrades legacy security failures and manual success records without reposting', async t => {
  let runtime = await startServer();
  const dir = runtime.dir;
  const db = new DatabaseSync(runtime.dbPath);
  db.exec('PRAGMA busy_timeout=15000');
  t.after(async () => { db.close(); await stopChild(runtime.child); cleanupDir(dir); });
  const failed = seedTarget(db, { status: 'FAILED', result: { message: '平台要求人工安全验证，已停止提交' } });
  db.prepare("UPDATE agent_jobs SET status='FAILED' WHERE id=?").run(failed.jobId);
  const old = seedTarget(db, { status: 'PUBLISHED', result: { manuallyConfirmed: true, manualAction: 'PUBLISHED_ON_PLATFORM', handledBy: 'legacy operator' } });
  db.prepare("UPDATE publish_targets SET submission_status='SUBMITTED',submit_lock='LOCKED',publish_attempt_state='PUBLISHED',submitted_at=? WHERE id=?").run(old.stamp, old.targetId);
  db.prepare("UPDATE agent_jobs SET status='SUCCESS' WHERE id=?").run(old.jobId);
  await stopChild(runtime.child);
  runtime = await startServer({ dir });
  assert.equal(db.prepare('SELECT status FROM publish_targets WHERE id=?').get(failed.targetId).status, 'NEEDS_CONFIRMATION');
  assert.equal(db.prepare('SELECT status FROM agent_jobs WHERE id=?').get(failed.jobId).status, 'NEEDS_CONFIRMATION');
  assert.equal(db.prepare('SELECT status FROM publish_targets WHERE id=?').get(old.targetId).status, 'SUBMITTED');
  const pending = db.prepare("SELECT * FROM agent_jobs WHERE status='QUEUED'").all();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].job_type, 'VERIFY_PUBLISH');
  assert.equal(JSON.parse(pending[0].payload).submittedAt, old.stamp);
  await stopChild(runtime.child);
  runtime = await startServer({ dir });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM agent_jobs WHERE status='QUEUED'").get().n, 1);
});

test('task stream displays security waiting as a manual step instead of a failure', () => {
  const source = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');
  const start = source.indexOf('function taskDisplayStatus(');
  const end = source.indexOf('\nfunction ', start + 1);
  const context = vm.createContext({ taskTargetResult: target => target.result || {} });
  vm.runInContext(source.slice(start, end), context);
  const waiting = { status: 'NEEDS_CONFIRMATION', targets: [{ status: 'NEEDS_CONFIRMATION', result: { manualSecurityVerificationRequired: true } }] };
  assert.equal(context.taskDisplayStatus(waiting), 'WAITING_MANUAL_SECURITY');
  assert.equal(context.taskDisplayStatus({ ...waiting, status: 'FAILED', targets: [...waiting.targets, { status: 'FAILED' }] }), 'FAILED');
  context.bilibiliManagementBlockReason = () => null;
  const fallbackStart = source.indexOf('function manualPublishFallbackState(');
  vm.runInContext(source.slice(fallbackStart, source.indexOf('\nfunction ', fallbackStart + 1)), context);
  const manual = { status: 'NEEDS_CONFIRMATION', publish_attempt_state: 'DRAFT_BLOCKED', result: { manualActionRequired: true, manualSecurityVerificationRequired: true } };
  assert.equal(context.manualPublishFallbackState(manual).label, '待人工安全验证发布');
  assert.equal(context.manualPublishFallbackState(manual).canConfirm, true);
  const verified = { status: 'PUBLISHED', publish_attempt_state: 'PUBLISHED', result: { manualSubmissionConfirmed: true } };
  assert.equal(context.manualPublishFallbackState(verified).label, '人工发布已通过平台核验');
  assert.equal(context.manualPublishFallbackState(verified).canConfirm, false);
});
