import { countUnicodeCharacters, normalizeReplyTextForComparison } from './platform-reply-policy.js';
import { isExplicitHumanRequest } from './conversation-intent.js';

const benignPrivacyPolicyQuestion = /(?:提交|提供|收集|填写)?的?(?:隐私|个人信息).{0,12}(?:会不会|会|是否|能否|怎么|如何|怎样)?(?:被)?(?:保密|保护|保存|使用|删除)/;
export const BUSINESS_RISK_KEYWORDS = Object.freeze({
  SENSITIVE: Object.freeze(['敏感词', '政治敏感', '涉政', '暴力', '色情', '毒品', '赌博', '自杀', '恐怖']),
  COMPLAINT: Object.freeze(['投诉', '举报', '曝光', '差评', '维权']),
  DISPUTE: Object.freeze(['纠纷', '争议', '冲突', '赔偿', '退款', '责任认定']),
  PRIVACY: Object.freeze(['身份证', '手机号', '住址', '隐私', '个人信息', '病历', '银行卡']),
  LEGAL: Object.freeze(['法律', '律师', '起诉', '法院', '违法', '行政处罚']),
  POLICY: Object.freeze(['政策解释', '政策依据', '资格认定', '官方认定'])
});

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const riskRules = Object.entries(BUSINESS_RISK_KEYWORDS)
  .map(([code, keywords]) => [code, new RegExp(keywords.map(escapeRegExp).join('|'))]);

export function detectRisk(content) {
  const text = String(content || '');
  if (isExplicitHumanRequest(text)) return { risk: true, code: 'EXPLICIT_HUMAN', reason: '用户明确要求人工处理' };
  for (const [code, pattern] of riskRules) {
    if (!pattern.test(text)) continue;
    if (code === 'PRIVACY' && benignPrivacyPolicyQuestion.test(text)) continue;
    return { risk: true, code, reason: `命中风险规则：${code}` };
  }
  return { risk: false, code: null, reason: null };
}

