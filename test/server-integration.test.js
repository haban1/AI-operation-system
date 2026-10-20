import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { precheckMaterial } from '../agent/precheck.js';

process.env.AUTH_ENABLED = 'false';
process.env.AGENT_SHARED_TOKEN = '';
process.env.SMOKE_TEST_ENABLED = 'false';

const root = path.resolve(import.meta.dirname, '..');
function openTestDatabase(databasePath, options = undefined) {
  const database = options === undefined ? new DatabaseSync(databasePath) : new DatabaseSync(databasePath, options);
  database.exec('PRAGMA busy_timeout=15000');
  return database;
}
async function request(base, pathname, options = {}) {
  const response = await fetch(base + pathname, { ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } });
  const data = await response.json(); return { response, data };
}
async function waitFor(base) {
  for (let i = 0; i < 50; i += 1) { try { const r = await fetch(base + '/api/health'); if (r.ok) return; } catch {} await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error('测试服务启动超时');
}async function waitForAgent(base) {
  for (let i = 0; i < 50; i += 1) { try { const r = await fetch(base + '/health'); if (r.ok) return; } catch {} await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error('本地 Agent 启动超时');
}
async function waitForAgentOffline(base) {
  for (let i = 0; i < 60; i += 1) {
    try { await fetch(base + '/health', { signal: AbortSignal.timeout(250) }); }
    catch { return; }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('Local Agent stop timeout');
}

async function freePort() {
  const server = http.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
async function startRuntimeStub(platformsOrControl) {
  const control = Array.isArray(platformsOrControl)
    ? { platforms: platformsOrControl, masterSwitch: { enabled: true } }
    : platformsOrControl;
  const stats = { claimCalls: 0 };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const platforms = control.platforms || [];
    const masterSwitch = control.masterSwitch || { enabled: false };
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    if (req.method === 'POST' && url.pathname === '/api/agent/heartbeat') return res.end(JSON.stringify({ ok: true, platforms, masterSwitch }));
    if (req.method === 'GET' && url.pathname === '/api/agent/platform-runtime') return res.end(JSON.stringify({ ok: true, platforms, masterSwitch }));
    if (req.method === 'POST' && url.pathname === '/api/agent/jobs/claim') { stats.claimCalls += 1; return res.end(JSON.stringify({ ok: true, job: null, platforms, masterSwitch })); }
    if (req.method === 'GET' && url.pathname === '/api/accounts') return res.end(JSON.stringify({ ok: true, accounts: [] }));
    if (req.method === 'POST' && /^\/api\/accounts\/\d+\/login-state$/.test(url.pathname)) return res.end(JSON.stringify({ ok: true }));
    res.statusCode = 404;
    return res.end(JSON.stringify({ ok: false, message: 'stub route not found' }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}`, control, stats };
}
async function closeServer(server) {
  if (!server?.listening) return;
  await new Promise(resolve => server.close(resolve));
}

test('服务端闭环：合规、幂等、提交/审核、消息去重和知识审核', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xhs-mvp-int-'));
  const dbPath = path.join(dir, 'test.db'); const port = 31991; const base = 'http://127.0.0.1:' + port;
  const child = spawn(process.execPath, ['src/server.js'], { cwd: root, env: { ...process.env, PORT: String(port), DATABASE_PATH: dbPath, QWEN_MODE: 'mock', RPA_MODE: 'simulated', AUTO_COLLECT_ENABLED: 'false', LOCAL_AGENT_AUTO_START: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await Promise.race([
        new Promise(resolve => child.once('exit', resolve)),
        new Promise(resolve => setTimeout(resolve, 2000)),
      ]);
    }
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
        break;
      } catch (error) {
        if (attempt === 4) throw error;
        await new Promise(resolve => setTimeout(resolve, 150 * (attempt + 1)));
      }
    }
  });
  await waitFor(base);
  const bootstrap = (await request(base, '/api/bootstrap')).data; const account = bootstrap.accounts.find(item => item.platform_code === 'xiaohongshu'); assert.ok(account); assert.equal(bootstrap.config.loginStatusPoll.enabled, true); assert.equal(bootstrap.config.loginStatusPoll.logoutConfirmations, 3);
  assert.equal(account.enabled, 0);
  const enabledXhsAccount = await request(base, `/api/accounts/${account.id}/runtime`, { method: 'POST', body: JSON.stringify({ enabled: true, updatedBy: 'integration-test' }) }); assert.equal(enabledXhsAccount.response.status, 200); assert.equal(enabledXhsAccount.data.agentControl.notified, false); assert.equal(enabledXhsAccount.data.agentControl.reason, 'ACCOUNT_ENABLE_DOES_NOT_WAKE_AGENT');
  const openedXhsPlatform = await request(base, '/api/platforms/xiaohongshu/runtime', { method: 'POST', body: JSON.stringify({ enabled: true, updatedBy: 'integration-test' }) }); assert.equal(openedXhsPlatform.response.status, 200); assert.equal(openedXhsPlatform.data.platform.effective_state, 'RUNNING');
  const loginSync = await request(base, `/api/accounts/${account.id}/login-state`, { method: 'POST', body: JSON.stringify({ state: 'READY', checkedAt: new Date().toISOString(), message: 'integration-confirmed', url: 'https://creator.xiaohongshu.com/publish/publish', evidence: ['authenticated-text'] }) }); assert.equal(loginSync.response.status, 200);
  assert.deepEqual(new Set(bootstrap.accounts.map(item => item.platform_code)), new Set(['xiaohongshu','douyin','wechat_channels','bilibili','weibo']));
  const douyinAccount = bootstrap.accounts.find(item => item.platform_code === 'douyin'); assert.ok(douyinAccount);
  const bilibiliAccount = bootstrap.accounts.find(item => item.platform_code === 'bilibili'); assert.ok(bilibiliAccount);
  const douyinLogin = await request(base, `/api/accounts/${douyinAccount.id}/login-state`, { method: 'POST', body: JSON.stringify({ state: 'READY', confidence: 'CONFIRMED', confirmedSamples: 1, checkMode: 'MANUAL', checkedAt: new Date().toISOString(), message: 'douyin-ready', url: 'https://creator.douyin.com/creator-micro/content/upload', evidence: ['authenticated-url','authenticated-text'] }) }); assert.equal(douyinLogin.response.status, 200);
  const initialWecom = await request(base, '/api/settings/wecom'); assert.equal(initialWecom.data.settings.configured, false);
  const invalidWecom = await request(base, '/api/settings/wecom', { method: 'POST', body: JSON.stringify({ webhookUrl: 'https://example.com/hook?key=secret' }) }); assert.equal(invalidWecom.response.status, 400);
  const testKey = '12345678-abcd-1234-abcd-1234567890ab';
  const savedWecom = await request(base, '/api/settings/wecom', { method: 'POST', body: JSON.stringify({ webhookUrl: `https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=${testKey}`, updatedBy: '集成测试' }) }); assert.equal(savedWecom.response.status, 200); assert.equal(savedWecom.data.settings.configured, true); assert.equal(savedWecom.data.settings.maskedUrl.includes(testKey), false);
  const readWecom = await request(base, '/api/settings/wecom'); assert.equal(JSON.stringify(readWecom.data).includes(testKey), false); assert.equal(readWecom.data.settings.source, 'DATABASE');
  const clearedWecom = await request(base, '/api/settings/wecom/clear', { method: 'POST', body: '{}' }); assert.equal(clearedWecom.data.settings.configured, false);
  const confirmedLogoutPayload = { state: 'LOGIN', confidence: 'CONFIRMED', confirmedSamples: 3, checkMode: 'POLL', checkedAt: new Date().toISOString(), message: '\u8fde\u7eed\u4e09\u6b21\u786e\u8ba4\u9000\u51fa', url: 'https://creator.xiaohongshu.com/login', evidence: ['login-url','login-text','consecutive-login-confirmations:3'] };
  const expiredSync = await request(base, `/api/accounts/${account.id}/login-state`, { method: 'POST', body: JSON.stringify(confirmedLogoutPayload) }); assert.equal(expiredSync.response.status, 200); assert.equal(expiredSync.data.account.login_status, 'EXPIRED'); assert.equal(expiredSync.data.alert.status, 'NOT_CONFIGURED'); assert.equal(expiredSync.data.alert.delivered, false);
  let loginAlerts = (await request(base, '/api/settings/wecom')).data.notifications.filter(item => item.type === 'PLATFORM_LOGIN_EXPIRED'); assert.equal(loginAlerts.length, 1); assert.match(loginAlerts[0].content, /\u8fde\u7eed 3 \u6b21\u68c0\u67e5\u8bc1\u636e\u4e00\u81f4/);
  const repeatedExpired = await request(base, `/api/accounts/${account.id}/login-state`, { method: 'POST', body: JSON.stringify({ ...confirmedLogoutPayload, checkedAt: new Date(Date.now()+1000).toISOString() }) }); assert.equal(repeatedExpired.response.status, 200); assert.equal(repeatedExpired.data.alert, null);
  loginAlerts = (await request(base, '/api/settings/wecom')).data.notifications.filter(item => item.type === 'PLATFORM_LOGIN_EXPIRED'); assert.equal(loginAlerts.length, 1);
  const restoredSync = await request(base, `/api/accounts/${account.id}/login-state`, { method: 'POST', body: JSON.stringify({ state: 'READY', confidence: 'CONFIRMED', confirmedSamples: 1, checkMode: 'POLL', checkedAt: new Date(Date.now()+2000).toISOString(), message: '\u5df2\u6062\u590d\u767b\u5f55', url: 'https://creator.xiaohongshu.com/publish/publish', evidence: ['authenticated-url','authenticated-text'] }) }); assert.equal(restoredSync.data.account.login_status, 'READY');
  const unknownSync = await request(base, `/api/accounts/${account.id}/login-state`, { method: 'POST', body: JSON.stringify({ state: 'UNKNOWN', confidence: 'UNCONFIRMED', confirmedSamples: 0, checkMode: 'POLL', checkedAt: new Date(Date.now()+3000).toISOString(), message: '\u9875\u9762\u7ed3\u679c\u4e0d\u7a33\u5b9a', url: 'https://creator.xiaohongshu.com/publish/publish', evidence: ['unstable-login-samples:LOGIN>READY'] }) }); assert.equal(unknownSync.response.status, 200); assert.equal(unknownSync.data.alert, null);
  loginAlerts = (await request(base, '/api/settings/wecom')).data.notifications.filter(item => item.type === 'PLATFORM_LOGIN_EXPIRED'); assert.equal(loginAlerts.length, 1);
  await request(base, `/api/accounts/${account.id}/login-state`, { method: 'POST', body: JSON.stringify({ state: 'READY', confidence: 'CONFIRMED', confirmedSamples: 1, checkMode: 'MANUAL', checkedAt: new Date(Date.now()+4000).toISOString(), message: '\u96c6\u6210\u6d4b\u8bd5\u6062\u590d', url: 'https://creator.xiaohongshu.com/publish/publish', evidence: ['authenticated-url','authenticated-text'] }) });

  const file = path.join(dir, 'community.png'); await sharp({ create: { width: 1080, height: 1440, channels: 3, background: '#315f91' } }).png().toFile(file);
  const precheck = await precheckMaterial({ materialPath: file, title: '社区活动报名指南', body: '本周社区活动开放报名，请通过公告中的报名入口提交信息，名额以页面显示为准。', platforms: ['douyin'] });
  const blocked = await request(base, '/api/publish/tasks', { method: 'POST', body: JSON.stringify({ title: '管理端一键发布测试', body: 'RPA自动发布测试，发布后可删除。', materialPath: file, targets: [{ platformCode: 'douyin', accountId: douyinAccount.id }], precheck, complianceConfirmed: true, managementConfirmed: true, publishMode: 'AUTO' }) }); assert.equal(blocked.response.status, 422);
  const payload = { title: '社区活动报名指南', body: '本周社区活动开放报名，请通过社区活动公告中的报名入口提交信息，名额以页面显示为准。', imageText: '社区活动报名指南', materialPath: file, targets: [{ platformCode: 'douyin', accountId: douyinAccount.id }], precheck, complianceConfirmed: true, managementConfirmed: true, publishMode: 'AUTO' };
  const created = await request(base, '/api/publish/tasks', { method: 'POST', body: JSON.stringify(payload) }); assert.equal(created.response.status, 201); const taskId = created.data.task.id; const targetId = created.data.task.targets[0].id;
  const duplicate = await request(base, '/api/publish/tasks', { method: 'POST', body: JSON.stringify(payload) }); assert.equal(duplicate.response.status, 409); assert.equal(duplicate.data.detail.existingTaskId, taskId);
  const allTaskView = await request(base, '/api/tasks'); assert.equal(allTaskView.response.status, 200); assert.equal(allTaskView.data.total, 1); assert.equal(allTaskView.data.platformCounts.length, 5); assert.equal(allTaskView.data.platformCounts.find(item => item.code === 'douyin').task_count, 1);
  const douyinTaskView = await request(base, '/api/tasks?platformCode=douyin'); assert.equal(douyinTaskView.data.tasks.length, 1); assert.ok(douyinTaskView.data.tasks.every(item => item.targets.every(target => target.platform_code === 'douyin')));
    const invalidPlatformView = await request(base, '/api/tasks?platformCode=unknown-platform'); assert.equal(invalidPlatformView.response.status, 400);
  const claimed = await request(base, '/api/agent/jobs/claim', { method: 'POST', body: JSON.stringify({ deviceId: 'device-rpa-01' }) }); assert.equal(claimed.data.job.job_type, 'PUBLISH');
  await request(base, '/api/agent/jobs/' + claimed.data.job.id + '/complete', { method: 'POST', body: JSON.stringify({ status: 'SUCCESS', result: { message: '平台已接收' } }) });
  let tasks = (await request(base, '/api/tasks')).data.tasks; assert.equal(tasks.find(item => item.id === taskId).targets[0].status, 'SUBMITTED'); assert.notEqual(tasks.find(item => item.id === taskId).status, 'PUBLISHED');
  let reviewDb = openTestDatabase(dbPath);
  const initialVerification = reviewDb.prepare("SELECT * FROM agent_jobs WHERE idempotency_key=?").get(`verify:target:${targetId}:initial`);
  const initialPayload = JSON.parse(initialVerification.payload);
  const initialDelayMs = Date.parse(initialVerification.available_at) - Date.parse(initialPayload.submittedAt);
  assert.ok(initialDelayMs >= 119_000 && initialDelayMs <= 121_000, `initial verify delay=${initialDelayMs}`);
  assert.equal(initialPayload.verificationSource, 'AUTOMATIC');
  reviewDb.close();

  const verifyRequested = await request(base, '/api/publish/targets/' + targetId + '/verify', { method: 'POST', body: '{}' }); assert.equal(verifyRequested.response.status, 200); assert.equal(verifyRequested.data.action, 'CREATED');
  const repeatedVerifyRequested = await request(base, '/api/publish/targets/' + targetId + '/verify', { method: 'POST', body: '{}' }); assert.equal(repeatedVerifyRequested.response.status, 200); assert.equal(repeatedVerifyRequested.data.action, 'ALREADY_QUEUED'); assert.equal(repeatedVerifyRequested.data.jobId, verifyRequested.data.jobId);
  reviewDb = openTestDatabase(dbPath);
  assert.equal(reviewDb.prepare('SELECT status FROM agent_jobs WHERE id=?').get(initialVerification.id).status, 'CANCELLED');
  const manualVerification = reviewDb.prepare('SELECT * FROM agent_jobs WHERE id=?').get(verifyRequested.data.jobId);
  const manualPayload = JSON.parse(manualVerification.payload);
  assert.equal(manualPayload.manualRequested, true); assert.equal(manualPayload.verificationSource, 'MANUAL');
  assert.ok(Math.abs(Date.parse(manualVerification.available_at) - Date.parse(manualVerification.created_at)) < 5_000);
  reviewDb.close();

  const reviewingJob = await request(base, '/api/agent/jobs/claim', { method: 'POST', body: JSON.stringify({ deviceId: 'device-rpa-01' }) }); assert.equal(reviewingJob.data.job.job_type, 'VERIFY_PUBLISH'); assert.equal(reviewingJob.data.job.payload.targetId, targetId); assert.equal(reviewingJob.data.job.payload.reviewAttempt, 0); assert.equal(reviewingJob.data.job.payload.manualRequested, true);
  await request(base, '/api/agent/jobs/' + reviewingJob.data.job.id + '/complete', { method: 'POST', body: JSON.stringify({ status: 'SUCCESS', result: { reviewStatus: 'REVIEWING', message: '抖音内容审核中' } }) });
  tasks = (await request(base, '/api/tasks')).data.tasks; const reviewingTarget = tasks.find(item => item.id === taskId).targets[0]; assert.equal(reviewingTarget.status, 'REVIEWING'); assert.equal(reviewingTarget.verification_job_status, 'QUEUED'); assert.equal(reviewingTarget.verification_source, 'AUTOMATIC'); assert.ok(reviewingTarget.next_verification_at);
  const followupKey = `verify:target:${targetId}:after:${reviewingJob.data.job.id}:attempt:1`;
  reviewDb = openTestDatabase(dbPath);
  let followups = reviewDb.prepare('SELECT * FROM agent_jobs WHERE idempotency_key=?').all(followupKey);
  const fastDelayMs = Date.parse(followups[0].available_at) - Date.parse(followups[0].created_at);
  assert.equal(followups.length, 1); assert.equal(JSON.parse(followups[0].payload).reviewAttempt, 1); assert.ok(fastDelayMs >= 179_000 && fastDelayMs <= 181_000, `fast verify delay=${fastDelayMs}`);
  reviewDb.close();
  await request(base, '/api/agent/jobs/' + reviewingJob.data.job.id + '/complete', { method: 'POST', body: JSON.stringify({ status: 'SUCCESS', result: { reviewStatus: 'REVIEWING', message: '重复完成回调' } }) });
  reviewDb = openTestDatabase(dbPath); followups = reviewDb.prepare('SELECT * FROM agent_jobs WHERE idempotency_key=?').all(followupKey); assert.equal(followups.length, 1);
  const oldSubmittedAt = new Date(Date.now() - 31 * 60 * 1000).toISOString();
  reviewDb.prepare('UPDATE publish_targets SET submitted_at=?,submit_attempted_at=? WHERE id=?').run(oldSubmittedAt, oldSubmittedAt, targetId);
  reviewDb.prepare('UPDATE agent_jobs SET available_at=? WHERE id=?').run(new Date(Date.now() - 1000).toISOString(), followups[0].id);
  reviewDb.close();
  const steadyReviewJob = await request(base, '/api/agent/jobs/claim', { method: 'POST', body: JSON.stringify({ deviceId: 'device-rpa-01' }) }); assert.equal(steadyReviewJob.data.job.id, followups[0].id);
  await request(base, '/api/agent/jobs/' + steadyReviewJob.data.job.id + '/complete', { method: 'POST', body: JSON.stringify({ status: 'SUCCESS', result: { reviewStatus: 'REVIEWING', message: '超过30分钟仍在审核' } }) });
  const steadyFollowupKey = `verify:target:${targetId}:after:${steadyReviewJob.data.job.id}:attempt:2`;
  reviewDb = openTestDatabase(dbPath);
  const steadyFollowup = reviewDb.prepare('SELECT * FROM agent_jobs WHERE idempotency_key=?').get(steadyFollowupKey);
  const steadyDelayMs = Date.parse(steadyFollowup.available_at) - Date.parse(steadyFollowup.created_at);
  assert.ok(steadyDelayMs >= 299_000 && steadyDelayMs <= 301_000, `steady verify delay=${steadyDelayMs}`);
  reviewDb.close();
  await request(base, '/api/publish/targets/' + targetId + '/review', { method: 'POST', body: JSON.stringify({ reviewStatus: 'PUBLISHED', message: '测试人工复核' }) }); tasks = (await request(base, '/api/tasks')).data.tasks; assert.equal(tasks.find(item => item.id === taskId).status, 'PUBLISHED'); assert.equal(tasks.find(item => item.id === taskId).targets[0].submission_status, 'SUBMITTED'); assert.ok(tasks.find(item => item.id === taskId).targets[0].submitted_at);
  reviewDb = openTestDatabase(dbPath); assert.equal(reviewDb.prepare('SELECT status FROM agent_jobs WHERE id=?').get(steadyFollowup.id).status, 'CANCELLED'); reviewDb.close();
  const history = await request(base, '/api/publish/history?page=1&pageSize=5'); assert.equal(history.response.status, 200); assert.equal(history.data.pageSize, 5); assert.equal(history.data.records[0].id, taskId); assert.equal(history.data.records[0].publish_status, 'SUCCESS');
  const message = { platformCode: 'douyin', accountId: douyinAccount.id, messageType: 'COMMENT', externalId: 'integration-comment-1', userName: '\u7528\u6237A\n\u4f60\u7684\u597d\u53cb', content: '\u6211\u8981\u6295\u8bc9\uff0c\u8bf7\u4eba\u5de5\u5904\u7406', externalUrl: 'https://creator.douyin.com/creator-micro/interaction/comment', context: { noteTitle: '\u793e\u533a\u6d3b\u52a8\u62a5\u540d\u6307\u5357', notePublishedAt: '2026-08-04T02:30:00.000Z', noteUrl: 'https://www.douyin.com/video/demo' } };
  const first = await request(base, '/api/agent/messages/upsert', { method: 'POST', body: JSON.stringify(message) }); const second = await request(base, '/api/agent/messages/upsert', { method: 'POST', body: JSON.stringify(message) }); assert.equal(first.data.results[0].created, true); assert.equal(second.data.results[0].created, false);
  const messages = (await request(base, '/api/messages')).data.messages.filter(item => item.external_id === message.externalId); assert.equal(messages.length, 1); assert.equal(messages[0].status, 'MANUAL_REQUIRED');
  assert.equal(messages[0].post.title, '社区活动报名指南'); assert.equal(messages[0].post.url, 'https://www.douyin.com/video/demo');
  assert.equal(messages[0].reply_status.ai.replied, false); assert.equal(messages[0].reply_status.ai.state, 'NOT_REPLIED'); assert.equal(messages[0].reply_status.manual.state, 'PENDING');
  const manualNotifications = (await request(base, '/api/settings/wecom')).data.notifications; const manualNotification = manualNotifications.find(item => item.type === 'RISK_MANUAL'); assert.ok(manualNotification); assert.equal(manualNotification.title, '【抖音·评论区】用户A需要转人工'); assert.ok(manualNotification.content.includes('发布平台：抖音')); assert.ok(manualNotification.content.includes('用户名称：用户A')); assert.ok(manualNotification.content.includes('关联笔记：《社区活动报名指南》（发布时间：2026/8/4 10:30）')); assert.ok(manualNotification.content.includes('评论内容：“我要投诉，请人工处理”')); assert.ok(manualNotification.content.includes('处理要求：需要转人工'));
  const detection = await request(base, '/api/messages/' + messages[0].id + '/detect-manual', { method: 'POST', body: JSON.stringify({ expectedReply: '已收到，将安排工作人员跟进。' }) }); assert.equal(detection.response.status, 200);
  const detectionJob = await request(base, '/api/agent/jobs/claim', { method: 'POST', body: JSON.stringify({ deviceId: 'device-rpa-01' }) }); assert.equal(detectionJob.data.job.job_type, 'DETECT_MANUAL_REPLY'); assert.equal(detectionJob.data.job.payload.messageType, 'COMMENT'); assert.equal(detectionJob.data.job.payload.sourceContent, message.content);
  await request(base, '/api/agent/jobs/' + detectionJob.data.job.id + '/complete', { method: 'POST', body: JSON.stringify({ status: 'SUCCESS', result: { handled: true, message: '检测到平台端已回复' } }) });
  const handled = (await request(base, '/api/messages')).data.messages.find(item => item.id === messages[0].id); assert.equal(handled.status, 'MANUAL_HANDLED'); assert.equal(handled.handled_by, 'PLATFORM_DETECTED'); assert.equal(handled.reply_status.manual.replied, true); assert.equal(handled.reply_status.manual.state, 'REPLIED');
  const wrongDouyinCollect = await request(base, '/api/platforms/douyin/collect', { method: 'POST', body: JSON.stringify({ accountId: account.id }) }); assert.equal(wrongDouyinCollect.response.status, 400);
  const douyinCollect = await request(base, '/api/platforms/douyin/collect', { method: 'POST', body: JSON.stringify({ accountId: douyinAccount.id, types: ['COMMENT','PRIVATE_MESSAGE'] }) }); assert.equal(douyinCollect.response.status, 200);
  const douyinCollectJob = await request(base, '/api/agent/jobs/claim', { method: 'POST', body: JSON.stringify({ deviceId: 'device-rpa-01' }) }); assert.equal(douyinCollectJob.data.job.job_type, 'COLLECT_MESSAGES'); assert.equal(douyinCollectJob.data.job.payload.platformCode, 'douyin'); assert.equal(douyinCollectJob.data.job.payload.accountId, douyinAccount.id);
  await request(base, '/api/agent/jobs/' + douyinCollectJob.data.job.id + '/complete', { method: 'POST', body: JSON.stringify({ status: 'SUCCESS', result: { messages: [] } }) });
  const douyinMessagePayload = { platformCode: 'douyin', accountId: douyinAccount.id, messageType: 'COMMENT', externalId: 'douyin-integration-comment-1', userName: '抖音测试用户', content: '请转人工处理这条抖音评论', externalUrl: 'https://creator.douyin.com/creator-micro/interaction/comment', context: {} };
  const douyinMessageUpsert = await request(base, '/api/agent/messages/upsert', { method: 'POST', body: JSON.stringify(douyinMessagePayload) }); assert.equal(douyinMessageUpsert.response.status, 200); assert.equal(douyinMessageUpsert.data.results[0].created, true);
  const douyinMessage = (await request(base, '/api/messages')).data.messages.find(item => item.external_id === douyinMessagePayload.externalId); assert.equal(douyinMessage.platform_code, 'douyin'); assert.equal(douyinMessage.status, 'MANUAL_REQUIRED');
  const douyinDetection = await request(base, '/api/messages/' + douyinMessage.id + '/detect-manual', { method: 'POST', body: JSON.stringify({ expectedReply: '抖音平台人工回复已完成。' }) }); assert.equal(douyinDetection.response.status, 200);
  const douyinDetectionJob = await request(base, '/api/agent/jobs/claim', { method: 'POST', body: JSON.stringify({ deviceId: 'device-rpa-01' }) }); assert.equal(douyinDetectionJob.data.job.job_type, 'DETECT_MANUAL_REPLY'); assert.equal(douyinDetectionJob.data.job.payload.platformCode, 'douyin');
  await request(base, '/api/agent/jobs/' + douyinDetectionJob.data.job.id + '/complete', { method: 'POST', body: JSON.stringify({ status: 'SUCCESS', result: { handled: false, message: '尚未检测到人工回复' } }) });

  // 失败任务详情与再次发送链路：只回填原任务失败的平台，并保留重新审核。
  const failedPayload = { ...payload, title: '社区活动报名提醒', body: '社区活动报名仍在进行，请按公告要求准备资料并在截止时间前提交，具体安排以页面显示为准。' };
  const invalidPublishedRetry = await request(base, '/api/publish/tasks', { method: 'POST', body: JSON.stringify({ ...failedPayload, retryOfTaskId: taskId }) });
  assert.equal(invalidPublishedRetry.response.status, 409);
  const failedCreated = await request(base, '/api/publish/tasks', { method: 'POST', body: JSON.stringify(failedPayload) });
  assert.equal(failedCreated.response.status, 201);
  const failedTaskId = failedCreated.data.task.id;
  const failedJob = await request(base, '/api/agent/jobs/claim', { method: 'POST', body: JSON.stringify({ deviceId: 'device-rpa-01' }) });
  assert.equal(failedJob.data.job.job_type, 'PUBLISH');
  assert.equal(failedJob.data.job.payload.taskId, failedTaskId);
  await request(base, '/api/agent/jobs/' + failedJob.data.job.id + '/complete', { method: 'POST', body: JSON.stringify({ status: 'FAILED', result: { message: '平台页面提交失败' } }) });
  const failedDetail = await request(base, '/api/tasks/' + failedTaskId);
  assert.equal(failedDetail.response.status, 200);
  assert.equal(failedDetail.data.task.status, 'FAILED');
  assert.equal(failedDetail.data.task.title, failedPayload.title);
  assert.equal(failedDetail.data.task.material_path, file);
  assert.equal(failedDetail.data.task.material_meta.imageText, failedPayload.imageText);
  assert.equal(failedDetail.data.task.targets.length, 1);
  assert.equal(failedDetail.data.task.targets[0].status, 'FAILED');
  assert.equal(failedDetail.data.task.targets[0].result.message, '平台页面提交失败');
  const missingTaskDetail = await request(base, '/api/tasks/999999');
  assert.equal(missingTaskDetail.response.status, 404);

  const retryPayload = { ...failedPayload, retryOfTaskId: failedTaskId };
  const retried = await request(base, '/api/publish/tasks', { method: 'POST', body: JSON.stringify(retryPayload) });
  assert.equal(retried.response.status, 201);
  assert.equal(retried.data.task.retry_of_task_id, failedTaskId);
  assert.equal(retried.data.task.targets.length, 1);
  const duplicateRetry = await request(base, '/api/publish/tasks', { method: 'POST', body: JSON.stringify(retryPayload) });
  assert.equal(duplicateRetry.response.status, 409);
  assert.equal(duplicateRetry.data.detail.existingTaskId, retried.data.task.id);
  const mixedRetry = await request(base, '/api/publish/tasks', { method: 'POST', body: JSON.stringify({ ...retryPayload, targets: [...failedPayload.targets, { platformCode: 'bilibili', accountId: bilibiliAccount.id }] }) });
  assert.equal(mixedRetry.response.status, 409);

  const privateMessage = await request(base, '/api/messages/simulate', { method: 'POST', body: JSON.stringify({ platformCode: 'xiaohongshu', accountId: account.id, messageType: 'PRIVATE_MESSAGE', userName: '私信测试用户', content: '请人工回复这条私信' }) }); assert.equal(privateMessage.response.status, 201);
  const privateRecord = (await request(base, '/api/messages')).data.messages.find(item => item.id === privateMessage.data.message.id); assert.equal(privateRecord.message_type, 'PRIVATE_MESSAGE'); assert.equal(privateRecord.content, '请人工回复这条私信'); assert.equal(privateRecord.post, null); assert.equal(privateRecord.reply_status.manual.state, 'PENDING');
  const gapQuestion = '编号ZXQ9842的量子航线资料如何领取？';
  const gapCountBefore = (await request(base, '/api/knowledge-gaps')).data.gaps.length;
  const simulatedGap = await request(base, '/api/messages/simulate', { method: 'POST', body: JSON.stringify({ platformCode: 'xiaohongshu', accountId: account.id, messageType: 'COMMENT', userName: '知识分类测试用户', content: gapQuestion }) }); assert.equal(simulatedGap.response.status, 201);
  const gapsAfterSimulation = (await request(base, '/api/knowledge-gaps')).data.gaps;
  assert.equal(gapsAfterSimulation.length, gapCountBefore);
  assert.ok(!gapsAfterSimulation.some(item => item.content === gapQuestion), '知识不足消息不应自动沉淀为待补充知识');
  const manualKnowledge = await request(base, '/api/knowledge', { method: 'POST', body: JSON.stringify({ question: gapQuestion, answer: '请到服务窗口领取相关资料。', keywords: '量子航线,资料领取', category: '小红书知识库', subcategory: '__CUSTOM__', customSubcategory: '资料领取' }) });
  assert.equal(manualKnowledge.response.status, 201);
  const publishedKnowledge = await request(base, '/api/knowledge/' + manualKnowledge.data.knowledge.id + '/publish', { method: 'POST', body: JSON.stringify({ reviewedBy: '分类审核测试' }) });
  assert.equal(publishedKnowledge.response.status, 200);
  assert.equal(publishedKnowledge.data.knowledge.category, '小红书知识库');
  assert.equal(publishedKnowledge.data.knowledge.subcategory, '资料领取');
  assert.equal(publishedKnowledge.data.knowledge.status, 'PUBLISHED');
  const publishedGap = { data: { knowledgeId: publishedKnowledge.data.knowledge.id, knowledge: publishedKnowledge.data.knowledge } };
  const syncedGapKnowledge = (await request(base, '/api/knowledge?category=' + encodeURIComponent('小红书知识库') + '&subcategory=' + encodeURIComponent('资料领取'))).data.knowledge; assert.equal(syncedGapKnowledge.length, 1); assert.equal(syncedGapKnowledge[0].id, publishedGap.data.knowledgeId);
  const invalidKnowledgeEdit = await request(base, '/api/knowledge/' + publishedGap.data.knowledgeId, { method: 'PUT', body: JSON.stringify({ question: gapQuestion, answer: '', category: '小红书知识库', subcategory: '资料领取' }) }); assert.equal(invalidKnowledgeEdit.response.status, 400);
  const editedGapAnswer = '请到一楼综合服务窗口领取资料，领取前可先电话确认库存。';
  const editedPublishedGap = await request(base, '/api/knowledge/' + publishedGap.data.knowledgeId, { method: 'PUT', body: JSON.stringify({ question: '量子航线资料在哪里领取？', answer: editedGapAnswer, keywords: '量子航线,资料,服务窗口', category: '小红书知识库', subcategory: '资料领取', editedBy: '知识编辑测试' }) }); assert.equal(editedPublishedGap.response.status, 200); assert.equal(editedPublishedGap.data.knowledge.status, 'PUBLISHED'); assert.equal(editedPublishedGap.data.knowledge.version, 2); assert.equal(editedPublishedGap.data.knowledge.answer, editedGapAnswer); assert.equal(editedPublishedGap.data.knowledge.reviewed_by, '知识编辑测试');
  const draft = await request(base, '/api/knowledge', { method: 'POST', body: JSON.stringify({ question: '新问题', answer: '新答案', keywords: '新问题' }) }); assert.equal(draft.data.knowledge.status, 'DRAFT'); assert.equal(draft.data.knowledge.category, '公共知识库'); await request(base, '/api/knowledge/' + draft.data.knowledge.id + '/publish', { method: 'POST', body: JSON.stringify({ reviewedBy: '测试审核' }) }); const knowledge = (await request(base, '/api/knowledge')).data.knowledge.find(item => item.id === draft.data.knowledge.id); assert.equal(knowledge.status, 'PUBLISHED');
  const customDraft = await request(base, '/api/knowledge', { method: 'POST', body: JSON.stringify({ question: '港澳青年服务有哪些？', answer: '请查看港澳青年服务专区的最新安排。', category: '公共知识库', subcategory: '__CUSTOM__', customSubcategory: '港澳青年服务' }) }); assert.equal(customDraft.response.status, 201); assert.equal(customDraft.data.knowledge.category, '公共知识库'); assert.equal(customDraft.data.knowledge.subcategory, '港澳青年服务');
  const invalidCustomCategory = await request(base, '/api/knowledge', { method: 'POST', body: JSON.stringify({ question: '无效分类问题', answer: '无效分类答案', category: '__CUSTOM__', customCategory: '新大类' }) }); assert.equal(invalidCustomCategory.response.status, 400);
  const categorySummary = await request(base, '/api/knowledge/categories'); assert.deepEqual(categorySummary.data.systemCategories, ['公共知识库','小红书知识库','抖音知识库','微博知识库','视频号知识库','B站知识库']); assert.equal(categorySummary.data.categories.length, 6); const publicSummary = categorySummary.data.categories.find(item => item.name === '公共知识库'); assert.ok(publicSummary); assert.ok(publicSummary.recentSubcategories.includes('港澳青年服务'));
  const customKnowledge = await request(base, '/api/knowledge?category=' + encodeURIComponent('公共知识库') + '&subcategory=' + encodeURIComponent('港澳青年服务')); assert.equal(customKnowledge.data.knowledge.length, 1); assert.equal(customKnowledge.data.knowledge[0].id, customDraft.data.knowledge.id); const templateResponse = await fetch(base + '/api/knowledge/import/template'); const templateText = await templateResponse.text(); assert.equal(templateResponse.status, 200); assert.ok(templateText.includes('标准问题')); assert.ok(templateText.includes('公共知识库'));
  const importCsv = '\uFEFF"标准问题","标准答案","关键词","大类","小类"\r\n"社区服务中心的办公时间是什么？","重复答案","办公时间","公共知识库","开放时间"\r\n"社区有没有长者智能手机培训？","本月安排两场长者智能手机培训，具体日期以活动公告为准。","长者培训,手机课程","公共知识库","课程培训"';
  const preview = await request(base, '/api/knowledge/import/preview', { method: 'POST', body: JSON.stringify({ fileName: '知识导入测试.csv', base64: Buffer.from(importCsv, 'utf8').toString('base64') }) });
  assert.equal(preview.response.status, 200); assert.equal(preview.data.summary.total, 2); assert.equal(preview.data.summary.exactDuplicates, 1); assert.equal(preview.data.summary.importable, 1); assert.equal(preview.data.items[1].category, '公共知识库'); assert.equal(preview.data.items[1].subcategory, '课程培训');
  const committed = await request(base, '/api/knowledge/import/commit', { method: 'POST', body: JSON.stringify({ batchId: preview.data.batchId, importedBy: '集成测试' }) }); assert.equal(committed.data.imported, 1);
  const importedKnowledge = (await request(base, '/api/knowledge')).data.knowledge.find(item => item.import_batch_id === preview.data.batchId); assert.ok(importedKnowledge); assert.equal(importedKnowledge.status, 'DRAFT'); assert.equal(importedKnowledge.source, 'FILE_IMPORT'); assert.equal(importedKnowledge.category, '公共知识库'); assert.equal(importedKnowledge.subcategory, '课程培训');
  const committedAgain = await request(base, '/api/knowledge/import/commit', { method: 'POST', body: JSON.stringify({ batchId: preview.data.batchId, importedBy: '集成测试' }) }); assert.equal(committedAgain.data.alreadyCommitted, true); assert.equal(committedAgain.data.imported, 1);
  const reviewCsv = '\uFEFF"标准问题","标准答案","关键词","大类","小类"\r\n"批量审核测试问题一","答案一","审核测试","测试分类","测试小类"\r\n"批量审核测试问题二","答案二","待修改","测试分类","测试小类"';
  const reviewPreview = await request(base, '/api/knowledge/import/preview', { method: 'POST', body: JSON.stringify({ fileName: '人工审核导入.csv', base64: Buffer.from(reviewCsv, 'utf8').toString('base64') }) }); assert.equal(reviewPreview.data.summary.total, 2); assert.equal(reviewPreview.data.summary.invalid, 2);
  const selectedCommit = await request(base, '/api/knowledge/import/commit', { method: 'POST', body: JSON.stringify({ batchId: reviewPreview.data.batchId, importedBy: '人工审核测试', selectedRowNos: [2], reviewedItems: [{ rowNo: 2, question: '批量审核后修订的问题二', answer: '人工修订后的标准答案', keywords: '人工审核,已修订', category: '微博知识库', subcategory: '已确认' }] }) });
  assert.equal(selectedCommit.response.status, 200); assert.equal(selectedCommit.data.selected, 1); assert.equal(selectedCommit.data.imported, 1); assert.equal(selectedCommit.data.skipped, 0);
  const selectedImported = (await request(base, '/api/knowledge')).data.knowledge.filter(item => item.import_batch_id === reviewPreview.data.batchId); assert.equal(selectedImported.length, 1); assert.equal(selectedImported[0].question, '批量审核后修订的问题二'); assert.equal(selectedImported[0].answer, '人工修订后的标准答案'); assert.equal(selectedImported[0].category, '微博知识库'); assert.equal(selectedImported[0].subcategory, '已确认');
  assert.equal(stderr.includes('SyntaxError'), false, stderr);
});




test('知识库删除：支持单条和小类删除，固定大类不可删除', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-delete-int-'));
  const dbPath = path.join(dir, 'test.db'); const port = await freePort(); const base = 'http://127.0.0.1:' + port;
  const child = spawn(process.execPath, ['src/server.js'], { cwd: root, env: { ...process.env, PORT: String(port), DATABASE_PATH: dbPath, QWEN_MODE: 'mock', AUTO_COLLECT_ENABLED: 'false', LOCAL_AGENT_AUTO_START: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await Promise.race([new Promise(resolve => child.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 2000))]);
    }
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try { fs.rmSync(dir, { recursive: true, force: true }); break; }
      catch (error) { if (attempt === 4) throw error; await new Promise(resolve => setTimeout(resolve, 150 * (attempt + 1))); }
    }
  });
  await waitFor(base);

  const categoryName = '小红书知识库';
  const first = await request(base, '/api/knowledge', { method: 'POST', body: JSON.stringify({ question: '删除测试问题一？', answer: '答案一', category: categoryName, subcategory: '__CUSTOM__', customSubcategory: '报名方式' }) });
  const second = await request(base, '/api/knowledge', { method: 'POST', body: JSON.stringify({ question: '删除测试问题二？', answer: '答案二', category: categoryName, subcategory: '__CUSTOM__', customSubcategory: '材料清单' }) });
  const third = await request(base, '/api/knowledge', { method: 'POST', body: JSON.stringify({ question: '删除测试问题三？', answer: '答案三', category: categoryName, subcategory: '报名方式' }) });
  assert.equal(first.response.status, 201); assert.equal(first.data.knowledge.subcategory, '报名方式');
  assert.equal(second.response.status, 201); assert.equal(third.response.status, 201);

  const summary = await request(base, '/api/knowledge/categories');
  assert.equal(summary.data.categories.length, 6);
  const category = summary.data.categories.find(item => item.name === categoryName);
  assert.equal(category.total, 3); assert.equal(category.subcategories.length, 2);
  assert.equal(category.subcategories.find(item => item.name === '报名方式').total, 2);
  assert.ok(category.recentSubcategories.includes('报名方式')); assert.ok(category.recentSubcategories.includes('材料清单'));

  const filtered = await request(base, '/api/knowledge?category=' + encodeURIComponent(categoryName) + '&subcategory=' + encodeURIComponent('报名方式'));
  assert.equal(filtered.data.knowledge.length, 2);

  const deleteOne = await request(base, '/api/knowledge/' + first.data.knowledge.id, { method: 'DELETE', body: '{}' });
  assert.equal(deleteOne.response.status, 200); assert.equal(deleteOne.data.deleted, 1);
  const missingOne = await request(base, '/api/knowledge/' + first.data.knowledge.id, { method: 'DELETE', body: '{}' });
  assert.equal(missingOne.response.status, 404);

  const deleteSubcategory = await request(base, '/api/knowledge/subcategories?category=' + encodeURIComponent(categoryName) + '&subcategory=' + encodeURIComponent('报名方式'), { method: 'DELETE', body: JSON.stringify({ confirmText: '删除' }) });
  assert.equal(deleteSubcategory.response.status, 200); assert.equal(deleteSubcategory.data.deleted, 1);
  const afterSubcategory = await request(base, '/api/knowledge?category=' + encodeURIComponent(categoryName));
  assert.equal(afterSubcategory.data.knowledge.length, 1); assert.equal(afterSubcategory.data.knowledge[0].id, second.data.knowledge.id);
  const afterSubcategorySummary = await request(base, '/api/knowledge/categories');
  assert.equal(afterSubcategorySummary.data.categories.find(item => item.name === categoryName).recentSubcategories.includes('报名方式'), false);

  const deleteCategory = await request(base, '/api/knowledge/categories?category=' + encodeURIComponent(categoryName), { method: 'DELETE', body: JSON.stringify({ confirmName: categoryName }) });
  assert.equal(deleteCategory.response.status, 405);
  const afterCategory = await request(base, '/api/knowledge?category=' + encodeURIComponent(categoryName));
  assert.equal(afterCategory.data.knowledge.length, 1); assert.equal(afterCategory.data.knowledge[0].id, second.data.knowledge.id);

  const emptyCategory = await request(base, '/api/knowledge/categories', { method: 'DELETE', body: JSON.stringify({ confirmName: '' }) });
  assert.equal(emptyCategory.response.status, 405);
  const options = await fetch(base + '/api/knowledge/categories', { method: 'OPTIONS' });
  assert.ok(options.headers.get('access-control-allow-methods').includes('DELETE'));
  assert.equal(stderr.includes('SyntaxError'), false, stderr);
});


test('旧本地知识兼容检索统一共享：任意历史分类都可被全部平台调用', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-shared-scope-int-'));
  const dbPath = path.join(dir, 'test.db'); const port = await freePort(); const base = 'http://127.0.0.1:' + port;
  const child = spawn(process.execPath, ['src/server.js'], { cwd: root, env: { ...process.env, PORT: String(port), DATABASE_PATH: dbPath, QWEN_MODE: 'mock', AUTO_COLLECT_ENABLED: 'false', LOCAL_AGENT_AUTO_START: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { child.kill(); await Promise.race([new Promise(resolve => child.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 2000))]); }
    for (let attempt = 0; attempt < 5; attempt += 1) { try { fs.rmSync(dir, { recursive: true, force: true }); break; } catch (error) { if (attempt === 4) throw error; await new Promise(resolve => setTimeout(resolve, 150 * (attempt + 1))); } }
  });
  await waitFor(base);
  const accounts = (await request(base, '/api/accounts')).data.accounts;
  const accountFor = platformCode => { const account = accounts.find(item => item.platform_code === platformCode); assert.ok(account, '缺少平台账号：' + platformCode); return account; };
  const createPublished = async (question, answer, category, subcategory) => {
    const created = await request(base, '/api/knowledge', { method: 'POST', body: JSON.stringify({ question, answer, category, subcategory }) });
    assert.equal(created.response.status, 201);
    const published = await request(base, '/api/knowledge/' + created.data.knowledge.id + '/publish', { method: 'POST', body: JSON.stringify({ reviewedBy: '统一知识范围测试' }) });
    assert.equal(published.response.status, 200);
    return published.data.knowledge;
  };
  const simulate = async (platformCode, content, suffix) => {
    // B站评论必须命中本系统 publish_targets；这里用私信绕开评论归属门禁，只验证知识共享范围。
    const isBilibili = platformCode === 'bilibili';
    const externalId = 'shared-scope-' + platformCode + '-' + suffix;
    const context = isBilibili
      ? { messageId: externalId, conversationId: 'shared-conversation-' + suffix, userId: 'shared-user-' + suffix, direction: 'incoming', chatTitleVerified: true, fullSource: true, sourceVerified: true }
      : { postId: 'shared-post-' + suffix, commentId: 'shared-comment-' + suffix, sourceVerified: true };
    const result = await request(base, '/api/messages/simulate', { method: 'POST', body: JSON.stringify({ platformCode, accountId: accountFor(platformCode).id, messageType: isBilibili ? 'PRIVATE_MESSAGE' : 'COMMENT', externalId, userName: '统一范围测试用户', content, context }) });
    assert.equal(result.response.status, 201);
    return result.data.message;
  };

  const xhsAccount = accountFor('xiaohongshu');
  const xhsAccountEnabled = await request(base, `/api/accounts/${xhsAccount.id}/runtime`, { method: 'POST', body: JSON.stringify({ enabled: true, updatedBy: '统一知识范围测试' }) });
  assert.equal(xhsAccountEnabled.response.status, 200);
  const xhsPlatformOpened = await request(base, '/api/platforms/xiaohongshu/runtime', { method: 'POST', body: JSON.stringify({ enabled: true, updatedBy: '统一知识范围测试' }) });
  assert.equal(xhsPlatformOpened.response.status, 200);

  const platformCodes = ['xiaohongshu', 'douyin', 'weibo', 'wechat_channels', 'bilibili'];
  const historicalCategories = [
    ['公共知识库', 'PUB-SHARED-660', '统一公共开放时间是什么？'],
    ['小红书知识库', 'XHS-SHARED-1101', '红杉叶片测试码是多少？'],
    ['抖音知识库', 'DY-SHARED-2101', '紫藤风铃测试码是多少？'],
    ['视频号知识库', 'WXCH-SHARED-3202', '银杏邮筒测试码是多少？'],
    ['B站知识库', 'BILI-SHARED-4303', '蓝鲸拼图测试码是多少？'],
    ['微博知识库', 'WB-SHARED-5404', '星河纸鹤测试码是多少？']
  ];

  for (const [category, marker, question] of historicalCategories) {
    const knowledge = await createPublished(question, `${marker}统一共享答案`, category, '统一范围测试');
    for (const platformCode of platformCodes) {
      const message = await simulate(platformCode, question, `${marker}-${platformCode}`);
      assert.equal(message.status, 'REPLY_QUEUED', `${platformCode} 应能读取历史分类 ${category}`);
      assert.equal(message.knowledge_id, knowledge.id, `${platformCode} 应命中同一条 ${category} 内容`);
      assert.notEqual(message.decision, 'KNOWLEDGE_GAP_GUIDANCE', `${platformCode} 不应因平台来源不同走知识缺口`);
    }
  }
  assert.equal(stderr.includes('SyntaxError'), false, stderr);
});


test('小类缓存按大类隔离、最多十条，并按最近使用顺序更新', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-cache-int-'));
  const dbPath = path.join(dir, 'test.db'); const port = await freePort(); const base = 'http://127.0.0.1:' + port;
  const child = spawn(process.execPath, ['src/server.js'], { cwd: root, env: { ...process.env, PORT: String(port), DATABASE_PATH: dbPath, QWEN_MODE: 'mock', AUTO_COLLECT_ENABLED: 'false', LOCAL_AGENT_AUTO_START: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { child.kill(); await Promise.race([new Promise(resolve => child.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 2000))]); }
    for (let attempt = 0; attempt < 5; attempt += 1) { try { fs.rmSync(dir, { recursive: true, force: true }); break; } catch (error) { if (attempt === 4) throw error; await new Promise(resolve => setTimeout(resolve, 150 * (attempt + 1))); } }
  });
  await waitFor(base);
  for (let index = 1; index <= 11; index += 1) {
    const subcategory = '缓存小类' + String(index).padStart(2, '0');
    const created = await request(base, '/api/knowledge', { method: 'POST', body: JSON.stringify({ question: '缓存测试问题' + index, answer: '缓存测试答案' + index, category: 'B站知识库', subcategory: '__CUSTOM__', customSubcategory: subcategory }) });
    assert.equal(created.response.status, 201);
    await new Promise(resolve => setTimeout(resolve, 3));
  }
  const xhsCreated = await request(base, '/api/knowledge', { method: 'POST', body: JSON.stringify({ question: '小红书缓存隔离问题', answer: '小红书缓存隔离答案', category: '小红书知识库', subcategory: '__CUSTOM__', customSubcategory: '小红书缓存项' }) });
  assert.equal(xhsCreated.response.status, 201);

  let summary = await request(base, '/api/knowledge/categories');
  let bilibiliCache = summary.data.categories.find(item => item.name === 'B站知识库').recentSubcategories;
  const xhsCache = summary.data.categories.find(item => item.name === '小红书知识库').recentSubcategories;
  assert.equal(bilibiliCache.length, 10);
  assert.equal(bilibiliCache.includes('缓存小类01'), false);
  for (let index = 2; index <= 11; index += 1) assert.ok(bilibiliCache.includes('缓存小类' + String(index).padStart(2, '0')));
  assert.ok(xhsCache.includes('小红书缓存项')); assert.equal(xhsCache.includes('缓存小类11'), false);

  await new Promise(resolve => setTimeout(resolve, 5));
  const retouched = await request(base, '/api/knowledge', { method: 'POST', body: JSON.stringify({ question: '缓存小类02再次使用', answer: '再次使用答案', category: 'B站知识库', subcategory: '缓存小类02' }) });
  assert.equal(retouched.response.status, 201);
  summary = await request(base, '/api/knowledge/categories');
  bilibiliCache = summary.data.categories.find(item => item.name === 'B站知识库').recentSubcategories;
  assert.equal(bilibiliCache[0], '缓存小类02'); assert.equal(bilibiliCache.length, 10);

  const deleted = await request(base, '/api/knowledge/subcategories?category=' + encodeURIComponent('B站知识库') + '&subcategory=' + encodeURIComponent('缓存小类02'), { method: 'DELETE', body: JSON.stringify({ confirmText: '删除' }) });
  assert.equal(deleted.response.status, 200); assert.equal(deleted.data.deleted, 2);
  summary = await request(base, '/api/knowledge/categories');
  bilibiliCache = summary.data.categories.find(item => item.name === 'B站知识库').recentSubcategories;
  assert.equal(bilibiliCache.includes('缓存小类02'), false);
  assert.equal(stderr.includes('SyntaxError'), false, stderr);
});


test('master switch persists state, controls Agent process, pauses claim, and resumes safely', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'master-switch-int-'));
  const dbPath = path.join(dir, 'test.db');
  const agentEntry = path.join(dir, 'fake-agent.mjs');
  const port = await freePort();
  const agentPort = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const agentBase = `http://127.0.0.1:${agentPort}`;
  fs.writeFileSync(agentEntry, `
    import http from 'node:http';
    const server = http.createServer((req, res) => {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      if (req.method === 'GET' && req.url === '/health') {
        return res.end(JSON.stringify({ ok: true, deviceId: process.env.DEVICE_ID }));
      }
      if (req.method === 'POST' && req.url === '/control/refresh') {
        req.resume();
        return res.end(JSON.stringify({ ok: true, masterSwitch: { enabled: true }, platforms: [] }));
      }
      if (req.method === 'POST' && req.url === '/control/shutdown') {
        req.resume();
        res.statusCode = 202;
        res.end(JSON.stringify({ ok: true, shuttingDown: true }));
        setImmediate(() => server.close());
        // Keep the process alive briefly after its listener disappears. This
        // reproduces the real master-switch restart race deterministically.
        setTimeout(() => {}, 250);
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ ok: false }));
    });
    server.listen(Number(process.env.AGENT_PORT), '127.0.0.1');
    process.on('SIGTERM', () => server.close());
    process.on('SIGINT', () => server.close());
  `, 'utf8');
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      AGENT_PORT: String(agentPort),
      LOCAL_AGENT_ENTRY: agentEntry,
      LOCAL_AGENT_START_TIMEOUT_MS: '4000',
      LOCAL_AGENT_WATCHDOG_INTERVAL_MS: '2000',
      LOCAL_AGENT_AUTO_START: 'true',
      CLOUD_BASE_URL: base,
      DATABASE_PATH: dbPath,
      QWEN_MODE: 'mock',
      RPA_MODE: 'simulated',
      AUTO_COLLECT_ENABLED: 'false'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  t.after(async () => {
    try {
      await fetch(agentBase + '/control/shutdown', { method: 'POST', body: '{}' });
      await waitForAgentOffline(agentBase);
    } catch {}
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await Promise.race([new Promise(resolve => child.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 2000))]);
    }
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try { fs.rmSync(dir, { recursive: true, force: true }); break; }
      catch (error) { if (attempt === 4) throw error; await new Promise(resolve => setTimeout(resolve, 150 * (attempt + 1))); }
    }
  });
  await waitFor(base);
  await waitForAgent(agentBase);

  const initialBootstrap = await request(base, '/api/bootstrap');
  assert.equal(initialBootstrap.data.config.masterSwitch.enabled, true);
  const initialSettings = await request(base, '/api/settings/operations');
  assert.equal(initialSettings.data.settings.enabled, true);

  await new Promise(resolve => setTimeout(resolve, 1800));
  await fetch(agentBase + '/control/shutdown', { method: 'POST', body: '{}' });
  await waitForAgentOffline(agentBase);
  await new Promise(resolve => setTimeout(resolve, 2500));
  await waitForAgent(agentBase);
  const recoveredSettings = await request(base, '/api/settings/operations');
  assert.equal(recoveredSettings.data.settings.enabled, true, 'watchdog recovery must keep the master switch enabled');

  const account = initialBootstrap.data.accounts.find(item => item.platform_code === 'douyin');
  assert.ok(account);
  const queued = await request(base, '/api/platforms/douyin/collect', { method: 'POST', body: JSON.stringify({ accountId: account.id }) });
  assert.equal(queued.response.status, 200);
  assert.ok(queued.data.jobId);

  const paused = await request(base, '/api/settings/operations', { method: 'POST', body: JSON.stringify({ enabled: false, updatedBy: 'integration-test' }) });
  assert.equal(paused.response.status, 200);
  assert.equal(paused.data.settings.enabled, false);
  assert.equal(paused.data.settings.updatedBy, 'integration-test');
  assert.equal(paused.data.agentShutdown.stopped, true);
  assert.equal(paused.data.agentShutdown.accepted, true);
  await waitForAgentOffline(agentBase);
  const pausedBootstrap = await request(base, '/api/bootstrap');
  assert.equal(pausedBootstrap.data.config.masterSwitch.enabled, false);
  assert.equal(pausedBootstrap.data.devices.find(item => item.id === account.device_id)?.status, 'OFFLINE');

  const invalid = await request(base, '/api/settings/operations', { method: 'POST', body: JSON.stringify({ enabled: 'false' }) });
  assert.equal(invalid.response.status, 400);
  const blockedCollect = await request(base, '/api/platforms/douyin/collect', { method: 'POST', body: JSON.stringify({ accountId: account.id }) });
  assert.equal(blockedCollect.response.status, 409);
  const blockedPublish = await request(base, '/api/publish/tasks', { method: 'POST', body: '{}' });
  assert.equal(blockedPublish.response.status, 409);

  const pausedClaim = await request(base, '/api/agent/jobs/claim', { method: 'POST', body: JSON.stringify({ deviceId: account.device_id }) });
  assert.equal(pausedClaim.response.status, 200);
  assert.equal(pausedClaim.data.job, null);
  assert.equal(pausedClaim.data.paused, true);

  const resumed = await request(base, '/api/settings/operations', { method: 'POST', body: JSON.stringify({ enabled: true, updatedBy: 'integration-test' }) });
  assert.equal(resumed.response.status, 200, JSON.stringify(resumed.data));
  assert.equal(resumed.data.settings.enabled, true);
  assert.equal(resumed.data.agent.online, true);
  await waitForAgent(agentBase);
  const isolatedMiss = await request(base, '/api/agent/jobs/claim', { method: 'POST', body: JSON.stringify({ deviceId: account.device_id, platformCodes: ['wechat_channels'] }) });
  assert.equal(isolatedMiss.response.status, 200);
  assert.equal(isolatedMiss.data.job, null);
  assert.deepEqual(isolatedMiss.data.platformCodes, ['wechat_channels']);
  const invalidPlatformFilter = await request(base, '/api/agent/jobs/claim', { method: 'POST', body: JSON.stringify({ deviceId: account.device_id, platformCodes: ['unknown_platform'] }) });
  assert.equal(invalidPlatformFilter.response.status, 400);
  const resumedClaim = await request(base, '/api/agent/jobs/claim', { method: 'POST', body: JSON.stringify({ deviceId: account.device_id, platformCodes: ['douyin'] }) });
  assert.equal(resumedClaim.response.status, 200);
  assert.equal(resumedClaim.data.job.id, queued.data.jobId);
  assert.equal(resumedClaim.data.job.status, 'RUNNING');

  const stoppedAgain = await request(base, '/api/settings/operations', { method: 'POST', body: JSON.stringify({ enabled: false, updatedBy: 'integration-test-cleanup' }) });
  assert.equal(stoppedAgain.data.agentShutdown.stopped, true);
  await waitForAgentOffline(agentBase);
  assert.equal(stderr.includes('SyntaxError'), false, stderr);
});

test('本地 Agent 五平台批量登录接口：仅 RUNNING 平台参与，模拟模式不误报且单项失败不阻断整批', async t => {
  const platformCodes = ['xiaohongshu', 'douyin', 'wechat_channels', 'bilibili', 'weibo'];
  const allPlatformCodes = [...platformCodes];
  const platforms = allPlatformCodes.map((code, index) => ({ code, name: code, sort_order: index + 1, desired_state: 'RUNNING', effective_state: 'RUNNING', enabled_account_count: 1, ready_account_count: 0, queued_job_count: 0, running_job_count: 0, blocked_reason: null }));
  const cloudStub = await startRuntimeStub(platforms);
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['agent/local-agent.js'], {
    cwd: root,
    env: {
      ...process.env,
      AGENT_PORT: String(port),
      CLOUD_BASE_URL: cloudStub.base,
      RPA_MODE: 'simulated',
      QWEN_MODE: 'mock'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await Promise.race([new Promise(resolve => child.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 2000))]);
    }
    await closeServer(cloudStub.server);
  });

  await waitForAgent(base);
  let automaticMonitor = null;
  for (let i = 0; i < 50; i += 1) {
    automaticMonitor = await request(base, '/platforms/login-monitor/status');
    if (automaticMonitor.data.loginMonitor.monitoredPlatformCodes.length === platformCodes.length) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.deepEqual(automaticMonitor.data.loginMonitor.monitoredPlatformCodes.sort(), [...platformCodes].sort(), 'Agent 启动后应从 RUNNING 平台自动恢复登录轮询集合');
  assert.ok(automaticMonitor.data.loginMonitor.nextPollAt);

  const checked = await request(base, '/platforms/check-login', { method: 'POST', body: '{}' });
  assert.equal(checked.response.status, 200);
  assert.deepEqual(Object.keys(checked.data.statuses).sort(), [...platformCodes].sort());
  for (const platformCode of platformCodes) {
    const status = checked.data.statuses[platformCode];
    assert.equal(status.platformCode, platformCode);
    assert.equal(status.state, 'UNAVAILABLE');
    assert.equal(status.loggedIn, false);
    assert.equal(status.confidence, 'UNCONFIRMED');
    assert.ok(status.checkedAt);
    assert.match(status.message, /不支持真实登录检查/);
  }

  const opened = await request(base, '/platforms/open-login', { method: 'POST', body: '{}' });
  assert.equal(opened.response.status, 200);
  assert.deepEqual(Object.keys(opened.data.statuses).sort(), [...platformCodes].sort());
  for (const platformCode of platformCodes) {
    assert.equal(opened.data.statuses[platformCode].state, 'UNAVAILABLE');
    assert.equal(opened.data.statuses[platformCode].loggedIn, false);
  }
  const monitorAfterOpen = await request(base, '/platforms/login-monitor/status');
  assert.deepEqual(monitorAfterOpen.data.loginMonitor.monitoredPlatformCodes.sort(), [...platformCodes].sort());
  assert.ok(monitorAfterOpen.data.loginMonitor.nextPollAt);
  assert.equal(stderr.includes('SyntaxError'), false, stderr);
});


