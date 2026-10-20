import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DouyinAssistedRpaAdapter } from '../agent/rpa-adapters/douyin-assisted.js';
import { matchDouyinCommentIdentity, selectPrivateConversationHeaderEvidence } from '../agent/rpa-adapters/assisted-platform.js';
import { assessAutoReplyEligibility } from '../src/services/auto-reply-eligibility.js';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-flow-'));
  const materialPath = path.join(root, 'video.mp4');
  fs.writeFileSync(materialPath, 'fixture');
  const adapter = new DouyinAssistedRpaAdapter({
    logsDir: path.join(root, 'logs'),
    profileDir: path.join(root, 'profile'),
    loginTimeoutMs: 10,
    sendTimeoutMs: 10
  });
  adapter.evidence = async (_payload, message, _page, reason, extra = {}) => ({ message, reason, ...extra });
  return { root, materialPath, adapter };
}

function evidencePage(text = '') {
  return {
    goto: async () => {},
    waitForTimeout: async () => {},
    locator(selector) {
      if (selector === 'body') return { allInnerTexts: async () => text ? [text] : [] };
      return { evaluateAll: async () => [] };
    }
  };
}

function usableLocator(onClick = async () => {}) {
  const item = {
    count: async () => 1,
    nth() { return item; },
    isVisible: async () => true,
    isEnabled: async () => true,
    evaluate: async fn => fn.toString().includes('const target') ? true : ({ className: 'e2e-send-msg-btn', text: '', ariaLabel: 'send' }),
    click: onClick
  };
  return item;
}

function missingLocator() {
  return { count: async () => 0, nth() { return this; }, filter() { return this; }, isVisible: async () => false };
}

function locatorList(items = []) {
  return {
    count: async () => items.length,
    nth: index => items[index] || missingLocator()
  };
}

function recentReadConversationPage(items = []) {
  const clicks = [];
  const textLocator = value => ({
    count: async () => value ? 1 : 0,
    nth() { return this; },
    isVisible: async () => Boolean(value),
    innerText: async () => value
  });
  const visibilityLocator = visible => ({
    first() { return this; },
    isVisible: async () => visible,
    count: async () => visible ? 1 : 0,
    nth() { return this; }
  });
  const rowItems = items.map((item, index) => ({
    ...item,
    index,
    count: async () => 1,
    nth() { return this; },
    isVisible: async () => item.visible !== false,
    locator(selector) {
      if (selector === '.conversation-name') return textLocator(item.name);
      if (selector === '.unread-dot') return visibilityLocator(item.unread === true);
      return missingLocator();
    },
    click: async () => { clicks.push(index); }
  }));
  const rows = locatorList(rowItems);
  const page = {
    url: () => 'https://www.douyin.com/user/self',
    locator: selector => selector === '[data-e2e="conversation-item"]' ? rows : missingLocator(),
    waitForTimeout: async () => {}
  };
  return { clicks, page, rowItems };
}

function configureRecentReadConversationSelectors(adapter) {
  adapter.assertRuntimeAllowed = async () => {};
  adapter.spec.privateConversationRowSelectors = ['[data-e2e="conversation-item"]'];
  adapter.spec.privateConversationNameSelectors = ['.conversation-name'];
  adapter.spec.privateUnreadSelectors = ['.unread-dot'];
}

function domLocator(options = {}, onClick = async () => {}) {
  const attributes = { ...(options.attributes || {}) };
  const element = {
    tagName: String(options.tagName || 'DIV').toUpperCase(),
    innerText: options.text || '',
    textContent: options.text || '',
    className: options.className || '',
    disabled: options.disabled === true,
    readOnly: options.readOnly === true,
    isContentEditable: options.contentEditable === true,
    getAttribute(name) {
      if (name === 'class') return this.className;
      if (name === 'contenteditable') return this.isContentEditable ? 'true' : null;
      if (name === 'aria-disabled') return this.disabled ? 'true' : attributes[name] ?? null;
      return attributes[name] ?? null;
    },
    matches(selector) {
      return String(selector).split(',').some(part => {
        const value = part.trim();
        if (value === 'button') return this.tagName === 'BUTTON';
        if (value === '[role="button"]') return this.getAttribute('role') === 'button';
        if (value.includes('cmt-btn-')) return this.tagName === 'BUTTON' && this.className.includes('cmt-btn-');
        return false;
      });
    }
  };
  return {
    count: async () => 1,
    nth() { return this; },
    isVisible: async () => options.visible !== false,
    isEnabled: async () => !element.disabled,
    evaluate: async (fn, arg) => fn(element, arg),
    click: onClick
  };
}

test('constructor pins Douyin and verified scoped selectors', () => {
  const { adapter } = fixture();
  assert.equal(adapter.platformCode, 'douyin');
  assert.equal(adapter.spec.strictScopedReply, true);
  assert.deepEqual(adapter.spec.privateConversationRowSelectors, ['[data-e2e="conversation-item"]']);
  assert.deepEqual(adapter.spec.privateMessageSendSelectors, ['.e2e-send-msg-btn']);
  assert.equal(adapter.spec.privateRequireUnreadForReply, true);
  assert.ok(adapter.spec.commentSendSelectors.includes('button[class*="cmt-btn-"]'));
  assert.equal(adapter.spec.commentRowSelector, '[class*="cmt-li-"]');
});

test('Douyin read row recovers its stable conversation ID from suffixed React properties', async () => {
  const { adapter } = fixture();
  const element = {
    parentElement: null,
    getAttribute: () => null
  };
  element['__reactFiber$fixture'] = {
    pendingProps: {
      conversationId: '0:1:107866855270:125779102156500'
    }
  };
  const row = { evaluate: async callback => callback(element) };

  const identity = await adapter.readPrivateConversationRowIdentity(row);

  assert.equal(identity.conversationId, '0:1:107866855270:125779102156500');
  assert.deepEqual(identity.evidence, ['react:conversationId']);
});
test('Douyin read row ignores the IM container id and keeps scanning for the real conversation ID', async () => {
  const { adapter } = fixture();
  const element = {
    parentElement: null,
    getAttribute: name => name === 'id' ? 'imSaasContainerId' : null
  };
  element['__reactFiber$fixture'] = {
    pendingProps: {
      conversationId: 'imSaasContainerId',
      nestedConversation: {
        conversationId: '0:1:107866855270:125779102156500'
      }
    }
  };
  const row = { evaluate: async callback => callback(element) };

  const identity = await adapter.readPrivateConversationRowIdentity(row);

  assert.equal(identity.conversationId, '0:1:107866855270:125779102156500');
  assert.deepEqual(identity.evidence, ['react:conversationId']);
});

test('Douyin read row rejects a container-only identity', async () => {
  const { adapter } = fixture();
  const element = {
    parentElement: null,
    getAttribute: name => name === 'id' ? 'imSaasContainerId' : null
  };
  element['__reactProps$fixture'] = { conversationId: 'imSaasContainerId' };
  const row = { evaluate: async callback => callback(element) };

  const identity = await adapter.readPrivateConversationRowIdentity(row);

  assert.equal(identity.conversationId, null);
  assert.deepEqual(identity.evidence, []);
});

test('open Douyin private conversation recovers a read latest incoming message', async () => {
  const { adapter } = fixture();
  const page = {
    url: () => 'https://www.douyin.com/user/self',
    locator: () => missingLocator(),
    waitForTimeout: async () => {}
  };
  adapter.findReplyEditor = async () => ({ isVisible: async () => true });
  adapter.readOpenDouyinConversationHeader = async () => ({ ok: true, headerName: 'alice' });
  adapter.locateOpenDouyinConversationIdentity = async () => ({ ok: true, conversationId: 'conversation-alice', evidence: ['test-row'] });
  adapter.inspectStablePrivateConversationTimeline = async () => ({
    stable: true,
    messages: [
      { text: '哈喽，你好啊', direction: 'incoming', messageId: 'message-1', conversationId: 'conversation-alice' },
      { text: '你好呀！请问有什么社区业务需要咨询或办理吗？', direction: 'outgoing', messageId: 'reply-1', conversationId: 'conversation-alice' },
      { text: '我想了解一下怎么入住你们社区', direction: 'incoming', messageId: 'message-2', conversationId: 'conversation-alice', messageIdEvidence: 'test-message' }
    ],
    latestMessage: {
      text: '我想了解一下怎么入住你们社区',
      direction: 'incoming',
      messageId: 'message-2',
      conversationId: 'conversation-alice',
      messageIdEvidence: 'test-message'
    }
  });

  const recovery = await adapter.collectLatestIncomingFromOpenPrivateConversation(page);
  assert.equal(recovery.recoveredCount, 1);
  assert.equal(recovery.reason, 'OPEN_CHAT_LATEST_INCOMING_VERIFIED');
  assert.equal(recovery.message.userName, 'alice');
  assert.equal(recovery.message.content, '我想了解一下怎么入住你们社区');
  assert.equal(recovery.message.context.unread, false);
  assert.equal(recovery.message.context.previewOnly, false);
  assert.equal(recovery.message.context.fullSource, true);
  assert.equal(recovery.message.context.sourceVerified, true);
  assert.equal(recovery.message.context.chatTitleVerified, true);
  assert.equal(recovery.message.context.direction, 'incoming');
  assert.equal(recovery.message.context.messageId, 'message-2');
  assert.equal(recovery.message.context.conversationId, 'conversation-alice');
  assert.equal(recovery.message.context.collectionSource, 'OPEN_CONVERSATION_TIMELINE');
});

test('open Douyin private conversation recovers every incoming message after the latest system reply', async () => {
  const { adapter } = fixture();
  const page = {
    url: () => 'https://www.douyin.com/user/self',
    locator: () => missingLocator(),
    waitForTimeout: async () => {}
  };
  adapter.findReplyEditor = async () => ({ isVisible: async () => true });
  adapter.readOpenDouyinConversationHeader = async () => ({ ok: true, headerName: 'alice' });
  adapter.locateOpenDouyinConversationIdentity = async () => ({ ok: true, conversationId: 'conversation-alice', evidence: ['test-row'] });
  adapter.inspectStablePrivateConversationTimeline = async () => ({
    stable: true,
    messages: [
      { text: '首个问题', direction: 'incoming', messageId: 'message-1', conversationId: 'conversation-alice' },
      { text: '您好，欢迎咨询。', direction: 'outgoing', messageId: 'reply-1', conversationId: 'conversation-alice' },
      { text: '我想了解一下创业社区', direction: 'incoming', messageId: 'message-2', conversationId: 'conversation-alice', messageIdEvidence: 'test-message-2' },
      { text: '具体怎么申请入住？', direction: 'incoming', messageId: 'message-3', conversationId: 'conversation-alice', messageIdEvidence: 'test-message-3' }
    ],
    latestMessage: {
      text: '具体怎么申请入住？',
      direction: 'incoming',
      messageId: 'message-3',
      conversationId: 'conversation-alice',
      messageIdEvidence: 'test-message-3'
    }
  });

  const recovery = await adapter.collectLatestIncomingFromOpenPrivateConversation(page);
  assert.equal(recovery.recoveredCount, 2);
  assert.equal(recovery.reason, 'OPEN_CHAT_INCOMING_AFTER_REPLY_VERIFIED');
  assert.deepEqual(recovery.messages.map(message => message.context.messageId), ['message-2', 'message-3']);
  assert.deepEqual(recovery.messages.map(message => message.content), ['我想了解一下创业社区', '具体怎么申请入住？']);
  assert.ok(recovery.messages.every(message => message.context.unread === false));
  assert.ok(recovery.messages.every(message => message.context.previewOnly === false));
});

test('open Douyin private conversation does not invent an incoming message from an outgoing-only timeline', async () => {
  const { adapter } = fixture();
  const page = { url: () => 'https://www.douyin.com/user/self' };
  adapter.findReplyEditor = async () => ({});
  adapter.readOpenDouyinConversationHeader = async () => ({ ok: true, headerName: 'alice' });
  adapter.inspectStablePrivateConversationTimeline = async () => ({
    stable: true,
    messages: [{ text: '已经回复', direction: 'outgoing', messageId: 'reply-1', conversationId: 'conversation-alice' }],
    latestMessage: { text: '已经回复', direction: 'outgoing', messageId: 'reply-1', conversationId: 'conversation-alice' }
  });

  const recovery = await adapter.collectLatestIncomingFromOpenPrivateConversation(page);
  assert.equal(recovery.recoveredCount, 0);
  assert.equal(recovery.reason, 'OPEN_CONVERSATION_LATEST_MESSAGE_OUTGOING');
  assert.equal(recovery.message, undefined);
});

