import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { AppError, fail } from './errors.mjs';

export const folderLimits = { files: 5000, fileBytes: 512 * 1024 ** 2, totalBytes: 5 * 1024 ** 3 };
const extensions = /\.(mp4|mov|m4v|webm|jpg|jpeg|png|webp)$/i;

export class BrowserFolders {
  constructor(store) { this.store = store; }

  async create(input) {
    const { name, fileCount, totalBytes } = input;
    if (Object.keys(input).some(k => !['name', 'fileCount', 'totalBytes'].includes(k))
      || typeof name !== 'string' || !name.trim() || name.length > 150 || /[\\/:\x00-\x1f]/.test(name)
      || !Number.isSafeInteger(fileCount) || fileCount < 1 || fileCount > folderLimits.files
      || !Number.isSafeInteger(totalBytes) || totalBytes < 1 || totalBytes > folderLimits.totalBytes) {
      fail(422, 'INVALID_FOLDER_UPLOAD', '请选择照片或视频文件夹，最多 5000 个文件、合计 5 GB');
    }
    const id = randomUUID(), folderPath = path.join(this.store.root, 'source-uploads', id);
    await fs.mkdir(folderPath, { recursive: true, mode: 0o700 });
    return this.store.put('source-folders', { id, name: name.trim(), folderPath, origin: 'browser',
      status: 'uploading', items: [], uploads: [], fileCount, totalBytes, receivedBytes: 0,
      message: '正在导入文件夹', createdAt: new Date().toISOString() });
  }

  async receive(id, req) {
    return this.store.locked(`folder-upload:${id}`, async () => {
      const source = await this.store.get('source-folders', id);
      const root = path.join(this.store.root, 'source-uploads', id);
      if (source.origin !== 'browser' || source.folderPath !== root || source.status !== 'uploading') {
        fail(409, 'FOLDER_UPLOAD_CLOSED', '请重新选择文件夹后导入');
      }
      let relative;
      try { relative = decodeURIComponent(String(req.headers['x-file-name'] || '')); } catch {}
      if (!relative || relative.length > 500 || /[\\:\x00-\x1f]/.test(relative)
        || relative.split('/').some(p => !p || p.startsWith('.') || p.trim() !== p)
        || !extensions.test(relative)) fail(422, 'INVALID_FOLDER_FILE', '仅支持文件夹内的照片和视频');
      if (source.uploads.some(item => item.path === relative)) fail(409, 'FOLDER_FILE_EXISTS', '该文件已导入，请勿重复上传');
      if (source.uploads.length >= source.fileCount) fail(413, 'FOLDER_FILE_LIMIT', '文件数量超过所选范围');
      const declared = Number(req.headers['content-length'] || 0);
      const remaining = source.totalBytes - source.receivedBytes;
      if (!Number.isSafeInteger(declared) || declared < 0 || declared > folderLimits.fileBytes || declared > remaining) {
        fail(413, 'FOLDER_SIZE_LIMIT', '单个文件不能超过 512 MB，文件夹合计不能超过 5 GB');
      }
      const target = path.join(root, ...relative.split('/'));
      const temporary = path.join(this.store.root, 'tmp', randomUUID() + '.upload');
      let bytes = 0;
      try {
        await pipeline(req, new Transform({ transform(chunk, encoding, done) {
          bytes += chunk.length;
          if (bytes > folderLimits.fileBytes || bytes > remaining) return done(new AppError(413, 'FOLDER_SIZE_LIMIT', '文件超过导入大小限制'));
          done(null, chunk);
        } }), createWriteStream(temporary, { flags: 'wx', mode: 0o600 }));
        if (!bytes) fail(422, 'EMPTY_FOLDER_FILE', '文件为空，请选择有效照片或视频');
        await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
        await fs.rename(temporary, target);
        source.uploads.push({ path: relative, bytes });
        source.receivedBytes += bytes;
        source.updatedAt = new Date().toISOString();
        await this.store.put('source-folders', source);
      } finally { await fs.rm(temporary, { force: true }); }
      return source;
    });
  }
}
