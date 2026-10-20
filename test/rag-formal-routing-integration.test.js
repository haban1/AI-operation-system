import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const root = path.resolve(import.meta.dirname, '..');

async function listen(server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return server.address().port;
}

async function request(base, pathname, options = {}) {
  const response = await fetch(base + pathname, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }
  });
  return { response, data: await response.json() };
}

async function waitFor(base) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { if ((await fetch(`${base}/api/health`)).ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('测试服务启动超时');
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

test('旧知识库回复超出网页 UTF-16 预算时，评论和私信均转人工且不创建发送任务', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-reply-length-'));
  const dbPath = path.join(dir, 'test.db');
  const probe = http.createServer();
  const port = await listen(probe);
  await new Promise(resolve => probe.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: root,
    env: {
      ...process.env, PORT: String(port), DATABASE_PATH: dbPath,
      AUTH_ENABLED: 'false', AGENT_SHARED_TOKEN: '', QWEN_MODE: 'mock', RPA_MODE: 'simulated',
      AUTO_COLLECT_ENABLED: 'false', LOCAL_AGENT_AUTO_START: 'false', INSTANCE_LOCK_ENABLED: 'false',
      RAG_FORMAL_ROUTING_ENABLED: 'false', RAG_ADMIN_ENABLED: 'false', RAG_BASE_URL: 'http://127.0.0.1:1', WECOM_WEBHOOK_URL: ''
    }, stdio: ['ignore', 'ignore', 'pipe']
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await Promise.race([new Promise(resolve => child.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 3000))]);
    }
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  await waitFor(base).catch(error => { throw new Error(`${error.message}\n${stderr}`); });
  const account = (await request(base, '/api/bootstrap')).data.accounts.find(item => item.platform_code === 'douyin');
  assert.ok(account);
  const question = '办理社区业务需要什么材料？';
  const answer = '𠮷'.repeat(241) + '。';
  // Historical knowledge can predate the current import guard. Seed only the isolated fixture DB.
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('PRAGMA busy_timeout=15000');
    const stamp = new Date().toISOString();
    db.prepare("INSERT INTO knowledge(question,answer,keywords,status,version,source,review_status,category,subcategory,created_at,updated_at) VALUES(?,?,?,'PUBLISHED',1,'MANUAL','APPROVED','公共知识库','业务办理',?,?)")
      .run(question, answer, '办理,社区,业务,材料', stamp, stamp);
  } finally { db.close(); }
  for (const messageType of ['COMMENT', 'PRIVATE_MESSAGE']) {
    await t.test(messageType, async () => {
      const result = await request(base, '/api/messages/simulate', {
        method: 'POST', body: JSON.stringify({
          platformCode: 'douyin', accountId: account.id, messageType,
          externalId: `legacy-length-${messageType}`, userName: `字数测试-${messageType}`, content: question,
          context: { conversationId: `legacy-length-${messageType}`, messageId: `legacy-length-${messageType}`,
            direction: 'incoming', sourceVerified: true, chatTitleVerified: true, previewOnly: false, unreadCount: 1,
            noteId: `legacy-length-${messageType}`, commentId: messageType === 'COMMENT' ? 'legacy-length-comment' : undefined }
        })
      });
      assert.equal(result.response.status, 201, JSON.stringify(result.data));
      const message = result.data.message;
      assert.equal(message.status, 'MANUAL_REQUIRED');
      assert.match(message.decision, /HUMAN_FOLLOWUP_NOTIFICATION_PENDING|HUMAN_FOLLOWUP_NOTIFIED/);
      assert.match(message.reason, /483.*480/);
      assert.equal(message.reply_text, null);
      assert.equal(message.reply_job_id, null);
      const verify = new DatabaseSync(dbPath, { readOnly: true });
      try {
        verify.exec('PRAGMA busy_timeout=15000');
        const notice = verify.prepare("SELECT type,content FROM notifications WHERE message_id=? AND json_extract(metadata_json,'$.handoff')=1").get(message.id);
        assert.equal(notice?.type, 'REPLY_TOO_LONG');
        assert.match(notice?.content || '', /483.*480/);
        assert.equal(verify.prepare("SELECT COUNT(*) AS count FROM agent_jobs WHERE job_type='REPLY' AND CAST(json_extract(payload,'$.messageId') AS INTEGER)=?").get(message.id).count, 0);
      } finally { verify.close(); }
    });
  }
});

