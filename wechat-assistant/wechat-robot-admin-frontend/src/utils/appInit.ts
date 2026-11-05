import type { AxiosResponse, InternalAxiosRequestConfig } from 'axios';
import { isAxiosError } from 'axios';
import type { AnyType } from '@/common/types';
import { UrlLogin } from '@/constant/redirect-url';
import { clientInit } from './clientInit';
import { appBasePath, isEmbedded } from './embedded';

const baseURL = appBasePath ? `${appBasePath}/api/v1` : '';

export const Init = () => {
	const errorWrapper = (stack: { code: number; message?: string; error?: string }) => {
		const error = new Error(stack.message || stack.error);
		Object.defineProperty(error, 'meta', { value: stack });
		return error;
	};

	const reqInterceptor = (config: InternalAxiosRequestConfig<AnyType>) => {
		return config;
	};

	const respInterceptor = (response: AxiosResponse<AnyType, AnyType>) => {
		const data = response.data as { code: number; error: string; data?: { login_method: 'scan' | 'token' } };
		switch (data.code) {
			case 200:
				return response;
			case 401:
				if (isEmbedded) {
					return Promise.reject(errorWrapper({ code: 401, message: '微信助手会话不可用，请刷新页面；若天河登录已过期，请重新登录天河。' }));
				}
				window.location.href = `${UrlLogin}?login_method=${data.data?.login_method ?? 'scan'}&redirect=${encodeURIComponent(window.location.href)}`;
				return;
			default:
				return Promise.reject(errorWrapper(data));
		}
	};

	clientInit({
		baseURL,
		reqInterceptors: [{ onFulfilled: reqInterceptor }],
		respInterceptors: [{
			onFulfilled: respInterceptor,
			onRejected: error => {
				if (isEmbedded && isAxiosError(error)) {
					const data = error.response?.data;
					const message = error.response?.status === 401
						? '天河登录已过期，请重新登录天河。'
						: data?.message || data?.error || '微信助手暂时无法连接，请稍后重试。';
					return Promise.reject(new Error(message));
				}
				return Promise.reject(error);
			},
		}],
	});
};
