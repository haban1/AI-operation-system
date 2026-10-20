import { db, json, now, row, rows, run } from '../db.js';
import { generateKnowledgeAliases } from './qwen.js';

let workerTimer = null;
let workerRunning = false;

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

function scheduleWorker(delay = 50) {
  if (workerTimer) return;
  workerTimer = setTimeout(() => {
    workerTimer = null;
    processKnowledgeAliasQueue().catch(error => console.error('[knowledge-alias]', error));
  }, delay);
  workerTimer.unref?.();
}

export function queueKnowledgeAliasGeneration(knowledgeId, { requestedBy = 'system', force = false } = {}) {
  const knowledge = row('SELECT * FROM knowledge WHERE id=?', Number(knowledgeId));
  if (!knowledge) return null;
  const stamp = now();
  if (force) {
    run("UPDATE knowledge_alias_generation_tasks SET status='CANCELLED',error_message='由新的生成任务替代',completed_at=?,updated_at=? WHERE knowledge_id=? AND status IN ('QUEUED','RUNNING')", stamp, stamp, knowledge.id);
  }
  run('DELETE FROM knowledge_aliases WHERE knowledge_id=? AND knowledge_version<>?', knowledge.id, Number(knowledge.version || 1));
  const active = row("SELECT * FROM knowledge_alias_generation_tasks WHERE knowledge_id=? AND knowledge_version=? AND status IN ('QUEUED','RUNNING') ORDER BY id DESC LIMIT 1", knowledge.id, Number(knowledge.version || 1));
  if (active) return active;
  const result = run(`INSERT INTO knowledge_alias_generation_tasks(knowledge_id,knowledge_version,status,requested_by,created_at,updated_at)
    VALUES(?,?,'QUEUED',?,?,?)`, knowledge.id, Number(knowledge.version || 1), requestedBy, stamp, stamp);
  scheduleWorker();
  return row('SELECT * FROM knowledge_alias_generation_tasks WHERE id=?', Number(result.lastInsertRowid));
}

function aliasConflict(knowledge, normalizedText) {
  const standardConflict = row(`SELECT id,question FROM knowledge WHERE id<>? AND status='PUBLISHED' AND REPLACE(REPLACE(REPLACE(LOWER(question),' ',''),'？',''),'。','')=? LIMIT 1`, knowledge.id, normalizedText);
  if (standardConflict) return { type: 'STANDARD_QUESTION', knowledgeId: Number(standardConflict.id), question: standardConflict.question };
  const alias = row(`SELECT a.id,a.knowledge_id,k.question FROM knowledge_aliases a JOIN knowledge k ON k.id=a.knowledge_id
    WHERE a.knowledge_id<>? AND a.normalized_text=? AND a.status='ENABLED' LIMIT 1`, knowledge.id, normalizedText);
  return alias ? { type: 'ALIAS', aliasId: Number(alias.id), knowledgeId: Number(alias.knowledge_id), question: alias.question } : null;
}

