import React from 'react';
import {interpolate,useCurrentFrame} from 'remotion';
import type {Scene} from '../content';
export const PipelineScene:React.FC<{scene:Scene}>=({scene})=>{
 const f=useCurrentFrame();
 return <div style={{marginTop:64}}>
  <div style={{fontSize:84,lineHeight:1.22,fontWeight:800}}>{scene.title}</div>
  <div style={{fontSize:40,color:'#67f3ef',marginTop:24}}>{scene.highlight}</div>
  <div style={{marginTop:48}}>{scene.items?.map((x,i)=><React.Fragment key={i}>
   {i>0&&<div style={{height:54,display:'flex',justifyContent:'center',alignItems:'center'}}><div style={{height:54,width:3,background:'#326060',position:'relative'}}><div style={{width:14,height:14,borderRadius:20,background:'#67f3ef',boxShadow:'0 0 16px #67f3ef',position:'absolute',left:-5,top:(f*1.8+i*14)%45}}/></div></div>}
   <div style={{display:'flex',alignItems:'center',gap:28,border:'1px solid #67f3ef55',background:'#0b151bf0',borderRadius:22,padding:'26px 32px',opacity:interpolate(f,[i*12,i*12+16],[0,1],{extrapolateLeft:'clamp',extrapolateRight:'clamp'})}}><div style={{fontSize:32,color:'#67f3ef',fontFamily:'monospace'}}>0{i+1}</div><div style={{fontSize:44,fontWeight:650}}>{x}</div></div>
  </React.Fragment>)}</div>
  <div style={{fontSize:32,color:'#9ab1b7',marginTop:36,lineHeight:1.5}}>{scene.body}</div>
 </div>;
};
