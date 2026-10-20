import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  BilibiliAssistedRpaAdapter,
  detectBilibiliPendingDraft,
  buildBilibiliCommentReplyForm,
  buildBilibiliPrivateReplyForm,
  extractBilibiliReplyReceipt,
  parseBilibiliCommentFeed,
  parseBilibiliPrivateFeed,
  parseBilibiliDuration,
  parseBilibiliSubmittedAt,
  assessBilibiliManagementRecord,
  isManagedBilibiliDraftState,
  bilibiliDraftContentMatches,
  canSafelyDiscardBilibiliManagedDraft,
  buildBilibiliCommentFeedPageUrl
} from '../agent/rpa-adapters/bilibili-assisted.js';
import { findVisibleTitleRecord } from '../agent/rpa-adapters/assisted-platform.js';
import { buildFormalRagRequest } from '../src/services/formal-rag-routing.js';

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bilibili-flow-'));
  const adapter = new BilibiliAssistedRpaAdapter({
    profileDir: path.join(dir, 'profile'), executablePath: 'chrome', logsDir: path.join(dir, 'logs'),
    loginTimeoutMs: 1, sendTimeoutMs: 1
  });
  adapter.evidence = async (_payload, message, _page, stage, extra = {}) => ({ message, stage, ...extra });
  adapter.preflightManagementReconciliation = async () => ({ checked: true, matched: false });
  adapter.waitForSubmittedManagementRecord = async () => ({
    confirmed: true,
    checked: true,
    matched: true,
    reviewStatus: 'PUBLISHED',
    platformPostId: 'BV1TEST00001',
    platformUrl: 'https://www.bilibili.com/video/BV1TEST00001/'
  });
  adapter.setSubmitAuthorizer(async () => ({ authorized: true, submitLock: 'LOCKED', publishAttemptState: 'SUBMITTING' }));
  return { dir, adapter, close: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const commentResponse = { code: 0, data: { items: [{
  id: 9988, reply_time: 1786000000, user: { mid: 22, nickname: '评论用户' },
  item: { source_content: '请问几点开放？', subject_id: 123, business_id: 1, root_id: 456, source_id: 789, target_id: 456, uri: 'https://www.bilibili.com/video/BV1xx' }
}] } };
const sessionsResponse = { code: 0, data: { session_list: [{ talker_id: 22, session_type: 1, unread_count: 1, ack_seqno: 10, account_info: { name: '私信用户' } }] } };
const privateResponse = { code: 0, data: { messages: [{ sender_uid: 22, receiver_id: 99, msg_type: 1, content: '{"content":"怎么预约？"}', msg_seqno: 13, msg_key: 903, timestamp: 103 }] } };

test('评论通知保留稳定通知ID和精确回复目标', () => {
  const [message] = parseBilibiliCommentFeed(commentResponse);
  assert.equal(message.externalId, 'bili-comment:9988');
  assert.equal(message.context.precision, 'EXACT_API_TARGET');
  assert.deepEqual([message.context.oid, message.context.replyType, message.context.root, message.context.parent], ['123', '1', '456', '789']);
});

test('B站简短评论从通知解析到正式RAG请求保留所属视频主题', () => {
  const entry = commentResponse.data.items[0];
  const [collected] = parseBilibiliCommentFeed({ code: 0, data: { items: [{
    ...entry,
    item: { ...entry.item, source_content: '怎么申请？', title: '澳车北上免抽签申请攻略' }
  }] } });
  for (const source of [{ context: collected.context }, { context_json: JSON.stringify(collected.context) }]) {
    const request = buildFormalRagRequest({ message: {
      id: 122, platform_code: 'bilibili', account_id: 4,
      message_type: collected.messageType, content: collected.content, ...source
    } });
    assert.match(request.query.text, /澳车北上免抽签申请攻略/);
    assert.match(request.query.text, /怎么申请？/);
    assert.deepEqual(request.context, [], '作品主题不能变成虚构的用户历史');
    assert.equal(request.constraints.requireGrounding, true);
  }
});

test('top-level comment notification converts zero root to exact source rpid', () => {
  const [message] = parseBilibiliCommentFeed({ code: 0, data: { items: [{
    id: 1132704905273355,
    user: { mid: 525733880, nickname: 'top-level-user' },
    item: {
      source_content: 'top-level-comment',
      subject_id: 117070909933096,
      business_id: 1,
      root_id: 0,
      source_id: 309704316385,
      target_id: 0
    }
  }] } });
  assert.equal(message.context.root, '309704316385');
  assert.equal(message.context.parent, '309704316385');
  assert.equal(message.context.replyable, true);
  assert.equal(message.context.precision, 'EXACT_API_TARGET');
});

test('comment notification stays read-only when every target rpid is zero or missing', () => {
  const [message] = parseBilibiliCommentFeed({ code: 0, data: { items: [{
    id: 1001,
    user: { mid: 22, nickname: 'incomplete-user' },
    item: { source_content: 'incomplete-comment', subject_id: 123, business_id: 1, root_id: 0, source_id: 0, target_id: 0 }
  }] } });
  assert.equal(message.context.root, null);
  assert.equal(message.context.parent, null);
  assert.equal(message.context.replyable, false);
  assert.equal(message.context.precision, 'READ_ONLY_INCOMPLETE_TARGET');
});

test('私信采集只保留对方未读文本并绑定 talkerId/msgKey', () => {
  const messages = parseBilibiliPrivateFeed({ sessionsResponse, messageResponses: { 22: privateResponse }, selfUid: '99' });
  assert.equal(messages.length, 1);
  assert.equal(messages[0].externalId, 'bili-private:903');
  assert.equal(messages[0].context.talkerId, '22');
  assert.equal(messages[0].context.precision, 'EXACT_API_SESSION_MESSAGE');
});


test('手机端已读但系统水位尚未处理的新私信仍会被采集', () => {
  const readSession = { code: 0, data: { session_list: [{
    talker_id: 22,
    session_type: 1,
    unread_count: 0,
    ack_seqno: 11,
    last_msg_seqno: 11,
    last_msg_key: 903,
    last_msg_time: 103,
    account_info: { name: '已读用户' }
  }] } };
  const messages = parseBilibiliPrivateFeed({
    sessionsResponse: readSession,
    messageResponses: { 22: privateResponse },
    selfUid: '99',
    previousSessionWatermarks: { 22: { seqno: 10, msgKey: '900', timestamp: 100 } }
  });
  assert.equal(messages.length, 1);
  assert.equal(messages[0].externalId, 'bili-private:903');
  assert.equal(messages[0].context.unreadCount, 0);
  assert.equal(messages[0].context.collectedBySystemWatermark, true);
});

test('系统水位已处理的已读私信不会重复采集', () => {
  const messages = parseBilibiliPrivateFeed({
    sessionsResponse: { code: 0, data: { session_list: [{ talker_id: 22, session_type: 1, unread_count: 0, ack_seqno: 11, last_msg_seqno: 11 }] } },
    messageResponses: { 22: privateResponse },
    selfUid: '99',
    previousSessionWatermarks: { 22: { seqno: 13, msgKey: '903', timestamp: 103 } }
  });
  assert.deepEqual(messages, []);
});

test('评论和私信表单要求 CSRF 与正整数精确目标', () => {
  const comment = buildBilibiliCommentReplyForm({ replyText: '第一行\n第二行', messageContext: { oid: '123', replyType: '1', root: '456', parent: '789' } }, 'csrf');
  assert.equal(comment.message, '第一行\n第二行');
  const legacyTopLevel = buildBilibiliCommentReplyForm({ replyText: 'legacy', messageContext: { oid: '123', replyType: '1', root: '0', parent: '789', sourceReplyId: '789', targetReplyId: '0' } }, 'csrf');
  assert.equal(legacyTopLevel.root, '789');
  assert.equal(legacyTopLevel.parent, '789');
  const privateForm = buildBilibiliPrivateReplyForm({ replyText: '收到', messageContext: { talkerId: '22' } }, 'csrf', '99', 123456, 'device');
  assert.equal(privateForm['msg[receiver_id]'], '22');
  assert.throws(() => buildBilibiliCommentReplyForm({ replyText: '误发', messageContext: { oid: '123', replyType: '1', root: '0', parent: '789' } }, 'csrf'), /root/);
});

test('评论和私信 API 仅以对应平台消息ID作为成功回执', () => {
  assert.equal(extractBilibiliReplyReceipt({ code: 0, data: { rpid: 123 } }, 'COMMENT'), '123');
  assert.equal(extractBilibiliReplyReceipt({ code: 0, data: { msg_key: 456 } }, 'PRIVATE_MESSAGE'), '456');
  assert.equal(extractBilibiliReplyReceipt({ code: 0, data: {} }, 'PRIVATE_MESSAGE'), null);
});

test('B站独立发送路径与共享字数策略一致，超长私信在打开浏览器前拦截', async () => {
  const f = fixture();
  try {
    f.adapter.getPage = async () => { assert.fail('超长私信不应打开浏览器'); };
    f.adapter.apiPost = async () => { assert.fail('超长私信不应发送'); };
    const result = await f.adapter.replyToMessage({ messageType: 'PRIVATE_MESSAGE', replyText: '😀'.repeat(240) + '。' });
    assert.equal(result.status, 'NEEDS_CONFIRMATION');
    assert.equal(result.result.stage, 'reply_length_blocked');
    assert.equal(result.result.sendAttempted, false);
    assert.equal(result.result.characterCount, 481);
    assert.equal(result.result.characterLimit, 480);
    const payload = { messageContext: { talkerId: '22' }, replyText: '答'.repeat(480) };
    assert.equal(JSON.parse(buildBilibiliPrivateReplyForm(payload, 'csrf', '99')['msg[content]']).content, payload.replyText);
    assert.throws(() => buildBilibiliPrivateReplyForm({ ...payload, replyText: '答'.repeat(481) }, 'csrf', '99'), /481.*480/);
    assert.throws(() => buildBilibiliCommentReplyForm({ replyText: '答'.repeat(981), messageContext: { oid: '123', replyType: '1', root: '456', parent: '789' } }, 'csrf'), /981.*980/);
  } finally { f.close(); }
});

test('评论与私信采集闭环合并两类 API 结果', async () => {
  const f = fixture();
  try {
    f.adapter.getPage = async () => ({});
    f.adapter.auth = async () => ({ selfUid: '99', csrf: 'csrf' });
    f.adapter.apiGet = async url => url.includes('/x/msgfeed/reply') ? commentResponse : url.includes('get_sessions') ? sessionsResponse : privateResponse;
    const output = await f.adapter.collectMessages({ types: ['COMMENT', 'PRIVATE_MESSAGE'] });
    assert.equal(output.status, 'SUCCESS');
    assert.deepEqual(output.result.messages.map(item => item.messageType), ['COMMENT', 'PRIVATE_MESSAGE']);
    assert.equal(output.result.apiConfirmed, true);
  } finally { f.close(); }
});

test('评论精确回复取得 rpid 后成功，缺回执时需要确认', async () => {
  const f = fixture();
  try {
    f.adapter.getPage = async () => ({});
    f.adapter.auth = async () => ({ selfUid: '99', csrf: 'csrf' });
    f.adapter.apiPost = async () => ({ code: 0, data: { rpid: 7788 } });
    const payload = { messageType: 'COMMENT', replyText: '知识库回复', messageContext: { oid: '123', replyType: '1', root: '456', parent: '789' } };
    const sent = await f.adapter.replyToMessage(payload);
    assert.equal(sent.status, 'SUCCESS');
    assert.equal(sent.result.platformMessageId, '7788');
    f.adapter.apiPost = async () => ({ code: 0, data: {} });
    assert.equal((await f.adapter.replyToMessage(payload)).status, 'NEEDS_CONFIRMATION');
  } finally { f.close(); }
});

test('私信精确回复取得 msg_key 后成功，网络不确定禁止盲目重试', async () => {
  const f = fixture();
  try {
    f.adapter.getPage = async () => ({});
    f.adapter.auth = async () => ({ selfUid: '99', csrf: 'csrf' });
    const payload = { messageType: 'PRIVATE_MESSAGE', replyText: '知识库回复', messageContext: { talkerId: '22' } };
    let sendCalls = 0;
    f.adapter.apiPost = async (_url, form) => {
      sendCalls += 1;
      assert.equal(form['msg[receiver_id]'], '22');
      assert.equal(form['msg[sender_uid]'], '99');
      assert.equal(JSON.parse(form['msg[content]']).content, '知识库回复');
      return { code: 0, data: { msg_key: 8899 } };
    };
    assert.equal((await f.adapter.replyToMessage(payload)).status, 'SUCCESS');
    assert.equal(sendCalls, 1);
    sendCalls = 0;
    f.adapter.apiPost = async () => { sendCalls += 1; throw new Error('connection reset'); };
    const uncertain = await f.adapter.replyToMessage(payload);
    assert.equal(uncertain.status, 'NEEDS_CONFIRMATION');
    assert.equal(uncertain.result.sendAttempted, true);
    assert.equal(uncertain.result.verified, false);
    assert.equal(sendCalls, 1);
  } finally { f.close(); }
});

test('发布保护已有草稿，且 AUTO 未获最终确认不得点击', async () => {
  const f = fixture();
  const materialPath = path.join(f.dir, 'video.mp4'); fs.writeFileSync(materialPath, 'x');
  try {
    const page = { async goto() {}, async waitForTimeout() {} };
    f.adapter.getPage = async () => page;
    f.adapter.waitForReady = async () => true;
    let prepared = 0; let clicked = 0;
    f.adapter.prepareDraft = async () => { prepared += 1; return { readiness: { ready: true } }; };
    f.adapter.findFinalPublishControl = async () => ({ status: 'UNIQUE', locator: { async click() { clicked += 1; } } });
    f.adapter.inspectPendingDraft = async () => ({ blocked: true, count: 1 });
    const blocked = await f.adapter.publish({ materialPath, publishMode: 'AUTO', managementConfirmed: true, contentOrigin: 'HUMAN_ORIGINAL' });
    assert.equal(blocked.result.stage, 'existing_draft_blocked'); assert.equal(prepared, 0);
    f.adapter.inspectPendingDraft = async () => ({ blocked: false });
    const unauthorized = await f.adapter.publish({ materialPath, publishMode: 'AUTO', managementConfirmed: false, contentOrigin: 'HUMAN_ORIGINAL' });
    assert.equal(unauthorized.status, 'NEEDS_CONFIRMATION'); assert.equal(clicked, 0);
  } finally { f.close(); }
});

test('Bilibili succeeds only after the management page confirms the submitted record', async () => {
  const f = fixture();
  const materialPath = path.join(f.dir, 'video.mp4'); fs.writeFileSync(materialPath, 'x');
  try {
    let clicked = 0;
    f.adapter.getPage = async () => ({ async goto() {}, async waitForTimeout() {} });
    f.adapter.waitForReady = async () => true;
    f.adapter.inspectPendingDraft = async () => ({ blocked: false });
    f.adapter.prepareDraft = async () => ({ readiness: { ready: true } });
    f.adapter.findFinalPublishControl = async () => ({ status: 'UNIQUE', locator: { async click() { clicked += 1; } } });
    f.adapter.waitForPublishSignal = async () => ({ confirmed: true, source: 'success-toast' });
    const output = await f.adapter.publish({ materialPath, publishMode: 'AUTO', managementConfirmed: true, contentOrigin: 'HUMAN_ORIGINAL' });
    assert.equal(output.status, 'SUCCESS'); assert.equal(clicked, 1); assert.equal(output.result.submitAttempted, true);
    assert.equal(output.result.platformPostId, 'BV1TEST00001');
    assert.equal(output.result.managementVerification.confirmed, true);
  } finally { f.close(); }
});

test('停止态在打开浏览器前硬阻断 B站操作', async () => {
  const f = fixture();
  try {
    let opened = false;
    f.adapter.setRuntimeGuard(async () => { const error = new Error('stopped'); error.code = 'PLATFORM_STOPPED'; throw error; });
    f.adapter.getPage = async () => { opened = true; return {}; };
    await assert.rejects(() => f.adapter.replyToMessage({ messageType: 'PRIVATE_MESSAGE', replyText: '不应发送', messageContext: { talkerId: '22' } }), error => error.code === 'PLATFORM_STOPPED');
    assert.equal(opened, false);
  } finally { f.close(); }
});



test('Bilibili recognizes the current success copy and count-suffixed review tabs', () => {
  const f = fixture();
  try {
    assert.equal(f.adapter.spec.successPattern.test('\u7a3f\u4ef6\u6295\u9012\u6210\u529f'), true);
    const published = f.adapter.spec.verifyTabs.find(tab => tab.reviewStatus === 'PUBLISHED');
    const reviewing = f.adapter.spec.verifyTabs.find(tab => tab.reviewStatus === 'REVIEWING');
    assert.ok(published.labels.some(label => label.test('\u5df2\u901a\u8fc7 1')));
    assert.ok(reviewing.labels.some(label => label.test('\u8fdb\u884c\u4e2d 0')));
  } finally { f.close(); }
});


test('Bilibili upload spec targets only the primary upload wrapper and the exact immediate-submit action', () => {
  const f = fixture();
  try {
    assert.deepEqual(f.adapter.spec.fileChooserLabels, []);
    assert.deepEqual(f.adapter.spec.fileChooserSelectors, []);
    assert.equal(f.adapter.spec.allowGenericFileInputFallback, false);
    assert.ok(f.adapter.spec.fileSelectors.length > 0);
    assert.ok(f.adapter.spec.fileSelectors.every(selector => selector.startsWith('.bcc-upload-wrapper input[type="file"]')));
    assert.ok(f.adapter.spec.fileSelectors.some(selector => selector.includes('accept*=".mp4"')));
    assert.equal(f.adapter.spec.fileSelectors.some(selector => selector.includes('name="buploader"')), false);
    assert.deepEqual(f.adapter.spec.publishLabels, ['\u7acb\u5373\u6295\u7a3f']);
    assert.equal(f.adapter.spec.publishLabels.includes('\u5b58\u8349\u7a3f'), false);
  } finally { f.close(); }
});

test('Bilibili waits for the primary upload wrapper instead of using preload inputs', async () => {
  const f = fixture();
  try {
    let waits = 0;
    f.adapter.runtimeCheckpoint = async () => 0;
    const activeInput = {
      async evaluate() {
        return { connected: true, disabled: false, accept: '.mp4,.mov', insidePrimaryWrapper: true };
      }
    };
    const emptyInput = { async evaluate() { return null; } };
    const scope = {
      locator(selector) {
        const primary = selector.includes('accept*=".mp4"');
        return {
          async count() { return primary && waits > 0 ? 1 : 0; },
          nth() { return primary && waits > 0 ? activeInput : emptyInput; }
        };
      }
    };
    const page = {
      frames() { return [scope]; },
      async waitForTimeout() { waits += 1; }
    };
    const result = await f.adapter.waitForPrimaryVideoUploadInput(page, 0, 1000);
    assert.equal(result.ready, true);
    assert.equal(result.selector, f.adapter.spec.fileSelectors[0]);
    assert.equal(waits, 1);
  } finally { f.close(); }
});

test('Bilibili does not report success from a toast when management has no matching record', async () => {
  const f = fixture();
  const materialPath = path.join(f.dir, 'toast-only.mp4'); fs.writeFileSync(materialPath, 'x');
  try {
    let clicked = 0;
    f.adapter.getPage = async () => ({ async goto() {}, async waitForTimeout() {} });
    f.adapter.waitForReady = async () => true;
    f.adapter.inspectPendingDraft = async () => ({ blocked: false });
    f.adapter.prepareDraft = async () => ({ readiness: { ready: true } });
    f.adapter.findFinalPublishControl = async () => ({ status: 'UNIQUE', locator: { async click() { clicked += 1; } } });
    f.adapter.waitForPublishSignal = async () => ({ confirmed: true, source: 'success-toast' });
    f.adapter.waitForSubmittedManagementRecord = async () => ({ confirmed: false, checked: true, matched: false });
    const output = await f.adapter.publish({ taskId: 18, targetId: 19, title: 'toast-only-video', materialPath, publishMode: 'AUTO', managementConfirmed: true, contentOrigin: 'HUMAN_ORIGINAL', draftFingerprint: { fingerprintHash: 'fp-toast-only' } });
    assert.equal(clicked, 1);
    assert.equal(output.status, 'NEEDS_CONFIRMATION');
    assert.equal(output.result.submissionStatus, 'UNKNOWN');
    assert.equal(output.result.publishSignal, 'success-toast');
    assert.equal(f.adapter.readDraftFingerprintState().state, 'SUBMIT_ATTEMPTED');
  } finally { f.close(); }
});

test('Bilibili content declaration must be readable after selecting an option', async () => {
  const f = fixture();
  try {
    const declarationPrompt = '\u8bf7\u9009\u62e9\u7b26\u5408\u60a8\u89c6\u9891\u5185\u5bb9\u7684\u521b\u4f5c\u58f0\u660e';
    const aiLabel = '\u542bAI\u751f\u6210\u5185\u5bb9';
    const hiddenTrigger = { async isVisible() { return false; }, async click() {} };
    const activeTrigger = {
      async isVisible() { return true; }, async click() {}, async inputValue() { return ''; },
      locator() { return { async innerText() { return ''; } }; }
    };
    const option = { async isVisible() { return true; }, async innerText() { return aiLabel; }, async click() {} };
    let locatorCalls = 0;
    const page = {
      locator() { locatorCalls += 1; return { first() { return locatorCalls === 1 ? activeTrigger : hiddenTrigger; }, filter() { return this; } }; },
      getByText(label) {
        if (label === declarationPrompt) return { first() { return hiddenTrigger; } };
        return { first() { return hiddenTrigger; }, async count() { return label === aiLabel ? 1 : 0; }, nth() { return option; } };
      },
      async waitForTimeout() {}
    };
    await assert.rejects(
      () => f.adapter.applyContentDeclaration(page, { contentOrigin: 'AI_GENERATED' }),
      error => error.message.includes('\u521b\u4f5c\u58f0\u660e') && error.message.includes('\u7981\u6b62\u6295\u7a3f')
    );
  } finally { f.close(); }
});

test('Bilibili accepts the already-selected default declaration without reopening the menu', async () => {
  const f = fixture();
  try {
    const selected = {
      async isVisible() { return true; },
      async innerText() { return '内容无需标注'; }
    };
    const selectedLocator = {
      async count() { return 1; },
      nth() { return selected; }
    };
    const control = {
      async isVisible() { return true; },
      async inputValue() { return ''; },
      async innerText() { return ''; },
      locator() { return { async innerText() { return '创作声明 内容无需标注'; } }; }
    };
    const controls = {
      async count() { return 1; },
      nth() { return control; }
    };
    let clicked = 0;
    const page = {
      locator(selector) {
        if (selector === '.bcc-option.selected') return selectedLocator;
        if (selector.includes('bcc-select-input-inner')) return controls;
        throw new Error(`unexpected selector: ${selector}`);
      },
      getByText() { throw new Error('menu should not be opened'); },
      async waitForTimeout() { clicked += 1; }
    };
    const result = await f.adapter.applyContentDeclaration(page, { contentOrigin: 'HUMAN_ORIGINAL' });
    assert.equal(result.applied, true);
    assert.equal(result.verified, true);
    assert.equal(result.alreadySelected, true);
    assert.equal(result.selectedLabel, '内容无需标注');
    assert.equal(clicked, 0);
  } finally { f.close(); }
});

test('Bilibili generates a PNG cover when no external cover is supplied', async () => {
  const f = fixture();
  try {
    const materialPath = path.join(f.dir, 'cover-source.mp4'); fs.writeFileSync(materialPath, 'x');
    const coverPath = await f.adapter.resolveBilibiliCoverPath({ title: 'cover-generation-test' }, materialPath);
    assert.equal(fs.existsSync(coverPath), true);
    assert.equal(path.extname(coverPath), '.png');
    assert.equal(fs.readFileSync(coverPath).subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  } finally { f.close(); }
});

test('Bilibili final publish control falls back to one exact visible text control', async () => {
  const f = fixture();
  try {
    let clicked = 0;
    const missingRole = { async count() { return 0; }, nth() { throw new Error('no role match'); } };
    const missingAncestor = { async count() { return 0; }, first() { throw new Error('no ancestor'); } };
    const textControl = {
      async isVisible() { return true; },
      async isEnabled() { return true; },
      locator() { return missingAncestor; },
      async click() { clicked += 1; }
    };
    const exactText = { async count() { return 1; }, nth() { return textControl; } };
    const page = {
      getByRole() { return missingRole; },
      getByText(label, options) {
        assert.equal(label, '\u7acb\u5373\u6295\u7a3f');
        assert.equal(options.exact, true);
        return exactText;
      }
    };
    const result = await f.adapter.findFinalPublishControl(page);
    assert.equal(result.status, 'UNIQUE');
    assert.equal(result.method, 'exact-text');
    await result.locator.click();
    assert.equal(clicked, 1);
  } finally { f.close(); }
});

test('Bilibili final publish control never clicks ambiguous exact text matches', async () => {
  const f = fixture();
  try {
    const missingRole = { async count() { return 0; }, nth() { throw new Error('no role match'); } };
    const missingAncestor = { async count() { return 0; }, first() { throw new Error('no ancestor'); } };
    const textControl = {
      async isVisible() { return true; },
      async isEnabled() { return true; },
      locator() { return missingAncestor; }
    };
    const exactText = { async count() { return 2; }, nth() { return textControl; } };
    const page = { getByRole() { return missingRole; }, getByText() { return exactText; } };
    const result = await f.adapter.findFinalPublishControl(page);
    assert.equal(result.status, 'AMBIGUOUS');
    assert.equal(result.count, 2);
    assert.equal(result.locator, undefined);
  } finally { f.close(); }
});

test('Bilibili pending-draft prompt is parsed and may appear asynchronously', async () => {
  const pendingText = '\u672c\u5730\u6d4f\u89c8\u5668\u5b58\u5728 1 \u4e2a\u672a\u63d0\u4ea4\u7684\u89c6\u9891 \u7ee7\u7eed\u7f16\u8f91 \u4e0d\u7528\u4e86';
  assert.deepEqual(detectBilibiliPendingDraft(pendingText), { blocked: true, count: 1 });
  assert.deepEqual(detectBilibiliPendingDraft('\u6295\u7a3f\u9875\u9762\u6b63\u5728\u52a0\u8f7d'), { blocked: false, count: null });

  const f = fixture();
  try {
    let inspections = 0;
    let continueClicks = 0;
    const visibleItem = {
      async isVisible() { return true; },
      async click() { continueClicks += 1; }
    };
    const body = { async innerText() { return '\u8349\u7a3f\u9875\u9762\u5c1a\u672a\u51fa\u73b0\u9884\u671f\u6807\u9898\u548c\u7d20\u6750'; } };
    const page = {
      async goto() {},
      async waitForTimeout() {},
      locator(selector) { return selector === 'body' ? body : { async count() { return 0; } }; },
      getByText(label) {
        return {
          async count() { return label === '\u7ee7\u7eed\u7f16\u8f91' ? 1 : 0; },
          nth() { return visibleItem; }
        };
      }
    };
    f.adapter.getPage = async () => page;
    f.adapter.waitForReady = async () => true;
    f.adapter.inspectPendingDraft = async () => {
      inspections += 1;
      return inspections < 3
        ? { blocked: false, continueEditingVisible: false }
        : { blocked: true, continueEditingVisible: true, localDraftFingerprint: { fingerprint: { fingerprintHash: 'fp-1' } } };
    };
    const output = await f.adapter.submitExistingDraft({
      authorized: true,
      prepareOnly: true,
      expectedTitle: '\u793e\u533a\u6d3b\u52a8\u9884\u544a',
      expectedMaterial: 'community.mp4',
      draftFingerprint: { fingerprintHash: 'fp-1' }
    });
    assert.equal(inspections, 3);
    assert.equal(continueClicks, 1);
    assert.equal(output.status, 'NEEDS_CONFIRMATION');
    assert.equal(output.result.stage, 'existing_draft_mismatch');
    assert.equal(output.result.submitAttempted, false);
  } finally { f.close(); }
});

test('Bilibili acquires the permanent submit lock immediately before the final click', async () => {
  const f = fixture();
  const materialPath = path.join(f.dir, 'locked.mp4'); fs.writeFileSync(materialPath, 'x');
  try {
    const events = [];
    f.adapter.setSubmitAuthorizer(async payload => {
      events.push(`lock:${payload.targetId}`);
      return { authorized: true, submitLock: 'LOCKED', publishAttemptState: 'SUBMITTING' };
    });
    f.adapter.getPage = async () => ({ async goto() {}, async waitForTimeout() {} });
    f.adapter.waitForReady = async () => true;
    f.adapter.inspectPendingDraft = async () => ({ blocked: false });
    f.adapter.prepareDraft = async () => ({ readiness: { ready: true } });
    f.adapter.findFinalPublishControl = async () => ({ status: 'UNIQUE', locator: { async click() { events.push('click'); } } });
    f.adapter.waitForPublishSignal = async () => ({ confirmed: false });
    f.adapter.waitForSubmittedManagementRecord = async () => ({ confirmed: false, checked: true, matched: false });
    const output = await f.adapter.publish({ taskId: 8, targetId: 9, accountId: 2, title: 'lock-test-video', materialPath, publishMode: 'AUTO', managementConfirmed: true, contentOrigin: 'HUMAN_ORIGINAL', draftFingerprint: { fingerprintHash: 'fp-lock' } });
    assert.deepEqual(events, ['lock:9', 'click']);
    assert.equal(output.status, 'NEEDS_CONFIRMATION');
    assert.equal(output.result.submitAttempted, true);
  } finally { f.close(); }
});

test('Bilibili reconciles a unique management-page match without opening the upload page', async () => {
  const f = fixture();
  const materialPath = path.join(f.dir, 'reconciled.mp4'); fs.writeFileSync(materialPath, 'x');
  try {
    let uploadPageOpened = false;
    f.adapter.preflightManagementReconciliation = async () => ({ matched: true, reviewStatus: 'PUBLISHED', platformPostId: 'BV1234567890', platformUrl: 'https://www.bilibili.com/video/BV1234567890/', match: { title: 'lock-test-video' }, verification: { result: { evidencePath: 'e.json', screenshotPath: 's.png' } } });
    f.adapter.getPage = async () => { uploadPageOpened = true; return {}; };
    const output = await f.adapter.publish({ taskId: 1, targetId: 2, title: 'lock-test-video', materialPath, publishMode: 'AUTO', managementConfirmed: true, contentOrigin: 'HUMAN_ORIGINAL', draftFingerprint: { fingerprintHash: 'fp' } });
    assert.equal(output.status, 'SUCCESS');
    assert.equal(output.result.reconciledBeforeSubmit, true);
    assert.equal(output.result.platformPostId, 'BV1234567890');
    assert.equal(output.result.submitAttempted, false);
    assert.equal(uploadPageOpened, false);
  } finally { f.close(); }
});

test('Bilibili AI declaration selects AI-generated content without guessing original', async () => {
  const f = fixture();
  try {
    const declarationPrompt = '\u8bf7\u9009\u62e9\u7b26\u5408\u60a8\u89c6\u9891\u5185\u5bb9\u7684\u521b\u4f5c\u58f0\u660e';
    const aiLabel = '\u542bAI\u751f\u6210\u5185\u5bb9';
    const selectedLabels = [];
    const hiddenTrigger = { async isVisible() { return false; }, async click() {} };
    const activeTrigger = {
      async isVisible() { return true; },
      async click() {},
      async inputValue() { return selectedLabels.length ? aiLabel : ''; },
      locator() { return { async innerText() { return selectedLabels.length ? aiLabel : ''; } }; }
    };
    const option = {
      async isVisible() { return true; },
      async innerText() { return aiLabel; },
      async click() { selectedLabels.push(aiLabel); }
    };
    let locatorCalls = 0;
    const page = {
      locator() {
        locatorCalls += 1;
        return { first() { return locatorCalls === 1 ? activeTrigger : hiddenTrigger; }, filter() { return this; } };
      },
      getByText(label) {
        if (label === declarationPrompt) return { first() { return hiddenTrigger; } };
        return {
          first() { return hiddenTrigger; },
          async count() { return label === aiLabel ? 1 : 0; },
          nth() { return option; }
        };
      },
      async waitForTimeout() {}
    };
    const result = await f.adapter.applyContentDeclaration(page, { contentOrigin: 'AI_GENERATED' });
    assert.equal(result.applied, true);
    assert.equal(result.aiDeclarationApplied, true);
    assert.equal(result.selectedLabel, aiLabel);
    assert.deepEqual(selectedLabels, [aiLabel]);
  } finally { f.close(); }
});


test('Bilibili comment feed marks the signed-in account by stable UID', () => {
  const [ownMessage] = parseBilibiliCommentFeed(commentResponse, '22');
  assert.equal(ownMessage.context.accountPlatformId, '22');
  assert.equal(ownMessage.context.actorPlatformId, '22');
  assert.equal(ownMessage.context.actorIsSelf, true);
  assert.equal(ownMessage.context.direction, 'OUTGOING');
  const [audienceMessage] = parseBilibiliCommentFeed(commentResponse, '99');
  assert.equal(audienceMessage.context.actorIsSelf, false);
  assert.equal(audienceMessage.context.direction, 'INCOMING');
});

test('Bilibili management lookup blocks multiple exact title records', async () => {
  const expectedTitle = 'same-title-video';
  const makeItem = (recordText, href) => ({
    async isVisible() { return true; },
    async evaluate(callback, callbackTitle) {
      const link = { href };
      const record = {
        tagName: 'DIV',
        className: 'video-item',
        innerText: recordText,
        textContent: recordText,
        parentElement: null,
        getAttribute(name) { return name === 'role' ? 'row' : null; },
        closest() { return null; },
        querySelector(selector) { return selector === 'a[href]' ? link : null; }
      };
      const element = {
        tagName: 'SPAN',
        className: 'title',
        innerText: callbackTitle,
        textContent: callbackTitle,
        parentElement: record,
        getAttribute() { return null; },
        closest() { return null; },
        querySelector() { return null; }
      };
      return callback(element, callbackTitle);
    }
  });
  const items = [
    makeItem(`${expectedTitle} 00:42 2026-08-10 10:10`, 'https://www.bilibili.com/video/BV1111111111/'),
    makeItem(`${expectedTitle} 00:42 2026-08-10 10:20`, 'https://www.bilibili.com/video/BV2222222222/')
  ];
  const matches = {
    async count() { return items.length; },
    nth(index) { return items[index]; }
  };
  const emptyLocator = {
    async count() { return 0; },
    nth() { return this; },
    async isVisible() { return false; },
    async isEnabled() { return false; }
  };
  const page = {
    frames() { return [this]; },
    getByText(title, options) {
      if (title === expectedTitle && options?.exact === false) return matches;
      return emptyLocator;
    },
    getByRole() { return emptyLocator; },
    async goto() {},
    async waitForTimeout() {}
  };

  const matchedRecord = await findVisibleTitleRecord(page, expectedTitle);
  assert.equal(matchedRecord.ambiguous, true);
  assert.equal(matchedRecord.candidateCount, 2);
  assert.equal(matchedRecord.signaledCandidateCount, 2);

  const f = fixture();
  try {
    delete f.adapter.preflightManagementReconciliation;
    f.adapter.getPage = async () => page;
    f.adapter.waitForDetectedPageState = async () => 'READY';
    const preflight = await f.adapter.preflightManagementReconciliation({ title: expectedTitle });
    assert.equal(preflight.blocked, true);
    assert.equal(preflight.reason, 'MULTIPLE_TITLE_MATCHES');
    assert.equal(preflight.managementMatch.candidateCount, 2);
  } finally { f.close(); }
});

test('Bilibili management record parsing separates video duration from submission time', () => {
  const duration = parseBilibiliDuration('sample-video 00:42 2026-08-10 11:15', 42);
  assert.equal(duration.seconds, 42);
  const submitted = parseBilibiliSubmittedAt('sample-video 00:42 2026-08-10 11:15', new Date(2026, 7, 10, 12, 0));
  assert.equal(submitted.precision, 'minute');
  assert.equal(new Date(submitted.iso).getHours(), 11);
  assert.equal(new Date(submitted.iso).getMinutes(), 15);
});

test('Bilibili management reconciliation requires matching duration and a non-stale submission time', () => {
  const taskCreatedAt = new Date(2026, 7, 10, 10, 0).toISOString();
  const payload = {
    title: 'same-title-video',
    taskCreatedAt,
    materialMeta: { durationSeconds: 42 },
    draftFingerprint: { fingerprintHash: 'fp-assess', durationSeconds: 42, createdAt: taskCreatedAt }
  };
  const matched = assessBilibiliManagementRecord(payload, {
    reviewStatus: 'PUBLISHED',
    text: 'same-title-video 00:43 2026-08-10 10:10 BV1234567890',
    href: 'https://www.bilibili.com/video/BV1234567890/'
  }, new Date(2026, 7, 10, 12, 0));
  assert.equal(matched.matched, true);
  assert.equal(matched.managementMatch.durationSeconds, 43);
  assert.equal(matched.platformPostId, 'BV1234567890');

  const durationMismatch = assessBilibiliManagementRecord(payload, {
    reviewStatus: 'PUBLISHED',
    text: 'same-title-video 01:20 2026-08-10 10:10'
  }, new Date(2026, 7, 10, 12, 0));
  assert.equal(durationMismatch.blocked, true);
  assert.equal(durationMismatch.reason, 'DURATION_MISMATCH');

  const stale = assessBilibiliManagementRecord(payload, {
    reviewStatus: 'PUBLISHED',
    text: 'same-title-video 00:42 2026-08-10 09:00'
  }, new Date(2026, 7, 10, 12, 0));
  assert.equal(stale.blocked, true);
  assert.equal(stale.reason, 'RECORD_PREDATES_TASK');
});



function managedDraftPayload(dir, overrides = {}) {
  const materialPath = overrides.materialPath || path.join(dir, 'managed-video.mp4');
  if (!fs.existsSync(materialPath)) fs.writeFileSync(materialPath, 'managed-video');
  const taskId = overrides.taskId ?? 101;
  const targetId = overrides.targetId ?? 201;
  const accountId = overrides.accountId ?? 3;
  const title = overrides.title || '\u7cfb\u7edf\u65e7\u8349\u7a3f\u6807\u9898';
  const materialSha256 = overrides.materialSha256 || 'a'.repeat(64);
  const durationSeconds = overrides.durationSeconds ?? 42;
  return {
    taskId,
    targetId,
    accountId,
    profileName: 'profile-bilibili-main',
    title,
    body: overrides.body || '\u8349\u7a3f\u6b63\u6587',
    materialPath,
    materialSha256,
    materialMeta: { durationSeconds },
    draftFingerprint: {
      fingerprintHash: overrides.fingerprintHash || `fp-${taskId}-${targetId}`,
      platformCode: 'bilibili',
      taskId,
      targetId,
      accountId,
      title,
      materialName: path.basename(materialPath),
      materialSha256,
      durationSeconds
    },
    ...overrides
  };
}

test('Bilibili v2 draft state records ownership content identity and history', () => {
  const f = fixture();
  try {
    const payload = managedDraftPayload(f.dir);
    const ready = f.adapter.writeDraftFingerprintState(payload, 'DRAFT_READY', { preparedAt: '2026-08-10T08:00:00.000Z' });
    assert.equal(ready.version, 2);
    assert.equal(ready.owner, 'codex-bilibili-agent');
    assert.equal(ready.platformCode, 'bilibili');
    assert.equal(ready.state, 'DRAFT_READY');
    assert.equal(ready.contentFingerprint.accountId, payload.accountId);
    assert.equal(ready.contentFingerprint.materialSha256, payload.materialSha256);
    assert.ok(ready.contentFingerprint.contentFingerprintHash);
    assert.equal(ready.history.at(-1).to, 'DRAFT_READY');
    assert.equal(isManagedBilibiliDraftState(ready), true);
    assert.equal(canSafelyDiscardBilibiliManagedDraft(ready), true);

    const attempted = f.adapter.writeDraftFingerprintState(payload, 'SUBMIT_ATTEMPTED', { submitAttemptedAt: '2026-08-10T08:01:00.000Z' });
    assert.equal(attempted.history.at(-1).from, 'DRAFT_READY');
    assert.equal(attempted.history.at(-1).to, 'SUBMIT_ATTEMPTED');
    assert.equal(canSafelyDiscardBilibiliManagedDraft(attempted), false);
  } finally { f.close(); }
});

test('Bilibili content fingerprint resumes across tasks only for the same account', () => {
  const f = fixture();
  try {
    const original = managedDraftPayload(f.dir);
    const state = f.adapter.writeDraftFingerprintState(original, 'DRAFT_READY');
    const next = managedDraftPayload(f.dir, { taskId: 102, targetId: 202, fingerprintHash: 'fp-next', title: '\u66f4\u65b0\u540e\u7684\u4efb\u52a1\u6807\u9898' });
    assert.equal(bilibiliDraftContentMatches(next, state), true);
    assert.equal(f.adapter.assessLocalDraft(next, state).resumeAllowed, true);
    assert.equal(bilibiliDraftContentMatches({ ...next, accountId: 9, draftFingerprint: { ...next.draftFingerprint, accountId: 9 } }, state), false);
    const accountless = { ...state, accountId: null, contentFingerprint: { ...state.contentFingerprint, accountId: null } };
    delete accountless.fingerprint.accountId;
    assert.equal(bilibiliDraftContentMatches(next, accountless), false);
  } finally { f.close(); }
});

test('Bilibili AUTO resumes a managed draft with matching content', async () => {
  const f = fixture();
  try {
    const original = managedDraftPayload(f.dir);
    const state = f.adapter.writeDraftFingerprintState(original, 'DRAFT_READY');
    const next = managedDraftPayload(f.dir, { taskId: 102, targetId: 202, fingerprintHash: 'fp-next-auto', title: '\u65b0\u4efb\u52a1\u6807\u9898' });
    f.adapter.getPage = async () => ({ async goto() {}, async waitForTimeout() {} });
    f.adapter.waitForReady = async () => true;
    f.adapter.inspectPendingDraft = async () => ({ blocked: true, continueEditingVisible: true, discardVisible: true, localDraftFingerprint: state });
    let resumed = null;
    f.adapter.submitExistingDraft = async payload => { resumed = payload; return { status: 'SUCCESS', result: { stage: 'published', autoResumed: true } }; };
    const output = await f.adapter.publish({ ...next, publishMode: 'AUTO', managementConfirmed: true, contentOrigin: 'HUMAN_ORIGINAL' });
    assert.equal(output.status, 'SUCCESS');
    assert.equal(resumed.autoResume, true);
    assert.equal(resumed.expectedTitle, next.title);
    assert.equal(resumed.expectedMaterial, path.basename(next.materialPath));
  } finally { f.close(); }
});

test('Bilibili never discards unknown or submit-attempted drafts', async () => {
  const f = fixture();
  try {
    const payload = managedDraftPayload(f.dir);
    f.adapter.getPage = async () => ({ async goto() {}, async waitForTimeout() {} });
    f.adapter.waitForReady = async () => true;
    let destructiveCalls = 0;
    f.adapter.discardVerifiedManagedDraft = async () => { destructiveCalls += 1; throw new Error('must not discard'); };
    f.adapter.submitExistingDraft = async () => { destructiveCalls += 1; throw new Error('must not resubmit'); };

    f.adapter.inspectPendingDraft = async () => ({ blocked: true, continueEditingVisible: true, discardVisible: true, localDraftFingerprint: null });
    const unknown = await f.adapter.publish({ ...payload, publishMode: 'AUTO', managementConfirmed: true, contentOrigin: 'HUMAN_ORIGINAL' });
    assert.equal(unknown.result.stage, 'existing_draft_blocked');
    assert.equal(destructiveCalls, 0);

    const attempted = f.adapter.writeDraftFingerprintState(payload, 'SUBMIT_ATTEMPTED', { submitAttemptedAt: new Date().toISOString() });
    f.adapter.inspectPendingDraft = async () => ({ blocked: true, continueEditingVisible: true, discardVisible: true, localDraftFingerprint: attempted });
    const verifyOnly = await f.adapter.publish({ ...payload, publishMode: 'AUTO', managementConfirmed: true, contentOrigin: 'HUMAN_ORIGINAL' });
    assert.equal(verifyOnly.result.stage, 'existing_draft_requires_verification');
    assert.equal(verifyOnly.result.verificationRequired, true);
    assert.equal(destructiveCalls, 0);
  } finally { f.close(); }
});

test('Bilibili discards managed drafts only after actual page identity matches', async () => {
  const f = fixture();
  try {
    const payload = managedDraftPayload(f.dir);
    const state = f.adapter.writeDraftFingerprintState(payload, 'DRAFT_READY');
    let discardClicks = 0;
    let continueClicks = 0;
    let discarded = false;
    const visibleControl = action => ({ async isVisible() { return true; }, async click() { action(); } });
    const empty = { async count() { return 0; }, nth() { return this; } };
    const pageForText = bodyText => ({
      async goto() {},
      async waitForTimeout() {},
      locator(selector) { return selector === 'body' ? { async innerText() { return bodyText; } } : empty; },
      getByText(label) {
        if (label === '\u7ee7\u7eed\u7f16\u8f91') return { async count() { return 1; }, nth() { return visibleControl(() => { continueClicks += 1; }); } };
        if (['\u4e0d\u7528\u4e86', '\u653e\u5f03\u8349\u7a3f', '\u4e22\u5f03\u8349\u7a3f'].includes(label)) return { async count() { return 1; }, nth() { return visibleControl(() => { discardClicks += 1; discarded = true; }); } };
        return empty;
      }
    });
    f.adapter.runtimeCheckpoint = async () => {};
    f.adapter.inspectPendingDraft = async () => discarded
      ? { blocked: false, discardVisible: false }
      : { blocked: true, continueEditingVisible: true, discardVisible: true };

    const mismatch = await f.adapter.discardVerifiedManagedDraft(pageForText('\u5176\u4ed6\u4eba\u5de5\u8349\u7a3f other.mp4 \u4e0a\u4f20\u5b8c\u6210'), { continueEditingVisible: true, discardVisible: true }, state, 0);
    assert.equal(mismatch.discarded, false);
    assert.equal(mismatch.reason, 'ACTUAL_DRAFT_IDENTITY_MISMATCH');
    assert.equal(discardClicks, 0);

    continueClicks = 0;
    const matchedText = `${payload.title} ${path.basename(payload.materialPath)} \u4e0a\u4f20\u5b8c\u6210`;
    const matched = await f.adapter.discardVerifiedManagedDraft(pageForText(matchedText), { continueEditingVisible: true, discardVisible: true }, state, 0);
    assert.equal(matched.discarded, true);
    assert.equal(continueClicks, 1);
    assert.equal(discardClicks, 1);
    assert.equal(f.adapter.readDraftFingerprintState().state, 'DISCARDED');
  } finally { f.close(); }
});

test('Bilibili updates metadata only for a verified same-content managed draft', async () => {
  const f = fixture();
  try {
    fs.mkdirSync(path.join(f.dir, 'logs'), { recursive: true });
    const original = managedDraftPayload(f.dir, { title: '\u65e7\u6807\u9898', fingerprintHash: 'fp-old-title' });
    const state = f.adapter.writeDraftFingerprintState(original, 'DRAFT_READY');
    const next = managedDraftPayload(f.dir, { taskId: 103, targetId: 203, title: '\u65b0\u6807\u9898', fingerprintHash: 'fp-new-title' });
    let titleValue = '\u65e7\u6807\u9898';
    let captionValue = '';
    const editable = (kind) => ({
      async isVisible() { return true; },
      async isEnabled() { return true; },
      async fill(value) { if (kind === 'title') titleValue = value; else captionValue = value; },
      async inputValue() { return kind === 'title' ? titleValue : captionValue; }
    });
    const empty = { async count() { return 0; }, nth() { return this; } };
    const continueControl = { async isVisible() { return true; }, async click() {} };
    const page = {
      async goto() {}, async waitForTimeout() {}, async screenshot() {}, url() { return 'https://member.bilibili.com/platform/upload/video/frame'; },
      locator(selector) {
        if (selector === 'body') return { async innerText() { return `\u65e7\u6807\u9898 ${path.basename(original.materialPath)} \u4e0a\u4f20\u5b8c\u6210`; } };
        const titleSelector = (f.adapter.spec.titleSelectors || []).includes(selector);
        const captionSelector = (f.adapter.spec.captionSelectors || []).includes(selector);
        if (titleSelector || captionSelector) return { async count() { return 1; }, nth() { return editable(titleSelector ? 'title' : 'caption'); } };
        return empty;
      },
      getByText(label) { return label === '\u7ee7\u7eed\u7f16\u8f91' ? { async count() { return 1; }, nth() { return continueControl; } } : empty; }
    };
    f.adapter.getPage = async () => page;
    f.adapter.waitForReady = async () => true;
    f.adapter.inspectPendingDraft = async () => ({ blocked: true, continueEditingVisible: true, localDraftFingerprint: state });
    f.adapter.applyContentDeclaration = async () => ({ applied: true });
    f.adapter.ensureBilibiliCover = async () => ({ coverState: { saved: true }, coverPath: null, alreadySaved: true });
    const output = await f.adapter.submitExistingDraft({ ...next, authorized: true, prepareOnly: true, expectedTitle: next.title, expectedMaterial: path.basename(next.materialPath), contentOrigin: 'HUMAN_ORIGINAL' });
    assert.equal(output.status, 'SUCCESS');
    assert.equal(output.result.stage, 'existing_draft_cover_ready');
    assert.equal(titleValue, '\u65b0\u6807\u9898');
    assert.match(captionValue, /\u65b0\u6807\u9898/);
  } finally { f.close(); }
});

test('Bilibili records DRAFT_PREPARE_UNCONFIRMED on preparation failure and SUBMITTED on success', async () => {
  const f = fixture();
  try {
    const payload = managedDraftPayload(f.dir);
    const page = { async goto() {}, async waitForTimeout() {} };
    f.adapter.getPage = async () => page;
    f.adapter.waitForReady = async () => true;
    f.adapter.inspectPendingDraft = async () => ({ blocked: false });
    f.adapter.prepareDraft = async () => { throw new Error('upload interrupted'); };
    const failed = await f.adapter.publish({ ...payload, publishMode: 'AUTO', managementConfirmed: true, contentOrigin: 'HUMAN_ORIGINAL' });
    assert.equal(failed.result.stage, 'draft_prepare_blocked');
    assert.equal(failed.result.submissionStatus, 'NOT_SUBMITTED');
    assert.equal(failed.result.draftExists, false);
    assert.equal(failed.result.draftPreservedInBrowser, false);
    assert.equal(f.adapter.readDraftFingerprintState(), null);

    f.adapter.prepareDraft = async () => ({ readiness: { ready: true } });
    f.adapter.findFinalPublishControl = async () => ({ status: 'UNIQUE', locator: { async click() {} } });
    f.adapter.waitForPublishSignal = async () => ({ confirmed: true, source: 'success-toast' });
    const success = await f.adapter.publish({ ...payload, publishMode: 'AUTO', managementConfirmed: true, contentOrigin: 'HUMAN_ORIGINAL' });
    assert.equal(success.status, 'SUCCESS');
    assert.equal(f.adapter.readDraftFingerprintState().state, 'SUBMITTED');
  } finally { f.close(); }
});

test('Bilibili reports an unchanged initial uploader as failed and safe to retry', async () => {
  const f = fixture();
  try {
    const payload = managedDraftPayload(f.dir);
    const page = { async goto() {}, async waitForTimeout() {} };
    f.adapter.getPage = async () => page;
    f.adapter.waitForReady = async () => true;
    f.adapter.inspectPendingDraft = async () => ({ blocked: false });
    f.adapter.prepareDraft = async () => {
      const error = new Error('initial uploader unchanged');
      error.code = 'MATERIAL_UPLOAD_NOT_STARTED';
      error.uploadDefinitelyNotStarted = true;
      error.draftPrepareStage = 'material-attachment-start';
      error.materialAttachment = { attached: false, selectionAttempted: true, attachAttempts: 2 };
      throw error;
    };

    const output = await f.adapter.publish({ ...payload, publishMode: 'AUTO', managementConfirmed: true, contentOrigin: 'HUMAN_ORIGINAL' });
    assert.equal(output.status, 'FAILED');
    assert.equal(output.result.stage, 'upload_not_started');
    assert.equal(output.result.submissionStatus, 'NOT_SUBMITTED');
    assert.equal(output.result.publishAttemptState, 'UPLOAD_NOT_STARTED');
    assert.equal(output.result.uploadAttempted, true);
    assert.equal(output.result.uploadMayHaveStarted, false);
    assert.equal(output.result.safeToRetry, true);
    assert.equal(output.result.failedStage, 'material-attachment-start');
    assert.equal(output.result.noDraftFingerprintState.state, 'UPLOAD_NOT_STARTED');
    assert.equal(output.result.noDraftFingerprintState.noDraftConfirmed, true);
    assert.equal(f.adapter.readDraftFingerprintState().state, 'UPLOAD_NOT_STARTED');
  } finally { f.close(); }
});



test('Bilibili comment cursor builds the next finite feed page', () => {
  const next = buildBilibiliCommentFeedPageUrl({ data: { cursor: { id: 88, time: 1786000000, is_end: false } } });
  const url = new URL(next);
  assert.equal(url.searchParams.get('id'), '88');
  assert.equal(url.searchParams.get('reply_time'), '1786000000');
  assert.equal(buildBilibiliCommentFeedPageUrl({ data: { cursor: { id: 88, time: 1786000000, is_end: true } } }), null);
});

test('Bilibili bound account UID mismatch blocks collection before reading messages', async () => {
  const f = fixture();
  try {
    f.adapter.getPage = async () => ({});
    f.adapter.auth = async () => ({ selfUid: '99', csrf: 'csrf' });
    let apiCalled = false;
    f.adapter.apiGet = async () => { apiCalled = true; return { code: 0, data: {} }; };
    const output = await f.adapter.collectMessages({ types: ['COMMENT'], platformUserId: '100' });
    assert.equal(output.status, 'FAILED');
    assert.equal(output.result.stage, 'account_identity_mismatch');
    assert.equal(output.result.safeToRetry, false);
    assert.equal(apiCalled, false);
  } finally { f.close(); }
});

test('Bilibili unbound account stays in observe-only identity mode', async () => {
  const f = fixture();
  try {
    f.adapter.getPage = async () => ({});
    f.adapter.auth = async () => ({ selfUid: '99', csrf: 'csrf' });
    f.adapter.apiGet = async () => ({ code: 0, data: { items: [], cursor: { is_end: true } } });
    const output = await f.adapter.collectMessages({ types: ['COMMENT'] });
    assert.equal(output.status, 'SUCCESS');
    assert.equal(output.result.accountIdentityMode, 'OBSERVE_ONLY');
    assert.equal(output.result.currentPlatformUserId, '99');
    assert.equal(output.result.boundPlatformUserId, null);
  } finally { f.close(); }
});

test('Bilibili comment collection scans multiple pages and dedupes notifications', async () => {
  const f = fixture();
  try {
    f.adapter.getPage = async () => ({});
    f.adapter.auth = async () => ({ selfUid: '99', csrf: 'csrf' });
    const secondItem = { ...commentResponse.data.items[0], id: 9989, item: { ...commentResponse.data.items[0].item, source_content: 'older post received a new comment', source_id: 790 } };
    f.adapter.apiGet = async url => url.includes('id=88')
      ? { code: 0, data: { items: [commentResponse.data.items[0], secondItem], cursor: { is_end: true } } }
      : { code: 0, data: { items: [commentResponse.data.items[0]], cursor: { id: 88, time: 1786000000, is_end: false } } };
    const output = await f.adapter.collectMessages({ types: ['COMMENT'], maxCommentPages: 5 });
    assert.equal(output.status, 'SUCCESS');
    assert.equal(output.result.messages.length, 2);
    assert.equal(output.result.commentPagesScanned, 2);
    assert.equal(output.result.commentPageScanStopReason, 'CURSOR_END');
    assert.equal(output.result.commentPageScanTruncated, false);
  } finally { f.close(); }
});

test('Bilibili marks truncated comment collection as partial instead of successful', async () => {
  const f = fixture();
  try {
    f.adapter.getPage = async () => ({});
    f.adapter.auth = async () => ({ selfUid: '99', csrf: 'csrf' });
    f.adapter.apiGet = async () => ({ code: 0, data: {
      items: [commentResponse.data.items[0]],
      cursor: { id: 88, time: 1786000000, is_end: false }
    } });
    const output = await f.adapter.collectMessages({ types: ['COMMENT'], maxCommentPages: 1 });
    assert.equal(output.status, 'PARTIAL_SUCCESS');
    assert.equal(output.result.partialCollection, true);
    assert.equal(output.result.commentPageScanTruncated, true);
    assert.equal(output.result.messages.length, 1);
  } finally { f.close(); }
});

test('Bilibili isolates a failed private session and keeps successful sessions', async () => {
  const f = fixture();
  try {
    f.adapter.getPage = async () => ({});
    f.adapter.auth = async () => ({ selfUid: '99', csrf: 'csrf' });
    const sessions = {
      code: 0,
      data: { session_list: [
        { talker_id: 22, session_type: 1, unread_count: 1, account_info: { name: '成功用户' } },
        { talker_id: 33, session_type: 1, unread_count: 1, account_info: { name: '失败用户' } }
      ] }
    };
    f.adapter.apiGet = async url => {
      if (url === 'https://api.vc.bilibili.com/session_svr/v1/session_svr/get_sessions?session_type=1&group_fold=1&unfollow_fold=0&sort_rule=2&build=0&mobi_app=web') return sessions;
      if (url.includes('talker_id=22')) return { code: 0, data: { messages: [privateResponse.data.messages[0]] } };
      if (url.includes('talker_id=33')) throw new Error('B站私信会话请求超时');
      throw new Error(`unexpected url: ${url}`);
    };
    const output = await f.adapter.collectMessages({ types: ['PRIVATE_MESSAGE'] });
    assert.equal(output.status, 'PARTIAL_SUCCESS');
    assert.equal(output.result.partialCollection, true);
    assert.equal(output.result.privateSessionErrors.length, 1);
    assert.equal(output.result.privateSessionErrors[0].talkerId, '33');
    assert.equal(output.result.messages.length, 1);
    assert.equal(output.result.messages[0].context.talkerId, '22');
  } finally { f.close(); }
});

test('Bilibili stops comment pagination when the platform is disabled', async () => {
  const f = fixture();
  try {
    let stopped = false;
    f.adapter.getPage = async () => ({});
    f.adapter.auth = async () => ({ selfUid: '99', csrf: 'csrf' });
    f.adapter.runtimeCheckpoint = async () => {
      if (!stopped) return;
      const error = new Error('stopped'); error.code = 'PLATFORM_STOPPED'; throw error;
    };
    f.adapter.apiGet = async () => { stopped = true; return { code: 0, data: { items: [commentResponse.data.items[0]], cursor: { id: 88, time: 1786000000, is_end: false } } }; };
    await assert.rejects(() => f.adapter.collectMessages({ types: ['COMMENT'], maxCommentPages: 5 }), error => error.code === 'PLATFORM_STOPPED');
  } finally { f.close(); }
});


test('management title lookup accepts a combined card text that starts with the exact title', async () => {
  const title = 'wechat-combined-card-title';
  const body = 'body prefix used for management reconciliation';
  const recordText = `${title} ${body} 2026-08-14 09:19`;
  const link = { href: 'https://channels.weixin.qq.com/platform/post/list?id=wx-combined-1' };
  const record = {
    tagName: 'DIV',
    className: 'video-item',
    innerText: recordText,
    textContent: recordText,
    parentElement: null,
    getAttribute() { return null; },
    closest(selector) { return selector === 'a[href]' ? link : null; },
    querySelector(selector) { return selector === 'a[href]' ? link : null; }
  };
  const item = {
    async isVisible() { return true; },
    async evaluate(callback, expectedTitle) { return callback(record, expectedTitle); }
  };
  const matches = { async count() { return 1; }, nth() { return item; } };
  const page = {
    frames() { return [this]; },
    getByText(expectedTitle, options) {
      assert.equal(expectedTitle, title);
      assert.equal(options.exact, false);
      return matches;
    }
  };

  const result = await findVisibleTitleRecord(page, title, {
    platformCode: 'wechat_channels',
    body,
    submittedAt: '2026-08-14T01:15:00.000Z',
    tabStatus: 'PUBLISHED'
  });
  assert.equal(result.ambiguous, undefined);
  assert.equal(result.reviewStatus, 'PUBLISHED');
  assert.equal(result.platformPostId, 'wx-combined-1');
  assert.ok(result.matchedBy.includes('TITLE_PREFIX'));
  assert.ok(result.matchedBy.includes('BODY_PREFIX'));
  assert.ok(result.matchedBy.includes('PUBLISHED_AT'));
});

