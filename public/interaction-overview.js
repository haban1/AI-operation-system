import { platformLogo } from './platform-icons.js?v=20261111-v2';
import { patchBackgroundContent } from './background-dom.js?v=20261112-refresh';

export function interactionAccountName(account) {
  const platform = String(account?.platform_name || account?.platform_code || '');
  const nickname = String(account?.login_status || '').toUpperCase() === 'READY' ? String(account.platform_user_name || '').trim() : '';
  return nickname ? `${nickname} · ${platform}` : platform;
}

function accountStatus(account, runtimes) {
  if (Number(account.enabled) === 0 || account.platform_effective_state === 'STOPPED') return ['muted', '已暂停'];
  if (account.login_status !== 'READY') return ['warn', account.login_status === 'UNKNOWN' ? '待检查登录' : '需登录'];
  if (runtimes.some(item => ['ERROR', 'FAILED', 'DEGRADED'].includes(item.state))) return ['warn', '采集需检查'];
  if (runtimes.some(item => ['QUEUED', 'RUNNING'].includes(item.state))) return ['busy', '采集中'];
  if (['COMMENT', 'PRIVATE_MESSAGE'].every(channel => runtimes.some(item => item.channel_type === channel && item.last_success_at))) return ['ok', '已同步'];
  return ['muted', runtimes.some(item => item.last_success_at) ? '部分已采集' : '未完成采集'];
}

export function renderInteractionOverview(root, { accounts = [], data = {}, selectedId, view, onSelect } = {}) {
  if (!root) return;
  const make = (tag, className, text) => {
    const element = document.createElement(tag); element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  };
  const section = make('section', 'interaction-overview'); section.setAttribute('aria-label', '各平台互动概览');
  const heading = make('header', 'interaction-overview-heading');
  heading.append(make('b', '', '平台概览'), make('span', '', '待人工处理 · 已采集消息'));
  const grid = make('div', 'interaction-overview-grid');
  for (const account of accounts) {
    const entries = (data.overview || []).filter(item => Number(item.account_id) === Number(account.id));
    const known = Array.isArray(data.overview);
    const runtimes = (data.channelRuntimeStates || []).filter(item => Number(item.account_id) === Number(account.id) && item.platform_code === account.platform_code);
    const [tone, label] = accountStatus(account, runtimes);
    const selected = Number(account.id) === Number(selectedId);
    const card = make('article', `interaction-platform-card${selected ? ' is-selected' : ''}`);
    card.dataset.refreshKey = `platform-overview:${account.id}`; card.dataset.account = account.id;
    const top = make('button', 'interaction-platform-title'); top.type = 'button';
    top.setAttribute('aria-label', `查看${interactionAccountName(account)}`); top.setAttribute('aria-pressed', String(selected));
    const logo = make('span', 'interaction-platform-logo'); logo.innerHTML = platformLogo(account.platform_code, 28);
    top.append(logo, make('b', '', interactionAccountName(account))); top.onclick = () => onSelect(account.id, view);
    const metrics = make('div', 'interaction-platform-counts');
    for (const [channel, text] of [['COMMENT', '评论'], ['PRIVATE_MESSAGE', '私信']]) {
      const entry = entries.find(item => item.message_type === channel);
      const count = known ? Number(entry?.pending || 0) : '—';
      const button = make('button', `interaction-platform-count${selected && channel === view ? ' is-current' : ''}`);
      button.type = 'button'; button.dataset.channel = channel;
      button.setAttribute('aria-label', `${interactionAccountName(account)}，${text}待处理 ${count} 条`);
      button.append(make('span', '', text), make('strong', count > 0 ? 'has-pending' : '', count));
      button.onclick = () => onSelect(account.id, channel); metrics.append(button);
    }
    const footer = make('footer', 'interaction-platform-footer');
    const state = make('span', `interaction-platform-state is-${tone}`, label);
    const total = entries.reduce((sum, item) => sum + Number(item.total || 0), 0);
    footer.append(state, make('span', '', known ? `已采集 ${total}` : '统计待更新'));
    card.append(top, metrics, footer); grid.append(card);
  }
  section.append(heading, grid);
  const next = document.createElement('div'); next.append(section);
  patchBackgroundContent(root, next);
}
