import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mini-processing-'));
process.env.DATABASE_PATH = path.join(dir, 'processing.db');
process.env.INSTANCE_LOCK_ENABLED = 'false';
process.env.MINI_PROGRAM_APP_ID = 'app-1';
process.env.MINI_PROGRAM_SHARED_SECRET = 'processing-test-secret-at-least-32-characters';
process.env.MINI_PROGRAM_CALLBACK_URL = '';
process.env.WECOM_WEBHOOK_URL = '';
const { db, now, row, run } = await import('../src/db.js');
const { config } = await import('../src/config.js');
const { ingestMiniProgramMessage, requestMiniProgramHandoff } = await import('../src/services/mini-program-channel.js');
const { withConversationSerial } = await import('../src/services/conversation-store.js');
const { cancelConversationAutomation } = await import('../src/services/conversation-control.js');
const { enqueueMiniProgramReply, deliverMiniProgramCallback } = await import('../src/services/mini-program-callback.js');
const processing = await import('../src/services/mini-program-processing.js');
const { withMiniProgramProcessingClaim } = await import('../src/services/mini-program-processing-context.js');
let sequence = 0;
function seed(overrides = {}) {
  sequence += 1;
  const payload = { appId: 'app-1', conversationId: `c-${sequence}`, messageId: `m-${sequence}`, userId: `u-${sequence}`, text: 'private source text', sentAt: now(), ...overrides };
  ingestMiniProgramMessage(payload);
  return row('SELECT * FROM messages WHERE external_id=?', `mini-program:app-1:message:${payload.messageId}`);
}
function job(message) { return row('SELECT * FROM mini_program_processing_jobs WHERE message_id=?', message.id); }
function deferred() { return Promise.withResolvers(); }
test.beforeEach(() => {
  db.exec('BEGIN; PRAGMA defer_foreign_keys=ON; DELETE FROM notifications; DELETE FROM mini_program_callback_outbox; DELETE FROM mini_program_processing_jobs; DELETE FROM agent_jobs; DELETE FROM reply_batches; DELETE FROM messages; DELETE FROM mini_program_users; DELETE FROM conversations; COMMIT;');
});
test.after(() => { processing.stopMiniProgramProcessingWorker(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test('durable claims recover expired leases, never steal live leases, and roll back failed claim writes', () => {
  const message = seed();
  db.exec("CREATE TEMP TRIGGER fail_claim BEFORE UPDATE OF status ON mini_program_processing_jobs WHEN NEW.status='RUNNING' BEGIN SELECT RAISE(ABORT,'CLAIM_FAILURE'); END");
  assert.throws(() => processing.claimMiniProgramProcessingJob(), /CLAIM_FAILURE/);
  assert.equal(job(message).attempt_count, 0);
  assert.equal(job(message).status, 'PENDING');
  db.exec('DROP TRIGGER fail_claim');
  const first = processing.claimMiniProgramProcessingJob({ leaseMs: 7000 });
  assert.equal(first.message_id, message.id);
  assert.equal(first.attempt_count, 1);
  assert.equal(Date.parse(first.lease_expires_at) - Date.parse(first.claimed_at), 7000);
  assert.equal(processing.claimMiniProgramProcessingJob(), null);
  run("UPDATE mini_program_processing_jobs SET lease_expires_at='2000-01-01T00:00:00.000Z' WHERE id=?", first.id);
  const recovered = processing.claimMiniProgramProcessingJob();
  assert.equal(recovered.id, first.id);
  assert.equal(recovered.attempt_count, 2);
  assert.equal(recovered.status, 'RUNNING');
});

test('success and business handoff complete once without retrying', async () => {
  const message = seed();
  await processing.processMiniProgramJobOnce({ processMessage: async id => requestMiniProgramHandoff({ conversationId: message.conversation_id, messageId: id }) });
  assert.equal(job(message).status, 'COMPLETED');
  assert.equal(job(message).attempt_count, 1);
  assert.equal(job(message).claimed_at, null);
  assert.ok(job(message).completed_at);
  assert.equal(await processing.processMiniProgramJobOnce({ processMessage: () => assert.fail('completed job ran twice') }), null);
  assert.equal(row('SELECT COUNT(*) AS n FROM notifications').n, 1);
});

test('failed completion write leaves the running lease recoverable', async () => {
  const message = seed();
  db.exec("CREATE TEMP TRIGGER fail_completion BEFORE UPDATE OF status ON mini_program_processing_jobs WHEN NEW.status='COMPLETED' BEGIN SELECT RAISE(ABORT,'COMPLETION_FAILURE'); END");
  await assert.rejects(processing.processMiniProgramJobOnce({ processMessage: async () => {} }), /COMPLETION_FAILURE/);
  assert.equal(job(message).status, 'RUNNING');
  assert.equal(job(message).completed_at, null);
  db.exec('DROP TRIGGER fail_completion');
  run("UPDATE mini_program_processing_jobs SET lease_expires_at='2000-01-01' WHERE id=?", job(message).id);
  await processing.processMiniProgramJobOnce({ processMessage: async () => {} });
  assert.equal(job(message).status, 'COMPLETED');
});

test('one initial failure plus three retries uses literal 5s, 30s, 2m then atomically hands off', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-09-06T00:00:00.000Z') });
  const message = seed();
  const failure = Object.assign(new Error(`${message.content} ${config.miniProgramSharedSecret} ${'z'.repeat(2000)}`), { code: 'E_PROCESSING' });
  const processMessage = async () => { throw failure; };
  for (const [attempt, delay] of [[1, 5000], [2, 30000], [3, 120000]]) {
    await processing.processMiniProgramJobOnce({ processMessage });
    const saved = job(message);
    assert.equal(saved.status, 'RETRY_WAIT');
    assert.equal(saved.attempt_count, attempt);
    assert.equal(Date.parse(saved.available_at) - Date.now(), delay);
    assert.equal(saved.claimed_at, null);
    assert.ok(saved.last_error_message.length <= 1000);
    assert.ok(!saved.last_error_message.includes(message.content));
    assert.ok(!saved.last_error_message.includes(config.miniProgramSharedSecret));
    assert.equal(row('SELECT COUNT(*) AS n FROM notifications').n, 0);
    t.mock.timers.tick(delay - 1);
    assert.equal(processing.claimMiniProgramProcessingJob(), null);
    t.mock.timers.tick(1);
  }
  await processing.processMiniProgramJobOnce({ processMessage });
  assert.equal(job(message).status, 'FAILED');
  assert.equal(job(message).attempt_count, 4);
  assert.equal(job(message).lease_expires_at, null);
  const notification = row('SELECT * FROM notifications');
  assert.equal(notification.type, 'MINI_PROGRAM_PROCESSING_FAILED');
  assert.equal(JSON.parse(notification.metadata_json).reason, '消息处理技术异常');
  assert.equal(row('SELECT handling_mode FROM conversations WHERE id=?', message.conversation_id).handling_mode, 'HANDOFF_PENDING');
  assert.equal(await processing.processMiniProgramJobOnce({ processMessage }), null);
  assert.equal(row('SELECT COUNT(*) AS n FROM notifications').n, 1);
});

test('expired final attempt becomes failed with handoff without a fifth execution', async () => {
  const message = seed();
  run("UPDATE mini_program_processing_jobs SET status='RUNNING',attempt_count=4,claimed_at='2000-01-01',lease_expires_at='2000-01-01' WHERE id=?", job(message).id);
  await processing.processMiniProgramJobOnce({ processMessage: () => assert.fail('fifth execution') });
  assert.equal(job(message).status, 'FAILED');
  assert.equal(job(message).attempt_count, 4);
  assert.equal(row('SELECT COUNT(*) AS n FROM notifications').n, 1);
});

test('exhaustion notification failure rolls back FAILED and handoff for lease recovery', async () => {
  const message = seed();
  run('UPDATE mini_program_processing_jobs SET attempt_count=3 WHERE id=?', job(message).id);
  db.exec("CREATE TEMP TRIGGER fail_exhaustion BEFORE INSERT ON notifications BEGIN SELECT RAISE(ABORT,'EXHAUSTION_FAILURE'); END");
  await assert.rejects(processing.processMiniProgramJobOnce({ processMessage: async () => { throw new Error('upstream'); } }), /EXHAUSTION_FAILURE/);
  assert.equal(job(message).status, 'RUNNING');
  assert.equal(row('SELECT handling_mode FROM conversations WHERE id=?', message.conversation_id).handling_mode, 'BOT_ACTIVE');
  assert.equal(row('SELECT status FROM messages WHERE id=?', message.id).status, 'NEW');
  db.exec('DROP TRIGGER fail_exhaustion');
  run("UPDATE mini_program_processing_jobs SET lease_expires_at='2000-01-01' WHERE id=?", job(message).id);
  await processing.processMiniProgramJobOnce({ processMessage: () => assert.fail('must recover exhausted lease') });
  assert.equal(job(message).status, 'FAILED');
});

for (const outcome of ['success', 'failure']) test(`stale ${outcome} cannot overwrite a reclaimed processing lease`, async () => {
  const message = seed();
  const started = deferred(); const release = deferred();
  const pending = processing.processMiniProgramJobOnce({ processMessage: async () => { started.resolve(); await release.promise; if (outcome === 'failure') throw new Error('stale'); } });
  await started.promise;
  run("UPDATE mini_program_processing_jobs SET lease_expires_at='2000-01-01' WHERE id=?", job(message).id);
  const { exhausted, ...replacement } = processing.claimMiniProgramProcessingJob();
  release.resolve(); await pending;
  assert.deepEqual({ ...job(message) }, replacement);
  assert.equal(row('SELECT COUNT(*) AS n FROM notifications').n, 0);
});

test('retrying earlier message blocks later processing only in the same conversation', async () => {
  const first = seed({ conversationId: 'ordered', userId: 'ordered-user' });
  const second = seed({ conversationId: 'ordered', userId: 'ordered-user' });
  const unrelated = seed();
  run("UPDATE mini_program_processing_jobs SET status='RETRY_WAIT',available_at='2099-01-01' WHERE id=?", job(first).id);
  assert.equal(processing.claimMiniProgramProcessingJob().message_id, unrelated.id);
  assert.equal(processing.claimMiniProgramProcessingJob(), null);
  assert.equal(job(second).status, 'PENDING');
});

test('handoff atomically cancels callback, queued Agent reply, message and reply batch', () => {
  const message = seed();
  const callback = enqueueMiniProgramReply({ message, replyText: 'answer' });
  run("UPDATE messages SET status='REPLY_QUEUED' WHERE id=?", message.id);
  const stamp = now();
  run("INSERT INTO agent_jobs(device_id,job_type,payload,status,created_at) VALUES(?,'REPLY',?,'QUEUED',?)", row('SELECT id FROM devices LIMIT 1').id, JSON.stringify({ messageId: message.id }), stamp);
  run("INSERT INTO reply_batches(platform_code,account_id,channel_type,conversation_id,conversation_namespace,conversation_version,status,first_pending_at,created_at,updated_at) VALUES('mini_program',?,'PRIVATE_MESSAGE',?,?,1,'READY',?,?,?)", message.account_id, message.conversation_id, message.conversation_key_snapshot, stamp, stamp, stamp);
  db.exec("CREATE TEMP TRIGGER fail_cancel BEFORE UPDATE OF status ON mini_program_callback_outbox BEGIN SELECT RAISE(ABORT,'CANCEL_FAILURE'); END");
  assert.throws(() => requestMiniProgramHandoff({ conversationId: message.conversation_id }), /CANCEL_FAILURE/);
  assert.equal(row('SELECT status FROM agent_jobs').status, 'QUEUED');
  assert.equal(row('SELECT status FROM reply_batches').status, 'READY');
  assert.equal(row('SELECT handling_mode FROM conversations WHERE id=?', message.conversation_id).handling_mode, 'BOT_ACTIVE');
  db.exec('DROP TRIGGER fail_cancel');
  const cancelled = cancelConversationAutomation(message.conversation_id);
  assert.deepEqual(cancelled, { jobs: 1, messages: 1, batches: 1, callbacks: 1 });
  assert.equal(row('SELECT status FROM mini_program_callback_outbox WHERE id=?', callback.id).status, 'CANCELLED');
});

test('SENDING callback holds the conversation lock until settled before handoff', async () => {
  const message = seed();
  const callback = enqueueMiniProgramReply({ message, replyText: 'answer' });
  config.miniProgramCallbackUrl = 'http://127.0.0.1:23456/callback';
  const started = deferred(); const release = deferred();
  const delivery = deliverMiniProgramCallback(callback, { fetchImpl: async () => { started.resolve(); await release.promise; return new Response('{}'); } });
  await Promise.race([started.promise, delivery.then(result => assert.fail(`callback did not start: ${result.status} ${result.error_message}`))]);
  const handoff = withConversationSerial(message.conversation_id, () => requestMiniProgramHandoff({ conversationId: message.conversation_id }));
  await new Promise(setImmediate);
  assert.equal(row('SELECT handling_mode FROM conversations WHERE id=?', message.conversation_id).handling_mode, 'BOT_ACTIVE');
  assert.equal(row('SELECT status FROM mini_program_callback_outbox').status, 'SENDING');
  release.resolve(); await delivery; await handoff;
  assert.equal(row('SELECT status FROM mini_program_callback_outbox').status, 'SENT');
  assert.equal(row('SELECT handling_mode FROM conversations WHERE id=?', message.conversation_id).handling_mode, 'HANDOFF_PENDING');
  config.miniProgramCallbackUrl = '';
});

test('worker start is idempotent, suppresses overlapping ticks and stop prevents new work', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const first = seed(); const second = seed();
  const started = deferred(); const release = deferred();
  const processMessage = async () => { started.resolve(); await release.promise; };
  const timer = processing.startMiniProgramProcessingWorker({ processMessage, intervalMs: 1000 });
  assert.equal(processing.startMiniProgramProcessingWorker({ processMessage }), timer);
  t.mock.timers.tick(1000); await started.promise;
  t.mock.timers.tick(5000); await new Promise(setImmediate);
  assert.equal(job(second).attempt_count, 0);
  release.resolve(); await new Promise(setImmediate);
  assert.equal(job(first).status, 'COMPLETED');
  processing.stopMiniProgramProcessingWorker();
  t.mock.timers.tick(5000); await new Promise(setImmediate);
  assert.equal(job(second).attempt_count, 0);
});

test('active processing renews its lease across the original expiry and cleans up renewal on completion', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: Date.parse('2026-09-06T08:00:00.000Z') });
  const message = seed(); const entered = deferred(); const release = deferred();
  const pending = processing.processMiniProgramJobOnce({ processMessage: async () => { entered.resolve(); await release.promise; } });
  try {
    await entered.promise;
    const first = job(message);
    t.mock.timers.tick(10000);
    assert.ok(Date.parse(job(message).lease_expires_at) > Date.parse(first.lease_expires_at));
    t.mock.timers.tick(10000); t.mock.timers.tick(10001);
    assert.equal(processing.claimMiniProgramProcessingJob(), null);
    assert.equal(job(message).attempt_count, 1);
  } finally { release.resolve(); await pending; }
  const completed = job(message);
  t.mock.timers.tick(60000);
  assert.deepEqual(job(message), completed);
});

