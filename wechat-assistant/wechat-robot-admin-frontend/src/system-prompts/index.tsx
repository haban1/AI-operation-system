import { PlusOutlined } from '@ant-design/icons';
import { useBoolean, useRequest, useSetState } from 'ahooks';
import { App, Button, Card, Empty, Input, Spin } from 'antd';
import dayjs from 'dayjs';
import React, { useState } from 'react';
import SystemPromptActions from './SystemPromptActions';
import SystemPromptEditor from './SystemPromptEditor';

interface IProps {
	className?: string;
	style?: React.CSSProperties;
	robotId: number;
}

interface IState {
	keyword: string;
}

const SystemPrompts = (props: IProps) => {
	const { className = '', style = {} } = props;

	const { message } = App.useApp();

	const [searchState, setSearchState] = useSetState<IState>({ keyword: '' });
	const [onNewOpen, setOnNewOpen] = useBoolean(false);
	const [selectedId, setSelectedId] = useState<number>();

	const {
		data = [],
		loading,
		refresh,
	} = useRequest(
		async () => {
			const resp = await window.wechatRobotClient.systemPrompts.systemPromptsList({
				id: props.robotId,
				keyword: searchState.keyword,
			});
			return resp.data?.data || [];
		},
		{
			manual: false,
			refreshDeps: [props.robotId, searchState.keyword],
			onError: reason => {
				message.error(reason.message);
			},
		},
	);

	const selected = data.find(item => item.id === selectedId) || data[0];
	return (
		<Spin spinning={loading}>
			<div
				className={`wx-page wx-personas ${className}`}
				style={style}
			>
				<div className="wx-page-toolbar">
					<Input.Search
						allowClear
						placeholder="搜索人设"
						style={{ width: 260 }}
						onSearch={keyword => setSearchState({ keyword })}
					/>
					<Button
						type="primary"
						icon={<PlusOutlined />}
						onClick={setOnNewOpen.setTrue}
					>
						新建人设
					</Button>
				</div>
				{selected ? (
					<div className="wx-persona-grid">
						<Card
							title={selected.title}
							extra={
								<SystemPromptActions
									robotId={props.robotId}
									dataSource={selected}
									onRefresh={refresh}
								/>
							}
						>
							<div className="wx-persona-copy">{selected.content}</div>
							<div className="wx-persona-meta">
								更新于 {dayjs(Number(selected.updated_at) * 1000).format('YYYY-MM-DD HH:mm')}
								<details className="wx-inline-details">
									<summary>创建信息</summary>
									{dayjs(Number(selected.created_at) * 1000).format('YYYY-MM-DD HH:mm:ss')}
								</details>
							</div>
						</Card>
						<Card title="人设列表">
							<div className="wx-persona-list">
								{data.map(item => (
									<button
										type="button"
										className={item.id === selected.id ? 'active' : ''}
										key={item.id}
										onClick={() => setSelectedId(item.id)}
									>
										<strong>{item.title}</strong>
										<p>{item.content}</p>
									</button>
								))}
							</div>
						</Card>
					</div>
				) : (
					<Empty description="暂无人设" />
				)}
				{onNewOpen && (
					<SystemPromptEditor
						open={onNewOpen}
						robotId={props.robotId}
						onClose={setOnNewOpen.setFalse}
						onRefresh={refresh}
					/>
				)}
			</div>
		</Spin>
	);
};

export default React.memo(SystemPrompts);
