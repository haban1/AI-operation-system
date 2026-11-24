import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const root = path.resolve(import.meta.dirname, '..');

async function listen(server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return server.address().port;
}

async function request(base, pathname, options = {}) {
  const response = await fetch(base + pathname, { ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } });
  return { response, data: await response.json() };
}

async function waitFor(base) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { if ((await fetch(`${base}/api/health`)).ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('测试服务启动超时');
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

const douyinEvidence = dir => ({
  message: '回复已发送并确认', stage: 'reply_sent', sendMethod: 'ENTER',
  evidencePath: path.join(dir, 'reply-evidence.json'), screenshotPath: path.join(dir, 'reply.png'),
  targetIdentityVerified: true, uniqueTargetMatch: true, editorCleared: true, scopedEchoCount: 1, baselineEchoCount: 0
});

test('转人工回执、人工接待面板、接管与交还 AI、闲置自动交还', async t => {
  const ragRequests = [];
  const ragServer = http.createServer(async (req, res) => {
    const payload = await readJson(req);
    ragRequests.push(payload);
    const question = String(payload?.query?.text || '');
    const base = { requestId: payload.requestId, snapshot: payload.snapshot, meta: { knowledgeVersion: 'test-release-1' } };
    const body = question.includes('材料')
      ? { ...base, result: 'ANSWERED', answer: { text: '请携带身份证到服务窗口办理。' }, grounding: { confidence: 0.9, sourceReferences: [{ documentId: 'doc-m', documentVersion: 1, chunkId: 'chunk-m', title: '办理材料清单', verificationStatus: 'VERIFIED' }] } }
      : { ...base, result: 'NO_ANSWER', reasonCode: 'INSUFFICIENT_EVIDENCE', grounding: { confidence: 0, sourceReferences: [] }, diagnostics: { selectedCandidates: [] } };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  const ragPort = await listen(ragServer);
  t.after(() => new Promise(resolve => ragServer.close(resolve)));

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-workspace-'));
  const dbPath = path.join(dir, 'test.db');
  const probe = http.createServer();
  const appPort = await listen(probe);
  await new Promise(resolve => probe.close(resolve));
  const base = `http://127.0.0.1:${appPort}`;
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: root,
    env: {
      ...process.env, PORT: String(appPort), DATABASE_PATH: dbPath,
      AUTH_ENABLED: 'false', AGENT_SHARED_TOKEN: '', QWEN_MODE: 'mock', RPA_MODE: 'simulated',
      AUTO_COLLECT_ENABLED: 'false', LOCAL_AGENT_AUTO_START: 'false', INSTANCE_LOCK_ENABLED: 'false',
      RAG_FORMAL_ROUTING_ENABLED: 'true', RAG_BASE_URL: `http://127.0.0.1:${ragPort}`, RAG_TIMEOUT_MS: '2000', WECOM_WEBHOOK_URL: '',
      HANDOFF_IDLE_RELEASE_HOURS: '1', HANDOFF_IDLE_SCAN_INTERVAL_MS: '200', HANDOFF_SERVICE_HOURS: ''
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await Promise.race([new Promise(resolve => child.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 3000))]);
    }
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  await waitFor(base).catch(error => { throw new Error(`${error.message}\n${stderr}`); });
  const account = (await request(base, '/api/bootstrap')).data.accounts.find(item => item.platform_code === 'douyin');
  assert.ok(account, stderr);
  const deviceId = account.device_id || 'device-rpa-01';

  let sequence = 0;
  // 走采集端写入接口（非模拟消息），这样人工回复可以真正排队发送。
  const collect = async (content, conversationId) => {
    sequence += 1;
    const suffix = `${sequence}-${Date.now()}`;
    const externalId = `handoff-ws-${suffix}`;
    const result = await request(base, '/api/agent/messages/upsert', {
      method: 'POST',
      body: JSON.stringify({
        platformCode: 'douyin', accountId: account.id, messageType: 'PRIVATE_MESSAGE', externalId, userName: '接待测试用户', content,
        context: { conversationId, messageId: `handoff-ws-message-${suffix}`, direction: 'incoming', sourceVerified: true, chatTitleVerified: true, previewOnly: false, unreadCount: 1 }
      })
    });
    assert.equal(result.response.status, 200, JSON.stringify(result.data) + stderr);
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try { return db.prepare('SELECT * FROM messages WHERE external_id=?').get(externalId); } finally { db.close(); }
  };
  const readDb = work => {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try { return work(db); } finally { db.close(); }
  };
  const writeDb = work => {
    const db = new DatabaseSync(dbPath);
    try { db.exec('PRAGMA busy_timeout=15000'); return work(db); } finally { db.close(); }
  };
  const claim = async () => (await request(base, '/api/agent/jobs/claim', { method: 'POST', body: JSON.stringify({ deviceId }) })).data.job;

  await t.test('用户说“转人工”后收到一次回执，消息仍留在待人工列表', async () => {
    const handoff = await collect('转人工', 'ws-ack');
    assert.equal(handoff.status, 'MANUAL_REQUIRED', JSON.stringify(handoff));
    assert.equal(handoff.reply_job_id, null);
    const followup = await collect('办理要带啥材料', 'ws-ack');
    assert.equal(followup.status, 'MANUAL_REQUIRED');
    const ackJobs = readDb(db => db.prepare(`SELECT * FROM agent_jobs WHERE job_type='REPLY' AND json_extract(payload,'$.auxiliaryKind')='HANDOFF_ACK'
      AND CAST(json_extract(payload,'$.conversationId') AS INTEGER)=?`).all(handoff.conversation_id));
    assert.equal(ackJobs.length, 1, '同一次转人工只发一次回执');
    assert.equal(ackJobs[0].status, 'QUEUED', '跟进消息不会取消回执');
    assert.match(JSON.parse(ackJobs[0].payload).replyText, /已经帮你联系人工同事/);
    assert.equal(readDb(db => db.prepare('SELECT handoff_ack_job_id FROM conversations WHERE id=?').get(handoff.conversation_id)).handoff_ack_job_id, ackJobs[0].id);

    const job = await claim();
    assert.equal(job?.id, ackJobs[0].id, '人工会话里的回执可以被领取');
    const completed = await request(base, `/api/agent/jobs/${job.id}/complete`, { method: 'POST', body: JSON.stringify({ status: 'SUCCESS', result: douyinEvidence(dir) }) });
    assert.equal(completed.data.handoffAck, true);
    readDb(db => {
      assert.equal(db.prepare('SELECT status FROM agent_jobs WHERE id=?').get(job.id).status, 'SUCCESS');
      for (const id of [handoff.id, followup.id]) assert.equal(db.prepare('SELECT status FROM messages WHERE id=?').get(id).status, 'MANUAL_REQUIRED');
    });
  });

  await t.test('接待面板展示会话与回执；知识库草稿；人工回复在人工会话中可以发出并一并处理更早的消息', async () => {
    const conversationId = readDb(db => db.prepare(`SELECT conversation_id FROM messages WHERE content='办理要带啥材料'`).get().conversation_id);
    const workspace = (await request(base, `/api/conversations/${conversationId}/workspace`)).data.workspace;
    assert.notEqual(workspace.conversation.handlingMode, 'BOT_ACTIVE');
    assert.equal(workspace.handoffAck.status, 'SUCCESS');
    assert.equal(workspace.messages.length, 2);
    assert.ok(workspace.pendingMessageId);
    assert.ok(workspace.conversation.idleReleaseAt, '显示闲置自动交还时间');

    const draft = (await request(base, `/api/conversations/${conversationId}/draft`, { method: 'POST', body: '{}' })).data.draft;
    assert.equal(draft.grounded, true);
    assert.equal(draft.draft, '请携带身份证到服务窗口办理。');
    assert.deepEqual(draft.sources, ['办理材料清单']);

    const replied = await request(base, `/api/conversations/${conversationId}/reply`, { method: 'POST', body: JSON.stringify({ replyText: '您好，带上身份证到窗口就能办。' }) });
    assert.equal(replied.response.status, 200, JSON.stringify(replied.data));
    const job = await claim();
    assert.equal(job?.id, replied.data.jobId, '人工回复在已转人工的会话里不再被领取守卫取消');
    assert.equal(job.payload.replyMode, 'MANUAL');
    await request(base, `/api/agent/jobs/${job.id}/complete`, { method: 'POST', body: JSON.stringify({ status: 'SUCCESS', result: douyinEvidence(dir) }) });
    readDb(db => {
      const rows = db.prepare('SELECT content,status,handler_note FROM messages WHERE conversation_id=? ORDER BY id').all(conversationId);
      assert.deepEqual(rows.map(item => item.status), ['MANUAL_HANDLED', 'MANUAL_HANDLED']);
      assert.match(rows[0].handler_note, /一并处理/);
    });
  });

  await t.test('非微博平台消息列表的“人工回复”按目标定位校验开放', async () => {
    const message = await collect('转人工', 'ws-list');
    const listed = (await request(base, '/api/messages')).data.messages.find(item => item.id === message.id);
    assert.equal(listed.manual_reply_supported, true);
    assert.notEqual(listed.conversation_handling_mode, 'BOT_ACTIVE');
    const submitted = await request(base, `/api/messages/${message.id}/manual-reply`, { method: 'POST', body: JSON.stringify({ replyText: '您好，我是人工客服。' }) });
    assert.equal(submitted.response.status, 200, JSON.stringify(submitted.data));
  });

  await t.test('运营接管：取消排队中的 AI 回复，不发企微通知；交还 AI 后新消息重新由 AI 回复', async () => {
    const answered = await collect('办理需要什么材料', 'ws-takeover');
    assert.equal(answered.status, 'REPLY_QUEUED', JSON.stringify(answered));
    const conversationId = answered.conversation_id;
    const before = readDb(db => db.prepare('SELECT COUNT(*) AS count FROM notifications').get().count);
    const takeover = await request(base, `/api/conversations/${conversationId}/takeover`, { method: 'POST', body: '{}' });
    assert.equal(takeover.response.status, 200, JSON.stringify(takeover.data));
    assert.equal(takeover.data.conversation.handling_mode, 'HUMAN_MANAGED');
    readDb(db => {
      assert.equal(db.prepare('SELECT status FROM agent_jobs WHERE id=?').get(answered.reply_job_id).status, 'CANCELLED');
      assert.equal(db.prepare('SELECT status FROM messages WHERE id=?').get(answered.id).status, 'MANUAL_REQUIRED');
      assert.equal(db.prepare('SELECT COUNT(*) AS count FROM notifications').get().count, before, '接管人就是人工，不再通知企微');
    });
    const whileHuman = await collect('那要多久能办好', 'ws-takeover');
    assert.equal(whileHuman.status, 'MANUAL_REQUIRED');

    const ragBefore = ragRequests.length;
    const released = await request(base, `/api/conversations/${conversationId}/release`, { method: 'POST', body: '{}' });
    assert.equal(released.data.conversation.handling_mode, 'BOT_ACTIVE');
    assert.equal(released.data.conversation.handoff_release_reason, 'OPERATOR_RELEASE');
    const afterRelease = await collect('办理还要带什么材料', 'ws-takeover');
    assert.equal(ragRequests.length, ragBefore + 1, '交还后重新查询知识库');
    assert.equal(afterRelease.decision, 'RAG_ANSWERED');
    assert.equal(readDb(db => db.prepare('SELECT status FROM messages WHERE id=?').get(whileHuman.id).status), 'MANUAL_REQUIRED', '旧的待人工消息保持原状');
  });

  await t.test('交还 AI 会关闭仍在等待的转人工意图，后续消息不再被“已通知”分支转给人工', async () => {
    const handoff = await collect('帮我转人工', 'ws-release-intent');
    assert.ok(handoff.manual_handoff_intent_id);
    await request(base, `/api/conversations/${handoff.conversation_id}/release`, { method: 'POST', body: '{}' });
    assert.equal(readDb(db => db.prepare('SELECT status FROM manual_handoff_intents WHERE id=?').get(handoff.manual_handoff_intent_id).status), 'CLOSED_BY_RELEASE');
    const next = await collect('办理需要什么材料呀', 'ws-release-intent');
    assert.equal(next.decision, 'RAG_ANSWERED', JSON.stringify(next));
  });

  await t.test('人工会话闲置超过设定时长后自动交还 AI', async () => {
    const handoff = await collect('转人工', 'ws-idle');
    const conversationId = handoff.conversation_id;
    const old = new Date(Date.now() - 2 * 3_600_000).toISOString();
    writeDb(db => {
      db.prepare('UPDATE conversations SET last_message_at=?,handoff_requested_at=?,handoff_confirmed_at=? WHERE id=?').run(old, old, old, conversationId);
    });
    let conversation;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      conversation = readDb(db => db.prepare('SELECT handling_mode,handoff_release_reason FROM conversations WHERE id=?').get(conversationId));
      if (conversation.handling_mode === 'BOT_ACTIVE') break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(conversation.handling_mode, 'BOT_ACTIVE');
    assert.equal(conversation.handoff_release_reason, 'IDLE_TIMEOUT');
    const fresh = readDb(db => db.prepare(`SELECT c.handling_mode FROM conversations c JOIN messages m ON m.conversation_id=c.id WHERE m.content='转人工' AND c.id<>? ORDER BY c.id DESC LIMIT 1`).get(conversationId));
    assert.notEqual(fresh.handling_mode, 'BOT_ACTIVE', '未闲置的人工会话不受影响');
  });

  await t.test('小程序会话不能从通用接口接管或交还', async () => {
    const id = writeDb(db => {
      const stamp = new Date().toISOString();
      const miniAccount = db.prepare("SELECT id FROM accounts WHERE platform_code='mini_program' LIMIT 1").get();
      if (!miniAccount) return null;
      return Number(db.prepare(`INSERT INTO conversations(namespace,platform_code,account_id,message_type,external_conversation_key,identity_confidence,identity_source,entry_type,context_enabled,version,created_at,updated_at)
        VALUES(?,?,?,?,?,'HIGH','test','PRIVATE_MESSAGE',1,0,?,?)`).run(`mini:${stamp}`, 'mini_program', miniAccount.id, 'PRIVATE_MESSAGE', `mini-${stamp}`, stamp, stamp).lastInsertRowid);
    });
    if (!id) return t.skip('测试库没有小程序账号');
    const result = await request(base, `/api/conversations/${id}/takeover`, { method: 'POST', body: '{}' });
    assert.equal(result.response.status, 409);
  });
});
