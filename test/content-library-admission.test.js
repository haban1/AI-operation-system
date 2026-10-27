import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { createContentLibrary } from '../src/services/content-library.js';

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'library-admission-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceRoot = path.join(root, 'source');
  await mkdir(sourceRoot);
  const mediaPath = path.join(sourceRoot, 'output.png');
  await writeFile(mediaPath, 'local fixture media bytes');
  const config = { contentLibraryDir: path.join(root, 'library'),
    contentLibrarySignalRoot: sourceRoot, contentLibraryEditingRoot: sourceRoot, contentLibraryCreationRoot: sourceRoot };
  const entries = ['automatic', 'editing', 'creation'].map(source => ({
    source, sourceId: `${source}-output`, rootPath: sourceRoot, filePath: mediaPath,
    title: source, body: 'fixture description', reviewStatus: 'selected', artifactType: 'image',
  }));
  const state = { entries, collect: null };
  const make = () => createContentLibrary(config, {
    cacheMs: 0,
    collectSources: () => state.collect ? state.collect() : Promise.resolve({ entries: state.entries, sources: [] }),
    inspectMedia: async () => ({ type: 'image', width: 1, height: 1 }),
  });
  return { root, mediaPath, config, state, make, library: make() };
}

test('all three sources require separate admission even when the source selected the media', async t => {
  const ctx = await fixture(t);
  const result = await ctx.library.list();
  assert.deepEqual(result.items, []);
  assert.deepEqual(result.rejectedItems, []);
  assert.deepEqual(result.counts, { total: 3, approved: 0, pending: 3, rejected: 0 });
  assert.deepEqual(result.pendingItems.map(item => item.source).sort(), ['automatic', 'creation', 'editing']);
  for (const item of result.pendingItems) {
    assert.equal(item.reviewStatus, 'selected');
    assert.equal(item.admissionStatus, 'pending');
    assert.equal(item.admittedBy, null);
    assert.equal(item.reviewedAt, null);
    await assert.rejects(ctx.library.publishDraft(item.id), { statusCode: 409, code: 'CONTENT_ADMISSION_REQUIRED' });
  }
  // Identical bytes share storage, but approval belongs to each source item.
  const approved = await ctx.library.setAdmission(result.pendingItems[0].id, 'approved', 'reviewer-one');
  assert.equal(approved.counts.approved, 1);
  assert.equal(approved.counts.pending, 2);
  assert.equal((await readdir(path.join(ctx.config.contentLibraryDir, 'media'))).length, 1);
});

test('approve, reject, and resubmit persist the actor and never remove copied media', async t => {
  const ctx = await fixture(t);
  ctx.state.entries = [ctx.state.entries[0]];
  const pending = (await ctx.library.list()).pendingItems[0];
  const approved = await ctx.library.setAdmission(pending.id, 'approved', 'reviewer-one');
  assert.equal(approved.item.admissionStatus, 'approved');
  assert.equal(approved.item.admittedBy, 'reviewer-one');
  assert.equal(approved.item.reviewedBy, 'reviewer-one');
  assert.equal(approved.item.admittedAt, approved.item.reviewedAt);
  const draft = await ctx.library.publishDraft(pending.id);
  const bytes = await readFile(draft.materialPath);
  const restarted = ctx.make();
  assert.equal((await restarted.list()).items[0].admittedBy, 'reviewer-one');
  for (const decision of ['rejected', 'pending']) {
    const reviewed = await restarted.setAdmission(pending.id, decision, 'reviewer-two');
    assert.equal(reviewed.item.admittedAt, null);
    assert.equal(reviewed.item.reviewedBy, 'reviewer-two');
    assert.ok(reviewed.item.reviewedAt);
    const snapshot = await ctx.make().list();
    assert.deepEqual(snapshot.items, []);
    assert.equal(snapshot[decision === 'pending' ? 'pendingItems' : 'rejectedItems'][0].id, pending.id);
    await assert.rejects(restarted.publishDraft(pending.id), { code: 'CONTENT_ADMISSION_REQUIRED' });
    assert.deepEqual(await readFile(draft.materialPath), bytes);
  }
});

