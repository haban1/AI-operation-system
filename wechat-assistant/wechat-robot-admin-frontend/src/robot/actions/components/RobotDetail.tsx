import {
	AliwangwangFilled,
	ClockCircleOutlined,
	DatabaseOutlined,
	DesktopOutlined,
	EnvironmentOutlined,
	FileTextFilled,
	FundFilled,
	IdcardOutlined,
	KeyOutlined,
	MacCommandFilled,
	OpenAIFilled,
	QrcodeOutlined,
	TagOutlined,
	UserOutlined,
	WechatFilled,
} from '@ant-design/icons';
import { useMemoizedFn, useRequest } from 'ahooks';
import { Alert, App, Avatar, Button, Col, Drawer, Row, Skeleton, Spin, Tabs, Tag } from 'antd';
import type { TabsProps } from 'antd';
import dayjs from 'dayjs';
import React, { Suspense, useEffect, useState } from 'react';
import MCPFilled from '@/icons/MCPFilled';
import MomentsFilled from '@/icons/MomentsFilled';
import OSSFilled from '@/icons/OSSFilled';
import SkillsFilled from '@/icons/SkillsFilled';
import TextKnowledgeFilled from '@/icons/TextKnowledgeFilled';
import GlobalSettings from '@/settings';
import Login from '../Login';
import Logout from '../Logout';
import RecreateRobotContainer from '../RecreateRobotContainer';
import Remove from '../Remove';
import RestartRobotContainer from '../RestartRobotContainer';
import EmbeddedDetailLayout from './EmbeddedDetailLayout';
import { BaseContainer, DrawerHeaderActions, DrawerHeaderTitle, LeftPanel } from './RobotDetail.styled';

interface IProps {
	robotId: number;
	open: boolean;
	embedded?: boolean;
	onListRefresh: () => void;
	onDetailRefresh: () => void;
	onClose: () => void;
	onModuleLoaded?: () => void;
}

const RobotList = React.lazy(() => import(/* webpackChunkName: "robot-list" */ '@/robot'));
const Contact = React.lazy(() => import(/* webpackChunkName: "contact" */ '@/contact'));
const CustomerSupport = React.lazy(() => import(/* webpackChunkName: "customer-support" */ '@/customer-support'));
const ContainerLog = React.lazy(() => import(/* webpackChunkName: "container-log" */ '@/container-log'));
const Moments = React.lazy(() => import(/* webpackChunkName: "moments" */ '@/moments'));
const SystemSettings = React.lazy(() => import(/* webpackChunkName: "system-settings" */ '@/system-settings'));
const KnowledgeBase = React.lazy(() => import(/* webpackChunkName: "knowledge-base" */ '@/knowledge-base'));
const MCPServers = React.lazy(() => import(/* webpackChunkName: "mcp-servers" */ '@/mcp-servers'));
const Skills = React.lazy(() => import(/* webpackChunkName: "skills" */ '@/skills'));
const OSSSettings = React.lazy(() => import(/* webpackChunkName: "oss-settings" */ '@/oss-settings'));
const SystemOverview = React.lazy(() => import(/* webpackChunkName: "system-overview" */ '@/system-overview'));
const SystemPrompts = React.lazy(() => import(/* webpackChunkName: "system-prompts" */ '@/system-prompts'));

const InfoRow = ({ icon, label, children }: { icon: React.ReactNode; label: string; children: React.ReactNode }) => (
	<div className="base-info-row">
		<div className="base-info-label">
			{icon}
			{label}
		</div>
		<div className="base-info-value ellipsis">{children}</div>
	</div>
);

