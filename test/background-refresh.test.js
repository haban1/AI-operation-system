import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
function functionBlock(start, end) {
  return source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
}
const signatureCode = functionBlock('function operationsDashboardSignature(', 'function scheduleOperationsDashboardRefresh(');
const dashboardCode = functionBlock('async function renderDashboard(', 'function bindOperationsDashboard(');
const refreshCode = functionBlock('async function refreshOperationsDashboard(', 'function dashboardRuntimeMarkup(');
const platformCode = functionBlock('function platformRuntimeSignature(', 'async function batchPlatformAction(');

function dashboardFixture() {
  const stamp = { textContent: 'earlier' };
  const context = vm.createContext({
    state: { page: 'dashboard', dashboardRange: '7d', dashboardPlatform: 'all', bootstrap: { config: {}, stats: { autoReplies: 0 } } },
    pageRenderGeneration: 1, operationsRangeLabels: {}, document: {createElement: () => ({})},
    operationsDashboardKey: '7d|all',
    operationsDashboardSignatureValue: '',
    data: { updatedAt: '2026-11-11T12:00:00Z', published: { value: 6 }, analytics: { updatedAt: 'earlier', accounts: [] }, kpis: [], channels: [], content: [], funnel: [] },
    operationsDashboardData() { return context.data; },
    $(selector) { return selector === '[data-operations-updated-at]' ? stamp : {}; },
    fmt(value) { return value; },
    esc() { throw new Error('render required'); },
  });
  vm.runInContext(signatureCode + dashboardCode, context);
  vm.runInContext('operationsDashboardSignatureValue=operationsDashboardSignature(data)', context);
  return { context, stamp };
}

test('background dashboard read keeps DOM and updates only generation time when data is unchanged', async () => {
  const { context, stamp } = dashboardFixture();
  context.data.updatedAt = '2026-11-11T12:00:30Z';
  context.data.analytics.updatedAt = '2026-11-11T12:00:30Z';
  await vm.runInContext('renderDashboard({background:true})', context);
  assert.equal(stamp.textContent, context.data.updatedAt);
});

for (const change of ['published', 'analytics', 'bootstrap']) {
  test(`background dashboard still renders changed ${change} data`, async () => {
    const { context } = dashboardFixture();
    if (change === 'published') context.data.published.value++;
    else if (change === 'analytics') context.data.analytics.accounts.push({ metrics: [{ value: 5 }] });
    else context.state.bootstrap.stats.autoReplies++;
    await assert.rejects(vm.runInContext('renderDashboard({background:true})', context), /render required/);
  });
}

test('manual dashboard render is available with unchanged data', async () => {
  const { context } = dashboardFixture();
  await assert.rejects(vm.runInContext('renderDashboard()', context), /render required/);
});

test('late dashboard read cannot render after leaving the page', async () => {
  const { context } = dashboardFixture();
  let release;
  context.operationsDashboardKey = null;
  context.loadOperationsDashboard = () => new Promise(resolve => { release = resolve; });
  const pending = vm.runInContext('renderDashboard({background:true})', context);
  context.state.page = 'tasks';
  context.pageRenderGeneration++;
  release();
  await pending;
});

function refreshFixture() {
  const writes = [], calls = [];
  const context = vm.createContext({
    state: { page: 'dashboard' }, generation: 1, operationsDashboardRefreshOwner: null,
    operationsDashboardKey: 'cached', document: { hidden: false, querySelector: () => null },
    messageFormHasEditingFocus: () => false,
    capturePageOwner: () => ({ page: context.state.page, generation: context.generation }),
    ownsPageOwner: owner => owner.page === context.state.page && owner.generation === context.generation,
    $: () => ({ setAttribute: (...args) => writes.push(args) }),
    renderDashboard: async options => calls.push(options.background),
    scheduleOperationsDashboardRefresh: () => calls.push('scheduled'),
    toast: () => calls.push('toast'),
  });
  vm.runInContext(refreshCode, context);
  return { context, writes, calls };
}

test('background polling continues without changing the loading state', async () => {
  const { context, writes, calls } = refreshFixture();
  await vm.runInContext('refreshOperationsDashboard({background:true})', context);
  assert.deepEqual(calls, [true, 'scheduled']);
  assert.deepEqual(writes, []);
});

for (const reason of ['hidden', 'dialog', 'editing', 'inFlight']) {
  test(`background refresh defers while ${reason} and rearms polling`, async () => {
    const { context, writes, calls } = refreshFixture();
    if (reason === 'hidden') context.document.hidden = true;
    if (reason === 'dialog') context.document.querySelector = () => ({});
    if (reason === 'editing') context.messageFormHasEditingFocus = () => true;
    if (reason === 'inFlight') context.operationsDashboardRefreshOwner = {};
    await vm.runInContext('refreshOperationsDashboard({background:true})', context);
    assert.deepEqual(calls, ['scheduled']);
    assert.deepEqual(writes, []);
  });
}

test('late manual refresh cannot clear the next page loading state', async () => {
  const { context, writes, calls } = refreshFixture();
  let release;
  context.renderDashboard = () => new Promise(resolve => { release = resolve; });
  const pending = vm.runInContext('refreshOperationsDashboard()', context);
  context.state.page = 'tasks';
  context.generation++;
  release();
  await pending;
  assert.deepEqual(writes, [['aria-busy', 'true']]);
  assert.deepEqual(calls, []);
});

function platformFixture() {
  let renders = 0;
  const context = vm.createContext({
    state: { page: 'platforms', bootstrap: { accounts: [{ login_status: 'READY' }], platforms: [{ queued_job_count: 0 }], devices: [], localAgent: { online: false }, config: {} } },
    platformRuntimeSignatureValue: '', platformActionsInFlight: 0, document: { hidden: false, querySelector: () => null },
    messageFormHasEditingFocus: () => false, $: () => ({}),
    renderPlatformRuntimePage: () => { renders++; },
  });
  vm.runInContext(platformCode, context);
  vm.runInContext('platformRuntimeSignatureValue=platformRuntimeSignature()', context);
  return { context, renderCount: () => renders };
}

test('platform polling preserves unchanged cards and ignores unrelated statistics', () => {
  const { context, renderCount } = platformFixture();
  vm.runInContext('refreshPlatformLoginStatus()', context);
  context.state.bootstrap.stats = { autoReplies: 10 };
  vm.runInContext('refreshPlatformLoginStatus()', context);
  assert.equal(renderCount(), 0);
});

for (const field of ['login', 'jobs', 'connection', 'missingDOM']) {
  test(`platform polling still reflects ${field} changes`, () => {
    const { context, renderCount } = platformFixture();
    if (field === 'login') context.state.bootstrap.accounts[0].login_status = 'EXPIRED';
    if (field === 'jobs') context.state.bootstrap.platforms[0].queued_job_count++;
    if (field === 'connection') context.state.bootstrap.localAgent.online = true;
    if (field === 'missingDOM') context.$ = () => null;
    vm.runInContext('refreshPlatformLoginStatus()', context);
    assert.equal(renderCount(), 1);
  });
}

test('platform polling defers during an in-flight account operation', () => {
  const { context, renderCount } = platformFixture();
  context.platformActionsInFlight = 1;
  context.state.bootstrap.accounts[0].login_status = 'EXPIRED';
  vm.runInContext('refreshPlatformLoginStatus()', context);
  assert.equal(renderCount(), 0);
});
