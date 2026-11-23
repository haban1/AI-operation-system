import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source=fs.readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
const section=(a,b)=>source.slice(source.indexOf(a),source.indexOf(b,source.indexOf(a)));
const task=(id=8,extra={})=>({id,title:'社区活动',body:'第一段文案\n第二段文案',created_at:`2026-11-${id+1}`,status:'EXECUTING',material_path:'fixture.png',material_meta:{meta:{type:'image'}},targets:[],...extra});
function fixture(){
  const host={dataset:{coverTask:'8'},innerHTML:'',querySelector:()=>null};
  const calls=[];
  const context=vm.createContext({state:{taskStatus:'CURRENT',currentPublishTaskId:null,currentTaskPreview:null},
    esc:value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;'),
    cleanText:value=>String(value??''),platformName:value=>value,publishAccountLabel:code=>code,
    platformLogo:()=>'',fmtTaskPublishTime:value=>value,fmt:value=>value,
    $:()=>host,agentResourceUrl:value=>value?'/api/local-agent'+value:null,
    agent:async(path,options)=>{calls.push({path,body:JSON.parse(options.body)});return {previewUrl:'/material-preview/fixture',materialMeta:{type:'image'}}}
  });
  vm.runInContext(section('function taskFailureMessage(','async function openTaskResolution(')+section('function taskVisualState(','async function deleteTask('),context);
  return {context,calls,host};
}

test('当前发布优先本次提交的ID，默认最新任务，不误选其他任务',()=>{
  const {context:c}=fixture(),tasks=[task(4),task(8),task(6)];
  assert.equal(c.currentPublishTask(tasks).id,8);
  c.state.currentPublishTaskId=4;assert.equal(c.currentPublishTask(tasks).id,4);
  c.state.currentPublishTaskId=99;assert.equal(c.currentPublishTask(tasks),null);
  assert.equal(c.currentPublishTask([]),null);
  const filters=c.taskStatusFilters(c.taskStatusCounts(tasks));
  assert.ok(filters.indexOf('data-task-status="CURRENT"')<filters.indexOf('data-task-status="ALL"'));
});

test('当前任务完整展示标题正文和真实封面，失败仍可解决且无技术路径',()=>{
  const {context:c}=fixture();
  c.state.currentTaskPreview={taskId:8,materialPath:'fixture.png',status:'READY',url:'/fixture.png',type:'image'};
  const current=task(8,{title:'<活动>',body:'第一段\n第二段',status:'FAILED',targets:[{id:1,platform_code:'douyin',status:'FAILED',result:{message:'网络中断'}}]});
  const html=c.currentPublishTaskMarkup(current);
  assert.match(html,/&lt;活动&gt;/);assert.match(html,/第一段\n第二段/);assert.match(html,/<img src="\/fixture.png"/);
  assert.match(html,/网络中断/);assert.match(html,/data-resolve-task="8"/);
  assert.doesNotMatch(html,/投稿阶段|投稿锁|task-progress|警告/);
});

test('封面使用已有素材信息接口，刷新同一任务不重复读取',async()=>{
  const {context:c,calls,host}=fixture();
  await c.loadCurrentTaskCover(task());await c.loadCurrentTaskCover(task());
  assert.equal(calls.length,1);assert.deepEqual(calls[0],{path:'/material-info',body:{materialPath:'fixture.png'}});
  assert.match(host.innerHTML,/material-preview\/fixture/);
  c.state.currentTaskPreview.type='video';assert.match(c.currentTaskCoverMarkup(task()),/<video[^>]+#t=0.1/);
});

test('素材缺失只影响封面，任务正文与状态保持可见',async()=>{
  const {context:c,host}=fixture();c.agent=async()=>{throw new Error('素材已移走')};
  await c.loadCurrentTaskCover(task());
  assert.match(host.innerHTML,/封面暂不可用/);
  const html=c.currentPublishTaskMarkup(task());
  assert.match(html,/社区活动/);assert.match(html,/第二段文案/);assert.match(html,/发布中/);
  assert.doesNotMatch(html,/<img|<video/);
  assert.match(c.currentPublishTaskMarkup(null),/发布内容/);
});

test('切换任务后迟到的封面响应不会覆盖当前任务',async()=>{
  const {context:c,host}=fixture();let finish;
  c.agent=()=>new Promise(resolve=>{finish=resolve});
  const pending=c.loadCurrentTaskCover(task());
  c.state.currentTaskPreview={taskId:9,materialPath:'new.png',status:'READY',url:'/new.png'};
  finish({previewUrl:'/old.png',materialMeta:{type:'image'}});await pending;
  assert.equal(c.state.currentTaskPreview.url,'/new.png');assert.equal(host.innerHTML,'');
});
