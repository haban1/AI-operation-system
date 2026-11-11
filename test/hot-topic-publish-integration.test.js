import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import ffmpeg from '@ffmpeg-installer/ffmpeg';
import { precheckMaterial } from '../agent/precheck.js';
import { buildMockAiReview } from '../src/services/ai-compliance.js';
import { startServer, stopChild, tempRuntimeDir, cleanupDir, jsonRequest } from './helpers/runtime.js';

const narration = '这条热点视频介绍如何查找公开资料、核对资料来源和记录查证时间。查阅公开信息时应保留原始出处，并区分事实与创作表述。';
const privateQuote = '原始资料中的独有引文需要核对来源以及对应的资料采集时间。';
const title = '公开资料查证与来源记录';

function jsonFile(filename, value) {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, JSON.stringify(value));
}

async function fixture(t, { decode = 'passed' } = {}) {
  const dir = tempRuntimeDir('hot-topic-publish-');
  let runtime, db;
  t.after(async () => { db?.close(); await stopChild(runtime?.child); cleanupDir(dir); });
  const signalRoot = path.join(dir, 'signal');
  const runDir = path.join(signalRoot, 'runs', 'run-complete');
  const scriptPath = path.join(runDir, 'script.json');
  jsonFile(scriptPath, {
    title, summary: '创作工具的宣传摘要不应覆盖实际旁白。', source_kind: 'topic',
    created_at: '2026-11-02T03:00:00Z',
    scenes: [{ narration, sourceIds: ['source-one', 'source-two'], visual: '不应进入知识的镜头设计指令。' }],
    sources: [
      { id: 'source-one', title: '资料来源一', url: 'https://example.org/public-evidence' },
      { id: 'source-two', title: '资料来源二', url: 'https://example.org/second-evidence' },
    ],
  });
  jsonFile(path.join(runDir, 'validation.json'), { full_decode: decode });
  jsonFile(path.join(runDir, 'evidence.json'), {
    kind: 'topic', collected_at: '2026-11-02T02:00:00Z',
    sources: [{ id: 'source-one', url: 'https://example.org/public-evidence' }],
    documents: [{ id: 'source-one', text: privateQuote }],
    brief: { claims: [{ evidence: [{ source_id: 'source-one', quote: privateQuote }] }] },
  });
  const sourceVideo = path.join(runDir, 'video.mp4');
  execFileSync(ffmpeg.path, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=640x360:r=25',
    '-t', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', sourceVideo], { timeout: 20_000 });
  runtime = await startServer({ dir, env: {
    RAG_BASE_URL: '', RAG_AUTO_START: 'false', RAG_ADMIN_ENABLED: 'false',
    CONTENT_LIBRARY_DIR: path.join(dir, 'library'), CONTENT_LIBRARY_SIGNAL_ROOT: signalRoot,
    CONTENT_LIBRARY_EDITING_ROOT: '', CONTENT_LIBRARY_CREATION_ROOT: '', CONTENT_LIBRARY_SEED_ENABLED: 'false',
    AI_AUDIO_CONTENT_AUTO_TRIGGER: 'false', VIDEO_STUDIO_ENABLED: 'false',
  } });
  db = new DatabaseSync(runtime.dbPath);
  db.exec('PRAGMA busy_timeout=15000');
  db.prepare("UPDATE accounts SET login_status='READY' WHERE platform_code='douyin'").run();
  const account = db.prepare("SELECT id FROM accounts WHERE platform_code='douyin' AND enabled=1 LIMIT 1").get();
  assert.ok(account);
  const request = (pathname, options) => jsonRequest(runtime.base, pathname, options);
  const sync = await request('/api/content-library/sync', { method: 'POST', body: {} });
  assert.equal(sync.response.status, 200, sync.text);
  const item = [...sync.data.items, ...sync.data.pendingItems].find(value => value.sourceId === 'run-complete');
  const jobs = () => db.prepare('SELECT * FROM hot_topic_knowledge_jobs ORDER BY id').all();
  const counts = () => ({
    tasks: db.prepare('SELECT COUNT(*) AS n FROM publish_tasks').get().n,
    targets: db.prepare('SELECT COUNT(*) AS n FROM publish_targets').get().n,
    publishes: db.prepare("SELECT COUNT(*) AS n FROM agent_jobs WHERE job_type='PUBLISH'").get().n,
    knowledge: jobs().length,
  });
  const admission = async decision => {
    const result = await request(`/api/content-library/${item.id}/admission`, { method: 'POST', body: { decision } });
    assert.equal(result.response.status, 200, result.text);
    return result;
  };
  const draft = async () => {
    const result = await request(`/api/content-library/${item.id}/publish-draft`);
    assert.equal(result.response.status, 200, result.text);
    return result.data;
  };
  const payload = async (material, overrides = {}) => {
    const result = {
      title: material.title, body: material.body, materialPath: material.materialPath,
      ...(material.id ? { contentLibraryItemId: material.id } : {}),
      targets: [{ platformCode: 'douyin', accountId: account.id }],
      complianceConfirmed: true, managementConfirmed: true, publishMode: 'AUTO', ...overrides,
    };
    result.precheck = await precheckMaterial({ materialPath: result.materialPath, title: result.title, body: result.body, platforms: ['douyin'] });
    assert.notEqual(result.precheck.overall, 'BLOCKED', JSON.stringify(result.precheck));
    return result;
  };
  return { ...runtime, db, request, jobs, counts, item, admission, draft, payload, sourceVideo, scriptPath };
}

test('confirmed automatic material enqueues one private document; drafts, repeated confirmation and duplicate tasks do not', async t => {
  const ctx = await fixture(t);
  assert.ok(ctx.item);
  assert.equal(ctx.jobs().length, 0, 'discovery must not publish knowledge');
  const pendingList = await ctx.request('/api/content-library');
  assert.equal(pendingList.response.status, 200, pendingList.text);
  assert.doesNotMatch(pendingList.text, /hotTopicDocument|documentHash|markdown|questions|原始资料中的独有引文/);
  const unapproved = await ctx.request(`/api/content-library/${ctx.item.id}/publish-draft`);
  assert.equal(unapproved.response.status, 409);
  await ctx.admission('approved');
  await ctx.admission('approved');
  assert.equal(ctx.jobs().length, 0, 'material approval alone must not enqueue knowledge');
  const approvedList = await ctx.request('/api/content-library');
  assert.equal(approvedList.response.status, 200, approvedList.text);
  assert.doesNotMatch(approvedList.text, /hotTopicDocument|documentHash|markdown|questions|原始资料中的独有引文/);
  const draft = await ctx.draft();
  assert.equal(draft.id, ctx.item.id);
  assert.equal(draft.title, title);
  assert.equal(draft.body, narration);
  assert.doesNotMatch(JSON.stringify(draft), /hotTopicDocument|documentHash|markdown|questions|原始资料中的独有引文|不应进入知识的镜头设计/);
  const payload = await ctx.payload(draft, { title: '运营编辑后的资料查证标题', body: '运营修改后的发布正文只用于平台展示，配套知识仍须保留原视频实际旁白和对应来源。' });
  payload.hotTopicDocument = { markdown: '客户端伪造的知识不得采信。' };
  const created = await ctx.request('/api/publish/tasks', { method: 'POST', body: payload });
  assert.equal(created.response.status, 201, created.text);
  assert.equal(ctx.jobs().length, 1);
  const job = ctx.jobs()[0];
  assert.equal(job.task_id, created.data.task.id);
  assert.equal(job.material_id, ctx.item.id);
  assert.equal(job.material_sha256, draft.sha256);
  assert.equal(job.source_id, 'run-complete');
  assert.equal(job.status, 'PENDING', 'unconfigured knowledge service leaves a durable outbox job');
  assert.equal(job.rag_document_id, null);
  const document = JSON.parse(job.document_json);
  assert.equal(document.title, title);
  assert.equal(document.body, narration);
  assert.ok(document.markdown.includes(privateQuote));
  assert.ok(document.markdown.includes('https://example.org/public-evidence'));
  assert.doesNotMatch(job.document_json, /客户端伪造|运营修改后的发布正文|不应进入知识的镜头设计/);
  const duplicate = await ctx.request('/api/publish/tasks', { method: 'POST', body: payload });
  assert.equal(duplicate.response.status, 409, duplicate.text);
  assert.equal(duplicate.data.code, 'PUBLISH_DUPLICATE');
  assert.deepEqual(ctx.counts(), { tasks: 1, targets: 1, publishes: 1, knowledge: 1 });
  // A separately confirmed platform task for the same immutable video/document
  // may exist, but must reuse the existing knowledge operation.
  const second = await ctx.request('/api/publish/tasks', { method: 'POST', body: { ...payload, title: '另一次资料查证内容分享' } });
  assert.equal(second.response.status, 201, second.text);
  assert.equal(ctx.jobs().length, 1);
  assert.equal(ctx.jobs()[0].document_json, job.document_json);
  assert.equal(ctx.jobs()[0].task_id, job.task_id);
});

test('failed generation and rejected material never enqueue knowledge or publish tasks', async t => {
  await t.test('failed media decode is not discovered', async child => {
    const ctx = await fixture(child, { decode: 'failed' });
    assert.equal(ctx.item, undefined);
    assert.deepEqual(ctx.counts(), { tasks: 0, targets: 0, publishes: 0, knowledge: 0 });
  });
  await t.test('a stale draft cannot bypass withdrawn approval', async child => {
    const ctx = await fixture(child);
    await ctx.admission('approved');
    const payload = await ctx.payload(await ctx.draft());
    await ctx.admission('rejected');
    const rejected = await ctx.request('/api/publish/tasks', { method: 'POST', body: payload });
    assert.equal(rejected.response.status, 409, rejected.text);
    assert.equal(rejected.data.code, 'CONTENT_ADMISSION_REQUIRED');
    assert.deepEqual(ctx.counts(), { tasks: 0, targets: 0, publishes: 0, knowledge: 0 });
  });
});

test('blocked AI review, stale bytes and a mismatched library identity do not enqueue', async t => {
  const ctx = await fixture(t);
  await ctx.admission('approved');
  const draft = await ctx.draft();
  const payload = await ctx.payload(draft);
  const review = buildMockAiReview({ title: payload.title, body: payload.body, materialSha256: draft.sha256, sourceType: 'video' });
  const blocked = await ctx.request('/api/publish/tasks', { method: 'POST', body: { ...payload, aiReview: { ...review, overall: 'BLOCKED' } } });
  assert.equal(blocked.response.status, 422, blocked.text);
  assert.equal(blocked.data.code, 'PUBLISH_COMPLIANCE_REJECTED');
  const wrongId = await ctx.request('/api/publish/tasks', { method: 'POST', body: { ...payload, contentLibraryItemId: 'f'.repeat(32) } });
  assert.equal(wrongId.response.status, 409, wrongId.text);
  const bytes = fs.readFileSync(draft.materialPath); bytes[bytes.length - 1] ^= 1;
  fs.writeFileSync(draft.materialPath, bytes);
  const changed = await ctx.request('/api/publish/tasks', { method: 'POST', body: payload });
  assert.equal(changed.response.status, 409, changed.text);
  assert.deepEqual(ctx.counts(), { tasks: 0, targets: 0, publishes: 0, knowledge: 0 });
});

test('enqueue failure rolls back the platform task, targets and publish jobs atomically', async t => {
  const ctx = await fixture(t);
  await ctx.admission('approved');
  const payload = await ctx.payload(await ctx.draft());
  ctx.db.exec(`CREATE TRIGGER reject_hot_topic_job AFTER INSERT ON hot_topic_knowledge_jobs
    BEGIN SELECT RAISE(ABORT, 'isolated integration rollback'); END`);
  const failed = await ctx.request('/api/publish/tasks', { method: 'POST', body: payload });
  assert.equal(failed.response.status, 500, failed.text);
  assert.deepEqual(ctx.counts(), { tasks: 0, targets: 0, publishes: 0, knowledge: 0 });
  ctx.db.exec('DROP TRIGGER reject_hot_topic_job');
  const retried = await ctx.request('/api/publish/tasks', { method: 'POST', body: payload });
  assert.equal(retried.response.status, 201, retried.text);
  assert.deepEqual(ctx.counts(), { tasks: 1, targets: 1, publishes: 1, knowledge: 1 });
});

test('ordinary manual media publishes without creating or accepting client supplied knowledge', async t => {
  const ctx = await fixture(t);
  const manualPath = path.join(ctx.dir, 'manual.mp4');
  fs.copyFileSync(ctx.sourceVideo, manualPath);
  const payload = await ctx.payload({ title: '普通手动素材内容分享', body: '这是运营手动选择的普通媒体素材，仍按照现有预检和审核流程创建平台发布任务。', materialPath: manualPath });
  payload.hotTopicDocument = { schemaVersion: 1, title: 'forged', body: 'forged', markdown: 'forged', questions: ['forged'] };
  const created = await ctx.request('/api/publish/tasks', { method: 'POST', body: payload });
  assert.equal(created.response.status, 201, created.text);
  assert.deepEqual(ctx.counts(), { tasks: 1, targets: 1, publishes: 1, knowledge: 0 });
});

test('scheduled automatic material enqueues only when its publish task is actually created', async t => {
  const ctx = await fixture(t);
  await ctx.admission('approved');
  const payload = await ctx.payload(await ctx.draft());
  const due = new Date(Date.now() + 5000);
  due.setUTCMilliseconds(0);
  const schedulePayload = { ...payload, scheduledAt: due.toISOString(), scheduledLocal: due.toISOString().slice(0, 19), timezoneOffsetMinutes: 0 };
  const created = await ctx.request('/api/publish/schedules', { method: 'POST', body: schedulePayload });
  assert.equal(created.response.status, 201, created.text);
  assert.deepEqual(ctx.counts(), { tasks: 0, targets: 0, publishes: 0, knowledge: 0 });
  const duplicate = await ctx.request('/api/publish/schedules', { method: 'POST', body: schedulePayload });
  assert.equal(duplicate.response.status, 409, duplicate.text);
  assert.equal(duplicate.data.code, 'SCHEDULE_DUPLICATE');
  const scheduleId = created.data.schedule.id;
  const deadline = Date.now() + 12_000;
  let schedule;
  while (Date.now() < deadline) {
    schedule = ctx.db.prepare('SELECT * FROM scheduled_publish_tasks WHERE id=?').get(scheduleId);
    if (schedule.publish_task_id || schedule.status === 'FAILED') break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(schedule.publish_task_id, JSON.stringify(schedule));
  assert.deepEqual(ctx.counts(), { tasks: 1, targets: 1, publishes: 1, knowledge: 1 });
  assert.equal(ctx.jobs()[0].task_id, schedule.publish_task_id);
  assert.equal(JSON.parse(ctx.jobs()[0].document_json).body, narration);
});
