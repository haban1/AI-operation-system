let activeDialog;

export function closeContentLibraryPicker() {
  const dialog = activeDialog;
  activeDialog = null;
  dialog?.close();
}

export function openContentLibraryPicker({ onSelect, onUnauthorized } = {}) {
  closeContentLibraryPicker();
  const dialog = document.createElement('dialog');
  let settled = false;
  dialog.className = 'content-library-picker';
  dialog.setAttribute('aria-label', '从成片库选择');
  dialog.innerHTML = `<header><div><b>从成片库选择</b><span>已入库的成片可直接使用；待确认的成片点“入库并去发布”。</span></div><button type="button" class="ghost" aria-label="关闭成片库">关闭</button></header><iframe title="成片库选择器" src="/video-workbench/index.html?picker=1#library" referrerpolicy="no-referrer"></iframe>`;
  const frame = dialog.querySelector('iframe');
  const receive = event => {
    if (settled || activeDialog !== dialog || !dialog.isConnected || event.origin !== location.origin || event.source !== frame.contentWindow) return;
    if (event.data?.type === 'content-workbench:unauthorized') {
      settled = true;
      dialog.close();
      onUnauthorized?.();
    } else if (event.data?.type === 'content-library:publish' && typeof event.data.id === 'string' && /^[a-f0-9]{32}$/.test(event.data.id)) {
      settled = true;
      dialog.close();
      onSelect?.(event.data.id);
    }
  };
  window.addEventListener('message', receive);
  dialog.addEventListener('close', () => {
    settled = true;
    window.removeEventListener('message', receive);
    dialog.remove();
    if (activeDialog === dialog) activeDialog = null;
  }, { once: true });
  dialog.querySelector('button').onclick = () => { settled = true; dialog.close(); };
  document.body.append(dialog);
  activeDialog = dialog;
  dialog.showModal();
}
