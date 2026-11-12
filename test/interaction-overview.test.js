import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { startServer, stopChild, cleanupDir, jsonRequest } from './helpers/runtime.js';

test('互动概览统计全量可见记录，按账号读取列表且不改变处理或发送状态', async t => {
  const runtime = await startServer({ env: { LOGIN_STATUS_POLL_ENABLED: 'false', OPERATIONS_ANALYTICS_ENABLED: 'false', ISSUE_DIAGNOSIS_ENABLED: 'false' } });
  t.after(async () => { await stopChild(runtime.child); cleanupDir(runtime.dir); });
  const db = new DatabaseSync(runtime.dbPath); db.exec('PRAGMA busy_timeout=15000'); t.after(() => db.close());
  const douyin = db.prepare("SELECT id FROM accounts WHERE platform_code='douyin' LIMIT 1").get().id;
  const weibo = db.prepare("SELECT id FROM accounts WHERE platform_code='weibo' LIMIT 1").get().id;
  const stamp = new Date().toISOString(); let seq = 0;
  const insert = db.prepare(`INSERT INTO messages(platform_code,account_id,message_type,external_id,user_name,content,status,decision,
    created_at,updated_at,collected_at,handled_at,deleted_at,wecom_notification_status)
    VALUES(?,?,?,?, '测试用户','测试内容',?,?,?,?,?,?,?,?)`);
  const add = ({ accountId = douyin, platform = 'douyin', channel = 'COMMENT', status = 'MANUAL_REQUIRED', decision = 'KNOWLEDGE_GAP', handled = null, deleted = null, notice = 'NOT_REQUIRED' } = {}) =>
    Number(insert.run(platform, accountId, channel, `overview-${++seq}`, status, decision, stamp, stamp, stamp, handled, deleted, notice).lastInsertRowid);
  const oldest = add();
  for (let index = 0; index < 204; index++) add();
  add({ channel: 'PRIVATE_MESSAGE', status: 'KNOWLEDGE_GAP' });
  add({ channel: 'PRIVATE_MESSAGE', status: 'AI_REPLY_TIMEOUT', decision: 'AI_REPLY_TIMEOUT' });
  for (const status of ['AUTO_REPLIED', 'MANUAL_HANDLED', 'CLOSED', 'SOURCE_GONE', 'SUPERSEDED', 'IGNORED_OFFICIAL']) add({ status });
  add({ handled: stamp });
  add({ status: 'NEW', decision: 'WAITING' });
  add({ deleted: stamp });
  add({ status: 'IGNORED_SELF', decision: 'SELF_MESSAGE' });
  add({ status: 'SUPERSEDED', decision: 'DUPLICATE_PROCESSED_MESSAGE' });
  add({ decision: 'HANDOFF_NOTIFY_FAILED', notice: 'FAILED' });
  const other = add({ accountId: weibo, platform: 'weibo' });
  db.prepare('UPDATE accounts SET enabled=0 WHERE id=?').run(weibo);
  const before = db.prepare('SELECT id,status,handled_at FROM messages ORDER BY id').all();
  const get = async path => { const result = await jsonRequest(runtime.base, path); assert.equal(result.response.status, 200); return result.data; };
  const all = await get('/api/messages');
  assert.equal(all.messages.length, 200);
  assert.ok(!all.messages.some(m => m.id === oldest));
  const comment = all.overview.find(item => item.account_id === douyin && item.message_type === 'COMMENT');
  assert.equal(comment.pending, 205);
  assert.equal(comment.total, 213);
  const privateMessages = all.overview.find(item => item.account_id === douyin && item.message_type === 'PRIVATE_MESSAGE');
  assert.equal(privateMessages.pending, 2); assert.equal(privateMessages.total, 2);
  const inactive = all.overview.find(item => item.account_id === weibo);
  assert.equal(inactive.pending, 1, '停用账号仍可查看已采集历史');
  const scoped = await get(`/api/messages?accountId=${weibo}`);
  assert.deepEqual(scoped.messages.map(m => m.id), [other]);
  assert.deepEqual(scoped.overview, all.overview, '切换详情账号不缩小全平台概览范围');
  assert.deepEqual((await get('/api/messages?accountId=99999999')).messages, []);
  for (const value of ['0', '-1', 'abc', '1.2', '1%20OR%201=1', '']) {
    assert.equal((await jsonRequest(runtime.base, `/api/messages?accountId=${value}`)).response.status, 400);
  }
  assert.deepEqual(db.prepare('SELECT id,status,handled_at FROM messages ORDER BY id').all(), before);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
});
