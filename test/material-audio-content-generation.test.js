import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { withExtractedAudio } from '../agent/material-audio-extractor.js';
import { callQwenAsr, callQwenContent, callQwenKnowledge, generateMaterialCopyFromAudio } from '../agent/material-audio-content-generation.js';
import { normalizeMaterialKnowledgeDraft } from '../src/services/material-knowledge-schema.js';
import { normalizeGeneratedCopy, parseModelJson } from '../src/services/material-content-schema.js';

function tempMaterial(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'audio-copy-test-'));
  const materialPath = path.join(directory, 'video.mp4');
  fs.writeFileSync(materialPath, Buffer.from('fake-video'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return materialPath;
}

function precheck(sha = randomBytes(32).toString('hex'), overrides = {}) {
  return { overall: 'PASSED', meta: { type: 'video', hasAudio: true, durationSeconds: 150, sha256: sha, ...overrides } };
}

function successfulCopy(title = '社区活动精彩回顾') {
  return JSON.stringify({
    coreTheme: '社区活动参与方式与服务安排',
    contentAngle: '从参与者最关心的报名和服务信息切入',
    keyPoints: ['介绍活动主要内容', '说明参与方式'],
    audioSummary: '社区活动介绍',
    title,
    body: '一起回顾本次社区活动的精彩内容，欢迎大家持续关注后续安排。',
    hashtags: ['社区活动', '#社区活动'],
    confirmedFacts: [],
    uncertainFacts: [],
    riskFlags: [],
    confidence: 1.5
  });
}

function copyWithText({ title, body }) {
  const copy = JSON.parse(successfulCopy(title));
  copy.body = body;
  return JSON.stringify(copy);
}

const fakeExtractAudio = async ({ operation }) => operation({ buffer: Buffer.from('audio'), bytes: 5, mimeType: 'audio/mpeg' });

test('文案 JSON 可从围栏中解析，并按 Unicode 字符截断标题', () => {
  const parsed = parseModelJson(`前言\n\`\`\`json\n${successfulCopy('一二三四五六七八九十一二三四五六七八九十一二三')}\n\`\`\``);
  const result = normalizeGeneratedCopy(parsed, { platformCodes: ['douyin', 'douyin'] });
  assert.equal([...result.title].length, 20);
  assert.equal(result.coreTheme, '社区活动参与方式与服务安排');
  assert.equal(result.contentAngle, '从参与者最关心的报名和服务信息切入');
  assert.deepEqual(result.keyPoints, ['介绍活动主要内容', '说明参与方式']);
  assert.deepEqual(result.hashtags, ['社区活动']);
  assert.equal(result.confidence, 1);
  assert.deepEqual(result.platformCodes, ['douyin']);
});


test('千问 ASR 请求使用 OpenAI 兼容的音频 data URL 结构', async () => {
  let request = null;
  const result = await callQwenAsr({
    audioBuffer: Buffer.from('audio'),
    mimeType: 'audio/mpeg',
    model: 'qwen3-asr-flash',
    apiKey: 'test-api-key',
    baseUrl: 'https://example.test/compatible-mode/v1',
    fetchImpl: async (url, options) => {
      request = { url, options, body: JSON.parse(options.body) };
      return {
        ok: true,
        json: async () => ({ model: 'qwen3-asr-flash', choices: [{ message: { content: '这是音频转写结果。' } }], usage: { total_tokens: 12 } })
      };
    }
  });
  assert.equal(request.url, 'https://example.test/compatible-mode/v1/chat/completions');
  assert.equal(request.options.headers.Authorization, 'Bearer test-api-key');
  assert.equal(request.body.model, 'qwen3-asr-flash');
  assert.equal(request.body.stream, false);
  assert.deepEqual(request.body.messages[0].content[0], {
    type: 'input_audio',
    input_audio: { data: 'data:audio/mpeg;base64,YXVkaW8=' }
  });
  assert.deepEqual(request.body.asr_options, { language: 'zh' });
  assert.equal(result.text, '这是音频转写结果。');
  assert.equal(result.usage.total_tokens, 12);
});

test('千问文案请求关闭思考并要求 JSON 对象', async () => {
  let request = null;
  const result = await callQwenContent({
    transcript: '音频介绍了社区活动。',
    platformCodes: ['douyin'],
    model: 'qwen3.7-plus',
    apiKey: 'test-api-key',
    baseUrl: 'https://example.test/compatible-mode/v1',
    fetchImpl: async (url, options) => {
      request = { url, options, body: JSON.parse(options.body) };
      return {
        ok: true,
        json: async () => ({ model: 'qwen3.7-plus', choices: [{ message: { content: successfulCopy() } }], usage: { total_tokens: 20 } })
      };
    }
  });
  assert.equal(request.url, 'https://example.test/compatible-mode/v1/chat/completions');
  assert.equal(request.body.model, 'qwen3.7-plus');
  assert.equal(request.body.enable_thinking, false);
  assert.equal(request.body.temperature, 0.45);
  assert.deepEqual(request.body.response_format, { type: 'json_object' });
  assert.match(request.body.messages[0].content, /严格只根据/);
  assert.match(request.body.messages[0].content, /核心主题/);
  assert.match(request.body.messages[0].content, /禁止单独使用“精彩回顾”/);
  assert.match(request.body.messages[0].content, /100～220个中文字符/);
  assert.match(request.body.messages[0].content, /法律、律师、起诉、法院、违法、行政处罚/);
  assert.match(request.body.messages[0].content, /逐字检查 title 和 body/);
  assert.match(request.body.messages[0].content, /音频介绍了社区活动/);
  assert.equal(result.usage.total_tokens, 20);
});

test('命中风险词的生成结果会自动安全改写后再返回', async t => {
  const materialPath = tempMaterial(t);
  const requests = [];
  const risky = copyWithText({
    title: '社区法律服务介绍',
    body: '视频介绍社区提供的法律服务和政策解释，帮助创业者了解相关支持安排。'
  });
  const safe = copyWithText({
    title: '社区创业支持服务',
    body: '视频聚焦社区创业支持内容，介绍可获得的专业咨询和全流程陪伴安排，帮助创业者更清楚地了解相关服务。'
  });
  const result = await generateMaterialCopyFromAudio({
    materialPath,
    precheck: precheck('a'.repeat(64)),
    mode: 'online',
    apiKey: 'test-api-key',
    force: true,
    extractAudio: fakeExtractAudio,
    invokeAsr: async () => ({ text: '音频介绍社区面向创业者提供的服务支持。' }),
    invokeContent: async args => {
      requests.push(args);
      return { content: args.safetyRewrite ? safe : risky, model: 'fake-content', usage: { total_tokens: 10 }, elapsedMs: 3 };
    }
  });
  assert.equal(result.status, 'SUCCESS');
  assert.equal(requests.length, 2);
  assert.ok(requests[1].safetyRewrite.findings.some(item => item.code === 'BUSINESS_RISK_LEGAL'));
  assert.equal(result.result.title, '社区创业支持服务');
  assert.doesNotMatch(`${result.result.title}\n${result.result.body}`, /法律|政策解释/);
  assert.equal(result.calls.content.usage.total_tokens, 20);
  assert.equal(result.calls.content.elapsedMs, 6);
});

test('安全改写后仍命中风险词时禁止自动填写文案', async t => {
  const materialPath = tempMaterial(t);
  let contentCalls = 0;
  const risky = copyWithText({
    title: '社区法律服务介绍',
    body: '视频介绍社区提供的法律服务，帮助创业者了解相关支持安排。'
  });
  const result = await generateMaterialCopyFromAudio({
    materialPath,
    precheck: precheck('b'.repeat(64)),
    mode: 'online',
    apiKey: 'test-api-key',
    force: true,
    extractAudio: fakeExtractAudio,
    invokeAsr: async () => ({ text: '音频介绍社区面向创业者提供的服务支持。' }),
    invokeContent: async () => { contentCalls += 1; return { content: risky, model: 'fake-content' }; }
  });
  assert.equal(result.status, 'FAILED');
  assert.equal(result.code, 'CONTENT_COMPLIANCE_REWRITE_FAILED');
  assert.match(result.message, /禁止自动填写标题和正文/);
  assert.equal(contentCalls, 2);
});

test('mock 模式明确标记为演示数据且不调用音频或网络', async () => {
  let extractCalls = 0;
  const result = await generateMaterialCopyFromAudio({
    materialPath: 'Z:/does-not-exist.mp4',
    precheck: precheck('1'.repeat(64)),
    mode: 'mock',
    extractAudio: async () => { extractCalls += 1; throw new Error('should not run'); },
    invokeAsr: async () => { throw new Error('should not run'); },
    invokeContent: async () => { throw new Error('should not run'); }
  });
  assert.equal(result.status, 'SUCCESS');
  assert.equal(result.mock, true);
  assert.equal(result.mode, 'mock');
  assert.match(result.result.title, /未分析视频/);
  assert.match(result.transcript.text, /未读取或分析/);
  assert.equal(result.originalVideoUploaded, false);
  assert.equal(extractCalls, 0);
});

test('在线模式拒绝非视频、无音轨和超时长素材', async t => {
  const materialPath = tempMaterial(t);
  const common = { materialPath, mode: 'online', apiKey: 'test-api-key', extractAudio: fakeExtractAudio };
  const notVideo = await generateMaterialCopyFromAudio({ ...common, precheck: precheck('2'.repeat(64), { type: 'image' }) });
  const noAudio = await generateMaterialCopyFromAudio({ ...common, precheck: precheck('3'.repeat(64), { hasAudio: false }) });
  const tooLong = await generateMaterialCopyFromAudio({ ...common, precheck: precheck('4'.repeat(64), { durationSeconds: 301 }), maxDurationSeconds: 300 });
  assert.equal(notVideo.code, 'MATERIAL_NOT_VIDEO');
  assert.equal(noAudio.code, 'MATERIAL_AUDIO_MISSING');
  assert.equal(tooLong.code, 'MATERIAL_DURATION_EXCEEDED');
});

test('在线链路完成 ASR 与文案生成、规范化结果并命中缓存', async t => {
  const materialPath = tempMaterial(t);
  const sha = '5'.repeat(64);
  let extractCalls = 0, asrCalls = 0, contentCalls = 0;
  const options = {
    materialPath,
    precheck: precheck(sha),
    platformCodes: ['douyin'],
    mode: 'online',
    apiKey: 'test-api-key',
    extractAudio: async args => { extractCalls += 1; return fakeExtractAudio(args); },
    invokeAsr: async () => { asrCalls += 1; return { text: '今天介绍社区活动的参与方式。', model: 'fake-asr', usage: { total_tokens: 10 }, elapsedMs: 8 }; },
    invokeContent: async () => { contentCalls += 1; return { content: successfulCopy('这是一个超过二十个字符的社区活动精彩回顾标题'), model: 'fake-content', usage: { total_tokens: 20 }, elapsedMs: 9 }; }
  };
  const first = await generateMaterialCopyFromAudio(options);
  const second = await generateMaterialCopyFromAudio(options);
  assert.equal(first.status, 'SUCCESS');
  assert.equal([...first.result.title].length, 20);
  assert.equal(first.transcript.text, '今天介绍社区活动的参与方式。');
  assert.equal(first.calls.asr.status, 'SUCCESS');
  assert.equal(first.calls.content.status, 'SUCCESS');
  assert.equal(first.transmittedBytes, 5);
  assert.equal(second.cached, true);
  assert.equal(second.calls.asr.status, 'SKIPPED');
  assert.equal(second.calls.content.status, 'SKIPPED');
  assert.equal(second.calls.asr.usage, null);
  assert.equal(second.calls.content.usage, null);
  assert.equal(second.transmittedBytes, 0);
  assert.equal(extractCalls, 1);
  assert.equal(asrCalls, 1);
  assert.equal(contentCalls, 1);
});

test('相同在线请求会合并并发调用', async t => {
  const materialPath = tempMaterial(t);
  let asrCalls = 0, contentCalls = 0;
  const options = {
    materialPath,
    precheck: precheck('6'.repeat(64)),
    mode: 'online',
    apiKey: 'test-api-key',
    extractAudio: fakeExtractAudio,
    invokeAsr: async () => { asrCalls += 1; await new Promise(resolve => setTimeout(resolve, 30)); return { text: '音频介绍了社区服务安排。', model: 'fake-asr' }; },
    invokeContent: async () => { contentCalls += 1; return { content: successfulCopy(), model: 'fake-content' }; }
  };
  const [first, second] = await Promise.all([generateMaterialCopyFromAudio(options), generateMaterialCopyFromAudio(options)]);
  assert.equal(first.status, 'SUCCESS');
  assert.equal(second.status, 'SUCCESS');
  assert.equal(second.cached, true);
  assert.equal(second.calls.asr.errorCode, 'INFLIGHT_SHARED');
  assert.equal(second.calls.content.errorCode, 'INFLIGHT_SHARED');
  assert.equal(asrCalls, 1);
  assert.equal(contentCalls, 1);
});

test('空白或大部分听不清的转写不会调用文案模型', async t => {
  const materialPath = tempMaterial(t);
  let contentCalls = 0;
  const result = await generateMaterialCopyFromAudio({
    materialPath,
    precheck: precheck('7'.repeat(64)),
    mode: 'online',
    apiKey: 'test-api-key',
    extractAudio: fakeExtractAudio,
    invokeAsr: async () => ({ text: '[听不清][听不清][听不清]' }),
    invokeContent: async () => { contentCalls += 1; return { content: successfulCopy() }; }
  });
  assert.equal(result.status, 'FAILED');
  assert.equal(result.code, 'ASR_TRANSCRIPT_UNUSABLE');
  assert.equal(result.calls.content.status, 'SKIPPED');
  assert.equal(contentCalls, 0);
});

test('文案模型无效 JSON 会修复一次，仍无效则安全失败', async t => {
  const materialPath = tempMaterial(t);
  let contentCalls = 0;
  const result = await generateMaterialCopyFromAudio({
    materialPath,
    precheck: precheck('8'.repeat(64)),
    mode: 'online',
    apiKey: 'test-api-key',
    force: true,
    extractAudio: fakeExtractAudio,
    invokeAsr: async () => ({ text: '音频介绍了社区活动。' }),
    invokeContent: async () => { contentCalls += 1; return { content: 'not-json' }; }
  });
  assert.equal(result.status, 'FAILED');
  assert.equal(result.code, 'CONTENT_INVALID_JSON');
  assert.equal(contentCalls, 2);
});


test('文案 JSON 修复成功时累计两次模型 usage', async t => {
  const materialPath = tempMaterial(t);
  let contentCalls = 0;
  const result = await generateMaterialCopyFromAudio({
    materialPath,
    precheck: precheck('9'.repeat(64)),
    mode: 'online',
    apiKey: 'test-api-key',
    force: true,
    extractAudio: fakeExtractAudio,
    invokeAsr: async () => ({ text: '音频介绍了社区活动。' }),
    invokeContent: async ({ repairContent }) => {
      contentCalls += 1;
      return repairContent == null
        ? { content: 'not-json', model: 'fake-content', usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 }, elapsedMs: 4 }
        : { content: successfulCopy(), model: 'fake-content', usage: { prompt_tokens: 8, completion_tokens: 6, total_tokens: 14 }, elapsedMs: 5 };
    }
  });
  assert.equal(result.status, 'SUCCESS');
  assert.equal(contentCalls, 2);
  assert.deepEqual(result.calls.content.usage, { prompt_tokens: 18, completion_tokens: 8, total_tokens: 26 });
  assert.equal(result.calls.content.elapsedMs, 9);
});

