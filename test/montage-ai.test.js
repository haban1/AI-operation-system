import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { createProject, editProject, AppError } from '../engines/montage15/src/domain.mjs';
import { templates } from '../engines/montage15/src/templates.mjs';
import { applyAiPlan, buildAiContext, AiEditing } from '../engines/montage15/src/ai-editing.mjs';
import { Store } from '../engines/montage15/src/store.mjs';
import { createWorkbench } from '../engines/montage15/src/server.mjs';
import { templateAudio } from '../engines/montage15/src/audio.mjs';

const template = templates.find(item => item.id === 'perspective-flow');
const assets = [
  { id: 'classroom', name: '课堂全景.mp4', type: 'video', duration: 20, width: 1920, height: 1080, subject: '周周有课', description: '讲师与课堂全景', tags: ['全景', '讲师'], mediaSha256: '1'.repeat(64) },
  { id: 'practice', name: '动手实践.jpg', type: 'image', duration: null, width: 1920, height: 1080, subject: '周周有课', description: '学员动手实践近景', tags: ['实践', '近景'], mediaSha256: '2'.repeat(64) },
  { id: 'other-product', name: '其他商品.jpg', type: 'image', duration: null, width: 1920, height: 1080, subject: '其他商品', mediaSha256: '3'.repeat(64) },
  { id: 'too-short', name: '短视频.mp4', type: 'video', duration: 1, width: 1920, height: 1080, subject: '周周有课', mediaSha256: '4'.repeat(64) },
];
const emptyLocks = () => ({ slots: [], fields: [], audio: false, settings: [] });
function project() {
  const value = createProject(template, { name: 'AI 制作验证', format: 'landscape' });
  value.settings.colorCards = false;
  value.brief = { request: '制作 15 秒课堂回顾，展示讲解与实践', facts: '活动名称为周周有课', subject: '周周有课', assetIds: assets.map(asset => asset.id) };
  value.locks = emptyLocks();
  return value;
}
const operation = (type, target, patch) => ({ type, target, assetId: null, text: null, inPoint: null, focusX: null, focusY: null, number: null, enabled: null, ...patch });
const field = text => operation('field', 'title', { text });
const slot = (target, assetId, inPoint = 0) => operation('slot', target, { assetId, inPoint, focusX: .5, focusY: .5 });
const plan = operations => ({ message: '已按要求更新', warnings: [], operations });
const run = (patch = {}) => ({ id: randomUUID(), mode: 'instruction', instruction: '调整工程、文案与音乐', scope: { kind: 'instruction', ids: [] }, ...patch });

