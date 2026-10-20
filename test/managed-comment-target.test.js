import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveManagedCommentTarget } from '../src/services/managed-comment-target.js';

function fakeDatabase(targets = []) {
  return { prepare: () => ({ all: accountId => targets.filter(item => Number(item.account_id ?? accountId) === Number(accountId)) }) };
}

test('B站评论归属门禁拒绝不存在于发布记录的视频', () => {
  const result = resolveManagedCommentTarget({
    platformCode: 'bilibili', accountId: 4, messageType: 'COMMENT', postId: '999999',
    externalUrl: 'https://www.bilibili.com/video/BV1UNKNOWN/'
  }, { database: fakeDatabase([]) });
  assert.equal(result.verified, false);
  assert.equal(result.reason, 'COMMENT_CONTENT_NOT_MANAGED');
});

test('B站评论可通过相同账号发布记录中的 BV 号确认归属', () => {
  const result = resolveManagedCommentTarget({
    platformCode: 'bilibili', accountId: 4, messageType: 'COMMENT', postId: '123456',
    externalUrl: 'https://www.bilibili.com/video/BV1TEST00001/'
  }, { database: fakeDatabase([{
    id: 7, account_id: 4, platform_post_id: 'BV1TEST00001',
    platform_url: 'https://www.bilibili.com/video/BV1TEST00001/', status: 'PUBLISHED', submission_status: 'SUBMITTED'
  }]) });
  assert.equal(result.verified, true);
  assert.equal(result.publishTargetId, 7);
  assert.equal(result.matchedId, 'BV1TEST00001');
});

test('同一 BV 号但不同账号的发布记录不能越权授权', () => {
  const result = resolveManagedCommentTarget({
    platformCode: 'bilibili', accountId: 4, messageType: 'COMMENT',
    externalUrl: 'https://www.bilibili.com/video/BV1TEST00001/'
  }, { database: fakeDatabase([{ id: 8, account_id: 5, platform_post_id: 'BV1TEST00001', status: 'PUBLISHED', submission_status: 'SUBMITTED' }]) });
  assert.equal(result.verified, false);
});
