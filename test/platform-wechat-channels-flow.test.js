import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import { chromium } from 'playwright-core';
import { WechatChannelsAssistedRpaAdapter } from '../agent/rpa-adapters/wechat-channels-assisted.js';

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-channels-flow-'));
  const profileDir = path.join(dir, 'profile');
  const adapter = new WechatChannelsAssistedRpaAdapter({
    profileDir,
    logsDir: path.join(dir, 'logs'),
    executablePath: 'chrome-not-used',
    loginTimeoutMs: 1,
    sendTimeoutMs: 1
  });
  adapter.evidence = async (_payload, message, _page, stage, extra = {}) => ({ message, stage, ...extra });
  return { dir, profileDir, adapter, close: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function collection(items) {
  return {
    async count() { return items.length; },
    nth(index) { return items[index]; }
  };
}

const chromePathForSendTests = [
  process.env.CHROME_EXECUTABLE_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'
].filter(Boolean).find(candidate => fs.existsSync(candidate));

async function privateSendDomFixture(t, { disabled = false } = {}) {
  const f = fixture();
  t.after(f.close);
  const browser = await chromium.launch({ headless: true, executablePath: chromePathForSendTests });
  t.after(() => browser.close());
  const page = await browser.newPage();
  // Channels' footer is a column flexbox: .btn stretches across the footer,
  // while only its right-aligned child button owns the send event (2026-09-10).
  await page.setContent(`
    <style>
      .session-dialog { width: 840px; }
      .footer { display: flex; flex-direction: column; justify-content: space-between;
        height: 238px; padding: 16px 12px 12px 24px; }
      .footer .content { flex: 1; }
      .edit_area { width: 100%; height: 126px; }
      .footer .btn { text-align: end; padding-top: 7px; }
      .weui-desktop-btn { min-width: 120px; line-height: 40px; }
    </style>
    <div class="session-dialog">
      <div class="header"><div class="left">Test user</div></div>
      <div class="session-content-wrapper">
        <div class="content-left"><div class="message-plain">你好，</div></div>
      </div>
      <div class="footer">
        <div class="content"><textarea class="edit_area"></textarea></div>
        <div class="weui-desktop-btn_wrp default btn">
          <button type="button" class="weui-desktop-btn weui-desktop-btn_default" ${disabled ? 'disabled' : ''}>发送</button>
        </div>
      </div>
    </div>
    <script>
      document.querySelector('button').addEventListener('click', () => {
        const editor = document.querySelector('textarea');
        if (!editor.value.trim()) return;
        const bubble = document.createElement('div');
        bubble.className = 'content-right';
        const text = document.createElement('div');
        text.className = 'message-plain';
        text.textContent = editor.value;
        bubble.append(text);
        document.querySelector('.session-content-wrapper').append(bubble);
        editor.value = '';
      });
    </script>
  `);
  f.adapter.spec.privateReplyEvidenceTimeoutMs = 1;
  f.adapter.waitWechatPrivateSendEffect = async () => {};
  return { ...f, page };
}

test('wechat private reply submits through the nested button in a full-width send wrapper', { skip: !chromePathForSendTests }, async t => {
  const { adapter, page } = await privateSendDomFixture(t);
  // Only external navigation/identity checks are replaced; input, target
  // selection, physical click and outgoing-message confirmation stay real.
  adapter.getPage = async () => page;
  adapter.openPrivateConversationForPayload = async () => ({ ok: true });
  adapter.revalidatePrivateReplyTarget = async () => ({ ok: true });
  const output = await adapter.replyToMessage({
    platformCode: 'wechat_channels', accountId: 'test-account',
    messageType: 'PRIVATE_MESSAGE', replyText: '您好，请问您想了解哪方面的内容？',
    sourceContent: '你好，', userName: 'Test user',
    messageContext: { conversationId: 'test-conversation', messageId: 'test-message', direction: 'incoming',
      conversationName: 'Test user', previewOnly: false, sourceVerified: true, chatTitleVerified: true }
  });
  assert.equal(output.status, 'SUCCESS', JSON.stringify(output.result));
  assert.equal(await page.locator('textarea').inputValue(), '');
  assert.deepEqual(await page.locator('.content-right .message-plain').allTextContents(), ['您好，请问您想了解哪方面的内容？']);
});

test('wechat private send rejects a disabled nested button without claiming a click', { skip: !chromePathForSendTests }, async t => {
  const { adapter, page } = await privateSendDomFixture(t, { disabled: true });
  const editor = page.locator('textarea');
  await editor.fill('Test reply');
  const output = await adapter.clickPrivateSend(page, editor);
  assert.equal(output.clicked, false);
  assert.equal(await editor.inputValue(), 'Test reply');
  assert.equal(await page.locator('.content-right').count(), 0);
});

function privateConversationPage() {
  const state = { inboxLabels: ['私信'], rows: [], selected: null };
  const evaluate = (fn, element, options) => Promise.resolve(runInNewContext(`(${fn.toString()})(element, options)`, {
    element, options, getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' })
  }));
  const locatorFor = element => ({
    first() { return this; },
    nth() { return this; },
    async count() { return element ? 1 : 0; },
    async isVisible() { return Boolean(element); },
    async isEnabled() { return Boolean(element); },
    async innerText() { return element?.innerText || ''; },
    async getAttribute(name) { return element?.getAttribute?.(name) || null; },
    async evaluate(fn, options) { return evaluate(fn, element, options); },
    locator(selector) { return locatorFor(element?.querySelector?.(selector)); },
    async click() { state.selected = element; }
  });
  const makeRow = (name, avatarUrl, preview = 'Question') => {
    const fields = {
      '.feed-title .name': { innerText: name }, '.feed-info': { innerText: preview },
      '.feed-title .date': { innerText: '10:00' },
      img: { getAttribute: key => key === 'src' ? avatarUrl : null }
    };
    const element = {
      name, avatarUrl, preview, className: 'session-wrap', parentElement: null,
      getAttribute: () => null,
      getClientRects: () => [{}],
      querySelector: selector => fields[selector] || null,
      ownerDocument: {
        querySelectorAll: () => state.inboxLabels.map(label => ({
          innerText: label, getClientRects: () => [{}],
          closest: () => ({ classList: { contains: value => value === 'weui-desktop-tab__nav_current' } })
        }))
      }
    };
    return element;
  };
  const page = {
    url: () => 'https://channels.weixin.qq.com/platform/private_msg',
    locator: selector => selector === '.session-dialog .header .left' ? {
      async evaluateAll(fn, options) {
        const avatar = state.selected?.avatarUrl ? {
          getAttribute: name => name === 'src' ? state.selected.avatarUrl : null,
          getClientRects: () => [{}]
        } : null;
        const header = {
          querySelectorAll: () => avatar ? [avatar] : [],
          getAttribute: name => name === 'data-conversation-id' ? state.currentConversationId || null : null
        };
        const title = {
          innerText: state.selected?.name, getClientRects: () => [{}],
          getAttribute: () => null, closest: () => header
        };
        return evaluate(fn, state.selected ? [title] : [], options);
      }
    } : {
      async count() { return state.rows.length; },
      nth: index => locatorFor(state.rows[index])
    },
    async waitForTimeout() {}
  };
  return { state, page, makeRow, locatorFor };
}

test('adapter is isolated to wechat_channels', () => {
  const f = fixture();
  try { assert.equal(f.adapter.platformCode, 'wechat_channels'); }
  finally { f.close(); }
});

test('stopped platform blocks collection before profile or browser launch', async () => {
  const f = fixture();
  try {
    let guardCalls = 0;
    f.adapter.setRuntimeGuard(async () => {
      guardCalls += 1;
      const error = new Error('stopped');
      error.code = 'PLATFORM_STOPPED';
      throw error;
    });
    await assert.rejects(() => f.adapter.collectMessages({ types: ['COMMENT'] }), error => error.code === 'PLATFORM_STOPPED');
    assert.equal(guardCalls, 1);
    assert.equal(fs.existsSync(f.profileDir), false);
    assert.equal(f.adapter.context, null);
  } finally { f.close(); }
});

test('transient UNKNOWN login state is allowed to settle before reply is blocked', async () => {
  const f = fixture();
  try {
    const states = ['UNKNOWN', 'UNKNOWN', 'READY'];
    f.adapter.detectPageState = async () => states.shift() || 'READY';
    const page = { async waitForTimeout() {} };
    assert.equal(await f.adapter.waitForDetectedPageState(page, 1000), 'READY');
  } finally { f.close(); }
});

test('comment candidate reads exact user, body and event time through compatibility hook', async () => {
  const f = fixture();
  try {
    const values = new Map([
      ['.comment-user-name', { innerText: 'Alice' }],
      ['.comment-content', { innerText: 'Weekend open?' }],
      ['.comment-time', { innerText: '2026/08/07 09:33' }]
    ]);
    const locator = {
      evaluate(fn, selectors) { return Promise.resolve(fn({ querySelector: selector => values.get(selector) || null }, selectors)); }
    };
    assert.deepEqual(await f.adapter.readDouyinCommentCandidate(locator), {
      userName: 'Alice', content: 'Weekend open?', eventTime: '2026/08/07 09:33'
    });
  } finally { f.close(); }
});

test('comment reply requires work context even when only one video exists', async () => {
  const f = fixture();
  try {
    f.adapter.readWechatCommentVideoRows = async () => [{ index: 0, visible: true, count: 1, title: 'Only work', time: '2026/08/07 08:59', text: 'Only work' }];
    let opened = false;
    f.adapter.openWechatCommentVideoRow = async () => { opened = true; return { ok: true }; };
    const result = await f.adapter.openWechatCommentVideoForPayload({}, { messageContext: {} });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'COMMENT_VIDEO_CONTEXT_REQUIRED');
    assert.equal(opened, false);
  } finally { f.close(); }
});

