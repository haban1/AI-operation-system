import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import {
  AssistedPlatformRpaAdapter,
  classifyReplyTargetState,
  isolatedCollectionFailure
} from '../agent/rpa-adapters/assisted-platform.js';
import { WechatChannelsAssistedRpaAdapter } from '../agent/rpa-adapters/wechat-channels-assisted.js';

const root = path.resolve(import.meta.dirname, '..');

function mockEvidencePage() {
  return {
    url: () => 'https://creator.douyin.com/creator-micro/data/following/chat',
    frames() { return [this]; },
    locator(selector) {
      return {
        allInnerTexts: async () => selector === 'body' ? ['message page ready'] : [],
        evaluateAll: async () => ''
      };
    },
    waitForTimeout: async () => {}
  };
}

test('collectMessages 私信优先且评论异常不会阻断私信结果', async () => {
  const adapter = Object.create(AssistedPlatformRpaAdapter.prototype);
  const page = mockEvidencePage();
  const order = [];
  adapter.platformCode = 'douyin';
  adapter.spec = { name: '抖音', messageUrl: 'https://example.test/messages', commentUrl: 'https://example.test/comments' };
  adapter.getPage = async () => page;
  adapter.prepareMessagePage = async (_page, item) => {
    order.push(item.type);
    if (item.type === 'COMMENT') {
      const error = new Error('page.goto: Timeout 30000ms exceeded');
      error.name = 'TimeoutError';
      throw error;
    }
    return { ok: true };
  };
  adapter.inspectLoginState = async () => ({ state: 'READY' });
  adapter.waitForMessageContentReady = async () => ({ ready: true, empty: false, pageCheck: { valid: true, reason: 'VERIFIED_PAGE' } });
  adapter.extractMessages = async (_page, type) => type === 'PRIVATE_MESSAGE' ? [{ externalId: 'pm-1', messageType: type, content: '你好' }] : [];
  adapter.inspectPrivateMessageCoverage = async () => ({ ambiguous: false, strangerInboxVisible: false });
  adapter.evidence = async (_payload, message, _page, stage, extra = {}) => ({ message, stage, ...extra });

  const output = await adapter.collectMessages({ types: ['COMMENT', 'PRIVATE_MESSAGE'] });
  assert.deepEqual(order, ['PRIVATE_MESSAGE', 'COMMENT']);
  assert.equal(output.status, 'NEEDS_CONFIRMATION');
  assert.equal(output.result.messages.length, 1);
  assert.equal(output.result.typeResults.find(item => item.type === 'PRIVATE_MESSAGE').status, 'SUCCESS');
  const comment = output.result.typeResults.find(item => item.type === 'COMMENT');
  assert.equal(comment.status, 'DEFERRED_PAGE_UNAVAILABLE');
  assert.equal(comment.reason, 'NAVIGATION_TIMEOUT');
});

test('只有完整列表验证后才判定 SOURCE_GONE，否则延后', async () => {
  assert.deepEqual(classifyReplyTargetState({
    reason: 'COMMENT_TARGET_NOT_FOUND', exhausted: true, listVerifiedComplete: true,
    lastAdvance: { attempted: true, moved: false, verifiedList: true }
  }), {
    sourceState: 'SOURCE_GONE', decision: 'SKIP_SOURCE_GONE', retrySafe: false,
    reason: 'COMMENT_TARGET_NOT_FOUND', listVerifiedComplete: true
  });
  assert.equal(classifyReplyTargetState({
    reason: 'COMMENT_TARGET_NOT_FOUND', exhausted: true,
    lastAdvance: { attempted: true, moved: false, verifiedList: false }
  }).sourceState, 'DEFERRED_PAGE_UNAVAILABLE');
  assert.equal(classifyReplyTargetState({ reason: 'COMMENT_TARGET_NOT_FOUND', exhausted: false }).sourceState, 'DEFERRED_PAGE_UNAVAILABLE');
  assert.equal(isolatedCollectionFailure('COMMENT', new Error('net::ERR_TIMED_OUT')).sourceState, 'DEFERRED_PAGE_UNAVAILABLE');
});

