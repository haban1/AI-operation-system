import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import sharp from 'sharp';
import { precheckMaterial } from '../agent/precheck.js';
import { parseOcrModelContent, prepareOcrImages, recognizeMaterialText } from '../agent/material-ocr.js';
import { parseModelJson, reviewMaterialWithAi } from '../agent/material-ai-review.js';
import { detectRisk, validateReply } from '../src/services/decision.js';
import { countUnicodeCharacters, getReplyLimit, knowledgeAnswerPolicy, normalizeReplyTextForComparison, truncateUnicodeSafely, validateKnowledgeAnswerLength, validateReplyTextLength } from '../src/services/platform-reply-policy.js';
import { assessDouyinPrivatePreview } from '../src/services/message-precision.js';
import { assessAutoReplyEligibility } from '../src/services/auto-reply-eligibility.js';
import { douyinPrivateOccurrenceAnchor, isSameDouyinPrivateOccurrence } from '../src/services/douyin-message-identity.js';
import { assessWeiboMessagePrecision } from '../src/services/weibo-message-precision.js';
import { assessWeiboConversationSource } from '../src/services/weibo-message-source.js';
import { hasReliableWeiboReplyEvidence } from '../src/services/weibo-reply-evidence.js';
import { scoreKnowledge } from '../src/services/knowledge.js';
import { normalizeKnowledgeMatchResult } from '../src/services/qwen.js';
import { validatePublishPrecheck } from '../src/services/publish-validation.js';
import { COMPLIANCE_RULE_VERSION, reviewPublishContent, validateComplianceApproval } from '../src/services/content-compliance.js';
import { AI_REVIEW_RULE_VERSION, buildAiReviewInputHash, buildMockAiReview, normalizeAiReviewResult, validateAiReviewApproval } from '../src/services/ai-compliance.js';
import { buildPublishIdempotencyKey, deriveTaskStatus } from '../src/services/workflow.js';
import { buildXhsCommentExternalId, buildXhsPrivateExternalId, selectThumbnailNoteCandidate } from '../agent/rpa-adapters/xiaohongshu-assisted.js';
import { decryptSettingValue, encryptSettingValue, maskWecomWebhookUrl, validateWecomWebhookUrl } from '../src/services/settings.js';
import { randomIntervalMs } from '../src/services/polling.js';
import { buildManualNotification, normalizePlatformUserName, resolveRelatedNote } from '../src/services/manual-notification.js';
import { isRepeatedCommentOccurrence, platformEventAgeMs, repeatedExternalId } from '../src/services/message-occurrence.js';
import { buildReplyIdempotencyKey, commentSourceIdentity, douyinCommentOccurrenceAnchor, estimatedCommentEventAt, isSameDouyinCommentSemanticCandidate } from '../src/services/comment-identity.js';
import { createRpaRegistry, supportedPlatforms } from '../agent/rpa-adapters/registry.js';
import { BilibiliAssistedRpaAdapter, buildBilibiliCommentReplyForm, buildBilibiliPrivateReplyForm, detectBilibiliPendingDraft, parseBilibiliCommentFeed, parseBilibiliPrivateFeed } from '../agent/rpa-adapters/bilibili-assisted.js';
import { WeiboAssistedRpaAdapter, matchWeiboCommentIdentity, matchWeiboPrivateMessageIdentity, parseWeiboEventTime, weiboContentDeclarationLabels } from '../agent/rpa-adapters/weibo-assisted.js';
import { DouyinAssistedRpaAdapter } from '../agent/rpa-adapters/douyin-assisted.js';
import { WechatChannelsAssistedRpaAdapter } from '../agent/rpa-adapters/wechat-channels-assisted.js';
import { AssistedPlatformRpaAdapter, PLATFORM_ASSISTED_SPECS, assessWechatCommentOverviewEvidence, assessWechatPrivateMessageEvidence, assessManagementPublishRecord, classifyAssistedLoginEvidence, classifyManagementReviewEvidence, classifyMessagePageEvidence, constrainPlatformTitle, composePlatformPublishDescription, findVisibleTitleRecord, isNavigationTimeoutError, isPrivateSendControlEvidence, managementRecordIdentityCandidates, matchDouyinCommentIdentity, matchPrivateConversationIdentity, mergeDouyinPrivateInboxMessages, materialAttachOutcome, normalizePrivateReceiptTextForComparison, reliablePublishSuccessEvidence } from '../agent/rpa-adapters/assisted-platform.js';
import { hasReliablePublishEvidence } from '../src/services/publish-attestation.js';
import { analyzePublishReadiness } from '../agent/rpa-adapters/publish-guard.js';
import { executeClaimedJobWithPlatformGuard } from '../agent/platform-runtime-guard.js';
import { PlatformOperationCoordinator } from '../agent/platform-operation-coordinator.js';
import { contentDeclarationLabels, normalizeContentOrigin } from '../src/services/content-origin.js';
import { checkLoginPrecisely } from '../agent/login-monitor.js';
import { isConfirmedLoginExpired, buildLoginExpiredNotification } from '../src/services/login-alert.js';
import { ensureLocalAgentOnline, shutdownLocalAgent, stopManagedLocalAgent } from '../src/services/local-agent-process.js';
import { assessCollectedMessageIdentity, normalizeEchoContent } from '../src/services/message-sender-identity.js';
import { deterministicDiagnosis } from '../src/services/issue-diagnosis.js';
import { resolveUploadTimeoutMs, uploadTimeoutMsForSize } from '../agent/publish-upload-timeout.js';

test('风险规则：明确转人工和投诉进入人工路径', () => {
  assert.equal(detectRisk('请转人工处理').risk, true);
  assert.equal(detectRisk('我要投诉这个问题').code, 'COMPLAINT');
  assert.equal(detectRisk('社区几点上班？').risk, false);
  assert.equal(detectRisk('提交的个人信息会保密吗？').risk, false);
  assert.equal(detectRisk('我的身份证号和银行卡信息需要人工处理').risk, true);
});

test('微博私信来源分类：高置信官方/系统会话被排除，普通用户和仅 V 用户被保留', () => {
  for (const userName of ['系统通知', '服务通知', '活动通知', '创作者小助手', '阿里巴巴云客服', '热搜简报', '微博视频', '微博积分']) {
    const assessment = assessWeiboConversationSource({ userName, preview: '通知内容', messageType: 'PRIVATE_MESSAGE' });
    assert.equal(assessment.isOfficial, true, userName);
    assert.equal(assessment.confidence, 'HIGH', userName);
  }
  const verifiedBroadcast = assessWeiboConversationSource({ userName: '新浪新闻', preview: '发来了一条链接消息 >>', verifiedAccount: true, messageType: 'PRIVATE_MESSAGE' });
  assert.equal(verifiedBroadcast.isOfficial, true);
  assert.equal(verifiedBroadcast.confidence, 'HIGH');

  const ordinaryLinkSender = assessWeiboConversationSource({ userName: '张三', preview: '发来了一条链接消息 >>', messageType: 'PRIVATE_MESSAGE' });
  assert.equal(ordinaryLinkSender.isOfficial, false);
  assert.equal(ordinaryLinkSender.reason, 'WEIBO_USER_CONVERSATION');

  const user = assessWeiboConversationSource({ userName: '张三', preview: '请问社区几点上班？', messageType: 'PRIVATE_MESSAGE' });
  assert.equal(user.isOfficial, false);
  assert.equal(user.reason, 'WEIBO_USER_CONVERSATION');

  const verifiedUser = assessWeiboConversationSource({ userName: '认证咨询用户', preview: '请问社区几点上班？', verifiedAccount: true, messageType: 'PRIVATE_MESSAGE' });
  assert.equal(verifiedUser.isOfficial, false);
  assert.equal(verifiedUser.confidence, 'REVIEW');
});

test('微博私信来源分类：允许名单优先，配置排除名单可扩展', () => {
  const allowed = assessWeiboConversationSource(
    { userName: '系统通知', preview: '系统消息', messageType: 'PRIVATE_MESSAGE' },
    { allowNames: '系统通知' }
  );
  assert.equal(allowed.isOfficial, false);
  assert.equal(allowed.reason, 'CONFIGURED_USER_ALLOWLIST');

  const excluded = assessWeiboConversationSource(
    { userName: '自定义平台助手', preview: '普通消息', messageType: 'PRIVATE_MESSAGE' },
    { excludeNames: '自定义平台助手' }
  );
  assert.equal(excluded.isOfficial, true);
  assert.equal(excluded.reason, 'WEIBO_CONFIGURED_OFFICIAL_CONVERSATION');
});

test('抖音私信精度门槛：多条未读列表预览不得进入自动回复', () => {
  const blocked = assessDouyinPrivatePreview({
    platformCode: 'douyin',
    messageType: 'PRIVATE_MESSAGE',
    context: { previewOnly: true, unreadCount: 2, inboxType: 'STRANGER' }
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, 'PRIVATE_PREVIEW_MULTIPLE_UNREAD');
  const single = assessDouyinPrivatePreview({ platformCode: 'douyin', messageType: 'PRIVATE_MESSAGE', context: { previewOnly: true, unreadCount: 1 } });
  assert.equal(single.ok, true);
});

test('抖音私信精度门槛不限制其他平台或已取得完整正文的消息', () => {
  assert.equal(assessDouyinPrivatePreview({ platformCode: 'weibo', messageType: 'PRIVATE_MESSAGE', context: { previewOnly: true, unreadCount: 3 } }).ok, true);
  assert.equal(assessDouyinPrivatePreview({ platformCode: 'douyin', messageType: 'PRIVATE_MESSAGE', context: { previewOnly: false, unreadCount: 3 } }).ok, true);
});

test('Douyin private relative-time labels map to one occurrence anchor across polling runs', () => {
  const firstObserved = new Date('2026-08-06T18:26:52.000Z');
  const secondObserved = new Date('2026-08-06T18:28:53.000Z');
  assert.equal(
    douyinPrivateOccurrenceAnchor('\u0033\u0032\u5206\u949f\u524d', firstObserved),
    douyinPrivateOccurrenceAnchor('\u0033\u0034\u5206\u949f\u524d', secondObserved)
  );
});

test('Douyin private cross-poll dedupe distinguishes a later identical message occurrence', () => {
  const existing = {
    user_name: '\u5496\u5561\u4e0d\u5609', content: '\u8bf7\u95ee\u793e\u533a\u610f\u89c1\u53cd\u9988\u7535\u8bdd\u662f\u591a\u5c11\uff1f',
    context_json: JSON.stringify({ eventTime: '\u0033\u0032\u5206\u949f\u524d', conversationKey: null }),
    collected_at: '2026-08-06T18:26:52.000Z'
  };
  const same = {
    userName: '\u5496\u5561\u4e0d\u5609', content: '\u8bf7\u95ee\u793e\u533a\u610f\u89c1\u53cd\u9988\u7535\u8bdd\u662f\u591a\u5c11\uff1f',
    context: { eventTime: '\u0033\u0034\u5206\u949f\u524d', conversationKey: null }
  };
  const later = {
    ...same,
    context: { eventTime: '\u521a\u521a', conversationKey: null }
  };
  assert.equal(isSameDouyinPrivateOccurrence(existing, same, '2026-08-06T18:28:53.000Z'), true);
  assert.equal(isSameDouyinPrivateOccurrence(existing, later, '2026-08-06T20:00:00.000Z'), false);
});

test('Douyin private cross-poll dedupe tolerates a five-minute occurrence-anchor drift', () => {
  const existing = {
    user_name: '咖啡不嘉🧊',
    content: '私信一般多久回复',
    context_json: JSON.stringify({ occurrenceAnchor: '2026-08-19T05:50Z', conversationKey: null }),
    collected_at: '2026-08-19T05:51:00.000Z'
  };
  const incoming = {
    userName: '咖啡不嘉🧊',
    content: '私信一般多久回复',
    context: { occurrenceAnchor: '2026-08-19T05:45Z', conversationKey: null }
  };
  assert.equal(isSameDouyinPrivateOccurrence(existing, incoming, '2026-08-19T06:02:00.000Z'), true);
});

test('Douyin unread private enrichment opens only one-unread candidates and upgrades stable evidence', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-private-enrich-'));
  try {
    const adapter = new DouyinAssistedRpaAdapter({ platformCode: 'douyin', logsDir: dir, profileDir: path.join(dir, 'profile'), executablePath: '', loginTimeoutMs: 1000, sendTimeoutMs: 1000 });
    let openCalls = 0;
    adapter.openPrivateConversationForPayload = async (_page, targetPayload) => {
      openCalls += 1;
      assert.equal(targetPayload.userName, '咖啡不嘉🧊');
      return {
        ok: true,
        conversationId: 'conversation-1001',
        messageId: 'message-9001',
        direction: 'incoming',
        sourceIsLatest: true,
        sourceMessageCount: 1,
        sourceIncomingMessageCount: 1,
        sourceMessage: { messageIdEvidence: 'react:messageId' },
        rowIdentity: { evidence: ['react:conversationId'] }
      };
    };
    const messages = [
      { messageType: 'PRIVATE_MESSAGE', externalId: 'old-1', externalUrl: 'https://www.douyin.com/user/self', userName: '历史用户', content: '历史消息', context: { unread: false, unreadCount: 0, previewOnly: true } },
      { messageType: 'PRIVATE_MESSAGE', externalId: 'old-2', externalUrl: 'https://www.douyin.com/user/self', userName: '多条用户', content: '最后一条预览', context: { unread: true, unreadCount: 2, previewOnly: true } },
      { messageType: 'PRIVATE_MESSAGE', externalId: 'old-3', externalUrl: 'https://www.douyin.com/user/self', userName: '咖啡不嘉🧊', content: '私信一般多久回复', context: { unread: true, unreadCount: 1, previewOnly: true, inboxType: 'MAIN' } }
    ];
    const result = await adapter.enrichDouyinUnreadPrivateMessages({}, messages, {});
    assert.equal(openCalls, 1);
    assert.equal(result.verifiedCount, 1);
    assert.equal(result.messages[1].context.privateVerificationReason, 'PRIVATE_PREVIEW_MULTIPLE_UNREAD');
    assert.equal(result.messages[2].context.previewOnly, false);
    assert.equal(result.messages[2].context.fullSource, true);
    assert.equal(result.messages[2].context.sourceVerified, true);
    assert.equal(result.messages[2].context.chatTitleVerified, true);
    assert.equal(result.messages[2].context.direction, 'incoming');
    assert.equal(result.messages[2].context.conversationId, 'conversation-1001');
    assert.equal(result.messages[2].context.messageId, 'message-9001');
    assert.notEqual(result.messages[2].externalId, 'old-3');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Douyin unread private enrichment remains preview-only when latest bubble is outgoing', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-private-outgoing-latest-'));
  try {
    const adapter = new DouyinAssistedRpaAdapter({ platformCode: 'douyin', logsDir: dir, profileDir: path.join(dir, 'profile'), executablePath: '', loginTimeoutMs: 1000, sendTimeoutMs: 1000 });
    adapter.openPrivateConversationForPayload = async () => ({
      ok: true,
      conversationId: 'conversation-1001',
      messageId: 'message-9001',
      direction: 'outgoing',
      sourceIsLatest: true,
      sourceMessageCount: 1,
      sourceIncomingMessageCount: 0
    });
    const [message] = (await adapter.enrichDouyinUnreadPrivateMessages({}, [{
      messageType: 'PRIVATE_MESSAGE', externalId: 'old', externalUrl: 'https://www.douyin.com/user/self', userName: '用户A', content: '旧问题',
      context: { unread: true, unreadCount: 1, previewOnly: true, inboxType: 'MAIN' }
    }], {})).messages;
    assert.equal(message.context.previewOnly, true);
    assert.equal(message.context.sourceVerified, false);
    assert.equal(message.context.privateVerificationReason, 'SOURCE_INCOMING_MESSAGE_NOT_IN_CONVERSATION');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('weibo precision blocks historical, preview-only, and unverified messages', () => {
  assert.equal(assessWeiboMessagePrecision({ platformCode: 'weibo', messageType: 'COMMENT', context: { historical: true, commentId: '1', sourceVerified: true } }).reason, 'WEIBO_HISTORICAL_MESSAGE');
  assert.equal(assessWeiboMessagePrecision({ platformCode: 'weibo', messageType: 'PRIVATE_MESSAGE', context: { previewOnly: true } }).reason, 'WEIBO_PRIVATE_PREVIEW_ONLY');
  assert.equal(assessWeiboMessagePrecision({ platformCode: 'weibo', messageType: 'PRIVATE_MESSAGE', context: { previewOnly: false, direction: 'incoming', sourceVerified: true, chatTitleVerified: true } }).reason, 'WEIBO_PRIVATE_MESSAGE_ID_MISSING');
  assert.equal(assessWeiboMessagePrecision({ platformCode: 'weibo', messageType: 'COMMENT', context: { commentId: '5013415519847148', sourceVerified: false } }).reason, 'WEIBO_COMMENT_SOURCE_UNVERIFIED');
  assert.equal(assessWeiboMessagePrecision({ platformCode: 'douyin', messageType: 'PRIVATE_MESSAGE', context: { previewOnly: true } }).applicable, false);
});

test('weibo precision accepts only fully verified current source messages', () => {
  const privateResult = assessWeiboMessagePrecision({ platformCode: 'weibo', messageType: 'PRIVATE_MESSAGE', context: { previewOnly: false, messageId: '4479825538150513', direction: 'incoming', sourceVerified: true, chatTitleVerified: true, historical: false } });
  assert.equal(privateResult.ok, true);
  const commentResult = assessWeiboMessagePrecision({ platformCode: 'weibo', messageType: 'COMMENT', context: { commentId: '5013415519847148', sourceVerified: true, historical: false } });
  assert.equal(commentResult.ok, true);
});

test('weibo reliable reply evidence requires unique target and new scoped echo', () => {
  const valid = { stage: 'reply_sent', evidencePath: 'evidence.json', screenshotPath: 'reply.png', sendMethod: 'weibo-chat:enter-key', targetIdentityVerified: true, uniqueTargetMatch: true, editorCleared: true, baselineEchoCount: 0, scopedEchoCount: 1 };
  assert.equal(hasReliableWeiboReplyEvidence(valid, 'SUCCESS'), true);
  assert.equal(hasReliableWeiboReplyEvidence({ ...valid, uniqueTargetMatch: false }, 'SUCCESS'), false);
  assert.equal(hasReliableWeiboReplyEvidence({ ...valid, scopedEchoCount: 0 }, 'SUCCESS'), false);
  assert.equal(hasReliableWeiboReplyEvidence(valid, 'NEEDS_CONFIRMATION'), false);
});

test('weibo comment and private identities require stable IDs and exact source text', () => {
  const commentPayload = { userName: 'comment-user', sourceContent: 'exact-comment', messageContext: { commentId: '5013415519847148', eventTime: '2024-3-18' } };
  assert.equal(matchWeiboCommentIdentity({ userName: 'comment-user', content: 'exact-comment', commentId: '5013415519847148', eventTime: '2024-3-18' }, commentPayload).matched, true);
  assert.equal(matchWeiboCommentIdentity({ userName: 'comment-user', content: 'exact-comment', commentId: '999', eventTime: '2024-3-18' }, commentPayload).matched, false);
  const privatePayload = { sourceContent: 'exact-private', messageContext: { messageId: '4479825538150513' } };
  assert.equal(matchWeiboPrivateMessageIdentity({ content: 'exact-private', messageId: '4479825538150513', direction: 'incoming' }, privatePayload).matched, true);
  assert.equal(matchWeiboPrivateMessageIdentity({ content: 'exact-private', messageId: '4479825538150513', direction: 'outgoing' }, privatePayload).matched, false);
  assert.equal(matchWeiboPrivateMessageIdentity({ content: 'exact-private', messageId: '999', direction: 'incoming' }, privatePayload).matched, false);
  assert.equal(matchWeiboPrivateMessageIdentity({ content: 'exact-private', direction: 'incoming' }, { sourceContent: 'exact-private', messageContext: {} }).matched, false);
});

test('weibo event time parser supports relative and full dates', () => {
  const nowMs = new Date(2026, 7, 6, 12, 0, 0).getTime();
  assert.equal(parseWeiboEventTime('10\u5206\u949f\u524d', nowMs), nowMs - 10 * 60_000);
  assert.equal(parseWeiboEventTime('2024-3-18', nowMs), new Date(2024, 2, 18).getTime());
});

test('weibo private reply sends with Enter only', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'weibo-enter-send-'));
  try {
    const adapter = new WeiboAssistedRpaAdapter({ profileDir: path.join(dir, 'profile'), executablePath: 'chrome', logsDir: path.join(dir, 'logs'), loginTimeoutMs: 1, sendTimeoutMs: 1 });
    const pressed = [];
    const result = await adapter.sendPrivateReply({ async press(key) { pressed.push(key); } });
    assert.deepEqual(pressed, ['Enter']);
    assert.equal(result.clicked, true);
    assert.equal(result.method, 'weibo-chat:enter-key');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});


test('weibo publish requires an exact content declaration before send lookup', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'weibo-declaration-'));
  const materialPath = path.join(dir, 'material.mp4');
  fs.writeFileSync(materialPath, 'test');
  try {
    const adapter = new WeiboAssistedRpaAdapter({ profileDir: path.join(dir, 'profile'), executablePath: 'chrome', logsDir: path.join(dir, 'logs'), loginTimeoutMs: 1, sendTimeoutMs: 1 });
    let editorText = '';
    let sendLookupCount = 0;
    let sendClickCount = 0;
    const editor = {
      async count() { return 1; }, nth() { return this; }, first() { return this; },
      async isVisible() { return true; }, async isEnabled() { return true; },
      async evaluate(fn) { return fn({ tagName: 'TEXTAREA' }); },
      async fill(value) { editorText = value; }, async inputValue() { return editorText; }
    };
    const fileInput = {
      async count() { return 1; }, first() { return this; },
      async setInputFiles() {}
    };
    const empty = { async count() { return 0; }, nth() { return this; }, first() { return this; } };
    const page = {
      async goto() {}, async waitForTimeout() {},
      locator(selector) { return selector.startsWith('textarea') ? editor : selector.includes('input[type="file"]') ? fileInput : empty; }
    };
    adapter.getPage = async () => page;
    adapter.waitForReady = async () => true;
    adapter.waitForWeiboUploadReady = async () => ({ ready: true, spinnerCount: 0, previewCount: 1 });
    adapter.applyWeiboContentDeclaration = async () => { throw new Error('declaration not uniquely verified'); };
    adapter.findPublishButton = async () => { sendLookupCount += 1; return { async click() { sendClickCount += 1; } }; };
    adapter.evidence = async (_payload, message, _page, stage, extra = {}) => ({ message, stage, ...extra });

    const result = await adapter.publish({ title: 'title', body: 'body', materialPath, publishMode: 'AUTO', contentOrigin: 'AI_GENERATED' });
    assert.equal(result.status, 'FAILED');
    assert.equal(result.result.stage, 'publish_failed');
    assert.equal(sendLookupCount, 0);
    assert.equal(sendClickCount, 0);
    assert.equal(adapter.spec.contentDeclarationRequired, true);
    assert.ok(weiboContentDeclarationLabels('AI_GENERATED').includes('AI\u751f\u6210\u6216\u5305\u542bAI\u751f\u6210\u5185\u5bb9'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});


test('知识评分：关键词命中高于无关问题', () => {
  const item = { question: '社区服务中心的办公时间是什么？', answer: '周一至周五 9:00—18:00', keywords: '办公时间,上班时间,几点开门' };
  assert.ok(scoreKnowledge('你们几点上班？', item) >= 0.58);
  assert.ok(scoreKnowledge('今天吃什么？', item) < 0.58);
});

test('AI 语义匹配只能选择候选知识，并支持口语转述', () => {
  const candidates = [
    { id: 11, question: '社区活动怎么报名？', answer: '按公告报名', score: 0.82 },
    { id: 12, question: '参加社区活动需要收费吗？', answer: '收费以公告为准', score: 0.25 }
  ];
  const result = normalizeKnowledgeMatchResult('```json\n{"matched":true,"knowledgeId":12,"confidence":0.96,"reason":"用户询问活动费用"}\n```', candidates);
  assert.equal(result.matched, true);
  assert.equal(result.knowledgeId, 12);
  assert.equal(result.knowledge, candidates[1]);
  assert.equal(result.confidence, 0.96);
});

test('AI 语义匹配不能返回候选列表之外的知识', () => {
  const candidates = [{ id: 8, question: '怎么加入社区？', answer: '发送加入社区', score: 0.25 }];
  const result = normalizeKnowledgeMatchResult({ matched: true, knowledgeId: 999, confidence: 0.99, reason: '越权选择' }, candidates);
  assert.equal(result.matched, false);
  assert.equal(result.knowledgeId, null);
  assert.equal(result.knowledge, null);
});

test('回复必须有知识依据且仅拦截标准答案之外新增的风险内容', () => {
  assert.equal(validateReply('周一至周五 9:00—18:00', '周一至周五 9:00—18:00').ok, true);
  assert.equal(validateReply('您好，周一至周五 9:00—18:00。', '周一至周五 9:00—18:00').ok, true);
  assert.equal(validateReply('您好，周一至周五 9:00。', '周一至周五 9:00—18:00').ok, false);
  assert.equal(validateReply('', '有知识').ok, false);
  assert.equal(validateReply('请提供身份证号码', '有知识').ok, false);

  const approvedAnswer = '可以。如需取消,请在活动开始前24小时联系工作人员;更换参加人时,请提供新的姓名、手机号。';
  assert.equal(validateReply(approvedAnswer, approvedAnswer).ok, true);
  assert.equal(validateReply(`您好，${approvedAnswer}`, approvedAnswer).ok, true);
  assert.equal(validateReply(`${approvedAnswer}另外请提供身份证号码。`, approvedAnswer).ok, false);
});

test('本地素材预检按平台分别给出结果', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mvp-precheck-'));
  const file = path.join(dir, 'demo.png');
  await sharp({ create: { width: 800, height: 1000, channels: 3, background: '#315f91' } }).png().toFile(file);
  const result = await precheckMaterial({ materialPath: file, title: '测试', body: '正文', platforms: ['xiaohongshu', 'bilibili', 'weibo'] });
  assert.equal(result.meta.type, 'image');
  assert.equal(result.results.find(x => x.platformCode === 'xiaohongshu').status, 'PASSED');
  assert.equal(result.results.find(x => x.platformCode === 'bilibili').status, 'BLOCKED');
  assert.equal(result.results.find(x => x.platformCode === 'weibo').status, 'PASSED');
  const automaticResult = await precheckMaterial({ materialPath: file, platforms: ['xiaohongshu'] });
  assert.equal(automaticResult.overall, 'PASSED');
  fs.unlinkSync(file);
  fs.rmdirSync(dir);
});

test('视频素材预检可解析分辨率、时长、编码、码率和帧率', async () => {
  const file = path.resolve('sample-material/five-platform-community-guide-20260805/community-activity-guide-1080x1920.mp4');
  assert.equal(fs.existsSync(file), true);
  const result = await precheckMaterial({ materialPath: file, platforms: ['xiaohongshu', 'douyin', 'wechat_channels', 'bilibili', 'weibo'] });
  assert.equal(result.meta.analyzer, 'ffprobe');
  assert.equal(result.meta.width, 1080);
  assert.equal(result.meta.height, 1920);
  assert.equal(result.meta.durationSeconds, 15);
  assert.equal(result.meta.videoCodec, 'h264');
  assert.equal(result.meta.audioCodec, 'aac');
  assert.equal(result.meta.frameRate, 24);
  assert.ok(result.meta.totalBitRate > 0);
  assert.equal(result.overall, 'PASSED');
});

test('OCR 输出解析可兼容 JSON、坐标数组和 HTML 文本', () => {
  assert.equal(parseOcrModelContent(JSON.stringify({ text: '社区活动\n报名指南' })).text, '社区活动\n报名指南');
  assert.equal(parseOcrModelContent('[{"text":"社区活动"},{"text":"社区活动"},{"text":"8月18日"}]').text, '社区活动\n8月18日');
  assert.equal(parseOcrModelContent('```html\n<html><body><p>活动公告</p><p>报名入口</p></body></html>\n```').text, '活动公告\n报名入口');
});

test('OCR 在本机压缩图片并从视频提取代表帧', async () => {
  const image = path.resolve('sample-material/five-platform-community-guide-20260805/community-activity-guide-cover.png');
  const video = path.resolve('sample-material/five-platform-community-guide-20260805/community-activity-guide-1080x1920.mp4');
  const imagePrecheck = await precheckMaterial({ materialPath: image, platforms: ['xiaohongshu'] });
  const imageFrames = await prepareOcrImages({ materialPath: image, meta: imagePrecheck.meta });
  assert.equal(imageFrames.length, 1);
  const imageMeta = await sharp(imageFrames[0].buffer).metadata();
  assert.equal(imageMeta.format, 'jpeg');
  assert.ok(Math.max(imageMeta.width, imageMeta.height) <= 1600);

  const videoPrecheck = await precheckMaterial({ materialPath: video, platforms: ['xiaohongshu'] });
  const videoFrames = await prepareOcrImages({ materialPath: video, meta: videoPrecheck.meta });
  assert.equal(videoFrames.length, 5);
  assert.ok(videoFrames.every(frame => frame.buffer.length > 0));
  assert.ok(videoFrames.every((frame, index) => index === 0 || frame.timeSeconds > videoFrames[index - 1].timeSeconds));
});

test('OCR 识别结果包含来源审计信息且原始素材不上传', async () => {
  const image = path.resolve('sample-material/five-platform-community-guide-20260805/community-activity-guide-cover.png');
  const precheck = await precheckMaterial({ materialPath: image, platforms: ['xiaohongshu'] });
  const result = await recognizeMaterialText({
    materialPath: image,
    precheck,
    force: true,
    mode: 'online',
    model: 'fake-ocr',
    apiKey: 'test-key',
    invokeVision: async ({ images }) => ({ text: '社区活动\n8月18日', frames: [], model: 'fake-ocr', usage: { total_tokens: 1 }, imageCount: images.length })
  });
  assert.equal(result.status, 'SUCCESS');
  assert.equal(result.text, '社区活动\n8月18日');
  assert.equal(result.frameCount, 1);
  assert.equal(result.originalUploaded, false);
  assert.ok(result.transmittedBytes > 0);
});

test('发布接口预检校验：缺失、阻断和平台不匹配均拒绝', () => {
  const base = {
    materialPath: 'C:/material/demo.png',
    targets: [{ platformCode: 'xiaohongshu', accountId: 1 }],
    precheck: {
      path: 'C:/material/demo.png', overall: 'PASSED',
      meta: { name: 'demo.png', type: 'image', size: 100 },
      results: [{ platformCode: 'xiaohongshu', status: 'PASSED', reasons: [], warnings: [] }]
    }
  };
  assert.equal(validatePublishPrecheck({ ...base, precheck: undefined }).ok, false);
  assert.equal(validatePublishPrecheck({ ...base, precheck: { ...base.precheck, overall: 'BLOCKED' } }).ok, false);
  assert.equal(validatePublishPrecheck({ ...base, targets: [{ platformCode: 'bilibili', accountId: 5 }] }).ok, false);
  assert.equal(validatePublishPrecheck(base).ok, true);
});


test('发布内容合规：测试占位内容被阻断', () => {
  const review = reviewPublishContent({ title: '管理端一键发布测试', body: '这是RPA自动发布链路测试，发布后可删除。' });
  assert.equal(review.overall, 'BLOCKED');
  assert.equal(validateComplianceApproval(review, true).ok, false);
});

test('发布内容合规：正式内容可确认通过', () => {
  const review = reviewPublishContent({ title: '社区活动报名指南', body: '本周社区活动开放报名，请通过社区活动公告中的报名入口提交信息，名额以页面显示为准。', imageText: '社区活动报名指南' });
  assert.notEqual(review.overall, 'BLOCKED');
  assert.equal(validateComplianceApproval(review, review.overall === 'WARNING').ok, true);
  assert.equal(validateComplianceApproval({ ...review, ruleVersion: COMPLIANCE_RULE_VERSION + '-old' }, true).ok, false);
});

