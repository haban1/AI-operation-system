import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createContentLibrary } from '../src/services/content-library.js';

const document = { schemaVersion: 1, title: '热点发布标题', body: '介绍本条热点的视频正文。', markdown: '# 原始热点全题\n\n独有后台知识正文及来源。', questions: ['本条热点介绍什么？'] };
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hot-library-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceRoot = path.join(root, 'source'); await mkdir(sourceRoot);
  const video = path.join(sourceRoot, 'video.mp4'); await writeFile(video, 'verified fixture video');
  const config = { contentLibraryDir: path.join(root, 'library'), contentLibrarySignalRoot: sourceRoot, contentLibraryEditingRoot: sourceRoot };
  const entry = { source: 'automatic', sourceId: 'run-one', rootPath: sourceRoot, filePath: video, title: '原始长标题', body: 'source body', hotTopicDocument: structuredClone(document) };
  const entries = [entry];
  const make = () => createContentLibrary(config, { cacheMs: 0, collectSources: async () => ({ entries, sources: [] }),
    inspectMedia: async () => ({ type: 'video', durationSeconds: 2 }) });
  return { root, video, config, entries, entry, make, library: make(), catalogPath: path.join(config.contentLibraryDir, 'catalog.json') };
}

test('automatic video stores a private immutable document before approval and survives restart', async t => {
  const ctx = await fixture(t);
  const snapshot = await ctx.library.list();
  assert.doesNotMatch(JSON.stringify(snapshot), /hotTopicDocument|独有后台知识|markdown|questions|documentHash/);
  const pending = snapshot.pendingItems[0];
  const catalog = JSON.parse(await readFile(ctx.catalogPath, 'utf8'));
  const ref = catalog.items[0].hotTopicDocument;
  const saved = JSON.parse(await readFile(path.join(ctx.config.contentLibraryDir, 'knowledge', ref.filename), 'utf8'));
  assert.equal(saved.materialId, pending.id); assert.equal(saved.sha256, pending.sha256);
  assert.deepEqual(saved.document, document);
  await assert.rejects(ctx.library.publishDraft(pending.id), { code: 'CONTENT_ADMISSION_REQUIRED' });
  await ctx.library.setAdmission(pending.id, 'approved', 'reviewer');
  ctx.entry.hotTopicDocument.body = 'source script modified after video creation';
  const restarted = ctx.make(); await restarted.sync({ force: true });
  const draft = await restarted.publishDraft(pending.id);
  assert.equal(draft.title, document.title); assert.equal(draft.body, document.body);
  assert.doesNotMatch(JSON.stringify(draft), /独有后台知识|hotTopicDocument|markdown|questions/);
  // The server obtains knowledge only from the catalog and exact selected media.
  assert.equal(restarted.assertPublishMaterial(draft.materialPath, draft.sha256).hotTopicDocument, undefined);
  assert.deepEqual(restarted.assertPublishMaterial(draft.materialPath, draft.sha256, { contentLibraryItemId: pending.id }).hotTopicDocument, document);
});

test('same bytes from editing do not enqueue automatic knowledge, and an ID cannot select different video bytes', async t => {
  const ctx = await fixture(t);
  ctx.entries.push({ ...ctx.entry, source: 'editing', sourceId: 'editing-one' });
  const snapshot = await ctx.library.list();
  for (const item of snapshot.pendingItems) await ctx.library.setAdmission(item.id, 'approved', 'reviewer');
  const automatic = snapshot.pendingItems.find(item => item.source === 'automatic');
  const editing = snapshot.pendingItems.find(item => item.source === 'editing');
  const draft = await ctx.library.publishDraft(editing.id);
  assert.equal(draft.body, 'source body');
  assert.equal(ctx.library.assertPublishMaterial(draft.materialPath, draft.sha256, { contentLibraryItemId: editing.id }).hotTopicDocument, undefined);
  assert.throws(() => ctx.library.assertPublishMaterial(draft.materialPath, draft.sha256, { contentLibraryItemId: 'f'.repeat(32) }), { code: 'CONTENT_ADMISSION_REQUIRED' });
  await writeFile(ctx.video, 'new rendered video bytes');
  const changed = await ctx.library.sync({ force: true });
  const newAutomatic = changed.pendingItems.find(item => item.source === 'automatic');
  await ctx.library.setAdmission(newAutomatic.id, 'approved', 'reviewer');
  const newDraft = await ctx.library.publishDraft(newAutomatic.id);
  assert.throws(() => ctx.library.assertPublishMaterial(newDraft.materialPath, newDraft.sha256, { contentLibraryItemId: automatic.id }), { code: 'CONTENT_ADMISSION_REQUIRED' });
});

