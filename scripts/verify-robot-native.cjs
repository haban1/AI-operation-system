// All browser requests are fulfilled locally, including all mutation endpoints.
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright-core');
const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
(async()=>{
 const root=path.resolve('wechat-assistant/wechat-robot-admin-frontend/dist');
 const browser=await chromium.launch({headless:true,...(process.env.BROWSER_EXECUTABLE?{executablePath:process.env.BROWSER_EXECUTABLE}:{})});
 let diagnosticPage;
 try{
  const context=await browser.newContext({viewport:{width:1440,height:1000},serviceWorkers:'block'});
  await context.addInitScript(()=>localStorage.setItem('robot-chat-room-closed',String(Date.now())));
  const page=await context.newPage();diagnosticPage=page;const errors=[];page.on('pageerror',e=>errors.push(e.message));
  const robot={id:3,robot_code:'qa-only',robot_name:'测试机器人',nickname:'测试机器人',status:'online',device_type:'iPad',last_login_at:1700000000};
  let sends=0,transitions=0,settings=0;
  const state={settings:{notifier:'bob',knowledge_codes:['business']},friends:[{wechat_id:'alice',nickname:'测试客户'},{wechat_id:'bob',nickname:'测试接待人'}],receptions:[{key:':alice',peer:'alice',room:'',reason:'客户请求人工接待',last_message:'请帮忙确认 <img src=x onerror=alert(1)>',started_at:1700000000,updated_at:1700000000}],broadcasts:[],categories:[{code:'business',name:'业务知识库'}]};
  await context.route('**/*',async route=>{
   const req=route.request(),url=new URL(req.url());
   if(url.hostname!=='robot-ui.test')return route.abort();
   if(url.pathname.startsWith('/api/')){
    let data={};
    if(url.pathname==='/api/v1/user/self')data={display_name:'测试管理员',wechat_id:'test',role:'root'};
    else if(url.pathname==='/api/v1/robot/list')data={items:[robot],total:1};
    else if(url.pathname==='/api/v1/robot/view')data=robot;
    else if(url.pathname==='/api/v1/support')data=state;
    else if(url.pathname==='/api/v1/support/settings'){settings++;data={};}
    else if(url.pathname==='/api/v1/support/reception'){transitions++;state.receptions=[];}
    else if(url.pathname==='/api/v1/support/broadcasts'){
     sends++;assert.match(req.postData(),/测试群发内容/);
     const id=req.postData().match(/name="client_request_id"\r\n\r\n([^\r\n]+)/)?.[1];assert.match(id,/^[\da-f-]{32,36}$/i);
     data={id,content:'测试群发内容',status:'completed',has_image:true,recipients:['alice','bob'],success_count:2,failed_count:0,created_at:1700000000,results:[]};state.broadcasts=[data];
    }else if(req.method()!=='GET')throw Error('Unexpected mutation: '+url.pathname);
    return route.fulfill({contentType:'application/json',body:JSON.stringify({code:200,data})});
   }
   const target=path.resolve(root,'.'+(url.pathname==='/'?'/index.html':decodeURIComponent(url.pathname)));
   if(!target.startsWith(root+path.sep)||!fs.existsSync(target))return route.abort();
   const types={'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png'};
   return route.fulfill({contentType:types[path.extname(target)]||'application/octet-stream',body:fs.readFileSync(target)});
  });
  await page.goto('http://robot-ui.test');
  assert.equal(await page.evaluate(()=>isSecureContext),false);
  if(await page.locator('.ant-notification-notice-close').count())await page.locator('.ant-notification-notice-close').click();await page.getByRole('button',{name:'管理机器人'}).click();
  await page.getByRole('tab',{name:/人工接待/}).click();
  await page.getByText('客户请求人工接待',{exact:false}).waitFor();
  await page.getByRole('button',{name:'保存设置',exact:true}).click();
  await page.getByText('设置已保存',{exact:true}).waitFor();assert.equal(settings,1);
  await page.getByRole('button',{name:'恢复 AI 回复',exact:true}).click();
  await page.getByRole('button',{name:'确 定',exact:true}).click();
  await page.getByText('暂无待接待会话',{exact:true}).waitFor();assert.equal(transitions,1);await page.getByRole('dialog',{name:'确认恢复 AI 回复？'}).waitFor({state:'hidden'});
  const out=path.resolve('backups/robot-native-ui-qa');fs.mkdirSync(out,{recursive:true});
  await page.screenshot({path:path.join(out,'reception.png'),fullPage:true});
  await page.getByRole('tab',{name:/好友群发/}).click();
  await page.getByRole('button',{name:'选择全部好友'}).click();
  await page.getByLabel('群发文字',{exact:true}).fill('测试群发内容');
  await page.getByLabel('群发图片',{exact:true}).setInputFiles({name:'test.png',mimeType:'image/png',buffer:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1ioAAAAASUVORK5CYII=','base64')});
  await page.getByRole('checkbox',{name:'我已核对好友和内容，确认发送'}).check();
  await page.getByRole('button',{name:'确认群发',exact:true}).click();
  await page.getByRole('button',{name:'取 消',exact:true}).click();assert.equal(sends,0);
  await page.getByRole('button',{name:'确认群发',exact:true}).click();
  await page.getByRole('button',{name:'确 定',exact:true}).click();
  await page.getByText('群发任务已提交',{exact:true}).waitFor();assert.equal(sends,1);
  assert.equal(await page.getByRole('button',{name:'确认群发',exact:true}).isDisabled(),true);
  await page.screenshot({path:path.join(out,'broadcast.png'),fullPage:true});
  await page.reload();if(await page.locator('.ant-notification-notice-close').count())await page.locator('.ant-notification-notice-close').click();await page.getByRole('button',{name:'管理机器人'}).click();await page.getByRole('tab',{name:/好友群发/}).click();
  assert.equal(await page.getByRole('button',{name:'确认群发',exact:true}).isDisabled(),true);assert.equal(sends,1);
  await page.setViewportSize({width:720,height:1000});await page.getByRole('button',{name:'确认群发',exact:true}).scrollIntoViewIfNeeded();await page.screenshot({path:path.join(out,'broadcast-narrow-verified.png'),fullPage:true});
  assert.deepEqual(errors,[]);
  console.log('PASS: native 8080 tabs, settings, reception, confirmation/cancel, text+image submit, HTTP request IDs, duplicate and reload protection. Real sends: 0.');
 }catch(error){if(diagnosticPage)console.error((await diagnosticPage.locator('body').innerText()).slice(-6000));throw error;}finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
