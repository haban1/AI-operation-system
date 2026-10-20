import { rows } from '../db.js';
import { allowedKnowledgeCategoriesForPlatform } from './knowledge-category.js';
import { applySemanticRules } from './knowledge-alias.js';

export function normalizeText(value = '') {
  return applySemanticRules(String(value)).toLowerCase()
    .replace(/(?:能|可以|可不可以|能不能|能否|是否能|是否可以)?(?:带|携带)(?:孩子|小孩|儿童|小朋友|宝宝|娃)/g, '是否可以带孩子')
    .replace(/[\s\p{P}\p{S}]+/gu, '')
    .replace(/几点上班|几点开门|什么时候上班|上班时间|营业时间/g, '办公时间')
    .replace(/在哪里|在哪儿|怎么去|具体位置/g, '地址')
    .replace(/如何报名|怎么报名|我要报名/g, '活动报名');
}

function bigrams(text) {
  const normalized = normalizeText(text);
  if (normalized.length < 2) return normalized ? new Set([normalized]) : new Set();
  const result = new Set();
  for (let i = 0; i < normalized.length - 1; i += 1) result.add(normalized.slice(i, i + 2));
  return result;
}

function dice(a, b) {
  if (!a.size || !b.size) return 0;
  let overlap = 0;
  for (const item of a) if (b.has(item)) overlap += 1;
  return (2 * overlap) / (a.size + b.size);
}

function scoreAlias(query, aliasText) {
  const q = normalizeText(query);
  const alias = normalizeText(aliasText);
  if (!q || !alias) return 0;
  if (q === alias) return 0.995;
  return dice(bigrams(q), bigrams(alias)) * 0.98;
}

export function scoreKnowledge(query, item) {
  const q = normalizeText(query);
  const question = normalizeText(item.question);
  const answer = normalizeText(item.answer);
  const keywords = String(item.keywords || '').split(/[,，;；\s]+/).map(normalizeText).filter(Boolean);
  const aliases = Array.isArray(item.aliases) ? item.aliases : [];
  if (!q) return 0;
  if (q === question) return 1;
  let aliasScore = 0;
  for (const alias of aliases) aliasScore = Math.max(aliasScore, scoreAlias(query, alias.alias_text || alias));
  let keywordScore = 0;
  for (const keyword of keywords) {
    if (q.includes(keyword)) keywordScore = Math.max(keywordScore, Math.min(0.96, 0.66 + keyword.length * 0.04));
  }
  const questionScore = dice(bigrams(q), bigrams(question));
  const answerScore = dice(bigrams(q), bigrams(answer)) * 0.42;
  return Math.max(aliasScore, keywordScore, questionScore, answerScore);
}

export function searchKnowledge(query, limit = 3, platformCode = '', options = {}) {
  const allowedCategories = allowedKnowledgeCategoriesForPlatform(platformCode);
  const allowedCategorySet = new Set(allowedCategories);
  const placeholders = allowedCategories.map(() => '?').join(',');
  const importBatchId = Number(options?.importBatchId || 0);
  const includeDraftBatch = Boolean(options?.includeDraftBatch && importBatchId);
  const statusClause = includeDraftBatch
    ? "(status='PUBLISHED' OR (import_batch_id=? AND status IN ('DRAFT','PENDING_REVIEW','APPROVED')))"
    : "status='PUBLISHED'";
  const params = includeDraftBatch ? [importBatchId, ...allowedCategories] : allowedCategories;
  const requestedIds = new Set((options?.knowledgeIds || []).map(Number).filter(Boolean));
  const excludedIds = new Set((options?.excludedKnowledgeIds || []).map(Number).filter(Boolean));
  const knowledgeItems = rows(`SELECT * FROM knowledge WHERE ${statusClause} AND category IN (${placeholders}) ORDER BY updated_at DESC`, ...params)
    .filter(item => allowedCategorySet.has(String(item.category || '').trim()))
    .filter(item => !requestedIds.size || requestedIds.has(Number(item.id)))
    .filter(item => !excludedIds.has(Number(item.id)));
  const aliasesByKnowledge = new Map();
  if (knowledgeItems.length) {
    const ids = knowledgeItems.map(item => Number(item.id));
    const aliasRows = rows(`SELECT * FROM knowledge_aliases WHERE status='ENABLED'
      AND knowledge_version=(SELECT version FROM knowledge WHERE id=knowledge_aliases.knowledge_id)
      AND knowledge_id IN (${ids.map(() => '?').join(',')})`, ...ids);
    for (const alias of aliasRows) {
      if (!aliasesByKnowledge.has(Number(alias.knowledge_id))) aliasesByKnowledge.set(Number(alias.knowledge_id), []);
      aliasesByKnowledge.get(Number(alias.knowledge_id)).push(alias);
    }
  }
  return knowledgeItems
    .map(item => {
      const aliases = aliasesByKnowledge.get(Number(item.id)) || [];
      const matchedAlias = aliases.map(alias => ({ ...alias, alias_score: scoreAlias(query, alias.alias_text) })).sort((a, b) => b.alias_score - a.alias_score)[0] || null;
      const enriched = { ...item, aliases };
      return {
        ...enriched,
        matched_alias: matchedAlias?.alias_text || null,
        alias_score: Number(matchedAlias?.alias_score || 0),
        score: Number(scoreKnowledge(query, enriched).toFixed(4)),
        scopePriority: 0
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
