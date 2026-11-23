import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startServer, stopChild, cleanupDir, jsonRequest } from './helpers/runtime.js';

test('confirmed platform logout alerts survive unknown states and deduplicate until login recovers', async t => {
  const runtime = await startServer({ env: { WECOM_WEBHOOK_URL: '' } });
  const db = new DatabaseSync(runtime.dbPath, { timeout: 15000 });
  t.after(async () => {
    db.close();
    await stopChild(runtime.child);
    assert.ok(path.resolve(runtime.dir).startsWith(path.resolve(process.env.TEMP || process.env.TMP || '/tmp') + path.sep));
    cleanupDir(runtime.dir);
  });
  const { data } = await jsonRequest(runtime.base, '/api/accounts');
  const notificationCount = () => db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE type='PLATFORM_LOGIN_EXPIRED'").get().n;
  for (const platformCode of ['weibo', 'douyin', 'wechat_channels', 'bilibili']) {
    await t.test(platformCode, async () => {
      const account = data.accounts.find(item => item.platform_code === platformCode);
      assert.ok(account);
      const before = notificationCount();
      const sync = async payload => {
        const result = await jsonRequest(runtime.base, `/api/accounts/${account.id}/login-state`, {
          method: 'POST', body: { checkedAt: new Date().toISOString(), checkMode: 'POLL', ...payload }
        });
        assert.equal(result.response.status, 200);
        return result.data;
      };
      const ready = { state: 'READY', confidence: 'CONFIRMED', confirmedSamples: 1, evidence: ['authenticated-url', 'authenticated-text'] };
      const unknown = { state: 'UNKNOWN', confidence: 'UNCONFIRMED', confirmedSamples: 0, evidence: ['page-loading'] };
      const expired = { state: 'LOGIN', confidence: 'CONFIRMED', confirmedSamples: 3, evidence: ['login-text', 'consecutive-login-confirmations:3'] };
      await sync(ready);
      assert.equal((await sync(unknown)).alert, null);
      assert.equal((await sync({ ...expired, confirmedSamples: 1 })).alert, null);
      assert.equal(notificationCount(), before);
      const first = await sync(expired);
      assert.equal(first.account.login_status, 'EXPIRED');
      assert.equal(first.alert.status, 'NOT_CONFIGURED');
      assert.equal(notificationCount(), before + 1);
      await sync(unknown);
      assert.equal((await sync(expired)).alert, null);
      assert.equal((await sync(expired)).alert, null);
      assert.equal(notificationCount(), before + 1);
      const issues = () => db.prepare("SELECT status FROM issues WHERE source='LOGIN_MONITOR' AND category='ACCOUNT_LOGIN' AND related_type='ACCOUNT' AND related_id=? ORDER BY id").all(String(account.id));
      assert.deepEqual(issues().map(item => item.status), ['OPEN']);
      await sync(ready);
      assert.deepEqual(issues().map(item => item.status), ['RESOLVED']);
      await sync(unknown);
      assert.ok((await sync(expired)).alert);
      assert.equal(notificationCount(), before + 2);
      assert.deepEqual(issues().map(item => item.status), ['RESOLVED', 'OPEN']);
      if (platformCode === 'wechat_channels') {
        for (const action of ['manual-resolve','false-positive']) {
          const issueId = db.prepare("SELECT id FROM issues WHERE related_type='ACCOUNT' AND related_id=? AND status='OPEN' ORDER BY id DESC LIMIT 1").get(String(account.id)).id;
          const result = await jsonRequest(runtime.base, `/api/issues/${issueId}/${action}`, { method:'POST', body:{} });
          assert.equal(result.response.status, 200);
          const count=issues().length, notices=notificationCount();
          // Move only the isolated fixture's resolution time, never the poll clock.
          const setAge = ms => db.prepare('UPDATE issues SET resolved_at=? WHERE id=?').run(new Date(Date.now()-ms).toISOString(),issueId);
          setAge(119*60*1000);
          await sync(ready);
          const muted=await sync(expired);
          assert.equal(muted.account.login_status,'EXPIRED');
          assert.equal(muted.alert,null);
          assert.equal(issues().length,count);
          assert.equal(notificationCount(),notices);
          setAge(120*60*1000);
          assert.ok((await sync(expired)).alert);
          assert.equal(issues().length,count+1);
          assert.equal(notificationCount(),notices+1);
        }
      }
    });
  }
});
