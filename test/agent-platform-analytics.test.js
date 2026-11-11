import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chromium } from 'playwright-core';
import { collectPlatformAnalytics, parsePlatformAnalyticsCards } from '../agent/platform-analytics.js';

const capturedAt = '2026-11-02T04:00:00.000Z';
const manageUrl = 'https://creator.douyin.com/creator-micro/data-center/operation';
const contentManageUrl = 'https://creator.douyin.com/creator-micro/content/manage';
const chromePath = [process.env.CHROME_EXECUTABLE_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
].filter(Boolean).find(candidate => fs.existsSync(candidate)) || null;

function parse(cards, options = {}) {
  return parsePlatformAnalyticsCards(cards, { capturedAt, ...options });
}

test('explicit analytics labels retain real zero, raw units and separate metric meanings', () => {
  const { metrics } = parse([
    { label: '播放量', rawValue: '1.2万' },
    { label: '曝光量', rawValue: '12,345' },
    { label: '总粉丝', rawValue: '600' },
    { label: '点赞量', rawValue: '8' },
    { label: '评论量', rawValue: '0' },
    { label: '分享量', rawValue: '5' },
    { label: '阅读量', rawValue: '38' },
    { label: '作品标题', rawValue: '123' },
  ]);
  const byKey = Object.fromEntries(metrics.map(metric => [metric.key, metric]));
  assert.equal(byKey.plays.value, 12000);
  assert.equal(byKey.plays.rawValue, '1.2万');
  assert.equal(byKey.plays.approximate, true);
  assert.equal(byKey.impressions.value, 12345);
  assert.equal(byKey.followersTotal.value, 600);
  assert.equal(byKey.likes.value, 8);
  assert.equal(byKey.comments.value, 0);
  assert.equal(byKey.shares.value, 5);
  assert.equal(byKey.reads.value, 38);
  assert.equal(metrics.length, 7);
  assert.ok(metrics.every(metric => metric.scope === 'SNAPSHOT'));
  assert.ok(metrics.every(metric => metric.asOf === capturedAt));
});

test('Douyin total interaction labels retain their individual meanings and total followers remain a snapshot', () => {
  const { metrics } = parse([
    { label: '总点赞量', rawValue: '12' },
    { label: '总分享量', rawValue: '6' },
    { label: '总评论量', rawValue: '3' },
    { label: '总粉丝量', rawValue: '90' },
  ], { pageText: '统计周期：2026-10-26 至 2026-11-01' });
  const byKey = Object.fromEntries(metrics.map(metric => [metric.key, metric]));
  assert.equal(metrics.length, 4);
  assert.equal(byKey.likes.value, 12);
  assert.equal(byKey.shares.value, 6);
  assert.equal(byKey.comments.value, 3);
  assert.equal(byKey.followersTotal.value, 90);
  for (const key of ['likes', 'shares', 'comments']) {
    assert.equal(byKey[key].scope, 'PERIOD');
    assert.equal(byKey[key].periodStart, '2026-10-25T16:00:00.000Z');
    assert.equal(byKey[key].periodEnd, '2026-11-01T15:59:59.999Z');
  }
  assert.equal(byKey.followersTotal.scope, 'SNAPSHOT');
  assert.equal(byKey.followersTotal.periodStart, undefined);
});

test('video channels accept explicit follower and new interaction labels but reject a bare new count', () => {
  const { metrics } = parse([
    { label: '关注者', rawValue: '1', periodText: '昨日数据' },
    { label: '新增播放', rawValue: '7', periodText: '昨日数据' },
    { label: '新增评论', rawValue: '2', periodText: '昨日数据' },
    { label: '新增', rawValue: '0', periodText: '昨日数据' },
  ]);
  const byKey = Object.fromEntries(metrics.map(metric => [metric.key, metric]));
  assert.equal(metrics.length, 3);
  assert.equal(byKey.followersTotal.value, 1);
  assert.equal(byKey.followersTotal.scope, 'SNAPSHOT');
  assert.equal(byKey.followersTotal.periodStart, undefined);
  assert.equal(byKey.plays.value, 7);
  assert.equal(byKey.comments.value, 2);
  for (const key of ['plays', 'comments']) {
    assert.equal(byKey[key].scope, 'PERIOD');
    assert.equal(byKey[key].periodStart, '2026-10-31T16:00:00.000Z');
    assert.equal(byKey[key].periodEnd, '2026-11-01T15:59:59.999Z');
  }
});

test('new video channels counts require a verified period while an exact inline follower count remains usable', () => {
  const { metrics } = parse([
    { text: '关注者1' },
    { label: '新增播放', rawValue: '7' },
    { label: '新增评论', rawValue: '2' },
    { text: '新增0' },
    { text: '提示关注者99' },
    { text: '关注者999增长' },
  ]);
  assert.deepEqual(metrics.map(metric => metric.key), ['followersTotal']);
  assert.equal(metrics[0].value, 1);
  assert.equal(metrics[0].scope, 'SNAPSHOT');
});

test('dates elsewhere in page text do not turn snapshot metrics into period metrics', () => {
  const { metrics } = parse([
    { label: '点赞量', rawValue: '12' },
    { label: '新增关注', rawValue: '9' },
    { label: '总粉丝', rawValue: '90' },
  ], { pageText: '近期作品：2026-10-26 至 2026-11-01 发布记录；昨天发布的作品' });
  assert.deepEqual(metrics.map(metric => metric.key), ['likes', 'followersTotal']);
  assert.ok(metrics.every(metric => metric.scope === 'SNAPSHOT'));
  assert.ok(metrics.every(metric => metric.periodStart === undefined && metric.periodEnd === undefined));
});

test('percentages, change comparisons, dates, missing values and tutorial examples never become metrics', () => {
  const { metrics } = parse([
    { label: '播放量', rawValue: '12.5%' },
    { label: '曝光量', rawValue: '较昨日增长20%' },
    { label: '总粉丝', rawValue: '2026-11-02' },
    { label: '点赞量', rawValue: '--' },
    { label: '评论量', rawValue: '1/2' },
    { label: '分享量', rawValue: '100', text: '教程示例：分享量100' },
    { label: '阅读量', rawValue: '-9' },
  ]);
  assert.deepEqual(metrics, []);
});

test('different values for one metric are rejected as ambiguous rather than summed', () => {
  const { metrics, issues } = parse([
    { label: '播放量', rawValue: '100', text: '播放量100' },
    { label: '播放量', rawValue: '200', text: '播放量200' },
    { label: '评论量', rawValue: '3' },
    { label: '评论量', rawValue: '3' },
  ]);
  assert.equal(metrics.filter(metric => metric.key === 'plays').length, 0);
  assert.equal(metrics.filter(metric => metric.key === 'comments').length, 1);
  assert.ok(issues.length > 0);
});

test('new followers without an explicit period remain unknown while total followers remain a snapshot', () => {
  const { metrics } = parse([
    { label: '新增关注', rawValue: '15' },
    { label: '净增粉丝', rawValue: '-2' },
    { label: '总粉丝', rawValue: '300' },
  ]);
  assert.deepEqual(metrics.map(metric => metric.key), ['followersTotal']);
  assert.equal(metrics[0].scope, 'SNAPSHOT');
});

test('period follower counts require bounded dates and only net growth accepts a negative value', () => {
  const { metrics } = parse([
    { label: '新增关注', rawValue: '15', periodText: '近7天' },
    { label: '净增粉丝', rawValue: '-3', periodText: '昨日' },
    { label: '点赞量', rawValue: '-2', periodText: '昨日' },
  ]);
  const byKey = Object.fromEntries(metrics.map(metric => [metric.key, metric]));
  assert.equal(byKey.newFollowers.value, 15);
  assert.equal(byKey.netFollowers.value, -3);
  assert.ok(!byKey.likes);
  for (const metric of Object.values(byKey)) {
    assert.equal(metric.scope, 'PERIOD');
    assert.ok(Number.isFinite(Date.parse(metric.periodStart)));
    assert.ok(Number.isFinite(Date.parse(metric.periodEnd)));
    assert.ok(Date.parse(metric.periodStart) < Date.parse(metric.periodEnd));
    assert.ok(Date.parse(metric.periodStart) <= Date.parse(capturedAt));
  }
  assert.ok(Date.parse(byKey.newFollowers.periodEnd) - Date.parse(byKey.newFollowers.periodStart) <= 8 * 86400000);
});

