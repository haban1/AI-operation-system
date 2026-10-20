import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { LoginPollingGate } from '../agent/login-polling-gate.js';
import { collectProcessTreeIds, profileProcessTreeIds } from '../agent/platform-process-cleanup.js';

test('登录轮询初始关闭，打开哪个平台只监控哪个平台', () => {
  let now = 1_000;
  const gate = new LoginPollingGate({ intervalMs: 60_000, initialDelayMs: 15_000, now: () => now });
  assert.equal(gate.isDue(), false);
  assert.deepEqual(gate.snapshot(), { platformCodes: [], nextPollAt: null });

  gate.activate('douyin');
  assert.deepEqual(gate.eligible(['douyin', 'wechat_channels', 'bilibili', 'weibo', 'xiaohongshu']), ['douyin']);
  assert.equal(gate.isDue(), false);
  now = 16_000;
  assert.equal(gate.isDue(), true);
  gate.markPolled();
  assert.equal(gate.isDue(), false);
});

test('关闭单个平台仅移除该平台，全部关闭后停止轮询', () => {
  const gate = new LoginPollingGate({ intervalMs: 60_000, initialDelayMs: 0, now: () => 1_000 });
  gate.activate('douyin');
  gate.activate('weibo');
  gate.deactivate(['douyin']);
  assert.deepEqual(gate.snapshot().platformCodes, ['weibo']);
  assert.deepEqual(gate.eligible(['douyin', 'weibo']), ['weibo']);
  gate.deactivate(['weibo']);
  assert.deepEqual(gate.snapshot(), { platformCodes: [], nextPollAt: null });
  gate.activate('bilibili');
  gate.clear();
  assert.deepEqual(gate.snapshot(), { platformCodes: [], nextPollAt: null });
});


test('登录轮询 Gate 自动同步 RUNNING 平台，重复同步不会把下一次检查提前', () => {
  let now = 1_000;
  const gate = new LoginPollingGate({ intervalMs: 60_000, initialDelayMs: 15_000, now: () => now });
  gate.sync(['douyin', 'wechat_channels']);
  const firstSchedule = gate.snapshot().nextPollAt;
  assert.deepEqual(gate.snapshot().platformCodes, ['douyin', 'wechat_channels']);

  now = 5_000;
  gate.sync(['douyin', 'wechat_channels']);
  assert.equal(gate.snapshot().nextPollAt, firstSchedule);

  gate.sync(['wechat_channels', 'bilibili']);
  assert.deepEqual(gate.snapshot().platformCodes, ['wechat_channels', 'bilibili']);
  assert.deepEqual(gate.eligible(['douyin', 'wechat_channels', 'bilibili']), ['wechat_channels', 'bilibili']);
});

test('Web 定时刷新会局部更新首页和平台页登录状态，不需要点击人工检查', () => {
  const appSource = fs.readFileSync(path.resolve(import.meta.dirname, '../public/app.js'), 'utf8');
  assert.match(appSource, /id="dashboardPlatformDetail-\$\{p\.code\}"/);
  assert.match(appSource, /function refreshDashboardLoginStatus\(\)/);
  assert.match(appSource, /function refreshPlatformLoginStatus\(\)/);
  assert.match(appSource, /state\.page==='dashboard'\)refreshDashboardLoginStatus\(\)/);
  assert.match(appSource, /state\.page==='platforms'\)refreshPlatformLoginStatus\(\)/);
});

test('按独立 Profile 选择浏览器进程树，不误杀其他平台', () => {
  const processes = [
    { processId: 100, parentProcessId: 1, commandLine: 'chrome --user-data-dir=D:\\profiles\\douyin' },
    { processId: 101, parentProcessId: 100, commandLine: 'chrome --type=renderer' },
    { processId: 102, parentProcessId: 101, commandLine: 'chrome --type=utility' },
    { processId: 200, parentProcessId: 1, commandLine: 'chrome --user-data-dir=D:\\profiles\\weibo' },
    { processId: 201, parentProcessId: 200, commandLine: 'chrome --type=renderer' }
  ];
  assert.deepEqual(collectProcessTreeIds(processes, [100]).sort((a, b) => a - b), [100, 101, 102]);
  assert.deepEqual(profileProcessTreeIds(processes, 'D:\\profiles\\douyin').sort((a, b) => a - b), [100, 101, 102]);
});


