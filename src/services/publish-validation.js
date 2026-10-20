function normalizeLocalPath(value) {
  return String(value || '').trim().replace(/\\/g, '/').toLowerCase();
}

export function validatePublishPrecheck(data) {
  const precheck = data?.precheck;
  if (!precheck || typeof precheck !== 'object') return { ok: false, message: '缺少 Local Agent 预检结果，请重新执行本地预检' };
  if (!['PASSED', 'WARNING'].includes(precheck.overall)) return { ok: false, message: '本地预检存在阻断项，不能创建发布任务' };
  if (normalizeLocalPath(precheck.path) !== normalizeLocalPath(data.materialPath)) return { ok: false, message: '素材路径与本地预检结果不一致，请重新预检' };
  if (!precheck.meta || typeof precheck.meta !== 'object') return { ok: false, message: '本地预检缺少素材元数据' };
  if (!Array.isArray(precheck.results)) return { ok: false, message: '本地预检缺少分平台结果' };
  const targets = Array.isArray(data.targets) ? data.targets : [];
  for (const target of targets) {
    const result = precheck.results.find(item => item?.platformCode === target.platformCode);
    if (!result) return { ok: false, message: '平台 ' + target.platformCode + ' 缺少预检结果' };
    if (!['PASSED', 'WARNING'].includes(result.status)) return { ok: false, message: '平台 ' + target.platformCode + ' 预检未通过' };
  }
  return { ok: true };
}
