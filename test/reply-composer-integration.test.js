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

const hit = (title, score) => ({ chunk_id: `chunk-${title}`, document_id: `doc-${title}`, document_version: 1, title, section_path: [], reranker_score_normalized: score, selected: true });

test('私信低置信度：确认方向后重新问答，知识缺口邀请转人工可用“好的”确认或婉拒', async t => {
  const ragRequests = [];
  const ragServer = http.createServer(async (req, res) => {
    const payload = await readJson(req);
    ragRequests.push(payload);
    const question = String(payload?.query?.text || '');
    const base = { requestId: payload.requestId, snapshot: payload.snapshot, meta: { knowledgeVersion: 'test-release-1' } };
    let body;
    if (question === 'AI 训练营结业证书说明') {
      body = { ...base, result: 'ANSWERED', answer: { text: '结业后颁发电子结业证书。' }, grounding: { confidence: 0.9, sourceReferences: [{ documentId: 'doc-y', documentVersion: 1, chunkId: 'chunk-y' }] } };
    } else if (question.includes('结业')) {
      body = { ...base, result: 'NO_ANSWER', reasonCode: 'INSUFFICIENT_EVIDENCE', grounding: { confidence: 0, sourceReferences: [] },
        diagnostics: { selectedCandidates: [hit('AI 训练营结业证书说明', 0.2)] } };
    } else if (question === 'AI 训练营课程安排') {
      body = { ...base, result: 'ANSWERED', answer: { text: '训练营每周六上午上课，共四周。' }, grounding: { confidence: 0.9, sourceReferences: [{ documentId: 'doc-x', documentVersion: 1, chunkId: 'chunk-x' }] } };
    } else if (question.includes('训练营')) {
      body = { ...base, result: 'NO_ANSWER', reasonCode: 'INSUFFICIENT_EVIDENCE', grounding: { confidence: 0, sourceReferences: [] },
        diagnostics: { selectedCandidates: [hit('AI 训练营报名方式', 0.3), hit('AI 训练营课程安排', 0.28)] } };
    } else {
      body = { ...base, result: 'NO_ANSWER', reasonCode: 'INSUFFICIENT_EVIDENCE', grounding: { confidence: 0, sourceReferences: [] }, diagnostics: { selectedCandidates: [] } };
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  const ragPort = await listen(ragServer);
  t.after(() => new Promise(resolve => ragServer.close(resolve)));

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reply-composer-integration-'));
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
      RAG_FORMAL_ROUTING_ENABLED: 'true', RAG_BASE_URL: `http://127.0.0.1:${ragPort}`, RAG_TIMEOUT_MS: '2000', WECOM_WEBHOOK_URL: ''
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

  let sequence = 0;
  const simulate = async (content, conversationId) => {
    sequence += 1;
    const suffix = `${sequence}-${Date.now()}`;
    const result = await request(base, '/api/messages/simulate', {
      method: 'POST',
      body: JSON.stringify({
        platformCode: 'douyin', accountId: account.id, messageType: 'PRIVATE_MESSAGE',
        externalId: `composer-${suffix}`, userName: '编排测试用户', content,
        context: { conversationId, messageId: `composer-message-${suffix}`, direction: 'incoming', sourceVerified: true, chatTitleVerified: true, previewOnly: false, unreadCount: 1 }
      })
    });
    assert.equal(result.response.status, 201, JSON.stringify(result.data));
    return result.data.message;
  };
  // 模拟平台已确认送达：只有用户实际看到的回复才算上一轮。
  const markDelivered = message => {
    const db = new DatabaseSync(dbPath);
    try {
      db.exec('PRAGMA busy_timeout=15000');
      const stamp = new Date().toISOString();
      db.prepare("UPDATE agent_jobs SET status='SUCCEEDED',completed_at=? WHERE id=?").run(stamp, message.reply_job_id);
      db.prepare("UPDATE messages SET status='AUTO_REPLIED',handled_at=?,handled_by='AI_RPA' WHERE id=?").run(stamp, message.id);
    } finally { db.close(); }
  };
  const readDb = work => {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try { return work(db); } finally { db.close(); }
  };

  await t.test('相关候选给出序号，用户回“2”后按选中方向重新问答', async () => {
    const clarify = await simulate('ai训练营咋整啊', 'composer-related');
    assert.equal(clarify.decision, 'RAG_RELATED_CLARIFICATION', JSON.stringify(clarify));
    assert.equal(clarify.status, 'REPLY_QUEUED');
    assert.match(clarify.reply_text, /1\. AI 训练营报名方式\n2\. AI 训练营课程安排/);
    markDelivered(clarify);
    const answered = await simulate('2', 'composer-related');
    assert.equal(ragRequests.at(-1).query.text, 'AI 训练营课程安排');
    assert.equal(answered.decision, 'RAG_ANSWERED', JSON.stringify(answered));
    assert.equal(answered.reply_text, '训练营每周六上午上课，共四周。');
    assert.equal(JSON.parse(answered.reply_context_json).clarificationConfirmed, true);
  });

  await t.test('单个方向时用户回“好的”，不被当作闲聊，按该方向重新问答', async () => {
    const clarify = await simulate('结业有证书没', 'composer-single');
    assert.equal(clarify.decision, 'RAG_RELATED_CLARIFICATION', JSON.stringify(clarify));
    assert.match(clarify.reply_text, /「AI 训练营结业证书说明」/);
    markDelivered(clarify);
    const answered = await simulate('好的', 'composer-single');
    assert.equal(ragRequests.at(-1).query.text, 'AI 训练营结业证书说明');
    assert.equal(answered.decision, 'RAG_ANSWERED', JSON.stringify(answered));
  });

  await t.test('无关问题友好划定范围，不登记人工意图', async () => {
    const message = await simulate('今天天气咋样啊', 'composer-off-domain');
    assert.equal(message.decision, 'RAG_OUT_OF_SCOPE', JSON.stringify(message));
    assert.doesNotMatch(message.reply_text, /人工|客服/);
    assert.equal(message.manual_handoff_intent_id, null);
  });

  await t.test('知识缺口邀请转人工，用户回“好的”即真正转人工并带上原问题', async () => {
    const gap = await simulate('社区入驻要啥条件', 'composer-gap-accept');
    assert.equal(gap.decision, 'RAG_KNOWLEDGE_GAP', JSON.stringify(gap));
    assert.match(gap.reply_text, /转人工/);
    assert.doesNotMatch(gap.reply_text, /建议向人工客服咨询/);
    assert.ok(gap.manual_handoff_intent_id);
    markDelivered(gap);
    const before = ragRequests.length;
    const accepted = await simulate('好的', 'composer-gap-accept');
    assert.equal(ragRequests.length, before, '确认转人工不再调用 RAG');
    assert.equal(accepted.status, 'MANUAL_REQUIRED', JSON.stringify(accepted));
    readDb(db => {
      const notification = db.prepare("SELECT content FROM notifications WHERE type='KNOWLEDGE_GAP_CONFIRMED' AND message_id=?").get(accepted.id);
      assert.ok(notification, '已创建转人工通知');
      assert.match(notification.content, /社区入驻要啥条件/);
      assert.equal(db.prepare('SELECT handling_mode FROM conversations WHERE id=?').get(accepted.conversation_id).handling_mode, 'HANDOFF_PENDING');
    });
    const followup = await simulate('大概多久回我', 'composer-gap-accept');
    assert.equal(followup.status, 'MANUAL_REQUIRED');
    readDb(db => {
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM notifications WHERE message_id=?").get(followup.id).count, 0, '窗口内跟进消息合并到已有通知');
    });
  });

  await t.test('知识缺口邀请后回“不用了”，婉拒并继续由 AI 服务', async () => {
    const gap = await simulate('社区入驻要交钱不', 'composer-gap-decline');
    assert.equal(gap.decision, 'RAG_KNOWLEDGE_GAP');
    markDelivered(gap);
    const declined = await simulate('不用了', 'composer-gap-decline');
    assert.equal(declined.decision, 'PRIVATE_HANDOFF_DECLINED', JSON.stringify(declined));
    assert.equal(declined.status, 'REPLY_QUEUED');
    readDb(db => {
      assert.equal(db.prepare('SELECT status FROM manual_handoff_intents WHERE id=?').get(gap.manual_handoff_intent_id).status, 'DECLINED');
      assert.equal(db.prepare('SELECT handling_mode FROM conversations WHERE id=?').get(declined.conversation_id).handling_mode, 'BOT_ACTIVE');
    });
  });

  await t.test('上一条不是邀请时，“好的”不会误触发转人工', async () => {
    const gap = await simulate('社区入驻流程长吗', 'composer-stale-offer');
    assert.equal(gap.decision, 'RAG_KNOWLEDGE_GAP');
    // 回复尚未送达用户，不能把它当作用户看到的邀约。
    const ack = await simulate('好的', 'composer-stale-offer');
    assert.notEqual(ack.status, 'MANUAL_REQUIRED', JSON.stringify(ack));
  });
});
