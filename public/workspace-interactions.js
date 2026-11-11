import { platformLogo } from './platform-icons.js?v=20261111-v2';
const privateSelection = new WeakMap();
const platformNames = { douyin: '抖音', wechat_channels: '视频号', bilibili: 'B站', weibo: '微博', xiaohongshu: '小红书' };

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function disclosure(className, label) {
  const details = element('details', className);
  details.append(element('summary', '', label));
  return details;
}

function retainDetails(card, selector, label, className) {
  if (card.querySelector(`:scope > .${className}`)) return;
  const nodes = [...card.querySelectorAll(selector)];
  if (!nodes.length) return;
  const details = disclosure(className, label);
  nodes[0].before(details);
  details.append(...nodes);
}

/* 卡片操作按钮分主次：能回复时“人工回复”为主按钮，否则“人工已处理”；“删除”为浅红文字按钮。
   只改外观类名，保留 app.js 绑定事件用的 .manual-reply / .mark-handled / .delete-message。 */
function rankCardActions(card) {
  const bar = card.querySelector('.section-actions');
  if (!bar || bar.dataset.v2Ranked) return;
  bar.dataset.v2Ranked = 'true';
  const buttons = [...bar.querySelectorAll(':scope > button')];
  const primary = buttons.find(b => b.classList.contains('manual-reply')) || buttons.find(b => b.classList.contains('mark-handled'));
  for (const b of buttons) {
    if (b === primary) b.classList.remove('secondary');
    else if (b.classList.contains('delete-message')) { b.classList.remove('secondary'); b.classList.add('v2-danger-ghost', 'v2-push-right'); }
    else b.classList.add('secondary');
  }
  if (primary) bar.prepend(primary);
}

function presentMessageCard(card) {
  if (card.dataset.workspacePresented) return;
  card.dataset.workspacePresented = 'true';
  const decision = card.querySelector('.message-decision-detail');
  if (decision) {
    const reply = [...decision.children].find(node => /^(AI回复内容|平台回复内容)：/.test(node.textContent.trim()));
    if (reply) {
      reply.classList.add('ws-message-reply');
      decision.before(reply);
    }
    retainDetails(card, '.message-decision-detail', '处理详情', 'ws-message-audit');
  }
}

function privateKey(message, index) {
  const context = message?.context || {};
  const conversation = context.conversationId || context.conversation_id || context.chatId || context.threadId;
  const user = message?.user_id || message?.external_user_id || context.userId || context.senderId;
  const account = `${message?.platform_code || ''}:${message?.account_id || ''}`;
  return `${account}:${conversation ? `conversation:${conversation}` : user ? `user:${user}` : `message:${message?.id ?? index}`}`;
}

