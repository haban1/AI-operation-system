import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const root = path.resolve(import.meta.dirname, '..');

async function request(base, pathname, body) {
  const response = await fetch(base + pathname, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { response, data: await response.json() };
}

async function withServer(t, v2, operation) {
  const listener = http.createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'private-platform-reply-'));
  const dbPath = path.join(dir, 'test.db');
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: root,
    env: {
      ...process.env, NODE_ENV: 'test', PORT: String(port), DATABASE_PATH: dbPath,
      AUTH_ENABLED: 'false', AGENT_SHARED_TOKEN: '', QWEN_MODE: 'mock', RPA_MODE: 'simulated',
      AUTO_COLLECT_ENABLED: 'false', LOCAL_AGENT_AUTO_START: 'false', INSTANCE_LOCK_ENABLED: 'false',
      LOGIN_STATUS_POLL_ENABLED: 'false', ISSUE_DIAGNOSIS_ENABLED: 'false',
      CHANNEL_SPLIT_ENABLED: 'true', PLATFORM_CHANNEL_SPLIT_DOUYIN: 'true',
      MESSAGE_EVENT_LEDGER_ENABLED: 'true', PRIVATE_RECONCILIATION_ENABLED: 'true',
      PRIVATE_LIVE_RECHECK_ENABLED: 'true', PRIVATE_AUTO_SEND_V2_ENABLED: String(v2),
      COMMENT_CHANNEL_V2_ENABLED: 'false'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await Promise.race([new Promise(resolve => child.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 3000))]);
    }
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  let ready = false;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try { if ((await fetch(`${base}/api/health`)).ok) { ready = true; break; } } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(ready, stderr);
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA busy_timeout=15000');
  const account = db.prepare("SELECT * FROM accounts WHERE platform_code='douyin' ORDER BY id LIMIT 1").get();
  try { await operation({ base, db, account, stderr: () => stderr }); }
  finally { db.close(); }
}

function incoming(account, key, conversationId = `conversation-${key}`) {
  return {
    platformCode: 'douyin', accountId: account.id, messageType: 'PRIVATE_MESSAGE',
    externalId: `external-${key}`, userName: '私信证据用户', content: '你好',
    externalUrl: 'https://www.douyin.com/user/self',
    context: {
      conversationKey: conversationId, conversationId, messageId: `incoming-${key}`,
      direction: 'incoming', collectionSource: 'OPEN_CONVERSATION_TIMELINE',
      fullSource: true, sourceVerified: true, chatTitleVerified: true, previewOnly: false
    }
  };
}

function replied(message) {
  return {
    ...message,
    context: {
      ...message.context, alreadyHandled: true, platformReplyDetected: true,
      platformReplyText: '您好，请说明您具体想咨询的业务。',
      platformReplyEvidence: {
        conversationId: message.context.conversationId,
        incomingMessageId: message.context.messageId,
        outgoingMessageId: `outgoing-${message.context.messageId}`,
        outgoingDirection: 'outgoing', incomingIndex: 1, outgoingIndex: 2, timelineStable: true
      }
    }
  };
}

async function upsert(fixture, message) {
  const result = await request(fixture.base, '/api/agent/messages/upsert', message);
  assert.equal(result.response.status, 200, fixture.stderr());
  assert.equal(result.data.results[0].error, undefined, JSON.stringify(result.data));
  return result.data.results[0];
}

async function collect(fixture, messages) {
  const { base, db, account } = fixture;
  const stamp = new Date().toISOString();
  const jobId = Number(db.prepare(`INSERT INTO agent_jobs(device_id,job_type,payload,status,attempts,created_at,claimed_at,channel_type,queue_lane)
    VALUES(?,'COLLECT_MESSAGES',?,'RUNNING',1,?,?,'PRIVATE_MESSAGE','PRIVATE_MESSAGE')`).run(
    account.device_id, JSON.stringify({ platformCode: 'douyin', accountId: account.id, types: ['PRIVATE_MESSAGE'], channelType: 'PRIVATE_MESSAGE' }), stamp, stamp
  ).lastInsertRowid);
  const result = await request(base, `/api/agent/jobs/${jobId}/complete`, {
    status: 'SUCCESS', result: { messages, typeResults: [{ type: 'PRIVATE_MESSAGE', status: 'SUCCESS', count: messages.length }] }
  });
  assert.equal(result.response.status, 200, fixture.stderr());
}

