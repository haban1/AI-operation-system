import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { XiaohongshuAssistedRpaAdapter } from '../agent/rpa-adapters/xiaohongshu-assisted.js';
import { hasReliablePublishEvidence } from '../src/services/publish-attestation.js';

function fixture({ stubEvidence = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaohongshu-flow-'));
  const materialPath = path.join(dir, 'material.jpg');
  fs.writeFileSync(materialPath, 'xhs-material');
  const adapter = new XiaohongshuAssistedRpaAdapter({
    profileDir: path.join(dir, 'profile'),
    logsDir: path.join(dir, 'logs'),
    executablePath: 'chrome-not-used',
    creatorUrl: 'https://creator.xiaohongshu.com/publish/publish',
    loginTimeoutMs: 1,
    sendTimeoutMs: 3
  });
  if (stubEvidence) adapter.evidence = async (_payload, message, _page, stage, extra = {}) => ({ message, stage, ...extra });
  return { dir, materialPath, adapter, close: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function publishPage(url = 'https://creator.xiaohongshu.com/publish/publish') {
  let currentUrl = url;
  return {
    async goto(next) { currentUrl = next; },
    url() { return currentUrl; },
    async waitForTimeout() {},
    async screenshot({ path: target }) { fs.writeFileSync(target, 'png'); },
    keyboard: { async press() {} }
  };
}

function autoPublishPayload(materialPath, extra = {}) {
  return {
    platformCode: 'xiaohongshu',
    taskId: 11,
    targetId: 22,
    materialPath,
    publishMode: 'AUTO',
    managementConfirmed: true,
    draftFingerprint: { fingerprintHash: 'fingerprint-123' },
    ...extra
  };
}

function one(locator) {
  return {
    async count() { return 1; },
    first() { return locator; },
    nth() { return locator; },
    filter() { return this; }
  };
}

function emptyCollection() {
  return { async count() { return 0; }, first() { return { async isVisible() { return false; } }; }, nth() { return this.first(); }, filter() { return this; } };
}


function publishInspection({ marker = 'candidate-1', text = '\u53d1\u5e03', tag = 'div', x = 100, y = 200, source = 'exact-label' } = {}) {
  return {
    visible: true,
    enabled: true,
    primaryCount: 1,
    reason: null,
    selected: {
      markerAttribute: 'data-codex-xhs-publish-candidate',
      marker,
      source,
      frameIndex: 0,
      frameUrl: 'https://creator.xiaohongshu.com/publish/publish',
      tag,
      role: 'button',
      text,
      className: 'publish-control',
      enabled: true,
      rect: { x, y, width: 120, height: 40 }
    }
  };
}

function publishClickPage({ targetCount = 1, dialogs = emptyCollection(), onClick = () => {} } = {}) {
  const locator = {
    async isVisible() { return true; },
    async isEnabled() { return true; },
    async evaluate() { return true; },
    async scrollIntoViewIfNeeded() {},
    async click() { onClick(); }
  };
  const frame = {
    locator() {
      return {
        async count() { return targetCount; },
        first() { return locator; }
      };
    }
  };
  const page = publishPage();
  page.frames = () => [frame];
  page.getByRole = role => role === 'dialog' ? dialogs : emptyCollection();
  return page;
}

test('小红书适配器暴露最终提交授权器', () => {
  const f = fixture();
  try {
    assert.equal(typeof f.adapter.setSubmitAuthorizer, 'function');
    const authorizer = async () => ({ authorized: true, submitLock: 'LOCKED' });
    f.adapter.setSubmitAuthorizer(authorizer);
    assert.equal(f.adapter.submitAuthorizer, authorizer);
  } finally { f.close(); }
});

test('AUTO 发布没有提交授权器时禁止最终点击', async () => {
  const f = fixture();
  try {
    let clicks = 0;
    f.adapter.getPage = async () => publishPage();
    f.adapter.waitForReady = async () => true;
    f.adapter.prepareDraft = async () => ({ prepared: true });
    f.adapter.capturePublishBaseline = async () => ({ url: 'before', successTextCount: 0 });
    f.adapter.clickFinalPublish = async () => { clicks += 1; return { clicked: true }; };
    const output = await f.adapter.publish(autoPublishPayload(f.materialPath));
    assert.equal(output.status, 'NEEDS_CONFIRMATION');
    assert.equal(output.result.stage, 'submit_authorization_blocked');
    assert.equal(output.result.submitAttempted, false);
    assert.equal(clicks, 0);
  } finally { f.close(); }
});

test('缺少草稿指纹时不获取提交锁也不点击', async () => {
  const f = fixture();
  try {
    let locks = 0;
    let clicks = 0;
    f.adapter.getPage = async () => publishPage();
    f.adapter.waitForReady = async () => true;
    f.adapter.prepareDraft = async () => ({ prepared: true });
    f.adapter.setSubmitAuthorizer(async () => { locks += 1; return { authorized: true, submitLock: 'LOCKED' }; });
    f.adapter.clickFinalPublish = async () => { clicks += 1; return { clicked: true }; };
    const output = await f.adapter.publish(autoPublishPayload(f.materialPath, { draftFingerprint: null }));
    assert.equal(output.status, 'NEEDS_CONFIRMATION');
    assert.equal(output.result.stage, 'draft_fingerprint_missing');
    assert.equal(output.result.submitAttempted, false);
    assert.deepEqual({ locks, clicks }, { locks: 0, clicks: 0 });
  } finally { f.close(); }
});

test('最终发布只获取一次锁，且锁在点击前获得', async () => {
  const f = fixture();
  try {
    const order = [];
    f.adapter.getPage = async () => publishPage();
    f.adapter.waitForReady = async () => true;
    f.adapter.prepareDraft = async () => ({ prepared: true });
    f.adapter.capturePublishBaseline = async () => ({ url: 'before', successTextCount: 0 });
    f.adapter.setSubmitAuthorizer(async () => { order.push('lock'); return { authorized: true, submitLock: 'LOCKED', token: 'once' }; });
    f.adapter.clickFinalPublish = async () => { order.push('click'); return { clicked: true, confirmation: 'NOT_PRESENT' }; };
    f.adapter.waitForPublishSuccess = async () => ({ confirmed: true, source: 'new-success-url' });
    const output = await f.adapter.publish(autoPublishPayload(f.materialPath));
    assert.equal(output.status, 'SUCCESS');
    assert.equal(output.result.submitAttempted, true);
    assert.deepEqual(order, ['lock', 'click']);
  } finally { f.close(); }
});

test('获取锁前平台停止：不点击并标记 writeAttempted=false', async () => {
  const f = fixture();
  try {
    let locks = 0;
    let clicks = 0;
    f.adapter.getPage = async () => publishPage();
    f.adapter.waitForReady = async () => true;
    f.adapter.prepareDraft = async () => ({ prepared: true });
    f.adapter.setSubmitAuthorizer(async () => { locks += 1; return { authorized: true, submitLock: 'LOCKED' }; });
    f.adapter.clickFinalPublish = async () => { clicks += 1; return { clicked: true }; };
    f.adapter.setRuntimeGuard(async () => { const error = new Error('platform stopped'); error.code = 'PLATFORM_OPERATION_CANCELLED'; throw error; });
    await assert.rejects(() => f.adapter.publish(autoPublishPayload(f.materialPath)), error => {
      assert.equal(error.code, 'PLATFORM_OPERATION_CANCELLED');
      assert.equal(error.writeAttempted, false);
      return true;
    });
    assert.deepEqual({ locks, clicks }, { locks: 0, clicks: 0 });
  } finally { f.close(); }
});

test('获取锁后平台停止：进入 NEEDS_CONFIRMATION 且禁止重试', async () => {
  const f = fixture();
  try {
    let guardCalls = 0;
    let clicks = 0;
    f.adapter.getPage = async () => publishPage();
    f.adapter.waitForReady = async () => true;
    f.adapter.prepareDraft = async () => ({ prepared: true });
    f.adapter.capturePublishBaseline = async () => ({ url: 'before', successTextCount: 0 });
    f.adapter.setSubmitAuthorizer(async () => ({ authorized: true, submitLock: 'LOCKED' }));
    f.adapter.clickFinalPublish = async () => { clicks += 1; return { clicked: true }; };
    f.adapter.setRuntimeGuard(async () => {
      guardCalls += 1;
      if (guardCalls === 2) { const error = new Error('stopped after lock'); error.code = 'PLATFORM_OPERATION_CANCELLED'; throw error; }
    });
    const output = await f.adapter.publish(autoPublishPayload(f.materialPath));
    assert.equal(output.status, 'NEEDS_CONFIRMATION');
    assert.equal(output.result.stage, 'publish_interrupted_after_lock');
    assert.equal(output.result.submitAttempted, true);
    assert.equal(output.result.submissionStatus, 'UNKNOWN');
    assert.equal(clicks, 0);
  } finally { f.close(); }
});

test('\u5c0f\u7ea2\u4e66\u53d1\u5e03\u5c31\u7eea\u8fde\u7eed\u4e94\u6b21\u53ea\u8bfb\u91c7\u6837\uff0c\u7b49\u5f85\u8fc7\u7a0b\u4e2d\u4e0d\u70b9\u51fb', async () => {
  const f = fixture();
  try {
    const readinessSequence = [true, true, false, true, true, true, true, true];
    let inspections = 0;
    let waits = 0;
    let clicks = 0;
    f.adapter.inspectPublishControl = async () => {
      const enabled = readinessSequence[Math.min(inspections, readinessSequence.length - 1)];
      inspections += 1;
      return { visible: true, enabled, primaryCount: 1 };
    };
    const page = {
      locator: () => ({ innerText: async () => '' }),
      waitForTimeout: async ms => { assert.equal(ms, 1000); waits += 1; },
      click: async () => { clicks += 1; }
    };

    const result = await f.adapter.waitForUploadAndPublishReady(page, 60_000);
    assert.equal(result.ready, true);
    assert.equal(result.stableReadySamples, 5);
    assert.equal(inspections, 8);
    assert.equal(waits, 7);
    assert.equal(clicks, 0);
  } finally { f.close(); }
});

test('\u6700\u7ec8\u53d1\u5e03\u6309\u94ae\u6709\u591a\u4e2a\u7cbe\u786e\u5019\u9009\u65f6\u4e0d\u70b9\u51fb', async () => {
  const f = fixture();
  try {
    let clicks = 0;
    let inspections = 0;
    f.adapter.inspectLoginState = async () => ({ state: 'READY' });
    f.adapter.inspectPublishControl = async () => {
      inspections += 1;
      return { visible: false, enabled: false, reason: 'AMBIGUOUS_PRIMARY', primaryCount: 2 };
    };
    const page = publishClickPage({ onClick: () => { clicks += 1; } });
    const result = await f.adapter.clickFinalPublish(page);
    assert.equal(result.clicked, false);
    assert.equal(result.reason, 'AMBIGUOUS_PRIMARY');
    assert.equal(result.primaryCount, 2);
    assert.equal(inspections, 1);
    assert.equal(clicks, 0);
  } finally { f.close(); }
});

test('\u552f\u4e00\u81ea\u5b9a\u4e49 div \u53d1\u5e03\u63a7\u4ef6\u901a\u8fc7\u4e24\u6b21\u68c0\u67e5\u540e\u53ea\u70b9\u51fb\u4e00\u6b21', async () => {
  const f = fixture();
  try {
    let clicks = 0;
    let inspections = 0;
    f.adapter.inspectLoginState = async () => ({ state: 'READY' });
    f.adapter.inspectPublishControl = async () => {
      inspections += 1;
      return publishInspection({ marker: `candidate-${inspections}`, tag: 'div' });
    };
    const page = publishClickPage({ onClick: () => { clicks += 1; } });
    const result = await f.adapter.clickFinalPublish(page);
    assert.equal(result.clicked, true);
    assert.equal(result.strategy, 'shared-inspection-locator');
    assert.equal(result.tag, 'div');
    assert.equal(result.confirmation, 'NOT_PRESENT');
    assert.equal(inspections, 2);
    assert.equal(clicks, 1);
  } finally { f.close(); }
});

test('\u53d1\u5e03\u5019\u9009\u5728\u4e8c\u6b21\u68c0\u67e5\u65f6\u53d1\u751f\u53d8\u5316\u5219\u62d2\u7edd\u70b9\u51fb', async () => {
  const f = fixture();
  try {
    let clicks = 0;
    let inspections = 0;
    f.adapter.inspectLoginState = async () => ({ state: 'READY' });
    f.adapter.inspectPublishControl = async () => {
      inspections += 1;
      return publishInspection({ marker: `candidate-${inspections}`, x: inspections === 1 ? 100 : 300 });
    };
    const page = publishClickPage({ onClick: () => { clicks += 1; } });
    const result = await f.adapter.clickFinalPublish(page);
    assert.equal(result.clicked, false);
    assert.equal(result.reason, 'PRIMARY_CHANGED_BEFORE_CLICK');
    assert.equal(inspections, 2);
    assert.equal(clicks, 0);
  } finally { f.close(); }
});

test('\u9047\u5230\u5b89\u5168\u9a8c\u8bc1\u65f6\u4e0d\u68c0\u67e5\u4e5f\u4e0d\u70b9\u51fb\u6700\u7ec8\u53d1\u5e03', async () => {
  const f = fixture();
  try {
    let clicks = 0;
    let inspections = 0;
    f.adapter.inspectLoginState = async () => ({ state: 'VERIFY_REQUIRED' });
    f.adapter.inspectPublishControl = async () => { inspections += 1; return publishInspection(); };
    const page = publishClickPage({ onClick: () => { clicks += 1; } });
    const result = await f.adapter.clickFinalPublish(page);
    assert.equal(result.clicked, false);
    assert.equal(result.reason, 'VERIFY_REQUIRED');
    assert.equal(inspections, 0);
    assert.equal(clicks, 0);
  } finally { f.close(); }
});

test('\u4e8c\u6b21\u786e\u8ba4\u6309\u94ae\u4e0d\u552f\u4e00\u65f6\u4e0d\u70b9\u51fb\u786e\u8ba4', async () => {
  const f = fixture();
  try {
    let publishClicks = 0;
    let confirmClicks = 0;
    let inspections = 0;
    const confirm = {
      async isVisible() { return true; },
      async isEnabled() { return true; },
      async click() { confirmClicks += 1; }
    };
    const confirms = { async count() { return 2; }, nth() { return confirm; } };
    const dialog = {
      async isVisible() { return true; },
      getByText() { return confirms; }
    };
    const dialogs = {
      filter() { return this; },
      async count() { return 1; },
      nth() { return dialog; }
    };
    f.adapter.inspectLoginState = async () => ({ state: 'READY' });
    f.adapter.inspectPublishControl = async () => {
      inspections += 1;
      return publishInspection({ marker: `candidate-${inspections}` });
    };
    const page = publishClickPage({ dialogs, onClick: () => { publishClicks += 1; } });
    const result = await f.adapter.clickFinalPublish(page);
    assert.equal(result.clicked, true);
    assert.equal(result.confirmation, 'AMBIGUOUS');
    assert.equal(result.confirmationCount, 2);
    assert.equal(publishClicks, 1);
    assert.equal(confirmClicks, 0);
  } finally { f.close(); }
});

test('普通管理页 URL 不能作为本次发布成功证据', async () => {
  const f = fixture();
  try {
    const page = publishPage('https://creator.xiaohongshu.com/new/note-manager');
    page.getByText = () => emptyCollection();
    const result = await f.adapter.waitForPublishSuccess(page, { url: 'https://creator.xiaohongshu.com/publish/publish', successTextCount: 0 });
    assert.equal(result.confirmed, false);
  } finally { f.close(); }
});

test('baseline 中已有成功文案不能证明本次发布成功', async () => {
  const f = fixture();
  try {
    const visible = { async isVisible() { return true; } };
    const page = publishPage('https://creator.xiaohongshu.com/publish/publish');
    page.getByText = () => ({ async count() { return 1; }, nth() { return visible; } });
    const result = await f.adapter.waitForPublishSuccess(page, { url: page.url(), successTextCount: 1 });
    assert.equal(result.confirmed, false);
  } finally { f.close(); }
});

test('新出现的精确 /publish/success URL 可确认发布', async () => {
  const f = fixture();
  try {
    const page = publishPage('https://creator.xiaohongshu.com/publish/success?id=1');
    page.getByText = () => emptyCollection();
    const result = await f.adapter.waitForPublishSuccess(page, { url: 'https://creator.xiaohongshu.com/publish/publish', successTextCount: 0 });
    assert.equal(result.confirmed, true);
    assert.equal(result.source, 'new-success-url');
  } finally { f.close(); }
});

test('服务端只认可带本次新成功信号的小红书发布证明', () => {
  const base = {
    stage: 'published', submissionStatus: 'SUBMITTED', submitAttempted: true,
    evidencePath: 'evidence.json', screenshotPath: 'evidence.png'
  };
  assert.equal(hasReliablePublishEvidence({ platformCode: 'xiaohongshu' }, { ...base, publishSignal: { confirmed: true, source: 'new-success-url' } }, 'SUCCESS'), true);
  assert.equal(hasReliablePublishEvidence({ platformCode: 'xiaohongshu' }, { ...base, publishSignal: { confirmed: true, source: 'success-url' } }, 'SUCCESS'), false);
  assert.equal(hasReliablePublishEvidence({ platformCode: 'xiaohongshu' }, { ...base, submitAttempted: false, publishSignal: { confirmed: true, source: 'new-visible-success-signal' } }, 'SUCCESS'), false);
});

test('Evidence 白名单不落盘回复正文和原消息正文', async () => {
  const f = fixture({ stubEvidence: false });
  try {
    const result = await f.adapter.evidence({
      platformCode: 'xiaohongshu', taskId: 1, targetId: 2, messageId: 3,
      replyText: '绝不能写入证据的回复正文', sourceContent: '绝不能写入证据的用户正文',
      messageContext: { content: '私信正文', userName: '用户' },
      draftFingerprint: { fingerprintHash: 'hash-only', title: '不应写入完整指纹' }
    }, '安全证据', null, 'privacy_test', { sendAttempted: false });
    const raw = fs.readFileSync(result.evidencePath, 'utf8');
    assert.doesNotMatch(raw, /绝不能写入证据的回复正文|绝不能写入证据的用户正文|私信正文/);
    assert.match(raw, /hash-only/);
    assert.doesNotMatch(raw, /不应写入完整指纹/);
  } finally { f.close(); }
});

test('评论回复最终点击前平台停止时不发送且可安全 defer', async () => {
  const f = fixture();
  try {
    let sendClicks = 0;
    let guardCalls = 0;
    const trigger = { async isVisible() { return true; }, async click() {} };
    const editor = { async isVisible() { return true; }, async fill() {}, async inputValue() { return '待发送'; } };
    const send = { async isVisible() { return true; }, async click() { sendClicks += 1; } };
    const echo = emptyCollection();
    const target = {
      locator(selector) {
        if (selector === '.action-reply') return one(trigger);
        if (selector.startsWith('textarea')) return one(editor);
        if (selector === 'button.submit') return one(send);
        throw new Error(`unexpected selector ${selector}`);
      },
      getByText() { return echo; }
    };
    const page = {
      async goto() {}, async waitForTimeout() {}, url() { return 'https://www.xiaohongshu.com/notification'; },
      waitForResponse() { return Promise.resolve(null); },
      getByText() { return { last() { return { async isVisible() { return false; } }; } }; }
    };
    f.adapter.getMainSitePage = async () => page;
    f.adapter.findCommentNotification = async () => target;
    f.adapter.setRuntimeGuard(async () => {
      guardCalls += 1;
      const error = new Error('stopped before send');
      error.code = 'PLATFORM_OPERATION_CANCELLED';
      throw error;
    });
    await assert.rejects(() => f.adapter.replyToMessage({
      platformCode: 'xiaohongshu', messageType: 'COMMENT', replyText: '你好',
      messageContext: { userName: '用户', content: '问题' }
    }), error => {
      assert.equal(error.code, 'PLATFORM_OPERATION_CANCELLED');
      assert.equal(error.writeAttempted, false);
      return true;
    });
    assert.equal(guardCalls, 1);
    assert.equal(sendClicks, 0);
  } finally { f.close(); }
});

test('评论回复写后异常进入 NEEDS_CONFIRMATION 并保留 sendAttempted=true', async () => {
  const f = fixture();
  try {
    const trigger = { async isVisible() { return true; }, async click() {} };
    const editor = { async isVisible() { return true; }, async fill() {}, async inputValue() { return '待发送'; } };
    const send = { async isVisible() { return true; }, async click() { throw new Error('click result unknown'); } };
    const target = {
      locator(selector) {
        if (selector === '.action-reply') return one(trigger);
        if (selector.startsWith('textarea')) return one(editor);
        if (selector === 'button.submit') return one(send);
        throw new Error(`unexpected selector ${selector}`);
      },
      getByText() { return emptyCollection(); }
    };
    const page = {
      async goto() {}, async waitForTimeout() {}, url() { return 'https://www.xiaohongshu.com/notification'; },
      waitForResponse() { return Promise.resolve(null); },
      getByText() { return { last() { return { async isVisible() { return false; } }; } }; }
    };
    f.adapter.getMainSitePage = async () => page;
    f.adapter.findCommentNotification = async () => target;
    const output = await f.adapter.replyToMessage({ platformCode: 'xiaohongshu', messageType: 'COMMENT', replyText: '你好' });
    assert.equal(output.status, 'NEEDS_CONFIRMATION');
    assert.equal(output.result.stage, 'reply_unconfirmed');
    assert.equal(output.result.sendAttempted, true);
    assert.equal(output.result.sendMethod, 'xiaohongshu:comment-click');
  } finally { f.close(); }
});


function installedChromePath() {
  const candidates = process.platform === 'win32'
    ? [
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
      ]
    : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
  return candidates.find(candidate => fs.existsSync(candidate)) || null;
}

const chromePathForDomTests = installedChromePath();

async function xhsPrivateDomFixture({ conversationId = 'target', openId = 'target', echoSuffix = '', additionalChat = false } = {}) {
  const f = fixture();
  const browser = await chromium.launch({ headless: true, executablePath: chromePathForDomTests });
  const page = await browser.newPage();
  await page.setContent(`<aside><div class="xhs-im-conv-item" data-conv-id="target" aria-selected="true"><span class="xhs-im-conv-item__name">bob</span></div></aside>
    <section data-conv-id="${openId}"><div class="chat-item"><div class="chat-item__body">原私信</div></div>
    <div class="xhs-im-input-bar-editor" contenteditable="true"></div></section>
    ${additionalChat ? '<section data-conv-id="other"><div class="chat-item__body--right">别的会话</div></section>' : ''}`);
  await page.locator('.xhs-im-conv-item').evaluate((element, id) => { element.dataset.convId = id; }, conversationId);
  await page.locator('.xhs-im-input-bar-editor').evaluate((element, suffix) => element.addEventListener('keydown', event => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    window.sends = (window.sends || 0) + 1;
    const bubble = document.createElement('div');
    bubble.className = 'chat-item__body--right';
    bubble.textContent = element.textContent + suffix;
    const destination = window.echoInOtherChat ? document.querySelector('section[data-conv-id="other"]') : element.parentElement;
    destination.append(bubble);
    element.textContent = '';
  }), echoSuffix);
  const localPage = {
    locator: selector => page.locator(selector),
    url: () => 'https://www.xiaohongshu.com/chat',
    goto: async () => {},
    waitForTimeout: async () => {}
  };
  f.adapter.getMainSitePage = async () => localPage;
  f.adapter.assertRuntimeAllowed = async () => {};
  return { ...f, page, localPage, close: async () => { await browser.close(); f.close(); } };
}

test('小红书私信会话 ID 必须原样精确匹配，不能删字符后回复另一个会话', { skip: !chromePathForDomTests }, async () => {
  const f = await xhsPrivateDomFixture();
  try {
    const result = await f.adapter.replyToMessage({ messageType: 'PRIVATE_MESSAGE', userName: 'bob', sourceContent: '原私信', replyText: '回复正文', messageContext: { conversationId: 'tar"get' } });
    assert.equal(await f.page.evaluate(() => window.sends || 0), 0);
    assert.equal(result.result.sendAttempted, false);
  } finally { await f.close(); }
});

test('小红书私信只认可本会话新增的完整回复气泡', { skip: !chromePathForDomTests }, async () => {
  for (const scenario of [{ echoSuffix: '不属于本次回复' }, { additionalChat: true }]) {
    const f = await xhsPrivateDomFixture(scenario);
    try {
      if (scenario.additionalChat) await f.page.evaluate(() => { window.echoInOtherChat = true; });
      const result = await f.adapter.replyToMessage({ messageType: 'PRIVATE_MESSAGE', userName: 'bob', sourceContent: '原私信', replyText: '回复正文', messageContext: { conversationId: 'target' } });
      assert.equal(await f.page.evaluate(() => window.sends || 0), 1);
      assert.equal(result.status, 'NEEDS_CONFIRMATION');
      assert.equal(result.result.sendAttempted, true);
    } finally { await f.close(); }
  }
});

test('小红书点击后仍显示另一会话的输入区时不能发送', { skip: !chromePathForDomTests }, async () => {
  const f = await xhsPrivateDomFixture({ openId: 'other' });
  try {
    const result = await f.adapter.replyToMessage({ messageType: 'PRIVATE_MESSAGE', userName: 'bob', sourceContent: '原私信', replyText: '回复正文', messageContext: { conversationId: 'target' } });
    assert.equal(await f.page.evaluate(() => window.sends || 0), 0);
    assert.equal(result.result.sendAttempted, false);
    assert.equal(result.status, 'NEEDS_CONFIRMATION');
  } finally { await f.close(); }
});

test('小红书已打开的私信页无需重载，发送后仍验证原会话', { skip: !chromePathForDomTests }, async () => {
  const f = await xhsPrivateDomFixture();
  try {
    let navigations = 0;
    f.localPage.goto = async () => { navigations += 1; };
    const result = await f.adapter.replyToMessage({ messageType: 'PRIVATE_MESSAGE', userName: 'bob', sourceContent: '原私信', replyText: '回复正文', messageContext: { conversationId: 'target' } });
    assert.equal(navigations, 0);
    assert.equal(result.status, 'SUCCESS');
    assert.equal(await f.page.evaluate(() => window.sends || 0), 1);
  } finally { await f.close(); }
});

test('小红书输入区身份与当前选中会话冲突时不发送', { skip: !chromePathForDomTests }, async () => {
  const f = await xhsPrivateDomFixture();
  try {
    f.adapter.assertRuntimeAllowed = async () => f.page.evaluate(() => {
      const row = document.querySelector('.xhs-im-conv-item');
      const other = row.cloneNode(true);
      other.dataset.convId = 'other';
      row.setAttribute('aria-selected', 'false');
      row.parentElement.append(other);
    });
    const result = await f.adapter.replyToMessage({ messageType: 'PRIVATE_MESSAGE', userName: 'bob', sourceContent: '原私信', replyText: '回复正文', messageContext: { conversationId: 'target' } });
    assert.equal(await f.page.evaluate(() => window.sends || 0), 0);
    assert.equal(result.result.sendAttempted, false);
  } finally { await f.close(); }
});

test('小红书同一聊天中的隐藏编辑器不能替代唯一可见输入框', { skip: !chromePathForDomTests }, async () => {
  const f = await xhsPrivateDomFixture();
  try {
    f.page.setDefaultTimeout(300);
    await f.page.locator('.xhs-im-input-bar-editor').evaluate(element => {
      const hidden = element.cloneNode();
      hidden.style.display = 'none';
      element.before(hidden);
    });
    const result = await f.adapter.replyToMessage({ messageType: 'PRIVATE_MESSAGE', userName: 'bob', sourceContent: '原私信', replyText: '回复正文', messageContext: { conversationId: 'target' } });
    assert.equal(result.status, 'SUCCESS');
    assert.equal(await f.page.evaluate(() => window.sends || 0), 1);
  } finally { await f.close(); }
});

test('小红书私信原文按正文节点和图片 emoji 核验，不混入消息时间', { skip: !chromePathForDomTests }, async () => {
  const f = await xhsPrivateDomFixture();
  try {
    await f.page.locator('.chat-item__body').evaluate(element => {
      element.innerHTML = '<span>你好<img alt="[微笑]"></span><time>10:30</time>';
    });
    const result = await f.adapter.replyToMessage({ messageType: 'PRIVATE_MESSAGE', userName: 'bob', sourceContent: '你好[微笑]', replyText: '回复正文', messageContext: { conversationId: 'target' } });
    assert.equal(result.status, 'SUCCESS');
    assert.equal(await f.page.evaluate(() => window.sends || 0), 1);
  } finally { await f.close(); }
});

test('XHS publish DOM accepts a button that restores pointer-events auto under a disabled footer', { skip: !chromePathForDomTests }, async () => {
  const f = fixture();
  const browser = await chromium.launch({ headless: true, executablePath: chromePathForDomTests });
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
    await page.setContent(`<!doctype html>
      <style>
        body { margin: 0; }
        .footer { position: fixed; inset: auto 0 0; height: 80px; display: flex; align-items: center; justify-content: center; gap: 20px; pointer-events: none; }
        .draft, .publish { width: 120px; height: 44px; border-radius: 22px; display: flex; align-items: center; justify-content: center; pointer-events: auto; cursor: pointer; }
        .draft { background: white; border: 1px solid #ddd; }
        .publish { background: rgb(255, 36, 66); color: white; }
      </style>
      <div class="footer">
        <div class="draft" role="button">&#26242;&#23384;&#31163;&#24320;</div>
        <div class="publish" role="button" onclick="window.publishClicks=(window.publishClicks||0)+1">&#21457;&#24067;</div>
      </div>`);

    const inspection = await f.adapter.inspectPublishControl(page, true);
    assert.equal(inspection.visible, true);
    assert.equal(inspection.enabled, true);
    assert.equal(inspection.primaryCount, 1);
    assert.equal(inspection.selected.disabledReason, null);
    assert.equal(inspection.selected.pointerEvents, 'auto');

    f.adapter.inspectLoginState = async () => ({ state: 'READY' });
    const result = await f.adapter.clickFinalPublish(page);
    assert.equal(result.clicked, true);
    assert.equal(result.primaryCount, 1);
    assert.equal(await page.evaluate(() => window.publishClicks || 0), 1);
  } finally {
    await browser.close();
    f.close();
  }
});

test('XHS publish DOM keeps zero clicks for disabled or ambiguous controls', { skip: !chromePathForDomTests }, async () => {
  const f = fixture();
  const browser = await chromium.launch({ headless: true, executablePath: chromePathForDomTests });
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
    f.adapter.inspectLoginState = async () => ({ state: 'READY' });

    await page.setContent('<div>form</div><button aria-disabled="true" onclick="window.publishClicks=(window.publishClicks||0)+1">&#21457;&#24067;</button>');
    const disabledInspection = await f.adapter.inspectPublishControl(page, true);
    assert.equal(disabledInspection.visible, true);
    assert.equal(disabledInspection.enabled, false);
    assert.equal(disabledInspection.primaryCount, 1);
    assert.equal(disabledInspection.reason, 'PRIMARY_DISABLED');
    assert.equal(disabledInspection.selected.disabledReason, 'ARIA_DISABLED');
    const disabledResult = await f.adapter.clickFinalPublish(page);
    assert.equal(disabledResult.clicked, false);
    assert.equal(disabledResult.reason, 'PRIMARY_DISABLED');
    assert.equal(await page.evaluate(() => window.publishClicks || 0), 0);

    await page.setContent(`
      <button onclick="window.publishClicks=(window.publishClicks||0)+1">&#21457;&#24067;</button>
      <button onclick="window.publishClicks=(window.publishClicks||0)+1">&#21457;&#24067;</button>`);
    const ambiguousInspection = await f.adapter.inspectPublishControl(page, true);
    assert.equal(ambiguousInspection.visible, false);
    assert.equal(ambiguousInspection.primaryCount, 2);
    assert.equal(ambiguousInspection.reason, 'AMBIGUOUS_PRIMARY');
    const ambiguousResult = await f.adapter.clickFinalPublish(page);
    assert.equal(ambiguousResult.clicked, false);
    assert.equal(ambiguousResult.reason, 'AMBIGUOUS_PRIMARY');
    assert.equal(await page.evaluate(() => window.publishClicks || 0), 0);
  } finally {
    await browser.close();
    f.close();
  }
});


