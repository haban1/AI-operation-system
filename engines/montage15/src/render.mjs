import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { assertRenderable, digest, fail } from './domain.mjs';
import { hashFile, probe, exec, FFMPEG } from './media.mjs';
import { buildHtml, getTemplate } from './templates.mjs';
import { writeJson } from './store.mjs';
import { templateAudio, audioMixFilters } from './audio.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENGINE_VERSION = '0.9.27';
const CHROME_CANDIDATES = [process.env.VIDEO_BROWSER_PATH, process.env.HYPERFRAMES_BROWSER_PATH, process.env.CHROME_EXECUTABLE_PATH, '/Users/jy/Library/Caches/ms-playwright/chromium_headless_shell-1228/chrome-headless-shell-mac-arm64/chrome-headless-shell', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].filter(Boolean);

export async function findBrowser() {
  for (const browser of CHROME_CANDIDATES) { try { await fs.access(browser, fs.constants.X_OK); return browser; } catch {} }
  return null;
}

export const publicJob = job => ({ id: job.id, projectId: job.projectId, projectName: job.projectName,
  templateId: job.templateId, revision: job.revision, status: job.status, progress: job.progress,
  message: job.message, error: job.error || null, createdAt: job.createdAt, updatedAt: job.updatedAt,
  durationSeconds: job.durationSeconds, elapsedSeconds: job.elapsedSeconds, bytes: job.bytes, sha256: job.sha256,
  downloadUrl: job.status === 'succeeded' ? `/api/jobs/${job.id}/download` : null,
  videoUrl: job.status === 'succeeded' ? `/api/jobs/${job.id}/video` : null,
});

