import { readFileSync } from 'node:fs';
import { montageTemplates, buildMontageHtml } from './montage15.mjs';

// The unchanged upstream files are retained under templates/upstream/.
// These are self-contained portrait adaptations, awaiting material acceptance.
export const templates = [...montageTemplates, ...JSON.parse(readFileSync(new URL('../templates/catalog.json', import.meta.url), 'utf8')).map(t=>({...t,hidden:true}))];

export function getTemplate(id) {
  return templates.find((template) => template.id === id);
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

function scriptJson(value) {
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

function finiteNumber(value, fallback, min, max) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
}

function resourceUrl(value) {
  const url = String(value ?? '').trim();
  if (!url || /[\u0000-\u0020\\]/.test(url) || url.startsWith('//')) {
    throw new TypeError('Media and script URLs must be nonempty local URLs without control characters.');
  }
  if (/^[a-z][a-z\d+.-]*:/i.test(url)) {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)
      || !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)
      || parsed.username || parsed.password) {
      throw new TypeError('Only project-relative, same-origin path, or loopback resource URLs are supported.');
    }
  }
  return url;
}

function assetKind(asset) {
  const kind = String(asset?.kind ?? asset?.type ?? asset?.mimeType ?? asset?.mime ?? '').toLowerCase();
  if (kind === 'video' || kind.startsWith('video/')) return 'video';
  if (kind === 'image' || kind.startsWith('image/')) return 'image';
  if (kind === 'audio' || kind.startsWith('audio/')) return 'audio';
  return null;
}

/**
 * asset.url, when supplied, is the complete URL and always takes precedence.
 * Render callers should supply e.g. { ...asset, url: 'assets/clip.mp4' }.
 * Otherwise the fallback is `${assetPrefix}/${encodeURIComponent(asset.id)}`.
 * No original filesystem path is read or exposed by this function.
 */
function assetUrl(asset, assetPrefix) {
  if (typeof asset.url === 'string' && asset.url.trim()) return resourceUrl(asset.url);
  return resourceUrl(`${String(assetPrefix).replace(/\/$/, '')}/${encodeURIComponent(String(asset.id))}`);
}

function visualMarkup(slot, selection, asset, template, assetPrefix, index) {
  const start = slot.startFrame / template.fps;
  const duration = slot.durationFrames / template.fps;
  const inPoint = finiteNumber(selection?.inPoint, 0, 0, Number.MAX_SAFE_INTEGER);
  const focusX = finiteNumber(selection?.focusX, 0.5, 0, 1) * 100;
  const focusY = finiteNumber(selection?.focusY, 0.5, 0, 1) * 100;
  const kind = assetKind(asset);
  let visual;
  if (asset && (kind === 'video' || kind === 'image')) {
    const src = escapeHtml(assetUrl(asset, assetPrefix));
    const shared = `id="media-${slot.id}" class="shot-media" src="${src}" style="object-position:${focusX}% ${focusY}%"`;
    visual = kind === 'video'
      ? `<video ${shared} playsinline muted preload="auto" data-has-audio="false" data-volume="0" data-start="${start}" data-duration="${duration}" data-media-start="${inPoint}" data-track-index="0"></video>`
      : `<img ${shared} alt="" decoding="sync" loading="eager" />`;
  } else {
    visual = `<div class="sample-placeholder"><span class="sample-number">0${index + 1}</span><span class="sample-mark">＋</span><strong>示例占位·请替换素材</strong><span>${escapeHtml(slot.name)} · 视频或图片</span></div>`;
  }
  return `<section id="${slot.id}" class="shot clip" data-start="${start}" data-duration="${duration}" data-track-index="0" aria-label="${escapeHtml(slot.name)}">
    <div class="picture-frame">${visual}<div class="picture-shade"></div><div class="shot-caption"><span class="shot-index">0${index + 1}</span><span>${escapeHtml(slot.name)}</span></div></div>
  </section>`;
}

