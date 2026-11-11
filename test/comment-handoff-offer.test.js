import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Set isolation before importing services: neither production .env nor its database is opened.
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'comment-handoff-offer-'));
const apiKey = 'test-comment-offer-secret-key';
Object.assign(process.env, {
  NODE_ENV: 'test', TIANHE_SKIP_DOTENV: 'true', DATABASE_PATH: path.join(testDir, 'test.db'),
  SETTINGS_KEY_PATH: path.join(testDir, '.settings-key'), SETTINGS_ENCRYPTION_KEY: 'comment-offer-isolated-test-key',
  QWEN_MODE: 'online', QWEN_API_KEY: apiKey, DASHSCOPE_API_KEY: '',
  QWEN_BASE_URL: 'https://ai.example.invalid/v1', QWEN_MODEL: 'qwen-test-offer',
  WECOM_WEBHOOK_URL: '', RPA_MODE: 'simulated', AUTO_COLLECT_ENABLED: 'false', LOCAL_AGENT_AUTO_START: 'false'
});
const { composeCommentHandoffOffer } = await import('../src/services/comment-handoff-offer.js');
const { db, row } = await import('../src/db.js');
const { saveEncryptedSetting } = await import('../src/services/settings.js');
const { validateReplyTextLength, PLATFORM_REPLY_LIMITS } = await import('../src/services/platform-reply-policy.js');
after(() => {
  db.close();
  fs.rmSync(testDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const invitation = '想了解的话，回复“详情”，我们在站内消息里接着聊。';
const fallbackText = `这部分还得再确认一下。${invitation}`;
const completion = content => ({
  ok: true, status: 200,
  json: async () => ({ choices: [{ message: { content } }], usage: { prompt_tokens: 70, completion_tokens: 24, total_tokens: 94 } })
});
const offer = (content, options = {}) => composeCommentHandoffOffer({
  question: '舞蹈课怎么报名？', platformCode: 'weibo',
  fetchImpl: async () => completion(content), ...options
});
const lastLog = () => row("SELECT * FROM ai_call_logs WHERE source_module='comment-handoff-offer' ORDER BY id DESC LIMIT 1");

test('生成自然诉求承接后由程序追加详情和站内沟通提示，记录调用且只调用一次', async () => {
  let calls = 0;
  const result = await offer(JSON.stringify({ acknowledgement: '明白，你想了解舞蹈课的报名方式。' }), {
    taskId: 'isolated-offer-natural',
    fetchImpl: async (url, options) => {
      calls += 1;
      assert.equal(url, 'https://ai.example.invalid/v1/chat/completions');
      assert.equal(options.method, 'POST');
      assert.equal(options.redirect, 'error');
      assert.equal(options.headers.Authorization, `Bearer ${apiKey}`);
      assert.ok(options.signal instanceof AbortSignal);
      const payload = JSON.parse(options.body);
      assert.equal(payload.enable_thinking, false);
      assert.equal(payload.response_format.type, 'json_object');
      assert.ok(payload.max_tokens >= 512);
      assert.match(payload.messages[0].content, /不能回答问题/);
      assert.match(payload.messages[0].content, /不得对外引流、索取联系账号、夸大宣传或作效果保证/);
      assert.match(payload.messages[0].content, /不要固定以“明白，你想了解”开头/);
      assert.deepEqual(JSON.parse(payload.messages[1].content), { question: '舞蹈课怎么报名？' });
      return completion(JSON.stringify({ acknowledgement: '明白，你想了解舞蹈课的报名方式。' }));
    }
  });
  assert.deepEqual(result, {
    replyText: `明白，你想了解舞蹈课的报名方式。${invitation}`, model: 'qwen-test-offer', fallback: false
  });
  assert.equal(calls, 1);
  const log = lastLog();
  assert.equal(log.source_module, 'comment-handoff-offer');
  assert.equal(log.task_id, 'isolated-offer-natural');
  assert.equal(log.status, 'SUCCESS');
  assert.equal(log.total_tokens, 94);
  assert.doesNotMatch(result.replyText, /转人工|轉人工|需要人工|客服|已通知|已转|已轉|将联系|將聯繫|已发私信|已發私信/);
});

test('支持另一种自然承接句，缺句号时补全', async () => {
  const result = await offer('{"acknowledgement":"理解您想了解舞蹈课的报名流程"}');
  assert.equal(result.fallback, false);
  assert.equal(result.replyText, `理解您想了解舞蹈课的报名流程。${invitation}`);
});

test('AI学习和课程报名使用自然短句，只表达待核实而不编造答案', async () => {
  for (const { question, acknowledgement } of [
    { question: '我想学习一些ai', acknowledgement: '学AI这个问题，细节还得再核实一下。' },
    { question: '我想学习一些人工智能', acknowledgement: 'AI学习这块，我还得确认一下。' },
    { question: '课程怎么报名？', acknowledgement: '课程报名这块，我还得核实一下。' },
    { question: '舞蹈课怎么报名？', acknowledgement: '关于舞蹈课报名，具体还得确认一下。' },
    { question: '舞蹈课怎么报名？', acknowledgement: '你问的舞蹈课报名，细节还要再确认一下。' }
  ]) {
    const result = await offer(JSON.stringify({ acknowledgement }), { question, platformCode: 'douyin' });
    assert.equal(result.fallback, false, acknowledgement);
    assert.equal(result.replyText, acknowledgement + invitation);
    assert.doesNotMatch(result.replyText, /明白，你想了解|收到你的问题|进一步确认|[？?]/);
    assert.equal((result.replyText.match(/回复“详情”/g) || []).length, 1);
  }
});

test('自然句式仍拒绝用户问题之外的业务事实、联系方式及确定性承诺', async () => {
  for (const { question, acknowledgement } of [
    { question: '舞蹈课能免费报名吗？', acknowledgement: '舞蹈课免费报名这事，细节还得再核实一下。' },
    { question: '舞蹈课是不是每周一开课？', acknowledgement: '舞蹈课每周一开课这事，具体还得确认一下。' },
    { question: '课程可以报名了吗？', acknowledgement: '课程可以报名这块，我还得核实一下。' },
    { question: '舞蹈课怎么报名？', acknowledgement: '钢琴课报名这事，细节还得再核实一下。' },
    { question: '我想学习一些ai', acknowledgement: 'AI入门这块，我还得确认一下。' },
    { question: '舞蹈课怎么报名？', acknowledgement: '舞蹈课报名没问题。' },
    { question: '舞蹈课怎么报名？', acknowledgement: '当然，舞蹈课报名很简单。' },
    { question: '课程报名微信多少？', acknowledgement: '课程报名微信这块，我还得确认一下。' },
    { question: '怎么加群了解课程？', acknowledgement: '加群这事，细节还得再核实一下。' },
    { question: '我想学习一些ai', acknowledgement: '学AI这个问题，细节还得再核实一下。回复详情。' },
    { question: '我想学习一些ai', acknowledgement: '学AI这个问题，已发私信。' }
  ]) {
    const result = await offer(JSON.stringify({ acknowledgement }), { question, platformCode: 'douyin' });
    assert.equal(result.fallback, true, acknowledgement);
    assert.equal(result.replyText, fallbackText);
  }
});

test('AI、ai、人工智能和人工智慧仅作学习主题规范，正常诉求可自然承接', async () => {
  for (const question of ['我想学习一些ai', '我想学习一些AI', '我想学习人工智能', '我想学习人工智慧']) {
    for (const topic of ['AI', 'ai', '人工智能', '人工智慧']) {
      const acknowledgement = `明白，你想了解${topic}的学习方式。`;
      const result = await offer(JSON.stringify({ acknowledgement }), { question });
      assert.equal(result.fallback, false, `${question} -> ${acknowledgement}`);
      assert.equal(result.replyText, `${acknowledgement}${invitation}`);
    }
  }
});

test('真实模型的AI学习承接样例允许无业务断言的通用“内容”用语', async () => {
  const content = '{"acknowledgement":"明白，你想了解学习AI相关的内容。"}';
  const result = await offer(content, { question: '我想学习一些ai' });
  assert.equal(result.fallback, false);
  assert.equal(result.replyText, `明白，你想了解学习AI相关的内容。${invitation}`);
  const traditional = await offer('{"acknowledgement":"明白，你想了解學習AI相關的內容。"}', { question: '我想學習一些ai', script: 'traditional' });
  assert.equal(traditional.fallback, false);
});

for (const content of ['', '{}', 'null', '[]', '{"acknowledgement":""}', '{"acknowledgement":[]}', 'not-json', '{"acknowledgement":"明白，你想了解报名方式。","reply":"课程免费"}']) {
  test(`空或无效 JSON 安全兜底：${content || '(empty)'}`, async () => {
    const result = await offer(content);
    assert.equal(result.fallback, true);
    assert.equal(result.replyText, fallbackText);
    assert.equal(lastLog().status, 'FAILED');
  });
}

for (const acknowledgement of [
  '舞蹈课可以直接报名。',
  '明白，你想了解课程只需九十九元。',
  '明白，你想了解课程每周一开课。',
  '明白，你想了解课程在天河大厦开课。',
  '明白，你想了解课程包括书法。',
  '明白，你想了解我们提供课程。',
  '明白，你想了解课程是免费的。',
  '已帮你转人工，工作人员稍后联系。',
  '明白，你想了解已通知客服的情况。',
  '明白，你想了解课程地址是天河路。',
  '明白，你想了解课程咨询电话。',
  '明白，你想了解课程报名微信。',
  '明白，你想了解课程收费为１００元。',
  '明白，你想了解课程99元。',
  '明白，你想了解xAI的学习方式。',
  '明白，你想了解AI.com的学习方式。',
  '明白，你想了解AI人工转接。',
  '明白，你想了解人工智能已转人工。',
  '明白，你想了解人工智能免费课程。',
  '明白，你想了解人工智能每周开课。',
  '明白，你想了解https://example.invalid。',
  '明白，你想了解www.example.invalid。',
  '明白，你想了解报名方式。请发送手机号码。',
  '明白，你想了解钢琴课的报名方式。',
  '明白，你想了解课程\u200b报名方式。'
]) {
  test(`风险、越界、虚构信息安全兜底：${acknowledgement}`, async () => {
    const result = await offer(JSON.stringify({ acknowledgement }));
    assert.equal(result.fallback, true);
    assert.equal(result.replyText, fallbackText);
  });
}

test('超长承接不截断放行，各平台最终回复均满足保守字数限制', async () => {
  const result = await offer(JSON.stringify({ acknowledgement: `明白，你想了解${'报名方式'.repeat(12)}。` }));
  assert.equal(result.fallback, true);
  for (const platformCode of Object.keys(PLATFORM_REPLY_LIMITS)) {
    assert.equal(validateReplyTextLength({ platformCode, messageType: 'COMMENT', text: result.replyText }).ok, true);
  }
  const oversized = await offer(JSON.stringify({ acknowledgement: '你'.repeat(2_000) }));
  assert.equal(oversized.replyText, fallbackText);
});

test('抖音最终文案守卫拦截承接句中的群引流，即使它复述了用户原词', async () => {
  const result = await offer('{"acknowledgement":"明白，你想了解加群方式。"}', {
    question: '怎么加群了解课程？', platformCode: 'douyin'
  });
  assert.equal(result.fallback, true);
  assert.equal(result.replyText, fallbackText);
  assert.doesNotMatch(result.replyText, /加群|进群|入群|微信|电话|二维码|转人工|需要人工|已发私信/);
  assert.match(lastLog().error_message, /不适合公开评论/);
});

test('各平台成功生成和失败兜底都使用详情与站内沟通文案，不公开人工提示', async () => {
  for (const platformCode of Object.keys(PLATFORM_REPLY_LIMITS)) {
    for (const content of ['{"acknowledgement":"明白，你想了解舞蹈课的报名方式。"}', '{}']) {
      const result = await offer(content, { platformCode });
      assert.match(result.replyText, /回复“详情”/);
      assert.match(result.replyText, /站内消息/);
      assert.doesNotMatch(result.replyText, /转人工|需要人工|客服|已发私信|已通知/);
      assert.equal(validateReplyTextLength({ platformCode, messageType: 'COMMENT', text: result.replyText }).ok, true);
    }
  }
});

test('8秒硬截止能处理忽略 AbortSignal 的 fetch，不重试、不抛错', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  let signal;
  const pending = composeCommentHandoffOffer({
    fetchImpl: (url, options) => {
      calls += 1;
      signal = options.signal;
      return new Promise(() => {});
    }
  });
  t.mock.timers.tick(8_000);
  const result = await pending;
  assert.equal(result.replyText, fallbackText);
  assert.equal(result.fallback, true);
  assert.equal(calls, 1);
  assert.equal(signal.aborted, true);
  assert.equal(lastLog().error_code, 'AI_TIMEOUT');
});

test('截止也覆盖响应体读取，不因返回HTTP头后卡住', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = composeCommentHandoffOffer({
    fetchImpl: async () => ({ ok: true, json: () => new Promise(() => {}) })
  });
  await Promise.resolve();
  t.mock.timers.tick(8_000);
  assert.equal((await pending).replyText, fallbackText);
  assert.equal(lastLog().error_code, 'AI_TIMEOUT');
});

test('模型HTTP错误只调用一次且不读取响应体、采用询问兜底', async () => {
  let calls = 0;
  const result = await composeCommentHandoffOffer({ fetchImpl: async () => {
    calls += 1;
    return { ok: false, status: 503, text: () => { throw new Error('must not read model error body'); } };
  } });
  assert.equal(result.replyText, fallbackText);
  assert.equal(result.fallback, true);
  assert.equal(calls, 1);
  assert.match(lastLog().error_message, /HTTP 503/);
});

test('网络异常和异常JSON读取安全兜底，日志隐藏密钥', async () => {
  const result = await composeCommentHandoffOffer({ fetchImpl: async () => { throw new Error(`fetch failed ${apiKey} Bearer another-test-secret`); } });
  assert.equal(result.replyText, fallbackText);
  assert.doesNotMatch(lastLog().error_message, new RegExp(apiKey));
  assert.doesNotMatch(lastLog().error_message, /another-test-secret/);
  const invalidBody = await composeCommentHandoffOffer({ fetchImpl: async () => ({ ok: true, json: async () => { throw new SyntaxError('invalid json'); } }) });
  assert.equal(invalidBody.replyText, fallbackText);
});

test('繁体生成和兜底都引导回复详情并使用站内消息，不公开人工转接文案', async () => {
  const result = await offer('{"acknowledgement":"明白，您想了解舞蹈課的報名方式。"}', { question: '舞蹈課怎麼報名？', script: 'auto' });
  assert.equal(result.fallback, false);
  assert.match(result.replyText, /回覆「詳情」.*站內/);
  const fallback = await offer('{}', { script: 'traditional' });
  assert.match(fallback.replyText, /^這部分還得再確認一下。/);
  assert.match(fallback.replyText, /回覆「詳情」.*站內/);
  assert.doesNotMatch(result.replyText + fallback.replyText, /轉人工|需要人工|客服|已通知/);
});

test('繁体自然短句保持主题来源和不确定语气', async () => {
  const result = await offer('{"acknowledgement":"學AI這個問題，細節還得再核實一下。"}', {
    question: '我想學習一些ai', platformCode: 'douyin', script: 'traditional'
  });
  assert.equal(result.fallback, false);
  assert.equal(result.replyText, '學AI這個問題，細節還得再核實一下。想了解的話，回覆「詳情」，我們在站內訊息裡接著聊。');
});

test('mock模式完全不联网并标记固定安全承接为fallback', async () => {
  saveEncryptedSetting('ai.mode', 'mock', 'isolated-test');
  try {
    let calls = 0;
    const result = await composeCommentHandoffOffer({ fetchImpl: async () => { calls += 1; throw new Error('NETWORK_FORBIDDEN'); } });
    assert.deepEqual(result, { replyText: fallbackText, model: 'mock-comment-handoff-offer', fallback: true });
    assert.equal(calls, 0);
    assert.equal(lastLog().mode, 'mock');
    assert.equal(lastLog().status, 'SUCCESS');
  } finally { saveEncryptedSetting('ai.mode', 'online', 'isolated-test'); }
});
