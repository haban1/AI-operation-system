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
