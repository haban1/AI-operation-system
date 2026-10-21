let workspace;
let content;
let frame;
let unauthorized;
let publish;
let receiveMessage;

// Keep the transplanted three-route workspace mounted, including its engine
// frames, when switching between creation and operations.
export function hideHotTopicStudio({ reset = false } = {}) {
  document.body.classList.remove('studio-active');
  if (content) content.hidden = false;
  if (!workspace) return;
  workspace.hidden = true;
  if (reset) {
    window.removeEventListener('message', receiveMessage);
    workspace.remove();
    workspace = frame = unauthorized = publish = receiveMessage = null;
  }
}

export function renderHotTopicStudio(container, { onUnauthorized, onPublish } = {}) {
  content = container;
  unauthorized = onUnauthorized;
  publish = onPublish;
  if (!workspace) {
    workspace = document.createElement('section');
    workspace.id = 'hotTopicWorkspace';
    workspace.className = 'signal-workspace';
    workspace.setAttribute('aria-label', '视频创作工作台');
    frame = document.createElement('iframe');
    frame.className = 'signal-workbench-frame';
    frame.title = '视频创作工作台 · 三条创作路径与共享成片库';
    frame.referrerPolicy = 'no-referrer';
    frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-popups allow-downloads allow-modals');
    frame.src = '/video-workbench/index.html';
    workspace.append(frame);
    content.after(workspace);
    receiveMessage = event => {
      if (event.origin !== location.origin || event.source !== frame?.contentWindow) return;
      if (event.data?.type === 'content-workbench:unauthorized') unauthorized?.();
      if (!workspace.hidden && event.data?.type === 'content-library:publish' && typeof event.data.id === 'string' && event.data.id.length <= 200) publish?.(event.data.id);
    };
    window.addEventListener('message', receiveMessage);
  }
  content.hidden = true;
  workspace.hidden = false;
  document.body.classList.add('studio-active');
}
