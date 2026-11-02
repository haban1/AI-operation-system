const $ = id => document.getElementById(id);
const active = new Set(['queued', 'generating', 'rendering']);
const labels = { queued: '等待处理', generating: '正在生成脚本', rendering: '正在生成视频', draft: '脚本待确认', completed: '视频已完成', failed: '处理失败', interrupted: '任务已中断', cancelled: '已取消' };
let projects = []; let selected = null; let dirty = false; let refreshing = false; let pendingCreate = null; let editorRevision = null;
let historySignature = '';
function notice(message, error = false) { $('notice').textContent = message; $('notice').hidden = !message; $('notice').classList.toggle('error', error); }
async function api(route, method = 'GET', data) {
  const response = await fetch(`/api/ai-studio${route}`, { method, cache: 'no-store', headers: data ? { 'Content-Type': 'application/json' } : {}, body: data ? JSON.stringify(data) : undefined, signal: AbortSignal.timeout(15000) });
  if (response.status === 401) throw new Error('请先在天河主页面登录，再刷新此页面。');
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || result.message || '请求失败，请稍后重试');
  return result;
}
function element(tag, className, text) { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; }
function renderHistory() {
  const signature = JSON.stringify([selected?.id, projects.map(({ id, topic, script, status, error, createdAt }) => [id, script?.title || topic, status, error, createdAt])]);
  if (signature === historySignature) return;
  historySignature = signature;
  const list = $('history'); list.replaceChildren();
  if (!projects.length) { list.append(element('p', 'hint', '还没有创作项目。生成的脚本和视频会显示在这里。')); return; }
  for (const project of projects) {
    const item = element('button', `historyItem${selected?.id === project.id ? ' selected' : ''}`);
    item.type = 'button'; item.append(element('strong', '', project.script?.title || project.topic));
    const bottom = element('div', 'historyBottom');
    bottom.append(element('small', '', new Date(project.createdAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })), element('span', `badge${project.status === 'completed' ? ' online' : project.error ? ' error' : ''}`, labels[project.status] || project.status));
    item.append(bottom); item.onclick = () => {
      if (dirty && !confirm('当前脚本有未保存的修改，是否放弃修改并切换项目？')) return;
      dirty = false; editorRevision = null; selectProject(project); renderHistory();
    }; list.append(item);
  }
}
function addScene(scene, index, disabled) {
  const panel = element('div', 'scene');
  const head = element('div', 'sceneHead'); head.append(element('span', 'sceneNum', String(index + 1).padStart(2, '0')));
  const heading = element('input'); heading.value = scene.heading; heading.maxLength = 32; heading.required = true; heading.dataset.field = 'heading'; heading.setAttribute('aria-label', `镜头 ${index + 1} 标题`);
  const seconds = element('input', 'sceneSeconds'); seconds.type = 'number'; seconds.min = '4'; seconds.max = '15'; seconds.value = scene.seconds; seconds.required = true; seconds.dataset.field = 'seconds'; seconds.setAttribute('aria-label', `镜头 ${index + 1} 最短秒数`);
  head.append(heading, seconds, element('small', 'hint', '秒')); panel.append(head);
  const text = element('textarea', 'sceneText'); text.value = scene.text; text.maxLength = 100; text.rows = 3; text.required = true; text.dataset.field = 'text'; text.setAttribute('aria-label', `镜头 ${index + 1} 屏幕正文`); panel.append(text);
  if (selected.voice) {
    const label = element('label', '', '配音文案'); const narration = element('textarea', 'sceneNarration'); narration.value = scene.narration; narration.maxLength = 160; narration.rows = 2; narration.dataset.field = 'narration'; narration.setAttribute('aria-label', `镜头 ${index + 1} 配音文案`); panel.append(label, narration);
  } else { panel.dataset.narration = scene.narration; }
  panel.querySelectorAll('input,textarea').forEach(input => { input.disabled = disabled; }); return panel;
}
function selectProject(project) {
  selected = project; $('empty').hidden = true; $('project').hidden = false;
  $('projectStatus').hidden = false; $('projectStatus').textContent = labels[project.status] || project.status;
  $('projectStatus').className = `badge${project.status === 'completed' ? ' online' : project.error ? ' error' : ''}`;
  const running = active.has(project.status);
  $('jobState').hidden = !running && !project.error; $('phase').textContent = labels[project.status] || project.status;
  $('percent').textContent = running ? `${project.progress || 0}%` : ''; $('progress').value = project.progress || 0; $('progress').hidden = !running;
  $('jobError').textContent = project.error || ''; $('cancel').hidden = !running; $('retry').hidden = !['failed', 'interrupted', 'cancelled'].includes(project.status);
  $('scriptForm').hidden = !project.script;
  if (project.script && !dirty && editorRevision !== project.revision) {
    $('scriptTitle').value = project.script.title; $('scriptSummary').value = project.script.summary;
    $('scenes').replaceChildren(...project.script.scenes.map((scene, index) => addScene(scene, index, running)));
    $('scriptTitle').disabled = running; $('scriptSummary').disabled = running; editorRevision = project.revision;
  }
  $('save').disabled = !dirty || running; $('render').disabled = dirty || running || !project.script;
  $('saveState').textContent = dirty ? '有未保存的修改' : '脚本已保存';
  $('preview').hidden = !project.runId;
  if (project.runId) {
    const base = `/api/ai-studio/projects/${project.id}/media/`;
    if ($('video').dataset.run !== project.runId) { $('video').src = `${base}video`; $('video').poster = `${base}poster`; $('video').dataset.run = project.runId; }
    $('downloadVideo').href = `${base}video`; $('downloadScript').href = `${base}script`; $('downloadSubtitles').href = `${base}subtitles`;
    $('downloadVideo').download = `${project.script?.title || '视频'}.mp4`;
    $('videoMeta').textContent = `${project.media.width} × ${project.media.height} · ${Math.round(project.media.duration)} 秒 · ${(project.media.sizeBytes / 1024 / 1024).toFixed(1)} MB${project.status !== 'completed' ? ' · 上一次完成的视频' : ''}`;
  }
}
async function refresh() {
  if (refreshing) return; refreshing = true;
  try {
    const data = await api('/projects'); projects = data.projects; renderHistory();
    if (selected && !dirty) { const updated = projects.find(p => p.id === selected.id); if (updated) selectProject(updated); }
  } catch (error) { notice(error.message, true); } finally { refreshing = false; }
}
async function create(autoRender) {
  if (!$('createForm').reportValidity()) return;
  if (dirty && !confirm('有未保存的脚本修改，是否放弃修改并创建新项目？')) return;
  const input = { topic: $('topic').value, brief: $('brief').value, ratio: $('ratio').value, theme: $('theme').value, voice: $('voice').checked, autoRender };
  const signature = JSON.stringify(input);
  if (!pendingCreate || pendingCreate.signature !== signature) pendingCreate = { signature, requestId: crypto.randomUUID() };
  $('generate').disabled = $('oneClick').disabled = true;
  try {
    const result = await api('/projects', 'POST', { ...input, requestId: pendingCreate.requestId });
    pendingCreate = null; dirty = false; editorRevision = null; selectProject(result.project); notice('任务已创建，进度会自动更新。'); await refresh();
  } catch (error) { notice(error.message, true); } finally { $('generate').disabled = $('oneClick').disabled = false; }
}
$('createForm').onsubmit = event => { event.preventDefault(); create(false); };
$('oneClick').onclick = () => create(true);
$('scriptForm').oninput = () => { dirty = true; $('saveState').textContent = '有未保存的修改'; $('save').disabled = false; $('render').disabled = true; };
$('scriptForm').onsubmit = async event => {
  event.preventDefault(); if (!selected) return; $('save').disabled = true;
  const script = { title: $('scriptTitle').value, summary: $('scriptSummary').value, scenes: [...$('scenes').children].map(panel => {
    const value = field => panel.querySelector(`[data-field="${field}"]`)?.value;
    return { heading: value('heading'), text: value('text'), narration: value('narration') || panel.dataset.narration || value('text'), seconds: Number(value('seconds')) };
  }) };
  try { const result = await api(`/projects/${selected.id}/script`, 'PUT', { script, revision: editorRevision }); dirty = false; editorRevision = null; selectProject(result.project); notice('脚本修改已保存。'); await refresh(); }
  catch (error) { notice(error.message, true); $('save').disabled = false; }
};
async function action(name, data = {}) {
  if (!selected) return; const button = $(name); button.disabled = true;
  try { const result = await api(`/projects/${selected.id}/${name}`, 'POST', data); editorRevision = null; selectProject(result.project); notice(name === 'cancel' ? '已请求取消任务。' : '任务已提交。'); await refresh(); }
  catch (error) { notice(error.message, true); } finally { button.disabled = false; if (selected) selectProject(selected); }
}
$('render').onclick = () => action('render', { revision: selected.revision });
$('cancel').onclick = () => action('cancel'); $('retry').onclick = () => action('retry');
$('refresh').onclick = refresh;
$('openLibrary').onclick = event => { if (window.parent !== window) { event.preventDefault(); window.parent.postMessage({ type: 'ai-studio:open-library' }, location.origin); } };
$('sync').onclick = async () => {
  const runId = selected?.runId;
  if (!runId) return;
  $('sync').disabled = true;
  try {
    const response = await fetch('/api/content-library/sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(60000) });
    const data = await response.json(); if (!response.ok) throw new Error(data.message || '成片同步失败');
    if (!data.items?.some(item => item.source === 'automatic' && item.sourceId === runId)) throw new Error('当前作品尚未入库，请稍后重新同步，或到成片库查看来源状态。');
    notice('同步已完成，可前往天河成片库查看、选择作品。');
  } catch (error) { notice(error.message, true); } finally { $('sync').disabled = false; }
};
async function modelStatus() {
  try { const data = await api('/status'); $('modelStatus').textContent = data.model.online ? `天河模型 · ${data.model.model}` : data.model.message; $('modelStatus').className = `badge ${data.model.online ? 'online' : 'error'}`; }
  catch (error) { $('modelStatus').textContent = '模型状态暂不可用'; notice(error.message, true); }
}
window.addEventListener('beforeunload', event => { if (dirty) { event.preventDefault(); event.returnValue = ''; } });
refresh(); modelStatus(); setInterval(() => { if (!document.hidden) refresh(); }, 3000); setInterval(() => { if (!document.hidden) modelStatus(); }, 30000);
