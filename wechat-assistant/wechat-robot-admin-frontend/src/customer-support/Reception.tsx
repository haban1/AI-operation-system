import { useMemoizedFn } from 'ahooks';
import { Alert, App, Button, Card, Empty, Form, Select, Space, Tag, Typography } from 'antd';
import React, { useState } from 'react';
import type { Snapshot } from './types';
import { friendName, timestamp } from './types';

interface IProps { robotId:number; data:Snapshot; onRefresh:()=>void }
const Reception=(props:IProps)=>{
 const {message,modal}=App.useApp();
 const [busy,setBusy]=useState(false);
 const [peer,setPeer]=useState<string>();
 const options=props.data.friends.map(f=>({value:f.wechat_id,label:friendName(f)}));
 const name=(id:string)=>friendName(props.data.friends.find(f=>f.wechat_id===id)||{wechat_id:id});
 const save=useMemoizedFn(async(values:{notifier?:string;knowledge_codes?:string[]})=>{
  setBusy(true);
  try {await window.wechatRobotClient.support.settingsCreate({id:props.robotId},{notifier:values.notifier||'',knowledge_codes:values.knowledge_codes||[]});message.success('设置已保存');props.onRefresh();}
  catch(e){message.error((e as Error).message);}finally{setBusy(false);}
 });
 const transition=useMemoizedFn((id:string,room:string,active:boolean)=>{
  modal.confirm({title:active?'确认由人工接待？':'确认恢复 AI 回复？',content:active?'该会话的 AI 自动回复将暂停，请在微信中接待。':'后续新消息恢复 AI 回复，接管前未完成的回答不会补发。',onOk:async()=>{
   await window.wechatRobotClient.support.receptionCreate({id:props.robotId},{peer:id,room,active,reason:active?'后台人工接管':''});
   message.success(active?'已进入人工接待':'已恢复 AI');props.onRefresh();
  }});
 });
 return <Space orientation="vertical" size="middle" style={{width:'100%'}}>
  <Alert type="info" showIcon title="人工接待期间 AI 暂停回复，请在微信客户端接待。客户请求人工，或客服在微信主动回复后，会进入此队列。" />
  <Card title="客服设置">
   <Form layout="vertical" initialValues={props.data.settings} onFinish={save}>
    <Form.Item label="接待通知人" name="notifier"><Select allowClear showSearch={{optionFilterProp:"label"}} options={options} placeholder="不发送通知" /></Form.Item>
    <Form.Item label="默认问答知识库" name="knowledge_codes" extra="私聊使用这里选择的原生知识库；群聊优先使用自己的绑定，未绑定时使用此设置。资料在「知识库」页管理。"><Select mode="multiple" options={props.data.categories.map(c=>({value:c.code,label:c.name}))} placeholder="请选择知识库" /></Form.Item>
    <Button type="primary" htmlType="submit" loading={busy}>保存设置</Button>
   </Form>
  </Card>
  <Card title={`人工接待队列（${props.data.receptions.length}）`} extra={<Button onClick={props.onRefresh}>刷新</Button>}>
   <Space wrap style={{marginBottom:16}}><Select aria-label="主动接管好友" style={{minWidth:230}} showSearch={{optionFilterProp:"label"}} options={options} value={peer} onChange={setPeer} placeholder="选择好友主动接管" /><Button disabled={!peer} onClick={()=>peer&&transition(peer,'',true)}>人工接管</Button></Space>
   {!props.data.receptions.length&&<Empty description="暂无待接待会话" />}
   {props.data.receptions.map(r=><Card key={r.key} size="small" style={{marginBottom:12}} title={<Space><Typography.Text>{name(r.peer)}</Typography.Text><Tag color="orange">人工接待中</Tag></Space>} extra={<Button onClick={()=>transition(r.peer,r.room,false)}>恢复 AI 回复</Button>}>
    <Typography.Paragraph type="secondary">{r.peer}{r.room?` · 群聊 ${r.room}`:''} · {timestamp(r.updated_at)}</Typography.Paragraph>
    <Typography.Paragraph>原因：{r.reason}</Typography.Paragraph><Typography.Paragraph style={{whiteSpace:'pre-wrap'}}>{r.last_message||'暂无新消息'}</Typography.Paragraph>
    {r.notification_error&&<Alert type="warning" title={r.notification_error} />}
   </Card>)}
  </Card>
 </Space>;
};
export default React.memo(Reception);
