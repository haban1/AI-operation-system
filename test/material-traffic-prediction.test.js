import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  callQwenTrafficPrediction,
  predictMaterialTraffic,
  predictionPrompt
} from '../agent/material-traffic-prediction.js';
import {
  TRAFFIC_PREDICTION_DISCLAIMER,
  normalizeTrafficPredictionResult
} from '../src/services/material-traffic-schema.js';

function prediction(overrides = {}) {
  return JSON.stringify({
    platformPredictions: [
      { platformCode: 'douyin', score: 78, strengths: ['标题直接点题', '正文信息层次清楚', '具备互动讨论空间'] },
      { platformCode: 'wechat_channels', score: 84, strengths: ['信息表达可信', '适合熟人分享', '主题与社区场景匹配'] }
    ],
    ...overrides
  });
}

test('千问流量潜力请求不依赖账号历史且禁止预测绝对播放量', async () => {
  let request;
  const result = await callQwenTrafficPrediction({
    title: '社区活动安排',
    body: '本期内容介绍社区活动的重点安排和参与提示。',
    contentOrigin: 'HUMAN_ORIGINAL',
    platformCodes: ['douyin', 'wechat_channels'],
    materialMeta: { type: 'video', durationSeconds: 150 },
    contentContext: { coreTheme: '社区活动安排', keyPoints: ['参与提示'] },
    aiReview: { overall: 'PASSED', summary: '未发现风险' },
    model: 'qwen3.7-plus',
    apiKey: 'test-key',
    baseUrl: 'https://example.test/compatible-mode/v1',
    fetchImpl: async (url, options) => {
      request = { url, body: JSON.parse(options.body) };
      return { ok: true, json: async () => ({ model: 'qwen3.7-plus', choices: [{ message: { content: prediction() } }], usage: { total_tokens: 60 } }) };
    }
  });
  assert.equal(request.url, 'https://example.test/compatible-mode/v1/chat/completions');
  assert.equal(request.body.model, 'qwen3.7-plus');
  assert.equal(request.body.enable_thinking, false);
  assert.deepEqual(request.body.response_format, { type: 'json_object' });
  assert.match(request.body.messages[0].content, /不读取、不假设、不引用账号近期流量/);
  assert.match(request.body.messages[0].content, /不预测具体播放量/);
  assert.match(request.body.messages[0].content, /各平台必须独立评分/);
  assert.match(request.body.messages[0].content, /抖音/);
  assert.match(request.body.messages[0].content, /视频号/);
  assert.equal(result.usage.total_tokens, 60);
});

test('流量潜力结果按所选平台规范评分、等级和优势因素', () => {
  const result = normalizeTrafficPredictionResult(JSON.parse(prediction()), {
    platformCodes: ['douyin', 'wechat_channels'],
    model: 'qwen3.7-plus',
    materialSha256: 'a'.repeat(64)
  });
  assert.equal(result.status, 'SUCCESS');
  assert.equal(result.overallScore, 81);
  assert.equal(result.platformPredictions[0].level, '高潜力');
  assert.equal(result.platformPredictions[1].level, '高潜力');
  assert.equal(result.platformPredictions[0].strengths.length, 3);
  assert.equal(Object.hasOwn(result.platformPredictions[0], 'summary'), false);
  assert.equal(result.disclaimer, TRAFFIC_PREDICTION_DISCLAIMER);
});

