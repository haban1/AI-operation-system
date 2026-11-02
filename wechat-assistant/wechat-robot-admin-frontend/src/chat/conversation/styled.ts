import styled from 'styled-components';

export const ConversationLayout = styled.div`
	height: 100%;
	min-height: 0;
	display: grid;
	grid-template-columns: 240px minmax(0, 1fr);
	.contact-sidebar {
		display: flex;
		flex-direction: column;
		min-height: 0;
		border-right: 1px solid var(--chat-border);
	}
	.contact-search {
		padding: 16px 12px 12px;
	}
	.contact-list {
		overflow-y: auto;
		flex: 1;
		min-height: 0;
		padding: 0 8px;
	}
	.contact-choice {
		display: flex;
		align-items: center;
		gap: 10px;
		width: 100%;
		padding: 12px 10px;
		border: 0;
		border-radius: 8px;
		text-align: left;
		color: inherit;
		background: transparent;
		cursor: pointer;
	}
	.contact-choice[aria-current='true'] {
		background: var(--chat-selected);
	}
	.contact-choice:hover {
		background: var(--chat-selected);
	}
	.contact-choice:disabled {
		cursor: wait;
		opacity: 0.65;
	}
	.contact-label {
		min-width: 0;
		flex: 1;
	}
	.contact-name {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.contact-kind {
		font-size: 12px;
		color: var(--chat-muted);
		margin-top: 3px;
	}
	.chat-pane {
		display: flex;
		flex-direction: column;
		min-width: 0;
		min-height: 0;
		height: 100%;
	}
	.chat-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		padding: 12px 18px;
		border-bottom: 1px solid var(--chat-border);
	}
	.chat-heading {
		display: flex;
		gap: 10px;
		align-items: center;
		min-width: 0;
	}
	.chat-messages {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		overflow-anchor: none;
		padding: 18px;
		background: var(--chat-background);
	}
	.chat-message {
		display: flex;
		align-items: flex-start;
		gap: 10px;
		margin: 0 0 20px;
	}
	.chat-message.outgoing {
		flex-direction: row-reverse;
	}
	.message-main {
		min-width: 0;
		max-width: min(80%, 680px);
	}
	.message-meta {
		color: var(--chat-muted);
		font-size: 12px;
		margin-bottom: 5px;
	}
	.outgoing .message-meta {
		text-align: right;
	}
	.message-bubble {
		padding: 10px 12px;
		border-radius: 12px;
		background: var(--chat-incoming);
		overflow-wrap: anywhere;
	}
	.outgoing .message-bubble {
		background: var(--chat-outgoing);
	}
	.message-bubble .text-message {
		margin: 0;
		white-space: pre-wrap;
		font: inherit;
		color: inherit;
	}
	.message-bubble .refer-message {
		margin: 0 0 8px;
		padding-left: 10px;
		border-left: 3px solid var(--chat-border);
		color: var(--chat-muted);
	}
	.message-bubble audio {
		max-width: 100%;
	}
	.chat-composer {
		padding: 12px 18px;
		border-top: 1px solid var(--chat-border);
	}
	.composer-toolbar {
		display: flex;
		justify-content: space-between;
		gap: 8px;
		align-items: center;
		margin-bottom: 8px;
	}
	.composer-actions {
		display: flex;
		justify-content: space-between;
		gap: 8px;
		align-items: center;
		margin-top: 8px;
	}
	.composer-hint {
		color: var(--chat-muted);
		font-size: 12px;
	}
	.image-draft {
		display: flex;
		align-items: center;
		gap: 10px;
		padding-bottom: 10px;
	}
	@media (max-width: 760px) {
		grid-template-columns: 160px minmax(0, 1fr);
		.contact-choice {
			gap: 6px;
			padding: 10px 5px;
		}
		.chat-header,
		.chat-composer {
			padding: 10px;
		}
		.chat-messages {
			padding: 12px 8px;
		}
		.composer-hint {
			display: none;
		}
		.message-main {
			max-width: 82%;
		}
	}
	@media (max-width: 520px) {
		grid-template-columns: minmax(0, 1fr);
		.contact-sidebar {
			max-height: 150px;
			border-right: 0;
			border-bottom: 1px solid var(--chat-border);
		}
		.contact-list {
			display: flex;
			flex: none;
			overflow-x: auto;
		}
		.contact-choice {
			width: 160px;
			flex-shrink: 0;
		}
		.contact-search {
			padding: 6px 8px;
		}
		grid-template-rows: auto minmax(0, 1fr);
	}
`;
