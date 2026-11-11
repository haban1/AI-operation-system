import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { managementRecordStatus, publishPageEvidenceText } from '../agent/rpa-adapters/assisted-platform.js';
import { BilibiliAssistedRpaAdapter } from '../agent/rpa-adapters/bilibili-assisted.js';

const executablePath = [process.env.CHROME_EXECUTABLE_PATH, 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', '/usr/bin/chromium'].find(value => value && fs.existsSync(value));

test('management status excludes authored rejected text but preserves actual rejection', () => {
  const title = '先建台账，再跑审计';
  const body = '候选通过 verify 验证，证伪进 rejected。';
  assert.equal(managementRecordStatus({ title, body, recordText: `${title} ${body} 2026年11月03日 15:33 已发布 播放 0` }), 'PUBLISHED');
  assert.equal(managementRecordStatus({ title, body, recordText: `${title} ${body} 审核未通过` }), 'REJECTED');
  assert.equal(managementRecordStatus({ title, body, recordText: `${title} ${body} 审核中` }), 'REVIEWING');
  assert.equal(managementRecordStatus({ title, body, recordText: `${title} ${body}` }), 'UNKNOWN');
});

test('publish notices exclude editable descriptions and retain a real security prompt', { skip: !executablePath }, async () => {
  const browser = await chromium.launch({ headless: true, executablePath, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    await page.setContent('<div contenteditable="true"><p>verify captcha 安全验证</p></div><textarea>审核未通过</textarea><div style="display:none">captcha</div><button>发布</button>');
    assert.equal(await publishPageEvidenceText(page), '发布');
    await page.locator('body').evaluate(root => { const warning = document.createElement('div'); warning.role = 'dialog'; warning.textContent = '请完成安全验证 captcha'; root.append(warning); });
    assert.match(await publishPageEvidenceText(page), /请完成安全验证 captcha/);
  } finally { await browser.close(); }
});

test('Bilibili selects a declaration with nested explanation and delayed menu', { skip: !executablePath }, async () => {
  const browser = await chromium.launch({ headless: true, executablePath, args: ['--no-sandbox'] });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bilibili-declaration-'));
  try {
    const page = await browser.newPage();
    await page.setContent(`<div class="bcc-select"><input class="bcc-select-input-inner" placeholder="请选择符合您视频内容的创作声明" readonly>
      <ul class="bcc-select-option-list" style="display:none"><li class="bcc-option">内容无需标注</li><li class="bcc-option">含 AI 生成内容<span>平台将添加内容标识</span></li></ul></div>`);
    await page.locator('input').evaluate(input => {
      input.onclick = () => setTimeout(() => { document.querySelector('ul').style.display = 'block'; }, 500);
      const option = document.querySelectorAll('li')[1];
      option.onclick = () => { input.value = '含AI生成内容'; option.classList.add('selected'); document.querySelector('ul').style.display = 'none'; };
    });
    const adapter = new BilibiliAssistedRpaAdapter({ logsDir: root, profileDir: path.join(root, 'profile') });
    const result = await adapter.applyContentDeclaration(page, { contentOrigin: 'AI_GENERATED' });
    assert.equal(result.verified, true);
    assert.equal(await page.locator('input').inputValue(), '含AI生成内容');
  } finally { await browser.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('Bilibili resumes only the same unfinished draft and checks rendered identity', { skip: !executablePath }, async () => {
  const browser = await chromium.launch({ headless: true, executablePath, args: ['--no-sandbox'] });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bilibili-draft-identity-'));
  try {
    const page = await browser.newPage();
    const adapter = new BilibiliAssistedRpaAdapter({ logsDir: root, profileDir: path.join(root, 'profile') });
    const state = { title: '先建台账，再跑审计', materialName: 'ab87bd6a96e5a0f5ace9414df0d6ef182f48ba266ed9c3d21d5ecca4e2a74400.mp4' };
    const stem = state.materialName.slice(0, -4);
    await page.setContent(`<input placeholder="稿件标题" value="${state.title}"><div>${stem}</div><span>上传完成</span>`);
    assert.equal((await adapter.verifyManagedDraftPage(page, state)).matched, true);
    await page.locator('div').evaluate(el => { el.textContent += 'different'; });
    assert.equal((await adapter.verifyManagedDraftPage(page, state)).matched, false);
    await page.locator('div').evaluate((el, text) => { el.textContent = text; }, stem);
    await page.locator('input').fill('其他草稿');
    assert.equal((await adapter.verifyManagedDraftPage(page, state)).matched, false);
  } finally { await browser.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