test('failed renewal expires closed and stops later handoff writes without a replacement worker', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: Date.parse('2026-09-06T09:00:00.000Z') });
  const message = seed(); const entered = deferred(); const release = deferred();
  const before = {
    message: row('SELECT * FROM messages WHERE id=?', message.id),
    conversation: row('SELECT * FROM conversations WHERE id=?', message.conversation_id)
  };
  let lostError = null;
  const pending = processing.processMiniProgramJobOnce({ processMessage: async () => {
    entered.resolve(); await release.promise;
    try { requestMiniProgramHandoff({ conversationId: message.conversation_id, messageId: message.id }); }
    catch (error) { lostError = error; throw error; }
  } });
  await entered.promise;
  const initialClaim = job(message);
  db.exec("CREATE TEMP TRIGGER fail_renewal BEFORE UPDATE OF lease_expires_at ON mini_program_processing_jobs WHEN NEW.status='RUNNING' BEGIN SELECT RAISE(ABORT,'PRIVATE_RENEWAL_DATABASE_TEXT'); END");
  try {
    t.mock.timers.tick(10000); t.mock.timers.tick(10000); t.mock.timers.tick(10001);
    release.resolve(); await pending;
    assert.equal(lostError?.code, 'MINI_PROGRAM_PROCESSING_LEASE_LOST');
    assert.ok(!lostError.message.includes('PRIVATE_RENEWAL_DATABASE_TEXT'));
    assert.deepEqual(job(message), initialClaim, 'expired worker must not finalize or renew its lease');
    assert.deepEqual(row('SELECT * FROM messages WHERE id=?', message.id), before.message);
    assert.deepEqual(row('SELECT * FROM conversations WHERE id=?', message.conversation_id), before.conversation);
    assert.equal(row('SELECT COUNT(*) AS n FROM notifications').n, 0);
    assert.equal(row('SELECT COUNT(*) AS n FROM mini_program_callback_outbox').n, 0);
  } finally {
    release.resolve(); await pending;
    db.exec('DROP TRIGGER fail_renewal');
  }
  const recovered = processing.claimMiniProgramProcessingJob();
  assert.equal(recovered.attempt_count, 2);
});

