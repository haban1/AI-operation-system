// Real embedded login regression. Only login POSTs and read-only GETs are allowed.
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright-core');
const {execFileSync}=require('node:child_process');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

(async()=>{
 const browser=await chromium.launch({headless:true,...(process.env.BROWSER_EXECUTABLE?{executablePath:process.env.BROWSER_EXECUTABLE}:{})});
 try {
  const robotOrigin=new URL(process.env.ROBOT_ADMIN_URL||'http://10.70.72.78:8080');
  const lanBase=new URL(robotOrigin);lanBase.port='3100';
  const bases=process.env.WEB_BASE_URL?[process.env.WEB_BASE_URL]:['http://127.0.0.1:3100','http://localhost:3100',lanBase.origin];
  const containers=JSON.parse(execFileSync('docker',['inspect','wechat-robot-admin-backend'],{encoding:'utf8'}));
  const entry=containers[0].Config.Env.find(v=>v.startsWith('LOGIN_TOKEN='));
  assert.ok(entry,'Robot login credential is not configured');
  for(const base of bases){
   const expectedRobot=new URL(robotOrigin);expectedRobot.hostname=new URL(base).hostname;
   const context=await browser.newContext({viewport:{width:1440,height:1000},serviceWorkers:'block'});
   try {
    const blockedMutations=[];
    await context.addInitScript(()=>localStorage.setItem('robot-chat-room-closed',String(Date.now())));
    await context.route('**/*',route=>{
     const request=route.request(),url=new URL(request.url());
     if(![new URL(base).origin,expectedRobot.origin,robotOrigin.origin].includes(url.origin))return route.abort();
     const login=request.method()==='POST'&&(
      (url.origin===new URL(base).origin&&url.pathname==='/api/auth/login')||
      (url.origin===expectedRobot.origin&&url.pathname==='/api/v1/login'));
     if(request.method()!=='GET'&&!login){blockedMutations.push(request.method()+' '+url.pathname);return route.abort();}
     return route.continue();
    });
    const login=await context.request.post(base+'/api/auth/login',{data:{username:process.env.ADMIN_USERNAME||'admin',password:process.env.ADMIN_PASSWORD||'admin123'}});
    assert.equal(login.status(),200,'Tianhe login failed');
    const page=await context.newPage();const errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    await page.goto(base+'/#wechat-service');
    await page.locator('#nav [data-workspace="wechat"]').click();
    const selector='iframe[title="微信机器人管理后台"]';
    const frame=page.frameLocator(selector);
    await frame.getByPlaceholder('请输入登录密钥').waitFor();
    assert.equal(new URL(await page.locator(selector).getAttribute('src')).origin,expectedRobot.origin,'Embedded robot must use the Tianhe hostname');
    assert.equal(new URL(await page.locator('[data-robot-open]').getAttribute('href')).origin,expectedRobot.origin);
    assert.equal(await frame.getByText('安全提示',{exact:true}).count(),0);
    const loginResponse=page.waitForResponse(r=>r.url()===expectedRobot.origin+'/api/v1/login'&&r.request().method()==='POST');
    await frame.getByPlaceholder('请输入登录密钥').fill(entry.slice('LOGIN_TOKEN='.length));
    await frame.getByRole('button',{name:/登\s*录/}).click();
    assert.equal((await (await loginResponse).json()).code,200,'Robot login failed');
    const management=()=>frame.getByRole('button',{name:/创建机器人/}).waitFor();
    await management();
    const checkSession=async()=>{
     const robotFrame=await (await page.locator(selector).elementHandle()).contentFrame();
     const code=await robotFrame.evaluate(async()=>{
      const result=await fetch('/api/v1/user/self',{credentials:'same-origin'});
      return (await result.json()).code;
     });
     assert.equal(code,200,'Embedded session was not retained');
    };
    await checkSession();
    await page.locator('[data-robot-reload]').click();await management();await checkSession();
    await page.reload();await management();await checkSession();
    await page.locator('#nav [data-workspace="overview"]').click();
    assert.equal(await page.locator(selector).count(),0);
    await page.locator('#nav [data-workspace="wechat"]').click();await management();await checkSession();
    const popup=await context.newPage();await popup.goto(expectedRobot.origin);
    await popup.getByRole('button',{name:/创建机器人/}).waitFor();await popup.close();
    assert.deepEqual(errors,[]);assert.deepEqual(blockedMutations,[]);
    const screenshotDir=path.resolve('backups/robot-native-ui-qa');fs.mkdirSync(screenshotDir,{recursive:true});
    await page.screenshot({path:path.join(screenshotDir,'embedded-login-'+new URL(base).hostname+'.png'),fullPage:true});
    console.log('PASS: '+base+' embedded login, iframe/page reload, workspace return and standalone session. No WeChat sends.');
   } finally {await context.close();}
  }
 } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
