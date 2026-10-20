import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chromium } from 'playwright-core';
import { cleanupDir, startServer, stopChild, openWorkspacePage } from './helpers/runtime.js';

// 与本项目其它浏览器测试保持一致：优先读 CHROME_EXECUTABLE_PATH，未安装 Chrome 时跳过而不是硬失败。
function installedChromePath() {
  const candidates = [
    process.env.CHROME_EXECUTABLE_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser'
  ].filter(Boolean);
  return candidates.find(candidate => fs.existsSync(candidate)) || null;
}

test('知识库历史版本可重复回滚，状态随当前正式版本更新', { skip: !installedChromePath() }, async t => {
  const runtime = await startServer({ env: {
    INSTANCE_LOCK_ENABLED: 'false', RAG_BASE_URL: '', RAG_ADMIN_ENABLED: 'false', RAG_FORMAL_ROUTING_ENABLED: 'false'
  } });
  t.after(async () => { await stopChild(runtime.child); cleanupDir(runtime.dir); });
  const browser = await chromium.launch({ headless: true, executablePath: installedChromePath() });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(5000);
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('dialog', dialog => dialog.accept());

  const releases = [
    { releaseId: 'release-failed', status: 'FAILED', error: { message: '基础知识版本已变化，发布快照已失效' } },
    { releaseId: 'release-current', status: 'ROLLED_BACK' },
    { releaseId: 'release-rolled', status: 'ROLLED_BACK' },
    { releaseId: 'release-published', status: 'PUBLISHED' },
    { releaseId: 'release-building', status: 'BUILDING' }
  ].map(item => ({
    knowledgeVersion: `kb-${item.releaseId}`, knowledgeBaseId: 'main-business-kb',
    createdAt: '2026-09-09T03:26:49Z', publishedBy: 'admin', enabledTestCaseCount: 1, disabledTestCaseCount: 0,
    ...item
  }));
  let activeId = 'release-current';
  let rejectRollback = false;
  await page.route('**/api/material-knowledge-drafts', route => route.fulfill({ json: { drafts: [] } }));
  await page.route('**/api/rag/**', async route => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/api/rag/status') return route.fulfill({ json: { rag: { enabled: true, configured: true } } });
    if (pathname === '/api/rag/documents') return route.fulfill({ json: { documents: [] } });
    if (pathname === '/api/rag/releases') return route.fulfill({ json: { releases, active: { release_id: activeId } } });
    if (pathname.endsWith('/members')) return route.fulfill({ json: { members: [] } });
    if (pathname.endsWith('/documents')) return route.fulfill({ json: { documents: [] } });
    const rollback = pathname.match(/^\/api\/rag\/releases\/([^/]+)\/rollback$/);
    if (rollback && route.request().method() === 'POST') {
      if (rejectRollback) return route.fulfill({ status: 422, json: { ok: false, code: 'DISABLED_CASE_VALIDATION_FAILED', message: '目标回滚版本包含当前仍被禁用的错误来源' } });
      const release = releases.find(item => item.releaseId === rollback[1]);
      if (!release || !['PUBLISHED', 'ROLLED_BACK'].includes(release.status)) return route.fulfill({ status: 404, json: { ok: false, message: '可回滚版本不存在' } });
      release.status = 'ROLLED_BACK';
      activeId = release.releaseId;
      return route.fulfill({ json: { release } });
    }
    return route.fulfill({ status: 404, json: { ok: false, message: `未预期的请求 ${pathname}` } });
  });
  const card = releaseId => page.locator('.rag-release-card').filter({ has: page.locator(`.rag-release-details[data-release-id="${releaseId}"]`) });
  await page.goto(runtime.base);
  await openWorkspacePage(page, 'knowledge');
  await card('release-current').waitFor().catch(async error => {
    throw new Error(`${error.message}\n页面错误：${pageErrors.join('\n')}\n提示：${await page.locator('#toast').innerText()}`, { cause: error });
  });

  await t.test('当前版本、历史版本和发布异常使用不同状态，详情与列表一致', async () => {
    for (const [releaseId, label, buttonCount] of [
      ['release-current', '当前正式版本', 0],
      ['release-published', '历史版本', 1],
      ['release-rolled', '历史版本', 1],
      ['release-failed', '发布失败', 0],
      ['release-building', '构建中', 0]
    ]) {
      assert.deepEqual(await card(releaseId).locator('.badge').allTextContents(), [label]);
      assert.equal(await card(releaseId).locator('.rag-release-rollback').count(), buttonCount);
      await card(releaseId).getByRole('button', { name: '详情', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: '发布版本详情' });
      await dialog.waitFor();
      assert.equal(await dialog.locator('.rag-release-summary .badge').innerText(), label);
      await dialog.getByRole('button', { name: '关闭', exact: true }).last().click();
    }
  });

  await t.test('详情打开期间新版本发布成功，弹窗状态跟随列表自动更新', async () => {
    const buildingRelease = releases.find(item => item.releaseId === 'release-building');
    const dialog = page.getByRole('dialog', { name: '发布版本详情' });
    try {
      await card('release-current').getByRole('button', { name: '详情', exact: true }).click();
      await dialog.waitFor();
      assert.equal(await dialog.locator('.rag-release-summary .badge').innerText(), '当前正式版本');
      buildingRelease.status = 'PUBLISHED';
      activeId = 'release-building';
      await page.waitForFunction(() => {
        const button = document.querySelector('.rag-release-details[data-release-id="release-current"]');
        return button?.closest('.rag-release-card')?.querySelector('.badge')?.textContent === '历史版本';
      });
      assert.equal(await dialog.locator('.rag-release-summary .badge').innerText(), '历史版本');
    } finally {
      if (await dialog.count()) await dialog.getByRole('button', { name: '关闭', exact: true }).last().click();
      buildingRelease.status = 'BUILDING';
      activeId = 'release-current';
      await page.locator('#ragReleaseRefresh').click();
      await page.waitForFunction(() => {
        const button = document.querySelector('.rag-release-details[data-release-id="release-current"]');
        return button?.closest('.rag-release-card')?.querySelector('.badge')?.textContent === '当前正式版本';
      });
    }
  });

  await t.test('已回滚的历史版本仍有入口，可在多个版本间反复切换', async () => {
    assert.equal(await card('release-rolled').getByRole('button', { name: '回滚到此版本' }).count(), 1);
    for (const releaseId of ['release-published', 'release-current', 'release-published', 'release-rolled']) {
      const previousId = activeId;
      await card(releaseId).getByRole('button', { name: '回滚到此版本' }).click();
      await page.waitForFunction(id => {
        const button = document.querySelector(`.rag-release-details[data-release-id="${id}"]`);
        return button?.closest('.rag-release-card')?.querySelector('.badge')?.textContent === '当前正式版本';
      }, releaseId);
      assert.equal(await card(releaseId).locator('.rag-release-rollback').count(), 0);
      assert.deepEqual(await card(previousId).locator('.badge').allTextContents(), ['历史版本']);
      assert.equal(await card(previousId).getByRole('button', { name: '回滚到此版本' }).count(), 1);
    }
    await page.reload();
    await openWorkspacePage(page, 'knowledge');
    await card('release-rolled').waitFor();
    assert.deepEqual(await card('release-rolled').locator('.badge').allTextContents(), ['当前正式版本']);
    assert.equal(await card('release-published').getByRole('button', { name: '回滚到此版本' }).count(), 1);

    rejectRollback = true;
    const button = card('release-published').getByRole('button', { name: '回滚到此版本' });
    await button.click();
    await page.locator('#toast.error').filter({ hasText: '目标回滚版本包含当前仍被禁用的错误来源' }).waitFor();
    assert.equal(await button.isEnabled(), true);
    assert.deepEqual(await card('release-rolled').locator('.badge').allTextContents(), ['当前正式版本']);
    assert.deepEqual(await card('release-published').locator('.badge').allTextContents(), ['历史版本']);
  });
  assert.deepEqual(pageErrors, []);
});
