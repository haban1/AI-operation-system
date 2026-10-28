import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createContentLibrary } from '../src/services/content-library.js';
import { createContentLibrarySeedLoader } from '../src/services/content-library-seeds.js';
import { createStudioOutputLibrary } from '../src/services/content-library-studio.js';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const allItems = snapshot => [...snapshot.items, ...snapshot.pendingItems, ...snapshot.rejectedItems];
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'content-library-seeds-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bundle = path.join(root, 'bundle'); await mkdir(path.join(bundle, 'media'), { recursive: true });
  const options = { cacheMs: 0, collectSources: async () => ({ entries: [], sources: [] }),
    inspectMedia: async file => ({ type: path.extname(file) === '.png' ? 'image' : 'video', durationSeconds: 3, width: 1280, height: 720 }) };
  const makeLibrary = suffix => createContentLibrary({ contentLibraryDir: path.join(root, `library${suffix || ''}`) }, options);
  const library = makeLibrary();
  async function add(id, source, sourceId, content = `fixed media bytes ${id}`, extension = '.mp4') {
    const bytes = Buffer.from(content), sha256 = hash(bytes), filename = sha256 + extension;
    await writeFile(path.join(bundle, 'media', filename), bytes);
    return { id, source, sourceId, title: id, artifactType: extension === '.png' ? 'image' : 'final_video', filename,
      filePath: `media/${filename}`, bytes: bytes.length, sha256 };
  }
  const items = [await add('seed-hotspot', 'automatic', 'portable-run'), await add('seed-mix', 'editing', 'studio:v5-test')];
  async function manifest(entries = items) { await writeFile(path.join(bundle, 'manifest.json'), JSON.stringify({ schemaVersion: 1, items: entries })); }
  const consent = { schemaVersion: 1, actor: 'user-request-fixture', basis: 'Explicit confirmation of these exact existing media bytes',
    approvedAt: '2026-10-29T00:00:00.000Z', items: items.map(({ source, sourceId, sha256, bytes }) => ({ source, sourceId, sha256, bytes })) };
  const consentBytes = JSON.stringify(consent);
  await writeFile(path.join(bundle, 'approval.json'), consentBytes); await manifest();
  const approvalSha256 = hash(consentBytes);
  const makeLoader = (overrides = {}) => createContentLibrarySeedLoader({ library, root: bundle, approvalSha256, ...overrides });
  return { root, bundle, items, library, add, manifest, consent, approvalSha256, makeLibrary, makeLoader };
}

test('a clean deployment imports exact fixed-byte consent once and exposes portable hotspot and mix outputs', async t => {
  const ctx = await fixture(t), loader = ctx.makeLoader();
  const loaded = await loader.load();
  assert.equal(loaded.imported, 2); assert.equal(loaded.approved, 2); assert.equal(loaded.failed, 0);
  const initial = await ctx.library.list();
  assert.deepEqual(initial.counts, { total: 2, approved: 2, pending: 0, rejected: 0 });
  for (const item of initial.items) {
    assert.equal(item.reviewedBy, ctx.consent.actor);
    assert.equal(item.reviewedAt, ctx.consent.approvedAt);
    assert.equal(item.seedApproval.authorizationSha256, ctx.approvalSha256);
    assert.equal(item.seedApproval.basis, ctx.consent.basis);
    await ctx.library.publishDraft(item.id);
  }
  const studio = createStudioOutputLibrary({ library: ctx.library, source: { async list() { throw new Error('offline'); } } });
  const outputs = (await studio.list()).items;
  assert.deepEqual(outputs.map(item => item.source).sort(), ['automatic', 'mix']);
  assert.ok(outputs.every(item => item.status === 'approved'));
  assert.equal(outputs.find(item => item.source === 'automatic').sourceId, 'portable-run');
  const again = await loader.load();
  assert.equal(again.imported, 0); assert.equal(again.approved, 0); assert.equal(again.retained, 2);
  const restarted = ctx.makeLibrary();
  assert.deepEqual((await restarted.list()).items, (await ctx.library.list()).items);
  assert.equal((await ctx.makeLoader({ library: restarted }).load()).approved, 0);
  assert.deepEqual((await restarted.list()).items.map(item => item.reviewedAt), initial.items.map(item => item.reviewedAt));
});

