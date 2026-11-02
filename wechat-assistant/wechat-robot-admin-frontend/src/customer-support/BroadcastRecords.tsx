import { useMemoizedFn } from 'ahooks';
import { Alert, Button, Card, Empty, Space, Tag, Typography } from 'antd';
import React, { useState } from 'react';
import BroadcastDetail from './BroadcastDetail';
import type { Broadcast } from './types';
import { broadcastLabels, timestamp } from './types';

interface IProps {
	robotId: number;
	jobs: Broadcast[];
	pending: string;
	onRefresh: () => void;
}

const BroadcastRecords = (props: IProps) => {
	const [selected, setSelected] = useState<string>();
	const close = useMemoizedFn(() => setSelected(undefined));
	const open = useMemoizedFn((id: string) => setSelected(id));
	return (
		<>
			<Card
				title="最近群发记录"
				extra={<Button onClick={props.onRefresh}>刷新记录</Button>}
			>
				{!props.jobs.length && <Empty description="暂无群发记录" />}
				{props.jobs.map(job => (
					<Card
						key={job.id}
						size="small"
						hoverable
						onClick={() => open(job.id)}
						style={{ marginBottom: 12, cursor: 'pointer' }}
						title={
							<Space wrap>
								<Tag>{broadcastLabels[job.status] || job.status}</Tag>
								<span>{timestamp(job.created_at)}</span>
							</Space>
						}
						extra={
							<Button
								type="link"
								aria-label={`查看群发详情 ${job.id}`}
								onClick={event => {
									event.stopPropagation();
									open(job.id);
								}}
							>
								查看详情
							</Button>
						}
					>
						<Typography.Paragraph
							ellipsis={{ rows: 2 }}
							style={{ whiteSpace: 'pre-wrap' }}
						>
							{job.content || '（图片消息）'}
							{job.has_image ? ` · ${job.image_count || 1} 张图片` : ''}
						</Typography.Paragraph>
						<Typography.Paragraph>
							已选 {job.recipients.length} 人 · 成功 {job.success_count} 人 · 失败 {job.failed_count} 人
						</Typography.Paragraph>
						{job.status === 'interrupted' && (
							<Alert
								type="warning"
								title="任务执行中断，部分发送结果可能未记录。请核对微信，不会自动重发。"
							/>
						)}
						<Typography.Text type="secondary">
							任务 {job.id}
							{job.id === props.pending ? ' · 本次提交' : ''}
						</Typography.Text>
					</Card>
				))}
			</Card>
			{selected && (
				<BroadcastDetail
					key={selected}
					robotId={props.robotId}
					jobId={selected}
					onClose={close}
				/>
			)}
		</>
	);
};

export default React.memo(BroadcastRecords);
