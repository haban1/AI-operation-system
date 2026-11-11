import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { freePort, spawnNode, waitForHttp, stopChild, cleanupDir, jsonRequest, tempRuntimeDir } from './helpers/runtime.js';

async function listen(server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString() || '{}');
}

function sendJson(response, data, status = 200) {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(data));
}

async function within(promise, description) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error(description)), 3000); })
    ]);
  } finally { clearTimeout(timer); }
}

test('评论人工邀约生成期间消息失效，不写入旧意图或回复任务', async t => {
  const dir = tempRuntimeDir('comment-handoff-race-');
  const ragRequests = [];
  const aiRequests = [];
  let activeGeneration = null;
  let runtime = null;
  let db = null;
  const rag = http.createServer(async (request, response) => {
    if (request.method !== 'POST' || request.url !== '/rag-api/v1/query') return sendJson(response, { error: 'unexpected RAG request' }, 404);
    const input = await readJson(request);
    ragRequests.push(input);
    sendJson(response, {
      requestId: input.requestId, snapshot: input.snapshot, result: 'NO_ANSWER',
      grounding: { confidence: 0, sourceReferences: [] }, meta: { knowledgeVersion: 'race-fixture' }
    });
  });
  const ai = http.createServer(async (request, response) => {
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') return sendJson(response, { error: 'unexpected AI request' }, 404);
    const input = await readJson(request);
    // Startup alias workers share the AI endpoint; only the comment composer is the race barrier.
    if (!String(input.messages?.[0]?.content || '').includes('"acknowledgement"')) {
      return sendJson(response, { choices: [{ message: { content: JSON.stringify({ aliases: [] }) } }] });
    }
    const generation = activeGeneration;
    if (!generation) return sendJson(response, { error: 'generation was not expected' }, 500);
    aiRequests.push(input);
    generation.started.resolve({ input, authorization: request.headers.authorization });
    await generation.release.promise;
    sendJson(response, {
      choices: [{ message: { content: JSON.stringify({ acknowledgement: '明白，你想了解舞蹈课的报名方式。' }) } }],
      usage: { prompt_tokens: 70, completion_tokens: 24, total_tokens: 94 }
    });
  });
  t.after(async () => {
    activeGeneration?.release.resolve();
    await stopChild(runtime?.child);
    db?.close();
    await Promise.all([rag, ai].map(server => new Promise(resolve => server.close(resolve))));
    cleanupDir(dir);
  });
  const ragBase = await listen(rag);
  const aiBase = await listen(ai);
  const appPort = await freePort();
  runtime = { base: `http://127.0.0.1:${appPort}`, dbPath: path.join(dir, 'runtime.db') };
  runtime.child = spawnNode(['src/server.js'], { env: {
    PORT: String(appPort), SERVER_HOST: '127.0.0.1', DATABASE_PATH: runtime.dbPath,
    NODE_ENV: 'test', TIANHE_SKIP_DOTENV: 'true', INSTANCE_LOCK_ENABLED: 'false',
    CONTENT_LIBRARY_SEED_ENABLED: 'false',
    SETTINGS_KEY_PATH: path.join(dir, '.settings-key'), SETTINGS_ENCRYPTION_KEY: 'comment-race-isolated-key',
    QWEN_MODE: 'online', QWEN_API_KEY: 'test-comment-race-key', DASHSCOPE_API_KEY: '',
    QWEN_BASE_URL: `${aiBase}/v1`, QWEN_MODEL: 'comment-race-model',
    RAG_FORMAL_ROUTING_ENABLED: 'true', RAG_ADMIN_ENABLED: 'false', RAG_BASE_URL: ragBase,
    RAG_TIMEOUT_MS: '2000', WECOM_WEBHOOK_URL: ''
  } });
  await waitForHttp(runtime.base, '/api/health', runtime.child, 15000);
  db = new DatabaseSync(runtime.dbPath);
  db.exec('PRAGMA busy_timeout=5000');
  const account = (await jsonRequest(runtime.base, '/api/bootstrap')).data.accounts.find(item => item.platform_code === 'douyin');
  assert.ok(account);

  for (const invalidation of ['handled', 'newer-conversation']) {
    await t.test(invalidation === 'handled' ? '已人工处理的消息保持原状态' : '新会话版本使旧邀约作废', async () => {
      const generation = { started: Promise.withResolvers(), release: Promise.withResolvers() };
      activeGeneration = generation;
      const externalId = `comment-offer-race-${invalidation}`;
      const pending = JSON.stringify({ candidateQuestion: '更新后的业务问题', source_message_id: 987654, race: invalidation });
      const offeredAt = '2026-01-02T03:04:05.000Z';
      const updatedAt = '2026-01-02T03:04:06.000Z';
      const responsePromise = jsonRequest(runtime.base, '/api/messages/simulate', {
        method: 'POST', signal: AbortSignal.timeout(6000), body: {
          platformCode: 'douyin', accountId: account.id, messageType: 'COMMENT',
          externalId, userName: '竞态测试用户', content: '舞蹈课怎么报名？',
          context: {
            conversationId: externalId, messageId: externalId, actorPlatformId: `actor-${invalidation}`,
            noteId: `work-${invalidation}`, commentId: `comment-${invalidation}`,
            direction: 'incoming', sourceVerified: true, previewOnly: false, unreadCount: 1
          }
        }
      }).then(value => ({ value }), error => ({ error }));
      let before;
      let response;
      try {
        const started = await within(generation.started.promise, '评论未进入阻塞的AI邀约生成');
        assert.equal(started.authorization, 'Bearer test-comment-race-key');
        assert.equal(started.input.model, 'comment-race-model');
        assert.equal(started.input.response_format.type, 'json_object');
        assert.deepEqual(JSON.parse(started.input.messages[1].content), { question: '舞蹈课怎么报名？' });
        before = db.prepare('SELECT * FROM messages WHERE external_id=?').get(externalId);
        assert.ok(before?.conversation_id);
        assert.equal(before.reply_job_id, null);
        assert.equal(db.prepare('SELECT COUNT(*) count FROM manual_handoff_intents WHERE source_message_id=?').get(before.id).count, 0);
        // These writes represent state committed by a newer request/operator while AI is awaiting HTTP.
        db.prepare('UPDATE conversations SET pending_intent_json=?,handoff_offered_at=?,clarification_attempts=2,updated_at=? WHERE id=?')
          .run(pending, offeredAt, updatedAt, before.conversation_id);
        if (invalidation === 'handled') {
          db.prepare("UPDATE messages SET status='MANUAL_HANDLED',decision='MANUAL_HANDLED',handled_at=?,handled_by='竞态测试人工',reply_text='人工已接手',reply_context_json=?,reason='人工结果必须保留' WHERE id=?")
            .run(updatedAt, JSON.stringify({ manual: true }), before.id);
        } else {
          db.prepare('UPDATE conversations SET version=version+1 WHERE id=?').run(before.conversation_id);
        }
      } finally {
        generation.release.resolve();
        const settled = await responsePromise;
        activeGeneration = null;
        if (settled.error) throw settled.error;
        response = settled.value;
      }
      assert.equal(response.response.status, 201, JSON.stringify(response.data));
      const message = db.prepare('SELECT * FROM messages WHERE id=?').get(before.id);
      const conversation = db.prepare('SELECT * FROM conversations WHERE id=?').get(before.conversation_id);
      assert.equal(conversation.pending_intent_json, pending, '旧邀约不能清空新业务确认');
      assert.equal(conversation.handoff_offered_at, offeredAt);
      assert.equal(conversation.clarification_attempts, 2);
      assert.equal(conversation.updated_at, updatedAt, '旧邀约不能更新新会话状态');
      assert.equal(db.prepare("SELECT COUNT(*) count FROM manual_handoff_intents WHERE status='WAITING_USER_CONFIRMATION'").get().count, 0);
      assert.equal(db.prepare('SELECT COUNT(*) count FROM manual_handoff_intents WHERE source_message_id=?').get(message.id).count, 0);
      assert.equal(db.prepare("SELECT COUNT(*) count FROM agent_jobs WHERE job_type='REPLY' AND CAST(json_extract(payload,'$.messageId') AS INTEGER)=?").get(message.id).count, 0);
      assert.equal(message.reply_job_id, null);
      assert.equal(message.manual_handoff_intent_id, null);
      assert.equal(db.prepare('SELECT COUNT(*) count FROM notifications WHERE message_id=?').get(message.id).count, 0);
      const generationLog = db.prepare("SELECT status,model FROM ai_call_logs WHERE source_module='comment-handoff-offer' AND task_id=? ORDER BY id DESC LIMIT 1").get(String(message.id));
      assert.deepEqual({ ...generationLog }, { status: 'SUCCESS', model: 'comment-race-model' }, '确认AI成功返回后由freshness gate终止旧结果');
      if (invalidation === 'handled') {
        assert.equal(message.status, 'MANUAL_HANDLED');
        assert.equal(message.decision, 'MANUAL_HANDLED');
        assert.equal(message.reply_text, '人工已接手');
        assert.equal(message.reply_context_json, JSON.stringify({ manual: true }));
        assert.equal(message.reason, '人工结果必须保留');
      } else {
        assert.equal(message.status, 'SUPERSEDED');
        assert.equal(message.decision, 'SUPERSEDED_BY_NEW_MESSAGE');
        assert.equal(message.reply_text, null);
        assert.match(message.reason, /旧回复已作废/);
        assert.equal(conversation.version, before.conversation_version + 1);
      }
    });
  }
  assert.equal(ragRequests.length, 2);
  assert.equal(aiRequests.length, 2);
});
