import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { once } from 'node:events';
import { cleanupDir, freePort, jsonRequest, spawnNode, startServer, stopChild, tempRuntimeDir, waitForHttp } from './helpers/runtime.js';

const messagePath = '/open-api/v1/mini-program/messages';
const appId = 'http-test-app';
const secret = 'mini-program-http-test-secret-at-least-32-characters';
const runtimeEnv = {
  MINI_PROGRAM_API_ENABLED: 'true', MINI_PROGRAM_APP_ID: appId,
  MINI_PROGRAM_SHARED_SECRET: secret, MINI_PROGRAM_CALLBACK_URL: '',
  WECOM_WEBHOOK_URL: '', RAG_BASE_URL: '', RAG_FORMAL_ROUTING_ENABLED: 'true',
  SQLITE_BUSY_TIMEOUT_MS: '1000', SQLITE_BUSY_RETRIES: '0'
};
let runtime;
let db;
let sequence = 0;

function payload(overrides = {}) {
  const id = ++sequence;
  return { appId, conversationId: `conversation-${id}`, messageId: `message-${id}`, userId: `user-${id}`, text: 'hello', sentAt: new Date().toISOString(), ...overrides };
}

// The client independently implements the published signing contract over the transmitted Buffer.
function signed(rawBody, { nonce = crypto.randomUUID(), timestamp = String(Math.floor(Date.now() / 1000)), method = 'POST', pathname = messagePath, suppliedApp = appId } = {}) {
  const canonical = [method, pathname, timestamp, nonce, crypto.createHash('sha256').update(rawBody).digest('hex')].join('\n');
  return { 'Content-Type': 'application/json', 'X-Mini-App-Id': suppliedApp, 'X-Timestamp': timestamp, 'X-Nonce': nonce, 'X-Signature': crypto.createHmac('sha256', secret).update(canonical).digest('hex') };
}

async function submit(value = payload(), options = {}) {
  const raw = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value));
  const headers = options.headers || signed(raw, options);
  const response = await fetch((options.base || runtime.base) + (options.pathname || messagePath), {
    method: options.method || 'POST', headers, body: raw, signal: AbortSignal.timeout(8000)
  });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { response, text, data };
}

function count(table, where = '1=1', ...args) {
  return db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get(...args).n;
}

function assertSafe(result, status, code) {
  assert.equal(result.response.status, status, result.text);
  assert.equal(result.data.ok, false);
  if (code) assert.equal(result.data.code, code);
  assert.deepEqual(Object.keys(result.data).sort(), ['code', 'detail', 'message', 'ok']);
  assert.equal(result.data.detail, null);
  assert.doesNotMatch(result.text, /SELECT |INSERT |SQLITE|node:|stack|signature|nonce-|private-body/);
  assert.ok(!result.text.includes(secret));
}

async function eventually(read, predicate, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  let value;
  do {
    value = read();
    if (predicate(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 40));
  } while (Date.now() < deadline);
  assert.fail(`Timed out waiting for durable state: ${JSON.stringify(value)}`);
}

function socketRequest(base, request, { abort = false } = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(base);
    const socket = net.connect(Number(target.port), target.hostname);
    const chunks = [];
    socket.setTimeout(5000, () => socket.destroy(new Error('socket request timed out')));
    socket.on('error', reject);
    socket.on('data', chunk => chunks.push(chunk));
    socket.on('close', () => resolve(Buffer.concat(chunks).toString('utf8')));
    socket.on('connect', () => {
      socket.write(request, () => { if (abort) socket.destroy(); });
    });
  });
}

function wireRequest(raw, headers, { target = messagePath, host = 'localhost', framing = [`Content-Length: ${raw.length}`], body = raw.toString('utf8') } = {}) {
  const lines = Object.entries(headers).map(([name, value]) => `${name}: ${value}`);
  return [`POST ${target} HTTP/1.1`, `Host: ${host}`, 'Connection: close', ...lines, ...framing, '', body].join('\r\n');
}

test.before(async () => {
  runtime = await startServer({ env: runtimeEnv });
  db = new DatabaseSync(runtime.dbPath);
});
test.after(async () => { db?.close(); await stopChild(runtime?.child); if (runtime) cleanupDir(runtime.dir); });

test('signed intake returns the exact durable 202 response and fresh-nonce retries are identical', async t => {
  const value = payload();
  const started = performance.now();
  const first = await submit(value);
  const elapsed = performance.now() - started;
  assert.equal(first.response.status, 202, first.text);
  assert.deepEqual(first.data, { ok: true, accepted: true, messageId: value.messageId, status: 'ACCEPTED' });
  assert.ok(elapsed < 1000, `intake took ${elapsed}ms`);
  t.diagnostic(`durable acceptance latency: ${elapsed.toFixed(1)}ms`);
  assert.equal(count('messages', 'external_id=?', `mini-program:${appId}:message:${value.messageId}`), 1);
  assert.equal(count('mini_program_processing_jobs', 'message_id IN (SELECT id FROM messages WHERE external_id=?)', `mini-program:${appId}:message:${value.messageId}`), 1);
  const again = await submit(value);
  assert.deepEqual(again.data, first.data);
  assert.equal(count('messages', 'external_id=?', `mini-program:${appId}:message:${value.messageId}`), 1);
});

