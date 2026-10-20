import { db, json, now, row, rows, run } from '../db.js';
import { assertMaterialKnowledgeDraftSize } from './material-knowledge-schema.js';

const EDITABLE_STATUSES = new Set(['PENDING_CONFIRMATION', 'FAILED']);

function cleanText(value, maxLength = Infinity) {
  const text = String(value ?? '').trim();
  return Number.isFinite(maxLength) ? [...text].slice(0, maxLength).join('') : text;
}

function cleanList(value, { maxItems = Infinity, maxLength = Infinity } = {}) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(item => cleanText(item, maxLength)).filter(Boolean))].slice(0, maxItems);
}

function cleanFaqs(value) {
  if (!Array.isArray(value)) return [];
  return value.map(item => ({
    question: cleanText(item?.question),
    answer: cleanText(item?.answer)
  })).filter(item => item.question && item.answer);
}

function mapDraft(item) {
  if (!item) return null;
  return {
    id: Number(item.id),
    materialSha256: item.material_sha256,
    materialFilename: item.material_filename,
    materialPath: item.material_path,
    transcriptHash: item.transcript_hash,
    title: item.title,
    summary: item.summary || '',
    keyFacts: json(item.key_facts_json, []),
    faqs: json(item.faqs_json, []),
    uncertainFacts: json(item.uncertain_facts_json, []),
    keywords: json(item.keywords_json, []),
    contentMarkdown: item.content_markdown,
    confidence: Number(item.confidence) || 0,
    generatorVersion: item.generator_version,
    status: item.status,
    ragDocumentId: item.rag_document_id,
    ragDocumentVersion: item.rag_document_version == null ? null : Number(item.rag_document_version),
    errorMessage: item.error_message,
    createdAt: item.created_at,
    updatedAt: item.updated_at
  };
}

function normalizedInput(input = {}) {
  const materialSha256 = cleanText(input.materialSha256 || input.sourceMaterialHash, 80).toLowerCase();
  const title = cleanText(input.title, 100);
  const contentMarkdown = cleanText(input.contentMarkdown);
  if (!/^[a-f0-9]{64}$/.test(materialSha256)) throw Object.assign(new Error('知识草稿缺少有效的素材 SHA-256'), { code: 'MATERIAL_SHA_INVALID' });
  if (!title) throw Object.assign(new Error('知识草稿标题不能为空'), { code: 'KNOWLEDGE_DRAFT_TITLE_REQUIRED' });
  if (!contentMarkdown) throw Object.assign(new Error('知识草稿内容不能为空'), { code: 'KNOWLEDGE_DRAFT_CONTENT_REQUIRED' });
  const value = {
    materialSha256,
    materialFilename: cleanText(input.materialFilename || input.sourceMaterialName, 240),
    materialPath: cleanText(input.materialPath, 2000),
    transcriptHash: cleanText(input.transcriptHash, 80),
    title,
    summary: cleanText(input.summary),
    keyFacts: cleanList(input.keyFacts),
    faqs: cleanFaqs(input.faqs),
    uncertainFacts: cleanList(input.uncertainFacts),
    keywords: cleanList(input.keywords, { maxItems: 30, maxLength: 100 }),
    contentMarkdown,
    confidence: Math.max(0, Math.min(1, Number(input.confidence) || 0)),
    generatorVersion: cleanText(input.generatorVersion, 120) || 'video-knowledge-2026.09.01.1'
  };
  assertMaterialKnowledgeDraftSize(value);
  return value;
}

export function listMaterialKnowledgeDrafts({ includeImported = false, limit = 100 } = {}) {
  const where = includeImported ? '' : "WHERE status NOT IN ('IMPORTED','IGNORED')";
  return rows(`SELECT * FROM material_knowledge_drafts ${where} ORDER BY created_at DESC, id DESC LIMIT ?`, Math.max(1, Math.min(500, Number(limit) || 100))).map(mapDraft);
}

export function getMaterialKnowledgeDraft(id) {
  return mapDraft(row('SELECT * FROM material_knowledge_drafts WHERE id=?', Number(id)));
}

