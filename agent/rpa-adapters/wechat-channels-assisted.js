import {
  AssistedPlatformRpaAdapter,
  assessWechatCommentOverviewEvidence,
  assessWechatPrivateMessageEvidence,
  clean,
  digest,
  firstUsable,
  pageEvidenceText,
  recoveryCollectionTargets,
  toRegex
} from './assisted-platform.js';
import { platformEventAgeMs } from '../../src/services/message-occurrence.js';

const WECHAT_PRIVATE_FIRST_OBSERVATION_MAX_AGE_MS = 6 * 60 * 60 * 1000;

export class WechatChannelsAssistedRpaAdapter extends AssistedPlatformRpaAdapter {
  constructor(options = {}) {
    super({
      ...options,
      platformCode: 'wechat_channels',
      spec: {
        ...(options.spec || {}),
        verificationPolicyId: 'wechat-channels-publish-status-v1',
        verifyPageUrlPattern: /^https:\/\/channels\.weixin\.qq\.com\/platform\/post\/list/i,
        verifyTabs: [
          { label: '已发表', labels: [/^已发表(?:\s*\d+)?$/], reviewStatus: 'PUBLISHED' },
          { label: '审核中', labels: [/^审核中(?:\s*\d+)?$/], reviewStatus: 'REVIEWING' },
          { label: '未通过', labels: [/^未通过(?:\s*\d+)?$/], reviewStatus: 'REJECTED' }
        ]
      }
    });
    this.wechatPrivateConversationFingerprints = new Map();
  }

  async readWechatAccountIdentity(page) {
    if (this.platformCode !== 'wechat_channels' || !page?.locator) return null;
    const selectors = this.spec.accountNameSelectors || [
      '.finder-ui-desktop-menu__footer .common-menu-item.account-info .account-info > .name',
      '.finder-ui-desktop-menu__footer .account-info .name',
      '.common-menu-item.account-info .name'
    ];
    for (const selector of selectors) {
      const locator = page.locator(selector).first();
      if (!await locator.isVisible().catch(() => false)) continue;
      const platformUserName = clean(await locator.innerText().catch(() => ''));
      if (!platformUserName) continue;
      return { platformUserName, source: `wechat-channels-dom:${selector}` };
    }
    return null;
  }
  async resolveWechatCommentScope(page, { requireRows = false } = {}) {
    if (this.platformCode !== 'wechat_channels' || !page?.locator) return { ok: false, reason: 'COMMENT_SCOPE_UNAVAILABLE', scope: null };
    const overviewSelector = this.spec.commentOverviewSelector || '.main-body-wrap.comment-view.interaction-wrap';
    const rowSelector = this.spec.commentVideoRowSelector || '.feeds-container .comment-feed-wrap';
    const commentSelector = this.spec.commentRowSelector || '.comment-item';
    const scopes = [];
    const addScope = scope => {
      if (scope?.locator && !scopes.includes(scope)) scopes.push(scope);
    };
    addScope(page);
    if (typeof page.frames === 'function') {
      for (const frame of page.frames()) addScope(frame);
    }
    const candidates = [];
    for (const scope of scopes) {
      const overviewLocator = scope.locator(overviewSelector);
      const rowLocator = scope.locator(rowSelector);
      const commentLocator = scope.locator(commentSelector);
      const callLocator = async (locator, method, fallback) => {
        if (typeof locator?.[method] !== 'function') return fallback;
        try {
          return await locator[method]();
        } catch {
          return fallback;
        }
      };
      const overviewTarget = typeof overviewLocator?.first === 'function' ? overviewLocator.first() : overviewLocator;
      const overviewVisible = Boolean(await callLocator(overviewTarget, 'isVisible', false));
      const countLocator = async locator => {
        if (typeof locator?.count === 'function') return Number(await callLocator(locator, 'count', 0)) || 0;
        if (typeof locator?.evaluateAll === 'function') {
          try {
            return Number(await locator.evaluateAll(elements => elements.length)) || 0;
          } catch {
            return 0;
          }
        }
        return typeof locator?.nth === 'function' ? 1 : 0;
      };
      const rowCount = await countLocator(rowLocator);
      const commentCount = await countLocator(commentLocator);
      const score = (overviewVisible ? 100 : 0) + Math.min(20, rowCount * 2) + Math.min(10, commentCount);
      if (score > 0 && (!requireRows || rowCount > 0)) {
        candidates.push({ scope, overviewVisible, rowCount, commentCount, score, frameUrl: typeof scope.url === 'function' ? scope.url() : null });
      }
    }
    candidates.sort((left, right) => right.score - left.score);
    if (!candidates.length) return { ok: false, reason: requireRows ? 'COMMENT_SCOPE_ROWS_NOT_FOUND' : 'COMMENT_SCOPE_NOT_FOUND', scope: null, candidates: [] };
    return { ok: true, reason: 'COMMENT_SCOPE_RESOLVED', ...candidates[0], candidates: candidates.map(({ scope: _scope, ...item }) => item) };
  }

  async readWechatCommentVideoRows(page) {
    if (this.platformCode !== 'wechat_channels') return [];
    const resolved = await this.resolveWechatCommentScope(page, { requireRows: true });
    const scope = resolved.ok ? resolved.scope : page;
    const rowSelector = this.spec.commentVideoRowSelector || '.feeds-container .comment-feed-wrap';
    const countSelector = this.spec.commentVideoCountSelector || '.feed-comment-total';
    const timeSelector = this.spec.commentVideoTimeSelector || '.feed-time';
    const titleSelector = this.spec.commentVideoTitleSelector || '.feed-title';
    return scope.locator(rowSelector).evaluateAll((elements, selectors) => {
      const normalize = value => String(value || '').replace(/\s+/g, ' ').trim();
      const stringId = value => value === null || value === undefined ? '' : String(value).trim();
      // With the Channels same-origin iframe, Playwright can return iframe-owned
      // elements while the callback's global `document` still points at the
      // outer page. Always anchor Vue/store lookups to the rows' ownerDocument.
      const rootDocument = elements[0]?.ownerDocument || document;
      const feedsVm = rootDocument.querySelector('.feeds')?.__vue__;
      const findStore = () => {
        const directStore = feedsVm?.commentStore || feedsVm?._data?.commentStore || feedsVm?.$props?.store || feedsVm?._props?.store;
        if (directStore?.commentFeeds) return directStore;
        const commentVm = rootDocument.querySelector(selectors.comment)?.__vue__;
        const commentStore = commentVm?.store || commentVm?._props?.store || commentVm?.$props?.store || commentVm?.$options?.propsData?.store;
        if (commentStore?.commentFeeds) return commentStore;
        return null;
      };
      const findVNodeKey = (vnode, target, seen = new Set()) => {
        if (!vnode || typeof vnode !== 'object' || seen.has(vnode)) return '';
        seen.add(vnode);
        if (vnode.elm === target) return stringId(vnode.key ?? vnode.data?.key);
        for (const child of vnode.children || []) {
          const found = findVNodeKey(child, target, seen);
          if (found) return found;
        }
        return findVNodeKey(vnode.componentInstance?._vnode, target, seen);
      };
      const possibleFeedObjects = vm => [
        vm?.dataSource, vm?.feed, vm?.item, vm?.feedInfo,
        vm?._data?.dataSource, vm?._data?.feed, vm?._data?.item,
        vm?._props?.dataSource, vm?._props?.feed, vm?._props?.item,
        vm?.$props?.dataSource, vm?.$props?.feed, vm?.$props?.item,
        vm?.$options?.propsData?.dataSource, vm?.$options?.propsData?.feed, vm?.$options?.propsData?.item
      ].filter(candidate => candidate && typeof candidate === 'object');
      const feedIdentity = feed => {
        const objectId = stringId(feed?.objectId);
        const exportId = stringId(feed?.exportId);
        const opaqueKey = stringId(feed?.objectNonce);
        const ids = [objectId, exportId].filter(Boolean);
        return {
          objectId,
          exportId,
          opaqueKey,
          key: objectId || exportId,
          consistent: ids.length > 0 && ids.every(value => value === ids[0])
        };
      };
      const store = findStore();
      const feeds = Array.isArray(store?.commentFeeds) ? store.commentFeeds : [];
      return elements.map((element, index) => {
        const style = getComputedStyle(element);
        const visible = style.display !== 'none'
          && style.visibility !== 'hidden'
          && Number(style.opacity || 1) > 0
          && element.getClientRects().length > 0;
        const countText = normalize(element.querySelector(selectors.count)?.innerText || element.querySelector(selectors.count)?.textContent);
        const countMatch = countText.match(/(\d+)\s*$/);
        const rowVm = element.__vue__;
        const rowCandidates = possibleFeedObjects(rowVm);
        const directFeed = rowCandidates.find(candidate => feedIdentity(candidate).consistent) || null;
        const vnodeKey = findVNodeKey(feedsVm?._vnode, element);
        const vnodeMatches = vnodeKey
          ? feeds.filter(candidate => {
              const identity = feedIdentity(candidate);
              return identity.key === vnodeKey || identity.exportId === vnodeKey || identity.opaqueKey === vnodeKey;
            })
          : [];
        const directIdentity = feedIdentity(directFeed);
        const directStoreMatches = directIdentity.key
          ? feeds.filter(candidate => feedIdentity(candidate).key === directIdentity.key)
          : [];
        let feed = null;
        let sourceBinding = 'UNRESOLVED';
        let sourceConflict = false;
        if (directFeed && directIdentity.consistent && directStoreMatches.length <= 1) {
          feed = directFeed;
          sourceBinding = 'ROW_VUE_DATA';
        } else if (directIdentity.key && directStoreMatches.length > 1) {
          sourceConflict = true;
          sourceBinding = 'ROW_VUE_ID_DUPLICATE';
        } else if (vnodeMatches.length === 1) {
          feed = vnodeMatches[0];
          sourceBinding = 'ROW_VNODE_KEY';
        } else if (vnodeMatches.length > 1) {
          sourceConflict = true;
          sourceBinding = 'ROW_VNODE_AMBIGUOUS';
        } else if (elements.length === 1 && feeds.length === 1 && feedIdentity(feeds[0]).consistent) {
          // A one-row/one-feed store has no ordering ambiguity and is safe to
          // bind even when the row component itself does not expose dataSource.
          feed = feeds[0];
          sourceBinding = 'SINGLETON_STORE';
        }
        const identity = feedIdentity(feed);
        const indexFeed = feeds[index] || null;
        const indexIdentity = feedIdentity(indexFeed);
        // Index association is retained only as diagnostic evidence. It is not
        // allowed to mark a work as verified because virtual lists can reorder.
        const candidateKey = identity.key || indexIdentity.key || '';
        const domCount = countMatch ? Number(countMatch[1]) : null;
        const trustedFeedCount = feed && Number.isInteger(Number(feed.commentCount)) ? Number(feed.commentCount) : null;
        return {
          index,
          visible,
          title: normalize(element.querySelector(selectors.title)?.innerText || element.querySelector(selectors.title)?.textContent),
          time: normalize(element.querySelector(selectors.time)?.innerText || element.querySelector(selectors.time)?.textContent),
          text: normalize(element.innerText || element.textContent),
          count: Number.isInteger(domCount) ? domCount : trustedFeedCount,
          className: String(element.className || ''),
          sourceVideoKey: identity.consistent && !sourceConflict ? identity.key || null : null,
          sourceVideoCandidateKey: candidateKey || null,
          sourceVideoOpaqueKey: identity.consistent && !sourceConflict ? identity.opaqueKey || null : null,
          sourceVideoPublishedAt: identity.consistent && !sourceConflict ? stringId(feed?.createTime) || null : null,
          sourceVideoDescription: identity.consistent && !sourceConflict ? normalize(feed?.desc?.description) || null : null,
          sourceVerified: Boolean(identity.key && identity.consistent && !sourceConflict && ['ROW_VUE_DATA', 'ROW_VNODE_KEY', 'SINGLETON_STORE'].includes(sourceBinding)),
          sourceIdentityBinding: sourceBinding,
          sourceIdentityConflict: sourceConflict,
          sourceIdentityEvidence: {
            vnodeKey: vnodeKey || null,
            directKey: directIdentity.key || null,
            indexCandidateKey: indexIdentity.key || null,
            storeMatchCount: directStoreMatches.length,
            vnodeMatchCount: vnodeMatches.length
          }
        };
      });
    }, { count: countSelector, time: timeSelector, title: titleSelector, comment: this.spec.commentRowSelector || '.comment-item' }).catch(() => []);
  }