test('AI chooses only the selected subject and prompt context contains no media paths', () => {
  const current = project();
  const context = buildAiContext(current, assets.map(asset => ({ ...asset, mediaFile: '/private/media', sourceFile: '/private/original' })), run());
  assert.ok(context.assets.some(asset => asset.id === 'classroom'));
  assert.ok(!context.assets.some(asset => asset.id === 'other-product'));
  assert.doesNotMatch(JSON.stringify(context), /mediaFile|sourceFile|\/private\//);
  assert.throws(() => applyAiPlan(current, assets, run(), plan([slot('shot-1', 'other-product')])), { code: 'AI_INVALID_ASSET' });
  current.brief.assetIds = ['practice'];
  assert.throws(() => applyAiPlan(current, assets, run(), plan([slot('shot-1', 'classroom')])), { code: 'AI_INVALID_ASSET' });
});

test('AI draft fills every slot and validates source in-points without changing the original', () => {
  const current = project();
  const original = structuredClone(current);
  const result = applyAiPlan(current, assets, run({ mode: 'generate', scope: { kind: 'all', ids: [] } }), plan([
    ...current.slots.map((item, index) => slot(item.id, index % 2 ? 'practice' : 'classroom', index % 2 ? 0 : index)), field('周周有课'),
  ]));
  assert.equal(result.project.revision, current.revision + 1);
  assert.equal(result.project.slots.filter(item => item.assetId).length, 7);
  assert.deepEqual(current, original);
  assert.throws(() => applyAiPlan(current, assets, run(), plan([slot('shot-1', 'too-short')])), { code: 'SHORT_ASSET' });
  assert.throws(() => applyAiPlan(current, assets, run(), plan([slot('shot-1', 'classroom', 19)])), { code: 'SHORT_ASSET' });
  assert.throws(() => applyAiPlan(current, assets, run({ mode: 'generate' }), plan([field('周周有课')])), { code: 'AI_INCOMPLETE_DRAFT' });
});

test('locks and regeneration scope protect manual work across fields, footage, music and motion', () => {
  for (const [locks, change] of [
    [{ ...emptyLocks(), fields: ['title'] }, field('周周有课')],
    [{ ...emptyLocks(), slots: ['shot-1'] }, slot('shot-1', 'practice')],
    [{ ...emptyLocks(), audio: true }, operation('audio', 'volume', { number: .4 })],
    [{ ...emptyLocks(), settings: ['intensity'] }, operation('setting', 'intensity', { number: .3 })],
  ]) {
    const current = project(); current.locks = locks;
    assert.throws(() => applyAiPlan(current, assets, run(), plan([change])), { code: 'AI_LOCKED' });
  }
  assert.throws(() => applyAiPlan(project(), assets, run({ scope: { kind: 'slots', ids: ['shot-3'] } }), plan([field('周周有课')])), { code: 'AI_SCOPE_VIOLATION' });
  const current = project();
  const result = applyAiPlan(current, assets, run({ scope: { kind: 'slots', ids: ['shot-3'] } }), plan([slot('shot-3', 'practice')]));
  assert.deepEqual(result.project.fields, current.fields);
  assert.deepEqual(result.project.slots.filter(item => item.id !== 'shot-3'), current.slots.filter(item => item.id !== 'shot-3'));
});

test('invalid AI operations and unsupported numeric facts never mutate the project', () => {
  const current = project();
  for (const invalid of [
    plan([field('只需 999 元')]), plan([field('a'.repeat(29))]),
    plan([operation('setting', 'colorCards', { enabled: true })]),
    plan([operation('audio', 'track', { text: '../../private' })]),
    plan([field('周周有课'), field('第二标题')]),
    plan([{ ...field('周周有课'), shell: 'touch /tmp/never' }]),
  ]) assert.throws(() => applyAiPlan(current, assets, run(), invalid));
  assert.equal(current.revision, 1);
  assert.equal(current.fields.title, template.defaults.title);
});

test('music replacement retains template sound effects and remains editable after save', () => {
  const current = project();
  const result = applyAiPlan(current, assets, run({ scope: { kind: 'audio', ids: [] } }), plan([
    operation('audio', 'track', { text: 'focus-story', inPoint: 0 }), operation('audio', 'volume', { number: .35 }),
  ]));
  const tracks = templateAudio(template, result.project);
  assert.equal(tracks.find(track => track.role === 'music').file, 'focus-story-music.wav');
  assert.equal(tracks.find(track => track.role === 'sfx').file, 'perspective-flow-sfx.wav');
  assert.equal(result.project.audio.volume, .35);
  assert.equal(editProject(result.project, { expectedRevision: 2 }, template, assets).audio.trackId, 'focus-story');
});

async function queueFixture(t, handler) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'montage-ai-queue-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new Store(directory); await store.init();
  for (const asset of assets) await store.put('assets', asset);
  const current = project(); await store.saveProject(current);
  const planner = { status: async () => ({ available: true }), plan: handler };
  const ai = new AiEditing({ store, planner }); await ai.init();
  const input = { expectedRevision: 1, mode: 'instruction', instruction: '把标题改为周周有课', scope: { kind: 'fields', ids: ['title'] }, requestId: randomUUID() };
  async function finished(id) {
    for (let count = 0; count < 200; count += 1) {
      const saved = await store.get('ai-runs', id);
      if (!['queued', 'running'].includes(saved.status)) return saved;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.fail('AI task did not finish');
  }
  return { ai, store, current, input, finished };
}

test('real queue applies once, deduplicates retry after success and retains revision provenance', async t => {
  let calls = 0;
  const ctx = await queueFixture(t, async () => { calls += 1; return plan([field('周周有课')]); });
  const first = await ctx.ai.enqueue(ctx.current, assets, ctx.input);
  const final = await ctx.finished(first.id);
  assert.equal(final.status, 'succeeded');
  const saved = await ctx.store.get('projects', ctx.current.id);
  assert.equal(saved.revision, 2); assert.equal(saved.editSource, 'ai');
  assert.equal((await ctx.ai.enqueue(saved, assets, ctx.input)).id, first.id);
  assert.equal(calls, 1);
  assert.equal((await ctx.store.revision(saved.id, 1)).fields.title, template.defaults.title);
});

test('a concurrent manual edit wins and stale AI output remains unapplied', async t => {
  let release;
  const ctx = await queueFixture(t, () => new Promise(resolve => { release = resolve; }));
  const first = await ctx.ai.enqueue(ctx.current, assets, ctx.input);
  while (!release) await new Promise(resolve => setTimeout(resolve, 5));
  await ctx.store.saveProject(editProject(ctx.current, { expectedRevision: 1, fields: { ...ctx.current.fields, title: '人工已确认' } }, template, assets));
  release(plan([field('周周有课')]));
  assert.equal((await ctx.finished(first.id)).status, 'conflict');
  assert.equal((await ctx.store.get('projects', ctx.current.id)).fields.title, '人工已确认');
});

test('cancellation and provider failure retain the last saved project', async t => {
  const ctx = await queueFixture(t, (_context, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new AppError(409, 'AI_CANCELLED', 'cancelled')), { once: true })));
  const first = await ctx.ai.enqueue(ctx.current, assets, ctx.input);
  while ((await ctx.store.get('ai-runs', first.id)).status !== 'running') await new Promise(resolve => setTimeout(resolve, 5));
  await ctx.ai.cancel(first.id);
  assert.equal((await ctx.finished(first.id)).status, 'cancelled');
  assert.equal((await ctx.store.get('projects', ctx.current.id)).revision, 1);
  ctx.ai.planner.plan = async () => { throw new Error('/private/provider-auth-token'); };
  const retry = await ctx.ai.enqueue(ctx.current, assets, { ...ctx.input, requestId: randomUUID() });
  const failed = await ctx.finished(retry.id);
  assert.equal(failed.status, 'failed'); assert.doesNotMatch(failed.error, /private|token/);
  assert.equal((await ctx.store.get('projects', ctx.current.id)).revision, 1);
});

