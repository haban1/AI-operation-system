import mammoth from 'mammoth';
import JSZip from 'jszip';
import { db, now, row, rows, run } from '../db.js';
import { normalizeText, scoreKnowledge } from './knowledge.js';
import { DEFAULT_KNOWLEDGE_SUBCATEGORY, PUBLIC_KNOWLEDGE_CATEGORY, classifyKnowledgeCategory, validateKnowledgeCategoryName, validateKnowledgeSubcategoryName } from './knowledge-category.js';
import { touchKnowledgeSubcategory } from './knowledge-subcategory-cache.js';
import { countUnicodeCharacters, truncateUnicodeSafely, validateKnowledgeAnswerLength } from './platform-reply-policy.js';
import { knowledgeMetadataFingerprint } from './knowledge-metadata-suggestion.js';

const SUPPORTED_EXTENSIONS = new Set(['.csv', '.tsv', '.txt', '.md', '.docx', '.xlsx']);
const MAX_FILE_BYTES = 8 * 1024 * 1024;

const HEADER_ALIASES = {
  question: ['问题', '标准问题', '问法', 'question', 'q'],
  answer: ['答案', '标准答案', '回复内容', 'answer', 'a'],
  keywords: ['关键词', '关键字', '标签', 'keywords', 'keyword', 'tags'],
  subcategory: ['\u5c0f\u7c7b', '\u4e8c\u7ea7\u5206\u7c7b', '\u5b50\u5206\u7c7b', 'subcategory', 'subtype'],
  category: ['\u5927\u7c7b', '\u77e5\u8bc6\u5927\u7c7b', '\u6240\u5c5e\u5927\u7c7b', '\u4e00\u7ea7\u5206\u7c7b', '\u5206\u7c7b', '\u7c7b\u522b', '\u77e5\u8bc6\u5206\u7c7b', 'category', 'type']
};

function cleanCell(value = '') {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/^\uFEFF/, '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
}

function decodeText(buffer) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    return new TextDecoder('gb18030').decode(buffer);
  }
}

function parseDelimited(text, delimiter) {
  const result = [];
  let rowValues = [];
  let value = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') { value += '"'; index += 1; }
      else if (char === '"') quoted = false;
      else value += char;
    } else if (char === '"') quoted = true;
    else if (char === delimiter) { rowValues.push(value); value = ''; }
    else if (char === '\n') { rowValues.push(value); result.push(rowValues); rowValues = []; value = ''; }
    else if (char !== '\r') value += char;
  }
  rowValues.push(value);
  if (rowValues.some(item => cleanCell(item))) result.push(rowValues);
  return result;
}

function normalizedHeader(value) {
  return cleanCell(value).toLowerCase().replace(/[\s_\-（）()]/g, '');
}

function findHeaderIndex(headers, key) {
  const aliases = HEADER_ALIASES[key].map(normalizedHeader);
  return headers.findIndex(header => aliases.includes(normalizedHeader(header)));
}

function excelColumnIndex(reference = '') {
  const letters = String(reference).match(/[A-Z]+/i)?.[0]?.toUpperCase() || '';
  let index = 0;
  for (const char of letters) index = index * 26 + char.charCodeAt(0) - 64;
  return Math.max(0, index - 1);
}

