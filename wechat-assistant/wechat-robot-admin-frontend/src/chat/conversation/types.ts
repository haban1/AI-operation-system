import type * as Api from '@/api/wechat-robot/wechat-robot';

export type ChatContact = NonNullable<NonNullable<Api.Contact.ListList.ResponseBody['data']>['items']>[number];
export type ChatRobot = NonNullable<Api.Robot.ViewList.ResponseBody['data']>;
export type ChatMessage = NonNullable<NonNullable<Api.Chat.HistoryList.ResponseBody['data']>['items']>[number];
export interface ChatDraft {
	text: string;
	image?: File;
}
export const contactName = (contact: ChatContact) =>
	contact.remark || contact.nickname || contact.alias || contact.wechat_id || '未命名联系人';
export const contactKind = (contact: ChatContact) =>
	contact.wechat_id?.endsWith('@chatroom') ? '群聊' : contact.type === 'official_account' ? '公众号' : '好友';
