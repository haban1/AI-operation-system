import { FileWordOutlined, GithubOutlined, LogoutOutlined, UserOutlined } from '@ant-design/icons';
import { useRequest } from 'ahooks';
import { Alert, App, Avatar, Button, Dropdown, Layout, Skeleton } from 'antd';
import type { MenuProps } from 'antd';
import React from 'react';
import { Outlet } from 'react-router-dom';
import styled from 'styled-components';
import logo from '../public/logo.svg';
import { UrlLogin } from './constant/redirect-url';
import { UserContext } from './context/user';
import { ThemeSwitch } from './theme-settings';
import { isEmbedded } from './utils/embedded';

const { Header } = Layout;

const rootStyle: React.CSSProperties = { minHeight: '100vh' };
const headerStyle: React.CSSProperties = {
	position: 'sticky',
	top: 0,
	zIndex: 100,
	width: '100%',
	display: 'flex',
	justifyContent: 'space-between',
	alignItems: 'center',
	paddingLeft: 20,
	paddingRight: 20,
	height: 60,
	lineHeight: '60px',
	background: 'var(--ant-color-bg-container)',
	borderBottom: '1px solid var(--ant-color-border-secondary)',
	boxShadow: 'none',
};

const Logo = styled.div`
	display: flex;
	align-items: center;
	gap: 10px;
	margin-right: 32px;
	cursor: default;
	user-select: none;

	.icon {
		width: 34px;
		height: 34px;
		border-radius: 8px;
		background: url('${logo}') center / contain no-repeat;
		flex-shrink: 0;
	}

	.title {
		color: var(--ant-color-text);
		font-weight: 550;
		font-size: 16px;
		letter-spacing: 0.5px;
		white-space: nowrap;

		@media (max-width: 639px) {
			display: none;
		}
	}
`;

const UserArea = styled.div`
	display: flex;
	align-items: center;
	gap: 10px;
	padding: 5px 10px;
	border-radius: 24px;
	cursor: pointer;

	.username {
		color: var(--ant-color-text-secondary);
		font-size: 14px;
		font-weight: 500;
		max-width: 120px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;

		@media (max-width: 1279px) {
			display: none;
		}
	}
`;

const HeaderActions = styled.div`
	display: flex;
	align-items: center;
	gap: 8px;
`;

const AppLayout = () => {
	const { message } = App.useApp();

	// 获取用户详情
	const {
		data: user,
		loading: userLoading,
		error,
		refresh,
	} = useRequest(
		async () => {
			const resp = await window.wechatRobotClient.user.selfList();
			return resp.data.data;
		},
		{
			manual: false,
			onError: reason => {
				message.error(reason.message);
			},
		},
	);

	// 用户登出
	const { runAsync: signOut } = useRequest(
		async () => {
			const resp = await window.wechatRobotClient.user.logoutDelete();
			return resp?.data;
		},
		{
			manual: true,
			onError: reason => {
				message.error(reason.message);
			},
		},
	);

	const items: MenuProps['items'] = [
		{
			key: 'docs',
			label: '使用文档',
			icon: <FileWordOutlined />,
			onClick: () => window.open('https://wechat-doc.houhoukang.com', '_blank'),
		},
		{
			key: 'github',
			label: 'GitHub',
			icon: <GithubOutlined />,
			onClick: () => window.open('https://github.com/hp0912/wechat-robot-client', '_blank'),
		},
		{ type: 'divider' },
		{
			key: 'signout',
			label: '登出',
			icon: <LogoutOutlined />,
			onClick: async () => {
				const resp = await signOut();
				window.location.href = `${UrlLogin}?login_method=${resp?.data?.login_method ?? 'scan'}&redirect=${encodeURIComponent(window.location.href)}`;
			},
		},
	];

	if (isEmbedded && error && !user) {
		return (
			<Alert
				type="error"
				title="微信助手暂时无法加载"
				description={error.message}
				action={<Button onClick={refresh}>重试</Button>}
			/>
		);
	}

	if (!user || userLoading) {
		return <Skeleton active />;
	}

	if (isEmbedded) {
		return (
			<UserContext.Provider value={{ user, signOut }}>
				<Layout style={rootStyle}>
					<Outlet />
				</Layout>
			</UserContext.Provider>
		);
	}

	return (
		<>
			<Layout style={rootStyle}>
				<Header style={headerStyle}>
					<div style={{ display: 'flex', alignItems: 'center' }}>
						<Logo>
							<div className="icon" />
							<div className="title">微信客服</div>
						</Logo>
					</div>
					<HeaderActions>
						<ThemeSwitch />
						<Dropdown
							menu={{ items }}
							placement="bottomRight"
						>
							<UserArea>
								<Avatar
									size={32}
									gap={4}
									src={user.avatar_url}
									alt={user.display_name}
									icon={<UserOutlined />}
									style={{ backgroundColor: 'var(--ant-color-primary-bg)', flexShrink: 0 }}
								/>
								<span className="username">{user.display_name}</span>
							</UserArea>
						</Dropdown>
					</HeaderActions>
				</Header>
				<Layout>
					<UserContext.Provider value={{ user: user, signOut }}>
						<Layout style={{ padding: '10px 10px 0 10px' }}>
							<Outlet />
						</Layout>
					</UserContext.Provider>
				</Layout>
			</Layout>
		</>
	);
};

export default React.memo(AppLayout);
