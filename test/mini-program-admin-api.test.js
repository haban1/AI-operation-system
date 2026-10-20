import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { cleanupDir, freePort, jsonRequest, tempRuntimeDir, waitForHttp } from './helpers/runtime.js';

const dir = tempRuntimeDir('mini-admin-');
const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const secret = 'admin-mini-secret-at-least-32-characters';
Object.assign(process.env, {
  DATABASE_PATH: path.join(dir, 'admin.db'), PORT: String(port), SERVER_HOST: '127.0.0.1',
  INSTANCE_LOCK_ENABLED: 'false', AUTH_ENABLED: 'true', ADMIN_USERNAME: 'admin',
  ADMIN_PASSWORD: 'Admin-test-password-2026!', SESSION_SECRET: 'admin-session-secret-at-least-32-characters',
  AGENT_SHARED_TOKEN: '', QWEN_MODE: 'mock', RPA_MODE: 'simulated', AUTO_COLLECT_ENABLED: 'false',
  LOCAL_AGENT_AUTO_START: 'false', MINI_PROGRAM_API_ENABLED: 'true', MINI_PROGRAM_APP_ID: 'admin-app',
  MINI_PROGRAM_SHARED_SECRET: secret, MINI_PROGRAM_CALLBACK_URL: '', WECOM_WEBHOOK_URL: ''
});
const { db, row, rows, run, now } = await import('../src/db.js');
const { config } = await import('../src/config.js');
const { ingestMiniProgramMessage, requestMiniProgramHandoff, miniProgramAccount } = await import('../src/services/mini-program-channel.js');
const { enqueueMiniProgramReply, deliverMiniProgramCallback } = await import('../src/services/mini-program-callback.js');
const { processMiniProgramJobOnce } = await import('../src/services/mini-program-processing.js');
const { withConversationSerial } = await import('../src/services/conversation-store.js');
const { deliverNotification, stopNotificationOutboxWorker } = await import('../src/services/notification.js');
await import('../src/server.js');
let cookie;
let sequence = 0;
function seed(overrides = {}) {
  const n = ++sequence;
  const payload = { appId: 'admin-app', conversationId: `c-${n}`, userId: `u-${n}`, messageId: `m-${n}`, text: 'stored incoming text', sentAt: now(), ...overrides };
  ingestMiniProgramMessage(payload);
  return row('SELECT * FROM messages WHERE external_id=?', `mini-program:admin-app:message:${payload.messageId}`);
}
function conversation(message) { return row('SELECT * FROM conversations WHERE id=?', message.conversation_id); }
function request(route, options = {}) { return jsonRequest(base, '/api/mini-program' + route, { headers: { Cookie: cookie }, ...options }); }
function handoff(message, body = { idempotencyKey: `mini-program-handoff:${message.conversation_id}` }) {
  return request(`/conversations/${message.conversation_id}/handoff`, { method: 'POST', body });
}
function callback(message, status = 'FAILED') {
  const value = enqueueMiniProgramReply({ message, replyText: 'stored AI reply' });
  run('UPDATE mini_program_callback_outbox SET status=? WHERE id=?', status, value.id);
  return row('SELECT * FROM mini_program_callback_outbox WHERE id=?', value.id);
}
function notification(message, status = 'FAILED') {
  const value = requestMiniProgramHandoff({ conversationId: message.conversation_id }).notification;
  run('UPDATE notifications SET status=? WHERE id=?', status, value.id);
  return row('SELECT * FROM notifications WHERE id=?', value.id);
}
function counts() { return ['messages', 'notifications', 'mini_program_callback_outbox', 'agent_jobs'].map(table => row(`SELECT COUNT(*) AS n FROM ${table}`).n); }
const forbiddenKeys = /^(?:payload_json|response_json|response_excerpt|context_json|context|metadata_json|signature|nonce|nonces|sharedSecret|appSecret|knowledgeAnswerSnapshot|knowledge_answer_snapshot|secret)$/i;
const allowedKeys = new Set('ok code detail message status apiEnabled appConfigured secretConfigured callbackConfigured lastReceivedAt counts processing processingFailed callbackPending callbackFailed notificationFailed conversations conversation messages notification callback created id platformCode appId conversationId userId lastTextPreview lastActivityAt handlingMode historicalUser processingStatus callbackStatus notificationId notificationStatus messageId text replyText decision knowledgeId knowledgeQuestionSnapshot receivedAt sentAt attemptCount error httpStatus confirmedAt retryable'.split(' '));
function safe(value) {
  if (Array.isArray(value)) return value.forEach(safe);
  if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) {
    assert.doesNotMatch(key, forbiddenKeys);
    assert.ok(allowedKeys.has(key), `Unapproved management field: ${key}`);
    safe(child);
  }
  if (typeof value === 'string') {
    assert.ok(!value.includes(secret));
    assert.doesNotMatch(value, /private-auth-evidence|private-response|private-error|private-nonce|a{64}|SQLITE|SELECT |C:\\private|\/private\/db/);
  }
}
function success(result) { assert.equal(result.response.status, 200, result.text); safe(result.data); return result.data; }
function failure(result, status) {
  assert.equal(result.response.status, status, result.text);
  assert.equal(result.data.ok, false);
  assert.deepEqual(Object.keys(result.data).sort(), ['code', 'detail', 'message', 'ok']);
  assert.equal(result.data.detail, null);
  safe(result.data);
}
test.before(async () => {
  await waitForHttp(base);
  stopNotificationOutboxWorker();
  const login = await jsonRequest(base, '/api/auth/login', { method: 'POST', body: { username: 'admin', password: process.env.ADMIN_PASSWORD } });
  assert.equal(login.response.status, 200, login.text);
  cookie = login.response.headers.get('set-cookie').split(';')[0];
  // Allow the imported server's one-shot alias backfills to settle before closing its database later.
  await new Promise(resolve => setTimeout(resolve, 250));
});
test.beforeEach(() => {
  db.exec('BEGIN; PRAGMA defer_foreign_keys=ON; DELETE FROM notifications; DELETE FROM mini_program_callback_outbox; DELETE FROM mini_program_processing_jobs; DELETE FROM agent_jobs; DELETE FROM reply_batches; DELETE FROM messages; DELETE FROM mini_program_users; DELETE FROM conversations; COMMIT;');
  config.miniProgramCallbackUrl = '';
  config.wecomWebhookUrl = '';
});
test.after(async () => {
  const originalExit = process.exit;
  await new Promise(resolve => { process.exit = () => resolve(); process.emit('SIGTERM'); });
  process.exit = originalExit;
  db.close();
  cleanupDir(dir);
});

