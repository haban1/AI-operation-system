import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { BUNDLED_CONTENT_APPROVAL_SHA256 } from '../src/services/content-library-seeds.js';

const defaultManifest = fileURLToPath(new URL('../bundled/content-library/manifest.json', import.meta.url));
const mediaExtensions = { video: new Set(['.mp4', '.mov', '.m4v', '.webm']), image: new Set(['.png', '.jpg', '.jpeg', '.webp']) };
const sources = new Set(['automatic', 'editing', 'creation']);
const tuple = item => JSON.stringify([item.source, item.sourceId, item.sha256, item.bytes]);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

function fail(code, message, itemId) {
  const error = new Error(message);
  error.code = code;
  if (itemId) error.itemId = itemId;
  throw error;
}

async function metadata(file, label) {
  let handle;
  try {
    handle = await fsp.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 2 * 1024 * 1024) fail('INVALID_METADATA', `${label} 必须是小于 2 MiB 的普通 JSON 文件`);
    const bytes = await handle.readFile();
    return { value: JSON.parse(bytes.toString('utf8')), sha256: digest(bytes) };
  } catch (error) {
    if (error.code === 'ENOENT') fail('MISSING_METADATA', `缺少 ${label}`);
    if (error instanceof SyntaxError) fail('INVALID_METADATA', `${label} 不是有效 JSON`);
    if (error.code === 'ELOOP') fail('UNTRUSTED_PATH', `${label} 不能是符号链接`);
    throw error;
  } finally { await handle?.close(); }
}

function validTuple(item) {
  return item && sources.has(item.source) && typeof item.sourceId === 'string' && item.sourceId.trim()
    && item.sourceId.length <= 512 && /^[a-f0-9]{64}$/.test(item.sha256 || '')
    && Number.isSafeInteger(item.bytes) && item.bytes > 0;
}

function validSignature(header, extension) {
  if (extension === '.png') return header.length >= 24 && header.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) && header.toString('ascii', 12, 16) === 'IHDR';
  if (extension === '.jpg' || extension === '.jpeg') return header.length >= 3 && header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff;
  if (extension === '.webp') return header.length >= 12 && header.toString('ascii', 0, 4) === 'RIFF' && header.toString('ascii', 8, 12) === 'WEBP';
  if (extension === '.webm') return header.length >= 4 && header.subarray(0, 4).equals(Buffer.from('1a45dfa3', 'hex'));
  const atom = header.toString('ascii', 4, 8);
  return header.length >= 12 && (atom === 'ftyp' || (extension === '.mov' && ['moov', 'mdat', 'wide', 'free', 'skip', 'pnot'].includes(atom)));
}

async function mediaFile(root, item) {
  let current = root, handle;
  try {
    const parts = item.filePath.split('/');
    for (const [index, part] of parts.entries()) {
      current = path.join(current, part);
      const stat = await fsp.lstat(current);
      if (stat.isSymbolicLink() || (index === parts.length - 1 ? !stat.isFile() : !stat.isDirectory())) fail('UNTRUSTED_PATH', '媒体路径必须全部由普通目录和文件组成', item.id);
    }
    if (await fsp.realpath(current) !== current) fail('UNTRUSTED_PATH', '媒体路径不能经过符号链接', item.id);
    handle = await fsp.open(current, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const before = await handle.stat();
    if (!before.isFile() || before.size !== item.bytes) fail('SIZE_MISMATCH', '媒体字节数与清单不一致', item.id);
    if (before.size > 100 * 1024 * 1024) fail('GITHUB_FILE_LIMIT', '单个媒体超过 GitHub 普通 Git 文件的 100 MiB 限制', item.id);
    const hash = createHash('sha256');
    let bytes = 0, header;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      header ||= chunk.subarray(0, 64);
      bytes += chunk.length; hash.update(chunk);
    }
    const after = await handle.stat();
    if (bytes !== item.bytes || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ino !== before.ino) fail('SIZE_MISMATCH', '媒体在校验期间发生变化', item.id);
    if (hash.digest('hex') !== item.sha256) fail('SHA256_MISMATCH', '媒体 SHA256 与清单不一致', item.id);
    if (!validSignature(header || Buffer.alloc(0), path.extname(item.filePath))) fail('MEDIA_SIGNATURE_MISMATCH', '媒体容器签名与扩展名不一致', item.id);
  } catch (error) {
    if (error.code === 'ENOENT') fail('MISSING_MEDIA', '清单引用的媒体文件不存在', item.id);
    if (error.code === 'ELOOP') fail('UNTRUSTED_PATH', '媒体路径不能经过符号链接', item.id);
    throw error;
  } finally { await handle?.close(); }
}