export function saveMaterialKnowledgeDraft(input = {}) {
  const value = normalizedInput(input);
  const existing = row(`SELECT * FROM material_knowledge_drafts
    WHERE material_sha256=? AND generator_version=? AND status IN ('PENDING_CONFIRMATION','FAILED')
    ORDER BY id DESC LIMIT 1`, value.materialSha256, value.generatorVersion);
  const stamp = now();
  if (existing) {
    run(`UPDATE material_knowledge_drafts SET material_filename=?,material_path=?,transcript_hash=?,title=?,summary=?,key_facts_json=?,faqs_json=?,uncertain_facts_json=?,keywords_json=?,content_markdown=?,confidence=?,status='PENDING_CONFIRMATION',rag_document_id=NULL,rag_document_version=NULL,error_message=NULL,updated_at=? WHERE id=?`,
      value.materialFilename, value.materialPath, value.transcriptHash, value.title, value.summary, JSON.stringify(value.keyFacts), JSON.stringify(value.faqs), JSON.stringify(value.uncertainFacts), JSON.stringify(value.keywords), value.contentMarkdown, value.confidence, stamp, existing.id);
    return getMaterialKnowledgeDraft(existing.id);
  }
  const result = run(`INSERT INTO material_knowledge_drafts(material_sha256,material_filename,material_path,transcript_hash,title,summary,key_facts_json,faqs_json,uncertain_facts_json,keywords_json,content_markdown,confidence,generator_version,status,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'PENDING_CONFIRMATION',?,?)`,
    value.materialSha256, value.materialFilename, value.materialPath, value.transcriptHash, value.title, value.summary, JSON.stringify(value.keyFacts), JSON.stringify(value.faqs), JSON.stringify(value.uncertainFacts), JSON.stringify(value.keywords), value.contentMarkdown, value.confidence, value.generatorVersion, stamp, stamp);
  return getMaterialKnowledgeDraft(result.lastInsertRowid);
}

export function updateMaterialKnowledgeDraft(id, input = {}) {
  const current = getMaterialKnowledgeDraft(id);
  if (!current) return null;
  if (!EDITABLE_STATUSES.has(current.status)) throw Object.assign(new Error('当前知识草稿状态不允许修改'), { code: 'KNOWLEDGE_DRAFT_NOT_EDITABLE', statusCode: 409 });
  const title = cleanText(input.title ?? current.title, 100);
  const contentMarkdown = cleanText(input.contentMarkdown ?? current.contentMarkdown);
  if (!title || !contentMarkdown) throw Object.assign(new Error('知识标题和内容不能为空'), { code: 'KNOWLEDGE_DRAFT_CONTENT_REQUIRED' });
  const summary = cleanText(input.summary ?? current.summary);
  const keyFacts = input.keyFacts === undefined ? current.keyFacts : cleanList(input.keyFacts);
  const faqs = input.faqs === undefined ? current.faqs : cleanFaqs(input.faqs);
  const uncertainFacts = input.uncertainFacts === undefined ? current.uncertainFacts : cleanList(input.uncertainFacts);
  const keywords = input.keywords === undefined ? current.keywords : cleanList(input.keywords, { maxItems: 30, maxLength: 100 });
  assertMaterialKnowledgeDraftSize({ title, summary, keyFacts, faqs, uncertainFacts, contentMarkdown });
  run(`UPDATE material_knowledge_drafts SET title=?,summary=?,key_facts_json=?,faqs_json=?,uncertain_facts_json=?,keywords_json=?,content_markdown=?,status='PENDING_CONFIRMATION',error_message=NULL,updated_at=? WHERE id=?`,
    title, summary, JSON.stringify(keyFacts), JSON.stringify(faqs), JSON.stringify(uncertainFacts), JSON.stringify(keywords), contentMarkdown, now(), Number(id));
  return getMaterialKnowledgeDraft(id);
}

export function deleteMaterialKnowledgeDraft(id) {
  const current = getMaterialKnowledgeDraft(id);
  if (!current) return false;
  if (current.status === 'IMPORTING') throw Object.assign(new Error('知识草稿正在加入知识库，暂时不能删除'), { code: 'KNOWLEDGE_DRAFT_IMPORTING', statusCode: 409 });
  run('DELETE FROM material_knowledge_drafts WHERE id=?', Number(id));
  return true;
}

export function markMaterialKnowledgeDraftImporting(id) {
  const current = getMaterialKnowledgeDraft(id);
  if (!current) return null;
  if (current.status === 'IMPORTED') return current;
  if (current.status === 'IMPORTING') throw Object.assign(new Error('知识草稿正在加入知识库，请勿重复操作'), { code: 'KNOWLEDGE_DRAFT_IMPORTING', statusCode: 409 });
  if (!EDITABLE_STATUSES.has(current.status)) throw Object.assign(new Error('当前知识草稿不能加入知识库'), { code: 'KNOWLEDGE_DRAFT_NOT_IMPORTABLE', statusCode: 409 });
  run("UPDATE material_knowledge_drafts SET status='IMPORTING',error_message=NULL,updated_at=? WHERE id=?", now(), Number(id));
  return getMaterialKnowledgeDraft(id);
}

export function markMaterialKnowledgeDraftImported(id, document = {}) {
  run("UPDATE material_knowledge_drafts SET status='IMPORTED',rag_document_id=?,rag_document_version=?,error_message=NULL,updated_at=? WHERE id=?",
    String(document.documentId || ''), Number(document.documentVersion) || 1, now(), Number(id));
  return getMaterialKnowledgeDraft(id);
}

export function markMaterialKnowledgeDraftFailed(id, error) {
  run("UPDATE material_knowledge_drafts SET status='FAILED',error_message=?,updated_at=? WHERE id=?", cleanText(error?.message || error, 2000), now(), Number(id));
  return getMaterialKnowledgeDraft(id);
}