const compositionCss = `
*{box-sizing:border-box}html,body{margin:0;width:1080px;height:1920px;overflow:hidden}body{background:#fff;font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif}#root{position:relative;width:1080px;height:1920px;overflow:hidden;isolation:isolate;color:#142448;background:#fff}.canvas-decoration{position:absolute;inset:0;pointer-events:none;z-index:0}.brand-line{position:absolute;left:76px;right:76px;top:76px;display:flex;align-items:center;justify-content:space-between;gap:32px;z-index:30}.brand-name{display:flex;align-items:center;gap:18px;font-size:30px;line-height:1.3;font-weight:650;letter-spacing:2px;max-width:760px;overflow-wrap:anywhere}.brand-dot{flex:0 0 16px;width:16px;height:16px;border-radius:50%;background:var(--accent)}.edition{font-size:22px;font-weight:600;letter-spacing:4px;white-space:nowrap}.title-block{position:absolute;left:76px;right:76px;top:175px;z-index:30}.headline{font-size:var(--title-size);font-weight:800;line-height:1.14;letter-spacing:-3px;white-space:pre-wrap;overflow-wrap:anywhere;margin:0;max-height:300px}.subtitle{margin:32px 0 0;font-size:34px;line-height:1.5;letter-spacing:1px;white-space:pre-wrap;overflow-wrap:anywhere;max-height:104px;color:#50617d}.shot{position:absolute;left:0;top:0;width:1080px;height:1920px;visibility:hidden;z-index:10}.shot:first-of-type{visibility:visible}.picture-frame{position:absolute;left:62px;top:580px;width:956px;height:1038px;border:14px solid #fff;border-radius:38px;background:#eaf0fa;overflow:hidden;box-shadow:0 28px 70px #162d4940;transform-origin:50% 55%}.shot-media{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}.picture-shade{position:absolute;inset:0;background:linear-gradient(180deg,transparent 65%,#10233e66);pointer-events:none}.shot-caption{position:absolute;left:30px;right:30px;bottom:31px;display:flex;align-items:center;gap:18px;font-size:25px;font-weight:600;letter-spacing:2px;color:#fff;text-shadow:0 2px 10px #0008}.shot-index{display:grid;place-items:center;width:52px;height:52px;border:1px solid #fff9;border-radius:50%;font-size:21px;letter-spacing:0}.sample-placeholder{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:18px;background:#edf2fc;color:#304f7f;overflow:hidden}.sample-number{position:absolute;right:18px;bottom:40px;font-size:440px;font-weight:800;line-height:1;color:#dce6f6;letter-spacing:-36px;z-index:0}.sample-mark{display:grid;place-items:center;width:100px;height:100px;border:2px dashed #9aaecb;border-radius:25px;font-size:52px;font-weight:300;position:relative}.sample-placeholder strong{font-size:34px;font-weight:600;position:relative;margin-top:15px}.sample-placeholder>span:last-child{font-size:25px;color:#7a8ca8;position:relative;letter-spacing:2px}.film-footer{position:absolute;left:76px;right:76px;top:1700px;z-index:30}.footer-note{display:flex;align-items:center;justify-content:space-between;font-size:25px;letter-spacing:3px;font-weight:500}.footer-arrow{font-size:46px;line-height:1;color:var(--accent)}.progress-track{display:flex;gap:16px;margin-top:32px}.progress-piece{height:8px;border-radius:6px;background:#dbe3f0;flex:1;overflow:hidden}.progress-piece>i{display:block;height:100%;width:100%;background:var(--accent);transform:scaleX(0);transform-origin:left center}.play-mode .canvas-decoration:before{content:"";position:absolute;right:-220px;top:900px;width:660px;height:660px;background:var(--accent);border-radius:50%;opacity:.09}.play-mode .canvas-decoration:after{content:"";position:absolute;right:76px;top:400px;width:52px;height:52px;border:12px solid var(--accent);border-radius:12px;transform:rotate(12deg)}.warm-grain{background:#f5f0e0!important;color:#343b2e!important}.warm-grain .canvas-decoration{background-image:radial-gradient(#76664c17 .8px,transparent .8px);background-size:7px 7px;opacity:.75}.warm-grain .brand-line{top:84px}.warm-grain .brand-name{font-weight:500;letter-spacing:4px}.warm-grain .brand-dot{width:12px;height:12px;flex-basis:12px;border-radius:2px}.warm-grain .edition{font-weight:400;letter-spacing:5px;color:#857e69}.warm-grain .title-block{top:182px}.warm-grain .headline{font-weight:550;line-height:1.2;letter-spacing:5px}.warm-grain .subtitle{color:#817c68;font-size:32px;letter-spacing:2px}.warm-grain .picture-frame{left:76px;top:600px;width:928px;height:1008px;border:12px solid #fffaf0;border-radius:17px;box-shadow:0 18px 40px #5e4e2421;background:#e9e3d3}.warm-grain .sample-placeholder{background:#e9e3d3;color:#6e7259}.warm-grain .sample-number{color:#ded7c4;font-weight:400}.warm-grain .sample-mark{border-color:#aaa78e;border-radius:50%}.warm-grain .sample-placeholder>span:last-child{color:#938c75}.warm-grain .shot-caption{font-weight:400;letter-spacing:3px}.warm-grain .picture-shade{background:linear-gradient(180deg,transparent 70%,#3f3c2d66)}.warm-grain .film-footer{top:1700px}.warm-grain .footer-note{font-size:24px;color:#756f58;font-weight:400}.warm-grain .progress-piece{height:5px;background:#dcd6c3;border-radius:0}.warm-grain .progress-track{gap:20px;margin-top:35px}.warm-grain .canvas-decoration:after{content:"";position:absolute;left:76px;right:76px;top:160px;border-top:1px solid #aaa18466}.playback-error{position:absolute;z-index:100;left:50px;right:50px;bottom:40px;padding:24px;background:#fff4eb;color:#9b3f1f;border:2px solid #d99f85;font-size:28px;line-height:1.5}
`;