test('小红书发布页骨架外壳不能提前确认 READY，编辑器证据出现后才确认', async () => {
  const f = fixture();
  try {
    let bodyText = '创作服务平台\n发布笔记';
    const hiddenPhone = { async count() { return 0; }, first() { return { async isVisible() { return false; } }; } };
    const page = {
      url: () => 'https://creator.xiaohongshu.com/publish/publish',
      frames: () => [],
      locator(selector) {
        if (selector === 'body') return { innerText: async () => bodyText };
        return hiddenPhone;
      }
    };

    const loading = await f.adapter.inspectLoginState(page);
    assert.deepEqual(loading, { state: 'UNKNOWN', evidence: ['publish-editor-loading'] });

    bodyText = '创作服务平台\n发布笔记\n上传视频';
    const ready = await f.adapter.inspectLoginState(page);
    assert.deepEqual(ready, { state: 'READY', evidence: ['authenticated-url', 'publish-editor-ready-text'] });
  } finally { f.close(); }
});

test('小红书上传标签延迟出现时继续等待，标签最多点击一次并持续检查运行开关', async () => {
  const f = fixture();
  try {
    let scan = 0;
    let selected = false;
    let clickCount = 0;
    let runtimeChecks = 0;
    let evaluationCount = 0;
    f.adapter.assertRuntimeAllowed = async () => { runtimeChecks += 1; };
    f.adapter.fileInputLocators = async (_page, kind) => {
      assert.equal(kind, 'video');
      return selected ? [{}] : [];
    };

    const tab = {
      async evaluate() {
        evaluationCount += 1;
        if (evaluationCount === 1) return { width: 120, height: 36, inViewport: true, displayed: true };
        clickCount += 1;
        selected = true;
        return undefined;
      },
      async scrollIntoViewIfNeeded() {},
      async click() {
        clickCount += 1;
        selected = true;
      }
    };
    const empty = { async count() { return 0; }, nth() { return tab; } };
    const frame = {
      url: () => 'https://creator.xiaohongshu.com/publish/publish',
      getByText(name) {
        if (name === '上传视频' && scan >= 2) return { async count() { return 1; }, nth() { return tab; } };
        return empty;
      }
    };
    const page = {
      frames: () => [frame],
      locator: selector => selector === 'body' ? { innerText: async () => '创作服务平台 发布笔记' } : empty,
      async waitForTimeout() { scan += 1; }
    };

    const result = await f.adapter.selectUploadTab(page, true, 5_000);
    assert.equal(result.selected, true);
    assert.equal(result.label, '上传视频');
    assert.equal(clickCount, 1);
    assert.equal(runtimeChecks >= 3, true);
  } finally { f.close(); }
});