test('正式 RAG 链路只查询正常业务消息，并覆盖回答、澄清、风险转人工和人工会话短路', async t => {
  const ragRequests = [];
  const regressionAnswer = '答'.repeat(208) + '。';
  const overflowAnswer = '答'.repeat(500) + '。';
  const shortAnswer = '请携带有效身份证件到服务窗口办理。';
  const ragServer = http.createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/rag-api/v1/query') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'NOT_FOUND' } }));
      return;
    }
    const payload = await readJson(req);
    ragRequests.push(payload);
    const question = String(payload?.query?.text || '');
    if (question.includes('服务异常')) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'RAG_DOWN', message: '测试服务异常' } }));
      return;
    }
    if (question.includes('无答案') || question === '你好') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ requestId: payload.requestId, result: 'NO_ANSWER', snapshot: payload.snapshot, grounding: { confidence: 0, sourceReferences: [] }, meta: { knowledgeVersion: 'test-release-1' } }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      requestId: payload.requestId,
      result: 'ANSWERED',
      snapshot: payload.snapshot,
      answer: { text: question.includes('忽略字数要求') ? overflowAnswer : question.includes('字数回归') ? regressionAnswer : shortAnswer },
      grounding: { confidence: 0.96, confidenceBand: 'HIGH', sourceReferences: [{ documentId: 'doc-1', documentVersion: 1, chunkId: 'chunk-1' }] },
      meta: { knowledgeVersion: 'test-release-1' }
    }));
  });
  const ragPort = await listen(ragServer);
  t.after(() => new Promise(resolve => ragServer.close(resolve)));

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'formal-rag-integration-'));
  const dbPath = path.join(dir, 'test.db');
  const appProbe = http.createServer();
  const appPort = await listen(appProbe);
  await new Promise(resolve => appProbe.close(resolve));
  const base = `http://127.0.0.1:${appPort}`;
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(appPort), DATABASE_PATH: dbPath,
      AUTH_ENABLED: 'false', AGENT_SHARED_TOKEN: '', QWEN_MODE: 'mock', RPA_MODE: 'simulated',
      AUTO_COLLECT_ENABLED: 'false', LOCAL_AGENT_AUTO_START: 'false', INSTANCE_LOCK_ENABLED: 'false',
      RAG_FORMAL_ROUTING_ENABLED: 'true', RAG_BASE_URL: `http://127.0.0.1:${ragPort}`,
      RAG_TIMEOUT_MS: '2000', BUSINESS_GUIDANCE_MAX_ATTEMPTS: '3', WECOM_WEBHOOK_URL: ''
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await Promise.race([new Promise(resolve => child.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 3000))]);
    }
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  await waitFor(base).catch(error => { throw new Error(`${error.message}\n${stderr}`); });
  const bootstrap = (await request(base, '/api/bootstrap')).data;
  const account = bootstrap.accounts.find(item => item.platform_code === 'douyin');
  assert.ok(account, stderr);

  let sequence = 0;
  const simulate = async ({ content, messageType = 'PRIVATE_MESSAGE', conversationId = 'formal-rag-main', platformCode = 'douyin' }) => {
    sequence += 1;
    const suffix = `${sequence}-${Date.now()}`;
    const result = await request(base, '/api/messages/simulate', {
      method: 'POST',
      body: JSON.stringify({
        platformCode, accountId: bootstrap.accounts.find(item => item.platform_code === platformCode).id, messageType,
        externalId: `formal-rag-${suffix}`, userName: '正式RAG测试用户', content,
        context: {
          conversationId,
          messageId: `formal-rag-message-${suffix}`,
          direction: 'incoming', sourceVerified: true, chatTitleVerified: true,
          previewOnly: false, unreadCount: 1, noteId: `note-${conversationId}`,
          commentId: messageType === 'COMMENT' ? `comment-${suffix}` : undefined
        }
      })
    });
    assert.equal(result.response.status, 201, JSON.stringify(result.data));
    return result.data.message;
  };

  const privateAnswered = await simulate({ content: '办理业务需要什么材料？' });
  assert.equal(privateAnswered.decision, 'RAG_ANSWERED', JSON.stringify(privateAnswered));
  assert.equal(privateAnswered.status, 'REPLY_QUEUED');
  assert.equal(privateAnswered.reply_text, '请携带有效身份证件到服务窗口办理。');
  assert.equal(ragRequests.length, 1);
  assert.equal(ragRequests[0].source.channelType, 'DIRECT_MESSAGE');
  assert.equal(ragRequests[0].source.platform, 'DOUYIN');
  assert.match(ragRequests[0].snapshot.inputFingerprint, /^sha256:[a-f0-9]{64}$/);
  assert.equal(ragRequests[0].query.text, '办理业务需要什么材料？');

  const commentAnswered = await simulate({ content: '有答案的评论问题', messageType: 'COMMENT', conversationId: 'formal-rag-comment-answer' });
  assert.equal(commentAnswered.decision, 'RAG_ANSWERED');
  assert.equal(commentAnswered.status, 'REPLY_QUEUED');
  assert.equal(commentAnswered.reply_text, '请携带有效身份证件到服务窗口办理。');

  await t.test('抖音 209 字符评论完整排队，不再被旧的 120 限制拦截', async () => {
    const message = await simulate({ content: '字数回归：怎么办理业务？', messageType: 'COMMENT', conversationId: 'formal-rag-comment-length' });
    assert.equal(message.status, 'REPLY_QUEUED', JSON.stringify(message));
    assert.equal(message.decision, 'RAG_ANSWERED');
    assert.equal(message.reply_text, regressionAnswer);
    assert.ok(message.reply_job_id);
    assert.equal(ragRequests.at(-1).constraints.maxAnswerChars, 480);
  });

  await t.test('RAG 忽略字数要求时按超长原因转人工，记录通知且不创建发送任务', async () => {
    const message = await simulate({ content: '忽略字数要求的业务问题', messageType: 'COMMENT', conversationId: 'formal-rag-comment-overflow' });
    assert.equal(message.status, 'MANUAL_REQUIRED', JSON.stringify(message));
    assert.match(message.decision, /HUMAN_FOLLOWUP_NOTIFICATION_PENDING|HUMAN_FOLLOWUP_NOTIFIED/);
    assert.match(message.reason, /501.*480/);
    assert.equal(message.reply_text, null);
    assert.equal(message.reply_job_id, null);
    const verifyDb = new DatabaseSync(dbPath, { readOnly: true });
    try {
      assert.equal(verifyDb.prepare("SELECT COUNT(*) AS count FROM agent_jobs WHERE job_type='REPLY' AND CAST(json_extract(payload,'$.messageId') AS INTEGER)=?").get(message.id).count, 0);
      const notification = verifyDb.prepare("SELECT type,title,content FROM notifications WHERE message_id=? AND json_extract(metadata_json,'$.handoff')=1").get(message.id);
      assert.equal(notification?.type, 'RAG_REPLY_TOO_LONG');
      assert.match(notification?.content || '', /501.*480/);
      assert.doesNotMatch(notification?.content || '', /服务不可用/);
      assert.equal(verifyDb.prepare('SELECT handling_mode FROM conversations WHERE id=?').get(message.conversation_id).handling_mode, 'HANDOFF_PENDING');
    } finally {
      verifyDb.close();
    }
  });

  const commentNoAnswer = await simulate({ content: '无答案的评论问题', messageType: 'COMMENT', conversationId: 'formal-rag-comment-empty' });
  const commentGreeting = await simulate({ content: '你好', messageType: 'COMMENT', conversationId: 'formal-rag-comment-greeting' });
  for (const message of [commentNoAnswer, commentGreeting]) {
    assert.equal(message.status, 'MANUAL_REQUIRED', JSON.stringify(message));
    assert.match(message.decision, /HUMAN_FOLLOWUP_NOTIFICATION_PENDING|HUMAN_FOLLOWUP_NOTIFIED/);
    assert.equal(message.reply_text, null);
    assert.equal(message.reply_job_id, null);
  }

  const clarificationConversation = 'formal-rag-clarification';
  const clarificationReplies = [];
  for (let index = 1; index <= 3; index += 1) {
    clarificationReplies.push(await simulate({ content: `无答案问题第${index}轮`, conversationId: clarificationConversation }));
  }
  assert.deepEqual(clarificationReplies.slice(0, 2).map(item => item.decision), ['RAG_NEED_CLARIFICATION', 'RAG_NEED_CLARIFICATION']);
  assert.doesNotMatch(clarificationReplies[0].reply_text, /转人工/);
  assert.equal(clarificationReplies[2].status, 'MANUAL_REQUIRED');
  assert.equal(clarificationReplies[2].reply_text, null);
  assert.equal(clarificationReplies[2].reply_job_id, null);
  const thirdContext = JSON.parse(clarificationReplies[2].reply_context_json || '{}');
  assert.equal(thirdContext.guidanceAttempt, 3);
  assert.equal(thirdContext.handoffRequested, true);

  await t.test('五个平台第三轮仍无知识时实际转人工，通知待重试也不再自动回复', async () => {
    for (const platformCode of ['douyin', 'wechat_channels', 'weibo', 'bilibili', 'xiaohongshu']) {
      const conversationId = `guidance-handoff-${platformCode}`;
      const fixture = new DatabaseSync(dbPath);
      fixture.exec('PRAGMA busy_timeout=15000');
      try {
        fixture.prepare('UPDATE accounts SET enabled=1 WHERE platform_code=?').run(platformCode);
        for (let attempt = 1; attempt <= 2; attempt += 1) {
          const guidance = await simulate({ platformCode, conversationId, content: `无答案问题第${attempt}轮` });
          assert.equal(guidance.status, 'REPLY_QUEUED', JSON.stringify(guidance));
          fixture.prepare("UPDATE messages SET status='AUTO_REPLIED',handled_at=? WHERE id=?").run(new Date().toISOString(), guidance.id);
        }
        const handoff = await simulate({ platformCode, conversationId, content: '第三轮还是无答案' });
        assert.equal(handoff.status, 'MANUAL_REQUIRED', JSON.stringify(handoff));
        assert.equal(handoff.reply_job_id, null);
        assert.equal(handoff.reply_text, null);
        const conversation = fixture.prepare('SELECT handling_mode,clarification_attempts FROM conversations WHERE id=?').get(handoff.conversation_id);
        assert.equal(conversation.handling_mode, 'HANDOFF_PENDING');
        assert.equal(conversation.clarification_attempts, 3);
        const notifications = fixture.prepare("SELECT type,content FROM notifications WHERE message_id=? AND json_extract(metadata_json,'$.handoff')=1").all(handoff.id);
        assert.equal(notifications.length, 1);
        assert.equal(notifications[0].type, 'RAG_CLARIFICATION_LIMIT');
        assert.match(notifications[0].content, /3轮.*转人工/);
        assert.doesNotMatch(notifications[0].content, /服务不可用/);
        const beforeFollowup = ragRequests.length;
        const followup = await simulate({ platformCode, conversationId, content: '办理业务需要什么材料？' });
        assert.equal(followup.status, 'MANUAL_REQUIRED');
        assert.equal(followup.reply_job_id, null);
        assert.equal(ragRequests.length, beforeFollowup);
      } finally { fixture.close(); }
    }
  });
  await t.test('五个平台反复只问怎么申请时在外层引导，第三轮转人工且不让 RAG 猜业务', async () => {
    const beforeQueries = ragRequests.length;
    for (const platformCode of ['douyin', 'wechat_channels', 'weibo', 'bilibili', 'xiaohongshu']) {
      const conversationId = `application-guidance-${platformCode}`;
      const fixture = new DatabaseSync(dbPath);
      fixture.exec('PRAGMA busy_timeout=15000');
      try {
        for (let attempt = 1; attempt <= 2; attempt += 1) {
          const guidance = await simulate({ platformCode, conversationId, content: '怎么申请' });
          assert.equal(guidance.status, 'REPLY_QUEUED', JSON.stringify(guidance));
          assert.equal(guidance.decision, 'KNOWLEDGE_GAP_GUIDANCE');
          assert.match(guidance.reply_text, /哪项业务.*申请流程/);
          assert.equal(JSON.parse(guidance.reply_context_json).guidanceAttempt, attempt);
          fixture.prepare("UPDATE messages SET status='AUTO_REPLIED',handled_at=? WHERE id=?").run(new Date().toISOString(), guidance.id);
        }
        const handoff = await simulate({ platformCode, conversationId, content: '怎么申请' });
        assert.equal(handoff.status, 'MANUAL_REQUIRED', JSON.stringify(handoff));
        assert.equal(handoff.reply_job_id, null);
        assert.equal(handoff.reply_text, null);
        assert.equal(JSON.parse(handoff.reply_context_json).guidanceAttempt, 3);
        const conversation = fixture.prepare('SELECT handling_mode,clarification_attempts FROM conversations WHERE id=?').get(handoff.conversation_id);
        assert.equal(conversation.handling_mode, 'HANDOFF_PENDING');
        assert.equal(conversation.clarification_attempts, 3);
        assert.equal(fixture.prepare("SELECT type FROM notifications WHERE message_id=? AND json_extract(metadata_json,'$.handoff')=1").get(handoff.id)?.type, 'KNOWLEDGE_GUIDANCE_LIMIT');
        const followup = await simulate({ platformCode, conversationId, content: '澳车北上怎么申请' });
        assert.equal(followup.status, 'MANUAL_REQUIRED');
        assert.equal(followup.reply_job_id, null);
      } finally { fixture.close(); }
    }
    assert.equal(ragRequests.length, beforeQueries);
  });

  await t.test('申请引导后补充业务可查询 RAG，后续怎么申请沿用已明确的业务', async () => {
    const conversationId = 'application-subject-resolved';
    const fixture = new DatabaseSync(dbPath);
    fixture.exec('PRAGMA busy_timeout=15000');
    try {
      const beforeQueries = ragRequests.length;
      const guidance = await simulate({ conversationId, content: '怎么申请' });
      assert.equal(guidance.decision, 'KNOWLEDGE_GAP_GUIDANCE');
      assert.equal(ragRequests.length, beforeQueries);
      fixture.prepare("UPDATE messages SET status='AUTO_REPLIED',handled_at=? WHERE id=?").run(new Date().toISOString(), guidance.id);
      const answered = await simulate({ conversationId, content: '澳车北上' });
      assert.equal(answered.decision, 'RAG_ANSWERED');
      assert.equal(JSON.parse(answered.reply_context_json).guidanceAttempt, 0);
      fixture.prepare("UPDATE messages SET status='AUTO_REPLIED',handled_at=? WHERE id=?").run(new Date().toISOString(), answered.id);
      const followup = await simulate({ conversationId, content: '怎么申请' });
      assert.equal(followup.decision, 'RAG_ANSWERED');
      assert.equal(ragRequests.length, beforeQueries + 2);
      assert.deepEqual(ragRequests.at(-1).context.map(item => [item.role, item.text]), [
        ['USER', '怎么申请'], ['ASSISTANT', guidance.reply_text],
        ['USER', '澳车北上'], ['ASSISTANT', shortAnswer]
      ]);
    } finally { fixture.close(); }
  });

  await t.test('第三轮查到可靠答案仍自动回复并重置引导次数，新会话独立计数', async () => {
    const conversationId = 'guidance-resolved';
    for (let attempt = 1; attempt <= 2; attempt += 1) await simulate({ conversationId, content: `无答案第${attempt}次` });
    const answered = await simulate({ conversationId, content: '办理业务需要什么材料？' });
    assert.equal(answered.decision, 'RAG_ANSWERED');
    const next = await simulate({ conversationId, content: '又一个无答案的问题' });
    assert.equal(next.decision, 'RAG_NEED_CLARIFICATION');
    assert.equal(JSON.parse(next.reply_context_json).guidanceAttempt, 1);
    const isolated = await simulate({ conversationId: 'guidance-isolated', content: '新会话无答案' });
    assert.equal(JSON.parse(isolated.reply_context_json).guidanceAttempt, 1);
  });

  const beforeRiskRequestCount = ragRequests.length;
  const risk = await simulate({ content: '你们都是垃圾客服，等着被报复', conversationId: 'formal-rag-risk' });
  assert.equal(risk.status, 'MANUAL_REQUIRED');
  assert.match(risk.decision, /HUMAN_FOLLOWUP_NOTIFICATION_PENDING|HUMAN_FOLLOWUP_NOTIFIED/);
  assert.equal(risk.reply_job_id, null);
  assert.equal(ragRequests.length, beforeRiskRequestCount);

  const unavailable = await simulate({ content: 'RAG服务异常时怎么办', conversationId: 'formal-rag-unavailable' });
  assert.equal(unavailable.status, 'MANUAL_REQUIRED');
  assert.match(unavailable.decision, /HUMAN_FOLLOWUP_NOTIFICATION_PENDING|HUMAN_FOLLOWUP_NOTIFIED/);
  assert.equal(unavailable.reply_job_id, null);
  assert.equal(unavailable.reply_text, null);

  const managedSeed = await simulate({ content: '已有答案用于建立人工会话', conversationId: 'formal-rag-managed' });
  const beforeManagedFollowupCount = ragRequests.length;
  const db = new DatabaseSync(dbPath);
  db.prepare("UPDATE conversations SET handling_mode='HUMAN_MANAGED',human_followup_state='WAITING',handoff_reason='测试人工已接管' WHERE id=?").run(managedSeed.conversation_id);
  db.close();
  const managedFollowup = await simulate({ content: '人工接管后的新消息', conversationId: 'formal-rag-managed' });
  assert.equal(managedFollowup.status, 'MANUAL_REQUIRED');
  assert.match(managedFollowup.decision, /HUMAN_FOLLOWUP_NOTIFICATION_PENDING|HUMAN_FOLLOWUP_NOTIFIED/);
  assert.equal(managedFollowup.reply_job_id, null);
  assert.equal(ragRequests.length, beforeManagedFollowupCount);

  const verifyDb = new DatabaseSync(dbPath, { readOnly: true });
  for (const message of [commentNoAnswer, commentGreeting]) {
    assert.equal(verifyDb.prepare("SELECT COUNT(*) AS count FROM agent_jobs WHERE job_type='REPLY' AND CAST(json_extract(payload,'$.messageId') AS INTEGER)=?").get(message.id).count, 0);
    assert.equal(verifyDb.prepare("SELECT COUNT(*) AS count FROM notifications WHERE message_id=? AND type='COMMENT_KNOWLEDGE_GAP' AND json_extract(metadata_json,'$.handoff')=1").get(message.id).count, 1);
    assert.equal(verifyDb.prepare('SELECT handling_mode FROM conversations WHERE id=?').get(message.conversation_id).handling_mode, 'HANDOFF_PENDING');
  }
  assert.equal(verifyDb.prepare("SELECT COUNT(*) AS count FROM knowledge_gaps WHERE message_id IN (?,?,?)").get(...clarificationReplies.map(item => item.id)).count, 0);
  assert.ok(verifyDb.prepare("SELECT COUNT(*) AS count FROM notifications WHERE message_id=? AND json_extract(metadata_json,'$.handoff')=1").get(risk.id).count >= 1);
  assert.ok(verifyDb.prepare("SELECT COUNT(*) AS count FROM notifications WHERE message_id=? AND json_extract(metadata_json,'$.handoff')=1").get(managedFollowup.id).count >= 1);
  verifyDb.close();

  await t.test('正式私信第五次提问仅携带第二到第四轮历史问答', async () => {
    const conversationId = 'formal-rag-three-rounds';
    const fixture = new DatabaseSync(dbPath);
    fixture.exec('PRAGMA busy_timeout=15000');
    try {
      for (let index = 1; index <= 5; index += 1) {
        const item = await simulate({ content: `社区业务咨询第${index}个问题`, conversationId });
        fixture.prepare("UPDATE messages SET status='AUTO_REPLIED',handled_at=? WHERE id=?").run(new Date().toISOString(), item.id);
      }
      assert.deepEqual(ragRequests.at(-1).context.map(item => [item.role, item.text]), [
        ['USER', '社区业务咨询第2个问题'], ['ASSISTANT', shortAnswer],
        ['USER', '社区业务咨询第3个问题'], ['ASSISTANT', shortAnswer],
        ['USER', '社区业务咨询第4个问题'], ['ASSISTANT', shortAnswer]
      ]);
    } finally { fixture.close(); }
  });

  await t.test('实际私信处理传递成对历史、按会话隔离并排除未发送草稿和已删除消息', async () => {
    const conversationId = 'formal-rag-context';
    const seed = await simulate({ content: '我想入驻港澳服务社区', conversationId });
    const fixture = new DatabaseSync(dbPath);
    fixture.exec('PRAGMA busy_timeout=15000');
    try {
      fixture.prepare("UPDATE messages SET status='AUTO_REPLIED',handled_at='2026-08-01T00:01:00Z',created_at='2026-08-01T00:00:00Z' WHERE id=?").run(seed.id);
      const followup = await simulate({ content: '那需要什么材料？', conversationId });
      assert.deepEqual(ragRequests.at(-1).context.map(item => [item.role, item.text]), [
        ['USER', '我想入驻港澳服务社区'], ['ASSISTANT', shortAnswer]
      ]);
      assert.equal(ragRequests.at(-1).context[1].sentAt, '2026-08-01T00:01:00.000Z');
      assert.equal(JSON.parse(followup.reply_context_json).contextUsed, true);

      await simulate({ content: '可以线上办理吗？', conversationId });
      assert.deepEqual(ragRequests.at(-1).context.map(item => [item.role, item.text]), [
        ['USER', '我想入驻港澳服务社区'], ['ASSISTANT', shortAnswer], ['USER', '那需要什么材料？']
      ]);

      await simulate({ content: '那需要什么材料？', conversationId: 'formal-rag-context-other-user' });
      assert.deepEqual(ragRequests.at(-1).context, []);

      fixture.prepare('UPDATE messages SET deleted_at=? WHERE id=?').run(new Date().toISOString(), seed.id);
      await simulate({ content: '那在哪里办呢？', conversationId });
      assert.ok(ragRequests.at(-1).context.every(item => item.messageId !== String(seed.id) && item.messageId !== `${seed.id}:reply`));
    } finally { fixture.close(); }
  });
});


