import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chromium } from 'playwright-core';
import { cleanupDir, openWorkspaceGroup, openWorkspacePage, startServer, stopChild } from './helpers/runtime.js';

function installedChromePath() {
  const candidates = [
    process.env.CHROME_EXECUTABLE_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser'
  ].filter(Boolean);
  return candidates.find(candidate => fs.existsSync(candidate)) || null;
}

const chromePath = installedChromePath();
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function conversations() {
  return [
    {
      id: 101,
      platformCode: 'mini_program',
      appId: 'mini-app-contract',
      conversationId: 'consultation-with-a-very-long-id-20260905-000000000001',
      userId: 'user-with-a-very-long-id-20260905-000000000001',
      lastTextPreview: '请问港澳居民居住证应该到哪里办理？',
      lastActivityAt: '2026-09-05T09:31:00.000Z',
      handlingMode: 'BOT_ACTIVE',
      historicalUser: false,
      processingStatus: 'COMPLETED',
      callbackStatus: 'FAILED',
      notificationId: null,
      notificationStatus: null
    },
    {
      id: 202,
      platformCode: 'mini_program',
      appId: 'mini-app-contract',
      conversationId: 'handoff-consultation-20260905-0002',
      userId: 'returning-user-20260905-0002',
      lastTextPreview: '请安排工作人员联系我。',
      lastActivityAt: '2026-09-05T09:35:00.000Z',
      handlingMode: 'HANDOFF_PENDING',
      historicalUser: true,
      processingStatus: null,
      callbackStatus: null,
      notificationId: 301,
      notificationStatus: 'FAILED'
    },
    {
      id: 303,
      platformCode: 'mini_program',
      appId: 'mini-app-contract',
      conversationId: 'closed-consultation-20260905-0003',
      userId: 'closed-user-20260905-0003',
      lastTextPreview: '此前已由工作人员接待。',
      lastActivityAt: '2026-09-05T09:40:00.000Z',
      handlingMode: 'HUMAN_MANAGED',
      historicalUser: true,
      processingStatus: null,
      callbackStatus: null,
      notificationId: 302,
      notificationStatus: 'CONFIRMED'
    }
  ];
}

function messagesFor(id) {
  if (Number(id) === 202) {
    return {
      conversation: conversations()[1],
      messages: [{
        id: 21,
        messageId: 'handoff-message-1',
        text: '请安排工作人员联系我。',
        replyText: null,
        status: 'MANUAL_REQUIRED',
        decision: 'HUMAN_HANDOFF',
        knowledgeId: null,
        knowledgeQuestionSnapshot: null,
        receivedAt: '2026-09-05T09:35:00.000Z',
        sentAt: '2026-09-05T09:34:59.000Z',
        processing: null,
        callback: null,
        notification: { id: 301, status: 'FAILED', attemptCount: 2, error: '企微通知发送失败，请检查通知服务后重试', httpStatus: null, sentAt: null, confirmedAt: null, retryable: true }
      }]
    };
  }
  if (Number(id) === 303) {
    return {
      conversation: conversations()[2],
      messages: [{
        id: 31,
        messageId: 'closed-message-1',
        text: '此前已由工作人员接待。',
        replyText: null,
        status: 'MANUAL_REQUIRED',
        decision: 'HUMAN_HANDOFF',
        knowledgeId: null,
        knowledgeQuestionSnapshot: null,
        receivedAt: '2026-09-05T09:40:00.000Z',
        sentAt: '2026-09-05T09:39:59.000Z',
        processing: null,
        callback: null,
        notification: { id: 302, status: 'CONFIRMED', attemptCount: 1, error: null, httpStatus: null, sentAt: '2026-09-05T09:40:02.000Z', confirmedAt: '2026-09-05T09:40:02.000Z', retryable: false }
      }]
    };
  }
  return {
    conversation: conversations()[0],
    messages: [
      {
        id: 12,
        messageId: 'message-later',
        text: '还需要准备什么资料？',
        replyText: '还需要准备近期照片。',
        status: 'REPLY_QUEUED',
        decision: 'RAG_ANSWERED',
        knowledgeId: 902,
        knowledgeQuestionSnapshot: '居住证办理材料',
        receivedAt: '2026-09-05T09:31:00.000Z',
        sentAt: '2026-09-05T09:30:59.000Z',
        processing: { id: 502, status: 'COMPLETED', attemptCount: 1, error: null },
        callback: { id: 401, status: 'FAILED', attemptCount: 3, error: '回调发送失败，请检查回调服务后重试', httpStatus: 503, sentAt: null, confirmedAt: null, retryable: true },
        notification: null
      },
      {
        id: 11,
        messageId: 'message-earlier',
        text: '较早问题：居住证在哪里办理？',
        replyText: '较早回答：请到街道服务中心办理。',
        status: 'AUTO_REPLIED',
        decision: 'RAG_ANSWERED',
        knowledgeId: 901,
        knowledgeQuestionSnapshot: '居住证办理地点',
        receivedAt: '2026-09-05T09:30:00.000Z',
        sentAt: '2026-09-05T09:29:59.000Z',
        processing: { id: 501, status: 'COMPLETED', attemptCount: 1, error: null },
        callback: { id: 400, status: 'SENT', attemptCount: 1, error: null, httpStatus: 204, sentAt: '2026-09-05T09:30:02.000Z', confirmedAt: null, retryable: false },
        notification: null
      }
    ]
  };
}

function listForFilter(filter) {
  const all = conversations();
  return ({
    ALL: all,
    PROCESSING: [all[0]],
    CALLBACK_PENDING: [all[0]],
    HANDOFF_PENDING: [all[1]],
    HUMAN_MANAGED: [all[2]],
    ERROR: [all[0], all[1]]
  })[filter] || all;
}

