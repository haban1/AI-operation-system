import { useMemoizedFn } from 'ahooks';
import { App, Drawer, theme } from 'antd';
import React, { useRef, useState } from 'react';
import ContactSidebar from './ContactSidebar';
import ConversationPane from './ConversationPane';
import { ConversationLayout } from './styled';
import type { ChatContact, ChatDraft, ChatRobot } from './types';

interface IProps {
	robotId: number;
	robot: ChatRobot;
	contact: ChatContact;
	onClose: () => void;
}

const Conversation = (props: IProps) => {
	const { token } = theme.useToken();
	const { message } = App.useApp();
	const [contact, setContact] = useState(props.contact);
	const [drafts, setDrafts] = useState<Record<string, ChatDraft>>({});
	const [busy, setBusy] = useState(false);
	const busyRef = useRef(false);
	const onBusyChange = useMemoizedFn((value: boolean) => {
		busyRef.current = value;
		setBusy(value);
	});
	const onSelect = useMemoizedFn((next: ChatContact) => {
		if (!busyRef.current && next.wechat_id) setContact(next);
	});
	const onClose = useMemoizedFn(() => {
		if (busyRef.current) {
			message.info('消息正在发送，请稍候');
			return;
		}
		props.onClose();
	});
	const onDraftChange = useMemoizedFn((patch: Partial<ChatDraft>) => {
		const key = contact.wechat_id!;
		setDrafts(previous => ({ ...previous, [key]: { ...(previous[key] || { text: '' }), ...patch } }));
	});
	const colors = {
		'--chat-border': token.colorBorderSecondary,
		'--chat-muted': token.colorTextSecondary,
		'--chat-selected': token.colorPrimaryBg,
		'--chat-background': token.colorFillAlter,
		'--chat-incoming': token.colorBgContainer,
		'--chat-outgoing': token.colorPrimaryBg,
	} as React.CSSProperties;

	return (
		<Drawer
			title="微信聊天"
			open
			onClose={onClose}
			closable={!busy}
			mask={{ closable: !busy }}
			keyboard={!busy}
			size="min(1180px, 100vw)"
			styles={{ body: { padding: 0, overflow: 'hidden' }, header: { paddingTop: 12, paddingBottom: 12 } }}
		>
			<ConversationLayout style={colors}>
				<ContactSidebar
					robotId={props.robotId}
					contact={contact}
					busy={busy}
					onSelect={onSelect}
				/>
				<ConversationPane
					key={`${props.robotId}:${contact.wechat_id}`}
					robotId={props.robotId}
					robot={props.robot}
					contact={contact}
					draft={drafts[contact.wechat_id!] || { text: '' }}
					busy={busy}
					onBusyChange={onBusyChange}
					onDraftChange={onDraftChange}
				/>
			</ConversationLayout>
		</Drawer>
	);
};

export default React.memo(Conversation);
