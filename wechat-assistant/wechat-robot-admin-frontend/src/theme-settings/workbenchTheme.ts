import type { ThemeConfig } from 'antd';
import type { ResolvedThemeMode } from './preferences';

const hostRoot = () => {
	try {
		return window.parent !== window ? window.parent.document.documentElement : null;
	} catch {
		return null;
	}
};

export const readWorkbenchTheme = () => {
	const root = hostRoot();
	let saved = 'day';
	try { saved = window.localStorage.getItem('ui-theme') || saved; } catch { /* use day mode */ }
	const mode: ResolvedThemeMode = (root?.dataset.theme || saved) === 'night' ? 'dark' : 'light';
	const dark = mode === 'dark';
	const style = root ? window.parent.getComputedStyle(root) : null;
	const variables: Record<string, string> = {};
	const color = (name: string, fallback: string) => {
		const value = style?.getPropertyValue(`--tk-${name}`).trim() || fallback;
		variables[`--tk-${name}`] = value;
		return value;
	};
	const primary = color('acc', dark ? '#7c6cf6' : '#2563eb');
	const surface = color('surface', dark ? '#14151e' : '#ffffff');
	const secondary = color('surface2', dark ? '#1e202b' : '#f4f7fc');
	const text = color('ink', dark ? '#f2f2f7' : '#0f1b2d');
	const muted = color('muted', dark ? '#8d90a5' : '#536176');
	const line = color('line', dark ? 'rgba(255,255,255,.08)' : '#d8e0eb');
	const tokens: NonNullable<ThemeConfig['token']> = {
		colorPrimary: primary, colorInfo: primary,
		colorPrimaryText: color('acc-text', primary), colorPrimaryTextHover: primary,
		colorPrimaryBg: color('acc-soft', dark ? 'rgba(124,108,246,.15)' : 'rgba(37,99,235,.1)'),
		colorPrimaryBorder: color('acc-line', primary),
		colorSuccess: color('ok', dark ? '#4cd6a0' : '#13834f'),
		colorSuccessBg: color('ok-soft', dark ? '#17352c' : '#e3f4ea'),
		colorWarning: color('warn', dark ? '#f5b454' : '#c46a00'),
		colorWarningBg: color('warn-soft', dark ? '#30271c' : '#fdf0dc'),
		colorError: color('danger', dark ? '#f07178' : '#d93a3a'),
		colorErrorBg: color('danger-soft', dark ? '#352025' : '#fde8e8'),
		colorBgBase: color('bg0', dark ? '#08090c' : '#e8edf5'),
		colorBgLayout: 'transparent', colorBgContainer: surface,
		colorBgElevated: color('dialog', dark ? '#15161e' : '#ffffff'),
		colorFillAlter: secondary, colorFillContent: secondary,
		colorFillContentHover: secondary, colorFillQuaternary: secondary,
		colorBorder: color('line-strong', line), colorBorderSecondary: line, colorSplit: line,
		colorText: text, colorTextHeading: text,
		colorTextSecondary: muted, colorTextDescription: muted, colorTextPlaceholder: muted,
		borderRadius: 10, borderRadiusSM: 8, borderRadiusLG: 14,
		fontSize: 14, fontFamily: 'Inter, "PingFang SC", "Microsoft YaHei", system-ui, sans-serif',
		boxShadowSecondary: dark ? '0 14px 34px -18px #000d' : '0 14px 32px -16px #28468c47',
	};
	for (const name of ['glass', 'card-edge', 'card-shadow', 'hi', 'ink2']) color(name, surface);
	return { mode, tokens, variables };
};

export const watchWorkbenchTheme = (onChange: () => void) => {
	const root = hostRoot();
	const observer = new MutationObserver(onChange);
	if (root) observer.observe(root, { attributes: true, attributeFilter: ['data-theme', 'data-fx', 'style'] });
	const onStorage = (event: StorageEvent) => { if (event.key === 'ui-theme') onChange(); };
	window.addEventListener('storage', onStorage);
	return () => { observer.disconnect(); window.removeEventListener('storage', onStorage); };
};
