import { robotUrl } from '@/utils/embedded';
import { useMemoizedFn, useRequest } from 'ahooks';
import {
	Alert,
	Avatar,
	Button,
	Card,
	Descriptions,
	Drawer,
	Image,
	Input,
	Space,
	Spin,
	Table,
	Tag,
	Typography,
} from 'antd';
import React, { useState } from 'react';
import type { SupportBroadcastDetail, SupportDelivery } from '@/api/wechat-robot/wechat-robot';
import { DefaultAvatar } from '@/constant';
import { broadcastLabels, timestamp } from './types';

interface IProps {
	robotId: number;
	jobId: string;
	onClose: () => void;
}
interface IImageProps {
	robotId: number;
	jobId: string;
	position: number;
}
type Job = NonNullable<SupportBroadcastDetail['job']>;

const imageCount = (job: Job) => job.image_count || (job.has_image ? 1 : 0);
const sentImages = (result?: SupportDelivery) => result?.images_sent ?? (result?.image_sent ? 1 : 0);
const deliveryState = (job: Job, result?: SupportDelivery) => {
	if (result?.error) return { text: '发送异常', color: 'error' };
	if (result && (!job.content || result.text_sent) && sentImages(result) >= imageCount(job))
		return { text: '已发送', color: 'success' };
	if (job.status === 'pending') return { text: '等待发送', color: 'default' };
	if (job.status === 'running') return { text: result ? '发送中' : '发送中／等待发送', color: 'processing' };
	return { text: '结果待核对', color: 'warning' };
};

const BroadcastImage = React.memo((props: IImageProps) => {
	const [failed, setFailed] = useState(false);
	const [attempt, setAttempt] = useState(0);
	const retry = useMemoizedFn(() => {
		setFailed(false);
		setAttempt(value => value + 1);
	});
	const onError = useMemoizedFn(() => setFailed(true));
	// Authenticated image route documented in Swagger; the browser supplies the session cookie.
	const query = new URLSearchParams({
		id: String(props.robotId),
		broadcast_id: props.jobId,
		position: String(props.position),
		retry: String(attempt),
	});
	return (
		<Space
			orientation="vertical"
			size="small"
		>
			<Typography.Text>第 {props.position} 张</Typography.Text>
			{failed ? (
				<Space orientation="vertical">
					<Typography.Text type="secondary">图片暂时无法加载</Typography.Text>
					<Button onClick={retry}>重新加载图片</Button>
				</Space>
			) : (
				<Image
					key={attempt}
					src={robotUrl(`/api/v1/support/broadcasts/image?${query}`)}
					alt={`群发记录图片 ${props.position}`}
					width={180}
					height={150}
					styles={{ image: { objectFit: 'contain' } }}
					onError={onError}
				/>
			)}
		</Space>
	);
});
BroadcastImage.displayName = 'BroadcastImage';

