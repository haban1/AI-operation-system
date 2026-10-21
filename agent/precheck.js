import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import sharp from 'sharp';
import ffprobeStatic from 'ffprobe-static';

const execFileAsync = promisify(execFile);
const bundledFfprobePath = typeof ffprobeStatic === 'string' ? ffprobeStatic : ffprobeStatic?.path;
// Linux ARM64 uses the distribution binary installed by the Docker image.
const ffprobePath = bundledFfprobePath && fs.existsSync(bundledFfprobePath) ? bundledFfprobePath : 'ffprobe';
const imageExt = new Set(['.jpg', '.jpeg', '.png', '.webp']);
const videoExt = new Set(['.mp4', '.mov']);
const rules = {
  xiaohongshu: { types: ['image', 'video'], extensions: ['.jpg', '.jpeg', '.png', '.webp', '.mp4', '.mov'], maxBytes: 20 * 1024 * 1024 * 1024, titleMax: 20 },
  douyin: { types: ['image', 'video'], maxBytes: 4 * 1024 * 1024 * 1024, titleMax: 55 },
  wechat_channels: { types: ['image', 'video'], maxBytes: 4 * 1024 * 1024 * 1024, titleMax: 55 },
  bilibili: { types: ['video'], extensions: ['.mp4', '.mov'], maxBytes: 20 * 1024 * 1024 * 1024, titleMax: 80 },
  weibo: { types: ['image', 'video'], extensions: ['.jpg', '.jpeg', '.png', '.webp', '.mp4', '.mov'], maxBytes: 4 * 1024 * 1024 * 1024, titleMax: 140 }
};

function sniffType(buffer, ext) {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return { type: 'image', format: 'png' };
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return { type: 'image', format: 'jpeg' };
  if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return { type: 'image', format: 'webp' };
  if (buffer.length >= 12 && buffer.toString('ascii', 4, 8) === 'ftyp') return { type: 'video', format: ext === '.mov' ? 'mov' : 'mp4' };
  if (imageExt.has(ext) || videoExt.has(ext)) return { type: 'unknown', format: null };
  return { type: 'unknown', format: null };
}

