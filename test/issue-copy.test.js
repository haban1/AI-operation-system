import test from 'node:test';
import assert from 'node:assert/strict';
import { issueCopy, issueLabel } from '../public/issue-copy.js';

test('问题已解决与作品发布状态分开显示', () => {
  assert.equal(issueLabel('RESOLVED'), '已解决');
  const detail = JSON.stringify({phase:'VERIFY_RESULT_PROVENANCE', validation:{
    reason:'REVIEW_STATUS_EVIDENCE_MISMATCH', expectedPlatformCode:'wechat_channels',
    reviewStatus:'PUBLISHED', matchedRecordStatus:'REVIEWING'
  }});
  const copy = issueCopy(Object.freeze({category:'PUBLISH_PLATFORM_ISOLATION', detail}));
  assert.equal(copy.title, '视频号发布状态未更新');
  assert.match(copy.summary, /审核状态与作品管理页的记录不一致/);
  assert.ok(copy.facts.includes('作品记录状态：审核中'));
  assert.equal(copy.original, detail);
});

test('截断和未知原因均不臆断原因，不丢失原文', () => {
  for(const detail of ['{"validation":', '{"validation":{"reason":"NEW_REASON"}}']){
    const copy = issueCopy({category:'PUBLISH_PLATFORM_ISOLATION', detail});
    assert.match(copy.summary, /未能确认/);
    assert.equal(copy.original, detail);
  }
});

test('采集和浏览器异常使用中文，保留原始错误', () => {
  const detail='采集结果持久化失败：未提供 externalId';
  const copy=issueCopy({source:'SYSTEM', category:'MESSAGE_COLLECTION', related_type:'ACCOUNT', title:'douyin 采集结果持久化失败', detail});
  assert.equal(copy.title,'抖音采集结果未能保存');
  assert.equal(copy.summary,'采集结果未能保存：未提供 平台消息编号');
  assert.equal(copy.original,detail);
  assert.match(issueCopy({detail:'Target page, context or browser has been closed'}).summary,/浏览器已关闭/);
});
