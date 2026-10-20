import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { startServer, stopChild, cleanupDir, jsonRequest } from './helpers/runtime.js';

test('小智与五个平台共用外层路由、引导计数和人工接管状态', async t => {
  const requests = [];
  let queryFailure = null, createFailure = false, delayedQuery = null;
  const rag = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const input = JSON.parse(Buffer.concat(chunks).toString() || '{}');
    const send = (data, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
    const create = req.url === '/rag-admin-api/v1/test-sessions';
    requests.push({ create, input });
    if (create) return createFailure ? send({ error: { code: 'RAG_NOT_READY', message: 'not ready' } }, 503) : send({ testSessionId: crypto.randomUUID() });
    if (queryFailure === 'timeout') return send({ error: { code: 'RAG_EXECUTION_TIMEOUT', message: 'request timed out; internal call log' } }, 503);
    const question = input.query?.text || input.question;
    if (question === '社区入驻费用（延迟测试）' && delayedQuery) {
      const waiting = delayedQuery;
      waiting.started.resolve();
      await waiting.release.promise;
      return send({ result: waiting.status, snapshot: input.snapshot, reasonCode: 'INSUFFICIENT_EVIDENCE', grounding: { confidence: 0, sourceReferences: [] } });
    }
    const answered = question.includes('社区入驻需要什么材料') || question.includes('OPC社区七免两低扶持港澳创业');
    send({ result: answered ? 'ANSWERED' : 'NO_ANSWER', snapshot: input.snapshot, answerId: crypto.randomUUID(),
      reasonCode: answered ? null : 'INSUFFICIENT_EVIDENCE', answer: answered ? { text: queryFailure === 'empty' ? '' : '请准备项目计划书。' } : null,
      grounding: { confidence: answered ? 0.9 : 0.3, sourceReferences: answered ? [{ documentId: 'community-policy', documentVersion: 1, chunkId: 'materials', title: '社区入驻材料', verificationStatus: 'VERIFIED' }] : [] },
      meta: { knowledgeVersion: 'parity-fixture' } });
  });
  await new Promise(resolve => rag.listen(0, '127.0.0.1', resolve));
  const runtime = await startServer({ env: { RAG_BASE_URL: `http://127.0.0.1:${rag.address().port}`, RAG_ADMIN_ENABLED: 'true', RAG_FORMAL_ROUTING_ENABLED: 'true', WECOM_WEBHOOK_URL: '' } });
  const db = new DatabaseSync(runtime.dbPath); db.exec('PRAGMA busy_timeout=5000');
  t.after(async () => { db.close(); await stopChild(runtime.child); cleanupDir(runtime.dir); await new Promise(resolve => rag.close(resolve)); });
  const platforms = ['douyin', 'weibo', 'wechat_channels', 'bilibili', 'xiaohongshu'];
  db.prepare("UPDATE accounts SET enabled=1 WHERE platform_code IN ('douyin','weibo','wechat_channels','bilibili','xiaohongshu')").run();
  const accounts = (await jsonRequest(runtime.base, '/api/accounts')).data.accounts;
  const chat = async () => {
    const result = await jsonRequest(runtime.base, '/api/xiaozhi/sessions', { method: 'POST', body: { scope: 'published', contextEnabled: true } });
    return async content => {
      const response = await jsonRequest(runtime.base, '/api/xiaozhi/chat', { method: 'POST', body: { sessionId: result.data.session.id, content } });
      assert.equal(response.response.status, 200, JSON.stringify(response.data));
      return response.data;
    };
  };
  const simulate = async (platformCode, conversationId, content, messageType = 'PRIVATE_MESSAGE', source = {}) => {
    const externalId = crypto.randomUUID();
    const result = await jsonRequest(runtime.base, '/api/messages/simulate', { method: 'POST', body: {
      platformCode, accountId: accounts.find(a => a.platform_code === platformCode).id, messageType, content, externalId, userName: '路由合并测试',
      context: { conversationId, messageId: externalId, direction: 'incoming', sourceVerified: true, chatTitleVerified: true, previewOnly: false, unreadCount: 1,
        ...(messageType === 'COMMENT' ? { noteId: conversationId, commentId: externalId } : {}), ...source }
    } });
    assert.equal(result.response.status, 201, JSON.stringify(result.data));
    const message = result.data.message;
    if (message.reply_job_id) {
      db.prepare("UPDATE agent_jobs SET status='SUCCESS' WHERE id=?").run(message.reply_job_id);
      db.prepare("UPDATE messages SET status='AUTO_REPLIED',handled_at=?,handled_by='AI' WHERE id=?").run(new Date().toISOString(), message.id);
    }
    return message;
  };
  const attempts = message => db.prepare('SELECT clarification_attempts FROM conversations WHERE id=?').get(message.conversation_id).clarification_attempts;

  for (const greeting of ['你好', '谢谢', '你好？', '在吗？', '早上好', '您好～', '哈喽，你好呀', '谢谢您']) await t.test(`${greeting}直接回复且不访问RAG`, async () => {
    const before = requests.length;
    const result = await (await chat())(greeting);
    assert.equal(result.decision, 'SIMPLE_GREETING');
    assert.equal(result.guidanceAttempt, 0);
    for (const platform of platforms) {
      const message = await simulate(platform, crypto.randomUUID(), greeting);
      assert.equal(message.reply_text, result.replyText);
      assert.equal(message.status, 'REPLY_QUEUED');
    }
    assert.equal(requests.length, before, '问候不创建远端会话或查询知识');
  });

  for (const content of ['转人工', '垃圾客服']) await t.test(`${content}立即接管且后续不自动回复`, async () => {
    const before = requests.length, ask = await chat();
    const result = await ask(content);
    assert.equal(result.action, 'HANDOFF');
    assert.equal(result.handoffRequested, true);
    assert.equal((await ask('社区入驻需要什么材料？')).action, 'HANDOFF');
    for (const platform of platforms) {
      const id = crypto.randomUUID();
      assert.equal((await simulate(platform, id, content)).status, 'MANUAL_REQUIRED');
      const next = await simulate(platform, id, '社区入驻需要什么材料？');
      assert.equal(next.status, 'MANUAL_REQUIRED');
      assert.equal(next.reply_job_id, null);
    }
    assert.equal(requests.length, before);
  });

  await t.test('插入问候不占引导次数，有答案后重新计数', async () => {
    const ask = await chat();
    const questionSequence = ['怎么申请', '你好', '怎么申请', '社区入驻需要什么材料？', '多少钱'];
    const expected = [1, 0, 2, 0, 1];
    const results = [];
    for (let i = 0; i < questionSequence.length; i++) {
      const result = await ask(questionSequence[i]); results.push(result);
      assert.equal(result.action, 'REPLY', questionSequence[i]);
      assert.equal(result.guidanceAttempt, expected[i]);
    }
    for (const platform of platforms) {
      const id = crypto.randomUUID();
      for (let i = 0; i < questionSequence.length; i++) {
        const message = await simulate(platform, id, questionSequence[i]);
        assert.equal(message.status, 'REPLY_QUEUED');
        assert.equal(message.reply_text, results[i].replyText);
        assert.equal(attempts(message), i === 1 ? 1 : expected[i]);
      }
    }
  });

  await t.test('问候之后的第三次无答案业务引导仍转人工', async () => {
    const ask = await chat();
    for (const content of ['怎么申请', '怎么申请', '你好？']) assert.equal((await ask(content)).action, 'REPLY');
    const result = await ask('怎么申请');
    assert.equal(result.action, 'HANDOFF'); assert.equal(result.guidanceAttempt, 3);
    for (const platform of platforms) {
      const id = crypto.randomUUID();
      for (const content of ['怎么申请', '怎么申请', '你好？']) await simulate(platform, id, content);
      const last = await simulate(platform, id, '怎么申请');
      assert.equal(last.status, 'MANUAL_REQUIRED'); assert.equal(last.reply_job_id, null); assert.equal(attempts(last), 3);
    }
  });

  for (const status of ['NEED_CLARIFICATION', 'REJECTED', 'UNAVAILABLE']) await t.test(`过期的 ${status} 不能接管已有新问题的会话`, async () => {
    const id = crypto.randomUUID();
    await simulate('douyin', id, '怎么申请');
    const second = await simulate('douyin', id, '怎么申请');
    const version = db.prepare('SELECT version FROM conversations WHERE id=?').get(second.conversation_id).version;
    delayedQuery = { status, started: Promise.withResolvers(), release: Promise.withResolvers() };
    const oldRequest = simulate('douyin', id, '社区入驻费用（延迟测试）');
    let newRequest;
    try {
      await delayedQuery.started.promise;
      newRequest = simulate('douyin', id, '社区入驻需要什么材料？');
      const deadline = Date.now() + 3000;
      while (db.prepare('SELECT version FROM conversations WHERE id=?').get(second.conversation_id).version < version + 2 && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert.equal(db.prepare('SELECT version FROM conversations WHERE id=?').get(second.conversation_id).version, version + 2);
    } finally {
      delayedQuery.release.resolve();
    }
    const [oldMessage, newMessage] = await Promise.all([oldRequest, newRequest]);
    delayedQuery = null;
    assert.equal(oldMessage.status, 'NEW');
    assert.match(oldMessage.reason, /旧结果已丢弃/);
    assert.equal(newMessage.decision, 'RAG_ANSWERED');
    assert.equal(newMessage.status, 'REPLY_QUEUED');
    assert.equal(attempts(newMessage), 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM notifications WHERE message_id=? AND json_extract(metadata_json,'$.handoff')=1").get(oldMessage.id).count, 0);
  });

  await t.test('RAG离线时仍能确认费用材料地址报名对象', async () => {
    createFailure = true;
    try {
      const before = requests.length;
      for (const content of ['怎么申请', '多少钱', '要什么材料', '地址在哪里', '如何报名', '在哪里申请']) {
        const result = await (await chat())(content);
        assert.equal(result.action, 'REPLY'); assert.equal(result.matchMethod, 'OUTER_ROUTER');
        for (const platform of platforms) assert.equal((await simulate(platform, crypto.randomUUID(), content)).reply_text, result.replyText);
      }
      assert.equal(requests.length, before);
    } finally { createFailure = false; }
  });

  for (const failure of ['timeout', 'empty']) await t.test(`${failure}统一处理且服务恢复后继续人工接管`, async () => {
    queryFailure = failure;
    try {
      const ask = await chat(), result = await ask('社区入驻需要什么材料？');
      assert.equal(result.action, 'HANDOFF'); assert.equal(result.handoffRequested, true);
      if (failure === 'timeout') assert.equal(result.replyText, 'AI回复超时');
      else assert.doesNotMatch(result.replyText, /ANSWERED|UNAVAILABLE/);
      const ids = new Map();
      for (const platform of platforms) {
        const id = crypto.randomUUID(); ids.set(platform, id);
        const message = await simulate(platform, id, '社区入驻需要什么材料？');
        assert.equal(message.status, 'MANUAL_REQUIRED'); assert.equal(message.reply_job_id, null);
        assert.equal(message.reason, result.replyText);
        if (failure === 'timeout') assert.equal(message.reason, 'AI回复超时');
      }
      queryFailure = null;
      const before = requests.length;
      assert.equal((await ask('社区入驻需要什么材料？')).action, 'HANDOFF');
      for (const platform of platforms) assert.equal((await simulate(platform, ids.get(platform), '社区入驻需要什么材料？')).status, 'MANUAL_REQUIRED');
      assert.equal(requests.length, before);
    } finally { queryFailure = null; }
  });

  await t.test('评论根据已核实的关联作品检索后回复', async () => {
    const stamp = new Date().toISOString(), postId = 'BV1PARITY1234';
    const taskId = db.prepare("INSERT INTO publish_tasks(title,body,material_path,status,created_at,updated_at) VALUES('OPC社区','入驻材料','fixture.mp4','PUBLISHED',?,?)").run(stamp, stamp).lastInsertRowid;
    db.prepare("INSERT INTO publish_targets(task_id,platform_code,account_id,status,submission_status,review_status,platform_post_id,updated_at) VALUES(?,'bilibili',?,'PUBLISHED','SUBMITTED','PUBLISHED',?,?)").run(taskId, accounts.find(a => a.platform_code === 'bilibili').id, postId, stamp);
    for (const platform of platforms) {
      const message = await simulate(platform, crypto.randomUUID(), '怎么申请入驻？', 'COMMENT', { postId, sourceVideoTitle: 'OPC社区七免两低扶持港澳创业' });
      assert.equal(message.status, 'REPLY_QUEUED', `${platform}: ${message.reason}`);
      assert.equal(message.reply_text, '请准备项目计划书。');
    }
  });

  await t.test('RAG创建会话失败也保存人工接管状态', async () => {
    createFailure = true;
    try {
      const ask = await chat();
      const first = await ask('社区入驻需要什么材料？');
      assert.equal(first.action, 'HANDOFF'); assert.equal(first.handoffRequested, true);
      createFailure = false;
      const before = requests.length;
      assert.equal((await ask('社区入驻需要什么材料？')).action, 'HANDOFF');
      assert.equal(requests.length, before);
    } finally { createFailure = false; }
  });

  await t.test('小智与用户端共用运营维护的转人工说法', async () => {
    const created = await jsonRequest(runtime.base, '/api/manual-handoff-phrases', { method: 'POST', body: { phrase: '给我安排专员', createdBy: '路由测试' } });
    assert.equal(created.response.status, 201);
    const before = requests.length;
    assert.equal((await (await chat())('给我安排专员')).action, 'HANDOFF');
    for (const platform of platforms) assert.equal((await simulate(platform, crypto.randomUUID(), '给我安排专员')).status, 'MANUAL_REQUIRED');
    assert.equal(requests.length, before);
  });
});
