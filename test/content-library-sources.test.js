import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { collectContentLibrarySources } from '../src/services/content-library-sources.js';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'content-library-sources-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function file(path, contents = 'media-fixture') {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents);
}

async function json(path, value) {
  await file(path, JSON.stringify(value));
}

async function signalRun(root, id, validation = { full_decode: 'passed' }) {
  await json(join(root, 'runs', id, 'script.json'), { title: id, created_at: '2026-10-20T00:00:00Z' });
  await json(join(root, 'runs', id, 'validation.json'), validation);
  await file(join(root, 'runs', id, 'video.mp4'));
}

test('unconfigured and unreadable sources are isolated and do not expose filesystem paths', async t => {
  const root = await fixture(t);
  await signalRun(root, 'complete');
  const result = await collectContentLibrarySources({
    contentLibrarySignalRoot: root,
    contentLibraryEditingRoot: join(root, 'missing-private-directory'),
  });
  assert.equal(result.entries.length, 1);
  assert.deepEqual(result.sources.map(item => [item.id, item.enabled, item.online]), [
    ['automatic', true, true], ['editing', true, false], ['creation', false, false],
  ]);
  assert.ok(!JSON.stringify(result.sources).includes(root));
  const disabled = await collectContentLibrarySources({ contentLibrarySignalRoot: 'relative/path' });
  assert.equal(disabled.entries.length, 0);
  assert.ok(disabled.sources.every(source => !source.enabled));
});

test('Signal requires passed decode, ignores rejected/orphan videos and keeps human selection separate', async t => {
  const root = await fixture(t);
  await signalRun(root, 'selected');
  await signalRun(root, 'unreviewed');
  await signalRun(root, 'rejected');
  await signalRun(root, 'unfinished', { full_decode: 'failed' });
  await file(join(root, 'runs/orphan/video.mp4'));
  await json(join(root, 'data/library-review.json'), { runs: { rejected: { decision: 'rejected' } } });
  await json(join(root, 'data/comparisons/compare-one.json'), {
    selected_styles: ['agent-c'], agents: [{ agent_id: 'agent-c', run: 'selected' }],
  });
  const result = await collectContentLibrarySources({ contentLibrarySignalRoot: root });
  assert.deepEqual(result.entries.map(entry => entry.sourceId).sort(), ['selected', 'unreviewed']);
  assert.equal(result.entries.find(entry => entry.sourceId === 'selected').reviewStatus, 'selected');
  assert.equal(result.entries.find(entry => entry.sourceId === 'unreviewed').reviewStatus, 'unreviewed');
  assert.ok(result.entries.every(entry => entry.artifactType === 'final_video'));
});

test('Signal rejects media and metadata symlinks outside its configured root', async t => {
  const root = await fixture(t);
  const source = join(root, 'source');
  const outside = join(root, 'outside');
  await file(join(outside, 'video.mp4'));
  await json(join(outside, 'script.json'), { title: 'Private metadata' });
  await signalRun(source, 'escaped-media');
  await rm(join(source, 'runs/escaped-media/video.mp4'));
  await symlink(join(outside, 'video.mp4'), join(source, 'runs/escaped-media/video.mp4'));
  await signalRun(source, 'escaped-metadata');
  await rm(join(source, 'runs/escaped-metadata/script.json'));
  await symlink(join(outside, 'script.json'), join(source, 'runs/escaped-metadata/script.json'));
  const result = await collectContentLibrarySources({ contentLibrarySignalRoot: source });
  assert.equal(result.entries.length, 0);
  assert.equal(result.sources[0].online, true);
});

