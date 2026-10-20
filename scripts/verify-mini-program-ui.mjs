import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
import sharp from 'sharp';
import { cleanupDir, root, startServer, stopChild, tempRuntimeDir } from '../test/helpers/runtime.js';

const messagePath = '/open-api/v1/mini-program/messages';
const appId = 'visual-mini-program-app';
const secret = 'visual-mini-program-secret-at-least-32-characters';
const adminUsername = 'visual-admin';
const adminPassword = 'Visual-admin-password-2026!';
const outputDir = path.join(root, 'logs', 'smoke-tests');
const emptyPath = path.join(outputDir, 'mini-program-empty.png');
const desktopPath = path.join(outputDir, 'mini-program-desktop.png');
const mobilePath = path.join(outputDir, 'mini-program-mobile.png');

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

function signedHeaders(rawBody) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = crypto.randomUUID();
  const bodyHash = crypto.createHash('sha256').update(rawBody).digest('hex');
  const canonical = ['POST', messagePath, timestamp, nonce, bodyHash].join('\n');
  return {
    'Content-Type': 'application/json',
    'X-Mini-App-Id': appId,
    'X-Timestamp': timestamp,
    'X-Nonce': nonce,
    'X-Signature': crypto.createHmac('sha256', secret).update(canonical).digest('hex')
  };
}

async function ingest(base, payload) {
  const rawBody = Buffer.from(JSON.stringify(payload));
  const response = await fetch(base + messagePath, { method: 'POST', headers: signedHeaders(rawBody), body: rawBody });
  const text = await response.text();
  assert.equal(response.status, 202, text);
  const result = JSON.parse(text);
  assert.deepEqual(result, { ok: true, accepted: true, messageId: payload.messageId, status: 'ACCEPTED' });
}

function stamp(minutesAgo = 0) {
  return new Date(Date.now() - minutesAgo * 60_000).toISOString();
}

async function seedSignedMessages(base) {
  const samples = [
    {
      conversationId: 'consultation-with-a-very-long-id-20260906-000000000001',
      userId: 'user-with-a-very-long-id-20260906-000000000001',
      messageId: 'visual-callback-failed',
      text: '请问港澳居民居住证应该到哪里办理，需要准备哪些材料？',
      sentAt: stamp(0)
    },
    {
      conversationId: 'handoff-consultation-20260906-0002',
      userId: 'handoff-user-20260906-0002',
      messageId: 'visual-wecom-failed',
      text: '情况比较特殊，请安排工作人员联系我。',
      sentAt: stamp(1)
    },
    {
      conversationId: 'processing-consultation-20260906-0003',
      userId: 'processing-user-20260906-0003',
      messageId: 'visual-processing',
      text: '我正在澳门工作，办理材料是否有区别？',
      sentAt: stamp(2)
    },
    {
      conversationId: 'failed-consultation-20260906-0004',
      userId: 'failed-user-20260906-0004',
      messageId: 'visual-processing-failed',
      text: '提交资料后一直没有进度，应该如何查询？',
      sentAt: stamp(3)
    },
    {
      conversationId: 'managed-consultation-20260906-0005',
      userId: 'returning-human-user-20260906-0005',
      messageId: 'visual-human-managed',
      text: '这是之前人工跟进过的事项，我再补充一个问题。',
      sentAt: stamp(4)
    }
  ];
  for (const sample of samples) await ingest(base, { appId, ...sample });
  return samples;
}