test('列表到底只有二次稳定且无 loading/load-more 才能确认完整，宽泛容器不能证明完整', async () => {
  const adapter = Object.create(AssistedPlatformRpaAdapter.prototype);
  adapter.spec = { commentScrollSelectors: [] };
  adapter.assertRuntimeAllowed = async () => {};
  let calls = 0;
  const stablePage = {
    waitForTimeout: async () => {},
    evaluate: async (_fn, options) => {
      calls += 1;
      if (calls === 1) {
        assert.equal(options.entries.find(item => item.selector === '.comment-item')?.trusted, true);
        return { attempted: true, moved: false, verifiedList: false, proofCandidate: true, selector: '.comment-item', elementIndex: 0, ancestorDepth: 1, scrollHeight: 900, visibleRowCount: 2, visibleRowSignature: 'a|b', atEnd: true, loadingOrLoadMoreVisible: false, before: 500 };
      }
      return { attempted: true, moved: false, verifiedList: false, selector: '.comment-item', elementIndex: 0, ancestorDepth: 1, scrollHeight: 900, visibleRowCount: 2, visibleRowSignature: 'a|b', atEnd: true, loadingOrLoadMoreVisible: false };
    }
  };
  const stable = await adapter.advanceHistoricalCommentList(stablePage, { selectors: ['.comment-item'], settleMs: 100 });
  assert.equal(stable.verifiedList, true);
  assert.equal(stable.confirmationCount, 2);
  assert.equal(calls, 2);

  const broadPage = {
    waitForTimeout: async () => { throw new Error('宽泛容器不应进入确认等待'); },
    evaluate: async (_fn, options) => {
      assert.equal(options.entries.find(item => item.selector === '.feeds-container')?.trusted, false);
      return { attempted: true, moved: false, verifiedList: false, proofCandidate: false, reason: 'CONTAINER_AT_END_PENDING_CONFIRMATION' };
    }
  };
  const broad = await adapter.advanceHistoricalCommentList(broadPage, { selectors: ['.feeds-container'], settleMs: 100 });
  assert.equal(broad.verifiedList, false);
});

test('fallback context stop 后有界清除 Runtime fallbackActive 标记', async () => {
  const calls = [];
  const adapter = Object.create(AssistedPlatformRpaAdapter.prototype);
  adapter.platformCode = 'douyin';
  adapter.lifecycleGeneration = 0;
  adapter.context = { close: async () => { calls.push('close'); } };
  adapter.launching = null;
  adapter.activePage = null;
  adapter.profileDir = '';
  adapter.profileProcessIds = [];
  adapter.browserExecution = { providerUsed: 'playwright', fallbackUsed: true };
  adapter.browserRuntimeManager = {
    prepareForWebAccessTakeover: async options => {
      calls.push(options);
      await options.releaseFallback();
      return { readyForTakeover: true };
    }
  };
  await adapter.stop();
  assert.equal(calls[0], 'close');
  assert.equal(calls[1].platformCode, 'douyin');
  assert.equal(calls[1].timeoutMs, 750);
  assert.equal(typeof calls[1].releaseFallback, 'function');
});

