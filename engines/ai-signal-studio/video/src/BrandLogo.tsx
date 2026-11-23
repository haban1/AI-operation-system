import React from 'react';
import {AbsoluteFill, Img, staticFile, useVideoConfig} from 'remotion';

export function withBrandLogo<P extends object>(Video:React.ComponentType<P>):React.FC<P> {
  return function BrandedVideo(props:P) {
    const {width,height}=useVideoConfig();
    const shortSide=Math.min(width,height),size=Math.round(shortSide*.12),margin=Math.round(shortSide*.03);
    return <AbsoluteFill>
      <Video {...props}/>
      <Img src={staticFile('branding/intellidriven.png')} alt="智慧驱动" style={{position:'absolute',left:margin,top:margin,width:size,height:'auto',opacity:.94,zIndex:1000,pointerEvents:'none',filter:'drop-shadow(0 1px 2px #ffffffb3) drop-shadow(0 1px 3px #00000059)'}}/>
    </AbsoluteFill>;
  };
}