test('legacy items and approval labels without an audit record migrate to pending', async t => {
  const ctx = await fixture(t);
  const initial = await ctx.library.list();
  await ctx.library.setAdmission(initial.pendingItems[0].id, 'approved', 'reviewer-one');
  const catalogPath = path.join(ctx.config.contentLibraryDir, 'catalog.json');
  const catalog = JSON.parse(await readFile(catalogPath, 'utf8'));
  for (const item of catalog.items) {
    for (const key of ['admissionStatus', 'admittedAt', 'admittedBy', 'reviewedAt', 'reviewedBy']) delete item[key];
    item.reviewStatus = 'selected';
  }
  catalog.items[1].admissionStatus = 'approved';
  await writeFile(catalogPath, JSON.stringify(catalog));
  ctx.state.entries = [];
  const restarted = ctx.make();
  const result = await restarted.list();
  assert.deepEqual(result.items, []);
  assert.equal(result.pendingItems.length, 3);
  assert.equal((await readdir(path.join(ctx.config.contentLibraryDir, 'media'))).length, 1);
  await assert.rejects(restarted.publishDraft(catalog.items[0].id), { code: 'CONTENT_ADMISSION_REQUIRED' });
  const persisted = JSON.parse(await readFile(catalogPath, 'utf8'));
  assert.ok(persisted.items.every(item => item.admissionStatus === 'pending'));
});

test('unchanged bytes retain admission after stat changes but new content requires new review', async t => {
  const ctx = await fixture(t);
  ctx.state.entries = [ctx.state.entries[0]];
  const pending = (await ctx.library.list()).pendingItems[0];
  await ctx.library.setAdmission(pending.id, 'approved', 'reviewer-one');
  const original = await readFile(ctx.mediaPath);
  await writeFile(ctx.mediaPath, original);
  const unchanged = await ctx.library.sync({ force: true });
  assert.equal(unchanged.items[0].id, pending.id);
  assert.equal(unchanged.items[0].admittedBy, 'reviewer-one');
  await writeFile(ctx.mediaPath, 'changed output bytes');
  const changed = await ctx.library.sync({ force: true });
  assert.equal(changed.items[0].id, pending.id);
  assert.equal(changed.pendingItems.length, 1);
  assert.notEqual(changed.pendingItems[0].sha256, pending.sha256);
  assert.equal(changed.pendingItems[0].admittedBy, null);
  await assert.rejects(ctx.library.publishDraft(changed.pendingItems[0].id), { code: 'CONTENT_ADMISSION_REQUIRED' });
});

test('a review queued during synchronization cannot be overwritten by the collected snapshot', async t => {
  const ctx = await fixture(t);
  ctx.state.entries = [ctx.state.entries[0]];
  const pending = (await ctx.library.list()).pendingItems[0];
  let begin, release;
  const started = new Promise(resolve => { begin = resolve; });
  const continueSync = new Promise(resolve => { release = resolve; });
  ctx.state.collect = async () => {
    begin();
    await continueSync;
    return { entries: [...ctx.state.entries, { ...ctx.state.entries[0], sourceId: 'new-output' }], sources: [] };
  };
  const syncing = ctx.library.sync({ force: true });
  await started;
  const reviewing = ctx.library.setAdmission(pending.id, 'approved', 'reviewer-during-sync');
  release();
  await Promise.all([syncing, reviewing]);
  ctx.state.collect = null;
  const result = await ctx.make().list();
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].admittedBy, 'reviewer-during-sync');
  assert.equal(result.pendingItems[0].sourceId, 'new-output');
});

