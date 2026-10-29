import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

// This digest pins the explicit consent snapshot shipped with this release.
// Editing a manifest or adding a future output never expands that consent.
export const BUNDLED_CONTENT_APPROVAL_SHA256 = 'f6e17e3f9aeb13d4ed6b4564f8ef67b03a64e33c02533818a0fd4d374afcb400';
const sourceTypes = new Set(['automatic', 'editing', 'creation']);
const extensions = new Set(['.mp4', '.mov', '.m4v', '.webm', '.png', '.jpg', '.jpeg', '.webp']);
const allItems = snapshot => [...snapshot.items, ...snapshot.pendingItems, ...snapshot.rejectedItems];
const tuple = item => JSON.stringify([item.source, item.sourceId, item.sha256, item.bytes]);
const validConsentItem = item => item && sourceTypes.has(item.source) && typeof item.sourceId === 'string' && item.sourceId.trim()
  && item.sourceId.length <= 512 && /^[a-f0-9]{64}$/.test(item.sha256 || '') && Number.isSafeInteger(item.bytes) && item.bytes > 0;
function validItem(item) {
  return validConsentItem(item) && /^[A-Za-z0-9_-]{1,160}$/.test(item.id || '')
    && typeof item.title === 'string' && item.title.length <= 500
    && ['final_video', 'video_clip', 'image'].includes(item.artifactType)
    && typeof item.filename === 'string' && item.filename.length <= 255 && !/[\\/:\x00-\x1f\x7f]/.test(item.filename)
    && extensions.has(path.extname(item.filename).toLowerCase())
    && typeof item.filePath === 'string' && item.filePath.length <= 1000 && !path.posix.isAbsolute(item.filePath)
    && !/[\\\x00-\x1f\x7f]/.test(item.filePath) && item.filePath.split('/').every(part => part && part !== '.' && part !== '..')
    && item.filePath === `media/${item.sha256}${path.extname(item.filename).toLowerCase()}`;
}
async function boundedJson(file, maxBytes = 2 * 1024 * 1024) {
  const handle = await fsp.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxBytes) throw new Error('Invalid seed metadata');
    const buffer = Buffer.alloc(maxBytes + 1);
    let length = 0;
    for (;;) { const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length); if (!bytesRead) break; length += bytesRead; if (length > maxBytes) throw new Error('Invalid seed metadata'); }
    const bytes = buffer.subarray(0, length);
    return { value: JSON.parse(bytes.toString('utf8')), sha256: createHash('sha256').update(bytes).digest('hex') };
  } finally { await handle.close(); }
}
async function openSeedFile(root, item) {
  const parts = item.filePath.split('/');
  let current = root;
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part);
    const stat = await fsp.lstat(current);
    if (stat.isSymbolicLink() || (index === parts.length - 1 ? !stat.isFile() : !stat.isDirectory())) throw new Error('Invalid seed media');
  }
  if (await fsp.realpath(current) !== current) throw new Error('Invalid seed media');
  const handle = await fsp.open(current, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  const stat = await handle.stat();
  if (!stat.isFile() || stat.size !== item.bytes) { await handle.close(); throw new Error('Seed media changed'); }
  return handle;
}

export function createContentLibrarySeedLoader({ library, root, enabled = true, approvalSha256 = BUNDLED_CONTENT_APPROVAL_SHA256 }) {
  let inFlight;
  async function run() {
    const result = { enabled, imported: 0, approved: 0, retained: 0, failed: 0, items: [], warnings: [] };
    if (!enabled) return result;
    let resolvedRoot, manifest;
    try {
      const stat = await fsp.lstat(root);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Invalid seed root');
      resolvedRoot = await fsp.realpath(root);
      manifest = (await boundedJson(path.join(resolvedRoot, 'manifest.json'))).value;
      if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.items) || manifest.items.length > 1000) throw new Error('Invalid manifest');
    } catch (failure) {
      if (failure.code !== 'ENOENT') result.warnings.push('预置素材清单不可读取，已保留现有素材与审核记录');
      return result;
    }
    let authorization = null, consent = new Set();
    try {
      const file = await boundedJson(path.join(resolvedRoot, 'approval.json'));
      const value = file.value;
      if (!/^[a-f0-9]{64}$/.test(approvalSha256) || file.sha256 !== approvalSha256 || value.schemaVersion !== 1
        || typeof value.actor !== 'string' || !value.actor.trim() || value.actor.length > 200
        || typeof value.basis !== 'string' || !value.basis.trim() || value.basis.length > 4000
        || !Number.isFinite(Date.parse(value.approvedAt)) || !Array.isArray(value.items) || value.items.length > 1000
        || value.items.some(item => !validConsentItem(item))) throw new Error('Invalid fixed consent');
      authorization = { actor: value.actor, basis: value.basis, approvedAt: value.approvedAt, authorizationSha256: file.sha256 };
      consent = new Set(value.items.map(tuple));
    } catch { result.warnings.push('预置素材没有匹配本版本的固定确认记录，未审核的新素材将保持待确认'); }
    const seen = new Set();
    for (const item of manifest.items) {
      let handle, stream;
      try {
        if (!validItem(item) || seen.has(item.id)) throw new Error('Invalid seed item');
        seen.add(item.id);
        handle = await openSeedFile(resolvedRoot, item);
        const before = allItems(await library.list()).find(record => record.source === item.source && record.sourceId === item.sourceId && record.sha256 === item.sha256 && record.sizeBytes === item.bytes);
        stream = handle.createReadStream({ autoClose: false });
        const received = await library.receive(stream, {
          source: item.source, filename: item.filename, title: item.title, artifactType: item.artifactType,
        }, 'bundled-content-import', { sourceId: item.sourceId, contentLength: item.bytes, expectedBytes: item.bytes, expectedSha256: item.sha256 });
        if (!before) result.imported += 1;
        let material = received.item, applied = false;
        if (authorization && consent.has(tuple(item))) {
          const decision = await library.admitSeed(material.id, authorization);
          material = decision.item; applied = decision.applied;
        }
        if (applied) result.approved += 1; else result.retained += 1;
        result.items.push({ id: item.id, materialId: material.id, status: material.admissionStatus, approvalApplied: applied });
      } catch {
        result.failed += 1;
        result.items.push({ id: typeof item?.id === 'string' ? item.id.slice(0, 160) : null, error: '预置素材未通过路径、文件或 SHA256 校验，已跳过' });
      } finally { stream?.destroy(); await handle?.close(); }
    }
    if (result.failed) result.warnings.push(`${result.failed} 条预置素材未通过校验，其余素材已保留`);
    return result;
  }
  return { load() { if (!inFlight) inFlight = run().finally(() => { inFlight = null; }); return inFlight; } };
}
