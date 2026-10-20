import { useMemoizedFn, useRequest } from 'ahooks';
import { Alert, App, Button, Modal, Space, Table, Tabs, Tag, Typography } from 'antd';
import React, { useState } from 'react';
import type { MomentPlan, MomentPlanCreate, MomentPlanJob } from '@/api/wechat-robot/wechat-robot';
import PlanEditor from './PlanEditor';
import ReviewDraft from './ReviewDraft';
import { cancellable, jobLabels, pendingKey, planLabels, repeatLabels, timestamp, visibilityLabels } from './shared';
interface IProps { robotId: number; onClose: () => void }

const PlanWorkspace = (props: IProps) => {
	const { message, modal } = App.useApp();
	const [editor, setEditor] = useState<'manual' | 'ai'>();
	const [review, setReview] = useState<MomentPlanJob>();
	const [tab, setTab] = useState('plans');
	const [working, setWorking] = useState(false);
	const readPending = () => { try { return JSON.parse(localStorage.getItem(pendingKey(props.robotId)) || 'null') as MomentPlanCreate | null; } catch { return null; } };
	const [pending, setPending] = useState(readPending);
	const { data, loading, refresh } = useRequest(async () => (await window.wechatRobotClient.moments.plansList({ id: props.robotId })).data.data, { pollingInterval: 15000, refreshDeps: [props.robotId], onError: e => message.error(e.message) });
	const closeEditor = useMemoizedFn(() => { setEditor(undefined); setPending(readPending()); refresh(); });
	const saved = useMemoizedFn(() => { closeEditor(); setTab('jobs'); });
	const closeReview = useMemoizedFn(() => setReview(undefined));
	const reviewSaved = useMemoizedFn(() => { setReview(undefined); refresh(); });
	const actPlan = useMemoizedFn((plan: MomentPlan, action: string) => {
		modal.confirm({ title: `${{ pause: '暂停', resume: '恢复', cancel: '取消' }[action]}计划“${plan.name}”？`, content: action === 'resume' ? '将从下一个计划时间继续，不补发已取消的任务。' : '尚未发布的文案和任务也会取消，已发布的朋友圈保留。', onOk: async () => { await window.wechatRobotClient.moments.plansActionCreate({ id: props.robotId }, { plan_id: plan.id, action }); refresh(); } });
	});
	const cancelJob = useMemoizedFn((job: MomentPlanJob) => modal.confirm({ title: '取消这次发布任务？', content: '周期计划的后续任务仍会继续。', onOk: async () => { await window.wechatRobotClient.moments.planJobsActionCreate({ id: props.robotId }, { job_id: job.id, action: 'cancel', content: '', scheduled_at: 0 }); refresh(); } }));
	const recoverPending = useMemoizedFn(async () => {
		if (!pending) return; setWorking(true);
		try { await window.wechatRobotClient.moments.plansCreate({ id: props.robotId }, pending); localStorage.removeItem(pendingKey(props.robotId)); setPending(null); refresh(); message.success('本次提交已确认'); } catch (e) { message.error((e as Error).message); } finally { setWorking(false); }
	});
	const forgetPending = useMemoizedFn(() => modal.confirm({ title: '已核对计划列表，清除本次提交记录？', content: '此操作只清除浏览器中的提交记录，不会取消服务器上的计划。', onOk: () => { localStorage.removeItem(pendingKey(props.robotId)); setPending(null); } }));
	const jobTable = (onlyReview = false) => <Table<MomentPlanJob> rowKey="id" size="small" loading={loading} dataSource={data?.jobs.filter(j => !onlyReview || j.status === 'awaiting_review')} pagination={{ pageSize: 10 }} scroll={{ x: 850 }} columns={[
		{ title: '计划 / 发布时间', width: 200, render: (_, j) => <><div>{j.plan_name}</div><Typography.Text type="secondary">{timestamp(j.scheduled_at)}</Typography.Text></> },
		{ title: '文案 / 结果', render: (_, j) => <Space orientation="vertical" style={{ width: '100%' }}><Typography.Paragraph style={{ whiteSpace: 'pre-wrap', margin: 0 }} ellipsis={{ rows: 3, expandable: true }}>{j.payload.content || '等待生成文案'}</Typography.Paragraph><Typography.Text type="secondary">{visibilityLabels[j.payload.share_type]} · {j.payload.asset_ids?.length || 0} 个附件</Typography.Text>{j.error && <Typography.Text type="danger">{j.error}</Typography.Text>}{j.moment_id && <Typography.Text type="secondary">朋友圈编号：{j.moment_id}</Typography.Text>}</Space> },
		{ title: '状态', width: 140, render: (_, j) => <Tag color={j.status === 'published' ? 'green' : j.status === 'awaiting_review' ? 'orange' : j.status === 'uncertain' || j.status === 'failed' ? 'red' : 'default'}>{jobLabels[j.status] || j.status}</Tag> },
		{ title: '操作', width: 160, render: (_, j) => <Space wrap>{j.status === 'awaiting_review' && <Button size="small" type="primary" onClick={() => setReview(j)}>审核文案</Button>}{cancellable.includes(j.status) && <Button size="small" danger onClick={() => cancelJob(j)}>取消任务</Button>}</Space> },
	]} />;
	return <Modal open title="朋友圈发布计划" width="min(1150px, calc(100vw - 32px))" footer={null} onCancel={props.onClose} styles={{ body: { maxHeight: '78vh', overflowY: 'auto' } }}>
		<Space orientation="vertical" size="middle" style={{ width: '100%' }}>
			<Space wrap><Button type="primary" disabled={!!pending} onClick={() => setEditor('manual')}>新建定时发布</Button><Button disabled={!!pending} onClick={() => setEditor('ai')}>新建 AI 内容计划</Button><Button onClick={refresh}>刷新记录</Button></Space>
			{pending && <Alert type="warning" showIcon title={`上次提交“${pending.name}”尚待确认`} description={<Space wrap><Button loading={working} onClick={recoverPending}>核对并恢复本次提交</Button><Button onClick={forgetPending}>已核对，清除提交记录</Button></Space>} />}
			<Alert type="info" showIcon title="审核文案需确认后才会发布；自动发布按计划执行。" description="机器人离线时等待恢复，超过计划时间1小时不补发。发布结果未确认时不会自动重试，周期计划会暂停。显示最近200条计划和执行记录。" />
			<Tabs activeKey={tab} onChange={setTab} items={[
				{ key: 'plans', label: '发布计划', children: <Table<MomentPlan> rowKey="id" size="small" loading={loading} dataSource={data?.plans} pagination={{ pageSize: 10 }} scroll={{ x: 850 }} columns={[
					{ title: '计划', width: 210, render: (_, p) => <><div>{p.name}</div><Typography.Text type="secondary">{p.kind === 'ai' ? 'AI 内容计划' : '定时发布'} · {repeatLabels[p.repeat]}</Typography.Text></> },
					{ title: '发布规则', render: (_, p) => <><div>{p.publish_mode === 'review' ? '审核后发布' : '自动发布'} · {visibilityLabels[p.payload.share_type]}</div><Typography.Text type="secondary">{p.topic || p.payload.content.slice(0, 70) || '附件内容'}</Typography.Text></> },
					{ title: '下次时间', width: 200, render: (_, p) => <>{timestamp(p.next_run_at)}<div><Typography.Text type="secondary">{p.timezone}</Typography.Text></div></> },
					{ title: '状态', width: 150, render: (_, p) => <Tag>{planLabels[p.status] || p.status}</Tag> },
					{ title: '操作', width: 150, render: (_, p) => <Space wrap>{p.status === 'active' && <Button size="small" onClick={() => actPlan(p, 'pause')}>暂停</Button>}{p.status === 'paused' && p.repeat !== 'once' && <Button size="small" onClick={() => actPlan(p, 'resume')}>恢复</Button>}{p.status !== 'cancelled' && <Button danger size="small" onClick={() => actPlan(p, 'cancel')}>取消计划</Button>}</Space> },
				]} /> },
				{ key: 'review', label: `待审核（${data?.jobs.filter(j => j.status === 'awaiting_review').length || 0}）`, children: jobTable(true) },
				{ key: 'jobs', label: '执行记录', children: jobTable() },
			]} />
		</Space>
		{editor && <PlanEditor robotId={props.robotId} kind={editor} categories={data?.categories || []} onClose={closeEditor} onSaved={saved} />}
		{review && <ReviewDraft robotId={props.robotId} job={review} onClose={closeReview} onSaved={reviewSaved} />}
	</Modal>;
};
export default React.memo(PlanWorkspace);
