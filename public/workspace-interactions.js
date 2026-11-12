import { platformLogo } from './platform-icons.js?v=20261111-v2';
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

/* ---------- 私信：会话列表 + 消息 ----------
   后台刷新时页面会原位合并（patchBackgroundContent），所以交互不绑定在某一批节点上：
   按钮用 onclick 属性（合并时同步为最新处理器），点击时再从页面上找当前的卡片和最新会话数据。 */
const privateView = { account: '', key: null, groups: new Map(), total: 0 };
function selectPrivateConversation(shell, key) {
  if (!shell) return;
  if (key !== 'all' && !privateView.groups.has(key)) key = 'all';
  privateView.key = key;
  for (const card of shell.querySelectorAll('.private-message-list > .private-item')) card.hidden = key !== 'all' && card.dataset.privateKey !== key;
  for (const button of shell.querySelectorAll('.ws-private-conversation')) {
    const active = button.dataset.privateConversation === key;
    button.classList.toggle('active', active);
    button.setAttribute('aria-current', active ? 'true' : 'false');
  }
  const group = privateView.groups.get(key);
  const heading = shell.querySelector('.ws-private-heading b'), count = shell.querySelector('.ws-private-heading span');
  if (heading) heading.textContent = key === 'all' ? '全部私信' : group?.name || '';
  if (count) count.textContent = `${key === 'all' ? privateView.total : group?.count || 0} 条消息`;
}
function filterPrivateConversations(shell) {
  if (!shell) return;
  const query = shell.querySelector('.ws-private-search')?.value.trim().toLocaleLowerCase() || '';
  const buttons = [...shell.querySelectorAll('.ws-private-conversation')];
  for (const button of buttons) button.hidden = Boolean(query) && !button.textContent.toLocaleLowerCase().includes(query);
  const empty = shell.querySelector('.ws-private-search-empty');
  if (empty) empty.hidden = buttons.some(button => !button.hidden);
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
    card.dataset.privateKey = key;
    if (!groups.has(key)) groups.set(key, {
      key, name: message?.user_name || card.querySelector('.interaction-head b')?.textContent || '未知用户',
      preview: message?.content || card.querySelector('.private-content p')?.textContent || '',
      time: card.querySelector('.interaction-head time')?.textContent || '', count: 0
    });
    groups.get(key).count += 1;
  });
  const shell = element('div', 'ws-private-shell');
  const sidebar = element('aside', 'ws-private-sidebar');
  sidebar.setAttribute('aria-label', '私信会话');
  const search = element('input', 'ws-private-search');
  search.type = 'search'; search.placeholder = '搜索会话'; search.setAttribute('aria-label', '搜索私信会话');
  search.oninput = event => filterPrivateConversations(event.currentTarget.closest('.ws-private-shell'));
  const navigation = element('nav', 'ws-private-conversations');
  navigation.setAttribute('aria-label', '选择私信会话');
  const empty = element('p', 'ws-private-search-empty', '没有匹配的会话');
  empty.hidden = true;
  sidebar.append(search, navigation, empty);
  const main = element('section', 'ws-private-main');
  const header = element('header', 'ws-private-heading');
  header.append(element('b'), element('span'));
  main.append(header);
  list.before(shell); shell.append(sidebar, main); main.append(list);
  const account = String(options.messageAccountId ?? '');
  if (privateView.account !== account) privateView.key = null;
  privateView.account = account; privateView.groups = groups; privateView.total = cards.length;
  for (const group of [{ key: 'all', name: '全部私信', preview: `${cards.length} 条消息`, time: '' }, ...groups.values()]) {
    const button = element('button', 'ws-private-conversation');
    button.type = 'button'; button.dataset.privateConversation = group.key; button.dataset.refreshKey = `conversation:${group.key}`;
    const avatar = element('span', 'ws-private-avatar', String(group.name).slice(0, 1));
    const copy = element('span', 'ws-private-copy');
    copy.append(element('b', '', group.name), element('small', '', String(group.preview).slice(0, 70)), element('time', '', group.time));
    button.append(avatar, copy);
    button.onclick = event => selectPrivateConversation(event.currentTarget.closest('.ws-private-shell'), group.key);
    navigation.append(button);
  }
  selectPrivateConversation(shell, privateView.key && (privateView.key === 'all' || groups.has(privateView.key)) ? privateView.key : groups.keys().next().value);
}

