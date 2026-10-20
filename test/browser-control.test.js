import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { BrowserController } from '../agent/browser-control/controller.js';
import { BusinessBrowserRouter } from '../agent/browser-control/business-router.js';
import { AssistedPlatformRpaAdapter } from '../agent/rpa-adapters/assisted-platform.js';
import { PlatformWebAccessManager } from '../agent/browser-control/platform-web-access-manager.js';
import { WebAccessCdpProvider } from '../agent/browser-control/providers/web-access-cdp-provider.js';
import { normalizeBrowserCommand, pathInsideRoots } from '../src/services/browser-control-policy.js';
import { cleanupDir, jsonRequest, startServer, stopChild, tempRuntimeDir } from './helpers/runtime.js';

function policy(overrides = {}) {
  const fileRoot = overrides.fileRoot || path.resolve('data/materials');
  return {
    defaultProvider: 'web_access_cdp',
    activePlatformCodes: ['douyin'],
    enabledPlatformCodes: ['douyin'],
    interactiveEnabled: false,
    config: {
      browserControlAllowedHosts: [],
      browserControlFileRoots: [fileRoot],
      platformRpa: {
        douyin: {
          publishUrl: 'https://creator.douyin.com/creator-micro/content/upload',
          manageUrl: 'https://creator.douyin.com/creator-micro/content/manage'
        }
      }
    },
    ...overrides
  };
}

function commandInput(overrides = {}) {
  return {
    platformCode: 'douyin',
    accountId: 2,
    provider: 'web_access_cdp',
    purpose: 'DIAGNOSTIC',
    action: 'READ_PAGE_STATE',
    params: {},
    ...overrides
  };
}

function errorCode(expected) {
  return error => error?.code === expected;
}

async function unusedTcpPort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

test('浏览器命令策略限制域名、敏感字段、高风险 selector 与文件目录', () => {
  const fileRoot = path.resolve('data/materials');
  const accepted = normalizeBrowserCommand(commandInput({
    action: 'OPEN_PAGE',
    params: { url: 'https://creator.douyin.com/creator-micro/content/upload' }
  }), policy({ fileRoot }));
  assert.equal(accepted.params.url, 'https://creator.douyin.com/creator-micro/content/upload');
  assert.equal(accepted.accountId, 2);

  assert.throws(() => normalizeBrowserCommand(commandInput({ accountId: null }), policy()), errorCode('BROWSER_ACCOUNT_REQUIRED'));
  assert.throws(() => normalizeBrowserCommand(commandInput({ action: 'OPEN_PAGE', params: { url: 'http://creator.douyin.com/' } }), policy()), errorCode('BROWSER_URL_PROTOCOL_BLOCKED'));
  assert.throws(() => normalizeBrowserCommand(commandInput({ action: 'OPEN_PAGE', params: { url: 'https://example.com/' } }), policy()), errorCode('BROWSER_DOMAIN_NOT_ALLOWED'));
  assert.throws(() => normalizeBrowserCommand(commandInput({ params: { nested: { Cookies: true } } }), policy()), errorCode('BROWSER_COMMAND_FORBIDDEN_FIELD'));
  assert.throws(() => normalizeBrowserCommand(commandInput({ params: { verification_code: '123456' } }), policy()), errorCode('BROWSER_COMMAND_FORBIDDEN_FIELD'));
  assert.throws(() => normalizeBrowserCommand(commandInput({ action: 'CLICK', purpose: 'ASSISTED_NAVIGATION', params: { selector: 'button.send-comment' } }), policy({ interactiveEnabled: true })), errorCode('BROWSER_HIGH_RISK_SELECTOR_BLOCKED'));
  assert.throws(() => normalizeBrowserCommand(commandInput({ action: 'CLICK', purpose: 'ASSISTED_NAVIGATION', params: { selector: 'button.next' } }), policy()), errorCode('BROWSER_INTERACTIVE_DISABLED'));

  const confirmed = normalizeBrowserCommand(commandInput({
    action: 'CLICK',
    purpose: 'ASSISTED_NAVIGATION',
    operatorConfirmedAt: new Date().toISOString(),
    params: { selector: 'button.next' }
  }), policy({ interactiveEnabled: true }));
  assert.equal(confirmed.confirmationRequired, true);
  assert.throws(() => normalizeBrowserCommand(commandInput({
    action: 'CLICK',
    purpose: 'ASSISTED_NAVIGATION',
    operatorConfirmedAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    params: { selector: 'button.next' }
  }), policy({ interactiveEnabled: true })), errorCode('BROWSER_OPERATOR_CONFIRMATION_FUTURE'));

  const allowedFile = path.join(fileRoot, 'video.mp4');
  const upload = normalizeBrowserCommand(commandInput({
    action: 'SET_FILES',
    purpose: 'FILE_PREP',
    operatorConfirmedAt: new Date().toISOString(),
    params: { selector: 'input[type=file]', files: [allowedFile] }
  }), policy({ interactiveEnabled: true, fileRoot }));
  assert.equal(pathInsideRoots(upload.params.files[0], [fileRoot]), true);
  assert.throws(() => normalizeBrowserCommand(commandInput({
    action: 'SET_FILES',
    purpose: 'FILE_PREP',
    operatorConfirmedAt: new Date().toISOString(),
    params: { selector: 'input[type=file]', files: [path.resolve('outside.mp4')] }
  }), policy({ interactiveEnabled: true, fileRoot })), errorCode('BROWSER_FILE_PATH_BLOCKED'));
});

function controllerConfig({ interactiveEnabled = false } = {}) {
  return {
    browserControlEnabled: true,
    browserControlProvider: 'web_access_cdp',
    browserControlEnabledPlatforms: ['douyin'],
    browserControlInteractiveEnabled: interactiveEnabled,
    browserControlRiskAcknowledged: false,
    browserControlAllowedHosts: [],
    browserControlFileRoots: [path.resolve('data/materials')],
    activePlatformCodes: ['douyin'],
    platformRpa: { douyin: { publishUrl: 'https://creator.douyin.com/creator-micro/content/upload' } }
  };
}