export async function verifyBundledMedia({ manifestPath = defaultManifest, approvalSha256 = BUNDLED_CONTENT_APPROVAL_SHA256 } = {}) {
  const directory = path.dirname(path.resolve(manifestPath));
  const rootStat = await fsp.lstat(directory);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) fail('UNTRUSTED_PATH', '预置媒体目录不能是符号链接');
  const root = await fsp.realpath(directory);
  const { value: manifest } = await metadata(path.join(root, path.basename(manifestPath)), 'manifest.json');
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.items) || !manifest.items.length || manifest.items.length > 1000) fail('INVALID_MANIFEST', 'manifest.json 必须包含 schemaVersion=1 和 1–1000 项素材');
  const approvalFile = await metadata(path.join(root, 'approval.json'), 'approval.json');
  const approval = approvalFile.value;
  if (!/^[a-f0-9]{64}$/.test(approvalSha256) || approvalFile.sha256 !== approvalSha256) fail('APPROVAL_LOCK_MISMATCH', 'approval.json 与本版本代码锁不一致');
  if (approval.schemaVersion !== 1 || typeof approval.actor !== 'string' || !approval.actor.trim() || approval.actor.length > 200
    || typeof approval.basis !== 'string' || !approval.basis.trim() || approval.basis.length > 4000 || !Number.isFinite(Date.parse(approval.approvedAt))
    || !Array.isArray(approval.items) || approval.items.length > 1000 || approval.items.some(item => !validTuple(item))) fail('INVALID_APPROVAL', '固定确认记录格式无效');
  const consent = new Set(approval.items.map(tuple));
  if (consent.size !== approval.items.length) fail('DUPLICATE_APPROVAL', '固定确认记录存在重复素材');
  const ids = new Set(), tuples = new Set(), checked = new Set();
  const result = { ok: true, schemaVersion: 1, counts: { total: manifest.items.length, approved: 0, sources: { automatic: 0, editing: 0, creation: 0 }, mediaTypes: { video: 0, image: 0 } }, totalBytes: 0, uniqueMediaFiles: 0, uniqueBytes: 0, largestBytes: 0, approval: { sha256: approvalFile.sha256, actor: approval.actor, basis: approval.basis, approvedAt: approval.approvedAt }, checks: ['trusted-media-paths', 'size', 'sha256', 'container-signature', 'fixed-approval-tuples'], warnings: [] };
  for (const item of manifest.items) {
    if (!validTuple(item) || !/^[A-Za-z0-9_-]{1,160}$/.test(item.id || '') || typeof item.title !== 'string' || item.title.length > 500
      || !['final_video', 'video_clip', 'image'].includes(item.artifactType) || typeof item.filename !== 'string' || !item.filename || item.filename.length > 255
      || /[\\/:\x00-\x1f\x7f]/.test(item.filename) || !mediaExtensions[item.mediaType]?.has(path.extname(item.filename).toLowerCase())) fail('INVALID_ITEM', '素材清单字段无效', item?.id);
    const extension = path.extname(item.filename).toLowerCase();
    if (typeof item.filePath !== 'string' || item.filePath !== `media/${item.sha256}${extension}`) fail('UNTRUSTED_PATH', '媒体路径必须为 media/<sha256>.<扩展名>', item.id);
    if (ids.has(item.id) || tuples.has(tuple(item))) fail('DUPLICATE_ITEM', '素材清单存在重复 ID 或来源内容', item.id);
    ids.add(item.id); tuples.add(tuple(item));
    if (!consent.has(tuple(item))) fail('APPROVAL_TUPLE_MISMATCH', '素材未在本版本固定确认记录中匹配', item.id);
    if (!checked.has(item.filePath)) {
      await mediaFile(root, item); checked.add(item.filePath); result.uniqueBytes += item.bytes;
      if (item.bytes > 50 * 1024 * 1024) result.warnings.push(`${item.id} 超过 GitHub 50 MiB 文件建议值`);
    }
    result.counts.approved++; result.counts.sources[item.source]++; result.counts.mediaTypes[item.mediaType]++;
    result.totalBytes += item.bytes; result.largestBytes = Math.max(result.largestBytes, item.bytes);
  }
  if (tuples.size !== consent.size) fail('APPROVAL_TUPLE_MISMATCH', '固定确认记录包含清单以外的素材');
  result.uniqueMediaFiles = checked.size;
  return result;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const json = process.argv.includes('--json');
  try {
    const unknown = process.argv.slice(2).filter(arg => !['--json', '--help'].includes(arg));
    if (unknown.length) fail('INVALID_ARGUMENT', '仅支持 --json 或 --help');
    if (process.argv.includes('--help')) console.log('npm run media:verify -- [--json]\n核验预置素材路径、字节、SHA256、容器签名及固定确认记录。媒体解码由导入器另行核验。');
    else {
      const result = await verifyBundledMedia();
      console.log(json ? JSON.stringify(result, null, 2) : `预置素材校验通过：${result.counts.total} 项，${result.counts.approved} 项固定确认，${result.uniqueBytes} 字节，最大单文件 ${result.largestBytes} 字节。\n确认版本 SHA256：${result.approval.sha256}${result.warnings.length ? '\n' + result.warnings.join('\n') : ''}`);
    }
  } catch (error) {
    const result = { ok: false, error: { code: error.code || 'VERIFICATION_FAILED', message: error.itemId ? error.message : error.code === 'ENOENT' ? '预置素材目录不存在' : error.message, ...(error.itemId ? { itemId: error.itemId } : {}) } };
    if (json) console.log(JSON.stringify(result, null, 2)); else console.error(`预置素材校验失败 [${result.error.code}]：${result.error.message}${result.error.itemId ? ` (${result.error.itemId})` : ''}`);
    process.exitCode = 1;
  }
}
