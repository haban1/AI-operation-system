import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { createContentLibrary } from '../src/services/content-library.js';
import { createStudioOutputLibrary, createStudioOutputSource } from '../src/services/content-library-studio.js';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const output = (id, bytes) => ({ id, title: `成片 ${id}`, source: 'mix', filename: `${id}.mp4`, sha256: digest(bytes), bytes: bytes.length, bundled: true });
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'studio-library-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = { contentLibraryDir: path.join(root, 'library'), contentLibrarySignalRoot: path.join(root, 'signal') };
  await mkdir(config.contentLibrarySignalRoot);
  const entries = [];
  const options = { collectSources: async () => ({ entries, sources: [] }), cacheMs: 0, inspectMedia: async file => ({ type: path.extname(file) === '.png' ? 'image' : 'video', durationSeconds: path.extname(file) === '.png' ? null : 1, width: 1280, height: 720 }) };
  const library = createContentLibrary(config, options);
  const bytes = new Map(Array.from({ length: 6 }, (_, i) => [`v5-0${i + 1}`, Buffer.from(`sample video bytes ${i}`)]));
  const state = { items: [...bytes].map(([id, content]) => output(id, content)), opened: [], unavailable: false };
  const source = {
    async list() { if (state.unavailable) throw new Error('private upstream error'); return { items: state.items }; },
    async open(item) { state.opened.push(item.id); const content = bytes.get(item.id); if (content instanceof Error) throw content; return { stream: Readable.from([content]), contentLength: content.length }; },
  };
  return { root, config, entries, library, bytes, state, source, makeLibrary: () => createContentLibrary(config, options), studio: createStudioOutputLibrary({ library, source }) };
}

test('the six samples remain pending until human confirmation; duplicate confirmations and restarts reuse one material', async t => {
  const ctx = await fixture(t);
  const initial = await ctx.studio.list();
  assert.equal(initial.items.length, 6);
  assert.ok(initial.items.every(item => item.status === 'pending' && /^[a-f0-9]{32}$/.test(item.materialId)));
  assert.equal(ctx.state.opened.length, 6);
  assert.deepEqual((await ctx.library.list()).counts, { total: 6, approved: 0, pending: 6, rejected: 0 });
  await assert.rejects(ctx.library.publishDraft(initial.items[0].materialId), { code: 'CONTENT_ADMISSION_REQUIRED' });
  const first = await ctx.studio.confirmBatch(['v5-01'], 'reviewer-one');
  assert.equal(first.results[0].ok, true);
  const materialId = first.results[0].materialId;
  const received = (await ctx.library.list()).items[0];
  assert.equal(received.id, materialId);
  assert.equal(received.admittedBy, 'reviewer-one');
  assert.equal(received.sourceId, 'studio:v5-01');
  const draft = await ctx.library.publishDraft(materialId);
  assert.equal(draft.requiresPrecheck, true);
  assert.deepEqual(await readFile(draft.materialPath), ctx.bytes.get('v5-01'));
  const repeated = await ctx.studio.confirmBatch(['v5-01', 'v5-01'], 'reviewer-one');
  assert.equal(repeated.results.length, 1);
  assert.equal(repeated.results[0].materialId, materialId);
  assert.deepEqual((await ctx.library.list()).counts, { total: 6, approved: 1, pending: 5, rejected: 0 });
  assert.equal(ctx.state.opened.length, 6, 'discovery and repeated confirmations do not redownload unchanged bytes');
  const restarted = createStudioOutputLibrary({ library: ctx.makeLibrary(), source: ctx.source });
  assert.equal((await restarted.list()).items.find(item => item.id === 'v5-01').materialId, materialId);
  const remaining = (await restarted.list()).items.filter(item => item.id !== 'v5-01');
  assert.ok(remaining.every(item => item.status === 'pending'));
});

test('batch confirmations keep independent successes and preserve pending items on mismatched or missing bytes', async t => {
  const ctx = await fixture(t);
  ctx.bytes.set('v5-02', Buffer.from('different bytes after listing'));
  ctx.bytes.set('v5-03', new Error('private network failure'));
  const batch = await ctx.studio.confirmBatch(['v5-01', 'v5-02', 'v5-03', 'unknown-id', 'v5-04'], 'reviewer');
  assert.deepEqual(batch.results.map(item => item.ok), [true, false, false, false, true]);
  assert.equal(batch.results[1].code, 'CONTENT_FILE_CHANGED');
  assert.doesNotMatch(JSON.stringify(batch), /private network/);
  assert.deepEqual(batch.summary, { approved: 2, failed: 3 });
  assert.deepEqual((await ctx.library.list()).counts, { total: 4, approved: 2, pending: 2, rejected: 0 });
  const failed = (await ctx.studio.list()).items.find(item => item.id === 'v5-02');
  assert.equal(failed.status, 'pending');
  assert.equal(failed.materialId, null);
  assert.ok(failed.syncError);
});

