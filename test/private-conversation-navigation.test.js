import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { DouyinAssistedRpaAdapter } from '../agent/rpa-adapters/douyin-assisted.js';
import { AssistedPlatformRpaAdapter } from '../agent/rpa-adapters/assisted-platform.js';

const chromePath = [
  process.env.CHROME_EXECUTABLE_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium'
].filter(Boolean).find(candidate => fs.existsSync(candidate));
const conversationId = '0:1:100000000000:200000000000';
const messageId = 'fixture-message-alice';
const payload = {
  userName: 'alice', sourceContent: '澳门车可以在内地停留多久？',
  messageContext: { inboxType: 'MAIN', conversationId, messageId, direction: 'incoming' }
};

test('shared row identity excludes a common app container and keeps identities local to each row', async () => {
  const adapter = Object.create(AssistedPlatformRpaAdapter.prototype);
  adapter.spec = { privateConversationRowSelectors: ['.row'] };
  const app = { getAttribute: name => name === 'id' ? 'app' : null, parentElement: null };
  const row = attributes => ({
    getAttribute: name => attributes[name] || null, parentElement: app,
    querySelectorAll: () => []
  });
  const read = element => adapter.readPrivateConversationRowIdentity({ evaluate: (fn, arg) => Promise.resolve(fn(element, arg)) });
  assert.equal((await read(row({}))).conversationId, null);
  assert.equal((await read(row({ id: 'row-0', 'data-id': 'display-index-0' }))).conversationId, null);
  assert.equal((await read(row({ 'data-conversation-id': 'conversation-alice' }))).conversationId, 'conversation-alice');
  assert.equal((await read(row({ 'data-conversation-id': 'conversation-bob' }))).conversationId, 'conversation-bob');
  app.getAttribute = name => name === 'data-conversation-id' ? 'currently-selected-chat' : null;
  app.querySelectorAll = () => [{}, {}];
  assert.equal((await read(row({}))).conversationId, null);
});

async function fixture(t, { open = 'alice', blockedBack = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'private-navigation-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const browser = await chromium.launch({ executablePath: chromePath, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  page.setDefaultTimeout(700);
  await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: `
    <meta charset="utf-8"><style>
      .row { width: 260px; height: 75px; }
      #chat { position: fixed; inset: 0 auto auto 0; width: 360px; height: 400px; background: white; }
      .chat-title { margin: 10px 0 180px; }
      [contenteditable] { width: 330px; height: 40px; }
    </style>
    <div id="rows">
      <div class="row" data-e2e="conversation-item" data-conversation-id="${conversationId}"><span class="name">alice</span><span class="preview">${payload.sourceContent}</span></div>
      <div class="row" data-e2e="conversation-item" data-conversation-id="0:1:100000000000:300000000000"><span class="name">bob</span><span class="preview">another question</span></div>
    </div>
    <section id="chat" data-stack-layer="chat" hidden>
      <button id="back">返回</button><div class="chat-title"></div>
      <div class="bubble"></div><div contenteditable="true"></div>
    </section>
    <script>
      window.rowClicks = []; window.backClicks = 0;
      const rows = document.querySelectorAll('.row');
      const chat = document.querySelector('#chat');
      function openRow(row) {
        chat.hidden = false;
        chat.dataset.conversationId = row.dataset.conversationId;
        chat.querySelector('.chat-title').textContent = row.querySelector('.name').textContent;
        const bubble = chat.querySelector('.bubble');
        bubble.textContent = row.querySelector('.preview').textContent;
        bubble.dataset.messageId = row === rows[0] ? '${messageId}' : 'fixture-message-bob';
      }
      for (const row of rows) row.onclick = () => { window.rowClicks.push(row.dataset.conversationId); openRow(row); };
      document.querySelector('#back').onclick = () => { window.backClicks++; ${blockedBack ? '' : 'chat.hidden = true;'} };
      ${open ? `openRow(rows[${open === 'alice' ? 0 : 1}]);` : ''}
    </script>` }));
  await page.goto('https://www.douyin.com/user/self');
  const adapter = new DouyinAssistedRpaAdapter({ logsDir: dir, profileDir: path.join(dir, 'profile') });
  Object.assign(adapter.spec, {
    privateConversationNameSelectors: ['.name'], privateConversationContentSelectors: ['.preview'],
    privateMessageEditorSelectors: ['[contenteditable="true"]'], privateConversationHeaderSelectors: ['.chat-title'],
    privateConversationBackSelectors: ['#back'], privateMessageEntrySelectors: [],
    privateConversationListReadAttempts: 2, privateConversationHeaderReadAttempts: 2,
    privateConversationHeaderSettleMs: 150
  });
  adapter.assertRuntimeAllowed = async () => {};
  adapter.prepareMessagePage = async () => ({ action: 'already_on_target' });
  adapter.inspectLoginState = async () => ({ state: 'READY' });
  adapter.waitForMessageContentReady = async () => ({ ready: true, pageCheck: { valid: true } });
  adapter.inspectDouyinStrangerInboxView = async () => ({ signalVisible: false });
  adapter.inspectPrivateConversationTimeline = async () => page.locator('#chat').evaluate(chat => {
    if (chat.hidden) return { messages: [], latestMessage: null };
    const bubble = chat.querySelector('.bubble');
    const message = { text: bubble.textContent, messageId: bubble.dataset.messageId,
      conversationId: chat.dataset.conversationId, direction: 'incoming' };
    return { messages: [message], latestMessage: message };
  });
  return { page, adapter };
}