function decodeXml(value = '') {
  return String(value)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

function xmlTagText(xml = '', tag = 't') {
  const values = [];
  const pattern = new RegExp(`<(?:[A-Za-z_][\\w.-]*:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:[A-Za-z_][\\w.-]*:)?${tag}>`, 'gi');
  let match;
  while ((match = pattern.exec(xml))) values.push(decodeXml(match[1]));
  return values.join('');
}

async function parseXlsx(buffer) {
  let zip;
  try { zip = await JSZip.loadAsync(buffer); }
  catch { throw new Error('Excel 文件不是有效的 XLSX 工作簿'); }
  const workbookXml = await zip.file('xl/workbook.xml')?.async('string');
  const relationshipsXml = await zip.file('xl/_rels/workbook.xml.rels')?.async('string');
  if (!workbookXml || !relationshipsXml) throw new Error('Excel 文件缺少工作簿结构');
  const firstSheet = workbookXml.match(/<(?:[A-Za-z_][\w.-]*:)?sheet\b[^>]*\b(?:[A-Za-z_][\w.-]*:)?id="([^"]+)"[^>]*\/?>(?:<\/(?:[A-Za-z_][\w.-]*:)?sheet>)?/i);
  if (!firstSheet) throw new Error('Excel 文件没有可读取的工作表');
  const escapedRelationshipId = firstSheet[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const relationship = [...relationshipsXml.matchAll(/<(?:[A-Za-z_][\w.-]*:)?Relationship\b([^>]*)\/?>(?:<\/(?:[A-Za-z_][\w.-]*:)?Relationship>)?/gi)]
    .find(match => new RegExp(`\\bId="${escapedRelationshipId}"`, 'i').test(match[1]));
  const target = relationship?.[1].match(/\bTarget="([^"]+)"/i)?.[1];
  if (!target) throw new Error('Excel 第一工作表关系无效');
  const sheetPath = target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`;
  const sheetXml = await zip.file(sheetPath)?.async('string');
  if (!sheetXml) throw new Error('Excel 第一工作表内容不存在');
  const sharedXml = await zip.file('xl/sharedStrings.xml')?.async('string');
  const sharedStrings = [];
  if (sharedXml) {
    const itemPattern = /<(?:[A-Za-z_][\w.-]*:)?si(?:\s[^>]*)?>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?si>/gi;
    let itemMatch;
    while ((itemMatch = itemPattern.exec(sharedXml))) sharedStrings.push(xmlTagText(itemMatch[1], 't'));
  }
  const rows = [];
  const rowPattern = /<(?:[A-Za-z_][\w.-]*:)?row(?:\s[^>]*)?>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?row>/gi;
  let rowMatch;
  while ((rowMatch = rowPattern.exec(sheetXml))) {
    const values = [];
    const cellPattern = /<(?:[A-Za-z_][\w.-]*:)?c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?c>)/gi;
    let cellMatch;
    while ((cellMatch = cellPattern.exec(rowMatch[1]))) {
      const attrs = cellMatch[1];
      const body = cellMatch[2] || '';
      const reference = attrs.match(/\br="([^"]+)"/i)?.[1] || '';
      const type = attrs.match(/\bt="([^"]+)"/i)?.[1] || '';
      const raw = body.match(/<(?:[A-Za-z_][\w.-]*:)?v(?:\s[^>]*)?>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?v>/i)?.[1] || '';
      let value = '';
      if (type === 's') value = sharedStrings[Number(raw)] || '';
      else if (type === 'inlineStr') value = xmlTagText(body, 't');
      else if (type === 'b') value = raw === '1' ? 'TRUE' : 'FALSE';
      else value = decodeXml(raw);
      values[excelColumnIndex(reference)] = value;
    }
    if (values.some(value => cleanCell(value))) rows.push(values);
  }
  return tabularItems(rows);
}

function tabularItems(table) {
  const nonempty = table.filter(values => values.some(value => cleanCell(value)));
  if (!nonempty.length) return [];
  const headers = nonempty[0];
  let questionIndex = findHeaderIndex(headers, 'question');
  let answerIndex = findHeaderIndex(headers, 'answer');
  let keywordsIndex = findHeaderIndex(headers, 'keywords');
  let categoryIndex = findHeaderIndex(headers, 'category');
  let subcategoryIndex = findHeaderIndex(headers, 'subcategory');
  const hasHeader = questionIndex >= 0 && answerIndex >= 0;
  if (!hasHeader) { questionIndex = 0; answerIndex = 1; keywordsIndex = 2; categoryIndex = 3; subcategoryIndex = 4; }
  return nonempty.slice(hasHeader ? 1 : 0).map((values, index) => ({
    sourceRow: index + (hasHeader ? 2 : 1),
    question: values[questionIndex],
    answer: values[answerIndex],
    keywords: values[keywordsIndex] || '',
    category: values[categoryIndex] || '',
    subcategory: values[subcategoryIndex] || ''
  }));
}

function textItems(text) {
  const normalized = cleanCell(text).replace(/\r\n?/g, '\n');
  const lines = normalized.split('\n').map(cleanCell);
  const items = [];
  let current = null;
  let currentCategory = '';
  let currentSubcategory = '';
  const flush = () => {
    if (current && (current.question || current.answer)) items.push(current);
    current = null;
  };
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line) continue;
    const subcategoryMatch = line.match(/^(?:\u5c0f\u7c7b|\u4e8c\u7ea7\u5206\u7c7b|\u5b50\u5206\u7c7b)\s*[:\uFF1A]\s*(.+)$/i);
    if (subcategoryMatch) { currentSubcategory = cleanCell(subcategoryMatch[1]); continue; }
    const categoryMatch = line.match(/^(?:分类|类别|知识分类)\s*[:：]\s*(.+)$/i);
    if (categoryMatch) { currentCategory = cleanCell(categoryMatch[1]); continue; }
    const questionMatch = line.match(/^(?:问题|标准问题|问|Q)\s*[:：]\s*(.+)$/i);
    if (questionMatch) {
      flush();
      current = { sourceRow: index + 1, question: questionMatch[1], answer: '', keywords: '', category: currentCategory, subcategory: currentSubcategory };
      continue;
    }
    const answerMatch = line.match(/^(?:答案|标准答案|答|A)\s*[:：]\s*(.+)$/i);
    if (answerMatch) {
      current ||= { sourceRow: index + 1, question: '', answer: '', keywords: '', category: currentCategory, subcategory: currentSubcategory };
      current.answer = answerMatch[1];
      continue;
    }
    const keywordsMatch = line.match(/^(?:关键词|关键字|标签)\s*[:：]\s*(.+)$/i);
    if (keywordsMatch && current) { current.keywords = keywordsMatch[1]; continue; }
    if (current?.answer) current.answer += `\n${line}`;
  }
  flush();
  if (items.length) return items;

  const blocks = normalized.split(/\n\s*\n+/).map(block => block.split('\n').map(cleanCell).filter(Boolean)).filter(Boolean);
  return blocks.filter(block => block.length >= 2 && /[？?]$/.test(block[0])).map((block, index) => ({
    sourceRow: index + 1,
    question: block[0],
    answer: block.slice(1).join('\n'),
    keywords: '',
    category: '',
    subcategory: ''
  }));
}

function classify(question, answer, providedCategory = '') {
  const explicit = cleanCell(providedCategory);
  const inferred = classifyKnowledgeCategory(question, answer);
  if (explicit) {
    const validation = validateKnowledgeCategoryName(explicit);
    return validation.ok
      ? { category: validation.name, categorySource: 'FILE', suggestedKeywords: inferred.suggestedKeywords, suggestedSubcategory: inferred.suggestedSubcategory }
      : { category: PUBLIC_KNOWLEDGE_CATEGORY, categorySource: 'FILE', suggestedKeywords: inferred.suggestedKeywords, suggestedSubcategory: inferred.suggestedSubcategory, categoryError: validation.message };
  }
  return { ...inferred, categorySource: 'DEFAULT' };
}

function resolveImportedSubcategory(value = '', suggestedSubcategory = DEFAULT_KNOWLEDGE_SUBCATEGORY) {
  const explicit = cleanCell(value);
  if (!explicit) return { subcategory: suggestedSubcategory || DEFAULT_KNOWLEDGE_SUBCATEGORY, subcategorySource: suggestedSubcategory && suggestedSubcategory !== DEFAULT_KNOWLEDGE_SUBCATEGORY ? 'RULE' : 'DEFAULT' };
  const validation = validateKnowledgeSubcategoryName(explicit);
  return validation.ok
    ? { subcategory: validation.name, subcategorySource: 'FILE' }
    : { subcategory: DEFAULT_KNOWLEDGE_SUBCATEGORY, subcategorySource: 'FILE', subcategoryError: validation.message };
}

function cleanKeywords(value, suggested = []) {
  const values = `${cleanCell(value)},${suggested.join(',')}`
    .split(/[,，;；、|\n]+/)
    .map(cleanCell)
    .filter(item => item && item.length <= 30);
  return [...new Set(values)].slice(0, 12).join(',');
}

function prepareItems(rawItems, existing) {
  const seen = new Set();
  return rawItems.map((raw, index) => {
    const cleanNotes = [];
    let question = cleanCell(raw.question).replace(/^(?:问题|标准问题|问|Q)\s*[:：]\s*/i, '');
    let answer = cleanCell(raw.answer).replace(/^(?:答案|标准答案|答|A)\s*[:：]\s*/i, '');
    if (question !== String(raw.question ?? '').trim() || answer !== String(raw.answer ?? '').trim()) cleanNotes.push('已清理空格、控制字符和字段前缀');
    const errors = [];
    if (!question) errors.push('缺少标准问题');
    if (!answer) errors.push('缺少标准答案');
    if (countUnicodeCharacters(question) > 500) {
      question = truncateUnicodeSafely(question, 500);
      cleanNotes.push('问题已按完整Unicode字符安全截断至500字');
    }
    if (countUnicodeCharacters(answer) > 5000) errors.push('标准答案不能超过5000个Unicode字符');

    const categoryResult = classify(question, answer, raw.category);
    if (categoryResult.categoryError) errors.push(categoryResult.categoryError);
    const subcategoryResult = resolveImportedSubcategory(raw.subcategory, categoryResult.suggestedSubcategory);
    if (subcategoryResult.subcategoryError) errors.push(subcategoryResult.subcategoryError);
    const answerLength = validateKnowledgeAnswerLength({ category: categoryResult.category, answer });
    if (!answerLength.ok) errors.push(answerLength.message);
    const hasFileKeywords = Boolean(cleanCell(raw.keywords));
    const hasFileCategory = Boolean(cleanCell(raw.category));
    const hasFileSubcategory = Boolean(cleanCell(raw.subcategory));
    const keywords = cleanKeywords(raw.keywords, categoryResult.suggestedKeywords);
    const keywordsSource = hasFileKeywords ? 'FILE' : 'RULE';
    if (!hasFileCategory) cleanNotes.push(`未填写大类，当前以“${PUBLIC_KNOWLEDGE_CATEGORY}”兜底，千问将继续推荐`);
    if (!hasFileSubcategory) cleanNotes.push(subcategoryResult.subcategorySource === 'RULE' ? `未填写小类，当前规则建议为“${subcategoryResult.subcategory}”，千问将继续推荐` : `未填写小类，当前以“${DEFAULT_KNOWLEDGE_SUBCATEGORY}”兜底，千问将继续推荐`);
    if (!hasFileKeywords) cleanNotes.push('未填写关键词，当前规则已兜底，千问将继续推荐可触发的完整意图词');

    const normalized = normalizeText(question);
    const duplicateUpload = normalized && seen.has(normalized);
    if (normalized) seen.add(normalized);
    if (duplicateUpload) errors.push('上传文件内问题重复');

    let matched = null;
    let matchScore = 0;
    for (const item of existing) {
      if (item.category !== categoryResult.category) continue;
      const score = scoreKnowledge(question, item);
      if (score > matchScore) { matchScore = score; matched = item; }
    }
    const exact = matched && normalized && normalized === normalizeText(matched.question);
    const matchStatus = exact ? 'EXACT_DUPLICATE' : matchScore >= 0.82 ? 'SIMILAR_REVIEW' : 'NEW';
    if (exact) cleanNotes.push(`与知识 #${matched.id} 完全重复，默认跳过`);
    else if (matchStatus === 'SIMILAR_REVIEW') cleanNotes.push(`与知识 #${matched.id} 相似，导入后需重点审核`);

    return {
      rowNo: index + 1,
      sourceRow: Number(raw.sourceRow || index + 1),
      question,
      answer,
      keywords,
      keywordsSource,
      keywordOptions: keywords.split(',').filter(Boolean).map(text => ({ text, confidence: 0.62, reason: hasFileKeywords ? '上传文件填写' : '本地规则兜底', source: hasFileKeywords ? 'FILE' : 'RULE', selectable: true, conflict: false, selected: true })),
      category: categoryResult.category,
      categorySource: categoryResult.categorySource,
      subcategory: subcategoryResult.subcategory,
      subcategorySource: subcategoryResult.subcategorySource,
      metadataFingerprint: knowledgeMetadataFingerprint({ question, answer }),
      aiStatus: (!hasFileKeywords || !hasFileCategory || !hasFileSubcategory) && question && answer ? 'QUEUED' : 'NOT_NEEDED',
      aiRecommendation: null,
      aiError: null,
      cleanNotes,
      errors,
      answerCharacterCount: answerLength.count,
      answerCharacterLimit: answerLength.limit,
      answerLimitLabel: answerLength.policy?.label || null,
      matchStatus,
      matchScore: Number(matchScore.toFixed(4)),
      matchedKnowledgeId: matched?.id || null,
      matchedQuestion: matched?.question || null,
      importable: errors.length === 0 && !exact
    };
  });
}

