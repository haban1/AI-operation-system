process.env.DATABASE_PATH = './data/db-check-temp.db';
process.env.INSTANCE_LOCK_ENABLED = 'false';
const m = await import('./src/db.js');
console.log(m.rows("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('issue_diagnoses','runtime_blocks') ORDER BY name"));
console.log(m.rows('PRAGMA table_info(issues)').filter(x => ['resolution_type','diagnosis_status','block_scope'].includes(x.name)));
m.db.close();