test('invalid review, missing identity, and tampered media fail without mutating admission', async t => {
  const ctx = await fixture(t);
  ctx.state.entries = [ctx.state.entries[0]];
  const pending = (await ctx.library.list()).pendingItems[0];
  await assert.rejects(ctx.library.setAdmission(pending.id, 'selected', 'admin'), { code: 'CONTENT_ADMISSION_INVALID' });
  await assert.rejects(ctx.library.setAdmission(pending.id, 'approved', ''), { code: 'CONTENT_ADMISSION_ACTOR_REQUIRED' });
  const file = path.join(ctx.config.contentLibraryDir, 'media', `${pending.sha256}.png`);
  const bytes = await readFile(file);bytes[0] ^= 1;
  await writeFile(file, bytes);
  await assert.rejects(ctx.library.setAdmission(pending.id, 'approved', 'admin'), { code: 'CONTENT_FILE_CHANGED' });
  assert.equal((await ctx.library.list()).pendingItems[0].admittedAt, null);
  // A failed operation must not poison the serialization queue.
  assert.equal((await ctx.library.setAdmission(pending.id, 'rejected', 'admin')).item.admissionStatus, 'rejected');
});

test('received media from all three sources stays pending without configured discovery roots', async t => {
  const ctx = await fixture(t);
  ctx.state.entries = [];
  for (const key of ['contentLibrarySignalRoot', 'contentLibraryEditingRoot', 'contentLibraryCreationRoot']) ctx.config[key] = '';
  const library = ctx.make();
  const bytes = await readFile(ctx.mediaPath);
  for (const source of ['automatic', 'editing', 'creation']) {
    const result = await library.receive(Readable.from([bytes.subarray(0, 4), bytes.subarray(4)]), { source, filename: 'original.png' }, 'receiver');
    assert.equal(result.item.source, source);
    assert.equal(result.item.title, 'original.png');
    assert.equal(result.item.artifactType, 'image');
    assert.equal(result.item.sourceStatus, '接收产物 · 待确认');
    assert.equal(result.item.admissionStatus, 'pending');
    assert.equal(result.item.receivedBy, 'receiver');
    assert.ok(result.item.receivedAt);
    await assert.rejects(library.publishDraft(result.item.id), { code: 'CONTENT_ADMISSION_REQUIRED' });
    if (source === 'automatic') await library.setAdmission(result.item.id, 'approved', 'reviewer');
  }
  const repeated = await library.receive(Readable.from([bytes]), { source: 'automatic', filename: 'again.png' }, 'receiver-two');
  assert.equal(repeated.item.admissionStatus, 'pending');
  assert.deepEqual(repeated.counts, { total: 4, approved: 1, pending: 3, rejected: 0 });
  const restarted = await ctx.make().list();
  assert.equal(restarted.items[0].admittedBy, 'reviewer');
  assert.equal(restarted.pendingItems.find(item => item.id === repeated.item.id).receivedBy, 'receiver-two');
  assert.equal(new Set([...restarted.items, ...restarted.pendingItems].map(item => item.sourceId)).size, 4);
  const media = await readdir(path.join(ctx.config.contentLibraryDir, 'media'));
  assert.equal(media.length, 1);
  assert.deepEqual(await readFile(path.join(ctx.config.contentLibraryDir, 'media', media[0])), bytes);
  assert.deepEqual(await readdir(path.join(ctx.config.contentLibraryDir, 'incoming')), []);
});