test('a metric key cannot ambiguously represent multiple scopes or periods even when its numeric values match', () => {
  for (const cards of [
    [{ label: '播放量', rawValue: '100' }, { label: '播放量', rawValue: '100', periodText: '今日' }],
    [{ label: '播放量', rawValue: '100', periodText: '今日' }, { label: '播放量', rawValue: '100', periodText: '昨日' }],
    [{ label: '新增关注', rawValue: '10', periodText: '近7天' }, { label: '新增关注', rawValue: '10', periodText: '近30天' }],
  ]) {
    const { metrics, issues } = parse([...cards, { label: '评论量', rawValue: '2' }]);
    assert.deepEqual(metrics.map(metric => metric.key), ['comments']);
    assert.ok(issues.length > 0);
  }
});

function fixture({ platformCode = 'douyin', initialUrl = manageUrl, snapshots = {}, gotoImpl, evaluateImpl, waitImpl, guardImpl, identity, redirectUrl, menuItems = {} } = {}) {
  const calls = { created: 0, closed: 0, guard: 0, contextRequests: 0, navigations: [], menuClicks: [], existingNavigations: 0,
    evaluations: [], waits: [] };
  let currentUrl = 'about:blank';
  const listeners = new Map();
  const defaultSnapshot = { bodyText: '账号数据概览', cards: [{ label: '播放量', rawValue: '123' }], links: [] };
  const page = {
    async goto(url, options = {}) {
      calls.navigations.push({ url, options });
      currentUrl = redirectUrl || url;
      if (gotoImpl) return gotoImpl(url, options);
      return null;
    },
    async evaluate() {
      calls.evaluations.push({ url: currentUrl });
      return evaluateImpl ? evaluateImpl(currentUrl, calls) : snapshots[currentUrl] || defaultSnapshot;
    },
    async waitForTimeout(timeout) {
      calls.waits.push({ url: currentUrl, timeout });
      if (waitImpl) return waitImpl(timeout, currentUrl, calls);
    },
    async waitForLoadState() {},
    on(event, listener) { listeners.set(event, listener); return page; },
    emit(event, value) { listeners.get(event)?.(value); },
    getByText(name, options) {
      assert.equal(options.exact, true);
      const items = menuItems[name] || [];
      return {
        async count() { return items.length; },
        nth(index) {
          return {
            async isVisible() { return items[index]?.visible === true; },
            async click() {
              calls.menuClicks.push(name); currentUrl = items[index].targetUrl;
              await items[index].onClick?.();
            },
          };
        },
      };
    },
    url() { return currentUrl; },
    isClosed() { return calls.closed > 0; },
    async close() { calls.closed += 1; },
  };
  const existingPage = {
    url: () => 'https://creator.douyin.com/publishing-an-existing-draft',
    async goto() { calls.existingNavigations += 1; assert.fail('existing publish/message page must not be navigated'); },
    async close() { assert.fail('existing page must remain open'); },
  };
  const context = {
    pages: () => [existingPage],
    async newPage() { calls.created += 1; return page; },
  };
  const adapter = {
    platformCode,
    spec: { manageUrl: initialUrl, checkUrl: initialUrl },
    async ensureContext() { calls.contextRequests += 1; return context; },
    async assertRuntimeAllowed() { calls.guard += 1; if (guardImpl) await guardImpl(calls); },
    ...(identity ? { readWechatAccountIdentity: async receivedPage => { assert.equal(receivedPage, page); return identity; } } : {}),
  };
  return { adapter, page, context, calls };
}

function accountResponse(body, { url = 'https://creator.douyin.com/aweme/v1/creator/pc/user/info/', method = 'GET', status = 200, jsonImpl } = {}) {
  return { url: () => url, request: () => ({ method: () => method }), status: () => status,
    ok: () => status >= 200 && status < 300, json: jsonImpl || (async () => body) };
}

test('only successful own-account Douyin response endpoints and known user shapes can verify an account', async () => {
  const successes = [
    { body: { user_info: { nickname: '响应本人账号', uid: '12345', token: 'must-not-leak' } }, expectedId: '12345' },
    { body: { user: { nickname: '响应本人账号', uid: 12345, csrf: 'must-not-leak' } }, expectedId: '12345',
      url: 'https://creator.douyin.com/aweme/v1/creator/user/info/' },
    { body: { data: { user: { nickname: '响应本人账号', id_str: '00012345', cookies: 'must-not-leak' } } }, expectedId: '00012345',
      url: 'https://creator.douyin.com/web/api/media/user/info/' },
    { body: { data: { user_info: { nickname: '响应本人账号', id_str: '12345', access_token: 'must-not-leak' } } }, expectedId: '12345' },
  ];
  for (const { body, expectedId, url } of successes) {
    let temporaryPage;
    const { adapter, page } = fixture({ gotoImpl: async () => temporaryPage.emit('response', accountResponse(body, url ? { url } : {})) });
    temporaryPage = page;
    const result = await collectPlatformAnalytics(adapter, {});
    assert.equal(result.status, 'SUCCESS');
    assert.equal(result.result.analytics.identityVerified, true);
    assert.equal(result.result.analytics.sourceVerified, true);
    assert.equal(result.result.analytics.accountIdentity.name, '响应本人账号');
    assert.equal(result.result.analytics.accountIdentity.id, expectedId);
    assert.ok(!JSON.stringify(result).includes('must-not-leak'));
  }
  const rejected = [
    { url: 'https://creator.douyin.com.evil.test/aweme/v1/creator/pc/user/info/' },
    { url: 'https://creator.douyin.com/aweme/v1/creator/pc/other/user/info/' },
    { method: 'POST' },
    { status: 500 },
    { body: { user_info: { nickname: '无效ID账号', uid: Number.MAX_SAFE_INTEGER + 1 } } },
  ];
  for (const { body = { user_info: { nickname: '不可绑定账号', uid: '12345', token: 'must-not-leak' } }, ...responseOptions } of rejected) {
    let temporaryPage;
    const { adapter, page } = fixture({ gotoImpl: async () => temporaryPage.emit('response', accountResponse(body, responseOptions)) });
    temporaryPage = page;
    const result = await collectPlatformAnalytics(adapter, {});
    assert.equal(result.result.analytics.identityVerified, false, JSON.stringify(responseOptions));
    assert.equal(result.result.analytics.sourceVerified, false, JSON.stringify(responseOptions));
    assert.deepEqual(result.result.analytics.accountIdentity, {});
    assert.ok(!JSON.stringify(result).includes('must-not-leak'));
  }
});

test('unknown Douyin self-response shapes record field names only and pending JSON cannot extend the total collection deadline', async () => {
  let temporaryPage;
  const unknown = fixture({ gotoImpl: async () => temporaryPage.emit('response', accountResponse({
    nickname: 'unknown-shape-private-nickname', access_token: 'unknown-shape-secret-value',
    new_shape: { nickname: 'nested-unknown-private-nickname', uid: 'private-id-value' },
    data: { unexpected: 'private-data-value' },
  }, { url: 'https://creator.douyin.com/aweme/v1/creator/pc/user/info/?diagnostic=private-query-value' })) });
  temporaryPage = unknown.page;
  const result = await collectPlatformAnalytics(unknown.adapter, {});
  assert.equal(result.result.analytics.identityVerified, false);
  const diagnostics = result.result.analytics.evidence.accountIdentityResponses;
  assert.ok(diagnostics.length > 0 && diagnostics.length <= 3);
  assert.equal(diagnostics[0].path, '/aweme/v1/creator/pc/user/info/');
  assert.ok(diagnostics[0].fieldNames.some(name => name.includes('new_shape')));
  assert.ok(diagnostics[0].fieldNames.length <= 32);
  assert.ok(diagnostics[0].fieldNames.every(name => typeof name === 'string' && name.length <= 100));
  for (const privateValue of ['unknown-shape-private-nickname', 'unknown-shape-secret-value',
    'nested-unknown-private-nickname', 'private-id-value', 'private-data-value', 'private-query-value']) {
    assert.ok(!JSON.stringify(result).includes(privateValue));
  }
  let pendingPage;
  const pending = fixture({ gotoImpl: async () => pendingPage.emit('response', accountResponse(null, {
    jsonImpl: () => new Promise(() => {}),
  })) });
  pendingPage = pending.page;
  const started = Date.now();
  const timedOut = await collectPlatformAnalytics(pending.adapter, {}, { timeoutMs: 60 });
  assert.equal(timedOut.status, 'FAILED');
  assert.equal(timedOut.result.analytics.identityVerified, false);
  assert.ok(Date.now() - started < 2000);
  assert.equal(pending.calls.closed, 1);
});

