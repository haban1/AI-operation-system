const MAX_RUNTIME_MS = 25000;
const PAGE_SETTLE_MS = 5000;
const DAY = 86400000;
const CHINA_OFFSET = 8 * 3600000;
const NAVIGATION_LABELS = ['数据概览', '数据中心', '首页', '视频数据', '粉丝数据'];
const DOUYIN_SELF_PATHS = new Set(['/aweme/v1/creator/pc/user/info/', '/aweme/v1/creator/user/info/', '/web/api/media/user/info/']);
const LABELS = {
  plays: ['播放量', '播放次数', '观看次数', '视频播放', '视频播放量', '总播放量', '累计播放量', '播放总量', '新增播放'],
  impressions: ['曝光量', '曝光次数', '总曝光量', '内容曝光量', '曝光'],
  followersTotal: ['粉丝总数', '总粉丝数', '总粉丝量', '总粉丝', '粉丝总量', '累计粉丝', '累计粉丝数', '粉丝量', '粉丝数', '粉丝人数', '粉丝', '关注者'],
  newFollowers: ['新增粉丝', '新增粉丝数', '新增关注', '新增关注数', '新增关注人数', '涨粉量', '涨粉人数'],
  netFollowers: ['净增粉丝', '净增粉丝数', '净增关注', '粉丝净增', '粉丝净增长'],
  likes: ['总点赞量', '总点赞数', '点赞量', '点赞数', '获赞数', '获赞量', '总获赞', '获赞', '点赞'],
  comments: ['总评论量', '总评论数', '评论量', '评论数', '评论', '新增评论'],
  shares: ['总分享量', '总分享数', '分享量', '分享数', '转发量', '转发数', '分享', '转发'],
  reads: ['阅读量', '阅读次数', '阅读数', '总阅读量', '阅读'],
};
const keyByLabel = new Map(Object.entries(LABELS).flatMap(([key, labels]) => labels.map(label => [label, key])));
const clean = (value, limit = 1000) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, limit) : '';
const fail = (code, message) => Object.assign(new Error(message), { code });

function labelKey(value) {
  return keyByLabel.get(clean(value, 80).replace(/[（(](?:次|人|个|位|万|千|亿)[）)]/g, '')
    .replace(/^(?:今日|今天|昨日|昨天|(?:近|最近|过去)\s*(?:7|30)\s*[天日])\s*/, '')
    .replace(/[：:]$/, '').trim());
}