test('问题汇总页面不再提供 AI 自检入口，仅保留人工处理和误判', () => {
  const appSource = fs.readFileSync(path.resolve(import.meta.dirname, '../public/app.js'), 'utf8');
  const indexSource = fs.readFileSync(path.resolve(import.meta.dirname, '../public/index.html'), 'utf8');
  assert.doesNotMatch(appSource, /AI 自检|diagnose-issue|retry-issue/);
  assert.doesNotMatch(indexSource, /AI 自检/);
  assert.match(appSource, /manual-resolve-issue/);
  assert.match(appSource, /false-positive-issue/);
});

test('installer defaults keep issue diagnosis disabled and contain no Smoke scheduler flags', () => {
  const root = path.resolve(import.meta.dirname, '..');
  const envExample = fs.readFileSync(path.join(root, '.env.example'), 'utf8');
  const initializer = fs.readFileSync(path.join(root, 'initialize-mvp.ps1'), 'utf8');
  assert.match(envExample, /^ISSUE_DIAGNOSIS_ENABLED=false$/m);
  assert.match(envExample, /^ISSUE_DIAGNOSIS_BROWSER_READONLY=true$/m);
  assert.match(initializer, /^ISSUE_DIAGNOSIS_ENABLED=false$/m);
  assert.match(initializer, /^ISSUE_DIAGNOSIS_BROWSER_READONLY=true$/m);
  assert.doesNotMatch(envExample, /^SMOKE_TEST_(?:ENABLED|SCHEDULED_ENABLED)=/m);
  assert.doesNotMatch(initializer, /^SMOKE_TEST_(?:ENABLED|SCHEDULED_ENABLED)=/m);
});

test('stop script gracefully shuts down Agent before stopping Web', () => {
  const root = path.resolve(import.meta.dirname, '..');
  const script = fs.readFileSync(path.join(root, 'stop-mvp.ps1'), 'utf8');
  const graceful = script.indexOf('/control/shutdown');
  const serverStop = script.indexOf('$ServerPidFile=');
  assert.ok(graceful >= 0, 'stop-mvp.ps1 must request Local Agent graceful shutdown');
  assert.ok(serverStop > graceful, 'Local Agent graceful shutdown must happen before stopping Web');
});


