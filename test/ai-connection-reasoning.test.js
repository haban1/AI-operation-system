import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

test('connection probe supports reasoning models and still rejects empty or unauthorized responses', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tianhe-connection-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const script = `
    import assert from 'node:assert/strict';
    const { testAiConnection } = await import('./src/services/qwen.js');
    const { getAiSettingsSummary } = await import('./src/services/settings.js');
    globalThis.fetch = async (url, request) => {
      const payload = JSON.parse(request.body);
      return Response.json({ choices: [{ finish_reason: payload.max_tokens < 64 ? 'length' : 'stop',
        message: { reasoning_content: 'reasoning uses tokens before the answer', content: payload.max_tokens < 64 ? '' : 'OK' } }] });
    };
    assert.match((await testAiConnection()).message, /连接测试成功/);
    assert.equal(getAiSettingsSummary().connectionTest.status, 'PASSED');
    globalThis.fetch = async () => Response.json({ choices: [{ message: { content: '', reasoning_content: 'unfinished' } }] });
    await assert.rejects(testAiConnection(), /未返回有效的对话内容/);
    assert.equal(getAiSettingsSummary().connectionTest.status, 'FAILED');
    globalThis.fetch = async () => Response.json({ error: 'not authorized' }, { status: 401 });
    await assert.rejects(testAiConnection(), /HTTP 401/);
    assert.equal(getAiSettingsSummary().connectionTest.status, 'FAILED');
  `;
  execFileSync(process.execPath, ['--input-type=module', '--eval', script], {
    cwd: path.resolve(import.meta.dirname, '..'),
    env: { ...process.env, NODE_ENV: 'test', TIANHE_SKIP_DOTENV: 'true',
      DATABASE_PATH: path.join(dir, 'test.db'), SETTINGS_KEY_PATH: path.join(dir, 'settings-key'),
      QWEN_MODE: 'online', QWEN_API_KEY: 'test-key', DASHSCOPE_API_KEY: '',
      QWEN_BASE_URL: 'https://provider.test/v1', QWEN_MODEL: 'reasoning-model' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
});
