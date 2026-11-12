import fs from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { AppError, fail } from './domain.mjs';

export const exec = promisify(execFile);
export const FFMPEG = process.env.VIDEO_FFMPEG || 'ffmpeg';
export const FFPROBE = process.env.VIDEO_FFPROBE || 'ffprobe';
const extensions = new Map(Object.entries({ '.mp4': 'video', '.mov': 'video', '.m4v': 'video', '.webm': 'video', '.jpg': 'image', '.jpeg': 'image', '.png': 'image', '.webp': 'image', '.mp3': 'audio', '.wav': 'audio', '.m4a': 'audio', '.aac': 'audio', '.flac': 'audio', '.ogg': 'audio', '.opus': 'audio' }));
const MAX_UPLOAD = 512 * 1024 * 1024;

export async function hashFile(file) { const hash = createHash('sha256'); for await (const chunk of createReadStream(file)) hash.update(chunk); return hash.digest('hex'); }
export async function probe(file, countFrames = false) {
  const { stdout } = await exec(FFPROBE, ['-v', 'error', ...(countFrames ? ['-count_frames'] : []), '-show_streams', '-show_format', '-of', 'json', file], { timeout: 60000, maxBuffer: 2 * 1024 * 1024 });
  return JSON.parse(stdout);
}
export const publicAsset = asset => ({ id: asset.id, name: asset.name, type: asset.type, duration: asset.duration,
  width: asset.width, height: asset.height, bytes: asset.bytes, createdAt: asset.createdAt,
  description: [asset.description, asset.visualDescription].filter(Boolean).join('\n'), subject: asset.subject || '', tags: asset.tags || [], notesRevision: asset.notesRevision || 0,
  url: `/api/assets/${asset.id}`, thumbnailUrl: asset.type === 'audio' ? null : `/api/assets/${asset.id}/thumbnail` });

