import crypto from 'node:crypto';
import { reviewPublishContent } from './content-compliance.js';

export const AI_REVIEW_RULE_VERSION = 'ai-multimodal-2026.08.10.1';

const validOverall = new Set(['PASSED', 'WARNING', 'BLOCKED']);
const validLevels = new Set(['WARN', 'BLOCK']);
const validFields = new Set(['title', 'body', 'image', 'video', 'content', 'origin', 'material', 'system']);

function cleanText(value, maxLength = 1000) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function normalizeOverall(value, fallback = 'PASSED') {
  const normalized = String(value || '').trim().toUpperCase();
  return validOverall.has(normalized) ? normalized : fallback;
}

function strongestOverall(values) {
  const normalized = values.map(value => normalizeOverall(value)).filter(Boolean);
  if (normalized.includes('BLOCKED')) return 'BLOCKED';
  if (normalized.includes('WARNING')) return 'WARNING';
  return 'PASSED';
}

export function buildAiReviewInputHash({ title = '', body = '', contentOrigin = '', materialSha256 = '' } = {}) {
  return crypto.createHash('sha256').update(JSON.stringify({
    title: String(title).trim(),
    body: String(body).trim(),
    contentOrigin: String(contentOrigin).trim(),
    materialSha256: String(materialSha256).trim().toLowerCase()
  })).digest('hex');
}

export function normalizeAiReviewResult(raw = {}, context = {}) {
  const sourceFindings = Array.isArray(raw.findings) ? raw.findings : [];
  const findings = sourceFindings.map((item, index) => {
    const level = validLevels.has(String(item?.level || '').toUpperCase()) ? String(item.level).toUpperCase() : 'WARN';
    const field = validFields.has(String(item?.field || '').toLowerCase()) ? String(item.field).toLowerCase() : 'content';
    const frameIndex = Number(item?.frameIndex);
    return {
      code: cleanText(item?.code || `AI_FINDING_${index + 1}`, 80).replace(/[^A-Za-z0-9_-]/g, '_').toUpperCase(),
      level,
      field,
      message: cleanText(item?.message || 'AI 发现潜在风险，请人工核对', 500),
      ...(Number.isFinite(frameIndex) && frameIndex > 0 ? { frameIndex } : {})
    };
  }).filter(item => item.message);
  const localFindings = Array.isArray(context.localFindings) ? context.localFindings : [];
  for (const item of localFindings) {
    if (!findings.some(existing => existing.code === item.code && existing.field === item.field)) findings.push({ ...item });
  }
  const findingOverall = findings.some(item => item.level === 'BLOCK') ? 'BLOCKED' : findings.some(item => item.level === 'WARN') ? 'WARNING' : 'PASSED';
  const textOverall = strongestOverall([raw.textReview?.overall, context.localOverall, findings.some(item => ['title', 'body', 'content', 'origin'].includes(item.field) && item.level === 'BLOCK') ? 'BLOCKED' : findings.some(item => ['title', 'body', 'content', 'origin'].includes(item.field)) ? 'WARNING' : 'PASSED']);
  const imageOverall = strongestOverall([raw.imageReview?.overall, findings.some(item => ['image', 'video', 'material'].includes(item.field) && item.level === 'BLOCK') ? 'BLOCKED' : findings.some(item => ['image', 'video', 'material'].includes(item.field)) ? 'WARNING' : 'PASSED']);
  const overall = strongestOverall([raw.overall, textOverall, imageOverall, findingOverall]);
  return {
    status: context.status || 'SUCCESS',
    overall,
    summary: cleanText(raw.summary || (overall === 'PASSED' ? 'AI 未发现明确风险' : overall === 'WARNING' ? 'AI 发现需要人工核对的风险' : 'AI 发现阻断发布的明确风险'), 800),
    findings,
    textReview: { overall: textOverall, summary: cleanText(raw.textReview?.summary || '已审核标题、正文和内容来源', 500) },
    imageReview: { overall: imageOverall, summary: cleanText(raw.imageReview?.summary || `已审核${context.sourceType === 'video' ? '视频代表帧' : '图片画面'}`, 500), checkedFrames: Number(context.frameCount || raw.imageReview?.checkedFrames || 0) },
    model: cleanText(context.model || raw.model || '', 120),
    source: context.source || 'qwen-multimodal',
    ruleVersion: AI_REVIEW_RULE_VERSION,
    materialSha256: String(context.materialSha256 || '').toLowerCase(),
    inputHash: String(context.inputHash || ''),
    sourceType: context.sourceType || '',
    frameCount: Number(context.frameCount || 0),
    transmittedBytes: Number(context.transmittedBytes || 0),
    originalUploaded: false,
    checkedAt: context.checkedAt || new Date().toISOString(),
    elapsedMs: Number(context.elapsedMs || 0),
    usage: context.usage || null,
    cached: context.cached === true
  };
}