test('cumulative labels stay snapshots while period totals keep their range and conflicting cross-page likes are omitted', async () => {
  const pageText = '统计周期：2026-10-26 至 2026-11-01';
  const cumulative = parse([
    { label: '获赞', rawValue: '14', periodText: '近7天' },
    { label: '累计播放量', rawValue: '100', periodText: '近7天' },
    { label: '累计粉丝数', rawValue: '90', periodText: '近7天' },
  ], { pageText });
  assert.equal(cumulative.metrics.length, 3);
  assert.ok(cumulative.metrics.every(metric => metric.scope === 'SNAPSHOT'));
  assert.ok(cumulative.metrics.every(metric => metric.periodStart === undefined && metric.periodEnd === undefined));
  const period = parse([{ label: '总点赞量', rawValue: '14', periodText: '近7天' }], { pageText });
  assert.equal(period.metrics[0].scope, 'PERIOD');
  assert.equal(period.metrics[0].periodStart, '2026-10-25T16:00:00.000Z');
  assert.equal(period.metrics[0].periodEnd, '2026-11-01T15:59:59.999Z');
  const homepageUrl = 'https://creator.douyin.com/creator-micro/home';
  const { adapter } = fixture({ initialUrl: homepageUrl, snapshots: {
    [homepageUrl]: { bodyText: '账号首页', cards: [{ label: '获赞', rawValue: '14' }],
      links: [{ text: '数据中心', href: manageUrl, visible: true }] },
    [manageUrl]: { bodyText: pageText, cards: [{ label: '总点赞量', rawValue: '14' }, { label: '评论量', rawValue: '2' }], links: [] },
  } });
  const result = await collectPlatformAnalytics(adapter, {});
  assert.deepEqual(result.result.analytics.metrics.map(metric => metric.key), ['comments']);
  assert.ok(result.result.analytics.evidence.issues.includes('AMBIGUOUS_METRIC:likes'));
});

test('collector uses and closes one independent page without guessing a logged-in account identity', async () => {
  const { adapter, calls } = fixture();
  const result = await collectPlatformAnalytics(adapter, { accountId: 7, accountName: 'payload label is not evidence',
    platformUserId: 'payload-id-is-not-evidence', platformUserName: 'payload-user-is-not-evidence' });
  assert.ok(['SUCCESS', 'PARTIAL_SUCCESS'].includes(result.status));
  assert.equal(calls.created, 1);
  assert.equal(calls.closed, 1);
  assert.equal(calls.existingNavigations, 0);
  assert.ok(calls.guard >= 2);
  assert.equal(result.result.platformCode, 'douyin');
  const analytics = result.result.analytics;
  assert.equal(analytics.schemaVersion, 1);
  assert.equal(analytics.sourceVerified, false);
  assert.equal(analytics.identityVerified, false);
  assert.notEqual(analytics.accountIdentity?.name, 'payload label is not evidence');
  assert.notEqual(analytics.accountIdentity?.id, 'payload-id-is-not-evidence');
  assert.notEqual(analytics.accountIdentity?.name, 'payload-user-is-not-evidence');
  assert.ok(analytics.metrics.some(metric => metric.key === 'plays' && metric.value === 123));
  assert.ok(calls.navigations.every(call => call.options.timeout > 0 && call.options.timeout <= 25000));
});

test('requested profile binding accepts matching Windows and Linux basenames from supported adapter configurations', async () => {
  for (const configuration of [
    { profileDir: 'C:\\browser-profiles\\douyin-main' },
    { profileDir: 'C:\\browser-profiles\\douyin-main\\' },
    { config: { profileDir: '/var/data/browser-profiles/douyin-main' } },
    { options: { profileDir: '/var/data/browser-profiles/douyin-main/' } },
  ]) {
    const { adapter, calls } = fixture();
    Object.assign(adapter, configuration);
    const payload = { profileName: 'douyin-main', accountId: 7 };
    const originalPayload = structuredClone(payload);
    const result = await collectPlatformAnalytics(adapter, payload);
    assert.ok(['SUCCESS', 'PARTIAL_SUCCESS'].includes(result.status));
    assert.equal(calls.contextRequests, 1);
    assert.equal(calls.created, 1);
    assert.equal(calls.closed, 1);
    assert.deepEqual(payload, originalPayload);
  }
});

test('missing or mismatched profile binding fails before requesting an existing browser context', async () => {
  for (const configuration of [
    {},
    { profileDir: '/var/data/browser-profiles/wrong-account' },
    { config: { profileDir: 'C:\\browser-profiles\\wrong-account' } },
    { options: { profileDir: '/var/data/browser-profiles/wrong-account/' } },
    { profileDir: '/profiles/wrong-account', config: { profileDir: '/profiles/douyin-main' } },
  ]) {
    const { adapter, calls } = fixture();
    Object.assign(adapter, configuration);
    const payload = { profileName: 'douyin-main', accountId: 7 };
    const originalPayload = structuredClone(payload);
    const result = await collectPlatformAnalytics(adapter, payload);
    assert.equal(result.status, 'FAILED');
    assert.equal(result.result.analytics.sourceVerified, false);
    assert.equal(calls.contextRequests, 0);
    assert.equal(calls.created, 0);
    assert.equal(calls.navigations.length, 0);
    assert.deepEqual(payload, originalPayload);
  }
});

async function withProfileBindings(value, action) {
  const previous = process.env.PLATFORM_ANALYTICS_PROFILE_BINDINGS;
  try {
    if (value === undefined) delete process.env.PLATFORM_ANALYTICS_PROFILE_BINDINGS;
    else process.env.PLATFORM_ANALYTICS_PROFILE_BINDINGS = value;
    return await action();
  } finally {
    if (previous === undefined) delete process.env.PLATFORM_ANALYTICS_PROFILE_BINDINGS;
    else process.env.PLATFORM_ANALYTICS_PROFILE_BINDINGS = previous;
  }
}

test('trusted process profile bindings allow a supervisor directory basename that differs from the database profile name', async () => {
  await withProfileBindings(JSON.stringify({ douyin: 'profile-douyin-main' }), async () => {
    const { adapter, calls } = fixture();
    adapter.profileDir = 'C:\\browser-supervisor\\profiles\\douyin';
    const result = await collectPlatformAnalytics(adapter, { profileName: 'profile-douyin-main' });
    assert.ok(['SUCCESS', 'PARTIAL_SUCCESS'].includes(result.status));
    assert.equal(calls.contextRequests, 1);
    assert.equal(calls.created, 1);
    assert.equal(calls.closed, 1);
  });
  await withProfileBindings(JSON.stringify({ weibo: 'profile-weibo-main' }), async () => {
    const { adapter, calls } = fixture();
    adapter.profileDir = '/var/data/profiles/profile-douyin-main';
    const result = await collectPlatformAnalytics(adapter, { profileName: 'profile-douyin-main' });
    assert.ok(['SUCCESS', 'PARTIAL_SUCCESS'].includes(result.status));
    assert.equal(calls.created, 1);
    assert.equal(calls.closed, 1);
  });
});