test('平台关闭时排队任务保持等待，开启后才可领取', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'platform-runtime-claim-'));
  const dbPath = path.join(dir, 'test.db');
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['src/server.js'], { cwd: root, env: { ...process.env, PORT: String(port), DATABASE_PATH: dbPath, QWEN_MODE: 'mock', RPA_MODE: 'simulated', AUTO_COLLECT_ENABLED: 'false', LOCAL_AGENT_AUTO_START: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await Promise.race([new Promise(resolve => child.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 2000))]);
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await waitFor(base);
  const bootstrap = (await request(base, '/api/bootstrap')).data;
  const account = bootstrap.accounts.find(item => item.platform_code === 'douyin');
  assert.ok(account);
  const queued = await request(base, '/api/platforms/douyin/collect', { method: 'POST', body: JSON.stringify({ accountId: account.id }) });
  assert.equal(queued.response.status, 200);

  const stopped = await request(base, '/api/platforms/douyin/runtime', { method: 'POST', body: JSON.stringify({ enabled: false, updatedBy: '集成测试' }) });
  assert.equal(stopped.response.status, 200);
  assert.equal(stopped.data.platform.desired_state, 'STOPPED');
  assert.equal(stopped.data.platform.effective_state, 'STOPPED');
  assert.equal(stopped.data.shutdown.acceptingNewJobs, false);
  assert.equal(stopped.data.shutdown.queuedJobsRemainWaiting, true);

  const blockedClaim = await request(base, '/api/agent/jobs/claim', { method: 'POST', body: JSON.stringify({ deviceId: account.device_id, platformCodes: ['douyin'] }) });
  assert.equal(blockedClaim.response.status, 200);
  assert.equal(blockedClaim.data.job, null);
  const runtimeWhileStopped = await request(base, '/api/platforms/douyin/runtime');
  assert.equal(runtimeWhileStopped.data.platform.queued_job_count, 1);
  assert.equal(runtimeWhileStopped.data.platform.running_job_count, 0);
  const blockedCollect = await request(base, '/api/platforms/douyin/collect', { method: 'POST', body: JSON.stringify({ accountId: account.id }) });
  assert.equal(blockedCollect.response.status, 409);

  const started = await request(base, '/api/platforms/douyin/runtime', { method: 'POST', body: JSON.stringify({ enabled: true, updatedBy: '集成测试' }) });
  assert.equal(started.response.status, 200);
  assert.equal(started.data.platform.desired_state, 'RUNNING');
  assert.equal(started.data.platform.effective_state, 'RUNNING');
  const claimed = await request(base, '/api/agent/jobs/claim', { method: 'POST', body: JSON.stringify({ deviceId: account.device_id, platformCodes: ['douyin'] }) });
  assert.equal(claimed.response.status, 200);
  assert.equal(claimed.data.job.id, queued.data.jobId);
  assert.equal(claimed.data.job.status, 'RUNNING');
  assert.equal(stderr.includes('SyntaxError'), false, stderr);
});


