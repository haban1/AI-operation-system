import { now, row, run } from '../db.js';
import { SYSTEM_KNOWLEDGE_CATEGORIES } from './knowledge-category.js';
import { knowledgeMetadataFingerprint, suggestKnowledgeMetadata } from './knowledge-metadata-suggestion.js';

const activeTasks = new Map();
const batchLocks = new Map();

function parsePreview(batch) {
  try { return JSON.parse(batch?.preview_json || '{}'); } catch { return {}; }
}

function taskView(task) {
  if (!task) return null;
  return {
    batchId: task.batchId,
    status: task.status,
    total: task.total,
    completed: task.completed,
    failed: task.failed,
    startedAt: task.startedAt,
    completedAt: task.completedAt || null,
    error: task.error || null
  };
}

function savePreview(batchId, preview, task) {
  preview.enrichment = taskView(task);
  run('UPDATE knowledge_import_batches SET preview_json=?,updated_at=? WHERE id=?', JSON.stringify(preview), now(), Number(batchId));
}

function withBatchLock(batchId, action) {
  const id = Number(batchId);
  const previous = batchLocks.get(id) || Promise.resolve();
  const next = previous.catch(() => {}).then(action);
  batchLocks.set(id, next);
  return next.finally(() => {
    if (batchLocks.get(id) === next) batchLocks.delete(id);
  });
}

async function updateLatestPreview(batchId, task, mutator = null) {
  return withBatchLock(batchId, async () => {
    const batch = row('SELECT * FROM knowledge_import_batches WHERE id=?', Number(batchId));
    if (!batch) return null;
    const preview = parsePreview(batch);
    if (mutator) await mutator(preview, batch);
    savePreview(batchId, preview, task);
    return preview;
  });
}

function enrichmentCandidates(items = []) {
  return items.filter(item => item?.aiStatus === 'QUEUED' && item.question && item.answer);
}

async function enrichOne(batchId, rowNo, expectedFingerprint, task) {
  const input = await withBatchLock(batchId, async () => {
    const batch = row('SELECT * FROM knowledge_import_batches WHERE id=?', Number(batchId));
    if (!batch || batch.status === 'COMMITTED') return null;
    const preview = parsePreview(batch);
    const item = (preview.items || []).find(entry => Number(entry.rowNo) === Number(rowNo));
    if (!item) return null;
    const currentFingerprint = knowledgeMetadataFingerprint({ question: item.question, answer: item.answer });
    if (currentFingerprint !== expectedFingerprint || item.metadataFingerprint !== expectedFingerprint) {
      item.aiStatus = 'DISCARDED';
      item.aiError = '问题或答案已经变化，旧的千问推荐结果已丢弃';
      savePreview(batchId, preview, task);
      return null;
    }
    item.aiStatus = 'RUNNING';
    savePreview(batchId, preview, task);
    return {
      question: item.question,
      answer: item.answer,
      category: item.category,
      categorySource: item.categorySource
    };
  });
  if (!input) return { stale: true };

  const allowedCategories = input.categorySource === 'FILE' && SYSTEM_KNOWLEDGE_CATEGORIES.includes(input.category)
    ? [input.category]
    : SYSTEM_KNOWLEDGE_CATEGORIES;
  const suggestion = await suggestKnowledgeMetadata({
    question: input.question,
    answer: input.answer,
    allowedCategories,
    preferredCategory: input.category,
    taskId: `knowledge-import:${batchId}:${rowNo}`
  });

  return withBatchLock(batchId, async () => {
    const latestBatch = row('SELECT * FROM knowledge_import_batches WHERE id=?', Number(batchId));
    if (!latestBatch || latestBatch.status === 'COMMITTED') return { stale: true };
    const latestPreview = parsePreview(latestBatch);
    const latestItem = (latestPreview.items || []).find(entry => Number(entry.rowNo) === Number(rowNo));
    if (!latestItem) return { stale: true };
    const latestFingerprint = knowledgeMetadataFingerprint({ question: latestItem.question, answer: latestItem.answer });
    if (latestFingerprint !== expectedFingerprint || latestItem.metadataFingerprint !== expectedFingerprint) {
      latestItem.aiStatus = 'DISCARDED';
      latestItem.aiError = '问题或答案已经变化，旧的千问推荐结果已丢弃';
      savePreview(batchId, latestPreview, task);
      return { stale: true };
    }
    if (latestItem.categorySource !== 'FILE') {
      latestItem.category = suggestion.category.name;
      latestItem.categorySource = suggestion.category.source === 'AI' ? 'AI' : 'RULE';
    }
    if (latestItem.subcategorySource !== 'FILE') {
      latestItem.subcategory = suggestion.subcategory.name;
      latestItem.subcategorySource = suggestion.subcategory.source === 'AI' ? 'AI' : 'RULE';
    }
    if (latestItem.keywordsSource !== 'FILE') {
      latestItem.keywordOptions = suggestion.keywords;
      latestItem.keywords = suggestion.selectedKeywords.join(',');
      latestItem.keywordsSource = suggestion.source === 'AI' ? 'AI' : 'RULE';
    }
    latestItem.aiRecommendation = suggestion;
    latestItem.aiStatus = suggestion.source === 'AI' ? 'COMPLETED' : 'FALLBACK';
    latestItem.aiError = suggestion.warning || null;
    latestItem.metadataFingerprint = expectedFingerprint;
    latestPreview.summary = {
      ...(latestPreview.summary || {}),
      categories: Object.entries((latestPreview.items || []).reduce((acc, entry) => {
        acc[entry.category] = (acc[entry.category] || 0) + 1;
        return acc;
      }, {})).map(([category, count]) => ({ category, count }))
    };
    savePreview(batchId, latestPreview, task);
    return { suggestion };
  });
}