test('临时音频在后续操作失败时仍会清理', async t => {
  const materialPath = tempMaterial(t);
  let extractedPath = '';
  await assert.rejects(() => withExtractedAudio({
    materialPath,
    ffmpegExecutable: process.execPath,
    execFileImpl: async (_executable, args) => { fs.writeFileSync(args.at(-1), Buffer.from('mp3')); return { stdout: '', stderr: '' }; },
    operation: async audio => { extractedPath = audio.path; throw new Error('downstream failed'); }
  }), /downstream failed/);
  assert.ok(extractedPath);
  assert.equal(fs.existsSync(extractedPath), false);
  assert.equal(fs.existsSync(path.dirname(extractedPath)), false);
});

test('发布页包含音频生成入口、SHA 防串素材、AI 来源和重新审核约束', () => {
  const app = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'public', 'app.js'), 'utf8');
  assert.match(app, /\/audio-content-generation/);
  assert.match(app, /id="generateAudioCopy"/);
  assert.match(app, /AI_GENERATED/);
  assert.match(app, /generation\.materialSha256/);
  assert.match(app, /invalidateCompliance\(\)/);
  assert.match(app, /系统不会自动发布/);
  assert.match(app, /generation\.result\?\.mock===true/);
  assert.match(app, /不会自动填写标题和正文/);
  assert.match(app, /id="openAiOnlineSettings"/);
  assert.match(app, /去开启 Online 模式/);
  assert.match(app, /核心主题/);
  assert.match(app, /result\.keyPoints/);
  assert.match(app, /ai-status-card/);
  assert.match(app, /AI CONTENT ENGINE/);
  assert.match(app, /AI SAFETY SCANNER/);
  assert.match(app, /is-ai-running/);
  assert.match(app, /publish-origin-card/);
  assert.match(app, /publish-review-actions/);
  assert.match(app, /syncContentOriginVisual/);
  assert.match(app, /publish-column publish-side-column/);
  assert.match(app, /publish-side-column">[\s\S]*id="publishHistory"/);
  assert.ok(app.indexOf('id="publishHistory"') > app.indexOf('id="publishSubmitButton"'));
  assert.match(app, /ResizeObserver/);
  assert.match(app, /--publish-history-max-height/);
  assert.match(app, /is-height-limited/);
  const styles = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'public', 'styles.css'), 'utf8');
  assert.match(styles, /publish-action-card/);
  assert.match(styles, /publish-history-panel\.is-height-limited/);
  assert.match(styles, /overflow-y:auto/);
  assert.match(styles, /grid-auto-rows:max-content/);
  assert.match(styles, /@media\(max-width:960px\)/);
});