test('open Douyin private conversation imports a replied incoming message with same-chat reply evidence', async () => {
  const { adapter } = fixture();
  const page = { url: () => 'https://www.douyin.com/user/self' };
  adapter.findReplyEditor = async () => ({});
  adapter.readOpenDouyinConversationHeader = async () => ({ ok: true, headerName: 'alice' });
  adapter.locateOpenDouyinConversationIdentity = async () => ({ ok: true, conversationId: 'conversation-alice' });
  const incoming = { text: '澳门车可以在内地停留多久？', direction: 'incoming', messageId: 'incoming-1', conversationId: 'conversation-alice' };
  const outgoing = { text: '为了更准确地帮助您，请再具体说明一下想咨询的业务、对象和问题。', direction: 'outgoing', messageId: 'outgoing-1', conversationId: 'conversation-alice' };
  adapter.inspectStablePrivateConversationTimeline = async () => ({ stable: true, messages: [incoming, outgoing], latestMessage: outgoing });

  const recovery = await adapter.collectLatestIncomingFromOpenPrivateConversation(page);
  assert.equal(recovery.recoveredCount, 1);
  assert.equal(recovery.message.content, incoming.text);
  assert.equal(recovery.message.context.alreadyHandled, true);
  assert.equal(recovery.message.context.platformReplyDetected, true);
  assert.equal(recovery.message.context.platformReplyText, outgoing.text);
  assert.deepEqual(recovery.message.context.platformReplyEvidence, {
    conversationId: 'conversation-alice', incomingMessageId: 'incoming-1', outgoingMessageId: 'outgoing-1',
    outgoingDirection: 'outgoing', incomingIndex: 0, outgoingIndex: 1, timelineStable: true
  });

  outgoing.messageId = null;
  assert.equal((await adapter.collectLatestIncomingFromOpenPrivateConversation(page)).recoveredCount, 0);
  outgoing.messageId = 'outgoing-1';
  outgoing.conversationId = 'conversation-bob';
  assert.equal((await adapter.collectLatestIncomingFromOpenPrivateConversation(page)).recoveredCount, 0);

  outgoing.conversationId = 'conversation-alice';
  const followup = { ...incoming, text: '那怎么办理？', messageId: 'incoming-2' };
  adapter.inspectStablePrivateConversationTimeline = async () => ({ stable: true, messages: [incoming, outgoing, followup], latestMessage: followup });
  const newQuestion = await adapter.collectLatestIncomingFromOpenPrivateConversation(page);
  assert.equal(newQuestion.recoveredCount, 1);
  assert.equal(newQuestion.message.context.messageId, 'incoming-2');
  assert.notEqual(newQuestion.message.context.alreadyHandled, true);

  const unidentified = { ...incoming, text: '最新但尚未加载编号的问题', messageId: null };
  const laterReply = { ...outgoing, text: '对最新问题的回复', messageId: 'outgoing-2' };
  adapter.inspectStablePrivateConversationTimeline = async () => ({ stable: true, messages: [incoming, outgoing, unidentified, laterReply], latestMessage: laterReply });
  assert.equal((await adapter.collectLatestIncomingFromOpenPrivateConversation(page)).recoveredCount, 0);
});

test('Douyin recovery dedup retains later platform reply evidence and never downgrades it', () => {
  const { adapter } = fixture();
  const incoming = { messageType: 'PRIVATE_MESSAGE', externalId: 'incoming-1', content: '原问题', context: { conversationId: 'conversation-alice', messageId: 'incoming-1' } };
  const replied = { ...incoming, context: { ...incoming.context, alreadyHandled: true, platformReplyDetected: true, platformReplyText: '平台回复', platformReplyEvidence: { outgoingMessageId: 'outgoing-1' } } };
  for (const candidates of [[incoming, replied], [replied, incoming]]) {
    const combined = adapter.combineOpenConversationRecoveries(candidates.map(message => ({ message, attempted: true })));
    assert.equal(combined.messages.length, 1);
    assert.equal(combined.message.context.platformReplyText, '平台回复');
    const merged = adapter.mergeOpenConversationRecovery({ result: { messages: [candidates[0]], typeResults: [] } }, { message: candidates[1] });
    assert.equal(merged.result.messages.length, 1);
    assert.equal(merged.result.messages[0].context.platformReplyText, '平台回复');
  }
});

test('unstable open Douyin private timeline is not auto-collected', async () => {
  const { adapter } = fixture();
  const page = { url: () => 'https://www.douyin.com/user/self' };
  adapter.findReplyEditor = async () => ({});
  adapter.readOpenDouyinConversationHeader = async () => ({ ok: true, headerName: 'alice' });
  adapter.inspectStablePrivateConversationTimeline = async () => ({
    stable: false,
    reason: 'PRIVATE_TIMELINE_UNSTABLE',
    messages: [{ text: '还在加载', direction: 'incoming', messageId: 'message-2', conversationId: 'conversation-alice' }],
    latestMessage: { text: '还在加载', direction: 'incoming', messageId: 'message-2', conversationId: 'conversation-alice' }
  });

  const recovery = await adapter.collectLatestIncomingFromOpenPrivateConversation(page);
  assert.equal(recovery.recoveredCount, 0);
  assert.equal(recovery.reason, 'PRIVATE_TIMELINE_UNSTABLE');
  assert.equal(recovery.timelineStable, false);
});

test('open conversation recovery merges once and records diagnostics', () => {
  const { adapter } = fixture();
  const recoveredMessage = {
    messageType: 'PRIVATE_MESSAGE',
    externalId: 'douyin-private_message-recovered',
    userName: 'alice',
    content: '我想了解一下怎么入住你们社区',
    context: { conversationId: 'conversation-alice', messageId: 'message-2' }
  };
  const baseOutput = {
    status: 'SUCCESS',
    result: {
      messages: [],
      typeResults: [{ type: 'PRIVATE_MESSAGE', status: 'SUCCESS', count: 0 }]
    }
  };
  const recovery = {
    attempted: true,
    recoveredCount: 1,
    reason: 'OPEN_CHAT_LATEST_INCOMING_VERIFIED',
    sourcePage: 'https://www.douyin.com/user/self',
    headerName: 'alice',
    conversationId: 'conversation-alice',
    messageId: 'message-2',
    timelineStable: true,
    messageCount: 3,
    message: recoveredMessage
  };

  const merged = adapter.mergeOpenConversationRecovery(baseOutput, recovery);
  assert.equal(merged.result.messages.length, 1);
  assert.equal(merged.result.typeResults[0].count, 1);
  assert.equal(merged.result.typeResults[0].recoveredCount, 1);
  assert.equal(merged.result.typeResults[0].openConversationRecovery.reason, 'OPEN_CHAT_LATEST_INCOMING_VERIFIED');

  const duplicate = adapter.mergeOpenConversationRecovery(merged, recovery);
  assert.equal(duplicate.result.messages.length, 1);
  assert.equal(duplicate.result.typeResults[0].count, 1);
  assert.equal(duplicate.result.typeResults[0].recoveredCount, 0);
  assert.equal(duplicate.result.typeResults[0].openConversationRecovery.reason, 'OPEN_CHAT_MESSAGE_ALREADY_COLLECTED');
});

test('message collection inspects the already open Douyin chat before normal inbox navigation', async () => {
  const { adapter } = fixture();
  const events = [];
  const page = {
    url: () => 'https://www.douyin.com/user/self',
    locator: () => ({
      evaluateAll: async () => [],
      count: async () => 0,
      nth() { return this; }
    })
  };
  const recoveredMessage = {
    messageType: 'PRIVATE_MESSAGE',
    externalId: 'douyin-private_message-recovered',
    userName: 'alice',
    content: '我想了解一下怎么入住你们社区',
    externalUrl: page.url(),
    context: {
      conversationId: 'conversation-alice',
      conversationKey: 'conversation-alice',
      messageId: 'message-2',
      direction: 'incoming',
      previewOnly: false,
      fullSource: true,
      sourceVerified: true,
      chatTitleVerified: true
    }
  };
  adapter.getPage = async () => page;
  adapter.channelPages.set('PRIVATE_MESSAGE', page);
  adapter.restorePrivateInboxOverview = async (restoredPage, options) => {
    assert.equal(restoredPage, page);
    assert.equal(options.source, 'MESSAGE_COLLECTION_FINALLY');
    events.push('restore-private-overview');
    return { attempted: true, restored: true, overviewVisible: true };
  };
  adapter.collectLatestIncomingFromOpenPrivateConversation = async () => {
    events.push('inspect-open-chat');
    return {
      attempted: true,
      recoveredCount: 1,
      reason: 'OPEN_CHAT_LATEST_INCOMING_VERIFIED',
      sourcePage: page.url(),
      headerName: 'alice',
      conversationId: 'conversation-alice',
      messageId: 'message-2',
      timelineStable: true,
      messageCount: 3,
      message: recoveredMessage
    };
  };
  adapter.prepareMessagePage = async () => {
    events.push('normal-inbox-navigation');
    return { action: 'already_on_target' };
  };
  adapter.inspectLoginState = async () => ({ state: 'READY' });
  adapter.waitForMessageContentReadyBase = async () => ({ ready: true, pageCheck: { valid: true, reason: 'READY' } });
  adapter.extractMessages = async () => [];
  adapter.enrichDouyinUnreadPrivateMessages = async () => ({ messages: [], attemptedCount: 0, verifiedCount: 0, results: [] });
  adapter.inspectPrivateMessageCoverage = async () => ({ strangerInboxVisible: false, strangerUnread: false, evidence: [] });

  const output = await adapter.collectMessages({ types: ['PRIVATE_MESSAGE'] });
  assert.deepEqual(events, ['inspect-open-chat', 'normal-inbox-navigation', 'inspect-open-chat', 'restore-private-overview']);
  assert.equal(output.status, 'SUCCESS');
  assert.equal(output.result.messages.length, 1);
  assert.equal(output.result.messages[0].context.messageId, 'message-2');
  assert.equal(output.result.typeResults[0].recoveredCount, 1);
  assert.deepEqual(output.result.typeResults[0].openConversationRecovery.inspectionPhases, [
    'BEFORE_NORMAL_COLLECTION',
    'AFTER_PRIVATE_NAVIGATION'
  ]);
});

test('message collection scans recent read chats when navigation opens the Douyin inbox without a selected conversation', async () => {
  const { adapter } = fixture();
  const events = [];
  let currentUrl = 'about:blank';
  const page = {
    url: () => currentUrl,
    locator: () => ({
      evaluateAll: async () => [],
      count: async () => 0,
      nth() { return this; }
    })
  };
  const recoveredMessage = {
    messageType: 'PRIVATE_MESSAGE',
    externalId: 'douyin-private_message-after-navigation',
    userName: 'alice',
    content: '刚刚又发了一条，但是页面已经显示已读',
    externalUrl: 'https://www.douyin.com/user/self',
    context: {
      conversationId: 'conversation-alice',
      conversationKey: 'conversation-alice',
      messageId: 'message-after-navigation',
      direction: 'incoming',
      previewOnly: false,
      fullSource: true,
      sourceVerified: true,
      chatTitleVerified: true
    }
  };
  adapter.getPage = async () => page;
  adapter.collectLatestIncomingFromOpenPrivateConversation = async () => {
    events.push(`inspect:${currentUrl}`);
    if (currentUrl === 'about:blank') {
      return { attempted: false, recoveredCount: 0, reason: 'NOT_ON_DOUYIN_PRIVATE_MESSAGE_PAGE', sourcePage: currentUrl };
    }
    return {
      attempted: true,
      recoveredCount: 0,
      reason: 'OPEN_CONVERSATION_HEADER_MISSING',
      sourcePage: currentUrl
    };
  };
  adapter.collectIncomingFromRecentReadPrivateConversations = async () => {
    events.push('scan-recent-read-conversations');
    return {
      attempted: true,
      recoveredCount: 1,
      reason: 'OPEN_CHAT_LATEST_INCOMING_VERIFIED',
      sourcePage: currentUrl,
      headerName: 'alice',
      conversationId: 'conversation-alice',
      messageId: 'message-after-navigation',
      timelineStable: true,
      messageCount: 3,
      scannedRowCount: 4,
      inspectedReadRowCount: 2,
      rowDiagnostics: [{ index: 1, recoveredCount: 1, reason: 'OPEN_CHAT_LATEST_INCOMING_VERIFIED' }],
      recoveryEntryVersion: 'douyin-open-chat-entry-2026.08.23.2',
      message: recoveredMessage
    };
  };
  adapter.prepareMessagePage = async () => {
    events.push('normal-inbox-navigation');
    currentUrl = 'https://www.douyin.com/user/self';
    return { action: 'navigated' };
  };
  adapter.inspectLoginState = async () => ({ state: 'READY' });
  adapter.waitForMessageContentReadyBase = async () => ({ ready: true, pageCheck: { valid: true, reason: 'READY' } });
  adapter.extractMessages = async () => [];
  adapter.enrichDouyinUnreadPrivateMessages = async () => ({ messages: [], attemptedCount: 0, verifiedCount: 0, results: [] });
  adapter.inspectPrivateMessageCoverage = async () => ({ strangerInboxVisible: false, strangerUnread: false, evidence: [] });

  const output = await adapter.collectMessages({ types: ['PRIVATE_MESSAGE'] });

  assert.deepEqual(events, [
    'inspect:about:blank',
    'normal-inbox-navigation',
    'inspect:https://www.douyin.com/user/self',
    'scan-recent-read-conversations'
  ]);
  assert.equal(output.status, 'SUCCESS');
  assert.equal(output.result.messages.length, 1);
  assert.equal(output.result.messages[0].context.messageId, 'message-after-navigation');
  assert.equal(output.result.typeResults[0].recoveredCount, 1);
  assert.equal(output.result.typeResults[0].openConversationRecovery.sourcePage, 'https://www.douyin.com/user/self');
  assert.equal(output.result.typeResults[0].openConversationRecovery.recoveryEntryVersion, 'douyin-open-chat-entry-2026.08.23.3');
  assert.equal(output.result.typeResults[0].openConversationRecovery.inspectedReadRowCount, 2);
});