test('new seed entries and updated bytes remain pending although the original fixed consent still matches', async t => {
  const ctx = await fixture(t);
  await ctx.makeLoader().load();
  const changed = await ctx.add(ctx.items[0].id, 'automatic', ctx.items[0].sourceId, 'new byte version awaiting its own consent');
  const added = await ctx.add('seed-new', 'creation', 'new-output', 'future generated image', '.png');
  await ctx.manifest([changed, ctx.items[1], added]);
  const loaded = await ctx.makeLoader().load();
  assert.equal(loaded.imported, 2); assert.equal(loaded.approved, 0);
  const result = await ctx.library.list();
  assert.deepEqual(result.counts, { total: 4, approved: 2, pending: 2, rejected: 0 });
  assert.ok(result.pendingItems.every(item => item.admittedBy === null));
  const fresh = ctx.makeLibrary('-fresh');
  await ctx.makeLoader({ library: fresh }).load();
  assert.deepEqual((await fresh.list()).counts, { total: 3, approved: 1, pending: 2, rejected: 0 });
});

test('altering approval metadata or extending its authorization list fails closed to pending', async t => {
  const ctx = await fixture(t);
  await writeFile(path.join(ctx.bundle, 'approval.json'), JSON.stringify({ ...ctx.consent, actor: 'forged-new-consent' }));
  const loaded = await ctx.makeLoader().load();
  assert.equal(loaded.approved, 0); assert.equal(loaded.imported, 2);
  assert.equal(loaded.warnings.length, 1);
  assert.deepEqual((await ctx.library.list()).counts, { total: 2, approved: 0, pending: 2, rejected: 0 });
});

test('restarts preserve a later rejection and an explicit withdrawal to pending', async t => {
  const ctx = await fixture(t);
  await ctx.makeLoader().load();
  const approved = (await ctx.library.list()).items;
  await ctx.library.setAdmission(approved[0].id, 'rejected', 'human-rejection');
  await ctx.library.setAdmission(approved[1].id, 'pending', 'human-withdrawal');
  const reviewed = allItems(await ctx.library.list());
  const restarted = ctx.makeLibrary();
  const loaded = await ctx.makeLoader({ library: restarted }).load();
  assert.equal(loaded.approved, 0);
  assert.deepEqual((await restarted.list()).counts, { total: 2, approved: 0, pending: 1, rejected: 1 });
  for (const item of allItems(await restarted.list())) {
    const previous = reviewed.find(record => record.id === item.id);
    assert.equal(item.reviewedBy, previous.reviewedBy);
    assert.equal(item.reviewedAt, previous.reviewedAt);
    assert.equal(item.admittedAt, null);
  }
});

test('a human rejection queued between reception and seed admission always wins', async t => {
  const ctx = await fixture(t);
  const reviewingLibrary = { ...ctx.library, async receive(...args) {
    const received = await ctx.library.receive(...args);
    await ctx.library.setAdmission(received.item.id, 'rejected', 'reviewer-during-seed');
    return received;
  } };
  const loaded = await ctx.makeLoader({ library: reviewingLibrary }).load();
  assert.equal(loaded.approved, 0);
  const snapshot = await ctx.library.list();
  assert.equal(snapshot.rejectedItems.length, 2);
  assert.ok(snapshot.rejectedItems.every(item => item.reviewedBy === 'reviewer-during-seed'));
});

test('changed bytes, wrong sizes, traversals and symlinks fail independently without approval', async t => {
  const ctx = await fixture(t);
  const corrupt = await ctx.add('corrupt', 'editing', 'corrupt');
  const content = await readFile(path.join(ctx.bundle, corrupt.filePath)); content[0] ^= 1;
  await writeFile(path.join(ctx.bundle, corrupt.filePath), content);
  const linked = await ctx.add('linked', 'editing', 'linked');
  const outside = path.join(ctx.root, 'outside.mp4'); await writeFile(outside, 'outside bytes');
  await rm(path.join(ctx.bundle, linked.filePath)); await symlink(outside, path.join(ctx.bundle, linked.filePath));
  const wrongSize = { ...await ctx.add('wrong-size', 'creation', 'wrong-size'), bytes: 99999 };
  const traversal = { ...ctx.items[0], id: 'traversal', filePath: '../outside.mp4' };
  await ctx.manifest([ctx.items[0], corrupt, linked, wrongSize, traversal]);
  const loaded = await ctx.makeLoader().load();
  assert.equal(loaded.approved, 1); assert.equal(loaded.failed, 4);
  assert.deepEqual((await ctx.library.list()).counts, { total: 1, approved: 1, pending: 0, rejected: 0 });
});

test('a disabled seed loader leaves the existing library untouched', async t => {
  const ctx = await fixture(t);
  const loaded = await ctx.makeLoader({ enabled: false }).load();
  assert.equal(loaded.enabled, false); assert.equal(loaded.imported, 0);
  assert.equal((await ctx.library.list()).counts.total, 0);
});
