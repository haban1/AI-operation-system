import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { chromium } from 'playwright-core';
import { startServer, stopChild, cleanupDir } from './helpers/runtime.js';

const chrome = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(fs.existsSync);
const env = { AUTH_ENABLED: 'false', RAG_AUTO_START: 'false', RAG_ADMIN_ENABLED: 'true', OPERATIONS_ANALYTICS_ENABLED: 'false', LOGIN_STATUS_POLL_ENABLED: 'false', ISSUE_DIAGNOSIS_ENABLED: 'false' };

test('file proxy supports CRUD with fixed scope and removes old management APIs', async t => {
  const calls = [];
  const upstream = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    calls.push({ method: req.method, url: req.url, raw });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(req.method === 'GET' ? { documents: [], chunks: [] } : { documentId: 'file-1', documentVersion: 1, deleted: req.method === 'DELETE' }));
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => upstream.close(resolve)));
  const runtime = await startServer({ env: { ...env, RAG_BASE_URL: `http://127.0.0.1:${upstream.address().port}` } });
  t.after(async () => { await stopChild(runtime.child); cleanupDir(runtime.dir); });
  const payload = { filename: 'hello.txt', mimeType: 'text/plain', contentBase64: Buffer.from('隔离测试内容').toString('base64'), knowledgeBaseId: 'untrusted', metadata: { knowledgeBaseId: 'untrusted' } };
  for (const [method, path, body] of [
    ['GET', '/api/rag/files'], ['POST', '/api/rag/files', payload], ['PUT', '/api/rag/files/file-1', payload],
    ['GET', '/api/rag/files/file-1/chunks'], ['DELETE', '/api/rag/files/file-1']
  ]) {
    const response = await fetch(runtime.base + path, { method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    assert.equal(response.status, body ? 202 : 200, await response.text());
  }
  assert.equal(calls.length, 5);
  assert.ok(calls.every(call => call.url.startsWith('/rag-admin-api/v1/files')));
  for (const call of calls.filter(call => ['POST', 'PUT'].includes(call.method))) {
    assert.match(call.raw, /"knowledgeBaseId":"main-business-kb"/);
    assert.doesNotMatch(call.raw, /untrusted|testSessionId/);
    assert.match(call.raw, /隔离测试内容/);
  }
  for (const [method, path] of [
    ['GET', '/api/xiaozhi/options'], ['POST', '/api/xiaozhi/sessions'], ['POST', '/api/xiaozhi/chat'],
    ['GET', '/api/rag/releases'], ['POST', '/api/rag/releases'], ['POST', '/api/rag/releases/id/rollback'],
    ['GET', '/api/knowledge-aliases'], ['GET', '/api/manual-handoff-phrases'], ['GET', '/api/rag/documents']
  ]) {
    const response = await fetch(runtime.base + path, { method, ...(method === 'GET' ? {} : { headers: { 'Content-Type': 'application/json' }, body: '{}' }) });
    assert.equal(response.status, 404, `${method} ${path}`);
  }
  assert.equal(calls.length, 5, 'retired routes must never proxy upstream');
});