export class RenderQueue {
  constructor(store) { this.store = store; this.queue = []; this.running = false; this.currentChild = null; }
  async init() {
    for (const job of await this.store.all('jobs')) {
      if (['queued', 'rendering'].includes(job.status)) await this.update(job, { status: 'failed', progress: 0,
        message: '上次渲染被中断，可以重新导出', error: '服务已重启，上次任务未完成；不会将旧文件标为本次结果' });
    }
  }
  async update(job, changes) {
    return this.store.locked(`job:${job.id}`, async () => {
      if (['succeeded', 'failed', 'cancelled'].includes(job.status)) return;
      Object.assign(job, changes, { updatedAt: new Date().toISOString() }); await this.store.put('jobs', job);
    });
  }
  async enqueue(project, assets) {
    const template = project.templateSnapshot || getTemplate(project.templateId);
    assertRenderable(project, template, assets);
    const browserPath = await findBrowser();
    if (!browserPath) fail(503, 'BROWSER_UNAVAILABLE', '本机未找到可用 Chrome，暂时无法导出');
    const relevant = assets.filter(a => project.slots.some(s => s.assetId === a.id) || project.audio.assetId === a.id);
    for (const asset of relevant) {
      if (await hashFile(asset.mediaFile).catch(() => null) !== asset.mediaSha256) fail(422, 'ASSET_CHANGED', `素材“${asset.name}”缺失或已被外部修改，请重新导入`);
    }
    const builtInAudio = await Promise.all(templateAudio(template, project).map(async a => ({...a,
      sha256: await hashFile(path.join(ROOT, 'templates/montage15/audio', a.file)) })));
    const fingerprint = digest({ project, builtInAudio, audioMixVersion: 1, assetHashes: relevant.map(a => [a.id, a.mediaSha256]), engine: ENGINE_VERSION });
    const inFlight = (await this.store.all('jobs')).find(j => j.fingerprint === fingerprint && ['queued', 'rendering'].includes(j.status));
    if (inFlight) return inFlight;
    if (this.queue.length >= 3) fail(429, 'QUEUE_FULL', '已有多个导出任务，请等待当前任务完成');
    const now = new Date().toISOString();
    const job = { id: randomUUID(), projectId: project.id, projectName: project.name, templateId: project.templateId,
      revision: project.revision, project: structuredClone(project), assets: structuredClone(relevant), builtInAudio, fingerprint,
      engineVersion: ENGINE_VERSION, browserPath, status: 'queued', progress: 0, message: '等待本机渲染', createdAt: now, updatedAt: now };
    await this.store.put('jobs', job);
    this.queue.push(job);
    void this.drain();
    return job;
  }
  async drain() {
    if (this.running) return;
    this.running = true;
    try { while (this.queue.length) { const job = this.queue.shift(); this.currentJob = job; await this.render(job); } }
    finally { this.running = false; this.currentJob = null; }
  }
  async cancel(id) {
    const job = this.currentJob?.id === id ? this.currentJob : this.queue.find(item => item.id === id) || await this.store.get('jobs', id);
    if (!['queued', 'rendering'].includes(job.status)) return job;
    this.queue = this.queue.filter(item => item.id !== id);
    await this.update(job, { status: 'cancelled', progress: 0, message: '已取消导出，可再次导出已保存工程' });
    if (this.currentJob?.id === id) this.currentChild?.kill('SIGTERM');
    return job;
  }
  async render(job) {
    const started = Date.now();
    const directory = path.join(this.store.root, 'renders', job.id);
    const temporaryOutput = path.join(directory, 'output.partial.mp4');
    try {
      await this.update(job, { status: 'rendering', progress: 0.03, message: '正在准备已保存版本的素材' });
      await fs.mkdir(path.join(directory, 'assets'), { recursive: true });
      await fs.mkdir(path.join(directory, 'vendor'), { recursive: true });
      const copiedAssets = [];
      for (const asset of job.assets) {
        const filename = `${asset.id}${path.extname(asset.mediaFile)}`;
        await fs.copyFile(asset.mediaFile, path.join(directory, 'assets', filename), fs.constants.COPYFILE_FICLONE);
        if (await hashFile(path.join(directory, 'assets', filename)) !== asset.mediaSha256) throw new Error('排队期间素材已变化，请重新关联素材后导出');
        copiedAssets.push({ ...asset, url: `assets/${filename}` });
      }
      await fs.copyFile(path.join(ROOT, 'vendor', 'gsap.min.js'), path.join(directory, 'vendor', 'gsap.min.js'));
      for (const audio of job.builtInAudio || []) {
        const target = path.join(directory, 'assets', audio.file);
        await fs.copyFile(path.join(ROOT, 'templates/montage15/audio', audio.file), target);
        if (await hashFile(target) !== audio.sha256) throw new Error('内置音轨已发生变化，请重新发起导出');
      }
      await fs.writeFile(path.join(directory, 'index.html'), buildHtml(job.project, copiedAssets, { gsapUrl: 'vendor/gsap.min.js', interactive: false, templateAudioPrefix: 'assets' }));
      await writeJson(path.join(directory, 'input-snapshot.json'), { project: job.project, engineVersion: ENGINE_VERSION,
        assetHashes: job.assets.map(a => ({ id: a.id, sha256: a.mediaSha256 })), builtInAudio: job.builtInAudio, fingerprint: job.fingerprint });
      await this.update(job, { progress: 0.08, message: '正在本机逐帧渲染，请保持服务运行' });
      if (job.status === 'cancelled') return;
      const logPath = path.join(directory, 'render.log');
      const log = await fs.open(logPath, 'w');
      let tail = '';
      try {
        await new Promise((resolve, reject) => {
          const args = [path.join(ROOT, 'node_modules', 'hyperframes', 'bin', 'hyperframes.mjs'), 'render', directory,
            '--output', temporaryOutput, '--fps', '30', '--quality', 'standard', '--sdr', '--workers', '1', '--no-browser-gpu', '--experimental-fast-capture=false'];
          const child = spawn(process.execPath, args, { cwd: directory, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env,
            HYPERFRAMES_BROWSER_PATH: job.browserPath || CHROME_CANDIDATES.find(Boolean), HYPERFRAMES_NO_TELEMETRY: '1',
            HYPERFRAMES_NO_UPDATE_CHECK: '1', DO_NOT_TRACK: '1', PRODUCER_LOW_MEMORY_MODE: '1', NO_COLOR: '1', CI: '1' } });
          this.currentChild = child;
          const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('渲染超过 15 分钟，请检查素材后重试')); }, 15 * 60 * 1000);
          timer.unref();
          let lineBuffer = '', lastProgressAt = 0, highestProgress = 0.08;
          const onData = data => {
            const value = data.toString(); tail = (tail + value).slice(-24000); void log.write(data).catch(() => {});
            const lines = (lineBuffer + value).split(/\r?\n/); lineBuffer = lines.pop().slice(-8192);
            for (const line of lines) {
              const match = /@hf-progress (\{.*\})/.exec(line);
              if (!match) continue;
              try {
                const progress = JSON.parse(match[1]);
                const fraction = Math.min(0.94, Math.max(0.08, Number(progress.pct) / 100));
                if (!Number.isFinite(fraction) || fraction < highestProgress || Date.now() - lastProgressAt < 1000) continue;
                highestProgress = fraction; lastProgressAt = Date.now();
                void this.update(job, { progress: fraction, message: progress.code === 'capture' && Number.isFinite(progress.done) && Number.isFinite(progress.total)
                  ? `正在本机渲染 ${progress.done}/${progress.total} 帧` : '正在本机处理画面和声音' }).catch(() => {});
              } catch {}
            }
          };
          child.stdout.on('data', onData); child.stderr.on('data', onData);
          child.once('error', error => { clearTimeout(timer); reject(error); });
          child.once('close', code => { clearTimeout(timer); this.currentChild = null; code === 0 ? resolve() : reject(new Error(`本地引擎退出（${code}）`)); });
        });
      } catch (error) {
        await fs.writeFile(path.join(directory, 'failure-summary.txt'), String(error.message) + '\n' + tail);
        throw error;
      } finally { await log.close(); }
      const tracks = (job.builtInAudio || []).map(a=>({...a, path:path.join(directory,'assets',a.file), inPoint:0}));
      if(job.project.audio.assetId && job.project.audio.musicEnabled !== false){const a=copiedAssets.find(a=>a.id===job.project.audio.assetId);tracks.push({role:'music',path:path.join(directory,a.url),inPoint:job.project.audio.inPoint??0,volume:job.project.audio.volume,duration:a.duration});}
      if(tracks.length){
        await this.update(job, {progress:.95,message:'正在混合配乐、淡入淡出和转场音效'});
        const mixed=path.join(directory,'output.sound.mp4'),args=['-v','error','-nostdin','-y','-i',temporaryOutput];
        tracks.forEach(t=>args.push('-i',t.path));
        const filters = audioMixFilters(tracks, job.project.audio);
        args.push('-filter_complex',filters.join(';'),'-map','0:v:0','-map','[aout]','-c:v','copy','-c:a','aac','-b:a','192k','-ar','48000','-ac','2','-t','15','-movflags','+faststart',mixed);
        await exec(FFMPEG,args,{timeout:180000,maxBuffer:1000000});await fs.rename(mixed,temporaryOutput);
      }
      await this.update(job, { progress: 0.96, message: '正在核对输出帧数、尺寸和文件摘要' });
      const info = await probe(temporaryOutput, true);
      const video = info.streams.find(s => s.codec_type === 'video');
      const duration = Number(info.format.duration);
      if (!video || video.width !== job.project.width || video.height !== job.project.height || Number(video.nb_read_frames) !== job.project.durationFrames || video.avg_frame_rate !== '30/1' || Math.abs(duration - 15) > 0.04)
        throw new Error('输出规格校验失败，请重试');
      if (((job.project.audio.assetId && job.project.audio.musicEnabled !== false) || job.builtInAudio?.length) && !info.streams.some(s => s.codec_type === 'audio')) throw new Error('音乐或音效轨未输出，请重试');
      const finalFile = path.join(directory, 'video.mp4');
      if (job.status === 'cancelled') { await fs.rm(temporaryOutput, { force: true }); return; }
      await fs.rename(temporaryOutput, finalFile);
      const stat = await fs.stat(finalFile);
      await this.update(job, { status: 'succeeded', progress: 1, message: '导出完成，可下载并进行素材验收', outputFile: finalFile,
        durationSeconds: duration, bytes: stat.size, sha256: await hashFile(finalFile), elapsedSeconds: Math.round((Date.now() - started) / 100) / 10 });
      if (job.status !== 'succeeded') return;
      await writeJson(path.join(directory, 'verification.json'), { jobId: job.id, revision: job.revision, fingerprint: job.fingerprint,
        engine: `HyperFrames ${ENGINE_VERSION}`, duration, frames: Number(video.nb_read_frames), width: video.width, height: video.height,
        fps: video.avg_frame_rate, audio: info.streams.some(s => s.codec_type === 'audio'), sha256: job.sha256, elapsedSeconds: job.elapsedSeconds });
    } catch (error) {
      await fs.rm(temporaryOutput, { force: true }).catch(() => {});
      if (job.status === 'cancelled') return;
      await this.update(job, { status: 'failed', progress: 0, message: '本次导出失败，可以修改素材后重试',
        error: `${error.message}。本次不会返回旧成片。`, elapsedSeconds: Math.round((Date.now() - started) / 100) / 10 });
    }
  }
}
