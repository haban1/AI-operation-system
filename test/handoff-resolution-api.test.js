import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { cleanupDir, jsonRequest, startServer, stopChild } from './helpers/runtime.js';

test('人工处理接口原子归档通知，首页与运营统计排除已处理和软删除消息', async t => {
  const runtime = await startServer();
  t.after(async () => { await stopChild(runtime.child); cleanupDir(runtime.dir); });
  const db = new DatabaseSync(runtime.dbPath);
  db.exec('PRAGMA busy_timeout=15000');
  t.after(() => db.close());
  const account = db.prepare("SELECT id FROM accounts WHERE platform_code='douyin' LIMIT 1").get();
  const stamp = new Date().toISOString();
  const before = (await jsonRequest(runtime.base, '/api/bootstrap')).data.stats.manualRequired;
  const create = suffix => Number(db.prepare(`INSERT INTO messages(platform_code,account_id,message_type,external_id,
    user_name,content,status,created_at,updated_at) VALUES('douyin',?,'PRIVATE_MESSAGE',?,'用户','待处理','MANUAL_REQUIRED',?,?)`)
    .run(account.id, suffix, stamp, stamp).lastInsertRowid);
  const id = create('resolve-api'), next = create('next-api');
  const handled = create('stale-handled-api'), deleted = create('stale-deleted-api');
  db.prepare('UPDATE messages SET handled_at=? WHERE id=?').run(stamp, handled);
  db.prepare('UPDATE messages SET deleted_at=? WHERE id=?').run(stamp, deleted);
  const notification = Number(db.prepare(`INSERT INTO notifications(channel,type,title,content,status,created_at,message_id,metadata_json)
    VALUES('WECOM','MANUAL_HANDOFF','转人工','待处理','RETRY_WAIT',?,?,'{"handoff":true}')`).run(stamp, id).lastInsertRowid);
  assert.equal((await jsonRequest(runtime.base, '/api/bootstrap')).data.stats.manualRequired, before + 2);
  db.exec("CREATE TRIGGER fail_archive BEFORE UPDATE ON notifications BEGIN SELECT RAISE(ABORT,'MOCK_ARCHIVE_FAILURE'); END");
  const failed = await jsonRequest(runtime.base, `/api/messages/${id}/handled`, { method: 'POST', body: {} });
  assert.equal(failed.response.status, 500);
  assert.equal(db.prepare('SELECT status FROM messages WHERE id=?').get(id).status, 'MANUAL_REQUIRED');
  db.exec('DROP TRIGGER fail_archive');
  const result = await jsonRequest(runtime.base, `/api/messages/${id}/handled`, { method: 'POST', body: { handledBy: '测试' } });
  assert.equal(result.response.status, 200);
  assert.equal(result.data.message.status, 'MANUAL_HANDLED');
  const archived = db.prepare('SELECT * FROM notifications WHERE id=?').get(notification);
  assert.equal(archived.status, 'CANCELLED');
  assert.ok(JSON.parse(archived.metadata_json).archivedAt);
  const bootstrap = (await jsonRequest(runtime.base, '/api/bootstrap')).data;
  assert.equal(bootstrap.stats.manualRequired, before + 1);
  const operations = (await jsonRequest(runtime.base, '/api/operations-dashboard')).data.dashboard;
  assert.equal(operations.recommendations.find(item => item.type === '人工接管积压').title, `处理 ${before + 1} 条待人工会话`);
  assert.equal(db.prepare('SELECT status FROM messages WHERE id=?').get(next).status, 'MANUAL_REQUIRED');
  assert.equal((await jsonRequest(runtime.base, `/api/messages/${id}/retry`, { method: 'POST', body: {} })).response.status, 409);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
});
