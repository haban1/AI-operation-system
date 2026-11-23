import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { chromium } from 'playwright-core';
import { WechatChannelsAssistedRpaAdapter } from '../agent/rpa-adapters/wechat-channels-assisted.js';
import { validatePlatformResultProvenance } from '../src/services/publish-verification-policy.js';
import { startServer, stopChild, cleanupDir, tempRuntimeDir, jsonRequest } from './helpers/runtime.js';

const platformCode = 'wechat_channels';
const verificationPolicyId = 'wechat-channels-publish-status-v1';
const pending = () => ({
  platformCode, verificationPolicyId, stage: 'verify',
  reviewStatus: 'SYNCING', submissionStatus: 'SUBMITTED', syncPending: true,
  matchedRecord: { matched: true, reviewStatus: 'UNKNOWN' }
});

test('confirmed pending reconciliation accepts raw UNKNOWN without accepting conflicting or ambiguous evidence', () => {
  assert.equal(validatePlatformResultProvenance(platformCode, pending()).ok, true);
  for (const patch of [
    { syncPending: false }, { syncPending: undefined }, { submissionStatus: 'UNKNOWN' },
    { stage: 'published' }, { reviewStatus: 'PUBLISHED' }, { reviewStatus: 'REJECTED' },
    { matchedRecord: { matched: true, ambiguous: true, reviewStatus: 'UNKNOWN' } },
    { matchedRecord: { matched: false, reviewStatus: 'UNKNOWN' } },
    ...['REVIEWING', 'REJECTED', 'PUBLISHED'].map(reviewStatus => ({ matchedRecord: { matched: true, reviewStatus } }))
  ]) {
    assert.equal(validatePlatformResultProvenance(platformCode, { ...pending(), ...patch }).reason,
      'REVIEW_STATUS_EVIDENCE_MISMATCH', JSON.stringify(patch));
  }
  assert.equal(validatePlatformResultProvenance(platformCode, { ...pending(), platformCode: 'douyin' }).reason, 'RESULT_PLATFORM_MISMATCH');
  assert.equal(validatePlatformResultProvenance(platformCode, { ...pending(), verificationPolicyId: 'douyin-publish-status-v1' }).reason, 'VERIFICATION_POLICY_MISMATCH');
  assert.equal(validatePlatformResultProvenance(platformCode, { ...pending(), platformUrl: 'https://creator.douyin.com/post/1' }).reason, 'PLATFORM_URL_SCOPE_MISMATCH');
});

const executablePath = [process.env.CHROME_EXECUTABLE_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/chromium'
].find(value => value && fs.existsSync(value));

test('video work card evidence excludes authored status words and preserves dates, rejection and ambiguity', { skip: !executablePath }, async t => {
  const dir = tempRuntimeDir('publish-sync-dom-');
  t.after(() => cleanupDir(dir));
  const browser = await chromium.launch({ headless: true, executablePath, args: ['--no-sandbox'] });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const adapter = new WechatChannelsAssistedRpaAdapter({ logsDir: dir, profileDir: path.join(dir, 'profile') });
  adapter.spec = { ...adapter.spec, verifyTabs: [], verifyRecordTimeoutMs: 1 };
  adapter.getPage = async () => ({
    goto: async () => {}, waitForTimeout: async () => {},
    url: () => 'https://channels.weixin.qq.com/platform/post/list',
    frames: () => page.frames()
  });
  adapter.waitForDetectedPageState = async () => 'READY';
  adapter.evidence = async (_payload, message, _page, stage, extra) => ({ platformCode, message, stage, ...extra });
  const body = '正文讨论内容分享和审核未通过，这些词属于作者内容而不是平台状态。';
  const payload = {
    title: '自动核验示例', body, submissionStatus: 'SUBMITTED', submissionConfirmed: true,
    submittedAt: new Date(2026, 10, 13, 2, 11).toISOString()
  };
  const card = (suffix = '', id = 'one') => `<article class="video-item" data-id="${id}">
    <div class="feed-title"><span>${body}</span></div>${suffix}</article>`;
  await page.setContent(card('<div>2026年11月13日 02:09</div><div>203</div>'));
  let result = await adapter.verifyPublish(payload);
  assert.equal(result.result.reviewStatus, 'PUBLISHED');
  assert.equal(result.result.matchedRecord.timeVerified, true);
  assert.match(result.result.matchedRecord.text, /2026年11月13日/);
  assert.equal(validatePlatformResultProvenance(platformCode, result.result).ok, true);

  await page.setContent(card());
  result = await adapter.verifyPublish(payload);
  assert.equal(result.result.matchedRecord.reviewStatus, 'UNKNOWN');
  assert.equal(result.result.reviewStatus, 'SYNCING');
  assert.equal(result.result.syncPending, true);
  assert.equal(validatePlatformResultProvenance(platformCode, result.result).ok, true);
  const unconfirmed = await adapter.verifyPublish({ ...payload, submissionStatus: 'UNKNOWN', submissionConfirmed: false });
  assert.equal(unconfirmed.result.reviewStatus, 'UNKNOWN');
  assert.equal(unconfirmed.result.syncPending, false);

  for (const [text, status] of [['审核中', 'REVIEWING'], ['审核未通过', 'REJECTED']]) {
    await page.setContent(card(`<div>${text}</div>`));
    assert.equal((await adapter.verifyPublish(payload)).result.reviewStatus, status);
  }
  await page.setContent(card('<div>2026年11月13日 02:09</div>', 'one') + card('<div>2026年11月13日 02:10</div>', 'two'));
  const ambiguous = await adapter.verifyPublish(payload);
  assert.equal(ambiguous.result.matchedRecord.ambiguous, true);
  assert.equal(ambiguous.result.reviewStatus, 'UNKNOWN');
  assert.equal(ambiguous.result.syncPending, false);
});