function extensionOf(fileName) {
  const match = String(fileName || '').toLowerCase().match(/(\.[a-z0-9]+)$/);
  return match?.[1] || '';
}

async function parseFile(fileName, buffer) {
  const extension = extensionOf(fileName);
  if (!SUPPORTED_EXTENSIONS.has(extension)) throw new Error('仅支持 CSV、TSV、TXT、MD、DOCX 和 XLSX 文件');
  if (!buffer.length) throw new Error('上传文件为空');
  if (buffer.length > MAX_FILE_BYTES) throw new Error('单个知识文档不能超过 8MB');
  if (extension === '.xlsx') return parseXlsx(buffer);
  if (extension === '.docx') {
    const extracted = await mammoth.extractRawText({ buffer });
    return textItems(extracted.value || '');
  }
  const text = decodeText(buffer);
  if (extension === '.csv' || extension === '.tsv') {
    const delimiter = extension === '.tsv' ? '\t' : ((text.match(/\t/g) || []).length > (text.match(/,/g) || []).length ? '\t' : ',');
    return tabularItems(parseDelimited(text, delimiter));
  }
  return textItems(text);
}

export function knowledgeImportTemplateCsv() {
  const lines = [
    ['\u6807\u51c6\u95ee\u9898', '\u6807\u51c6\u7b54\u6848', '\u5173\u952e\u8bcd', '\u5927\u7c7b', '\u5c0f\u7c7b'],
    ['\u793e\u533a\u670d\u52a1\u4e2d\u5fc3\u7684\u529e\u516c\u65f6\u95f4\u662f\u4ec0\u4e48\uff1f', '\u793e\u533a\u670d\u52a1\u4e2d\u5fc3\u5de5\u4f5c\u65f6\u95f4\u4e3a\u5468\u4e00\u81f3\u5468\u4e94 9:00\u201418:00\uff1b\u8282\u5047\u65e5\u5b89\u6392\u4ee5\u6700\u65b0\u516c\u544a\u4e3a\u51c6\u3002', '\u529e\u516c\u65f6\u95f4,\u4e0a\u73ed\u65f6\u95f4', '\u516c\u5171\u77e5\u8bc6\u5e93', '\u5f00\u653e\u65f6\u95f4'],
    ['\u5982\u4f55\u62a5\u540d\u53c2\u52a0\u793e\u533a\u6d3b\u52a8\uff1f', '\u8bf7\u901a\u8fc7\u6d3b\u52a8\u516c\u544a\u4e2d\u7684\u62a5\u540d\u5165\u53e3\u63d0\u4ea4\u4fe1\u606f\uff1b\u540d\u989d\u548c\u622a\u6b62\u65f6\u95f4\u4ee5\u5177\u4f53\u6d3b\u52a8\u516c\u544a\u4e3a\u51c6\u3002', '\u6d3b\u52a8\u62a5\u540d,\u9884\u7ea6', '\u516c\u5171\u77e5\u8bc6\u5e93', '\u6d3b\u52a8\u62a5\u540d']
  ];
  const escapeCsv = value => `"${String(value).replace(/"/g, '""')}"`;
  return '\uFEFF' + lines.map(values => values.map(escapeCsv).join(',')).join('\r\n');
}

