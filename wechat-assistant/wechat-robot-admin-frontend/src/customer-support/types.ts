export interface Friend {
	wechat_id: string;
	nickname?: string;
	remark?: string;
	avatar?: string;
}
export interface Reception {
	key: string;
	peer: string;
	room: string;
	reason: string;
	last_message: string;
	notification_error?: string;
	started_at: number;
	updated_at: number;
}
export interface Broadcast {
	id: string;
	content: string;
	status: string;
	has_image: boolean;
	image_count?: number;
	recipients: string[];
	success_count: number;
	failed_count: number;
	created_at: number;
	results: { peer: string; text_sent: boolean; image_sent: boolean; images_sent?: number; error?: string }[];
}
export interface Snapshot {
	settings: { notifier: string; knowledge_codes: string[] };
	friends: Friend[];
	receptions: Reception[];
	broadcasts: Broadcast[];
	categories: { code: string; name: string }[];
}
export const friendName = (friend: Friend) => friend.remark || friend.nickname || friend.wechat_id;
export const timestamp = (value: number) => (value ? new Date(value * 1000).toLocaleString('zh-CN') : '—');
export const broadcastLabels: Record<string, string> = {
	pending: '等待发送',
	running: '发送中',
	completed: '已完成',
	partial: '部分失败',
	failed: '发送失败',
	interrupted: '结果待核对',
};
