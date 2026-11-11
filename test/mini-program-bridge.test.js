import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mini-bridge-test-'));
Object.assign(process.env, { NODE_ENV: 'test', DATABASE_PATH: path.join(dir, 'runtime.db'),
  SETTINGS_ENCRYPTION_KEY: 'bridge-isolated-settings-test-key', INSTANCE_LOCK_ENABLED: 'false',
  MINI_PROGRAM_API_ENABLED: 'false', MINI_PROGRAM_APP_ID: '', MINI_PROGRAM_SHARED_SECRET: '',
  MINI_PROGRAM_CALLBACK_URL: '', MINI_PROGRAM_CONNECTION_MODE: 'push', WECOM_WEBHOOK_URL: '' });
const { db, row, run, now } = await import('../src/db.js');
const { getMiniProgramConnection, saveMiniProgramConnection, miniProgramConnectionSummary, BRIDGE_PROTOCOL } = await import('../src/services/mini-program-connection.js');
const { pollMiniProgramBridgeOnce, testMiniProgramBridge, requestMiniProgramBridge, startMiniProgramBridgeWorker, stopMiniProgramBridgeWorker, getMiniProgramBridgeStatus } = await import('../src/services/mini-program-bridge.js');
const { verifyMiniProgramSignature } = await import('../src/services/mini-program-auth.js');
const { enqueueMiniProgramReply, deliverMiniProgramCallback } = await import('../src/services/mini-program-callback.js');
const secret = 'bridge-test-shared-secret-more-than-32-characters';
const options = { mode: 'pull', enabled: true, appId: 'bridge-test', sharedSecret: secret,
  gatewayUrl: 'http://127.0.0.1:19999/bridge/v1', callbackUrl: '', pollSeconds: 2 };
