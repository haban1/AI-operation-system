import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { Readable } from 'node:stream';
import sharp from 'sharp';
import { createWorkbench } from '../engines/montage15/src/server.mjs';
import { BrowserFolders, folderLimits } from '../engines/montage15/src/browser-folders.mjs';
import { Store } from '../engines/montage15/src/store.mjs';

test('browser folder import persists nested media and feeds projects without native picker', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'montage-folder-'));
  const app = await createWorkbench({ dataDir: dir });
  const server = http.createServer(app.handle);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await app.close(); await fs.rm(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const boot = await (await fetch(base + '/api/bootstrap')).json();
  const png = await sharp({ create: { width: 64, height: 48, channels: 3, background: '#287b77' } }).png().toBuffer();
  const second = await sharp({ create: { width: 64, height: 48, channels: 3, background: '#ac7623' } }).png().toBuffer();
  async function request(url, { body, method = 'GET', headers = {}, status = 200 } = {}) {
    const r = await fetch(base + url, { method, headers: { Origin: base, 'x-workbench-token': boot.sessionToken, 'Content-Type': Buffer.isBuffer(body) ? 'application/octet-stream' : 'application/json', ...headers }, body: body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body) });
    const data = await r.json(); assert.equal(r.status, status, JSON.stringify(data)); return data;
  }
  await request('/api/source-folders/upload', { method: 'POST', body: { name: 'fixture', fileCount: 1, totalBytes: png.length }, headers: { 'x-workbench-token': '' }, status: 403 });
  await request('/api/source-folders/upload', { method: 'POST', body: { name: 'fixture', fileCount: 1, totalBytes: png.length }, headers: { Origin: 'https://foreign.invalid' }, status: 403 });
  const { source } = await request('/api/source-folders/upload', { method: 'POST', body: { name: '素材 <测试>', fileCount: 2, totalBytes: png.length + second.length }, status: 201 });
  const upload = source.id;
  assert.equal(source.status, 'uploading');
  for (const filename of ['../outside.png', '/absolute.png', 'C:\\secret.png', 'folder//image.png', '.hidden/image.png', 'folder/app.js']) {
    await request(`/api/source-folders/${upload}/files`, { method: 'POST', headers: { 'x-file-name': encodeURIComponent(filename) }, body: png, status: 422 });
  }
  for (const [filename, bytes] of [['一/照片.png', png], ['二/照片.png', second]]) await request(`/api/source-folders/${upload}/files`, { method: 'POST', headers: { 'x-file-name': encodeURIComponent(filename) }, body: bytes, status: 201 });
  await request(`/api/source-folders/${upload}/files`, { method: 'POST', headers: { 'x-file-name': encodeURIComponent('一/照片.png') }, body: png, status: 409 });
  await request(`/api/source-folders/${upload}/scan`, { method: 'POST', body: {}, status: 202 });
  await app.sources.running.get(upload);
  const indexed = await request(`/api/source-folders/${upload}`);
  assert.equal(indexed.source.status, 'ready');
  assert.equal(indexed.source.count, 2);
  const { items } = await request(`/api/source-folders/${upload}/items`);
  assert.equal(items.length, 2);
  const { asset } = await request(`/api/source-folders/${upload}/import`, { method: 'POST', body: { id: items[0].id } });
  assert.equal(asset.type, 'image');
  const project = await request('/api/projects', { method: 'POST', body: { name: '测试工程', templateId: 'perspective-flow', format: 'landscape', sourceId: upload }, status: 201 });
  assert.equal(project.project.brief.sourceId, upload);
  const restarted = await createWorkbench({ dataDir: dir });
  await restarted.close();
  assert.equal((await restarted.sources.list())[0].count, 2);
  assert.deepEqual(await fs.readFile(path.join(dir, 'source-uploads', upload, '一', '照片.png')), png);
  await request(`/api/source-folders/${upload}/files`, { method: 'POST', headers: { 'x-file-name': 'after.png' }, body: png, status: 409 });
});

test('browser folder limits and interrupted uploads keep quotas and temporary files consistent', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'montage-folder-limits-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const store = new Store(dir); await store.init();
  const folders = new BrowserFolders(store);
  for (const input of [{ name: '../escape', fileCount: 1, totalBytes: 1 }, { name: 'fixture', fileCount: 5001, totalBytes: 1 }, { name: 'fixture', fileCount: 1, totalBytes: folderLimits.totalBytes + 1 }, { name: 'fixture', fileCount: 1, totalBytes: 1, folderPath: '/tmp' }]) {
    await assert.rejects(folders.create(input), { code: 'INVALID_FOLDER_UPLOAD' });
  }
  const source = await folders.create({ name: 'fixture', fileCount: 1, totalBytes: 3 });
  const req = (chunks, length) => { const stream = Readable.from(chunks); stream.headers = { 'x-file-name': 'photo.png', ...(length === undefined ? {} : { 'content-length': length }) }; return stream; };
  await assert.rejects(folders.receive(source.id, req([Buffer.from('1234')], 4)), { code: 'FOLDER_SIZE_LIMIT' });
  await assert.rejects(folders.receive(source.id, req([Buffer.from('1234')])), { code: 'FOLDER_SIZE_LIMIT' });
  assert.equal((await store.get('source-folders', source.id)).receivedBytes, 0);
  assert.deepEqual(await fs.readdir(path.join(dir, 'tmp')), []);
  const interrupted = Readable.from((async function* () { yield Buffer.from('1'); throw new Error('connection interrupted'); })());
  interrupted.headers = { 'x-file-name': 'photo.png' };
  await assert.rejects(folders.receive(source.id, interrupted), /connection interrupted/);
  assert.equal((await store.get('source-folders', source.id)).uploadedCount, undefined);
  assert.deepEqual(await fs.readdir(path.join(dir, 'tmp')), []);
  await folders.receive(source.id, req([Buffer.from('123')]));
  assert.equal((await store.get('source-folders', source.id)).receivedBytes, 3);
  assert.equal((await store.get('source-folders', source.id)).uploads.length, 1);
});
