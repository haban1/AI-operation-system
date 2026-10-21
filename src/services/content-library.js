import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const execFileAsync = promisify(execFile);
const sourceKeys = { automatic: 'contentLibrarySignalRoot', editing: 'contentLibraryEditingRoot', creation: 'contentLibraryCreationRoot' };
const sourceTitles = { automatic: '自动化成片', editing: '素材剪辑', creation: 'AIGC 创作' };
const formats = { '.mp4': ['video', 'video/mp4'], '.mov': ['video', 'video/quicktime'], '.m4v': ['video', 'video/x-m4v'], '.webm': ['video', 'video/webm'], '.png': ['image', 'image/png'], '.jpg': ['image', 'image/jpeg'], '.jpeg': ['image', 'image/jpeg'], '.webp': ['image', 'image/webp'] };
const idPattern = /^[a-f0-9]{32}$/;
const filePattern = /^[a-f0-9]{64}\.(?:mp4|mov|m4v|webm|png|jpg|jpeg|webp)$/;
const MAX_CATALOG_BYTES = 8 * 1024 * 1024;

export class ContentLibraryError extends Error {
  constructor(statusCode, code, message) { super(message); this.statusCode = statusCode; this.code = code; }
}
const libraryError = (code, message, status = 409) => new ContentLibraryError(status, code, message);
const boundedText = (value, length) => String(value || '').slice(0, length);
function inside(root, target) { const relative = path.relative(root, target); return Boolean(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); }
function sourceRef(item) { return { source: item.source, sourceId: item.sourceId }; }

export async function inspectContentMedia(filePath, { ffprobePath, timeoutMs = 10000 } = {}) {
  const extension = path.extname(filePath).toLowerCase();
  if (!formats[extension]) throw libraryError('CONTENT_MEDIA_INVALID', '不支持的媒体格式');
  if (!ffprobePath) {
    try {
      const module = await import('ffprobe-static');
      const bundled = typeof module.default === 'string' ? module.default : module.default?.path;
      if (bundled) { await fsp.access(bundled, fs.constants.X_OK); ffprobePath = bundled; }
    } catch {}
    // ffprobe-static does not ship a Linux ARM64 binary. Local/container builds
    // can supply the system ffprobe executable without changing media checks.
    ffprobePath ||= 'ffprobe';
  }
  if (!ffprobePath) throw libraryError('CONTENT_MEDIA_UNAVAILABLE', '媒体检测工具不可用');
  const { stdout } = await execFileAsync(ffprobePath, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', '--', filePath], {
    timeout: Math.max(100, Math.min(10000, timeoutMs)), maxBuffer: 1024 * 1024, windowsHide: true,
  });
  const probe = JSON.parse(stdout);
  const video = probe.streams?.find(stream => stream.codec_type === 'video');
  if (!video || !Number.isFinite(Number(video.width)) || !Number.isFinite(Number(video.height)) || video.width <= 0 || video.height <= 0) {
    throw libraryError('CONTENT_MEDIA_INVALID', '文件没有有效图像或视频轨道');
  }
  const [type, mimeType] = formats[extension];
  const duration = Number(probe.format?.duration || video.duration);
  const container = String(probe.format?.format_name || '').split(',');
  if (type === 'video' && (!Number.isFinite(duration) || duration <= 0 || !container.includes(extension === '.webm' ? 'webm' : 'mov'))) {
    throw libraryError('CONTENT_MEDIA_INVALID', '文件不是有效视频');
  }
  const imageCodecs = { '.png': 'png', '.jpg': 'mjpeg', '.jpeg': 'mjpeg', '.webp': 'webp' };
  if (type === 'image' && video.codec_name !== imageCodecs[extension]) throw libraryError('CONTENT_MEDIA_INVALID', '图片格式与扩展名不一致');
  return { type, mimeType, width: Number(video.width), height: Number(video.height), durationSeconds: type === 'video' ? duration : null, videoCodec: video.codec_name, hasAudio: Boolean(probe.streams?.some(stream => stream.codec_type === 'audio')) };
}

export function parseContentRange(value, size) {
  if (!value) return { status: 200, start: 0, end: size - 1 };
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(value));
  if (!match || (!match[1] && !match[2]) || size <= 0) return null;
  let start, end;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return null;
    start = Math.max(0, size - suffix); end = size - 1;
  } else {
    start = Number(match[1]); end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= size) return null;
  return { status: 206, start, end };
}

