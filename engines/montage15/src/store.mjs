import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AppError, validId } from './domain.mjs';

export async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try { await fs.writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 }); await fs.rename(temporary, file); }
  finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
}
export async function readJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT' && arguments.length > 1) return fallback; throw error; }
}
export async function listJson(directory) {
  const files = await fs.readdir(directory).catch(e => e.code === 'ENOENT' ? [] : Promise.reject(e));
  return Promise.all(files.filter(name => name.endsWith('.json')).map(name => readJson(path.join(directory, name))));
}

export class Store {
  constructor(root) { this.root = root; this.locks = new Map(); }
  async init() { for (const folder of ['assets', 'projects', 'revisions', 'jobs', 'renders', 'tmp', 'thumbnails']) await fs.mkdir(path.join(this.root, folder), { recursive: true, mode: 0o700 }); }
  file(kind, id) {
    if (!validId(id)) throw new AppError(404, 'NOT_FOUND', '记录不存在');
    return path.join(this.root, kind, `${id}.json`);
  }
  async get(kind, id) {
    const value = await readJson(this.file(kind, id), null);
    if (!value) throw new AppError(404, 'NOT_FOUND', '记录不存在');
    return value;
  }
  async put(kind, value) { await writeJson(this.file(kind, value.id), value); return value; }
  async all(kind) { return (await listJson(path.join(this.root, kind))).sort((a, b) => (b.updatedAt || b.createdAt || '').localeCompare(a.updatedAt || a.createdAt || '')); }
  async saveProject(project) {
    // Persist the immutable revision first. A failed current-pointer write keeps the old current project valid.
    const revisionFile = path.join(this.root, 'revisions', project.id, `${project.revision}.json`);
    await fs.mkdir(path.dirname(revisionFile), { recursive: true });
    const temporary = `${revisionFile}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, JSON.stringify(project, null, 2) + '\n', { mode: 0o600 });
      try { await fs.link(temporary, revisionFile); }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        if (JSON.stringify(await readJson(revisionFile)) !== JSON.stringify(project)) {
          const current = await readJson(this.file('projects', project.id), null);
          // A revision newer than the committed pointer was left by an interrupted save.
          // Callers serialize writes with the project lock. Committed history stays immutable.
          if (current && current.revision < project.revision) await fs.rename(temporary, revisionFile);
          else throw new AppError(409, 'REVISION_EXISTS', '该修订已存在，不能覆盖历史版本');
        }
      }
    } finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
    return this.put('projects', project);
  }
  async revision(id, revision) {
    if (!validId(id) || !Number.isInteger(revision) || revision < 1) throw new AppError(404, 'NOT_FOUND', '工程修订不存在');
    const value = await readJson(path.join(this.root, 'revisions', id, `${revision}.json`), null);
    if (!value) throw new AppError(404, 'NOT_FOUND', '工程修订不存在');
    return value;
  }
  async locked(key, fn) {
    const previous = this.locks.get(key) || Promise.resolve();
    const result = previous.catch(() => {}).then(fn);
    this.locks.set(key, result);
    try { return await result; } finally { if (this.locks.get(key) === result) this.locks.delete(key); }
  }
}
