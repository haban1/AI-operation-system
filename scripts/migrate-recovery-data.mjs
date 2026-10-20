#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const TERMINAL_JOB_STATUSES = ['SUCCESS', 'FAILED', 'CANCELLED'];
const TERMINAL_MESSAGE_STATUSES = ['AUTO_REPLIED', 'MANUAL_HANDLED', 'CLOSED', 'IGNORED_SELF', 'IGNORED_OFFICIAL'];
const DIRECT_TABLES = ['accounts', 'platforms', 'knowledge', 'knowledge_import_batches', 'system_settings', 'ai_call_logs', 'notifications'];
const FILTERED_TABLES = ['publish_tasks', 'publish_targets', 'messages', 'agent_jobs'];
export const RECOVERY_MIGRATION_TABLES = Object.freeze([...DIRECT_TABLES, ...FILTERED_TABLES]);
export const RECOVERY_MIGRATION_EXCLUDED = Object.freeze(['browser_commands', 'browser_command_events', 'browser_sessions', 'runtime_blocks', 'reply_locks', 'instance_locks']);

const sha256File = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const q = name => `"${String(name).replaceAll('"', '""')}"`;
function tableExists(db, name) { return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name)); }
function rowsFor(db, table) {
  if (!tableExists(db, table)) return [];
  if (table === 'agent_jobs') return db.prepare(`SELECT * FROM agent_jobs WHERE status IN (${TERMINAL_JOB_STATUSES.map(()=>'?').join(',')}) AND job_type <> 'PUBLISH_STATUS_CHECK'`).all(...TERMINAL_JOB_STATUSES);
  if (table === 'messages') return db.prepare(`SELECT * FROM messages WHERE status IN (${TERMINAL_MESSAGE_STATUSES.map(()=>'?').join(',')})`).all(...TERMINAL_MESSAGE_STATUSES);
  if (table === 'publish_tasks') return db.prepare("SELECT * FROM publish_tasks WHERE status NOT IN ('QUEUED','EXECUTING','RUNNING','CLAIMED','RETRYING')").all();
  if (table === 'publish_targets') return db.prepare("SELECT * FROM publish_targets WHERE status NOT IN ('QUEUED','RUNNING','CLAIMED','RETRYING') AND COALESCE(publish_attempt_state,'') NOT IN ('SUBMIT_ATTEMPTED_UNCONFIRMED')").all();
  return db.prepare(`SELECT * FROM ${q(table)}`).all();
}
function sourceCount(db, table) { return tableExists(db, table) ? Number(db.prepare(`SELECT COUNT(*) AS count FROM ${q(table)}`).get().count) : 0; }

export function analyzeRecoveryMigration({ sourcePath, targetPath, apply = false } = {}) {
  const source = path.resolve(String(sourcePath || ''));
  const target = path.resolve(String(targetPath || ''));
  if (!sourcePath || !fs.existsSync(source)) throw new Error('SOURCE_DATABASE_NOT_FOUND');
  if (!targetPath) throw new Error('TARGET_DATABASE_REQUIRED');
  if (source.toLowerCase() === target.toLowerCase()) throw new Error('SOURCE_TARGET_MUST_DIFFER');
  if (apply && fs.existsSync(target)) throw new Error('TARGET_DATABASE_MUST_BE_NEW');
  const sourceHashBefore = sha256File(source);
  const sourceDb = new DatabaseSync(source, { readOnly: true });
  const selected = new Map();
  const report = { mode: apply ? 'APPLY_TO_NEW_DATABASE' : 'DRY_RUN', sourcePath: source, targetPath: target, sourceSha256Before: sourceHashBefore, tables: {}, excludedTables: [...RECOVERY_MIGRATION_EXCLUDED], secretsPrinted: false };
  try {
    for (const table of RECOVERY_MIGRATION_TABLES) {
      const rows = rowsFor(sourceDb, table); selected.set(table, rows);
      const read = sourceCount(sourceDb, table);
      report.tables[table] = { read, selected: rows.length, skipped: read - rows.length, written: 0, conflicts: 0 };
    }
    if (apply) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const backupPath = path.join(path.dirname(target), `${path.basename(source)}.backup-${Date.now()}`);
      fs.copyFileSync(source, backupPath);
      report.sourceBackupPath = backupPath;
      report.sourceBackupSha256 = sha256File(backupPath);
      const targetDb = new DatabaseSync(target);
      try {
        targetDb.exec('PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE;');
        for (const table of RECOVERY_MIGRATION_TABLES) {
          if (!tableExists(sourceDb, table)) continue;
          const schema = sourceDb.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table)?.sql;
          if (!schema) continue;
          targetDb.exec(schema);
          const rows = selected.get(table) || [];
          if (!rows.length) continue;
          const columns = Object.keys(rows[0]);
          const insert = targetDb.prepare(`INSERT INTO ${q(table)} (${columns.map(q).join(',')}) VALUES (${columns.map(()=>'?').join(',')})`);
          for (const record of rows) { insert.run(...columns.map(column => record[column])); report.tables[table].written += 1; }
        }
        targetDb.exec('COMMIT;');
      } catch (error) { try { targetDb.exec('ROLLBACK;'); } catch {} throw error; }
      finally { targetDb.close(); }
    }
  } finally { sourceDb.close(); }
  report.sourceSha256After = sha256File(source);
  report.sourceUnchanged = report.sourceSha256Before === report.sourceSha256After;
  if (!report.sourceUnchanged) throw new Error('SOURCE_DATABASE_CHANGED');
  return report;
}

function arg(name) { const index=process.argv.indexOf(name); return index >= 0 ? process.argv[index+1] : null; }
if (path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
  const report = analyzeRecoveryMigration({ sourcePath: arg('--source'), targetPath: arg('--target'), apply: process.argv.includes('--apply') });
  const reportPath = arg('--report');
  const output = JSON.stringify(report, null, 2);
  if (reportPath) { fs.mkdirSync(path.dirname(path.resolve(reportPath)), { recursive: true }); fs.writeFileSync(path.resolve(reportPath), output + '\n', 'utf8'); }
  process.stdout.write(output + '\n');
}