test('停止平台的 Local Agent 入口不调用适配器且不创建浏览器 Profile', async t => {
  const platformCodes = ['xiaohongshu', 'douyin', 'wechat_channels', 'bilibili', 'weibo'];
  const platforms = platformCodes.map((code, index) => ({ code, name: code, sort_order: index + 1, desired_state: 'STOPPED', effective_state: 'STOPPED', enabled_account_count: 1, ready_account_count: 0, queued_job_count: code === 'xiaohongshu' ? 1 : 0, running_job_count: 0, blocked_reason: 'PLATFORM_STOPPED' }));
  const cloudStub = await startRuntimeStub(platforms);
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stopped-platform-profile-'));
  const profilePaths = Object.fromEntries(platformCodes.map(code => [code, path.join(dir, `${code}-profile`)]));
  const child = spawn(process.execPath, ['agent/local-agent.js'], {
    cwd: root,
    env: {
      ...process.env,
      AGENT_PORT: String(port),
      CLOUD_BASE_URL: cloudStub.base,
      RPA_MODE: 'five_platform_assisted',
      QWEN_MODE: 'mock',
      XHS_PROFILE_DIR: profilePaths.xiaohongshu,
      DOUYIN_PROFILE_DIR: profilePaths.douyin,
      CHANNELS_PROFILE_DIR: profilePaths.wechat_channels,
      BILIBILI_PROFILE_DIR: profilePaths.bilibili,
      WEIBO_PROFILE_DIR: profilePaths.weibo
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await Promise.race([new Promise(resolve => child.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 2000))]);
    }
    await closeServer(cloudStub.server);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await waitForAgent(base);
  for (const profilePath of Object.values(profilePaths)) assert.equal(fs.existsSync(profilePath), false, `Agent 启动不应创建 Profile：${profilePath}`);
  const opened = await request(base, '/platforms/xiaohongshu/open-login', { method: 'POST', body: '{}' });
  assert.equal(opened.response.status, 409);
  assert.equal(opened.data.code, 'PLATFORM_STOPPED');
  assert.equal(fs.existsSync(profilePaths.xiaohongshu), false, '停止平台不得创建 Profile 或启动浏览器');
  const checked = await request(base, '/platforms/xiaohongshu/check-login', { method: 'POST', body: '{}' });
  assert.equal(checked.response.status, 409);
  assert.equal(fs.existsSync(profilePaths.xiaohongshu), false);
  const status = await request(base, '/platforms/xiaohongshu/status');
  assert.equal(status.response.status, 200);
  assert.equal(status.data.status.state, 'STOPPED');
  assert.equal(stderr.includes('SyntaxError'), false, stderr);
});

test('master stop blocks local video-channel claim, adapter calls, and Profile creation even when platform runtime says RUNNING', async t => {
  const platformCodes = ['xiaohongshu', 'douyin', 'wechat_channels', 'bilibili', 'weibo'];
  const control = {
    masterSwitch: { enabled: false },
    platforms: platformCodes.map((code, index) => ({
      code, name: code, sort_order: index + 1,
      desired_state: 'RUNNING', effective_state: 'RUNNING',
      enabled_account_count: 1, ready_account_count: 1,
      queued_job_count: code === 'wechat_channels' ? 1 : 0,
      running_job_count: 0, blocked_reason: null
    }))
  };
  const cloudStub = await startRuntimeStub(control);
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'master-stopped-profile-'));
  const channelsProfile = path.join(dir, 'wechat-channels-profile');
  const child = spawn(process.execPath, ['agent/local-agent.js'], {
    cwd: root,
    env: {
      ...process.env,
      AGENT_PORT: String(port), CLOUD_BASE_URL: cloudStub.base,
      RPA_MODE: 'five_platform_assisted', QWEN_MODE: 'mock',
      XHS_PROFILE_DIR: path.join(dir, 'xhs'),
      DOUYIN_PROFILE_DIR: path.join(dir, 'douyin'),
      CHANNELS_PROFILE_DIR: channelsProfile,
      BILIBILI_PROFILE_DIR: path.join(dir, 'bilibili'),
      WEIBO_PROFILE_DIR: path.join(dir, 'weibo'),
      AGENT_POLL_MS: '100'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await Promise.race([new Promise(resolve => child.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 2000))]);
    }
    await closeServer(cloudStub.server);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await waitForAgent(base);
  await new Promise(resolve => setTimeout(resolve, 350));
  assert.equal(cloudStub.stats.claimCalls, 0, 'Local Agent must not call claim while the master switch is stopped');
  assert.equal(fs.existsSync(channelsProfile), false);

  const opened = await request(base, '/platforms/wechat_channels/open-login', { method: 'POST', body: '{}' });
  assert.equal(opened.response.status, 409);
  assert.equal(opened.data.code, 'PLATFORM_STOPPED');
  assert.equal(opened.data.runtime.blocked_reason, 'MASTER_SWITCH_STOPPED');
  assert.equal(fs.existsSync(channelsProfile), false, 'master stop must prevent the video-channel Profile and browser from being created');

  const batch = await request(base, '/platforms/open-login', { method: 'POST', body: '{}' });
  assert.equal(batch.response.status, 200);
  assert.equal(batch.data.statuses.wechat_channels.state, 'STOPPED');
  assert.equal(fs.existsSync(channelsProfile), false);
  assert.equal(stderr.includes('SyntaxError'), false, stderr);
});

