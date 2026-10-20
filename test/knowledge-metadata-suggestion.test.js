import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-metadata-'));
process.env.DATABASE_PATH = path.join(dir, 'test.db');
process.env.QWEN_MODE = 'mock';
process.env.LOCAL_AGENT_AUTO_START = 'false';
process.env.AUTO_COLLECT_ENABLED = 'false';

const dbModule = await import('../src/db.js');
const { now, row, run, db } = dbModule;
const { suggestKnowledgeMetadata } = await import('../src/services/knowledge-metadata-suggestion.js');
const { previewKnowledgeImport } = await import('../src/services/knowledge-import.js');
const { getKnowledgeImportPreview, queueKnowledgeImportMetadataEnrichment } = await import('../src/services/knowledge-import-enrichment.js');
const { searchKnowledge } = await import('../src/services/knowledge.js');

async function waitForBatch(batchId) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const preview = getKnowledgeImportPreview(batchId);
    if (['COMPLETED', 'FAILED', 'PARTIAL_FAILED'].includes(preview?.enrichment?.status)) return preview;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('AI 元数据推荐任务等待超时');
}

test.after(() => {
  try { db.close(); } catch {}
  fs.rmSync(dir, { recursive: true, force: true });
});

test('千问知识元数据推荐会限制大类并拦截过宽或冲突关键词', async () => {
  const stamp = now();
  run(`INSERT INTO knowledge(question,answer,keywords,status,version,source,review_status,category,subcategory,created_at,updated_at)
    VALUES(?,?,?,'PUBLISHED',1,'MANUAL','APPROVED','公共知识库','费用缴费',?,?)`,
  '参加社区活动是否收费？', '活动免费。', '是否收费,活动费用', stamp, stamp);

  const result = await suggestKnowledgeMetadata({
    question: '亲子活动要不要钱？',
    answer: '本次亲子活动不收取费用。',
    platformCode: 'bilibili',
    allowedCategories: ['公共知识库', 'B站知识库'],
    preferredCategory: 'B站知识库'
  });

  assert.equal(result.category.name, 'B站知识库');
  assert.ok(result.keywords.length >= 3);
  assert.ok(result.keywords.every(item => item.text !== '活动'));
  const conflict = result.keywords.find(item => item.text === '是否收费');
  assert.equal(conflict?.conflict, true);
  assert.equal(conflict?.selected, false);
});

test('文件只填写问题答案时后台会补齐AI推荐并保留来源信息', async () => {
  const csv = '\uFEFF"标准问题","标准答案"\r\n"活动可以带小孩吗？","可以带孩子参加，现场请由监护人照看。"';
  const preview = await previewKnowledgeImport({ fileName: '知识问答.csv', base64: Buffer.from(csv, 'utf8').toString('base64') });
  assert.equal(preview.items[0].aiStatus, 'QUEUED');
  assert.equal(preview.items[0].categorySource, 'DEFAULT');

  queueKnowledgeImportMetadataEnrichment(preview.batchId);
  const enriched = await waitForBatch(preview.batchId);
  assert.equal(enriched.enrichment.status, 'COMPLETED');
  assert.ok(['COMPLETED', 'FALLBACK'].includes(enriched.items[0].aiStatus));
  assert.ok(enriched.items[0].keywordOptions.length > 0);
  assert.ok(enriched.items[0].keywords.includes('孩子') || enriched.items[0].keywords.includes('小孩'));
  assert.ok(['AI', 'RULE'].includes(enriched.items[0].keywordsSource));
  assert.equal(row('SELECT id FROM knowledge_import_batches WHERE id=?', preview.batchId).id, preview.batchId);
});

