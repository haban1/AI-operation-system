import { useMemoizedFn } from 'ahooks';
import { Alert, App, Avatar, Button, Drawer, Empty, Form, Input, Select, Space, Tag } from 'antd';
import React, { useRef, useState } from 'react';
import type { ChatDraft, ChatRobot } from '@/chat/conversation/types';
import ReceptionConversation from './ReceptionConversation';
import type { Reception as ReceptionItem, Snapshot } from './types';
import { friendName, timestamp } from './types';

interface IProps {
	robotId: number;
	robot: ChatRobot;
	data: Snapshot;
	onRefresh: () => void;
}

const Reception = (props: IProps) => {
	const { message, modal } = App.useApp();
	const [busy, setBusy] = useState(false);
	const [peer, setPeer] = useState<string>();
	const [selectedKey, setSelectedKey] = useState<string>();
	const [keyword, setKeyword] = useState('');
	const [settingsOpen, setSettingsOpen] = useState(false);
	const [drafts, setDrafts] = useState<Record<string, ChatDraft>>({});
	const [sendingReception, setSendingReception] = useState<ReceptionItem>();
	const [transitioning, setTransitioning] = useState(false);
	const sending = useRef(false);
	const options = props.data.friends.map(f => ({ value: f.wechat_id, label: friendName(f) }));
	const name = (id: string) => friendName(props.data.friends.find(f => f.wechat_id === id) || { wechat_id: id });
	const queue = props.data.receptions.filter(item => `${name(item.peer)} ${item.last_message}`.includes(keyword));
	const selected = sendingReception || queue.find(item => item.key === selectedKey) || queue[0];
	const onBusyChange = useMemoizedFn((value: boolean) => {
		sending.current = value;
		setSendingReception(value ? selected : undefined);
	});
	const onDraftChange = useMemoizedFn((key: string, patch: Partial<ChatDraft>) => {
		setDrafts(previous => ({ ...previous, [key]: { ...(previous[key] || { text: '' }), ...patch } }));
	});
	const disabledReason = transitioning
		? '正在更新接待状态，请稍候。'
		: props.robot.status !== 'online'
			? '微信当前离线，请重新登录后发送。'
			: selected && !props.data.receptions.some(item => item.key === selected.key)
				? '该会话已结束人工接待，请重新接管后发送。'
				: undefined;
	const save = useMemoizedFn(async (values: { notifier?: string; knowledge_codes?: string[] }) => {
		setBusy(true);
		try {
			await window.wechatRobotClient.support.settingsCreate(
				{ id: props.robotId },
				{ notifier: values.notifier || '', knowledge_codes: values.knowledge_codes || [] },
			);
			message.success('设置已保存');
			props.onRefresh();
		} catch (e) {
			message.error((e as Error).message);
		} finally {
			setBusy(false);
		}
	});
	const transition = useMemoizedFn((id: string, room: string, active: boolean) => {
		if (sending.current || transitioning) return;
		modal.confirm({
			title: active ? '确认由人工接待？' : '确认恢复 AI 回复？',
			content: active
				? '该会话的 AI 自动回复将暂停，可在当前窗口发送文字和图片。'
				: '后续新消息恢复 AI 回复，接管前未完成的回答不会补发。',
			onOk: async () => {
				if (sending.current) throw new Error('消息正在发送，请稍候');
				setTransitioning(true);
				try {
					const response = await window.wechatRobotClient.support.receptionCreate(
						{ id: props.robotId },
						{ peer: id, room, active, reason: active ? '后台人工接管' : '' },
					);
					if (response.data.code !== 200) throw new Error(response.data.message || '接待状态更新失败');
					message.success(active ? '已进入人工接待' : '已恢复 AI');
					props.onRefresh();
				} finally {
					setTransitioning(false);
				}
			},
		});
	});
	return (
		<div className="wx-page wx-reception">
			<div className="wx-page-toolbar">
				<span className="wx-muted">{props.data.receptions.length} 个接待会话</span>
				<Space>
					<Button onClick={props.onRefresh}>刷新</Button>
					<Button onClick={() => setSettingsOpen(true)}>接待设置</Button>
				</Space>
			</div>
			<div className="wx-chat-shell">
				<aside className="wx-chat-list">
					<div className="wx-chat-search">
						<Input
							aria-label="搜索接待会话"
							placeholder="搜索会话"
							value={keyword}
							disabled={!!sendingReception || transitioning}
							onChange={event => setKeyword(event.target.value)}
						/>
					</div>
					{queue.map(item => (
						<button
							type="button"
							className={`wx-conversation ${item.key === selected?.key ? 'active' : ''}`}
							key={item.key}
							disabled={!!sendingReception || transitioning}
							onClick={() => {
								if (!sending.current) setSelectedKey(item.key);
							}}
						>
							<Avatar src={props.data.friends.find(friend => friend.wechat_id === item.peer)?.avatar}>
								{name(item.peer).slice(0, 1)}
							</Avatar>
							<span>
								<strong>
									{name(item.peer)}
									{item.room ? ' · 群聊' : ''}
								</strong>
								<small>{timestamp(item.updated_at)}</small>
								<p>{item.last_message || '暂无新消息'}</p>
							</span>
						</button>
					))}
					{!queue.length && (
						<Empty
							image={Empty.PRESENTED_IMAGE_SIMPLE}
							description="暂无人工接待会话"
						/>
					)}
				</aside>
				<section className="wx-chat-main">
					<header className="wx-chat-heading">
						<strong>人工接待</strong>
						{selected && (
							<Space>
								<Tag>人工接待中</Tag>
								<Button
									type="text"
									disabled={!!sendingReception || transitioning}
									onClick={() => transition(selected.peer, selected.room, false)}
								>
									恢复 AI 回复
								</Button>
							</Space>
						)}
					</header>
					{selected ? (
						<ReceptionConversation
							key={`${props.robotId}:${selected.key}`}
							robotId={props.robotId}
							robot={props.robot}
							reception={selected}
							data={props.data}
							draft={drafts[selected.key] || { text: '' }}
							busy={!!sendingReception || transitioning}
							disabledReason={disabledReason}
							onDraftChange={onDraftChange}
							onBusyChange={onBusyChange}
						/>
					) : (
						<div className="wx-chat-history">
							<Empty description="暂无人工接待会话，好友聊天请在“联系人”中查看。" />
						</div>
					)}
					<footer className="wx-chat-footer">
						<span>在上方输入文字或添加图片发送。人工接待期间 AI 暂停回复，完成后可恢复 AI。</span>
						{selected && (
							<>
								<details className="wx-inline-details">
									<summary>接待详情</summary>
									<p>{selected.reason}</p>
									<p>
										{selected.peer}
										{selected.room ? ` · 群聊 ${selected.room}` : ''}
									</p>
								</details>
								{selected.notification_error && (
									<Alert
										type="warning"
										title={selected.notification_error}
									/>
								)}
							</>
						)}
						<details className="wx-inline-details">
							<summary>主动接管</summary>
							<Space wrap>
								<Select
									aria-label="主动接管好友"
									style={{ minWidth: 230 }}
									showSearch={{ optionFilterProp: 'label' }}
									options={options}
									value={peer}
									onChange={setPeer}
									placeholder="选择好友"
								/>
								<Button
									disabled={!peer || !!sendingReception || transitioning}
									onClick={() => peer && transition(peer, '', true)}
								>
									人工接管
								</Button>
							</Space>
						</details>
					</footer>
				</section>
			</div>
			{settingsOpen && (
				<Drawer
					title="接待设置"
					open
					onClose={() => setSettingsOpen(false)}
					size={460}
				>
					<Form
						layout="vertical"
						initialValues={props.data.settings}
						onFinish={save}
					>
						<Form.Item
							label="接待通知人"
							name="notifier"
						>
							<Select
								allowClear
								showSearch={{ optionFilterProp: 'label' }}
								options={options}
								placeholder="不发送通知"
							/>
						</Form.Item>
						<Form.Item
							label="默认问答知识库"
							name="knowledge_codes"
							extra="私聊使用此知识库；群聊优先使用自己的绑定。资料在知识库页管理。"
						>
							<Select
								mode="multiple"
								options={props.data.categories.map(c => ({ value: c.code, label: c.name }))}
								placeholder="请选择知识库"
							/>
						</Form.Item>
						<Button
							type="primary"
							htmlType="submit"
							loading={busy}
						>
							保存设置
						</Button>
					</Form>
				</Drawer>
			)}
		</div>
	);
};

export default React.memo(Reception);
