import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { startServer, stopChild, cleanupDir, jsonRequest } from './helpers/runtime.js';

test('account switch restores a recollected audience comment hidden by a stale self nickname', async t => {
  const runtime = await startServer();
  const db = new DatabaseSync(runtime.dbPath);
  t.after(async () => { db.close(); await stopChild(runtime.child); cleanupDir(runtime.dir); });
  const { data } = await jsonRequest(runtime.base, '/api/accounts');
  const account = data.accounts.find(item => item.platform_code === 'wechat_channels');
  db.prepare('UPDATE accounts SET platform_user_name=?,platform_user_aliases=? WHERE id=?')
    .run('九龄之酒', JSON.stringify(['九龄之酒']), account.id);
  const incoming = {
    platformCode: 'wechat_channels', accountId: account.id, messageType: 'COMMENT',
    externalId: 'account-switch-comment', userName: '九龄之酒', content: '什么是七免两低？',
    context: { sourceVideoKey: 'new-account-video', commentStableId: 'same-comment', sourceVerified: true }
  };
  const collect = message => jsonRequest(runtime.base, '/api/agent/messages/upsert', { method: 'POST', body: { messages: [message] } });
  const first = await collect(incoming);
  assert.equal(first.response.status, 200);
  assert.equal(first.data.results[0].message.status, 'IGNORED_SELF');
  const id = first.data.results[0].message.id;
  const current = { ...incoming, context: { ...incoming.context, accountUserName: '天河港澳社区', accountIdentitySource: 'wechat-channels-dom:account-info' } };
  const restored = await collect(current);
  assert.equal(restored.data.results[0].message.id, id);
  assert.equal(restored.data.results[0].message.status, 'MANUAL_REQUIRED');
  assert.equal(restored.data.results[0].message.decision, 'MANUAL_REQUIRED');
  assert.equal(restored.data.results[0].message.reply_job_id, null);
  assert.equal(JSON.parse(restored.data.results[0].message.context_json).identityAssessment.isSelf, false);
  assert.equal(db.prepare("SELECT count(*) AS n FROM agent_jobs WHERE job_type='REPLY'").get().n, 0);
  assert.deepEqual(JSON.parse(db.prepare('SELECT platform_user_aliases FROM accounts WHERE id=?').get(account.id).platform_user_aliases), ['天河港澳社区']);
  const visible = await jsonRequest(runtime.base, '/api/messages');
  assert.ok(visible.data.messages.some(message => message.id === id));
  const repeated = await collect(current);
  assert.equal(repeated.data.results[0].message.id, id);
  assert.equal(repeated.data.results[0].message.status, 'MANUAL_REQUIRED');
  const own = await collect({ ...current, externalId: 'current-own-comment', userName: '天河港澳社区', context: { ...current.context, commentStableId: 'own-comment' } });
  assert.equal(own.data.results[0].message.status, 'IGNORED_SELF');
  db.prepare('UPDATE messages SET deleted_at=? WHERE id=?').run(new Date().toISOString(), id);
  assert.ok((await collect(current)).data.results[0].message.deleted_at, 'recollection must preserve an intentional deletion');
});

test('微博主号改名后，自身评论和私信被忽略，相似昵称仍作为用户消息保留', async t => {
  const runtime = await startServer();
  const db = new DatabaseSync(runtime.dbPath);
  t.after(async () => { db.close(); await stopChild(runtime.child); cleanupDir(runtime.dir); });
  const account = db.prepare("SELECT * FROM accounts WHERE platform_code='weibo' AND profile_name='profile-weibo-main'").get();
  const collect = message => jsonRequest(runtime.base, '/api/agent/messages/upsert', { method: 'POST', body: { messages: [message] } });
  for (const messageType of ['COMMENT', 'PRIVATE_MESSAGE']) {
    const own = await collect({
      platformCode: 'weibo', accountId: account.id, messageType,
      externalId: `renamed-weibo-self-${messageType}`, userName: '天河港澳社区', content: '请问社区几点上班？'
    });
    assert.equal(own.response.status, 200);
    assert.equal(own.data.results[0].message.status, 'IGNORED_SELF');
    assert.equal(own.data.results[0].message.reply_job_id, null);
  }
  const audience = await collect({
    platformCode: 'weibo', accountId: account.id, messageType: 'PRIVATE_MESSAGE',
    externalId: 'renamed-weibo-audience', userName: '天河港澳社区居民', content: '请问社区几点上班？'
  });
  assert.equal(audience.response.status, 200);
  assert.equal(JSON.parse(audience.data.results[0].message.context_json).identityAssessment.isSelf, false);
  assert.notEqual(audience.data.results[0].message.status, 'IGNORED_SELF');
  assert.equal(account.display_name, '天河港澳社区-微博');
  assert.deepEqual(JSON.parse(account.platform_user_aliases), ['天河港澳社区']);
});

test('微博改名迁移仅更新默认微博主号，后续重启保留新采集到的身份', async t => {
  let runtime = await startServer();
  const db = new DatabaseSync(runtime.dbPath);
  t.after(async () => { db.close(); await stopChild(runtime.child); cleanupDir(runtime.dir); });
  await stopChild(runtime.child);
  const main = db.prepare("SELECT * FROM accounts WHERE platform_code='weibo' AND profile_name='profile-weibo-main'").get();
  db.prepare('UPDATE accounts SET platform_user_name=?,platform_user_aliases=? WHERE id=?')
    .run('改名前的主号', JSON.stringify(['改名前的主号']), main.id);
  db.prepare("UPDATE accounts SET platform_user_name='其他平台账号' WHERE platform_code='douyin'").run();
  const otherId = Number(db.prepare(`INSERT INTO accounts(platform_code,display_name,device_id,profile_name,enabled,login_status,created_at,platform_user_name)
    VALUES('weibo','第二个微博账号',?,'profile-weibo-secondary',1,'UNKNOWN',?,'其他微博账号')`)
    .run(main.device_id, main.created_at).lastInsertRowid);
  db.prepare('DELETE FROM schema_migrations WHERE id=?').run('2026-09-11-weibo-main-account-name-v1');

  runtime = await startServer({ dir: runtime.dir });
  const renamed = db.prepare('SELECT * FROM accounts WHERE id=?').get(main.id);
  assert.equal(renamed.platform_user_name, '天河港澳社区');
  assert.deepEqual(JSON.parse(renamed.platform_user_aliases), ['天河港澳社区']);
  assert.equal(renamed.platform_user_id, main.platform_user_id);
  assert.equal(db.prepare('SELECT platform_user_name FROM accounts WHERE id=?').get(otherId).platform_user_name, '其他微博账号');
  assert.equal(db.prepare("SELECT platform_user_name FROM accounts WHERE platform_code='douyin'").get().platform_user_name, '其他平台账号');

  await stopChild(runtime.child);
  db.prepare('UPDATE accounts SET platform_user_name=?,platform_user_aliases=? WHERE id=?')
    .run('后来采集到的昵称', JSON.stringify(['后来采集到的昵称']), main.id);
  runtime = await startServer({ dir: runtime.dir });
  const current = db.prepare('SELECT * FROM accounts WHERE id=?').get(main.id);
  assert.equal(current.platform_user_name, '后来采集到的昵称');
  assert.deepEqual(JSON.parse(current.platform_user_aliases), ['后来采集到的昵称']);
});