export async function importAsset(req, store, { id = randomUUID() } = {}) {
  let supplied;
  try { supplied = decodeURIComponent(String(req.headers['x-file-name'] || '')); } catch { fail(400, 'INVALID_FILENAME', '文件名编码不正确'); }
  const name = path.basename(supplied.replaceAll('\\', '/')).replace(/[\x00-\x1f]/g, '').slice(0, 180);
  const extension = path.extname(name).toLowerCase();
  const type = extensions.get(extension);
  if (!type) fail(415, 'UNSUPPORTED_FORMAT', '支持 MP4/MOV/WebM 视频，JPG/PNG/WebP 图片和常用音频格式');
  const declared = Number(req.headers['content-length'] || 0);
  if (!Number.isFinite(declared) || declared > MAX_UPLOAD) fail(413, 'FILE_TOO_LARGE', '单个素材不能超过 512 MB');
  const folder = path.join(store.root, 'assets', id);
  await fs.mkdir(folder, { mode: 0o700 });
  const original = path.join(folder, `original${extension}`);
  let bytes = 0;
  const hash = createHash('sha256');
  try {
    await pipeline(req, new Transform({ transform(chunk, encoding, callback) {
      bytes += chunk.length;
      if (bytes > MAX_UPLOAD) return callback(new AppError(413, 'FILE_TOO_LARGE', '单个素材不能超过 512 MB'));
      hash.update(chunk); callback(null, chunk);
    } }), createWriteStream(original, { flags: 'wx', mode: 0o600 }));
    if (!bytes) fail(400, 'EMPTY_FILE', '文件为空');
    const source = await probe(original);
    const video = source.streams.find(s => s.codec_type === 'video' && !s.disposition?.attached_pic);
    const sound = source.streams.find(s => s.codec_type === 'audio');
    if ((type === 'audio' && !sound) || (type !== 'audio' && !video)) fail(415, 'INVALID_MEDIA', '文件内容与所选素材类型不匹配');
    const sourceDuration = Number(source.format.duration || video?.duration || sound?.duration || 0);
    if (type !== 'image' && (!Number.isFinite(sourceDuration) || sourceDuration <= 0 || sourceDuration > 1800))
      fail(422, 'INVALID_DURATION', '请导入长度不超过 30 分钟的视频或音频');
    if (video && (video.width * video.height > 50_000_000 || video.width < 8 || video.height < 8)) fail(422, 'INVALID_DIMENSIONS', '素材分辨率不在支持范围内');
    let mediaFile;
    if (type === 'video') {
      mediaFile = path.join(folder, 'media.mp4');
      // Normalize VFR, phone rotation, codecs and source audio once. Both preview and render use this immutable local media.
      await exec(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', original, '-map', '0:v:0', '-an', '-vf', "scale=w='min(1920,iw)':h='min(1920,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2", '-r', '30', '-fps_mode', 'cfr', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '19', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', mediaFile], { timeout: 600000, maxBuffer: 1024 * 1024 });
    } else if (type === 'image') {
      mediaFile = path.join(folder, 'media.png');
      await exec(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', original, '-frames:v', '1', '-vf', "scale=w='min(3840,iw)':h='min(3840,ih)':force_original_aspect_ratio=decrease", mediaFile], { timeout: 60000, maxBuffer: 1024 * 1024 });
    } else {
      mediaFile = path.join(folder, 'media.wav');
      await exec(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', original, '-vn', '-ac', '2', '-ar', '48000', '-c:a', 'pcm_s16le', mediaFile], { timeout: 180000, maxBuffer: 1024 * 1024 });
    }
    const normalized = await probe(mediaFile);
    const stream = normalized.streams.find(s => s.codec_type === 'video');
    const duration = type === 'image' ? null : Number(normalized.format.duration);
    if (type !== 'image' && (!Number.isFinite(duration) || duration <= 0)) fail(422, 'INVALID_DURATION', '无法读取有效素材时长');
    const thumbnailFile = type === 'audio' ? null : path.join(store.root, 'thumbnails', `${id}.jpg`);
    if (thumbnailFile) await exec(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', mediaFile, '-frames:v', '1', '-vf', 'scale=320:320:force_original_aspect_ratio=decrease', '-q:v', '3', thumbnailFile], { timeout: 30000, maxBuffer: 1024 * 1024 });
    const asset = { id, name, type, duration, width: stream?.width || null, height: stream?.height || null,
      sourceDuration, bytes, sourceFile: original, mediaFile, thumbnailFile, sourceSha256: hash.digest('hex'),
      mediaSha256: await hashFile(mediaFile), createdAt: new Date().toISOString() };
    await store.put('assets', asset);
    return asset;
  } catch (error) {
    await fs.rm(folder, { recursive: true, force: true });
    await fs.rm(path.join(store.root, 'thumbnails', `${id}.jpg`), { force: true });
    if (error instanceof AppError) throw error;
    throw new AppError(422, 'MEDIA_IMPORT_FAILED', '素材读取或本地转换失败，请检查文件是否完整、是否为支持格式');
  }
}

export async function serveFile(req, res, file, mime, { downloadName } = {}) {
  const stat = await fs.stat(file).catch(() => null);
  if (!stat?.isFile()) fail(404, 'FILE_MISSING', '本地文件缺失，请重新导入素材或重新渲染');
  const headers = { 'content-type': mime, 'accept-ranges': 'bytes', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
  if (downloadName) headers['content-disposition'] = `attachment; filename="video.mp4"; filename*=UTF-8''${encodeURIComponent(downloadName)}`;
  let start = 0, end = stat.size - 1, status = 200;
  if (req.headers.range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
    if (!match || (!match[1] && !match[2])) { res.writeHead(416, { 'content-range': `bytes */${stat.size}` }); return res.end(); }
    if (!match[1]) start = Math.max(0, stat.size - Number(match[2]));
    else { start = Number(match[1]); if (match[2]) end = Math.min(end, Number(match[2])); }
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= stat.size) { res.writeHead(416, { 'content-range': `bytes */${stat.size}` }); return res.end(); }
    status = 206; headers['content-range'] = `bytes ${start}-${end}/${stat.size}`;
  }
  headers['content-length'] = end - start + 1;
  res.writeHead(status, headers);
  if (req.method === 'HEAD') return res.end();
  const stream = createReadStream(file, { start, end });
  res.on('close', () => stream.destroy());
  stream.on('error', () => res.destroy());
  stream.pipe(res);
}

export function mediaMime(file) {
  return ({ '.mp4': 'video/mp4', '.png': 'image/png', '.jpg': 'image/jpeg', '.wav': 'audio/wav' })[path.extname(file)] || 'application/octet-stream';
}
