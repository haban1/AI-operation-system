import test from 'node:test';
import assert from 'node:assert/strict';
import { extractProtectedFacts, validateMultiReply, validateReply } from '../src/services/decision.js';
import {
  detectGreetingIntent,
  isGreetingOnlyMessage,
  detectSmallTalkIntent,
  smallTalkFallbackReply,
  detectManualHandoffCommand,
  splitUserQuestions,
  questionTopic,
  knowledgeGapReply,
  composeGroundedMultiReply,
  GREETING_REPLY,
  HANDOFF_SUBMITTED_REPLY,
  ensureNaturalReplyGreeting
} from '../src/services/conversation-intent.js';
import { analyzeContextNeed, businessConversationContext, commentSourceTopicAnchor, consecutiveBusinessGuidanceAttempts, evaluateReply, smallTalkConversationContext } from '../src/services/reply-engine.js';

test('单独问候语会进入引导，不把带问题的问候误判为纯问候', () => {
  assert.deepEqual(detectGreetingIntent('你好'), { greetingOnly: true, effectiveQuestion: '' });
  assert.deepEqual(detectGreetingIntent('在吗？'), { greetingOnly: true, effectiveQuestion: '' });
  assert.deepEqual(detectGreetingIntent('你好啊'), { greetingOnly: true, effectiveQuestion: '' });
  assert.deepEqual(detectGreetingIntent('在吗呀？'), { greetingOnly: true, effectiveQuestion: '' });
  assert.deepEqual(detectGreetingIntent('你好，请问活动收费吗？'), { greetingOnly: false, effectiveQuestion: '请问活动收费吗？' });
  assert.deepEqual(detectGreetingIntent('你好啊，请问活动收费吗？'), { greetingOnly: false, effectiveQuestion: '请问活动收费吗？' });
  assert.match(GREETING_REPLY, /活动|报名/);
});

test('只有明确人工指令才触发，否定、疑问和引用不会误触发', () => {
  for (const text of ['转人工', '请转人工处理', '麻烦找客服', '我要人工回复', '那你帮我转人工吧', '帮我转个人工', '好吧那帮我转个人工', '请帮我转接一下客服', '给我找一位工作人员']) {
    assert.equal(detectManualHandoffCommand(text).matched, true, text);
  }
  for (const text of ['我不想转人工', '不要帮我转个人工', '是不是需要转人工', '你刚才让我输入“转人工”', '你刚才说“帮我转个人工”', '可以转人工吗', '可以帮我转个人工吗']) {
    assert.equal(detectManualHandoffCommand(text).matched, false, text);
  }
  assert.equal(HANDOFF_SUBMITTED_REPLY, '好，我帮你转人工，稍等一下。');
  assert.doesNotMatch(HANDOFF_SUBMITTED_REPLY, /^你好~，/);
});

test('自定义转人工说法采用完整句匹配并支持停用', () => {
  assert.equal(detectManualHandoffCommand('给我，安排专员！', { customPhrases: ['给我安排专员'] }).matched, true);
  assert.equal(detectManualHandoffCommand('我只是说给我安排专员', { customPhrases: ['给我安排专员'] }).matched, false);
  assert.equal(detectManualHandoffCommand('给我安排专员', { customPhrases: [{ phrase: '给我安排专员', status: 'DISABLED' }] }).matched, false);
  assert.equal(detectManualHandoffCommand('给我安排专员', { customPhrases: [{ normalized_phrase: '给我安排专员', status: 'ENABLED' }] }).reason, 'EXPLICIT_CUSTOM_HANDOFF_PHRASE');
});

test('多问题拆分保留每个核心问题', () => {
  const result = splitUserQuestions('你好，请问什么时候开始，怎么报名，要不要钱，可以带孩子吗？');
  assert.deepEqual(result.questions, ['什么时候开始', '怎么报名', '要不要钱', '可以带孩子吗']);
  assert.equal(result.truncated, false);
  assert.deepEqual(splitUserQuestions('最近有什么活动，能带小孩参加吗').questions, ['最近有什么活动', '能带小孩参加吗']);
  assert.deepEqual(splitUserQuestions('你视频里的这个活动，是干什么的呀，怎么报名参加呀').questions, ['你视频里的这个活动，是干什么的呀，怎么报名参加呀']);
});

test('知识缺口话术能提取“是否可以带孩子”的主题', () => {
  assert.equal(questionTopic('可以带孩子吗'), '是否可以带孩子');
  assert.equal(
    knowledgeGapReply('可以带孩子吗'),
    '你说的是哪场活动？把活动名字发我，我帮你看看孩子能不能一起去。'
  );
  assert.equal(questionTopic('能不能带娃一起去'), '是否可以带孩子');
});

