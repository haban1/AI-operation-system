import React from 'react';
import {interpolate,useCurrentFrame} from 'remotion';
import type {Scene} from '../content';
export const CardsScene:React.FC<{scene:Scene}>=({scene})=>{
 const f=useCurrentFrame();const colors=['#67f3ef','#a78bfa','#67f3ef','#a78bfa'];
 return <div style={{marginTop:64}}>
  <div style={{fontSize:84,fontWeight:800,lineHeight:1.22}}>{scene.title}</div>
  <div style={{fontSize:44,color:'#67f3ef',lineHeight:1.45,marginTop:25}}>{scene.highlight}</div>
  <div style={{marginTop:60,display:'flex',flexDirection:'column',gap:26}}>{scene.items?.map((x,i)=><div key={i} style={{display:'flex',alignItems:'center',gap:26,padding:'34px 30px',borderRadius:22,background:'#0b151be8',border:`1px solid ${colors[i]}44`,opacity:interpolate(f,[i*12,i*12+18],[0,1],{extrapolateLeft:'clamp',extrapolateRight:'clamp'}),translate:`${interpolate(f,[i*12,i*12+18],[30,0],{extrapolateLeft:'clamp',extrapolateRight:'clamp'})}px 0`}}><span style={{color:colors[i],fontSize:32,fontFamily:'monospace'}}>{scene.type==='compare'?'↳':`0${i+1}`}</span><span style={{fontSize:45,lineHeight:1.35,fontWeight:650}}>{x}</span></div>)}</div>
  <div style={{fontSize:38,color:'#a7bec4',lineHeight:1.6,marginTop:48}}>{scene.body}</div>
 </div>;
};