test('抖音/视频号评论目标查找默认最多四轮，未扫完整时不误判删除', async () => {
  const adapter = Object.create(AssistedPlatformRpaAdapter.prototype);
  let locateCalls = 0;
  adapter.platformCode = 'douyin';
  adapter.spec = { commentScrollSelectors: [] };
  adapter.assertRuntimeAllowed = async () => {};
  adapter.locateMessageContainer = async () => { locateCalls += 1; return { ok: false, reason: 'COMMENT_TARGET_NOT_FOUND' }; };
  adapter.advanceHistoricalCommentList = async () => ({ attempted: true, moved: true, reason: 'SCROLLED_CONTAINER' });
  const result = await adapter.locateMessageContainerWithRetry({ waitForTimeout: async () => {} }, { messageType: 'COMMENT' }, { delayMs: 1, timeBudgetMs: 60000 });
  assert.equal(locateCalls, 4);
  assert.equal(result.locateAttempts, 4);
  assert.equal(result.listVerifiedComplete, false);
  assert.equal(classifyReplyTargetState(result).sourceState, 'DEFERRED_PAGE_UNAVAILABLE');

  const wechat = Object.create(WechatChannelsAssistedRpaAdapter.prototype);
  wechat.platformCode = 'wechat_channels';
  wechat.assertRuntimeAllowed = async () => {};
  wechat.readWechatCommentVideoRows = async () => [{ index: 0, visible: true, title: '仍存在的视频', time: '昨天', count: 0, text: '仍存在的视频 昨天 0' }];
  wechat.openWechatCommentVideoRow = async () => ({ ok: false, reason: 'COMMENT_VIDEO_EMPTY_UNVERIFIED', emptyConfirmations: 0 });
  const zeroOnly = await wechat.openWechatCommentVideoForPayload({ waitForTimeout: async () => {} }, { messageContext: { sourceVideoTitle: '仍存在的视频', sourceVideoTime: '昨天' } });
  assert.equal(zeroOnly.reason, 'COMMENT_VIDEO_EMPTY_UNVERIFIED');
  assert.equal(zeroOnly.listVerifiedComplete, false);
  assert.equal(zeroOnly.zeroCountConfirmations, 2);
  assert.equal(classifyReplyTargetState(zeroOnly).sourceState, 'DEFERRED_PAGE_UNAVAILABLE');

  wechat.openWechatCommentVideoRow = async () => ({ ok: true, empty: true, reason: 'COMMENT_VIDEO_EMPTY_CONFIRMED', emptyConfirmations: 2, panelEvidence: { panelVisible: true, explicitEmpty: true, loadingOrLoadMoreVisible: false, visibleCommentCount: 0 } });
  const gone = await wechat.openWechatCommentVideoForPayload({ waitForTimeout: async () => {} }, { messageContext: { sourceVideoTitle: '仍存在的视频', sourceVideoTime: '昨天' } });
  assert.equal(gone.reason, 'COMMENT_TARGET_NOT_FOUND');
  assert.equal(gone.listVerifiedComplete, true);
  assert.equal(classifyReplyTargetState(gone).sourceState, 'SOURCE_GONE');

  wechat.readWechatCommentVideoRows = async () => [{ index: 0, visible: true, title: '仍存在的视频', time: '昨天', count: null, text: '仍存在的视频 昨天' }];
  const unresolved = await wechat.openWechatCommentVideoForPayload({ waitForTimeout: async () => {} }, { messageContext: { sourceVideoTitle: '仍存在的视频', sourceVideoTime: '昨天' } });
  assert.equal(unresolved.reason, 'COMMENT_VIDEO_COUNT_UNAVAILABLE');
  assert.equal(unresolved.listVerifiedComplete, false);
  assert.equal(classifyReplyTargetState(unresolved).sourceState, 'DEFERRED_PAGE_UNAVAILABLE');
});

async function freePort() {
  const server = http.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function request(base, pathname, options = {}) {
  const response = await fetch(base + pathname, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }
  });
  const data = await response.json();
  return { response, data };
}

async function waitFor(base) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(base + '/api/health');
      if (response.ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('测试服务启动超时');
}

async function withServer(t, runTest) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'message-collection-isolation-'));
  const databasePath = path.join(dir, 'test.db');
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      DATABASE_PATH: databasePath,
      AUTH_ENABLED: 'false',
      AGENT_SHARED_TOKEN: '',
      QWEN_MODE: 'mock',
      RPA_MODE: 'simulated',
      AUTO_COLLECT_ENABLED: 'false',
      LOCAL_AGENT_AUTO_START: 'false',
      INSTANCE_LOCK_ENABLED: 'false'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stderr = '';
  let db = null;
  child.stderr.on('data', chunk => { stderr += chunk; });
  t.after(async () => {
    try { db?.close(); } catch {}
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await Promise.race([new Promise(resolve => child.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 3000))]);
    }
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  await waitFor(base);
  db = new DatabaseSync(databasePath);
  db.exec('PRAGMA busy_timeout=15000');
  await runTest({ base, db, stderr: () => stderr });
}

function insertMessageAndReplyJob(db, account, suffix) {
  const stamp = new Date().toISOString();
  const externalId = `source-state-${suffix}-${Date.now()}`;
  const messageId = Number(db.prepare(`INSERT INTO messages(platform_code,account_id,message_type,external_id,user_name,content,status,decision,reply_text,context_json,created_at,updated_at)
    VALUES(?,?,?,?,?,?,'REPLY_RUNNING','AUTO_REPLY','测试回复','{}',?,?)`).run(account.platform_code, account.id, 'COMMENT', externalId, '测试用户', '测试内容', stamp, stamp).lastInsertRowid);
  const payload = JSON.stringify({ messageId, platformCode: account.platform_code, accountId: account.id, messageType: 'COMMENT' });
  const runningJobId = Number(db.prepare(`INSERT INTO agent_jobs(device_id,job_type,payload,status,attempts,created_at,claimed_at) VALUES(?,'REPLY',?,'RUNNING',1,?,?)`).run(account.device_id, payload, stamp, stamp).lastInsertRowid);
  const queuedJobId = Number(db.prepare(`INSERT INTO agent_jobs(device_id,job_type,payload,status,attempts,created_at) VALUES(?,'REPLY',?,'QUEUED',0,?)`).run(account.device_id, payload, stamp).lastInsertRowid);
  db.prepare('UPDATE messages SET reply_job_id=? WHERE id=?').run(runningJobId, messageId);
  return { messageId, runningJobId, queuedJobId, externalId };
}