async function prepareRepresentativeStates(dbPath, samples, env) {
  Object.assign(process.env, env, { DATABASE_PATH: dbPath });
  const { db, row, run } = await import('../src/db.js');
  const { enqueueMiniProgramReply } = await import('../src/services/mini-program-callback.js');
  const { requestMiniProgramHandoff } = await import('../src/services/mini-program-channel.js');
  const byMessageId = Object.fromEntries(samples.map(sample => [sample.messageId,
    row('SELECT * FROM messages WHERE external_id=?', `mini-program:${appId}:message:${sample.messageId}`)]));
  for (const [messageId, message] of Object.entries(byMessageId)) assert.ok(message?.id, `missing seeded message ${messageId}`);

  const callbackMessage = byMessageId['visual-callback-failed'];
  const callback = enqueueMiniProgramReply({
    message: callbackMessage,
    replyText: '居住证通常由居住地公安机关或受理点办理，请携带身份证明、居住证明及近期照片；具体材料以当地窗口要求为准。'
  });
  run("UPDATE messages SET status='REPLY_QUEUED',decision='RAG_ANSWERED',reply_text=?,knowledge_id=902,knowledge_question_snapshot=?,updated_at=? WHERE id=?",
    '居住证通常由居住地公安机关或受理点办理，请携带身份证明、居住证明及近期照片；具体材料以当地窗口要求为准。', '居住证办理地点与材料', stamp(0), callbackMessage.id);
  run("UPDATE mini_program_processing_jobs SET status='COMPLETED',attempt_count=1,claimed_at=NULL,lease_expires_at=NULL,last_error_code=NULL,last_error_message=NULL,completed_at=?,updated_at=? WHERE message_id=?",
    stamp(0), stamp(0), callbackMessage.id);
  run("UPDATE mini_program_callback_outbox SET status='FAILED',attempt_count=3,http_status=503,error_message='callback delivery failed',available_at=NULL,claimed_at=NULL,lease_expires_at=NULL,updated_at=? WHERE id=?", stamp(0), callback.id);

  const notificationMessage = byMessageId['visual-wecom-failed'];
  const notification = requestMiniProgramHandoff({ conversationId: notificationMessage.conversation_id, messageId: notificationMessage.id, reason: '用户主动要求人工协助' }).notification;
  run("UPDATE notifications SET status='FAILED',attempt_count=2,error_message='notification delivery failed',available_at=NULL,claimed_at=NULL,lease_expires_at=NULL,updated_at=? WHERE id=?", stamp(1), notification.id);

  const processingMessage = byMessageId['visual-processing'];
  run("UPDATE mini_program_processing_jobs SET status='RUNNING',attempt_count=1,claimed_at=?,lease_expires_at=?,updated_at=? WHERE message_id=?",
    stamp(2), '2099-01-01T00:00:00.000Z', stamp(2), processingMessage.id);

  const failedMessage = byMessageId['visual-processing-failed'];
  run("UPDATE mini_program_processing_jobs SET status='FAILED',attempt_count=max_attempts,claimed_at=NULL,lease_expires_at=NULL,last_error_code='MINI_PROGRAM_PROCESSING_ERROR',last_error_message='processing failed',completed_at=?,updated_at=? WHERE message_id=?",
    stamp(3), stamp(3), failedMessage.id);

  const managedMessage = byMessageId['visual-human-managed'];
  const managedNotification = requestMiniProgramHandoff({ conversationId: managedMessage.conversation_id, messageId: managedMessage.id, reason: '历史人工用户再次咨询' }).notification;
  run("UPDATE notifications SET status='CONFIRMED',attempt_count=1,error_message=NULL,sent_at=?,confirmed_at=?,available_at=NULL,claimed_at=NULL,lease_expires_at=NULL,updated_at=? WHERE id=?",
    stamp(4), stamp(4), stamp(4), managedNotification.id);
  run("UPDATE conversations SET handling_mode='HUMAN_MANAGED',handoff_confirmed_at=?,wecom_notified_at=?,updated_at=? WHERE id=?",
    stamp(4), stamp(4), stamp(4), managedMessage.conversation_id);
  run('UPDATE mini_program_users SET first_handoff_at=?,last_handoff_at=?,last_conversation_id=?,handoff_count=1,updated_at=? WHERE account_id=? AND external_user_id=?',
    stamp(4), stamp(4), managedMessage.conversation_id, stamp(4), managedMessage.account_id, managedMessage.user_name);

  for (const sample of samples) {
    const message = byMessageId[sample.messageId];
    run('UPDATE conversations SET last_message_at=?,updated_at=? WHERE id=?', sample.sentAt, sample.sentAt, message.conversation_id);
  }
  db.close();
}

async function login(page, base) {
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.locator('#loginScreen:not([hidden])').waitFor();
  await page.locator('#loginForm input[name="username"]').fill(adminUsername);
  await page.locator('#loginForm input[name="password"]').fill(adminPassword);
  await page.locator('#loginSubmit').click();
  await page.locator('.shell:not([hidden])').waitFor();
}