function makeController({ interactiveEnabled = false, failActions = [] } = {}) {
  const calls = [];
  const provider = {
    name: 'web_access_cdp',
    async execute(command, context) {
      calls.push({ command, context });
      if (failActions.includes(command.action)) {
        const error = new Error('fake provider failure');
        error.code = 'FAKE_PROVIDER_FAILURE';
        throw error;
      }
      if (command.action === 'OPEN_PAGE') return { managedTabId: 'tab-1', url: command.params.url };
      if (command.action === 'CLOSE_TAB') return { managedTabId: null, closed: true };
      return { managedTabId: context.managedTabId, action: command.action };
    }
  };
  const registry = {
    providers: new Map([[provider.name, provider]]),
    get(name) { if (name !== provider.name) throw Object.assign(new Error('missing provider'), { code: 'BROWSER_PROVIDER_UNAVAILABLE' }); return provider; },
    list() { return [{ name: provider.name, available: true }]; },
    async stop() {}
  };
  const evidenceStore = { screenshotPath: () => path.resolve('logs/browser-control/test.png') };
  return { controller: new BrowserController({ config: controllerConfig({ interactiveEnabled }), registry, evidenceStore, logger: { warn() {} } }), calls };
}

function controllerPayload(overrides = {}) {
  return {
    browserCommandId: 1,
    sessionId: 'session-1',
    platformCode: 'douyin',
    accountId: 2,
    provider: 'web_access_cdp',
    purpose: 'DIAGNOSTIC',
    action: 'READ_PAGE_STATE',
    params: {},
    ...overrides
  };
}

test('BrowserController 固定 session 并复用、关闭 managedTabId', async () => {
  const { controller, calls } = makeController();
  const opened = await controller.execute({ id: 1, payload: controllerPayload({ action: 'OPEN_PAGE', params: { url: 'https://creator.douyin.com/creator-micro/content/upload' } }) });
  assert.equal(opened.status, 'SUCCESS');
  assert.equal(opened.result.managedTabId, 'tab-1');

  const read = await controller.execute({ id: 2, payload: controllerPayload({ browserCommandId: 2, action: 'READ_PAGE_STATE' }) });
  assert.equal(read.status, 'SUCCESS');
  assert.equal(calls.at(-1).context.managedTabId, 'tab-1');

  const closed = await controller.execute({ id: 3, payload: controllerPayload({ browserCommandId: 3, action: 'CLOSE_TAB' }) });
  assert.equal(closed.status, 'SUCCESS');
  assert.equal(closed.result.managedTabId, null);
});

test('BrowserController 将交互式不确定失败转人工确认，只读失败保持 FAILED', async () => {
  const interactive = makeController({ interactiveEnabled: true, failActions: ['CLICK'] }).controller;
  const click = await interactive.execute({ id: 1, payload: controllerPayload({
    action: 'CLICK',
    purpose: 'ASSISTED_NAVIGATION',
    operatorConfirmedAt: new Date().toISOString(),
    managedTabId: 'tab-1',
    params: { selector: 'button.next' }
  }) });
  assert.equal(click.status, 'NEEDS_CONFIRMATION');
  assert.equal(click.result.operationMayHaveOccurred, true);

  const readonly = makeController({ failActions: ['READ_PAGE_STATE'] }).controller;
  const read = await readonly.execute({ id: 2, payload: controllerPayload({ action: 'READ_PAGE_STATE', managedTabId: 'tab-1' }) });
  assert.equal(read.status, 'FAILED');
  assert.equal(read.result.operationMayHaveOccurred, false);
});

test('云端默认关闭浏览器命令创建', async t => {
  const runtime = await startServer({ env: { BROWSER_CONTROL_ENABLED: 'false', BROWSER_CONTROL_ENABLED_PLATFORMS: '' } });
  t.after(async () => { await stopChild(runtime.child); cleanupDir(runtime.dir); });
  const bootstrap = (await jsonRequest(runtime.base, '/api/bootstrap')).data;
  const account = bootstrap.accounts.find(item => item.platform_code === 'douyin');
  const response = await jsonRequest(runtime.base, '/api/browser-control/commands', { method: 'POST', body: {
    platformCode: 'douyin', accountId: account.id, provider: 'web_access_cdp', purpose: 'DIAGNOSTIC', action: 'OPEN_PAGE', params: { url: 'https://creator.douyin.com/creator-micro/content/upload' }
  } });
  assert.equal(response.response.status, 409);
  assert.equal(response.data.code, 'BROWSER_CONTROL_DISABLED');
});

