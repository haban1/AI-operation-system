import test from 'node:test';
import assert from 'node:assert/strict';
import { issueAccountPresentation } from '../public/issue-account-identity.js';

const issue = { source:'LOGIN_MONITOR',category:'ACCOUNT_LOGIN',related_type:'ACCOUNT',related_id:'3',title:'视频号登录状态已过期',detail:'示例工作室-视频号连续 3 次检测到明确退出证据，请人工处理',status:'OPEN' };
const account = { id:3,platform_code:'wechat_channels',platform_name:'视频号',login_status:'READY',platform_user_id:' real-id ',display_name:'已换手工标签',platform_user_name:'旧昵称' };

test('账号真实ID置于平台前，历史标签变更仍能替换且原记录不变',()=>{
  const before=JSON.stringify(issue);
  assert.deepEqual(issueAccountPresentation(issue,[account]),{title:'real-id · 视频号登录状态已过期',detail:'real-id · 视频号连续 3 次检测到明确退出证据，请人工处理'});
  assert.equal(JSON.stringify(issue),before);
});
for(const patch of [{platform_user_id:''},{platform_user_id:' '},{login_status:'EXPIRED'},{login_status:'UNKNOWN'},{login_status:'DISABLED'}])test(`缺失或失效身份只显示平台 ${JSON.stringify(patch)}`,()=>{
  const display=issueAccountPresentation(issue,[{...account,...patch}]);
  assert.deepEqual(display,{title:issue.title,detail:'视频号连续 3 次检测到明确退出证据，请人工处理'});
});
test('缺失关联账号不借用同平台其他账号ID，已解决记录同样清理名称',()=>{
  const display=issueAccountPresentation({...issue,status:'RESOLVED'},[{...account,id:8}]);
  assert.equal(display.title,issue.title);
  assert.equal(display.detail,'视频号连续 3 次检测到明确退出证据，请人工处理');
});
test('仅格式化登录监测模板，不修改其他告警或任意用户内容',()=>{
  for(const patch of [{source:'RPA'},{category:'REPLY'},{related_type:'MESSAGE'},{detail:'用户询问示例工作室地址，请保留原始证据'}]){
    const value={...issue,...patch};assert.equal(issueAccountPresentation(value,[account]).detail,value.detail);
  }
});
test('ID保留为纯文本，模板原因及次数完整保留',()=>{
  const result=issueAccountPresentation({...issue,detail:'更早标签连续 12 次检测到明确退出证据，请人工处理'},[{...account,platform_user_id:'<id&"value>'}]);
  assert.equal(result.detail,'<id&"value> · 视频号连续 12 次检测到明确退出证据，请人工处理');
});