test('HANDOFF_PENDING without a durable notification cannot complete and repairs through retry', async () => {
  const message = seed();
  run("UPDATE conversations SET handling_mode='HANDOFF_PENDING',human_followup_state='WAITING' WHERE id=?", message.conversation_id);
  db.exec("CREATE TEMP TRIGGER fail_orphan_handoff BEFORE INSERT ON notifications BEGIN SELECT RAISE(ABORT,'PRIVATE_ORPHAN_FAILURE'); END");
  try {
    await processing.processMiniProgramJobOnce({ processMessage: () => assert.fail('pending handoff must not run RAG') });
    assert.equal(job(message).status, 'RETRY_WAIT');
    assert.equal(row('SELECT COUNT(*) AS n FROM notifications').n, 0);
    assert.ok(!job(message).last_error_message.includes('PRIVATE_ORPHAN_FAILURE'));
  } finally { db.exec('DROP TRIGGER fail_orphan_handoff'); }
  run('UPDATE mini_program_processing_jobs SET available_at=? WHERE id=?', now(), job(message).id);
  await processing.processMiniProgramJobOnce({ processMessage: () => assert.fail('recovery must not run RAG') });
  assert.equal(job(message).status, 'COMPLETED');
  assert.equal(row('SELECT COUNT(*) AS n FROM notifications').n, 1);
});

