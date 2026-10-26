import type {Caption} from '@remotion/captions';
export const theme = {background:'#04090D',surface:'#0B151B',ink:'#F3FAFA',muted:'#8CA0A7',accent:'#67F3EF',secondary:'#A78BFA'};
export type Scene = {type:string;eyebrow:string;title:string;highlight?:string;metric?:number;body?:string;items:string[];narration:string[];sourceIds:string[];from:number;durationFrames:number;audio:string;captions:Caption[]};
export type VideoProps = {title:string;repo:string;source_kind?:string;topic_title?:string;created_at:string;durationFrames:number;scenes:Scene[];sources:{id:string;url:string}[]};
