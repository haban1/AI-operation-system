import { useMemoizedFn, useRequest } from 'ahooks';
import { Alert, App, DatePicker, Form, Input, Modal, Select, Space, Typography, Upload } from 'antd';
import type { UploadFile } from 'antd';
import dayjs from 'dayjs';
import type { Dayjs } from 'dayjs';
import React, { useRef, useState } from 'react';
import type { MomentPlanCreate, MomentPlanSnapshot } from '@/api/wechat-robot/wechat-robot';
import { newRequestID, pendingKey, repeatLabels, visibilityLabels } from './shared';

interface IProps {
	robotId: number;
	kind: 'manual' | 'ai';
	categories: MomentPlanSnapshot['categories'];
	onClose: () => void;
	onSaved: () => void;
}
interface IValues {
	name: string;
	content?: string;
	topic?: string;
	instructions?: string;
	knowledge_codes?: string[];
	publish_mode: string;
	repeat: string;
	at: Dayjs;
	share_type: string;
	share_with?: string[];
	donot_share?: string[];
	with_user_list?: string[];
}

const PlanEditor = (props: IProps) => {
	const { message } = App.useApp();
	const [form] = Form.useForm<IValues>();
	const [files, setFiles] = useState<UploadFile[]>([]);
	const [busy, setBusy] = useState(false);
	const [submitted, setSubmitted] = useState(false);
	const locked = useRef(false);
	const shareType = Form.useWatch('share_type', form);
	const publishMode = Form.useWatch('publish_mode', form);
	const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai';
	const { data: contacts, run: findContacts, loading } = useRequest(async (keyword = '') => {
		const resp = await window.wechatRobotClient.contact.listList({ id: props.robotId, keyword, type: 'friend', page_index: 1, page_size: 50 });
		return resp.data.data?.items || [];
	}, { debounceWait: 300, onError: e => message.error(e.message) });
	const contactOptions = contacts?.map(c => ({ value: c.wechat_id, label: c.remark || c.nickname || c.wechat_id }));
	const contactSelect = <Select mode="multiple" loading={loading} placeholder="搜索并选择好友" showSearch={{ filterOption: false, onSearch: findContacts }} options={contactOptions} />;
	const save = useMemoizedFn(async () => {
		if (locked.current) return;
		try {
			const values = await form.validateFields();
			if (values.at.unix() <= dayjs().unix()) { message.warning('请选择未来的发布时间'); return; }
			if (props.kind === 'manual' && !values.content?.trim() && !files.length) { message.warning('请填写正文或添加附件'); return; }
			const videos = files.filter(f => f.type?.startsWith('video/'));
			if ((videos.length && files.length !== 1) || files.length > 9 || files.reduce((n, f) => n + (f.size || 0), 0) > 40 * 1024 * 1024) { message.warning('最多9张图片或1个视频，附件合计不超过40MB'); return; }
			locked.current = true; setBusy(true);
			const assetIDs: string[] = [];
			for (const f of files) {
				const file = f.originFileObj;
				if (!file) throw new Error('附件无法读取，请重新选择');
				const response = await window.wechatRobotClient.moments.planAssetsCreate({ id: props.robotId }, { media: file });
				assetIDs.push(response.data.data.id);
			}
			const body: MomentPlanCreate = {
				id: newRequestID(), name: values.name.trim(), kind: props.kind, topic: values.topic || '', instructions: values.instructions || '',
				knowledge_codes: values.knowledge_codes || [], publish_mode: props.kind === 'manual' ? 'auto' : values.publish_mode,
				repeat: props.kind === 'manual' ? 'once' : values.repeat, timezone, first_run_at: values.at.unix(),
				payload: { content: values.content || '', asset_ids: assetIDs, share_type: values.share_type, share_with: values.share_type === 'share_with' ? values.share_with || [] : [], donot_share: values.share_type === 'donot_share' ? values.donot_share || [] : [], with_user_list: values.with_user_list || [] },
			};
			// Persist before submitting so a refresh or a lost response cannot create a second plan.
			localStorage.setItem(pendingKey(props.robotId), JSON.stringify(body));
			setSubmitted(true);
			await window.wechatRobotClient.moments.plansCreate({ id: props.robotId }, body);
			localStorage.removeItem(pendingKey(props.robotId));
			message.success(props.kind === 'ai' ? '内容计划已创建，首次文案即将生成' : '定时发布已保存');
			props.onSaved();
		} catch (e) {
			if (e instanceof Error) message.error(e.message);
			if (!localStorage.getItem(pendingKey(props.robotId))) locked.current = false;
		} finally { setBusy(false); }
	});
	return <Modal title={props.kind === 'ai' ? '新建 AI 内容计划' : '新建定时发布'} open width={650} okText="保存计划" onOk={save} onCancel={props.onClose} confirmLoading={busy} okButtonProps={{ disabled: submitted }} styles={{ body: { maxHeight: '70vh', overflowY: 'auto' } }}>
		{submitted && <Alert type="info" showIcon title="已提交请求；如未确认成功，请关闭此窗口，在计划列表核对或恢复本次提交。" />}
		<Form form={form} layout="vertical" disabled={busy || submitted} initialValues={{ publish_mode: 'review', repeat: 'once', share_type: 'public', at: dayjs().add(1, 'hour').second(0) }}>
			<Form.Item label="计划名称" name="name" rules={[{ required: true, whitespace: true, max: 100 }]}><Input maxLength={100} placeholder="例如：每周社区服务介绍" /></Form.Item>
			{props.kind === 'ai' ? <>
				<Form.Item label="内容主题" name="topic" rules={[{ required: true, whitespace: true, max: 500 }]}><Input.TextArea rows={2} maxLength={500} placeholder="例如：介绍社区提供的企业服务" /></Form.Item>
				<Form.Item label="参考知识库" name="knowledge_codes" extra="沿用微信模块的原生知识库。不选择时按主题创作；选择后未检索到资料会停止生成。"><Select mode="multiple" options={props.categories.map(c => ({ value: c.code, label: c.name }))} placeholder="可选择一个或多个知识库" /></Form.Item>
				<Form.Item label="写作要求" name="instructions"><Input.TextArea rows={3} maxLength={2000} placeholder="例如：语气亲切，150字以内，结尾邀请咨询" /></Form.Item>
				<Form.Item label="发布方式" name="publish_mode"><Select options={[{ value: 'review', label: '生成后由我审核，再按确认时间发布' }, { value: 'auto', label: '自动生成并按计划直接发布' }]} /></Form.Item>
				{publishMode === 'auto' && <Alert type="info" showIcon title="保存后将按计划生成文案，并在所选可见范围内自动发布。" style={{ marginBottom: 16 }} />}
				<Form.Item label="执行频率" name="repeat"><Select options={Object.entries(repeatLabels).map(([value, label]) => ({ value, label }))} /></Form.Item>
			</> : <Form.Item label="朋友圈正文" name="content" rules={[{ max: 2000 }]}><Input.TextArea rows={5} maxLength={2000} showCount placeholder="说点什么吧……" /></Form.Item>}
			<Form.Item label={props.kind === 'ai' ? '首次发布时间' : '发布时间'} name="at" rules={[{ required: true }]} extra={`时区：${timezone}。每天/每周沿用首次时间；待审核文案不会自动发布。`}><DatePicker showTime format="YYYY-MM-DD HH:mm" style={{ width: '100%' }} /></Form.Item>
			<Form.Item label="配图或视频" extra="最多9张图片（每张10MB）或1个视频（30MB），合计40MB。周期计划会重复使用这些附件。">
				<Upload fileList={files} multiple accept="image/jpeg,image/png,image/gif,image/webp,video/mp4,video/quicktime" beforeUpload={file => {
					if (file.size > (file.type.startsWith('video/') ? 30 : 10) * 1024 * 1024) { message.error('附件超过大小限制'); return Upload.LIST_IGNORE; }
					return false;
				}} onChange={info => setFiles(info.fileList)}><a>选择附件</a></Upload>
			</Form.Item>
			<Form.Item label="谁可以看" name="share_type"><Select options={Object.entries(visibilityLabels).map(([value, label]) => ({ value, label }))} /></Form.Item>
			{shareType === 'share_with' && <Form.Item label="可见好友" name="share_with" rules={[{ required: true }]}>{contactSelect}</Form.Item>}
			{shareType === 'donot_share' && <Form.Item label="不可见好友" name="donot_share" rules={[{ required: true }]}>{contactSelect}</Form.Item>}
			<Form.Item label="提醒谁看" name="with_user_list">{contactSelect}</Form.Item>
			<Space orientation="vertical"><Typography.Text type="secondary">附件将在发布时上传。机器人需在线；超过计划时间1小时的任务不会补发。</Typography.Text>{props.kind === 'ai' && <Typography.Text type="secondary">AI 沿用天河统一模型配置。首次文案立即进入生成队列；后续审核文案提前一天生成，自动发布文案提前30分钟生成。</Typography.Text>}</Space>
		</Form>
	</Modal>;
};
export default React.memo(PlanEditor);
