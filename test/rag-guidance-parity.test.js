import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { startServer, stopChild, cleanupDir, jsonRequest } from './helpers/runtime.js';

const candidate = { documentId: 'policy-document', documentVersion: 1, chunkId: 'policy-chunk', title: '什么是“七免两低”扶持政策？', sectionPath: ['OPC港澳服务社区介绍及入驻流程', '常见问题'], verificationStatus: 'VERIFIED' };
const queryAnalysis = question => ({ originalQuestion: question, resolvedQuestion: question, keywords: ['社区', '政策'], contextUsed: true });

test('小智和各平台私信区分缺对象澄清与证据缺口，不因候选或三次无答案制造回问循环', async t => {
  const requests = [];
  const rag = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const input = JSON.parse(Buffer.concat(chunks).toString() || '{}');
    const send = data => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
    if (req.url === '/rag-admin-api/v1/test-sessions') return send({ testSessionId: 'guidance-test-session' });
    const formal = req.url === '/rag-api/v1/query';
    const question = formal ? input.query.text : input.question;
    requests.push({ formal, question, context: input.context });
    const known = question === '什么是七免两低政策' || question === '是的';
    const analysis = queryAnalysis(question);
    send({
      result: known ? 'ANSWERED' : 'NO_ANSWER', reasonCode: known ? null : 'INSUFFICIENT_EVIDENCE',
      snapshot: input.snapshot, answerId: 'guidance-answer',
      answer: known ? { text: '这是社区的创业扶持政策。' } : null,
      grounding: { confidence: known ? 0.9 : 0.41, sourceReferences: formal && !known ? [] : [candidate] },
      meta: { knowledgeVersion: 'same-release', ...(formal ? {} : { queryAnalysis: analysis }) },
      ...(formal ? { diagnostics: { queryAnalysis: analysis, selectedCandidates: [{ document_id: candidate.documentId, document_version: 1, chunk_id: candidate.chunkId, title: candidate.title, section_path: candidate.sectionPath, selected: true }] } } : {})
    });
  });
  await new Promise(resolve => rag.listen(0, '127.0.0.1', resolve));
  const runtime = await startServer({ env: { RAG_BASE_URL: `http://127.0.0.1:${rag.address().port}`, RAG_ADMIN_ENABLED: 'true', RAG_FORMAL_ROUTING_ENABLED: 'true', WECOM_WEBHOOK_URL: '', BUSINESS_GUIDANCE_MAX_ATTEMPTS: '3' } });
  const db = new DatabaseSync(runtime.dbPath);
  db.exec('PRAGMA busy_timeout=5000');
  t.after(async () => { db.close(); await stopChild(runtime.child); cleanupDir(runtime.dir); await new Promise(resolve => rag.close(resolve)); });
  db.prepare("UPDATE accounts SET enabled=1 WHERE platform_code IN ('douyin','weibo','wechat_channels','bilibili','xiaohongshu')").run();
  const accounts = (await jsonRequest(runtime.base, '/api/accounts')).data.accounts;
  const createChat = async () => {
    const session = await jsonRequest(runtime.base, '/api/xiaozhi/sessions', { method: 'POST', body: { scope: 'published', contextEnabled: true } });
    return async content => (await jsonRequest(runtime.base, '/api/xiaozhi/chat', { method: 'POST', body: { sessionId: session.data.session.id, content } })).data;
  };
  let sequence = 0;
  const simulate = async (platformCode, conversationId, content) => {
    const id = `guidance-${++sequence}`;
    const result = await jsonRequest(runtime.base, '/api/messages/simulate', { method: 'POST', body: {
      platformCode, accountId: accounts.find(a => a.platform_code === platformCode).id, messageType: 'PRIVATE_MESSAGE',
      externalId: id, userName: '引导回归用户', content,
      context: { conversationId, messageId: id, direction: 'incoming', sourceVerified: true, chatTitleVerified: true, previewOnly: false, unreadCount: 1 }
    } });
    assert.equal(result.response.status, 201, `${platformCode}: ${JSON.stringify(result.data)}`);
    const message = result.data.message;
    // Simulate the customer having seen the prior reply without running an Agent.
    if (message.reply_job_id) {
      db.prepare("UPDATE agent_jobs SET status='SUCCESS' WHERE id=?").run(message.reply_job_id);
      db.prepare("UPDATE messages SET status='AUTO_REPLIED',handled_at=?,handled_by='AI' WHERE id=?").run(new Date().toISOString(), message.id);
    }
    return message;
  };
  const questions = ['这个有什么政策？', '就是社区政策有哪一些', '不是，还有其他政策吗？'];
  const chat = await createChat();
  const results = [];
  for (const question of questions) results.push(await chat(question));
  assert.equal(results[0].matchMethod, 'OUTER_ROUTER', '未解析的“这个”才在业务层确认');
  for (const result of results.slice(1)) {
    assert.equal(result.decision, 'RAG_KNOWLEDGE_GAP');
    assert.equal(result.guidanceAttempt, 0);
    assert.equal(result.handoffRequested, false);
    assert.equal(result.clarificationCandidate, null);
    assert.doesNotMatch(result.replyText, /七免两低|[？?]|具体说明一下想咨询的业务/);
  }
  for (const platform of ['douyin', 'weibo', 'wechat_channels', 'bilibili', 'xiaohongshu']) {
    const conversationId = `${platform}-guidance`;
    let message;
    for (let index = 0; index < questions.length; index += 1) {
      message = await simulate(platform, conversationId, questions[index]);
      assert.equal(message.reply_text, results[index].replyText, platform);
      assert.ok(message.reply_job_id, platform);
    }
    const conversation = db.prepare('SELECT handling_mode,clarification_attempts,pending_intent_json FROM conversations WHERE id=?').get(message.conversation_id);
    assert.equal(conversation.handling_mode, 'BOT_ACTIVE');
    assert.equal(conversation.clarification_attempts, 1, '只有第一条真缺对象问题计数');
    assert.equal(conversation.pending_intent_json, null, '候选不能被写为待用户确认对象');
    const answer = await simulate(platform, conversationId, '什么是七免两低政策');
    assert.equal(answer.decision, 'RAG_ANSWERED');
    assert.equal(db.prepare('SELECT clarification_attempts FROM conversations WHERE id=?').get(answer.conversation_id).clarification_attempts, 0);
  }
  assert.equal((await chat('什么是七免两低政策')).decision, 'RAG_ANSWERED');
  assert.ok(!requests.some(item => item.question === questions[0]), '真缺对象的首问仍不让 RAG 猜测');
  assert.ok(requests.some(item => item.formal && item.question === questions[1]));
  const broad = await createChat();
  assert.equal((await broad('有哪些政策？')).decision, 'RAG_KNOWLEDGE_GAP');
  assert.ok(requests.some(item => item.question === '有哪些政策？'), '宽泛目录请求按知识库默认范围查询');
});