test('same nonce is rejected while concurrent fresh nonces create exactly one message and job', async () => {
  const value = payload();
  const raw = Buffer.from(JSON.stringify(value));
  const headers = signed(raw);
  const replay = await Promise.all(Array.from({ length: 6 }, () => submit(raw, { headers })));
  assert.equal(replay.filter(result => result.response.status === 202).length, 1);
  for (const result of replay.filter(item => item.response.status !== 202)) assertSafe(result, 401, 'MINI_PROGRAM_NONCE_REPLAY');
  const retries = await Promise.all(Array.from({ length: 8 }, () => submit(raw)));
  for (const result of retries) assert.deepEqual(result.data, { ok: true, accepted: true, messageId: value.messageId, status: 'ACCEPTED' });
  assert.equal(count('messages', 'external_id=?', `mini-program:${appId}:message:${value.messageId}`), 1);
  assert.equal(count('mini_program_processing_jobs', 'message_id IN (SELECT id FROM messages WHERE external_id=?)', `mini-program:${appId}:message:${value.messageId}`), 1);
});

test('invalid signatures, header apps, timestamps and missing or repeated auth headers never consume nonces', async t => {
  for (const [name, mutate] of [
    ['wrong signature', headers => { headers['X-Signature'] = '0'.repeat(64); }],
    ['wrong header app', headers => { headers['X-Mini-App-Id'] = 'other-app'; }],
    ['stale timestamp', () => {}],
    ['future timestamp', () => {}],
    ...['X-Signature', 'X-Nonce', 'X-Timestamp', 'X-Mini-App-Id'].map(key => [`missing ${key}`, headers => { delete headers[key]; }]),
    ['repeated auth header', headers => { headers['x-nonce'] = headers['X-Nonce']; }]
  ]) await t.test(name, async () => {
    const raw = Buffer.from(JSON.stringify(payload()));
    const timestamp = String(Math.floor(Date.now() / 1000) + (name === 'stale timestamp' ? -301 : name === 'future timestamp' ? 301 : 0));
    const headers = signed(raw, { timestamp });
    const nonce = headers['X-Nonce'];
    mutate(headers);
    const before = count('messages');
    assertSafe(await submit(raw, { headers }), 401);
    assert.equal(count('messages'), before);
    assert.equal(count('mini_program_request_nonces', 'nonce=?', nonce), 0);
  });
});

test('signatures are sensitive to the exact raw whitespace and altered bytes do not consume the nonce', async () => {
  const raw = Buffer.from(JSON.stringify(payload(), null, 2) + '\n');
  const headers = signed(raw);
  assertSafe(await submit(Buffer.from(raw.toString().trim()), { headers }), 401, 'MINI_PROGRAM_AUTH_FAILED');
  assert.equal(count('mini_program_request_nonces', 'nonce=?', headers['X-Nonce']), 0);
  assert.equal((await submit(raw, { headers })).response.status, 202);
});

test('validly signed malformed JSON consumes its nonce before parsing and never stores the body', async () => {
  const raw = Buffer.from('{"text":"private-body",');
  const headers = signed(raw);
  const before = count('messages');
  assertSafe(await submit(raw, { headers }), 400, 'MINI_PROGRAM_PAYLOAD_INVALID');
  assert.equal(count('mini_program_request_nonces', 'nonce=?', headers['X-Nonce']), 1);
  assertSafe(await submit(raw, { headers }), 401, 'MINI_PROGRAM_NONCE_REPLAY');
  assert.equal(count('messages'), before);
});

test('invalid UTF-8 is rejected after exact-byte verification and nonce consumption', async () => {
  const valid = Buffer.from(JSON.stringify(payload({ text: 'invalid-utf8-marker' })));
  const offset = valid.indexOf('invalid-utf8-marker');
  const raw = Buffer.concat([valid.subarray(0, offset), Buffer.from([0xc0, 0xaf]), valid.subarray(offset + 'invalid-utf8-marker'.length)]);
  const headers = signed(raw);
  assertSafe(await submit(raw, { headers }), 400, 'MINI_PROGRAM_PAYLOAD_INVALID');
  assert.equal(count('mini_program_request_nonces', 'nonce=?', headers['X-Nonce']), 1);
});