test('comment editor is found only inside the selected comment scope', async () => {
  const f = fixture();
  try {
    assert.equal((await f.adapter.findWechatCommentEditor({}, {}, null)).reason, 'COMMENT_EDITOR_SCOPE_REQUIRED');
    const editor = { async isVisible() { return true; } };
    const root = {
      async isVisible() { return true; },
      locator(selector) { assert.equal(selector, 'textarea.create-input'); return collection([editor]); }
    };
    const scope = {
      locator(selector) { assert.equal(selector, '.comment-reply-list .comment-create-wrap'); return collection([root]); }
    };
    const result = await f.adapter.findDouyinCommentEditor({}, {}, scope);
    assert.equal(result.ok, true);
    assert.equal(result.root, root);
    assert.equal(result.editor, editor);
  } finally { f.close(); }
});

test('comment send clicks only the scoped primary control and checks runtime first', async () => {
  const f = fixture();
  try {
    const order = [];
    f.adapter.setRuntimeGuard(async () => { order.push('guard'); });
    const button = {
      async isVisible() { return true; },
      async isEnabled() { return true; },
      async click() { order.push('click'); }
    };
    const editorRoot = {
      locator(selector) { assert.equal(selector, '.create-ft .primary'); return collection([button]); }
    };
    const result = await f.adapter.clickDouyinCommentSend(editorRoot);
    assert.deepEqual(order, ['guard', 'click']);
    assert.equal(result.clicked, true);
    assert.equal(result.method, 'wechat-comment-scoped:.create-ft .primary');
  } finally { f.close(); }
});

