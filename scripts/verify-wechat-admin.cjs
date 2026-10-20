// Only the read-only Tianhe shell is contacted; robot UI requests are mocked.
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright-core');
const assert=require('node:assert/strict');
const path=require('node:path');
(async()=>{
 const browser=await chromium.launch({headless:true,...(process.env.BROWSER_EXECUTABLE?{executablePath:process.env.BROWSER_EXECUTABLE}:{})});
 try {
  const context=await browser.newContext({viewport:{width:1440,height:1000}});
  const page=await context.newPage(); const errors=[];
  let robotConfig={url:'http://robot-admin.test/'};
  page.on('pageerror',e=>errors.push(e.message));
  await context.route('http://robot-admin.test/**',route=>route.fulfill({contentType:'text/html; charset=utf-8',body:'<h1>机器人管理测试页</h1>'}));
  await context.route('**/api/wechat/**',route=>{
   assert.equal(new URL(route.request().url()).pathname,'/api/wechat/robot-admin');
   assert.equal(route.request().method(),'GET');
   return route.fulfill({contentType:'application/json',body:JSON.stringify(robotConfig)});
  });
  const base=process.env.WEB_BASE_URL||'http://127.0.0.1:3100';
  const login=await context.request.post(base+'/api/auth/login',{data:{username:process.env.ADMIN_USERNAME||'admin',password:process.env.ADMIN_PASSWORD||'admin123'}});
  assert.equal(login.status(),200);
  await page.goto(base+'/#wechat-service');
  await page.locator('#nav [data-workspace="wechat"]').click();
  await page.frameLocator('iframe[title="微信机器人管理后台"]').getByRole('heading',{name:'机器人管理测试页'}).waitFor();
  assert.equal(await page.locator('[data-robot-open]').getAttribute('href'),'http://robot-admin.test/');
  await page.getByText('微信问答资料在这里的知识库维护。',{exact:false}).waitFor();
  await page.locator('[data-robot-reload]').click();
  await page.frameLocator('iframe').getByRole('heading').waitFor();
  robotConfig={url:'http://robot-admin.test:8080/login?login_method=token#entry',followHost:true};
  const expected=new URL(robotConfig.url);expected.hostname=new URL(base).hostname;
  await context.route(expected.origin+'/**',route=>route.fulfill({contentType:'text/html; charset=utf-8',body:'<h1>机器人同站点测试页</h1>'}));
  await page.locator('[data-robot-reload]').click();
  await page.frameLocator('iframe').getByRole('heading',{name:'机器人同站点测试页'}).waitFor();
  assert.equal(await page.locator('iframe').getAttribute('src'),expected.href);
  assert.equal(await page.locator('[data-robot-open]').getAttribute('href'),expected.href);
  await page.screenshot({path:path.resolve('backups/robot-native-ui-qa/tianhe-shell.png'),fullPage:true});
  assert.deepEqual(errors,[]);
  console.log('PASS: explicit host following preserves protocol, port, path/query and standalone link; external URL remains unchanged by default. No WeChat sends.');
 } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});