test('云端命令、Agent claim/complete、session 与幂等状态形成闭环', async t => {
  const runtime = await startServer({ env: {
    BROWSER_CONTROL_ENABLED: 'true',
    BROWSER_CONTROL_ENABLED_PLATFORMS: 'douyin',
    BROWSER_CONTROL_INTERACTIVE_ENABLED: 'false'
  } });
  t.after(async () => { await stopChild(runtime.child); cleanupDir(runtime.dir); });

  const bootstrap = (await jsonRequest(runtime.base, '/api/bootstrap')).data;
  const account = bootstrap.accounts.find(item => item.platform_code === 'douyin');
  assert.ok(account?.enabled);
  const createBody = {
    platformCode: 'douyin',
    accountId: account.id,
    provider: 'web_access_cdp',
    purpose: 'DIAGNOSTIC',
    action: 'OPEN_PAGE',
    idempotencyKey: 'browser-test-open-1',
    params: { url: 'https://creator.douyin.com/creator-micro/content/upload' }
  };
  const created = await jsonRequest(runtime.base, '/api/browser-control/commands', { method: 'POST', body: createBody });
  assert.equal(created.response.status, 201, created.text);
  assert.equal(created.data.command.status, 'QUEUED');
  assert.equal(created.data.session.provider, 'web_access_cdp');

  const duplicate = await jsonRequest(runtime.base, '/api/browser-control/commands', { method: 'POST', body: createBody });
  assert.equal(duplicate.response.status, 200, duplicate.text);
  assert.equal(duplicate.data.reused, true);
  assert.equal(duplicate.data.command.id, created.data.command.id);
  const conflict = await jsonRequest(runtime.base, '/api/browser-control/commands', { method: 'POST', body: {
    ...createBody,
    params: { url: 'https://creator.douyin.com/creator-micro/content/manage' }
  } });
  assert.equal(conflict.response.status, 409, conflict.text);
  assert.equal(conflict.data.code, 'BROWSER_IDEMPOTENCY_CONFLICT');

  const claimed = await jsonRequest(runtime.base, '/api/agent/jobs/claim', { method: 'POST', body: { deviceId: account.device_id, platformCodes: ['douyin'] } });
  assert.equal(claimed.response.status, 200, claimed.text);
  assert.equal(claimed.data.job.job_type, 'BROWSER_COMMAND');
  assert.equal(claimed.data.job.payload.browserCommandId, created.data.command.id);

  const running = await jsonRequest(runtime.base, `/api/browser-control/commands/${created.data.command.id}`);
  assert.equal(running.data.command.status, 'RUNNING');

  const completed = await jsonRequest(runtime.base, `/api/agent/jobs/${claimed.data.job.id}/complete`, { method: 'POST', body: {
    status: 'SUCCESS',
    result: { managedTabId: 'tab-cloud-1', url: 'https://creator.douyin.com/creator-micro/content/upload', evidenceRef: 'logs/browser-control/example.png' }
  } });
  assert.equal(completed.response.status, 200, completed.text);

  const detail = await jsonRequest(runtime.base, `/api/browser-control/commands/${created.data.command.id}`);
  assert.equal(detail.data.command.status, 'SUCCESS');
  assert.equal(detail.data.session.managed_tab_id, 'tab-cloud-1');
  assert.equal(detail.data.session.current_url, 'https://creator.douyin.com/creator-micro/content/upload');
  assert.deepEqual(detail.data.events.map(item => item.event_type), ['CREATED', 'CLAIMED', 'COMPLETED']);

  const navigateBody = {
    platformCode: 'douyin',
    accountId: account.id,
    sessionId: created.data.session.id,
    provider: 'web_access_cdp',
    purpose: 'DIAGNOSTIC',
    action: 'NAVIGATE',
    idempotencyKey: 'browser-test-nav-1',
    params: { url: 'https://creator.douyin.com/creator-micro/content/manage' }
  };
  const navigate = await jsonRequest(runtime.base, '/api/browser-control/commands', { method: 'POST', body: navigateBody });
  assert.equal(navigate.response.status, 201, navigate.text);

  const heartbeat = await jsonRequest(runtime.base, '/api/agent/heartbeat', { method: 'POST', body: {
    deviceId: account.device_id,
    version: 'browser-test-agent',
    browserControl: { enabled: true, defaultProvider: 'web_access_cdp', providers: [{ name: 'web_access_cdp', available: true }] }
  } });
  assert.equal(heartbeat.response.status, 200, heartbeat.text);

  const db = new DatabaseSync(runtime.dbPath, { readOnly: true });
  try {
    const deviceColumns = db.prepare('PRAGMA table_info(devices)').all().map(item => item.name);
    assert.ok(deviceColumns.includes('browser_control_json'));
    for (const table of ['browser_sessions', 'browser_commands', 'browser_command_events']) {
      assert.ok(db.prepare(`PRAGMA table_info(${table})`).all().length > 0, table);
    }
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM browser_sessions').get().count, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM browser_commands').get().count, 2);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM agent_jobs WHERE job_type='BROWSER_COMMAND'").get().count, 2);
    const browserCapability = JSON.parse(db.prepare('SELECT browser_control_json FROM devices WHERE id=?').get(account.device_id).browser_control_json);
    assert.equal(browserCapability.defaultProvider, 'web_access_cdp');
  } finally {
    db.close();
  }
});


