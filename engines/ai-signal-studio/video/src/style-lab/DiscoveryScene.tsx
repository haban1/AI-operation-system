import React from 'react';
import {AbsoluteFill,interpolate,useCurrentFrame} from 'remotion';
import {CaptionLine,Footer,Flow,clamp,enter,font,type ShotProps} from './shared';

const cyan='#7ee7e6',purple='#b7a2ff';
type P=[number,number,number];
const CAD:React.FC<{mode:string;duration:number}>=({mode,duration})=>{
 const f=useCurrentFrame();const angle=-.55+f/duration*.7;const tilt=.4;
 const project=([x,y,z]:P)=>{const xx=x*Math.cos(angle)+z*Math.sin(angle),zz=-x*Math.sin(angle)+z*Math.cos(angle);const yy=y*Math.cos(tilt)-zz*Math.sin(tilt);return [440+xx*1.8,520-yy*1.8,zz]};
 const cubes=[{x:0,y:-40,z:10,w:220,h:22,d:190},{x:0,y:115,z:-70,w:220,h:290,d:22}];
 const faces:{pts:number[][];depth:number;shade:string}[]=[];
 cubes.forEach((c,k)=>{
  const spread=mode==='check'?Math.sin(Math.min(1,f/45)*Math.PI/2)*24:0;
  const verts:P[]=[[-1,-1,-1],[1,-1,-1],[1,1,-1],[-1,1,-1],[-1,-1,1],[1,-1,1],[1,1,1],[-1,1,1]].map(([a,b,d])=>[c.x+a*c.w/2,c.y+b*c.h/2+(k?spread:0),c.z+d*c.d/2] as P);
  [[0,1,2,3],[4,5,6,7],[0,4,7,3],[1,5,6,2],[0,1,5,4],[3,2,6,7]].forEach((ix,i)=>{const pts=ix.map(j=>project(verts[j]));faces.push({pts,depth:pts.reduce((a,p)=>a+p[2],0)/4,shade:['#284b64','#4da6af','#377181','#224d67','#254a63','#90dddd'][i]})});
 });
 faces.sort((a,b)=>a.depth-b.depth);
 const wire=mode==='wire';
 return <svg width="100%" height="100%" viewBox="0 0 880 790">
  <ellipse cx="440" cy="690" rx="300" ry="50" fill="#060b1c" opacity=".6"/>
  {Array.from({length:9},(_,i)=><path key={i} d={`M${40+i*100} 575 L${-100+i*130} 790 M10 ${570+i*28} H870`} stroke="#7ee7e619" strokeWidth="1"/>)}
  {faces.map((face,i)=><polygon key={i} points={face.pts.map(p=>p.slice(0,2).join(',')).join(' ')} fill={wire?'#0c183222':face.shade} stroke={wire?cyan:'#bafafc90'} strokeWidth={wire?2.4:1.5} opacity={enter(f,i*1.5)}/>)}
  {!wire&&[-58,58].map((x,i)=>{const pts=Array.from({length:36},(_,j)=>project([x+18*Math.cos(j/36*Math.PI*2),180+18*Math.sin(j/36*Math.PI*2),-58]));return <polygon key={i} points={pts.map(p=>p.slice(0,2).join(',')).join(' ')} fill="#081a2b" stroke="#a2f0ec" strokeWidth="2"/>})}
  {mode==='check'&&<><path d="M140 120 H700 M140 100 V145 M700 100 V145" stroke={purple} strokeWidth="3"/><text x="420" y="90" textAnchor="middle" fill={purple} fontSize="31">尺寸 / 材料 / 承重</text><path d="M750 170 V540 M730 170 H770 M730 540 H770" stroke={purple} strokeWidth="3"/><text x="780" y="360" fill={purple} fontSize="29" transform="rotate(90 780 360)">需要人工复核</text></>}
  <text x="440" y="750" textAnchor="middle" fill="#7287a6" fontSize="25">自制几何示意 · 未调用 CAD 工具</text>
 </svg>;
};

