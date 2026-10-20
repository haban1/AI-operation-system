import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WechatChannelsAssistedRpaAdapter } from '../agent/rpa-adapters/wechat-channels-assisted.js';

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-channels-comment-regression-'));
  const adapter = new WechatChannelsAssistedRpaAdapter({
    profileDir: path.join(dir, 'profile'),
    logsDir: path.join(dir, 'logs'),
    executablePath: 'chrome-not-used',
    loginTimeoutMs: 1,
    sendTimeoutMs: 1
  });
  return { adapter, close: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function staticLocator({ rows = [], visible = false } = {}) {
  return {
    async evaluateAll() { return rows; },
    async count() { return rows.length; },
    nth(index) { return rows[index]; },
    first() { return this; },
    async isVisible() { return visible; },
    async innerText() { return ''; }
  };
}

function scopedPage({ directRows, frameRows }) {
  const overviewSelector = '.main-body-wrap.comment-view.interaction-wrap';
  const rowSelector = '.feeds-container .comment-feed-wrap';
  const frame = {
    url() { return 'https://channels.weixin.qq.com/platform/interaction/comment?scope=active'; },
    locator(selector) {
      if (selector === overviewSelector) return staticLocator({ visible: true });
      if (selector === rowSelector) return staticLocator({ rows: frameRows, visible: true });
      return staticLocator();
    }
  };
  const iframeHandle = { async contentFrame() { return frame; }, async isVisible() { return true; } };
  const page = {
    url() { return 'https://channels.weixin.qq.com/platform/interaction/comment'; },
    mainFrame() { return page; },
    frames() { return [page, frame]; },
    frameLocator() { return { locator: selector => frame.locator(selector) }; },
    locator(selector) {
      if (selector === 'iframe') {
        return {
          async count() { return 1; },
          nth() { return iframeHandle; },
          first() { return iframeHandle; }
        };
      }
      if (selector === overviewSelector) return staticLocator({ visible: false });
      if (selector === rowSelector) return staticLocator({ rows: directRows, visible: true });
      return staticLocator();
    }
  };
  return { page, frame };
}

function withMockBrowserDom(documentValue, callback) {
  const previousDocument = globalThis.document;
  const previousGetComputedStyle = globalThis.getComputedStyle;
  globalThis.document = documentValue;
  globalThis.getComputedStyle = element => element?.style || { display: 'block', visibility: 'visible', opacity: '1' };
  try {
    return callback();
  } finally {
    globalThis.document = previousDocument;
    globalThis.getComputedStyle = previousGetComputedStyle;
  }
}

function vueBackedCommentScope({ feedsVm = {}, feeds = [], comments = [], detailTitle = '' } = {}) {
  const overviewSelector = '.main-body-wrap.comment-view.interaction-wrap';
  const rowSelector = '.feeds-container .comment-feed-wrap';
  const commentSelector = '.comment-item';
  const detailElement = detailTitle ? { innerText: detailTitle, textContent: detailTitle } : null;
  const documentValue = {
    querySelector(selector) {
      if (selector === '.feeds') return { __vue__: feedsVm };
      if (selector === commentSelector) return comments[0] || null;
      if (selector === '.feed-detail') return detailElement;
      if (selector === '.feed-selected-info .feed-title' || selector === '.feed-detail .feed-title') return detailElement;
      return null;
    },
    querySelectorAll(selector) {
      if (selector === rowSelector) return feeds;
      if (selector === commentSelector) return comments;
      return [];
    }
  };
  const execute = callback => withMockBrowserDom(documentValue, callback);
  const collection = elements => ({
    async evaluateAll(callback, argument) { return execute(() => callback(elements, argument)); },
    async count() { return elements.length; },
    nth(index) { return elements[index]; },
    first() { return this; },
    async isVisible() { return elements.length > 0; },
    async innerText() { return ''; }
  });
  return {
    url() { return 'https://channels.weixin.qq.com/empty.html'; },
    locator(selector) {
      if (selector === overviewSelector) return staticLocator({ visible: true });
      if (selector === rowSelector) return collection(feeds);
      if (selector === commentSelector) return collection(comments);
      return staticLocator();
    },
    async evaluate(callback, argument) { return execute(() => callback(argument)); },
    async waitForTimeout() {}
  };
}

function feedElement({ title, time, count, className = 'comment-feed-wrap inactive-feed' }) {
  const nodes = {
    '.feed-title': { innerText: title, textContent: title },
    '.feed-time': { innerText: time, textContent: time },
    '.feed-comment-total': { innerText: String(count), textContent: String(count) }
  };
  const element = {
    className,
    innerText: `${title} ${time} ${count}`,
    textContent: `${title} ${time} ${count}`,
    style: { display: 'block', visibility: 'visible', opacity: '1' },
    getClientRects() { return [1]; },
    querySelector(selector) { return nodes[selector] || null; },
    async isVisible() { return true; },
    async click() {},
    async evaluate(callback, argument) { return callback(element, argument); }
  };
  return element;
}

function commentElement({ store, commentId, content = '提交的个人信息会保密吗？' }) {
  const dataSource = { commentId, commentContent: content };
  return {
    className: 'comment-item',
    innerText: content,
    textContent: content,
    style: { display: 'block', visibility: 'visible', opacity: '1' },
    getClientRects() { return [1]; },
    __vue__: {
      store,
      dataSource,
      $props: { store, dataSource },
      $options: { propsData: { store, dataSource } },
      $vnode: { key: commentId, data: { key: commentId } }
    }
  };
}
test('wechat channels comment rows are read from the active iframe/scope, not stale top-level DOM', async () => {
  const f = fixture();
  try {
    const staleRows = [{ index: 0, visible: true, title: '旧作品', time: '2026/08/16 09:00', text: '旧作品 1', count: 1 }];
    const activeRows = [{ index: 0, visible: true, title: 'OPC一人公司', time: '2026/08/17 23:00', text: 'OPC一人公司 1', count: 1 }];
    const { page } = scopedPage({ directRows: staleRows, frameRows: activeRows });

    const rows = await f.adapter.readWechatCommentVideoRows(page);

    assert.deepEqual(rows, activeRows);
  } finally { f.close(); }
});

test('wechat channels refuses unchanged old comment DOM after switching works', async () => {
  const f = fixture();
  try {
    const targetElement = {
      className: 'comment-feed-wrap active-feed',
      getClientRects() { return [1]; }
    };
    const oldComment = {
      className: 'comment-item',
      innerText: '旧用户 账号发布的内容可以转载吗？ 2026/08/17 22:00',
      textContent: '旧用户 账号发布的内容可以转载吗？ 2026/08/17 22:00',
      getClientRects() { return [1]; },
      getAttribute() { return null; },
      querySelector() { return null; }
    };
    const target = {
      async isVisible() { return true; },
      async click() {},
      async evaluate(callback, argument) { return callback(targetElement, argument); }
    };
    const page = {
      url() { return 'https://channels.weixin.qq.com/platform/interaction/comment'; },
      locator(selector) {
        if (selector === '.feeds-container .comment-feed-wrap') return { nth() { return target; } };
        if (selector === '.comment-item') {
          return { async evaluateAll(callback, argument) { return callback([oldComment], argument); } };
        }
        return staticLocator();
      },
      async evaluate() {
        return {
          panelVisible: true,
          explicitEmpty: false,
          loadingOrLoadMoreVisible: false,
          visibleCommentCount: 1,
          signature: oldComment.innerText
        };
      },
      async waitForTimeout() {}
    };
    const previousGetComputedStyle = globalThis.getComputedStyle;
    globalThis.getComputedStyle = () => ({ display: 'block', visibility: 'visible', opacity: '1' });
    try {
      const result = await f.adapter.openWechatCommentVideoRow(page, {
        index: 1,
        visible: true,
        title: 'OPC一人公司',
        time: '2026/08/17 23:00',
        text: 'OPC一人公司 1',
        count: 1
      }, { timeoutMs: 25 });

      assert.equal(result.ok, false, '未发生评论指纹切换时不得把旧 DOM 当作目标作品评论');
    } finally {
      globalThis.getComputedStyle = previousGetComputedStyle;
    }
  } finally { f.close(); }
});

test('wechat channels preserves stable work/comment IDs and marks the source verified', async () => {
  const f = fixture();
  try {
    const sourceContext = f.adapter.wechatCommentVideoContext({
      index: 0,
      visible: true,
      title: 'OPC一人公司',
      time: '2026/08/17 23:00',
      text: 'OPC一人公司 1',
      count: 1,
      sourceVideoKey: 'feed-real-137cae7f4ca0',
      sourceVerified: true
    });
    const page = {
      url() { return 'https://channels.weixin.qq.com/platform/interaction/comment'; },
      locator() {
        return {
          async evaluateAll() {
            return [{
              index: 0,
              text: '提交的个人信息会保密吗？',
              userName: '是一只七.',
              eventTime: '2026/08/17 23:05',
              unread: null,
              unreadEvidence: null,
              conversationKey: null,
              commentStableId: 'comment-real-998877',
              sourceVideoKey: 'feed-real-137cae7f4ca0',
              type: 'COMMENT'
            }];
          }
        };
      }
    };

    const [message] = await f.adapter.extractMessages(page, 'COMMENT', {}, { sourceContext });

    assert.deepEqual({
      rowVideoKey: sourceContext.sourceVideoKey,
      commentStableId: message.context.commentStableId,
      messageVideoKey: message.context.sourceVideoKey,
      sourceVerified: message.context.sourceVerified
    }, {
      rowVideoKey: 'feed-real-137cae7f4ca0',
      commentStableId: 'comment-real-998877',
      messageVideoKey: 'feed-real-137cae7f4ca0',
      sourceVerified: true
    });
  } finally { f.close(); }
});

test('wechat channels isolates one work failure and continues collecting later works', async () => {
  const f = fixture();
  try {
    const rows = [
      { index: 0, visible: true, title: '异常作品', time: '2026/08/17 22:00', text: '异常作品 1', count: 1 },
      { index: 1, visible: true, title: '正常作品', time: '2026/08/17 23:00', text: '正常作品 1', count: 1 }
    ];
    f.adapter.readWechatAccountIdentity = async () => ({ platformUserName: '测试账号', source: 'test' });
    f.adapter.readWechatCommentVideoRows = async () => rows;
    f.adapter.openWechatCommentVideoRow = async (_page, row) => {
      if (row.index === 0) throw new Error('single work DOM detached');
      return { ok: true, sourceContext: { ...f.adapter.wechatCommentVideoContext(row), sourceVideoKey: 'feed-normal-2', sourceVerified: true } };
    };
    f.adapter.extractMessages = async (_page, _type, _payload, options) => [{
      externalId: 'wechat-comment-normal-1',
      content: '正常作品的新评论',
      context: options.sourceContext
    }];

    const result = await f.adapter.collectWechatChannelComments({ waitForTimeout: async () => {} }, {}, { maxRounds: 1 });

    assert.equal(result.messages.length, 1);
    assert.equal(result.messages[0].externalId, 'wechat-comment-normal-1');
    assert.equal(result.videoResults.find(item => item.row.index === 1)?.status, 'SUCCESS');
    assert.notEqual(result.videoResults.find(item => item.row.index === 0)?.status, 'SUCCESS');
  } finally { f.close(); }
});

test('wechat channels reads real work IDs from comment item store when feeds vue has no store', async () => {
  const f = fixture();
  try {
    const sourceVideoKey = 'export/UzFfBgAAxL-BMEosSybmk8zT4DCaF1fkvNQ9oL64wQ_d3T9trA';
    const store = {
      commentFeeds: [{
        objectId: sourceVideoKey,
        exportId: sourceVideoKey,
        objectNonce: '15338843287693678863',
        createTime: '2026-08-17T23:00:00+08:00',
        commentCount: 1,
        desc: { description: 'OPC 社区邀请你的加入' }
      }]
    };
    const feeds = [feedElement({ title: 'OPC一人公司', time: '2026/08/17 23:00', count: 1 })];
    const comments = [commentElement({ store, commentId: '14990267272420071588' })];
    const scope = vueBackedCommentScope({ feedsVm: {}, feeds, comments });

    const [row] = await f.adapter.readWechatCommentVideoRows(scope);

    assert.equal(row.sourceVideoKey, sourceVideoKey);
    assert.equal(row.sourceVideoOpaqueKey, '15338843287693678863');
    assert.equal(row.sourceVerified, true);
  } finally { f.close(); }
});

test('wechat channels reads current work and comment IDs from comment item store when feeds vue has no store', async () => {
  const f = fixture();
  try {
    const sourceVideoKey = 'export/UzFfBgAAxL-BMEosSybmk8zT4DCaF1fkvNQ9oL64wQ_d3T9trA';
    const commentId = '14990267272420071588';
    const currentFeed = {
      objectId: sourceVideoKey,
      exportId: sourceVideoKey,
      objectNonce: '15338843287693678863',
      commentCount: 1,
      desc: { description: 'OPC 社区邀请你的加入' }
    };
    const store = {
      currentExportId: sourceVideoKey,
      currentFeed,
      currentFeedIndex: 0,
      commentFeeds: [currentFeed],
      commentList: [{ commentId }],
      isFeedLoading: false,
      isCommentLoading: false
    };
    const feeds = [feedElement({ title: 'OPC一人公司', time: '2026/08/17 23:00', count: 1, className: 'comment-feed-wrap active-feed' })];
    const comments = [commentElement({ store, commentId })];
    const scope = vueBackedCommentScope({ feedsVm: {}, feeds, comments, detailTitle: 'OPC一人公司' });

    const state = await f.adapter.readWechatCommentRuntimeState(scope);

    assert.equal(state.currentExportId, sourceVideoKey);
    assert.deepEqual(state.commentIds, [commentId]);
    assert.deepEqual(state.storeCommentIds, [commentId]);
    assert.equal(state.sourceVerified, true);
  } finally { f.close(); }
});

test('wechat channels verifies second-level replies from nested store comment data', async () => {
  const f = fixture();
  try {
    const sourceVideoKey = 'export/work-with-nested-reply';
    const rootCommentId = '14990267272420071588';
    const replyCommentId = '14990327826286516612';
    const currentFeed = { objectId: sourceVideoKey, exportId: sourceVideoKey, commentCount: 2 };
    const store = {
      currentExportId: sourceVideoKey,
      currentFeed,
      currentFeedIndex: 0,
      commentFeeds: [currentFeed],
      commentList: [{ commentId: rootCommentId, levelTwoComment: [{ commentId: replyCommentId, levelTwoComment: [] }] }],
      isFeedLoading: false,
      isCommentLoading: false
    };
    const feeds = [feedElement({ title: '含二级回复的作品', time: '2026/08/18 01:00', count: 2, className: 'comment-feed-wrap active-feed' })];
    const comments = [
      commentElement({ store, commentId: rootCommentId, content: '用户评论' }),
      commentElement({ store, commentId: replyCommentId, content: '作者回复' })
    ];
    const scope = vueBackedCommentScope({ feedsVm: {}, feeds, comments, detailTitle: '含二级回复的作品' });

    const state = await f.adapter.readWechatCommentRuntimeState(scope);

    assert.deepEqual(state.commentIds, [rootCommentId, replyCommentId]);
    assert.deepEqual(state.storeCommentIds, [rootCommentId, replyCommentId]);
    assert.equal(state.sourceVerified, true);
  } finally { f.close(); }
});

test('wechat channels still rejects a DOM comment absent from the nested store', async () => {
  const f = fixture();
  try {
    const sourceVideoKey = 'export/work-with-stale-dom';
    const rootCommentId = '14990267272420071588';
    const staleCommentId = '14999999999999999999';
    const currentFeed = { objectId: sourceVideoKey, exportId: sourceVideoKey, commentCount: 2 };
    const store = {
      currentExportId: sourceVideoKey,
      currentFeed,
      currentFeedIndex: 0,
      commentFeeds: [currentFeed],
      commentList: [{ commentId: rootCommentId, levelTwoComment: [] }],
      isFeedLoading: false,
      isCommentLoading: false
    };
    const feeds = [feedElement({ title: '存在旧 DOM 的作品', time: '2026/08/18 01:00', count: 2, className: 'comment-feed-wrap active-feed' })];
    const comments = [
      commentElement({ store, commentId: rootCommentId, content: '当前评论' }),
      commentElement({ store, commentId: staleCommentId, content: '旧页面残留评论' })
    ];
    const scope = vueBackedCommentScope({ feedsVm: {}, feeds, comments, detailTitle: '存在旧 DOM 的作品' });

    const state = await f.adapter.readWechatCommentRuntimeState(scope);

    assert.deepEqual(state.storeCommentIds, [rootCommentId]);
    assert.equal(state.sourceVerified, false);
  } finally { f.close(); }
});

test('wechat channels does not accept a stable old comment store after switching works', async () => {
  const f = fixture();
  try {
    const oldSourceVideoKey = 'export/old-work';
    const targetSourceVideoKey = 'export/target-work';
    const oldCommentId = '14990267196328777889';
    const oldFeed = { objectId: oldSourceVideoKey, exportId: oldSourceVideoKey, commentCount: 1 };
    const staleStore = {
      currentExportId: oldSourceVideoKey,
      currentFeed: oldFeed,
      currentFeedIndex: 0,
      commentFeeds: [oldFeed, { objectId: targetSourceVideoKey, exportId: targetSourceVideoKey, commentCount: 1 }],
      commentList: [{ commentId: oldCommentId }],
      isFeedLoading: false,
      isCommentLoading: false
    };
    const feeds = [
      feedElement({ title: '旧作品', time: '2026/08/17 22:00', count: 1 }),
      feedElement({ title: '目标作品', time: '2026/08/17 23:00', count: 1, className: 'comment-feed-wrap active-feed' })
    ];
    const comments = [commentElement({ store: staleStore, commentId: oldCommentId, content: '旧作品评论' })];
    const scope = vueBackedCommentScope({ feedsVm: {}, feeds, comments, detailTitle: '旧作品' });

    const result = await f.adapter.openWechatCommentVideoRow(scope, {
      index: 1,
      visible: true,
      title: '目标作品',
      time: '2026/08/17 23:00',
      text: '目标作品 1',
      count: 1,
      sourceVideoKey: targetSourceVideoKey,
      sourceVerified: true
    }, { timeoutMs: 20 });

    assert.equal(result.ok, false);
    assert.equal(result.reason, 'COMMENT_VIDEO_ID_MISMATCH');
    assert.equal(result.runtimeState.currentExportId, oldSourceVideoKey);
    assert.deepEqual(result.runtimeState.commentIds, [oldCommentId]);
  } finally { f.close(); }
});

test('wechat channels binds reordered rows from row Vue data instead of store index', async () => {
  const f = fixture();
  try {
    const feedA = { objectId: 'work-A', exportId: 'work-A', objectNonce: 'nonce-A', createTime: '100', commentCount: 3, desc: { description: '作品 A' } };
    const feedB = { objectId: 'work-B', exportId: 'work-B', objectNonce: 'nonce-B', createTime: '200', commentCount: 5, desc: { description: '作品 B' } };
    const store = { commentFeeds: [feedA, feedB] };
    const rowB = feedElement({ title: '作品 B', time: '2026/08/18 10:00', count: 5 });
    const rowA = feedElement({ title: '作品 A', time: '2026/08/18 09:00', count: 3 });
    rowB.__vue__ = { dataSource: feedB, $props: { dataSource: feedB } };
    rowA.__vue__ = { dataSource: feedA, $props: { dataSource: feedA } };
    const comments = [commentElement({ store, commentId: 'comment-B' })];
    const scope = vueBackedCommentScope({ feedsVm: {}, feeds: [rowB, rowA], comments });

    const rows = await f.adapter.readWechatCommentVideoRows(scope);

    assert.equal(rows[0].sourceVideoKey, 'work-B');
    assert.equal(rows[0].sourceVideoOpaqueKey, 'nonce-B');
    assert.equal(rows[0].sourceIdentityBinding, 'ROW_VUE_DATA');
    assert.equal(rows[0].sourceVerified, true);
    assert.equal(rows[1].sourceVideoKey, 'work-A');
    assert.equal(rows[1].sourceIdentityBinding, 'ROW_VUE_DATA');
  } finally { f.close(); }
});

test('wechat channels does not verify multi-row works from index-only association', async () => {
  const f = fixture();
  try {
    const feedA = { objectId: 'work-A', exportId: 'work-A', commentCount: 8 };
    const feedB = { objectId: 'work-B', exportId: 'work-B', commentCount: 9 };
    const store = { commentFeeds: [feedA, feedB] };
    const rows = [
      feedElement({ title: '页面首行实际可能是 B', time: '2026/08/18 10:00', count: 9 }),
      feedElement({ title: '页面次行实际可能是 A', time: '2026/08/18 09:00', count: 8 })
    ];
    const comments = [commentElement({ store, commentId: 'comment-1' })];
    const scope = vueBackedCommentScope({ feedsVm: {}, feeds: rows, comments });

    const collectedRows = await f.adapter.readWechatCommentVideoRows(scope);

    assert.equal(collectedRows[0].sourceVideoKey, null);
    assert.equal(collectedRows[0].sourceVideoCandidateKey, 'work-A');
    assert.equal(collectedRows[0].sourceVerified, false);
    assert.equal(collectedRows[0].sourceIdentityBinding, 'UNRESOLVED');
    assert.equal(collectedRows[0].count, 9, '评论数应优先使用当前 DOM 行，而不是错位的 feed index');
  } finally { f.close(); }
});

test('wechat channels can establish the final work identity after clicking an initially unbound row', async () => {
  const f = fixture();
  try {
    const workId = 'work-live-confirmed';
    const commentId = 'comment-live-confirmed';
    const currentFeed = { objectId: workId, exportId: workId, objectNonce: 'nonce-live', createTime: '300', commentCount: 1, desc: { description: '实时确认作品' } };
    const store = {
      currentExportId: workId,
      currentFeed,
      currentFeedIndex: 0,
      commentFeeds: [currentFeed],
      commentList: [{ commentId }],
      isFeedLoading: false,
      isCommentLoading: false
    };
    const feeds = [feedElement({ title: '实时确认作品', time: '2026/08/18 11:00', count: 1, className: 'comment-feed-wrap active-feed' })];
    const comments = [commentElement({ store, commentId, content: '这条评论能自动回复吗？' })];
    const scope = vueBackedCommentScope({ feedsVm: {}, feeds, comments, detailTitle: '实时确认作品' });

    const result = await f.adapter.openWechatCommentVideoRow(scope, {
      index: 0,
      visible: true,
      title: '实时确认作品',
      time: '2026/08/18 11:00',
      text: '实时确认作品 1',
      count: 1,
      sourceVideoKey: null,
      sourceVerified: false,
      sourceIdentityBinding: 'UNRESOLVED'
    }, { timeoutMs: 50 });

    assert.equal(result.ok, true);
    assert.equal(result.sourceContext.sourceVideoKey, workId);
    assert.equal(result.sourceContext.sourceVideoOpaqueKey, 'nonce-live');
    assert.equal(result.sourceContext.sourceVerified, true);
    assert.equal(result.sourceContext.sourceIdentityBinding, 'LIVE_SELECTED_WORK');
  } finally { f.close(); }
});


test('wechat channels collection emits verified sidecar inventory without changing message results', async () => {
  const f = fixture();
  try {
    const page = {
      url() { return 'https://channels.weixin.qq.com/platform/interaction/comment'; },
      locator() { return staticLocator({ visible: true }); }
    };
    f.adapter.getPage = async () => page;
    f.adapter.prepareMessagePage = async () => ({ ok: true });
    f.adapter.inspectLoginState = async () => ({ state: 'READY', evidence: {} });
    f.adapter.waitForMessageContentReady = async () => ({ ready: true, pageCheck: { valid: true, reason: 'VERIFIED' } });
    f.adapter.evidence = async (_payload, _message, _page, stage, extra = {}) => ({ stage, ...extra });
    f.adapter.collectWechatChannelComments = async () => ({
      ok: true,
      reason: 'COMMENT_VIDEO_COLLECTION_COMPLETE',
      empty: false,
      messages: [{ externalId: 'message-1', content: '测试评论' }],
      rows: [],
      positiveRowCount: 1,
      videoResults: [{
        status: 'SUCCESS',
        reason: 'COMMENT_VIDEO_COLLECTED',
        sourceContext: {
          sourceVideoKey: 'work-sidecar-1',
          sourceVideoOpaqueKey: 'nonce-sidecar-1',
          sourceVideoTitle: '档案测试作品',
          sourceVideoDescription: '档案测试描述',
          sourceVideoPublishedAt: '2026-08-18T03:00:00.000Z',
          sourceVerified: true,
          sourceIdentityBinding: 'LIVE_SELECTED_WORK',
          sourceIdentityConflict: false,
          sourceIdentityEvidence: { stableConfirmations: 2 }
        },
        runtimeState: {
          currentExportId: 'work-sidecar-1',
          activeVNodeKey: 'work-sidecar-1',
          activeIndex: 0,
          currentFeedIndex: 0,
          selectionIdentityConsistent: true
        }
      }]
    });

    const result = await f.adapter.collectMessages({ types: ['COMMENT'], accountId: 42, profileName: 'wx-profile' });

    assert.equal(result.status, 'SUCCESS');
    assert.equal(result.result.messages.length, 1);
    assert.equal(result.result.contentInventory.length, 1);
    assert.equal(result.result.contentInventory[0].platformPostId, 'work-sidecar-1');
    assert.equal(result.result.contentInventory[0].platformAccountKey, '42');
    assert.equal(result.result.contentInventory[0].verificationStatus, 'VERIFIED');
    assert.equal(result.result.contentInventory[0].evidenceJson.sourceVerified, true);
  } finally { f.close(); }
});

test('wechat channels does not authorize unverified nested comment fields', async () => {
  const f = fixture();
  try {
    const sourceVideoKey = 'export/work-with-unverified-children';
    const rootCommentId = '14990267272420071588';
    const childCommentId = '14990267272420071589';
    const currentFeed = { objectId: sourceVideoKey, exportId: sourceVideoKey, commentCount: 2 };
    const store = {
      currentExportId: sourceVideoKey,
      currentFeed,
      currentFeedIndex: 0,
      commentFeeds: [currentFeed],
      commentList: [{ commentId: rootCommentId, children: [{ commentId: childCommentId }] }],
      isFeedLoading: false,
      isCommentLoading: false
    };
    const feeds = [feedElement({ title: '未经授权嵌套字段', time: '2026/08/18 12:00', count: 2, className: 'comment-feed-wrap active-feed' })];
    const comments = [
      commentElement({ store, commentId: rootCommentId, content: '顶层评论' }),
      commentElement({ store, commentId: childCommentId, content: 'children 中的回复' })
    ];
    const scope = vueBackedCommentScope({ feedsVm: {}, feeds, comments, detailTitle: '未经授权嵌套字段' });

    const state = await f.adapter.readWechatCommentRuntimeState(scope);

    assert.deepEqual(state.storeCommentIds, [rootCommentId]);
    assert.equal(state.sourceVerified, false);
  } finally { f.close(); }
});

test('wechat channels requires every visible comment to expose one stable ID', async () => {
  const f = fixture();
  try {
    const sourceVideoKey = 'export/work-with-idless-dom-comment';
    const rootCommentId = '14990267272420071600';
    const currentFeed = { objectId: sourceVideoKey, exportId: sourceVideoKey, commentCount: 2 };
    const store = {
      currentExportId: sourceVideoKey,
      currentFeed,
      currentFeedIndex: 0,
      commentFeeds: [currentFeed],
      commentList: [{ commentId: rootCommentId, levelTwoComment: [] }],
      isFeedLoading: false,
      isCommentLoading: false
    };
    const idlessDataSource = { commentContent: '没有稳定 ID 的可见评论' };
    const idlessComment = {
      className: 'comment-item',
      innerText: idlessDataSource.commentContent,
      textContent: idlessDataSource.commentContent,
      style: { display: 'block', visibility: 'visible', opacity: '1' },
      getClientRects() { return [1]; },
      __vue__: {
        store,
        dataSource: idlessDataSource,
        $props: { store, dataSource: idlessDataSource },
        $options: { propsData: { store, dataSource: idlessDataSource } },
        $vnode: { key: '', data: { key: '' } }
      }
    };
    const feeds = [feedElement({ title: '缺少评论 ID', time: '2026/08/18 12:05', count: 2, className: 'comment-feed-wrap active-feed' })];
    const comments = [commentElement({ store, commentId: rootCommentId, content: '有稳定 ID 的评论' }), idlessComment];
    const scope = vueBackedCommentScope({ feedsVm: {}, feeds, comments, detailTitle: '缺少评论 ID' });

    const state = await f.adapter.readWechatCommentRuntimeState(scope);

    assert.equal(state.visibleCommentCount, 2);
    assert.deepEqual(state.commentIds, [rootCommentId]);
    assert.equal(state.sourceVerified, false);
  } finally { f.close(); }
});

test('wechat channels rejects a new work ID while the old comment snapshot remains unchanged', async () => {
  const f = fixture();
  try {
    const oldWorkId = 'export/old-work-snapshot';
    const targetWorkId = 'export/target-work-snapshot';
    const oldFingerprint = 'old-comment-fingerprint';
    let readCount = 0;
    const target = {
      async isVisible() { return true; },
      async click() {},
      async evaluate(callback) { return callback({ className: 'comment-feed-wrap active-feed' }); }
    };
    const scope = {
      locator() { return { nth() { return target; } }; },
      async waitForTimeout() {}
    };
    f.adapter.resolveWechatCommentScope = async () => ({ ok: true, scope });
    f.adapter.readWechatCommentRuntimeState = async () => {
      readCount += 1;
      if (readCount === 1) {
        return { currentExportId: oldWorkId, activeIndex: 0, currentFeedIndex: 0, commentFingerprint: oldFingerprint, visibleCommentCount: 1, sourceVerified: true, selectionIdentityConsistent: true, isFeedLoading: false, isCommentLoading: false };
      }
      return { currentExportId: targetWorkId, activeIndex: 1, currentFeedIndex: 1, commentFingerprint: oldFingerprint, visibleCommentCount: 1, sourceVerified: true, selectionIdentityConsistent: true, isFeedLoading: false, isCommentLoading: false };
    };

    const result = await f.adapter.openWechatCommentVideoRow(scope, {
      index: 1,
      visible: true,
      title: '目标作品',
      sourceVideoKey: targetWorkId,
      sourceVerified: true
    }, { timeoutMs: 20 });

    assert.equal(result.ok, false);
    assert.equal(result.reason, 'COMMENT_VIDEO_SWITCH_UNVERIFIED');
    assert.equal(result.runtimeState.currentExportId, targetWorkId);
  } finally { f.close(); }
});

test('wechat channels confirms an empty comment panel with two independent samples', async () => {
  const f = fixture();
  try {
    const workId = 'export/empty-work';
    let readCount = 0;
    const target = {
      async isVisible() { return true; },
      async click() {},
      async evaluate(callback) { return callback({ className: 'comment-feed-wrap active-feed' }); }
    };
    const scope = {
      locator() { return { nth() { return target; } }; },
      async waitForTimeout() {}
    };
    const emptyState = { currentExportId: workId, activeIndex: 0, currentFeedIndex: 0, commentFingerprint: 'empty-fingerprint', visibleCommentCount: 0, workIdentityVerified: true, sourceVerified: false, selectionIdentityConsistent: true, isFeedLoading: false, isCommentLoading: false };
    f.adapter.resolveWechatCommentScope = async () => ({ ok: true, scope });
    f.adapter.readWechatCommentRuntimeState = async () => { readCount += 1; return { ...emptyState }; };
    f.adapter.readWechatCommentPanelEvidence = async () => ({ panelVisible: true, explicitEmpty: true, loadingOrLoadMoreVisible: false, visibleCommentCount: 0, signature: '暂无评论' });

    const result = await f.adapter.openWechatCommentVideoRow(scope, {
      index: 0,
      visible: true,
      title: '空评论作品',
      sourceVideoKey: workId,
      sourceVerified: true
    }, { timeoutMs: 50, allowStableEmpty: true });

    assert.equal(result.ok, true);
    assert.equal(result.empty, true);
    assert.equal(result.emptyConfirmations, 2);
    assert.ok(readCount >= 3, `expected before + two independent samples, got ${readCount}`);
  } finally { f.close(); }
});

test('wechat channels separates verified work identity from an empty comment collection', async () => {
  const f = fixture();
  try {
    const workId = 'export/real-empty-work';
    const currentFeed = { objectId: workId, exportId: workId, commentCount: 0 };
    const store = {
      currentExportId: workId,
      currentFeed,
      currentFeedIndex: 0,
      commentFeeds: [currentFeed],
      commentList: [],
      isFeedLoading: false,
      isCommentLoading: false
    };
    const feeds = [feedElement({ title: '真实空评论作品', time: '2026/08/18 12:10', count: 0, className: 'comment-feed-wrap active-feed' })];
    const scope = vueBackedCommentScope({ feedsVm: { commentStore: store }, feeds, comments: [], detailTitle: '真实空评论作品' });

    const state = await f.adapter.readWechatCommentRuntimeState(scope);

    assert.equal(state.workIdentityVerified, true);
    assert.equal(state.sourceVerified, false);
    assert.equal(state.visibleCommentCount, 0);
    assert.deepEqual(state.commentIds, []);
  } finally { f.close(); }
});

test('wechat channels opens a work with verified levelTwoComment replies', async () => {
  const f = fixture();
  try {
    const workId = 'export/work-with-opened-level-two';
    const rootCommentId = '14990267272420071610';
    const replyCommentId = '14990267272420071611';
    const currentFeed = { objectId: workId, exportId: workId, commentCount: 2 };
    const store = {
      currentExportId: workId,
      currentFeed,
      currentFeedIndex: 0,
      commentFeeds: [currentFeed],
      commentList: [{ commentId: rootCommentId, levelTwoComment: [{ commentId: replyCommentId, levelTwoComment: [] }] }],
      isFeedLoading: false,
      isCommentLoading: false
    };
    const feeds = [feedElement({ title: '打开二级回复作品', time: '2026/08/18 12:15', count: 2, className: 'comment-feed-wrap active-feed' })];
    const comments = [
      commentElement({ store, commentId: rootCommentId, content: '用户评论' }),
      commentElement({ store, commentId: replyCommentId, content: '作者回复' })
    ];
    const scope = vueBackedCommentScope({ feedsVm: {}, feeds, comments, detailTitle: '打开二级回复作品' });

    const result = await f.adapter.openWechatCommentVideoRow(scope, {
      index: 0,
      visible: true,
      title: '打开二级回复作品',
      sourceVideoKey: workId,
      sourceVerified: true
    }, { timeoutMs: 50 });

    assert.equal(result.ok, true);
    assert.equal(result.reason, 'COMMENT_VIDEO_SELECTED_STABLE');
    assert.equal(result.sourceContext.sourceVerified, true);
    assert.deepEqual(result.runtimeState.storeCommentIds, [rootCommentId, replyCommentId]);
  } finally { f.close(); }
});

test('wechat channels resets empty confirmation after a loading sample', async () => {
  const f = fixture();
  try {
    const workId = 'export/interrupted-empty-work';
    let readCount = 0;
    let evidenceCount = 0;
    const target = {
      async isVisible() { return true; },
      async click() {},
      async evaluate(callback) { return callback({ className: 'comment-feed-wrap active-feed' }); }
    };
    const scope = {
      locator() { return { nth() { return target; } }; },
      async waitForTimeout() {}
    };
    const state = { currentExportId: workId, activeIndex: 0, currentFeedIndex: 0, commentFingerprint: 'empty-fingerprint', visibleCommentCount: 0, workIdentityVerified: true, sourceVerified: false, selectionIdentityConsistent: true, isFeedLoading: false, isCommentLoading: false };
    const evidenceSequence = [
      { panelVisible: true, explicitEmpty: true, loadingOrLoadMoreVisible: false, visibleCommentCount: 0, signature: '暂无评论' },
      { panelVisible: true, explicitEmpty: false, loadingOrLoadMoreVisible: true, visibleCommentCount: 0, signature: '加载中' },
      { panelVisible: true, explicitEmpty: true, loadingOrLoadMoreVisible: false, visibleCommentCount: 0, signature: '暂无评论' },
      { panelVisible: true, explicitEmpty: true, loadingOrLoadMoreVisible: false, visibleCommentCount: 0, signature: '暂无评论' }
    ];
    f.adapter.resolveWechatCommentScope = async () => ({ ok: true, scope });
    f.adapter.readWechatCommentRuntimeState = async () => { readCount += 1; return { ...state }; };
    f.adapter.readWechatCommentPanelEvidence = async () => evidenceSequence[Math.min(evidenceCount++, evidenceSequence.length - 1)];

    const result = await f.adapter.openWechatCommentVideoRow(scope, {
      index: 0,
      visible: true,
      title: '被加载状态打断的空作品',
      sourceVideoKey: workId,
      sourceVerified: true
    }, { timeoutMs: 50, allowStableEmpty: true });

    assert.equal(result.ok, true);
    assert.equal(result.emptyConfirmations, 2);
    assert.ok(evidenceCount >= 4, `loading sample must reset the sequence, got ${evidenceCount} samples`);
    assert.ok(readCount >= 5, `expected before + four loop samples, got ${readCount}`);
  } finally { f.close(); }
});

test('wechat channels can confirm switching between two empty works', async () => {
  const f = fixture();
  try {
    const oldWorkId = 'export/old-empty-work';
    const targetWorkId = 'export/target-empty-work';
    let readCount = 0;
    const target = {
      async isVisible() { return true; },
      async click() {},
      async evaluate(callback) { return callback({ className: 'comment-feed-wrap active-feed' }); }
    };
    const scope = {
      locator() { return { nth() { return target; } }; },
      async waitForTimeout() {}
    };
    f.adapter.resolveWechatCommentScope = async () => ({ ok: true, scope });
    f.adapter.readWechatCommentRuntimeState = async () => {
      readCount += 1;
      return readCount === 1
        ? { currentExportId: oldWorkId, activeIndex: 0, currentFeedIndex: 0, commentFingerprint: 'empty-fingerprint', visibleCommentCount: 0, workIdentityVerified: true, sourceVerified: false, selectionIdentityConsistent: true, isFeedLoading: false, isCommentLoading: false }
        : { currentExportId: targetWorkId, activeIndex: 1, currentFeedIndex: 1, commentFingerprint: 'empty-fingerprint', visibleCommentCount: 0, workIdentityVerified: true, sourceVerified: false, selectionIdentityConsistent: true, isFeedLoading: false, isCommentLoading: false };
    };
    f.adapter.readWechatCommentPanelEvidence = async () => ({ panelVisible: true, explicitEmpty: true, loadingOrLoadMoreVisible: false, visibleCommentCount: 0, signature: '暂无评论' });

    const result = await f.adapter.openWechatCommentVideoRow(scope, {
      index: 1,
      visible: true,
      title: '目标空作品',
      sourceVideoKey: targetWorkId,
      sourceVerified: true
    }, { timeoutMs: 50, allowStableEmpty: true });

    assert.equal(result.ok, true);
    assert.equal(result.empty, true);
    assert.equal(result.sourceContext.sourceVideoKey, targetWorkId);
  } finally { f.close(); }
});

test('wechat channels rejects a wrong selected work even when its comment panel is empty', async () => {
  const f = fixture();
  try {
    const expectedWorkId = 'export/expected-empty-work';
    const wrongWorkId = 'export/wrong-empty-work';
    const target = {
      async isVisible() { return true; },
      async click() {},
      async evaluate(callback) { return callback({ className: 'comment-feed-wrap active-feed' }); }
    };
    const scope = {
      locator() { return { nth() { return target; } }; },
      async waitForTimeout() {}
    };
    const state = { currentExportId: wrongWorkId, activeIndex: 0, currentFeedIndex: 0, commentFingerprint: 'empty-fingerprint', visibleCommentCount: 0, workIdentityVerified: true, sourceVerified: false, selectionIdentityConsistent: true, isFeedLoading: false, isCommentLoading: false };
    f.adapter.resolveWechatCommentScope = async () => ({ ok: true, scope });
    f.adapter.readWechatCommentRuntimeState = async () => ({ ...state });
    f.adapter.readWechatCommentPanelEvidence = async () => ({ panelVisible: true, explicitEmpty: true, loadingOrLoadMoreVisible: false, visibleCommentCount: 0, signature: '暂无评论' });

    const result = await f.adapter.openWechatCommentVideoRow(scope, {
      index: 0,
      visible: true,
      title: '预期空作品',
      sourceVideoKey: expectedWorkId,
      sourceVerified: true
    }, { timeoutMs: 50, allowStableEmpty: true });

    assert.equal(result.ok, false);
    assert.equal(result.reason, 'COMMENT_VIDEO_ID_MISMATCH');
  } finally { f.close(); }
});

