import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMessageProcessingIdentity } from '../src/services/message-processing-identity.js';
import { isRepeatedCommentOccurrence, sameStableCommentIdentity } from '../src/services/message-occurrence.js';
import { DouyinAssistedRpaAdapter, classifyDouyinReplyThreadEvidence } from '../agent/rpa-adapters/douyin-assisted.js';

test('stable Douyin comment identity survives relative-time display changes and repeat suffixes', () => {
  const existing = {
    platform_code: 'douyin',
    account_id: 7,
    message_type: 'COMMENT',
    external_id: 'douyin-comment-original',
    user_name: 'haban',
    content: '怎么联系社区工作人员',
    context_json: JSON.stringify({ sourceVideoKey: '7675565312120573210', commentStableId: '4f5ad4463a44d966be724f21', eventTime: '昨天 10:51' }),
    created_at: '2026-08-20T02:51:00.000Z'
  };
  const incomingContext = { sourceVideoKey: '7675565312120573210', commentStableId: '4f5ad4463a44d966be724f21', eventTime: '1天前' };
  assert.equal(sameStableCommentIdentity(existing, incomingContext), true);
  assert.equal(isRepeatedCommentOccurrence(existing, incomingContext, new Date('2026-08-21T08:30:00.000Z')), false);

  const firstIdentity = buildMessageProcessingIdentity(existing, new Date('2026-08-21T08:30:00.000Z'));
  const repeatedIdentity = buildMessageProcessingIdentity({
    ...existing,
    external_id: 'douyin-comment-original--repeat-20260821163000000',
    context_json: JSON.stringify(incomingContext)
  }, new Date('2026-08-21T08:30:00.000Z'));
  assert.equal(firstIdentity.identitySource, 'COMMENT_STABLE_ID');
  assert.equal(firstIdentity.identityKey, repeatedIdentity.identityKey);
});

test('different stable comment ids remain independent even when user and content are identical', () => {
  const base = {
    platform_code: 'douyin', account_id: 7, message_type: 'COMMENT', external_id: 'same-preview',
    user_name: 'haban', content: '怎么联系社区工作人员'
  };
  const left = buildMessageProcessingIdentity({ ...base, context_json: JSON.stringify({ commentStableId: 'comment-A', sourceVideoKey: 'video-A' }) });
  const right = buildMessageProcessingIdentity({ ...base, context_json: JSON.stringify({ commentStableId: 'comment-B', sourceVideoKey: 'video-B' }) });
  assert.notEqual(left.identityKey, right.identityKey);
});

test('folded reply evidence only verifies no-author after a stable, complete scoped expansion', () => {
  assert.equal(classifyDouyinReplyThreadEvidence({ replyThreadCollapsed: true, collapsedReplyCount: 1 }), 'UNVERIFIED');
  assert.equal(classifyDouyinReplyThreadEvidence({ replyThreadExpanded: true, nestedReplyCount: 0 }, { stable: true, expectedReplyCount: 1 }), 'UNVERIFIED');
  assert.equal(classifyDouyinReplyThreadEvidence({ replyThreadExpanded: true, nestedReplyCount: 1 }, { stable: false, expectedReplyCount: 1 }), 'UNVERIFIED');
  assert.equal(classifyDouyinReplyThreadEvidence({ replyThreadExpanded: true, nestedReplyCount: 1 }, { stable: true, expectedReplyCount: 1 }), 'VERIFIED_NO_AUTHOR_REPLY');
  assert.equal(classifyDouyinReplyThreadEvidence({ replyThreadExpanded: true, nestedReplyCount: 0, platformAuthorReplyDetected: true, authorReplies: [{ text: '已回复' }] }, { stable: false, expectedReplyCount: 1 }), 'VERIFIED_AUTHOR_REPLY');
});

function foldedMessage(overrides = {}) {
  return {
    externalId: 'douyin-comment-folded',
    messageType: 'COMMENT',
    userName: 'haban',
    content: '怎么联系社区工作人员',
    externalUrl: 'https://creator.douyin.com/creator-micro/data/following/comment',
    context: {
      commentStableId: 'comment-folded-1',
      sourceVideoKey: 'video-1',
      eventTime: '1天前',
      replyThreadCollapsed: true,
      collapsedReplyCount: 1,
      ...overrides
    }
  };
}

