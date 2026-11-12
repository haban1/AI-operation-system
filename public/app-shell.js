/* 工作台外框：侧栏搜索与计数、底部 AI 员工状态卡、顶栏合并栏目切换、⌘K 命令面板。
   只读 bootstrap 数据（app.js 派发的 app:bootstrap 事件）并跳转页面（设置 location.hash），
   不调用任何写接口；原有导航、运行开关、刷新与退出按钮全部保留。 */
import { PLATFORM_BRANDS, PLATFORM_ORDER, platformPath } from './platform-icons.js?v=20261111-v2';

const PAGES = [
  ['overview', '运营总览', '运营总览', '首页 数据 指标 今天'],
  ['studio', '创作方式', '内容创作', '创作 成片 视频 素材 热点'],
  ['publishing', '发布内容', '发布管理', '新建 发布 视频 图片 文案'],
  ['schedule', '发布排期', '发布管理', '定时 排期 计划'],
  ['publish-tasks', '发布任务', '发布管理', '任务 结果 核验 重试'],
  ['comments', '评论', '用户互动', '评论 回复 互动'],
  ['private-messages', '私信', '用户互动', '私信 消息 会话'],
  ['mini-program', '小程序对话', '用户互动', '小程序 咨询'],
  ['human-handoffs', '转人工记录', '用户互动', '人工 接管 企微 通知'],
  ['wechat-service', '微信客服', '微信客服', '微信 群发 朋友圈 联系人'],
  ['documents', '文件管理', '知识库', '知识 文件 上传 资料'],
  ['answer-style', '回答风格 / 人设', '知识库', '人设 风格 问候'],
  ['reply-test', 'RAG 问答测试', '知识库', '测试 问答 RAG'],
  ['accounts', '平台账号', '平台账号', '账号 登录 启停 智能回复'],
  ['services', 'AI 服务', '系统设置', '模型 Key AI 配置'],
  ['creation-settings', '创作设置', '系统设置', '配音 创作 模型'],
  ['notifications', '消息通知', '系统设置', '企微 Webhook 通知'],
  ['usage', '调用记录', '系统设置', '费用 Token 调用'],
  ['browser-tools', '浏览器状态', '系统设置', '浏览器 登录 修复'],
  ['diagnostics', '问题记录', '系统设置', '问题 异常 报错']
];
const ICON = {
  search: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6"/><path d="m20 20-4.5-4.5"/></svg>',
  page: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/></svg>',
  action: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M13 3 5 14h6l-1 7 8-11h-6z"/></svg>',
  enter: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 10 4 15l5 5"/><path d="M20 4v7a4 4 0 0 1-4 4H4"/></svg>'
};
const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const shortcut = isMac ? '⌘K' : 'Ctrl K';
let latest = null;

/* ---------- 侧栏：搜索入口 + 计数 ---------- */
function mountSidebarSearch() {
  const brand = document.querySelector('.sidebar .brand');
  if (!brand || document.querySelector('.shell-search')) return;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'shell-search';
  button.innerHTML = `${ICON.search}<span>搜索页面或操作</span><kbd>${shortcut}</kbd>`;
  button.onclick = openPalette;
  brand.after(button);
}
function navCounts(data) {
  const s = data?.stats || {};
  return { inbox: Number(s.manualRequired || 0), publishing: Number(s.queuedTasks || 0), settings: Number(s.openIssues || 0) };
}
function paintBadges() {
  if (!latest) return;
  const counts = navCounts(latest);
  const tone = { inbox: 'warn', publishing: 'acc', settings: 'danger' };
  for (const button of document.querySelectorAll('#nav [data-workspace]')) {
    const key = button.dataset.workspace;
    let badge = button.querySelector('.shell-badge');
    const value = counts[key] || 0;
    if (!value) { badge?.remove(); continue; }
    if (!badge) { badge = document.createElement('em'); button.append(badge); }
    const text = value > 99 ? '99+' : String(value);
    if (badge.textContent !== text) badge.textContent = text;
    badge.className = `shell-badge is-${tone[key] || 'acc'}`;
  }
}

