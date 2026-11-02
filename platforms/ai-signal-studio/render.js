import { spawn } from 'node:child_process';
import { mkdir, writeFile, rename, stat, rm } from 'node:fs/promises';
import path from 'node:path';

export function runCommand(program, args, { cwd, signal, timeout = 180000 } = {}) {
  return new Promise((resolve, reject) => {
    const combined = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout);
    const child = spawn(program, args, { cwd, signal: combined, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', chunk => { stdout = (stdout + chunk).slice(-262144); });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-8000); });
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve(stdout) : reject(Object.assign(new Error(`${program} exited ${code}`), { stderr })));
  });
}
export function wrapText(text, width) {
  const lines = []; let line = ''; let count = 0;
  for (const char of String(text)) {
    const size = /[\u0020-\u007e]/.test(char) ? 0.55 : 1;
    if (char === '\n' || count + size > width) { lines.push(line); line = ''; count = 0; if (char === '\n') continue; }
    line += char; count += size;
  }
  if (line) lines.push(line);
  return lines.join('\n');
}
const timecode = seconds => {
  const ms = Math.round(seconds * 1000);
  return `${String(Math.floor(ms / 3600000)).padStart(2, '0')}:${String(Math.floor(ms / 60000) % 60).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`;
};
export async function renderVideo({ directory, project, signal, onProgress = async () => {} }) {
  await mkdir(directory, { recursive: true });
  const scratch = path.join(directory, 'work'); await mkdir(scratch);
  const [width, height] = { portrait: [720, 1280], landscape: [1280, 720], square: [720, 720] }[project.ratio];
  const [background, accent, light] = { forest: ['102f29', '7ce2b8', 'e7fff2'], ocean: ['122b48', '81bbff', 'eef6ff'], sunset: ['3d2233', 'ffbb84', 'fff1e6'] }[project.theme];
  const font = process.env.STUDIO_FONT || '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc';
  const size = width === 1280 ? 38 : 34;
  const headingSize = width === 1280 ? 62 : 48;
  const contentWidth = Math.floor((width - 130) / size);
  const bodyY = height === 1280 ? 490 : 285;
  const headingY = height === 1280 ? 320 : 155;
  const captions = []; let duration = 0;
  await writeFile(path.join(scratch, 'title.txt'), wrapText(project.script.title, width === 1280 ? 38 : 24));
  try {
    for (let i = 0; i < project.script.scenes.length; i++) {
      signal?.throwIfAborted();
      const scene = project.script.scenes[i];
      await writeFile(path.join(scratch, 'heading.txt'), wrapText(scene.heading, Math.floor((width - 130) / headingSize)));
      await writeFile(path.join(scratch, 'body.txt'), wrapText(scene.text, contentWidth));
      let seconds = scene.seconds;
      if (project.voice) {
        await writeFile(path.join(scratch, 'narration.txt'), scene.narration);
        await runCommand('espeak-ng', ['-v', 'cmn', '-s', '190', '-f', 'narration.txt', '-w', 'speech.wav'], { cwd: scratch, signal, timeout: 30000 });
        const audio = JSON.parse(await runCommand('ffprobe', ['-v', 'error', '-show_format', '-of', 'json', 'speech.wav'], { cwd: scratch, signal }));
        seconds = Math.max(seconds, Math.ceil(Number(audio.format.duration) + 0.4));
        if (!Number.isFinite(seconds) || seconds > 60) throw new Error('Invalid speech duration');
      }
      const draw = (file, fontSize, color, x, y, extra = '') => `drawtext=fontfile=${font}:textfile=${file}:expansion=none:fontsize=${fontSize}:fontcolor=0x${color}:x=${x}:y=${y}:line_spacing=16${extra}`;
      const filter = [
        `drawbox=x=0:y=0:w=${width}:h=12:color=0x${accent}:t=fill`,
        `drawbox=x=${width - 175}:y=${height - 280}:w=320:h=320:color=0x${accent}@0.08:t=fill`,
        `drawbox=x=62:y=${headingY - 50}:w=54:h=5:color=0x${accent}:t=fill`,
        draw('title.txt', 22, accent, 62, 55),
        draw('heading.txt', headingSize, light, 62, headingY),
        draw('body.txt', size, light, 62, bodyY),
        `drawtext=fontfile=${font}:text='${String(i + 1).padStart(2, '0')} / ${String(project.script.scenes.length).padStart(2, '0')}':fontsize=24:fontcolor=0x${accent}:x=62:y=${height - 85}`,
        `drawbox=x=62:y=${height - 40}:w=${width - 124}:h=3:color=0x${accent}@0.2:t=fill`,
        `drawtext=fontfile=${font}:text='—':fontsize=50:fontcolor=0x${accent}:x='62+(${width - 170})*t/${seconds}':y=${height - 78}`,
        'fade=t=in:st=0:d=0.25', `fade=t=out:st=${seconds - 0.25}:d=0.25`,
      ].join(',');
      const args = ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `color=c=0x${background}:s=${width}x${height}:r=24:d=${seconds}`];
      if (project.voice) args.push('-i', 'speech.wav');
      else args.push('-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo');
      args.push('-vf', filter, '-af', 'apad', '-t', String(seconds), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-pix_fmt', 'yuv420p', '-threads', '2', '-c:a', 'aac', '-ar', '44100', '-ac', '2', '-b:a', '96k', '-movflags', '+faststart', `scene-${i}.mp4`);
      await runCommand('ffmpeg', args, { cwd: scratch, signal });
      captions.push(`${i + 1}\n${timecode(duration)} --> ${timecode(duration + seconds)}\n${scene.heading}\n${scene.text}\n`);
      duration += seconds;
      await onProgress(15 + Math.round(65 * (i + 1) / project.script.scenes.length));
    }
    await writeFile(path.join(scratch, 'concat.txt'), project.script.scenes.map((_, i) => `file 'scene-${i}.mp4'`).join('\n'));
    await runCommand('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '1', '-i', 'concat.txt', '-c', 'copy', '-movflags', '+faststart', '../video.tmp.mp4'], { cwd: scratch, signal });
    await onProgress(88);
    const probe = JSON.parse(await runCommand('ffprobe', ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', 'video.tmp.mp4'], { cwd: directory, signal }));
    const video = probe.streams.find(stream => stream.codec_type === 'video');
    if (video?.codec_name !== 'h264' || video.width !== width || video.height !== height || !(Number(probe.format.duration) > 0)) throw new Error('Video validation failed');
    await runCommand('ffmpeg', ['-hide_banner', '-v', 'error', '-xerror', '-i', 'video.tmp.mp4', '-f', 'null', '-'], { cwd: directory, signal });
    await runCommand('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-ss', '1', '-i', 'video.tmp.mp4', '-frames:v', '1', 'poster.png'], { cwd: directory, signal });
    await writeFile(path.join(directory, 'subtitles.srt'), captions.join('\n'));
    await writeFile(path.join(directory, 'script.json'), JSON.stringify({ ...project.script, created_at: new Date().toISOString(), implementation: 'tianhe-local', project_id: project.id, voice: project.voice ? 'local-mandarin' : 'none' }, null, 2));
    signal?.throwIfAborted();
    await rename(path.join(directory, 'video.tmp.mp4'), path.join(directory, 'video.mp4'));
    const sizeBytes = (await stat(path.join(directory, 'video.mp4'))).size;
    const metadata = { width, height, duration: Number(probe.format.duration), sizeBytes, codec: 'h264' };
    await writeFile(path.join(directory, 'validation.tmp.json'), JSON.stringify({ ...metadata, full_decode: 'passed', validated_at: new Date().toISOString() }));
    signal?.throwIfAborted();
    await rename(path.join(directory, 'validation.tmp.json'), path.join(directory, 'validation.json'));
    return metadata;
  } finally {
    // Only generated scratch files in this newly allocated run directory are removed.
    await rm(scratch, { recursive: true, force: true });
  }
}