test('recent read-conversation scan skips unread rows and recovers only a stable read conversation', async () => {
  const { adapter } = fixture();
  adapter.assertRuntimeAllowed = async () => {};
  adapter.spec.privateConversationRowSelectors = ['[data-e2e="conversation-item"]'];
  adapter.spec.privateConversationNameSelectors = ['.conversation-name'];
  adapter.spec.privateUnreadSelectors = ['.unread-dot'];
  const clicks = [];
  const textLocator = text => ({
    count: async () => text ? 1 : 0,
    nth() { return this; },
    isVisible: async () => Boolean(text),
    innerText: async () => text
  });
  const visibilityLocator = visible => ({
    first() { return this; },
    isVisible: async () => visible,
    count: async () => visible ? 1 : 0,
    nth() { return this; }
  });
  const row = ({ name, unread, conversationId, index }) => ({
    conversationId,
    count: async () => 1,
    nth() { return this; },
    isVisible: async () => true,
    locator(selector) {
      if (selector === '.conversation-name') return textLocator(name);
      if (selector === '.unread-dot') return visibilityLocator(unread);
      return missingLocator();
    },
    click: async () => { clicks.push(index); }
  });
  const unreadRow = row({ name: 'unread-user', unread: true, conversationId: 'conversation-unread', index: 0 });
  const readRow = row({ name: 'alice', unread: false, conversationId: 'conversation-alice', index: 1 });
  const rows = locatorList([unreadRow, readRow]);
  const page = {
    url: () => 'https://www.douyin.com/user/self',
    locator: selector => selector === '[data-e2e="conversation-item"]' ? rows : missingLocator(),
    waitForTimeout: async () => {}
  };
  adapter.readPrivateConversationRowIdentity = async target => ({
    conversationId: target.conversationId,
    evidence: ['fixture:conversation-id']
  });
  const recoveredMessage = {
    messageType: 'PRIVATE_MESSAGE',
    externalId: 'douyin-private_message-read-row',
    userName: 'alice',
    content: '这条已经显示已读，但还没有回复',
    context: {
      conversationId: 'conversation-alice',
      conversationKey: 'conversation-alice',
      messageId: 'message-read-row'
    }
  };
  adapter.collectLatestIncomingFromOpenPrivateConversation = async (_page, _payload, options) => {
    assert.equal(options.expectedHeaderName, 'alice');
    assert.equal(options.expectedConversationId, 'conversation-alice');
    return {
      attempted: true,
      recoveredCount: 1,
      reason: 'OPEN_CHAT_LATEST_INCOMING_VERIFIED',
      sourcePage: page.url(),
      headerName: 'alice',
      conversationId: 'conversation-alice',
      messageId: 'message-read-row',
      timelineStable: true,
      messageCount: 3,
      message: recoveredMessage
    };
  };

  const recovery = await adapter.collectIncomingFromRecentReadPrivateConversations(page, {}, { maxRows: 8 });
  assert.deepEqual(clicks, [1]);
  assert.equal(recovery.recoveredCount, 1);
  assert.equal(recovery.message.context.messageId, 'message-read-row');
  assert.equal(recovery.scannedRowCount, 2);
  assert.equal(recovery.inspectedReadRowCount, 1);
  assert.equal(recovery.rowDiagnostics[0].reason, 'UNREAD_ROW_LEFT_FOR_NORMAL_COLLECTION');
  assert.equal(recovery.recoveryEntryVersion, 'douyin-open-chat-entry-2026.08.23.3');
});

test('unique visible read row without a list conversation ID recovers from the stable Douyin timeline identity', async () => {
  const { adapter } = fixture();
  configureRecentReadConversationSelectors(adapter);
  const { clicks, page } = recentReadConversationPage([
    { name: '咖啡不嘉🧊', unread: false, conversationId: null }
  ]);
  adapter.readPrivateConversationRowIdentity = async () => ({ conversationId: null, evidence: [] });
  adapter.findReplyEditor = async () => ({});
  adapter.readOpenDouyinConversationHeader = async () => ({ ok: true, headerName: '咖啡不嘉🧊' });
  const latestMessage = {
    text: '我看到你们发布的这个东西，想和你们的社区合作，成为社区志愿者。带孩子一起参加可以吗',
    direction: 'incoming',
    messageId: '041cefe0-d93e-4b1f-acd4-b6731224ca19',
    conversationId: '0:1:107866855270:125779102156500',
    messageIdEvidence: ['react:messageId'],
    conversationIdEvidence: ['react:conversationId']
  };
  adapter.inspectStablePrivateConversationTimeline = async () => ({
    stable: true,
    reason: 'PRIVATE_TIMELINE_STABLE',
    messages: [latestMessage],
    latestMessage
  });

  const recovery = await adapter.collectIncomingFromRecentReadPrivateConversations(page);

  assert.deepEqual(clicks, [0]);
  assert.equal(recovery.recoveredCount, 1);
  assert.equal(recovery.conversationId, '0:1:107866855270:125779102156500');
  assert.equal(recovery.message.context.messageId, '041cefe0-d93e-4b1f-acd4-b6731224ca19');
  assert.equal(recovery.message.context.conversationId, '0:1:107866855270:125779102156500');
  assert.equal(recovery.rowDiagnostics[0].entryIdentity, 'UNIQUE_VISIBLE_HEADER');
  assert.equal(recovery.recoveryEntryVersion, 'douyin-open-chat-entry-2026.08.23.3');
});

test('duplicate visible read-row names without stable IDs are not clicked', async () => {
  const { adapter } = fixture();
  configureRecentReadConversationSelectors(adapter);
  const { clicks, page } = recentReadConversationPage([
    { name: '同名用户', unread: false, conversationId: null },
    { name: '同名用户', unread: false, conversationId: null }
  ]);
  adapter.readPrivateConversationRowIdentity = async () => ({ conversationId: null, evidence: [] });
  adapter.collectLatestIncomingFromOpenPrivateConversation = async () => {
    throw new Error('ambiguous rows must not be opened');
  };

  const recovery = await adapter.collectIncomingFromRecentReadPrivateConversations(page);

  assert.deepEqual(clicks, []);
  assert.equal(recovery.recoveredCount, 0);
  assert.equal(recovery.inspectedReadRowCount, 0);
  assert.deepEqual(recovery.rowDiagnostics.map(item => item.reason), [
    'READ_ROW_HEADER_AMBIGUOUS_WITHOUT_STABLE_ID',
    'READ_ROW_HEADER_AMBIGUOUS_WITHOUT_STABLE_ID'
  ]);
});

test('unique read row without a stable ID is rejected when the opened Douyin header differs', async () => {
  const { adapter } = fixture();
  configureRecentReadConversationSelectors(adapter);
  const { clicks, page } = recentReadConversationPage([
    { name: 'alice', unread: false, conversationId: null }
  ]);
  adapter.readPrivateConversationRowIdentity = async () => ({ conversationId: null, evidence: [] });
  adapter.findReplyEditor = async () => ({});
  adapter.readOpenDouyinConversationHeader = async () => ({ ok: true, headerName: 'bob' });
  adapter.inspectStablePrivateConversationTimeline = async () => {
    throw new Error('timeline must not be inspected after a header mismatch');
  };

  const recovery = await adapter.collectIncomingFromRecentReadPrivateConversations(page);

  assert.deepEqual(clicks, [0]);
  assert.equal(recovery.recoveredCount, 0);
  assert.equal(recovery.rowDiagnostics[0].reason, 'OPEN_CONVERSATION_SCANNED_HEADER_MISMATCH');
});

test('unique read row without a stable ID is not collected when the timeline lacks a stable conversation ID', async () => {
  const { adapter } = fixture();
  configureRecentReadConversationSelectors(adapter);
  const { clicks, page } = recentReadConversationPage([
    { name: 'alice', unread: false, conversationId: null }
  ]);
  adapter.readPrivateConversationRowIdentity = async () => ({ conversationId: null, evidence: [] });
  adapter.findReplyEditor = async () => ({});
  adapter.readOpenDouyinConversationHeader = async () => ({ ok: true, headerName: 'alice' });
  const latestMessage = {
    text: '这条消息缺少稳定会话身份',
    direction: 'incoming',
    messageId: 'message-without-conversation-id',
    conversationId: null
  };
  adapter.inspectStablePrivateConversationTimeline = async () => ({
    stable: true,
    reason: 'PRIVATE_TIMELINE_STABLE',
    messages: [latestMessage],
    latestMessage
  });

  const recovery = await adapter.collectIncomingFromRecentReadPrivateConversations(page);

  assert.deepEqual(clicks, [0]);
  assert.equal(recovery.recoveredCount, 0);
  assert.equal(recovery.rowDiagnostics[0].reason, 'STABLE_CONVERSATION_ID_REQUIRED');
});

test('Douyin upload landing control injects the local video through file chooser', async () => {
  const { adapter, materialPath } = fixture();
  let selectedPath = null;
  let triggerClicks = 0;
  let titleValue = null;
  let captionValue = null;
  let uploadStarted = false;

  const absent = () => ({
    count: async () => 0,
    nth() { return this; },
    isVisible: async () => false,
    isEnabled: async () => false
  });
  const uploadTrigger = {
    count: async () => 1,
    nth() { return this; },
    isVisible: async () => true,
    isEnabled: async () => true,
    evaluate: async fn => fn.toString().includes('const target') ? true : null,
    click: async () => { triggerClicks += 1; }
  };
  const titleInput = {
    count: async () => 1,
    nth() { return this; },
    isVisible: async () => true,
    isEnabled: async () => true,
    click: async () => {},
    evaluate: async fn => fn.toString().includes('tagName.toLowerCase') ? 'input' : null,
    fill: async value => { titleValue = value; }
  };
  const captionInput = {
    count: async () => 1,
    nth() { return this; },
    isVisible: async () => true,
    isEnabled: async () => true,
    click: async () => {},
    evaluate: async fn => fn.toString().includes('tagName.toLowerCase') ? 'textarea' : null,
    fill: async value => { captionValue = value; }
  };
  const chooser = {
    setFiles: async value => {
      selectedPath = value;
      uploadStarted = true;
    }
  };
  const page = {
    frames: () => [page],
    waitForEvent: async event => event === 'filechooser' ? chooser : null,
    waitForTimeout: async () => {},
    bringToFront: async () => {},
    getByRole(_role, options = {}) {
      return options.name === '上传视频' ? uploadTrigger : absent();
    },
    getByText() { return absent(); },
    getByPlaceholder() { return absent(); },
    getByLabel() { return absent(); },
    locator(selector) {
      if (selector === 'body') {
        return { allInnerTexts: async () => [uploadStarted ? '上传中 1%' : '点击上传或直接将视频文件拖入此区域'] };
      }
      if (selector === 'input[placeholder*="标题"]') return titleInput;
      if (selector === 'textarea[placeholder*="简介"]') return captionInput;
      return absent();
    }
  };
  adapter.waitForUploadAndPublishReady = async () => ({ ready: true, stableReadySamples: 5 });

  const prepared = await adapter.prepareDraft(page, { title: '上传回归测试', body: '' }, materialPath);

  assert.equal(selectedPath, materialPath);
  assert.equal(triggerClicks, 1);
  assert.equal(titleValue, '上传回归测试');
  // 标题已经有独立输入框时，正文不应再次自动复制标题，避免标题被写进视频描述。\n  assert.equal(captionValue, null);
  assert.equal(prepared.materialAttachment.attached, true);
  assert.equal(prepared.materialAttachment.method, 'filechooser');
  assert.equal(prepared.materialAttachment.attachAttempts, 1);
});

test('constructor includes the current Douyin stack chat header selector', () => {
  const { adapter } = fixture();
  assert.ok(adapter.spec.privateConversationHeaderSelectors.includes('.StackLayoutStackChatHeadertitle'));
});

test('private conversation header accepts the current right-panel title above the editor', () => {
  const selected = selectPrivateConversationHeaderEvidence([{
    text: '- ??(?????)',
    className: 'StackLayoutStackChatHeadertitle',
    visible: true,
    insideConversationRow: false,
    configuredMatch: true,
    rect: { x: 1760, y: 48, width: 180, height: 28 }
  }], '- ??(?????)', { x: 1740, y: 780, width: 500, height: 120 });
  assert.equal(selected.ok, true);
  assert.equal(selected.headerName, '- ??(?????)');
});

test('private conversation header accepts emoji nickname exactly', () => {
  const selected = selectPrivateConversationHeaderEvidence([{
    text: '??????',
    className: 'RightPanelHeadertitle',
    visible: true,
    insideConversationRow: false,
    configuredMatch: true,
    rect: { x: 1760, y: 48, width: 140, height: 28 }
  }], '??????', { x: 1740, y: 780, width: 500, height: 120 });
  assert.equal(selected.ok, true);
  assert.equal(selected.headerName, '??????');
});

test('private conversation header rejects an exact nickname found only in the left list', () => {
  const selected = selectPrivateConversationHeaderEvidence([{
    text: '??????',
    className: 'conversationConversationItemtitle',
    visible: true,
    insideConversationRow: true,
    configuredMatch: false,
    rect: { x: 1310, y: 180, width: 140, height: 28 }
  }], '??????', { x: 1740, y: 780, width: 500, height: 120 });
  assert.equal(selected.ok, false);
  assert.equal(selected.reason, 'CONVERSATION_HEADER_MISMATCH');
});

test('private conversation header rejects duplicate equally reliable right-panel titles', () => {
  const selected = selectPrivateConversationHeaderEvidence([0, 1].map(index => ({
    text: 'alice',
    className: 'StackLayoutStackChatHeadertitle',
    visible: true,
    insideConversationRow: false,
    configuredMatch: true,
    rect: { x: 1760, y: 48 + index * 36, width: 140, height: 28 }
  })), 'alice', { x: 1740, y: 780, width: 500, height: 120 });
  assert.equal(selected.ok, false);
  assert.equal(selected.reason, 'CONVERSATION_HEADER_AMBIGUOUS');
});

test('private conversation header rejects a matching title outside the opened chat geometry', () => {
  const selected = selectPrivateConversationHeaderEvidence([{
    text: 'alice',
    className: 'StackLayoutStackChatHeadertitle',
    visible: true,
    insideConversationRow: false,
    configuredMatch: true,
    rect: { x: 200, y: 48, width: 140, height: 28 }
  }], 'alice', { x: 1740, y: 780, width: 500, height: 120 });
  assert.equal(selected.ok, false);
  assert.equal(selected.reason, 'CONVERSATION_HEADER_MISMATCH');
});

