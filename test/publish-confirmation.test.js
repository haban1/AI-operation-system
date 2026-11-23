import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const actions = source.slice(source.indexOf('function buildPublishRequestPayload('), source.indexOf('const SCHEDULE_STATUS_VIEW='));

function fixture(review = { status: 'SUCCESS', overall: 'PASSED' }) {
  const writes = [], errors = [], destinations = [];
  const fields = { title: '社区服务介绍', body: '了解社区服务及活动安排，欢迎居民参与。', materialPath: 'fixture.png', contentOrigin: 'HUMAN_ORIGINAL' };
  const confirmed = { checked: false };
  const context = vm.createContext({
    state: { compliance: review, materialMeta: { sha256: 'fixture-sha', type:'image' }, materialPreviewUrl:'/api/local-agent/fixture-cover.png', taskPlatform:'weibo', taskStatus:'FAILED', currentPublishTaskId:99 },
    $: selector => selector === '#warningConfirmed' ? confirmed : {},
    selectedTargets: () => [{ platformCode: 'douyin', accountId: 2 }],
    FormData: class { get(key) { return fields[key]; } },
    api: async (url, options) => { writes.push({ url, ...JSON.parse(options.body) }); return { task: { id: 1 } }; },
    toast: (message, error) => { if (error) errors.push(message); },
    navigate(page) { destinations.push(page); }, renderAiReview() {}
  });
  vm.runInContext(actions, context);
  return { context, writes, errors, confirmed, destinations, submit: id => context.submitPublish({ preventDefault() {}, submitter: id ? { id } : undefined }) };
}

test('only explicit confirm publish grants automatic execution', async () => {
  for (const [id, mode] of [['publishSubmitButton', 'AUTO'], ['publishDraftButton', 'DRAFT_ONLY'], [undefined, 'DRAFT_ONLY']]) {
    const f = fixture();
    await f.submit(id);
    assert.equal(f.writes.length, 1);
    assert.equal(f.writes[0].publishMode, mode);
    assert.equal(f.writes[0].managementConfirmed, mode === 'AUTO');
    assert.equal(f.context.state.taskStatus,'CURRENT');
    assert.equal(f.context.state.taskPlatform,'ALL');
    assert.equal(f.context.state.currentPublishTaskId,1);
    assert.equal(f.context.state.currentTaskPreview.url,'/api/local-agent/fixture-cover.png');
    assert.deepEqual(f.destinations,['tasks']);
  }
});

test('payload defaults to draft; the schedule action explicitly selects automatic mode', () => {
  const f = fixture();
  assert.equal(f.context.buildPublishRequestPayload().publishMode, 'DRAFT_ONLY');
  assert.equal(f.context.buildPublishRequestPayload('AUTO').managementConfirmed, true);
  assert.match(source.slice(source.indexOf('function openScheduledPublishDialog(')), /payload=buildPublishRequestPayload\('AUTO'\)/);
});

test('task creation failure keeps the form and previous current task selection', async () => {
  const f=fixture();
  f.context.api=async()=>{throw new Error('任务创建失败')};
  await f.submit('publishSubmitButton');
  assert.deepEqual(f.destinations,[]);
  assert.equal(f.context.state.currentPublishTaskId,99);
  assert.equal(f.context.state.taskStatus,'FAILED');
  assert.deepEqual(f.errors,['任务创建失败']);
});

for (const review of [null, { status: 'FAILED', overall: 'PASSED' }, { status: 'SUCCESS', overall: 'BLOCKED' }]) {
  test(`missing, failed or blocked review stays blocked: ${JSON.stringify(review)}`, async () => {
    const f = fixture(review);
    f.confirmed.checked = true;
    await f.submit('publishSubmitButton');
    assert.equal(f.writes.length, 0);
    assert.equal(f.errors.length, 1);
  });
}

test('warning needs explicit acknowledgment for both draft and automatic publishing', async () => {
  for (const id of ['publishDraftButton', 'publishSubmitButton']) {
    const f = fixture({ status: 'SUCCESS', overall: 'WARNING' });
    await f.submit(id);
    assert.equal(f.writes.length, 0);
    assert.match(f.errors[0], /确认.*警告/);
    f.confirmed.checked = true;
    await f.submit(id);
    assert.equal(f.writes.length, 1);
    assert.equal(f.writes[0].complianceConfirmed, true);
  }
});
