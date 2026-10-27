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
function admissionFields(item = {}) {
  const actor = value => typeof value === 'string' && value.trim() && value.length <= 200 ? value : null;
  const timestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;
  const reviewedAt = timestamp(item.reviewedAt), reviewedBy = actor(item.reviewedBy);
  const admittedAt = timestamp(item.admittedAt), admittedBy = actor(item.admittedBy);
  // A source's selected flag, or a legacy item without an explicit review,
  // never establishes permission to use that item in the material library.
  const admissionStatus = reviewedAt && reviewedBy && (
    item.admissionStatus === 'rejected' || (item.admissionStatus === 'approved' && admittedAt && admittedBy)
  ) ? item.admissionStatus : 'pending';
  return { admissionStatus, reviewedAt, reviewedBy,
    admittedAt: admissionStatus === 'approved' ? admittedAt : null,
    admittedBy: admissionStatus === 'approved' ? admittedBy : null };
}
function decodeCatalog(buffer) {
  if (buffer.length > MAX_CATALOG_BYTES) throw new Error('Invalid catalog');
  const parsed = JSON.parse(buffer.toString('utf8'));
  if (parsed.version !== 1 || !Array.isArray(parsed.items) || parsed.items.length > 1000) throw new Error('Invalid catalog');
  for (const item of parsed.items) {
    if (!idPattern.test(item.id) || !Object.hasOwn(sourceKeys, item.source) || !filePattern.test(item.filename)
      || !/^[a-f0-9]{64}$/.test(item.sha256) || !item.filename.startsWith(item.sha256 + '.')
      || !Number.isSafeInteger(item.sizeBytes) || item.sizeBytes <= 0 || !['video', 'image'].includes(item.mediaType)) throw new Error('Invalid item');
  }
  return { version: 1, items: parsed.items.map(item => ({ ...item, ...admissionFields(item) })),
    sources: Array.isArray(parsed.sources) ? parsed.sources : [], lastSyncedAt: typeof parsed.lastSyncedAt === 'string' ? parsed.lastSyncedAt : null };
}

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
  let mutationTail = Promise.resolve();
  let libraryRoot;

  function serialize(operation) {
    const result = mutationTail.then(operation);
    mutationTail = result.catch(() => {});
    return result;
  }

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
        catalog = decodeCatalog(buffer.subarray(0, bytesRead));
      } catch (error) {
        if (error.code !== 'ENOENT') throw libraryError('CONTENT_LIBRARY_INVALID', '成片库索引无法读取，原文件已保留', 500);
      } finally { await handle?.close(); }
    })();
    try { await loading; } catch (error) { loading = null; throw error; }
  }

  function publicItem(item) {
    return { id: item.id, source: item.source, sourceId: item.sourceId, title: item.title, body: item.body, createdAt: item.createdAt,
      mediaType: item.mediaType, mimeType: item.mimeType, sizeBytes: item.sizeBytes, sha256: item.sha256,
      reviewStatus: item.reviewStatus, sourceStatus: boundedText(item.sourceStatus, 200), artifactType: item.artifactType,
      receivedAt: item.receivedAt || null, receivedBy: item.receivedBy || null,
      ...admissionFields(item), mediaUrl: `/api/content-library/${item.id}/media` };
  }
  function snapshot() {
    const all = catalog.items.map(publicItem).sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));
    const items = all.filter(item => item.admissionStatus === 'approved');
    const pendingItems = all.filter(item => item.admissionStatus === 'pending');
    const rejectedItems = all.filter(item => item.admissionStatus === 'rejected');
    return { items, pendingItems, rejectedItems,
      counts: { total: all.length, approved: items.length, pending: pendingItems.length, rejected: rejectedItems.length },
      sources: catalog.sources, lastSyncedAt: catalog.lastSyncedAt };
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
  async function importEntry(entry, items, deadline, allowedRoot) {
    if (!Object.hasOwn(sourceKeys, entry.source) || !String(entry.sourceId || '').trim() || String(entry.sourceId).length > 512) throw new Error('Invalid source');
    const configuredRoot = allowedRoot || config[sourceKeys[entry.source]];
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
      const admission = admissionFields(items.find(item => item.id === id));
      if (items.length >= 1000 && !items.some(item => item.id === id)) throw libraryError('CONTENT_LIBRARY_FULL', '成片库索引已达到容量上限');
      // Content-addressed copies are immutable to callers; a later source edit creates a new item.
      await fsp.rename(temporary, destination); temporary = null;
      const createdAt = Number.isFinite(Date.parse(entry.createdAt)) ? new Date(entry.createdAt).toISOString() : new Date().toISOString();
      return { id, source: entry.source, sourceId: String(entry.sourceId), title: boundedText(entry.title, 500) || '未命名作品', body: boundedText(entry.body, 20000), createdAt,
        mediaType: metadata.type, mimeType: formats[extension][1], sizeBytes: copied, sha256, filename, sourceFingerprint: fingerprint,
        reviewStatus: entry.reviewStatus === 'selected' ? 'selected' : 'unreviewed', sourceStatus: boundedText(entry.sourceStatus, 200),
        artifactType: ['final_video', 'video_clip', 'image'].includes(entry.artifactType) ? entry.artifactType : metadata.type === 'image' ? 'image' : 'final_video', ...admission,
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
    inFlight = serialize(() => !force && lastCheck && Date.now() - lastCheck < cacheMs ? snapshot() : synchronize()).finally(() => { inFlight = null; });
    return inFlight;
  }
  async function receive(stream, params, actor, { contentLength } = {}) {
    const invalid = () => libraryError('CONTENT_RECEIVE_INVALID', '接收参数无效，请选择来源并上传有效的媒体文件名', 400);
    if (!params || typeof params !== 'object' || Array.isArray(params)
      || Object.keys(params).some(key => !['source', 'filename', 'title', 'artifactType'].includes(key))) throw invalid();
    const { source, filename } = params;
    if (!Object.hasOwn(sourceKeys, source) || typeof filename !== 'string' || !filename.trim() || filename.length > 255
      || /[\\/:\x00-\x1f\x7f]/.test(filename) || filename === '.' || filename === '..'
      || path.basename(filename) !== filename) throw invalid();
    const extension = path.extname(filename).toLowerCase();
    if (!Object.hasOwn(formats, extension)) throw invalid();
    if (params.title !== undefined && (typeof params.title !== 'string' || params.title.length > 500)) throw invalid();
    const artifactType = params.artifactType ?? (formats[extension][0] === 'image' ? 'image' : 'video_clip');
    if (!['final_video', 'video_clip', 'image'].includes(artifactType)
      || (artifactType === 'image') !== (formats[extension][0] === 'image')) throw invalid();
    if (typeof actor !== 'string' || !actor.trim() || actor.length > 200) throw libraryError('CONTENT_RECEIVE_ACTOR_REQUIRED', '接收产物需要有效的管理员身份', 401);
    let expected;
    if (contentLength !== undefined) {
      if (!/^\d+$/.test(String(contentLength)) || !Number.isSafeInteger(Number(contentLength))) throw invalid();
      expected = Number(contentLength);
      if (expected > maxFileBytes) throw libraryError('CONTENT_MEDIA_TOO_LARGE', '媒体文件超过大小限制', 413);
    }
    await initialize();
    const incoming = path.join(libraryRoot, 'incoming');
    await fsp.mkdir(incoming, { recursive: true, mode: 0o700 });
    const incomingRoot = await fsp.realpath(incoming);
    if (!inside(libraryRoot, incomingRoot)) throw libraryError('CONTENT_LIBRARY_INVALID', '接收目录配置无效', 500);
    const stagingRoot = await fsp.mkdtemp(path.join(incomingRoot, 'receive-'));
    const filePath = path.join(stagingRoot, `media${extension}`);
    let output;
    try {
      output = await fsp.open(filePath, 'wx', 0o600);
      let received = 0;
      // Keep the HTTP request alive on validation failure so the caller receives
      // a useful 4xx response, while writing chunks without buffering the body.
      for await (const chunk of stream.iterator({ destroyOnReturn: false })) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        received += bytes.length;
        if (received > maxFileBytes) throw libraryError('CONTENT_MEDIA_TOO_LARGE', '媒体文件超过大小限制', 413);
        let offset = 0;
        while (offset < bytes.length) {
          const written = await output.write(bytes, offset, bytes.length - offset);
          if (!written.bytesWritten) throw new Error('Incomplete media write');
          offset += written.bytesWritten;
        }
      }
      if (!received || (expected !== undefined && received !== expected)) throw libraryError('CONTENT_MEDIA_INVALID', '媒体文件为空或传输不完整', 400);
      await output.sync(); await output.close(); output = null;
      // Uploads do not hold the mutation queue while waiting for network bytes.
      return await serialize(async () => {
        const receivedAt = new Date().toISOString();
        let imported;
        try {
          try {
            imported = await importEntry({ source, sourceId: `received-${crypto.randomUUID()}`, rootPath: stagingRoot, filePath,
              title: params.title?.trim() || filename, createdAt: receivedAt, sourceStatus: '接收产物 · 待确认', artifactType },
            catalog.items, Date.now() + Math.max(maxSyncMs, 60_000), stagingRoot);
          } catch (error) {
            if (error instanceof ContentLibraryError) throw error;
            throw libraryError('CONTENT_MEDIA_INVALID', '文件不是有效的图片或视频，或媒体检测未完成', 400);
          }
          imported = { ...imported, receivedAt, receivedBy: actor, meta: { ...imported.meta, name: filename } };
          await save({ ...catalog, items: [...catalog.items, imported] });
          return { item: publicItem(imported), counts: snapshot().counts };
        } catch (error) {
          if (imported && !catalog.items.some(item => item.filename === imported.filename)) {
            await fsp.rm(path.join(libraryRoot, 'media', imported.filename), { force: true });
          }
          throw error;
        }
      });
    } finally {
      await output?.close();
      await fsp.rm(stagingRoot, { recursive: true, force: true });
    }
  }
  async function find(id) {
    await initialize();
    if (!idPattern.test(String(id))) throw libraryError('CONTENT_NOT_FOUND', '成片不存在', 404);
    const item = catalog.items.find(item => item.id === id);
    if (!item) throw libraryError('CONTENT_NOT_FOUND', '成片不存在', 404);
    return item;
  }
  async function publishDraft(id) {
    await initialize();
    return serialize(async () => {
      const item = await find(id);
      if (admissionFields(item).admissionStatus !== 'approved') throw libraryError('CONTENT_ADMISSION_REQUIRED', '请先人工确认入库，再带入发布草稿');
      if (['.webm', '.m4v'].includes(path.extname(item.filename))) throw libraryError('CONTENT_PUBLISH_FORMAT_UNSUPPORTED', '此格式可以预览；发布前请从创作工具导出 MP4 或 MOV');
      const stored = await verifiedStored(item);
      try {
        return { id: item.id, source: item.source, title: item.title, body: item.body, materialPath: stored.filePath, sha256: item.sha256,
          sourceRef: sourceRef(item), requiresPrecheck: true, mediaUrl: `/api/content-library/${item.id}/media`, mediaType: item.mediaType,
          sizeBytes: item.sizeBytes, meta: { ...item.meta, type: item.mediaType, size: item.sizeBytes, sha256: item.sha256 } };
      } finally { await stored.handle.close(); }
    });
  }
  function assertPublishMaterial(materialPath, materialSha) {
    const requested = path.resolve(materialPath);
    const unavailable = () => libraryError('CONTENT_FILE_UNAVAILABLE', '内容库素材不可用，请重新选择已确认入库的作品');
    let root;
    try { root = fs.realpathSync(directory); }
    catch {
      if (inside(directory, requested) || (libraryRoot && inside(libraryRoot, requested))) throw unavailable();
      return null;
    }
    let resolved;
    try { resolved = fs.realpathSync(requested); }
    catch { throw unavailable(); }
    const requestedInLibrary = inside(directory, requested) || inside(root, requested);
    if (!requestedInLibrary && !inside(root, resolved)) return null;
    const mediaRoot = path.join(root, 'media');
    const filename = path.basename(resolved);
    if (path.dirname(resolved) !== mediaRoot || !filePattern.test(filename)) throw unavailable();
    let durable, fd;
    try {
      fd = fs.openSync(path.join(root, 'catalog.json'), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size > MAX_CATALOG_BYTES) throw new Error('Invalid catalog');
      const bytes = Buffer.alloc(MAX_CATALOG_BYTES + 1);
      let length = 0, count;
      while (length < bytes.length && (count = fs.readSync(fd, bytes, length, bytes.length - length, length)) > 0) length += count;
      durable = decodeCatalog(bytes.subarray(0, length));
    } catch { throw libraryError('CONTENT_LIBRARY_INVALID', '内容库审核记录无法读取，已停止创建发布任务', 409); }
    finally { if (fd !== undefined) fs.closeSync(fd); }
    // Publication authorizes the actual file, never a caller-supplied sourceRef.
    // Identical bytes share one path: any surviving audited approval authorizes
    // those bytes, even if another source's record was rejected or resubmitted.
    const approved = durable.items.find(item => item.filename === filename && admissionFields(item).admissionStatus === 'approved');
    if (!approved) throw libraryError('CONTENT_ADMISSION_REQUIRED', '作品尚未确认入库或已撤回，请重新选择已确认的作品');
    const stat = fs.statSync(resolved);
    if (!stat.isFile() || stat.size !== approved.sizeBytes || materialSha !== approved.sha256) {
      throw libraryError('CONTENT_FILE_CHANGED', '内容库素材已改变，请重新接收并确认入库');
    }
    // This read and the caller's publish-task transaction are synchronous, so
    // an admission mutation cannot interleave between this check and creation.
    return { id: approved.id, ...sourceRef(approved), sha256: approved.sha256 };
  }
  async function verifiedStored(item) {
    const stored = await openStored(item);
    try {
      const hash = crypto.createHash('sha256');
      for await (const chunk of stored.handle.createReadStream({ autoClose: false })) hash.update(chunk);
      if (hash.digest('hex') !== item.sha256) throw libraryError('CONTENT_FILE_CHANGED', '成片文件已改变，请重新同步');
      return stored;
    } catch (error) { await stored.handle.close(); throw error; }
  }
  async function setAdmission(id, decision, actor) {
    if (!['approved', 'rejected', 'pending'].includes(decision)) throw libraryError('CONTENT_ADMISSION_INVALID', '请选择确认入库、拒绝或重新提交审核', 400);
    if (typeof actor !== 'string' || !actor.trim() || actor.length > 200) throw libraryError('CONTENT_ADMISSION_ACTOR_REQUIRED', '审核操作需要有效的管理员身份', 401);
    await initialize();
    return serialize(async () => {
      const item = await find(id);
      if (decision === 'approved') { const stored = await verifiedStored(item); await stored.handle.close(); }
      const stamp = new Date().toISOString();
      const reviewed = { ...item, admissionStatus: decision, reviewedAt: stamp, reviewedBy: actor,
        admittedAt: decision === 'approved' ? stamp : null, admittedBy: decision === 'approved' ? actor : null };
      await save({ ...catalog, items: catalog.items.map(existing => existing.id === id ? reviewed : existing) });
      return { item: publicItem(reviewed), counts: snapshot().counts };
    });
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
  return { list: () => sync(), sync, receive, setAdmission, publishDraft, assertPublishMaterial, streamMedia };
}
