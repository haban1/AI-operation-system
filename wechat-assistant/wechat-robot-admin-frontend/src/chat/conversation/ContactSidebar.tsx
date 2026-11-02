import { SearchOutlined } from '@ant-design/icons';
import { useRequest, useSetState } from 'ahooks';
import { Alert, Avatar, Button, Empty, Input, Pagination, Spin } from 'antd';
import React from 'react';
import { DefaultAvatar } from '@/constant';
import type { ChatContact } from './types';
import { contactKind, contactName } from './types';

interface IProps {
	robotId: number;
	contact: ChatContact;
	busy: boolean;
	onSelect: (contact: ChatContact) => void;
}

const ContactSidebar = (props: IProps) => {
	const [search, setSearch] = useSetState({ keyword: '', page: 1 });
	const { data, loading, error, refresh } = useRequest(
		async () => {
			const response = await window.wechatRobotClient.contact.listList({
				id: props.robotId,
				keyword: search.keyword,
				page_index: search.page,
				page_size: 20,
			});
			return response.data.data;
		},
		{ refreshDeps: [search.keyword, search.page], debounceWait: 250 },
	);
	// Do not show results from the previous search while a new search is loading.
	const results = loading ? [] : (data?.items || []).filter(item => item.wechat_id);
	const choices =
		!search.keyword && !results.some(item => item.wechat_id === props.contact.wechat_id)
			? [props.contact, ...results]
			: results;

	return (
		<aside
			className="contact-sidebar"
			aria-label="聊天联系人"
		>
			<div className="contact-search">
				<Input
					prefix={<SearchOutlined />}
					aria-label="搜索聊天联系人"
					placeholder="搜索联系人或群聊"
					allowClear
					value={search.keyword}
					onChange={event => setSearch({ keyword: event.target.value, page: 1 })}
				/>
			</div>
			{error && (
				<Alert
					type="error"
					title="联系人加载失败"
					action={
						<Button
							size="small"
							onClick={refresh}
						>
							重试
						</Button>
					}
				/>
			)}
			<div className="contact-list">
				{loading && <Spin size="small" />}
				{choices.map(contact => (
					<button
						type="button"
						className="contact-choice"
						key={contact.wechat_id}
						aria-current={contact.wechat_id === props.contact.wechat_id}
						aria-label={`与${contactName(contact)}聊天`}
						disabled={props.busy}
						onClick={() => props.onSelect(contact)}
					>
						<Avatar
							src={contact.avatar || DefaultAvatar}
							size={34}
							style={{ flexShrink: 0 }}
						/>
						<div className="contact-label">
							<div className="contact-name">{contactName(contact)}</div>
							<div className="contact-kind">{contactKind(contact)}</div>
						</div>
					</button>
				))}
				{!loading && !choices.length && (
					<Empty
						image={Empty.PRESENTED_IMAGE_SIMPLE}
						description="没有找到联系人"
					/>
				)}
			</div>
			{Number(data?.total) > 20 && (
				<Pagination
					simple
					size="small"
					current={search.page}
					pageSize={20}
					total={data?.total}
					showSizeChanger={false}
					onChange={page => setSearch({ page })}
					style={{ padding: 10, textAlign: 'center' }}
				/>
			)}
		</aside>
	);
};

export default React.memo(ContactSidebar);