test('invalid reception metadata, limits, interrupted streams and inspection failures leave no media behind', async t => {
  const ctx = await fixture(t);
  ctx.state.entries = [];
  ctx.config.contentLibraryMaxFileBytes = 16;
  const library = ctx.make();
  const good = { source: 'editing', filename: 'sample.png' };
  for (const params of [
    { ...good, source: '__proto__' }, { ...good, filename: '../a.png' }, { ...good, filename: 'a\\b.png' },
    { ...good, filename: 'a:stream.png' }, { ...good, filename: 'a\u0000.png' }, { ...good, filename: 'a.txt' },
    { ...good, filename: '' }, { ...good, artifactType: 'final_video' }, { ...good, title: 'x'.repeat(501) },
    { ...good, admissionStatus: 'approved' }, { ...good, actor: 'forged' }, { ...good, filePath: ctx.mediaPath },
  ]) await assert.rejects(library.receive(Readable.from(['x']), params, 'receiver'), { code: 'CONTENT_RECEIVE_INVALID' });
  await assert.rejects(library.receive(Readable.from(['x']), good, ''), { code: 'CONTENT_RECEIVE_ACTOR_REQUIRED' });
  await assert.rejects(library.receive(Readable.from(['x']), good, 'receiver', { contentLength: 17 }), { statusCode: 413 });
  await assert.rejects(library.receive(Readable.from(['x']), good, 'receiver', { contentLength: 'wrong' }), { code: 'CONTENT_RECEIVE_INVALID' });
  await assert.rejects(library.receive(Readable.from([Buffer.alloc(10), Buffer.alloc(10)]), good, 'receiver'), { statusCode: 413 });
  await assert.rejects(library.receive(Readable.from([]), good, 'receiver'), { code: 'CONTENT_MEDIA_INVALID' });
  await assert.rejects(library.receive(Readable.from(['x']), good, 'receiver', { contentLength: 2 }), { code: 'CONTENT_MEDIA_INVALID' });
  const broken = Readable.from((async function* () { yield Buffer.from('x'); throw new Error('source disconnected'); })());
  await assert.rejects(library.receive(broken, good, 'receiver'), /source disconnected/);
  const invalidMedia = createContentLibrary(ctx.config, { collectSources: async () => ({ entries: [] }), inspectMedia: async () => { throw new Error(`bad file at ${ctx.root}`); } });
  await assert.rejects(invalidMedia.receive(Readable.from(['not a media file']), good, 'receiver'), error => {
    assert.equal(error.code, 'CONTENT_MEDIA_INVALID');
    assert.equal(error.message.includes(ctx.root), false);
    return true;
  });
  assert.deepEqual(await readdir(path.join(ctx.config.contentLibraryDir, 'incoming')), []);
  assert.deepEqual(await readdir(path.join(ctx.config.contentLibraryDir, 'media')), []);
  assert.equal((await library.list()).counts.total, 0);
});

test('receiving a slow stream does not block manual admission', { timeout: 5000 }, async t => {
  const ctx = await fixture(t);
  const pending = (await ctx.library.list()).pendingItems[0];
  let begin, release;
  const started = new Promise(resolve => { begin = resolve; });
  const ready = new Promise(resolve => { release = resolve; });
  const stream = Readable.from((async function* () { begin(); yield Buffer.from('start'); await ready; yield Buffer.from('end'); })());
  const receiving = ctx.library.receive(stream, { source: 'editing', filename: 'slow.png' }, 'receiver');
  await started;
  try {
    assert.equal((await ctx.library.setAdmission(pending.id, 'approved', 'reviewer')).item.admissionStatus, 'approved');
  } finally { release(); }
  assert.equal((await receiving).item.admissionStatus, 'pending');
});

test('final publication checks durable file admission and permits bytes with any surviving approval', async t => {
  const ctx = await fixture(t);
  const snapshot = await ctx.library.list();
  const [first, second] = snapshot.pendingItems;
  const materialPath = path.join(ctx.config.contentLibraryDir, 'media', `${first.sha256}.png`);
  assert.throws(() => ctx.library.assertPublishMaterial(materialPath, first.sha256), { code: 'CONTENT_ADMISSION_REQUIRED' });
  await ctx.library.setAdmission(first.id, 'approved', 'reviewer');
  const uninitialized = ctx.make();
  assert.equal(uninitialized.assertPublishMaterial(materialPath, first.sha256).id, first.id);
  assert.throws(() => uninitialized.assertPublishMaterial(materialPath, '0'.repeat(64)), { code: 'CONTENT_FILE_CHANGED' });
  await ctx.library.setAdmission(second.id, 'approved', 'other-reviewer');
  await ctx.library.setAdmission(first.id, 'rejected', 'reviewer');
  // Three source records share this file; one surviving approval authorizes its bytes.
  assert.equal(uninitialized.assertPublishMaterial(materialPath, first.sha256).id, second.id);
  await ctx.library.setAdmission(second.id, 'pending', 'other-reviewer');
  assert.throws(() => uninitialized.assertPublishMaterial(materialPath, first.sha256), { code: 'CONTENT_ADMISSION_REQUIRED' });
  // Identical source bytes outside the library remain normal external material.
  assert.equal(uninitialized.assertPublishMaterial(ctx.mediaPath, first.sha256), null);
  // A broken discovery/storage configuration must not disable ordinary material.
  const brokenRoot = path.join(ctx.mediaPath, 'not-a-directory');
  const brokenLibrary = createContentLibrary({ ...ctx.config, contentLibraryDir: brokenRoot });
  assert.equal(brokenLibrary.assertPublishMaterial(ctx.mediaPath, first.sha256), null);
  assert.throws(() => brokenLibrary.assertPublishMaterial(path.join(brokenRoot, 'media', `${first.sha256}.png`), first.sha256), { code: 'CONTENT_FILE_UNAVAILABLE' });
});

