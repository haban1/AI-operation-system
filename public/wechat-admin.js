let dispose = () => {};
export function cleanupWechatAdmin() { dispose(); dispose = () => {}; }

export function renderWechatAdmin(container) {
  cleanupWechatAdmin();
  const controller = new AbortController();
  container.innerHTML = `<section class="panel wx-robot-panel"><div class="panel-head"><div><h3>微信客服</h3><p class="muted">打开机器人管理，使用「人工接待」「好友群发」和「知识库」。微信问答资料在这里的知识库维护。</p></div><div class="wx-toolbar"><button class="btn ghost" data-robot-reload type="button">重新加载</button><a class="btn ghost" data-robot-open target="_blank" rel="noopener noreferrer" hidden>独立窗口打开</a></div></div><div data-robot-status class="notice" role="status">正在加载机器人管理后台…</div><div data-robot-frame></div></section>`;
  container.querySelector('[data-robot-reload]').onclick = () => renderWechatAdmin(container);
  dispose = () => { controller.abort(); container.querySelectorAll('iframe').forEach(frame => frame.remove()); };
  (async () => {
    try {
      const response = await fetch('/api/wechat/robot-admin', {credentials:'same-origin', signal:controller.signal});
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || '无法获取机器人管理地址');
      if (controller.signal.aborted) return;
      const address = new URL(data.url);
      if (!['http:', 'https:'].includes(address.protocol) || address.username || address.password) throw new Error('机器人管理地址无效');
      // Explicitly enabled only when Tianhe and the robot are exposed on the same host.
      // Keep iframe cookies same-site for both loopback and LAN access.
      if (data.followHost === true) address.hostname = window.location.hostname;
      const link = container.querySelector('[data-robot-open]'); link.href = address.href; link.hidden = false;
      container.querySelector('[data-robot-status]').textContent = '模型统一在天河「企微及 AI」配置。首次使用请用原机器人后台密钥登录，再打开机器人管理。人工接待期间在微信客户端回复，完成后在这里恢复 AI。';
      const frame = document.createElement('iframe');
      frame.title = '微信机器人管理后台'; frame.className = 'wx-robot-frame'; frame.referrerPolicy = 'no-referrer';
      frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads');
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