test('并发补全多条知识时不会互相覆盖推荐结果', async () => {
  const csv = '\uFEFF"标准问题","标准答案"\r\n"活动可以带小孩吗？","可以带孩子参加，现场请由监护人照看。"\r\n"社区活动收费吗？","本次活动免费，不收取报名费用。"\r\n"活动在哪里举办？","活动在天河社区服务中心举办。"';
  const preview = await previewKnowledgeImport({ fileName: '并发知识问答.csv', base64: Buffer.from(csv, 'utf8').toString('base64') });
  assert.equal(preview.items.length, 3);
  queueKnowledgeImportMetadataEnrichment(preview.batchId);
  const enriched = await waitForBatch(preview.batchId);
  assert.equal(enriched.enrichment.status, 'COMPLETED');
  assert.equal(enriched.enrichment.completed, 3);
  assert.equal(enriched.items.filter(item => ['COMPLETED', 'FALLBACK'].includes(item.aiStatus)).length, 3);
  assert.ok(enriched.items.every(item => Array.isArray(item.keywordOptions) && item.keywordOptions.length > 0));
});

test('Web 知识库不再暴露待补充知识模块或请求知识缺口接口', () => {
  const app = fs.readFileSync(path.resolve(import.meta.dirname, '../public/app.js'), 'utf8');
  assert.doesNotMatch(app, /待补充知识/);
  assert.doesNotMatch(app, /data-knowledge-view="gaps"/);
  assert.doesNotMatch(app, /renderKnowledgeGaps/);
  assert.doesNotMatch(app, /knowledgeGapStatus/);
  assert.equal(app.includes('/api/knowledge-gaps'), false);
});



test('Web 使用原知识上传界面接入统一知识库，不展示 RAG 专用字段或旧分类入口', () => {
  const app = fs.readFileSync(path.resolve(import.meta.dirname, '../public/app.js'), 'utf8');
  const ragView = app.slice(app.indexOf('async function renderRagKnowledge()'), app.indexOf('async function renderKnowledge()', app.indexOf('async function renderRagKnowledge()')));
  assert.match(app, /<b>知识库内容<\/b><small>资料上传、测试与发布<\/small>/);
  assert.match(app, /<b>转人工说法<\/b>/);
  assert.match(app, /class="knowledge-upload-form"/);
  assert.match(app, /id="ragUploadZone" class="knowledge-file-picker"/);
  assert.doesNotMatch(app, /<b>统一 RAG<\/b>/);
  assert.doesNotMatch(app, /<b>历史知识<\/b>/);
  assert.doesNotMatch(app, /data-knowledge-view="library"/);
  assert.doesNotMatch(ragView, /name="title"|name="sourceDepartment"|name="sourceOwner"|name="category"|class="rag-upload-form"/);
  assert.match(app, /ragUploadStage/);
  assert.match(app, /ragCurrentDocumentId/);
  assert.match(ragView, /isLegacyPlatformMigrationDocument/);
  assert.match(ragView, /rag-document-content/);
  assert.match(ragView, /rag-document-delete/);
  assert.match(app, /\/chunks/);
  assert.doesNotMatch(ragView, /const currentStep=isProcessing\?1:hasTestable\?2:activeId\?4:0/);
});

test('旧本地知识兼容检索不再按平台大类隔离', () => {
  const stamp = now();
  const marker = '跨平台统一知识答案-' + Date.now();
  const id = Number(run(`INSERT INTO knowledge(question,answer,keywords,status,version,source,review_status,category,subcategory,created_at,updated_at)
    VALUES(?,?,?,'PUBLISHED',1,'MANUAL','APPROVED','抖音知识库','统一检索',?,?)`,
  marker, '这条知识可供全部平台共同使用。', '跨平台,统一知识', stamp, stamp).lastInsertRowid);

  for (const platformCode of ['douyin', 'weibo', 'wechat_channels', 'bilibili', 'xiaohongshu']) {
    const matches = searchKnowledge(marker, 3, platformCode);
    assert.equal(matches[0]?.id, id, `${platformCode} 应命中同一条知识`);
  }

  run('DELETE FROM knowledge WHERE id=?', id);
});