test('兜底话术默认在第三次澄清提示转人工，前两次不提前提示', () => {
  const commentReply = knowledgeGapReply('这个活动具体怎么安排？', { messageType: 'COMMENT' });
  assert.equal(commentReply, '你说的是哪场活动？把活动名字发我，再告诉我想问哪方面。');
  assert.doesNotMatch(commentReply, /转人工|请输入|无法确认|私信/);
  assert.equal(knowledgeGapReply('什么资格？', { messageType: 'COMMENT' }), '你是想问这个活动需要满足什么条件才能参加吗？');
  const privateReply = knowledgeGapReply('这个活动具体怎么安排？', { messageType: 'PRIVATE_MESSAGE', attempt: 1 });
  assert.match(privateReply, /哪场活动|活动名字/);
  assert.doesNotMatch(privateReply, /转人工/);
  assert.doesNotMatch(knowledgeGapReply('这个活动具体怎么安排？', { messageType: 'PRIVATE_MESSAGE', attempt: 2 }), /转人工/);
  assert.doesNotMatch(smallTalkFallbackReply('CASUAL_CHAT', { attempt: 2 }), /转人工/);
  assert.match(smallTalkFallbackReply('CASUAL_CHAT', { attempt: 3 }), /转人工/);
  const escalatedReply = knowledgeGapReply('这个活动具体怎么安排？', { messageType: 'PRIVATE_MESSAGE', attempt: 3 });
  assert.match(escalatedReply, /转人工/);
  assert.equal((escalatedReply.match(/转人工/g) || []).length, 1);
});
test('评论来源作品会作为省略问题的知识库检索上下文', async () => {
  const message = {
    id: 78,
    content: '需要多少钱？',
    context: {},
    context_json: JSON.stringify({
      sourceVerified: true,
      sourceVideoTitle: 'OPC社区零门槛助港澳创业，七免两低，免办公场地租赁及部分创业服务费用'
    })
  };
  const anchor = commentSourceTopicAnchor(message, 'COMMENT');
  assert.deepEqual(anchor, {
    text: 'OPC社区零门槛助港澳创业，七免两低，免办公场地租赁及部分创业服务费用',
    sourceMessageId: 78,
    source: 'source_post'
  });
  assert.equal(commentSourceTopicAnchor(message, 'PRIVATE_MESSAGE'), null);
  assert.equal(commentSourceTopicAnchor({ ...message, context_json: JSON.stringify({ sourceVerified: false, sourceVideoTitle: '不可靠来源' }) }, 'COMMENT'), null);

  const contextState = analyzeContextNeed(message.content, [], anchor);
  assert.equal(contextState.elliptical, true);
  assert.equal(contextState.anchor.source, 'source_post');

  const result = await evaluateReply({
    message,
    platformCode: 'douyin',
    messageType: 'COMMENT',
    searchOptions: { knowledgeIds: [-1] }
  });
  assert.equal(result.contextUsed, true);
  assert.match(result.resolvedQuestions[0], /OPC社区.*用户追问：需要多少钱/);
  assert.equal(result.action, 'HANDOFF');
  assert.equal(result.replyText, null);
  assert.deepEqual(result.unknownQuestions, ['需要多少钱']);
});

test('业务与闲聊上下文均限最近三轮，澄清计数单独统计', () => {
  const history = Array.from({ length: 5 }, (_, index) => ({ id: index + 1, content: `问题${index + 1}`, decision: 'AUTO_REPLY' }));
  assert.deepEqual(businessConversationContext(history).map(item => item.id), [3, 4, 5]);
  const greetings = history.map(item => ({ ...item, decision: 'SMALL_TALK' }));
  assert.deepEqual(smallTalkConversationContext(greetings).map(item => item.id), [3, 4, 5]);
  assert.equal(consecutiveBusinessGuidanceAttempts(greetings), 5);
});

test('评论问候未命中知识时也直接转人工，不调用闲聊回复器', async () => {
  let smallTalkCalls = 0;
  const result = await evaluateReply({
    message: '你好', platformCode: 'douyin', messageType: 'COMMENT',
    searchOptions: { knowledgeIds: [-1] },
    composeSmallTalkReplyFn: async () => { smallTalkCalls += 1; return { text: '请私信咨询业务。' }; }
  });
  assert.equal(result.action, 'HANDOFF');
  assert.equal(result.replyText, null);
  assert.equal(smallTalkCalls, 0);
});

