import styled from 'styled-components';
import { ConversationLayout } from '@/chat/conversation/styled';

export const ReceptionLayout = styled(ConversationLayout)`
	display: flex;
	flex-direction: column;
	height: min(680px, 80vh);
	min-height: 420px;
	.chat-pane {
		flex: 1;
	}
	.chat-header {
		flex-wrap: wrap;
	}
	.chat-heading {
		flex: 1 1 160px;
	}
	.contact-kind {
		overflow-wrap: anywhere;
	}
`;