test('intake and duplicate acknowledgements finish while the real RAG worker is still waiting', { timeout: 15000 }, async t => {
  let waitingResponse;
  let ragPayload;
  const rag = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    ragPayload = JSON.parse(Buffer.concat(chunks).toString());
    waitingResponse = res;
  });
  await new Promise(resolve => rag.listen(0, '127.0.0.1', resolve));
  const isolated = await startServer({ env: { ...runtimeEnv, RAG_BASE_URL: `http://127.0.0.1:${rag.address().port}` } });
  const observer = new DatabaseSync(isolated.dbPath);
  t.after(async () => {
    waitingResponse?.end();
    observer.close();
    await stopChild(isolated.child);
    await new Promise(resolve => rag.close(resolve));
    cleanupDir(isolated.dir);
  });
  const value = payload({ text: '\u529e\u7406\u4e1a\u52a1\u9700\u8981\u4ec0\u4e48\u6750\u6599\uff1f' });
  const started = performance.now();
  const accepted = await submit(value, { base: isolated.base });
  const elapsed = performance.now() - started;
  assert.equal(accepted.response.status, 202);
  assert.ok(elapsed < 1000, `acceptance blocked on RAG for ${elapsed}ms`);
  await eventually(() => Boolean(waitingResponse), Boolean);
  assert.equal(observer.prepare('SELECT status FROM mini_program_processing_jobs').get().status, 'RUNNING');
  assert.equal(observer.prepare('SELECT COUNT(*) AS n FROM mini_program_callback_outbox').get().n, 0);
  const retryStarted = performance.now();
  const retry = await submit(value, { base: isolated.base });
  const retryElapsed = performance.now() - retryStarted;
  assert.deepEqual(retry.data, accepted.data);
  assert.ok(retryElapsed < 1000, `duplicate blocked behind RAG for ${retryElapsed}ms`);
  t.diagnostic(`RAG-held ACK: ${elapsed.toFixed(1)}ms; duplicate ACK: ${retryElapsed.toFixed(1)}ms`);
  waitingResponse.setHeader('Content-Type', 'application/json');
  waitingResponse.end(JSON.stringify({ requestId: ragPayload.requestId, result: 'ANSWERED', snapshot: ragPayload.snapshot, answer: { text: 'Please bring valid identification.' }, grounding: { confidence: 0.96, sourceReferences: [{ documentId: 'doc', chunkId: 'chunk' }] } }));
  await eventually(() => observer.prepare('SELECT status FROM mini_program_processing_jobs').get().status, status => status === 'COMPLETED');
  assert.equal(observer.prepare('SELECT COUNT(*) AS n FROM mini_program_callback_outbox').get().n, 1);
});

test('strict JSON fields, text, IDs and ISO timestamps reject invalid payloads after consuming the nonce', async t => {
  const base = payload();
  for (const [name, value] of [
    ['null', null], ['array', []], ['missing', { ...base, userId: undefined }],
    ['number', { ...base, userId: 42 }], ['empty ID', { ...base, conversationId: ' ' }],
    ['long ID', { ...base, messageId: 'x'.repeat(129) }], ['empty text', { ...base, text: ' \n ' }],
    ['long text', { ...base, text: '\u{1f600}'.repeat(2001) }],
    ['attachment', { ...base, attachments: [] }], ['nontext type', { ...base, type: 'image' }],
    ['invalid date', { ...base, sentAt: '2026-02-30T10:00:00Z' }], ['non ISO date', { ...base, sentAt: 'September 6, 2026' }]
  ]) await t.test(name, async () => {
    const raw = Buffer.from(JSON.stringify(value));
    const headers = signed(raw);
    const before = count('messages');
    assertSafe(await submit(raw, { headers }), 400, 'MINI_PROGRAM_PAYLOAD_INVALID');
    assert.equal(count('mini_program_request_nonces', 'nonce=?', headers['X-Nonce']), 1);
    assert.equal(count('messages'), before);
  });
});

test('body app must equal both verified header and configuration before ingress', async () => {
  const raw = Buffer.from(JSON.stringify(payload({ appId: 'other-app' })));
  const headers = signed(raw);
  const before = count('messages');
  assertSafe(await submit(raw, { headers }), 401, 'MINI_PROGRAM_AUTH_FAILED');
  assert.equal(count('mini_program_request_nonces', 'nonce=?', headers['X-Nonce']), 1);
  assert.equal(count('messages'), before);
  assertSafe(await submit(raw, { headers: signed(raw, { suppliedApp: 'other-app' }) }), 401, 'MINI_PROGRAM_AUTH_FAILED');
});