function message(id, overrides = {}) { return { appId: options.appId, conversationId: `c-${id}`, messageId: id, userId: `u-${id}`, text: '用户咨询文字', sentAt: now(), ...overrides }; }
const calls = []; const nonces = new Set();
function mock(delivery = null, extra = {}) {
  return async (url, request) => {
    const raw = Buffer.from(request.body), body = JSON.parse(raw);
    const verified = verifyMiniProgramSignature({ method: request.method, pathname: new URL(url).pathname,
      headers: request.headers, rawBody: raw, appId: options.appId, secret });
    assert.ok(!nonces.has(verified.nonce)); nonces.add(verified.nonce);
    assert.equal(request.redirect, 'manual');
    calls.push({ url, body });
    const result = { ok: true, protocol: BRIDGE_PROTOCOL, appId: options.appId,
      requestNonce: request.headers['X-Nonce'], delivery, acknowledged: true, deliveryId: body.deliveryId,
      capabilities: ['pull','ack','replies'], ...extra };
    return new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json' } });
  };
}
function clearQueues() {
  run("UPDATE mini_program_processing_jobs SET status='COMPLETED',claimed_at=NULL,lease_expires_at=NULL");
  run("UPDATE mini_program_callback_outbox SET status='CANCELLED'");
  run('DELETE FROM mini_program_bridge_receipts');
}
test.after(async () => { await stopMiniProgramBridgeWorker(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test('保存主动连接配置：加密落盘、密钥不回显、固定实例 ID', () => {
  const summary = saveMiniProgramConnection(options);
  assert.equal(summary.callbackUrl, `${options.gatewayUrl}/replies`);
  assert.equal(summary.secretConfigured, true);
  assert.ok(!JSON.stringify(summary).includes(secret));
  const stored = row("SELECT encrypted_value FROM system_settings WHERE setting_key='mini_program.connection.v1'").encrypted_value;
  assert.ok(stored.startsWith('v1:')); assert.ok(!stored.includes(secret));
  const again = saveMiniProgramConnection({ ...options, sharedSecret: '' });
  assert.equal(again.clientId, summary.clientId);
  assert.equal(getMiniProgramConnection().sharedSecret, secret);
});
test('拒绝不安全地址、重定向式参数、弱密钥、非法字段', () => {
  for (const gatewayUrl of ['http://example.test/bridge','https://user:pass@example.test/bridge','https://example.test/bridge?token=secret','https://example.test/#x']) {
    assert.throws(() => saveMiniProgramConnection({ ...options, gatewayUrl }));
  }
  assert.throws(() => saveMiniProgramConnection({ ...options, sharedSecret: 'short' }));
  assert.throws(() => saveMiniProgramConnection({ ...options, appId: 'bad\nheader' }));
  assert.throws(() => saveMiniProgramConnection({ ...options, pollSeconds: 0 }));
  assert.throws(() => saveMiniProgramConnection({ ...options, unknown: true }));
});
test('连通检查只探测协议，不领取消息；空队列保持空闲', async () => {
  calls.length = 0;
  const result = await testMiniProgramBridge({ fetchImpl: mock() });
  assert.equal(result.reachable, true); assert.ok(calls[0].url.endsWith('/health'));
  assert.equal(calls.length, 1);
  assert.deepEqual(await pollMiniProgramBridgeOnce({ fetchImpl: mock() }), { idle: true });
});
test('先持久化消息和任务，再确认收件；同一投递与重新租约均幂等', async () => {
  const delivery = { id: 'delivery-1', message: message('message-1') };
  const f = mock(delivery);
  const fetchImpl = async (url, request) => {
    if (url.endsWith('/ack')) {
      assert.ok(row("SELECT id FROM messages WHERE external_id='mini-program:bridge-test:message:message-1'"));
      assert.ok(row("SELECT delivery_id FROM mini_program_bridge_receipts WHERE delivery_id='delivery-1'"));
    }
    return f(url, request);
  };
  assert.equal((await pollMiniProgramBridgeOnce({ fetchImpl })).status, 'ACCEPTED');
  await pollMiniProgramBridgeOnce({ fetchImpl });
  await pollMiniProgramBridgeOnce({ fetchImpl: mock({ ...delivery, id: 'new-lease-1' }) });
  assert.equal(row("SELECT COUNT(*) n FROM messages WHERE platform_code='mini_program'").n, 1);
  assert.equal(row('SELECT COUNT(*) n FROM mini_program_processing_jobs').n, 1);
});
test('确认失败不丢消息；下次先补确认，不重复领取；重启后仍保留配置与收件', async () => {
  const delivery = { id: 'ack-failure', message: message('message-2') };
  const good = mock(delivery);
  await assert.rejects(pollMiniProgramBridgeOnce({ fetchImpl: (url, req) => url.endsWith('/ack') ? Promise.reject(new Error('network')) : good(url, req) }));
  assert.equal(getMiniProgramBridgeStatus().pendingReceipts, 1);
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    const {miniProgramConnectionSummary}=await import('./src/services/mini-program-connection.js');
    const {getMiniProgramBridgeStatus}=await import('./src/services/mini-program-bridge.js');
    console.log(JSON.stringify({settings:miniProgramConnectionSummary(),pending:getMiniProgramBridgeStatus().pendingReceipts}));
  `], { cwd: path.resolve(import.meta.dirname, '..'), env: process.env, encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  const restored = JSON.parse(child.stdout.trim());
  assert.equal(restored.pending, 1); assert.equal(restored.settings.clientId, miniProgramConnectionSummary().clientId);
  calls.length = 0;
  await pollMiniProgramBridgeOnce({ fetchImpl: mock() });
  assert.equal(calls.length, 1); assert.ok(calls[0].url.endsWith('/ack'));
  assert.equal(getMiniProgramBridgeStatus().pendingReceipts, 0);
});
test('无效消息明确拒收；跨应用消息绝不确认', async () => {
  const invalid = await pollMiniProgramBridgeOnce({ fetchImpl: mock({ id: 'invalid-1', message: message('invalid-1', { text: '' }) }) });
  assert.equal(invalid.status, 'REJECTED');
  assert.equal(row("SELECT code FROM mini_program_bridge_receipts WHERE delivery_id='invalid-1'").code, 'MINI_PROGRAM_PAYLOAD_INVALID');
  calls.length = 0;
  await assert.rejects(pollMiniProgramBridgeOnce({ fetchImpl: mock({ id: 'cross-app', message: message('cross-app', { appId: 'other' }) }) }));
  assert.equal(calls.length, 1);
  assert.equal(row("SELECT delivery_id FROM mini_program_bridge_receipts WHERE delivery_id='cross-app'"), undefined);
});
test('拒绝协议错配、Nonce 错配、超大响应、重定向及 HTML', async () => {
  for (const extra of [{ protocol: 'other' }, { appId: 'other' }, { requestNonce: 'replay' }, { padding: 'x'.repeat(50_000) }]) {
    await assert.rejects(pollMiniProgramBridgeOnce({ fetchImpl: mock(null, extra) }));
  }
  await assert.rejects(requestMiniProgramBridge(getMiniProgramConnection(), 'pull', {}, { fetchImpl: async () => new Response('', { status: 302, headers: { Location: 'https://other.test' } }) }));
  await assert.rejects(requestMiniProgramBridge(getMiniProgramConnection(), 'pull', {}, { fetchImpl: async () => new Response('<html/>') }));
});
test('回复沿用持久化回调队列，主动发送至服务器 /replies 并校验签名', async () => {
  const stored = row("SELECT * FROM messages WHERE external_id='mini-program:bridge-test:message:message-1'");
  const callback = enqueueMiniProgramReply({ message: stored, replyText: '这是一条测试回复' });
  let received;
  const result = await deliverMiniProgramCallback(callback.id, { fetchImpl: async (url, request) => {
    assert.equal(url, `${options.gatewayUrl}/replies`);
    verifyMiniProgramSignature({ method: 'POST', pathname: new URL(url).pathname, headers: request.headers,
      rawBody: request.body, appId: options.appId, secret });
    received = JSON.parse(request.body);
    return new Response(null, { status: 204 });
  } });
  assert.equal(result.delivered, true); assert.equal(received.inReplyToMessageId, 'message-1');
});
test('任务未完成时禁止改路由；暂停仅停止领取；已存在数据不允许换应用', async () => {
  assert.throws(() => saveMiniProgramConnection({ ...options, gatewayUrl: 'https://other.test/bridge' }), /待处理/);
  saveMiniProgramConnection({ ...options, enabled: false, sharedSecret: '' });
  assert.deepEqual(await pollMiniProgramBridgeOnce({ fetchImpl: () => { throw new Error('must not call'); } }), { skipped: true });
  assert.equal(getMiniProgramBridgeStatus().state, 'PAUSED');
  assert.throws(() => saveMiniProgramConnection({ ...options, appId: 'other-app' }), /应用标识/);
  clearQueues(); saveMiniProgramConnection(options);
});
test('后台连接失败进入退避重试；停止可取消正在进行的请求', async () => {
  startMiniProgramBridgeWorker({ fetchImpl: async () => { throw new Error('never leak secret or remote body'); } });
  await new Promise(r => setTimeout(r, 50));
  const status = getMiniProgramBridgeStatus();
  assert.equal(status.state, 'RETRYING'); assert.equal(status.consecutiveFailures, 1);
  assert.ok(status.nextAttemptAt); assert.ok(!JSON.stringify(status).includes('never leak'));
  await stopMiniProgramBridgeWorker();
  startMiniProgramBridgeWorker({ fetchImpl: (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('abort')), { once: true })) });
  await new Promise(r => setTimeout(r, 20));
  await stopMiniProgramBridgeWorker();
  assert.equal(getMiniProgramBridgeStatus().state, 'STOPPED');
});