async function markItemFailed(batchId, rowNo, error, task) {
  await updateLatestPreview(batchId, task, preview => {
    const item = (preview.items || []).find(entry => Number(entry.rowNo) === Number(rowNo));
    if (item) {
      item.aiStatus = 'FAILED';
      item.aiError = String(error?.message || error).slice(0, 500);
    }
  });
}

async function runTask(task) {
  task.status = 'RUNNING';
  task.startedAt = now();
  try {
    const batch = row('SELECT * FROM knowledge_import_batches WHERE id=?', task.batchId);
    if (!batch || batch.status === 'COMMITTED') {
      task.status = 'CANCELLED';
      task.completedAt = now();
      await updateLatestPreview(task.batchId, task);
      return;
    }
    const preview = parsePreview(batch);
    const candidates = enrichmentCandidates(preview.items || []).map(item => ({ rowNo: Number(item.rowNo), fingerprint: item.metadataFingerprint }));
    task.total = candidates.length;
    await updateLatestPreview(task.batchId, task);
    let cursor = 0;
    const worker = async () => {
      while (cursor < candidates.length) {
        const candidate = candidates[cursor++];
        try {
          await enrichOne(task.batchId, candidate.rowNo, candidate.fingerprint, task);
        } catch (error) {
          task.failed += 1;
          await markItemFailed(task.batchId, candidate.rowNo, error, task);
        } finally {
          task.completed += 1;
          await updateLatestPreview(task.batchId, task);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(3, Math.max(1, candidates.length)) }, () => worker()));
    task.status = task.failed ? (task.failed === task.total ? 'FAILED' : 'PARTIAL_FAILED') : 'COMPLETED';
    task.completedAt = now();
    await updateLatestPreview(task.batchId, task);
  } catch (error) {
    task.status = 'FAILED';
    task.error = String(error.message || error).slice(0, 500);
    task.completedAt = now();
    await updateLatestPreview(task.batchId, task);
  } finally {
    setTimeout(() => {
      if (activeTasks.get(task.batchId) === task) activeTasks.delete(task.batchId);
    }, 10 * 60 * 1000).unref?.();
  }
}

export function queueKnowledgeImportMetadataEnrichment(batchId, { force = false } = {}) {
  const id = Number(batchId);
  const batch = row('SELECT * FROM knowledge_import_batches WHERE id=?', id);
  if (!batch) throw new Error('导入批次不存在');
  if (batch.status === 'COMMITTED') throw new Error('该导入批次已经入库，不能重新生成推荐');
  const active = activeTasks.get(id);
  if (active && ['QUEUED', 'RUNNING'].includes(active.status)) return taskView(active);
  const preview = parsePreview(batch);
  if (force) {
    for (const item of preview.items || []) {
      if (item.question && item.answer && (item.categorySource !== 'FILE' || item.subcategorySource !== 'FILE' || item.keywordsSource !== 'FILE')) {
        item.aiStatus = 'QUEUED';
        item.aiError = null;
        item.metadataFingerprint = knowledgeMetadataFingerprint({ question: item.question, answer: item.answer });
      }
    }
  }
  const total = enrichmentCandidates(preview.items || []).length;
  const task = { batchId: id, status: total ? 'QUEUED' : 'COMPLETED', total, completed: 0, failed: 0, startedAt: null, completedAt: total ? null : now(), error: null };
  activeTasks.set(id, task);
  savePreview(id, preview, task);
  if (total) setTimeout(() => runTask(task), 0);
  return taskView(task);
}

export function getKnowledgeImportPreview(batchId) {
  const batch = row('SELECT * FROM knowledge_import_batches WHERE id=?', Number(batchId));
  if (!batch) return null;
  const preview = parsePreview(batch);
  return {
    batchId: Number(batch.id),
    fileName: batch.file_name,
    items: preview.items || [],
    summary: preview.summary || {},
    enrichment: taskView(activeTasks.get(Number(batch.id))) || preview.enrichment || null,
    status: batch.status,
    createdAt: batch.created_at,
    updatedAt: batch.updated_at
  };
}