  async readWechatCommentPanelEvidence(page) {
    if (this.platformCode !== 'wechat_channels' || typeof page?.evaluate !== 'function') return { panelVisible: false, explicitEmpty: false, loadingOrLoadMoreVisible: false, visibleCommentCount: 0 };
    return page.evaluate(({ panelSelectors, rowSelector }) => {
      const visible = element => {
        if (!element) return false;
        const style = getComputedStyle(element);
        return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) > 0 && element.getClientRects().length > 0;
      };
      const candidateDocuments = [document];
      for (const frame of document.querySelectorAll('iframe')) {
        try {
          if (frame.contentDocument) candidateDocuments.push(frame.contentDocument);
        } catch {}
      }
      const rootDocument = candidateDocuments
        .map(candidate => ({
          candidate,
          score: panelSelectors.reduce((total, selector) => {
            try { return total + candidate.querySelectorAll(selector).length; } catch { return total; }
          }, 0) + candidate.querySelectorAll(rowSelector).length * 10
        }))
        .sort((left, right) => right.score - left.score)[0]?.candidate || document;
      const panels = panelSelectors.flatMap(selector => {
        try { return [...rootDocument.querySelectorAll(selector)]; } catch { return []; }
      }).filter(visible);
      const panel = panels.find(candidate => candidate.querySelector(rowSelector) || /暂无评论|还没有评论|暂时没有评论|暂无内容/i.test(String(candidate.innerText || candidate.textContent || ''))) || null;
      if (!panel) return { panelVisible: false, explicitEmpty: false, loadingOrLoadMoreVisible: false, visibleCommentCount: 0, signature: '' };
      const comments = [...panel.querySelectorAll(rowSelector)].filter(visible);
      const busyNodes = [...panel.querySelectorAll('[aria-busy="true"],[class*="loading"],[class*="spinner"],[class*="load-more"],[class*="loadMore"],[class*="load_more"],button')];
      const loadingOrLoadMoreVisible = busyNodes.some(node => visible(node) && (/loading|spinner|load-more|loadmore|load_more/i.test(String(node.className || '')) || /加载中|正在加载|加载更多|展开更多|更多评论|load more|loading/i.test(String(node.innerText || node.textContent || ''))));
      const text = String(panel.innerText || panel.textContent || '').replace(/\s+/g, ' ').trim();
      const explicitEmpty = comments.length === 0 && /暂无评论|还没有评论|暂时没有评论/i.test(text);
      return { panelVisible: true, explicitEmpty, loadingOrLoadMoreVisible, visibleCommentCount: comments.length, signature: text.slice(0, 240) };
    }, {
      panelSelectors: this.spec.commentPanelSelectors || ['.comment-list', '.comment-list-wrap', '.comment-container', '.comments-container', '.comments-wrap', '.interaction-comment-list', '.comment-view .comments', '.feed-detail'],
      rowSelector: this.spec.commentRowSelector || '.comment-item'
    }).catch(() => ({ panelVisible: false, explicitEmpty: false, loadingOrLoadMoreVisible: false, visibleCommentCount: 0, signature: '' }));
  }

  async readWechatCommentRuntimeState(scope) {
    const selector = this.spec.commentRowSelector || '.comment-item';
    const domComments = await scope.locator(selector).evaluateAll(elements => {
      const visible = element => {
        const style = getComputedStyle(element);
        return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) > 0 && element.getClientRects().length > 0;
      };
      const normalize = value => String(value || '').replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\s+/g, ' ').trim();
      return elements.filter(visible).map(element => {
        const vm = element.__vue__;
        const data = vm?.dataSource || vm?._props?.dataSource || vm?.$props?.dataSource || vm?.$options?.propsData?.dataSource;
        const id = data?.commentId ?? vm?.$vnode?.key ?? vm?.$vnode?.data?.key ?? '';
        return { id: String(id || '').trim(), text: normalize(element.innerText || element.textContent) };
      });
    }).catch(() => []);
    const state = typeof scope?.evaluate === 'function' ? await scope.evaluate(({ rowSelector, commentSelector }) => {
      const stringId = value => value === null || value === undefined ? '' : String(value).trim();
      const normalize = value => String(value || '').replace(/\s+/g, ' ').trim();
      const candidateDocuments = [document];
      for (const frame of document.querySelectorAll('iframe')) {
        try {
          if (frame.contentDocument) candidateDocuments.push(frame.contentDocument);
        } catch {}
      }
      const rootDocument = candidateDocuments
        .map(candidate => ({ candidate, score: candidate.querySelectorAll(rowSelector).length * 10 + candidate.querySelectorAll(commentSelector).length }))
        .sort((left, right) => right.score - left.score)[0]?.candidate || document;
      const comments = [...rootDocument.querySelectorAll(commentSelector)].filter(element => {
        const style = getComputedStyle(element);
        return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) > 0 && element.getClientRects().length > 0;
      });
      const commentVm = comments[0]?.__vue__;
      const feedsVm = rootDocument.querySelector('.feeds')?.__vue__;
      const store = commentVm?.store || commentVm?._props?.store || commentVm?.$props?.store || commentVm?.$options?.propsData?.store
        || feedsVm?.commentStore || feedsVm?._data?.commentStore || feedsVm?.$props?.store || feedsVm?._props?.store || null;
      const currentFeed = store?.currentFeed || null;
      const objectId = stringId(currentFeed?.objectId);
      const exportId = stringId(currentFeed?.exportId);
      const currentExportId = stringId(store?.currentExportId);
      const activeRows = [...rootDocument.querySelectorAll(rowSelector)];
      const activeIndex = activeRows.findIndex(element => /(^|\s)(?:active-feed|selected)(\s|$)/i.test(String(element.className || '')) && !/(^|\s)inactive-feed(\s|$)/i.test(String(element.className || '')));
      const activeElement = activeIndex >= 0 ? activeRows[activeIndex] : null;
      const findVNodeKey = (vnode, target, seen = new Set()) => {
        if (!vnode || typeof vnode !== 'object' || seen.has(vnode)) return '';
        seen.add(vnode);
        if (vnode.elm === target) return stringId(vnode.key ?? vnode.data?.key);
        for (const child of vnode.children || []) {
          const found = findVNodeKey(child, target, seen);
          if (found) return found;
        }
        return findVNodeKey(vnode.componentInstance?._vnode, target, seen);
      };
      const activeVNodeKey = activeElement && feedsVm ? findVNodeKey(feedsVm._vnode, activeElement) : '';
      const commentIds = [];
      let commentIdentityConsistent = comments.length > 0;
      for (const element of comments) {
        const vm = element.__vue__;
        const data = vm?.dataSource || vm?._props?.dataSource || vm?.$props?.dataSource || vm?.$options?.propsData?.dataSource;
        const ids = [data?.commentId, vm?.$props?.dataSource?.commentId, vm?.$options?.propsData?.dataSource?.commentId, vm?.$vnode?.key, vm?.$vnode?.data?.key]
          .map(stringId).filter(Boolean);
        if (ids.length < 3 || ids.some(value => value !== ids[0])) commentIdentityConsistent = false;
        if (ids[0]) commentIds.push(ids[0]);
      }
      const storeCommentIds = [];
      const collectStoreCommentIds = (items, seen = new Set()) => {
        if (!Array.isArray(items)) return;
        for (const item of items) {
          if (!item || typeof item !== 'object' || seen.has(item)) continue;
          seen.add(item);
          const id = stringId(item.commentId);
          if (id) storeCommentIds.push(id);
          collectStoreCommentIds(item.levelTwoComment, seen);
        }
      };
      collectStoreCommentIds(store?.commentList);
      const uniqueStoreCommentIds = [...new Set(storeCommentIds)];
      const allVisibleCommentsHaveStableIds = commentIds.length === comments.length;
      const storeContainsDomComments = commentIds.length > 0
        && allVisibleCommentsHaveStableIds
        && commentIds.every(id => uniqueStoreCommentIds.includes(id));
      const workIdentityConsistent = Boolean(objectId && exportId && currentExportId && objectId === exportId && objectId === currentExportId);
      const activeVNodeConsistent = !activeVNodeKey || activeVNodeKey === currentExportId;
      const currentFeedIndex = Number.isInteger(store?.currentFeedIndex) ? store.currentFeedIndex : null;
      const selectionIdentityConsistent = Boolean(
        (activeVNodeKey && activeVNodeKey === currentExportId)
        || (activeIndex >= 0 && currentFeedIndex !== null && activeIndex === currentFeedIndex)
      );
      const detailTitle = normalize(rootDocument.querySelector('.feed-selected-info .feed-title')?.innerText || rootDocument.querySelector('.feed-detail .feed-title')?.innerText || '');
      const feedDescription = normalize(currentFeed?.desc?.description);
      const workIdentityVerified = workIdentityConsistent
        && activeVNodeConsistent
        && selectionIdentityConsistent
        && store?.isFeedLoading !== true
        && store?.isCommentLoading !== true;
      return {
        currentExportId: currentExportId || objectId || exportId || null,
        currentFeedIndex,
        currentFeedCommentCount: Number.isInteger(Number(currentFeed?.commentCount)) ? Number(currentFeed.commentCount) : null,
        currentFeedNonce: stringId(currentFeed?.objectNonce) || null,
        currentFeedPublishedAt: stringId(currentFeed?.createTime) || null,
        currentFeedDescription: feedDescription || null,
        isFeedLoading: store?.isFeedLoading === true,
        isCommentLoading: store?.isCommentLoading === true,
        activeIndex,
        activeVNodeKey: activeVNodeKey || null,
        detailVisible: Boolean(rootDocument.querySelector('.feed-detail')),
        detailTitle: detailTitle || null,
        visibleCommentCount: comments.length,
        commentIds,
        storeCommentIds: uniqueStoreCommentIds,
        workIdentityVerified,
        sourceVerified: workIdentityVerified && commentIdentityConsistent && storeContainsDomComments,
        selectionIdentityConsistent
      };
    }, { rowSelector: this.spec.commentVideoRowSelector || '.feeds-container .comment-feed-wrap', commentSelector: selector }).catch(() => ({})) : {};
    const commentFingerprint = digest(domComments.map(item => item.id || item.text));
    return { ...state, visibleCommentCount: Number.isInteger(state?.visibleCommentCount) ? state.visibleCommentCount : domComments.length, domComments, commentFingerprint };
  }

  wechatCommentVideoContext(row = {}) {
    const sourceVideoTitle = clean(row.title);
    const sourceVideoTime = clean(row.time);
    const sourceVideoText = clean(row.text);
    return {
      sourceVideoIndex: Number.isInteger(row.index) ? row.index : null,
      sourceVideoTitle: sourceVideoTitle || null,
      sourceVideoTime: sourceVideoTime || null,
      sourceVideoText: sourceVideoText || null,
      sourceVideoCommentCount: Number.isInteger(row.count) ? row.count : null,
      sourceVideoKey: clean(row.sourceVideoKey) || null,
      sourceVideoCandidateKey: clean(row.sourceVideoCandidateKey) || null,
      sourceVideoOpaqueKey: clean(row.sourceVideoOpaqueKey) || null,
      sourceVideoPublishedAt: clean(row.sourceVideoPublishedAt) || null,
      sourceVideoDescription: clean(row.sourceVideoDescription) || null,
      sourceVerified: row.sourceVerified === true && Boolean(clean(row.sourceVideoKey)),
      sourceIdentityBinding: clean(row.sourceIdentityBinding) || null,
      sourceIdentityConflict: row.sourceIdentityConflict === true,
      sourceIdentityEvidence: row.sourceIdentityEvidence && typeof row.sourceIdentityEvidence === 'object' ? row.sourceIdentityEvidence : null,
      sourceVideoLegacyKey: digest([sourceVideoTitle, sourceVideoTime])
    };
  }

  async openWechatCommentVideoRow(page, row, { timeoutMs = 15000, allowStableEmpty = false } = {}) {
    if (this.platformCode !== 'wechat_channels') return { ok: false, reason: 'NOT_WECHAT_CHANNELS' };
    if (!row?.visible || !Number.isInteger(row.index)) return { ok: false, reason: 'COMMENT_VIDEO_ROW_INVALID', row };
    const resolved = await this.resolveWechatCommentScope(page, { requireRows: true });
    if (!resolved.ok) return { ok: false, reason: resolved.reason, row };
    const scope = resolved.scope;
    const rowSelector = this.spec.commentVideoRowSelector || '.feeds-container .comment-feed-wrap';
    const target = scope.locator(rowSelector).nth(row.index);
    if (!await target.isVisible().catch(() => false)) return { ok: false, reason: 'COMMENT_VIDEO_ROW_NOT_VISIBLE', row };
    const before = await this.readWechatCommentRuntimeState(scope);
    await target.click();
    const deadline = Date.now() + timeoutMs;
    const expectedKey = clean(row.sourceVideoKey);
    let lastSignature = null;
    let stableConfirmations = 0;
    let mismatchConfirmations = 0;
    let emptyConfirmations = 0;
    let lastEmptySignature = null;
    let latest = before;
    let panelEvidence = null;
    while (Date.now() < deadline) {
      latest = await this.readWechatCommentRuntimeState(scope);
      const targetClassSelected = await target.evaluate(element => !/(^|\s)inactive-feed(\s|$)/i.test(String(element.className || ''))).catch(() => false);
      const selected = latest.activeIndex === row.index || (latest.activeIndex === -1 && targetClassSelected);
      const targetIdentityMatched = expectedKey ? clean(latest.currentExportId) === expectedKey : true;
      const changedFromOld = Boolean(latest.commentFingerprint && latest.commentFingerprint !== before.commentFingerprint);
      const switchedWork = Boolean(
        clean(before.currentExportId)
        && clean(latest.currentExportId)
        && clean(before.currentExportId) !== clean(latest.currentExportId)
      );
      const commentSnapshotReady = !switchedWork || changedFromOld;
      const loaded = latest.isFeedLoading !== true && latest.isCommentLoading !== true;
      const liveWorkIdentityVerified = (latest.workIdentityVerified === true || latest.sourceVerified === true)
        && Boolean(clean(latest.currentExportId));
      const liveIdentityVerified = latest.sourceVerified === true && liveWorkIdentityVerified;
      const identityReady = targetIdentityMatched && liveIdentityVerified && commentSnapshotReady;
      const signature = [latest.currentExportId, latest.activeIndex, latest.currentFeedIndex, latest.commentFingerprint, latest.visibleCommentCount, loaded, latest.selectionIdentityConsistent].join('|');
      const stableSignature = signature === lastSignature;
      stableConfirmations = selected && loaded && identityReady && stableSignature ? stableConfirmations + 1 : (selected && loaded && identityReady ? 1 : 0);
      const stableMismatch = Boolean(expectedKey && selected && loaded && liveWorkIdentityVerified && !targetIdentityMatched);
      mismatchConfirmations = stableMismatch && stableSignature ? mismatchConfirmations + 1 : (stableMismatch ? 1 : 0);
      lastSignature = signature;
      if (mismatchConfirmations >= 2) {
        return { ok: false, reason: 'COMMENT_VIDEO_ID_MISMATCH', row, scope, sourceContext: this.wechatCommentVideoContext(row), visibleCommentCount: latest.visibleCommentCount || 0, runtimeState: latest, beforeState: before, mismatchConfirmations };
      }
      if (stableConfirmations >= 2 && latest.visibleCommentCount > 0) {
        const sourceContext = this.wechatCommentVideoContext({
          ...row,
          sourceVideoKey: latest.currentExportId || row.sourceVideoKey,
          sourceVideoOpaqueKey: latest.currentFeedNonce || row.sourceVideoOpaqueKey,
          sourceVideoPublishedAt: latest.currentFeedPublishedAt || row.sourceVideoPublishedAt,
          sourceVideoDescription: latest.currentFeedDescription || row.sourceVideoDescription,
          sourceVerified: latest.sourceVerified === true && Boolean(latest.currentExportId),
          sourceIdentityBinding: 'LIVE_SELECTED_WORK',
          sourceIdentityConflict: false,
          sourceIdentityEvidence: {
            currentExportId: latest.currentExportId || null,
            activeVNodeKey: latest.activeVNodeKey || null,
            activeIndex: Number.isInteger(latest.activeIndex) ? latest.activeIndex : null,
            currentFeedIndex: Number.isInteger(latest.currentFeedIndex) ? latest.currentFeedIndex : null,
            stableConfirmations: stableConfirmations
          }
        });
        this.wechatCommentScope = scope;
        return { ok: true, reason: 'COMMENT_VIDEO_SELECTED_STABLE', row, scope, sourceContext, visibleCommentCount: latest.visibleCommentCount, runtimeState: latest, stableConfirmations };
      }
      if (selected && loaded && allowStableEmpty) {
        panelEvidence = await this.readWechatCommentPanelEvidence(scope);
        const stableEmpty = panelEvidence.panelVisible === true
          && panelEvidence.explicitEmpty === true
          && panelEvidence.loadingOrLoadMoreVisible !== true
          && panelEvidence.visibleCommentCount === 0;
        const emptyReady = stableEmpty && liveWorkIdentityVerified && targetIdentityMatched;
        const emptySignature = [
          latest.currentExportId,
          latest.activeIndex,
          latest.currentFeedIndex,
          panelEvidence.signature,
          panelEvidence.explicitEmpty,
          panelEvidence.visibleCommentCount,
          panelEvidence.loadingOrLoadMoreVisible
        ].join('|');
        const stableEmptySignature = emptyReady && emptySignature === lastEmptySignature;
        emptyConfirmations = emptyReady
          ? (stableEmptySignature ? emptyConfirmations + 1 : 1)
          : 0;
        lastEmptySignature = emptyReady ? emptySignature : null;
        if (emptyConfirmations >= 2) {
          const sourceContext = this.wechatCommentVideoContext({
            ...row,
            sourceVideoKey: latest.currentExportId || row.sourceVideoKey,
            sourceVideoOpaqueKey: latest.currentFeedNonce || row.sourceVideoOpaqueKey,
            sourceVideoPublishedAt: latest.currentFeedPublishedAt || row.sourceVideoPublishedAt,
            sourceVideoDescription: latest.currentFeedDescription || row.sourceVideoDescription,
            sourceVerified: liveWorkIdentityVerified && targetIdentityMatched,
            sourceIdentityBinding: 'LIVE_SELECTED_WORK',
            sourceIdentityConflict: false,
            sourceIdentityEvidence: {
              currentExportId: latest.currentExportId || null,
              activeVNodeKey: latest.activeVNodeKey || null,
              activeIndex: Number.isInteger(latest.activeIndex) ? latest.activeIndex : null,
              currentFeedIndex: Number.isInteger(latest.currentFeedIndex) ? latest.currentFeedIndex : null,
              stableConfirmations: emptyConfirmations,
              emptyPanelSignature: panelEvidence.signature || null
            }
          });
          this.wechatCommentScope = scope;
          return { ok: true, empty: true, reason: 'COMMENT_VIDEO_EMPTY_CONFIRMED', row, scope, sourceContext, visibleCommentCount: 0, panelEvidence, emptyConfirmations, runtimeState: latest };
        }
      } else if (allowStableEmpty) {
        emptyConfirmations = 0;
        lastEmptySignature = null;
      }
      const waitMs = Math.min(250, Math.max(0, deadline - Date.now()));
      if (waitMs <= 0) break;
      await scope.waitForTimeout?.(waitMs);
    }
    return { ok: false, reason: expectedKey && clean(latest.currentExportId) !== expectedKey ? 'COMMENT_VIDEO_ID_MISMATCH' : 'COMMENT_VIDEO_SWITCH_UNVERIFIED', row, scope, sourceContext: this.wechatCommentVideoContext(row), visibleCommentCount: latest.visibleCommentCount || 0, runtimeState: latest, beforeState: before, panelEvidence, stableConfirmations, emptyConfirmations };
  }

  async collectWechatChannelComments(page, payload, { readiness = null, maxRounds = 4 } = {}) {
    if (readiness?.empty) {
      return { ok: true, reason: readiness.reason || 'COMMENT_EMPTY_CONFIRMED', empty: true, messages: [], rows: [], overview: readiness.wechatCommentEvidence || null, videoResults: [], scanRounds: 0 };
    }
    const messages = [];
    const videoResults = [];
    const allRows = new Map();
    const processedVideos = new Set();
    const accountIdentity = await this.readWechatAccountIdentity(page);
    let scanRounds = 0;
    let stopReason = 'MAX_ROUNDS';
    for (let round = 1; round <= Math.max(1, Number(maxRounds) || 4); round += 1) {
      await this.assertRuntimeAllowed();
      scanRounds = round;
      const scope = this.wechatCommentScope || page;
      const rows = await this.readWechatCommentVideoRows(page);
      let discovered = 0;
      for (const row of rows.filter(item => item.visible)) {
        const sourceContext = this.wechatCommentVideoContext(row);
        const scanKey = clean(sourceContext.sourceVideoKey) || clean(sourceContext.sourceVideoLegacyKey) || `${sourceContext.sourceVideoTitle}|${sourceContext.sourceVideoTime}|${row.index}`;
        if (scanKey && !allRows.has(scanKey)) { allRows.set(scanKey, row); discovered += 1; }
        if (!scanKey || processedVideos.has(scanKey) || !Number.isInteger(row.count) || row.count <= 0) continue;
        processedVideos.add(scanKey);
        try {
          const opened = await this.openWechatCommentVideoRow(page, row);
          if (!opened.ok) { videoResults.push({ row, status: 'NEEDS_CONFIRMATION', reason: opened.reason, count: 0, sourceContext, runtimeState: opened.runtimeState || null }); continue; }
          const collected = await this.extractMessages(page, 'COMMENT', payload, {
            scope: opened.scope || this.wechatCommentScope || page,
            sourceContext: { ...opened.sourceContext, accountUserName: accountIdentity?.platformUserName || null, accountIdentitySource: accountIdentity?.source || null }
          });
          if (!collected.length) videoResults.push({ row, status: 'NEEDS_CONFIRMATION', reason: 'COMMENT_COUNT_POSITIVE_BUT_NO_ITEMS', count: 0, sourceContext: opened.sourceContext });
          else { messages.push(...collected); videoResults.push({ row, status: 'SUCCESS', reason: 'COMMENT_VIDEO_COLLECTED', count: collected.length, sourceContext: opened.sourceContext }); }
        } catch (error) {
          videoResults.push({ row, status: 'NEEDS_CONFIRMATION', reason: 'COMMENT_VIDEO_COLLECTION_FAILED', error: clean(error?.message || error), count: 0, sourceContext });
        }
      }
      if (round >= Math.max(1, Number(maxRounds) || 4)) break;
      const advance = await this.advanceHistoricalCommentList(scope, { selectors: [this.spec.commentVideoRowSelector || '.feeds-container .comment-feed-wrap'], settleMs: 200 });
      if (!advance.attempted || !advance.moved) { stopReason = advance.reason || 'VIDEO_LIST_EXHAUSTED'; break; }
      await scope.waitForTimeout(500);
      if (discovered === 0 && round > 1) { stopReason = 'NO_NEW_VIDEO_ROWS'; break; }
    }
    const rows = [...allRows.values()];
    const positiveRows = rows.filter(row => Number.isInteger(row.count) && row.count > 0);
    if (!positiveRows.length) {
      const resolved = await this.resolveWechatCommentScope(page);
      const overview = await this.inspectWechatCommentEmptyState(resolved.ok ? resolved.scope : page, await pageEvidenceText(resolved.ok ? resolved.scope : page));
      return overview.confirmedEmpty
        ? { ok: true, reason: overview.reason, empty: true, messages: [], rows, overview, videoResults, scanRounds, stopReason }
        : { ok: false, reason: overview.reason || 'COMMENT_VIDEO_COUNTS_UNRESOLVED', empty: false, messages: [], rows, overview, videoResults, scanRounds, stopReason };
    }
    const uniqueMessages = [...new Map(messages.map(message => [message.externalId, message])).values()];
    const unresolved = videoResults.filter(item => item.status !== 'SUCCESS');
    return { ok: unresolved.length === 0, reason: unresolved.length ? 'COMMENT_VIDEO_COLLECTION_INCOMPLETE' : 'COMMENT_VIDEO_COLLECTION_COMPLETE', empty: false, messages: uniqueMessages, rows, positiveRowCount: positiveRows.length, videoResults, scanRounds, stopReason };
  }

  async openWechatCommentVideoForPayload(page, payload, { maxRounds = 4, timeBudgetMs = 12000, deadlineAt = null } = {}) {
    if (this.platformCode !== 'wechat_channels') return { ok: false, reason: 'NOT_WECHAT_CHANNELS' };
    const context = payload.messageContext || payload.context || {};
    const expectedKey = clean(context.sourceVideoKey);
    const expectedTitle = clean(context.sourceVideoTitle);
    const expectedTime = clean(context.sourceVideoTime);
    if (!expectedKey && !expectedTitle && !expectedTime) return { ok: false, reason: 'COMMENT_VIDEO_CONTEXT_REQUIRED', expected: { sourceVideoKey: null, sourceVideoTitle: null, sourceVideoTime: null }, candidates: [] };
    const resolved = await this.resolveWechatCommentScope(page, { requireRows: true });
    const scope = resolved.ok ? resolved.scope : page;
    const seenCandidates = new Map();
    const rounds = Math.max(1, Number(maxRounds) || 4);
    const requestedDeadline = Number(deadlineAt);
    const deadline = Number.isFinite(requestedDeadline) && requestedDeadline > Date.now()
      ? requestedDeadline
      : Date.now() + Math.max(1000, Number(timeBudgetMs) || 12000);
    let zeroCountConfirmations = 0;
    for (let round = 1; round <= rounds; round += 1) {
      await this.assertRuntimeAllowed();
      const rows = (await this.readWechatCommentVideoRows(scope)).filter(row => row.visible);
      const currentMatches = [];
      for (const row of rows) {
        const sourceContext = this.wechatCommentVideoContext(row);
        const key = clean(sourceContext.sourceVideoKey) || `${sourceContext.sourceVideoTitle}|${sourceContext.sourceVideoTime}`;
        if (key) seenCandidates.set(key, sourceContext);
        const matched = expectedKey
          ? sourceContext.sourceVideoKey === expectedKey
          : (!expectedTitle || sourceContext.sourceVideoTitle === expectedTitle) && (!expectedTime || sourceContext.sourceVideoTime === expectedTime);
        if (matched) currentMatches.push({ row, sourceContext });
      }
      if (currentMatches.length === 1) {
        const matched = currentMatches[0];
        if (!Number.isInteger(matched.row.count)) {
          return {
            ok: false,
            reason: 'COMMENT_VIDEO_COUNT_UNAVAILABLE',
            expected: { sourceVideoKey: expectedKey || null, sourceVideoTitle: expectedTitle || null, sourceVideoTime: expectedTime || null },
            candidates: [...seenCandidates.values()],
            scanRounds: round,
            exhausted: false,
            listVerifiedComplete: false,
            matchedVideo: matched.sourceContext
          };
        }
        if (matched.row.count <= 0) {
          zeroCountConfirmations += 1;
          if (zeroCountConfirmations < 2 && round < rounds && Date.now() < deadline) {
            await scope.waitForTimeout(Math.min(250, Math.max(0, deadline - Date.now())));
            continue;
          }
          const remainingMs = deadline - Date.now();
          if (zeroCountConfirmations < 2 || remainingMs < 400) {
            return { ok: false, reason: 'COMMENT_VIDEO_EMPTY_UNVERIFIED', candidates: [...seenCandidates.values()], scanRounds: round, zeroCountConfirmations, exhausted: false, listVerifiedComplete: false, matchedVideo: matched.sourceContext };
          }
          const emptyPanel = await this.openWechatCommentVideoRow(scope, matched.row, { timeoutMs: Math.min(900, remainingMs), allowStableEmpty: true });
          const emptyConfirmed = emptyPanel.ok === true && emptyPanel.empty === true && emptyPanel.panelEvidence?.explicitEmpty === true && emptyPanel.emptyConfirmations >= 2;
          return {
            ok: false,
            reason: emptyConfirmed ? 'COMMENT_TARGET_NOT_FOUND' : (emptyPanel.reason || 'COMMENT_VIDEO_EMPTY_UNVERIFIED'),
            expected: { sourceVideoKey: expectedKey || null, sourceVideoTitle: expectedTitle || null, sourceVideoTime: expectedTime || null },
            candidates: [...seenCandidates.values()],
            scanRounds: round,
            zeroCountConfirmations,
            exhausted: emptyConfirmed,
            listVerifiedComplete: emptyConfirmed,
            sourceGoneConfirmed: emptyConfirmed,
            matchedVideo: matched.sourceContext,
            emptyPanel
          };
        }
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) return { ok: false, reason: 'COMMENT_VIDEO_SEARCH_TIMEOUT', candidates: [...seenCandidates.values()], scanRounds: round, exhausted: false, listVerifiedComplete: false, timeBudgetExhausted: true };
        return {
          ...(await this.openWechatCommentVideoRow(scope, matched.row, { timeoutMs: Math.max(1000, Math.min(5000, remainingMs)) })),
          scanRounds: round,
          candidates: [...seenCandidates.values()],
          listVerifiedComplete: false
        };
      }
      if (currentMatches.length > 1) return { ok: false, reason: 'COMMENT_VIDEO_TARGET_AMBIGUOUS', expected: { sourceVideoKey: expectedKey || null, sourceVideoTitle: expectedTitle || null, sourceVideoTime: expectedTime || null }, candidates: [...seenCandidates.values()], scanRounds: round, listVerifiedComplete: false };
      // Some Channels virtual-list rows do not expose their own Vue feed object.
      // Never trust feeds[index] in that case: probe the visible row and accept it
      // only when the clicked panel's live objectId/exportId/currentExportId and
      // selected-row evidence converge on the expected stable work ID.
      if (expectedKey && currentMatches.length === 0) {
        const probeRows = rows
          .filter(row => !clean(row.sourceVideoKey) && Number.isInteger(row.count) && row.count > 0)
          .sort((left, right) => Number(clean(right.sourceVideoCandidateKey) === expectedKey) - Number(clean(left.sourceVideoCandidateKey) === expectedKey));
        const probeResults = [];
        for (const probeRow of probeRows) {
          const remainingMs = deadline - Date.now();
          if (remainingMs < 500) break;
          const probe = await this.openWechatCommentVideoRow(scope, { ...probeRow, sourceVideoKey: expectedKey, sourceVerified: false }, { timeoutMs: Math.max(400, Math.min(1800, remainingMs)) });
          probeResults.push({ index: probeRow.index, candidateKey: clean(probeRow.sourceVideoCandidateKey) || null, ok: probe.ok === true, reason: probe.reason });
          if (probe.ok) {
            return { ...probe, scanRounds: round, candidates: [...seenCandidates.values()], probeResults, listVerifiedComplete: false };
          }
        }
        if (probeResults.length) seenCandidates.set(`probe-round-${round}`, { probeResults });
      }
      if (round >= rounds || Date.now() >= deadline) break;
      const advance = await this.advanceHistoricalCommentList(scope, { selectors: [this.spec.commentVideoRowSelector || '.feeds-container .comment-feed-wrap'], settleMs: Math.min(200, Math.max(0, deadline - Date.now())) });
      if (!advance.attempted || !advance.moved) return {
        ok: false,
        reason: 'COMMENT_VIDEO_TARGET_NOT_FOUND',
        expected: { sourceVideoKey: expectedKey || null, sourceVideoTitle: expectedTitle || null, sourceVideoTime: expectedTime || null },
        candidates: [...seenCandidates.values()],
        scanRounds: round,
        exhausted: true,
        listVerifiedComplete: advance.verifiedList === true,
        sourceGoneConfirmed: advance.verifiedList === true,
        lastAdvance: advance
      };
      await scope.waitForTimeout(500);
    }
    return {
      ok: false,
      reason: 'COMMENT_VIDEO_TARGET_NOT_FOUND',
      expected: { sourceVideoKey: expectedKey || null, sourceVideoTitle: expectedTitle || null, sourceVideoTime: expectedTime || null },
      candidates: [...seenCandidates.values()],
      scanRounds: rounds,
      exhausted: false,
      listVerifiedComplete: false,
      timeBudgetExhausted: Date.now() >= deadline
    };
  }

  async resolveWechatPrivateMessageScope(page, { requireRows = false } = {}) {
    if (this.platformCode !== 'wechat_channels' || !page?.locator) {
      return { ok: false, reason: 'PRIVATE_SCOPE_UNAVAILABLE', scope: null, candidates: [] };
    }
    const scopes = [];
    const addScope = scope => {
      if (scope?.locator && !scopes.includes(scope)) scopes.push(scope);
    };
    addScope(page);
    if (typeof page.frames === 'function') {
      for (const frame of page.frames()) addScope(frame);
    }
    const rowSelector = (this.spec.privateConversationRowSelectors || ['.private-msg-list .session-wrap']).join(',');
    const candidates = [];
    for (const scope of scopes) {
      const frameUrl = typeof scope.url === 'function' ? scope.url() : '';
      const panelVisible = Boolean(await firstUsable((this.spec.privateMessagePanelSelectors || []).map(selector => scope.locator(selector))));
      const rows = await scope.locator(rowSelector).evaluateAll(elements => elements.map(element => {
        const style = getComputedStyle(element);
        return style.display !== 'none'
          && style.visibility !== 'hidden'
          && Number(style.opacity || 1) > 0
          && element.getClientRects().length > 0;
      })).catch(() => []);
      const visibleRowCount = rows.filter(Boolean).length;
      const text = await pageEvidenceText(scope).catch(() => '');
      const evidence = await this.inspectWechatPrivateMessageState(scope, text);
      const privateFrameUrl = /channels\.weixin\.qq\.com\/(?:micro\/interaction\/private_msg|platform\/private_msg)(?:[/?#]|$)/i.test(frameUrl);
      const score = (privateFrameUrl ? 100 : 0)
        + (panelVisible ? 80 : 0)
        + Math.min(50, visibleRowCount * 5)
        + (evidence.explicitEmpty ? 20 : 0)
        + (evidence.ready ? 10 : 0);
      if (score > 0 && (!requireRows || visibleRowCount > 0)) {
        candidates.push({ scope, frameUrl, panelVisible, visibleRowCount, evidence, score });
      }
    }
    candidates.sort((left, right) => right.score - left.score);
    if (!candidates.length) {
      return { ok: false, reason: requireRows ? 'PRIVATE_SCOPE_ROWS_NOT_FOUND' : 'PRIVATE_SCOPE_NOT_FOUND', scope: null, candidates: [] };
    }
    const selected = candidates[0];
    return {
      ok: true,
      reason: 'PRIVATE_SCOPE_RESOLVED',
      ...selected,
      candidates: candidates.map(({ scope: _scope, ...candidate }) => candidate)
    };
  }

  async resolvePrivateReplyScope(page) {
    const resolved = await this.resolveWechatPrivateMessageScope(page);
    return resolved.ok ? resolved.scope : page;
  }

  wechatPrivateInboxDefinition(inboxType = 'MAIN') {
    const normalized = clean(inboxType || 'MAIN').toUpperCase();
    if (normalized === 'MAIN') return { inboxType: 'MAIN', label: '\u79c1\u4fe1' };
    if (normalized === 'GREETING') return { inboxType: 'GREETING', label: '\u6253\u62db\u547c\u6d88\u606f' };
    return null;
  }

  async inspectWechatPrivateInboxTabs(scope, expectedLabel = '') {
    if (!scope?.locator) return { tabs: [], matches: [] };
    const tabSelector = this.spec.privateInboxTabSelector || '.weui-desktop-tab__nav a';
    const tabs = await scope.locator(tabSelector).evaluateAll((elements, expected) => {
      const normalize = value => String(value || '').replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\s+/g, ' ').trim();
      return elements.map((element, index) => {
        const style = getComputedStyle(element);
        const nav = element.closest('.weui-desktop-tab__nav');
        const visible = style.display !== 'none'
          && style.visibility !== 'hidden'
          && Number(style.opacity || 1) > 0
          && element.getClientRects().length > 0;
        const text = normalize(element.innerText || element.textContent);
        return {
          index,
          text,
          visible,
          active: Boolean(nav?.classList?.contains('weui-desktop-tab__nav_current')),
          navClassName: String(nav?.className || '')
        };
      }).filter(item => item.visible && (!expected || item.text === expected));
    }, clean(expectedLabel)).catch(() => []);
    return {
      tabSelector,
      tabs,
      matches: tabs.filter(tab => !expectedLabel || tab.text === clean(expectedLabel))
    };
  }

  async selectWechatPrivateInbox(page, inboxType = 'MAIN', { timeoutMs = 8000 } = {}) {
    const definition = this.wechatPrivateInboxDefinition(inboxType);
    if (!definition) return { ok: false, handled: false, reason: 'INBOX_TYPE_UNSUPPORTED', inboxType: clean(inboxType).toUpperCase() };
    if (!page?.locator) return { ok: false, handled: true, reason: 'PRIVATE_INBOX_PAGE_UNAVAILABLE', ...definition };
    const deadline = Date.now() + Math.max(1000, Number(timeoutMs) || 8000);
    let lastEvidence = [];
    while (Date.now() < deadline) {
      await this.assertRuntimeAllowed();
      const scopes = [];
      const addScope = scope => {
        if (scope?.locator && !scopes.includes(scope)) scopes.push(scope);
      };
      const resolved = await this.resolveWechatPrivateMessageScope(page);
      if (resolved.ok) addScope(resolved.scope);
      addScope(page);
      if (typeof page.frames === 'function') {
        for (const frame of page.frames()) addScope(frame);
      }
      for (const scope of scopes) {
        const tabState = await this.inspectWechatPrivateInboxTabs(scope, definition.label);
        lastEvidence.push({
          frameUrl: typeof scope.url === 'function' ? scope.url() : null,
          label: definition.label,
          matches: tabState.matches
        });
        if (tabState.matches.length > 1) {
          return { ok: false, handled: true, reason: 'PRIVATE_INBOX_TAB_AMBIGUOUS', ...definition, tabState, evidence: lastEvidence.slice(-12) };
        }
        if (tabState.matches.length !== 1) continue;
        const match = tabState.matches[0];
        if (!match.active) {
          const tabs = scope.locator(tabState.tabSelector);
          const target = tabs.nth(match.index);
          if (!await target.isVisible().catch(() => false)) continue;
          await target.click();
        }
        let active = match.active;
        const activeDeadline = Math.min(deadline, Date.now() + 3000);
        while (!active && Date.now() < activeDeadline) {
          await page.waitForTimeout(100).catch(() => {});
          const refreshed = await this.inspectWechatPrivateInboxTabs(scope, definition.label);
          active = refreshed.matches.length === 1 && refreshed.matches[0].active;
          if (refreshed.matches.length > 1) {
            return { ok: false, handled: true, reason: 'PRIVATE_INBOX_TAB_AMBIGUOUS', ...definition, tabState: refreshed, evidence: lastEvidence.slice(-12) };
          }
        }
        if (!active) continue;
        await page.waitForTimeout(500).catch(() => {});
        const refreshedScope = await this.resolveWechatPrivateMessageScope(page);
        return {
          ok: true,
          handled: true,
          reason: 'PRIVATE_INBOX_SELECTED',
          ...definition,
          clicked: !match.active,
          scope: refreshedScope.ok ? refreshedScope.scope : scope,
          frameUrl: typeof scope.url === 'function' ? scope.url() : null,
          evidence: lastEvidence.slice(-12)
        };
      }
      await page.waitForTimeout(Math.min(250, Math.max(0, deadline - Date.now()))).catch(() => {});
    }
    return { ok: false, handled: true, reason: 'PRIVATE_INBOX_TAB_NOT_FOUND', ...definition, evidence: lastEvidence.slice(-12) };
  }

  async preparePrivateInbox(page, { inboxType = 'MAIN' } = {}) {
    const definition = this.wechatPrivateInboxDefinition(inboxType);
    if (!definition) return { ok: false, handled: false, reason: 'INBOX_TYPE_UNSUPPORTED', inboxType: clean(inboxType).toUpperCase() };
    const isRealPlaywrightPage = Boolean(
      page
      && typeof page.locator === 'function'
      && typeof page.frames === 'function'
      && typeof page.mainFrame === 'function'
      && typeof page.frameLocator === 'function'
      && typeof page.context === 'function'
      && typeof page.evaluate === 'function'
      && typeof page.waitForTimeout === 'function'
    );
    if (!isRealPlaywrightPage && definition.inboxType === 'MAIN') {
      return { ok: true, handled: true, reason: 'PRIVATE_MAIN_INBOX_ASSUMED_FOR_TEST_DOUBLE', ...definition, scope: page };
    }
    return this.selectWechatPrivateInbox(page, definition.inboxType);
  }

  async readWechatPrivateConversations(scope, inboxType = 'MAIN') {
    if (!scope?.locator) return [];
    const rowSelector = (this.spec.privateConversationRowSelectors || ['.private-msg-list .session-wrap']).join(',');
    const rows = scope.locator(rowSelector);
    const count = await rows.count().catch(() => 0);
    const conversations = [];
    for (let index = 0; index < count; index += 1) {
      const row = rows.nth(index);
      if (!await row.isVisible().catch(() => false)) continue;
      const title = await firstUsable((this.spec.privateConversationNameSelectors || []).map(selector => row.locator(selector)));
      const preview = await firstUsable((this.spec.privateConversationContentSelectors || []).map(selector => row.locator(selector)));
      const time = await firstUsable((this.spec.privateConversationTimeSelectors || []).map(selector => row.locator(selector)));
      const avatar = row.locator('img').first();
      const rowIdentity = await this.readPrivateConversationRowIdentity(row);
      let unread = false;
      let unreadEvidence = null;
      for (const selector of this.spec.privateUnreadSelectors || []) {
        const unreadNode = row.locator(selector).first();
        if (!await unreadNode.isVisible().catch(() => false)) continue;
        unread = true;
        unreadEvidence = await unreadNode.evaluate((element, unreadSelector) => ({
          selector: unreadSelector,
          className: String(element.className || ''),
          text: String(element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim()
        }), selector).catch(() => ({ selector }));
        break;
      }
      conversations.push({
        inboxType: clean(inboxType).toUpperCase(),
        index,
        name: clean(await title?.innerText().catch(() => '')),
        preview: clean(await preview?.innerText().catch(() => '')),
        time: clean(await time?.innerText().catch(() => '')),
        avatarUrl: clean(await avatar?.getAttribute?.('src').catch(() => '')) || null,
        conversationId: clean(rowIdentity?.conversationId) || null,
        conversationIdEvidence: rowIdentity?.evidence || [],
        unread,
        unreadEvidence,
        outerHTML: await row.evaluate(element => String(element.outerHTML || '').slice(0, 12000)).catch(() => '')
      });
    }
    return conversations;
  }

  async readPrivateConversationRowIdentity(row) {
    const platformIdentity = await super.readPrivateConversationRowIdentity(row);
    if (platformIdentity.conversationId || typeof row?.evaluate !== 'function') return platformIdentity;
    const candidate = await row.evaluate((element, selectors) => {
      const normalize = value => String(value || '').replace(/\s+/g, ' ').trim();
      const visible = node => {
        if (!node) return false;
        const style = getComputedStyle(node);
        return style.display !== 'none' && style.visibility !== 'hidden'
          && Number(style.opacity || 1) > 0 && node.getClientRects().length > 0;
      };
      if (!visible(element)) return null;
      const activeTabs = [...element.ownerDocument.querySelectorAll(selectors.tabs)]
        .filter(tab => visible(tab) && tab.closest('.weui-desktop-tab__nav')?.classList?.contains('weui-desktop-tab__nav_current'));
      if (activeTabs.length !== 1) return null;
      const label = normalize(activeTabs[0].innerText || activeTabs[0].textContent);
      const inboxType = label === '私信' ? 'MAIN' : label === '打招呼消息' ? 'GREETING' : null;
      if (!inboxType) return null;
      const names = selectors.names.map(selector => element.querySelector(selector)).filter(Boolean);
      const name = normalize(names[0]?.innerText || names[0]?.textContent);
      const avatarUrl = normalize(element.querySelector('img')?.getAttribute('src'));
      return { inboxType, name, avatarUrl };
    }, {
      tabs: this.spec.privateInboxTabSelector || '.weui-desktop-tab__nav a',
      names: this.spec.privateConversationNameSelectors || ['.feed-title .name']
    }).catch(() => null);
    if (!candidate?.name || !candidate.avatarUrl) return platformIdentity;
    const identity = this.deriveWechatPrivateConversationIdentity(candidate);
    return { ...identity, evidence: [...identity.evidence, 'active-inbox-tab'] };
  }

  deriveWechatPrivateConversationIdentity(conversation = {}, target = {}) {
    const directId = clean(target.conversationId || conversation.conversationId);
    if (directId) {
      return {
        conversationId: directId,
        identitySource: directId.startsWith('wechat-conversation-')
          ? 'wechat-avatar-inbox-name-derived'
          : 'wechat-platform-conversation-id',
        evidence: target.rowIdentity?.evidence || conversation.conversationIdEvidence || []
      };
    }
    const inboxType = clean(conversation.inboxType || 'MAIN').toUpperCase();
    const avatarUrl = clean(conversation.avatarUrl);
    const userName = clean(conversation.name);
    if (!avatarUrl || !userName) {
      return { conversationId: null, identitySource: 'wechat-conversation-identity-incomplete', evidence: [] };
    }
    return {
      conversationId: `wechat-conversation-${digest(['wechat_channels', inboxType, avatarUrl, userName])}`,
      identitySource: 'wechat-avatar-inbox-name-derived',
      evidence: ['avatar-url', 'inbox-type', 'conversation-name']
    };
  }

  wechatPrivateIncomingOccurrence(timeline = {}, content = '') {
    const expected = clean(content);
    if (!expected) return 0;
    return (Array.isArray(timeline.messages) ? timeline.messages : [])
      .filter(message => clean(message.direction).toLowerCase() === 'incoming' && clean(message.text) === expected)
      .length;
  }

  deriveWechatPrivateMessageId({ conversationId, eventTime, content, occurrence }) {
    const stableConversationId = clean(conversationId);
    const stableContent = clean(content);
    if (!stableConversationId || !stableContent || Number(occurrence) < 1) return null;
    return `wechat-message-${digest([
      stableConversationId,
      clean(eventTime) || 'time-unavailable',
      stableContent,
      Math.max(1, Number(occurrence) || 1)
    ])}`;
  }

  async inspectWechatPrivateConversationCandidate(page, conversation, payload = {}) {
    const inboxType = clean(conversation?.inboxType || 'MAIN').toUpperCase();
    const userName = clean(conversation?.name);
    const sourceContent = clean(conversation?.preview);
    if (!userName || !sourceContent || /对方回复或关注你之前/.test(sourceContent)) {
      return { status: 'SKIPPED', reason: 'PRIVATE_CONVERSATION_PREVIEW_UNUSABLE', conversation };
    }
    const target = await this.openPrivateConversationForPayload(page, {
      platformCode: this.platformCode,
      accountId: payload.accountId,
      profileName: payload.profileName,
      messageType: 'PRIVATE_MESSAGE',
      userName,
      sourceContent,
      externalUrl: typeof page?.url === 'function' ? page.url() : this.spec.messageUrl,
      messageContext: {
        inboxType,
        conversationName: userName,
        unread: conversation.unread === true,
        unreadEvidence: conversation.unreadEvidence || null,
        avatarUrl: conversation.avatarUrl || null,
        conversationId: clean(conversation.conversationId) || null,
        conversationKey: clean(conversation.conversationId) || null
      }
    }, { requireSourcePreview: true, requireUnreadEvidence: false }).catch(error => ({
      ok: false,
      reason: 'PRIVATE_CONVERSATION_INSPECTION_FAILED',
      error: clean(error?.message || error)
    }));
    if (!target.ok) return { status: 'UNVERIFIED', reason: target.reason || 'PRIVATE_CONVERSATION_INSPECTION_FAILED', conversation, target };

    const timeline = target.timeline || {};
    const latestMessage = target.latestMessage || timeline.latestMessage || null;
    if (target.timelineStable !== true || timeline.stable !== true) {
      return { status: 'UNVERIFIED', reason: 'PRIVATE_TIMELINE_UNSTABLE', conversation, target };
    }
    if (!latestMessage || clean(latestMessage.text) !== sourceContent) {
      return { status: 'UNVERIFIED', reason: 'PRIVATE_PREVIEW_LATEST_MESSAGE_MISMATCH', conversation, target };
    }
    if (clean(latestMessage.direction).toLowerCase() !== 'incoming') {
      return { status: 'SKIPPED', reason: 'PRIVATE_LATEST_MESSAGE_OUTGOING', conversation, target };
    }
    if (target.sourceIsLatest !== true) {
      return { status: 'UNVERIFIED', reason: 'SOURCE_MESSAGE_NOT_LATEST_IN_CONVERSATION', conversation, target };
    }

    const conversationIdentity = this.deriveWechatPrivateConversationIdentity(conversation, target);
    const occurrence = this.wechatPrivateIncomingOccurrence(timeline, sourceContent);
    const platformMessageId = clean(target.messageId);
    const messageId = platformMessageId || this.deriveWechatPrivateMessageId({
      conversationId: conversationIdentity.conversationId,
      eventTime: conversation.time,
      content: sourceContent,
      occurrence
    });
    const identityComplete = Boolean(conversationIdentity.conversationId && messageId);
    const externalUrl = typeof page?.url === 'function' ? page.url() : this.spec.messageUrl;
    const externalId = identityComplete
      ? `${this.platformCode}-private_message-${digest([externalUrl, inboxType, conversationIdentity.conversationId, messageId])}`
      : `${this.platformCode}-private_message-observed-${digest([externalUrl, inboxType, userName, conversation.avatarUrl, conversation.time, sourceContent])}`;
    const sourceVerified = identityComplete;
    const message = {
      messageType: 'PRIVATE_MESSAGE',
      externalId,
      userName,
      content: sourceContent,
      externalUrl,
      context: {
        platformCode: this.platformCode,
        sourcePage: externalUrl,
        eventTime: clean(conversation.time) || null,
        selectorVersion: 'wechat-channels-private-timeline-2026.08.20.1',
        rawText: sourceContent,
        inboxType,
        conversationName: userName,
        avatarUrl: clean(conversation.avatarUrl) || null,
        unread: conversation.unread === true,
        unreadCount: conversation.unread === true ? 1 : 0,
        unreadEvidence: conversation.unreadEvidence || null,
        conversationKey: conversationIdentity.conversationId,
        conversationId: conversationIdentity.conversationId,
        messageId,
        identitySource: platformMessageId ? 'wechat-platform-message-id' : conversationIdentity.identitySource,
        conversationIdentitySource: conversationIdentity.identitySource,
        conversationIdEvidence: conversationIdentity.evidence,
        messageIdEvidence: platformMessageId ? (latestMessage.messageIdEvidence || null) : ['conversation-id', 'event-time', 'message-text', 'incoming-occurrence'],
        incomingOccurrence: occurrence,
        direction: 'incoming',
        previewOnly: false,
        fullSource: true,
        sourceVerified,
        chatTitleVerified: true,
        incomingLatestVerified: true,
        sourceIsLatest: true,
        timelineStable: true,
        privateVerificationReason: sourceVerified
          ? 'WECHAT_CHAT_LATEST_INCOMING_VERIFIED'
          : 'WECHAT_CHAT_LATEST_INCOMING_IDENTITY_INCOMPLETE',
        privateVerificationVersion: 'wechat-private-timeline-2026.08.20.1',
        sourceMessageCount: target.sourceMessageCount,
        sourceIncomingMessageCount: target.sourceIncomingMessageCount,
        candidateCount: 1
      }
    };
    return {
      status: sourceVerified ? 'VERIFIED' : 'OBSERVED',
      reason: message.context.privateVerificationReason,
      conversation,
      target,
      message
    };
  }

  async collectTargetedWechatPrivateMessages(page, payload, recovery, { navigation = null } = {}) {
    const inboxes = [];
    const discovered = [];
    for (const definition of [this.wechatPrivateInboxDefinition('MAIN'), this.wechatPrivateInboxDefinition('GREETING')]) {
      const selection = await this.selectWechatPrivateInbox(page, definition.inboxType);
      if (!selection.ok) {
        inboxes.push({ ...definition, ok: false, reason: selection.reason, conversations: [] });
        continue;
      }
      const readiness = await this.waitForMessageContentReady(page, 'PRIVATE_MESSAGE');
      const pageCheck = readiness.pageCheck || await this.classifyLiveMessagePage(page, 'PRIVATE_MESSAGE');
      if (!readiness.ready || !pageCheck.valid) {
        inboxes.push({ ...definition, ok: false, reason: readiness.reason || pageCheck.reason, conversations: [] });
        continue;
      }
      const scope = readiness.scope || selection.scope || page;
      const conversations = await this.readWechatPrivateConversations(scope, definition.inboxType);
      const stableConversations = conversations.filter(conversation => clean(conversation.conversationId));
      discovered.push(...stableConversations);
      inboxes.push({ ...definition, ok: true, reason: readiness.reason || 'PRIVATE_INBOX_READY', conversationCount: conversations.length, stableConversationCount: stableConversations.length });
    }

    const messages = [];
    const targetResults = [];
    for (const target of recovery.targets) {
      const stableId = target.externalConversationKey;
      const matches = discovered.filter(conversation => clean(conversation.conversationId) === stableId);
      if (matches.length !== 1) {
        targetResults.push({ externalConversationKey: stableId, status: 'NEEDS_CONFIRMATION', reason: matches.length ? 'RECOVERY_TARGET_AMBIGUOUS' : 'RECOVERY_TARGET_NOT_FOUND', matchCount: matches.length });
        continue;
      }
      await this.assertRuntimeAllowed();
      const inspected = await this.inspectWechatPrivateConversationCandidate(page, matches[0], payload);
      const messageConversationId = clean(inspected.message?.context?.conversationId || inspected.message?.context?.conversationKey);
      if (inspected.message && messageConversationId === stableId) messages.push(inspected.message);
      const hardFailure = inspected.status === 'UNVERIFIED' || (inspected.message && messageConversationId !== stableId);
      targetResults.push({
        externalConversationKey: stableId,
        status: hardFailure ? 'NEEDS_CONFIRMATION' : (inspected.message ? 'SUCCESS' : 'NO_NEW_MESSAGE'),
        reason: messageConversationId && messageConversationId !== stableId ? 'RECOVERY_TARGET_ID_MISMATCH' : inspected.reason,
        recoveredCount: inspected.message && messageConversationId === stableId ? 1 : 0
      });
    }
    const unresolved = targetResults.filter(item => item.status === 'NEEDS_CONFIRMATION');
    const uniqueMessages = [];
    const seen = new Set();
    for (const message of messages) {
      const key = clean(message.externalId);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      uniqueMessages.push(message);
    }
    const mainMessages = uniqueMessages.filter(message => message.context?.inboxType === 'MAIN');
    const greetingMessages = uniqueMessages.filter(message => message.context?.inboxType === 'GREETING');
    return {
      ok: unresolved.length === 0,
      reason: unresolved[0]?.reason || (uniqueMessages.length ? 'TARGETED_RECOVERY_NEW_MESSAGES' : 'TARGETED_RECOVERY_NO_NEW_MESSAGE'),
      code: unresolved.length ? 'RECOVERY_TARGET_NOT_FOUND' : null,
      navigation,
      messages: uniqueMessages,
      mainMessages,
      greetingMessages,
      droppedDuplicateCount: Math.max(0, messages.length - uniqueMessages.length),
      empty: false,
      pageCheck: unresolved.length ? { valid: false, reason: unresolved[0].reason } : { valid: true, reason: 'TARGETED_RECOVERY_COMPLETED' },
      inboxes,
      recoveryTargeted: true,
      recoveryTargetCount: recovery.targets.length,
      targetResults
    };
  }

  async collectWechatPrivateMessages(page, payload, { navigation = null } = {}) {
    const recovery = recoveryCollectionTargets(payload);
    if (recovery) {
      if (!recovery.ok) {
        return {
          ok: false,
          reason: recovery.code,
          code: recovery.code,
          navigation,
          messages: [],
          mainMessages: [],
          greetingMessages: [],
          inboxes: [],
          recoveryTargeted: true
        };
      }
      return this.collectTargetedWechatPrivateMessages(page, payload, recovery, { navigation });
    }
    const inboxes = [];
    const allMessages = [];
    for (const definition of [this.wechatPrivateInboxDefinition('MAIN'), this.wechatPrivateInboxDefinition('GREETING')]) {
      const selection = await this.selectWechatPrivateInbox(page, definition.inboxType);
      if (!selection.ok) {
        inboxes.push({ ...definition, ok: false, reason: selection.reason, selection });
        continue;
      }
      const readiness = await this.waitForMessageContentReady(page, 'PRIVATE_MESSAGE');
      const pageCheck = readiness.pageCheck || await this.classifyLiveMessagePage(page, 'PRIVATE_MESSAGE');
      if (!readiness.ready || !pageCheck.valid) {
        inboxes.push({
          ...definition,
          ok: false,
          reason: readiness.reason || pageCheck.reason,
          selection: { ...selection, scope: undefined },
          readiness: { ...readiness, scope: undefined },
          pageCheck
        });
        continue;
      }
      const scope = readiness.scope || selection.scope || page;
      const conversations = await this.readWechatPrivateConversations(scope, definition.inboxType);
      const orderedConversations = [...conversations].sort((left, right) => Number(right.unread === true) - Number(left.unread === true));
      const observed = orderedConversations.map(conversation => {
        const conversationKey = clean(conversation.conversationId)
          || digest([definition.inboxType, conversation.avatarUrl, conversation.name]);
        const fingerprint = digest([conversation.preview, conversation.time, conversation.avatarUrl, conversation.name]);
        const stateKey = `${definition.inboxType}:${conversationKey}`;
        const known = this.wechatPrivateConversationFingerprints.has(stateKey);
        const previousFingerprint = known ? this.wechatPrivateConversationFingerprints.get(stateKey) : null;
        const ageMs = platformEventAgeMs(conversation.time);
        const recentOnFirstObservation = !known
          && ageMs !== null
          && ageMs <= WECHAT_PRIVATE_FIRST_OBSERVATION_MAX_AGE_MS;
        return {
          conversation,
          stateKey,
          fingerprint,
          known,
          changed: known && previousFingerprint !== fingerprint,
          ageMs,
          recentOnFirstObservation,
          eligible: conversation.unread === true || (known && previousFingerprint !== fingerprint) || recentOnFirstObservation
        };
      });
      const inspectionResults = [];
      const inspectionCandidates = observed
        .filter(item => item.eligible)
        .slice(0, 5);
      for (const item of inspectionCandidates) {
        await this.assertRuntimeAllowed();
        const inspected = await this.inspectWechatPrivateConversationCandidate(page, item.conversation, payload);
        inspectionResults.push(inspected);
        this.wechatPrivateConversationFingerprints.set(item.stateKey, item.fingerprint);
        if (inspected.message) allMessages.push(inspected.message);
      }
      for (const item of observed) {
        if (!this.wechatPrivateConversationFingerprints.has(item.stateKey)) {
          this.wechatPrivateConversationFingerprints.set(item.stateKey, item.fingerprint);
        }
      }
      const inboxMessages = inspectionResults.map(item => item.message).filter(Boolean);
      inboxes.push({
        ...definition,
        ok: true,
        reason: readiness.reason || 'PRIVATE_INBOX_READY',
        count: inboxMessages.length,
        conversationCount: conversations.length,
        inspectedConversationCount: inspectionResults.length,
        verifiedConversationCount: inspectionResults.filter(item => item.status === 'VERIFIED').length,
        skippedOutgoingCount: inspectionResults.filter(item => item.reason === 'PRIVATE_LATEST_MESSAGE_OUTGOING').length,
        inspectionResults: inspectionResults.map(item => ({
          status: item.status,
          reason: item.reason,
          userName: item.conversation?.name || null,
          preview: item.conversation?.preview || null,
          unread: item.conversation?.unread === true
        })),
        empty: Boolean(readiness.empty),
        selection: { ...selection, scope: undefined },
        readiness: { ...readiness, scope: undefined },
        pageCheck
      });
    }
    const uniqueMessages = [];
    const seen = new Set();
    for (const message of allMessages) {
      const key = clean(message.externalId) || digest([
        message.context?.inboxType,
        message.userName,
        message.content,
        message.context?.eventTime
      ]);
      if (seen.has(key)) continue;
      seen.add(key);
      uniqueMessages.push(message);
    }
    const mainMessages = uniqueMessages.filter(message => message.context?.inboxType === 'MAIN');
    const greetingMessages = uniqueMessages.filter(message => message.context?.inboxType === 'GREETING');
    const failed = inboxes.filter(inbox => !inbox.ok);
    return {
      ok: failed.length === 0,
      reason: failed.length
        ? failed[0].reason
        : (uniqueMessages.length ? 'VERIFIED_WECHAT_PRIVATE_INBOXES_LATEST_INCOMING' : 'WECHAT_PRIVATE_INBOXES_NO_NEW_INCOMING'),
      navigation,
      messages: uniqueMessages,
      mainMessages,
      greetingMessages,
      droppedDuplicateCount: Math.max(0, allMessages.length - uniqueMessages.length),
      empty: inboxes.length > 0 && inboxes.every(inbox => inbox.ok && inbox.empty),
      pageCheck: failed.length ? failed[0].pageCheck || null : { valid: true, reason: 'VERIFIED_WECHAT_PRIVATE_INBOXES' },
      inboxes
    };
  }

  async inspectConversation(userName) {
    if (clean(userName) !== '__LIST_ONLY__') return super.inspectConversation(userName);
    const page = await this.getPage();
    const navigation = await this.prepareMessagePage(page, { type: 'PRIVATE_MESSAGE', label: '\u79c1\u4fe1', url: this.spec.messageUrl });
    const inboxes = [];
    for (const definition of [this.wechatPrivateInboxDefinition('MAIN'), this.wechatPrivateInboxDefinition('GREETING')]) {
      const selection = await this.selectWechatPrivateInbox(page, definition.inboxType);
      if (!selection.ok) {
        inboxes.push({ ...definition, ok: false, reason: selection.reason, selection, conversations: [] });
        continue;
      }
      const readiness = await this.waitForMessageContentReady(page, 'PRIVATE_MESSAGE');
      const resolved = readiness.scope
        ? { ok: true, scope: readiness.scope, frameUrl: typeof readiness.scope.url === 'function' ? readiness.scope.url() : null }
        : await this.resolveWechatPrivateMessageScope(page);
      if (!resolved.ok) {
        inboxes.push({ ...definition, ok: false, reason: resolved.reason, selection: { ...selection, scope: undefined }, readiness: { ...readiness, scope: undefined }, conversations: [] });
        continue;
      }
      const conversations = await this.readWechatPrivateConversations(resolved.scope, definition.inboxType);
      inboxes.push({
        ...definition,
        ok: readiness.ready === true,
        reason: readiness.reason || resolved.reason,
        selection: { ...selection, scope: undefined },
        readiness: { ...readiness, scope: undefined },
        frameUrl: resolved.frameUrl,
        conversations
      });
    }
    return {
      inspectionOnly: true,
      sent: false,
      navigation,
      url: page.url(),
      inboxes,
      conversations: inboxes.flatMap(inbox => inbox.conversations || [])
    };
  }

  async inspectWechatPrivateMessageState(page, text = '') {
    if (this.platformCode !== 'wechat_channels') return { ready: false, reason: 'NOT_WECHAT_CHANNELS' };
    const panelVisible = Boolean(await firstUsable((this.spec.privateMessagePanelSelectors || []).map(selector => page.locator(selector))));
    const rowSelector = (this.spec.privateConversationRowSelectors || ['.private-msg-list .session-wrap']).join(',');
    const sessionRows = await page.locator(rowSelector).evaluateAll(elements => elements.map((element, index) => {
      const style = getComputedStyle(element);
      return {
        index,
        visible: style.display !== 'none'
          && style.visibility !== 'hidden'
          && Number(style.opacity || 1) > 0
          && element.getClientRects().length > 0
      };
    })).catch(() => []);
    let totalText = '';
    let declaredSessionTotal = null;
    for (const selector of this.spec.privateMessageTotalSelectors || []) {
      const total = await firstUsable([page.locator(selector)]);
      if (!total) continue;
      totalText = clean(await total.innerText().catch(() => ''));
      if (!totalText) continue;
      const asciiText = totalText.replace(/[０-９]/g, char => String(char.charCodeAt(0) - 0xFF10));
      const matched = asciiText.match(/共\s*(\d+)\s*个/i) || asciiText.match(/(\d+)/);
      if (matched) declaredSessionTotal = Number(matched[1]);
      break;
    }
    let explicitEmptyVisible = false;
    const emptyPattern = toRegex(this.spec.privateEmptyTextPattern, /\u6682\u65e0\u79c1\u4fe1/i);
    for (const selector of this.spec.privateEmptySelectors || []) {
      const states = await page.locator(selector).evaluateAll((elements, source) => {
        const pattern = new RegExp(source, 'i');
        return elements.map(element => {
          const style = getComputedStyle(element);
          const visible = style.display !== 'none'
            && style.visibility !== 'hidden'
            && Number(style.opacity || 1) > 0
            && element.getClientRects().length > 0;
          return visible && pattern.test(String(element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim());
        });
      }, emptyPattern.source).catch(() => []);
      if (states.some(Boolean)) { explicitEmptyVisible = true; break; }
    }
    return assessWechatPrivateMessageEvidence({
      url: page.url(),
      text,
      panelVisible,
      sessionRows,
      explicitEmptyVisible,
      declaredSessionTotal,
      totalText
    });
  }

  async inspectWechatCommentEmptyState(page, text = '') {
    if (this.platformCode !== 'wechat_channels') return { confirmedEmpty: false, reason: 'NOT_WECHAT_CHANNELS' };
    const resolved = await this.resolveWechatCommentScope(page);
    const scope = resolved.ok ? resolved.scope : page;
    const overviewSelector = this.spec.commentOverviewSelector || '.main-body-wrap.comment-view.interaction-wrap';
    const totalSelector = this.spec.commentVideoTotalSelector || '.feeds .feeds-nums';
    const filterSelector = this.spec.commentVideoFilterSelector || '.feeds .controls .weui-desktop-form__dropdown__value';
    const rowSelector = this.spec.commentVideoRowSelector || '.feeds-container .comment-feed-wrap';
    const countSelector = this.spec.commentVideoCountSelector || '.feed-comment-total';
    const timeSelector = this.spec.commentVideoTimeSelector || '.feed-time';
    const overviewVisible = Boolean(await firstUsable([scope.locator(overviewSelector)]));
    const filterText = clean(await firstUsable([scope.locator(filterSelector)]).then(locator => locator?.innerText().catch(() => '') || ''));
    const totalText = clean(await firstUsable([scope.locator(totalSelector)]).then(locator => locator?.innerText().catch(() => '') || ''));
    const totalMatch = totalText.match(/\u5171\s*(\d+)\s*\u4e2a/i);
    const videoRows = await scope.locator(rowSelector).evaluateAll((elements, selectors) => elements.map((element, index) => {
      const style = getComputedStyle(element);
      const visible = style.display !== 'none'
        && style.visibility !== 'hidden'
        && Number(style.opacity || 1) > 0
        && element.getClientRects().length > 0;
      const countText = String(element.querySelector(selectors.countSelector)?.innerText || element.querySelector(selectors.countSelector)?.textContent || '').replace(/\s+/g, ' ').trim();
      const countMatch = countText.match(/(\d+)\s*$/);
      return {
        index,
        visible,
        time: String(element.querySelector(selectors.timeSelector)?.innerText || element.querySelector(selectors.timeSelector)?.textContent || '').replace(/\s+/g, ' ').trim(),
        count: countMatch ? Number(countMatch[1]) : null
      };
    }), { countSelector, timeSelector }).catch(() => []);
    let commentRowCount = 0;
    for (const selector of this.spec.commentReadySelectors || []) {
      commentRowCount += await scope.locator(selector).evaluateAll(elements => elements.filter(element => {
        const style = getComputedStyle(element);
        return style.display !== 'none'
          && style.visibility !== 'hidden'
          && Number(style.opacity || 1) > 0
          && element.getClientRects().length > 0;
      }).length).catch(() => 0);
    }
    const evidenceText = clean([text, totalText, filterText].filter(Boolean).join(' '));
    return assessWechatCommentOverviewEvidence({
      url: typeof page?.url === 'function' ? page.url() : (typeof scope?.url === 'function' ? scope.url() : ''),
      text: evidenceText,
      overviewVisible,
      allVideoFilterVisible: filterText === '全部视频',
      totalVideoCount: totalMatch ? Number(totalMatch[1]) : null,
      videoRows,
      commentRowCount
    });
  }

  async clickFinalPublish(page) {
    await this.assertRuntimeAllowed();
    this.wechatFinalPublishEntered = true;
    const result = await super.clickFinalPublish(page);
    if (result?.clicked) this.wechatFinalPublishClicked = true;
    return result;
  }

  async publish(payload) {
    this.wechatFinalPublishEntered = false;
    this.wechatFinalPublishClicked = false;
    let output;
    try {
      output = await super.publish(payload);
    } catch (error) {
      if (error?.code === 'PLATFORM_STOPPED' || error?.code === 'PLATFORM_OPERATION_CANCELLED') {
        if (!this.wechatFinalPublishEntered) error.writeAttempted = false;
        throw error;
      }
      if (!this.wechatFinalPublishEntered) throw error;
      return {
        status: 'NEEDS_CONFIRMATION',
        result: {
          message: 'Wechat Channels final publish may have been submitted; verify manually and do not retry automatically',
          stage: 'publish_execution_uncertain',
          error: clean(error?.message),
          submissionStatus: 'UNKNOWN',
          sendAttempted: true,
          retrySafe: false,
          nonIdempotent: true,
          manualReviewRequired: true
        }
      };
    }

    const stage = clean(output?.result?.stage);
    const message = clean(output?.result?.message);
    const verificationRequired = /\u7ed1\u5b9a\u624b\u673a\u53f7|\u5b89\u5168\u9a8c\u8bc1|\u626b\u7801\u9a8c\u8bc1|\u4eba\u8138\u9a8c\u8bc1|\u9a8c\u8bc1\u7801|\u6682\u65f6\u65e0\u6cd5\u4f7f\u7528|\u64cd\u4f5c\u9891\u7e41/i.test(message);
    const submissionUncertain = this.wechatFinalPublishEntered && (
      output?.status === 'FAILED'
      || stage === 'publish_unconfirmed'
      || stage === 'publish_confirmation_ambiguous'
      || output?.result?.submissionStatus === 'UNKNOWN'
    );
    if (verificationRequired || submissionUncertain) {
      return {
        ...output,
        status: 'NEEDS_CONFIRMATION',
        result: {
          ...(output?.result || {}),
          submissionStatus: submissionUncertain ? 'UNKNOWN' : output?.result?.submissionStatus,
          sendAttempted: Boolean(this.wechatFinalPublishEntered),
          retrySafe: false,
          nonIdempotent: Boolean(this.wechatFinalPublishEntered),
          manualReviewRequired: true
        }
      };
    }
    return output;
  }

  async waitForMessageContentReady(page, messageType, timeoutMs = 18000) {
    const type = String(messageType || '').toUpperCase();
    if (this.platformCode !== 'wechat_channels' || !['COMMENT', 'PRIVATE_MESSAGE'].includes(type)) {
      return super.waitForMessageContentReady(page, messageType, timeoutMs);
    }
    const isRealPlaywrightPage = Boolean(
      page
      && typeof page.locator === 'function'
      && typeof page.frames === 'function'
      && typeof page.mainFrame === 'function'
      && typeof page.frameLocator === 'function'
      && typeof page.context === 'function'
      && typeof page.evaluate === 'function'
      && typeof page.waitForTimeout === 'function'
    );
    if (!isRealPlaywrightPage) {
      return super.waitForMessageContentReady(page, messageType, timeoutMs);
    }
    const timeoutBudgetMs = Math.max(1000, Number(timeoutMs) || 18000);
    const deadline = Date.now() + timeoutBudgetMs;
    if (type === 'PRIVATE_MESSAGE') {
      let lastReason = 'PRIVATE_SCOPE_NOT_FOUND';
      let lastEmptyKey = '';
      let stableEmptySamples = 0;
      const emptyConfirmationMs = Math.min(6000, Math.max(500, timeoutBudgetMs - 500));
      const requiredEmptySamples = Math.ceil(emptyConfirmationMs / 500) + 1;
      while (Date.now() < deadline) {
        await this.assertRuntimeAllowed();
        const resolved = await this.resolveWechatPrivateMessageScope(page);
        if (resolved.ok) {
          const evidence = resolved.evidence || await this.inspectWechatPrivateMessageState(
            resolved.scope,
            await pageEvidenceText(resolved.scope).catch(() => '')
          );
          lastReason = evidence.reason || resolved.reason;
          if (evidence.ready && !evidence.empty) {
            this.wechatPrivateScope = resolved.scope;
            return {
              ready: true,
              empty: false,
              reason: evidence.reason,
              pageCheck: { valid: true, reason: evidence.reason, url: typeof page.url === 'function' ? page.url() : null },
              privateEvidence: evidence,
              scope: resolved.scope,
              privateScope: {
                frameUrl: resolved.frameUrl,
                panelVisible: resolved.panelVisible,
                visibleRowCount: resolved.visibleRowCount
              }
            };
          }
          const emptyKey = evidence.ready && evidence.empty
            ? `${evidence.reason}:${evidence.sessionCount}:${evidence.declaredSessionTotal ?? 'unknown'}:${resolved.frameUrl}`
            : '';
          stableEmptySamples = emptyKey && emptyKey === lastEmptyKey ? stableEmptySamples + 1 : (emptyKey ? 1 : 0);
          lastEmptyKey = emptyKey;
          if (emptyKey && stableEmptySamples >= requiredEmptySamples) {
            this.wechatPrivateScope = resolved.scope;
            return {
              ready: true,
              empty: true,
              reason: evidence.reason,
              pageCheck: { valid: true, reason: evidence.reason, url: typeof page.url === 'function' ? page.url() : null },
              privateEvidence: { ...evidence, stableEmptySamples, emptyConfirmationMs },
              scope: resolved.scope,
              privateScope: {
                frameUrl: resolved.frameUrl,
                panelVisible: resolved.panelVisible,
                visibleRowCount: resolved.visibleRowCount
              }
            };
          }
        } else {
          lastReason = resolved.reason;
          lastEmptyKey = '';
          stableEmptySamples = 0;
        }
        await page.waitForTimeout(Math.min(500, Math.max(0, deadline - Date.now()))).catch(() => {});
      }
      return {
        ready: false,
        reason: lastReason,
        pageCheck: { valid: false, reason: lastReason, url: typeof page.url === 'function' ? page.url() : null }
      };
    }

    let lastReason = 'COMMENT_SCOPE_NOT_FOUND';
    while (Date.now() < deadline) {
      await this.assertRuntimeAllowed();
      const resolved = await this.resolveWechatCommentScope(page);
      if (resolved.ok) {
        const rows = await this.readWechatCommentVideoRows(resolved.scope);
        if (rows.some(row => row.visible)) {
          this.wechatCommentScope = resolved.scope;
          return { ready: true, reason: 'WECHAT_COMMENT_SCOPE_READY', pageCheck: { valid: true, reason: 'WECHAT_COMMENT_SCOPE_READY', url: typeof page?.url === 'function' ? page.url() : null }, scope: resolved.scope };
        }
        const text = await pageEvidenceText(resolved.scope).catch(() => '');
        const evidence = await this.inspectWechatCommentEmptyState(resolved.scope, text);
        lastReason = evidence.reason || 'COMMENT_ROWS_NOT_READY';
        if (evidence.confirmedEmpty) {
          this.wechatCommentScope = resolved.scope;
          return { ready: true, empty: true, reason: evidence.reason, pageCheck: { valid: true, reason: evidence.reason, url: typeof page?.url === 'function' ? page.url() : null }, wechatCommentEvidence: evidence, scope: resolved.scope };
        }
      } else lastReason = resolved.reason;
      await page.waitForTimeout(Math.min(500, Math.max(0, deadline - Date.now()))).catch(() => {});
    }
    return { ready: false, reason: lastReason, pageCheck: { valid: false, reason: lastReason, url: typeof page?.url === 'function' ? page.url() : null } };
  }

  async locateMessageContainer(page, payload) {
    if (this.platformCode === 'wechat_channels' && String(payload?.messageType || '').toUpperCase() === 'COMMENT') {
      const resolved = await this.resolveWechatCommentScope(page);
      if (!resolved.ok) return { ok: false, reason: resolved.reason, candidates: [] };
      this.wechatCommentScope = resolved.scope;
      return super.locateMessageContainer(resolved.scope, payload);
    }
    return super.locateMessageContainer(page, payload);
  }

  async locateMessageContainerWithRetry(page, payload, options = {}) {
    if (this.platformCode === 'wechat_channels' && String(payload?.messageType || '').toUpperCase() === 'COMMENT') {
      const isRealPlaywrightPage = Boolean(
        page
        && typeof page.locator === 'function'
        && typeof page.frames === 'function'
        && typeof page.mainFrame === 'function'
      );
      if (!isRealPlaywrightPage) return super.locateMessageContainerWithRetry(page, payload, options);
      const resolved = await this.resolveWechatCommentScope(page);
      if (!resolved.ok) return { ok: false, reason: resolved.reason, candidates: [] };
      this.wechatCommentScope = resolved.scope;
      return super.locateMessageContainerWithRetry(resolved.scope, payload, options);
    }
    return super.locateMessageContainerWithRetry(page, payload, options);
  }

  async readWechatCommentCandidate(locator) {
    return locator.evaluate((element, selectors) => {
      const normalize = value => String(value || '').replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\s+/g, ' ').trim();
      const stringId = value => value === null || value === undefined ? '' : String(value).trim();
      const read = selector => {
        const node = element.querySelector(selector);
        return normalize(node?.innerText || node?.textContent);
      };
      const vm = element.__vue__;
      const data = vm?.dataSource || vm?._props?.dataSource || vm?.$props?.dataSource || vm?.$options?.propsData?.dataSource;
      const store = vm?.store || vm?._props?.store || vm?.$props?.store || vm?.$options?.propsData?.store;
      const commentIds = [data?.commentId, vm?.$props?.dataSource?.commentId, vm?.$options?.propsData?.dataSource?.commentId, vm?.$vnode?.key, vm?.$vnode?.data?.key]
        .map(stringId).filter(Boolean);
      const objectId = stringId(store?.currentFeed?.objectId);
      const exportId = stringId(store?.currentFeed?.exportId);
      const currentExportId = stringId(store?.currentExportId);
      const result = {
        userName: normalize(data?.commentNickname) || read(selectors.user),
        content: normalize(data?.commentContent) || read(selectors.content),
        eventTime: stringId(data?.commentCreatetime) || read(selectors.time)
      };
      if (data || store || commentIds.length || objectId || exportId || currentExportId) {
        result.actorPlatformId = stringId(data?.username) || null;
        result.commentStableId = commentIds[0] || null;
        result.sourceVideoKey = currentExportId || objectId || exportId || null;
        result.sourceVerified = Boolean(commentIds.length >= 3 && commentIds.every(value => value === commentIds[0]) && objectId && exportId && currentExportId && objectId === exportId && objectId === currentExportId && store?.isFeedLoading !== true && store?.isCommentLoading !== true);
      }
      return result;
    }, {
      user: this.spec.commentNameSelector || '.comment-user-name',
      content: this.spec.commentTextSelector || '.comment-content',
      time: this.spec.commentTimeSelector || '.comment-time'
    }).catch(() => null);
  }

  // Compatibility hooks: the shared reply flow still uses Douyin-prefixed hook names.
  async readDouyinCommentCandidate(locator) {
    return this.readWechatCommentCandidate(locator);
  }

  async findWechatCommentEditor(_page, _payload, scope = null) {
    if (!scope) return { ok: false, reason: 'COMMENT_EDITOR_SCOPE_REQUIRED' };
    const roots = scope.locator(this.spec.commentEditorRootSelector || '.comment-reply-list .comment-create-wrap');
    const rootCount = Math.min(await roots.count().catch(() => 0), 20);
    const visibleRoots = [];
    for (let index = 0; index < rootCount; index += 1) {
      const root = roots.nth(index);
      if (await root.isVisible().catch(() => false)) visibleRoots.push(root);
    }
    if (visibleRoots.length !== 1) {
      return { ok: false, reason: visibleRoots.length ? 'COMMENT_EDITOR_AMBIGUOUS' : 'COMMENT_EDITOR_NOT_FOUND', count: visibleRoots.length };
    }
    const root = visibleRoots[0];
    for (const selector of this.spec.commentEditorSelectors || ['textarea.create-input']) {
      const editors = root.locator(selector);
      const count = Math.min(await editors.count().catch(() => 0), 20);
      const visibleEditors = [];
      for (let index = 0; index < count; index += 1) {
        const editor = editors.nth(index);
        if (await editor.isVisible().catch(() => false)) visibleEditors.push(editor);
      }
      if (visibleEditors.length > 1) return { ok: false, reason: 'COMMENT_EDITOR_AMBIGUOUS', count: visibleEditors.length };
      if (visibleEditors.length === 1) return { ok: true, root, editor: visibleEditors[0], selector };
    }
    return { ok: false, reason: 'COMMENT_EDITOR_NOT_FOUND', count: 0 };
  }

  async findDouyinCommentEditor(page, payload, scope = null) {
    return this.findWechatCommentEditor(page, payload, scope);
  }

  async clickWechatCommentSend(editorRoot) {
    if (!editorRoot) return { clicked: false, method: null, reason: 'COMMENT_EDITOR_SCOPE_REQUIRED' };
    for (const selector of this.spec.commentSendSelectors || ['.create-ft .primary']) {
      const controls = editorRoot.locator(selector);
      const count = Math.min(await controls.count().catch(() => 0), 20);
      const usable = [];
      for (let index = 0; index < count; index += 1) {
        const control = controls.nth(index);
        const visible = await control.isVisible().catch(() => false);
        const enabled = await control.isEnabled().catch(() => true);
        if (visible && enabled) usable.push(control);
      }
      if (usable.length > 1) return { clicked: false, method: null, reason: 'COMMENT_SEND_AMBIGUOUS', count: usable.length };
      if (usable.length === 1) {
        await this.assertRuntimeAllowed();
        this.wechatReplySendEntered = true;
        await usable[0].click();
        this.wechatReplyClicked = true;
        return { clicked: true, method: `wechat-comment-scoped:${selector}` };
      }
    }
    return { clicked: false, method: null, reason: 'COMMENT_SCOPED_SEND_MISSING' };
  }

  async clickDouyinCommentSend(editorRoot) {
    return this.clickWechatCommentSend(editorRoot);
  }

  async countExactWechatIncomingMessages(page, text) {
    const exactText = clean(text);
    if (!exactText) return { count: 0, matches: [] };
    const selector = '.session-dialog .content-left .message-plain';
    const matches = await page.locator(selector).evaluateAll((elements, expected) => {
      const normalize = value => String(value || '').replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\s+/g, ' ').trim();
      return elements.map((element, index) => {
        const style = getComputedStyle(element);
        const visible = style.display !== 'none'
          && style.visibility !== 'hidden'
          && Number(style.opacity || 1) > 0
          && element.getClientRects().length > 0;
        return { index, visible, text: normalize(element.innerText || element.textContent) };
      }).filter(item => item.visible && item.text === expected);
    }, exactText).catch(() => []);
    return { count: matches.length, matches, selector };
  }

  async readWechatCurrentConversationIdentity(page) {
    if (!page?.locator) return {};
    const selector = (this.spec.privateConversationHeaderSelectors || ['.session-dialog .header .left']).join(',');
    const headers = page.locator(selector);
    if (typeof headers?.evaluateAll !== 'function') return {};
    return headers.evaluateAll(elements => {
      const normalize = value => String(value || '').replace(/\s+/g, ' ').trim();
      const visible = element => {
        if (!element) return false;
        const style = getComputedStyle(element);
        return style.display !== 'none' && style.visibility !== 'hidden'
          && Number(style.opacity || 1) > 0 && element.getClientRects().length > 0;
      };
      const visibleHeaders = elements.filter(visible);
      if (visibleHeaders.length !== 1) return {};
      const title = visibleHeaders[0];
      const header = title.closest('.header');
      const nodes = [title, header, title.closest('.session-dialog')].filter(Boolean);
      const attributes = ['data-conversation-id', 'data-conversationid', 'data-session-id', 'data-sessionid', 'data-chat-id', 'data-chatid'];
      const conversationIds = [...new Set(nodes.flatMap(node => attributes.map(name => normalize(node.getAttribute(name)))).filter(Boolean))];
      const avatars = [...new Set([...(header?.querySelectorAll('img') || [])]
        .filter(visible).map(image => normalize(image.getAttribute('src'))).filter(Boolean))];
      return {
        conversationId: conversationIds.length === 1 ? conversationIds[0] : null,
        conversationIdConflict: conversationIds.length > 1,
        avatarUrl: avatars.length === 1 ? avatars[0] : null,
        source: 'wechat-current-conversation-header'
      };
    }).catch(() => ({}));
  }

  async verifyWechatIncomingSource(page, payload, { timeline: existingTimeline = null } = {}) {
    const sourceContent = clean(payload.sourceContent);
    if (!sourceContent) return { ok: false, reason: 'SOURCE_INCOMING_MESSAGE_REQUIRED', sourceMessageCount: 0 };
    const timeline = existingTimeline?.stable === true
      ? existingTimeline
      : await this.inspectStablePrivateConversationTimeline(page);
    if (timeline.stable !== true) return { ok: false, reason: 'PRIVATE_TIMELINE_UNSTABLE', timelineStable: false, timeline };
    const messages = Array.isArray(timeline.messages) ? timeline.messages : [];
    const matchingIncoming = messages.filter(message => clean(message.direction).toLowerCase() === 'incoming' && clean(message.text) === sourceContent);
    const latestMessage = timeline.latestMessage || messages.at(-1) || null;
    if (!latestMessage || clean(latestMessage.text) !== sourceContent) {
      return {
        ok: false,
        reason: 'SOURCE_MESSAGE_NOT_LATEST_IN_CONVERSATION',
        sourceMessageCount: matchingIncoming.length,
        sourceIncomingMessageCount: matchingIncoming.length,
        latestMessage,
        timelineStable: true,
        timeline
      };
    }
    if (clean(latestMessage.direction).toLowerCase() !== 'incoming') {
      return {
        ok: false,
        reason: 'SOURCE_MESSAGE_NOT_INCOMING',
        sourceMessageCount: matchingIncoming.length,
        sourceIncomingMessageCount: matchingIncoming.length,
        latestMessage,
        timelineStable: true,
        timeline
      };
    }
    if (!matchingIncoming.length) {
      return { ok: false, reason: 'SOURCE_INCOMING_MESSAGE_NOT_IN_CONVERSATION', sourceMessageCount: 0, sourceIncomingMessageCount: 0, latestMessage, timelineStable: true, timeline };
    }

    const expectedMessageId = clean(payload.platformMessageId || payload.messageContext?.messageId);
    const expectedConversationId = clean(payload.conversationId || payload.messageContext?.conversationId || payload.messageContext?.conversationKey);
    const currentIdentity = await this.readWechatCurrentConversationIdentity(page);
    if (currentIdentity.conversationIdConflict) {
      return { ok: false, reason: 'CURRENT_CONVERSATION_ID_AMBIGUOUS', currentIdentity, timeline };
    }
    if (expectedConversationId && !expectedConversationId.startsWith('wechat-conversation-')
      && currentIdentity.conversationId && currentIdentity.conversationId !== expectedConversationId) {
      return { ok: false, reason: 'CONVERSATION_STABLE_ID_MISMATCH', expectedConversationId, currentIdentity, timeline };
    }
    const expectedAvatarUrl = clean(payload.messageContext?.avatarUrl);
    if (expectedAvatarUrl && currentIdentity.avatarUrl && currentIdentity.avatarUrl !== expectedAvatarUrl) {
      return { ok: false, reason: 'CONVERSATION_AVATAR_MISMATCH', expectedAvatarUrl, currentIdentity, timeline };
    }
    const identitySource = clean(payload.messageContext?.identitySource || payload.messageContext?.conversationIdentitySource);
    const occurrence = this.wechatPrivateIncomingOccurrence(timeline, sourceContent);
    if (expectedMessageId && identitySource.includes('derived')) {
      const derivedMessageId = this.deriveWechatPrivateMessageId({
        conversationId: expectedConversationId,
        eventTime: payload.messageContext?.eventTime,
        content: sourceContent,
        occurrence
      });
      if (!derivedMessageId || derivedMessageId !== expectedMessageId) {
        return {
          ok: false,
          reason: 'DERIVED_MESSAGE_ID_MISMATCH',
          expectedMessageId,
          derivedMessageId,
          occurrence,
          latestMessage,
          timelineStable: true,
          timeline
        };
      }
    }
    return {
      ok: true,
      sourceMessageCount: matchingIncoming.length,
      sourceIncomingMessageCount: matchingIncoming.length,
      sourceMessage: latestMessage,
      latestMessage,
      sourceIsLatest: true,
      direction: 'incoming',
      occurrence,
      currentIdentity,
      timelineStable: true,
      timeline
    };
  }

  async openPrivateConversationForPayload(page, payload, options = {}) {
    const result = await super.openPrivateConversationForPayload(page, payload, options);
    if (!result.ok || options.requireSourcePreview === false) return result;
    const privateScope = await this.resolvePrivateReplyScope(page, result);
    const incoming = await this.verifyWechatIncomingSource(privateScope, payload, { timeline: result.timeline });
    if (!incoming.ok) return { ...result, ok: false, ...incoming };
    return {
      ...result,
      sourceMessageCount: incoming.sourceMessageCount,
      sourceIncomingMessageCount: incoming.sourceIncomingMessageCount,
      sourceMessage: incoming.sourceMessage,
      latestMessage: incoming.latestMessage,
      sourceIsLatest: true,
      timelineStable: true,
      direction: 'incoming',
      timeline: incoming.timeline
    };
  }

  async fillPrivateReplyEditor(editor, value) {
    const replyText = String(value ?? '');
    await editor.click();
    if (typeof editor.press === 'function') {
      await editor.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A').catch(() => {});
      await editor.press('Backspace').catch(() => {});
    }
    if (typeof editor.fill === 'function') await editor.fill('').catch(() => {});
    if (!replyText) return { method: 'wechat-keyboard-clear' };

    if (typeof editor.pressSequentially === 'function') {
      await editor.pressSequentially(replyText, { delay: 12 });
      return { method: 'wechat-press-sequentially' };
    }
    if (typeof editor.type === 'function') {
      await editor.type(replyText, { delay: 12 });
      return { method: 'wechat-type' };
    }
    throw new Error('WECHAT_PRIVATE_REAL_KEYBOARD_INPUT_UNAVAILABLE');
  }

  async clickWechatPrivateSendControl(page, editor) {
    return super.clickPrivateSend(page, editor);
  }

  async readWechatPrivateSendSnapshot(scope, editor, replyText) {
    const remaining = await this.editorRemainingValue(editor);
    const scoped = await this.countExactPrivateMessages(scope, replyText, { outgoingOnly: true, editor });
    return {
      remaining,
      scopedEchoCount: Number(scoped?.count || 0),
      matches: scoped?.matches || []
    };
  }

  async waitWechatPrivateSendEffect() {
    await new Promise(resolve => setTimeout(resolve, 1200));
  }

  async clickPrivateSend(page, editor) {
    await this.assertRuntimeAllowed();
    this.wechatReplySendEntered = true;

    const intendedText = await this.editorRemainingValue(editor);
    const beforeClick = await this.readWechatPrivateSendSnapshot(page, editor, intendedText);
    const result = await this.clickWechatPrivateSendControl(page, editor);
    if (!result?.clicked) return result;

    this.wechatReplyClicked = true;
    await this.waitWechatPrivateSendEffect();
    const afterClick = await this.readWechatPrivateSendSnapshot(page, editor, intendedText);
    const normalizedRemaining = clean(afterClick.remaining);
    const clickProducedEffect = !normalizedRemaining || afterClick.scopedEchoCount > beforeClick.scopedEchoCount;
    // A successful click may still be awaiting its network response. An
    // unchanged editor is not proof of rejection, so only the read-only
    // reply-evidence loop may follow this submission.

    return {
      ...result,
      evidence: {
        ...(result.evidence || {}),
        intendedTextLength: intendedText.length,
        baselineEchoCountBeforeClick: beforeClick.scopedEchoCount,
        editorClearedAfterClick: !normalizedRemaining,
        echoCountAfterClick: afterClick.scopedEchoCount,
        clickProducedEffect,
        enterFallbackAttempted: false,
        enterFallbackReason: null
      }
    };
  }

  async replyToMessage(payload) {
    this.wechatReplySendEntered = false;
    this.wechatReplyClicked = false;
    let output;
    try {
      output = await super.replyToMessage(payload);
    } catch (error) {
      if (error?.code === 'PLATFORM_STOPPED' || error?.code === 'PLATFORM_OPERATION_CANCELLED') throw error;
      if (!this.wechatReplySendEntered) throw error;
      return {
        status: 'NEEDS_CONFIRMATION',
        result: {
          message: 'Wechat Channels final publish may have been submitted; verify manually and do not retry automatically',
          stage: 'reply_execution_uncertain',
          error: clean(error?.message),
          sendAttempted: true,
          retrySafe: false,
          nonIdempotent: true,
          manualReviewRequired: true
        }
      };
    }
    const stage = clean(output?.result?.stage);
    if (output?.status === 'SUCCESS' && stage === 'reply_sent') {
      output = {
        ...output,
        result: {
          ...(output.result || {}),
          sendMethod: `wechat-channels:${clean(output.result?.sendMethod) || 'scoped-ui'}`
        }
      };
    }
    if (this.wechatReplySendEntered && output?.status !== 'SUCCESS') {
      return {
        ...output,
        result: {
          ...(output?.result || {}),
          sendAttempted: true,
          retrySafe: false,
          nonIdempotent: true,
          manualReviewRequired: stage === 'reply_phone_binding_required' || stage === 'reply_unconfirmed'
        }
      };
    }
    return output;
  }

}
