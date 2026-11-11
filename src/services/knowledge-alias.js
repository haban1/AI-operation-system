import { rows } from '../db.js';

export function normalizeAliasText(value = '') {
  return String(value || '').normalize('NFC').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '').trim();
}

export function applySemanticRules(value = '') {
  let text = String(value || '').normalize('NFC').toLowerCase();
  const rules = rows("SELECT source_text,target_text FROM semantic_rules WHERE status='ENABLED' ORDER BY priority DESC,id");
  for (const rule of rules) {
    if (rule.source_text) text = text.replaceAll(String(rule.source_text).toLowerCase(), String(rule.target_text).toLowerCase());
  }
  return text;
}