test('小程序对话工作台通过真实页面完成筛选、详情和管理动作且不提供回复输入', { skip: !chromePath }, async t => {
  const runtime = await startServer({ env: {
    MINI_PROGRAM_API_ENABLED: 'true',
    MINI_PROGRAM_APP_ID: 'mini-app-contract',
    MINI_PROGRAM_SHARED_SECRET: 'contract-secret-value',
    MINI_PROGRAM_CALLBACK_URL: 'http://127.0.0.1:65534/callback'
  } });
  t.after(async () => { await stopChild(runtime.child); cleanupDir(runtime.dir); });

  const browser = await chromium.launch({ headless: true, executablePath: chromePath });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const requests = [];
  const sameOriginRequests = [];
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.origin === runtime.base) sameOriginRequests.push({ method: request.method(), pathname: url.pathname });
  });
  let releaseHandoff;
  const handoffGate = new Promise(resolve => { releaseHandoff = resolve; });

  await page.route('**/api/mini-program/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const record = { method: request.method(), pathname: url.pathname, search: url.search, body: request.postData() ? request.postDataJSON() : null };
    requests.push(record);
    let payload;
    if (request.method() === 'GET' && url.pathname === '/api/mini-program/status') {
      payload = { ok: true, status: { apiEnabled: true, appConfigured: true, secretConfigured: true, callbackConfigured: true, lastReceivedAt: '2026-09-05T09:40:00.000Z', counts: { processing: 1, processingFailed: 1, callbackPending: 1, callbackFailed: 1, notificationFailed: 1 } } };
    } else if (request.method() === 'GET' && url.pathname === '/api/mini-program/conversations') {
      payload = { ok: true, conversations: listForFilter(url.searchParams.get('status') || 'ALL') };
    } else if (request.method() === 'GET' && /^\/api\/mini-program\/conversations\/\d+\/messages$/.test(url.pathname)) {
      payload = { ok: true, ...messagesFor(url.pathname.split('/')[4]) };
    } else if (request.method() === 'POST' && url.pathname === '/api/mini-program/conversations/101/handoff') {
      await handoffGate;
      payload = { ok: true, conversation: conversations()[0], notification: { id: 399, status: 'PENDING', retryable: false }, created: true };
    } else if (request.method() === 'POST' && url.pathname === '/api/mini-program/notifications/301/retry') {
      payload = { ok: true, notification: { id: 301, status: 'PENDING', retryable: false } };
    } else if (request.method() === 'POST' && url.pathname === '/api/mini-program/callbacks/401/retry') {
      payload = { ok: true, callback: { id: 401, status: 'PENDING', retryable: false } };
    } else {
      return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ ok: false, message: `unexpected ${request.method()} ${url.pathname}` }) });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(payload) });
  });

  await page.goto(runtime.base);
  // 分组工作区导航：互动相关栏目同属「用户互动」分组，顺序为 评论 → 私信 → 小程序对话 → 转人工记录。
  const navLabels = (await openWorkspaceGroup(page, 'inbox')).map(label => label.trim());
  assert.deepEqual(navLabels, ['评论', '私信', '小程序对话', '转人工记录'], JSON.stringify(navLabels));

  await openWorkspacePage(page, 'miniProgram');
  await page.locator('.mini-program-page').waitFor();
  assert.equal(await page.locator('.mini-program-page').count(), 1);
  assert.match(await page.locator('.mini-program-summary').innerText(), /开放接口|应用配置|回调配置|最近接收|待处理|待回调|企微失败/);

  const filterLabels = ['全部', 'AI 处理中', '回复待发送', '转人工通知中', '已转人工', '异常'];
  assert.deepEqual(await page.locator('.mini-program-filter').allTextContents(), filterLabels);
  for (const [label, status] of [
    ['AI 处理中', 'PROCESSING'],
    ['回复待发送', 'CALLBACK_PENDING'],
    ['转人工通知中', 'HANDOFF_PENDING'],
    ['已转人工', 'HUMAN_MANAGED'],
    ['异常', 'ERROR'],
    ['全部', 'ALL']
  ]) {
    await page.getByRole('button', { name: label, exact: true }).click();
    await page.waitForFunction(expected => document.querySelector('.mini-program-filter.active')?.dataset.filter === expected, status);
    assert.ok(requests.some(item => item.method === 'GET' && item.pathname === '/api/mini-program/conversations' && new URLSearchParams(item.search).get('status') === status));
  }

  await page.locator('.mini-program-conversation[data-conversation-id="101"]').click();
  await page.locator('.mini-program-message').first().waitFor();
  const renderedTexts = await page.locator('.mini-program-message .mini-program-inbound').allTextContents();
  assert.match(renderedTexts[0], /较早问题/);
  assert.match(renderedTexts[1], /还需要准备什么资料/);
  const detailText = await page.locator('.mini-program-detail').innerText();
  assert.match(detailText, /居住证办理地点|回调发送失败|503|AI 回复/);
  assert.match(detailText, /知识库已回复/);
  assert.doesNotMatch(detailText, /RAG_ANSWERED/);
  assert.equal(await page.locator('.mini-program-page textarea, .mini-program-page input').count(), 0);
  assert.doesNotMatch(detailText, /发送回复|人工回复输入/);

  await page.getByRole('button', { name: '重试回调', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#toast')?.classList.contains('show'));
  assert.ok(requests.some(item => item.method === 'POST' && item.pathname === '/api/mini-program/callbacks/401/retry' && JSON.stringify(item.body) === '{}'));
  assert.equal(await page.locator('.mini-program-conversation.active').getAttribute('data-conversation-id'), '101');

  const handoffButton = page.getByRole('button', { name: '转人工', exact: true });
  await handoffButton.click();
  await page.waitForFunction(() => document.querySelector('.mini-program-handoff')?.disabled === true);
  const handoffRequest = requests.find(item => item.method === 'POST' && item.pathname === '/api/mini-program/conversations/101/handoff');
  assert.deepEqual(handoffRequest?.body, { idempotencyKey: 'mini-program-handoff:101' });
  releaseHandoff();
  await page.waitForFunction(() => document.querySelector('.mini-program-handoff')?.disabled === false);
  assert.equal(await page.locator('.mini-program-conversation.active').getAttribute('data-conversation-id'), '101');

  await page.getByRole('button', { name: '转人工通知中', exact: true }).click();
  await page.locator('.mini-program-conversation[data-conversation-id="202"]').click();
  await page.getByRole('button', { name: '重试企微通知', exact: true }).click();
  assert.ok(requests.some(item => item.method === 'POST' && item.pathname === '/api/mini-program/notifications/301/retry' && JSON.stringify(item.body) === '{}'));
  assert.equal(await page.locator('.mini-program-conversation.active').getAttribute('data-conversation-id'), '202');

  const statusRequestsBeforeRefresh = requests.filter(item => item.pathname === '/api/mini-program/status').length;
  await page.getByRole('button', { name: '刷新小程序对话', exact: true }).click();
  await page.waitForFunction(count => performance.getEntriesByType('resource').length >= 0 && document.querySelector('.mini-program-refresh:not(:disabled)') && count >= 0, statusRequestsBeforeRefresh);
  assert.ok(requests.filter(item => item.pathname === '/api/mini-program/status').length > statusRequestsBeforeRefresh);

  const allowed = [
    ['GET', /^\/api\/mini-program\/status$/],
    ['GET', /^\/api\/mini-program\/conversations$/],
    ['GET', /^\/api\/mini-program\/conversations\/\d+\/messages$/],
    ['POST', /^\/api\/mini-program\/conversations\/\d+\/handoff$/],
    ['POST', /^\/api\/mini-program\/notifications\/\d+\/retry$/],
    ['POST', /^\/api\/mini-program\/callbacks\/\d+\/retry$/]
  ];
  assert.ok(requests.length > 0);
  assert.deepEqual(requests.filter(item => !allowed.some(([method, pattern]) => item.method === method && pattern.test(item.pathname))), []);
  for (const [method, pattern] of allowed) assert.ok(requests.some(item => item.method === method && pattern.test(item.pathname)), `${method} ${pattern}`);
  assert.equal(sameOriginRequests.some(item => item.pathname.startsWith('/open-api/')), false);
  assert.equal(sameOriginRequests.some(item => /rag/i.test(item.pathname)), false);
});

