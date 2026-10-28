(() => {
  'use strict';
  const deploymentBase = location.pathname.replace(/\/index\.html$/, '').replace(/\/$/, '');
  const API_BASE = window.__VIDEO_STUDIO_API_BASE__ ?? deploymentBase;
  const pickerMode = new URLSearchParams(location.search).get('picker') === '1';
  const $ = (id) => document.getElementById(id);
  const icon = (name, cls = '') => `<i data-lucide="${name}"${cls ? ` class="${cls}"` : ''}></i>`;
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (x) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[x]));
  const state = { videos: [], skills: [], tools: [], collections: [], sessions: [], selectedSkill: null, selectedAssets: [], assetKind: 'content', collectionId: null, folder: '', entries: [], categories: [], categoryCounts: {}, slogans: [], session: null, sessionEpoch: 0, loadingSession: false, running: false, stream: null, poll: null, tab: 'library', mediaRequest: 0, previewAsset: null, previewVideo: null, online: false, automaticUrl: '/automatic/', seenEvents: new Map(), lastEvents: new Map() };
  const defaultCategories = ['讲师讲解','听众反应','实操教学','交流互动','场地环境','团队合影','颁证仪式','课程信息','品牌资产','虚拟形象','音乐音效','待分类'];
  const styleNames = ['纪录混剪｜证据与现场','预告片｜由静到燃','品牌开场｜分享的价值','社交短片｜三眼看现场','节拍混剪｜现场脉动','对照蒙太奇｜台上与台下'];
  const styleDescriptions = ['现场与事实，组织一条清晰的叙事','铺垫、转折与节奏推进','以主题与价值建立第一印象','短节奏、多视角与局部说明','围绕音乐节拍组织镜头','在讲授与实践之间形成呼应'];
  let toastTimer;
  const renderIcons = () => window.lucide?.createIcons();
  function toast(text) { $('toast').textContent = text; $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').hidden = true, 3200); }
  function errorIn(id, text) { $(id).textContent = text || ''; $(id).hidden = !text; }
  function seconds(value) { const s = Math.floor(Number(value) || 0); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; }
  function localUrl(value) { if (!value || /^(https?:|data:|blob:)/.test(value)) return value || ''; if (API_BASE && value.startsWith('/') && !value.startsWith(`${API_BASE}/`)) return API_BASE + value; return value; }
  function bundledPath(value) { if (!value) return ''; if (/^(https?:|\/|data:)/.test(value)) return localUrl(value); return `${API_BASE}/bundled/${value.replace(/^bundled\//, '')}`; }
  function fileSize(value) { const n = Number(value); if (!n) return ''; return n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.ceil(n / 1024)} KB`; }
  function empty(iconName, title, description = '') { return `<div class="empty-state">${icon(iconName)}<strong>${esc(title)}</strong>${description ? `<p>${esc(description)}</p>` : ''}</div>`; }
  async function api(path, options = {}) {
    const res = await fetch(`${API_BASE}${path}`, { ...options, headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers } });
    if (res.status === 401) window.parent.postMessage({ type: 'content-workbench:unauthorized' }, location.origin);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(typeof data.error === 'string' ? data.error : data.error?.message || data.message || `请求失败（${res.status}）`);
    return data;
  }
  function normalizeSkill(skill, i) { return { ...skill, id: skill.id || skill.name || `chatcut-source-pack-${String(i + 1).padStart(2, '0')}`, title: skill.title || styleNames[i] || skill.name, description: skill.description || styleDescriptions[i] }; }
  async function bootstrapPicker() {
    $('createFromLibrary').disabled = true;
    try {
      // Publishing uses the shared library's stable IDs and authenticated media URLs.
      const res = await fetch('/api/content-library', { cache: 'no-store', credentials: 'same-origin', signal: AbortSignal.timeout(20000) });
      if (res.status === 401) window.parent.postMessage({ type: 'content-workbench:unauthorized' }, location.origin);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error?.message || data.message || (res.status === 401 ? '登录已失效，请重新登录。' : '暂时无法读取共享成片库。'));
      if (!Array.isArray(data.items)) throw new Error('成片库返回了无法识别的数据。');
      state.videos = data.items.filter((item) => /^[a-f0-9]{32}$/.test(item?.id) && ['video', 'image'].includes(item.mediaType)).map((item) => ({
        ...item, libraryItem: true, title: item.title || '未命名作品',
        mediaUrl: `/api/content-library/${item.id}/media`,
        styleLabel: { automatic: '自动热点', editing: '混剪', creation: 'AIGC 创作' }[item.source] || '已收录作品',
        createdLabel: item.mediaType === 'image' ? '图片素材' : '视频成片',
      }));
      renderVideos();
    } catch (err) {
      if (!state.videos.length) $('videoGrid').innerHTML = empty('unplug', '暂时无法读取成片库', err.message);
      else toast(err.message);
      renderIcons();
    } finally { $('createFromLibrary').disabled = false; }
  }
  function publishSelection(id) {
    const item = state.videos.find((video) => video.id === id && video.libraryItem);
    if (!item) return;
    if ($('videoDialog').open) $('videoDialog').close();
    window.parent.postMessage({ type: 'content-library:publish', id: item.id }, location.origin);
    toast(window.parent === window ? '请从主应用的发布页面选择作品。' : '已选择作品，正在带入发布。');
  }
  async function bootstrap() {
    if (pickerMode) return bootstrapPicker();
    try {
      const data = await api('/api/studio/bootstrap');
      state.videos = data.videos || data.manifest?.videos || [];
      state.skills = (data.skills || []).map(normalizeSkill);
      state.tools = Array.isArray(data.tools) ? data.tools : Object.entries(data.tools || {}).map(([id, value]) => typeof value === 'object' ? { id, ...value } : { id, status: value });
      state.collections = data.collections || [];
      state.slogans = data.slogans || [];
      state.sessions = data.sessions || [];
      state.automaticUrl = data.automaticUrl || `${API_BASE}/automatic/`;
      if (!state.selectedSkill || !state.skills.some((s) => s.id === state.selectedSkill)) state.selectedSkill = state.skills[0]?.id || null;
      state.online = true;
      $('connectionDot').className = 'connection-dot online';
      $('connectionLabel').textContent = '服务在线';
      renderVideos(); renderSkills(); renderTools(); renderSessions(); renderCollections();
      if (state.tab === 'assets') await loadMedia();
    } catch (err) {
      state.online = false;
      $('connectionDot').className = 'connection-dot error';
      $('connectionLabel').textContent = '连接中断';
      if (!state.videos.length) $('videoGrid').innerHTML = empty('unplug', '工作台暂时无法连接', err.message);
      if (!state.skills.length) $('skillList').innerHTML = '<div class="folder-placeholder">工作流暂不可用</div>';
      renderIcons();
    }
  }
  function route() {
    let hash = location.hash.replace(/^#\/?/, '');
    if (pickerMode) hash = 'mix/library';
    if (!hash || ['overview', 'editing', 'creation'].includes(hash)) hash = 'mix/library';
    if (hash === 'automatic' || hash === 'automatic/') {
      $('mixWorkspace').hidden = true; $('automaticWorkspace').hidden = false;
      $('breadcrumbMethod').textContent = '自动热点';
      $('automaticLink').href = state.automaticUrl;
      if (!$('automaticFrame').src) $('automaticFrame').src = state.automaticUrl;
      document.title = '自动热点 · 内容生成工作台';
    } else {
      $('mixWorkspace').hidden = false; $('automaticWorkspace').hidden = true;
      $('breadcrumbMethod').textContent = '混剪';
      state.tab = ['library','create','assets'].includes(hash.split('/')[1]) ? hash.split('/')[1] : 'library';
      document.querySelectorAll('[data-tab]').forEach((el) => { const selected = el.dataset.tab === state.tab; el.setAttribute('aria-selected', selected); el.tabIndex = selected ? 0 : -1; $('panel-' + el.dataset.tab).hidden = !selected; });
      $('headingActions').hidden = state.tab === 'create';
      document.title = `${{ library: '成片库', create: '视频制作', assets: '素材库' }[state.tab]} · 混剪工作台`;
      if (pickerMode) document.title = '从共享成片库选择';
      if (state.tab === 'assets') { renderCollections(); loadMedia(); }
      if (state.tab === 'create') { renderMessages(); renderSelectedAssets(); }
    }
    document.querySelectorAll('[data-method]').forEach((el) => el.classList.toggle('active', el.dataset.method === (hash.startsWith('automatic') ? 'automatic' : 'mix')));
    renderIcons();
  }
  function renderVideos() {
    const query = $('videoSearch').value.trim().toLowerCase();
    const videos = state.videos.filter((v) => `${v.title} ${v.styleId} ${v.sourceSkill} ${v.description || ''}`.toLowerCase().includes(query));
    $('videoCount').textContent = state.videos.length;
    $('librarySummary').textContent = `${state.videos.length} 条作品`;
    $('videoGrid').innerHTML = videos.length ? videos.map((v, i) => {
      const preview = v.libraryItem ? (v.mediaType === 'image'
        ? `<img src="${esc(v.mediaUrl)}" alt="${esc(v.title)}画面" loading="lazy">`
        : `<video src="${esc(v.mediaUrl)}" preload="metadata" muted playsinline aria-hidden="true"></video>`)
        : `<img src="${esc(bundledPath(v.posterPath || v.posterUrl))}" alt="${esc(v.title)}画面" loading="lazy">`;
      return `<article class="video-card"><button class="video-cover" data-play-video="${esc(v.id)}" aria-label="预览${esc(v.title)}">${preview}<span class="style-chip">${esc(v.styleLabel || v.style || ['纪录混剪','预告片','品牌开场','社交短片','节拍混剪','对照蒙太奇'][i] || '作品')}</span><span class="play-button"><span>${icon(v.mediaType === 'image' ? 'expand' : 'play')}</span></span>${!v.libraryItem || v.durationSeconds || v.duration ? `<span class="duration-chip">${seconds(v.durationSeconds || v.duration)}</span>` : ''}</button><div class="video-info"><h3>${esc(v.title)}</h3><div class="video-subtitle"><span class="video-meta">${icon('layers-2')}${esc(v.width && v.height ? `${v.width} × ${v.height}` : v.mediaType === 'image' ? '图片素材' : '视频成片')}</span><span>${esc(v.createdLabel || '工作流样片')}</span></div></div><div class="video-card-footer">${pickerMode ? `<button class="text-button" data-publish-video="${esc(v.id)}">${icon('check')}选择用于发布</button>` : `<button class="text-button" data-style-video="${esc(v.id)}">${icon('wand-sparkles')}使用此工作流</button>`}<a class="icon-button" href="${esc(v.libraryItem ? v.mediaUrl : bundledPath(v.videoPath || v.url))}" download title="下载${esc(v.title)}" aria-label="下载${esc(v.title)}">${icon('download')}</a></div></article>`;
    }).join('') : empty('search', query ? '没有找到匹配的成片' : '暂无成片', pickerMode ? '先在内容生成工作台完成导出，再刷新成片库。' : '');
    renderIcons();
  }
  function openVideo(id) {
    const video = state.videos.find((v) => v.id === id); if (!video) return;
    state.previewVideo = video;
    $('videoDialogTitle').textContent = video.title;
    $('videoDialogMeta').textContent = video.libraryItem ? (video.mediaType === 'image' ? '图片素材' : '视频成片') : `${seconds(video.durationSeconds || video.duration)} · ${video.width} × ${video.height}`;
    const isImage = video.mediaType === 'image';
    $('videoPlayer').hidden = isImage;
    $('pickerImagePreview').hidden = !isImage;
    if (isImage) { $('pickerImagePreview').src = video.mediaUrl; $('pickerImagePreview').alt = video.title; }
    else $('videoPlayer').src = video.libraryItem ? video.mediaUrl : bundledPath(video.videoPath || video.url);
    $('videoPlayer').poster = bundledPath(video.posterPath || video.posterUrl);
    $('downloadVideo').href = video.libraryItem ? video.mediaUrl : bundledPath(video.videoPath || video.url);
    $('downloadVideo').download = (video.videoPath || '').split('/').pop() || `${video.title}.${isImage ? 'png' : 'mp4'}`;
    $('videoDialog').showModal();
    if (!isImage) $('videoPlayer').play().catch(() => {});
  }
  function skillForVideo(v) { return state.skills.find((s) => s.id === v.sourceSkill || s.id === v.styleId || s.name === v.sourceSkill) || state.skills.find((s) => String(s.id).endsWith(String(v.styleId || '').match(/\d+$/)?.[0] || '---')); }
  function useVideoStyle(id) {
    const video = state.videos.find((v) => v.id === id); if (!video) return;
    const skill = skillForVideo(video); if (skill) state.selectedSkill = skill.id;
    renderSkills();
    if ($('videoDialog').open) $('videoDialog').close();
    location.hash = 'mix/create';
    $('chatInput').focus();
  }
  function renderSkills() {
    $('skillList').innerHTML = state.skills.map((s, i) => `<button class="skill-option${s.id === state.selectedSkill ? ' selected' : ''}" data-skill="${esc(s.id)}" aria-pressed="${s.id === state.selectedSkill}" title="${esc(s.description)}"><span class="skill-number">${String(i + 1).padStart(2, '0')}</span><span><strong>${esc(s.title)}</strong><small>${esc(styleDescriptions[i] || s.description)}</small></span>${s.id === state.selectedSkill ? icon('check', 'check-icon') : ''}</button>`).join('');
    const chosen = state.skills.find((s) => s.id === state.selectedSkill);
    $('selectedSkillLabel').textContent = chosen?.title || '未选择工作流';
    renderIcons();
  }
  function renderTools() {
    const tools = state.tools.length ? state.tools : [{id:'codex',name:'Codex CLI',status:'unknown'},{id:'chatcut',name:'ChatCut',status:'unknown'},{id:'remotion',name:'Remotion',status:'unknown'},{id:'hyperframe',name:'Hyperframe',status:'unknown'}];
    $('toolList').innerHTML = tools.map((tool) => {
      const status = String(tool.status || (tool.ready ? 'ready' : 'unknown'));
      const ready = ['ready','connected','available','installed','configured','online'].includes(status);
      const label = tool.statusLabel || ({ready:'已就绪',connected:'已连接',available:'可用',installed:'已安装',configured:'已配置',online:'在线',auth_required:'待授权',needs_authorization:'待授权',skill_ready:'Skill 已装',unavailable:'不可用',missing:'未安装',error:'连接异常',unknown:'待检查'}[status] || status);
      return `<div class="tool-row" title="${esc(tool.detail || tool.message || '')}"><span class="tool-name">${icon(tool.id === 'codex' ? 'terminal' : tool.id === 'chatcut' ? 'scissors' : 'puzzle')}${esc(tool.name || tool.title || tool.id)}</span><span class="tool-status ${ready ? 'ready' : 'warning'}">${esc(label)}</span></div>`;
    }).join('');
    const codex = tools.find((t) => t.id === 'codex');
    $('chatSubtitle').textContent = codex?.model || codex?.version || 'Codex';
    renderIcons();
  }
  function sessionId(session) { return session?.id || session?.sessionId; }
  function renderSessions() {
    const current = sessionId(state.session) || '';
    $('sessionSelect').innerHTML = '<option value="">新会话</option>' + state.sessions.map((s) => `<option value="${esc(sessionId(s))}">${esc(s.title || s.name || '未命名会话')}</option>`).join('');
    $('sessionSelect').value = current;
  }
  function messagesOf(session) { return session?.messages || session?.conversation || []; }
  function renderMessages() {
    const messages = messagesOf(state.session);
    if (!messages.length) {
      $('chatMessages').innerHTML = `<div class="chat-empty"><span class="empty-symbol">${icon('clapperboard')}</span><h2>开始一条新作品</h2><p>主题、素材和创作想法</p><div class="prompt-suggestions"><button data-prompt="用已选的课堂素材制作一条 15 秒宣传片，重点展示从讲解到上手实践，音乐为主，不要配音。">15 秒课程宣传</button><button data-prompt="先查看已选素材，给出选片建议和分镜草案，暂不生成或导出。">先做分镜草案</button></div></div>`;
    } else {
      $('chatMessages').innerHTML = messages.filter((m) => m.role !== 'system').map((m) => {
        const role = m.role === 'user' ? 'user' : 'assistant';
        let content = m.content ?? m.text ?? '';
        if (Array.isArray(content)) content = content.map((c) => c.text || '').join('\n');
        return `<article class="chat-message ${role}"><span class="message-avatar">${icon(role === 'user' ? 'user-round' : 'sparkles')}</span><div class="message-content"><div class="message-role">${role === 'user' ? '你' : '制作助手'}${m.status && !['completed','complete'].includes(m.status) ? `<span class="message-status">${esc({running:'制作中',error:'未完成',cancelled:'已停止',failed:'未完成'}[m.status] || m.status)}</span>` : ''}</div><div class="message-body">${esc(content)}</div>${m.tools?.length ? `<div class="message-tools">${esc(m.tools.join(' · '))}</div>` : ''}</div></article>`;
      }).join('');
    }
    renderIcons();
    $('chatMessages').scrollTop = $('chatMessages').scrollHeight;
    setRunning(Boolean(state.session?.running || state.session?.status === 'running'));
  }
  function setRunning(value) { state.running = value; $('sendMessage').hidden = value; $('stopGeneration').hidden = !value; $('runStatus').hidden = !value; if (value && !$('runStatus').textContent) $('runStatus').textContent = '正在处理…'; }
  async function refreshSession() {
    const requestedId = sessionId(state.session), epoch = state.sessionEpoch;
    if (!requestedId) return;
    const data = await api(`/api/chat/sessions/${encodeURIComponent(requestedId)}`);
    if (epoch !== state.sessionEpoch || requestedId !== sessionId(state.session)) return;
    state.session = data.session || data;
    renderMessages();
    if (!state.running && state.poll) { clearInterval(state.poll); state.poll = null; }
  }
  async function loadSession(id) {
    const epoch = ++state.sessionEpoch;
    closeStream(); errorIn('chatError', '');
    state.session = null; state.loadingSession = Boolean(id); setRunning(false);
    if (!id) { $('sendMessage').disabled = false; renderMessages(); renderSessions(); return; }
    $('sendMessage').disabled = true;
    $('chatMessages').innerHTML = empty('loader-circle', '正在读取会话…'); renderIcons();
    try {
      const data = await api(`/api/chat/sessions/${encodeURIComponent(id)}`);
      if (epoch !== state.sessionEpoch) return;
      state.session = data.session || data; renderMessages(); renderSessions(); connectStream();
    } catch (err) { if (epoch === state.sessionEpoch) errorIn('chatError', err.message); }
    finally { if (epoch === state.sessionEpoch) { state.loadingSession = false; $('sendMessage').disabled = false; } }
  }
  function closeStream() { state.stream?.close(); state.stream = null; if (state.poll) clearInterval(state.poll); state.poll = null; }
  function connectStream() {
    closeStream(); const id = sessionId(state.session), epoch = state.sessionEpoch; if (!id) return;
    const after = state.lastEvents.get(id);
    const stream = new EventSource(`${API_BASE}/api/chat/sessions/${encodeURIComponent(id)}/events${after ? `?after=${encodeURIComponent(after)}` : ''}`);
    state.stream = stream;
    const handler = (event) => {
      if (epoch !== state.sessionEpoch || id !== sessionId(state.session)) return;
      let data; try { data = JSON.parse(event.data); } catch { return; }
      const eventId = data.id || event.lastEventId;
      if (eventId) {
        const seen = state.seenEvents.get(id) || new Set();
        if (seen.has(String(eventId))) return;
        seen.add(String(eventId));
        if (seen.size > 1500) seen.delete(seen.values().next().value);
        state.seenEvents.set(id, seen); state.lastEvents.set(id, eventId);
      }
      if (data.session) { state.session = data.session; renderMessages(); return; }
      if (['delta','message.delta','assistant.delta','text_delta'].includes(data.type)) {
        const messages = messagesOf(state.session); let last = messages.at(-1);
        if (!last || last.role !== 'assistant') { last = { role:'assistant', content:'', status:'running' }; messages.push(last); }
        last.content = String(last.content || last.text || '') + (data.delta || data.text || ''); renderMessages(); setRunning(true);
      } else if (['message','message.completed'].includes(data.type) && data.message) {
        refreshSession().catch(() => {});
      } else if (data.type === 'done' || /completed|finished|cancelled|error|failed/.test(data.type || '')) {
        if (data.type === 'error') errorIn('chatError', data.message || data.error?.message || data.error || '制作未完成');
        if (data.error) errorIn('chatError', typeof data.error === 'string' ? data.error : data.error.message);
        if (data.type === 'done') { state.session.status = data.status; setRunning(false); }
        refreshSession().catch(() => {});
      } else if (data.type === 'activity') {
        $('runStatus').textContent = data.label || (data.activityType === 'command_execution' ? '正在执行制作任务…' : data.activityType === 'mcp_tool_call' ? '正在调用制作工具…' : '正在处理…');
      } else if (data.message || data.summary || data.text) {
        $('runStatus').textContent = data.message || data.summary || data.text;
      }
    };
    stream.onmessage = handler;
    ['session','snapshot','delta','status','activity','thread','usage','done','error','turn.completed','turn.failed'].forEach((type) => stream.addEventListener(type, handler));
    stream.onerror = () => { if (epoch === state.sessionEpoch && id === sessionId(state.session) && state.running) $('runStatus').textContent = '正在重新连接…'; };
  }
  async function sendMessage(event) {
    event.preventDefault(); const message = $('chatInput').value.trim(); if (!message || state.running || state.loadingSession || $('sendMessage').disabled) return;
    const epoch = state.sessionEpoch;
    errorIn('chatError', ''); $('sendMessage').disabled = true;
    try {
      if (!sessionId(state.session)) {
        const result = await api('/api/chat/sessions', { method:'POST', body:JSON.stringify({ title: message.slice(0, 35) }) });
        if (epoch !== state.sessionEpoch) return;
        state.session = result.session || result;
        state.sessions.unshift({ ...state.session }); renderSessions(); connectStream();
      }
      const modules = { descriptive_text:$('moduleText').checked, picture_in_picture:$('modulePip').checked, transitions:$('moduleTransitions').checked, music:$('moduleMusic').checked, voiceover:$('moduleVoice').checked };
      const result = await api(`/api/chat/sessions/${encodeURIComponent(sessionId(state.session))}/messages`, { method:'POST', body:JSON.stringify({ message, skillIds:state.selectedSkill ? [state.selectedSkill] : [], assetContext:state.selectedAssets.map((a) => ({ id:a.id,name:a.name,path:a.path || a.sourcePath,collectionId:a.collectionId,relativePath:a.relativePath,text:a.text })), modules }) });
      if (epoch !== state.sessionEpoch) return;
      $('chatInput').value = '';
      if (result.session) state.session = result.session;
      else { state.session.messages ||= []; state.session.messages.push({ role:'user',content:message }); state.session.running = true; }
      renderMessages(); setRunning(true); $('runStatus').textContent = '正在处理…';
      if (!state.poll) state.poll = setInterval(() => refreshSession().catch(() => {}), 1800);
    } catch (err) { if (epoch === state.sessionEpoch) { errorIn('chatError', err.message); setRunning(false); } }
    finally { if (epoch === state.sessionEpoch) $('sendMessage').disabled = false; }
  }
  function renderSelectedAssets() {
    $('selectedAssets').innerHTML = state.selectedAssets.map((a, i) => `<span class="asset-token">${icon(a.type === 'directory' ? 'folder' : a.type === 'slogan' ? 'type' : 'image')}<span>${esc(a.name)}</span><button data-remove-asset="${i}" title="移除素材" aria-label="移除${esc(a.name)}">×</button></span>`).join(''); renderIcons();
  }
  function addAsset(asset) { if (state.selectedAssets.some((a) => a.id === asset.id && a.collectionId === asset.collectionId)) return toast('已在制作素材中'); state.selectedAssets.push({ ...asset, collectionId:asset.collectionId || state.collectionId }); renderSelectedAssets(); toast('已加入制作素材'); }
  function collectionsForKind() { return state.collections.filter((c) => (c.kind || 'content') === state.assetKind || (state.assetKind === 'company' && ['brand','character','asset'].includes(c.kind))); }
  function renderCollections() {
    const collections = collectionsForKind();
    const special = state.assetKind === 'company' && ['__slogans','__character'].includes(state.collectionId);
    if (!special && !collections.some((c) => c.id === state.collectionId)) { state.collectionId = collections[0]?.id || null; state.folder = ''; }
    $('collectionHeading').textContent = state.assetKind === 'company' ? '固定资产' : '素材目录';
    $('collectionCount').textContent = collections.length;
    $('addSlogan').hidden = state.assetKind !== 'company';
    $('collectionList').innerHTML = collections.map((c) => `<button class="folder-button ${c.id === state.collectionId ? 'active' : ''}" data-collection="${esc(c.id)}" title="${esc(c.path || c.name)}">${icon(c.category === 'character' ? 'person-standing' : 'folder')}<span class="folder-name">${esc(c.name)}</span>${c.available === false ? '<span class="folder-offline">离线</span>' : ''}</button>`).join('') || '<div class="folder-placeholder">暂无映射目录</div>';
    if (state.assetKind === 'company') $('collectionList').innerHTML += `<button class="folder-button ${state.collectionId === '__slogans' ? 'active' : ''}" data-collection="__slogans">${icon('type')}<span class="folder-name">公司 Slogan</span></button><button class="folder-button ${state.collectionId === '__character' ? 'active' : ''}" data-collection="__character">${icon('person-standing')}<span class="folder-name">虚拟形象</span><span class="folder-offline">待定</span></button>`;
    renderIcons();
  }
  async function loadMedia() {
    const request = ++state.mediaRequest;
    $('assetSearch').value = ''; $('assetCategoryFilter').value = '';
    if (state.collectionId === '__slogans') { state.entries = state.slogans.map((s) => ({ ...s, type:'slogan', name:s.name || '公司 Slogan', text:s.text || s.content })); renderAssetBreadcrumbs(); renderAssets(); return; }
    if (state.collectionId === '__character') { state.entries = []; $('assetGrid').innerHTML = empty('person-standing', '虚拟形象待定'); $('assetFooter').textContent = ''; renderAssetBreadcrumbs(); renderIcons(); return; }
    if (!state.collectionId) { state.entries = []; $('assetGrid').innerHTML = empty('folder-plus', state.assetKind === 'company' ? '尚未添加公司资产' : '尚未映射素材目录'); $('assetBreadcrumbs').textContent = '全部目录'; $('assetFooter').textContent = ''; renderIcons(); return; }
    $('assetGrid').innerHTML = empty('loader-circle', '正在读取目录…'); renderAssetBreadcrumbs(); renderIcons();
    try {
      const data = await api(`/api/media?collectionId=${encodeURIComponent(state.collectionId)}&folder=${encodeURIComponent(state.folder)}`);
      if (request !== state.mediaRequest) return;
      state.entries = (data.entries || data.files || []).map((entry) => ({ ...entry, type:entry.type || (entry.isDirectory ? 'directory' : 'image'), id:entry.id || entry.relativePath || entry.name, name:entry.name || entry.filename }));
      state.categories = (data.categories || defaultCategories).map((c) => typeof c === 'string' ? c : c.name || c.label || c.id);
      state.categoryCounts = data.categoryCounts || {};
      renderCategoryFilter();
      renderAssetBreadcrumbs(); renderAssets();
    } catch (err) { if (request !== state.mediaRequest) return; state.entries = []; $('assetGrid').innerHTML = empty('folder-x', '目录暂时无法读取', err.message); $('assetFooter').textContent = ''; renderIcons(); }
  }
  function renderAssetBreadcrumbs() {
    const collection = state.collections.find((c) => c.id === state.collectionId);
    const parts = state.folder.split('/').filter(Boolean);
    $('assetBreadcrumbs').innerHTML = `<button data-folder="">${esc(collection?.name || (state.collectionId === '__slogans' ? '公司 Slogan' : state.collectionId === '__character' ? '虚拟形象' : '全部目录'))}</button>` + parts.map((part, i) => `${icon('chevron-right')}<button data-folder="${esc(parts.slice(0, i + 1).join('/'))}">${esc(part)}</button>`).join(''); renderIcons();
  }
  function renderAssets() {
    const query = $('assetSearch').value.trim().toLowerCase();
    const category = $('assetCategoryFilter').value;
    const entries = state.entries.filter((e) => `${e.name} ${e.text || ''}`.toLowerCase().includes(query) && (!category || (e.category || '待分类') === category));
    $('assetGrid').innerHTML = entries.length ? entries.map((entry) => {
      const directory = ['directory','folder'].includes(entry.type);
      const thumb = localUrl(entry.thumbnailUrl || (['image','photo'].includes(entry.type) ? entry.url : ''));
      const categories = [...new Set([entry.category || '待分类', ...state.categories, ...defaultCategories])];
      const categorySelect = !directory && entry.type !== 'slogan' ? `<select class="asset-category-select" data-asset-category="${esc(entry.id)}" aria-label="${esc(entry.name)}的分类" title="修改素材分类">${categories.map((c) => `<option value="${esc(c)}"${c === (entry.category || '待分类') ? ' selected' : ''}>${esc(c)}</option>`).join('')}</select>` : '';
      return `<article class="asset-item ${entry.type === 'slogan' ? 'slogan-item' : ''}"><button class="asset-open" data-open-asset="${esc(entry.id)}" title="${esc(entry.name)}"><span class="asset-thumbnail">${entry.type === 'slogan' ? esc(entry.text) : thumb ? `<img loading="lazy" src="${esc(thumb)}" alt="${esc(entry.name)}">` : icon(directory ? 'folder' : entry.type === 'video' ? 'film' : entry.type === 'audio' ? 'music-2' : 'file')} </span><span class="asset-name">${esc(entry.name)}</span><span class="asset-detail">${directory ? '文件夹' : entry.type === 'slogan' ? '文字资产' : fileSize(entry.size || entry.sizeBytes)}</span></button>${categorySelect}<button class="add-asset-button" data-add-asset="${esc(entry.id)}" title="加入制作素材" aria-label="将${esc(entry.name)}加入制作素材">${icon('plus')}</button></article>`;
    }).join('') : empty('search', query ? '没有找到匹配的素材' : '此目录暂无素材');
    $('assetFooter').textContent = `${entries.length} 项${state.folder ? ' · ' + state.folder : ''}`;
    renderIcons();
  }
  function renderCategoryFilter() {
    const previous = $('assetCategoryFilter').value;
    const categories = [...new Set([...state.categories, ...state.entries.map((e) => e.category || '待分类')])];
    $('assetCategoryFilter').innerHTML = '<option value="">全部分类</option>' + categories.map((c) => `<option value="${esc(c)}">${esc(c)}${state.categoryCounts[c] ? ` (${state.categoryCounts[c]})` : ''}</option>`).join('');
    if (categories.includes(previous)) $('assetCategoryFilter').value = previous;
  }
  function openAsset(id) {
    const entry = state.entries.find((e) => String(e.id) === id); if (!entry) return;
    if (['directory','folder'].includes(entry.type)) { state.folder = entry.relativePath || [state.folder, entry.name].filter(Boolean).join('/'); loadMedia(); return; }
    state.previewAsset = { ...entry, collectionId:state.collectionId };
    $('assetDialogTitle').textContent = entry.name;
    $('assetPreview').innerHTML = entry.type === 'slogan' ? `<p>${esc(entry.text)}</p>` : ['image','photo'].includes(entry.type) ? `<img src="${esc(localUrl(entry.url || entry.thumbnailUrl))}" alt="${esc(entry.name)}">` : entry.type === 'video' ? `<video src="${esc(localUrl(entry.url))}" controls playsinline></video>` : entry.type === 'audio' ? `<audio src="${esc(localUrl(entry.url))}" controls></audio>` : `<p>${esc(entry.name)}</p>`;
    $('assetDialog').showModal();
  }
  async function saveCollection(event) {
    event.preventDefault(); errorIn('collectionError', ''); $('saveCollection').disabled = true;
    try {
      const data = await api('/api/collections', { method:'POST', body:JSON.stringify({ name:$('collectionName').value.trim(), path:$('collectionPath').value.trim(), kind:$('collectionKind').value, category:$('collectionKind').value === 'company' ? $('companyCategory').value : undefined }) });
      const collection = data.collection || data;
      state.assetKind = $('collectionKind').value;
      if (collection.id) { state.collections.push(collection); state.collectionId = collection.id; state.folder = ''; }
      else await bootstrap();
      $('collectionDialog').close(); updateAssetKindButtons(); renderCollections(); await loadMedia(); toast('目录已添加');
    } catch (err) { errorIn('collectionError', err.message); }
    finally { $('saveCollection').disabled = false; }
  }
  function updateAssetKindButtons() { document.querySelectorAll('[data-asset-kind]').forEach((button) => button.classList.toggle('active', button.dataset.assetKind === state.assetKind)); }
  const imagePreview = document.createElement('img');
  imagePreview.id = 'pickerImagePreview';
  imagePreview.hidden = true;
  $('videoPlayer').before(imagePreview);
  if (pickerMode) {
    document.body.classList.add('library-picker-mode');
    document.querySelector('.page-heading h1').textContent = '从成片库选择';
    $('createFromLibrary').innerHTML = `${icon('refresh-cw')}刷新成片`;
    $('useVideoStyle').innerHTML = `${icon('check')}选择用于发布`;
  }
  document.addEventListener('click', (event) => {
    const close = event.target.closest('[data-close-dialog]'); if (close) $(close.dataset.closeDialog).close();
    const play = event.target.closest('[data-play-video]'); if (play) openVideo(play.dataset.playVideo);
    const style = event.target.closest('[data-style-video]'); if (style) useVideoStyle(style.dataset.styleVideo);
    const publish = event.target.closest('[data-publish-video]'); if (publish) publishSelection(publish.dataset.publishVideo);
    const skill = event.target.closest('[data-skill]'); if (skill) { state.selectedSkill = state.selectedSkill === skill.dataset.skill ? null : skill.dataset.skill; renderSkills(); }
    const suggestion = event.target.closest('[data-prompt]'); if (suggestion) { $('chatInput').value = suggestion.dataset.prompt; $('chatInput').focus(); }
    const remove = event.target.closest('[data-remove-asset]'); if (remove) { state.selectedAssets.splice(Number(remove.dataset.removeAsset), 1); renderSelectedAssets(); }
    const kind = event.target.closest('[data-asset-kind]'); if (kind) { state.assetKind = kind.dataset.assetKind; state.collectionId = null; state.folder = ''; updateAssetKindButtons(); renderCollections(); loadMedia(); }
    const collection = event.target.closest('[data-collection]'); if (collection) { state.collectionId = collection.dataset.collection; state.folder = ''; document.querySelectorAll('[data-collection]').forEach((b) => b.classList.toggle('active', b.dataset.collection === state.collectionId)); loadMedia(); }
    const folder = event.target.closest('[data-folder]'); if (folder) { state.folder = folder.dataset.folder; loadMedia(); }
    const asset = event.target.closest('[data-open-asset]'); if (asset) openAsset(asset.dataset.openAsset);
    const add = event.target.closest('[data-add-asset]'); if (add) { const asset = state.entries.find((e) => String(e.id) === add.dataset.addAsset); if (asset) addAsset(asset); }
  });
  $('videoSearch').addEventListener('input', renderVideos);
  $('assetSearch').addEventListener('input', renderAssets);
  $('assetCategoryFilter').addEventListener('change', renderAssets);
  $('assetGrid').addEventListener('change', async (event) => {
    const select = event.target.closest('[data-asset-category]'); if (!select) return;
    const asset = state.entries.find((e) => String(e.id) === select.dataset.assetCategory); if (!asset) return;
    const previous = asset.category || '待分类'; select.disabled = true;
    try { await api('/api/assets/category', { method:'POST', body:JSON.stringify({ collectionId:state.collectionId, relativePath:asset.relativePath || [state.folder, asset.name].filter(Boolean).join('/'), category:select.value }) }); asset.category = select.value; renderCategoryFilter(); renderAssets(); toast('分类已保存'); }
    catch (err) { select.value = previous; toast(err.message); }
    finally { select.disabled = false; }
  });
  $('createFromLibrary').addEventListener('click', () => { if (pickerMode) return bootstrapPicker(); location.hash = 'mix/create'; $('chatInput').focus(); });
  $('useVideoStyle').addEventListener('click', () => pickerMode ? publishSelection(state.previewVideo?.id) : useVideoStyle(state.previewVideo?.id));
  $('videoDialog').addEventListener('close', () => { $('videoPlayer').pause(); $('videoPlayer').removeAttribute('src'); $('videoPlayer').load(); imagePreview.removeAttribute('src'); });
  $('assetDialog').addEventListener('close', () => { $('assetPreview').innerHTML = ''; });
  $('addPreviewToChat').addEventListener('click', () => { if (state.previewAsset) addAsset(state.previewAsset); $('assetDialog').close(); location.hash = 'mix/create'; });
  $('refreshAll').addEventListener('click', bootstrap); $('refreshTools').addEventListener('click', bootstrap);
  $('pickAssets').addEventListener('click', () => { location.hash = 'mix/assets'; });
  $('chatForm').addEventListener('submit', sendMessage);
  $('chatInput').addEventListener('keydown', (event) => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); $('chatForm').requestSubmit(); } });
  $('stopGeneration').addEventListener('click', async () => { const id = sessionId(state.session), epoch = state.sessionEpoch; if (!id) return; try { await api(`/api/chat/sessions/${encodeURIComponent(id)}/cancel`, { method:'POST', body:'{}' }); if (epoch === state.sessionEpoch && id === sessionId(state.session)) await refreshSession(); } catch (err) { if (epoch === state.sessionEpoch) errorIn('chatError', err.message); } });
  $('newSession').addEventListener('click', () => { ++state.sessionEpoch; closeStream(); state.session = null; state.loadingSession = false; $('sendMessage').disabled = false; setRunning(false); renderMessages(); renderSessions(); errorIn('chatError', ''); $('chatInput').focus(); });
  $('sessionSelect').addEventListener('change', () => loadSession($('sessionSelect').value));
  $('addCollection').addEventListener('click', () => { $('collectionForm').reset(); $('collectionKind').value = state.assetKind; $('companyCategoryField').hidden = state.assetKind !== 'company'; errorIn('collectionError', ''); $('collectionDialog').showModal(); });
  $('collectionKind').addEventListener('change', () => $('companyCategoryField').hidden = $('collectionKind').value !== 'company');
  $('collectionForm').addEventListener('submit', saveCollection);
  $('addSlogan').addEventListener('click', () => { $('sloganForm').reset(); errorIn('sloganError', ''); $('sloganDialog').showModal(); });
  $('sloganForm').addEventListener('submit', async (event) => { event.preventDefault(); errorIn('sloganError', ''); try { const data = await api('/api/assets/slogan', { method:'POST', body:JSON.stringify({ name:$('sloganName').value.trim() || '公司 Slogan', text:$('sloganText').value.trim() }) }); const slogan = data.slogan || data; state.slogans.push(slogan); $('sloganDialog').close(); state.collectionId = '__slogans'; renderCollections(); state.collectionId = '__slogans'; loadMedia(); toast('Slogan 已保存'); } catch (err) { errorIn('sloganError', err.message); } });
  document.querySelectorAll('dialog').forEach((dialog) => dialog.addEventListener('click', (event) => { if (event.target === dialog) { const rect = dialog.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close(); } }));
  document.querySelector('.workspace-tabs').addEventListener('keydown', (event) => { if (!['ArrowLeft','ArrowRight'].includes(event.key)) return; const tabs = Array.from(document.querySelectorAll('[data-tab]')); const i = tabs.findIndex((t) => t === document.activeElement); if (i < 0) return; event.preventDefault(); const next = tabs[(i + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length]; next.focus(); next.click(); });
  window.addEventListener('hashchange', route);
  $('videoGrid').innerHTML = Array.from({length:6}, () => '<div class="skeleton-card" aria-hidden="true"></div>').join('');
  renderMessages(); renderTools(); renderCollections(); route(); renderIcons();
  bootstrap().then(() => route());
})();
