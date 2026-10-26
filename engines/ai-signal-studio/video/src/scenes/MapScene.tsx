import React from 'react';
import {interpolate,useCurrentFrame} from 'remotion';
import type {Scene} from '../content';
export const MapScene:React.FC<{scene:Scene}>=({scene})=>{
 const f=useCurrentFrame();const p=Math.min(1,Math.max(0,(f-32)/65));
 const nodes=[{x:300,y:105,w:260},{x:300,y:340,w:260},{x:50,y:605,w:310},{x:500,y:605,w:310}];
 return <div style={{marginTop:64}}><div style={{fontSize:84,fontWeight:800,lineHeight:1.22}}>{scene.title}</div><div style={{fontSize:44,color:'#67f3ef',marginTop:24}}>{scene.highlight}</div>
  <div style={{position:'relative',height:780,marginTop:22}}>
   <svg width="860" height="780" viewBox="0 0 860 780" style={{position:'absolute',inset:0}}>
    <defs><marker id="arrow" markerWidth="12" markerHeight="12" refX="7" refY="4" orient="auto"><path d="M0 0 L8 4 L0 8" fill="none" stroke="#67f3ef" strokeWidth="1.4"/></marker></defs>
    {['M430 210 L430 332','M430 445 L430 515 L205 515 L205 597','M430 445 L430 515 L655 515 L655 597'].map((d,i)=><path key={i} d={d} fill="none" stroke={i===2?'#a78bfa':'#67f3ef'} strokeWidth="3" pathLength="1" strokeDasharray="1" strokeDashoffset={1-p} opacity={.75} markerEnd={p===1?'url(#arrow)':undefined}/>)}
    {p===1&&<circle cx="430" cy={230+(f*1.7)%80} r="7" fill="#67f3ef"/>}
   </svg>
   {nodes.map((n,i)=><div key={i} style={{position:'absolute',left:n.x,top:n.y,width:n.w,height:105,borderRadius:20,border:`2px solid ${i===3?'#a78bfa77':'#67f3ef66'}`,background:'#0c1c24',display:'flex',alignItems:'center',justifyContent:'center',gap:18,boxShadow:i===1?'0 0 50px #67f3ef18':'none',fontSize:43,fontWeight:700,opacity:interpolate(f,[i*12,i*12+15],[0,1],{extrapolateLeft:'clamp',extrapolateRight:'clamp'}),scale:interpolate(f,[i*12,i*12+15],[.9,1],{extrapolateLeft:'clamp',extrapolateRight:'clamp'})}}>{scene.items[i]||['浏览器','接口服务','缓存','数据库'][i]}</div>)}
   <div style={{position:'absolute',top:465,left:30,color:'#8ca0a7',fontSize:26}}>请求与依赖关系</div>
  </div><div style={{fontSize:30,color:'#9ab1b7',lineHeight:1.5,marginTop:-10}}>{scene.body}</div>
 </div>;
};
