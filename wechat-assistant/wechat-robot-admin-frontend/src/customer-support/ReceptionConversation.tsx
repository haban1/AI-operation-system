import { useMemoizedFn } from 'ahooks';
import { theme } from 'antd';
import React from 'react';
import ConversationPane from '@/chat/conversation/ConversationPane';
import type { ChatDraft, ChatRobot } from '@/chat/conversation/types';
import { ReceptionLayout } from './Reception.styled';
import type { Reception, Snapshot } from './types';
import { friendName } from './types';

interface IProps {
	robotId: number;
	robot: ChatRobot;
	reception: Reception;
	data: Snapshot;
	draft: ChatDraft;
	busy: boolean;
	disabledReason?: string;
	onDraftChange: (key: string, patch: Partial<ChatDraft>) => void;
	onBusyChange: (busy: boolean) => void;
}

const ReceptionConversation = (props: IProps) => {
	const { token } = theme.useToken();
	const target = props.reception.room || props.reception.peer;
	const friend = props.data.friends.find(item => item.wechat_id === target);
	const peer = props.data.friends.find(item => item.wechat_id === props.reception.peer);
	const contact = friend || { wechat_id: target, nickname: props.reception.room ? `群聊 ${target}` : target };
	const changeDraft = useMemoizedFn((patch: Partial<ChatDraft>) => props.onDraftChange(props.reception.key, patch));
	const colors = {
		'--chat-border': token.colorBorderSecondary,
		'--chat-muted': token.colorTextSecondary,
		'--chat-selected': token.colorPrimaryBg,
		'--chat-background': token.colorFillAlter,
		'--chat-incoming': token.colorBgContainer,
		'--chat-outgoing': token.colorPrimaryBg,
	} as React.CSSProperties;
	return (
		<ReceptionLayout style={colors}>
			<ConversationPane
				robotId={props.robotId}
				robot={props.robot}
				contact={contact}
				draft={props.draft}
				busy={props.busy}
				disabledReason={props.disabledReason}
				subtitle={
					props.reception.room
						? `群聊接待 · 当前接待 ${friendName(peer || { wechat_id: props.reception.peer })} · 回复发送到本群`
						: '人工接待中 · AI 已暂停 · 消息自动更新'
				}
				onDraftChange={changeDraft}
				onBusyChange={props.onBusyChange}
			/>
		</ReceptionLayout>
	);
};

export default React.memo(ReceptionConversation);
