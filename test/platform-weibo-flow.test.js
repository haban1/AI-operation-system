import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import {
  WeiboAssistedRpaAdapter,
  assessWeiboCommentDetailReplyEvidence,
  assessWeiboSentCommentReplyEvidence,
  assessWeiboPublishReceipt,
  classifyWeiboPublishNetworkEvidence,
  dedupeWeiboPublishMatches,
  validateWeiboReplyPayload,
  weiboContentDeclarationLabels
} from '../agent/rpa-adapters/weibo-assisted.js';

function makeAdapter() {
  const logsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'weibo-flow-'));
  const adapter = new WeiboAssistedRpaAdapter({ logsDir, profileDir: path.join(logsDir, 'profile'), sendTimeoutMs: 1 });
  adapter.evidence = async (_payload, message, _page, stage, extra = {}) => ({ message, stage, ...extra });
  return adapter;
}

function makeEditor(onEnter = () => {}) {
  let value = '';
  return {
    evaluate: async () => 'textarea',
    fill: async text => { value = text; },
    inputValue: async () => value,
    innerText: async () => value,
    textContent: async () => value,
    press: async key => { if (key === 'Enter') { onEnter(); value = ''; } },
    isVisible: async () => true,
    isEnabled: async () => true,
    boundingBox: async () => ({ x: 0, y: 0, width: 400, height: 80 }),
    clear: () => { value = ''; }
  };
}

function locatorCollection(itemsOrFactory) {
  const items = () => typeof itemsOrFactory === 'function' ? itemsOrFactory() : itemsOrFactory;
  return {
    count: async () => items().length,
    nth: index => items()[index],
    first: () => items()[0]
  };
}

function visibleControl({ text = '', onClick = () => {} } = {}) {
  return {
    innerText: async () => text,
    textContent: async () => text,
    isVisible: async () => true,
    isEnabled: async () => true,
    click: async () => onClick()
  };
}

function validCommentPayload() {
  return {
    messageType: 'COMMENT', userName: 'alice', sourceContent: '原评论', replyText: '知识库生成回复',
    messageContext: { commentId: '5013415519847148', sourceVerified: true, historical: false }
  };
}

function validPrivatePayload() {
  return {
    messageType: 'PRIVATE_MESSAGE', userName: 'bob', sourceContent: '原私信', replyText: '知识库生成回复',
    messageContext: { messageId: '4479825538150513', direction: 'incoming', sourceVerified: true, chatTitleVerified: true, previewOnly: false, historical: false }
  };
}

const weiboChromePath = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'
].find(candidate => fs.existsSync(candidate));

test('微博私信稳定身份丢失时不点击旧索引，列表重排后仍点击原会话', { skip: !weiboChromePath }, async () => {
  const adapter = makeAdapter();
  const browser = await chromium.launch({ headless: true, executablePath: weiboChromePath });
  try {
    const page = await browser.newPage();
    await page.setContent(`<ul>
      <li class="sessionlist" data-id="target" onclick="window.clicked='target'"><span class="one-line username">bob</span><span class="lastmsg">原私信</span></li>
      <li class="sessionlist" data-id="other" onclick="window.clicked='other'"><span class="one-line username">other</span><span class="lastmsg">别的消息</span></li>
    </ul>`);
    const located = await adapter.locateConversationRow(page, { conversationKey: 'target', userName: 'bob', preview: '原私信' });
    await page.evaluate(() => document.querySelector('ul').prepend(document.querySelector('[data-id="other"]')));
    await located.click();
    assert.equal(await page.evaluate(() => window.clicked), 'target');
    await located.dispose();
    await page.locator('[data-id="target"]').evaluate(element => element.remove());
    const missing = await adapter.locateConversationRow(page, { conversationKey: 'target', userName: 'bob', preview: '原私信' }, page.locator('li.sessionlist').first());
    assert.equal(missing, null);
  } finally { await browser.close(); }
});

test('微博定向恢复在列表重排后按稳定身份打开目标会话', { skip: !weiboChromePath }, async () => {
  const adapter = makeAdapter();
  const browser = await chromium.launch({ headless: true, executablePath: weiboChromePath });
  try {
    const page = await browser.newPage();
    await page.setContent(`<ul id="sessions">
      <li class="sessionlist" data-id="target" onclick="window.clicked='target'"><span class="one-line username">bob</span><span class="lastmsg">原私信</span><span class="num">1</span></li>
      <li class="sessionlist" data-id="other" onclick="window.clicked='other'"><span class="one-line username">bob</span><span class="lastmsg">其他私信</span></li></ul>
      <section class="message"><div class="header"><span class="friendname">bob</span></div>
      <ul class="chat-content"><li id="4479825538150513"><div class="message-item other"><span class="puretext">原私信</span></div></li></ul></section>`);
    const localPage = { locator: selector => page.locator(selector), goto: async () => {}, waitForTimeout: async () => {}, url: () => 'https://api.weibo.com/chat/#/chat' };
    adapter.inspectLoginState = async () => ({ state: 'READY' });
    adapter.assertWeiboOperationAllowed = async () => {};
    const originalLocate = adapter.locateRecoveryConversationByStableKey.bind(adapter);
    adapter.locateRecoveryConversationByStableKey = async (...args) => {
      const target = await originalLocate(...args);
      await page.evaluate(() => document.querySelector('#sessions').prepend(document.querySelector('[data-id="other"]')));
      return target;
    };
    await adapter.collectTargetedPrivateMessages(localPage, {}, { targets: [{ externalConversationKey: 'target' }] });
    assert.equal(await page.evaluate(() => window.clicked), 'target');
  } finally { await browser.close(); }
});

test('微博复用当前会话仍排除系统名称和列表中高置信官方来源', { skip: !weiboChromePath }, async () => {
  const adapter = makeAdapter();
  const browser = await chromium.launch({ headless: true, executablePath: weiboChromePath });
  try {
    const page = await browser.newPage();
    const localPage = { url: () => 'https://api.weibo.com/chat/#/chat', locator: selector => page.locator(selector), goto: async () => { throw new Error('无需导航'); } };
    adapter.inspectLoginState = async () => ({ state: 'READY' });
    for (const userName of ['系统通知', 'bob']) {
      await page.setContent(`${userName === 'bob' ? '<li class="sessionlist"></li>' : ''}
        <section class="message"><div class="header"><span class="friendname">${userName}</span></div>
        <ul class="chat-content"><li id="4479825538150513"><div class="message-item other"><span class="puretext">原私信</span></div></li></ul></section>`);
      adapter.readConversationRow = async () => ({ userName, preview: '发来了一条链接消息', verifiedAccount: true, conversationKey: 'official' });
      const result = await adapter.openPrivateConversation(localPage, { ...validPrivatePayload(), userName }, true);
      assert.equal(result.ok, false);
      assert.equal(result.reason, 'PRIVATE_OFFICIAL_SOURCE');
    }
  } finally { await browser.close(); }
});