test('content type and encoding are checked before authentication and nonce consumption', async t => {
  for (const contentType of [undefined, 'text/plain', 'application/jsonp', 'application/json, text/plain', 'application/json; charset=iso-8859-1', 'application/json; charset=utf-8; charset=utf-8']) {
    await t.test(String(contentType), async () => {
      const raw = Buffer.from(JSON.stringify(payload()));
      const headers = signed(raw);
      if (contentType === undefined) delete headers['Content-Type']; else headers['Content-Type'] = contentType;
      headers['X-Signature'] = '0'.repeat(64);
      assertSafe(await submit(raw, { headers }), 415, 'MINI_PROGRAM_JSON_CONTENT_TYPE_REQUIRED');
      assert.equal(count('mini_program_request_nonces', 'nonce=?', headers['X-Nonce']), 0);
    });
  }
  const raw = Buffer.from(JSON.stringify(payload()));
  const headers = { ...signed(raw), 'Content-Encoding': 'gzip' };
  assertSafe(await submit(raw, { headers }), 415, 'MINI_PROGRAM_JSON_CONTENT_TYPE_REQUIRED');
  assert.equal(count('mini_program_request_nonces', 'nonce=?', headers['X-Nonce']), 0);
  assert.equal((await submit(raw, { headers: { ...signed(raw), 'Content-Type': 'Application/JSON; charset="UTF-8"' } })).response.status, 202);
});

test('32 KiB raw boundary is exact for content-length and chunked bodies', async () => {
  const raw = Buffer.from(JSON.stringify(payload()));
  const boundary = Buffer.concat([raw, Buffer.alloc(32768 - raw.length, ' ')]);
  assert.equal((await submit(boundary)).response.status, 202);
  const oversized = Buffer.concat([boundary, Buffer.from(' ')]);
  const headers = signed(oversized);
  assertSafe(await submit(oversized, { headers }), 413, 'MINI_PROGRAM_BODY_TOO_LARGE');
  assert.equal(count('mini_program_request_nonces', 'nonce=?', headers['X-Nonce']), 0);
  for (const [body, expected] of [[Buffer.from(JSON.stringify(payload())), 202], [oversized, 413]]) {
    const signedHeaders = signed(body);
    const chunks = [body.subarray(0, 120), body.subarray(120)];
    const chunked = chunks.map(chunk => `${chunk.length.toString(16)}\r\n${chunk.toString()}\r\n`).join('') + '0\r\n\r\n';
    const response = await socketRequest(runtime.base, wireRequest(body, signedHeaders, { framing: ['Transfer-Encoding: chunked'], body: chunked }));
    assert.match(response, new RegExp(`^HTTP/1.1 ${expected} `));
    assert.equal(count('mini_program_request_nonces', 'nonce=?', signedHeaders['X-Nonce']), expected === 202 ? 1 : 0);
  }
});

test('ambiguous headers and invalid framing are rejected without consuming a signed nonce', async t => {
  for (const [name, extra, framing, expected] of [
    ['duplicate content type', { 'content-type': 'application/json' }, null, 415],
    ['conflicting content type', { 'content-type': 'text/plain' }, null, 415],
    ['duplicate host', { host: 'other.example' }, null, 400],
    ['length plus transfer encoding', {}, ['Content-Length: 2', 'Transfer-Encoding: chunked'], 400],
    ['duplicate length', {}, ['Content-Length: 2', 'Content-Length: 2'], 400],
    ['invalid length', {}, ['Content-Length: -1'], 400],
    ['encoded transfer', {}, ['Transfer-Encoding: gzip, chunked'], 400]
  ]) await t.test(name, async () => {
    const raw = Buffer.from(JSON.stringify(payload()));
    const headers = signed(raw);
    const response = await socketRequest(runtime.base, wireRequest(raw, { ...headers, ...extra }, framing ? { framing } : {}));
    assert.match(response, new RegExp(`^HTTP/1.1 ${expected} `));
    assert.equal(count('mini_program_request_nonces', 'nonce=?', headers['X-Nonce']), 0);
  });
});

test('advertised oversize is rejected before waiting for bytes and aborted uploads leave the server healthy', async () => {
  const raw = Buffer.from(JSON.stringify(payload()));
  const headers = signed(raw);
  const response = await socketRequest(runtime.base, wireRequest(raw, headers, { framing: ['Content-Length: 999999999'], body: '' }));
  assert.match(response, /^HTTP\/1.1 413 /);
  assert.equal(count('mini_program_request_nonces', 'nonce=?', headers['X-Nonce']), 0);
  const before = count('messages');
  await socketRequest(runtime.base, wireRequest(raw, headers, { body: raw.subarray(0, 5).toString() }), { abort: true });
  assert.equal((await jsonRequest(runtime.base, '/api/health')).response.status, 200);
  assert.equal(count('messages'), before);
  assert.equal(count('mini_program_request_nonces', 'nonce=?', headers['X-Nonce']), 0);
});

