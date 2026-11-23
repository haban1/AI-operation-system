import { AppError } from '../../engines/montage15/src/domain.mjs';
import { buildPlanPrompt, planSchema } from '../../engines/montage15/src/codex-planner.mjs';

export class SystemMontagePlanner {
  constructor({ settings, fetcher = fetch, timeoutMs = 180000 }) {
    this.settings = settings;
    this.fetcher = fetcher;
    this.timeoutMs = timeoutMs;
    this.lastSuccessAt = null;
  }

  async status() {
    const settings = this.settings();
    const available = settings.mode === 'online' && Boolean(settings.apiKey && settings.baseUrl && (settings.contentModel || settings.model));
    return { provider: 'system-ai', available, authenticated: available, version: settings.contentModel || settings.model,
      lastSuccessAt: this.lastSuccessAt,
      message: available ? '已连接系统模型' : '请在系统设置中配置并启用大模型',
      inputDescription: '制作要求、事实资料、所选素材的名称、说明、标签与时长' };
  }

  async plan(context, { signal, onProgress = () => {} } = {}) {
    if (!(await this.status()).available) throw new AppError(503, 'AI_UNAVAILABLE', '请在系统设置中配置并启用大模型');
    if (signal?.aborted) throw new AppError(409, 'AI_CANCELLED', '已取消本次 AI 任务');
    const settings = this.settings();
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    onProgress('正在选择素材并生成初稿');
    try {
      const response = await this.fetcher(`${settings.baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${settings.apiKey}` },
        body: JSON.stringify({ model: settings.contentModel || settings.model, temperature: 0.2, max_tokens: 6500,
          enable_thinking: false, response_format: { type: 'json_object' },
          messages: [{ role: 'system', content: buildPlanPrompt(context) + '\n只输出符合以下schema的JSON对象：' + JSON.stringify(planSchema) }] }),
        signal: combined,
      });
      if (!response.ok) throw new AppError(502, 'AI_PROVIDER_FAILED', '模型请求失败，请在系统设置中测试模型连接后重试');
      const data = await response.json();
      const choice = data.choices?.[0];
      if (choice?.finish_reason === 'length') throw new AppError(502, 'AI_INVALID_RESPONSE', '模型方案未生成完整，请重试');
      let plan;
      try { plan = JSON.parse(String(choice?.message?.content || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')); }
      catch { throw new AppError(502, 'AI_INVALID_RESPONSE', '模型未返回有效的编辑方案，请重试'); }
      this.lastSuccessAt = new Date().toISOString();
      return plan;
    } catch (error) {
      if (signal?.aborted) throw new AppError(409, 'AI_CANCELLED', '已取消本次 AI 任务');
      if (timeout.aborted) throw new AppError(504, 'AI_TIMEOUT', '本次 AI 处理超时，请稍后重试');
      if (error instanceof AppError) throw error;
      throw new AppError(502, 'AI_PROVIDER_FAILED', '模型连接暂时不可用，请稍后重试');
    }
  }
}
