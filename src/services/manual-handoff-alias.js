import { db, now, row, rows, run } from '../db.js';
import { detectManualHandoffCommand, normalizeManualHandoffPhrase } from './conversation-intent.js';
import { generateManualHandoffAliases } from './qwen.js';

const BUILTIN_HANDOFF_PHRASES = [
  '转人工', '帮我转人工', '帮我转个人工', '我要人工回复', '请帮我转接一下客服', '给我找一位工作人员'
];
const builtinNormalized = new Set(BUILTIN_HANDOFF_PHRASES.map(normalizeManualHandoffPhrase));
let workerTimer = null;
let workerRunning = false;

function scheduleWorker(delay = 50) {
  if (workerTimer) return;
  workerTimer = setTimeout(() => {
    workerTimer = null;
    processManualHandoffAliasQueue().catch(error => console.error('[manual-handoff-alias]', error));
  }, delay);
  workerTimer.unref?.();
}

function safeAliasText(value = '') {
  return String(value || '').normalize('NFC').replace(/\s+/g, ' ').trim().slice(0, 80);
}

function hasUnsafeMeaning(text = '') {
  const compact = normalizeManualHandoffPhrase(text);
  if (!compact || compact.length < 3) return '说法过短，容易误触发';
  if (/[?？]$/.test(String(text).trim()) || /(?:能不能|可不可以|是否可以|可以吗|行不行|怎么|如何)(?:转|找|联系|接).*(?:人工|客服|真人|工作人员|专员)/.test(compact)) return '疑问句不能作为明确转人工指令';
  if (/(?:不想|不要|不用|别|无需|取消)(?:转|找|联系|接)?(?:人工|客服|真人|工作人员|专员)/.test(compact)) return '否定或取消转人工的说法不能启用';
  if (/(?:你刚才说|你说过|上面说|为什么说|提到)(?:转人工|人工客服|真人客服)/.test(compact)) return '引用转人工字样不代表用户正在请求转人工';
  return '';
}

function validateGeneratedAlias(phrase, aliasText) {
  const text = safeAliasText(aliasText);
  const normalized = normalizeManualHandoffPhrase(text);
  if (!text || !normalized) return { accepted: false, reason: '内容为空' };
  if (normalized === normalizeManualHandoffPhrase(phrase.phrase)) return { accepted: false, reason: '与标准说法重复' };
  const unsafe = hasUnsafeMeaning(text);
  if (unsafe) return { accepted: false, reason: unsafe };
  if (!detectManualHandoffCommand(text).matched && !/(?:转|找|联系|接|安排|需要|要|想要).*(?:人工|客服|真人|工作人员|专员)|(?:人工|客服|真人|工作人员|专员).*(?:处理|回复|联系|服务)/.test(normalized)) {
    return { accepted: false, reason: '没有明确表达转接真人服务的意图' };
  }
  if (builtinNormalized.has(normalized)) return { accepted: false, reason: '系统内置规则已支持' };
  return { accepted: true, text, normalized };
}

function aliasConflict(phrase, normalizedText) {
  const standard = row('SELECT id,phrase FROM manual_handoff_phrases WHERE id<>? AND normalized_phrase=? LIMIT 1', phrase.id, normalizedText);
  if (standard) return `与标准说法“${standard.phrase}”重复`;
  const alias = row(`SELECT a.id,a.phrase_id,a.alias_text,p.phrase FROM manual_handoff_phrase_aliases a
    JOIN manual_handoff_phrases p ON p.id=a.phrase_id
    WHERE a.phrase_id<>? AND a.normalized_text=? AND a.status='ENABLED' AND a.phrase_version=p.version LIMIT 1`, phrase.id, normalizedText);
  return alias ? `与“${alias.phrase}”下已启用的相似说法重复` : '';
}

export function queueManualHandoffAliasGeneration(phraseId, { requestedBy = 'system', force = false } = {}) {
  const phrase = row('SELECT * FROM manual_handoff_phrases WHERE id=?', Number(phraseId));
  if (!phrase) return null;
  const stamp = now();
  const version = Number(phrase.version || 1);
  if (force) {
    run("UPDATE manual_handoff_alias_generation_tasks SET status='CANCELLED',error_message='由新的生成任务替代',completed_at=?,updated_at=? WHERE phrase_id=? AND status IN ('QUEUED','RUNNING')", stamp, stamp, phrase.id);
  }
  run('DELETE FROM manual_handoff_phrase_aliases WHERE phrase_id=? AND phrase_version<>?', phrase.id, version);
  const active = row("SELECT * FROM manual_handoff_alias_generation_tasks WHERE phrase_id=? AND phrase_version=? AND status IN ('QUEUED','RUNNING') ORDER BY id DESC LIMIT 1", phrase.id, version);
  if (active) return active;
  const result = run(`INSERT INTO manual_handoff_alias_generation_tasks(phrase_id,phrase_version,status,requested_by,created_at,updated_at)
    VALUES(?,?,'QUEUED',?,?,?)`, phrase.id, version, requestedBy, stamp, stamp);
  scheduleWorker();
  return row('SELECT * FROM manual_handoff_alias_generation_tasks WHERE id=?', Number(result.lastInsertRowid));
}

