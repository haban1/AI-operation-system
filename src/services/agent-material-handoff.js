import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

function reject(statusCode, code, message) {
  throw Object.assign(new Error(message), { statusCode, code });
}

export async function resolveJobMaterial({ job, deviceId, roots, at = Date.now() }) {
  if (!job || !deviceId || job.device_id !== deviceId) reject(404, 'JOB_NOT_FOUND', '没有分配给该设备的任务');
  if (job.job_type !== 'PUBLISH' || job.status !== 'RUNNING' || !(Date.parse(job.lease_expires_at) > at)) {
    reject(409, 'JOB_NOT_ACTIVE', '仅可读取租约有效的执行中发布任务素材');
  }
  const payload = typeof job.payload === 'string' ? JSON.parse(job.payload) : job.payload;
  const expectedSha = String(payload?.materialSha256 || payload?.materialMeta?.sha256 || '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(expectedSha)) reject(409, 'MATERIAL_SHA_REQUIRED', '任务缺少素材校验信息，请重新检测素材');
  let materialPath;
  try { materialPath = await fs.promises.realpath(payload.materialPath); }
  catch { reject(404, 'MATERIAL_NOT_FOUND', '发布素材不存在'); }
  const trustedRoots = await Promise.all(roots.map(root => fs.promises.realpath(root).catch(() => null)));
  const inside = trustedRoots.some(root => {
    if (!root) return false;
    const relative = path.relative(root, materialPath);
    return relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  });
  if (!inside) reject(403, 'MATERIAL_PATH_DENIED', '仅可交接已上传或已入库的发布素材');
  const stat = await fs.promises.stat(materialPath);
  if (!stat.isFile()) reject(400, 'MATERIAL_NOT_FILE', '发布素材必须是文件');
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(materialPath)) hash.update(chunk);
  const sha256 = hash.digest('hex');
  if (sha256 !== expectedSha) reject(409, 'MATERIAL_SHA_CHANGED', '素材已改变，请重新检测并创建任务');
  return { path: materialPath, size: stat.size, sha256 };
}
