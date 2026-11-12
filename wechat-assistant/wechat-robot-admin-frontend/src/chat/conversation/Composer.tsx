import { DeleteOutlined, PictureOutlined, SendOutlined } from '@ant-design/icons';
import { useMemoizedFn } from 'ahooks';
import { Alert, App, Button, Image, Input, Typography } from 'antd';
import type { TextAreaRef } from 'antd/es/input/TextArea';
import React, { useEffect, useRef, useState } from 'react';
import type { ChatContact, ChatDraft } from './types';
import { contactName } from './types';

interface IProps {
	robotId: number;
	contact: ChatContact;
	draft: ChatDraft;
	disabledReason?: string;
	onDraftChange: (patch: Partial<ChatDraft>) => void;
	onBusyChange: (busy: boolean) => void;
	onSent: () => void;
}

const Composer = (props: IProps) => {
	const { message } = App.useApp();
	const [sending, setSending] = useState(false);
	const [error, setError] = useState('');
	const [imageURL, setImageURL] = useState('');
	const pending = useRef(false);
	const composing = useRef(false);
	const input = useRef<TextAreaRef>(null);
	const fileInput = useRef<HTMLInputElement>(null);
	const unavailable =
		!!props.disabledReason ||
		!props.contact.wechat_id ||
		props.contact.status === -2 ||
		props.contact.status === -10001;

	useEffect(() => {
		if (!props.draft.image) {
			setImageURL('');
			return;
		}
		const url = URL.createObjectURL(props.draft.image);
		setImageURL(url);
		return () => URL.revokeObjectURL(url);
	}, [props.draft.image]);

	const chooseImage = useMemoizedFn((file?: File) => {
		if (!file || pending.current || unavailable) return;
		if (!/\.(jpg|jpeg|png|gif|webp)$/i.test(file.name) || file.size === 0 || file.size > 50 * 1024 * 1024) {
			message.error('请选择不超过 50 MB 的 JPG、PNG、GIF 或 WebP 图片');
			return;
		}
		props.onDraftChange({ image: file });
	});

	const send = useMemoizedFn(async () => {
		const text = props.draft.text;
		const image = props.draft.image;
		if (pending.current || composing.current || unavailable || (!text.trim() && !image)) return;
		const recipient = props.contact.wechat_id!;
		// Keep every completion callback bound to the conversation that started this send.
		const robotId = props.robotId;
		const onDraftChange = props.onDraftChange;
		const onSent = props.onSent;
		const onBusyChange = props.onBusyChange;
		pending.current = true;
		setSending(true);
		setError('');
		onBusyChange(true);
		try {
			if (text.trim()) {
				const response = await window.wechatRobotClient.message.sendTextCreate(
					{ id: robotId },
					{ id: robotId, to_wxid: recipient, content: text, at: [] },
					{ timeout: 120000 },
				);
				if (response?.data?.code !== 200) throw new Error(response?.data?.message || '未收到发送确认');
				onDraftChange({ text: '' });
				onSent();
			}
			if (image) {
				// The existing server checks the extension case-sensitively.
				const file = new File(
					[image],
					image.name.replace(/\.[^.]+$/, extension => extension.toLowerCase()),
					{ type: image.type },
				);
				const response = await window.wechatRobotClient.message.sendImageCreate(
					{ id: robotId },
					{ to_wxid: recipient, image: file },
					{ timeout: 120000 },
				);
				if (response?.data?.code !== 200) throw new Error(response?.data?.message || '未收到发送确认');
				onDraftChange({ image: undefined });
				onSent();
			}
		} catch (reason) {
			setError(
				`${reason instanceof Error ? reason.message : '发送异常'}。未确认发送的内容已保留，请核对聊天记录后再发送。`,
			);
			onSent();
		} finally {
			pending.current = false;
			setSending(false);
			onBusyChange(false);
			requestAnimationFrame(() => input.current?.focus());
		}
	});

	return (
		<div className="chat-composer">
			{error && (
				<Alert
					type="error"
					showIcon
					title="发送结果未确认"
					description={error}
					closable={{ onClose: () => setError('') }}
					style={{ marginBottom: 8 }}
				/>
			)}
			{unavailable && (
				<Alert
					type="warning"
					title={props.disabledReason || '该联系人已不可用，可以继续查看聊天记录。'}
					style={{ marginBottom: 8 }}
				/>
			)}
			<div className="composer-toolbar">
				<Button
					icon={<PictureOutlined />}
					disabled={sending || unavailable}
					onClick={() => fileInput.current?.click()}
				>
					添加图片
				</Button>
				<span className="composer-hint">{sending ? '正在发送…' : 'Enter 发送，Shift + Enter 换行'}</span>
			</div>
			<input
				ref={fileInput}
				type="file"
				accept=".jpg,.jpeg,.png,.gif,.webp"
				aria-label="选择聊天图片"
				hidden
				onChange={event => {
					chooseImage(event.target.files?.[0]);
					event.target.value = '';
				}}
			/>
			{props.draft.image && (
				<div className="image-draft">
					{imageURL && (
						<Image
							src={imageURL}
							width={52}
							height={52}
							styles={{ image: { objectFit: 'cover' } }}
							alt="待发送图片"
						/>
					)}
					<Typography.Text
						ellipsis
						style={{ maxWidth: '65%' }}
					>
						{props.draft.image.name}
					</Typography.Text>
					<Button
						type="text"
						icon={<DeleteOutlined />}
						aria-label="移除待发送图片"
						disabled={sending}
						onClick={() => props.onDraftChange({ image: undefined })}
					/>
				</div>
			)}
			<Input.TextArea
				ref={input}
				autoFocus
				aria-label={`发送给${contactName(props.contact)}的消息`}
				placeholder="输入消息…"
				autoSize={{ minRows: 3, maxRows: 6 }}
				value={props.draft.text}
				disabled={sending || unavailable}
				onChange={event => props.onDraftChange({ text: event.target.value })}
				onCompositionStart={() => {
					composing.current = true;
				}}
				onCompositionEnd={() => {
					composing.current = false;
				}}
				onKeyDown={event => {
					if (
						event.key === 'Enter' &&
						!event.shiftKey &&
						!event.ctrlKey &&
						!event.altKey &&
						!event.metaKey &&
						!event.nativeEvent.isComposing &&
						// eslint-disable-next-line @typescript-eslint/no-deprecated -- Some IMEs report 229 after compositionend; Enter must only confirm the candidate.
						event.keyCode !== 229 &&
						!composing.current
					) {
						event.preventDefault();
						void send();
					}
				}}
				onPaste={event => {
					const file = Array.from(event.clipboardData.files).find(item => item.type.startsWith('image/'));
					if (file) {
						event.preventDefault();
						chooseImage(file);
					}
				}}
			/>
			<div className="composer-actions">
				<span className="composer-hint">
					{props.draft.image && props.draft.text.trim() ? '先发送文字，再发送图片' : '发送后可继续输入下一条'}
				</span>
				<Button
					type="primary"
					icon={<SendOutlined />}
					loading={sending}
					disabled={unavailable || (!props.draft.text.trim() && !props.draft.image)}
					onClick={send}
				>
					发送
				</Button>
			</div>
		</div>
	);
};

export default React.memo(Composer);