for (const switchAfterSend of [false, true]) test(switchAfterSend ? '微博发送后切换会话时不能用另一会话的回显确认成功' : '微博私信使用消息列表旁的同会话输入框发送并核验回执', { skip: !weiboChromePath }, async () => {
  const adapter = makeAdapter();
  const browser = await chromium.launch({ headless: true, executablePath: weiboChromePath });
  try {
    const page = await browser.newPage();
    await page.setContent(`<textarea id="webchat-textarea" class="editor textarea-content">其他输入框</textarea>
      <section class="textbox"><div class="message"><div class="header"><span class="friendname">bob</span></div>
      <ul class="chat-content"><li id="4479825538150513"><div class="message-item other"><span class="puretext">原私信</span></div></li></ul></div>
      <div class="text"><div class="sendbox_cont"><div class="atwho-wrap">
      <textarea id="webchat-textarea" class="editor textarea-content pastable"></textarea></div></div></div></section>`);
    const localPage = {
      url: () => 'https://api.weibo.com/chat/#/chat',
      locator: selector => page.locator(selector),
      goto: async () => { throw new Error('当前有效会话不应重载'); },
      waitForTimeout: async () => {}
    };
    adapter.inspectLoginState = async () => ({ state: 'READY' });
    adapter.getPage = async () => localPage;
    adapter.assertWeiboOperationAllowed = async () => {};
    await page.locator('.textbox textarea').evaluate((element, switchAfterSend) => element.addEventListener('keydown', event => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      window.sent = (window.sent || 0) + 1;
      const row = document.createElement('li');
      row.innerHTML = '<div class="message-item me"><span class="puretext"></span></div>';
      row.querySelector('.puretext').textContent = element.value;
      element.closest('.textbox').querySelector('.chat-content').append(row);
      element.value = '';
      if (switchAfterSend) element.closest('.textbox').querySelector('.friendname').textContent = '另一个用户';
    }), switchAfterSend);
    const result = await adapter.replyToMessage(validPrivatePayload());
    assert.equal(result.status, switchAfterSend ? 'NEEDS_CONFIRMATION' : 'SUCCESS', JSON.stringify(result.result));
    if (switchAfterSend) assert.equal(result.result.sendAttempted, true);
    assert.equal(await page.evaluate(() => window.sent || 0), 1);
    assert.equal(await page.locator('body > textarea').inputValue(), '其他输入框');
  } finally { await browser.close(); }
});

test('微博私信不借用其他会话输入框，当前会话输入框不唯一时不发送', { skip: !weiboChromePath }, async () => {
  const adapter = makeAdapter();
  const browser = await chromium.launch({ headless: true, executablePath: weiboChromePath });
  try {
    const page = await browser.newPage();
    const editor = '<textarea id="webchat-textarea" class="editor textarea-content">原有草稿</textarea>';
    for (const composer of ['', `<div class="text">${editor}${editor}</div>`]) {
      await page.setContent(`<section class="textbox"><div class="message"><div class="header"><span class="friendname">bob</span></div>
        <ul class="chat-content"><li id="4479825538150513"><div class="message-item other"><span class="puretext">原私信</span></div></li></ul></div>${composer}</section>
        <section class="textbox"><div class="text">${editor}</div></section>`);
      const localPage = { url: () => 'https://api.weibo.com/chat/#/chat', locator: selector => page.locator(selector) };
      adapter.inspectLoginState = async () => ({ state: 'READY' });
      adapter.getPage = async () => localPage;
      adapter.assertWeiboOperationAllowed = async () => {};
      await page.evaluate(() => { window.sent = 0; document.addEventListener('keydown', event => { if (event.key === 'Enter') window.sent += 1; }); });
      const result = await adapter.replyToMessage(validPrivatePayload());
      assert.equal(result.status, 'NEEDS_CONFIRMATION');
      assert.equal(result.result.stage, 'reply_editor_missing');
      assert.equal(await page.evaluate(() => window.sent), 0);
      assert.ok((await page.locator('textarea').evaluateAll(elements => elements.map(element => element.value))).every(value => value === '原有草稿'));
    }
  } finally { await browser.close(); }
});

test('微博私信 Enter 结果未知时保留已发送尝试，禁止按未发送重试', async () => {
  const adapter = makeAdapter();
  let presses = 0;
  const editor = makeEditor();
  editor.press = async () => { presses += 1; throw new Error('Enter response lost'); };
  adapter.getPage = async () => ({ locator: () => ({}), waitForTimeout: async () => {} });
  adapter.openPrivateConversation = async () => ({ ok: true, uniqueTargetMatch: true, targetIdentityVerified: true });
  adapter.findPrivateEditor = async () => editor;
  adapter.countScopedEchoes = async () => 0;
  adapter.assertWeiboOperationAllowed = async () => {};
  const result = await adapter.replyToMessage(validPrivatePayload());
  assert.equal(result.status, 'NEEDS_CONFIRMATION');
  assert.equal(result.result.sendAttempted, true);
  assert.equal(result.result.stage, 'reply_unconfirmed');
  assert.equal(presses, 1);
});

test('微博私信发送后的平台中断保留未知结果，不能抛出可重试的写前中断', async () => {
  const adapter = makeAdapter();
  let sent = false;
  const editor = makeEditor(() => { sent = true; });
  adapter.getPage = async () => ({ locator: () => ({}), waitForTimeout: async () => {} });
  adapter.openPrivateConversation = async () => ({ ok: true, uniqueTargetMatch: true, targetIdentityVerified: true });
  adapter.findPrivateEditor = async () => editor;
  adapter.countScopedEchoes = async () => {
    if (sent) { const error = new Error('stopped after send'); error.code = 'PLATFORM_OPERATION_CANCELLED'; throw error; }
    return 0;
  };
  adapter.assertWeiboOperationAllowed = async () => {};
  const result = await adapter.replyToMessage(validPrivatePayload());
  assert.equal(result.status, 'NEEDS_CONFIRMATION');
  assert.equal(result.result.sendAttempted, true);
  assert.equal(result.result.stage, 'reply_unconfirmed');
});

function makeLoginStatePage(url, { bodyText = '', visibleSelectors = [] } = {}) {
  const visibleSet = new Set(visibleSelectors);
  const empty = { isVisible: async () => false };
  return {
    url: () => url,
    locator: selector => {
      if (selector === 'body') return { innerText: async () => bodyText };
      return { first: () => visibleSet.has(selector) ? { isVisible: async () => true } : empty };
    }
  };
}

test('微博登录状态：newlogin 明确判定为未登录', async () => {
  const adapter = makeAdapter();
  const result = await adapter.inspectLoginState(makeLoginStatePage(
    'https://weibo.com/newlogin?tabtype=weibo&gid=102803&openLoginLayer=0&url=https://weibo.com/'
  ));
  assert.deepEqual(result, { state: 'LOGIN', evidence: ['login-url'] });
});

test('微博登录状态：首页无可靠账号证据时保持无法确认', async () => {
  const adapter = makeAdapter();
  const result = await adapter.inspectLoginState(makeLoginStatePage('https://weibo.com/'));
  assert.deepEqual(result, { state: 'UNKNOWN', evidence: ['weibo-home-identity-unconfirmed'] });
});

test('微博登录状态：首页只有信息流头像时不能确认当前账号已登录', async () => {
  const adapter = makeAdapter();
  const result = await adapter.inspectLoginState(makeLoginStatePage('https://weibo.com/', {
    visibleSelectors: ['[class*="woo-avatar-main"]']
  }));
  assert.deepEqual(result, { state: 'UNKNOWN', evidence: ['weibo-home-identity-unconfirmed'] });
});

test('微博登录状态：首页顶部账号头像可确认身份有效', async () => {
  const adapter = makeAdapter();
  const selector = 'header [class*="woo-avatar-main"]';
  const result = await adapter.inspectLoginState(makeLoginStatePage('https://weibo.com/', {
    visibleSelectors: [selector]
  }));
  assert.deepEqual(result, {
    state: 'READY',
    evidence: ['authenticated-url', `authenticated-selector:${selector}`]
  });
});

