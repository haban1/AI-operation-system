import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const root = path.resolve(import.meta.dirname, '..');

async function freePort() {
  const server = http.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function waitFor(base) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { if ((await fetch(`${base}/api/health`)).ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('测试服务启动超时');
}

async function request(base, pathname, { method = 'GET', body } = {}) {
  const response = await fetch(base + pathname, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body
  });
  return { response, data: await response.json() };
}

async function withLedgerServer(t, operation) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'collection-ledger-integration-'));
  const dbPath = path.join(dir, 'test.db');
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port), DATABASE_PATH: dbPath,
      AUTH_ENABLED: 'false', AGENT_SHARED_TOKEN: '', QWEN_MODE: 'mock', RPA_MODE: 'simulated',
      AUTO_COLLECT_ENABLED: 'false', LOCAL_AGENT_AUTO_START: 'false', INSTANCE_LOCK_ENABLED: 'false',
      LOGIN_STATUS_POLL_ENABLED: 'false', ISSUE_DIAGNOSIS_ENABLED: 'false',
      CHANNEL_SPLIT_ENABLED: 'true', PLATFORM_CHANNEL_SPLIT_DOUYIN: 'true',
      MESSAGE_EVENT_LEDGER_ENABLED: 'true', PRIVATE_AUTO_SEND_V2_ENABLED: 'false', COMMENT_CHANNEL_V2_ENABLED: 'false'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await Promise.race([new Promise(resolve => child.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 3000))]);
    }
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  await waitFor(base);
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA busy_timeout=15000');
  try { await operation({ base, db, stderr: () => stderr }); }
  finally { db.close(); }
}

function markRunning(db, jobId) {
  const stamp = new Date().toISOString();
  db.prepare("UPDATE agent_jobs SET status='RUNNING',attempts=attempts+1,claimed_at=?,lease_expires_at=? WHERE id=?")
    .run(stamp, new Date(Date.now() + 600_000).toISOString(), jobId);
}