test('publication identifies library files through aliases and fails closed for untrusted catalog records', async t => {
  const ctx = await fixture(t);
  ctx.state.entries = [ctx.state.entries[0]];
  const pending = (await ctx.library.list()).pendingItems[0];
  await ctx.library.setAdmission(pending.id, 'approved', 'reviewer');
  const draft = await ctx.library.publishDraft(pending.id);
  const alias = path.join(ctx.root, 'external-alias.png');
  await symlink(draft.materialPath, alias);
  assert.equal(ctx.library.assertPublishMaterial(alias, pending.sha256).id, pending.id);
  await ctx.library.setAdmission(pending.id, 'rejected', 'reviewer');
  assert.throws(() => ctx.library.assertPublishMaterial(alias, pending.sha256), { code: 'CONTENT_ADMISSION_REQUIRED' });
  const escaping = path.join(ctx.config.contentLibraryDir, 'media', `${'1'.repeat(64)}.png`);
  await symlink(ctx.mediaPath, escaping);
  assert.throws(() => ctx.library.assertPublishMaterial(escaping, pending.sha256), { code: 'CONTENT_FILE_UNAVAILABLE' });
  const unknown = path.join(ctx.config.contentLibraryDir, 'media', `${'2'.repeat(64)}.png`);
  await writeFile(unknown, 'unknown bytes');
  assert.throws(() => ctx.library.assertPublishMaterial(unknown, '2'.repeat(64)), { code: 'CONTENT_ADMISSION_REQUIRED' });
  const sibling = path.join(ctx.root, 'library-other');
  await mkdir(sibling);
  const external = path.join(sibling, 'outside.png');
  await writeFile(external, 'external bytes');
  assert.equal(ctx.library.assertPublishMaterial(external, pending.sha256), null);
  const catalogPath = path.join(ctx.config.contentLibraryDir, 'catalog.json');
  const catalog = JSON.parse(await readFile(catalogPath, 'utf8'));
  catalog.items[0].admissionStatus = 'approved';
  delete catalog.items[0].reviewedBy;
  await writeFile(catalogPath, JSON.stringify(catalog));
  assert.throws(() => ctx.library.assertPublishMaterial(draft.materialPath, pending.sha256), { code: 'CONTENT_ADMISSION_REQUIRED' });
  for (const invalid of ['{', 'x'.repeat(8 * 1024 * 1024 + 1)]) {
    await writeFile(catalogPath, invalid);
    assert.throws(() => ctx.library.assertPublishMaterial(draft.materialPath, pending.sha256), { code: 'CONTENT_LIBRARY_INVALID' });
    assert.equal(ctx.library.assertPublishMaterial(ctx.mediaPath, pending.sha256), null);
  }
  await rm(catalogPath);
  assert.throws(() => ctx.library.assertPublishMaterial(draft.materialPath, pending.sha256), { code: 'CONTENT_LIBRARY_INVALID' });
});
