import fs from 'node:fs';
import path from 'node:path';
import {
  AssistedPlatformRpaAdapter,
  clean,
  digest,
  firstUsable,
  isNavigationTimeoutError,
  pageEvidenceText,
  recoveryCollectionFailure,
  recoveryCollectionTargets
} from './assisted-platform.js';

const DOUYIN_VERIFY_RE = /\u9a8c\u8bc1\u7801|\u5b89\u5168\u9a8c\u8bc1|\u626b\u7801\u9a8c\u8bc1|\u5b8c\u6210\u9a8c\u8bc1|verify|captcha/i;

function patternMatches(pattern, value) {
  if (!pattern) return false;
  const expression = pattern instanceof RegExp ? new RegExp(pattern.source, pattern.flags.replace('g', '')) : new RegExp(String(pattern), 'i');
  return expression.test(String(value || ''));
}

export function classifyDouyinReplyThreadEvidence(evidence = {}, { stable = false, expectedReplyCount = 0 } = {}) {
  const authorReplies = Array.isArray(evidence.authorReplies) ? evidence.authorReplies : [];
  if (evidence.platformAuthorReplyDetected === true || authorReplies.length > 0) return 'VERIFIED_AUTHOR_REPLY';
  const expected = Math.max(1, Number(expectedReplyCount) || 0);
  const observed = Math.max(0, Number(evidence.nestedReplyCount) || 0);
  // “收起回复”只能证明界面进入了展开态；还必须稳定看到预期数量的子回复，
  // 才能安全断言其中没有作者回复，避免加载未完成时误发。
  if (evidence.replyThreadExpanded === true && stable && observed >= expected) return 'VERIFIED_NO_AUTHOR_REPLY';
  if (evidence.replyThreadCollapsed === true || evidence.replyThreadExpanded === true) return 'UNVERIFIED';
  return 'NOT_APPLICABLE';
}

export class DouyinAssistedRpaAdapter extends AssistedPlatformRpaAdapter {
  constructor(options = {}) {
    super({
      ...options,
      platformCode: 'douyin',
      spec: {
        ...(options.spec || {}),
        verificationPolicyId: 'douyin-publish-status-v1',
        verifyPageUrlPattern: /^https:\/\/creator\.douyin\.com\/creator-micro\/content\/manage/i,
        verifyTabs: [
          { label: '已发布', labels: [/^已发布(?:\s*\d+)?$/], reviewStatus: 'PUBLISHED' },
          { label: '审核中', labels: [/^审核中(?:\s*\d+)?$/], reviewStatus: 'REVIEWING' },
          { label: '未通过', labels: [/^未通过(?:\s*\d+)?$/], reviewStatus: 'REJECTED' }
        ],
        strictScopedReply: true,
        privateConversationRowSelectors: ['[data-e2e="conversation-item"]'],
        privateMessageEditorSelectors: [
          '[class*="messageEditorinputArea"][contenteditable="true"]',
          '[data-placeholder="\u53d1\u9001\u6d88\u606f"]'
        ],
        privateMessageSendSelectors: ['.e2e-send-msg-btn'],
        privateConversationBackSelectors: [
          '[class*="StackLayoutStackChatHeader"] [aria-label*="返回"]',
          '[class*="StackLayoutStackChatHeader"] [title*="返回"]',
          '[class*="StackLayoutStackChatHeader"] [class*="back"]',
          '[class*="StackLayoutStackChatHeader"] [class*="Back"]',
          '[class*="RightPanelHeader"] [aria-label*="返回"]',
          '[class*="RightPanelHeader"] [title*="返回"]',
          '[class*="RightPanelHeader"] [class*="back"]',
          '[class*="RightPanelHeader"] [class*="Back"]'
        ],
        // 首次发现只能从真实未读红点进入；后续回复会显式关闭红点复查，改用稳定消息身份校验。
        privateRequireUnreadForReply: true,
        commentEditorSelectors: [
          'textarea[placeholder="\u6709\u7231\u8bc4\u8bba\uff0c\u8bf4\u70b9\u513f\u597d\u542c\u7684\uff5e"]',
          'textarea[placeholder*="\u6709\u7231\u8bc4\u8bba"]',
          '[contenteditable="true"]'
        ],
        commentSendSelectors: ['button[class*="cmt-btn-"]'],
        // The current creator landing page exposes only an "上传视频" control.
        // Treat it as a real file-chooser trigger so Playwright injects the local
        // material into the chooser instead of merely clicking the entry button.
        fileChooserLabels: ['上传视频', '点击上传', '选择视频'],
        allowGenericFileInputFallback: false
      }
    });
    this.douyinPublishAttempted = false;
    this.douyinReplyAttempted = false;
  }

  async execute(job) {
    await this.assertRuntimeAllowed();
    return super.execute(job);
  }

  async collectMessages(payload) {
    await this.assertRuntimeAllowed();
    const requested = new Set((payload.types || ['COMMENT', 'PRIVATE_MESSAGE']).map(value => String(value).toUpperCase()));
    const targetedRecovery = recoveryCollectionTargets(payload);
    if (targetedRecovery) {
      if (!targetedRecovery.ok) return recoveryCollectionFailure(targetedRecovery.code, '抖音旧会话恢复任务缺少平台稳定会话标识，已禁止泛扫历史会话');
      if (requested.size !== 1 || !requested.has('PRIVATE_MESSAGE')) {
        return recoveryCollectionFailure('RECOVERY_PRIVATE_MESSAGE_ONLY', '抖音旧会话恢复任务只允许定向采集私信');
      }
      return this.collectTargetedRecoveryConversations(payload, targetedRecovery);
    }
    const recoveryState = { recoveries: [], postNavigationInspected: false };
    const previousRecoveryState = this.douyinOpenConversationRecoveryState;
    this.douyinOpenConversationRecoveryState = recoveryState;
    let privatePage = null;

    try {
      // 采集流程随后可能跳去评论页，所以先检查当前已经打开的私信会话。
      // 同时还会在常规流程真正进入私信页并完成加载后再检查一次，避免 Agent
      // 从 about:blank、评论页或内容管理页启动时，只因为消息已经被标为已读就永久漏采。
      if (requested.has('PRIVATE_MESSAGE')) {
        try {
          const page = await this.getPage();
          privatePage = page;
          recoveryState.recoveries.push({
            ...(await this.collectLatestIncomingFromOpenPrivateConversation(page, payload)),
            inspectionPhase: 'BEFORE_NORMAL_COLLECTION'
          });
        } catch (error) {
          recoveryState.recoveries.push({
            attempted: true,
            recoveredCount: 0,
            reason: 'OPEN_CONVERSATION_INSPECTION_FAILED',
            error: clean(error?.message || error),
            inspectionPhase: 'BEFORE_NORMAL_COLLECTION'
          });
        }
      }

      const output = await super.collectMessages(payload);
      privatePage ||= this.existingPrivateMessagePage();
      const recovery = requested.has('PRIVATE_MESSAGE')
        ? this.combineOpenConversationRecoveries(recoveryState.recoveries)
        : { attempted: false, recoveredCount: 0, reason: 'PRIVATE_MESSAGE_NOT_REQUESTED' };
      return this.mergeOpenConversationRecovery(output, recovery);
    } finally {
      if (requested.has('PRIVATE_MESSAGE')) {
        this.lastPrivateInboxRestore = await this.restorePrivateInboxOverview(privatePage || this.existingPrivateMessagePage(), {
          source: 'MESSAGE_COLLECTION_FINALLY'
        }).catch(error => ({
          attempted: true,
          restored: false,
          exited: false,
          reason: 'PRIVATE_INBOX_RESTORE_FAILED',
          error: clean(error?.message || error)
        }));
      }
      if (this.douyinOpenConversationRecoveryState === recoveryState) {
        this.douyinOpenConversationRecoveryState = previousRecoveryState;
      }
    }
  }

  async collectTargetedRecoveryConversations(payload, recovery) {
    const page = await this.getPage();
    try {
    const messages = [];
    const targetResults = [];
    for (const target of recovery.targets) {
      await this.assertRuntimeAllowed();
      const stableId = target.externalConversationKey;
      const opened = await this.openPrivateConversationForPayload(page, {
        ...payload,
        messageType: 'PRIVATE_MESSAGE',
        userName: target.userName,
        sourceContent: '',
        messageContext: {
          ...(payload.messageContext || {}),
          conversationId: stableId,
          conversationKey: stableId,
          conversationName: target.userName || null,
          inboxType: payload.messageContext?.inboxType || 'MAIN'
        }
      }, { requireSourcePreview: false, requireUnreadEvidence: false }).catch(error => ({
        ok: false,
        reason: 'RECOVERY_TARGET_OPEN_FAILED',
        error: clean(error?.message || error)
      }));
      if (!opened.ok || clean(opened.conversationId) !== stableId) {
        targetResults.push({
          externalConversationKey: stableId,
          status: 'NEEDS_CONFIRMATION',
          reason: !opened.ok ? (opened.reason || 'RECOVERY_TARGET_NOT_FOUND') : 'RECOVERY_TARGET_ID_MISMATCH',
          actualConversationId: clean(opened.conversationId) || null
        });
        continue;
      }
      const collected = await this.collectLatestIncomingFromOpenPrivateConversation(page, payload, {
        expectedHeaderName: clean(opened.headerName || opened.conversationName || target.userName),
        expectedConversationId: stableId,
        conversationIdEvidence: opened.rowIdentity?.evidence || []
      });
      const accepted = (Array.isArray(collected.messages) ? collected.messages : collected.message ? [collected.message] : [])
        .filter(message => clean(message?.context?.conversationId || message?.context?.conversationKey) === stableId);
      messages.push(...accepted);
      targetResults.push({
        externalConversationKey: stableId,
        status: accepted.length ? 'SUCCESS' : 'NO_NEW_MESSAGE',
        reason: collected.reason,
        recoveredCount: accepted.length
      });
    }
    const unresolved = targetResults.filter(item => item.status === 'NEEDS_CONFIRMATION');
    const status = unresolved.length ? 'NEEDS_CONFIRMATION' : 'SUCCESS';
    const evidence = await this.evidence(
      payload,
      unresolved.length ? '抖音旧会话定向恢复存在无法可靠定位的目标' : '抖音旧会话定向恢复完成：' + messages.length + ' 条',
      page,
      unresolved.length ? 'recovery_target_unverified' : 'recovery_targeted',
      { targetResults, recoveryTargeted: true }
    );
    return {
      status,
      result: {
        ...evidence,
        code: unresolved.length ? 'RECOVERY_TARGET_NOT_FOUND' : null,
        messages,
        typeResults: [{ type: 'PRIVATE_MESSAGE', status, reason: unresolved[0]?.reason || 'TARGETED_RECOVERY_COMPLETED', count: messages.length }],
        successfulScopeNames: unresolved.length ? [] : ['PRIVATE_MESSAGE'],
        partialScopeNames: unresolved.length && messages.length ? ['PRIVATE_MESSAGE'] : [],
        recoveryTargeted: true,
        recoveryTargetCount: recovery.targets.length,
        targetResults
      }
    };
    } finally {
      this.lastPrivateInboxRestore = await this.restorePrivateInboxOverview(page, {
        source: 'TARGETED_RECOVERY_FINALLY'
      }).catch(error => ({
        attempted: true,
        restored: false,
        exited: false,
        reason: 'PRIVATE_INBOX_RESTORE_FAILED',
        error: clean(error?.message || error)
      }));
    }
  }

  async waitForMessageContentReadyBase(page, type) {
    return super.waitForMessageContentReady(page, type);
  }

