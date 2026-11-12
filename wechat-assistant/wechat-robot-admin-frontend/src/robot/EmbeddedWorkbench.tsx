import { ReloadOutlined } from '@ant-design/icons';
import { useBoolean, useRequest } from 'ahooks';
import { Alert, Button, Drawer, Empty, Flex, Select, Skeleton, Space, Tag } from 'antd';
import React, { Suspense, useState } from 'react';
import RobotList from './index';
import { loadRobotAccounts } from './load-robot-accounts';

const RobotDetail = React.lazy(() => import(/* webpackChunkName: "robot-detail" */ './actions/components/RobotDetail'));
const selectedRobotKey = 'tianhe-wechat-selected-robot';

const EmbeddedWorkbench = () => {
	const [selectedId, setSelectedId] = useState(() => Number(localStorage.getItem(selectedRobotKey)) || undefined);
	const [managementOpen, setManagementOpen] = useBoolean(false);
	const { data, loading, error, refresh } = useRequest(
		() =>
			loadRobotAccounts(async query => {
				const response = await window.wechatRobotClient.robot.listList(query);
				return response.data.data || {};
			}),
		{ pollingInterval: 30000, pollingWhenHidden: false },
	);
	const robots = data || [];
	const robot =
		robots.find(item => item.id === selectedId) || robots.find(item => item.status === 'online') || robots[0];

	if (!data && loading) return <Skeleton active />;
	if (!data && error)
		return (
			<Alert
				type="error"
				title="微信助手暂时无法加载"
				description={error.message}
				action={<Button onClick={refresh}>重试</Button>}
			/>
		);

	return (
		<section
			className="embedded-workbench"
			aria-label="微信客服操作面板"
		>
			<Flex
				justify="space-between"
				align="center"
				wrap
				gap={12}
				className="wx-account-toolbar"
			>
				<Space>
					<span className="wx-account-caption">当前账号</span>
					{robots.length > 0 && (
						<Select
							aria-label="选择微信账号"
							value={robot?.id}
							style={{ minWidth: 180 }}
							options={robots.map(item => ({
								value: item.id,
								label: item.nickname || item.robot_name || item.wechat_id || String(item.id),
							}))}
							onChange={value => {
								setSelectedId(value);
								localStorage.setItem(selectedRobotKey, String(value));
							}}
						/>
					)}
					{robot && (
						<Tag
							color={robot.status === 'online' ? 'success' : 'warning'}
							role="status"
							aria-label="微信连接状态"
						>
							{robot.status === 'online' ? '微信在线' : '微信离线'}
						</Tag>
					)}
				</Space>
				<Space>
					<Button
						icon={<ReloadOutlined />}
						onClick={refresh}
						loading={loading}
					>
						刷新
					</Button>
					<Button onClick={setManagementOpen.setTrue}>账号管理</Button>
				</Space>
			</Flex>
			{error && (
				<Alert
					type="warning"
					title={`刷新失败：${error.message}`}
				/>
			)}
			{robot?.id ? (
				<Suspense fallback={<Skeleton active />}>
					<RobotDetail
						key={robot.id}
						robotId={robot.id}
						embedded
						open
						onListRefresh={refresh}
						onDetailRefresh={refresh}
						onClose={refresh}
					/>
				</Suspense>
			) : (
				<Empty
					style={{ padding: 48 }}
					description="暂无微信账号，请在账号管理中添加机器人。"
				/>
			)}
			{managementOpen && (
				<Drawer
					title="微信账号管理"
					open
					onClose={() => {
						setManagementOpen.setFalse();
						refresh();
					}}
					size="large"
				>
					<RobotList />
				</Drawer>
			)}
		</section>
	);
};

export default React.memo(EmbeddedWorkbench);
