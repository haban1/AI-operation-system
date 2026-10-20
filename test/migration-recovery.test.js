import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { analyzeRecoveryMigration } from '../scripts/migrate-recovery-data.mjs';

const fileHash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

test('迁移dry-run不写源库、不创建目标库且不迁移运行态与PUBLISH_STATUS_CHECK', () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'recovery-migration-')); const source=path.join(dir,'source.db'); const target=path.join(dir,'target.db');
  const db=new DatabaseSync(source);
  db.exec(`CREATE TABLE accounts(id INTEGER PRIMARY KEY,name TEXT); CREATE TABLE agent_jobs(id INTEGER PRIMARY KEY,job_type TEXT,status TEXT); CREATE TABLE runtime_blocks(id INTEGER PRIMARY KEY,status TEXT);`);
  db.prepare('INSERT INTO accounts VALUES(?,?)').run(1,'safe-account');
  for (const row of [[1,'PUBLISH','SUCCESS'],[2,'PUBLISH_STATUS_CHECK','SUCCESS'],[3,'REPLY','RUNNING'],[4,'COLLECT_MESSAGES','QUEUED']]) db.prepare('INSERT INTO agent_jobs VALUES(?,?,?)').run(...row);
  db.prepare('INSERT INTO runtime_blocks VALUES(?,?)').run(1,'ACTIVE'); db.close();
  const before=fileHash(source); const report=analyzeRecoveryMigration({sourcePath:source,targetPath:target,apply:false});
  assert.equal(report.mode,'DRY_RUN'); assert.equal(report.sourceUnchanged,true); assert.equal(fileHash(source),before); assert.equal(fs.existsSync(target),false);
  assert.deepEqual(report.tables.agent_jobs,{read:4,selected:1,skipped:3,written:0,conflicts:0});
  assert.ok(report.excludedTables.includes('runtime_blocks'));
  fs.rmSync(dir,{recursive:true,force:true});
});