test('stopped execute is rejected before browser access', async () => {
  const { adapter } = fixture();
  let browserAccess = 0;
  adapter.getPage = async () => { browserAccess += 1; throw new Error('browser must not open'); };
  adapter.setRuntimeGuard(async () => { const error = new Error('stopped'); error.code = 'PLATFORM_OPERATION_CANCELLED'; throw error; });
  await assert.rejects(() => adapter.execute({ job_type: 'COLLECT_MESSAGES', payload: {} }), /stopped/);
  assert.equal(browserAccess, 0);
});

test('AUTO publish without management confirmation never clicks final submit', async () => {
  const { adapter, materialPath } = fixture();
  let clicks = 0;
  adapter.getPage = async () => evidencePage();
  adapter.waitForReady = async () => true;
  adapter.prepareDraft = async () => ({ prepared: true });
  adapter.clickFinalPublish = async () => { clicks += 1; return { clicked: true }; };
  const output = await adapter.publish({ materialPath, publishMode: 'AUTO', managementConfirmed: false });
  assert.equal(output.status, 'NEEDS_CONFIRMATION');
  assert.equal(output.result.finalActionAuthorized, false);
  assert.equal(clicks, 0);
});

test('publish succeeds only with a confirmed platform signal', async () => {
  const { adapter, materialPath } = fixture();
  adapter.getPage = async () => evidencePage();
  adapter.waitForReady = async () => true;
  adapter.prepareDraft = async () => ({ prepared: true });
  adapter.clickFinalPublish = async () => { adapter.douyinPublishAttempted = true; return { clicked: true, confirmation: 'NOT_PRESENT' }; };
  adapter.waitForPublishSignal = async () => ({ confirmed: true, urlMatched: true, textMatched: true });
  const output = await adapter.publish({ materialPath, publishMode: 'AUTO', managementConfirmed: true });
  assert.equal(output.status, 'SUCCESS');
  assert.equal(output.result.submissionStatus, 'SUBMITTED');
});

test('publish post-click uncertainty is NEEDS_CONFIRMATION and never retryable', async () => {
  const { adapter, materialPath } = fixture();
  adapter.getPage = async () => evidencePage();
  adapter.waitForReady = async () => true;
  adapter.prepareDraft = async () => ({ prepared: true });
  adapter.clickFinalPublish = async () => { adapter.douyinPublishAttempted = true; return { clicked: true, confirmation: 'NOT_PRESENT' }; };
  adapter.waitForPublishSignal = async () => { throw new Error('signal inspection failed'); };
  const output = await adapter.publish({ materialPath, publishMode: 'AUTO', managementConfirmed: true });
  assert.equal(output.status, 'NEEDS_CONFIRMATION');
  assert.equal(output.result.submissionStatus, 'UNKNOWN');
  assert.equal(output.result.doNotRetry, true);
  assert.equal(output.result.reason, 'publish_post_click_error');
});

test('comment target requires one exact user/content/time match', async () => {
  const { adapter } = fixture();
  const candidates = [
    { userName: 'alice', content: 'hello', eventTime: '10:01' },
    { userName: 'alice', content: 'hello', eventTime: '10:02' }
  ];
  const rows = {
    count: async () => candidates.length,
    nth(index) { return { candidate: candidates[index], isVisible: async () => true }; }
  };
  const page = { locator: () => rows };
  adapter.readDouyinCommentCandidate = async row => row.candidate;
  const payload = { messageType: 'COMMENT', userName: 'alice', sourceContent: 'hello', messageContext: { eventTime: '10:02' } };
  const exact = await adapter.locateMessageContainer(page, payload);
  assert.equal(exact.ok, true);
  assert.equal(exact.index, 1);
  candidates[0].eventTime = '10:02';
  const ambiguous = await adapter.locateMessageContainer(page, payload);
  assert.equal(ambiguous.ok, false);
  assert.equal(ambiguous.reason, 'COMMENT_TARGET_AMBIGUOUS');
});

test('comment identity tolerates only small forward drift in Douyin relative time', () => {
  const payload = {
    messageType: 'COMMENT',
    userName: '\u5496\u5561\u4e0d\u5609\ud83e\uddca',
    sourceContent: '\u793e\u533a\u670d\u52a1\u4e2d\u5fc3\u5468\u672b\u5f00\u653e\u5417?',
    messageContext: {
      eventTime: '18\u5206\u949f\u524d',
      commentFingerprint: 'stored-fingerprint'
    }
  };
  const drifted = matchDouyinCommentIdentity({
    userName: '\u5496\u5561\u4e0d\u5609\ud83e\uddca',
    content: '\u793e\u533a\u670d\u52a1\u4e2d\u5fc3\u5468\u672b\u5f00\u653e\u5417?',
    eventTime: '19\u5206\u949f\u524d'
  }, payload);
  assert.equal(drifted.matched, true);
  assert.equal(drifted.reason, 'COMMENT_IDENTITY_RELATIVE_TIME_DRIFT');

  const stale = matchDouyinCommentIdentity({
    userName: '\u5496\u5561\u4e0d\u5609\ud83e\uddca',
    content: '\u793e\u533a\u670d\u52a1\u4e2d\u5fc3\u5468\u672b\u5f00\u653e\u5417?',
    eventTime: '25\u5206\u949f\u524d'
  }, payload);
  assert.equal(stale.matched, false);
  assert.equal(stale.reason, 'COMMENT_TIME_MISMATCH');
});

test('comment locator reuses collection selectors and supports non-li cmt containers', async () => {
  const { adapter } = fixture();
  let usedSelector = '';
  const row = { candidate: { userName: 'alice', content: 'hello', eventTime: '18\u5206\u949f\u524d' }, isVisible: async () => true };
  const rows = { count: async () => 1, nth: () => row };
  const page = { locator(selector) { usedSelector = selector; return rows; } };
  adapter.readDouyinCommentCandidate = async locator => locator.candidate;
  const result = await adapter.locateMessageContainer(page, {
    messageType: 'COMMENT', userName: 'alice', sourceContent: 'hello', messageContext: { eventTime: '18\u5206\u949f\u524d' }
  });
  assert.equal(result.ok, true);
  assert.match(usedSelector, /\[class\*="cmt-li-"\]/);
  assert.doesNotMatch(usedSelector, /li\[class\*="cmt-li-"\]/);
});

test('comment target locator retries only transient not-found results', async () => {
  const { adapter } = fixture();
  let calls = 0;
  let waits = 0;
  const target = { marker: 'exact-target' };
  adapter.locateMessageContainer = async () => {
    calls += 1;
    return calls === 1
      ? { ok: false, reason: 'COMMENT_TARGET_NOT_FOUND', candidates: [] }
      : { ok: true, locator: target, identity: { matched: true } };
  };
  const result = await adapter.locateMessageContainerWithRetry({ waitForTimeout: async () => { waits += 1; } }, {
    messageType: 'COMMENT', userName: 'alice', sourceContent: 'hello'
  }, { attempts: 3, delayMs: 100 });
  assert.equal(result.ok, true);
  assert.equal(result.locator, target);
  assert.equal(result.locateAttempts, 2);
  assert.equal(waits, 1);
});

test('comment target locator scrolls historical rows before the second exact match', async () => {
  const { adapter } = fixture();
  let locateCalls = 0;
  let scrollCalls = 0;
  const target = { marker: 'historical-exact-target' };
  adapter.locateMessageContainer = async () => (++locateCalls === 1
    ? { ok: false, reason: 'COMMENT_TARGET_NOT_FOUND', candidates: [] }
    : { ok: true, locator: target, identity: { matched: true } });
  adapter.advanceHistoricalCommentList = async () => { scrollCalls += 1; return { attempted: true, moved: true, reason: 'SCROLLED_CONTAINER' }; };
  const result = await adapter.locateMessageContainerWithRetry({ waitForTimeout: async () => {} }, {
    messageType: 'COMMENT', userName: 'alice', sourceContent: 'historical comment'
  }, { attempts: 3, delayMs: 100 });
  assert.equal(result.ok, true);
  assert.equal(result.locator, target);
  assert.equal(result.locateAttempts, 2);
  assert.equal(result.historicalScan, true);
  assert.equal(scrollCalls, 1);
});

test('comment target locator does not retry ambiguous identity', async () => {
  const { adapter } = fixture();
  let calls = 0;
  let waits = 0;
  adapter.locateMessageContainer = async () => {
    calls += 1;
    return { ok: false, reason: 'COMMENT_TARGET_AMBIGUOUS' };
  };
  const result = await adapter.locateMessageContainerWithRetry({ waitForTimeout: async () => { waits += 1; } }, {
    messageType: 'COMMENT', userName: 'alice', sourceContent: 'hello'
  }, { attempts: 3, delayMs: 100 });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'COMMENT_TARGET_AMBIGUOUS');
  assert.equal(result.locateAttempts, 1);
  assert.equal(calls, 1);
  assert.equal(waits, 0);
});

test('comment editor is resolved only inside the exact target comment', async () => {
  const { adapter } = fixture();
  const editor = domLocator({ tagName: 'textarea', attributes: { placeholder: '\u6709\u7231\u8bc4\u8bba\uff0c\u8bf4\u70b9\u513f\u597d\u542c\u7684\uff5e' } });
  const editorRoot = {
    isVisible: async () => true,
    locator: () => locatorList([editor])
  };
  const targetComment = { locator: () => locatorList([editorRoot]) };
  const page = { locator: () => { throw new Error('page-wide editor lookup is forbidden'); } };
  const result = await adapter.findDouyinCommentEditor(page, { userName: 'alice' }, targetComment);
  assert.equal(result.ok, true);
  assert.equal(result.root, editorRoot);
  assert.equal(result.editor, editor);
});

test('comment editor rejects missing target scope and multiple local roots', async () => {
  const { adapter } = fixture();
  const page = { locator: () => missingLocator() };
  const missingScope = await adapter.findDouyinCommentEditor(page, { userName: 'alice' });
  assert.equal(missingScope.ok, false);
  assert.equal(missingScope.reason, 'COMMENT_EDITOR_SCOPE_MISSING');

  const rootA = { isVisible: async () => true };
  const rootB = { isVisible: async () => true };
  const targetComment = { locator: () => locatorList([rootA, rootB]) };
  const ambiguous = await adapter.findDouyinCommentEditor(page, { userName: 'alice' }, targetComment);
  assert.equal(ambiguous.ok, false);
  assert.equal(ambiguous.reason, 'COMMENT_EDITOR_ROOT_AMBIGUOUS');
  assert.equal(ambiguous.count, 2);
});

test('comment editor rejects two distinct editable controls in the target root', async () => {
  const { adapter } = fixture();
  const editorA = domLocator({ tagName: 'textarea', attributes: { placeholder: '\u6709\u7231\u8bc4\u8bba' } });
  const editorB = domLocator({ tagName: 'div', contentEditable: true });
  const editorRoot = { isVisible: async () => true, locator: () => locatorList([editorA, editorB]) };
  const targetComment = { locator: () => locatorList([editorRoot]) };
  const result = await adapter.findDouyinCommentEditor({}, { userName: 'alice' }, targetComment);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'COMMENT_EDITOR_CONTROL_AMBIGUOUS');
  assert.equal(result.count, 2);
});

test('comment send is scoped, unique and rechecks runtime immediately before click', async () => {
  const { adapter } = fixture();
  let clicks = 0;
  const send = domLocator({ tagName: 'button', className: 'abc-cmt-btn-active', text: '\u53d1\u9001' }, async () => { clicks += 1; });
  const cancel = domLocator({ tagName: 'button', className: 'abc-cmt-btn-active', text: '\u53d6\u6d88' });
  const root = { locator: () => locatorList([send, cancel]) };
  const sent = await adapter.clickDouyinCommentSend(root);
  assert.equal(sent.clicked, true);
  assert.equal(clicks, 1);

  adapter.setRuntimeGuard(async () => { throw new Error('stopped'); });
  await assert.rejects(() => adapter.clickDouyinCommentSend(root), /stopped/);
  assert.equal(clicks, 1);
});

test('comment send never escapes the verified editor root', async () => {
  const { adapter } = fixture();
  let outsideClicks = 0;
  const outside = domLocator({ tagName: 'button', className: 'cmt-btn-active', text: '\u53d1\u9001' }, async () => { outsideClicks += 1; });
  const page = { locator: () => locatorList([outside]) };
  const editorRoot = { locator: () => missingLocator() };
  const located = await adapter.findDouyinCommentSend(editorRoot, { requireEnabled: true });
  assert.equal(located.ok, false);
  assert.equal(located.reason, 'COMMENT_SEND_MISSING');
  assert.equal(outsideClicks, 0);
  assert.ok(page);
});

test('private preview with multiple unread is blocked before getPage', async () => {
  const { adapter } = fixture();
  let browserAccess = 0;
  adapter.getPage = async () => { browserAccess += 1; return {}; };
  const output = await adapter.replyToMessage({
    platformCode: 'douyin',
    accountId: 'test-account',
    messageType: 'PRIVATE_MESSAGE',
    replyText: 'answer',
    userName: 'alice',
    sourceContent: 'latest preview',
    messageContext: { conversationId: 'conversation-alice', messageId: 'message-preview', direction: 'incoming', previewOnly: true, unreadCount: 2, sourceVerified: true, chatTitleVerified: true }
  });
  assert.equal(output.status, 'NEEDS_CONFIRMATION');
  assert.equal(output.result.reason, 'reply_eligibility_blocked');
  assert.equal(output.result.eligibility.reason, 'SIDEBAR_PREVIEW_NOT_SENDABLE');
  assert.equal(browserAccess, 0);
});