test('视频知识草稿只保留已确认内容，待确认项不会写入导入正文', () => {
  const draft = normalizeMaterialKnowledgeDraft({
    title: '社区服务介绍',
    summary: '视频介绍了社区服务办理方式。',
    keyFacts: ['可到服务点咨询'],
    faqs: [{ question: '在哪里咨询？', answer: '可到服务点咨询。' }],
    uncertainFacts: ['具体开放时间需要人工确认'],
    keywords: ['社区服务'],
    confidence: 0.8
  }, { materialSha256: 'a'.repeat(64), materialFilename: 'service.mp4' });
  assert.match(draft.contentMarkdown, /社区服务办理方式/);
  assert.match(draft.contentMarkdown, /在哪里咨询/);
  assert.doesNotMatch(draft.contentMarkdown, /具体开放时间/);
  assert.deepEqual(draft.uncertainFacts, ['具体开放时间需要人工确认']);
});

test('千问知识草稿请求使用低温度 JSON 输出并限制事实来源', async () => {
  let request = null;
  await callQwenKnowledge({
    transcript: '视频说明可以到社区服务点咨询。',
    model: 'qwen3.7-plus',
    apiKey: 'test-api-key',
    baseUrl: 'https://example.test/compatible-mode/v1',
    fetchImpl: async (url, options) => {
      request = { url, body: JSON.parse(options.body) };
      return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ title: '社区咨询', summary: '可到社区服务点咨询。', keyFacts: [], faqs: [], uncertainFacts: [], keywords: [], confidence: 1 }) } }] }) };
    }
  });
  assert.equal(request.body.temperature, 0.2);
  assert.deepEqual(request.body.response_format, { type: 'json_object' });
  assert.match(request.body.messages[0].content, /只提取转写中能够直接确认的事实/);
  assert.match(request.body.messages[0].content, /不得使用文件名、视频画面、常识或发布文案/);
});