/* ---------- 评论三栏收件箱：左侧筛选 / 中间按帖子分组的原列表 / 右侧详情 ----------
   中间列保留 app.js 生成的分组、展开与未读逻辑；右侧详情由接口数据渲染，
   操作按钮只转发点击到原卡片上的按钮，不复制任何业务逻辑。
   后台刷新原位合并后，点击时再从页面上查找当前节点与最新数据，避免引用已被替换的节点。 */
let selectedCommentId = null;
let commentFilter = 'all';
let latestComments = new Map();
const PENDING_STATUSES = ['MANUAL_REQUIRED', 'KNOWLEDGE_GAP', 'AI_REPLY_TIMEOUT'];
function commentCategory(message) {
  if (!message) return 'other';
  if (message.reply_status?.manual?.replied || message.status === 'MANUAL_HANDLED' || message.handled_at) return 'manual';
  if (message.reply_status?.ai?.replied || message.reply_status?.platform?.replied) return 'ai';
  if (PENDING_STATUSES.includes(message.status) || PENDING_STATUSES.includes(message.decision)) return 'pending';
  return 'other';
}
const COMMENT_FILTERS = [['pending', '待处理', 'warn'], ['ai', 'AI 已回复', 'ok'], ['manual', '人工已处理', 'muted'], ['all', '全部', 'all']];
const ACTION_CLASSES = ['manual-reply', 'detect-manual', 'mark-handled', 'retry-message', 'delete-message', 'open-message'];
function cardMessageId(card) { return card.querySelector('[data-id]')?.dataset.id || ''; }
function liveCommentCard(id) { return [...document.querySelectorAll('#content .comment-item')].find(card => cardMessageId(card) === String(id)); }
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
  const id = String(message.id);
  const ctx = element('div', 'v2-inbox-context');
  ctx.innerHTML = platformLogo(message.platform_code, 34);
  const ctxCopy = element('div', 'v2-inbox-context-copy');
  ctxCopy.append(element('b', '', group?.querySelector('.comment-post-title')?.textContent || message.post?.title || '未识别关联帖子'));
  const meta = element('small'); meta.append(element('span', '', message.platform_name || ''), element('span', '', message.account_name || ''));
  ctxCopy.append(meta); ctx.append(ctxCopy);
  const postKey = group?.dataset.commentPost;
  if (postKey && group.querySelector('.comment-post-meta .open-message')) {
    const b = element('button', 'btn secondary', '查看原帖'); b.type = 'button';
    b.onclick = () => [...document.querySelectorAll('#content details[data-comment-post]')].find(item => item.dataset.commentPost === postKey)?.querySelector('.comment-post-meta .open-message')?.click();
    ctx.append(b);
  }
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
  originals.forEach((original, index) => {
    // 只保留外观类名：app.js 会按 .mark-handled 等类名重新绑定事件，代理按钮不能被它误绑。
    const look = [...original.classList].filter(name => ['btn', 'secondary', 'danger'].includes(name)).join(' ');
    const proxy = element('button', `${look || 'btn'} v2-proxy`, original.textContent);
    proxy.type = 'button'; proxy.disabled = original.disabled; if (original.title) proxy.title = original.title;
    const action = ACTION_CLASSES.find(name => original.classList.contains(name));
    proxy.onclick = () => {
      const live = liveCommentCard(id);
      const target = live && (action ? live.querySelector(`.section-actions .${action}`) : live.querySelectorAll('.section-actions button')[index]);
      target?.click();
    };
    if (original === primary) proxy.classList.remove('secondary');
    else if (!proxy.classList.contains('secondary')) proxy.classList.add('secondary');
    if (original.classList.contains('delete-message')) { proxy.classList.remove('secondary'); proxy.classList.add('v2-danger-ghost', 'v2-push-right'); }
    if (original === primary) actions.prepend(proxy); else actions.append(proxy);
  });
  detail.append(actions);
}
function applyCommentFilter(inbox) {
  if (!inbox) return;
  const list = inbox.querySelector('.v2-inbox-list');
  for (const card of list.querySelectorAll('.comment-item')) {
    const m = latestComments.get(cardMessageId(card));
    card.classList.toggle('v2-filtered-out', commentFilter !== 'all' && commentCategory(m) !== commentFilter);
  }
  for (const group of list.querySelectorAll('.comment-post-group')) {
    const visible = [...group.querySelectorAll('.comment-item')].some(card => !card.classList.contains('v2-filtered-out'));
    group.classList.toggle('v2-filtered-out', !visible);
  }
  for (const b of inbox.querySelectorAll('.v2-filter')) { const on = b.dataset.filter === commentFilter; b.classList.toggle('active', on); b.setAttribute('aria-pressed', String(on)); }
}
function selectComment(inbox, id) {
  if (!inbox) return;
  selectedCommentId = id;
  const cards = [...inbox.querySelectorAll('.v2-inbox-list .comment-item')];
  const card = cards.find(c => cardMessageId(c) === String(id));
  for (const c of cards) c.classList.toggle('is-selected', c === card);
  renderCommentDetail(inbox.querySelector('.v2-inbox-detail'), latestComments.get(String(id)), card, card?.closest('.comment-post-group'));
}
function presentCommentInbox(root, options) {
  const page = root.querySelector('.message-ops-page.channel-comments');
  const list = page?.querySelector('.interaction-list');
  if (!list || list.closest('.v2-inbox')) return;
  const messages = (Array.isArray(options.messages) ? options.messages : []).filter(m => m.message_type === 'COMMENT');
  latestComments = new Map(messages.map(m => [String(m.id), m]));
  const inbox = element('div', 'v2-inbox');
  const filters = element('aside', 'v2-inbox-filter'); filters.setAttribute('aria-label', '评论筛选');
  const middle = element('section', 'v2-inbox-list'); middle.setAttribute('aria-label', '按帖子分组的评论');
  const detail = element('section', 'v2-inbox-detail'); detail.setAttribute('aria-label', '评论详情');
  list.before(inbox); middle.append(list); inbox.append(filters, middle, detail);
  const counts = { all: messages.length, pending: 0, ai: 0, manual: 0, other: 0 };
  for (const m of messages) counts[commentCategory(m)] += 1;
  filters.append(element('div', 'v2-filter-caption', '状态'));
  for (const [key, label, tone] of COMMENT_FILTERS) {
    const b = element('button', `v2-filter v2-filter-${tone}`); b.type = 'button'; b.dataset.filter = key;
    b.append(element('i'), element('span', '', label), element('em', 'v2-num', String(counts[key] || 0)));
    b.onclick = event => { commentFilter = key; applyCommentFilter(event.currentTarget.closest('.v2-inbox')); };
    filters.append(b);
  }
  for (const card of list.querySelectorAll('.comment-item')) card.tabIndex = 0;
  middle.onclick = event => {
    const card = event.target.closest('.comment-item');
    if (!card || event.target.closest('button,a,summary,details.ws-message-audit')) return;
    selectComment(event.currentTarget.closest('.v2-inbox'), cardMessageId(card));
  };
  middle.onkeydown = event => {
    const card = event.target.closest?.('.comment-item');
    if (!card || event.target !== card || (event.key !== 'Enter' && event.key !== ' ')) return;
    event.preventDefault(); selectComment(event.currentTarget.closest('.v2-inbox'), cardMessageId(card));
  };
  const fallback = messages.find(m => commentCategory(m) === 'pending') || messages[0];
  const initial = selectedCommentId && latestComments.has(String(selectedCommentId)) ? selectedCommentId : fallback?.id;
  applyCommentFilter(inbox);
  selectComment(inbox, initial ?? null);
}