// This is our preview controller, not a renderer. With interactive=false no
// playback loop, media seeking, resizing, or message listeners are installed.
// HyperFrames alone drives the registered paused timeline during export.
function runtimeSource(config) {
  return `(() => {
    const config = ${scriptJson(config)};
    const root = document.getElementById('root');
    window.__timelines = window.__timelines || {};
    if (!window.gsap) {
      const warning = document.createElement('div');
      warning.className = 'playback-error';
      warning.textContent = '本地动画组件加载失败，请重新打开预览。';
      root.appendChild(warning);
      return;
    }
    // Measure the actual system-font layout in both preview and export. A
    // manual newline plus wrapping can make more than two visible lines.
    const header = root.querySelector?.('.title-block');
    if (header) {
      const headline = header.querySelector('.headline');
      const subtitle = header.querySelector('.subtitle');
      const picture = root.querySelector('.picture-frame');
      const availableHeight = picture.offsetTop - header.offsetTop - 24;
      let titleSize = parseFloat(getComputedStyle(headline).fontSize);
      while (header.offsetHeight > availableHeight && titleSize > 48) {
        headline.style.fontSize = (--titleSize) + 'px';
      }
      let subtitleSize = parseFloat(getComputedStyle(subtitle).fontSize);
      while (header.offsetHeight > availableHeight && subtitleSize > 24) {
        subtitle.style.fontSize = (--subtitleSize) + 'px';
      }
      if (header.offsetHeight > availableHeight + 0.5) {
        root.dataset.layoutError = 'text_overflow';
        throw new Error('TEXT_LAYOUT_OVERFLOW: title/subtitle cannot fit without clipping.');
      }
    }
    const tl = gsap.timeline({paused: true});
    window.__timelines.main = tl;
    const warm = config.templateId === 'warm-grain';
    tl.set('.shot', {autoAlpha: 0}, 0);
    config.shots.forEach((shot, index) => {
      const selector = '#' + shot.id;
      tl.set(selector, {autoAlpha: 1}, shot.start);
      if (index < config.shots.length - 1) tl.set(selector, {autoAlpha: 0}, shot.end);
      // Keep the picture present at every frame, including the opening frame.
      tl.fromTo(selector + ' .picture-frame',
        {scale: warm ? 0.985 : 0.96, y: warm ? 9 : 20, rotation: warm ? -0.45 : 0},
        {scale: 1, y: 0, rotation: 0, duration: warm ? 1.2 : 0.65, ease: warm ? 'power2.out' : 'back.out(1.2)'}, shot.start);
      tl.fromTo('#progress-' + (index + 1), {scaleX: 0}, {scaleX: 1, duration: shot.end - shot.start, ease: 'none'}, shot.start);
    });
    tl.fromTo('.title-block', {y: 14}, {y: 0, duration: 0.8, ease: 'power2.out'}, 0);
    tl.to({}, {duration: 0.001}, config.duration - 0.001);
    tl.pause(0);
    if (!config.interactive) return;

    let currentFrame = 0;
    let playing = false;
    let raf = 0;
    let baseFrame = 0;
    let baseTime = 0;
    let lastSentFrame = -1;
    let lastSentPlaying = null;
    const videos = config.shots.map(shot => ({...shot, element: document.getElementById('media-' + shot.id)}))
      .filter(shot => shot.element && shot.element.tagName === 'VIDEO');
    const music = document.getElementById('background-audio');
    videos.forEach(shot => { shot.element.muted = true; shot.element.volume = 0; });
    if (music) music.volume = config.audioVolume;

    function emit(force = false) {
      if (!force && currentFrame === lastSentFrame && playing === lastSentPlaying) return;
      lastSentFrame = currentFrame;
      lastSentPlaying = playing;
      if (window.parent !== window && location.origin !== 'null') {
        window.parent.postMessage({type: 'workbench:time', frame: currentFrame, playing}, location.origin);
      }
    }
    function pauseAllMedia() {
      videos.forEach(shot => shot.element.pause());
      if (music) music.pause();
    }
    function placeMedia(element, desired, active, force) {
      if (!active) { element.pause(); return; }
      const end = Number.isFinite(element.duration) && element.duration > 0 ? Math.max(0, element.duration - 0.001) : Infinity;
      // Chrome quantizes currentTime to microseconds: 209/30 can become
      // 6.966666 and select frame 208. This decoding-only epsilon is 0.0001 s,
      // far below half a frame. Project/UI time and export timing stay exact.
      const seekEpsilon = force && element.tagName === 'VIDEO' ? 0.0001 : 0;
      const target = Math.min(end, Math.max(0, desired) + seekEpsilon);
      if (element.readyState >= 1 && (force || Math.abs(element.currentTime - target) > 0.15)) {
        try { element.currentTime = target; } catch (_) { /* Metadata may change during relinking. */ }
      }
      if (playing && currentFrame < config.totalFrames && desired < end && element.paused) {
        const promise = element.play();
        if (promise && typeof promise.catch === 'function') promise.catch(() => {});
      } else if (!playing || currentFrame >= config.totalFrames || desired >= end) element.pause();
    }
    function paint(force = false) {
      // A cursor at 450 shows the last visible frame while reporting 15 s.
      const time = Math.min(currentFrame / config.fps, (config.totalFrames - 1) / config.fps);
      tl.seek(time, false);
      videos.forEach(shot => placeMedia(shot.element, shot.inPoint + time - shot.start, time >= shot.start && time < shot.end, force));
      if (music) placeMedia(music, time, true, force);
      emit();
    }
    function pause() {
      playing = false;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      pauseAllMedia();
      emit();
    }
    function tick(now) {
      if (!playing) return;
      currentFrame = Math.min(config.totalFrames, Math.floor(baseFrame + (now - baseTime) * config.fps / 1000));
      if (currentFrame >= config.totalFrames) {
        playing = false;
        raf = 0;
        paint(true);
        pauseAllMedia();
        emit(true);
        return;
      }
      paint();
      raf = requestAnimationFrame(tick);
    }
    function play() {
      if (playing) return;
      if (currentFrame >= config.totalFrames) currentFrame = 0;
      playing = true;
      baseFrame = currentFrame;
      baseTime = performance.now();
      paint(true);
      raf = requestAnimationFrame(tick);
    }
    function seek(frame) {
      if (typeof frame !== 'number' || !Number.isFinite(frame)) return;
      currentFrame = Math.min(config.totalFrames, Math.max(0, Math.round(frame)));
      if (currentFrame >= config.totalFrames) pause();
      baseFrame = currentFrame;
      baseTime = performance.now();
      paint(true);
      emit(true);
    }
    function fitPreview() {
      const scale = Math.min(window.innerWidth / config.width, window.innerHeight / config.height);
      root.style.transformOrigin = 'top left';
      root.style.transform = 'scale(' + scale + ')';
      root.style.left = ((window.innerWidth - config.width * scale) / 2) + 'px';
      root.style.top = ((window.innerHeight - config.height * scale) / 2) + 'px';
      document.documentElement.style.width = '100%';
      document.documentElement.style.height = '100%';
      document.body.style.width = '100%';
      document.body.style.height = '100%';
    }
    window.addEventListener('message', event => {
      if (event.source !== window.parent || event.origin !== location.origin) return;
      const message = event.data;
      if (!message || typeof message !== 'object') return;
      if (message.type === 'workbench:seek') seek(message.frame ?? message.payload?.frame);
      else if (message.type === 'workbench:play') play();
      else if (message.type === 'workbench:pause') pause();
    });
    document.addEventListener('visibilitychange', () => { if (document.hidden) pause(); });
    window.addEventListener('pagehide', pause);
    window.addEventListener('resize', fitPreview);
    if ('IntersectionObserver' in window) {
      new IntersectionObserver(entries => { if (entries[0] && !entries[0].isIntersecting) pause(); }).observe(root);
    }
    [...videos.map(shot => shot.element), ...(music ? [music] : [])].forEach(element => {
      element.addEventListener('loadedmetadata', () => paint(true));
    });
    window.__workbench = {play, pause, seek, getState: () => ({frame: currentFrame, playing})};
    fitPreview();
    paint(true);
    emit(true);
  })();`;
}

