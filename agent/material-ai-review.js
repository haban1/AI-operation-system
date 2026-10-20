import fs from 'node:fs';
import path from 'node:path';
import { config } from '../src/config.js';
import { buildAiReviewInputHash, buildFailedAiReview, buildMockAiReview, normalizeAiReviewResult } from '../src/services/ai-compliance.js';
import { reviewPublishContent } from '../src/services/content-compliance.js';
import { prepareOcrImages } from './material-ocr.js';

const cache = new Map();
const inflight = new Map();

function parseModelJson(content) {
  const raw = Array.isArray(content) ? content.map(item => typeof item === 'string' ? item : item?.text || '').join('\n') : String(content || '');
  const unfenced = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const candidates = [unfenced];
  const start = unfenced.indexOf('{');
  const end = unfenced.lastIndexOf('}');
  if (start >= 0 && end > start) candidates.push(unfenced.slice(start, end + 1));
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch {}
  }
  throw new Error('AI 返回内容不是有效 JSON');
}

function auditPrompt({ title, body, contentOrigin, sourceType, frameCount }) {
  return `你是社交媒体发布前的多模态内容安全审核员。请联合审核标题、正文、内容来源声明以及后续 ${frameCount} 张${sourceType === 'video' ? '视频代表帧' : '素材图片'}。\n\n审核维度：色情或性暗示、暴力血腥、自残、毒品、武器、违法交易、未成年人敏感风险、仇恨极端或危险内容、个人隐私和证件信息、手机号/二维码/站外引流、医疗金融功效等误导承诺、测试占位内容或自动化链路泄露、标题正文与素材画面明显矛盾、画面中的可见文字风险。\n\n判定要求：只有明确且严重的风险标记 BLOCK；不确定、需人工判断或轻度风险标记 WARN；不得臆测模糊画面。请只返回一个 JSON 对象，不要输出 Markdown。结构必须是：{"overall":"PASSED|WARNING|BLOCKED","summary":"简要结论","findings":[{"code":"英文大写代码","level":"WARN|BLOCK","field":"title|body|image|video|content|origin|material","message":"中文说明","frameIndex":1}],"textReview":{"overall":"PASSED|WARNING|BLOCKED","summary":"文案结论"},"imageReview":{"overall":"PASSED|WARNING|BLOCKED","summary":"画面结论","checkedFrames":${frameCount}}}。没有风险时 findings 为空数组。\n\n标题：${title}\n正文：${body}\n内容来源：${contentOrigin || '未选择'}`;
}

async function callQwenMultimodal({ images, title, body, contentOrigin, sourceType, model, apiKey, baseUrl = config.qwenBaseUrl }) {
  if (!apiKey) throw new Error('未配置千问 API Key');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.aiReviewTimeoutMs);
  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        temperature: 0,
        enable_thinking: false,
        max_tokens: 2200,
        response_format: { type: 'json_object' },
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: auditPrompt({ title, body, contentOrigin, sourceType, frameCount: images.length }) },
            ...images.map(item => ({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${item.buffer.toString('base64')}` } }))
          ]
        }]
      }),
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`千问多模态 API 返回 ${response.status}: ${(await response.text()).slice(0, 500)}`);
    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content;
    if (!content) throw new Error('千问多模态 API 未返回审核内容');
    return { review: parseModelJson(content), model: data.model || model, usage: data.usage || null };
  } finally {
    clearTimeout(timer);
  }
}

export async function reviewMaterialWithAi({
  title = '', body = '', contentOrigin = '', materialPath, precheck, force = false,
  mode = config.qwenMode, model = config.aiReviewModel, apiKey = config.qwenApiKey, baseUrl = config.qwenBaseUrl,
  invokeModel = callQwenMultimodal
} = {}) {
  const startedAt = Date.now();
  const absolute = path.resolve(materialPath || '');
  const meta = precheck?.meta || {};
  const materialSha256 = String(meta.sha256 || '').toLowerCase();
  const sourceType = meta.type || '';
  const inputHash = buildAiReviewInputHash({ title, body, contentOrigin, materialSha256 });
  const cacheKey = `${model}:${inputHash}`;
  if (!force && cache.has(cacheKey)) return { ...cache.get(cacheKey), cached: true };
  if (!force && inflight.has(cacheKey)) return inflight.get(cacheKey);

  const task = (async () => {
    if (!config.aiReviewEnabled) return buildFailedAiReview({ title, body, contentOrigin, materialSha256, sourceType, model, message: 'AI 内容与图片审核功能已关闭', elapsedMs: Date.now() - startedAt });
    if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) return buildFailedAiReview({ title, body, contentOrigin, materialSha256, sourceType, model, message: 'AI 审核素材不存在或不可读取', elapsedMs: Date.now() - startedAt });
    if (!materialSha256) return buildFailedAiReview({ title, body, contentOrigin, materialSha256, sourceType, model, message: '素材缺少 SHA-256 指纹，请重新检测素材', elapsedMs: Date.now() - startedAt });
    if (!['image', 'video'].includes(sourceType)) return buildFailedAiReview({ title, body, contentOrigin, materialSha256, sourceType, model, message: 'AI 审核仅支持图片和视频素材', elapsedMs: Date.now() - startedAt });
    if (mode !== 'online') return buildMockAiReview({ title, body, contentOrigin, materialSha256, sourceType, frameCount: sourceType === 'video' ? config.ocrVideoFrameCount : 1 });
    if (!apiKey) return buildFailedAiReview({ title, body, contentOrigin, materialSha256, sourceType, model, message: '未配置千问 API Key，无法完成 AI 图片审核', elapsedMs: Date.now() - startedAt });
    try {
      const images = await prepareOcrImages({ materialPath: absolute, meta });
      const transmittedBytes = images.reduce((sum, item) => sum + item.buffer.length, 0);
      const result = await invokeModel({ images, title: String(title).trim(), body: String(body).trim(), contentOrigin, sourceType, model, apiKey, baseUrl });
      const local = reviewPublishContent({ title, body });
      const output = normalizeAiReviewResult(result.review, {
        localFindings: local.findings,
        localOverall: local.overall,
        materialSha256,
        inputHash,
        sourceType,
        frameCount: images.length,
        transmittedBytes,
        model: result.model || model,
        usage: result.usage || null,
        elapsedMs: Date.now() - startedAt
      });
      cache.set(cacheKey, output);
      while (cache.size > 50) cache.delete(cache.keys().next().value);
      return output;
    } catch (error) {
      const reason = error.name === 'AbortError' ? '请求超时' : error.message;
      return buildFailedAiReview({ title, body, contentOrigin, materialSha256, sourceType, model, message: `AI 内容与图片审核失败：${reason}`, elapsedMs: Date.now() - startedAt });
    }
  })();
  inflight.set(cacheKey, task);
  try { return await task; }
  finally { inflight.delete(cacheKey); }
}

export { parseModelJson };
