import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createStudio, normalizeInput, normalizeScript, parseModelScript } from '../core.js';
import { createStudioServer, rangeBounds } from '../server.js';
import { renderVideo, runCommand } from '../render.js';

const script = { title: '社区服务小贴士', summary: '介绍服务咨询的准备事项', scenes: [
  { heading: '准备问题', text: '出发前列好需要咨询的问题。', narration: '出发前列好问题。', seconds: 4 },
  { heading: '核对信息', text: '具体办理条件，以工作人员确认的信息为准。', narration: '具体条件请核对。', seconds: 4 },
] };
const input = () => ({ topic: '社区服务', requestId: randomUUID() });
const root = () => mkdtemp(path.join(os.tmpdir(), 'tianhe-studio-test-'));
async function until(fn) { for (let i = 0; i < 100; i++) { if (await fn()) return; await delay(20); } throw new Error('Condition timed out'); }
const model = async () => Response.json({ choices: [{ message: { content: JSON.stringify(script) } }] });

test('invalid script and input cannot reach video rendering', () => {
  assert.throws(() => normalizeInput({ ...input(), ratio: '../escape' }));
  assert.throws(() => normalizeInput({ topic: 'x' }));
  assert.throws(() => normalizeScript({ title: 'x', scenes: [] }));
  assert.throws(() => normalizeScript({ ...script, scenes: script.scenes.map(s => ({ ...s, seconds: 999 })) }));
  assert.throws(() => parseModelScript('not JSON'));
  assert.deepEqual(parseModelScript('```json\n' + JSON.stringify(script) + '\n```'), script);
});

test('duplicate submissions call the model once; stale edits and double render are rejected', async t => {
  let calls = 0; let release;
  const studio = await createStudio({ root: await root(), modelBase: 'http://model', modelToken: 'internal', fetchImpl: async (_url, opts) => {
    calls++; const payload = JSON.parse(opts.body); assert.equal(payload.model, 'tianhe-workbench-chat'); assert.equal(opts.headers.Authorization, 'Bearer internal'); return model();
  }, renderer: async () => new Promise(resolve => { release = resolve; }) });
  t.after(() => studio.close());
  const data = input(); const [a, b] = await Promise.all([studio.create(data), studio.create(data)]);
  assert.equal(a.id, b.id); await until(() => studio.get(a.id).status === 'draft'); assert.equal(calls, 1);
  const current = studio.get(a.id);
  await assert.rejects(studio.saveScript(a.id, { script, revision: current.revision - 1 }), /已更新/);
  await studio.render(a.id, current.revision); await until(() => release);
  await assert.rejects(studio.render(a.id, current.revision), /运行/);
  release({ duration: 8 }); await until(() => studio.get(a.id).status === 'completed');
});

test('cancel stops an active model request; cancelled tasks cannot become completed', async t => {
  let started = false;
  const studio = await createStudio({ root: await root(), modelBase: 'http://model', modelToken: 'token', fetchImpl: async (_url, options) => {
    started = true; await delay(10000, null, { signal: options.signal }); return model();
  } }); t.after(() => studio.close());
  const project = await studio.create(input()); await until(() => started);
  await studio.cancel(project.id); await delay(50); assert.equal(studio.get(project.id).status, 'cancelled');
});

test('restart retains drafts and interrupts queued work without calling model again', async t => {
  const directory = await root(); await mkdir(path.join(directory, 'projects'));
  const id = randomUUID(); await writeFile(path.join(directory, 'projects', `${id}.json`), JSON.stringify({ id, ...input(), status: 'rendering', script, revision: 3, createdAt: new Date().toISOString() }));
  const studio = await createStudio({ root: directory, fetchImpl: () => { throw new Error('Must not replay'); } }); t.after(() => studio.close());
  assert.equal(studio.get(id).status, 'interrupted'); assert.deepEqual(studio.get(id).script, script);
});

test('HTTP requires service auth, keeps health public and validates ranges', async t => {
  const { server, studio } = await createStudioServer({ root: await root(), token: 'service-token', modelBase: 'http://model', modelToken: 'model-token', fetchImpl: model });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await studio.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(base + '/api/health')).status, 200);
  assert.equal((await fetch(base + '/api/projects')).status, 401);
  assert.equal((await fetch(base + '/api/projects', { headers: { Authorization: 'Bearer service-token' } })).status, 200);
  assert.equal((await fetch(base + '/api/projects?url=http://evil', { headers: { Authorization: 'Bearer service-token' } })).status, 400);
  assert.deepEqual(rangeBounds('bytes=-10', 100), { start: 90, end: 99, partial: true });
  assert.deepEqual(rangeBounds('bytes=0-999', 100), { start: 0, end: 99, partial: true });
  assert.throws(() => rangeBounds('bytes=100-', 100)); assert.throws(() => rangeBounds('bytes=0-1,3-4', 100));
});

test('real renderer validates an H264 MP4, local voice, subtitles and complete output marker', { skip: process.env.STUDIO_RENDER_TEST !== '1', timeout: 120000 }, async () => {
  const directory = path.join(await root(), 'run-test');
  const project = { id: randomUUID(), ratio: 'square', theme: 'forest', voice: true, script: { ...script, scenes: script.scenes.map(s => ({ ...s, text: s.text + ' 100% %{n} : [安全文本]' })) } };
  const result = await renderVideo({ directory, project, signal: new AbortController().signal });
  assert.equal(result.width, 720); assert.equal(result.height, 720); assert.ok(result.duration >= 8);
  const validation = JSON.parse(await readFile(path.join(directory, 'validation.json'), 'utf8')); assert.equal(validation.full_decode, 'passed');
  assert.match(await readFile(path.join(directory, 'subtitles.srt'), 'utf8'), /00:00:00,000/);
  const probe = JSON.parse(await runCommand('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', path.join(directory, 'video.mp4')]));
  assert.ok(probe.streams.some(s => s.codec_name === 'aac'));
});
