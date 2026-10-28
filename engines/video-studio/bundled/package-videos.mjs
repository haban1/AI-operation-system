import { createHash } from 'node:crypto';
import { readFile, writeFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';

const root = dirname(fileURLToPath(import.meta.url));
const entries = [
  ['01', 'Documentary', '纪录混剪', '证据与现场', '用讲解、演示与实操建立现场证据。'],
  ['02', 'Trailer', '预告片', '由静到燃', '从主题铺垫到现场证明，逐步提升节奏。'],
  ['03', 'Brand', '品牌开场', '分享的价值', '用分享、案例和实操呈现活动价值。'],
  ['04', 'Social', '社交短片', '三眼看现场', '竖屏短片，以三个现场要点快速展开。'],
  ['05', 'Beat', '节拍混剪', '现场脉动', '随配乐节拍组织镜头与分层文字。'],
  ['06', 'Contrast', '对照蒙太奇', '台上与台下', '交叉连接讲授与实践，保留场次区分。'],
];

const videos = [];
for (const [number, suffix, style, subtitle, description] of entries) {
  const filename = `V5_${number}_${suffix}.mp4`;
  const path = join(root, 'videos', filename);
  const probe = JSON.parse(execFileSync('ffprobe', [
    '-v', 'error', '-show_entries',
    'format=duration,size:stream=codec_type,codec_name,width,height,r_frame_rate',
    '-of', 'json', path,
  ], { encoding: 'utf8' }));
  const video = probe.streams.find((stream) => stream.codec_type === 'video');
  if (!video || !probe.streams.some((stream) => stream.codec_type === 'audio')) {
    throw new Error(`Missing video or audio: ${filename}`);
  }
  const poster = `V5_${number}_${suffix}.jpg`;
  const durationSeconds = Number(probe.format.duration);
  const posterAtSeconds = Math.min(durationSeconds / 3, 8);
  execFileSync('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
    '-ss', String(posterAtSeconds), '-i', path, '-frames:v', '1',
    '-vf', 'scale=960:960:force_original_aspect_ratio=decrease', '-q:v', '3',
    join(root, 'posters', poster)]);
  const bytes = await readFile(path);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  videos.push({
    id: `v5-${number}`, title: `${style} · ${subtitle}`, style, subtitle,
    description, styleId: `chatcut-source-pack-${number}`,
    sourceSkill: `chatcut-source-pack-${number}`,
    durationSeconds, width: video.width, height: video.height,
    orientation: video.width < video.height ? 'portrait' : 'landscape',
    bytes: (await stat(path)).size, sha256,
    videoPath: `/bundled/videos/${filename}`,
    posterPath: `/bundled/posters/${poster}`,
    posterAtSeconds, bundled: true,
    validation: { metadata: 'passed', posterDecoded: true },
  });
}

await writeFile(join(root, 'manifest.json'), JSON.stringify({
  schemaVersion: 1, title: '六套剪辑成片',
  mediaDelivery: 'repository-bundled',
  videos,
}, null, 2) + '\n');
console.log(JSON.stringify({ videos: videos.length, bytes: videos.reduce((sum, video) => sum + video.bytes, 0) }));
