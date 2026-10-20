import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { callQwenImageContent, generateMaterialCopyFromImage } from '../agent/material-image-content-generation.js';

function tempImage(t, content = crypto.randomBytes(32)) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'image-copy-test-'));
  const materialPath = path.join(directory, 'material.jpg');
  fs.writeFileSync(materialPath, content);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return materialPath;
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function precheckFor(file, overrides = {}) {
  return { overall: 'PASSED', meta: { type: 'image', sha256: sha256(file), format: 'JPEG', ...overrides } };
}

function imageCopy(overrides = {}) {
  return JSON.stringify({
    coreTheme: '社区便民活动安排与参与信息',
    contentAngle: '围绕图片中清晰可见的活动重点展开',
    keyPoints: ['图片展示活动主题', '图片列出参与提示'],
    imageSummary: '图片展示社区便民活动主题及参与提示。',
    title: '社区便民活动安排',
    body: '图片围绕社区便民活动展开，清晰呈现活动主题与参与提示，方便居民快速了解重点信息并按实际需要关注后续安排。',
    hashtags: ['社区活动'],
    confirmedFacts: ['图片展示社区活动信息'],
    uncertainFacts: [],
    riskFlags: [],
    confidence: 0.93,
    ...overrides
  });
}

const fakePrepareImages = async () => [{ index: 1, timeSeconds: null, buffer: Buffer.from('compressed-image') }];

test('千问图片文案请求使用主多模态模型与 image_url data URL', async () => {
  let request = null;
  const result = await callQwenImageContent({
    imageBuffer: Buffer.from('image'),
    platformCodes: ['weibo'],
    model: 'qwen3.7-plus',
    apiKey: 'test-key',
    baseUrl: 'https://example.test/compatible-mode/v1',
    fetchImpl: async (url, options) => {
      request = { url, options, body: JSON.parse(options.body) };
      return { ok: true, json: async () => ({ model: 'qwen3.7-plus', choices: [{ message: { content: imageCopy() } }], usage: { total_tokens: 30 } }) };
    }
  });
  assert.equal(request.url, 'https://example.test/compatible-mode/v1/chat/completions');
  assert.equal(request.body.model, 'qwen3.7-plus');
  assert.equal(request.body.enable_thinking, false);
  assert.deepEqual(request.body.response_format, { type: 'json_object' });
  assert.equal(request.body.messages[0].content[1].type, 'image_url');
  assert.equal(request.body.messages[0].content[1].image_url.url, 'data:image/jpeg;base64,aW1hZ2U=');
  assert.match(request.body.messages[0].content[0].text, /核心主题/);
  assert.match(request.body.messages[0].content[0].text, /不得依据文件名/);
  assert.match(request.body.messages[0].content[0].text, /禁止单独使用“精彩瞬间”/);
  assert.match(request.body.messages[0].content[0].text, /逐字检查 title 和 body/);
  assert.equal(result.usage.total_tokens, 30);
});

test('图片在线链路生成标题正文并缓存同一素材结果', async t => {
  const materialPath = tempImage(t);
  const checked = precheckFor(materialPath);
  let calls = 0;
  const options = {
    materialPath,
    precheck: checked,
    mode: 'online',
    apiKey: 'test-key',
    contentModel: 'qwen3.7-plus',
    prepareImages: fakePrepareImages,
    invokeContent: async () => {
      calls += 1;
      return { content: imageCopy(), model: 'qwen3.7-plus', usage: { total_tokens: 20 }, elapsedMs: 8 };
    }
  };
  const first = await generateMaterialCopyFromImage(options);
  const second = await generateMaterialCopyFromImage(options);
  assert.equal(first.status, 'SUCCESS');
  assert.equal(first.sourceType, 'image');
  assert.equal(first.result.title, '社区便民活动安排');
  assert.equal(first.result.imageSummary, '图片展示社区便民活动主题及参与提示。');
  assert.equal(first.result.sourceSummary, '图片展示社区便民活动主题及参与提示。');
  assert.equal(first.calls.content.model, 'qwen3.7-plus');
  assert.equal(first.transmittedBytes, Buffer.byteLength('compressed-image'));
  assert.equal(first.originalImageUploaded, false);
  assert.equal(second.cached, true);
  assert.equal(second.calls.content.errorCode, 'CACHE_HIT');
  assert.equal(calls, 1);
});

