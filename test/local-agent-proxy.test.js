import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';

const root = path.resolve(import.meta.dirname, '..');

async function freePort() {
  const server = http.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function waitFor(base) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(`${base}/api/health`);
      if (response.ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Web 服务启动超时');
}

async function closeServer(server) {
  if (!server.listening) return;
  await new Promise(resolve => server.close(resolve));
}

async function requestJson(base, pathname, options = {}) {
  const response = await fetch(`${base}${pathname}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }
  });
  return { response, data: await response.json() };
}

test('Web 统一代理 Local Agent，隐藏共享 Token 并限制代理路由', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-agent-proxy-'));
  const webPort = await freePort();
  const agentPort = await freePort();
  const token = 'proxy-test-secret-token';
  const bindingId = createHash('sha256').update(`device-rpa-01\0${token}`).digest('hex').slice(0, 24);
  let reportedBindingId = bindingId;
  let regenerationReply = null;
  const seen = { precheckToken: null, precheckBody: null, audioToken: null, audioBody: null, knowledgeToken: null, knowledgeBody: null, shutdownCalls: 0, previewRange: null };

  const agentServer = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${agentPort}`);
    if (req.method === 'GET' && url.pathname === '/health') {
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ ok: true, deviceId: 'device-rpa-01', bindingId: reportedBindingId, version: 'proxy-test', masterSwitchEnabled: true }));
    }
    if (req.method === 'POST' && url.pathname === '/precheck') {
      seen.precheckToken = req.headers['x-agent-token'];
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      seen.precheckBody = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ ok: true, precheck: { overall: 'PASSED' }, previewUrl: '/material-preview/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' }));
    }
    if (req.method === 'POST' && url.pathname === '/audio-content-generation') {
      seen.audioToken = req.headers['x-agent-token'];
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      seen.audioBody = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ ok: true, generation: { status: 'SUCCESS', materialSha256: seen.audioBody.materialSha256, result: { title: 'AI标题', body: 'AI正文' } } }));
    }
    if (req.method === 'POST' && url.pathname === '/material-content-generation') {
      seen.knowledgeToken = req.headers['x-agent-token'];
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      seen.knowledgeBody = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      res.writeHead(regenerationReply.status, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(regenerationReply.body));
    }
    if (req.method === 'POST' && url.pathname === '/control/shutdown') {
      seen.shutdownCalls += 1;
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ ok: true }));
    }
    if (['GET', 'HEAD'].includes(req.method) && url.pathname === '/material-preview/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa') {
      seen.previewRange = req.headers.range || null;
      const bytes = Buffer.from('preview');
      res.writeHead(req.headers.range ? 206 : 200, {
        'Content-Type': 'video/mp4',
        'Content-Length': bytes.length,
        'Accept-Ranges': 'bytes',
        ...(req.headers.range ? { 'Content-Range': `bytes 0-${bytes.length - 1}/${bytes.length}` } : {})
      });
      if (req.method === 'HEAD') return res.end();
      return res.end(bytes);
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: false, message: 'stub route not found' }));
  });
  await new Promise(resolve => agentServer.listen(agentPort, '127.0.0.1', resolve));

  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(webPort),
      AGENT_PORT: String(agentPort),
      DATABASE_PATH: path.join(dir, 'test.db'),
      AUTH_ENABLED: 'false',
      AGENT_SHARED_TOKEN: token,
      LOCAL_AGENT_AUTO_START: 'false',
      AUTO_COLLECT_ENABLED: 'false',
      SMOKE_TEST_ENABLED: 'false',
      QWEN_MODE: 'mock',
      RPA_MODE: 'simulated'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });

  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await Promise.race([
        new Promise(resolve => child.once('exit', resolve)),
        new Promise(resolve => setTimeout(resolve, 2000))
      ]);
    }
    await closeServer(agentServer);
    fs.rmSync(dir, { recursive: true, force: true });
    assert.equal(stderr, '', stderr);
  });

  const base = `http://127.0.0.1:${webPort}`;
  await waitFor(base);
  await requestJson(base, '/api/settings/operations', { method: 'POST', body: JSON.stringify({ enabled: true, updatedBy: 'proxy-test' }) });

  const bootstrap = await requestJson(base, '/api/bootstrap');
  assert.equal(bootstrap.response.status, 200);
  assert.equal(bootstrap.data.localAgent.online, true);
  assert.equal(bootstrap.data.localAgent.deviceId, 'device-rpa-01');
  assert.equal(bootstrap.data.localAgent.bindingVerified, true);
  assert.equal(bootstrap.data.config.localAgentBaseUrl, '/api/local-agent');
  assert.equal(bootstrap.data.config.audioContentGenerationEnabled, true);
  assert.equal(bootstrap.data.config.audioContentAutoTrigger, true);
  assert.equal(Object.hasOwn(bootstrap.data.config, 'localAgentToken'), false);
  assert.equal(JSON.stringify(bootstrap.data).includes(token), false);

  const health = await requestJson(base, '/api/local-agent/health');
  assert.equal(health.response.status, 200);
  assert.equal(health.data.localAgent.online, true);

  const precheck = await requestJson(base, '/api/local-agent/precheck', {
    method: 'POST',
    body: JSON.stringify({ materialPath: 'D:/material/demo.mp4', platforms: ['bilibili'] })
  });
  assert.equal(precheck.response.status, 200);
  assert.equal(precheck.data.precheck.overall, 'PASSED');
  assert.equal(seen.precheckToken, token);
  assert.equal(seen.precheckBody.materialPath, 'D:/material/demo.mp4');


  const audioGeneration = await requestJson(base, '/api/local-agent/audio-content-generation', {
    method: 'POST',
    body: JSON.stringify({ materialPath: 'D:/material/demo.mp4', materialSha256: 'a'.repeat(64), platformCodes: ['douyin'] })
  });
  assert.equal(audioGeneration.response.status, 200);
  assert.equal(audioGeneration.data.generation.status, 'SUCCESS');
  assert.equal(seen.audioToken, token);
  assert.equal(seen.audioBody.materialSha256, 'a'.repeat(64));
  assert.deepEqual(seen.audioBody.platformCodes, ['douyin']);

  await t.test('知识专用重生成保留顶层错误码，返回安全提示且不覆盖原草稿', async t => {
    const created = await requestJson(base, '/api/material-knowledge-drafts', {
      method: 'POST',
      body: JSON.stringify({
        materialSha256: 'b'.repeat(64), materialFilename: '原始知识视频.mp4', materialPath: 'D:/material/knowledge.mp4',
        title: '已有完整知识', contentMarkdown: '# 已有完整知识\n\n末尾条件：资格过期后须重新申请。',
        generatorVersion: 'knowledge-proxy-test'
      })
    });
    assert.equal(created.response.status, 201);
    const original = created.data.draft;
    const privateDiagnostic = 'private upstream diagnostic: Authorization=Bearer test-only-secret';
    const cases = [
      { code: 'KNOWLEDGE_ONLINE_REQUIRED', message: '请开启在线 AI 后重新生成视频知识草稿。' },
      { code: 'AI_KEY_MISSING', message: '请先在 AI 设置中配置 API Key，再重新生成知识草稿。' },
      { code: 'ASR_TRANSCRIPT_UNUSABLE', message: '视频音频未能识别出有效内容，请检查音轨后重试。' },
      { code: 'AI_AUDIO_TOTAL_TIMEOUT', message: '知识草稿生成超时，请重新生成或拆分视频后重试。' },
      { code: 'KNOWLEDGE_HTTP_ERROR', message: '知识草稿生成失败，请稍后重试；原草稿已保留。' },
      { name: 'Local Agent HTTP 422 不暴露上游正文', httpFailure: true, code: 'KNOWLEDGE_HTTP_ERROR', message: '知识草稿生成失败，请稍后重试；原草稿已保留。' }
    ];
    for (const scenario of cases) {
      await t.test(scenario.name || scenario.code, async () => {
        regenerationReply = scenario.httpFailure ? {
          status: 422, body: { ok: false, code: scenario.code, message: privateDiagnostic }
        } : {
          status: 200,
          body: { ok: true, generation: {
            status: 'FAILED', code: scenario.code, message: privateDiagnostic,
            calls: { knowledge: { status: 'SKIPPED', errorCode: null, errorMessage: null } },
            // A failed result must remain a failure even if an upstream response contains a partial draft.
            ...(scenario.code === 'AI_KEY_MISSING' ? { knowledgeDraft: { ...original, title: '不应保存的部分草稿', contentMarkdown: '遗漏末尾条件的内容' } } : {})
          } }
        };
        const failed = await requestJson(base, `/api/material-knowledge-drafts/${original.id}/regenerate`, { method: 'POST', body: '{}' });
        assert.equal(failed.response.status, 422);
        assert.equal(failed.data.ok, false);
        assert.equal(failed.data.code, scenario.code);
        assert.equal(failed.data.message, scenario.message);
        assert.equal(failed.data.detail, null);
        assert.equal(JSON.stringify(failed.data).includes(privateDiagnostic), false);
        assert.equal(seen.knowledgeToken, token);
        assert.equal(seen.knowledgeBody.knowledgeOnly, true);
        assert.equal(seen.knowledgeBody.force, true);
        assert.equal(seen.knowledgeBody.materialSha256, original.materialSha256);
        assert.equal(seen.knowledgeBody.materialPath, original.materialPath);
        assert.deepEqual(seen.knowledgeBody.platformCodes, []);
        const reread = await requestJson(base, `/api/material-knowledge-drafts/${original.id}`);
        assert.deepEqual(reread.data.draft, original);
      });
    }
  });

  const denied = await requestJson(base, '/api/local-agent/control/shutdown', { method: 'POST', body: '{}' });
  assert.equal(denied.response.status, 404);
  assert.equal(denied.data.code, 'LOCAL_AGENT_PROXY_ROUTE_NOT_ALLOWED');
  assert.equal(seen.shutdownCalls, 0);

  const preview = await fetch(`${base}/api/local-agent/material-preview/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa`, { headers: { Range: 'bytes=0-6' } });
  assert.equal(preview.status, 206);
  assert.equal(preview.headers.get('content-type'), 'video/mp4');
  assert.equal(await preview.text(), 'preview');
  assert.equal(seen.previewRange, 'bytes=0-6');

  reportedBindingId = 'different-install-binding';
  const mismatchedHealth = await requestJson(base, '/api/local-agent/health');
  assert.equal(mismatchedHealth.data.localAgent.online, false);
  assert.equal(mismatchedHealth.data.localAgent.bindingVerified, false);
  assert.match(mismatchedHealth.data.localAgent.message, /不属于当前 Web 安装实例/);
  const rejectedMismatchedAgent = await requestJson(base, '/api/local-agent/precheck', { method: 'POST', body: '{}' });
  assert.equal(rejectedMismatchedAgent.response.status, 503);
  assert.equal(rejectedMismatchedAgent.data.code, 'LOCAL_AGENT_OFFLINE');
});