export function createContentLibrary(config, {
  collectSources = async () => (await import('./content-library-sources.js')).collectContentLibrarySources(config),
  inspectMedia = inspectContentMedia, ffprobePath, cacheMs = 15000, maxSyncMs = 12000, maxImportsPerSync = 40,
} = {}) {
  const directory = path.resolve(config.contentLibraryDir || path.join(path.dirname(config.databasePath), 'content-library'));
  const maxFileBytes = Math.max(1, Number(config.contentLibraryMaxFileBytes) || 2 * 1024 * 1024 * 1024);
  const catalogPath = path.join(directory, 'catalog.json');
  let catalog = { version: 1, items: [], sources: [], lastSyncedAt: null };
  let loading, inFlight, lastCheck = 0, scanCursor = 0;
  let libraryRoot;

  async function initialize() {
    if (loading) return loading;
    loading = (async () => {
      await fsp.mkdir(directory, { recursive: true, mode: 0o700 });
      libraryRoot = await fsp.realpath(directory);
      await fsp.mkdir(path.join(libraryRoot, 'media'), { recursive: true, mode: 0o700 });
      const mediaRoot = await fsp.realpath(path.join(libraryRoot, 'media'));
      if (!inside(libraryRoot, mediaRoot)) throw libraryError('CONTENT_LIBRARY_INVALID', '成片库目录配置无效', 500);
      let handle;
      try {
        handle = await fsp.open(catalogPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > MAX_CATALOG_BYTES) throw new Error('Invalid catalog');
        const buffer = Buffer.alloc(MAX_CATALOG_BYTES + 1);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        if (bytesRead > MAX_CATALOG_BYTES) throw new Error('Invalid catalog');
        const parsed = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'));
        if (parsed.version !== 1 || !Array.isArray(parsed.items) || parsed.items.length > 1000) throw new Error('Invalid catalog');
        for (const item of parsed.items) {
          if (!idPattern.test(item.id) || !Object.hasOwn(sourceKeys, item.source) || !filePattern.test(item.filename)
            || !/^[a-f0-9]{64}$/.test(item.sha256) || !item.filename.startsWith(item.sha256 + '.')
            || !Number.isSafeInteger(item.sizeBytes) || item.sizeBytes <= 0 || !['video', 'image'].includes(item.mediaType)) throw new Error('Invalid item');
        }
        catalog = { version: 1, items: parsed.items, sources: Array.isArray(parsed.sources) ? parsed.sources : [], lastSyncedAt: typeof parsed.lastSyncedAt === 'string' ? parsed.lastSyncedAt : null };
      } catch (error) {
        if (error.code !== 'ENOENT') throw libraryError('CONTENT_LIBRARY_INVALID', '成片库索引无法读取，原文件已保留', 500);
      } finally { await handle?.close(); }
    })();
    try { await loading; } catch (error) { loading = null; throw error; }
  }

  function publicItem(item) {
    return { id: item.id, source: item.source, sourceId: item.sourceId, title: item.title, body: item.body, createdAt: item.createdAt,
      mediaType: item.mediaType, mimeType: item.mimeType, sizeBytes: item.sizeBytes, sha256: item.sha256,
      reviewStatus: item.reviewStatus, sourceStatus: boundedText(item.sourceStatus, 200), artifactType: item.artifactType, mediaUrl: `/api/content-library/${item.id}/media` };
  }
  function snapshot() {
    return { items: catalog.items.map(publicItem).sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt))), sources: catalog.sources, lastSyncedAt: catalog.lastSyncedAt };
  }
  async function save(next) {
    const encoded = JSON.stringify(next);
    if (Buffer.byteLength(encoded) > MAX_CATALOG_BYTES) throw libraryError('CONTENT_LIBRARY_FULL', '成片库索引已达到容量上限');
    const temporary = path.join(libraryRoot, `.catalog-${crypto.randomUUID()}.tmp`);
    let handle;
    try {
      handle = await fsp.open(temporary, 'wx', 0o600);
      await handle.writeFile(encoded); await handle.sync(); await handle.close(); handle = null;
      await fsp.rename(temporary, catalogPath);
      catalog = next;
    } finally { await handle?.close(); await fsp.rm(temporary, { force: true }); }
  }
  async function openStored(item) {
    if (!item || !filePattern.test(item.filename)) throw libraryError('CONTENT_NOT_FOUND', '成片不存在', 404);
    const requested = path.join(libraryRoot, 'media', item.filename);
    let handle;
    try {
      const resolved = await fsp.realpath(requested);
      if (!inside(path.join(libraryRoot, 'media'), resolved)) throw new Error('Invalid path');
      handle = await fsp.open(requested, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size !== item.sizeBytes) throw new Error('Invalid file');
      return { handle, stat, filePath: requested };
    } catch {
      await handle?.close();
      throw libraryError('CONTENT_FILE_UNAVAILABLE', '成片文件不可用，请重新同步', 409);
    }
  }
  async function importEntry(entry, items, deadline) {
    if (!Object.hasOwn(sourceKeys, entry.source) || !String(entry.sourceId || '').trim() || String(entry.sourceId).length > 512) throw new Error('Invalid source');
    const configuredRoot = config[sourceKeys[entry.source]];
    if (!configuredRoot || !path.isAbsolute(entry.filePath || '') || !path.isAbsolute(entry.rootPath || '')) throw new Error('Invalid root');
    const root = await fsp.realpath(configuredRoot);
    if (await fsp.realpath(entry.rootPath) !== root) throw new Error('Wrong root');
    const sourcePath = await fsp.realpath(entry.filePath);
    if (!inside(root, sourcePath)) throw new Error('Source outside root');
    const extension = path.extname(sourcePath).toLowerCase();
    if (!formats[extension]) throw new Error('Unsupported media');
    const input = await fsp.open(sourcePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    let temporary;
    try {
      const stat = await input.stat();
      if (!stat.isFile() || stat.size <= 0 || stat.size > maxFileBytes) throw new Error('Invalid source size');
      const fingerprint = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
      const previous = items.find(item => item.source === entry.source && item.sourceId === entry.sourceId && item.sourceFingerprint === fingerprint);
      if (previous) {
        try { const stored = await openStored(previous); await stored.handle.close(); return { ...previous, title: boundedText(entry.title, 500) || previous.title, body: boundedText(entry.body, 20000), sourceStatus: boundedText(entry.sourceStatus, 200), reviewStatus: entry.reviewStatus === 'selected' ? 'selected' : 'unreviewed', artifactType: ['final_video', 'video_clip', 'image'].includes(entry.artifactType) ? entry.artifactType : previous.artifactType }; } catch {}
      }
      const remaining = Math.max(100, deadline - Date.now());
      const signal = AbortSignal.timeout(remaining);
      temporary = path.join(libraryRoot, 'media', `.import-${crypto.randomUUID()}${extension}`);
      const hash = crypto.createHash('sha256');
      let copied = 0;
      const meter = new Transform({ transform(chunk, _encoding, callback) {
        copied += chunk.length;
        if (copied > maxFileBytes || copied > stat.size) return callback(new Error('Source changed'));
        hash.update(chunk); callback(null, chunk);
      } });
      await pipeline(input.createReadStream({ autoClose: false }), meter, fs.createWriteStream(temporary, { flags: 'wx', mode: 0o600 }), { signal });
      const after = await input.stat();
      if (copied !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs || after.size !== stat.size) throw new Error('Source changed');
      const sha256 = hash.digest('hex');
      const knownMedia = items.find(item => item.sha256 === sha256 && item.filename.endsWith(extension));
      const metadata = knownMedia?.meta || await inspectMedia(temporary, { ffprobePath, timeoutMs: Math.max(100, deadline - Date.now()) });
      if (!['video', 'image'].includes(metadata.type) || metadata.type !== formats[extension][0]) throw new Error('Invalid media');
      const filename = `${sha256}${extension}`;
      const destination = path.join(libraryRoot, 'media', filename);
      const id = crypto.createHash('sha256').update(`${entry.source}\0${entry.sourceId}\0${sha256}`).digest('hex').slice(0, 32);
      if (items.length >= 1000 && !items.some(item => item.id === id)) throw libraryError('CONTENT_LIBRARY_FULL', '成片库索引已达到容量上限');
      // Content-addressed copies are immutable to callers; a later source edit creates a new item.
      await fsp.rename(temporary, destination); temporary = null;
      const createdAt = Number.isFinite(Date.parse(entry.createdAt)) ? new Date(entry.createdAt).toISOString() : new Date().toISOString();
      return { id, source: entry.source, sourceId: String(entry.sourceId), title: boundedText(entry.title, 500) || '未命名作品', body: boundedText(entry.body, 20000), createdAt,
        mediaType: metadata.type, mimeType: formats[extension][1], sizeBytes: copied, sha256, filename, sourceFingerprint: fingerprint,
        reviewStatus: entry.reviewStatus === 'selected' ? 'selected' : 'unreviewed', sourceStatus: boundedText(entry.sourceStatus, 200),
        artifactType: ['final_video', 'video_clip', 'image'].includes(entry.artifactType) ? entry.artifactType : metadata.type === 'image' ? 'image' : 'final_video',
        meta: { ...metadata, name: path.basename(sourcePath), size: copied, sha256 } };
    } finally { await input.close(); if (temporary) await fsp.rm(temporary, { force: true }); }
  }
  async function synchronize() {
    const deadline = Date.now() + maxSyncMs;
    let collected;
    try { collected = await collectSources(config); }
    catch { collected = { entries: [], sources: Object.keys(sourceKeys).map(id => ({ id, online: false })) }; }
    const entries = Array.isArray(collected.entries) ? collected.entries.slice(0, 450) : [];
    const sources = Object.keys(sourceKeys).map(id => {
      const upstream = collected.sources?.find(item => item.id === id);
      return { id, title: sourceTitles[id], enabled: Boolean(config[sourceKeys[id]]), online: upstream?.online === true,
        message: !config[sourceKeys[id]] ? '尚未配置作品来源' : upstream?.online === true ? '作品来源可读取' : '作品来源暂时不可读取',
        importedCount: 0, rejectedCount: 0, pendingCount: 0 };
    });
    const items = [...catalog.items];
    // Rotate the bounded work batch, including cached entries, so later sources and
    // updated source metadata are eventually examined on every catalog size.
    const start = entries.length ? scanCursor % entries.length : 0;
    const ordered = [...entries.slice(start), ...entries.slice(0, start)];
    let attempted = 0;
    for (const entry of ordered) {
      const source = sources.find(item => item.id === entry.source);
      if (!source) continue;
      if (attempted >= maxImportsPerSync || Date.now() >= deadline) { source.pendingCount += 1; continue; }
      attempted += 1;
      try {
        const imported = await importEntry(entry, items, deadline);
        const index = items.findIndex(item => item.id === imported.id);
        if (index < 0) items.push(imported); else items[index] = imported;
        source.importedCount += 1;
      } catch (error) { if (error.code === 'CONTENT_LIBRARY_FULL') source.pendingCount += 1; else source.rejectedCount += 1; }
    }
    scanCursor = entries.length ? (start + attempted) % entries.length : 0;
    await save({ version: 1, items, sources, lastSyncedAt: new Date().toISOString() });
    lastCheck = Date.now();
    return snapshot();
  }
  async function sync({ force = false } = {}) {
    await initialize();
    if (inFlight) return inFlight;
    if (!force && lastCheck && Date.now() - lastCheck < cacheMs) return snapshot();
    inFlight = synchronize().finally(() => { inFlight = null; });
    return inFlight;
  }
  async function find(id) {
    await initialize();
    if (!idPattern.test(String(id))) throw libraryError('CONTENT_NOT_FOUND', '成片不存在', 404);
    const item = catalog.items.find(item => item.id === id);
    if (!item) throw libraryError('CONTENT_NOT_FOUND', '成片不存在', 404);
    return item;
  }
  async function publishDraft(id) {
    const item = await find(id);
    if (['.webm', '.m4v'].includes(path.extname(item.filename))) throw libraryError('CONTENT_PUBLISH_FORMAT_UNSUPPORTED', '此格式可以预览；发布前请从创作工具导出 MP4 或 MOV');
    const stored = await openStored(item);
    try {
      const hash = crypto.createHash('sha256');
      for await (const chunk of stored.handle.createReadStream({ autoClose: false })) hash.update(chunk);
      if (hash.digest('hex') !== item.sha256) throw libraryError('CONTENT_FILE_CHANGED', '成片文件已改变，请重新同步');
      return { id: item.id, source: item.source, title: item.title, body: item.body, materialPath: stored.filePath, sha256: item.sha256,
        sourceRef: sourceRef(item), requiresPrecheck: true, mediaUrl: `/api/content-library/${item.id}/media`, mediaType: item.mediaType,
        sizeBytes: item.sizeBytes, meta: { ...item.meta, type: item.mediaType, size: item.sizeBytes, sha256: item.sha256 } };
    } finally { await stored.handle.close(); }
  }
  async function streamMedia(req, res, id) {
    const item = await find(id);
    const stored = await openStored(item);
    const range = parseContentRange(req.headers.range, stored.stat.size);
    const headers = { 'Content-Type': item.mimeType, 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' };
    if (!range) { await stored.handle.close(); res.writeHead(416, { ...headers, 'Content-Range': `bytes */${stored.stat.size}` }); res.end(); return; }
    const { start, end, status } = range;
    res.writeHead(status, { ...headers, 'Content-Length': end - start + 1, ...(status === 206 ? { 'Content-Range': `bytes ${start}-${end}/${stored.stat.size}` } : {}) });
    if (req.method === 'HEAD') { await stored.handle.close(); res.end(); return; }
    try { await pipeline(stored.handle.createReadStream({ start, end, autoClose: false }), res); }
    catch { if (!res.destroyed) res.destroy(); }
    finally { await stored.handle.close(); }
  }
  return { list: () => sync(), sync, publishDraft, streamMedia };
}
