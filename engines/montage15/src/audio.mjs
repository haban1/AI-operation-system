import { selectedMusic } from './music.mjs';

// Built-in stems are versioned template resources, independent of imported media.
export function templateAudio(template, project) {
  if (!template?.soundtrack) return [];
  const a = project.audio || {};
  const tracks = [];
  if (a.musicEnabled !== false && !a.assetId) tracks.push({
    file: selectedMusic(template, project).musicFile, role: 'music', volume: a.volume ?? 0.8,
  });
  if (a.sfxEnabled !== false) tracks.push({
    file: template.soundtrack.sfxFile, role: 'sfx', volume: a.sfxVolume ?? 0.65,
  });
  return tracks;
}

export function audioMixFilters(tracks, audio) {
  const fadeIn = audio.fadeIn ?? .12;
  const fadeOut = audio.fadeOut ?? .6;
  const filters = tracks.map((track, index) => {
    const offset = track.role === 'music' ? audio.offset || 0 : 0;
    const delay = Math.max(0, offset);
    const start = track.inPoint + Math.max(0, -offset);
    const duration = Math.min(15 - delay, (track.duration ?? 15) - start);
    const fades = track.role === 'music'
      ? (fadeIn ? `,afade=t=in:d=${fadeIn}` : '') + (fadeOut ? `,afade=t=out:st=${Math.max(0, duration - fadeOut)}:d=${fadeOut}` : '')
      : '';
    return `[${index + 1}:a]atrim=start=${start}:duration=${duration},asetpts=PTS-STARTPTS,volume=${track.volume}${fades}${delay ? `,adelay=${Math.round(delay * 1000)}:all=1` : ''}[a${index}]`;
  });
  filters.push(tracks.map((_, index) => `[a${index}]`).join('') + `amix=inputs=${tracks.length}:normalize=0,apad,atrim=duration=15[aout]`);
  return filters;
}
