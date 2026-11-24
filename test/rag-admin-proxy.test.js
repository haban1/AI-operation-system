import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startServer, stopChild, cleanupDir, jsonRequest } from './helpers/runtime.js';

// 2026-11-10 起知识库只保留文件自动生效（docs/knowledge-files.md）：旧文档/发布/回滚/小智
// 管理接口已下线，它们返回 404 由 test/knowledge-files.test.js 覆盖。本文件覆盖仍由业务后端
// 代理的 RAG 管理面：系统状态，以及素材知识草稿确认后经文件接口入库。
const env = {
  AUTH_ENABLED: 'false', AGENT_SHARED_TOKEN: '', RAG_AUTO_START: 'false', RAG_ADMIN_ENABLED: 'true',
  RAG_FORMAL_ROUTING_ENABLED: 'false', RAG_TIMEOUT_MS: '3000', OPERATIONS_ANALYTICS_ENABLED: 'false',
  LOGIN_STATUS_POLL_ENABLED: 'false', ISSUE_DIAGNOSIS_ENABLED: 'false', INSTANCE_LOCK_ENABLED: 'false'
};

test('业务后端代理 RAG 状态，素材知识草稿确认后经文件接口自动生效入库', async t => {
  const calls = [];
  let failUpload = false;
  const rag = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString('utf8');
    const url = new URL(req.url, 'http://rag.local');
    calls.push({ method: req.method, pathname: url.pathname, contentType: req.headers['content-type'], raw });
    const json = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
    if (req.method === 'GET' && url.pathname === '/rag-admin-api/v1/system/status') return json(200, { status: 'READY', providers: { embedding: 'mock' } });
    if (req.method === 'POST' && url.pathname === '/rag-admin-api/v1/files') {
      if (failUpload) return json(503, { error: { code: 'RAG_NOT_READY', message: 'index busy' } });
      return json(202, { documentId: 'doc-draft', documentVersion: 1, filename: 'draft.md', status: 'PROCESSING', usageStatus: 'PROCESSING' });
    }
    return json(404, { error: { code: 'NOT_FOUND', message: `${req.method} ${url.pathname}` } });
  });
  await new Promise(resolve => rag.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => rag.close(resolve)));
  const runtime = await startServer({ env: { ...env, RAG_BASE_URL: `http://127.0.0.1:${rag.address().port}` } });
  t.after(async () => { await stopChild(runtime.child); cleanupDir(runtime.dir); });

  const status = await jsonRequest(runtime.base, '/api/rag/status');
  assert.equal(status.response.status, 200, status.text);
  assert.equal(status.data.rag.status, 'READY');
  assert.equal(status.data.rag.knowledgeBaseId, 'main-business-kb');

  const draftBody = (sha, title) => ({
    materialSha256: sha.repeat(64), materialFilename: '服务介绍.mp4', materialPath: 'D:/materials/service.mp4', title,
    summary: '视频介绍社区服务。', keyFacts: ['可到服务点咨询'], faqs: [{ question: '如何咨询？', answer: '可到服务点咨询。' }],
    uncertainFacts: ['开放时间待确认'], keywords: ['社区服务'], contentMarkdown: `# ${title}\n\n可到服务点咨询。`, confidence: 0.9,
    generatorVersion: 'video-knowledge-test', knowledgeBaseId: 'weibo-only-kb', platform: 'WEIBO'
  });
  const created = await jsonRequest(runtime.base, '/api/material-knowledge-drafts', { method: 'POST', body: draftBody('d', '社区服务介绍') });
  assert.equal(created.response.status, 201, created.text);
  assert.equal(created.data.draft.status, 'PENDING_CONFIRMATION');
  const draftId = created.data.draft.id;
  assert.equal(calls.filter(call => call.pathname.startsWith('/rag-admin-api/v1/files')).length, 0, '草稿未确认前不入库');
  const listed = await jsonRequest(runtime.base, '/api/material-knowledge-drafts');
  assert.equal(listed.data.drafts.length, 1);
  assert.equal(listed.data.drafts[0].materialFilename, '服务介绍.mp4');
  const updated = await jsonRequest(runtime.base, `/api/material-knowledge-drafts/${draftId}`, { method: 'PUT', body: { title: '社区服务办理说明', contentMarkdown: '# 社区服务办理说明\n\n请到服务点咨询。' } });
  assert.equal(updated.data.draft.title, '社区服务办理说明');

  const imported = await jsonRequest(runtime.base, `/api/material-knowledge-drafts/${draftId}/import`, { method: 'POST', body: {} });
  assert.equal(imported.response.status, 202, imported.text);
  assert.equal(imported.data.draft.status, 'IMPORTED');
  assert.equal(imported.data.draft.ragDocumentId, 'doc-draft');
  const uploads = calls.filter(call => call.pathname.startsWith('/rag-admin-api/v1/files'));
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0].method, 'POST', '新草稿创建新文件，不覆盖已有文件');
  assert.match(uploads[0].contentType, /^multipart\/form-data; boundary=/);
  assert.match(uploads[0].raw, /请到服务点咨询/, '入库的是确认后的编辑内容');
  assert.match(uploads[0].raw, /AI知识草稿-社区服务办理说明\.md/);
  assert.match(uploads[0].raw, /"knowledgeBaseId":"main-business-kb"/, '知识范围由服务端固定');
  assert.doesNotMatch(uploads[0].raw, /weibo-only-kb|WEIBO|testSessionId|candidateDocuments|release/);
  assert.ok(!calls.some(call => /test-sessions|releases|\/documents/.test(call.pathname)), '不再创建测试会话、发布任务或旧文档');

  const again = await jsonRequest(runtime.base, `/api/material-knowledge-drafts/${draftId}/import`, { method: 'POST', body: {} });
  assert.equal(again.response.status, 200, again.text);
  assert.equal(again.data.document.documentId, 'doc-draft');
  assert.equal(calls.filter(call => call.pathname.startsWith('/rag-admin-api/v1/files')).length, 1, '重复确认幂等，不重复上传');
  assert.equal((await jsonRequest(runtime.base, '/api/material-knowledge-drafts')).data.drafts.length, 0);
  assert.equal((await jsonRequest(runtime.base, '/api/material-knowledge-drafts?includeImported=true')).data.drafts.length, 1);

  const second = await jsonRequest(runtime.base, '/api/material-knowledge-drafts', { method: 'POST', body: draftBody('e', '入库失败的草稿') });
  failUpload = true;
  const failed = await jsonRequest(runtime.base, `/api/material-knowledge-drafts/${second.data.draft.id}/import`, { method: 'POST', body: {} });
  assert.ok(failed.response.status >= 500, failed.text);
  const afterFailure = (await jsonRequest(runtime.base, '/api/material-knowledge-drafts')).data.drafts.find(draft => draft.id === second.data.draft.id);
  assert.ok(afterFailure, '入库失败的草稿仍留在待确认列表，可重试');
  assert.notEqual(afterFailure.status, 'IMPORTED');
  assert.equal(afterFailure.ragDocumentId ?? null, null);
});