async function processOneTask(task) {
  const stamp = now();
  const claimed = run("UPDATE manual_handoff_alias_generation_tasks SET status='RUNNING',started_at=?,updated_at=? WHERE id=? AND status='QUEUED'", stamp, stamp, task.id);
  if (!claimed.changes) return;
  const phrase = row('SELECT * FROM manual_handoff_phrases WHERE id=?', task.phrase_id);
  if (!phrase || Number(phrase.version || 1) !== Number(task.phrase_version)) {
    run("UPDATE manual_handoff_alias_generation_tasks SET status='DISCARDED',error_message='标准说法已删除或版本已变化，生成结果丢弃',completed_at=?,updated_at=? WHERE id=?", now(), now(), task.id);
    return;
  }
  try {
    const generated = await generateManualHandoffAliases({ phrase: phrase.phrase, taskId: task.id, count: 20 });
    const current = row('SELECT * FROM manual_handoff_phrases WHERE id=?', task.phrase_id);
    const currentTask = row('SELECT * FROM manual_handoff_alias_generation_tasks WHERE id=?', task.id);
    if (!current || Number(current.version || 1) !== Number(task.phrase_version) || currentTask?.status !== 'RUNNING') {
      if (currentTask) run("UPDATE manual_handoff_alias_generation_tasks SET status='DISCARDED',error_message='标准说法已删除、版本变化或任务已取消，生成结果丢弃',completed_at=?,updated_at=? WHERE id=?", now(), now(), task.id);
      return;
    }
    const unique = new Map();
    for (const raw of generated.aliases || []) {
      const validation = validateGeneratedAlias(current, raw);
      if (!validation.accepted || unique.has(validation.normalized)) continue;
      unique.set(validation.normalized, validation.text);
    }
    db.exec('BEGIN IMMEDIATE');
    try {
      const finalPhrase = row('SELECT * FROM manual_handoff_phrases WHERE id=?', task.phrase_id);
      const finalTask = row('SELECT * FROM manual_handoff_alias_generation_tasks WHERE id=?', task.id);
      if (!finalPhrase || Number(finalPhrase.version || 1) !== Number(task.phrase_version) || finalTask?.status !== 'RUNNING') throw new Error('STALE_HANDOFF_ALIAS_TASK');
      run('DELETE FROM manual_handoff_phrase_aliases WHERE phrase_id=? AND phrase_version=?', finalPhrase.id, Number(task.phrase_version));
      for (const [normalized, aliasText] of unique) {
        const conflict = aliasConflict(finalPhrase, normalized);
        run(`INSERT INTO manual_handoff_phrase_aliases(phrase_id,phrase_version,alias_text,normalized_text,source,status,confidence,validation_status,validation_message,created_at,updated_at)
          VALUES(?,?,?,?,?,'DISABLED',?,?,?, ?,?)`, finalPhrase.id, Number(task.phrase_version), aliasText, normalized, 'AI', 1, conflict ? 'CONFLICT' : 'VALID', conflict || null, now(), now());
      }
      run("UPDATE manual_handoff_alias_generation_tasks SET status='COMPLETED',model=?,generated_count=?,error_message=NULL,completed_at=?,updated_at=? WHERE id=?", generated.model || null, unique.size, now(), now(), task.id);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      if (error.message !== 'STALE_HANDOFF_ALIAS_TASK') throw error;
      run("UPDATE manual_handoff_alias_generation_tasks SET status='DISCARDED',error_message='标准说法版本已变化，生成结果丢弃',completed_at=?,updated_at=? WHERE id=?", now(), now(), task.id);
    }
  } catch (error) {
    run("UPDATE manual_handoff_alias_generation_tasks SET status='FAILED',error_message=?,completed_at=?,updated_at=? WHERE id=? AND status='RUNNING'", String(error.message || error).slice(0, 1000), now(), now(), task.id);
  }
}

export async function processManualHandoffAliasQueue() {
  if (workerRunning) return;
  workerRunning = true;
  try {
    while (true) {
      const task = row("SELECT * FROM manual_handoff_alias_generation_tasks WHERE status='QUEUED' ORDER BY id LIMIT 1");
      if (!task) break;
      await processOneTask(task);
    }
  } finally {
    workerRunning = false;
    if (row("SELECT id FROM manual_handoff_alias_generation_tasks WHERE status='QUEUED' LIMIT 1")) scheduleWorker(500);
  }
}