test('浏览器命令重启恢复区分只读与交互式动作', async t => {
  const dir = tempRuntimeDir('browser-recovery-');
  const first = await startServer({ dir, env: { BROWSER_CONTROL_ENABLED: 'true', BROWSER_CONTROL_ENABLED_PLATFORMS: 'douyin' } });
  await stopChild(first.child);

  const db = new DatabaseSync(first.dbPath);
  const stamp = new Date().toISOString();
  const expiry = new Date(Date.now() + 600_000).toISOString();
  const account = db.prepare("SELECT * FROM accounts WHERE platform_code='douyin' LIMIT 1").get();
  const insertSession = db.prepare(`INSERT INTO browser_sessions(id,device_id,platform_code,account_id,provider,purpose,state,managed_tab_id,created_at,updated_at)
    VALUES(?,?,?,?,?,'DIAGNOSTIC','OPEN',?,?,?)`);
  const insertCommand = db.prepare(`INSERT INTO browser_commands(session_id,device_id,platform_code,account_id,provider,action,purpose,params_json,status,created_at,updated_at)
    VALUES(?,?,?,?,?,?,'DIAGNOSTIC','{}','RUNNING',?,?)`);
  const insertJob = db.prepare(`INSERT INTO agent_jobs(device_id,job_type,payload,status,created_at,claimed_at,available_at,lease_expires_at)
    VALUES(?,'BROWSER_COMMAND',?,'RUNNING',?,?,?,?)`);
  for (const [suffix, action] of [['safe', 'READ_PAGE_STATE'], ['interactive', 'CLICK']]) {
    const sessionId = `browser-recovery-${suffix}`;
    insertSession.run(sessionId, account.device_id, 'douyin', account.id, 'web_access_cdp', `tab-${suffix}`, stamp, stamp);
    const command = insertCommand.run(sessionId, account.device_id, 'douyin', account.id, 'web_access_cdp', action, stamp, stamp);
    const commandId = Number(command.lastInsertRowid);
    const job = insertJob.run(account.device_id, JSON.stringify({ browserCommandId: commandId, sessionId, platformCode: 'douyin', accountId: account.id, provider: 'web_access_cdp', action }), stamp, stamp, stamp, expiry);
    db.prepare('UPDATE browser_commands SET agent_job_id=? WHERE id=?').run(Number(job.lastInsertRowid), commandId);
  }
  db.close();

  const second = await startServer({ dir, env: { BROWSER_CONTROL_ENABLED: 'true', BROWSER_CONTROL_ENABLED_PLATFORMS: 'douyin' } });
  t.after(async () => { await stopChild(second.child); cleanupDir(dir); });
  const verify = new DatabaseSync(first.dbPath, { readOnly: true });
  try {
    const jobs = verify.prepare("SELECT payload,status,result FROM agent_jobs WHERE job_type='BROWSER_COMMAND' ORDER BY id").all();
    const byAction = Object.fromEntries(jobs.map(item => [JSON.parse(item.payload).action, item]));
    assert.equal(byAction.READ_PAGE_STATE.status, 'QUEUED');
    assert.equal(JSON.parse(byAction.READ_PAGE_STATE.result).reason, 'PROCESS_RESTART_SAFE_REQUEUE');
    assert.equal(byAction.CLICK.status, 'NEEDS_CONFIRMATION');
    assert.equal(JSON.parse(byAction.CLICK.result).reason, 'PROCESS_RESTART_NON_IDEMPOTENT');

    const commands = verify.prepare('SELECT action,status FROM browser_commands ORDER BY id').all();
    assert.deepEqual(Object.fromEntries(commands.map(item => [item.action, item.status])), { READ_PAGE_STATE: 'QUEUED', CLICK: 'NEEDS_CONFIRMATION' });
    const events = verify.prepare("SELECT status,COUNT(*) AS count FROM browser_command_events WHERE event_type='RECOVERED' GROUP BY status").all();
    assert.deepEqual(Object.fromEntries(events.map(item => [item.status, item.count])), { NEEDS_CONFIRMATION: 1, QUEUED: 1 });
  } finally {
    verify.close();
  }
});

test('Web Access 主控模式会覆盖显式 Playwright 请求，并记录实际 Provider', async () => {
  const calls = [];
  const webAccess = {
    name: 'web_access_cdp',
    async execute(command) {
      calls.push(command.provider);
      return { managedTabId: 'web-tab' };
    }
  };
  const playwright = { name: 'playwright', async execute() { throw new Error('不应调用 Playwright'); } };
  const providers = new Map([[webAccess.name, webAccess], [playwright.name, playwright]]);
  const registry = { providers, get: name => providers.get(name), list: () => [...providers.values()].map(item => ({ name: item.name, available: true })), async stop() {} };
  const config = {
    ...controllerConfig(),
    browserControlMode: 'web_access_primary',
    browserControlPrimaryProvider: 'web_access_cdp',
    browserControlFallbackProvider: 'playwright',
    browserControlLegacyFallbackEnabled: true
  };
  const controller = new BrowserController({ config, registry, evidenceStore: { screenshotPath: () => 'unused' }, logger: { warn() {} } });
  const output = await controller.execute({ id: 10, payload: controllerPayload({ provider: 'playwright', action: 'OPEN_PAGE', params: { url: 'https://creator.douyin.com/creator-micro/content/upload' } }) });
  assert.equal(output.status, 'SUCCESS');
  assert.deepEqual(calls, ['web_access_cdp']);
  assert.equal(output.result.providerRequested, 'playwright');
  assert.equal(output.result.providerUsed, 'web_access_cdp');
  assert.equal(output.result.fallbackUsed, false);
});

test('Web Access 启动失败时仅安全建页动作允许回退，交互动作禁止自动重试', async () => {
  const calls = [];
  const webAccess = {
    name: 'web_access_cdp',
    async execute(command) {
      calls.push(`web:${command.action}`);
      const error = new Error('proxy unavailable');
      error.code = 'WEB_ACCESS_PROXY_UNREACHABLE';
      throw error;
    }
  };
  const playwright = {
    name: 'playwright',
    async execute(command) {
      calls.push(`playwright:${command.action}`);
      return { managedTabId: 'fallback-tab' };
    }
  };
  const providers = new Map([[webAccess.name, webAccess], [playwright.name, playwright]]);
  const registry = { providers, get: name => providers.get(name), list: () => [], async stop() {} };
  const config = {
    ...controllerConfig({ interactiveEnabled: true }),
    browserControlMode: 'web_access_primary',
    browserControlPrimaryProvider: 'web_access_cdp',
    browserControlFallbackProvider: 'playwright',
    browserControlLegacyFallbackEnabled: true
  };
  const controller = new BrowserController({ config, registry, evidenceStore: { screenshotPath: () => 'unused' }, logger: { warn() {} } });
  const opened = await controller.execute({ id: 11, payload: controllerPayload({ sessionId: 'fallback-open', action: 'OPEN_PAGE', params: { url: 'https://creator.douyin.com/creator-micro/content/upload' } }) });
  assert.equal(opened.status, 'SUCCESS');
  assert.equal(opened.result.providerUsed, 'playwright');
  assert.equal(opened.result.fallbackUsed, true);
  assert.equal(opened.result.fallbackReason.code, 'WEB_ACCESS_PROXY_UNREACHABLE');

  const clicked = await controller.execute({ id: 12, payload: controllerPayload({ sessionId: 'no-fallback-click', action: 'CLICK', purpose: 'ASSISTED_NAVIGATION', operatorConfirmedAt: new Date().toISOString(), params: { selector: 'button.next' } }) });
  assert.equal(clicked.status, 'NEEDS_CONFIRMATION');
  assert.equal(clicked.result.fallbackUsed, false);
  assert.equal(calls.includes('playwright:CLICK'), false);
});


