import React from 'react';
import {AbsoluteFill,Sequence,staticFile,useCurrentFrame,interpolate} from 'remotion';
import {Audio} from '@remotion/media';
import type {VideoProps,Scene} from './content';
import {Backdrop} from './Backdrop';
import {Captions} from './Captions';
import {TitleScene} from './scenes/TitleScene';
import {StatsScene} from './scenes/StatsScene';
import {PipelineScene} from './scenes/PipelineScene';
import {CardsScene} from './scenes/CardsScene';
import {MapScene} from './scenes/MapScene';
const SceneView:React.FC<{scene:Scene;index:number;total:number;repo:string;date:string}>=({scene,index,total,repo,date})=>{
 const f=useCurrentFrame();
 return <AbsoluteFill style={{fontFamily:'"PingFang SC","Helvetica Neue",sans-serif',color:'#f3fafa',opacity:interpolate(f,[0,7,scene.durationFrames-6,scene.durationFrames],[0,1,1,0],{extrapolateLeft:'clamp',extrapolateRight:'clamp'})}}>
  <div style={{position:'absolute',left:90,right:130,top:135,display:'flex',justifyContent:'space-between',alignItems:'center'}}><span style={{fontSize:28,letterSpacing:5,color:'#67f3ef'}}>AI SIGNAL</span><span style={{fontSize:25,color:'#8ca0a7'}}>本周工具观察</span></div>
  <div style={{position:'absolute',left:90,right:130,top:265}}><div style={{fontSize:27,color:'#a78bfa',letterSpacing:4}}>{scene.eyebrow}</div>
   {scene.type==='cover'||scene.type==='hook'?<TitleScene scene={scene}/>:scene.type==='stats'?<StatsScene scene={scene}/>:scene.type==='map'?<MapScene scene={scene}/>:scene.type==='pipeline'?<PipelineScene scene={scene}/>:<CardsScene scene={scene}/>}
  </div>
  <Captions captions={scene.captions||[]}/>
  <div style={{position:'absolute',left:90,right:130,top:1750,display:'flex',justifyContent:'space-between',fontSize:23,color:'#8ca0a7'}}><span>{repo} · {date.slice(0,10)}</span><span>{String(index+1).padStart(2,'0')} / {String(total).padStart(2,'0')}</span></div>
  <div style={{position:'absolute',top:1810,left:90,right:130,height:3,background:'#193135'}}><div style={{width:`${(index+f/scene.durationFrames)/total*100}%`,height:3,background:'#67f3ef'}}/></div>
  {f<9&&<div style={{position:'absolute',height:4,left:0,right:0,top:f/8*1920,background:'#67f3ef88',boxShadow:'0 0 30px #67f3ef'}}/>}
  {scene.audio&&<Audio src={staticFile(scene.audio)}/>}
 </AbsoluteFill>;
};
export const TrendVideo:React.FC<VideoProps>=(props)=><AbsoluteFill><Backdrop/>{props.scenes.map((scene,index)=><Sequence key={index} from={scene.from} durationInFrames={scene.durationFrames} name={scene.title}><SceneView scene={scene} index={index} total={props.scenes.length} repo={props.repo} date={props.created_at}/></Sequence>)}</AbsoluteFill>;
