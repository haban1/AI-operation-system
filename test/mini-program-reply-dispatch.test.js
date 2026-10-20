import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { assessAutoReplyEligibility } from '../src/services/auto-reply-eligibility.js';
import { buildManualNotification } from '../src/services/manual-notification.js';

const signedContext = { appId: 'app-1', conversationId: 'c-1', messageId: 'm-1', userId: 'user-001', direction: 'incoming', serverSignatureVerified: true };
const eligibilityInput = { platformCode: 'mini_program', accountId: 6, messageType: 'PRIVATE_MESSAGE', sourceContent: '办理业务需要什么材料？', userName: 'user-001', messageContext: signedContext };

test('signed server messages are eligible without DOM or RPA evidence', () => {
  const result = assessAutoReplyEligibility(eligibilityInput);
  assert.equal(result.allowed, true);
  assert.deepEqual(result.target, { kind: 'SERVER_CALLBACK', platformCode: 'mini_program', accountId: '6', appId: 'app-1', conversationId: 'c-1', messageId: 'm-1', userId: 'user-001' });
});

test('server eligibility requires verified signature, all four identifiers and incoming direction', async t => {
  for (const [field, value, reason] of [
    ['serverSignatureVerified', false, 'SERVER_SIGNATURE_NOT_VERIFIED'],
    ['appId', '', 'SERVER_MESSAGE_IDENTITY_REQUIRED'],
    ['conversationId', '', 'SERVER_MESSAGE_IDENTITY_REQUIRED'],
    ['messageId', '', 'SERVER_MESSAGE_IDENTITY_REQUIRED'],
    ['userId', '', 'SERVER_MESSAGE_IDENTITY_REQUIRED'],
    ['direction', 'outgoing', 'INCOMING_DIRECTION_REQUIRED']
  ]) await t.test(field, () => {
    const result = assessAutoReplyEligibility({ ...eligibilityInput, messageContext: { ...signedContext, [field]: value } });
    assert.equal(result.allowed, false);
    assert.equal(result.reason, reason);
  });
});

