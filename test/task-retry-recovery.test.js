import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const root = path.resolve(import.meta.dirname, '..');

async function freePort() {
  const server = http.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function waitFor(base) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(base + '/api/health');
      if (response.ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('补发恢复状态测试服务启动超时');
}

async function request(base, pathname, options = {}) {
  const response = await fetch(base + pathname, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }
  });
  return { response, data: await response.json() };
}

function insertTask(db, { title, status = 'FAILED', retryOfTaskId = null, createdAt = new Date().toISOString() }) {
  return Number(db.prepare(`INSERT INTO publish_tasks(title,body,material_path,retry_of_task_id,status,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?)`).run(title, `${title}正文`, 'D:/retry-recovery-test.mp4', retryOfTaskId, status, createdAt, createdAt).lastInsertRowid);
}

function insertTarget(db, taskId, account, {
  status = 'FAILED',
  submissionStatus = 'NOT_SUBMITTED',
  reviewStatus = 'UNKNOWN',
  publishAttemptState = 'UPLOAD_FAILED',
  submitLock = 'UNLOCKED',
  reviewMessage = '原始上传失败记录',
  updatedAt = new Date().toISOString()
} = {}) {
  return Number(db.prepare(`INSERT INTO publish_targets(
      task_id,platform_code,account_id,status,submission_status,review_status,publish_attempt_state,submit_lock,review_message,updated_at,reviewed_at,submitted_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      taskId,
      account.platform_code,
      account.id,
      status,
      submissionStatus,
      reviewStatus,
      publishAttemptState,
      submitLock,
      reviewMessage,
      updatedAt,
      status === 'PUBLISHED' ? updatedAt : null,
      submissionStatus === 'SUBMITTED' ? updatedAt : null
    ).lastInsertRowid);
}

function taskByTitle(payload, title) {
  const task = payload.tasks.find(item => item.title === title);
  assert.ok(task, `未找到测试任务：${title}`);
  return task;
}

test('任务中心：补发成功使用派生展示状态，并保留原失败审计', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-retry-recovery-'));
  const dbPath = path.join(dir, 'test.db');
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      DATABASE_PATH: dbPath,
      AUTH_ENABLED: 'false',
      AGENT_SHARED_TOKEN: '',
      QWEN_MODE: 'mock',
      AUTO_COLLECT_ENABLED: 'false',
      LOCAL_AGENT_AUTO_START: 'false',
      SMOKE_TEST_ENABLED: 'false'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stderr = '';
  let db;
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await Promise.race([new Promise(resolve => child.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 2000))]);
    }
    db?.close();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try { fs.rmSync(dir, { recursive: true, force: true }); break; }
      catch (error) { if (attempt === 4) throw error; await new Promise(resolve => setTimeout(resolve, 100)); }
    }
  });

  await waitFor(base);
  db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000');
  const accounts = db.prepare(`SELECT id,platform_code,device_id FROM accounts WHERE enabled=1 AND platform_code IN ('douyin','wechat_channels','weibo') ORDER BY id`).all();
  const accountByPlatform = Object.fromEntries(accounts.map(account => [account.platform_code, account]));
  assert.ok(accountByPlatform.douyin);
  assert.ok(accountByPlatform.wechat_channels);
  assert.ok(accountByPlatform.weibo);

  const sourceId = insertTask(db, { title: '补发成功源任务', status: 'PARTIAL_FAILED', createdAt: '2026-08-20T01:00:00.000Z' });
  insertTarget(db, sourceId, accountByPlatform.douyin, { status: 'PUBLISHED', submissionStatus: 'SUBMITTED', reviewStatus: 'PUBLISHED', publishAttemptState: 'PUBLISHED', submitLock: 'LOCKED', reviewMessage: '首次发布成功', updatedAt: '2026-08-20T01:01:00.000Z' });
  const originalFailedTargetId = insertTarget(db, sourceId, accountByPlatform.wechat_channels, { reviewMessage: '视频号上传过程中网络异常', updatedAt: '2026-08-20T01:02:00.000Z' });
  const retryId = insertTask(db, { title: '补发成功任务', status: 'PUBLISHED', retryOfTaskId: sourceId, createdAt: '2026-08-20T01:10:00.000Z' });
  const retryTargetId = insertTarget(db, retryId, accountByPlatform.wechat_channels, { status: 'PUBLISHED', submissionStatus: 'SUBMITTED', reviewStatus: 'PUBLISHED', publishAttemptState: 'PUBLISHED', submitLock: 'LOCKED', reviewMessage: '管理页确认发布', updatedAt: '2026-08-20T01:12:00.000Z' });

  const partialSourceId = insertTask(db, { title: '只恢复部分平台', status: 'FAILED' });
  insertTarget(db, partialSourceId, accountByPlatform.douyin);
  insertTarget(db, partialSourceId, accountByPlatform.weibo);
  const partialRetryId = insertTask(db, { title: '只补发其中一个平台', status: 'PUBLISHED', retryOfTaskId: partialSourceId });
  insertTarget(db, partialRetryId, accountByPlatform.douyin, { status: 'PUBLISHED', submissionStatus: 'SUBMITTED', reviewStatus: 'PUBLISHED', publishAttemptState: 'PUBLISHED', submitLock: 'LOCKED' });

  const pendingSourceId = insertTask(db, { title: '补发处理中源任务', status: 'FAILED' });
  insertTarget(db, pendingSourceId, accountByPlatform.wechat_channels);
  const pendingRetryId = insertTask(db, { title: '补发处理中任务', status: 'REVIEWING', retryOfTaskId: pendingSourceId });
  insertTarget(db, pendingRetryId, accountByPlatform.wechat_channels, { status: 'REVIEWING', submissionStatus: 'SUBMITTED', reviewStatus: 'REVIEWING', publishAttemptState: 'SUBMITTED', submitLock: 'LOCKED' });

  const failedSourceId = insertTask(db, { title: '补发仍失败源任务', status: 'FAILED' });
  insertTarget(db, failedSourceId, accountByPlatform.wechat_channels);
  const failedRetryId = insertTask(db, { title: '补发仍失败任务', status: 'FAILED', retryOfTaskId: failedSourceId });
  insertTarget(db, failedRetryId, accountByPlatform.wechat_channels, { status: 'FAILED' });

  const multiSourceId = insertTask(db, { title: '多次补发源任务', status: 'FAILED' });
  insertTarget(db, multiSourceId, accountByPlatform.wechat_channels);
  const firstRetryId = insertTask(db, { title: '第一次补发失败', status: 'FAILED', retryOfTaskId: multiSourceId, createdAt: '2026-08-20T02:00:00.000Z' });
  insertTarget(db, firstRetryId, accountByPlatform.wechat_channels, { status: 'FAILED', updatedAt: '2026-08-20T02:01:00.000Z' });
  const secondRetryId = insertTask(db, { title: '第二次补发成功', status: 'PUBLISHED', retryOfTaskId: firstRetryId, createdAt: '2026-08-20T02:10:00.000Z' });
  insertTarget(db, secondRetryId, accountByPlatform.wechat_channels, { status: 'PUBLISHED', submissionStatus: 'SUBMITTED', reviewStatus: 'PUBLISHED', publishAttemptState: 'PUBLISHED', submitLock: 'LOCKED', updatedAt: '2026-08-20T02:12:00.000Z' });

  const all = await request(base, '/api/tasks');
  assert.equal(all.response.status, 200);

  const recovered = taskByTitle(all.data, '补发成功源任务');
  assert.equal(recovered.status, 'PARTIAL_FAILED');
  assert.equal(recovered.displayStatus, 'RECOVERED_BY_RETRY');
  assert.deepEqual(recovered.retryRecovery, {
    status: 'RECOVERED',
    recovered: true,
    failedTargetCount: 1,
    recoveredTargetCount: 1,
    pendingTargetCount: 0,
    failedRetryTargetCount: 0,
    retryTaskId: retryId,
    retryTaskIds: [retryId],
    recoveredAt: '2026-08-20T01:12:00.000Z'
  });
  const recoveredTarget = recovered.targets.find(target => target.id === originalFailedTargetId);
  assert.equal(recoveredTarget.status, 'FAILED');
  assert.equal(recoveredTarget.publish_attempt_state, 'UPLOAD_FAILED');
  assert.equal(recoveredTarget.review_message, '视频号上传过程中网络异常');
  assert.deepEqual(recoveredTarget.retryRecovery, {
    status: 'RECOVERED',
    recovered: true,
    retryTaskId: retryId,
    retryTargetId,
    recoveredAt: '2026-08-20T01:12:00.000Z'
  });

  const originalAudit = db.prepare('SELECT status,publish_attempt_state,review_message FROM publish_targets WHERE id=?').get(originalFailedTargetId);
  assert.deepEqual({ ...originalAudit }, { status: 'FAILED', publish_attempt_state: 'UPLOAD_FAILED', review_message: '视频号上传过程中网络异常' });
  assert.equal(db.prepare('SELECT status FROM publish_tasks WHERE id=?').get(sourceId).status, 'PARTIAL_FAILED');

  const partial = taskByTitle(all.data, '只恢复部分平台');
  assert.equal(partial.displayStatus, 'FAILED');
  assert.equal(partial.retryRecovery.status, 'PARTIAL');
  assert.equal(partial.retryRecovery.recovered, false);
  assert.equal(partial.retryRecovery.recoveredTargetCount, 1);
  assert.equal(partial.retryRecovery.failedTargetCount, 2);

  const pending = taskByTitle(all.data, '补发处理中源任务');
  assert.equal(pending.displayStatus, 'FAILED');
  assert.equal(pending.retryRecovery.status, 'IN_PROGRESS');
  assert.equal(pending.retryRecovery.pendingTargetCount, 1);

  const retryFailed = taskByTitle(all.data, '补发仍失败源任务');
  assert.equal(retryFailed.displayStatus, 'FAILED');
  assert.equal(retryFailed.retryRecovery.status, 'FAILED');
  assert.equal(retryFailed.retryRecovery.failedRetryTargetCount, 1);

  const multi = taskByTitle(all.data, '多次补发源任务');
  assert.equal(multi.displayStatus, 'RECOVERED_BY_RETRY');
  assert.equal(multi.retryRecovery.recovered, true);
  assert.equal(multi.retryRecovery.retryTaskId, secondRetryId);
  assert.deepEqual(multi.retryRecovery.retryTaskIds, [secondRetryId, firstRetryId]);

  const scoped = await request(base, '/api/tasks?platformCode=wechat_channels');
  const scopedRecovered = taskByTitle(scoped.data, '补发成功源任务');
  assert.equal(scopedRecovered.displayStatus, 'RECOVERED_BY_RETRY');
  assert.equal(scopedRecovered.targets.length, 1);
  assert.equal(scopedRecovered.targets[0].platform_code, 'wechat_channels');

  const detail = await request(base, `/api/tasks/${sourceId}`);
  assert.equal(detail.response.status, 200);
  assert.equal(detail.data.task.displayStatus, 'RECOVERED_BY_RETRY');
  assert.equal(detail.data.task.retryRecovery.retryTaskId, retryId);

  const deletedRetry = await request(base, `/api/tasks/${retryId}`, { method: 'DELETE' });
  assert.equal(deletedRetry.response.status, 200);
  const afterRetryDelete = await request(base, `/api/tasks/${sourceId}`);
  assert.equal(afterRetryDelete.data.task.status, 'PARTIAL_FAILED');
  assert.equal(afterRetryDelete.data.task.displayStatus, undefined);
  assert.equal(afterRetryDelete.data.task.retryRecovery, undefined);
  assert.equal(db.prepare('SELECT status FROM publish_targets WHERE id=?').get(originalFailedTargetId).status, 'FAILED');
  assert.equal(stderr.includes('SyntaxError'), false, stderr);
});

test('任务中心使用统一任务流展示补发恢复状态并保留失败审计', () => {
  const app = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
  const styles = fs.readFileSync(path.join(root, 'public', 'styles.css'), 'utf8');
  assert.match(app, /RECOVERED_BY_RETRY:'已补发成功'/);
  assert.match(app, /task\.retryRecovery\?\.recovered/);
  assert.match(app, /function taskVisualState\(/);
  assert.match(app, /\['PUBLISHED','SUCCESS','RECOVERED_BY_RETRY'\]\.includes\(status\)/);
  assert.match(app, /class="task-stream"/);
  assert.match(app, /data-task-status=/);
  assert.match(app, /task-command-center/);
  assert.match(app, /原失败平台已通过补发任务/);
  assert.match(app, /原失败记录继续保留/);
  assert.match(app, /task-recovered-state/);
  assert.equal(app.includes('function taskStatusSection('), false);
  assert.match(styles, /\.task-stream-card\.is-success/);
  assert.match(styles, /\.task-command-center/);
  assert.match(styles, /\.task-progress-track/);
  assert.match(styles, /prefers-reduced-motion:reduce/);
  assert.match(styles, /\.task-retry-recovery/);
  assert.match(styles, /\.task-target-detail\.is-recovered/);
});

