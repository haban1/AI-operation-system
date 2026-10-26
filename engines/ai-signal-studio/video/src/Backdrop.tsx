import React from 'react';
import {AbsoluteFill,interpolate,useCurrentFrame,useVideoConfig} from 'remotion';
export const Backdrop:React.FC=()=>{
 const f=useCurrentFrame();const {durationInFrames}=useVideoConfig();
 return <AbsoluteFill style={{background:'#04090D',overflow:'hidden'}}>
  <div style={{position:'absolute',inset:-80,backgroundImage:'linear-gradient(#67f3ef12 1px,transparent 1px),linear-gradient(90deg,#67f3ef12 1px,transparent 1px)',backgroundSize:'80px 80px',translate:`${-f/15%80}px ${-f/24%80}px`}}/>
  <div style={{position:'absolute',width:1400,height:1400,top:80,left:-160,background:'radial-gradient(circle,#1a6e6b42,transparent 67%)',scale:interpolate(f,[0,durationInFrames],[0.9,1.2])}}/>
  <div style={{position:'absolute',inset:0,background:'linear-gradient(180deg,#04090d22,transparent 45%,#04090D 88%)'}}/>
  <div style={{position:'absolute',inset:0,opacity:.08,backgroundImage:'repeating-linear-gradient(0deg,#ffffff22 0px,#ffffff22 1px,transparent 1px,transparent 5px)'}}/>
 </AbsoluteFill>;
};