async function processOneTask(task) {
  const stamp = now();
  const claimed = run("UPDATE knowledge_alias_generation_tasks SET status='RUNNING',started_at=?,updated_at=? WHERE id=? AND status='QUEUED'", stamp, stamp, task.id);
  if (!claimed.changes) return;
  const knowledge = row('SELECT * FROM knowledge WHERE id=?', task.knowledge_id);
  if (!knowledge || Number(knowledge.version || 1) !== Number(task.knowledge_version)) {
    run("UPDATE knowledge_alias_generation_tasks SET status='DISCARDED',error_message='知识已删除或版本已变化，生成结果丢弃',completed_at=?,updated_at=? WHERE id=?", now(), now(), task.id);
    return;
  }
  try {
    const generated = await generateKnowledgeAliases({ knowledge, taskId: task.id, count: 30 });
    const current = row('SELECT * FROM knowledge WHERE id=?', task.knowledge_id);
    const currentTask = row('SELECT * FROM knowledge_alias_generation_tasks WHERE id=?', task.id);
    if (!current || Number(current.version || 1) !== Number(task.knowledge_version) || currentTask?.status !== 'RUNNING') {
      if (currentTask) run("UPDATE knowledge_alias_generation_tasks SET status='DISCARDED',error_message='知识已删除、版本变化或任务已取消，生成结果丢弃',completed_at=?,updated_at=? WHERE id=?", now(), now(), task.id);
      return;
    }
    const unique = new Map();
    const standard = normalizeAliasText(applySemanticRules(current.question));
    for (const aliasText of generated.aliases || []) {
      const normalized = normalizeAliasText(applySemanticRules(aliasText));
      if (!normalized || normalized === standard || unique.has(normalized)) continue;
      unique.set(normalized, String(aliasText).trim().slice(0, 500));
    }
    db.exec('BEGIN IMMEDIATE');
    try {
      const finalKnowledge = row('SELECT * FROM knowledge WHERE id=?', task.knowledge_id);
      const finalTask = row('SELECT status FROM knowledge_alias_generation_tasks WHERE id=?', task.id);
      if (!finalKnowledge || Number(finalKnowledge.version || 1) !== Number(task.knowledge_version) || finalTask?.status !== 'RUNNING') throw new Error('STALE_ALIAS_TASK');
      run('DELETE FROM knowledge_aliases WHERE knowledge_id=?', finalKnowledge.id);
      const insert = db.prepare(`INSERT OR IGNORE INTO knowledge_aliases(knowledge_id,knowledge_version,alias_text,normalized_text,source,status,confidence,validation_status,conflict_json,created_at,updated_at)
        VALUES(?,?,?,?,'AI',?,?,?,?,?,?)`);
      for (const [normalized, aliasText] of unique) {
        const conflict = aliasConflict(finalKnowledge, normalized);
        insert.run(finalKnowledge.id, Number(finalKnowledge.version || 1), aliasText, normalized, conflict ? 'DISABLED' : 'ENABLED', conflict ? 0.35 : 0.92, conflict ? 'CONFLICT' : 'VALID', conflict ? JSON.stringify(conflict) : null, now(), now());
      }
      run("UPDATE knowledge_alias_generation_tasks SET status='COMPLETED',model=?,generated_count=?,error_message=NULL,completed_at=?,updated_at=? WHERE id=?", generated.model || null, unique.size, now(), now(), task.id);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      if (error.message !== 'STALE_ALIAS_TASK') throw error;
      run("UPDATE knowledge_alias_generation_tasks SET status='DISCARDED',error_message='知识版本已变化，生成结果丢弃',completed_at=?,updated_at=? WHERE id=?", now(), now(), task.id);
    }
  } catch (error) {
    run("UPDATE knowledge_alias_generation_tasks SET status='FAILED',error_message=?,completed_at=?,updated_at=? WHERE id=? AND status='RUNNING'", String(error.message || error).slice(0, 1000), now(), now(), task.id);
  }
}

export async function processKnowledgeAliasQueue() {
  if (workerRunning) return;
  workerRunning = true;
  try {
    while (true) {
      const task = row("SELECT * FROM knowledge_alias_generation_tasks WHERE status='QUEUED' ORDER BY id LIMIT 1");
      if (!task) break;
      await processOneTask(task);
    }
  } finally {
    workerRunning = false;
    if (row("SELECT id FROM knowledge_alias_generation_tasks WHERE status='QUEUED' LIMIT 1")) scheduleWorker(500);
  }
}