test('malformed request URLs return safe 400 before configuration and never log the raw Host or target', async t => {
  for (const enabled of [true, false]) await t.test(`intake ${enabled ? 'enabled' : 'disabled'}`, async t => {
    const isolated = await startServer({ env: { ...runtimeEnv, MINI_PROGRAM_API_ENABLED: String(enabled) } });
    t.after(async () => { await stopChild(isolated.child); cleanupDir(isolated.dir); });
    for (const [name, target, host] of [
      ['exact endpoint with malformed Host', messagePath, 'private-review-host['],
      ['malformed absolute target', 'http://private-review-target[/messages', 'localhost'],
      ['generic API with malformed Host', '/api/health', 'private-review-api-host[']
    ]) await t.test(name, async () => {
      const raw = Buffer.from(JSON.stringify(payload()));
      const headers = signed(raw);
      const response = await socketRequest(isolated.base, wireRequest(raw, headers, { target, host }));
      await jsonRequest(isolated.base, '/api/health');
      const logged = isolated.child.stdoutText + isolated.child.stderrText;
      assert.deepEqual({
        status: Number(/^HTTP\/1.1 (\d+)/.exec(response)?.[1]),
        safeCode: response.includes('"code":"INVALID_REQUEST_TARGET"'),
        exposesInput: /private-review-|ERR_INVALID_URL/.test(response + logged)
      }, { status: 400, safeCode: true, exposesInput: false });
    });
    const observer = new DatabaseSync(isolated.dbPath);
    try {
      assert.equal(observer.prepare('SELECT COUNT(*) AS n FROM mini_program_request_nonces').get().n, 0);
      assert.equal(observer.prepare("SELECT COUNT(*) AS n FROM messages WHERE platform_code='mini_program'").get().n, 0);
    } finally { observer.close(); }
    const validTarget = await submit(payload(), { base: isolated.base });
    if (enabled) assert.equal(validTarget.response.status, 202);
    else assertSafe(validTarget, 503, 'MINI_PROGRAM_API_DISABLED');
  });
});

