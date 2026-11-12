import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { exec, FFMPEG } from './media.mjs';

export class VisualIndex {
  constructor(root) {
    this.root = root;
    this.binary = path.join(root, 'local-vision', 'classify-frame');
    this.build = null;
  }

  async ready() {
    if (process.platform !== 'darwin') return false;
    this.build ||= (async () => {
      await fs.mkdir(path.dirname(this.binary), { recursive: true });
      try { await fs.access(this.binary, fs.constants.X_OK); }
      catch {
        await exec('/usr/bin/xcrun', ['swiftc', '-O', fileURLToPath(new URL('./classify-frame.swift', import.meta.url)), '-o', this.binary], { timeout: 120000, maxBuffer: 500000 });
      }
      return true;
    })().catch(() => false);
    return this.build;
  }

  async describe(file, type, duration) {
    if (!(await this.ready())) return { visualStatus: 'unavailable', visualDescription: '画面识别暂不可用，当前使用文件资料索引' };
    const directory = await fs.mkdtemp(path.join(this.root, 'tmp', 'visual-'));
    try {
      const inPoints = type === 'image' ? [0] : [...new Set([0, .25, .5, .75, 1].map(part => Math.floor(Math.max(0, duration - 3) * part * 30) / 30))];
      const frames = [];
      for (const inPoint of inPoints) {
        const frame = path.join(directory, 'frame.jpg');
        await exec(FFMPEG, ['-v', 'error', '-nostdin', '-y', ...(type === 'video' ? ['-ss', String(inPoint)] : []), '-i', file, '-frames:v', '1', '-vf', 'scale=640:640:force_original_aspect_ratio=decrease', frame], { timeout: 30000, maxBuffer: 100000 });
        const result = JSON.parse((await exec(this.binary, [frame], { timeout: 30000, maxBuffer: 50000 })).stdout);
        frames.push({ inPoint, ...result });
      }
      return { visualStatus: 'ready', visualVersion: 1, visualDuration: duration, frames,
        visualDescription: '本机画面识别线索，' + frames.map(frame => `${frame.inPoint}秒：${frame.labels.join('、')}，检测到${frame.detectedPeople}个人物区域`).join('；') };
    } catch {
      return { visualStatus: 'failed', visualDescription: '画面识别未完成，当前使用文件资料索引' };
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  }
}
