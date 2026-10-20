const MAX_TITLE_LENGTH = 100;
const MAX_KNOWLEDGE_CONTENT_LENGTH = 100_000;

function text(value = '') {
  return String(value ?? '').replace(/\r\n?/g, '\n').trim();
}

function shortText(value, maxLength) {
  if (!Number.isFinite(maxLength)) return text(value);
  return [...text(value)].slice(0, maxLength).join('');
}

function stringList(value, { maxItems = Infinity, maxLength = Infinity } = {}) {
  const source = Array.isArray(value) ? value : [];
  return [...new Set(source.map(item => shortText(item, maxLength)).filter(Boolean))].slice(0, maxItems);
}

function faqList(value) {
  const source = Array.isArray(value) ? value : [];
  const result = [];
  for (const item of source) {
    if (!item || typeof item !== 'object') continue;
    const question = text(item.question);
    const answer = text(item.answer);
    if (!question || !answer) continue;
    result.push({ question, answer });
  }
  return result;
}

function markdownEscapeHeading(value) {
  return text(value).replace(/^#+\s*/g, '').replace(/[\r\n]+/g, ' ');
}

export function buildKnowledgeMarkdown({ title, summary, keyFacts = [], faqs = [] } = {}) {
  const sections = [`# ${markdownEscapeHeading(title || '视频知识内容')}`];
  if (summary) sections.push(`## 核心说明\n\n${text(summary)}`);
  if (keyFacts.length) sections.push(`## 关键知识点\n\n${keyFacts.map(item => `- ${text(item)}`).join('\n')}`);
  if (faqs.length) sections.push(`## 常见问题\n\n${faqs.map(item => `### ${markdownEscapeHeading(item.question)}\n\n${text(item.answer)}`).join('\n\n')}`);
  return sections.join('\n\n').trim() + '\n';
}

export function assertMaterialKnowledgeDraftSize({ title, summary = '', keyFacts = [], faqs = [], uncertainFacts = [], contentMarkdown = '' } = {}) {
  // Validate both representations: edited Markdown may differ from the structured knowledge.
  const confirmedText = [summary, ...keyFacts, ...faqs.flatMap(item => [item.question, item.answer])].join('\n');
  const contents = [contentMarkdown, confirmedText, buildKnowledgeMarkdown({ title, summary, keyFacts, faqs }), uncertainFacts.join('\n')];
  if (contents.some(content => [...String(content ?? '').trim()].length > MAX_KNOWLEDGE_CONTENT_LENGTH)) {
    throw Object.assign(new Error(`知识草稿内容超过 ${MAX_KNOWLEDGE_CONTENT_LENGTH} 字符，请拆分后重试；原始内容未截断或保存。`), {
      code: 'KNOWLEDGE_DRAFT_CONTENT_TOO_LARGE',
      statusCode: 400
    });
  }
}

export function normalizeMaterialKnowledgeDraft(raw = {}, context = {}) {
  const title = shortText(raw.title || raw.knowledgeTitle || '视频知识内容', MAX_TITLE_LENGTH);
  const summary = text(raw.summary || raw.coreSummary);
  const keyFacts = stringList(raw.keyFacts || raw.confirmedFacts);
  const faqs = faqList(raw.faqs || raw.questions);
  const uncertainFacts = stringList(raw.uncertainFacts);
  const keywords = stringList(raw.keywords, { maxItems: 20, maxLength: 50 });
  if (!summary && !keyFacts.length && !faqs.length) {
    const error = new Error('AI 未生成可用的知识内容');
    error.code = 'KNOWLEDGE_REQUIRED_FIELDS_MISSING';
    throw error;
  }
  const contentMarkdown = buildKnowledgeMarkdown({ title, summary, keyFacts, faqs });
  assertMaterialKnowledgeDraftSize({ title, summary, keyFacts, faqs, uncertainFacts, contentMarkdown });
  const confidenceValue = Number(raw.confidence);
  return {
    status: 'SUCCESS',
    title,
    summary,
    keyFacts,
    faqs,
    uncertainFacts,
    keywords,
    contentMarkdown,
    confidence: Number.isFinite(confidenceValue) ? Math.max(0, Math.min(1, confidenceValue)) : 0,
    sourceMaterialHash: String(context.materialSha256 || raw.sourceMaterialHash || '').toLowerCase(),
    sourceMaterialName: shortText(context.materialFilename || raw.sourceMaterialName || '', 240),
    generatorVersion: String(context.generatorVersion || raw.generatorVersion || 'video-knowledge-2026.09.01.1')
  };
}