test('快速切换筛选时只有最新请求可以提交列表、详情和选中状态', { skip: !chromePath }, async t => {
  const runtime = await startServer();
  t.after(async () => { await stopChild(runtime.child); cleanupDir(runtime.dir); });
  const browser = await chromium.launch({ headless: true, executablePath: chromePath });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  let slowProcessing = false;
  let processingSeen = deferred();
  let messageApiRequests = 0;
  page.on('request', request => { if (new URL(request.url()).pathname === '/api/messages') messageApiRequests += 1; });
  const processingConversation = { ...conversations()[0], userId: 'processing-result-user', conversationId: 'processing-result-conversation' };
  const callbackConversation = { ...conversations()[1], id: 202, userId: 'callback-result-user', conversationId: 'callback-result-conversation', handlingMode: 'BOT_ACTIVE' };

  await page.route('**/api/mini-program/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    let payload;
    if (url.pathname === '/api/mini-program/status') {
      payload = { ok: true, status: { counts: {} } };
    } else if (url.pathname === '/api/mini-program/conversations') {
      const filter = url.searchParams.get('status') || 'ALL';
      if (filter === 'PROCESSING') {
        processingSeen.resolve();
        await delay(450);
        payload = { ok: true, conversations: [processingConversation] };
      } else if (filter === 'CALLBACK_PENDING') {
        await delay(30);
        payload = { ok: true, conversations: [callbackConversation] };
      } else payload = { ok: true, conversations: [processingConversation] };
    } else if (url.pathname === '/api/mini-program/conversations/101/messages') {
      if (slowProcessing) await delay(450);
      payload = { ok: true, conversation: processingConversation, messages: [{ ...messagesFor(101).messages[0], text: 'PROCESSING 旧详情' }] };
    } else if (url.pathname === '/api/mini-program/conversations/202/messages') {
      await delay(30);
      payload = { ok: true, conversation: callbackConversation, messages: [{ ...messagesFor(202).messages[0], text: 'CALLBACK 最新详情' }] };
    } else return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ ok: false }) });
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(payload) });
  });

  await page.goto(runtime.base);
  await openWorkspacePage(page, 'miniProgram');
  await page.locator('.mini-program-page').waitFor();
  slowProcessing = true;
  const firstSeen = processingSeen;
  await page.getByRole('button', { name: 'AI 处理中', exact: true }).click();
  await firstSeen.promise;
  await page.getByRole('button', { name: '回复待发送', exact: true }).click();
  await page.waitForFunction(() => (
    document.querySelector('.mini-program-filter.active')?.dataset.filter === 'CALLBACK_PENDING'
    && document.querySelector('.mini-program-conversation')?.dataset.conversationId === '202'
    && document.querySelector('.mini-program-detail')?.textContent.includes('CALLBACK 最新详情')
  ));
  await delay(1050);
  assert.equal(await page.locator('.mini-program-filter.active').getAttribute('data-filter'), 'CALLBACK_PENDING');
  assert.deepEqual(await page.locator('.mini-program-conversation').evaluateAll(nodes => nodes.map(node => node.dataset.conversationId)), ['202']);
  assert.match(await page.locator('.mini-program-detail').innerText(), /callback-result-user|callback-result-conversation|CALLBACK 最新详情/);
  assert.doesNotMatch(await page.locator('.mini-program-page').innerText(), /PROCESSING 旧详情|processing-result-user/);

  processingSeen = deferred();
  await page.getByRole('button', { name: 'AI 处理中', exact: true }).click();
  await processingSeen.promise;
  await openWorkspacePage(page, 'dashboard');
  await page.locator('.operations-dashboard').waitFor();
  await delay(950);
  assert.equal(await page.locator('.operations-dashboard').count(), 1);
  assert.equal(await page.locator('.mini-program-page').count(), 0);
  await openWorkspacePage(page, 'messages');
  await page.locator('.message-workbench').waitFor();
  assert.equal(messageApiRequests, 1, 'page generation metadata must not replace renderMessages prefetched data');
});

