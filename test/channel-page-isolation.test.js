import test from 'node:test';
import assert from 'node:assert/strict';
import { AssistedPlatformRpaAdapter, filterRecoveryCollectionOutput, operationLaneForJob } from '../agent/rpa-adapters/assisted-platform.js';
import { XiaohongshuAssistedRpaAdapter } from '../agent/rpa-adapters/xiaohongshu-assisted.js';

function fakePage(id, url = 'about:blank') {
  let closed = false;
  const listeners = {};
  return { id, url: () => url, isClosed: () => closed, bringToFront: async () => {}, once: (name, fn) => { listeners[name] = fn; }, close: () => { closed = true; listeners.close?.(); } };
}

test('one browser context keeps distinct fixed pages for comment and private lanes', async () => {
  const first = fakePage('first', 'https://example.test/home');
  let sequence = 0;
  const context = { pages: () => [first, ...created], newPage: () => assert.fail('background lanes must not open a visible tab') };
  const created = [];
  const adapter = Object.create(AssistedPlatformRpaAdapter.prototype);
  adapter.spec = { hostHints: ['example.test'], name: '测试平台' };
  adapter.channelPages = new Map();
  adapter.ensureContext = async () => context;
  adapter.createBackgroundPage = async () => { const page = fakePage(`new-${++sequence}`); created.push(page); return page; };
  const comment = await adapter.getChannelPage('COMMENT');
  const privatePage = await adapter.getChannelPage('PRIVATE_MESSAGE');
  assert.notEqual(comment, privatePage);
  assert.notEqual(comment, first);
  assert.notEqual(privatePage, first);
  assert.equal(await adapter.getChannelPage('COMMENT'), comment);
  assert.equal(await adapter.getChannelPage('PRIVATE_MESSAGE'), privatePage);
});

test('publish belongs to comment lane and recovery output rejects unrelated conversations', () => {
  assert.equal(operationLaneForJob({ job_type: 'PUBLISH', payload: {} }), 'COMMENT');
  const filtered = filterRecoveryCollectionOutput({ status: 'SUCCESS', result: { messages: [
    { context: { conversationId: 'target-1' } }, { context: { conversationId: 'other' } }
  ] } }, { recoveryScan: true, recoveryTargets: [{ externalConversationKey: 'target-1' }] });
  assert.equal(filtered.result.messages.length, 1);
  assert.equal(filtered.result.recoveryDroppedCount, 1);
});

test('concurrent requests for one workspace share its opening and can retry after a failure', async () => {
  const adapter = Object.create(AssistedPlatformRpaAdapter.prototype);
  const context = { newPage: () => assert.fail('must not open a visible tab') };
  adapter.spec = { hostHints: [] };
  adapter.ensureContext = async () => context;
  let attempts = 0;
  const page = fakePage('worker');
  adapter.createBackgroundPage = async () => {
    attempts++;
    await new Promise(resolve => setImmediate(resolve));
    if (attempts === 1) throw new Error('unsupported');
    return page;
  };
  const pair = () => [adapter.getChannelPage('COMMENT'), adapter.getChannelPage('COMMENT')];
  assert.deepEqual((await Promise.allSettled(pair())).map(r => r.status), ['rejected', 'rejected']);
  assert.equal(attempts, 1);
  assert.deepEqual(await Promise.all(pair()), [page, page]);
  assert.equal(attempts, 2);
});

test('login status can inspect the existing QR challenge without focusing or navigating it', async () => {
  const adapter = Object.create(AssistedPlatformRpaAdapter.prototype);
  const operator = fakePage('operator');
  operator.bringToFront = () => assert.fail('polling cannot focus');
  adapter.channelPages = new Map([['INTERACTIVE', operator]]);
  adapter.getPage = () => assert.fail('in-progress operator login must not be replaced');
  adapter.status = async p => { assert.equal(p, operator); return { state: 'VERIFY_REQUIRED', confidence: 'CONFIRMED' }; };
  adapter.recheckLogin = async p => { assert.equal(p, operator); return { state: 'VERIFY_REQUIRED' }; };
  assert.equal((await adapter.checkLogin({ preserveInteractiveLogin: true })).state, 'VERIFY_REQUIRED');
});

test('explicit Xiaohongshu handoff reveals the preserved draft, not a new login tab', async () => {
  const adapter = Object.create(XiaohongshuAssistedRpaAdapter.prototype);
  const draft = fakePage('draft');
  let focus = 0;
  draft.bringToFront = async () => { focus++; };
  adapter.channelPages = new Map([['PUBLISH', draft]]);
  adapter.openLogin = () => assert.fail('preserved draft must not be navigated');
  adapter.status = async p => ({ current: p });
  assert.equal((await adapter.openManualAction()).current, draft);
  assert.equal(focus, 1);
});
