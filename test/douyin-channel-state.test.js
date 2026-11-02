import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DouyinAssistedRpaAdapter } from '../agent/rpa-adapters/douyin-assisted.js';
import { AssistedPlatformRpaAdapter } from '../agent/rpa-adapters/assisted-platform.js';

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-channel-state-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return new DouyinAssistedRpaAdapter({ logsDir: path.join(root, 'logs'), profileDir: path.join(root, 'profile') });
}

test('overlapping comment collection cannot take private post-navigation recovery', async t => {
  const adapter = fixture(t);
  const privateStarted = deferred();
  const commentStarted = deferred();
  const finishComment = deferred();
  const page = {};
  adapter.getPage = async () => page;
  adapter.restorePrivateInboxOverview = async () => ({ restored: true });
  let inspections = 0;
  adapter.collectLatestIncomingFromOpenPrivateConversation = async () => ++inspections === 1
    ? { attempted: true, recoveredCount: 0, reason: 'NOT_OPEN_BEFORE_NAVIGATION' }
    : { attempted: true, recoveredCount: 1, reason: 'OPEN_CHAT_LATEST_INCOMING_VERIFIED',
      message: { externalId: 'new-incoming', messageType: 'PRIVATE_MESSAGE', content: '社区地址在哪',
        context: { conversationId: 'chat-1', messageId: 'new-1' } } };
  adapter.waitForMessageContentReadyBase = async () => ({ ready: true });
  t.mock.method(AssistedPlatformRpaAdapter.prototype, 'collectMessages', async function (payload) {
    const type = payload.types[0];
    if (type === 'COMMENT') {
      commentStarted.resolve();
      await finishComment.promise;
    } else {
      privateStarted.resolve();
      await commentStarted.promise;
      await this.waitForMessageContentReady(page, 'PRIVATE_MESSAGE');
    }
    return { status: 'SUCCESS', result: { messages: [], typeResults: [{ type, status: 'SUCCESS', count: 0 }] } };
  });
  const privateRun = adapter.collectMessages({ types: ['PRIVATE_MESSAGE'] });
  await privateStarted.promise;
  const commentRun = adapter.collectMessages({ types: ['COMMENT'] });
  let privateOutput;
  try { privateOutput = await privateRun; }
  finally { finishComment.resolve(); }
  const commentOutput = await commentRun;
  assert.equal(privateOutput.result.messages.length, 1);
  assert.equal(privateOutput.result.messages[0].context.messageId, 'new-1');
  assert.equal(commentOutput.result.messages.length, 0);
  assert.equal(adapter.douyinOpenConversationRecoveryState, undefined);
});

test('concurrent replies keep post-click uncertainty local to the sending operation', async t => {
  const adapter = fixture(t);
  const clicked = deferred();
  const releaseSender = deferred();
  adapter.restorePrivateInboxOverview = async () => ({ restored: true });
  t.mock.method(AssistedPlatformRpaAdapter.prototype, 'replyToMessage', async function (payload) {
    if (payload.messageType === 'PRIVATE_MESSAGE') {
      this.douyinReplyAttempted = true;
      clicked.resolve();
      await releaseSender.promise;
      throw new Error('post-click echo disconnected');
    }
    return { status: 'NEEDS_CONFIRMATION', result: { reason: 'COMMENT_TARGET_NOT_READY' } };
  });
  const privateRun = adapter.replyToMessage({ messageType: 'PRIVATE_MESSAGE' });
  await clicked.promise;
  let commentOutput;
  try { commentOutput = await adapter.replyToMessage({ messageType: 'COMMENT' }); }
  finally { releaseSender.resolve(); }
  const privateOutput = await privateRun;
  assert.equal(privateOutput.status, 'NEEDS_CONFIRMATION');
  assert.equal(privateOutput.result.reason, 'reply_post_click_error');
  assert.equal(privateOutput.result.doNotRetry, true);
  assert.equal(commentOutput.result.doNotRetry, undefined);
});
