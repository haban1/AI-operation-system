import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fail } from './errors.mjs';
import { exec, FFMPEG, hashFile, importAsset, probe } from './media.mjs';
import { VisualIndex } from './visual-index.mjs';
import { chooseSourceFolder } from './folder-picker.mjs';

const mediaTypes = new Map(Object.entries({ '.mp4': 'video', '.mov': 'video', '.m4v': 'video', '.webm': 'video', '.jpg': 'image', '.jpeg': 'image', '.png': 'image', '.webp': 'image' }));
const within = (root, file) => file.startsWith(root + path.sep);

export class SourceFolders {
  constructor(store, { visualIndex = new VisualIndex(store.root) } = {}) {
    this.store = store;
    this.running = new Map();
    this.visualIndex = visualIndex;
  }

  async init() {
    for (const source of await this.store.all('source-folders')) {
      if (source.status === 'indexing') {
        await this.store.put('source-folders', { ...source, status: 'interrupted', message: '索引被中断，可重新扫描', updatedAt: new Date().toISOString() });
      }
    }
  }

  view(source) {
    return { id: source.id, name: source.name, folderPath: source.folderPath, status: source.status,
      count: source.items?.length || 0, visualCount: (source.items || []).filter(item => item.visualStatus === 'ready').length, scanned: source.scanned || 0, total: source.total || 0,
      message: source.message, warnings: source.warnings || [], updatedAt: source.updatedAt };
  }

  async list() {
    return (await this.store.all('source-folders')).map(source => this.view(source));
  }

  async register(input) {
    if (Object.keys(input).some(key => key !== 'folderPath') || typeof input.folderPath !== 'string' || !path.isAbsolute(input.folderPath) || input.folderPath.includes('\0')) {
      fail(422, 'INVALID_SOURCE_FOLDER', '请选择本机素材文件夹，或填写完整文件夹路径');
    }
    const folderPath = await fs.realpath(input.folderPath).catch(() => null);
    if (!folderPath || !(await fs.stat(folderPath)).isDirectory()) fail(422, 'SOURCE_FOLDER_MISSING', '文件夹不存在或当前无法读取');
    const existing = (await this.store.all('source-folders')).find(source => source.folderPath === folderPath);
    if (existing) return existing;
    const source = { id: randomUUID(), name: path.basename(folderPath), folderPath, items: [], status: 'new', createdAt: new Date().toISOString() };
    await this.store.put('source-folders', source);
    return source;
  }

  async choose() {
    if (!this.picker) {
      this.pickerController = new AbortController();
      this.picker = chooseSourceFolder(this.store.root, { signal: this.pickerController.signal })
        .then(folderPath => this.register({ folderPath })).finally(() => { this.picker = null; });
    }
    return this.picker;
  }

  close() { this.pickerController?.abort(); }

  async scan(id) {
    const source = await this.store.get('source-folders', id);
    if (this.running.has(id)) return source;
    const next = { ...source, status: 'indexing', scanned: 0, total: 0, message: '正在查找照片和视频', warnings: [], updatedAt: new Date().toISOString() };
    await this.store.put('source-folders', next);
    const task = this.index(next).finally(() => this.running.delete(id));
    this.running.set(id, task);
    return next;
  }

