import test from 'node:test';
import assert from 'node:assert/strict';
import { getReplyLimit, validateReplyTextLength, validateKnowledgeAnswerLength } from '../src/services/platform-reply-policy.js';

const verifiedWebCases = [
  ['douyin', 'COMMENT', 500], ['douyin', 'PRIVATE_MESSAGE', 500],
  ['bilibili', 'PRIVATE_MESSAGE', 500]
];

for (const [platformCode, messageType, maximum] of verifiedWebCases) {
  test(`${platformCode}/${messageType} 使用已核实网页上限和 UTF-16 计数`, () => {
    const policy = getReplyLimit(platformCode, messageType);
    assert.equal(policy.publishedMax, maximum);
    assert.equal(policy.safeMax, maximum - 20);
    assert.equal(policy.sourceType, 'OFFICIAL_WEB');
    assert.equal(policy.countingMode, 'UTF16');
    assert.ok(policy.sourceUrl?.startsWith('https://'));
    const check = (text, usePublishedMax = false) => validateReplyTextLength({ platformCode, messageType, text, usePublishedMax });
    assert.equal(check('答'.repeat(maximum), true).ok, true);
    assert.equal(check('答'.repeat(maximum + 1), true).ok, false);
    assert.equal(check('答'.repeat(maximum - 20)).ok, true);
    assert.equal(check('答'.repeat(maximum - 19)).ok, false);
    assert.equal(check('😀'.repeat((maximum - 20) / 2)).ok, true);
    assert.equal(check('😀'.repeat((maximum - 20) / 2) + '。').ok, false);
    assert.equal(check('e\u0301'.repeat(maximum - 20)).ok, true);
  });
}

test('微博评论引用官方 140 字文档，其余未核实网页通道保留明确标注的保守配置', () => {
  const weiboComment = getReplyLimit('weibo', 'COMMENT');
  assert.equal(weiboComment.publishedMax, 140);
  assert.equal(weiboComment.sourceType, 'OFFICIAL_DOC');
  assert.equal(weiboComment.countingMode, 'CODE_POINTS');
  for (const [platformCode, messageType, maximum] of [
    ['weibo', 'PRIVATE_MESSAGE', 300], ['wechat_channels', 'COMMENT', 200],
    ['wechat_channels', 'PRIVATE_MESSAGE', 500], ['bilibili', 'COMMENT', 1000]
  ]) {
    const policy = getReplyLimit(platformCode, messageType);
    assert.equal(policy.publishedMax, maximum);
    assert.equal(policy.sourceType, 'PROJECT_FALLBACK');
    assert.equal(policy.safeMax, maximum - 20);
  }
});

test('B站知识答案预览按私信 480 预算和表情 UTF-16 长度检查', () => {
  assert.equal(validateKnowledgeAnswerLength({ category: 'B站知识库', answer: '😀'.repeat(240) }).ok, true);
  const overflow = validateKnowledgeAnswerLength({ category: 'B站知识库', answer: '😀'.repeat(240) + '。' });
  assert.equal(overflow.ok, false);
  assert.equal(overflow.count, 481);
  assert.equal(overflow.limit, 480);
});

test('B站评论未核实计数时保留原适配器 UTF-16 保护，不因统一策略放行更长表情文本', () => {
  const check = text => validateReplyTextLength({ platformCode: 'bilibili', messageType: 'COMMENT', text });
  assert.equal(check('😀'.repeat(490)).ok, true);
  assert.equal(check('😀'.repeat(490) + '。').ok, false);
  assert.equal(check('😀'.repeat(490) + '。').count, 981);
});