test('服务端 SOURCE_GONE 只完成当前回复并释放消息回复锁', async t => {
  await withServer(t, async ({ base, db, stderr }) => {
    const bootstrap = (await request(base, '/api/bootstrap')).data;
    const account = bootstrap.accounts.find(item => item.platform_code === 'douyin');
    assert.ok(account, stderr());
    const ids = insertMessageAndReplyJob(db, account, 'gone');
    const issueStamp = new Date().toISOString();
    db.prepare(`INSERT INTO issues(source,category,level,title,detail,status,related_type,related_id,created_at,updated_at) VALUES('RPA','REPLY','ERROR','回复故障','测试','OPEN','MESSAGE',?,?,?)`).run(String(ids.messageId), issueStamp, issueStamp);
    db.prepare(`INSERT INTO issues(source,category,level,title,detail,status,related_type,related_id,created_at,updated_at) VALUES('WECOM','NOTIFICATION','ERROR','通知故障','测试','OPEN','MESSAGE',?,?,?)`).run(String(ids.messageId), issueStamp, issueStamp);
    db.prepare(`INSERT INTO knowledge_gaps(message_id,normalized_question,status,created_at,updated_at) VALUES(?,?,'PENDING',?,?)`).run(ids.messageId, '测试内容', new Date().toISOString(), new Date().toISOString());

    const completed = await request(base, `/api/agent/jobs/${ids.runningJobId}/complete`, {
      method: 'POST',
      body: JSON.stringify({ status: 'CANCELLED', result: { sourceState: 'SOURCE_GONE', decision: 'SKIP_SOURCE_GONE', message: '完整列表确认内容已删除' } })
    });
    assert.equal(completed.response.status, 200, stderr());
    const message = db.prepare('SELECT * FROM messages WHERE id=?').get(ids.messageId);
    assert.equal(message.status, 'SOURCE_GONE');
    assert.equal(message.decision, 'SKIP_SOURCE_GONE');
    assert.equal(message.reply_job_id, null);
    assert.ok(message.handled_at);
    assert.equal(db.prepare('SELECT status FROM agent_jobs WHERE id=?').get(ids.queuedJobId).status, 'QUEUED');
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM knowledge_gaps WHERE message_id=?').get(ids.messageId).count, 0);
    assert.equal(db.prepare("SELECT status FROM issues WHERE related_id=? AND category='REPLY'").get(String(ids.messageId)).status, 'RESOLVED');
    assert.equal(db.prepare("SELECT status FROM issues WHERE related_id=? AND category='NOTIFICATION'").get(String(ids.messageId)).status, 'OPEN');

    const handled = insertMessageAndReplyJob(db, account, 'handled');
    db.prepare("UPDATE messages SET status='MANUAL_HANDLED',handled_at=?,handled_by='运营人员',handler_note='人工已完成' WHERE id=?").run(new Date().toISOString(), handled.messageId);
    const stale = await request(base, `/api/agent/jobs/${handled.runningJobId}/complete`, {
      method: 'POST',
      body: JSON.stringify({ status: 'CANCELLED', result: { sourceState: 'SOURCE_GONE', decision: 'SKIP_SOURCE_GONE', message: '迟到的旧任务结果' } })
    });
    assert.equal(stale.response.status, 200, stderr());
    const protectedMessage = db.prepare('SELECT * FROM messages WHERE id=?').get(handled.messageId);
    assert.equal(protectedMessage.status, 'MANUAL_HANDLED');
    assert.equal(protectedMessage.handler_note, '人工已完成');
  });
});