test('AI 审核解析与标准化：严格 JSON 可识别并保留图片风险', () => {
  const parsed = parseModelJson('```json\n{"overall":"BLOCKED","summary":"画面包含风险","findings":[{"code":"IMAGE_RISK","level":"BLOCK","field":"image","message":"画面包含明确风险","frameIndex":2}],"textReview":{"overall":"PASSED"},"imageReview":{"overall":"BLOCKED","checkedFrames":3}}\n```');
  const review = normalizeAiReviewResult(parsed, { materialSha256: 'abc', inputHash: 'hash', sourceType: 'video', frameCount: 3, model: 'test-vision' });
  assert.equal(review.overall, 'BLOCKED');
  assert.equal(review.imageReview.overall, 'BLOCKED');
  assert.equal(review.findings[0].frameIndex, 2);
  assert.equal(review.ruleVersion, AI_REVIEW_RULE_VERSION);
});

test('AI 审核绑定当前文案、来源和素材指纹，任一变化后结果失效', () => {
  const input = { title: '社区活动报名指南', body: '本周社区活动开放报名，请按公告说明提交报名信息。', contentOrigin: 'HUMAN_ORIGINAL', materialSha256: 'abc123', sourceType: 'image' };
  const review = buildMockAiReview(input);
  assert.equal(validateAiReviewApproval(review, { ...input, confirmed: true }).ok, true);
  assert.equal(validateAiReviewApproval(review, { ...input, title: '已修改标题', confirmed: true }).ok, false);
  assert.equal(validateAiReviewApproval(review, { ...input, materialSha256: 'changed', confirmed: true }).ok, false);
  assert.notEqual(buildAiReviewInputHash(input), buildAiReviewInputHash({ ...input, contentOrigin: 'AI_GENERATED' }));
});

test('AI 审核警告必须人工确认，阻断项不能放行', () => {
  const input = { title: '社区活动报名指南', body: '本周社区活动开放报名，请按公告说明提交报名信息。', contentOrigin: 'HUMAN_ORIGINAL', materialSha256: 'abc123' };
  const warning = normalizeAiReviewResult({ overall: 'WARNING', findings: [{ code: 'QR_CODE', level: 'WARN', field: 'image', message: '画面疑似包含二维码' }] }, { materialSha256: input.materialSha256, inputHash: buildAiReviewInputHash(input), sourceType: 'image', frameCount: 1, model: 'test' });
  assert.equal(validateAiReviewApproval(warning, input).ok, false);
  assert.equal(validateAiReviewApproval(warning, { ...input, confirmed: true }).ok, true);
  const blocked = normalizeAiReviewResult({ overall: 'BLOCKED', findings: [{ code: 'ILLEGAL', level: 'BLOCK', field: 'image', message: '画面包含明确违法交易信息' }] }, { materialSha256: input.materialSha256, inputHash: buildAiReviewInputHash(input), sourceType: 'image', frameCount: 1, model: 'test' });
  assert.equal(validateAiReviewApproval(blocked, { ...input, confirmed: true }).ok, false);
});

test('多模态 AI 审核会压缩本地图片并合并模型画面阻断结果', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-review-test-'));
  const file = path.join(dir, 'material.png');
  await sharp({ create: { width: 900, height: 1200, channels: 3, background: '#2d527a' } }).png().toFile(file);
  const precheck = await precheckMaterial({ materialPath: file, platforms: [] });
  const review = await reviewMaterialWithAi({
    title: '社区活动报名指南', body: '本周社区活动开放报名，请按公告说明提交报名信息。', contentOrigin: 'HUMAN_ORIGINAL',
    materialPath: file, precheck, force: true, mode: 'online', model: 'test-multimodal', apiKey: 'test-key',
    invokeModel: async ({ images }) => ({
      review: { overall: 'BLOCKED', summary: '画面风险', findings: [{ code: 'IMAGE_BLOCK', level: 'BLOCK', field: 'image', message: '画面存在明确阻断风险', frameIndex: 1 }], textReview: { overall: 'PASSED' }, imageReview: { overall: 'BLOCKED', checkedFrames: images.length } },
      model: 'test-multimodal', usage: { total_tokens: 1 }
    })
  });
  assert.equal(review.status, 'SUCCESS');
  assert.equal(review.overall, 'BLOCKED');
  assert.equal(review.frameCount, 1);
  assert.equal(review.originalUploaded, false);
  assert.ok(review.transmittedBytes > 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('发布页使用 Local Agent AI 图片审核并提交审核结果，不再依赖旧合规接口或 OCR 缺失警告', () => {
  const source = fs.readFileSync(path.resolve(import.meta.dirname, '../public/app.js'), 'utf8');
  const localRules = fs.readFileSync(path.resolve(import.meta.dirname, '../src/services/content-compliance.js'), 'utf8');
  const agentSource = fs.readFileSync(path.resolve(import.meta.dirname, '../agent/local-agent.js'), 'utf8');
  assert.equal(source.includes("agent('/ai-review'"), true);
  assert.equal(source.includes('aiReview:state.compliance'), true);
  assert.equal(source.includes('/api/compliance/review'), false);
  assert.equal(source.includes('agentResourceUrl(d.previewUrl)'), true);
  assert.equal(source.includes('`http://127.0.0.1:17831${d.previewUrl}`'), false);
  assert.match(agentSource, /model: ai\.model \|\| config\.aiReviewModel/);
  assert.doesNotMatch(agentSource, /model: ai\.visionModel \|\| ai\.model/);
  assert.doesNotMatch(localRules, /IMAGE_TEXT_NOT_CHECKED|图片OCR文本/);
});

test('发布页素材状态卡仅展示格式和分平台状态', () => {
  const source = fs.readFileSync(path.resolve(import.meta.dirname, '../public/app.js'), 'utf8');
  const styles = fs.readFileSync(path.resolve(import.meta.dirname, '../public/styles.css'), 'utf8');
  const renderSource = source.slice(source.indexOf('function renderMaterialPrecheck('), source.indexOf('function publishHistoryHtml('));
  assert.match(source, /上传后仅展示视频格式与所选平台适配状态/);
  assert.match(renderSource, /material-format-tile/);
  assert.match(renderSource, /material-platform-chip/);
  assert.match(renderSource, /statusLabel=status==='PASSED'\?'通过'/);
  assert.doesNotMatch(renderSource, /视频参数：|音频参数：|解析器：|SHA-256：|尺寸：|大小：/);
  assert.match(styles, /\.material-platform-chip\.is-passed/);
  assert.match(styles, /\.material-platform-chip\.is-blocked/);
});
test('发布任务幂等键与目标顺序无关，但素材变化会变化', () => {
  const a = buildPublishIdempotencyKey({ targets: [{ accountId: 1, platformCode: 'xiaohongshu' }, { accountId: 2, platformCode: 'douyin' }], materialSha: 'abc', title: '标题', body: '正文' });
  const b = buildPublishIdempotencyKey({ targets: [{ accountId: 2, platformCode: 'douyin' }, { accountId: 1, platformCode: 'xiaohongshu' }], materialSha: 'abc', title: '标题', body: '正文' });
  const c = buildPublishIdempotencyKey({ targets: [{ accountId: 1, platformCode: 'xiaohongshu' }, { accountId: 2, platformCode: 'douyin' }], materialSha: 'changed', title: '标题', body: '正文' });
  assert.equal(a, b); assert.notEqual(a, c);
});

test('普通发布任务保留旧幂等键算法，再次发送按来源任务隔离', () => {
  const base = { targets: [{ accountId: 2, platformCode: 'douyin' }, { accountId: 1, platformCode: 'xiaohongshu' }], materialSha: 'abc', title: ' 标题 ', body: '正文' };
  const original = buildPublishIdempotencyKey(base);
  const retryA = buildPublishIdempotencyKey({ ...base, retryOfTaskId: 31 });
  const retryAAgain = buildPublishIdempotencyKey({ ...base, retryOfTaskId: 31 });
  const retryB = buildPublishIdempotencyKey({ ...base, retryOfTaskId: 32 });
  assert.equal(original, 'ea89b9c3e8c16cbf86fa32b64e17a55c4b84ca729e58e4f9b1079de5c236b7cf');
  assert.equal(retryA, retryAAgain);
  assert.notEqual(retryA, original);
  assert.notEqual(retryA, retryB);
});


test('消息安全重试仅允许明确的发送前页面延迟创建一次新回复任务', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reply-safe-deferred-retry-'));
  const dbPath = path.join(dir, 'test.db');
  const portProbe = http.createServer();
  await new Promise(resolve => portProbe.listen(0, '127.0.0.1', resolve));
  const port = portProbe.address().port;
  await new Promise(resolve => portProbe.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: path.resolve(import.meta.dirname, '..'),
    env: {
      ...process.env,
      PORT: String(port),
      DATABASE_PATH: dbPath,
      AUTH_ENABLED: 'false',
      AGENT_SHARED_TOKEN: '',
      QWEN_MODE: 'mock',
      RPA_MODE: 'simulated',
      AUTO_COLLECT_ENABLED: 'false',
      LOCAL_AGENT_AUTO_START: 'false',
      SMOKE_TEST_ENABLED: 'false',
      INSTANCE_LOCK_ENABLED: 'false',
      MESSAGE_EVENT_LEDGER_ENABLED: 'false'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await Promise.race([
        new Promise(resolve => child.once('exit', resolve)),
        new Promise(resolve => setTimeout(resolve, 2000))
      ]);
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const request = async (pathname, options = {}) => {
    const response = await fetch(base + pathname, {
      ...options,
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }
    });
    return { response, data: await response.json() };
  };
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(base + '/api/health');
      if (response.ok) break;
    } catch {}
    if (attempt === 59) assert.fail(`测试服务启动超时：${stderr}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  const bootstrap = (await request('/api/bootstrap')).data;
  const account = bootstrap.accounts.find(item => item.platform_code === 'weibo');
  assert.ok(account, stderr);
  const knowledge = await request('/api/knowledge', {
    method: 'POST',
    body: JSON.stringify({
      question: '社区服务中心几点开放？', answer: '社区服务中心每天上午九点开放。',
      keywords: '社区服务中心,开放', category: '公共知识库', subcategory: '服务时间'
    })
  });
  assert.equal(knowledge.response.status, 201, JSON.stringify(knowledge.data));
  const published = await request(`/api/knowledge/${knowledge.data.knowledge.id}/publish`, {
    method: 'POST', body: JSON.stringify({ reviewedBy: '安全重试回归测试' })
  });
  assert.equal(published.response.status, 200, JSON.stringify(published.data));
  const disabled = await request('/api/platforms/weibo/smart-reply', {
    method: 'POST', body: JSON.stringify({ enabled: false, updatedBy: '安全重试回归测试' })
  });
  assert.equal(disabled.response.status, 200, JSON.stringify(disabled.data));

  const createMessage = async suffix => {
    const stamp = `${Date.now()}-${suffix}`;
    const collected = await request('/api/messages/simulate', {
      method: 'POST',
      body: JSON.stringify({
        platformCode: 'weibo',
        accountId: account.id,
        messageType: 'COMMENT',
        externalId: `reply-safe-retry-${stamp}`,
        userName: `安全重试用户-${suffix}`,
        content: '社区服务中心几点开放？',
        context: { postId: `post-${stamp}`, commentId: `comment-${stamp}`, sourceVerified: true }
      })
    });
    assert.equal(collected.response.status, 201, JSON.stringify(collected.data));
    assert.equal(collected.data.message.reply_job_id, null);
    return collected.data.message;
  };
  const safeMessage = await createMessage('safe');
  const attemptedMessage = await createMessage('attempted');
  const unprovenMessage = await createMessage('unproven');

  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA busy_timeout = 15000');
  const stamp = new Date().toISOString();
  const attachPreviousReply = (message, result, suffix) => {
    const inserted = db.prepare(`INSERT INTO agent_jobs(device_id,job_type,payload,status,result,created_at,completed_at,idempotency_key,available_at)
      VALUES(?,'REPLY',?,'NEEDS_CONFIRMATION',?,?,?,?,?)`).run(
        account.device_id,
        JSON.stringify({ messageId: message.id, platformCode: 'weibo' }),
        JSON.stringify(result),
        stamp,
        stamp,
        `reply-safe-retry-old:${message.id}:${suffix}`,
        stamp
      );
    const jobId = Number(inserted.lastInsertRowid);
    db.prepare("UPDATE messages SET status='DEFERRED_PAGE_UNAVAILABLE',decision='DEFERRED_PAGE_UNAVAILABLE',reply_job_id=?,updated_at=? WHERE id=?")
      .run(jobId, stamp, message.id);
    return jobId;
  };
  const deferredResult = {
    status: 'DEFERRED_PAGE_UNAVAILABLE',
    sourceState: 'DEFERRED_PAGE_UNAVAILABLE',
    decision: 'DEFERRED_PAGE_UNAVAILABLE',
    retrySafe: true,
    sendAttempted: false
  };
  const safePreviousJobId = attachPreviousReply(safeMessage, deferredResult, 'safe');
  const attemptedPreviousJobId = attachPreviousReply(attemptedMessage, { ...deferredResult, sendAttempted: true }, 'attempted');
  const unprovenPreviousJobId = attachPreviousReply(unprovenMessage, {
    status: 'DEFERRED_PAGE_UNAVAILABLE',
    sourceState: 'DEFERRED_PAGE_UNAVAILABLE',
    decision: 'DEFERRED_PAGE_UNAVAILABLE',
    sendAttempted: false
  }, 'unproven');
  db.close();

  const enabled = await request('/api/platforms/weibo/smart-reply', {
    method: 'POST', body: JSON.stringify({ enabled: true, updatedBy: '安全重试回归测试' })
  });
  assert.equal(enabled.response.status, 200, JSON.stringify(enabled.data));

  const safeRetry = await request(`/api/messages/${safeMessage.id}/retry`, { method: 'POST', body: '{}' });
  assert.equal(safeRetry.response.status, 200, JSON.stringify(safeRetry.data));

  assert.equal(safeRetry.data.message.status, 'REPLY_QUEUED');
  assert.ok(safeRetry.data.message.reply_job_id);
  assert.notEqual(safeRetry.data.message.reply_job_id, safePreviousJobId);

  const duplicateRetry = await request(`/api/messages/${safeMessage.id}/retry`, { method: 'POST', body: '{}' });
  assert.equal(duplicateRetry.response.status, 409);

  const attemptedRetry = await request(`/api/messages/${attemptedMessage.id}/retry`, { method: 'POST', body: '{}' });
  assert.equal(attemptedRetry.response.status, 409);
  const unprovenRetry = await request(`/api/messages/${unprovenMessage.id}/retry`, { method: 'POST', body: '{}' });
  assert.equal(unprovenRetry.response.status, 409);

  const verifyDb = new DatabaseSync(dbPath, { readOnly: true });
  const jobsFor = messageId => verifyDb.prepare("SELECT id,status FROM agent_jobs WHERE job_type='REPLY' AND CAST(json_extract(payload,'$.messageId') AS INTEGER)=? ORDER BY id").all(messageId);
  const safeJobs = jobsFor(safeMessage.id);
  assert.equal(safeJobs.length, 2);
  assert.deepEqual(safeJobs.map(item => item.id), [safePreviousJobId, safeRetry.data.message.reply_job_id]);
  assert.equal(safeJobs[1].status, 'QUEUED');
  assert.deepEqual(jobsFor(attemptedMessage.id).map(item => item.id), [attemptedPreviousJobId]);
  assert.deepEqual(jobsFor(unprovenMessage.id).map(item => item.id), [unprovenPreviousJobId]);
  verifyDb.close();
});

test('发布状态口径：已提交不等于已发布', () => {
  assert.equal(deriveTaskStatus(['SUBMITTED']), 'SUBMITTED');
  assert.equal(deriveTaskStatus(['REVIEWING']), 'REVIEWING');
  assert.equal(deriveTaskStatus(['PUBLISHED']), 'PUBLISHED');
  assert.equal(deriveTaskStatus(['REJECTED']), 'FAILED');
});


test('XHS comment id ignores changing relative time labels', () => {
  const base = { eventType: 'COMMENT', profileUrl: 'https://www.xiaohongshu.com/user/profile/u1?xsec_token=old', userName: 'user-a', content: 'office hours?', quote: '', thumbnailUrl: 'https://ci.xiaohongshu.com/note-cover?imageView2=1' };
  const first = buildXhsCommentExternalId({ ...base, eventTime: 'just-now' });
  const second = buildXhsCommentExternalId({ ...base, eventTime: '3-minutes', profileUrl: 'https://www.xiaohongshu.com/user/profile/u1?xsec_token=new', thumbnailUrl: 'https://ci.xiaohongshu.com/note-cover?imageView2=2' });
  assert.equal(first, second);
  assert.notEqual(first, buildXhsCommentExternalId({ ...base, content: 'different question' }));
});

test('XHS private-message id ignores changing sidebar time labels', () => {
  const first = buildXhsPrivateExternalId({ conversationId: 'conv-1', eventTime: 'just-now', content: 'office hours?' });
  const second = buildXhsPrivateExternalId({ conversationId: 'conv-1', eventTime: '11:21', content: 'office hours?' });
  assert.equal(first, second);
  assert.notEqual(first, buildXhsPrivateExternalId({ conversationId: 'conv-1', content: 'complaint' }));
});

test('企微机器人 Webhook 仅允许官方 HTTPS 地址并安全掩码', () => {
  const key = '12345678-abcd-1234-abcd-1234567890ab';
  const webhook = `https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=${key}`;
  assert.equal(validateWecomWebhookUrl(webhook).ok, true);
  assert.equal(validateWecomWebhookUrl(webhook.replace('https:', 'http:')).ok, false);
  assert.equal(validateWecomWebhookUrl(`https://example.com/cgi-bin/webhook/send?key=${key}`).ok, false);
  assert.equal(validateWecomWebhookUrl('https://qyapi.weixin.qq.com/cgi-bin/webhook/send').ok, false);
  const masked = maskWecomWebhookUrl(webhook);
  assert.equal(masked.includes(key), false);
  assert.equal(masked.includes(key.slice(-6)), true);
});

test('企微 Webhook 配置加密后可恢复且密文不包含明文', () => {
  const webhook = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abcdefgh-1234-5678-9012-abcdefghijkl';
  const encrypted = encryptSettingValue(webhook);
  assert.equal(encrypted.includes(webhook), false);
  assert.equal(decryptSettingValue(encrypted), webhook);
});


test('\u6d88\u606f\u4e0e\u8bc4\u8bba\u8f6e\u8be2\uff1a\u6bcf\u8f6e\u5728 5 \u5230 6 \u5206\u949f\u5185\u91cd\u65b0\u968f\u673a', () => {
  const min = 5 * 60 * 1000;
  const max = 6 * 60 * 1000;
  assert.equal(randomIntervalMs(min, max, () => 0), min);
  assert.equal(randomIntervalMs(min, max, () => 0.5), 330_000);
  assert.equal(randomIntervalMs(min, max, () => 0.999999), max);
});


test('企微转人工评论通知包含平台、用户、来源、笔记和评论内容', () => {
  const notification = buildManualNotification({
    message: { platform_code: 'xiaohongshu', message_type: 'COMMENT', user_name: '水木木\n你的好友', content: '我要投诉，请人工处理' },
    platformName: '小红书',
    note: { title: '社区活动报名指南', publishedAt: '2026-08-04T02:30:00.000Z' },
    reason: '命中风险规则：COMPLAINT'
  });
  assert.equal(normalizePlatformUserName('水木木\n你的好友'), '水木木');
  assert.equal(notification.title, '【小红书·评论区】水木木需要转人工');
  assert.match(notification.content, /发布平台：小红书/);
  assert.match(notification.content, /用户名称：水木木/);
  assert.match(notification.content, /消息来源：评论区/);
  assert.match(notification.content, /关联笔记：《社区活动报名指南》（发布时间：2026\/8\/4 10:30）/);
  assert.match(notification.content, /评论内容：“我要投诉，请人工处理”/);
  assert.match(notification.content, /处理要求：需要转人工/);
});

test('企微转人工私信通知明确显示私信会话无关联笔记', () => {
  const notification = buildManualNotification({
    message: { platform_code: 'xiaohongshu', message_type: 'PRIVATE_MESSAGE', user_name: '用户A', content: '麻烦人工回复' },
    platformName: '小红书',
    note: {},
    reason: '用户明确要求人工处理'
  });
  assert.equal(notification.title, '【小红书·私信】用户A需要转人工');
  assert.match(notification.content, /消息来源：私信/);
  assert.match(notification.content, /关联笔记：无（私信会话）/);
  assert.match(notification.content, /私信内容：“麻烦人工回复”/);
});

test('关联笔记只按明确 ID、URL 或标题匹配，不拿最近发布冒充', () => {
  const candidates = [
    { title: '其他笔记', platform_post_id: 'other', platform_url: 'https://www.xiaohongshu.com/explore/other', submitted_at: '2026-08-03T01:00:00.000Z' },
    { title: '社区活动报名指南', platform_post_id: 'note-123', platform_url: 'https://www.xiaohongshu.com/explore/note-123?xsec_token=secret', submitted_at: '2026-08-04T02:30:00.000Z' }
  ];
  const matched = resolveRelatedNote({ noteUrl: 'https://www.xiaohongshu.com/explore/note-123' }, candidates);
  assert.equal(matched.title, '社区活动报名指南');
  assert.equal(matched.matched, true);
  const unmatched = resolveRelatedNote({}, candidates);
  assert.equal(unmatched.title, null);
  assert.equal(unmatched.matched, false);
});

test('关联作品兼容采集器字段和驼峰候选字段，并优先按作品ID匹配', () => {
  const matched = resolveRelatedNote({
    sourceVideoKey: 'export/video-123',
    sourceVideoTitle: '澳门车主注意事项 澳门车主注意事项，详情请看视频内容',
    sourceVideoPublishedAt: '1786974410'
  }, [{
    platformPostId: 'export/video-123',
    opaqueKey: 'opaque-456',
    title: '澳门车主注意事项 澳门车主注意事项，详情请看视频内容',
    publishedAt: '1786974410'
  }]);
  assert.equal(matched.matched, true);
  assert.equal(matched.id, 'export/video-123');
  assert.equal(matched.title, '澳门车主注意事项 澳门车主注意事项，详情请看视频内容');
  assert.equal(matched.publishedAt, '2026-08-17T13:46:50.000Z');
});



test('comment occurrence time parses common relative labels', () => {
  const reference = new Date('2026-08-04T12:00:00.000Z');
  assert.equal(platformEventAgeMs('\u521a\u521a', reference), 0);
  assert.equal(platformEventAgeMs('5\u5206\u949f\u524d', reference), 5 * 60 * 1000);
  assert.equal(platformEventAgeMs('3\u5c0f\u65f6\u524d', reference), 3 * 60 * 60 * 1000);
  const localReference = new Date(2026, 7, 20, 23, 30);
  assert.equal(platformEventAgeMs('08\u670820\u65e5 22:09', localReference), 81 * 60 * 1000);
  assert.equal(platformEventAgeMs('2026-08-20 22:09', localReference), 81 * 60 * 1000);
});

test('normal aging of the same comment is not a repeated occurrence', () => {
  const reference = new Date('2026-08-04T12:00:00.000Z');
  const existing = {
    created_at: '2026-08-04T09:00:00.000Z',
    context_json: JSON.stringify({ eventTime: '2\u5c0f\u65f6\u524d' })
  };
  assert.equal(isRepeatedCommentOccurrence(existing, { eventTime: '3\u5c0f\u65f6\u524d' }, reference), false);
});

test('relative time becoming newer identifies a repeated same-content comment', () => {
  const reference = new Date('2026-08-04T12:00:00.000Z');
  const existing = {
    created_at: '2026-08-04T08:50:00.000Z',
    context_json: JSON.stringify({ eventTime: '3\u5c0f\u65f6\u524d' })
  };
  assert.equal(isRepeatedCommentOccurrence(existing, { eventTime: '5\u5206\u949f\u524d' }, reference), true);
  assert.match(repeatedExternalId('xhs-comment-abc', reference), /^xhs-comment-abc--repeat-\d+$/);
});

test('creation time recovers a missed repeated comment after legacy context overwrite', () => {
  const reference = new Date('2026-08-04T12:00:00.000Z');
  const existing = {
    created_at: '2026-08-04T07:00:00.000Z',
    context_json: JSON.stringify({ eventTime: '1\u5c0f\u65f6\u524d' })
  };
  assert.equal(isRepeatedCommentOccurrence(existing, { eventTime: '1\u5c0f\u65f6\u524d' }, reference), true);
});



test('Douyin comment semantic identity survives relative-time drift across collection rounds', () => {
  const firstObservedAt = new Date('2026-08-08T13:15:00.000Z');
  const secondObservedAt = new Date('2026-08-08T13:27:00.000Z');
  const existing = {
    user_name: 'douyin-user',
    content: 'same comment',
    collected_at: firstObservedAt.toISOString(),
    context_json: JSON.stringify({ eventTime: '4\u5206\u949f\u524d' })
  };
  const incoming = {
    userName: 'douyin-user',
    content: 'same comment',
    context: { eventTime: '17\u5206\u949f\u524d' }
  };
  assert.equal(estimatedCommentEventAt(existing.context_json, firstObservedAt), new Date('2026-08-08T13:11:00.000Z').getTime());
  assert.equal(estimatedCommentEventAt(incoming.context, secondObservedAt), new Date('2026-08-08T13:10:00.000Z').getTime());
  assert.equal(isSameDouyinCommentSemanticCandidate(existing, incoming, secondObservedAt), true);
  assert.equal(douyinCommentOccurrenceAnchor('4\u5206\u949f\u524d', firstObservedAt), douyinCommentOccurrenceAnchor('17\u5206\u949f\u524d', secondObservedAt));
});

test('Douyin comment semantic identity separates videos and preserves same-video matches', () => {
  const existing = {
    user_name: 'same-user',
    content: 'same-content',
    collected_at: '2026-08-08T12:00:00.000Z',
    context_json: JSON.stringify({ sourceVideoKey: 'video-A', eventTime: '3\u5c0f\u65f6\u524d' })
  };
  assert.equal(commentSourceIdentity(existing.context_json), 'video:video-a');
  assert.equal(isSameDouyinCommentSemanticCandidate(existing, {
    userName: 'same-user', content: 'same-content', context: { sourceVideoKey: 'video-A', eventTime: '4\u5c0f\u65f6\u524d' }
  }, '2026-08-08T16:00:00.000Z'), true);
  assert.equal(isSameDouyinCommentSemanticCandidate(existing, {
    userName: 'same-user', content: 'same-content', context: { sourceVideoKey: 'video-B', eventTime: '4\u5c0f\u65f6\u524d' }
  }, '2026-08-08T16:00:00.000Z'), false);
  assert.equal(isRepeatedCommentOccurrence(existing, { sourceVideoKey: 'video-A', eventTime: '5\u5206\u949f\u524d' }, '2026-08-08T16:00:00.000Z'), true);
});

test('Douyin reply jobs use semantic idempotency while repeated occurrences remain independent', () => {
  const base = {
    platform_code: 'douyin', account_id: 2, message_type: 'COMMENT',
    user_name: 'douyin-user', content: 'same comment',
    context_json: JSON.stringify({ sourceVideoKey: 'video-A' })
  };
  const first = buildReplyIdempotencyKey({ ...base, id: 75, external_id: 'douyin-comment-old-1' });
  const duplicate = buildReplyIdempotencyKey({ ...base, id: 76, external_id: 'douyin-comment-old-2' });
  const repeated = buildReplyIdempotencyKey({ ...base, id: 77, external_id: 'douyin-comment-old-2--repeat-20260808' });
  assert.equal(first, duplicate);
  assert.notEqual(first, repeated);
  assert.equal(buildReplyIdempotencyKey({ ...base, id: 88, platform_code: 'weibo' }), 'reply:message:88');
  assert.equal(buildReplyIdempotencyKey({ ...base, id: 89, message_type: 'PRIVATE_MESSAGE' }), 'reply:message:89');
});

test('thumbnail note matching requires a close and unambiguous image match', () => {
  assert.equal(selectThumbnailNoteCandidate([
    { title: 'matched', score: 0.002 },
    { title: 'different', score: 0.067 }
  ]).title, 'matched');
  assert.equal(selectThumbnailNoteCandidate([{ title: 'too different', score: 0.08 }]), null);
  assert.equal(selectThumbnailNoteCandidate([
    { title: 'same cover A', score: 0.002 },
    { title: 'same cover B', score: 0.0021 }
  ]), null);
});


test('five_platform_assisted 为另外四个平台注册独立辅助浏览器适配器', async () => {
  assert.deepEqual(supportedPlatforms, ['xiaohongshu', 'douyin', 'wechat_channels', 'bilibili', 'weibo']);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'five-platform-registry-'));
  try {
    const logsDir = path.join(dir, 'logs');
    const platformConfigs = Object.fromEntries(
      supportedPlatforms.filter(code => code !== 'xiaohongshu').map(code => [code, {
        profileDir: path.join(dir, 'profiles', code),
        executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
        loginTimeoutMs: 600000,
        sendTimeoutMs: 180000,
        spec: { publishUrl: PLATFORM_ASSISTED_SPECS[code].publishUrl }
      }])
    );
    const registry = createRpaRegistry({
      mode: 'five_platform_assisted',
      logsDir,
      xiaohongshu: {
        profileDir: path.join(dir, 'profiles', 'xiaohongshu'),
        executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
        creatorUrl: 'https://creator.xiaohongshu.com/publish/publish',
        loginTimeoutMs: 600000,
        sendTimeoutMs: 1800000
      },
      platforms: platformConfigs
    });
    assert.deepEqual([...registry.keys()], supportedPlatforms);
    for (const code of supportedPlatforms.filter(item => item !== 'xiaohongshu')) {
      const adapter = registry.get(code);
      assert.ok(adapter instanceof AssistedPlatformRpaAdapter);
      assert.equal(adapter.platformCode, code);
      assert.equal(adapter.profileDir, platformConfigs[code].profileDir);
      assert.equal(adapter.spec.publishUrl, PLATFORM_ASSISTED_SPECS[code].publishUrl);
      assert.notEqual(adapter, registry.get('xiaohongshu'));
    }
    const douyin = registry.get('douyin');
    const wechatChannels = registry.get('wechat_channels');
    assert.ok(douyin instanceof DouyinAssistedRpaAdapter);
    assert.ok(wechatChannels instanceof WechatChannelsAssistedRpaAdapter);
    assert.notEqual(douyin.constructor, wechatChannels.constructor);
    assert.equal(Object.hasOwn(DouyinAssistedRpaAdapter.prototype, 'inspectDouyinCommentEmptyState'), true);
    assert.equal(Object.hasOwn(WechatChannelsAssistedRpaAdapter.prototype, 'inspectWechatCommentEmptyState'), true);
    assert.equal(Object.hasOwn(DouyinAssistedRpaAdapter.prototype, 'inspectWechatCommentEmptyState'), false);
    assert.equal(Object.hasOwn(WechatChannelsAssistedRpaAdapter.prototype, 'inspectDouyinCommentEmptyState'), false);
    assert.ok(registry.get('bilibili') instanceof BilibiliAssistedRpaAdapter);
    assert.ok(registry.get('weibo') instanceof WeiboAssistedRpaAdapter);
    assert.notEqual(douyin, registry.get('bilibili'));
    assert.notEqual(registry.get('bilibili'), registry.get('weibo'));
    let douyinClosed = 0;
    let wechatClosed = 0;
    douyin.context = { close: async () => { douyinClosed += 1; } };
    wechatChannels.context = { close: async () => { wechatClosed += 1; } };
    await douyin.stop();
    assert.equal(douyinClosed, 1);
    assert.equal(wechatClosed, 0);
    assert.notEqual(wechatChannels.context, null);
    await wechatChannels.stop();
    assert.equal(wechatClosed, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});


test('master switch agent manager starts once and reuses the online process', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mvp-agent-manager-'));
  const entry = path.join(dir, 'fake-agent.mjs');
  const counter = path.join(dir, 'starts.txt');
  const probe = (await import('node:net')).createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  fs.writeFileSync(entry, `
    import http from 'node:http';
    import fs from 'node:fs';
    import crypto from 'node:crypto';
    fs.appendFileSync(process.env.START_COUNTER, 'started\\n');
    const bindingId = process.env.AGENT_SHARED_TOKEN
      ? crypto.createHash('sha256').update(String(process.env.DEVICE_ID || '') + '\\0' + process.env.AGENT_SHARED_TOKEN).digest('hex').slice(0, 24)
      : undefined;
    const server = http.createServer((req, res) => {
      if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true, deviceId: process.env.DEVICE_ID, bindingId }));
      }
      if (req.method === 'POST' && req.url === '/control/shutdown') {
        res.writeHead(202, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, shuttingDown: true }));
        setImmediate(() => server.close());
        return;
      }
      res.writeHead(404); res.end();
    });
    server.listen(Number(process.env.AGENT_PORT), '127.0.0.1');
    process.on('SIGTERM', () => server.close(() => process.exit(0)));
    process.on('SIGINT', () => server.close(() => process.exit(0)));
  `, 'utf8');

  try {
    const first = await ensureLocalAgentOnline({
      port, deviceId: 'test-device', agentEntryPath: entry, logsDir: dir,
      cloudBaseUrl: 'http://127.0.0.1:1', timeoutMs: 4000, env: { START_COUNTER: counter }
    });
    assert.equal(first.online, true);
    assert.equal(first.started, true);

    const second = await ensureLocalAgentOnline({
      port, deviceId: 'test-device', agentEntryPath: entry, logsDir: dir,
      cloudBaseUrl: 'http://127.0.0.1:1', timeoutMs: 1000, env: { START_COUNTER: counter }
    });
    assert.equal(second.online, true);
    assert.equal(second.started, false);
    assert.equal(second.alreadyRunning, true);
    assert.equal(fs.readFileSync(counter, 'utf8').trim().split(/\r?\n/).length, 1);

    const stopped = await shutdownLocalAgent({
      port, deviceId: 'test-device', logsDir: dir, timeoutMs: 2000, pollMs: 25
    });
    assert.equal(stopped.stopped, true);
    assert.equal(stopped.accepted, true);
    assert.equal(fs.existsSync(path.join(dir, 'agent.pid')), false);
  } finally {
    await stopManagedLocalAgent();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try { fs.rmSync(dir, { recursive: true, force: true }); break; }
      catch (error) { if (attempt === 4) throw error; await new Promise(resolve => setTimeout(resolve, 100)); }
    }
  }
});

