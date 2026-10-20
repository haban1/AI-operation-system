import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

export function copyModelCache(source, destination) {
  const boundary = fs.realpathSync(source);
  const within = candidate => {
    const relative = path.relative(boundary, fs.realpathSync(candidate));
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Model cache reference leaves its source directory');
    return candidate;
  };
  let copied = 0;
  function visit(directory, target) {
    fs.mkdirSync(target, { recursive: true });
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (['blobs', '.locks', '__pycache__'].includes(entry.name)) continue;
      const origin = within(path.join(directory, entry.name));
      const output = path.join(target, entry.name);
      if (entry.isDirectory()) { visit(origin, output); continue; }
      let resolved = origin;
      if (fs.statSync(origin).size < 256) {
        const reference = fs.readFileSync(origin, 'utf8').trim();
        if (/^(?:\.\.[\\/])+blobs[\\/][a-f0-9]{40,64}$/i.test(reference)) {
          resolved = within(path.resolve(directory, reference.replaceAll('\\', '/')));
        }
      }
      fs.copyFileSync(resolved, output);
      copied++;
    }
  }
  visit(boundary, destination);
  return copied;
}

export function prepareRagData(sourceRoot, destinationRoot) {
  const sourceDb = path.join(sourceRoot, 'data/rag.db');
  const destinationDb = path.join(destinationRoot, 'data/rag.db');
  if (fs.existsSync(destinationDb)) throw new Error('RAG template destination already exists');
  fs.mkdirSync(path.dirname(destinationDb), { recursive: true });
  const source = new DatabaseSync(sourceDb, { readOnly: true });
  try { source.exec(`VACUUM INTO '${destinationDb.replaceAll("'", "''")}'`); } finally { source.close(); }
  const db = new DatabaseSync(destinationDb);
  try {
    db.exec('PRAGMA foreign_keys=OFF; PRAGMA secure_delete=ON; BEGIN IMMEDIATE;');
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(item => item.name));
    for (const table of ['trace_candidates', 'trace_feedback', 'trace_spans', 'trace_runs', 'idempotency_keys', 'evaluation_cases', 'evaluation_runs']) {
      if (tables.has(table)) db.exec(`DELETE FROM ${table}`);
    }
    const uploads = path.join(destinationRoot, 'data/uploads');
    fs.mkdirSync(uploads, { recursive: true });
    const boundary = fs.realpathSync(sourceRoot);
    for (const document of db.prepare('SELECT document_id,document_version,source_path FROM document_versions').all()) {
      const filename = path.win32.basename(document.source_path);
      const local = path.resolve(sourceRoot, document.source_path.replaceAll('\\', '/'));
      const origin = fs.existsSync(local) ? local : path.join(sourceRoot, 'data/uploads', filename);
      const relative = path.relative(boundary, fs.realpathSync(origin));
      if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Document source leaves the RAG project');
      fs.copyFileSync(origin, path.join(uploads, filename));
      db.prepare('UPDATE document_versions SET source_path=? WHERE document_id=? AND document_version=?').run('data/uploads/' + filename, document.document_id, document.document_version);
    }
    if (db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('RAG snapshot has invalid foreign keys');
    db.exec('COMMIT; PRAGMA foreign_keys=ON; VACUUM; PRAGMA wal_checkpoint(TRUNCATE);');
    if (db.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') throw new Error('RAG snapshot integrity check failed');
    return {
      documents: db.prepare('SELECT COUNT(*) AS count FROM documents').get().count,
      chunks: db.prepare('SELECT COUNT(*) AS count FROM chunks').get().count,
      releases: db.prepare('SELECT COUNT(*) AS count FROM releases').get().count
    };
  } finally { db.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [source, target] = process.argv.slice(2);
  if (!source || !target || path.resolve(source) === path.resolve(target)) throw new Error('Usage: prepare-rag-bundle.mjs <source-rag> <new-staging-rag>');
  const data = prepareRagData(source, target);
  const modelFiles = copyModelCache(path.join(source, 'models'), path.join(target, 'models'));
  console.log(JSON.stringify({ ...data, modelFiles }));
}
