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
  const options = { collectSources: async () => ({ entries, sources: [] }), cacheMs: 0, inspectMedia: async () => ({ type: 'video', durationSeconds: 1 }) };
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
  assert.ok(initial.items.every(item => item.status === 'pending' && !item.materialId));
  assert.deepEqual(ctx.state.opened, []);
  assert.equal((await ctx.library.list()).counts.total, 0);
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
  assert.deepEqual((await ctx.library.list()).counts, { total: 1, approved: 1, pending: 0, rejected: 0 });
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
  assert.deepEqual((await ctx.library.list()).counts, { total: 2, approved: 2, pending: 0, rejected: 0 });
  assert.equal((await ctx.studio.list()).items.find(item => item.id === 'v5-02').status, 'pending');
});

test('a new byte version requires a new confirmation and never inherits prior approval', async t => {
  const ctx = await fixture(t);
  const old = (await ctx.studio.confirmBatch(['v5-01'], 'reviewer')).results[0].materialId;
  ctx.bytes.set('v5-01', Buffer.from('new finished video version'));
  ctx.state.items[0] = output('v5-01', ctx.bytes.get('v5-01'));
  const current = (await ctx.studio.list()).items.find(item => item.id === 'v5-01');
  assert.equal(current.status, 'pending');
  assert.equal(current.materialId, undefined);
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
  assert.equal(offline.items.length, 1);
  assert.equal(offline.items[0].id, 'v5-01');
  assert.equal(offline.items[0].status, 'approved');
  assert.equal(offline.items[0].materialId, materialId);
  assert.equal(offline.items[0].videoPath, `/api/content-library/${materialId}/media`);
  assert.match(offline.warnings[0], /仍可查看已保存/);
  ctx.state.unavailable = false;
  ctx.bytes.set('v5-01', Buffer.from('new online version awaits approval'));
  ctx.state.items[0] = output('v5-01', ctx.bytes.get('v5-01'));
  const online = await ctx.studio.list();
  const versions = online.items.filter(item => item.id === 'v5-01');
  assert.equal(versions.length, 1);
  assert.equal(versions[0].status, 'pending');
  assert.equal(versions[0].materialId, undefined);
  assert.equal(versions[0].sha256, ctx.state.items[0].sha256);
  assert.equal(online.warnings, undefined);
});

test('local fallback skips corrupted copies and permits explicit confirmation of a retained pending output', async t => {
  const ctx = await fixture(t);
  const materialId = (await ctx.studio.confirmBatch(['v5-01'], 'reviewer')).results[0].materialId;
  await ctx.library.setAdmission(materialId, 'pending', 'reviewer');
  ctx.state.items = [];
  const pending = (await ctx.studio.list()).items[0];
  assert.equal(pending.id, 'v5-01');
  assert.equal(pending.status, 'pending');
  const openedBefore = ctx.state.opened.length;
  assert.equal((await ctx.studio.confirmBatch(['v5-01'], 'reviewer-two')).results[0].materialId, materialId);
  assert.equal(ctx.state.opened.length, openedBefore);
  const draft = await ctx.library.publishDraft(materialId);
  const bytes = await readFile(draft.materialPath); bytes[0] ^= 1;
  await writeFile(draft.materialPath, bytes);
  assert.deepEqual((await ctx.studio.list()).items, []);
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
  const confirmed = await ctx.studio.confirmBatch([auto.id], 'human-reviewer');
  assert.equal(confirmed.results[0].ok, true);
  assert.equal((await ctx.studio.list()).items.find(item => item.source === 'automatic').status, 'approved');
  const snapshot = await ctx.library.list();
  assert.equal(snapshot.pendingItems.find(item => item.id === upload.item.id).admissionStatus, 'pending');
  assert.equal(snapshot.items[0].admittedBy, 'human-reviewer');
  assert.deepEqual(ctx.state.opened, []);
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