test('Web Access Provider 首次健康检查未连接时会用只读 targets 请求建立连接', async () => {
  const provider = new WebAccessCdpProvider({ autoStart: false, riskAcknowledged: true });
  let healthCalls = 0;
  let targetsCalls = 0;
  provider.health = async () => (++healthCalls === 1
    ? { status: 'ok', connected: false }
    : { status: 'ok', connected: true });
  provider.request = async pathname => {
    assert.equal(pathname, '/targets');
    targetsCalls += 1;
    return [];
  };
  const ready = await provider.ensureReady();
  assert.equal(ready.connected, true);
  assert.equal(targetsCalls, 1);
  assert.equal(healthCalls, 2);
});

test('五平台 Web Access 运行时使用互不重复的 Proxy、Debug 端口并标明 Profile 隔离', () => {
  const profiles = Object.fromEntries(['xiaohongshu', 'douyin', 'wechat_channels', 'bilibili', 'weibo'].map(code => [code, path.resolve('data/browser-profiles', code)]));
  const manager = new PlatformWebAccessManager({ enabled: true, mode: 'web_access_primary', platformProfiles: profiles, proxyBasePort: 3456, browserDebugBasePort: 9310 });
  const states = manager.listPlatformStates();
  assert.equal(states.length, 5);
  assert.deepEqual(states.map(item => item.platformCode), ['xiaohongshu', 'douyin', 'wechat_channels', 'bilibili', 'weibo']);
  const ports = states.map(item => manager.portsFor(item.platformCode));
  assert.equal(new Set(ports.map(item => item.proxyPort)).size, 5);
  assert.equal(new Set(ports.map(item => item.browserDebugPort)).size, 5);
  assert.deepEqual(ports[0], { proxyPort: 3456, browserDebugPort: 9310 });
  assert.deepEqual(ports[1], { proxyPort: 3457, browserDebugPort: 9311 });
  assert.deepEqual(ports[2], { proxyPort: 3458, browserDebugPort: 9312 });
  assert.deepEqual(ports[4], { proxyPort: 3460, browserDebugPort: 9314 });
});

test('本 Agent 本轮启动的 Chrome 无 DevToolsActivePort 时可凭受跟踪进程通过', async () => {
  const dir = tempRuntimeDir('web-access-tracked-no-marker-');
  const port = await unusedTcpPort();
  const socketPath = '/devtools/browser/tracked-no-marker';
  const fakeChild = new EventEmitter();
  fakeChild.pid = 95201;
  fakeChild.exitCode = null;
  fakeChild.signalCode = null;
  fakeChild.kill = () => true;
  let server = null;
  let spawnCalls = 0;
  const manager = new PlatformWebAccessManager({
    enabled: true,
    mode: 'web_access_primary',
    riskAcknowledged: true,
    executablePath: process.execPath,
    platformOrder: ['douyin'],
    platformProfiles: { douyin: dir },
    browserDebugBasePort: port,
    requestTimeoutMs: 500,
    spawnProcess() {
      spawnCalls += 1;
      server = createServer((request, response) => {
        if (request.url === '/json/version') {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ webSocketDebuggerUrl: `ws://127.0.0.1:${port}${socketPath}` }));
          return;
        }
        response.writeHead(404).end();
      });
      server.once('error', error => fakeChild.emit('error', error));
      server.listen(port, '127.0.0.1');
      return fakeChild;
    },
    logger: { log() {}, warn() {} }
  });
  const state = manager.stateFor('douyin');
  try {
    await manager.launchBrowser(state);
    assert.equal(spawnCalls, 1);
    assert.equal(fs.existsSync(path.join(dir, 'DevToolsActivePort')), false);
    const status = await manager.debugEndpointStatus(state);
    assert.equal(status.ready, true);
    assert.equal(status.detail.ownership.valid, true);
    assert.equal(status.detail.ownership.pid, fakeChild.pid);
    assert.equal(status.detail.ownershipProof, 'TRACKED_CHILD_AND_PRELAUNCH_PORT_FREE');
  } finally {
    if (fakeChild.exitCode === null) {
      fakeChild.exitCode = 0;
      fakeChild.emit('exit', 0, null);
    }
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    await manager.stop();
    cleanupDir(dir);
  }
});

test('外部已有调试端口无 DevToolsActivePort 时拒绝连接且不启动 Chrome', async () => {
  const dir = tempRuntimeDir('web-access-external-no-marker-');
  const socketPath = '/devtools/browser/external-no-marker';
  const server = createServer((request, response) => {
    if (request.url === '/json/version') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ webSocketDebuggerUrl: `ws://127.0.0.1:${server.address().port}${socketPath}` }));
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  let spawnCalls = 0;
  try {
    const port = server.address().port;
    const manager = new PlatformWebAccessManager({
      enabled: true,
      mode: 'web_access_primary',
      riskAcknowledged: true,
      executablePath: process.execPath,
      platformOrder: ['douyin'],
      platformProfiles: { douyin: dir },
      browserDebugBasePort: port,
      spawnProcess() {
        spawnCalls += 1;
        throw new Error('occupied external port must not spawn');
      },
      logger: { log() {}, warn() {} }
    });
    await assert.rejects(
      manager.launchBrowser(manager.stateFor('douyin')),
      error => error.code === 'BROWSER_DEBUG_PORT_IN_USE'
        && error.detail.portListening === true
        && error.detail.marker.exists === false
    );
    assert.equal(spawnCalls, 0);
  } finally {
    await new Promise(resolve => server.close(resolve));
    cleanupDir(dir);
  }
});