function scenario(script, setup = '', environment = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mini-dispatch-'));
  try {
    const childEnvironment = {
      ...process.env,
      DATABASE_PATH: path.join(dir, 'test.db'),
      PORT: '0',
      AUTH_ENABLED: 'false',
      AGENT_SHARED_TOKEN: '',
      INSTANCE_LOCK_ENABLED: 'false',
      LOCAL_AGENT_AUTO_START: 'false',
      AUTO_COLLECT_ENABLED: 'false',
      QWEN_MODE: 'mock',
      RPA_MODE: 'simulated',
      WECOM_WEBHOOK_URL: '',
      MINI_PROGRAM_APP_ID: 'app-1',
      MINI_PROGRAM_SHARED_SECRET: 'test-secret',
      MINI_PROGRAM_CALLBACK_URL: '',
      RAG_BASE_URL: '',
      RAG_FORMAL_ROUTING_ENABLED: 'true'
    };
    for (const [name, value] of Object.entries(environment)) {
      if (value === null) delete childEnvironment[name];
      else childEnvironment[name] = value;
    }
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import http from 'node:http';
      const { db, row, rows, run, now } = await import('./src/db.js');
      const { ingestMiniProgramMessage, miniProgramAccount } = await import('./src/services/mini-program-channel.js');
      const { savePlatformSmartReply, saveMasterSwitch } = await import('./src/services/settings.js');
      const { ensureMessageConversation } = await import('./src/services/conversation-store.js');
      const { config } = await import('./src/config.js');
      ${setup}
      const server = await import('./src/server.js');
      saveMasterSwitch(true);
      let sequence = 0;
      function seed(text = '你好', overrides = {}) {
        sequence += 1;
        const payload = { appId: 'app-1', conversationId: 'c-' + sequence, messageId: 'm-' + sequence, userId: 'user-001', text, sentAt: now(), ...overrides };
        ingestMiniProgramMessage(payload);
        return row('SELECT * FROM messages WHERE external_id=?', 'mini-program:app-1:message:' + payload.messageId);
      }
      try {
        ${script};
        await new Promise(setImmediate);
        // Drain remaining HTTP handles after shutdown instead of forcing libuv to exit.
        process.exit = code => { process.exitCode = code; };
        process.emit('SIGTERM');
      } catch (error) { console.error(error); process.exit(1); }
    `], {
      cwd: path.resolve(import.meta.dirname, '..'), encoding: 'utf8', timeout: 20_000,
      env: childEnvironment
    });
    assert.equal(child.status, 0, [child.stderr, child.error?.message, child.stdout].filter(Boolean).join('\n'));
  } finally { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
}

test('reply queueing creates exactly one callback and never an Agent job or reply batch', () => scenario(`
  const message = seed();
  const options = { decision: 'TEST_STATIC', reason: 'test reply', confidence: 0.9, responseMode: 'ROUTER_STATIC', replyBatch: { id: 999999 } };
  const id = await server.queueStaticReply(message, '请携带有效身份证件。', options);
  const callbacks = rows('SELECT * FROM mini_program_callback_outbox');
  assert.equal(callbacks.length, 1);
  assert.equal(id, callbacks[0].id);
  const payload = JSON.parse(callbacks[0].payload_json);
  assert.equal(payload.appId, 'app-1');
  assert.equal(payload.conversationId, 'c-1');
  assert.equal(payload.userId, 'user-001');
  assert.equal(payload.inReplyToMessageId, 'm-1');
  assert.equal(payload.text, '请携带有效身份证件。');
  const saved = row('SELECT * FROM messages WHERE id=?', message.id);
  assert.equal(saved.status, 'REPLY_QUEUED');
  assert.equal(saved.reply_job_id, null);
  assert.equal(saved.decision, 'TEST_STATIC');
  assert.equal(saved.confidence, 0.9);
  assert.equal(saved.response_mode, 'ROUTER_STATIC');
  assert.equal(await server.queueStaticReply(message, '重复回复', options), null);
  assert.equal(row('SELECT COUNT(*) AS n FROM mini_program_callback_outbox').n, 1);
  assert.equal(row('SELECT COUNT(*) AS n FROM reply_batches').n, 0);
  assert.equal(row("SELECT COUNT(*) AS n FROM agent_jobs WHERE job_type='REPLY'").n, 0);
`));

test('mini reply queue retains signature and source-current gates', () => scenario(`
  const unsigned = seed();
  run("UPDATE messages SET context_json=json_set(context_json,'$.serverSignatureVerified',0) WHERE id=?", unsigned.id);
  await server.queueStaticReply(unsigned, '不应发送', { decision: 'TEST', reason: 'test' });
  assert.equal(row('SELECT decision FROM messages WHERE id=?', unsigned.id).decision, 'AUTO_REPLY_INELIGIBLE');
  assert.equal(row('SELECT reason FROM messages WHERE id=?', unsigned.id).reason, 'SERVER_SIGNATURE_NOT_VERIFIED');
  const old = seed('旧问题', { conversationId: 'stale' });
  seed('新问题', { conversationId: 'stale' });
  assert.equal(await server.queueStaticReply(old, '旧回复', { decision: 'TEST', reason: 'test' }), null);
  assert.equal(row('SELECT status FROM messages WHERE id=?', old.id).status, 'SUPERSEDED');
  assert.equal(row('SELECT COUNT(*) AS n FROM mini_program_callback_outbox').n, 0);
  assert.equal(row("SELECT COUNT(*) AS n FROM agent_jobs WHERE job_type='REPLY'").n, 0);
`));

test('mini callback and message state roll back together when the message update fails', () => scenario(`
  const message = seed();
  db.exec("CREATE TEMP TRIGGER fail_mini_reply_update BEFORE UPDATE OF reply_text ON messages WHEN NEW.platform_code='mini_program' AND NEW.status='REPLY_QUEUED' BEGIN SELECT RAISE(ABORT, 'TEST_MESSAGE_UPDATE_FAILED'); END");
  await assert.rejects(server.queueStaticReply(message, 'first answer', { decision: 'FIRST', reason: 'first attempt' }), /TEST_MESSAGE_UPDATE_FAILED/);
  const failedMessage = row('SELECT * FROM messages WHERE id=?', message.id);
  const failedCallbacks = rows('SELECT * FROM mini_program_callback_outbox WHERE message_id=?', message.id);
  db.exec('DROP TRIGGER fail_mini_reply_update');
  const id = await server.queueStaticReply(message, 'second answer', { decision: 'SECOND', reason: 'retry' });
  const callbacks = rows('SELECT * FROM mini_program_callback_outbox WHERE message_id=?', message.id);
  const saved = row('SELECT * FROM messages WHERE id=?', message.id);
  assert.deepEqual(failedMessage, message);
  assert.equal(failedCallbacks.length, 0, 'failed message update must not leave a deliverable callback');
  assert.equal(callbacks.length, 1);
  assert.equal(callbacks[0].id, id);
  assert.equal(JSON.parse(callbacks[0].payload_json).text, 'second answer');
  assert.equal(saved.reply_text, 'second answer');
  assert.equal(saved.decision, 'SECOND');
  assert.equal(saved.status, 'REPLY_QUEUED');
  assert.equal(saved.reply_job_id, null);
  assert.equal(row("SELECT COUNT(*) AS n FROM agent_jobs WHERE job_type='REPLY'").n, 0);
`));

test('mini dispatch preserves an outer transaction and rolls both writes back with it', () => scenario(`
  const message = seed();
  db.exec('BEGIN IMMEDIATE');
  const id = await server.queueStaticReply(message, 'outer transaction answer', { decision: 'OUTER', reason: 'outer transaction' });
  assert.equal(db.isTransaction, true);
  assert.equal(row('SELECT reply_text FROM messages WHERE id=?', message.id).reply_text, 'outer transaction answer');
  assert.equal(JSON.parse(row('SELECT payload_json FROM mini_program_callback_outbox WHERE id=?', id).payload_json).text, 'outer transaction answer');
  db.exec('ROLLBACK');
  assert.deepEqual(row('SELECT * FROM messages WHERE id=?', message.id), message);
  assert.equal(row('SELECT COUNT(*) AS n FROM mini_program_callback_outbox').n, 0);
`));

test('mini processor bypasses five-platform switch while retaining greeting and risk routes', () => scenario(`
  for (const code of config.activePlatformCodes) savePlatformSmartReply(code, false);
  const greeting = await server.processMessage(seed().id);
  assert.equal(greeting.status, 'REPLY_QUEUED');
  assert.equal(greeting.response_mode, 'ROUTER_STATIC');
  assert.equal(greeting.reply_job_id, null);
  const risk = await server.processMessage(seed('你们都是垃圾客服，等着被报复').id);
  assert.equal(risk.status, 'MANUAL_REQUIRED');
  assert.equal(row('SELECT handling_mode FROM conversations WHERE id=?', risk.conversation_id).handling_mode, 'HANDOFF_PENDING');
  assert.equal(row('SELECT COUNT(*) AS n FROM mini_program_callback_outbox WHERE message_id=?', risk.id).n, 0);
  const handoff = await server.processMessage(seed('转人工').id);
  assert.equal(row('SELECT handling_mode FROM conversations WHERE id=?', handoff.conversation_id).handling_mode, 'HANDOFF_PENDING');
  assert.equal(row("SELECT COUNT(*) AS n FROM agent_jobs WHERE job_type='REPLY'").n, 0);
`));

test('mini business queries enter handoff instead of legacy replies when formal RAG is unconfigured by default', () => scenario(`
  assert.equal(config.ragFormalRoutingEnabled, false);
  const message = await server.processMessage(seed('办理业务需要什么材料？').id);
  const conversation = row('SELECT * FROM conversations WHERE id=?', message.conversation_id);
  const notification = row('SELECT * FROM notifications WHERE conversation_id=?', message.conversation_id);
  assert.equal(message.status, 'MANUAL_REQUIRED');
  assert.equal(message.reply_text, null);
  assert.equal(conversation.handling_mode, 'HANDOFF_PENDING');
  assert.equal(notification.type, 'RAG_UNAVAILABLE_MANUAL');
  assert.equal(row('SELECT COUNT(*) AS n FROM mini_program_callback_outbox WHERE message_id=?', message.id).n, 0);
  assert.equal(row("SELECT COUNT(*) AS n FROM agent_jobs WHERE job_type='REPLY'").n, 0);
`, '', { RAG_FORMAL_ROUTING_ENABLED: null }));

test('mini processor keeps formal RAG answer, clarification and failure handoff behavior', () => scenario(`
  assert.equal(config.ragFormalRoutingEnabled, false);
  const answered = await server.processMessage(seed('办理业务需要什么材料？').id);
  assert.equal(answered.decision, 'RAG_ANSWERED');
  assert.equal(answered.reply_text, '请携带身份证件。');
  assert.equal(answered.reply_job_id, null);
  assert.equal(requests[0].source.platform, 'DOUYIN');
  assert.equal(requests[0].source.channelType, 'DIRECT_MESSAGE');
  const guided = [];
  for (let n = 0; n < 3; n += 1) guided.push(await server.processMessage(seed('无答案问题' + n, { conversationId: 'clarify' }).id));
  assert.deepEqual(guided.slice(0, 2).map(message => message.decision), ['RAG_NEED_CLARIFICATION', 'RAG_NEED_CLARIFICATION']);
  const limit = guided[2];
  assert.equal(limit.status, 'MANUAL_REQUIRED');
  assert.equal(row('SELECT handling_mode FROM conversations WHERE id=?', limit.conversation_id).handling_mode, 'HANDOFF_PENDING');
  assert.equal(row('SELECT COUNT(*) AS n FROM notifications WHERE message_id=?', limit.id).n, 1);
  assert.equal(row('SELECT COUNT(*) AS n FROM mini_program_callback_outbox WHERE message_id=?', limit.id).n, 0);
  assert.equal(JSON.parse(limit.reply_context_json).guidanceAttempt, 3);
  const failed = await server.processMessage(seed('服务异常怎么办').id);
  assert.equal(failed.status, 'MANUAL_REQUIRED');
  assert.equal(row('SELECT handling_mode FROM conversations WHERE id=?', failed.conversation_id).handling_mode, 'HANDOFF_PENDING');
  assert.equal(row('SELECT COUNT(*) AS n FROM mini_program_callback_outbox WHERE message_id=?', failed.id).n, 0);
  assert.equal(row("SELECT COUNT(*) AS n FROM agent_jobs WHERE job_type='REPLY'").n, 0);
  rag.closeAllConnections();
  await new Promise(resolve => rag.close(resolve));
`, `
  const requests = [];
  const rag = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const payload = JSON.parse(raw); requests.push(payload);
    res.setHeader('Content-Type', 'application/json');
    if (payload.query.text.includes('异常')) { res.writeHead(503); res.end(JSON.stringify({ error: { code: 'RAG_DOWN' } })); return; }
    const answer = !payload.query.text.includes('无答案');
    res.end(JSON.stringify({ requestId: payload.requestId, result: answer ? 'ANSWERED' : 'NO_ANSWER', snapshot: payload.snapshot,
      answer: answer ? { text: '请携带身份证件。' } : undefined, grounding: { confidence: answer ? 0.96 : 0, sourceReferences: answer ? [{ documentId: 'doc-1', chunkId: 'chunk-1' }] : [] } }));
  });
  await new Promise(resolve => rag.listen(0, '127.0.0.1', resolve));
  config.ragBaseUrl = 'http://127.0.0.1:' + rag.address().port;
