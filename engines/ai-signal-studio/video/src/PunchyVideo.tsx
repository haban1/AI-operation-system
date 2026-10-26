import React from 'react';
import {AbsoluteFill,Sequence,Audio,Img,staticFile,interpolate,spring,useCurrentFrame,useVideoConfig} from 'remotion';
import {Video} from '@remotion/media';
import type {VideoProps,Scene} from './content';

type Word={text:string;startMs:number;endMs:number};
type Shot=Omit<Scene,'captions'> & {shot?:string;media?:string;mediaLabel?:string;captions:(Scene['captions'][number]&{words?:Word[]})[]};
export type PunchyProps=Omit<VideoProps,'scenes'> & {audioMix?:{music:number;effects:number};narrationAudio?:string;musicAudio?:string;effectsAudio?:string;assetBase?:string;scenes:Shot[]};
const ink='#10151D',yellow='#E7FF56',paper='#F4F3EC',blue='#3074FF';
const clamp={extrapolateLeft:'clamp',extrapolateRight:'clamp'} as const;
const ease=(f:number,d=16)=>spring({frame:f,fps:30,config:{damping:18,stiffness:180},durationInFrames:d});

const Arrow=({size=64,color=yellow}:{size?:number;color?:string})=><svg width={size} height={size} viewBox="0 0 64 64"><path d="M8 32h45M34 10l22 22-22 22" fill="none" stroke={color} strokeWidth="7" strokeLinecap="round" strokeLinejoin="round"/></svg>;
const Chip:React.FC<{children:React.ReactNode;dark?:boolean}>=({children,dark})=><div style={{display:'inline-flex',alignItems:'center',gap:14,padding:'14px 22px',borderRadius:9,background:dark?ink:yellow,color:dark?paper:ink,fontSize:27,fontWeight:800,letterSpacing:1}}>{children}</div>;

const Captions:React.FC<{scene:Shot;light:boolean}>=({scene,light})=>{
 const f=useCurrentFrame();const ms=f/30*1000;
 const c=scene.captions.find(c=>ms>=c.startMs-65 && ms<Math.min(c.endMs+110,scene.durationFrames/30*1000));
 if(!c)return null;
 return <div style={{position:'absolute',top:1510,left:50,width:910,textAlign:'center',fontSize:46,lineHeight:1.38,fontWeight:750,color:light?ink:paper,letterSpacing:0}}>
  <span style={{display:'inline-block',padding:'13px 19px',background:light?'rgba(244,243,236,.97)':'rgba(10,15,22,.96)',borderRadius:10,boxShadow:light?'0 4px 0 #10151D12':'none'}}>{c.words?c.words.map((w,i)=><span key={i} style={{color:ms>=w.startMs&&ms<w.endMs+30?(light?blue:yellow):undefined}}>{w.text}</span>):c.text}</span>
 </div>;
};