test('采集完成后按通道写入事件账本，重复扫描幂等且只在完整成功时推进检查点', async t => {
  await withLedgerServer(t, async ({ base, db, stderr }) => {
    const bootstrap = (await request(base, '/api/bootstrap')).data;
    const account = bootstrap.accounts.find(item => item.platform_code === 'douyin');
    assert.ok(account, stderr());

    const externalId = `ledger-private-${Date.now()}`;
    const queue = await request(base, '/api/platforms/douyin/collect', {
      method: 'POST', body: JSON.stringify({ accountId: account.id, types: ['PRIVATE_MESSAGE'] })
    });
    assert.equal(queue.response.status, 200, stderr());
    markRunning(db, queue.data.jobId);
    const completionBody = {
      status: 'SUCCESS',
      result: {
        messages: [{
          externalId,
          messageType: 'PRIVATE_MESSAGE',
          userName: '账本测试用户',
          content: '我想继续了解上次的问题',
          context: {
            sourceVerified: true,
            conversationId: 'conversation-ledger-user-1',
            userId: 'platform-user-ledger-1',
            messageId: externalId,
            direction: 'incoming',
            eventTime: '2026-08-24T10:00:00.000Z'
          }
        }],
        typeResults: [{ type: 'PRIVATE_MESSAGE', status: 'SUCCESS', count: 1 }]
      }
    };
    const completed = await request(base, `/api/agent/jobs/${queue.data.jobId}/complete`, { method: 'POST', body: JSON.stringify(completionBody) });
    assert.equal(completed.response.status, 200, stderr());

    const event = db.prepare('SELECT * FROM message_events WHERE platform_code=? AND account_id=? AND channel_type=? AND platform_message_id=?')
      .get('douyin', account.id, 'PRIVATE_MESSAGE', externalId);
    assert.ok(event, stderr());
    assert.equal(event.direction, 'INBOUND');
    assert.equal(event.seen_count, 1);
    const storedMessage = db.prepare('SELECT conversation_key_snapshot FROM messages WHERE external_id=?').get(externalId);
    assert.ok(storedMessage?.conversation_key_snapshot);
    assert.match(storedMessage.conversation_key_snapshot, new RegExp(`^REAL:douyin:${account.id}:PRIVATE_MESSAGE:`));
    assert.equal(event.conversation_namespace, storedMessage.conversation_key_snapshot);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM collection_checkpoints WHERE platform_code='douyin' AND account_id=? AND channel_type='PRIVATE_MESSAGE'").get(account.id).count, 1);
    assert.equal(db.prepare("SELECT state FROM channel_runtime_states WHERE platform_code='douyin' AND account_id=? AND channel_type='PRIVATE_MESSAGE'").get(account.id).state, 'IDLE');
    const storedResult = JSON.parse(db.prepare('SELECT result FROM agent_jobs WHERE id=?').get(queue.data.jobId).result);
    assert.equal(storedResult.messageLedger[0].checkpointAdvanced, true);

    const secondStamp = new Date().toISOString();
    const secondJobId = Number(db.prepare(`INSERT INTO agent_jobs(device_id,job_type,payload,status,attempts,created_at,claimed_at,channel_type,queue_lane)
      VALUES(?,'COLLECT_MESSAGES',?,'RUNNING',1,?,?,?,?)`).run(
        account.device_id,
        JSON.stringify({ platformCode: 'douyin', accountId: account.id, channelType: 'PRIVATE_MESSAGE', queueLane: 'PRIVATE_MESSAGE', types: ['PRIVATE_MESSAGE'] }),
        secondStamp, secondStamp, 'PRIVATE_MESSAGE', 'PRIVATE_MESSAGE'
      ).lastInsertRowid);
    const duplicate = await request(base, `/api/agent/jobs/${secondJobId}/complete`, { method: 'POST', body: JSON.stringify(completionBody) });
    assert.equal(duplicate.response.status, 200, stderr());
    const repeated = db.prepare('SELECT seen_count FROM message_events WHERE platform_message_id=?').get(externalId);
    assert.equal(repeated.seen_count, 2);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM message_events WHERE platform_message_id=?').get(externalId).count, 1);

    const partialStamp = new Date().toISOString();
    const partialJobId = Number(db.prepare(`INSERT INTO agent_jobs(device_id,job_type,payload,status,attempts,created_at,claimed_at,channel_type,queue_lane)
      VALUES(?,'COLLECT_MESSAGES',?,'RUNNING',1,?,?,?,?)`).run(
        account.device_id,
        JSON.stringify({ platformCode: 'douyin', accountId: account.id, channelType: 'COMMENT', queueLane: 'COMMENT', types: ['COMMENT'] }),
        partialStamp, partialStamp, 'COMMENT', 'COMMENT'
      ).lastInsertRowid);
    const partial = await request(base, `/api/agent/jobs/${partialJobId}/complete`, {
      method: 'POST',
      body: JSON.stringify({ status: 'PARTIAL_SUCCESS', result: { messages: [], message: '评论列表没有完整到底', typeResults: [{ type: 'COMMENT', status: 'NEEDS_CONFIRMATION' }] } })
    });
    assert.equal(partial.response.status, 200, stderr());
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM collection_checkpoints WHERE platform_code='douyin' AND account_id=? AND channel_type='COMMENT'").get(account.id).count, 0);
    assert.equal(db.prepare("SELECT state FROM channel_runtime_states WHERE platform_code='douyin' AND account_id=? AND channel_type='COMMENT'").get(account.id).state, 'DEGRADED');
  });
});

