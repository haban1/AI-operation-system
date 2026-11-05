import React from 'react';
import type { RouteProps } from 'react-router-dom';
import { isEmbedded } from './utils/embedded';

const RobotList = React.lazy(() => import(/* webpackChunkName: "robot-list" */ '@/robot'));
const EmbeddedWorkbench = React.lazy(() => import(/* webpackChunkName: "embedded-workbench" */ '@/robot/EmbeddedWorkbench'));

const routers: RouteProps[] = [
	{
		index: true,
		element: isEmbedded ? <EmbeddedWorkbench /> : <RobotList />,
	},
];

export default routers;
