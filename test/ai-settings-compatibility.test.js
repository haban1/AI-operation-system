import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'tianhe-ai-settings-compat-'));
Object.assign(process.env, {
  NODE_ENV: 'test', DATABASE_PATH: path.join(temp, 'settings.db'),
  SETTINGS_ENCRYPTION_KEY: 'settings-compatibility-fixture-only',
  SETTINGS_KEY_PATH: path.join(temp, '.settings-key'),
  QWEN_API_KEY: 'fixture-unified-key', DASHSCOPE_API_KEY: '', QWEN_MODE: 'online',
  QWEN_BASE_URL: 'http://127.0.0.1:11434/v1', QWEN_MODEL: 'chat-test', QWEN_VISION_MODEL: 'vision-test'
});
const { db } = await import('../src/db.js');
const { saveAiSettings, getAiSettings, getAiSettingsSummary, clearAiApiKey } = await import('../src/services/settings.js');
const { beginAiConnectionTest, finishAiConnectionTest } = await import('../src/services/ai-connection-status.js');
after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

test('saving unified model roles preserves local and LAN provider compatibility', () => {
  for (const baseUrl of [
    'http://127.0.0.1:11434/v1', 'http://localhost:8080/v1', 'http://10.70.72.78:3100/api/model/v1',
    'http://172.29.96.1:8000/v1', 'http://192.168.8.2:1234/v1', 'http://host.docker.internal:11434/v1',
    'http://ollama:11434/v1', 'http://[::1]:11434/v1', 'https://provider.example:8443/v1'
  ]) {
    const summary = saveAiSettings({ baseUrl, apiKey: 'fixture-unified-key', model: 'chat-test', visionModel: 'vision-test',
      asrModel: 'local:whisper-small', contentModel: 'content-test', imageContentModel: 'image-test',
      trafficPredictionModel: 'traffic-test', embeddingModel: 'local:BAAI/bge-small-zh-v1.5' });
    assert.equal(summary.baseUrl, baseUrl);
    assert.equal(summary.asrModel, 'local:whisper-small');
    assert.equal(summary.visionModel, 'vision-test');
    assert.equal(summary.contentModel, 'content-test');
    assert.equal(summary.imageContentModel, 'image-test');
    assert.equal(summary.trafficPredictionModel, 'traffic-test');
    assert.equal(summary.embeddingModel, 'local:BAAI/bge-small-zh-v1.5');
    assert.equal(Object.hasOwn(summary, 'apiKey'), false);
    const updated = saveAiSettings({ contentModel: '', model: 'chat-next' });
    assert.equal(updated.contentModel, 'chat-next');
    assert.equal(updated.modelOverrides.contentModel, '');
    assert.equal(updated.embeddingModel, summary.embeddingModel);
    assert.equal(getAiSettings().apiKey, 'fixture-unified-key');
  }
});

test('saving an endpoint never reuses the unified key across origins', () => {
  saveAiSettings({ baseUrl: 'http://127.0.0.1:11434/v1', apiKey: 'fixture-unified-key' });
  assert.throws(() => saveAiSettings({ baseUrl: 'http://127.0.0.1:11435/v1' }), /重新输入/);
  assert.throws(() => saveAiSettings({ baseUrl: 'https://other.example/v1' }), /重新输入/);
  for (const baseUrl of ['http://provider.example/v1', 'https://user:pass@provider.example/v1',
    'https://provider.example/v1?key=secret', 'https://provider.example/v1#fragment', 'file:///tmp/model']) {
    assert.throws(() => saveAiSettings({ baseUrl, apiKey: 'fixture-unified-key' }), { code: 'INVALID_AI_SETTINGS' });
  }
  assert.equal(getAiSettings().baseUrl, 'http://127.0.0.1:11434/v1');
});

test('saving model roles and clearing a key invalidate an earlier connection test', () => {
  saveAiSettings({ baseUrl: 'http://127.0.0.1:11434/v1', apiKey: 'fixture-unified-key' });
  finishAiConnectionTest(beginAiConnectionTest(getAiSettings()), 'PASSED');
  assert.equal(getAiSettingsSummary().connectionTest.status, 'PASSED');
  saveAiSettings({ embeddingModel: 'embedding-next' });
  assert.equal(getAiSettingsSummary().connectionTest.status, 'UNTESTED');
  finishAiConnectionTest(beginAiConnectionTest(getAiSettings()), 'PASSED');
  clearAiApiKey();
  assert.equal(getAiSettingsSummary().connectionTest.status, 'UNTESTED', 'the environment fallback still requires a fresh test');
});
