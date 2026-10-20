import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mini-program-callback-'));
process.env.DATABASE_PATH = path.join(dir, 'callback.db');
process.env.INSTANCE_LOCK_ENABLED = 'false';
process.env.MINI_PROGRAM_APP_ID = 'app-1';
process.env.MINI_PROGRAM_SHARED_SECRET = 'callback-test-secret-that-is-at-least-32-characters';
process.env.MINI_PROGRAM_CALLBACK_URL = '';
process.env.MINI_PROGRAM_CALLBACK_TIMEOUT_MS = '1000';

const { config } = await import('../src/config.js');
const { db, immediateTransaction, now, row, run } = await import('../src/db.js');
const { ingestMiniProgramMessage } = await import('../src/services/mini-program-channel.js');
const { signMiniProgramRequest } = await import('../src/services/mini-program-auth.js');
const {
  MINI_PROGRAM_CALLBACK_RETRY_DELAYS_MS,
  claimMiniProgramCallback,
  deliverMiniProgramCallback,
  enqueueMiniProgramReply,
  processMiniProgramCallbackOnce,
  requeueMiniProgramCallback,
  startMiniProgramCallbackWorker,
  stopMiniProgramCallbackWorker
} = await import('../src/services/mini-program-callback.js');

const EXPECTED_RETRY_DELAYS_MS = Object.freeze([
  5_000, 30_000, 120_000, 600_000, 3_600_000,
  21_600_000, 21_600_000, 21_600_000, 21_600_000
]);

let receiver;
let receiverBaseUrl;
let receiverBehavior;
let receivedRequests;
let fixtureSequence = 0;

async function requestBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function clearRows() {
  db.exec(`
    DELETE FROM notifications;
    DELETE FROM mini_program_callback_outbox;
    DELETE FROM mini_program_processing_jobs;
    DELETE FROM messages;
    DELETE FROM mini_program_users;
    DELETE FROM conversations;
  `);
}

function sourceMessage({ conversationId, messageId, userId = 'user-1', text = '请问怎么办理？' } = {}) {
  fixtureSequence += 1;
  const externalConversationId = conversationId || `conversation-${fixtureSequence}`;
  const externalMessageId = messageId || `message-${fixtureSequence}`;
  ingestMiniProgramMessage({
    appId: 'app-1',
    conversationId: externalConversationId,
    messageId: externalMessageId,
    userId,
    text,
    sentAt: '2026-09-05T09:30:00.000Z'
  });
  const message = row('SELECT * FROM messages WHERE external_id=?', `mini-program:app-1:message:${externalMessageId}`);
  run("UPDATE messages SET status='REPLY_QUEUED',decision='AUTO_REPLY',reply_text=?,updated_at=? WHERE id=?",
    '办理时请携带有效身份证件。', now(), message.id);
  return row('SELECT * FROM messages WHERE id=?', message.id);
}

function enqueueFixture(options = {}) {
  const message = sourceMessage(options);
  const replyText = options.replyText || '办理时请携带有效身份证件。';
  run('UPDATE messages SET reply_text=?,updated_at=? WHERE id=?', replyText, now(), message.id);
  return {
    message: row('SELECT * FROM messages WHERE id=?', message.id),
    callback: enqueueMiniProgramReply({
      message: row('SELECT * FROM messages WHERE id=?', message.id),
      replyText,
      createdAt: options.createdAt || '2026-09-05T09:30:02.000Z'
    })
  };
}

function storedCallback(id) {
  return row('SELECT * FROM mini_program_callback_outbox WHERE id=?', Number(id));
}

function makeDue(id) {
  run("UPDATE mini_program_callback_outbox SET available_at='2000-01-01T00:00:00.000Z' WHERE id=?", Number(id));
}

function assertServiceError(operation, { statusCode, code }) {
  assert.throws(operation, error => {
    assert.equal(error.statusCode, statusCode);
    assert.equal(error.code, code);
    return true;
  });
}

