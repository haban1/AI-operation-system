import crypto from 'node:crypto';
import { rows } from '../db.js';
import { generateKnowledgeMetadataSuggestions } from './qwen.js';
import {
  DEFAULT_KNOWLEDGE_SUBCATEGORY,
  PUBLIC_KNOWLEDGE_CATEGORY,
  SYSTEM_KNOWLEDGE_CATEGORIES,
  classifyKnowledgeCategory,
  knowledgeCategoryForPlatform,
  validateKnowledgeCategoryName,
  validateKnowledgeSubcategoryName
} from './knowledge-category.js';

const BROAD_KEYWORDS = new Set([
  '活动', '资料', '报名', '加入', '入驻', '可以', '可不可以', '怎么', '如何', '电话', '地址',
  '时间', '费用', '收费', '咨询', '问题', '业务', '服务', '请问', '你好', '在吗', '了解', '办理'
]);

function cleanText(value = '') {
  return String(value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();
}

function keywordKey(value = '') {
  return cleanText(value).toLowerCase().replace(/[\s，,。！？?!；;：:、|/\\()（）【】\[\]“”‘’"']/g, '');
}

function confidence(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : fallback;
}

export function knowledgeMetadataFingerprint({ question = '', answer = '', originalMessage = '', platformCode = '' } = {}) {
  return crypto.createHash('sha256').update(JSON.stringify({
    question: cleanText(question),
    answer: cleanText(answer),
    originalMessage: cleanText(originalMessage),
    platformCode: cleanText(platformCode)
  })).digest('hex');
}

export function listExistingKnowledgeSubcategories(allowedCategories = SYSTEM_KNOWLEDGE_CATEGORIES) {
  const allowed = new Set((allowedCategories || []).filter(item => SYSTEM_KNOWLEDGE_CATEGORIES.includes(item)));
  if (!allowed.size) return [];
  return rows(`SELECT category,subcategory,MAX(updated_at) AS last_used_at FROM knowledge
    WHERE status!='DISABLED' AND subcategory IS NOT NULL AND TRIM(subcategory)!=''
    GROUP BY category,subcategory ORDER BY last_used_at DESC,id DESC`)
    .filter(item => allowed.has(item.category))
    .map(item => ({ category: item.category, name: item.subcategory, lastUsedAt: item.last_used_at }));
}

function existingKeywordOwners() {
  const owners = new Map();
  for (const item of rows("SELECT id,question,category,keywords FROM knowledge WHERE status='PUBLISHED'")) {
    for (const keyword of String(item.keywords || '').split(/[,，;；、|\n]+/).map(cleanText).filter(Boolean)) {
      const key = keywordKey(keyword);
      if (!key) continue;
      if (!owners.has(key)) owners.set(key, []);
      owners.get(key).push({ id: Number(item.id), question: item.question, category: item.category });
    }
  }
  return owners;
}

function rawKeywordItems(raw) {
  const values = Array.isArray(raw) ? raw : [];
  return values.map(item => typeof item === 'string' ? { text: item } : (item || {}));
}

function fallbackResult({ question, answer, preferredCategory, allowedCategories, existingSubcategories }) {
  const classified = classifyKnowledgeCategory(question, answer);
  const category = allowedCategories.includes(preferredCategory)
    ? preferredCategory
    : allowedCategories.includes(classified.category)
      ? classified.category
      : allowedCategories[0] || PUBLIC_KNOWLEDGE_CATEGORY;
  const existing = existingSubcategories.find(item => item.category === category && item.name === classified.suggestedSubcategory);
  return {
    keywords: (classified.suggestedKeywords || []).map(text => ({ text, confidence: 0.62, reason: '千问不可用时由本地规则提供兜底建议' })),
    category: { name: category, confidence: 0.62, reason: preferredCategory ? '千问不可用，保留消息来源平台的安全默认大类' : '千问不可用，使用本地规则安全默认大类' },
    subcategory: { name: classified.suggestedSubcategory || DEFAULT_KNOWLEDGE_SUBCATEGORY, confidence: 0.62, existing: Boolean(existing), reason: '千问不可用时由本地规则提供兜底建议' },
    model: 'local-rule-fallback',
    usage: null
  };
}

function normalizeCategory(raw, { allowedCategories, preferredCategory, fallback }) {
  const name = cleanText(raw?.name || raw);
  const valid = validateKnowledgeCategoryName(name);
  if (valid.ok && allowedCategories.includes(valid.name)) {
    return { name: valid.name, confidence: confidence(raw?.confidence, 0.75), reason: cleanText(raw?.reason) || '千问根据问题、答案和来源范围推荐', source: 'AI' };
  }
  const safe = allowedCategories.includes(preferredCategory) ? preferredCategory : fallback.name;
  return { name: safe, confidence: Math.min(0.65, confidence(fallback.confidence, 0.62)), reason: name ? `千问返回的大类“${name}”不在允许范围，已使用安全默认值` : fallback.reason, source: 'RULE_FALLBACK' };
}

function normalizeSubcategory(raw, { category, fallback, existingSubcategories }) {
  const proposed = cleanText(raw?.name || raw) || fallback.name || DEFAULT_KNOWLEDGE_SUBCATEGORY;
  const valid = validateKnowledgeSubcategoryName(proposed);
  const name = valid.ok ? valid.name : (fallback.name || DEFAULT_KNOWLEDGE_SUBCATEGORY);
  const exact = existingSubcategories.find(item => item.category === category && item.name === name);
  const similar = existingSubcategories.find(item => item.category === category && (item.name.includes(name) || name.includes(item.name)));
  const finalName = exact?.name || similar?.name || name;
  return {
    name: finalName,
    confidence: valid.ok ? confidence(raw?.confidence, 0.72) : confidence(fallback.confidence, 0.62),
    existing: Boolean(exact || similar),
    reason: cleanText(raw?.reason) || fallback.reason || '根据问题和答案的业务主题推荐',
    source: valid.ok ? 'AI' : 'RULE_FALLBACK'
  };
}

function normalizeKeywords(raw, fallbackKeywords = []) {
  const owners = existingKeywordOwners();
  const candidates = [...rawKeywordItems(raw), ...rawKeywordItems(fallbackKeywords).map(item => ({ ...item, fallback: true }))];
  const seen = new Set();
  const result = [];
  for (const item of candidates) {
    const text = cleanText(item.text).replace(/^[,，;；、|]+|[,，;；、|]+$/g, '');
    const key = keywordKey(text);
    if (!text || !key || seen.has(key) || text.length > 30) continue;
    seen.add(key);
    const tooShort = Array.from(key).length < 2;
    const broad = BROAD_KEYWORDS.has(key);
    const conflicts = owners.get(key) || [];
    const conflict = conflicts.length > 0;
    const source = item.fallback ? 'RULE_FALLBACK' : 'AI';
    const score = confidence(item.confidence, item.fallback ? 0.62 : 0.75);
    const selectable = !tooShort && !broad;
    result.push({
      text,
      confidence: score,
      reason: cleanText(item.reason) || (item.fallback ? '本地规则兜底推荐' : '千问根据完整业务意图推荐'),
      source,
      selectable,
      conflict,
      conflictKnowledge: conflicts.slice(0, 5),
      selected: selectable && !conflict && score >= 0.7,
      message: tooShort ? '关键词过短，不能启用' : broad ? '词义过宽，容易误触发，不能启用' : conflict ? `已被其他 ${conflicts.length} 条知识使用，默认不勾选` : ''
    });
    if (result.length >= 12) break;
  }
  return result;
}

export async function suggestKnowledgeMetadata({
  question,
  answer,
  originalMessage = '',
  platformCode = '',
  allowedCategories,
  preferredCategory,
  taskId = null
} = {}) {
  const cleanQuestion = cleanText(question);
  const cleanAnswer = cleanText(answer);
  if (!cleanQuestion) throw new Error('请先填写标准问题');
  if (!cleanAnswer) throw new Error('请先填写标准答案');
  const platformCategory = knowledgeCategoryForPlatform(platformCode);
  const allowed = [...new Set((allowedCategories?.length ? allowedCategories : SYSTEM_KNOWLEDGE_CATEGORIES)
    .map(cleanText).filter(item => SYSTEM_KNOWLEDGE_CATEGORIES.includes(item)))];
  if (!allowed.length) allowed.push(PUBLIC_KNOWLEDGE_CATEGORY);
  const preferred = allowed.includes(preferredCategory) ? preferredCategory : (allowed.includes(platformCategory) ? platformCategory : allowed[0]);
  const existingSubcategories = listExistingKnowledgeSubcategories(allowed);
  const fallback = fallbackResult({ question: cleanQuestion, answer: cleanAnswer, preferredCategory: preferred, allowedCategories: allowed, existingSubcategories });
  let generated;
  let error = null;
  try {
    generated = await generateKnowledgeMetadataSuggestions({
      question: cleanQuestion,
      answer: cleanAnswer,
      originalMessage,
      platformCode,
      allowedCategories: allowed,
      preferredCategory: preferred,
      existingSubcategories: existingSubcategories.map(item => item.name),
      taskId
    });
  } catch (caught) {
    error = String(caught.message || caught);
    generated = fallback;
  }
  const category = normalizeCategory(generated.category, { allowedCategories: allowed, preferredCategory: preferred, fallback: fallback.category });
  const subcategory = normalizeSubcategory(generated.subcategory, { category: category.name, fallback: fallback.subcategory, existingSubcategories });
  const keywords = normalizeKeywords(generated.keywords, fallback.keywords);
  return {
    fingerprint: knowledgeMetadataFingerprint({ question: cleanQuestion, answer: cleanAnswer, originalMessage, platformCode }),
    keywords,
    selectedKeywords: keywords.filter(item => item.selected).map(item => item.text),
    category,
    subcategory,
    allowedCategories: allowed,
    model: generated.model || fallback.model,
    usage: generated.usage || null,
    source: error ? 'RULE_FALLBACK' : 'AI',
    warning: error ? `千问推荐失败，已保留本地规则结果：${error}` : null
  };
}