function presentPrivateMessages(root, options) {
  const list = root.querySelector('.private-message-list');
  if (!list || list.closest('.ws-private-shell')) return;
  const cards = [...list.querySelectorAll(':scope > .private-item')];
  if (!cards.length) return;
  const messages = Array.isArray(options.privateMessages) ? options.privateMessages : Array.isArray(options.messages) ? options.messages.filter(message => message.message_type === 'PRIVATE_MESSAGE') : [];
  const byId = new Map(messages.map(message => [String(message.id), message]));
  const groups = new Map();
  cards.forEach((card, index) => {
    const id = card.querySelector('.delete-message[data-id]')?.dataset.id;
    const message = byId.get(id);
    const key = message ? privateKey(message, index) : `message:${id || index}`;
    if (!groups.has(key)) groups.set(key, {
      key, name: message?.user_name || card.querySelector('.interaction-head b')?.textContent || '未知用户',
      preview: message?.content || card.querySelector('.private-content p')?.textContent || '',
      time: card.querySelector('.interaction-head time')?.textContent || '', cards: []
    });
    groups.get(key).cards.push(card);
  });
  const shell = element('div', 'ws-private-shell');
  const sidebar = element('aside', 'ws-private-sidebar');
  sidebar.setAttribute('aria-label', '私信会话');
  const search = element('input', 'ws-private-search');
  search.type = 'search'; search.placeholder = '搜索会话'; search.setAttribute('aria-label', '搜索私信会话');
  const navigation = element('nav', 'ws-private-conversations');
  navigation.setAttribute('aria-label', '选择私信会话');
  const empty = element('p', 'ws-private-search-empty', '没有匹配的会话');
  empty.hidden = true;
  sidebar.append(search, navigation, empty);
  const main = element('section', 'ws-private-main');
  const header = element('header', 'ws-private-heading');
  const heading = element('b');
  const count = element('span');
  header.append(heading, count);
  main.append(header);
  list.before(shell); shell.append(sidebar, main); main.append(list);
  const account = String(options.messageAccountId ?? '');
  const previous = privateSelection.get(root);
  let selected = previous?.account === account && (previous.key === 'all' || groups.has(previous.key)) ? previous.key : groups.keys().next().value;
  const buttons = new Map();
  const select = key => {
    selected = key;
    privateSelection.set(root, { account, key });
    for (const [groupKey, group] of groups) for (const card of group.cards) card.hidden = key !== 'all' && key !== groupKey;
    for (const [groupKey, button] of buttons) {
      const active = groupKey === key;
      button.classList.toggle('active', active);
      button.setAttribute('aria-current', active ? 'true' : 'false');
    }
    heading.textContent = key === 'all' ? '全部私信' : groups.get(key).name;
    count.textContent = `${key === 'all' ? cards.length : groups.get(key).cards.length} 条消息`;
  };
  for (const group of [{ key: 'all', name: '全部私信', preview: `${cards.length} 条消息`, time: '' }, ...groups.values()]) {
    const button = element('button', 'ws-private-conversation');
    button.type = 'button'; button.dataset.privateConversation = group.key;
    const avatar = element('span', 'ws-private-avatar', String(group.name).slice(0, 1));
    const copy = element('span', 'ws-private-copy');
    copy.append(element('b', '', group.name), element('small', '', String(group.preview).slice(0, 70)), element('time', '', group.time));
    button.append(avatar, copy);
    button.addEventListener('click', () => select(group.key));
    navigation.append(button); buttons.set(group.key, button);
  }
  search.addEventListener('input', () => {
    const query = search.value.trim().toLocaleLowerCase();
    for (const button of buttons.values()) button.hidden = Boolean(query) && !button.textContent.toLocaleLowerCase().includes(query);
    empty.hidden = [...buttons.values()].some(button => !button.hidden);
  });
  select(selected);
}

/* ---------- 评论三栏收件箱：左侧筛选 / 中间按帖子分组的原列表 / 右侧详情 ----------
   中间列保留 app.js 生成的分组、展开与未读逻辑；右侧详情由接口数据渲染，
   操作按钮只转发点击到原卡片上的按钮，不复制任何业务逻辑。 */
