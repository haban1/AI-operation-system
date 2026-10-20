import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { once } from 'node:events';
import { Worker } from 'node:worker_threads';

const root = path.resolve(import.meta.dirname, '..');

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
  for (let index = 0; index < 100; index += 1) {
    try {
      const response = await fetch(base + '/api/health');
      if (response.ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('测试服务启动超时');
}

function withDatabase(dbPath, options, callback) {
  const db = new DatabaseSync(dbPath, options);
  try {
    db.exec('PRAGMA busy_timeout=15000');
    return callback(db);
  } finally {
    db.close();
  }
}

test('私信确认候选问题后串联知识库上下文，即使会话待确认字段丢失也能恢复', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-confirmation-chain-'));
  const dbPath = path.join(dir, 'test.db');
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      DATABASE_PATH: dbPath,
      QWEN_MODE: 'mock',
      AUTO_REPLY_THRESHOLD: '0.9',
      RPA_MODE: 'simulated',
      AUTO_COLLECT_ENABLED: 'false',
      LOCAL_AGENT_AUTO_START: 'false',
      WECOM_WEBHOOK_URL: '',
      RAG_FORMAL_ROUTING_ENABLED: 'false',
      RAG_BASE_URL: '',
      AUTH_ENABLED: 'false'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  let competingWriter = null;
  t.after(async () => {
    if (competingWriter) await competingWriter.terminate();
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await Promise.race([
        new Promise(resolve => child.once('exit', resolve)),
        new Promise(resolve => setTimeout(resolve, 2000))
      ]);
    }
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  await waitFor(base).catch(error => { throw new Error(`${error.message}\n${stderr}`); });
  const bootstrap = (await request(base, '/api/bootstrap')).data;
  const account = bootstrap.accounts.find(item => item.platform_code === 'douyin');
  assert.ok(account);

  const created = await request(base, '/api/knowledge', {
    method: 'POST',
    body: JSON.stringify({
      question: '澳门车主可以申请这个车辆通关业务吗?',
      answer: '可以。申请人需年满18岁，是澳门居民，并持有澳门身份证和回乡证；车辆须为本人唯一登记车辆，每人限申请一辆。',
      keywords: '澳门,车主,车辆通关,申请',
      category: '公共知识库',
      subcategory: '车辆通关'
    })
  });
  assert.equal(created.response.status, 201, JSON.stringify(created.data));
  const knowledgeId = created.data.knowledge.id;
  const published = await request(base, `/api/knowledge/${knowledgeId}/publish`, {
    method: 'POST',
    body: JSON.stringify({ reviewedBy: 'integration-test' })
  });
  assert.equal(published.response.status, 200, JSON.stringify(published.data));

  const simulate = async (content, suffix) => {
    const result = await request(base, '/api/messages/simulate', {
      method: 'POST',
      body: JSON.stringify({
        platformCode: 'douyin',
        accountId: account.id,
        messageType: 'PRIVATE_MESSAGE',
        externalId: `confirmation-chain-${suffix}`,
        userName: '澳门车主测试用户',
        content,
        context: {
          conversationId: 'macao-owner-confirmation',
          messageId: `confirmation-chain-message-${suffix}`,
          direction: 'incoming',
          sourceVerified: true,
          chatTitleVerified: true,
          previewOnly: false,
          unreadCount: 1
        }
      })
    });
    assert.equal(result.response.status, 201, JSON.stringify(result.data));
    return result.data.message;
  };

  const first = await simulate('关于澳门车主的事情', 'first');
  assert.equal(first.decision, 'KNOWLEDGE_GAP_GUIDANCE');
  assert.match(first.reply_text, /澳门车主可以申请这个车辆通关业务吗/);
  const firstContext = JSON.parse(first.reply_context_json || '{}');
  assert.equal(firstContext.clarificationCandidate.candidateQuestion, '澳门车主可以申请这个车辆通关业务吗?');

  // 主动制造短暂写入占用，防止等待锁的回归只在偶发竞争时才暴露。
  competingWriter = new Worker(`
    const { DatabaseSync } = require('node:sqlite');
    const { parentPort, workerData } = require('node:worker_threads');
    const db = new DatabaseSync(workerData);
    db.exec('PRAGMA busy_timeout=15000; BEGIN IMMEDIATE');
    parentPort.postMessage('locked');
    setTimeout(() => { db.exec('COMMIT'); db.close(); }, 500);
  `, { eval: true, workerData: dbPath });
  assert.deepEqual(await once(competingWriter, 'message'), ['locked']);

  const conversation = withDatabase(dbPath, {}, db => {
    const firstRow = db.prepare('SELECT conversation_id FROM messages WHERE external_id=?').get('confirmation-chain-first');
    assert.ok(firstRow?.conversation_id);
    const row = db.prepare('SELECT id,pending_intent_json FROM conversations WHERE id=?').get(firstRow.conversation_id);
    assert.ok(row);
    assert.ok(row.pending_intent_json);
    // 模拟旧流程只保留消息诊断上下文、未能持久化会话级 pending_intent_json。
    db.prepare('UPDATE conversations SET pending_intent_json=NULL WHERE id=?').run(row.id);
    return row;
  });

  const confirmed = await simulate('对的', 'confirmed');
  assert.equal(confirmed.decision, 'AUTO_REPLY', JSON.stringify(confirmed));
  assert.equal(Number(confirmed.knowledge_id), Number(knowledgeId));
  assert.match(confirmed.reply_text, /年满18岁/);
  assert.match(confirmed.reply_text, /澳门居民/);
  assert.match(confirmed.reply_text, /澳门身份证和回乡证/);
  assert.doesNotMatch(confirmed.reply_text, /你想问哪件事/);
  const confirmedContext = JSON.parse(confirmed.reply_context_json || '{}');
  assert.equal(confirmedContext.pendingIntentRecovered, true);
  assert.equal(confirmedContext.clarificationConfirmed, true);

  const after = withDatabase(dbPath, { readOnly: true }, db => (
    db.prepare('SELECT pending_intent_json FROM conversations WHERE id=?').get(conversation.id)
  ));
  assert.equal(after.pending_intent_json, null);

  // 省略式追问在同一有效会话内只执行一次上下文知识匹配，不再先direct后context。
  const followup = await simulate('那需要什么？', 'single-context-call');
  assert.equal(followup.decision, 'KNOWLEDGE_GAP_GUIDANCE', JSON.stringify(followup));
  assert.equal(JSON.parse(followup.reply_context_json || '{}').contextUsed, true);
  const matchCalls = withDatabase(dbPath, { readOnly: true }, db => (
    db.prepare("SELECT task_id FROM ai_call_logs WHERE task_type='KNOWLEDGE_MATCH' AND task_id LIKE ? ORDER BY id").all(`${followup.id}:1:%`)
  ));
  assert.deepEqual(matchCalls.map(item => item.task_id), [`${followup.id}:1:context`]);

  // 即使上一条消息相隔3小时，仍继续承接已确认的业务上下文，避免丢失用户的提问和回答。
  const staleCreatedAt = new Date(Date.now() - 3 * 60 * 60_000).toISOString();
  withDatabase(dbPath, {}, db => {
    db.prepare('UPDATE messages SET created_at=? WHERE id=?').run(staleCreatedAt, followup.id);
    db.prepare('UPDATE conversations SET clarification_attempts=3,pending_intent_json=? WHERE id=?').run(JSON.stringify({ candidateQuestion: '澳门车主可以申请这个车辆通关业务吗?', candidateKnowledgeId: knowledgeId }), conversation.id);
  });

  const staleConfirmation = await simulate('对的', 'stale-confirmation');
  assert.equal(staleConfirmation.decision, 'AUTO_REPLY', JSON.stringify(staleConfirmation));
  assert.equal(Number(staleConfirmation.knowledge_id), Number(knowledgeId));
  const staleContext = JSON.parse(staleConfirmation.reply_context_json || '{}');
  assert.equal(staleContext.contextExpired, false);
  assert.ok(staleContext.recentMessageIds.length > 0);
  assert.equal(staleContext.clarificationConfirmed, true);

  const retainedConversation = withDatabase(dbPath, { readOnly: true }, db => (
    db.prepare('SELECT clarification_attempts,pending_intent_json FROM conversations WHERE id=?').get(conversation.id)
  ));
  assert.equal(retainedConversation.clarification_attempts, 0);
  assert.equal(retainedConversation.pending_intent_json, null);
});
