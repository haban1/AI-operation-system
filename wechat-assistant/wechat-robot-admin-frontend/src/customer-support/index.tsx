import { useRequest } from 'ahooks';
import { Alert, Spin } from 'antd';
import React from 'react';
import Broadcast from './Broadcast';
import Reception from './Reception';
import type { Snapshot } from './types';

interface IProps { robotId:number; mode:'reception'|'broadcast' }
const CustomerSupport=(props:IProps)=>{
 const {data,error,refresh}=useRequest(async()=>{
  const response=await window.wechatRobotClient.support.supportList({id:props.robotId});
  const snapshot=response.data.data as Snapshot;
  return {...snapshot,friends:snapshot.friends||[],receptions:snapshot.receptions||[],broadcasts:snapshot.broadcasts||[],categories:snapshot.categories||[]};
 },{refreshDeps:[props.robotId],pollingInterval:8000,pollingWhenHidden:false});
 if(error&&!data)return <Alert type="error" title={error.message} />;
 if(!data)return <Spin />;
 return <div style={{padding:16,maxWidth:1400,margin:'0 auto'}}>
  {error&&<Alert type="warning" title={`刷新失败：${error.message}`} />}
  {props.mode==='reception'?<Reception robotId={props.robotId} data={data} onRefresh={refresh} />:<Broadcast robotId={props.robotId} data={data} onRefresh={refresh} />}
 </div>;
};
export default React.memo(CustomerSupport);