test('微博登录状态：私信正文提到安全验证时不覆盖已加载的会话证据', async () => {
  const adapter = makeAdapter();
  const result = await adapter.inspectLoginState(makeLoginStatePage('https://api.weibo.com/chat/#/chat', {
    bodyText: '用户问：为什么总是提示请完成安全验证？',
    visibleSelectors: ['ul.contactslist']
  }));
  assert.deepEqual(result, {
    state: 'READY',
    evidence: ['authenticated-url:weibo-chat', 'authenticated-selector:ul.contactslist']
  });
});

test('微博登录状态：可见验证码组件才作为强验证证据', async () => {
  const adapter = makeAdapter();
  const selector = 'iframe[src*="captcha" i]';
  const result = await adapter.inspectLoginState(makeLoginStatePage('https://weibo.com/', {
    bodyText: '请完成安全验证',
    visibleSelectors: [selector]
  }));
  assert.deepEqual(result, {
    state: 'VERIFY_REQUIRED',
    evidence: [`verification-selector:${selector}`]
  });
});

test('微博登录状态：已有可用私信页优先于其他旧验证页面', async () => {
  const adapter = makeAdapter();
  const challenge = makeLoginStatePage('https://weibo.com/', { bodyText: '请完成安全验证' });
  const chat = makeLoginStatePage('https://api.weibo.com/chat/#/chat', { visibleSelectors: ['ul.contactslist'] });
  challenge.isClosed = chat.isClosed = () => false;
  adapter.context = { pages: () => [challenge, chat] };
  const existing = await adapter.findExistingLoginEvidence();
  assert.equal(existing.page, chat);
  assert.equal(existing.inspection.state, 'READY');
});

test('微博登录状态：新版空评论收件箱可确认已登录且评论功能可用', async () => {
  const adapter = makeAdapter();
  const page = makeLoginStatePage('https://weibo.com/comment/inbox', {
    bodyText: '消息 收到的评论 关注人的评论 发出的评论 暂无内容',
    visibleSelectors: ['.wbpro-tab2']
  });
  const login = await adapter.inspectLoginState(page);
  assert.deepEqual(login, {
    state: 'READY',
    evidence: [
      'authenticated-url:weibo-comment',
      'authenticated-selector:.wbpro-tab2',
      'authenticated-text:weibo-comment-tabs'
    ]
  });
  const capability = await adapter.inspectCapabilityOnCurrentPage(page, 'comment');
  assert.equal(capability.state, 'READY');
  assert.ok(capability.evidence.includes('.wbpro-tab2'));
});

test('微博功能检查：评论列表本身可作为受保护功能的登录证据', async () => {
  const adapter = makeAdapter();
  const page = makeLoginStatePage('https://weibo.com/comment/inbox', {
    visibleSelectors: ['.wbpro-scroller']
  });
  const result = await adapter.inspectCapabilityOnCurrentPage(page, 'comment');
  assert.equal(result.state, 'READY');
  assert.ok(result.evidence.includes('.wbpro-scroller'));
});

test('微博主动登录检查以私信受保护页面为主证据并复核采集回复能力', async () => {
  const adapter = makeAdapter();
  let currentUrl = 'about:blank';
  const page = makeLoginStatePage(currentUrl, { visibleSelectors: ['ul.contactslist'] });
  page.url = () => currentUrl;
  page.goto = async url => { currentUrl = url; };
  page.waitForTimeout = async () => {};
  adapter.ensureContext = async () => {};
  adapter.getLoginInspectionPage = async () => page;
  adapter.inspectFunctionalCapabilities = async () => ({
    publish: { state: 'REACHABLE', evidence: [], url: 'https://weibo.com/' },
    comment: { state: 'READY', evidence: ['.wbpro-scroller'], url: 'https://weibo.com/comment/inbox' },
    privateMessage: { state: 'READY', evidence: ['ul.contactslist'], url: 'https://api.weibo.com/chat/#/chat' }
  });
  const result = await adapter.checkLogin({ preserveInteractiveLogin: false });
  assert.equal(currentUrl, 'https://api.weibo.com/chat/#/chat');
  assert.equal(result.state, 'READY');
  assert.equal(result.loggedIn, true);
  assert.equal(result.operational, true);
  assert.match(result.message, /采集回复可用/);
});

test('微博评论行会同时提取评论ID和所属作品ID', async () => {
  const adapter = makeAdapter();
  const row = {
    evaluate: async () => ({
      index: 0,
      userName: 'Hipo00',
      content: '你们社区有什么活动啊？招聘志愿者吗',
      href: '/7215153159/RexVTygah?cid=5334681230770311',
      eventTime: '刚刚'
    })
  };
  const result = await adapter.readCommentRow(row, 0);
  assert.equal(result.commentId, '5334681230770311');
  assert.equal(result.postId, 'RexVTygah');
  assert.equal(result.externalUrl, 'https://weibo.com/7215153159/RexVTygah?cid=5334681230770311');
});

test('回复载荷硬门槛：历史评论、预览私信和无稳定 ID 均被阻断', () => {
  assert.equal(validateWeiboReplyPayload({ ...validCommentPayload(), messageContext: { ...validCommentPayload().messageContext, historical: true } }).reason, 'HISTORICAL_MESSAGE');
  assert.equal(validateWeiboReplyPayload({ ...validPrivatePayload(), messageContext: { ...validPrivatePayload().messageContext, previewOnly: true } }).reason, 'PRIVATE_PREVIEW_ONLY');
  assert.equal(validateWeiboReplyPayload({ ...validCommentPayload(), messageContext: { sourceVerified: true } }).reason, 'COMMENT_ID_MISSING');
  assert.equal(validateWeiboReplyPayload({ ...validPrivatePayload(), messageContext: { ...validPrivatePayload().messageContext, sourceType: 'OFFICIAL_OR_SYSTEM', officialSource: true } }).reason, 'PRIVATE_OFFICIAL_SOURCE');
  assert.equal(validateWeiboReplyPayload(validCommentPayload()).ok, true);
  assert.equal(validateWeiboReplyPayload(validPrivatePayload()).ok, true);
});

test('历史或预览目标在打开浏览器前即停止', async () => {
  const adapter = makeAdapter();
  let getPageCalls = 0;
  adapter.getPage = async () => { getPageCalls += 1; throw new Error('must not open browser'); };
  const result = await adapter.replyToMessage({ ...validPrivatePayload(), messageContext: { ...validPrivatePayload().messageContext, previewOnly: true } });
  assert.equal(result.status, 'NEEDS_CONFIRMATION');
  assert.equal(result.result.stage, 'reply_source_blocked');
  assert.equal(getPageCalls, 0);
});

test('Weibo declaration handles required trigger, delayed popup and woo-pop-main button', async () => {
  const adapter = makeAdapter();
  let triggerText = '\u8bf7\u8fdb\u884c\u5185\u5bb9\u58f0\u660e\uff08\u5fc5\u586b\uff09';
  let opened = false;
  let optionReads = 0;
  let optionClicks = 0;
  const trigger = {
    innerText: async () => triggerText,
    textContent: async () => triggerText,
    isVisible: async () => true,
    isEnabled: async () => true,
    click: async () => { opened = true; }
  };
  const option = {
    innerText: async () => '\u5185\u5bb9\u7531AI\u751f\u6210',
    textContent: async () => '\u5185\u5bb9\u7531AI\u751f\u6210',
    isVisible: async () => true,
    isEnabled: async () => true,
    click: async () => { optionClicks += 1; triggerText = '\u5185\u5bb9\u7531AI\u751f\u6210'; }
  };
  const empty = locatorCollection([]);
  const page = {
    locator: selector => {
      if (selector.includes('.wbpro-form .woo-pop-ctrl')) return locatorCollection([trigger]);
      if (selector.startsWith('.woo-pop-main button')) {
        return locatorCollection(() => {
          if (!opened) return [];
          optionReads += 1;
          return optionReads >= 2 ? [option] : [];
        });
      }
      return empty;
    },
    getByRole: () => empty,
    getByText: () => empty,
    waitForTimeout: async () => {}
  };

  const result = await adapter.applyWeiboContentDeclaration(page, { contentOrigin: 'AI_GENERATED' });
  assert.deepEqual(result, { applied: true, contentOrigin: 'AI_GENERATED', selectedLabel: '\u5185\u5bb9\u7531AI\u751f\u6210' });
  assert.equal(optionReads >= 2, true);
  assert.equal(optionClicks, 1);
});