test('private message source must remain the stable latest incoming bubble, not merely exist in the dialog', async () => {
  const f = fixture();
  try {
    f.adapter.inspectStablePrivateConversationTimeline = async () => ({
      stable: true,
      messages: [{ text: 'Exact source', direction: 'incoming' }],
      latestMessage: { text: 'Exact source', direction: 'incoming' }
    });
    const exact = await f.adapter.verifyWechatIncomingSource({}, { sourceContent: 'Exact source' });
    assert.equal(exact.ok, true);
    assert.equal(exact.sourceMessageCount, 1);

    f.adapter.inspectStablePrivateConversationTimeline = async () => ({
      stable: true,
      messages: [{ text: 'Exact source', direction: 'incoming' }, { text: 'Sent by us only', direction: 'outgoing' }],
      latestMessage: { text: 'Sent by us only', direction: 'outgoing' }
    });
    const stale = await f.adapter.verifyWechatIncomingSource({}, { sourceContent: 'Exact source' });
    assert.equal(stale.ok, false);
    assert.equal(stale.reason, 'SOURCE_MESSAGE_NOT_LATEST_IN_CONVERSATION');

    const outgoing = await f.adapter.verifyWechatIncomingSource({}, { sourceContent: 'Sent by us only' });
    assert.equal(outgoing.ok, false);
    assert.equal(outgoing.reason, 'SOURCE_MESSAGE_NOT_INCOMING');
  } finally { f.close(); }
});

