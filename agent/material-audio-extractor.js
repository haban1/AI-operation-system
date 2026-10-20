import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import { config } from '../src/config.js';

const execFileAsync = promisify(execFile);
const defaultFfmpegPath = ffmpegInstaller?.path;

function extractorError(code, message, cause = null) {
  const error = new Error(message);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

function safeCleanupTempDirectory(directory) {
  if (!directory) return;
  const resolved = path.resolve(directory);
  const tempRoot = `${path.resolve(os.tmpdir())}${path.sep}`;
  if (!resolved.startsWith(tempRoot) || !path.basename(resolved).startsWith('ai-material-audio-')) return;
  fs.rmSync(resolved, { recursive: true, force: true });
}

export async function withExtractedAudio({
  materialPath,
  maxBytes = config.audioMaxBytes,
  timeoutMs = config.audioExtractTimeoutMs,
  operation,
  ffmpegExecutable = defaultFfmpegPath,
  execFileImpl = execFileAsync
} = {}) {
  const absolute = path.resolve(materialPath || '');
  if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
    throw extractorError('AUDIO_SOURCE_NOT_FOUND', '待提取音频的视频文件不存在');
  }
  if (!ffmpegExecutable || !fs.existsSync(ffmpegExecutable)) {
    throw extractorError('AUDIO_EXTRACTOR_UNAVAILABLE', '本地音频提取组件不可用');
  }
  if (typeof operation !== 'function') {
    throw extractorError('AUDIO_OPERATION_REQUIRED', '未提供音频处理操作');
  }

  const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-material-audio-'));
  const outputPath = path.join(tempDirectory, 'audio.mp3');
  try {
    try {
      await execFileImpl(ffmpegExecutable, [
        '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
        '-i', absolute,
        '-vn', '-ac', '1', '-ar', '16000', '-b:a', '48k', '-f', 'mp3',
        outputPath
      ], { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
    } catch (error) {
      const timedOut = error?.code === 'ETIMEDOUT' || error?.killed === true || /timed?\s*out/i.test(String(error?.message || ''));
      throw extractorError(timedOut ? 'AUDIO_EXTRACT_TIMEOUT' : 'AUDIO_EXTRACT_FAILED', timedOut ? '视频音频提取超时' : `视频音频提取失败：${error.message}`, error);
    }

    if (!fs.existsSync(outputPath)) throw extractorError('AUDIO_EMPTY', '视频未提取出有效音频');
    const stat = fs.statSync(outputPath);
    if (!stat.isFile() || stat.size <= 0) throw extractorError('AUDIO_EMPTY', '视频未提取出有效音频');
    if (stat.size > maxBytes) throw extractorError('AUDIO_TOO_LARGE', `提取后的音频超过上限（${Math.ceil(maxBytes / 1024 / 1024)}MB）`);
    const buffer = fs.readFileSync(outputPath);
    return await operation({ path: outputPath, buffer, bytes: buffer.length, mimeType: 'audio/mpeg' });
  } finally {
    safeCleanupTempDirectory(tempDirectory);
  }
}