test('Douyin REPLY NEEDS_CONFIRMATION never writes AUTO_REPLIED', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-reply-confirmation-'));
  const dbPath = path.join(dir, 'test.db');
  const port = 31994;
  const base = 'http://127.0.0.1:' + port;
  const child = spawn(process.execPath, ['src/server.js'], { cwd: root, env: { ...process.env, PORT: String(port), DATABASE_PATH: dbPath, QWEN_MODE: 'mock', RPA_MODE: 'simulated', AUTO_COLLECT_ENABLED: 'false', LOCAL_AGENT_AUTO_START: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await Promise.race([new Promise(resolve => child.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 2000))]);
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await waitFor(base);
  const bootstrap = (await request(base, '/api/bootstrap')).data;
  const account = bootstrap.accounts.find(item => item.platform_code === 'douyin');
  assert.ok(account);
  const externalId = 'douyin-reply-needs-confirmation-1';
  const upsert = await request(base, '/api/agent/messages/upsert', {
    method: 'POST',
    body: JSON.stringify({
      platformCode: 'douyin', accountId: account.id, messageType: 'COMMENT', externalId,
      userName: '\u5b89\u5168\u6d4b\u8bd5\u7528\u6237', content: '\u8bf7\u95ee\u793e\u533a\u670d\u52a1\u4e2d\u5fc3\u51e0\u70b9\u4e0a\u73ed\uff1f',
      externalUrl: 'https://creator.douyin.com/creator-micro/data/following/comment',
      context: { sourceVideoKey: 'video-needs-confirmation', commentStableId: 'comment-needs-confirmation', eventTime: '22:37', sourceVerified: true }
    })
  });
  assert.equal(upsert.response.status, 200);
  const queued = (await request(base, '/api/messages')).data.messages.find(item => item.external_id === externalId);
  assert.equal(queued.status, 'REPLY_QUEUED');
  const claim = await request(base, '/api/agent/jobs/claim', { method: 'POST', body: JSON.stringify({ deviceId: account.device_id }) });
  assert.equal(claim.data.job.job_type, 'REPLY');
  assert.equal(claim.data.job.payload.messageId, queued.id);
  const completed = await request(base, '/api/agent/jobs/' + claim.data.job.id + '/complete', {
    method: 'POST', body: JSON.stringify({ status: 'NEEDS_CONFIRMATION', result: { message: '\u5df2\u70b9\u51fb\u53d1\u9001\uff0c\u4f46\u76ee\u6807\u7ebf\u7a0b\u65e0\u65b0\u589e\u7cbe\u786e\u56de\u663e' } })
  });
  assert.equal(completed.response.status, 200);
  const finalMessage = (await request(base, '/api/messages')).data.messages.find(item => item.external_id === externalId);
  assert.equal(finalMessage.status, 'MANUAL_REQUIRED');
  assert.equal(finalMessage.decision, 'TECHNICAL_ERROR');
  assert.equal(finalMessage.handled_at, null);
  assert.notEqual(finalMessage.handled_by, 'AI_RPA');

  const multiUnreadExternalId = 'douyin-private-multi-unread-preview-1';
  await request(base, '/api/agent/messages/upsert', {
    method: 'POST',
    body: JSON.stringify({
      platformCode: 'douyin', accountId: account.id, messageType: 'PRIVATE_MESSAGE', externalId: multiUnreadExternalId,
      userName: '\u964c\u751f\u6d4b\u8bd5\u7528\u6237', content: '\u8bf7\u95ee\u793e\u533a\u670d\u52a1\u4e2d\u5fc3\u51e0\u70b9\u4e0a\u73ed\uff1f',
      externalUrl: 'https://www.douyin.com/user/self',
      context: { conversationName: '\u964c\u751f\u6d4b\u8bd5\u7528\u6237', inboxType: 'STRANGER', previewOnly: true, unreadCount: 2 }
    })
  });
  const multiUnread = (await request(base, '/api/messages')).data.messages.find(item => item.external_id === multiUnreadExternalId);
  assert.equal(multiUnread.status, 'MANUAL_REQUIRED');
  assert.equal(multiUnread.decision, 'PRIVATE_PREVIEW_INCOMPLETE');
  assert.equal(multiUnread.reply_job_id, null);
  assert.match(multiUnread.reason, /2 \u6761\u672a\u8bfb/);

  const singlePreviewExternalId = 'douyin-private-single-preview-knowledge-match-1';
  await request(base, '/api/agent/messages/upsert', {
    method: 'POST',
    body: JSON.stringify({
      platformCode: 'douyin', accountId: account.id, messageType: 'PRIVATE_MESSAGE', externalId: singlePreviewExternalId,
      userName: '知识命中测试用户', content: '请问社区服务中心几点上班？',
      externalUrl: 'https://www.douyin.com/user/self',
      context: { conversationName: '知识命中测试用户', inboxType: 'MAIN', unread: true, unreadCount: 1, previewOnly: true, fullSource: false, sourceVerified: false, chatTitleVerified: true }
    })
  });
  const singlePreview = (await request(base, '/api/messages')).data.messages.find(item => item.external_id === singlePreviewExternalId);
  assert.equal(singlePreview.status, 'MANUAL_REQUIRED');
  assert.equal(singlePreview.decision, 'AUTO_REPLY_INELIGIBLE');
  assert.ok(singlePreview.knowledge_id, 'knowledge match must remain visible even when the send eligibility gate blocks the reply');
  assert.ok(Number(singlePreview.confidence) >= 0.58);
  assert.equal(singlePreview.reply_job_id, null);

  const riskPreviewExternalId = 'douyin-private-risk-preview-1';
  await request(base, '/api/agent/messages/upsert', {
    method: 'POST',
    body: JSON.stringify({
      platformCode: 'douyin', accountId: account.id, messageType: 'PRIVATE_MESSAGE', externalId: riskPreviewExternalId,
      userName: '\u6296\u97f3\u5c0f\u5b89', content: '\u63d0\u9192\uff1a\u8b66\u60d5\u8272\u60c5\u670d\u52a1\u8bc8\u9a97\uff01',
      externalUrl: 'https://www.douyin.com/user/self',
      context: { conversationName: '\u6296\u97f3\u5c0f\u5b89', inboxType: 'STRANGER', previewOnly: true, unreadCount: 2 }
    })
  });
  const riskPreview = (await request(base, '/api/messages')).data.messages.find(item => item.external_id === riskPreviewExternalId);
  assert.equal(riskPreview.status, 'MANUAL_REQUIRED');
  assert.equal(riskPreview.decision, 'HUMAN_FOLLOWUP_NOTIFICATION_PENDING');
  assert.equal(riskPreview.wecom_notification_status, 'PENDING');
  assert.match(riskPreview.reason, /风险|恶意|诈骗/);
  assert.equal(riskPreview.reply_job_id, null);

  const weakExternalId = 'douyin-reply-success-without-attestation-1';
  await request(base, '/api/agent/messages/upsert', {
    method: 'POST',
    body: JSON.stringify({
      platformCode: 'douyin', accountId: account.id, messageType: 'PRIVATE_MESSAGE', externalId: weakExternalId,
      userName: '\u5b89\u5168\u6d4b\u8bd5\u7528\u6237B', content: '\u8bf7\u95ee\u793e\u533a\u670d\u52a1\u4e2d\u5fc3\u51e0\u70b9\u4e0a\u73ed\uff1f',
      externalUrl: 'https://www.douyin.com/user/self', context: { conversationId: 'conversation-weak-attestation', messageId: 'message-weak-attestation', direction: 'incoming', conversationName: '\u5b89\u5168\u6d4b\u8bd5\u7528\u6237B', previewOnly: false, sourceVerified: true, chatTitleVerified: true }
    })
  });
  const weakClaim = await request(base, '/api/agent/jobs/claim', { method: 'POST', body: JSON.stringify({ deviceId: account.device_id }) });
  assert.equal(weakClaim.data.job.job_type, 'REPLY');
  await request(base, '/api/agent/jobs/' + weakClaim.data.job.id + '/complete', {
    method: 'POST', body: JSON.stringify({ status: 'SUCCESS', result: { message: '\u4ec5\u58f0\u660e\u6210\u529f\uff0c\u6ca1\u6709\u56de\u663e\u8bc1\u636e' } })
  });
  const weakFinal = (await request(base, '/api/messages')).data.messages.find(item => item.external_id === weakExternalId);
  assert.equal(weakFinal.status, 'MANUAL_REQUIRED');
  assert.equal(weakFinal.handled_at, null);
  assert.notEqual(weakFinal.handled_by, 'AI_RPA');

  const verifiedExternalId = 'douyin-reply-attested-success-1';
  await request(base, '/api/agent/messages/upsert', {
    method: 'POST',
    body: JSON.stringify({
      platformCode: 'douyin', accountId: account.id, messageType: 'PRIVATE_MESSAGE', externalId: verifiedExternalId,
      userName: '\u5b89\u5168\u6d4b\u8bd5\u7528\u6237C', content: '\u8bf7\u95ee\u793e\u533a\u670d\u52a1\u4e2d\u5fc3\u51e0\u70b9\u4e0a\u73ed\uff1f',
      externalUrl: 'https://www.douyin.com/user/self', context: { conversationId: 'conversation-verified-attestation', messageId: 'message-verified-attestation', direction: 'incoming', conversationName: '\u5b89\u5168\u6d4b\u8bd5\u7528\u6237C', previewOnly: false, sourceVerified: true, chatTitleVerified: true }
    })
  });
  const verifiedClaim = await request(base, '/api/agent/jobs/claim', { method: 'POST', body: JSON.stringify({ deviceId: account.device_id }) });
  assert.equal(verifiedClaim.data.job.job_type, 'REPLY');
  await request(base, '/api/agent/jobs/' + verifiedClaim.data.job.id + '/complete', {
    method: 'POST', body: JSON.stringify({ status: 'SUCCESS', result: {
      message: '\u5df2\u5728\u76ee\u6807\u79c1\u4fe1\u4f1a\u8bdd\u7684\u5df1\u65b9\u6c14\u6ce1\u68c0\u6d4b\u5230\u7cbe\u786e\u56de\u663e',
      stage: 'reply_sent', evidencePath: 'D:/evidence/reply.json', screenshotPath: 'D:/evidence/reply.png',
      sendMethod: 'scoped-selector:.e2e-send-msg-btn', editorCleared: true, baselineEchoCount: 0, scopedEchoCount: 1
    } })
  });
  const verifiedFinal = (await request(base, '/api/messages')).data.messages.find(item => item.external_id === verifiedExternalId);
  assert.equal(verifiedFinal.status, 'AUTO_REPLIED');
  assert.equal(verifiedFinal.handled_by, 'AI_RPA');
  assert.ok(verifiedFinal.handled_at);

  const channelsAccount = bootstrap.accounts.find(item => item.platform_code === 'wechat_channels');
  assert.ok(channelsAccount);
  const createChannelsReply = async externalId => {
    const upserted = await request(base, '/api/agent/messages/upsert', { method: 'POST', body: JSON.stringify({
      platformCode: 'wechat_channels', accountId: channelsAccount.id, messageType: 'PRIVATE_MESSAGE', externalId,
      userName: '\u89c6\u9891\u53f7\u5b89\u5168\u6d4b\u8bd5\u7528\u6237', content: '\u8bf7\u95ee\u793e\u533a\u670d\u52a1\u4e2d\u5fc3\u51e0\u70b9\u4e0a\u73ed\uff1f',
      externalUrl: 'https://channels.weixin.qq.com/platform/private_msg',
      context: { conversationId: 'conversation-' + externalId, messageId: 'message-' + externalId, direction: 'incoming', conversationName: '\u89c6\u9891\u53f7\u5b89\u5168\u6d4b\u8bd5\u7528\u6237', previewOnly: false, sourceVerified: true, chatTitleVerified: true }
    }) });
    assert.equal(upserted.response.status, 200);
    assert.equal(upserted.data.results[0].message.status, 'REPLY_QUEUED');
    return request(base, '/api/agent/jobs/claim', { method: 'POST', body: JSON.stringify({ deviceId: channelsAccount.device_id }) });
  };
  const channelsWeakId = 'wechat-reply-success-without-scoped-echo-1';
  const channelsWeakClaim = await createChannelsReply(channelsWeakId);
  assert.equal(channelsWeakClaim.data.job.job_type, 'REPLY');
  await request(base, '/api/agent/jobs/' + channelsWeakClaim.data.job.id + '/complete', { method: 'POST', body: JSON.stringify({ status: 'SUCCESS', result: {
    stage: 'reply_sent', evidencePath: 'D:/evidence/channels.json', screenshotPath: 'D:/evidence/channels.png',
    sendMethod: 'wechat-channels:scoped-ui', editorCleared: true, baselineEchoCount: 0, scopedEchoCount: 0
  } }) });
  const channelsWeakFinal = (await request(base, '/api/messages')).data.messages.find(item => item.external_id === channelsWeakId);
  assert.equal(channelsWeakFinal.status, 'MANUAL_REQUIRED');

  const channelsVerifiedId = 'wechat-reply-attested-success-1';
  const channelsVerifiedClaim = await createChannelsReply(channelsVerifiedId);
  assert.equal(channelsVerifiedClaim.data.job.job_type, 'REPLY');
  await request(base, '/api/agent/jobs/' + channelsVerifiedClaim.data.job.id + '/complete', { method: 'POST', body: JSON.stringify({ status: 'SUCCESS', result: {
    stage: 'reply_sent', evidencePath: 'D:/evidence/channels.json', screenshotPath: 'D:/evidence/channels.png',
    sendMethod: 'wechat-channels:wechat-comment-scoped:.create-ft .primary', editorCleared: true, baselineEchoCount: 0, scopedEchoCount: 1
  } }) });
  const channelsVerifiedFinal = (await request(base, '/api/messages')).data.messages.find(item => item.external_id === channelsVerifiedId);
  assert.equal(channelsVerifiedFinal.status, 'AUTO_REPLIED');
  assert.equal(channelsVerifiedFinal.handled_by, 'AI_RPA');

  const bilibiliAccount = bootstrap.accounts.find(item => item.platform_code === 'bilibili');
  assert.ok(bilibiliAccount);
  const createBilibiliReply = async externalId => {
    const upserted = await request(base, '/api/agent/messages/upsert', { method: 'POST', body: JSON.stringify({
      platformCode: 'bilibili', accountId: bilibiliAccount.id, messageType: 'PRIVATE_MESSAGE', externalId,
      userName: '\u0042\u7ad9\u5b89\u5168\u6d4b\u8bd5\u7528\u6237', content: '\u8bf7\u95ee\u793e\u533a\u670d\u52a1\u4e2d\u5fc3\u51e0\u70b9\u4e0a\u73ed\uff1f', externalUrl: 'https://message.bilibili.com/#/whisper',
      context: { conversationId: 'conversation-' + externalId, messageId: 'message-' + externalId, direction: 'incoming', talkerId: '22', previewOnly: false, sourceVerified: true, chatTitleVerified: true }
    }) });
    assert.equal(upserted.response.status, 200);
    assert.equal(upserted.data.results[0].message.status, 'REPLY_QUEUED');
    return request(base, '/api/agent/jobs/claim', { method: 'POST', body: JSON.stringify({ deviceId: bilibiliAccount.device_id }) });
  };
  const biliWeakId = 'bilibili-reply-success-without-id-1';
  const biliWeakClaim = await createBilibiliReply(biliWeakId);
  assert.equal(biliWeakClaim.data.job.job_type, 'REPLY');
  await request(base, '/api/agent/jobs/' + biliWeakClaim.data.job.id + '/complete', { method: 'POST', body: JSON.stringify({ status: 'SUCCESS', result: {
    stage: 'reply_sent', evidencePath: 'D:/evidence/bili.json', screenshotPath: 'D:/evidence/bili.png', sendMethod: 'bilibili-api:web-im-send-msg', apiCode: 0, verified: true
  } }) });
  const biliWeakFinal = (await request(base, '/api/messages')).data.messages.find(item => item.external_id === biliWeakId);
  assert.equal(biliWeakFinal.status, 'MANUAL_REQUIRED');

  const biliSafeRetryId = 'bilibili-reply-safe-pre-send-retry-1';
  const biliSafeFirstClaim = await createBilibiliReply(biliSafeRetryId);
  const biliSafeFirstJobId = biliSafeFirstClaim.data.job.id;
  await request(base, '/api/agent/jobs/' + biliSafeFirstJobId + '/complete', { method: 'POST', body: JSON.stringify({ status: 'FAILED', result: {
    stage: 'reply_validation_failed', sendMethod: 'bilibili-api:web-im-send-msg', sendAttempted: false, verified: false
  } }) });
  const biliSafeFailed = (await request(base, '/api/messages')).data.messages.find(item => item.external_id === biliSafeRetryId);
  assert.equal(biliSafeFailed.status, 'MANUAL_REQUIRED');
  const biliSafeRetry = await request(base, '/api/messages/' + biliSafeFailed.id + '/retry', { method: 'POST', body: '{}' });
  assert.equal(biliSafeRetry.response.status, 200, JSON.stringify(biliSafeRetry.data));
  assert.doesNotMatch(JSON.stringify(biliSafeRetry.data), /AI\s*自检/);
  const biliSafeSecondClaim = await request(base, '/api/agent/jobs/claim', { method: 'POST', body: JSON.stringify({ deviceId: bilibiliAccount.device_id }) });
  assert.equal(biliSafeSecondClaim.data.job.job_type, 'REPLY');
  assert.equal(biliSafeSecondClaim.data.job.payload.messageId, biliSafeFailed.id);
  await request(base, '/api/agent/jobs/' + biliSafeSecondClaim.data.job.id + '/complete', { method: 'POST', body: JSON.stringify({ status: 'FAILED', result: {
    stage: 'reply_validation_failed', sendMethod: 'bilibili-api:web-im-send-msg', sendAttempted: false, verified: false
  } }) });

  const biliUnsafeRetryId = 'bilibili-reply-uncertain-no-retry-1';
  const biliUnsafeClaim = await createBilibiliReply(biliUnsafeRetryId);
  await request(base, '/api/agent/jobs/' + biliUnsafeClaim.data.job.id + '/complete', { method: 'POST', body: JSON.stringify({ status: 'NEEDS_CONFIRMATION', result: {
    stage: 'reply_unconfirmed', sendMethod: 'bilibili-api:web-im-send-msg', sendAttempted: true, verified: false
  } }) });
  const biliUnsafeFailed = (await request(base, '/api/messages')).data.messages.find(item => item.external_id === biliUnsafeRetryId);
  const biliUnsafeRetry = await request(base, '/api/messages/' + biliUnsafeFailed.id + '/retry', { method: 'POST', body: '{}' });
  assert.equal(biliUnsafeRetry.response.status, 409);
  assert.equal(biliUnsafeRetry.data.code, 'REQUEST_FAILED');
  assert.doesNotMatch(JSON.stringify(biliUnsafeRetry.data), /AI\s*自检/);
  assert.match(biliUnsafeRetry.data.message, /结果不可确定|重复回复|禁止自动重试/);

  const biliVerifiedId = 'bilibili-reply-attested-success-1';
  const biliVerifiedClaim = await createBilibiliReply(biliVerifiedId);
  assert.equal(biliVerifiedClaim.data.job.job_type, 'REPLY');
  await request(base, '/api/agent/jobs/' + biliVerifiedClaim.data.job.id + '/complete', { method: 'POST', body: JSON.stringify({ status: 'SUCCESS', result: {
    stage: 'reply_sent', evidencePath: 'D:/evidence/bili.json', screenshotPath: 'D:/evidence/bili.png', sendMethod: 'bilibili-api:web-im-send-msg', apiCode: 0, platformMessageId: '998877', verified: true
  } }) });
  const biliVerifiedFinal = (await request(base, '/api/messages')).data.messages.find(item => item.external_id === biliVerifiedId);
  assert.equal(biliVerifiedFinal.status, 'AUTO_REPLIED');
  assert.equal(biliVerifiedFinal.handled_by, 'AI_RPA');
});


test('Douyin private collection dedupes the same preview when relative time changes', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-private-dedupe-'));
  const dbPath = path.join(dir, 'test.db');
  const port = 31996;
  const base = 'http://127.0.0.1:' + port;
  const child = spawn(process.execPath, ['src/server.js'], { cwd: root, env: { ...process.env, PORT: String(port), DATABASE_PATH: dbPath, QWEN_MODE: 'mock', RPA_MODE: 'simulated', AUTO_COLLECT_ENABLED: 'false', LOCAL_AGENT_AUTO_START: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await Promise.race([new Promise(resolve => child.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 2000))]);
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await waitFor(base);
  const bootstrap = (await request(base, '/api/bootstrap')).data;
  const account = bootstrap.accounts.find(item => item.platform_code === 'douyin');
  assert.ok(account);
  const common = {
    platformCode: 'douyin', accountId: account.id, messageType: 'PRIVATE_MESSAGE',
    userName: '\u5496\u5561\u4e0d\u5609', content: '\u4e00\u4e2a\u77e5\u8bc6\u5e93\u4e0d\u4f1a\u547d\u4e2d\u7684\u552f\u4e00\u95ee\u9898',
    externalUrl: 'https://www.douyin.com/user/self'
  };
  const first = await request(base, '/api/agent/messages/upsert', { method: 'POST', body: JSON.stringify({
    ...common, externalId: 'douyin-private-old-relative-id',
    context: { eventTime: '\u0033\u0032\u5206\u949f\u524d', occurrenceAnchor: '2026-08-07T03:00Z', previewOnly: true, unreadCount: 1, inboxType: 'MAIN' }
  }) });
  assert.equal(first.response.status, 200);
  assert.equal(first.data.results[0].created, true);
  const second = await request(base, '/api/agent/messages/upsert', { method: 'POST', body: JSON.stringify({
    ...common, externalId: 'douyin-private-new-relative-id',
    context: { eventTime: '\u0033\u0034\u5206\u949f\u524d', occurrenceAnchor: '2026-08-07T03:00Z', previewOnly: true, unreadCount: 1, inboxType: 'STRANGER' }
  }) });
  assert.equal(second.response.status, 200);
  assert.equal(second.data.results[0].created, false);
  const matching = (await request(base, '/api/messages')).data.messages.filter(item => item.platform_code === 'douyin' && item.message_type === 'PRIVATE_MESSAGE' && item.content === common.content);
  assert.equal(matching.length, 1);
});


test('bulk start enables all active accounts and platforms before explicit login opening', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'platform-runtime-start-all-'));
  const dbPath = path.join(dir, 'test.db');
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['src/server.js'], { cwd: root, env: { ...process.env, PORT: String(port), DATABASE_PATH: dbPath, QWEN_MODE: 'mock', RPA_MODE: 'simulated', AUTO_COLLECT_ENABLED: 'false', LOCAL_AGENT_AUTO_START: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await Promise.race([new Promise(resolve => child.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 2000))]);
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await waitFor(base);
  const initial = (await request(base, '/api/bootstrap')).data;
  const activeCodes = initial.config.activePlatformCodes;
  for (const account of initial.accounts.filter(item => activeCodes.includes(item.platform_code))) {
    const disabled = await request(base, `/api/accounts/${account.id}/runtime`, { method: 'POST', body: JSON.stringify({ enabled: false, updatedBy: 'integration-test' }) });
    assert.equal(disabled.response.status, 200);
  }

  const started = await request(base, '/api/platforms/runtime/start-all', { method: 'POST', body: JSON.stringify({ updatedBy: 'integration-test' }) });
  assert.equal(started.response.status, 200);
  assert.equal(started.data.accounts.length, activeCodes.length);
  assert.ok(started.data.accounts.every(account => account.enabled === 1 && account.login_status === 'UNKNOWN'));
  assert.ok(started.data.platforms.filter(item => activeCodes.includes(item.code)).every(item => item.desired_state === 'RUNNING' && item.effective_state === 'RUNNING'));
  assert.equal(started.data.agentControl.reason, 'LOCAL_AGENT_AUTO_START_DISABLED');
  assert.match(started.data.message, /\u7528\u6237.*\u4e3b\u52a8.*\u6253\u5f00/);

  const startedAgain = await request(base, '/api/platforms/runtime/start-all', { method: 'POST', body: JSON.stringify({ updatedBy: 'integration-test' }) });
  assert.equal(startedAgain.response.status, 200);
  assert.ok(startedAgain.data.accounts.every(account => account.enabled === 1));
  assert.ok(startedAgain.data.platforms.filter(item => activeCodes.includes(item.code)).every(item => item.desired_state === 'RUNNING'));
  assert.equal(stderr.includes('SyntaxError'), false, stderr);
});