test('账本写入异常时采集任务不能显示成功', async t => {
  await withLedgerServer(t, async ({ base, db, stderr }) => {
    const bootstrap = (await request(base, '/api/bootstrap')).data;
    const account = bootstrap.accounts.find(item => item.platform_code === 'douyin');
    assert.ok(account, stderr());
    const queued = await request(base, '/api/platforms/douyin/collect', {
      method: 'POST', body: JSON.stringify({ accountId: account.id, types: ['PRIVATE_MESSAGE'] })
    });
    assert.equal(queued.response.status, 200, stderr());
    markRunning(db, queued.data.jobId);
    const externalId = `ledger-broken-${Date.now()}`;
    const replyJobsBefore = db.prepare("SELECT COUNT(*) AS count FROM agent_jobs WHERE job_type='REPLY'").get().count;
    db.exec('DROP TABLE message_events');
    const failed = await request(base, `/api/agent/jobs/${queued.data.jobId}/complete`, {
      method: 'POST',
      body: JSON.stringify({
        status: 'SUCCESS',
        result: {
          messages: [{ externalId, messageType: 'PRIVATE_MESSAGE', userName: '用户', content: '测试', context: { conversationId: 'broken-conversation', direction: 'incoming', sourceVerified: true } }],
          typeResults: [{ type: 'PRIVATE_MESSAGE', status: 'SUCCESS' }]
        }
      })
    });
    assert.equal(failed.response.status, 500, stderr());
    const job = db.prepare('SELECT status,result FROM agent_jobs WHERE id=?').get(queued.data.jobId);
    assert.equal(job.status, 'FAILED');
    assert.match(JSON.parse(job.result).persistenceError, /message_events|no such table/i);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM messages WHERE external_id=?').get(externalId).count, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM collection_checkpoints WHERE platform_code='douyin' AND account_id=? AND channel_type='PRIVATE_MESSAGE'").get(account.id).count, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM agent_jobs WHERE job_type='REPLY'").get().count, replyJobsBefore);
  });
});

test('同一采集批次中任一消息无效时整批回滚且不启动回复', async t => {
  await withLedgerServer(t, async ({ base, db, stderr }) => {
    const bootstrap = (await request(base, '/api/bootstrap')).data;
    const account = bootstrap.accounts.find(item => item.platform_code === 'douyin');
    assert.ok(account, stderr());
    const queued = await request(base, '/api/platforms/douyin/collect', {
      method: 'POST', body: JSON.stringify({ accountId: account.id, types: ['PRIVATE_MESSAGE'] })
    });
    assert.equal(queued.response.status, 200, stderr());
    markRunning(db, queued.data.jobId);

    const validExternalId = `ledger-atomic-valid-${Date.now()}`;
    const invalidExternalId = `ledger-atomic-invalid-${Date.now()}`;
    const replyJobsBefore = db.prepare("SELECT COUNT(*) AS count FROM agent_jobs WHERE job_type='REPLY'").get().count;
    const failed = await request(base, `/api/agent/jobs/${queued.data.jobId}/complete`, {
      method: 'POST',
      body: JSON.stringify({
        status: 'SUCCESS',
        result: {
          messages: [
            {
              externalId: validExternalId,
              messageType: 'PRIVATE_MESSAGE',
              userName: '原子批次用户',
              content: '第一条合法消息',
              context: { conversationId: 'atomic-conversation', userId: 'atomic-user', direction: 'incoming', sourceVerified: true }
            },
            {
              externalId: invalidExternalId,
              messageType: 'PRIVATE_MESSAGE',
              userName: '原子批次用户',
              content: '',
              context: { conversationId: 'atomic-conversation', userId: 'atomic-user', direction: 'incoming', sourceVerified: true }
            }
          ],
          typeResults: [{ type: 'PRIVATE_MESSAGE', status: 'SUCCESS', count: 2 }]
        }
      })
    });

    assert.equal(failed.response.status, 500, stderr());
    const job = db.prepare('SELECT status,result FROM agent_jobs WHERE id=?').get(queued.data.jobId);
    assert.equal(job.status, 'FAILED');
    assert.match(JSON.parse(job.result).persistenceError, /externalId|消息内容|不能为空|不匹配/i);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM messages WHERE external_id IN (?,?)').get(validExternalId, invalidExternalId).count, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM message_events WHERE platform_message_id IN (?,?)').get(validExternalId, invalidExternalId).count, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM collection_checkpoints WHERE platform_code='douyin' AND account_id=? AND channel_type='PRIVATE_MESSAGE'").get(account.id).count, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM agent_jobs WHERE job_type='REPLY'").get().count, replyJobsBefore);
  });
});
