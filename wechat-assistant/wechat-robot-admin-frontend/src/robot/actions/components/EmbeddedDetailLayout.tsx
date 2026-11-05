import type { DrawerProps } from 'antd';
import React from 'react';

const EmbeddedDetailLayout = (props: DrawerProps) => (
	<div className="embedded-robot-detail">
		<div className="embedded-robot-heading">
			{props.title}
			{props.extra}
		</div>
		<div className="embedded-robot-body">{props.children}</div>
	</div>
);

export default React.memo(EmbeddedDetailLayout);
