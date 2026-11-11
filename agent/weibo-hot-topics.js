import { createHmac, timingSafeEqual } from 'node:crypto';

export const WEIBO_HOT_TOPICS_PATH = '/platforms/weibo/hot-topics';
export const WEIBO_HOT_TOPICS_URL = 'https://weibo.com/hot/search';

// Signal receives a derived, read-only credential, never the general Agent token.
export function weiboHotTopicsToken(sharedToken) {
  return sharedToken ? createHmac('sha256', sharedToken).update('signal:weibo-hot-topics:v1').digest('hex') : '';
}

export function authorizeWeiboHotTopics(req, sharedToken) {
  if (req.method !== 'GET' || req.url !== WEIBO_HOT_TOPICS_PATH || !sharedToken) return false;
  const supplied = Buffer.from(String(req.headers['x-signal-token'] || ''));
  const expected = Buffer.from(weiboHotTopicsToken(sharedToken));
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function failure(code, message) {
  return Object.assign(new Error(message), { code, statusCode: 502 });
}

export function validateWeiboHotPage({ status, url, text = '' }) {
  let parsed;
  try { parsed = new URL(url); } catch { throw failure('WEIBO_PAGE_UNRECOGNIZED', '无法确认微博页面网址，请重新打开微博平台浏览器'); }
  if (['passport.weibo.com', 'visitor.passport.weibo.com'].includes(parsed.hostname) ||
      /\/(?:newlogin|login)(?:[/?#]|$)/i.test(parsed.pathname)) {
    throw failure('WEIBO_LOGIN_REQUIRED', '微博热榜未取得有效登录会话，请在平台账号中重新检查微博登录');
  }
  if (/请.{0,8}(?:安全验证|验证码)|访问频次过高|访问异常|访问受限|verifycode|captcha/i.test(text.slice(0, 12000))) {
    throw failure('WEIBO_VERIFY_REQUIRED', '微博要求安全验证或限制访问，请在微博浏览器中人工处理后重试');
  }
  if (status === 401) throw failure('WEIBO_LOGIN_REQUIRED', '微博登录会话已失效，请在平台账号中重新登录');
  if (status === 403 || status === 429) {
    throw failure('WEIBO_ACCESS_DENIED', `微博官方热搜页面拒绝访问（HTTP ${status}），请检查微博页面是否要求验证`);
  }
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'weibo.com' || parsed.port || parsed.username || parsed.password || parsed.pathname !== '/hot/search') {
    throw failure('WEIBO_PAGE_UNRECOGNIZED', '当前页面不是微博官方热搜榜，已停止采集，请检查微博浏览器');
  }
  if (status !== 200) {
    throw failure('WEIBO_HTTP_ERROR', `微博热榜请求异常（HTTP ${status}），请稍后重试`);
  }
}

export function normalizeWeiboChart(data, pageUrl) {
  if (!Array.isArray(data?.data?.realtime) || !data.data.realtime.length) {
    throw failure('WEIBO_SCHEMA_CHANGED', '微博热榜为空或接口格式已变化，不能确认采集成功');
  }
  // Forward only public chart fields. Never export headers, cookies or page HTML.
  const seen = new Set();
  const realtime = data.data.realtime.slice(0, 60).filter(row => row && typeof row === 'object' &&
    Number.isInteger(row.rank) && row.rank >= 1 && row.rank <= 50 && !row.is_ad).map(row => ({
    word: String(row.word || row.note || '').slice(0, 160),
    num: String(row.num ?? row.raw_hot ?? '').slice(0, 30),
    rank: row.rank, is_ad: false
  })).filter(row => row.word.trim().length >= 2 && !seen.has(row.rank) && seen.add(row.rank));
  if (!realtime.some(row => !row.is_ad)) throw failure('WEIBO_SCHEMA_CHANGED', '微博未返回可用的热搜条目');
  return { data: { realtime }, transport: 'logged-in-browser', collected_at: new Date().toISOString(),
    evidence_url: pageUrl, browser: { platform: 'weibo', page_url: pageUrl, recognition: 'browser-session-url' } };
}

// Runs in the website document; reads only the public, ranked chart rows.
export function readWeiboChartDocument() {
  const realtime = [];
  for (const anchor of document.querySelectorAll('a[href*="s.weibo.com/weibo?"]')) {
    const row = anchor.closest('div[class*="_item_"]');
    if (!row || !row.getClientRects().length) continue;
    const rankText = row.querySelector('[class*="_ranknum_"]')?.textContent?.trim() || '';
    if (!/^\d{1,2}$/.test(rankText)) continue; // unranked promoted/pinned rows
    const url = new URL(anchor.href, location.href);
    if (url.hostname !== 's.weibo.com' || url.pathname !== '/weibo') continue;
    const promotion = url.searchParams.get('topic_ad');
    if ((promotion && promotion !== '0') || row.querySelector('[class*="_ad_"]')) continue;
    realtime.push({ rank: Number(rankText), word: anchor.textContent.trim(),
      num: row.querySelector('[class*="_num_"]')?.textContent?.trim() || '' });
  }
  return { data: { realtime } };
}

export async function collectWeiboHotTopics(adapter) {
  if (typeof adapter?.ensureContext !== 'function') throw failure('WEIBO_BROWSER_UNAVAILABLE', '微博浏览器服务未配置');
  const context = await adapter.ensureContext();
  const page = await context.newPage();
  try {
    // A separate temporary tab reuses the platform profile without navigating
    // comment, message, login or publishing tabs owned by other workflows.
    const response = await page.goto(WEIBO_HOT_TOPICS_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    validateWeiboHotPage({ status: response?.status() || 0, url: page.url() });
    await page.locator('[class*="_ranknum_"]').first().waitFor({ state: 'visible', timeout: 12000 }).catch(() => {});
    const chart = await page.evaluate(readWeiboChartDocument);
    if (!chart?.data?.realtime?.length) {
      const text = await page.locator('body').innerText({ timeout: 3000 }).catch(() => '');
      validateWeiboHotPage({ status: response?.status() || 0, url: page.url(), text: text.slice(0, 12000) });
    }
    validateWeiboHotPage({ status: response?.status() || 0, url: page.url() });
    return normalizeWeiboChart(chart, page.url());
  } catch (error) {
    if (error.code?.startsWith('WEIBO_')) throw error;
    throw failure('WEIBO_BROWSER_REQUEST_FAILED', '微博浏览器读取热榜失败或超时，请检查网络和平台运行状态');
  } finally {
    await page.close().catch(() => {});
  }
}
