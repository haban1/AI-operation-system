// Browser regression test: every request is fulfilled locally; no live WeChat/model calls.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}) });
  const root = path.resolve('wechat-assistant/wechat-robot-admin-frontend/dist');
  const out = path.resolve('backups/moment-plans-ui-qa');
  fs.mkdirSync(out, { recursive: true });
  let page;
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, timezoneId: 'Asia/Shanghai', serviceWorkers: 'block' });
    await context.addInitScript(() => localStorage.setItem('robot-chat-room-closed', String(Date.now())));
    page = await context.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    const robot = { id: 3, robot_code: 'offline-test', robot_name: '测试机器人', nickname: '测试机器人', status: 'online', device_type: 'iPad' };
    const state = { plans: [], jobs: [], categories: [{ code: 'business', name: '社区服务知识库' }], assets: [] };
    let uploads = 0, approvals = 0, submissions = 0;
    await context.route('**/*', async route => {
      const req = route.request(), url = new URL(req.url());
      if (url.hostname !== 'robot-ui.test') return route.abort();
      if (url.pathname.startsWith('/api/')) {
        let data = {};
        if (url.pathname === '/api/v1/user/self') data = { role: 'root', display_name: '测试管理员', wechat_id: 'test' };
        else if (url.pathname === '/api/v1/robot/list') data = { items: [robot], total: 1 };
        else if (url.pathname === '/api/v1/robot/view') data = robot;
        else if (url.pathname === '/api/v1/contact/list') data = { items: [{ wechat_id: 'friend1', nickname: '测试好友' }], total: 1 };
        else if (url.pathname === '/api/v1/moments/list') data = { ObjectList: [], ObjectCount: 0 };
        else if (url.pathname === '/api/v1/moments/plans' && req.method() === 'GET') data = state;
        else if (url.pathname === '/api/v1/moments/plan-assets') {
          uploads++; assert.match(req.postDataBuffer().toString(), /name="media"/);
          data = { id: 'asset-test', name: 'test.png', media_type: 'image', size: 70, created_at: 1 }; state.assets.push(data);
        } else if (url.pathname === '/api/v1/moments/plans' && req.method() === 'POST') {
          submissions++;
          assert.equal(url.searchParams.get('id'), '3');
          const body = req.postDataJSON();
          assert.equal(body.timezone, 'Asia/Shanghai'); assert.ok(body.first_run_at > Date.now() / 1000);
          data = state.plans.find(p => p.id === body.id);
          if (!data) {
            data = { ...body, status: body.repeat === 'once' ? 'completed' : 'active', next_run_at: body.repeat === 'once' ? 0 : body.first_run_at + 86400, created_at: 1, updated_at: 1 };
            state.plans.unshift(data);
            state.jobs.unshift({ id: 'job-' + body.id, plan_id: body.id, plan_name: body.name, status: body.publish_mode === 'review' ? 'awaiting_review' : 'scheduled', payload: { ...body.payload, content: body.kind === 'ai' ? '社区为企业提供服务，欢迎咨询。' : body.payload.content }, scheduled_at: body.first_run_at, occurrence_at: body.first_run_at, sources: body.kind === 'ai' ? '社区服务说明' : '', error: '', moment_id: '', created_at: 1, updated_at: 1 });
          }
        } else if (url.pathname === '/api/v1/moments/plan-jobs/action') {
          const body = req.postDataJSON(), job = state.jobs.find(j => j.id === body.job_id); assert.ok(job);
          if (body.action === 'approve') { approvals++; assert.ok(body.scheduled_at > Date.now() / 1000); job.payload.content = body.content; job.status = 'scheduled'; } else job.status = 'cancelled';
        } else if (url.pathname === '/api/v1/moments/plans/action') {
          const body = req.postDataJSON(), plan = state.plans.find(p => p.id === body.plan_id); assert.ok(plan);
          plan.status = { pause: 'paused', resume: 'active', cancel: 'cancelled' }[body.action];
        } else if (req.method() !== 'GET') throw new Error('Unexpected mutation: ' + url.pathname);
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ code: 200, data, message: '' }) });
      }
      const target = path.resolve(root, '.' + (url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname)));
      if (!target.startsWith(root + path.sep) || !fs.existsSync(target)) return route.abort();
      const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
      return route.fulfill({ contentType: types[path.extname(target)] || 'application/octet-stream', body: fs.readFileSync(target) });
    });
    await page.goto('http://robot-ui.test');
    if (await page.locator('.ant-notification-notice-close').count()) await page.locator('.ant-notification-notice-close').click();
    await page.getByRole('button', { name: '管理机器人' }).click();
    await page.getByRole('tab', { name: '朋友圈', exact: true }).click();
    await page.getByRole('button', { name: '发布计划', exact: true }).click();
    await page.getByRole('button', { name: '新建定时发布', exact: true }).click();
    let dialog = page.getByRole('dialog', { name: '新建定时发布', exact: true });
    await dialog.getByLabel('计划名称', { exact: true }).fill('定时图文测试');
    await dialog.getByLabel('朋友圈正文', { exact: true }).fill('下午好，欢迎了解社区服务。');
    await dialog.locator('input[type=file]').setInputFiles({ name: 'test.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1ioAAAAASUVORK5CYII=', 'base64') });
    await dialog.getByRole('button', { name: '保存计划', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    assert.equal(uploads, 1); assert.equal(state.plans.length, 1); assert.deepEqual(state.plans[0].payload.asset_ids, ['asset-test']);
    assert.equal(state.plans[0].repeat, 'once'); assert.equal(state.plans[0].publish_mode, 'auto');
    await page.getByRole('button', { name: '新建 AI 内容计划', exact: true }).click();
    dialog = page.getByRole('dialog', { name: '新建 AI 内容计划', exact: true });
    await dialog.getByLabel('计划名称', { exact: true }).fill('社区服务内容计划');
    await dialog.getByLabel('内容主题', { exact: true }).fill('介绍社区的企业服务');
    await dialog.getByLabel('参考知识库', { exact: true }).click();
    await page.getByText('社区服务知识库', { exact: true }).click();
    await dialog.getByLabel('写作要求', { exact: true }).fill('亲切自然，150字以内');
    await dialog.getByLabel('执行频率', { exact: true }).click();
    await page.getByText('每天', { exact: true }).click();
    await page.screenshot({ path: path.join(out, 'ai-plan-editor.png'), fullPage: true });
    await dialog.getByRole('button', { name: '保存计划', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    assert.equal(state.plans[0].publish_mode, 'review'); assert.equal(state.plans[0].repeat, 'daily'); assert.deepEqual(state.plans[0].knowledge_codes, ['business']);
    await page.getByRole('button', { name: '审核文案', exact: true }).click();
    dialog = page.getByRole('dialog', { name: '审核朋友圈文案', exact: true });
    await dialog.getByLabel('待发布正文', { exact: true }).fill('这是审核后修订的文案。');
    await dialog.getByRole('button', { name: '审核通过并安排发布', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' }); assert.equal(approvals, 1); assert.equal(state.jobs[0].payload.content, '这是审核后修订的文案。');
    await page.getByRole('button', { name: '取消任务', exact: true }).first().click();
    await page.getByRole('button', { name: '确 定', exact: true }).click();
    await page.getByText('已取消', { exact: true }).waitFor();
    await page.getByRole('tab', { name: '发布计划', exact: true }).click();
    await page.getByRole('button', { name: /^暂\s*停$/ }).click();
    await page.getByRole('button', { name: '确 定', exact: true }).click();
    await page.getByRole('button', { name: /^恢\s*复$/ }).waitFor();
    await page.screenshot({ path: path.join(out, 'plans-desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 720, height: 1000 });
    await page.screenshot({ path: path.join(out, 'plans-narrow.png'), fullPage: true });
    assert.equal(submissions, 2); assert.deepEqual(errors, []);
    console.log('PASS: scheduled text+image, AI knowledge plan, default review, recurrence, edit/approve, cancellation, pause, responsive UI. All APIs mocked; real posts: 0.');
  } catch (e) { if (page) { console.error((await page.locator('body').innerText()).slice(-5000)); await page.screenshot({ path: path.join(out, 'failure.png'), fullPage: true }); } throw e; }
  finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