function readNumber(rawValue, key) {
  const raw = clean(rawValue, 80).replace(/，/g, ',');
  const match = /^([+-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)\s*(千|万|亿|[kKwWmM])?\s*(?:次|人|个|位)?$/.exec(raw);
  if (!match) return null;
  const multiplier = { 千: 1000, 万: 10000, 亿: 100000000, k: 1000, w: 10000, m: 1000000 }[match[2]?.toLowerCase()] || 1;
  const scaled = Number(match[1].replaceAll(',', '')) * multiplier;
  const value = Math.round(scaled);
  if (Math.abs(scaled - value) > 0.000001 || !Number.isSafeInteger(value) || (value < 0 && key !== 'netFollowers') || (raw.startsWith('+') && key !== 'netFollowers')) return null;
  return { value, rawValue: clean(rawValue, 80), ...(match[2] ? { approximate: true } : {}) };
}

function periodFromText(value, capturedAt) {
  const source = clean(value, 500);
  const now = Date.parse(capturedAt);
  if (!source || !Number.isFinite(now)) return null;
  const today = Math.floor((now + CHINA_OFFSET) / DAY) * DAY - CHINA_OFFSET;
  const found = [];
  const add = (start, end) => {
    if (Number.isFinite(start) && Number.isFinite(end) && start <= end && start <= now && end <= now + DAY) {
      found.push({ periodStart: new Date(start).toISOString(), periodEnd: new Date(Math.min(end, now)).toISOString() });
    }
  };
  for (const match of source.matchAll(/(20\d{2})[年./-](\d{1,2})[月./-](\d{1,2})日?\s*(?:至|到|—|–|~|～|-)\s*(20\d{2})[年./-](\d{1,2})[月./-](\d{1,2})日?/g)) {
    const parts = match.slice(1).map(Number);
    const valid = (year, month, day) => {
      const date = new Date(Date.UTC(year, month - 1, day));
      return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
    };
    if (valid(...parts.slice(0, 3)) && valid(...parts.slice(3))) {
      add(Date.UTC(parts[0], parts[1] - 1, parts[2]) - CHINA_OFFSET, Date.UTC(parts[3], parts[4] - 1, parts[5]) - CHINA_OFFSET + DAY - 1);
    }
  }
  if (/(?:今日|今天)/.test(source) && !/(?:较|比|对比)\s*(?:今日|今天)/.test(source)) add(today, now);
  if (/(?:昨日|昨天)/.test(source) && !/(?:较|比|对比)\s*(?:昨日|昨天)/.test(source)) add(today - DAY, today - 1);
  for (const match of source.matchAll(/(?:近|最近|过去)\s*(7|30)\s*[天日]/g)) add(today - (Number(match[1]) - 1) * DAY, now);
  const unique = [...new Map(found.map(item => [JSON.stringify(item), item])).values()];
  return unique.length === 1 ? unique[0] : null;
}

function explicitPeriodText(value) {
  // A post's publication date or a date mentioned in unrelated page copy is
  // never evidence for the dashboard's reporting window.
  const source = clean(value, 12000);
  return [...new Set([...source.matchAll(/(?:统计周期|统计时间|数据周期|数据时间)\s*[:：]?\s*(20\d{2}[年./-]\d{1,2}[月./-]\d{1,2}日?\s*(?:至|到|—|–|~|～|-)\s*20\d{2}[年./-]\d{1,2}[月./-]\d{1,2}日?)/g)]
    .map(match => match[0]))].join(' ');
}

/** Parse only explicit label/value pairs. Missing, ambiguous and unsupported
 * values stay absent; zero is accepted only when it is actually displayed.
 */
export function parsePlatformAnalyticsCards(cards, { capturedAt = new Date().toISOString(), pageText = '' } = {}) {
  const grouped = new Map(), issues = [];
  const explicitPagePeriod = explicitPeriodText(pageText);
  for (const card of (Array.isArray(cards) ? cards : []).slice(0, 120)) {
    let label = clean(card?.label, 80), rawValue = card?.rawValue;
    if (rawValue === undefined && !labelKey(label)) {
      const text = clean(card?.text || label, 100);
      for (const known of [...keyByLabel.keys()].sort((left, right) => right.length - left.length)) {
        if (!text.startsWith(known)) continue;
        const value = text.slice(known.length).replace(/^\s*[:：]?\s*/, '');
        if (readNumber(value, keyByLabel.get(known))) { label = known; rawValue = value; break; }
      }
    }
    const key = labelKey(label);
    if (!key || /(?:率|占比|环比|同比|涨跌|增幅|较前|较昨|对比)/.test(label)) continue;
    if (/(?:教程|示例|演示|样例|模拟|预估|预测|潜力)/.test(clean(card?.text, 500))) { issues.push(`EXAMPLE_OR_ESTIMATE:${key}`); continue; }
    const number = readNumber(rawValue, key);
    if (!number) { issues.push(`INVALID_NUMBER:${key}`); continue; }
    const incrementalLabel = /^(?:新增播放|新增评论|新增关注|新增粉丝|净增关注|净增粉丝|粉丝净增)/.test(label);
    const period = explicitPagePeriod ? periodFromText(explicitPagePeriod, capturedAt)
      : clean(card?.periodText) ? periodFromText(card.periodText, capturedAt) : periodFromText(label, capturedAt)
        || (incrementalLabel && /(?:^|\s)昨日数据(?:\s|$)/.test(clean(pageText, 12000)) ? periodFromText('昨日', capturedAt) : null);
    if ((['newFollowers', 'netFollowers'].includes(key) || ['新增播放', '新增评论'].includes(label)) && !period) { issues.push(`PERIOD_UNVERIFIED:${key}`); continue; }
    const cumulative = key === 'followersTotal' || /^累计/.test(label) || /^(?:总)?获赞(?:数|量)?$/.test(label);
    const metric = { key, label, ...number, scope: !cumulative && period ? 'PERIOD' : 'SNAPSHOT',
      ...(!cumulative && period ? period : {}), asOf: capturedAt };
    const identity = key;
    if (!grouped.has(identity)) grouped.set(identity, []);
    grouped.get(identity).push(metric);
  }
  const metrics = [];
  for (const values of grouped.values()) {
    if (new Set(values.map(item => JSON.stringify([item.value, item.scope, item.periodStart, item.periodEnd]))).size > 1) { issues.push(`AMBIGUOUS_METRIC:${values[0].key}`); continue; }
    metrics.push(values.find(item => !item.approximate) || values[0]);
  }
  return { metrics: metrics.slice(0, 20), issues: [...new Set(issues)].slice(0, 50) };
}

function allowedUrl(value, hosts, base) {
  try {
    const url = new URL(value, base);
    if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') || !hosts.has(url.hostname.toLowerCase())
        || [...url.searchParams.keys()].some(key => /token|secret|session|cookie|csrf|password|authorization/i.test(key))) return null;
    url.hash = '';
    return url.href;
  } catch { return null; }
}

function trustedAnalyticsPage(platformCode, value) {
  try {
    const url = new URL(value);
    const paths = {
      douyin: { host: 'creator.douyin.com', paths: ['/creator-micro/home', '/creator-micro/data-center/operation'] },
      bilibili: { host: 'member.bilibili.com', paths: ['/platform/home', '/platform/data-up', '/platform/data-up/video', '/platform/data-up/fans'] },
      wechat_channels: { host: 'channels.weixin.qq.com', paths: ['/platform', '/platform/home'] },
    }[platformCode];
    // The management list and social feed are navigation/identity evidence
    // only. Their per-post counters must never become account aggregates.
    return Boolean(paths && url.hostname === paths.host && paths.paths.includes(url.pathname.replace(/\/+$/, ''))
      && ![...url.searchParams.keys()].some(key => /^(?:id|aweme_?id|bvid|aid|cid|vid|oid|item_?id|video_?id|post_?id|work_?id|note_?id|object_?id)$/i.test(key)));
  } catch { return false; }
}

