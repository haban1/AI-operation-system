import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';
import { openWorkspacePage } from './helpers/runtime.js';

const root = path.resolve(import.meta.dirname, '..');
// 与本项目其它浏览器测试保持一致：优先读 CHROME_EXECUTABLE_PATH，未安装 Chrome 时跳过。
function installedChromePath() {
  const candidates = [
    process.env.CHROME_EXECUTABLE_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser'
  ].filter(Boolean);
  return candidates.find(candidate => fs.existsSync(candidate)) || null;
}
const chromePath = installedChromePath();
async function listen(server) { await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); return server.address().port; }
async function readBody(req) { const chunks = []; for await (const chunk of req) chunks.push(chunk); return Buffer.concat(chunks); }
async function request(base, pathname, options = {}) {
  const response = await fetch(base + pathname, { ...options, headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) } });
  return { response, data: await response.json() };
}
async function waitFor(base) { for (let i = 0; i < 100; i += 1) { try { if ((await fetch(`${base}/api/health`)).ok) return; } catch {} await new Promise(resolve => setTimeout(resolve, 100)); } throw new Error('测试服务启动超时'); }

function appEnvironment({ port, dbPath, ragPort }) {
  return {
    ...process.env,
    PORT: String(port), DATABASE_PATH: dbPath, AUTH_ENABLED: 'false', AGENT_SHARED_TOKEN: '', QWEN_MODE: 'mock', RPA_MODE: 'simulated',
    AUTO_COLLECT_ENABLED: 'false', LOCAL_AGENT_AUTO_START: 'false', INSTANCE_LOCK_ENABLED: 'false', BUSINESS_GUIDANCE_MAX_ATTEMPTS: '3',
    RAG_BASE_URL: `http://127.0.0.1:${ragPort}`, RAG_ADMIN_ENABLED: 'true', RAG_FORMAL_ROUTING_ENABLED: 'false', RAG_TIMEOUT_MS: '3000'
  };
}

