import test from 'node:test';
import assert from 'node:assert/strict';
import { AssistedPlatformRpaAdapter, filterRecoveryCollectionOutput, operationLaneForJob } from '../agent/rpa-adapters/assisted-platform.js';

function fakePage(id, url = 'about:blank') {
  let closed = false;
  const listeners = {};
  return { id, url: () => url, isClosed: () => closed, bringToFront: async () => {}, once: (name, fn) => { listeners[name] = fn; }, close: () => { closed = true; listeners.close?.(); } };
}

test('one browser context keeps distinct fixed pages for comment and private lanes', async () => {
  const first = fakePage('first', 'https://example.test/home');
  let sequence = 0;
  const context = { pages: () => [first, ...created], newPage: async () => { const page = fakePage(`new-${++sequence}`); created.push(page); return page; } };
  const created = [];
  const adapter = Object.create(AssistedPlatformRpaAdapter.prototype);
  adapter.spec = { hostHints: ['example.test'], name: '测试平台' };
  adapter.channelPages = new Map();
  adapter.ensureContext = async () => context;
  const comment = await adapter.getChannelPage('COMMENT');
  const privatePage = await adapter.getChannelPage('PRIVATE_MESSAGE');
  assert.notEqual(comment, privatePage);
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