test('小智RAG评论先邀请人工协助，仅在有上下文的严格确认后接管', async t => {
  const questions = [];
  const rag = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const input = JSON.parse(Buffer.concat(chunks).toString() || '{}');
    const send = (data, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
    if (req.url === '/rag-admin-api/v1/test-sessions') return send({ testSessionId: 'comment-offer-test-session' });
    const question = input.question;
    questions.push(question);
    if (question === '课程服务失败') return send({ error: { code: 'RAG_UNAVAILABLE', message: 'service unavailable' } }, 503);
    const status = question === '课程问题被拒绝' ? 'REJECTED' : question === '课程安排不明确' ? 'NEED_CLARIFICATION' : question === '社区入驻材料' ? 'ANSWERED' : 'NO_ANSWER';
    send({
      result: status, answerId: `comment-offer-answer-${questions.length}`, answer: status === 'ANSWERED' ? { text: '请准备项目计划书。' } : null,
      grounding: { confidence: status === 'ANSWERED' ? 0.9 : 0, sourceReferences: status === 'ANSWERED' ? [candidate] : [] },
      reasonCode: status === 'ANSWERED' ? null : 'INSUFFICIENT_EVIDENCE', meta: { knowledgeVersion: 'comment-offer-test' }
    });
  });
  await new Promise(resolve => rag.listen(0, '127.0.0.1', resolve));
  const runtime = await startServer({ env: { RAG_BASE_URL: `http://127.0.0.1:${rag.address().port}`, RAG_ADMIN_ENABLED: 'true', RAG_FORMAL_ROUTING_ENABLED: 'true', WECOM_WEBHOOK_URL: '' } });
  t.after(async () => { await stopChild(runtime.child); cleanupDir(runtime.dir); await new Promise(resolve => rag.close(resolve)); });
  const createChat = async (contextEnabled = true) => {
    const session = await jsonRequest(runtime.base, '/api/xiaozhi/sessions', { method: 'POST', body: { messageType: 'COMMENT', contextEnabled } });
    assert.equal(session.response.status, 200, JSON.stringify(session.data));
    return async (content, settings = {}) => {
      const response = await jsonRequest(runtime.base, '/api/xiaozhi/chat', { method: 'POST', body: { sessionId: session.data.session.id, content, ...settings } });
      assert.equal(response.response.status, 200, JSON.stringify(response.data));
      return response.data;
    };
  };
  for (const question of ['有没有木工雕刻课？', '课程安排不明确']) {
    const ask = await createChat();
    const offered = await ask(question);
    assert.equal(offered.action, 'REPLY');
    assert.equal(offered.decision, 'COMMENT_HANDOFF_OFFER');
    assert.equal(offered.handoffOffered, true);
    assert.equal(offered.handoffRequested, false);
    assert.equal(offered.confidence, 0);
    assert.match(offered.replyText, /回复.*详情/);
    assert.match(offered.replyText, /站内消息/);
    assert.doesNotMatch(offered.replyText, /转人工|人工协助|已通知|已发私信/);
    const before = questions.length;
    const accepted = await ask('详情');
    assert.equal(accepted.action, 'HANDOFF');
    assert.equal(accepted.handoffRequested, true);
    assert.equal(questions.length, before, '邀请后的严格确认无需再次查询知识');
    assert.equal((await ask('社区入驻材料')).action, 'HANDOFF');
  }
  const declinedChat = await createChat();
  await declinedChat('有没有木工雕刻课？');
  const beforeDecline = questions.length;
  assert.equal((await declinedChat('不用了，谢谢')).decision, 'COMMENT_HANDOFF_DECLINED');
  assert.equal(questions.length, beforeDecline);
  assert.equal((await declinedChat('好的')).decision, 'COMMENT_SOCIAL_REPLY', '拒绝后不能用普通肯定确认旧邀请');
  assert.equal((await declinedChat('社区入驻材料')).decision, 'RAG_ANSWERED', '拒绝后仍可自动回答可靠知识');

  const mixedChat = await createChat();
  await mixedChat('有没有木工雕刻课？');
  const mixed = await mixedChat('好，课程几点开始？');
  assert.equal(mixed.action, 'REPLY');
  assert.equal(mixed.handoffRequested, false);
  assert.equal(questions.at(-1), '好，课程几点开始？');
  const stateless = await createChat(false);
  await stateless('有没有木工雕刻课？');
  assert.equal((await stateless('好的')).decision, 'COMMENT_SOCIAL_REPLY');
  assert.equal((await stateless('好的', { contextEnabled: true })).handoffRequested, false);
  const switched = await createChat();
  await switched('有没有木工雕刻课？');
  assert.equal((await switched('是的', { messageType: 'PRIVATE_MESSAGE' })).handoffRequested, false, '评论邀请不跨入私信');
  assert.equal((await switched('好的', { messageType: 'COMMENT' })).handoffRequested, false);
  for (const content of ['转人工', '垃圾客服', '课程问题被拒绝', '课程服务失败']) {
    const result = await (await createChat())(content);
    assert.equal(result.action, 'HANDOFF', content);
    assert.equal(result.handoffRequested, true, content);
    assert.equal(result.handoffOffered, false, content);
  }
});