  async index(source) {
    try {
      const files = [];
      const pending = [source.folderPath];
      while (pending.length) {
        const directory = pending.shift();
        for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
          if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
          const file = path.join(directory, entry.name);
          if (entry.isDirectory()) pending.push(file);
          else if (entry.isFile() && mediaTypes.has(path.extname(entry.name).toLowerCase())) files.push(file);
          if (files.length + pending.length > 5000) fail(422, 'SOURCE_FOLDER_TOO_LARGE', '该目录超过 5000 项，请选择更具体的素材文件夹');
        }
      }
      files.sort();
      source.total = files.length;
      const imported = await this.store.all('assets');
      const previous = new Map((source.items || []).map(item => [item.relativePath, item]));
      const previousByHash = new Map((source.items || []).map(item => [item.sourceSha256, item]));
      const items = [];
      await fs.mkdir(path.join(this.store.root, 'source-thumbnails'), { recursive: true });
      for (const file of files) {
        const relativePath = path.relative(source.folderPath, file);
        try {
          const stat = await fs.stat(file);
          if (stat.size > 512 * 1024 ** 2) throw new Error('超过单素材 512 MB');
          const sourceSha256 = await hashFile(file);
          const old = previous.get(relativePath) || previousByHash.get(sourceSha256);
          const existing = imported.find(asset => asset.sourceSha256 === sourceSha256);
          if (old?.sourceSha256 === sourceSha256) {
            const item = { ...old, name: path.basename(file), relativePath, bytes: stat.size };
            item.subject ||= source.name;
            if (item.type === 'video' && !item.metadataVersion) {
              const info = await probe(file);
              const video = info.streams.find(stream => stream.codec_type === 'video' && !stream.disposition?.attached_pic);
              item.duration = Number(video?.duration || info.format.duration);
            }
            item.metadataVersion = 2;
            if (!item.visualVersion || item.visualDuration !== item.duration) Object.assign(item, await this.visualIndex.describe(file, item.type, item.duration));
            items.push(item);
          }
          else {
            const type = mediaTypes.get(path.extname(file).toLowerCase());
            const info = await probe(file);
            const video = info.streams.find(stream => stream.codec_type === 'video' && !stream.disposition?.attached_pic);
            const duration = type === 'image' ? null : Number(video?.duration || info.format.duration);
            if (!video || (type === 'video' && (!duration || duration > 1800))) throw new Error('文件格式或时长不受支持');
            const item = { id: existing?.id || randomUUID(), name: path.basename(file), type, width: video.width, height: video.height,
              duration, metadataVersion: 2, bytes: stat.size, relativePath, sourceSha256, sourceId: source.id,
              description: existing?.description || relativePath, subject: existing?.subject || source.name, tags: existing?.tags || [], notesRevision: existing?.notesRevision || 0 };
            const thumbnail = path.join(this.store.root, 'source-thumbnails', item.id + '.jpg');
            await exec(FFMPEG, ['-v', 'error', '-nostdin', '-y', '-i', file, '-frames:v', '1', '-vf', 'scale=320:320:force_original_aspect_ratio=decrease', '-q:v', '3', thumbnail], { timeout: 30000, maxBuffer: 100000 });
            Object.assign(item, await this.visualIndex.describe(file, type, duration));
            items.push(item);
          }
        } catch (error) {
          source.warnings.push(`${relativePath}，${error.message?.slice(0, 80) || '读取失败'}`);
        }
        source.scanned += 1;
        source.message = `正在索引 ${source.scanned} / ${source.total}`;
        source.updatedAt = new Date().toISOString();
        await this.store.put('source-folders', source);
      }
      const uniqueItems = [...new Map(items.map(item => [item.sourceSha256, item])).values()];
      const visualCount = uniqueItems.filter(item => item.visualStatus === 'ready').length;
      await this.store.put('source-folders', { ...source, items: uniqueItems, status: 'ready', message: `已索引 ${uniqueItems.length} 份素材，${visualCount} 份有本机画面线索`, updatedAt: new Date().toISOString() });
    } catch (error) {
      await this.store.put('source-folders', { ...source, status: 'failed', message: '索引失败，请检查文件夹后重新扫描', warnings: [error.message], updatedAt: new Date().toISOString() });
    }
  }

  async items(id) {
    return (await this.store.get('source-folders', id)).items || [];
  }

  async assets(project) {
    const assets = await this.store.all('assets');
    if (!project.brief?.sourceId) return assets;
    const items = await this.items(project.brief.sourceId);
    const merged = new Map(assets.map(asset => [asset.id, asset]));
    for (const item of items) {
      const imported = merged.get(item.id);
      const asset = { ...item, ...imported, frames: item.frames };
      asset.description = [asset.description, item.visualDescription].filter(Boolean).join('\n');
      merged.set(item.id, asset);
    }
    return [...merged.values()];
  }

  async materialize(project, plan) {
    if (!project.brief?.sourceId) return this.store.all('assets');
    const ids = [...new Set(plan.operations.filter(operation => operation.type === 'slot').map(operation => operation.assetId))];
    for (const id of ids) await this.import(project.brief.sourceId, id);
    return this.assets(project);
  }

  async repair(sourceId) {
    await this.running.get(sourceId);
    const items = await this.items(sourceId);
    let restored = 0;
    for (const item of items) {
      const asset = await this.store.get('assets', item.id).catch(() => null);
      if (asset && await hashFile(asset.mediaFile).catch(() => null) !== asset.mediaSha256) {
        await this.import(sourceId, item.id, { repair: true });
        restored += 1;
      }
    }
    return restored;
  }

  async import(sourceId, id, { repair = false } = {}) {
    return this.store.locked('asset-import', async () => {
      const source = await this.store.get('source-folders', sourceId);
      const item = source.items.find(entry => entry.id === id);
      if (!item) return this.store.get('assets', id);
      const existing = await this.store.get('assets', id).catch(() => null);
      if (existing && await hashFile(existing.mediaFile).catch(() => null) === existing.mediaSha256) return existing;
      if (existing && !repair) fail(409, 'SOURCE_ASSET_CHANGED', '已导入素材缺失，请先使用重新关联素材恢复');
      const filename = path.resolve(source.folderPath, item.relativePath);
      const resolved = await fs.realpath(filename).catch(() => null);
      if (!resolved || !within(source.folderPath, resolved)) fail(409, 'SOURCE_FILE_MISSING', '来源素材已移动，请重新关联文件夹');
      const handle = await fs.open(resolved, constants.O_RDONLY | constants.O_NOFOLLOW);
      const stream = handle.createReadStream({ start: 0 });
      stream.headers = { 'x-file-name': encodeURIComponent(item.name), 'content-length': String(item.bytes) };
      try {
        const temporaryId = existing ? randomUUID() : id;
        const asset = await importAsset(stream, this.store, { id: temporaryId });
        if (asset.sourceSha256 !== item.sourceSha256) {
          await fs.rm(path.dirname(asset.mediaFile), { recursive: true, force: true });
          await fs.rm(asset.thumbnailFile, { force: true });
          await fs.rm(this.store.file('assets', temporaryId), { force: true });
          fail(409, 'SOURCE_FILE_CHANGED', '来源文件已变化，请重新扫描后再制作');
        }
        const saved = await this.store.put('assets', { ...asset, id, sourceId, description: existing?.description || item.description, subject: existing?.subject || item.subject, tags: existing?.tags || item.tags, notesRevision: existing?.notesRevision || item.notesRevision });
        if (temporaryId !== id) await fs.rm(this.store.file('assets', temporaryId), { force: true });
        return saved;
      } finally {
        stream.destroy();
        await handle.close().catch(() => {});
      }
    });
  }
}
