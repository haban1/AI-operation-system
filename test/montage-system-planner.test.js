import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs/promises';
import { SystemMontagePlanner } from '../src/services/montage-ai-planner.js';
import { createProject } from '../engines/montage15/src/domain.mjs';
import { templates } from '../engines/montage15/src/templates.mjs';
import { applyAiPlan, buildAiContext } from '../engines/montage15/src/ai-editing.mjs';

const settings = () => ({ mode: 'online', baseUrl: 'https://model.invalid/v1/', apiKey: 'fixture-secret', model: 'chat', contentModel: 'editing' });

test('system model returns an applicable full draft with scoped metadata and dynamic settings', async () => {
  const project = createProject(templates.find(t => t.id === 'perspective-flow'), { name: '隔离验证' });
  const asset = { id: 'fixture', type: 'image', name: '照片', width: 100, height: 100 };
  project.brief = { assetIds: [asset.id] };
  const run = { id: 'run', mode: 'generate', scope: { kind: 'all', ids: [] }, instruction: '' };
  const expected = { message: '已生成', warnings: [], operations: project.slots.map(s => ({ type: 'slot', target: s.id, assetId: asset.id, inPoint: 0, focusX: .5, focusY: .5 })) };
  let active = settings();
  const planner = new SystemMontagePlanner({ settings: () => active, fetcher: async (url, options) => {
    assert.equal(url, 'https://model.invalid/v1/chat/completions');
    const body = JSON.parse(options.body);
    assert.equal(body.model, 'editing');
    assert.match(body.messages[0].content, /"operations"/);
    assert.doesNotMatch(body.messages[0].content, /private\/media/);
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(expected) } }] });
  } });
  assert.equal((await planner.status()).available, true);
  const context = buildAiContext(project, [{ ...asset, mediaFile: '/private/media' }], run);
  const plan = await planner.plan(context);
  const applied = applyAiPlan(project, [asset], run, plan);
  assert(applied.project.slots.every(s => s.assetId === asset.id));
  assert.equal(project.slots[0].assetId, null);
  active = { ...active, apiKey: '' };
  assert.equal((await planner.status()).available, false);
  assert.doesNotMatch(JSON.stringify(await planner.status()), /fixture-secret|model.invalid/);
});

test('system model failure, invalid output, timeout and cancellation preserve safe errors', async () => {
  for (const [fetcher, code] of [
    [async () => new Response('fixture-secret', { status: 401 }), 'AI_PROVIDER_FAILED'],
    [async () => Response.json({ choices: [{ message: { content: 'not-json' } }] }), 'AI_INVALID_RESPONSE'],
    [async () => Response.json({ choices: [{ finish_reason: 'length', message: { content: '{}' } }] }), 'AI_INVALID_RESPONSE'],
    [async () => { throw Error('fixture-secret'); }, 'AI_PROVIDER_FAILED'],
  ]) {
    await assert.rejects(new SystemMontagePlanner({ settings, fetcher }).plan({}), error => error.code === code && !error.message.includes('fixture-secret'));
  }
  const fetcher = (url, { signal }) => new Promise((resolve, reject) => {
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
  const keeper = setInterval(() => {}, 1000);
  try {
    await assert.rejects(new SystemMontagePlanner({ settings, fetcher, timeoutMs: 20 }).plan({}), { code: 'AI_TIMEOUT' });
    const controller = new AbortController();
    const task = new SystemMontagePlanner({ settings, fetcher }).plan({}, { signal: controller.signal });
    setTimeout(() => controller.abort(), 10);
    await assert.rejects(task, { code: 'AI_CANCELLED' });
  } finally { clearInterval(keeper); }
});

test('LAN HTTP can submit generation without crypto.randomUUID', async () => {
  const nodes = new Map();
  const node = () => ({ disabled: false, hidden: false, value: '', inert: false, addEventListener() {} });
  const window = {};
  const context = vm.createContext({ window, crypto: {}, document: { getElementById(id) { if (!nodes.has(id)) nodes.set(id, node()); return nodes.get(id); } }, clearTimeout, setTimeout });
  vm.runInContext(await fs.readFile(new URL('../engines/montage15/public/workflow.js', import.meta.url), 'utf8'), context);
  let submitted;
  const project = { id: 'project', revision: 1 };
  const workflow = new window.MontageWorkflow({ state: { project, dirty: false }, updateStatus() {},
    api: async (url, options) => { submitted = JSON.parse(options.body); return { run: { id: 'run' } }; } });
  workflow.displayRun = () => {};
  workflow.poll = async () => {};
  await workflow.start('generate', { kind: 'all', ids: [] }, '');
  assert.equal(submitted.mode, 'generate');
  assert.equal(submitted.expectedRevision, 1);
  assert.equal('requestId' in submitted, false);
});