test('\u5fae\u535a\u53d1\u5e03\u6309\u94ae\u8fde\u7eed\u4e94\u6b21\u552f\u4e00\u53ef\u7528\u540e\u624d\u8fd4\u56de\uff0c\u91c7\u6837\u671f\u95f4\u4e0d\u70b9\u51fb', async () => {
  const adapter = makeAdapter();
  const enabledSequence = [true, true, false, true, true, true, true, true];
  let enabledReads = 0;
  let operationChecks = 0;
  let waits = 0;
  let clicks = 0;
  const button = {
    isEnabled: async () => enabledSequence[Math.min(enabledReads++, enabledSequence.length - 1)],
    click: async () => { clicks += 1; }
  };
  adapter.findPublishButton = async () => button;
  adapter.assertWeiboOperationAllowed = async generation => {
    assert.equal(generation, 9);
    operationChecks += 1;
  };
  const page = { waitForTimeout: async ms => { assert.equal(ms, 1000); waits += 1; } };

  const result = await adapter.waitForStableWeiboPublishButton(page, {}, 9, 60_000);
  assert.equal(result.ready, true);
  assert.equal(result.publishButtonFound, true);
  assert.equal(result.publishButtonEnabled, true);
  assert.equal(result.stableReadySamples, 5);
  assert.equal(enabledReads, 8);
  assert.equal(operationChecks, 8);
  assert.equal(waits, 7);
  assert.equal(clicks, 0);
});

test('Weibo declaration clicks unique confirm button before accepting selection', async () => {
  const adapter = makeAdapter();
  const originalNow = Date.now;
  let now = 0;
  let triggerText = '\u8bf7\u8fdb\u884c\u5185\u5bb9\u58f0\u660e\uff08\u5fc5\u586b\uff09';
  let optionClicks = 0;
  let confirmClicks = 0;
  const trigger = visibleControl({ text: '', onClick: () => {} });
  trigger.innerText = async () => triggerText;
  trigger.textContent = async () => triggerText;
  const option = visibleControl({ text: '\u542bAI\u751f\u6210\u5185\u5bb9', onClick: () => { optionClicks += 1; } });
  const confirm = visibleControl({ text: '\u786e\u5b9a', onClick: () => { confirmClicks += 1; triggerText = '\u542bAI\u751f\u6210\u5185\u5bb9'; } });
  const empty = locatorCollection([]);
  const page = {
    locator: selector => selector.includes('.wbpro-form .woo-pop-ctrl') ? locatorCollection([trigger]) : empty,
    getByRole: (role, options) => {
      if (role !== 'button') return empty;
      if (options?.name === '\u542bAI\u751f\u6210\u5185\u5bb9') return locatorCollection([option]);
      if (options?.name === '\u786e\u5b9a') return locatorCollection([confirm]);
      return empty;
    },
    getByText: () => empty,
    waitForTimeout: async ms => { now += ms; }
  };

  Date.now = () => now;
  try {
    const result = await adapter.applyWeiboContentDeclaration(page, { contentOrigin: 'AI_GENERATED' });
    assert.deepEqual(result, { applied: true, contentOrigin: 'AI_GENERATED', selectedLabel: '\u542bAI\u751f\u6210\u5185\u5bb9' });
  } finally {
    Date.now = originalNow;
  }
  assert.equal(optionClicks, 1);
  assert.equal(confirmClicks, 1);
});

test('Weibo declaration rejects duplicate visible confirm buttons', async () => {
  const adapter = makeAdapter();
  const originalNow = Date.now;
  let now = 0;
  const trigger = visibleControl({ text: '\u8bf7\u8fdb\u884c\u5185\u5bb9\u58f0\u660e\uff08\u5fc5\u586b\uff09' });
  const option = visibleControl({ text: '\u542bAI\u751f\u6210\u5185\u5bb9' });
  const confirm1 = visibleControl({ text: '\u786e\u5b9a' });
  const confirm2 = visibleControl({ text: '\u786e\u5b9a' });
  const empty = locatorCollection([]);
  const page = {
    locator: selector => selector.includes('.wbpro-form .woo-pop-ctrl') ? locatorCollection([trigger]) : empty,
    getByRole: (role, options) => {
      if (role !== 'button') return empty;
      if (options?.name === '\u542bAI\u751f\u6210\u5185\u5bb9') return locatorCollection([option]);
      if (options?.name === '\u786e\u5b9a') return locatorCollection([confirm1, confirm2]);
      return empty;
    },
    getByText: () => empty,
    waitForTimeout: async ms => { now += ms; }
  };

  Date.now = () => now;
  try {
    await assert.rejects(
      () => adapter.applyWeiboContentDeclaration(page, { contentOrigin: 'AI_GENERATED' }),
      /Content declaration confirm button is ambiguous \(2\)/
    );
  } finally {
    Date.now = originalNow;
  }
});

test('Weibo declaration rejects confirm click when trigger stays unchanged', async () => {
  const adapter = makeAdapter();
  const originalNow = Date.now;
  let now = 0;
  let confirmClicks = 0;
  const trigger = visibleControl({ text: '\u8bf7\u8fdb\u884c\u5185\u5bb9\u58f0\u660e\uff08\u5fc5\u586b\uff09' });
  const option = visibleControl({ text: '\u542bAI\u751f\u6210\u5185\u5bb9' });
  const confirm = visibleControl({ text: '\u786e\u5b9a', onClick: () => { confirmClicks += 1; } });
  const empty = locatorCollection([]);
  const page = {
    locator: selector => selector.includes('.wbpro-form .woo-pop-ctrl') ? locatorCollection([trigger]) : empty,
    getByRole: (role, options) => {
      if (role !== 'button') return empty;
      if (options?.name === '\u542bAI\u751f\u6210\u5185\u5bb9') return locatorCollection([option]);
      if (options?.name === '\u786e\u5b9a') return locatorCollection([confirm]);
      return empty;
    },
    getByText: () => empty,
    waitForTimeout: async ms => { now += ms; }
  };

  Date.now = () => now;
  try {
    await assert.rejects(
      () => adapter.applyWeiboContentDeclaration(page, { contentOrigin: 'AI_GENERATED' }),
      /Content declaration selection was not confirmed/
    );
  } finally {
    Date.now = originalNow;
  }
  assert.equal(confirmClicks, 1);
});

