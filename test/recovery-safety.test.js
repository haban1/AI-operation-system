import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assessAutoReplyEligibility } from '../src/services/auto-reply-eligibility.js';
import { isRecoveryJobTypeClaimable, observePublishStateInShadow, recoveryPublishPolicy, recoveryReplyPostActionPolicy } from '../src/services/recovery-publish-safety.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const baseComment = { platformCode: 'douyin', accountId: 1, messageType: 'COMMENT', userName: '用户A', sourceContent: '完整评论', messageContext: { postId: 'post-1', commentId: 'comment-1', sourceVerified: true } };
const basePrivate = { platformCode: 'weibo', accountId: 1, messageType: 'PRIVATE_MESSAGE', userName: '用户B', sourceContent: '完整私信', messageContext: { conversationId: 'conversation-1', messageId: 'message-1', direction: 'incoming', previewOnly: false, sourceVerified: true, chatTitleVerified: true } };

test('AI shadow失败不阻断确定性发布且没有最终点击权限', async () => {
  const deterministicResult = { status: 'SUCCESS', receipt: 'platform-confirmed' };
  const result = await observePublishStateInShadow({ deterministicResult, observeWithAi: async () => { throw new Error('invalid json'); } });
  assert.equal(result.deterministicResult, deterministicResult);
  assert.equal(result.aiAudit.status, 'FAILED');
  assert.deepEqual(result.aiAuthority, { mayBlock: false, maySetPublishSuccess: false, mayClickFinalPublish: false, mayRetry: false });
  assert.equal(recoveryPublishPolicy({ aiFinalClickAllowed: true }).aiFinalClickAllowed, false);
});

test('恢复版拒绝创建或领取全历史PUBLISH_STATUS_CHECK', () => {
  assert.equal(isRecoveryJobTypeClaimable('PUBLISH_STATUS_CHECK'), false);
  assert.equal(isRecoveryJobTypeClaimable('PUBLISH'), true);
  const server = fs.readFileSync(path.join(root, 'src', 'server.js'), 'utf8');
  assert.match(server, /j\.job_type <> 'PUBLISH_STATUS_CHECK'/);
});

test('评论缺commentId或帖子稳定ID时不得自动发送', () => {
  assert.equal(assessAutoReplyEligibility({ ...baseComment, messageContext: { postId: 'post-1', sourceVerified: true } }).reason, 'STABLE_COMMENT_ID_REQUIRED');
  assert.equal(assessAutoReplyEligibility({ ...baseComment, messageContext: { commentId: 'comment-1', sourceVerified: true } }).reason, 'STABLE_POST_ID_REQUIRED');
});

test('微博仅可从已验证且cid一致的官方评论链接补回作品ID', () => {
  const common = {
    platformCode: 'weibo',
    accountId: 1,
    messageType: 'COMMENT',
    userName: 'Hipo00',
    sourceContent: '你们社区有什么活动啊？招聘志愿者吗',
    externalUrl: 'https://weibo.com/7215153159/RexVTygah?cid=5334681230770311',
    messageContext: { commentId: '5334681230770311', sourceVerified: true }
  };
  const accepted = assessAutoReplyEligibility(common);
  assert.equal(accepted.allowed, true);
  assert.equal(accepted.target.postId, 'RexVTygah');
  assert.equal(accepted.detail.targetEvidence, 'VERIFIED_EXTERNAL_URL');

  assert.equal(assessAutoReplyEligibility({ ...common, externalUrl: 'http://weibo.com/7215153159/RexVTygah?cid=5334681230770311' }).reason, 'STABLE_POST_ID_REQUIRED');
  assert.equal(assessAutoReplyEligibility({ ...common, externalUrl: 'https://evil.example/7215153159/RexVTygah?cid=5334681230770311' }).reason, 'STABLE_POST_ID_REQUIRED');
  assert.equal(assessAutoReplyEligibility({ ...common, externalUrl: 'https://weibo.com/7215153159/RexVTygah?cid=9999999999999999' }).reason, 'STABLE_POST_ID_REQUIRED');
  assert.equal(assessAutoReplyEligibility({ ...common, messageContext: { commentId: '5334681230770311', sourceVerified: false } }).reason, 'STABLE_POST_ID_REQUIRED');
});


test('B站评论必须命中本系统发布内容才允许自动回复', () => {
  const sample = {
    platformCode: 'bilibili', accountId: 4, messageType: 'COMMENT', userName: '用户A', sourceContent: '完整评论',
    messageContext: { postId: '999999', commentId: '888888', sourceVerified: true }
  };
  const denied = assessAutoReplyEligibility(sample);
  assert.equal(denied.allowed, false);
  assert.equal(denied.reason, 'COMMENT_CONTENT_NOT_MANAGED');
  const allowed = assessAutoReplyEligibility({ ...sample, contentOwnership: { verified: true, reason: 'PUBLISH_TARGET_MATCHED', publishTargetId: 7 } });
  assert.equal(allowed.allowed, true);
});