test('Douyin private row falls back to exact DOM selectors while visible children are still loading', async () => {
  const { adapter } = fixture();
  adapter.spec.privateConversationNameSelectors = ['.conversationConversationItemtitle'];
  adapter.spec.privateConversationContentSelectors = ['pre.ConversationItemHinttextBox'];
  adapter.spec.privateUnreadSelectors = ['.unread-count'];
  const hiddenChild = {
    count: async () => 1,
    nth() { return this; },
    first() { return this; },
    isVisible: async () => false,
    innerText: async () => ''
  };
  const nodes = {
    '.conversationConversationItemtitle': { innerText: '咖啡不嘉🧊', textContent: '咖啡不嘉🧊' },
    'pre.ConversationItemHinttextBox': { innerText: '你好', textContent: '你好' },
    '.unread-count': { getClientRects: () => [{ width: 10, height: 10 }] }
  };
  const element = { querySelector: selector => nodes[selector] || null };
  const row = {
    isVisible: async () => true,
    locator: () => hiddenChild,
    evaluate: async (fn, options) => fn(element, options)
  };
  const previousGetComputedStyle = globalThis.getComputedStyle;
  globalThis.getComputedStyle = () => ({ display: 'block', visibility: 'visible', opacity: '1' });
  try {
    const snapshot = await adapter.readPrivateConversationRowSnapshot(row);
    assert.equal(snapshot.userName, '咖啡不嘉🧊');
    assert.equal(snapshot.preview, '你好');
    assert.equal(snapshot.unread, true);
    assert.ok(snapshot.readSources.includes('row-dom-selector-fallback'));
  } finally {
    if (previousGetComputedStyle === undefined) delete globalThis.getComputedStyle;
    else globalThis.getComputedStyle = previousGetComputedStyle;
  }
});

test('Douyin private list waits for two complete identical snapshots', async () => {
  const { adapter } = fixture();
  adapter.assertRuntimeAllowed = async () => {};
  adapter.spec.privateConversationListReadAttempts = 5;
  adapter.spec.privateConversationListStableSamples = 2;
  adapter.spec.privateConversationListSettleMs = 150;
  const snapshots = [
    { visible: true, userName: '', preview: '', unread: true },
    { visible: true, userName: 'alice', preview: 'question', unread: true },
    { visible: true, userName: 'alice', preview: 'question', unread: true }
  ];
  let reads = 0;
  adapter.readPrivateConversationRowSnapshot = async () => snapshots[Math.min(reads++, snapshots.length - 1)];
  const scope = { locator: () => locatorList([{}]), waitForTimeout: async () => {} };
  const result = await adapter.waitForPrivateConversationRows(scope, {
    userName: 'alice', sourceContent: 'question'
  }, { requireSourcePreview: true });
  assert.equal(result.stable, true);
  assert.equal(result.attempts, 3);
  assert.equal(result.stableSamples, 2);
  assert.equal(result.exactRows.length, 1);
});

test('Douyin private list never treats repeated empty child snapshots as loaded', async () => {
  const { adapter } = fixture();
  adapter.assertRuntimeAllowed = async () => {};
  adapter.spec.privateConversationListReadAttempts = 3;
  adapter.spec.privateConversationListStableSamples = 2;
  adapter.readPrivateConversationRowSnapshot = async () => ({ visible: true, userName: '', preview: '', unread: true });
  const scope = { locator: () => locatorList([{}]), waitForTimeout: async () => {} };
  const result = await adapter.waitForPrivateConversationRows(scope, {
    userName: 'alice', sourceContent: 'question'
  }, { requireSourcePreview: true });
  assert.equal(result.stable, false);
  assert.equal(result.deferred, true);
  assert.equal(result.reason, 'CONVERSATION_LIST_LOADING_TIMEOUT');
});

test('Douyin reply reuses the currently open verified conversation before scanning the virtualized list', async () => {
  const { adapter } = fixture();
  const page = { waitForTimeout: async () => {} };
  let listScans = 0;
  adapter.prepareMessagePage = async () => ({ action: 'already_on_target' });
  adapter.inspectLoginState = async () => ({ state: 'READY' });
  adapter.waitForMessageContentReady = async () => ({ ready: true, scope: page, pageCheck: { valid: true, reason: 'READY' } });
  adapter.inspectDouyinStrangerInboxView = async () => ({ signalVisible: false });
  adapter.revalidatePrivateReplyTarget = async () => ({
    ok: true,
    header: { ok: true, headerName: '咖啡不嘉🧊' },
    sourceMessageCount: 1,
    conversationId: 'conversation-coffee',
    messageId: 'message-hello',
    direction: 'incoming',
    sourceIsLatest: true,
    sourceMessage: { text: '你好啊', direction: 'incoming', conversationId: 'conversation-coffee', messageId: 'message-hello' },
    latestMessage: { text: '你好啊', direction: 'incoming', conversationId: 'conversation-coffee', messageId: 'message-hello' },
    timeline: { stable: true, messages: [{ text: '你好啊', direction: 'incoming', conversationId: 'conversation-coffee', messageId: 'message-hello' }] }
  });
  adapter.waitForPrivateConversationRows = async () => { listScans += 1; throw new Error('不应扫描左侧会话列表'); };

  const result = await adapter.openPrivateConversationForPayload(page, {
    userName: '咖啡不嘉🧊',
    sourceContent: '你好啊',
    messageContext: {
      inboxType: 'OPEN_CONVERSATION',
      collectionSource: 'OPEN_CONVERSATION_TIMELINE',
      conversationId: 'conversation-coffee',
      messageId: 'message-hello',
      direction: 'incoming'
    }
  }, { requireSourcePreview: true, requireUnreadEvidence: false });

  assert.equal(result.ok, true);
  assert.equal(result.reusedOpenConversation, true);
  assert.equal(result.conversationId, 'conversation-coffee');
  assert.equal(result.messageId, 'message-hello');
  assert.equal(listScans, 0);
});

test('Douyin private list accepts a unique exact name and preview when the row stable ID is unavailable', async () => {
  const { adapter } = fixture();
  adapter.readPrivateConversationRowSnapshot = async () => ({
    visible: true,
    userName: '咖啡不嘉🧊',
    preview: '你好啊',
    unread: false,
    conversationId: null
  });
  const scope = { locator: () => locatorList([{}]) };

  const result = await adapter.inspectPrivateConversationRows(scope, {
    userName: '咖啡不嘉🧊',
    sourceContent: '你好啊',
    messageContext: { conversationId: '0:1:107866855270:125779102156500' }
  }, { requireSourcePreview: true });

  assert.equal(result.namedRows.length, 1);
  assert.equal(result.exactRows.length, 1);
  assert.equal(result.exactRows[0].identity.reason, 'STABLE_ID_UNAVAILABLE_NAME_PREVIEW_EXACT');
  assert.equal(result.exactRows[0].identity.stableConversationIdUnavailable, true);
});

test('Douyin private list still rejects an explicitly different row stable ID', async () => {
  const { adapter } = fixture();
  adapter.readPrivateConversationRowSnapshot = async () => ({
    visible: true,
    userName: '咖啡不嘉🧊',
    preview: '你好啊',
    unread: false,
    conversationId: 'different-conversation'
  });
  const scope = { locator: () => locatorList([{}]) };

  const result = await adapter.inspectPrivateConversationRows(scope, {
    userName: '咖啡不嘉🧊',
    sourceContent: '你好啊',
    messageContext: { conversationId: '0:1:107866855270:125779102156500' }
  }, { requireSourcePreview: true });

  assert.equal(result.namedRows.length, 0);
  assert.equal(result.exactRows.length, 0);
});

test('Douyin reply may open the unique name-preview fallback only after final timeline identity verification', async () => {
  const { adapter } = fixture();
  let clicks = 0;
  const row = { click: async () => { clicks += 1; } };
  const page = { locator: () => locatorList([row]), waitForTimeout: async () => {} };
  adapter.prepareMessagePage = async () => ({ action: 'already_on_target' });
  adapter.inspectLoginState = async () => ({ state: 'READY' });
  adapter.waitForMessageContentReady = async () => ({ ready: true, scope: page, pageCheck: { valid: true, reason: 'READY' } });
  adapter.inspectDouyinStrangerInboxView = async () => ({ signalVisible: false });
  adapter.waitForPrivateConversationRows = async () => ({
    rowSelector: '[data-e2e="conversation-item"]',
    namedRows: [{ index: 0, candidate: { userName: '咖啡不嘉🧊', preview: '你好啊', unread: false, conversationId: null } }],
    exactRows: [{ index: 0, candidate: { userName: '咖啡不嘉🧊', preview: '你好啊', unread: false, conversationId: null }, identity: { matched: true, stableConversationIdUnavailable: true } }]
  });
  adapter.readPrivateConversationRowIdentity = async () => ({ conversationId: null, evidence: [] });
  adapter.waitForPrivateConversationHeader = async () => ({ ok: true, headerName: '咖啡不嘉🧊' });
  adapter.revalidatePrivateReplyTarget = async () => ({
    ok: true,
    header: { ok: true, headerName: '咖啡不嘉🧊' },
    sourceMessageCount: 1,
    conversationId: '0:1:107866855270:125779102156500',
    messageId: '6c57e755-e11e-45b4-bb94-27557d28c40f',
    direction: 'incoming',
    sourceIsLatest: true,
    sourceMessage: { text: '你好啊', direction: 'incoming', conversationId: '0:1:107866855270:125779102156500', messageId: '6c57e755-e11e-45b4-bb94-27557d28c40f' },
    latestMessage: { text: '你好啊', direction: 'incoming', conversationId: '0:1:107866855270:125779102156500', messageId: '6c57e755-e11e-45b4-bb94-27557d28c40f' },
    timeline: { stable: true, messages: [{ text: '你好啊', direction: 'incoming', conversationId: '0:1:107866855270:125779102156500', messageId: '6c57e755-e11e-45b4-bb94-27557d28c40f' }] }
  });

  const result = await adapter.openPrivateConversationForPayload(page, {
    userName: '咖啡不嘉🧊',
    sourceContent: '你好啊',
    messageContext: {
      inboxType: 'MAIN',
      conversationId: '0:1:107866855270:125779102156500',
      messageId: '6c57e755-e11e-45b4-bb94-27557d28c40f',
      direction: 'incoming'
    }
  }, { requireSourcePreview: true, requireUnreadEvidence: false });

  assert.equal(clicks, 1);
  assert.equal(result.ok, true);
  assert.equal(result.stableIdFallbackUsed, true);
  assert.equal(result.conversationId, '0:1:107866855270:125779102156500');
  assert.equal(result.messageId, '6c57e755-e11e-45b4-bb94-27557d28c40f');
  assert.equal(result.direction, 'incoming');
});

test('Douyin reply blocks a name-preview fallback when the opened timeline identity does not verify', async () => {
  const { adapter } = fixture();
  let clicks = 0;
  const row = { click: async () => { clicks += 1; } };
  const page = { locator: () => locatorList([row]), waitForTimeout: async () => {} };
  adapter.prepareMessagePage = async () => ({ action: 'already_on_target' });
  adapter.inspectLoginState = async () => ({ state: 'READY' });
  adapter.waitForMessageContentReady = async () => ({ ready: true, scope: page, pageCheck: { valid: true, reason: 'READY' } });
  adapter.inspectDouyinStrangerInboxView = async () => ({ signalVisible: false });
  adapter.waitForPrivateConversationRows = async () => ({
    rowSelector: '[data-e2e="conversation-item"]',
    namedRows: [{ index: 0, candidate: { userName: '咖啡不嘉🧊', preview: '你好啊', unread: false, conversationId: null } }],
    exactRows: [{ index: 0, candidate: { userName: '咖啡不嘉🧊', preview: '你好啊', unread: false, conversationId: null } }]
  });
  adapter.readPrivateConversationRowIdentity = async () => ({ conversationId: null, evidence: [] });
  adapter.waitForPrivateConversationHeader = async () => ({ ok: true, headerName: '咖啡不嘉🧊' });
  adapter.revalidatePrivateReplyTarget = async () => ({
    ok: false,
    reason: 'CONVERSATION_ID_MISMATCH',
    expectedConversationId: '0:1:107866855270:125779102156500',
    liveConversationId: 'different-conversation'
  });

  const result = await adapter.openPrivateConversationForPayload(page, {
    userName: '咖啡不嘉🧊',
    sourceContent: '你好啊',
    messageContext: {
      inboxType: 'MAIN',
      conversationId: '0:1:107866855270:125779102156500',
      messageId: '6c57e755-e11e-45b4-bb94-27557d28c40f',
      direction: 'incoming'
    }
  }, { requireSourcePreview: true, requireUnreadEvidence: false });

  assert.equal(clicks, 1);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'CONVERSATION_ID_MISMATCH');
  assert.equal(result.stableIdFallbackUsed, true);
});

test('Douyin private conversation rejects duplicate exact rows after the list stabilizes', async () => {
  const { adapter } = fixture();
  adapter.assertRuntimeAllowed = async () => {};
  adapter.spec.privateConversationListReadAttempts = 2;
  adapter.spec.privateConversationListStableSamples = 2;
  const rowItems = [{ index: 0 }, { index: 1 }];
  let clicks = 0;
  for (const row of rowItems) row.click = async () => { clicks += 1; };
  adapter.readPrivateConversationRowSnapshot = async () => ({ visible: true, userName: 'alice', preview: 'question', unread: true });
  const page = { locator: () => locatorList(rowItems), waitForTimeout: async () => {} };
  adapter.prepareMessagePage = async () => ({ action: 'already_on_target' });
  adapter.inspectLoginState = async () => ({ state: 'READY' });
  adapter.waitForMessageContentReady = async () => ({ ready: true, scope: page, pageCheck: { valid: true, reason: 'READY' } });
  adapter.inspectDouyinStrangerInboxView = async () => ({ signalVisible: false });
  const result = await adapter.openPrivateConversationForPayload(page, {
    userName: 'alice',
    sourceContent: 'question',
    messageContext: { unread: true }
  }, { requireSourcePreview: true, requireUnreadEvidence: true });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'CONVERSATION_TARGET_AMBIGUOUS');
  assert.equal(clicks, 0);
});

