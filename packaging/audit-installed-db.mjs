import { DatabaseSync } from 'node:sqlite';
const path = process.argv[2];
const db = new DatabaseSync(path, { readOnly: true });
const has = name => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
const count = name => has(name) ? db.prepare(`SELECT count(*) AS count FROM ${name}`).get().count : -1;
const result = {
  integrity: db.prepare('PRAGMA integrity_check').all().map(x => Object.values(x)[0]),
  quick: db.prepare('PRAGMA quick_check').all().map(x => Object.values(x)[0]),
  tableCount: db.prepare("SELECT count(*) AS count FROM sqlite_master WHERE type='table'").get().count,
  counts: Object.fromEntries(['platforms','accounts','knowledge','knowledge_aliases','messages','publish_tasks','agent_jobs','system_settings'].map(t => [t,count(t)])),
  platformStates: has('platforms') ? db.prepare('SELECT code,desired_state FROM platforms ORDER BY sort_order').all() : [],
  activeJobs: has('agent_jobs') ? db.prepare("SELECT count(*) AS count FROM agent_jobs WHERE status IN ('QUEUED','RUNNING','CLAIMED','DISPATCHED')").get().count : -1
};
db.close();
console.log(JSON.stringify(result));