test('评论知识库没有直接答案时按问题做针对性澄清', () => {
  const companyTypeReply = knowledgeGapReply('OPC公司有哪些类型？', { messageType: 'COMMENT' });
  assert.match(companyTypeReply, /创业项目/);
  assert.match(companyTypeReply, /公司类型/);
  assert.notEqual(companyTypeReply, '你想问哪场活动或哪项业务？把名字和想了解的内容告诉我就行。');

  const feeReply = knowledgeGapReply('需要多少钱？', {
    messageType: 'COMMENT',
    sourceTopic: 'OPC社区零门槛入驻，七免两低'
  });
  assert.match(feeReply, /入驻费用/);
  assert.match(feeReply, /配套服务/);
});

test('单个复合问题中的逗号不会误拆成两个问题', () => {
  const result = splitUserQuestions('活动报名后,可以取消或更换参加人吗?');
  assert.deepEqual(result.questions, ['活动报名后,可以取消或更换参加人吗']);
});


test('多问题安全兜底不重复用户原问题，也不使用生硬编号模板', () => {
  const reply = composeGroundedMultiReply(
    [
      { question: '我看到你们发布的这个东西，想要跟你们的社区合作，成为你们社区的志愿者', knowledge: { answer: '请私信发送合作信息。' } }
    ],
    ['可以带孩子一起参加吗']
  );
  assert.equal(
    reply,
    '请私信发送合作信息。\n\n另外，你说的是哪场活动？把活动名字发我，我帮你看看孩子能不能一起去。'
  );
  assert.doesNotMatch(reply, /我看到你们发布的这个东西/);
  assert.doesNotMatch(reply, /关于你提出的问题|^[12]\./m);
});




test('多问题校验把所有标准答案视为可信依据，只检查AI新增衔接内容', () => {
  const answer1 = '內地支付寶可以綁定符合條件的銀行卡。';
  const answer2 = '转载前请先取得原作者授权。';
  const reply = `${answer1}\n\n另外，${answer2}`;
  assert.deepEqual(validateMultiReply(reply, [answer1, answer2], { maxLength: 500 }), { ok: true });
  assert.equal(validateMultiReply(`${reply} 请提供手机号。`, [answer1, answer2], { maxLength: 500 }).ok, false);
});


test('多问题安全兜底会把知识答案中的换行实体还原为真实换行', () => {
  const reply = composeGroundedMultiReply([{ knowledge: { answer: '第一行&#10;&#10;第二行' } }], []);
  assert.equal(reply, '第一行\n\n第二行');
});


test('纯闲聊会被识别，但带业务问题、实时事实问题和模糊业务追问不会误判', () => {
  for (const text of ['你好', '你好啊', '您好哟', '在吗呀', '谢谢你', '谢谢啊', '哈哈哈', '你叫什么名字？', '你是谁呢', '你能做什么？', '我今天心情不好']) {
    assert.equal(detectSmallTalkIntent(text).smallTalkOnly, true, text);
  }
  for (const text of ['你好，活动怎么报名？', '你好啊，活动怎么报名？', '哈哈，那活动收费吗？', '明天活动几点开始？', '可以吗？', '今天天气怎么样？']) {
    assert.equal(detectSmallTalkIntent(text).smallTalkOnly, false, text);
  }
  assert.match(smallTalkFallbackReply('IDENTITY'), /小智/);
});

test('回复引擎的纯闲聊真实走千问闲聊通道，不进入知识库', async () => {
  const calls = [];
  const result = await evaluateReply({
    message: { content: '你叫什么名字？' },
    platformCode: 'douyin',
    messageType: 'PRIVATE_MESSAGE',
    taskId: 'smalltalk-unit',
    composeSmallTalkReplyFn: async input => {
      calls.push(input);
      return { text: '我叫小智呀，有什么想聊的都可以告诉我。', businessDetected: false, model: 'unit-smalltalk-model' };
    }
  });
  assert.equal(calls.length, 1);
  assert.equal(result.decision, 'SMALL_TALK');
  assert.equal(result.responseMode, 'BUSINESS_GUIDANCE');
  assert.match(result.replyText, /小智/);
  assert.match(result.replyText, /活动|报名|办理/);
  assert.doesNotMatch(result.replyText, /陪.*聊|想聊的都可以/);
  assert.match(result.reason, /unit-smalltalk-model/);
  assert.deepEqual(result.matches, []);
});

test('第三次仍无法明确业务时提供转人工入口，可靠知识答复会重置计数', async () => {
  const previous = [1, 2].map(id => ({ id, content: '你好', decision: id % 2 ? 'SMALL_TALK' : 'KNOWLEDGE_GAP_GUIDANCE' }));
  assert.equal(consecutiveBusinessGuidanceAttempts(previous), 2);
  assert.equal(consecutiveBusinessGuidanceAttempts([...previous, { id: 5, decision: 'AUTO_REPLY' }]), 0);
  const result = await evaluateReply({
    message: { content: '你能做什么？' },
    platformCode: 'wechat_channels',
    messageType: 'PRIVATE_MESSAGE',
    recentMessages: previous,
    composeSmallTalkReplyFn: async () => ({ text: '我可以陪你聊聊。', businessDetected: false, model: 'unit-model' })
  });
  assert.equal(result.guidanceAttempt, 3);
  assert.equal(result.handoffOffered, true);
  assert.match(result.replyText, /转人工/);
  assert.doesNotMatch(result.replyText, /陪你聊/);
});

