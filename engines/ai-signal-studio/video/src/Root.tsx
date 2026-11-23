import React from 'react';
import {Composition} from 'remotion';
import {TrendVideo} from './TrendVideo';
import type {VideoProps} from './content';
import props from './demo-props.json';
import {PunchyVideo,type PunchyProps} from './PunchyVideo';
import v2 from './demo-props.json';
import {StyleLab} from './style-lab/StyleLab';
import type {LabProps} from './style-lab/shared';
import {withBrandLogo} from './BrandLogo';
const BrandedTrendVideo=withBrandLogo(TrendVideo);
const BrandedPunchyVideo=withBrandLogo(PunchyVideo);
const BrandedStyleLab=withBrandLogo(StyleLab);
export const Root:React.FC=()=> <>
 <Composition id="AITrend" component={BrandedTrendVideo} width={1080} height={1920} fps={30} durationInFrames={props.durationFrames} defaultProps={props as VideoProps} calculateMetadata={({props})=>({durationInFrames:props.durationFrames})}/>
 <Composition id="AITrendV2" component={BrandedPunchyVideo} width={1080} height={1920} fps={30} durationInFrames={v2.durationFrames} defaultProps={v2 as PunchyProps} calculateMetadata={({props})=>({durationInFrames:props.durationFrames})}/>
 <Composition id="StyleLab" component={BrandedStyleLab} width={1080} height={1920} fps={30} durationInFrames={props.durationFrames} defaultProps={{...props,style_id:'rapid'} as LabProps} calculateMetadata={({props})=>({durationInFrames:props.durationFrames})}/>
</>;
