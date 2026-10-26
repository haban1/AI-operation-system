import React from 'react';
import {AbsoluteFill,Img,staticFile,interpolate,useCurrentFrame} from 'remotion';
import {CaptionLine,Footer,Flow,clamp,enter,font,type ShotProps} from './shared';

const blue='#315fdf', paper='#f4f1e9', ink='#1c2a3f';
const Diagram:React.FC=()=>{
 const f=useCurrentFrame();const points=[[440,110],[220,330],[660,330],[440,560]];
 return <svg viewBox="0 0 880 700" width="100%" height="100%"><defs><marker id="head" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto"><path d="M0 0 L7 3 L0 6" fill={blue}/></marker></defs>{[[0,1],[0,2],[1,3],[2,3]].map(([a,b],i)=><path key={i} d={`M${points[a][0]} ${points[a][1]+45} L${points[b][0]} ${points[b][1]-45}`} fill="none" stroke={blue} strokeWidth="4" markerEnd="url(#head)" strokeDasharray="12 7" strokeDashoffset={-f*1.2}/>)}{points.map(([x,y],i)=><g key={i} style={{opacity:enter(f,i*8)}}><rect x={x-130} y={y-46} width="260" height="92" rx="13" fill={i===0?blue:'#fff'} stroke={blue} strokeWidth="2"/><text x={x} y={y+14} textAnchor="middle" fontSize="37" fontWeight="650" fill={i===0?'#fff':ink}>{['需求输入','检索资料','调用工具','汇总结果'][i]}</text></g>)}</svg>;
};

export const WalkthroughScene:React.FC<ShotProps>=({scene:s,index,count,repo,assetBase})=>{
 const f=useCurrentFrame();const labels=['输入','生成','交付'];const step=s.visual==='prompt'?0:s.media||s.visual==='files'||s.type==='hook'?2:s.visual==='diagram'&&index>0?1:Math.min(2,Math.floor(index/count*3));
 return <AbsoluteFill style={{background:paper,color:ink,fontFamily:font,overflow:'hidden'}}>
  <div style={{position:'absolute',top:138,left:82,right:110,display:'flex',justifyContent:'space-between',fontSize:27,letterSpacing:2,fontWeight:750}}><span>THE USEFUL TOOL</span><span style={{color:blue}}>AI / 02</span></div>
  <div style={{position:'absolute',left:82,top:250,right:110,translate:`0 ${(1-enter(f))*35}px`,opacity:enter(f)}}><div style={{fontSize:91,fontWeight:800,lineHeight:1.18,letterSpacing:-3}}>{s.title}</div><div style={{fontSize:94,fontWeight:800,color:blue,marginTop:14,lineHeight:1.25}}>{s.highlight}</div></div>
  <div style={{position:'absolute',top:550,left:82,right:110,display:'flex',gap:12}}>{labels.map((l,i)=><div key={l} style={{flex:1,background:step===i?blue:'#e4e6e5',color:step===i?'#fff':'#7a8491',fontSize:28,fontWeight:700,padding:'13px 18px',borderRadius:7}}>0{i+1} {l}</div>)}</div>
  <div style={{position:'absolute',left:82,right:110,top:635,height:740,background:'#fff',borderRadius:20,border:'2px solid #dae0e5',overflow:'hidden',boxShadow:'0 18px 45px #1c2a3f0b',translate:`0 ${(1-enter(f,5))*70}px`}}>
   <div style={{height:58,display:'flex',alignItems:'center',padding:'0 24px',gap:9,background:'#eef1f5',borderBottom:'1px solid #dfe4eb'}}>{['#ec8577','#eac66e','#7fbd99'].map(c=><span key={c} style={{width:12,height:12,borderRadius:9,background:c}}/>)}<span style={{fontSize:23,color:'#778496',marginLeft:20}}>{s.media?'官方仓库示例':'工作流自制示意'}</span></div>
   {s.media?<><Img src={staticFile(`${assetBase}/${s.media}`)} style={{position:'absolute',top:135,left:interpolate(f,[0,s.durationFrames],[-30,-250],clamp),width:1420,height:683,objectFit:'contain'}}/><div style={{position:'absolute',bottom:25,left:30,fontSize:23,color:'#748194',background:'#ffffffef',padding:12}}>Diagram Design / MIT / 官方示例 · 非亲测</div></>:
    s.visual==='prompt'?<div style={{padding:42}}><div style={{fontSize:30,color:'#8090a5',marginBottom:22}}>把目标说具体</div><div style={{padding:'34px 28px',background:'#f0f4ff',borderRadius:16,border:'2px solid #d9e2ff',fontSize:44,lineHeight:1.6,minHeight:220}}>{(s.body||'画一个 Agent 流程：输入、检索、调用工具、返回结果。').slice(0,Math.floor(f/1.5))}<span style={{color:blue,opacity:Math.floor(f/15)%2}}>▍</span></div><div style={{marginTop:40,color:blue,fontSize:36}}>说明节点 · 说明关系 · 说明用途</div></div>:
    s.visual==='diagram'?<div style={{height:650,padding:'0 25px'}}><Diagram/></div>:
    s.type==='stats'?<div style={{padding:'90px 40px'}}><div style={{fontSize:36,color:'#76869d'}}>GitHub 本周新增 Star</div><div style={{fontSize:160,fontWeight:850,color:blue,letterSpacing:-8,marginTop:20}}>+{Math.round((s.metric||0)*interpolate(f,[0,35],[0,1],clamp)).toLocaleString()}</div><div style={{fontSize:31,color:'#77869a',marginTop:38}}>2026.10.15 采集 · 是关注度，非测评</div></div>:
    s.visual==='files'?<div style={{padding:'55px 38px',display:'flex',flexDirection:'column',gap:24}}>{['.html  可直接打开','.svg   继续编辑','.png   放进文档'].map((v,i)=><div key={v} style={{padding:30,background:i===Math.floor(f/35)%3?'#e8efff':'#f6f7f9',border:'1px solid #dfe5ee',borderRadius:12,color:i===0?blue:ink,fontFamily:'monospace',fontSize:39,translate:`${(1-enter(f,i*9))*80}px 0`}}>▤ {v}</div>)}</div>:
    <div style={{height:650,padding:30}}><Flow cues={s.cueFrames} labels={s.items.length?s.items:['核对内容','导出图片','放进文档']} accent={blue} light vertical/></div>}
  </div>
  <div style={{position:'absolute',top:1410,left:83,right:110,color:'#6e7d91',fontSize:30}}>{s.visual==='prompt'?'输入示意 · 不代表实际调用记录':s.body}</div>
  <CaptionLine scene={s} accent={blue} light/><Footer scene={s} index={index} count={count} repo={repo} accent={blue} light/>
 </AbsoluteFill>;
};
