import test from 'node:test';
import assert from 'node:assert/strict';
import { detectReplyLanguage, detectSocialMessage, socialReplyText, withoutIdentityClauses } from '../src/services/social-reply.js';
import { detectManualHandoffCommand } from '../src/services/conversation-intent.js';
import { routeIncomingMessage, MESSAGE_ROUTE } from '../src/services/message-router.js';
import { composeNoAnswerReply, handoffOfferResponse, questionAfterHandoffDecline } from '../src/services/reply-composer.js';
import { detectRisk } from '../src/services/decision.js';

const kind = text => detectSocialMessage(text)?.kind || null;

test('社交消息：夸奖、道谢收尾、发错对象、问身份直接回应，不进知识库', () => {
  assert.equal(kind('哈喽哈喽👋😄 刚刷到你们讲AI的那条视频，讲得挺接地气，连我都听懂了哈哈😂👍 (ง •̀_•́)ง'), 'PRAISE');
  assert.equal(kind('明白了，谢谢您的回复。我自己再找找，祝您周末愉快。'), 'CLOSING');
  assert.equal(kind('好的，明白了。电影我自己再找找，有课程方面的问题再来咨询您。谢谢！'), 'CLOSING');
  assert.equal(kind('谢谢，您说得很清楚。我会先确定第一版服务的学生，再梳理学校的正式文件。'), 'CLOSING');
  assert.equal(kind('唔好意思，撳錯咗，嗰句係畀我媽㗎😂'), 'MISDIRECTED');
  assert.equal(kind('媽，我今晚會晚啲返屋企，唔使等我食飯。'), 'FAMILY_MESSAGE');
  assert.equal(kind('你好，请问你怎么称呼？你是智能客服，还是人工客服？你能帮我解答哪些课程问题？'), 'IDENTITY');
  assert.equal(kind('Thank you. Starting with one request type makes sense.'), 'CLOSING');
  assert.equal(kind('好的，谢谢帮忙！'), 'CLOSING');
  assert.equal(kind('讲得太好了，已经推荐给朋友了👍'), 'PRAISE');
  assert.equal(kind('哦懂了，课里连上服务器、发链接给别人用都教。那就行，我还怕最后只能给人发个 localhost，让人猜我做了啥呢😂 谢啦！'), 'CLOSING');
  assert.equal(kind('懂了，我就想知道到底咋按人挑内容，不是把同一篇报告换俩皮肤😂 这下清楚了，谢啦。'), 'CLOSING');
  assert.equal(kind('好嘞～我先把视频收藏啦🥰 暂时没啥要问的，就是刷到这么好懂的讲解，想来给你们点个赞哈哈 以后有问题再来找你呀～'), 'PRAISE');
  assert.equal(kind('好嘞～有想问的我再来戳你😄 你们继续更这种一听就懂的AI视频哈'), 'PRAISE');
});

test('社交消息：夹带真实问题或不满时不拦截', () => {
  assert.equal(kind('明白了，想再确认一下，第一版做出来后是用原始记录重新生成再对照检查吗？'), null);
  assert.equal(kind('好的，我想咨询下报名'), null);
  assert.equal(kind('有回放么'), null);
  assert.equal(kind('您好，想请您推荐一部适合周末和家人一起看的电影。最好轻松一些，不要太长。'), null);
  assert.equal(kind('哦，能部署这事儿明白了。我再问细点哈：课上会带着我们部署到服务器，还是本地跑通就结课😂'), null);
  assert.equal(kind('懂了，那报名咋弄呢？谢啦'), null);
  assert.equal(kind('我没啥要问的，想问下报名几号截止'), null);
  assert.equal(kind('谢谢，这个课程太差了，我要退款'), null);
  assert.equal(kind('你好，请问你是人工客服，还是智能助手？我想了解一下 AI 课程，你能帮我介绍一下吗？'), null);
});

test('社交回应跟随繁体、粤语和英文', () => {
  const support = '嘿嘿收到～我先点个关注，你们多拍点这种举例子的哈，真的好懂！';
  assert.match(socialReplyText(detectSocialMessage(support), { source: support }), /关注|鼓励/);
  const cantonese = '唔好意思，撳錯咗';
  assert.match(socialReplyText(detectSocialMessage(cantonese), { source: cantonese }), /唔緊要/);
  const traditional = '啊拍謝，傳錯人了啦😅 謝謝～';
  assert.match(socialReplyText(detectSocialMessage(traditional), { source: traditional }), /沒關係/);
  assert.equal(detectReplyLanguage('Hello, does your AI course cover how to build a small system?'), 'english');
  assert.match(socialReplyText(detectSocialMessage('Thanks a lot, that was helpful.'), { source: 'Thanks a lot' }), /welcome/i);
});