export const DiscoveryScene:React.FC<ShotProps>=({scene:s,index,count,repo})=>{
 const f=useCurrentFrame();const mode=s.visual||'concept';
 return <AbsoluteFill style={{background:'#091126',color:'#f4f5ff',fontFamily:font,overflow:'hidden'}}>
  <div style={{position:'absolute',width:1200,height:1200,left:-400+f*.2,top:400,borderRadius:'50%',background:'radial-gradient(circle,#36507860,transparent 64%)'}}/>
  <div style={{position:'absolute',width:900,height:900,right:-450,top:100,borderRadius:'50%',background:'radial-gradient(circle,#53418c55,transparent 67%)'}}/>
  {Array.from({length:34},(_,i)=><span key={i} style={{position:'absolute',left:(i*173+41)%1020,top:(i*269+85)%1790,width:i%4===0?4:2,height:i%4===0?4:2,borderRadius:4,background:'#c1cfff',opacity:.13+.18*Math.sin(f/30+i)}}/>)}
  <div style={{position:'absolute',top:140,left:82,right:110,fontSize:27,color:purple,letterSpacing:5,display:'flex',justifyContent:'space-between'}}><span>A SMALL DISCOVERY</span><span>AI / 03</span></div>
  <div style={{position:'absolute',top:260,left:82,right:110,opacity:enter(f),translate:`0 ${(1-enter(f))*35}px`}}><div style={{fontSize:94,fontWeight:750,lineHeight:1.25,letterSpacing:-3}}>{s.title}</div><div style={{fontSize:103,color:cyan,fontWeight:800,lineHeight:1.25,marginTop:13,letterSpacing:-4}}>{s.highlight}</div></div>
  {s.type==='stats'?<div style={{position:'absolute',top:680,left:82,right:110,textAlign:'center'}}><div style={{fontSize:35,color:purple}}>这一周，有多少人关注？</div><div style={{fontSize:200,fontWeight:800,color:cyan,letterSpacing:-10,margin:'25px 0'}}>+{Math.round((s.metric||0)*interpolate(f,[0,50],[0,1],clamp)).toLocaleString()}</div><div style={{fontSize:35}}>GitHub 周新增 Star</div><div style={{fontSize:26,color:'#7d91ae',marginTop:30}}>2026.10.15 采集 · 关注度不代表工程可靠性</div></div>:
   mode==='files'?<div style={{position:'absolute',top:700,left:130,right:155,display:'flex',flexDirection:'column',gap:30}}>{s.items.map((item,i)=><div key={item} style={{padding:'40px 32px',border:'1px solid #7ee7e655',borderRadius:18,background:'#12213a',fontSize:43,color:i===0?cyan:'#eef2ff',opacity:enter(f,s.cueFrames?.[i]??i*12),translate:`0 ${(1-enter(f,s.cueFrames?.[i]??i*12))*35}px`}}><span style={{color:purple,marginRight:22}}>◇</span>{item}</div>)}<div style={{fontSize:28,color:'#8094af',textAlign:'center',marginTop:10}}>按用途选择导出格式</div></div>:
   !['solid','wire','check'].includes(mode)?<div style={{position:'absolute',top:650,left:82,right:110,height:690}}><Flow cues={s.cueFrames} labels={s.items.length?s.items:[s.title,s.highlight||'用途',s.body||'查看来源']} accent={cyan} vertical/></div>:
   <div style={{position:'absolute',top:620,left:70,right:95,height:790,scale:interpolate(f,[0,25],[.9,1],clamp)}}><CAD mode={mode} duration={s.durationFrames}/></div>}
  <div style={{position:'absolute',top:1415,left:82,right:110,textAlign:'center',color:purple,fontSize:32}}>{s.body}</div>
  <CaptionLine scene={s} accent={cyan}/><Footer scene={s} index={index} count={count} repo={repo} accent={purple}/>
 </AbsoluteFill>;
};
