import { now, row, rows, run } from '../db.js';
import { redactAiSecrets } from './settings.js';

const DEFAULT_TIMEZONE_OFFSET_MINUTES = 8 * 60;
const DEFAULT_TREND_DAYS = 7;
const TOKEN_PRICE_SOURCE_URL = 'https://help.aliyun.com/zh/model-studio/model-pricing';

// 阿里云百炼中国内地（北京）qwen-plus 阶梯价，单位：人民币元 / 百万 Token。
// qwen3.7-plus 是本项目实际返回的模型名，按 qwen-plus 对应档位计价。
const QWEN_PLUS_PRICE_TIERS = [
  { maxInputTokens: 32_000, inputPerMillion: 1.6, outputPerMillion: 6.4, label: '≤32K' },
  { maxInputTokens: 128_000, inputPerMillion: 2.4, outputPerMillion: 9.6, label: '32K–128K' },
  { maxInputTokens: 256_000, inputPerMillion: 3.2, outputPerMillion: 12.8, label: '128K–256K' },
  { maxInputTokens: 1_000_000, inputPerMillion: 6.4, outputPerMillion: 25.6, label: '256K–1M' }
];

function usageNumbers(usage = {}) {
  const input = Number(usage.prompt_tokens ?? usage.input_tokens ?? 0) || 0;
  const output = Number(usage.completion_tokens ?? usage.output_tokens ?? 0) || 0;
  const total = Number(usage.total_tokens ?? input + output) || 0;
  return { input, output, total };
}

function timezoneOffsetMinutes(value = DEFAULT_TIMEZONE_OFFSET_MINUTES) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(-12 * 60, Math.min(14 * 60, Math.round(parsed))) : DEFAULT_TIMEZONE_OFFSET_MINUTES;
}

function localDateKey(date, offsetMinutes = DEFAULT_TIMEZONE_OFFSET_MINUTES) {
  return new Date(date.getTime() + timezoneOffsetMinutes(offsetMinutes) * 60_000).toISOString().slice(0, 10);
}

function utcBoundaryForLocalDate(dateKey, offsetMinutes = DEFAULT_TIMEZONE_OFFSET_MINUTES) {
  return new Date(`${dateKey}T00:00:00.000Z`).getTime() - timezoneOffsetMinutes(offsetMinutes) * 60_000;
}