test('stopped platforms are hidden from publish eligibility and bulk stop keeps queued publish waiting', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-runtime-stop-all-'));
  const dbPath = path.join(dir, 'test.db');
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['src/server.js'], { cwd: root, env: { ...process.env, PORT: String(port), DATABASE_PATH: dbPath, QWEN_MODE: 'mock', RPA_MODE: 'simulated', AUTO_COLLECT_ENABLED: 'false', LOCAL_AGENT_AUTO_START: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await Promise.race([new Promise(resolve => child.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 2000))]);
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await waitFor(base);
  const bootstrap = (await request(base, '/api/bootstrap')).data;
  const account = bootstrap.accounts.find(item => item.platform_code === 'douyin');
  assert.ok(account);
  const loginSync = await request(base, `/api/accounts/${account.id}/login-state`, { method: 'POST', body: JSON.stringify({ state: 'READY', checkedAt: new Date().toISOString(), message: 'runtime-test-ready', url: 'https://creator.douyin.com/publish/publish', evidence: ['authenticated-text'] }) });
  assert.equal(loginSync.response.status, 200);
  const materialPath = path.join(dir, 'publish.png');
  await sharp({ create: { width: 1080, height: 1440, channels: 3, background: '#315f91' } }).png().toFile(materialPath);
  const title = 'Event guide';
  const content = 'Community event registration is now open. Please use the official registration page and review the event details before submitting.';
  const precheck = await precheckMaterial({ materialPath, title, body: content, platforms: ['douyin'] });
  const payload = { title, body: content, materialPath, targets: [{ platformCode: 'douyin', accountId: account.id }], precheck, complianceConfirmed: true, managementConfirmed: true, publishMode: 'AUTO' };

  const stoppedAll = await request(base, '/api/platforms/runtime/stop-all', { method: 'POST', body: JSON.stringify({ updatedBy: 'integration-test' }) });
  assert.equal(stoppedAll.response.status, 200);
  assert.equal(stoppedAll.data.platforms.length, 5);
  assert.ok(stoppedAll.data.platforms.filter(item => item.lifecycle_state === 'ACTIVE').every(item => item.desired_state === 'STOPPED' && item.effective_state === 'STOPPED')); assert.equal(stoppedAll.data.platforms.find(item => item.code === 'xiaohongshu')?.lifecycle_state, 'ACTIVE');
  assert.equal(stoppedAll.data.shutdown.queuedJobsRemainWaiting, true);
  const blockedPublish = await request(base, '/api/publish/tasks', { method: 'POST', body: JSON.stringify(payload) });
  assert.equal(blockedPublish.response.status, 409);
  assert.equal((await request(base, '/api/tasks')).data.total, 0);

  const started = await request(base, '/api/platforms/douyin/runtime', { method: 'POST', body: JSON.stringify({ enabled: true, updatedBy: 'integration-test' }) });
  assert.equal(started.response.status, 200);
  assert.equal(started.data.platform.effective_state, 'RUNNING');
  const created = await request(base, '/api/publish/tasks', { method: 'POST', body: JSON.stringify(payload) });
  assert.equal(created.response.status, 201);

  const stoppedAgain = await request(base, '/api/platforms/runtime/stop-all', { method: 'POST', body: JSON.stringify({ updatedBy: 'integration-test' }) });
  assert.equal(stoppedAgain.response.status, 200);
  const xhsRuntime = stoppedAgain.data.platforms.find(item => item.code === 'douyin');
  assert.equal(xhsRuntime.queued_job_count, 1);
  const blockedClaim = await request(base, '/api/agent/jobs/claim', { method: 'POST', body: JSON.stringify({ deviceId: account.device_id, platformCodes: ['douyin'] }) });
  assert.equal(blockedClaim.response.status, 200);
  assert.equal(blockedClaim.data.job, null);
  assert.equal(stderr.includes('SyntaxError'), false, stderr);
});


test('server ignores a collected main-account reply echo before knowledge-gap and manual notification logic', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'self-reply-echo-'));
  const dbPath = path.join(dir, 'test.db');
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: root,
    env: { ...process.env, PORT: String(port), DATABASE_PATH: dbPath, QWEN_MODE: 'mock', RPA_MODE: 'simulated', AUTO_COLLECT_ENABLED: 'false', LOCAL_AGENT_AUTO_START: 'false' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await Promise.race([new Promise(resolve => child.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 2000))]);
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await waitFor(base).catch(error => { throw new Error(`${error.message}\n${stderr}`); });
  const bootstrap = (await request(base, '/api/bootstrap')).data;
  const account = bootstrap.accounts.find(item => item.platform_code === 'wechat_channels');
  assert.ok(account);

  const sourceVideoKey = 'integration-video-echo-1';
  const viewer = await request(base, '/api/agent/messages/upsert', { method: 'POST', body: JSON.stringify({
    platformCode: 'wechat_channels', accountId: account.id, messageType: 'COMMENT', externalId: 'viewer-comment-echo-1',
    userName: '\u695a', content: '\u793e\u533a\u670d\u52a1\u4e2d\u5fc3\u51e0\u70b9\u4e0a\u73ed\uff1f',
    externalUrl: 'https://channels.weixin.qq.com/platform/interaction/comment',
    context: { sourceVideoKey, commentStableId: 'viewer-comment-stable-1', sourceVerified: true, actorUserName: '\u695a', accountUserName: '\u4e5d\u9f84\u4e4b\u9152' }
  }) });
  assert.equal(viewer.data.results[0].message.status, 'REPLY_QUEUED');
  const db = openTestDatabase(dbPath);
  const viewerRow = db.prepare("SELECT id,reply_text FROM messages WHERE external_id='viewer-comment-echo-1'").get();
  assert.ok(viewerRow.reply_text);
  const sentAt = new Date().toISOString();
  db.prepare("UPDATE messages SET status='AUTO_REPLIED',handled_at=?,handled_by='AI_RPA',updated_at=? WHERE id=?").run(sentAt, sentAt, viewerRow.id);

  const beforeNotifications = db.prepare('SELECT COUNT(*) AS count FROM notifications').get().count;
  const echo = await request(base, '/api/agent/messages/upsert', { method: 'POST', body: JSON.stringify({
    platformCode: 'wechat_channels', accountId: account.id, messageType: 'COMMENT', externalId: 'main-account-echo-1',
    userName: '\u4e5d\u9f84\u4e4b\u9152', content: viewerRow.reply_text,
    externalUrl: 'https://channels.weixin.qq.com/platform/interaction/comment',
    context: { sourceVideoKey, actorUserName: '\u4e5d\u9f84\u4e4b\u9152', accountUserName: '\u4e5d\u9f84\u4e4b\u9152' }
  }) });
  assert.equal(echo.response.status, 200);
  assert.equal(echo.data.results[0].ignoredSelf, true);
  assert.equal(echo.data.results[0].message.status, 'IGNORED_SELF');
  assert.equal(echo.data.results[0].message.decision, 'SELF_MESSAGE');
  const echoRow = db.prepare("SELECT id,status,decision FROM messages WHERE external_id='main-account-echo-1'").get();
  assert.equal(echoRow.status, 'IGNORED_SELF');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM knowledge_gaps WHERE message_id=?').get(echoRow.id).count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM notifications').get().count, beforeNotifications);
  const visible = (await request(base, '/api/messages')).data.messages;
  const visibleEcho = visible.find(item => item.external_id === 'main-account-echo-1');
  assert.equal(visibleEcho, undefined);
  db.close();
});

