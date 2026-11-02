import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const extensions = new Set(['.jpg', '.jpeg', '.png', '.webp', '.mp4', '.mov']);
const uploadError = (statusCode, code, message) => Object.assign(new Error(message), { statusCode, code });

export function validateMaterialUpload(req, url, maxBytes) {
  if (String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase() !== 'application/octet-stream') {
    throw uploadError(415, 'MATERIAL_UPLOAD_CONTENT_TYPE', '请使用文件上传方式添加素材');
  }
  const filename = url.searchParams.get('filename') || '';
  if ([...url.searchParams.keys()].some(key => key !== 'filename') || url.searchParams.getAll('filename').length !== 1
    || !filename || Buffer.byteLength(filename) > 240 || /[<>:"/\\|?*\x00-\x1f\x7f]/.test(filename)
    || /[. ]$/.test(filename) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(filename)) {
    throw uploadError(400, 'MATERIAL_UPLOAD_FILENAME', '素材文件名无效，请重命名后上传');
  }
  if (!extensions.has(path.extname(filename).toLowerCase())) {
    throw uploadError(415, 'MATERIAL_UPLOAD_TYPE', '支持 JPG、PNG、WEBP、MP4、MOV 格式');
  }
  const length = req.headers['content-length'];
  if (!/^\d+$/.test(String(length)) || !Number.isSafeInteger(Number(length))) {
    throw uploadError(411, 'MATERIAL_UPLOAD_LENGTH', '无法确定文件大小，请重新选择文件');
  }
  const size = Number(length);
  if (!size) throw uploadError(400, 'MATERIAL_UPLOAD_EMPTY', '不能上传空文件');
  if (size > maxBytes) throw uploadError(413, 'MATERIAL_UPLOAD_TOO_LARGE', '素材超过单文件上传大小限制');
  return { filename, size };
}

// Each upload gets its own directory; the browser never selects a server path.
// Stream to disk so large videos do not pass through the JSON body buffer.
export async function receiveMaterialUpload(req, url, { directory, maxBytes, inspect }) {
  const { filename, size } = validateMaterialUpload(req, url, maxBytes);
  const uploadDir = path.join(path.resolve(directory), randomUUID());
  const materialPath = path.join(uploadDir, filename);
  await fs.mkdir(uploadDir, { recursive: true, mode: 0o700 });
  let file;
  try {
    file = await fs.open(materialPath, 'wx', 0o600);
    let received = 0;
    for await (const chunk of req.iterator({ destroyOnReturn: false })) {
      received += chunk.length;
      if (received > maxBytes || received > size) throw uploadError(413, 'MATERIAL_UPLOAD_TOO_LARGE', '素材超过单文件上传大小限制');
      await file.writeFile(chunk);
    }
    await file.close();
    file = null;
    if (received !== size) throw uploadError(400, 'MATERIAL_UPLOAD_INCOMPLETE', '文件上传不完整，请重新选择');
    const precheck = await inspect({ materialPath, platforms: [] });
    const extension = path.extname(filename).toLowerCase();
    const formatExtensions = { jpeg: ['.jpg', '.jpeg'], png: ['.png'], webp: ['.webp'], mp4: ['.mp4'], mov: ['.mov'] };
    if (!precheck.meta?.parserReady || !formatExtensions[precheck.meta.format]?.includes(extension)) {
      throw uploadError(422, 'MATERIAL_UPLOAD_INVALID_MEDIA', '文件内容无法解析为所选图片或视频格式，请检查文件是否损坏');
    }
    return { materialPath, precheck };
  } catch (error) {
    await file?.close().catch(() => {});
    await fs.rm(uploadDir, { recursive: true, force: true });
    if (error.statusCode) throw error;
    throw uploadError(500, 'MATERIAL_UPLOAD_FAILED', '素材保存失败，请检查可用空间后重试');
  }
}
