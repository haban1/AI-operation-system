import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DouyinAssistedRpaAdapter } from '../agent/rpa-adapters/douyin-assisted.js';

function createAdapter(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const adapter = new DouyinAssistedRpaAdapter({
    platformCode: 'douyin',
    logsDir: dir,
    profileDir: path.join(dir, 'profile'),
    executablePath: '',
    loginTimeoutMs: 1000,
    sendTimeoutMs: 1000
  });
  adapter.assertRuntimeAllowed = async () => {};
  return { adapter, dir };
}

function createPage(adapter, reloadError, bodyText = '') {
  let reloadCalls = 0;
  return {
    page: {
      url() { return adapter.spec.commentUrl; },
      async reload() {
        reloadCalls += 1;
        throw reloadError;
      },
      async waitForTimeout() {},
      locator(selector) {
        if (selector === 'body') return { async innerText() { return bodyText; } };
        if (selector === 'a,button,input,textarea,[role="button"],[role="menuitem"],[role="tab"],nav') {
          return { async evaluateAll() { return []; } };
        }
        return {
          async count() { return 0; },
          nth() { return this; },
          async isVisible() { return false; }
        };
      }
    },
    reloadCalls() { return reloadCalls; }
  };
}

test('Douyin reload TimeoutError continues with verified DOM rows and does not refresh twice', async () => {
  const { adapter, dir } = createAdapter('douyin-refresh-timeout-rows-');
  try {
    const error = new Error('navigation timed out');
    error.name = 'TimeoutError';
    const fake = createPage(adapter, error, '评论管理');
    let refreshCalls = 0;
    adapter.classifyLiveMessagePage = async () => ({ valid: true, reason: 'VERIFIED_DOM' });
    adapter.firstVisibleSelector = async (_page, selectors) => selectors === adapter.spec.commentReadySelectors
      ? adapter.spec.commentReadySelectors[0]
      : null;
    adapter.refreshDouyinCommentListIfOffered = async () => { refreshCalls += 1; return { loaded: false }; };

    const result = await adapter.recoverDouyinCommentListAfterRefresh(fake.page, {
      refreshOffered: true,
      refreshClicked: true,
      settleTimeoutMs: 250
    });

    assert.equal(result.loaded, true);
    assert.equal(result.reason, 'COMMENT_ROWS_READY_AFTER_RELOAD');
    assert.equal(result.reloadTimedOut, true);
    assert.equal(result.reloaded, false);
    assert.equal(fake.reloadCalls(), 1);
    assert.equal(refreshCalls, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Douyin page.reload timeout accepts only explicit settled empty DOM evidence', async () => {
  const { adapter, dir } = createAdapter('douyin-refresh-timeout-empty-');
  try {
    const fake = createPage(adapter, new Error('page.reload: Timeout 60000ms exceeded'), '评论管理 暂无评论 点击刷新');
    let refreshCalls = 0;
    adapter.classifyLiveMessagePage = async () => ({ valid: true, reason: 'VERIFIED' });
    adapter.firstVisibleSelector = async () => null;
    adapter.refreshDouyinCommentListIfOffered = async () => { refreshCalls += 1; return { loaded: false }; };

    const result = await adapter.recoverDouyinCommentListAfterRefresh(fake.page, {
      refreshOffered: true,
      refreshClicked: true,
      settleTimeoutMs: 250
    });

    assert.equal(result.stateCleared, true);
    assert.equal(result.empty, true);
    assert.equal(result.reason, 'COMMENT_EMPTY_CONFIRMED_AFTER_RELOAD');
    assert.equal(result.reloadTimedOut, true);
    assert.equal(fake.reloadCalls(), 1);
    assert.equal(refreshCalls, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Douyin net::ERR_TIMED_OUT with an error page returns an explicit deferred result', async () => {
  const { adapter, dir } = createAdapter('douyin-refresh-timeout-unavailable-');
  try {
    const fake = createPage(adapter, new Error('page.reload: net::ERR_TIMED_OUT at https://creator.douyin.com/'), 'This site cannot be reached');
    let refreshCalls = 0;
    adapter.classifyLiveMessagePage = async () => ({ valid: false, reason: 'PAGE_ERROR', evidence: ['page-error'] });
    adapter.refreshDouyinCommentListIfOffered = async () => { refreshCalls += 1; return { loaded: false }; };

    const result = await adapter.recoverDouyinCommentListAfterRefresh(fake.page, {
      refreshOffered: true,
      refreshClicked: true,
      settleTimeoutMs: 250
    });

    assert.equal(result.loaded, false);
    assert.equal(result.stateCleared, false);
    assert.equal(result.reason, 'COMMENT_RECOVERY_DEFERRED_AFTER_RELOAD_TIMEOUT');
    assert.equal(result.deferredReason, 'COMMENT_RECOVERY_PAGE_ERROR');
    assert.equal(result.disposition, 'DEFERRED_PAGE_UNAVAILABLE');
    assert.equal(result.deferred, true);
    assert.equal(result.needsConfirmation, true);
    assert.equal(result.doNotRetryImmediately, true);
    assert.equal(result.reloadTimedOut, true);
    assert.equal(fake.reloadCalls(), 1);
    assert.equal(refreshCalls, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Douyin reload timeout with a blank page defers instead of reporting success', async () => {
  const { adapter, dir } = createAdapter('douyin-refresh-timeout-blank-');
  try {
    const fake = createPage(adapter, new Error('page.reload: Timeout 60000ms exceeded'), '');
    let refreshCalls = 0;
    adapter.classifyLiveMessagePage = async () => ({ valid: false, reason: 'MESSAGE_TEXT_MISSING', evidence: ['message-text-missing'] });
    adapter.refreshDouyinCommentListIfOffered = async () => { refreshCalls += 1; return { loaded: false }; };

    const result = await adapter.recoverDouyinCommentListAfterRefresh(fake.page, {
      refreshOffered: true,
      refreshClicked: true,
      settleTimeoutMs: 250
    });

    assert.equal(result.loaded, false);
    assert.equal(result.stateCleared, false);
    assert.equal(result.reason, 'COMMENT_RECOVERY_DEFERRED_AFTER_RELOAD_TIMEOUT');
    assert.equal(result.deferredReason, 'COMMENT_RECOVERY_MESSAGE_TEXT_MISSING');
    assert.equal(result.disposition, 'DEFERRED_PAGE_UNAVAILABLE');
    assert.equal(result.needsConfirmation, true);
    assert.equal(fake.reloadCalls(), 1);
    assert.equal(refreshCalls, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test('Douyin reload recovery still throws non-navigation failures', async () => {
  const { adapter, dir } = createAdapter('douyin-refresh-non-timeout-');
  try {
    const fake = createPage(adapter, new Error('browser context closed unexpectedly'), '');
    await assert.rejects(
      adapter.recoverDouyinCommentListAfterRefresh(fake.page, {
        refreshOffered: true,
        refreshClicked: true,
        settleTimeoutMs: 250
      }),
      /browser context closed unexpectedly/
    );
    assert.equal(fake.reloadCalls(), 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