test('页面不可靠时延后回复且采集失败不创建账号级 collect 阻断', async t => {
  await withServer(t, async ({ base, db, stderr }) => {
    const bootstrap = (await request(base, '/api/bootstrap')).data;
    const account = bootstrap.accounts.find(item => item.platform_code === 'wechat_channels');
    assert.ok(account, stderr());
    const ids = insertMessageAndReplyJob(db, account, 'deferred');
    const deferred = await request(base, `/api/agent/jobs/${ids.runningJobId}/complete`, {
      method: 'POST',
      body: JSON.stringify({ status: 'NEEDS_CONFIRMATION', result: { sourceState: 'DEFERRED_PAGE_UNAVAILABLE', decision: 'DEFERRED_PAGE_UNAVAILABLE', message: '页面暂不可用' } })
    });
    assert.equal(deferred.response.status, 200, stderr());
    const message = db.prepare('SELECT * FROM messages WHERE id=?').get(ids.messageId);
    assert.equal(message.status, 'DEFERRED_PAGE_UNAVAILABLE');
    assert.equal(message.decision, 'DEFERRED_PAGE_UNAVAILABLE');
    assert.equal(message.reply_job_id, null);
    assert.equal(message.handled_at, null);

    const resumeStamp = new Date().toISOString();
    const resumeCollectId = Number(db.prepare(`INSERT INTO agent_jobs(device_id,job_type,payload,status,attempts,created_at,claimed_at) VALUES(?,'COLLECT_MESSAGES',?,'RUNNING',1,?,?)`).run(account.device_id, JSON.stringify({ platformCode: account.platform_code, accountId: account.id }), resumeStamp, resumeStamp).lastInsertRowid);
    const resumed = await request(base, `/api/agent/jobs/${resumeCollectId}/complete`, {
      method: 'POST',
      body: JSON.stringify({ status: 'SUCCESS', result: { messages: [{ externalId: ids.externalId, messageType: 'COMMENT', userName: '测试用户', content: '测试内容', context: { sourceVerified: true } }] } })
    });
    assert.equal(resumed.response.status, 200, stderr());
    const resumedMessage = db.prepare('SELECT * FROM messages WHERE id=?').get(ids.messageId);
    assert.notEqual(resumedMessage.status, 'DEFERRED_PAGE_UNAVAILABLE');
    assert.notEqual(resumedMessage.decision, 'DEFERRED_PAGE_UNAVAILABLE');

    const stamp = new Date().toISOString();
    const collectJobId = Number(db.prepare(`INSERT INTO agent_jobs(device_id,job_type,payload,status,attempts,created_at,claimed_at) VALUES(?,'COLLECT_MESSAGES',?,'RUNNING',1,?,?)`).run(account.device_id, JSON.stringify({ platformCode: account.platform_code, accountId: account.id }), stamp, stamp).lastInsertRowid);
    const collection = await request(base, `/api/agent/jobs/${collectJobId}/complete`, {
      method: 'POST',
      body: JSON.stringify({ status: 'FAILED', result: { sourceState: 'DEFERRED_PAGE_UNAVAILABLE', message: 'net::ERR_TIMED_OUT', typeResults: [{ type: 'COMMENT', status: 'DEFERRED_PAGE_UNAVAILABLE' }] } })
    });
    assert.equal(collection.response.status, 200, stderr());
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM issues WHERE category='MESSAGE_COLLECTION'").get().count, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM runtime_blocks WHERE feature='collect' AND status='ACTIVE'").get().count, 0);

    const manualCollect = await request(base, `/api/platforms/${account.platform_code}/collect`, {
      method: 'POST',
      body: JSON.stringify({ accountId: account.id, types: ['COMMENT'] })
    });
    assert.equal(manualCollect.response.status, 200, stderr());
    const payload = JSON.parse(db.prepare('SELECT payload FROM agent_jobs WHERE id=?').get(manualCollect.data.jobId).payload);
    assert.equal(Object.hasOwn(payload, 'noteCandidates'), false);

    const infraStamp = new Date().toISOString();
    const infraJobId = Number(db.prepare(`INSERT INTO agent_jobs(device_id,job_type,payload,status,attempts,created_at,claimed_at) VALUES(?,'COLLECT_MESSAGES',?,'RUNNING',1,?,?)`).run(account.device_id, JSON.stringify({ platformCode: account.platform_code, accountId: account.id }), infraStamp, infraStamp).lastInsertRowid);
    const infrastructureFailure = await request(base, `/api/agent/jobs/${infraJobId}/complete`, {
      method: 'POST',
      body: JSON.stringify({ status: 'FAILED', result: { createAccountCollectBlock: true, message: 'Profile 无法启动', typeResults: [{ type: 'COMMENT', status: 'DEFERRED_PAGE_UNAVAILABLE' }] } })
    });
    assert.equal(infrastructureFailure.response.status, 200, stderr());
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM issues WHERE category='MESSAGE_COLLECTION'").get().count, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM runtime_blocks WHERE feature='collect' AND status='ACTIVE'").get().count, 1);
  });
});


