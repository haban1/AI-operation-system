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
  for (let i = 0; i < 60; i += 1) {
    try {
      const response = await fetch(base + '/api/health');
      if (response.ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('任务删除测试服务启动超时');
}

async function request(base, pathname, options = {}) {
  const response = await fetch(base + pathname, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }
  });
  const data = await response.json();
  return { response, data };
}

function insertTask(db, { title, status = 'QUEUED', retryOfTaskId = null }) {
  const stamp = new Date().toISOString();
  return Number(db.prepare(`INSERT INTO publish_tasks(title,body,material_path,retry_of_task_id,status,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?)`).run(title, '任务删除集成测试正文', 'D:/task-delete-test.mp4', retryOfTaskId, status, stamp, stamp).lastInsertRowid);
}

function insertTarget(db, taskId, account) {
  const stamp = new Date().toISOString();
  return Number(db.prepare(`INSERT INTO publish_targets(task_id,platform_code,account_id,status,updated_at)
    VALUES(?,?,?,?,?)`).run(taskId, account.platform_code, account.id, 'QUEUED', stamp).lastInsertRowid);
}

function insertPublishJob(db, taskId, targetId, deviceId, status) {
  const stamp = new Date().toISOString();
  return Number(db.prepare(`INSERT INTO agent_jobs(device_id,job_type,payload,status,created_at)
    VALUES(?,'PUBLISH',?,?,?)`).run(deviceId, JSON.stringify({ taskId, targetId }), status, stamp).lastInsertRowid);
}

test('任务中心删除：取消排队任务、保留审计日志、清理重试引用并阻止删除执行中任务', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-delete-int-'));
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
  let db = null;
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await Promise.race([
        new Promise(resolve => child.once('exit', resolve)),
        new Promise(resolve => setTimeout(resolve, 2000))
      ]);
    }
    if (db) db.close();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try { fs.rmSync(dir, { recursive: true, force: true }); break; }
      catch (error) {
        if (attempt === 4) throw error;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
  });

  await waitFor(base);
  db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000');
  const account = db.prepare("SELECT id,platform_code,device_id FROM accounts WHERE enabled=1 ORDER BY id LIMIT 1").get();
  assert.ok(account);

  const sourceTaskId = insertTask(db, { title: '待删除的排队任务', status: 'FAILED' });
  const sourceTargetId = insertTarget(db, sourceTaskId, account);
  const queuedJobId = insertPublishJob(db, sourceTaskId, sourceTargetId, account.device_id, 'QUEUED');
  const retryTaskId = insertTask(db, { title: '保留的再次发送任务', status: 'FAILED', retryOfTaskId: sourceTaskId });
  insertTarget(db, retryTaskId, account);

  const before = await request(base, '/api/tasks');
  assert.equal(before.response.status, 200);
  assert.equal(before.data.total, 2);

  const deleted = await request(base, `/api/tasks/${sourceTaskId}`, { method: 'DELETE' });
  assert.equal(deleted.response.status, 200);
  assert.deepEqual(deleted.data.deleted, {
    id: sourceTaskId,
    title: '待删除的排队任务',
    status: 'FAILED',
    targets: 1,
    cancelledJobs: 1
  });
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM publish_tasks WHERE id=?').get(sourceTaskId).c, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM publish_targets WHERE task_id=?').get(sourceTaskId).c, 0);
  const cancelledJob = db.prepare('SELECT status,result,completed_at FROM agent_jobs WHERE id=?').get(queuedJobId);
  assert.equal(cancelledJob.status, 'CANCELLED');
  assert.ok(cancelledJob.completed_at);
  assert.equal(JSON.parse(cancelledJob.result).reason, 'PUBLISH_TASK_DELETED');
  assert.equal(db.prepare('SELECT retry_of_task_id FROM publish_tasks WHERE id=?').get(retryTaskId).retry_of_task_id, null);

  const missingDetail = await request(base, `/api/tasks/${sourceTaskId}`);
  assert.equal(missingDetail.response.status, 404);
  const after = await request(base, '/api/tasks');
  assert.equal(after.data.total, 1);

  const runningTaskId = insertTask(db, { title: '执行中的任务', status: 'EXECUTING' });
  const runningTargetId = insertTarget(db, runningTaskId, account);
  const runningJobId = insertPublishJob(db, runningTaskId, runningTargetId, account.device_id, 'RUNNING');
  const blocked = await request(base, `/api/tasks/${runningTaskId}`, { method: 'DELETE' });
  assert.equal(blocked.response.status, 409);
  assert.equal(blocked.data.code, 'TASK_DELETE_RUNNING');
  assert.deepEqual(blocked.data.detail.runningJobIds, [runningJobId]);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM publish_tasks WHERE id=?').get(runningTaskId).c, 1);
  assert.equal(db.prepare('SELECT status FROM agent_jobs WHERE id=?').get(runningJobId).status, 'RUNNING');

  const unknown = await request(base, '/api/tasks/99999999', { method: 'DELETE' });
  assert.equal(unknown.response.status, 404);
  assert.equal(unknown.data.code, 'TASK_NOT_FOUND');
  assert.equal(stderr.includes('SyntaxError'), false, stderr);
});

test('任务中心前端提供发布时间、删除按钮、二次确认和 DELETE 请求', () => {
  const app = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
  const styles = fs.readFileSync(path.join(root, 'public', 'styles.css'), 'utf8');
  assert.match(app, /function fmtTaskPublishTime\(value\)/);
  assert.match(app, /fmtTaskPublishTime\(task\.created_at\)/);
  assert.match(app, /class="task-publish-time"/);
  assert.equal(app.includes('\\u53d1\\u5e03\\u65f6\\u95f4\\uff1a') || app.includes('发布时间：'), true);
  assert.match(styles, /\.task-publish-time\{/);
  assert.match(app, /data-delete-task=/);
  assert.match(app, /confirmDelete\(\{/);
  assert.match(app, /api\(`\/api\/tasks\/\$\{task\.id\}`\s*,\s*\{method:'DELETE'\}\)/);
  assert.match(app, /TASK|任务正在平台执行|系统会阻止删除/);
  assert.match(styles, /\.delete-task-button\{/);
});
