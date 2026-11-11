import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

test('an intentionally empty knowledge base stays empty across restarts and missing legacy seed migrations', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tianhe-empty-knowledge-'));
  const databasePath = path.join(dir, 'runtime.db');
  const initialize = () => {
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', "const {db}=await import('./src/db.js'); db.close();"], {
      cwd: path.resolve(import.meta.dirname, '..'), encoding: 'utf8', windowsHide: true,
      env: { ...process.env, NODE_ENV: 'test', TIANHE_SKIP_DOTENV: 'true', DATABASE_PATH: databasePath,
        INSTANCE_LOCK_ENABLED: 'false', LOCAL_AGENT_AUTO_START: 'false', AUTO_COLLECT_ENABLED: 'false' }
    });
    assert.equal(child.status, 0, child.stderr);
  };
  try {
    initialize();
    let database = new DatabaseSync(databasePath);
    const originalCount = database.prepare('SELECT COUNT(*) AS n FROM knowledge').get().n;
    const previousMaxId = database.prepare('SELECT MAX(id) AS id FROM knowledge').get().id;
    const accounts = database.prepare('SELECT id,platform_code,profile_name FROM accounts ORDER BY id').all();
    assert.ok(originalCount > 0, 'new installations retain their default examples');
    database.exec('BEGIN IMMEDIATE');
    database.prepare('INSERT INTO system_settings VALUES(?,?,?,?)').run('knowledge.seed_examples_disabled', 'true', new Date().toISOString(), 'KNOWLEDGE_RESET');
    database.exec("DELETE FROM knowledge_aliases; DELETE FROM knowledge_alias_generation_tasks; DELETE FROM knowledge; DELETE FROM schema_migrations WHERE id='2026-08-12-platform-knowledge-isolation-markers-v1'; COMMIT");
    database.close();
    for (let restart = 0; restart < 2; restart += 1) {
      initialize();
      database = new DatabaseSync(databasePath);
      assert.equal(database.prepare('SELECT COUNT(*) AS n FROM knowledge').get().n, 0);
      assert.deepEqual(database.prepare('SELECT id,platform_code,profile_name FROM accounts ORDER BY id').all(), accounts);
      database.close();
    }
    database = new DatabaseSync(databasePath);
    const stamp = new Date().toISOString();
    const next = database.prepare("INSERT INTO knowledge(question,answer,keywords,status,version,created_at,updated_at) VALUES('new','answer','','DRAFT',1,?,?)").run(stamp, stamp);
    assert.ok(Number(next.lastInsertRowid) > previousMaxId, 'knowledge IDs are retained independently of version reset');
    assert.equal(database.prepare('SELECT version FROM knowledge WHERE id=?').get(next.lastInsertRowid).version, 1);
    database.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