test('视频文案成功时独立返回知识草稿，知识生成失败不阻断发布文案', async t => {
  const materialPath = tempMaterial(t);
  const base = {
    materialPath,
    mode: 'online',
    apiKey: 'test-api-key',
    force: true,
    knowledgeEnabled: true,
    extractAudio: fakeExtractAudio,
    invokeAsr: async () => ({ text: '视频说明可以到社区服务点咨询。' }),
    invokeContent: async () => ({ content: successfulCopy('社区服务咨询') })
  };
  const success = await generateMaterialCopyFromAudio({
    ...base,
    precheck: precheck('b'.repeat(64)),
    invokeKnowledge: async () => ({ content: JSON.stringify({ title: '社区服务咨询', summary: '可到社区服务点咨询。', keyFacts: ['可到服务点咨询'], faqs: [{ question: '如何咨询？', answer: '可到社区服务点咨询。' }], uncertainFacts: [], keywords: ['社区服务'], confidence: 0.9 }) })
  });
  assert.equal(success.status, 'SUCCESS');
  assert.equal(success.calls.knowledge.status, 'SUCCESS');
  assert.equal(success.knowledgeDraft.sourceMaterialHash, 'b'.repeat(64));
  assert.match(success.knowledgeDraft.contentMarkdown, /如何咨询/);

  const failedKnowledge = await generateMaterialCopyFromAudio({
    ...base,
    precheck: precheck('c'.repeat(64)),
    invokeKnowledge: async () => { throw Object.assign(new Error('knowledge unavailable'), { code: 'KNOWLEDGE_DOWN' }); }
  });
  assert.equal(failedKnowledge.status, 'SUCCESS');
  assert.equal(failedKnowledge.calls.content.status, 'SUCCESS');
  assert.equal(failedKnowledge.calls.knowledge.status, 'FAILED');
  assert.equal(failedKnowledge.knowledgeDraft, null);
});