test('wechat collected derived conversation identity locates the same avatar after list reorder', async () => {
  const f = fixture();
  const ui = privateConversationPage();
  try {
    const targetRow = ui.makeRow('Amy', 'https://wx.qlogo.cn/amy/0');
    ui.state.rows = [targetRow];
    f.adapter.prepareMessagePage = async () => ({});
    f.adapter.inspectLoginState = async () => ({ state: 'READY' });
    f.adapter.preparePrivateInbox = async () => ({ ok: true, handled: true, scope: ui.page });
    f.adapter.waitForMessageContentReady = async () => ({ ready: true, pageCheck: { valid: true }, scope: ui.page });
    f.adapter.resolvePrivateReplyScope = async () => ui.page;
    f.adapter.waitForPrivateConversationHeader = async () => ({ ok: true, headerName: ui.state.selected?.name });
    f.adapter.inspectStablePrivateConversationTimeline = async () => ({
      stable: true,
      messages: [{ text: ui.state.selected?.preview, direction: 'incoming' }],
      latestMessage: { text: ui.state.selected?.preview, direction: 'incoming' }
    });
    const [conversation] = await f.adapter.readWechatPrivateConversations(ui.page, 'MAIN');
    const collected = await f.adapter.inspectWechatPrivateConversationCandidate(ui.page, conversation, { accountId: 'test-account' });
    assert.equal(collected.status, 'VERIFIED', collected.reason);
    assert.equal(collected.message.context.conversationIdentitySource, 'wechat-avatar-inbox-name-derived');

    const otherRow = ui.makeRow('Amy', 'https://wx.qlogo.cn/another-amy/0');
    ui.state.rows = [otherRow, targetRow];
    ui.state.selected = null;
    const opened = await f.adapter.openPrivateConversationForPayload(ui.page, {
      userName: collected.message.userName, sourceContent: collected.message.content,
      messageContext: collected.message.context
    }, { requireUnreadEvidence: false });
    assert.equal(opened.ok, true, opened.reason);
    assert.equal(ui.state.selected, targetRow);
    assert.equal(opened.conversationId, collected.message.context.conversationId);
  } finally { f.close(); }
});

test('wechat derived conversation identity requires an unambiguous active inbox and avatar', async () => {
  const f = fixture();
  const ui = privateConversationPage();
  try {
    const row = ui.locatorFor(ui.makeRow('Amy', 'https://wx.qlogo.cn/amy/0'));
    const main = await f.adapter.readPrivateConversationRowIdentity(row);
    assert.match(main.conversationId || '', /^wechat-conversation-/);
    ui.state.inboxLabels = ['打招呼消息'];
    const greeting = await f.adapter.readPrivateConversationRowIdentity(row);
    assert.notEqual(main.conversationId, greeting.conversationId);
    for (const labels of [[], ['私信', '打招呼消息']]) {
      ui.state.inboxLabels = labels;
      assert.equal((await f.adapter.readPrivateConversationRowIdentity(row)).conversationId, null);
    }
    ui.state.inboxLabels = ['私信'];
    const noAvatar = ui.locatorFor(ui.makeRow('Amy', ''));
    assert.equal((await f.adapter.readPrivateConversationRowIdentity(noAvatar)).conversationId, null);
  } finally { f.close(); }
});

test('wechat send-time validation rejects a same-name same-text conversation with a different visible avatar', async () => {
  const f = fixture();
  const ui = privateConversationPage();
  try {
    f.adapter.locatePrivateConversationHeader = async () => ({ ok: true, headerName: 'Amy' });
    f.adapter.inspectStablePrivateConversationTimeline = async () => ({
      stable: true, messages: [{ text: 'Question', direction: 'incoming' }],
      latestMessage: { text: 'Question', direction: 'incoming' }
    });
    const payload = {
      userName: 'Amy', sourceContent: 'Question',
      messageContext: { conversationId: 'wechat-conversation-target', avatarUrl: 'https://wx.qlogo.cn/amy/0' }
    };
    ui.state.selected = ui.makeRow('Amy', 'https://wx.qlogo.cn/another-amy/0');
    const changed = await f.adapter.revalidatePrivateReplyTarget(ui.page, payload);
    assert.equal(changed.ok, false);
    assert.equal(changed.reason, 'CONVERSATION_AVATAR_MISMATCH');

    ui.state.selected = ui.makeRow('Amy', 'https://wx.qlogo.cn/amy/0');
    assert.equal((await f.adapter.revalidatePrivateReplyTarget(ui.page, payload)).ok, true);
    ui.state.selected = ui.makeRow('Amy', '');
    assert.equal((await f.adapter.revalidatePrivateReplyTarget(ui.page, payload)).ok, true);
  } finally { f.close(); }
});