test('已观察到平台回复的私信入库可见、保存实际回复与会话上下文，重采不重发', async t => {
  await withServer(t, false, async fixture => {
    const { db, account, base } = fixture;
    const source = incoming(account, 'new-handled');
    source.content = '澳门车可以在内地停留多久？';
    const observed = replied(source);
    const first = await upsert(fixture, observed);
    assert.equal(first.created, true);
    assert.equal(first.message.status, 'MANUAL_HANDLED');
    assert.equal(first.message.handled_by, 'PLATFORM_DETECTED');
    assert.ok(first.message.handled_at);
    assert.equal(first.message.reply_text, observed.context.platformReplyText);
    assert.ok(first.message.conversation_id);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM agent_jobs WHERE job_type='REPLY'").get().count, 0);
    const registry = db.prepare('SELECT * FROM message_processing_registry WHERE canonical_message_id=?').get(first.message.id);
    assert.equal(registry.processing_status, 'MANUAL_HANDLED');
    const visible = (await request(base, '/api/messages')).data.messages.find(item => item.id === first.message.id);
    assert.equal(visible.content, source.content);
    assert.equal(visible.reply_status.ai.replied, false);
    assert.equal(visible.reply_status.manual.replied, false);
    assert.equal(visible.reply_status.platform.replied, true);
    assert.equal((await request(base, `/api/messages/${first.message.id}/retry`, {})).response.status, 409);

    const repeated = await upsert(fixture, source);
    assert.equal(repeated.created, false);
    assert.equal(repeated.message.id, first.message.id);
    assert.equal(repeated.message.reply_text, observed.context.platformReplyText);
    assert.equal(JSON.parse(repeated.message.context_json).platformReplyDetected, true);
    const weaker = { ...source, externalId: 'changed-external-id', context: { ...source.context, sourceVerified: false, fullSource: false, previewOnly: true, collectionSource: 'CONVERSATION_LIST' } };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const retained = await upsert(fixture, weaker);
      assert.equal(retained.message.id, first.message.id);
      const retainedContext = JSON.parse(retained.message.context_json);
      assert.equal(retainedContext.platformReplyDetected, true);
      assert.equal(retainedContext.sourceVerified, true);
      assert.equal(retainedContext.collectionSource, 'OPEN_CONVERSATION_TIMELINE');
    }
    const future = await upsert(fixture, incoming(account, 'future-incoming', source.context.conversationId));
    assert.equal(future.message.conversation_id, first.message.conversation_id);
    assert.equal(future.message.handled_at, null);
    assert.equal(db.prepare('SELECT content,reply_text FROM messages WHERE conversation_id=? AND id<?').get(future.message.conversation_id, future.message.id).reply_text, observed.context.platformReplyText);
  });
});

test('私信平台回复证据撤销旧发送任务，保留删除记录且不将不完整证据当成已解决', async t => {
  await withServer(t, false, async fixture => {
    const { db, account } = fixture;
    for (const jobStatus of ['QUEUED', 'RUNNING']) {
      const source = incoming(account, `existing-${jobStatus}`);
      const first = await upsert(fixture, source);
      assert.ok(first.message.reply_job_id);
      db.prepare('UPDATE agent_jobs SET status=? WHERE id=?').run(jobStatus, first.message.reply_job_id);
      const changed = await upsert(fixture, replied(source));
      assert.equal(changed.created, false);
      assert.equal(changed.message.id, first.message.id);
      assert.equal(changed.message.status, 'MANUAL_HANDLED');
      assert.equal(changed.message.reply_job_id, null);
      assert.equal(db.prepare('SELECT status FROM agent_jobs WHERE id=?').get(first.message.reply_job_id).status, 'CANCELLED');
    }

    const source = incoming(account, 'deleted');
    const first = await upsert(fixture, source);
    const stamp = new Date().toISOString();
    db.prepare("UPDATE messages SET deleted_at=?,status='CLOSED',handled_at=?,handled_by='operator',handler_note='用户删除' WHERE id=?").run(stamp, stamp, first.message.id);
    const deleted = await upsert(fixture, replied(source));
    assert.equal(deleted.message.deleted_at, stamp);
    assert.equal(deleted.message.status, 'CLOSED');
    assert.equal(deleted.message.handled_by, 'operator');
    assert.equal(deleted.message.handler_note, '用户删除');

    const mutations = [
      message => { delete message.context.platformReplyEvidence; },
      message => { message.context.platformReplyEvidence.outgoingMessageId = ''; },
      message => { message.context.platformReplyEvidence.outgoingMessageId = message.context.messageId; },
      message => { message.context.platformReplyEvidence.outgoingDirection = 'incoming'; },
      message => { message.context.platformReplyEvidence.conversationId = 'other-conversation'; },
      message => { message.context.platformReplyEvidence.incomingMessageId = 'other-message'; },
      message => { message.context.platformReplyEvidence.outgoingIndex = 0; },
      message => { message.context.platformReplyEvidence.timelineStable = false; },
      message => { message.context.platformReplyText = ''; },
      message => { message.context.previewOnly = true; }
    ];
    for (const [index, mutate] of mutations.entries()) {
      const invalid = replied(incoming(account, `invalid-${index}`));
      mutate(invalid);
      const write = await upsert(fixture, invalid);
      assert.equal(write.message.status, 'MANUAL_REQUIRED', `case ${index}`);
      assert.equal(write.message.decision, 'PLATFORM_REPLY_UNVERIFIED', `case ${index}`);
      assert.equal(write.message.handled_at, null);
      assert.equal(write.message.reply_job_id, null);
    }
    const unsafeSource = incoming(account, 'existing-unverified');
    const unsafeBefore = await upsert(fixture, unsafeSource);
    const unsafeObservation = replied(unsafeSource);
    delete unsafeObservation.context.platformReplyEvidence;
    const unsafeAfter = await upsert(fixture, unsafeObservation);
    assert.equal(unsafeAfter.message.decision, 'PLATFORM_REPLY_UNVERIFIED');
    assert.equal(db.prepare('SELECT status FROM agent_jobs WHERE id=?').get(unsafeBefore.message.reply_job_id).status, 'CANCELLED');
  });
});