test('Douyin private conversation does not continue when a loaded preview changes before opening', async () => {
  const { adapter } = fixture();
  adapter.assertRuntimeAllowed = async () => {};
  adapter.spec.privateConversationListReadAttempts = 4;
  adapter.spec.privateConversationListStableSamples = 2;
  const snapshots = [
    { visible: true, userName: 'alice', preview: 'old question', unread: true },
    { visible: true, userName: 'alice', preview: 'new question', unread: true },
    { visible: true, userName: 'alice', preview: 'new question', unread: true }
  ];
  let reads = 0;
  let clicks = 0;
  adapter.readPrivateConversationRowSnapshot = async () => snapshots[Math.min(reads++, snapshots.length - 1)];
  const row = { click: async () => { clicks += 1; } };
  const page = { locator: () => locatorList([row]), waitForTimeout: async () => {} };
  adapter.prepareMessagePage = async () => ({ action: 'already_on_target' });
  adapter.inspectLoginState = async () => ({ state: 'READY' });
  adapter.waitForMessageContentReady = async () => ({ ready: true, scope: page, pageCheck: { valid: true, reason: 'READY' } });
  adapter.inspectDouyinStrangerInboxView = async () => ({ signalVisible: false });
  const result = await adapter.openPrivateConversationForPayload(page, {
    userName: 'alice',
    sourceContent: 'old question',
    messageContext: { unread: true }
  }, { requireSourcePreview: true, requireUnreadEvidence: true });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'SOURCE_PREVIEW_CHANGED');
  assert.deepEqual(result.previews, ['new question']);
  assert.equal(clicks, 0);
});

test('Douyin private list loading timeout is deferred without emitting an unverified message', async () => {
  const { adapter } = fixture();
  adapter.openPrivateConversationForPayload = async () => ({
    ok: false,
    deferred: true,
    reason: 'CONVERSATION_LIST_LOADING_TIMEOUT'
  });
  const result = await adapter.enrichDouyinUnreadPrivateMessages({}, [{
    userName: 'alice',
    content: 'question',
    externalUrl: 'https://www.douyin.com/user/self',
    context: { unread: true, unreadCount: 1 }
  }]);
  assert.deepEqual(result.messages, []);
  assert.equal(result.attemptedCount, 0);
  assert.equal(result.deferredCount, 1);
  assert.deepEqual(result.results, [{
    userName: 'alice',
    status: 'DEFERRED',
    reason: 'CONVERSATION_LIST_LOADING_TIMEOUT'
  }]);
});

test('Douyin returns from an open private conversation to the conversation overview first', async () => {
  const { adapter } = fixture();
  adapter.assertRuntimeAllowed = async () => {};
  adapter.spec.privateMessageEditorSelectors = ['.private-editor'];
  adapter.spec.privateConversationRowSelectors = ['[data-e2e="conversation-item"]'];
  adapter.spec.privateConversationBackSelectors = ['.private-back'];
  adapter.spec.privateMessageEntrySelectors = ['[data-e2e="im-entry"]'];
  let conversationOpen = true;
  let backClicks = 0;
  let entryClicks = 0;
  const dynamicEditor = {
    count: async () => conversationOpen ? 1 : 0,
    nth() { return this; },
    isVisible: async () => conversationOpen
  };
  const dynamicRows = {
    count: async () => conversationOpen ? 0 : 2,
    nth() {
      return {
        isVisible: async () => !conversationOpen
      };
    }
  };
  const back = usableLocator(async () => {
    backClicks += 1;
    conversationOpen = false;
  });
  const entry = usableLocator(async () => {
    entryClicks += 1;
    conversationOpen = false;
  });
  const page = {
    url: () => 'https://www.douyin.com/user/self',
    locator(selector) {
      if (selector === '.private-editor') return dynamicEditor;
      if (selector === '[data-e2e="conversation-item"]') return dynamicRows;
      if (selector === '.private-back') return back;
      if (selector === '[data-e2e="im-entry"]') return entry;
      return missingLocator();
    },
    waitForTimeout: async () => {}
  };

  const result = await adapter.restorePrivateInboxOverview(page, { source: 'TEST' });

  assert.equal(result.restored, true);
  assert.equal(result.overviewVisible, true);
  assert.equal(result.method, 'conversation-back');
  assert.equal(result.reason, 'PRIVATE_INBOX_OVERVIEW_RESTORED');
  assert.equal(backClicks, 1);
  assert.equal(entryClicks, 0);
});

test('Douyin closes the private panel through the trusted entry when no back control is available', async () => {
  const { adapter } = fixture();
  adapter.assertRuntimeAllowed = async () => {};
  adapter.spec.privateMessageEditorSelectors = ['.private-editor'];
  adapter.spec.privateMessageEntrySelectors = ['[data-e2e="im-entry"]'];
  let panelOpen = true;
  let entryClicks = 0;
  const dynamicEditor = {
    count: async () => panelOpen ? 1 : 0,
    nth() { return this; },
    isVisible: async () => panelOpen
  };
  const entry = usableLocator(async () => { entryClicks += 1; panelOpen = false; });
  const page = {
    locator(selector) {
      if (selector === '.private-editor') return dynamicEditor;
      if (selector === '[data-e2e="im-entry"]') return entry;
      return missingLocator();
    },
    waitForTimeout: async () => {}
  };
  const result = await adapter.afterPrivateReplyConfirmed(page);
  assert.equal(result.exited, true);
  assert.equal(result.reason, 'PRIVATE_MESSAGE_PANEL_CLOSED');
  assert.equal(result.method, 'panel-close-fallback');
  assert.equal(entryClicks, 1);
});

test('Douyin unread handoff only requires the red dot during first discovery', async () => {
  const { adapter } = fixture();
  let clicks = 0;
  const textLocator = (text, visible = true) => ({
    count: async () => visible ? 1 : 0,
    nth() { return this; },
    first() { return this; },
    isVisible: async () => visible,
    innerText: async () => text
  });
  const row = {
    isVisible: async () => true,
    locator(selector) {
      if ((adapter.spec.privateConversationNameSelectors || []).includes(selector)) return textLocator('alice');
      if ((adapter.spec.privateConversationContentSelectors || []).includes(selector)) return textLocator('question');
      if ((adapter.spec.privateUnreadSelectors || []).includes(selector)) return textLocator('', false);
      return textLocator('', false);
    },
    click: async () => { clicks += 1; }
  };
  const page = {
    locator: selector => selector === '[data-e2e="conversation-item"]'
      ? { count: async () => 1, nth: () => row }
      : missingLocator(),
    waitForTimeout: async () => {}
  };
  adapter.prepareMessagePage = async () => ({ action: 'already_on_target' });
  adapter.inspectLoginState = async () => ({ state: 'READY' });
  adapter.waitForMessageContentReady = async () => ({ ready: true, pageCheck: { valid: true, reason: 'READY' } });
  adapter.inspectDouyinStrangerInboxView = async () => ({ signalVisible: false });
  adapter.readPrivateConversationRowIdentity = async () => ({ conversationId: 'conversation-alice', evidence: 'test-row' });
  adapter.locatePrivateConversationHeader = async () => ({ ok: true, headerName: 'alice' });
  adapter.inspectPrivateConversationTimeline = async () => ({
    messages: [{ text: 'question', direction: 'incoming', messageId: 'message-question', conversationId: 'conversation-alice' }],
    latestMessage: { text: 'question', direction: 'incoming', messageId: 'message-question', conversationId: 'conversation-alice' }
  });

  const payload = {
    userName: 'alice',
    sourceContent: 'question',
    messageContext: { unread: true, conversationId: 'conversation-alice', messageId: 'message-question' }
  };
  const discovery = await adapter.openPrivateConversationForPayload(page, payload, {
    requireSourcePreview: true,
    requireUnreadEvidence: true
  });
  assert.equal(discovery.ok, false);
  assert.equal(discovery.reason, 'CONVERSATION_NO_LONGER_UNREAD');
  assert.equal(clicks, 0);

  const replyHandoff = await adapter.openPrivateConversationForPayload(page, payload, {
    requireSourcePreview: true,
    requireUnreadEvidence: false
  });
  assert.equal(replyHandoff.ok, true);
  assert.equal(replyHandoff.conversationId, 'conversation-alice');
  assert.equal(replyHandoff.messageId, 'message-question');
  assert.equal(replyHandoff.direction, 'incoming');
  assert.equal(clicks, 1);

  const stableBeforeSend = await adapter.revalidatePrivateReplyTarget(page, payload);
  assert.equal(stableBeforeSend.ok, true);
  assert.equal(stableBeforeSend.messageId, 'message-question');

  adapter.inspectPrivateConversationTimeline = async () => ({
    messages: [
      { text: 'question', direction: 'incoming', messageId: 'message-question', conversationId: 'conversation-alice' },
      { text: '人工已经回复', direction: 'outgoing', messageId: 'message-human-reply', conversationId: 'conversation-alice' }
    ],
    latestMessage: { text: '人工已经回复', direction: 'outgoing', messageId: 'message-human-reply', conversationId: 'conversation-alice' }
  });
  const changedBeforeSend = await adapter.revalidatePrivateReplyTarget(page, payload);
  assert.equal(changedBeforeSend.ok, false);
  assert.equal(changedBeforeSend.reason, 'SOURCE_MESSAGE_NOT_LATEST_IN_CONVERSATION');
});

test('Douyin unread enrichment explicitly requires unread evidence before entering a chat', async () => {
  const { adapter } = fixture();
  let receivedOptions = null;
  adapter.openPrivateConversationForPayload = async (_page, _payload, options) => {
    receivedOptions = options;
    return { ok: false, reason: 'TEST_STOP_AFTER_OPTION_CAPTURE' };
  };
  await adapter.enrichDouyinUnreadPrivateMessages({}, [{
    userName: 'alice',
    content: 'question',
    externalUrl: 'https://creator.douyin.com/creator-micro/data/im',
    context: { unread: true, unreadCount: 1, previewOnly: true }
  }]);
  assert.deepEqual(receivedOptions, { requireSourcePreview: true, requireUnreadEvidence: true });
});


function privateTimelineDomMessage({
  text,
  messageId,
  conversationId = 'conversation-visual-order',
  direction = 'incoming',
  x = direction === 'outgoing' ? 620 : 120,
  top = 100,
  width = 180,
  height = 40,
  style = null
}) {
  const rect = { x, y: top, top, right: x + width, bottom: top + height, width, height };
  const container = {
    className: `MessageItem ${direction === 'outgoing' ? 'right outgoing' : 'left incoming'}`,
    parentElement: null,
    __style: style,
    getAttribute(name) {
      if (name === 'data-message-id') return messageId || null;
      if (name === 'data-conversation-id') return conversationId || null;
      return null;
    },
    getClientRects: () => width > 0 && height > 0 ? [rect] : [],
    getBoundingClientRect: () => rect
  };
  const element = {
    innerText: text,
    textContent: text,
    parentElement: container,
    __style: style,
    getClientRects: () => width > 0 && height > 0 ? [rect] : [],
    closest(selector) {
      if (selector.includes('MessageItem') || selector.includes('listitem') || selector === 'li') return container;
      return null;
    }
  };
  return element;
}

test('Douyin private timeline extracts stable IDs and incoming direction from the selected chat bubble', async () => {
  const { adapter } = fixture();
  const previousGetComputedStyle = globalThis.getComputedStyle;
  globalThis.getComputedStyle = () => ({ display: 'block', visibility: 'visible', opacity: '1' });
  const container = {
    className: 'MessageItem left incoming',
    parentElement: null,
    getAttribute(name) {
      if (name === 'data-message-id') return 'message-9001';
      if (name === 'data-conversation-id') return 'conversation-1001';
      return null;
    },
    getClientRects: () => [{ x: 120, y: 240, width: 180, height: 44 }],
    getBoundingClientRect: () => ({ x: 120, y: 240, top: 240, right: 300, bottom: 284, width: 180, height: 44 })
  };
  const element = {
    innerText: '私信一般多久回复', textContent: '私信一般多久回复', parentElement: container,
    getClientRects: () => [{ x: 120, width: 180 }],
    closest(selector) {
      if (selector.includes('MessageItem') || selector.includes('listitem') || selector === 'li') return container;
      return null;
    }
  };
  const page = { locator: () => ({ evaluateAll: async (fn, options) => fn([element], options) }) };
  const editor = { boundingBox: async () => ({ x: 100, width: 800 }) };
  try {
    const result = await adapter.inspectPrivateConversationTimeline(page, { editor });
    assert.equal(result.messages.length, 1);
    assert.equal(result.latestMessage.direction, 'incoming');
    assert.equal(result.latestMessage.messageId, 'message-9001');
    assert.equal(result.latestMessage.conversationId, 'conversation-1001');
  } finally {
    globalThis.getComputedStyle = previousGetComputedStyle;
  }
});

