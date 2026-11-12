import { useMemoizedFn } from 'ahooks';
import { App as AntdApp, ConfigProvider } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { isEmbedded } from '@/utils/embedded';
import {
	defaultThemePreferences,
	getComponentSizeByDensity,
	parseStoredThemePreferences,
	parseThemePreferences,
	resolveThemeMode,
	themeStorageKey,
} from './preferences';
import type { ResolvedThemeMode, ThemePreferences } from './preferences';
import { buildThemeConfig } from './themeConfig';
import { readWorkbenchTheme, watchWorkbenchTheme } from './workbenchTheme';

interface IProps {
	children?: React.ReactNode;
}

type UpdateThemePreference = <K extends keyof ThemePreferences>(key: K, value: ThemePreferences[K]) => void;

interface ThemeSettingsContextValue {
	preferences: ThemePreferences;
	resolvedThemeMode: ResolvedThemeMode;
	updateThemePreference: UpdateThemePreference;
	resetThemePreferences: () => void;
}

const ThemeSettingsContext = createContext<ThemeSettingsContextValue | null>(null);

const getSystemIsDark = () => {
	if (typeof window === 'undefined' || !window.matchMedia) {
		return false;
	}

	return window.matchMedia('(prefers-color-scheme: dark)').matches;
};

const getInitialPreferences = () => {
	if (isEmbedded) {
		return parseThemePreferences({ ...defaultThemePreferences, themeMode: 'light', colorPreset: 'default' });
	}
	if (typeof window === 'undefined') {
		return defaultThemePreferences;
	}

	return parseStoredThemePreferences(window.localStorage.getItem(themeStorageKey));
};

const ThemeSettingsProvider = (props: IProps) => {
	const [preferences, setPreferences] = useState<ThemePreferences>(getInitialPreferences);
	const [systemIsDark, setSystemIsDark] = useState(getSystemIsDark);
	const [workbenchTheme, setWorkbenchTheme] = useState(() => isEmbedded ? readWorkbenchTheme() : null);

	const resolvedThemeMode = workbenchTheme?.mode || resolveThemeMode(preferences.themeMode, systemIsDark);

	const themeConfig = useMemo(() => {
		return buildThemeConfig(preferences, resolvedThemeMode, workbenchTheme?.tokens);
	}, [preferences, resolvedThemeMode, workbenchTheme]);

	useEffect(() => {
		if (!isEmbedded) return;
		const sync = () => {
			const next = readWorkbenchTheme();
			setWorkbenchTheme(previous => JSON.stringify(previous) === JSON.stringify(next) ? previous : next);
		};
		sync();
		return watchWorkbenchTheme(sync);
	}, []);

	useEffect(() => {
		if (!workbenchTheme) return;
		const root = document.documentElement;
		root.dataset.workbenchTheme = workbenchTheme.mode;
		for (const [key, value] of Object.entries(workbenchTheme.variables)) root.style.setProperty(key, value);
		return () => {
			delete root.dataset.workbenchTheme;
			for (const key of Object.keys(workbenchTheme.variables)) root.style.removeProperty(key);
		};
	}, [workbenchTheme]);

	const componentSize = useMemo(() => {
		return getComponentSizeByDensity(preferences.density);
	}, [preferences.density]);

	const updateThemePreference = useMemoizedFn(
		(key: keyof ThemePreferences, value: ThemePreferences[keyof ThemePreferences]) => {
			setPreferences(prev => parseThemePreferences({ ...prev, [key]: value }));
		},
	);

	const resetThemePreferences = useMemoizedFn(() => {
		setPreferences(defaultThemePreferences);
	});

	useEffect(() => {
		const media = window.matchMedia('(prefers-color-scheme: dark)');
		const onChange = (event: MediaQueryListEvent) => {
			setSystemIsDark(event.matches);
		};

		setSystemIsDark(media.matches);
		media.addEventListener('change', onChange);

		return () => {
			media.removeEventListener('change', onChange);
		};
	}, []);

	useEffect(() => {
		if (!isEmbedded) window.localStorage.setItem(themeStorageKey, JSON.stringify(preferences));
	}, [preferences]);

	useEffect(() => {
		document.documentElement.dataset.themeMode = resolvedThemeMode;

		return () => {
			delete document.documentElement.dataset.themeMode;
		};
	}, [resolvedThemeMode]);

	const contextValue = useMemo<ThemeSettingsContextValue>(
		() => ({
			preferences,
			resolvedThemeMode,
			updateThemePreference,
			resetThemePreferences,
		}),
		[preferences, resolvedThemeMode],
	);

	return (
		<ThemeSettingsContext.Provider value={contextValue}>
			<ConfigProvider
				locale={zhCN}
				theme={themeConfig}
				componentSize={componentSize}
			>
				<AntdApp>
					{!isEmbedded && <div className="skin" />}
					{props.children}
				</AntdApp>
			</ConfigProvider>
		</ThemeSettingsContext.Provider>
	);
};

export const useThemeSettings = () => {
	const context = useContext(ThemeSettingsContext);

	if (!context) {
		throw new Error('useThemeSettings must be used within ThemeSettingsProvider');
	}

	return context;
};

export default React.memo(ThemeSettingsProvider);