test('管理响应经过状态、标识、数字和时间安全投影且空结果不发错误请求', { skip: !chromePath }, async t => {
  const runtime = await startServer({ env: { MINI_PROGRAM_SHARED_SECRET: 'browser-contract-shared-secret' } });
  t.after(async () => { await stopChild(runtime.child); cleanupDir(runtime.dir); });
  const browser = await chromium.launch({ headless: true, executablePath: chromePath });
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.addInitScript(() => { window.__miniProgramInjected = 0; });
  const page = await context.newPage();
  const requests = [];
  const maliciousStatus = 'x" onmouseover="window.__miniProgramInjected=1';
  const validConversation = {
    ...conversations()[0], id: 808, handlingMode: maliciousStatus, processingStatus: 'PENDING',
    callbackStatus: 'PENDING', notificationStatus: 'PENDING', lastActivityAt: 'not-a-date', sharedSecret: 'browser-contract-shared-secret'
  };
  const invalidConversations = [null, -9, Number.MAX_SAFE_INTEGER + 1, 'id" onfocus="window.__miniProgramInjected=2'].map((id, index) => ({
    ...conversations()[0], id, userId: `invalid-user-${index}`, conversationId: `invalid-conversation-${index}`, handlingMode: 'BOT_ACTIVE'
  }));
  const detail = {
    conversation: validConversation,
    messages: [
      {
        ...messagesFor(101).messages[0], id: 'invalid-message-id', status: maliciousStatus, decision: maliciousStatus,
        knowledgeId: Number.MAX_SAFE_INTEGER + 1, receivedAt: '0', sentAt: '2026-02-30T01:02:03.000Z',
        processing: { id: -1, status: 'PENDING', attemptCount: '3', error: null },
        callback: { id: null, status: 'PENDING', attemptCount: -1, error: null, httpStatus: '503', retryable: true },
        notification: { id: Number.MAX_SAFE_INTEGER + 1, status: 'PENDING', attemptCount: null, error: null, retryable: true }
      },
      {
        ...messagesFor(101).messages[1], id: 809, knowledgeId: -4,
        callback: { id: 812, status: 'NOT_CONFIGURED', attemptCount: 0, error: '回调尚未配置', httpStatus: null, retryable: true },
        processing: null, notification: null
      }
    ]
  };

  await page.route('**/api/mini-program/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    requests.push({ method: request.method(), pathname: url.pathname, search: url.search });
    let payload;
    if (url.pathname === '/api/mini-program/status') payload = {
      ok: true,
      status: {
        apiEnabled: true, appConfigured: true, callbackConfigured: true, sharedSecret: 'browser-contract-shared-secret',
        lastReceivedAt: '2026-02-30T01:02:03.000Z', counts: { processing: '9', processingFailed: -1, callbackPending: Number.MAX_SAFE_INTEGER + 1, callbackFailed: 'bad', notificationFailed: null }
      }
    };
    else if (url.pathname === '/api/mini-program/conversations') {
      payload = { ok: true, conversations: url.searchParams.get('status') === 'HUMAN_MANAGED' ? invalidConversations : [validConversation, ...invalidConversations] };
    } else if (url.pathname === '/api/mini-program/conversations/808/messages') payload = { ok: true, ...detail };
    else if (/\/api\/mini-program\/conversations\/[^/]+\/messages/.test(url.pathname)) payload = { ok: true, conversation: invalidConversations[0], messages: [] };
    else return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ ok: false }) });
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(payload) });
  });

  await page.goto(runtime.base);
  await openWorkspacePage(page, 'miniProgram');
  await page.locator('.mini-program-page').waitFor();
  assert.deepEqual(await page.locator('.mini-program-conversation').evaluateAll(nodes => nodes.map(node => node.dataset.conversationId)), ['808']);
  assert.deepEqual(await page.locator('.mini-program-summary-item>b').allTextContents(), ['已开启', '已就绪', '已就绪', '—', '0', '0', '0']);
  assert.doesNotMatch(await page.locator('.mini-program-page').innerText(), /Invalid Date|2000\/1\/1|2026\/3\/2|browser-contract-shared-secret|x"|#-4|9007199254740992/);
  assert.ok((await page.getByText('未知状态', { exact: true }).count()) >= 2);
  const unsafeMessage = page.locator('.mini-program-message').filter({ hasText: 'message-later' });
  assert.equal(await unsafeMessage.count(), 1);
  const deliveryTexts = await unsafeMessage.locator('.mini-program-delivery').allTextContents();
  assert.match(deliveryTexts[0], /待处理/);
  assert.match(deliveryTexts[1], /等待发送/);
  assert.match(deliveryTexts[2], /等待通知/);
  assert.match(await page.locator('.mini-program-message').filter({ hasText: 'message-earlier' }).innerText(), /未配置回调/);
  assert.equal(await page.locator('.mini-program-retry-callback').count(), 1);
  assert.equal(await page.locator('.mini-program-retry-notification').count(), 0);
  assert.equal(await page.locator('.mini-program-handoff').count(), 0);
  const eventAttributes = await page.locator('.mini-program-page').evaluate(root => [...root.querySelectorAll('*')].flatMap(node => [...node.attributes].filter(attribute => /^on/i.test(attribute.name)).map(attribute => attribute.name)));
  assert.deepEqual(eventAttributes, []);
  await page.locator('.mini-program-page').evaluate(root => root.querySelectorAll('*').forEach(node => node.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))));
  assert.equal(await page.evaluate(() => window.__miniProgramInjected), 0);
  assert.deepEqual(requests.filter(item => item.method === 'POST'), []);
  assert.deepEqual(requests.filter(item => /\/(?:0|-9|NaN|null|9007199254740992)\//.test(item.pathname)), []);

  await page.getByRole('button', { name: '已转人工', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.mini-program-empty').length === 2);
  const emptyText = await page.locator('.mini-program-page').innerText();
  assert.match(emptyText, /暂无符合条件的会话/);
  assert.match(emptyText, /请选择一个会话/);
  assert.deepEqual(requests.filter(item => /\/(?:0|-9|NaN|null|9007199254740992)\//.test(item.pathname)), []);
});

test('三类动作锁跨重绘生效，失败清理后可重试并保持选中会话', { skip: !chromePath }, async t => {
  const runtime = await startServer();
  t.after(async () => { await stopChild(runtime.child); cleanupDir(runtime.dir); });
  const browser = await chromium.launch({ headless: true, executablePath: chromePath });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const activeConversation = { ...conversations()[0], id: 101, handlingMode: 'BOT_ACTIVE' };
  const otherConversation = { ...conversations()[1], id: 202, handlingMode: 'HANDOFF_PENDING' };
  const actionMessage = {
    ...messagesFor(101).messages[0],
    callback: { id: 401, status: 'FAILED', attemptCount: 1, error: '回调失败', httpStatus: 500, retryable: true },
    notification: { id: 301, status: 'FAILED', attemptCount: 1, error: '企微失败', retryable: true }
  };
  const postCounts = { handoff: 0, callback: 0, notification: 0 };
  const gates = { handoff: deferred(), callback: deferred(), notification: deferred() };
  const entered = { handoff: deferred(), callback: deferred(), notification: deferred() };
  let excludeSelected = false;

  await page.route('**/api/mini-program/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    let payload;
    if (request.method() === 'GET' && url.pathname === '/api/mini-program/status') payload = { ok: true, status: { counts: {} } };
    else if (request.method() === 'GET' && url.pathname === '/api/mini-program/conversations') payload = { ok: true, conversations: excludeSelected ? [otherConversation] : [activeConversation, otherConversation] };
    else if (request.method() === 'GET' && url.pathname === '/api/mini-program/conversations/101/messages') payload = { ok: true, conversation: activeConversation, messages: [actionMessage] };
    else if (request.method() === 'GET' && url.pathname === '/api/mini-program/conversations/202/messages') payload = { ok: true, conversation: otherConversation, messages: messagesFor(202).messages };
    else if (request.method() === 'POST') {
      const kind = url.pathname.includes('/handoff') ? 'handoff' : url.pathname.includes('/callbacks/') ? 'callback' : 'notification';
      postCounts[kind] += 1;
      if (postCounts[kind] === 1) {
        entered[kind].resolve();
        await gates[kind].promise;
        if (kind === 'handoff') return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ ok: false, message: '模拟转人工失败' }) });
      }
      payload = { ok: true };
    } else return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ ok: false }) });
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(payload) });
  });

  await page.goto(runtime.base);
  await openWorkspacePage(page, 'miniProgram');
  await page.locator('.mini-program-page').waitFor();

  const verifyLockAcrossRefresh = async (kind, selector) => {
    const original = page.locator(selector);
    const originalHandle = await original.elementHandle();
    await original.click();
    await entered[kind].promise;
    await original.waitFor({ state: 'attached' });
    assert.equal(await original.isDisabled(), true);
    assert.equal(await original.getAttribute('aria-busy'), 'true');
    const statusRequest = page.waitForRequest(request => new URL(request.url()).pathname === '/api/mini-program/status');
    await page.getByRole('button', { name: '刷新小程序对话', exact: true }).click();
    await statusRequest;
    await page.waitForFunction(node => !node.isConnected, originalHandle);
    const replacement = page.locator(selector);
    await replacement.waitFor();
    assert.equal(await replacement.isDisabled(), true);
    assert.equal(await replacement.getAttribute('aria-busy'), 'true');
    await replacement.dispatchEvent('click');
    await delay(80);
    assert.equal(postCounts[kind], 1);
    return replacement;
  };

  await verifyLockAcrossRefresh('handoff', '.mini-program-handoff');
  gates.handoff.resolve();
  await page.waitForFunction(() => document.querySelector('.mini-program-handoff')?.disabled === false);
  assert.match(await page.locator('#toast').innerText(), /模拟转人工失败/);
  await page.locator('.mini-program-handoff').click();
  await page.waitForFunction(() => document.querySelector('.mini-program-handoff')?.disabled === false);
  assert.equal(postCounts.handoff, 2);

  await verifyLockAcrossRefresh('callback', '.mini-program-retry-callback');
  gates.callback.resolve();
  await page.waitForFunction(() => document.querySelector('.mini-program-retry-callback')?.disabled === false);
  assert.equal(postCounts.callback, 1);

  await verifyLockAcrossRefresh('notification', '.mini-program-retry-notification');
  gates.notification.resolve();
  await page.waitForFunction(() => document.querySelector('.mini-program-retry-notification')?.disabled === false);
  assert.equal(postCounts.notification, 1);

  excludeSelected = true;
  const statusRequest = page.waitForRequest(request => new URL(request.url()).pathname === '/api/mini-program/status');
  await page.getByRole('button', { name: '刷新小程序对话', exact: true }).click();
  await statusRequest;
  await page.waitForFunction(() => document.querySelector('.mini-program-detail')?.textContent.includes('consultation-with-a-very-long-id-20260905-000000000001'));
  assert.match(await page.locator('.mini-program-detail').innerText(), /consultation-with-a-very-long-id-20260905-000000000001/);
  assert.equal(await page.locator('.mini-program-conversation.active').count(), 0);
});

