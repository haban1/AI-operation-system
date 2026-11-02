import test from 'node:test';
import assert from 'node:assert/strict';
import { DouyinAssistedRpaAdapter } from '../agent/rpa-adapters/douyin-assisted.js';
import { assessAutoReplyEligibility } from '../src/services/auto-reply-eligibility.js';

function fixture() {
  const adapter = new DouyinAssistedRpaAdapter({ profileDir: './unused-test-profile', logsDir: './unused-test-logs' });
  const preview = { messageType: 'PRIVATE_MESSAGE', userName: '居民', content: '周末也开放吗？', externalUrl: 'https://www.douyin.com/user/self',
    context: { unread: true, unreadCount: 2, previewOnly: true } };
  const messages = [
    { messageId: 'outgoing-1', conversationId: 'conversation-12345678', direction: 'outgoing', text: '您好' },
    { messageId: 'incoming-1', conversationId: 'conversation-12345678', direction: 'incoming', text: '社区几点开放？' },
    { messageId: 'incoming-2', conversationId: 'conversation-12345678', direction: 'incoming', text: preview.content }
  ];
  const target = { ok: true, headerName: '居民', conversationId: 'conversation-12345678', messageId: 'incoming-2', direction: 'incoming',
    sourceIsLatest: true, timelineStable: true, timeline: { stable: true, messages, latestMessage: messages.at(-1) } };
  return { adapter, preview, target };
}

test('multiple unread messages enter the real full-source reply path only after a complete stable timeline is verified', async () => {
  const { adapter, preview, target } = fixture();
  adapter.openPrivateConversationForPayload = async (_page, payload, options) => {
    assert.equal(payload.sourceContent, preview.content);
    assert.deepEqual(options, { requireSourcePreview: true, requireUnreadEvidence: true });
    return target;
  };
  const result = await adapter.enrichDouyinUnreadPrivateMessages({}, [preview]);
  assert.equal(result.verifiedCount, 1);
  assert.equal(result.messages.length, 2);
  assert.deepEqual(result.messages.map(m => m.content), ['社区几点开放？', '周末也开放吗？']);
  for (const message of result.messages) {
    assert.equal(message.context.previewOnly, false);
    assert.equal(message.context.unreadBatchSize, 2);
    assert.equal(assessAutoReplyEligibility({ ...message, platformCode: 'douyin', accountId: 2 }).allowed, true);
  }
});

for (const [name, mutate, reason] of [
  ['missing earlier unread message', t => t.timeline.messages.splice(1, 1), 'PRIVATE_UNREAD_TIMELINE_INCOMPLETE'],
  ['outgoing within unread batch', t => { t.timeline.messages[1].direction = 'outgoing'; }, 'PRIVATE_UNREAD_TIMELINE_INCOMPLETE'],
  ['missing stable message ID', t => { t.timeline.messages[1].messageId = ''; }, 'STABLE_MESSAGE_ID_REQUIRED'],
  ['duplicate stable message ID', t => { t.timeline.messages[1].messageId = 'incoming-2'; }, 'PRIVATE_MESSAGE_ID_AMBIGUOUS'],
  ['cross conversation data', t => { t.timeline.messages[1].conversationId = 'other-conversation'; }, 'OPEN_CONVERSATION_ID_CONFLICT'],
  ['changed latest preview', t => { t.timeline.messages[2].text = 'new incoming'; }, 'SOURCE_PREVIEW_CHANGED'],
  ['wrong header', t => { t.headerName = '另一位居民'; }, 'CONVERSATION_HEADER_MISMATCH'],
  ['unstable timeline', t => { t.timeline.stable = false; }, 'PRIVATE_TIMELINE_UNSTABLE']
]) {
  test(`multiple unread remains non-sendable on ${name}`, async () => {
    const { adapter, preview, target } = fixture();
    mutate(target);
    adapter.openPrivateConversationForPayload = async () => target;
    const result = await adapter.enrichDouyinUnreadPrivateMessages({}, [preview]);
    assert.equal(result.verifiedCount, 0);
    assert.equal(result.messages.length, 1);
    assert.equal(result.messages[0].context.privateVerificationReason, reason);
    assert.equal(result.messages[0].context.sourceVerified, false);
  });
}