test('status endpoint reports boolean configuration and owned queue counts without secret values', async () => {
  const message = seed();
  callback(message, 'NOT_CONFIGURED');
  const other = seed();
  notification(other);
  run("UPDATE mini_program_processing_jobs SET status='FAILED' WHERE message_id=?", other.id);
  const data = success(await request('/status')).status;
  assert.deepEqual(data, {
    apiEnabled: true, appConfigured: true, secretConfigured: true, callbackConfigured: false,
    lastReceivedAt: other.collected_at,
    counts: { processing: 1, processingFailed: 1, callbackPending: 1, callbackFailed: 0, notificationFailed: 1 }
  });
  // Handoff cancelled the first callback only if it belonged to that conversation.
  assert.equal(row('SELECT status FROM mini_program_callback_outbox WHERE message_id=?', message.id).status, 'NOT_CONFIGURED');
});

test('conversation endpoint normalizes identity, preserves Unicode preview and returns a strict field projection', async () => {
  const message = seed({ text: '\u{1f600}'.repeat(121) + 'tail' });
  const data = success(await request('/conversations')).conversations;
  assert.equal(data.length, 1);
  assert.deepEqual(Object.keys(data[0]).sort(), ['appId', 'callbackStatus', 'conversationId', 'handlingMode', 'historicalUser', 'id', 'lastActivityAt', 'lastTextPreview', 'notificationId', 'notificationStatus', 'platformCode', 'processingStatus', 'userId'].sort());
  assert.equal(data[0].id, message.conversation_id);
  assert.equal(data[0].conversationId, `c-${sequence}`);
  assert.equal(data[0].userId, `u-${sequence}`);
  assert.equal(data[0].lastTextPreview, '\u{1f600}'.repeat(120));
  assert.equal([...data[0].lastTextPreview].length, 120);
  assert.equal(data[0].historicalUser, false);
});

test('message endpoint projects text, decision, knowledge question and safe delivery summaries', async () => {
  const message = seed();
  const cb = callback(message);
  const note = notification(message);
  run("UPDATE messages SET reply_text='stored AI reply',knowledge_id=123,knowledge_question_snapshot='stored question',knowledge_answer_snapshot='private-auth-evidence' WHERE id=?", message.id);
  const context = JSON.parse(message.context_json);
  run('UPDATE messages SET context_json=? WHERE id=?', JSON.stringify({ ...context, secret, signature: 'a'.repeat(64), nonce: 'private-nonce', private: 'private-auth-evidence' }), message.id);
  run('UPDATE mini_program_callback_outbox SET response_excerpt=?,error_message=? WHERE id=?', 'private-response ' + secret, 'private-error C:\\private\\db ' + secret, cb.id);
  run('UPDATE notifications SET response_json=?,error_message=? WHERE id=?', JSON.stringify({ signature: 'a'.repeat(64) }), 'private-error /private/db ' + secret, note.id);
  run('UPDATE mini_program_processing_jobs SET last_error_message=? WHERE message_id=?', 'private-error ' + secret, message.id);
  const result = success(await request(`/conversations/${message.conversation_id}/messages`));
  assert.equal(result.messages.length, 1);
  const item = result.messages[0];
  assert.deepEqual(Object.keys(item).sort(), ['id', 'messageId', 'text', 'replyText', 'status', 'decision', 'knowledgeId', 'knowledgeQuestionSnapshot', 'receivedAt', 'sentAt', 'processing', 'callback', 'notification'].sort());
  assert.equal(item.text, 'stored incoming text');
  assert.equal(item.replyText, 'stored AI reply');
  assert.equal(item.decision, 'HUMAN_FOLLOWUP_NOTIFICATION_PENDING');
  assert.equal(item.knowledgeId, 123);
  assert.equal(item.knowledgeQuestionSnapshot, 'stored question');
  assert.equal(item.callback.status, 'FAILED');
  assert.ok(item.callback.error);
  assert.equal(item.notification.status, 'FAILED');
  assert.ok(item.notification.error);
});

test('handoff endpoint cancels durable replies and repeats return one notification with distinct UI and durable keys', async () => {
  const message = seed();
  const cb = callback(message, 'PENDING');
  const results = await Promise.all(Array.from({ length: 8 }, () => handoff(message)));
  results.forEach(success);
  assert.equal(new Set(results.map(result => result.data.notification.id)).size, 1);
  assert.equal(results.filter(result => result.data.created).length, 1);
  assert.equal(conversation(message).handling_mode, 'HANDOFF_PENDING');
  assert.equal(row('SELECT status FROM mini_program_callback_outbox WHERE id=?', cb.id).status, 'CANCELLED');
  assert.equal(row('SELECT status FROM messages WHERE id=?', message.id).status, 'MANUAL_REQUIRED');
  assert.equal(row('SELECT idempotency_key FROM notifications').idempotency_key, `wecom:mini-program:handoff:conversation:${message.conversation_id}`);
  assert.deepEqual(counts(), [1, 1, 1, 0]);
});

test('notification retry endpoint requeues only failed/retry-wait owned handoff notifications', async () => {
  const message = seed();
  const note = notification(message);
  const result = success(await request(`/notifications/${note.id}/retry`, { method: 'POST', body: {} }));
  assert.equal(result.notification.id, note.id);
  assert.equal(result.notification.status, 'PENDING');
  failure(await request(`/notifications/${note.id}/retry`, { method: 'POST', body: {} }), 409);
});

test('callback retry endpoint requeues a retained failed reply without returning payload or response evidence', async () => {
  const message = seed();
  const cb = callback(message);
  const result = success(await request(`/callbacks/${cb.id}/retry`, { method: 'POST', body: {} }));
  assert.equal(result.callback.id, cb.id);
  assert.equal(result.callback.status, 'PENDING');
  assert.equal(row('SELECT payload_json FROM mini_program_callback_outbox WHERE id=?', cb.id).payload_json, cb.payload_json);
});

