import { useMemoizedFn } from 'ahooks';
import { Alert, App, Button, Card, Checkbox, Col, Drawer, Input, Row, Space, Typography } from 'antd';
import React, { useEffect, useRef, useState } from 'react';
import BroadcastRecords from './BroadcastRecords';
import type { Snapshot } from './types';
import { friendName } from './types';

interface IProps {
	robotId: number;
	data: Snapshot;
	onRefresh: () => void;
}
const requestID = () => {
	if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
	return Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join('');
};
const Broadcast = (props: IProps) => {
	const { message, modal } = App.useApp();
	const storageKey = `robot-broadcast-${props.robotId}`;
	const [pending, setPending] = useState(() => {
		try {
			return localStorage.getItem(storageKey) || '';
		} catch {
			return '';
		}
	});
	const [recipients, setRecipients] = useState<string[]>([]);
	const [recordsOpen, setRecordsOpen] = useState(false);
	const [recipientSearch, setRecipientSearch] = useState('');
	const [content, setContent] = useState('');
	const [images, setImages] = useState<File[]>([]);
	const [previews, setPreviews] = useState<string[]>([]);
	const [confirmed, setConfirmed] = useState(false);
	const [busy, setBusy] = useState(false);
	const submitting = useRef(false);
	useEffect(() => {
		const urls = images.map(file => URL.createObjectURL(file));
		setPreviews(urls);
		return () => urls.forEach(url => URL.revokeObjectURL(url));
	}, [images]);
	const selectImages = useMemoizedFn((event: React.ChangeEvent<HTMLInputElement>) => {
		const files = Array.from(event.target.files || []);
		event.target.value = '';
		if (!files.length) return;
		if (images.length + files.length > 3) {
			message.error('一次最多选择 3 张图片，请先移除不需要的图片。');
			return;
		}
		if (files.some(file => !file.size || file.size > 10 * 1024 * 1024)) {
			message.error('每张图片不能为空且不能超过 10 MB');
			return;
		}
		if (files.some(file => !['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(file.type))) {
			message.error('请选择 PNG、JPEG、GIF 或 WebP 图片');
			return;
		}
		setImages(current => [...current, ...files]);
		setConfirmed(false);
	});
	const send = useMemoizedFn(() => {
		if (pending || submitting.current) return;
		if (!recipients.length || (!content.trim() && !images.length) || !confirmed) {
			message.warning('请选择好友、填写内容，并勾选发送确认。');
			return;
		}
		modal.confirm({
			title: `确认向 ${recipients.length} 位好友群发？`,
			content: `${images.length ? `每位好友将收到 ${images.length} 张图片。` : ''}发送后无法撤回整个群发任务，请核对所选好友和内容。`,
			onOk: async () => {
				if (submitting.current) return;
				submitting.current = true;
				setBusy(true);
				const id = requestID();
				setPending(id);
				try {
					localStorage.setItem(storageKey, id);
				} catch {
					/* Storage may be disabled. */
				}
				try {
					await window.wechatRobotClient.support.broadcastsCreate(
						{ id: props.robotId },
						{
							client_request_id: id,
							recipients: JSON.stringify(recipients),
							confirm_send: 'true',
							content: content.trim(),
							image: images[0],
							image2: images[1],
							image3: images[2],
						},
					);
					message.success('群发任务已提交');
				} catch (e) {
					message.error(`${(e as Error).message}。请先核对群发记录，不要重复提交。`);
				} finally {
					setBusy(false);
					props.onRefresh();
				}
			},
		});
	});
	const next = useMemoizedFn(() =>
		modal.confirm({
			title: '已核对记录，开始另一条群发？',
			content: '结果未确认的任务，请先在微信中核对，避免重复发送。',
			onOk: () => {
				try {
					localStorage.removeItem(storageKey);
				} catch {
					/* Storage may be disabled. */
				}
				setPending('');
				submitting.current = false;
				setConfirmed(false);
			},
		}),
	);
	return (
		<div className="wx-page wx-broadcast">
			<div className="wx-page-toolbar">
				<span />
				<Button onClick={() => setRecordsOpen(true)}>群发记录</Button>
			</div>
			{pending && (
				<Alert
					type="warning"
					showIcon
					title="本次提交已锁定，请先核对群发记录。刷新页面不会重复发送。"
				/>
			)}
			<Row gutter={[16, 16]}>
				<Col
					xs={24}
					lg={14}
				>
					<Card title="编辑消息">
						<Space
							orientation="vertical"
							style={{ width: '100%' }}
						>
							<Input.TextArea
								aria-label="群发文字"
								rows={6}
								maxLength={2000}
								showCount
								value={content}
								disabled={!!pending}
								onChange={e => {
									setContent(e.target.value);
									setConfirmed(false);
								}}
								placeholder="输入文字，也可以只发送图片"
							/>
							<label className="wx-upload">
								添加图片（选填）<small>最多 3 张，每张不超过 10 MB</small>
								<input
									aria-label="群发图片"
									type="file"
									multiple
									accept="image/png,image/jpeg,image/gif,image/webp"
									disabled={!!pending || images.length >= 3}
									onChange={selectImages}
								/>
							</label>
							<Typography.Text type="secondary">
								已选 {images.length}/3 张。先发送文字，再按下方顺序逐张发送图片。
							</Typography.Text>
							<details
								className="wx-send-preview"
								open={images.length > 0 || undefined}
							>
								<summary>发送预览</summary>
								<Typography.Paragraph style={{ whiteSpace: 'pre-wrap' }}>
									{content || (images.length ? '（仅图片）' : '（尚未填写内容）')}
								</Typography.Paragraph>
								<Space
									wrap
									align="start"
								>
									{images.map((file, index) => (
										<Space
											key={previews[index] || index}
											orientation="vertical"
											style={{ maxWidth: 180 }}
										>
											{previews[index] && (
												<img
													src={previews[index]}
													alt={`群发图片预览 ${index + 1}`}
													style={{ maxWidth: '100%', height: 140, objectFit: 'contain' }}
												/>
											)}
											<Typography.Text
												ellipsis
												title={file.name}
												style={{ maxWidth: 180 }}
											>
												{index + 1}. {file.name}
											</Typography.Text>
											<Button
												size="small"
												disabled={!!pending}
												aria-label={`移除第 ${index + 1} 张图片`}
												onClick={() => {
													setImages(current => current.filter((_, i) => i !== index));
													setConfirmed(false);
												}}
											>
												移除图片
											</Button>
										</Space>
									))}
								</Space>
							</details>
							<Checkbox
								checked={confirmed}
								disabled={!!pending}
								onChange={e => setConfirmed(e.target.checked)}
							>
								我已核对好友和内容，确认发送
							</Checkbox>
							<Space>
								<Button
									type="primary"
									loading={busy}
									disabled={!!pending}
									onClick={send}
								>
									确认群发
								</Button>
								{pending && (
									<Button
										disabled={busy}
										onClick={next}
									>
										开始另一条群发
									</Button>
								)}
							</Space>
						</Space>
					</Card>
				</Col>
				<Col
					xs={24}
					lg={10}
				>
					<Card title="选择接收人">
						<Input
							aria-label="搜索群发好友"
							placeholder="搜索昵称或备注"
							value={recipientSearch}
							onChange={e => setRecipientSearch(e.target.value)}
						/>
						<Space className="wx-recipient-select">
							<Checkbox
								disabled={!!pending}
								checked={!!props.data.friends.length && recipients.length === props.data.friends.length}
								indeterminate={!!recipients.length && recipients.length < props.data.friends.length}
								onChange={e => {
									setRecipients(e.target.checked ? props.data.friends.map(f => f.wechat_id) : []);
									setConfirmed(false);
								}}
							>
								全选
							</Checkbox>
							<Button
								type="text"
								disabled={!!pending}
								onClick={() => {
									setRecipients([]);
									setConfirmed(false);
								}}
							>
								清空
							</Button>
							<span>已选 {recipients.length} 人</span>
						</Space>
						<div className="wx-recipient-list">
							{props.data.friends
								.filter(f => friendName(f).includes(recipientSearch))
								.map(f => (
									<label
										className="wx-recipient"
										key={f.wechat_id}
									>
										<Checkbox
											disabled={!!pending}
											checked={recipients.includes(f.wechat_id)}
											onChange={e => {
												setRecipients(current =>
													e.target.checked ? [...current, f.wechat_id] : current.filter(id => id !== f.wechat_id),
												);
												setConfirmed(false);
											}}
										/>
										<span className="wx-avatar">{friendName(f).slice(0, 1)}</span>
										<strong>{friendName(f)}</strong>
									</label>
								))}
						</div>
					</Card>
				</Col>
			</Row>
			{recordsOpen && (
				<Drawer
					title="群发记录"
					open
					onClose={() => setRecordsOpen(false)}
					size={850}
				>
					<BroadcastRecords
						robotId={props.robotId}
						jobs={props.data.broadcasts}
						pending={pending}
						onRefresh={props.onRefresh}
					/>
				</Drawer>
			)}
		</div>
	);
};
export default React.memo(Broadcast);
