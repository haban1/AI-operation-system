import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { verifyBundledMedia } from '../scripts/verify-bundled-media.mjs';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jr1kAAAAASUVORK5CYII=', 'base64');
const sha256 = data => createHash('sha256').update(data).digest('hex');

async function fixture(t, content = png) {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'bundled-media-check-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const hash = sha256(content);
  const item = { id: 'fixture-image', source: 'creation', sourceId: 'fixture-source', title: '测试素材', artifactType: 'image', filename: `${hash}.png`, filePath: `media/${hash}.png`, bytes: content.length, sha256: hash, mediaType: 'image' };
  const manifest = { schemaVersion: 1, items: [item] };
  const approval = { schemaVersion: 1, actor: 'fixture-reviewer', basis: 'Explicit fixture approval', approvedAt: '2026-10-29T00:00:00Z', items: [{ source: item.source, sourceId: item.sourceId, sha256: hash, bytes: content.length }] };
  await fs.mkdir(path.join(root, 'media'));
  const mediaPath = path.join(root, item.filePath);
  await fs.writeFile(mediaPath, content);
  const manifestPath = path.join(root, 'manifest.json');
  const writeManifest = () => fs.writeFile(manifestPath, JSON.stringify(manifest));
  const writeApproval = async () => {
    const bytes = Buffer.from(JSON.stringify(approval));
    await fs.writeFile(path.join(root, 'approval.json'), bytes);
    return sha256(bytes);
  };
  await writeManifest();
  const approvalSha256 = await writeApproval();
  return { root, item, manifest, approval, manifestPath, mediaPath, writeManifest, writeApproval, options: { manifestPath, approvalSha256 } };
}

test('verifier reports portable counts and the pinned approval version for matching bytes', async t => {
  const context = await fixture(t);
  const result = await verifyBundledMedia(context.options);
  assert.equal(result.ok, true);
  assert.equal(result.counts.total, 1);
  assert.equal(result.counts.approved, 1);
  assert.deepEqual(result.counts.sources, { automatic: 0, editing: 0, creation: 1 });
  assert.deepEqual(result.counts.mediaTypes, { video: 0, image: 1 });
  assert.equal(result.uniqueBytes, png.length);
  assert.equal(result.approval.sha256, context.options.approvalSha256);
  assert.ok(!JSON.stringify(result).includes(context.root));
});

test('changed media bytes with the same length fail SHA256 validation', async t => {
  const context = await fixture(t);
  const changed = Buffer.from(png); changed[changed.length - 1] ^= 1;
  await fs.writeFile(context.mediaPath, changed);
  await assert.rejects(verifyBundledMedia(context.options), { code: 'SHA256_MISMATCH' });
});

test('missing media fails instead of accepting manifest metadata', async t => {
  const context = await fixture(t);
  await fs.unlink(context.mediaPath);
  await assert.rejects(verifyBundledMedia(context.options), { code: 'MISSING_MEDIA' });
});

test('paths escaping the media directory and symlink media are rejected', async t => {
  const context = await fixture(t);
  context.item.filePath = '../outside.png'; await context.writeManifest();
  await assert.rejects(verifyBundledMedia(context.options), { code: 'UNTRUSTED_PATH' });
  context.item.filePath = `media/${context.item.sha256}.png`; await context.writeManifest();
  const outside = path.join(context.root, 'outside.png');
  await fs.rename(context.mediaPath, outside); await fs.symlink(outside, context.mediaPath);
  await assert.rejects(verifyBundledMedia(context.options), { code: 'UNTRUSTED_PATH' });
});

test('approval must match both the code lock and the complete source-content tuple', async t => {
  const context = await fixture(t);
  await assert.rejects(verifyBundledMedia({ ...context.options, approvalSha256: '0'.repeat(64) }), { code: 'APPROVAL_LOCK_MISMATCH' });
  context.approval.items[0].sourceId = 'another-source';
  const approvalSha256 = await context.writeApproval();
  await assert.rejects(verifyBundledMedia({ ...context.options, approvalSha256 }), { code: 'APPROVAL_TUPLE_MISMATCH' });
});

test('renaming arbitrary data to a media extension does not pass its container signature', async t => {
  const context = await fixture(t, Buffer.from('This is not an image file.'));
  await assert.rejects(verifyBundledMedia(context.options), { code: 'MEDIA_SIGNATURE_MISMATCH' });
});
