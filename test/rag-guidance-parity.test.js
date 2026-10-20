import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { startServer, stopChild, cleanupDir, jsonRequest } from './helpers/runtime.js';

const candidate = { documentId: 'policy-document', documentVersion: 1, chunkId: 'policy-chunk', title: '什么是“七免两低”扶持政策？', sectionPath: ['OPC港澳服务社区介绍及入驻流程', '常见问题'], verificationStatus: 'VERIFIED' };
const queryAnalysis = question => ({ originalQuestion: question, resolvedQuestion: question, keywords: ['社区', '政策'], contextUsed: true });

test('小智和各平台私信使用相同的主题确认，并保留三轮转人工边界', async t => {
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
  const questions = ['这个有什么政策？', '就是社区政策有哪一些'];
  const chat = await createChat();
  const testFirst = await chat(questions[0]);
  const testSecond = await chat(questions[1]);
  assert.match(testFirst.replyText, /政策/);
  assert.match(testSecond.replyText, /七免两低/);
  assert.match(testSecond.replyText, /[？?]/);
  assert.notEqual(testFirst.replyText, testSecond.replyText);
  assert.doesNotMatch(testSecond.replyText, /具体说明一下想咨询的业务/);
  assert.equal(testSecond.confidence, 0, '确认候选不能冒充可靠知识答案');
  assert.equal(testFirst.matchMethod, 'OUTER_ROUTER', '未明确对象的政策问题先在业务层确认');
  for (const platform of ['douyin', 'weibo', 'wechat_channels', 'bilibili', 'xiaohongshu']) {
    const first = await simulate(platform, `${platform}-guidance`, questions[0]);
    const second = await simulate(platform, `${platform}-guidance`, questions[1]);
    assert.equal(first.reply_text, testFirst.replyText, platform);
    assert.equal(second.reply_text, testSecond.replyText, platform);
    assert.equal(JSON.parse(second.reply_context_json).clarificationCandidate.candidateQuestion, candidate.title);
    const third = await simulate(platform, `${platform}-guidance`, '不是，还有其他政策吗？');
    assert.equal(third.status, 'MANUAL_REQUIRED', platform);
    assert.equal(third.reply_job_id, null, platform);
    assert.equal(third.reply_text, null, platform);
  }
  assert.equal((await chat('不是，还有其他政策吗？')).handoffRequested, true);
  const confirmed = await createChat();
  await confirmed(questions[0]); await confirmed(questions[1]);
  assert.equal((await confirmed('是的')).decision, 'RAG_ANSWERED', '第三轮能查到答案时正常回复');
  const actual = await simulate('douyin', 'confirmed-policy', questions[0]);
  await simulate('douyin', 'confirmed-policy', questions[1]);
  const answer = await simulate('douyin', 'confirmed-policy', '是的');
  assert.equal(answer.decision, 'RAG_ANSWERED');
  assert.ok(requests.at(-1).context.some(item => item.role === 'ASSISTANT' && item.text.includes('七免两低')));
  assert.equal(db.prepare('SELECT clarification_attempts FROM conversations WHERE id=?').get(actual.conversation_id).clarification_attempts, 0);
  assert.ok(!requests.some(item => item.question === questions[0]), '没有业务对象时不能让 RAG 猜测政策');
});