async function pageMetrics(page) {
  return page.evaluate(() => {
    const overlapParents = [
      ...document.querySelectorAll('.mini-program-summary-head'),
      ...document.querySelectorAll('.mini-program-summary-item'),
      ...document.querySelectorAll('.mini-program-list-head'),
      ...document.querySelectorAll('.mini-program-conversation-head'),
      ...document.querySelectorAll('.mini-program-detail-head'),
      ...document.querySelectorAll('.mini-program-detail-toolbar'),
      ...document.querySelectorAll('.mini-program-message > header'),
      ...document.querySelectorAll('.mini-program-message-actions')
    ];
    const overlaps = [];
    for (const parent of overlapParents) {
      const children = [...parent.children].filter(child => {
        const style = getComputedStyle(child);
        const rect = child.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
      });
      for (let index = 0; index < children.length; index += 1) for (const sibling of children.slice(index + 1)) {
        const first = children[index].getBoundingClientRect();
        const second = sibling.getBoundingClientRect();
        const overlapWidth = Math.min(first.right, second.right) - Math.max(first.left, second.left);
        const overlapHeight = Math.min(first.bottom, second.bottom) - Math.max(first.top, second.top);
        if (overlapWidth > 0.5 && overlapHeight > 0.5) overlaps.push(`${parent.className}: ${children[index].tagName}/${sibling.tagName}`);
      }
    }
    const ids = [...document.querySelectorAll('.mini-program-id, .mini-program-detail-head h3')];
    return {
      bodyOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      overlaps,
      clippedIds: ids.filter(node => node.scrollWidth > node.clientWidth + 1).map(node => node.textContent),
      replyInputs: document.querySelectorAll('.mini-program-page textarea, .mini-program-page input, .mini-program-page [contenteditable="true"]').length,
      hasReplyCommand: /发送回复|人工回复|send-reply|manual-reply/i.test(document.querySelector('.mini-program-page')?.innerText || ''),
      pageWidth: document.documentElement.clientWidth,
      conversationCount: document.querySelectorAll('.mini-program-conversation').length,
      messageCount: document.querySelectorAll('.mini-program-message').length,
      emptyCount: document.querySelectorAll('.mini-program-empty').length
    };
  });
}

function verifyMetrics(metrics, width, { empty = false } = {}) {
  assert.equal(metrics.pageWidth, width, JSON.stringify(metrics));
  assert.equal(metrics.bodyOverflow, false, JSON.stringify(metrics));
  assert.deepEqual(metrics.overlaps, [], JSON.stringify(metrics));
  assert.deepEqual(metrics.clippedIds, [], JSON.stringify(metrics));
  assert.equal(metrics.replyInputs, 0, JSON.stringify(metrics));
  assert.equal(metrics.hasReplyCommand, false, JSON.stringify(metrics));
  if (empty) {
    assert.equal(metrics.conversationCount, 0, JSON.stringify(metrics));
    assert.equal(metrics.messageCount, 0, JSON.stringify(metrics));
    assert.ok(metrics.emptyCount >= 2, JSON.stringify(metrics));
  } else {
    assert.ok(metrics.conversationCount >= 5, JSON.stringify(metrics));
    assert.ok(metrics.messageCount >= 1, JSON.stringify(metrics));
  }
}

async function verifyImage(file, width, height) {
  const metadata = await sharp(file).metadata();
  assert.equal(metadata.width, width, `${file} width`);
  assert.equal(metadata.height, height, `${file} height`);
  const stats = await sharp(file).stats();
  assert.ok(stats.channels.some(channel => channel.stdev > 4), `${file} appears blank`);
  assert.ok(fs.statSync(file).size > 20_000, `${file} is unexpectedly small`);
}

function monitorPage(page, base) {
  const diagnostics = { consoleErrors: [], pageErrors: [], failedRequests: [], httpErrors: [], channelRequests: [], responseChecks: [], leakedResponses: [] };
  page.on('console', message => { if (message.type() === 'error') diagnostics.consoleErrors.push(message.text()); });
  page.on('pageerror', error => diagnostics.pageErrors.push(error.message));
  page.on('requestfailed', request => diagnostics.failedRequests.push(`${request.method()} ${request.url()}`));
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.origin === base && (/mini-program|open-api|rag/i.test(url.pathname))) diagnostics.channelRequests.push({ method: request.method(), pathname: url.pathname });
  });
  page.on('response', response => {
    const url = new URL(response.url());
    if (url.origin === base && response.status() >= 400) diagnostics.httpErrors.push(`${response.status()} ${response.request().method()} ${url.pathname}`);
    if (url.origin !== base || !url.pathname.startsWith('/api/')) return;
    diagnostics.responseChecks.push(response.text().then(body => {
      if (body.includes(secret)) diagnostics.leakedResponses.push(`${response.request().method()} ${url.pathname}`);
    }).catch(() => {}));
  });
  return diagnostics;
}

async function verifyPageSafety(page, diagnostics) {
  await Promise.all(diagnostics.responseChecks);
  assert.deepEqual(diagnostics.consoleErrors, [], `browser console errors: ${JSON.stringify(diagnostics.consoleErrors)}`);
  assert.deepEqual(diagnostics.pageErrors, [], `browser page errors: ${JSON.stringify(diagnostics.pageErrors)}`);
  assert.deepEqual(diagnostics.failedRequests, [], `browser request failures: ${JSON.stringify(diagnostics.failedRequests)}`);
  assert.deepEqual(diagnostics.httpErrors, [], `browser HTTP errors: ${JSON.stringify(diagnostics.httpErrors)}`);
  assert.deepEqual(diagnostics.leakedResponses, [], `shared secret leaked in responses: ${JSON.stringify(diagnostics.leakedResponses)}`);
  assert.equal((await page.content()).includes(secret), false, 'shared secret leaked into rendered DOM');
  assert.equal(diagnostics.channelRequests.some(item => item.pathname.startsWith('/open-api/') || /rag/i.test(item.pathname)), false, JSON.stringify(diagnostics.channelRequests));
  assert.deepEqual(diagnostics.channelRequests.filter(item => !(
    item.method === 'GET' && (
      item.pathname === '/api/mini-program/status'
      || item.pathname === '/api/mini-program/conversations'
      || /^\/api\/mini-program\/conversations\/\d+\/messages$/.test(item.pathname)
    )
  )), [], JSON.stringify(diagnostics.channelRequests));
}