test('a new byte version requires a new confirmation and never inherits prior approval', async t => {
  const ctx = await fixture(t);
  const old = (await ctx.studio.confirmBatch(['v5-01'], 'reviewer')).results[0].materialId;
  ctx.bytes.set('v5-01', Buffer.from('new finished video version'));
  ctx.state.items[0] = output('v5-01', ctx.bytes.get('v5-01'));
  const current = (await ctx.studio.list()).items.find(item => item.id === 'v5-01');
  assert.equal(current.status, 'pending');
  assert.ok(current.materialId);
  assert.notEqual(current.materialId, old);
  const confirmed = await ctx.studio.confirmBatch(['v5-01'], 'reviewer-two');
  assert.notEqual(confirmed.results[0].materialId, old);
  assert.equal((await ctx.library.list()).counts.approved, 2);
  assert.equal((await ctx.studio.list()).items.find(item => item.id === 'v5-01').status, 'approved');
});

test('same-size stored tampering invalidates displayed approval and the publication gate', async t => {
  const ctx = await fixture(t);
  const materialId = (await ctx.studio.confirmBatch(['v5-01'], 'reviewer')).results[0].materialId;
  const draft = await ctx.library.publishDraft(materialId);
  const bytes = await readFile(draft.materialPath); bytes[0] ^= 1;
  await writeFile(draft.materialPath, bytes);
  assert.equal((await ctx.studio.list()).items.find(item => item.id === 'v5-01').status, 'pending');
  const adapter = await ctx.studio.publishingLibrary.list({ items: ctx.state.items });
  assert.equal(adapter.items.find(item => item.id === 'v5-01').status, 'pending');
  await assert.rejects(ctx.library.publishDraft(materialId), { code: 'CONTENT_FILE_CHANGED' });
  // A new explicit confirmation recopies the known original bytes and verifies them.
  assert.equal((await ctx.studio.confirmBatch(['v5-01'], 'reviewer-two')).results[0].ok, true);
  assert.deepEqual(await readFile(draft.materialPath), ctx.bytes.get('v5-01'));
});

test('an offline companion retains approved local copies without overriding an online newer version', async t => {
  const ctx = await fixture(t);
  const materialId = (await ctx.studio.confirmBatch(['v5-01'], 'reviewer')).results[0].materialId;
  ctx.state.unavailable = true;
  const offline = await ctx.studio.list();
  assert.equal(offline.items.length, 6);
  const retained = offline.items.find(item => item.id === 'v5-01');
  assert.equal(retained.status, 'approved');
  assert.equal(retained.materialId, materialId);
  assert.equal(retained.videoPath, `/api/content-library/${materialId}/media`);
  assert.match(offline.warnings[0], /仍可查看已保存/);
  ctx.state.unavailable = false;
  ctx.bytes.set('v5-01', Buffer.from('new online version awaits approval'));
  ctx.state.items[0] = output('v5-01', ctx.bytes.get('v5-01'));
  const online = await ctx.studio.list();
  const versions = online.items.filter(item => item.id === 'v5-01');
  assert.equal(versions.length, 1);
  assert.equal(versions[0].status, 'pending');
  assert.ok(versions[0].materialId);
  assert.notEqual(versions[0].materialId, materialId);
  assert.equal(versions[0].sha256, ctx.state.items[0].sha256);
  assert.equal(online.warnings, undefined);
});