test('only the exact POST request target accepts messages and other methods have a stable safe response', async t => {
  for (const method of ['GET', 'HEAD', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) await t.test(method, async () => {
    const response = await fetch(runtime.base + messagePath, { method });
    assert.equal(response.status, 405);
    assert.equal(response.headers.get('allow'), 'POST');
    if (method !== 'HEAD') assert.equal((await response.json()).code, 'MINI_PROGRAM_METHOD_NOT_ALLOWED');
  });
  for (const target of [messagePath + '/', messagePath + '/extra', messagePath + '?extra=1', '/open-api/v1/mini-program/../mini-program/messages', '/open-api/v1/mini-program/%6dessages', '/open-api/v1/mini-program//messages', '/open-api/other']) {
    await t.test(target, async () => {
      const raw = Buffer.from(JSON.stringify(payload()));
      const headers = signed(raw);
      const response = await socketRequest(runtime.base, wireRequest(raw, headers, { target }));
      assert.doesNotMatch(response, /^HTTP\/1.1 202 /);
      assert.equal(count('mini_program_request_nonces', 'nonce=?', headers['X-Nonce']), 0);
    });
  }
});

test('conversation user mismatch is 409 and terminal conversations acknowledge without retaining text', async () => {
  const value = payload();
  assert.equal((await submit(value)).response.status, 202);
  assertSafe(await submit({ ...value, messageId: 'wrong-user-' + sequence, userId: 'different-user' }), 409, 'CONVERSATION_USER_MISMATCH');
  db.prepare("UPDATE conversations SET handling_mode='HUMAN_MANAGED' WHERE namespace=?").run(`mini-program:${appId}:${value.conversationId}`);
  const ignoredId = 'ignored-' + sequence;
  const ignored = await submit({ ...value, messageId: ignoredId, text: 'private-body-ignored' });
  assert.deepEqual(ignored.data, { ok: true, accepted: true, messageId: ignoredId, status: 'IGNORED_HANDOFF_COMPLETED' });
  assert.equal(count('messages', 'content=?', 'private-body-ignored'), 0);
  assertSafe(await submit({ ...value, messageId: 'ignored-wrong-user-' + sequence, userId: 'different-user' }), 409, 'CONVERSATION_USER_MISMATCH');
  assert.equal((await submit(value)).data.status, 'ACCEPTED');
});

test('SQLite write contention returns a safe retryable 503 without claiming acceptance', async () => {
  const raw = Buffer.from(JSON.stringify(payload()));
  const headers = signed(raw);
  const before = count('messages');
  db.exec('BEGIN IMMEDIATE');
  try { assertSafe(await submit(raw, { headers }), 503, 'MINI_PROGRAM_TEMPORARILY_UNAVAILABLE'); }
  finally { db.exec('ROLLBACK'); }
  assert.equal(count('messages'), before);
  assert.equal(count('mini_program_request_nonces', 'nonce=?', headers['X-Nonce']), 0);
  assert.equal((await submit(raw, { headers })).response.status, 202);
});

test('unexpected database failures cannot expose internal details in responses or server logs', async () => {
  const raw = Buffer.from(JSON.stringify(payload()));
  const headers = signed(raw);
  const before = count('messages');
  db.exec("CREATE TRIGGER mini_http_fail_insert BEFORE INSERT ON messages BEGIN SELECT RAISE(ABORT,'private-body internal database details'); END");
  try { assertSafe(await submit(raw, { headers }), 500, 'MINI_PROGRAM_INTERNAL_ERROR'); }
  finally { db.exec('DROP TRIGGER mini_http_fail_insert'); }
  assert.equal(count('messages'), before);
  assert.equal(count('mini_program_request_nonces', 'nonce=?', headers['X-Nonce']), 1);
  assert.doesNotMatch(runtime.child.stderrText + runtime.child.stdoutText, /private-body|internal database details/);
});

test('disabled and incomplete configuration fail before content type, signature and nonce handling', async t => {
  for (const [name, env, code] of [
    ['disabled', { MINI_PROGRAM_API_ENABLED: 'false' }, 'MINI_PROGRAM_API_DISABLED'],
    ['missing app', { MINI_PROGRAM_APP_ID: '' }, 'MINI_PROGRAM_CONFIGURATION_INCOMPLETE'],
    ['invalid app', { MINI_PROGRAM_APP_ID: 'x'.repeat(129) }, 'MINI_PROGRAM_CONFIGURATION_INCOMPLETE'],
    ['missing secret', { MINI_PROGRAM_SHARED_SECRET: '' }, 'MINI_PROGRAM_CONFIGURATION_INCOMPLETE'],
    ['short secret', { MINI_PROGRAM_SHARED_SECRET: 'short' }, 'MINI_PROGRAM_CONFIGURATION_INCOMPLETE']
  ]) await t.test(name, async t => {
    const isolated = await startServer({ env: { ...runtimeEnv, ...env } });
    t.after(async () => { await stopChild(isolated.child); cleanupDir(isolated.dir); });
    const raw = Buffer.from(JSON.stringify(payload()));
    const headers = { ...signed(raw), 'Content-Type': 'text/plain', 'X-Signature': '0'.repeat(64) };
    assertSafe(await submit(raw, { base: isolated.base, headers }), 503, code);
    const isolatedDb = new DatabaseSync(isolated.dbPath);
    try {
      assert.equal(isolatedDb.prepare('SELECT COUNT(*) AS n FROM mini_program_request_nonces').get().n, 0);
      assert.equal(isolatedDb.prepare("SELECT COUNT(*) AS n FROM messages WHERE platform_code='mini_program'").get().n, 0);
    } finally { isolatedDb.close(); }
  });
});

test('real server startup drains seeded processing and callbacks with intake and Local Agent off, then restart preserves replay protection', async t => {
  const dir = tempRuntimeDir('mini-http-lifecycle-');
  let isolated;
  let isolatedDb;
  const received = [];
  const callback = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => { received.push(JSON.parse(Buffer.concat(chunks).toString())); res.writeHead(204); res.end(); });
  });
  await new Promise(resolve => callback.listen(0, '127.0.0.1', resolve));
  const callbackUrl = `http://127.0.0.1:${callback.address().port}/callback`;
  t.after(async () => { isolatedDb?.close(); await stopChild(isolated?.child); await new Promise(resolve => callback.close(resolve)); cleanupDir(dir); });
  const seed = spawnNode(['--input-type=module', '-e', `
    const { db, run, now, row } = await import('./src/db.js');
    const { ingestMiniProgramMessage } = await import('./src/services/mini-program-channel.js');
    const { enqueueMiniProgramReply } = await import('./src/services/mini-program-callback.js');
    const { saveMasterSwitch } = await import('./src/services/settings.js');
    saveMasterSwitch(true);
    for (const id of ['processing', 'callback']) ingestMiniProgramMessage({ appId: 'http-test-app', conversationId: id, messageId: id, userId: id, text: 'hello', sentAt: now() });
    const message = row("SELECT * FROM messages WHERE external_id='mini-program:http-test-app:message:callback'");
    run("UPDATE mini_program_processing_jobs SET status='COMPLETED' WHERE message_id=?", message.id);
    enqueueMiniProgramReply({ message, replyText: 'seeded durable reply' });
    run("UPDATE mini_program_processing_jobs SET status='RUNNING',attempt_count=1,claimed_at='2000-01-01T00:00:00.000Z',lease_expires_at='2000-01-01T00:00:01.000Z' WHERE status='PENDING'");
    run("UPDATE mini_program_callback_outbox SET status='SENDING',attempt_count=1,claimed_at='2000-01-01T00:00:00.000Z',lease_expires_at='2000-01-01T00:00:01.000Z'");
    run('INSERT INTO mini_program_request_nonces(app_id,nonce,expires_at,created_at) VALUES(?,?,?,?)', 'http-test-app', 'expired-seeded', '2000-01-01T00:00:01.000Z', '2000-01-01T00:00:00.000Z');
    db.close();
  `], { env: { ...runtimeEnv, DATABASE_PATH: dir + '/runtime.db', MINI_PROGRAM_CALLBACK_URL: callbackUrl } });
  const [seedCode] = await once(seed, 'exit');
  assert.equal(seedCode, 0, seed.stderrText);
  isolated = await startServer({ dir, env: { ...runtimeEnv, MINI_PROGRAM_API_ENABLED: 'false', MINI_PROGRAM_CALLBACK_URL: callbackUrl } });
  isolatedDb = new DatabaseSync(isolated.dbPath);
  assertSafe(await submit(payload(), { base: isolated.base }), 503, 'MINI_PROGRAM_API_DISABLED');
  await eventually(() => isolatedDb.prepare("SELECT status FROM mini_program_processing_jobs WHERE status<>'COMPLETED'").all(), value => value.length === 0);
  // Recovery makes the old callback due now, behind the processing reply: allow two 5s ticks.
  await eventually(() => received, value => value.some(item => item.inReplyToMessageId === 'callback'), 12000);
  assert.ok(received.some(item => item.inReplyToMessageId === 'processing'));
  assert.equal(isolatedDb.prepare("SELECT COUNT(*) AS n FROM message_processing_registry WHERE platform_code='mini_program'").get().n, 2);
  assert.equal(isolatedDb.prepare("SELECT COUNT(*) AS n FROM mini_program_request_nonces WHERE nonce='expired-seeded'").get().n, 0);
  assert.equal(isolatedDb.prepare("SELECT COUNT(*) AS n FROM agent_jobs WHERE job_type='REPLY' AND payload LIKE '%mini_program%'").get().n, 0);
  isolatedDb.close(); isolatedDb = null;
  await stopChild(isolated.child);
  isolated = await startServer({ dir, env: runtimeEnv });
  const raw = Buffer.from(JSON.stringify(payload()));
  const headers = signed(raw);
  assert.equal((await submit(raw, { base: isolated.base, headers })).response.status, 202);
  await stopChild(isolated.child);
  isolated = await startServer({ dir, env: runtimeEnv });
  assertSafe(await submit(raw, { base: isolated.base, headers }), 401, 'MINI_PROGRAM_NONCE_REPLAY');
});

