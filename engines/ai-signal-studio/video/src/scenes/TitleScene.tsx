import React from 'react';
import {interpolate,useCurrentFrame,spring} from 'remotion';
import type {Scene} from '../content';
export const TitleScene:React.FC<{scene:Scene}>=({scene})=>{
 const f=useCurrentFrame();const closing=scene.type==='hook';
 return <div style={{marginTop:100}}>
  <div style={{fontSize:34,color:'#8ca0a7',letterSpacing:5}}>{closing?'NEXT / 下一步':'AI TOOL / 本周发现'}</div>
  <div style={{fontSize:112,fontWeight:850,lineHeight:1.2,marginTop:38,letterSpacing:-4,translate:`0 ${interpolate(f,[0,24],[40,0],{extrapolateRight:'clamp'})}px`}}>{scene.title}</div>
  <div style={{fontSize:104,color:'#67f3ef',fontWeight:850,lineHeight:1.25,marginTop:18}}>{scene.highlight}</div>
  <div style={{marginTop:75,padding:38,border:'1px solid #67f3ef55',borderRadius:28,background:'#0b151bcc',scale:spring({frame:Math.max(0,f-15),fps:30,config:{damping:18}})}}>
   <div style={{fontSize:52,fontWeight:750}}>{scene.items?.[0] || 'Archify'}</div>
   <div style={{fontSize:38,lineHeight:1.65,color:'#aac0c6',marginTop:24}}>{scene.body}</div>
   <div style={{display:'flex',gap:16,marginTop:36,flexWrap:'wrap'}}>{scene.items?.slice(1).map(x=><div key={x} style={{fontSize:28,padding:'10px 20px',borderRadius:50,background:'#67f3ef16',color:'#67f3ef'}}>{x}</div>)}</div>
  </div>
 </div>;
};