export async function previewKnowledgeImport({ fileName, base64 }) {
  if (!fileName || !base64) throw new Error('请选择知识文档后再上传');
  let buffer;
  try { buffer = Buffer.from(String(base64).replace(/^data:[^;]+;base64,/, ''), 'base64'); }
  catch { throw new Error('文件内容不是有效的 Base64 数据'); }
  const rawItems = await parseFile(fileName, buffer);
  if (!rawItems.length) throw new Error('未识别到知识问答；TXT、MD、DOCX 请使用“问题：/答案：”格式，CSV/XLSX 请使用下载模板字段');
  if (rawItems.length > 1000) throw new Error('单次最多导入 1000 条知识');
  const existing = rows("SELECT * FROM knowledge WHERE status!='DISABLED' ORDER BY id DESC");
  const items = prepareItems(rawItems, existing);
  const summary = {
    total: items.length,
    importable: items.filter(item => item.importable).length,
    exactDuplicates: items.filter(item => item.matchStatus === 'EXACT_DUPLICATE').length,
    similar: items.filter(item => item.matchStatus === 'SIMILAR_REVIEW').length,
    invalid: items.filter(item => item.errors.length > 0).length,
    categories: Object.entries(items.reduce((acc, item) => { acc[item.category] = (acc[item.category] || 0) + 1; return acc; }, {})).map(([category, count]) => ({ category, count }))
  };
  const stamp = now();
  const batchId = Number(run(`INSERT INTO knowledge_import_batches(file_name,file_type,status,total_rows,valid_rows,duplicate_rows,similar_rows,error_rows,preview_json,created_at,updated_at)
    VALUES(?,?,'PREVIEWED',?,?,?,?,?,?,?,?)`, fileName, extensionOf(fileName).slice(1).toUpperCase(), summary.total, summary.importable, summary.exactDuplicates, summary.similar, summary.invalid, JSON.stringify({ items, summary }), stamp, stamp).lastInsertRowid);
  return { batchId, fileName, items, summary };
}