/* 问题记录：标题下只显示一句可读的原因，原始报错、关联对象与阻断信息收进“技术详情”；
   “人工已处理”为主按钮。只调整展示，按钮与接口不变。 */
function issueSummary(raw) {
  const text = String(raw || '').replace(/\s+/g, ' ').trim();
  const cut = text.search(/\s+at\s+(?:[\w$.<>]+\s+\(|file:|async\s|node:)/);
  let summary = (cut > 0 ? text.slice(0, cut) : text).replace(/^(?:Error|TypeError|RangeError):\s*/, '').trim();
  if (summary.length > 160) summary = `${summary.slice(0, 160)}…`;
  return summary;
}
function presentIssues(root) {
  for (const card of root.querySelectorAll('.issue-card')) {
    if (card.dataset.v2Issue) continue;
    card.dataset.v2Issue = 'true';
    const paragraphs = [...card.querySelectorAll(':scope > p')];
    const title = paragraphs[0], raw = paragraphs[1], extra = card.querySelector(':scope > .muted');
    const tech = disclosure('v2-issue-tech', '技术详情');
    const summary = element('p', 'v2-issue-summary', issueSummary(raw?.textContent) || '查看技术详情了解原因。');
    if (raw) { raw.classList.add('v2-issue-raw'); tech.append(raw); }
    if (extra) { extra.classList.add('v2-issue-extra'); tech.append(extra); }
    (title || card.querySelector(':scope > .meta'))?.after(summary);
    summary.after(tech);
    const bar = card.querySelector('.section-actions');
    const resolve = bar?.querySelector('.manual-resolve-issue');
    if (resolve) { resolve.classList.remove('secondary'); bar.prepend(resolve); }
  }
}

/* 转人工记录：与评论/私信一致的“状态列 + 明细”结构。左侧计数取自原统计卡片，
   点击只在页面上筛选已加载的行，不请求接口。 */
let handoffFilter = 'all';
function handoffRowState(row) {
  const text = row.lastElementChild?.textContent || '';
  return /成功/.test(text) ? 'sent' : 'retry';
}
function applyHandoffFilter(page) {
  for (const row of page.querySelectorAll('.handoff-table-wrap tbody tr')) row.hidden = handoffFilter !== 'all' && handoffRowState(row) !== handoffFilter;
  for (const b of page.querySelectorAll('.v2-handoff-filter .v2-filter')) { const on = b.dataset.filter === handoffFilter; b.classList.toggle('active', on); b.setAttribute('aria-pressed', String(on)); }
}
function presentHandoffs(root) {
  const page = root.querySelector('.handoff-page');
  if (!page || page.classList.contains('v2-handoffs')) return;
  page.classList.add('v2-handoffs');
  const summary = page.querySelector('.handoff-summary'), table = page.querySelector('.handoff-table-panel');
  const metrics = [...(summary?.querySelectorAll('.handoff-metrics article') || [])].map(item => Number(item.querySelector('b')?.textContent || 0));
  const toolbar = element('div', 'v2-page-toolbar');
  const note = summary?.querySelector('.panel-head p');
  if (note) toolbar.append(element('p', 'v2-page-note', note.textContent));
  const refresh = summary?.querySelector('#refreshHandoffs');
  if (refresh) toolbar.append(refresh);
  const layout = element('div', 'v2-split');
  const aside = element('aside', 'v2-inbox-filter v2-handoff-filter');
  aside.setAttribute('aria-label', '转人工记录筛选');
  aside.append(element('div', 'v2-filter-caption', '企业微信通知'));
  for (const [key, label, tone, value] of [['retry', '通知重试中', 'warn', metrics[2]], ['sent', '已成功通知', 'ok', metrics[1]], ['all', '全部', 'all', metrics[0]]]) {
    const b = element('button', `v2-filter v2-filter-${tone}`); b.type = 'button'; b.dataset.filter = key;
    b.append(element('i'), element('span', '', label), element('em', 'v2-num', String(value ?? 0)));
    b.onclick = event => { handoffFilter = key; applyHandoffFilter(event.currentTarget.closest('.handoff-page')); };
    aside.append(b);
  }
  if (table) { table.classList.add('v2-split-main'); table.querySelector('.panel-head p')?.remove(); }
  layout.append(aside); if (table) layout.append(table);
  summary?.remove();
  page.prepend(toolbar, layout);
  applyHandoffFilter(page);
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
    const platformCell = element('span', 'ws-task-platform');
    const codes = [...new Set((task?.targets || []).map(target => target.platform_code).filter(Boolean))];
    if (codes.length) {
      for (const code of codes) {
        const chip = element('span', 'v2-platform-chip');
        chip.innerHTML = platformLogo(code, 20);
        chip.append(element('span', '', platformNames[code] || code));
        platformCell.append(chip);
      }
    } else platformCell.textContent = names.join('、') || '—';
    summary.append(subject, platformCell);
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
  /* 顶部状态条：用一句话说清运行模式、采集服务和平台数；批量按钮直接显示。
     沿用原 .platform-runtime-page-head 与按钮 ID，按钮只改显示文字，事件不变。 */
  const head = root.querySelector('.platform-runtime-page-head');
  const notices = [...root.querySelectorAll(':scope > .notice')];
  const modeNotice = notices.find(n => /模拟模式|真实账号模式/.test(n.querySelector('b')?.textContent || ''));
  const safetyNotice = notices.find(n => n !== modeNotice);
  if (head && !head.dataset.v2Bar) {
    head.dataset.v2Bar = 'true';
    const modeText = modeNotice?.textContent || '';
    const real = /真实账号模式/.test(modeText), online = /已连接/.test(modeText);
    const status = element('div', 'v2-runtime-status');
    const mode = element('span', `v2-pill v2-pill-${real ? 'ok' : 'warn'}`, real ? '真实账号模式' : '模拟模式');
    mode.title = real ? '会在运营电脑的专用 Chrome 中操作真实平台账号。' : '只用于测试和演示，不会登录或操作真实平台账号。';
    const agent = element('span', `v2-pill v2-pill-${online ? 'ok' : 'warn'}`, online ? '采集服务已连接' : '采集服务未连接');
    agent.title = online ? '运营电脑上的本机采集服务在线，可以打开浏览器登录、采集和发布。' : '运营电脑上的本机采集服务未运行，登录、采集和发布暂时不会执行。';
    status.append(mode, agent);
    const summary = head.querySelector('.runtime-summary');
    const match = summary?.textContent.match(/(\d+)\s*\/\s*(\d+)\s*可执行\s*·\s*(\d+)\s*\/\s*(\d+)\s*已开启/);
    if (summary && match) {
      summary.textContent = `${match[3]} 个平台已开启 · ${match[1]} 个可以执行任务`;
      summary.title = `共 ${match[2]} 个平台。“可以执行任务”指平台已开启且账号已登录。`;
      status.append(summary);
    }
    const actions = root.querySelector('.platform-runtime-panel > .panel-head .button-row');
    if (actions) {
      actions.classList.add('v2-runtime-actions');
      const labels = { enableAllPlatforms: '全部开启', openSelectedPlatforms: '批量打开登录窗口', stopAllPlatforms: '全部停止' };
      for (const button of actions.querySelectorAll('button')) {
        if (labels[button.id]) button.textContent = labels[button.id];
        if (button.dataset.go === 'issues') button.textContent = '查看问题';
      }
      const stop = actions.querySelector('#stopAllPlatforms');
      if (stop) { stop.classList.remove('danger'); stop.classList.add('secondary', 'v2-danger-ghost'); }
    }
    head.replaceChildren(status);
    if (actions) head.append(actions);
    root.querySelector('.platform-runtime-panel > .panel-head')?.setAttribute('hidden', '');
  }
  if ((modeNotice || safetyNotice) && !root.querySelector('.ws-platform-help')) {
    const help = disclosure('ws-platform-help', '使用说明');
    const list = element('div', 'v2-help');
    const loginText = modeNotice?.querySelector('p')?.textContent;
    if (loginText) list.append(element('b', '', '如何登录平台账号'), element('p', '', loginText));
    if (safetyNotice) list.append(element('b', '', '停止平台后会怎样'), element('p', '', '平台停止后不再接任务，不检查登录、不采集，也不会打开浏览器；已经打开的平台浏览器会被关闭。账号停用时同样如此。'));
    help.append(list);
    (head || root.firstElementChild)?.after(help);
    modeNotice?.remove(); safetyNotice?.remove();
  }
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
  // 与评论收件箱一致：左侧“状态”列 / 中间会话列表 / 右侧详情
  const workbench = page.querySelector('.mini-program-workbench');
  const filters = page.querySelector('.mini-program-filters');
  if (workbench && filters) {
    const aside = element('aside', 'v2-inbox-filter ws-mini-filter-column');
    aside.setAttribute('aria-label', '会话筛选');
    aside.append(element('div', 'v2-filter-caption', '状态'), filters);
    workbench.prepend(aside);
    workbench.classList.add('v2-mini-inbox');
  }
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
  if (options.page === 'issues') presentIssues(root);
  if (options.page === 'handoffs') presentHandoffs(root);
}
