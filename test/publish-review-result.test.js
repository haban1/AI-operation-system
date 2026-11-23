import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const rendering = source.slice(source.indexOf('function renderPublishReviewStatus('), source.indexOf('function selectedTargets('));
const execution = source.slice(source.indexOf('async function runCompliance('), source.indexOf('function buildPublishRequestPayload('));

function fixture(review) {
  const box = { dataset: {} }, confirmation = {}, confirmed = { checked: true };
  const button = { classList: { add() {}, remove() {} }, setAttribute() {}, querySelector: () => null };
  const calls = [], values = { '#publishTitle': '社区服务介绍', '#publishBody': '介绍服务和活动安排。', '#contentOrigin': 'HUMAN_ORIGINAL', '#materialPath': 'fixture.png' };
  const context = vm.createContext({
    state: { compliance: { status: 'SUCCESS', overall: 'PASSED' } },
    $: selector => ({ '#complianceBox': box, '#publishWarningConfirmation': confirmation, '#warningConfirmed': confirmed, '#runCompliance': button }[selector] || { value: values[selector] }),
    esc: value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;'),
    agent: async endpoint => { calls.push(endpoint); return { review }; }, toast() {}
  });
  vm.runInContext(rendering + execution, context);
  return { context, box, confirmation, confirmed, calls };
}

test('passed review renders only the requested status and makes no prediction call', async () => {
  const review = { status: 'SUCCESS', overall: 'PASSED', summary: 'verbose summary', model: 'private-model', frameCount: 5, findings: [{ message: 'unnecessary detail' }] };
  const f = fixture(review);
  await f.context.runCompliance();
  assert.equal(f.box.innerHTML, '<strong>审核通过</strong>');
  assert.equal(f.box.className, 'publish-review-result is-success');
  assert.equal(f.confirmation.hidden, true);
  assert.deepEqual(f.calls, ['/ai-review']);
  assert.equal(f.context.state.compliance, review);
});

test('warning remains a real warning with escaped reasons and explicit acknowledgment', () => {
  const f = fixture();
  f.context.renderAiReview({ status: 'SUCCESS', overall: 'WARNING', findings: [{ message: '<检查标题>' }, { message: '<检查标题>' }] });
  assert.equal(f.confirmation.hidden, false);
  assert.equal(f.box.innerHTML, '<strong>请确认内容</strong><p>&lt;检查标题&gt;</p>');
  assert.equal(f.box.className, 'publish-review-result is-warning');
});

test('failed or blocked review never renders a passed label', () => {
  for (const review of [{ status: 'FAILED', overall: 'PASSED' }, { status: 'SUCCESS', overall: 'BLOCKED', findings: [{ message: '请修改内容' }] }]) {
    const f = fixture();
    f.context.renderAiReview(review);
    assert.doesNotMatch(f.box.innerHTML, /审核通过/);
    assert.equal(f.confirmation.hidden, true);
    assert.equal(f.confirmed.checked, false);
  }
});

test('starting a new review invalidates the previous pass while awaiting its result', async () => {
  const f = fixture();
  let finish;
  f.context.agent = () => new Promise(resolve => { finish = resolve; });
  const work = f.context.runCompliance();
  assert.equal(f.context.state.compliance, null);
  assert.equal(f.box.innerHTML, '<strong>正在审核…</strong>');
  assert.equal(f.confirmed.checked, false);
  finish({ review: { status: 'SUCCESS', overall: 'PASSED' } });
  await work;
  assert.equal(f.box.innerHTML, '<strong>审核通过</strong>');
});
