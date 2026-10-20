import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const root = path.resolve(import.meta.dirname, '..');
async function freePort() { const server = http.createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port; }
async function request(base, pathname, options = {}) { const response = await fetch(base + pathname, { ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } }); return { response, data: await response.json() }; }
async function waitFor(base) { for (let i = 0; i < 80; i += 1) { try { const response = await fetch(base + '/api/health'); if (response.ok) return; } catch {} await new Promise(resolve => setTimeout(resolve, 100)); } throw new Error('测试服务启动超时'); }

test('小智即时复用正式知识库，但不创建真实消息或Agent任务', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaozhi-chat-'));
  const dbPath = path.join(dir, 'test.db');
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['src/server.js'], { cwd: root, env: { ...process.env, PORT: String(port), DATABASE_PATH: dbPath, QWEN_MODE: 'mock', RPA_MODE: 'simulated', AUTO_COLLECT_ENABLED: 'false', LOCAL_AGENT_AUTO_START: 'false', AUTH_ENABLED: 'false', BUSINESS_GUIDANCE_MAX_ATTEMPTS: '5' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill(); await Promise.race([new Promise(resolve => child.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 2000))]); } fs.rmSync(dir, { recursive: true, force: true }); });
  await waitFor(base).catch(error => { throw new Error(`${error.message}\n${stderr}`); });

  const created = await request(base, '/api/knowledge', { method: 'POST', body: JSON.stringify({ question: '参加志愿者活动需要携带什么材料？', answer: '请携带本人有效证件，并提前十分钟到场。', keywords: '志愿者,活动,材料', category: '公共知识库', subcategory: '活动咨询' }) });
  assert.equal(created.response.status, 201, JSON.stringify(created.data));
  const knowledgeId = created.data.knowledge.id;
  const published = await request(base, `/api/knowledge/${knowledgeId}/publish`, { method: 'POST', body: JSON.stringify({ reviewedBy: 'xiaozhi-test' }) });
  assert.equal(published.response.status, 200, JSON.stringify(published.data));

  const secondCreated = await request(base, '/api/knowledge', { method: 'POST', body: JSON.stringify({ question: '社区活动怎么报名？', answer: '近期社区活动请通过置顶活动通知中的报名入口提交信息。', keywords: '社区,活动,报名', category: '公共知识库', subcategory: '活动咨询' }) });
  assert.equal(secondCreated.response.status, 201, JSON.stringify(secondCreated.data));
  const secondKnowledgeId = secondCreated.data.knowledge.id;
  const secondPublished = await request(base, `/api/knowledge/${secondKnowledgeId}/publish`, { method: 'POST', body: JSON.stringify({ reviewedBy: 'xiaozhi-test' }) });
  assert.equal(secondPublished.response.status, 200, JSON.stringify(secondPublished.data));

  const options = await request(base, '/api/xiaozhi/options');
  assert.equal(options.response.status, 200);
  assert.ok(options.data.options.platforms.some(item => item.code === 'douyin'));
  const session = await request(base, '/api/xiaozhi/sessions', { method: 'POST', body: JSON.stringify({ platformCode: 'douyin', messageType: 'PRIVATE_MESSAGE', contextEnabled: true }) });
  assert.equal(session.response.status, 200);

  const beforeDb = new DatabaseSync(dbPath, { readOnly: true });
  const beforeMessages = beforeDb.prepare('SELECT COUNT(*) count FROM messages').get().count;
  const beforeJobs = beforeDb.prepare('SELECT COUNT(*) count FROM agent_jobs').get().count;
  beforeDb.close();

  const first = await request(base, '/api/xiaozhi/chat', { method: 'POST', body: JSON.stringify({ sessionId: session.data.session.id, content: '参加志愿者活动需要携带什么材料？', platformCode: 'douyin', messageType: 'PRIVATE_MESSAGE', contextEnabled: true }) });
  assert.equal(first.response.status, 200, JSON.stringify(first.data));
  assert.equal(first.data.testOnly, true);
  assert.equal(first.data.decision, 'AUTO_REPLY');
  assert.deepEqual(first.data.matchedKnowledgeIds, [knowledgeId]);
  assert.match(first.data.replyText, /有效证件/);
  assert.ok(first.data.answerId);
  assert.equal(first.data.approvalDecision, 'ENABLED');
  assert.equal(first.data.decisionVersion, 1);

  const followup = await request(base, '/api/xiaozhi/chat', { method: 'POST', body: JSON.stringify({ sessionId: session.data.session.id, content: '那需要什么？', platformCode: 'douyin', messageType: 'PRIVATE_MESSAGE', contextEnabled: true }) });
  assert.equal(followup.response.status, 200, JSON.stringify(followup.data));
  assert.equal(followup.data.decision, 'AUTO_REPLY');
  assert.equal(followup.data.contextUsed, true);
  assert.deepEqual(followup.data.matchedKnowledgeIds, [knowledgeId]);

  const multi = await request(base, '/api/xiaozhi/chat', { method: 'POST', body: JSON.stringify({ sessionId: session.data.session.id, content: '参加志愿者活动需要携带什么材料？另外，社区活动怎么报名？', platformCode: 'douyin', messageType: 'PRIVATE_MESSAGE', contextEnabled: true }) });
  assert.equal(multi.response.status, 200, JSON.stringify(multi.data));
  assert.equal(multi.data.decision, 'AUTO_REPLY');
  assert.deepEqual(multi.data.matchedKnowledgeIds, [knowledgeId, secondKnowledgeId]);
  assert.match(multi.data.replyText, /请携带本人有效证件，并提前十分钟到场。/);
  assert.match(multi.data.replyText, /近期社区活动请通过置顶活动通知中的报名入口提交信息。/);
  assert.doesNotMatch(multi.data.replyText, /关于你提出的问题|^[12]\./m);

  const guidanceSession = await request(base, '/api/xiaozhi/sessions', { method: 'POST', body: JSON.stringify({ platformCode: 'douyin', messageType: 'PRIVATE_MESSAGE', contextEnabled: true }) });
  assert.equal(guidanceSession.response.status, 200);
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const guidance = await request(base, '/api/xiaozhi/chat', { method: 'POST', body: JSON.stringify({ sessionId: guidanceSession.data.session.id, content: '你好', platformCode: 'douyin', messageType: 'PRIVATE_MESSAGE', contextEnabled: true }) });
    assert.equal(guidance.response.status, 200, JSON.stringify(guidance.data));
    assert.equal(guidance.data.decision, 'SIMPLE_GREETING');
    assert.equal(guidance.data.responseMode, 'ROUTER_STATIC');
    assert.equal(guidance.data.guidanceAttempt, 0, '问候不消耗业务引导次数');
    assert.equal(guidance.data.handoffRequested, false);
  }
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const guidance = await request(base, '/api/xiaozhi/chat', { method: 'POST', body: JSON.stringify({ sessionId: guidanceSession.data.session.id, content: '怎么申请', platformCode: 'douyin', messageType: 'PRIVATE_MESSAGE', contextEnabled: true }) });
    assert.equal(guidance.response.status, 200, JSON.stringify(guidance.data));
    assert.equal(guidance.data.guidanceAttempt, attempt);
    assert.equal(guidance.data.maxGuidanceAttempts, 5);
    assert.equal(guidance.data.handoffOffered, false);
    assert.equal(guidance.data.handoffRequested, attempt === 5);
    if (attempt < 5) assert.doesNotMatch(guidance.data.replyText, /转人工/);
    else {
      assert.match(guidance.data.replyText, /转人工/);
      assert.doesNotMatch(guidance.data.replyText, /请回复|可以补充/);
    }
  }

  const disabled = await request(base, `/api/xiaozhi/sessions/${session.data.session.id}/answers/${first.data.answerId}/decision`, { method: 'PUT', body: JSON.stringify({ decision: 'DISABLED', reasonCode: 'ANSWER_INACCURATE', reason: '测试停用：答案需要重新核对' }) });
  assert.equal(disabled.response.status, 200, JSON.stringify(disabled.data));
  assert.equal(disabled.data.answer.decision, 'DISABLED');
  assert.equal(disabled.data.answer.reasonCode, 'ANSWER_INACCURATE');
  assert.equal(disabled.data.answer.decisionVersion, 2);
  assert.equal(disabled.data.answer.reason, '测试停用：答案需要重新核对');

  const disabledAgain = await request(base, `/api/xiaozhi/sessions/${session.data.session.id}/answers/${first.data.answerId}/decision`, { method: 'PUT', body: JSON.stringify({ decision: 'DISABLED', reasonCode: 'ANSWER_INACCURATE', reason: '测试停用：答案需要重新核对' }) });
  assert.equal(disabledAgain.response.status, 200, JSON.stringify(disabledAgain.data));
  assert.equal(disabledAgain.data.answer.decisionVersion, 2);

  const answers = await request(base, `/api/xiaozhi/sessions/${session.data.session.id}/answers`);
  assert.equal(answers.response.status, 200, JSON.stringify(answers.data));
  const persistedFirst = answers.data.answers.find(item => item.answerId === first.data.answerId);
  assert.equal(persistedFirst.decision, 'DISABLED');
  assert.equal(persistedFirst.decisionVersion, 2);

  const answerHistory = await request(base, `/api/xiaozhi/sessions/${session.data.session.id}/answers/${first.data.answerId}/history`);
  assert.equal(answerHistory.response.status, 200, JSON.stringify(answerHistory.data));
  assert.deepEqual(answerHistory.data.history.map(item => item.decision), ['ENABLED', 'DISABLED']);
  assert.equal(answerHistory.data.history[1].operatorId, 'admin');

  const disabledChat = await request(base, '/api/xiaozhi/chat', { method: 'POST', body: JSON.stringify({ sessionId: session.data.session.id, content: '参加志愿者活动需要携带什么材料？', platformCode: 'douyin', messageType: 'PRIVATE_MESSAGE', contextEnabled: false }) });
  assert.equal(disabledChat.response.status, 200, JSON.stringify(disabledChat.data));
  assert.equal(disabledChat.data.matchedKnowledgeIds.includes(knowledgeId), false);

  const enabled = await request(base, `/api/xiaozhi/sessions/${session.data.session.id}/answers/${first.data.answerId}/decision`, { method: 'PUT', body: JSON.stringify({ decision: 'ENABLED' }) });
  assert.equal(enabled.response.status, 200, JSON.stringify(enabled.data));
  assert.equal(enabled.data.answer.decision, 'ENABLED');
  assert.equal(enabled.data.answer.reasonCode, null);
  assert.equal(enabled.data.answer.reason, null);
  assert.equal(enabled.data.answer.decisionVersion, 3);

  const afterEnableChat = await request(base, '/api/xiaozhi/chat', { method: 'POST', body: JSON.stringify({ sessionId: session.data.session.id, content: '参加志愿者活动需要携带什么材料？', platformCode: 'douyin', messageType: 'PRIVATE_MESSAGE', contextEnabled: false }) });
  assert.equal(afterEnableChat.response.status, 200, JSON.stringify(afterEnableChat.data));
  assert.deepEqual(afterEnableChat.data.matchedKnowledgeIds, [knowledgeId]);

  const missingReason = await request(base, `/api/xiaozhi/sessions/${session.data.session.id}/answers/${first.data.answerId}/decision`, { method: 'PUT', body: JSON.stringify({ decision: 'DISABLED' }) });
  assert.equal(missingReason.response.status, 400, JSON.stringify(missingReason.data));

  const afterDb = new DatabaseSync(dbPath, { readOnly: true });
  assert.equal(afterDb.prepare('SELECT COUNT(*) count FROM xiaozhi_test_answers WHERE answer_id=?').get(first.data.answerId).count, 1);
  assert.equal(afterDb.prepare('SELECT COUNT(*) count FROM xiaozhi_test_answer_decision_history WHERE answer_id=?').get(first.data.answerId).count, 3);
  assert.equal(afterDb.prepare('SELECT COUNT(*) count FROM messages').get().count, beforeMessages);
  assert.equal(afterDb.prepare('SELECT COUNT(*) count FROM agent_jobs').get().count, beforeJobs);
  afterDb.close();

  const appSource = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');
  const styleSource = fs.readFileSync(path.join(root, 'public/styles.css'), 'utf8');
  const qwenSource = fs.readFileSync(path.join(root, 'src/services/qwen.js'), 'utf8');
  assert.match(appSource, /status:'thinking'/);
  assert.match(appSource, /typeXiaozhiReply/);
  assert.match(appSource, /xiaozhi-thinking/);
  assert.match(appSource, /xiaozhi-reply-text/);
  assert.match(appSource, /业务引导/);
  assert.match(appSource, /handoffOffered/);
  assert.match(appSource, /xiaozhi-enable/);
  assert.match(appSource, /xiaozhi-disable/);
  assert.match(appSource, /xiaozhi-review-dialog/);
  assert.match(appSource, /ANSWER_INACCURATE/);
  assert.match(appSource, /具体说明/);
  assert.match(appSource, /\/decision/);
  assert.match(appSource, /status==='typing'/);
  assert.match(styleSource, /xiaozhiDotBounce/);
  assert.match(styleSource, /xiaozhiCursorBlink/);
  assert.match(qwenSource, /composeMultiReply[\s\S]*?enable_thinking:\s*false/);
  assert.match(qwenSource, /composeMultiReply[\s\S]*?max_tokens:/);
});