test('Web Access 同时校验端口监听、DevToolsActivePort、json/version WebSocket 与 Profile', async () => {
  const dir = tempRuntimeDir('web-access-profile-match-');
  const socketPath = '/devtools/browser/profile-match';
  const server = createServer((request, response) => {
    if (request.url === '/json/version') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ webSocketDebuggerUrl: `ws://127.0.0.1:${server.address().port}${socketPath}` }));
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    const port = server.address().port;
    fs.writeFileSync(path.join(dir, 'DevToolsActivePort'), `${port}\n${socketPath}\n`, 'utf8');
    const manager = new PlatformWebAccessManager({
      enabled: true,
      mode: 'web_access_primary',
      platformOrder: ['douyin'],
      platformProfiles: { douyin: dir },
      browserDebugBasePort: port
    });
    const state = manager.stateFor('douyin');
    const status = await manager.debugEndpointStatus(state);
    assert.equal(status.ready, true);
    assert.equal(status.detail.portListening, true);
    assert.equal(status.detail.marker.port, port);
    assert.equal(status.detail.endpoint.path, socketPath);

    fs.writeFileSync(path.join(dir, 'DevToolsActivePort'), `${port}\n/devtools/browser/another-profile\n`, 'utf8');
    await assert.rejects(
      manager.debugEndpointStatus(state),
      error => error.code === 'WEB_ACCESS_PROFILE_WEBSOCKET_MISMATCH'
        && error.detail.marker.webSocketPath === '/devtools/browser/another-profile'
    );
  } finally {
    await new Promise(resolve => server.close(resolve));
    cleanupDir(dir);
  }
});

test('DevToolsActivePort 缺失第二行 WebSocket 路径时拒绝接管 Profile', async () => {
  const dir = tempRuntimeDir('web-access-profile-marker-path-missing-');
  const socketPath = '/devtools/browser/profile-marker-path-missing';
  const server = createServer((request, response) => {
    if (request.url === '/json/version') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ webSocketDebuggerUrl: `ws://127.0.0.1:${server.address().port}${socketPath}` }));
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    const port = server.address().port;
    fs.writeFileSync(path.join(dir, 'DevToolsActivePort'), `${port}\n`, 'utf8');
    let spawnCalls = 0;
    const manager = new PlatformWebAccessManager({
      enabled: true,
      mode: 'web_access_primary',
      riskAcknowledged: true,
      executablePath: process.execPath,
      platformOrder: ['douyin'],
      platformProfiles: { douyin: dir },
      browserDebugBasePort: port,
      spawnProcess() {
        spawnCalls += 1;
        throw new Error('incomplete external marker must not spawn');
      },
      logger: { log() {}, warn() {} }
    });
    const state = manager.stateFor('douyin');
    await assert.rejects(
      manager.launchBrowser(state),
      error => error.code === 'BROWSER_DEBUG_PORT_IN_USE'
        && error.detail.marker.webSocketPath === null
        && /DevToolsActivePort|WebSocket|Profile/i.test(error.message)
    );
    assert.equal(spawnCalls, 0);
  } finally {
    await new Promise(resolve => server.close(resolve));
    cleanupDir(dir);
  }
});

test('Web Access 等待日志文件 fd 打开后再交给真实 Node spawn', async () => {
  const dir = tempRuntimeDir('web-access-real-spawn-log-fd-');
  let observedLogFd = null;
  const manager = new PlatformWebAccessManager({
    enabled: true,
    mode: 'web_access_primary',
    riskAcknowledged: true,
    executablePath: process.execPath,
    platformOrder: ['douyin'],
    platformProfiles: { douyin: dir },
    browserDebugBasePort: 49121,
    requestTimeoutMs: 50,
    spawnProcess(executable, args, options) {
      const logTarget = options.stdio[1];
      observedLogFd = typeof logTarget === 'number' ? logTarget : logTarget?.fd;
      if (!Number.isInteger(observedLogFd)) {
        const error = new TypeError('stdio log fd is not open');
        error.code = 'ERR_INVALID_ARG_VALUE';
        throw error;
      }
      return spawn(process.execPath, ['-e', 'process.exit(0)'], options);
    },
    logger: { log() {}, warn() {} }
  });
  manager.debugEndpointReady = async () => false;
  manager.debugEndpointStatus = async () => ({ ready: false, detail: { portListening: false } });
  try {
    let failure = null;
    await manager.launchBrowser(manager.stateFor('douyin')).catch(error => { failure = error; });
    assert.ok(Number.isInteger(observedLogFd) && observedLogFd >= 0, 'spawn 前日志 WriteStream 必须已有有效 fd');
    assert.notEqual(failure?.code, 'BROWSER_PROCESS_SPAWN_FAILED');
    assert.doesNotMatch(`${failure?.message || ''} ${failure?.detail?.spawnError?.message || ''}`, /ERR_INVALID_ARG_VALUE|stdio/i);
    assert.equal(failure?.code, 'BROWSER_PROCESS_EXITED_EARLY');
  } finally {
    await manager.stop();
    cleanupDir(dir);
  }
});