const BrowserFrame:React.FC<{scene:Shot;base:string;hero?:boolean;mode?:string}>=({scene,base,hero,mode})=>{
 const f=useCurrentFrame();const p=interpolate(f,[0,scene.durationFrames],[0,1],clamp);
 const entry=ease(f);
 const pan=mode==='focus'?interpolate(p,[0,.5,1],[0,0,-80]):mode==='export'?-1550:interpolate(p,[0,1],[-440,-580]);
 const scale=mode==='styles'?1:mode==='export'?2:mode==='focus'?1.65:hero?1.56:1.32;
 return <div style={{position:'absolute',left:46,top:hero?570:560,width:976,height:820,background:'#07101C',borderRadius:26,overflow:'hidden',boxShadow:'0 35px 80px #0005',border:'2px solid #ffffff25',transform:`translateY(${(1-entry)*90}px) scale(${.97+.03*entry})`}}>
   <div style={{height:49,background:'#182432',display:'flex',alignItems:'center',gap:10,padding:'0 22px',color:'#C6D0D9',fontSize:20}}><i style={{width:10,height:10,borderRadius:8,background:'#FF705C'}}/><i style={{width:10,height:10,borderRadius:8,background:yellow}}/><i style={{width:10,height:10,borderRadius:8,background:'#63DCAE'}}/><span style={{marginLeft:15}}>{scene.media?(scene.mediaLabel||'项目演示'):'自制示意 / key points'}</span><span style={{marginLeft:'auto'}}>↗</span></div>
   {scene.media?<div style={{position:'absolute',left:mode==='styles'?-55:pan*.62,top:mode==='export'?-50:mode==='styles'?100:hero?48:80,width:976*scale,height:610*scale,transform:`translateY(${mode==='styles'||mode==='export'?0:-20*p}px)`}}>
     <Video src={staticFile(`${base}/${scene.media}`)} muted loop style={{width:'100%',height:'100%'}} trimBefore={mode==='focus'?36:mode==='story'?100:mode==='end'?300:mode==='export'?18:0} playbackRate={mode==='story'?2:1}/>
   </div>:<MiniDiagram frame={f} items={scene.items.length?scene.items:[scene.title,scene.highlight||'项目用途',scene.body||'查看官方说明']} />}
   <div style={{position:'absolute',bottom:0,left:0,right:0,padding:'24px 28px',background:'linear-gradient(transparent,#07101C 30%)',color:'#fff',display:'flex',justifyContent:'space-between',alignItems:'center',height:115}}>
    <span style={{fontSize:25,color:'#A5BCC8'}}>{scene.mediaLabel||'自制示意'}</span>{mode!=='story'&&<span style={{fontSize:26,color:yellow,fontWeight:800}}>{mode==='focus'?'CLICK → FOCUS':mode==='styles'?'STYLE → SWITCH':mode==='export'?'EXPORT → WEBM':'PLAY → FOLLOW'}</span>}
   </div>
   {mode==='focus'&&f>37&&<div style={{position:'absolute',left:424,top:410,color:yellow,fontSize:34,fontWeight:800,background:'#10151DEB',padding:'14px 22px',borderRadius:12,transform:`translateX(${(1-ease(f-37))*60}px)`}}>← 关联节点</div>}
   {mode==='export'&&f>15&&<div style={{position:'absolute',left:599,top:647,width:354,height:72,border:`4px solid ${yellow}`,borderRadius:12,boxShadow:'0 0 22px #E7FF5633',opacity:interpolate(f,[15,23],[0,1],clamp)}}/>}
 </div>;
};

const MiniDiagram:React.FC<{frame:number;items:string[]}>=({frame,items})=><div style={{position:'absolute',inset:'110px 40px',display:'flex',flexDirection:'column',gap:24}}>{items.map((t,i)=><div key={i} style={{display:'flex',gap:20,alignItems:'center',opacity:interpolate(frame-i*8,[0,12],[0,1],clamp),transform:`translateX(${(1-ease(frame-i*8))*90}px)`}}><div style={{padding:'28px 40px',width:780,color:'#fff',background:'#14283A',borderLeft:`5px solid ${i%2?yellow:blue}`,fontSize:t.length>18?34:42,fontWeight:700}}>{t}</div></div>)}</div>;

const StatShot:React.FC<{scene:Shot;repo:string}>=({scene,repo})=>{
 const f=useCurrentFrame();const reveal=ease(f-17,25);
 const n=Math.round((scene.metric||0)*interpolate(f,[18,45],[0,1],clamp));
 return <>
 <div style={{position:'absolute',top:565,left:-60,width:1200,height:570,background:yellow,transform:`rotate(-5deg) translateX(${(1-reveal)*1100}px)`}}/>
 <div style={{position:'absolute',top:610,left:60,color:ink,width:920,transform:`scale(${.75+.25*reveal})`,opacity:reveal}}><div style={{fontSize:45,fontWeight:800}}>GITHUB · 本周新增</div><div style={{fontSize:188,fontWeight:900,letterSpacing:-13,lineHeight:1.24,fontVariantNumeric:'tabular-nums'}}>{n.toLocaleString()}</div><div style={{fontSize:36,fontWeight:700}}>STARS <span style={{marginLeft:35,fontWeight:500}}>一周的关注度，有多高？</span></div></div>
 <div style={{position:'absolute',top:1210,left:60,color:'#B6BFCA',fontSize:29,lineHeight:1.7}}>{repo}<br/>{scene.body}<br/><span style={{color:'#748393',fontSize:24}}>周新增 ≠ 累计 · 关注度不代表实际效果</span></div>
 </>;
};