test('Douyin private timeline reads React selfSend and stable messageKey from the real web IM shape', async () => {
  const { adapter } = fixture();
  const previousGetComputedStyle = globalThis.getComputedStyle;
  globalThis.getComputedStyle = () => ({ display: 'block', visibility: 'visible', opacity: '1' });
  const rowBox = {
    className: 'MessageBoxContentrowBox',
    parentElement: null,
    getAttribute: () => null,
    getClientRects: () => [{ x: 1285, y: 240, width: 520, height: 44 }],
    getBoundingClientRect: () => ({ x: 1285, y: 240, top: 240, right: 1805, bottom: 284, width: 520, height: 44 })
  };
  const container = {
    className: 'MessageItemTextcontainer',
    parentElement: rowBox,
    getAttribute: () => null,
    getClientRects: () => [{ x: 1301, y: 240, width: 146.4, height: 44 }],
    getBoundingClientRect: () => ({ x: 1301, y: 240, top: 240, right: 1447.4, bottom: 284, width: 146.4, height: 44 })
  };
  container['__reactProps$test'] = {
    children: {
      props: {
        conversationId: '0:1:conversation-real-shape',
        selfSend: false,
        messageKey: '381583ef-1df6-47b1-9570-af081dbe0ce0|peer|7'
      }
    }
  };
  const element = {
    innerText: '私信一般多久回复', textContent: '私信一般多久回复', parentElement: container,
    getClientRects: () => [{ x: 1313, width: 122 }],
    closest(selector) {
      if (selector.includes('MessageBoxContentrowBox')) return rowBox;
      if (selector.includes('MessageItem') || selector.includes('listitem') || selector === 'li') return container;
      return null;
    }
  };
  const page = { locator: () => ({ evaluateAll: async (fn, options) => fn([element], options) }) };
  const editor = { boundingBox: async () => ({ x: 1285, width: 146 }) };
  try {
    const result = await adapter.inspectPrivateConversationTimeline(page, { editor });
    assert.equal(result.messages.length, 1);
    assert.equal(result.latestMessage.direction, 'incoming');
    assert.equal(result.latestMessage.directionEvidence, 'react:selfSend');
    assert.equal(result.latestMessage.messageId, '381583ef-1df6-47b1-9570-af081dbe0ce0');
    assert.equal(result.latestMessage.messageIdEvidence, 'react:messageKey');
    assert.equal(result.latestMessage.conversationId, '0:1:conversation-real-shape');
  } finally {
    globalThis.getComputedStyle = previousGetComputedStyle;
  }
});


test('Douyin private timeline uses visual position instead of raw DOM order for the latest message', async () => {
  const { adapter } = fixture();
  const previousGetComputedStyle = globalThis.getComputedStyle;
  globalThis.getComputedStyle = node => node?.__style || ({ display: 'block', visibility: 'visible', opacity: '1' });
  const visuallyLatest = privateTimelineDomMessage({ text: '最新问题', messageId: 'message-latest', top: 420 });
  const earlierButLastInDom = privateTimelineDomMessage({ text: '较早消息', messageId: 'message-earlier', top: 180 });
  const page = { locator: () => ({ evaluateAll: async (fn, options) => fn([visuallyLatest, earlierButLastInDom], options) }) };
  const editor = { boundingBox: async () => ({ x: 80, y: 700, width: 760, height: 80 }) };
  try {
    const result = await adapter.inspectPrivateConversationTimeline(page, { editor });
    assert.deepEqual(result.messages.map(message => message.messageId), ['message-earlier', 'message-latest']);
    assert.equal(result.latestMessage.messageId, 'message-latest');
    assert.equal(result.latestMessage.bottom, 460);
  } finally {
    globalThis.getComputedStyle = previousGetComputedStyle;
  }
});

test('Douyin private timeline ignores hidden and zero-size trailing message nodes', async () => {
  const { adapter } = fixture();
  const previousGetComputedStyle = globalThis.getComputedStyle;
  globalThis.getComputedStyle = node => node?.__style || ({ display: 'block', visibility: 'visible', opacity: '1' });
  const realLatest = privateTimelineDomMessage({ text: '真实最新问题', messageId: 'message-real', top: 420 });
  const hiddenClone = privateTimelineDomMessage({ text: '隐藏克隆', messageId: 'message-hidden', top: 900, style: { display: 'none', visibility: 'visible', opacity: '1' } });
  const zeroSizeClone = privateTimelineDomMessage({ text: '零尺寸克隆', messageId: 'message-zero', top: 960, width: 0, height: 0 });
  const page = { locator: () => ({ evaluateAll: async (fn, options) => fn([realLatest, hiddenClone, zeroSizeClone], options) }) };
  const editor = { boundingBox: async () => ({ x: 80, y: 700, width: 760, height: 80 }) };
  try {
    const result = await adapter.inspectPrivateConversationTimeline(page, { editor });
    assert.equal(result.messages.length, 1);
    assert.equal(result.latestMessage.messageId, 'message-real');
  } finally {
    globalThis.getComputedStyle = previousGetComputedStyle;
  }
});

test('Douyin private timeline deduplicates repeated DOM nodes by stable message ID', async () => {
  const { adapter } = fixture();
  const previousGetComputedStyle = globalThis.getComputedStyle;
  globalThis.getComputedStyle = node => node?.__style || ({ display: 'block', visibility: 'visible', opacity: '1' });
  const firstClone = privateTimelineDomMessage({ text: '重复问题', messageId: 'message-duplicate', top: 410 });
  const secondClone = privateTimelineDomMessage({ text: '重复问题', messageId: 'message-duplicate', top: 412 });
  const page = { locator: () => ({ evaluateAll: async (fn, options) => fn([firstClone, secondClone], options) }) };
  const editor = { boundingBox: async () => ({ x: 80, y: 700, width: 760, height: 80 }) };
  try {
    const result = await adapter.inspectPrivateConversationTimeline(page, { editor });
    assert.equal(result.rawMessageCount, 2);
    assert.equal(result.deduplicatedMessageCount, 1);
    assert.equal(result.latestMessage.messageId, 'message-duplicate');
    assert.equal(result.latestMessage.top, 412);
  } finally {
    globalThis.getComputedStyle = previousGetComputedStyle;
  }
});

test('Douyin private timeline waits for two identical snapshots before accepting the latest bubble', async () => {
  const { adapter } = fixture();
  const snapshots = [
    { messages: [{ text: '旧快照', direction: 'incoming', messageId: 'message-old', top: 100, bottom: 140 }], latestMessage: { text: '旧快照', direction: 'incoming', messageId: 'message-old', top: 100, bottom: 140 } },
    { messages: [{ text: '最新问题', direction: 'incoming', messageId: 'message-new', top: 200, bottom: 240 }], latestMessage: { text: '最新问题', direction: 'incoming', messageId: 'message-new', top: 200, bottom: 240 } },
    { messages: [{ text: '最新问题', direction: 'incoming', messageId: 'message-new', top: 200, bottom: 240 }], latestMessage: { text: '最新问题', direction: 'incoming', messageId: 'message-new', top: 200, bottom: 240 } }
  ];
  let reads = 0;
  let waits = 0;
  adapter.inspectPrivateConversationTimeline = async () => snapshots[Math.min(reads++, snapshots.length - 1)];
  const result = await adapter.inspectStablePrivateConversationTimeline({ waitForTimeout: async () => { waits += 1; } });
  assert.equal(result.stable, true);
  assert.equal(result.attempts, 3);
  assert.equal(result.latestMessage.messageId, 'message-new');
  assert.equal(reads, 3);
  assert.equal(waits, 2);
});

test('private exact-message counting tolerates an empty optional container selector', async () => {
  const { adapter } = fixture();
  const previousGetComputedStyle = globalThis.getComputedStyle;
  globalThis.getComputedStyle = () => ({ display: 'block', visibility: 'visible', opacity: '1' });
  const container = {
    getBoundingClientRect: () => ({ x: 1760, width: 220 }),
    className: 'MessageItemTextcontainer'
  };
  const element = {
    innerText: '??????????????',
    textContent: '??????????????',
    getClientRects: () => [{ x: 1760 }],
    closest(selector) {
      if (!selector) throw new Error('empty selector must not reach Element.closest');
      return selector.includes('MessageItemTextcontainer') ? container : null;
    }
  };
  const page = {
    locator: () => ({ evaluateAll: async (fn, options) => fn([element], options) })
  };
  try {
    const result = await adapter.countExactPrivateMessages(page, '??????????????');
    assert.equal(result.count, 1);
  } finally {
    globalThis.getComputedStyle = previousGetComputedStyle;
  }
});

test('private send uses only local .e2e-send-msg-btn and checks runtime', async () => {
  const { adapter } = fixture();
  let clicks = 0;
  const send = usableLocator(async () => { clicks += 1; });
  const row = { count: async () => 1, locator: selector => selector === '.e2e-send-msg-btn' ? send : missingLocator() };
  const editor = { locator: () => row };
  const result = await adapter.clickPrivateSend({}, editor);
  assert.equal(result.clicked, true);
  assert.equal(clicks, 1);
  assert.equal(adapter.douyinReplyAttempted, true);

  adapter.setRuntimeGuard(async () => { throw new Error('stopped'); });
  await assert.rejects(() => adapter.clickPrivateSend({}, editor), /stopped/);
  assert.equal(clicks, 1);
});

test('private post-click verification error becomes non-retryable uncertainty', async () => {
  const { adapter } = fixture();
  let value = '';
  const page = {};
  const editor = {
    click: async () => {},
    evaluate: async () => 'textarea',
    fill: async input => { value = input; },
    inputValue: async () => value,
    boundingBox: async () => null
  };
  adapter.getPage = async () => page;
  adapter.channelPages.set('PRIVATE_MESSAGE', page);
  adapter.openPrivateConversationForPayload = async () => ({ ok: true });
  adapter.revalidatePrivateReplyTarget = async () => ({ ok: true });
  adapter.findReplyEditor = async () => editor;
  adapter.countExactPrivateMessages = async () => ({ count: 0, matches: [] });
  adapter.clickPrivateSend = async () => { adapter.douyinReplyAttempted = true; throw new Error('echo inspection disconnected'); };
  let exitCalls = 0;
  let finalRestoreCalls = 0;
  adapter.afterPrivateReplyConfirmed = async () => { exitCalls += 1; return { attempted: true, exited: true }; };
  adapter.restorePrivateInboxOverview = async (restoredPage, options) => {
    assert.equal(restoredPage, page);
    assert.equal(options.source, 'PRIVATE_REPLY_FINALLY');
    finalRestoreCalls += 1;
    return { attempted: true, restored: true, exited: true, overviewVisible: true, reason: 'PRIVATE_INBOX_OVERVIEW_RESTORED' };
  };
  const output = await adapter.replyToMessage({
    platformCode: 'douyin',
    accountId: 'test-account',
    messageType: 'PRIVATE_MESSAGE',
    replyText: 'answer',
    userName: 'alice',
    sourceContent: 'question',
    messageContext: { conversationId: 'conversation-alice', messageId: 'message-question', direction: 'incoming', previewOnly: false, sourceVerified: true, chatTitleVerified: true }
  });
  assert.equal(output.status, 'NEEDS_CONFIRMATION');
  assert.equal(output.result.reason, 'reply_post_click_error');
  assert.equal(output.result.doNotRetry, true);
  assert.equal(output.result.submissionStatus, 'UNKNOWN');
  assert.equal(exitCalls, 0);
  assert.equal(finalRestoreCalls, 1);
  assert.equal(output.result.postReplyExit.reason, 'PRIVATE_INBOX_OVERVIEW_RESTORED');
});


test('comment reply succeeds only after a new exact echo in the target thread', async () => {
  const { adapter } = fixture();
  let value = '';
  let echoChecks = 0;
  const editor = {
    click: async () => {},
    evaluate: async () => 'textarea',
    fill: async input => { value = input; },
    inputValue: async () => value
  };
  const replyTrigger = usableLocator(async () => {});
  const container = {
    getByText: () => replyTrigger,
    getByRole: () => missingLocator(),
    locator: () => missingLocator()
  };
  const page = { goto: async () => {}, waitForTimeout: async () => {} };
  adapter.getPage = async () => page;
  adapter.detectPageState = async () => 'READY';
  adapter.waitForMessageContentReady = async () => ({ ready: true });
  adapter.locateMessageContainer = async () => ({ ok: true, locator: container, identity: { matched: true }, index: 0 });
  adapter.readDouyinCommentCandidate = async () => ({ userName: 'alice', content: 'question', eventTime: '10:00', commentStableId: 'comment-A', sourceVideoKey: 'video-A' });
  let editorScope = null;
  adapter.findDouyinCommentEditor = async (_page, _payload, scope) => { editorScope = scope; return { ok: true, root: container, editor }; };
  adapter.countExactCommentEchoes = async () => { echoChecks += 1; return echoChecks < 3 ? 0 : 1; };
  let sendClicks = 0;
  adapter.clickDouyinCommentSend = async () => { sendClicks += 1; adapter.douyinReplyAttempted = true; value = ''; return { clicked: true, method: 'comment-editor-scoped-send' }; };
  adapter.waitForReplyEvidence = async check => check();
  const output = await adapter.replyToMessage({
    platformCode: 'douyin',
    accountId: 'test-account',
    messageType: 'COMMENT',
    replyText: 'answer',
    userName: 'alice',
    sourceContent: 'question',
    messageContext: { eventTime: '10:00', postId: 'video-A', commentId: 'comment-A', sourceVerified: true }
  });
  assert.equal(output.status, 'SUCCESS');
  assert.equal(editorScope, container);
  assert.equal(output.result.scopedEchoCount, 1);
  assert.equal(output.result.baselineEchoCount, 0);
  assert.equal(sendClicks, 1);
});

test('comment reply skips send when the exact reply already exists in the target thread', async () => {
  const { adapter } = fixture();
  let triggerClicks = 0;
  let sendClicks = 0;
  const replyTrigger = usableLocator(async () => { triggerClicks += 1; });
  const container = {
    getByText: () => replyTrigger,
    getByRole: () => missingLocator(),
    locator: () => missingLocator()
  };
  const page = { goto: async () => {}, waitForTimeout: async () => {} };
  adapter.getPage = async () => page;
  adapter.detectPageState = async () => 'READY';
  adapter.waitForMessageContentReady = async () => ({ ready: true });
  adapter.locateMessageContainer = async () => ({ ok: true, locator: container, identity: { matched: true }, index: 0 });
  adapter.countExactCommentEchoes = async () => 1;
  adapter.clickDouyinCommentSend = async () => { sendClicks += 1; return { clicked: true }; };
  const output = await adapter.replyToMessage({
    platformCode: 'douyin', accountId: 'test-account', messageType: 'COMMENT', replyText: 'answer', userName: 'alice', sourceContent: 'question', messageContext: { eventTime: '10:00', postId: 'video-A', commentId: 'comment-A', sourceVerified: true }
  });
  assert.equal(output.status, 'SUCCESS');
  assert.equal(output.result.reason, 'reply_already_replied');
  assert.equal(output.result.alreadyReplied, true);
  assert.equal(output.result.sent, false);
  assert.equal(triggerClicks, 0);
  assert.equal(sendClicks, 0);
});

