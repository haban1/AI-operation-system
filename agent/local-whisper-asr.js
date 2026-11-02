import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import { config } from '../src/config.js';

export const LOCAL_ASR_MODEL = 'local:whisper-small';
const execFileAsync = promisify(execFile);
const asrError = (code, message) => Object.assign(new Error(message), { code });

// The model is shared read-only with OpenChatCut. Each request owns its audio
// and output directory, so concurrent requests cannot overwrite each other.
export async function callLocalWhisperAsr({
  audioBuffer,
  model = LOCAL_ASR_MODEL,
  modelPath = config.localAsrModelPath,
  executable = config.localAsrExecutable,
  ffmpegExecutable = ffmpegInstaller.path,
  threads = config.localAsrThreads,
  timeoutMs = config.audioAsrTimeoutMs,
  execFileImpl = execFileAsync
} = {}) {
  if (model !== LOCAL_ASR_MODEL) throw asrError('LOCAL_ASR_MODEL_UNSUPPORTED', '当前本地语音识别支持 local:whisper-small，请在 AI 配置中修改音视频转文字模型');
  if (!modelPath || !(await fs.stat(modelPath).catch(() => null))?.isFile()) {
    throw asrError('LOCAL_ASR_MODEL_MISSING', '本地语音识别模型未安装或未挂载，请安装 Whisper Small 模型后重试');
  }
  if (!Buffer.isBuffer(audioBuffer) || !audioBuffer.length) throw asrError('AUDIO_EMPTY', '未收到有效音频');
  const startedAt = Date.now();
  const remaining = () => {
    const ms = timeoutMs - (Date.now() - startedAt);
    if (ms <= 0) throw asrError('ASR_TIMEOUT', '本地语音识别超时，请稍后重试或缩短视频');
    return ms;
  };
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tianhe-whisper-'));
  try {
    const input = path.join(directory, 'input.audio');
    const wav = path.join(directory, 'audio.wav');
    const output = path.join(directory, 'transcript');
    await fs.writeFile(input, audioBuffer);
    await execFileImpl(ffmpegExecutable, [
      '-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-i', input,
      '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wav
    ], { timeout: remaining(), maxBuffer: 1024 * 1024, windowsHide: true });
    await execFileImpl(executable, [
      '-m', modelPath, '-f', wav, '-l', 'zh', '-t', String(threads),
      '-ng', '-nt', '-np', '-otxt', '-of', output,
      '--prompt', '以下是普通话语音，请使用简体中文转写。'
    ], { timeout: remaining(), maxBuffer: 4 * 1024 * 1024, windowsHide: true });
    const text = (await fs.readFile(`${output}.txt`, 'utf8')).trim();
    if (!text) throw asrError('ASR_EMPTY_TRANSCRIPT', '本地语音识别未返回转写文本');
    return { text, model, usage: null, elapsedMs: Date.now() - startedAt, local: true };
  } catch (error) {
    if (error?.killed || error?.code === 'ETIMEDOUT') throw asrError('ASR_TIMEOUT', '本地语音识别超时，请稍后重试或缩短视频');
    if (error?.code === 'ENOENT') throw asrError('LOCAL_ASR_UNAVAILABLE', '本地语音识别组件不可用，请更新天河容器后重试');
    if (typeof error?.code === 'string' && /^(ASR_|LOCAL_ASR_)/.test(error.code)) throw error;
    throw asrError('LOCAL_ASR_FAILED', '本地语音识别失败，请检查音频及模型文件后重试');
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}