export function startManualHandoffAliasWorker({ backfill = true } = {}) {
  const stamp = now();
  run("UPDATE manual_handoff_alias_generation_tasks SET status='QUEUED',started_at=NULL,error_message=COALESCE(error_message,'服务重启后重新排队'),updated_at=? WHERE status='RUNNING'", stamp);
  if (backfill) {
    const missing = rows(`SELECT p.id FROM manual_handoff_phrases p WHERE NOT EXISTS (
      SELECT 1 FROM manual_handoff_phrase_aliases a WHERE a.phrase_id=p.id AND a.phrase_version=p.version
    ) AND NOT EXISTS (
      SELECT 1 FROM manual_handoff_alias_generation_tasks t WHERE t.phrase_id=p.id AND t.phrase_version=p.version AND t.status IN ('QUEUED','RUNNING','COMPLETED')
    ) ORDER BY p.id`);
    for (const item of missing) queueManualHandoffAliasGeneration(item.id, { requestedBy: 'startup-backfill' });
  }
  scheduleWorker(200);
}

export function listManualHandoffAliases(phraseId) {
  return rows(`SELECT a.*,p.phrase AS standard_phrase,p.status AS phrase_status,p.version AS current_phrase_version
    FROM manual_handoff_phrase_aliases a JOIN manual_handoff_phrases p ON p.id=a.phrase_id
    WHERE a.phrase_id=? ORDER BY CASE a.validation_status WHEN 'VALID' THEN 0 ELSE 1 END,a.id`, Number(phraseId));
}

export function listManualHandoffAliasTasks(limit = 500) {
  return rows(`SELECT t.*,p.phrase AS standard_phrase,p.version AS current_phrase_version FROM manual_handoff_alias_generation_tasks t
    LEFT JOIN manual_handoff_phrases p ON p.id=t.phrase_id ORDER BY t.id DESC LIMIT ?`, Math.max(1, Math.min(1000, Number(limit) || 500)));
}

export function setManualHandoffAliasSelections(phraseId, enabledIds = []) {
  const phrase = row('SELECT * FROM manual_handoff_phrases WHERE id=?', Number(phraseId));
  if (!phrase) return null;
  const selected = new Set((Array.isArray(enabledIds) ? enabledIds : []).map(Number).filter(Number.isFinite));
  const aliases = rows('SELECT * FROM manual_handoff_phrase_aliases WHERE phrase_id=? AND phrase_version=?', phrase.id, Number(phrase.version || 1));
  let skippedConflicts = 0;
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const alias of aliases) {
      let enabled = selected.has(Number(alias.id)) && alias.validation_status === 'VALID';
      let message = alias.validation_message;
      if (enabled) {
        const conflict = aliasConflict(phrase, alias.normalized_text);
        if (conflict) { enabled = false; skippedConflicts += 1; message = conflict; }
      }
      run('UPDATE manual_handoff_phrase_aliases SET status=?,validation_status=?,validation_message=?,updated_at=? WHERE id=?', enabled ? 'ENABLED' : 'DISABLED', message ? 'CONFLICT' : 'VALID', message || null, now(), alias.id);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return { phraseId: phrase.id, total: aliases.length, enabled: aliases.filter(alias => selected.has(Number(alias.id)) && alias.validation_status === 'VALID').length - skippedConflicts, skippedConflicts };
}

export function setManualHandoffAliasStatus(aliasId, status) {
  if (!['ENABLED', 'DISABLED'].includes(status)) throw new Error('转人工相似说法状态无效');
  const alias = row(`SELECT a.*,p.version AS current_phrase_version FROM manual_handoff_phrase_aliases a JOIN manual_handoff_phrases p ON p.id=a.phrase_id WHERE a.id=?`, Number(aliasId));
  if (!alias) return null;
  if (status === 'ENABLED') {
    if (Number(alias.phrase_version) !== Number(alias.current_phrase_version)) throw new Error('该相似说法属于旧版本，请重新生成');
    if (alias.validation_status !== 'VALID') throw new Error(alias.validation_message || '该相似说法存在冲突，不能启用');
  }
  run('UPDATE manual_handoff_phrase_aliases SET status=?,updated_at=? WHERE id=?', status, now(), alias.id);
  return row('SELECT * FROM manual_handoff_phrase_aliases WHERE id=?', alias.id);
}

export function deleteManualHandoffAlias(aliasId) {
  return Number(run('DELETE FROM manual_handoff_phrase_aliases WHERE id=?', Number(aliasId)).changes || 0);
}
