export const CONTENT_ORIGINS = Object.freeze({
  AI_GENERATED: 'AI_GENERATED',
  HUMAN_ORIGINAL: 'HUMAN_ORIGINAL'
});

export function normalizeContentOrigin(value) {
  const normalized = String(value || '').trim().toUpperCase();
  return Object.values(CONTENT_ORIGINS).includes(normalized) ? normalized : null;
}

export function contentDeclarationLabels(origin) {
  const normalized = normalizeContentOrigin(origin);
  if (normalized === CONTENT_ORIGINS.AI_GENERATED) return ['含AI生成内容', 'AI生成内容', '由AI生成', '包含AI生成内容'];
  if (normalized === CONTENT_ORIGINS.HUMAN_ORIGINAL) return ['原创内容', '本人原创', '非AI生成内容', '真人原创'];
  return [];
}