export function buildHtml(project, assets = [], {
  assetPrefix = '/api/assets',
  gsapUrl = '/vendor/gsap.min.js',
  interactive = true,
  templateAudioPrefix = '/template-audio',
} = {}) {
  const template = project?.templateSnapshot || getTemplate(project?.templateId);
  if (!template) throw new TypeError(`Unknown template: ${String(project?.templateId ?? '')}`);
  if (template.engine === 'montage15') return buildMontageHtml(template, project, assets, {assetPrefix, gsapUrl, interactive, templateAudioPrefix});
  const fields = { ...template.defaults, ...(project.fields ?? {}) };
  const accent = /^#(?:[\da-f]{3}|[\da-f]{6}|[\da-f]{8})$/i.test(String(fields.accent))
    ? String(fields.accent) : template.defaults.accent;
  const byId = new Map((Array.isArray(assets) ? assets : []).map(asset => [String(asset.id), asset]));
  const bySlot = new Map((Array.isArray(project.slots) ? project.slots : []).map(slot => [slot.id, slot]));
  const visual = template.slots.map((slot, index) => {
    const selection = bySlot.get(slot.id);
    return visualMarkup(slot, selection, byId.get(String(selection?.assetId)), template, assetPrefix, index);
  }).join('\n');
  const requestedAudio = byId.get(String(project.audio?.assetId));
  const music = assetKind(requestedAudio) === 'audio' ? requestedAudio : null;
  const audioVolume = finiteNumber(project.audio?.volume, 0.6, 0, 1);
  const duration = template.durationFrames / template.fps;
  const audio = music
    ? `<audio id="background-audio" src="${escapeHtml(assetUrl(music, assetPrefix))}" preload="auto" data-start="0" data-duration="${duration}" data-media-start="0" data-volume="${audioVolume}" data-track-index="2"></audio>`
    : '';
  const titleLength = [...String(fields.title ?? '')].length;
  const titleSize = titleLength > 24 ? 64 : titleLength > 16 ? 74 : 86;
  const subtitleSize = [...String(fields.subtitle ?? '')].length > 42 ? 28 : template.id === 'warm-grain' ? 32 : 34;
  const config = {
    templateId: template.id,
    width: template.width, height: template.height,
    fps: template.fps, totalFrames: template.durationFrames, duration,
    interactive: Boolean(interactive), audioVolume,
    shots: template.slots.map(slot => ({
      id: slot.id,
      start: slot.startFrame / template.fps,
      end: (slot.startFrame + slot.durationFrames) / template.fps,
      inPoint: finiteNumber(bySlot.get(slot.id)?.inPoint, 0, 0, Number.MAX_SAFE_INTEGER),
    })),
  };
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=1080, height=1920" />
<title>${escapeHtml(fields.title || template.name)}</title>
<!-- Portrait adaptation of HeyGen HyperFrames ${escapeHtml(template.id)}. Apache-2.0; see THIRD_PARTY_NOTICES.md. -->
<script>window.__timelines = window.__timelines || {};</script>
<script src="${escapeHtml(resourceUrl(gsapUrl))}"></script>
<style>${compositionCss}</style>
</head>
<body>
<div id="root" class="${template.id}" data-composition-id="main" data-start="0" data-duration="${duration}" data-width="${template.width}" data-height="${template.height}" data-fps="${template.fps}" style="--accent:${accent};--title-size:${titleSize}px">
  <div class="canvas-decoration"></div>
  <div class="brand-line"><div class="brand-name"><span class="brand-dot"></span><span>${escapeHtml(fields.brand)}</span></div><span class="edition">15 SEC.</span></div>
  <div class="title-block"><h1 class="headline" style="max-height:none">${escapeHtml(fields.title)}</h1><p class="subtitle" style="max-height:none;font-size:${subtitleSize}px">${escapeHtml(fields.subtitle)}</p></div>
  ${visual}
  <div class="film-footer"><div class="footer-note"><span>${template.id === 'warm-grain' ? '每个细节，都值得留下' : '精彩，从这一刻开始'}</span><span class="footer-arrow">↗</span></div><div class="progress-track"><span class="progress-piece"><i id="progress-1"></i></span><span class="progress-piece"><i id="progress-2"></i></span><span class="progress-piece"><i id="progress-3"></i></span></div></div>
  ${audio}
</div>
<script>${runtimeSource(config)}</script>
</body>
</html>`;
}