test('V2 新补采的已回复私信只入账和上下文，下一条来信仍可正常回复', async t => {
  await withServer(t, true, async fixture => {
    const { db, account } = fixture;
    const source = incoming(account, 'v2-new');
    await collect(fixture, [replied(source)]);
    const stored = db.prepare('SELECT * FROM messages WHERE external_id=?').get(source.externalId);
    assert.equal(stored.status, 'MANUAL_HANDLED');
    const event = db.prepare('SELECT * FROM message_events WHERE platform_message_id=?').get(source.externalId);
    assert.equal(event.reply_disposition, 'ALREADY_HANDLED');
    assert.equal(event.conversation_namespace, stored.conversation_key_snapshot);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM reply_batches').get().count, 0);
    const future = incoming(account, 'v2-next', source.context.conversationId);
    await collect(fixture, [future]);
    const batch = db.prepare('SELECT * FROM reply_batches ORDER BY id DESC LIMIT 1').get();
    assert.equal(batch.status, 'READY');
    assert.equal(batch.conversation_namespace, stored.conversation_key_snapshot);
    await collect(fixture, [source]);
    assert.equal(db.prepare('SELECT reply_disposition FROM message_events WHERE id=?').get(event.id).reply_disposition, 'ALREADY_HANDLED');
    assert.equal(db.prepare('SELECT agent_job_id FROM reply_batches WHERE id=?').get(batch.id).agent_job_id, batch.agent_job_id);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM conversations WHERE platform_code='douyin'").get().count, 1);
  });
});

test('V2 已有待发或发送不确定批次在平台回复补采后收敛，旧回执不能覆盖已处理状态', async t => {
  await withServer(t, true, async fixture => {
    const { db, account, base } = fixture;
    for (const state of ['READY', 'SENDING', 'SEND_UNCERTAIN']) {
      const source = incoming(account, `v2-existing-${state}`);
      await collect(fixture, [source]);
      const before = db.prepare('SELECT * FROM messages WHERE external_id=?').get(source.externalId);
      const batch = db.prepare('SELECT * FROM reply_batches WHERE generation_message_id=?').get(before.id);
      assert.equal(batch.status, 'READY');
      const jobState = state === 'SENDING' ? 'RUNNING' : state === 'SEND_UNCERTAIN' ? 'NEEDS_CONFIRMATION' : 'QUEUED';
      db.prepare('UPDATE reply_batches SET status=? WHERE id=?').run(state, batch.id);
      db.prepare('UPDATE agent_jobs SET status=? WHERE id=?').run(jobState, batch.agent_job_id);
      await collect(fixture, [replied(source)]);
      const after = db.prepare('SELECT * FROM messages WHERE id=?').get(before.id);
      assert.equal(after.status, 'MANUAL_HANDLED', state);
      assert.equal(after.reply_job_id, null);
      const closed = db.prepare('SELECT * FROM reply_batches WHERE id=?').get(batch.id);
      assert.equal(closed.status, 'COMPLETED', state);
      assert.equal(closed.invalidation_reason, 'PLATFORM_REPLY_DETECTED');
      assert.ok(closed.completed_at);
      assert.equal(db.prepare('SELECT reply_disposition FROM message_events WHERE platform_message_id=?').get(source.externalId).reply_disposition, 'ALREADY_HANDLED');
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM agent_jobs WHERE id=? AND status IN ('QUEUED','RUNNING')").get(batch.agent_job_id).count, 0);
      const stale = await request(base, `/api/agent/jobs/${batch.agent_job_id}/complete`, { status: 'SUCCESS', result: { stage: 'reply_sent' } });
      assert.equal(stale.data.ignored, true);
      assert.equal(db.prepare('SELECT handled_by FROM messages WHERE id=?').get(before.id).handled_by, 'PLATFORM_DETECTED');
      await collect(fixture, [incoming(account, `v2-followup-${state}`, source.context.conversationId)]);
      assert.equal(db.prepare('SELECT status FROM reply_batches WHERE conversation_namespace=? ORDER BY id DESC LIMIT 1').get(batch.conversation_namespace).status, 'READY');
    }
  });
});