test('知识库页面集中显示 AI 草稿操作，发布页只负责自动保存草稿', () => {
  const app = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'public', 'app.js'), 'utf8');
  assert.match(app, /material-knowledge-drafts/);
  assert.match(app, /AI生成草稿/);
  assert.match(app, /加入知识库/);
  assert.match(app, /重新生成/);
  assert.match(app, /确认后才会加入统一知识库/);
  assert.match(app, /knowledgeDraftSaved/);
  assert.match(app, /标题和正文已生成，但知识草稿生成失败，请点击重新生成文案后再试/);
  assert.ok(app.indexOf('AI生成草稿') > app.indexOf('async function renderRagKnowledge'));
});

test('模型报告输出截断时不能将可解析的部分知识作为完整草稿', async t => {
  const result = await generateMaterialCopyFromAudio({
    materialPath: tempMaterial(t),
    precheck: precheck(),
    mode: 'online',
    apiKey: 'test-api-key',
    knowledgeEnabled: true,
    extractAudio: fakeExtractAudio,
    invokeAsr: async () => ({ text: '申请条件和有效期都有明确要求。' }),
    invokeContent: async () => ({ content: successfulCopy() }),
    invokeKnowledge: args => callQwenKnowledge({
      ...args,
      fetchImpl: async () => ({
        ok: true,
        json: async () => ({
          model: 'test-knowledge-model',
          choices: [{ finish_reason: 'length', message: { content: JSON.stringify({ title: '申请条件', keyFacts: ['年满十八岁'] }) } }],
          usage: { total_tokens: 3000 }
        })
      })
    })
  });
  assert.equal(result.calls.content.status, 'SUCCESS');
  assert.equal(result.calls.knowledge.status, 'FAILED');
  assert.equal(result.calls.knowledge.errorCode, 'KNOWLEDGE_OUTPUT_INCOMPLETE');
  assert.equal(result.calls.knowledge.usage.total_tokens, 3000);
  assert.equal(result.knowledgeDraft, null);
});