test('local fallback skips corrupted copies and permits explicit confirmation of a retained pending output', async t => {
  const ctx = await fixture(t);
  const materialId = (await ctx.studio.confirmBatch(['v5-01'], 'reviewer')).results[0].materialId;
  await ctx.library.setAdmission(materialId, 'pending', 'reviewer');
  ctx.state.items = [];
  const pending = (await ctx.studio.list()).items.find(item => item.id === 'v5-01');
  assert.equal(pending.id, 'v5-01');
  assert.equal(pending.status, 'pending');
  const openedBefore = ctx.state.opened.length;
  assert.equal((await ctx.studio.confirmBatch(['v5-01'], 'reviewer-two')).results[0].materialId, materialId);
  assert.equal(ctx.state.opened.length, openedBefore);
  const draft = await ctx.library.publishDraft(materialId);
  const bytes = await readFile(draft.materialPath); bytes[0] ^= 1;
  await writeFile(draft.materialPath, bytes);
  assert.equal((await ctx.studio.list()).items.some(item => item.id === 'v5-01'), false);
});

test('automatic finals share the existing admission gate while previous pending records stay untouched', async t => {
  const ctx = await fixture(t);
  const filePath = path.join(ctx.config.contentLibrarySignalRoot, 'automatic.mp4');
  await writeFile(filePath, 'automatic completed media');
  ctx.entries.push({ source: 'automatic', sourceId: 'run-one', rootPath: ctx.config.contentLibrarySignalRoot, filePath,
    title: '热点成片', artifactType: 'final_video', reviewStatus: 'selected' });
  const upload = await ctx.library.receive(Readable.from(['previous unreviewed material']), { source: 'editing', filename: 'old.mp4' }, 'receiver');
  const auto = (await ctx.studio.list()).items.find(item => item.source === 'automatic');
  assert.equal(auto.status, 'pending');
  assert.match(auto.materialId, /^[a-f0-9]{32}$/);
  assert.equal(auto.sourceId, 'run-one');
  assert.equal(auto.durationSeconds, 1);
  assert.equal(auto.width, 1280);
  assert.equal(auto.height, 720);
  const confirmed = await ctx.studio.confirmBatch([auto.id], 'human-reviewer');
  assert.equal(confirmed.results[0].ok, true);
  assert.equal((await ctx.studio.list()).items.find(item => item.source === 'automatic').status, 'approved');
  const snapshot = await ctx.library.list();
  assert.equal(snapshot.pendingItems.find(item => item.id === upload.item.id).admissionStatus, 'pending');
  assert.equal(snapshot.items[0].admittedBy, 'human-reviewer');
  assert.equal(ctx.state.opened.length, 6);
});

test('embedded adapter discovery and concurrent library views import once without granting approval', async t => {
  const ctx = await fixture(t);
  const [adapter, view] = await Promise.all([
    ctx.studio.publishingLibrary.list({ items: ctx.state.items }),
    ctx.studio.list(),
  ]);
  assert.equal(adapter.items.length, 6);
  assert.equal(view.items.length, 6);
  assert.equal(ctx.state.opened.length, 6);
  assert.ok(adapter.items.every(item => item.status === 'pending' && item.materialId));
  const snapshot = await ctx.library.list();
  assert.equal(snapshot.counts.approved, 0);
  assert.equal(snapshot.pendingItems.length, 6);
  assert.ok(snapshot.pendingItems.every(item => item.receivedBy === 'video-studio-discovery' && item.admittedBy === null));
});

test('the shared materials pool retains legacy images and videos while output libraries stay source-specific', async t => {
  const ctx = await fixture(t);
  const image = (await ctx.library.receive(Readable.from(['legacy image bytes']), { source: 'editing', filename: 'previous-image.png' }, 'historical-import')).item;
  const video = (await ctx.library.receive(Readable.from(['legacy video bytes']), { source: 'creation', filename: 'previous-video.mp4' }, 'historical-import')).item;
  const rejected = (await ctx.library.receive(Readable.from(['rejected image bytes']), { source: 'creation', filename: 'rejected.png' }, 'historical-import')).item;
  await ctx.library.setAdmission(video.id, 'approved', 'previous-reviewer');
  await ctx.library.setAdmission(rejected.id, 'rejected', 'previous-reviewer');
  const shared = await ctx.studio.materials();
  assert.equal(shared.items.length, 8);
  assert.equal(new Set(shared.items.map(item => item.materialId)).size, 8);
  assert.equal(shared.items.some(item => item.materialId === rejected.id), false);
  const legacyImage = shared.items.find(item => item.materialId === image.id);
  assert.equal(legacyImage.source, 'legacy');
  assert.equal(legacyImage.originalSource, 'editing');
  assert.equal(legacyImage.libraryItem, true);
  assert.equal(legacyImage.mediaType, 'image');
  assert.equal(legacyImage.status, 'pending');
  assert.equal(legacyImage.mediaUrl, `/api/content-library/${image.id}/media`);
  assert.equal(legacyImage.videoPath, legacyImage.mediaUrl);
  assert.equal(shared.items.find(item => item.materialId === video.id).status, 'approved');
  const outputs = await ctx.studio.list();
  assert.equal(outputs.items.length, 6);
  assert.ok(outputs.items.every(item => item.source === 'mix'));
  await assert.rejects(ctx.library.publishDraft(image.id), { code: 'CONTENT_ADMISSION_REQUIRED' });
  const confirmed = await ctx.studio.confirmBatch([image.id, 'f'.repeat(32)], 'current-reviewer');
  assert.deepEqual(confirmed.results.map(item => item.ok), [true, false]);
  assert.equal(confirmed.results[0].materialId, image.id);
  assert.equal((await ctx.library.list()).items.find(item => item.id === image.id).admittedBy, 'current-reviewer');
});

