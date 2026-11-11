import React from 'react';
import styled from 'styled-components';
import { techCard, theme } from '@/common/tech-theme';

const Container = styled.div`
	${techCard}
	margin-top: 18px;
	padding: 21px 22px 4px;
	.param-group-title {
		margin-bottom: 20px;
		color: ${theme.title};
		font-size: 16px;
		font-weight: 550;
	}
`;

interface IProps {
	className?: string;
	style?: React.CSSProperties;
	title?: React.ReactNode;
	collapsed?: boolean;
	children?: React.ReactElement | React.ReactElement[];
}

const ParamsGroup = (props: IProps) => {
	const { className = '', style } = props;

	if (props.collapsed)
		return (
			<details className="wx-advanced-group">
				<summary>{props.title}</summary>
				<Container
					className={className}
					style={style}
				>
					{props.children}
				</Container>
			</details>
		);
	return (
		<Container
			className={className}
			style={style}
		>
			<div className="param-group-title">{props.title}</div>
			{props.children}
		</Container>
	);
};

export default React.memo(ParamsGroup);