export function startKnowledgeAliasWorker({ backfill = true } = {}) {
  const stamp = now();
  run("UPDATE knowledge_alias_generation_tasks SET status='QUEUED',started_at=NULL,error_message=COALESCE(error_message,'服务重启后重新排队'),updated_at=? WHERE status='RUNNING'", stamp);
  if (backfill) {
    const missing = rows(`SELECT k.id FROM knowledge k WHERE k.status='PUBLISHED' AND NOT EXISTS (
      SELECT 1 FROM knowledge_aliases a WHERE a.knowledge_id=k.id AND a.knowledge_version=k.version
    ) AND NOT EXISTS (
      SELECT 1 FROM knowledge_alias_generation_tasks t WHERE t.knowledge_id=k.id AND t.knowledge_version=k.version AND t.status IN ('QUEUED','RUNNING','COMPLETED')
    ) ORDER BY k.id`);
    for (const item of missing) queueKnowledgeAliasGeneration(item.id, { requestedBy: 'startup-backfill' });
  }
  scheduleWorker(200);
}

export function listKnowledgeAliases({ search = '', status = '', category = '', knowledgeId = null, limit = 500 } = {}) {
  const clauses = ['1=1'];
  const params = [];
  if (knowledgeId !== null && knowledgeId !== '') { clauses.push('a.knowledge_id=?'); params.push(Number(knowledgeId)); }
  if (search) { clauses.push('(a.alias_text LIKE ? OR k.question LIKE ?)'); params.push(`%${search}%`, `%${search}%`); }
  if (status) { clauses.push('a.status=?'); params.push(status); }
  if (category) { clauses.push('k.category=?'); params.push(category); }
  params.push(Math.max(1, Math.min(1000, Number(limit) || 500)));
  return rows(`SELECT a.*,k.question AS knowledge_question,k.answer AS knowledge_answer,k.category,k.subcategory,k.status AS knowledge_status,k.version AS current_knowledge_version
    FROM knowledge_aliases a JOIN knowledge k ON k.id=a.knowledge_id WHERE ${clauses.join(' AND ')} ORDER BY a.id DESC LIMIT ?`, ...params)
    .map(item => ({ ...item, conflict: json(item.conflict_json, null) }));
}

export function listKnowledgeAliasTasks(limit = 200) {
  return rows(`SELECT t.*,k.question AS knowledge_question,k.category,k.subcategory FROM knowledge_alias_generation_tasks t
    LEFT JOIN knowledge k ON k.id=t.knowledge_id ORDER BY t.id DESC LIMIT ?`, Math.max(1, Math.min(1000, Number(limit) || 200)));
}


export function setKnowledgeAliasSelections(knowledgeId, enabledIds = []) {
  const knowledge = row('SELECT id FROM knowledge WHERE id=?', Number(knowledgeId));
  if (!knowledge) return null;
  const selected = new Set((Array.isArray(enabledIds) ? enabledIds : []).map(Number).filter(Number.isFinite));
  const aliases = rows('SELECT id,validation_status FROM knowledge_aliases WHERE knowledge_id=?', knowledge.id);
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const alias of aliases) {
      const enabled = selected.has(Number(alias.id)) && alias.validation_status !== 'CONFLICT';
      run('UPDATE knowledge_aliases SET status=?,updated_at=? WHERE id=?', enabled ? 'ENABLED' : 'DISABLED', now(), alias.id);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return {
    knowledgeId: knowledge.id,
    total: aliases.length,
    enabled: aliases.filter(alias => selected.has(Number(alias.id)) && alias.validation_status !== 'CONFLICT').length,
    skippedConflicts: aliases.filter(alias => selected.has(Number(alias.id)) && alias.validation_status === 'CONFLICT').length
  };
}

export function setKnowledgeAliasStatus(aliasId, status) {
  if (!['ENABLED', 'DISABLED'].includes(status)) throw new Error('相似问法状态无效');
  run('UPDATE knowledge_aliases SET status=?,updated_at=? WHERE id=?', status, now(), Number(aliasId));
  return row('SELECT * FROM knowledge_aliases WHERE id=?', Number(aliasId));
}

export function deleteKnowledgeAlias(aliasId) {
  return Number(run('DELETE FROM knowledge_aliases WHERE id=?', Number(aliasId)).changes || 0);
}