test('all six management endpoints require a real admin session before validation or business changes', async () => {
  const message = seed();
  const cb = callback(message);
  const note = notification(message);
  const before = counts();
  for (const [method, route] of [['GET', '/status'], ['GET', '/conversations'], ['GET', `/conversations/${message.conversation_id}/messages`], ['POST', `/conversations/${message.conversation_id}/handoff`], ['POST', `/notifications/${note.id}/retry`], ['POST', `/callbacks/${cb.id}/retry`]]) {
    failure(await request(route, { method, headers: { 'X-Signature': 'a'.repeat(64), 'X-Mini-App-Id': 'admin-app' }, ...(method === 'POST' ? { body: { text: 'invalid' } } : {}) }), 401);
  }
  assert.deepEqual(counts(), before);
});

test('filters classify processing failures separately from callback/WeCom failures and limits bound results', async () => {
  const first = seed();
  const second = seed();
  const third = seed();
  const fourth = seed();
  const fifth = seed();
  run("UPDATE mini_program_processing_jobs SET status='COMPLETED'");
  run("UPDATE mini_program_processing_jobs SET status='FAILED' WHERE message_id=?", first.id);
  run("UPDATE mini_program_processing_jobs SET status='RUNNING' WHERE message_id=?", second.id);
  callback(third, 'NOT_CONFIGURED');
  callback(fourth, 'FAILED');
  notification(fifth);
  const expected = { ALL: [first, second, third, fourth, fifth], PROCESSING: [second], CALLBACK_PENDING: [third], HANDOFF_PENDING: [fifth], HUMAN_MANAGED: [], ERROR: [first, fourth, fifth] };
  for (const [status, messages] of Object.entries(expected)) {
    const actual = success(await request('/conversations?status=' + status)).conversations;
    assert.deepEqual(actual.map(item => item.id).sort(), messages.map(item => item.conversation_id).sort(), status);
  }
  assert.equal(success(await request('/conversations?limit=1')).conversations.length, 1);
  assert.deepEqual(success(await request('/status')).status.counts, { processing: 1, processingFailed: 1, callbackPending: 1, callbackFailed: 1, notificationFailed: 1 });
});

test('malformed IDs, filters, limits and handoff bodies reject injection-like input without side effects', async () => {
  const message = seed();
  const before = counts();
  for (const id of ['0', '-1', '1.5', '1e2', '9007199254740992', '1%20OR%201=1', 'null', '01']) {
    failure(await request(`/conversations/${id}/messages`), 400);
    failure(await request(`/conversations/${id}/handoff`, { method: 'POST', body: { idempotencyKey: 'x' } }), 400);
    for (const name of ['notifications', 'callbacks']) failure(await request(`/${name}/${id}/retry`, { method: 'POST', body: {} }), 400);
  }
  for (const query of ['status=failed', 'status=ALL%27%20OR%201=1', 'status=', 'status=ALL&status=ERROR', 'limit=0', 'limit=-1', 'limit=1001', 'limit=Infinity', 'limit=1.5', 'limit=', 'limit=1&limit=2', 'limit=1%20OR%201=1']) failure(await request('/conversations?' + query), 400);
  for (const body of [{}, { idempotencyKey: '' }, { idempotencyKey: 1 }, { idempotencyKey: 'x'.repeat(300) }, { idempotencyKey: 'mini-program-handoff:999999' }, { idempotencyKey: `mini-program-handoff:${message.conversation_id}`, text: 'manual reply' }, null, []]) failure(await handoff(message, body), 400);
  for (const route of ['/conversations/999999/messages', '/conversations/999999/handoff', '/notifications/999999/retry', '/callbacks/999999/retry']) {
    const post = !route.endsWith('/messages');
    failure(await request(route, { method: post ? 'POST' : 'GET', ...(post ? { body: route.endsWith('/handoff') ? { idempotencyKey: 'mini-program-handoff:999999' } : {} } : {}) }), 404);
  }
  assert.deepEqual(counts(), before);
});

test('cross-platform conversations and noncanonical accounts cannot be read or handed off', async () => {
  for (const mutation of ["platform_code='weibo'", 'account_id=1', "namespace='mini-program:wrong-app:c'", "user_name='swapped-user'"]) {
    const message = seed();
    run(`UPDATE conversations SET ${mutation} WHERE id=?`, message.conversation_id);
    failure(await request(`/conversations/${message.conversation_id}/messages`), 404);
    failure(await handoff(message), 404);
    assert.ok(!success(await request('/conversations')).conversations.some(item => item.id === message.conversation_id));
  }
  assert.equal(row('SELECT COUNT(*) AS n FROM notifications').n, 0);
});

test('swapped message identity cannot escape through details, handoff, retries, filters or counts', async () => {
  for (const mutation of ["platform_code='weibo'", 'account_id=1', "user_name='wrong-user'", "context_json='{}'", "context_json='malformed'", "external_id='wrong-id'"]) {
    const message = seed();
    const cb = callback(message);
    const note = notification(message);
    run(`UPDATE messages SET ${mutation} WHERE id=?`, message.id);
    assert.equal(success(await request(`/conversations/${message.conversation_id}/messages`)).messages.length, 0);
    failure(await handoff(message), 404);
    failure(await request(`/notifications/${note.id}/retry`, { method: 'POST', body: {} }), 404);
    failure(await request(`/callbacks/${cb.id}/retry`, { method: 'POST', body: {} }), 404);
    assert.equal(row('SELECT status FROM notifications WHERE id=?', note.id).status, 'FAILED');
    assert.equal(row('SELECT status FROM mini_program_callback_outbox WHERE id=?', cb.id).status, 'FAILED');
  }
  const status = success(await request('/status')).status;
  assert.deepEqual(status.counts, { processing: 0, processingFailed: 0, callbackPending: 0, callbackFailed: 0, notificationFailed: 0 });
  assert.equal(status.lastReceivedAt, null);
});

test('notification retry proves durable handoff key, metadata and source/conversation identity', async () => {
  for (const mutation of ["idempotency_key='other-key'", "metadata_json='{}'", "metadata_json='malformed'", "metadata_json=json_set(metadata_json,'$.handoff',0)", "metadata_json=json_set(metadata_json,'$.miniProgram.userId','wrong-user')", "metadata_json=json_set(metadata_json,'$.miniProgram.accountId',1)", "metadata_json=json_set(metadata_json,'$.miniProgram.conversationId','wrong-conversation')", "metadata_json=json_set(metadata_json,'$.miniProgram.appId','wrong-app')"]) {
    const message = seed();
    const note = notification(message);
    run(`UPDATE notifications SET ${mutation} WHERE id=?`, note.id);
    failure(await request(`/notifications/${note.id}/retry`, { method: 'POST', body: {} }), 404);
    assert.equal(row('SELECT status FROM notifications WHERE id=?', note.id).status, 'FAILED');
  }
  const left = seed();
  const note = notification(left);
  const right = seed();
  run('UPDATE notifications SET message_id=? WHERE id=?', right.id, note.id);
  failure(await handoff(left), 404);
  failure(await request(`/notifications/${note.id}/retry`, { method: 'POST', body: {} }), 404);
});