`, { RAG_FORMAL_ROUTING_ENABLED: 'false' }));

test('manual notifications preserve caller metadata and force verified mini identity and conversation idempotency', () => scenario(`
  const message = seed('转人工');
  const first = await server.notifyManual(message, 'RISK_MANUAL', '', '测试原因', {
    idempotencyKey: 'caller-key', metadata: { origin: 'test-caller', trace: { requestId: 'custom-trace' }, appId: 'wrong', userId: 'wrong', accountId: -1, conversationId: 'wrong', miniProgram: { appId: 'forged-app', userId: 'forged-user', accountId: -2, conversationId: 'forged-conversation', forgedExtra: true } }
  });
  const saved = row('SELECT * FROM notifications WHERE id=?', first.notificationId);
  assert.deepEqual(JSON.parse(saved.metadata_json), { origin: 'test-caller', trace: { requestId: 'custom-trace' }, handoff: true, reason: '测试原因', platformCode: 'mini_program', userName: 'user-001', appId: 'app-1', userId: 'user-001', accountId: miniProgramAccount().id, conversationId: 'c-1', miniProgram: { appId: 'app-1', userId: 'user-001', accountId: miniProgramAccount().id, conversationId: 'c-1' } });
  assert.equal(saved.idempotency_key, 'wecom:mini-program:handoff:conversation:' + message.conversation_id);
  assert.ok(saved.content.includes('用户 ID：user-001'));
  assert.ok(saved.content.includes('会话 ID：c-1'));
  assert.ok(saved.content.endsWith('请根据企业微信通知中的用户 ID 和会话 ID，在小程序客服系统中继续对接。'));
  const secondMessage = seed('补充消息', { conversationId: 'c-1' });
  const second = await server.notifyManual(secondMessage, 'HUMAN_FOLLOWUP_MESSAGE', '', '后续原因', { idempotencyKey: 'different-key' });
  assert.equal(second.notificationId, first.notificationId);
  assert.equal(row('SELECT COUNT(*) AS n FROM notifications').n, 1);