export function buildMockAiReview({ title = '', body = '', contentOrigin = '', materialSha256 = '', sourceType = 'image', frameCount = 1 } = {}) {
  const local = reviewPublishContent({ title, body });
  return normalizeAiReviewResult({
    overall: local.overall,
    summary: local.overall === 'PASSED' ? '模拟 AI 审核通过' : '模拟 AI 审核发现内容风险',
    findings: local.findings,
    textReview: { overall: local.overall, summary: '已使用本地安全规则模拟审核标题和正文' },
    imageReview: { overall: 'PASSED', summary: '模拟模式下素材画面默认通过', checkedFrames: frameCount }
  }, {
    localOverall: local.overall,
    materialSha256,
    inputHash: buildAiReviewInputHash({ title, body, contentOrigin, materialSha256 }),
    sourceType,
    frameCount,
    model: 'mock-ai-multimodal-reviewer',
    source: 'mock-ai-multimodal'
  });
}

export function buildFailedAiReview({ title = '', body = '', contentOrigin = '', materialSha256 = '', sourceType = '', model = '', message = 'AI 审核失败', elapsedMs = 0 } = {}) {
  const inputHash = buildAiReviewInputHash({ title, body, contentOrigin, materialSha256 });
  return {
    status: 'FAILED', overall: 'BLOCKED', summary: message,
    findings: [{ code: 'AI_REVIEW_FAILED', level: 'BLOCK', field: 'system', message }],
    textReview: { overall: 'BLOCKED', summary: 'AI 文案审核未完成' },
    imageReview: { overall: 'BLOCKED', summary: 'AI 图片/视频画面审核未完成', checkedFrames: 0 },
    model, source: 'qwen-multimodal', ruleVersion: AI_REVIEW_RULE_VERSION,
    materialSha256: String(materialSha256 || '').toLowerCase(), inputHash, sourceType,
    frameCount: 0, transmittedBytes: 0, originalUploaded: false,
    checkedAt: new Date().toISOString(), elapsedMs, usage: null, cached: false
  };
}

export function validateAiReviewApproval(review, { title = '', body = '', contentOrigin = '', materialSha256 = '', confirmed = false, maxAgeMs = 24 * 60 * 60 * 1000 } = {}) {
  if (!review || typeof review !== 'object') return { ok: false, message: '缺少 AI 内容与图片审核结果' };
  if (review.status !== 'SUCCESS') return { ok: false, message: 'AI 内容与图片审核未成功完成，请重新审核' };
  if (review.ruleVersion !== AI_REVIEW_RULE_VERSION) return { ok: false, message: 'AI 审核规则版本已变化，请重新审核' };
  const expectedHash = buildAiReviewInputHash({ title, body, contentOrigin, materialSha256 });
  if (!review.inputHash || review.inputHash !== expectedHash) return { ok: false, message: '文案、内容来源或素材已变化，请重新执行 AI 审核' };
  if (String(review.materialSha256 || '').toLowerCase() !== String(materialSha256 || '').toLowerCase()) return { ok: false, message: '素材文件已变化，请重新执行 AI 图片审核' };
  const checkedAt = Date.parse(review.checkedAt || '');
  if (!Number.isFinite(checkedAt)) return { ok: false, message: 'AI 审核时间无效，请重新审核' };
  if (Date.now() - checkedAt > maxAgeMs || checkedAt - Date.now() > 5 * 60 * 1000) return { ok: false, message: 'AI 审核结果已过期，请重新审核' };
  if (review.overall === 'BLOCKED') return { ok: false, message: 'AI 审核存在阻断项，不能发布' };
  if (review.overall === 'WARNING' && confirmed !== true) return { ok: false, message: 'AI 审核存在警告，请人工核对后继续' };
  if (!validOverall.has(review.overall)) return { ok: false, message: 'AI 审核结果无效，请重新审核' };
  return { ok: true };
}