function addUtcDays(dateKey, days) {
  const value = new Date(`${dateKey}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function pricingForModel(model, inputTokens = 0) {
  const normalized = String(model || '').trim().toLowerCase();
  const isQwenPlus = normalized === 'qwen-plus'
    || normalized.startsWith('qwen-plus-')
    || normalized === 'qwen3.7-plus'
    || normalized.startsWith('qwen3.7-plus-');
  if (!isQwenPlus) return null;
  const safeInput = Math.max(0, Number(inputTokens) || 0);
  const tier = QWEN_PLUS_PRICE_TIERS.find(item => safeInput <= item.maxInputTokens) || null;
  return tier ? { ...tier, family: 'qwen-plus', currency: 'CNY', unitTokens: 1_000_000 } : null;
}

export function estimateTokenCost({ model = '', inputTokens = 0, outputTokens = 0 } = {}) {
  const input = Math.max(0, Number(inputTokens) || 0);
  const output = Math.max(0, Number(outputTokens) || 0);
  const normalizedModel = String(model || '').trim().toLowerCase();
  if (normalizedModel === 'qwen3-asr-flash' || normalizedModel.startsWith('qwen3-asr-flash-')) {
    return { priced: false, costCny: 0, pricing: null, billingType: 'duration' };
  }
  const pricing = pricingForModel(model, input);
  if (!pricing) return { priced: false, costCny: 0, pricing: null, billingType: 'unknown' };
  const costCny = (input * pricing.inputPerMillion + output * pricing.outputPerMillion) / pricing.unitTokens;
  return { priced: true, costCny, pricing, billingType: 'token' };
}

function emptyDaily(date) {
  return { date, calls: 0, successes: 0, failures: 0, input_tokens: 0, output_tokens: 0, total_tokens: 0, estimated_cost_cny: 0, priced_calls: 0, unpriced_token_calls: 0 };
}

function summarizeLogs(logs) {
  const summary = {
    calls: logs.length,
    successes: 0,
    failures: 0,
    input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
    average_duration_ms: 0,
    estimated_cost_cny: 0,
    priced_calls: 0,
    unpriced_token_calls: 0,
    unpriced_tokens: 0,
    non_token_billed_calls: 0,
    non_token_billed_tokens: 0
  };
  let durationTotal = 0;
  for (const log of logs) {
    if (log.status === 'SUCCESS') summary.successes += 1;
    else summary.failures += 1;
    const input = Number(log.input_tokens || 0);
    const output = Number(log.output_tokens || 0);
    const total = Number(log.total_tokens || input + output);
    summary.input_tokens += input;
    summary.output_tokens += output;
    summary.total_tokens += total;
    durationTotal += Math.max(0, Number(log.duration_ms || 0));
    const estimate = estimateTokenCost({ model: log.model, inputTokens: input, outputTokens: output });
    if (estimate.priced) {
      summary.priced_calls += 1;
      summary.estimated_cost_cny += estimate.costCny;
    } else if (total > 0 && estimate.billingType === 'duration') {
      summary.non_token_billed_calls += 1;
      summary.non_token_billed_tokens += total;
    } else if (total > 0) {
      summary.unpriced_token_calls += 1;
      summary.unpriced_tokens += total;
    }
  }
  summary.average_duration_ms = logs.length ? Math.round(durationTotal / logs.length) : 0;
  summary.estimated_cost_cny = Number(summary.estimated_cost_cny.toFixed(8));
  return summary;
}

function modelCostBreakdown(logs) {
  const grouped = new Map();
  for (const log of logs) {
    const model = String(log.model || '未记录模型');
    const input = Number(log.input_tokens || 0);
    const output = Number(log.output_tokens || 0);
    const total = Number(log.total_tokens || input + output);
    const estimate = estimateTokenCost({ model, inputTokens: input, outputTokens: output });
    if (!grouped.has(model)) grouped.set(model, { model, calls: 0, input_tokens: 0, output_tokens: 0, total_tokens: 0, estimated_cost_cny: 0, priced: true, billing_type: estimate.billingType, tiers: new Set() });
    const item = grouped.get(model);
    item.calls += 1;
    item.input_tokens += input;
    item.output_tokens += output;
    item.total_tokens += total;
    item.priced = item.priced && (estimate.priced || total === 0);
    if (total > 0 && item.billing_type !== 'token') item.billing_type = estimate.billingType;
    if (estimate.priced) {
      item.estimated_cost_cny += estimate.costCny;
      item.tiers.add(`${estimate.pricing.label}：输入 ¥${estimate.pricing.inputPerMillion}/百万 · 输出 ¥${estimate.pricing.outputPerMillion}/百万`);
    }
  }
  return [...grouped.values()].map(item => ({
    ...item,
    estimated_cost_cny: Number(item.estimated_cost_cny.toFixed(8)),
    price_description: item.billing_type === 'duration' ? '按音频时长计费，不纳入 Token 费用' : [...item.tiers].join('；'),
    tiers: undefined
  })).sort((a, b) => b.estimated_cost_cny - a.estimated_cost_cny || b.total_tokens - a.total_tokens);
}

export function recordAiCall({ taskType = 'OTHER', taskId = null, sourceModule = 'unknown', mode = 'mock', model = '', status = 'SUCCESS', usage = null, durationMs = 0, errorCode = null, errorMessage = null } = {}) {
  const tokens = usageNumbers(usage || {});
  const safeError = errorMessage ? redactAiSecrets(String(errorMessage)).slice(0, 1000) : null;
  const result = run(`INSERT INTO ai_call_logs(task_type,task_id,source_module,mode,model,status,input_tokens,output_tokens,total_tokens,duration_ms,error_code,error_message,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`, String(taskType || 'OTHER').slice(0, 80), taskId == null ? null : String(taskId).slice(0, 100), String(sourceModule || 'unknown').slice(0, 100), String(mode || 'mock').slice(0, 20), String(model || '').slice(0, 100), String(status || 'SUCCESS').slice(0, 30), tokens.input, tokens.output, tokens.total, Math.max(0, Math.round(Number(durationMs) || 0)), errorCode ? String(errorCode).slice(0, 100) : null, safeError, now());
  return row('SELECT * FROM ai_call_logs WHERE id=?', Number(result.lastInsertRowid));
}

export function listAiCallLogs(limit = 100) {
  const safeLimit = Math.max(1, Math.min(300, Number(limit) || 100));
  return rows(`SELECT id,task_type,task_id,source_module,mode,model,status,input_tokens,output_tokens,total_tokens,duration_ms,error_code,error_message,created_at FROM ai_call_logs ORDER BY id DESC LIMIT ?`, safeLimit);
}

export function aiUsageOverview({ days = DEFAULT_TREND_DAYS, timezoneOffset = DEFAULT_TIMEZONE_OFFSET_MINUTES, referenceDate = new Date() } = {}) {
  const safeDays = Math.max(1, Math.min(31, Number(days) || DEFAULT_TREND_DAYS));
  const offset = timezoneOffsetMinutes(timezoneOffset);
  const todayKey = localDateKey(referenceDate, offset);
  const firstKey = addUtcDays(todayKey, -(safeDays - 1));
  const nextDayKey = addUtcDays(todayKey, 1);
  const rangeStart = new Date(utcBoundaryForLocalDate(firstKey, offset)).toISOString();
  const rangeEnd = new Date(utcBoundaryForLocalDate(nextDayKey, offset)).toISOString();
  const logs = rows(`SELECT id,model,status,input_tokens,output_tokens,total_tokens,duration_ms,created_at FROM ai_call_logs WHERE created_at>=? AND created_at<? ORDER BY id`, rangeStart, rangeEnd);
  const dailyMap = new Map();
  for (let index = 0; index < safeDays; index += 1) {
    const date = addUtcDays(firstKey, index);
    dailyMap.set(date, emptyDaily(date));
  }
  for (const log of logs) {
    const key = localDateKey(new Date(log.created_at), offset);
    const item = dailyMap.get(key);
    if (!item) continue;
    item.calls += 1;
    if (log.status === 'SUCCESS') item.successes += 1;
    else item.failures += 1;
    item.input_tokens += Number(log.input_tokens || 0);
    item.output_tokens += Number(log.output_tokens || 0);
    item.total_tokens += Number(log.total_tokens || 0);
    const estimate = estimateTokenCost({ model: log.model, inputTokens: log.input_tokens, outputTokens: log.output_tokens });
    if (estimate.priced) {
      item.priced_calls += 1;
      item.estimated_cost_cny += estimate.costCny;
    } else if (Number(log.total_tokens || 0) > 0) item.unpriced_token_calls += 1;
  }
  const daily = [...dailyMap.values()].map(item => ({ ...item, estimated_cost_cny: Number(item.estimated_cost_cny.toFixed(8)) }));
  const todayLogs = logs.filter(log => localDateKey(new Date(log.created_at), offset) === todayKey);
  return {
    summary: summarizeLogs(todayLogs),
    daily,
    model_costs: modelCostBreakdown(todayLogs),
    pricing: {
      currency: 'CNY',
      region: '阿里云百炼中国内地（北京）',
      checked_at: '2026-08-24',
      source_url: TOKEN_PRICE_SOURCE_URL,
      note: '仅估算按 Token 计费的模型；语音识别等按时长计费的模型不计入 Token 费用。'
    },
    timezone_offset_minutes: offset
  };
}

export function aiUsageSummary() {
  return aiUsageOverview().summary;
}