test('raw library IDs cannot bypass byte verification during explicit legacy confirmation', async t => {
  const ctx = await fixture(t);
  const received = (await ctx.library.receive(Readable.from(['stored historical video']), { source: 'creation', filename: 'legacy.mp4' }, 'receiver')).item;
  await ctx.library.setAdmission(received.id, 'approved', 'reviewer');
  const draft = await ctx.library.publishDraft(received.id);
  const changed = await readFile(draft.materialPath); changed[0] ^= 1;
  await writeFile(draft.materialPath, changed);
  const shared = await ctx.studio.materials();
  assert.equal(shared.items.find(item => item.materialId === received.id).status, 'pending');
  const confirmed = await ctx.studio.confirmBatch([received.id], 'reviewer-two');
  assert.equal(confirmed.results[0].ok, false);
  assert.equal(confirmed.results[0].code, 'CONTENT_FILE_CHANGED');
});

test('confirmation requires identity and rejects paths or URLs; unavailable hosts retain automatic entries', async t => {
  const ctx = await fixture(t);
  await assert.rejects(ctx.studio.confirmBatch(['v5-01'], ''), { statusCode: 401 });
  for (const ids of [[], ['../secret'], ['https://example.com/video.mp4'], ['x'.repeat(161)], Array(101).fill('v5-01')]) {
    await assert.rejects(ctx.studio.confirmBatch(ids, 'reviewer'), { code: 'STUDIO_CONFIRM_INVALID' });
  }
  assert.deepEqual(ctx.state.opened, []);
  ctx.state.unavailable = true;
  assert.equal((await ctx.studio.list()).warnings.length, 1);
  const failed = await ctx.studio.confirmBatch(['v5-01'], 'reviewer');
  assert.equal(failed.results[0].ok, false);
  assert.equal((await ctx.library.list()).counts.approved, 0);
});

test('the HTTP source downloads only fixed listed IDs, sends If-Match, and rejects redirects or changed versions', async t => {
  const content = Buffer.from('mock video bytes');
  const item = { ...output('fixed-id', content), videoPath: 'https://foreign.invalid/private' };
  const seen = [];
  let mode = 'ok';
  const server = createServer((req, res) => {
    seen.push({ path: req.url, headers: req.headers });
    if (mode === 'redirect') { res.writeHead(302, { Location: 'https://foreign.invalid/private' }); return res.end(); }
    if (req.url === '/api/studio/outputs') { res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify({ items: [item, { ...item, id: '../escape' }] })); }
    if (mode === 'changed') { res.writeHead(409); return res.end('private response'); }
    res.setHeader('Content-Length', content.length); res.end(content);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const source = createStudioOutputSource({ upstreamUrl: `http://127.0.0.1:${server.address().port}` });
  const listed = await source.list();
  assert.equal(listed.items.length, 1);
  const opened = await source.open(listed.items[0]);
  const chunks = []; for await (const chunk of opened.stream) chunks.push(chunk);
  assert.deepEqual(Buffer.concat(chunks), content);
  assert.equal(seen[1].path, '/api/studio/outputs/fixed-id/file');
  assert.equal(seen[1].headers['if-match'], `"${item.sha256}"`);
  assert.equal(seen[1].headers.cookie, undefined);
  mode = 'changed';
  await assert.rejects(source.open(item), { code: 'CONTENT_FILE_CHANGED' });
  mode = 'redirect';
  await assert.rejects(source.list(), { statusCode: 502 });
});
