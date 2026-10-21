import test from 'node:test';
import assert from 'node:assert/strict';
import { getAiSignalIntegration } from '../src/services/ai-signal-integration.js';

const browserUrl = 'http://127.0.0.1:4180/';
const service = 'AI Signal Studio';
const healthy = () => Response.json({ ok: true, service });

test('AI Signal Studio 未配置时禁用，健康地址单独配置也不发请求', async () => {
  for (const settings of [{}, { url: '  ' }, { healthUrl: 'http://internal.example/api/health' }]) {
    const result = await getAiSignalIntegration(settings, { fetchImpl: () => assert.fail('disabled integration must not fetch') });
    assert.deepEqual(result, { enabled: false, url: '', online: false, service, message: '热点工作台尚未接入' });
  }
});

test('AI Signal Studio 只读取固定健康地址，并仅返回公开状态字段', async () => {
  let calls = 0;
  const result = await getAiSignalIntegration({ url: browserUrl }, {
    fetchImpl: async (url, options) => {
      calls += 1;
      assert.equal(url, 'http://127.0.0.1:4180/api/health');
      assert.equal(options.method, 'GET');
      assert.equal(options.credentials, 'omit');
      assert.equal(options.redirect, 'error');
      assert.equal(options.cache, 'no-store');
      assert.deepEqual(options.headers, { Accept: 'application/json' });
      assert.ok(options.signal instanceof AbortSignal);
      assert.equal(options.signal.aborted, false);
      assert.equal(options.body, undefined);
      return Response.json({ ok: true, service, token: 'upstream-secret', config: { apiKey: 'private-api-key' } });
    },
  });
  assert.equal(calls, 1);
  assert.deepEqual(result, { enabled: true, url: browserUrl, online: true, service, message: '热点工作台已连接' });
  assert.doesNotMatch(JSON.stringify(result), /upstream-secret|private-api-key|apiKey|token|config/);
});

test('工作台地址和容器内健康地址可独立配置，健康地址不返回浏览器', async () => {
  const healthUrl = 'http://host.docker.internal:4180/api/health';
  const result = await getAiSignalIntegration({ url: browserUrl, healthUrl }, {
    fetchImpl: async target => {
      assert.equal(target, healthUrl);
      return healthy();
    },
  });
  assert.equal(result.online, true);
  assert.equal(result.url, browserUrl);
  assert.doesNotMatch(JSON.stringify(result), /host\.docker\.internal|healthUrl|api\/health/);
});

test('带路径的工作台默认检查同源根健康接口', async () => {
  const result = await getAiSignalIntegration({ url: 'https://studio.example/workbench' }, {
    fetchImpl: async target => {
      assert.equal(target, 'https://studio.example/api/health');
      return healthy();
    },
  });
  assert.equal(result.url, 'https://studio.example/workbench');
  assert.equal(result.online, true);
});

test('HTTP、JSON 或服务身份不符合契约时显示离线', async t => {
  const cases = [
    ['HTTP 错误', () => Response.json({ ok: true, service }, { status: 503 })],
    ['HTTP 重定向', () => Response.json({ ok: true, service }, { status: 302, headers: { Location: 'https://secret.example' } })],
    ['已重定向响应', () => ({ ok: true, redirected: true, json: async () => ({ ok: true, service }) })],
    ['ok 为 false', () => Response.json({ ok: false, service })],
    ['ok 非布尔值', () => Response.json({ ok: 'true', service })],
    ['服务名称不符', () => Response.json({ ok: true, service: 'another service' })],
    ['空对象', () => Response.json({})],
    ['空响应', () => Response.json(null)],
    ['非 JSON', () => new Response('private-upstream-error')],
  ];
  for (const [name, response] of cases) {
    await t.test(name, async () => {
      const result = await getAiSignalIntegration({ url: browserUrl }, { fetchImpl: async () => response() });
      assert.equal(result.enabled, true);
      assert.equal(result.online, false);
      assert.equal(result.url, browserUrl);
      assert.equal(result.message, '热点工作台暂时无法连接，请确认服务已启动');
      assert.doesNotMatch(JSON.stringify(result), /secret\.example|private-upstream-error|another service/);
    });
  }
});

test('离线异常不泄露完整上游 URL、凭据或异常文本', async () => {
  const result = await getAiSignalIntegration({ url: browserUrl, healthUrl: 'http://internal.example/api/health' }, {
    fetchImpl: async () => { throw new Error('failed http://user:password@internal.example/api/health?key=secret-token'); },
  });
  assert.equal(result.enabled, true);
  assert.equal(result.online, false);
  assert.doesNotMatch(JSON.stringify(result), /internal\.example|password|secret-token|failed|api\/health/);
});

test('健康请求使用 3 秒超时，超时按离线处理', async t => {
  const controller = new AbortController();
  controller.abort(new DOMException('private timeout details', 'TimeoutError'));
  t.mock.method(AbortSignal, 'timeout', ms => {
    assert.equal(ms, 3000);
    return controller.signal;
  });
  const result = await getAiSignalIntegration({ url: browserUrl }, {
    fetchImpl: async (_url, options) => { options.signal.throwIfAborted(); },
  });
  assert.equal(result.enabled, true);
  assert.equal(result.online, false);
  assert.doesNotMatch(JSON.stringify(result), /private timeout details|TimeoutError/);
});

test('工作台和健康 URL 拒绝非 HTTP、凭据、查询及片段且不泄露配置', async t => {
  const invalidUrls = [
    'javascript:alert(1)',
    'file:///tmp/config',
    'ftp://studio.example/',
    '//studio.example/',
    'not-a-url',
    'http://private-user:private-password@studio.example/',
    'http://private-user@studio.example/',
    'http://:private-password@studio.example/',
    'http://studio.example/?key=private-token',
    'http://studio.example/?',
    'http://studio.example/#private-fragment',
    'http://studio.example/#',
    'http://stu\tdio.example/',
  ];
  for (const [index, invalidUrl] of invalidUrls.entries()) {
    for (const field of ['url', 'healthUrl']) {
      await t.test(`${field} 无效地址 ${index + 1}`, async () => {
        const result = await getAiSignalIntegration({ url: browserUrl, [field]: invalidUrl }, {
          fetchImpl: () => assert.fail('invalid configuration must not fetch'),
        });
        assert.deepEqual(result, { enabled: false, url: '', online: false, service, message: '热点工作台地址配置无效' });
        assert.doesNotMatch(JSON.stringify(result), /private-user|private-password|private-token|private-fragment|studio\.example/);
      });
    }
  }
});

test('健康检查只接受 /api/health，拒绝生成发布及其他路径', async () => {
  for (const pathname of ['/', '/api/generate', '/api/publish', '/api/health/', '/v1/api/health', '/api/%68ealth']) {
    const result = await getAiSignalIntegration({ url: browserUrl, healthUrl: `http://internal.example${pathname}` }, {
      fetchImpl: () => assert.fail('non-health endpoint must not fetch'),
    });
    assert.equal(result.enabled, false);
    assert.equal(result.url, '');
    assert.equal(result.online, false);
  }
});
