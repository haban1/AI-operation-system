import { useMemoizedFn } from 'ahooks';
import { Alert, App, Button, Card, Checkbox, Col, Empty, Input, Row, Select, Space, Tag, Typography } from 'antd';
import React, { useEffect, useRef, useState } from 'react';
import type { Snapshot } from './types';
import { friendName, timestamp } from './types';

interface IProps { robotId:number; data:Snapshot; onRefresh:()=>void }
const requestID=()=>{
 if(typeof crypto.randomUUID==='function')return crypto.randomUUID();
 return Array.from(crypto.getRandomValues(new Uint8Array(16)),b=>b.toString(16).padStart(2,'0')).join('');
};
const labels:Record<string,string>={pending:'等待发送',running:'发送中',completed:'已完成',partial:'部分失败',failed:'发送失败',interrupted:'结果待核对'};
const Broadcast=(props:IProps)=>{
 const {message,modal}=App.useApp();
 const storageKey=`robot-broadcast-${props.robotId}`;
 const [pending,setPending]=useState(()=>{try{return localStorage.getItem(storageKey)||'';}catch{return '';}});
 const [recipients,setRecipients]=useState<string[]>([]);
 const [content,setContent]=useState('');
 const [image,setImage]=useState<File>();
 const [preview,setPreview]=useState('');
 const [confirmed,setConfirmed]=useState(false);
 const [busy,setBusy]=useState(false);
 const submitting=useRef(false);
 useEffect(()=>{if(!image){setPreview('');return;}const url=URL.createObjectURL(image);setPreview(url);return()=>URL.revokeObjectURL(url);},[image]);
 const send=useMemoizedFn(()=>{
  if(pending||submitting.current)return;
  if(!recipients.length||(!content.trim()&&!image)||!confirmed){message.warning('请选择好友、填写内容，并勾选发送确认。');return;}
  modal.confirm({title:`确认向 ${recipients.length} 位好友群发？`,content:'发送后无法撤回整个群发任务，请核对所选好友和内容。',onOk:async()=>{
   if(submitting.current)return;
   submitting.current=true;setBusy(true);
   const id=requestID();setPending(id);try{localStorage.setItem(storageKey,id);}catch{/* Storage may be disabled. */}
   try{await window.wechatRobotClient.support.broadcastsCreate({id:props.robotId},{client_request_id:id,recipients:JSON.stringify(recipients),confirm_send:'true',content:content.trim(),image});message.success('群发任务已提交');}
   catch(e){message.error(`${(e as Error).message}。请先核对群发记录，不要重复提交。`);}
   finally{setBusy(false);props.onRefresh();}
  }});
 });
 const next=useMemoizedFn(()=>modal.confirm({title:'已核对记录，开始另一条群发？',content:'结果未确认的任务，请先在微信中核对，避免重复发送。',onOk:()=>{try{localStorage.removeItem(storageKey);}catch{/* Storage may be disabled. */}setPending('');submitting.current=false;setConfirmed(false);}}));
 return <Space orientation="vertical" size="middle" style={{width:'100%'}}>
  {pending&&<Alert type="warning" showIcon title="本次提交已锁定，请先核对下方记录。刷新页面不会重复发送。" />}
  <Row gutter={[16,16]}>
   <Col xs={24} lg={12}><Card title="选择微信好友">
    <Select aria-label="群发好友" mode="multiple" style={{width:'100%'}} value={recipients} disabled={!!pending} showSearch={{optionFilterProp:"label"}} placeholder="搜索昵称或备注，选择好友" options={props.data.friends.map(f=>({value:f.wechat_id,label:friendName(f)}))} onChange={v=>{setRecipients(v);setConfirmed(false);}} />
    <Space style={{marginTop:12}}><Button disabled={!!pending} onClick={()=>{setRecipients(props.data.friends.map(f=>f.wechat_id));setConfirmed(false);}}>选择全部好友</Button><Button disabled={!!pending} onClick={()=>{setRecipients([]);setConfirmed(false);}}>清空选择</Button><Tag>已选 {recipients.length} 人</Tag></Space>
   </Card></Col>
   <Col xs={24} lg={12}><Card title="编辑群发内容"><Space orientation="vertical" style={{width:'100%'}}>
    <Input.TextArea aria-label="群发文字" rows={6} maxLength={2000} showCount value={content} disabled={!!pending} onChange={e=>{setContent(e.target.value);setConfirmed(false);}} placeholder="输入文字，也可以只发送图片" />
    <label>图片（最大 10 MB）<input aria-label="群发图片" type="file" accept="image/png,image/jpeg,image/gif,image/webp" disabled={!!pending} onChange={e=>{const file=e.target.files?.[0];if(file&&(file.size>10*1024*1024||!file.size)){message.error('请选择不超过 10 MB 的图片');e.target.value='';return;}setImage(file);setConfirmed(false);}} /></label>
    {image&&<Button disabled={!!pending} onClick={()=>{setImage(undefined);setConfirmed(false);}}>移除图片</Button>}
    <Card size="small" title="发送预览"><Typography.Paragraph style={{whiteSpace:'pre-wrap'}}>{content||'（仅图片）'}</Typography.Paragraph>{preview&&<img src={preview} alt="群发图片预览" style={{maxWidth:'100%',maxHeight:240}} />}</Card>
    <Checkbox checked={confirmed} disabled={!!pending} onChange={e=>setConfirmed(e.target.checked)}>我已核对好友和内容，确认发送</Checkbox>
    <Space><Button type="primary" loading={busy} disabled={!!pending} onClick={send}>确认群发</Button>{pending&&<Button disabled={busy} onClick={next}>开始另一条群发</Button>}</Space>
   </Space></Card></Col>
  </Row>
  <Card title="最近群发记录" extra={<Button onClick={props.onRefresh}>刷新记录</Button>}>
   {!props.data.broadcasts.length&&<Empty description="暂无群发记录" />}
   {props.data.broadcasts.map(job=><Card key={job.id} size="small" style={{marginBottom:12}} title={<Space><Tag>{labels[job.status]||job.status}</Tag><span>{timestamp(job.created_at)}</span></Space>}>
    <Typography.Paragraph style={{whiteSpace:'pre-wrap'}}>{job.content||'（图片消息）'}{job.has_image?' · 含图片':''}</Typography.Paragraph>
    <Typography.Paragraph>已选 {job.recipients.length} 人 · 成功 {job.success_count} 人 · 失败 {job.failed_count} 人</Typography.Paragraph>
    {job.status==='interrupted'&&<Alert type="warning" title="任务执行中断，部分发送结果可能未记录。请核对微信，不会自动重发。" />}
    {job.results?.some(r=>r.error)&&<details><summary>查看失败详情</summary>{job.results.filter(r=>r.error).map(r=><p key={r.peer}>{r.peer}：{r.error}</p>)}</details>}
    <Typography.Text type="secondary">任务 {job.id}{job.id===pending?' · 本次提交':''}</Typography.Text>
   </Card>)}
  </Card>
 </Space>;
};
export default React.memo(Broadcast);