/* ---------- 侧栏底部：AI 员工状态卡（原“运行状态”折叠区的摘要行） ---------- */
function accountOk(account) {
  return account && Number(account.enabled) !== 0 && String(account.platform_effective_state || '').toUpperCase() !== 'STOPPED' && String(account.login_status || '').toUpperCase() === 'READY';
}
function paintStatusCard() {
  const summary = document.querySelector('.sidebar .side-status > summary');
  if (!summary) return;
  if (!summary.querySelector('.shell-status')) {
    summary.innerHTML = '<span class="shell-status"><span class="shell-status-head"><i class="shell-pulse"></i><b></b><span class="shell-chevron" aria-hidden="true"></span></span><span class="shell-status-logos"></span><small></small></span>';
  }
  const running = latest?.config?.masterSwitch?.enabled !== false;
  const accounts = latest?.accounts || [];
  const head = summary.querySelector('.shell-status-head b');
  const text = running ? 'AI 员工运行中' : 'AI 员工已暂停';
  if (head.textContent !== text) head.textContent = text;
  summary.querySelector('.shell-pulse').classList.toggle('is-paused', !running);
  const logos = summary.querySelector('.shell-status-logos');
  const signature = PLATFORM_ORDER.map(code => `${code}:${accountOk(accounts.find(a => a.platform_code === code)) ? 1 : 0}`).join(',');
  if (logos.dataset.signature !== signature) {
    logos.dataset.signature = signature;
    logos.innerHTML = PLATFORM_ORDER.map(code => {
      const brand = PLATFORM_BRANDS[code], ok = accountOk(accounts.find(a => a.platform_code === code));
      return `<span class="shell-status-logo ${ok ? 'is-ok' : 'is-off'}" title="${brand.name}${ok ? ' 已登录' : ' 未就绪'}" style="${brand.filled ? `background:${brand.color}` : ''}"><svg viewBox="0 0 24 24"><path fill="${brand.filled ? '#fff' : brand.color}" d="${platformPath(code)}"/></svg></span>`;
    }).join('');
  }
  const ready = PLATFORM_ORDER.filter(code => accountOk(accounts.find(a => a.platform_code === code))).length;
  const note = `${ready} 个平台可执行 · 点开查看运行开关`;
  const small = summary.querySelector('small');
  if (small.textContent !== note) small.textContent = note;
}

/* ---------- 顶栏：栏目切换并入顶栏，右侧搜索 ---------- */
function mountTopbar() {
  const topbar = document.querySelector('main > .topbar');
  if (!topbar) return;
  if (!topbar.querySelector('.shell-top-tools')) {
    const tools = document.createElement('div');
    tools.className = 'shell-top-tools';
    tools.innerHTML = `<button type="button" class="shell-icon-button" aria-label="搜索页面或操作（${shortcut}）" title="搜索（${shortcut}）">${ICON.search}</button>`;
    tools.querySelector('button').onclick = openPalette;
    topbar.append(tools);
  }
  const subnav = document.querySelector('#workspaceSubnav');
  if (subnav && subnav.parentElement !== topbar) topbar.insertBefore(subnav, topbar.querySelector('.shell-top-tools'));
  const many = Boolean(subnav && !subnav.hidden && subnav.querySelectorAll('.ws-section-tab').length > 1);
  topbar.classList.toggle('has-subnav', many);
  // 只有一个栏目时，栏目名与页面标题重复，不显示分段控件
  if (subnav) subnav.classList.toggle('shell-single', !many);
}