const BroadcastDetail = (props: IProps) => {
	const [keyword, setKeyword] = useState('');
	const { data, error, loading, refresh } = useRequest(
		async () => {
			const response = await window.wechatRobotClient.support.broadcastsDetailList({
				id: props.robotId,
				broadcast_id: props.jobId,
			});
			const detail = response.data.data;
			if (detail?.job?.id !== props.jobId) throw new Error('群发记录不存在或加载失败');
			return detail;
		},
		{ pollingInterval: 8000, pollingWhenHidden: false },
	);
	const job = data?.job;
	const friends = new Map((data?.friends || []).map(friend => [friend.wechat_id, friend]));
	const results = new Map((job?.results || []).map(result => [result.peer, result]));
	const rows = (job?.recipients || [])
		.map(peer => {
			const friend = friends.get(peer);
			return {
				peer,
				name: friend?.remark || friend?.nickname || peer,
				nickname: friend?.nickname,
				avatar: friend?.avatar,
				result: results.get(peer),
			};
		})
		.filter(row =>
			`${row.name} ${row.nickname || ''} ${row.peer}`.toLowerCase().includes(keyword.trim().toLowerCase()),
		);
	return (
		<Drawer
			open
			title="群发记录详情"
			size="min(960px, 96vw)"
			onClose={props.onClose}
			extra={
				<Button
					loading={loading}
					onClick={refresh}
				>
					刷新详情
				</Button>
			}
		>
			{error && (
				<Alert
					type="error"
					showIcon
					title={data ? '详情刷新失败，以下为上次加载的记录' : '群发详情加载失败'}
					description={error.message}
					action={<Button onClick={refresh}>重试</Button>}
					style={{ marginBottom: 16 }}
				/>
			)}
			{!data && loading && <Spin />}
			{job && (
				<Space
					orientation="vertical"
					size="middle"
					style={{ width: '100%' }}
				>
					<Descriptions
						column={{ xs: 1, sm: 2 }}
						items={[
							{
								key: 'status',
								label: '任务状态',
								children: <Tag>{broadcastLabels[job.status || ''] || job.status}</Tag>,
							},
							{
								key: 'count',
								label: '发送统计',
								children: `共 ${job.recipients?.length || 0} 人 · 成功 ${job.success_count || 0} 人 · 失败 ${job.failed_count || 0} 人`,
							},
							{ key: 'created', label: '创建时间', children: timestamp(job.created_at || 0) },
							{ key: 'updated', label: '更新时间', children: timestamp(job.updated_at || 0) },
							{
								key: 'id',
								label: '任务编号',
								span: 2,
								children: (
									<Typography.Text
										copyable
										style={{ overflowWrap: 'anywhere' }}
									>
										{job.id}
									</Typography.Text>
								),
							},
						]}
					/>
					{job.status === 'interrupted' && (
						<Alert
							type="warning"
							showIcon
							title="任务已中断，未记录的发送结果需要在微信中核对。"
						/>
					)}
					<Card
						size="small"
						title="发送内容"
					>
						<Typography.Paragraph style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
							{job.content || '（仅图片消息）'}
						</Typography.Paragraph>
						{imageCount(job) > 0 && (
							<Image.PreviewGroup>
								<Space
									wrap
									align="start"
								>
									{Array.from({ length: Math.min(3, imageCount(job)) }, (_, index) => (
										<BroadcastImage
											key={index}
											robotId={props.robotId}
											jobId={props.jobId}
											position={index + 1}
										/>
									))}
								</Space>
							</Image.PreviewGroup>
						)}
					</Card>
					<Card
						size="small"
						title="接收好友与发送结果"
						extra={<Typography.Text type="secondary">每 8 秒刷新</Typography.Text>}
					>
						<Input.Search
							aria-label="搜索群发接收好友"
							placeholder="搜索好友昵称、备注或微信账号"
							value={keyword}
							onChange={event => setKeyword(event.target.value)}
							allowClear
							style={{ maxWidth: 360, marginBottom: 12 }}
						/>
						<Table
							rowKey="peer"
							size="small"
							dataSource={rows}
							pagination={{ pageSize: 10, showSizeChanger: false, showTotal: total => `共 ${total} 人` }}
							scroll={{ x: 700 }}
							columns={[
								{
									title: '好友',
									key: 'friend',
									width: 220,
									render: (_, row) => (
										<Space align="start">
											<Avatar src={row.avatar || DefaultAvatar} />
											<div>
												<div>{row.name}</div>
												<Typography.Text
													type="secondary"
													style={{ fontSize: 12, overflowWrap: 'anywhere' }}
												>
													{row.peer}
												</Typography.Text>
											</div>
										</Space>
									),
								},
								{
									title: '状态',
									key: 'status',
									width: 155,
									render: (_, row) => {
										const state = deliveryState(job, row.result);
										return <Tag color={state.color}>{state.text}</Tag>;
									},
								},
								{
									title: '文字',
									key: 'text',
									width: 110,
									render: (_, row) => (!job.content ? '—' : row.result?.text_sent ? '已发送' : '未确认发送'),
								},
								{
									title: '图片',
									key: 'images',
									width: 100,
									render: (_, row) => (imageCount(job) ? `${sentImages(row.result)}/${imageCount(job)} 张已发送` : '—'),
								},
								{
									title: '说明',
									key: 'error',
									render: (_, row) =>
										row.result?.error ||
										(deliveryState(job, row.result).text === '结果待核对' ? '没有完整发送结果，请核对微信记录' : '—'),
								},
							]}
						/>
					</Card>
				</Space>
			)}
		</Drawer>
	);
};

export default React.memo(BroadcastDetail);
