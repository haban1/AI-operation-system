import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { startServer, stopChild, cleanupDir } from './helpers/runtime.js';
import { revealControl } from './helpers/ui-details.js';

const chrome = [process.env.CHROME_EXECUTABLE_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/chromium'].filter(Boolean).find(file => fs.existsSync(file));
const candidate = process.env.PUBLISH_UI_CANDIDATE_DIR;
const evidence = process.env.PUBLISH_UI_EVIDENCE_DIR;

async function isolatedPage(browser, runtime) {
  const bootstrap = await (await fetch(runtime.base + '/api/bootstrap')).json();
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  const fixture = { writes: [], errors: [], review: 'PASSED', reviewStatus: 'SUCCESS', precheck: 'PASSED', task: null };
  page.on('pageerror', error => fixture.errors.push(error.message));
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    const json = (data, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify({ ok: status < 400, ...data }) });
    if (url.origin !== runtime.base) return route.abort();
    if (!['GET', 'HEAD'].includes(request.method())) {
      const body = request.postDataJSON();
      fixture.writes.push({ url: url.pathname, body });
      if (url.pathname === '/api/local-agent/precheck') return json({ precheck: { overall: fixture.precheck, meta: { type: 'image', format: 'png', width: 1280, height: 720, sha256: 'isolated-sha' }, results: body.platforms.map(platformCode => ({ platformCode, status: fixture.precheck })) }, previewUrl: '/isolated-material.svg' });
      if (url.pathname === '/api/local-agent/ai-review') return json({ review: { status: fixture.reviewStatus, overall: fixture.review, findings: [] } });
      if (url.pathname === '/api/local-agent/traffic-prediction') return json({ prediction: { status: 'FAILED', message: '隔离测试不调用模型' } });
      if (url.pathname === '/api/publish/tasks') return json({ task: { id: 9001 } });
      if (url.pathname === '/api/publish/schedules') return json({ schedule: { id: 9002, scheduled_at: body.scheduledAt } });
      return json({ message: '未声明的隔离写请求' }, 400);
    }
    if (candidate && ['/', '/index.html', '/app.js', '/workspace.css', '/workspace-presentation.js', '/publish-flow.js'].includes(url.pathname)) {
      const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      return route.fulfill({ contentType: name.endsWith('.html') ? 'text/html' : name.endsWith('.css') ? 'text/css' : 'application/javascript', body: fs.readFileSync(path.join(candidate, name)) });
    }
    if (url.pathname.endsWith('/isolated-material.svg')) return route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720"><rect width="1280" height="720" fill="#203f37"/><text x="640" y="380" text-anchor="middle" fill="#b8d8c7" font-size="50">素材预览</text></svg>' });
    if (url.pathname === '/api/tasks') return json({ tasks: fixture.task ? [fixture.task] : [], total: fixture.task ? 1 : 0, platformCounts: [] });
    if (fixture.task && url.pathname === `/api/tasks/${fixture.task.id}`) return json({ task: fixture.task });
    if (url.pathname === '/api/bootstrap') {
      const data = structuredClone(bootstrap);
      data.platforms = ['douyin', 'weibo', 'bilibili'].map((code, index) => ({ code, name: ['抖音', '微博', 'B站'][index], lifecycle_state: 'ACTIVE', desired_state: 'RUNNING', effective_state: 'RUNNING', task_execution_state: index === 2 ? 'STOPPED' : 'RUNNING' }));
      data.accounts = data.platforms.map((platform, index) => ({ id: index + 2, platform_code: platform.code, platform_name: platform.name, display_name: '隔离演示账号', profile_name: 'isolated-' + index, enabled: 1, login_status: 'READY' }));
      data.config = { ...data.config, audioContentAutoTrigger: false, masterSwitch: { enabled: true } };
      data.localAgent = { online: true };
      return json(data);
    }
    return route.continue();
  });
  await page.goto(runtime.base + '/#publishing');
  try { await page.locator('[data-publish-goto="1"]').waitFor(); }
  catch (error) { throw new Error(`${error.message}\n${JSON.stringify(fixture)}\n${(await page.locator('body').innerText()).slice(-3500)}`); }
  return { context, page, fixture };
}