test('changed asset descriptions invalidate an in-flight selection', async t => {
  let release;
  const ctx = await queueFixture(t, () => new Promise(resolve => { release = resolve; }));
  const first = await ctx.ai.enqueue(ctx.current, assets, ctx.input);
  while (!release) await new Promise(resolve => setTimeout(resolve, 5));
  await ctx.store.put('assets', { ...assets[0], notesRevision: 1, description: '已更新说明' });
  release(plan([field('周周有课')]));
  assert.equal((await ctx.finished(first.id)).code, 'AI_ASSETS_CHANGED');
  assert.equal((await ctx.store.get('projects', ctx.current.id)).revision, 1);
});

test('restart reconciles an applied AI revision even when its final status write was interrupted', async t => {
  const ctx = await queueFixture(t, async () => plan([field('周周有课')]));
  const started = await ctx.ai.enqueue(ctx.current, assets, ctx.input);
  const finished = await ctx.finished(started.id);
  await ctx.store.put('ai-runs', { ...finished, status: 'running', message: '状态写入前重启' });
  const restarted = new AiEditing({ store: ctx.store, planner: ctx.ai.planner });
  await restarted.init();
  assert.equal((await ctx.store.get('ai-runs', started.id)).status, 'succeeded');
  assert.equal((await ctx.store.get('projects', ctx.current.id)).revision, 2);
  const interrupted = { ...finished, id: randomUUID(), status: 'running', resultRevision: null };
  await ctx.store.put('ai-runs', interrupted);
  await restarted.init();
  assert.equal((await ctx.store.get('ai-runs', interrupted.id)).code, 'AI_INTERRUPTED');
});

