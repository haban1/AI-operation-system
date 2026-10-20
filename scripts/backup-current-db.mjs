import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const [source, destination] = process.argv.slice(2);
if (!source || !destination) throw new Error('Usage: node backup-current-db.mjs <source> <destination>');
if (!fs.existsSync(source)) throw new Error(`Source database not found: ${source}`);
if (fs.existsSync(destination)) throw new Error(`Destination already exists: ${destination}`);
fs.mkdirSync(path.dirname(destination), { recursive: true });
const sourceDb = new DatabaseSync(source, { readOnly: true });
const escaped = destination.replaceAll("'", "''");
sourceDb.exec(`VACUUM INTO '${escaped}'`);
sourceDb.close();
const backupDb = new DatabaseSync(destination, { readOnly: true });
const integrity = backupDb.prepare('PRAGMA integrity_check').all();
const quick = backupDb.prepare('PRAGMA quick_check').all();
const tableCount = backupDb.prepare("SELECT count(*) AS count FROM sqlite_master WHERE type='table'").get().count;
backupDb.close();
console.log(JSON.stringify({ source, destination, integrity, quick, tableCount }, null, 2));