test('Weibo verification collapses nested DOM matches for the same post URL', () => {
  const matches = dedupeWeiboPublishMatches([
    { index: 0, text: 'account just-now community activity registration guide body body body body body body', externalUrl: 'https://weibo.com/7215153159/RcjttdbdI', eventTime: 'just now' },
    { index: 1, text: 'community activity registration guide body body body body body body', externalUrl: null, eventTime: '' }
  ]);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].externalUrl, 'https://weibo.com/7215153159/RcjttdbdI');

  const realNestedMatches = dedupeWeiboPublishMatches([
    { text: 'Luka_99 \u521a\u521a \u6765\u81ea \u5fae\u535a\u89c6\u9891\u53f7 2 \u9605\u8bfb \u63a8\u5e7f 12121212 3333333333 Luka_99\u7684\u5fae\u535a\u89c6\u9891 00:28 \u8f6c\u53d1 \u8bc4\u8bba \u8d5e', externalUrl: 'https://weibo.com/7215153159/RdkHah6xI', eventTime: '\u521a\u521a' },
    { text: '12121212 3333333333 Luka_99\u7684\u5fae\u535a\u89c6\u9891 00:28', externalUrl: null, eventTime: '' }
  ]);
  assert.equal(realNestedMatches.length, 1);
  assert.equal(realNestedMatches[0].externalUrl, 'https://weibo.com/7215153159/RdkHah6xI');

  const distinct = dedupeWeiboPublishMatches([
    { text: 'community activity registration guide body body body body body body', externalUrl: 'https://weibo.com/7215153159/postA' },
    { text: 'community activity registration guide body body body body body body', externalUrl: 'https://weibo.com/7215153159/postB' }
  ]);
  assert.equal(distinct.length, 2);
});
test('Weibo declaration rejects duplicate visible exact-match buttons', async () => {
  const adapter = makeAdapter();
  let triggerClicks = 0;
  let optionClicks = 0;
  const trigger = visibleControl({ text: '\u5185\u5bb9\u58f0\u660e', onClick: () => { triggerClicks += 1; } });
  const option1 = visibleControl({ text: '\u5185\u5bb9\u7531AI\u751f\u6210', onClick: () => { optionClicks += 1; } });
  const option2 = visibleControl({ text: '\u5185\u5bb9\u7531AI\u751f\u6210', onClick: () => { optionClicks += 1; } });
  const empty = locatorCollection([]);
  const page = {
    locator: selector => selector.includes('.wbpro-form .woo-pop-ctrl') ? locatorCollection([trigger]) : empty,
    getByRole: (role, options) => role === 'button' && options?.name === '\u5185\u5bb9\u7531AI\u751f\u6210'
      ? locatorCollection([option1, option2])
      : empty,
    getByText: () => empty,
    waitForTimeout: async () => {}
  };

  await assert.rejects(
    () => adapter.applyWeiboContentDeclaration(page, { contentOrigin: 'AI_GENERATED' }),
    /Content declaration option is ambiguous \(2\)/
  );
  assert.equal(triggerClicks, 1);
  assert.equal(optionClicks, 0);
});

test('微博素材必须等待 spinner 消失且预览出现，等待期间持续检查平台开关', async () => {
  const adapter = makeAdapter();
  let spinnerReads = 0;
  let previewReads = 0;
  let operationChecks = 0;
  let waits = 0;
  const root = {
    locator: selector => ({
      evaluateAll: async () => {
        if (selector === '.woo-spinner-main') return ++spinnerReads === 1 ? 1 : 0;
        if (selector === '.woo-picture-img') return ++previewReads === 1 ? 0 : 1;
        return 0;
      }
    }),
    innerText: async () => ''
  };
  const editor = {
    locator: selector => {
      assert.match(selector, /ancestor::div/);
      return { count: async () => 1, first: () => root };
    }
  };
  adapter.assertWeiboOperationAllowed = async generation => {
    assert.equal(generation, 7);
    operationChecks += 1;
  };
  const page = { waitForTimeout: async ms => { assert.equal(ms, 500); waits += 1; } };

  const result = await adapter.waitForWeiboUploadReady(page, editor, 7);
  assert.deepEqual(result, { ready: true, spinnerCount: 0, previewCount: 1 });
  assert.equal(operationChecks, 2);
  assert.equal(waits, 1);
});

test('微博声明选项仍可见但触发器未更新时必须阻断发送', async () => {
  const adapter = makeAdapter();
  const originalNow = Date.now;
  let now = 0;
  let optionClicks = 0;
  const trigger = visibleControl({ text: '\u8bf7\u8fdb\u884c\u5185\u5bb9\u58f0\u660e\uff08\u5fc5\u586b\uff09' });
  const option = visibleControl({ text: '\u5185\u5bb9\u7531AI\u751f\u6210', onClick: () => { optionClicks += 1; } });
  const empty = locatorCollection([]);
  const page = {
    locator: selector => selector.includes('.wbpro-form .woo-pop-ctrl') ? locatorCollection([trigger]) : empty,
    getByRole: (role, options) => role === 'button' && options?.name === '\u5185\u5bb9\u7531AI\u751f\u6210' ? locatorCollection([option]) : empty,
    getByText: () => empty,
    waitForTimeout: async ms => { now += ms; }
  };

  Date.now = () => now;
  try {
    await assert.rejects(
      () => adapter.applyWeiboContentDeclaration(page, { contentOrigin: 'AI_GENERATED' }),
      /Content declaration selection was not confirmed/
    );
  } finally {
    Date.now = originalNow;
  }
  assert.equal(optionClicks, 1);
});

test('微博复核只使用顶部当前账号主页，不使用信息流头像', async () => {
  const adapter = makeAdapter();
  const anchor = (href, y) => ({
    isVisible: async () => true,
    boundingBox: async () => ({ x: 0, y, width: 40, height: 40 }),
    getAttribute: async name => name === 'href' ? href : null
  });
  const own = anchor('/u/7215153159', 20);
  const feed = anchor('/u/9999999999', 300);
  const page = {
    goto: async () => {},
    waitForTimeout: async () => {},
    locator: () => locatorCollection([own, feed])
  };

  assert.equal(await adapter.resolveManageUrl(page), 'https://weibo.com/u/7215153159');
  const ambiguousPage = { ...page, locator: () => locatorCollection([own, anchor('/u/8888888888', 50)]) };
  assert.equal(await adapter.resolveManageUrl(ambiguousPage), null);
});

test('微博发布网络回执只识别发布接口，并区分明确成功、明确失败和不确定', () => {
  const success = classifyWeiboPublishNetworkEvidence({
    url: 'https://weibo.com/ajax/statuses/update',
    status: 200,
    body: { ok: 1, data: { idstr: '5171234567890123', url: 'https://weibo.com/1234567890/AbCdEf' } }
  });
  assert.equal(success.kind, 'SUCCESS');
  assert.equal(success.confirmed, true);
  assert.equal(success.platformPostId, '5171234567890123');

  const failure = classifyWeiboPublishNetworkEvidence({
    url: 'https://weibo.com/ajax/statuses/update',
    status: 403,
    body: { ok: 0, error_code: 20018, message: '发布失败' }
  });
  assert.equal(failure.kind, 'FAILURE');
  assert.equal(failure.confirmed, true);

  const ignored = classifyWeiboPublishNetworkEvidence({
    url: 'https://weibo.com/ajax/profile/info',
    status: 200,
    body: { ok: 1, data: { idstr: 'should-not-count' } }
  });
  assert.equal(ignored.kind, 'IGNORED');

  const uncertain = classifyWeiboPublishNetworkEvidence({
    url: 'https://weibo.com/ajax/statuses/update',
    status: 200,
    body: { data: {} }
  });
  assert.equal(uncertain.kind, 'UNCONFIRMED');
  assert.equal(uncertain.confirmed, false);
});

test('发布回执只接受编辑器清空且出现本次新增精确信号', () => {
  assert.equal(assessWeiboPublishReceipt({ baselineSuccessSignalCount: 1, successSignalCount: 1, editorCleared: true }).confirmed, false);
  assert.equal(assessWeiboPublishReceipt({ editorCleared: true }).confirmed, false);
  assert.equal(assessWeiboPublishReceipt({ baselineEchoCount: 0, scopedEchoCount: 1, editorCleared: true }).confirmed, true);
  assert.equal(assessWeiboPublishReceipt({ baselineSuccessSignalCount: 0, successSignalCount: 1, editorCleared: true }).confirmed, true);
});

