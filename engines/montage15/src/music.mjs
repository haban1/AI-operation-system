import { readFileSync } from 'node:fs';

const catalog = JSON.parse(readFileSync(new URL('../templates/montage15/catalog.json', import.meta.url), 'utf8'));
export const musicTracks = catalog.map(template => ({
  id: template.id,
  title: template.soundtrack.title,
  author: template.soundtrack.author,
  bpm: template.soundtrack.bpm,
  musicFile: template.soundtrack.musicFile,
  mood: {
    'perspective-flow': '动感、现场、推进',
    'prism-pulse': '强节奏、运动、快切',
    'film-strip': '复古、纪实、轻松',
    'focus-story': '舒缓、温暖、沉浸',
    'split-journey': '轻快、旅行、明亮',
  }[template.id],
}));

export function selectedMusic(template, project) {
  if (!project.audio?.trackId || project.audio.trackId === 'template') return template.soundtrack;
  return musicTracks.find(track => track.id === project.audio.trackId);
}
