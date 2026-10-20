import { getAiSettings, redactAiSecrets } from './settings.js';
import { recordAiCall } from './ai-usage.js';

const CATEGORIES = new Set(['LOGIN_EXPIRED','VERIFY_REQUIRED','NETWORK_ERROR','BROWSER_CRASH','MATERIAL_INVALID','CONTENT_REJECTED','RATE_LIMITED','PERMISSION_DENIED','PLATFORM_ERROR','LOCATOR_MISMATCH','PAGE_CHANGED','TIMEOUT','RESULT_UNCERTAIN','SYSTEM_ERROR','UNKNOWN']);

function textOf(context, evidence) {
  const pageText = (Array.isArray(evidence?.pages) ? evidence.pages : []).flatMap(page => [
    page?.name,
    page?.title,
    page?.message,
    page?.error,
    ...(Array.isArray(page?.keyText) ? page.keyText : []),
    ...(Array.isArray(page?.controls) ? page.controls : [])
  ]);
  return [context?.issue?.title, context?.issue?.detail, context?.originalResult?.message, evidence?.message, evidence?.code, ...pageText]
    .filter(Boolean).join('\n').slice(0, 30000);
}

export function deterministicDiagnosis(context, evidence = {}) {
  const text = textOf(context, evidence);
  const lower = text.toLowerCase();
  let category = 'UNKNOWN';
  let failedStage = evidence.failedStage || context?.originalResult?.stage || 'UNKNOWN';
  if (/结果不明确|待确认|needs_confirmation|unconfirmed|无法确认|回执不可信/.test(lower)) category = 'RESULT_UNCERTAIN';
  else if (/登录过期|未登录|login expired|登录失效/.test(lower)) category = 'LOGIN_EXPIRED';
  else if (/验证码|扫码|人脸|verify_required|安全验证/.test(lower)) category = 'VERIFY_REQUIRED';
  else if (/素材不存在|素材无效|格式|分辨率|编码|material/.test(lower)) category = 'MATERIAL_INVALID';
  else if (/权限|permission|无权/.test(lower)) category = 'PERMISSION_DENIED';
  else if (/频繁|限流|rate.?limit|too many/.test(lower)) category = 'RATE_LIMITED';
  else if (/拒绝|违规|审核失败|rejected|content[ _-]?(?:rejected|violation|blocked)/.test(lower)) category = 'CONTENT_REJECTED';
  else if (/selector|locator|定位|按钮.*未找到|未匹配/.test(lower)) category = 'LOCATOR_MISMATCH';
  else if (/页面变化|page changed|结构变化/.test(lower)) category = 'PAGE_CHANGED';
  else if (/network|fetch failed|连接|网络/.test(lower)) category = 'NETWORK_ERROR';
  else if (/timeout|超时/.test(lower)) category = 'TIMEOUT';
  else if (/browser|chrome|浏览器.*崩溃/.test(lower)) category = 'BROWSER_CRASH';
  else if (/database|sqlite|磁盘|agent/.test(lower)) category = 'SYSTEM_ERROR';
  else if (/平台|publish|reply|collect/.test(lower)) category = 'PLATFORM_ERROR';
  const pages = Array.isArray(evidence.pages) ? evidence.pages : [];
  const missingSelectors = pages.flatMap(page => Object.entries(page.selectorHits || {}).filter(([, hit]) => !hit).map(([selector]) => ({ page: page.name || page.key, selector })));
  if (missingSelectors.length && ['UNKNOWN','PLATFORM_ERROR'].includes(category)) category = 'LOCATOR_MISMATCH';
  const resultUncertain = category === 'RESULT_UNCERTAIN' || context?.issue?.status === 'NEEDS_CONFIRMATION' || context?.originalJob?.status === 'NEEDS_CONFIRMATION';
  const safeToRetry = !resultUncertain && ['LOGIN_EXPIRED','VERIFY_REQUIRED','NETWORK_ERROR','BROWSER_CRASH','MATERIAL_INVALID','LOCATOR_MISMATCH','PAGE_CHANGED','TIMEOUT','SYSTEM_ERROR','UNKNOWN'].includes(category) && context?.originalResult?.submitAttempted !== true && context?.originalResult?.sendAttempted !== true;
  const pageChanged = category === 'PAGE_CHANGED' || (missingSelectors.length >= 3 && pages.length > 0);
  const recommendations = {
    LOGIN_EXPIRED: ['重新打开该账号登录页并完成人工登录', '登录检查正常后再由人工决定是否创建新任务'],
    VERIFY_REQUIRED: ['在原平台完成人工验证码、扫码或安全验证', '验证完成前不要自动重试'],
    LOCATOR_MISMATCH: ['技术人员核对失败阶段的页面 DOM 和定位器', '在隔离环境验证新定位器后再发布版本'],
    PAGE_CHANGED: ['技术人员对比当前页面结构与历史适配流程', '仅在隔离环境完成适配验证'],
    RESULT_UNCERTAIN: ['人工到原平台核对实际发布或回复结果', '确认未执行前禁止重新提交'],
    MATERIAL_INVALID: ['检查素材路径、格式、尺寸、时长和编码', '修正素材后显式创建新的重试任务'],
    NETWORK_ERROR: ['检查本机网络、代理和平台可访问性', '确认未发生写操作后再决定是否重试'],
    UNKNOWN: ['结合截图和证据日志人工定位', '必要时交由技术人员进行隔离复现']
  }[category] || ['根据证据核对失败阶段', '由人工决定后续处理，系统不会自动重试'];
  const evidenceList = [];
  if (context?.originalJob) evidenceList.push({ type: 'ORIGINAL_JOB', jobId: context.originalJob.id, status: context.originalJob.status, jobType: context.originalJob.job_type });
  if (context?.originalResult) evidenceList.push({ type: 'ORIGINAL_RESULT', stage: context.originalResult.stage || null, code: context.originalResult.code || null, message: context.originalResult.message || null, submitAttempted: context.originalResult.submitAttempted, sendAttempted: context.originalResult.sendAttempted });
  for (const page of pages) evidenceList.push({ type: 'PAGE', name: page.name || page.key, url: page.url, title: page.title, screenshotPath: page.screenshotPath, missingSelectors: Object.entries(page.selectorHits || {}).filter(([, hit]) => !hit).map(([selector]) => selector) });
  if (evidence.message) evidenceList.push({ type: 'AGENT_MESSAGE', message: evidence.message, code: evidence.code || null });
  const summary = ({ LOGIN_EXPIRED: '账号登录状态已失效', VERIFY_REQUIRED: '平台要求人工安全验证', NETWORK_ERROR: '网络或平台连接异常', BROWSER_CRASH: '浏览器执行环境异常', MATERIAL_INVALID: '发布素材不符合执行条件', CONTENT_REJECTED: '内容被平台拒绝或审核失败', RATE_LIMITED: '平台触发频率限制', PERMISSION_DENIED: '账号权限不足', PLATFORM_ERROR: '平台执行流程返回异常', LOCATOR_MISMATCH: '页面控件定位器未匹配', PAGE_CHANGED: '页面结构疑似发生变化', TIMEOUT: '执行阶段超时', RESULT_UNCERTAIN: '写操作结果不明确，必须人工确认', SYSTEM_ERROR: '本地系统或 Agent 异常', UNKNOWN: '现有证据不足，暂无法确定根因' })[category];
  return { category, failedStage, confidence: category === 'UNKNOWN' ? 0.35 : missingSelectors.length ? 0.84 : 0.72, pageChanged, safeToRetry, suggestedBlockScope: context?.issue?.block_scope || (context?.platformCode ? 'PLATFORM_FEATURE' : 'TASK'), summary, evidence: evidenceList, recommendations };
}