test('Douyin MAIN reply reuses the verified open chat even when it covers the list', { skip: !chromePath }, async t => {
  const { page, adapter } = await fixture(t);
  const result = await adapter.openPrivateConversationForPayload(page, payload, { requireUnreadEvidence: false });
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.reusedOpenConversation, true);
  assert.equal(result.conversationId, conversationId);
  assert.deepEqual(await page.evaluate(() => window.rowClicks), []);
  assert.equal(await page.evaluate(() => window.backClicks), 0);
});

test('private reply preserves an already verified inbox instead of reloading its active chat', { skip: !chromePath }, async t => {
  const { page, adapter } = await fixture(t);
  let navigations = 0;
  page.on('request', request => { if (request.isNavigationRequest()) navigations++; });
  adapter.prepareMessagePage = AssistedPlatformRpaAdapter.prototype.prepareMessagePage.bind(adapter);
  adapter.classifyLiveMessagePage = async () => ({ valid: true, reason: 'VERIFIED_DOM' });
  const result = await adapter.openPrivateConversationForPayload(page, payload, { requireUnreadEvidence: false });
  assert.equal(result.ok, true, result.reason);
  assert.equal(navigations, 0);
});

test('Douyin collection preserves the verified inbox across consecutive rounds', { skip: !chromePath }, async t => {
  const { page, adapter } = await fixture(t, { open: null });
  let navigations = 0;
  page.on('request', request => { if (request.isNavigationRequest()) navigations++; });
  adapter.prepareMessagePage = AssistedPlatformRpaAdapter.prototype.prepareMessagePage.bind(adapter);
  adapter.getPage = async () => page;
  adapter.evidence = async (_payload, message, _page, stage, extra = {}) => ({ message, stage, ...extra });
  for (let round = 0; round < 2; round++) {
    const result = await adapter.collectMessages({ types: ['PRIVATE_MESSAGE'] });
    assert.equal(result.status, 'SUCCESS');
    assert.equal(result.result.typeResults[0].navigation.entryAction, 'already-open');
  }
  assert.equal(navigations, 0);
});

test('Douyin MAIN reply resets a leftover stranger inbox before reusing the page', { skip: !chromePath }, async t => {
  const { page, adapter } = await fixture(t, { open: null });
  await page.locator('body').evaluate(body => { body.dataset.inbox = 'STRANGER'; });
  adapter.prepareMessagePage = AssistedPlatformRpaAdapter.prototype.prepareMessagePage.bind(adapter);
  adapter.classifyLiveMessagePage = async () => ({ valid: true, reason: 'VERIFIED_DOM' });
  adapter.inspectDouyinStrangerInboxView = async () => ({ signalVisible: await page.locator('body').getAttribute('data-inbox') === 'STRANGER' });
  const result = await adapter.openPrivateConversationForPayload(page, payload, { requireUnreadEvidence: false });
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.navigation.attempts, 1);
  assert.equal(result.conversationId, conversationId);
  assert.deepEqual(await page.evaluate(() => window.rowClicks), [conversationId]);
});

test('Douyin exits a different overlay chat before locating the requested recipient', { skip: !chromePath }, async t => {
  const { page, adapter } = await fixture(t, { open: 'bob' });
  const result = await adapter.openPrivateConversationForPayload(page, payload, { requireUnreadEvidence: false });
  assert.equal(result.ok, true);
  assert.equal(result.conversationId, conversationId);
  assert.deepEqual(await page.evaluate(() => window.rowClicks), [conversationId]);
  assert.equal(await page.evaluate(() => window.backClicks), 1);
});

test('Douyin does not reuse a same-name chat with a different stable conversation ID', { skip: !chromePath }, async t => {
  const { page, adapter } = await fixture(t);
  await page.locator('#chat').evaluate(chat => { chat.dataset.conversationId = '0:1:100000000000:999999999999'; });
  const result = await adapter.openPrivateConversationForPayload(page, payload, { requireUnreadEvidence: false });
  assert.equal(result.ok, true);
  assert.notEqual(result.reusedOpenConversation, true);
  assert.equal(result.conversationId, conversationId);
  assert.equal(await page.evaluate(() => window.backClicks), 1);
});

test('Douyin stops without clicking a covered row when the previous chat cannot close', { skip: !chromePath }, async t => {
  const { page, adapter } = await fixture(t, { open: 'bob', blockedBack: true });
  const result = await adapter.openPrivateConversationForPayload(page, payload, { requireUnreadEvidence: false });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'PRIVATE_CONVERSATION_SWITCH_BLOCKED');
  assert.deepEqual(await page.evaluate(() => window.rowClicks), []);
});