test('wechat send-time validation rejects a different current stable conversation ID', async () => {
  const f = fixture();
  const ui = privateConversationPage();
  try {
    ui.state.selected = ui.makeRow('Amy', '');
    ui.state.currentConversationId = 'conversation-other';
    f.adapter.locatePrivateConversationHeader = async () => ({ ok: true, headerName: 'Amy' });
    f.adapter.inspectStablePrivateConversationTimeline = async () => ({
      stable: true, messages: [{ text: 'Question', direction: 'incoming' }],
      latestMessage: { text: 'Question', direction: 'incoming' }
    });
    const result = await f.adapter.revalidatePrivateReplyTarget(ui.page, {
      userName: 'Amy', sourceContent: 'Question', messageContext: { conversationId: 'conversation-target' }
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'CONVERSATION_STABLE_ID_MISMATCH');
  } finally { f.close(); }
});

test('publish verification becomes NEEDS_CONFIRMATION and is never retry-safe', async () => {
  const f = fixture();
  const materialPath = path.join(f.dir, 'video.mp4');
  fs.writeFileSync(materialPath, 'x');
  try {
    f.adapter.getPage = async () => ({ async goto() {}, async waitForTimeout() {} });
    f.adapter.waitForReady = async () => true;
    f.adapter.prepareDraft = async () => { throw new Error('\u9700\u8981\u7ed1\u5b9a\u624b\u673a\u53f7'); };
    const output = await f.adapter.publish({ materialPath, publishMode: 'AUTO', managementConfirmed: true });
    assert.equal(output.status, 'NEEDS_CONFIRMATION');
    assert.equal(output.result.retrySafe, false);
    assert.equal(output.result.manualReviewRequired, true);
  } finally { f.close(); }
});

test('wechat private send does not press Enter when button click already clears the editor', async () => {
  const f = fixture();
  try {
    let editorValue = 'Hello';
    const pressed = [];
    const editor = {
      async click() {},
      async inputValue() { return editorValue; },
      async press(key) { pressed.push(key); }
    };
    f.adapter.countExactPrivateMessages = async () => ({ count: 0, matches: [] });
    f.adapter.clickWechatPrivateSendControl = async () => {
      editorValue = '';
      return { clicked: true, method: 'button-click', evidence: { text: '发送' } };
    };
    f.adapter.waitWechatPrivateSendEffect = async () => {};

    const result = await f.adapter.clickPrivateSend({}, editor);
    assert.equal(result.clicked, true);
    assert.equal(result.method, 'button-click');
    assert.equal(result.evidence.clickProducedEffect, true);
    assert.equal(result.evidence.enterFallbackAttempted, false);
    assert.deepEqual(pressed, []);
  } finally { f.close(); }
});

test('wechat private send never resubmits when the first click has no immediate receipt', async () => {
  const f = fixture();
  try {
    let editorValue = 'Hello';
    const pressed = [];
    const editor = {
      async click() {},
      async inputValue() { return editorValue; },
      async press(key) { pressed.push(key); if (key === 'Enter') editorValue = ''; }
    };
    f.adapter.countExactPrivateMessages = async () => ({ count: 0, matches: [] });
    f.adapter.clickWechatPrivateSendControl = async () => ({ clicked: true, method: 'button-click', evidence: { text: '发送' } });
    f.adapter.waitWechatPrivateSendEffect = async () => {};

    const result = await f.adapter.clickPrivateSend({}, editor);
    assert.equal(result.clicked, true);
    assert.equal(result.method, 'button-click');
    assert.equal(result.evidence.clickProducedEffect, false);
    assert.equal(result.evidence.enterFallbackAttempted, false);
    assert.deepEqual(pressed, []);
  } finally { f.close(); }
});

test('wechat private reply confirms a delayed button submission without a second send', async () => {
  const f = fixture();
  try {
    let editorValue = '';
    let submitCount = 0;
    let echoCount = 0;
    const editor = {
      async click() {},
      evaluate(fn) { return Promise.resolve(fn({ tagName: 'TEXTAREA' })); },
      async fill(value) { editorValue = value; },
      async pressSequentially(value) { editorValue += value; },
      async inputValue() { return editorValue; },
      async press(key) {
        if (key === 'Backspace') editorValue = '';
        if (key === 'Enter') submitCount += 1;
      }
    };
    f.adapter.getPage = async () => ({ locator: () => ({ innerText: async () => '', evaluateAll: async () => [] }) });
    f.adapter.openPrivateConversationForPayload = async () => ({ ok: true });
    f.adapter.resolvePrivateReplyScope = async page => page;
    f.adapter.revalidatePrivateReplyTarget = async () => ({ ok: true });
    f.adapter.findReplyEditor = async () => editor;
    f.adapter.countExactPrivateMessages = async () => ({ count: echoCount, matches: [] });
    f.adapter.clickWechatPrivateSendControl = async () => {
      submitCount += 1;
      return { clicked: true, method: 'button-click' };
    };
    f.adapter.waitWechatPrivateSendEffect = async () => {};
    f.adapter.waitForReplyEvidence = async readEvidence => {
      assert.equal((await readEvidence()).confirmed, false);
      editorValue = '';
      echoCount = submitCount;
      return readEvidence();
    };

    const output = await f.adapter.replyToMessage({
      platformCode: 'wechat_channels', accountId: 'test-account', messageType: 'PRIVATE_MESSAGE', replyText: 'Knowledge reply',
      sourceContent: 'Question', userName: 'Alice',
      messageContext: { conversationId: 'conversation-Alice', messageId: 'message-Question', direction: 'incoming',
        conversationName: 'Alice', unread: true, previewOnly: false, sourceVerified: true, chatTitleVerified: true }
    });
    assert.equal(output.status, 'SUCCESS', JSON.stringify(output.result));
    assert.equal(output.result.stage, 'reply_sent');
    assert.equal(output.result.scopedEchoCount, 1);
    assert.equal(submitCount, 1);
  } finally { f.close(); }
});

test('wechat private send does not press Enter when a new outgoing echo appears after click', async () => {
  const f = fixture();
  try {
    let echoCount = 0;
    const pressed = [];
    const editor = {
      async click() {},
      async inputValue() { return 'Hello'; },
      async press(key) { pressed.push(key); }
    };
    f.adapter.countExactPrivateMessages = async () => ({ count: echoCount, matches: [] });
    f.adapter.clickWechatPrivateSendControl = async () => {
      echoCount = 1;
      return { clicked: true, method: 'button-click', evidence: { text: '发送' } };
    };
    f.adapter.waitWechatPrivateSendEffect = async () => {};

    const result = await f.adapter.clickPrivateSend({}, editor);
    assert.equal(result.clicked, true);
    assert.equal(result.method, 'button-click');
    assert.equal(result.evidence.clickProducedEffect, true);
    assert.equal(result.evidence.enterFallbackAttempted, false);
    assert.deepEqual(pressed, []);
  } finally { f.close(); }
});

test('uncertain publish or reply after final action is marked non-idempotent', async () => {
  const f = fixture();
  const materialPath = path.join(f.dir, 'video.mp4');
  fs.writeFileSync(materialPath, 'x');
  try {
    f.adapter.getPage = async () => ({ async goto() {}, async waitForTimeout() {} });
    f.adapter.waitForReady = async () => true;
    f.adapter.prepareDraft = async () => ({ readiness: { ready: true } });
    f.adapter.clickFinalPublish = async () => { f.adapter.wechatFinalPublishEntered = true; throw new Error('connection reset'); };
    const publish = await f.adapter.publish({ materialPath, publishMode: 'AUTO', managementConfirmed: true });
    assert.equal(publish.status, 'NEEDS_CONFIRMATION');
    assert.equal(publish.result.submissionStatus, 'UNKNOWN');
    assert.equal(publish.result.retrySafe, false);
    assert.equal(publish.result.nonIdempotent, true);

    let editorValue = '';
    const editor = {
      async click() {},
      evaluate(fn) { return Promise.resolve(fn({ tagName: 'TEXTAREA' })); },
      async fill(value) { editorValue = value; },
      async pressSequentially(value) { editorValue += value; },
      async inputValue() { return editorValue; }
    };
    f.adapter.openPrivateConversationForPayload = async () => ({ ok: true });
    f.adapter.revalidatePrivateReplyTarget = async () => ({ ok: true });
    f.adapter.findReplyEditor = async () => editor;
    f.adapter.countExactPrivateMessages = async () => ({ count: 0, matches: [] });
    f.adapter.clickPrivateSend = async () => { f.adapter.wechatReplySendEntered = true; return { clicked: true, method: 'stub' }; };
    f.adapter.waitForReplyEvidence = async () => ({ confirmed: false, phoneCheckBlocked: false, editorCleared: false, scopedEchoCount: 0, baselineEchoCount: 0 });
    const reply = await f.adapter.replyToMessage({
      platformCode: 'wechat_channels', accountId: 'test-account', messageType: 'PRIVATE_MESSAGE', replyText: 'Knowledge reply', sourceContent: 'Question', userName: 'Alice',
      messageContext: { conversationId: 'conversation-Alice', messageId: 'message-Question', direction: 'incoming', conversationName: 'Alice', unread: true, previewOnly: false, sourceVerified: true, chatTitleVerified: true }
    });
    assert.equal(reply.status, 'NEEDS_CONFIRMATION');
    assert.equal(reply.result.stage, 'reply_unconfirmed');
    assert.equal(reply.result.retrySafe, false);
    assert.equal(reply.result.nonIdempotent, true);

    f.adapter.waitForReplyEvidence = async () => ({ confirmed: true, phoneCheckBlocked: false, editorCleared: true, scopedEchoCount: 1, baselineEchoCount: 0 });
    const sent = await f.adapter.replyToMessage({
      platformCode: 'wechat_channels', accountId: 'test-account', messageType: 'PRIVATE_MESSAGE', replyText: 'Knowledge reply', sourceContent: 'Question', userName: 'Alice',
      messageContext: { conversationId: 'conversation-Alice', messageId: 'message-Question', direction: 'incoming', conversationName: 'Alice', unread: true, previewOnly: false, sourceVerified: true, chatTitleVerified: true }
    });
    assert.equal(sent.status, 'SUCCESS');
    assert.equal(sent.result.stage, 'reply_sent');
    assert.equal(sent.result.sendMethod, 'wechat-channels:stub');
  } finally { f.close(); }
});

test('wechat channels reads the current account name from the menu footer', async () => {
  const f = fixture();
  try {
    const page = {
      locator(selector) {
        return {
          first() { return this; },
          async isVisible() { return selector.includes('finder-ui-desktop-menu__footer'); },
          async innerText() { return '\u4e5d\u9f84\u4e4b\u9152'; }
        };
      }
    };
    const identity = await f.adapter.readWechatAccountIdentity(page);
    assert.equal(identity.platformUserName, '\u4e5d\u9f84\u4e4b\u9152');
    assert.match(identity.source, /^wechat-channels-dom:/);
  } finally { f.close(); }
});

test('wechat channels passes current account identity into every collected comment context', async () => {
  const f = fixture();
  try {
    f.adapter.readWechatCommentVideoRows = async () => [{ index: 0, visible: true, count: 1 }];
    f.adapter.readWechatAccountIdentity = async () => ({ platformUserName: '\u4e5d\u9f84\u4e4b\u9152', source: 'wechat-channels-dom:test' });
    f.adapter.openWechatCommentVideoRow = async () => ({ ok: true, sourceContext: { sourceVideoKey: 'video-1' } });
    let receivedSourceContext = null;
    f.adapter.extractMessages = async (_page, _type, _payload, options) => {
      receivedSourceContext = options.sourceContext;
      return [{ externalId: 'comment-1' }];
    };
    const result = await f.adapter.collectWechatChannelComments({}, {});
    assert.equal(result.ok, true);
    assert.equal(receivedSourceContext.accountUserName, '\u4e5d\u9f84\u4e4b\u9152');
    assert.equal(receivedSourceContext.accountIdentitySource, 'wechat-channels-dom:test');
    assert.equal(receivedSourceContext.sourceVideoKey, 'video-1');
  } finally { f.close(); }
});

test('wechat channels finds an older work after scrolling the work list', async () => {
  const f = fixture();
  try {
    let round = 0;
    let openedTitle = '';
    const page = { waitForTimeout: async () => {} };
    f.adapter.readWechatCommentVideoRows = async () => round === 0
      ? [{ index: 0, visible: true, count: 1, title: 'latest work', time: '2026/08/12 09:00', text: 'latest work' }]
      : [{ index: 0, visible: true, count: 1, title: 'older work', time: '2026/07/20 09:00', text: 'older work' }];
    f.adapter.advanceHistoricalCommentList = async () => { round += 1; return { attempted: true, moved: true, reason: 'SCROLLED_CONTAINER' }; };
    f.adapter.openWechatCommentVideoRow = async (_page, row) => { openedTitle = row.title; return { ok: true, sourceContext: f.adapter.wechatCommentVideoContext(row) }; };
    const result = await f.adapter.openWechatCommentVideoForPayload(page, { messageContext: { sourceVideoTitle: 'older work', sourceVideoTime: '2026/07/20 09:00' } }, { maxRounds: 2 });
    assert.equal(result.ok, true);
    assert.equal(result.scanRounds, 2);
    assert.equal(openedTitle, 'older work');
  } finally { f.close(); }
});

test('wechat channels collects comments from a historical work discovered on the second scan', async () => {
  const f = fixture();
  try {
    let round = 0;
    const page = { waitForTimeout: async () => {} };
    f.adapter.readWechatAccountIdentity = async () => ({ platformUserName: 'test-account', source: 'wechat-channels-dom:test' });
    f.adapter.readWechatCommentVideoRows = async () => round === 0
      ? [{ index: 0, visible: true, count: 0, title: 'latest work', time: '2026/08/12 09:00', text: 'latest work' }]
      : [{ index: 0, visible: true, count: 1, title: 'older work', time: '2026/07/20 09:00', text: 'older work' }];
    f.adapter.advanceHistoricalCommentList = async () => { round += 1; return { attempted: true, moved: true, reason: 'SCROLLED_CONTAINER' }; };
    f.adapter.openWechatCommentVideoRow = async (_page, row) => ({ ok: true, sourceContext: f.adapter.wechatCommentVideoContext(row) });
    f.adapter.extractMessages = async (_page, _type, _payload, options) => [{ externalId: 'historical-wechat-comment-1', context: options.sourceContext }];
    const result = await f.adapter.collectWechatChannelComments(page, {}, { maxRounds: 2 });
    assert.equal(result.ok, true);
    assert.equal(result.scanRounds, 2);
    assert.equal(result.messages.length, 1);
    assert.equal(result.messages[0].context.sourceVideoTitle, 'older work');
  } finally { f.close(); }
});

test('wechat channels never guesses when multiple historical work identities are identical', async () => {
  const f = fixture();
  try {
    f.adapter.readWechatCommentVideoRows = async () => [
      { index: 0, visible: true, count: 1, title: 'same work', time: '2026/07/20 09:00', text: 'same work' },
      { index: 1, visible: true, count: 2, title: 'same work', time: '2026/07/20 09:00', text: 'same work' }
    ];
    const result = await f.adapter.openWechatCommentVideoForPayload({}, { messageContext: { sourceVideoTitle: 'same work', sourceVideoTime: '2026/07/20 09:00' } }, { maxRounds: 1 });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'COMMENT_VIDEO_TARGET_AMBIGUOUS');
  } finally { f.close(); }
});