function normalizeAiResult(value, fallback) {
  if (!value || typeof value !== 'object') return fallback;
  const category = CATEGORIES.has(value.category) ? value.category : fallback.category;
  return { ...fallback, category, failedStage: String(value.failedStage || fallback.failedStage).slice(0, 100), confidence: Math.max(0, Math.min(1, Number(value.confidence ?? fallback.confidence))), pageChanged: value.pageChanged === true || fallback.pageChanged, safeToRetry: fallback.safeToRetry && value.safeToRetry === true, summary: String(value.summary || fallback.summary).slice(0, 1000), recommendations: Array.isArray(value.recommendations) ? value.recommendations.map(item => String(item).slice(0, 500)).slice(0, 10) : fallback.recommendations };
}

export async function diagnoseIssue(context, evidence = {}) {
  const fallback = deterministicDiagnosis(context, evidence);
  const settings = getAiSettings();
  const startedAt = Date.now();
  if (settings.mode === 'mock' || !settings.apiKey) {
    recordAiCall({ taskType: 'ISSUE_DIAGNOSIS', taskId: String(context?.issue?.id || ''), sourceModule: 'issue-diagnosis', mode: settings.mode, model: settings.mode === 'mock' ? 'mock-diagnostic-rules' : settings.model, status: 'SUCCESS', durationMs: Date.now() - startedAt });
    return fallback;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const compact = { issue: { source: context.issue?.source, category: context.issue?.category, title: context.issue?.title, detail: context.issue?.detail, relatedType: context.issue?.related_type }, originalResult: context.originalResult || null, agentEvidence: evidence };
    const response = await fetch(`${settings.baseUrl}/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${settings.apiKey}` }, body: JSON.stringify({ model: settings.model, temperature: 0, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: '你是RPA故障只读诊断器。只输出JSON，字段为category,failedStage,confidence,pageChanged,safeToRetry,summary,recommendations。不得建议自动重发；写操作结果不明确时safeToRetry必须为false。' }, { role: 'user', content: JSON.stringify(compact).slice(0, 24000) }] }), signal: controller.signal });
    if (!response.ok) throw new Error(`AI API 返回 ${response.status}`);
    const data = await response.json();
    const parsed = JSON.parse(data?.choices?.[0]?.message?.content || '{}');
    const result = normalizeAiResult(parsed, fallback);
    recordAiCall({ taskType: 'ISSUE_DIAGNOSIS', taskId: String(context.issue?.id || ''), sourceModule: 'issue-diagnosis', mode: settings.mode, model: data.model || settings.model, status: 'SUCCESS', usage: data.usage || null, durationMs: Date.now() - startedAt });
    return result;
  } catch (error) {
    recordAiCall({ taskType: 'ISSUE_DIAGNOSIS', taskId: String(context.issue?.id || ''), sourceModule: 'issue-diagnosis', mode: settings.mode, model: settings.model, status: 'FAILED', durationMs: Date.now() - startedAt, errorCode: error.name === 'AbortError' ? 'AI_TIMEOUT' : 'AI_REQUEST_FAILED', errorMessage: redactAiSecrets(error.message) });
    return { ...fallback, recommendations: [...fallback.recommendations, '在线 AI 总结暂不可用，本次结论由本地安全规则生成'] };
  } finally { clearTimeout(timer); }
}