test.before(async () => {
  receiverBehavior = { status: 200, body: 'accepted', delayMs: 0 };
  receivedRequests = [];
  receiver = http.createServer(async (request, response) => {
    const rawBody = await requestBody(request);
    receivedRequests.push({ url: request.url, headers: request.headers, rawBody });
    const behavior = receiverBehavior;
    if (behavior.delayMs) await new Promise(resolve => setTimeout(resolve, behavior.delayMs));
    if (response.destroyed) return;
    if (behavior.redirectLocation && request.url !== behavior.redirectLocation) {
      response.writeHead(302, { Location: behavior.redirectLocation });
      response.end('redirecting');
      return;
    }
    if (behavior.resetAfterHeaders) {
      response.writeHead(behavior.status, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Length': '1000'
      });
      response.flushHeaders();
      response.write('partial diagnostic');
      setTimeout(() => response.destroy(), 10);
      return;
    }
    response.writeHead(behavior.status, { 'Content-Type': 'text/plain; charset=utf-8' });
    let responseBody = behavior.body;
    if (behavior.echoRequestSecrets) {
      responseBody = `safe diagnostic\nsecret=${config.miniProgramSharedSecret}\nsignature=${request.headers['x-signature']}\npayload=${rawBody.toString('utf8')}`;
    } else if (behavior.echoLong === 'payload') {
      responseBody = `safe diagnostic\npayload=${rawBody.toString('utf8')}`;
    } else if (behavior.echoLong === 'reply') {
      responseBody = `safe diagnostic\nreply=${JSON.parse(rawBody.toString('utf8')).text}`;
    } else if (behavior.echoLong === 'json-reply') {
      responseBody = `safe diagnostic\nreply=${JSON.stringify(JSON.parse(rawBody.toString('utf8')).text)}`;
    }
    response.end(responseBody);
  });
  await new Promise((resolve, reject) => {
    receiver.once('error', reject);
    receiver.listen(0, '127.0.0.1', resolve);
  });
  receiverBaseUrl = `http://127.0.0.1:${receiver.address().port}`;
});

test.beforeEach(() => {
  stopMiniProgramCallbackWorker();
  clearRows();
  receivedRequests = [];
  receiverBehavior = { status: 200, body: 'accepted', delayMs: 0 };
  config.miniProgramCallbackUrl = `${receiverBaseUrl}/callbacks/replies`;
  config.miniProgramCallbackTimeoutMs = 1_000;
});