export function commitKnowledgeImport({ batchId, importedBy = '业务人员', selectedRowNos, reviewedItems }) {
  const batch = row('SELECT * FROM knowledge_import_batches WHERE id=?', Number(batchId));
  if (!batch) throw new Error('导入批次不存在，请重新上传预览');
  if (batch.status === 'COMMITTED') return { batchId: batch.id, imported: batch.imported_rows, skipped: batch.total_rows - batch.imported_rows, alreadyCommitted: true };
  const preview = JSON.parse(batch.preview_json || '{}');
  const previewItems = Array.isArray(preview.items) ? preview.items : [];
  const reviewList = Array.isArray(reviewedItems) ? reviewedItems : [];
  const reviewedByRow = new Map(reviewList.map(item => [Number(item.rowNo), item]));
  const hasManualSelection = Array.isArray(selectedRowNos) || reviewList.length > 0;
  const selected = new Set((Array.isArray(selectedRowNos) ? selectedRowNos : reviewList.map(item => item.rowNo)).map(Number).filter(Number.isFinite));
  const chosenItems = previewItems.filter(item => hasManualSelection ? selected.has(Number(item.rowNo)) : item.importable);
  if (hasManualSelection && !chosenItems.length) throw new Error('请至少选择一条预处理数据后再入库');

  const reviewedRawItems = chosenItems.map(item => {
    const edited = reviewedByRow.get(Number(item.rowNo)) || {};
    return {
      sourceRow: item.sourceRow,
      question: edited.question ?? item.question,
      answer: edited.answer ?? item.answer,
      keywords: edited.keywords ?? item.keywords,
      category: edited.category ?? item.category,
      subcategory: edited.subcategory ?? item.subcategory
    };
  });
  const existing = rows("SELECT * FROM knowledge WHERE status!='DISABLED' ORDER BY id DESC");
  const items = prepareItems(reviewedRawItems, existing);
  const stamp = now();
  let imported = 0;
  const knowledgeIds = [];
  const rejected = [];
  db.exec('BEGIN IMMEDIATE');
  try {
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      const sourceItem = chosenItems[index];
      if (!item.importable) {
        rejected.push({ rowNo: sourceItem.rowNo, sourceRow: sourceItem.sourceRow, errors: item.errors, matchStatus: item.matchStatus });
        continue;
      }
      const exists = row("SELECT id FROM knowledge WHERE status!='DISABLED' AND category=? AND question=?", item.category, item.question);
      if (exists) {
        rejected.push({ rowNo: sourceItem.rowNo, sourceRow: sourceItem.sourceRow, errors: ['标准问题已存在'], matchStatus: 'EXACT_DUPLICATE' });
        continue;
      }
      const inserted = run(`INSERT INTO knowledge(question,answer,keywords,status,version,source,review_status,category,subcategory,source_file,import_batch_id,match_status,matched_knowledge_id,clean_notes,created_at,updated_at)
        VALUES(?,?,?,'DRAFT',1,'FILE_IMPORT','PENDING_REVIEW',?,?,?,?,?,?,?,?,?)`, item.question, item.answer, item.keywords, item.category, item.subcategory, batch.file_name, batch.id, item.matchStatus, item.matchedKnowledgeId, [...item.cleanNotes, `人工审核：${cleanCell(importedBy) || '业务人员'}`].join('；'), stamp, stamp);
      knowledgeIds.push(Number(inserted.lastInsertRowid));
      touchKnowledgeSubcategory(item.category, item.subcategory, stamp);
      imported += 1;
    }
    run("UPDATE knowledge_import_batches SET status='COMMITTED',imported_rows=?,committed_at=?,updated_at=? WHERE id=?", imported, stamp, stamp, batch.id);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return { batchId: batch.id, selected: chosenItems.length, imported, skipped: chosenItems.length - imported, rejected, knowledgeIds, alreadyCommitted: false };
}

export function listKnowledgeImports(limit = 20) {
  return rows('SELECT id,file_name,file_type,status,total_rows,valid_rows,duplicate_rows,similar_rows,error_rows,imported_rows,created_at,committed_at FROM knowledge_import_batches ORDER BY id DESC LIMIT ?', Number(limit));
}

export const knowledgeImportLimits = { supportedExtensions: [...SUPPORTED_EXTENSIONS], maxFileBytes: MAX_FILE_BYTES };


