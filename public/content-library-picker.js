let activeDialog;

export function closeContentLibraryPicker() {
  activeDialog?.close();
}

export function openContentLibraryPicker({ onSelect, onUnauthorized } = {}) {
  closeContentLibraryPicker();
  const dialog = document.createElement('dialog');
  dialog.className = 'content-library-picker';
  dialog.setAttribute('aria-label', '从共享成片库选择素材');
  dialog.innerHTML = `<header><div><b>从成片库选择</b><span>三条创作路径的生成结果，统一带入发布。</span></div><button type="button" class="ghost" aria-label="关闭成片库">关闭</button></header><iframe title="共享成片库选择器" src="/video-workbench/index.html?picker=1#library" referrerpolicy="no-referrer"></iframe>`;
  const frame = dialog.querySelector('iframe');
  const receive = event => {
    if (!dialog.isConnected || event.origin !== location.origin || event.source !== frame.contentWindow) return;
    if (event.data?.type === 'content-workbench:unauthorized') {
      dialog.close();
      onUnauthorized?.();
    } else if (event.data?.type === 'content-library:publish' && typeof event.data.id === 'string' && event.data.id.length <= 200) {
      dialog.close();
      onSelect?.(event.data.id);
    }
  };
  window.addEventListener('message', receive);
  dialog.addEventListener('close', () => {
    window.removeEventListener('message', receive);
    dialog.remove();
    if (activeDialog === dialog) activeDialog = null;
  }, { once: true });
  dialog.querySelector('button').onclick = () => dialog.close();
  document.body.append(dialog);
  activeDialog = dialog;
  dialog.showModal();
}