  async readPrivateConversationRowSnapshot(row) {
    const snapshot = await super.readPrivateConversationRowSnapshot(row);
    if (!snapshot?.visible) return snapshot;
    if (!row || typeof row.evaluate !== 'function') return snapshot;
    const fallback = await row.evaluate((element, options) => {
      const normalize = value => String(value || '').normalize('NFC').replace(/[​﻿︎️]/g, '').replace(/\s+/g, ' ').trim();
      const pick = selectors => {
        for (const selector of selectors || []) {
          try {
            const node = element.querySelector(selector);
            if (node) return node;
          } catch {}
        }
        return null;
      };
      const visible = node => {
        if (!node) return false;
        try {
          const style = getComputedStyle(node);
          return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) > 0 && node.getClientRects().length > 0;
        } catch {
          return false;
        }
      };
      const nameNode = pick(options.nameSelectors);
      const previewNode = pick(options.contentSelectors);
      const unreadNode = pick(options.unreadSelectors);
      return {
        userName: normalize(nameNode?.innerText || nameNode?.textContent),
        preview: normalize(previewNode?.innerText || previewNode?.textContent),
        unread: visible(unreadNode),
        nameSelectorMatched: Boolean(nameNode),
        previewSelectorMatched: Boolean(previewNode)
      };
    }, {
      nameSelectors: this.spec.privateConversationNameSelectors || [],
      contentSelectors: this.spec.privateConversationContentSelectors || [],
      unreadSelectors: this.spec.privateUnreadSelectors || []
    }).catch(() => null);
    return {
      ...snapshot,
      userName: snapshot.userName || clean(fallback?.userName),
      preview: snapshot.preview || clean(fallback?.preview),
      unread: snapshot.unread === true || fallback?.unread === true,
      readSources: [
        ...(snapshot.readSources || []),
        ...((fallback?.nameSelectorMatched || fallback?.previewSelectorMatched) ? ['row-dom-selector-fallback'] : [])
      ]
    };
  }

  async waitForPrivateConversationRows(privateScope, payload, options = {}) {
    const maxAttempts = Math.max(2, Math.min(20, Number(this.spec.privateConversationListReadAttempts) || 12));
    const settleMs = Math.max(150, Math.min(1000, Number(this.spec.privateConversationListSettleMs) || 450));
    const stableRequired = Math.max(2, Math.min(4, Number(this.spec.privateConversationListStableSamples) || 2));
    const missingDecisionAttempt = Math.max(stableRequired, Math.min(maxAttempts, Number(this.spec.privateConversationListMissingDecisionAttempt) || 4));
    let previousSignature = null;
    let stableSamples = 0;
    let last = null;
    const diagnostics = [];

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      await this.assertRuntimeAllowed();
      const current = await super.waitForPrivateConversationRows(privateScope, payload, options);
      last = current;
      const signature = JSON.stringify((current.rowSnapshots || []).map(item => ({
        index: item.index,
        userName: clean(item.candidate?.userName),
        preview: clean(item.candidate?.preview),
        unread: item.candidate?.unread === true
      })));
      stableSamples = signature && signature === previousSignature ? stableSamples + 1 : 1;
      previousSignature = signature;
      const matchingRowsComplete = current.namedRows.length > 0 && current.namedRows.every(item => (
        clean(item.candidate?.userName)
        && (options.requireSourcePreview === false || clean(item.candidate?.preview))
      ));
      const visibleRowsComplete = current.rowSnapshots.length > 0 && current.rowSnapshots.every(item => (
        clean(item.candidate?.userName)
        && (options.requireSourcePreview === false || clean(item.candidate?.preview))
      ));
      diagnostics.push({
        attempt,
        rowCount: current.count,
        visibleRowCount: current.rowSnapshots.length,
        namedRowCount: current.namedRows.length,
        exactRowCount: current.exactRows.length,
        stableSamples,
        matchingRowsComplete,
        visibleRowsComplete
      });
      const targetStable = matchingRowsComplete && visibleRowsComplete && stableSamples >= stableRequired;
      const missingStable = attempt >= missingDecisionAttempt && visibleRowsComplete && stableSamples >= stableRequired;
      if (targetStable || missingStable) {
        return { ...current, stable: true, attempts: attempt, stableSamples, diagnostics };
      }
      if (attempt < maxAttempts && typeof privateScope?.waitForTimeout === 'function') {
        await privateScope.waitForTimeout(settleMs);
      }
    }

    return {
      ...(last || { rowSelector: (this.spec.privateConversationRowSelectors || ['[data-e2e="conversation-item"]']).join(','), count: 0, rowSnapshots: [], namedRows: [], exactRows: [] }),
      stable: false,
      attempts: maxAttempts,
      stableSamples,
      diagnostics,
      deferred: true,
      reason: 'CONVERSATION_LIST_LOADING_TIMEOUT'
    };
  }

  async waitForPrivateConversationHeader(page, userName) {
    const maxAttempts = Math.max(2, Math.min(16, Number(this.spec.privateConversationHeaderReadAttempts) || 10));
    const settleMs = Math.max(150, Math.min(1000, Number(this.spec.privateConversationHeaderSettleMs) || 450));
    let last = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      await this.assertRuntimeAllowed();
      const current = await super.waitForPrivateConversationHeader(page, userName);
      last = current;
      if (current.ok && current.editorFound !== false) return { ...current, attempts: attempt };
      if (current.reason === 'CONVERSATION_HEADER_AMBIGUOUS') return { ...current, attempts: attempt };
      if (attempt < maxAttempts && typeof page?.waitForTimeout === 'function') await page.waitForTimeout(settleMs);
    }
    return { ...(last || { ok: false, reason: 'CONVERSATION_HEADER_MISMATCH' }), attempts: maxAttempts, loadingWaitExhausted: true };
  }

  async inspectStablePrivateConversationTimeline(page, options = {}) {
    return super.inspectStablePrivateConversationTimeline(page, {
      attempts: options.attempts ?? 7,
      settleMs: options.settleMs ?? 500
    });
  }

  existingPrivateMessagePage(page = null) {
    const usable = candidate => {
      if (!candidate) return null;
      if (typeof candidate.isClosed === 'function' && candidate.isClosed()) return null;
      return candidate;
    };
    return usable(page) || usable(this.channelPages?.get('PRIVATE_MESSAGE')) || null;
  }

  async inspectPrivateInboxOverviewState(page) {
    if (!page || typeof page.locator !== 'function') {
      return {
        onPrivatePage: false,
        conversationOpen: false,
        overviewVisible: false,
        panelClosed: false,
        reason: 'PRIVATE_PAGE_UNAVAILABLE'
      };
    }
    const sourcePage = typeof page.url === 'function' ? page.url() : '';
    if (sourcePage && !patternMatches(this.spec.privateMessagePageUrlPattern, sourcePage)) {
      return {
        onPrivatePage: false,
        conversationOpen: false,
        overviewVisible: false,
        panelClosed: false,
        sourcePage,
        reason: 'NOT_ON_DOUYIN_PRIVATE_MESSAGE_PAGE'
      };
    }
    const editor = await firstUsable(
      (this.spec.privateMessageEditorSelectors || []).map(selector => page.locator(selector))
    ).catch(() => null);
    const rows = page.locator((this.spec.privateConversationRowSelectors || ['[data-e2e="conversation-item"]']).join(','));
    const rowCount = Math.min(await rows.count().catch(() => 0), 20);
    let visibleRowCount = 0;
    for (let index = 0; index < rowCount; index += 1) {
      if (await rows.nth(index).isVisible().catch(() => false)) visibleRowCount += 1;
    }
    return {
      onPrivatePage: true,
      conversationOpen: Boolean(editor),
      overviewVisible: !editor && visibleRowCount > 0,
      panelClosed: !editor && visibleRowCount === 0,
      visibleRowCount,
      sourcePage,
      reason: editor
        ? 'PRIVATE_CONVERSATION_OPEN'
        : visibleRowCount > 0
          ? 'PRIVATE_INBOX_OVERVIEW_VISIBLE'
          : 'PRIVATE_MESSAGE_PANEL_CLOSED'
    };
  }

  async clickPrivateConversationBackByGeometry(page) {
    if (!page || typeof page.evaluate !== 'function') {
      return { clicked: false, reason: 'PRIVATE_BACK_GEOMETRY_UNAVAILABLE' };
    }
    return page.evaluate(({ headerSelectors }) => {
      const visible = element => {
        if (!element) return false;
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== 'none'
          && style.visibility !== 'hidden'
          && Number(style.opacity || 1) > 0
          && rect.width > 0
          && rect.height > 0;
      };
      const headers = [];
      for (const selector of headerSelectors || []) {
        try {
          for (const element of document.querySelectorAll(selector)) {
            if (visible(element) && !element.closest('[data-e2e="conversation-item"]')) headers.push(element);
          }
        } catch {}
      }
      const uniqueHeaders = [...new Set(headers)];
      if (uniqueHeaders.length !== 1) {
        return {
          clicked: false,
          reason: uniqueHeaders.length ? 'PRIVATE_BACK_HEADER_AMBIGUOUS' : 'PRIVATE_BACK_HEADER_MISSING',
          headerCount: uniqueHeaders.length
        };
      }
      const header = uniqueHeaders[0];
      const headerRect = header.getBoundingClientRect();
      let root = header.parentElement;
      for (let depth = 0; root && depth < 6; depth += 1, root = root.parentElement) {
        const rootRect = root.getBoundingClientRect();
        if (!visible(root) || rootRect.width < headerRect.width + 40) continue;
        const candidates = [];
        const seen = new Set();
        for (const node of root.querySelectorAll('button,[role="button"],a,svg,[class*="back"],[class*="Back"]')) {
          const target = node.closest('button,[role="button"],a') || node;
          if (seen.has(target) || !visible(target)) continue;
          seen.add(target);
          const rect = target.getBoundingClientRect();
          const targetCenterY = rect.top + rect.height / 2;
          const headerCenterY = headerRect.top + headerRect.height / 2;
          const horizontalGap = headerRect.left - rect.right;
          if (rect.right > headerRect.left - 2) continue;
          if (horizontalGap < 0 || horizontalGap > 120) continue;
          if (Math.abs(targetCenterY - headerCenterY) > 36) continue;
          if (rect.width < 8 || rect.height < 8 || rect.width > 80 || rect.height > 80) continue;
          candidates.push(target);
        }
        const uniqueCandidates = [...new Set(candidates)];
        if (uniqueCandidates.length !== 1) {
          if (uniqueCandidates.length > 1) {
            return { clicked: false, reason: 'PRIVATE_BACK_CONTROL_AMBIGUOUS', candidateCount: uniqueCandidates.length };
          }
          continue;
        }
        uniqueCandidates[0].click();
        return { clicked: true, reason: 'PRIVATE_BACK_CONTROL_CLICKED_BY_GEOMETRY', candidateCount: 1 };
      }
      return { clicked: false, reason: 'PRIVATE_BACK_CONTROL_MISSING', candidateCount: 0 };
    }, {
      headerSelectors: this.spec.privateConversationHeaderSelectors || []
    }).catch(error => ({
      clicked: false,
      reason: 'PRIVATE_BACK_GEOMETRY_FAILED',
      error: clean(error?.message || error)
    }));
  }

  async waitForPrivateInboxOverview(page, { maxChecks = 8 } = {}) {
    let state = await this.inspectPrivateInboxOverviewState(page);
    for (let check = 1; check <= maxChecks; check += 1) {
      if (!state.conversationOpen) return { ...state, checks: check };
      if (typeof page?.waitForTimeout === 'function') await page.waitForTimeout(check === 1 ? 350 : 250);
      state = await this.inspectPrivateInboxOverviewState(page);
    }
    return { ...state, checks: maxChecks };
  }

  async restorePrivateInboxOverview(page, { source = 'UNSPECIFIED' } = {}) {
    const privatePage = this.existingPrivateMessagePage(page);
    if (!privatePage) {
      return {
        attempted: false,
        restored: false,
        exited: false,
        overviewVisible: false,
        panelClosed: false,
        source,
        reason: 'PRIVATE_PAGE_NOT_ACTIVE'
      };
    }
    const before = await this.inspectPrivateInboxOverviewState(privatePage);
    if (!before.onPrivatePage) {
      return {
        attempted: false,
        restored: false,
        exited: false,
        overviewVisible: false,
        panelClosed: false,
        source,
        reason: before.reason,
        before
      };
    }
    if (!before.conversationOpen) {
      return {
        attempted: false,
        restored: true,
        exited: true,
        overviewVisible: before.overviewVisible,
        panelClosed: before.panelClosed,
        method: before.overviewVisible ? 'already-overview' : 'already-closed',
        source,
        reason: before.reason,
        before
      };
    }

    await this.assertRuntimeAllowed();
    const directBack = await firstUsable(
      (this.spec.privateConversationBackSelectors || []).map(selector => privatePage.locator(selector))
    ).catch(() => null);
    let backClick = null;
    if (directBack) {
      await directBack.click();
      backClick = { clicked: true, reason: 'PRIVATE_BACK_CONTROL_CLICKED_BY_SELECTOR' };
    } else {
      backClick = await this.clickPrivateConversationBackByGeometry(privatePage);
    }
    if (backClick.clicked) {
      const restored = await this.waitForPrivateInboxOverview(privatePage);
      if (!restored.conversationOpen) {
        return {
          attempted: true,
          restored: true,
          exited: true,
          overviewVisible: restored.overviewVisible,
          panelClosed: restored.panelClosed,
          method: 'conversation-back',
          source,
          reason: restored.overviewVisible ? 'PRIVATE_INBOX_OVERVIEW_RESTORED' : restored.reason,
          before,
          backClick,
          after: restored
        };
      }
    }

    const entry = await firstUsable(
      (this.spec.privateMessageEntrySelectors || []).map(selector => privatePage.locator(selector))
    ).catch(() => null);
    if (!entry) {
      return {
        attempted: true,
        restored: false,
        exited: false,
        overviewVisible: false,
        panelClosed: false,
        method: backClick?.clicked ? 'conversation-back' : null,
        source,
        reason: 'PRIVATE_MESSAGE_ENTRY_MISSING',
        before,
        backClick
      };
    }
    await this.assertRuntimeAllowed();
    await entry.click();
    const closed = await this.waitForPrivateInboxOverview(privatePage);
    return {
      attempted: true,
      restored: !closed.conversationOpen,
      exited: !closed.conversationOpen,
      overviewVisible: closed.overviewVisible,
      panelClosed: closed.panelClosed,
      method: 'panel-close-fallback',
      source,
      reason: !closed.conversationOpen ? 'PRIVATE_MESSAGE_PANEL_CLOSED' : 'PRIVATE_MESSAGE_PANEL_STILL_OPEN',
      before,
      backClick,
      after: closed
    };
  }

  async afterPrivateReplyConfirmed(page) {
    return this.restorePrivateInboxOverview(page, { source: 'PRIVATE_REPLY_CONFIRMED' });
  }

  async preparePrivateConversationList(page) {
    const editor = await firstUsable(
      (this.spec.privateMessageEditorSelectors || []).map(selector => page.locator(selector))
    ).catch(() => null);
    if (!editor) return { ok: true, reason: 'PRIVATE_CONVERSATION_NOT_OPEN' };
    const before = await this.inspectPrivateInboxOverviewState(page);
    if (!before.conversationOpen) return { ok: true, before };
    const restore = await this.restorePrivateInboxOverview(page, { source: 'PRIVATE_CONVERSATION_SWITCH' }).catch(async error => {
      if (['PLATFORM_STOPPED', 'PLATFORM_OPERATION_CANCELLED'].includes(error.code)) throw error;
      await this.assertRuntimeAllowed();
      return { restored: false, error: clean(error?.message || error) };
    });
    if (restore.restored && restore.panelClosed) {
      await this.prepareMessagePage(page, { type: 'PRIVATE_MESSAGE', label: '私信', url: this.spec.messageUrl });
    }
    const after = await this.inspectPrivateInboxOverviewState(page);
    return {
      ok: restore.restored === true && after.overviewVisible === true,
      reason: restore.restored && after.overviewVisible ? 'PRIVATE_INBOX_OVERVIEW_READY' : 'PRIVATE_CONVERSATION_SWITCH_BLOCKED',
      before, restore, after
    };
  }

  async readPrivateConversationRowIdentity(row) {
    const looksLikeDouyinConversationId = value => {
      const text = clean(value);
      if (!text || text.length < 8 || text.length > 256 || /\s/.test(text)) return false;
      if (/^(?:imsaascontainerid|conversationid|conversationkey|sessionid|sessionkey|chatid|chatkey)$/i.test(text)) return false;
      if (/^\d+(?::\d+){2,}$/.test(text)) return true;
      if (/^\d{8,}$/.test(text)) return true;
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(text)) return true;
      return text.length >= 16 && /\d/.test(text) && /[:|_-]/.test(text);
    };
    const inherited = await super.readPrivateConversationRowIdentity(row)
      .catch(() => ({ conversationId: null, evidence: [] }));
    if (looksLikeDouyinConversationId(inherited?.conversationId)) return inherited;
    if (!row || typeof row.evaluate !== 'function') return { conversationId: null, evidence: [] };

    // React adds a random suffix after __reactFiber$ / __reactProps$.
    // Ignore generic DOM/container IDs and keep only values shaped like stable Douyin conversation identities.
    return row.evaluate(element => {
      const stable = value => {
        const text = String(value ?? '').trim();
        return text && !/^(?:true|false|null|undefined)$/i.test(text) ? text : null;
      };
      const validConversationId = value => {
        const text = stable(value);
        if (!text || text.length < 8 || text.length > 256 || /\s/.test(text)) return null;
        if (/^(?:imsaascontainerid|conversationid|conversationkey|sessionid|sessionkey|chatid|chatkey)$/i.test(text)) return null;
        if (/^\d+(?::\d+){2,}$/.test(text)) return text;
        if (/^\d{8,}$/.test(text)) return text;
        if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(text)) return text;
        return text.length >= 16 && /\d/.test(text) && /[:|_-]/.test(text) ? text : null;
      };
      const nodes = [];
      for (let node = element, depth = 0; node && depth < 12; node = node.parentElement, depth += 1) nodes.push(node);
      const attributes = [
        'data-conversation-id', 'data-conversationid', 'data-conversation-key', 'data-conversationkey',
        'data-session-id', 'data-sessionid', 'data-chat-id', 'data-chatid'
      ];
      for (const node of nodes) {
        for (const name of attributes) {
          const value = validConversationId(node.getAttribute?.(name));
          if (value) return { conversationId: value, evidence: [`attribute:${name}`] };
        }
      }

      const wanted = new Set([
        'conversationid', 'conversationkey', 'conversationshortid', 'conversationidentifier',
        'sessionid', 'sessionkey', 'chatid', 'chatkey'
      ]);
      const seen = new WeakSet();
      const inspect = (value, depth = 0) => {
        if (!value || depth > 12 || (typeof value !== 'object' && typeof value !== 'function') || seen.has(value)) return null;
        seen.add(value);
        let entries = [];
        try { entries = Object.entries(value); } catch { return null; }
        for (const [key, child] of entries) {
          const normalizedKey = String(key || '').replace(/[^a-z0-9]/gi, '').toLowerCase();
          if (wanted.has(normalizedKey) && ['string', 'number'].includes(typeof child)) {
            const candidate = validConversationId(child);
            if (candidate) return { conversationId: candidate, evidence: [`react:${key}`] };
          }
          if (depth < 3 || /props|memoized|pending|children|next|conversation|session|chat|data|state|item|record|model/i.test(key)) {
            const nested = inspect(child, depth + 1);
            if (nested) return nested;
          }
        }
        return null;
      };
      for (const node of nodes) {
        for (const key of Object.getOwnPropertyNames(node)) {
          if (!key.startsWith('__reactFiber$') && !key.startsWith('__reactProps$')) continue;
          const root = node[key];
          const direct = inspect(root, 0);
          if (direct) return direct;
          if (!key.startsWith('__reactFiber$')) continue;
          for (let fiber = root, depth = 0; fiber && depth < 16; fiber = fiber.return, depth += 1) {
            for (const candidate of [fiber.pendingProps, fiber.memoizedProps, fiber.memoizedState, fiber.stateNode]) {
              const result = inspect(candidate, 0);
              if (result) return result;
            }
          }
        }
      }
      return { conversationId: null, evidence: [] };
    }).catch(() => ({ conversationId: null, evidence: [] }));
  }
  async waitForMessageContentReady(page, type) {
    const readiness = await this.waitForMessageContentReadyBase(page, type);
    const recoveryState = this.douyinOpenConversationRecoveryState;
    if (type === 'PRIVATE_MESSAGE' && recoveryState && !recoveryState.postNavigationInspected) {
      recoveryState.postNavigationInspected = true;
      try {
        const directRecovery = {
          ...(await this.collectLatestIncomingFromOpenPrivateConversation(page)),
          inspectionPhase: 'AFTER_PRIVATE_NAVIGATION'
        };
        recoveryState.recoveries.push(directRecovery);
        if (directRecovery.recoveredCount === 0
          && ['OPEN_CONVERSATION_HEADER_MISSING', 'OPEN_CONVERSATION_EDITOR_MISSING'].includes(directRecovery.reason)) {
          recoveryState.recoveries.push({
            ...(await this.collectIncomingFromRecentReadPrivateConversations(page)),
            inspectionPhase: 'AFTER_PRIVATE_NAVIGATION_READ_ROW_SCAN'
          });
        }
      } catch (error) {
        recoveryState.recoveries.push({
          attempted: true,
          recoveredCount: 0,
          reason: 'OPEN_CONVERSATION_POST_NAVIGATION_INSPECTION_FAILED',
          error: clean(error?.message || error),
          inspectionPhase: 'AFTER_PRIVATE_NAVIGATION'
        });
      }
    }
    return readiness;
  }

  combineOpenConversationRecoveries(recoveries = []) {
    const candidates = (Array.isArray(recoveries) ? recoveries : []).filter(Boolean);
    const messages = [];
    const stableKeys = new Map();
    for (const recovery of candidates) {
      const recoveredMessages = [
        ...(Array.isArray(recovery.messages) ? recovery.messages : []),
        ...(!Array.isArray(recovery.messages) && recovery.message ? [recovery.message] : [])
      ].filter(Boolean);
      for (const message of recoveredMessages) {
        const context = message.context || {};
        const conversationId = clean(context.conversationId || context.conversationKey);
        const messageId = clean(context.messageId);
        const stableKey = conversationId && messageId
          ? `private:${conversationId}:${messageId}`
          : clean(message.externalId);
        if (stableKey && stableKeys.has(stableKey)) {
          // A later observation may include a reply that was absent in the first snapshot.
          if (context.platformReplyDetected === true) {
            const index = stableKeys.get(stableKey);
            messages[index] = { ...message, context: { ...messages[index].context, ...context } };
          }
          continue;
        }
        if (stableKey) stableKeys.set(stableKey, messages.length);
        messages.push(message);
      }
    }
    const primary = [...candidates].reverse().find(item => (
      (Array.isArray(item.messages) && item.messages.length) || item.message
    )) || [...candidates].reverse().find(item => item.attempted === true) || candidates.at(-1) || {
      attempted: false,
      recoveredCount: 0,
      reason: 'OPEN_CONVERSATION_NOT_INSPECTED'
    };
    const reason = messages.length > 1
      ? 'OPEN_CHAT_INCOMING_AFTER_REPLY_VERIFIED'
      : messages.length === 1
        ? (messages[0].context?.platformReplyDetected === true ? 'OPEN_CHAT_PLATFORM_REPLY_DETECTED' : 'OPEN_CHAT_LATEST_INCOMING_VERIFIED')
        : primary.reason;
    return {
      ...primary,
      attempted: candidates.some(item => item.attempted === true),
      recoveredCount: messages.length,
      reason,
      messages,
      message: messages.at(-1),
      inspectionPhases: candidates.map(item => item.inspectionPhase).filter(Boolean),
      recoveryEntryVersion: 'douyin-open-chat-entry-2026.08.23.3'
    };
  }

  async readOpenDouyinConversationHeader(page) {
    const names = new Map();
    const selectors = this.spec.privateConversationHeaderSelectors || [];
    for (const selector of selectors) {
      const locators = page?.locator?.(selector);
      const count = Math.min(await locators?.count?.().catch(() => 0) || 0, 20);
      for (let index = 0; index < count; index += 1) {
        const locator = locators.nth(index);
        if (!await locator.isVisible().catch(() => false)) continue;
        const candidate = await locator.evaluate(element => ({
          text: String(element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim(),
          insideConversationRow: Boolean(element.closest?.('[data-e2e="conversation-item"]'))
        })).catch(async () => ({
          text: clean(await locator.innerText().catch(() => '')),
          insideConversationRow: false
        }));
        const name = clean(candidate?.text);
        if (!name || candidate?.insideConversationRow) continue;
        names.set(name, { selector, index });
      }
    }
    if (!names.size) return { ok: false, reason: 'OPEN_CONVERSATION_HEADER_MISSING' };
    if (names.size !== 1) return { ok: false, reason: 'OPEN_CONVERSATION_HEADER_AMBIGUOUS', candidates: [...names.keys()] };

    const headerName = [...names.keys()][0];
    const verified = await this.locatePrivateConversationHeader(page, headerName)
      .catch(error => ({ ok: false, reason: 'OPEN_CONVERSATION_HEADER_VERIFY_FAILED', error: clean(error?.message || error) }));
    if (!verified.ok) return { ...verified, headerName };
    return { ok: true, headerName, evidence: verified.evidence || names.get(headerName) };
  }

  async locateOpenDouyinConversationIdentity(page, headerName) {
    const matches = [];
    const selectors = this.spec.privateConversationRowSelectors || ['[data-e2e="conversation-item"]'];
    for (const selector of selectors) {
      const rows = page?.locator?.(selector);
      const count = Math.min(await rows?.count?.().catch(() => 0) || 0, 100);
      for (let index = 0; index < count; index += 1) {
        const row = rows.nth(index);
        if (!await row.isVisible().catch(() => false)) continue;
        const title = await firstUsable((this.spec.privateConversationNameSelectors || []).map(nameSelector => row.locator(nameSelector)));
        const rowName = title ? clean(await title.innerText().catch(() => '')) : '';
        if (rowName !== clean(headerName)) continue;
        const identity = await this.readPrivateConversationRowIdentity(row);
        matches.push({ selector, index, conversationId: clean(identity?.conversationId) || null, evidence: identity?.evidence || [] });
      }
      if (matches.length) break;
    }
    if (!matches.length) return { ok: false, reason: 'OPEN_CONVERSATION_ROW_NOT_FOUND', conversationId: null, matches: [] };
    const conversationIds = [...new Set(matches.map(item => item.conversationId).filter(Boolean))];
    if (matches.length > 1 || conversationIds.length > 1) {
      return { ok: false, reason: 'OPEN_CONVERSATION_ROW_AMBIGUOUS', conversationId: null, matches };
    }
    return { ok: true, conversationId: conversationIds[0] || null, evidence: matches[0].evidence, matches };
  }

  buildOpenConversationIncomingMessage({ sourcePage, headerName, conversationId, timeline, sourceMessage }) {
    const content = clean(sourceMessage?.text).slice(0, 1000);
    const messageId = clean(sourceMessage?.messageId);
    if (!content || !messageId || !conversationId) return null;
    const sourceMessageCount = (timeline.messages || []).filter(message => clean(message?.text) === content).length;
    const sourceIncomingMessageCount = (timeline.messages || []).filter(message => (
      clean(message?.text) === content
      && clean(message?.direction).toLowerCase() === 'incoming'
    )).length;
    return {
      messageType: 'PRIVATE_MESSAGE',
      externalId: `${this.platformCode}-private_message-${digest([sourcePage, conversationId, messageId])}`,
      userName: headerName,
      content,
      externalUrl: sourcePage,
      context: {
        platformCode: this.platformCode,
        sourcePage,
        eventTime: null,
        selectorVersion: 'douyin-open-chat-2026.08.23.3',
        rawText: content,
        // 当前打开的会话中，抖音可能已经把消息标成已读；这里明确使用完整消息
        // 证据，不再把 unread 当作自动回复的前置条件。
        unread: false,
        unreadCount: 0,
        unreadEvidence: null,
        inboxType: 'OPEN_CONVERSATION',
        conversationName: headerName,
        conversationKey: conversationId,
        conversationId,
        messageId,
        direction: 'incoming',
        previewOnly: false,
        fullSource: true,
        sourceVerified: true,
        chatTitleVerified: true,
        collectionSource: 'OPEN_CONVERSATION_TIMELINE',
        privateVerificationReason: 'OPEN_CHAT_LATEST_INCOMING_VERIFIED',
        privateVerificationVersion: 'douyin-open-chat-2026.08.23.3',
        sourceMessageCount,
        sourceIncomingMessageCount,
        messageIdEvidence: sourceMessage.messageIdEvidence || null,
        conversationIdEvidence: sourceMessage.conversationIdEvidence || null
      }
    };
  }

  async collectLatestIncomingFromOpenPrivateConversation(page, payload = {}, options = {}) {
    const sourcePage = typeof page?.url === 'function' ? page.url() : '';
    if (!sourcePage || !patternMatches(this.spec.privateMessagePageUrlPattern, sourcePage)) {
      return { attempted: false, recoveredCount: 0, reason: 'NOT_ON_DOUYIN_PRIVATE_MESSAGE_PAGE', sourcePage };
    }

    const editor = await this.findReplyEditor(page, true).catch(() => null);
    if (!editor) return { attempted: true, recoveredCount: 0, reason: 'OPEN_CONVERSATION_EDITOR_MISSING', sourcePage };

    const header = await this.readOpenDouyinConversationHeader(page);
    if (!header.ok) return { attempted: true, recoveredCount: 0, reason: header.reason, sourcePage, header };
    const expectedHeaderName = clean(options.expectedHeaderName);
    if (expectedHeaderName && clean(header.headerName) !== expectedHeaderName) {
      return {
        attempted: true,
        recoveredCount: 0,
        reason: 'OPEN_CONVERSATION_SCANNED_HEADER_MISMATCH',
        sourcePage,
        headerName: header.headerName,
        expectedHeaderName
      };
    }

    const timeline = await this.inspectStablePrivateConversationTimeline(page);
    if (timeline.stable !== true) {
      return {
        attempted: true,
        recoveredCount: 0,
        reason: timeline.reason || 'PRIVATE_TIMELINE_UNSTABLE',
        sourcePage,
        headerName: header.headerName,
        timelineStable: false,
        messageCount: timeline.messages?.length || 0
      };
    }

    const timelineMessages = Array.isArray(timeline.messages) ? timeline.messages : [];
    const lastOutgoingIndex = timelineMessages.reduce((lastIndex, message, index) => (
      clean(message?.direction).toLowerCase() === 'outgoing' ? index : lastIndex
    ), -1);
    const incomingAfterLastOutgoing = timelineMessages
      .slice(lastOutgoingIndex + 1)
      .filter(message => clean(message?.direction).toLowerCase() === 'incoming' && clean(message?.text) && clean(message?.messageId));
    const latestMessage = timeline.latestMessage || null;
    let candidateMessages = incomingAfterLastOutgoing.length
      ? incomingAfterLastOutgoing
      : (clean(latestMessage?.direction).toLowerCase() === 'incoming' ? [latestMessage] : []);
    let observedReply = null;
    if (!candidateMessages.length && clean(latestMessage?.direction).toLowerCase() === 'outgoing') {
      const incomingIndex = timelineMessages.slice(0, lastOutgoingIndex).findLastIndex(message => (
        clean(message?.direction).toLowerCase() === 'incoming'
      ));
      const incoming = timelineMessages[incomingIndex];
      const outgoing = timelineMessages[lastOutgoingIndex];
      if (clean(incoming?.text) && clean(incoming?.messageId) && clean(outgoing?.text) && clean(outgoing?.messageId)
        && clean(outgoing.messageId) !== clean(incoming.messageId)) {
        candidateMessages = [incoming];
        observedReply = { message: outgoing, incomingIndex, outgoingIndex: lastOutgoingIndex };
      }
    }
    if (!candidateMessages.length) {
      return {
        attempted: true,
        recoveredCount: 0,
        reason: clean(latestMessage?.direction).toLowerCase() === 'outgoing'
          ? 'OPEN_CONVERSATION_LATEST_MESSAGE_OUTGOING'
          : 'OPEN_CONVERSATION_LATEST_MESSAGE_MISSING',
        sourcePage,
        headerName: header.headerName,
        direction: clean(latestMessage?.direction).toLowerCase() || null
      };
    }

    const messageIds = [...new Set(candidateMessages.map(message => clean(message?.messageId)).filter(Boolean))];
    if (!messageIds.length) {
      return { attempted: true, recoveredCount: 0, reason: 'STABLE_MESSAGE_ID_REQUIRED', sourcePage, headerName: header.headerName };
    }

    const expectedConversationId = clean(options.expectedConversationId);
    const rowIdentity = expectedConversationId
      ? { ok: true, conversationId: expectedConversationId, evidence: options.conversationIdEvidence || ['recent-read-row-scan'] }
      : await this.locateOpenDouyinConversationIdentity(page, header.headerName)
        .catch(error => ({ ok: false, reason: 'OPEN_CONVERSATION_ROW_INSPECTION_FAILED', conversationId: null, error: clean(error?.message || error) }));
    const timelineConversationIds = [...new Set(timelineMessages.map(message => clean(message?.conversationId)).filter(Boolean))];
    if (timelineConversationIds.length > 1) {
      return { attempted: true, recoveredCount: 0, reason: 'OPEN_CONVERSATION_ID_AMBIGUOUS', sourcePage, headerName: header.headerName };
    }
    const identityCandidates = [
      clean(candidateMessages.at(-1)?.conversationId),
      timelineConversationIds[0] || '',
      rowIdentity.ok ? clean(rowIdentity.conversationId) : '',
      clean(this.privateConversationIdFromUrl(page))
    ].filter(Boolean);
    const conversationIds = [...new Set(identityCandidates)];
    if (conversationIds.length > 1) {
      return {
        attempted: true,
        recoveredCount: 0,
        reason: 'OPEN_CONVERSATION_ID_CONFLICT',
        sourcePage,
        headerName: header.headerName,
        conversationIds
      };
    }
    const conversationId = conversationIds[0] || null;
    if (!conversationId) {
      return {
        attempted: true,
        recoveredCount: 0,
        reason: rowIdentity.reason || 'STABLE_CONVERSATION_ID_REQUIRED',
        sourcePage,
        headerName: header.headerName
      };
    }

    const messages = candidateMessages
      .map(sourceMessage => this.buildOpenConversationIncomingMessage({
        sourcePage,
        headerName: header.headerName,
        conversationId,
        timeline,
        sourceMessage
      }))
      .filter(Boolean);
    if (!messages.length) {
      return { attempted: true, recoveredCount: 0, reason: 'OPEN_CONVERSATION_INCOMING_MESSAGE_UNVERIFIED', sourcePage, headerName: header.headerName, conversationId };
    }
    const reason = observedReply
      ? 'OPEN_CHAT_PLATFORM_REPLY_DETECTED'
      : messages.length > 1 ? 'OPEN_CHAT_INCOMING_AFTER_REPLY_VERIFIED' : 'OPEN_CHAT_LATEST_INCOMING_VERIFIED';
    messages.forEach(message => {
      message.context.privateVerificationReason = reason;
      message.context.privateVerificationVersion = 'douyin-open-chat-2026.08.23.3';
      message.context.conversationIdEvidence = candidateMessages.find(item => clean(item?.messageId) === message.context.messageId)?.conversationIdEvidence
        || rowIdentity.evidence
        || null;
      if (observedReply) {
        Object.assign(message.context, {
          alreadyHandled: true,
          platformReplyDetected: true,
          platformReplyText: clean(observedReply.message.text),
          platformReplyEvidence: {
            conversationId,
            incomingMessageId: message.context.messageId,
            outgoingMessageId: clean(observedReply.message.messageId),
            outgoingDirection: 'outgoing',
            incomingIndex: observedReply.incomingIndex,
            outgoingIndex: observedReply.outgoingIndex,
            timelineStable: true
          }
        });
      }
    });
    const latestRecovered = messages.at(-1);
    return {
      attempted: true,
      recoveredCount: messages.length,
      reason,
      sourcePage,
      headerName: header.headerName,
      conversationId,
      messageId: latestRecovered.context.messageId,
      timelineStable: true,
      messageCount: timelineMessages.length,
      messages,
      // 保留单条 message 字段，兼容现有调用方和旧诊断数据。
      message: latestRecovered
    };
  }

  async collectIncomingFromRecentReadPrivateConversations(page, payload = {}, { maxRows = 8 } = {}) {
    const sourcePage = typeof page?.url === 'function' ? page.url() : '';
    if (!sourcePage || !patternMatches(this.spec.privateMessagePageUrlPattern, sourcePage)) {
      return { attempted: false, recoveredCount: 0, reason: 'NOT_ON_DOUYIN_PRIVATE_MESSAGE_PAGE', sourcePage };
    }
    const rowSelector = (this.spec.privateConversationRowSelectors || ['[data-e2e="conversation-item"]']).join(',');
    const rows = page?.locator?.(rowSelector);
    const rowCount = Math.min(await rows?.count?.().catch(() => 0) || 0, 100);
    const limit = Math.max(1, Math.min(Number(maxRows) || 8, 12));
    const recoveries = [];
    const rowDiagnostics = [];
    let inspectedReadRows = 0;

    // 抖音当前的会话列表行不一定暴露 conversationId；先对可见行做一次只读快照。
    // 仅当昵称在当前可见列表中唯一时，才允许点击无稳定 ID 的已读行，并在打开后
    // 继续依赖“标题一致 + 稳定时间线 + 消息级 conversationId/messageId”完成强校验。
    const visibleRows = [];
    for (let index = 0; index < rowCount; index += 1) {
      const row = rows.nth(index);
      if (!await row.isVisible().catch(() => false)) continue;
      let unread = false;
      for (const selector of this.spec.privateUnreadSelectors || []) {
        if (await row.locator(selector).first().isVisible().catch(() => false)) {
          unread = true;
          break;
        }
      }
      const title = await firstUsable((this.spec.privateConversationNameSelectors || []).map(selector => row.locator(selector)));
      const headerName = clean(await title?.innerText().catch(() => ''));
      const identity = await this.readPrivateConversationRowIdentity(row);
      const conversationId = clean(identity?.conversationId);
      visibleRows.push({ index, row, unread, headerName, conversationId, identity });
    }
    const visibleHeaderCounts = new Map();
    for (const item of visibleRows) {
      if (!item.headerName) continue;
      visibleHeaderCounts.set(item.headerName, (visibleHeaderCounts.get(item.headerName) || 0) + 1);
    }

    try {
      for (const item of visibleRows) {
        if (inspectedReadRows >= limit) break;
        const { index, unread, headerName, conversationId, identity } = item;
        if (unread) {
          rowDiagnostics.push({ index, skipped: true, reason: 'UNREAD_ROW_LEFT_FOR_NORMAL_COLLECTION' });
          continue;
        }
        if (!headerName) {
          rowDiagnostics.push({
            index,
            skipped: true,
            reason: 'READ_ROW_HEADER_MISSING'
          });
          continue;
        }
        const uniqueVisibleHeader = visibleHeaderCounts.get(headerName) === 1;
        if (!conversationId && !uniqueVisibleHeader) {
          rowDiagnostics.push({
            index,
            headerName,
            skipped: true,
            reason: 'READ_ROW_HEADER_AMBIGUOUS_WITHOUT_STABLE_ID'
          });
          continue;
        }

        inspectedReadRows += 1;
        await this.assertRuntimeAllowed();
        try {
          const preparation = await this.preparePrivateConversationList(page);
          if (!preparation.ok) {
            rowDiagnostics.push({ index, headerName, skipped: true, reason: preparation.reason });
            break;
          }
          const currentRows = await this.inspectPrivateConversationRows(page, {
            userName: headerName, messageContext: { conversationId }
          }, { requireSourcePreview: false });
          const matches = currentRows.namedRows.filter(target => clean(target.candidate.userName) === headerName);
          if (matches.length !== 1) {
            rowDiagnostics.push({ index, headerName, skipped: true, reason: 'READ_CONVERSATION_ROW_CHANGED' });
            continue;
          }
          const currentRow = page.locator(currentRows.rowSelector || rowSelector).nth(matches[0].index);
          const handle = typeof currentRow.elementHandle === 'function' ? await currentRow.elementHandle() : null;
          if (typeof currentRow.elementHandle === 'function' && !handle) {
            rowDiagnostics.push({ index, headerName, skipped: true, reason: 'READ_CONVERSATION_ROW_CHANGED' });
            continue;
          }
          try {
            const actual = await this.readPrivateConversationRowIdentity(handle || currentRow);
            if (conversationId && clean(actual.conversationId) && clean(actual.conversationId) !== conversationId) {
              rowDiagnostics.push({ index, headerName, skipped: true, reason: 'READ_CONVERSATION_ROW_CHANGED' });
              continue;
            }
            await (handle || currentRow).click();
          } finally {
            if (handle) await handle.dispose().catch(() => {});
          }
          await page.waitForTimeout(900);
          const recovery = await this.collectLatestIncomingFromOpenPrivateConversation(page, payload, {
            expectedHeaderName: headerName,
            ...(conversationId ? {
              expectedConversationId: conversationId,
              conversationIdEvidence: identity?.evidence || []
            } : {})
          });
          recoveries.push(recovery);
          rowDiagnostics.push({
            index,
            headerName,
            conversationId: conversationId || recovery.conversationId || null,
            entryIdentity: conversationId ? 'STABLE_CONVERSATION_ID' : 'UNIQUE_VISIBLE_HEADER',
            recoveredCount: Number(recovery.recoveredCount) || 0,
            reason: recovery.reason
          });
        } catch (error) {
          if (['PLATFORM_STOPPED', 'PLATFORM_OPERATION_CANCELLED'].includes(error.code)) throw error;
          await this.assertRuntimeAllowed();
          rowDiagnostics.push({ index, headerName, skipped: true, reason: 'READ_CONVERSATION_INSPECTION_FAILED', error: clean(error?.message || error) });
        }
      }
    } finally {
      try {
        const preparation = await this.preparePrivateConversationList(page);
        if (!preparation.ok) rowDiagnostics.push({ skipped: true, reason: preparation.reason });
      } catch (error) {
        if (['PLATFORM_STOPPED', 'PLATFORM_OPERATION_CANCELLED'].includes(error.code)) throw error;
        await this.assertRuntimeAllowed();
        rowDiagnostics.push({ skipped: true, reason: 'PRIVATE_INBOX_RESTORE_FAILED', error: clean(error?.message || error) });
      }
    }

    const combined = this.combineOpenConversationRecoveries(recoveries);
    return {
      ...combined,
      attempted: true,
      reason: combined.recoveredCount > 0 ? combined.reason : 'RECENT_READ_CONVERSATION_SCAN_NO_NEW_INCOMING',
      sourcePage,
      scannedRowCount: rowCount,
      inspectedReadRowCount: inspectedReadRows,
      rowDiagnostics,
      recoveryEntryVersion: 'douyin-open-chat-entry-2026.08.23.3'
    };
  }

  mergeOpenConversationRecovery(output, recovery = {}) {
    if (!output?.result) return output;
    const recoveredMessages = [
      ...(Array.isArray(recovery?.messages) ? recovery.messages : []),
      ...(!Array.isArray(recovery?.messages) && recovery?.message ? [recovery.message] : [])
    ].filter(Boolean);
    const messages = Array.isArray(output.result.messages) ? [...output.result.messages] : [];
    const stableKey = message => {
      const context = message?.context || {};
      const conversationId = clean(context.conversationId || context.conversationKey);
      const messageId = clean(context.messageId);
      return conversationId && messageId ? `private:${conversationId}:${messageId}` : clean(message?.externalId);
    };
    let addedCount = 0;
    for (const recoveredMessage of recoveredMessages) {
      const recoveredKey = stableKey(recoveredMessage);
      const duplicateIndex = recoveredKey ? messages.findIndex(message => stableKey(message) === recoveredKey) : -1;
      if (duplicateIndex < 0) {
        messages.push(recoveredMessage);
        addedCount += 1;
      } else if (recoveredMessage.context?.platformReplyDetected === true) {
        messages[duplicateIndex] = {
          ...recoveredMessage,
          context: { ...messages[duplicateIndex].context, ...recoveredMessage.context }
        };
      }
    }
    const diagnostic = {
      attempted: recovery.attempted === true,
      detectedCount: Number(recovery.recoveredCount) || recoveredMessages.length,
      recoveredCount: addedCount,
      reason: recoveredMessages.length && addedCount === 0 ? 'OPEN_CHAT_MESSAGE_ALREADY_COLLECTED' : recovery.reason,
      sourcePage: recovery.sourcePage || null,
      headerName: recovery.headerName || null,
      conversationId: recovery.conversationId || null,
      messageId: recovery.messageId || null,
      timelineStable: recovery.timelineStable === true,
      messageCount: Number(recovery.messageCount) || 0,
      inspectionPhases: Array.isArray(recovery.inspectionPhases) ? recovery.inspectionPhases : [],
      recoveryEntryVersion: recovery.recoveryEntryVersion || null,
      scannedRowCount: Number(recovery.scannedRowCount) || 0,
      inspectedReadRowCount: Number(recovery.inspectedReadRowCount) || 0,
      rowDiagnostics: Array.isArray(recovery.rowDiagnostics) ? recovery.rowDiagnostics : []
    };
    const typeResults = Array.isArray(output.result.typeResults) ? output.result.typeResults.map(item => ({ ...item })) : [];
    const privateResult = typeResults.find(item => item.type === 'PRIVATE_MESSAGE');
    if (privateResult) {
      privateResult.count = messages.filter(message => message.messageType === 'PRIVATE_MESSAGE').length;
      privateResult.recoveredCount = addedCount;
      privateResult.openConversationRecovery = diagnostic;
    }
    return {
      ...output,
      result: {
        ...output.result,
        messages,
        typeResults
      }
    };
  }

  async verifyPublish(payload) {
    await this.assertRuntimeAllowed();
    return super.verifyPublish(payload);
  }

  async clickFinalPublish(page) {
    await this.assertRuntimeAllowed();
    // Once final submission starts, an exception may race with a completed click.
    this.douyinPublishAttempted = true;
    return super.clickFinalPublish(page);
  }

  async publish(payload) {
    await this.assertRuntimeAllowed();
    this.douyinPublishAttempted = false;
    const materialPath = path.resolve(payload.materialPath || '');
    if (!fs.existsSync(materialPath)) {
      return { status: 'FAILED', result: await this.evidence(payload, '\u672c\u5730\u7d20\u6750\u4e0d\u5b58\u5728\uff0c\u65e0\u6cd5\u51c6\u5907\u6296\u97f3\u8349\u7a3f', null, 'material_missing') };
    }

    const page = await this.getPage();
    await this.assertRuntimeAllowed();
    await page.goto(this.spec.publishUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    if (!await this.waitForReady(page)) {
      return { status: 'NEEDS_CONFIRMATION', result: await this.evidence(payload, '\u7b49\u5f85\u4eba\u5de5\u767b\u5f55\u6296\u97f3\u8d85\u65f6\uff1b\u6d4f\u89c8\u5668\u9875\u9762\u5df2\u4fdd\u7559', page, 'login_required') };
    }
    if (this.spec.publishPageSettleMs) await page.waitForTimeout(this.spec.publishPageSettleMs);

    try {
      await this.assertRuntimeAllowed();
      const prepared = await this.prepareDraft(page, payload, materialPath);
      const draftEvidence = await this.evidence(payload, '\u6296\u97f3\u8349\u7a3f\u5df2\u51c6\u5907\u5b8c\u6210', page, 'draft_ready', prepared);
      if (payload.publishMode !== 'AUTO') {
        return { status: 'NEEDS_CONFIRMATION', result: { ...draftEvidence, message: '\u6296\u97f3\u8349\u7a3f\u5df2\u51c6\u5907\uff0c\u7b49\u5f85\u4eba\u5de5\u68c0\u67e5\u5e76\u63d0\u4ea4' } };
      }
      if (payload.managementConfirmed !== true) {
        return { status: 'NEEDS_CONFIRMATION', result: { ...draftEvidence, message: '\u6296\u97f3\u8349\u7a3f\u5df2\u51c6\u5907\uff0c\u4f46\u7f3a\u5c11\u672c\u6b21\u6700\u7ec8\u53d1\u8868\u786e\u8ba4\uff0c\u672a\u70b9\u51fb\u53d1\u8868', finalActionAuthorized: false } };
      }

      await this.assertRuntimeAllowed();
      const clickResult = await this.clickFinalPublish(page);
      if (!clickResult.clicked) {
        this.douyinPublishAttempted = false;
        return { status: 'NEEDS_CONFIRMATION', result: { ...draftEvidence, message: '\u6296\u97f3\u6700\u7ec8\u53d1\u8868\u6309\u94ae\u4e0d\u662f\u552f\u4e00\u53ef\u7528\u6309\u94ae\uff0c\u672a\u6267\u884c\u70b9\u51fb', clickResult } };
      }
      if (clickResult.confirmation === 'AMBIGUOUS') {
        return { status: 'NEEDS_CONFIRMATION', result: { ...(await this.evidence(payload, '\u5df2\u70b9\u51fb\u6296\u97f3\u53d1\u8868\u5165\u53e3\uff0c\u4f46\u4e8c\u6b21\u786e\u8ba4\u6309\u94ae\u4e0d\u552f\u4e00\uff1b\u8bf7\u4eba\u5de5\u6838\u5bf9\u4e14\u4e0d\u8981\u81ea\u52a8\u91cd\u8bd5', page, 'publish_confirmation_ambiguous', { clickResult, submissionStatus: 'UNKNOWN' })), doNotRetry: true } };
      }

      const postClickText = await pageEvidenceText(page);
      if (DOUYIN_VERIFY_RE.test(postClickText) || patternMatches(this.spec.publishBlockedTextPattern, postClickText)) {
        return { status: 'NEEDS_CONFIRMATION', result: { ...(await this.evidence(payload, '\u6296\u97f3\u8981\u6c42\u4eba\u5de5\u5b8c\u6210\u8d26\u53f7\u6216\u5b89\u5168\u9a8c\u8bc1\uff0c\u7cfb\u7edf\u4e0d\u4f1a\u7ed5\u8fc7\u9a8c\u8bc1\u6216\u81ea\u52a8\u91cd\u8bd5', page, 'publish_verification_required', { clickResult, submissionStatus: 'UNKNOWN' })), doNotRetry: true } };
      }
      const publishSignal = await this.waitForPublishSignal(page);
      if (publishSignal.confirmed === true) {
        return { status: 'SUCCESS', result: await this.evidence(payload, '\u6296\u97f3\u53d1\u5e03\u5df2\u63d0\u4ea4\uff0c\u5e76\u68c0\u6d4b\u5230\u5e73\u53f0\u6210\u529f\u4fe1\u53f7', page, 'published', { submissionStatus: 'SUBMITTED', publishSignal, clickResult }) };
      }
      return { status: 'NEEDS_CONFIRMATION', result: { ...(await this.evidence(payload, '\u5df2\u70b9\u51fb\u6296\u97f3\u53d1\u5e03\uff0c\u4f46\u672a\u68c0\u6d4b\u5230\u53ef\u9760\u6210\u529f\u4fe1\u53f7\uff1b\u8bf7\u4eba\u5de5\u6838\u5bf9\u4e14\u4e0d\u8981\u81ea\u52a8\u91cd\u8bd5', page, 'publish_unconfirmed', { submissionStatus: 'UNKNOWN', publishSignal, clickResult })), doNotRetry: true } };
    } catch (error) {
      if (!this.douyinPublishAttempted) throw error;
      return {
        status: 'NEEDS_CONFIRMATION',
        result: {
          ...(await this.evidence(payload, `\u6296\u97f3\u53d1\u5e03\u52a8\u4f5c\u53ef\u80fd\u5df2\u7ecf\u63d0\u4ea4\uff0c\u4f46\u540e\u7eed\u6821\u9a8c\u5f02\u5e38\uff1a${error.message}\uff1b\u8bf7\u4eba\u5de5\u6838\u5bf9\u4e14\u4e0d\u8981\u81ea\u52a8\u91cd\u8bd5`, page, 'publish_post_click_error', { submissionStatus: 'UNKNOWN', errorCode: error.code || null })),
          doNotRetry: true
        }
      };
    }
  }

  async replyToMessage(payload) {
    await this.assertRuntimeAllowed();
    this.douyinReplyAttempted = false;
    const isPrivate = String(payload?.messageType || '').toUpperCase() === 'PRIVATE_MESSAGE';
    let output = null;
    try {
      output = await super.replyToMessage(payload);
      if (this.douyinReplyAttempted && output?.status === 'NEEDS_CONFIRMATION') {
        output.result = { ...(output.result || {}), doNotRetry: true };
      }
      return output;
    } catch (error) {
      if (!this.douyinReplyAttempted) throw error;
      output = {
        status: 'NEEDS_CONFIRMATION',
        result: {
          message: `\u6296\u97f3\u56de\u590d\u52a8\u4f5c\u53ef\u80fd\u5df2\u7ecf\u53d1\u9001\uff0c\u4f46\u540e\u7eed\u6821\u9a8c\u5f02\u5e38\uff1a${error.message}\uff1b\u8bf7\u4eba\u5de5\u6838\u5bf9\u4e14\u4e0d\u8981\u81ea\u52a8\u91cd\u8bd5`,
          reason: 'reply_post_click_error',
          doNotRetry: true,
          submissionStatus: 'UNKNOWN',
          errorCode: error.code || null
        }
      };
      return output;
    } finally {
      if (isPrivate) {
        const restore = await this.restorePrivateInboxOverview(this.existingPrivateMessagePage(), {
          source: 'PRIVATE_REPLY_FINALLY'
        }).catch(error => ({
          attempted: true,
          restored: false,
          exited: false,
          reason: 'PRIVATE_INBOX_RESTORE_FAILED',
          error: clean(error?.message || error)
        }));
        this.lastPrivateInboxRestore = restore;
        if (output?.result && !output.result.postReplyExit) output.result.postReplyExit = restore;
      }
    }
  }

  async clickPrivateSend(page, editor) {
    await this.assertRuntimeAllowed();
    this.douyinReplyAttempted = true;
    const result = await super.clickPrivateSend(page, editor);
    if (!result.clicked) this.douyinReplyAttempted = false;
    return result;
  }

  async inspectStrangerInbox() {
    if (this.platformCode !== 'douyin') throw new Error('\u8be5\u8c03\u8bd5\u5165\u53e3\u4ec5\u652f\u6301\u6296\u97f3');
    const page = await this.getPage();
    const navigation = await this.prepareMessagePage(page, { type: 'PRIVATE_MESSAGE', label: '\u79c1\u4fe1', url: this.spec.messageUrl });
    const readiness = await this.waitForMessageContentReady(page, 'PRIVATE_MESSAGE');
    const pageCheck = readiness.pageCheck || await this.classifyLiveMessagePage(page, 'PRIVATE_MESSAGE');
    if (!readiness.ready || !pageCheck.valid) return { ok: false, reason: readiness.reason || pageCheck.reason, navigation, pageCheck, inspectionOnly: true, sent: false };

    const visibleBoxes = [];
    for (const selector of this.spec.privateStrangerBoxSelectors || []) {
      const boxes = page.locator(selector);
      const count = await boxes.count().catch(() => 0);
      for (let index = 0; index < count; index += 1) {
        const box = boxes.nth(index);
        if (!await box.isVisible().catch(() => false)) continue;
        visibleBoxes.push({ selector, index, box });
      }
    }
    if (visibleBoxes.length !== 1) return { ok: false, reason: visibleBoxes.length ? 'STRANGER_INBOX_AMBIGUOUS' : 'STRANGER_INBOX_MISSING', count: visibleBoxes.length, navigation, pageCheck, inspectionOnly: true, sent: false };

    const target = visibleBoxes[0];
    const before = await target.box.evaluate(element => ({
      text: String(element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim(),
      className: String(element.className || ''),
      outerHTML: String(element.outerHTML || '').slice(0, 20000),
      unreadNodes: [...element.querySelectorAll('[class*="ConversationItemUnReadCount"]')].map(node => ({
        className: String(node.className || ''),
        text: String(node.innerText || node.textContent || '').replace(/\s+/g, ' ').trim(),
        ariaLabel: node.getAttribute('aria-label'),
        title: node.getAttribute('title'),
        outerHTML: String(node.outerHTML || '').slice(0, 3000),
        visible: getComputedStyle(node).display !== 'none' && getComputedStyle(node).visibility !== 'hidden' && node.getClientRects().length > 0
      }))
    })).catch(() => null);

    await this.assertRuntimeAllowed();
    await target.box.click();
    await page.waitForTimeout(1200);
    const afterText = await pageEvidenceText(page);
    const nodes = await page.locator('[data-e2e="conversation-item"],[class*="conversation"],[class*="Conversation"],[class*="stranger"],[class*="Stranger"]').evaluateAll(elements => elements.slice(0, 200).map((element, index) => {
      const style = getComputedStyle(element);
      const visible = style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) > 0 && element.getClientRects().length > 0;
      if (!visible) return null;
      return {
        index,
        tag: element.tagName.toLowerCase(),
        className: String(element.className || '').slice(0, 500),
        dataE2e: element.getAttribute('data-e2e'),
        role: element.getAttribute('role'),
        ariaLabel: element.getAttribute('aria-label'),
        text: String(element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 2000),
        outerHTML: String(element.outerHTML || '').slice(0, 12000)
      };
    }).filter(Boolean)).catch(() => []);
    const screenshotPath = path.join(this.logsDir, `${this.platformCode}-stranger-inbox-inspection-${Date.now()}.png`);
    await page.screenshot({ path: screenshotPath, fullPage: false }).catch(() => {});
    return {
      ok: true,
      navigation,
      pageCheck,
      before,
      after: { url: page.url(), title: await page.title(), bodyText: afterText.slice(0, 30000), nodes },
      screenshotPath: fs.existsSync(screenshotPath) ? screenshotPath : null,
      inspectionOnly: true,
      sent: false
    };
  }

  async refreshDouyinCommentListIfOffered(page, { maxAttempts = 1, settleTimeoutMs = 6000 } = {}) {
    if (this.platformCode !== 'douyin') return { offered: false, clicked: false, attempts: 0, reason: 'NOT_DOUYIN' };
    const refreshPattern = /\u6682\u65e0\u8bc4\u8bba[\s\S]{0,120}\u70b9\u51fb\u5237\u65b0|\u70b9\u51fb\u5237\u65b0[\s\S]{0,120}\u6682\u65e0\u8bc4\u8bba/i;
    const limit = Math.max(0, Math.min(Number(maxAttempts) || 0, 2));
    const result = { offered: false, clicked: false, attempts: 0, loaded: false, stateCleared: false, reason: 'REFRESH_NOT_OFFERED' };
    for (let attempt = 0; attempt < limit; attempt += 1) {
      const beforeText = await pageEvidenceText(page);
      if (!refreshPattern.test(beforeText)) {
        result.stateCleared = result.attempts > 0;
        result.reason = result.attempts > 0 ? 'COMMENT_REFRESH_STATE_CLEARED' : 'REFRESH_NOT_OFFERED';
        return result;
      }
      result.offered = true;
      const refreshControl = await firstUsable([
        page.getByText(/^\u70b9\u51fb\u5237\u65b0$/, { exact: true }),
        page.getByRole('button', { name: /^\u70b9\u51fb\u5237\u65b0$/ })
      ], { enabled: true });
      if (!refreshControl) {
        result.reason = 'COMMENT_REFRESH_CONTROL_MISSING';
        return result;
      }
      await this.assertRuntimeAllowed();
      await refreshControl.click();
      result.clicked = true;
      result.attempts += 1;
      const deadline = Date.now() + Math.max(1000, Number(settleTimeoutMs) || 6000);
      while (Date.now() < deadline) {
        await page.waitForTimeout(500);
        const rowSelector = await this.firstVisibleSelector(page, this.spec.commentReadySelectors || []);
        if (rowSelector) {
          result.loaded = true;
          result.reason = 'COMMENT_ROWS_READY_AFTER_REFRESH';
          result.rowSelector = rowSelector;
          return result;
        }
        const afterText = await pageEvidenceText(page);
        if (!refreshPattern.test(afterText)) {
          result.stateCleared = true;
          result.reason = 'COMMENT_REFRESH_STATE_CLEARED';
          return result;
        }
      }
    }
    result.reason = result.clicked ? 'COMMENT_REFRESH_UNRESOLVED' : result.reason;
    return result;
  }

  async inspectDouyinCommentEmptyState(page, text = null) {
    if (this.platformCode !== 'douyin') return { confirmedEmpty: false, reason: 'NOT_DOUYIN' };
    const evidenceText = text == null ? await pageEvidenceText(page) : clean(text);
    const explicitEmpty = /\u6682\u65e0\u8bc4\u8bba/i.test(evidenceText);
    const busyText = /(?:\u6b63\u5728)?(?:\u52a0\u8f7d|\u5237\u65b0|\u8bf7\u6c42)(?:\u4e2d|\u2026|\.{3})|\u8bf7\u7a0d\u5019/i.test(evidenceText);
    const busySelector = await this.firstVisibleSelector(page, [
      '[aria-busy="true"]',
      '[class*="loading"]',
      '[class*="Loading"]',
      '[class*="spinning"]',
      '[class*="spinner"]',
      '[data-loading="true"]'
    ]);
    const commentCardSelector = await this.firstVisibleSelector(page, this.messageCardSelectors('COMMENT'));
    const busy = busyText || Boolean(busySelector);
    const confirmedEmpty = explicitEmpty && !busy && !commentCardSelector;
    return {
      confirmedEmpty,
      explicitEmpty,
      busy,
      busyText,
      busySelector,
      commentCardSelector,
      reason: confirmedEmpty
        ? 'COMMENT_EMPTY_CONFIRMED_AFTER_RELOAD'
        : (!explicitEmpty ? 'COMMENT_EMPTY_TEXT_MISSING' : (busy ? 'COMMENT_EMPTY_BUSY_STATE' : 'COMMENT_EMPTY_HAS_VISIBLE_CARD'))
    };
  }

  async recoverDouyinCommentListAfterRefresh(page, { settleTimeoutMs = 5000, refreshOffered = false, refreshClicked = false } = {}) {
    const result = { attempted: false, reloadAttempted: false, reloaded: false, reloadTimedOut: false, loaded: false, stateCleared: false, reason: 'RECOVERY_NOT_ATTEMPTED' };
    const deferAfterReloadTimeout = (deferredReason, extra = {}) => ({
      ...result,
      ...extra,
      reason: 'COMMENT_RECOVERY_DEFERRED_AFTER_RELOAD_TIMEOUT',
      deferredReason,
      disposition: 'DEFERRED_PAGE_UNAVAILABLE',
      deferred: true,
      needsConfirmation: true,
      doNotRetryImmediately: true
    });
    if (this.platformCode !== 'douyin') return { ...result, reason: 'NOT_DOUYIN' };
    if (!refreshOffered) return { ...result, reason: 'COMMENT_RECOVERY_REFRESH_NOT_OFFERED' };
    if (!refreshClicked) return { ...result, reason: 'COMMENT_RECOVERY_REFRESH_NOT_CLICKED' };
    const currentUrl = page.url();
    const expectedUrl = clean(this.spec.commentUrl);
    if (!expectedUrl || !currentUrl.startsWith(expectedUrl)) return { ...result, reason: 'COMMENT_RECOVERY_URL_MISMATCH', currentUrl, expectedUrl };
    result.attempted = true;
    result.currentUrl = currentUrl;
    result.refreshOffered = true;
    result.refreshClicked = true;
    await this.assertRuntimeAllowed();
    result.reloadAttempted = true;
    try {
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
      result.reloaded = true;
    } catch (error) {
      if (!isNavigationTimeoutError(error)) throw error;
      result.reloadTimedOut = true;
      result.reloadError = clean(error?.message || error).slice(0, 500);
    }
    await page.waitForTimeout(result.reloadTimedOut ? 750 : 1200).catch(() => {});
    result.finalUrl = page.url();
    if (!result.finalUrl.startsWith(expectedUrl)) {
      if (result.reloadTimedOut) return deferAfterReloadTimeout('COMMENT_RECOVERY_FINAL_URL_MISMATCH');
      result.reason = 'COMMENT_RECOVERY_FINAL_URL_MISMATCH';
      return result;
    }
    const pageCheck = await this.classifyLiveMessagePage(page, 'COMMENT');
    result.pageCheck = pageCheck;
    if (!pageCheck.valid) {
      if (result.reloadTimedOut) return deferAfterReloadTimeout(`COMMENT_RECOVERY_${pageCheck.reason || 'PAGE_UNVERIFIED'}`, { pageCheck });
      result.reason = `COMMENT_RECOVERY_${pageCheck.reason || 'PAGE_UNVERIFIED'}`;
      return result;
    }

    const settleDeadline = Date.now() + Math.max(250, Number(settleTimeoutMs) || 5000);
    do {
      const rowSelector = await this.firstVisibleSelector(page, this.spec.commentReadySelectors || []);
      if (rowSelector) return { ...result, loaded: true, rowSelector, reason: 'COMMENT_ROWS_READY_AFTER_RELOAD' };
      const text = await pageEvidenceText(page);
      const emptyState = await this.inspectDouyinCommentEmptyState(page, text);
      result.emptyState = emptyState;
      if (emptyState.confirmedEmpty) return { ...result, stateCleared: true, empty: true, reason: emptyState.reason };
      if (!emptyState.busy) break;
      await page.waitForTimeout(350).catch(() => {});
    } while (Date.now() < settleDeadline);

    if (result.emptyState?.busy) {
      if (result.reloadTimedOut) return deferAfterReloadTimeout('COMMENT_RECOVERY_BUSY_STATE', { pageCheck, emptyState: result.emptyState });
      result.reason = 'COMMENT_RECOVERY_BUSY_STATE';
      return result;
    }

    // A timed-out reload may still leave a usable DOM. We accept only verified rows or
    // an explicit settled empty state above; never click refresh again in the same recovery.
    if (result.reloadTimedOut) {
      return deferAfterReloadTimeout('COMMENT_RECOVERY_CONTENT_UNRESOLVED', { pageCheck, emptyState: result.emptyState });
    }

    const refresh = await this.refreshDouyinCommentListIfOffered(page, { maxAttempts: 1, settleTimeoutMs });
    result.refresh = refresh;
    if (refresh.loaded) return { ...result, loaded: true, rowSelector: refresh.rowSelector, reason: 'COMMENT_ROWS_READY_AFTER_RELOAD_REFRESH' };
    if (refresh.stateCleared) return { ...result, stateCleared: true, reason: 'COMMENT_REFRESH_STATE_CLEARED_AFTER_RELOAD' };
    const finalText = await pageEvidenceText(page);
    const finalEmptyState = await this.inspectDouyinCommentEmptyState(page, finalText);
    result.emptyState = finalEmptyState;
    if (finalEmptyState.confirmedEmpty) return { ...result, stateCleared: true, empty: true, reason: finalEmptyState.reason };
    result.reason = finalEmptyState.busy
      ? 'COMMENT_RECOVERY_BUSY_STATE'
      : (refresh.reason === 'REFRESH_NOT_OFFERED' ? 'COMMENT_RECOVERY_CONTENT_UNRESOLVED' : (refresh.reason || 'COMMENT_REFRESH_UNRESOLVED_AFTER_RELOAD'));
    return result;
  }

  async inspectDouyinStrangerInboxView(page) {
    const titleSelectors = this.spec.privateStrangerListTitleSelectors || ['.conversationStrangerConversationListtitle'];
    const listSelectors = this.spec.privateStrangerListSelectors || ['.conversationStrangerConversationListlistWrapper'];
    const title = await firstUsable(titleSelectors.map(selector => page.locator(selector)));
    const list = await firstUsable(listSelectors.map(selector => page.locator(selector)));
    const titleText = clean(await title?.innerText().catch(() => ''));
    const titleVisible = Boolean(title);
    const listVisible = Boolean(list);
    return {
      open: titleVisible && listVisible && titleText === '陌生人消息',
      signalVisible: titleVisible || listVisible,
      titleVisible,
      listVisible,
      titleText
    };
  }

  async openDouyinStrangerInbox(page) {
    if (this.platformCode !== 'douyin') return { ok: false, reason: 'STRANGER_INBOX_UNSUPPORTED' };
    const preparation = await this.preparePrivateConversationList(page);
    if (!preparation.ok) return preparation;
    const existingView = await this.inspectDouyinStrangerInboxView(page);
    if (existingView.open) return { ok: true, alreadyOpen: true, title: existingView.titleText };
    if (existingView.signalVisible) return { ok: false, reason: 'STRANGER_INBOX_VIEW_UNVERIFIED', ...existingView };

    const targets = [];
    for (const selector of this.spec.privateStrangerBoxSelectors || []) {
      const boxes = page.locator(selector);
      const count = await boxes.count().catch(() => 0);
      for (let index = 0; index < count; index += 1) {
        const box = boxes.nth(index);
        if (await box.isVisible().catch(() => false)) targets.push({ selector, index, box });
      }
    }
    if (targets.length !== 1) return { ok: false, reason: targets.length ? 'STRANGER_INBOX_AMBIGUOUS' : 'STRANGER_INBOX_MISSING', targetCount: targets.length };
    await this.assertRuntimeAllowed();
    await targets[0].box.click();
    await page.waitForTimeout(800);
    const openedView = await this.inspectDouyinStrangerInboxView(page);
    if (!openedView.open) return { ok: false, reason: 'STRANGER_INBOX_VIEW_UNVERIFIED', ...openedView };
    return { ok: true, alreadyOpen: false, title: openedView.titleText, entrySelector: targets[0].selector };
  }

  async readDouyinElementIdentity(locator) {
    return locator.evaluate(element => {
      const text = value => String(value || '').replace(/\s+/g, ' ').trim();
      const result = {};
      const wanted = new Map([
        ['comment_id', 'commentStableId'], ['commentid', 'commentStableId'], ['cid', 'commentStableId'],
        ['item_id_plain', 'sourceVideoKey'], ['aweme_id', 'sourceVideoKey'], ['video_id', 'sourceVideoKey'],
        ['item_id', 'sourceVideoOpaqueKey'], ['item_link', 'sourceVideoUrl'],
        ['title', 'sourceVideoTitle'], ['create_time', 'sourceVideoPublishedAt'],
        ['comment_count', 'commentCount']
      ]);
      const seen = new WeakSet();
      const assignPrimitive = (key, value) => {
        const target = wanted.get(String(key || '').toLowerCase());
        if (!target || result[target] != null || !['string', 'number'].includes(typeof value)) return;
        const normalized = text(value);
        if (normalized && !/^(?:true|false)$/.test(normalized)) result[target] = normalized;
      };
      const inspect = (value, depth = 0) => {
        if (!value || depth > 8 || (typeof value !== 'object' && typeof value !== 'function') || seen.has(value)) return;
        seen.add(value);
        for (const [key, child] of Object.entries(value)) {
          if (['return', 'child', 'sibling', 'stateNode', '_owner'].includes(key)) continue;
          assignPrimitive(key, child);
          if (key === 'key' && typeof child === 'string' && child.trim().startsWith('{')) {
            try { inspect(JSON.parse(child), depth + 1); } catch {}
          }
          if (depth < 2 || /props|item|video|comment|data|state|key|list/i.test(key)) inspect(child, depth + 1);
        }
      };
      const identityNodes = [];
      for (let node = element, depth = 0; node && depth < 12; depth += 1, node = node.parentElement) identityNodes.push(node);
      for (const node of identityNodes) {
        for (const name of Object.getOwnPropertyNames(node)) {
          if (!name.startsWith('__reactFiber$') && !name.startsWith('__reactProps$')) continue;
          let current = node[name];
          for (let depth = 0; current && depth < 12; depth += 1, current = current.return) inspect(current, 0);
        }
      }
      if (!result.sourceVideoKey && result.sourceVideoOpaqueKey) result.sourceVideoKey = result.sourceVideoOpaqueKey;
      const userNode = element.querySelector('h4[class*="cmt-name-"]');
      const contentNode = element.querySelector('pre[class*="cmt-text-"]');
      const timeNode = element.querySelector('p[class*="cmt-time-"]');
      const image = element.querySelector('img[alt]');
      const published = element.querySelector('[class*="publish-time-"]');
      const countNode = element.querySelector('[class*="comment-count-"] span');
      return {
        ...result,
        userName: text(userNode?.innerText || userNode?.textContent),
        content: text(contentNode?.innerText || contentNode?.textContent),
        eventTime: text(timeNode?.getAttribute('datetime') || timeNode?.innerText || timeNode?.textContent),
        sourceVideoTitle: text(result.sourceVideoTitle || image?.getAttribute('alt')) || null,
        sourceVideoPublishedAt: text(result.sourceVideoPublishedAt || published?.innerText || published?.textContent) || null,
        commentCount: Number.parseInt(text(result.commentCount ?? countNode?.innerText ?? countNode?.textContent), 10) || 0,
        className: String(element.className || ''),
        selected: /(?:^|\s)selected-[^\s]+/.test(String(element.className || '')),
        elementText: text(element.innerText || element.textContent)
      };
    }).catch(() => null);
  }

  async readDouyinCommentCandidate(locator) {
    return this.readDouyinElementIdentity(locator);
  }

  async inspectDouyinCommentReplyThread(locator) {
    if (!locator) return { ok: false, reason: 'COMMENT_REPLY_THREAD_SCOPE_MISSING' };
    return locator.evaluate((element, options) => {
      const text = value => String(value || '').replace(/\s+/g, ' ').trim();
      const visible = node => Boolean(node
        && getComputedStyle(node).display !== 'none'
        && getComputedStyle(node).visibility !== 'hidden'
        && Number(getComputedStyle(node).opacity || 1) > 0
        && node.getClientRects().length > 0);
      const nodeText = node => text(node?.innerText || node?.textContent);
      const leafExactNodes = pattern => [...element.querySelectorAll('*')]
        .filter(node => visible(node) && pattern.test(nodeText(node)))
        .filter(node => ![...node.children].some(child => visible(child) && nodeText(child) === nodeText(node)));
      const expandControls = leafExactNodes(/^展开\s*\d+\s*条回复$/);
      const collapseControls = leafExactNodes(/^收起回复$/);
      const collapsedReplyCount = expandControls.reduce((maximum, node) => {
        const matched = nodeText(node).match(/(\d+)/);
        return Math.max(maximum, Number(matched?.[1] || 0));
      }, 0);
      const topContentNode = element.querySelector(options.commentTextSelector);
      const nestedReplyRows = [...element.querySelectorAll(options.commentRowSelector)]
        .filter(node => node !== element && visible(node));
      const authorBadges = leafExactNodes(/^作者$/);
      const authorReplies = [];
      const seenReplies = new Set();
      for (const badge of authorBadges) {
        let replyRoot = badge;
        let replyContentNode = null;
        for (let depth = 0; replyRoot && replyRoot !== element && depth < 10; depth += 1, replyRoot = replyRoot.parentElement) {
          const candidates = [...replyRoot.querySelectorAll(options.commentTextSelector)]
            .filter(node => node !== topContentNode && visible(node));
          if (candidates.length === 1) { replyContentNode = candidates[0]; break; }
        }
        if (!replyContentNode || !replyRoot || replyRoot === element || !element.contains(replyRoot)) continue;
        const replyText = nodeText(replyContentNode);
        if (!replyText) continue;
        const userNode = replyRoot.querySelector(options.commentNameSelector);
        const userName = nodeText(userNode) || null;
        const key = [userName, replyText].join('|');
        if (seenReplies.has(key)) continue;
        seenReplies.add(key);
        authorReplies.push({ userName, text: replyText });
      }
      const replyThreadCollapsed = expandControls.length > 0;
      const replyThreadExpanded = collapseControls.length > 0;
      const signature = JSON.stringify({
        replyThreadCollapsed,
        collapsedReplyCount,
        replyThreadExpanded,
        nestedReplyCount: nestedReplyRows.length,
        authorReplies
      });
      return {
        ok: true,
        replyThreadCollapsed,
        collapsedReplyCount,
        replyThreadExpanded,
        nestedReplyCount: nestedReplyRows.length,
        platformAuthorReplyDetected: authorReplies.length > 0,
        platformAuthorReplyText: authorReplies[0]?.text || null,
        platformAuthorReplyUserName: authorReplies[0]?.userName || null,
        authorReplies,
        signature
      };
    }, {
      commentRowSelector: this.spec.commentRowSelector || '[class*="cmt-li-"]',
      commentNameSelector: this.spec.commentNameSelector || 'h4[class*="cmt-name-"]',
      commentTextSelector: this.spec.commentTextSelector || 'pre[class*="cmt-text-"]'
    }).catch(error => ({ ok: false, reason: 'COMMENT_REPLY_THREAD_INSPECTION_FAILED', error: error.message }));
  }

  async findDouyinCommentReplyThreadToggle(container, mode = 'expand') {
    if (!container) return { ok: false, reason: 'COMMENT_REPLY_THREAD_SCOPE_MISSING', count: 0 };
    const pattern = mode === 'collapse' ? /^收起回复$/ : /^展开\s*\d+\s*条回复$/;
    const controls = container.locator('button,[role="button"],a,span,div,p');
    const count = Math.min(await controls.count().catch(() => 0), 160);
    const matches = [];
    for (let index = 0; index < count; index += 1) {
      const control = controls.nth(index);
      if (!await control.isVisible().catch(() => false)) continue;
      const evidence = await control.evaluate((element, source) => {
        const text = value => String(value || '').replace(/\s+/g, ' ').trim();
        const label = text(element.innerText || element.textContent);
        const pattern = new RegExp(source);
        const childHasSameText = [...element.children].some(child => text(child.innerText || child.textContent) === label);
        return {
          label,
          exact: pattern.test(label),
          leaf: !childHasSameText,
          semanticControl: ['button', 'a'].includes(String(element.tagName || '').toLowerCase()) || element.getAttribute('role') === 'button',
          className: String(element.className?.baseVal || element.className || '')
        };
      }, pattern.source).catch(() => null);
      if (evidence?.exact && evidence.leaf) matches.push({ control, evidence, index });
    }
    const semantic = matches.filter(item => item.evidence.semanticControl);
    const usable = semantic.length === 1 ? semantic : matches;
    if (usable.length !== 1) return {
      ok: false,
      reason: usable.length ? 'COMMENT_REPLY_THREAD_TOGGLE_AMBIGUOUS' : 'COMMENT_REPLY_THREAD_TOGGLE_MISSING',
      count: usable.length,
      candidates: usable.map(item => ({ index: item.index, ...item.evidence }))
    };
    return { ok: true, control: usable[0].control, evidence: usable[0].evidence, count: 1 };
  }

  async enrichDouyinFoldedCommentReplies(page, messages = [], payload = {}) {
    if (this.platformCode !== 'douyin') return { messages, attemptedCount: 0, verifiedCount: 0, results: [] };
    const processedStableIds = new Set((Array.isArray(payload.processedCommentStableIds) ? payload.processedCommentStableIds : [])
      .map(value => clean(value)).filter(Boolean));
    const results = [];
    const enriched = [];
    let attemptedCount = 0;
    let verifiedCount = 0;
    const updateMessage = (message, patch) => ({
      ...message,
      context: { ...(message.context && typeof message.context === 'object' ? message.context : {}), ...patch }
    });
    for (const message of messages) {
      const context = message.context && typeof message.context === 'object' ? message.context : {};
      const stableId = clean(context.commentStableId || context.commentId || context.cid);
      const hasReplyThreadEvidence = context.replyThreadCollapsed === true
        || context.replyThreadExpanded === true
        || context.platformAuthorReplyDetected === true;
      if (!hasReplyThreadEvidence) {
        enriched.push(message);
        results.push({ stableId: stableId || null, status: 'SKIPPED', reason: 'COMMENT_REPLY_THREAD_NOT_PRESENT' });
        continue;
      }
      if (context.platformAuthorReplyDetected === true) {
        verifiedCount += 1;
        enriched.push(updateMessage(message, { replyThreadVerification: 'VERIFIED_AUTHOR_REPLY' }));
        results.push({ stableId: stableId || null, status: 'VERIFIED', verification: 'VERIFIED_AUTHOR_REPLY', source: 'INITIAL_SCOPED_EXTRACTION' });
        continue;
      }
      if (stableId && processedStableIds.has(stableId)) {
        enriched.push(updateMessage(message, {
          replyThreadVerification: 'SKIPPED_ALREADY_PROCESSED',
          processingRegistryHandled: true
        }));
        results.push({ stableId, status: 'SKIPPED', reason: 'COMMENT_ALREADY_HANDLED_IN_REGISTRY' });
        continue;
      }

      attemptedCount += 1;
      const locatePayload = {
        platformCode: 'douyin',
        messageType: 'COMMENT',
        sourceContent: message.content,
        userName: message.userName,
        externalUrl: message.externalUrl,
        messageContext: context
      };
      let located = await this.locateMessageContainer(page, locatePayload);
      if (!located.ok || !located.locator) {
        enriched.push(updateMessage(message, { replyThreadVerification: 'UNVERIFIED', replyThreadVerificationReason: located.reason || 'COMMENT_TARGET_NOT_FOUND' }));
        results.push({ stableId: stableId || null, status: 'UNVERIFIED', reason: located.reason || 'COMMENT_TARGET_NOT_FOUND' });
        continue;
      }
      let inspection = await this.inspectDouyinCommentReplyThread(located.locator);
      const expectedReplyCount = Math.max(1, Number(inspection.collapsedReplyCount || context.collapsedReplyCount) || 0);
      if (!inspection.ok) {
        enriched.push(updateMessage(message, { replyThreadVerification: 'UNVERIFIED', replyThreadVerificationReason: inspection.reason }));
        results.push({ stableId: stableId || null, status: 'UNVERIFIED', reason: inspection.reason });
        continue;
      }
      if (inspection.platformAuthorReplyDetected === true) {
        verifiedCount += 1;
        enriched.push(updateMessage(message, { ...inspection, replyThreadVerification: 'VERIFIED_AUTHOR_REPLY' }));
        results.push({ stableId: stableId || null, status: 'VERIFIED', verification: 'VERIFIED_AUTHOR_REPLY', source: 'SCOPED_THREAD_INSPECTION' });
        continue;
      }
      if (inspection.replyThreadCollapsed === true) {
        const toggle = await this.findDouyinCommentReplyThreadToggle(located.locator, 'expand');
        if (!toggle.ok) {
          enriched.push(updateMessage(message, { ...inspection, replyThreadVerification: 'UNVERIFIED', replyThreadVerificationReason: toggle.reason }));
          results.push({ stableId: stableId || null, status: 'UNVERIFIED', reason: toggle.reason });
          continue;
        }
        try {
          await this.assertRuntimeAllowed();
          await toggle.control.click();
          await page.waitForTimeout(350);
        } catch (error) {
          enriched.push(updateMessage(message, { ...inspection, replyThreadVerification: 'UNVERIFIED', replyThreadVerificationReason: 'COMMENT_REPLY_THREAD_EXPAND_FAILED' }));
          results.push({ stableId: stableId || null, status: 'UNVERIFIED', reason: 'COMMENT_REPLY_THREAD_EXPAND_FAILED', error: error.message });
          continue;
        }
        located = await this.locateMessageContainer(page, locatePayload);
        if (!located.ok || !located.locator) {
          enriched.push(updateMessage(message, { ...inspection, replyThreadVerification: 'UNVERIFIED', replyThreadVerificationReason: 'COMMENT_TARGET_LOST_AFTER_EXPAND' }));
          results.push({ stableId: stableId || null, status: 'UNVERIFIED', reason: 'COMMENT_TARGET_LOST_AFTER_EXPAND' });
          continue;
        }
        inspection = await this.inspectDouyinCommentReplyThread(located.locator);
      }
      if (!inspection.ok) {
        enriched.push(updateMessage(message, { replyThreadVerification: 'UNVERIFIED', replyThreadVerificationReason: inspection.reason }));
        results.push({ stableId: stableId || null, status: 'UNVERIFIED', reason: inspection.reason });
        continue;
      }
      await page.waitForTimeout(250);
      const confirmation = await this.inspectDouyinCommentReplyThread(located.locator);
      const stable = confirmation.ok === true && confirmation.signature === inspection.signature;
      const finalEvidence = confirmation.ok === true ? confirmation : inspection;
      const verification = classifyDouyinReplyThreadEvidence(finalEvidence, { stable, expectedReplyCount });
      if (verification === 'VERIFIED_AUTHOR_REPLY' || verification === 'VERIFIED_NO_AUTHOR_REPLY') verifiedCount += 1;
      enriched.push(updateMessage(message, {
        ...finalEvidence,
        replyThreadVerification: verification === 'NOT_APPLICABLE' ? 'UNVERIFIED' : verification,
        replyThreadVerificationReason: verification === 'UNVERIFIED' || verification === 'NOT_APPLICABLE'
          ? (stable ? 'COMMENT_REPLY_THREAD_STATE_NOT_EXPANDED' : 'COMMENT_REPLY_THREAD_STATE_UNSTABLE')
          : null
      }));
      results.push({
        stableId: stableId || null,
        status: verification.startsWith('VERIFIED_') ? 'VERIFIED' : 'UNVERIFIED',
        verification: verification === 'NOT_APPLICABLE' ? 'UNVERIFIED' : verification,
        stable,
        evidence: { ...finalEvidence, authorReplies: undefined }
      });
    }
    return { messages: enriched, attemptedCount, verifiedCount, results };
  }

  async ensureDouyinVideoPickerOpen(page) {
    const existing = page.locator('.semi-sidesheet-content').filter({ hasText: '作品列表' });
    if (await existing.first().isVisible().catch(() => false)) return { ok: true, alreadyOpen: true, sheet: existing.first() };
    const choose = await firstUsable([
      page.getByRole('button', { name: /^选择作品$/ }),
      page.getByText(/^选择作品$/, { exact: true })
    ]);
    if (!choose) return { ok: false, reason: 'DOUYIN_VIDEO_PICKER_TRIGGER_MISSING' };
    await this.assertRuntimeAllowed();
    await choose.click();
    const sheet = page.locator('.semi-sidesheet-content').filter({ hasText: '作品列表' }).first();
    const opened = await sheet.waitFor({ state: 'visible', timeout: 3000 }).then(() => true).catch(() => false);
    return opened ? { ok: true, alreadyOpen: false, sheet } : { ok: false, reason: 'DOUYIN_VIDEO_PICKER_NOT_OPENED' };
  }

  async inspectDouyinCommentVideos(page, { maxRounds = 8 } = {}) {
    const picker = await this.ensureDouyinVideoPickerOpen(page);
    if (!picker.ok) return { ...picker, videos: [] };
    const videos = [];
    const seen = new Set();
    let stopReason = 'MAX_ROUNDS';
    for (let round = 1; round <= Math.max(1, Number(maxRounds) || 8); round += 1) {
      const cards = picker.sheet.locator('[class*="item-container-"]');
      const count = Math.min(await cards.count().catch(() => 0), 200);
      let added = 0;
      for (let index = 0; index < count; index += 1) {
        const card = cards.nth(index);
        if (!await card.isVisible().catch(() => false)) continue;
        const identity = await this.readDouyinElementIdentity(card);
        const sourceVideoKey = clean(identity?.sourceVideoKey);
        if (!sourceVideoKey || seen.has(sourceVideoKey)) continue;
        seen.add(sourceVideoKey);
        videos.push({
          sourceVideoKey,
          sourceVideoOpaqueKey: clean(identity?.sourceVideoOpaqueKey) || null,
          sourceVideoUrl: clean(identity?.sourceVideoUrl) || null,
          sourceVideoTitle: clean(identity?.sourceVideoTitle) || null,
          sourceVideoPublishedAt: clean(identity?.sourceVideoPublishedAt) || null,
          commentCount: Math.max(0, Number(identity?.commentCount) || 0),
          selected: identity?.selected === true
        });
        added += 1;
      }
      const ended = await picker.sheet.getByText(/没有更多视频|暂无更多/, { exact: false }).first().isVisible().catch(() => false);
      if (ended) { stopReason = 'VIDEO_LIST_EXHAUSTED'; break; }
      const advance = await picker.sheet.evaluate(element => {
        const nodes = [element, ...element.querySelectorAll('*')];
        const target = nodes.find(node => node.scrollHeight > node.clientHeight + 8 && getComputedStyle(node).overflowY !== 'visible');
        if (!target) return { moved: false, reason: 'VIDEO_LIST_SCROLL_CONTAINER_MISSING' };
        const before = target.scrollTop;
        target.scrollTop = Math.min(target.scrollHeight, before + Math.max(320, target.clientHeight * 0.8));
        return { moved: target.scrollTop > before, before, after: target.scrollTop, scrollHeight: target.scrollHeight, clientHeight: target.clientHeight };
      }).catch(error => ({ moved: false, reason: 'VIDEO_LIST_SCROLL_FAILED', error: error.message }));
      if (!advance.moved) { stopReason = advance.reason || (added ? 'VIDEO_LIST_STABLE' : 'VIDEO_LIST_EMPTY'); break; }
      await page.waitForTimeout(350);
    }
    return { ok: videos.length > 0, reason: videos.length ? stopReason : 'DOUYIN_VIDEO_LIST_EMPTY', videos };
  }

  async readDouyinCurrentVideoIdentity(page) {
    const scopes = [
      page.locator('.comment-container').first(),
      page.locator('[class*="cmt-li-"]').first()
    ];
    for (const scope of scopes) {
      if (!await scope.isVisible().catch(() => false)) continue;
      const identity = await this.readDouyinElementIdentity(scope);
      if (clean(identity?.sourceVideoKey)) return identity;
    }
    return null;
  }

  async openDouyinCommentVideoByKey(page, sourceVideoKey, { maxRounds = 8 } = {}) {
    const expectedKey = clean(sourceVideoKey);
    if (!expectedKey) return { ok: false, reason: 'DOUYIN_SOURCE_VIDEO_KEY_REQUIRED' };
    const current = await this.readDouyinCurrentVideoIdentity(page);
    if (clean(current?.sourceVideoKey) === expectedKey) return { ok: true, alreadySelected: true, video: current };
    const picker = await this.ensureDouyinVideoPickerOpen(page);
    if (!picker.ok) return picker;
    const observed = [];
    for (let round = 1; round <= Math.max(1, Number(maxRounds) || 8); round += 1) {
      const cards = picker.sheet.locator('[class*="item-container-"]');
      const count = Math.min(await cards.count().catch(() => 0), 200);
      for (let index = 0; index < count; index += 1) {
        const card = cards.nth(index);
        if (!await card.isVisible().catch(() => false)) continue;
        const identity = await this.readDouyinElementIdentity(card);
        const actualKey = clean(identity?.sourceVideoKey);
        if (actualKey && !observed.includes(actualKey)) observed.push(actualKey);
        if (actualKey !== expectedKey && clean(identity?.sourceVideoOpaqueKey) !== expectedKey) continue;
        await this.assertRuntimeAllowed();
        await card.click();
        await picker.sheet.waitFor({ state: 'hidden', timeout: 3000 }).catch(() => {});
        await page.waitForTimeout(650);
        const selected = await this.readDouyinCurrentVideoIdentity(page);
        if (clean(selected?.sourceVideoKey) !== expectedKey && clean(selected?.sourceVideoOpaqueKey) !== expectedKey) {
          return { ok: false, reason: 'DOUYIN_SELECTED_VIDEO_MISMATCH', expectedKey, selected, observed };
        }
        return { ok: true, alreadySelected: false, video: selected || identity, observed };
      }
      const ended = await picker.sheet.getByText(/没有更多视频|暂无更多/, { exact: false }).first().isVisible().catch(() => false);
      if (ended) break;
      const moved = await picker.sheet.evaluate(element => {
        const nodes = [element, ...element.querySelectorAll('*')];
        const target = nodes.find(node => node.scrollHeight > node.clientHeight + 8 && getComputedStyle(node).overflowY !== 'visible');
        if (!target) return false;
        const before = target.scrollTop;
        target.scrollTop = Math.min(target.scrollHeight, before + Math.max(320, target.clientHeight * 0.8));
        return target.scrollTop > before;
      }).catch(() => false);
      if (!moved) break;
      await page.waitForTimeout(350);
    }
    return { ok: false, reason: 'DOUYIN_SOURCE_VIDEO_NOT_FOUND', expectedKey, observed, sourceGone: true };
  }

  async openDouyinCommentVideoForPayload(page, payload) {
    const context = payload.messageContext || payload.context || {};
    return this.openDouyinCommentVideoByKey(page, context.sourceVideoKey || context.postId || context.awemeId || context.itemId);
  }

  async collectHistoricalCommentMessages(page, payload, options = {}) {
    const inventory = await this.inspectDouyinCommentVideos(page);
    if (!inventory.ok) {
      const current = await this.readDouyinCurrentVideoIdentity(page);
      return super.collectHistoricalCommentMessages(page, payload, {
        ...options,
        sourceContext: current && clean(current.sourceVideoKey) ? {
          sourceVideoKey: clean(current.sourceVideoKey),
          sourceVideoOpaqueKey: clean(current.sourceVideoOpaqueKey) || null,
          sourceVideoUrl: clean(current.sourceVideoUrl) || null,
          sourceVideoTitle: clean(current.sourceVideoTitle) || null,
          sourceVideoPublishedAt: clean(current.sourceVideoPublishedAt) || null,
          sourceVerified: true
        } : {}
      });
    }
    const messages = [];
    const seen = new Set();
    const videoResults = [];
    let rounds = 0;
    for (const video of inventory.videos) {
      await this.assertRuntimeAllowed();
      const selected = await this.openDouyinCommentVideoByKey(page, video.sourceVideoKey);
      if (!selected.ok) {
        videoResults.push({ sourceVideoKey: video.sourceVideoKey, status: 'SKIPPED', reason: selected.reason, sourceGone: selected.sourceGone === true });
        continue;
      }
      await page.waitForTimeout(450);
      const collection = await super.collectHistoricalCommentMessages(page, payload, {
        ...options,
        sourceContext: {
          sourceVideoKey: video.sourceVideoKey,
          sourceVideoOpaqueKey: video.sourceVideoOpaqueKey,
          sourceVideoUrl: video.sourceVideoUrl,
          sourceVideoTitle: video.sourceVideoTitle,
          sourceVideoPublishedAt: video.sourceVideoPublishedAt,
          sourceVerified: true
        }
      });
      rounds += Number(collection.rounds) || 0;
      let added = 0;
      for (const message of collection.messages || []) {
        const key = clean(message?.externalId);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        messages.push(message);
        added += 1;
      }
      videoResults.push({ sourceVideoKey: video.sourceVideoKey, status: 'SUCCESS', count: added, stopReason: collection.stopReason });
    }
    return { messages, rounds, stopReason: 'ALL_CURRENT_DOUYIN_VIDEOS_SCANNED', videoResults, inventoryReason: inventory.reason };
  }

  async findDouyinCommentEditor(page, payload, scope = null) {
    // Douyin can keep editors from other expanded comments in the DOM. Never fall back to
    // page-wide discovery: the editor must belong to the already verified target comment.
    if (!scope || scope === page) return { ok: false, reason: 'COMMENT_EDITOR_SCOPE_MISSING', count: 0 };

    const roots = scope.locator(this.spec.commentEditorRootSelector || '[class*="cmt-editor-"]');
    const rootCount = Math.min(await roots.count().catch(() => 0), 20);
    const visibleRoots = [];
    for (let index = 0; index < rootCount; index += 1) {
      const root = roots.nth(index);
      if (await root.isVisible().catch(() => false)) visibleRoots.push(root);
    }
    if (visibleRoots.length !== 1) {
      return {
        ok: false,
        reason: visibleRoots.length ? 'COMMENT_EDITOR_ROOT_AMBIGUOUS' : 'COMMENT_EDITOR_ROOT_MISSING',
        count: visibleRoots.length,
        rootCount
      };
    }

    const root = visibleRoots[0];
    const editorSelector = [...new Set([
      ...(this.spec.commentEditorSelectors || []),
      'textarea[placeholder="\u6709\u7231\u8bc4\u8bba\uff0c\u8bf4\u70b9\u513f\u597d\u542c\u7684\uff5e"]',
      'textarea[placeholder*="\u6709\u7231\u8bc4\u8bba"]',
      '[contenteditable="true"]'
    ].filter(Boolean))].join(',');
    const editors = root.locator(editorSelector);
    const editorCount = Math.min(await editors.count().catch(() => 0), 20);
    const usableEditors = [];
    const editorCandidates = [];
    for (let index = 0; index < editorCount; index += 1) {
      const editor = editors.nth(index);
      if (!await editor.isVisible().catch(() => false)) continue;
      const evidence = await editor.evaluate(element => ({
        tagName: String(element.tagName || '').toLowerCase(),
        placeholder: element.getAttribute('placeholder') || element.getAttribute('data-placeholder') || '',
        ariaLabel: element.getAttribute('aria-label') || '',
        contentEditable: element.isContentEditable === true || element.getAttribute('contenteditable') === 'true',
        disabled: element.disabled === true || element.readOnly === true || element.getAttribute('aria-disabled') === 'true',
        value: element.value || element.innerText || element.textContent || ''
      })).catch(() => null);
      if (!evidence) continue;
      const editable = (evidence.tagName === 'textarea' || evidence.contentEditable) && !evidence.disabled;
      editorCandidates.push({ index, ...evidence, editable });
      if (editable) usableEditors.push({ editor, evidence });
    }
    if (usableEditors.length !== 1) {
      return {
        ok: false,
        reason: usableEditors.length ? 'COMMENT_EDITOR_CONTROL_AMBIGUOUS' : 'COMMENT_EDITOR_CONTROL_MISSING',
        count: usableEditors.length,
        editorCount,
        editorCandidates
      };
    }

    const { editor, evidence: contextEvidence } = usableEditors[0];
    const contextText = clean([contextEvidence.placeholder, contextEvidence.ariaLabel].join(' '));
    if (/\u56de\u590d/.test(contextText) && clean(payload.userName) && !contextText.includes(clean(payload.userName))) {
      return { ok: false, reason: 'COMMENT_EDITOR_CONTEXT_MISMATCH', contextEvidence };
    }
    return { ok: true, root, editor, contextEvidence, rootCount: visibleRoots.length, editorCount: usableEditors.length };
  }

  async findDouyinCommentSend(editorRoot, { requireEnabled = true } = {}) {
    if (!editorRoot) return { ok: false, reason: 'COMMENT_SEND_SCOPE_MISSING', count: 0 };
    const configuredSelectors = [...new Set((this.spec.commentSendSelectors || []).filter(Boolean))];
    const selector = [...configuredSelectors, 'button', '[role="button"]'].join(',');
    const controls = editorRoot.locator(selector);
    const controlCount = Math.min(await controls.count().catch(() => 0), 30);
    const candidates = [];
    for (let index = 0; index < controlCount; index += 1) {
      const control = controls.nth(index);
      if (!await control.isVisible().catch(() => false)) continue;
      const evidence = await control.evaluate((element, configured) => {
        const text = value => String(value || '').replace(/\s+/g, ' ').trim();
        const label = text(element.innerText || element.textContent || element.getAttribute('aria-label') || element.getAttribute('title'));
        return {
          tagName: String(element.tagName || '').toLowerCase(),
          text: label,
          ariaLabel: element.getAttribute('aria-label') || '',
          title: element.getAttribute('title') || '',
          className: String(element.className?.baseVal || element.className || ''),
          configuredMatch: configured.length > 0 && configured.some(item => {
            try { return element.matches(item); } catch { return false; }
          }),
          disabledAttribute: element.disabled === true || element.getAttribute('aria-disabled') === 'true'
        };
      }, configuredSelectors).catch(() => null);
      if (!evidence) continue;
      const semanticMatch = [evidence.text, evidence.ariaLabel, evidence.title]
        .some(value => /^(?:\u53d1\u9001|\u8bc4\u8bba)$/.test(clean(value)));
      // Douyin currently gives both "??" and "??" the same cmt-btn-* class.
      // A configured CSS match alone is therefore insufficient; require exact send semantics.
      if (!semanticMatch) continue;
      const enabled = !evidence.disabledAttribute && await control.isEnabled().catch(() => true);
      candidates.push({ control, evidence: { ...evidence, semanticMatch, enabled } });
    }
    const usable = requireEnabled ? candidates.filter(item => item.evidence.enabled) : candidates;
    if (usable.length !== 1) {
      return {
        ok: false,
        reason: usable.length ? 'COMMENT_SEND_AMBIGUOUS' : (candidates.length ? 'COMMENT_SEND_DISABLED' : 'COMMENT_SEND_MISSING'),
        count: usable.length,
        candidateCount: candidates.length,
        candidates: candidates.map(item => item.evidence)
      };
    }
    return { ok: true, control: usable[0].control, evidence: usable[0].evidence, count: 1 };
  }

  async clickDouyinCommentSend(editorRoot) {
    const located = await this.findDouyinCommentSend(editorRoot, { requireEnabled: true });
    if (!located.ok) return { clicked: false, method: null, ...located };
    await this.assertRuntimeAllowed();
    this.douyinReplyAttempted = true;
    await located.control.click();
    return { clicked: true, method: 'comment-editor-scoped-send', evidence: located.evidence };
  }
}