test('旧页面 bootstrap 响应不能覆盖最新页面的全局运行门禁', { skip: !chromePath }, async t => {
  const runtime = await startServer();
  t.after(async () => { await stopChild(runtime.child); cleanupDir(runtime.dir); });
  const browser = await chromium.launch({ headless: true, executablePath: chromePath });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const oldBootstrapEntered = deferred();
  const releaseOldBootstrap = deferred();
  let raceStarted = false;
  let raceRequestCount = 0;

  await page.route('**/api/bootstrap', async route => {
    const response = await route.fetch();
    if (!raceStarted) return route.fulfill({ response });
    raceRequestCount += 1;
    const stale = raceRequestCount === 1;
    if (stale) {
      oldBootstrapEntered.resolve();
      await releaseOldBootstrap.promise;
    }
    const payload = await response.json();
    payload.config = {
      ...payload.config,
      qwenMode: stale ? 'mock' : 'online',
      masterSwitch: { ...(payload.config?.masterSwitch || {}), enabled: !stale }
    };
    payload.localAgent = { ...(payload.localAgent || {}), online: !stale };
    payload.devices = [];
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(payload) });
  });

  await page.goto(runtime.base);
  await page.locator('.operations-dashboard').waitFor();
  raceStarted = true;
  await openWorkspacePage(page, 'publish');
  await oldBootstrapEntered.promise;
  await openWorkspacePage(page, 'miniProgram');
  await page.locator('.mini-program-page').waitFor();
  assert.match(await page.locator('#qwenMode').innerText(), /在线/);
  assert.equal(await page.locator('#operationsBadge').innerText(), 'LIVE');
  assert.equal(await page.locator('body').evaluate(node => node.classList.contains('operations-paused')), false);

  releaseOldBootstrap.resolve();
  await delay(200);
  assert.match(await page.locator('#qwenMode').innerText(), /在线/);
  assert.equal(await page.locator('#operationsBadge').innerText(), 'LIVE');
  assert.equal(await page.locator('#agentStatus').innerText(), '在线');
  assert.equal(await page.locator('body').evaluate(node => node.classList.contains('operations-paused')), false);
  assert.equal(await page.locator('.mini-program-page').count(), 1);
});

