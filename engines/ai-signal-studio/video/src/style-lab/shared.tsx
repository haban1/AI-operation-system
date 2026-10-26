import React from 'react';
import {interpolate, spring, useCurrentFrame} from 'remotion';
import type {Scene, VideoProps} from '../content';

type Word = {text:string;startMs:number;endMs:number};
export type LabScene = Omit<Scene,'captions'> & {visual?:string;media?:string;mediaLabel?:string;cueFrames?:number[];speechStartFrame?:number;captions:(Scene['captions'][number]&{words?:Word[]})[]};
export type LabProps = Omit<VideoProps,'scenes'> & {style_id?:string;audioMix?:{music:number;effects:number};assetBase?:string;narrationAudio?:string;musicAudio?:string;effectsAudio?:string;scenes:LabScene[]};
export type ShotProps = {scene:LabScene;index:number;count:number;repo:string;source_kind?:string;assetBase:string};
export const clamp = {extrapolateLeft:'clamp',extrapolateRight:'clamp'} as const;
export const enter=(frame:number,delay=0)=>spring({frame:frame-delay,fps:30,config:{damping:21,stiffness:180}});
export const font='"PingFang SC", "Noto Sans CJK SC", "Microsoft YaHei", sans-serif';

export const CaptionLine:React.FC<{scene:LabScene;accent:string;light?:boolean}>=({scene,accent,light})=>{
 const f=useCurrentFrame();const ms=f*1000/30;
 const cap=scene.captions.find((c,i)=>ms>=c.startMs-25&&ms<Math.min(c.endMs+100,scene.captions[i+1]?.startMs??Infinity));
 if(!cap)return null;
 return <div style={{position:'absolute',left:80,right:105,top:1540,textAlign:'center',fontSize:cap.text.length>22?41:47,fontWeight:650,lineHeight:1.5,color:light?'#1d293c':'#f5f6fc'}}><span style={{background:light?'#ffffffec':'#0b1020e8',padding:'15px 22px',borderRadius:12,display:'inline-block'}}>{cap.words?cap.words.map((w,i)=><span key={i} style={{color:ms>=w.startMs&&ms<w.endMs+35?accent:undefined}}>{w.text}</span>):cap.text}</span></div>;
};

export const Footer:React.FC<{scene:LabScene;index:number;count:number;repo:string;accent:string;light?:boolean}>=({scene,index,count,repo,accent,light})=>{
 const f=useCurrentFrame();
 return <><div style={{position:'absolute',bottom:158,left:82,right:105,fontSize:23,color:light?'#687382':'#8492ac',display:'flex',justifyContent:'space-between'}}><span>AI SIGNAL / {repo.length>32?repo.slice(0,31)+'…':repo}</span><span>{String(index+1).padStart(2,'0')} / {count}</span></div><div style={{position:'absolute',bottom:125,left:82,right:105,height:4,background:light?'#17243d15':'#ffffff15'}}><div style={{width:`${(index+f/scene.durationFrames)/count*100}%`,height:4,background:accent}}/></div></>;
};

export const Flow:React.FC<{labels:string[];accent:string;light?:boolean;vertical?:boolean;cues?:number[]}>=({labels,accent,light,vertical,cues})=>{
 const f=useCurrentFrame();const items=labels.slice(0,4);const delay=(i:number)=>cues?.[i]??i*8;const active=cues?.length?Math.max(0,cues.filter(c=>f>=c).length-1):Math.floor(f/35)%items.length;
 return <div style={{display:'flex',flexDirection:vertical?'column':'row',alignItems:'center',justifyContent:'center',gap:vertical?24:18,width:'100%',height:'100%'}}>{items.map((label,i)=><React.Fragment key={i}>{i>0&&<div style={{color:accent,fontSize:50,opacity:interpolate(f-delay(i),[0,10],[0,1],clamp)}}>{vertical?'↓':'→'}</div>}<div style={{minWidth:vertical?520:180,padding:vertical?'24px 32px':'40px 18px',textAlign:'center',border:`2px solid ${i===active?accent:light?'#d0d8e5':'#ffffff24'}`,borderRadius:18,background:light?'#fff':'#111d30',color:light?'#21324b':'#f6f7ff',fontSize:42,fontWeight:650,opacity:enter(f,delay(i)),translate:`0 ${(1-enter(f,delay(i)))*35}px`}}>{label}</div></React.Fragment>)}</div>;
};