for (const width of [1440, 390]) test(`file-only knowledge UI CRUD at ${width}px`, { skip: !chrome }, async t => {
  const runtime = await startServer({ env: { ...env, RAG_BASE_URL: 'http://127.0.0.1:1' } });
  t.after(async () => { await stopChild(runtime.child); cleanupDir(runtime.dir); });
  const browser = await chromium.launch({ executablePath: chrome, headless: true }); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width, height: 1000 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  let documents = [{ documentId: 'doc-1', filename: '<img onerror=alert(1)>.txt', usageStatus: 'ACTIVE', documentVersion: 1, createdAt: '2026-11-10T00:00:00Z' }];
  let failEdit = true; const requests = [];
  await page.route('**/api/rag/**', async route => {
    const req = route.request(); const path = new URL(req.url()).pathname; requests.push({ method: req.method(), path });
    let data = {};
    if (path === '/api/rag/status') data = { rag: { enabled: true, configured: true } };
    else if (path.endsWith('/chunks')) data = { chunks: [{ text: '<script>window.unsafe=true</script>\n隔离测试正文' }] };
    else if (req.method() === 'POST') { const item = req.postDataJSON(); documents.unshift({ documentId: 'doc-2', filename: item.filename, documentVersion: 1, usageStatus: 'ACTIVE' }); data = { document: documents[0] }; }
    else if (req.method() === 'PUT') {
      if (failEdit) return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ ok: false, message: '模拟保存失败' }) });
      documents[0] = { ...documents[0], filename: req.postDataJSON().filename, documentVersion: 2 }; data = { document: documents[0] };
    } else if (req.method() === 'DELETE') { documents = documents.filter(item => item.documentId !== path.split('/').pop()); data = { document: { deleted: true } }; }
    else data = { documents };
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, ...data }) });
  });
  await page.goto(runtime.base + '/#documents');
  await page.locator('.knowledge-files-page').waitFor({ timeout: 8000 }).catch(async error => { throw new Error(`${error.message}\nPage errors: ${JSON.stringify(errors)}\n${await page.locator('body').innerText()}`); });
  assert.equal(await page.locator('#workspaceSubnav').isVisible(), true);
  assert.equal(await page.locator('#workspaceSubnav button').count(), 3);
  assert.doesNotMatch(await page.locator('#content').innerText(), /发布版本|相似问法|回答风格|转人工说法|回复测试|回归测试|小智|回退|权限/);
  assert.equal(await page.locator('.knowledge-file-info img').count(), 0);
  await page.locator('[data-file-action=view]').click();
  await page.getByText('隔离测试正文', { exact: false }).waitFor();
  assert.equal(await page.evaluate(() => window.unsafe), undefined);
  await page.keyboard.press('Escape');
  await page.locator('#knowledgeFileSearch').fill('不存在');
  assert.equal(await page.locator('.knowledge-file-row:visible').count(), 0);
  await page.locator('#knowledgeFileSearch').fill('');
  await page.locator('#knowledgeFileInput').setInputFiles({ name: '新增.txt', mimeType: 'text/plain', buffer: Buffer.from('新增内容') });
  await page.locator('#knowledgeFileUpload button').click();
  await page.locator('.knowledge-file-info b', { hasText: '新增.txt' }).waitFor();
  await page.locator('[data-file-id=doc-2] [data-file-action=edit]').click();
  await page.locator('.knowledge-file-edit input').setInputFiles({ name: '修改.txt', mimeType: 'text/plain', buffer: Buffer.from('修改内容') });
  await page.locator('.knowledge-file-edit [type=submit]').click();
  await page.getByText('模拟保存失败', { exact: true }).waitFor();
  assert.equal(await page.locator('.knowledge-file-edit input').evaluate(input => input.files[0].name), '修改.txt');
  failEdit = false;
  await page.locator('.knowledge-file-edit [type=submit]').click();
  await page.locator('.knowledge-file-info b', { hasText: '修改.txt' }).waitFor();
  await page.locator('[data-file-id=doc-2] [data-file-action=delete]').click();
  await page.locator('.confirm-cancel').click();
  assert.equal(documents.length, 2);
  await page.locator('[data-file-id=doc-2] [data-file-action=delete]').click();
  await page.locator('.confirm-submit').click();
  await page.waitForFunction(() => document.querySelectorAll('.knowledge-file-row').length === 1);
  for (const hash of ['versions', 'aliases', 'handoff-rules']) {
    await page.evaluate(hash => { location.hash = hash; }, hash);
    await page.waitForFunction(() => location.hash === '#documents');
    assert.equal(await page.locator('.knowledge-files-page').count(), 1);
  }
  assert.ok(requests.every(item => /^\/api\/rag\/(?:status|files)/.test(item.path)));
  assert.deepEqual(errors, []);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 2), false);
  await page.screenshot({ path: `.codex-work/knowledge-files-20261110/files-${width}.png`, fullPage: true });
});
