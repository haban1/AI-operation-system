export interface Friend { wechat_id: string; nickname?: string; remark?: string }
export interface Reception { key:string; peer:string; room:string; reason:string; last_message:string; notification_error?:string; started_at:number; updated_at:number }
export interface Broadcast { id:string; content:string; status:string; has_image:boolean; recipients:string[]; success_count:number; failed_count:number; created_at:number; results:{peer:string;text_sent:boolean;image_sent:boolean;error?:string}[] }
export interface Snapshot { settings:{notifier:string;knowledge_codes:string[]}; friends:Friend[]; receptions:Reception[]; broadcasts:Broadcast[]; categories:{code:string;name:string}[] }
export const friendName=(friend:Friend)=>friend.remark || friend.nickname || friend.wechat_id;
export const timestamp=(value:number)=>value?new Date(value*1000).toLocaleString('zh-CN'):'—';