test('master switch agent manager rejects a missing entry without reporting online', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mvp-agent-missing-'));
  try {
    await assert.rejects(
      ensureLocalAgentOnline({ port: 37987, deviceId: 'missing-device', agentEntryPath: path.join(dir, 'missing.mjs'), logsDir: dir, timeoutMs: 1000 }),
      /Local Agent/
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});


test('startup script leaves Local Agent lifecycle to the global master switch', () => {
  const source = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'start-mvp.ps1'), 'utf8');
  assert.doesNotMatch(source, /Start-Process[^\r\n]+agent\/local-agent\.js/i);
  assert.match(source, /Local Agent .*\u81ea\u52a8\u542f\u505c/);
  const staleAgentPidCleanup = source.indexOf("Remove-Item -LiteralPath (Join-Path $Logs 'agent.pid')");
  const serverLaunch = source.indexOf("$server = Start-Process");
  assert.ok(staleAgentPidCleanup >= 0 && staleAgentPidCleanup < serverLaunch, 'stale agent.pid must be removed before Web can write a fresh PID');
});


test('\u4e94\u5e73\u53f0\u767b\u5f55\u68c0\u6d4b\uff1a\u7a7a\u767d\u9875\u548c\u975e\u76ee\u6807\u57df\u540d\u4e0d\u80fd\u5224\u5b9a READY', () => {
  const spec = PLATFORM_ASSISTED_SPECS.douyin;
  assert.equal(classifyAssistedLoginEvidence({ url: 'about:blank', text: '', spec }).state, 'UNKNOWN');
  assert.equal(classifyAssistedLoginEvidence({ url: 'https://example.com/', text: '\u5185\u5bb9\u7ba1\u7406', spec }).state, 'UNKNOWN');
});

test('\u4e94\u5e73\u53f0\u767b\u5f55\u68c0\u6d4b\uff1a\u767b\u5f55\u3001\u9a8c\u8bc1\u548c\u9875\u9762\u5f02\u5e38\u5747\u4fdd\u5b88\u5224\u5b9a', () => {
  const spec = PLATFORM_ASSISTED_SPECS.douyin;
  assert.equal(classifyAssistedLoginEvidence({ url: 'https://creator.douyin.com/login', text: '', spec }).state, 'LOGIN');
  assert.equal(classifyAssistedLoginEvidence({ url: spec.manageUrl, text: '\u8bf7\u5b8c\u6210\u6ed1\u5757\u5b89\u5168\u9a8c\u8bc1', spec }).state, 'VERIFY_REQUIRED');
  assert.equal(classifyAssistedLoginEvidence({ url: spec.manageUrl, text: '\u65e0\u6cd5\u8bbf\u95ee\u6b64\u7f51\u7ad9 ERR_CONNECTION_RESET', spec }).state, 'ERROR');
});

test('\u4e94\u5e73\u53f0\u767b\u5f55\u68c0\u6d4b\uff1a\u53ea\u6709\u76ee\u6807 URL \u4e0e\u767b\u5f55\u540e\u6b63\u5411\u8bc1\u636e\u540c\u65f6\u5b58\u5728\u624d\u5224\u5b9a READY', () => {
  const spec = PLATFORM_ASSISTED_SPECS.douyin;
  assert.equal(classifyAssistedLoginEvidence({ url: spec.manageUrl, text: '\u666e\u901a\u9875\u9762', spec }).state, 'UNKNOWN');
  const result = classifyAssistedLoginEvidence({ url: spec.manageUrl, text: '\u4f5c\u54c1\u7ba1\u7406 \u6570\u636e\u4e2d\u5fc3', spec });
  assert.equal(result.state, 'READY'); assert.ok(result.evidence.includes('authenticated-url'));
});


test('\u6296\u97f3\u6d88\u606f\u9875\u6821\u9a8c\uff1a\u771f\u5b9e\u8bc4\u8bba\u7ba1\u7406\u9875\u624d\u5141\u8bb8\u7a7a\u91c7\u96c6', () => {
  const spec = PLATFORM_ASSISTED_SPECS.douyin;
  const result = classifyMessagePageEvidence({
    messageType: 'COMMENT',
    url: 'https://creator.douyin.com/creator-micro/data/following/comment',
    text: '\u8bc4\u8bba\u7ba1\u7406 \u9009\u62e9\u4f5c\u54c1 \u8bf7\u9009\u62e9\u6392\u5e8f\u65b9\u5f0f \u6682\u65e0\u8bc4\u8bba',
    spec
  });
  assert.equal(result.valid, true);
  assert.equal(result.reason, 'VERIFIED');
});

test('message navigation only downgrades Playwright navigation timeouts', () => {
  assert.equal(isNavigationTimeoutError(Object.assign(new Error('page.goto: Timeout 60000ms exceeded.'), { name: 'TimeoutError' })), true);
  assert.equal(isNavigationTimeoutError(new Error('page.goto: net::ERR_TIMED_OUT at https://example.com/')), true);
  assert.equal(isNavigationTimeoutError(new Error('page.goto: net::ERR_CONNECTION_RESET')), false);
});