test('发布点击后回执不确定时返回 NEEDS_CONFIRMATION 且不重试', async () => {
  const adapter = makeAdapter();
  const materialPath = path.join(adapter.logsDir, 'material.mp4');
  fs.writeFileSync(materialPath, 'fixture');
  const editor = makeEditor();
  const fileInput = { setInputFiles: async value => assert.equal(value, materialPath) };
  const empty = { count: async () => 0 };
  const page = {
    goto: async () => {}, waitForTimeout: async () => {}, url: () => 'https://weibo.com/', screenshot: async () => {},
    locator: selector => selector.startsWith('textarea')
      ? { count: async () => 1, nth: () => editor }
      : selector.startsWith('input[type="file"]')
        ? { count: async () => 1, first: () => fileInput }
        : empty
  };
  let clicks = 0;
  const button = { isEnabled: async () => true, click: async () => { clicks += 1; } };
  adapter.getPage = async () => page;
  adapter.waitForReady = async () => true;
  adapter.waitForWeiboUploadReady = async () => ({ ready: true, spinnerCount: 0, previewCount: 1 });
  adapter.applyWeiboContentDeclaration = async () => ({ applied: true });
  adapter.findPublishButton = async () => button;
  adapter.countFeedEchoes = async () => 0;
  adapter.countPublishSuccessSignals = async () => 0;
  adapter.waitForPublishReceipt = async () => { throw new Error('receipt timeout'); };
  adapter.assertWeiboOperationAllowed = async () => true;
  const result = await adapter.publish({ materialPath, title: '标题', body: '正文', contentOrigin: 'AI_GENERATED', publishMode: 'AUTO' });
  assert.equal(clicks, 1);
  assert.equal(result.status, 'NEEDS_CONFIRMATION');
  assert.equal(result.result.stage, 'publish_unconfirmed');
  assert.equal(result.result.sendAttempted, true);
});

test('评论回复精确使用局部回复按钮并以发出的评论四项唯一匹配确认', async () => {
  const adapter = makeAdapter();
  let sent = false;
  let buttonClicks = 0;
  const editor = makeEditor();
  const button = { isVisible: async () => true, isEnabled: async () => true, click: async () => { buttonClicks += 1; sent = true; editor.clear(); } };
  const composerScope = { getByRole: () => ({ count: async () => 1, nth: () => button }) };
  const page = { waitForTimeout: async () => {}, locator: () => ({}), url: () => 'https://weibo.com/comment/inbox' };
  adapter.getPage = async () => page;
  adapter.openCommentInbox = async () => ({ ok: true });
  adapter.locateCommentTarget = async () => ({ ok: true, locator: {}, candidate: { userName: 'alice' }, uniqueTargetMatch: true, targetIdentityVerified: true });
  adapter.openCommentReplyComposer = async () => ({ ok: true, editor, scope: composerScope });
  adapter.countScopedEchoes = async () => 0;
  adapter.inspectSentCommentReply = async () => ({ handled: sent, matchCount: sent ? 1 : 0, detectionSource: 'SENT_COMMENT_INBOX' });
  adapter.inspectCommentDetailReply = async () => ({ handled: false, authoredReplyCount: 0 });
  adapter.assertWeiboOperationAllowed = async () => true;
  const result = await adapter.replyToMessage(validCommentPayload());
  assert.equal(buttonClicks, 1);
  assert.equal(result.status, 'SUCCESS');
  assert.equal(result.result.stage, 'reply_sent');
  assert.equal(result.result.sendMethod, 'weibo-comment:scoped-reply-button');
});

test('私信回复精确使用聊天编辑器 Enter 并以新增 outgoing 回显确认', async () => {
  const adapter = makeAdapter();
  let sent = false;
  const editor = makeEditor(() => { sent = true; });
  const page = { waitForTimeout: async () => {}, locator: selector => ({ selector }), url: () => 'https://api.weibo.com/chat/#/chat' };
  adapter.getPage = async () => page;
  adapter.openPrivateConversation = async () => ({ ok: true, uniqueTargetMatch: true, targetIdentityVerified: true });
  adapter.findPrivateEditor = async () => editor;
  adapter.countScopedEchoes = async (_scope, _text, outgoingOnly) => { assert.equal(outgoingOnly, true); return sent ? 1 : 0; };
  adapter.assertWeiboOperationAllowed = async () => true;
  const result = await adapter.replyToMessage(validPrivatePayload());
  assert.equal(sent, true);
  assert.equal(result.status, 'SUCCESS');
  assert.equal(result.result.stage, 'reply_sent');
  assert.equal(result.result.sendMethod, 'weibo-chat:enter-key');
});

test('平台停止发生在最终发送前时异常向上抛出且不点击评论发送', async () => {
  const adapter = makeAdapter();
  const editor = makeEditor();
  let buttonClicks = 0;
  const button = { isVisible: async () => true, isEnabled: async () => true, click: async () => { buttonClicks += 1; } };
  const composerScope = { getByRole: () => ({ count: async () => 1, nth: () => button }) };
  const page = { waitForTimeout: async () => {}, locator: () => ({}), url: () => 'https://weibo.com/comment/inbox' };
  adapter.getPage = async () => page;
  adapter.openCommentInbox = async () => ({ ok: true });
  adapter.locateCommentTarget = async () => ({ ok: true, locator: {}, candidate: { userName: 'alice' }, uniqueTargetMatch: true, targetIdentityVerified: true });
  adapter.openCommentReplyComposer = async () => ({ ok: true, editor, scope: composerScope });
  adapter.countScopedEchoes = async () => 0;
  adapter.assertWeiboOperationAllowed = async () => { const error = new Error('stopped'); error.code = 'PLATFORM_OPERATION_CANCELLED'; throw error; };
  await assert.rejects(() => adapter.replyToMessage(validCommentPayload()), error => error.code === 'PLATFORM_OPERATION_CANCELLED');
  assert.equal(buttonClicks, 0);
});

test('评论采集只保留稳定 commentId 并去重', async () => {
  const adapter = makeAdapter();
  const rows = { count: async () => 3, nth: index => ({ index }) };
  const page = { locator: () => rows, url: () => 'https://weibo.com/comment/inbox' };
  adapter.openCommentInbox = async () => ({ ok: true });
  adapter.assertWeiboOperationAllowed = async () => true;
  adapter.readCommentRow = async (_row, index) => [
    { userName: 'u', content: 'c', commentId: '5013415519847148', externalUrl: 'https://weibo.com/comment/inbox?cid=5013415519847148', eventTime: '刚刚' },
    { userName: 'u', content: 'c', commentId: '5013415519847148', externalUrl: 'https://weibo.com/comment/inbox?cid=5013415519847148', eventTime: '刚刚' },
    { userName: 'x', content: 'no-id', commentId: null, externalUrl: null, eventTime: '刚刚' }
  ][index];
  const result = await adapter.collectComments(page);
  assert.equal(result.messages.length, 1);
  assert.equal(result.messages[0].context.commentId, '5013415519847148');
  assert.equal(result.messages[0].context.sourceVerified, true);

  const second = await adapter.collectComments(page, { maxRounds: 1, watermark: result.watermark });
  assert.equal(second.messages.length, 0);
  assert.deepEqual(second.watermark.recentCommentIds, result.watermark.recentCommentIds);
});