test('视频号最终发表流程进入前停止时标记 writeAttempted=false', async () => {
  const f = fixture();
  const materialPath = path.join(f.dir, 'video-before-stop.mp4');
  fs.writeFileSync(materialPath, 'x');
  try {
    f.adapter.getPage = async () => {
      const error = new Error('platform stopped before publish page');
      error.code = 'PLATFORM_STOPPED';
      throw error;
    };
    await assert.rejects(
      () => f.adapter.publish({ materialPath, publishMode: 'AUTO', managementConfirmed: true }),
      error => error.code === 'PLATFORM_STOPPED' && error.writeAttempted === false
    );
    assert.equal(f.adapter.wechatFinalPublishEntered, false);
  } finally { f.close(); }
});

test('视频号进入最终发表调用后停止保持非幂等不确定，禁止标记为安全重试', async () => {
  const f = fixture();
  const materialPath = path.join(f.dir, 'video-during-final.mp4');
  fs.writeFileSync(materialPath, 'x');
  try {
    f.adapter.getPage = async () => ({ async goto() {}, async waitForTimeout() {} });
    f.adapter.waitForReady = async () => true;
    f.adapter.prepareDraft = async () => ({ readiness: { ready: true, stableReadySamples: 5 } });
    f.adapter.clickFinalPublish = async () => {
      f.adapter.wechatFinalPublishEntered = true;
      const error = new Error('platform stopped during final publish');
      error.code = 'PLATFORM_OPERATION_CANCELLED';
      throw error;
    };

    await assert.rejects(
      () => f.adapter.publish({ materialPath, publishMode: 'AUTO', managementConfirmed: true }),
      error => error.code === 'PLATFORM_OPERATION_CANCELLED' && error.writeAttempted === true
    );
    assert.equal(f.adapter.wechatFinalPublishEntered, true);
  } finally { f.close(); }
});