test('Douyin comments dedupe across changing externalIds and accept already-replied evidence', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-comment-dedupe-'));
  const dbPath = path.join(dir, 'test.db');
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: root,
    env: { ...process.env, PORT: String(port), DATABASE_PATH: dbPath, QWEN_MODE: 'mock', RPA_MODE: 'simulated', AUTO_COLLECT_ENABLED: 'false', LOCAL_AGENT_AUTO_START: 'false' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await Promise.race([new Promise(resolve => child.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 2000))]);
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await waitFor(base).catch(error => { throw new Error(`${error.message}\n${stderr}`); });

  const bootstrap = (await request(base, '/api/bootstrap')).data;
  const account = bootstrap.accounts.find(item => item.platform_code === 'douyin');
  assert.ok(account);
  const question = 'DUPLICATE-COMMENT-20260808 service center weekend hours?';
  const answer = 'The service center is open Saturday 09:00-17:00 and closed Sunday.';
  const knowledgeCreated = await request(base, '/api/knowledge', {
    method: 'POST', body: JSON.stringify({ question, answer, keywords: 'DUPLICATE-COMMENT-20260808,weekend,hours' })
  });
  assert.equal(knowledgeCreated.response.status, 201);
  const knowledgePublished = await request(base, `/api/knowledge/${knowledgeCreated.data.knowledge.id}/publish`, {
    method: 'POST', body: JSON.stringify({ reviewedBy: 'integration-test' })
  });
  assert.equal(knowledgePublished.response.status, 200);

  const common = {
    platformCode: 'douyin', accountId: account.id, messageType: 'COMMENT',
    userName: 'duplicate-user', content: question,
    externalUrl: 'https://creator.douyin.com/creator-micro/interaction/comment'
  };
  const first = await request(base, '/api/agent/messages/upsert', {
    method: 'POST', body: JSON.stringify({
      ...common, externalId: 'douyin-comment-changing-hash-1',
      context: { sourceVideoKey: 'video-A', commentStableId: 'comment-stable-A', sourceVerified: true, eventTime: '4\u5206\u949f\u524d' }
    })
  });
  assert.equal(first.response.status, 200);
  assert.equal(first.data.results[0].created, true);
  assert.equal(first.data.results[0].message.status, 'REPLY_QUEUED');

  const duplicate = await request(base, '/api/agent/messages/upsert', {
    method: 'POST', body: JSON.stringify({
      ...common, externalId: 'douyin-comment-changing-hash-2',
      context: { sourceVideoKey: 'video-A', commentStableId: 'comment-stable-A', sourceVerified: true, eventTime: '17\u5206\u949f\u524d' }
    })
  });
  assert.equal(duplicate.response.status, 200);
  assert.equal(duplicate.data.results[0].created, false);
  assert.equal(duplicate.data.results[0].message.id, first.data.results[0].message.id);

  const db = openTestDatabase(dbPath);
  const countMessages = () => db.prepare("SELECT COUNT(*) AS count FROM messages WHERE platform_code='douyin' AND account_id=? AND user_name=? AND content=?").get(account.id, common.userName, question).count;
  const replyJobs = () => db.prepare("SELECT id,status,idempotency_key,json_extract(payload,'$.messageId') AS message_id FROM agent_jobs WHERE job_type='REPLY' AND json_extract(payload,'$.platformCode')='douyin' ORDER BY id").all();
  assert.equal(countMessages(), 1);
  assert.equal(replyJobs().length, 1);

  const claimed = await request(base, '/api/agent/jobs/claim', {
    method: 'POST', body: JSON.stringify({ deviceId: account.device_id, platformCodes: ['douyin'] })
  });
  assert.equal(claimed.response.status, 200);
  assert.equal(claimed.data.job.job_type, 'REPLY');
  assert.equal(claimed.data.job.payload.messageId, first.data.results[0].message.id);
  const completed = await request(base, `/api/agent/jobs/${claimed.data.job.id}/complete`, {
    method: 'POST', body: JSON.stringify({
      status: 'SUCCESS',
      result: {
        stage: 'reply_already_replied', alreadyReplied: true, sent: false, scopedEchoCount: 1,
        evidencePath: 'logs/already-replied.json', screenshotPath: 'logs/already-replied.png',
        message: 'exact reply already exists in the target comment thread'
      }
    })
  });
  assert.equal(completed.response.status, 200);
  const completedMessage = db.prepare('SELECT status,handled_at,handled_by FROM messages WHERE id=?').get(first.data.results[0].message.id);
  assert.equal(completedMessage.status, 'AUTO_REPLIED');
  assert.ok(completedMessage.handled_at);
  assert.equal(completedMessage.handled_by, 'AI_RPA');
  assert.equal(db.prepare('SELECT status FROM agent_jobs WHERE id=?').get(claimed.data.job.id).status, 'SUCCESS');

  const otherVideo = await request(base, '/api/agent/messages/upsert', {
    method: 'POST', body: JSON.stringify({
      ...common, externalId: 'douyin-comment-video-b',
      context: { sourceVideoKey: 'video-B', commentStableId: 'comment-stable-B', sourceVerified: true, eventTime: '17\u5206\u949f\u524d' }
    })
  });
  assert.equal(otherVideo.data.results[0].created, true);
  assert.notEqual(otherVideo.data.results[0].message.id, first.data.results[0].message.id);

  const ageExisting = await request(base, '/api/agent/messages/upsert', {
    method: 'POST', body: JSON.stringify({
      ...common, externalId: 'douyin-comment-video-a-aged',
      context: { sourceVideoKey: 'video-A', commentStableId: 'comment-stable-A', sourceVerified: true, eventTime: '3\u5c0f\u65f6\u524d' }
    })
  });
  assert.equal(ageExisting.data.results[0].created, false);
  assert.equal(ageExisting.data.results[0].message.id, first.data.results[0].message.id);

  const repeated = await request(base, '/api/agent/messages/upsert', {
    method: 'POST', body: JSON.stringify({
      ...common, externalId: 'douyin-comment-video-a-repeat',
      context: { sourceVideoKey: 'video-A', commentStableId: 'comment-stable-A', sourceVerified: true, eventTime: '5\u5206\u949f\u524d' }
    })
  });
  assert.equal(repeated.data.results[0].created, false);
  assert.equal(repeated.data.results[0].message.id, first.data.results[0].message.id);
  assert.equal(repeated.data.results[0].message.external_id, 'douyin-comment-changing-hash-1');
  assert.equal(countMessages(), 2);
  const jobs = replyJobs();
  assert.equal(jobs.length, 2);
  assert.equal(new Set(jobs.map(item => item.idempotency_key)).size, 2);
  const registry = db.prepare("SELECT canonical_message_id,processing_status,seen_count,json_extract(metadata_json,'$.commentStableId') AS stable_id FROM message_processing_registry WHERE platform_code='douyin' AND account_id=? AND message_type='COMMENT' AND json_extract(metadata_json,'$.commentStableId')='comment-stable-A'").get(account.id);
  assert.equal(registry.canonical_message_id, first.data.results[0].message.id);
  assert.equal(registry.processing_status, 'AUTO_REPLIED');
  assert.ok(registry.seen_count >= 4);
  assert.equal(registry.stable_id, 'comment-stable-A');

  const supersededId = otherVideo.data.results[0].message.id;
  db.prepare("UPDATE messages SET status='SUPERSEDED',decision='DUPLICATE_PROCESSED_MESSAGE',reason='duplicate processed message',reply_job_id=NULL WHERE id=?").run(supersededId);
  const visibleAfterReconciliation = (await request(base, '/api/messages')).data.messages;
  assert.equal(visibleAfterReconciliation.some(item => item.id === supersededId), false);
  const retrySuperseded = await request(base, `/api/messages/${supersededId}/retry`, { method: 'POST', body: '{}' });
  assert.equal(retrySuperseded.response.status, 409);
  assert.match(retrySuperseded.data.message, /处理完成|归并/);
  assert.equal(stderr.includes('SyntaxError'), false, stderr);
  db.close();
});

test('Weibo official conversations stay visible but ignored and Web manual replies complete as manual handling', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'weibo-message-int-'));
  const dbPath = path.join(dir, 'test.db');
  const port = await freePort();
  const base = 'http://127.0.0.1:' + port;
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: root,
    env: { ...process.env, PORT: String(port), DATABASE_PATH: dbPath, QWEN_MODE: 'mock', RPA_MODE: 'simulated', AUTO_COLLECT_ENABLED: 'false', LOCAL_AGENT_AUTO_START: 'false' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await Promise.race([new Promise(resolve => child.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 2000))]);
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await waitFor(base);
  const bootstrap = (await request(base, '/api/bootstrap')).data;
  const account = bootstrap.accounts.find(item => item.platform_code === 'weibo');
  assert.ok(account);

  const beforeNotifications = (await request(base, '/api/settings/wecom')).data.notifications.length;
  const officialPayload = {
    platformCode: 'weibo', accountId: account.id, messageType: 'PRIVATE_MESSAGE', externalId: 'weibo-official-int-1',
    userName: '系统通知', content: '请转人工处理：您发布的视频已成功发出', externalUrl: 'https://api.weibo.com/chat/#/chat',
    context: { messageId: '4479825538150501', direction: 'incoming', sourceVerified: true, chatTitleVerified: true, previewOnly: false }
  };
  const officialUpsert = await request(base, '/api/agent/messages/upsert', { method: 'POST', body: JSON.stringify(officialPayload) });
  assert.equal(officialUpsert.response.status, 200, stderr);
  assert.equal(officialUpsert.data.results[0].ignoredOfficial, true);
  const visibleOfficial = (await request(base, '/api/messages')).data.messages.find(item => item.external_id === officialPayload.externalId);
  assert.equal(visibleOfficial.status, 'IGNORED_OFFICIAL');
  assert.equal(visibleOfficial.decision, 'OFFICIAL_MESSAGE');
  assert.equal((await request(base, '/api/settings/wecom')).data.notifications.length, beforeNotifications);

  const hotSearchPayload = {
    platformCode: 'weibo', accountId: account.id, messageType: 'PRIVATE_MESSAGE', externalId: 'weibo-hot-search-digest-int-1',
    userName: '热搜简报', content: '发来了一条链接消息 >>', externalUrl: 'https://api.weibo.com/chat/#/chat',
    context: { previewOnly: true, unreadCount: 0, sourceVerified: false, chatTitleVerified: true }
  };
  const hotSearchUpsert = await request(base, '/api/agent/messages/upsert', { method: 'POST', body: JSON.stringify(hotSearchPayload) });
  assert.equal(hotSearchUpsert.response.status, 200, stderr);
  assert.equal(hotSearchUpsert.data.results[0].ignoredOfficial, true);
  const visibleHotSearch = (await request(base, '/api/messages')).data.messages.find(item => item.external_id === hotSearchPayload.externalId);
  assert.equal(visibleHotSearch.status, 'IGNORED_OFFICIAL');
  assert.equal(visibleHotSearch.decision, 'OFFICIAL_MESSAGE');
  assert.equal((await request(base, '/api/settings/wecom')).data.notifications.length, beforeNotifications);

  const userPayload = {
    platformCode: 'weibo', accountId: account.id, messageType: 'PRIVATE_MESSAGE', externalId: 'weibo-user-int-1',
    userName: 'bob', content: '请转人工处理这个问题', externalUrl: 'https://api.weibo.com/chat/#/chat',
    context: { messageId: '4479825538150513', direction: 'incoming', sourceVerified: true, chatTitleVerified: true, previewOnly: false, historical: false }
  };
  const userUpsert = await request(base, '/api/agent/messages/upsert', { method: 'POST', body: JSON.stringify(userPayload) });
  assert.equal(userUpsert.response.status, 200, stderr);
  const message = (await request(base, '/api/messages')).data.messages.find(item => item.external_id === userPayload.externalId);
  assert.ok(message);
  assert.equal(message.status, 'MANUAL_REQUIRED');

  const submitted = await request(base, '/api/messages/' + message.id + '/manual-reply', {
    method: 'POST', body: JSON.stringify({ replyText: '您好，已由运营人员接入处理。', handledBy: '微博运营' })
  });
  assert.equal(submitted.response.status, 200, stderr);
  assert.ok(submitted.data.jobId);

  const claimed = await request(base, '/api/agent/jobs/claim', { method: 'POST', body: JSON.stringify({ deviceId: account.device_id || 'device-rpa-01' }) });
  assert.equal(claimed.response.status, 200, stderr);
  assert.equal(claimed.data.job.job_type, 'REPLY');
  assert.equal(claimed.data.job.payload.replyMode, 'MANUAL');
  assert.equal(claimed.data.job.payload.handledBy, '微博运营');

  const completed = await request(base, '/api/agent/jobs/' + claimed.data.job.id + '/complete', {
    method: 'POST',
    body: JSON.stringify({
      status: 'SUCCESS',
      result: {
        message: '微博人工回复已发送并确认', stage: 'reply_sent', sendMethod: 'ENTER',
        evidencePath: path.join(dir, 'reply-evidence.json'), screenshotPath: path.join(dir, 'reply.png'),
        targetIdentityVerified: true, uniqueTargetMatch: true, editorCleared: true, scopedEchoCount: 1, baselineEchoCount: 0
      }
    })
  });
  assert.equal(completed.response.status, 200, stderr);
  const handled = (await request(base, '/api/messages')).data.messages.find(item => item.id === message.id);
  assert.equal(handled.status, 'MANUAL_HANDLED');
  assert.equal(handled.decision, 'MANUAL_HANDLED');
  assert.equal(handled.handled_by, '微博运营');
});


test('Douyin private message queues an auto reply when the approved answer contains a phone-number field', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-private-approved-risk-word-'));
  const dbPath = path.join(dir, 'test.db');
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: root,
    env: { ...process.env, PORT: String(port), DATABASE_PATH: dbPath, QWEN_MODE: 'mock', RPA_MODE: 'simulated', AUTO_COLLECT_ENABLED: 'false', LOCAL_AGENT_AUTO_START: 'false' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await Promise.race([new Promise(resolve => child.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 2000))]);
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await waitFor(base).catch(error => { throw new Error(`${error.message}\n${stderr}`); });

  const bootstrap = (await request(base, '/api/bootstrap')).data;
  const account = bootstrap.accounts.find(item => item.platform_code === 'douyin');
  assert.ok(account);
  const question = '活动报名后,可以取消或更换参加人吗?';
  const answer = '可以。如需取消,请在活动开始前24小时联系工作人员;更换参加人时,请提供新的姓名、手机号。';
  const created = await request(base, '/api/knowledge', {
    method: 'POST',
    body: JSON.stringify({
      question, answer, keywords: '取消报名,更换人员',
      category: '抖音知识库', subcategory: '报名变更'
    })
  });
  assert.equal(created.response.status, 201, JSON.stringify(created.data));
  const knowledgeId = created.data.knowledge.id;
  const published = await request(base, `/api/knowledge/${knowledgeId}/publish`, {
    method: 'POST', body: JSON.stringify({ reviewedBy: 'integration-test' })
  });
  assert.equal(published.response.status, 200, JSON.stringify(published.data));

  const externalId = 'douyin-private-registration-change-regression-1';
  const upserted = await request(base, '/api/agent/messages/upsert', {
    method: 'POST',
    body: JSON.stringify({
      platformCode: 'douyin', accountId: account.id, messageType: 'PRIVATE_MESSAGE', externalId,
      userName: '咖啡不嘉🧊', content: question, externalUrl: 'https://www.douyin.com/user/self',
      context: { conversationId: 'conversation-registration-change-1', messageId: 'message-registration-change-1', direction: 'incoming', conversationName: '咖啡不嘉🧊', inboxType: 'MAIN', previewOnly: false, unreadCount: 1, sourceVerified: true, chatTitleVerified: true }
    })
  });
  assert.equal(upserted.response.status, 200, JSON.stringify(upserted.data));
  const message = upserted.data.results[0].message;
  assert.equal(message.status, 'REPLY_QUEUED');
  assert.equal(message.decision, 'AUTO_REPLY');
  assert.equal(message.knowledge_id, knowledgeId);
  assert.equal(message.reply_text, answer);
  assert.ok(message.reply_job_id);

  const db = openTestDatabase(dbPath, { readOnly: true });
  const replyJob = db.prepare("SELECT id,status,job_type,json_extract(payload,'$.replyText') AS reply_text FROM agent_jobs WHERE id=?").get(message.reply_job_id);
  assert.equal(replyJob.job_type, 'REPLY');
  assert.equal(replyJob.status, 'QUEUED');
  assert.equal(replyJob.reply_text, answer);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM issues WHERE related_type='MESSAGE' AND related_id=?").get(String(message.id)).count, 0);
  db.close();
});