test('callback retry proves source relationship and normalized payload identity', async () => {
  for (const mutation of ["app_id='wrong-app'", "payload_json='{}'", "payload_json='malformed'", "payload_json=json_set(payload_json,'$.conversationId','wrong')", "payload_json=json_set(payload_json,'$.userId','wrong')", "payload_json=json_set(payload_json,'$.inReplyToMessageId','wrong')", "payload_json=json_set(payload_json,'$.eventId','wrong')", "payload_json=json_set(payload_json,'$.type','manual.reply')"]) {
    const message = seed();
    const cb = callback(message);
    run(`UPDATE mini_program_callback_outbox SET ${mutation} WHERE id=?`, cb.id);
    failure(await request(`/callbacks/${cb.id}/retry`, { method: 'POST', body: {} }), 404);
    assert.equal(row('SELECT status FROM mini_program_callback_outbox WHERE id=?', cb.id).status, 'FAILED');
  }
  const left = seed();
  const cb = callback(left);
  const right = seed();
  run('UPDATE mini_program_callback_outbox SET conversation_id=? WHERE id=?', right.conversation_id, cb.id);
  failure(await request(`/callbacks/${cb.id}/retry`, { method: 'POST', body: {} }), 404);
});

test('retry actions enforce delivery state and never revive callbacks after handoff', async () => {
  for (const status of ['PENDING', 'SENDING', 'SENT', 'RETRY_WAIT', 'CANCELLED', 'FAILED', 'NOT_CONFIGURED']) {
    const message = seed();
    const cb = callback(message, status);
    const result = await request(`/callbacks/${cb.id}/retry`, { method: 'POST', body: {} });
    if (['FAILED', 'NOT_CONFIGURED'].includes(status)) success(result); else failure(result, 409);
  }
  for (const status of ['PENDING', 'SENDING', 'SENT', 'CONFIRMED', 'FAILED', 'RETRY_WAIT']) {
    const message = seed();
    const note = notification(message, status);
    const result = await request(`/notifications/${note.id}/retry`, { method: 'POST', body: {} });
    if (['FAILED', 'RETRY_WAIT'].includes(status)) success(result); else failure(result, 409);
  }
  const message = seed();
  const cb = callback(message);
  notification(message);
  failure(await request(`/callbacks/${cb.id}/retry`, { method: 'POST', body: {} }), 409);
});

test('confirmed replay preserves human history and pending missing evidence uses shared repair safely', async () => {
  const message = seed();
  const note = success(await handoff(message)).notification;
  config.wecomWebhookUrl = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=admin-test-key';
  await deliverNotification(note.id, { fetchImpl: async () => new Response('{"errcode":0}', { status: 200 }) });
  assert.equal(conversation(message).handling_mode, 'HUMAN_MANAGED');
  const before = row('SELECT * FROM mini_program_users');
  for (let i = 0; i < 3; i++) {
    const repeated = success(await handoff(message));
    assert.equal(repeated.created, false);
    assert.equal(repeated.notification.id, note.id);
    assert.equal(repeated.conversation.handlingMode, 'HUMAN_MANAGED');
  }
  assert.deepEqual(row('SELECT * FROM mini_program_users'), before);
  assert.equal(success(await request('/conversations?status=HUMAN_MANAGED')).conversations[0].historicalUser, true);
  const pending = seed();
  run("UPDATE conversations SET handling_mode='HANDOFF_PENDING',handoff_reason='original reason',handoff_source_message_id=? WHERE id=?", pending.id, pending.conversation_id);
  const repaired = success(await handoff(pending));
  assert.equal(repaired.conversation.handlingMode, 'HANDOFF_PENDING');
  assert.equal(row('SELECT handoff_reason FROM conversations WHERE id=?', pending.conversation_id).handoff_reason, 'original reason');
  const broken = seed();
  run("UPDATE conversations SET handling_mode='HUMAN_MANAGED' WHERE id=?", broken.conversation_id);
  failure(await handoff(broken), 409);
  assert.equal(row('SELECT COUNT(*) AS n FROM notifications').n, 2);
});

test('handoff database errors roll back cancellation and return stable safe errors', async () => {
  const message = seed();
  const cb = callback(message, 'PENDING');
  db.exec("CREATE TEMP TRIGGER fail_admin_handoff BEFORE INSERT ON notifications BEGIN SELECT RAISE(ABORT,'private-error C:\\private\\db SQLITE INSERT'); END");
  try { failure(await handoff(message), 500); } finally { db.exec('DROP TRIGGER fail_admin_handoff'); }
  assert.equal(conversation(message).handling_mode, 'BOT_ACTIVE');
  assert.equal(row('SELECT status FROM mini_program_callback_outbox WHERE id=?', cb.id).status, 'PENDING');
  assert.equal(row('SELECT COUNT(*) AS n FROM notifications').n, 0);
});

test('handoff rejects malformed older children before shared cancellation can change their state', async () => {
  for (const target of ['message', 'callback', 'batch']) {
    const message = seed();
    const cb = callback(message, 'PENDING');
    const context = JSON.parse(message.context_json);
    seed({ conversationId: context.conversationId, userId: context.userId });
    if (target === 'message') run("UPDATE messages SET platform_code='weibo' WHERE id=?", message.id);
    if (target === 'callback') run("UPDATE mini_program_callback_outbox SET app_id='wrong-app' WHERE id=?", cb.id);
    if (target === 'batch') run(`INSERT INTO reply_batches(platform_code,account_id,channel_type,conversation_id,conversation_namespace,conversation_version,status,first_pending_at,created_at,updated_at)
      VALUES('weibo',1,'PRIVATE_MESSAGE',?,?,1,'READY',?,?,?)`, message.conversation_id, message.conversation_key_snapshot, now(), now(), now());
    const snapshot = () => ['conversations', 'messages', 'notifications', 'mini_program_callback_outbox', 'reply_batches'].map(table => rows(`SELECT * FROM ${table} ORDER BY id`));
    const before = snapshot();
    failure(await handoff(message), 404);
    assert.deepEqual(snapshot(), before, target);
  }
});

