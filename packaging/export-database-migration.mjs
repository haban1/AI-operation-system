import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync, backup } from 'node:sqlite';

const [sourcePath, outputDir] = process.argv.slice(2);
if (!sourcePath || !outputDir) throw new Error('Usage: source.db outputDir');
fs.mkdirSync(outputDir, { recursive: true });
const csvDir = path.join(outputDir, 'CSV_全表导出');
fs.mkdirSync(csvDir, { recursive: true });
const backupPath = path.join(outputDir, '天河AI数字员工平台-业务数据库-20260814.db');
if (fs.existsSync(backupPath)) fs.rmSync(backupPath, { force: true });
const source = new DatabaseSync(sourcePath);
await backup(source, backupPath);
source.close();
const db = new DatabaseSync(backupPath, { readOnly: true });
const integrity = db.prepare('PRAGMA integrity_check').all().map(r => r.integrity_check);
if (integrity.length !== 1 || integrity[0] !== 'ok') throw new Error(`Backup integrity failed: ${integrity.join(',')}`);
const objects = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY CASE type WHEN 'table' THEN 1 WHEN 'index' THEN 2 WHEN 'trigger' THEN 3 WHEN 'view' THEN 4 ELSE 5 END,name").all();
const tables = objects.filter(o => o.type === 'table');
const quoteId = name => `"${String(name).replaceAll('"','""')}"`;
const jsonValue = value => typeof value === 'bigint' ? Number(value) : Buffer.isBuffer(value) ? { $blobBase64: value.toString('base64') } : value;
const sqlValue = value => {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'bigint' || typeof value === 'number') return String(value);
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return `X'${Buffer.from(value).toString('hex')}'`;
  return `'${String(value).replaceAll("'", "''")}'`;
};
const csvValue = value => {
  if (value === null || value === undefined) return '';
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) value = `base64:${Buffer.from(value).toString('base64')}`;
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"','""')}"` : text;
};
const allData = { exportedAt: new Date().toISOString(), sourceDatabase: path.basename(sourcePath), integrity, tables: {} };
const manifest = [];
let dump = ['PRAGMA foreign_keys=OFF;', 'BEGIN TRANSACTION;'];
for (const table of tables) dump.push(`${table.sql};`);
for (const table of tables) {
  const name = String(table.name);
  const columns = db.prepare(`PRAGMA table_info(${quoteId(name)})`).all();
  const rows = db.prepare(`SELECT * FROM ${quoteId(name)}`).all();
  const normalizedRows = rows.map(row => Object.fromEntries(Object.entries(row).map(([k,v]) => [k,jsonValue(v)])));
  allData.tables[name] = { columns: columns.map(c => ({ ...c, cid:Number(c.cid), notnull:Number(c.notnull), pk:Number(c.pk) })), rows: normalizedRows };
  manifest.push({ table: name, rows: rows.length, columns: columns.length });
  const headers = columns.map(c => String(c.name));
  const csv = ['\uFEFF' + headers.map(csvValue).join(','), ...rows.map(row => headers.map(h => csvValue(row[h])).join(','))].join('\r\n');
  fs.writeFileSync(path.join(csvDir, `${name}.csv`), csv, 'utf8');
  if (rows.length) {
    const columnSql = headers.map(quoteId).join(',');
    for (const row of rows) dump.push(`INSERT INTO ${quoteId(name)}(${columnSql}) VALUES(${headers.map(h => sqlValue(row[h])).join(',')});`);
  }
}
for (const object of objects.filter(o => o.type !== 'table')) dump.push(`${object.sql};`);
try {
  const sequences = db.prepare('SELECT name,seq FROM sqlite_sequence').all();
  if (sequences.length) {
    dump.push('DELETE FROM sqlite_sequence;');
    for (const seq of sequences) dump.push(`INSERT INTO sqlite_sequence(name,seq) VALUES(${sqlValue(seq.name)},${sqlValue(seq.seq)});`);
  }
} catch {}
dump.push('COMMIT;', 'PRAGMA foreign_keys=ON;');
fs.writeFileSync(path.join(outputDir, '数据库完整导出-结构与数据.sql'), '\uFEFF' + dump.join('\r\n'), 'utf8');
fs.writeFileSync(path.join(outputDir, '数据库完整导出-全表数据.json'), JSON.stringify(allData, null, 2), 'utf8');
fs.writeFileSync(path.join(outputDir, '数据库表清单.json'), JSON.stringify({ exportedAt: allData.exportedAt, integrity, databaseBytes: fs.statSync(backupPath).size, tables: manifest }, null, 2), 'utf8');
console.log(JSON.stringify({ backupPath, integrity, databaseBytes: fs.statSync(backupPath).size, tables: manifest }, null, 2));
db.close();
