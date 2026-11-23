import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
const section=(a,b)=>source.slice(source.indexOf(a),source.indexOf(b,source.indexOf(a)));
const context=vm.createContext({
 state:{taskStatus:'ALL'},
 esc:value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;'),
 cleanText:value=>String(value??''), platformName:value=>value,
 publishAccountLabel:code=>code,fmtTaskPublishTime:value=>value,fmt:value=>value
});
vm.runInContext(section('function taskFailureMessage(','async function openTaskResolution(')+section('function taskVisualState(','async function deleteTask('),context);
const target=(extra={})=>({id:11,account_id:2,platform_code:'douyin',platform_name:'抖音',status:'FAILED',publish_attempt_state:'UPLOAD_FAILED',result:{message:'网络中断'},...extra});
const task=(extra={})=>({id:1,title:'测试发布',body:'正文',created_at:'2026-11-17',status:'FAILED',targets:[target()],compliance:{overall:'WARNING'},...extra});

test('正常状态只使用三种文案，未确认状态不会显示成功',()=>{
 for(const [statuses,label] of [
  [['QUEUED','PENDING','RUNNING','EXECUTING','RETRYING'],'发布中'],
  [['SUBMITTED','REVIEWING','SYNCING','NEEDS_CONFIRMATION','UNKNOWN'],'审核中'],
  [['PUBLISHED','SUCCESS','RECOVERED_BY_RETRY'],'发布成功'],
  [['FAILED','PARTIAL_FAILED','REJECTED'],'发布失败']
 ])for(const status of statuses)assert.equal(context.taskVisualState(task({status,targets:[]})).label,label,status);
});
test('进行中详情无路径、技术字段或合规警告',()=>{
 const html=context.taskCard(task({status:'EXECUTING',targets:[target({status:'EXECUTING'})]}));
 assert.match(html,/发布中/);
 assert.doesNotMatch(html,/任务入列|投稿阶段|投稿锁|尝试次数|警告|WARNING|task-progress|去解决|网络中断/);
});
test('失败显示真实原因和单一处理入口，内容安全转义',()=>{
 const html=context.taskCard(task({targets:[target({result:{message:'<网络失败>'}})]}));
 assert.match(html,/发布失败/);assert.match(html,/&lt;网络失败&gt;/);
 assert.match(html,/data-resolve-task="1"/);
 assert.doesNotMatch(html,/data-retry-task|投稿阶段|WARNING/);
});
test('补发恢复隐藏旧失败和解决入口但不修改源对象',()=>{
 const original=task({retryRecovery:{recovered:true,retryTaskId:9}}),before=JSON.stringify(original);
 const html=context.taskCard(original);
 assert.match(html,/发布成功/);assert.doesNotMatch(html,/网络中断|发布失败|去解决|补发|原失败/);
 assert.equal(JSON.stringify(original),before);
 assert.equal(context.taskResolutionMarkup(original),'<p>当前无需处理。</p>');
});
test('安全验证和混合平台失败保留处理入口与各平台状态',()=>{
 const security=target({status:'NEEDS_CONFIRMATION',publish_attempt_state:'DRAFT_BLOCKED',result:{manualSecurityVerificationRequired:true,manualActionRequired:true}});
 assert.equal(context.taskVisualState(task({status:'NEEDS_CONFIRMATION',targets:[security]})).key,'FAILED');
 assert.match(context.taskCard(task({status:'NEEDS_CONFIRMATION',targets:[security]})),/安全验证/);
 const html=context.taskCard(task({status:'PARTIAL_FAILED',targets:[target({status:'PUBLISHED'}),target()]}));
 assert.match(html,/发布成功/);assert.match(html,/发布失败/);
});
test('解决窗口依据防重发规则，只给未提交失败重试',()=>{
 assert.match(context.taskResolutionMarkup(task()),/重新编辑并发布/);
 for(const extra of [{submit_lock:'LOCKED'},{submit_attempted_at:'2026-11-17'},{publish_attempt_state:'SUBMIT_ATTEMPTED_UNCONFIRMED'},{result:{manualActionRequired:true}}]){
  const html=context.taskResolutionMarkup(task({targets:[target(extra)]}));
  assert.doesNotMatch(html,/data-retry-task/);
 }
 const locked=context.taskResolutionMarkup(task({targets:[target({submit_lock:'LOCKED',publish_attempt_state:'SUBMIT_ATTEMPTED_UNCONFIRMED'})]}));
 assert.match(locked,/查询发布结果/);
});
test('托管B站草稿续接与安全验证仍可进入原操作',()=>{
 const draft=target({platform_code:'bilibili',publish_attempt_state:'DRAFT_BLOCKED',draft_fingerprint:{fingerprintHash:'fixture'},result:{draftResumeAvailable:true,draftAssessment:{managed:true,resumeAllowed:true}}});
 assert.match(context.taskResolutionMarkup(task({targets:[draft]})),/resume-bilibili-draft/);
 const security=target({status:'NEEDS_CONFIRMATION',publish_attempt_state:'DRAFT_BLOCKED',result:{manualActionRequired:true,manualSecurityVerificationRequired:true}});
 const html=context.taskResolutionMarkup(task({status:'NEEDS_CONFIRMATION',targets:[security]}));
 assert.match(html,/open-manual-publish/);assert.match(html,/confirm-manual-published/);assert.doesNotMatch(html,/data-retry-task/);
});