test('知识 JSON 修复将长内容及末尾适用限制完整交给模型', async () => {
  const repairContent = JSON.stringify({
    title: '申请及使用要求',
    keyFacts: ['逐条记录已确认的申请条件。'.repeat(1100), '长期不使用资格会自动失效，需要重新申请。']
  }).slice(0, -1);
  let prompt = '';
  await callQwenKnowledge({
    transcript: '申请及使用要求',
    repairContent,
    model: 'test-knowledge-model',
    apiKey: 'test-api-key',
    fetchImpl: async (_url, options) => {
      prompt = JSON.parse(options.body).messages[0].content;
      return { ok: true, json: async () => ({ choices: [{ message: { content: '{}' } }] }) };
    }
  });
  assert.ok(prompt.includes(repairContent), '修复请求必须保留完整原始内容，不能丢掉末尾条件');
});

test('知识草稿超过容量时明确失败，不通过格式修复将事实缩减后保存', async t => {
  let knowledgeCalls = 0;
  const result = await generateMaterialCopyFromAudio({
    materialPath: tempMaterial(t),
    precheck: precheck(),
    mode: 'online',
    apiKey: 'test-api-key',
    knowledgeEnabled: true,
    extractAudio: fakeExtractAudio,
    invokeAsr: async () => ({ text: '原文包含需要完整保留的知识条件。' }),
    invokeContent: async () => ({ content: successfulCopy() }),
    invokeKnowledge: async () => {
      knowledgeCalls += 1;
      return { content: JSON.stringify({ title: '完整条件', keyFacts: [knowledgeCalls === 1 ? '知'.repeat(100_001) : '简化条件'] }) };
    }
  });
  assert.equal(result.calls.knowledge.status, 'FAILED');
  assert.equal(result.calls.knowledge.errorCode, 'KNOWLEDGE_DRAFT_CONTENT_TOO_LARGE');
  assert.equal(knowledgeCalls, 1);
  assert.equal(result.knowledgeDraft, null);
});

