import { css } from 'styled-components';

export const theme = {
	cyan: 'var(--ant-color-primary)',
	blue: 'var(--ant-color-primary)',
	blueDeep: 'var(--ant-color-primary)',
	green: 'var(--ant-color-success)',
	pink: 'var(--ant-color-error)',
	teal: 'var(--ant-color-primary)',
	border: 'var(--ant-color-border-secondary)',
	borderStrong: 'var(--ant-color-primary-border)',
	cyanSoft: 'var(--ant-color-primary-border)',
	cyanSofter: 'var(--ant-color-border-secondary)',
	cyanGlow: 'var(--ant-color-primary-border-hover)',
	title: 'var(--ant-color-text-heading)',
	label: 'var(--ant-color-text-secondary)',
	value: 'var(--ant-color-text)',
	surface: 'var(--ant-color-bg-container)',
	surfaceSoft: 'var(--ant-color-fill-content)',
} as const;

export const techScrollbar = css`
	scrollbar-width: thin;
	scrollbar-color: var(--ant-color-border) transparent;

	&::-webkit-scrollbar {
		width: 6px;
		height: 6px;
	}

	&::-webkit-scrollbar-thumb {
		border-radius: 3px;
		background: var(--ant-color-border);
	}

	&::-webkit-scrollbar-thumb:hover {
		background: var(--ant-color-primary-border-hover);
	}
`;

export const techCard = css`
	position: relative;
	border: 1px solid ${theme.border};
	border-radius: 10px;
	background: ${theme.surface};
`;

export const techCardHover = css`
	border-color: ${theme.borderStrong};
`;

export const techSectionTitle = css`
	display: inline-flex;
	align-items: center;
	gap: 8px;
	font-size: 13px;
	font-weight: 550;
	color: ${theme.title};
`;