test('V2 较早来信补回平台回复证据时保留较新来信的待发批次', async t => {
  await withServer(t, true, async fixture => {
    const { db, account } = fixture;
    const older = incoming(account, 'v2-older');
    const newer = incoming(account, 'v2-newer', older.context.conversationId);
    await collect(fixture, [older]);
    await collect(fixture, [newer]);
    const pending = db.prepare('SELECT * FROM messages WHERE external_id=?').get(newer.externalId);
    const batch = db.prepare('SELECT * FROM reply_batches WHERE generation_message_id=?').get(pending.id);
    await collect(fixture, [replied(older)]);
    assert.equal(db.prepare('SELECT status FROM messages WHERE external_id=?').get(older.externalId).status, 'MANUAL_HANDLED');
    assert.equal(db.prepare('SELECT status FROM reply_batches WHERE id=?').get(batch.id).status, 'READY');
    assert.equal(db.prepare('SELECT status FROM agent_jobs WHERE id=?').get(batch.agent_job_id).status, 'QUEUED');
    assert.equal(db.prepare('SELECT handled_at FROM messages WHERE id=?').get(pending.id).handled_at, null);
  });
});

for (const v2 of [false, true]) test(`${v2 ? 'V2' : 'V1'} 新补入的历史已回复私信不取代当前来信和待发版本`, async t => {
  await withServer(t, v2, async fixture => {
    const { db, account } = fixture;
    const newer = incoming(account, `late-history-newer-${v2}`);
    newer.occurredAt = '2026-09-09T10:00:00Z';
    const ingest = async message => v2 ? collect(fixture, [message]) : upsert(fixture, message);
    await ingest(newer);
    const pending = db.prepare('SELECT * FROM messages WHERE external_id=?').get(newer.externalId);
    const before = db.prepare('SELECT * FROM conversations WHERE id=?').get(pending.conversation_id);
    const older = replied(incoming(account, `late-history-older-${v2}`, newer.context.conversationId));
    older.occurredAt = '2026-09-09T09:00:00Z';
    await ingest(older);
    await ingest(older);
    const stored = db.prepare('SELECT * FROM messages WHERE external_id=?').get(older.externalId);
    assert.equal(stored.status, 'MANUAL_HANDLED');
    assert.equal(stored.conversation_id, pending.conversation_id);
    const after = db.prepare('SELECT * FROM conversations WHERE id=?').get(pending.conversation_id);
    assert.equal(after.last_incoming_message_id, pending.id, '补采历史不能成为当前待回复来信');
    assert.equal(after.version, before.version);
    assert.equal(after.ledger_version, before.ledger_version);
    assert.equal(after.last_incoming_event_id, before.last_incoming_event_id);
    assert.equal(db.prepare('SELECT status FROM agent_jobs WHERE id=?').get(pending.reply_job_id).status, 'QUEUED');
    if (v2) {
      const batch = db.prepare('SELECT * FROM reply_batches WHERE generation_message_id=?').get(pending.id);
      assert.equal(batch.status, 'READY');
      assert.equal(batch.conversation_version, after.ledger_version);
      const event = db.prepare('SELECT * FROM message_events WHERE source_message_id=?').get(stored.id);
      assert.equal(event.reply_disposition, 'ALREADY_HANDLED');
      assert.equal(event.conversation_id, pending.conversation_id);
    }
  });
});