test('unrelated notification records with no conversation return 404 without mutation', async () => {
  const message = seed();
  const note = notification(message);
  run('UPDATE notifications SET conversation_id=NULL,message_id=NULL WHERE id=?', note.id);
  const before = row('SELECT * FROM notifications WHERE id=?', note.id);
  failure(await request(`/notifications/${note.id}/retry`, { method: 'POST', body: {} }), 404);
  assert.deepEqual(row('SELECT * FROM notifications WHERE id=?', note.id), before);
});

test('status counts and overlapping filters cover every pending queue state', async () => {
  for (const status of ['PENDING', 'RUNNING', 'RETRY_WAIT']) {
    const message = seed();
    run('UPDATE mini_program_processing_jobs SET status=? WHERE message_id=?', status, message.id);
  }
  for (const status of ['PENDING', 'SENDING', 'RETRY_WAIT', 'NOT_CONFIGURED']) {
    const message = seed();
    callback(message, status);
  }
  const failed = seed();
  callback(failed, 'FAILED');
  notification(failed, 'RETRY_WAIT');
  assert.deepEqual(success(await request('/status')).status.counts, { processing: 8, processingFailed: 0, callbackPending: 4, callbackFailed: 1, notificationFailed: 0 });
  assert.equal(success(await request('/conversations?status=PROCESSING')).conversations.length, 8);
  assert.equal(success(await request('/conversations?status=CALLBACK_PENDING')).conversations.length, 4);
  assert.deepEqual(success(await request('/conversations?status=ERROR')).conversations.map(item => item.id), [failed.conversation_id]);
});

test('128-code-point external IDs remain readable and actionable through internal route IDs', async () => {
  const message = seed({ conversationId: '\u{1f600}'.repeat(128), userId: '\u{1f601}'.repeat(128), messageId: '\u{1f602}'.repeat(128) });
  const list = success(await request('/conversations')).conversations;
  assert.equal(list.length, 1);
  assert.equal(list[0].conversationId, '\u{1f600}'.repeat(128));
  assert.equal(success(await request(`/conversations/${message.conversation_id}/messages`)).messages[0].messageId, '\u{1f602}'.repeat(128));
  success(await handoff(message));
});

test('hexadecimal external IDs are preserved as identities rather than treated as signatures', async () => {
  const message = seed({ conversationId: 'b'.repeat(64), userId: 'c'.repeat(64), messageId: 'd'.repeat(64) });
  const result = success(await request(`/conversations/${message.conversation_id}/messages`));
  assert.equal(result.conversation.conversationId, 'b'.repeat(64));
  assert.equal(result.conversation.userId, 'c'.repeat(64));
  assert.equal(result.messages[0].messageId, 'd'.repeat(64));
});

test('handoff never duplicates a pending notification whose durable key was corrupted', async () => {
  const message = seed();
  const note = notification(message);
  run("UPDATE notifications SET idempotency_key='wrong-key' WHERE id=?", note.id);
  const before = rows('SELECT * FROM notifications');
  failure(await handoff(message), 404);
  assert.deepEqual(rows('SELECT * FROM notifications'), before);
});

test('safe time projections cannot contain nested authentication evidence or raw internal strings', async () => {
  const message = seed();
  const cb = callback(message, 'SENT');
  const context = JSON.parse(message.context_json);
  run('UPDATE messages SET context_json=?,collected_at=? WHERE id=?', JSON.stringify({ ...context, sentAt: { signature: 'a'.repeat(64), nonce: 'private-nonce' } }), 'private-error /private/db', message.id);
  run('UPDATE mini_program_callback_outbox SET sent_at=? WHERE id=?', 'private-error C:\\private\\db ' + secret, cb.id);
  const result = success(await request(`/conversations/${message.conversation_id}/messages`));
  assert.equal(result.conversation.lastActivityAt, null);
  assert.equal(result.messages[0].sentAt, null);
  assert.equal(result.messages[0].receivedAt, null);
  assert.equal(result.messages[0].callback.sentAt, null);
  assert.equal(success(await request('/status')).status.lastReceivedAt, null);
});

for (const field of ['status', 'decision', 'knowledge_id']) test(`review: persisted message ${field} is projected by type, not reflected`, async () => {
  const message = seed();
  const marker = `private-nonce private-error SQLITE /private/db ${secret}`;
  run(`UPDATE messages SET ${field}=? WHERE id=?`, marker, message.id);
  const result = success(await request(`/conversations/${message.conversation_id}/messages`));
  assert.equal(result.messages[0][field === 'knowledge_id' ? 'knowledgeId' : field], field === 'knowledge_id' ? null : 'UNKNOWN');
  success(await request('/conversations'));
  success(await request('/status'));
});

for (const table of ['mini_program_processing_jobs', 'mini_program_callback_outbox', 'notifications']) test(`review: persisted ${table} numeric and enum fields are safe`, async () => {
  const message = seed();
  const cb = callback(message);
  const note = notification(message);
  const field = table === 'mini_program_processing_jobs' ? 'processing' : table === 'notifications' ? 'notification' : 'callback';
  const id = table === 'mini_program_processing_jobs' ? row('SELECT id FROM mini_program_processing_jobs WHERE message_id=?', message.id).id : table === 'notifications' ? note.id : cb.id;
  const marker = `private-nonce private-error SQLITE /private/db ${secret}`;
  run(`UPDATE ${table} SET status=?,attempt_count=? WHERE id=?`, marker, marker, id);
  if (field === 'callback') run('UPDATE mini_program_callback_outbox SET http_status=? WHERE id=?', marker, id);
  const result = success(await request(`/conversations/${message.conversation_id}/messages`)).messages[0][field];
  assert.equal(result.status, 'UNKNOWN');
  assert.equal(result.attemptCount, null);
  assert.equal(result.httpStatus ?? null, null);
  success(await request('/conversations'));
  success(await request('/status'));
});

