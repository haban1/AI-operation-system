import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DouyinAssistedRpaAdapter } from '../agent/rpa-adapters/douyin-assisted.js';

function fixture(t, { verified = true, existingReply = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-private-priority-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const adapter = new DouyinAssistedRpaAdapter({ logsDir: path.join(root, 'logs') });
  const events = [];
  const page = { url: () => 'https://www.douyin.com/user/self' };
  const incoming = { messageType: 'PRIVATE_MESSAGE', externalId: 'incoming-1', content: '社区几点开放',
    context: { conversationId: 'chat-1', messageId: 'message-1', direction: 'incoming',
      sourceVerified: verified, fullSource: verified, previewOnly: !verified, platformReplyDetected: existingReply } };
  adapter.getPage = async () => page;
  adapter.restorePrivateInboxOverview = async () => ({ restored: true });
  adapter.collectLatestIncomingFromOpenPrivateConversation = async () => ({ attempted: true, recoveredCount: 0, reason: 'OPEN_CONVERSATION_HEADER_MISSING' });
  adapter.prepareMessagePage = async () => ({ reusedCurrentPage: true });
  adapter.inspectLoginState = async () => ({ state: 'READY' });
  adapter.waitForMessageContentReadyBase = async () => ({ ready: true, pageCheck: { valid: true } });
  adapter.extractMessages = async () => { events.push('extract-unread'); return [incoming]; };
  adapter.enrichDouyinUnreadPrivateMessages = async () => {
    events.push('verify-unread');
    return { messages: [incoming], verifiedCount: verified ? 1 : 0, results: [] };
  };
  adapter.inspectPrivateMessageCoverage = async () => ({ strangerInboxVisible: false });
  adapter.collectIncomingFromRecentReadPrivateConversations = async () => {
    events.push('read-chat-recovery');
    return { attempted: true, recoveredCount: 0, reason: 'RECENT_READ_CONVERSATION_SCAN_NO_NEW_INCOMING' };
  };
  adapter.evidence = async (_payload, message, _page, stage, extra) => ({ message, stage, ...extra });
  return { adapter, events };
}

test('a verified new incoming message returns without waiting for unrelated read-chat scanning', async t => {
  const { adapter, events } = fixture(t);
  const output = await adapter.collectMessages({ types: ['PRIVATE_MESSAGE'] });
  assert.equal(output.status, 'SUCCESS');
  assert.deepEqual(events, ['extract-unread', 'verify-unread']);
  assert.equal(output.result.messages[0].context.messageId, 'message-1');
  assert.ok(output.result.typeResults[0].openConversationRecovery.inspectionPhases.includes('AFTER_PRIVATE_UNREAD_COLLECTION'));
});

for (const options of [{ verified: false }, { existingReply: true }]) {
  test(`read-chat recovery remains available when current previews cannot supply a new reply: ${JSON.stringify(options)}`, async t => {
    const { adapter, events } = fixture(t, options);
    await adapter.collectMessages({ types: ['PRIVATE_MESSAGE'] });
    assert.deepEqual(events, ['extract-unread', 'verify-unread', 'read-chat-recovery']);
  });
}