test('Web Access Chrome stdout/stderr 写入平台独立日志并返回具体提前退出原因', async () => {
  const dir = tempRuntimeDir('web-access-chrome-log-');
  let spawnOptions = null;
  const fakeChild = new EventEmitter();
  fakeChild.pid = 91234;
  fakeChild.exitCode = 23;
  fakeChild.signalCode = null;
  fakeChild.kill = () => true;
  const manager = new PlatformWebAccessManager({
    enabled: true,
    mode: 'web_access_primary',
    riskAcknowledged: true,
    executablePath: process.execPath,
    platformOrder: ['douyin'],
    platformProfiles: { douyin: dir },
    browserDebugBasePort: 49111,
    requestTimeoutMs: 50,
    spawnProcess(executable, args, options) {
      spawnOptions = { executable, args, options };
      return fakeChild;
    },
    logger: { log() {}, warn() {} }
  });
  manager.debugEndpointReady = async () => false;
  manager.debugEndpointStatus = async () => ({ ready: false, detail: { portListening: false } });
  try {
    let failure = null;
    await manager.acquirePlatformContext({ platformCode: 'douyin' }).catch(error => { failure = error; });
    assert.equal(failure?.code, 'BROWSER_PROCESS_EXITED_EARLY');
    assert.equal(failure?.detail?.processExitCode, 23);
    assert.match(failure?.detail?.logPath || '', /logs[\\/]web-access-douyin-chrome\.log$/);
    assert.ok(spawnOptions);
    assert.notEqual(spawnOptions.options.stdio, 'ignore');
    assert.equal(spawnOptions.options.stdio[0], 'ignore');
    assert.equal(spawnOptions.options.stdio[1], spawnOptions.options.stdio[2]);
    assert.equal(spawnOptions.options.stdio[1].path, failure.detail.logPath);
    assert.match(fs.readFileSync(failure.detail.logPath, 'utf8'), /launch platform=douyin debugPort=49111/);
  } finally {
    await manager.stop();
    cleanupDir(dir);
  }
});

test('Web Access 启动失败会先确认本 Agent 子进程退出，再允许 legacy fallback', async () => {
  const dir = tempRuntimeDir('web-access-exit-before-fallback-');
  const child = new EventEmitter();
  child.pid = 92345;
  child.exitCode = null;
  child.signalCode = null;
  child.kill = () => {
    setTimeout(() => {
      child.exitCode = 0;
      child.emit('exit', 0, null);
    }, 10);
    return true;
  };
  const manager = new PlatformWebAccessManager({
    enabled: true,
    mode: 'web_access_primary',
    platformOrder: ['douyin'],
    platformProfiles: { douyin: dir },
    fallbackRetryCooldownMs: 60_000,
    spawnProcess() {
      const killer = new EventEmitter();
      setImmediate(() => {
        child.exitCode = 0;
        child.emit('exit', 0, null);
        killer.emit('exit', 0, null);
      });
      return killer;
    },
    logger: { log() {}, warn() {} }
  });
  manager.launchBrowser = async state => {
    state.browserProcess = child;
    const error = new Error('synthetic launch failure');
    error.code = 'BROWSER_PROCESS_SPAWN_FAILED';
    error.detail = { platformCode: state.platformCode };
    throw error;
  };
  try {
    let failure = null;
    await manager.acquirePlatformContext({ platformCode: 'douyin' }).catch(error => { failure = error; });
    assert.equal(child.exitCode, 0);
    assert.equal(failure?.code, 'BROWSER_PROCESS_SPAWN_FAILED');
    assert.equal(manager.shouldUseLegacyFallback(failure), true);
    assert.equal(manager.stateFor('douyin').fallbackActive, true);
  } finally {
    await manager.stop();
    cleanupDir(dir);
  }
});

test('Windows 清理本 Agent Chrome 时根进程退出后仍执行 taskkill /T /F 保障进程树回收', { skip: process.platform !== 'win32' }, async () => {
  const dir = tempRuntimeDir('web-access-windows-process-tree-');
  const child = new EventEmitter();
  child.pid = 93456;
  child.exitCode = null;
  child.signalCode = null;
  const killSignals = [];
  child.kill = signal => {
    killSignals.push(signal);
    if (signal === 'SIGTERM') {
      setImmediate(() => {
        child.exitCode = 0;
        child.emit('exit', 0, null);
      });
    }
    return true;
  };
  const spawnedKillers = [];
  const manager = new PlatformWebAccessManager({
    enabled: true,
    mode: 'web_access_primary',
    platformOrder: ['douyin'],
    platformProfiles: { douyin: dir },
    spawnProcess(executable, args, options) {
      spawnedKillers.push({ executable, args, options });
      const killer = new EventEmitter();
      setImmediate(() => {
        child.exitCode = 0;
        child.emit('exit', 0, null);
        killer.emit('exit', 0, null);
      });
      return killer;
    },
    logger: { log() {}, warn() {} }
  });
  const state = manager.stateFor('douyin');
  state.provider.stop = async () => {};
  state.browserProcess = child;
  try {
    const stopped = await manager.stopPlatform('douyin');
    assert.equal(stopped.processExited, true);
    assert.deepEqual(killSignals, []);
    assert.equal(spawnedKillers.length, 1, 'Windows 必须显式清理 PID 对应的整棵进程树，不能只确认根进程退出');
    assert.match(spawnedKillers[0].executable, /taskkill(?:\.exe)?$/i);
    assert.deepEqual(spawnedKillers[0].args, ['/PID', String(child.pid), '/T', '/F']);
    assert.equal(spawnedKillers[0].options.windowsHide, true);
    assert.equal(spawnedKillers[0].options.stdio, 'ignore');
  } finally {
    await manager.stop();
    cleanupDir(dir);
  }
});

