import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFormalRagRequest, formalRagReplyResult, routeBusinessClarification, validateFormalRagResponseSnapshot } from '../src/services/formal-rag-routing.js';
import { validateFormalRagRequest } from '../src/services/rag-contract.js';
import { getReplyLimit, validateReplyTextLength } from '../src/services/platform-reply-policy.js';

test('小程序私信保持正式 RAG V1 的兼容平台与渠道枚举', () => {
  const request = buildFormalRagRequest({ message: { id: 1, platform_code: 'mini_program', account_id: 6, message_type: 'PRIVATE_MESSAGE', content: '测试' } });
  assert.equal(request.source.platform, 'DOUYIN');
  assert.equal(request.source.channelType, 'DIRECT_MESSAGE');
  assert.equal(validateFormalRagRequest(request).ok, true);
});

test('正式 RAG 请求遵循 1.0 合同并生成可回显输入指纹', () => {
  const request = buildFormalRagRequest({
    message: {
      id: 9, platform_code: 'douyin', account_id: 2, message_type: 'PRIVATE_MESSAGE', content: '怎么办理',
      conversation_key_snapshot: 'douyin:2:pm:u1', conversation_version: 3, created_at: '2026-08-28T08:00:00+08:00'
    },
    conversation: { handling_mode: 'BOT_ACTIVE' },
    recentMessages: [{ id: 8, content: '我想咨询业务', created_at: '2026-08-28T07:59:00+08:00' }]
  });
  assert.equal(request.contractVersion, '1.0');
  assert.equal(request.snapshot.conversationVersion, 3);
  assert.match(request.snapshot.inputFingerprint, /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(request.source, { platform: 'DOUYIN', accountId: '2', channelType: 'DIRECT_MESSAGE' });
  assert.deepEqual(request.knowledgeScope, { tenantId: 'local-default', knowledgeBaseId: 'main-business-kb' });
  assert.deepEqual(request.query.messageIds, ['8', '9']);
  assert.equal(request.query.text, '怎么办理');
  assert.equal(request.constraints.requireGrounding, true);
  assert.equal(validateFormalRagRequest(request).ok, true);
});

test('正式 RAG 请求适配微博、B站、视频号和评论枚举', () => {
  const cases = [
    ['weibo', 'WEIBO'], ['bilibili', 'BILIBILI'], ['wechat_channels', 'WECHAT_CHANNELS']
  ];
  for (const [platformCode, expected] of cases) {
    const request = buildFormalRagRequest({ message: { id: 1, platform_code: platformCode, account_id: 1, message_type: 'COMMENT', content: '测试' } });
    assert.equal(request.source.platform, expected);
    assert.equal(request.source.channelType, 'COMMENT');
    assert.deepEqual(request.knowledgeScope, { tenantId: 'local-default', knowledgeBaseId: 'main-business-kb' });
    assert.equal('filters' in request.knowledgeScope, false);
  }
});

test('RAG 返回快照必须和原请求完全一致', () => {
  const request = buildFormalRagRequest({ message: { id: 1, platform_code: 'douyin', account_id: 1, message_type: 'PRIVATE_MESSAGE', content: '测试', conversation_version: 2 } });
  assert.equal(validateFormalRagResponseSnapshot(request, { snapshot: request.snapshot }).ok, true);
  assert.equal(validateFormalRagResponseSnapshot(request, { snapshot: { ...request.snapshot, conversationVersion: 3 } }).code, 'RAG_CONVERSATION_VERSION_MISMATCH');
  assert.equal(validateFormalRagResponseSnapshot(request, {}).code, 'RAG_SNAPSHOT_MISSING');
});

test('正式 RAG 按目标平台和消息通道请求可发送的答案长度', () => {
  for (const [platformCode, commentLimit, privateLimit] of [
    ['douyin', 480, 480], ['weibo', 120, 280],
    ['bilibili', 980, 480], ['wechat_channels', 180, 480]
  ]) {
    for (const [messageType, expectedLimit] of [['COMMENT', commentLimit], ['PRIVATE_MESSAGE', privateLimit]]) {
      const request = buildFormalRagRequest({ message: { id: 1, platform_code: platformCode, message_type: messageType, content: '办理需要什么材料？' } });
      assert.equal(request.constraints.maxAnswerChars, expectedLimit, `${platformCode}/${messageType}`);
      assert.equal(request.constraints.requireGrounding, true);
    }
  }
});

test('抖音 209 字符评论答案完整通过，不再被旧的 120 限制拦截', () => {
  const text = '答'.repeat(208) + '。';
  const result = formalRagReplyResult({ result: 'ANSWERED', answer: { text } }, { platformCode: 'douyin', messageType: 'COMMENT' });
  assert.equal(result.action, 'REPLY');
  assert.equal(result.replyText, text);
});

test('RAG 超长答案转人工且不截断正文或创建回复', () => {
  const text = '答'.repeat(480) + '。';
  const result = formalRagReplyResult({ result: 'ANSWERED', answer: { text } }, { platformCode: 'douyin', messageType: 'COMMENT' });
  assert.equal(result.action, 'HANDOFF');
  assert.equal(result.decision, 'RAG_REPLY_TOO_LONG');
  assert.equal(result.replyText, null);
  assert.match(result.reason, /481.*480/);
  assert.equal(result.handoffOffered, false);
});

test('RAG 因无法生成完整短答而拒答时按超长转人工，私信不进入无答案澄清', () => {
  for (const messageType of ['COMMENT', 'PRIVATE_MESSAGE']) {
    const result = formalRagReplyResult({ result: 'NO_ANSWER', reasonCode: 'ANSWER_TOO_LONG' }, { platformCode: 'douyin', messageType });
    assert.equal(result.action, 'HANDOFF');
    assert.equal(result.decision, 'RAG_REPLY_TOO_LONG');
    assert.equal(result.replyText, null);
    assert.match(result.reason, /480/);
  }
});

test('RAG 抖音评论和私信按官网输入框计数，480 以内可发', () => {
  for (const text of ['答'.repeat(479) + '。', '😀'.repeat(239) + '。', 'e\u0301'.repeat(479) + '。']) {
    const result = formalRagReplyResult({ result: 'ANSWERED', answer: { text } }, { platformCode: 'douyin', messageType: 'COMMENT' });
    assert.equal(result.action, 'REPLY');
    assert.equal(result.replyText, text);
  }
  assert.equal(formalRagReplyResult({ result: 'ANSWERED', answer: { text: '答'.repeat(481) } }, { platformCode: 'douyin', messageType: 'COMMENT' }).action, 'HANDOFF');
  const text = '😀'.repeat(240) + '。';
  assert.equal(formalRagReplyResult({ result: 'ANSWERED', answer: { text } }, { platformCode: 'douyin', messageType: 'COMMENT' }).action, 'HANDOFF');
  assert.equal(formalRagReplyResult({ result: 'ANSWERED', answer: { text } }, { platformCode: 'douyin', messageType: 'PRIVATE_MESSAGE' }).action, 'HANDOFF');
});

test('抖音评论官网上限为 500，自动回复预留 20，表情按网页 UTF-16 长度计数', () => {
  const policy = getReplyLimit('douyin', 'COMMENT');
  assert.equal(policy.publishedMax, 500);
  assert.equal(policy.safeMax, 480);
  const check = text => validateReplyTextLength({ platformCode: 'douyin', messageType: 'COMMENT', text, usePublishedMax: true });
  assert.equal(check('答'.repeat(500)).ok, true);
  assert.equal(check('答'.repeat(501)).ok, false);
  assert.equal(check('😀'.repeat(250)).ok, true);
  assert.equal(check('😀'.repeat(251)).ok, false);
  assert.equal(check('😀'.repeat(251)).count, 502);
});

test('正式 RAG 评论直接回复知识答案并保留 grounding 引用', () => {
  const result = formalRagReplyResult({
    result: 'ANSWERED',
    answer: { text: '请携带身份证件。' },
    grounding: { confidence: 0.91, sourceReferences: [{ documentId: 'doc-1', chunkId: 'chunk-1' }] }
  }, { messageType: 'COMMENT' });
  assert.equal(result.action, 'REPLY');
  assert.equal(result.replyText, '请携带身份证件。');
  assert.equal(result.confidence, 0.91);
  assert.deepEqual(result.sourceReferences, [{ documentId: 'doc-1', chunkId: 'chunk-1' }]);
});

test('RAG 评论没有可靠答案时直接转人工且不生成公开回复', () => {
  for (const result of ['NO_ANSWER', 'NEED_CLARIFICATION', 'REJECTED', 'ANSWERED', 'UNAVAILABLE']) {
    const comment = formalRagReplyResult({ result }, { messageType: 'COMMENT' });
    assert.equal(comment.action, 'HANDOFF', result);
    assert.equal(comment.replyText, null, result);
    assert.equal(comment.handoffOffered, false, result);
  }
});

test('RAG 私信无答案先澄清，第三轮直接转人工且不再要求用户确认', () => {
  const first = formalRagReplyResult({ result: 'NO_ANSWER' }, { messageType: 'PRIVATE_MESSAGE' });
  assert.equal(first.action, 'REPLY');
  assert.equal(first.decision, 'RAG_NEED_CLARIFICATION');
  const privateResult = formalRagReplyResult({ result: 'NO_ANSWER' }, { messageType: 'PRIVATE_MESSAGE', guidanceAttempt: 3, maxGuidanceAttempts: 3 });
  assert.equal(privateResult.decision, 'RAG_CLARIFICATION_LIMIT');
  assert.equal(privateResult.action, 'HANDOFF');
  assert.equal(privateResult.replyText, null);
  assert.equal(privateResult.handoffRequested, true);
  assert.equal(privateResult.handoffOffered, false);
  assert.match(privateResult.reason, /3轮.*转人工/);
});

test('各平台私信的申请引导只补问业务名称并保留申请流程意图', () => {
  for (const platformCode of ['douyin', 'wechat_channels', 'weibo', 'bilibili', 'xiaohongshu']) {
    const result = formalRagReplyResult({ result: 'NO_ANSWER', reasonCode: 'INSUFFICIENT_EVIDENCE' }, {
      platformCode, messageType: 'PRIVATE_MESSAGE', question: '怎么申请？'
    });
    assert.equal(result.decision, 'RAG_NEED_CLARIFICATION');
    assert.match(result.replyText, /哪项业务/);
    assert.match(result.replyText, /申请流程/);
    assert.doesNotMatch(result.replyText, /INSUFFICIENT_EVIDENCE|转人工/);
  }
});

test('私信引导不使用无关候选，也不会重复刚确认过的候选问题', () => {
  const reference = { documentId: 'doc-policy', chunkId: 'chunk-policy', title: '什么是“七免两低”扶持政策？', sectionPath: ['OPC港澳服务社区'], verificationStatus: 'VERIFIED' };
  const response = { result: 'NO_ANSWER', grounding: { sourceReferences: [reference] } };
  const unrelated = formalRagReplyResult(response, { question: 'App在哪里下载？' });
  assert.doesNotMatch(unrelated.replyText, /七免两低/);
  const context = [{ role: 'USER', text: '社区有哪些政策？' }, { role: 'ASSISTANT', text: '你是想了解“七免两低”扶持政策吗？' }];
  const rejected = formalRagReplyResult(response, { question: '不是', context, guidanceAttempt: 2 });
  assert.doesNotMatch(rejected.replyText, /七免两低/);
  assert.match(rejected.replyText, /明白/);
  const repeated = formalRagReplyResult(response, { question: '社区政策有哪些？', context, guidanceAttempt: 2 });
  assert.doesNotMatch(repeated.replyText, /七免两低/);
  assert.match(repeated.replyText, /社区/);
});

test('政策对象不明时先确认，已明确的业务和评论仍进入知识检索', () => {
  assert.equal(routeBusinessClarification({ question: '这个有什么政策？' }).matchMethod, 'OUTER_ROUTER');
  assert.equal(routeBusinessClarification({ question: '港澳社区有什么政策？' }), null);
  assert.equal(routeBusinessClarification({ question: '这个有什么政策？', context: [{ role: 'USER', text: '我想了解港澳服务社区' }] }), null);
  assert.equal(routeBusinessClarification({ question: '这个有什么政策？', messageType: 'COMMENT' }), null);
  const repeated = routeBusinessClarification({ question: '有哪些政策？', guidanceAttempt: 3, context: [{ role: 'USER', text: '这个有什么政策？' }] });
  assert.equal(repeated.action, 'HANDOFF');
  assert.equal(repeated.replyText, null);
});

test('同一消息重新判断使用新的 RAG 运行标识，保持会话快照一致', () => {
  const input = { message: { id: 111, platform_code: 'douyin', account_id: 2, message_type: 'PRIVATE_MESSAGE', content: '就是社区政策有哪一些' } };
  const first = buildFormalRagRequest(input);
  const retried = buildFormalRagRequest(input);
  assert.notEqual(first.requestId, retried.requestId);
  assert.notEqual(first.traceId, retried.traceId, 'RAG 会拒绝新请求复用旧 traceId');
  assert.deepEqual(first.snapshot, retried.snapshot);
});

test('评论检索携带已核实的作品主题，保持问题完整并参与会话指纹', () => {
  for (const platform_code of ['douyin', 'weibo', 'wechat_channels', 'bilibili', 'xiaohongshu']) {
    const message = { id: 105, platform_code, account_id: 1, message_type: 'COMMENT', content: '怎么申请入驻？', context_json: JSON.stringify({ sourceVerified: true, sourceVideoTitle: 'OPC社区七免两低扶持港澳创业' }) };
    const request = buildFormalRagRequest({ message });
    assert.match(request.query.text, /OPC社区七免两低扶持港澳创业/);
    assert.match(request.query.text, /怎么申请入驻？/);
    assert.equal(request.constraints.requireGrounding, true);
    assert.equal(validateFormalRagRequest(request).ok, true);
    assert.deepEqual(request.context, [], '作品不能伪装成用户历史发言');
    const changed = buildFormalRagRequest({ message: { ...message, context_json: JSON.stringify({ sourceVerified: true, sourceVideoTitle: '其他社区' }) } });
    assert.notEqual(request.snapshot.inputFingerprint, changed.snapshot.inputFingerprint);
  }
});

test('未核实的作品和私信残留标题不得成为评论检索主题', () => {
  for (const [message_type, context] of [
    ['COMMENT', { sourceVerified: false, sourceVideoTitle: '错误作品' }],
    ['COMMENT', { sourceVideoTitle: '待归因作品' }],
    ['PRIVATE_MESSAGE', { sourceVerified: true, sourceVideoTitle: '旧作品' }],
    ['COMMENT', { sourceVerified: false, subjectTitle: '错误作品' }],
    ['COMMENT', { subjectTitle: '待归因作品' }],
    ['PRIVATE_MESSAGE', { sourceVerified: true, subjectTitle: '旧作品' }]
  ]) {
    const request = buildFormalRagRequest({ message: { id: 1, message_type, content: '怎么申请？', context_json: JSON.stringify(context) } });
    assert.equal(request.query.text, '怎么申请？');
  }
  const content = '问'.repeat(3970) + '最终条件是什么？';
  const request = buildFormalRagRequest({ message: { id: 2, message_type: 'COMMENT', content, context_json: JSON.stringify({ sourceVerified: true, postTitle: '长标题'.repeat(200) }) } });
  assert.ok([...request.query.text].length <= 4000);
  assert.ok(request.query.text.includes(content), '不能为插入标题截掉原问题');
});

test('已入库的B站作品标题兼容平台字段并参与检索指纹', () => {
  for (const field of ['subjectTitle', 'subject_title']) {
    const message = { id: 122, platform_code: 'bilibili', message_type: 'COMMENT', content: '怎么申请？' };
    const request = buildFormalRagRequest({ message: {
      ...message, context_json: JSON.stringify({ sourceVerified: true, [field]: '澳车北上免抽签申请攻略' })
    } });
    assert.match(request.query.text, /澳车北上免抽签申请攻略/);
    assert.equal(validateFormalRagRequest(request).ok, true);
    const changed = buildFormalRagRequest({ message: {
      ...message, context_json: JSON.stringify({ sourceVerified: true, [field]: '其他业务申请指南' })
    } });
    assert.notEqual(request.snapshot.inputFingerprint, changed.snapshot.inputFingerprint);
  }
});

test('费用材料地址报名先确认对象，已有业务上下文时再查询知识库', () => {
  for (const question of ['多少钱？', '请问要什么材料', '地址在哪里', '如何报名', '在哪里申请', '这个要多少钱', '需要什麼材料？']) {
    const first = routeBusinessClarification({ question });
    assert.equal(first?.matchMethod, 'OUTER_ROUTER', question);
    assert.equal(first.guidanceAttempt, 1);
    assert.equal(routeBusinessClarification({ question, context: [{ role: 'USER', text: '我想了解OPC港澳服务社区' }] }), null);
    const second = routeBusinessClarification({ question, context: [{ role: 'USER', text: '多少钱？' }, { role: 'USER', text: '你好' }], guidanceAttempt: 2 });
    assert.equal(second?.guidanceAttempt, 2, '省略对象和问候不能冒充已知业务');
    assert.equal(routeBusinessClarification({ question, messageType: 'COMMENT' }), null);
  }
  for (const question of ['澳车北上需要什么材料', 'OPC社区入驻多少钱', '社区政策有哪些', '这个App在哪里下载']) {
    assert.equal(routeBusinessClarification({ question }), null, question);
  }
});

test('RAG 超时和空答案统一为实际转人工，超时只输出简短原因', () => {
  for (const error of [{ code: 'RAG_EXECUTION_TIMEOUT', message: 'request failed' }, { name: 'TimeoutError', message: 'request failed' }, { code: 'OTHER', message: 'Timed out after 30000 ms. Call log: secret stack' }]) {
    const result = formalRagReplyResult({ status: 'UNAVAILABLE', error, retryable: true });
    assert.equal(result.action, 'HANDOFF');
    assert.equal(result.handoffRequested, true);
    assert.equal(result.decision, 'AI_REPLY_TIMEOUT');
    assert.equal(result.reason, 'AI回复超时');
    assert.equal(result.replyText, null);
    assert.equal(result.guidanceAttempt, 0, '故障不算业务引导');
  }
  const empty = formalRagReplyResult({ result: 'ANSWERED', answer: { text: '  ' } });
  assert.equal(empty.action, 'HANDOFF');
  assert.equal(empty.handoffRequested, true);
  assert.doesNotMatch(empty.reason, /ANSWERED|UNAVAILABLE/);
});

test('否定、不知道和泛泛咨询不能替代已确认的业务对象', () => {
  for (const text of ['不是', '不知道', '不清楚', '我想咨询一下', '想问一下', '没有', '嗯']) {
    const context = [{ role: 'USER', text }, { role: 'ASSISTANT', text: '您是想了解澳车北上吗？' }];
    const result = routeBusinessClarification({ question: '怎么申请', context, guidanceAttempt: 2 });
    assert.equal(result?.matchMethod, 'OUTER_ROUTER', text);
    assert.equal(result.guidanceAttempt, 2, text);
    assert.equal(routeBusinessClarification({ question: '怎么申请', context: [{ role: 'USER', text: '我想咨询澳车北上' }, ...context] }), null);
  }
});


test('评论仅判断当前一条及所属作品，不使用历史会话；私信保留历史', () => {
  const message = { id: 202, platform_code: 'douyin', account_id: 1, message_type: 'COMMENT', content: '怎么加入', context_json: JSON.stringify({ sourceVerified: true, sourceVideoTitle: 'OPC港澳服务社区入驻介绍' }) };
  const recentMessages = [{ id: 201, content: '我想报名另一场活动', status: 'AUTO_REPLIED', reply_text: '请提供活动名称' }];
  const comment = buildFormalRagRequest({ message, recentMessages });
  assert.deepEqual(comment.context, []);
  assert.deepEqual(comment.query.messageIds, ['202']);
  assert.match(comment.query.text, /OPC港澳服务社区/);
  const privateRequest = buildFormalRagRequest({ message: { ...message, message_type: 'PRIVATE_MESSAGE' }, recentMessages });
  assert.equal(privateRequest.context.length, 2);
  assert.deepEqual(privateRequest.query.messageIds, ['201', '202']);
});