test('message navigation timeout continues when the target DOM is already verifiable', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-message-navigation-timeout-valid-'));
  try {
    const adapter = new WechatChannelsAssistedRpaAdapter({ platformCode: 'wechat_channels', logsDir: dir, profileDir: path.join(dir, 'profile'), executablePath: '', loginTimeoutMs: 1000, sendTimeoutMs: 1000 });
    const targetUrl = adapter.spec.commentUrl;
    const page = {
      currentUrl: targetUrl,
      async goto() { throw Object.assign(new Error('page.goto: Timeout 60000ms exceeded.'), { name: 'TimeoutError' }); },
      async waitForTimeout() {},
      url() { return this.currentUrl; },
      locator(selector) {
        return {
          async innerText() { return selector === 'body' ? '\u8bc4\u8bba\u7ba1\u7406 \u5168\u90e8\u89c6\u9891 \u5171 0 \u4e2a \u6682\u65e0\u8bc4\u8bba' : ''; },
          async evaluateAll() { return []; }
        };
      }
    };
    const navigation = await adapter.prepareMessagePage(page, { type: 'COMMENT', label: '\u8bc4\u8bba', url: targetUrl });
    assert.equal(navigation.timeoutCount, 1);
    assert.equal(navigation.degradedAfterTimeout, true);
    assert.equal(navigation.attemptResults[0].status, 'TIMEOUT_CONTINUING_WITH_PAGE_VERIFICATION');
    assert.equal(navigation.attemptResults[0].domReadable, true);
    assert.equal(navigation.finalPageCheck.valid, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('unresolved message navigation timeout becomes NEEDS_CONFIRMATION instead of a failed job', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-message-navigation-timeout-unresolved-'));
  try {
    const adapter = new WechatChannelsAssistedRpaAdapter({ platformCode: 'wechat_channels', logsDir: dir, profileDir: path.join(dir, 'profile'), executablePath: '', loginTimeoutMs: 1000, sendTimeoutMs: 1000 });
    const page = {
      currentUrl: 'about:blank',
      async goto() { throw Object.assign(new Error('page.goto: Timeout 60000ms exceeded.'), { name: 'TimeoutError' }); },
      async waitForTimeout() {},
      url() { return this.currentUrl; },
      locator() { return { async innerText() { return ''; }, async evaluateAll() { return []; } }; }
    };
    adapter.getPage = async () => page;
    adapter.inspectLoginState = async () => ({ state: 'UNKNOWN', evidence: [] });
    adapter.waitForMessageContentReady = async () => ({ ready: false, reason: 'MESSAGE_CONTENT_TIMEOUT', pageCheck: { valid: false, reason: 'URL_MISMATCH', evidence: ['message-url-mismatch'] } });
    adapter.evidence = async (_payload, message, evidencePage, stage, extra = {}) => ({ message, stage, url: evidencePage.url(), ...extra });
    const result = await adapter.collectMessages({ types: ['COMMENT'], profileName: 'test' });
    assert.equal(result.status, 'NEEDS_CONFIRMATION');
    assert.equal(result.result.typeResults[0].navigation.timeoutCount, 1);
    assert.equal(result.result.typeResults[0].pageReason, 'URL_MISMATCH');
    assert.deepEqual(result.result.messages, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Douyin does not immediately retry a timed-out comment navigation', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-message-navigation-no-timeout-retry-'));
  try {
    const adapter = new DouyinAssistedRpaAdapter({ platformCode: 'douyin', logsDir: dir, profileDir: path.join(dir, 'profile'), executablePath: '', loginTimeoutMs: 1000, sendTimeoutMs: 1000 });
    let gotoCalls = 0;
    const page = {
      async goto() { gotoCalls += 1; throw new Error('page.goto: net::ERR_TIMED_OUT at https://creator.douyin.com/creator-micro/data/following/comment'); },
      async waitForTimeout() {},
      url() { return 'about:blank'; },
      locator() { return { async innerText() { return ''; }, async evaluateAll() { return []; } }; }
    };
    adapter.inspectLoginState = async () => ({ state: 'UNKNOWN', evidence: [] });
    const navigation = await adapter.prepareMessagePage(page, { type: 'COMMENT', label: '\u8bc4\u8bba', url: adapter.spec.commentUrl });
    assert.equal(gotoCalls, 1);
    assert.equal(navigation.attempts, 1);
    assert.equal(navigation.timeoutCount, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test('message navigation still throws non-timeout browser failures', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-message-navigation-hard-failure-'));
  try {
    const adapter = new WechatChannelsAssistedRpaAdapter({ platformCode: 'wechat_channels', logsDir: dir, profileDir: path.join(dir, 'profile'), executablePath: '', loginTimeoutMs: 1000, sendTimeoutMs: 1000 });
    const page = {
      async goto() { throw new Error('page.goto: net::ERR_CONNECTION_RESET'); },
      async waitForTimeout() {},
      url() { return 'about:blank'; },
      locator() { return { async innerText() { return ''; }, async evaluateAll() { return []; } }; }
    };
    await assert.rejects(
      adapter.prepareMessagePage(page, { type: 'COMMENT', label: '\u8bc4\u8bba', url: adapter.spec.commentUrl }),
      /ERR_CONNECTION_RESET/
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('\u6296\u97f3\u6d88\u606f\u9875\u56de\u5f52\uff1a\u672a\u627e\u5230\u76f8\u5173\u9875\u9762\u4e0d\u5f97\u8fd4\u56de\u6210\u529f\u7a7a\u91c7\u96c6', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-message-page-'));
  try {
    const adapter = new DouyinAssistedRpaAdapter({
      platformCode: 'douyin', logsDir: dir, profileDir: path.join(dir, 'profile'),
      executablePath: '', loginTimeoutMs: 1000, sendTimeoutMs: 1000,
      spec: { commentUrl: 'https://creator.douyin.com/creator-micro/interaction/comment' }
    });
    const page = {
      currentUrl: 'about:blank',
      async goto(url) { this.currentUrl = url; },
      async waitForTimeout() {},
      url() { return this.currentUrl; },
      locator(selector) {
        return {
          async innerText() { return selector === 'body' ? '\u5f88\u62b1\u6b49\uff0c\u672a\u627e\u5230\u76f8\u5173\u9875\u9762' : ''; },
          async evaluateAll() { return []; }
        };
      }
    };
    adapter.getPage = async () => page;
    adapter.inspectLoginState = async () => ({ state: 'READY', evidence: ['test-authenticated'] });
    adapter.evidence = async (_payload, message, evidencePage, stage, extra = {}) => ({ message, stage, url: evidencePage.url(), ...extra });
    const result = await adapter.collectMessages({ types: ['COMMENT'], profileName: 'test' });
    assert.equal(result.status, 'NEEDS_CONFIRMATION');
    assert.equal(result.result.stage, 'message_page_unverified');
    assert.equal(result.result.typeResults[0].pageReason, 'PAGE_ERROR');
    assert.deepEqual(result.result.messages, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('\u6296\u97f3\u79c1\u4fe1\u9875\u6821\u9a8c\uff1a\u4e3b\u7ad9\u81ea\u5df1\u4e3b\u9875\u4e0e\u771f\u5b9e\u79c1\u4fe1\u6d6e\u5c42\u4fe1\u53f7\u540c\u65f6\u5b58\u5728\u624d\u901a\u8fc7', () => {
  const spec = PLATFORM_ASSISTED_SPECS.douyin;
  const valid = classifyMessagePageEvidence({
    messageType: 'PRIVATE_MESSAGE',
    url: 'https://www.douyin.com/user/self',
    text: '\u4e0b\u8f7d\u5ba2\u6237\u7aef\uff0c\u5b9e\u65f6\u63a5\u6536\u597d\u53cb\u6d88\u606f \u964c\u751f\u4eba\u6d88\u606f \u6536\u8d77\u4f1a\u8bdd',
    spec
  });
  assert.equal(valid.valid, true);
  const missingPanel = classifyMessagePageEvidence({ messageType: 'PRIVATE_MESSAGE', url: spec.messageUrl, text: '\u4e2a\u4eba\u4e3b\u9875', spec });
  assert.equal(missingPanel.valid, false);
  assert.equal(missingPanel.reason, 'PAGE_SIGNAL_MISSING');
});

test('\u6296\u97f3\u79c1\u4fe1\u91c7\u96c6\uff1a\u5148\u6253\u5f00\u6d88\u606f\u6d6e\u5c42\uff0c\u4e14\u6ca1\u6709\u672a\u8bfb\u8bc1\u636e\u65f6\u4e0d\u91c7\u96c6\u5386\u53f2\u4f1a\u8bdd', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-private-panel-'));
  try {
    const adapter = new DouyinAssistedRpaAdapter({ platformCode: 'douyin', logsDir: dir, profileDir: path.join(dir, 'profile'), executablePath: '', loginTimeoutMs: 1000, sendTimeoutMs: 1000 });
    const page = {
      currentUrl: 'about:blank', panelOpen: false,
      async goto(url) { this.currentUrl = url; }, async waitForTimeout() {}, url() { return this.currentUrl; },
      locator(selector) {
        const self = this;
        if (selector === '[data-e2e="im-entry"]') return { async count() { return 1; }, nth() { return this; }, async isVisible() { return true; }, async click() { page.panelOpen = true; } };
        if (selector === 'body') return { async innerText() { return page.panelOpen ? '\u4e0b\u8f7d\u5ba2\u6237\u7aef\uff0c\u5b9e\u65f6\u63a5\u6536\u597d\u53cb\u6d88\u606f \u964c\u751f\u4eba\u6d88\u606f \u6536\u8d77\u4f1a\u8bdd' : '\u4e2a\u4eba\u4e3b\u9875'; }, async evaluateAll() { return []; } };
        return { async evaluateAll() { return []; }, async count() { return 0; }, nth() { return this; }, async isVisible() { return false; } };
      }
    };
    adapter.getPage = async () => page;
    adapter.inspectLoginState = async () => ({ state: 'UNKNOWN', evidence: ['main-site-page'] });
    adapter.evidence = async (_payload, message, evidencePage, stage, extra = {}) => ({ message, stage, url: evidencePage.url(), ...extra });
    const result = await adapter.collectMessages({ types: ['PRIVATE_MESSAGE'], profileName: 'test' });
    assert.equal(result.status, 'SUCCESS');
    assert.equal(page.panelOpen, true);
    assert.equal(result.result.messages.length, 0);
    assert.equal(result.result.typeResults[0].reason, 'VERIFIED_MAIN_AND_STRANGER_UNREAD_ONLY');
    assert.equal(result.result.typeResults[0].navigation.entryOpened, true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Douyin private send fallback rejects upload controls and accepts explicit send evidence only', () => {
  assert.equal(isPrivateSendControlEvidence({ className: 'semi-upload-add', dataAction: '\u9009\u62e9\u6587\u4ef6' }), false);
  assert.equal(isPrivateSendControlEvidence({ className: 'message-send-button', ariaLabel: 'Send' }), true);
  assert.equal(isPrivateSendControlEvidence({ className: 'messageMsgInputpublishBtn e2e-send-msg-btn' }), true);
  assert.equal(isPrivateSendControlEvidence({ className: 'plain-round-button' }), false);
});


test('Douyin stranger inbox requires one unique entry and verifies title plus list after clicking', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-stranger-open-'));
  try {
    const adapter = new DouyinAssistedRpaAdapter({ platformCode: 'douyin', logsDir: dir, profileDir: path.join(dir, 'profile'), executablePath: '', loginTimeoutMs: 1000, sendTimeoutMs: 1000 });
    const rootLocator = items => ({ async count() { return items.length; }, nth(index) { return items[index]; } });
    const visibleNode = extra => ({ async isVisible() { return true; }, ...extra });
    const ambiguousPage = {
      locator(selector) {
        if (selector.includes('conversationStrangerBoxwrapper')) return rootLocator([visibleNode({}), visibleNode({})]);
        return rootLocator([]);
      }
    };
    const ambiguous = await adapter.openDouyinStrangerInbox(ambiguousPage);
    assert.equal(ambiguous.ok, false);
    assert.equal(ambiguous.reason, 'STRANGER_INBOX_AMBIGUOUS');
    assert.equal(ambiguous.targetCount, 2);

    let clicked = false;
    const unverifiedPage = {
      async waitForTimeout() {},
      locator(selector) {
        if (selector.includes('conversationStrangerBoxwrapper')) return rootLocator([visibleNode({ async click() { clicked = true; } })]);
        if (selector === '.conversationStrangerConversationListtitle' && clicked) return rootLocator([visibleNode({ async innerText() { return '陌生人消息'; } })]);
        return rootLocator([]);
      }
    };
    const unverified = await adapter.openDouyinStrangerInbox(unverifiedPage);
    assert.equal(clicked, true);
    assert.equal(unverified.ok, false);
    assert.equal(unverified.reason, 'STRANGER_INBOX_VIEW_UNVERIFIED');
    assert.equal(unverified.titleVisible, true);
    assert.equal(unverified.listVisible, false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Douyin stranger extraction keeps unread rows only and records STRANGER context', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-stranger-extract-'));
  try {
    const adapter = new DouyinAssistedRpaAdapter({ platformCode: 'douyin', logsDir: dir, profileDir: path.join(dir, 'profile'), executablePath: '', loginTimeoutMs: 1000, sendTimeoutMs: 1000 });
    const page = {
      url() { return 'https://www.douyin.com/user/self'; },
      locator() { return { async evaluateAll() { return [
        { index: 0, text: '历史预览', userName: '历史用户', eventTime: '08/01', unread: false, unreadEvidence: null, unreadCount: 0, conversationKey: 'old' },
        { index: 1, text: '最新陌生人消息', userName: '新用户', eventTime: '08/06', unread: true, unreadEvidence: 'badge 2', unreadCount: 2, conversationKey: 'new' }
      ]; } }; }
    };
    const messages = await adapter.extractMessages(page, 'PRIVATE_MESSAGE', { noteCandidates: [] }, { inboxType: 'STRANGER' });
    assert.equal(messages.length, 1);
    assert.equal(messages[0].userName, '新用户');
    assert.equal(messages[0].context.inboxType, 'STRANGER');
    assert.equal(messages[0].context.unreadCount, 2);
    assert.equal(messages[0].context.previewOnly, true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Douyin private inbox merge prefers verified STRANGER rows and removes duplicate previews', () => {
  const sharedMain = { userName: 'same-user', content: 'same-preview', context: { eventTime: '10:00', inboxType: 'MAIN' } };
  const sharedStranger = { userName: 'same-user', content: 'same-preview', context: { eventTime: '10:00', inboxType: 'STRANGER' } };
  const uniqueMain = { userName: 'main-user', content: 'main-preview', context: { eventTime: '10:01', inboxType: 'MAIN' } };
  const uniqueStranger = { userName: 'stranger-user', content: 'stranger-preview', context: { eventTime: '10:02', inboxType: 'STRANGER' } };
  const merged = mergeDouyinPrivateInboxMessages([sharedMain, uniqueMain], [sharedStranger, uniqueStranger]);
  assert.deepEqual(merged.messages, [uniqueMain, sharedStranger, uniqueStranger]);
  assert.deepEqual(merged.mainMessages, [uniqueMain]);
  assert.deepEqual(merged.strangerMessages, [sharedStranger, uniqueStranger]);
  assert.equal(merged.droppedDuplicateCount, 1);
});

test('Douyin private extraction passes exact inbox scope into DOM filtering', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-private-scope-'));
  try {
    const adapter = new DouyinAssistedRpaAdapter({ platformCode: 'douyin', logsDir: dir, profileDir: path.join(dir, 'profile'), executablePath: '', loginTimeoutMs: 1000, sendTimeoutMs: 1000 });
    const seen = [];
    const page = {
      url() { return 'https://www.douyin.com/user/self'; },
      locator() { return { async evaluateAll(_callback, options) {
        seen.push({ platformCode: options.platformCode, inboxType: options.inboxType });
        return [];
      } }; }
    };
    await adapter.extractMessages(page, 'PRIVATE_MESSAGE', { noteCandidates: [] }, { inboxType: 'MAIN' });
    await adapter.extractMessages(page, 'PRIVATE_MESSAGE', { noteCandidates: [] }, { inboxType: 'STRANGER' });
    assert.deepEqual(seen, [
      { platformCode: 'douyin', inboxType: 'MAIN' },
      { platformCode: 'douyin', inboxType: 'STRANGER' }
    ]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Douyin STRANGER reply enters the stranger inbox before locating a conversation', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-stranger-reply-order-'));
  try {
    const adapter = new DouyinAssistedRpaAdapter({ platformCode: 'douyin', logsDir: dir, profileDir: path.join(dir, 'profile'), executablePath: '', loginTimeoutMs: 1000, sendTimeoutMs: 1000 });
    let strangerOpened = false;
    adapter.prepareMessagePage = async () => ({ requestedUrl: adapter.spec.messageUrl, finalUrl: adapter.spec.messageUrl, attempts: 1 });
    adapter.inspectLoginState = async () => ({ state: 'READY', evidence: ['authenticated'] });
    adapter.waitForMessageContentReady = async () => ({ ready: true, pageCheck: { valid: true, reason: 'VERIFIED_DOM' } });
    adapter.openDouyinStrangerInbox = async () => { strangerOpened = true; return { ok: true }; };
    const page = {
      url() { return adapter.spec.messageUrl; },
      locator(selector) {
        if (selector === '[data-e2e="conversation-item"]') {
          assert.equal(strangerOpened, true);
          return { async count() { return 0; }, nth() { throw new Error('no row expected'); } };
        }
        return { async count() { return 0; }, nth() { return this; }, async isVisible() { return false; } };
      }
    };
    const result = await adapter.openPrivateConversationForPayload(page, { userName: '陌生用户', sourceContent: '原始消息', messageContext: { inboxType: 'STRANGER' } }, { requireSourcePreview: true, requireUnreadEvidence: false });
    assert.equal(strangerOpened, true);
    assert.equal(result.reason, 'CONVERSATION_LIST_LOADING_TIMEOUT');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Douyin MAIN reply never matches a row while the stranger inbox view is visible', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-main-inbox-isolation-'));
  try {
    const adapter = new DouyinAssistedRpaAdapter({ platformCode: 'douyin', logsDir: dir, profileDir: path.join(dir, 'profile'), executablePath: '', loginTimeoutMs: 1000, sendTimeoutMs: 1000 });
    let conversationRowsTouched = false;
    adapter.prepareMessagePage = async () => ({ requestedUrl: adapter.spec.messageUrl, finalUrl: adapter.spec.messageUrl, attempts: 1 });
    adapter.inspectLoginState = async () => ({ state: 'READY', evidence: ['authenticated'] });
    adapter.waitForMessageContentReady = async () => ({ ready: true, pageCheck: { valid: true, reason: 'VERIFIED_DOM' } });
    const single = item => ({ async count() { return 1; }, nth() { return item; } });
    const visibleText = text => ({ async isVisible() { return true; }, async innerText() { return text; } });
    const page = {
      url() { return adapter.spec.messageUrl; },
      locator(selector) {
        if (selector === '.conversationStrangerConversationListtitle') return single(visibleText('陌生人消息'));
        if (selector === '.conversationStrangerConversationListlistWrapper') return single(visibleText(''));
        if (selector === '[data-e2e="conversation-item"]') conversationRowsTouched = true;
        return { async count() { return 0; }, nth() { return this; }, async isVisible() { return false; } };
      }
    };
    const result = await adapter.openPrivateConversationForPayload(page, { userName: '普通用户', sourceContent: '原始消息', messageContext: { inboxType: 'MAIN' } });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'MAIN_INBOX_VIEW_UNVERIFIED');
    assert.equal(conversationRowsTouched, false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Douyin reply rejects a multi-unread preview before opening the browser', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-multi-unread-reply-block-'));
  try {
    const adapter = new DouyinAssistedRpaAdapter({ platformCode: 'douyin', logsDir: dir, profileDir: path.join(dir, 'profile'), executablePath: '', loginTimeoutMs: 1000, sendTimeoutMs: 1000 });
    let pageRequested = false;
    adapter.getPage = async () => { pageRequested = true; throw new Error('browser must not open'); };
    adapter.evidence = async (_payload, message, _page, stage, extra = {}) => ({ message, stage, ...extra });
    const result = await adapter.replyToMessage({ platformCode: 'douyin', accountId: 'test-account', messageType: 'PRIVATE_MESSAGE', userName: '普通用户', sourceContent: '原始消息', replyText: '测试回复', messageContext: { conversationId: 'conversation-preview', messageId: 'message-preview', direction: 'incoming', previewOnly: true, unreadCount: 2, inboxType: 'STRANGER', sourceVerified: true, chatTitleVerified: true } });
    assert.equal(result.status, 'NEEDS_CONFIRMATION');
    assert.equal(result.result.stage, 'reply_eligibility_blocked');
    assert.equal(result.result.eligibility.reason, 'SIDEBAR_PREVIEW_NOT_SENDABLE');
    assert.equal(pageRequested, false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Douyin comment reply identity requires exact user, content and time/fingerprint in one row', () => {
  const payload = {
    messageType: 'COMMENT',
    userName: '\u5496\u5561\u4e0d\u5609\ud83e\uddca',
    sourceContent: '\u793e\u533a\u6d3b\u52a8\u600e\u4e48\u62a5\u540d\uff1f',
    messageContext: { eventTime: '\u6628\u592922:37' }
  };
  const exact = matchDouyinCommentIdentity({ userName: payload.userName, content: payload.sourceContent, eventTime: '\u6628\u592922:37' }, payload);
  assert.equal(exact.matched, true);
  const otherUser = matchDouyinCommentIdentity({ userName: '\u540c\u6587\u5176\u4ed6\u7528\u6237', content: payload.sourceContent, eventTime: '\u6628\u592922:37' }, payload);
  assert.equal(otherUser.matched, false);
  assert.equal(otherUser.reason, 'COMMENT_USER_MISMATCH');
  const otherTime = matchDouyinCommentIdentity({ userName: payload.userName, content: payload.sourceContent, eventTime: '\u6628\u592922:38' }, payload);
  assert.equal(otherTime.matched, false);
  assert.equal(otherTime.reason, 'COMMENT_TIME_MISMATCH');
});

test('Wechat comment reply trusts matching stable work/comment IDs across time formats', () => {
  const payload = {
    messageType: 'COMMENT',
    userName: '是一只七.',
    sourceContent: '账号发布的内容可以转载吗？',
    messageContext: {
      eventTime: '2026/08/17 23:05',
      commentFingerprint: 'display-time-fingerprint',
      sourceVideoKey: 'export/work-stable-1',
      commentStableId: '14990267196328777889'
    }
  };
  const result = matchDouyinCommentIdentity({
    userName: payload.userName,
    content: payload.sourceContent,
    eventTime: '1786979102',
    sourceVideoKey: 'export/work-stable-1',
    commentStableId: '14990267196328777889'
  }, payload);
  assert.equal(result.matched, true);
  assert.equal(result.reason, 'COMMENT_IDENTITY_STABLE_IDS');
});

test('Douyin comment reply rejects a stale or mismatched fingerprint', () => {
  const payload = {
    userName: '\u6d4b\u8bd5\u7528\u6237', sourceContent: '\u540c\u4e00\u6761\u8bc4\u8bba',
    messageContext: { eventTime: '21:30', commentFingerprint: 'not-the-live-fingerprint' }
  };
  const result = matchDouyinCommentIdentity({ userName: '\u6d4b\u8bd5\u7528\u6237', content: '\u540c\u4e00\u6761\u8bc4\u8bba', eventTime: '21:30' }, payload);
  assert.equal(result.matched, false);
  assert.equal(result.reason, 'COMMENT_FINGERPRINT_MISMATCH');
});

test('Douyin private reply requires exact conversation and unchanged source preview', () => {
  const payload = { userName: '\u5ba2\u6237A', sourceContent: '\u8bf7\u95ee\u793e\u533a\u7535\u8bdd\u662f\u591a\u5c11\uff1f', messageContext: { conversationName: '\u5ba2\u6237A' } };
  assert.equal(matchPrivateConversationIdentity({ name: '\u5ba2\u6237A', preview: '\u8bf7\u95ee\u793e\u533a\u7535\u8bdd\u662f\u591a\u5c11\uff1f' }, payload).matched, true);
  const changed = matchPrivateConversationIdentity({ name: '\u5ba2\u6237A', preview: '\u7528\u6237\u53c8\u53d1\u4e86\u4e00\u6761\u65b0\u6d88\u606f' }, payload);
  assert.equal(changed.matched, false);
  assert.equal(changed.reason, 'SOURCE_PREVIEW_CHANGED');
  const wrongConversation = matchPrivateConversationIdentity({ name: '\u5ba2\u6237B', preview: payload.sourceContent }, payload);
  assert.equal(wrongConversation.matched, false);
  assert.equal(wrongConversation.reason, 'CONVERSATION_NAME_MISMATCH');
});

test('Douyin reply implementation uses scoped send controls and scoped echo verification', () => {
  const source = AssistedPlatformRpaAdapter.prototype.replyToMessage.toString();
  assert.match(source, /countExactPrivateMessages/);
  assert.match(source, /countExactCommentEchoes/);
  assert.match(source, /clickDouyinCommentSend/);
  assert.match(source, /baselineEchoCount/);
  assert.match(AssistedPlatformRpaAdapter.prototype.openPrivateConversationForPayload.toString(), /waitForPrivateConversationHeader/);
  assert.match(AssistedPlatformRpaAdapter.prototype.waitForPrivateConversationHeader.toString(), /locatePrivateConversationHeader/);
  assert.match(AssistedPlatformRpaAdapter.prototype.locatePrivateConversationHeader.toString(), /insideConversationRow/);
  assert.match(AssistedPlatformRpaAdapter.prototype.locatePrivateConversationHeader.toString(), /editorBox/);
  assert.match(AssistedPlatformRpaAdapter.prototype.openPrivateConversationForPayload.toString(), /SOURCE_MESSAGE_NOT_IN_CONVERSATION/);
});

test('Douyin private-message preparation does not toggle an already-open panel closed', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-private-panel-open-'));
  try {
    const adapter = new DouyinAssistedRpaAdapter({ platformCode: 'douyin', logsDir: dir, profileDir: path.join(dir, 'profile'), executablePath: '', loginTimeoutMs: 1000, sendTimeoutMs: 1000 });
    const page = {
      currentUrl: 'about:blank', panelOpen: true, entryClicks: 0,
      async goto(url) { this.currentUrl = url; }, async waitForTimeout() {}, url() { return this.currentUrl; },
      locator(selector) {
        if (selector === '[data-e2e="im-entry"]') return { async count() { return 1; }, nth() { return this; }, async isVisible() { return true; }, async click() { page.entryClicks += 1; page.panelOpen = !page.panelOpen; } };
        if (selector === 'body') return { async innerText() { return page.panelOpen ? '\u4e0b\u8f7d\u5ba2\u6237\u7aef\uff0c\u5b9e\u65f6\u63a5\u6536\u597d\u53cb\u6d88\u606f \u964c\u751f\u4eba\u6d88\u606f \u6536\u8d77\u4f1a\u8bdd' : '\u4e2a\u4eba\u4e3b\u9875'; }, async evaluateAll() { return []; } };
        return { async evaluateAll() { return []; }, async count() { return 0; }, nth() { return this; }, async isVisible() { return false; } };
      }
    };
    adapter.getPage = async () => page;
    adapter.inspectLoginState = async () => ({ state: 'UNKNOWN', evidence: ['main-site-page'] });
    adapter.evidence = async (_payload, message, evidencePage, stage, extra = {}) => ({ message, stage, url: evidencePage.url(), ...extra });
    const result = await adapter.collectMessages({ types: ['PRIVATE_MESSAGE'], profileName: 'test' });
    assert.equal(result.status, 'SUCCESS');
    assert.equal(page.panelOpen, true);
    assert.equal(page.entryClicks, 0);
    assert.equal(result.result.typeResults[0].navigation.entryAction, 'already-open');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Douyin private conversation name selector excludes the sibling time label', () => {
  const spec = PLATFORM_ASSISTED_SPECS.douyin;
  assert.deepEqual(spec.privateConversationNameSelectors, ['.conversationConversationItemtitle']);
  assert.equal(spec.privateConversationNameSelectors.some(selector => selector.includes('*=')), false);
});

test('\u6296\u97f3\u79c1\u4fe1\u63d0\u53d6\uff1a\u53ea\u4fdd\u7559\u5e26\u53ef\u89c1\u672a\u8bfb\u6807\u8bb0\u7684\u4f1a\u8bdd\u9884\u89c8', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-private-unread-'));
  try {
    const adapter = new DouyinAssistedRpaAdapter({ platformCode: 'douyin', logsDir: dir, profileDir: path.join(dir, 'profile'), executablePath: '', loginTimeoutMs: 1000, sendTimeoutMs: 1000 });
    const page = {
      url() { return 'https://www.douyin.com/user/self'; },
      locator() { return { async evaluateAll() { return [
        { index: 0, text: '\u5386\u53f2\u6d88\u606f', userName: '\u5386\u53f2\u7528\u6237', eventTime: '08/01', unread: false, unreadEvidence: null, conversationKey: null, href: null },
        { index: 1, text: '\u65b0\u6d88\u606f\u6d4b\u8bd5', userName: '\u6d4b\u8bd5\u7528\u6237', eventTime: '21:58', unread: true, unreadEvidence: 'ConversationItemUnReadCountbadge 1', conversationKey: 'conv-1', href: null }
      ]; } }; }
    };
    const messages = await adapter.extractMessages(page, 'PRIVATE_MESSAGE', { noteCandidates: [] });
    assert.equal(messages.length, 1);
    assert.equal(messages[0].userName, '\u6d4b\u8bd5\u7528\u6237');
    assert.equal(messages[0].content, '\u65b0\u6d88\u606f\u6d4b\u8bd5');
    assert.equal(messages[0].context.unread, true);
    assert.match(messages[0].context.selectorVersion, /^douyin-web-im-2026\.08\.06\.(?:[4-9]|[1-9]\d+)$/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('\u6296\u97f3\u8bc4\u8bba\u5165\u53e3\uff1a\u9996\u6b21\u88ab\u5b89\u5168\u91cd\u5b9a\u5411\u5230\u9996\u9875\u65f6\u53ea\u91cd\u8bd5\u4e00\u6b21', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-comment-retry-'));
  try {
    const adapter = new DouyinAssistedRpaAdapter({ platformCode: 'douyin', logsDir: dir, profileDir: path.join(dir, 'profile'), executablePath: '', loginTimeoutMs: 1000, sendTimeoutMs: 1000 });
    const page = {
      currentUrl: 'about:blank', attempts: 0,
      async goto() { this.attempts += 1; this.currentUrl = this.attempts === 1 ? 'https://creator.douyin.com/creator-micro/home' : 'https://creator.douyin.com/creator-micro/data/following/comment'; },
      async waitForTimeout() {}, url() { return this.currentUrl; },
      locator(selector) { return { async innerText() { return selector === 'body' ? (page.attempts === 1 ? '创作者中心 数据中心' : '评论管理 选择作品 暂无评论') : ''; }, async evaluateAll() { return []; } }; }
    };
    adapter.getPage = async () => page;
    adapter.inspectLoginState = async () => ({ state: 'READY', evidence: ['test-authenticated'] });
    // 本用例只验证安全重定向后的单次重试，不重复模拟历史评论滚动采集器。
    adapter.collectHistoricalCommentMessages = async () => ({ messages: [], rounds: 1, uniqueCount: 0, stopReason: 'TEST_EMPTY' });
    adapter.evidence = async (_payload, message, evidencePage, stage, extra = {}) => ({ message, stage, url: evidencePage.url(), ...extra });
    const result = await adapter.collectMessages({ types: ['COMMENT'], profileName: 'test' });
    assert.equal(result.status, 'SUCCESS');
    assert.equal(page.attempts, 2);
    assert.equal(result.result.typeResults[0].navigation.attempts, 2);
    assert.equal(result.result.typeResults[0].navigation.retryReason, 'URL_MISMATCH');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});


test('\u89c6\u9891\u53f7\u767b\u5f55\u5224\u5b9a\uff1a\u53d7\u4fdd\u62a4 URL \u4e0e\u53ef\u89c1\u4e1a\u52a1\u63a7\u4ef6\u540c\u65f6\u5b58\u5728\u624d\u5224\u5b9a READY', () => {
  const spec = PLATFORM_ASSISTED_SPECS.wechat_channels;
  const selector = 'input[placeholder*="\u641c\u7d22\u89c6\u9891"]';
  const result = classifyAssistedLoginEvidence({
    url: 'https://channels.weixin.qq.com/platform/post/list',
    text: '\u5185\u5bb9\u7ba1\u7406 \u4e92\u52a8\u7ba1\u7406 \u76f4\u64ad\u7ba1\u7406 \u641c\u7d22\u89c6\u9891 \u53d1\u8868\u89c6\u9891',
    visibleSelectors: [selector],
    spec
  });
  assert.equal(result.state, 'READY');
  assert.deepEqual(result.evidence, ['authenticated-url', `authenticated-selector:${selector}`, 'authenticated-text']);
});

test('\u89c6\u9891\u53f7\u767b\u5f55\u9875\u8bc1\u636e\u4f18\u5148\u4e8e\u65e7\u9875\u9762\u6b8b\u7559\u7684\u767b\u5f55\u540e DOM', () => {
  const spec = PLATFORM_ASSISTED_SPECS.wechat_channels;
  const result = classifyAssistedLoginEvidence({
    url: 'https://channels.weixin.qq.com/platform/post/list',
    text: '\u5185\u5bb9\u7ba1\u7406 \u8bf7\u4f7f\u7528\u5fae\u4fe1\u626b\u63cf\u4e8c\u7ef4\u7801',
    visibleSelectors: ['[class*="qrcode"]', 'input[placeholder*="\u641c\u7d22\u89c6\u9891"]'],
    spec
  });
  assert.equal(result.state, 'LOGIN');
  assert.ok(result.evidence.includes('login-text'));
  assert.ok(result.evidence.some(item => item.startsWith('logged-out-selector:')));
});

test('\u7cbe\u51c6\u767b\u5f55\u590d\u6838\uff1a\u8fde\u7eed\u4e09\u6b21\u660e\u786e LOGIN \u624d\u786e\u8ba4\u9000\u51fa', async () => {
  let calls = 0;
  const status = await checkLoginPrecisely({
    check: async () => ({ state: 'LOGIN', confidence: 'CONFIRMED', evidence: ['login-url'], checkedAt: new Date(1760000000000 + calls++).toISOString(), url: 'https://example.com/login' }),
    logoutConfirmations: 3,
    confirmDelayMs: 250,
    sleep: async () => {},
    mode: 'POLL'
  });
  assert.equal(calls, 3);
  assert.equal(status.state, 'LOGIN');
  assert.equal(status.confidence, 'CONFIRMED');
  assert.equal(status.confirmedSamples, 3);
  assert.equal(status.checkMode, 'POLL');
  assert.ok(status.evidence.includes('consecutive-login-confirmations:3'));
});

test('视频号扫码页检查：已显示二维码时不得重新导航刷新', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-login-preserve-'));
  try {
    const adapter = new WechatChannelsAssistedRpaAdapter({ platformCode: 'wechat_channels', logsDir: dir, profileDir: path.join(dir, 'profile'), executablePath: '', loginTimeoutMs: 1000, sendTimeoutMs: 1000 });
    let navigations = 0;
    const page = {
      async goto() { navigations += 1; },
      async waitForTimeout() {},
      url() { return 'https://channels.weixin.qq.com/platform/login'; }
    };
    adapter.getPage = async () => page;
    adapter.status = async () => ({ platformCode: 'wechat_channels', browser: 'OPEN', loggedIn: false, state: 'LOGIN', confidence: 'CONFIRMED', evidence: ['login-text'], checkedAt: new Date().toISOString(), url: page.url(), message: '等待扫码' });
    const status = await adapter.checkLogin({ preserveInteractiveLogin: true });
    assert.equal(status.state, 'LOGIN');
    assert.equal(navigations, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('精准登录复核：首次检查允许导航，后续复核只读取当前页面', async () => {
  let navigationChecks = 0;
  let passiveChecks = 0;
  const loggedOut = () => ({ state: 'LOGIN', confidence: 'CONFIRMED', evidence: ['login-url'], checkedAt: new Date().toISOString(), url: 'https://example.com/login' });
  const status = await checkLoginPrecisely({
    check: async () => { navigationChecks += 1; return loggedOut(); },
    recheck: async () => { passiveChecks += 1; return loggedOut(); },
    logoutConfirmations: 3,
    sleep: async () => {}
  });
  assert.equal(navigationChecks, 1);
  assert.equal(passiveChecks, 2);
  assert.equal(status.confirmedSamples, 3);
});

test('\u7cbe\u51c6\u767b\u5f55\u590d\u6838\uff1aLOGIN \u4e0e READY \u6ce2\u52a8\u65f6\u5fc5\u987b\u8fd4\u56de UNKNOWN', async () => {
  const samples = [
    { state: 'LOGIN', confidence: 'CONFIRMED', evidence: ['login-text'] },
    { state: 'READY', confidence: 'CONFIRMED', evidence: ['authenticated-url', 'authenticated-text'] }
  ];
  const status = await checkLoginPrecisely({ check: async () => ({ ...samples.shift(), checkedAt: new Date().toISOString() }), sleep: async () => {} });
  assert.equal(status.state, 'UNKNOWN');
  assert.equal(status.confidence, 'UNCONFIRMED');
  assert.equal(status.confirmedSamples, 0);
  assert.ok(status.evidence.some(item => item.startsWith('unstable-login-samples:')));
});

test('\u4f01\u5fae\u9000\u767b\u544a\u8b66\uff1a\u53ea\u63a5\u53d7\u8fde\u7eed\u4e09\u6b21\u4e14\u6709\u660e\u786e\u767b\u5f55\u9875\u8bc1\u636e', () => {
  const base = { state: 'LOGIN', confidence: 'CONFIRMED', confirmedSamples: 3, evidence: ['login-url', 'consecutive-login-confirmations:3'] };
  assert.equal(isConfirmedLoginExpired({ ...base, confidence: 'UNCONFIRMED' }), false);
  assert.equal(isConfirmedLoginExpired({ ...base, confirmedSamples: 2 }), false);
  assert.equal(isConfirmedLoginExpired({ ...base, evidence: ['consecutive-login-confirmations:3'] }), false);
  assert.equal(isConfirmedLoginExpired(base), true);
  const notification = buildLoginExpiredNotification({ account: { platform_name: '\u89c6\u9891\u53f7', display_name: '\u6e2f\u6fb3\u793e\u533a-\u89c6\u9891\u53f7', device_name: 'RPA-01' }, data: { ...base, checkedAt: '2026-08-06T06:00:00.000Z', url: 'https://channels.weixin.qq.com/login.html' } });
  assert.equal(notification.type, 'PLATFORM_LOGIN_EXPIRED');
  assert.match(notification.content, /\u8fde\u7eed 3 \u6b21\u68c0\u67e5\u8bc1\u636e\u4e00\u81f4/);
  assert.match(notification.content, /\u89c6\u9891\u53f7/);
});


test('发布页仍在加载或上传 0% 时禁止进入最终提交', () => {
  const loading = analyzePublishReadiness({ text: '加载中，请稍候...', publishButtonVisible: false, publishButtonEnabled: false });
  assert.equal(loading.ready, false);
  const uploading = analyzePublishReadiness({ text: '上传中 0% 当前速度 1.00MB/s 智能推荐封面生成中，请稍等', publishButtonVisible: true, publishButtonEnabled: true });
  assert.equal(uploading.ready, false);
  assert.equal(uploading.busy, true);
  assert.equal(uploading.incompleteProgress, true);
});


test('平台帮助文案提到上传中时不得误判为真实上传状态', () => {
  const ready = analyzePublishReadiness({
    text: '发布 暂存离开 点击发布后，如作品还在上传中，请勿关闭页面，等待上传发布完成。预览视频 重新上传',
    publishButtonVisible: true,
    publishButtonEnabled: true
  });
  assert.equal(ready.ready, true);
  assert.equal(ready.busy, false);
});
test('平台发布字段：标题已单独填写时，视频描述不得重复标题', () => {
  const payload = { title: '澳门车主注意事项', body: '澳门车主应注意事项，详情请看视频内容' };
  assert.equal(composePlatformPublishDescription(payload, { titleFilled: true }), '澳门车主应注意事项，详情请看视频内容');
  assert.equal(composePlatformPublishDescription(payload, { titleFilled: false }), '澳门车主注意事项 澳门车主应注意事项，详情请看视频内容');
});

test('视频号短标题按平台字符与 16 字限制安全规整', () => {
  const original = '社区活动报名指南｜2026年8月6日';
  const constrained = constrainPlatformTitle(original, PLATFORM_ASSISTED_SPECS.wechat_channels.titleMaxLength, PLATFORM_ASSISTED_SPECS.wechat_channels.titleUnsupportedPattern);
  assert.equal(constrained.value, '社区活动报名指南 2026年8月');
  assert.equal(constrained.sanitized, true);
  assert.equal(constrained.truncated, true);
  assert.equal(constrained.originalLength, 18);
  assert.equal(constrained.length, 16);
  assert.deepEqual(constrainPlatformTitle('社区活动', 16), { value: '社区活动', sanitized: false, truncated: false, originalLength: 4, length: 4 });
});

test('视频号文件处理阶段不得提前判定草稿就绪', () => {
  const processing = analyzePublishReadiness({ text: '正在处理文件 封面预览 编辑', publishButtonVisible: true, publishButtonEnabled: true });
  assert.equal(processing.ready, false);
  assert.equal(processing.busy, true);
  const spec = PLATFORM_ASSISTED_SPECS.wechat_channels;
  assert.equal(spec.requireUploadEvidence, true);
  assert.equal(spec.draftRequiresPublishEnabled, true);
  assert.ok(spec.captionSelectors.includes('.input-editor[contenteditable]'));
});

test('发布按钮不可用时禁止点击，上传完成且按钮可用才允许提交', () => {
  const disabled = analyzePublishReadiness({ text: '上传完成', publishButtonVisible: true, publishButtonEnabled: false });
  assert.equal(disabled.ready, false);
  const ready = analyzePublishReadiness({ text: '上传完成 封面已生成', publishButtonVisible: true, publishButtonEnabled: true });
  assert.equal(ready.ready, true);
  assert.equal(ready.busy, false);
});

test('发布准备检查会明确识别上传失败，但不会只凭“重新上传”按钮误判', () => {
  const failed = analyzePublishReadiness({ text: '上传失败，重新上传', publishButtonVisible: false, publishButtonEnabled: false });
  assert.equal(failed.ready, false);
  assert.equal(failed.busy, false);
  assert.equal(failed.uploadFailed, true);
  assert.equal(failed.failureCode, 'PLATFORM_UPLOAD_FAILED');

  const channelsNetworkFailure = analyzePublishReadiness({ text: '网络出错，请重新上传。 视频描述 短标题', publishButtonVisible: true, publishButtonEnabled: true });
  assert.equal(channelsNetworkFailure.ready, false);
  assert.equal(channelsNetworkFailure.uploadFailed, true);
  assert.match(channelsNetworkFailure.failureText, /网络出错/);

  const retryButtonOnly = analyzePublishReadiness({ text: '重新上传 作品描述', publishButtonVisible: true, publishButtonEnabled: true });
  assert.equal(retryButtonOnly.uploadFailed, false);
  assert.equal(retryButtonOnly.ready, true);
});

test('抖音发布页出现上传失败时立即中止并返回可重试状态', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-upload-failed-'));
  try {
    const emptyLocator = {
      count: async () => 0,
      nth() { return this; }
    };
    const frame = {
      locator: selector => selector === 'body' ? { allInnerTexts: async () => ['上传失败，重新上传'] } : emptyLocator,
      getByRole: () => emptyLocator,
      getByText: () => emptyLocator
    };
    const page = {
      frames: () => [frame],
      waitForTimeout: async () => { throw new Error('检测上传失败后不应继续等待'); }
    };
    const adapter = new AssistedPlatformRpaAdapter({
      platformCode: 'douyin',
      logsDir: path.join(dir, 'logs'),
      profileDir: path.join(dir, 'profile'),
      executablePath: 'chrome',
      loginTimeoutMs: 1,
      sendTimeoutMs: 1
    });

    await assert.rejects(
      adapter.waitForUploadAndPublishReady(page, 60_000),
      error => error.code === 'PLATFORM_UPLOAD_FAILED'
        && error.retryable === true
        && error.platformState === 'UPLOAD_FAILED'
        && /抖音视频上传失败/.test(error.message)
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('微博内容声明必须来自明确内容来源，禁止系统猜测', () => {
  assert.equal(normalizeContentOrigin(''), null);
  assert.equal(normalizeContentOrigin('unknown'), null);
  assert.equal(normalizeContentOrigin('AI_GENERATED'), 'AI_GENERATED');
  assert.equal(normalizeContentOrigin('human_original'), 'HUMAN_ORIGINAL');
  assert.ok(contentDeclarationLabels('AI_GENERATED').includes('含AI生成内容'));
  assert.ok(contentDeclarationLabels('HUMAN_ORIGINAL').includes('原创内容'));
  assert.deepEqual(contentDeclarationLabels('unknown'), []);
  assert.equal(PLATFORM_ASSISTED_SPECS.weibo.contentDeclarationRequired, true);
});

test('抖音发布入口配置覆盖管理页高清发布跳转', () => {
  assert.deepEqual(PLATFORM_ASSISTED_SPECS.douyin.publishEntryLabels, ['高清发布', '发布视频', '上传视频', '发布作品']);
});

test('\u6296\u97f3\u7d20\u6750\u6302\u8f7d\uff1a\u9875\u9762\u6d88\u8d39\u5e76\u6e05\u7a7a input \u540e\u7981\u6b62\u518d\u6b21\u4e0a\u4f20', () => {
  assert.equal(materialAttachOutcome({ commandAccepted: false, selectionCount: 0, evidenceConfirmed: false }), 'TRY_NEXT');
  assert.equal(materialAttachOutcome({ commandAccepted: true, selectionCount: 1, evidenceConfirmed: false }), 'ATTACHED');
  assert.equal(materialAttachOutcome({ commandAccepted: true, selectionCount: 0, evidenceConfirmed: true }), 'ATTACHED');
  assert.equal(materialAttachOutcome({ commandAccepted: true, selectionCount: 0, evidenceConfirmed: false }), 'STOP_UNCONFIRMED');
});

test('\u6296\u97f3\u7d20\u6750\u6302\u8f7d\uff1a\u771f\u5b9e\u4e0a\u4f20\u8fdb\u5ea6\u53ef\u4f5c\u4e3a\u8bc1\u636e\uff0c\u521d\u59cb\u4e0a\u4f20\u63d0\u793a\u4e0d\u53ef', () => {
  const pattern = PLATFORM_ASSISTED_SPECS.douyin.uploadEvidenceTextPattern;
  assert.equal(pattern.test('\u5df2\u4e0a\u4f20\uff1a3.1MB/3.2MB \u5f53\u524d\u901f\u5ea6\uff1a1011KB/s \u5269\u4f59\u65f6\u95f4\uff1a1\u79d2 98%'), true);
  pattern.lastIndex = 0;
  assert.equal(pattern.test('\u70b9\u51fb\u4e0a\u4f20\u6216\u5c06\u89c6\u9891\u62d6\u62fd\u5230\u6b64\u5904'), false);
});


test('草稿结果必须绑定本次素材挂载审计，禁止返回未定义变量', () => {
  const source = AssistedPlatformRpaAdapter.prototype.prepareDraft.toString();
  assert.match(source, /(?:let|const)\s+materialAttachment\s*=\s*(?:null|await\s+uploadFile\()/);
  assert.match(source, /materialAttachment\s*=\s*await\s+uploadFile\(/);
  assert.match(source, /return\s*\{\s*materialAttachment\s*,/);
});


test('Douyin publish success ignores upload guidance text', () => {
  const spec = PLATFORM_ASSISTED_SPECS.douyin;
  const guidance = reliablePublishSuccessEvidence({
    url: 'https://creator.douyin.com/creator-micro/content/post/video?enter_from=publish_page',
    signalText: '\u70b9\u51fb\u53d1\u5e03\u540e\uff0c\u5982\u4f5c\u54c1\u8fd8\u5728\u4e0a\u4f20\u4e2d\uff0c\u8bf7\u52ff\u5173\u95ed\u9875\u9762\uff0c\u7b49\u5f85\u4e0a\u4f20\u53d1\u5e03\u5b8c\u6210\u3002',
    pageText: '\u53d1\u5e03 \u6682\u5b58\u79bb\u5f00',
    spec
  });
  assert.equal(guidance.confirmed, false);
  const success = reliablePublishSuccessEvidence({
    url: 'https://creator.douyin.com/creator-micro/content/post/video?enter_from=publish_page',
    signalText: '\u53d1\u5e03\u6210\u529f',
    spec
  });
  assert.equal(success.confirmed, true);
  assert.equal(success.source, 'visible-success-signal');
});

test('视频号 AUTO 缺少本次最终确认时绝不点击发表', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-publish-confirm-'));
  const materialPath = path.join(dir, 'sample.mp4');
  fs.writeFileSync(materialPath, 'video');
  try {
    const adapter = new WechatChannelsAssistedRpaAdapter({ platformCode: 'wechat_channels', logsDir: path.join(dir, 'logs'), profileDir: path.join(dir, 'profile'), executablePath: '', loginTimeoutMs: 1, sendTimeoutMs: 1 });
    const page = { async goto() {}, async waitForTimeout() {}, url() { return PLATFORM_ASSISTED_SPECS.wechat_channels.publishUrl; } };
    let clickCount = 0;
    adapter.getPage = async () => page;
    adapter.waitForReady = async () => true;
    adapter.prepareDraft = async () => ({ readiness: { ready: true } });
    adapter.clickFinalPublish = async () => { clickCount += 1; return { clicked: true }; };
    adapter.evidence = async (_payload, message, _page, stage, extra = {}) => ({ message, stage, ...extra });
    const result = await adapter.publish({ materialPath, publishMode: 'AUTO', managementConfirmed: false });
    assert.equal(result.status, 'NEEDS_CONFIRMATION');
    assert.equal(result.result.finalActionAuthorized, false);
    assert.equal(clickCount, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('视频号发布信号对象必须 confirmed=true 才能返回 SUCCESS', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-publish-signal-'));
  const materialPath = path.join(dir, 'sample.mp4');
  fs.writeFileSync(materialPath, 'video');
  try {
    const adapter = new WechatChannelsAssistedRpaAdapter({ platformCode: 'wechat_channels', logsDir: path.join(dir, 'logs'), profileDir: path.join(dir, 'profile'), executablePath: '', loginTimeoutMs: 1, sendTimeoutMs: 1 });
    const page = {
      async goto() {}, async waitForTimeout() {}, url() { return PLATFORM_ASSISTED_SPECS.wechat_channels.publishUrl; },
      locator() { return { async innerText() { return ''; }, async evaluateAll() { return []; } }; }
    };
    adapter.getPage = async () => page;
    adapter.waitForReady = async () => true;
    adapter.prepareDraft = async () => ({ readiness: { ready: true } });
    adapter.clickFinalPublish = async () => ({ clicked: true, primary: 'CLICKED', confirmation: 'NOT_PRESENT' });
    adapter.evidence = async (_payload, message, _page, stage, extra = {}) => ({ message, stage, evidencePath: 'proof.json', screenshotPath: 'proof.png', ...extra });
    adapter.waitForPublishSignal = async () => ({ confirmed: false, source: null });
    const unknown = await adapter.publish({ materialPath, publishMode: 'AUTO', managementConfirmed: true });
    assert.equal(unknown.status, 'NEEDS_CONFIRMATION');
    assert.equal(unknown.result.stage, 'publish_unconfirmed');
    assert.equal(unknown.result.submissionStatus, 'UNKNOWN');
    adapter.waitForPublishSignal = async () => ({ confirmed: true, source: 'success-url' });
    const confirmed = await adapter.publish({ materialPath, publishMode: 'AUTO', managementConfirmed: true });
    assert.equal(confirmed.status, 'SUCCESS');
    assert.equal(confirmed.result.stage, 'published');
    assert.equal(confirmed.result.submissionStatus, 'SUBMITTED');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('视频号服务端只接受带可靠平台回执的 SUBMITTED 结果', () => {
  const payload = { platformCode: 'wechat_channels' };
  assert.equal(hasReliablePublishEvidence(payload, { stage: 'published' }, 'SUCCESS'), false);
  assert.equal(hasReliablePublishEvidence(payload, { stage: 'published', submissionStatus: 'SUBMITTED', evidencePath: 'proof.json', screenshotPath: 'proof.png', publishSignal: { confirmed: false, source: null } }, 'SUCCESS'), false);
  assert.equal(hasReliablePublishEvidence(payload, { stage: 'published', submissionStatus: 'SUBMITTED', evidencePath: 'proof.json', screenshotPath: 'proof.png', publishSignal: { confirmed: true, source: 'success-url' } }, 'SUCCESS'), true);
});

test('核验页找不到稿件时不能只凭 submittedAt 标记为已提交', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-verify-unconfirmed-'));
  try {
    const adapter = new WechatChannelsAssistedRpaAdapter({ platformCode: 'wechat_channels', logsDir: path.join(dir, 'logs'), profileDir: path.join(dir, 'profile'), executablePath: '', loginTimeoutMs: 1, sendTimeoutMs: 1 });
    adapter.spec = { ...adapter.spec, verifyTabs: [], verifyRecordTimeoutMs: 0 };
    const emptyTextMatches = { async count() { return 0; }, nth() { return this; } };
    const page = {
      async goto() {},
      async waitForTimeout() {},
      getByText() { return emptyTextMatches; }
    };
    adapter.getPage = async () => page;
    adapter.waitForDetectedPageState = async () => 'READY';
    adapter.evidence = async (_payload, message, _page, stage, extra = {}) => ({ message, stage, ...extra });

    const unknown = await adapter.verifyPublish({
      title: '网络失败后不存在的稿件',
      submittedAt: '2026-08-20T08:22:54.000Z',
      submissionStatus: 'UNKNOWN',
      submissionConfirmed: false
    });
    assert.equal(unknown.status, 'NEEDS_CONFIRMATION');
    assert.equal(unknown.result.reviewStatus, 'UNKNOWN');
    assert.equal(unknown.result.submissionStatus, 'UNKNOWN');
    assert.equal(unknown.result.syncPending, false);

    const confirmed = await adapter.verifyPublish({
      title: '平台已确认但暂未同步的稿件',
      submittedAt: '2026-08-20T08:22:54.000Z',
      submissionStatus: 'SUBMITTED',
      submissionConfirmed: true
    });
    assert.equal(confirmed.status, 'SUCCESS');
    assert.equal(confirmed.result.reviewStatus, 'SYNCING');
    assert.equal(confirmed.result.submissionStatus, 'SUBMITTED');
    assert.equal(confirmed.result.syncPending, true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Management review requires a title-matched record', () => {
  const title = '\u793e\u533a\u6d3b\u52a8\u62a5\u540d\u6d41\u7a0b\u6307\u5357-20260806204043';
  const globalTabsOnly = classifyManagementReviewEvidence({
    title,
    recordText: '\u5168\u90e8 \u5df2\u53d1\u5e03 \u5ba1\u6838\u4e2d \u672a\u901a\u8fc7 \u6ca1\u6709\u66f4\u591a\u4f5c\u54c1',
    spec: PLATFORM_ASSISTED_SPECS.douyin
  });
  assert.equal(globalTabsOnly, 'UNKNOWN');
  assert.equal(classifyManagementReviewEvidence({ title, recordText: `${title} \u5ba1\u6838\u4e2d`, tabStatus: 'REVIEWING', spec: PLATFORM_ASSISTED_SPECS.douyin }), 'REVIEWING');
  assert.equal(classifyManagementReviewEvidence({ title, recordText: `${title} \u5ba1\u6838\u672a\u901a\u8fc7`, tabStatus: 'REJECTED', spec: PLATFORM_ASSISTED_SPECS.douyin }), 'REJECTED');
  assert.equal(classifyManagementReviewEvidence({ title, recordText: `${title} \u53d1\u5e03\u65f6\u95f4 2026-08-06`, tabStatus: 'PUBLISHED', spec: PLATFORM_ASSISTED_SPECS.douyin }), 'PUBLISHED');
  assert.equal(classifyManagementReviewEvidence({ title: '\u793e\u533a\u6d3b\u52a8\u62a5\u540d\u6307\u5357', recordText: '\u793e\u533a\u6d3b\u52a8\u62a5\u540d\u6307\u5357 \u793e\u533a\u6d3b\u52a8\u62a5\u540d\u5f00\u653e\u4e2d 2026\u5e7408\u670807\u65e5 08:59 0 0 0 0 0', spec: PLATFORM_ASSISTED_SPECS.wechat_channels }), 'PUBLISHED');
});

test('视频号管理页可用正文作为稿件身份，其他平台仍只按标题核验', () => {
  const title = '一人有限公司OPC社区';
  const body = 'OPC社区，邀你一起共创一人有限公司';
  assert.deepEqual(
    managementRecordIdentityCandidates({ platformCode: 'wechat_channels', title, body, spec: PLATFORM_ASSISTED_SPECS.wechat_channels }).map(item => [item.kind, item.text]),
    [['TITLE', title], ['BODY', body]]
  );
  assert.deepEqual(
    managementRecordIdentityCandidates({ platformCode: 'douyin', title, body, spec: PLATFORM_ASSISTED_SPECS.douyin }).map(item => item.kind),
    ['TITLE']
  );
  assert.deepEqual(
    managementRecordIdentityCandidates({ platformCode: 'wechat_channels', title, body: '可以吗', spec: PLATFORM_ASSISTED_SPECS.wechat_channels }).map(item => item.kind),
    ['TITLE']
  );
});

test('视频号管理页按正文命中已发布记录，同时校验提交时间', () => {
  const result = assessManagementPublishRecord({
    platformCode: 'wechat_channels',
    title: '一人有限公司OPC社区',
    body: 'OPC社区，邀你一起共创一人有限公司',
    identityText: 'OPC社区，邀你一起共创一人有限公司',
    identityKind: 'BODY',
    recordText: 'OPC社区，邀你一起共创一人有限公司 2026年08月20日 17:03 0 0 0 0 0',
    submittedAt: '2026-08-20T08:59:14.320Z',
    spec: PLATFORM_ASSISTED_SPECS.wechat_channels,
    exactIdentityLabel: true
  });
  assert.equal(result.matched, true);
  assert.equal(result.reviewStatus, 'PUBLISHED');
  assert.equal(result.identityKind, 'BODY');
  assert.ok(result.matchedBy.includes('EXACT_BODY_LABEL'));
  assert.ok(result.matchedBy.includes('PUBLISHED_AT'));
  assert.equal(result.confidence, 'HIGH');
});

test('视频号管理页正文查找只接受记录卡片，并对多条候选保持歧义', async () => {
  const title = '一人有限公司OPC社区';
  const body = 'OPC社区，邀你一起共创一人有限公司';
  const empty = { async count() { return 0; }, nth() { return this; } };
  const makePage = details => ({
    getByText(text) {
      if (text !== body) return empty;
      return {
        async count() { return details.length; },
        nth(index) {
          return {
            async isVisible() { return true; },
            async evaluate() { return details[index]; }
          };
        }
      };
    }
  });
  const record = {
    text: `${body} 2026年08月20日 17:03 0 0 0 0 0`,
    href: null,
    recordKey: 'path:0.1.0',
    hasRecordSignal: true,
    hasRecordStructure: true,
    exactIdentityLabel: true,
    identityLabelStartsRecord: true
  };
  const matched = await findVisibleTitleRecord(makePage([record]), title, {
    platformCode: 'wechat_channels', body, submittedAt: '2026-08-20T08:59:14.320Z', spec: PLATFORM_ASSISTED_SPECS.wechat_channels
  });
  assert.equal(matched.reviewStatus, 'PUBLISHED');
  assert.equal(matched.identityKind, 'BODY');

  const ambiguous = await findVisibleTitleRecord(makePage([
    record,
    { ...record, recordKey: 'path:0.2.0' }
  ]), title, {
    platformCode: 'wechat_channels', body, submittedAt: '2026-08-20T08:59:14.320Z', spec: PLATFORM_ASSISTED_SPECS.wechat_channels
  });
  assert.equal(ambiguous.ambiguous, true);
  assert.equal(ambiguous.candidateCount, 2);

  const unrelatedPage = await findVisibleTitleRecord(makePage([null]), title, {
    platformCode: 'wechat_channels', body, submittedAt: '2026-08-20T08:59:14.320Z', spec: PLATFORM_ASSISTED_SPECS.wechat_channels
  });
  assert.equal(unrelatedPage, null);
});

test('视频号正文匹配不会把提交前的旧视频认成当前稿件', () => {
  const stale = assessManagementPublishRecord({
    platformCode: 'wechat_channels',
    title: '一人有限公司OPC社区',
    body: 'OPC社区，邀你一起共创一人有限公司',
    identityText: 'OPC社区，邀你一起共创一人有限公司',
    identityKind: 'BODY',
    recordText: 'OPC社区，邀你一起共创一人有限公司 2026年08月19日 17:03 0 0 0 0 0',
    submittedAt: '2026-08-20T08:59:14.320Z',
    tabStatus: 'PUBLISHED',
    spec: PLATFORM_ASSISTED_SPECS.wechat_channels,
    exactIdentityLabel: true
  });
  assert.equal(stale.matched, false);
  assert.equal(stale.reason, 'RECORD_BEFORE_SUBMISSION');
});

test('Platform review matcher combines platform-specific title, body, time and post identity evidence', () => {
  const submittedAt = '2026-08-14T01:15:00.000Z';
  const wechat = assessManagementPublishRecord({
    platformCode: 'wechat_channels',
    title: '\u89c6\u9891\u53f7\u590d\u6838\u6807\u9898',
    body: '\u8fd9\u662f\u7528\u4e8e\u590d\u6838\u7684\u6b63\u6587\u5185\u5bb9\uff0c\u540e\u7eed\u8fd8\u6709\u66f4\u591a\u6587\u5b57',
    recordText: '\u89c6\u9891\u53f7\u590d\u6838\u6807\u9898 \u8fd9\u662f\u7528\u4e8e\u590d\u6838\u7684\u6b63\u6587\u5185\u5bb9\uff0c\u540e\u7eed\u8fd8\u6709\u66f4\u591a\u6587\u5b57 2026\u5e7408\u670814\u65e5 09:19',
    href: 'https://channels.weixin.qq.com/platform/post/list?id=wx-post-1',
    submittedAt,
    tabStatus: 'PUBLISHED',
    spec: PLATFORM_ASSISTED_SPECS.wechat_channels,
    titleLabelStartsRecord: true
  });
  assert.equal(wechat.matched, true);
  assert.equal(wechat.reviewStatus, 'PUBLISHED');
  assert.ok(wechat.matchedBy.includes('BODY_PREFIX'));
  assert.ok(wechat.matchedBy.includes('PUBLISHED_AT'));
  assert.equal(wechat.platformPostId, 'wx-post-1');
  assert.equal(wechat.confidence, 'HIGH');

  const stale = assessManagementPublishRecord({
    platformCode: 'douyin',
    title: '\u540c\u540d\u6296\u97f3\u4f5c\u54c1',
    recordText: '\u540c\u540d\u6296\u97f3\u4f5c\u54c1 2026\u5e7408\u670813\u65e5 09:19',
    submittedAt,
    tabStatus: 'PUBLISHED',
    spec: PLATFORM_ASSISTED_SPECS.douyin,
    exactTitleLabel: true
  });
  assert.equal(stale.matched, false);
  assert.equal(stale.reason, 'RECORD_BEFORE_SUBMISSION');
});




test('\u505c\u7528\u5e73\u53f0\u5728\u8fd0\u884c\u603b\u89c8\u663e\u793a\u5df2\u505c\u7528\uff0c\u4e0d\u5192\u5145\u65e0\u6cd5\u786e\u8ba4', () => {
  const appSource = fs.readFileSync(path.resolve(import.meta.dirname, '../public/app.js'), 'utf8');
  const cssSource = fs.readFileSync(path.resolve(import.meta.dirname, '../public/styles.css'), 'utf8');
  assert.match(appSource, /enabled===0\|\|account\?\.login_status==='DISABLED'/);
  assert.match(appSource, /DISABLED:\{text:'\\u5df2\\u505c\\u7528',cls:'disabled'\}/);
  assert.match(appSource, /accountLoginDetail\(account\)/);
  assert.match(cssSource, /\.badge\.disabled\{/);
});


test('Douyin comment readiness clicks the explicit refresh once before treating the list as empty', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-comment-refresh-'));
  try {
    const adapter = new DouyinAssistedRpaAdapter({ platformCode: 'douyin', logsDir: dir, profileDir: path.join(dir, 'profile'), executablePath: '', loginTimeoutMs: 1000, sendTimeoutMs: 1000 });
    const empty = { async count() { return 0; }, nth() { return this; }, async isVisible() { return false; } };
    const page = {
      state: 'refresh', refreshClicks: 0,
      locator(selector) {
        if (selector === 'body') return { async innerText() { return page.state === 'refresh' ? '\u8bc4\u8bba\u7ba1\u7406 \u6682\u65e0\u8bc4\u8bba \u70b9\u51fb\u5237\u65b0' : '\u8bc4\u8bba\u7ba1\u7406 \u5df2\u52a0\u8f7d\u8bc4\u8bba'; } };
        if (selector.includes('a,button,input')) return { async evaluateAll() { return []; } };
        return empty;
      },
      getByText() { return { async count() { return 1; }, nth() { return this; }, async isVisible() { return true; }, async isEnabled() { return true; }, async evaluate() { return true; }, async click() { page.refreshClicks += 1; page.state = 'rows'; } }; },
      getByRole() { return empty; },
      async waitForTimeout() {}
    };
    adapter.classifyLiveMessagePage = async () => ({ valid: true, reason: 'VERIFIED' });
    adapter.firstVisibleSelector = async () => page.state === 'rows' ? adapter.spec.commentReadySelectors[0] : null;
    const result = await adapter.waitForMessageContentReady(page, 'COMMENT', 2000);
    assert.equal(result.ready, true);
    assert.equal(result.reason, 'COMMENT_ROWS_READY_AFTER_REFRESH');
    assert.equal(page.refreshClicks, 1);
    assert.equal(result.refreshEvidence.attempts, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Douyin comment refresh state without a scoped refresh control is not accepted as a real empty list', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-comment-refresh-missing-'));
  try {
    const adapter = new DouyinAssistedRpaAdapter({ platformCode: 'douyin', logsDir: dir, profileDir: path.join(dir, 'profile'), executablePath: '', loginTimeoutMs: 1000, sendTimeoutMs: 1000 });
    const empty = { async count() { return 0; }, nth() { return this; }, async isVisible() { return false; } };
    const page = {
      locator(selector) {
        if (selector === 'body') return { async innerText() { return '\u8bc4\u8bba\u7ba1\u7406 \u6682\u65e0\u8bc4\u8bba \u70b9\u51fb\u5237\u65b0'; } };
        if (selector.includes('a,button,input')) return { async evaluateAll() { return []; } };
        return empty;
      },
      getByText() { return empty; }, getByRole() { return empty; }, async waitForTimeout() {}
    };
    adapter.classifyLiveMessagePage = async () => ({ valid: true, reason: 'VERIFIED' });
    adapter.firstVisibleSelector = async () => null;
    const result = await adapter.waitForMessageContentReady(page, 'COMMENT', 1000);
    assert.equal(result.ready, false);
    assert.equal(result.reason, 'COMMENT_REFRESH_CONTROL_MISSING');
    assert.equal(result.refreshEvidence.offered, true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Douyin comment readiness performs one bounded reload recovery after refresh stays unresolved', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-comment-reload-recovery-'));
  try {
    const adapter = new DouyinAssistedRpaAdapter({ platformCode: 'douyin', logsDir: dir, profileDir: path.join(dir, 'profile'), executablePath: '', loginTimeoutMs: 1000, sendTimeoutMs: 1000 });
    let reloads = 0;
    let refreshCalls = 0;
    const page = {
      locator(selector) {
        if (selector === 'body') return { async innerText() { return reloads === 0 ? '\u8bc4\u8bba\u7ba1\u7406 \u6682\u65e0\u8bc4\u8bba \u70b9\u51fb\u5237\u65b0' : '\u8bc4\u8bba\u7ba1\u7406 \u9009\u62e9\u4f5c\u54c1'; } };
        if (selector.includes('a,button,input')) return { async evaluateAll() { return []; } };
        return { async count() { return 0; }, nth() { return this; }, async isVisible() { return false; } };
      },
      url() { return 'https://creator.douyin.com/creator-micro/data/following/comment'; },
      async reload() { reloads += 1; },
      async waitForTimeout() {}
    };
    adapter.classifyLiveMessagePage = async () => ({ valid: true, reason: 'VERIFIED' });
    adapter.firstVisibleSelector = async () => null;
    adapter.refreshDouyinCommentListIfOffered = async () => {
      refreshCalls += 1;
      return refreshCalls === 1
        ? { offered: true, clicked: true, attempts: 1, loaded: false, stateCleared: false, reason: 'COMMENT_REFRESH_UNRESOLVED' }
        : { offered: true, clicked: true, attempts: 1, loaded: true, stateCleared: false, rowSelector: adapter.spec.commentReadySelectors[0], reason: 'COMMENT_ROWS_READY_AFTER_REFRESH' };
    };
    const result = await adapter.waitForMessageContentReady(page, 'COMMENT', 3000);
    assert.equal(result.ready, true);
    assert.equal(result.reason, 'COMMENT_ROWS_READY_AFTER_RELOAD_REFRESH');
    assert.equal(reloads, 1);
    assert.equal(refreshCalls, 2);
    assert.equal(result.recoveryEvidence.loaded, true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Douyin comment readiness accepts a verified empty list after the bounded reload recovery', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-comment-empty-after-reload-'));
  try {
    const adapter = new DouyinAssistedRpaAdapter({ platformCode: 'douyin', logsDir: dir, profileDir: path.join(dir, 'profile'), executablePath: '', loginTimeoutMs: 1000, sendTimeoutMs: 1000 });
    const empty = { async count() { return 0; }, nth() { return this; }, async isVisible() { return false; } };
    const page = {
      locator(selector) {
        if (selector === 'body') return { async innerText() { return '\u8bc4\u8bba\u7ba1\u7406 \u6682\u65e0\u8bc4\u8bba \u70b9\u51fb\u5237\u65b0'; } };
        if (selector.includes('a,button,input')) return { async evaluateAll() { return []; } };
        return empty;
      },
      async waitForTimeout() {}
    };
    adapter.classifyLiveMessagePage = async () => ({ valid: true, reason: 'VERIFIED' });
    adapter.firstVisibleSelector = async () => null;
    adapter.refreshDouyinCommentListIfOffered = async () => ({ offered: true, clicked: true, attempts: 1, loaded: false, stateCleared: false, reason: 'COMMENT_REFRESH_UNRESOLVED' });
    adapter.recoverDouyinCommentListAfterRefresh = async () => ({ attempted: true, reloaded: true, loaded: false, stateCleared: true, reason: 'COMMENT_EMPTY_CONFIRMED_AFTER_RELOAD', pageCheck: { valid: true, reason: 'VERIFIED' } });
    const result = await adapter.waitForMessageContentReady(page, 'COMMENT', 2000);
    assert.equal(result.ready, true);
    assert.equal(result.empty, true);
    assert.equal(result.reason, 'COMMENT_EMPTY_CONFIRMED_AFTER_RELOAD');
    assert.equal(result.recoveryEvidence.reloaded, true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});


test('Douyin comment reload recovery accepts a persistent refresh action only with explicit settled empty evidence', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-comment-persistent-refresh-empty-'));
  try {
    const adapter = new DouyinAssistedRpaAdapter({ platformCode: 'douyin', logsDir: dir, profileDir: path.join(dir, 'profile'), executablePath: '', loginTimeoutMs: 1000, sendTimeoutMs: 1000 });
    let reloads = 0;
    const page = {
      locator(selector) {
        if (selector === 'body') return { async innerText() { return '\u8bc4\u8bba\u7ba1\u7406 \u6682\u65e0\u8bc4\u8bba \u70b9\u51fb\u5237\u65b0'; } };
        if (selector.includes('a,button,input')) return { async evaluateAll() { return []; } };
        return { async count() { return 0; }, nth() { return this; }, async isVisible() { return false; } };
      },
      url() { return PLATFORM_ASSISTED_SPECS.douyin.commentUrl; },
      async reload() { reloads += 1; },
      async waitForTimeout() {}
    };
    adapter.classifyLiveMessagePage = async () => ({ valid: true, reason: 'VERIFIED' });
    adapter.firstVisibleSelector = async () => null;
    const result = await adapter.recoverDouyinCommentListAfterRefresh(page, { refreshOffered: true, refreshClicked: true, settleTimeoutMs: 250 });
    assert.equal(result.reason, 'COMMENT_EMPTY_CONFIRMED_AFTER_RELOAD');
    assert.equal(result.empty, true);
    assert.equal(result.emptyState.explicitEmpty, true);
    assert.equal(result.emptyState.busy, false);
    assert.equal(result.emptyState.commentCardSelector, null);
    assert.equal(reloads, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Douyin comment reload recovery never confirms empty while a busy state remains visible', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-comment-busy-after-reload-'));
  try {
    const adapter = new DouyinAssistedRpaAdapter({ platformCode: 'douyin', logsDir: dir, profileDir: path.join(dir, 'profile'), executablePath: '', loginTimeoutMs: 1000, sendTimeoutMs: 1000 });
    const page = {
      locator(selector) {
        if (selector === 'body') return { async innerText() { return '\u8bc4\u8bba\u7ba1\u7406 \u6682\u65e0\u8bc4\u8bba \u52a0\u8f7d\u4e2d'; } };
        if (selector.includes('a,button,input')) return { async evaluateAll() { return []; } };
        return { async count() { return 0; }, nth() { return this; }, async isVisible() { return false; } };
      },
      url() { return PLATFORM_ASSISTED_SPECS.douyin.commentUrl; },
      async reload() {},
      async waitForTimeout() {}
    };
    adapter.classifyLiveMessagePage = async () => ({ valid: true, reason: 'VERIFIED' });
    adapter.firstVisibleSelector = async () => null;
    const result = await adapter.recoverDouyinCommentListAfterRefresh(page, { refreshOffered: true, refreshClicked: true, settleTimeoutMs: 250 });
    assert.equal(result.reason, 'COMMENT_RECOVERY_BUSY_STATE');
    assert.notEqual(result.reason, 'COMMENT_EMPTY_CONFIRMED_AFTER_RELOAD');
    assert.equal(result.emptyState.busy, true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Douyin comment reload recovery treats a visible comment card as loaded, never as empty', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-comment-card-after-reload-'));
  try {
    const adapter = new DouyinAssistedRpaAdapter({ platformCode: 'douyin', logsDir: dir, profileDir: path.join(dir, 'profile'), executablePath: '', loginTimeoutMs: 1000, sendTimeoutMs: 1000 });
    const page = {
      locator(selector) {
        if (selector === 'body') return { async innerText() { return '\u8bc4\u8bba\u7ba1\u7406 \u6682\u65e0\u8bc4\u8bba \u70b9\u51fb\u5237\u65b0'; } };
        if (selector.includes('a,button,input')) return { async evaluateAll() { return []; } };
        return { async count() { return 0; }, nth() { return this; }, async isVisible() { return false; } };
      },
      url() { return PLATFORM_ASSISTED_SPECS.douyin.commentUrl; },
      async reload() {},
      async waitForTimeout() {}
    };
    adapter.classifyLiveMessagePage = async () => ({ valid: true, reason: 'VERIFIED' });
    adapter.firstVisibleSelector = async (_page, selectors) => selectors === adapter.spec.commentReadySelectors ? adapter.spec.commentReadySelectors[0] : null;
    const result = await adapter.recoverDouyinCommentListAfterRefresh(page, { refreshOffered: true, refreshClicked: true, settleTimeoutMs: 250 });
    assert.equal(result.loaded, true);
    assert.equal(result.reason, 'COMMENT_ROWS_READY_AFTER_RELOAD');
    assert.notEqual(result.reason, 'COMMENT_EMPTY_CONFIRMED_AFTER_RELOAD');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Douyin comment reload recovery refuses empty success when refresh was not actually clicked', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-comment-refresh-not-clicked-'));
  try {
    const adapter = new DouyinAssistedRpaAdapter({ platformCode: 'douyin', logsDir: dir, profileDir: path.join(dir, 'profile'), executablePath: '', loginTimeoutMs: 1000, sendTimeoutMs: 1000 });
    let reloads = 0;
    const page = {
      url() { return PLATFORM_ASSISTED_SPECS.douyin.commentUrl; },
      async reload() { reloads += 1; }
    };
    const result = await adapter.recoverDouyinCommentListAfterRefresh(page, { refreshOffered: true, refreshClicked: false });
    assert.equal(result.reason, 'COMMENT_RECOVERY_REFRESH_NOT_CLICKED');
    assert.equal(result.attempted, false);
    assert.equal(reloads, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Douyin comment reload recovery refuses empty success when the reloaded page identity is invalid', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-comment-invalid-page-after-reload-'));
  try {
    const adapter = new DouyinAssistedRpaAdapter({ platformCode: 'douyin', logsDir: dir, profileDir: path.join(dir, 'profile'), executablePath: '', loginTimeoutMs: 1000, sendTimeoutMs: 1000 });
    const page = {
      url() { return PLATFORM_ASSISTED_SPECS.douyin.commentUrl; },
      async reload() {},
      async waitForTimeout() {}
    };
    adapter.classifyLiveMessagePage = async () => ({ valid: false, reason: 'MESSAGE_TEXT_MISMATCH' });
    const result = await adapter.recoverDouyinCommentListAfterRefresh(page, { refreshOffered: true, refreshClicked: true });
    assert.equal(result.reason, 'COMMENT_RECOVERY_MESSAGE_TEXT_MISMATCH');
    assert.equal(result.reloaded, true);
    assert.notEqual(result.reason, 'COMMENT_EMPTY_CONFIRMED_AFTER_RELOAD');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Douyin private-message collection continues when comment page needs confirmation', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-collect-partial-'));
  try {
    const adapter = new DouyinAssistedRpaAdapter({ platformCode: 'douyin', logsDir: dir, profileDir: path.join(dir, 'profile'), executablePath: '', loginTimeoutMs: 1000, sendTimeoutMs: 1000 });
    let activeType = null;
    const page = {
      locator(selector) {
        if (selector === 'body') return { async innerText() { return activeType === 'COMMENT' ? '\u8bc4\u8bba\u7ba1\u7406' : '\u79c1\u4fe1 \u6d88\u606f'; } };
        if (selector.includes('a,button,input')) return { async evaluateAll() { return []; } };
        return { async count() { return 0; }, nth() { return this; }, async isVisible() { return false; } };
      },
      url() { return activeType === 'COMMENT' ? adapter.spec.commentUrl : adapter.spec.messageUrl; }
    };
    adapter.getPage = async () => page;
    adapter.prepareMessagePage = async (_page, item) => { activeType = item.type; return { requestedUrl: item.url, finalUrl: item.url, attempts: 1 }; };
    adapter.inspectLoginState = async () => ({ state: 'READY', evidence: ['authenticated'] });
    adapter.waitForMessageContentReady = async (_page, type) => type === 'COMMENT'
      ? { ready: false, reason: 'COMMENT_REFRESH_UNRESOLVED', pageCheck: { valid: true, reason: 'VERIFIED' }, refreshEvidence: { clicked: true }, recoveryEvidence: { reloaded: true } }
      : { ready: true, reason: 'PRIVATE_PANEL_READY', pageCheck: { valid: true, reason: 'VERIFIED_DOM' } };
    adapter.extractMessages = async (_page, type) => type === 'PRIVATE_MESSAGE' ? [{ messageType: 'PRIVATE_MESSAGE', externalId: 'private-1', userName: '\u7528\u6237A', content: '\u8bf7\u95ee\u793e\u533a\u7535\u8bdd' }] : [];
    adapter.inspectPrivateMessageCoverage = async () => ({ strangerUnread: false });
    adapter.evidence = async (_payload, message, _page, stage, extra = {}) => ({ message, stage, evidencePath: path.join(dir, `${stage}.json`), screenshotPath: path.join(dir, `${stage}.png`), ...extra });
    const result = await adapter.collectMessages({ types: ['COMMENT', 'PRIVATE_MESSAGE'], profileName: 'profile-douyin-main' });
    assert.equal(result.status, 'NEEDS_CONFIRMATION');
    assert.equal(result.result.messages.length, 1);
    assert.equal(result.result.messages[0].messageType, 'PRIVATE_MESSAGE');
    assert.equal(result.result.typeResults.find(item => item.type === 'COMMENT').status, 'NEEDS_CONFIRMATION');
    assert.equal(result.result.typeResults.find(item => item.type === 'PRIVATE_MESSAGE').status, 'SUCCESS');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Douyin exact comment locator rejects multiple identical live targets', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-comment-ambiguous-'));
  try {
    const adapter = new DouyinAssistedRpaAdapter({ platformCode: 'douyin', logsDir: dir, profileDir: path.join(dir, 'profile'), executablePath: '', loginTimeoutMs: 1000, sendTimeoutMs: 1000 });
    const rows = { async count() { return 2; }, nth(index) { return { index, async isVisible() { return true; } }; } };
    const payload = { messageType: 'COMMENT', userName: '\u7528\u6237A', sourceContent: '\u540c\u4e00\u6761\u8bc4\u8bba', messageContext: { eventTime: '22:37' } };
    adapter.readDouyinCommentCandidate = async () => ({ userName: '\u7528\u6237A', content: '\u540c\u4e00\u6761\u8bc4\u8bba', eventTime: '22:37' });
    const result = await adapter.locateMessageContainer({ locator() { return rows; } }, payload);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'COMMENT_TARGET_AMBIGUOUS');
    assert.equal(result.candidates.length, 2);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Douyin private reply stops before editor access when the exact conversation audit fails', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-private-target-stop-'));
  try {
    const adapter = new DouyinAssistedRpaAdapter({ platformCode: 'douyin', logsDir: dir, profileDir: path.join(dir, 'profile'), executablePath: '', loginTimeoutMs: 1000, sendTimeoutMs: 1000 });
    adapter.getPage = async () => ({});
    adapter.openPrivateConversationForPayload = async () => ({ ok: false, reason: 'CONVERSATION_HEADER_MISMATCH' });
    adapter.findReplyEditor = async () => { throw new Error('editor must not be inspected'); };
    adapter.evidence = async (_payload, message, _page, stage, extra = {}) => ({ message, stage, ...extra });
    const result = await adapter.replyToMessage({ platformCode: 'douyin', accountId: 'test-account', messageType: 'PRIVATE_MESSAGE', userName: '\u7528\u6237A', sourceContent: '\u539f\u59cb\u79c1\u4fe1', replyText: '\u56de\u590d\u6587\u672c', messageContext: { conversationId: 'conversation-A', messageId: 'message-A', direction: 'incoming', previewOnly: false, sourceVerified: true, chatTitleVerified: true } });
    assert.equal(result.status, 'NEEDS_CONFIRMATION');
    assert.equal(result.result.stage, 'reply_target_missing');
    assert.equal(result.result.target.reason, 'CONVERSATION_HEADER_MISMATCH');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Douyin reply cannot succeed from an exact echo outside the scoped private conversation evidence', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-private-scoped-echo-'));
  try {
    const adapter = new DouyinAssistedRpaAdapter({ platformCode: 'douyin', logsDir: dir, profileDir: path.join(dir, 'profile'), executablePath: '', loginTimeoutMs: 1000, sendTimeoutMs: 1000 });
    let editorValue = '';
    const editor = {
      async click() {},
      async evaluate() { return 'textarea'; },
      async fill(value) { editorValue = value; },
      async inputValue() { return editorValue; },
      async boundingBox() { return { x: 600, width: 300 }; }
    };
    const page = { getByText() { throw new Error('global page echo must not be used for Douyin success'); } };
    adapter.getPage = async () => page;
    adapter.openPrivateConversationForPayload = async () => ({ ok: true, headerName: '\u7528\u6237A', sourceMessageCount: 1 });
    adapter.revalidatePrivateReplyTarget = async () => ({ ok: true, reason: 'MOCK_TARGET_STABLE' });
    adapter.findReplyEditor = async () => editor;
    adapter.countExactPrivateMessages = async () => ({ count: 0, matches: [] });
    adapter.clickPrivateSend = async () => { editorValue = ''; return { clicked: true, method: 'scoped-selector:.e2e-send-msg-btn' }; };
    adapter.waitForReplyEvidence = async check => check();
    adapter.evidence = async (_payload, message, _page, stage, extra = {}) => ({ message, stage, ...extra });
    const result = await adapter.replyToMessage({ platformCode: 'douyin', accountId: 'test-account', messageType: 'PRIVATE_MESSAGE', userName: '\u7528\u6237A', sourceContent: '\u539f\u59cb\u79c1\u4fe1', replyText: '\u7cbe\u786e\u56de\u590d', messageContext: { conversationId: 'conversation-A', messageId: 'message-A', direction: 'incoming', previewOnly: false, sourceVerified: true, chatTitleVerified: true } });
    assert.equal(result.status, 'NEEDS_CONFIRMATION');
    assert.equal(result.result.stage, 'reply_unconfirmed');
    assert.equal(result.result.scopedEchoCount, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});


test('B\u7ad9\u8bc4\u8bba\u91c7\u96c6\u4f7f\u7528\u901a\u77e5 ID \u751f\u6210\u7a33\u5b9a externalId', () => {
  const messages = parseBilibiliCommentFeed({ code: 0, data: { items: [{
    id: 9988, reply_time: 1786000000, user: { mid: 22, nickname: '\u6d4b\u8bd5\u7528\u6237' },
    item: { source_content: '\u8bf7\u95ee\u51e0\u70b9\u4e0a\u73ed\uff1f', subject_id: 123, business_id: 1, root_id: 456, source_id: 789, target_id: 456, uri: 'https://www.bilibili.com/video/BV1xx' }
  }] } });
  assert.equal(messages.length, 1);
  assert.equal(messages[0].externalId, 'bili-comment:9988');
  assert.equal(messages[0].userName, '\u6d4b\u8bd5\u7528\u6237');
  assert.equal(messages[0].content, '\u8bf7\u95ee\u51e0\u70b9\u4e0a\u73ed\uff1f');
  assert.equal(messages[0].context.oid, '123');
  assert.equal(messages[0].context.root, '456');
  assert.equal(messages[0].context.parent, '789');
});

test('B\u7ad9\u79c1\u4fe1\u91c7\u96c6\u53ea\u4fdd\u7559\u5bf9\u65b9\u53d1\u9001\u7684\u672a\u8bfb\u6587\u672c\u6d88\u606f', () => {
  const sessionsResponse = { code: 0, data: { session_list: [{ talker_id: 22, session_type: 1, unread_count: 1, ack_seqno: 10 }] } };
  const messageResponses = { 22: { code: 0, data: { messages: [
    { sender_uid: 22, receiver_id: 99, msg_type: 1, content: '{"content":"\u5df2\u8bfb\u65e7\u6d88\u606f"}', msg_seqno: 9, msg_key: 900, timestamp: 100 },
    { sender_uid: 99, receiver_id: 22, msg_type: 1, content: '{"content":"\u6211\u65b9\u6d88\u606f"}', msg_seqno: 11, msg_key: 901, timestamp: 101 },
    { sender_uid: 22, receiver_id: 99, msg_type: 2, content: '{}', msg_seqno: 12, msg_key: 902, timestamp: 102 },
    { sender_uid: 22, receiver_id: 99, msg_type: 1, content: '{"content":"\u65b0\u672a\u8bfb\u6d88\u606f"}', msg_seqno: 13, msg_key: 903, timestamp: 103 }
  ] } } };
  const messages = parseBilibiliPrivateFeed({ sessionsResponse, messageResponses, selfUid: '99' });
  assert.deepEqual(messages.map(item => item.content), ['\u65b0\u672a\u8bfb\u6d88\u606f']);
  assert.equal(messages[0].externalId, 'bili-private:903');
  assert.equal(messages[0].context.previewOnly, false);
});


test('B\u7ad9API\u91c7\u96c6\u7ed3\u679c\u80fd\u901a\u8fc7\u7edf\u4e00\u81ea\u52a8\u56de\u590d\u8d44\u683c\u68c0\u67e5', () => {
  const comment = parseBilibiliCommentFeed({ code: 0, data: { items: [{
    id: 10001, user: { mid: 22, nickname: '\u8bc4\u8bba\u7528\u6237' },
    item: { source_content: '\u600e\u4e48\u62a5\u540d\uff1f', subject_id: 123, business_id: 1, root_id: 456, source_id: 789, target_id: 456 }
  }] } })[0];
  const privateMessage = parseBilibiliPrivateFeed({
    sessionsResponse: { code: 0, data: { session_list: [{ talker_id: 22, session_type: 1, unread_count: 1, ack_seqno: 10 }] } },
    messageResponses: { 22: { code: 0, data: { messages: [{ sender_uid: 22, receiver_id: 99, msg_type: 1, content: '{"content":"\u600e\u4e48\u52a0\u5165\uff1f"}', msg_seqno: 11, msg_key: 903, timestamp: 103 }] } } },
    selfUid: '99'
  })[0];
  const commentEligibility = assessAutoReplyEligibility({ platformCode: 'bilibili', accountId: 4, messageType: 'COMMENT', sourceContent: comment.content, userName: comment.userName, messageContext: comment.context, contentOwnership: { verified: true, reason: 'PUBLISH_TARGET_MATCHED' } });
  const privateEligibility = assessAutoReplyEligibility({ platformCode: 'bilibili', accountId: 4, messageType: 'PRIVATE_MESSAGE', sourceContent: privateMessage.content, userName: privateMessage.userName, messageContext: privateMessage.context });
  assert.equal(commentEligibility.allowed, true);
  assert.equal(privateEligibility.allowed, true);
});

test('B\u7ad9\u8bc4\u8bba\u548c\u79c1\u4fe1\u56de\u590d\u8868\u5355\u5fc5\u987b\u643a\u5e26 CSRF \u4e0e\u7cbe\u786e\u76ee\u6807 ID', () => {
  const comment = buildBilibiliCommentReplyForm({ replyText: '\u6536\u5230', messageContext: { oid: '123', replyType: '1', root: '456', parent: '789' } }, 'csrf-token');
  assert.deepEqual(comment, { oid: '123', type: '1', message: '\u6536\u5230', root: '456', parent: '789', plat: '1', csrf: 'csrf-token', csrf_token: 'csrf-token' });
  const privateForm = buildBilibiliPrivateReplyForm({ replyText: '\u6536\u5230', messageContext: { talkerId: '22' } }, 'csrf-token', '99', 123456, 'device-id');
  assert.equal(privateForm['msg[sender_uid]'], '99');
  assert.equal(privateForm['msg[receiver_id]'], '22');
  assert.equal(privateForm['msg[content]'], '{"content":"\u6536\u5230"}');
  assert.equal(privateForm.csrf_token, 'csrf-token');
});

test('B\u7ad9 API \u56de\u590d\u53ea\u6709\u53d6\u5f97\u5e73\u53f0\u6d88\u606f ID \u624d\u8fd4\u56de SUCCESS', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-reply-receipt-'));
  try {
    const adapter = new BilibiliAssistedRpaAdapter({ profileDir: path.join(dir, 'profile'), executablePath: 'chrome', logsDir: path.join(dir, 'logs'), loginTimeoutMs: 1, sendTimeoutMs: 1 });
    adapter.getPage = async () => ({});
    adapter.auth = async () => ({ csrf: 'csrf-token', selfUid: '99' });
    adapter.apiPost = async () => ({ code: 0, data: { msg_key: 998877 } });
    adapter.evidence = async (_payload, message, _page, stage, extra = {}) => ({ message, stage, ...extra });
    const sent = await adapter.replyToMessage({ messageType: 'PRIVATE_MESSAGE', replyText: '\u6536\u5230', messageContext: { talkerId: '22' } });
    assert.equal(sent.status, 'SUCCESS');
    assert.equal(sent.result.stage, 'reply_sent');
    assert.equal(sent.result.platformMessageId, '998877');
    assert.equal(sent.result.verified, true);

    adapter.apiPost = async () => ({ code: 0, data: {} });
    const uncertain = await adapter.replyToMessage({ messageType: 'PRIVATE_MESSAGE', replyText: '\u6536\u5230', messageContext: { talkerId: '22' } });
    assert.equal(uncertain.status, 'NEEDS_CONFIRMATION');
    assert.equal(uncertain.result.stage, 'reply_unconfirmed');
    assert.equal(uncertain.result.verified, false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('B站没有确认草稿时，Web 不得显示草稿已保留', () => {
  const appSource = fs.readFileSync(path.resolve(import.meta.dirname, '../public/app.js'), 'utf8');
  assert.match(appSource, /当前没有确认到B站草稿/);
  assert.match(appSource, /草稿创建未完成/);
  assert.doesNotMatch(appSource, /result\.stage==='existing_draft_blocked'\|\|target\.publish_attempt_state==='DRAFT_BLOCKED'\)label='未提交：检测到遗留草稿，已安全保留'/);
  assert.doesNotMatch(appSource, /result\.draftPreservedInBrowser===true\|\|target\.publish_attempt_state==='DRAFT_BLOCKED'\)label='自动发布未成功，草稿已保留，需要人工处理'/);
});

test('B站发布会识别已有未提交视频草稿', () => {
  assert.deepEqual(detectBilibiliPendingDraft('本地浏览器存在1个未提交的视频 继续编辑 不用了'), { blocked: true, count: 1 });
  assert.deepEqual(detectBilibiliPendingDraft('上传视频 稿件标题 视频简介'), { blocked: false, count: null });
});

test('B站存在未提交草稿时不上传新素材，也不点击草稿按钮', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-existing-draft-'));
  const materialPath = path.join(dir, 'test.mp4');
  fs.writeFileSync(materialPath, Buffer.from('safe-test-placeholder'));
  try {
    const adapter = new BilibiliAssistedRpaAdapter({ profileDir: path.join(dir, 'profile'), executablePath: 'chrome', logsDir: path.join(dir, 'logs'), loginTimeoutMs: 1, sendTimeoutMs: 1 });
    let uploadAttempted = false;
    let clicked = false;
    const textLocator = {
      async count() { return 1; },
      nth() { return this; },
      async isVisible() { return true; },
      async isEnabled() { return true; },
      async click() { clicked = true; }
    };
    const page = {
      async goto() {},
      locator(selector) { return selector === 'body' ? { async innerText() { return '本地浏览器存在1个未提交的视频 继续编辑 不用了'; } } : textLocator; },
      getByText() { return textLocator; }
    };
    adapter.getPage = async () => page;
    adapter.waitForReady = async () => true;
    adapter.prepareDraft = async () => { uploadAttempted = true; return {}; };
    adapter.evidence = async (_payload, message, _page, stage, extra = {}) => ({ message, stage, ...extra });
    const result = await adapter.publish({ materialPath, publishMode: 'DRAFT_ONLY', contentOrigin: 'HUMAN_ORIGINAL' });
    assert.equal(result.status, 'NEEDS_CONFIRMATION');
    assert.equal(result.result.stage, 'existing_draft_blocked');
    assert.equal(result.result.draftProtected, true);
    assert.equal(result.result.uploadAttempted, false);
    assert.equal(uploadAttempted, false);
    assert.equal(clicked, false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('five_platform_assisted \u4e3a B\u7ad9\u548c\u5fae\u535a\u6ce8\u518c\u5404\u81ea\u4e13\u7528\u9002\u914d\u5668', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-registry-'));
  try {
    const platforms = Object.fromEntries(['douyin','wechat_channels','bilibili','weibo'].map(code => [code, { profileDir: path.join(dir, code), executablePath: 'chrome', loginTimeoutMs: 1, sendTimeoutMs: 1 }]));
    const registry = createRpaRegistry({ mode: 'five_platform_assisted', logsDir: path.join(dir, 'logs'), xiaohongshu: { profileDir: path.join(dir, 'xhs'), executablePath: 'chrome' }, platforms });
    assert.ok(registry.get('bilibili') instanceof BilibiliAssistedRpaAdapter);
    assert.ok(registry.get('weibo') instanceof WeiboAssistedRpaAdapter);
    for (const code of ['douyin','wechat_channels']) {
      assert.ok(registry.get(code) instanceof AssistedPlatformRpaAdapter);
      assert.equal(registry.get(code) instanceof BilibiliAssistedRpaAdapter, false);
      assert.equal(registry.get(code) instanceof WeiboAssistedRpaAdapter, false);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

function makeWechatTestLocator({ text = '', visible = true, enabled = true, onClick = null, evaluateValue = null } = {}) {
  return {
    async count() { return visible ? 1 : 0; },
    nth() { return this; },
    first() { return this; },
    async isVisible() { return visible; },
    async isEnabled() { return enabled; },
    async innerText() { return text; },
    async textContent() { return text; },
    async click() { if (onClick) onClick(); },
    async evaluate() { return evaluateValue ?? true; }
  };
}

test('\u89c6\u9891\u53f7\u6d88\u606f\u5165\u53e3\u4e0e\u9875\u9762\u4fe1\u53f7\u4e25\u683c\u7ed1\u5b9a\u5b98\u65b9 URL', () => {
  const spec = PLATFORM_ASSISTED_SPECS.wechat_channels;
  assert.equal(spec.commentUrl, 'https://channels.weixin.qq.com/platform/interaction/comment');
  assert.equal(spec.messageUrl, 'https://channels.weixin.qq.com/platform/private_msg');
  const comment = classifyMessagePageEvidence({
    messageType: 'COMMENT',
    url: spec.commentUrl,
    text: '\u8bc4\u8bba\u7ba1\u7406 \u89c6\u9891\u53f7\u52a9\u624b \u00b7 \u8bc4\u8bba \u6682\u65e0\u8bc4\u8bba',
    spec
  });
  const privateMessage = classifyMessagePageEvidence({
    messageType: 'PRIVATE_MESSAGE',
    url: spec.messageUrl,
    text: '\u79c1\u4fe1\u7ba1\u7406 \u5168\u90e8\u79c1\u4fe1 \u6682\u65e0\u79c1\u4fe1 \u89c6\u9891\u53f7\u52a9\u624b',
    spec
  });
  assert.equal(comment.valid, true);
  assert.equal(privateMessage.valid, true);
  assert.equal(classifyMessagePageEvidence({ messageType: 'COMMENT', url: spec.messageUrl, text: '\u8bc4\u8bba\u7ba1\u7406 \u6682\u65e0\u8bc4\u8bba', spec }).reason, 'URL_MISMATCH');
  assert.equal(classifyMessagePageEvidence({ messageType: 'PRIVATE_MESSAGE', url: spec.messageUrl, text: '\u5185\u5bb9\u7ba1\u7406', spec }).reason, 'PAGE_SIGNAL_MISSING');
});

test('\u89c6\u9891\u53f7\u8bc4\u8bba\u91c7\u96c6\u4f7f\u7528\u540c\u4e00\u5361\u7247\u5185\u7684\u6635\u79f0\u3001\u6b63\u6587\u548c\u65f6\u95f4', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-comment-extract-'));
  try {
    const adapter = new WechatChannelsAssistedRpaAdapter({ platformCode: 'wechat_channels', logsDir: dir, profileDir: path.join(dir, 'profile'), executablePath: '', loginTimeoutMs: 1000, sendTimeoutMs: 1000 });
    let optionsSeen = null;
    const page = {
      url() { return 'https://channels.weixin.qq.com/platform/interaction/comment'; },
      locator() { return { async evaluateAll(_fn, options) { optionsSeen = options; return [{ index: 0, text: '\u552f\u4e00\u6d4b\u8bd5\u8bc4\u8bba', userName: '\u6d4b\u8bd5\u7528\u6237', eventTime: '2026-08-06 10:00', unread: null, unreadEvidence: null, conversationKey: null, containerClassName: 'comment-item', href: null }]; } }; }
    };
    const messages = await adapter.extractMessages(page, 'COMMENT', { noteCandidates: [] });
    assert.equal(optionsSeen.structuredComment, true);
    assert.equal(optionsSeen.commentNameSelector, '.comment-user-name');
    assert.equal(optionsSeen.commentTextSelector, '.comment-content');
    assert.equal(optionsSeen.commentTimeSelector, '.comment-time');
    assert.equal(messages.length, 1);
    assert.equal(messages[0].userName, '\u6d4b\u8bd5\u7528\u6237');
    assert.equal(messages[0].content, '\u552f\u4e00\u6d4b\u8bd5\u8bc4\u8bba');
    assert.equal(messages[0].context.selectorVersion, 'wechat_channels-comment-2026.08.07.2');
    assert.ok(messages[0].context.commentFingerprint);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('\u89c6\u9891\u53f7\u8bc4\u8bba\u56de\u590d\u5fc5\u987b\u552f\u4e00\u7cbe\u786e\u547d\u4e2d\uff0c0 \u6761\u6216\u591a\u6761\u5747\u62d2\u7edd', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-comment-identity-'));
  try {
    const adapter = new WechatChannelsAssistedRpaAdapter({ platformCode: 'wechat_channels', logsDir: dir, profileDir: path.join(dir, 'profile'), executablePath: '', loginTimeoutMs: 1000, sendTimeoutMs: 1000 });
    const payload = { messageType: 'COMMENT', userName: '\u552f\u4e00\u7528\u6237', sourceContent: '\u552f\u4e00\u8bc4\u8bba', messageContext: { eventTime: '2026-08-06 11:00' } };
    const rows = [{ id: 0 }, { id: 1 }];
    const page = { locator() { return { async count() { return rows.length; }, nth(index) { return { ...rows[index], async isVisible() { return true; } }; } }; } };
    adapter.readDouyinCommentCandidate = async row => ({ userName: '\u552f\u4e00\u7528\u6237', content: row.id === 0 ? '\u5176\u4ed6\u8bc4\u8bba' : '\u4e0d\u540c\u8bc4\u8bba', eventTime: '2026-08-06 11:00' });
    assert.equal((await adapter.locateMessageContainer(page, payload)).reason, 'COMMENT_TARGET_NOT_FOUND');
    adapter.readDouyinCommentCandidate = async () => ({ userName: '\u552f\u4e00\u7528\u6237', content: '\u552f\u4e00\u8bc4\u8bba', eventTime: '2026-08-06 11:00' });
    assert.equal((await adapter.locateMessageContainer(page, payload)).reason, 'COMMENT_TARGET_AMBIGUOUS');
    rows.pop();
    const exact = await adapter.locateMessageContainer(page, payload);
    assert.equal(exact.ok, true);
    assert.equal(exact.index, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('\u89c6\u9891\u53f7\u8bc4\u8bba\u7f16\u8f91\u5668\u548c\u53d1\u9001\u63a7\u4ef6\u9650\u5236\u5728\u76ee\u6807\u8bc4\u8bba\u5361\u7247', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-comment-scope-'));
  try {
    const adapter = new WechatChannelsAssistedRpaAdapter({ platformCode: 'wechat_channels', logsDir: dir, profileDir: path.join(dir, 'profile'), executablePath: '', loginTimeoutMs: 1000, sendTimeoutMs: 1000 });
    let triggerClicked = false;
    let editorScope = null;
    let sendRoot = null;
    let value = '';
    const trigger = makeWechatTestLocator({ onClick: () => { triggerClicked = true; } });
    const container = {
      locator(selector) { return selector === ':scope > .comment-item-main .comment-actions .weui-icon-outlined-comment' ? trigger : makeWechatTestLocator({ visible: false }); },
      getByText() { return makeWechatTestLocator({ visible: false }); },
      getByRole() { return makeWechatTestLocator({ visible: false }); }
    };
    const editor = {
      async click() {},
      async evaluate() { return 'textarea'; },
      async fill(next) { value = next; },
      async inputValue() { return value; }
    };
    const root = { marker: 'target-comment-editor' };
    const page = { async goto() {}, async waitForTimeout() {}, url() { return PLATFORM_ASSISTED_SPECS.wechat_channels.commentUrl; } };
    adapter.getPage = async () => page;
    adapter.detectPageState = async () => 'READY';
    adapter.waitForMessageContentReady = async () => ({ ready: true });
    adapter.openWechatCommentVideoForPayload = async () => ({ ok: true, reason: 'COMMENT_VIDEO_SELECTED' });
    adapter.locateMessageContainer = async () => ({ ok: true, locator: container, identity: { matched: true }, index: 0 });
    adapter.countExactCommentEchoes = async () => 0;
    adapter.readDouyinCommentCandidate = async () => ({ userName: '\u6d4b\u8bd5\u7528\u6237', content: '\u6d4b\u8bd5\u8bc4\u8bba', eventTime: '2026-08-06 12:00', commentStableId: 'wechat-comment-A', sourceVideoKey: 'wechat-video-A', sourceVerified: true });
    adapter.findDouyinCommentEditor = async (_page, _payload, scope) => { editorScope = scope; return { ok: true, root, editor }; };
    adapter.clickDouyinCommentSend = async candidateRoot => { sendRoot = candidateRoot; return { clicked: true, method: 'mock-scoped-send' }; };
    adapter.waitForReplyEvidence = async () => ({ confirmed: true, phoneCheckBlocked: false, editorCleared: true, scopedEchoCount: 1, baselineEchoCount: 0 });
    adapter.evidence = async (_payload, message, _page, stage, extra = {}) => ({ message, stage, ...extra });
    const result = await adapter.replyToMessage({ platformCode: 'wechat_channels', accountId: 'test-account', messageType: 'COMMENT', userName: '\u6d4b\u8bd5\u7528\u6237', sourceContent: '\u6d4b\u8bd5\u8bc4\u8bba', replyText: '\u6d4b\u8bd5\u56de\u590d', externalUrl: page.url(), messageContext: { eventTime: '2026-08-06 12:00', postId: 'wechat-video-A', commentId: 'wechat-comment-A', sourceVerified: true } });
    assert.equal(result.status, 'SUCCESS');
    assert.equal(triggerClicked, true);
    assert.equal(editorScope, container);
    assert.equal(sendRoot, root);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('\u89c6\u9891\u53f7\u79c1\u4fe1\u56de\u590d\u7f3a\u5c11\u672a\u8bfb\u8bc1\u636e\u65f6\u5728\u5b9a\u4f4d\u4f1a\u8bdd\u524d\u505c\u6b62', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-private-unread-required-'));
  try {
    const adapter = new WechatChannelsAssistedRpaAdapter({ platformCode: 'wechat_channels', logsDir: dir, profileDir: path.join(dir, 'profile'), executablePath: '', loginTimeoutMs: 1000, sendTimeoutMs: 1000 });
    const page = { locator() { throw new Error('conversation rows must not be inspected'); } };
    adapter.prepareMessagePage = async () => ({ finalUrl: PLATFORM_ASSISTED_SPECS.wechat_channels.messageUrl });
    adapter.inspectLoginState = async () => ({ state: 'READY', evidence: [] });
    adapter.waitForMessageContentReady = async () => ({ ready: true, pageCheck: { valid: true } });
    const result = await adapter.openPrivateConversationForPayload(page, { messageType: 'PRIVATE_MESSAGE', userName: '\u6d4b\u8bd5\u7528\u6237', sourceContent: '\u6d4b\u8bd5\u79c1\u4fe1', messageContext: { inboxType: 'MAIN' } });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'PRIVATE_UNREAD_EVIDENCE_REQUIRED');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

function makeWechatPrivateConversationPage({ preview = '\u6d4b\u8bd5\u79c1\u4fe1', unread = true, header = '\u6d4b\u8bd5\u7528\u6237' } = {}) {
  let clicked = false;
  const invisible = makeWechatTestLocator({ visible: false });
  const title = makeWechatTestLocator({ text: '\u6d4b\u8bd5\u7528\u6237' });
  const previewLocator = makeWechatTestLocator({ text: preview });
  const unreadLocator = makeWechatTestLocator({ visible: unread });
  const row = {
    async isVisible() { return true; },
    locator(selector) {
      if (selector === '.feed-title .name') return title;
      if (selector === '.feed-info') return previewLocator;
      if (selector === '.dot') return unreadLocator;
      return invisible;
    },
    async click() { clicked = true; }
  };
  const rows = { async count() { return 1; }, nth() { return row; } };
  const page = {
    url() { return PLATFORM_ASSISTED_SPECS.wechat_channels.messageUrl; },
    locator(selector) {
      if (selector === '.private-msg-list .session-wrap' || selector === '.private-msg-list .session-wrap,.session-container .session-wrap') return rows;
      if (selector === '.session-dialog .header .left') return makeWechatTestLocator({ text: header });
      return invisible;
    },
    async waitForTimeout() {}
  };
  return { page, wasClicked: () => clicked };
}

test('\u89c6\u9891\u53f7\u79c1\u4fe1\u76ee\u6807\u5df2\u65e0\u672a\u8bfb\u6807\u8bb0\u65f6\u7981\u6b62\u56de\u590d', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-private-dot-'));
  try {
    const adapter = new WechatChannelsAssistedRpaAdapter({ platformCode: 'wechat_channels', logsDir: dir, profileDir: path.join(dir, 'profile'), executablePath: '', loginTimeoutMs: 1000, sendTimeoutMs: 1000 });
    const mock = makeWechatPrivateConversationPage({ unread: false });
    adapter.prepareMessagePage = async () => ({ finalUrl: mock.page.url() });
    adapter.inspectLoginState = async () => ({ state: 'READY', evidence: [] });
    adapter.waitForMessageContentReady = async () => ({ ready: true, pageCheck: { valid: true } });
    const result = await adapter.openPrivateConversationForPayload(mock.page, { messageType: 'PRIVATE_MESSAGE', userName: '\u6d4b\u8bd5\u7528\u6237', sourceContent: '\u6d4b\u8bd5\u79c1\u4fe1', messageContext: { inboxType: 'MAIN', unread: true } });
    assert.equal(result.reason, 'CONVERSATION_NO_LONGER_UNREAD');
    assert.equal(mock.wasClicked(), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('\u89c6\u9891\u53f7\u79c1\u4fe1\u4f1a\u8bdd\u9884\u89c8\u53d1\u751f\u53d8\u5316\u65f6\u7981\u6b62\u56de\u590d', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-private-preview-'));
  try {
    const adapter = new WechatChannelsAssistedRpaAdapter({ platformCode: 'wechat_channels', logsDir: dir, profileDir: path.join(dir, 'profile'), executablePath: '', loginTimeoutMs: 1000, sendTimeoutMs: 1000 });
    const mock = makeWechatPrivateConversationPage({ preview: '\u5df2\u53d8\u5316\u7684\u65b0\u9884\u89c8', unread: true });
    adapter.prepareMessagePage = async () => ({ finalUrl: mock.page.url() });
    adapter.inspectLoginState = async () => ({ state: 'READY', evidence: [] });
    adapter.waitForMessageContentReady = async () => ({ ready: true, pageCheck: { valid: true } });
    const result = await adapter.openPrivateConversationForPayload(mock.page, { messageType: 'PRIVATE_MESSAGE', userName: '\u6d4b\u8bd5\u7528\u6237', sourceContent: '\u539f\u59cb\u79c1\u4fe1', messageContext: { inboxType: 'MAIN', unread: true } });
    assert.equal(result.reason, 'SOURCE_PREVIEW_CHANGED');
    assert.equal(mock.wasClicked(), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});


test('wechat channels private collection scans both main and greeting inboxes and keeps the source inbox', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-private-two-inboxes-'));
  try {
    const adapter = new WechatChannelsAssistedRpaAdapter({ platformCode: 'wechat_channels', logsDir: dir, profileDir: path.join(dir, 'profile'), executablePath: '', loginTimeoutMs: 1000, sendTimeoutMs: 1000 });
    const selected = [];
    const page = { url: () => PLATFORM_ASSISTED_SPECS.wechat_channels.messageUrl };
    adapter.selectWechatPrivateInbox = async (_page, inboxType) => {
      selected.push(inboxType);
      return { ok: true, handled: true, inboxType, label: inboxType === 'MAIN' ? '\u79c1\u4fe1' : '\u6253\u62db\u547c\u6d88\u606f', scope: page };
    };
    adapter.waitForMessageContentReady = async () => ({ ready: true, empty: false, reason: 'PRIVATE_SESSIONS_READY', pageCheck: { valid: true, reason: 'VERIFIED' }, scope: page });
    adapter.readWechatPrivateConversations = async (_scope, inboxType) => [{
      inboxType,
      name: inboxType === 'MAIN' ? 'main-user' : 'greeting-user',
      preview: inboxType === 'MAIN' ? 'main-message' : 'greeting-message',
      time: '刚刚',
      avatarUrl: `https://wx.qlogo.cn/${inboxType}`,
      unread: false
    }];
    adapter.inspectWechatPrivateConversationCandidate = async (_page, conversation) => ({
      status: 'VERIFIED',
      reason: 'WECHAT_CHAT_LATEST_INCOMING_VERIFIED',
      conversation,
      message: {
        externalId: `wechat-${conversation.inboxType}`,
        userName: conversation.name,
        content: conversation.preview,
        context: { inboxType: conversation.inboxType, unread: conversation.unread }
      }
    });
    const result = await adapter.collectWechatPrivateMessages(page, { noteCandidates: [] });
    assert.equal(result.ok, true);
    assert.deepEqual(selected, ['MAIN', 'GREETING']);
    assert.equal(result.mainMessages.length, 1);
    assert.equal(result.greetingMessages.length, 1);
    assert.deepEqual(result.messages.map(message => message.context.inboxType), ['MAIN', 'GREETING']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('wechat channels first observation skips old no-dot history but inspects a later changed preview', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-private-first-baseline-'));
  try {
    const adapter = new WechatChannelsAssistedRpaAdapter({ platformCode: 'wechat_channels', logsDir: dir, profileDir: path.join(dir, 'profile'), executablePath: '', loginTimeoutMs: 1000, sendTimeoutMs: 1000 });
    const page = { url: () => PLATFORM_ASSISTED_SPECS.wechat_channels.messageUrl };
    let current = { inboxType: 'MAIN', name: 'old-user', preview: '历史消息', time: '前天', avatarUrl: 'https://wx.qlogo.cn/old-user', unread: false };
    let inspections = 0;
    adapter.selectWechatPrivateInbox = async (_page, inboxType) => ({ ok: true, handled: true, inboxType, scope: page });
    adapter.waitForMessageContentReady = async () => ({ ready: true, empty: false, reason: 'PRIVATE_SESSIONS_READY', pageCheck: { valid: true, reason: 'VERIFIED' }, scope: page });
    adapter.readWechatPrivateConversations = async (_scope, inboxType) => inboxType === 'MAIN' ? [{ ...current }] : [];
    adapter.inspectWechatPrivateConversationCandidate = async (_page, conversation) => {
      inspections += 1;
      return {
        status: 'VERIFIED',
        reason: 'WECHAT_CHAT_LATEST_INCOMING_VERIFIED',
        conversation,
        message: { externalId: `wechat-${inspections}`, userName: conversation.name, content: conversation.preview, context: { inboxType: conversation.inboxType } }
      };
    };

    const first = await adapter.collectWechatPrivateMessages(page, {});
    assert.equal(first.mainMessages.length, 0);
    assert.equal(first.inboxes[0].inspectedConversationCount, 0);
    assert.equal(inspections, 0);

    current = { ...current, preview: '刚发的新消息', time: '刚刚' };
    const second = await adapter.collectWechatPrivateMessages(page, {});
    assert.equal(second.mainMessages.length, 1);
    assert.equal(second.mainMessages[0].content, '刚发的新消息');
    assert.equal(second.inboxes[0].inspectedConversationCount, 1);
    assert.equal(inspections, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('wechat channels first observation still inspects a recent no-dot conversation', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-private-first-recent-'));
  try {
    const adapter = new WechatChannelsAssistedRpaAdapter({ platformCode: 'wechat_channels', logsDir: dir, profileDir: path.join(dir, 'profile'), executablePath: '', loginTimeoutMs: 1000, sendTimeoutMs: 1000 });
    const page = { url: () => PLATFORM_ASSISTED_SPECS.wechat_channels.messageUrl };
    let inspections = 0;
    adapter.selectWechatPrivateInbox = async (_page, inboxType) => ({ ok: true, handled: true, inboxType, scope: page });
    adapter.waitForMessageContentReady = async () => ({ ready: true, empty: false, reason: 'PRIVATE_SESSIONS_READY', pageCheck: { valid: true, reason: 'VERIFIED' }, scope: page });
    adapter.readWechatPrivateConversations = async (_scope, inboxType) => inboxType === 'MAIN' ? [{ inboxType, name: 'recent-user', preview: '刚发的问题', time: '5分钟前', avatarUrl: 'https://wx.qlogo.cn/recent-user', unread: false }] : [];
    adapter.inspectWechatPrivateConversationCandidate = async (_page, conversation) => {
      inspections += 1;
      return { status: 'VERIFIED', reason: 'WECHAT_CHAT_LATEST_INCOMING_VERIFIED', conversation, message: { externalId: 'wechat-recent', userName: conversation.name, content: conversation.preview, context: { inboxType: conversation.inboxType } } };
    };

    const result = await adapter.collectWechatPrivateMessages(page, {});
    assert.equal(result.mainMessages.length, 1);
    assert.equal(result.inboxes[0].inspectedConversationCount, 1);
    assert.equal(inspections, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('wechat channels collects a no-dot conversation when the stable latest bubble is incoming', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-private-no-dot-incoming-'));
  try {
    const adapter = new WechatChannelsAssistedRpaAdapter({ platformCode: 'wechat_channels', logsDir: dir, profileDir: path.join(dir, 'profile'), executablePath: '', loginTimeoutMs: 1000, sendTimeoutMs: 1000 });
    const timeline = {
      stable: true,
      messages: [
        { text: 'hi', direction: 'incoming' },
        { text: '你好', direction: 'outgoing' },
        { text: '您好', direction: 'incoming' }
      ],
      latestMessage: { text: '您好', direction: 'incoming' }
    };
    adapter.openPrivateConversationForPayload = async (_page, request, options) => {
      assert.equal(request.messageContext.unread, false);
      assert.equal(options.requireUnreadEvidence, false);
      return {
        ok: true,
        conversationId: null,
        messageId: null,
        sourceMessageCount: 1,
        sourceIncomingMessageCount: 1,
        sourceIsLatest: true,
        timelineStable: true,
        latestMessage: timeline.latestMessage,
        timeline
      };
    };
    const page = { url: () => PLATFORM_ASSISTED_SPECS.wechat_channels.messageUrl };
    const first = await adapter.inspectWechatPrivateConversationCandidate(page, {
      inboxType: 'MAIN', name: 'Amy', preview: '您好', time: '08月20日 22:09',
      avatarUrl: 'http://wx.qlogo.cn/mmhead/amy/0', unread: false
    }, { accountId: 1 });
    const second = await adapter.inspectWechatPrivateConversationCandidate(page, {
      inboxType: 'MAIN', name: 'Amy', preview: '您好', time: '08月20日 22:09',
      avatarUrl: 'http://wx.qlogo.cn/mmhead/amy/0', unread: false
    }, { accountId: 1 });
    assert.equal(first.status, 'VERIFIED');
    assert.equal(first.message.content, '您好');
    assert.equal(first.message.context.unread, false);
    assert.equal(first.message.context.direction, 'incoming');
    assert.equal(first.message.context.sourceVerified, true);
    assert.equal(first.message.context.incomingLatestVerified, true);
    assert.match(first.message.context.conversationId, /^wechat-conversation-/);
    assert.match(first.message.context.messageId, /^wechat-message-/);
    assert.equal(first.message.externalId, second.message.externalId);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('wechat channels no-dot conversation is not collected when the latest bubble is outgoing', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-private-no-dot-outgoing-'));
  try {
    const adapter = new WechatChannelsAssistedRpaAdapter({ platformCode: 'wechat_channels', logsDir: dir, profileDir: path.join(dir, 'profile'), executablePath: '', loginTimeoutMs: 1000, sendTimeoutMs: 1000 });
    const timeline = {
      stable: true,
      messages: [
        { text: '您好', direction: 'incoming' },
        { text: '已经人工回复', direction: 'outgoing' }
      ],
      latestMessage: { text: '已经人工回复', direction: 'outgoing' }
    };
    adapter.openPrivateConversationForPayload = async () => ({
      ok: true,
      sourceIsLatest: true,
      timelineStable: true,
      latestMessage: timeline.latestMessage,
      timeline
    });
    const result = await adapter.inspectWechatPrivateConversationCandidate(
      { url: () => PLATFORM_ASSISTED_SPECS.wechat_channels.messageUrl },
      { inboxType: 'MAIN', name: '已回复用户', preview: '已经人工回复', time: '08月20日 22:10', avatarUrl: 'http://wx.qlogo.cn/replied/0', unread: false },
      {}
    );
    assert.equal(result.status, 'SKIPPED');
    assert.equal(result.reason, 'PRIVATE_LATEST_MESSAGE_OUTGOING');
    assert.equal(result.message, undefined);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('wechat channels private collection rejects an unstable timeline or a preview mismatch', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-private-unstable-'));
  try {
    const adapter = new WechatChannelsAssistedRpaAdapter({ platformCode: 'wechat_channels', logsDir: dir, profileDir: path.join(dir, 'profile'), executablePath: '', loginTimeoutMs: 1000, sendTimeoutMs: 1000 });
    const page = { url: () => PLATFORM_ASSISTED_SPECS.wechat_channels.messageUrl };
    const conversation = { inboxType: 'GREETING', name: 'haban', preview: '怎么加入社区', time: '08月20日 22:11', avatarUrl: 'http://wx.qlogo.cn/haban/0', unread: false };
    adapter.openPrivateConversationForPayload = async () => ({ ok: true, timelineStable: false, timeline: { stable: false, messages: [] } });
    const unstable = await adapter.inspectWechatPrivateConversationCandidate(page, conversation, {});
    assert.equal(unstable.reason, 'PRIVATE_TIMELINE_UNSTABLE');
    adapter.openPrivateConversationForPayload = async () => ({
      ok: true,
      sourceIsLatest: true,
      timelineStable: true,
      latestMessage: { text: '另一个问题', direction: 'incoming' },
      timeline: { stable: true, messages: [{ text: '另一个问题', direction: 'incoming' }], latestMessage: { text: '另一个问题', direction: 'incoming' } }
    });
    const mismatch = await adapter.inspectWechatPrivateConversationCandidate(page, conversation, {});
    assert.equal(mismatch.reason, 'PRIVATE_PREVIEW_LATEST_MESSAGE_MISMATCH');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('wechat channels derived message identity changes for a repeated incoming occurrence', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-private-derived-id-'));
  try {
    const adapter = new WechatChannelsAssistedRpaAdapter({ platformCode: 'wechat_channels', logsDir: dir, profileDir: path.join(dir, 'profile'), executablePath: '', loginTimeoutMs: 1000, sendTimeoutMs: 1000 });
    const conversationId = 'wechat-conversation-stable';
    const first = adapter.deriveWechatPrivateMessageId({ conversationId, eventTime: '08月20日 22:09', content: '您好', occurrence: 1 });
    const same = adapter.deriveWechatPrivateMessageId({ conversationId, eventTime: '08月20日 22:09', content: '您好', occurrence: 1 });
    const repeated = adapter.deriveWechatPrivateMessageId({ conversationId, eventTime: '08月20日 22:10', content: '您好', occurrence: 2 });
    assert.equal(first, same);
    assert.notEqual(first, repeated);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('wechat channels send-time verification requires the exact source to remain the stable latest incoming bubble', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-private-send-revalidate-'));
  try {
    const adapter = new WechatChannelsAssistedRpaAdapter({ platformCode: 'wechat_channels', logsDir: dir, profileDir: path.join(dir, 'profile'), executablePath: '', loginTimeoutMs: 1000, sendTimeoutMs: 1000 });
    adapter.inspectStablePrivateConversationTimeline = async () => ({
      stable: true,
      messages: [{ text: '原问题', direction: 'incoming' }, { text: '用户又问了新问题', direction: 'incoming' }],
      latestMessage: { text: '用户又问了新问题', direction: 'incoming' }
    });
    const result = await adapter.verifyWechatIncomingSource({}, { sourceContent: '原问题', messageContext: {} });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'SOURCE_MESSAGE_NOT_LATEST_IN_CONVERSATION');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('wechat channels greeting reply prepares the greeting inbox before locating the conversation', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-private-greeting-reply-'));
  try {
    const adapter = new WechatChannelsAssistedRpaAdapter({ platformCode: 'wechat_channels', logsDir: dir, profileDir: path.join(dir, 'profile'), executablePath: '', loginTimeoutMs: 1000, sendTimeoutMs: 1000 });
    const mock = makeWechatPrivateConversationPage({ preview: 'hello-from-greeting', unread: true });
    const prepared = [];
    adapter.prepareMessagePage = async () => ({ finalUrl: mock.page.url() });
    adapter.inspectLoginState = async () => ({ state: 'READY', evidence: [] });
    adapter.preparePrivateInbox = async (_page, options) => { prepared.push(options.inboxType); return { ok: true, handled: true, inboxType: options.inboxType, scope: mock.page }; };
    adapter.waitForMessageContentReady = async () => ({ ready: true, pageCheck: { valid: true }, scope: mock.page });
    adapter.locatePrivateConversationHeader = async () => ({ ok: true, headerName: '\u6d4b\u8bd5\u7528\u6237' });
    adapter.inspectStablePrivateConversationTimeline = async () => ({ stable: true, messages: [], latestMessage: null });
    const result = await adapter.openPrivateConversationForPayload(mock.page, {
      messageType: 'PRIVATE_MESSAGE',
      userName: '\u6d4b\u8bd5\u7528\u6237',
      sourceContent: 'hello-from-greeting',
      messageContext: { inboxType: 'GREETING', unread: true }
    }, { requireSourcePreview: false, requireUnreadEvidence: false });
    assert.deepEqual(prepared, ['GREETING']);
    assert.notEqual(result.reason, 'INBOX_TYPE_UNSUPPORTED');
    assert.equal(result.inboxType, 'GREETING');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('wechat channels private collection reports incomplete coverage when greeting tab cannot be selected', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-private-greeting-missing-'));
  try {
    const adapter = new WechatChannelsAssistedRpaAdapter({ platformCode: 'wechat_channels', logsDir: dir, profileDir: path.join(dir, 'profile'), executablePath: '', loginTimeoutMs: 1000, sendTimeoutMs: 1000 });
    const page = { url: () => PLATFORM_ASSISTED_SPECS.wechat_channels.messageUrl };
    adapter.selectWechatPrivateInbox = async (_page, inboxType) => inboxType === 'MAIN'
      ? { ok: true, handled: true, inboxType, scope: page }
      : { ok: false, handled: true, inboxType, reason: 'PRIVATE_INBOX_TAB_NOT_FOUND' };
    adapter.waitForMessageContentReady = async () => ({ ready: true, empty: true, reason: 'PRIVATE_EMPTY_CONFIRMED', pageCheck: { valid: true }, scope: page });
    adapter.extractMessages = async () => [];
    const result = await adapter.collectWechatPrivateMessages(page, {});
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'PRIVATE_INBOX_TAB_NOT_FOUND');
    assert.equal(result.inboxes[0].ok, true);
    assert.equal(result.inboxes[1].ok, false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('\u89c6\u9891\u53f7\u79c1\u4fe1\u53d1\u9001\u6392\u9664\u4e0a\u4f20\u63a7\u4ef6\uff0c\u53ea\u63a5\u53d7\u660e\u786e\u53d1\u9001\u8bc1\u636e', () => {
  const spec = PLATFORM_ASSISTED_SPECS.wechat_channels;
  assert.equal(spec.privateEditorScopeSelector, '.footer');
  assert.equal(spec.privateOutgoingMessageContainerSelector, '.content-right');
  assert.equal(isPrivateSendControlEvidence({ text: '\u4e0a\u4f20\u56fe\u7247', className: 'file-uploader default btn' }), false);
  assert.equal(isPrivateSendControlEvidence({ ariaLabel: '\u53d1\u9001', className: 'default btn message-send' }), true);
  assert.equal(isPrivateSendControlEvidence({ text: '', className: 'default btn' }), false);
});

test('\u89c6\u9891\u53f7\u79c1\u4fe1\u6210\u529f\u56de\u663e\u53ea\u8ba1\u6570 content-right \u5df1\u65b9\u6c14\u6ce1', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-private-outgoing-'));
  try {
    const adapter = new WechatChannelsAssistedRpaAdapter({ platformCode: 'wechat_channels', logsDir: dir, profileDir: path.join(dir, 'profile'), executablePath: '', loginTimeoutMs: 1000, sendTimeoutMs: 1000 });
    let optionsSeen = null;
    const page = {
      locator(selector) {
        if (selector === '.session-dialog .message-plain') {
          return {
            async evaluateAll(_fn, options) {
              optionsSeen = options;
              return [{ index: 0, outgoing: true, x: 100, width: 50, className: 'content-right' }];
            }
          };
        }
        if (selector === '.session-dialog .content-right') {
          return {
            async evaluateAll() {
              return { matches: [], pendingCount: 0, failedCount: 0 };
            }
          };
        }
        throw new Error(`unexpected selector: ${selector}`);
      }
    };
    const result = await adapter.countExactPrivateMessages(page, '\u7cbe\u786e\u56de\u590d', { outgoingOnly: true });
    assert.equal(result.count, 1);
    assert.equal(optionsSeen.outgoingOnly, true);
    assert.equal(optionsSeen.outgoingContainerSelector, '.content-right');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('视频号私信回执归一化兼容换行、全角符号和零宽字符', () => {
  assert.equal(
    normalizePrivateReceiptTextForComparison('你好～\n请发送“转人工”\u200b'),
    normalizePrivateReceiptTextForComparison('你好~请发送"转人工"')
  );
});

test('视频号长私信通过完整己方气泡确认发送成功并使用20秒回执窗口', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-private-long-bubble-'));
  try {
    const adapter = new WechatChannelsAssistedRpaAdapter({ platformCode: 'wechat_channels', logsDir: dir, profileDir: path.join(dir, 'profile'), executablePath: '', loginTimeoutMs: 1000, sendTimeoutMs: 1000 });
    adapter.spec = { ...adapter.spec, privatePhoneCheckTextPattern: null };
    const replyText = '你好～为了能更好地帮你查询业务，请告诉我你具体想了解哪一项内容。如果需要转人工，请发送“转人工”。';
    let value = '';
    let sent = false;
    let evidenceTimeoutMs = null;
    const editor = {
      async inputValue() { return value; },
      async boundingBox() { return { x: 0, y: 600, width: 800, height: 80 }; }
    };
    const page = {
      url() { return PLATFORM_ASSISTED_SPECS.wechat_channels.messageUrl; },
      locator(selector) {
        if (selector === '.session-dialog .message-plain') {
          return { async evaluateAll() { return []; } };
        }
        if (selector === '.session-dialog .content-right') {
          return {
            async evaluateAll() {
              return sent
                ? { matches: [{ index: 0, matchMode: 'CANONICAL_TEXT', className: 'content-right' }], pendingCount: 0, failedCount: 0 }
                : { matches: [], pendingCount: 0, failedCount: 0 };
            }
          };
        }
        throw new Error(`unexpected selector: ${selector}`);
      }
    };
    adapter.getPage = async () => page;
    adapter.openPrivateConversationForPayload = async () => ({ ok: true, conversationName: '测试用户' });
    adapter.resolvePrivateReplyScope = async () => page;
    adapter.findReplyEditor = async () => editor;
    adapter.fillPrivateReplyEditor = async (_editor, text) => { value = text; return { method: 'mock-keyboard' }; };
    adapter.revalidatePrivateReplyTarget = async () => ({ ok: true, reason: 'MOCK_TARGET_STABLE' });
    adapter.clickPrivateSend = async () => { sent = true; value = ''; return { clicked: true, method: 'mock-send' }; };
    adapter.waitForReplyEvidence = async (check, timeoutMs) => { evidenceTimeoutMs = timeoutMs; return check(); };
    adapter.evidence = async (_payload, message, _page, stage, extra = {}) => ({ message, stage, ...extra });

    const result = await adapter.replyToMessage({
      platformCode: 'wechat_channels',
      accountId: 'test-account',
      messageType: 'PRIVATE_MESSAGE',
      userName: '测试用户',
      sourceContent: '怎么咨询业务',
      replyText,
      messageContext: {
        conversationId: 'wechat-conversation-long',
        messageId: 'wechat-message-long',
        direction: 'incoming',
        inboxType: 'MAIN',
        unread: true,
        previewOnly: false,
        unreadCount: 1,
        sourceVerified: true,
        chatTitleVerified: true
      }
    });

    assert.equal(result.status, 'SUCCESS');
    assert.equal(result.result.stage, 'reply_sent');
    assert.equal(result.result.echoDetector, 'OUTGOING_BUBBLE');
    assert.equal(result.result.scopedEchoCount, 1);
    assert.equal(result.result.baselineEchoCount, 0);
    assert.equal(result.result.bubbleEvidence.count, 1);
    assert.equal(evidenceTimeoutMs, 20000);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('\u89c6\u9891\u53f7\u89e6\u53d1\u624b\u673a\u53f7\u7ed1\u5b9a\u9650\u5236\u65f6\u8fd4\u56de NEEDS_CONFIRMATION \u4e14\u4e0d\u91cd\u8bd5', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-phone-check-'));
  try {
    const adapter = new WechatChannelsAssistedRpaAdapter({ platformCode: 'wechat_channels', logsDir: dir, profileDir: path.join(dir, 'profile'), executablePath: '', loginTimeoutMs: 1000, sendTimeoutMs: 1000 });
    let value = '';
    let sendAttempts = 0;
    const editor = {
      async click() {},
      async evaluate() { return 'textarea'; },
      async fill(next) { value = next; },
      async pressSequentially(next) { value += next; },
      async inputValue() { return value; }
    };
    const page = { url() { return PLATFORM_ASSISTED_SPECS.wechat_channels.messageUrl; } };
    adapter.getPage = async () => page;
    adapter.openPrivateConversationForPayload = async () => ({ ok: true, conversationName: '\u6d4b\u8bd5\u7528\u6237' });
    adapter.revalidatePrivateReplyTarget = async () => ({ ok: true, reason: 'MOCK_TARGET_STABLE' });
    adapter.findReplyEditor = async () => editor;
    adapter.countExactPrivateMessages = async () => ({ count: 0, matches: [] });
    adapter.clickPrivateSend = async () => { sendAttempts += 1; return { clicked: true, method: 'mock-send' }; };
    adapter.waitForReplyEvidence = async () => ({ confirmed: false, phoneCheckBlocked: true, editorCleared: false, scopedEchoCount: 0, baselineEchoCount: 0 });
    adapter.evidence = async (_payload, message, _page, stage, extra = {}) => ({ message, stage, ...extra });
    const result = await adapter.replyToMessage({ platformCode: 'wechat_channels', accountId: 'test-account', messageType: 'PRIVATE_MESSAGE', userName: '\u6d4b\u8bd5\u7528\u6237', sourceContent: '\u6d4b\u8bd5\u79c1\u4fe1', replyText: '\u6d4b\u8bd5\u56de\u590d', messageContext: { conversationId: 'wechat-conversation-A', messageId: 'wechat-message-A', direction: 'incoming', inboxType: 'MAIN', unread: true, previewOnly: false, unreadCount: 1, sourceVerified: true, chatTitleVerified: true } });
    assert.equal(result.status, 'NEEDS_CONFIRMATION');
    assert.equal(result.result.stage, 'reply_phone_binding_required');
    assert.equal(sendAttempts, 1);
    assert.equal(result.result.fillMethod, 'wechat-press-sequentially');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('wechat channels private reply refuses to click send when real keyboard input is unavailable', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-private-keyboard-missing-'));
  try {
    const adapter = new WechatChannelsAssistedRpaAdapter({ platformCode: 'wechat_channels', logsDir: dir, profileDir: path.join(dir, 'profile'), executablePath: '', loginTimeoutMs: 1000, sendTimeoutMs: 1000 });
    let value = '';
    let sendAttempts = 0;
    const editor = {
      async click() {},
      async press() {},
      async fill(next) { value = next; },
      async inputValue() { return value; }
    };
    const page = { url() { return PLATFORM_ASSISTED_SPECS.wechat_channels.messageUrl; } };
    adapter.getPage = async () => page;
    adapter.openPrivateConversationForPayload = async () => ({ ok: true, conversationName: '测试用户' });
    adapter.findReplyEditor = async () => editor;
    adapter.countExactPrivateMessages = async () => ({ count: 0, matches: [] });
    adapter.revalidatePrivateReplyTarget = async () => ({ ok: true, reason: 'MOCK_TARGET_STABLE' });
    adapter.clickPrivateSend = async () => { sendAttempts += 1; return { clicked: true, method: 'mock-send' }; };
    adapter.evidence = async (_payload, message, _page, stage, extra = {}) => ({ message, stage, ...extra });

    const result = await adapter.replyToMessage({ platformCode: 'wechat_channels', accountId: 'test-account', messageType: 'PRIVATE_MESSAGE', userName: '测试用户', sourceContent: '测试私信', replyText: '测试回复', messageContext: { conversationId: 'wechat-conversation-A', messageId: 'wechat-message-A', direction: 'incoming', inboxType: 'MAIN', unread: true, previewOnly: false, unreadCount: 1, sourceVerified: true, chatTitleVerified: true } });
    assert.equal(result.status, 'NEEDS_CONFIRMATION');
    assert.equal(result.result.stage, 'reply_fill_failed');
    assert.equal(result.result.error, 'WECHAT_PRIVATE_REAL_KEYBOARD_INPUT_UNAVAILABLE');
    assert.equal(sendAttempts, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('\u89c6\u9891\u53f7\u8349\u7a3f\u5b9e\u673a\u811a\u672c\u5e26\u6709\u5355\u5e73\u53f0\u5b89\u5168\u65ad\u8a00', t => {
  const scriptPath = path.resolve('.tmp/run-wechat-draft-final.mjs');
  if (!fs.existsSync(scriptPath)) return t.skip('实机临时脚本未随源码交付，跳过一次性脚本断言');
  const script = fs.readFileSync(scriptPath, 'utf8');
  assert.match(script, /platforms:\['wechat_channels'\]/);
  assert.match(script, /targets:\[\{platformCode:'wechat_channels',accountId:account\.id\}\]/);
  assert.match(script, /payload\.targets\.length!==1/);
  assert.match(script, /payload\.publishMode!=='DRAFT_ONLY'/);
  assert.match(script, /payload\.managementConfirmed!==false/);
  for (const platform of ['douyin', 'xiaohongshu', 'bilibili', 'weibo']) {
    assert.doesNotMatch(script, new RegExp(`platformCode:'${platform}'`));
  }
});



test('wechat channels runtime entry URLs stay aligned with verified pages', () => {
  const configSource = fs.readFileSync(path.resolve('src/config.js'), 'utf8');
  const envSource = fs.readFileSync(path.resolve('.env'), 'utf8');
  const agentSource = fs.readFileSync(path.resolve('agent/local-agent.js'), 'utf8');
  for (const source of [configSource, envSource, agentSource]) {
    assert.match(source, /channels\.weixin\.qq\.com\/platform\/interaction\/comment/);
    assert.match(source, /channels\.weixin\.qq\.com\/platform\/private_msg/);
  }
  assert.doesNotMatch(configSource, /channels\.weixin\.qq\.com\/platform\/comment['"]/);
  assert.doesNotMatch(configSource, /channels\.weixin\.qq\.com\/platform\/message['"]/);
});


test('wechat channels comment overview page accepts the verified Wujie text signals', () => {
  const text = '\u8bc4\u8bba\u7ba1\u7406 \u89c6\u9891 \u56fe\u6587 \u5168\u90e8\u89c6\u9891 \u51713\u4e2a 2026/06/10 12:16 0 \u89c6\u9891\u53f7\u52a9\u624b \u00b7 \u8bc4\u8bba';
  const result = classifyMessagePageEvidence({
    messageType: 'COMMENT',
    url: 'https://channels.weixin.qq.com/platform/interaction/comment',
    text,
    spec: PLATFORM_ASSISTED_SPECS.wechat_channels
  });
  assert.equal(result.valid, true);
});

test('wechat channels comment overview confirms empty only when every listed video count is zero', () => {
  const result = assessWechatCommentOverviewEvidence({
    url: 'https://channels.weixin.qq.com/platform/interaction/comment',
    text: '\u8bc4\u8bba\u7ba1\u7406 \u5168\u90e8\u89c6\u9891 \u51713\u4e2a',
    overviewVisible: true,
    allVideoFilterVisible: true,
    totalVideoCount: 3,
    videoRows: [
      { time: '2026/06/10 12:16', count: 0 },
      { time: '2026/05/20 11:05', count: 0 },
      { time: '2024/07/26 11:25', count: 0 }
    ],
    commentRowCount: 0
  });
  assert.equal(result.confirmedEmpty, true);
  assert.equal(result.reason, 'COMMENT_EMPTY_ALL_VIDEO_COUNTS_ZERO');
  assert.equal(result.videoRowCount, 3);
});

test('wechat channels comment overview never treats a nonzero comment count as empty', () => {
  const result = assessWechatCommentOverviewEvidence({
    url: 'https://channels.weixin.qq.com/platform/interaction/comment',
    text: '\u8bc4\u8bba\u7ba1\u7406 \u5168\u90e8\u89c6\u9891 \u51713\u4e2a',
    overviewVisible: true,
    allVideoFilterVisible: true,
    totalVideoCount: 3,
    videoRows: [{ count: 0 }, { count: 2 }, { count: 0 }],
    commentRowCount: 0
  });
  assert.equal(result.confirmedEmpty, false);
  assert.equal(result.reason, 'COMMENT_COUNTS_PRESENT');
});

test('wechat channels comment overview requires a complete located video list', () => {
  const incomplete = assessWechatCommentOverviewEvidence({
    url: 'https://channels.weixin.qq.com/platform/interaction/comment',
    text: '\u8bc4\u8bba\u7ba1\u7406 \u5168\u90e8\u89c6\u9891 \u51713\u4e2a',
    overviewVisible: true,
    allVideoFilterVisible: true,
    totalVideoCount: 3,
    videoRows: [{ count: 0 }, { count: 0 }],
    commentRowCount: 0
  });
  assert.equal(incomplete.confirmedEmpty, false);
  assert.equal(incomplete.reason, 'COMMENT_VIDEO_LIST_INCOMPLETE');

  const unverified = assessWechatCommentOverviewEvidence({
    url: 'https://channels.weixin.qq.com/platform/interaction/comment',
    text: '\u4e92\u52a8\u7ba1\u7406 \u8bc4\u8bba',
    overviewVisible: false,
    videoRows: []
  });
  assert.equal(unverified.confirmedEmpty, false);
  assert.equal(unverified.reason, 'COMMENT_OVERVIEW_UNVERIFIED');
});

test('wechat channels readiness returns a structured empty-page success', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-comment-empty-'));
  try {
    const adapter = new WechatChannelsAssistedRpaAdapter({ platformCode: 'wechat_channels', logsDir: dir, profileDir: path.join(dir, 'profile'), executablePath: '', loginTimeoutMs: 1000, sendTimeoutMs: 1000 });
    adapter.classifyLiveMessagePage = async () => ({ valid: true, reason: 'VERIFIED', evidence: ['message-url-matched', 'message-text-matched'] });
    adapter.firstVisibleSelector = async () => null;
    adapter.inspectWechatCommentEmptyState = async () => ({ confirmedEmpty: true, reason: 'COMMENT_EMPTY_ALL_VIDEO_COUNTS_ZERO', totalVideoCount: 3, videoRowCount: 3 });
    const locator = () => ({ allInnerTexts: async () => ['\u8bc4\u8bba\u7ba1\u7406 \u89c6\u9891 \u56fe\u6587 \u5168\u90e8\u89c6\u9891 \u51713\u4e2a'], evaluateAll: async () => [] });
    const page = { frames: () => [{ locator }], locator, url: () => 'https://channels.weixin.qq.com/platform/interaction/comment', waitForTimeout: async () => {} };
    const result = await adapter.waitForMessageContentReady(page, 'COMMENT', 1000);
    assert.equal(result.ready, true);
    assert.equal(result.empty, true);
    assert.equal(result.reason, 'COMMENT_EMPTY_ALL_VIDEO_COUNTS_ZERO');
    assert.equal(result.wechatCommentEvidence.totalVideoCount, 3);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('wechat channels private readiness never treats message syncing as ready', () => {
  const state = assessWechatPrivateMessageEvidence({
    url: PLATFORM_ASSISTED_SPECS.wechat_channels.messageUrl,
    text: '\u79c1\u4fe1\u7ba1\u7406 \u6d88\u606f\u540c\u6b65\u4e2d',
    panelVisible: true,
    sessionRows: [],
    explicitEmptyVisible: false
  });
  assert.equal(state.ready, false);
  assert.equal(state.syncing, true);
  assert.equal(state.reason, 'PRIVATE_SYNC_IN_PROGRESS');
});

test('wechat channels private readiness waits when the page declares sessions that are not rendered yet', () => {
  const incomplete = assessWechatPrivateMessageEvidence({
    url: PLATFORM_ASSISTED_SPECS.wechat_channels.messageUrl,
    text: '\u79c1\u4fe1\u7ba1\u7406 \u51681\u4e2a \u6682\u65e0\u79c1\u4fe1',
    panelVisible: true,
    sessionRows: [],
    explicitEmptyVisible: true,
    declaredSessionTotal: 1,
    totalText: '\u51711\u4e2a'
  });
  assert.equal(incomplete.ready, false);
  assert.equal(incomplete.empty, false);
  assert.equal(incomplete.declaredSessionTotal, 1);
  assert.equal(incomplete.reason, 'PRIVATE_SESSION_LIST_INCOMPLETE');

  const uncounted = assessWechatPrivateMessageEvidence({
    url: PLATFORM_ASSISTED_SPECS.wechat_channels.messageUrl,
    text: '\u79c1\u4fe1\u7ba1\u7406 \u6682\u65e0\u79c1\u4fe1',
    panelVisible: true,
    sessionRows: [],
    explicitEmptyVisible: true
  });
  assert.equal(uncounted.declaredSessionTotal, null);
  assert.equal(uncounted.reason, 'PRIVATE_EMPTY_UNCOUNTED');
});

test('wechat channels private readiness accepts sessions and only a stable explicit empty state', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-private-readiness-'));
  try {
    const adapter = new WechatChannelsAssistedRpaAdapter({ platformCode: 'wechat_channels', logsDir: dir, profileDir: path.join(dir, 'profile'), executablePath: '', loginTimeoutMs: 1000, sendTimeoutMs: 1000 });
    adapter.classifyLiveMessagePage = async () => ({ valid: true, reason: 'VERIFIED' });
    adapter.inspectWechatPrivateMessageState = async () => ({ ready: true, empty: true, reason: 'PRIVATE_EMPTY_CONFIRMED', sessionCount: 0 });
    let waits = 0;
    const locator = () => ({ allInnerTexts: async () => ['\u79c1\u4fe1\u7ba1\u7406 \u6682\u65e0\u79c1\u4fe1'], evaluateAll: async () => [] });
    const page = { frames: () => [{ locator }], locator, waitForTimeout: async () => { waits += 1; } };
    const empty = await adapter.waitForMessageContentReady(page, 'PRIVATE_MESSAGE', 1000);
    assert.equal(empty.ready, true);
    assert.equal(empty.empty, true);
    assert.equal(empty.reason, 'PRIVATE_EMPTY_CONFIRMED');
    assert.equal(waits, 1);

    adapter.inspectWechatPrivateMessageState = async () => ({ ready: true, empty: false, reason: 'PRIVATE_SESSIONS_READY', sessionCount: 1 });
    waits = 0;
    const sessions = await adapter.waitForMessageContentReady(page, 'PRIVATE_MESSAGE', 1000);
    assert.equal(sessions.ready, true);
    assert.equal(sessions.empty, false);
    assert.equal(sessions.reason, 'PRIVATE_SESSIONS_READY');
    assert.equal(waits, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('wechat channels comment collection opens every positive-count video and preserves source context', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-comment-video-collect-'));
  try {
    const adapter = new WechatChannelsAssistedRpaAdapter({ platformCode: 'wechat_channels', logsDir: dir, profileDir: path.join(dir, 'profile'), executablePath: '', loginTimeoutMs: 1000, sendTimeoutMs: 1000 });
    adapter.readWechatCommentVideoRows = async () => [
      { index: 0, visible: true, title: '\u793e\u533a\u6d3b\u52a8\u62a5\u540d\u6307\u5357', time: '2026/08/07 08:59', text: '\u793e\u533a\u6d3b\u52a8\u62a5\u540d\u6307\u5357 2026/08/07 08:59 1', count: 1, sourceVideoKey: 'wechat-feed-real-1001', sourceVerified: true },
      { index: 1, visible: true, title: '', time: '2026/06/10 12:16', text: '2026/06/10 12:16 0', count: 0, sourceVideoKey: 'wechat-feed-real-1002', sourceVerified: true }
    ];
    const opened = [];
    adapter.openWechatCommentVideoRow = async (_page, row) => {
      opened.push(row.index);
      return { ok: true, reason: 'COMMENT_VIDEO_SELECTED', sourceContext: adapter.wechatCommentVideoContext(row) };
    };
    let sourceContext = null;
    adapter.extractMessages = async (_page, _type, _payload, options) => {
      sourceContext = options.sourceContext;
      return [{ externalId: 'wechat-comment-one', context: options.sourceContext }];
    };
    const result = await adapter.collectWechatChannelComments({}, {});
    assert.equal(result.ok, true);
    assert.deepEqual(opened, [0]);
    assert.equal(result.messages.length, 1);
    assert.equal(sourceContext.sourceVideoTitle, '\u793e\u533a\u6d3b\u52a8\u62a5\u540d\u6307\u5357');
    assert.equal(sourceContext.sourceVideoTime, '2026/08/07 08:59');
    assert.equal(sourceContext.sourceVideoKey, 'wechat-feed-real-1001');
    assert.equal(sourceContext.sourceVerified, true);
    assert.ok(sourceContext.sourceVideoLegacyKey);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('wechat channels title and time remain legacy identity and never become a stable sourceVideoKey', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-comment-legacy-video-key-'));
  try {
    const adapter = new WechatChannelsAssistedRpaAdapter({ platformCode: 'wechat_channels', logsDir: dir, profileDir: path.join(dir, 'profile'), executablePath: '', loginTimeoutMs: 1000, sendTimeoutMs: 1000 });
    const context = adapter.wechatCommentVideoContext({
      index: 0,
      visible: true,
      title: '\u53ea\u6709\u6807\u9898\u7684\u4f5c\u54c1',
      time: '2026/08/07 08:59',
      text: '\u53ea\u6709\u6807\u9898\u7684\u4f5c\u54c1 1',
      count: 1
    });
    assert.equal(context.sourceVideoKey, null);
    assert.equal(context.sourceVerified, false);
    assert.ok(context.sourceVideoLegacyKey);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('wechat channels positive comment count never becomes successful zero collection', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-comment-positive-unloaded-'));
  try {
    const adapter = new WechatChannelsAssistedRpaAdapter({ platformCode: 'wechat_channels', logsDir: dir, profileDir: path.join(dir, 'profile'), executablePath: '', loginTimeoutMs: 1000, sendTimeoutMs: 1000 });
    adapter.readWechatCommentVideoRows = async () => [{ index: 0, visible: true, title: '\u76ee\u6807\u4f5c\u54c1', time: '2026/08/07 08:59', text: '\u76ee\u6807\u4f5c\u54c1 1', count: 1 }];
    adapter.openWechatCommentVideoRow = async (_page, row) => ({ ok: false, reason: 'COMMENT_VIDEO_ITEMS_TIMEOUT', row });
    const result = await adapter.collectWechatChannelComments({}, {});
    assert.equal(result.ok, false);
    assert.equal(result.messages.length, 0);
    assert.equal(result.reason, 'COMMENT_VIDEO_COLLECTION_INCOMPLETE');
    assert.equal(result.videoResults[0].status, 'NEEDS_CONFIRMATION');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('wechat channels reply reopens the uniquely matched source video before locating the comment', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-comment-video-reply-'));
  try {
    const adapter = new WechatChannelsAssistedRpaAdapter({ platformCode: 'wechat_channels', logsDir: dir, profileDir: path.join(dir, 'profile'), executablePath: '', loginTimeoutMs: 1000, sendTimeoutMs: 1000 });
    const rows = [
      { index: 0, visible: true, title: '\u5176\u4ed6\u4f5c\u54c1', time: '2026/08/06 08:00', text: '\u5176\u4ed6\u4f5c\u54c1 1', count: 1, sourceVideoKey: 'wechat-feed-real-other', sourceVerified: true },
      { index: 1, visible: true, title: '\u76ee\u6807\u4f5c\u54c1', time: '2026/08/07 08:59', text: '\u76ee\u6807\u4f5c\u54c1 1', count: 1, sourceVideoKey: 'wechat-feed-real-target', sourceVerified: true }
    ];
    adapter.readWechatCommentVideoRows = async () => rows;
    let openedIndex = null;
    adapter.openWechatCommentVideoRow = async (_page, row) => { openedIndex = row.index; return { ok: true, row, sourceContext: adapter.wechatCommentVideoContext(row) }; };
    const targetContext = adapter.wechatCommentVideoContext(rows[1]);
    assert.equal(targetContext.sourceVideoKey, 'wechat-feed-real-target');
    assert.equal(targetContext.sourceVerified, true);
    const result = await adapter.openWechatCommentVideoForPayload({}, { messageContext: targetContext });
    assert.equal(result.ok, true);
    assert.equal(openedIndex, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('wechat channels collection preserves the structured comment empty reason', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-comment-empty-collect-'));
  try {
    const adapter = new WechatChannelsAssistedRpaAdapter({ platformCode: 'wechat_channels', logsDir: dir, profileDir: path.join(dir, 'profile'), executablePath: '', loginTimeoutMs: 1000, sendTimeoutMs: 1000 });
    const page = {
      url: () => PLATFORM_ASSISTED_SPECS.wechat_channels.commentUrl,
      locator: () => ({ allInnerTexts: async () => ['comment overview'], evaluateAll: async () => [] })
    };
    adapter.getPage = async () => page;
    adapter.prepareMessagePage = async () => ({ requestedUrl: page.url(), finalUrl: page.url(), attempts: 1 });
    adapter.inspectLoginState = async () => ({ state: 'READY', evidence: ['authenticated'] });
    adapter.waitForMessageContentReady = async () => ({
      ready: true,
      empty: true,
      reason: 'COMMENT_EMPTY_ALL_VIDEO_COUNTS_ZERO',
      pageCheck: { valid: true, reason: 'VERIFIED', evidence: ['message-url-matched', 'message-text-matched'] },
      wechatCommentEvidence: { confirmedEmpty: true, totalVideoCount: 3, videoRowCount: 3 }
    });
    adapter.extractMessages = async () => [];
    adapter.evidence = async (_payload, message, evidencePage, stage, extra = {}) => ({ message, stage, url: evidencePage.url(), ...extra });

    const result = await adapter.collectMessages({ types: ['COMMENT'], profileName: 'profile-channels-main' });
    assert.equal(result.status, 'SUCCESS');
    assert.equal(result.result.typeResults[0].reason, 'COMMENT_EMPTY_ALL_VIDEO_COUNTS_ZERO');
    assert.equal(result.result.typeResults[0].empty, true);
    assert.equal(result.result.typeResults[0].readinessReason, 'COMMENT_EMPTY_ALL_VIDEO_COUNTS_ZERO');
    assert.equal(result.result.typeResults[0].wechatCommentEvidence.totalVideoCount, 3);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});


test('execution guard defers stopped platform jobs without resolving adapters', async () => {
  const calls = { defer: 0, resolve: 0, execute: 0 };
  const job = { id: 101, payload: { platformCode: 'xiaohongshu' } };
  let deferredRuntime = null;
  const result = await executeClaimedJobWithPlatformGuard({
    job,
    getRuntime: async () => ({ code: 'xiaohongshu', desired_state: 'STOPPED', effective_state: 'STOPPED', blocked_reason: 'PLATFORM_STOPPED' }),
    deferJob: async (_job, runtime) => { calls.defer += 1; deferredRuntime = runtime; },
    resolveAdapter: () => { calls.resolve += 1; return {}; },
    executeAdapter: async () => { calls.execute += 1; return { status: 'SUCCESS' }; }
  });

  assert.equal(result.deferred, true);
  assert.equal(result.output, null);
  assert.equal(deferredRuntime.blocked_reason, 'PLATFORM_STOPPED');
  assert.deepEqual(calls, { defer: 1, resolve: 0, execute: 0 });
});

test('execution guard fails closed when platform runtime control is unavailable', async () => {
  const calls = { defer: 0, resolve: 0, execute: 0 };
  const job = { id: 102, payload: { platformCode: 'weibo' } };
  let deferredRuntime = null;
  const result = await executeClaimedJobWithPlatformGuard({
    job,
    getRuntime: async () => { throw new Error('runtime endpoint unavailable'); },
    deferJob: async (_job, runtime) => { calls.defer += 1; deferredRuntime = runtime; },
    resolveAdapter: () => { calls.resolve += 1; return {}; },
    executeAdapter: async () => { calls.execute += 1; return { status: 'SUCCESS' }; }
  });

  assert.equal(result.deferred, true);
  assert.equal(result.runtime.effective_state, 'STOPPED');
  assert.equal(deferredRuntime.blocked_reason, 'CONTROL_UNAVAILABLE');
  assert.match(deferredRuntime.message, /runtime endpoint unavailable/);
  assert.deepEqual(calls, { defer: 1, resolve: 0, execute: 0 });
});


test('platform runtime controls expose a dedicated navigation entry', () => {
  const appSource = fs.readFileSync(path.resolve(import.meta.dirname, '../public/app.js'), 'utf8');
  const indexSource = fs.readFileSync(path.resolve(import.meta.dirname, '../public/index.html'), 'utf8');
  assert.equal(appSource.includes("['platforms','accounts','平台启停'"), true);
  assert.match(appSource, /platforms:renderPlatformRuntimePage/);
  assert.match(appSource, /data-go="platforms">平台启停/);
  assert.doesNotMatch(appSource, /data-go="issues">查看待处理问题/);
  assert.doesNotMatch(appSource, /metric\('系统问题'/);
  assert.doesNotMatch(appSource, /metric\('待补充知识'/);
  assert.match(appSource, /grid cols-3 metric-grid/);
  assert.doesNotMatch(appSource, /metric\('进行中任务'/);
  assert.match(appSource, /metric\('转人工记录',s\.handoffRecords,'已创建的人工接管通知'/);
  assert.match(appSource, /metric\('转人工记录',[\s\S]*'handoffs'/);
  assert.match(appSource, /metric\('AI 已回复',s\.autoReplies,'自动处理完成'/);
  assert.match(appSource, /今日 AI 用量/);
  assert.match(appSource, /s\.aiUsageToday/);
  assert.match(appSource, /五个平台独立启停/);
  assert.match(appSource, /未开启平台绝不唤醒/);
  assert.match(appSource, /platform-account-toggle/);
  assert.match(indexSource, /20260917-intellidriven-operations-workspace/);
});


test('web access browser control console is exposed with read-only commands and safety boundaries', () => {
  const appSource = fs.readFileSync(path.resolve(import.meta.dirname, '../public/app.js'), 'utf8');
  const stylesSource = fs.readFileSync(path.resolve(import.meta.dirname, '../public/styles.css'), 'utf8');
  assert.equal(appSource.includes("['browser','browser','浏览器控制'"), true);
  assert.match(appSource, /browser:renderBrowserControl/);
  assert.match(appSource, /\/api\/browser-control\/summary/);
  assert.match(appSource, /\/api\/browser-control\/commands/);
  assert.match(appSource, /Web Access CDP/);
  assert.match(appSource, /BROWSER_CONTROL_ENABLED/);
  assert.match(appSource, /Web Access 浏览器主控中心/);
  assert.match(appSource, /Playwright CDP 兼容层/);
  assert.doesNotMatch(appSource, /Web Access 是增量 Provider/);
  assert.doesNotMatch(appSource, /<option value="CLICK">/);
  assert.doesNotMatch(appSource, /<option value="SET_FILES">/);
  assert.match(stylesSource, /\.browser-console-hero/);
});


test('admin logout clears sensitive workspace DOM, transient state, and refresh timer', () => {
  const appSource = fs.readFileSync(path.resolve(import.meta.dirname, '../public/app.js'), 'utf8');
  assert.equal(appSource.includes('function clearWorkspaceSession(){'), true);
  assert.equal(appSource.includes('clearInterval(refreshTimer);refreshTimer=null'), true);
  assert.equal(appSource.includes("shell.hidden=true;shell.setAttribute('aria-hidden','true')"), true);
  assert.equal(appSource.includes('session-cleared'), true);
  assert.equal(appSource.includes('smokeSelectedId'), false);
  assert.equal(appSource.includes('knowledgeImportPreview:null'), true);
  assert.equal(appSource.includes('retryDraft:null'), true);
  assert.equal(appSource.includes("shell.hidden=false;shell.removeAttribute('aria-hidden')"), true);
  assert.equal(appSource.includes('showLoginScreen('), true);
});


test('publish UI shows blocked platform reasons while only selecting task-executable accounts', () => {
  const appSource = fs.readFileSync(path.resolve(import.meta.dirname, '../public/app.js'), 'utf8');
  const indexSource = fs.readFileSync(path.resolve(import.meta.dirname, '../public/index.html'), 'utf8');
  assert.match(appSource, /function publishPlatformAccounts\(\)/);
  assert.match(appSource, /function publishPlatformAvailability\(account\)/);
  assert.match(appSource, /function runnablePublishAccounts\(\)/);
  assert.match(appSource, /runtimeByPlatform\.get\(account\.platform_code\)\?\.task_execution_state==='RUNNING'/);
  assert.match(appSource, /platform-check:not\(:disabled\)/);
  assert.match(appSource, /ACTIVE_ISSUE_BLOCK/);
  assert.match(appSource, /\u95ee\u9898\u6c47\u603b/);
  assert.doesNotMatch(appSource, /AI \u81ea\u68c0/);
  assert.doesNotMatch(appSource, /Smoke \u57fa\u7ebf\u5f85\u786e\u8ba4|\u9875\u9762\u5de1\u68c0/);
  assert.match(appSource, /function selectedTargets\(\)[\s\S]*runnablePublishAccounts\(\)[\s\S]*filter\(target=>runnableKeys\.has/);
  assert.match(appSource, /id="enableAllPlatforms"/);
  assert.match(appSource, /\/api\/platforms\/runtime\/start-all/);
  assert.match(appSource, /startAllPlatforms\(enableAll\)/);
  assert.match(appSource, /id="openSelectedPlatforms"/);
  assert.match(appSource, /batchPlatformAction\('open',openSelected\)/);
  assert.match(appSource, /\/platforms\/\$\{action==='open'\?'open-login':'check-login'\}/);
  assert.match(appSource, /\\u4e00\\u952e\\u6253\\u5f00\\u6240\\u9009\\u5e73\\u53f0/);
  assert.match(appSource, /\/platforms\/\$\{platformCode\}\/open-manual-action/);
  assert.match(appSource, /\/api\/publish\/targets\/\$\{targetId\}\/manual-published/);
  assert.match(appSource, /id="stopAllPlatforms"/);
  assert.match(appSource, /\/api\/platforms\/runtime\/stop-all/);
  assert.match(indexSource, /20260917-intellidriven-operations-workspace/);
});


test('queued platform operation is cancelled when global or platform control stops before execution', async () => {
  const control = {
    masterSwitch: { enabled: true },
    platforms: [
      { code: 'douyin', desired_state: 'RUNNING', effective_state: 'RUNNING' },
      { code: 'wechat_channels', desired_state: 'RUNNING', effective_state: 'RUNNING' }
    ]
  };
  const stopped = [];
  const coordinator = new PlatformOperationCoordinator({
    fetchControl: async () => control,
    onStopped: async codes => { stopped.push(...codes); }
  });
  await coordinator.update(control);

  let releaseFirst;
  let firstStarted;
  const firstStartedPromise = new Promise(resolve => { firstStarted = resolve; });
  const first = coordinator.run('douyin', async () => {
    firstStarted();
    await new Promise(resolve => { releaseFirst = resolve; });
    return 'done';
  });
  await firstStartedPromise;

  let queuedAdapterCalls = 0;
  const queued = coordinator.run('douyin', async () => {
    queuedAdapterCalls += 1;
  });
  await new Promise(resolve => setImmediate(resolve));

  control.masterSwitch = { enabled: false };
  await coordinator.update(control);
  releaseFirst();
  assert.equal(await first, 'done');
  await assert.rejects(queued, error => ['PLATFORM_STOPPED', 'PLATFORM_OPERATION_CANCELLED'].includes(error.code));
  assert.equal(queuedAdapterCalls, 0, 'stopped queued operation must never call the adapter');
  assert.deepEqual(new Set(stopped), new Set(['douyin', 'wechat_channels']));
});

test('different platform operations run concurrently while each platform remains independently serialized', async () => {
  const control = {
    masterSwitch: { enabled: true },
    platforms: [
      { code: 'douyin', desired_state: 'RUNNING', effective_state: 'RUNNING' },
      { code: 'wechat_channels', desired_state: 'RUNNING', effective_state: 'RUNNING' }
    ]
  };
  const coordinator = new PlatformOperationCoordinator({ fetchControl: async () => control });
  await coordinator.update(control);

  let releaseDouyin;
  let douyinStarted;
  const douyinStartedPromise = new Promise(resolve => { douyinStarted = resolve; });
  const douyin = coordinator.run('douyin', async () => {
    douyinStarted();
    await new Promise(resolve => { releaseDouyin = resolve; });
    return 'douyin-done';
  });
  await douyinStartedPromise;

  let channelsStarted = false;
  const channels = coordinator.run('wechat_channels', async () => {
    channelsStarted = true;
    return 'channels-done';
  });
  assert.equal(await channels, 'channels-done');
  assert.equal(channelsStarted, true, 'a different platform must not wait for the douyin queue');

  releaseDouyin();
  assert.equal(await douyin, 'douyin-done');
});

test('Local Agent starts platform/channel workers while preserving cross-platform parallelism', () => {
  const source = fs.readFileSync(path.resolve(import.meta.dirname, '../agent/local-agent.js'), 'utf8');
  assert.match(source, /async function platformWorkerLoop\(\{ platformCode, name, queueLanes = null \}\)/);
  assert.match(source, /await claim\(\[platformCode\], \{ queueLanes \}\)/);
  assert.match(source, /platformWorkerPlans\(platformCode, \{ splitEnabled: platformChannelSplitEnabled\(platformCode\) \}\)/);
  assert.match(source, /Promise\.all\(\[controlLoop\(\), \.\.\.workerPlans\.map\(platformWorkerLoop\)\]\)/);
  assert.match(source, /const activeJobCountsByPlatform = new Map\(\)/);
  assert.match(source, /function platformHasActiveJob\(platformCode\)/);
  assert.match(source, /const pollableCodes = desiredCodes\.filter/);
  assert.match(source, /if \(config\.loginStatusPollEnabled && loginPollingGate\.isDue\(\)\)/);
  assert.doesNotMatch(source, /activeJobCount === 0 && config\.loginStatusPollEnabled/);
});

test('master switch is a hard local gate and enabling it is required before operations can run', async () => {
  const control = {
    masterSwitch: { enabled: false },
    platforms: [{ code: 'wechat_channels', desired_state: 'RUNNING', effective_state: 'RUNNING' }]
  };
  const coordinator = new PlatformOperationCoordinator({ fetchControl: async () => control });
  await coordinator.update(control);
  assert.deepEqual(coordinator.runnablePlatformCodes(), []);
  await assert.rejects(coordinator.run('wechat_channels', async () => {}), error => error.code === 'PLATFORM_STOPPED');

  let adapterCalls = 0;
  control.masterSwitch = { enabled: true };
  const result = await coordinator.run('wechat_channels', async () => { adapterCalls += 1; return 'opened'; });
  assert.equal(result, 'opened');
  assert.equal(adapterCalls, 1);
});

test('sender identity gate prioritizes explicit markers and stable platform IDs', () => {
  assert.equal(assessCollectedMessageIdentity({ data: { context: { actorIsSelf: true } } }).isSelf, true);
  assert.equal(assessCollectedMessageIdentity({
    data: { userName: 'same-name', context: { actorPlatformId: '200', accountPlatformId: '100', accountUserName: 'same-name' } }
  }).isSelf, false);
  assert.equal(assessCollectedMessageIdentity({
    data: { context: { actorMid: '99', accountPlatformId: '99' } }
  }).evidence, 'PLATFORM_USER_ID_MATCH');
  assert.equal(assessCollectedMessageIdentity({
    data: { context: { actorRole: 'OFFICIAL', actorBadge: '\u5b98\u65b9' } }
  }).isSelf, false, 'generic official verification is not proof that the message belongs to the current account');
});

test('sender identity gate accepts exact account name but never fuzzy name matching', () => {
  assert.equal(assessCollectedMessageIdentity({
    data: { userName: '\u4e5d\u9f84\u4e4b\u9152', context: { accountUserName: '\u4e5d\u9f84\u4e4b\u9152' } }
  }).evidence, 'EXACT_ACCOUNT_NAME_MATCH');
  assert.equal(assessCollectedMessageIdentity({
    data: { userName: '\u4e5d\u9f84\u4e4b\u9152\u7c89\u4e1d', context: { accountUserName: '\u4e5d\u9f84\u4e4b\u9152' } }
  }).isSelf, false);
});

test('sender identity gate recognizes only same-scope recent outgoing reply echoes', () => {
  const replyText = '\u60a8\u597d\uff0c\u5468\u516d09:00\u201417:00\u5f00\u653e\u3002';
  const outgoing = {
    id: 62, message_type: 'COMMENT', reply_text: replyText,
    context_json: JSON.stringify({ sourceVideoKey: 'video-1' }),
    handled_at: '2026-08-08T02:20:00.000Z'
  };
  const sameScope = assessCollectedMessageIdentity({
    data: { messageType: 'COMMENT', content: ` ${replyText} `, context: { sourceVideoKey: 'video-1' } },
    recentOutgoingReplies: [outgoing], collectedAt: '2026-08-08T02:24:00.000Z'
  });
  assert.equal(sameScope.evidence, 'RECENT_OUTGOING_REPLY_ECHO');
  assert.equal(sameScope.matchedMessageId, 62);
  assert.equal(assessCollectedMessageIdentity({
    data: { messageType: 'COMMENT', content: replyText, context: { sourceVideoKey: 'video-2' } },
    recentOutgoingReplies: [outgoing], collectedAt: '2026-08-08T02:24:00.000Z'
  }).isSelf, false);
  assert.equal(normalizeEchoContent('\uff21  \uff22'), 'A B');
});

test('sender identity uses the current account instead of a previous login nickname', () => {
  const account = { platform_user_name: '天河港澳社区', platform_user_aliases: JSON.stringify(['九龄之酒', '天河港澳社区']) };
  for (const context of [{}, { accountUserName: '天河港澳社区' }]) {
    const result = assessCollectedMessageIdentity({ data: { userName: '九龄之酒', content: '什么是七免两低？', context }, account });
    assert.equal(result.isSelf, false);
  }
  assert.equal(assessCollectedMessageIdentity({
    data: { userName: '九龄之酒', context: { accountUserName: '天河港澳社区' } },
    account: { platform_user_name: '九龄之酒' }
  }).isSelf, false, 'fresh page identity takes precedence over the stored previous account');
  assert.equal(assessCollectedMessageIdentity({ data: { userName: '天河港澳社区' }, account }).isSelf, true);
});

test('wechat channels recognizes the greeting inbox explicit empty message', () => {
  const text = '私信 打招呼消息 全部消息 暂无打招呼消息 视频号助手 · 打招呼';
  assert.equal(PLATFORM_ASSISTED_SPECS.wechat_channels.privateEmptyTextPattern.test('暂无打招呼消息'), true);
  const evidence = { url: PLATFORM_ASSISTED_SPECS.wechat_channels.messageUrl, text, panelVisible: true, sessionRows: [] };
  const result = assessWechatPrivateMessageEvidence(evidence);
  assert.equal(result.ready, true);
  assert.equal(result.empty, true);
  assert.equal(result.reason, 'PRIVATE_EMPTY_UNCOUNTED');
  assert.equal(assessWechatPrivateMessageEvidence({ ...evidence, declaredSessionTotal: 1 }).ready, false);
  assert.equal(assessWechatPrivateMessageEvidence({ ...evidence, text: `${text} 消息同步中` }).ready, false);
});


test('AI 自检不会把 contenteditable 选择器误判为内容被拒绝', () => {
  const context = {
    issue: { id: 1, title: '抖音采集失败', detail: 'network timeout before any write', block_scope: 'ACCOUNT' },
    originalResult: { message: 'network timeout before any write', submitAttempted: false, sendAttempted: false },
    platformCode: 'douyin'
  };
  const evidence = {
    message: '模拟只读诊断取证完成',
    pages: [{ name: '评论管理页', selectorHits: { '[contenteditable="true"]': true } }]
  };
  const diagnosis = deterministicDiagnosis(context, evidence);
  assert.equal(diagnosis.category, 'NETWORK_ERROR');
  assert.equal(diagnosis.safeToRetry, true);
});

test('AI 自检仍能识别明确的内容拒绝证据', () => {
  const diagnosis = deterministicDiagnosis({
    issue: { id: 2, title: '发布失败', detail: '平台审核失败：content_rejected', block_scope: 'TASK' },
    originalResult: { message: 'content rejected by platform', submitAttempted: false }
  }, {});
  assert.equal(diagnosis.category, 'CONTENT_REJECTED');
  assert.equal(diagnosis.safeToRetry, false);
});



test('发布上传超时会按素材大小动态估算，并限制在安全上下限内', () => {
  const options = {
    minTimeoutMs: 600_000,
    maxTimeoutMs: 1_800_000,
    minBytesPerSecond: 262_144,
    processingGraceMs: 180_000
  };
  assert.equal(uploadTimeoutMsForSize(1_024, options), 600_000);
  assert.equal(uploadTimeoutMsForSize(146_347_823, options), 738_273);
  assert.equal(uploadTimeoutMsForSize(10 * 1024 * 1024 * 1024, options), 1_800_000);
});

test('发布上传超时在文件缺失和反向上下限配置下仍保持安全', () => {
  assert.equal(resolveUploadTimeoutMs(path.join(os.tmpdir(), `missing-upload-${Date.now()}.mp4`), {
    minTimeoutMs: 600_000,
    maxTimeoutMs: 300_000
  }), 600_000);
  assert.equal(uploadTimeoutMsForSize(800 * 1024 * 1024, {
    minTimeoutMs: 600_000,
    maxTimeoutMs: 300_000,
    minBytesPerSecond: 262_144,
    processingGraceMs: 180_000
  }), 600_000);
});


test('知识导入人工选择固定大类后解除大类错误，并提供清空预览入口', () => {
  const appSource = fs.readFileSync(path.resolve(import.meta.dirname, '../public/app.js'), 'utf8');
  const styleSource = fs.readFileSync(path.resolve(import.meta.dirname, '../public/styles.css'), 'utf8');
  assert.match(appSource, /function isKnowledgeImportCategoryError/);
  assert.match(appSource, /请选择知识大类/);
  assert.match(appSource, /item\.errors=\(item\.errors\|\|\[\]\)\.filter\(error=>!isKnowledgeImportCategoryError\(error\)\)/);
  assert.match(appSource, /item\.importable=\(item\.errors\|\|\[\]\)\.length===0&&item\.matchStatus!==['"]EXACT_DUPLICATE['"]/);
  assert.match(appSource, /id="clearKnowledgeImportPreview"/);
  assert.match(appSource, /clearButton\.disabled=!data/);
  assert.match(appSource, /已清空当前预处理数据/);
  assert.match(styleSource, /\.knowledge-review-actions\{[^}]*white-space:nowrap/);
  assert.match(styleSource, /\.knowledge-clear-preview\{[^}]*min-width:52px[^}]*white-space:nowrap/);
});






test('知识导入流程按真实处理阶段动态变化，扩大人工审核区且预览列表在卡片内滚动', () => {
  const appSource = fs.readFileSync(path.resolve(import.meta.dirname, '../public/app.js'), 'utf8');
  const styleSource = fs.readFileSync(path.resolve(import.meta.dirname, '../public/styles.css'), 'utf8');
  assert.equal(appSource.includes("knowledgeImportStage:'IDLE'"), true);
  assert.equal(appSource.includes('function renderKnowledgeImportFlow()'), true);
  assert.equal(appSource.includes("setKnowledgeImportStage('UPLOADING')"), true);
  assert.equal(appSource.includes("setKnowledgeImportStage('PROCESSING')"), true);
  assert.equal(appSource.includes('setKnowledgeImportStage(knowledgeImportStageForPreview(preview))'), true);
  assert.equal(appSource.includes("setKnowledgeImportStage('COMMITTING')"), true);
  assert.equal(appSource.includes("setKnowledgeImportStage('FAILED',{failedStep})"), true);
  assert.equal(appSource.includes('data-import-step="${step.id}"'), true);
  assert.equal(styleSource.includes('.knowledge-import-workspace{align-items:stretch}'), true);
  assert.equal(styleSource.includes('@media(min-width:1251px){.knowledge-import-workspace{grid-auto-rows:clamp(640px,72vh,760px)}#knowledgeImportPreview>.knowledge-preview-list{min-height:230px}}'), true);
  assert.match(styleSource, /#knowledgeImportPreview\{[^}]*display:flex[^}]*min-height:0[^}]*overflow:hidden/);
  assert.match(styleSource, /#knowledgeImportPreview>\.knowledge-preview-list\{[^}]*flex:1 1 auto[^}]*max-height:none[^}]*overflow-y:auto[^}]*scrollbar-gutter:stable/);
  assert.match(styleSource, /\.knowledge-preview-list\{[^}]*grid-auto-rows:max-content[^}]*align-content:start/);
  assert.equal(styleSource.includes('.knowledge-mini-flow .flow-step.is-active:not(.is-idle) b{animation:knowledgeImportPulse'), true);
});

test('平台回复字数策略区分 Unicode 和网页计数，B站私信安全上限为 480 字符', () => {
  assert.equal(countUnicodeCharacters('测试😊'), 3);
  assert.equal(countUnicodeCharacters('e\u0301'), 1);
  assert.equal(getReplyLimit('bilibili', 'PRIVATE_MESSAGE').publishedMax, 500);
  assert.equal(getReplyLimit('bilibili', 'PRIVATE_MESSAGE').safeMax, 480);
  assert.equal(getReplyLimit('weibo', 'COMMENT').safeMax, 120);
  assert.equal(validateReplyTextLength({ platformCode: 'bilibili', messageType: 'PRIVATE_MESSAGE', text: '字'.repeat(480) }).ok, true);
  assert.equal(validateReplyTextLength({ platformCode: 'bilibili', messageType: 'PRIVATE_MESSAGE', text: '字'.repeat(481) }).ok, false);
});

test('知识库平台限制和 Emoji 归一化不会截断组合 Emoji 或误判爱心变体', () => {
  const family = '👨‍👩‍👧‍👦';
  assert.equal(truncateUnicodeSafely(`A${family}B`, 7), 'A');
  assert.equal(truncateUnicodeSafely(`A${family}B`, 8), `A${family}`);
  assert.equal(normalizeReplyTextForComparison('❤'), normalizeReplyTextForComparison('❤️'));
  assert.equal(knowledgeAnswerPolicy('公共知识库').safeMax, 120);
  assert.equal(knowledgeAnswerPolicy('B站知识库').safeMax, 480);
  assert.equal(validateKnowledgeAnswerLength({ category: '公共知识库', answer: '答'.repeat(121) }).ok, false);
  assert.equal(validateKnowledgeAnswerLength({ category: 'B站知识库', answer: '答'.repeat(480) }).ok, true);
});

test('RPA 在打开浏览器前拦截超过 B站私信安全上限的回复', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bilibili-reply-length-'));
  const adapter = new AssistedPlatformRpaAdapter({ platformCode: 'bilibili', logsDir: dir, profileDir: path.join(dir, 'profile'), executablePath: '', loginTimeoutMs: 1000, sendTimeoutMs: 1000 });
  const result = await adapter.replyToMessage({
    platformCode: 'bilibili',
    accountId: 'account-1',
    messageType: 'PRIVATE_MESSAGE',
    userName: '测试用户',
    sourceContent: '请问怎么报名？',
    replyText: '答'.repeat(481),
    messageContext: { conversationId: 'conversation-1', messageId: 'message-1', direction: 'incoming', previewOnly: false, fullSource: true, sourceVerified: true, chatTitleVerified: true }
  });
  assert.equal(result.status, 'NEEDS_CONFIRMATION');
  assert.equal(result.result.stage, 'reply_length_blocked');
  assert.equal(result.result.characterCount, 481);
  assert.equal(result.result.characterLimit, 480);
});







test('知识大类总览、相似问法库和问题汇总入口只在前端隐藏，后台功能代码保留', () => {
  const appSource = fs.readFileSync(path.resolve(import.meta.dirname, '../public/app.js'), 'utf8');
  const styleSource = fs.readFileSync(path.resolve(import.meta.dirname, '../public/styles.css'), 'utf8');
  assert.match(appSource, /hiddenNavPages=new Set\(\['browser','aliases','issues'\]\)/);
  assert.match(appSource, /knowledge-list-panel knowledge-category-overview/);
  assert.match(styleSource, /\.knowledge-category-overview\{display:none!important\}/);
  assert.match(appSource, /async function renderKnowledgeAliases\(\)/);
  assert.match(appSource, /async function renderIssues\(\)/);
  assert.match(appSource, /\/api\/issues\/\$\{button\.dataset\.id\}\/manual-resolve/);
  assert.match(appSource, /api\('\/api\/knowledge-aliases\?limit=1000'\)/);
  assert.match(appSource, /\/api\/knowledge-aliases\/generate-all/);
});


test('企微机器人与 AI 服务配置默认折叠为单条流光框，并且一次只展开一个配置面板', () => {
  const appSource = fs.readFileSync(path.resolve(import.meta.dirname, '../public/app.js'), 'utf8');
  const styleSource = fs.readFileSync(path.resolve(import.meta.dirname, '../public/styles.css'), 'utf8');
  assert.equal(appSource.includes("wecomCategory:'ALL',settingsConfigPanel:null"), true);
  assert.equal(appSource.includes('class="settings-config-flow-frame'), true);
  assert.equal(appSource.includes('data-settings-config-toggle="wecom"'), true);
  assert.equal(appSource.includes('data-settings-config-toggle="ai"'), true);
  assert.equal(appSource.includes('id="wecomSettingsDrawer"'), true);
  assert.equal(appSource.includes('id="aiSettingsDrawer"'), true);
  assert.equal(appSource.includes('state.settingsConfigPanel=state.settingsConfigPanel===panel?null:panel'), true);
  assert.equal(styleSource.includes('animation:settingsFlowBorder'), true);
  assert.equal(styleSource.includes('@keyframes settingsFlowBorder'), true);
  assert.equal(styleSource.includes('@keyframes settingsFlowGlint'), true);
  assert.equal(appSource.includes('aria-label="${state.settingsConfigPanel===\'wecom\'?\'收起\':\'展开\'}企业微信群机器人配置"'), true);
  assert.equal(appSource.includes('aria-label="${state.settingsConfigPanel===\'ai\'?\'收起\':\'展开\'}AI 服务配置"'), true);
  assert.equal(styleSource.includes('.settings-config-toggle .settings-toggle-copy,.settings-config-toggle .settings-toggle-status,.settings-config-toggle .settings-toggle-action{display:none}'), true);
});



