import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { startServer, stopChild, cleanupDir, jsonRequest } from './helpers/runtime.js';

async function fixture(t) {
  const runtime = await startServer({ env: { ISSUE_DIAGNOSIS_ENABLED: 'false' } });
  const db = new DatabaseSync(runtime.dbPath);
  t.after(async () => { db.close(); await stopChild(runtime.child); cleanupDir(runtime.dir); });
  const account = db.prepare("SELECT * FROM accounts WHERE platform_code='douyin'").get();
  const request = (pathname, body) => jsonRequest(runtime.base, pathname, body === undefined ? {} : { method: 'POST', body });
  const queue = async () => {
    const response = await request('/api/platforms/douyin/collect', { accountId: account.id, types: ['COMMENT'] });
    assert.equal(response.response.status, 200, JSON.stringify(response.data));
    const jobId = response.data.jobId;
    db.prepare("UPDATE agent_jobs SET status='RUNNING',attempts=1 WHERE id=?").run(jobId);
    return jobId;
  };
  return { db, account, request, queue };
}

test('late collection after account disable cancels without messages, replies or a persistent block', async t => {
  const { db, account, request, queue } = await fixture(t);
  const jobId = await queue();
  db.prepare('UPDATE accounts SET enabled=0 WHERE id=?').run(account.id);
  const completed = await request(`/api/agent/jobs/${jobId}/complete`, {
    status: 'SUCCESS', result: { messages: [{ externalId: 'late-comment', messageType: 'COMMENT', userName: '居民', content: '社区在哪里？' }] }
  });
  assert.equal(completed.response.status, 200);
  assert.equal(completed.data.job.status, 'CANCELLED');
  assert.equal(JSON.parse(completed.data.job.result).ignoreReason, 'ACCOUNT_DISABLED_DURING_COLLECTION');
  assert.equal(db.prepare("SELECT count(*) n FROM messages WHERE external_id='late-comment'").get().n, 0);
  assert.equal(db.prepare("SELECT count(*) n FROM agent_jobs WHERE job_type='REPLY'").get().n, 0);
  assert.equal(db.prepare("SELECT count(*) n FROM runtime_blocks WHERE status='ACTIVE'").get().n, 0);
  db.prepare("UPDATE accounts SET enabled=1,login_status='READY' WHERE id=?").run(account.id);
  const nextJob = await queue();
  db.prepare("UPDATE agent_jobs SET status='QUEUED' WHERE id=?").run(nextJob);
  const claimed = await request('/api/agent/jobs/claim', { deviceId: account.device_id, platformCodes: ['douyin'] });
  assert.equal(claimed.data.job.id, nextJob);
});

test('a real persistence error remains blocked and is visible until issue resolution restores collection', async t => {
  const { db, account, request, queue } = await fixture(t);
  const jobId = await queue();
  const failed = await request(`/api/agent/jobs/${jobId}/complete`, {
    status: 'SUCCESS', result: { messages: [{ externalId: 'invalid-comment', messageType: 'COMMENT', content: '' }] }
  });
  assert.equal(failed.response.status, 500);
  const issue = db.prepare("SELECT * FROM issues WHERE related_type='ACCOUNT' AND CAST(related_id AS INTEGER)=?").get(account.id);
  assert.ok(issue);
  const runtime = (await request('/api/platforms/douyin/runtime')).data.platform;
  assert.equal(runtime.active_block_count, 1);
  assert.equal(runtime.blocked, true);
  assert.equal(runtime.task_execution_state, 'PAUSED');
  assert.equal(runtime.smart_reply_effective_state, 'STOPPED');
  await request(`/api/issues/${issue.id}/manual-resolve`, { resolution: '已修复采集输入并验证', resolvedBy: 'test' });
  const restored = (await request('/api/platforms/douyin/runtime')).data.platform;
  assert.equal(restored.blocked, false);
  assert.equal(restored.smart_reply_effective_state, 'RUNNING');
  assert.equal(db.prepare("SELECT count(*) n FROM runtime_blocks WHERE status='ACTIVE'").get().n, 0);
});

test('account block is reported without stopping other enabled accounts on the same platform', async t => {
  const { db, account, request, queue } = await fixture(t);
  const jobId = await queue();
  await request(`/api/agent/jobs/${jobId}/complete`, { status: 'SUCCESS', result: { messages: [{ externalId: 'bad', content: '' }] } });
  db.prepare("INSERT INTO accounts(platform_code,display_name,device_id,profile_name,enabled,login_status,created_at) VALUES('douyin','second',?,'second-profile',1,'READY',?)")
    .run(account.device_id, new Date().toISOString());
  const runtime = (await request('/api/platforms/douyin/runtime')).data.platform;
  assert.equal(runtime.active_block_count, 1);
  assert.equal(runtime.blocked, false);
  assert.equal(runtime.task_execution_state, 'RUNNING');
});