test('业务后端代理 RAG 文档、发布和小智测试管理接口', { skip: !chromePath }, async t => {
  const observed = { upload: null, release: null, rollback: null, testSession: null, testQuery: null, decision: null, documentKnowledgeBaseId: null, releaseKnowledgeBaseId: null, releaseDocumentVersion: null, chunksVersion: null, deletedDocumentId: null };
  let testQueryResult = null;
  const ragServer = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://rag.local');
    const json = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
    if (req.method === 'GET' && url.pathname === '/rag-admin-api/v1/system/status') return json(200, { status: 'READY', providers: { embedding: 'mock' } });
    if (req.method === 'GET' && url.pathname === '/rag-admin-api/v1/documents') { observed.documentKnowledgeBaseId = url.searchParams.get('knowledge_base_id'); return json(200, { documents: [{ documentId: 'doc-1', documentVersion: 2, title: '运营手册', filename: 'manual.txt', status: 'READY_FOR_TEST', createdAt: '2026-08-28T00:00:00Z', updatedAt: '2026-08-28T00:00:00Z' }] }); }
    if (req.method === 'POST' && url.pathname === '/rag-admin-api/v1/documents') {
      const raw = await readBody(req); observed.upload = { contentType: req.headers['content-type'], raw: raw.toString('utf8') };
      return json(202, { documentId: 'doc-1', documentVersion: 2, title: '运营手册', filename: 'manual.txt', status: 'PROCESSING', progress: 0, createdAt: '2026-08-28T00:00:00Z', updatedAt: '2026-08-28T00:00:00Z' });
    }
    if (req.method === 'GET' && url.pathname === '/rag-admin-api/v1/documents/doc-1') { observed.releaseDocumentVersion = url.searchParams.get('version'); return json(200, { documentId: 'doc-1', documentVersion: 2, title: '运营手册', filename: 'manual.txt', status: 'READY_FOR_TEST', progress: 100, createdAt: '2026-08-28T00:00:00Z', updatedAt: '2026-08-28T00:00:00Z' }); }
    if (req.method === 'GET' && url.pathname === '/rag-admin-api/v1/documents/doc-1/chunks') { observed.chunksVersion = url.searchParams.get('version'); return json(200, { documentId: 'doc-1', documentVersion: 2, chunks: [{ chunk_id: 'chunk-1', text: '解析后的完整内容', excerpt: '解析后的完整内容' }] }); }
    if (req.method === 'DELETE' && url.pathname === '/rag-admin-api/v1/documents/doc-1') { observed.deletedDocumentId = 'doc-1'; return json(200, { documentId: 'doc-1', filename: 'manual.txt', deleted: true }); }
    if (req.method === 'GET' && url.pathname === '/rag-admin-api/v1/releases') { observed.releaseKnowledgeBaseId = url.searchParams.get('knowledge_base_id'); return json(200, { active: { release_id: 'release-active' }, releases: [{ releaseId: 'release-active', knowledgeVersion: 'kb-main-business-kb-test123', status: 'PUBLISHED', publishedAt: '2026-08-29T06:30:00Z', publishedBy: 'admin' }] }); }
    if (req.method === 'GET' && url.pathname === '/rag-admin-api/v1/releases/release-active/members') return json(200, { releaseId: 'release-active', members: [{ document_id: 'doc-1', document_version: 2, chunk_id: 'chunk-1', text: '不得返回的第一段正文' }, { document_id: 'doc-1', document_version: 2, chunk_id: 'chunk-2', text: '不得返回的第二段正文' }] });
    if (req.method === 'POST' && url.pathname === '/rag-admin-api/v1/knowledge-bases/main-business-kb/releases') { observed.release = JSON.parse((await readBody(req)).toString('utf8')); return json(202, { releaseId: 'release-new', knowledgeBaseId: 'main-business-kb', status: 'BUILDING' }); }
    if (req.method === 'GET' && url.pathname === '/rag-admin-api/v1/releases/release-new') return json(200, { releaseId: 'release-new', knowledgeBaseId: 'main-business-kb', status: 'PUBLISHED' });
    if (req.method === 'POST' && url.pathname === '/rag-admin-api/v1/releases/release-active/rollback') { observed.rollback = JSON.parse((await readBody(req)).toString('utf8')); return json(200, { releaseId: 'release-active', knowledgeBaseId: 'main-business-kb', status: 'PUBLISHED' }); }
    if (req.method === 'POST' && url.pathname === '/rag-admin-api/v1/test-sessions') { observed.testSession = JSON.parse((await readBody(req)).toString('utf8')); return json(200, { requestId: observed.testSession.requestId, testSessionId: 'test-session-1', status: 'ACTIVE', mode: observed.testSession.mode, baseReleaseId: 'release-active', candidateDocuments: observed.testSession.candidateDocuments, createdAt: '2026-08-28T00:00:00Z' }); }
    if (req.method === 'POST' && url.pathname === '/rag-admin-api/v1/test-sessions/test-session-1/query') { observed.testQuery = JSON.parse((await readBody(req)).toString('utf8')); return json(200, { requestId: observed.testQuery.requestId, testSessionId: 'test-session-1', answerId: 'answer-1', result: 'ANSWERED', answer: { text: '这是来自待测文档的答案。' }, decision: 'ENABLED', sourceReferences: [{ documentId: 'doc-1', documentVersion: 2, chunkId: 'chunk-1' }], grounding: { confidence: 0.95, sourceReferences: [{ documentId: 'doc-1', documentVersion: 2, chunkId: 'chunk-1' }] }, traceId: 'trace-1', meta: { knowledgeVersion: 'test-version' }, ...testQueryResult }); }
    if (req.method === 'PUT' && url.pathname === '/rag-admin-api/v1/test-sessions/test-session-1/answers/answer-1/decision') { observed.decision = JSON.parse((await readBody(req)).toString('utf8')); return json(200, { requestId: observed.decision.requestId, testSessionId: 'test-session-1', answerId: 'answer-1', decision: observed.decision.decision, reasonCode: observed.decision.reasonCode, note: observed.decision.note, operatorId: observed.decision.operatorId, decisionVersion: 2, updatedAt: '2026-08-28T00:00:01Z' }); }
    if (req.method === 'GET' && url.pathname === '/rag-admin-api/v1/test-sessions/test-session-1/answers/answer-1/history') return json(200, { history: [{ answer_id: 'answer-1', decision: 'ENABLED', decision_version: 1 }, { answer_id: 'answer-1', decision: 'DISABLED', reason_code: 'ANSWER_INACCURATE', decision_version: 2 }] });
    return json(404, { error: { code: 'NOT_FOUND', message: `${req.method} ${url.pathname}` } });
  });
  const ragPort = await listen(ragServer); t.after(() => new Promise(resolve => ragServer.close(resolve)));

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rag-admin-proxy-')); const dbPath = path.join(dir, 'test.db');
  const probe = http.createServer(); const appPort = await listen(probe); await new Promise(resolve => probe.close(resolve)); const base = `http://127.0.0.1:${appPort}`;
  const child = spawn(process.execPath, ['src/server.js'], { cwd: root, env: appEnvironment({ port: appPort, dbPath, ragPort }), stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill(); await Promise.race([new Promise(resolve => child.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 3000))]); } fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  await waitFor(base).catch(error => { throw new Error(`${error.message}\n${stderr}`); });

  const status = await request(base, '/api/rag/status'); assert.equal(status.response.status, 200); assert.equal(status.data.rag.status, 'READY');
  const docs = await request(base, '/api/rag/documents?knowledgeBaseId=douyin-only-kb'); assert.equal(docs.data.documents[0].documentId, 'doc-1'); assert.equal(observed.documentKnowledgeBaseId, 'main-business-kb');
  const chunks = await request(base, '/api/rag/documents/doc-1/chunks?version=2'); assert.equal(chunks.data.chunks[0].text, '解析后的完整内容'); assert.equal(observed.chunksVersion, '2');
  const deleted = await request(base, '/api/rag/documents/doc-1', { method: 'DELETE', body: '{}' }); assert.equal(deleted.data.document.deleted, true); assert.equal(observed.deletedDocumentId, 'doc-1');
  const upload = await request(base, '/api/rag/documents', { method: 'POST', body: JSON.stringify({ filename: 'manual.txt', mimeType: 'text/plain', contentBase64: Buffer.from('测试文档内容').toString('base64'), metadata: { title: '运营手册', sourceDepartment: '运营部', sourceOwner: '资料负责人', knowledgeBaseId: 'weibo-only-kb', category: '微博知识库', subcategory: '平台专属', knowledgeCategory: '微博业务', classification: 'platform-only', platform: 'WEIBO', platformCode: 'weibo' } }) });
  assert.equal(upload.response.status, 202, JSON.stringify(upload.data)); assert.match(observed.upload.contentType, /^multipart\/form-data; boundary=/); assert.match(observed.upload.raw, /测试文档内容/); assert.match(observed.upload.raw, /main-business-kb/); assert.doesNotMatch(observed.upload.raw, /运营手册|运营部|资料负责人|weibo-only-kb|微博知识库|平台专属|微博业务|platform-only|WEIBO|\"platformCode\"/);
  const draftCreated = await request(base, '/api/material-knowledge-drafts', { method: 'POST', body: JSON.stringify({ materialSha256: 'd'.repeat(64), materialFilename: '服务介绍.mp4', materialPath: 'D:/materials/service.mp4', title: '社区服务介绍', summary: '视频介绍社区服务。', keyFacts: ['可到服务点咨询'], faqs: [{ question: '如何咨询？', answer: '可到服务点咨询。' }], uncertainFacts: ['开放时间待确认'], keywords: ['社区服务'], contentMarkdown: '# 社区服务介绍\n\n可到服务点咨询。', confidence: 0.9, generatorVersion: 'video-knowledge-test' }) });
  assert.equal(draftCreated.response.status, 201, JSON.stringify(draftCreated.data));
  assert.equal(draftCreated.data.draft.status, 'PENDING_CONFIRMATION');
  const draftId = draftCreated.data.draft.id;
  const drafts = await request(base, '/api/material-knowledge-drafts'); assert.equal(drafts.data.drafts.length, 1); assert.equal(drafts.data.drafts[0].materialFilename, '服务介绍.mp4');
  const draftUpdated = await request(base, `/api/material-knowledge-drafts/${draftId}`, { method: 'PUT', body: JSON.stringify({ title: '社区服务办理说明', contentMarkdown: '# 社区服务办理说明\n\n请到服务点咨询。' }) });
  assert.equal(draftUpdated.data.draft.title, '社区服务办理说明');
  const draftImported = await request(base, `/api/material-knowledge-drafts/${draftId}/import`, { method: 'POST', body: '{}' });
  assert.equal(draftImported.response.status, 202, JSON.stringify(draftImported.data));
  assert.equal(draftImported.data.draft.status, 'IMPORTED');
  assert.equal(draftImported.data.draft.ragDocumentId, 'doc-1');
  assert.match(observed.upload.raw, /社区服务办理说明/);
  assert.match(observed.upload.raw, /main-business-kb/);
  const pendingDrafts = await request(base, '/api/material-knowledge-drafts'); assert.equal(pendingDrafts.data.drafts.length, 0);
  const allDrafts = await request(base, '/api/material-knowledge-drafts?includeImported=true'); assert.equal(allDrafts.data.drafts.length, 1);

    const document = await request(base, '/api/rag/documents/doc-1?version=2'); assert.equal(document.data.document.status, 'READY_FOR_TEST');
  const releases = await request(base, '/api/rag/releases?knowledgeBaseId=bilibili-only-kb'); assert.equal(releases.data.active.release_id, 'release-active'); assert.equal(observed.releaseKnowledgeBaseId, 'main-business-kb');
  const releaseDocuments = await request(base, '/api/rag/releases/release-active/documents');
  assert.equal(releaseDocuments.response.status, 200, JSON.stringify(releaseDocuments.data));
  assert.deepEqual(releaseDocuments.data.documents, [{ documentId: 'doc-1', documentVersion: 2, filename: 'manual.txt', uploadedAt: '2026-08-28T00:00:00Z' }]);
  assert.equal(observed.releaseDocumentVersion, '2');
  assert.doesNotMatch(JSON.stringify(releaseDocuments.data), /不得返回的第一段正文|不得返回的第二段正文|chunk_id|\"text\"/);
  const release = await request(base, '/api/rag/releases', { method: 'POST', body: JSON.stringify({ knowledgeBaseId: 'wechat-channels-only-kb', testSessionId: 'test-session-1', candidateDocuments: [{ documentId: 'doc-1', documentVersion: 2 }], publishNote: '运营验证通过' }) }); assert.equal(release.response.status, 202); assert.equal(observed.release.testSessionId, 'test-session-1'); assert.equal(observed.release.publishedBy, 'admin');
  const releaseStatus = await request(base, '/api/rag/releases/release-new'); assert.equal(releaseStatus.data.release.status, 'PUBLISHED');
  const rollback = await request(base, '/api/rag/releases/release-active/rollback', { method: 'POST', body: JSON.stringify({ note: '测试回滚' }) }); assert.equal(rollback.data.release.status, 'PUBLISHED'); assert.equal(observed.rollback.operatorId, 'admin');

  const options = await request(base, '/api/xiaozhi/options'); assert.equal(options.data.options.backend, 'RAG'); assert.equal(options.data.options.ragDocuments[0].documentVersion, 2);
  const session = await request(base, '/api/xiaozhi/sessions', { method: 'POST', body: JSON.stringify({ scope: 'pre_release', candidateDocuments: [{ documentId: 'doc-1', documentVersion: 2 }, { documentId: 'doc-1', documentVersion: 2 }], selectedDocumentId: 'doc-1', selectedDocumentVersion: 2 }) });
  const sessionId = session.data.session.id;
  assert.deepEqual(session.data.session.candidateDocuments, [{ documentId: 'doc-1', documentVersion: 2 }]);
  const chat = await request(base, '/api/xiaozhi/chat', { method: 'POST', body: JSON.stringify({ sessionId, content: '测试问题', scope: 'pre_release', selectedDocumentId: 'doc-1', selectedDocumentVersion: 2 }) });
  assert.equal(chat.data.replyText, '这是来自待测文档的答案。'); assert.equal(chat.data.approvalDecision, 'ENABLED'); assert.deepEqual(observed.testSession.candidateDocuments, [{ documentId: 'doc-1', documentVersion: 2 }]);
  const publishedChat = await request(base, '/api/xiaozhi/chat', { method: 'POST', body: JSON.stringify({ sessionId, content: '测试正式版本', scope: 'published' }) });
  assert.equal(publishedChat.response.status, 200, JSON.stringify(publishedChat.data)); assert.equal(publishedChat.data.session.scope, 'published'); assert.deepEqual(publishedChat.data.session.candidateDocuments, []); assert.equal(publishedChat.data.session.selectedDocumentId, null); assert.deepEqual(observed.testSession.candidateDocuments, []);
  const decision = await request(base, `/api/xiaozhi/sessions/${sessionId}/answers/answer-1/decision`, { method: 'PUT', body: JSON.stringify({ decision: 'DISABLED', reasonCode: 'ANSWER_INACCURATE', reason: '答案不准确' }) }); assert.equal(decision.data.answer.decision, 'DISABLED'); assert.equal(decision.data.answer.decisionVersion, 2);
  const history = await request(base, `/api/xiaozhi/sessions/${sessionId}/answers/answer-1/history`); assert.equal(history.data.history.length, 2);

  await t.test('小智连续提问只向 RAG 传最近三轮完整问答，关闭上下文时不传历史', async () => {
    const created = await request(base, '/api/xiaozhi/sessions', { method: 'POST', body: JSON.stringify({ scope: 'published', contextEnabled: true }) });
    const historySessionId = created.data.session.id;
    for (let index = 1; index <= 5; index += 1) {
      const result = await request(base, '/api/xiaozhi/chat', { method: 'POST', body: JSON.stringify({ sessionId: historySessionId, content: `小智上下文问题${index}` }) });
      assert.equal(result.response.status, 200, JSON.stringify(result.data));
    }
    assert.deepEqual(observed.testQuery.context.map(item => [item.role, item.text]), [
      ['USER', '小智上下文问题2'], ['ASSISTANT', '这是来自待测文档的答案。'],
      ['USER', '小智上下文问题3'], ['ASSISTANT', '这是来自待测文档的答案。'],
      ['USER', '小智上下文问题4'], ['ASSISTANT', '这是来自待测文档的答案。']
    ]);
    await request(base, '/api/xiaozhi/chat', { method: 'POST', body: JSON.stringify({ sessionId: historySessionId, content: '独立问题', contextEnabled: false }) });
    assert.deepEqual(observed.testQuery.context, []);
  });

  const noAnswer = { result: 'NO_ANSWER', answer: null, reasonCode: 'INSUFFICIENT_EVIDENCE', grounding: { confidence: 0.85, sourceReferences: [] }, sourceReferences: [] };
  const createChat = async () => {
    const created = await request(base, '/api/xiaozhi/sessions', { method: 'POST', body: JSON.stringify({ scope: 'published', contextEnabled: true }) });
    return async (content, settings = {}) => {
      const result = await request(base, '/api/xiaozhi/chat', { method: 'POST', body: JSON.stringify({ sessionId: created.data.session.id, content, ...settings }) });
      assert.equal(result.response.status, 200, JSON.stringify(result.data));
      return result.data;
    };
  };
  await t.test('小智对缺少业务名称的申请问题先引导，补充业务后保留原问题继续作答', async () => {
    try {
      testQueryResult = noAnswer;
      const chat = await createChat();
      const queryBeforeGuidance = observed.testQuery.requestId;
      const guidance = await chat('怎么申请');
      assert.equal(guidance.decision, 'KNOWLEDGE_GAP_GUIDANCE');
      assert.match(guidance.replyText, /哪项业务/);
      assert.match(guidance.replyText, /申请流程/);
      assert.doesNotMatch(guidance.replyText, /INSUFFICIENT_EVIDENCE|未找到可靠知识依据/);
      assert.equal(guidance.responseMode, 'BUSINESS_CLARIFICATION');
      assert.equal(guidance.guidanceAttempt, 1);
      assert.equal(guidance.confidence, 0);
      assert.equal(guidance.handoffOffered, false);
      assert.equal(observed.testQuery.requestId, queryBeforeGuidance, '缺少业务名称时由外层先引导，不交给 RAG 猜测');

      const applicationAnswer = '澳车北上可通过官方APP或官网申请，先实名注册，再按要求提交车辆资料。';
      testQueryResult = { result: 'ANSWERED', answer: { text: applicationAnswer } };
      const answered = await chat('澳车北上');
      assert.equal(answered.replyText, applicationAnswer);
      assert.equal(answered.decision, 'RAG_ANSWERED');
      assert.equal(answered.guidanceAttempt, 0);
      assert.deepEqual(observed.testQuery.context.map(item => [item.role, item.text]), [
        ['USER', '怎么申请'], ['ASSISTANT', guidance.replyText]
      ]);
      const followup = await chat('怎么申请');
      assert.equal(followup.replyText, applicationAnswer);
      assert.equal(followup.contextUsed, true);
      assert.ok(observed.testQuery.context.some(item => item.role === 'USER' && item.text === '澳车北上'));

      testQueryResult = noAnswer;
      assert.equal((await chat('其他业务怎么申请')).guidanceAttempt, 1, '有可靠答案后重新计算引导次数');
      const isolatedChat = await createChat();
      const queryBeforeIsolated = observed.testQuery.requestId;
      assert.equal((await isolatedChat('怎么申请')).guidanceAttempt, 1);
      assert.equal(observed.testQuery.requestId, queryBeforeIsolated);
    } finally { testQueryResult = null; }
  });
  await t.test('小智保留关键词、补全后的追问和检索分数，检索分数不改变无答案引导', async () => {
    const queryAnalysis = { originalQuestion: 'App在哪？', resolvedQuestion: '澳车北上 APP 下载入口', keywords: ['澳车北上', 'APP', '下载', '获取入口'], contextUsed: true };
    try {
      testQueryResult = { ...noAnswer, meta: { queryAnalysis }, grounding: { confidence: 0.84, confidenceType: 'DIAGNOSTIC_NOT_CALIBRATED_PROBABILITY', sourceReferences: [] } };
      const chat = await createChat();
      const result = await chat('App在哪？');
      assert.equal(result.confidence, 0, '无可靠答案时不能把检索分数当作自动回复许可');
      assert.equal(result.retrievalConfidence, 0.84);
      assert.deepEqual(result.queryAnalysis, queryAnalysis);
      assert.equal(result.contextUsed, true);
      assert.equal(result.ragStatus, 'NO_ANSWER');
      assert.equal(result.decision, 'RAG_NEED_CLARIFICATION');
      assert.equal(result.guidanceAttempt, 1);
      const outer = await (await createChat())('怎么申请');
      assert.equal(outer.retrievalConfidence, null, '尚未检索时没有检索分数');
    } finally { testQueryResult = null; }
  });

  await t.test('连续缺少申请业务时不允许 RAG 猜测主题，第三轮直接转人工并停止自动应答', async () => {
    try {
      testQueryResult = { result: 'ANSWERED', answer: { text: '错误猜测的人才公寓申请流程。' } };
      const chat = await createChat();
      for (let attempt = 1; attempt <= 4; attempt += 1) {
        const result = await chat('怎么申请');
        assert.equal(result.guidanceAttempt, Math.min(attempt, 3));
        assert.equal(result.maxGuidanceAttempts, 3);
        assert.equal(result.handoffOffered, false);
        assert.equal(result.handoffRequested, attempt >= 3);
        assert.equal(result.decision, attempt >= 3 ? 'KNOWLEDGE_GUIDANCE_LIMIT' : 'KNOWLEDGE_GAP_GUIDANCE');
        if (attempt >= 3) {
          assert.equal(result.action, 'HANDOFF');
          assert.match(result.replyText, /转人工/);
          assert.doesNotMatch(result.replyText, /请回复|请再.*说明/);
        }
      }
      const queryBeforeFollowup = observed.testQuery.requestId;
      testQueryResult = { result: 'ANSWERED', answer: { text: '不应在人工接管的测试会话里继续自动回答。' } };
      const humanFollowup = await chat('澳车北上');
      assert.equal(humanFollowup.action, 'HANDOFF');
      assert.equal(observed.testQuery.requestId, queryBeforeFollowup);
      testQueryResult = noAnswer;
      const fresh = await chat('怎么申请', { contextEnabled: false });
      assert.equal(fresh.guidanceAttempt, 1);
      assert.equal(fresh.handoffOffered, false);
      assert.equal(fresh.handoffRequested, false);
      assert.equal(observed.testQuery.requestId, queryBeforeFollowup);
    } finally { testQueryResult = null; }
  });
  await t.test('小智不会把超长拒答误判为缺少业务信息，也不截断统一测试的可靠长答案', async () => {
    try {
      const chat = await createChat();
      testQueryResult = { ...noAnswer, reasonCode: 'ANSWER_TOO_LONG' };
      const rejected = await chat('澳车北上怎么申请');
      assert.equal(rejected.decision, 'RAG_REPLY_TOO_LONG');
      assert.equal(rejected.guidanceAttempt, 0);
      assert.doesNotMatch(rejected.replyText, /哪项业务/);
      const text = '完整申请流程。'.repeat(100);
      testQueryResult = { result: 'ANSWERED', answer: { text } };
      assert.equal((await chat('完整申请流程')).action, 'HANDOFF', '超长拒答触发人工接管后不得自动恢复');
      const answered = await (await createChat())('完整申请流程');
      assert.equal(answered.replyText, text);
      assert.equal(answered.decision, 'RAG_ANSWERED');
    } finally { testQueryResult = null; }
  });

  const browser = await chromium.launch({ headless: true, executablePath: installedChromePath() });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.goto(base);
  testQueryResult = { ...noAnswer, grounding: { confidence: 0.84, sourceReferences: [] }, meta: {
    queryAnalysis: { keywords: ['澳车北上', 'APP', '下载', '获取入口'], resolvedQuestion: '澳车北上 APP 下载入口', contextUsed: true }
  } };
  await openWorkspacePage(page, 'xiaozhi');
  await page.locator('#xiaozhiScope').selectOption('published');
  await page.locator('#xiaozhiInput').fill('App在哪？');
  await page.locator('#xiaozhiSend').click();
  await page.locator('.xiaozhi-diagnostic summary').click();
  const diagnosticText = await page.locator('.xiaozhi-diagnostic').innerText();
  assert.match(diagnosticText, /知识匹配参考分.*84%/);
  assert.match(diagnosticText, /提取关键词.*澳车北上.*APP.*下载/);
  assert.match(diagnosticText, /实际检索问题.*澳车北上 APP 下载入口/);
  assert.match(diagnosticText, /分数来源.*RAG/);
  assert.doesNotMatch(diagnosticText, /置信度.*0%/);
  testQueryResult = null;
  await openWorkspacePage(page, 'knowledge');
  await page.getByRole('heading', { name: '知识库发布版本' }).waitFor();
  const detailsButton = page.getByRole('button', { name: '详情', exact: true });
  assert.equal(await detailsButton.count(), 1);
  await detailsButton.click();
  const dialog = page.getByRole('dialog', { name: '发布版本详情' });
  await dialog.waitFor();
  assert.match(await dialog.innerText(), /运营手册|manual\.txt/);
  assert.match(await dialog.innerText(), /上传日期|发布日期/);
  assert.doesNotMatch(await dialog.innerText(), /不得返回的第一段正文|不得返回的第二段正文/);
  await page.setViewportSize({ width: 390, height: 844 });
  const dialogBounds = await dialog.boundingBox();
  assert.ok(dialogBounds && dialogBounds.x >= 0 && dialogBounds.x + dialogBounds.width <= 390, JSON.stringify(dialogBounds));
  await dialog.getByRole('button', { name: '关闭', exact: true }).last().click();
  await page.setViewportSize({ width: 1440, height: 1000 });

  const pending = { documentId: 'doc-video', documentVersion: 1, title: '澳车北上测试文案', filename: '澳车北上测试文案.md', status: 'READY_FOR_TEST', createdAt: '2026-09-10T00:00:00Z' };
  const newVersion = { ...pending, documentVersion: 2 };
  const processing = { ...pending, documentId: 'doc-processing', title: '正在解析的视频资料', filename: '正在解析的视频资料.md', status: 'PROCESSING' };
  const documents = [pending, newVersion, processing];
  const releasesForUi = [];
  let activeForUi = null;
  await page.route('**/api/rag/documents', route => route.fulfill({ json: { documents } }));
  await page.route('**/api/rag/documents/*/chunks?*', route => route.fulfill({ json: { chunks: [{ text: '澳车北上申请流程' }] } }));
  await page.route('**/api/rag/releases', async route => {
    if (route.request().method() === 'POST') {
      const request = route.request().postDataJSON();
      releasesForUi.unshift({ releaseId: 'release-video', status: 'BUILDING', candidateDocuments: request.candidateDocuments, createdAt: '2026-09-10T00:01:00Z' });
      return route.fulfill({ status: 202, json: { release: releasesForUi[0] } });
    }
    return route.fulfill({ json: { releases: releasesForUi, active: activeForUi } });
  });
  await page.route('**/api/rag/releases/release-video/members', route => route.fulfill({ json: { members: [{ document_id: 'doc-video', document_version: 1, chunk_id: 'video-chunk' }] } }));
  await page.route('**/api/xiaozhi/options', route => route.fulfill({ json: { options: { backend: 'RAG', ragDocuments: documents.filter(item => item.status === 'READY_FOR_TEST') } } }));
  const card = (id, version = 1) => page.locator('.rag-document-card').filter({ has: page.locator(`.rag-document-content[data-document-id="${id}"][data-version="${version}"]`) });
  const progress = page.locator('#ragDocumentProgress');

  await t.test('查看内容和点击卡片会切换到对应文档的名称与进度', async () => {
    await page.locator('#ragReleaseRefresh').click();
    await card('doc-video').locator('.rag-document-content').click();
    await page.locator('.rag-content-dialog').waitFor();
    assert.match(await progress.innerText({ timeout: 3000 }), /澳车北上测试文案\.md/);
    assert.match(await progress.locator('.is-active').innerText(), /小智测试/);
    await page.locator('.rag-content-close').click();
    await card('doc-processing').locator('p').click();
    assert.match(await progress.innerText(), /正在解析的视频资料\.md/);
    assert.match(await progress.locator('.is-active').innerText(), /解析处理/);
  });

  await t.test('小智提交发布后标记已测试，刷新保留且不影响其他版本，构建失败与成功显示真实进度', async () => {
    const closeContent = page.locator('.rag-content-close');
    if (await closeContent.count()) await closeContent.click();
    await card('doc-video').locator('.rag-document-test').click();
    await page.locator('#xiaozhiInput').fill('澳车北上怎么申请？');
    await page.locator('#xiaozhiSend').click();
    await page.locator('#xiaozhiPublish').click();
    await page.locator('.xiaozhi-publish-confirm').click();
    await page.getByRole('heading', { name: '知识库发布版本' }).waitFor();
    assert.equal(await card('doc-video').locator('.badge').innerText(), '已测试');
    assert.equal(await card('doc-video', 2).locator('.badge').innerText(), '待测试');
    assert.match(await progress.innerText(), /澳车北上测试文案\.md/);
    assert.match(await progress.locator('.is-active').innerText(), /正式发布/);
    assert.equal(await progress.locator('.is-complete').count(), 4);

    await page.reload();
    await openWorkspacePage(page, 'knowledge');
    await card('doc-video').waitFor();
    assert.equal(await card('doc-video').locator('.badge').innerText(), '已测试');
    await card('doc-video').locator('p').click();
    releasesForUi[0].status = 'FAILED';
    await page.locator('#ragReleaseRefresh').click();
    await page.waitForFunction(() => document.querySelector('#ragDocumentProgress')?.textContent.includes('发布失败'));
    assert.equal(await progress.locator('.is-complete').count(), 4);
    assert.equal(await card('doc-video').locator('.badge').innerText(), '已测试');

    releasesForUi[0].status = 'PUBLISHED';
    activeForUi = { release_id: 'release-video' };
    await page.locator('#ragReleaseRefresh').click();
    await page.waitForFunction(() => document.querySelectorAll('#ragDocumentProgress .is-complete').length === 5);
    assert.match(await progress.innerText(), /已正式发布/);
    assert.equal(await card('doc-video', 2).locator('.badge').innerText(), '待测试');
    await page.setViewportSize({ width: 390, height: 844 });
    const bounds = await progress.boundingBox();
    assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 390, JSON.stringify(bounds));
    // A release can succeed with base knowledge only after all candidate chunks are disabled.
    await page.route('**/api/rag/releases/release-video/members', route => route.fulfill({ json: { members: [] } }));
    await page.locator('#ragReleaseRefresh').click();
    await page.waitForFunction(() => document.querySelector('#ragDocumentProgress')?.textContent.includes('未包含'));
    assert.equal(await card('doc-video').locator('.badge').innerText(), '已测试');
    assert.equal(await progress.locator('.is-complete').count(), 4, '未进入正式版本的文档不能显示正式发布已完成');
    assert.doesNotMatch(await progress.innerText(), /曾正式发布|当前用户端生效/);
  });
});
