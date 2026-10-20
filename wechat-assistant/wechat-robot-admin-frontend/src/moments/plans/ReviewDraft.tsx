import { useMemoizedFn } from 'ahooks';
import { App, DatePicker, Form, Input, Modal, Typography } from 'antd';
import dayjs from 'dayjs';
import type { Dayjs } from 'dayjs';
import React, { useState } from 'react';
import type { MomentPlanJob } from '@/api/wechat-robot/wechat-robot';
import { visibilityLabels } from './shared';
interface IProps { robotId: number; job: MomentPlanJob; onClose: () => void; onSaved: () => void }
const ReviewDraft = (props: IProps) => {
	const { message } = App.useApp();
	const [busy, setBusy] = useState(false);
	const [form] = Form.useForm<{ content: string; at: Dayjs }>();
	const submit = useMemoizedFn(async () => {
		try {
			const values = await form.validateFields();
			if (values.at.unix() <= dayjs().unix()) { message.warning('请选择未来的发布时间'); return; }
			setBusy(true);
			await window.wechatRobotClient.moments.planJobsActionCreate({ id: props.robotId }, { job_id: props.job.id, action: 'approve', content: values.content, scheduled_at: values.at.unix() });
			message.success('审核通过，已安排发布'); props.onSaved();
		} catch (e) { if (e instanceof Error) message.error(e.message); } finally { setBusy(false); }
	});
	return <Modal open title="审核朋友圈文案" width={650} okText="审核通过并安排发布" onOk={submit} onCancel={props.onClose} confirmLoading={busy}>
		<Typography.Paragraph>可见范围：{visibilityLabels[props.job.payload.share_type]} · 附件 {props.job.payload.asset_ids?.length || 0} 个</Typography.Paragraph>
		{props.job.sources && <Typography.Paragraph type="secondary" style={{ whiteSpace: 'pre-wrap' }}>参考资料：{props.job.sources}</Typography.Paragraph>}
		<Form form={form} layout="vertical" disabled={busy} initialValues={{ content: props.job.payload.content, at: dayjs.unix(Math.max(props.job.scheduled_at, dayjs().add(5, 'minute').unix())) }}>
			<Form.Item label="待发布正文" name="content" rules={[{ required: true, whitespace: true, max: 2000 }]}><Input.TextArea rows={8} showCount maxLength={2000} /></Form.Item>
			<Form.Item label="确认发布时间" name="at" rules={[{ required: true }]} extra={`时区：${Intl.DateTimeFormat().resolvedOptions().timeZone}`}><DatePicker showTime format="YYYY-MM-DD HH:mm" style={{ width: '100%' }} /></Form.Item>
		</Form>
	</Modal>;
};
export default React.memo(ReviewDraft);