test('OpenChatCut only discovers successful export jobs with a matching local output', async t => {
  const root = await fixture(t);
  await file(join(root, 'media/uploads/final.mp4'));
  await file(join(root, 'media/uploads/unlisted.mp4'));
  const makeJob = (id, changes = {}) => ({
    id, status: 'succeeded', createdAt: 1792454400000,
    params: { kind: 'export', format: 'video', name: id },
    result: { kind: 'video', path: '/media/uploads/final.mp4', name: id, sizeBytes: 13 },
    ...changes,
  });
  const jobs = [
    makeJob('complete'),
    makeJob('partial', { params: { kind: 'export', format: 'video', frameRange: [0, 30] } }),
    makeJob('running', { status: 'running' }),
    makeJob('failed', { status: 'failed' }),
    makeJob('generation', { params: { kind: 'generation', format: 'video' } }),
    makeJob('mismatched-size', { result: { kind: 'video', path: '/media/uploads/final.mp4', sizeBytes: 999 } }),
    makeJob('escaped', { result: { kind: 'video', path: '/media/uploads/../final.mp4' } }),
    makeJob('remote', { result: { kind: 'video', path: 'https://untrusted.test/final.mp4' } }),
  ];
  const db = new DatabaseSync(join(root, 'project-store-v1.sqlite3'));
  db.exec('CREATE TABLE kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)');
  db.prepare('INSERT INTO kv(k,v) VALUES (?,?)').run('generation-jobs:snapshot', JSON.stringify({ version: 1, jobs }));
  db.prepare('INSERT INTO kv(k,v) VALUES (?,?)').run('credentials', 'not-json-do-not-read');
  db.close();
  const result = await collectContentLibrarySources({ contentLibraryEditingRoot: root });
  assert.deepEqual(result.entries.map(entry => entry.sourceId).sort(), ['complete', 'partial']);
  assert.equal(result.entries.find(entry => entry.sourceId === 'complete').artifactType, 'final_video');
  assert.equal(result.entries.find(entry => entry.sourceId === 'partial').artifactType, 'video_clip');
  assert.ok(result.entries.every(entry => entry.reviewStatus === 'unreviewed'));
});

test('Toonflow discovers only linked completed canvas outputs and labels video as a clip', async t => {
  const root = await fixture(t);
  const workspaces = join(root, 'workspaces');
  const project = join(workspaces, 'project-one');
  await file(join(project, 'assets/generated.png'));
  await file(join(project, 'assets/preview.mp4'));
  await file(join(project, 'assets/orphan.mp4'));
  await file(join(root, 'private.png'));
  await symlink(join(root, 'private.png'), join(project, 'assets/escaped.png'));
  const node = (id, type, mediaType, url, extra = {}) => ({
    id, type, data: { label: id, outputs: { media: { dataType: mediaType, value: { url } } }, ...extra },
  });
  await json(join(project, 'canvas.json'), { toonflowCanvas: true, nodes: [
    node('generated-image', 'remote-imageGenerationNode', 'IMAGE', 'assets/generated.png'),
    node('duplicate-image', 'remote-imageGenerationNode', 'IMAGE', 'assets/generated.png'),
    node('preview-not-final', 'remote-videoNode', 'VIDEO', 'assets/preview.mp4'),
    node('running', 'remote-videoGenerationNode', 'VIDEO', 'assets/orphan.mp4', { isGenerating: true }),
    node('uploaded-input', 'remote-imageNode', 'IMAGE', 'assets/escaped.png'),
    node('symlink', 'remote-imageGenerationNode', 'IMAGE', 'assets/escaped.png'),
    node('traversal', 'remote-imageGenerationNode', 'IMAGE', '../private.png'),
    node('remote', 'remote-imageGenerationNode', 'IMAGE', 'https://untrusted.test/image.png'),
  ] });
  await json(join(project, 'not-a-canvas.json'), { nodes: [node('fake', 'remote-videoNode', 'VIDEO', 'assets/orphan.mp4')] });
  const result = await collectContentLibrarySources({ contentLibraryCreationRoot: workspaces });
  assert.equal(result.entries.length, 2);
  assert.deepEqual(result.entries.map(entry => entry.artifactType).sort(), ['image', 'video_clip']);
  assert.ok(result.entries.every(entry => entry.reviewStatus === 'unreviewed'));
  const canonicalRoot = await realpath(workspaces);
  assert.ok(result.entries.every(entry => entry.filePath.startsWith(`${canonicalRoot}/`)));
});