function safeEvidenceText(value) {
  return clean(value, 10000)
    .replace(/(?:Bearer\s+)[A-Za-z0-9._~-]+/gi, '[REDACTED]')
    .replace(/\b(?:access_token|token|csrf|cookie|authorization|password|secret)\s*[:=]\s*[^\s;]+/gi, '[REDACTED]');
}

function compactEvidence(value) {
  const evidence = { ...value, issues: [...new Set(value.issues || [])].slice(0, 20), pages: [...(value.pages || [])]
    .sort((left, right) => Number(right.scopeVerified === true) - Number(left.scopeVerified === true)).slice(0, 2).map(page => ({
    ...page, bodyText: safeEvidenceText(page.bodyText).slice(0, 600),
    links: (page.links || []).slice(0, 8), metrics: (page.metrics || []).map(({ sourceUrl: _sourceUrl, ...metric }) => metric),
  })) };
  while (Buffer.byteLength(JSON.stringify(evidence), 'utf8') > 8192) {
    evidence.truncated = true;
    const body = evidence.pages.find(page => page.bodyText);
    if (body) { body.bodyText = ''; continue; }
    const links = evidence.pages.find(page => page.links.length);
    if (links) { links.links.pop(); continue; }
    const candidates = evidence.pages.find(page => page.identityCandidates?.length);
    if (candidates) { candidates.identityCandidates.pop(); continue; }
    const resources = evidence.pages.find(page => page.accountResourcePaths?.length);
    if (resources) { resources.accountResourcePaths.pop(); continue; }
    if (evidence.accountIdentityResponses?.length) { evidence.accountIdentityResponses.pop(); continue; }
    const metrics = evidence.pages.find(page => page.metrics.length);
    if (metrics) { metrics.metrics.pop(); continue; }
    if (evidence.issues.length) { evidence.issues.pop(); continue; }
    // A platform source URL is bounded separately; this fallback keeps even
    // unusually long configured paths from violating the backend evidence cap.
    return { identityStatus: evidence.identityStatus, truncated: true, issues: ['EVIDENCE_SIZE_LIMIT'] };
  }
  return evidence;
}

function trustedIdentity(value, source) {
  if (!value || typeof value !== 'object') return null;
  const id = clean(value.id || value.platformUserId || value.selfUid || value.mid, 200);
  const name = clean(value.name || value.platformUserName || value.uname, 200);
  if ((!id && !name) || /^(?:登录|未登录|注册|账号|个人中心|创作者中心|我的|首页|用户|未知|unknown)$/i.test(name)) return null;
  return { ...(id ? { id } : {}), ...(name ? { name } : {}), source };
}

