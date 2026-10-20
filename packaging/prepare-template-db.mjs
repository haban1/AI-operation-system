import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const databasePath = process.argv[2];
if (!databasePath || !fs.existsSync(databasePath)) throw new Error('Usage: node prepare-template-db.mjs <copied-template-database>');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const livePath = path.join(root, 'data/mvp.db');
if (fs.existsSync(livePath) && fs.realpathSync(databasePath).toLowerCase() === fs.realpathSync(livePath).toLowerCase()) {
  throw new Error('Refusing to clear the live database; create an installation snapshot first');
}
const db = new DatabaseSync(databasePath);
const preserved = new Set([
  'platforms', 'devices', 'accounts', 'mini_program_channel_identity', 'schema_migrations', 'system_settings',
  'knowledge', 'knowledge_aliases', 'knowledge_subcategory_cache', 'knowledge_import_batches',
  'semantic_rules', 'manual_handoff_phrases', 'manual_handoff_phrase_aliases',
  'xiaozhi_test_answers', 'xiaozhi_test_answer_decision_history'
]);
const identifier = value => '"' + value.replaceAll('"', '""') + '"';
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(row => row.name);
const has = name => tables.includes(name);
const columns = name => new Set(db.prepare(`PRAGMA table_info(${identifier(name)})`).all().map(item => item.name));
const stamp = new Date().toISOString();
const cleared = {};
try {
  // Messages and conversations reference one another. Validate all foreign keys
  // before committing the copied database after clearing both sides.
  db.exec('PRAGMA foreign_keys=OFF; PRAGMA busy_timeout=15000; PRAGMA secure_delete=ON; BEGIN IMMEDIATE;');
  try {
    for (const table of tables.filter(name => !preserved.has(name))) {
      cleared[table] = db.prepare(`DELETE FROM ${identifier(table)}`).run().changes;
    }
    if (has('platforms')) db.prepare("UPDATE platforms SET desired_state='STOPPED',runtime_updated_at=?,runtime_updated_by='安装模板重置'").run(stamp);
    if (has('devices')) db.exec("UPDATE devices SET status='OFFLINE',last_heartbeat=NULL,browser_control_json=NULL");
    if (has('accounts')) {
      const present = columns('accounts');
      const assignments = ["login_status=CASE WHEN enabled=0 THEN 'DISABLED' ELSE 'UNKNOWN' END"];
      for (const name of ['login_checked_at', 'login_message', 'login_source', 'login_evidence', 'login_url', 'platform_user_id', 'platform_user_name', 'platform_user_aliases', 'identity_updated_at', 'identity_source']) {
        if (present.has(name)) assignments.push(`${identifier(name)}=NULL`);
      }
      db.exec(`UPDATE accounts SET ${assignments.join(',')}`);
      // Cleared nicknames must be seeded again on the destination computer.
      // Keep schema migrations and explicit mini-program account bindings intact.
      if (has('schema_migrations')) db.prepare('DELETE FROM schema_migrations WHERE id=?').run('2026-09-11-weibo-main-account-name-v1');
    }
    if (has('system_settings')) db.prepare(`INSERT INTO system_settings(setting_key,encrypted_value,updated_at,updated_by)
      VALUES('operations.master_enabled','false',?,'安装模板重置')
      ON CONFLICT(setting_key) DO UPDATE SET encrypted_value='false',updated_at=excluded.updated_at,updated_by=excluded.updated_by`).run(stamp);
    const foreignKeys = db.prepare('PRAGMA foreign_key_check').all();
    if (foreignKeys.length) throw new Error(`Template has ${foreignKeys.length} broken foreign keys`);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  db.exec('PRAGMA foreign_keys=ON; VACUUM; PRAGMA wal_checkpoint(TRUNCATE);');
  const integrity = db.prepare('PRAGMA integrity_check').get().integrity_check;
  if (integrity !== 'ok') throw new Error('Template integrity check failed');
  console.log(JSON.stringify({ databasePath, integrity, cleared, knowledge: has('knowledge') ? db.prepare('SELECT COUNT(*) AS count FROM knowledge').get().count : 0 }));
} finally { db.close(); }
