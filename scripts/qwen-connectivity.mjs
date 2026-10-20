import { config } from '../src/config.js';

const endpoint = `${config.qwenBaseUrl}/chat/completions`;
const maskedEndpoint = endpoint.replace(/(https:\/\/)([^/]+)/, '$1$2');

function fail(message, details = '') {
  console.error(`\n[失败] ${message}`);
  if (details) console.error(details);
  process.exitCode = 1;
}

if (!config.qwenApiKey) {
  fail(
    '未配置千问 API Key。',
    '请复制 .env.example 为 .env，然后填写 QWEN_API_KEY；不要把 API Key 发到聊天、日志或截图中。'
  );
} else {
  console.log('[千问连通性测试]');
  console.log(`模型: ${config.qwenModel}`);
  console.log(`接口: ${maskedEndpoint}`);
  console.log('API Key: 已读取（不会显示）');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.qwenApiKey}`
      },
      body: JSON.stringify({
        model: config.qwenModel,
        temperature: 0,
        messages: [
          {
            role: 'system',
            content: '你是接口连通性测试助手。请只回复：千问接口连接成功'
          },
          {
            role: 'user',
            content: '请执行连通性测试。'
          }
        ]
      }),
      signal: controller.signal
    });

    const raw = await response.text();
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      data = null;
    }

    if (!response.ok) {
      const requestId = response.headers.get('x-request-id') || data?.request_id || data?.requestId;
      const apiMessage = data?.error?.message || data?.message || raw.slice(0, 500);
      const hints = {
        400: '请检查模型名称、API Host 与请求参数是否匹配。',
        401: '请检查 API Key 是否正确、是否完整，并确认它与所选地域一致。',
        403: '请确认百炼模型服务已开通，并检查业务空间、模型权限或 IP 白名单。',
        404: '请检查 QWEN_BASE_URL。建议直接使用创建 API Key 时显示的 API Host。',
        429: '阿里云模型调用额度或并发受限，请查看百炼用量与计费状态。'
      };
      fail(
        `HTTP ${response.status} ${response.statusText}`,
        `${hints[response.status] || '请根据阿里云返回信息检查配置。'}\n阿里云信息: ${apiMessage}${requestId ? `\nRequest ID: ${requestId}` : ''}`
      );
    } else {
      const text = data?.choices?.[0]?.message?.content?.trim();
      if (!text) {
        fail('接口返回成功，但没有读取到回复文本。', raw.slice(0, 500));
      } else {
        console.log(`HTTP: ${response.status}`);
        console.log(`返回模型: ${data.model || config.qwenModel}`);
        console.log(`回复: ${text}`);
        if (data.usage) {
          console.log(`Token: 输入 ${data.usage.prompt_tokens ?? '-'} / 输出 ${data.usage.completion_tokens ?? '-'} / 总计 ${data.usage.total_tokens ?? '-'}`);
        }
        console.log('\n[成功] 当前电脑已能调用阿里云百炼千问。');
      }
    }
  } catch (error) {
    if (error?.name === 'AbortError') {
      fail('请求超过 30 秒，已中止。', '请检查本机网络、代理、防火墙或 API Host。');
    } else {
      fail('无法连接阿里云百炼。', error?.message || String(error));
    }
  } finally {
    clearTimeout(timer);
  }
}
