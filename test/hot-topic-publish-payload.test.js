import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const start = app.indexOf('function buildPublishRequestPayload(){');
const source = app.slice(start, app.indexOf('\nasync function submitPublish(', start));
function fixture() {
  const fields = { title: '人工核对后的发布标题', body: '人工修改正文仍保留视频来源', materialPath: '/library/media/a.mp4', contentOrigin: '' };
  const state = { precheck: { overall: 'PASSED', meta: { sha256: 'a'.repeat(64) } }, compliance: { status: 'SUCCESS', overall: 'PASSED' },
    retryDraft: { origin: 'content-library', id: '1'.repeat(32), materialPath: fields.materialPath }, retrySourceTaskId: null };
  const context = vm.createContext({ state, selectedTargets: () => [{ platformCode: 'douyin', accountId: 1 }],
    $: () => ({ checked: false }), FormData: class { get(key) { return fields[key]; } } });
  vm.runInContext(source, context);
  return { fields, state, build: () => vm.runInContext('buildPublishRequestPayload()', context) };
}

test('publishing keeps selected library identity when editing copy and requires the existing checks', () => {
  const ctx = fixture();
  assert.equal(ctx.build().contentLibraryItemId, ctx.state.retryDraft.id);
  assert.equal(ctx.build().body, ctx.fields.body);
  assert.equal(ctx.build().publishMode, 'DRAFT_ONLY');
  ctx.state.compliance = null;
  assert.throws(ctx.build, /请先执行 AI/);
});

test('changing to external media or a normal creation draft drops automatic-library identity', () => {
  const ctx = fixture();
  ctx.fields.materialPath = '/upload/new.mp4';
  assert.equal(ctx.build().contentLibraryItemId, undefined);
  ctx.fields.materialPath = ctx.state.retryDraft.materialPath;
  ctx.state.retryDraft.origin = 'studio';
  assert.equal(ctx.build().contentLibraryItemId, undefined);
});
