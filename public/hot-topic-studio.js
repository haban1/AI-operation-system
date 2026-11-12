let workspace;
let content;
let frame;
let unauthorized;
let publish;
let receiveMessage;
let viewChanged;
let currentViewTitle;
let currentMode;
let contentRoute = 'overview';
let openSettings;

// Keep the production chat and library mounted while navigating operations.
export function hideHotTopicStudio({ reset = false } = {}) {
  document.body.classList.remove('studio-active', 'studio-settings-active');
  if (content) content.hidden = false;
  if (!workspace) return;
  workspace.hidden = true;
  if (reset) {
    window.removeEventListener('message', receiveMessage);
    workspace.remove();
    workspace = frame = unauthorized = publish = receiveMessage = currentViewTitle = null;
    currentMode = openSettings = null;
    contentRoute = 'overview';
  }
}

export function renderHotTopicStudio(container, { view, onUnauthorized, onPublish, onViewChanged, onOpenSettings } = {}) {
  content = container;
  unauthorized = onUnauthorized;
  publish = onPublish;
  viewChanged = onViewChanged;
  openSettings = onOpenSettings;
  const mode = view === 'settings' ? 'settings' : 'content';
  const changedMode = currentMode && currentMode !== mode;
  currentMode = mode;
  if (!workspace) {
    workspace = document.createElement('section');
    workspace.id = 'hotTopicWorkspace';
    workspace.className = 'signal-workspace';
    workspace.setAttribute('aria-label', '内容生成');
    frame = document.createElement('iframe');
    frame.className = 'signal-workbench-frame';
    frame.title = '内容生成 · 自动热点与混剪';
    frame.referrerPolicy = 'no-referrer';
    frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-popups allow-downloads allow-modals');
    frame.onload = () => frame?.contentWindow?.postMessage({type:'content-workbench:navigate',view:currentMode === 'settings' ? 'settings' : contentRoute},location.origin);
    frame.src = '/video-workbench/index.html?v=20261112-main-montage' + (mode === 'settings' ? '#settings' : '');
    workspace.append(frame);
    content.after(workspace);
    receiveMessage = event => {
      if (event.origin !== location.origin || event.source !== frame?.contentWindow) return;
      if (!workspace.hidden && event.data?.type === 'content-workbench:view-changed' && typeof event.data.title === 'string' && event.data.title.length <= 40) {
        if(event.data.view === 'settings') { if(currentMode !== 'settings')openSettings?.(); }
        else if(currentMode === 'content') {
          if(typeof event.data.route === 'string' && /^(overview|materials|editing|creation|automatic\/(create|library)|mix\/(create|library|assets))$/.test(event.data.route))contentRoute=event.data.route;
          currentViewTitle=event.data.title;viewChanged?.(event.data);
        }
      }
      if (event.data?.type === 'content-workbench:unauthorized') unauthorized?.();
      if (!workspace.hidden && event.data?.type === 'content-library:publish' && typeof event.data.id === 'string' && event.data.id.length <= 200) publish?.(event.data.id);
    };
    window.addEventListener('message', receiveMessage);
  }
  content.hidden = true;
  workspace.hidden = false;
  document.body.classList.toggle('studio-active', mode === 'content');
  document.body.classList.toggle('studio-settings-active', mode === 'settings');
  if(changedMode)frame.contentWindow?.postMessage({type:'content-workbench:navigate',view:mode === 'settings' ? 'settings' : contentRoute},location.origin);
  if(mode === 'content' && currentViewTitle)viewChanged?.({title:currentViewTitle});
}
