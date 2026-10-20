function evidenceList(value) {
  return Array.isArray(value) ? value.map(String) : [];
}

export function isConfirmedLoginExpired(data, requiredConfirmations = 3) {
  if (!data || !['LOGIN', 'EXPIRED'].includes(String(data.state || '').toUpperCase())) return false;
  if (String(data.confidence || '').toUpperCase() !== 'CONFIRMED') return false;
  if (Number(data.confirmedSamples || 0) < Math.max(2, Number(requiredConfirmations) || 3)) return false;
  return evidenceList(data.evidence).some(item => item === 'login-url' || item === 'login-text' || item.startsWith('logged-out-selector:'));
}

function formatChinaTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value || '未知');
  return date.toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' });
}

export function buildLoginExpiredNotification({ account, data }) {
  const platformName = account.platform_name || account.platform_code || '未知平台';
  const confirmations = Number(data.confirmedSamples || 0);
  const evidence = evidenceList(data.evidence).filter(item => !item.startsWith('check-mode:'));
  return {
    type: 'PLATFORM_LOGIN_EXPIRED',
    title: `【平台账号退出登录】${platformName}需要人工处理`,
    content: [
      `平台：${platformName}`,
      `账号：${account.display_name || '未命名账号'}`,
      `RPA设备：${account.device_name || account.device_id || '未知设备'}`,
      `检测时间：${formatChinaTime(data.checkedAt)}`,
      `审核结论：已确认退出登录（连续 ${confirmations} 次检查证据一致）`,
      `证据：${evidence.join('、') || '无'}`,
      `检测页面：${data.url || '无'}`,
      '处理要求：请在对应 RPA 电脑的独立浏览器 Profile 中人工重新登录；系统不会代填密码、验证码或扫码。'
    ].join('\n')
  };
}