test('review: numeric projections reject invalid domains and retain legitimate integers', async () => {
  const message = seed();
  const cb = callback(message);
  const note = notification(message);
  for (const value of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    run('UPDATE messages SET knowledge_id=? WHERE id=?', value, message.id);
    run('UPDATE mini_program_processing_jobs SET attempt_count=? WHERE message_id=?', value, message.id);
    run('UPDATE mini_program_callback_outbox SET attempt_count=? WHERE id=?', value, cb.id);
    run('UPDATE notifications SET attempt_count=? WHERE id=?', value, note.id);
    const item = success(await request(`/conversations/${message.conversation_id}/messages`)).messages[0];
    assert.equal(item.knowledgeId, null);
    for (const child of ['processing', 'callback', 'notification']) assert.equal(item[child].attemptCount, null);
  }
  for (const value of [0, 99, 600, 200.5, Number.MAX_SAFE_INTEGER + 1]) {
    run('UPDATE mini_program_callback_outbox SET http_status=? WHERE id=?', value, cb.id);
    assert.equal(success(await request(`/conversations/${message.conversation_id}/messages`)).messages[0].callback.httpStatus, null);
  }
  run("UPDATE messages SET status='AUTO_REPLIED',decision='AUTO_REPLY',knowledge_id=42 WHERE id=?", message.id);
  run('UPDATE mini_program_processing_jobs SET attempt_count=0 WHERE message_id=?', message.id);
  run('UPDATE mini_program_callback_outbox SET attempt_count=2,http_status=204 WHERE id=?', cb.id);
  run('UPDATE notifications SET attempt_count=3 WHERE id=?', note.id);
  const item = success(await request(`/conversations/${message.conversation_id}/messages`)).messages[0];
  assert.equal(item.status, 'AUTO_REPLIED');
  assert.equal(item.decision, 'AUTO_REPLY');
  assert.equal(item.knowledgeId, 42);
  assert.equal(item.processing.attemptCount, 0);
  assert.equal(item.callback.attemptCount, 2);
  assert.equal(item.callback.httpStatus, 204);
  assert.equal(item.notification.attemptCount, 3);
  for (const value of [100, 599]) {
    run('UPDATE mini_program_callback_outbox SET http_status=? WHERE id=?', value, cb.id);
    assert.equal(success(await request(`/conversations/${message.conversation_id}/messages`)).messages[0].callback.httpStatus, value);
  }
});

test('review: corrupt handling mode and invalid persisted IDs never leak unsafe values', async () => {
  const message = seed();
  run('UPDATE conversations SET handling_mode=? WHERE id=?', `private-nonce ${secret}`, message.conversation_id);
  assert.equal(success(await request(`/conversations/${message.conversation_id}/messages`)).conversation.handlingMode, 'UNKNOWN');
  // Non-positive primary keys are legal SQLite storage, but not public management identifiers.
  run('UPDATE mini_program_processing_jobs SET id=-1 WHERE message_id=?', message.id);
  assert.equal(success(await request(`/conversations/${message.conversation_id}/messages`)).messages[0].processing.id, null);
});

test('review: duplicate profile accounts cannot own management reads, handoff or retries', async () => {
  const canonical = miniProgramAccount();
  const duplicate = Number(run(`INSERT INTO accounts(platform_code,display_name,device_id,profile_name,created_at)
    VALUES(?,?,?,?,?)`, canonical.platform_code, 'duplicate mini account', canonical.device_id, canonical.profile_name, now()).lastInsertRowid);
  const bot = seed();
  const cb = callback(bot);
  const pending = seed();
  const note = notification(pending);
  const metadata = JSON.parse(note.metadata_json);
  try {
    for (const table of ['conversations', 'messages', 'mini_program_users']) run(`UPDATE ${table} SET account_id=? WHERE account_id=?`, duplicate, canonical.id);
    run('UPDATE notifications SET metadata_json=? WHERE id=?', JSON.stringify({ ...metadata, miniProgram: { ...metadata.miniProgram, accountId: duplicate } }), note.id);
    assert.equal(miniProgramAccount().id, canonical.id);
    const snapshot = () => ['accounts', 'conversations', 'messages', 'mini_program_users', 'notifications', 'mini_program_callback_outbox', 'mini_program_processing_jobs'].map(table => rows(`SELECT * FROM ${table} ORDER BY id`));
    const before = snapshot();
    assert.deepEqual(success(await request('/conversations')).conversations, []);
    assert.deepEqual(success(await request('/status')).status.counts, { processing: 0, processingFailed: 0, callbackPending: 0, callbackFailed: 0, notificationFailed: 0 });
    for (const message of [bot, pending]) {
      failure(await request(`/conversations/${message.conversation_id}/messages`), 404);
      failure(await handoff(message), 404);
    }
    failure(await request(`/callbacks/${cb.id}/retry`, { method: 'POST', body: {} }), 404);
    failure(await request(`/notifications/${note.id}/retry`, { method: 'POST', body: {} }), 404);
    assert.deepEqual(snapshot(), before);
  } finally {
    for (const table of ['conversations', 'messages', 'mini_program_users']) run(`UPDATE ${table} SET account_id=? WHERE account_id=?`, canonical.id, duplicate);
    run('UPDATE notifications SET metadata_json=? WHERE id=?', note.metadata_json, note.id);
    run('DELETE FROM accounts WHERE id=?', duplicate);
  }
  assert.equal(success(await request('/conversations')).conversations.length, 2);
});

test('review 2: canonical account remains stable under reverse indexes and arbitrary duplicate IDs', async () => {
  const canonical = miniProgramAccount();
  const message = seed();
  const cb = callback(message);
  const note = notification(message);
  const duplicate = Number(run(`INSERT INTO accounts(platform_code,display_name,device_id,profile_name,created_at)
    VALUES(?,?,?,?,?)`, canonical.platform_code, canonical.display_name, canonical.device_id, canonical.profile_name, canonical.created_at).lastInsertRowid);
  try {
    db.exec('CREATE INDEX test_mini_account_reverse ON accounts(platform_code,profile_name,id DESC)');
    assert.equal(miniProgramAccount().id, canonical.id);
    run(`INSERT INTO accounts(id,platform_code,display_name,device_id,profile_name,created_at)
      VALUES(-100,?,?,?,?,?)`, canonical.platform_code, canonical.display_name, canonical.device_id, canonical.profile_name, '1900-01-01T00:00:00.000Z');
    assert.equal(miniProgramAccount().id, canonical.id);
    const before = rows('SELECT * FROM accounts ORDER BY id');
    assert.equal(success(await request('/conversations')).conversations[0].id, message.conversation_id);
    assert.equal(success(await request(`/conversations/${message.conversation_id}/messages`)).messages[0].id, message.id);
    assert.deepEqual(rows('SELECT * FROM accounts ORDER BY id'), before);
    success(await handoff(message));
    success(await request(`/notifications/${note.id}/retry`, { method: 'POST', body: {} }));
    failure(await request(`/callbacks/${cb.id}/retry`, { method: 'POST', body: {} }), 409);
    assert.equal(conversation(message).account_id, canonical.id);
  } finally {
    db.exec('DROP INDEX IF EXISTS test_mini_account_reverse');
    run('DELETE FROM accounts WHERE id IN (?,?)', duplicate, -100);
  }
});