function sha256(file) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytes;
    let position = 0;
    while ((bytes = fs.readSync(fd, buffer, 0, buffer.length, position)) > 0) {
      hash.update(buffer.subarray(0, bytes));
      position += bytes;
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function integerOrNull(value) {
  const number = numberOrNull(value);
  return number === null ? null : Math.round(number);
}

function parseFrameRate(value) {
  if (!value || value === '0/0') return null;
  const [left, right] = String(value).split('/').map(Number);
  const rate = right ? left / right : Number(value);
  return Number.isFinite(rate) && rate > 0 ? Number(rate.toFixed(3)) : null;
}

function normalizeRotation(videoStream) {
  const sideRotation = videoStream?.side_data_list?.find(item => item.rotation !== undefined)?.rotation;
  const value = numberOrNull(sideRotation ?? videoStream?.tags?.rotate ?? 0) ?? 0;
  return ((Math.round(value) % 360) + 360) % 360;
}

async function analyzeImage(file) {
  const metadata = await sharp(file, { animated: true, failOn: 'warning' }).metadata();
  if (!metadata.format || !metadata.width || !metadata.height) throw new Error('未解析出图片格式或尺寸');
  const orientationSwapsSides = [5, 6, 7, 8].includes(metadata.orientation);
  const width = orientationSwapsSides ? metadata.height : metadata.width;
  const height = orientationSwapsSides ? metadata.width : metadata.height;
  return {
    type: 'image',
    format: metadata.format === 'jpg' ? 'jpeg' : metadata.format,
    analyzer: 'sharp',
    width,
    height,
    aspectRatio: Number((width / height).toFixed(4)),
    channels: metadata.channels ?? null,
    colorSpace: metadata.space ?? null,
    bitDepth: metadata.depth ?? null,
    density: metadata.density ?? null,
    hasAlpha: Boolean(metadata.hasAlpha),
    orientation: metadata.orientation ?? null,
    pages: metadata.pages ?? 1,
    isProgressive: Boolean(metadata.isProgressive),
    hasColorProfile: Boolean(metadata.hasProfile)
  };
}

async function analyzeVideo(file, ext) {
  const { stdout } = await execFileAsync(ffprobePath, [
    '-v', 'error', '-show_streams', '-show_format', '-of', 'json', '--', file
  ], { timeout: 20000, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
  const probe = JSON.parse(stdout);
  const streams = Array.isArray(probe.streams) ? probe.streams : [];
  const video = streams.find(stream => stream.codec_type === 'video');
  const audio = streams.find(stream => stream.codec_type === 'audio');
  if (!video) throw new Error('文件中未发现可解析的视频轨道');
  const rotation = normalizeRotation(video);
  const rawWidth = integerOrNull(video.width);
  const rawHeight = integerOrNull(video.height);
  const swapsSides = rotation === 90 || rotation === 270;
  const width = swapsSides ? rawHeight : rawWidth;
  const height = swapsSides ? rawWidth : rawHeight;
  const durationSeconds = numberOrNull(probe.format?.duration) ?? numberOrNull(video.duration);
  const frameRate = parseFrameRate(video.avg_frame_rate) ?? parseFrameRate(video.r_frame_rate);
  const container = String(probe.format?.format_name || '');
  return {
    type: 'video',
    format: ext === '.mov' ? 'mov' : container.includes('mp4') ? 'mp4' : (container.split(',')[0] || null),
    container,
    analyzer: 'ffprobe',
    width,
    height,
    encodedWidth: rawWidth,
    encodedHeight: rawHeight,
    aspectRatio: width && height ? Number((width / height).toFixed(4)) : null,
    durationSeconds: durationSeconds === null ? null : Number(durationSeconds.toFixed(3)),
    frameRate,
    videoCodec: video.codec_name || null,
    videoProfile: video.profile || null,
    pixelFormat: video.pix_fmt || null,
    videoBitRate: integerOrNull(video.bit_rate),
    totalBitRate: integerOrNull(probe.format?.bit_rate),
    frameCount: integerOrNull(video.nb_frames),
    rotation,
    fieldOrder: video.field_order || null,
    colorSpace: video.color_space || null,
    colorTransfer: video.color_transfer || null,
    colorPrimaries: video.color_primaries || null,
    hasAudio: Boolean(audio),
    audioCodec: audio?.codec_name || null,
    audioBitRate: integerOrNull(audio?.bit_rate),
    audioChannels: integerOrNull(audio?.channels),
    audioSampleRate: integerOrNull(audio?.sample_rate)
  };
}

function addImageChecks(meta, reasons, warnings) {
  if (!meta.width || !meta.height) reasons.push('图片元数据解析不完整，无法确认分辨率');
  if (meta.width && meta.height && (meta.width < 300 || meta.height < 300)) warnings.push('图片分辨率较低，建议至少保证短边达到 300 像素');
  if (meta.aspectRatio && (meta.aspectRatio < 0.4 || meta.aspectRatio > 2.5)) warnings.push('图片宽高比较极端，请核对平台展示和裁切效果');
  if ((meta.pages || 1) > 1) warnings.push('检测到多帧或动图素材，部分平台可能只取首帧');
}

function addVideoChecks(meta, reasons, warnings) {
  if (!meta.width || !meta.height) reasons.push('视频元数据解析不完整，无法确认分辨率');
  if (!meta.durationSeconds || meta.durationSeconds <= 0) reasons.push('视频元数据解析不完整，无法确认有效时长');
  if (!meta.videoCodec) reasons.push('视频元数据解析不完整，无法确认视频编码');
  if (meta.width && meta.height && (meta.width < 480 || meta.height < 480)) warnings.push('视频分辨率较低，建议至少保证短边达到 480 像素');
  if (meta.aspectRatio && (meta.aspectRatio < 0.4 || meta.aspectRatio > 2.5)) warnings.push('视频宽高比较极端，请核对平台展示和裁切效果');
  if (meta.videoCodec && !['h264', 'hevc'].includes(meta.videoCodec)) warnings.push(`视频编码为 ${meta.videoCodec}，跨平台发布建议使用 H.264/AVC`);
  if (meta.pixelFormat && !['yuv420p', 'yuvj420p', 'yuv420p10le'].includes(meta.pixelFormat)) warnings.push(`视频像素格式为 ${meta.pixelFormat}，部分平台可能不兼容`);
  if (!meta.frameRate) warnings.push('未解析出视频帧率，请人工确认');
  else if (meta.frameRate < 15 || meta.frameRate > 60) warnings.push(`视频帧率为 ${meta.frameRate} fps，建议使用 15–60 fps`);
  if (!meta.totalBitRate && !meta.videoBitRate) warnings.push('未解析出视频码率，请人工确认');
  else if ((meta.totalBitRate || meta.videoBitRate) > 100 * 1024 * 1024) warnings.push('视频码率超过 100 Mbps，上传和平台转码风险较高');
  if (meta.hasAudio && meta.audioCodec && !['aac', 'mp3'].includes(meta.audioCodec)) warnings.push(`音频编码为 ${meta.audioCodec}，跨平台发布建议使用 AAC`);
}

export async function precheckMaterial({ materialPath, platforms = [], title = '', body = '' }) {
  const absolute = path.resolve(materialPath || '');
  const base = { path: absolute, exists: fs.existsSync(absolute), checkedAt: new Date().toISOString(), ruleVersion: 'media-2026.08.06.1' };
  if (!base.exists) return { ...base, overall: 'BLOCKED', message: '本地素材不存在', results: [] };
  let stat;
  try {
    stat = fs.statSync(absolute);
    fs.accessSync(absolute, fs.constants.R_OK);
  } catch (error) {
    return { ...base, overall: 'BLOCKED', message: `本地素材不可读取：${error.message}`, results: [] };
  }
  if (!stat.isFile()) return { ...base, overall: 'BLOCKED', message: '所选路径不是文件', results: [] };

  const ext = path.extname(absolute).toLowerCase();
  const fd = fs.openSync(absolute, 'r');
  const header = Buffer.alloc(Math.min(1024 * 1024, Math.max(64, stat.size)));
  const read = fs.readSync(fd, header, 0, header.length, 0);
  fs.closeSync(fd);
  const sample = header.subarray(0, read);
  let detected = sniffType(sample, ext);
  let parsed = null;
  let parserError = null;
  try {
    if (detected.type === 'image' || imageExt.has(ext)) parsed = await analyzeImage(absolute);
    else if (detected.type === 'video' || videoExt.has(ext)) parsed = await analyzeVideo(absolute, ext);
    if (parsed) detected = { type: parsed.type, format: parsed.format };
  } catch (error) {
    parserError = error.message;
  }

  const meta = {
    name: path.basename(absolute),
    extension: ext,
    type: detected.type,
    format: detected.format,
    size: stat.size,
    modifiedAt: stat.mtime.toISOString(),
    sha256: sha256(absolute),
    ...(parsed || {}),
    parserReady: Boolean(parsed),
    parserError
  };

  const results = platforms.map(platformCode => {
    const rule = rules[platformCode];
    const reasons = [];
    const warnings = [];
    if (!rule) {
      reasons.push('缺少该平台预检规则');
    } else {
      if (rule.extensions && !rule.extensions.includes(ext)) reasons.push(`平台不支持该文件扩展名：${ext || '无扩展名'}`);
      if (detected.type === 'unknown') reasons.push('文件真实格式无法识别，不能只依据扩展名发布');
      else if (!rule.types.includes(detected.type)) reasons.push(`平台不支持该素材类型：${detected.type}`);

      if (detected.type === 'image' && !imageExt.has(ext)) reasons.push('文件内容是图片，但扩展名不是受支持的图片格式');
      if (detected.type === 'video' && !videoExt.has(ext)) reasons.push('文件内容是视频，但扩展名不是受支持的视频格式');
      if (detected.format === 'png' && ext !== '.png') reasons.push('扩展名与真实 PNG 格式不一致');
      if (detected.format === 'jpeg' && !['.jpg', '.jpeg'].includes(ext)) reasons.push('扩展名与真实 JPEG 格式不一致');
      if (detected.format === 'webp' && ext !== '.webp') reasons.push('扩展名与真实 WEBP 格式不一致');
      if (detected.format === 'mp4' && ext !== '.mp4') reasons.push('扩展名与真实 MP4 格式不一致');
      if (detected.format === 'mov' && ext !== '.mov') reasons.push('扩展名与真实 MOV 格式不一致');
      if (stat.size > rule.maxBytes) reasons.push('文件大小超过当前规则上限');
      if (rule.titleMax && [...String(title || '')].length > rule.titleMax) warnings.push(`标题超过当前平台建议长度（${rule.titleMax} 字），发布页可能截断或要求修改`);

      if (parserError && detected.type === 'image') reasons.push(`图片元数据解析失败：${parserError}`);
      if (parserError && detected.type === 'video') reasons.push(`视频元数据解析失败：${parserError}`);
      if (meta.parserReady && detected.type === 'image') addImageChecks(meta, reasons, warnings);
      if (meta.parserReady && detected.type === 'video') addVideoChecks(meta, reasons, warnings);
    }
    return { platformCode, status: reasons.length ? 'BLOCKED' : warnings.length ? 'WARNING' : 'PASSED', reasons, warnings };
  });

  const overall = results.some(result => result.status === 'BLOCKED') ? 'BLOCKED' : results.some(result => result.status === 'WARNING') ? 'WARNING' : 'PASSED';
  const message = overall === 'PASSED' ? '预检通过' : overall === 'WARNING' ? '存在警告，需要人工确认后继续' : '存在阻断项';
  return { ...base, overall, message, meta, results };
}
