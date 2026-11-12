import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-resolution-'));
process.env.DATABASE_PATH = path.join(dir, 'test.db');
process.env.SETTINGS_ENCRYPTION_KEY = '22'.repeat(32);
process.env.WECOM_WEBHOOK_URL = '';
const { db, now, row, run } = await import('../src/db.js');
const { config } = await import('../src/config.js');
const service = await import('../src/services/notification.js');
let sequence = 0;
const account = row("SELECT id FROM accounts WHERE platform_code='douyin' LIMIT 1");
const stamp = now();
const conversationId = Number(run(`INSERT INTO conversations(namespace,platform_code,account_id,message_type,
  created_at,updated_at,handling_mode) VALUES('resolve-test','douyin',?,'PRIVATE_MESSAGE',?,?,'HANDOFF_PENDING')`,
account.id, stamp, stamp).lastInsertRowid);

function fixture({ status = 'MANUAL_REQUIRED', notificationStatus = 'PENDING', metadata = {} } = {}) {
  const id = Number(run(`INSERT INTO messages(platform_code,account_id,message_type,external_id,user_name,content,
    status,conversation_id,created_at,updated_at) VALUES('douyin',?,'PRIVATE_MESSAGE',?,'测试用户','测试问题',?,?,?,?)`,
  account.id, `resolve-${++sequence}`, status, conversationId, stamp, stamp).lastInsertRowid);
  const input = { type: 'MANUAL_HANDOFF', title: '转人工', content: '待处理', messageId: id, conversationId,
    idempotencyKey: `resolve:${id}`, metadata: { handoff: true, ...metadata } };
  const notification = service.enqueueNotification(input).notification;
  run('UPDATE notifications SET status=? WHERE id=?', notificationStatus, notification.id);
  return { id, notification, input };
}
const notification = id => row('SELECT * FROM notifications WHERE id=?', id);
const close = id => run("UPDATE messages SET status='MANUAL_HANDLED',handled_at=? WHERE id=?", now(), id);

test('完成仅归档对应消息通知，保留新待办、普通通知、会话接管和幂等键', () => {
  const first = fixture(), next = fixture();
  const ordinary = service.enqueueNotification({ type: 'ALERT', title: '普通通知', content: '保留', messageId: first.id });
  const before = row('SELECT * FROM conversations WHERE id=?', conversationId);
  close(first.id);
  assert.equal(service.archiveResolvedMessageNotifications(first.id), 1);
  const archived = notification(first.notification.id);
  assert.equal(archived.status, 'CANCELLED');
  assert.equal(JSON.parse(archived.metadata_json).archiveReason, 'MESSAGE_RESOLVED');
  assert.equal(notification(next.notification.id).status, 'PENDING');
  assert.equal(notification(ordinary.notification.id).metadata_json, null);
  assert.equal(service.archiveResolvedMessageNotifications(first.id), 0);
  assert.equal(service.enqueueNotification(first.input).notification.id, first.notification.id);
  assert.deepEqual(row('SELECT * FROM conversations WHERE id=?', conversationId), before);
  assert.ok(!service.listHandoffNotifications().some(n => n.id === first.notification.id));
  assert.ok(service.listHandoffNotifications().some(n => n.id === next.notification.id));
});

test('未完成及仅送达的通知继续保留，完成后保留原送达证据', () => {
  const item = fixture({ notificationStatus: 'CONFIRMED' });
  run('UPDATE notifications SET confirmed_at=? WHERE id=?', stamp, item.notification.id);
  assert.equal(service.archiveResolvedMessageNotifications(item.id), 0);
  close(item.id);
  assert.equal(service.archiveResolvedMessageNotifications(item.id), 1);
  assert.equal(notification(item.notification.id).status, 'CONFIRMED');
  assert.equal(notification(item.notification.id).confirmed_at, stamp);
});

test('归档的失败记录不能手动重试、直接投递或被 worker 领取', async () => {
  const item = fixture({ notificationStatus: 'FAILED', metadata: { archivedAt: stamp } });
  assert.throws(() => service.requeueNotification(item.notification.id), { code: 'NOTIFICATION_NOT_RETRYABLE' });
  await service.deliverNotification(item.notification.id, { fetchImpl: () => assert.fail('不能发送归档通知') });
  run("UPDATE notifications SET status='PENDING' WHERE id=?", item.notification.id);
  let claimed;
  while ((claimed = service.claimPendingNotification())) {
    assert.notEqual(claimed.id, item.notification.id);
    run("UPDATE notifications SET status='CANCELLED' WHERE id=?", claimed.id);
  }
  run("UPDATE notifications SET status='SENDING',lease_expires_at=? WHERE id=?", '2000-01-01', item.notification.id);
  assert.equal(service.claimPendingNotification(), null);
  assert.equal(notification(item.notification.id).status, 'SENDING');
});

for (const failure of [false, true]) test(`发送途中完成人工处理，迟到${failure ? '失败' : '成功'}回执不能复活记录`, async () => {
  const item = fixture();
  config.wecomWebhookUrl = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abcdefgh12345678';
  let finish;
  const response = new Promise((resolve, reject) => { finish = failure ? reject : resolve; });
  const pending = service.deliverNotification(item.notification.id, { fetchImpl: () => response });
  assert.equal(notification(item.notification.id).status, 'SENDING');
  close(item.id);
  service.archiveResolvedMessageNotifications(item.id);
  finish(failure ? new Error('模拟离线') : new Response(JSON.stringify({ errcode: 0 }), { status: 200 }));
  const result = await pending;
  assert.equal(result.confirmed, false);
  assert.equal(notification(item.notification.id).status, 'CANCELLED');
  assert.equal(notification(item.notification.id).claimed_at, null);
  assert.equal(row('SELECT handling_mode FROM conversations WHERE id=?', conversationId).handling_mode, 'HANDOFF_PENDING');
});

test('完成后才入队的通知立即归档；启动补偿覆盖既有已关闭、软删除和已处理记录', () => {
  const late = fixture({ status: 'MANUAL_HANDLED' });
  assert.ok(JSON.parse(notification(late.notification.id).metadata_json).archivedAt);
  for (const mode of ['CLOSED', 'AUTO_REPLIED', 'MANUAL_HANDLED', 'deleted', 'handled']) {
    const item = fixture();
    if (mode === 'deleted' || mode === 'handled') run(`UPDATE messages SET ${mode === 'deleted' ? 'deleted_at' : 'handled_at'}=? WHERE id=?`, stamp, item.id);
    else run('UPDATE messages SET status=? WHERE id=?', mode, item.id);
    assert.equal(service.reconcileResolvedHandoffNotifications(), 1);
    assert.ok(JSON.parse(notification(item.notification.id).metadata_json).archivedAt);
  }
  assert.equal(service.reconcileResolvedHandoffNotifications(), 0);
});

test.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