function decodeReplyEntities(value) {
  return String(value || '')
    .replace(/&#(?:10|x0*a);?/gi, '\n')
    .replace(/&#(?:13|x0*d);?/gi, '\n')
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

function normalizeReplyPart(value) {
  return normalizeReplyTextForComparison(decodeReplyEntities(value)).replace(/\s+/g, '');
}

function addedReplyText(normalizedReply, normalizedKnowledge) {
  const index = normalizedReply.indexOf(normalizedKnowledge);
  if (index < 0) return normalizedReply;
  const before = normalizedReply.slice(0, index);
  const after = normalizedReply.slice(index + normalizedKnowledge.length);
  return [before, after].filter(Boolean).join('\n');
}

function normalizeProtectedFact(value) {
  return String(value || '')
    .normalize('NFC')
    .toLocaleLowerCase('zh-CN')
    .replace(/[“”"'‘’\s，,。；;：:（）()【】\[\]]+/gu, '')
    .replace(/[—–－~～]/gu, '-')
    .trim();
}

/**
 * 数字、时间、金额、联系方式、网址、明确口令等属于不可自由改写的事实锚点。
 * 语义完整性由在线事实核验器判断；这里再做一层确定性的硬约束。
 */
export function extractProtectedFacts(value = '') {
  const text = decodeReplyEntities(value).normalize('NFC');
  const patterns = [
    /https?:\/\/[^\s，。；;]+/giu,
    /(?:\+?86[-\s]?)?1[3-9]\d{9}/gu,
    /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu,
    /\d{4}[年\-/.]\d{1,2}(?:[月\-/.]\d{1,2}日?)?/gu,
    /\d{1,2}月\d{1,2}日/gu,
    /(?:上午|下午|晚上|早上|中午)?\s*\d{1,2}[：:]\d{2}(?:\s*[-—–至到~～]\s*\d{1,2}[：:]\d{2})?/gu,
    /(?:¥|￥)\s*\d+(?:\.\d+)?|\d+(?:\.\d+)?\s*(?:元|块钱|人民幣|人民币)/gu,
    /\d+(?:\.\d+)?\s*(?:%|％|小时|小時|分钟|分鐘|天|日|周|个月|個月|年|岁|歲|人|名|个|個|份|次|公里|米|件|张|張|位)/gu,
    /周[一二三四五六日天](?:\s*[-—–至到~～]\s*周[一二三四五六日天])?/gu,
    /[“"]([^“”"\n]{1,40})[”"]/gu
  ];
  const facts = new Set();
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const normalized = normalizeProtectedFact(match[1] || match[0]);
      if (normalized) facts.add(normalized);
    }
  }
  return [...facts];
}

function validateProtectedFacts(reply, groundingText) {
  const replyFacts = extractProtectedFacts(reply);
  const groundingFacts = extractProtectedFacts(groundingText);
  const normalizedReply = normalizeProtectedFact(reply);
  const normalizedGrounding = normalizeProtectedFact(groundingText);
  for (const fact of groundingFacts) {
    if (!normalizedReply.includes(fact)) return { ok: false, reason: `生成内容遗漏或改动了受保护事实：${fact}` };
  }
  for (const fact of replyFacts) {
    if (!normalizedGrounding.includes(fact)) return { ok: false, reason: `生成内容新增了知识中没有的事实：${fact}` };
  }
  return { ok: true };
}

function riskCodes(value = '') {
  const text = String(value || '');
  const codes = new Set();
  if (isExplicitHumanRequest(text)) codes.add('EXPLICIT_HUMAN');
  for (const [code, pattern] of riskRules) {
    if (!pattern.test(text)) continue;
    if (code === 'PRIVACY' && benignPrivacyPolicyQuestion.test(text)) continue;
    codes.add(code);
  }
  return codes;
}

function validateNoUnsupportedRisk(reply, groundingText) {
  const groundingCodes = riskCodes(groundingText);
  for (const code of riskCodes(reply)) {
    if (!groundingCodes.has(code)) return { ok: false, reason: `生成内容新增了未经知识支持的风险信息：${code}` };
  }
  return { ok: true };
}

export function validateMultiReply(text, knowledgeAnswers = [], { maxLength = 500, requiredParts = [], groundingVerified = false } = {}) {
  const value = String(text || '').trim().normalize('NFC');
  if (!value || countUnicodeCharacters(value) > maxLength) return { ok: false, reason: `回复为空或超过 ${maxLength} 个字符` };
  const answers = knowledgeAnswers.map(normalizeReplyPart).filter(Boolean);
  const required = requiredParts.map(normalizeReplyPart).filter(Boolean);
  if (!answers.length) return { ok: false, reason: '缺少知识依据' };
  if (groundingVerified) {
    const groundingText = [...knowledgeAnswers, ...requiredParts].filter(Boolean).join('\n');
    const facts = validateProtectedFacts(value, groundingText);
    if (!facts.ok) return facts;
    return validateNoUnsupportedRisk(value, groundingText);
  }
  let addedText = normalizeReplyPart(value);
  for (const answer of answers) {
    const index = addedText.indexOf(answer);
    if (index < 0) return { ok: false, reason: '生成内容未完整包含全部知识库标准答案' };
    addedText = addedText.slice(0, index) + addedText.slice(index + answer.length);
  }
  for (const part of required) {
    const index = addedText.indexOf(part);
    if (index < 0) return { ok: false, reason: '生成内容未完整包含待确认话术' };
    addedText = addedText.slice(0, index) + addedText.slice(index + part.length);
  }
  if (detectRisk(addedText).risk) return { ok: false, reason: '生成内容命中风险规则' };
  return { ok: true };
}

export function validateReply(text, knowledgeAnswer, { maxLength = 500, groundingVerified = false } = {}) {
  const value = String(text || '').trim().normalize('NFC');
  if (!value || countUnicodeCharacters(value) > maxLength) return { ok: false, reason: `回复为空或超过 ${maxLength} 个字符` };
  if (!knowledgeAnswer) return { ok: false, reason: '缺少知识依据' };
  if (groundingVerified) {
    const facts = validateProtectedFacts(value, knowledgeAnswer);
    if (!facts.ok) return facts;
    return validateNoUnsupportedRisk(value, knowledgeAnswer);
  }
  const normalizedReply = normalizeReplyPart(value);
  const normalizedKnowledge = normalizeReplyPart(knowledgeAnswer);
  const longKnowledge = normalizedKnowledge.length > 500;
  const groundedExcerpt = longKnowledge
    && normalizedReply.length >= Math.min(80, normalizedKnowledge.length)
    && normalizedKnowledge.includes(normalizedReply);
  if (!normalizedReply.includes(normalizedKnowledge) && !groundedExcerpt) {
    return { ok: false, reason: longKnowledge ? '生成内容不是知识库长答案中的原文片段' : '生成内容未完整包含知识库标准答案' };
  }
  const addedText = groundedExcerpt ? '' : addedReplyText(normalizedReply, normalizedKnowledge);
  if (detectRisk(addedText).risk) return { ok: false, reason: '生成内容命中风险规则' };
  return { ok: true };
}
