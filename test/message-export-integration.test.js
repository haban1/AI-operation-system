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
    try { const response = await fetch(base + '/api/health'); if (response.ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('reply export test server start timeout');
}

test('message reply export endpoint filters platforms and returns downloadable CSV', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'message-export-'));
  const databasePath = path.join(dir, 'test.db');
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: root,
    env: { ...process.env, PORT: String(port), DATABASE_PATH: databasePath, AUTH_ENABLED: 'false', AGENT_SHARED_TOKEN: '', AUTO_COLLECT_ENABLED: 'false', LOCAL_AGENT_AUTO_START: 'false', QWEN_MODE: 'mock', RPA_MODE: 'simulated' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await Promise.race([new Promise(resolve => child.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 2000))]);
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await waitFor(base);
  const db = new DatabaseSync(databasePath);
  db.exec('PRAGMA busy_timeout=15000');
  const account = db.prepare("SELECT id,device_id FROM accounts WHERE platform_code='xiaohongshu' ORDER BY id LIMIT 1").get();
  assert.ok(account, stderr);
  const stamp = '2026-08-19T04:05:06.000Z';
  const deletedInsert = db.prepare(`INSERT INTO messages(platform_code,account_id,message_type,external_id,user_name,content,status,decision,reply_text,created_at,updated_at,handled_at,handled_by,handler_note,context_json)
    VALUES('xiaohongshu',?,'COMMENT','export-test-delete','待删除用户','这条记录稍后删除','AUTO_REPLIED','AUTO_REPLY','这条回复不应继续导出',?,?,?,?,?,'{}')`)
    .run(account.id, stamp, stamp, stamp, 'AI_RPA', '自动回复成功');
  const deletedId = Number(deletedInsert.lastInsertRowid);
  db.prepare(`INSERT INTO messages(platform_code,account_id,message_type,external_id,user_name,content,status,decision,reply_text,created_at,updated_at,handled_at,handled_by,handler_note,context_json)
    VALUES('xiaohongshu',?,'COMMENT','export-test-visible','=测试用户','请问怎么报名？','AUTO_REPLIED','AUTO_REPLY','请私信发送报名信息。',?,?,?,?,?,'{}')`)
    .run(account.id, stamp, stamp, stamp, 'AI_RPA', '自动回复成功');
  const selfInsert = db.prepare(`INSERT INTO messages(platform_code,account_id,message_type,external_id,user_name,content,status,decision,reply_text,created_at,updated_at,handled_at,handled_by,handler_note,context_json)
    VALUES('xiaohongshu',?,'COMMENT','export-test-self','运营账号','这是己方账号发出的消息','IGNORED_SELF','SELF_MESSAGE',NULL,?,?,?,?,?,'{}')`)
    .run(account.id, stamp, stamp, stamp, 'PLATFORM_DETECTED', '己方消息识别');
  const selfMessageId = Number(selfInsert.lastInsertRowid);

  const beforeDelete = await fetch(base + '/api/messages/export?platforms=xiaohongshu');
  assert.equal(beforeDelete.status, 200, stderr);
  assert.equal(beforeDelete.headers.get('x-export-count'), '2');

  const deletedResponse = await fetch(base + `/api/messages/${deletedId}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deletedBy: '测试运营', reason: '测试软删除与导出绑定' })
  });
  const deletedResult = await deletedResponse.json();
  assert.equal(deletedResponse.status, 200, JSON.stringify(deletedResult));
  assert.equal(deletedResult.deleted, true);

  const visibleMessages = await (await fetch(base + '/api/messages')).json();
  assert.equal(visibleMessages.messages.some(item => Number(item.id) === deletedId), false);
  assert.equal(visibleMessages.messages.some(item => Number(item.id) === selfMessageId), false);

  const response = await fetch(base + '/api/messages/export?platforms=xiaohongshu');
  const csv = await response.text();
  assert.equal(response.status, 200, stderr);
  assert.match(response.headers.get('content-type') || '', /text\/csv/);
  assert.match(response.headers.get('content-disposition') || '', /filename\*=UTF-8''/);
  assert.equal(response.headers.get('x-export-count'), '1');
  assert.match(csv, /小红书/);
  assert.match(csv, /请问怎么报名/);
  assert.match(csv, /请私信发送报名信息/);
  assert.match(csv, /"'=测试用户"/);
  assert.doesNotMatch(csv, /这条记录稍后删除/);
  assert.doesNotMatch(csv, /这条回复不应继续导出/);
  assert.doesNotMatch(csv, /这是己方账号发出的消息/);
  const storedSelf = db.prepare('SELECT status,decision,deleted_at FROM messages WHERE id=?').get(selfMessageId);
  assert.equal(storedSelf.status, 'IGNORED_SELF');
  assert.equal(storedSelf.decision, 'SELF_MESSAGE');
  assert.equal(storedSelf.deleted_at, null);

  const storedDeleted = db.prepare('SELECT * FROM messages WHERE id=?').get(deletedId);
  assert.ok(storedDeleted.deleted_at);
  assert.equal(storedDeleted.deleted_by, '测试运营');
  assert.equal(storedDeleted.status, 'AUTO_REPLIED');
  const registry = db.prepare('SELECT * FROM message_processing_registry WHERE canonical_message_id=?').get(deletedId);
  assert.ok(registry);
  assert.equal(registry.processing_status, 'AUTO_REPLIED');

  const queuedMessage = db.prepare(`INSERT INTO messages(platform_code,account_id,message_type,external_id,user_name,content,status,created_at,updated_at,context_json)
    VALUES('xiaohongshu',?,'COMMENT','delete-queued-test','排队用户','等待回复','REPLY_QUEUED',?,?,'{}')`).run(account.id, stamp, stamp);
  const queuedMessageId = Number(queuedMessage.lastInsertRowid);
  const queuedJob = db.prepare(`INSERT INTO agent_jobs(device_id,job_type,payload,status,created_at) VALUES(?,'REPLY',?,'QUEUED',?)`)
    .run(account.device_id, JSON.stringify({ messageId: queuedMessageId, platformCode: 'xiaohongshu', accountId: account.id }), stamp);
  const queuedJobId = Number(queuedJob.lastInsertRowid);
  db.prepare('UPDATE messages SET reply_job_id=? WHERE id=?').run(queuedJobId, queuedMessageId);
  const queuedDelete = await fetch(base + `/api/messages/${queuedMessageId}`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  const queuedDeleteResult = await queuedDelete.json();
  assert.equal(queuedDelete.status, 200, JSON.stringify(queuedDeleteResult));
  assert.equal(queuedDeleteResult.processingClosed, true);
  assert.equal(queuedDeleteResult.cancelledJobs, 1);
  const storedQueued = db.prepare('SELECT * FROM messages WHERE id=?').get(queuedMessageId);
  assert.equal(storedQueued.status, 'CLOSED');
  assert.equal(storedQueued.decision, 'OPERATOR_DISMISSED');
  assert.ok(storedQueued.handled_at);
  assert.ok(storedQueued.deleted_at);
  assert.equal(db.prepare('SELECT status FROM agent_jobs WHERE id=?').get(queuedJobId).status, 'CANCELLED');
  assert.equal(db.prepare('SELECT processing_status FROM message_processing_registry WHERE canonical_message_id=?').get(queuedMessageId).processing_status, 'CLOSED');
  const queuedDeleteAgain = await fetch(base + `/api/messages/${queuedMessageId}`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  const queuedDeleteAgainResult = await queuedDeleteAgain.json();
  assert.equal(queuedDeleteAgain.status, 200);
  assert.equal(queuedDeleteAgainResult.alreadyDeleted, true);

  const runningMessage = db.prepare(`INSERT INTO messages(platform_code,account_id,message_type,external_id,user_name,content,status,created_at,updated_at,context_json)
    VALUES('xiaohongshu',?,'PRIVATE_MESSAGE','delete-running-test','运行中用户','正在发送','REPLY_RUNNING',?,?,'{}')`).run(account.id, stamp, stamp);
  const runningMessageId = Number(runningMessage.lastInsertRowid);
  const runningJob = db.prepare(`INSERT INTO agent_jobs(device_id,job_type,payload,status,created_at) VALUES(?,'REPLY',?,'RUNNING',?)`)
    .run(account.device_id, JSON.stringify({ messageId: runningMessageId, platformCode: 'xiaohongshu', accountId: account.id }), stamp);
  db.prepare('UPDATE messages SET reply_job_id=? WHERE id=?').run(Number(runningJob.lastInsertRowid), runningMessageId);
  const runningDelete = await fetch(base + `/api/messages/${runningMessageId}`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  const runningDeleteResult = await runningDelete.json();
  assert.equal(runningDelete.status, 409);
  assert.equal(runningDeleteResult.code, 'MESSAGE_DELETE_RUNNING');
  assert.equal(db.prepare('SELECT deleted_at FROM messages WHERE id=?').get(runningMessageId).deleted_at, null);

  const noSelection = await fetch(base + '/api/messages/export');
  assert.equal(noSelection.status, 400);
  const emptyPlatform = await fetch(base + '/api/messages/export?platforms=douyin');
  assert.equal(emptyPlatform.status, 404);
  db.close();
});