test('单独重新生成知识不调用发布文案，且不会污染正常文案生成的缓存', async t => {
  let copyCalls = 0;
  const input = {
    materialPath: tempMaterial(t),
    precheck: precheck(),
    mode: 'online',
    apiKey: 'test-api-key',
    knowledgeEnabled: true,
    extractAudio: fakeExtractAudio,
    invokeAsr: async () => ({ text: '原视频明确说明申请材料和办理步骤。' }),
    invokeContent: async () => {
      copyCalls += 1;
      return { content: successfulCopy() };
    },
    invokeKnowledge: async () => ({ content: JSON.stringify({ title: '申请要求', keyFacts: ['申请时提交有效证件。'] }) })
  };
  const knowledge = await generateMaterialCopyFromAudio({ ...input, knowledgeOnly: true });
  assert.equal(knowledge.status, 'SUCCESS');
  assert.equal(knowledge.calls.content.status, 'SKIPPED');
  assert.equal(copyCalls, 0);
  assert.equal(knowledge.result, null);
  assert.match(knowledge.knowledgeDraft.contentMarkdown, /有效证件/);

  const full = await generateMaterialCopyFromAudio(input);
  assert.equal(full.status, 'SUCCESS');
  assert.equal(copyCalls, 1);
  assert.equal(full.result.title, '社区活动精彩回顾');
  const cachedKnowledge = await generateMaterialCopyFromAudio({ ...input, knowledgeOnly: true });
  assert.equal(cachedKnowledge.result, null);
  assert.equal(copyCalls, 1);
  const otherSource = precheck();
  const otherKnowledge = await generateMaterialCopyFromAudio({ ...input, precheck: otherSource, knowledgeOnly: true });
  assert.equal(otherKnowledge.knowledgeDraft.sourceMaterialHash, otherSource.meta.sha256);
});

