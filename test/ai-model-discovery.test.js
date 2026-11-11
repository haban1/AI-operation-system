import test from 'node:test';
import assert from 'node:assert/strict';
import { discoverAiModels, resolveDiscoverySettings, validateAiBaseUrl } from '../src/services/ai-model-discovery.js';
import { beginAiConnectionTest, finishAiConnectionTest, clearAiConnectionStatus, getAiConnectionStatus } from '../src/services/ai-connection-status.js';
import { aiConnectionPresentation } from '../public/ai-model-settings.js';
const current = { baseUrl: 'https://provider.example/v1', apiKey: 'sk-test-secret-12345', mode: 'online', model: 'chat-test', visionModel: 'vision-test' };
const json = data => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });

test('model discovery only uses the selected URL and bearer key, deduplicates and never exposes key', async () => {
  const calls = [];
  const result = await discoverAiModels({}, current, { fetchImpl: async (url, options) => {
    calls.push({ url, options });
    return json({ data: [{ id: 'z-model' }, { id: 'chat/model' }, { id: 'z-model' }, { id: '<script>' }, { id: current.apiKey }, { id: 1 }, null] });
  } });
  assert.deepEqual(result.models, ['chat/model', 'z-model']);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, current.baseUrl + '/models');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer ' + current.apiKey);
  assert.equal(calls[0].options.redirect, 'manual');
  assert.equal(JSON.stringify(result).includes(current.apiKey), false);
});
test('draft settings work without saving; blank key reuses only the same origin', () => {
  assert.deepEqual(resolveDiscoverySettings({ baseUrl: current.baseUrl + '/' }, current), { apiKey: current.apiKey, baseUrl: current.baseUrl });
  assert.throws(() => resolveDiscoverySettings({ baseUrl: 'https://different.example/v1' }, current), /重新输入/);
  assert.deepEqual(resolveDiscoverySettings({ baseUrl: 'https://different.example/v1', apiKey: 'new-test-key' }, current), { baseUrl: 'https://different.example/v1', apiKey: 'new-test-key' });
  assert.throws(() => resolveDiscoverySettings({ baseUrl: current.baseUrl }, {}), /填写 AI Key/);
  assert.throws(() => resolveDiscoverySettings({ apiKey: 'bad key here' }, current), /格式无效/);
});
test('invalid or unsafe URL syntax is rejected before fetching', async () => {
  for (const url of ['http://provider.example/v1', 'https://user:pass@provider.example/v1', 'https://provider.example:8443/v1', 'https://provider.example/v1?key=secret', 'https://provider.example/v1#hash', 'not-a-url']) {
    assert.throws(() => validateAiBaseUrl(url));
    await assert.rejects(discoverAiModels({ baseUrl: url }, current, { fetchImpl: () => assert.fail('must not fetch') }));
  }
});
for (const [status, text] of [[401, '访问被拒绝'], [403, '访问被拒绝'], [404, '不支持'], [405, '不支持'], [501, '不支持'], [429, '过于频繁'], [500, 'HTTP 500'], [302, '跳转']]) {
  test('HTTP ' + status + ' is actionable and never returns upstream secrets', async () => {
    await assert.rejects(discoverAiModels({}, current, { fetchImpl: async () => new Response(current.apiKey, { status }) }), error => error.message.includes(text) && !error.message.includes(current.apiKey));
  });
}
test('empty, malformed and incompatible lists permit manual fallback', async () => {
  const empty = await discoverAiModels({}, current, { fetchImpl: async () => json({ data: [] }) });
  assert.deepEqual(empty.models, []);
  assert.match(empty.message, /手动/);
  for (const response of [json({ models: ['wrong-shape'] }), new Response('<html>error</html>')]) {
    await assert.rejects(discoverAiModels({}, current, { fetchImpl: async () => response }), /手动/);
  }
});
test('upstream response bytes and model count are bounded', async () => {
  await assert.rejects(discoverAiModels({}, current, { fetchImpl: async () => new Response('x'.repeat(2 * 1024 * 1024 + 1)) }), /过大/);
  const result = await discoverAiModels({}, current, { fetchImpl: async () => json({ data: Array.from({ length: 2001 }, (_, i) => ({ id: 'model-' + i })) }) });
  assert.equal(result.models.length, 2000);
  assert.equal(result.truncated, true);
});
test('timeouts and transport errors are safe', async () => {
  await assert.rejects(discoverAiModels({}, current, { timeoutMs: 5, fetchImpl: (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error(current.apiKey)))) }), /超时/);
  await assert.rejects(discoverAiModels({}, current, { fetchImpl: () => { throw new Error(current.apiKey); } }), error => !error.message.includes(current.apiKey) && /无法连接/.test(error.message));
});
test('status is based on an actual test of this exact configuration, never key presence', () => {
  clearAiConnectionStatus();
  assert.equal(getAiConnectionStatus(current).status, 'UNTESTED');
  assert.equal(aiConnectionPresentation({ mode: 'online', configured: true }).passed, false);
  const token = beginAiConnectionTest(current);
  finishAiConnectionTest(token, 'PASSED');
  assert.equal(getAiConnectionStatus(current).status, 'PASSED');
  for (const field of ['apiKey', 'baseUrl', 'model', 'visionModel']) assert.equal(getAiConnectionStatus({ ...current, [field]: 'changed' }).status, 'UNTESTED');
  assert.equal(getAiConnectionStatus({ ...current, mode: 'mock' }).status, 'SIMULATED');
  assert.equal(getAiConnectionStatus({ ...current, apiKey: '' }).status, 'UNCONFIGURED');
  clearAiConnectionStatus();
  finishAiConnectionTest(token, 'PASSED');
  assert.equal(getAiConnectionStatus(current).status, 'UNTESTED', 'late test cannot restore status after a save');
  const old = beginAiConnectionTest(current), latest = beginAiConnectionTest(current);
  finishAiConnectionTest(latest, 'FAILED');
  finishAiConnectionTest(old, 'PASSED');
  assert.equal(getAiConnectionStatus(current).status, 'FAILED');
});
