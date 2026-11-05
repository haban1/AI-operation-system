import { robotUrl } from '@/utils/embedded';
import { useMemoizedFn, useRequest, useSetState } from 'ahooks';
import { Alert, Avatar, Button, Col, Drawer, Empty, List, Row, Spin } from 'antd';
import dayjs from 'dayjs';
import React, { useRef } from 'react';
import type * as Api from '@/api/wechat-robot/wechat-robot';
import type { DtoSnsObject as SnsObject } from '@/api/wechat-robot/wechat-robot';
import { DefaultAvatar } from '@/constant';
import MediaList, { MediaVideo } from './MediaList';
import SpecifiContactMomentDetail from './SpecifiContactMomentDetail';
import { Container } from './styled';

interface IProps {
	open?: boolean;
	robotId: number;
	robot: NonNullable<Api.Robot.ViewList.ResponseBody['data']>;
	contactAvatar?: string;
	contactId?: string;
	contactName?: string;
	onClose: () => void;
}

interface IState {
	done: boolean;
	frist_page_md5: string;
	max_id: string;
	moments: SnsObject[];
	tips: string[];
}

const SpecifiContactMomentList = (props: IProps) => {
	// frist_page_md5 单词拼写原本是协议拼错了
	const [prevState, setPrevState] = useSetState<IState>({
		done: false,
		frist_page_md5: '',
		max_id: '0',
		moments: [],
		tips: [],
	});
	const [momentDetailState, setMomentDetailState] = useSetState<{ open: boolean; momentId?: string }>({ open: false });
	const busy = useRef(false);

	const {
		run: loadPage,
		loading: getLoading,
		error,
		params,
	} = useRequest(
		async (reset = false) => {
			if (busy.current) return;
			busy.current = true;
			try {
				const cursor = reset ? '0' : prevState.max_id;
				const resp = await window.wechatRobotClient.moments.getDetailList({
					id: props.robotId,
					Towxid: props.contactId!,
					Fristpagemd5: reset ? '' : prevState.frist_page_md5,
					Maxid: cursor,
				});
				const page = resp.data.data;
				if (!page) throw new Error('朋友圈数据加载失败，请重试');
				const items = (page.ObjectList || []).filter(item => !!item?.IdStr);
				const moments = new Map((reset ? [] : prevState.moments).map(item => [item.IdStr!, item]));
				items.forEach(item => moments.set(item.IdStr!, item));
				const nextCursor = items[items.length - 1]?.IdStr;
				setPrevState({
					moments: [...moments.values()],
					max_id: nextCursor || cursor,
					frist_page_md5: page.FristPageMd5 || (reset ? '' : prevState.frist_page_md5),
					done: !nextCursor || nextCursor === cursor,
					tips: [...new Set([...(reset ? [] : prevState.tips), ...(page.RetTips || []).filter(tip => tip.trim())])],
				});
			} finally {
				busy.current = false;
			}
		},
		{ manual: false },
	);

	const onDetailRefresh = useMemoizedFn(() => {
		if (!busy.current) loadPage(true);
	});
	const onLoadMore = useMemoizedFn(() => {
		if (!busy.current) loadPage(false);
	});
	const onRetry = useMemoizedFn(() => {
		if (!busy.current) loadPage(params[0]);
	});

	const onDetailClose = useMemoizedFn(() => {
		setMomentDetailState({ open: false, momentId: undefined });
	});

	return (
		<Drawer
			title={
				<Row
					align="middle"
					wrap={false}
				>
					<Col flex="0 0 32px">
						<Avatar src={props.contactAvatar || DefaultAvatar} />
					</Col>
					<Col
						flex="0 1 auto"
						className="ellipsis"
						style={{ padding: '0 3px' }}
					>
						{props.contactName}的朋友圈
					</Col>
				</Row>
			}
			size="min(99vw, 80vw)"
			open={props.open}
			onClose={props.onClose}
			footer={null}
			extra={
				<Button
					loading={getLoading}
					onClick={onDetailRefresh}
				>
					刷新
				</Button>
			}
		>
			<Container>
				{prevState.tips.length > 0 && (
					<Alert
						type="info"
						showIcon
						title={prevState.tips.join('；')}
						style={{ marginBottom: 12 }}
					/>
				)}
				{error && (
					<Alert
						type="error"
						showIcon
						title="朋友圈加载失败"
						description={error.message}
						action={
							<Button
								loading={getLoading}
								onClick={onRetry}
							>
								重试
							</Button>
						}
						style={{ marginBottom: 12 }}
					/>
				)}
				{!prevState.moments.length && getLoading ? (
					<Spin spinning={getLoading} />
				) : (
					<div
						id="specifi-moments-list"
						style={{
							position: 'relative',
							height: 'calc(100vh - 115px)',
							overflowY: 'auto',
							border: '1px solid rgba(5,5,5,0.06)',
							borderRadius: 4,
							marginRight: 2,
						}}
					>
						<List
							rowKey="IdStr"
							itemLayout="horizontal"
							split={false}
							dataSource={prevState.moments || []}
							locale={{ emptyText: error ? '暂时无法加载朋友圈，请重试' : <Empty description="暂无可见的朋友圈" /> }}
							renderItem={item => {
								const media = item.TimelineObject?.ContentObject?.MediaList?.Media;
								const momentLocation = item.TimelineObject?.Location;

								return (
									<List.Item
										onClick={() => {
											setMomentDetailState({ open: true, momentId: item.IdStr! });
										}}
									>
										<Row
											align="top"
											wrap={false}
											style={{ padding: '0 16px' }}
											gutter={[8, 8]}
										>
											<Col flex="0 0 125px">
												<p style={{ margin: 0 }}>
													<b>{dayjs(item.CreateTime! * 1000).format('YYYY年M月D日')}</b>
												</p>
												<p style={{ margin: 0 }}>
													<span style={{ fontSize: 12, color: '#3a3a3a' }}>
														{dayjs(item.CreateTime! * 1000).format('HH:mm')}
													</span>
												</p>
												{(momentLocation?.PoiName || momentLocation?.City || momentLocation?.PoiAddress) && (
													<p style={{ marginTop: 16 }}>
														<span className="moment-location">
															{momentLocation?.PoiName || momentLocation?.City || momentLocation?.PoiAddress}
														</span>
													</p>
												)}
											</Col>
											<Col
												flex="0 0 528px"
												style={{ backgroundColor: '#eeeeee' }}
												onClick={ev => ev.stopPropagation()}
											>
												{Array.isArray(media) ? (
													<>
														{media.length === 1 && Number(media[0].Type) === 6 ? (
															<MediaVideo
																dataSource={media[0]}
																videoDownloadUrl={robotUrl(`/api/v1/moments/down-media?id=${props.robotId}&url=${encodeURIComponent(media[0]!.URL!.Value!)}`)}
															/>
														) : (
															<MediaList
																className="moment-media-list"
																dataSource={media}
															/>
														)}
													</>
												) : null}
											</Col>
											<Col flex="1 1 auto">
												{!!item.TimelineObject?.ContentDesc && (
													<pre className="moment-content">{item.TimelineObject.ContentDesc}</pre>
												)}
											</Col>
										</Row>
									</List.Item>
								);
							}}
						/>
						{!error && prevState.moments.length > 0 && (
							<div style={{ padding: 16, textAlign: 'center' }}>
								{prevState.done ? (
									'已显示全部可见的朋友圈'
								) : (
									<Button
										loading={getLoading}
										onClick={onLoadMore}
									>
										加载更多
									</Button>
								)}
							</div>
						)}
						{momentDetailState.open && (
							<SpecifiContactMomentDetail
								open={momentDetailState.open}
								robotId={props.robotId}
								robot={props.robot}
								contactAvatar={props.contactAvatar}
								contactId={props.contactId}
								contactName={props.contactName}
								momentId={momentDetailState.momentId!}
								onRefresh={onDetailRefresh}
								onClose={onDetailClose}
							/>
						)}
					</div>
				)}
			</Container>
		</Drawer>
	);
};

export default React.memo(SpecifiContactMomentList);