async function readSnapshot(page) {
  return page.evaluate(({ labels, navigationLabels }) => {
    const norm = value => String(value || '').replace(/\s+/g, ' ').trim();
    const visible = element => {
      const style = getComputedStyle(element), rect = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) > 0 && rect.width > 0 && rect.height > 0;
    };
    const labelSet = new Set(labels);
    const metricLabel = value => labelSet.has(norm(value).replace(/[（(](?:次|人|个|位|万|千|亿)[）)]/g, '')
      .replace(/^(?:今日|今天|昨日|昨天|(?:近|最近|过去)\s*(?:7|30)\s*[天日])\s*/, '').replace(/[：:]$/, '').trim());
    const numeric = value => /^[+-]?(?:\d{1,3}(?:[,，]\d{3})+|\d+)(?:\.\d+)?\s*(?:千|万|亿|[kKwWmM])?\s*(?:次|人|个|位)?$/.test(norm(value));
    const explicitPeriod = [...new Set([...norm(document.body?.innerText).slice(0, 12000)
      .matchAll(/(?:统计周期|统计时间|数据周期|数据时间)\s*[:：]?\s*(20\d{2}[年./-]\d{1,2}[月./-]\d{1,2}日?\s*(?:至|到|—|–|~|～|-)\s*20\d{2}[年./-]\d{1,2}[月./-]\d{1,2}日?)/g)]
      .map(match => match[0]))].join(' ');
    const cards = [], signatures = new Set();
    const candidates = [...document.querySelectorAll('span,div,p,dt,dd,strong,b,h1,h2,h3,h4,label')].slice(0, 12000);
    const yesterdaySection = candidates.some(element => visible(element) && norm(element.innerText) === '昨日数据');
    const periodText = explicitPeriod || (yesterdaySection ? '昨日数据' : '');
    for (const element of candidates) {
      const label = norm(element.innerText);
      if (label.length > 80 || !visible(element)) continue;
      if (element.closest('tr,article,[class*="feed-item"],[class*="feedItem"],[class*="video-item"],[class*="videoItem"],[class*="post-item"],[class*="postItem"],[data-e2e*="work-item"]')) continue;
      const cardPeriod = explicitPeriod || (/^(?:新增播放|新增评论|新增关注|新增粉丝|净增关注|净增粉丝|粉丝净增)/.test(label) && yesterdaySection ? '昨日数据' : '');
      if (!metricLabel(label)) {
        if ([...labelSet].some(known => label.startsWith(known) && numeric(label.slice(known.length).replace(/^\s*[:：]?\s*/, '')))
            && !signatures.has(`INLINE:${label}`)) {
          cards.push({ text: label, ...(cardPeriod ? { periodText: cardPeriod } : {}) }); signatures.add(`INLINE:${label}`);
        }
        continue;
      }
      for (let container = element.parentElement, depth = 0; container && depth < 3; depth += 1, container = container.parentElement) {
        const text = norm(container.innerText);
        if (text.length > 500) break;
        const numbers = [...container.querySelectorAll('span,div,p,dd,strong,b,[class*="num"],[class*="value"],[class*="count"]')]
          .filter(node => node !== element && visible(node)).map(node => norm(node.innerText)).filter(numeric);
        const unique = [...new Set(numbers)];
        if (unique.length > 1) break;
        if (unique.length === 1) {
          const signature = `${label}:${unique[0]}:${text}`;
          if (!signatures.has(signature)) { cards.push({ label, rawValue: unique[0], text, ...(cardPeriod ? { periodText: cardPeriod } : {}) }); signatures.add(signature); }
          break;
        }
      }
      if (cards.length >= 100) break;
    }
    const links = [], navSeen = new Set();
    for (const element of [...document.querySelectorAll('a,nav *,aside *,[role="menuitem"],[class*="nav"] *,[class*="menu"] *,[class*="sidebar"] *')].slice(0, 6000)) {
      const text = norm(element.innerText);
      if (!navigationLabels.includes(text) || !visible(element)) continue;
      const anchor = element.closest('a');
      const href = anchor?.getAttribute('href') || null;
      const signature = `${text}:${href || ''}`;
      if (navSeen.has(signature)) continue;
      navSeen.add(signature); links.push({ text, href, visible: true,
        navigationScoped: Boolean(element.closest('nav,aside,[role="menu"],[role="menuitem"],[class*="sidebar"],[class*="side-nav"],[class*="sideNav"]')) });
    }
    const identities = [];
    for (const selector of [
      '[data-e2e="account-name"]', '[data-e2e="user-name"]',
      'header .user-name', 'header .user-name-text', 'header [class*="user-info"] [class*="name"]',
      '[class*="header"] [class*="userInfo"] [class*="name"]',
      '.finder-ui-desktop-menu__footer .account-info .name',
    ]) {
      for (const element of document.querySelectorAll(selector)) {
        const name = norm(element.innerText);
        if (name && name.length <= 200 && visible(element)) identities.push({ name, source: `ACCOUNT_HEADER:${selector}` });
      }
    }
    // This matches the existing Weibo adapter's own-account top-bar rule.
    if (location.hostname === 'weibo.com' || location.hostname === 'www.weibo.com') {
      for (const anchor of document.querySelectorAll('a[href^="/u/"][title],a[href^="https://weibo.com/u/"][title]')) {
        const rect = anchor.getBoundingClientRect(), match = (anchor.getAttribute('href') || '').match(/\/u\/(\d+)(?:[/?#]|$)/);
        if (visible(anchor) && rect.y >= 0 && rect.y <= 100 && match) identities.push({ id: match[1], name: norm(anchor.getAttribute('title')), source: 'WEIBO_OWN_PROFILE_TOPBAR' });
      }
    }
    const uniqueIdentities = [...new Map(identities.map(item => [`${item.id || ''}:${item.name || ''}`, item])).values()];
    const identityCandidates = [], candidateSeen = new Set();
    for (const element of [...document.querySelectorAll('[class],[alt],[title]')].slice(0, 6000)) {
      const className = norm(element.getAttribute('class')), alt = norm(element.getAttribute('alt')), title = norm(element.getAttribute('title'));
      if (!/account|user.?info|user.?name|nick|profile/i.test(`${className} ${alt} ${title}`) || !visible(element)) continue;
      const text = norm(element.innerText || title || alt);
      if (!text || text.length > 100) continue;
      const candidate = { text, className: className.slice(0, 120), parentClass: norm(element.parentElement?.getAttribute('class')).slice(0, 120) };
      const signature = JSON.stringify(candidate);
      if (!candidateSeen.has(signature)) { identityCandidates.push(candidate); candidateSeen.add(signature); }
      if (identityCandidates.length >= 8) break;
    }
    const accountResourcePaths = [...new Set(performance.getEntriesByType('resource').flatMap(entry => {
      try { const url = new URL(entry.name, location.href); return url.origin === location.origin && /user|account/i.test(url.pathname) ? [url.pathname.slice(0, 250)] : []; } catch { return []; }
    }))].slice(0, 8);
    return { bodyText: (document.body?.innerText || '').slice(0, 600), cards, links, periodText,
      identityCandidates, accountResourcePaths,
      accountIdentity: uniqueIdentities.length === 1 ? { ...uniqueIdentities[0], verified: true } : null };
  }, { labels: Object.values(LABELS).flat(), navigationLabels: NAVIGATION_LABELS });
}

/** Read analytics in a temporary page in the existing account context. Never
 * use getPage/getChannelPage or navigate a publishing/private/comment page.
 */
export async function collectPlatformAnalytics(adapter, payload = {}, options = {}) {
  const platformCode = clean(adapter?.platformCode, 100);
  const capturedAt = new Date().toISOString();
  const analytics = { schemaVersion: 1, capturedAt, sourceUrl: null, accountIdentity: {}, sourceVerified: false,
    identityVerified: false, metrics: [], evidence: { pages: [], identityStatus: 'UNVERIFIED', issues: [] } };
  const result = message => { analytics.evidence = compactEvidence(analytics.evidence); return { platformCode, analytics, message }; };
  if (!platformCode || platformCode === 'simulated' || (payload.platformCode && payload.platformCode !== platformCode)) {
    return { status: 'FAILED', result: result('当前适配器不支持真实运营数据采集') };
  }
  if (payload.profileName !== undefined && payload.profileName !== null) {
    const expected = clean(payload.profileName, 250);
    const configuredProfile = adapter.profileDir || adapter.config?.profileDir || adapter.options?.profileDir;
    const actual = typeof configuredProfile === 'string' ? configuredProfile.replace(/[\\/]+$/, '').split(/[\\/]/).pop() : '';
    const normalize = value => process.platform === 'win32' ? value.toLowerCase() : value;
    let binding, bindingConfigured = false;
    try {
      const encoded = process.env.PLATFORM_ANALYTICS_PROFILE_BINDINGS;
      if (encoded) {
        if (Buffer.byteLength(encoded, 'utf8') > 4096) throw new Error('Invalid profile bindings');
        const bindings = JSON.parse(encoded);
        if (!bindings || typeof bindings !== 'object' || Array.isArray(bindings)
            || Object.values(bindings).some(value => typeof value !== 'string' || !value.trim() || value.length > 250 || /[\\/]/.test(value))) throw new Error('Invalid profile bindings');
        if (Object.hasOwn(bindings, platformCode)) { binding = bindings[platformCode].trim(); bindingConfigured = true; }
      }
    } catch {
      analytics.evidence.issues.push('ANALYTICS_PROFILE_BINDING_INVALID');
      return { status: 'FAILED', result: result('本地执行器的运营账号 Profile 绑定配置无效，未打开浏览器') };
    }
    // The supervisor intentionally uses short directory names such as douyin.
    // Only its trusted process configuration may bind that directory to the
    // account's logical profile name; never accept a mapping from the job.
    if (!expected || /[\\/]/.test(expected) || !actual || normalize(expected) !== normalize(bindingConfigured ? binding : actual)) {
      analytics.evidence.issues.push('ANALYTICS_PROFILE_MISMATCH');
      return { status: 'FAILED', result: result('采集任务的账号 Profile 与当前适配器实际目录不匹配，未打开浏览器') };
    }
    analytics.evidence.profileBinding = { profileName: expected, verified: true, source: bindingConfigured ? 'TRUSTED_SUPERVISOR_CONFIG' : 'DIRECTORY_BASENAME' };
  }
  const configured = [adapter.spec?.manageUrl, adapter.spec?.checkUrl].filter(value => typeof value === 'string');
  const hosts = new Set(configured.flatMap(value => { try { const url = new URL(value); return url.protocol === 'https:' ? [url.hostname.toLowerCase()] : []; } catch { return []; } }));
  const initialUrl = configured.map(url => allowedUrl(url, hosts)).find(Boolean);
  if (!initialUrl || typeof adapter.ensureContext !== 'function') return { status: 'FAILED', result: result('未配置可验证的站内运营入口') };

  const timeoutMs = Math.max(1, Math.min(MAX_RUNTIME_MS, Number(options.timeoutMs) || MAX_RUNTIME_MS));
  const deadline = Date.now() + timeoutMs;
  let page, timer, expired = false, identity, responseIdentityError;
  const popups = new Set();
  const identityReads = new Set();
  let identityReadCount = 0;
  const rememberIdentity = next => {
    if (!next) return;
    if (identity && ((identity.id && next.id && identity.id !== next.id) || (identity.name && next.name && identity.name !== next.name))) {
      throw fail('ANALYTICS_ACCOUNT_CHANGED', '两个运营页面显示的本人账号身份不一致，未接纳任何运营指标');
    }
    identity = { ...identity, ...next, source: [identity?.source, next.source].filter(Boolean).join(';').slice(0, 500) };
  };
  const checkpoint = async () => {
    if (responseIdentityError) throw responseIdentityError;
    if (expired || Date.now() >= deadline) throw fail('ANALYTICS_TIMEOUT', '运营采集超过总时间限制');
    await adapter.assertRuntimeAllowed?.();
    if (expired || Date.now() >= deadline) throw fail('ANALYTICS_TIMEOUT', '运营采集超过总时间限制');
    if (responseIdentityError) throw responseIdentityError;
  };
  const remaining = () => Math.max(1, Math.min(12000, deadline - Date.now()));
  const parseSnapshot = snapshot => trustedAnalyticsPage(platformCode, page.url())
    ? parsePlatformAnalyticsCards(snapshot.cards, { capturedAt, pageText: clean(snapshot.periodText || snapshot.bodyText, 12000) })
    : { metrics: [], issues: ['ANALYTICS_PAGE_SCOPE_UNVERIFIED'] };
  const observeSelfResponse = response => {
    if (expired || platformCode !== 'douyin' || identityReadCount >= 8) return;
    let path;
    try {
      const url = new URL(response.url());
      if (url.origin !== 'https://creator.douyin.com' || url.username || url.password || !DOUYIN_SELF_PATHS.has(url.pathname)
          || response.request().method() !== 'GET' || !response.ok()) return;
      path = url.pathname;
    } catch { return; }
    identityReadCount += 1;
    const task = (async () => {
      try {
        const body = await response.json();
        if (expired || Date.now() >= deadline || !body || typeof body !== 'object' || Array.isArray(body)) return;
        const object = value => Boolean(value && typeof value === 'object' && !Array.isArray(value));
        const shapes = [['user_info', body.user_info], ['user', body.user], ['data.user', body.data?.user], ['data.user_info', body.data?.user_info]];
        const fieldNames = [...new Set([
          ...Object.keys(body), ...(object(body.data) ? Object.keys(body.data).map(key => `data.${key}`) : []),
          ...shapes.flatMap(([name, value]) => object(value) ? Object.keys(value).map(key => `${name}.${key}`) : []),
        ])].slice(0, 32).map(value => clean(value, 100));
        let recognized = false;
        if (body.status_code === undefined || body.status_code === 0 || body.status_code === '0') {
          for (const [shapeName, value] of shapes) {
            if (!object(value)) continue;
            let rawId = value.id_str ?? value.uid;
            if (rawId === '' && value.uid !== undefined) rawId = value.uid;
            const hasId = rawId !== undefined && rawId !== null;
            const id = typeof rawId === 'string' && rawId.trim().length <= 200 ? clean(rawId, 200)
              : typeof rawId === 'number' && Number.isSafeInteger(rawId) && rawId >= 0 ? String(rawId) : '';
            if (hasId && !id) continue;
            const name = typeof value.nickname === 'string' && value.nickname.length <= 200 ? clean(value.nickname, 200) : '';
            if (!id && !name) continue;
            const observed = trustedIdentity({ ...(id ? { id } : {}), ...(name ? { name } : {}) }, `DOUYIN_SELF_RESPONSE:${path}:${shapeName}`);
            if (!observed) continue;
            rememberIdentity(observed);
            recognized = true;
          }
        }
        if (!recognized) {
          analytics.evidence.accountIdentityResponses ||= [];
          if (analytics.evidence.accountIdentityResponses.length < 3) analytics.evidence.accountIdentityResponses.push({ path, fieldNames });
        }
      } catch (error) {
        if (error?.code === 'ANALYTICS_ACCOUNT_CHANGED') responseIdentityError = error;
      }
    })();
    identityReads.add(task);
    task.finally(() => identityReads.delete(task));
  };
  const run = async () => {
    await checkpoint();
    const context = await adapter.ensureContext();
    await checkpoint();
    page = await context.newPage();
    if (expired) { await page.close().catch(() => {}); throw fail('ANALYTICS_TIMEOUT', '运营采集超过总时间限制'); }
    // Read-only menu entries can open a separate tab. They are not part of the
    // verified navigation flow, so close every popup without reading it.
    page.on?.('popup', popup => {
      popups.add(popup);
      Promise.resolve().then(() => popup.close()).catch(() => {});
    });
    page.on?.('response', observeSelfResponse);
    await checkpoint();
    await page.goto(initialUrl, { waitUntil: 'domcontentloaded', timeout: remaining() });
    await checkpoint();
    if (!allowedUrl(page.url(), hosts)) throw fail('ANALYTICS_URL_REJECTED', '运营页面跳转到未验证的站点或登录入口');
    if (platformCode === 'bilibili' && typeof adapter.auth === 'function') {
      const auth = await adapter.auth();
      rememberIdentity(trustedIdentity(auth, 'BILIBILI_EXISTING_AUTH'));
      await checkpoint();
    }
    const visitedUrls = new Set(), navigationAttempts = new Set();
    for (let visit = 0; visit < 4; visit += 1) {
      await checkpoint();
      // Creator dashboards are client-rendered. Wait only on this temporary
      // page for usable metrics: navigation often renders well before cards.
      // Account for scheduled waits as well as wall time so mocked/no-op waits
      // stay bounded, while every real wait shares the overall deadline.
      const settleDeadline = Math.min(deadline, Date.now() + PAGE_SETTLE_MS);
      let settleBudget = PAGE_SETTLE_MS;
      if (typeof page.waitForTimeout === 'function') {
        const initialWait = Math.max(0, Math.min(800, settleDeadline - Date.now()));
        if (initialWait) await page.waitForTimeout(initialWait);
        settleBudget -= initialWait;
      }
      let snapshot = await readSnapshot(page);
      let parsed = parseSnapshot(snapshot);
      while (!parsed.metrics.length && (trustedAnalyticsPage(platformCode, page.url()) || !snapshot.links?.length)
          && settleBudget > 0 && typeof page.waitForTimeout === 'function') {
        await checkpoint();
        const waitMs = Math.max(0, Math.min(500, settleBudget, settleDeadline - Date.now()));
        if (!waitMs) break;
        await page.waitForTimeout(waitMs);
        settleBudget -= waitMs;
        snapshot = await readSnapshot(page);
        parsed = parseSnapshot(snapshot);
      }
      await checkpoint();
      const sourceUrl = allowedUrl(page.url(), hosts);
      if (!sourceUrl) throw fail('ANALYTICS_URL_REJECTED', '运营页面站点验证失败');
      if (!visitedUrls.has(sourceUrl) && visitedUrls.size >= 3) { analytics.evidence.issues.push('ANALYTICS_ROUTE_LIMIT'); break; }
      visitedUrls.add(sourceUrl);
      if (typeof adapter.readWechatAccountIdentity === 'function') {
        const value = await adapter.readWechatAccountIdentity(page);
        const readIdentity = trustedIdentity(value, clean(value?.source, 300) || 'EXISTING_ACCOUNT_READER');
        rememberIdentity(readIdentity);
        await checkpoint();
      }
      if (snapshot.accountIdentity?.verified === true && clean(snapshot.accountIdentity?.source, 300)) {
        rememberIdentity(trustedIdentity(snapshot.accountIdentity, clean(snapshot.accountIdentity.source, 300)));
      }
      const pageMetrics = parsed.metrics.map(metric => ({ ...metric, sourceUrl }));
      const pageEvidence = { sourceUrl, scopeVerified: trustedAnalyticsPage(platformCode, sourceUrl),
        bodyText: safeEvidenceText(snapshot.bodyText).slice(0, 600), cardsObserved: Array.isArray(snapshot.cards) ? snapshot.cards.length : 0,
        identityCandidates: !identity && Array.isArray(snapshot.identityCandidates) ? snapshot.identityCandidates.slice(0, 8).map(item => ({
          text: safeEvidenceText(item?.text).slice(0, 100), className: safeEvidenceText(item?.className).slice(0, 120), parentClass: safeEvidenceText(item?.parentClass).slice(0, 120),
        })).filter(item => item.text) : [],
        accountResourcePaths: !identity && Array.isArray(snapshot.accountResourcePaths) ? snapshot.accountResourcePaths
          .filter(item => typeof item === 'string' && item.startsWith('/') && !/[?#]|token|secret|session|cookie|csrf|password|authorization/i.test(item)).slice(0, 8).map(item => item.slice(0, 250)) : [],
        metrics: pageMetrics, issues: parsed.issues, links: (Array.isArray(snapshot.links) ? snapshot.links : []).filter(link => link?.visible !== false)
          .map(link => ({ text: clean(link.text || link.label, 60), href: link.href ? allowedUrl(link.href, hosts, sourceUrl) : null })).slice(0, 20) };
      const existingEvidence = analytics.evidence.pages.findIndex(item => item.sourceUrl === sourceUrl);
      if (existingEvidence < 0) analytics.evidence.pages.push(pageEvidence);
      else analytics.evidence.pages[existingEvidence] = pageEvidence;
      analytics.sourceUrl = sourceUrl;
      if (visit === 3) break;
      const navigationLabels = ['douyin', 'bilibili', 'wechat_channels'].includes(platformCode) ? ['首页', ...NAVIGATION_LABELS.filter(label => label !== '首页')] : NAVIGATION_LABELS;
      const links = (Array.isArray(snapshot.links) ? snapshot.links : []).filter(link => link?.visible !== false && navigationLabels.includes(clean(link.text || link.label, 60)))
        .sort((left, right) => navigationLabels.indexOf(clean(left.text || left.label, 60)) - navigationLabels.indexOf(clean(right.text || right.label, 60)));
      let target, menuTarget;
      for (const link of links) {
        const signature = `${sourceUrl}:${clean(link.text || link.label, 60)}:${link.href || ''}`;
        if (navigationAttempts.has(signature) || visitedUrls.size >= 3) continue;
        if (link.href) {
          const url = allowedUrl(link.href, hosts, sourceUrl);
          if (url && !visitedUrls.has(url)) { target = link; break; }
          continue;
        }
        navigationAttempts.add(signature);
        const root = link.navigationScoped === true && typeof page.locator === 'function'
          ? page.locator('nav,aside,[role="menu"],[role="menuitem"],[class*="sidebar"],[class*="side-nav"],[class*="sideNav"]') : page;
        const locator = root.getByText?.(clean(link.text || link.label, 60), { exact: true });
        if (!locator) continue;
        const visible = [];
        for (let index = 0, count = Math.min(await locator.count(), 20); index < count; index += 1) {
          const candidate = locator.nth(index);
          if (await candidate.isVisible().catch(() => false)) visible.push(candidate);
        }
        if (visible.length !== 1) { analytics.evidence.issues.push('ANALYTICS_NAVIGATION_AMBIGUOUS'); continue; }
        target = link; menuTarget = visible[0]; break;
      }
      if (!target) break;
      navigationAttempts.add(`${sourceUrl}:${clean(target.text || target.label, 60)}:${target.href || ''}`);
      await checkpoint();
      if (target.href) await page.goto(allowedUrl(target.href, hosts, sourceUrl), { waitUntil: 'domcontentloaded', timeout: remaining() });
      else {
        await checkpoint();
        await menuTarget.click({ timeout: remaining() });
        await page.waitForLoadState?.('domcontentloaded', { timeout: remaining() }).catch(() => {});
      }
      await checkpoint();
      if (!allowedUrl(page.url(), hosts)) throw fail('ANALYTICS_URL_REJECTED', '数据导航跳转到未验证的站点');
    }
    const grouped = new Map();
    for (const { sourceUrl: _sourceUrl, ...metric } of analytics.evidence.pages.flatMap(item => item.metrics)) {
      const key = metric.key;
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(metric);
    }
    for (const values of grouped.values()) {
      if (new Set(values.map(item => JSON.stringify([item.value, item.scope, item.periodStart, item.periodEnd]))).size > 1) analytics.evidence.issues.push(`AMBIGUOUS_METRIC:${values[0].key}`);
      else analytics.metrics.push(values.find(item => !item.approximate) || values[0]);
    }
    analytics.metrics = analytics.metrics.slice(0, 20);
    const metricPage = [...analytics.evidence.pages].reverse().find(item => item.scopeVerified && item.metrics.length);
    if (metricPage) analytics.sourceUrl = metricPage.sourceUrl;
    if (identityReads.size) {
      let identityTimer;
      try {
        await Promise.race([Promise.allSettled([...identityReads]), new Promise(resolve => {
          identityTimer = setTimeout(resolve, Math.max(0, Math.min(1000, deadline - Date.now())));
        })]);
      } finally { clearTimeout(identityTimer); }
    }
    await checkpoint();
    if (identity) {
      for (const item of analytics.evidence.pages) { delete item.identityCandidates; delete item.accountResourcePaths; }
      analytics.accountIdentity = { ...(identity.id ? { id: identity.id } : {}), ...(identity.name ? { name: identity.name } : {}) };
      analytics.identityVerified = true;
      analytics.evidence.identityStatus = 'VERIFIED'; analytics.evidence.identitySource = identity.source;
    } else analytics.evidence.issues.push('ACCOUNT_IDENTITY_UNVERIFIED');
    await checkpoint();
    analytics.sourceVerified = analytics.identityVerified && analytics.metrics.length > 0;
    return { status: analytics.sourceVerified ? 'SUCCESS' : analytics.metrics.length ? 'PARTIAL_SUCCESS' : 'FAILED',
      result: result(analytics.sourceVerified ? `已读取 ${analytics.metrics.length} 项真实运营指标` : analytics.metrics.length
        ? '已观察到运营指标，但本人账号身份未验证，尚不可进入运营统计' : '未读取到可验证的运营指标，保留原页面证据以便校准') };
  };
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => { expired = true; reject(fail('ANALYTICS_TIMEOUT', '运营采集超过总时间限制')); }, timeoutMs); });
  try { return await Promise.race([run(), timeout]); }
  catch (error) {
    analytics.sourceVerified = false;
    analytics.evidence.issues.push(clean(error?.code, 100) || 'ANALYTICS_COLLECTION_FAILED');
    return { status: 'FAILED', result: result(safeEvidenceText(error?.message) || '运营数据采集失败') };
  } finally {
    clearTimeout(timer); expired = true;
    if (page) {
      let cleanupTimer;
      try {
        await Promise.race([Promise.allSettled([page, ...popups].map(item => Promise.resolve().then(() => item.close()))),
          new Promise(resolve => { cleanupTimer = setTimeout(resolve, Math.max(0, Math.min(500, deadline - Date.now()))); })]);
      } finally { clearTimeout(cleanupTimer); }
    }
  }
}