const RobotDetail = (props: IProps) => {
	const { message } = App.useApp();

	const { open, onClose } = props;
	const [accountDetailsOpen, setAccountDetailsOpen] = useState(false);

	useEffect(() => {
		props.onModuleLoaded?.();
	}, []);

	const { data, loading, error, refresh } = useRequest(
		async () => {
			const resp = await window.wechatRobotClient.robot.viewList({
				id: props.robotId,
			});
			return resp.data?.data;
		},
		{
			manual: false,
			onError: reason => {
				message.error(reason.message);
			},
		},
	);

	const onRefresh = useMemoizedFn(() => {
		refresh();
		props.onDetailRefresh();
	});

	const onRemoveRefresh = useMemoizedFn(() => {
		props.onListRefresh();
		props.onClose();
	});

	if (!data) {
		if (error)
			return (
				<Alert
					type="error"
					title="微信账号信息加载失败"
					description={error.message}
					action={<Button onClick={refresh}>重试</Button>}
				/>
			);
		return (
			<Skeleton
				avatar
				active
				paragraph={{ rows: 4 }}
			/>
		);
	}

	const items: TabsProps['items'] = [
		{
			key: 'reception',
			label: '人工接待',
			icon: <UserOutlined />,
			children: (
				<Suspense fallback={<Spin />}>
					<CustomerSupport
						robotId={props.robotId}
						mode="reception"
					/>
				</Suspense>
			),
		},
		{
			key: 'broadcast',
			label: '好友群发',
			icon: <WechatFilled />,
			children: (
				<Suspense fallback={<Spin />}>
					<CustomerSupport
						robotId={props.robotId}
						mode="broadcast"
					/>
				</Suspense>
			),
		},
		{
			key: 'concact',
			icon: <WechatFilled />,
			label: '联系人',
			children: (
				<Contact
					robotId={props.robotId}
					robot={data}
				/>
			),
		},
		{
			key: 'moments',
			icon: <MomentsFilled />,
			label: '朋友圈',
			children: (
				<Suspense fallback={<Spin />}>
					<Moments
						robotId={props.robotId}
						robot={data}
					/>
				</Suspense>
			),
		},
		{
			key: 'global-settings',
			icon: <OpenAIFilled />,
			label: '回复设置',
			children: <GlobalSettings robotId={props.robotId} />,
		},
		{
			key: 'system-settings',
			icon: <MacCommandFilled />,
			label: '系统设置',
			children: (
				<Suspense fallback={<Spin />}>
					<SystemSettings robotId={props.robotId} />
				</Suspense>
			),
		},
		{
			key: 'system-prompts',
			icon: <AliwangwangFilled />,
			label: '人设管理',
			children: (
				<Suspense fallback={<Spin />}>
					<SystemPrompts robotId={props.robotId} />
				</Suspense>
			),
		},
		{
			key: 'text-knowledge-base',
			icon: <TextKnowledgeFilled />,
			label: '知识库',
			children: (
				<Suspense fallback={<Spin />}>
					<KnowledgeBase robotId={props.robotId} />
				</Suspense>
			),
		},
		{
			key: 'mcp-servers',
			icon: <MCPFilled />,
			label: 'MCP 服务',
			children: (
				<Suspense fallback={<Spin />}>
					<MCPServers robotId={props.robotId} />
				</Suspense>
			),
		},
		{
			key: 'skills',
			icon: <SkillsFilled />,
			label: '技能管理',
			children: (
				<Suspense fallback={<Spin />}>
					<Skills
						robotId={props.robotId}
						robot={data}
					/>
				</Suspense>
			),
		},
		{
			key: 'oss-settings',
			icon: <OSSFilled />,
			label: '文件存储',
			children: (
				<Suspense fallback={<Spin />}>
					<OSSSettings robotId={props.robotId} />
				</Suspense>
			),
		},
		{
			key: 'logs',
			icon: <FileTextFilled />,
			label: '运行日志',
			children: (
				<Suspense fallback={<Spin />}>
					<ContainerLog robotId={props.robotId} />
				</Suspense>
			),
		},
		{
			key: 'system-overview',
			icon: <FundFilled />,
			label: '服务概况',
			children: (
				<Suspense fallback={<Spin />}>
					<SystemOverview robotId={props.robotId} />
				</Suspense>
			),
		},
	];

	const mainKeys = ['reception', 'broadcast', 'concact', 'moments', 'system-prompts', 'text-knowledge-base'];
	const mainItems = mainKeys.map(key => items.find(item => item.key === key)!).filter(Boolean);
	const settingsItems = [
		{
			key: 'wechat-accounts',
			label: '微信账号',
			children: (
				<Suspense fallback={<Spin />}>
					<RobotList />
				</Suspense>
			),
		},
		...items.filter(item => !mainKeys.includes(item.key)),
	];
	const groupedItems = [
		...mainItems,
		{
			key: 'settings',
			label: '设置',
			children: (
				<Tabs
					className="wechat-settings-tabs"
					tabPlacement="start"
					destroyOnHidden
					items={settingsItems}
				/>
			),
		},
	];
	const DetailLayout = props.embedded ? EmbeddedDetailLayout : Drawer;

	return (
		<DetailLayout
			title={
				!props.embedded && (
					<DrawerHeaderTitle>
						<Avatar
							className="robot-detail-title-avatar"
							src={data.avatar}
						/>
						<div className="robot-detail-title-copy">
							<div className="ellipsis robot-detail-title-name">{data.nickname || data.wechat_id}</div>
							<Tag
								className={`robot-detail-title-status ${data.status === 'online' ? 'status-online' : 'status-offline'}`}
							>
								{data.status === 'online' ? '在线' : '离线'}
							</Tag>
						</div>
					</DrawerHeaderTitle>
				)
			}
			extra={
				<DrawerHeaderActions>
					<Button onClick={() => setAccountDetailsOpen(true)}>账号详情</Button>
					<details className="wechat-account-actions">
						<summary>账号操作</summary>
						<div className="account-action-list">
							{props.embedded &&
								(data.status === 'online' ? (
									<Logout
										robotId={data.id!}
										onRefresh={onRefresh}
									/>
								) : (
									<Login
										robotId={data.id!}
										robot={data}
										onRefresh={onRefresh}
									/>
								))}
							<RestartRobotContainer
								robotId={data.id!}
								robot={data}
								onRefresh={onRefresh}
							/>
							<RecreateRobotContainer
								robotId={data.id!}
								onRefresh={onRefresh}
							/>
							<Remove
								robotId={data.id!}
								robot={data}
								onRefresh={onRemoveRefresh}
								buttonText="删除机器人"
							/>
						</div>
					</details>
				</DrawerHeaderActions>
			}
			open={open}
			onClose={onClose}
			size="min(calc(100vw - 32px), max(calc(100vw - 300px), 750px))"
			styles={{
				header: {
					padding: '10px 16px',
					background: 'var(--ant-color-bg-container)',
					borderBottom: '1px solid var(--ant-color-border-secondary)',
					boxShadow: 'none',
				},
				body: { padding: 0 },
			}}
			footer={null}
		>
			<Row
				style={{ height: '100%' }}
				wrap={false}
			>
				<Col
					flex="1 1 auto"
					style={{
						position: 'relative',
						minWidth: 0,
						padding: '0',
					}}
				>
					<LeftPanel>
						<Tabs
							destroyOnHidden
							items={groupedItems}
							classNames={{
								header: 'tech-tabs-header',
								item: 'tech-tabs-item',
								indicator: 'tech-tabs-indicator',
								content: 'tech-tabs-content',
							}}
							styles={{ item: { borderRadius: 0 } }}
						/>
					</LeftPanel>
				</Col>
				<Drawer
					title="账号详情"
					open={accountDetailsOpen}
					onClose={() => setAccountDetailsOpen(false)}
					size={380}
					styles={{ body: { padding: 0 } }}
				>
					{loading ? (
						<Skeleton
							avatar
							active
							paragraph={{ rows: 4 }}
						/>
					) : (
						<BaseContainer>
							<div className="base-info-scroll">
								<div className="title">基本信息</div>

								<div className="base-info-header">
									<Avatar
										src={data.avatar}
										size={44}
									/>
									<div className="base-info-profile">
										<div className="ellipsis base-info-name">{data.nickname || data.wechat_id || '未命名'}</div>
										<div style={{ marginTop: 2 }}>
											{data.status === 'online' ? (
												<Tag className="base-info-status-tag status-online">在线</Tag>
											) : (
												<Tag className="base-info-status-tag status-offline">离线</Tag>
											)}
										</div>
									</div>
								</div>

								<div className="base-info-card">
									<div className="base-info-card-title">账号信息</div>
									<InfoRow
										icon={<WechatFilled />}
										label="微信号"
									>
										{data.wechat_id || <Tag color="default">未绑定</Tag>}
									</InfoRow>
									<InfoRow
										icon={<UserOutlined />}
										label="昵称"
									>
										{data.nickname || <Tag color="default">未绑定</Tag>}
									</InfoRow>
									<InfoRow
										icon={<IdcardOutlined />}
										label="归属人"
									>
										{data.owner}
									</InfoRow>
									<InfoRow
										icon={<ClockCircleOutlined />}
										label="上次登录"
									>
										{data.last_login_at ? (
											dayjs(data.last_login_at * 1000).format('YYYY-MM-DD HH:mm:ss')
										) : (
											<Tag color="default">未登录</Tag>
										)}
									</InfoRow>
								</div>

								<div className="base-info-card">
									<div className="base-info-card-title">设备信息</div>
									<InfoRow
										icon={<DesktopOutlined />}
										label="设备ID"
									>
										{data.device_id}
									</InfoRow>
									<InfoRow
										icon={<TagOutlined />}
										label="设备名称"
									>
										{data.device_name}
									</InfoRow>
									<InfoRow
										icon={<DesktopOutlined />}
										label="设备类型"
									>
										{data.device_type}
									</InfoRow>
									<InfoRow
										icon={<QrcodeOutlined />}
										label="微信版本"
									>
										{data.wechat_version}
									</InfoRow>
								</div>

								<div className="base-info-card">
									<div className="base-info-card-title">实例信息</div>
									<InfoRow
										icon={<KeyOutlined />}
										label="机器人ID"
									>
										{data.id}
									</InfoRow>
									<InfoRow
										icon={<QrcodeOutlined />}
										label="机器人编码"
									>
										{data.robot_code}
									</InfoRow>
									<InfoRow
										icon={<TagOutlined />}
										label="机器人名称"
									>
										{data.robot_name}
									</InfoRow>
									<InfoRow
										icon={<DatabaseOutlined />}
										label="RDS"
									>
										{data.redis_db}
									</InfoRow>
								</div>

								{!!data.proxy?.ProxyIp && (
									<div className="base-info-card">
										<div className="base-info-card-title">代理信息</div>
										<InfoRow
											icon={<EnvironmentOutlined />}
											label="代理 IP"
										>
											{data.proxy.ProxyIp}
										</InfoRow>
										<InfoRow
											icon={<EnvironmentOutlined />}
											label="代理用户"
										>
											{data.proxy.ProxyUser}
										</InfoRow>
										<InfoRow
											icon={<EnvironmentOutlined />}
											label="代理密码"
										>
											{data.proxy.ProxyPassword}
										</InfoRow>
									</div>
								)}

								<div className="base-info-card">
									<InfoRow
										icon={<ClockCircleOutlined />}
										label="创建时间"
									>
										{dayjs((data.created_at || 0) * 1000).format('YYYY-MM-DD HH:mm:ss')}
									</InfoRow>
								</div>
							</div>
						</BaseContainer>
					)}
				</Drawer>
			</Row>
		</DetailLayout>
	);
};

export default React.memo(RobotDetail);