test('在线流量潜力评估生成结果并缓存同一输入', async () => {
  let calls = 0;
  const options = {
    title: '社区服务时间说明',
    body: '内容说明社区服务的具体时间、参与方式和注意事项。',
    contentOrigin: 'HUMAN_ORIGINAL',
    platformCodes: ['douyin', 'wechat_channels'],
    materialMeta: { type: 'video', sha256: 'b'.repeat(64), durationSeconds: 150 },
    contentContext: { coreTheme: '社区服务时间与参与方式', keyPoints: ['服务时间', '参与方式'] },
    aiReview: { overall: 'PASSED' },
    mode: 'online',
    model: 'qwen3.7-plus',
    apiKey: 'test-key',
    invokeModel: async () => {
      calls += 1;
      return { content: prediction(), model: 'qwen3.7-plus', usage: { total_tokens: 48 }, elapsedMs: 12 };
    }
  };
  const first = await predictMaterialTraffic(options);
  const second = await predictMaterialTraffic(options);
  assert.equal(first.status, 'SUCCESS');
  assert.equal(first.platformPredictions[0].score, 78);
  assert.equal(first.usage.total_tokens, 48);
  assert.equal(second.cached, true);
  assert.equal(calls, 1);
});

test('Mock 模式明确标记演示评分且不调用在线模型', async () => {
  let invoked = false;
  const result = await predictMaterialTraffic({
    title: '演示标题',
    body: '演示正文用于验证页面流量潜力评分。',
    platformCodes: ['weibo'],
    materialMeta: { type: 'image', sha256: 'c'.repeat(64) },
    mode: 'mock',
    apiKey: '',
    invokeModel: async () => { invoked = true; return {}; }
  });
  assert.equal(result.status, 'SUCCESS');
  assert.equal(result.mock, true);
  assert.equal(result.platformPredictions[0].platformName, '微博');
  assert.equal(invoked, false);
});

test('AI 缺少任一所选平台结果时返回失败且不伪造评分', async () => {
  const result = await predictMaterialTraffic({
    title: '独立平台评分测试',
    body: '当前内容用于验证模型必须完整返回所选平台结果。',
    platformCodes: ['douyin', 'bilibili'],
    materialMeta: { type: 'video', sha256: 'd'.repeat(64) },
    mode: 'online',
    model: 'qwen3.7-plus',
    apiKey: 'test-key',
    force: true,
    invokeModel: async () => ({ content: JSON.stringify({ platformPredictions: [{ platformCode: 'douyin', score: 70, strengths: ['主题明确', '标题清晰'] }] }) })
  });
  assert.equal(result.status, 'FAILED');
  assert.equal(result.code, 'TRAFFIC_PREDICTION_INCOMPLETE');
  assert.deepEqual(result.platformPredictions, []);
});

test('发布页、Local Agent 与 Web 代理包含平台内容潜力功能和参考声明', () => {
  const root = path.resolve(import.meta.dirname, '..');
  const app = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
  const styles = fs.readFileSync(path.join(root, 'public', 'styles.css'), 'utf8');
  const agent = fs.readFileSync(path.join(root, 'agent', 'local-agent.js'), 'utf8');
  const server = fs.readFileSync(path.join(root, 'src', 'server.js'), 'utf8');
  assert.match(app, /\/traffic-prediction/);
  assert.match(app, /AI平台内容适配潜力评分/);
  assert.match(app, /不读取账号近期表现/);
  assert.match(app, /具体内容表现以平台实际数据为准/);
  assert.match(app, /素材潜力预测/);
  assert.doesNotMatch(app, /素材流量预测/);
  assert.match(styles, /traffic-platform-card/);
  assert.match(styles, /traffic-score-ring/);
  assert.match(agent, /MATERIAL_TRAFFIC_PREDICTION/);
  assert.match(server, /traffic-prediction/);
});

test('流量预测提示词明确平台差异和仅供参考边界', () => {
  const prompt = predictionPrompt({
    title: '测试标题', body: '测试正文', platformCodes: ['bilibili', 'weibo'], materialMeta: {}, contentContext: {}, aiReview: {}
  });
  assert.match(prompt, /B站/);
  assert.match(prompt, /微博/);
  assert.match(prompt, /内容深度/);
  assert.match(prompt, /话题性/);
  assert.match(prompt, /不得声称是平台官方预测/);
  assert.doesNotMatch(prompt, /\"summary\"/);
});

