import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { Writable } from 'node:stream';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createContentLibrary, inspectContentMedia, parseContentRange } from '../src/services/content-library.js';

const fixture = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lCEAAAAASUVORK5CYII=', 'base64');
const probe = process.platform === 'darwin' ? '/opt/homebrew/bin/ffprobe' : 'ffprobe';
const ffmpeg = process.platform === 'darwin' ? '/opt/homebrew/bin/ffmpeg' : 'ffmpeg';
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

async function setup(t, options = {}) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'content-library-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'source');
  await fs.mkdir(root);
  const original = path.join(root, 'sample.png');
  await fs.writeFile(original, fixture);
  const config = { contentLibraryDir: path.join(base, 'library'), contentLibrarySignalRoot: root, contentLibraryMaxFileBytes: 1024 * 1024 };
  const entry = { source: 'automatic', sourceId: 'sample', title: '成片标题', body: '来源文案', createdAt: '2026-10-01T00:00:00Z', reviewStatus: 'selected', sourceStatus: '制作完成', artifactType: 'image', rootPath: root, filePath: original };
  const state = { entries: [entry], online: true, calls: 0, error: false };
  const collectSources = async () => {
    state.calls++;
    if (state.error) throw new Error('secret upstream path');
    return { entries: state.entries, sources: [{ id: 'automatic', online: state.online, message: '/private/secret-root' }] };
  };
  const make = (overrides = {}) => createContentLibrary(config, { collectSources, ffprobePath: probe, ...options, ...overrides });
  return { base, root, original, config, entry, state, make, library: make() };
}

class ResponseSink extends Writable {
  constructor() { super(); this.chunks = []; }
  writeHead(statusCode, headers) { this.statusCode = statusCode; this.headers = headers; }
  _write(chunk, _encoding, callback) { this.chunks.push(Buffer.from(chunk)); callback(); }
  get body() { return Buffer.concat(this.chunks); }
}
async function media(library, id, range, method = 'GET') {
  const response = new ResponseSink();
  await library.streamMedia({ method, headers: range ? { range } : {} }, response, id);
  return response;
}

test('real media import creates an immutable shared copy and unapproved publish draft', async t => {
  const ctx = await setup(t);
  const result = await ctx.library.list();
  assert.equal(result.items.length, 1);
  const item = result.items[0];
  assert.equal(item.mediaType, 'image');
  assert.equal(item.reviewStatus, 'selected');
  assert.equal(item.sourceStatus, '制作完成');
  assert.equal(item.artifactType, 'image');
  assert.equal(item.sha256, digest(await fs.readFile(ctx.original)));
  assert.doesNotMatch(JSON.stringify(result), /sourceFingerprint|filename|private\/secret-root|rootPath|filePath/);
  const draft = await ctx.library.publishDraft(item.id);
  assert.equal(draft.title, item.title);
  assert.equal(draft.requiresPrecheck, true);
  assert.equal(draft.meta.width, 1);
  assert.equal(draft.meta.height, 1);
  assert.equal(draft.meta.type, 'image');
  assert.ok(draft.materialPath.startsWith(await fs.realpath(path.join(ctx.config.contentLibraryDir, 'media')) + path.sep));
  assert.notEqual(draft.materialPath, ctx.original);
  assert.deepEqual(await fs.readFile(draft.materialPath), await fs.readFile(ctx.original));
  for (const field of ['approved', 'platforms', 'selectedPlatforms', 'sourceDeclaration', 'reviewApproved']) assert.equal(Object.hasOwn(draft, field), false);
});

test('refresh and restart preserve ids and refresh source metadata without duplicate copies', async t => {
  const ctx = await setup(t);
  const first = await ctx.library.list();
  ctx.entry.sourceStatus = '已人工挑选'; ctx.entry.body = '更新文案'; ctx.entry.reviewStatus = 'unreviewed';
  const second = await ctx.library.sync({ force: true });
  assert.equal(second.items[0].id, first.items[0].id);
  assert.equal(second.items[0].sourceStatus, '已人工挑选');
  assert.equal(second.items[0].body, '更新文案');
  assert.equal(second.items[0].reviewStatus, 'unreviewed');
  const restarted = await ctx.make().list();
  assert.equal(restarted.items[0].id, first.items[0].id);
  assert.equal((await fs.readdir(path.join(ctx.config.contentLibraryDir, 'media'))).length, 1);
});

