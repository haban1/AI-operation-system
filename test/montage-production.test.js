import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import sharp from 'sharp';
import { Store } from '../engines/montage15/src/store.mjs';
import { SourceFolders } from '../engines/montage15/src/source-folders.mjs';
import { createProject, editProject, assertRenderable } from '../engines/montage15/src/domain.mjs';
import { createWorkbench } from '../engines/montage15/src/server.mjs';
import { templates, buildHtml } from '../engines/montage15/src/templates.mjs';
import { AiEditing, applyAiPlan } from '../engines/montage15/src/ai-editing.mjs';
import { RenderQueue } from '../engines/montage15/src/render.mjs';
import { audioMixFilters } from '../engines/montage15/src/audio.mjs';
import { VisualIndex } from '../engines/montage15/src/visual-index.mjs';

const template = templates.find(item => item.id === 'perspective-flow');
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'montage-production-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const folder = path.join(root, 'footage');
  await fs.mkdir(folder);
  const store = new Store(path.join(root, 'data'));
  await store.init();
  const sources = new SourceFolders(store, { visualIndex: { describe: async () => ({ visualStatus: 'ready', visualVersion: 1, visualDescription: 'classroom' }) } });
  const file = path.join(folder, 'classroom.jpg');
  await sharp({ create: { width: 64, height: 48, channels: 3, background: '#257354' } }).jpeg().toFile(file);
  const source = await sources.register({ folderPath: folder });
  await sources.scan(source.id);
  await sources.running.get(source.id);
  return { root, folder, file, store, sources, source, item: (await sources.items(source.id))[0] };
}

test('folder indexing persists a reusable source and materializes only selected footage', async t => {
  const ctx = await fixture(t);
  assert.equal((await ctx.store.all('assets')).length, 0);
  assert.equal((await ctx.sources.list())[0].count, 1);
  const original = await fs.readFile(ctx.file);
  const imported = await ctx.sources.import(ctx.source.id, ctx.item.id);
  assert.equal(imported.id, ctx.item.id);
  assert.deepEqual(await fs.readFile(ctx.file), original);
  assert.equal((await ctx.sources.import(ctx.source.id, ctx.item.id)).mediaFile, imported.mediaFile);
  await ctx.sources.scan(ctx.source.id);
  await ctx.sources.running.get(ctx.source.id);
  assert.equal((await ctx.sources.items(ctx.source.id))[0].id, ctx.item.id);
  const restarted = new SourceFolders(ctx.store);
  await restarted.init();
  assert.equal((await restarted.list())[0].count, 1);
});

test('photo visual indexing decodes a still image before invoking the local classifier', async t => {
  const ctx = await fixture(t);
  const binary = path.join(ctx.root, 'classifier.mjs');
  await fs.writeFile(binary, `#!${process.execPath}\nimport fs from 'node:fs/promises';\nawait fs.access(process.argv[2]);\nconsole.log(JSON.stringify({ labels: ['people'], detectedPeople: 2 }));\n`, { mode: 0o700 });
  const index = new VisualIndex(ctx.store.root);
  index.ready = async () => true;
  index.binary = binary;
  const result = await index.describe(ctx.file, 'image', null);
  assert.equal(result.visualStatus, 'ready');
  assert.match(result.visualDescription, /people/);
  assert.equal(result.frames.length, 1);
});

test('folder refresh deduplicates identical bytes and retains identity after a file rename', async t => {
  const ctx = await fixture(t);
  const renamed = path.join(ctx.folder, 'renamed.jpg');
  await fs.rename(ctx.file, renamed);
  await fs.copyFile(renamed, path.join(ctx.folder, 'copy.jpg'));
  await ctx.sources.scan(ctx.source.id);
  await ctx.sources.running.get(ctx.source.id);
  const items = await ctx.sources.items(ctx.source.id);
  assert.equal(items.length, 1);
  assert.equal(items[0].id, ctx.item.id);
  await ctx.sources.import(ctx.source.id, items[0].id);
});