test('pending verification schedules subsequent automatic checks, keeps the submit lock and stops on publication', async t => {
  const runtime = await startServer({ env: { LOGIN_STATUS_POLL_ENABLED: 'false', OPERATIONS_ANALYTICS_ENABLED: 'false', ISSUE_DIAGNOSIS_ENABLED: 'false' } });
  const db = new DatabaseSync(runtime.dbPath);
  db.exec('PRAGMA busy_timeout=15000');
  t.after(async () => { db.close(); await stopChild(runtime.child); cleanupDir(runtime.dir); });
  const account = db.prepare("SELECT * FROM accounts WHERE platform_code='wechat_channels' LIMIT 1").get();
  const stamp = new Date().toISOString();
  const taskId = Number(db.prepare("INSERT INTO publish_tasks(title,body,material_path,status,created_at,updated_at) VALUES('sync fixture','fixture body','fixture.mp4','EXECUTING',?,?)").run(stamp, stamp).lastInsertRowid);
  const targetId = Number(db.prepare(`INSERT INTO publish_targets(task_id,platform_code,account_id,status,submission_status,review_status,
    publish_attempt_state,submit_lock,submitted_at,submit_attempted_at,submit_attempt_count,updated_at)
    VALUES(?,? ,?,'SUBMITTED','SUBMITTED','UNKNOWN','SUBMITTED','LOCKED',?,?,1,?)`).run(taskId, platformCode, account.id, stamp, stamp, stamp).lastInsertRowid);
  const payload = { taskId, targetId, platformCode, accountId: account.id, profileName: account.profile_name,
    verificationPolicyId, title: 'sync fixture', body: 'fixture body', submittedAt: stamp,
    submissionStatus: 'SUBMITTED', submissionConfirmed: true, reviewAttempt: 0, verificationSource: 'AUTOMATIC' };
  const jobId = Number(db.prepare("INSERT INTO agent_jobs(device_id,job_type,payload,status,created_at,available_at) VALUES(?,'VERIFY_PUBLISH',?,'RUNNING',?,?)").run(account.device_id, JSON.stringify(payload), stamp, stamp).lastInsertRowid);
  const complete = async (id, result) => {
    const response = await jsonRequest(runtime.base, `/api/agent/jobs/${id}/complete`, { method: 'POST', body: { status: 'SUCCESS', result } });
    assert.equal(response.response.status, 200, response.text);
  };
  const target = () => db.prepare('SELECT * FROM publish_targets WHERE id=?').get(targetId);
  const queued = () => db.prepare("SELECT * FROM agent_jobs WHERE job_type='VERIFY_PUBLISH' AND status='QUEUED' AND CAST(json_extract(payload,'$.targetId') AS INTEGER)=?").all(targetId);
  await complete(jobId, pending());
  assert.equal(target().status, 'SYNCING');
  assert.equal(target().submit_lock, 'LOCKED');
  assert.equal(target().submit_attempt_count, 1);
  assert.equal(target().submitted_at, stamp);
  assert.equal(target().platform_post_id, null);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM issues WHERE source='PUBLISH_GUARD'").get().n, 0);
  assert.equal(queued().length, 1);
  const next = queued()[0];
  assert.equal(JSON.parse(next.payload).reviewAttempt, 1);
  assert.equal(JSON.parse(next.payload).verificationSource, 'AUTOMATIC');
  assert.equal(JSON.parse(next.payload).submissionConfirmed, true);
  const delay = Date.parse(next.available_at) - Date.parse(next.created_at);
  assert.ok(delay >= 179000 && delay <= 181000, String(delay));

  await complete(jobId, pending());
  assert.equal(queued().length, 1, 'duplicate completion must not duplicate the next check');
  db.prepare("UPDATE agent_jobs SET status='RUNNING' WHERE id=?").run(next.id);
  await complete(next.id, pending());
  assert.equal(queued().length, 1);
  const final = queued()[0];
  assert.equal(JSON.parse(final.payload).reviewAttempt, 2);
  db.prepare("UPDATE agent_jobs SET status='RUNNING' WHERE id=?").run(final.id);
  await complete(final.id, {
    platformCode, verificationPolicyId, stage: 'verify', reviewStatus: 'PUBLISHED', submissionStatus: 'SUBMITTED',
    matchedRecord: { matched: true, reviewStatus: 'PUBLISHED' }, matchedTab: '已发表',
    platformUrl: 'https://channels.weixin.qq.com/platform/post/detail?id=fixture', platformPostId: 'fixture'
  });
  assert.equal(target().status, 'PUBLISHED');
  assert.equal(target().submit_lock, 'LOCKED');
  assert.equal(target().submit_attempt_count, 1);
  assert.equal(queued().length, 0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM agent_jobs WHERE job_type='PUBLISH'").get().n, 0);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
});