test('fallback 占用 Profile 时抑制重复启动，并仅通过释放回调安全接管', async () => {
  const dir = tempRuntimeDir('web-access-fallback-takeover-');
  const manager = new PlatformWebAccessManager({
    enabled: true,
    mode: 'web_access_primary',
    platformOrder: ['douyin'],
    platformProfiles: { douyin: dir },
    fallbackRetryCooldownMs: 60_000,
    profileReleaseTimeoutMs: 500
  });
  manager.stateFor('douyin');
  let launchCalls = 0;
  manager.launchBrowser = async () => { launchCalls += 1; };
  const startError = new Error('fallback required');
  startError.code = 'BROWSER_PROCESS_EXITED_EARLY';
  startError.detail = { platformCode: 'douyin' };
  assert.equal(manager.shouldUseLegacyFallback(startError), true);
  await assert.rejects(
    manager.acquirePlatformContext({ platformCode: 'douyin' }),
    error => error.code === 'WEB_ACCESS_RETRY_SUPPRESSED_WHILE_FALLBACK_ACTIVE'
  );
  assert.equal(launchCalls, 0);
  manager.stateFor('douyin').retryNotBefore = Date.now() - 1;
  await assert.rejects(
    manager.acquirePlatformContext({ platformCode: 'douyin' }),
    error => error.code === 'WEB_ACCESS_RETRY_SUPPRESSED_WHILE_FALLBACK_ACTIVE'
  );
  assert.equal(launchCalls, 0);
  await assert.rejects(
    manager.prepareForWebAccessTakeover({ platformCode: 'douyin' }),
    error => error.code === 'WEB_ACCESS_FALLBACK_RELEASE_REQUIRED'
  );

  const lockPath = path.join(dir, 'SingletonLock');
  fs.writeFileSync(lockPath, 'fallback owns profile', 'utf8');
  let releaseCalls = 0;
  try {
    const takeover = await manager.prepareForWebAccessTakeover({
      platformCode: 'douyin',
      releaseFallback: async () => {
        releaseCalls += 1;
        fs.rmSync(lockPath, { force: true });
      }
    });
    assert.equal(releaseCalls, 1);
    assert.equal(takeover.readyForTakeover, true);
    assert.equal(manager.stateFor('douyin').fallbackActive, false);
    assert.equal(manager.stateFor('douyin').retryNotBefore, 0);
  } finally {
    cleanupDir(dir);
  }
});

test('发布和回复正式业务统一经过 BusinessBrowserRouter 并回报实际 Web Access Provider', async () => {
  const executed = [];
  const adapter = {
    platformCode: 'douyin',
    browserExecution: null,
    async execute(job) {
      executed.push(job.job_type);
      this.browserExecution = {
        providerRequested: 'web_access_cdp',
        providerUsed: 'web_access_cdp',
        fallbackUsed: false,
        compatibilityLayer: 'playwright_connect_over_cdp',
        proxyPort: 3457,
        browserDebugPort: 9311
      };
      return { status: 'SUCCESS', result: { businessAction: job.job_type } };
    }
  };
  const router = new BusinessBrowserRouter({
    adapters: new Map([['douyin', adapter]]),
    webAccessManager: {
      executionInfo: platformCode => ({ platformCode, mode: 'WEB_ACCESS_PRIMARY', primaryProvider: 'web_access_cdp', fallbackProvider: 'playwright', actual: 'web_access_cdp', runtime: { proxyPort: 3457, browserDebugPort: 9311 } })
    }
  });
  for (const jobType of ['PUBLISH', 'REPLY']) {
    const output = await router.execute({ job_type: jobType, payload: { platformCode: 'douyin' } });
    assert.equal(output.status, 'SUCCESS');
    assert.equal(output.result.browserControl.mode, 'WEB_ACCESS_PRIMARY');
    assert.equal(output.result.browserControl.providerUsed, 'web_access_cdp');
    assert.equal(output.result.browserControl.compatibilityLayer, 'playwright_connect_over_cdp');
    assert.equal(output.result.browserControl.fallbackUsed, false);
  }
  assert.deepEqual(executed, ['PUBLISH', 'REPLY']);
});


test('后台获取平台页面默认不抢前台，只有明确请求时才前置', async () => {
  const dir = tempRuntimeDir('browser-focus-');
  try {
    let bringToFrontCalls = 0;
    const page = {
      isClosed: () => false,
      url: () => 'https://creator.douyin.com/creator-micro/content/manage',
      bringToFront: async () => { bringToFrontCalls += 1; }
    };
    const context = {
      pages: () => [page],
      newPage: async () => page
    };
    const adapter = new AssistedPlatformRpaAdapter({
      platformCode: 'douyin',
      logsDir: path.join(dir, 'logs'),
      profileDir: path.join(dir, 'profile'),
      executablePath: 'unused',
      loginTimeoutMs: 1000,
      sendTimeoutMs: 1000
    });
    adapter.ensureContext = async () => context;

    assert.equal(await adapter.getPage(), page);
    assert.equal(bringToFrontCalls, 0);

    assert.equal(await adapter.getPage({ bringToFront: true }), page);
    assert.equal(bringToFrontCalls, 1);
  } finally {
    cleanupDir(dir);
  }
});

test('用户明确打开登录页时仍会请求把平台浏览器显示到前台', async () => {
  const dir = tempRuntimeDir('browser-login-focus-');
  try {
    let requestedOptions = null;
    let navigatedTo = null;
    const page = {
      goto: async url => { navigatedTo = url; },
      waitForTimeout: async () => {}
    };
    const adapter = new AssistedPlatformRpaAdapter({
      platformCode: 'wechat_channels',
      logsDir: path.join(dir, 'logs'),
      profileDir: path.join(dir, 'profile'),
      executablePath: 'unused',
      loginTimeoutMs: 1000,
      sendTimeoutMs: 1000
    });
    adapter.getPage = async options => {
      requestedOptions = options;
      return page;
    };
    adapter.status = async () => ({ loginStatus: 'UNKNOWN' });

    await adapter.openLogin();

    assert.deepEqual(requestedOptions, { bringToFront: true });
    assert.equal(navigatedTo, adapter.spec.publishUrl);
  } finally {
    cleanupDir(dir);
  }
});