test('旧定时 bootstrap 刷新不能覆盖小程序页面较新的运行门禁', { skip: !chromePath }, async t => {
  const runtime = await startServer();
  t.after(async () => { await stopChild(runtime.child); cleanupDir(runtime.dir); });
  const browser = await chromium.launch({ headless: true, executablePath: chromePath });
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.addInitScript(() => {
    const nativeSetInterval = window.setInterval.bind(window);
    window.setInterval = function(callback, timeout, ...args) {
      if (timeout === 5000) window.__runBootstrapRefreshTimer = () => callback(...args);
      return nativeSetInterval(callback, timeout, ...args);
    };
  });
  const page = await context.newPage();
  const timerBootstrapEntered = deferred();
  const releaseTimerBootstrap = deferred();
  let raceStarted = false;
  let raceRequestCount = 0;

  await page.route('**/api/bootstrap', async route => {
    const response = await route.fetch();
    if (!raceStarted) return route.fulfill({ response });
    raceRequestCount += 1;
    const staleTimerResponse = raceRequestCount === 1;
    if (staleTimerResponse) {
      timerBootstrapEntered.resolve();
      await releaseTimerBootstrap.promise;
    }
    const payload = await response.json();
    payload.config = {
      ...payload.config,
      qwenMode: staleTimerResponse ? 'mock' : 'online',
      masterSwitch: { ...(payload.config?.masterSwitch || {}), enabled: !staleTimerResponse }
    };
    payload.localAgent = { ...(payload.localAgent || {}), online: !staleTimerResponse };
    payload.devices = [];
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(payload) });
  });
  await page.route('**/api/mini-program/**', async route => {
    const pathname = new URL(route.request().url()).pathname;
    const payload = pathname === '/api/mini-program/status'
      ? { ok: true, status: { counts: {} } }
      : pathname === '/api/mini-program/conversations'
        ? { ok: true, conversations: [] }
        : null;
    if (!payload) return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ ok: false }) });
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(payload) });
  });

  await page.goto(runtime.base);
  await page.locator('.operations-dashboard').waitFor();
  await page.waitForFunction(() => typeof window.__runBootstrapRefreshTimer === 'function');
  raceStarted = true;
  await page.evaluate(() => { void window.__runBootstrapRefreshTimer(); });
  await timerBootstrapEntered.promise;

  await openWorkspacePage(page, 'miniProgram');
  await page.locator('.mini-program-page').waitFor();
  assert.match(await page.locator('#qwenMode').innerText(), /在线/);
  assert.equal(await page.locator('#operationsBadge').innerText(), 'LIVE');
  assert.equal(await page.locator('#agentStatus').innerText(), '在线');

  releaseTimerBootstrap.resolve();
  await delay(200);
  assert.match(await page.locator('#qwenMode').innerText(), /在线/);
  assert.equal(await page.locator('#operationsBadge').innerText(), 'LIVE');
  assert.equal(await page.locator('#agentStatus').innerText(), '在线');
  assert.equal(await page.locator('body').evaluate(node => node.classList.contains('operations-paused')), false);
  assert.equal(await page.locator('.mini-program-page').count(), 1);
});

test('旧平台动作完成后不能借用小程序页面所有权刷新或重绘', { skip: !chromePath }, async t => {
  const runtime = await startServer();
  t.after(async () => { await stopChild(runtime.child); cleanupDir(runtime.dir); });
  const browser = await chromium.launch({ headless: true, executablePath: chromePath });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const actionPostEntered = deferred();
  const releaseActionPost = deferred();
  const miniBootstrapEntered = deferred();
  const releaseMiniBootstrap = deferred();
  let holdMiniBootstrap = false;
  let bootstrapRequestsAfterMiniNavigation = 0;

  await page.route('**/api/bootstrap', async route => {
    const response = await route.fetch();
    const payload = await response.json();
    payload.config = { ...payload.config, activePlatformCodes: ['douyin'] };
    payload.platforms = [{
      code: 'douyin', name: '抖音', lifecycle_state: 'ACTIVE', desired_state: 'RUNNING',
      effective_state: 'RUNNING', task_execution_state: 'RUNNING', running_job_count: 0
    }];
    payload.accounts = [{
      id: 1, platform_code: 'douyin', platform_name: '抖音', display_name: '竞态测试账号',
      profile_name: 'race-profile', enabled: 1, login_status: 'LOGGED_IN'
    }];
    if (holdMiniBootstrap) {
      bootstrapRequestsAfterMiniNavigation += 1;
      if (bootstrapRequestsAfterMiniNavigation === 1) {
        miniBootstrapEntered.resolve();
        await releaseMiniBootstrap.promise;
      }
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(payload) });
  });
  await page.route('**/api/platforms/runtime/stop-all', async route => {
    actionPostEntered.resolve();
    await releaseActionPost.promise;
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, platforms: [{ code: 'douyin', desired_state: 'STOPPED' }] })
    });
  });
  await page.route('**/api/mini-program/**', async route => {
    const pathname = new URL(route.request().url()).pathname;
    const payload = pathname === '/api/mini-program/status'
      ? { ok: true, status: { counts: {} } }
      : pathname === '/api/mini-program/conversations'
        ? { ok: true, conversations: [] }
        : null;
    if (!payload) return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ ok: false }) });
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(payload) });
  });

  await page.goto(runtime.base);
  await openWorkspacePage(page, 'platforms');
  await page.locator('.platform-runtime-page-head').waitFor();
  await page.evaluate(() => {
    const button = document.querySelector('#stopAllPlatforms');
    const handler = button.onclick;
    button.onclick = function(event) {
      const action = handler.call(this, event);
      window.__staleActionDone = Promise.resolve(action);
      return action;
    };
  });
  await page.locator('#stopAllPlatforms').click();
  await page.getByRole('button', { name: '确认全部停止', exact: true }).click();
  await actionPostEntered.promise;

  holdMiniBootstrap = true;
  await openWorkspacePage(page, 'miniProgram');
  await miniBootstrapEntered.promise;
  releaseActionPost.resolve();
  await page.evaluate(() => window.__staleActionDone);
  releaseMiniBootstrap.resolve();

  assert.equal(bootstrapRequestsAfterMiniNavigation, 1, '旧 action 不得为新页面分配 bootstrap token 或发起请求');
  await page.locator('.mini-program-page').waitFor();
  assert.equal(await page.locator('#workspaceSubnav button[data-workspace-item="mini-program"].active').count(), 1);
  assert.equal(await page.locator('.mini-program-page').count(), 1);
  assert.equal(await page.locator('.platform-runtime-page-head').count(), 0);
});

