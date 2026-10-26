import React from 'react';
import {AbsoluteFill,Sequence,staticFile} from 'remotion';
import {Audio} from '@remotion/media';
import {RapidScene} from './RapidScene';
import {WalkthroughScene} from './WalkthroughScene';
import {DiscoveryScene} from './DiscoveryScene';
import type {LabProps} from './shared';
export const StyleLab:React.FC<LabProps>=(p)=>{
 const Shot=p.style_id==='walkthrough'?WalkthroughScene:p.style_id==='discovery'?DiscoveryScene:RapidScene;
 return <AbsoluteFill>
  {p.narrationAudio&&<Audio src={staticFile(p.narrationAudio)}/>}
  {p.musicAudio&&<Audio src={staticFile(p.musicAudio)} volume={p.audioMix?.music??(p.style_id==='rapid'?.25:p.style_id==='walkthrough'?.12:.16)}/>}
  {p.effectsAudio&&<Audio src={staticFile(p.effectsAudio)} volume={p.audioMix?.effects??(p.style_id==='rapid'?.4:.2)}/>}
  {p.scenes.map((scene,index)=><Sequence key={index} from={scene.from} durationInFrames={scene.durationFrames} name={scene.title}>{!p.narrationAudio&&scene.audio&&<Audio src={staticFile(scene.audio)}/>}<Shot scene={scene} index={index} count={p.scenes.length} repo={p.repo} source_kind={p.source_kind} assetBase={p.assetBase||''}/></Sequence>)}
 </AbsoluteFill>;
};
