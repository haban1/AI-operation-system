import { now, rows, run } from '../db.js';
import { DEFAULT_KNOWLEDGE_SUBCATEGORY, KNOWLEDGE_SUBCATEGORY_CACHE_LIMIT, validateKnowledgeCategoryName, validateKnowledgeSubcategoryName } from './knowledge-category.js';

export function listKnowledgeSubcategoryCache(category) {
  const categoryValidation = validateKnowledgeCategoryName(category);
  if (!categoryValidation.ok) return [];
  return rows(`SELECT subcategory,last_used_at FROM knowledge_subcategory_cache
    WHERE category=? ORDER BY last_used_at DESC, subcategory COLLATE NOCASE LIMIT ?`, categoryValidation.name, KNOWLEDGE_SUBCATEGORY_CACHE_LIMIT);
}

export function touchKnowledgeSubcategory(category, subcategory, stamp = now()) {
  const categoryValidation = validateKnowledgeCategoryName(category);
  if (!categoryValidation.ok) throw new Error(categoryValidation.message);
  const subcategoryValidation = validateKnowledgeSubcategoryName(subcategory);
  if (!subcategoryValidation.ok) throw new Error(subcategoryValidation.message);
  if (subcategoryValidation.name === DEFAULT_KNOWLEDGE_SUBCATEGORY) return;
  run(`INSERT INTO knowledge_subcategory_cache(category,subcategory,last_used_at) VALUES(?,?,?)
    ON CONFLICT(category,subcategory) DO UPDATE SET last_used_at=excluded.last_used_at`, categoryValidation.name, subcategoryValidation.name, stamp);
  run(`DELETE FROM knowledge_subcategory_cache WHERE category=? AND subcategory NOT IN (
    SELECT subcategory FROM knowledge_subcategory_cache WHERE category=? ORDER BY last_used_at DESC, subcategory COLLATE NOCASE LIMIT ?
  )`, categoryValidation.name, categoryValidation.name, KNOWLEDGE_SUBCATEGORY_CACHE_LIMIT);
}

export function removeKnowledgeSubcategoryCache(category, subcategory) {
  run('DELETE FROM knowledge_subcategory_cache WHERE category=? AND subcategory=?', category, subcategory);
}