test('旧平台刷新晚于小程序渲染返回时不能重绘已提交的新页面', { skip: !chromePath }, async t => {
  const runtime = await startServer();
  t.after(async () => { await stopChild(runtime.child); cleanupDir(runtime.dir); });
  const browser = await chromium.launch({ headless: true, executablePath: chromePath });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const actionRefreshEntered = deferred();
  const releaseActionRefresh = deferred();
  let holdActionRefresh = false;
  let bootstrapRequestsAfterAction = 0;

  await page.route('**/api/bootstrap', async route => {
    const response = await route.fetch();
    const payload = await response.json();
    payload.config = { ...payload.config, activePlatformCodes: ['douyin'] };
    payload.platforms = [{
      code: 'douyin', name: '抖音', lifecycle_state: 'ACTIVE', desired_state: 'RUNNING',
      effective_state: 'RUNNING', task_execution_state: 'RUNNING', running_job_count: 0
    }];
    payload.accounts = [{
      id: 1, platform_code: 'douyin', platform_name: '抖音', display_name: '竞态测试账号',
      profile_name: 'race-profile', enabled: 1, login_status: 'LOGGED_IN'
    }];
    if (holdActionRefresh) {
      bootstrapRequestsAfterAction += 1;
      if (bootstrapRequestsAfterAction === 1) {
        actionRefreshEntered.resolve();
        await releaseActionRefresh.promise;
      }
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(payload) });
  });
  await page.route('**/api/platforms/runtime/stop-all', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ ok: true, platforms: [{ code: 'douyin', desired_state: 'STOPPED' }] })
  }));
  await page.route('**/api/mini-program/**', async route => {
    const pathname = new URL(route.request().url()).pathname;
    const payload = pathname === '/api/mini-program/status'
      ? { ok: true, status: { counts: {} } }
      : pathname === '/api/mini-program/conversations'
        ? { ok: true, conversations: [] }
        : null;
    if (!payload) return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ ok: false }) });
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(payload) });
  });

  await page.goto(runtime.base);
  await openWorkspacePage(page, 'platforms');
  await page.locator('.platform-runtime-page-head').waitFor();
  await page.evaluate(() => {
    const button = document.querySelector('#stopAllPlatforms');
    const handler = button.onclick;
    button.onclick = function(event) {
      const action = handler.call(this, event);
      window.__staleActionDone = Promise.resolve(action);
      return action;
    };
  });
  holdActionRefresh = true;
  await page.locator('#stopAllPlatforms').click();
  await page.getByRole('button', { name: '确认全部停止', exact: true }).click();
  await actionRefreshEntered.promise;

  await openWorkspacePage(page, 'miniProgram');
  await page.locator('.mini-program-page').waitFor();
  assert.equal(await page.locator('.mini-program-page').count(), 1, '新页面必须先完整提交');
  await page.evaluate(() => {
    window.__stalePlatformRedraws = 0;
    window.__stalePlatformObserver = new MutationObserver(records => {
      window.__stalePlatformRedraws += records.filter(record => record.type === 'childList').length;
    });
    window.__stalePlatformObserver.observe(document.querySelector('#content'), { childList: true });
  });

  releaseActionRefresh.resolve();
  await page.evaluate(async () => {
    await window.__staleActionDone;
    await new Promise(resolve => queueMicrotask(resolve));
  });

  assert.equal(await page.evaluate(() => window.__stalePlatformRedraws), 0, '旧 action handler 结束前不得重绘平台页');
  assert.equal(await page.locator('#nav button[data-workspace="inbox"].active').count(), 1);
  assert.equal(await page.locator('#workspaceSubnav button[data-workspace-item="mini-program"].active').count(), 1);
  assert.equal(await page.locator('.mini-program-page').count(), 1);
  assert.equal(await page.locator('.platform-runtime-page-head').count(), 0);
  await page.evaluate(() => window.__stalePlatformObserver.disconnect());
});

