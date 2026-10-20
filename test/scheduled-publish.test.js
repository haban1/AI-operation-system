import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import sharp from 'sharp';
import { precheckMaterial } from '../agent/precheck.js';

const root = path.resolve(import.meta.dirname, '..');

async function freePort() {
  const server = http.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function waitFor(base) {
  for (let index = 0; index < 80; index += 1) {
    try { if ((await fetch(base + '/api/health')).ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('定时发布测试服务启动超时');
}

async function request(base, pathname, options = {}) {
  const response = await fetch(base + pathname, { ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } });
  const data = await response.json();
  return { response, data };
}

function localText(date) {
  const pad = value => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

async function waitForSchedule(base, id, expected, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const list = await request(base, '/api/publish/schedules?limit=50');
    const record = list.data.records.find(item => item.id === id);
    if (record && expected.includes(record.status)) return record;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`定时任务 #${id} 未进入状态 ${expected.join('/')}`);
}

test('定时发布：本地时间持久化、到点只创建一次正式任务、状态回写并支持取消', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scheduled-publish-'));
  const dbPath = path.join(dir, 'test.db');
  const materialPath = path.join(dir, 'schedule.png');
  await sharp({ create: { width: 1080, height: 1440, channels: 3, background: '#315f91' } }).png().toFile(materialPath);
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: root,
    env: { ...process.env, PORT: String(port), DATABASE_PATH: dbPath, AUTH_ENABLED: 'false', AGENT_SHARED_TOKEN: '', QWEN_MODE: 'mock', AUTO_COLLECT_ENABLED: 'false', LOCAL_AGENT_AUTO_START: 'false', SMOKE_TEST_ENABLED: 'false', INSTANCE_LOCK_ENABLED: 'false' },
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
    if (db) db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await waitFor(base);
  db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000');
  const account = db.prepare("SELECT id,platform_code,device_id FROM accounts WHERE platform_code='douyin' ORDER BY id LIMIT 1").get();
  assert.ok(account, stderr);
  const stamp = new Date().toISOString();
  db.prepare("UPDATE accounts SET enabled=1,login_status='READY',login_checked_at=?,login_message='测试已登录' WHERE id=?").run(stamp, account.id);
  db.prepare("UPDATE platforms SET desired_state='RUNNING',lifecycle_state='ACTIVE',runtime_updated_at=? WHERE code='douyin'").run(stamp);
  db.prepare("UPDATE devices SET status='ONLINE',last_heartbeat=? WHERE id=?").run(stamp, account.device_id);

  const title = '社区活动定时发布';
  const body = '本周社区活动开放报名，请以官方页面的最新安排为准。';
  const precheck = await precheckMaterial({ materialPath, title, body, platforms: ['douyin'] });
  const scheduled = new Date(Date.now() + 6500); scheduled.setMilliseconds(0);
  const payload = { title, body, materialPath, targets: [{ platformCode: 'douyin', accountId: account.id }], precheck, complianceConfirmed: true, managementConfirmed: true, publishMode: 'AUTO', scheduledAt: scheduled.toISOString(), scheduledLocal: localText(scheduled), timezoneOffsetMinutes: scheduled.getTimezoneOffset() };

  const created = await request(base, '/api/publish/schedules', { method: 'POST', body: JSON.stringify(payload) });
  assert.equal(created.response.status, 201, JSON.stringify(created.data));
  assert.equal(created.data.schedule.status, 'PENDING');
  assert.equal(created.data.schedule.scheduled_local_text, localText(scheduled));
  assert.equal(created.data.schedule.target_count, 1);

  const duplicate = await request(base, '/api/publish/schedules', { method: 'POST', body: JSON.stringify(payload) });
  assert.equal(duplicate.response.status, 409);
  assert.equal(duplicate.data.code, 'SCHEDULE_DUPLICATE');

  const past = new Date(Date.now() - 5000); past.setMilliseconds(0);
  const invalid = await request(base, '/api/publish/schedules', { method: 'POST', body: JSON.stringify({ ...payload, scheduledAt: past.toISOString(), scheduledLocal: localText(past), timezoneOffsetMinutes: past.getTimezoneOffset() }) });
  assert.equal(invalid.response.status, 400);

  const running = await waitForSchedule(base, created.data.schedule.id, ['RUNNING']);
  assert.ok(running.publish_task_id);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM publish_tasks').get().c, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM agent_jobs WHERE job_type='PUBLISH'").get().c, 1);
  await new Promise(resolve => setTimeout(resolve, 1200));
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM publish_tasks').get().c, 1, '轮询不得重复创建正式任务');

  db.prepare("UPDATE publish_targets SET status='PUBLISHED',review_status='PUBLISHED',updated_at=? WHERE task_id=?").run(new Date().toISOString(), running.publish_task_id);
  db.prepare("UPDATE publish_tasks SET status='PUBLISHED',updated_at=? WHERE id=?").run(new Date().toISOString(), running.publish_task_id);
  const completed = await waitForSchedule(base, created.data.schedule.id, ['COMPLETED']);
  assert.equal(completed.status, 'COMPLETED');

  const later = new Date(Date.now() + 60_000); later.setMilliseconds(0);
  const cancellable = await request(base, '/api/publish/schedules', { method: 'POST', body: JSON.stringify({ ...payload, title: '等待取消的定时任务', scheduledAt: later.toISOString(), scheduledLocal: localText(later), timezoneOffsetMinutes: later.getTimezoneOffset() }) });
  assert.equal(cancellable.response.status, 201, JSON.stringify(cancellable.data));
  const cancelled = await request(base, `/api/publish/schedules/${cancellable.data.schedule.id}/cancel`, { method: 'POST', body: '{}' });
  assert.equal(cancelled.response.status, 200);
  assert.equal(cancelled.data.schedule.status, 'CANCELLED');
});

test('发布页面包含定时按钮、年月日时分秒滚轮和未来任务/历史记录双栏', () => {
  const app = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');
  const css = fs.readFileSync(path.join(root, 'public/styles.css'), 'utf8');
  for (const text of ['创建定时发布任务', '未来定时发布任务', "['year','年']", "['month','月']", "['day','日']", "['hour','时']", "['minute','分']", "['second','秒']", '待执行', '执行失败', '执行完成']) assert.equal(app.includes(text), true, `缺少：${text}`);
  assert.match(css, /\.publish-records-grid\{display:grid;grid-template-columns:minmax\(0,1fr\) minmax\(0,1fr\)/);
  assert.match(css, /\.schedule-wheel\{[^}]*scroll-snap-type:y mandatory/);
});

