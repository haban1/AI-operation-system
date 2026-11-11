import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {chromium} from 'playwright-core';
import {startServer,stopChild,cleanupDir,openWorkspacePage} from './helpers/runtime.js';
const chrome=[process.env.CHROME_EXECUTABLE_PATH,'C:/Program Files/Google/Chrome/Application/chrome.exe','/usr/bin/chromium'].filter(Boolean).find(p=>fs.existsSync(p));
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve}};
const json=(route,data,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify({ok:status<400,...data})});
async function setup(t){
 const runtime=await startServer();t.after(async()=>{await stopChild(runtime.child);cleanupDir(runtime.dir)});
 const browser=await chromium.launch({headless:true,executablePath:chrome});t.after(()=>browser.close());const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/app.js?*',async route=>{const response=await route.fetch();return route.fulfill({response,body:(await response.text())+`\nwindow.navTest={snapshot:()=>({page:state.page,loading:pageRenderInFlightGeneration!==0}),tasks:refreshTasksFromTimer,messages:refreshMessagesFromTimer};`})});
 await page.addInitScript(()=>{const interval=window.setInterval;window.setInterval=(fn,ms,...args)=>interval(fn,ms===1000?ms:600000,...args)});
 await page.goto(runtime.base);await page.locator('.operations-dashboard').waitFor();return {page,errors};
}
async function nav(page,name){await openWorkspacePage(page,name);await page.waitForFunction(name=>window.navTest.snapshot().page===name&&!window.navTest.snapshot().loading,name)}

test('page data loads in parallel with bootstrap, without duplicate timer reads', {skip:!chrome},async t=>{
 const {page,errors}=await setup(t);const entered=deferred(),release=deferred();t.after(()=>release.resolve());const readEntered=deferred();let reads=0;
 await page.route('**/api/bootstrap',async r=>{entered.resolve();await release.promise;await r.continue()});await page.route('**/api/tasks',r=>{reads++;readEntered.resolve();return json(r,{tasks:[]})});
 await openWorkspacePage(page,'tasks');await entered.promise;await readEntered.promise;
 assert.equal(await page.locator('#content').getAttribute('aria-busy'),'true');assert.match(await page.locator('#content').innerText(),/正在加载/);
 await page.evaluate(()=>window.navTest.tasks());assert.equal(reads,1);release.resolve();await page.waitForFunction(()=>!window.navTest.snapshot().loading);assert.equal(await page.locator('.task-center-panel').count(),1);assert.deepEqual(errors,[]);
});
for(const from of ['tasks','messages'])test(`late ${from} timer response cannot replace another page`,{skip:!chrome},async t=>{
 const {page,errors}=await setup(t);await nav(page,from);const entered=deferred(),release=deferred();t.after(()=>release.resolve());
 await page.route(`**/api/${from}*`,async r=>{entered.resolve();await release.promise;await json(r,from==='tasks'?{tasks:[]}:{messages:[],latest_marker:'late'})});
 await page.evaluate(from=>{window.pendingTimer=window.navTest[from]()},from);await entered.promise;await nav(page,'platforms');const before=await page.locator('#content').innerHTML();release.resolve();await page.evaluate(()=>window.pendingTimer);
 assert.equal(await page.locator('#content').innerHTML(),before);assert.deepEqual(errors,[]);
});
test('unchanged task refresh does not replace the current DOM', {skip:!chrome},async t=>{
 const {page,errors}=await setup(t);await nav(page,'tasks');await page.evaluate(()=>{window.oldTaskPanel=document.querySelector('.task-center-panel')});await page.evaluate(()=>window.navTest.tasks());assert.equal(await page.evaluate(()=>window.oldTaskPanel===document.querySelector('.task-center-panel')),true);assert.deepEqual(errors,[]);
});
test('knowledge lists overlap status; leaving a delayed read never repaints the new page', {skip:!chrome},async t=>{
 const {page,errors}=await setup(t);const entered=deferred(),release=deferred();t.after(()=>release.resolve());const reads=new Set();
 await page.route('**/api/rag/**',async r=>{const p=new URL(r.request().url()).pathname;reads.add(p);if(p==='/api/rag/status'){entered.resolve();await release.promise;return json(r,{rag:{enabled:true,configured:true}})}return json(r,p.endsWith('documents')?{documents:[]}:{releases:[],active:null})});
 await page.route('**/api/material-knowledge-drafts?*',r=>json(r,{drafts:[]}));
 await openWorkspacePage(page,'knowledge');await entered.promise;await page.waitForTimeout(100);assert.ok(reads.has('/api/rag/documents'));assert.ok(reads.has('/api/rag/releases'));await nav(page,'platforms');const before=await page.locator('#content').innerHTML();release.resolve();await page.waitForTimeout(200);assert.equal(await page.locator('#content').innerHTML(),before);assert.deepEqual(errors,[]);
});
test('disabled knowledge handles failed speculative reads without unhandled errors', {skip:!chrome},async t=>{
 const {page,errors}=await setup(t);await page.route('**/api/rag/**',r=>new URL(r.request().url()).pathname.endsWith('/status')?json(r,{rag:{enabled:false,configured:false}}):json(r,{message:'disabled'},503));await nav(page,'knowledge');assert.match(await page.locator('#content').innerText(),/尚未启用/);await page.waitForTimeout(100);assert.deepEqual(errors,[]);
});
test('failed data read shows a recoverable error and clears loading state', {skip:!chrome},async t=>{
 const {page,errors}=await setup(t);await page.route('**/api/tasks',r=>json(r,{message:'test read failed'},503));await nav(page,'tasks');assert.match(await page.locator('#content').innerText(),/页面加载失败/);assert.equal(await page.locator('#content').getAttribute('aria-busy'),null);await nav(page,'platforms');assert.doesNotMatch(await page.locator('#content').innerText(),/页面加载失败/);assert.deepEqual(errors,[]);
});
test('handoff rules remain available independently of knowledge service', {skip:!chrome},async t=>{
 const {page,errors}=await setup(t);let ragReads=0;
 await page.route('**/api/rag/**',r=>{ragReads++;return json(r,{message:'knowledge service unavailable'},503)});
 await page.evaluate(()=>{location.hash='#handoff-rules'});
 await page.locator('.handoff-phrase-empty').waitFor();
 await page.waitForFunction(()=>!window.navTest.snapshot().loading);
 assert.equal(ragReads,0);assert.doesNotMatch(await page.locator('#content').innerText(),/页面加载失败/);assert.deepEqual(errors,[]);
});