test('render HTTP validation accepts indexed candidates that were never materialized', async t => {
  const ctx = await fixture(t);
  await sharp({ create: { width: 64, height: 48, channels: 3, background: '#c3a522' } }).jpeg().toFile(path.join(ctx.folder, 'second.jpg'));
  await ctx.sources.scan(ctx.source.id);
  await ctx.sources.running.get(ctx.source.id);
  const items = await ctx.sources.items(ctx.source.id);
  const asset = await ctx.sources.import(ctx.source.id, ctx.item.id);
  const project = createProject(template);
  project.settings.colorCards = false;
  project.brief = { request: '课堂回顾', facts: '', subject: '', sourceId: ctx.source.id, assetIds: items.map(item => item.id) };
  project.slots.forEach(slot => { slot.assetId = asset.id; });
  await ctx.store.saveProject(project);
  const app = await createWorkbench({ dataDir: ctx.store.root });
  let validated = false;
  app.queue.enqueue = async (saved, assets) => {
    assertRenderable(saved, saved.templateSnapshot, assets);
    assert.equal(assets.length, 2);
    validated = true;
    return { id: 'fixture-job', projectId: saved.id, revision: saved.revision, status: 'queued' };
  };
  const server = http.createServer((req, res) => app.handle(req, res));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const bootstrap = await (await fetch(base + '/api/bootstrap')).json();
  const response = await fetch(base + '/api/projects/' + project.id + '/render', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-workbench-token': bootstrap.sessionToken }, body: JSON.stringify({ expectedRevision: 1 }) });
  assert.equal(response.status, 202);
  assert.equal(validated, true);
});

test('folder scan excludes hidden files and escaping symlinks and changed bytes reject import', async t => {
  const ctx = await fixture(t);
  await fs.copyFile(ctx.file, path.join(ctx.folder, '.hidden.jpg'));
  await fs.symlink(ctx.file, path.join(ctx.folder, 'linked.jpg'));
  await ctx.sources.scan(ctx.source.id);
  await ctx.sources.running.get(ctx.source.id);
  assert.equal((await ctx.sources.items(ctx.source.id)).length, 1);
  await sharp({ create: { width: 64, height: 48, channels: 3, background: '#ffbc33' } }).jpeg().toFile(ctx.file);
  await assert.rejects(ctx.sources.import(ctx.source.id, ctx.item.id), { code: 'SOURCE_FILE_CHANGED' });
  assert.equal((await ctx.store.all('assets')).length, 0);
  assert.equal((await fs.readdir(path.join(ctx.store.root, 'thumbnails'))).length, 0);
});

test('AI plans directly from the indexed folder and imports selected items before committing', async t => {
  const ctx = await fixture(t);
  const project = createProject(template);
  project.settings.colorCards = false;
  project.brief = { request: '', facts: '', subject: '', sourceId: ctx.source.id, assetIds: [ctx.item.id] };
  await ctx.store.saveProject(project);
  const planner = { status: async () => ({ available: true }), plan: async context => {
    assert.equal(context.assets[0].id, ctx.item.id);
    assert.ok(context.request.trim());
    assert.doesNotMatch(JSON.stringify(context), /folderPath|sourceFile|relativePath/);
    return { message: '已选片', warnings: [], operations: project.slots.map(slot => ({ type: 'slot', target: slot.id, assetId: ctx.item.id, inPoint: 0, focusX: .5, focusY: .5 })) };
  } };
  const ai = new AiEditing({ store: ctx.store, planner, assetsForProject: project => ctx.sources.assets(project), prepareAssets: (project, plan) => ctx.sources.materialize(project, plan) });
  const run = await ai.enqueue(project, await ctx.sources.assets(project), { expectedRevision: 1, mode: 'generate', instruction: '', scope: { kind: 'all', ids: [] } });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if ((await ctx.store.get('ai-runs', run.id)).status === 'succeeded') break;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  assert.equal((await ctx.store.get('ai-runs', run.id)).status, 'succeeded');
  assert.equal((await ctx.store.all('assets')).length, 1);
  assert.ok((await ctx.store.get('projects', project.id)).slots.every(slot => slot.assetId === ctx.item.id));
});

test('reassociation repairs a missing normalized file from identical source bytes', async t => {
  const ctx = await fixture(t);
  const imported = await ctx.sources.import(ctx.source.id, ctx.item.id);
  await fs.rm(imported.mediaFile);
  const count = await ctx.sources.repair(ctx.source.id);
  assert.equal(count, 1);
  const restored = await ctx.store.get('assets', ctx.item.id);
  assert.equal(restored.sourceSha256, imported.sourceSha256);
  assert.equal(restored.mediaSha256, imported.mediaSha256);
  await fs.access(restored.mediaFile);
});

test('AI draft keeps template music and explicit music adjustment remains supported', () => {
  const project = createProject(template);
  const operation = { type: 'audio', target: 'track', assetId: null, text: 'film-strip', inPoint: 0 };
  const plan = { message: '调整音乐', warnings: [], operations: [operation] };
  const run = { id: 'music-policy', mode: 'regenerate', instruction: '重新挑选镜头', scope: { kind: 'all', ids: [] } };
  assert.deepEqual(applyAiPlan(project, [], run, plan).project.audio, project.audio);
  const changed = applyAiPlan(project, [], { ...run, instruction: '更换配乐', scope: { kind: 'audio', ids: [] } }, plan);
  assert.equal(changed.project.audio.trackId, 'film-strip');
});

test('layer ordering and sound-picture offsets are validated and present in preview', () => {
  const project = createProject(template);
  const next = editProject(project, { expectedRevision: 1, settings: { ...project.settings, layerOrder: ['text', 'brand', 'media'], textOffset: .25 }, audio: { ...project.audio, offset: .3 } }, template, []);
  const html = buildHtml(next, []);
  assert.match(html, /z-index:60/);
  assert.match(html, /data-start="0.3"/);
  assert.match(html, /"start":0.4/);
  assert.throws(() => editProject(project, { expectedRevision: 1, audio: { ...project.audio, offset: 50 } }, template, []), { code: 'INVALID_VALUE' });
  assert.throws(() => editProject(project, { expectedRevision: 1, settings: { ...project.settings, layerOrder: ['text', 'text', 'media'] } }, template, []), { code: 'INVALID_LAYERS' });
});

test('an interrupted revision pointer can be retried while committed history remains immutable', async t => {
  const ctx = await fixture(t);
  const project = createProject(template);
  await ctx.store.saveProject(project);
  const next = editProject(project, { expectedRevision: 1, name: 'first edit' }, template, []);
  const put = ctx.store.put.bind(ctx.store);
  ctx.store.put = async () => { throw new Error('simulated pointer write failure'); };
  await assert.rejects(ctx.store.saveProject(next), /pointer write failure/);
  ctx.store.put = put;
  const retry = editProject(project, { expectedRevision: 1, name: 'retried edit' }, template, []);
  await ctx.store.saveProject(retry);
  assert.equal((await ctx.store.get('projects', project.id)).name, 'retried edit');
  await assert.rejects(ctx.store.saveProject(next), { code: 'REVISION_EXISTS' });
});

test('queued and active renders can be cancelled without exposing a successful output', async t => {
  const ctx = await fixture(t);
  const queue = new RenderQueue(ctx.store);
  const job = { id: 'cancel-render', status: 'queued' };
  await ctx.store.put('jobs', job);
  queue.queue.push(job);
  assert.equal((await queue.cancel(job.id)).status, 'cancelled');
  assert.equal(queue.queue.length, 0);
  let killed = false;
  queue.currentJob = { id: 'active-render', status: 'rendering' };
  queue.currentChild = { kill: () => { killed = true; } };
  await ctx.store.put('jobs', queue.currentJob);
  assert.equal((await queue.cancel('active-render')).status, 'cancelled');
  assert.equal(killed, true);
  await queue.update(queue.currentJob, { status: 'succeeded' });
  assert.equal(queue.currentJob.status, 'cancelled');
});


test('advanced music timing fades at the shifted end and retains long imported audio', () => {
  const stem = { role: 'music', inPoint: 0, volume: .8, duration: 15 };
  assert.match(audioMixFilters([stem], { offset: -3, fadeOut: .6 })[0], /atrim=start=3:duration=12.*afade=t=out:st=11.4:d=0.6/);
  assert.match(audioMixFilters([stem], { offset: .2 })[0], /duration=14.8.*adelay=200:all=1/);
  assert.match(audioMixFilters([{ ...stem, duration: 30 }], { offset: -3 })[0], /atrim=start=3:duration=15/);
  for (const textOffset of [-2, 2]) {
    const project = createProject(template);
    project.settings.textOffset = textOffset;
    const html = buildHtml(project, []);
    const cards = JSON.parse(html.match(/"cards":(\[.*?\]),"settings"/s)[1]);
    assert.ok(cards.every(card => card.start >= 0 && card.end <= 15 && card.end > card.start));
  }
});

async function productionController(state) {
  const vm = await import('node:vm');
  const controls = new Map();
  function control(id) {
    if (!controls.has(id)) controls.set(id, {
      value: '',
      options: [],
      replaceChildren(...options) { this.options = options; this.value = options[0]?.value || ''; },
      add(option) { this.options.push(option); },
    });
    return controls.get(id);
  }
  const saved = new Map();
  const context = {
    window: {}, location: { pathname: '/test-montage/' },
    document: { getElementById: control },
    localStorage: { getItem: key => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value), removeItem: key => saved.delete(key) },
    Option: class { constructor(text, value) { this.text = text; this.value = value; } },
    structuredClone,
  };
  vm.runInNewContext(await fs.readFile(new URL('../engines/montage15/public/production.js', import.meta.url), 'utf8'), context);
  const controller = Object.create(context.window.MontageProduction.prototype);
  controller.state = state;
  return { controller, control, saved };
}