const PromptShot:React.FC<{scene:Shot;archify:boolean}>=({scene,archify})=>{
 const f=useCurrentFrame();const typed=archify?'把 Agent 调用工具的流程画出来。':scene.body||scene.title;
 return <>
  <div style={{position:'absolute',left:60,top:580,width:920,padding:35,background:'#fff',borderRadius:24,border:'2px solid #D8DCD5',boxShadow:'0 18px 0 #10151D08',transform:`translateY(${(1-ease(f))*40}px)`}}>
   <div style={{color:'#728076',fontSize:25,marginBottom:28}}>输入示意 / {archify?'系统描述':'项目说明'}</div><div style={{fontSize:43,fontWeight:700,lineHeight:1.55,minHeight:140}}>{typed.slice(0,Math.floor(f*1.25))}<span style={{opacity:f%20<13?1:0,color:blue}}>▏</span></div><div style={{display:'flex',justifyContent:'flex-end'}}><Chip dark>{archify?'生成图解':'查看要点'} <Arrow size={25}/></Chip></div>
  </div>
  <div style={{position:'absolute',top:960,left:62,display:'flex',alignItems:'center',gap:32}}>{(scene.items.length?scene.items:['描述','关系','交互图']).map((t,i)=><React.Fragment key={i}>{i>0&&<Arrow color={blue} size={42}/>}<div style={{fontSize:34,fontWeight:750,transform:`translateY(${(1-ease(f-20-i*9))*45}px)`,opacity:interpolate(f,[18+i*9,27+i*9],[0,1],clamp)}}>{t}</div></React.Fragment>)}</div>
  {archify&&<div style={{position:'absolute',top:1120,left:60,display:'flex',gap:20}}>{['架构图','流程图','时序图'].map((t,i)=><div key={t} style={{width:280,height:260,borderRadius:18,padding:'24px 20px',background:i===1?ink:'#E6E9E1',color:i===1?paper:ink,transform:`translateY(${(1-ease(f-43-i*7))*80}px)`,opacity:interpolate(f,[40+i*7,50+i*7],[0,1],clamp)}}><svg width="235" height="125" viewBox="0 0 235 125"><path d={i===2?'M40 5v105M115 5v105M195 5v105M40 25h75m0 35h80m-80 30H40':'M30 25h80v40h90M110 65v35H30'} stroke={i===1?yellow:blue} strokeWidth="5" fill="none"/>{i!==2&&[30,110,200].map((x,j)=><rect key={x} x={x-18} y={j===0?8:j===1?48:83} width="36" height="32" rx="5" fill={i===1?yellow:blue}/>)}</svg><div style={{fontSize:37,fontWeight:800,marginTop:22}}>{t}</div></div>)}</div>}
 </>;
};

const CheckShot:React.FC=()=>{
 const f=useCurrentFrame();return <>
 <div style={{position:'absolute',left:60,top:580,width:920,height:570,background:paper,borderRadius:26,padding:40,color:ink}}>
  <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',fontSize:42,fontWeight:800}}><span>图中关系</span><span style={{fontSize:105,color:blue,transform:`rotate(${interpolate(f,[0,18],[-20,0],clamp)}deg)`}}>⇄</span><span>实际代码</span></div>
  <div style={{height:2,background:'#CBD0C8',margin:'25px 0'}}/>
  {['调用方向是否一致','遗漏了哪个分支','来源能不能追溯'].map((s,i)=><div key={s} style={{fontSize:38,margin:'28px 0',display:'flex',gap:22,opacity:interpolate(f-i*17,[5,16],[0,1],clamp),transform:`translateX(${(1-ease(f-i*17-5))*50}px)`}}><span style={{color:blue}}>✓</span>{s}</div>)}
 </div><div style={{position:'absolute',top:1230,left:65,color:paper,fontSize:39,fontWeight:700}}>用于讲解与梳理<span style={{color:yellow}}>，仍需核对</span></div>
 </>;
};

