import { platformAccountLabel } from './account-identity.js?v=20261113';

// Login-monitor records contain a historical operator label in their detail.
// Format that known identity slot at display time, leaving the stored evidence intact.
export function issueAccountPresentation(issue, accounts = []) {
  const title = String(issue?.title ?? '');
  const detail = String(issue?.detail ?? '');
  if (issue?.source !== 'LOGIN_MONITOR' || issue.category !== 'ACCOUNT_LOGIN' || issue.related_type !== 'ACCOUNT') return { title, detail };
  const account = accounts.find(item => String(item.id) === String(issue.related_id));
  const platform = account?.platform_name || account?.platform_code || title.match(/^(.+)登录状态已过期$/)?.[1];
  if (!platform) return { title, detail };
  const label = platformAccountLabel(account, platform);
  return {
    title: title.endsWith('登录状态已过期') ? `${label}登录状态已过期` : title,
    detail: detail.replace(/^[^\r\n]*?(连续\s+\d+\s+次检测到明确退出证据，请人工处理)$/, (_, reason) => `${label}${reason}`)
  };
}