test('tasks cannot override trusted profile bindings and malformed environment maps fail before opening a context', async () => {
  await withProfileBindings(JSON.stringify({ douyin: 'profile-douyin-main' }), async () => {
    const { adapter, calls } = fixture();
    adapter.profileDir = '/var/data/profiles/douyin';
    const result = await collectPlatformAnalytics(adapter, {
      profileName: 'another-profile',
      profileBindings: { douyin: 'another-profile' },
      platformAnalyticsProfileBindings: { douyin: 'another-profile' },
      PLATFORM_ANALYTICS_PROFILE_BINDINGS: JSON.stringify({ douyin: 'another-profile' }),
    });
    assert.equal(result.status, 'FAILED');
    assert.equal(calls.contextRequests, 0);
    assert.equal(calls.created, 0);
  });
  await withProfileBindings(JSON.stringify({ douyin: 'profile-douyin-main' }), async () => {
    const { adapter, calls } = fixture();
    const result = await collectPlatformAnalytics(adapter, { profileName: 'profile-douyin-main' });
    assert.equal(result.status, 'FAILED');
    assert.equal(calls.contextRequests, 0);
  });
  for (const invalid of ['{broken-json', '[]', 'null', '{"douyin":3}', '{"douyin":""}', '{"weibo":false}']) {
    await withProfileBindings(invalid, async () => {
      const { adapter, calls } = fixture();
      adapter.profileDir = '/var/data/profiles/profile-douyin-main';
      const result = await collectPlatformAnalytics(adapter, { profileName: 'profile-douyin-main' });
      assert.equal(result.status, 'FAILED', invalid);
      assert.equal(calls.contextRequests, 0, invalid);
      assert.equal(calls.created, 0, invalid);
    });
  }
});

test('existing account identity reader can verify a source without leaking authentication material', async () => {
  const { adapter, calls } = fixture({ platformCode: 'wechat_channels', initialUrl: 'https://channels.weixin.qq.com/platform/home', identity: {
    platformUserName: '测试视频号', source: 'wechat-channels-dom:.account-info .name',
    csrf: 'must-not-be-forwarded', cookies: ['must-not-be-forwarded'],
  } });
  const result = await collectPlatformAnalytics(adapter, { accountId: 9 });
  assert.ok(['SUCCESS', 'PARTIAL_SUCCESS'].includes(result.status));
  const analytics = result.result.analytics;
  assert.equal(analytics.sourceVerified, true);
  assert.equal(analytics.identityVerified, true);
  assert.equal(analytics.accountIdentity.name, '测试视频号');
  assert.ok(!JSON.stringify(result).includes('must-not-be-forwarded'));
  assert.equal(calls.closed, 1);
});

test('the actual video channels platform root is a trusted account overview without a home suffix', async () => {
  const initialUrl = 'https://channels.weixin.qq.com/platform';
  const { adapter, calls } = fixture({ platformCode: 'wechat_channels', initialUrl, snapshots: {
    [initialUrl]: { bodyText: '视频号首页 关注者1 昨日数据 新增播放7 新增评论2 新增0', links: [],
      accountIdentity: { name: '测试视频号', verified: true, source: 'ACCOUNT_HEADER:.account-info .name' },
      cards: [{ label: '关注者', rawValue: '1' },
        { label: '新增播放', rawValue: '7', periodText: '昨日数据' },
        { label: '新增评论', rawValue: '2', periodText: '昨日数据' },
        { label: '新增', rawValue: '0', periodText: '昨日数据' }],
    },
  } });
  const result = await collectPlatformAnalytics(adapter, {});
  assert.equal(result.status, 'SUCCESS');
  assert.equal(result.result.analytics.sourceVerified, true);
  assert.deepEqual(result.result.analytics.metrics.map(metric => metric.key), ['followersTotal', 'plays', 'comments']);
  assert.equal(result.result.analytics.evidence.pages[0].scopeVerified, true);
  assert.deepEqual(calls.navigations.map(call => call.url), [initialUrl]);
  assert.equal(calls.closed, 1);
});

test('offline video channels DOM reads inline leaf counts under yesterday data without accepting unrelated work counters', { skip: !chromePath }, async t => {
  const browser = await chromium.launch({ headless: true, executablePath: chromePath });
  t.after(() => browser.close());
  const context = await browser.newContext();
  const html = `<!doctype html><html><body>
    <header><span class="user-name">隔离测试视频号</span></header>
    <main>
      <section><h2>账号概览</h2><div><span>关注者1</span></div></section>
      <section><h2>昨日数据</h2>
        <div><span>新增播放7</span></div><div><span>新增评论2</span></div><div><span>新增0</span></div>
      </section>
      <article><span>播放量</span><span>99999</span><span>评论量</span><span>888</span></article>
      <div hidden><span>关注者</span><span>999</span></div>
    </main>
  </body></html>`;
  await context.route('**/*', route => route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html }));
  const result = await collectPlatformAnalytics({
    platformCode: 'wechat_channels',
    spec: { manageUrl: 'https://channels.weixin.qq.com/platform' },
    async ensureContext() { return context; },
    async assertRuntimeAllowed() {},
  }, {});
  assert.equal(result.status, 'SUCCESS');
  const analytics = result.result.analytics;
  assert.equal(analytics.accountIdentity.name, '隔离测试视频号');
  const byKey = Object.fromEntries(analytics.metrics.map(metric => [metric.key, metric]));
  assert.deepEqual(Object.keys(byKey).sort(), ['comments', 'followersTotal', 'plays']);
  assert.equal(byKey.followersTotal.value, 1);
  assert.equal(byKey.followersTotal.scope, 'SNAPSHOT');
  assert.equal(byKey.followersTotal.periodStart, undefined);
  assert.equal(byKey.plays.value, 7);
  assert.equal(byKey.comments.value, 2);
  const chinaDay = value => new Date(value).toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
  const yesterday = chinaDay(Date.parse(analytics.capturedAt) - 86400000);
  for (const key of ['plays', 'comments']) {
    assert.equal(byKey[key].scope, 'PERIOD');
    assert.equal(chinaDay(byKey[key].periodStart), yesterday);
    assert.equal(chinaDay(byKey[key].periodEnd), yesterday);
    assert.equal(Date.parse(byKey[key].periodEnd) - Date.parse(byKey[key].periodStart), 86400000 - 1);
  }
  assert.equal(context.pages().length, 0, 'the temporary collection page must be closed');
});

test('snapshot identity requires an explicit verified marker and a reliable source', async () => {
  for (const [accountIdentity, expected] of [
    [{ name: '无证据昵称' }, false],
    [{ name: '无来源昵称', verified: true }, false],
    [{ name: '已验证账号', verified: true, source: 'ACCOUNT_HEADER:.user-name' }, true],
  ]) {
    const { adapter } = fixture({ snapshots: { [manageUrl]: {
      bodyText: '数据概览', cards: [{ label: '播放量', rawValue: '11' }], links: [], accountIdentity,
    } } });
    const result = await collectPlatformAnalytics(adapter, {});
    assert.equal(result.result.analytics.identityVerified, expected);
    assert.equal(result.result.analytics.sourceVerified, expected);
  }
});

test('diagnostic identity candidates cannot verify an account and disappear once reliable identity is available', async () => {
  for (const verified of [false, true]) {
    const { adapter } = fixture({ snapshots: { [manageUrl]: {
      bodyText: '数据概览', cards: [{ label: '播放量', rawValue: '11' }], links: [],
      identityCandidates: [{ text: '候选账号', className: 'account-info-unknown', parentClass: 'profile-card',
        verified: true, source: 'untrusted-candidate-field' }],
      accountResourcePaths: ['/api/account/profile'],
      ...(verified ? { accountIdentity: { name: '真实账号', verified: true, source: 'ACCOUNT_HEADER:.user-name' } } : {}),
    } } });
    const result = await collectPlatformAnalytics(adapter, { accountName: '候选账号' });
    const analytics = result.result.analytics;
    assert.equal(analytics.identityVerified, verified);
    assert.equal(analytics.sourceVerified, verified);
    if (verified) {
      assert.equal(analytics.accountIdentity.name, '真实账号');
      assert.equal(analytics.evidence.pages[0].identityCandidates, undefined);
      assert.equal(analytics.evidence.pages[0].accountResourcePaths, undefined);
    } else {
      assert.equal(result.status, 'PARTIAL_SUCCESS');
      assert.deepEqual(analytics.accountIdentity, {});
      assert.deepEqual(analytics.evidence.pages[0].identityCandidates, [
        { text: '候选账号', className: 'account-info-unknown', parentClass: 'profile-card' },
      ]);
      assert.deepEqual(analytics.evidence.pages[0].accountResourcePaths, ['/api/account/profile']);
    }
  }
});