test('submit lock permanently prevents automatic repost and allows read-only reconciliation', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-submit-lock-'));
  const dbPath = path.join(dir, 'test.db');
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['src/server.js'], { cwd: root, env: { ...process.env, PORT: String(port), DATABASE_PATH: dbPath, QWEN_MODE: 'mock', RPA_MODE: 'simulated', AUTO_COLLECT_ENABLED: 'false', LOCAL_AGENT_AUTO_START: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await Promise.race([new Promise(resolve => child.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 2000))]);
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await waitFor(base);
  const db = openTestDatabase(dbPath);
  const account = db.prepare("SELECT * FROM accounts WHERE platform_code='bilibili' LIMIT 1").get();
  assert.ok(account);
  const stamp = new Date().toISOString();
  const taskId = Number(db.prepare("INSERT INTO publish_tasks(title,body,material_path,status,created_at,updated_at) VALUES(?,?,?,'EXECUTING',?,?)").run('submit-lock-test', 'body', 'D:/material/lock.mp4', stamp, stamp).lastInsertRowid);
  const targetId = Number(db.prepare("INSERT INTO publish_targets(task_id,platform_code,account_id,status,submission_status,review_status,publish_attempt_state,submit_lock,updated_at) VALUES(?,'bilibili',?,'RUNNING','NOT_SUBMITTED','UNKNOWN','NOT_ATTEMPTED','UNLOCKED',?)").run(taskId, account.id, stamp).lastInsertRowid);
  const fingerprint = { version: 1, taskId, targetId, title: 'submit-lock-test', materialSha256: 'abc', durationSeconds: 15, createdAt: stamp, accountId: account.id, platformCode: 'bilibili', fingerprintHash: 'fingerprint-lock-test' };
  db.prepare('UPDATE publish_targets SET draft_fingerprint=? WHERE id=?').run(JSON.stringify(fingerprint), targetId);

  const lockPayload = { deviceId: account.device_id, taskId, targetId, accountId: account.id, platformCode: 'bilibili', draftFingerprint: fingerprint, reason: 'TEST_FINAL_CLICK' };
  const acquired = await request(base, `/api/agent/publish-targets/${targetId}/acquire-submit-lock`, { method: 'POST', body: JSON.stringify(lockPayload) });
  assert.equal(acquired.response.status, 200, JSON.stringify(acquired.data));
  assert.equal(acquired.data.authorized, true);
  assert.equal(acquired.data.submitLock, 'LOCKED');
  assert.equal(acquired.data.submitAttemptCount, 1);

  const duplicate = await request(base, `/api/agent/publish-targets/${targetId}/acquire-submit-lock`, { method: 'POST', body: JSON.stringify(lockPayload) });
  assert.equal(duplicate.response.status, 409);
  assert.equal(duplicate.data.detail.code, 'SUBMIT_ALREADY_LOCKED');

  const queuedJobId = Number(db.prepare("INSERT INTO agent_jobs(device_id,job_type,payload,status,created_at,available_at) VALUES(?,'PUBLISH',?,'QUEUED',?,?)").run(account.device_id, JSON.stringify({ taskId, targetId, platformCode: 'bilibili', accountId: account.id }), stamp, stamp).lastInsertRowid);
  const claim = await request(base, '/api/agent/jobs/claim', { method: 'POST', body: JSON.stringify({ deviceId: account.device_id, platformCodes: ['bilibili'] }) });
  assert.equal(claim.response.status, 200);
  assert.equal(claim.data.job, null);
  assert.equal(db.prepare('SELECT status FROM agent_jobs WHERE id=?').get(queuedJobId).status, 'NEEDS_CONFIRMATION');

  const uncertainResult = {
    platformCode: 'bilibili',
    verificationPolicyId: 'bilibili-publish-status-v1',
    stage: 'publish_unconfirmed',
    submitAttempted: true,
    finalActionAuthorized: true,
    submissionStatus: 'UNKNOWN',
    reviewStatus: 'UNKNOWN',
    message: 'submission result is uncertain'
  };
  const uncertain = await request(base, `/api/agent/publish-targets/${targetId}/record-submit-result`, { method: 'POST', body: JSON.stringify({ status: 'NEEDS_CONFIRMATION', result: uncertainResult }) });
  assert.equal(uncertain.response.status, 200, JSON.stringify(uncertain.data));
  let target = db.prepare('SELECT * FROM publish_targets WHERE id=?').get(targetId);
  assert.equal(target.status, 'NEEDS_CONFIRMATION');
  assert.equal(target.publish_attempt_state, 'SUBMIT_ATTEMPTED_UNCONFIRMED');
  assert.equal(target.submit_lock, 'LOCKED');
  assert.equal(target.submit_attempt_count, 1);

  let automaticVerifyJobs = db.prepare("SELECT * FROM agent_jobs WHERE job_type='VERIFY_PUBLISH' AND CAST(json_extract(payload,'$.targetId') AS INTEGER)=? ORDER BY id").all(targetId);
  assert.equal(automaticVerifyJobs.length, 1);
  const automaticVerifyPayload = JSON.parse(automaticVerifyJobs[0].payload);
  assert.equal(automaticVerifyPayload.taskId, taskId);
  assert.equal(automaticVerifyPayload.targetId, targetId);
  assert.equal(automaticVerifyPayload.platformCode, 'bilibili');
  assert.equal(automaticVerifyPayload.accountId, account.id);
  assert.equal(automaticVerifyPayload.verificationPolicyId, 'bilibili-publish-status-v1');
  assert.equal(automaticVerifyPayload.verificationSource, 'AUTOMATIC_UNCONFIRMED_SUBMIT');
  assert.equal(automaticVerifyPayload.submissionStatus, 'UNKNOWN');
  assert.equal(automaticVerifyPayload.submissionConfirmed, false);
  assert.equal(automaticVerifyPayload.reviewAttempt, 0);
  const initialVerifyDelayMs = Date.parse(automaticVerifyJobs[0].available_at) - Date.parse(target.submit_attempted_at);
  assert.ok(initialVerifyDelayMs >= 119_000 && initialVerifyDelayMs <= 121_000, String(initialVerifyDelayMs));
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM agent_jobs WHERE job_type='PUBLISH' AND CAST(json_extract(payload,'$.targetId') AS INTEGER)=?").get(targetId).count, 1);

  const duplicateUncertain = await request(base, `/api/agent/publish-targets/${targetId}/record-submit-result`, { method: 'POST', body: JSON.stringify({ status: 'NEEDS_CONFIRMATION', result: uncertainResult }) });
  assert.equal(duplicateUncertain.response.status, 200, JSON.stringify(duplicateUncertain.data));
  automaticVerifyJobs = db.prepare("SELECT * FROM agent_jobs WHERE job_type='VERIFY_PUBLISH' AND CAST(json_extract(payload,'$.targetId') AS INTEGER)=? ORDER BY id").all(targetId);
  assert.equal(automaticVerifyJobs.length, 1);

  const beforeIsolation = db.prepare('SELECT status,review_status,result FROM publish_targets WHERE id=?').get(targetId);
  const crossedResult = await request(base, `/api/agent/publish-targets/${targetId}/record-submit-result`, {
    method: 'POST',
    body: JSON.stringify({
      status: 'SUCCESS',
      result: {
        platformCode: 'douyin',
        verificationPolicyId: 'douyin-publish-status-v1',
        stage: 'verify_published',
        reviewStatus: 'PUBLISHED',
        matchedTab: '已发布',
        platformUrl: 'https://creator.douyin.com/creator-micro/content/manage',
        message: 'wrong platform evidence must be rejected'
      }
    })
  });
  assert.equal(crossedResult.response.status, 200, JSON.stringify(crossedResult.data));
  const afterIsolation = db.prepare('SELECT status,review_status,result FROM publish_targets WHERE id=?').get(targetId);
  assert.deepEqual(afterIsolation, beforeIsolation);
  const isolationIssue = db.prepare("SELECT * FROM issues WHERE source='PUBLISH_GUARD' AND category='PUBLISH_PLATFORM_ISOLATION' AND related_type='PUBLISH_TARGET' AND related_id=? ORDER BY id DESC LIMIT 1").get(String(targetId));
  assert.ok(isolationIssue);
  assert.match(isolationIssue.detail, /RESULT_PLATFORM_MISMATCH/);

  const reconciled = await request(base, `/api/publish/targets/${targetId}/review`, { method: 'POST', body: JSON.stringify({ reviewStatus: 'PUBLISHED', platformPostId: 'BV1LockTest01', platformUrl: 'https://www.bilibili.com/video/BV1LockTest01/' }) });
  assert.equal(reconciled.response.status, 200);
  target = db.prepare('SELECT * FROM publish_targets WHERE id=?').get(targetId);
  assert.equal(target.status, 'PUBLISHED');
  assert.equal(target.submission_status, 'SUBMITTED');
  assert.equal(target.publish_attempt_state, 'PUBLISHED');
  assert.equal(target.submit_lock, 'LOCKED');

  const uploadFailureTaskId = Number(db.prepare("INSERT INTO publish_tasks(title,body,material_path,status,created_at,updated_at) VALUES(?,?,?,'EXECUTING',?,?)").run('upload-failure-test', 'body', 'D:/material/upload-failure.mp4', stamp, stamp).lastInsertRowid);
  const uploadFailureTargetId = Number(db.prepare("INSERT INTO publish_targets(task_id,platform_code,account_id,status,submission_status,review_status,publish_attempt_state,submit_lock,updated_at) VALUES(?,'bilibili',?,'RUNNING','NOT_SUBMITTED','UNKNOWN','NOT_ATTEMPTED','UNLOCKED',?)").run(uploadFailureTaskId, account.id, stamp).lastInsertRowid);
  const uploadFailureFingerprint = { version: 1, taskId: uploadFailureTaskId, targetId: uploadFailureTargetId, title: 'upload-failure-test', materialSha256: 'upload-failure', durationSeconds: 15, createdAt: stamp, accountId: account.id, platformCode: 'bilibili', fingerprintHash: 'fingerprint-upload-failure-test' };
  db.prepare('UPDATE publish_targets SET draft_fingerprint=? WHERE id=?').run(JSON.stringify(uploadFailureFingerprint), uploadFailureTargetId);
  const uploadFailureLock = await request(base, `/api/agent/publish-targets/${uploadFailureTargetId}/acquire-submit-lock`, { method: 'POST', body: JSON.stringify({ deviceId: account.device_id, taskId: uploadFailureTaskId, targetId: uploadFailureTargetId, accountId: account.id, platformCode: 'bilibili', draftFingerprint: uploadFailureFingerprint, reason: 'TEST_UPLOAD_FAILURE' }) });
  assert.equal(uploadFailureLock.response.status, 200, JSON.stringify(uploadFailureLock.data));
  const uploadFailureRecorded = await request(base, `/api/agent/publish-targets/${uploadFailureTargetId}/record-submit-result`, {
    method: 'POST',
    body: JSON.stringify({ status: 'FAILED', result: { stage: 'upload_failed', uploadFailed: true, platformState: 'UPLOAD_FAILED', errorCode: 'PLATFORM_UPLOAD_FAILED', submitAttempted: false, submissionStatus: 'NOT_SUBMITTED', retrySafe: true, message: '视频尚未提交平台：上传过程中出现网络异常' } })
  });
  assert.equal(uploadFailureRecorded.response.status, 200, JSON.stringify(uploadFailureRecorded.data));
  const uploadFailureTarget = db.prepare('SELECT * FROM publish_targets WHERE id=?').get(uploadFailureTargetId);
  assert.equal(uploadFailureTarget.status, 'FAILED');
  assert.equal(uploadFailureTarget.submission_status, 'NOT_SUBMITTED');
  assert.equal(uploadFailureTarget.review_status, 'UNKNOWN');
  assert.equal(uploadFailureTarget.publish_attempt_state, 'UPLOAD_FAILED');
  assert.equal(uploadFailureTarget.submit_lock, 'UNLOCKED');
  assert.equal(uploadFailureTarget.submit_attempted_at, null);
  assert.equal(uploadFailureTarget.submit_attempt_count, 0);
  assert.equal(JSON.parse(uploadFailureTarget.result).manualActionRequired, false);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM agent_jobs WHERE job_type='VERIFY_PUBLISH' AND CAST(json_extract(payload,'$.targetId') AS INTEGER)=?").get(uploadFailureTargetId).count, 0);

  const uploadNotStartedTaskId = Number(db.prepare("INSERT INTO publish_tasks(title,body,material_path,status,created_at,updated_at) VALUES(?,?,?,'EXECUTING',?,?)").run('upload-not-started-test', 'body', 'D:/material/upload-not-started.mp4', stamp, stamp).lastInsertRowid);
  const uploadNotStartedTargetId = Number(db.prepare("INSERT INTO publish_targets(task_id,platform_code,account_id,status,submission_status,review_status,publish_attempt_state,submit_lock,updated_at) VALUES(?,'bilibili',?,'RUNNING','NOT_SUBMITTED','UNKNOWN','NOT_ATTEMPTED','UNLOCKED',?)").run(uploadNotStartedTaskId, account.id, stamp).lastInsertRowid);
  const uploadNotStartedFingerprint = { version: 1, taskId: uploadNotStartedTaskId, targetId: uploadNotStartedTargetId, title: 'upload-not-started-test', materialSha256: 'upload-not-started', durationSeconds: 15, createdAt: stamp, accountId: account.id, platformCode: 'bilibili', fingerprintHash: 'fingerprint-upload-not-started-test' };
  db.prepare('UPDATE publish_targets SET draft_fingerprint=? WHERE id=?').run(JSON.stringify(uploadNotStartedFingerprint), uploadNotStartedTargetId);
  const uploadNotStartedLock = await request(base, `/api/agent/publish-targets/${uploadNotStartedTargetId}/acquire-submit-lock`, { method: 'POST', body: JSON.stringify({ deviceId: account.device_id, taskId: uploadNotStartedTaskId, targetId: uploadNotStartedTargetId, accountId: account.id, platformCode: 'bilibili', draftFingerprint: uploadNotStartedFingerprint, reason: 'TEST_UPLOAD_NOT_STARTED' }) });
  assert.equal(uploadNotStartedLock.response.status, 200, JSON.stringify(uploadNotStartedLock.data));
  const uploadNotStartedRecorded = await request(base, `/api/agent/publish-targets/${uploadNotStartedTargetId}/record-submit-result`, {
    method: 'POST',
    body: JSON.stringify({ status: 'FAILED', result: { stage: 'upload_not_started', errorCode: 'MATERIAL_UPLOAD_NOT_STARTED', submitAttempted: false, submissionStatus: 'NOT_SUBMITTED', uploadMayHaveStarted: false, uploadDefinitelyNotStarted: true, retrySafe: true, safeToRetry: true, message: '文件选择动作已执行，但平台上传未启动' } })
  });
  assert.equal(uploadNotStartedRecorded.response.status, 200, JSON.stringify(uploadNotStartedRecorded.data));
  const uploadNotStartedTarget = db.prepare('SELECT * FROM publish_targets WHERE id=?').get(uploadNotStartedTargetId);
  assert.equal(uploadNotStartedTarget.status, 'FAILED');
  assert.equal(uploadNotStartedTarget.submission_status, 'NOT_SUBMITTED');
  assert.equal(uploadNotStartedTarget.publish_attempt_state, 'UPLOAD_NOT_STARTED');
  assert.equal(uploadNotStartedTarget.submit_lock, 'UNLOCKED');
  assert.equal(uploadNotStartedTarget.submit_attempted_at, null);
  assert.equal(uploadNotStartedTarget.submit_attempt_count, 0);
  assert.equal(JSON.parse(uploadNotStartedTarget.result).manualActionRequired, false);
  assert.equal(JSON.parse(uploadNotStartedTarget.result).safeToRetry, true);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM agent_jobs WHERE job_type='VERIFY_PUBLISH' AND CAST(json_extract(payload,'$.targetId') AS INTEGER)=?").get(uploadNotStartedTargetId).count, 0);

  const reconciledTaskId = Number(db.prepare("INSERT INTO publish_tasks(title,body,material_path,status,created_at,updated_at) VALUES(?,?,?,'EXECUTING',?,?)").run('management-reconcile-test', 'body', 'D:/material/reconcile.mp4', stamp, stamp).lastInsertRowid);
  const reconciledTargetId = Number(db.prepare("INSERT INTO publish_targets(task_id,platform_code,account_id,status,submission_status,review_status,publish_attempt_state,submit_lock,updated_at) VALUES(?,'bilibili',?,'RUNNING','NOT_SUBMITTED','UNKNOWN','NOT_ATTEMPTED','UNLOCKED',?)").run(reconciledTaskId, account.id, stamp).lastInsertRowid);
  const reconciledFingerprint = { version: 1, taskId: reconciledTaskId, targetId: reconciledTargetId, title: 'management-reconcile-test', materialSha256: 'def', durationSeconds: 15, createdAt: stamp, accountId: account.id, platformCode: 'bilibili', fingerprintHash: 'fingerprint-reconcile-test' };
  db.prepare('UPDATE publish_targets SET draft_fingerprint=? WHERE id=?').run(JSON.stringify(reconciledFingerprint), reconciledTargetId);
  const platformSubmittedAt = new Date(Date.now() - 30_000).toISOString();
  const managementReconciled = await request(base, `/api/agent/publish-targets/${reconciledTargetId}/record-submit-result`, {
    method: 'POST',
    body: JSON.stringify({
      status: 'SUCCESS',
      draftFingerprint: reconciledFingerprint,
      result: {
        stage: 'management_precheck_reconciled',
        reconciledBeforeSubmit: true,
        submitAttempted: false,
        submissionStatus: 'SUBMITTED',
        reviewStatus: 'PUBLISHED',
        submittedAt: platformSubmittedAt,
        platformPostId: 'BV1Reconcile1',
        platformUrl: 'https://www.bilibili.com/video/BV1Reconcile1/'
      }
    })
  });
  assert.equal(managementReconciled.response.status, 200, JSON.stringify(managementReconciled.data));
  let reconciledTarget = db.prepare('SELECT * FROM publish_targets WHERE id=?').get(reconciledTargetId);
  assert.equal(reconciledTarget.status, 'PUBLISHED');
  assert.equal(reconciledTarget.submission_status, 'SUBMITTED');
  assert.equal(reconciledTarget.submit_lock, 'LOCKED');
  assert.equal(reconciledTarget.submit_authorized_at, null);
  assert.equal(reconciledTarget.submit_attempted_at, platformSubmittedAt);

  const staleQueuedJobId = Number(db.prepare("INSERT INTO agent_jobs(device_id,job_type,payload,status,created_at,available_at) VALUES(?,'PUBLISH',?,'QUEUED',?,?)").run(account.device_id, JSON.stringify({ taskId: reconciledTaskId, targetId: reconciledTargetId, platformCode: 'bilibili', accountId: account.id }), stamp, stamp).lastInsertRowid);
  const guardedClaim = await request(base, '/api/agent/jobs/claim', { method: 'POST', body: JSON.stringify({ deviceId: account.device_id, platformCodes: ['bilibili'] }) });
  assert.equal(guardedClaim.response.status, 200);
  assert.equal(db.prepare('SELECT status FROM agent_jobs WHERE id=?').get(staleQueuedJobId).status, 'NEEDS_CONFIRMATION');
  reconciledTarget = db.prepare('SELECT * FROM publish_targets WHERE id=?').get(reconciledTargetId);
  assert.equal(reconciledTarget.status, 'PUBLISHED');
  assert.equal(reconciledTarget.publish_attempt_state, 'PUBLISHED');

  const manualTaskId = Number(db.prepare("INSERT INTO publish_tasks(title,body,material_path,status,created_at,updated_at) VALUES(?,?,?,'EXECUTING',?,?)").run('manual-fallback-test', 'body', 'D:/material/manual.mp4', stamp, stamp).lastInsertRowid);
  const manualTargetId = Number(db.prepare("INSERT INTO publish_targets(task_id,platform_code,account_id,status,submission_status,review_status,publish_attempt_state,submit_lock,result,updated_at) VALUES(?,'bilibili',?,'NEEDS_CONFIRMATION','NOT_SUBMITTED','UNKNOWN','DRAFT_BLOCKED','UNLOCKED',?,?)").run(manualTaskId, account.id, JSON.stringify({ manualActionRequired: true, draftPreservedInBrowser: true, message: 'draft preserved' }), stamp).lastInsertRowid);
  const manualFingerprint = { version: 1, taskId: manualTaskId, targetId: manualTargetId, title: 'manual-fallback-test', materialSha256: 'manual', durationSeconds: 15, createdAt: stamp, accountId: account.id, platformCode: 'bilibili', fingerprintHash: 'fingerprint-manual-test' };
  db.prepare('UPDATE publish_targets SET draft_fingerprint=? WHERE id=?').run(JSON.stringify(manualFingerprint), manualTargetId);
  const queuedManualPublishId = Number(db.prepare("INSERT INTO agent_jobs(device_id,job_type,payload,status,created_at,available_at) VALUES(?,'PUBLISH',?,'QUEUED',?,?)").run(account.device_id, JSON.stringify({ taskId: manualTaskId, targetId: manualTargetId, platformCode: 'bilibili', accountId: account.id }), stamp, stamp).lastInsertRowid);
  const queuedManualVerifyId = Number(db.prepare("INSERT INTO agent_jobs(device_id,job_type,payload,status,created_at,available_at) VALUES(?,'VERIFY_PUBLISH',?,'QUEUED',?,?)").run(account.device_id, JSON.stringify({ taskId: manualTaskId, targetId: manualTargetId, platformCode: 'bilibili', accountId: account.id }), stamp, stamp).lastInsertRowid);

  const manualPublished = await request(base, `/api/publish/targets/${manualTargetId}/manual-published`, { method: 'POST', body: JSON.stringify({ handledBy: 'integration-operator' }) });
  assert.equal(manualPublished.response.status, 200, JSON.stringify(manualPublished.data));
  const manualTarget = db.prepare('SELECT * FROM publish_targets WHERE id=?').get(manualTargetId);
  assert.equal(manualTarget.status, 'PUBLISHED');
  assert.equal(manualTarget.submission_status, 'SUBMITTED');
  assert.equal(manualTarget.review_status, 'PUBLISHED');
  assert.equal(manualTarget.publish_attempt_state, 'PUBLISHED');
  assert.equal(manualTarget.submit_lock, 'LOCKED');
  assert.ok(Number(manualTarget.submit_attempt_count) >= 1);
  assert.equal(manualTarget.submit_lock_reason, 'MANUAL_PLATFORM_PUBLISH_CONFIRMED');
  assert.equal(JSON.parse(manualTarget.result).manuallyConfirmed, true);
  assert.equal(db.prepare('SELECT status FROM agent_jobs WHERE id=?').get(queuedManualPublishId).status, 'CANCELLED');
  assert.equal(db.prepare('SELECT status FROM agent_jobs WHERE id=?').get(queuedManualVerifyId).status, 'CANCELLED');
  assert.equal(db.prepare('SELECT status FROM publish_tasks WHERE id=?').get(manualTaskId).status, 'PUBLISHED');

  const blockedManualRetry = await request(base, `/api/agent/publish-targets/${manualTargetId}/acquire-submit-lock`, { method: 'POST', body: JSON.stringify({ deviceId: account.device_id, taskId: manualTaskId, targetId: manualTargetId, accountId: account.id, platformCode: 'bilibili', draftFingerprint: manualFingerprint, reason: 'MUST_NOT_REPOST' }) });
  assert.equal(blockedManualRetry.response.status, 409);
  assert.equal(blockedManualRetry.data.detail.code, 'SUBMIT_ALREADY_LOCKED');

  const staleReview = await request(base, `/api/publish/targets/${manualTargetId}/review`, { method: 'POST', body: JSON.stringify({ reviewStatus: 'UNKNOWN', message: 'stale automated review' }) });
  assert.equal(staleReview.response.status, 200);
  assert.equal(db.prepare('SELECT status FROM publish_targets WHERE id=?').get(manualTargetId).status, 'PUBLISHED');

  assert.equal(stderr.includes('SyntaxError'), false, stderr);
  db.close();
});



test('material preview capability URL streams media without exposing the shared Agent token', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'material-preview-capability-'));
  const materialPath = path.join(dir, 'preview.png');
  await sharp({ create: { width: 32, height: 24, channels: 3, background: { r: 12, g: 34, b: 56 } } }).png().toFile(materialPath);
  const cloudStub = await startRuntimeStub({ masterSwitch: { enabled: true }, platforms: [] });
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const origin = 'http://127.0.0.1:3100';
  const agentToken = 'material-preview-test-token';
  const child = spawn(process.execPath, ['agent/local-agent.js'], {
    cwd: root,
    env: {
      ...process.env,
      AGENT_PORT: String(port),
      CLOUD_BASE_URL: cloudStub.base,
      AGENT_SHARED_TOKEN: agentToken,
      AGENT_ALLOWED_ORIGINS: origin,
      RPA_MODE: 'simulated',
      QWEN_MODE: 'mock',
      LOGIN_STATUS_POLL_ENABLED: 'false',
      AGENT_POLL_MS: '1000'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await Promise.race([new Promise(resolve => child.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 2000))]);
    }
    await closeServer(cloudStub.server);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await waitForAgent(base);
  const precheck = await request(base, '/precheck', {
    method: 'POST',
    headers: { 'X-Agent-Token': agentToken, Origin: origin },
    body: JSON.stringify({ materialPath, platforms: [] })
  });
  assert.equal(precheck.response.status, 200, JSON.stringify(precheck.data));
  assert.equal(precheck.data.precheck.meta.type, 'image');
  assert.match(precheck.data.previewUrl, /^\/material-preview\/[0-9a-f-]+$/i);

  const materialBytes = fs.readFileSync(materialPath);
  const preview = await fetch(base + precheck.data.previewUrl, { headers: { Origin: origin } });
  assert.equal(preview.status, 200);
  assert.equal(preview.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await preview.arrayBuffer()), materialBytes);

  const firstRange = await fetch(base + precheck.data.previewUrl, { headers: { Origin: origin, Range: 'bytes=0-15' } });
  assert.equal(firstRange.status, 206);
  assert.equal(firstRange.headers.get('content-range'), `bytes 0-15/${materialBytes.length}`);
  assert.deepEqual(Buffer.from(await firstRange.arrayBuffer()), materialBytes.subarray(0, 16));

  const suffixRange = await fetch(base + precheck.data.previewUrl, { headers: { Origin: origin, Range: 'bytes=-16' } });
  assert.equal(suffixRange.status, 206);
  assert.equal(suffixRange.headers.get('content-range'), `bytes ${materialBytes.length - 16}-${materialBytes.length - 1}/${materialBytes.length}`);
  assert.deepEqual(Buffer.from(await suffixRange.arrayBuffer()), materialBytes.subarray(-16));

  const previewHead = await fetch(base + precheck.data.previewUrl, { method: 'HEAD', headers: { Origin: origin } });
  assert.equal(previewHead.status, 200);
  assert.equal(previewHead.headers.get('content-type'), 'image/png');
  assert.equal(Number(previewHead.headers.get('content-length')), materialBytes.length);
  assert.equal((await previewHead.arrayBuffer()).byteLength, 0);

  const invalidPreview = await fetch(`${base}/material-preview/00000000-0000-0000-0000-000000000000`, { headers: { Origin: origin } });
  assert.equal(invalidPreview.status, 404);
  const protectedApi = await fetch(`${base}/platforms/status`, { headers: { Origin: origin } });
  assert.equal(protectedApi.status, 401);
  assert.equal((await protectedApi.json()).code, 'AGENT_AUTH_REQUIRED');
  const deniedOrigin = await fetch(base + precheck.data.previewUrl, { headers: { Origin: 'https://evil.example' } });
  assert.equal(deniedOrigin.status, 403);
  assert.equal(stderr.includes('SyntaxError'), false, stderr);
});