for (const signal of ['SIGINT', 'SIGTERM']) test(`direct server ${signal} stops processing, callback and nonce timers before teardown`, { timeout: 15000 }, async () => {
  const dir = tempRuntimeDir('mini-http-shutdown-');
  const port = await freePort();
  const preload = `
    import assert from 'node:assert/strict';
    import { pathToFileURL } from 'node:url';
    import { mock } from 'node:test';
    mock.timers.enable({ apis: ['setInterval'] });
    process.exit = code => { process.exitCode = code; };
    setTimeout(async () => {
      try {
        const deadline = Date.now() + 8000;
        while (true) {
          try { if ((await fetch('http://127.0.0.1:${port}/api/health')).ok) break; } catch {}
          if (Date.now() > deadline) throw new Error('server did not start');
          await new Promise(resolve => setTimeout(resolve, 30));
        }
        const root = pathToFileURL(process.cwd() + '/');
        const { db, row, run, now } = await import(new URL('./src/db.js', root));
        const { ingestMiniProgramMessage } = await import(new URL('./src/services/mini-program-channel.js', root));
        const { enqueueMiniProgramReply } = await import(new URL('./src/services/mini-program-callback.js', root));
        const { saveMasterSwitch } = await import(new URL('./src/services/settings.js', root));
        saveMasterSwitch(true);
        function seed(id) {
          ingestMiniProgramMessage({ appId: 'http-test-app', conversationId: id, messageId: id, userId: id, text: 'hello', sentAt: now() });
          const message = row('SELECT * FROM messages WHERE external_id=?', 'mini-program:http-test-app:message:' + id);
          enqueueMiniProgramReply({ message, replyText: 'retained reply' });
          run('INSERT INTO mini_program_request_nonces(app_id,nonce,expires_at,created_at) VALUES(?,?,?,?)', 'http-test-app', id, '2000-01-01T00:00:01.000Z', '2000-01-01T00:00:00.000Z');
          return message;
        }
        const first = seed('before-shutdown');
        mock.timers.tick(60001);
        for (let i=0; i<50 && row('SELECT status FROM mini_program_processing_jobs WHERE message_id=?', first.id).status !== 'COMPLETED'; i++) await new Promise(resolve => setTimeout(resolve, 10));
        assert.equal(row('SELECT status FROM mini_program_processing_jobs WHERE message_id=?', first.id).status, 'COMPLETED');
        assert.equal(row('SELECT status FROM mini_program_callback_outbox WHERE message_id=?', first.id).status, 'NOT_CONFIGURED');
        assert.equal(row("SELECT COUNT(*) AS n FROM mini_program_request_nonces WHERE nonce='before-shutdown'").n, 0);
        process.emit('${signal}');
        await new Promise(resolve => setImmediate(resolve));
        const after = seed('after-shutdown');
        mock.timers.tick(60001);
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(row('SELECT status FROM mini_program_processing_jobs WHERE message_id=?', after.id).status, 'PENDING');
        assert.equal(row('SELECT status FROM mini_program_callback_outbox WHERE message_id=?', after.id).status, 'PENDING');
        assert.equal(row("SELECT COUNT(*) AS n FROM mini_program_request_nonces WHERE nonce='after-shutdown'").n, 1);
        mock.timers.reset();
        db.close();
      } catch (error) { console.error(error); process.exitCode = 1; mock.timers.reset(); process.emit('${signal}'); }
    }, 0);
  `;
  const child = spawnNode(['--import', 'data:text/javascript,' + encodeURIComponent(preload), 'src/server.js'], {
    env: { ...runtimeEnv, DATABASE_PATH: dir + '/runtime.db', PORT: String(port), SERVER_HOST: '127.0.0.1', INSTANCE_LOCK_ENABLED: 'false' }
  });
  try {
    const [code] = await Promise.race([once(child, 'exit'), new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('shutdown left open handles')), 12000); timer.unref(); })]);
    assert.equal(code, 0, child.stderrText + child.stdoutText);
  } finally { await stopChild(child); cleanupDir(dir); }
});