test('new projects default to the reusable folder while legacy projects keep their own source state', async () => {
  const state = { project: null, sourceFolders: [{ id: 'folder-a', name: '素材 A', status: 'ready', count: 20 }, { id: 'folder-b', name: '素材 B', status: 'ready', count: 3 }] };
  const { controller, control } = await productionController(state);
  controller.renderSources();
  assert.equal(control('source-select').value, 'folder-a');
  assert.equal(control('new-project-source').value, 'folder-a');
  state.project = { brief: {} };
  controller.renderSources();
  assert.equal(control('source-select').value, '');
  assert.equal(control('new-project-source').value, 'folder-a');
  state.project.brief.sourceId = 'folder-b';
  controller.renderSources();
  assert.equal(control('source-select').value, 'folder-b');
});

test('undo to the saved snapshot clears the draft while retaining the current revision', async () => {
  const current = { id: 'undo-project', revision: 13, name: '体验工程', fields: { title: '标题 A' }, slots: [], audio: {}, settings: {}, locks: {}, brief: {} };
  const state = { project: structuredClone(current), dirty: false };
  const { controller } = await productionController(state);
  controller.savedContent = JSON.stringify({ name: current.name, fields: current.fields, slots: [], audio: {}, settings: {}, locks: {}, brief: {} });
  controller.setProject = project => { state.project = project; };
  controller.markDirty = () => { state.dirty = true; };
  controller.refreshEditor = () => {};
  controller.updateUndo = () => {};
  let cleared = false;
  controller.saved = () => { cleared = true; };
  controller.applyLocal({ ...current, revision: 1, fields: { title: '标题 B' } });
  assert.equal(state.dirty, true);
  assert.equal(state.project.revision, 13);
  controller.applyLocal(current);
  assert.equal(state.dirty, false);
  assert.equal(cleared, true);
});

test('rendering rejects changed bytes after a job has entered the queue', async t => {
  const ctx = await fixture(t);
  const asset = await ctx.sources.import(ctx.source.id, ctx.item.id);
  const project = createProject(template);
  project.slots.forEach(slot => { slot.assetId = asset.id; });
  const job = { id: 'queued-source-change', status: 'queued', project, assets: [asset], builtInAudio: [] };
  await ctx.store.put('jobs', job);
  await fs.writeFile(asset.mediaFile, 'changed after enqueue');
  await new RenderQueue(ctx.store).render(job);
  const result = await ctx.store.get('jobs', job.id);
  assert.equal(result.status, 'failed');
  assert.match(result.error, /素材已变化/);
  assert.equal(result.outputFile, undefined);
});
