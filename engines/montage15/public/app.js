/* Local template workbench. All user-facing values are inserted as text or escaped. */
(() => {
  'use strict';
  const base = new URL('.', document.currentScript.src).pathname.replace(/\/$/, '');
  const resource = value => base + value;
  const storageKey = 'video-workbench:last-project:' + base;
  let librarySlot = null;
  let libraryBusy = false;

  const $ = (id) => document.getElementById(id);
  const state = {
    templates: [], templateCatalog: [], musicTracks: [], assets: [], projects: [], jobs: [], project: null, templateId: null, sessionToken: null,
    dirty: false, saving: false, creating: false, rendering: false, importing: false,
    playing: false, frame: 0, tab: 'templates', job: null, pollTimer: null, pollEpoch: 0, toastTimer: null,
  };
  const workflow = new window.MontageWorkflow({ state, api, saveProject, setProject, markDirty, renderAssets, toast, showError, resource, updateStatus });
  const production = new window.MontageProduction({ state, api, resource, saveProject, setProject, markDirty, workflow, toast, showError, renderProject, refreshEditor: renderInspector, seek: frame => { sendPreview('pause'); sendPreview('seek', { frame }); } });
  const workspace = new window.MontageWorkspace({ state, api, production, workflow, resource, saveProject, openProject, openNewProjectDialog, markDirty, refreshEditor: renderInspector, toast, action: callback => production.action(callback) });
  production.onWorkspace = () => workspace.render();
  workflow.onWorkspace = () => workspace.renderGallery();
  production.replaceAsset = (...args) => workspace.replaceAsset(...args);
  const typeNames = { video: '视频', image: '图片', audio: '音频' };
  const escape = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const currentTemplate = () => state.project?.templateSnapshot || state.templateCatalog.find((t) => t.id === (state.project?.templateId || state.templateId));
  const assetById = (id) => state.assets.find((a) => a.id === id);
  const finite = (v, fallback = 0) => Number.isFinite(Number(v)) ? Number(v) : fallback;
  const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
  const secondsLabel = (n) => `${Number(finite(n).toFixed(2))} 秒`;
  const slotSeconds = (slot) => slot.durationFrames / (currentTemplate()?.fps || 30);
  const localUrl = (value) => { try { const u = new URL(value, location.origin); return u.origin === location.origin ? `${u.pathname}${u.search}` : null; } catch { return null; } };

  async function api(path, options = {}) {
    const headers = { ...options.headers };
    if (options.body && typeof options.body === 'string') headers['Content-Type'] = 'application/json';
    if (options.method && !['GET', 'HEAD'].includes(options.method.toUpperCase()) && state.sessionToken) headers['x-workbench-token'] = state.sessionToken;
    const response = await fetch(resource(path), { ...options, headers, cache: 'no-store', credentials: 'same-origin' });
    let result;
    try { result = await response.json(); } catch { throw new Error(`服务响应异常（${response.status}），请确认工作台仍在运行。`); }
    if (!response.ok) {
      const details = Array.isArray(result.details) ? result.details.map((d) => typeof d === 'string' ? d : d.message || '').filter(Boolean).join('；') : typeof result.details === 'string' ? result.details : '';
      const error = new Error(`${result.error || '操作未完成'}${details ? `：${details}` : ''}`);
      error.code = result.code;
      error.status = response.status;
      throw error;
    }
    return result;
  }

  function showError(error) {
    $('global-error-text').textContent = error?.message || String(error);
    $('global-error').hidden = false;
  }
  const run = (fn) => async (event) => { try { await fn(event); } catch (error) { showError(error); } };
  function toast(message) {
    clearTimeout(state.toastTimer);
    $('toast').textContent = message;
    $('toast').hidden = false;
    state.toastTimer = setTimeout(() => { $('toast').hidden = true; }, 3000);
  }
  function setTab(tab) {
    state.tab = tab;
    ['templates', 'assets'].forEach((name) => {
      $(`${name}-tab`).classList.toggle('active', name === tab);
      $(`${name}-tab`).setAttribute('aria-selected', String(name === tab));
      $(`${name}-panel`).hidden = name !== tab;
    });
  }

  function validation() {
    const template = currentTemplate();
    if (!state.project || !template) return { missing: 0, problems: ['请先创建工程。'] };
    let missing = 0;
    const problems = [];
    if (!state.project.name.trim()) problems.push('请填写工程名称');
    if (!state.project.fields.title.trim()) problems.push('请填写主标题');
    for (const def of template.slots) {
      const slot = state.project.slots.find((s) => s.id === def.id);
      const asset = slot && assetById(slot.assetId);
      if (!asset || !['video', 'image'].includes(asset.type)) {
        missing += 1;
        continue;
      }
      if (asset.type === 'video' && asset.duration + 0.035 < finite(slot.inPoint) + slotSeconds(def)) {
        problems.push(`${def.name}的可用视频不足 ${secondsLabel(slotSeconds(def))}`);
      }
    }
    if (missing && !(template.supportsColorCards && state.project.settings?.colorCards)) problems.unshift(`还需为 ${missing} 个画面位置选择素材`);
    const audio = assetById(state.project.audio?.assetId);
    if (audio?.type === 'audio' && audio.duration + 0.015 < finite(state.project.audio?.inPoint) + template.durationFrames / template.fps) {
      problems.push('音乐长度不足 15 秒，请换用更长音频或暂不添加音乐');
    }
    return { missing, problems };
  }

  function updateStatus() {
    const template = currentTemplate();
    const { missing, problems } = validation();
    const project = state.project;
    const cards = !!(template?.supportsColorCards && project?.settings?.colorCards);
    $('format-label').textContent = `${(project?.width || template?.width) > (project?.height || template?.height) ? '横屏 16:9' : '竖屏 9:16'} · 15 秒`;
    $('save-status').textContent = state.saving ? '正在保存…' : project ? state.dirty ? '有未保存修改' : '已保存到本机' : '模板预览';
    $('save-status').classList.toggle('is-dirty', state.dirty);
    $('save-button').disabled = !project || state.saving || state.rendering || state.workflowBusy;
    $('save-bottom-button').disabled = state.saving || state.rendering || state.workflowBusy;
    $('save-bottom-button').textContent = state.saving ? '正在保存…' : '保存并更新预览';
    $('render-button').disabled = !project || state.saving || state.rendering || state.workflowBusy || problems.length > 0;
    $('render-button').innerHTML = state.rendering ? '<span aria-hidden="true">◌</span> 正在导出' : '<span aria-hidden="true">↗</span> 导出视频';
    $('render-button').title = problems.length ? problems.join('；') : '保存当前工程并导出 MP4';
    $('edit-state').textContent = state.dirty ? '尚未保存' : '已保存';
    $('slot-readiness').textContent = template && project ? `${template.slots.length - missing} / ${template.slots.length} 已就绪` : '';
    $('validation-summary').textContent = problems.length ? `${problems.join('；')}。` : cards && missing ? `${missing} 个空槽位使用色卡，可直接预览和导出。` : '素材已就绪，可以保存并导出视频。';
    $('validation-summary').classList.toggle('ready', problems.length === 0);
    $('project-revision').textContent = project ? `修订 ${project.revision}${state.dirty ? ' · 有未保存修改' : ' · 已保存'}` : '先选一套模板，看看效果';
    $('preview-title').textContent = project?.name || template?.name || '准备你的下一条视频';
    const badge = $('preview-badge');
    badge.className = `badge ${!project ? 'badge-neutral' : problems.length ? 'badge-warning' : 'badge-ready'}`;
    badge.textContent = !project ? '色卡模板预览' : missing && cards ? '色卡演示' : missing ? `待补齐 ${missing} 个素材` : problems.length ? '需要调整' : '素材已就绪';
    const notice = $('preview-notice').lastElementChild;
    notice.textContent = !project ? '色卡代表素材位置。创建工程后，可以替换视频、图片和文字。' : state.dirty ? '有未保存修改。点击“保存并更新预览”后查看最新效果。' : missing && cards ? '空槽位使用色卡。选择素材即可替换，转场与时间结构保持不变。' : missing ? '请为每个画面位置选择素材，再进行导出。' : problems.length ? '请先处理右侧提示的问题，再进行导出。' : '正在预览已保存的工程。建议播放检查镜头、文字和音乐后再导出。';
    $('saved-preview-note').textContent = project ? `预览修订 ${project.revision}${state.dirty ? ' · 等待保存更新' : ''}` : '预览可播放、暂停及逐帧定位';
  }

  function markDirty() {
    if (!state.project) return;
    state.dirty = true;
    if (state.job && !['queued','rendering'].includes(state.job.status)) $('render-panel').hidden = true;
    production.changed();
    updateStatus();
  }

  function renderTemplates() {
    const templates = state.templates;
    $('template-count').textContent = templates.length;
    $('template-list').innerHTML = templates.map(t => `<article class="template-card ${t.id === state.templateId ? 'selected' : ''}"><button class="template-select" data-template-id="${escape(t.id)}" aria-label="预览${escape(t.name)}" aria-pressed="${t.id === state.templateId}"><img class="template-poster" src="${escape(resource('/posters/' + t.id + '.jpg'))}" alt=""><div class="template-card-body"><strong>${escape(t.name.replace(/^\d+ · /, ''))}</strong><small>${t.slots.length} 个镜头 · 15 秒</small></div></button></article>`).join('');
    $('template-list').querySelectorAll('[data-template-id]').forEach(button => button.addEventListener('click', run(() => selectTemplate(button.dataset.templateId))));
    $('new-project-template').innerHTML = templates.map(t => `<option value="${escape(t.id)}">${escape(t.name)}</option>`).join('');
  }

  function renderAssets() {
    $('asset-count').textContent = state.assets.length;
    $('asset-summary').textContent = state.assets.length ? `共 ${state.assets.length} 个本地素材` : '尚未导入素材';
    const filter = $('asset-filter').value;
    const assets = state.assets.filter((a) => filter === 'all' || a.type === filter);
    $('asset-list').innerHTML = assets.length ? assets.map((asset) => {
      const thumbnail = localUrl(asset.thumbnailUrl || (asset.type === 'image' ? asset.url : ''));
      const dimensions = asset.width && asset.height ? `${asset.width} × ${asset.height}` : '';
      const info = [asset.type !== 'image' ? secondsLabel(asset.duration) : '', dimensions].filter(Boolean).join(' · ');
      return `<article class="asset-card">${thumbnail ? `<img class="asset-thumb" src="${escape(thumbnail)}" alt="" loading="lazy" />` : `<div class="asset-thumb asset-thumb-fallback" aria-hidden="true">${asset.type === 'audio' ? '♫' : '▧'}</div>`}<div class="asset-info"><strong title="${escape(asset.name)}">${escape(asset.name)}</strong><small>${escape(info || typeNames[asset.type] || '素材')}</small></div><button type="button" class="text-button asset-note-button" data-asset-notes="${escape(asset.id)}">素材说明</button>${asset.description ? `<p class="asset-note-text">${escape(asset.description)}</p>` : ''}</article>`;
    }).join('') : `<div class="empty-assets">${state.assets.length ? '暂无此类型素材。' : '把准备好的素材导入这里。<br>然后在右侧为画面位置选择素材。'}</div>`;
    $('asset-list').querySelectorAll('[data-asset-notes]').forEach(button => button.addEventListener('click', run(() => workflow.openNotes(button.dataset.assetNotes))));
    workspace.renderGallery();
  }

  function renderProjectSelect() {
    const sorted = [...state.projects].sort((a, b) => new Date(b.updatedAt || b.createdAt) - new Date(a.updatedAt || a.createdAt));
    $('project-select').innerHTML = '<option value="">模板预览</option>' + sorted.map((p) => `<option value="${escape(p.id)}">${escape(p.name)}</option>`).join('');
    $('project-select').value = state.project?.id || '';
    if (document.body.classList.contains('is-home')) workspace.renderHome();
  }

  function renderInspector() {
    const template = currentTemplate();
    workflow.render();
    production.render();
    $('inspector-template').textContent = template?.name || '尚未选择';
    $('template-detail').hidden = !!state.project;
    $('use-template-button').hidden = !!state.project;
    $('use-template-button').disabled = !state.templates.some(item => item.id === template?.id);
    $('editor-form').hidden = !state.project;
    if (!state.project) {
      $('template-detail').innerHTML = template ? `<strong>${escape(template.name)}</strong><p>${escape(template.description)}</p><div class="detail-meta"><span>${template.slots.length} 个画面位置</span><span>15 秒</span><span>可换视频 / 图片</span></div><p style="margin-top:15px">创建工程后，为各个画面位置选择素材，再预览与导出。</p>` : '<p>选择左侧模板，查看样式与素材需求。</p>';
      updateStatus();
      return;
    }
    const p = state.project;
    $('project-name').value = p.name || '';
    ['title', 'subtitle', 'brand'].forEach((field) => { $(`field-${field}`).value = p.fields[field] || ''; });
    $('field-accent').value = /^#[\da-f]{6}$/i.test(p.fields.accent) ? p.fields.accent : '#d8ef7b';
    $('accent-value').textContent = $('field-accent').value;
    $('montage-controls').hidden = !template.supportsColorCards;
    if (template.supportsColorCards) {
      ['beat1','beat2','beat3'].forEach(key => { $(`field-${key}`).value = p.fields[key] || ''; });
      ['titles','brand','colorCards'].forEach(key => { $(`setting-${key}`).checked = p.settings[key]; });
      $('setting-intensity').value = p.settings.intensity;
      $('intensity-value').textContent = `${Math.round(p.settings.intensity * 100)}%`;
    }
    renderSlots();
    renderAudio();
    updateStatus();
  }

  function visualOptions(selected) {
    return `<option value="">${currentTemplate()?.supportsColorCards ? '选择视频或图片…' : '选择视频或图片…'}</option>` + [...new Map([...state.assets, ...(state.sourceItems || [])].map(a => [a.id, a])).values()].filter((a) => ['video', 'image'].includes(a.type)).map((a) => `<option value="${escape(a.id)}" ${a.id === selected ? 'selected' : ''}>${escape(a.name)}${a.type === 'video' ? ` · ${secondsLabel(a.duration)}` : ' · 图片'}</option>`).join('');
  }

  function renderSlots() {
    if (!state.project) return;
    const template = currentTemplate();
    $('slot-list').innerHTML = template.slots.map((def, index) => {
      const slot = state.project.slots.find((s) => s.id === def.id);
      const asset = assetById(slot?.assetId);
      const duration = slotSeconds(def);
      const start = def.startFrame / template.fps;
      const short = asset?.type === 'video' && asset.duration + 0.035 < finite(slot?.inPoint) + duration;
      return `<div class="slot-card" data-slot-id="${escape(def.id)}"><div class="slot-topline"><strong>${String(index + 1).padStart(2, '0')} ${escape(def.name)}</strong><span>${Number(start.toFixed(2))}–${Number((start + duration).toFixed(2))} 秒</span></div><select class="slot-asset-select" aria-label="${escape(def.name)}的素材">${visualOptions(slot?.assetId)}</select><button type="button" class="text-button slot-library-select">从系统素材库选择</button>${asset ? `<div class="slot-details"><div class="slot-asset-meta">${escape(typeNames[asset.type])} · ${asset.width || '—'} × ${asset.height || '—'}${asset.type === 'video' ? ` · 原片 ${secondsLabel(asset.duration)}` : ''}</div>${asset.type === 'video' ? `<label class="field-label" for="inpoint-${escape(def.id)}">从原片第几秒开始</label><input id="inpoint-${escape(def.id)}" class="slot-inpoint" type="number" min="0" step="0.01" value="${finite(slot.inPoint)}" aria-label="${escape(def.name)}取材起点" />` : ''}<div class="range-field"><label>水平焦点 <output class="focus-x-output">${Math.round(finite(slot.focusX, .5) * 100)}%</output></label><input class="slot-focus-x" type="range" min="0" max="1" step="0.01" value="${finite(slot.focusX, .5)}" aria-label="${escape(def.name)}水平裁切焦点" /></div><div class="range-field"><label>垂直焦点 <output class="focus-y-output">${Math.round(finite(slot.focusY, .5) * 100)}%</output></label><input class="slot-focus-y" type="range" min="0" max="1" step="0.01" value="${finite(slot.focusY, .5)}" aria-label="${escape(def.name)}垂直裁切焦点" /></div><p class="slot-warning" ${short ? '' : 'hidden'}>可用视频不足 ${secondsLabel(duration)}，请提前取材起点或更换素材。</p></div>` : '<p class="slot-empty">请从系统素材库选择，或导入本地视频和照片。</p>'}</div>`;
    }).join('');
    $('slot-list').querySelectorAll('.slot-card').forEach((card) => {
      const slot = state.project.slots.find((s) => s.id === card.dataset.slotId);
      const def = template.slots.find((s) => s.id === card.dataset.slotId);
      card.querySelector('.slot-asset-select').addEventListener('change', run(async (event) => {
        const selected = event.target.value;
        if (selected && !assetById(selected) && state.project.brief?.sourceId) {
          const { asset } = await api(`/api/source-folders/${state.project.brief.sourceId}/import`, { method: 'POST', body: JSON.stringify({ id: selected }) });
          state.assets.push(asset);
        }
        slot.assetId = selected || null;
        slot.inPoint = 0;
        slot.focusX = .5;
        slot.focusY = .5;
        workflow.lock('slots', slot.id);
        markDirty();
        renderSlots();
      }));
      card.querySelector('.slot-library-select').addEventListener('click',run(()=>openSystemLibrary(slot.id)));
      const inpoint = card.querySelector('.slot-inpoint');
      if (inpoint) inpoint.addEventListener('input', () => {
        slot.inPoint = Math.max(0, finite(inpoint.value));
        workflow.lock('slots', slot.id);
        const asset = assetById(slot.assetId);
        card.querySelector('.slot-warning').hidden = !(asset?.type === 'video' && asset.duration + .035 < slot.inPoint + slotSeconds(def));
        markDirty();
      });
      for (const axis of ['x', 'y']) {
        const range = card.querySelector(`.slot-focus-${axis}`);
        if (range) range.addEventListener('input', () => {
          slot[`focus${axis.toUpperCase()}`] = clamp(finite(range.value, .5), 0, 1);
          workflow.lock('slots', slot.id);
          card.querySelector(`.focus-${axis}-output`).textContent = `${Math.round(range.value * 100)}%`;
          markDirty();
        });
      }
    });
    workflow.decorateSlots();
  }

  function renderAudio() {
    if (!state.project) return;
    state.project.audio ||= { assetId: null, volume: .25 };
    const audio = state.project.audio;
    $('audio-select').innerHTML = '<option value="builtin:template">模板配套音乐</option>' + state.musicTracks.map(track => `<option value="builtin:${escape(track.id)}">${escape(track.title)} · ${escape(track.mood)}</option>`).join('') + state.assets.filter(a => a.type === 'audio').map(a => `<option value="asset:${escape(a.id)}">${escape(a.name)} · ${secondsLabel(a.duration)}</option>`).join('');
    $('audio-select').value = audio.assetId ? `asset:${audio.assetId}` : `builtin:${audio.trackId || 'template'}`;
    $('audio-volume').value = finite(audio.volume, .25);
    $('audio-volume-value').textContent = `${Math.round(finite(audio.volume, .25) * 100)}%`;
    $('music-enabled').checked = audio.musicEnabled !== false;
    $('sfx-enabled').checked = audio.sfxEnabled !== false;
    $('sfx-volume').value = audio.sfxVolume ?? .65;
    $('sfx-volume-value').textContent = `${Math.round((audio.sfxVolume ?? .65)*100)}%`;
    $('audio-inpoint').value = audio.inPoint ?? 0;
    $('audio-inpoint').disabled = !audio.assetId;
    $('audio-fadeout').value = audio.fadeOut ?? .6;
    const track = state.musicTracks.find(item => item.id === audio.trackId) || currentTemplate()?.soundtrack;
    const actualMusic = audio.assetId ? assetById(audio.assetId)?.name || '导入音乐' : track?.title || '';
    $('creation-music').textContent = `当前配乐 · ${actualMusic}`;
    $('creation-music-restore').hidden = !audio.assetId && (!audio.trackId || audio.trackId === 'template' || audio.trackId === state.project.templateId);
    $('soundtrack-info').textContent = audio.assetId ? '当前使用导入的音乐。' : track ? `当前配乐 ${track.title} · Kevin MacLeod，须保留署名。` : '可导入本地背景音乐。';

  }

  function resizePreview() {
    const stage = document.querySelector('.preview-stage');
    const t = state.project || currentTemplate();
    const ratio = t ? t.width / t.height : 16 / 9;
    const cap = ratio > 1 ? 1100 : 330;
    $('preview-shell').style.aspectRatio = String(ratio);
    $('preview-shell').style.width = `${Math.min(cap, stage.clientWidth, Math.max(150, (stage.clientHeight - 24) * ratio))}px`;
  }
  function resetPlayer() {
    state.frame = 0;
    state.playing = false;
    $('play-button').textContent = '▶';
    $('play-button').setAttribute('aria-label', '播放预览');
    $('timeline').value = 0;
    $('time-current').textContent = '00:00.00';
  }
  function refreshPreview() {
    const template = currentTemplate();
    resetPlayer();
    $('preview-placeholder').hidden = !!template;
    $('preview-frame').hidden = !template;
    ['play-button', 'restart-button', 'timeline'].forEach((id) => { $(id).disabled = !template; });
    if (!template) return;
    const p = state.project;
    $('preview-frame').src = resource(p ? `/api/projects/${encodeURIComponent(p.id)}/preview?revision=${p.revision}&v=${Date.now()}` : `/api/templates/${encodeURIComponent(template.id)}/preview`);
    $('timeline').max = template.durationFrames - 1;
    $('time-total').textContent = formatTime(template.durationFrames, template.fps);
    resizePreview();
  }
  function sendPreview(type, data = {}) {
    $('preview-frame').contentWindow?.postMessage({ type: `workbench:${type}`, ...data }, location.origin);
  }
  function formatTime(frame, fps = currentTemplate()?.fps || 30) {
    const centiseconds = Math.floor(frame / fps * 100);
    return `${String(Math.floor(centiseconds / 6000)).padStart(2, '0')}:${String(Math.floor(centiseconds / 100) % 60).padStart(2, '0')}.${String(centiseconds % 100).padStart(2, '0')}`;
  }

  function confirmDiscard() {
    return !state.dirty || window.confirm('当前修改还没有保存。确定离开这份工程吗？未保存的修改将被丢弃。');
  }
  async function selectTemplate(id) {
    if (!confirmDiscard()) return;
    stopPolling();
    state.project = null;
    state.templateId = id;
    history.replaceState(null, '', resource('/?new=1&template=' + encodeURIComponent(id)));
    state.dirty = false;
    state.rendering = false;
    state.job = null;
    workflow.render();
    $('render-panel').hidden = true;
    renderTemplates();
    renderProjectSelect();
    renderInspector();
    refreshPreview();
  }

  function openNewProjectDialog() {
    if (!state.templates.length) return;
    $('new-project-template').value = state.templateId || state.templates[0].id;
    $('new-project-name').value = '';
    production.renderSources();
    $('new-project-dialog').showModal();
    $('new-project-name').focus();
  }
  async function createProject(event) {
    event.preventDefault();
    if (state.creating || !confirmDiscard()) return;
    const name = $('new-project-name').value.trim();
    if (!name) return $('new-project-name').focus();
    state.creating = true;
    $('create-project-submit').disabled = true;
    try {
      const { project } = await api('/api/projects', { method: 'POST', body: JSON.stringify({ name, templateId: $('new-project-template').value, format: $('new-project-format').value, sourceId: $('new-project-source').value || undefined }) });
      state.projects.unshift(project);
      $('new-project-dialog').close();
      setProject(project);
      toast('工程已创建，填写要求后即可让 AI 制作');
    } finally {
      state.creating = false;
      $('create-project-submit').disabled = false;
    }
  }

  function setProject(project) {
    stopPolling();
    state.project = structuredClone(project);
    state.templateId = project.templateId;
    state.dirty = false;
    state.rendering = false;
    state.job = null;
    $('render-panel').hidden = true;
    localStorage.setItem(storageKey, project.id);
    history.replaceState(null, '', resource('/?project=' + project.id));
    renderTemplates();
    renderProjectSelect();
    renderInspector();
    workspace.entered();
    refreshPreview();
    const latestJob = state.jobs.filter((j) => j.projectId === project.id).sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))[0];
    if (latestJob && latestJob.revision===project.revision) {
      displayJob(latestJob);
      if(['queued', 'rendering'].includes(latestJob.status || latestJob.state)) pollJob(latestJob.id);
    }
  }

  async function openProject(id) {
    if (!id) return selectTemplate(state.templateId || state.templates[0]?.id);
    if (!confirmDiscard()) { $('project-select').value = state.project?.id || ''; return; }
    const { project } = await api(`/api/projects/${encodeURIComponent(id)}`);
    setProject(project);
  }

  async function saveProject({ quiet = false } = {}) {
    if (!state.project || state.saving) return null;
    state.saving = true;
    updateStatus();
    const p = state.project;
    const snapshot = structuredClone({ expectedRevision: p.revision, name: p.name.trim(), fields: p.fields, slots: p.slots, audio: p.audio, settings: p.settings, locks: p.locks, brief: p.brief });
    const signature = JSON.stringify(snapshot);
    try {
      const { project } = await api(`/api/projects/${encodeURIComponent(p.id)}`, { method: 'PUT', body: signature });
      if (state.project?.id !== p.id) return project;
      const currentSignature = JSON.stringify({ expectedRevision: p.revision, name: p.name.trim(), fields: p.fields, slots: p.slots, audio: p.audio, settings: p.settings, locks: p.locks, brief: p.brief });
      const changedWhileSaving = currentSignature !== signature;
      if (changedWhileSaving) {
        p.revision = project.revision;
        p.updatedAt = project.updatedAt;
        state.dirty = true;
      } else {
        state.project = structuredClone(project);
        state.dirty = false;
      }
      const index = state.projects.findIndex((item) => item.id === project.id);
      if (index < 0) state.projects.unshift(project); else state.projects[index] = project;
      renderProjectSelect();
      refreshPreview();
      if (!changedWhileSaving) production.saved(project);
      if (!quiet) toast(changedWhileSaving ? '已保存，期间新增的修改仍待保存' : '工程已保存，预览已更新');
      return project;
    } finally {
      state.saving = false;
      updateStatus();
    }
  }

  async function importFiles(files) {
    if (state.importing || !files?.length) return;
    setTab('assets');
    state.importing = true;
    const items = [...files];
    const failures = [];
    let imported = 0;
    $('import-status').hidden = false;
    $('drop-zone').classList.add('is-loading');
    try {
      for (let index = 0; index < items.length; index += 1) {
        const file = items[index];
        $('import-status').textContent = `正在本地导入并准备预览素材 ${index + 1} / ${items.length}：${file.name}`;
        try {
          const { asset } = await api('/api/assets', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'x-file-name': encodeURIComponent(file.name) }, body: file });
          const existing = state.assets.findIndex((a) => a.id === asset.id);
          if (existing >= 0) state.assets[existing] = asset; else state.assets.unshift(asset);
          addCandidateAsset(asset);
          imported += 1;
          renderAssets();
        } catch (error) { failures.push(`${file.name}：${error.message}`); }
      }
      if (state.project) { renderSlots(); renderAudio(); updateStatus(); }
      $('import-status').textContent = failures.length ? `成功导入 ${imported} 个，${failures.length} 个未导入。` : `已导入 ${imported} 个素材，可以在右侧选择使用。`;
      if (failures.length) showError(new Error(failures.join('；')));
      else toast(`已导入 ${imported} 个素材`);
    } finally {
      state.importing = false;
      $('drop-zone').classList.remove('is-loading');
      $('file-input').value = '';
    }
  }

  function displayJob(job) {
    state.job = job;
    const status = job.status || job.state;
    state.rendering = ['queued', 'rendering'].includes(status);
    const panel = $('render-panel');
    panel.hidden = false;
    panel.classList.toggle('failed', status === 'failed');
    panel.classList.toggle('completed', status === 'succeeded');
    const percentage = Math.round(clamp(finite(job.progress), 0, 1) * 100);
    $('render-percentage').textContent = status === 'succeeded' ? '100%' : ['failed','cancelled'].includes(status) ? '未完成' : `${percentage}%`;
    $('render-progress').style.width = `${status === 'succeeded' ? 100 : percentage}%`;
    $('render-title').textContent = status === 'succeeded' ? `修订 ${job.revision} · 导出完成` : ['failed','cancelled'].includes(status) ? `修订 ${job.revision} · ${status==='cancelled'?'导出已取消':'导出失败'}` : `正在导出修订 ${job.revision}`;
    $('render-message').textContent = status === 'failed' ? job.error || job.message || '请检查素材与本机渲染服务后重试。' : status === 'succeeded' ? '成片已保存在本机。请下载后检查画面、文字与声音。' : job.message || '正在本机生成视频，完成后可下载成片。';
    const download = localUrl(job.downloadUrl);
    $('download-button').hidden = status !== 'succeeded' || !download;
    $('receive-library-button').hidden = true;
    if (status === 'succeeded' && download) $('download-button').href = download;
    else $('download-button').removeAttribute('href');
    $('render-cancel').hidden = !state.rendering;
    $('render-retry').hidden = !['failed', 'cancelled'].includes(status);
    updateStatus();
  }
  function stopPolling() { clearTimeout(state.pollTimer); state.pollTimer = null; state.pollEpoch += 1; }
  async function pollJob(id) {
    clearTimeout(state.pollTimer);
    state.pollTimer = null;
    const epoch = state.pollEpoch;
    try {
      const { job } = await api(`/api/jobs/${encodeURIComponent(id)}`);
      if (epoch !== state.pollEpoch || state.job && state.job.id !== id) return;
      displayJob(job);
      const index = state.jobs.findIndex((j) => j.id === id);
      if (index >= 0) state.jobs[index] = job; else state.jobs.push(job);
      if (['queued', 'rendering'].includes(job.status || job.state)) state.pollTimer = setTimeout(() => pollJob(id), 1000);
    } catch (error) {
      if (epoch !== state.pollEpoch) return;
      showError(new Error(`导出状态暂时无法读取：${error.message}。工程已保存，可重开后确认结果。`));
      state.pollTimer = setTimeout(() => pollJob(id), 4000);
    }
  }
  async function renderProject() {
    if (state.rendering || !state.project) return;
    if (state.workflowBusy) return;
    const { problems } = validation();
    if (problems.length) throw new Error(problems.join('；'));
    if (state.dirty) await saveProject({ quiet: true });
    if (state.dirty) throw new Error('保存期间工程又发生了修改，请完成保存后再导出。');
    state.rendering = true;
    updateStatus();
    $('download-button').hidden = true;
    $('download-button').removeAttribute('href');
    try {
      const { job } = await api(`/api/projects/${encodeURIComponent(state.project.id)}/render`, { method: 'POST', body: JSON.stringify({ expectedRevision: state.project.revision }) });
      displayJob(job);
      state.jobs.push(job);
      pollJob(job.id);
    } catch (error) {
      state.rendering = false;
      updateStatus();
      throw error;
    }
  }

  function addCandidateAsset(asset) {
    if (!state.project || asset.type === 'audio') return;
    state.project.brief ||= { request: '', facts: '', subject: '', assetIds: [] };
    if (!state.project.brief.assetIds.includes(asset.id)) {
      state.project.brief.assetIds.push(asset.id);
      markDirty();
    }
  }

  async function importLibraryIds(ids) {
    if (libraryBusy || !ids.length) return;
    const projectId = state.project?.id;
    const targetSlot = librarySlot;
    libraryBusy = true;
    $('library-import-selected').disabled = true;
    try {
      for (let index = 0; index < ids.length; index += 1) {
        $('library-status').textContent = `正在导入 ${index + 1} / ${ids.length}`;
        const { asset } = await api('/api/library-assets/import', { method: 'POST', body: JSON.stringify({ id: ids[index] }) });
        const previous = state.assets.findIndex(item => item.id === asset.id);
        if (previous >= 0) state.assets[previous] = asset; else state.assets.unshift(asset);
        if (state.project?.id === projectId) {
          addCandidateAsset(asset);
          if (targetSlot) {
            const slot = state.project.slots.find(item => item.id === targetSlot);
            if (slot) {
              Object.assign(slot, { assetId: asset.id, inPoint: 0, focusX: .5, focusY: .5 });
              workflow.lock('slots', slot.id); markDirty();
            }
          }
        }
      }
      $('library-dialog').close();
      toast(`已导入 ${ids.length} 个素材`);
    } catch (error) {
      $('library-status').textContent = error.message;
      throw error;
    } finally {
      libraryBusy = false;
      $('library-import-selected').disabled = false;
      renderAssets(); renderInspector();
    }
  }

  async function openSystemLibrary(slotId = null) {
    librarySlot = slotId;
    $('library-dialog').showModal();
    $('library-status').textContent = '正在读取素材…';
    $('system-library-list').replaceChildren();
    $('library-batch-actions').hidden = !!slotId;
    const { items } = await api('/api/library-assets');
    $('library-status').textContent = items.length ? slotId ? '选择一个素材替换此画面。' : '可一次选择多个素材，加入当前工程的 AI 候选范围。' : '系统素材库中暂无可用素材，可先导入本地文件。';
    $('system-library-list').innerHTML = items.map(item => {
      const information = `${escape(typeNames[item.mediaType])} · ${item.width || '—'} × ${item.height || '—'}${item.durationSeconds ? ` · ${secondsLabel(item.durationSeconds)}` : ''}`;
      return slotId
        ? `<button type="button" class="system-library-item" data-library-id="${escape(item.id)}"><strong>${escape(item.title)}</strong><small>${information}</small></button>`
        : `<label class="candidate-row"><input type="checkbox" value="${escape(item.id)}"><span><strong>${escape(item.title)}</strong><small>${information}</small></span></label>`;
    }).join('');
    $('system-library-list').querySelectorAll('[data-library-id]').forEach(button => button.addEventListener('click', run(() => importLibraryIds([button.dataset.libraryId]))));
  }
  async function receiveCurrentOutput(){
    if(!state.job || state.job.status!=='succeeded')return;
    const button=$('receive-library-button');button.disabled=true;
    try{await api(`/api/jobs/${encodeURIComponent(state.job.id)}/library`,{method:'POST',body:'{}'});toast('已加入成片库，等待确认入库');}finally{button.disabled=false;}
  }

  function bindEvents() {
    $('library-import-button').addEventListener('click',run(()=>openSystemLibrary()));
    $('library-select-all').addEventListener('click', () => $('system-library-list').querySelectorAll('input').forEach(input => { input.checked = true; }));
    $('library-import-selected').addEventListener('click', run(() => importLibraryIds([...$('system-library-list').querySelectorAll('input:checked')].map(input => input.value))));
    $('close-library-dialog').addEventListener('click',()=>{if(!libraryBusy)$('library-dialog').close();});
    $('receive-library-button').addEventListener('click',run(receiveCurrentOutput));
    const previewStage = document.querySelector('.preview-stage');
    new ResizeObserver(resizePreview).observe(previewStage);
    window.addEventListener('resize', resizePreview);
    $('templates-tab').addEventListener('click', () => setTab('templates'));
    $('assets-tab').addEventListener('click', () => setTab('assets'));
    $('dismiss-error').addEventListener('click', () => { $('global-error').hidden = true; });
    $('asset-filter').addEventListener('change', renderAssets);
    $('new-project-button').addEventListener('click', openNewProjectDialog);
    $('use-template-button').addEventListener('click', openNewProjectDialog);
    $('close-dialog').addEventListener('click', () => $('new-project-dialog').close());
    $('cancel-dialog').addEventListener('click', () => $('new-project-dialog').close());
    $('new-project-form').addEventListener('submit', run(createProject));
    $('project-select').addEventListener('change', run((event) => openProject(event.target.value)));
    $('save-button').addEventListener('click', run(() => saveProject()));
    $('save-bottom-button').addEventListener('click', run(() => saveProject()));
    $('render-button').addEventListener('click', run(renderProject));
    $('editor-form').addEventListener('submit', (event) => event.preventDefault());
    $('project-name').addEventListener('input', () => { if (state.project) { state.project.name = $('project-name').value; markDirty(); } });
    ['title', 'subtitle', 'brand', 'accent'].forEach((key) => $(`field-${key}`).addEventListener('input', () => {
      if (!state.project) return;
      state.project.fields[key] = $(`field-${key}`).value;
      workflow.lock('fields', key);
      if (key === 'accent') $('accent-value').textContent = $(`field-${key}`).value;
      markDirty();
    }));
    ['beat1','beat2','beat3'].forEach(key => $(`field-${key}`).addEventListener('input', () => { if(state.project){state.project.fields[key]=$(`field-${key}`).value;workflow.lock('fields',key);markDirty();} }));
    ['titles','brand','colorCards'].forEach(key => $(`setting-${key}`).addEventListener('change', () => { if(state.project){state.project.settings[key]=$(`setting-${key}`).checked;if(key!=='colorCards')workflow.lock('settings',key);markDirty();} }));
    $('setting-intensity').addEventListener('input',()=>{if(state.project){state.project.settings.intensity=Number($('setting-intensity').value);$('intensity-value').textContent=`${Math.round(state.project.settings.intensity*100)}%`;workflow.lock('settings','intensity');markDirty();}});
    $('audio-select').addEventListener('change', () => {
      if (!state.project) return;
      const value = $('audio-select').value;
      state.project.audio.assetId = value.startsWith('asset:') ? value.slice(6) : null;
      state.project.audio.trackId = value.startsWith('builtin:') ? value.slice(8) : 'template';
      state.project.audio.inPoint = 0;
      workflow.lock('audio'); renderAudio(); markDirty();
    });

    for (const [id,key] of [['music-enabled','musicEnabled'],['sfx-enabled','sfxEnabled']]) $(id).addEventListener('change',()=>{if(state.project){state.project.audio[key]=$(id).checked;workflow.lock('audio');markDirty();}});
    for (const [id,key] of [['sfx-volume','sfxVolume'],['audio-inpoint','inPoint'],['audio-fadeout','fadeOut']]) $(id).addEventListener('input',()=>{if(state.project){state.project.audio[key]=Number($(id).value);if(id==='sfx-volume')$('sfx-volume-value').textContent=`${Math.round(state.project.audio[key]*100)}%`;workflow.lock('audio');markDirty();}});
    $('audio-volume').addEventListener('input', () => {
      if (!state.project) return;
      state.project.audio.volume = Number($('audio-volume').value);
      workflow.lock('audio');
      $('audio-volume-value').textContent = `${Math.round(state.project.audio.volume * 100)}%`;
      markDirty();
    });
    $('drop-zone').addEventListener('click', () => { if (!state.importing) $('file-input').click(); });
    $('drop-zone').addEventListener('keydown', (event) => { if (['Enter', ' '].includes(event.key) && !state.importing) { event.preventDefault(); $('file-input').click(); } });
    $('file-input').addEventListener('change', run((event) => importFiles(event.target.files)));
    ['dragenter', 'dragover'].forEach((name) => $('drop-zone').addEventListener(name, (event) => { event.preventDefault(); $('drop-zone').classList.add('dragover'); }));
    ['dragleave', 'drop'].forEach((name) => $('drop-zone').addEventListener(name, (event) => { event.preventDefault(); $('drop-zone').classList.remove('dragover'); }));
    $('drop-zone').addEventListener('drop', run((event) => importFiles(event.dataTransfer.files)));
    $('play-button').addEventListener('click', () => {
      state.playing = !state.playing;
      sendPreview(state.playing ? 'play' : 'pause');
      $('play-button').textContent = state.playing ? 'Ⅱ' : '▶';
      $('play-button').setAttribute('aria-label', state.playing ? '暂停预览' : '播放预览');
    });
    $('restart-button').addEventListener('click', () => { resetPlayer(); sendPreview('pause'); sendPreview('seek', { frame: 0 }); });
    $('timeline').addEventListener('input', () => {
      state.frame = Number($('timeline').value);
      state.playing = false;
      $('play-button').textContent = '▶';
      sendPreview('pause');
      sendPreview('seek', { frame: state.frame });
      $('time-current').textContent = formatTime(state.frame);
    });
    window.addEventListener('message', (event) => {
      if (event.origin !== location.origin || event.source !== $('preview-frame').contentWindow || event.data?.type !== 'workbench:time') return;
      const frame = clamp(finite(event.data.frame), 0, (currentTemplate()?.durationFrames || 450) - 1);
      state.frame = frame;
      state.playing = !!event.data.playing;
      $('timeline').value = frame;
      $('time-current').textContent = formatTime(frame);
      $('play-button').textContent = state.playing ? 'Ⅱ' : '▶';
      $('play-button').setAttribute('aria-label', state.playing ? '暂停预览' : '播放预览');
    });
    window.addEventListener('beforeunload', (event) => { if (state.dirty) { event.preventDefault(); event.returnValue = ''; } });
    window.addEventListener('keydown', (event) => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') { event.preventDefault(); if (state.project && !state.saving) run(() => saveProject())(); } });
  }

  async function bootstrap() {
    bindEvents();
    const data = await api('/api/bootstrap');
    state.sessionToken = data.sessionToken;
    state.templates = (data.templates || []).filter(t => !t.hidden);
    state.templateCatalog = data.templateCatalog || state.templates;
    state.musicTracks = data.musicTracks || [];
    state.assets = data.assets || [];
    state.sourceFolders = data.sourceFolders || [];
    production.renderSources();
    state.projects = data.projects || [];
    state.jobs = data.jobs || [];
    workflow.status();
    const query = new URLSearchParams(location.search);
    state.templateId = state.templates.find(t => t.id === query.get('template'))?.id || state.templates[0]?.id || null;
    renderTemplates();
    renderAssets();
    renderProjectSelect();
    renderInspector();
    const lastId = query.get('new') === '1' || query.get('home') === '1' ? null : query.get('project');
    if (lastId && state.projects.some((p) => p.id === lastId)) {
      try { const { project } = await api(`/api/projects/${encodeURIComponent(lastId)}`); setProject(project); }
      catch (error) { showError(error); refreshPreview(); }
    } else { refreshPreview(); workspace.home(); }
    updateStatus();
  }

  bootstrap().catch((error) => { $('save-status').textContent = '连接未完成'; showError(error); });
})();
