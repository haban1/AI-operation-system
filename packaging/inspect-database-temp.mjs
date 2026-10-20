import { DatabaseSync } from 'node:sqlite';
const dbPath = process.argv[2];
const db = new DatabaseSync(dbPath, { readOnly: true });
const tables = db.prepare("SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
const result = { integrity: db.prepare('PRAGMA integrity_check').all(), tables: [] };
for (const table of tables) {
  const safe = '"' + table.name.replaceAll('"', '""') + '"';
  const count = db.prepare(`SELECT COUNT(*) AS count FROM ${safe}`).get();
  result.tables.push({ name: table.name, count: Number(count.count), columns: db.prepare(`PRAGMA table_info(${safe})`).all(), sql: table.sql });
}
const knowledgeColumns = result.tables.find(item => item.name === 'knowledge')?.columns || [];
if (knowledgeColumns.length) {
  result.knowledgeStatus = db.prepare("SELECT status, COUNT(*) AS count FROM knowledge GROUP BY status ORDER BY status").all();
  result.knowledgeCategory = db.prepare("SELECT category, subcategory, status, COUNT(*) AS count FROM knowledge GROUP BY category,subcategory,status ORDER BY category,subcategory,status").all();
  result.knowledgeSample = db.prepare("SELECT * FROM knowledge ORDER BY id LIMIT 5").all();
}
console.log(JSON.stringify(result, (_key, value) => typeof value === 'bigint' ? Number(value) : value, 2));
db.close();