test('changed source creates a new version while previous media survives source disappearance', async t => {
  const ctx = await setup(t);
  const first = (await ctx.library.list()).items[0];
  const firstDraft = await ctx.library.publishDraft(first.id);
  const originalBytes = await fs.readFile(firstDraft.materialPath);
  await fs.appendFile(ctx.original, Buffer.from('version-2'));
  const second = await ctx.library.sync({ force: true });
  assert.equal(second.items.length, 2);
  assert.equal(new Set(second.items.map(item => item.id)).size, 2);
  assert.deepEqual(await fs.readFile(firstDraft.materialPath), originalBytes);
  ctx.state.error = true;
  await fs.rm(ctx.root, { recursive: true });
  const offline = await ctx.make().list();
  assert.equal(offline.items.length, 2);
  assert.equal(offline.sources[0].online, false);
  assert.doesNotMatch(JSON.stringify(offline), /secret upstream/);
  assert.equal((await ctx.library.publishDraft(first.id)).sha256, first.sha256);
});

test('concurrent list requests share synchronization and force bypasses cached snapshot', async t => {
  const ctx = await setup(t);
  const snapshots = await Promise.all([ctx.library.list(), ctx.library.list(), ctx.library.list()]);
  assert.equal(ctx.state.calls, 1);
  assert.deepEqual(snapshots[0], snapshots[1]);
  await ctx.library.list(); assert.equal(ctx.state.calls, 1);
  await ctx.library.sync({ force: true }); assert.equal(ctx.state.calls, 2);
});

test('bounded synchronization progresses past forty entries and revisits cached source state', async t => {
  const ctx = await setup(t);
  ctx.state.entries = Array.from({ length: 83 }, (_, index) => ({ ...ctx.entry, sourceId: `item-${index}` }));
  assert.equal((await ctx.library.list()).items.length, 40);
  assert.equal((await ctx.library.sync({ force: true })).items.length, 80);
  assert.equal((await ctx.library.sync({ force: true })).items.length, 83);
  ctx.state.entries[80].sourceStatus = '后来选中';
  await ctx.library.sync({ force: true });
  const refreshed = await ctx.library.sync({ force: true });
  assert.equal(refreshed.items.find(item => item.sourceId === 'item-80').sourceStatus, '后来选中');
  assert.equal((await fs.readdir(path.join(ctx.config.contentLibraryDir, 'media'))).length, 1);
});

test('a full catalog still refreshes existing metadata and reports pending new entries', async t => {
  const ctx = await setup(t);
  await ctx.library.list();
  const catalogPath = path.join(ctx.config.contentLibraryDir, 'catalog.json');
  const catalog = JSON.parse(await fs.readFile(catalogPath, 'utf8'));
  const original = catalog.items[0];
  catalog.items = Array.from({ length: 1000 }, (_, index) => index === 0 ? original : { ...original, id: digest(String(index)).slice(0, 32), sourceId: `seed-${index}` });
  await fs.writeFile(catalogPath, JSON.stringify(catalog));
  ctx.entry.sourceStatus = '已更新';
  ctx.state.entries.push({ ...ctx.entry, sourceId: 'new-item' });
  const result = await ctx.make().list();
  assert.equal(result.items.length, 1000);
  assert.equal(result.items.find(item => item.id === original.id).sourceStatus, '已更新');
  assert.equal(result.sources[0].pendingCount, 1);
});

test('bad files, wrong roots and escaping symlinks are isolated from valid siblings', async t => {
  const ctx = await setup(t);
  const outside = path.join(ctx.base, 'outside.png'); await fs.writeFile(outside, fixture);
  const empty = path.join(ctx.root, 'empty.png'); await fs.writeFile(empty, '');
  const invalid = path.join(ctx.root, 'invalid.png'); await fs.writeFile(invalid, 'this is not a PNG');
  const link = path.join(ctx.root, 'escape.png'); await fs.symlink(outside, link);
  const large = path.join(ctx.root, 'large.png'); await fs.writeFile(large, Buffer.alloc(1024 * 1024 + 1));
  ctx.state.entries.push(...[
    { filePath: outside }, { filePath: empty }, { filePath: invalid }, { filePath: link }, { filePath: large },
    { rootPath: ctx.base }, { filePath: 'https://example.com/image.png' },
  ].map((fields, index) => ({ ...ctx.entry, sourceId: `bad-${index}`, ...fields })));
  const result = await ctx.library.list();
  assert.equal(result.items.length, 1);
  assert.equal(result.sources[0].rejectedCount, 7);
  assert.equal((await fs.readdir(path.join(ctx.config.contentLibraryDir, 'media'))).length, 1);
});

test('failed probe removes temporary files and never creates an item', async t => {
  const ctx = await setup(t, { inspectMedia: async () => { throw new Error('probe failed /secret'); } });
  const result = await ctx.library.list();
  assert.deepEqual(result.items, []);
  assert.equal(result.sources[0].rejectedCount, 1);
  assert.deepEqual(await fs.readdir(path.join(ctx.config.contentLibraryDir, 'media')), []);
  assert.doesNotMatch(JSON.stringify(result), /secret|probe failed/);
});