test('private row selection stays bound to the verified element when the list reorders', { skip: !chromePath }, async t => {
  const { page, adapter } = await fixture(t, { open: null });
  let selected = false;
  const originalScan = adapter.waitForPrivateConversationRows.bind(adapter);
  adapter.waitForPrivateConversationRows = async (...args) => {
    const result = await originalScan(...args);
    selected = true;
    return result;
  };
  const originalRead = adapter.readPrivateConversationRowIdentity.bind(adapter);
  adapter.readPrivateConversationRowIdentity = async row => {
    const identity = await originalRead(row);
    // Reordering after stable-row selection must not retarget a stored nth locator.
    if (selected) {
      await page.locator('#rows').evaluate(rows => rows.prepend(rows.lastElementChild));
    }
    return identity;
  };
  const result = await adapter.openPrivateConversationForPayload(page, payload, { requireUnreadEvidence: false });
  assert.equal(result.ok, true);
  assert.deepEqual(await page.evaluate(() => window.rowClicks), [conversationId]);
  assert.equal(await page.locator('#rows .row').first().getAttribute('data-conversation-id'), '0:1:100000000000:300000000000');
});

test('Douyin read-conversation collection exits each chat before reading the next row and returns to the list', { skip: !chromePath }, async t => {
  const { page, adapter } = await fixture(t, { open: null });
  const recovery = await adapter.collectIncomingFromRecentReadPrivateConversations(page);
  assert.equal(recovery.recoveredCount, 2);
  assert.deepEqual(recovery.messages.map(message => message.userName), ['alice', 'bob']);
  assert.equal(await page.locator('#chat').isVisible(), false);
  assert.deepEqual(await page.evaluate(() => window.rowClicks), [conversationId, '0:1:100000000000:300000000000']);
});

test('Douyin stranger-inbox collection closes an existing chat before clicking the covered entry', { skip: !chromePath }, async t => {
  const { page, adapter } = await fixture(t);
  await page.locator('#rows').evaluate(rows => {
    const entry = document.createElement('button');
    entry.className = 'conversationStrangerBoxwrapper';
    entry.textContent = '陌生人消息';
    entry.onclick = () => { document.body.dataset.inbox = 'STRANGER'; };
    rows.prepend(entry);
  });
  adapter.inspectDouyinStrangerInboxView = async () => {
    const open = await page.locator('body').getAttribute('data-inbox') === 'STRANGER';
    return { open, signalVisible: open, titleText: open ? '陌生人消息' : '' };
  };
  const result = await adapter.openDouyinStrangerInbox(page);
  assert.equal(result.ok, true, result.reason);
  assert.equal(await page.locator('body').getAttribute('data-inbox'), 'STRANGER');
  assert.equal(await page.evaluate(() => window.backClicks), 1);
});

test('Douyin read collection reselects each recipient after closing a chat reorders the list', { skip: !chromePath }, async t => {
  const { page, adapter } = await fixture(t, { open: null });
  await page.locator('#back').evaluate(back => {
    const close = back.onclick;
    back.onclick = () => { close(); const rows = document.querySelector('#rows'); rows.prepend(rows.lastElementChild); };
  });
  const result = await adapter.collectIncomingFromRecentReadPrivateConversations(page);
  assert.deepEqual(result.messages.map(message => message.userName), ['alice', 'bob']);
  assert.deepEqual(await page.evaluate(() => window.rowClicks), [conversationId, '0:1:100000000000:300000000000']);
});

test('Douyin read collection preserves collected messages when a later row disappears or cannot be read', { skip: !chromePath }, async t => {
  const { page, adapter } = await fixture(t, { open: null });
  const recover = adapter.collectLatestIncomingFromOpenPrivateConversation.bind(adapter);
  adapter.collectLatestIncomingFromOpenPrivateConversation = async (...args) => {
    if (args[2]?.expectedHeaderName === 'bob') throw new Error('fixture chat read failed');
    return recover(...args);
  };
  const failedRead = await adapter.collectIncomingFromRecentReadPrivateConversations(page);
  assert.deepEqual(failedRead.messages.map(message => message.userName), ['alice']);
  assert.ok(failedRead.rowDiagnostics.some(item => item.reason === 'READ_CONVERSATION_INSPECTION_FAILED'));
  await page.locator('#back').evaluate(back => {
    const close = back.onclick;
    back.onclick = () => { close(); document.querySelectorAll('.row')[1]?.remove(); };
  });
  const disappeared = await adapter.collectIncomingFromRecentReadPrivateConversations(page);
  assert.deepEqual(disappeared.messages.map(message => message.userName), ['alice']);
  assert.ok(disappeared.rowDiagnostics.some(item => item.reason === 'READ_CONVERSATION_ROW_CHANGED'));
});

test('Douyin conversation preparation propagates a platform stop during overlay restoration', { skip: !chromePath }, async t => {
  const { page, adapter } = await fixture(t);
  adapter.restorePrivateInboxOverview = async () => { throw Object.assign(new Error('platform stopped'), { code: 'PLATFORM_STOPPED' }); };
  await assert.rejects(adapter.preparePrivateConversationList(page), { code: 'PLATFORM_STOPPED' });
});