test('图片 Mock 模式明确未分析图片且不调用视觉模型', async t => {
  const materialPath = tempImage(t);
  let invoked = false;
  const result = await generateMaterialCopyFromImage({
    materialPath,
    precheck: precheckFor(materialPath),
    mode: 'mock',
    apiKey: '',
    prepareImages: async () => { invoked = true; return []; },
    invokeContent: async () => { invoked = true; return {}; }
  });
  assert.equal(result.status, 'SUCCESS');
  assert.equal(result.mock, true);
  assert.equal(result.sourceType, 'image');
  assert.match(result.result.imageSummary, /未读取或分析图片/);
  assert.equal(invoked, false);
});

test('图片素材 SHA 变化时拒绝调用模型', async t => {
  const materialPath = tempImage(t);
  let invoked = false;
  const result = await generateMaterialCopyFromImage({
    materialPath,
    precheck: { overall: 'PASSED', meta: { type: 'image', sha256: '0'.repeat(64) } },
    mode: 'online',
    apiKey: 'test-key',
    prepareImages: async () => { invoked = true; return []; },
    invokeContent: async () => { invoked = true; return {}; }
  });
  assert.equal(result.status, 'FAILED');
  assert.equal(result.code, 'MATERIAL_SHA_CHANGED');
  assert.equal(invoked, false);
});

test('图片生成命中风险词后会依据原图自动安全改写', async t => {
  const materialPath = tempImage(t);
  let calls = 0;
  const result = await generateMaterialCopyFromImage({
    materialPath,
    precheck: precheckFor(materialPath),
    mode: 'online',
    apiKey: 'test-key',
    force: true,
    prepareImages: fakePrepareImages,
    invokeContent: async ({ safetyRewrite, imageBuffer }) => {
      calls += 1;
      assert.ok(Buffer.isBuffer(imageBuffer));
      return safetyRewrite
        ? { content: imageCopy({ title: '社区咨询服务安排', body: '图片呈现社区咨询服务相关安排，并列出清晰可见的参与提示，方便居民结合自身需要了解具体信息。' }), usage: { total_tokens: 14 }, elapsedMs: 5 }
        : { content: imageCopy({ title: '法律援助服务安排', body: '图片介绍法律援助服务安排，并展示相关参与提示与信息。' }), usage: { total_tokens: 12 }, elapsedMs: 4 };
    }
  });
  assert.equal(result.status, 'SUCCESS');
  assert.equal(result.result.title, '社区咨询服务安排');
  assert.equal(calls, 2);
  assert.deepEqual(result.calls.content.usage, { total_tokens: 26 });
  assert.equal(result.calls.content.elapsedMs, 9);
});

test('图片安全改写后仍命中风险词时禁止自动填写', async t => {
  const materialPath = tempImage(t);
  let calls = 0;
  const result = await generateMaterialCopyFromImage({
    materialPath,
    precheck: precheckFor(materialPath),
    mode: 'online',
    apiKey: 'test-key',
    force: true,
    prepareImages: fakePrepareImages,
    invokeContent: async () => {
      calls += 1;
      return { content: imageCopy({ title: '法律援助服务安排', body: '图片介绍法律援助服务安排，并展示相关参与提示与信息。' }) };
    }
  });
  assert.equal(result.status, 'FAILED');
  assert.equal(result.code, 'CONTENT_COMPLIANCE_REWRITE_FAILED');
  assert.equal(calls, 2);
});

test('发布页与代理层包含图片生成入口、自动触发和统一路由', () => {
  const root = path.resolve(import.meta.dirname, '..');
  const app = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
  const agent = fs.readFileSync(path.join(root, 'agent', 'local-agent.js'), 'utf8');
  const server = fs.readFileSync(path.join(root, 'src', 'server.js'), 'utf8');
  assert.match(app, /\/material-content-generation/);
  assert.match(app, /meta\.type==='image'/);
  assert.match(app, /图片压缩/);
  assert.match(app, /画面理解/);
  assert.match(app, /图片视觉理解/);
  assert.match(app, /id="generateAudioCopy"/);
  assert.match(agent, /generateMaterialCopyFromImage/);
  assert.match(agent, /MATERIAL_IMAGE_CONTENT_GENERATION/);
  assert.match(agent, /'\/material-content-generation'/);
  assert.match(agent, /'\/audio-content-generation'/);
  assert.match(server, /material-content-generation/);
});