let selectedCommentId = null;
let commentFilter = 'all';
const PENDING_STATUSES = ['MANUAL_REQUIRED', 'KNOWLEDGE_GAP', 'AI_REPLY_TIMEOUT'];
function commentCategory(message) {
  if (!message) return 'other';
  if (message.reply_status?.manual?.replied || message.status === 'MANUAL_HANDLED' || message.handled_at) return 'manual';
  if (message.reply_status?.ai?.replied || message.reply_status?.platform?.replied) return 'ai';
  if (PENDING_STATUSES.includes(message.status) || PENDING_STATUSES.includes(message.decision)) return 'pending';
  return 'other';
}
const COMMENT_FILTERS = [['pending', '待处理', 'warn'], ['ai', 'AI 已回复', 'ok'], ['manual', '人工已处理', 'muted'], ['all', '全部', 'all']];
function cardMessageId(card) { return card.querySelector('[data-id]')?.dataset.id || ''; }
function shortStamp(value) {
  const d = new Date(value); if (Number.isNaN(d.getTime())) return '';
  const p = n => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function renderCommentDetail(detail, message, card, group) {
  detail.replaceChildren();
  if (!message || !card) {
    detail.append(element('p', 'v2-empty', '在中间列表展开帖子，点选一条评论查看详情和处理。'));
    return;
  }
  const ctx = element('div', 'v2-inbox-context');
  ctx.innerHTML = platformLogo(message.platform_code, 34);
  const ctxCopy = element('div', 'v2-inbox-context-copy');
  ctxCopy.append(element('b', '', group?.querySelector('.comment-post-title')?.textContent || message.post?.title || '未识别关联帖子'));
  const meta = element('small'); meta.append(element('span', '', message.platform_name || ''), element('span', '', message.account_name || ''));
  ctxCopy.append(meta); ctx.append(ctxCopy);
  const openPost = group?.querySelector('.comment-post-meta .open-message');
  if (openPost) { const b = element('button', 'btn secondary', '查看原帖'); b.type = 'button'; b.onclick = () => openPost.click(); ctx.append(b); }
  const bubble = element('div', 'v2-bubble');
  bubble.append(element('span', 'v2-avatar', String(message.user_name || '?').trim().slice(0, 1) || '?'));
  const body = element('div', 'v2-bubble-body');
  const who = element('small'); who.append(element('span', '', message.user_name || '未知用户'), element('span', 'v2-num', shortStamp(message.collected_at || message.created_at)));
  body.append(who, element('p', '', message.content || ''));
  bubble.append(body);
  const status = element('div', 'v2-detail-status');
  const statusRow = card.querySelector('.reply-status-row');
  if (statusRow) status.append(statusRow.cloneNode(true));
  detail.append(ctx, bubble, status);
  const category = commentCategory(message);
  if (message.reply_text) {
    const reply = element('div', 'v2-suggest');
    const sent = category === 'ai' || category === 'manual';
    const hd = element('div', 'v2-suggest-head', sent ? (message.reply_status?.platform?.replied ? '平台上的回复' : '已发送的回复') : 'AI 拟回复（未发送）');
    if (message.confidence !== null && message.confidence !== undefined && message.confidence !== '') {
      const conf = Number(message.confidence); const pct = conf <= 1 ? Math.round(conf * 100) : Math.round(conf);
      const c = element('span', 'v2-confidence'); c.innerHTML = `匹配度 <b class="v2-num">${pct}%</b><i><b style="width:${Math.max(0, Math.min(100, pct))}%"></b></i>`; hd.append(c);
    }
    reply.append(hd, element('p', '', message.reply_text));
    if (message.knowledge_id) reply.append(element('small', 'v2-suggest-source', `依据知识 #${message.knowledge_id}`));
    detail.append(reply);
  }
  if (category === 'pending') {
    const reason = card.querySelector('.message-decision-detail .wide');
    detail.append(element('div', 'v2-risk', reason ? reason.textContent : '需要人工判断后处理。'));
  }
  const audit = card.querySelector('.message-decision-detail');
  if (audit) { const d = disclosure('v2-detail-audit', '处理详情'); d.append(audit.cloneNode(true)); detail.append(d); }
  const actions = element('div', 'v2-detail-actions');
  const originals = [...card.querySelectorAll('.section-actions button')];
  // 主操作：能直接回复时是“人工回复”，否则是“人工已处理”
  const primary = originals.find(b => b.classList.contains('manual-reply')) || originals.find(b => b.classList.contains('mark-handled'));
  for (const original of originals) {
    // 只保留外观类名：app.js 会按 .mark-handled 等类名重新绑定事件，代理按钮不能被它误绑。
    const look = [...original.classList].filter(name => ['btn', 'secondary', 'danger'].includes(name)).join(' ');
    const proxy = element('button', `${look || 'btn'} v2-proxy`, original.textContent);
    proxy.type = 'button'; proxy.disabled = original.disabled; if (original.title) proxy.title = original.title;
    proxy.onclick = () => original.click();
    if (original === primary) proxy.classList.remove('secondary');
    else if (!proxy.classList.contains('secondary')) proxy.classList.add('secondary');
    if (original.classList.contains('delete-message')) { proxy.classList.remove('secondary'); proxy.classList.add('v2-danger-ghost', 'v2-push-right'); }
    actions.append(proxy);
  }
  if (primary) { const first = [...actions.children].find(b => b.textContent === primary.textContent); if (first) actions.prepend(first); }
  detail.append(actions);
}
function presentCommentInbox(root, options) {
  const page = root.querySelector('.message-ops-page.channel-comments');
  const list = page?.querySelector('.interaction-list');
  if (!list || list.closest('.v2-inbox')) return;
  const messages = (Array.isArray(options.messages) ? options.messages : []).filter(m => m.message_type === 'COMMENT');
  const byId = new Map(messages.map(m => [String(m.id), m]));
  const inbox = element('div', 'v2-inbox');
  const filters = element('aside', 'v2-inbox-filter'); filters.setAttribute('aria-label', '评论筛选');
  const middle = element('section', 'v2-inbox-list'); middle.setAttribute('aria-label', '按帖子分组的评论');
  const detail = element('section', 'v2-inbox-detail'); detail.setAttribute('aria-label', '评论详情');
  list.before(inbox); middle.append(list); inbox.append(filters, middle, detail);
  const cards = [...list.querySelectorAll('.comment-item')];
  const counts = { all: messages.length, pending: 0, ai: 0, manual: 0, other: 0 };
  for (const m of messages) counts[commentCategory(m)] += 1;
  filters.append(element('div', 'v2-filter-caption', '状态'));
  const buttons = new Map();
  const apply = () => {
    for (const card of cards) {
      const m = byId.get(cardMessageId(card));
      card.classList.toggle('v2-filtered-out', commentFilter !== 'all' && commentCategory(m) !== commentFilter);
    }
    for (const group of list.querySelectorAll('.comment-post-group')) {
      const visible = [...group.querySelectorAll('.comment-item')].some(card => !card.classList.contains('v2-filtered-out'));
      group.classList.toggle('v2-filtered-out', !visible);
    }
    for (const [key, b] of buttons) { b.classList.toggle('active', key === commentFilter); b.setAttribute('aria-pressed', String(key === commentFilter)); }
  };
  for (const [key, label, tone] of COMMENT_FILTERS) {
    const b = element('button', `v2-filter v2-filter-${tone}`); b.type = 'button';
    b.append(element('i'), element('span', '', label), element('em', 'v2-num', String(counts[key] || 0)));
    b.onclick = () => { commentFilter = key; apply(); };
    filters.append(b); buttons.set(key, b);
  }
  const select = (id, { reveal = false } = {}) => {
    selectedCommentId = id;
    const card = cards.find(c => cardMessageId(c) === String(id));
    for (const c of cards) c.classList.toggle('is-selected', c === card);
    const group = card?.closest('.comment-post-group');
    if (reveal && group && !group.open) group.open = true;
    renderCommentDetail(detail, byId.get(String(id)), card, group);
  };
  for (const card of cards) {
    card.tabIndex = 0;
    card.addEventListener('click', event => { if (event.target.closest('button,a,summary,details.ws-message-audit')) return; select(cardMessageId(card)); });
    card.addEventListener('keydown', event => { if ((event.key === 'Enter' || event.key === ' ') && event.target === card) { event.preventDefault(); select(cardMessageId(card)); } });
  }
  const fallback = messages.find(m => commentCategory(m) === 'pending') || messages[0];
  const initial = selectedCommentId && byId.has(String(selectedCommentId)) ? selectedCommentId : fallback?.id;
  apply();
  select(initial ?? null);
}

function presentMessages(root, options) {
  const page = root.querySelector('.message-ops-page');
  if (!page) return;
  page.classList.add('ws-interactions');
  const workbench = page.querySelector('.message-workbench');
  if (workbench && !page.querySelector('.ws-collection-details')) {
    const details = disclosure('ws-collection-details', '采集状态与设置');
    workbench.querySelector('.message-toolbar')?.after(details);
    const poll = workbench.querySelector('#messagePollInterval')?.closest('label');
    if (poll) details.append(poll);
    for (const selector of ['.message-command-center', '.message-poll-meta', '.message-channel-poll-grid', '.interaction-tabs']) {
      const node = page.querySelector(selector);
      if (node) details.append(node);
    }
  }
  page.querySelectorAll('.interaction-card').forEach(presentMessageCard);
  page.querySelectorAll('.interaction-card').forEach(rankCardActions);
  if (options.messageView !== 'PRIVATE_MESSAGE' && page.classList.contains('channel-comments')) presentCommentInbox(root, options);
  if (options.messageView === 'PRIVATE_MESSAGE' || page.classList.contains('channel-private')) presentPrivateMessages(root, options);
}

function presentTasks(root, options) {
  const panel = root.querySelector('.task-center-panel');
  if (!panel) return;
  panel.classList.add('ws-tasks');
  retainDetails(panel, ':scope > .task-command-center, :scope > .task-platform-context', '任务概况', 'ws-task-overview');
  const tasks = new Map((options.tasks || []).map(task => [String(task.id), task]));
  for (const card of panel.querySelectorAll('.task-stream-card')) {
    if (card.closest('.ws-task-row')) continue;
    const details = disclosure('ws-task-row', '');
    const summary = details.firstElementChild;
    summary.className = 'ws-task-summary';
    const title = card.querySelector('h3');
    const time = card.querySelector('.task-publish-time');
    const status = card.querySelector('.compact-task-meta .badge');
    const id = card.querySelector('[data-delete-task]')?.dataset.deleteTask;
    const task = tasks.get(id);
    const platforms = task?.targets?.map(target => target.platform_name || platformNames[target.platform_code] || target.platform_code).filter(Boolean);
    const names = platforms?.length ? [...new Set(platforms)] : [...card.querySelectorAll('.task-target-detail > b')].map(node => node.textContent.split(' · ')[0]);
    const subject = element('span', 'ws-task-subject');
    if (title) subject.append(title);
    subject.append(element('small', '', id ? `任务 #${id}` : ''));
    summary.append(subject, element('span', 'ws-task-platform', names.join('、') || '—'));
    if (time) summary.append(time);
    const state = element('span', 'ws-task-state');
    if (status) state.append(status);
    summary.append(state, element('span', 'ws-task-expand', '详情'));
    card.before(details); details.append(card);
  }
}

function presentPlatforms(root) {
  const grid = root.querySelector('.platform-runtime-grid');
  if (!grid) return;
  root.classList.add('ws-platforms');
  for (const notice of root.querySelectorAll(':scope > .notice')) {
    if (notice.closest('details')) continue;
    const details = disclosure('ws-platform-notice', notice.querySelector('b')?.textContent || '运行说明');
    notice.before(details); details.append(notice);
  }
  const panel = root.querySelector('.platform-runtime-panel');
  if (panel) retainDetails(panel, ':scope > .panel-head', '批量管理', 'ws-platform-bulk');
  for (const card of grid.querySelectorAll(':scope > .platform-runtime-card')) {
    const head = card.querySelector('.platform-runtime-heading > div');
    const code = card.querySelector('[data-platform]')?.dataset.platform;
    if (head && code && !head.querySelector('.v2-logo')) { head.classList.add('v2-has-logo'); head.insertAdjacentHTML('afterbegin', platformLogo(code, 40)); }
    if (card.dataset.workspacePresented || card.classList.contains('is-planned')) continue;
    card.dataset.workspacePresented = 'true';
    const heading = card.querySelector('.platform-runtime-heading');
    const toggle = heading?.querySelector('.platform-runtime-toggle');
    const smart = card.querySelector('.smart-reply-control');
    const login = card.querySelector('.platform-login-action')?.parentElement;
    const account = card.querySelector(':scope > .muted');
    const details = disclosure('ws-platform-maintenance', '更多管理');
    if (account) {
      const name = account.textContent.split(' · Profile')[0];
      const label = element('p', 'ws-platform-account', name);
      heading?.after(label);
    }
    if (toggle) {
      const row = element('div', 'ws-platform-setting');
      row.append(element('span', '', '平台运行'), toggle);
      (card.querySelector('.ws-platform-account') || heading).after(row);
    }
    if (smart) card.querySelector('.ws-platform-setting')?.after(smart);
    if (login) {
      login.classList.add('ws-platform-login');
      const badge = login.querySelector('.badge');
      if (badge) heading?.append(badge);
      if (smart) smart.after(login);
    }
    const keep = new Set([heading, card.querySelector('.ws-platform-account'), card.querySelector('.ws-platform-setting'), smart, login]);
    for (const child of [...card.children]) if (!keep.has(child)) details.append(child);
    card.append(details);
  }
}

function presentMiniProgram(root) {
  const page = root.querySelector('.mini-program-page');
  if (!page || page.classList.contains('ws-mini')) return;
  page.classList.add('ws-mini');
  const toolbar = element('div', 'ws-mini-toolbar');
  const status = page.querySelector('#miniLinkState');
  const refresh = page.querySelector('.mini-program-refresh');
  if (status) toolbar.append(status);
  if (refresh) toolbar.append(refresh);
  const settings = disclosure('ws-mini-settings', '连接与运行设置');
  for (const node of [page.querySelector('.mini-link-card'), page.querySelector('.mini-program-summary')]) if (node) settings.append(node);
  page.prepend(toolbar, settings);
  const conversationId = page.querySelector('.mini-program-detail-head .mini-program-id');
  if (conversationId) {
    const details = disclosure('ws-mini-conversation-meta', '会话详情');
    conversationId.before(details); details.append(conversationId);
  }
  for (const message of page.querySelectorAll('.mini-program-message')) {
    retainDetails(message, '.mini-program-message-meta, .mini-program-delivery-grid', '处理与送达详情', 'ws-mini-delivery');
    const messageId = message.querySelector(':scope > header > span');
    if (messageId) message.querySelector('.ws-mini-delivery')?.append(messageId);
  }
}

function presentReplyTest(root) {
  const page = root.querySelector('.xiaozhi-page');
  if (!page || page.classList.contains('ws-reply-test')) return;
  page.classList.add('ws-reply-test');
  const toolbar = page.querySelector('.xiaozhi-toolbar');
  const chat = page.querySelector('.xiaozhi-chat');
  if (!toolbar || !chat) return;
  const layout = element('div', 'ws-test-layout');
  const settings = element('aside', 'ws-test-settings');
  settings.setAttribute('aria-label', '测试资料与设置');
  settings.append(element('h3', '', '测试资料与设置'));
  const controls = toolbar.querySelector('.xiaozhi-settings');
  if (controls) settings.append(controls);
  const note = toolbar.querySelector('.xiaozhi-scope-note');
  if (note) {
    const details = disclosure('ws-test-note', '知识范围说明');
    details.append(note); settings.append(details);
  }
  toolbar.after(layout); layout.append(chat, settings);
  retainDetails(chat, '.xiaozhi-footnote', '测试详情', 'ws-test-details');
  const explanation = chat.querySelector('.xiaozhi-empty p');
  if (explanation) chat.querySelector('.ws-test-details')?.append(explanation);
}

export function applyInteractionPresentation(root, options = {}) {
  if (!root?.querySelector) return;
  root.classList.toggle('ws-platforms', options.page === 'platforms');
  if (options.page === 'messages') presentMessages(root, options);
  if (options.page === 'tasks') presentTasks(root, options);
  if (options.page === 'platforms') presentPlatforms(root);
  if (options.page === 'miniProgram') presentMiniProgram(root);
  if (options.page === 'xiaozhi') presentReplyTest(root);
}