function serverReviewScenario(script) {
  const databasePath = path.join(dir, `review-${++sequence}.db`);
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    const { db,row,run,now } = await import('./src/db.js');
    const { config } = await import('./src/config.js');
    const { ingestMiniProgramMessage } = await import('./src/services/mini-program-channel.js');
    const { withConversationSerial } = await import('./src/services/conversation-store.js');
    const { processMiniProgramJobOnce } = await import('./src/services/mini-program-processing.js');
    const server = await import('./src/server.js');
    const { saveMasterSwitch } = await import('./src/services/settings.js'); saveMasterSwitch(true);
    ${script}
    process.exit = code => { process.exitCode=code; }; process.emit('SIGTERM');
  `], { cwd: path.resolve(import.meta.dirname, '..'), encoding: 'utf8', timeout: 20000,
    env: { ...process.env, DATABASE_PATH: databasePath, PORT: '0', AUTH_ENABLED: 'false', LOCAL_AGENT_AUTO_START: 'false', AUTO_COLLECT_ENABLED: 'false', QWEN_MODE: 'mock', RPA_MODE: 'simulated', RAG_FORMAL_ROUTING_ENABLED: 'true' } });
  assert.equal(child.status, 0, [child.error?.message, child.stderr, child.stdout].filter(Boolean).join('\n'));
  assert.ok(!child.stderr.includes('PRIVATE_HANDOFF_DATABASE_TEXT'));
}

test('real mini handoff INSERT failure rolls back all effects and retries without private issue text', () => serverReviewScenario(`
  ingestMiniProgramMessage({appId:'app-1',conversationId:'atomic',messageId:'atomic',userId:'atomic-user',text:'转人工',sentAt:now()});
  const message = row('SELECT * FROM messages');
  db.exec("CREATE TEMP TRIGGER fail_handoff BEFORE INSERT ON notifications BEGIN SELECT RAISE(ABORT,'PRIVATE_HANDOFF_DATABASE_TEXT'); END");
  await processMiniProgramJobOnce({processMessage:id=>server.processMessageWithRegistry(id)});
  assert.equal(row('SELECT status FROM mini_program_processing_jobs').status,'RETRY_WAIT');
  assert.equal(row('SELECT handling_mode FROM conversations').handling_mode,'BOT_ACTIVE');
  assert.equal(row('SELECT status FROM messages').status,'NEW');
  assert.equal(row('SELECT COUNT(*) AS n FROM notifications').n,0);
  assert.equal(row('SELECT COUNT(*) AS n FROM issues').n,0);
  assert.ok(!row('SELECT last_error_message FROM mini_program_processing_jobs').last_error_message.includes('PRIVATE_HANDOFF_DATABASE_TEXT'));
  db.exec('DROP TRIGGER fail_handoff');
  run('UPDATE mini_program_processing_jobs SET available_at=?',now());
  await processMiniProgramJobOnce({processMessage:id=>server.processMessageWithRegistry(id)});
  assert.equal(row('SELECT status FROM mini_program_processing_jobs').status,'COMPLETED');
  assert.equal(row('SELECT handling_mode FROM conversations').handling_mode,'HANDOFF_PENDING');
  assert.equal(row('SELECT COUNT(*) AS n FROM notifications').n,1);
  assert.equal(row('SELECT COUNT(*) AS n FROM issues').n,0);
`));

test('direct registry processing honors the conversation lock without an implicit bypass', () => serverReviewScenario(`
  ingestMiniProgramMessage({appId:'app-1',conversationId:'locked',messageId:'locked',userId:'locked-user',text:'你好',sentAt:now()});
  const message=row('SELECT * FROM messages');
  const entered=Promise.withResolvers(); const release=Promise.withResolvers();
  const held=withConversationSerial(message.conversation_id,async()=>{entered.resolve();await release.promise;});
  await entered.promise;
  const direct=server.processMessageWithRegistry(message.id);
  await new Promise(setImmediate);
  assert.equal(row('SELECT COUNT(*) AS n FROM mini_program_callback_outbox').n,0);
  assert.equal(row('SELECT status FROM messages').status,'NEW');
  release.resolve(); await held; await direct;
  assert.equal(row('SELECT status FROM messages').status,'REPLY_QUEUED');
  assert.equal(row('SELECT COUNT(*) AS n FROM mini_program_callback_outbox').n,1);
`));

test('copied claim context waits for a SENDING callback lock before registry processing', () => serverReviewScenario(`
  const {withMiniProgramProcessingClaim}=await import('./src/services/mini-program-processing-context.js');
  const {claimMiniProgramProcessingJob}=await import('./src/services/mini-program-processing.js');
  const {enqueueMiniProgramReply,deliverMiniProgramCallback}=await import('./src/services/mini-program-callback.js');
  config.miniProgramCallbackUrl='http://127.0.0.1:23456/callback';
  ingestMiniProgramMessage({appId:'app-1',conversationId:'copied-claim',messageId:'copied-claim',userId:'copied-user',text:'你好',sentAt:now()});
  const message=row('SELECT * FROM messages');
  const callback=enqueueMiniProgramReply({message,replyText:'existing reply'});
  const entered=Promise.withResolvers(); const release=Promise.withResolvers();
  const sending=deliverMiniProgramCallback(callback,{fetchImpl:async()=>{entered.resolve();await release.promise;return new Response('{}');}});
  await entered.promise;
  const claim=claimMiniProgramProcessingJob(); let processed=false;
  const pending=withMiniProgramProcessingClaim({...claim},async()=>{processed=true;await server.processMessageWithRegistry(message.id);});
  try {
    await new Promise(setImmediate);
    assert.equal(processed,false,'copied live claim is not proof of lock ownership');
    assert.equal(row('SELECT status FROM mini_program_callback_outbox').status,'SENDING');
  } finally { release.resolve(); await sending; await pending; }
  assert.equal(processed,true);
  assert.equal(row('SELECT status FROM mini_program_callback_outbox').status,'SENT');
  assert.equal(row('SELECT status FROM messages').status,'AUTO_REPLIED');
`));

for (const replacement of [false, true]) test(`copied claim waiting for lock fails closed when ${replacement ? 'reclaimed' : 'expired'}`, async () => {
  const message = seed(); const claim = processing.claimMiniProgramProcessingJob();
  const entered = deferred(); const release = deferred();
  const held = withConversationSerial(message.conversation_id, async () => { entered.resolve(); await release.promise; });
  await entered.promise;
  const before = {
    message: row('SELECT * FROM messages WHERE id=?', message.id),
    conversation: row('SELECT * FROM conversations WHERE id=?', message.conversation_id)
  };
  let processed = false;
  const pending = Promise.resolve(withMiniProgramProcessingClaim({ ...claim }, () => { processed = true; return requestMiniProgramHandoff({ conversationId: message.conversation_id }); }));
  const rejected = assert.rejects(pending, error => error.code === 'MINI_PROGRAM_PROCESSING_LEASE_LOST');
  run("UPDATE mini_program_processing_jobs SET lease_expires_at='2000-01-01' WHERE id=?", claim.id);
  if (replacement) processing.claimMiniProgramProcessingJob();
  const durableJob = job(message);
  release.resolve(); await held; await rejected;
  assert.equal(processed, false);
  assert.deepEqual(job(message), durableJob);
  assert.deepEqual(row('SELECT * FROM messages WHERE id=?', message.id), before.message);
  assert.deepEqual(row('SELECT * FROM conversations WHERE id=?', message.conversation_id), before.conversation);
  assert.equal(row('SELECT COUNT(*) AS n FROM notifications').n, 0);
});

test('claim context cannot outlive its active conversation lock', async () => {
  const message = seed(); const claim = processing.claimMiniProgramProcessingJob();
  const release = deferred(); let detached;
  await withMiniProgramProcessingClaim(claim, () => {
    detached = release.promise.then(() => requestMiniProgramHandoff({ conversationId: message.conversation_id }));
  });
  const rejected = assert.rejects(detached, error => error.code === 'MINI_PROGRAM_PROCESSING_LEASE_LOST');
  release.resolve(); await rejected;
  assert.equal(row('SELECT handling_mode FROM conversations WHERE id=?', message.conversation_id).handling_mode, 'BOT_ACTIVE');
  assert.equal(row('SELECT COUNT(*) AS n FROM notifications').n, 0);
});

for (const staleResult of ['ANSWERED', 'NO_ANSWER', 'UNAVAILABLE']) test(`two real processes fence stale RAG ${staleResult} after replacement completion`, { timeout: 20000 }, async () => {
  const firstRequest = deferred();
  let waitingResponse; let firstPayload; let requests = 0;
  const rag = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const payload = JSON.parse(raw); requests += 1;
    if (requests === 1) { waitingResponse = res; firstPayload = payload; firstRequest.resolve(); return; }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ requestId: payload.requestId, result: 'ANSWERED', snapshot: payload.snapshot, answer: { text: 'replacement answer' }, grounding: { confidence: 0.96, sourceReferences: [{ documentId: 'doc', chunkId: 'chunk' }] } }));
  });
  await new Promise(resolve => rag.listen(0, '127.0.0.1', resolve));
  const databasePath = path.join(dir, `cross-process-${++sequence}.db`);
  const children = []; let observer;
  function startWorker(label) {
    const completion = deferred(); let output = '';
    const child = spawn(process.execPath, ['--input-type=module', '-e', `
      const {row,now}=await import('./src/db.js');
      const {config}=await import('./src/config.js'); config.ragBaseUrl=${JSON.stringify(`http://127.0.0.1:${rag.address().port}`)};
      const {ingestMiniProgramMessage}=await import('./src/services/mini-program-channel.js');
      const {processMiniProgramJobOnce}=await import('./src/services/mini-program-processing.js');
      const server=await import('./src/server.js');
      const {saveMasterSwitch}=await import('./src/services/settings.js'); saveMasterSwitch(true);
      if (!row('SELECT id FROM messages')) ingestMiniProgramMessage({appId:'app-1',conversationId:'cross-process',messageId:'cross-process',userId:'cross-process-user',text:'办理业务需要什么材料？',sentAt:now()});
      await processMiniProgramJobOnce({processMessage:id=>server.processMessageWithRegistry(id)});
      process.exit=code=>{process.exitCode=code;}; process.emit('SIGTERM');
    `], { cwd: path.resolve(import.meta.dirname, '..'), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, DATABASE_PATH: databasePath, PORT: '0', AUTH_ENABLED: 'false', LOCAL_AGENT_AUTO_START: 'false', AUTO_COLLECT_ENABLED: 'false', QWEN_MODE: 'mock', RPA_MODE: 'simulated', RAG_FORMAL_ROUTING_ENABLED: 'true' } });
    child.stdout.on('data', chunk => { output = (output + chunk).slice(-12000); });
    child.stderr.on('data', chunk => { output = (output + chunk).slice(-12000); });
    child.on('exit', code => completion.resolve({ code, label, output }));
    children.push(child); return completion.promise;
  }
  try {
    const first = startWorker('first');
    await Promise.race([firstRequest.promise, first.then(result => assert.fail(JSON.stringify(result)))]);
    observer = new DatabaseSync(databasePath);
    observer.prepare("UPDATE mini_program_processing_jobs SET lease_expires_at='2000-01-01T00:00:00.000Z'").run();
    const replacement = await startWorker('replacement');
    assert.equal(replacement.code, 0, replacement.output);
    const snapshot = () => Object.fromEntries(['conversations','messages','mini_program_callback_outbox','notifications','issues','mini_program_processing_jobs','message_processing_registry'].map(table => [table, observer.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
    const afterReplacement = snapshot();
    assert.equal(afterReplacement.mini_program_processing_jobs[0].status, 'COMPLETED');
    assert.equal(afterReplacement.mini_program_processing_jobs[0].attempt_count, 2);
    assert.equal(afterReplacement.messages[0].reply_text, 'replacement answer');
    waitingResponse.setHeader('Content-Type', 'application/json');
    if (staleResult === 'UNAVAILABLE') { waitingResponse.writeHead(503); waitingResponse.end('{}'); }
    else waitingResponse.end(JSON.stringify({ requestId: firstPayload.requestId, result: staleResult, snapshot: firstPayload.snapshot, answer: staleResult === 'ANSWERED' ? { text: 'stale answer' } : undefined, grounding: { confidence: staleResult === 'ANSWERED' ? 0.96 : 0, sourceReferences: staleResult === 'ANSWERED' ? [{ documentId: 'old-doc', chunkId: 'old-chunk' }] : [] } }));
    const stale = await first;
    assert.equal(stale.code, 0, stale.output);
    assert.deepEqual(snapshot(), afterReplacement, 'lost lease must fence every business write, not only the processing job');
  } finally {
    for (const child of children) if (child.exitCode === null) child.kill();
    observer?.close(); rag.closeAllConnections(); await new Promise(resolve => rag.close(resolve));
  }
});

for (const order of ['processing-first', 'handoff-first', 'infrastructure-error']) test(`real RAG await ordering: ${order}`, () => {
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import http from 'node:http';
    const { db, row, run, now } = await import('./src/db.js');
    const { config } = await import('./src/config.js');
    const { ingestMiniProgramMessage, requestMiniProgramHandoff } = await import('./src/services/mini-program-channel.js');
    const { withConversationSerial } = await import('./src/services/conversation-store.js');
    const { processMiniProgramJobOnce } = await import('./src/services/mini-program-processing.js');
    const { saveMasterSwitch } = await import('./src/services/settings.js');
    const entered = Promise.withResolvers(); const release = Promise.withResolvers();
    let requests = 0;
    const rag = http.createServer(async (req, res) => {
      let raw = ''; for await (const chunk of req) raw += chunk;
      const payload = JSON.parse(raw); requests++; entered.resolve(); await release.promise;
      res.setHeader('Content-Type','application/json');
      res.end(JSON.stringify({ requestId: payload.requestId, result: 'ANSWERED', snapshot: payload.snapshot, answer: { text: '请携带身份证件。' }, grounding: { confidence: 0.96, sourceReferences: [{documentId:'doc-1',chunkId:'chunk-1'}] } }));
    });
    await new Promise(resolve => rag.listen(0,'127.0.0.1',resolve));
    config.ragBaseUrl = 'http://127.0.0.1:' + rag.address().port;
    const server = await import('./src/server.js'); saveMasterSwitch(true);
    ingestMiniProgramMessage({ appId:'app-1', conversationId:'rag-order', messageId:'rag-order', userId:'rag-user', text:'办理业务需要什么材料？', sentAt:now() });
    const message = row('SELECT * FROM messages');
    let queuedBeforeHandoff = null;
    const handoffWork = () => { queuedBeforeHandoff = row('SELECT status FROM mini_program_callback_outbox'); return requestMiniProgramHandoff({ conversationId:message.conversation_id }); };
    if (${JSON.stringify(order)} === 'infrastructure-error') {
      const processing = processMiniProgramJobOnce({ processMessage: id => server.processMessageWithRegistry(id) });
      await entered.promise;
      db.exec("CREATE TEMP TRIGGER fail_rag_reconciliation BEFORE UPDATE ON messages WHEN NEW.reason LIKE 'RAG返回前%' BEGIN SELECT RAISE(ABORT,'PRIVATE_SOURCE_SECRET'); END");
      run('UPDATE conversations SET version=version+1 WHERE id=?',message.conversation_id);
      release.resolve(); await processing;
      db.exec('DROP TRIGGER fail_rag_reconciliation');
      assert.equal(row('SELECT status FROM mini_program_processing_jobs').status,'RETRY_WAIT');
      assert.equal(row('SELECT status FROM messages').status,'NEW');
      assert.equal(row('SELECT COUNT(*) AS n FROM notifications').n,0);
    } else if (${JSON.stringify(order)} === 'processing-first') {
      const processing = processMiniProgramJobOnce({ processMessage: id => server.processMessageWithRegistry(id) });
      await entered.promise;
      const handoff = withConversationSerial(message.conversation_id, handoffWork);
      assert.equal(row('SELECT handling_mode FROM conversations').handling_mode,'BOT_ACTIVE');
      release.resolve(); await processing; await handoff;
      assert.equal(queuedBeforeHandoff.status,'PENDING');
      assert.equal(row('SELECT status FROM mini_program_callback_outbox').status,'CANCELLED');
      assert.equal(requests,1);
    } else {
      const handoff = withConversationSerial(message.conversation_id, handoffWork);
      const processing = processMiniProgramJobOnce({ processMessage: id => server.processMessageWithRegistry(id) });
      await handoff; await processing;
      assert.equal(row('SELECT COUNT(*) AS n FROM mini_program_callback_outbox').n,0);
      assert.equal(requests,0);
    }
    if (${JSON.stringify(order)} !== 'infrastructure-error') {
      assert.equal(row('SELECT status FROM mini_program_processing_jobs').status,'COMPLETED');
      assert.equal(row('SELECT status FROM messages').status,'MANUAL_REQUIRED');
      assert.equal(row('SELECT handling_mode FROM conversations').handling_mode,'HANDOFF_PENDING');
      assert.equal(row('SELECT COUNT(*) AS n FROM notifications').n,1);
    }
    rag.closeAllConnections(); await new Promise(resolve => rag.close(resolve));
    process.exit = code => { process.exitCode = code; }; process.emit('SIGTERM');
  `], { cwd: path.resolve(import.meta.dirname, '..'), encoding: 'utf8', timeout: 20000,
    env: { ...process.env, DATABASE_PATH: path.join(dir, `${order}.db`), PORT: '0', AUTH_ENABLED: 'false', LOCAL_AGENT_AUTO_START: 'false', AUTO_COLLECT_ENABLED: 'false', QWEN_MODE: 'mock', RPA_MODE: 'simulated', RAG_FORMAL_ROUTING_ENABLED: 'true' } });
  assert.equal(child.status, 0, [child.error?.message, child.stderr, child.stdout].filter(Boolean).join('\n'));
  assert.ok(!child.stderr.includes('PRIVATE_SOURCE_SECRET'));
});