/* ---------- ⌘K 命令面板 ---------- */
let palette = null;
function actions() {
  const night = document.documentElement.getAttribute('data-theme') === 'night';
  return [
    { label: night ? '切换到日间模式' : '切换到夜间模式', group: '操作', keywords: '主题 日间 夜间 深色 浅色', run: () => document.querySelector('.tk-theme-toggle')?.click() },
    { label: '刷新当前页面', group: '操作', keywords: '刷新 重新加载', run: () => document.querySelector('#refreshBtn')?.click() }
  ];
}
function entries(query) {
  const q = query.trim().toLocaleLowerCase();
  const current = (location.hash || '').slice(1);
  const pages = PAGES.map(([key, label, group, keywords]) => ({ label, group: `页面 · ${group}`, hint: group, keywords: `${label} ${group} ${keywords} ${key}`, run: () => { location.hash = key; }, current: key === current, kind: 'page' }));
  const all = [...pages, ...actions().map(item => ({ ...item, kind: 'action' }))];
  if (!q) return all;
  return all.filter(item => `${item.label} ${item.keywords}`.toLocaleLowerCase().includes(q));
}
function renderPalette() {
  const { list, input } = palette;
  const items = entries(input.value);
  palette.items = items;
  palette.active = Math.min(palette.active, Math.max(0, items.length - 1));
  list.replaceChildren();
  if (!items.length) {
    const empty = document.createElement('p');
    empty.className = 'shell-palette-empty';
    empty.textContent = `没有找到“${input.value.trim()}”相关的页面或操作`;
    list.append(empty);
    return;
  }
  let lastGroup = '';
  items.forEach((item, index) => {
    const group = item.kind === 'page' ? '页面' : '操作';
    if (group !== lastGroup) { const h = document.createElement('div'); h.className = 'shell-palette-group'; h.textContent = group; list.append(h); lastGroup = group; }
    const row = document.createElement('div');
    row.className = `shell-palette-item${index === palette.active ? ' is-active' : ''}`;
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', String(index === palette.active));
    row.innerHTML = `<span class="shell-palette-icon">${item.kind === 'page' ? ICON.page : ICON.action}</span><span class="shell-palette-label"></span>${item.hint ? '<small></small>' : ''}${item.current ? '<em>当前</em>' : ''}<span class="shell-palette-enter">${ICON.enter}</span>`;
    row.querySelector('.shell-palette-label').textContent = item.label;
    if (item.hint) row.querySelector('small').textContent = item.hint;
    row.onmouseenter = () => { palette.active = index; paintActive(); };
    row.onclick = () => runItem(index);
    list.append(row);
  });
}
function paintActive() {
  palette.list.querySelectorAll('.shell-palette-item').forEach((row, index) => {
    const active = index === palette.active;
    row.classList.toggle('is-active', active);
    row.setAttribute('aria-selected', String(active));
    if (active) row.scrollIntoView({ block: 'nearest' });
  });
}
function runItem(index) {
  const item = palette?.items[index];
  closePalette();
  item?.run();
}
function closePalette() {
  if (!palette) return;
  const { overlay, previous } = palette;
  palette = null;
  overlay.classList.add('is-closing');
  setTimeout(() => overlay.remove(), 120);
  previous?.focus?.({ preventScroll: true });
}
function openPalette() {
  if (palette) { closePalette(); return; }
  if (document.querySelector('.confirm-overlay')) return;
  const overlay = document.createElement('div');
  overlay.className = 'shell-palette-overlay';
  overlay.innerHTML = `<div class="shell-palette" role="dialog" aria-modal="true" aria-label="搜索页面或操作"><label class="shell-palette-search">${ICON.search}<input type="text" placeholder="搜索页面或操作，例如“评论”“定时”“夜间”" autocomplete="off" spellcheck="false" aria-label="搜索页面或操作"><kbd>Esc</kbd></label><div class="shell-palette-list" role="listbox"></div><footer><span><kbd>↑</kbd><kbd>↓</kbd> 选择</span><span><kbd>↵</kbd> 打开</span><span><kbd>Esc</kbd> 关闭</span></footer></div>`;
  document.body.append(overlay);
  palette = { overlay, input: overlay.querySelector('input'), list: overlay.querySelector('.shell-palette-list'), active: 0, items: [], previous: document.activeElement };
  palette.input.oninput = () => { palette.active = 0; renderPalette(); };
  palette.input.onkeydown = event => {
    if (event.key === 'ArrowDown') { event.preventDefault(); palette.active = Math.min(palette.items.length - 1, palette.active + 1); paintActive(); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); palette.active = Math.max(0, palette.active - 1); paintActive(); }
    else if (event.key === 'Enter') { event.preventDefault(); runItem(palette.active); }
    else if (event.key === 'Escape') { event.preventDefault(); closePalette(); }
  };
  overlay.onclick = event => { if (event.target === overlay) closePalette(); };
  renderPalette();
  setTimeout(() => palette?.input.focus(), 0);
}

/* ---------- 启动 ---------- */
function paintAll() { mountSidebarSearch(); mountTopbar(); paintBadges(); paintStatusCard(); }
export function startAppShell() {
  window.addEventListener('app:bootstrap', event => { latest = event.detail; paintBadges(); paintStatusCard(); });
  document.addEventListener('keydown', event => {
    if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'k') { event.preventDefault(); openPalette(); }
  });
  paintAll();
  // 外框模块可能晚于首次数据加载：直接读取主程序已保存的数据，不额外请求接口
  if (!latest && window.__appBootstrap) { latest = window.__appBootstrap; paintBadges(); paintStatusCard(); }
  let queued = false;
  new MutationObserver(() => {
    if (queued) return;
    queued = true;
    queueMicrotask(() => { queued = false; paintAll(); });
  }).observe(document.querySelector('.shell') || document.body, { childList: true, subtree: true });
}
