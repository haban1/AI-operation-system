import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { randomIntervalMs } from '../src/services/polling.js';

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

async function waitFor(base, child, stderr) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`server startup timeout: ${stderr()}`);
    try {
      const response = await fetch(base + '/api/health');
      if (response.ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`server startup timeout: ${stderr()}`);
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise(resolve => child.once('exit', resolve)),
    new Promise(resolve => setTimeout(resolve, 3000))
  ]);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
}

test('AI settings, usage logs, and randomized polling integration', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mvp-ai-settings-'));
  const dbPath = path.join(dir, 'test.db');
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  let stderr = '';
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      DATABASE_PATH: dbPath,
      AUTH_ENABLED: 'false',
      AGENT_SHARED_TOKEN: '',
      TIANHE_MODEL_TOKEN: 'test-internal-model-token',
      QWEN_MODE: 'mock',
      QWEN_API_KEY: '',
      DASHSCOPE_API_KEY: '',
      AUTO_COLLECT_ENABLED: 'true',
      LOCAL_AGENT_AUTO_START: 'false',
      SMOKE_TEST_ENABLED: 'false'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stderr.on('data', chunk => { stderr += chunk; });
  t.after(async () => {
    await stopChild(child);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try { fs.rmSync(dir, { recursive: true, force: true }); break; }
      catch (error) {
        if (attempt === 4) throw error;
        await new Promise(resolve => setTimeout(resolve, 100 * (attempt + 1)));
      }
    }
  });

  await waitFor(base, child, () => stderr);

  const initial = await request(base, '/api/settings/ai');
  assert.equal(initial.response.status, 200);
  assert.equal(initial.data.settings.mode, 'mock');
  assert.equal(Object.hasOwn(initial.data.settings, 'apiKey'), false, 'admin API must not expose the plaintext AI key');
  assert.equal((await request(base, '/api/model/v1/status')).response.status, 401);
  const modelStatus = await request(base, '/api/model/v1/status', { headers: { Authorization: 'Bearer test-internal-model-token' } });
  assert.equal(modelStatus.response.status, 200);
  assert.equal(modelStatus.data.source, 'tianhe');
  assert.equal(Object.hasOwn(modelStatus.data, 'apiKey'), false);

  const invalidUrl = await request(base, '/api/settings/ai', {
    method: 'POST',
    body: JSON.stringify({ mode: 'mock', baseUrl: 'http://example.com/v1', model: 'qwen-test', visionModel: 'qwen-vl-test' })
  });
  assert.equal(invalidUrl.response.status, 400);
  assert.equal(invalidUrl.data.code, 'REQUEST_FAILED');

  const onlineWithoutKey = await request(base, '/api/settings/ai', {
    method: 'POST',
    body: JSON.stringify({ mode: 'online', baseUrl: 'https://example.com/v1', model: 'qwen-test', visionModel: 'qwen-vl-test' })
  });
  assert.equal(onlineWithoutKey.response.status, 400);
  assert.match(onlineWithoutKey.data.message, /AI Key/);

  const secretKey = 'sk-test-sensitive-1234567890';
  const saved = await request(base, '/api/settings/ai', {
    method: 'POST',
    body: JSON.stringify({ mode: 'mock', apiKey: secretKey, baseUrl: 'https://example.com/v1', model: 'qwen-test', visionModel: 'qwen-vl-test', updatedBy: 'automation-test' })
  });
  assert.equal(saved.response.status, 200);
  assert.equal(saved.data.settings.configured, true);
  assert.equal(saved.data.settings.maskedApiKey, '******567890');
  assert.equal(Object.hasOwn(saved.data.settings, 'apiKey'), false);
  assert.equal(JSON.stringify(saved.data).includes(secretKey), false);
  const extended = await request(base, '/api/settings/ai', {
    method: 'POST', body: JSON.stringify({ asrModel: 'asr-test', contentModel: 'content-test', embeddingModel: 'embed-test' })
  });
  assert.equal(extended.response.status, 200);
  const agentSettings = await request(base, '/api/agent/settings/ai');
  assert.equal(agentSettings.data.settings.asrModel, 'asr-test');
  assert.equal(agentSettings.data.settings.contentModel, 'content-test');
  assert.equal(extended.data.settings.embeddingModel, 'embed-test');
  const inherited = await request(base, '/api/settings/ai', {
    method: 'POST', body: JSON.stringify({ contentModel: '', model: 'chat-next' })
  });
  assert.equal(inherited.data.settings.contentModel, 'chat-next');
  assert.equal(inherited.data.settings.modelOverrides.contentModel, '');

  const readDb = sql => { const database = new DatabaseSync(dbPath, { readOnly: true }); try { return database.prepare(sql).get(); } finally { database.close(); } };
  const storedKey = readDb("SELECT encrypted_value FROM system_settings WHERE setting_key='ai.api_key'");
  assert.ok(storedKey?.encrypted_value?.startsWith('v1:'));
  assert.equal(storedKey.encrypted_value.includes(secretKey), false, 'database must not store the plaintext AI key');

  const connection = await request(base, '/api/settings/ai/test', { method: 'POST', body: '{}' });
  assert.equal(connection.response.status, 200);
  assert.equal(connection.data.result.mode, 'mock');

  const logged = await request(base, '/api/agent/ai-usage', {
    method: 'POST',
    body: JSON.stringify({
      taskType: 'CONTENT_REVIEW', taskId: 'test-1', sourceModule: 'test-suite', mode: 'online', model: 'qwen3.7-plus',
      status: 'FAILED', usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 }, durationMs: 123,
      errorCode: 'TEST_ERROR', errorMessage: `Bearer ${secretKey}; api_key=${secretKey}`
    })
  });
  assert.equal(logged.response.status, 200);
  assert.equal(JSON.stringify(logged.data).includes(secretKey), false);
  assert.equal(logged.data.log.input_tokens, 11);
  assert.equal(logged.data.log.output_tokens, 7);
  assert.equal(logged.data.log.total_tokens, 18);
  assert.equal(logged.data.log.duration_ms, 123);

  const usage = await request(base, '/api/settings/ai?limit=20');
  assert.equal(usage.response.status, 200);
  assert.ok(Number(usage.data.summary.calls) >= 2);
  assert.ok(usage.data.logs.some(item => item.task_type === 'CONNECTION_TEST' && item.mode === 'mock' && item.status === 'SUCCESS'));
  const contentLog = usage.data.logs.find(item => item.task_type === 'CONTENT_REVIEW' && item.task_id === 'test-1');
  assert.ok(contentLog);
  assert.equal(contentLog.model, 'qwen3.7-plus');
  assert.equal(contentLog.total_tokens, 18);
  assert.equal(usage.data.daily.length, 7);
  assert.equal(usage.data.daily.at(-1).calls, Number(usage.data.summary.calls));
  assert.equal(usage.data.summary.estimated_cost_cny, 0.0000624);
  assert.equal(usage.data.model_costs.find(item => item.model === 'qwen3.7-plus').estimated_cost_cny, 0.0000624);
  assert.match(usage.data.pricing.source_url, /help\.aliyun\.com/);
  assert.equal(JSON.stringify(usage.data).includes(secretKey), false, 'AI log API must not expose the key');

  const bootstrapAfterUsage = await request(base, '/api/bootstrap');
  assert.equal(bootstrapAfterUsage.response.status, 200);
  assert.equal(bootstrapAfterUsage.data.stats.aiUsageToday.calls, usage.data.summary.calls);
  assert.equal(bootstrapAfterUsage.data.stats.aiUsageToday.total_tokens, usage.data.summary.total_tokens);
  assert.equal(bootstrapAfterUsage.data.stats.aiUsageToday.estimated_cost_cny, usage.data.summary.estimated_cost_cny);

  const cleared = await request(base, '/api/settings/ai/clear-key', { method: 'POST', body: '{}' });
  assert.equal(cleared.response.status, 200);
  assert.equal(cleared.data.settings.configured, false);
  assert.equal(cleared.data.settings.maskedApiKey, '');
  assert.equal(readDb("SELECT COUNT(*) AS count FROM system_settings WHERE setting_key='ai.api_key'").count, 0);

  const ranges = [
    ['1-2', 60_000, 120_000],
    ['2-3', 120_000, 180_000],
    ['3-4', 180_000, 240_000],
    ['4-5', 240_000, 300_000]
  ];
  for (const [value, minMs, maxMs] of ranges) {
    const before = Date.now();
    const result = await request(base, '/api/settings/message-collection', {
      method: 'POST', body: JSON.stringify({ interval: value, updatedBy: 'automation-test' })
    });
    assert.equal(result.response.status, 200);
    assert.equal(result.data.settings.value, value);
    assert.equal(result.data.settings.minMs, minMs);
    assert.equal(result.data.settings.maxMs, maxMs);
    assert.equal(result.data.settings.options.length, 4);
    assert.ok(result.data.settings.nextCollectionAt);
    const delay = new Date(result.data.settings.nextCollectionAt).getTime() - before;
    assert.ok(delay >= minMs - 1500, `${value} next polling time must not be later than the upper bound`);
    assert.ok(delay <= maxMs + 1500, `${value} next polling time must not be later than the upper bound`);
  }

  const invalidRange = await request(base, '/api/settings/message-collection', {
    method: 'POST', body: JSON.stringify({ interval: '5-6' })
  });
  assert.equal(invalidRange.response.status, 400);

  const polling = await request(base, '/api/settings/message-collection');
  assert.equal(polling.data.settings.value, '4-5');
  assert.deepEqual(polling.data.settings.options.map(item => item.value), ['1-2', '2-3', '3-4', '4-5']);
  assert.deepEqual(polling.data.settings.options.map(item => item.label), ['1\uff5e2 \u5206\u949f', '2\uff5e3 \u5206\u949f', '3\uff5e4 \u5206\u949f', '4\uff5e5 \u5206\u949f']);

  const bootstrap = await request(base, '/api/bootstrap');
  assert.equal(bootstrap.data.config.messageCollection.value, '4-5');
  assert.equal(bootstrap.data.config.messageCollectMinIntervalMs, 240_000);
  assert.equal(bootstrap.data.config.messageCollectMaxIntervalMs, 300_000);
  assert.ok(bootstrap.data.config.messageCollection.nextCollectionAt);

  for (const [, minMs, maxMs] of ranges) {
    const samples = Array.from({ length: 100 }, () => randomIntervalMs(minMs, maxMs));
    assert.ok(samples.every(value => value >= minMs && value <= maxMs));
    assert.ok(new Set(samples).size > 1, 'polling must be randomized on every cycle');
  }

  const stopped = await request(base, '/api/settings/operations', {
    method: 'POST', body: JSON.stringify({ enabled: false, updatedBy: 'automation-test' })
  });
  assert.equal(stopped.response.status, 200);
  const stoppedPolling = await request(base, '/api/settings/message-collection');
  assert.equal(stoppedPolling.data.settings.nextCollectionAt, null);
});

