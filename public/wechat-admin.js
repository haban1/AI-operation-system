let dispose = () => {};
export function cleanupWechatAdmin() { dispose(); dispose = () => {}; }

export function renderWechatAdmin(container) {
  cleanupWechatAdmin();
  const controller = new AbortController();
  container.innerHTML = `<section class="panel wx-robot-panel"><div class="panel-head"><div><h3>微信客服</h3><p class="muted">微信助手 · 联系人、人工接待、好友群发与知识库</p></div><button class="btn ghost" data-robot-reload type="button">重新加载</button></div><div data-robot-status class="notice" role="status">正在连接微信助手…</div><div data-robot-frame></div></section>`;
  container.querySelector('[data-robot-reload]').onclick = () => renderWechatAdmin(container);
  dispose = () => { controller.abort(); container.querySelectorAll('iframe').forEach(frame => frame.remove()); };
  (async () => {
    try {
      const response = await fetch('/api/wechat/robot-admin', {credentials:'same-origin', signal:controller.signal});
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || '无法连接微信助手');
      if (controller.signal.aborted) return;
      const address = new URL(data.url, window.location.origin);
      if (data.embedded !== true || address.origin !== window.location.origin || address.pathname !== '/wechat-workbench/') {
        throw new Error('微信助手尚未配置系统内访问，请联系管理员完成接入。');
      }
      const frame = document.createElement('iframe');
      frame.title = '微信助手操作面板'; frame.className = 'wx-robot-frame'; frame.referrerPolicy = 'same-origin';
      frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads');
      frame.onload = () => {
        if (controller.signal.aborted) return;
        const status = container.querySelector('[data-robot-status]');
        try {
          const doc = frame.contentDocument;
          if (!doc?.querySelector('#root')) {
            let error;
            try { error = JSON.parse(doc.body.textContent); } catch {}
            status.textContent = error?.message || '微信助手加载失败，请重新加载';
            status.className = 'notice warn';
            return;
          }
          status.hidden = true;
        } catch { status.textContent = '微信助手加载失败，请重新加载'; status.className = 'notice warn'; }
      };
      frame.src = address.href;
      container.querySelector('[data-robot-frame]').replaceChildren(frame);
    } catch (error) {
      if (!controller.signal.aborted) {
        container.querySelector('[data-robot-status]').textContent = error.message;
        container.querySelector('[data-robot-status]').className = 'notice warn';
      }
    }
  })();
}
