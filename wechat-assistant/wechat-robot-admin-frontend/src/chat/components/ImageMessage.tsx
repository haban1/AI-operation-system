import {
	DownloadOutlined,
	EyeOutlined,
	RotateLeftOutlined,
	RotateRightOutlined,
	SwapOutlined,
	UndoOutlined,
	ZoomInOutlined,
	ZoomOutOutlined,
} from '@ant-design/icons';
import { useMemoizedFn } from 'ahooks';
import { Button, Image, Space } from 'antd';
import React, { useState } from 'react';
import type * as Api from '@/api/wechat-robot/wechat-robot';
import { useAttachDownload } from '@/hooks';

interface IProps {
	robotId: number;
	message: NonNullable<NonNullable<Api.Chat.HistoryList.ResponseBody['data']>['items']>[number];
}

const ImageMessage = (props: IProps) => {
	const { onAttachDownload: onDownload } = useAttachDownload('image', props.robotId, props.message.id!);
	const [failed, setFailed] = useState(false);
	const [useSavedImage, setUseSavedImage] = useState(false);
	const [attempt, setAttempt] = useState(0);
	const onError = useMemoizedFn(() => {
		if (props.message.attachment_url && !useSavedImage) {
			setUseSavedImage(true);
			return;
		}
		setFailed(true);
	});
	const onRetry = useMemoizedFn(() => {
		setAttempt(value => value + 1);
		setFailed(false);
	});

	const url =
		(!useSavedImage && props.message.attachment_url) ||
		`/api/v1/chat/image/download?id=${props.robotId}&message_id=${props.message.id}&retry=${attempt}`;

	if (failed) {
		return (
			<Space
				orientation="vertical"
				size={0}
				role="status"
			>
				<span>图片暂时无法加载，可能未保存或已过期。</span>
				<Button
					type="link"
					size="small"
					onClick={onRetry}
				>
					重新加载图片
				</Button>
			</Space>
		);
	}

	return (
		<Image
			key={`${url}-${attempt}`}
			placeholder
			onError={onError}
			styles={{
				image: {
					maxHeight: 300,
					width: 'auto',
					maxWidth: '100%',
				},
			}}
			src={url}
			alt={props.message.display_full_content || '图片消息'}
			preview={{
				mask: true,
				cover: (
					<span style={{ color: '#fff' }}>
						<EyeOutlined style={{ marginRight: 8 }} />
						<span>点击查看大图</span>
					</span>
				),
				actionsRender: (
					_,
					{
						transform: { scale },
						actions: { onFlipY, onFlipX, onRotateLeft, onRotateRight, onZoomOut, onZoomIn, onReset },
					},
				) => (
					<Space
						size={12}
						className="toolbar-wrapper"
					>
						<DownloadOutlined onClick={onDownload} />
						<SwapOutlined
							rotate={90}
							onClick={onFlipY}
						/>
						<SwapOutlined onClick={onFlipX} />
						<RotateLeftOutlined onClick={onRotateLeft} />
						<RotateRightOutlined onClick={onRotateRight} />
						<ZoomOutOutlined
							disabled={scale === 1}
							onClick={onZoomOut}
						/>
						<ZoomInOutlined
							disabled={scale === 50}
							onClick={onZoomIn}
						/>
						<UndoOutlined onClick={onReset} />
					</Space>
				),
			}}
		/>
	);
};

export default React.memo(ImageMessage);
