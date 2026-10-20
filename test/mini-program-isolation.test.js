import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

let observed;
test.before(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mini-isolation-'));
  try {
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import http from 'node:http';
      const probe = http.createServer();
      await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
      process.env.PORT = String(probe.address().port);
      await new Promise(resolve => probe.close(resolve));
      const { row, rows, run, now } = await import('./src/db.js');
      const { config } = await import('./src/config.js');
      const { ingestMiniProgramMessage, miniProgramAccount } = await import('./src/services/mini-program-channel.js');
      const { signMiniProgramRequest, verifyMiniProgramSignature } = await import('./src/services/mini-program-auth.js');
      const { saveMasterSwitch } = await import('./src/services/settings.js');
      const { ensureMessageConversation } = await import('./src/services/conversation-store.js');
      const server = await import('./src/server.js');
      saveMasterSwitch(true);
      const base = 'http://127.0.0.1:' + process.env.PORT;
      async function request(pathname, method = 'GET', data) {
        const response = await fetch(base + pathname, { method, headers: { 'Content-Type': 'application/json' }, body: data ? JSON.stringify(data) : undefined });
        return { status: response.status, data: await response.json() };
      }
      const account = miniProgramAccount();
      let sequence = 0;
      function signedSeed() {
        sequence += 1;
        const payload = { appId: 'app-1', conversationId: 'c-' + sequence, messageId: 'm-' + sequence, userId: 'user-001', text: '你好', sentAt: now() };
        const rawBody = Buffer.from(JSON.stringify(payload));
        const signatureInput = { method: 'POST', pathname: '/open-api/v1/mini-program/messages', timestamp: String(Math.floor(Date.now() / 1000)), nonce: 'isolation-nonce-' + sequence, rawBody, secret: 'isolation-test-secret-32-characters-long' };
        const signature = signMiniProgramRequest(signatureInput);
        verifyMiniProgramSignature({ ...signatureInput, appId: payload.appId, headers: { 'x-mini-app-id': payload.appId, 'x-timestamp': signatureInput.timestamp, 'x-nonce': signatureInput.nonce, 'x-signature': signature } });
        ingestMiniProgramMessage(payload);
        return row('SELECT * FROM messages WHERE external_id=?', 'mini-program:app-1:message:' + payload.messageId);
      }
      const result = { mutations: [], legacy: [] };
      try {
        const seed = signedSeed();
        result.list = await request('/api/messages');
        result.seedId = seed.id;
        for (const [suffix, method] of [['', 'DELETE'], ['/handled', 'POST'], ['/retry', 'POST'], ['/manual-reply', 'POST'], ['/detect-manual', 'POST']]) {
          const message = signedSeed();
          const before = JSON.stringify(message);
          const jobCount = row('SELECT COUNT(*) AS n FROM agent_jobs').n;
          const response = await request('/api/messages/' + message.id + suffix, method, { replyText: '人工回复', expectedReply: '人工回复' });
          result.mutations.push({ suffix, response, unchanged: before === JSON.stringify(row('SELECT * FROM messages WHERE id=?', message.id)), addedJobs: row('SELECT COUNT(*) AS n FROM agent_jobs').n - jobCount });
        }
        result.login = await request('/api/agent/accounts/' + account.id + '/login-state', 'POST', { state: 'READY', checkedAt: now() });
        result.loginStatus = row('SELECT login_status FROM accounts WHERE id=?', account.id).login_status;
        const collected = { platformCode: 'mini_program', accountId: account.id, externalId: 'unsigned', messageType: 'PRIVATE_MESSAGE', content: '你好', userName: 'user-001', context: { serverSignatureVerified: true } };
        const beforeCount = row('SELECT COUNT(*) AS n FROM messages').n;
        result.simulation = await request('/api/messages/simulate', 'POST', collected);
        result.collection = await request('/api/agent/messages/upsert', 'POST', collected);
        result.ingestedRows = row('SELECT COUNT(*) AS n FROM messages').n - beforeCount;
        result.unknownSimulation = await request('/api/messages/simulate', 'POST', { ...collected, platformCode: 'unknown' });
        result.unknownCollection = await request('/api/agent/messages/upsert', 'POST', { ...collected, platformCode: 'unknown' });
        result.manualCollection = await request('/api/platforms/mini_program/collect', 'POST', { accountId: account.id });

        run("UPDATE accounts SET login_status='READY',enabled=1");
        run("UPDATE platforms SET desired_state='RUNNING',lifecycle_state='ACTIVE'");
        run("UPDATE agent_jobs SET status='CANCELLED' WHERE status IN ('QUEUED','RUNNING')");
        config.autoCollectEnabled = true;
        const autoIds = server.enqueueAutomaticMessageCollections();
        result.autoPlatforms = autoIds.map(id => JSON.parse(row('SELECT payload FROM agent_jobs WHERE id=?', id).payload).platformCode);
        run("UPDATE agent_jobs SET status='CANCELLED' WHERE status IN ('QUEUED','RUNNING')");
        for (const code of config.activePlatformCodes) {
          const legacyAccount = row('SELECT * FROM accounts WHERE platform_code=?', code);
          const id = Number(run("INSERT INTO messages(platform_code,account_id,external_id,message_type,user_name,content,status,context_json,created_at,updated_at) VALUES(?,?,?,'PRIVATE_MESSAGE','legacy-user','你好','NEW',?,?,?)", code, legacyAccount.id, 'legacy-' + code, JSON.stringify({ conversationId: 'legacy-' + code, messageId: 'legacy-' + code, direction: 'incoming', sourceVerified: true, chatTitleVerified: true }), now(), now()).lastInsertRowid);
          ensureMessageConversation(row('SELECT * FROM messages WHERE id=?', id));
          run("UPDATE messages SET decision='TEST_SEEDED' WHERE id=?", id);
          result.legacy.push({ code, id });
        }
        run("UPDATE conversations SET last_message_at=?,last_recovery_scan_at=NULL", new Date(Date.now() - 60 * 60_000).toISOString());
        const recoveryIds = server.enqueueConversationRecoveryJobs();
        result.recoveryPlatforms = recoveryIds.map(id => JSON.parse(row('SELECT payload FROM agent_jobs WHERE id=?', id).payload).platformCode);
        result.legacyList = await request('/api/messages');
        for (const item of result.legacy) {
          item.login = await request('/api/agent/accounts/' + row('SELECT account_id FROM messages WHERE id=?', item.id).account_id + '/login-state', 'POST', { state: 'READY', checkedAt: now() });
          item.handled = await request('/api/messages/' + item.id + '/handled', 'POST', { handledBy: 'test' });
          item.deleted = await request('/api/messages/' + item.id, 'DELETE', {});
        }
        console.log('OBSERVED:' + JSON.stringify(result));
        process.emit('SIGTERM');
      } catch (error) { console.error(error); process.exit(1); }
    `], {
      cwd: path.resolve(import.meta.dirname, '..'), encoding: 'utf8', timeout: 30_000,
      env: { ...process.env, DATABASE_PATH: path.join(dir, 'test.db'), AUTH_ENABLED: 'false', AGENT_SHARED_TOKEN: '', INSTANCE_LOCK_ENABLED: 'false', LOCAL_AGENT_AUTO_START: 'false', AUTO_COLLECT_ENABLED: 'false', QWEN_MODE: 'mock', RPA_MODE: 'simulated', WECOM_WEBHOOK_URL: '', RAG_FORMAL_ROUTING_ENABLED: 'false', MINI_PROGRAM_APP_ID: 'app-1', MINI_PROGRAM_SHARED_SECRET: 'test-secret', MINI_PROGRAM_CALLBACK_URL: '' }
    });
    assert.equal(child.status, 0, child.stderr || child.error?.message || child.stdout);
    const line = child.stdout.split('\n').find(line => line.startsWith('OBSERVED:'));
    assert.ok(line, child.stdout);
    observed = JSON.parse(line.slice('OBSERVED:'.length));
  } finally { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});

test('signed mini messages stay out of the legacy GET /api/messages list', () => {
  assert.equal(observed.list.status, 200);
  assert.equal(observed.list.data.messages.some(message => message.id === observed.seedId), false);
  assert.equal(observed.legacyList.data.messages.some(message => message.platform_code === 'mini_program'), false);
});

for (const suffix of ['', '/handled', '/retry', '/manual-reply', '/detect-manual']) {
  test(`mini messages reject generic ${suffix || 'DELETE'} without mutation or Agent jobs`, () => {
    const result = observed.mutations.find(item => item.suffix === suffix);
    assert.equal(result.response.status, 409);
    assert.equal(result.response.data.code, 'MINI_PROGRAM_DEDICATED_API_REQUIRED');
    assert.equal(result.unchanged, true);
    assert.equal(result.addedJobs, 0);
  });
}

test('Agent login-state cannot replace mini NOT_REQUIRED state', () => {
  assert.equal(observed.login.status, 409);
  assert.equal(observed.login.data.code, 'MINI_PROGRAM_DEDICATED_API_REQUIRED');
  assert.equal(observed.loginStatus, 'NOT_REQUIRED');
});

test('simulation and Agent collection reject mini with stable signed-endpoint errors', () => {
  assert.equal(observed.simulation.status, 400);
  assert.equal(observed.simulation.data.code, 'MINI_PROGRAM_SIGNED_ENDPOINT_REQUIRED');
  assert.equal(observed.collection.status, 200);
  assert.equal(observed.collection.data.results[0].code, 'MINI_PROGRAM_SIGNED_ENDPOINT_REQUIRED');
  assert.equal(observed.collection.data.results[0].created, false);
  assert.equal(observed.ingestedRows, 0);
  assert.equal(observed.manualCollection.status, 400);
  assert.equal(observed.manualCollection.data.message, '不支持的平台');
});

test('automatic collection and recovery use the active platform allowlist even if mini is READY', () => {
  const codes = ['bilibili', 'douyin', 'wechat_channels', 'weibo', 'xiaohongshu'];
  assert.deepEqual([...new Set(observed.autoPlatforms)].sort(), codes);
  assert.deepEqual([...new Set(observed.recoveryPlatforms)].sort(), codes);
});

test('legacy unknown-platform errors and five-platform list, login and mutations remain unchanged', () => {
  assert.equal(observed.unknownSimulation.status, 400);
  assert.equal(observed.unknownSimulation.data.code, 'REQUEST_FAILED');
  assert.equal(observed.unknownSimulation.data.message, '平台、账号、externalId 和消息内容不能为空或不匹配');
  assert.deepEqual(observed.unknownCollection.data.results, [{ created: false, error: '平台、账号、externalId 和消息内容不能为空或不匹配', externalId: 'unsigned' }]);
  for (const item of observed.legacy) {
    assert.ok(observed.legacyList.data.messages.some(message => message.id === item.id), item.code);
    assert.equal(item.login.status, 200, item.code);
    assert.equal(item.handled.status, 200, item.code);
    assert.equal(item.handled.data.message.status, 'MANUAL_HANDLED', item.code);
    assert.equal(item.deleted.status, 200, item.code);
    assert.equal(item.deleted.data.deleted, true, item.code);
  }
});