test('media supports exact GET, HEAD, open-ended and suffix ranges, and rejects invalid ranges', async t => {
  const ctx = await setup(t);
  const item = (await ctx.library.list()).items[0];
  const bytes = await fs.readFile(ctx.original);
  const full = await media(ctx.library, item.id);
  assert.equal(full.statusCode, 200); assert.deepEqual(full.body, bytes);
  assert.equal(full.headers['Cache-Control'], 'private, no-store');
  assert.equal(full.headers['X-Content-Type-Options'], 'nosniff');
  for (const [range, expected] of [['bytes=0-9', bytes.subarray(0, 10)], ['bytes=10-', bytes.subarray(10)], ['bytes=-8', bytes.subarray(-8)]]) {
    const part = await media(ctx.library, item.id, range);
    assert.equal(part.statusCode, 206); assert.deepEqual(part.body, expected);
    assert.match(part.headers['Content-Range'], /^bytes \d+-\d+\/\d+$/);
  }
  const head = await media(ctx.library, item.id, 'bytes=1-3', 'HEAD');
  assert.equal(head.statusCode, 206); assert.equal(head.body.length, 0); assert.equal(head.headers['Content-Length'], 3);
  for (const range of ['bytes=999999-', 'bytes=10-2', 'bytes=0-1,3-4', 'bytes=-0', 'garbage']) {
    const invalid = await media(ctx.library, item.id, range);
    assert.equal(invalid.statusCode, 416); assert.equal(invalid.body.length, 0);
  }
});

test('publish draft detects same-size tampering and refuses stored symlinks', async t => {
  const ctx = await setup(t);
  const item = (await ctx.library.list()).items[0];
  const draft = await ctx.library.publishDraft(item.id);
  const bytes = await fs.readFile(draft.materialPath); bytes[bytes.length - 1] ^= 1;
  await fs.writeFile(draft.materialPath, bytes);
  await assert.rejects(ctx.library.publishDraft(item.id), { code: 'CONTENT_FILE_CHANGED' });
  await fs.rm(draft.materialPath); await fs.symlink(ctx.original, draft.materialPath);
  await assert.rejects(ctx.library.publishDraft(item.id), { code: 'CONTENT_FILE_UNAVAILABLE' });
  await assert.rejects(ctx.library.publishDraft('../escape'), { statusCode: 404 });
});

test('corrupt persisted catalog fails closed and remains unchanged', async t => {
  const ctx = await setup(t);
  await fs.mkdir(ctx.config.contentLibraryDir);
  const catalogPath = path.join(ctx.config.contentLibraryDir, 'catalog.json');
  await fs.writeFile(catalogPath, '{not-json');
  await assert.rejects(ctx.library.list(), { code: 'CONTENT_LIBRARY_INVALID' });
  assert.equal(await fs.readFile(catalogPath, 'utf8'), '{not-json');
  assert.equal(ctx.state.calls, 0);
});

test('video detection verifies actual container and track, supporting library-only M4V', async t => {
  const ctx = await setup(t);
  const video = path.join(ctx.root, 'final.m4v');
  await promisify(execFile)(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=64x64:r=5', '-t', '1', '-c:v', 'mpeg4', '-f', 'mp4', video], { timeout: 10000 });
  const metadata = await inspectContentMedia(video, { ffprobePath: probe });
  assert.equal(metadata.type, 'video'); assert.ok(metadata.durationSeconds > 0);
  ctx.config.contentLibraryMaxFileBytes = 10 * 1024 * 1024;
  ctx.state.entries = [{ ...ctx.entry, filePath: video, artifactType: 'video_clip' }];
  const library = ctx.make();
  const result = await library.list();
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].mimeType, 'video/x-m4v');
  await assert.rejects(library.publishDraft(result.items[0].id), { code: 'CONTENT_PUBLISH_FORMAT_UNSUPPORTED' });
  const fake = path.join(ctx.root, 'fake.mp4'); await fs.writeFile(fake, fixture);
  await assert.rejects(inspectContentMedia(fake, { ffprobePath: probe }), { code: 'CONTENT_MEDIA_INVALID' });
});

test('range parser clamps ends and refuses unsafe integers', () => {
  assert.deepEqual(parseContentRange('bytes=0-100', 20), { status: 206, start: 0, end: 19 });
  assert.deepEqual(parseContentRange('bytes=-100', 20), { status: 206, start: 0, end: 19 });
  assert.equal(parseContentRange('bytes=9007199254740992-', 20), null);
  assert.equal(parseContentRange('bytes=-9007199254740992', 20), null);
});