test('bulk enable and bulk browser-open controls are separate and preserve their respective boundaries', () => {
  const appSource = fs.readFileSync(path.resolve(import.meta.dirname, '../public/app.js'), 'utf8');
  const agentSource = fs.readFileSync(path.resolve(import.meta.dirname, '../agent/local-agent.js'), 'utf8');
  assert.match(appSource, /id=\"enableAllPlatforms\"/);
  assert.match(appSource, /async function startAllPlatforms/);
  assert.match(appSource, /\/api\/platforms\/runtime\/start-all/);
  assert.match(appSource, /startAllPlatforms\(enableAll\)/);
  assert.match(appSource, /\\u4e00\\u952e\\u5f00\\u542f\\u5168\\u90e8\\u5e73\\u53f0/);
  assert.match(appSource, /id=\"openSelectedPlatforms\"/);
  assert.match(appSource, /batchPlatformAction\('open',openSelected\)/);
  assert.match(appSource, /\\u4e00\\u952e\\u6253\\u5f00\\u6240\\u9009\\u5e73\\u53f0/);
  assert.match(agentSource, /runPlatformBatch\('open'\)/);
  assert.match(agentSource, /platformCoordinator\.runnablePlatformCodes\(\)/);
  assert.match(agentSource, /open-manual-action/);
  assert.match(agentSource, /withGuardedPlatformOperation\(platformCode, openManualAction\)/);
});

test('test runner ignores project .env values and preserves child exit status', () => {
  const root = path.resolve(import.meta.dirname, '..');
  const runnerPath = path.join(root, 'scripts', 'run-tests.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-env-isolation-'));
  try {
    const sourceDir = path.join(dir, 'src');
    fs.mkdirSync(sourceDir);
    fs.copyFileSync(path.join(root, 'src', 'config.js'), path.join(sourceDir, 'config.js'));
    fs.mkdirSync(path.join(sourceDir, 'services'));
    fs.copyFileSync(path.join(root, 'src', 'services', 'conversation-policy.js'), path.join(sourceDir, 'services', 'conversation-policy.js'));
    fs.writeFileSync(path.join(dir, '.env'), [
      'RAG_FORMAL_ROUTING_ENABLED=true',
      'RAG_ADMIN_ENABLED=true',
      'CHANNEL_SPLIT_ENABLED=true',
      'PLATFORM_CHANNEL_SPLIT_DOUYIN=true'
    ].join('\n'));

    const configUrl = pathToFileURL(path.join(sourceDir, 'config.js')).href;
    const probe = spawnSync(process.execPath, [runnerPath, '--input-type=module', '--eval', `
      const { config } = await import(${JSON.stringify(configUrl)});
      console.log(JSON.stringify({
        nodeEnv: process.env.NODE_ENV,
        businessGuidanceMaxAttempts: config.businessGuidanceMaxAttempts,
        ragFormalRoutingEnabled: config.ragFormalRoutingEnabled,
        ragAdminEnabled: config.ragAdminEnabled,
        channelSplitEnabled: config.channelSplitEnabled,
        platformChannelSplitDouyin: config.platformChannelSplitDouyin
      }));
    `], {
      cwd: root,
      env: { NODE_ENV: 'production' },
      encoding: 'utf8'
    });
    assert.equal(probe.status, 0, probe.stderr);
    assert.deepEqual(JSON.parse(probe.stdout), {
      nodeEnv: 'test',
      businessGuidanceMaxAttempts: 3,
      ragFormalRoutingEnabled: false,
      ragAdminEnabled: false,
      channelSplitEnabled: false,
      platformChannelSplitDouyin: false
    });

    const failure = spawnSync(process.execPath, [runnerPath, '--eval', 'process.exit(7)'], {
      cwd: root,
      env: { NODE_ENV: 'production' },
      encoding: 'utf8'
    });
    assert.equal(failure.status, 7);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('direct node test runs ignore project .env values', () => {
  const root = path.resolve(import.meta.dirname, '..');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'direct-test-env-isolation-'));
  try {
    const sourceDir = path.join(dir, 'src');
    fs.mkdirSync(sourceDir);
    fs.copyFileSync(path.join(root, 'src', 'config.js'), path.join(sourceDir, 'config.js'));
    fs.mkdirSync(path.join(sourceDir, 'services'));
    fs.copyFileSync(path.join(root, 'src', 'services', 'conversation-policy.js'), path.join(sourceDir, 'services', 'conversation-policy.js'));
    fs.writeFileSync(path.join(dir, '.env'), [
      'RAG_FORMAL_ROUTING_ENABLED=true',
      'RAG_ADMIN_ENABLED=true',
      'CHANNEL_SPLIT_ENABLED=true',
      'PLATFORM_CHANNEL_SPLIT_DOUYIN=true'
    ].join('\n'));
    const probePath = path.join(dir, 'config-isolation.test.mjs');
    fs.writeFileSync(probePath, `
      import test from 'node:test';
      import assert from 'node:assert/strict';
      import { config } from './src/config.js';
      test('config remains isolated', () => {
        assert.equal(config.businessGuidanceMaxAttempts, 3);
        assert.equal(config.ragFormalRoutingEnabled, false);
        assert.equal(config.ragAdminEnabled, false);
        assert.equal(config.channelSplitEnabled, false);
        assert.equal(config.platformChannelSplitDouyin, false);
      });
    `);

    const direct = spawnSync(process.execPath, ['--test', probePath], {
      cwd: dir,
      env: { NODE_ENV: 'production' },
      encoding: 'utf8'
    });
    assert.equal(direct.status, 0, `${direct.stdout}\n${direct.stderr}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