test('comment reply skips send when an existing exact reply appears after opening the target thread', async () => {
  const { adapter } = fixture();
  let checks = 0;
  let sendClicks = 0;
  const replyTrigger = usableLocator();
  const container = { getByText: () => replyTrigger, getByRole: () => missingLocator(), locator: () => missingLocator() };
  const editor = { click: async () => {}, evaluate: async () => 'textarea', fill: async () => {}, inputValue: async () => '' };
  const page = { goto: async () => {}, waitForTimeout: async () => {} };
  adapter.getPage = async () => page;
  adapter.detectPageState = async () => 'READY';
  adapter.waitForMessageContentReady = async () => ({ ready: true });
  adapter.locateMessageContainer = async () => ({ ok: true, locator: container, identity: { matched: true }, index: 0 });
  adapter.readDouyinCommentCandidate = async () => ({ userName: 'alice', content: 'question', eventTime: '10:00', commentStableId: 'comment-A', sourceVideoKey: 'video-A' });
  adapter.findDouyinCommentEditor = async () => ({ ok: true, root: container, editor });
  adapter.countExactCommentEchoes = async () => { checks += 1; return checks === 1 ? 0 : 1; };
  adapter.clickDouyinCommentSend = async () => { sendClicks += 1; return { clicked: true }; };
  const output = await adapter.replyToMessage({
    platformCode: 'douyin', accountId: 'test-account', messageType: 'COMMENT', replyText: 'answer', userName: 'alice', sourceContent: 'question', messageContext: { eventTime: '10:00', postId: 'video-A', commentId: 'comment-A', sourceVerified: true }
  });
  assert.equal(output.status, 'SUCCESS');
  assert.equal(output.result.reason, 'reply_already_replied');
  assert.equal(output.result.alreadyReplied, true);
  assert.equal(sendClicks, 0);
});


test('comment collection keeps externalId stable when only relative time changes', async () => {
  const { adapter } = fixture();
  const collect = async row => adapter.extractMessages({
    url: () => 'https://creator.douyin.com/creator-micro/interaction/comment',
    locator: () => ({ evaluateAll: async () => [row] })
  }, 'COMMENT', { noteCandidates: [] });

  const first = await collect({
    index: 0, text: 'douyin-userdouyin-user', userName: 'douyin-user', eventTime: '4\u5206\u949f\u524d',
    commentStableId: 'comment-1001', sourceVideoKey: 'video-A', containerClassName: 'cmt-li-test'
  });
  const later = await collect({
    index: 0, text: 'douyin-userdouyin-user', userName: 'douyin-user', eventTime: '17\u5206\u949f\u524d',
    commentStableId: 'comment-1001', sourceVideoKey: 'video-A', containerClassName: 'cmt-li-test'
  });
  const otherComment = await collect({
    index: 1, text: 'douyin-userdouyin-user', userName: 'douyin-user', eventTime: '17\u5206\u949f\u524d',
    commentStableId: 'comment-2002', sourceVideoKey: 'video-A', containerClassName: 'cmt-li-test'
  });

  assert.equal(first.length, 1);
  assert.equal(first[0].externalId, later[0].externalId);
  assert.notEqual(first[0].externalId, otherComment[0].externalId);
  assert.equal(first[0].context.commentStableId, 'comment-1001');
  assert.equal(first[0].context.sourceVideoKey, 'video-A');
});

test('Douyin comment reply ignores a stale private-message URL and blocks an unverified comment page', async () => {
  const { adapter } = fixture();
  let navigatedTo = '';
  let locateCalls = 0;
  const page = {
    goto: async url => { navigatedTo = url; },
    url: () => navigatedTo,
    waitForTimeout: async () => {},
    locator: () => missingLocator()
  };
  adapter.getPage = async () => page;
  adapter.waitForDetectedPageState = async () => 'READY';
  adapter.waitForMessageContentReady = async () => ({ ready: true, pageCheck: { valid: false, reason: 'URL_MISMATCH' } });
  adapter.locateMessageContainerWithRetry = async () => { locateCalls += 1; return { ok: false }; };
  const output = await adapter.replyToMessage({
    platformCode: 'douyin', accountId: 'test-account', messageType: 'COMMENT', replyText: 'answer', userName: 'alice', sourceContent: 'question',
    externalUrl: 'https://www.douyin.com/user/self', messageContext: { eventTime: '10:00', postId: 'video-A', commentId: 'comment-A', sourceVerified: true }
  });
  assert.equal(navigatedTo, adapter.spec.commentUrl);
  assert.equal(output.status, 'NEEDS_CONFIRMATION');
  assert.equal(output.result.reason, 'reply_comment_page_mismatch');
  assert.equal(locateCalls, 0);
});

test('private reply succeeds only after editor clear and a new outgoing exact bubble', async () => {
  const { adapter } = fixture();
  let value = '';
  let echoChecks = 0;
  const editor = {
    click: async () => {},
    evaluate: async () => 'textarea',
    fill: async input => { value = input; },
    inputValue: async () => value,
    boundingBox: async () => null
  };
  let receivedOpenOptions = null;
  adapter.getPage = async () => ({});
  adapter.openPrivateConversationForPayload = async (_page, _payload, options) => {
    receivedOpenOptions = options;
    return { ok: true, conversationName: 'alice', headerName: 'alice', sourceMessageCount: 1 };
  };
  adapter.revalidatePrivateReplyTarget = async () => ({ ok: true });
  adapter.findReplyEditor = async () => editor;
  adapter.countExactPrivateMessages = async () => { echoChecks += 1; return { count: echoChecks === 1 ? 0 : 1, matches: [] }; };
  adapter.clickPrivateSend = async () => { adapter.douyinReplyAttempted = true; value = ''; return { clicked: true, method: 'scoped-selector:.e2e-send-msg-btn' }; };
  adapter.waitForReplyEvidence = async check => check();
  let exitCalls = 0;
  adapter.afterPrivateReplyConfirmed = async () => {
    exitCalls += 1;
    return { attempted: true, exited: false, reason: 'PRIVATE_MESSAGE_PANEL_STILL_OPEN' };
  };
  const output = await adapter.replyToMessage({
    platformCode: 'douyin',
    accountId: 'test-account',
    messageType: 'PRIVATE_MESSAGE',
    replyText: 'answer',
    userName: 'alice',
    sourceContent: 'question',
    messageContext: { conversationId: 'conversation-alice', messageId: 'message-question', direction: 'incoming', previewOnly: false, sourceVerified: true, chatTitleVerified: true }
  });
  assert.equal(output.status, 'SUCCESS');
  assert.equal(output.result.editorCleared, true);
  assert.equal(output.result.scopedEchoCount, 1);
  assert.equal(output.result.baselineEchoCount, 0);
  assert.deepEqual(receivedOpenOptions, { requireSourcePreview: true, requireUnreadEvidence: false });
  assert.equal(exitCalls, 1);
  assert.equal(output.result.postReplyExit.exited, false);
  assert.equal(output.result.postReplyExit.reason, 'PRIVATE_MESSAGE_PANEL_STILL_OPEN');
});


test('Douyin comment extraction reads comment_id and item_id_plain from React fiber props', async () => {
  const { adapter } = fixture();
  const textNode = value => ({ innerText: value, textContent: value, getAttribute: () => null });
  const nodes = {
    [adapter.spec.commentTextSelector]: textNode('React fiber question'),
    [adapter.spec.commentNameSelector]: textNode('fiber-user'),
    [adapter.spec.commentTimeSelector]: textNode('3分钟前')
  };
  const row = {
    className: 'cmt-li-react-fixture',
    parentElement: null,
    innerText: 'fiber-user React fiber question 3分钟前',
    textContent: 'fiber-user React fiber question 3分钟前',
    getClientRects: () => [{ width: 100, height: 20 }],
    getAttribute: () => null,
    closest: () => null,
    querySelector: selector => selector === 'a[href]' ? null : (nodes[selector] || null)
  };
  row.__reactFiber$unit = {
    memoizedProps: {
      commentInfo: { comment_id: 'comment-react-1001' },
      itemInfo: { item_id_plain: 'video-react-9001' }
    },
    return: null
  };
  const previousGetComputedStyle = globalThis.getComputedStyle;
  globalThis.getComputedStyle = () => ({ display: 'block', visibility: 'visible', opacity: '1' });
  try {
    const page = {
      url: () => 'https://creator.douyin.com/creator-micro/data/following/comment',
      locator: () => ({ evaluateAll: async (fn, options) => fn([row], options) })
    };
    const messages = await adapter.extractMessages(page, 'COMMENT', { noteCandidates: [] });
    assert.equal(messages.length, 1);
    assert.equal(messages[0].context.commentStableId, 'comment-react-1001');
    assert.equal(messages[0].context.sourceVideoKey, 'video-react-9001');
    assert.equal(messages[0].context.sourceVerified, true);
  } finally {
    if (previousGetComputedStyle === undefined) delete globalThis.getComputedStyle;
    else globalThis.getComputedStyle = previousGetComputedStyle;
  }
});

test('Douyin multi-work historical scan continues after one work disappears', async () => {
  const { adapter } = fixture();
  const openedWorkKeys = [];
  const collectedWorkKeys = [];
  adapter.inspectDouyinCommentVideos = async () => ({
    ok: true,
    reason: 'VIDEO_LIST_STABLE',
    videos: [
      { sourceVideoKey: 'video-A', sourceVideoTitle: 'work A' },
      { sourceVideoKey: 'video-B', sourceVideoTitle: 'deleted work' },
      { sourceVideoKey: 'video-C', sourceVideoTitle: 'work C' }
    ]
  });
  adapter.openDouyinCommentVideoByKey = async (_page, sourceVideoKey) => {
    openedWorkKeys.push(sourceVideoKey);
    if (sourceVideoKey === 'video-B') {
      return { ok: false, reason: 'DOUYIN_SOURCE_VIDEO_NOT_FOUND', sourceGone: true };
    }
    return { ok: true, video: { sourceVideoKey } };
  };
  adapter.extractMessages = async (_page, _type, _payload, options) => {
    const sourceVideoKey = options.sourceContext.sourceVideoKey;
    collectedWorkKeys.push(sourceVideoKey);
    return [{ externalId: `comment-${sourceVideoKey}`, context: { ...options.sourceContext } }];
  };
  const result = await adapter.collectHistoricalCommentMessages(
    { waitForTimeout: async () => {} },
    {},
    { maxRounds: 1, settleMs: 0 }
  );
  assert.deepEqual(openedWorkKeys, ['video-A', 'video-B', 'video-C']);
  assert.deepEqual(collectedWorkKeys, ['video-A', 'video-C']);
  assert.deepEqual(result.messages.map(message => message.context.sourceVideoKey), ['video-A', 'video-C']);
  assert.deepEqual(result.videoResults.map(item => [item.sourceVideoKey, item.status, item.sourceGone === true]), [
    ['video-A', 'SUCCESS', false],
    ['video-B', 'SKIPPED', true],
    ['video-C', 'SUCCESS', false]
  ]);
});

test('Douyin comment reply opens the work identified by sourceVideoKey before locating the comment', async () => {
  const { adapter } = fixture();
  const calls = [];
  const page = {
    goto: async () => { calls.push('goto-comment-page'); },
    url: () => adapter.spec.commentUrl,
    waitForTimeout: async () => {},
    locator: () => missingLocator()
  };
  adapter.getPage = async () => page;
  adapter.waitForDetectedPageState = async () => 'READY';
  adapter.waitForMessageContentReady = async () => ({ ready: true, pageCheck: { valid: true, reason: 'VERIFIED_COMMENT_PAGE' } });
  adapter.openDouyinCommentVideoForPayload = async (_page, payload) => {
    calls.push(`open-work:${payload.messageContext.sourceVideoKey}`);
    return { ok: true, sourceContext: { sourceVideoKey: payload.messageContext.sourceVideoKey, sourceVerified: true } };
  };
  adapter.locateMessageContainerWithRetry = async () => {
    calls.push('locate-comment');
    return { ok: false, reason: 'COMMENT_TARGET_NOT_FOUND' };
  };
  const output = await adapter.replyToMessage({
    platformCode: 'douyin',
    accountId: 'test-account',
    messageType: 'COMMENT',
    replyText: 'answer',
    userName: 'alice',
    sourceContent: 'question',
    messageContext: {
      eventTime: '3分钟前',
      commentStableId: 'comment-1001',
      sourceVideoKey: 'video-9001',
      sourceVerified: true
    }
  });
  assert.equal(output.status, 'NEEDS_CONFIRMATION');
  assert.deepEqual(calls, ['goto-comment-page', 'open-work:video-9001', 'locate-comment']);
});

test('Douyin verified comment identity satisfies the autonomous reply send gate', () => {
  const result = assessAutoReplyEligibility({
    platformCode: 'douyin',
    accountId: 'test-account',
    messageType: 'COMMENT',
    userName: 'alice',
    sourceContent: 'question',
    messageContext: {
      commentStableId: 'comment-1001',
      sourceVideoKey: 'video-9001',
      sourceVerified: true
    }
  }, { phase: 'send' });
  assert.equal(result.allowed, true);
  assert.equal(result.reason, 'DETERMINISTIC_TARGET_VERIFIED');
  assert.deepEqual(result.target, {
    kind: 'COMMENT',
    platformCode: 'douyin',
    accountId: 'test-account',
    postId: 'video-9001',
    commentId: 'comment-1001',
    sourceTextHash: result.target.sourceTextHash
  });
});
