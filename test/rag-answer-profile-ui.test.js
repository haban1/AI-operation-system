import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chromium } from 'playwright-core';

const chromePath = [process.env.CHROME_EXECUTABLE_PATH, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].filter(Boolean).find(path => fs.existsSync(path));
const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const tabs = source.slice(source.indexOf('function renderKnowledgeTabs(){'), source.indexOf('function bindKnowledgeTabs(){'));
const implementation = source.slice(source.indexOf('const RAG_DEFAULT_ANSWER_PROFILE ='), source.indexOf('async function renderKnowledge(){'));

test('answer-style form loads saved values, cancels without saving, preserves failed edits and safely renders text', { skip: !chromePath }, async () => {
  const browser = await chromium.launch({ executablePath: chromePath, headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<main id="content"></main>');
    await page.addScriptTag({ content: `
      const state={page:'knowledge',knowledgeView:'persona'};
      const $=selector=>document.querySelector(selector);
      const esc=value=>String(value).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
      function clearRagKnowledgePoll(){} function bindKnowledgeTabs(){}
      window.calls=[]; window.failLoad=false; window.failSave=false;
      window.saved={assistantName:'智慧驱动答疑助手',companyName:'智慧驱动',stylePrompt:'先回答，再解释。',greeting:'你好'};
      async function api(path,options={}){window.calls.push({path,method:options.method||'GET',body:options.body});if(window.failLoad)throw new Error('加载中断');if(options.method==='PUT'){if(window.failSave)throw new Error('保存中断');window.saved=JSON.parse(options.body)}return {profile:{...window.saved}}}
      ${tabs}\n${implementation}
      window.renderProfile=renderRagAnswerProfile;
    ` });
    await page.evaluate(() => window.renderProfile());
    assert.equal(await page.locator('[name=companyName]').inputValue(), '智慧驱动');
    await page.locator('[name=stylePrompt]').fill('未保存的修改');
    await page.locator('#ragAnswerProfileCancel').click();
    assert.equal(await page.locator('[name=stylePrompt]').inputValue(), '先回答，再解释。');
    assert.equal(await page.evaluate(() => window.calls.filter(item => item.method === 'PUT').length), 0);
    await page.locator('[name=stylePrompt]').fill('失败后应保留的输入');
    await page.evaluate(() => { window.failSave = true; });
    await page.locator('button[type=submit]').click();
    await page.waitForFunction(() => document.querySelector('#ragAnswerProfileStatus').textContent.includes('保存未确认'));
    assert.equal(await page.locator('[name=stylePrompt]').inputValue(), '失败后应保留的输入');
    assert.equal(await page.locator('fieldset').isDisabled(), false);
    await page.evaluate(() => { window.failSave = false; });
    await page.locator('button[type=submit]').click();
    await page.waitForFunction(() => document.querySelector('#ragAnswerProfileStatus').textContent.startsWith('已保存'));
    await page.evaluate(() => window.renderProfile());
    assert.equal(await page.locator('[name=stylePrompt]').inputValue(), '失败后应保留的输入');
    await page.evaluate(() => { window.saved.assistantName = '<img src=x onerror="window.injected=true">'; });
    await page.evaluate(() => window.renderProfile());
    assert.equal(await page.locator('img').count(), 0);
    assert.equal(await page.evaluate(() => window.injected), undefined);
    await page.evaluate(() => { window.failLoad = true; });
    await page.evaluate(() => window.renderProfile());
    assert.equal(await page.locator('form').count(), 0, 'failed load must not offer editable default values');
    assert.equal(await page.locator('#ragAnswerProfileRetry').count(), 1);
    await page.evaluate(() => { window.failLoad = false; });
    await page.locator('#ragAnswerProfileRetry').click();
    await page.waitForSelector('form');
    assert.equal(await page.locator('[name=assistantName]').getAttribute('maxlength'), '60');
    assert.equal(await page.locator('[name=stylePrompt]').getAttribute('maxlength'), '4000');
  } finally {
    await browser.close();
  }
});
