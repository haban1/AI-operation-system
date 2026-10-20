const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright-core');
const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const {execFileSync}=require('node:child_process');
const origin=new URL(process.env.ROBOT_ADMIN_URL||'http://10.70.72.78:8080').origin;
(async()=>{
 const browser=await chromium.launch({headless:true,...(process.env.BROWSER_EXECUTABLE?{executablePath:process.env.BROWSER_EXECUTABLE}:{})});
 try {
  if(process.argv.includes('--live')){
   const context=await browser.newContext({serviceWorkers:'block'});
   await context.addInitScript(()=>localStorage.setItem('robot-chat-room-closed',String(Date.now())));
   await context.route('**/*',route=>{
    const request=route.request(),url=new URL(request.url());
    if(url.origin!==origin)return route.abort();
    if(request.method()!=='GET'&&!(request.method()==='POST'&&url.pathname==='/api/v1/login'))return route.abort();
    return route.continue();
   });
   const page=await context.newPage();
   await page.goto(origin+'/login?login_method=token');
   await page.getByPlaceholder('请输入登录密钥').waitFor();
   assert.equal(await page.getByText('安全提示',{exact:true}).count(),0);
   const containers=JSON.parse(execFileSync('docker',['inspect','wechat-robot-admin-backend'],{encoding:'utf8'}));
   const entry=containers[0].Config.Env.find(v=>v.startsWith('LOGIN_TOKEN='));
   assert.ok(entry,'Login credential is not configured');
   await page.getByPlaceholder('请输入登录密钥').fill(entry.slice('LOGIN_TOKEN='.length));
   await page.getByRole('button',{name:/登\s*录/}).click();
   await page.getByRole('button',{name:/创建机器人/}).waitFor();
   await page.reload();
   await page.getByRole('button',{name:/创建机器人/}).waitFor();
   const response=await context.request.get(origin+'/api/v1/support?id=3');
   assert.equal((await response.json()).code,200);
   console.log('PASS: configured LAN HTTP login, management page, reload/session persistence and authorized support access. No WeChat sends.');
   await context.close();
   return;
  }
  const root=path.resolve('wechat-assistant/wechat-robot-admin-frontend/dist');
  const differentPort=new URL(origin);differentPort.port=differentPort.port==='8081'?'8082':'8081';
  const cases=[[origin,false],['http://localhost:8080',false],['http://127.0.0.1:8080',false],
   ['https://robot-public.test',false],['http://robot-public.test',true],[differentPort.origin,true]];
  for(const [base,warn] of cases){
   const context=await browser.newContext({serviceWorkers:'block'});
   await context.addInitScript(()=>localStorage.setItem('robot-chat-room-closed',String(Date.now())));
   let logins=0;
   await context.route('**/*',route=>{
    const req=route.request(),url=new URL(req.url());
    if(url.origin!==base)return route.abort();
    if(url.pathname.startsWith('/api/')){
     let data={};
     if(url.pathname==='/api/v1/login'){
      assert.deepEqual(req.postDataJSON(),{token:'mock-login-key'});logins++;data={success:true};
     }else if(req.method()!=='GET')throw Error('Unexpected mutation');
     else if(url.pathname==='/api/v1/user/self')data={display_name:'测试管理员',role:100};
     else if(url.pathname==='/api/v1/robot/list')data={items:[],total:0};
     return route.fulfill({contentType:'application/json',body:JSON.stringify({code:200,data})});
    }
    const filename=url.pathname==='/login'||url.pathname==='/'?'/index.html':decodeURIComponent(url.pathname);
    const target=path.resolve(root,'.'+filename);
    if(!target.startsWith(root+path.sep)||!fs.existsSync(target))return route.abort();
    const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml'};
    return route.fulfill({contentType:mime[path.extname(target)]||'application/octet-stream',body:fs.readFileSync(target)});
   });
   const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
   await page.goto(base+'/login?login_method=token');
   await page.getByPlaceholder('请输入登录密钥').waitFor();
   if(warn){await page.getByText('当前地址未配置为允许 HTTP 访问的后台地址，请使用 HTTPS。',{exact:true}).waitFor();assert.equal(logins,0);}
   else{
    await page.getByPlaceholder('请输入登录密钥').fill('mock-login-key');
    assert.equal(await page.getByText('安全提示',{exact:true}).count(),0);
    await page.getByRole('button',{name:/登\s*录/}).click();
    await page.getByRole('button',{name:/创建机器人/}).waitFor();
    assert.equal(logins,1);
   }
   assert.deepEqual(errors,[]);
   await context.close();
  }
  console.log('PASS: configured LAN origin, localhost, HTTPS login; other HTTP hosts and ports retain the warning. All login requests mocked.');
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});