test('server imports do not auto-start mini workers and signal shutdown leaves no worker handles', async () => {
  const dir = tempRuntimeDir('mini-http-import-');
  const child = spawnNode(['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    const { db, row, now } = await import('./src/db.js');
    const { ingestMiniProgramMessage } = await import('./src/services/mini-program-channel.js');
    ingestMiniProgramMessage({ appId: 'http-test-app', conversationId: 'import', messageId: 'import', userId: 'import', text: 'hello', sentAt: now() });
    await import('./src/server.js');
    await new Promise(resolve => setTimeout(resolve, 1250));
    assert.equal(row('SELECT status FROM mini_program_processing_jobs').status, 'PENDING');
    process.exit = code => { process.exitCode = code; };
    process.emit('SIGTERM');
  `], { env: { ...runtimeEnv, DATABASE_PATH: dir + '/runtime.db', PORT: '0', INSTANCE_LOCK_ENABLED: 'false' } });
  try {
    const [code] = await Promise.race([once(child, 'exit'), new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('worker handles prevented shutdown')), 8000); timer.unref(); })]);
    assert.equal(code, 0, child.stderrText);
  } finally { await stopChild(child); cleanupDir(dir); }
});

const npmEntry = path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
for (const [name, args, skip] of [
  ['canonical direct', ['src/server.js'], false],
  ['Windows alternate-case direct', ['src/SERVER.js'], process.platform !== 'win32'],
  ['npm start', [npmEntry, 'start'], !fs.existsSync(npmEntry)]
]) test(`${name} server entry drains an accepted durable message`, { skip, timeout: 12000 }, async t => {
  const dir = tempRuntimeDir('mini-http-entry-');
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const marker = 'mini-program-entry-server-pid:';
  const preload = `if (/[\\\\/]server\\.js$/i.test(process.argv[1] || '')) console.log('${marker}' + process.pid);`;
  const child = spawnNode(args, { env: {
    ...runtimeEnv, DATABASE_PATH: path.join(dir, 'runtime.db'), PORT: String(port), SERVER_HOST: '127.0.0.1',
    NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --import=data:text/javascript,${encodeURIComponent(preload)}`.trim()
  } });
  let observer;
  t.after(async () => {
    observer?.close();
    const serverPid = Number(new RegExp(marker + '(\\d+)').exec(child.stdoutText)?.[1]);
    if (serverPid && serverPid !== child.pid) { try { process.kill(serverPid, 'SIGTERM'); } catch {} }
    await stopChild(child);
    cleanupDir(dir);
  });
  await waitForHttp(base, '/api/health', child);
  const value = payload();
  assert.equal((await submit(value, { base })).response.status, 202);
  observer = new DatabaseSync(path.join(dir, 'runtime.db'));
  await eventually(() => observer.prepare('SELECT status FROM mini_program_processing_jobs').get(), job => job?.status === 'COMPLETED', 3500);
  assert.equal(observer.prepare('SELECT COUNT(*) AS n FROM mini_program_callback_outbox').get().n, 1);
});