async function main() {
  const chromePath = installedChromePath();
  assert.ok(chromePath, 'Chrome executable was not found; set CHROME_EXECUTABLE_PATH');
  const runtimeDir = tempRuntimeDir('mini-program-ui-visual-');
  const env = {
    AUTH_ENABLED: 'true',
    ADMIN_USERNAME: adminUsername,
    ADMIN_PASSWORD: adminPassword,
    SESSION_SECRET: 'visual-session-secret-at-least-32-characters',
    SESSION_COOKIE_SECURE: 'false',
    INSTANCE_LOCK_ENABLED: 'true',
    MINI_PROGRAM_API_ENABLED: 'true',
    MINI_PROGRAM_APP_ID: appId,
    MINI_PROGRAM_SHARED_SECRET: secret,
    MINI_PROGRAM_CALLBACK_URL: 'http://127.0.0.1:65534/callbacks/mini-program/messages',
    WECOM_WEBHOOK_URL: '',
    QWEN_MODE: 'mock',
    RPA_MODE: 'simulated',
    AUTO_COLLECT_ENABLED: 'false',
    LOCAL_AGENT_AUTO_START: 'false'
  };
  let runtime;
  let browser;
  try {
    fs.mkdirSync(outputDir, { recursive: true });
    runtime = await startServer({ dir: runtimeDir, env });
    browser = await chromium.launch({ headless: true, executablePath: chromePath });
    const emptyPage = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const emptyDiagnostics = monitorPage(emptyPage, runtime.base);
    await login(emptyPage, runtime.base);
    await emptyPage.locator('#nav button[data-page="miniProgram"]').click();
    await emptyPage.locator('.mini-program-page').waitFor();
    await emptyPage.waitForFunction(() => document.querySelectorAll('.mini-program-empty').length === 2);
    const emptyText = await emptyPage.locator('.mini-program-page').innerText();
    assert.match(emptyText, /暂无符合条件的会话/);
    assert.match(emptyText, /请选择一个会话/);
    const emptyMetrics = await pageMetrics(emptyPage);
    verifyMetrics(emptyMetrics, 1440, { empty: true });
    await emptyPage.screenshot({ path: emptyPath });
    await verifyImage(emptyPath, 1440, 1000);
    await verifyPageSafety(emptyPage, emptyDiagnostics);
    await browser.close();
    browser = null;

    const samples = await seedSignedMessages(runtime.base);
    await stopChild(runtime.child);
    await prepareRepresentativeStates(runtime.dbPath, samples, env);

    runtime = await startServer({ dir: runtimeDir, env });
    browser = await chromium.launch({ headless: true, executablePath: chromePath });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const diagnostics = monitorPage(page, runtime.base);
    await login(page, runtime.base);
    await page.locator('#nav button[data-page="miniProgram"]').click();
    await page.locator('.mini-program-page').waitFor();
    await page.locator('.mini-program-message').first().waitFor();
    await page.waitForFunction(() => document.querySelectorAll('.mini-program-conversation').length >= 5);

    const desktopMetrics = await pageMetrics(page);
    verifyMetrics(desktopMetrics, 1440);
    await page.screenshot({ path: desktopPath });
    await verifyImage(desktopPath, 1440, 1000);

    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('.mini-program-detail-head').scrollIntoViewIfNeeded();
    await page.evaluate(() => window.scrollBy(0, -(document.querySelector('.topbar')?.getBoundingClientRect().height || 0) - 12));
    const mobileMetrics = await pageMetrics(page);
    verifyMetrics(mobileMetrics, 390);
    await page.screenshot({ path: mobilePath });
    await verifyImage(mobilePath, 390, 844);

    await verifyPageSafety(page, diagnostics);

    console.log(`mini-program UI verified: ${emptyPath} (1440x1000 empty)`);
    console.log(`mini-program UI verified: ${desktopPath} (1440x1000)`);
    console.log(`mini-program UI verified: ${mobilePath} (390x844)`);
  } finally {
    if (browser) await browser.close();
    if (runtime?.child) await stopChild(runtime.child);
    cleanupDir(runtimeDir);
  }
}

await main();
