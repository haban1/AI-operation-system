import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export async function prepareRemoteJobMaterial(job, { baseUrl, token, deviceId, cacheDir, maxBytes }) {
  if (job.job_type !== 'PUBLISH') return job;
  const sha256 = String(job.payload?.materialSha256 || job.payload?.materialMeta?.sha256 || '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error('发布素材缺少 SHA256，拒绝上传未经校验的文件');
  const extension = path.posix.extname(String(job.payload.materialPath || '').replaceAll('\\', '/')).toLowerCase();
  if (!['.mp4', '.mov', '.jpg', '.jpeg', '.png', '.webp'].includes(extension)) throw new Error('发布素材格式不支持');
  await fs.promises.mkdir(cacheDir, { recursive: true });
  const destination = path.join(cacheDir, `${sha256}${extension}`);
  // Always authorize the current lease with Web, even when the cache exists.
  const response = await fetch(`${baseUrl}/api/agent/jobs/${job.id}/material?deviceId=${encodeURIComponent(deviceId)}`, {
    headers: { Authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.timeout(10 * 60_000)
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`无法交接发布素材（HTTP ${response.status}），未执行平台上传`);
  }
  const expectedSize = Number(response.headers.get('content-length'));
  if (response.headers.get('x-material-sha256') !== sha256 || !Number.isSafeInteger(expectedSize) || expectedSize <= 0 || expectedSize > maxBytes) {
    await response.body?.cancel();
    throw new Error('发布素材交接头校验失败');
  }
  const temporary = path.join(cacheDir, `${sha256}-${randomUUID()}.part`);
  const hash = createHash('sha256');
  let received = 0;
  try {
    const verify = new Transform({ transform(chunk, encoding, callback) {
      received += chunk.length;
      if (received > expectedSize || received > maxBytes) return callback(new Error('发布素材超出允许大小'));
      hash.update(chunk);
      callback(null, chunk);
    } });
    await pipeline(Readable.fromWeb(response.body), verify, fs.createWriteStream(temporary, { flags: 'wx' }));
    if (received !== expectedSize || hash.digest('hex') !== sha256) throw new Error('发布素材大小或 SHA256 不一致');
    await fs.promises.rename(temporary, destination);
  } finally { await fs.promises.rm(temporary, { force: true }); }
  // Preserve the server's draft fingerprint and submit-lock identity.
  return { ...job, payload: { ...job.payload, materialPath: destination } };
}
