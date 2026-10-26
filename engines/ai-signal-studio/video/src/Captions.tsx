import React from 'react';
import {useCurrentFrame} from 'remotion';
import type {Caption} from '@remotion/captions';
export const Captions:React.FC<{captions:Caption[]}>=({captions})=>{
 const ms=useCurrentFrame()/30*1000;const active=captions.find(c=>c.startMs<=ms&&ms<c.endMs);
 return <div style={{position:'absolute',left:90,right:130,top:1530,minHeight:156,display:'flex',alignItems:'center',justifyContent:'center',textAlign:'center',fontSize:48,lineHeight:1.5,fontWeight:650,textShadow:'0 3px 14px #000',color:'#f3fafa'}}>{active?.text}</div>;
};
