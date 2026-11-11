import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {chromium} from 'playwright-core';
import {startServer,stopChild,cleanupDir,openWorkspacePage} from './helpers/runtime.js';

const chrome=[process.env.CHROME_EXECUTABLE_PATH,'C:/Program Files/Google/Chrome/Application/chrome.exe','/usr/bin/chromium'].filter(Boolean).find(file=>fs.existsSync(file));
const comment=(id,key,title,publishedAt,extra={})=>({
  id,external_id:'comment-'+id,message_type:'COMMENT',platform_code:'douyin',platform_name:'抖音',account_id:2,account_name:'测试账号',
  content:'评论内容 '+id,user_name:'用户'+id,collected_at:'2026-10-21T03:38:05.949Z',status:'REPLIED',
  post:{key,id:key,title,publishedAt,matched:true},reply_status:{ai:{state:'REPLIED',replied:true},manual:{state:'NOT_REPLIED'}},...extra
});
function fixtures(){return [
  comment(300,'old','较早发布的帖子','发布于2026年09月15日 14:53'),
  comment(210,'new','最新发布的帖子','发布于2026年10月20日 10:24'),
  comment(209,'new','最新发布的帖子','发布于2026年10月20日 10:24'),
  comment(301,'unknown','日期未知的帖子','未提供'),
  {id:302,external_id:'private-302',message_type:'PRIVATE_MESSAGE',platform_code:'douyin',platform_name:'抖音',account_id:2,account_name:'测试账号',content:'这是一条私信',user_name:'私信用户',collected_at:'2026-10-21T03:38:00Z',status:'REPLIED',reply_status:{ai:{state:'REPLIED',replied:true},manual:{state:'NOT_REPLIED'}}}
]}
async function setup(t,messages=fixtures()){
  const runtime=await startServer();
  t.after(async()=>{await stopChild(runtime.child);cleanupDir(runtime.dir)});
  const browser=await chromium.launch({headless:true,executablePath:chrome});
  t.after(()=>browser.close());
  const page=await browser.newPage({viewport:{width:1440,height:1080},timezoneId:'Asia/Shanghai'});
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  const payload={messages,channelRuntimeStates:[]};
  await page.route('**/api/bootstrap',async route=>{
    const response=await route.fetch();const data=await response.json();
    data.accounts.push({...data.accounts.find(account=>account.id===2),id:202,display_name:'另一个测试账号'});
    await route.fulfill({response,body:JSON.stringify(data)});
  });
  await page.route('**/api/messages*',route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({ok:true,...payload})}));
  await page.route('**/app.js?*',async route=>{
    const response=await route.fetch();
    await route.fulfill({response,body:(await response.text())+`\nwindow.commentPostTest={setAccount:id=>{state.messageAccountId=id},snapshot:()=>({page:state.page,loading:pageRenderInFlightGeneration!==0}),refresh:refreshMessagesFromTimer,groups:groupCommentsByPost,parseDate:commentPostPublishedTimestamp};`});
  });
  await page.addInitScript(()=>{const interval=window.setInterval;window.setInterval=(fn,ms,...args)=>interval(fn,ms===1000?ms:600000,...args)});
  async function open(){
    await page.goto(runtime.base);await page.locator('.operations-dashboard').waitFor();
    await page.evaluate(()=>window.commentPostTest.setAccount(2));
    await openWorkspacePage(page,'messages');
    await page.waitForFunction(()=>window.commentPostTest.snapshot().page==='messages'&&!window.commentPostTest.snapshot().loading);
    await page.locator('.message-workbench').waitFor();
  }
  await open();
  t.after(()=>assert.deepEqual(errors,[]));
  return {page,payload,open};
}
const groups=page=>page.locator('details.comment-post-group');
const newPost=page=>groups(page).filter({has:page.locator('.comment-post-title',{hasText:'最新发布的帖子'})});
async function refresh(page){await page.evaluate(()=>window.commentPostTest.refresh())}

test('comment posts sort by publication, start collapsed, and clear their count on keyboard expansion',{skip:!chrome},async t=>{
  const {page}=await setup(t);
  assert.deepEqual(await page.locator('.comment-post-title').allTextContents(),['最新发布的帖子','较早发布的帖子','日期未知的帖子']);
  assert.equal(await groups(page).count(),3);
  assert.equal(await page.locator('details.comment-post-group[open]').count(),0);
  assert.equal(await page.locator('.comment-item:visible').count(),0);
  assert.equal(await page.locator('.post-summary:visible').count(),0);
  assert.deepEqual(await page.locator('.comment-unread-count b').allTextContents(),['2','1','1']);
  const latest=newPost(page);await latest.locator(':scope > summary').focus();await page.keyboard.press('Enter');
  await latest.locator('.comment-item').first().waitFor({state:'visible'});
  await page.waitForFunction(()=>!document.querySelector('.comment-post-group[open] .comment-unread-count'));
  assert.equal(await latest.locator('.comment-item:visible').count(),2);
  assert.equal(await groups(page).nth(1).locator('.comment-unread-count b').textContent(),'1');
  assert.match(await latest.locator('.comment-post-meta').innerText(),/2026\/10\/20/);
  assert.doesNotMatch(await page.locator('#content').textContent(),/Invalid Date/);
  const output=path.resolve('.tmp/comment-post-list-20261021');fs.mkdirSync(output,{recursive:true});
  await latest.locator(':scope > summary').click();
  await latest.locator('.comment-item').first().waitFor({state:'hidden'});
  await page.screenshot({path:path.join(output,'comments-collapsed.png'),fullPage:true});
  await latest.locator(':scope > summary').click();await latest.locator('.comment-item').first().waitFor({state:'visible'});
  await page.screenshot({path:path.join(output,'comments-expanded.png'),fullPage:true});
});

