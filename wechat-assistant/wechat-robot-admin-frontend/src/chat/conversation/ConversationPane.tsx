import { HistoryOutlined, ReloadOutlined } from '@ant-design/icons';
import { useMemoizedFn, useRequest } from 'ahooks';
import { Alert, Avatar, Button, Empty, Space, Spin, Tag } from 'antd';
import dayjs from 'dayjs';
import React, { useLayoutEffect, useMemo, useRef, useState } from 'react';
import ChatHistory from '@/chat';
import { DefaultAvatar } from '@/constant';
import MessageContent from '../components/MessageContent';
import Composer from './Composer';
import type { ChatContact, ChatDraft, ChatRobot } from './types';
import { contactKind, contactName } from './types';

interface IProps {
	robotId: number;
	robot: ChatRobot;
	contact: ChatContact;
	draft: ChatDraft;
	busy: boolean;
	subtitle?: string;
	disabledReason?: string;
	onDraftChange: (patch: Partial<ChatDraft>) => void;
	onBusyChange: (busy: boolean) => void;
}

const ConversationPane = (props: IProps) => {
	const [historyOpen, setHistoryOpen] = useState(false);
	const [hasNew, setHasNew] = useState(false);
	const viewport = useRef<HTMLDivElement>(null);
	const atBottom = useRef(true);
	const previousLastID = useRef<number | undefined>(undefined);
	const { data, loading, error, refresh, refreshAsync } = useRequest(
		async () => {
			const response = await window.wechatRobotClient.chat.historyList({
				id: props.robotId,
				contact_id: props.contact.wechat_id!,
				page_index: 1,
				page_size: 50,
			});
			return response.data.data;
		},
		{ pollingInterval: 3000, pollingWhenHidden: false },
	);
	const messages = useMemo(() => [...(data?.items || [])].sort((a, b) => Number(a.id) - Number(b.id)), [data]);
	const scrollToLatest = useMemoizedFn(() => {
		atBottom.current = true;
		setHasNew(false);
		if (viewport.current) viewport.current.scrollTop = viewport.current.scrollHeight;
	});
	useLayoutEffect(() => {
		const lastID = messages.at(-1)?.id;
		if (atBottom.current) scrollToLatest();
		else if (previousLastID.current !== undefined && lastID !== previousLastID.current) setHasNew(true);
		previousLastID.current = lastID;
	}, [messages, scrollToLatest]);
	const sent = useMemoizedFn(() => {
		atBottom.current = true;
		// A failed refresh must not turn a successfully sent message into a send failure.
		void refreshAsync().catch(() => undefined);
	});
	const closeHistory = useMemoizedFn(() => setHistoryOpen(false));

	return (
		<section
			className="chat-pane"
			aria-label={`与${contactName(props.contact)}的会话`}
		>
			<div className="chat-header">
				<div className="chat-heading">
					<Avatar src={props.contact.avatar || DefaultAvatar} />
					<div className="contact-label">
						<strong className="contact-name">{contactName(props.contact)}</strong>
						<div className="contact-kind">{props.subtitle || `${contactKind(props.contact)} · 消息自动更新`}</div>
					</div>
				</div>
				<Space size={4}>
					<Button
						icon={<ReloadOutlined />}
						aria-label="刷新当前聊天"
						onClick={refresh}
						loading={loading}
					/>
					<Button
						icon={<HistoryOutlined />}
						onClick={() => setHistoryOpen(true)}
						disabled={props.busy}
					>
						历史记录
					</Button>
				</Space>
			</div>
			{error && (
				<Alert
					type="warning"
					title="聊天记录暂时无法更新"
					description="已显示的记录仍可查看，请稍后刷新。"
					action={
						<Button
							size="small"
							onClick={refresh}
						>
							重新加载
						</Button>
					}
				/>
			)}
			<div
				className="chat-messages"
				ref={viewport}
				role="log"
				aria-label="当前聊天消息"
				aria-live="off"
				onScroll={() => {
					const el = viewport.current;
					if (el) {
						atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
						if (atBottom.current) setHasNew(false);
					}
				}}
				onLoadCapture={() => {
					if (atBottom.current) scrollToLatest();
				}}
			>
				{Number(data?.total) > 50 && (
					<div style={{ textAlign: 'center', marginBottom: 18 }}>
						<Button
							type="link"
							disabled={props.busy}
							onClick={() => setHistoryOpen(true)}
						>
							查看更早的聊天记录
						</Button>
					</div>
				)}
				{!data && loading && <Spin style={{ display: 'block', margin: 24 }} />}
				{!loading && !error && !messages.length && (
					<Empty
						image={Empty.PRESENTED_IMAGE_SIMPLE}
						description="还没有聊天记录，发送一条消息开始聊天"
					/>
				)}
				{messages.map(item => {
					const outgoing = item.sender_wxid === props.robot.wechat_id;
					const name = outgoing
						? props.robot.nickname || '我'
						: item.sender_nickname || (item.is_chat_room ? item.sender_wxid : contactName(props.contact));
					const avatar = outgoing
						? props.robot.avatar
						: item.sender_avatar || (item.sender_wxid === props.contact.wechat_id ? props.contact.avatar : undefined);
					return (
						<article
							className={`chat-message${outgoing ? ' outgoing' : ''}`}
							key={item.id}
						>
							<Avatar
								src={avatar || DefaultAvatar}
								size={32}
								style={{ flexShrink: 0 }}
							/>
							<div className="message-main">
								<div className="message-meta">
									{name} · {dayjs(Number(item.created_at) * 1000).format('MM-DD HH:mm:ss')}
								</div>
								<div className="message-bubble">
									{item.is_recalled && <Tag color="default">已撤回</Tag>}
									<MessageContent
										robotId={props.robotId}
										message={item}
									/>
								</div>
							</div>
						</article>
					);
				})}
			</div>
			{hasNew && (
				<Button
					type="link"
					onClick={scrollToLatest}
				>
					有新消息，点击查看
				</Button>
			)}
			<Composer
				robotId={props.robotId}
				contact={props.contact}
				draft={props.draft}
				disabledReason={props.disabledReason}
				onDraftChange={props.onDraftChange}
				onBusyChange={props.onBusyChange}
				onSent={sent}
			/>
			{historyOpen && (
				<ChatHistory
					robotId={props.robotId}
					robot={props.robot}
					contact={props.contact}
					open
					title={`${contactName(props.contact)}的聊天记录`}
					onClose={closeHistory}
				/>
			)}
		</section>
	);
};

export default React.memo(ConversationPane);