test('问身份不再被当成转人工；身份之外明确要人工仍然转', () => {
  assert.equal(detectManualHandoffCommand('你好，请问你是人工客服还是机器人？').matched, false);
  assert.equal(detectManualHandoffCommand('你是人工客服吗？帮我转人工').matched, true);
  assert.equal(detectManualHandoffCommand('可以帮我转人工客服吗').matched, true);
  assert.equal(detectManualHandoffCommand('human').matched, true);
  assert.equal(detectManualHandoffCommand('Could I talk to a human please?').matched, true);
  assert.equal(detectManualHandoffCommand('No need to talk to a human, thanks').matched, false);
  assert.doesNotMatch(withoutIdentityClauses('你是人工客服，还是智能助手？'), /人工/);
  const route = routeIncomingMessage({ message: { message_type: 'PRIVATE_MESSAGE', platform_code: 'douyin', content: '你好，你是人工客服还是机器人？你能帮我解答哪些问题？' } });
  assert.equal(route.route, MESSAGE_ROUTE.DIRECT_REPLY);
  assert.match(route.replyText, /智能助手/);
});

test('婉拒转人工时顺带的新问题会被保留下来继续作答', () => {
  assert.equal(handoffOfferResponse('不用了哈，不用转人工～😊 那我换个问题：5月10号那节课会讲怎么把微信和 Claude Code 连起来用吗？'), 'DECLINE');
  assert.match(questionAfterHandoffDecline('不用了哈，不用转人工～😊 那我换个问题：5月10号那节课会讲怎么把微信和 Claude Code 连起来用吗？'), /^5月10号那节课/);
  assert.match(questionAfterHandoffDecline('不用啦，发票的事儿我回头再问～谢谢哈 对了，我云服务器上已经预装了 OpenClaw，想接 Telegram 能直接用现有环境吗？'), /^我云服务器上/);
  assert.equal(questionAfterHandoffDecline('不用了，谢谢'), '');
  assert.equal(handoffOfferResponse('No thanks'), 'DECLINE');
});

test('已婉拒转人工后，知识缺口说明不再邀请转人工；开票不被当成价格问题；英文用英文', () => {
  const declined = composeNoAnswerReply({ reasonCode: 'NO_EVIDENCE' }, { question: '能用 Windows 笔记本吗', handoffDeclined: true });
  assert.doesNotMatch(declined.replyText, /转人工/);
  assert.equal(declined.handoffOffered, false);
  const invoice = composeNoAnswerReply({ reasonCode: 'NO_EVIDENCE' }, { question: '付款后还能开公司抬头的增值税专票吗，费用怎么报销' });
  assert.doesNotMatch(invoice.replyText, /价格|費用這塊|费用这块/);
  const english = composeNoAnswerReply({ reasonCode: 'NO_EVIDENCE' }, { question: 'Does the course include a hands-on exercise?', script: 'english' });
  assert.match(english.replyText, /reply "human"/);
});

test('与业务无关：找电影、推荐片子都友好划定范围', () => {
  for (const question of ['你好，我想找一部适合周末晚上看的电影。有没有轻松一点的推荐？', '想请您推荐一部适合周末和家人一起看的电影', '有没有温暖一点的喜剧片']) {
    assert.equal(composeNoAnswerReply({ reasonCode: 'NO_EVIDENCE' }, { question }).kind, 'OUT_OF_SCOPE', question);
  }
  assert.notEqual(composeNoAnswerReply({ reasonCode: 'NO_EVIDENCE' }, { question: '推荐一门适合零基础的 AI 课' }).kind, 'OUT_OF_SCOPE');
});

test('风险词：看恐怖片不是敏感内容，恐怖袭击仍然是', () => {
  assert.equal(detectRisk('我喜欢悬疑片，但不太敢看恐怖片').risk, false);
  assert.equal(detectRisk('关于恐怖袭击的内容').risk, true);
});
