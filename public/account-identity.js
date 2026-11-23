// Use only the detected platform identity, never an operator label or database ID.
export function platformAccountLabel(account, platform = account?.platform_name || account?.platform_code || '') {
  const id = String(account?.login_status || '').toUpperCase() === 'READY'
    ? String(account?.platform_user_id ?? '').trim() : '';
  return id ? `${id} · ${platform}` : String(platform);
}