test('handled registry ids bypass folded-thread clicking and collection-side reprocessing', async () => {
  let locateCalls = 0;
  const fake = {
    platformCode: 'douyin',
    locateMessageContainer: async () => { locateCalls += 1; throw new Error('must not locate handled comment'); }
  };
  const result = await DouyinAssistedRpaAdapter.prototype.enrichDouyinFoldedCommentReplies.call(fake, {}, [foldedMessage()], {
    processedCommentStableIds: ['comment-folded-1']
  });
  assert.equal(locateCalls, 0);
  assert.equal(result.attemptedCount, 0);
  assert.equal(result.messages[0].context.replyThreadVerification, 'SKIPPED_ALREADY_PROCESSED');
  assert.equal(result.messages[0].context.processingRegistryHandled, true);
});

test('folded-thread expansion marks scoped author reply and never treats it as unanswered', async () => {
  let inspectionIndex = 0;
  let clickCount = 0;
  const locator = { marker: 'target-comment-only' };
  const snapshots = [
    { ok: true, replyThreadCollapsed: true, collapsedReplyCount: 1, replyThreadExpanded: false, nestedReplyCount: 0, platformAuthorReplyDetected: false, authorReplies: [], signature: 'collapsed' },
    { ok: true, replyThreadCollapsed: false, collapsedReplyCount: 0, replyThreadExpanded: true, nestedReplyCount: 1, platformAuthorReplyDetected: true, platformAuthorReplyText: '可以直接通过当前账号发送私信', platformAuthorReplyUserName: 'Seven 7', authorReplies: [{ userName: 'Seven 7', text: '可以直接通过当前账号发送私信' }], signature: 'expanded-author' },
    { ok: true, replyThreadCollapsed: false, collapsedReplyCount: 0, replyThreadExpanded: true, nestedReplyCount: 1, platformAuthorReplyDetected: true, platformAuthorReplyText: '可以直接通过当前账号发送私信', platformAuthorReplyUserName: 'Seven 7', authorReplies: [{ userName: 'Seven 7', text: '可以直接通过当前账号发送私信' }], signature: 'expanded-author' }
  ];
  const fake = {
    platformCode: 'douyin',
    locateMessageContainer: async () => ({ ok: true, locator }),
    inspectDouyinCommentReplyThread: async received => {
      assert.equal(received, locator);
      return snapshots[Math.min(inspectionIndex++, snapshots.length - 1)];
    },
    findDouyinCommentReplyThreadToggle: async received => {
      assert.equal(received, locator);
      return { ok: true, control: { click: async () => { clickCount += 1; } } };
    },
    assertRuntimeAllowed: async () => {},
  };
  const page = { waitForTimeout: async () => {} };
  const result = await DouyinAssistedRpaAdapter.prototype.enrichDouyinFoldedCommentReplies.call(fake, page, [foldedMessage()], {});
  assert.equal(clickCount, 1);
  assert.equal(result.messages[0].context.replyThreadVerification, 'VERIFIED_AUTHOR_REPLY');
  assert.equal(result.messages[0].context.platformAuthorReplyDetected, true);
  assert.match(result.messages[0].context.platformAuthorReplyText, /当前账号发送私信/);
});

test('ambiguous or missing folded target stays unverified and cannot enter automatic reply', async () => {
  const fake = {
    platformCode: 'douyin',
    locateMessageContainer: async () => ({ ok: false, reason: 'COMMENT_TARGET_AMBIGUOUS' })
  };
  const result = await DouyinAssistedRpaAdapter.prototype.enrichDouyinFoldedCommentReplies.call(fake, {}, [foldedMessage()], {});
  assert.equal(result.messages[0].context.replyThreadVerification, 'UNVERIFIED');
  assert.equal(result.messages[0].context.replyThreadVerificationReason, 'COMMENT_TARGET_AMBIGUOUS');
});