test('enqueue stores one stable assistant event per source message and participates in outer rollback', () => {
  const message = sourceMessage({
    conversationId: 'stable-conversation',
    messageId: 'stable-message',
    userId: 'stable-user'
  });
  const first = enqueueMiniProgramReply({
    message,
    replyText: '办理时请携带有效身份证件。',
    createdAt: '2026-09-05T09:30:02.000Z'
  });
  const duplicate = enqueueMiniProgramReply({
    message,
    replyText: '这段重放内容不得覆盖原载荷',
    createdAt: '2026-09-06T00:00:00.000Z'
  });

  assert.equal(duplicate.id, first.id);
  assert.equal(duplicate.event_id, first.event_id);
  assert.equal(duplicate.payload_json, first.payload_json);
  assert.match(first.event_id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  assert.deepEqual(JSON.parse(first.payload_json), {
    eventId: first.event_id,
    type: 'assistant.message',
    appId: 'app-1',
    conversationId: 'stable-conversation',
    userId: 'stable-user',
    inReplyToMessageId: 'stable-message',
    text: '办理时请携带有效身份证件。',
    createdAt: '2026-09-05T09:30:02.000Z'
  });
  assert.equal(row('SELECT COUNT(*) AS count FROM mini_program_callback_outbox').count, 1);

  const rollbackMessage = sourceMessage({ messageId: 'rollback-message' });
  assert.throws(() => immediateTransaction(() => {
    enqueueMiniProgramReply({ message: rollbackMessage, replyText: '回滚回复', createdAt: '2026-09-05T10:00:00.000Z' });
    throw new Error('ROLL_BACK_CALLBACK');
  }), /ROLL_BACK_CALLBACK/);
  assert.equal(row('SELECT COUNT(*) AS count FROM mini_program_callback_outbox WHERE message_id=?', rollbackMessage.id).count, 0);
});

test('real HTTP delivery preserves raw bytes and signed headers, and every 2xx including 204 succeeds', async () => {
  for (const status of [200, 204]) {
    clearRows();
    receivedRequests = [];
    receiverBehavior = { status, body: status === 204 ? '' : 'accepted', delayMs: 0 };
    const { message, callback } = enqueueFixture({ messageId: `success-${status}` });

    const result = await processMiniProgramCallbackOnce();

    assert.equal(result.status, 'SENT');
    assert.equal(result.delivered, true);
    const request = receivedRequests[0];
    assert.ok(request);
    assert.equal(request.rawBody.equals(Buffer.from(callback.payload_json, 'utf8')), true);
    assert.equal(request.headers['content-type'], 'application/json');
    assert.equal(request.headers['x-mini-app-id'], 'app-1');
    assert.match(request.headers['x-timestamp'], /^\d+$/);
    assert.ok(request.headers['x-nonce']);
    assert.equal(request.headers['x-signature'], signMiniProgramRequest({
      method: 'POST',
      pathname: '/callbacks/replies',
      timestamp: request.headers['x-timestamp'],
      nonce: request.headers['x-nonce'],
      rawBody: request.rawBody,
      secret: config.miniProgramSharedSecret
    }));
    const stored = storedCallback(callback.id);
    assert.equal(stored.status, 'SENT');
    assert.equal(stored.http_status, status);
    assert.ok(stored.sent_at);
    if (status === 204) assert.ok(stored.response_excerpt === null || stored.response_excerpt === '');
    assert.equal(row('SELECT status FROM messages WHERE id=?', message.id).status, 'AUTO_REPLIED');
  }
});

test('a real HTTP redirect is not followed or accepted as callback delivery', async () => {
  receiverBehavior = { status: 200, body: 'login page', delayMs: 0, redirectLocation: '/login' };
  const { message } = enqueueFixture({ messageId: 'redirect-message' });

  const result = await processMiniProgramCallbackOnce();

  assert.equal(result.status, 'RETRY_WAIT');
  assert.equal(result.http_status, 302);
  assert.deepEqual(receivedRequests.map(request => request.url), ['/callbacks/replies']);
  assert.equal(row('SELECT status FROM messages WHERE id=?', message.id).status, 'REPLY_QUEUED');
});

test('accepted and rejected response excerpts redact echoed request credentials and payload', async () => {
  for (const status of [200, 400]) {
    clearRows();
    receivedRequests = [];
    const replyText = `sensitive reply text ${status}`;
    receiverBehavior = { status, body: '', delayMs: 0, echoRequestSecrets: true };
    const { callback } = enqueueFixture({ messageId: `echo-secrets-${status}`, replyText });

    const result = await processMiniProgramCallbackOnce();

    assert.equal(result.status, status === 200 ? 'SENT' : 'RETRY_WAIT');
    assert.ok(result.response_excerpt.includes('safe diagnostic'));
    assert.ok(result.response_excerpt.length <= 1000);
    const actualSignature = receivedRequests[0].headers['x-signature'];
    for (const sensitive of [
      config.miniProgramSharedSecret,
      actualSignature,
      callback.payload_json,
      replyText
    ]) assert.equal(result.response_excerpt.includes(sensitive), false);
  }
});

test('long raw and JSON-encoded echoed replies are redacted after bounded response capture', async () => {
  const replyText = `private reply "quoted" \\ path\n${'x'.repeat(12_800)}`;
  const rawPrivatePrefix = replyText.slice(0, 80);
  const encodedPrivatePrefix = JSON.stringify(replyText).slice(1, 100);

  for (const status of [200, 400]) {
    for (const echoLong of ['reply', 'payload']) {
      clearRows();
      receivedRequests = [];
      receiverBehavior = { status, body: '', delayMs: 0, echoLong };
      const { callback } = enqueueFixture({
        messageId: `long-echo-${status}-${echoLong}`,
        replyText
      });

      const result = await processMiniProgramCallbackOnce();

      assert.equal(result.status, status === 200 ? 'SENT' : 'RETRY_WAIT');
      assert.ok((result.response_excerpt || '').length <= 1000);
      assert.equal((result.response_excerpt || '').includes(rawPrivatePrefix), false);
      assert.equal((result.response_excerpt || '').includes(encodedPrivatePrefix), false);
      assert.equal((storedCallback(callback.id).response_excerpt || '').includes('private reply'), false);
    }
  }
});

test('long sensitive-prefix detection precedes overlapping exact and generic redaction', async () => {
  for (const status of [200, 400]) {
    for (const echoLong of ['reply', 'json-reply']) {
      for (const [prefixName, prefix] of [
        ['digest', 'a'.repeat(64)],
        ['callback-url', config.miniProgramCallbackUrl]
      ]) {
        clearRows();
        receivedRequests = [];
        const privateMarker = `PRIVATE-OVERLAP-${status}-${echoLong}-${prefixName}`;
        const replyText = `${prefix}${privateMarker}${'z'.repeat(12_800)}`;
        receiverBehavior = { status, body: '', delayMs: 0, echoLong };
        const { callback } = enqueueFixture({
          messageId: `overlap-${status}-${echoLong}-${prefixName}`,
          replyText
        });

        const result = await processMiniProgramCallbackOnce();

        assert.equal(result.status, status === 200 ? 'SENT' : 'RETRY_WAIT');
        assert.equal((result.response_excerpt || '').includes(privateMarker), false);
        assert.equal((storedCallback(callback.id).response_excerpt || '').includes(privateMarker), false);
      }
    }
  }
});

test('a 2xx response remains accepted when its diagnostic body resets after headers', async () => {
  receiverBehavior = { status: 202, body: '', delayMs: 0, resetAfterHeaders: true };
  const { message } = enqueueFixture({ messageId: 'accepted-body-reset' });

  const result = await processMiniProgramCallbackOnce();

  assert.equal(result.status, 'SENT');
  assert.equal(result.http_status, 202);
  assert.equal(result.delivered, true);
  assert.equal(row('SELECT status FROM messages WHERE id=?', message.id).status, 'AUTO_REPLIED');
  assert.equal(receivedRequests.length, 1);
});

test('timeout and thrown network errors retry with sanitized persisted text', async () => {
  receiverBehavior = { status: 200, body: 'too late', delayMs: 100 };
  config.miniProgramCallbackTimeoutMs = 20;
  const timed = enqueueFixture({ messageId: 'timeout-message' });
  const timeoutResult = await processMiniProgramCallbackOnce();
  assert.equal(timeoutResult.status, 'RETRY_WAIT');
  assert.match(timeoutResult.error_message, /超时|timeout/i);

  clearRows();
  const secretReply = '不得出现在错误中的回复正文';
  const failed = enqueueFixture({ messageId: 'network-message', replyText: secretReply });
  const fakeSignature = 'a'.repeat(64);
  const failureResult = await processMiniProgramCallbackOnce({
    fetchImpl: async () => {
      throw new Error(`network ${config.miniProgramSharedSecret} ${config.miniProgramCallbackUrl} ${secretReply} ${fakeSignature}`);
    }
  });
  assert.equal(failureResult.status, 'RETRY_WAIT');
  assert.ok(failureResult.error_message);
  assert.ok(failureResult.error_message.length <= 1000);
  for (const sensitive of [config.miniProgramSharedSecret, config.miniProgramCallbackUrl, secretReply, fakeSignature, failed.callback.payload_json]) {
    assert.equal(failureResult.error_message.includes(sensitive), false);
  }
});

test('non-2xx responses use the exact retry table and attempt ten becomes durable FAILED', async () => {
  receiverBehavior = { status: 503, body: 'temporary rejection', delayMs: 0 };
  const { callback } = enqueueFixture({ messageId: 'retry-table-message' });
  assert.deepEqual(MINI_PROGRAM_CALLBACK_RETRY_DELAYS_MS, EXPECTED_RETRY_DELAYS_MS);

  for (let attempt = 1; attempt <= 10; attempt += 1) {
    const result = await processMiniProgramCallbackOnce();
    assert.equal(result.attempt_count, attempt);
    assert.equal(result.http_status, 503);
    assert.equal(result.response_excerpt, 'temporary rejection');
    if (attempt < 10) {
      assert.equal(result.status, 'RETRY_WAIT');
      assert.equal(
        Date.parse(result.available_at) - Date.parse(result.updated_at),
        EXPECTED_RETRY_DELAYS_MS[attempt - 1]
      );
      makeDue(callback.id);
    } else {
      assert.equal(result.status, 'FAILED');
      assert.equal(result.available_at, null);
    }
  }

  assert.equal(storedCallback(callback.id).status, 'FAILED');
  assert.equal(row('SELECT COUNT(*) AS count FROM mini_program_callback_outbox WHERE id=?', callback.id).count, 1);
  assert.equal(receivedRequests.length, 10);
});

test('manual requeue preserves attempts, extends the maximum, and clamps later retries to six hours', async () => {
  const { callback } = enqueueFixture({ messageId: 'manual-extension-message' });
  run(`UPDATE mini_program_callback_outbox SET status='FAILED',attempt_count=10,max_attempts=10,
    available_at=NULL,error_message='old failure',http_status=500,response_excerpt='old response' WHERE id=?`, callback.id);

  const requeued = requeueMiniProgramCallback(callback.id);
  assert.equal(requeued.status, 'PENDING');
  assert.equal(requeued.attempt_count, 10);
  assert.equal(requeued.max_attempts, 20);
  assert.equal(requeued.error_message, null);
  assert.equal(requeued.http_status, null);
  assert.equal(requeued.response_excerpt, null);
  const result = await processMiniProgramCallbackOnce({ fetchImpl: async () => { throw new Error('offline'); } });
  assert.equal(result.status, 'RETRY_WAIT');
  assert.equal(result.attempt_count, 11);
  assert.equal(Date.parse(result.available_at) - Date.parse(result.updated_at), 21_600_000);
});

test('missing callback configuration becomes NOT_CONFIGURED and keeps payload and reply text', async () => {
  const { message, callback } = enqueueFixture({ messageId: 'not-configured-message' });
  config.miniProgramCallbackUrl = '';

  const result = await processMiniProgramCallbackOnce();

  assert.equal(result.status, 'NOT_CONFIGURED');
  assert.equal(result.attempt_count, 1);
  assert.equal(result.payload_json, callback.payload_json);
  assert.equal(row('SELECT reply_text FROM messages WHERE id=?', message.id).reply_text, '办理时请携带有效身份证件。');
  assert.equal(receivedRequests.length, 0);
  const requeued = requeueMiniProgramCallback(callback.id);
  assert.equal(requeued.status, 'PENDING');
  assert.equal(requeued.attempt_count, 1);
  assert.equal(requeued.max_attempts, 11);
});

test('manual retry rejects every active or completed callback state', () => {
  const { callback } = enqueueFixture({ messageId: 'invalid-manual-retry-message' });
  for (const status of ['SENT', 'SENDING', 'PENDING', 'RETRY_WAIT']) {
    run('UPDATE mini_program_callback_outbox SET status=? WHERE id=?', status, callback.id);
    assertServiceError(() => requeueMiniProgramCallback(callback.id), {
      statusCode: 409,
      code: 'MINI_PROGRAM_CALLBACK_NOT_RETRYABLE'
    });
  }
});

test('an earlier unsent callback blocks later work only within its conversation', () => {
  const first = enqueueFixture({ conversationId: 'ordered', messageId: 'ordered-1' });
  const second = enqueueFixture({ conversationId: 'ordered', messageId: 'ordered-2' });
  const independent = enqueueFixture({ conversationId: 'independent', messageId: 'independent-1' });
  run("UPDATE mini_program_callback_outbox SET status='RETRY_WAIT',available_at='2999-01-01T00:00:00.000Z' WHERE id=?", first.callback.id);

  const claimedIndependent = claimMiniProgramCallback();
  assert.equal(claimedIndependent.id, independent.callback.id);
  assert.equal(storedCallback(second.callback.id).attempt_count, 0);
  run("UPDATE mini_program_callback_outbox SET status='SENT',claimed_at=NULL,lease_expires_at=NULL WHERE id=?", first.callback.id);
  run("UPDATE mini_program_callback_outbox SET status='CANCELLED',claimed_at=NULL,lease_expires_at=NULL WHERE id=?", independent.callback.id);

  const claimedSecond = claimMiniProgramCallback();
  assert.equal(claimedSecond.id, second.callback.id);
  assert.equal(claimedSecond.attempt_count, 1);
});

test('claim recovers an expired lease and increments only the new SENDING transition', () => {
  const first = enqueueFixture({ conversationId: 'lease-order', messageId: 'lease-1' });
  const second = enqueueFixture({ conversationId: 'lease-order', messageId: 'lease-2' });
  run(`UPDATE mini_program_callback_outbox SET status='SENDING',attempt_count=3,
    claimed_at='2000-01-01T00:00:00.000Z',lease_expires_at='2000-01-01T00:00:01.000Z' WHERE id=?`, first.callback.id);

  const claimed = claimMiniProgramCallback({ leaseMs: 45_000 });

  assert.equal(claimed.id, first.callback.id);
  assert.equal(claimed.status, 'SENDING');
  assert.equal(claimed.attempt_count, 4);
  assert.equal(Date.parse(claimed.lease_expires_at) - Date.parse(claimed.claimed_at), 45_000);
  assert.equal(storedCallback(second.callback.id).attempt_count, 0);
});

test('claim finalizes an expired tenth attempt instead of leaving an unclaimable retry', () => {
  const exhausted = enqueueFixture({ messageId: 'expired-tenth-attempt' });
  run(`UPDATE mini_program_callback_outbox SET status='SENDING',attempt_count=10,max_attempts=10,
    available_at=NULL,claimed_at='2000-01-01T00:00:00.000Z',lease_expires_at='2000-01-01T00:00:01.000Z' WHERE id=?`,
  exhausted.callback.id);

  assert.equal(claimMiniProgramCallback(), null);
  const recovered = storedCallback(exhausted.callback.id);
  assert.equal(recovered.status, 'FAILED');
  assert.equal(recovered.attempt_count, 10);
  assert.equal(recovered.available_at, null);
  assert.equal(recovered.claimed_at, null);
  assert.equal(recovered.lease_expires_at, null);
});

test('a stale claim cannot send or overwrite a re-claimed callback while the current id remains deliverable', async () => {
  const { callback } = enqueueFixture({ messageId: 'stale-lease-owner' });
  const claimA = claimMiniProgramCallback();
  run("UPDATE mini_program_callback_outbox SET lease_expires_at='2000-01-01T00:00:00.000Z' WHERE id=?", callback.id);
  const claimB = claimMiniProgramCallback();
  assert.equal(claimA.attempt_count, 1);
  assert.equal(claimB.attempt_count, 2);

  const staleWhileSending = await deliverMiniProgramCallback(claimA);

  assert.equal(staleWhileSending.status, 'SENDING');
  assert.equal(staleWhileSending.attempt_count, 2);
  assert.equal(staleWhileSending.claimed_at, claimB.claimed_at);
  assert.equal(receivedRequests.length, 0);
  assert.deepEqual(storedCallback(callback.id), claimB);

  const delivered = await deliverMiniProgramCallback(callback.id);
  assert.equal(delivered.status, 'SENT');
  assert.equal(receivedRequests.length, 1);
  const completed = storedCallback(callback.id);

  const staleAfterCompletion = await deliverMiniProgramCallback(claimA);
  assert.equal(staleAfterCompletion.status, 'SENT');
  assert.equal(receivedRequests.length, 1);
  assert.deepEqual(storedCallback(callback.id), completed);
});

test('HANDOFF_PENDING cancels a callback claimed before the final send check', async () => {
  const { message, callback } = enqueueFixture({ messageId: 'handoff-race-message' });
  const claimed = claimMiniProgramCallback();
  assert.equal(claimed.status, 'SENDING');
  run("UPDATE conversations SET handling_mode='HANDOFF_PENDING',human_followup_state='WAITING',updated_at=? WHERE id=?", now(), message.conversation_id);

  const result = await deliverMiniProgramCallback(claimed);

  assert.equal(result.status, 'CANCELLED');
  assert.equal(result.error_message, 'CONVERSATION_HANDOFF');
  assert.equal(result.claimed_at, null);
  assert.equal(result.lease_expires_at, null);
  assert.equal(receivedRequests.length, 0);
  assert.equal(row('SELECT status FROM messages WHERE id=?', message.id).status, 'REPLY_QUEUED');
});

test('response reading cancels after 8 KiB and persists at most 1000 characters', async () => {
  const { callback } = enqueueFixture({ messageId: 'capped-response-message' });
  let emittedBytes = 0;
  let cancelled = false;
  const body = new ReadableStream({
    pull(controller) {
      emittedBytes += 1024;
      controller.enqueue(new Uint8Array(1024).fill(120));
    },
    cancel() {
      cancelled = true;
    }
  });

  const result = await processMiniProgramCallbackOnce({
    fetchImpl: async () => new Response(body, { status: 200 })
  });

  assert.equal(result.status, 'SENT');
  assert.equal(result.response_excerpt, 'x'.repeat(1000));
  assert.equal(result.response_excerpt.length, 1000);
  // ReadableStream may prefetch one chunk; a larger cap would emit beyond this bound.
  assert.ok(emittedBytes >= 8 * 1024 && emittedBytes <= 9 * 1024);
  assert.equal(cancelled, true);
  assert.equal(storedCallback(callback.id).response_excerpt.length, 1000);
});

test('accepted HTTP plus a local database failure cannot commit SENT without AUTO_REPLIED', async () => {
  const { message, callback } = enqueueFixture({ messageId: 'delivery-rollback-message' });
  db.exec(`CREATE TRIGGER fail_mini_program_auto_reply
    BEFORE UPDATE OF status ON messages
    WHEN NEW.status='AUTO_REPLIED'
    BEGIN
      SELECT RAISE(ABORT, 'INJECTED_MESSAGE_UPDATE_FAILURE');
    END;`);
  try {
    const result = await processMiniProgramCallbackOnce();
    assert.equal(result.status, 'RETRY_WAIT');
    assert.equal(storedCallback(callback.id).status, 'RETRY_WAIT');
    assert.equal(row('SELECT status FROM messages WHERE id=?', message.id).status, 'REPLY_QUEUED');
  } finally {
    db.exec('DROP TRIGGER IF EXISTS fail_mini_program_auto_reply');
  }
});

test('worker start is idempotent and stop releases its timer', () => {
  const first = startMiniProgramCallbackWorker({ intervalMs: 60_000 });
  const second = startMiniProgramCallbackWorker({ intervalMs: 1 });
  assert.equal(second, first);
  stopMiniProgramCallbackWorker();
  assert.equal(startMiniProgramCallbackWorker({ intervalMs: 60_000 }) === first, false);
  stopMiniProgramCallbackWorker();
});

test.after(async () => {
  stopMiniProgramCallbackWorker();
  await new Promise(resolve => receiver.close(resolve));
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