test('read comments stay read after reload and only newly collected comments count',{skip:!chrome},async t=>{
  const {page,payload,open}=await setup(t);
  await newPost(page).locator(':scope > summary').click();
  await page.waitForFunction(()=>!document.querySelector('.comment-post-group[open] .comment-unread-count'));
  await open();
  assert.equal(await newPost(page).getAttribute('open'),null);
  assert.equal(await newPost(page).locator('.comment-unread-count').count(),0);
  payload.messages.unshift(comment(401,'new','最新发布的帖子','发布于2026年10月20日 10:24'));
  await refresh(page);
  assert.equal(await newPost(page).locator('.comment-unread-count b').textContent(),'1');
  payload.messages.find(message=>message.id===210).status='MANUAL_REQUIRED';
  await refresh(page);
  assert.equal(await newPost(page).locator('.comment-unread-count b').textContent(),'1');
  await newPost(page).locator(':scope > summary').click();
  await page.waitForFunction(()=>!document.querySelector('.comment-post-group[open] .comment-unread-count'));
  await open();
  assert.equal(await newPost(page).locator('.comment-unread-count').count(),0);
});

test('automatic redraw retains expansion but never marks new comments read by itself',{skip:!chrome},async t=>{
  const {page,payload}=await setup(t);
  await newPost(page).locator(':scope > summary').click();
  await page.waitForFunction(()=>!document.querySelector('.comment-post-group[open] .comment-unread-count'));
  payload.messages.unshift(comment(401,'new','最新发布的帖子','发布于2026年10月20日 10:24'));
  await refresh(page);
  assert.notEqual(await newPost(page).getAttribute('open'),null);
  await page.waitForFunction(()=>document.querySelector('.comment-post-group[open] .comment-unread-count b')?.textContent==='1');
  assert.equal(await newPost(page).locator('.comment-item:visible').count(),3);
  // A second redraw exercises the initial toggle event emitted for restored <details open>.
  payload.messages.find(message=>message.id===300).status='MANUAL_REQUIRED';
  await refresh(page);
  assert.equal(await newPost(page).locator('.comment-unread-count b').textContent(),'1');
  await newPost(page).locator(':scope > summary').click();
  await newPost(page).locator('.comment-item').first().waitFor({state:'hidden'});
  await newPost(page).locator(':scope > summary').click();
  await page.waitForFunction(()=>!document.querySelector('.comment-post-group[open] .comment-unread-count'));
});

test('post metadata changes trigger timer sorting and private messages keep their card layout',{skip:!chrome},async t=>{
  const {page,payload}=await setup(t);
  payload.messages.find(message=>message.id===301).post.publishedAt='2026-10-21T10:00:00+08:00';
  await refresh(page);
  assert.equal(await page.locator('.comment-post-title').first().textContent(),'日期未知的帖子');
  await page.locator('#workspaceSubnav [data-workspace-item="private-messages"]').click();
  await page.locator('.private-message-list').waitFor();
  assert.equal(await groups(page).count(),0);
  assert.equal(await page.locator('.comment-unread-count').count(),0);
  assert.match(await page.locator('.private-message-list').innerText(),/这是一条私信/);
});

test('publication parser handles platform formats and read positions stay isolated between accounts',{skip:!chrome},async t=>{
  const {page,payload}=await setup(t);
  const parsed=await page.evaluate(()=>{
    const parse=window.commentPostTest.parseDate;
    return ['发布于2026年10月20日 10:24','2026/10/20 10:24','2026-10-20T02:24:00Z','1792463040','1792463040000','未提供','2026年02月31日 10:00','2026/10/20 25:99'].map(parse);
  });
  assert.ok(parsed.slice(0,5).every(timestamp=>timestamp===parsed[0]),JSON.stringify(parsed));
  assert.deepEqual(parsed.slice(5),[null,null,null]);
  await newPost(page).locator(':scope > summary').click();
  await page.waitForFunction(()=>!document.querySelector('.comment-post-group[open] .comment-unread-count'));
  // Same platform post ID under another account must have an independent unread position.
  payload.messages.unshift(comment(201,'new','另一个账号的同一帖子','2026/10/20 10:24',{account_id:202}));
  await page.locator('#messageAccount').selectOption('202');
  await page.locator('.comment-post-title',{hasText:'另一个账号的同一帖子'}).waitFor();
  assert.equal(await page.locator('.comment-unread-count b').textContent(),'1');
  const separated=await page.evaluate(messages=>window.commentPostTest.groups(messages).length,[
    comment(1,'same','相同标题','2026/10/20 10:24'),
    comment(2,'same','相同标题','2026/10/20 10:24',{account_id:99}),
    comment(3,'same','相同标题','2026/10/20 10:24',{platform_code:'bilibili'})
  ]);
  assert.equal(separated,3);
});