test('单独生成知识失败时返回知识错误，不将空草稿报告为成功', async t => {
  const result = await generateMaterialCopyFromAudio({
    materialPath: tempMaterial(t),
    precheck: precheck(),
    mode: 'online',
    apiKey: 'test-api-key',
    knowledgeOnly: true,
    extractAudio: fakeExtractAudio,
    invokeAsr: async () => ({ text: '原视频明确说明申请材料和办理步骤。' }),
    invokeContent: async () => ({ content: successfulCopy() }),
    invokeKnowledge: async () => { throw Object.assign(new Error('知识模型暂不可用'), { code: 'KNOWLEDGE_UNAVAILABLE' }); }
  });
  assert.equal(result.status, 'FAILED');
  assert.equal(result.code, 'KNOWLEDGE_UNAVAILABLE');
  assert.equal(result.calls.content.status, 'SKIPPED');
});

test('单独重新生成知识后普通生成不会从旧结果缓存恢复已淘汰的草稿', async t => {
  let knowledgeCalls = 0;
  const input = {
    materialPath: tempMaterial(t),
    precheck: precheck(),
    mode: 'online',
    apiKey: 'test-api-key',
    knowledgeEnabled: true,
    extractAudio: fakeExtractAudio,
    invokeAsr: async () => ({ text: '申请需要有效证件，资格过期后需要重新办理。' }),
    invokeContent: async () => ({ content: successfulCopy() }),
    invokeKnowledge: async () => ({ content: JSON.stringify({
      title: '申请及有效期',
      keyFacts: ++knowledgeCalls === 1 ? ['申请需要有效证件。'] : ['申请需要有效证件。', '资格过期后需要重新办理。']
    }) })
  };
  await generateMaterialCopyFromAudio(input);
  const regenerated = await generateMaterialCopyFromAudio({ ...input, knowledgeOnly: true, force: true });
  const revisit = await generateMaterialCopyFromAudio(input);
  assert.deepEqual(revisit.knowledgeDraft.keyFacts, regenerated.knowledgeDraft.keyFacts);
  assert.equal(knowledgeCalls, 2);
  assert.equal(revisit.result.title, '社区活动精彩回顾');
});


test('视频知识生成覆盖评论短问法，并将业务对象与答案保留在同一 FAQ', async () => {
  const transcript = '本视频介绍 OPC 港澳服务社区。申请加入需先提交项目介绍，审核通过后签约。';
  const faq = { question: '怎么加入 OPC 港澳服务社区？（常见问法：怎么加入？）', answer: '加入 OPC 港澳服务社区需先提交项目介绍，审核通过后签约。' };
  let prompt;
  const response = await callQwenKnowledge({
    transcript, model: 'test-model', apiKey: 'test', baseUrl: 'https://example.test/v1',
    fetchImpl: async (_url, options) => {
      prompt = JSON.parse(options.body).messages[0].content;
      return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ title: 'OPC 港澳服务社区', faqs: [faq] }) } }] }) };
    }
  });
  assert.match(prompt, /评论.*单轮/);
  assert.match(prompt, /常见问法/);
  assert.match(prompt, /多个.*业务/);
  assert.match(prompt, /不得.*反问/);
  assert.ok(prompt.includes(transcript));
  const draft = normalizeMaterialKnowledgeDraft(parseModelJson(response.content));
  assert.deepEqual(draft.faqs, [faq]);
  assert.ok(draft.contentMarkdown.includes('### ' + faq.question));
  assert.ok(draft.contentMarkdown.includes(faq.answer));
});