async function fillContent(page) {
  await revealControl(page.locator('#materialPath'));
  await page.locator('#materialPath').fill('isolated-material.png');
  await page.locator('#publishTitle').fill('社区服务介绍');
  await page.locator('#publishBody').fill('了解社区服务与活动安排，欢迎一起参与。');
  await page.locator('#contentOrigin').selectOption('HUMAN_ORIGINAL');
}

async function prepareReview(page) {
  await fillContent(page);
  await page.locator('[data-publish-next]').click();
  await page.locator('.platform-check[data-platform="douyin"]').check();
  await page.locator('[data-publish-next]').click();
  await page.locator('#runPrecheck').click();
  await page.waitForFunction(() => document.querySelector('#precheckBox').textContent.includes('平台适配检测通过'));
}

test('发布三步流程保留草稿、原审核门禁与提交合同', { skip: !chrome }, async t => {
  const runtime = await startServer({ env: { RAG_AUTO_START: 'false', RAG_ADMIN_ENABLED: 'false', OPERATIONS_ANALYTICS_ENABLED: 'false', LOGIN_STATUS_POLL_ENABLED: 'false', ISSUE_DIAGNOSIS_ENABLED: 'false' } });
  t.after(async () => { await stopChild(runtime.child); cleanupDir(runtime.dir); });
  const browser = await chromium.launch({ executablePath: chrome, headless: true });
  t.after(() => browser.close());

  await t.test('步骤验证、自由返回、账号折叠与排期切换保留草稿', async child => {
    const { page, context, fixture } = await isolatedPage(browser, runtime);
    child.after(() => context.close());
    assert.equal(await page.locator('[data-publish-stage]:visible').count(), 1);
    for (const id of ['materialPath', 'publishTitle', 'publishBody', 'materialFile', 'contentOrigin', 'runPrecheck', 'runCompliance', 'warningConfirmed', 'autoPublish', 'scheduledPublishButton', 'publishSubmitButton', 'selectAllPlatforms']) assert.equal(await page.locator('#' + id).count(), 1, id);
    await page.locator('[data-publish-next]').click();
    assert.equal(await page.locator('#publishForm').getAttribute('data-publish-step'), '1');
    assert.match(await page.locator('.publish-flow-error').innerText(), /选择图片或视频/);
    await fillContent(page);
    await page.locator('#publishTitle').press('Enter');
    assert.equal(fixture.writes.some(item => item.url === '/api/publish/tasks'), false);
    assert.equal(await page.locator('#publishForm').getAttribute('data-publish-step'), '2');
    await page.locator('[data-publish-next]').click();
    assert.match(await page.locator('.publish-flow-error').innerText(), /至少选择/);
    const blocked = page.locator('.platform-check[data-platform="bilibili"]');
    assert.equal(await blocked.isVisible(), false);
    await page.locator('#publishStage2 details > summary').click();
    assert.equal(await blocked.isDisabled(), true);
    await page.locator('#selectAllPlatforms').click();
    assert.equal(await page.locator('.platform-check:checked').count(), 2);
    assert.equal(await blocked.isChecked(), false);
    await page.locator('#selectAllPlatforms').click();
    await page.locator('.platform-check[data-platform="douyin"]').check();
    await page.locator('[data-publish-next]').click();
    assert.match(await page.locator('.publish-flow-summary').innerText(), /社区服务介绍.*|抖音/);
    await page.locator('[data-workspace-item="schedule"]').click();
    await page.locator('#publishHistory').waitFor();
    assert.equal(await page.locator('.publish-flow-nav').isVisible(), false);
    await page.locator('[data-workspace-item="publishing"]').click();
    assert.equal(await page.locator('#publishForm').getAttribute('data-publish-step'), '3');
    await page.locator('[data-publish-back]').click();
    assert.equal(await page.locator('.platform-check[data-platform="douyin"]').isChecked(), true);
    await page.locator('[data-publish-back]').click();
    assert.equal(await page.locator('#publishTitle').inputValue(), '社区服务介绍');
    assert.deepEqual(fixture.errors, []);
  });

  await t.test('缺少预检、审核失败、阻断及未确认警告均不能提交', async child => {
    const { page, context, fixture } = await isolatedPage(browser, runtime);
    child.after(() => context.close());
    await page.locator('[data-publish-goto="3"]').click();
    await page.locator('#publishSubmitButton').click();
    assert.equal(await page.locator('#publishForm').getAttribute('data-publish-step'), '1', '隐藏必填项自动定位');
    await prepareReview(page);
    await page.locator('#publishSubmitButton').click();
    assert.match(await page.locator('#toast').innerText(), /先执行 AI/);
    for (const [status, overall, message] of [['FAILED', 'PASSED', /未成功/], ['SUCCESS', 'BLOCKED', /阻断/], ['SUCCESS', 'WARNING', /确认.*警告/]]) {
      fixture.reviewStatus = status; fixture.review = overall;
      await page.locator('#runCompliance').click();
      await page.waitForFunction(() => !document.querySelector('#runCompliance').disabled);
      await page.locator('#publishSubmitButton').click();
      assert.match(await page.locator('#toast').innerText(), message);
    }
    assert.equal(fixture.writes.filter(item => item.url === '/api/publish/tasks').length, 0);
    await page.locator('#warningConfirmed').check();
    await page.locator('#publishSubmitButton').click();
    await page.waitForURL('**/#publish-tasks');
    const payload = fixture.writes.find(item => item.url === '/api/publish/tasks').body;
    assert.equal(payload.publishMode, 'DRAFT_ONLY');
    assert.equal(payload.managementConfirmed, false);
    assert.equal(payload.complianceConfirmed, true);
    assert.deepEqual(payload.targets, [{ platformCode: 'douyin', accountId: 2 }]);
    assert.equal(payload.title, '社区服务介绍');
    assert.equal(payload.contentOrigin, 'HUMAN_ORIGINAL');
    assert.deepEqual(fixture.errors, []);
  });

  for (const scheduled of [false, true]) await t.test(scheduled ? '定时发布沿用原弹窗与载荷' : '明确勾选后才创建 AUTO 任务', async child => {
    const { page, context, fixture } = await isolatedPage(browser, runtime);
    child.after(() => context.close());
    await prepareReview(page);
    fixture.precheck = 'BLOCKED';
    await page.locator('#runPrecheck').click();
    await page.waitForFunction(() => document.querySelector('#precheckBox').textContent.includes('平台适配未通过'));
    await page.locator('#publishSubmitButton').click();
    assert.match(await page.locator('#toast').innerText(), /素材格式不符合/);
    fixture.precheck = 'PASSED';
    await page.locator('#runPrecheck').click();
    await page.waitForFunction(() => document.querySelector('#precheckBox').textContent.includes('平台适配检测通过'));
    await page.locator('#runCompliance').click();
    await page.waitForFunction(() => !document.querySelector('#runCompliance').disabled);
    assert.equal(await page.locator('#autoPublish').isChecked(), false);
    assert.equal(await page.locator('#publishSubmitButton').innerText(), '创建草稿任务');
    await page.locator('#autoPublish').check();
    assert.equal(await page.locator('#publishSubmitButton').innerText(), '确认发布');
    if (scheduled) {
      await page.locator('#scheduledPublishButton').click();
      await page.locator('#scheduleCreateSubmit').click();
    } else await page.locator('#publishSubmitButton').click();
    await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('已创建'));
    const payload = fixture.writes.find(item => item.url === (scheduled ? '/api/publish/schedules' : '/api/publish/tasks')).body;
    assert.equal(payload.publishMode, 'AUTO');
    assert.equal(payload.managementConfirmed, true);
    assert.equal(payload.materialPath, 'isolated-material.png');
    assert.equal(payload.aiReview.status, 'SUCCESS');
    if (scheduled) { assert.ok(Date.parse(payload.scheduledAt) > Date.now()); assert.equal(typeof payload.timezoneOffsetMinutes, 'number'); }
    assert.deepEqual(fixture.errors, []);
  });

  await t.test('失败重试带入文案和账号，重新审核且不继承自动发布授权', async child => {
    const { page, context, fixture } = await isolatedPage(browser, runtime);
    child.after(() => context.close());
    fixture.task = { id: 8123, title: '失败任务的标题', body: '失败任务的正文', material_path: 'retry-material.png', status: 'FAILED', created_at: '2026-11-10T00:00:00Z', targets: [{ id: 8124, platform_code: 'douyin', account_id: 2, status: 'FAILED' }] };
    await page.locator('[data-publish-goto="3"]').click();
    await page.locator('#autoPublish').check();
    await page.locator('[data-workspace-item="publish-tasks"]').click();
    await revealControl(page.locator('[data-retry-task="8123"]'));
    await page.locator('[data-retry-task="8123"]').click();
    await page.locator('#publishTitle').waitFor();
    assert.equal(await page.locator('#publishTitle').inputValue(), fixture.task.title);
    assert.equal(await page.locator('#publishBody').inputValue(), fixture.task.body);
    assert.equal(await page.locator('#materialPath').inputValue(), fixture.task.material_path);
    assert.equal(await page.locator('#autoPublish').isChecked(), false);
    await page.locator('#contentOrigin').selectOption('HUMAN_ORIGINAL');
    await page.locator('[data-publish-next]').click();
    assert.equal(await page.locator('.platform-check[data-platform="douyin"]').isChecked(), true);
    await page.locator('[data-publish-next]').click();
    await page.locator('#publishSubmitButton').click();
    assert.match(await page.locator('#toast').innerText(), /先执行 AI/);
    await page.locator('#runCompliance').click();
    await page.waitForFunction(() => !document.querySelector('#runCompliance').disabled);
    await page.locator('#publishSubmitButton').click();
    await page.waitForURL('**/#publish-tasks');
    const payload = fixture.writes.find(item => item.url === '/api/publish/tasks').body;
    assert.equal(payload.retryOfTaskId, 8123);
    assert.equal(payload.publishMode, 'DRAFT_ONLY');
    assert.equal(payload.title, fixture.task.title);
    assert.deepEqual(fixture.errors, []);
  });

  await t.test('桌面和手机三个步骤不溢出且操作按钮可见', async child => {
    const { page, context, fixture } = await isolatedPage(browser, runtime);
    child.after(() => context.close());
    await prepareReview(page);
    if (evidence) fs.mkdirSync(evidence, { recursive: true });
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      for (const step of [1, 2, 3]) {
        await page.locator(`[data-publish-goto="${step}"]`).click();
        assert.equal(await page.locator('[data-publish-stage]:visible').count(), 1);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${width}/${step}`);
        assert.equal(await page.locator(step === 3 ? '#publishSubmitButton' : '[data-publish-next]').isVisible(), true);
        const bounds = await page.locator('.publish-flow-footer').evaluate(footer => [...footer.querySelectorAll('button:not([hidden])')].filter(item => item.getBoundingClientRect().width).map(item => ({ text: item.textContent, left: item.getBoundingClientRect().left, right: item.getBoundingClientRect().right, top: item.getBoundingClientRect().top, bottom: item.getBoundingClientRect().bottom })));
        for (const rect of bounds) assert.ok(rect.left >= 0 && rect.right <= width, JSON.stringify(rect));
        assert.ok(await page.locator('.publish-flow-nav ol').evaluate(item => item.getBoundingClientRect().width > item.closest('form').getBoundingClientRect().width * .9));
        if (evidence) {
          fs.writeFileSync(path.join(evidence, `publish-${width}-step-${step}.json`), JSON.stringify(bounds, null, 2));
          await page.waitForFunction(() => !document.querySelector('#toast').classList.contains('show'));
          await page.screenshot({ path: path.join(evidence, `publish-${width}-step-${step}.png`), fullPage: true });
        }
      }
    }
    assert.deepEqual(fixture.errors, []);
  });
});