test('review 2: unavailable canonical binding returns safe 503 across all six management routes without writes', async () => {
  const message = seed();
  const cb = callback(message);
  const note = notification(message);
  for (const mutation of [
    'DELETE FROM mini_program_channel_identity',
    'UPDATE mini_program_channel_identity SET account_id=1 WHERE id=1',
    `UPDATE accounts SET profile_name='private-error private-nonce' WHERE id=${message.account_id}`
  ]) {
    db.exec('SAVEPOINT unavailable_identity');
    try {
      db.exec(mutation);
      const snapshot = () => ['accounts', 'mini_program_channel_identity', 'conversations', 'messages', 'notifications', 'mini_program_users', 'mini_program_callback_outbox', 'mini_program_processing_jobs'].map(table => rows(`SELECT * FROM ${table} ORDER BY id`));
      const before = snapshot();
      const calls = [
        () => request('/status'), () => request('/conversations'),
        () => request(`/conversations/${message.conversation_id}/messages`), () => handoff(message),
        () => request(`/notifications/${note.id}/retry`, { method: 'POST', body: {} }),
        () => request(`/callbacks/${cb.id}/retry`, { method: 'POST', body: {} })
      ];
      for (const call of calls) {
        const result = await call();
        failure(result, 503);
        assert.equal(result.data.code, 'MINI_PROGRAM_ACCOUNT_UNAVAILABLE');
      }
      assert.deepEqual(snapshot(), before);
      assert.equal((await jsonRequest(base, '/api/bootstrap', { headers: { Cookie: cookie } })).response.status, 200);
    } finally { db.exec('ROLLBACK TO unavailable_identity; RELEASE unavailable_identity'); }
  }
});

test('review: EMAIL records are not mini-program WeCom handoff notifications', async () => {
  const message = seed();
  const note = notification(message);
  run("UPDATE notifications SET channel='EMAIL' WHERE id=?", note.id);
  const snapshot = () => ['conversations', 'messages', 'notifications', 'mini_program_users', 'mini_program_callback_outbox'].map(table => rows(`SELECT * FROM ${table} ORDER BY id`));
  const before = snapshot();
  const detail = success(await request(`/conversations/${message.conversation_id}/messages`));
  assert.equal(detail.messages[0].notification, null);
  assert.equal(detail.conversation.notificationId, null);
  assert.equal(detail.conversation.notificationStatus, null);
  assert.equal(success(await request('/status')).status.counts.notificationFailed, 0);
  assert.deepEqual(success(await request('/conversations?status=ERROR')).conversations, []);
  failure(await handoff(message), 404);
  failure(await request(`/notifications/${note.id}/retry`, { method: 'POST', body: {} }), 404);
  assert.deepEqual(snapshot(), before);
});

test('review: handoff cancellation is not shown as callback delivery failure', async () => {
  const message = seed();
  callback(message, 'PENDING');
  success(await handoff(message));
  const detail = success(await request(`/conversations/${message.conversation_id}/messages`)).messages[0].callback;
  assert.equal(detail.status, 'CANCELLED');
  assert.equal(detail.error, null);
  assert.equal(detail.retryable, false);
});

for (const status of ['CONFIRMED', 'SENT']) test(`review: HUMAN_MANAGED ${status} with invalid terminal timestamps is a side-effect-free conflict`, async () => {
  const message = seed();
  const note = notification(message, status);
  run("UPDATE conversations SET handling_mode='HUMAN_MANAGED' WHERE id=?", message.conversation_id);
  for (const [confirmedAt, sentAt] of [[null, null], ['private-error /private/db', null], [null, 'private-nonce'], ['2026-99-99T00:00:00Z', 'not-a-date']]) {
    run('UPDATE notifications SET confirmed_at=?,sent_at=? WHERE id=?', confirmedAt, sentAt, note.id);
    const snapshot = () => ['conversations', 'messages', 'notifications', 'mini_program_users', 'mini_program_callback_outbox'].map(table => rows(`SELECT * FROM ${table} ORDER BY id`));
    const before = snapshot();
    failure(await handoff(message), 409);
    assert.deepEqual(snapshot(), before);
  }
});

for (const stamp of ['2026-02-30T01:02:03.000Z', '2026-02-29T01:02:03.000Z', '2026-04-31T01:02:03.000Z',
  '1900-02-29T01:02:03.000Z', '2026-02-30T01:02:03+08:00', '2026-09-01T24:00:00Z']) {
  test(`review 2: calendar-invalid terminal evidence ${stamp} returns 409 without mutations`, async () => {
    for (const status of ['SENT', 'CONFIRMED']) for (const mode of ['HANDOFF_PENDING', 'HUMAN_MANAGED']) {
      const message = seed();
      const note = notification(message, status);
      run('UPDATE notifications SET confirmed_at=?,sent_at=? WHERE id=?', status === 'CONFIRMED' ? stamp : null, stamp, note.id);
      run('UPDATE conversations SET handling_mode=? WHERE id=?', mode, message.conversation_id);
      const snapshot = () => ['conversations', 'messages', 'notifications', 'mini_program_users', 'mini_program_callback_outbox', 'mini_program_processing_jobs'].map(table => rows(`SELECT * FROM ${table} ORDER BY id`));
      const before = snapshot();
      failure(await handoff(message), 409);
      assert.deepEqual(snapshot(), before, `${status} ${mode}`);
    }
  });
}