test('HTTP template selection, revision restore and AI editing persist through engine restart', { timeout: 30000 }, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'montage-ai-http-'));
  const options = { dataDir: directory, mountPath: '/video-workbench/montage', templateIds: ['perspective-flow'], planner: { status: async () => ({ available: true }), plan: async () => plan([field('周周有课')]) } };
  let app = await createWorkbench(options);
  const server = http.createServer((request, response) => app.handle(request, response));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await fs.rm(directory, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}/video-workbench/montage`;
  let token = (await (await fetch(base + '/api/bootstrap')).json()).sessionToken;
  async function request(route, method = 'GET', body, expected = 200) {
    const response = await fetch(base + route, { method, headers: { 'x-workbench-token': token, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const value = await response.json(); assert.equal(response.status, expected, JSON.stringify(value)); return value;
  }
  const catalog = (await request('/api/templates')).templates;
  assert.equal(catalog.length, 5); assert.equal(catalog.filter(item => item.enabled).length, 1);
  const second = catalog.find(item => item.id === 'film-strip');
  await request('/api/templates/film-strip/availability', 'POST', { enabled: true, version: 'old-version' }, 409);
  await request('/api/templates/film-strip/availability', 'POST', { enabled: true, version: second.version });
  let current = (await request('/api/projects', 'POST', { name: '版本恢复', templateId: 'film-strip', format: 'landscape' }, 201)).project;
  const originalSnapshot = structuredClone(current.templateSnapshot);
  await request('/api/templates/film-strip/availability', 'POST', { enabled: false, version: second.version });
  await request('/api/projects', 'POST', { name: 'disabled', templateId: 'film-strip' }, 422);
  current = (await request(`/api/projects/${current.id}`, 'PUT', { expectedRevision: 1, fields: { ...current.fields, title: '手动修正' }, locks: { ...emptyLocks(), fields: ['title'] } })).project;
  assert.deepEqual(current.templateSnapshot, originalSnapshot);
  const beforeRestore = current.revision;
  current = (await request(`/api/projects/${current.id}/restore`, 'POST', { expectedRevision: current.revision, revision: 1 })).project;
  assert.equal(current.revision, beforeRestore + 1); assert.equal(current.restoredFrom, 1);
  assert.equal((await request(`/api/projects/${current.id}/revisions`)).revisions.length, 3);
  assert.equal(current.fields.title, originalSnapshot.defaults.title);
  const aiRun = (await request(`/api/projects/${current.id}/ai-runs`, 'POST', { expectedRevision: current.revision, mode: 'instruction', instruction: '把标题改为周周有课', scope: { kind: 'fields', ids: ['title'] }, requestId: randomUUID() }, 202)).run;
  let status;
  for (let count = 0; count < 200; count += 1) {
    status = (await request('/api/ai-runs/' + aiRun.id)).run;
    if (!['queued', 'running'].includes(status.status)) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(status.status, 'succeeded');
  app = await createWorkbench(options);
  token = (await request('/api/bootstrap')).sessionToken;
  assert.equal((await request(`/api/projects/${current.id}`)).project.fields.title, '周周有课');
  assert.equal((await request('/api/templates')).templates.find(item => item.id === 'film-strip').enabled, false);
  assert.equal((await request('/api/ai-runs/' + aiRun.id)).run.status, 'succeeded');
});