test('legacy videos without source text remain usable and receive a private document when source becomes available', async t => {
  const ctx = await fixture(t);
  delete ctx.entry.hotTopicDocument;
  const item = (await ctx.library.list()).pendingItems[0];
  await ctx.library.setAdmission(item.id, 'approved', 'reviewer');
  assert.equal((await ctx.library.publishDraft(item.id)).body, 'source body');
  ctx.entry.hotTopicDocument = document;
  await ctx.library.sync({ force: true });
  assert.equal((await ctx.library.publishDraft(item.id)).body, document.body);
  assert.equal((await ctx.library.list()).items[0].id, item.id);
});

test('synchronization restores a lost private copy only from the exact frozen source text', async t => {
  const ctx = await fixture(t);
  const item = (await ctx.library.list()).pendingItems[0];
  await ctx.library.setAdmission(item.id, 'approved', 'reviewer');
  const catalog = JSON.parse(await readFile(ctx.catalogPath, 'utf8'));
  const file = path.join(ctx.config.contentLibraryDir, 'knowledge', catalog.items[0].hotTopicDocument.filename);
  const original = await readFile(file);
  await rm(file);
  await ctx.library.sync({ force: true });
  assert.deepEqual(await readFile(file), original);
  await rm(file);
  ctx.entry.hotTopicDocument.markdown = '# A later unsupported script';
  await ctx.library.sync({ force: true });
  await assert.rejects(readFile(file), { code: 'ENOENT' });
  await assert.rejects(ctx.library.publishDraft(item.id), { code: 'CONTENT_KNOWLEDGE_UNAVAILABLE' });
});

test('modified, wrongly bound or symlinked private documents fail closed before confirmation', async t => {
  const ctx = await fixture(t);
  const item = (await ctx.library.list()).pendingItems[0];
  await ctx.library.setAdmission(item.id, 'approved', 'reviewer');
  const draft = await ctx.library.publishDraft(item.id);
  const catalog = JSON.parse(await readFile(ctx.catalogPath, 'utf8'));
  const ref = catalog.items[0].hotTopicDocument;
  const file = path.join(ctx.config.contentLibraryDir, 'knowledge', ref.filename);
  const original = await readFile(file);
  await writeFile(file, original.toString().replace('独有后台知识', '更改后的知识'));
  assert.throws(() => ctx.library.assertPublishMaterial(draft.materialPath, draft.sha256, { contentLibraryItemId: item.id }), { code: 'CONTENT_KNOWLEDGE_UNAVAILABLE' });
  await assert.rejects(ctx.library.publishDraft(item.id), { code: 'CONTENT_KNOWLEDGE_UNAVAILABLE' });
  // Other workflows using these same media bytes are unaffected by document failures.
  assert.equal(ctx.library.assertPublishMaterial(draft.materialPath, draft.sha256).id, item.id);
  await rm(file);
  const external = path.join(ctx.root, 'external-document.json'); await writeFile(external, original);
  await symlink(external, file);
  assert.throws(() => ctx.library.assertPublishMaterial(draft.materialPath, draft.sha256, { contentLibraryItemId: item.id }), { code: 'CONTENT_KNOWLEDGE_UNAVAILABLE' });
});
