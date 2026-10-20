import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import { cleanupDir, startServer, stopChild, tempRuntimeDir } from './helpers/runtime.js';

const messagePath = '/open-api/v1/mini-program/messages';
const callbackPath = '/callbacks/mini-program/messages';
const appId = 'flow-test-app';
const secret = 'mini-program-flow-test-secret-at-least-32-characters';
const wecomUrl = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=flow-test-key-123456';

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

async function closeServer(server) {
  if (!server?.listening) return;
  server.closeAllConnections?.();
  await new Promise(resolve => server.close(resolve));
}

async function readRaw(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function signedHeaders(rawBody, { nonce = crypto.randomUUID(), timestamp = String(Math.floor(Date.now() / 1000)) } = {}) {
  const canonical = ['POST', messagePath, timestamp, nonce, crypto.createHash('sha256').update(rawBody).digest('hex')].join('\n');
  return {
    'Content-Type': 'application/json',
    'X-Mini-App-Id': appId,
    'X-Timestamp': timestamp,
    'X-Nonce': nonce,
    'X-Signature': crypto.createHmac('sha256', secret).update(canonical).digest('hex')
  };
}

function diagnostic(value) {
  try { return JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item); }
  catch { return String(value); }
}

async function eventually(read, predicate, { timeoutMs = 12_000, label = 'durable state' } = {}) {
  const deadline = Date.now() + timeoutMs;
  let value;
  let lastError = null;
  do {
    try {
      value = await read();
      lastError = null;
      if (predicate(value)) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  assert.fail(`Timed out waiting for ${label}: ${lastError?.message || diagnostic(value)}`);
}

test('mini program channel preserves the end-to-end RAG, callback, handoff and recovery contract', { timeout: 120_000 }, async t => {
  const dir = tempRuntimeDir('mini-program-flow-');
  const dbPath = path.join(dir, 'runtime.db');
  Object.assign(process.env, {
    DATABASE_PATH: dbPath,
    INSTANCE_LOCK_ENABLED: 'false',
    MINI_PROGRAM_API_ENABLED: 'true',
    MINI_PROGRAM_APP_ID: appId,
    MINI_PROGRAM_SHARED_SECRET: secret,
    WECOM_WEBHOOK_URL: wecomUrl,
    SQLITE_BUSY_TIMEOUT_MS: '5000',
    SQLITE_BUSY_RETRIES: '5'
  });

  const ragRequests = [];
  const ragErrors = [];
  let ragServer = null;
  const callbackReceipts = [];
  const callbackErrors = [];
  const callbackEventIds = new Set();
  let callbackServer = null;
  let runtime = null;
  let db = null;
  let deliverNotification;

  t.after(async () => {
    const current = runtime;
    runtime = null;
    await stopChild(current?.child);
    db?.close();
    await Promise.all([closeServer(ragServer), closeServer(callbackServer)]);
    cleanupDir(dir);
  });

  ragServer = http.createServer((req, res) => {
    void (async () => {
      if (req.method !== 'POST' || req.url !== '/rag-api/v1/query') {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 'NOT_FOUND' } }));
        return;
      }
      const rawBody = await readRaw(req);
      const payload = JSON.parse(rawBody.toString('utf8'));
      ragRequests.push({ rawBody, payload });
      const noAnswer = String(payload.query?.text || '').startsWith('无答案');
      const response = noAnswer
        ? {
            requestId: payload.requestId,
            result: 'NO_ANSWER',
            snapshot: payload.snapshot,
            grounding: { confidence: 0, sourceReferences: [] },
            meta: { knowledgeVersion: 'flow-release-1' }
          }
        : {
            requestId: payload.requestId,
            result: 'ANSWERED',
            snapshot: payload.snapshot,
            answer: { text: `正式知识回答：${payload.query.text}` },
            grounding: {
              confidence: 0.97,
              confidenceBand: 'HIGH',
              sourceReferences: [{ documentId: 'flow-document', documentVersion: 1, chunkId: 'flow-chunk' }]
            },
            meta: { knowledgeVersion: 'flow-release-1' }
          };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(response));
    })().catch(error => {
      ragErrors.push(error.message);
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'FAKE_RAG_ERROR' } }));
    });
  });
  const ragPort = await listen(ragServer);

  callbackServer = http.createServer((req, res) => {
    void (async () => {
      const rawBody = await readRaw(req);
      const timestamp = String(req.headers['x-timestamp'] || '');
      const nonce = String(req.headers['x-nonce'] || '');
      const signature = String(req.headers['x-signature'] || '');
      const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
      const canonical = [req.method, pathname, timestamp, nonce, crypto.createHash('sha256').update(rawBody).digest('hex')].join('\n');
      const expected = crypto.createHmac('sha256', secret).update(canonical).digest('hex');
      const validSignature = /^[a-f0-9]{64}$/.test(signature)
        && crypto.timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex'));
      const payload = JSON.parse(rawBody.toString('utf8'));
      const duplicateEvent = callbackEventIds.has(payload.eventId);
      callbackEventIds.add(payload.eventId);
      callbackReceipts.push({
        rawBody,
        payload,
        validSignature,
        duplicateEvent,
        appHeader: String(req.headers['x-mini-app-id'] || ''),
        timestamp,
        nonce,
        pathname
      });
      if (req.method !== 'POST' || pathname !== callbackPath || !validSignature || !timestamp || !nonce
        || req.headers['x-mini-app-id'] !== appId) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false }));
        return;
      }
      res.writeHead(204);
      res.end();
    })().catch(error => {
      callbackErrors.push(error.message);
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false }));
    });
  });
  const callbackPort = await listen(callbackServer);

  const runtimeEnv = {
    MINI_PROGRAM_API_ENABLED: 'true',
    MINI_PROGRAM_APP_ID: appId,
    MINI_PROGRAM_SHARED_SECRET: secret,
    MINI_PROGRAM_CALLBACK_URL: `http://127.0.0.1:${callbackPort}${callbackPath}`,
    MINI_PROGRAM_CALLBACK_TIMEOUT_MS: '2000',
    RAG_BASE_URL: `http://127.0.0.1:${ragPort}`,
    RAG_FORMAL_ROUTING_ENABLED: 'true',
    RAG_TIMEOUT_MS: '2000',
    BUSINESS_GUIDANCE_MAX_ATTEMPTS: '3',
    WECOM_WEBHOOK_URL: '',
    SQLITE_BUSY_TIMEOUT_MS: '5000',
    SQLITE_BUSY_RETRIES: '5',
    INSTANCE_LOCK_ENABLED: 'true'
  };

  async function launchRuntime() {
    assert.equal(runtime, null, 'runtime must be stopped before launch');
    runtime = await startServer({ dir, env: runtimeEnv });
    return runtime;
  }

  async function haltRuntime() {
    const current = runtime;
    runtime = null;
    await stopChild(current?.child);
  }

  let sequence = 0;
  function message(overrides = {}) {
    const id = ++sequence;
    return {
      appId,
      conversationId: `flow-conversation-${id}`,
      messageId: `flow-message-${id}`,
      userId: `flow-user-${id}`,
      text: `办理第${id}项业务需要什么材料？`,
      sentAt: new Date().toISOString(),
      ...overrides
    };
  }

  async function submit(value) {
    assert.ok(runtime, 'runtime is not running');
    const rawBody = Buffer.from(JSON.stringify(value));
    const headers = signedHeaders(rawBody);
    const response = await fetch(runtime.base + messagePath, {
      method: 'POST',
      headers,
      body: rawBody,
      signal: AbortSignal.timeout(8_000)
    });
    const responseText = await response.text();
    let data;
    try { data = JSON.parse(responseText); } catch { data = responseText; }
    return { response, responseText, data, rawBody, headers };
  }

  function externalMessageId(messageId) {
    return `mini-program:${appId}:message:${messageId}`;
  }

  let row;
  let rows;
  function storedMessage(messageId) {
    return row('SELECT * FROM messages WHERE external_id=?', externalMessageId(messageId));
  }

  function callbacksFor(messageId) {
    return callbackReceipts.filter(item => item.payload?.inReplyToMessageId === messageId);
  }

  function ragForText(text) {
    return ragRequests.filter(item => item.payload?.query?.text === text);
  }

  function assertAccepted(result, value, status = 'ACCEPTED') {
    assert.equal(result.response.status, 202, result.responseText);
    assert.deepEqual(result.data, { ok: true, accepted: true, messageId: value.messageId, status });
  }

  async function waitForDelivered(messageId, timeoutMs = 12_000) {
    return eventually(() => {
      const stored = storedMessage(messageId);
      const processing = stored && row('SELECT * FROM mini_program_processing_jobs WHERE message_id=?', stored.id);
      const callback = stored && row('SELECT * FROM mini_program_callback_outbox WHERE message_id=?', stored.id);
      const receipts = callbacksFor(messageId);
      return { stored, processing, callback, receipts };
    }, state => state.stored?.status === 'AUTO_REPLIED'
      && state.processing?.status === 'COMPLETED'
      && state.callback?.status === 'SENT'
      && state.receipts.length === 1
      && state.receipts[0].validSignature,
    { timeoutMs, label: `callback delivery for ${messageId}` });
  }

  ({ db, row, rows } = await import('../src/db.js'));
  ({ deliverNotification } = await import('../src/services/notification.js'));
  await launchRuntime();

  await t.test('normal questions use the formal unified knowledge base and a raw-byte signed callback only', async () => {
    const value = message({
      conversationId: 'normal-flow',
      messageId: 'normal-flow-1',
      userId: 'normal-user',
      text: '创业补贴业务需要什么材料？'
    });
    const result = await submit(value);
    assertAccepted(result, value);

    const acceptedMessage = storedMessage(value.messageId);
    assert.ok(acceptedMessage, '202 is returned only after the message is durable');
    assert.equal(acceptedMessage.content, value.text);
    const acceptedJob = row('SELECT * FROM mini_program_processing_jobs WHERE message_id=?', acceptedMessage.id);
    assert.ok(acceptedJob, '202 is returned only after the processing job is durable');

    const state = await waitForDelivered(value.messageId);
    assert.equal(state.stored.reply_job_id, null);
    assert.equal(state.stored.reply_text, `正式知识回答：${value.text}`);
    assert.equal(row('SELECT COUNT(*) AS count FROM messages WHERE external_id=?', externalMessageId(value.messageId)).count, 1);
    assert.equal(row('SELECT COUNT(*) AS count FROM mini_program_processing_jobs WHERE message_id=?', state.stored.id).count, 1);
    assert.equal(row('SELECT COUNT(*) AS count FROM mini_program_callback_outbox WHERE message_id=?', state.stored.id).count, 1);
    assert.equal(row("SELECT COUNT(*) AS count FROM agent_jobs WHERE job_type='REPLY'").count, 0);

    const requests = ragForText(value.text);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].payload.contractVersion, '1.0');
    assert.equal(requests[0].payload.knowledgeScope.knowledgeBaseId, 'main-business-kb');
    assert.equal(requests[0].payload.knowledgeScope.tenantId, 'local-default');
    assert.deepEqual(requests[0].payload.source, {
      platform: 'DOUYIN',
      accountId: String(state.stored.account_id),
      channelType: 'DIRECT_MESSAGE'
    });
    assert.equal(requests[0].payload.snapshot.conversationKey, `mini-program:${appId}:${value.conversationId}`);
    assert.match(requests[0].payload.snapshot.inputFingerprint, /^sha256:[a-f0-9]{64}$/);

    const receipt = state.receipts[0];
    assert.equal(receipt.pathname, callbackPath);
    assert.equal(receipt.appHeader, appId);
    assert.equal(receipt.validSignature, true);
    assert.equal(receipt.duplicateEvent, false);
    assert.deepEqual(Object.keys(receipt.payload).sort(), [
      'appId', 'conversationId', 'createdAt', 'eventId', 'inReplyToMessageId', 'text', 'type', 'userId'
    ]);
    assert.equal(receipt.payload.type, 'assistant.message');
    assert.equal(receipt.payload.appId, appId);
    assert.equal(receipt.payload.conversationId, value.conversationId);
    assert.equal(receipt.payload.userId, value.userId);
    assert.equal(receipt.payload.inReplyToMessageId, value.messageId);
    assert.equal(receipt.payload.text, `正式知识回答：${value.text}`);
    assert.match(receipt.payload.eventId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.ok(!Number.isNaN(Date.parse(receipt.payload.createdAt)));
    assert.deepEqual(ragErrors, []);
    assert.deepEqual(callbackErrors, []);
  });

  await t.test('mini program keeps only three historical rounds after confirmed callbacks', async () => {
    for (let index = 1; index <= 5; index += 1) {
      const value = message({ conversationId: 'three-round-context', messageId: `three-round-${index}`, userId: 'three-round-user', text: `小程序业务咨询第${index}个问题` });
      assertAccepted(await submit(value), value);
      await waitForDelivered(value.messageId);
    }
    const requests = ragForText('小程序业务咨询第5个问题');
    assert.equal(requests.length, 1);
    assert.deepEqual(requests[0].payload.context.map(item => [item.role, item.text]), [
      ['USER', '小程序业务咨询第2个问题'], ['ASSISTANT', '正式知识回答：小程序业务咨询第2个问题'],
      ['USER', '小程序业务咨询第3个问题'], ['ASSISTANT', '正式知识回答：小程序业务咨询第3个问题'],
      ['USER', '小程序业务咨询第4个问题'], ['ASSISTANT', '正式知识回答：小程序业务咨询第4个问题']
    ]);
  });

  await t.test('the third unresolved round hands off automatically, and notification confirmation terminates collection and marks user history', async () => {
    const conversationId = 'clarification-flow';
    const userId = 'clarification-user';
    const clarificationValues = [];
    for (let index = 1; index <= 3; index += 1) {
      const value = message({
        conversationId,
        messageId: `clarification-${index}`,
        userId,
        text: `无答案问题第${index}轮`
      });
      clarificationValues.push(value);
      const result = await submit(value);
      assertAccepted(result, value);
      if (index < 3) await waitForDelivered(value.messageId);
    }

    const clarificationCallbacks = clarificationValues.slice(0, 2).map(value => callbacksFor(value.messageId)[0].payload);
    assert.deepEqual(clarificationCallbacks.map(item => item.text), [
      '你想问哪件事？把业务或活动名字发我，再说下你想了解什么就行。',
      '你想问哪件事？把业务或活动名字发我，再说下你想了解什么就行。'
    ]);
    assert.doesNotMatch(clarificationCallbacks[0].text, /转人工/);
    assert.doesNotMatch(clarificationCallbacks[1].text, /转人工/);
    const handoffValue = clarificationValues[2];
    await eventually(
      () => row('SELECT status FROM mini_program_processing_jobs WHERE message_id=?', storedMessage(handoffValue.messageId)?.id),
      job => job?.status === 'COMPLETED',
      { timeoutMs: 5_000, label: 'automatic guidance handoff completion' }
    );
    assert.equal(callbacksFor(handoffValue.messageId).length, 0);
    assert.deepEqual(clarificationValues.map(value => ragForText(value.text).length), [1, 1, 1]);

    const conversation = row('SELECT * FROM conversations WHERE namespace=?', `mini-program:${appId}:${conversationId}`);
    assert.equal(conversation.clarification_attempts, 3);
    assert.equal(row('SELECT COUNT(*) AS count FROM notifications WHERE conversation_id=?', conversation.id).count, 1);

    const notification = await eventually(() => row('SELECT * FROM notifications WHERE conversation_id=?', conversation.id), Boolean, {
      timeoutMs: 5_000,
      label: 'automatic guidance handoff notification'
    });
    assert.equal(notification.type, 'RAG_CLARIFICATION_LIMIT');
    const pendingConversation = row('SELECT * FROM conversations WHERE id=?', conversation.id);
    assert.equal(pendingConversation.handling_mode, 'HANDOFF_PENDING');
    assert.equal(notification.message_id, storedMessage(handoffValue.messageId).id);
    assert.equal(row('SELECT COUNT(*) AS count FROM notifications WHERE conversation_id=?', conversation.id).count, 1);
    assert.equal(row('SELECT COUNT(*) AS count FROM mini_program_callback_outbox WHERE message_id=?', storedMessage(handoffValue.messageId).id).count, 0);
    assert.equal(callbacksFor(handoffValue.messageId).length, 0);
    assert.equal(callbackReceipts.some(item => /已转人工/.test(item.payload?.text || '')), false);

    const ragCountBeforePending = ragRequests.length;
    const callbackCountBeforePending = callbackReceipts.length;
    const pendingValue = message({ conversationId, messageId: 'clarification-pending', userId, text: '通知人工期间补充的文字' });
    const pendingResult = await submit(pendingValue);
    assertAccepted(pendingResult, pendingValue);
    const pendingMessage = storedMessage(pendingValue.messageId);
    assert.ok(pendingMessage);
    assert.equal(pendingMessage.content, pendingValue.text);
    assert.equal(row('SELECT COUNT(*) AS count FROM mini_program_processing_jobs WHERE message_id=?', pendingMessage.id).count, 0);
    assert.equal(row('SELECT COUNT(*) AS count FROM mini_program_callback_outbox WHERE message_id=?', pendingMessage.id).count, 0);
    assert.equal(row('SELECT COUNT(*) AS count FROM notifications WHERE conversation_id=?', conversation.id).count, 1);
    assert.equal(ragRequests.length, ragCountBeforePending);
    assert.equal(callbackReceipts.length, callbackCountBeforePending);

    await haltRuntime();
    const delivered = await deliverNotification(notification, {
      fetchImpl: async () => new Response(JSON.stringify({ errcode: 0, errmsg: 'ok' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      })
    });
    assert.equal(delivered.delivered, true);
    assert.equal(delivered.confirmed, true);
    const managedConversation = row('SELECT * FROM conversations WHERE id=?', conversation.id);
    assert.equal(managedConversation.handling_mode, 'HUMAN_MANAGED');
    assert.equal(managedConversation.handoff_notification_id, notification.id);
    assert.ok(managedConversation.handoff_confirmed_at);
    const historicalUser = row('SELECT * FROM mini_program_users WHERE app_id=? AND external_user_id=?', appId, userId);
    assert.ok(historicalUser.first_handoff_at);
    assert.ok(historicalUser.last_handoff_at);
    assert.equal(historicalUser.last_conversation_id, conversation.id);
    assert.equal(historicalUser.handoff_count, 1);

    await launchRuntime();
    const messageCountBeforeIgnored = row('SELECT COUNT(*) AS count FROM messages WHERE conversation_id=?', conversation.id).count;
    const totalNotificationsBeforeIgnored = row('SELECT COUNT(*) AS count FROM notifications').count;
    const totalCallbacksBeforeIgnored = row('SELECT COUNT(*) AS count FROM mini_program_callback_outbox').count;
    const totalJobsBeforeIgnored = row('SELECT COUNT(*) AS count FROM mini_program_processing_jobs').count;
    const ragCountBeforeIgnored = ragRequests.length;
    const ignoredValue = message({ conversationId, messageId: 'clarification-ignored', userId, text: '这段终止后的正文不能落库' });
    const ignoredResult = await submit(ignoredValue);
    assertAccepted(ignoredResult, ignoredValue, 'IGNORED_HANDOFF_COMPLETED');
    assert.equal(row('SELECT COUNT(*) AS count FROM messages WHERE conversation_id=?', conversation.id).count, messageCountBeforeIgnored);
    assert.equal(storedMessage(ignoredValue.messageId), undefined);
    assert.equal(row('SELECT COUNT(*) AS count FROM notifications').count, totalNotificationsBeforeIgnored);
    assert.equal(row('SELECT COUNT(*) AS count FROM mini_program_callback_outbox').count, totalCallbacksBeforeIgnored);
    assert.equal(row('SELECT COUNT(*) AS count FROM mini_program_processing_jobs').count, totalJobsBeforeIgnored);
    assert.equal(ragRequests.length, ragCountBeforeIgnored);

    const historicalConversationId = 'historical-user-new-flow';
    const historicalValue = message({
      conversationId: historicalConversationId,
      messageId: 'historical-user-new-1',
      userId,
      text: '历史人工用户新会话的第一段文字'
    });
    const ragCountBeforeHistorical = ragRequests.length;
    const callbackCountBeforeHistorical = callbackReceipts.length;
    const historicalResult = await submit(historicalValue);
    assertAccepted(historicalResult, historicalValue);
    const historicalMessage = storedMessage(historicalValue.messageId);
    const historicalConversation = row('SELECT * FROM conversations WHERE id=?', historicalMessage.conversation_id);
    const historicalNotification = row('SELECT * FROM notifications WHERE conversation_id=?', historicalConversation.id);
    assert.equal(historicalMessage.content, historicalValue.text);
    assert.equal(historicalConversation.handling_mode, 'HANDOFF_PENDING');
    assert.equal(row('SELECT COUNT(*) AS count FROM messages WHERE conversation_id=?', historicalConversation.id).count, 1);
    assert.equal(row('SELECT COUNT(*) AS count FROM mini_program_processing_jobs WHERE message_id=?', historicalMessage.id).count, 0);
    assert.equal(row('SELECT COUNT(*) AS count FROM mini_program_callback_outbox WHERE message_id=?', historicalMessage.id).count, 0);
    assert.equal(row('SELECT COUNT(*) AS count FROM notifications WHERE conversation_id=?', historicalConversation.id).count, 1);
    assert.match(historicalNotification.content, /历史人工用户再次咨询/);
    assert.match(historicalNotification.content, new RegExp(userId));
    assert.match(historicalNotification.content, new RegExp(historicalConversationId));
    assert.match(historicalNotification.content, new RegExp(historicalValue.text));
    assert.equal(JSON.parse(historicalNotification.metadata_json).reason, '历史人工用户再次咨询');
    assert.equal(ragRequests.length, ragCountBeforeHistorical);
    assert.equal(callbackReceipts.length, callbackCountBeforeHistorical);

    const otherValue = message({
      conversationId: 'other-user-flow',
      messageId: 'other-user-flow-1',
      userId: 'other-user',
      text: '其他用户办理业务需要哪些材料？'
    });
    const otherResult = await submit(otherValue);
    assertAccepted(otherResult, otherValue);
    const otherState = await waitForDelivered(otherValue.messageId);
    assert.equal(row('SELECT handling_mode FROM conversations WHERE id=?', otherState.stored.conversation_id).handling_mode, 'BOT_ACTIVE');
    assert.equal(ragForText(otherValue.text).length, 1);
    assert.equal(callbacksFor(otherValue.messageId).length, 1);
    assert.equal(row("SELECT COUNT(*) AS count FROM agent_jobs WHERE job_type='REPLY'").count, 0);
  });

  await t.test('queued work survives a real restart and concurrent intake remains idempotent and user-isolated', async () => {
    await haltRuntime();
    await launchRuntime();

    const callbackSeed = message({
      conversationId: 'restart-callback-flow',
      messageId: 'restart-callback-1',
      userId: 'restart-callback-user',
      text: '重启前生成回调的业务问题'
    });
    assertAccepted(await submit(callbackSeed), callbackSeed);
    const callbackQueued = await eventually(() => {
      const stored = storedMessage(callbackSeed.messageId);
      const processing = stored && row('SELECT * FROM mini_program_processing_jobs WHERE message_id=?', stored.id);
      const callback = stored && row('SELECT * FROM mini_program_callback_outbox WHERE message_id=?', stored.id);
      return { stored, processing, callback };
    }, state => state.processing?.status === 'COMPLETED' && state.callback?.status === 'PENDING', {
      timeoutMs: 3_500,
      label: 'callback queued before restart'
    });
    assert.equal(callbacksFor(callbackSeed.messageId).length, 0);

    const processingSeed = message({
      conversationId: 'restart-processing-flow',
      messageId: 'restart-processing-1',
      userId: 'restart-processing-user',
      text: '重启前排队处理的业务问题'
    });
    assertAccepted(await submit(processingSeed), processingSeed);
    const processingMessage = storedMessage(processingSeed.messageId);
    const processingQueued = row('SELECT * FROM mini_program_processing_jobs WHERE message_id=?', processingMessage.id);
    assert.equal(processingQueued.status, 'PENDING');
    assert.equal(row('SELECT COUNT(*) AS count FROM mini_program_callback_outbox WHERE message_id=?', processingMessage.id).count, 0);

    await haltRuntime();
    assert.equal(row('SELECT status FROM mini_program_callback_outbox WHERE id=?', callbackQueued.callback.id).status, 'PENDING');
    assert.equal(row('SELECT status FROM mini_program_processing_jobs WHERE id=?', processingQueued.id).status, 'PENDING');
    await launchRuntime();

    const recoveredCallback = await waitForDelivered(callbackSeed.messageId, 14_000);
    const recoveredProcessing = await waitForDelivered(processingSeed.messageId, 14_000);
    assert.equal(recoveredCallback.callback.attempt_count, 1);
    assert.equal(recoveredProcessing.processing.attempt_count, 1);
    assert.equal(ragForText(callbackSeed.text).length, 1);
    assert.equal(ragForText(processingSeed.text).length, 1);
    assert.equal(callbacksFor(callbackSeed.messageId).length, 1);
    assert.equal(callbacksFor(processingSeed.messageId).length, 1);

    const duplicateValue = message({
      conversationId: 'concurrent-duplicate-flow',
      messageId: 'concurrent-duplicate-1',
      userId: 'concurrent-duplicate-user',
      text: '并发幂等业务问题'
    });
    const duplicateResults = await Promise.all(Array.from({ length: 8 }, () => submit(duplicateValue)));
    for (const result of duplicateResults) assertAccepted(result, duplicateValue);
    assert.equal(new Set(duplicateResults.map(result => result.headers['X-Nonce'])).size, duplicateResults.length);
    const duplicateState = await waitForDelivered(duplicateValue.messageId);
    assert.equal(row('SELECT COUNT(*) AS count FROM messages WHERE external_id=?', externalMessageId(duplicateValue.messageId)).count, 1);
    assert.equal(row('SELECT COUNT(*) AS count FROM mini_program_processing_jobs WHERE message_id=?', duplicateState.stored.id).count, 1);
    assert.equal(row('SELECT COUNT(*) AS count FROM mini_program_callback_outbox WHERE message_id=?', duplicateState.stored.id).count, 1);
    assert.equal(ragForText(duplicateValue.text).length, 1);
    assert.equal(callbacksFor(duplicateValue.messageId).length, 1);

    const sharedConversationId = 'concurrent-user-binding-flow';
    const contenders = [
      message({
        conversationId: sharedConversationId,
        messageId: 'concurrent-user-a',
        userId: 'concurrent-user-a',
        text: '甲用户办理业务需要什么材料？'
      }),
      message({
        conversationId: sharedConversationId,
        messageId: 'concurrent-user-b',
        userId: 'concurrent-user-b',
        text: '乙用户办理业务需要什么材料？'
      })
    ];
    const contenderResults = await Promise.all(contenders.map(value => submit(value)));
    assert.deepEqual(contenderResults.map(result => result.response.status).sort(), [202, 409]);
    const acceptedIndex = contenderResults.findIndex(result => result.response.status === 202);
    const rejectedIndex = acceptedIndex === 0 ? 1 : 0;
    assertAccepted(contenderResults[acceptedIndex], contenders[acceptedIndex]);
    assert.equal(contenderResults[rejectedIndex].data.code, 'CONVERSATION_USER_MISMATCH');

    const boundConversation = row('SELECT * FROM conversations WHERE namespace=?', `mini-program:${appId}:${sharedConversationId}`);
    const boundMessages = rows('SELECT * FROM messages WHERE conversation_id=? ORDER BY id', boundConversation.id);
    assert.equal(boundConversation.user_name, contenders[acceptedIndex].userId);
    assert.equal(boundMessages.length, 1);
    assert.equal(boundMessages[0].user_name, contenders[acceptedIndex].userId);
    assert.equal(boundMessages[0].content, contenders[acceptedIndex].text);
    assert.equal(storedMessage(contenders[rejectedIndex].messageId), undefined);
    assert.equal(row('SELECT COUNT(*) AS count FROM mini_program_processing_jobs WHERE conversation_id=?', boundConversation.id).count, 1);
    const winnerState = await waitForDelivered(contenders[acceptedIndex].messageId);
    assert.equal(ragForText(contenders[acceptedIndex].text).length, 1);
    assert.equal(ragForText(contenders[rejectedIndex].text).length, 0);
    assert.equal(callbacksFor(contenders[acceptedIndex].messageId).length, 1);
    assert.equal(row('SELECT COUNT(*) AS count FROM mini_program_callback_outbox WHERE conversation_id=?', winnerState.stored.conversation_id).count, 1);
    assert.equal(row("SELECT COUNT(*) AS count FROM agent_jobs WHERE job_type='REPLY'").count, 0);
    assert.deepEqual(ragErrors, []);
    assert.deepEqual(callbackErrors, []);
    assert.equal(callbackReceipts.every(receipt => receipt.validSignature && !receipt.duplicateEvent), true);
  });
});