test('历史稿件评论采集候选不会截断最近 20 条', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'historical-comment-candidates-'));
  const dbPath = path.join(dir, 'test.db');
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      DATABASE_PATH: dbPath,
      QWEN_MODE: 'mock',
      RPA_MODE: 'simulated',
      AUTO_COLLECT_ENABLED: 'false',
      LOCAL_AGENT_AUTO_START: 'false'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stderr = '';
  let db = null;
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  t.after(async () => {
    db?.close();
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await Promise.race([
        new Promise(resolve => child.once('exit', resolve)),
        new Promise(resolve => setTimeout(resolve, 2000))
      ]);
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await waitFor(base);
  db = openTestDatabase(dbPath);
  const account = db.prepare("SELECT * FROM accounts WHERE platform_code='douyin' LIMIT 1").get();
  assert.ok(account);
  db.prepare("UPDATE accounts SET enabled=1,login_status='READY' WHERE id=?").run(account.id);
  db.prepare("UPDATE platforms SET desired_state='RUNNING',lifecycle_state='ACTIVE',smoke_gate_state='CLEAR' WHERE code='douyin'").run();
  db.exec('DELETE FROM publish_targets; DELETE FROM publish_tasks;');

  const insertTask = db.prepare("INSERT INTO publish_tasks(title,body,material_path,status,created_at,updated_at) VALUES(?,?,?,'PUBLISHED',?,?)");
  const insertTarget = db.prepare("INSERT INTO publish_targets(task_id,platform_code,account_id,status,submission_status,review_status,platform_post_id,platform_url,submitted_at,reviewed_at,updated_at) VALUES(?,'douyin',?,'PUBLISHED','SUBMITTED','PUBLISHED',?,?,?,?,?)");
  for (let index = 1; index <= 25; index += 1) {
    const suffix = String(index).padStart(2, '0');
    const stamp = new Date(Date.now() - ((26 - index) * 60_000)).toISOString();
    const taskId = Number(insertTask.run(
      `history-title-${suffix}`,
      `history-body-${suffix}`,
      `D:/material/history-${suffix}.mp4`,
      stamp,
      stamp
    ).lastInsertRowid);
    insertTarget.run(
      taskId,
      account.id,
      `history-post-${suffix}`,
      `https://www.douyin.com/video/history-post-${suffix}`,
      stamp,
      stamp,
      stamp
    );
  }

  const indexRow = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_targets_message_candidates'").get();
  assert.equal(indexRow?.name, 'idx_targets_message_candidates');

  const queued = await request(base, '/api/platforms/douyin/collect', {
    method: 'POST',
    body: JSON.stringify({ accountId: account.id, types: ['COMMENT'] })
  });
  assert.equal(queued.response.status, 200, JSON.stringify(queued.data));
  const jobRow = db.prepare('SELECT payload FROM agent_jobs WHERE id=?').get(queued.data.jobId);
  assert.ok(jobRow);
  const payload = JSON.parse(jobRow.payload);
  assert.equal(payload.noteCandidates.length, 25);
  assert.equal(payload.noteCandidates[0].platformPostId, 'history-post-25');
  assert.equal(payload.noteCandidates.at(-1).platformPostId, 'history-post-01');
  assert.ok(payload.noteCandidates.some(item => item.platformPostId === 'history-post-01'));
  assert.equal(stderr.includes('SyntaxError'), false, stderr);
});

test('Web control loss stops the local Agent and clears login polling', async t => {
  const platforms = [{ code: 'douyin', name: 'douyin', sort_order: 1, desired_state: 'RUNNING', effective_state: 'RUNNING', enabled_account_count: 1, ready_account_count: 0, queued_job_count: 0, running_job_count: 0, blocked_reason: null }];
  const cloudStub = await startRuntimeStub(platforms);
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['agent/local-agent.js'], {
    cwd: root,
    env: {
      ...process.env,
      AGENT_PORT: String(port),
      CLOUD_BASE_URL: cloudStub.base,
      AGENT_POLL_MS: '50',
      AGENT_CLOUD_FAILURE_SHUTDOWN_THRESHOLD: '3',
      INSTANCE_LOCK_ENABLED: 'false',
      RPA_MODE: 'simulated',
      QWEN_MODE: 'mock'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk.toString(); });
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await Promise.race([new Promise(resolve => child.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 2000))]);
    }
    await closeServer(cloudStub.server);
  });

  await waitForAgent(base);
  const opened = await request(base, '/platforms/douyin/open-login', { method: 'POST', body: '{}' });
  assert.equal(opened.response.status, 200);
  const monitor = await request(base, '/platforms/login-monitor/status');
  assert.deepEqual(monitor.data.loginMonitor.monitoredPlatformCodes, ['douyin']);
  assert.ok(monitor.data.loginMonitor.nextPollAt);

  await closeServer(cloudStub.server);
  const exit = await Promise.race([
    new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal }))),
    new Promise((_, reject) => setTimeout(() => reject(new Error(`Agent did not stop after Web loss. stdout=${stdout} stderr=${stderr}`)), 5000))
  ]);
  await waitForAgentOffline(base);
  assert.equal(exit.signal, null);
  assert.equal(exit.code, 0);
  assert.match(stdout, /Received CLOUD_WEB_UNREACHABLE/);
  assert.match(stderr, /Web control connection failed 3\/3/);
});



test('知识库上传预览按平台安全字数拦截，B站私信按官网 500 减 20 和 UTF-16 处理', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-length-int-'));
  const dbPath = path.join(dir, 'test.db');
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['src/server.js'], { cwd: root, env: { ...process.env, PORT: String(port), DATABASE_PATH: dbPath, QWEN_MODE: 'mock', RPA_MODE: 'simulated', AUTO_COLLECT_ENABLED: 'false', LOCAL_AGENT_AUTO_START: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await Promise.race([new Promise(resolve => child.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 2000))]);
    }
  });
  await waitFor(base);

  const categories = await request(base, '/api/knowledge/categories');
  assert.equal(categories.response.status, 200);
  assert.equal(categories.data.replyLimits.bilibili.PRIVATE_MESSAGE.publishedMax, 500);
  assert.equal(categories.data.replyLimits.bilibili.PRIVATE_MESSAGE.safeMax, 480);
  assert.equal(categories.data.replyLimits.bilibili.PRIVATE_MESSAGE.sourceType, 'OFFICIAL_WEB');
  assert.equal(categories.data.replyLimits.bilibili.PRIVATE_MESSAGE.countingMode, 'UTF16');

  const csvCell = value => `"${String(value).replaceAll('"', '""')}"`;
  const csv = [
    ['标准问题', '标准答案', '关键词', '知识大类', '知识小类'],
    ['公共超限问题', '公'.repeat(121), '公共,超限', '公共知识库', '字数测试'],
    ['B站合规问题', `答${'😊'.repeat(239)}。`, 'B站,合规', 'B站知识库', '字数测试'],
    ['B站超限问题', '答'.repeat(481), 'B站,超限', 'B站知识库', '字数测试']
  ].map(row => row.map(csvCell).join(',')).join('\r\n');
  const preview = await request(base, '/api/knowledge/import/preview', { method: 'POST', body: JSON.stringify({ fileName: '平台字数测试.csv', base64: Buffer.from(csv, 'utf8').toString('base64') }) });
  assert.equal(preview.response.status, 200);
  assert.equal(preview.data.items.length, 3);
  const [publicOver, bilibiliOk, bilibiliOver] = preview.data.items;
  assert.equal(publicOver.answerCharacterCount, 121);
  assert.equal(publicOver.answerCharacterLimit, 120);
  assert.equal(publicOver.importable, false);
  assert.match(publicOver.errors.join('；'), /超过可入库上限 120/);
  assert.equal(bilibiliOk.answerCharacterCount, 480);
  assert.equal(bilibiliOk.answerCharacterLimit, 480);
  assert.equal(bilibiliOk.importable, true);
  assert.equal(bilibiliOver.answerCharacterCount, 481);
  assert.equal(bilibiliOver.answerCharacterLimit, 480);
  assert.equal(bilibiliOver.importable, false);

  const committed = await request(base, '/api/knowledge/import/commit', { method: 'POST', body: JSON.stringify({
    batchId: preview.data.batchId,
    importedBy: '平台字数集成测试',
    selectedRowNos: [1, 2, 3],
    reviewedItems: [
      { rowNo: 1, question: publicOver.question, answer: '公'.repeat(120), keywords: publicOver.keywords, category: publicOver.category, subcategory: publicOver.subcategory },
      { rowNo: 2, question: bilibiliOk.question, answer: bilibiliOk.answer, keywords: bilibiliOk.keywords, category: bilibiliOk.category, subcategory: bilibiliOk.subcategory },
      { rowNo: 3, question: bilibiliOver.question, answer: bilibiliOver.answer, keywords: bilibiliOver.keywords, category: bilibiliOver.category, subcategory: bilibiliOver.subcategory }
    ]
  }) });
  assert.equal(committed.response.status, 200);
  assert.equal(committed.data.selected, 3);
  assert.equal(committed.data.imported, 2);
  assert.equal(committed.data.skipped, 1);
  assert.match(JSON.stringify(committed.data.rejected), /超过可入库上限 480/);
  const imported = (await request(base, '/api/knowledge')).data.knowledge.filter(item => item.import_batch_id === preview.data.batchId);
  assert.equal(imported.length, 2);
  assert.equal(imported.some(item => item.question === 'B站超限问题'), false);
  assert.equal(stderr.includes('SyntaxError'), false, stderr);
});







test('Weibo collection watermarks persist and are returned to the next collection job', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'weibo-watermark-int-'));
  const dbPath = path.join(dir, 'test.db');
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['src/server.js'], { cwd: root, env: { ...process.env, PORT: String(port), DATABASE_PATH: dbPath, QWEN_MODE: 'mock', RPA_MODE: 'simulated', AUTO_COLLECT_ENABLED: 'false', LOCAL_AGENT_AUTO_START: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await Promise.race([new Promise(resolve => child.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 2000))]);
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await waitFor(base);
  const db = openTestDatabase(dbPath);
  const account = db.prepare("SELECT * FROM accounts WHERE platform_code='weibo' LIMIT 1").get();
  assert.ok(account);

  const created = await request(base, '/api/platforms/weibo/collect', { method: 'POST', body: JSON.stringify({ accountId: account.id, types: ['COMMENT', 'PRIVATE_MESSAGE'] }) });
  assert.equal(created.response.status, 200, JSON.stringify(created.data));
  const firstClaim = await request(base, '/api/agent/jobs/claim', { method: 'POST', body: JSON.stringify({ deviceId: account.device_id, platformCodes: ['weibo'] }) });
  assert.equal(firstClaim.response.status, 200, JSON.stringify(firstClaim.data));
  assert.equal(firstClaim.data.job.job_type, 'COLLECT_MESSAGES');
  assert.equal(firstClaim.data.job.payload.collectionMode, 'WEIBO_SAFE_INCREMENTAL');
  assert.deepEqual(firstClaim.data.job.payload.collectionWatermarks, {});

  const commentWatermark = {
    recentCommentIds: ['5013415519847148'],
    lastFullSweepAt: '2026-08-21T00:00:00.000Z',
    lastSeenEventTimeMs: 1787270400000
  };
  const privateWatermark = {
    sessions: {
      'user-1': {
        conversationKey: 'user-1',
        userName: '微博测试用户',
        lastMessageId: '4479825538150513',
        recentMessageIds: ['4479825538150513'],
        lastPreviewHash: 'preview-hash-1',
        lastEventTimeMs: 1787270401000,
        lastCheckedAt: '2026-08-21T00:00:01.000Z',
        initializedAt: '2026-08-21T00:00:00.000Z',
        extractionIncomplete: false
      }
    },
    lastFullSweepAt: '2026-08-21T00:00:02.000Z'
  };
  const completed = await request(base, '/api/agent/jobs/' + firstClaim.data.job.id + '/complete', {
    method: 'POST',
    body: JSON.stringify({
      status: 'SUCCESS',
      result: {
        messages: [],
        collectionWatermarks: { COMMENT: commentWatermark, PRIVATE_MESSAGE: privateWatermark },
        successfulScopeNames: ['COMMENT', 'PRIVATE_MESSAGE'],
        partialScopeNames: []
      }
    })
  });
  assert.equal(completed.response.status, 200, JSON.stringify(completed.data));

  const cursorRows = db.prepare("SELECT scope,cursor_json,last_success_at FROM platform_collection_cursors WHERE platform_code='weibo' AND account_id=? ORDER BY scope").all(account.id);
  assert.equal(cursorRows.length, 2);
  const commentCursor = JSON.parse(cursorRows.find(item => item.scope === 'COMMENT').cursor_json);
  const privateCursor = JSON.parse(cursorRows.find(item => item.scope === 'PRIVATE_MESSAGE').cursor_json);
  assert.deepEqual(commentCursor.recentCommentIds, commentWatermark.recentCommentIds);
  assert.equal(privateCursor.sessions['user-1'].lastMessageId, '4479825538150513');
  assert.ok(cursorRows.every(item => item.last_success_at));
  const storedJobResult = JSON.parse(db.prepare('SELECT result FROM agent_jobs WHERE id=?').get(firstClaim.data.job.id).result);
  assert.deepEqual(storedJobResult.collectionWatermarksSaved.sort(), ['COMMENT', 'PRIVATE_MESSAGE']);

  db.prepare('DELETE FROM agent_jobs WHERE id=?').run(firstClaim.data.job.id);
  const secondCreated = await request(base, '/api/platforms/weibo/collect', { method: 'POST', body: JSON.stringify({ accountId: account.id, types: ['COMMENT', 'PRIVATE_MESSAGE'] }) });
  assert.equal(secondCreated.response.status, 200, JSON.stringify(secondCreated.data));
  const secondClaim = await request(base, '/api/agent/jobs/claim', { method: 'POST', body: JSON.stringify({ deviceId: account.device_id, platformCodes: ['weibo'] }) });
  assert.equal(secondClaim.response.status, 200, JSON.stringify(secondClaim.data));
  assert.deepEqual(secondClaim.data.job.payload.collectionWatermarks.COMMENT.recentCommentIds, commentWatermark.recentCommentIds);
  assert.equal(secondClaim.data.job.payload.collectionWatermarks.PRIVATE_MESSAGE.sessions['user-1'].lastMessageId, '4479825538150513');
  assert.equal(stderr.includes('SyntaxError'), false, stderr);
  db.close();
});

test('Weibo explicit publish rejection safely unlocks only Weibo targets for a real retry', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'weibo-publish-reject-int-'));
  const dbPath = path.join(dir, 'test.db');
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['src/server.js'], { cwd: root, env: { ...process.env, PORT: String(port), DATABASE_PATH: dbPath, QWEN_MODE: 'mock', RPA_MODE: 'simulated', AUTO_COLLECT_ENABLED: 'false', LOCAL_AGENT_AUTO_START: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await Promise.race([new Promise(resolve => child.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 2000))]);
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await waitFor(base);
  const db = openTestDatabase(dbPath);
  const weibo = db.prepare("SELECT * FROM accounts WHERE platform_code='weibo' LIMIT 1").get();
  const bilibili = db.prepare("SELECT * FROM accounts WHERE platform_code='bilibili' LIMIT 1").get();
  assert.ok(weibo);
  assert.ok(bilibili);
  const stamp = new Date().toISOString();

  const createLockedTarget = async (platformCode, account, suffix) => {
    const taskId = Number(db.prepare("INSERT INTO publish_tasks(title,body,material_path,status,created_at,updated_at) VALUES(?,?,?,'EXECUTING',?,?)").run(`weibo-reject-${suffix}`, 'body', `D:/material/${suffix}.mp4`, stamp, stamp).lastInsertRowid);
    const targetId = Number(db.prepare("INSERT INTO publish_targets(task_id,platform_code,account_id,status,submission_status,review_status,publish_attempt_state,submit_lock,updated_at) VALUES(?,?,?,'RUNNING','NOT_SUBMITTED','UNKNOWN','NOT_ATTEMPTED','UNLOCKED',?)").run(taskId, platformCode, account.id, stamp).lastInsertRowid);
    const fingerprint = { version: 1, taskId, targetId, title: `weibo-reject-${suffix}`, materialSha256: `hash-${suffix}`, durationSeconds: 15, createdAt: stamp, accountId: account.id, platformCode, fingerprintHash: `fingerprint-${suffix}` };
    db.prepare('UPDATE publish_targets SET draft_fingerprint=? WHERE id=?').run(JSON.stringify(fingerprint), targetId);
    const lockPayload = { deviceId: account.device_id, taskId, targetId, accountId: account.id, platformCode, draftFingerprint: fingerprint, reason: 'TEST_FINAL_CLICK' };
    const acquired = await request(base, `/api/agent/publish-targets/${targetId}/acquire-submit-lock`, { method: 'POST', body: JSON.stringify(lockPayload) });
    assert.equal(acquired.response.status, 200, JSON.stringify(acquired.data));
    return { taskId, targetId, fingerprint, lockPayload };
  };

  const rejected = await createLockedTarget('weibo', weibo, 'explicit');
  const rejectionResult = {
    platformCode: 'weibo',
    verificationPolicyId: 'weibo-publish-status-v1',
    stage: 'publish_rejected',
    explicitPlatformFailure: true,
    submissionStatus: 'NOT_SUBMITTED',
    reviewStatus: 'UNKNOWN',
    submitAttempted: true,
    networkEvidence: { kind: 'FAILURE', confirmed: true, code: '20018', message: '发布失败' },
    message: '微博平台明确拒绝本次发布'
  };
  const rejectedResponse = await request(base, `/api/agent/publish-targets/${rejected.targetId}/record-submit-result`, { method: 'POST', body: JSON.stringify({ status: 'FAILED', result: rejectionResult }) });
  assert.equal(rejectedResponse.response.status, 200, JSON.stringify(rejectedResponse.data));
  const rejectedTarget = db.prepare('SELECT * FROM publish_targets WHERE id=?').get(rejected.targetId);
  assert.equal(rejectedTarget.status, 'FAILED');
  assert.equal(rejectedTarget.submission_status, 'NOT_SUBMITTED');
  assert.equal(rejectedTarget.review_status, 'UNKNOWN');
  assert.equal(rejectedTarget.publish_attempt_state, 'PUBLISH_REJECTED');
  assert.equal(rejectedTarget.submit_lock, 'UNLOCKED');
  assert.equal(rejectedTarget.submit_authorized_at, null);
  assert.equal(rejectedTarget.submit_attempted_at, null);
  assert.equal(rejectedTarget.submit_attempt_count, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM agent_jobs WHERE job_type='VERIFY_PUBLISH' AND CAST(json_extract(payload,'$.targetId') AS INTEGER)=?").get(rejected.targetId).count, 0);

  const retryLock = await request(base, `/api/agent/publish-targets/${rejected.targetId}/acquire-submit-lock`, { method: 'POST', body: JSON.stringify({ ...rejected.lockPayload, reason: 'RETRY_AFTER_EXPLICIT_WEIBO_REJECTION' }) });
  assert.equal(retryLock.response.status, 200, JSON.stringify(retryLock.data));
  assert.equal(retryLock.data.authorized, true);
  assert.equal(retryLock.data.submitAttemptCount, 1);

  const uncertain = await createLockedTarget('weibo', weibo, 'uncertain');
  const uncertainResponse = await request(base, `/api/agent/publish-targets/${uncertain.targetId}/record-submit-result`, { method: 'POST', body: JSON.stringify({ status: 'NEEDS_CONFIRMATION', result: { ...rejectionResult, stage: 'publish_unconfirmed', submissionStatus: 'UNKNOWN', networkEvidence: { kind: 'UNCONFIRMED', confirmed: false }, message: '微博提交结果暂时无法确认' } }) });
  assert.equal(uncertainResponse.response.status, 200, JSON.stringify(uncertainResponse.data));
  const uncertainTarget = db.prepare('SELECT * FROM publish_targets WHERE id=?').get(uncertain.targetId);
  assert.equal(uncertainTarget.submit_lock, 'LOCKED');
  assert.ok(uncertainTarget.submit_attempted_at);
  assert.equal(uncertainTarget.publish_attempt_state, 'SUBMIT_ATTEMPTED_UNCONFIRMED');

  const otherPlatform = await createLockedTarget('bilibili', bilibili, 'bilibili');
  const otherResponse = await request(base, `/api/agent/publish-targets/${otherPlatform.targetId}/record-submit-result`, { method: 'POST', body: JSON.stringify({ status: 'FAILED', result: { ...rejectionResult, platformCode: 'bilibili', verificationPolicyId: 'bilibili-publish-status-v1' } }) });
  assert.equal(otherResponse.response.status, 200, JSON.stringify(otherResponse.data));
  const otherTarget = db.prepare('SELECT * FROM publish_targets WHERE id=?').get(otherPlatform.targetId);
  assert.equal(otherTarget.submit_lock, 'LOCKED');
  assert.ok(otherTarget.submit_attempted_at);
  assert.notEqual(otherTarget.publish_attempt_state, 'PUBLISH_REJECTED');

  assert.equal(stderr.includes('SyntaxError'), false, stderr);
  db.close();
});