test('identity diagnostics cap candidate fields and paths, remove sensitive resource details, and fit the UTF-8 evidence budget', async () => {
  for (const fill of ['x', '账']) {
    const { adapter } = fixture({ snapshots: { [manageUrl]: {
      bodyText: '数据概览', cards: [{ label: '播放量', rawValue: '11' }], links: [],
      identityCandidates: Array.from({ length: 30 }, (_, index) => ({
        text: `candidate${index} ${fill.repeat(2000)}`, className: fill.repeat(2000), parentClass: fill.repeat(2000),
      })),
      accountResourcePaths: [
        '/api/user?token=must-not-be-recorded', '/api/account#private-fragment',
        '/api/secret/account', '/api/session/user', 'https://untrusted.example/account',
        ...Array.from({ length: 20 }, (_, index) => `/api/account/${index}/${fill.repeat(1000)}`),
      ],
    } } });
    const result = await collectPlatformAnalytics(adapter, {});
    const analytics = result.result.analytics;
    const evidence = analytics.evidence;
    assert.equal(analytics.identityVerified, false);
    assert.equal(analytics.sourceVerified, false);
    assert.ok(Buffer.byteLength(JSON.stringify(evidence), 'utf8') <= 8192);
    for (const page of evidence.pages || []) {
      assert.ok((page.identityCandidates || []).length <= 8);
      assert.ok((page.accountResourcePaths || []).length <= 8);
      for (const candidate of page.identityCandidates || []) {
        assert.ok(candidate.text.length <= 100);
        assert.ok(candidate.className.length <= 120);
        assert.ok(candidate.parentClass.length <= 120);
      }
      for (const resourcePath of page.accountResourcePaths || []) {
        assert.ok(resourcePath.startsWith('/') && resourcePath.length <= 250);
        assert.doesNotMatch(resourcePath, /[?#]|token|secret|session|cookie|csrf|password|authorization/i);
      }
    }
    assert.ok(!JSON.stringify(evidence).includes('must-not-be-recorded'));
    assert.ok(!JSON.stringify(evidence).includes('private-fragment'));
    if (fill === 'x') {
      assert.equal(evidence.pages[0].identityCandidates.length, 8);
      assert.equal(evidence.pages[0].identityCandidates[0].text.length, 100);
      assert.equal(evidence.pages[0].identityCandidates[0].className.length, 120);
      assert.equal(evidence.pages[0].identityCandidates[0].parentClass.length, 120);
      assert.equal(evidence.pages[0].accountResourcePaths.length, 8);
      assert.equal(evidence.pages[0].accountResourcePaths[0].length, 250);
    } else assert.equal(evidence.truncated, true);
  }
});

test('content management and social feeds cannot contribute individual-post counts to account analytics', async () => {
  for (const [platformCode, initialUrl] of [
    ['douyin', contentManageUrl],
    ['douyin', `${manageUrl}-lookalike`],
    ['bilibili', 'https://member.bilibili.com/platform/upload-manager'],
    ['wechat_channels', 'https://channels.weixin.qq.com/platform/post/list'],
    ['weibo', 'https://weibo.com/'],
    ['weibo', 'https://weibo.com/datacenter'],
  ]) {
    const { adapter, calls } = fixture({ platformCode, initialUrl, snapshots: {
      [initialUrl]: { bodyText: '作品列表 别人的作品 播放量999 点赞量88 评论量7',
        cards: [{ label: '播放量', rawValue: '999' }, { label: '点赞量', rawValue: '88' }, { label: '评论量', rawValue: '7' }],
        accountIdentity: { name: '已登录账号', verified: true, source: 'ACCOUNT_HEADER:.user-name' }, links: [] },
    } });
    const result = await collectPlatformAnalytics(adapter, {});
    assert.equal(result.status, 'FAILED', initialUrl);
    assert.deepEqual(result.result.analytics.metrics, [], initialUrl);
    assert.equal(result.result.analytics.sourceVerified, false, initialUrl);
    assert.equal(result.result.analytics.identityVerified, true, initialUrl);
    assert.equal(result.result.analytics.accountIdentity.name, '已登录账号', initialUrl);
    assert.ok(JSON.stringify(result.result.analytics.evidence).includes('ANALYTICS_PAGE_SCOPE_UNVERIFIED'), initialUrl);
    assert.equal(calls.navigations.length, 1, initialUrl);
    assert.equal(calls.closed, 1, initialUrl);
  }
});

test('an account analytics URL selected for one work is rejected even when its path and account identity are trusted', async () => {
  for (const key of ['aweme_id', 'bvid', 'aid', 'item_id', 'video_id', 'post_id', 'work_id', 'id']) {
    const initialUrl = `${manageUrl}?${key}=123`;
    const { adapter, calls } = fixture({ initialUrl, snapshots: {
      [initialUrl]: { bodyText: '单作品数据', cards: [{ label: '播放量', rawValue: '777' }], links: [],
        accountIdentity: { name: '已登录账号', verified: true, source: 'ACCOUNT_HEADER:.user-name' } },
    } });
    const result = await collectPlatformAnalytics(adapter, {});
    assert.equal(result.status, 'FAILED', key);
    assert.deepEqual(result.result.analytics.metrics, [], key);
    assert.equal(result.result.analytics.sourceVerified, false, key);
    assert.equal(calls.closed, 1, key);
  }
});

test('a recognized analytics pathname on an unrelated configured host cannot verify account metrics', async () => {
  const initialUrl = 'https://untrusted.example/creator-micro/data-center/operation';
  const { adapter, calls } = fixture({ initialUrl, snapshots: {
    [initialUrl]: { bodyText: '数据概览', cards: [{ label: '播放量', rawValue: '777' }], links: [],
      accountIdentity: { name: '账号名', verified: true, source: 'ACCOUNT_HEADER:.user-name' } },
  } });
  const result = await collectPlatformAnalytics(adapter, {});
  assert.equal(result.status, 'FAILED');
  assert.deepEqual(result.result.analytics.metrics, []);
  assert.equal(result.result.analytics.sourceVerified, false);
  assert.equal(calls.closed, 1);
});

test('the collector uses an explicitly labeled dashboard body period while retaining followers as a snapshot', async () => {
  const { adapter } = fixture({ snapshots: { [manageUrl]: {
    bodyText: '数据概览 统计周期：2026-10-26 至 2026-11-01 总点赞量12 总评论量3 总粉丝量90',
    cards: [{ label: '总点赞量', rawValue: '12' }, { label: '总评论量', rawValue: '3' }, { label: '总粉丝量', rawValue: '90' }], links: [],
  } } });
  const result = await collectPlatformAnalytics(adapter, {});
  const byKey = Object.fromEntries(result.result.analytics.metrics.map(metric => [metric.key, metric]));
  assert.ok(['SUCCESS', 'PARTIAL_SUCCESS'].includes(result.status));
  for (const key of ['likes', 'comments']) {
    assert.equal(byKey[key].scope, 'PERIOD');
    assert.equal(byKey[key].periodStart, '2026-10-25T16:00:00.000Z');
    assert.equal(byKey[key].periodEnd, '2026-11-01T15:59:59.999Z');
  }
  assert.equal(byKey.followersTotal.value, 90);
  assert.equal(byKey.followersTotal.scope, 'SNAPSHOT');
});

test('an explicit dashboard date range takes priority over relative periods on cards and filter buttons', async () => {
  const { adapter } = fixture({ snapshots: { [manageUrl]: {
    bodyText: '数据概览 近7天 近30天 昨日 统计周期：2026-10-26 至 2026-11-01',
    cards: [
      { label: '总点赞量', rawValue: '12', periodText: '近7天' },
      { label: '新增粉丝', rawValue: '5', periodText: '近7天' },
      { label: '总粉丝量', rawValue: '90', periodText: '近7天' },
    ], links: [],
  } } });
  const result = await collectPlatformAnalytics(adapter, {});
  const byKey = Object.fromEntries(result.result.analytics.metrics.map(metric => [metric.key, metric]));
  assert.ok(['SUCCESS', 'PARTIAL_SUCCESS'].includes(result.status));
  for (const key of ['likes', 'newFollowers']) {
    assert.equal(byKey[key].scope, 'PERIOD');
    assert.equal(byKey[key].periodStart, '2026-10-25T16:00:00.000Z');
    assert.equal(byKey[key].periodEnd, '2026-11-01T15:59:59.999Z');
  }
  assert.equal(byKey.followersTotal.value, 90);
  assert.equal(byKey.followersTotal.scope, 'SNAPSHOT');
  assert.equal(byKey.followersTotal.periodStart, undefined);
});

test('the collector does not infer a dashboard period from unrelated work publication dates in body text', async () => {
  const { adapter } = fixture({ snapshots: { [manageUrl]: {
    bodyText: '作品发布于2026-10-26 至 2026-11-01 点赞量12 新增粉丝5',
    cards: [{ label: '点赞量', rawValue: '12' }, { label: '新增粉丝', rawValue: '5' }], links: [],
  } } });
  const result = await collectPlatformAnalytics(adapter, {});
  assert.deepEqual(result.result.analytics.metrics.map(metric => metric.key), ['likes']);
  assert.equal(result.result.analytics.metrics[0].scope, 'SNAPSHOT');
  assert.equal(result.result.analytics.metrics[0].periodStart, undefined);
});

test('collector follows only visible HTTPS analytics navigation through three routes and never opens a fourth', async () => {
  const analyticsUrl = manageUrl;
  const homepageUrl = 'https://creator.douyin.com/creator-micro/home';
  const { adapter, calls } = fixture({ initialUrl: contentManageUrl, snapshots: {
    [contentManageUrl]: { bodyText: '内容管理', cards: [{ label: '播放量', rawValue: '99999', text: '单作品播放量99999' }], links: [
      { text: '数据中心', href: 'https://creator.douyin.com.evil.test/phishing', visible: true },
      { text: '数据概览', href: 'http://creator.douyin.com/insecure', visible: true },
      { text: '粉丝数据', href: 'javascript:alert(1)', visible: true },
      { text: '首页', href: 'https://user:secret@creator.douyin.com/private', visible: true },
      { text: '数据中心', href: analyticsUrl, visible: true },
      { text: '首页', href: homepageUrl, visible: true },
    ] },
    [homepageUrl]: { bodyText: '账号首页', cards: [{ label: '点赞量', rawValue: '8' }],
      links: [{ text: '数据中心', href: analyticsUrl, visible: true }] },
    [analyticsUrl]: { bodyText: '数据中心', cards: [{ label: '曝光量', rawValue: '300' }], links: [
      { text: '粉丝数据', href: 'https://creator.douyin.com/data/fans', visible: true },
    ] },
  } });
  const result = await collectPlatformAnalytics(adapter, { url: 'https://untrusted.example/' });
  assert.ok(['SUCCESS', 'PARTIAL_SUCCESS'].includes(result.status));
  assert.deepEqual(calls.navigations.map(call => call.url), [contentManageUrl, homepageUrl, analyticsUrl]);
  assert.ok(result.result.analytics.metrics.some(metric => metric.key === 'impressions' && metric.value === 300));
  assert.ok(result.result.analytics.metrics.some(metric => metric.key === 'likes' && metric.value === 8));
  assert.ok(!result.result.analytics.metrics.some(metric => metric.key === 'plays'));
  assert.equal(result.result.analytics.evidence.pages.length, 2);
  assert.ok(result.result.analytics.evidence.pages.every(page => page.scopeVerified === true));
  assert.ok(Buffer.byteLength(JSON.stringify(result.result.analytics.evidence), 'utf8') <= 8192);
  assert.equal(calls.closed, 1);
});

test('a menu without href on the third route cannot physically open a fourth route', async () => {
  const homepageUrl = 'https://creator.douyin.com/creator-micro/home';
  const fourthUrl = `${manageUrl}?view=fans`;
  const { adapter, calls } = fixture({ initialUrl: contentManageUrl,
    menuItems: { '粉丝数据': [{ visible: true, targetUrl: fourthUrl,
      onClick: () => { assert.fail('the third route must not click a menu that could open a fourth route'); } }] },
    snapshots: {
      [contentManageUrl]: { bodyText: '内容管理', cards: [], links: [{ text: '首页', href: homepageUrl, visible: true }] },
      [homepageUrl]: { bodyText: '账号首页', cards: [{ label: '点赞量', rawValue: '8' }],
        links: [{ text: '数据中心', href: manageUrl, visible: true }] },
      [manageUrl]: { bodyText: '数据概览', cards: [{ label: '播放量', rawValue: '456' }],
        links: [{ text: '粉丝数据', href: null, visible: true }] },
    },
  });
  const result = await collectPlatformAnalytics(adapter, {});
  assert.ok(['SUCCESS', 'PARTIAL_SUCCESS'].includes(result.status));
  assert.deepEqual(calls.navigations.map(call => call.url), [contentManageUrl, homepageUrl, manageUrl]);
  assert.deepEqual(calls.menuClicks, []);
  assert.ok(!calls.evaluations.some(call => call.url === fourthUrl));
  assert.ok(result.result.analytics.metrics.some(metric => metric.key === 'plays' && metric.value === 456));
  assert.equal(calls.closed, 1);
});

test('SPA navigation and invalid cards do not stop waiting for usable metrics that render later', async () => {
  const analyticsUrl = `${manageUrl}?view=interaction`;
  let metricsRendered = false;
  const { adapter, calls } = fixture({
    gotoImpl: async url => {
      if (url === analyticsUrl) assert.equal(metricsRendered, true, 'do not leave the first page before its metrics render');
    },
    evaluateImpl: (url, state) => {
      if (url === analyticsUrl) return { bodyText: '数据概览', cards: [{ label: '总粉丝', rawValue: '321' }], links: [] };
      const elapsedWait = state.waits.filter(wait => wait.url === url).reduce((sum, wait) => sum + wait.timeout, 0);
      metricsRendered = elapsedWait >= 1800;
      return { bodyText: '内容管理', cards: [{ label: '播放量', rawValue: metricsRendered ? '456' : '12.5%' }],
        links: [{ text: '数据中心', href: analyticsUrl, visible: true }] };
    },
  });
  const result = await collectPlatformAnalytics(adapter, {});
  assert.ok(['SUCCESS', 'PARTIAL_SUCCESS'].includes(result.status));
  assert.ok(calls.evaluations.filter(call => call.url === manageUrl).length >= 3);
  assert.ok(result.result.analytics.metrics.some(metric => metric.key === 'plays' && metric.value === 456));
  assert.ok(result.result.analytics.metrics.some(metric => metric.key === 'followersTotal' && metric.value === 321));
  assert.deepEqual(calls.navigations.map(call => call.url), [manageUrl, analyticsUrl]);
  assert.equal(calls.closed, 1);
});

test('Bilibili prefers the observed homepage over data center whether homepage is a link or a unique menu', async () => {
  const managerUrl = 'https://member.bilibili.com/platform/upload-manager';
  const homepageUrl = 'https://member.bilibili.com/platform/home';
  const dataUrl = 'https://member.bilibili.com/platform/data-up';
  for (const homepageHref of [homepageUrl, null]) {
    const { adapter, calls } = fixture({ platformCode: 'bilibili',
      menuItems: { '首页': [{ visible: true, targetUrl: homepageUrl }] }, snapshots: {
        [managerUrl]: { bodyText: '稿件管理', cards: [{ label: '评论量', rawValue: '3' }], links: [
          { text: '数据中心', href: dataUrl, visible: true },
          { text: '首页', href: homepageHref, visible: true },
        ] },
        [homepageUrl]: { bodyText: '首页', cards: [{ label: '总粉丝', rawValue: '800' }], links: [] },
      } });
    adapter.spec = { manageUrl: managerUrl, checkUrl: managerUrl };
    const result = await collectPlatformAnalytics(adapter, {});
    assert.ok(['SUCCESS', 'PARTIAL_SUCCESS'].includes(result.status));
    assert.ok(result.result.analytics.metrics.some(metric => metric.key === 'followersTotal' && metric.value === 800));
    assert.ok(!result.result.analytics.metrics.some(metric => metric.key === 'comments'));
    assert.equal(result.result.analytics.evidence.pages.find(page => page.sourceUrl === homepageUrl)?.scopeVerified, true);
    assert.deepEqual(result.result.analytics.evidence.pages.find(page => page.sourceUrl === managerUrl)?.metrics, []);
    assert.ok(!calls.navigations.some(call => call.url === dataUrl));
    assert.deepEqual(calls.menuClicks, homepageHref ? [] : ['首页']);
    assert.equal(calls.closed, 1);
    assert.equal(calls.existingNavigations, 0);
  }
});

test('video channels prefer the observed homepage over data center and ignore content-list counts', async () => {
  const managerUrl = 'https://channels.weixin.qq.com/platform/post/list';
  const homepageUrl = 'https://channels.weixin.qq.com/platform/home';
  const dataUrl = 'https://channels.weixin.qq.com/platform/statistic';
  for (const homepageHref of [homepageUrl, null]) {
    const { adapter, calls } = fixture({ platformCode: 'wechat_channels', initialUrl: managerUrl,
      menuItems: { '首页': [{ visible: true, targetUrl: homepageUrl }] }, snapshots: {
        [managerUrl]: { bodyText: '内容管理', cards: [{ label: '评论量', rawValue: '3' }], links: [
          { text: '数据中心', href: dataUrl, visible: true },
          { text: '首页', href: homepageHref, visible: true },
        ] },
        [homepageUrl]: { bodyText: '账号首页', cards: [{ label: '总粉丝', rawValue: '80' }], links: [] },
      } });
    const result = await collectPlatformAnalytics(adapter, {});
    assert.ok(['SUCCESS', 'PARTIAL_SUCCESS'].includes(result.status));
    assert.ok(result.result.analytics.metrics.some(metric => metric.key === 'followersTotal' && metric.value === 80));
    assert.ok(!result.result.analytics.metrics.some(metric => metric.key === 'comments'));
    assert.equal(result.result.analytics.evidence.pages.find(page => page.sourceUrl === homepageUrl)?.scopeVerified, true);
    assert.deepEqual(result.result.analytics.evidence.pages.find(page => page.sourceUrl === managerUrl)?.metrics, []);
    assert.ok(!calls.navigations.some(call => call.url === dataUrl));
    assert.deepEqual(calls.menuClicks, homepageHref ? [] : ['首页']);
    assert.equal(calls.closed, 1);
  }
});

test('persistently empty SPA pages have a bounded per-page settling budget even with immediate fixture waits', async () => {
  const analyticsUrl = `${manageUrl}?view=interaction`;
  const { adapter, calls } = fixture({ snapshots: {
    [manageUrl]: { bodyText: '内容管理', cards: [], links: [{ text: '数据中心', href: analyticsUrl, visible: true }] },
    [analyticsUrl]: { bodyText: '数据中心', cards: [], links: [] },
  } });
  const started = Date.now();
  const result = await collectPlatformAnalytics(adapter, {});
  assert.equal(result.status, 'FAILED');
  assert.deepEqual(result.result.analytics.metrics, []);
  assert.ok(Date.now() - started < 2000);
  assert.deepEqual(calls.navigations.map(call => call.url), [manageUrl, analyticsUrl]);
  for (const url of [manageUrl, analyticsUrl]) {
    const waits = calls.waits.filter(wait => wait.url === url);
    assert.ok(waits.length > 1 && waits.length <= 12);
    assert.equal(waits.reduce((sum, wait) => sum + wait.timeout, 0), 5000);
    assert.ok(calls.evaluations.filter(call => call.url === url).length <= 12);
  }
  assert.equal(calls.closed, 1);
});

test('the total collection deadline still interrupts SPA settling before its per-page budget elapses', async () => {
  const { adapter, calls } = fixture({
    snapshots: { [manageUrl]: { bodyText: '尚在加载', cards: [], links: [] } },
    waitImpl: timeout => new Promise(resolve => setTimeout(resolve, timeout)),
  });
  const started = Date.now();
  const result = await collectPlatformAnalytics(adapter, {}, { timeoutMs: 60 });
  assert.equal(result.status, 'FAILED');
  assert.ok(Date.now() - started < 2000);
  assert.ok(result.result.analytics.evidence.issues.includes('ANALYTICS_TIMEOUT'));
  assert.deepEqual(result.result.analytics.metrics, []);
  assert.equal(calls.navigations.length, 1);
  assert.ok(calls.waits.every(wait => wait.timeout <= 60));
  assert.equal(calls.closed, 1);
});

test('cross-page metric conflicts are omitted instead of summed or selected by visit order', async () => {
  const analyticsUrl = `${manageUrl}?view=interaction`;
  for (const [first, second] of [
    [{ label: '播放量', rawValue: '100' }, { label: '播放量', rawValue: '200' }],
    [{ label: '播放量', rawValue: '100' }, { label: '播放量', rawValue: '100', periodText: '今日' }],
    [{ label: '播放量', rawValue: '100', periodText: '今日' }, { label: '播放量', rawValue: '100', periodText: '昨日' }],
    [{ label: '新增关注', rawValue: '10', periodText: '近7天' }, { label: '新增关注', rawValue: '10', periodText: '近30天' }],
  ]) {
    const { adapter, calls } = fixture({ snapshots: {
      [manageUrl]: { bodyText: '管理页', cards: [first], links: [{ text: '数据中心', href: analyticsUrl, visible: true }] },
      [analyticsUrl]: { bodyText: '数据中心', cards: [second, { label: '评论量', rawValue: '2' }], links: [] },
    } });
    const result = await collectPlatformAnalytics(adapter, {});
    assert.deepEqual(result.result.analytics.metrics.map(metric => metric.key), ['comments']);
    assert.equal(calls.navigations.length, 2);
    assert.equal(calls.closed, 1);
  }
});

test('reliable account identity changing between pages fails the entire collection', async () => {
  const analyticsUrl = `${manageUrl}?view=interaction`;
  const { adapter, calls } = fixture({ snapshots: {
    [manageUrl]: { bodyText: '管理页', cards: [{ label: '播放量', rawValue: '100' }],
      accountIdentity: { id: '123', name: '账号甲', verified: true, source: 'ACCOUNT_HEADER:.user-name' },
      links: [{ text: '数据中心', href: analyticsUrl, visible: true }] },
    [analyticsUrl]: { bodyText: '数据中心', cards: [{ label: '点赞量', rawValue: '10' }],
      accountIdentity: { id: '456', name: '账号乙', verified: true, source: 'ACCOUNT_HEADER:.user-name' }, links: [] },
  } });
  const result = await collectPlatformAnalytics(adapter, { accountName: '账号乙', platformUserId: '456' });
  assert.equal(result.status, 'FAILED');
  assert.equal(result.result.analytics.sourceVerified, false);
  assert.equal(result.result.analytics.identityVerified, false);
  assert.equal(calls.navigations.length, 2);
  assert.equal(calls.closed, 1);
});

test('large page text and navigation inventories remain within the UTF-8 evidence budget', async () => {
  const { adapter, calls } = fixture({ snapshots: {
    [manageUrl]: {
      bodyText: '公开运营指标文本'.repeat(4000),
      cards: Array.from({ length: 100 }, () => ({ label: '播放量', rawValue: '123' })),
      links: Array.from({ length: 100 }, (_, index) => ({ text: '数据中心', visible: true,
        href: `https://creator.douyin.com/data/${'长路径'.repeat(800)}${index}` })),
    },
  } });
  const result = await collectPlatformAnalytics(adapter, {});
  const evidence = result.result.analytics.evidence;
  assert.ok(Buffer.byteLength(JSON.stringify(evidence), 'utf8') <= 8192);
  assert.ok((evidence.pages || []).every(page => Array.from(page.bodyText || '').length <= 600));
  assert.equal(calls.closed, 1);
});

test('collector does not treat hidden links or arbitrary content links as an analytics entry', async () => {
  const { adapter, calls } = fixture({ snapshots: {
    [manageUrl]: { bodyText: '内容管理', cards: [], links: [
      { text: '数据中心', href: 'https://creator.douyin.com/hidden-data', visible: false },
      { text: '发布作品', href: 'https://creator.douyin.com/publish', visible: true },
    ] },
  } });
  await collectPlatformAnalytics(adapter, {});
  assert.equal(calls.navigations.length, 1);
  assert.equal(calls.closed, 1);
});

test('an observed exact readonly menu may be clicked once on the temporary page when it has no href', async () => {
  const fansUrl = `${manageUrl}?view=fans`;
  const { adapter, calls } = fixture({ menuItems: { '粉丝数据': [{ visible: true, targetUrl: fansUrl }] }, snapshots: {
    [manageUrl]: { bodyText: '内容管理', cards: [], links: [{ text: '粉丝数据', href: null, visible: true }] },
    [fansUrl]: { bodyText: '粉丝数据', cards: [{ label: '粉丝总数', rawValue: '321' }], links: [] },
  } });
  const result = await collectPlatformAnalytics(adapter, {});
  assert.equal(calls.created, 1);
  assert.deepEqual(calls.menuClicks, ['粉丝数据']);
  assert.equal(calls.navigations.length, 1);
  assert.equal(calls.existingNavigations, 0);
  assert.equal(result.result.analytics.evidence.pages.length, 2);
  assert.ok(result.result.analytics.metrics.some(metric => metric.key === 'followersTotal' && metric.value === 321));
  assert.equal(calls.closed, 1);
});

test('expanding a readonly menu without changing URL still permits navigation to the newly visible video data entry', async () => {
  let expanded = false;
  const { adapter, calls } = fixture({ initialUrl: contentManageUrl,
    menuItems: { '数据中心': [{ visible: true, targetUrl: contentManageUrl, onClick: () => { expanded = true; } }] },
    evaluateImpl: url => url === manageUrl
      ? { bodyText: '视频数据', cards: [{ label: '播放量', rawValue: '456' }], links: [] }
      : { bodyText: '内容管理', cards: [{ label: '点赞量', rawValue: '999' }], links: expanded
        ? [{ text: '视频数据', href: manageUrl, visible: true }]
        : [{ text: '数据中心', href: null, visible: true }] },
  });
  const result = await collectPlatformAnalytics(adapter, {});
  assert.ok(['SUCCESS', 'PARTIAL_SUCCESS'].includes(result.status));
  assert.deepEqual(calls.menuClicks, ['数据中心']);
  assert.deepEqual(calls.navigations.map(call => call.url), [contentManageUrl, manageUrl]);
  assert.ok(result.result.analytics.metrics.some(metric => metric.key === 'plays' && metric.value === 456));
  assert.ok(!result.result.analytics.metrics.some(metric => metric.key === 'likes'));
  assert.equal(calls.closed, 1);
});

test('unexpected popups are never inspected and are retried during cleanup after immediate close fails', async () => {
  for (const failNavigation of [false, true]) {
    let temporaryPage, closeAttempts = 0, popupClosed = false;
    const popup = {
      async close() {
        closeAttempts += 1;
        if (closeAttempts === 1) throw new Error('popup not ready to close yet');
        popupClosed = true;
      },
      async evaluate() { assert.fail('popup content must never be inspected'); },
      async goto() { assert.fail('popup must never be navigated'); },
      url() { assert.fail('popup URL must never be inspected'); },
    };
    const { adapter, page, calls } = fixture({ gotoImpl: async () => {
      temporaryPage.emit('popup', popup);
      if (failNavigation) throw new Error('navigation failed after opening popup');
    } });
    temporaryPage = page;
    const result = await collectPlatformAnalytics(adapter, {});
    assert.equal(result.status, failNavigation ? 'FAILED' : 'PARTIAL_SUCCESS');
    assert.equal(popupClosed, true);
    assert.equal(closeAttempts, 2);
    assert.equal(calls.closed, 1);
    assert.equal(calls.existingNavigations, 0);
  }
});

test('ambiguous readonly menu targets never cause a click', async () => {
  const { adapter, calls } = fixture({ menuItems: { '数据中心': [
    { visible: true, targetUrl: 'https://creator.douyin.com/data/a' },
    { visible: true, targetUrl: 'https://creator.douyin.com/data/b' },
  ] }, snapshots: {
    [manageUrl]: { bodyText: '内容管理', cards: [], links: [{ text: '数据中心', href: null, visible: true }] },
  } });
  await collectPlatformAnalytics(adapter, {});
  assert.deepEqual(calls.menuClicks, []);
  assert.equal(calls.navigations.length, 1);
  assert.equal(calls.closed, 1);
});

test('an ambiguous homepage falls back to the next unique visible readonly data center menu', async () => {
  const { adapter, calls } = fixture({ initialUrl: contentManageUrl,
    menuItems: {
      '首页': [
        { visible: true, targetUrl: 'https://creator.douyin.com/creator-micro/home' },
        { visible: true, targetUrl: 'https://creator.douyin.com/creator-micro/home' },
      ],
      '数据中心': [{ visible: true, targetUrl: manageUrl }],
    }, snapshots: {
      [contentManageUrl]: { bodyText: '侧栏首页 面包屑首页 数据中心', cards: [], links: [
        { text: '首页', href: null, visible: true },
        { text: '数据中心', href: null, visible: true },
      ] },
      [manageUrl]: { bodyText: '数据概览', cards: [{ label: '播放量', rawValue: '456' }], links: [] },
    },
  });
  const result = await collectPlatformAnalytics(adapter, {});
  assert.ok(['SUCCESS', 'PARTIAL_SUCCESS'].includes(result.status));
  assert.deepEqual(calls.menuClicks, ['数据中心']);
  assert.deepEqual(calls.navigations.map(call => call.url), [contentManageUrl]);
  assert.ok(result.result.analytics.metrics.some(metric => metric.key === 'plays' && metric.value === 456));
  assert.equal(calls.closed, 1);
});

test('cross-host redirects cannot be accepted as a trusted analytics source', async () => {
  const { adapter, calls } = fixture({ redirectUrl: 'https://untrusted.example/overview' });
  const result = await collectPlatformAnalytics(adapter, {});
  assert.equal(result.status, 'FAILED');
  assert.ok(!(result.result.analytics?.metrics || []).length);
  assert.equal(calls.closed, 1);
});

test('runtime stop after navigation aborts collection and closes the temporary page', async () => {
  const { adapter, calls } = fixture({ guardImpl: state => {
    if (state.navigations.length) throw Object.assign(new Error('platform stopped'), { code: 'PLATFORM_STOPPED' });
  } });
  const result = await collectPlatformAnalytics(adapter, {});
  assert.equal(result.status, 'FAILED');
  assert.equal(calls.created, 1);
  assert.equal(calls.closed, 1);
  assert.equal(calls.navigations.length, 1);
});

test('navigation errors and total timeouts close the temporary page and do not report invented metrics', async () => {
  const failing = fixture({ gotoImpl: async () => { throw new Error('navigation unavailable'); } });
  const failed = await collectPlatformAnalytics(failing.adapter, {});
  assert.equal(failed.status, 'FAILED');
  assert.equal(failing.calls.closed, 1);
  const timeout = fixture({ gotoImpl: () => new Promise(() => {}) });
  const started = Date.now();
  const timedOut = await collectPlatformAnalytics(timeout.adapter, {}, { timeoutMs: 25 });
  assert.equal(timedOut.status, 'FAILED');
  assert.ok(Date.now() - started < 2000);
  assert.equal(timeout.calls.closed, 1);
  assert.ok(!(timedOut.result.analytics?.metrics || []).length);
});

test('unsupported simulated adapters never create an analytics browser page', async () => {
  const { adapter, calls } = fixture({ platformCode: 'simulated' });
  const result = await collectPlatformAnalytics(adapter, {});
  assert.equal(result.status, 'FAILED');
  assert.equal(calls.created, 0);
  assert.equal(calls.navigations.length, 0);
});

test('a page created after the total deadline is still closed without navigating it', async () => {
  const { adapter, context, page, calls } = fixture();
  let releasePage;
  context.newPage = () => {
    calls.created += 1;
    return new Promise(resolve => { releasePage = () => resolve(page); });
  };
  const result = await collectPlatformAnalytics(adapter, {}, { timeoutMs: 25 });
  assert.equal(result.status, 'FAILED');
  assert.equal(calls.created, 1);
  releasePage();
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.navigations.length, 0);
  assert.equal(calls.closed, 1);
});