test('review 2: calendar-invalid persisted times are null, never rolled into another date', async () => {
  const message = seed();
  const cb = callback(message, 'SENT');
  const note = notification(message, 'CONFIRMED');
  const context = JSON.parse(message.context_json);
  for (const stamp of ['2026-02-30T01:02:03.000Z', '2026-02-29T01:02:03.000Z', '2026-04-31T01:02:03.000Z']) {
    run('UPDATE messages SET context_json=?,collected_at=? WHERE id=?', JSON.stringify({ ...context, sentAt: stamp }), stamp, message.id);
    run('UPDATE mini_program_callback_outbox SET sent_at=? WHERE id=?', stamp, cb.id);
    run('UPDATE notifications SET confirmed_at=?,sent_at=? WHERE id=?', stamp, stamp, note.id);
    const detail = success(await request(`/conversations/${message.conversation_id}/messages`));
    assert.equal(detail.conversation.lastActivityAt, null);
    assert.equal(detail.messages[0].sentAt, null);
    assert.equal(detail.messages[0].receivedAt, null);
    assert.equal(detail.messages[0].callback.sentAt, null);
    assert.equal(detail.messages[0].notification.sentAt, null);
    assert.equal(detail.messages[0].notification.confirmedAt, null);
    assert.equal(success(await request('/status')).status.lastReceivedAt, null);
    assert.equal(success(await request('/conversations')).conversations[0].lastActivityAt, null);
  }
});

test('review 2: valid leap days and ISO offsets retain the exact instant and replay history once', async () => {
  const currentStamp = now();
  const fixtures = [
    [currentStamp, currentStamp],
    ['2024-02-29T01:02:03.000Z', '2024-02-29T01:02:03.000Z'],
    ['2000-02-29T01:02:03Z', '2000-02-29T01:02:03.000Z'],
    ['2024-02-29T23:59:59.999-01:00', '2024-03-01T00:59:59.999Z'],
    ['2024-03-01T00:00:00+14:00', '2024-02-29T10:00:00.000Z'],
    ['2024-02-29T23:59:59-14:00', '2024-03-01T13:59:59.000Z']
  ];
  for (const [stamp, expected] of fixtures) {
    const message = seed({ sentAt: stamp });
    const note = notification(message, 'SENT');
    run('UPDATE notifications SET confirmed_at=NULL,sent_at=? WHERE id=?', stamp, note.id);
    const result = success(await handoff(message));
    assert.equal(result.notification.sentAt, expected);
    assert.equal(result.conversation.lastActivityAt, expected);
    assert.equal(result.conversation.handlingMode, 'HUMAN_MANAGED');
    const user = row('SELECT * FROM mini_program_users WHERE external_user_id=?', message.user_name);
    assert.equal(user.first_handoff_at, stamp);
    assert.equal(user.last_handoff_at, stamp);
    assert.equal(user.handoff_count, 1);
    success(await handoff(message));
    assert.deepEqual(row('SELECT * FROM mini_program_users WHERE id=?', user.id), user);
  }
});

test('review: legacy SENT timestamp repairs HUMAN_MANAGED history once without a second notification', async () => {
  const message = seed();
  const note = notification(message, 'SENT');
  const stamp = '2026-09-01T01:02:03.000Z';
  run('UPDATE notifications SET confirmed_at=NULL,sent_at=? WHERE id=?', stamp, note.id);
  run("UPDATE conversations SET handling_mode='HUMAN_MANAGED' WHERE id=?", message.conversation_id);
  const repaired = success(await handoff(message));
  assert.equal(repaired.created, false);
  assert.equal(repaired.notification.id, note.id);
  assert.equal(repaired.conversation.handlingMode, 'HUMAN_MANAGED');
  assert.equal(repaired.conversation.historicalUser, true);
  const before = row('SELECT * FROM mini_program_users');
  assert.equal(before.handoff_count, 1);
  assert.equal(before.first_handoff_at, stamp);
  assert.equal(before.last_handoff_at, stamp);
  success(await handoff(message));
  assert.deepEqual(row('SELECT * FROM mini_program_users'), before);
  assert.equal(row('SELECT COUNT(*) AS n FROM notifications').n, 1);
});

test('no artificial reply endpoint or action body can create a reply', async () => {
  const message = seed();
  const before = counts();
  for (const action of ['reply', 'messages', 'send']) failure(await request(`/conversations/${message.conversation_id}/${action}`, { method: 'POST', body: { text: 'manual reply' } }), 404);
  failure(await handoff(message, { idempotencyKey: `mini-program-handoff:${message.conversation_id}`, replyText: 'manual reply' }), 400);
  const cb = callback(message);
  failure(await request(`/callbacks/${cb.id}/retry`, { method: 'POST', body: { text: 'manual reply' } }), 400);
  assert.equal(row('SELECT payload_json FROM mini_program_callback_outbox WHERE id=?', cb.id).payload_json, cb.payload_json);
  assert.deepEqual(counts(), [before[0], before[1], before[2] + 1, before[3]]);
});

for (const worker of ['processing', 'callback']) for (const first of ['worker', 'admin']) test(`authenticated handoff serializes with ${worker}, ${first} obtains the lock first`, async () => {
  const message = seed();
  config.miniProgramCallbackUrl = 'http://127.0.0.1:23456/callback';
  const cb = worker === 'callback' ? callback(message, 'PENDING') : null;
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  let sent = 0;
  const work = () => worker === 'callback'
    ? deliverMiniProgramCallback(cb.id, { fetchImpl: async () => { sent++; entered.resolve(); await release.promise; return new Response(null, { status: 204 }); } })
    : processMiniProgramJobOnce({ processMessage: async () => { entered.resolve(); await release.promise; enqueueMiniProgramReply({ message, replyText: 'processing reply' }); } });
  let admin;
  let running;
  if (first === 'worker') {
    running = work();
    await entered.promise;
    let finished = false;
    admin = handoff(message).then(result => { finished = true; return result; });
    await new Promise(resolve => setTimeout(resolve, 40));
    const completedBeforeRelease = finished;
    release.resolve();
    await running;
    assert.equal(completedBeforeRelease, false);
  } else {
    const held = withConversationSerial(message.conversation_id, async () => { entered.resolve(); await release.promise; });
    await entered.promise;
    admin = handoff(message);
    await new Promise(resolve => setTimeout(resolve, 40));
    running = work();
    release.resolve();
    await held;
  }
  success(await admin);
  await running;
  assert.equal(conversation(message).handling_mode, 'HANDOFF_PENDING');
  assert.equal(row('SELECT COUNT(*) AS n FROM notifications').n, 1);
  assert.equal(row('SELECT COUNT(*) AS n FROM agent_jobs').n, 0);
  const callbacks = rows('SELECT status FROM mini_program_callback_outbox');
  if (worker === 'callback' && first === 'worker') { assert.equal(sent, 1); assert.equal(callbacks[0].status, 'SENT'); }
  else { assert.equal(sent, 0); assert.ok(callbacks.every(item => item.status === 'CANCELLED')); }
});