test('离开再返回小程序页面时旧数据响应不能抢在新 bootstrap 前提交', { skip: !chromePath }, async t => {
  const runtime = await startServer();
  t.after(async () => { await stopChild(runtime.child); cleanupDir(runtime.dir); });
  const browser = await chromium.launch({ headless: true, executablePath: chromePath });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const staleListEntered = deferred();
  const releaseStaleList = deferred();
  const reentryBootstrapEntered = deferred();
  const releaseReentryBootstrap = deferred();
  let holdReentryBootstrap = false;
  let processingListCount = 0;

  await page.route('**/api/bootstrap', async route => {
    const response = await route.fetch();
    if (holdReentryBootstrap) {
      holdReentryBootstrap = false;
      reentryBootstrapEntered.resolve();
      await releaseReentryBootstrap.promise;
    }
    return route.fulfill({ response });
  });
  await page.route('**/api/mini-program/**', async route => {
    const url = new URL(route.request().url());
    let payload;
    if (url.pathname === '/api/mini-program/status') payload = { ok: true, status: { counts: {} } };
    else if (url.pathname === '/api/mini-program/conversations') {
      const filter = url.searchParams.get('status') || 'ALL';
      if (filter === 'PROCESSING') {
        processingListCount += 1;
        if (processingListCount === 1) {
          staleListEntered.resolve();
          await releaseStaleList.promise;
          payload = { ok: true, conversations: [{ ...conversations()[0], id: 202, userId: 'stale-reentry-user', conversationId: 'stale-reentry-conversation' }] };
        } else payload = { ok: true, conversations: [{ ...conversations()[0], id: 303, userId: 'latest-reentry-user', conversationId: 'latest-reentry-conversation' }] };
      } else payload = { ok: true, conversations: [conversations()[0]] };
    } else if (url.pathname === '/api/mini-program/conversations/101/messages') payload = { ok: true, ...messagesFor(101) };
    else if (url.pathname === '/api/mini-program/conversations/202/messages') payload = { ok: true, conversation: { ...conversations()[0], id: 202, userId: 'stale-reentry-user', conversationId: 'stale-reentry-conversation' }, messages: [{ ...messagesFor(101).messages[0], text: '旧页面响应' }] };
    else if (url.pathname === '/api/mini-program/conversations/303/messages') payload = { ok: true, conversation: { ...conversations()[0], id: 303, userId: 'latest-reentry-user', conversationId: 'latest-reentry-conversation' }, messages: [{ ...messagesFor(101).messages[0], text: '最新页面响应' }] };
    else return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ ok: false }) });
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(payload) });
  });

  await page.goto(runtime.base);
  await openWorkspacePage(page, 'miniProgram');
  await page.locator('.mini-program-page').waitFor();
  await page.getByRole('button', { name: 'AI 处理中', exact: true }).click();
  await staleListEntered.promise;
  await openWorkspacePage(page, 'dashboard');
  await page.locator('.operations-dashboard').waitFor();
  holdReentryBootstrap = true;
  await openWorkspacePage(page, 'miniProgram');
  await reentryBootstrapEntered.promise;
  releaseStaleList.resolve();
  await delay(250);
  assert.equal(await page.locator('.mini-program-page').count(), 0);
  assert.doesNotMatch(await page.locator('#content').innerText(), /stale-reentry|旧页面响应/);

  releaseReentryBootstrap.resolve();
  await page.waitForFunction(() => document.querySelector('.mini-program-detail')?.textContent.includes('最新页面响应'));
  assert.match(await page.locator('.mini-program-page').innerText(), /latest-reentry-user|latest-reentry-conversation|最新页面响应/);
  assert.doesNotMatch(await page.locator('.mini-program-page').innerText(), /stale-reentry|旧页面响应/);
});

test('小程序消息仅按严格有效时间排序且无效时间排在有效消息之后', { skip: !chromePath }, async t => {
  const runtime = await startServer();
  t.after(async () => { await stopChild(runtime.child); cleanupDir(runtime.dir); });
  const browser = await chromium.launch({ headless: true, executablePath: chromePath });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const conversation = conversations()[0];
  const baseMessage = messagesFor(101).messages[0];

  await page.route('**/api/mini-program/**', async route => {
    const url = new URL(route.request().url());
    let payload;
    if (url.pathname === '/api/mini-program/status') payload = { ok: true, status: { counts: {} } };
    else if (url.pathname === '/api/mini-program/conversations') payload = { ok: true, conversations: [conversation] };
    else if (url.pathname === '/api/mini-program/conversations/101/messages') payload = { ok: true, conversation, messages: [
      { ...baseMessage, id: 12, messageId: 'later', text: '较晚消息', receivedAt: '2026-09-05T10:00:00.000Z' },
      { ...baseMessage, id: 13, messageId: 'invalid', text: '无效日期消息', receivedAt: 'not-a-date', sentAt: 'also-not-a-date' },
      { ...baseMessage, id: 11, messageId: 'earlier', text: '较早消息', receivedAt: '2026-09-05T09:00:00.000Z' }
    ] };
    else return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ ok: false }) });
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(payload) });
  });

  await page.goto(runtime.base);
  await openWorkspacePage(page, 'miniProgram');
  await page.locator('.mini-program-message').first().waitFor();
  assert.deepEqual(await page.locator('.mini-program-inbound p').allTextContents(), ['较早消息', '较晚消息', '无效日期消息']);
  assert.equal(await page.locator('.mini-program-message').last().locator('time').innerText(), '—');
});

test('小程序管理响应中的文本对象统一安全降级且不会中断渲染', { skip: !chromePath }, async t => {
  const runtime = await startServer();
  t.after(async () => { await stopChild(runtime.child); cleanupDir(runtime.dir); });
  const browser = await chromium.launch({ headless: true, executablePath: chromePath });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const toxicText = { toString: 'not-callable', valueOf: 'not-callable' };
  const detailSeen = deferred();
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));

  await page.route('**/api/mini-program/**', async route => {
    const url = new URL(route.request().url());
    let payload;
    if (url.pathname === '/api/mini-program/status') payload = { ok: true, status: { counts: {} } };
    else if (url.pathname === '/api/mini-program/conversations') payload = { ok: true, conversations: [{ ...conversations()[0], userId: toxicText, conversationId: toxicText, lastTextPreview: toxicText }] };
    else if (url.pathname === '/api/mini-program/conversations/101/messages') {
      detailSeen.resolve();
      payload = { ok: true, conversation: { ...conversations()[0], userId: toxicText, conversationId: toxicText }, messages: [{
        ...messagesFor(101).messages[0],
        messageId: toxicText,
        text: toxicText,
        replyText: toxicText,
        knowledgeQuestionSnapshot: toxicText,
        callback: { id: 401, status: 'FAILED', attemptCount: 1, error: toxicText, retryable: true }
      }] };
    } else return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ ok: false }) });
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(payload) });
  });

  await page.goto(runtime.base);
  await openWorkspacePage(page, 'miniProgram');
  await detailSeen.promise;
  await delay(150);
  assert.equal(await page.locator('.mini-program-page').count(), 1);
  assert.deepEqual(pageErrors, []);
  const text = await page.locator('.mini-program-page').innerText();
  assert.match(text, /未知用户|会话 —|暂无已保存文字|用户文字\s+—|未命中知识问法/);
  assert.doesNotMatch(text, /\[object Object\]|not-callable|页面加载失败/);
  assert.equal(await page.locator('.mini-program-retry-callback').count(), 1);
});