`));

test('shared manual notification replay preserves the channel-created mini identity contract', () => scenario(`
  const { requestMiniProgramHandoff } = await import('./src/services/mini-program-channel.js');
  const message = seed('转人工');
  const original = requestMiniProgramHandoff({ conversationId: message.conversation_id, messageId: message.id, reason: 'channel handoff' }).notification;
  const result = await server.notifyManual(message, 'HUMAN_FOLLOWUP_MESSAGE', '', 'later reason', { idempotencyKey: 'caller-key', metadata: { miniProgram: { userId: 'forged-user' } } });
  const notification = row('SELECT * FROM notifications WHERE id=?', result.notificationId);
  assert.equal(result.notificationId, original.id);
  assert.equal(notification.idempotency_key, 'wecom:mini-program:handoff:conversation:' + message.conversation_id);
  assert.equal(notification.metadata_json, original.metadata_json);
  assert.equal(notification.content, original.content);
  assert.deepEqual(JSON.parse(notification.metadata_json).miniProgram, { appId: 'app-1', userId: 'user-001', accountId: miniProgramAccount().id, conversationId: 'c-1' });
  assert.equal(row('SELECT COUNT(*) AS n FROM notifications').n, 1);
`));

test('five-platform private reply dispatch and smart-reply switches remain unchanged', () => scenario(`
  for (const code of config.activePlatformCodes) {
    const account = row('SELECT * FROM accounts WHERE platform_code=?', code);
    const id = Number(run("INSERT INTO messages(platform_code,account_id,external_id,message_type,user_name,content,status,context_json,created_at,updated_at) VALUES(?,?,?,'PRIVATE_MESSAGE','legacy-user','你好','NEW',?,?,?)", code, account.id, 'legacy-' + code, JSON.stringify({ conversationId: 'legacy-' + code, messageId: 'legacy-' + code, direction: 'incoming', sourceVerified: true, chatTitleVerified: true, fullSource: true, previewOnly: false, candidateCount: 1 }), now(), now()).lastInsertRowid);
    const message = ensureMessageConversation(row('SELECT * FROM messages WHERE id=?', id)).message;
    savePlatformSmartReply(code, false);
    assert.equal((await server.processMessage(id)).decision, 'SMART_REPLY_PAUSED');
    savePlatformSmartReply(code, true);
    await assert.rejects(server.queueStaticReply(message, '长'.repeat(10000), { decision: 'TEST', reason: 'legacy length' }), /字符/);
    const jobId = await server.queueStaticReply(message, '你好，请问有什么可以帮您？', { decision: 'TEST', reason: 'legacy' });
    assert.ok(jobId);
    assert.equal(row('SELECT reply_job_id FROM messages WHERE id=?', id).reply_job_id, jobId);
    assert.equal(row('SELECT job_type FROM agent_jobs WHERE id=?', jobId).job_type, 'REPLY');
    assert.equal(JSON.parse(row('SELECT payload FROM agent_jobs WHERE id=?', jobId).payload).platformCode, code);
  }
  assert.equal(row('SELECT COUNT(*) AS n FROM mini_program_callback_outbox').n, 0);
  assert.equal(row("SELECT COUNT(*) AS n FROM agent_jobs WHERE job_type='REPLY'").n, 5);
`));

test('mini notification fallback directs operators to the mini customer-service system', () => {
  const result = buildManualNotification({ message: { id: 1, platform_code: 'mini_program', message_type: 'PRIVATE_MESSAGE', user_name: 'user-001', content: '转人工', context_json: JSON.stringify(signedContext) }, reason: '用户请求' });
  assert.match(result.title, /小程序/);
  assert.equal(result.content.split('\n').at(-1), '请根据企业微信通知中的用户 ID 和会话 ID，在小程序客服系统中继续对接。');
});
