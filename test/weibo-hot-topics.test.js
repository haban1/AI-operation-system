import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chromium } from 'playwright-core';
import { authorizeWeiboHotTopics, weiboHotTopicsToken, collectWeiboHotTopics, validateWeiboHotPage, normalizeWeiboChart, readWeiboChartDocument,
  WEIBO_HOT_TOPICS_URL, WEIBO_HOT_TOPICS_PATH } from '../agent/weibo-hot-topics.js';

test('derived credential only authorizes the fixed read-only route', () => {
  const token = weiboHotTopicsToken('shared-secret');
  assert.notEqual(token, 'shared-secret');
  const req = { method: 'GET', url: WEIBO_HOT_TOPICS_PATH, headers: { 'x-signal-token': token } };
  assert.equal(authorizeWeiboHotTopics(req, 'shared-secret'), true);
  for (const delta of [{ method: 'POST' }, { url: '/control/shutdown' }, { url: WEIBO_HOT_TOPICS_PATH + '?url=https://example.com' }, { headers: { 'x-signal-token': 'wrong' } }]) {
    assert.equal(authorizeWeiboHotTopics({ ...req, ...delta }, 'shared-secret'), false);
  }
  assert.equal(authorizeWeiboHotTopics(req, 'rotated-secret'), false);
  assert.equal(authorizeWeiboHotTopics(req, ''), false);
});

const chart = { data: { realtime: [
  { rank: 1, word: '人工智能新进展', num: 12345, privateField: 'must not escape' },
  { rank: 2, word: '验证码技术更新', raw_hot: '2.3万' }, { rank: 3, word: '广告条目', is_ad: 1 }
] }, account: 'must not escape' };

test('returns only chart fields without mistaking hot search titles for challenges', () => {
  const result = normalizeWeiboChart(chart, WEIBO_HOT_TOPICS_URL);
  assert.equal(result.data.realtime.length, 2);
  assert.equal(result.data.realtime[0].num, '12345');
  assert.equal(result.transport, 'logged-in-browser');
  assert.equal(result.browser.page_url, WEIBO_HOT_TOPICS_URL);
  assert.equal(result.browser.recognition, 'browser-session-url');
  assert.equal(JSON.stringify(result).includes('must not escape'), false);
});

test('distinguishes login, challenge, denied and malformed responses', () => {
  for (const [change, code] of [
    [{ url: 'https://passport.weibo.com/login' }, 'WEIBO_LOGIN_REQUIRED'],
    [{ text: '请完成安全验证' }, 'WEIBO_VERIFY_REQUIRED'],
    [{ status: 403, text: 'Forbidden' }, 'WEIBO_ACCESS_DENIED'],
    [{ status: 429, text: 'Too many requests' }, 'WEIBO_ACCESS_DENIED'],
    [{ url: 'https://weibo.com/newlogin?tabtype=search' }, 'WEIBO_LOGIN_REQUIRED'],
    [{ url: 'https://weibo.com.attacker.example/hot/search' }, 'WEIBO_PAGE_UNRECOGNIZED'],
    [{ url: 'https://attacker@weibo.com/hot/search' }, 'WEIBO_PAGE_UNRECOGNIZED'],
    [{ url: 'https://weibo.com/hot/mine' }, 'WEIBO_PAGE_UNRECOGNIZED'],
    [{ url: 'about:blank' }, 'WEIBO_PAGE_UNRECOGNIZED']
  ]) assert.throws(() => validateWeiboHotPage({ status: 200, url: WEIBO_HOT_TOPICS_URL, ...change }), { code });
  assert.throws(() => normalizeWeiboChart({data:{realtime:[]}},WEIBO_HOT_TOPICS_URL),{code:'WEIBO_SCHEMA_CHANGED'});
});

test('uses existing context, closes only its temporary tab on success or failure', async () => {
  for (const fails of [false, true]) {
    let closed = 0, opened = 0, requested;
    const page = { goto: async (url, options) => {
      requested = { url, options };
      if (fails) throw new Error('network error containing sensitive internals');
      return { status: () => 200 };
    }, evaluate: async () => chart, locator: () => ({ first: () => ({ waitFor: async () => {} }) }),
    url: () => WEIBO_HOT_TOPICS_URL, close: async () => { closed++; } };
    const adapter = { ensureContext: async () => ({ newPage: async () => { opened++; return page; } }) };
    if (fails) await assert.rejects(collectWeiboHotTopics(adapter), { code: 'WEIBO_BROWSER_REQUEST_FAILED' });
    else assert.equal((await collectWeiboHotTopics(adapter)).data.realtime.length, 2);
    assert.equal(opened, 1); assert.equal(closed, 1);
    assert.equal(requested.url, WEIBO_HOT_TOPICS_URL);
    assert.equal(requested.options.timeout, 30000);
  }
});

test('DOM adapter reads real row structure, skips pinned and advertised rows, preserves rank gaps', async t => {
  const executablePath = [process.env.CHROME_EXECUTABLE_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    '/usr/bin/google-chrome', '/usr/bin/chromium', chromium.executablePath()].find(p => p && fs.existsSync(p));
  if (!executablePath) return t.skip('Chrome is not installed');
  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    const page = await browser.newPage();
    const row = (rank, title, heat, query='') => `<div class="_item_fixture"><div class="woo-box-flex"><div class="woo-box-item-flex"><div class="_titout_fixture">${rank ? `<div><span class="_ranknum_fixture">${rank}</span></div>` : ''}<a href="https://s.weibo.com/weibo?q=topic${query}">${title}</a></div><div class="_num_fixture"><span>${heat}</span></div></div></div></div>`;
    await page.setContent(row(null,'置顶新闻','')+row(1,'热搜第一条','123456')+row(2,'推广条目','999999','&topic_ad=1')+row(3,'热搜第三条','2.3万')+row(3,'重复第三条','100')+row(4,'隐藏条目','2').replace('class="_item_fixture"','class="_item_fixture" style="display:none"'));
    const result = normalizeWeiboChart(await page.evaluate(readWeiboChartDocument),WEIBO_HOT_TOPICS_URL);
    assert.deepEqual(result.data.realtime.map(x=>[x.rank,x.word,x.num]),[[1,'热搜第一条','123456'],[3,'热搜第三条','2.3万']]);
  } finally { await browser.close(); }
});
