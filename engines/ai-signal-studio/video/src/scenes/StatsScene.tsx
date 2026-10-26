import React from 'react';
import {interpolate,useCurrentFrame} from 'remotion';
import type {Scene} from '../content';
export const StatsScene:React.FC<{scene:Scene}>=({scene})=>{
 const f=useCurrentFrame();const n=scene.metric;const raw=typeof n==='number';
 return <div style={{marginTop:80}}>
  <div style={{fontSize:84,fontWeight:800,lineHeight:1.2}}>{scene.title}</div>
  <div style={{fontSize:34,marginTop:72,color:'#8ca0a7'}}>GitHub Trending · 本周新增 Star</div>
  <div style={{fontSize:160,fontWeight:800,color:'#67f3ef',letterSpacing:-8,fontVariantNumeric:'tabular-nums',marginTop:14}}>{raw?Math.round(interpolate(f,[8,60],[0,n!],{extrapolateLeft:'clamp',extrapolateRight:'clamp'})).toLocaleString('en-US'):scene.highlight}</div>
  <div style={{height:20,borderRadius:20,marginTop:35,background:'#183535',overflow:'hidden'}}><div style={{width:`${interpolate(f,[8,65],[0,100],{extrapolateLeft:'clamp',extrapolateRight:'clamp'})}%`,height:'100%',background:'linear-gradient(90deg,#67f3ef,#a78bfa)'}}/></div>
  <div style={{fontSize:30,color:'#8ca0a7',marginTop:20}}>数值强调动画 · 非每日增长曲线</div>
  <div style={{fontSize:48,lineHeight:1.65,marginTop:76}}>{scene.body}</div>
  <div style={{marginTop:54,borderLeft:'4px solid #a78bfa',paddingLeft:28,fontSize:34,color:'#c5b8e5'}}>{scene.items?.join(' / ')}</div>
 </div>;
};
