import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export function readMaterialInfo(materialPath) {
  const absolute = path.resolve(materialPath);
  const stat = fs.statSync(absolute);
  if (!stat.isFile()) throw new Error('素材路径不是文件');
  const extension = path.extname(absolute).toLowerCase();
  const hash = createHash('sha256');
  const fd = fs.openSync(absolute, 'r');
  try {
    const buffer = Buffer.alloc(1024 * 1024);
    let length;
    while ((length = fs.readSync(fd, buffer, 0, buffer.length, null))) hash.update(buffer.subarray(0, length));
  } finally { fs.closeSync(fd); }
  return {
    name: path.basename(absolute), extension, size: stat.size,
    type: ['.mp4', '.mov'].includes(extension) ? 'video' : ['.jpg', '.jpeg', '.png', '.webp'].includes(extension) ? 'image' : 'unknown',
    sha256: hash.digest('hex')
  };
}