const PunchyScene:React.FC<{scene:Shot;index:number;count:number;base:string;repo:string;source_kind?:string}>=({scene,index,count,base,repo,source_kind})=>{
 const f=useCurrentFrame();const shot=scene.shot||({cover:'hero',stats:'stats',pipeline:'prompt',compare:'check',hook:'end'}[scene.type]||'story');
 const light=['hero','prompt','styles','end'].includes(shot);const color=light?ink:paper;
 const titleIn=ease(f,18);const hero=shot==='hero';
 return <AbsoluteFill style={{background:light?paper:ink,color,fontFamily:'"PingFang SC","Hiragino Sans GB",Arial,sans-serif',overflow:'hidden'}}>
   <div style={{position:'absolute',inset:0,backgroundImage:light?'radial-gradient(#10151D16 1.4px,transparent 1.4px)':'radial-gradient(#F4F3EC10 1.4px,transparent 1.4px)',backgroundSize:'32px 32px',opacity:.45,transform:`translateY(${f%32}px)`}}/>
   <div style={{position:'absolute',top:155,left:58,right:105,display:'flex',justifyContent:'space-between',alignItems:'center'}}><Chip dark={light}>{hero?(source_kind==='topic'?'主题观察':'AI 工具观察'):repo.split('/').at(-1)?.slice(0,24).toUpperCase()}</Chip><span style={{fontSize:26,fontWeight:750,letterSpacing:3,color:light?'#6B736E':'#99A6B3'}}>0{index+1} / 0{count}</span></div>
   <div style={{position:'absolute',left:58,top:276,width:930,transform:`translateY(${(1-titleIn)*65}px)`,opacity:titleIn}}>
    <div style={{fontSize:hero?86:scene.title.length>12?60:78,fontWeight:850,lineHeight:1.22,letterSpacing:-3}}>{scene.title}</div>
    <div style={{fontSize:hero?96:(scene.highlight?.length||0)>12?60:84,fontWeight:900,lineHeight:1.25,letterSpacing:-4,marginTop:10,color:light?blue:yellow,display:'inline-block',position:'relative'}}>{shot==='stats'?'关注度上来了':scene.highlight}<div style={{height:8,background:light?yellow:blue,width:`${interpolate(f,[7,26],[0,100],clamp)}%`,marginTop:6}}/></div>
   </div>
   {shot==='stats'?<StatShot scene={scene} repo={repo}/>:shot==='prompt'?<PromptShot scene={scene} archify={repo==='tt-a1i/archify'}/>:shot==='check'&&repo==='tt-a1i/archify'?<CheckShot/>:<BrowserFrame scene={scene} base={base} hero={hero} mode={shot}/>}
   {shot==='end'&&<div style={{position:'absolute',top:1230,left:86,right:95,background:yellow,padding:'25px 26px',borderRadius:16,display:'flex',alignItems:'center',justifyContent:'space-between',boxShadow:'0 10px 30px #0004',transform:`translateY(${(1-ease(f-8))*70}px)`}}><span style={{fontSize:40,fontWeight:900,color:ink}}>{source_kind==='topic'?(scene.items[0]||'从一个小问题开始验证'):'GitHub 搜索 '+repo.split('/').at(-1)?.slice(0,23)}</span><Arrow color={ink} size={52}/></div>}
   {shot==='story'&&repo==='tt-a1i/archify'&&<div style={{position:'absolute',top:1250,left:90,display:'flex',alignItems:'center',gap:20,color:paper,fontSize:30,fontWeight:800,background:'#07101CEC',padding:'12px 18px',borderRadius:12}}>{['输入','规划','调用','返回'].map((t,i)=><React.Fragment key={t}>{i>0&&<Arrow size={25}/>}<span style={{color:Math.floor(f/22)%4===i?yellow:paper}}>{t}</span></React.Fragment>)}</div>}
   <Captions scene={scene} light={light}/>
   <div style={{position:'absolute',bottom:175,left:60,color:light?'#747D74':'#8C9CA8',fontSize:23,fontWeight:600,letterSpacing:1}}>AI SIGNAL <span style={{marginLeft:22,fontWeight:400}}>{source_kind==='topic'?'来源可追溯 · 自制示意 · 原创讲解':'开源工具 · 自制示意 · 原创讲解'}</span></div>
   <div style={{position:'absolute',left:0,right:0,bottom:135,height:6,background:light?'#10151D12':'#ffffff15'}}><div style={{height:'100%',background:light?blue:yellow,width:`${(index+f/scene.durationFrames)/count*100}%`}}/></div>
   <div style={{position:'absolute',inset:0,pointerEvents:'none',background:yellow,opacity:interpolate(f,[0,3,6],[.32,.1,0],clamp)}}/>
 </AbsoluteFill>;
};

export const PunchyVideo:React.FC<PunchyProps>=(props)=>{
 const base=props.assetBase||props.narrationAudio?.split('/audio/')[0]||'';
 return <AbsoluteFill>
  {props.narrationAudio&&<Audio src={staticFile(props.narrationAudio)}/>}
  {props.musicAudio&&<Audio src={staticFile(props.musicAudio)} volume={props.audioMix?.music??.32}/>}
  {props.effectsAudio&&<Audio src={staticFile(props.effectsAudio)} volume={.6}/>}
  {props.scenes.map((s,i)=><Sequence key={i} from={s.from} durationInFrames={s.durationFrames}>{!props.narrationAudio&&s.audio&&<Audio src={staticFile(s.audio)}/>}<PunchyScene scene={s} index={i} count={props.scenes.length} base={base} repo={props.repo} source_kind={props.source_kind}/></Sequence>)}
 </AbsoluteFill>;
};