test('私信缺messageId、会话ID或仅sidebar preview时不得自动发送', () => {
  assert.equal(assessAutoReplyEligibility({ ...basePrivate, messageContext: { ...basePrivate.messageContext, messageId: '' } }).reason, 'STABLE_MESSAGE_ID_REQUIRED');
  assert.equal(assessAutoReplyEligibility({ ...basePrivate, messageContext: { ...basePrivate.messageContext, conversationId: '' } }).reason, 'STABLE_CONVERSATION_ID_REQUIRED');
  assert.equal(assessAutoReplyEligibility({ ...basePrivate, messageContext: { ...basePrivate.messageContext, previewOnly: true } }).reason, 'SIDEBAR_PREVIEW_NOT_SENDABLE');
});

test('两个候选目标、DOM变化、安全验证或编辑框未绑定均不得自动授权', () => {
  assert.equal(assessAutoReplyEligibility({ ...baseComment, messageContext: { ...baseComment.messageContext, candidateCount: 2 } }).reason, 'TARGET_NOT_UNIQUE');
  assert.equal(assessAutoReplyEligibility({ ...baseComment, messageContext: { ...baseComment.messageContext, targetChangedAfterLocate: true } }).reason, 'TARGET_DOM_CHANGED');
  assert.equal(assessAutoReplyEligibility({ ...baseComment, messageContext: { ...baseComment.messageContext, editorBoundToTarget: false } }).reason, 'EDITOR_NOT_BOUND_TO_TARGET');
  assert.equal(assessAutoReplyEligibility({ ...baseComment, messageContext: { ...baseComment.messageContext, securityChallenge: true } }).reason, 'PAGE_SECURITY_OR_ERROR_STATE');
});

test('完整确定性评论和私信目标可进入页面级唯一定位，AI仍无直接发送权', () => {
  for (const sample of [baseComment, basePrivate]) {
    const result = assessAutoReplyEligibility(sample);
    assert.equal(result.allowed, true);
    assert.equal(result.aiDirectSendAllowed, false);
    assert.equal(result.retryable, false);
  }
});

test('写后异常不得自动重试，已存在精确回复必须跳过', () => {
  assert.deepEqual(recoveryReplyPostActionPolicy({ writeAttempted: true, failureAfterWrite: true }), { action: 'NEEDS_CONFIRMATION', maySend: false, retryable: false });
  assert.deepEqual(recoveryReplyPostActionPolicy({ exactReplyExists: true }), { action: 'SKIP_ALREADY_REPLIED', maySend: false, retryable: false });
});
test('抖音无会话ID的纯问候可以安全进入自动回复资格', () => {
  const result = assessAutoReplyEligibility({
    platformCode: 'douyin',
    accountId: 1,
    messageType: 'PRIVATE_MESSAGE',
    userName: '用户B',
    sourceContent: '哈喽，你好呀',
    messageContext: {
      messageId: 'message-greeting-1',
      direction: 'incoming',
      previewOnly: false,
      fullSource: true,
      sourceVerified: true,
      chatTitleVerified: true
    }
  });
  assert.equal(result.allowed, true);
  assert.equal(result.target.kind, 'PRIVATE_MESSAGE_GREETING');
  assert.equal(result.detail.greetingOnly, true);
});

test('普通业务私信无会话ID仍然拒绝，纯问候缺消息ID或仍是预览也拒绝', () => {
  const common = {
    platformCode: 'douyin',
    accountId: 1,
    messageType: 'PRIVATE_MESSAGE',
    userName: '用户B',
    messageContext: {
      messageId: 'message-greeting-1',
      direction: 'incoming',
      previewOnly: false,
      fullSource: true,
      sourceVerified: true,
      chatTitleVerified: true
    }
  };
  assert.equal(assessAutoReplyEligibility({ ...common, sourceContent: '活动怎么报名' }).reason, 'STABLE_CONVERSATION_ID_REQUIRED');
  assert.equal(assessAutoReplyEligibility({ ...common, sourceContent: '哈喽，你好呀', messageContext: { ...common.messageContext, messageId: '' } }).reason, 'STABLE_MESSAGE_ID_REQUIRED');
  assert.equal(assessAutoReplyEligibility({ ...common, sourceContent: '哈喽，你好呀', messageContext: { ...common.messageContext, previewOnly: true } }).reason, 'SIDEBAR_PREVIEW_NOT_SENDABLE');
});
