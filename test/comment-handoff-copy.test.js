import test from 'node:test';
import assert from 'node:assert/strict';
import { commentHandoffCopy, isSafeCommentHandoffCopy } from '../src/services/comment-handoff-copy.js';

test('评论邀请使用详情与站内消息，不公开人工接管或私信发送承诺', () => {
  for (const platformCode of ['douyin', 'weibo', 'bilibili', 'wechat_channels']) {
    const copy = commentHandoffCopy({ platformCode });
    assert.match(copy.invitation, /回复“详情”.*站内消息/);
    assert.equal(copy.invitation, '想了解的话，回复“详情”，我们在站内消息里接着聊。');
    assert.equal(copy.fallbackReply, `这部分还得再确认一下。${copy.invitation}`);
    assert.doesNotMatch(copy.fallbackReply, /收到你的问题|具体信息还需要进一步确认|想继续了解吗|[？?]/);
    assert.doesNotMatch(copy.fallbackReply, /转人工|人工协助|客服|私聊|私信|微信|电话|已通知/);
    assert.equal(isSafeCommentHandoffCopy(copy.fallbackReply, { platformCode }), true);
  }
});

test('繁体和自动跟随语言也使用详情站内沟通', () => {
  for (const input of [{ script: 'traditional' }, { question: '我想學習人工智慧' }]) {
    const copy = commentHandoffCopy({ platformCode: 'douyin', ...input });
    assert.equal(copy.traditional, true);
    assert.match(copy.fallbackReply, /回覆「詳情」.*站內訊息/);
    assert.equal(copy.fallbackReply, '這部分還得再確認一下。想了解的話，回覆「詳情」，我們在站內訊息裡接著聊。');
    assert.equal(isSafeCommentHandoffCopy(copy.fallbackReply, { platformCode: 'douyin' }), true);
  }
});

test('抖音询问拦截外部联系、群引流和夸大承诺，也拒绝夹杂空格符号', () => {
  for (const text of [
    '加微信了解课程', '加 微·信了解', '加VX', '加群了解详情', '进群领取', '扫码看二维码',
    '联系电话13812345678', '私聊我', '私信你了', '保证报名成功', '百分之百有效', '免费领取资料',
    'https://example.com', 'www.example.com', '请回复转人工', '客服会联系你'
  ]) assert.equal(isSafeCommentHandoffCopy(text, { platformCode: 'douyin' }), false, text);
});

test('人工智能等正常学习主题可以自然承接', () => {
  for (const text of ['学人工智能这个问题，细节还得再核实一下。', 'AI学习这块，我还得确认一下。', '舞蹈课报名这事，具体还得确认一下。']) {
    assert.equal(isSafeCommentHandoffCopy(text, { platformCode: 'douyin' }), true, text);
  }
});
