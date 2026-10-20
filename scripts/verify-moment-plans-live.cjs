// Read-only deployment smoke check. The only mutation is authenticating to the admin UI.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
const { execFileSync } = require('node:child_process');
const assert = require('node:assert/strict');
const origin = process.env.ROBOT_ADMIN_URL || 'http://127.0.0.1:8080';
(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}) });
  try {
    const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1440, height: 1000 } });
    await context.addInitScript(() => localStorage.setItem('robot-chat-room-closed', String(Date.now())));
    const denied = await context.request.get(origin + '/api/v1/moments/plans?id=3');
    assert.equal((await denied.json()).code, 401, 'Plans must require authentication');
    const inspect = JSON.parse(execFileSync('docker', ['inspect', 'wechat-robot-admin-backend'], { encoding: 'utf8' }));
    const entry = inspect[0].Config.Env.find(v => v.startsWith('LOGIN_TOKEN='));
    assert.ok(entry, 'Login credential missing');
    const login = await context.request.post(origin + '/api/v1/login', { data: { token: entry.slice('LOGIN_TOKEN='.length) } });
    assert.equal((await login.json()).code, 200, 'Admin authentication failed');
    const state = await (await context.request.get(origin + '/api/v1/moments/plans?id=3')).json();
    assert.equal(state.code, 200, 'Plans API failed');
    assert.ok(Array.isArray(state.data.plans) && Array.isArray(state.data.jobs) && Array.isArray(state.data.categories));
    let blockedMutations = 0;
    await context.route('**/*', route => {
      const req = route.request(), url = new URL(req.url());
      if (url.origin !== origin || req.method() !== 'GET' || url.pathname.includes('/moments/sync')) { if (req.method() !== 'GET') blockedMutations++; return route.abort(); }
      return route.continue();
    });
    const page = await context.newPage();
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.goto(origin);
    if (await page.locator('.ant-notification-notice-close').count()) await page.locator('.ant-notification-notice-close').first().click();
    await page.getByRole('button', { name: '管理机器人' }).first().click();
    await page.getByRole('tab', { name: '朋友圈', exact: true }).click();
    await page.getByRole('button', { name: '发布计划', exact: true }).click();
    await page.getByRole('button', { name: '新建定时发布', exact: true }).waitFor();
    await page.getByRole('button', { name: '新建 AI 内容计划', exact: true }).waitFor();
    assert.deepEqual(errors, []); assert.equal(blockedMutations, 0);
    console.log(JSON.stringify({ authenticatedAPI: 'passed', unauthorizedAccess: 'denied', deployedUI: 'passed', plans: state.data.plans.length, jobs: state.data.jobs.length, knowledgeCategories: state.data.categories.length, realPosts: 0 }));
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