test('frontend navigation, AI settings, and polling controls remain available', () => {
  const app = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
  assert.ok(app.includes(`'\u4f01\u5fae\u53ca AI'`));
  assert.doesNotMatch(app, /\['accounts'\s*,/);
  assert.doesNotMatch(app, /function\s+renderAccounts\s*\(/);
  assert.match(app, /id="messagePollInterval"/);
  assert.match(app, /\/api\/settings\/message-collection/);
  assert.match(app, /\/api\/settings\/ai/);
  assert.match(app, /id="selectAiOnlineMode"/);
  assert.match(app, /选择 Online 在线模式/);
  assert.match(app, /aiLogRows|ai-call-log|AI \u8c03\u7528\u65e5\u5fd7/);
  assert.doesNotMatch(app, /<span>当前 Key 余额<\/span>/);
  assert.doesNotMatch(app, /<article class="success"><span>成功<\/span>/);
  assert.doesNotMatch(app, /<article class="failure"><span>失败 \/ 跳过<\/span>/);
  assert.match(app, /const dashboardDeviceCards=devices\.length\?devices\.map/);
  assert.match(app, /id="dashboardDeviceSummaryCount"/);
  assert.match(app, /class="dashboard-runtime-layout"/);
  assert.match(app, /执行环境与五平台登录/);
  assert.ok(app.includes('\\u8d26\\u53f7\\u4e0e\\u667a\\u80fd\\u56de\\u590d\\u7ba1\\u7406'));
  assert.ok(!app.includes('\\u8d26\\u53f7\\u4e0e\\u8bbe\\u5907\\u7edf\\u4e00\\u7ba1\\u7406'));
  assert.doesNotMatch(app, /id="togglePlatformOpsDetails"/);
  assert.doesNotMatch(app, /id="platformOpsDetails"/);
  assert.doesNotMatch(app, /五平台人工登录/);
  assert.doesNotMatch(app, /platformOpsExpanded:false/);
  assert.match(app, /xiaohongshu/);
  for (const range of ['1-2', '2-3', '3-4', '4-5']) assert.match(app, new RegExp(`value:'${range}'`));
});

test('composeReply in QWEN_MODE=mock grounds an entity-decoded long answer within 500 characters', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mvp-qwen-mock-compose-'));
  const dbPath = path.join(dir, 'test.db');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const script = String.raw`
    globalThis.fetch = async () => { throw new Error('NETWORK_FORBIDDEN'); };
    const { composeReply } = await import('./src/services/qwen.js');
    const lines = Array.from(
      { length: 80 },
      (_, index) => '\u77e5\u8bc6\u6761\u76ee'
        + String(index + 1).padStart(2, '0')
        + '\uff1a\u529e\u7406\u6d41\u7a0b\u53ea\u5305\u62ec\u6750\u6599\u6838\u9a8c\u3001\u7a97\u53e3\u53d7\u7406\u548c\u7ed3\u679c\u786e\u8ba4\u3002'
    );
    const rawAnswer = lines.join('&#10;');
    const result = await composeReply({
      userMessage: '请说明办理流程',
      knowledge: { question: '办理流程是什么？', answer: rawAnswer },
      taskId: 'mock-long-grounded-reply-test'
    });
    process.stdout.write(JSON.stringify({ rawAnswer, decodedAnswer: lines.join('\n'), result }));
  `;

  let stdout = '';
  let stderr = '';
  const child = spawn(process.execPath, ['--input-type=module', '--eval', script], {
    cwd: root,
    env: {
      ...process.env,
      DATABASE_PATH: dbPath,
      QWEN_MODE: 'mock',
      QWEN_API_KEY: '',
      DASHSCOPE_API_KEY: ''
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const exit = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });

  assert.equal(exit.code, 0, stderr || `composeReply child exited with signal ${exit.signal}`);
  const { rawAnswer, decodedAnswer, result } = JSON.parse(stdout);
  const replyText = String(result.text || '');
  assert.ok(rawAnswer.length > 500);
  assert.ok(replyText.trim().length > 0);
  assert.ok(Array.from(replyText).length <= 500, `reply length was ${Array.from(replyText).length}`);
  assert.notEqual(replyText, rawAnswer);
  assert.doesNotMatch(replyText, /&#10;/i);
  assert.match(replyText, /\n/);
  assert.ok(decodedAnswer.startsWith(replyText), 'mock reply must contain only an exact excerpt from the decoded knowledge answer');
  assert.ok(replyText.split('\n').filter(Boolean).every(line => decodedAnswer.split('\n').includes(line)));
  assert.equal(result.model, 'mock-grounded-composer');
});