test('私信采集在点击前排除高置信官方会话，只采集普通用户', async () => {
  const adapter = makeAdapter();
  let openedTitle = '';
  const clickCounts = [0, 0, 0];
  const rowItems = [0, 1, 2].map(index => ({ index, dispose: async () => {}, click: async () => {
    clickCounts[index] += 1;
    openedTitle = index === 2 ? 'bob' : index === 1 ? '热搜简报' : '系统通知';
  } }));
  const rows = { count: async () => rowItems.length, nth: index => rowItems[index], elementHandles: async () => rowItems };
  const page = {
    goto: async () => {},
    waitForTimeout: async () => {},
    url: () => 'https://api.weibo.com/chat/#/chat',
    locator: selector => selector === 'li.sessionlist'
      ? rows
      : { first: () => ({ innerText: async () => openedTitle }) }
  };
  adapter.inspectLoginState = async () => ({ state: 'READY' });
  adapter.assertWeiboOperationAllowed = async () => true;
  adapter.readConversationRow = async (_row, index) => index === 0
    ? { userName: '系统通知', preview: '您发布的视频已成功发出', unreadCount: 1, eventTime: '刚刚', conversationKey: 'official-1' }
    : index === 1
      ? { userName: '热搜简报', preview: '发来了一条链接消息 >>', unreadCount: 0, eventTime: '07:41', conversationKey: 'official-2' }
      : { userName: 'bob', preview: '你好', unreadCount: 1, eventTime: '刚刚', conversationKey: 'user-1' };
  adapter.extractOpenIncomingMessages = async (_page, conversation) => [{ content: conversation.preview, eventTime: '刚刚', messageId: '4479825538150513', direction: 'incoming', sourceVerified: true }];

  const result = await adapter.collectPrivateMessages(page);
  assert.deepEqual(clickCounts, [0, 0, 1]);
  assert.equal(result.messages.length, 1);
  assert.equal(result.messages[0].userName, 'bob');
  assert.equal(result.messages[0].context.officialSource, false);
  assert.equal(result.summary.ignoredCount, 2);
  assert.deepEqual(result.summary.ignoredConversations.map(item => item.userName), ['系统通知', '热搜简报']);
});

test('私信采集只接受已打开会话中的稳定 incoming 气泡；无气泡降级为预览待确认', async () => {
  const makePage = () => {
    const row = { click: async () => {}, dispose: async () => {} };
    const rows = { count: async () => 1, nth: () => row, elementHandles: async () => [row] };
    return {
      goto: async () => {}, waitForTimeout: async () => {}, url: () => 'https://api.weibo.com/chat/#/chat',
      locator: selector => selector === 'li.sessionlist'
        ? rows
        : { first: () => ({ innerText: async () => 'bob' }) }
    };
  };
  const conversation = { userName: 'bob', preview: '你好', unreadCount: 1, eventTime: '刚刚', conversationKey: 'conversation-1' };

  const verifiedAdapter = makeAdapter();
  verifiedAdapter.inspectLoginState = async () => ({ state: 'READY' });
  verifiedAdapter.readConversationRow = async () => conversation;
  verifiedAdapter.extractOpenIncomingMessages = async () => [{ content: '你好', eventTime: '刚刚', messageId: '4479825538150513', direction: 'incoming', sourceVerified: true }];
  verifiedAdapter.assertWeiboOperationAllowed = async () => true;
  const verified = await verifiedAdapter.collectPrivateMessages(makePage());
  assert.equal(verified.summary.status, 'SUCCESS');
  assert.equal(verified.messages[0].context.previewOnly, false);
  assert.equal(verified.messages[0].context.sourceVerified, true);
  assert.equal(verified.messages[0].context.messageId, '4479825538150513');

  const previewAdapter = makeAdapter();
  previewAdapter.inspectLoginState = async () => ({ state: 'READY' });
  previewAdapter.readConversationRow = async () => conversation;
  previewAdapter.extractOpenIncomingMessages = async () => [];
  previewAdapter.assertWeiboOperationAllowed = async () => true;
  const preview = await previewAdapter.collectPrivateMessages(makePage());
  assert.equal(preview.summary.status, 'NEEDS_CONFIRMATION');
  assert.equal(preview.messages[0].context.previewOnly, true);
  assert.equal(preview.messages[0].context.sourceVerified, false);
});


test('Weibo collects new comments on older posts after inbox scrolling', async () => {
  const adapter = makeAdapter();
  let round = 0;
  const page = {
    locator: () => locatorCollection(round === 0 ? [{ id: 'new' }] : [{ id: 'new' }, { id: 'old' }]),
    waitForTimeout: async () => {},
    url: () => 'https://weibo.com/comment/inbox'
  };
  adapter.openCommentInbox = async () => ({ ok: true });
  adapter.assertWeiboOperationAllowed = async () => true;
  adapter.advanceHistoricalCommentList = async () => { round += 1; return { attempted: true, moved: true, reason: 'SCROLLED_CONTAINER' }; };
  adapter.readCommentRow = async row => row.id === 'old'
    ? { userName: 'old-user', content: 'new comment on old post', commentId: '5013415519847999', externalUrl: 'https://weibo.com/comment/inbox?cid=5013415519847999', eventTime: '\u521a\u521a' }
    : { userName: 'new-user', content: 'new comment', commentId: '5013415519847001', externalUrl: 'https://weibo.com/comment/inbox?cid=5013415519847001', eventTime: '\u521a\u521a' };
  const result = await adapter.collectComments(page, { maxRounds: 2 });
  assert.equal(result.messages.length, 2);
  assert.deepEqual(result.messages.map(item => item.context.commentId), ['5013415519847001', '5013415519847999']);
  assert.equal(result.summary.scanRounds, 2);
});

test('Weibo locates an older exact commentId on the second scan', async () => {
  const adapter = makeAdapter();
  let round = 0;
  const oldRow = { id: 'old' };
  const page = {
    locator: () => locatorCollection(round === 0 ? [{ id: 'new' }] : [oldRow]),
    waitForTimeout: async () => {}
  };
  adapter.assertWeiboOperationAllowed = async () => true;
  adapter.advanceHistoricalCommentList = async () => { round += 1; return { attempted: true, moved: true, reason: 'SCROLLED_CONTAINER' }; };
  adapter.readCommentRow = async row => row.id === 'old'
    ? { userName: 'alice', content: '\u539f\u8bc4\u8bba', commentId: '5013415519847148', eventTime: '\u521a\u521a' }
    : { userName: 'alice', content: '\u539f\u8bc4\u8bba', commentId: '5013415519847000', eventTime: '\u521a\u521a' };
  const result = await adapter.locateCommentTarget(page, validCommentPayload(), { maxRounds: 2 });
  assert.equal(result.ok, true);
  assert.equal(result.locator, oldRow);
  assert.equal(result.scanRounds, 2);
  assert.equal(result.identity.matched, true);
  assert.equal(result.identity.reason, 'WEIBO_COMMENT_IDENTITY_EXACT');
});


test('微博 HUMAN_ORIGINAL 精确声明包含“我的内容无需声明”且不接受转载声明', () => {
  const labels = weiboContentDeclarationLabels('HUMAN_ORIGINAL');
  assert.equal(labels.includes('我的内容无需声明'), true);
  assert.equal(labels.includes('内容为转载'), false);
  assert.equal(labels.includes('含AI生成内容'), false);
});

