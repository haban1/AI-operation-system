import { DatabaseSync } from 'node:sqlite';
const [sourcePath, backupPath] = process.argv.slice(2);
function tableCounts(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((row) => row.name);
  const result = {};
  for (const name of names) result[name] = db.prepare(`SELECT count(*) AS count FROM "${name.replaceAll('"', '""')}"`).get().count;
  db.close();
  return result;
}
const source = tableCounts(sourcePath);
const backup = tableCounts(backupPath);
console.log(JSON.stringify({ source, backup, equal: JSON.stringify(source) === JSON.stringify(backup) }, null, 2));