test('闲聊和业务上下文互相隔离', () => {
  const messages = [
    { id: 1, content: '活动怎么报名', decision: 'AUTO_REPLY', knowledge_question_snapshot: '社区活动怎么报名？' },
    { id: 2, content: '谢谢', decision: 'SMALL_TALK' },
    { id: 3, content: '你好', decision: 'GREETING_GUIDANCE' },
    { id: 4, content: '那收费吗', decision: 'KNOWLEDGE_GAP_GUIDANCE' }
  ];
  assert.deepEqual(smallTalkConversationContext(messages).map(item => item.id), [2, 3]);
  assert.deepEqual(businessConversationContext(messages).map(item => item.id), [4]);
});


test('自动回复不再机械添加问候，只清理历史遗留前缀', () => {
  assert.equal(ensureNaturalReplyGreeting('可以参加。'), '可以参加。');
  assert.equal(ensureNaturalReplyGreeting('您好，可以参加。'), '您好，可以参加。');
  assert.equal(ensureNaturalReplyGreeting('你好~，可以参加。'), '可以参加。');
});

test('评论区纯问候先问好并引导观众进入私信', () => {
  const reply = smallTalkFallbackReply('GREETING', { messageType: 'COMMENT' });
  assert.match(reply, /^你好呀/);
  assert.match(reply, /私信/);
  assert.doesNotMatch(reply, /转人工/);
});
test('待确认意图优先承接“对/不是”，纠正内容不会落入闲聊', async () => {
  let smallTalkCalls = 0;
  const composeSmallTalkReplyFn = async () => { smallTalkCalls += 1; return { text: '不应调用', businessDetected: false, model: 'unexpected' }; };
  const affirmed = await evaluateReply({
    message: { content: '对' }, platformCode: 'douyin', messageType: 'PRIVATE_MESSAGE',
    pendingIntent: { candidateQuestion: '这个活动需要什么资格' }, searchOptions: { knowledgeIds: [-1] }, composeSmallTalkReplyFn
  });
  assert.equal(affirmed.clarificationConfirmed, true);
  assert.equal(affirmed.resolvedQuestions[0], '这个活动需要什么资格');

  const denied = await evaluateReply({
    message: { content: '不是' }, platformCode: 'douyin', messageType: 'PRIVATE_MESSAGE',
    pendingIntent: { candidateQuestion: '这个活动需要什么资格' }, searchOptions: { knowledgeIds: [-1] }, composeSmallTalkReplyFn
  });
  assert.equal(denied.clarificationDenied, true);
  assert.match(denied.replyText, /想问的是哪方面/);

  const corrected = await evaluateReply({
    message: { content: '不是，我问的是报名时间' }, platformCode: 'douyin', messageType: 'PRIVATE_MESSAGE',
    pendingIntent: { candidateQuestion: '这个活动需要什么资格' }, searchOptions: { knowledgeIds: [-1] }, composeSmallTalkReplyFn
  });
  assert.equal(corrected.resolvedQuestions[0], '报名时间');
  assert.equal(smallTalkCalls, 0);
});

test('事实核验通过后允许自然改写，但时间金额和联系方式不能被改动或新增', () => {
  const knowledge = '活动周六14:30开始，费用20元，需提前报名。';
  assert.deepEqual(
    validateReply('周六14:30开场，费用20元，记得提前报名。', knowledge, { groundingVerified: true }),
    { ok: true }
  );
  assert.equal(validateReply('周六15:30开场，费用20元，记得提前报名。', knowledge, { groundingVerified: true }).ok, false);
  assert.equal(validateReply('周六14:30开场，费用20元，打13800138000报名。', knowledge, { groundingVerified: true }).ok, false);
  assert.deepEqual(extractProtectedFacts(knowledge), ['1430', '20元', '周六']);
});

test('抖音纯问候识别支持连续问候，但带业务问题不属于纯问候', () => {
  for (const text of ['你好', '在吗', '哈喽，你好呀']) {
    assert.equal(isGreetingOnlyMessage(text), true, text);
  }
  assert.equal(isGreetingOnlyMessage('你好，活动怎么报名？'), false);
  assert.equal(isGreetingOnlyMessage('哈喽，能带孩子参加吗？'), false);
});