test('微博当前声明弹窗精确选择“我的内容无需声明”并只确认一次', async () => {
  const adapter = makeAdapter();
  let triggerText = '内容声明';
  let optionOpen = false;
  let optionChosen = false;
  let optionClicks = 0;
  let confirmClicks = 0;

  const trigger = visibleControl({
    get text() { return triggerText; },
    onClick: () => { optionOpen = true; }
  });
  // visibleControl captures a static value, so expose the changing trigger text explicitly.
  trigger.innerText = async () => triggerText;
  trigger.textContent = async () => triggerText;
  const option = visibleControl({ text: '我的内容无需声明', onClick: () => {
    optionClicks += 1;
    optionChosen = true;
  } });
  const confirm = visibleControl({ text: '确定', onClick: () => {
    confirmClicks += 1;
    triggerText = '我的内容无需声明';
    optionOpen = false;
  } });
  const empty = locatorCollection([]);
  const page = {
    locator(selector) {
      if (selector === '.wbpro-form .woo-pop-ctrl, .woo-pop-wrap[class*="statement"] .woo-pop-ctrl, .woo-pop-ctrl') return locatorCollection([trigger]);
      return empty;
    },
    getByRole(role, options = {}) {
      if (role !== 'button') return empty;
      if (options.name === '我的内容无需声明') return locatorCollection(optionOpen ? [option] : []);
      if (options.name === '确定') return locatorCollection(optionChosen ? [confirm] : []);
      return empty;
    },
    async waitForTimeout(ms) {
      // Preserve the production clock-based branch while keeping the regression test bounded.
      await new Promise(resolve => setTimeout(resolve, Math.min(Number(ms) || 0, 110)));
    }
  };

  const result = await adapter.applyWeiboContentDeclaration(page, { contentOrigin: 'HUMAN_ORIGINAL' });
  assert.equal(result.applied, true);
  assert.equal(result.selectedLabel, '我的内容无需声明');
  assert.equal(optionClicks, 1);
  assert.equal(confirmClicks, 1);
  assert.equal(triggerText, '我的内容无需声明');
});


test('微博发出的评论只有帖子、用户名、原评论和回复正文四项在同一记录内唯一吻合才确认', () => {
  const base = {
    expectedUserName: 'SKTT1KFAKER',
    expectedSourceContent: '你们最近有什么活动啊',
    expectedReply: '你好~，近期活动请查看账号置顶内容或最新发布的活动通知；如果没有找到，也可以私信发送“活动咨询”由工作人员协助查询。',
    expectedPostId: 'RexVTygah',
    candidates: [{
      rowText: 'Luka_99 4分钟前 回复 @SKTT1KFAKER: 你好~，近期活动请查看账号置顶内容或最新发布的活动通知；如果没有找到，也可以私信发送“活动咨询”由工作人员协助查询。 @SKTT1KFAKER: 你们最近有什么活动啊 OPC一人社区',
      postIds: ['RexVTygah']
    }]
  };
  const confirmed = assessWeiboSentCommentReplyEvidence(base);
  assert.equal(confirmed.handled, true);
  assert.equal(confirmed.reason, 'SENT_COMMENT_TARGET_REPLY_EXACT');
  assert.equal(assessWeiboSentCommentReplyEvidence({ ...base, expectedUserName: 'Hipo00' }).handled, false);
  assert.equal(assessWeiboSentCommentReplyEvidence({ ...base, expectedSourceContent: '别的问题' }).handled, false);
  assert.equal(assessWeiboSentCommentReplyEvidence({ ...base, expectedReply: '别的回复' }).handled, false);
  assert.equal(assessWeiboSentCommentReplyEvidence({ ...base, expectedPostId: 'OtherPost' }).handled, false);
  assert.equal(assessWeiboSentCommentReplyEvidence({ ...base, candidates: [...base.candidates, ...base.candidates] }).reason, 'SENT_COMMENT_TARGET_AMBIGUOUS');
});

test('微博评论详情页只在评论锚点、作品、原评论和主号回复全部吻合时确认已回复', () => {
  const base = {
    requestedUrl: 'https://weibo.com/7215153159/RexVTygah?cid=5334681230770311',
    finalUrl: 'https://weibo.com/7215153159/RexVTygah?cid=5334681230770311',
    expectedCommentId: '5334681230770311',
    expectedPostId: 'RexVTygah',
    ownerUid: '7215153159',
    sourceMatchCount: 1,
    authoredReplyCount: 1
  };
  const confirmed = assessWeiboCommentDetailReplyEvidence(base);
  assert.equal(confirmed.handled, true);
  assert.equal(confirmed.reason, 'COMMENT_DETAIL_AUTHORED_REPLY_EXACT');
  assert.equal(assessWeiboCommentDetailReplyEvidence({ ...base, finalUrl: 'https://weibo.com/7215153159/RexVTygah?cid=5334681230770999' }).reason, 'COMMENT_DETAIL_ANCHOR_MISMATCH');
  assert.equal(assessWeiboCommentDetailReplyEvidence({ ...base, expectedPostId: 'OtherPost' }).reason, 'COMMENT_DETAIL_POST_MISMATCH');
  assert.equal(assessWeiboCommentDetailReplyEvidence({ ...base, ownerUid: null }).reason, 'COMMENT_DETAIL_OWNER_MISSING');
  assert.equal(assessWeiboCommentDetailReplyEvidence({ ...base, sourceMatchCount: 0 }).reason, 'COMMENT_DETAIL_SOURCE_NOT_VISIBLE');
  assert.equal(assessWeiboCommentDetailReplyEvidence({ ...base, authoredReplyCount: 0 }).reason, 'COMMENT_DETAIL_REPLY_NOT_VISIBLE');
});

test('微博评论只读核验优先检查发出的评论，未命中时才进入帖子详情页', async () => {
  const adapter = makeAdapter();
  const scope = {};
  const page = { locator: () => scope };
  adapter.getPage = async () => page;
  adapter.openCommentInbox = async () => ({ ok: true });
  adapter.locateCommentTarget = async () => ({ ok: true, locator: scope });
  adapter.inspectSentCommentReply = async () => ({ handled: false, matchCount: 0, detectionSource: 'SENT_COMMENT_INBOX', readOnly: true });
  adapter.inspectCommentDetailReply = async () => ({ handled: true, authoredReplyCount: 1, detectionSource: 'COMMENT_DETAIL_THREAD', readOnly: true });
  const result = await adapter.detectManualReply({ ...validCommentPayload(), expectedReply: '知识库生成回复' });
  assert.equal(result.status, 'SUCCESS');
  assert.equal(result.result.handled, true);
  assert.equal(result.result.scopedEchoCount, 1);
  assert.equal(result.result.detectionSource, 'COMMENT_DETAIL_THREAD');
  assert.equal(result.result.sentReceipt.detectionSource, 'SENT_COMMENT_INBOX');
  assert.equal(result.result.detail.readOnly, true);
});

test('微博评论只读核验在发出的评论四项唯一命中后不再依赖收到的评论回显', async () => {
  const adapter = makeAdapter();
  const page = { locator: () => ({}) };
  adapter.getPage = async () => page;
  adapter.openCommentInbox = async () => ({ ok: true });
  adapter.locateCommentTarget = async () => ({ ok: true });
  adapter.inspectSentCommentReply = async () => ({ handled: true, matchCount: 1, detectionSource: 'SENT_COMMENT_INBOX', readOnly: true });
  adapter.inspectCommentDetailReply = async () => { throw new Error('详情页不应再执行'); };
  const result = await adapter.detectManualReply({ ...validCommentPayload(), expectedReply: '知识库生成回复' });
  assert.equal(result.status, 'SUCCESS');
  assert.equal(result.result.handled, true);
  assert.equal(result.result.detectionSource, 'SENT_COMMENT_INBOX');
  assert.equal(result.result.scopedEchoCount, 1);
});
