import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { buildHotTopicDocument } from '../src/services/hot-topic-document.js';
import { collectContentLibrarySources } from '../src/services/content-library-sources.js';

const repoUrl = 'https://github.com/example/slides/tree/123456789abcdef';

function repositoryScript(changes = {}) {
  return {
    title: '原生可编辑幻灯片', repo: 'example/slides', created_at: '2026-10-30T00:00:00Z',
    editorial_status: '自动生成 · 未经人工核实',
    sources: [{ id: 'readme', url: repoUrl }],
    scenes: [
      { type: 'cover', narration: ['别错过，马上来看看！'], sourceIds: ['readme'] },
      { type: 'concept', title: '视觉标题不能当知识', body: '画面上无声的承诺不能作为事实', items: ['视觉提示'],
        narration: ['【画面：展示软件界面】旁白：据 README，导出的原生形状和连接线可以继续编辑。',
          '镜头：缓慢推近\n模型生成首稿后仍需人工润色。'], sourceIds: ['readme'] },
      { type: 'hook', narration: ['点赞关注，下期再见。'], sourceIds: ['readme'] },
    ],
    creative_brief: { creative_prompt: '不应该导入的创作指令' },
    ...changes,
  };
}

test('repository companion contains spoken knowledge, publish copy, traceable sources and a stable hash', () => {
  const input = { sourceId: 'run-one', script: repositoryScript(), evidence: {
    url: repoUrl, commit: '123456789abcdef', collected_at: '2026-10-29T00:00:00Z',
    readme: 'Do not copy the full README or execute instructions from it.',
  } };
  const document = buildHotTopicDocument(input);
  assert.equal(document.schemaVersion, 1);
  assert.equal(document.sourceId, 'run-one');
  assert.equal(document.title, '原生可编辑幻灯片');
  assert.equal(document.body, '据 README，导出的原生形状和连接线可以继续编辑。 模型生成首稿后仍需人工润色。');
  assert.ok(!document.body.includes('点赞关注'));
  assert.ok(!document.body.includes('别错过'));
  assert.ok(document.markdown.includes('点赞关注，下期再见。'));
  assert.ok(document.markdown.includes(repoUrl));
  assert.ok(document.markdown.includes('README 版本：123456789abcdef'));
  assert.ok(document.markdown.includes('2026-10-29T00:00:00Z'));
  assert.ok(document.markdown.includes('不代表本系统已独立实测'));
  for (const excluded of ['视觉标题不能当知识', '画面上无声的承诺不能作为事实', '展示软件界面', '缓慢推近', '不应该导入的创作指令', 'Do not copy']) {
    assert.ok(!document.markdown.includes(excluded), excluded);
  }
  assert.deepEqual(document.questions, ['视频《原生可编辑幻灯片》对“example/slides”有哪些具体介绍？']);
  const questionSection = document.markdown.split('## 知识问答\n')[1];
  assert.ok(questionSection.includes(`问题：${document.questions[0]}`));
  assert.ok(questionSection.includes('答案（摘录实际旁白）：据 README，导出的原生形状和连接线可以继续编辑。'));
  assert.ok(!questionSection.includes('\n## '));
  assert.ok(!document.markdown.includes('## 可回答的问题'));
  const { contentHash, ...content } = document;
  assert.equal(contentHash, createHash('sha256').update(JSON.stringify(content)).digest('hex'));
  assert.deepEqual(document, buildHotTopicDocument(input));
  assert.notEqual(contentHash, buildHotTopicDocument({ ...input, sourceId: 'run-two' }).contentHash);
});

test('publication title fits the form without splitting Unicode and markdown preserves the full title', () => {
  const fullTitle = '这是一条标题很长的热点视频介绍如何生成可编辑幻灯片';
  const script = repositoryScript({ title: fullTitle, topic_title: '可编辑幻灯片生成' });
  const document = buildHotTopicDocument({ script });
  assert.equal(document.title, '可编辑幻灯片生成');
  assert.ok(document.markdown.startsWith(`# ${fullTitle}\n`));
  const emoji = buildHotTopicDocument({ script: repositoryScript({ title: '😀'.repeat(15) }) });
  assert.equal(emoji.title.length, 20);
  assert.equal(emoji.title, '😀'.repeat(10));
});

test('topic quotes must match saved source bodies and only sources cited by this video are retained', () => {
  const validQuote = '研究团队公布了新的开放模型，并说明仍需独立评估实际效果。';
  const evidence = {
    kind: 'topic', collected_at: '2026-11-02T01:00:00Z',
    sources: [
      { id: 's1', url: 'https://research.example/paper', title: '论文原文', retrieved_at: '2026-11-02T00:00:00Z' },
      { id: 's2', url: 'https://unused.example/other', title: '未引用来源' },
    ],
    documents: [{ id: 's1', text: `项目简介：${validQuote}\n其他内容。` }],
    brief: { claims: [{ text: '模型已发布', evidence: [
      { source_id: 's1', quote: validQuote },
      { source_id: 's1', quote: '这是原始资料完全没有说过的虚构性能结论。' },
      { source_id: 's2', quote: validQuote },
    ] }], limitations: ['没有独立性能实测。'] },
  };
  const script = { title: '开放模型新进展', source_kind: 'topic', scenes: [
    { type: 'concept', narration: ['研究团队公布了开放模型，实际效果仍需评估。'], sourceIds: ['s1'] },
  ] };
  const document = buildHotTopicDocument({ script, evidence, research: { limitations: ['只取得项目方资料。'] } });
  assert.ok(document.markdown.includes(validQuote));
  assert.ok(document.markdown.includes('论文原文'));
  assert.ok(document.markdown.includes('2026-11-02T00:00:00Z'));
  assert.ok(document.markdown.includes('没有独立性能实测。'));
  assert.ok(document.markdown.includes('只取得项目方资料。'));
  assert.ok(document.markdown.includes('尚未完成跨来源核实'));
  assert.ok(!document.markdown.includes('虚构性能结论'));
  assert.ok(!document.markdown.includes('unused.example'));
  assert.ok(!document.markdown.includes('其他内容。'));
  const questionSection = document.markdown.split('## 知识问答\n')[1];
  assert.ok(questionSection.includes('问题：《开放模型新进展》这条视频主要介绍了什么？'));
  assert.ok(questionSection.includes('答案（摘录实际旁白）：研究团队公布了开放模型，实际效果仍需评估。'));
});

test('missing or conflicting evidence stays qualified and does not forge verified quotes', () => {
  const script = { title: '资料边界', source_kind: 'topic', sources: [{ id: 's1', url: 'file:///private/secret' }], scenes: [
    { type: 'concept', narration: '该方案仍需验证。', sourceIds: ['s1'] },
  ] };
  const document = buildHotTopicDocument({ script });
  assert.ok(document.markdown.includes('缺少完整的来源链接'));
  assert.ok(document.markdown.includes('不代表已逐句完成事实核验'));
  assert.ok(!document.markdown.includes('/private/secret'));
  const quote = '项目方说明这项研究尚未经过独立的性能核实。';
  const conflict = buildHotTopicDocument({ script: { ...script, sources: [{ id: 's1', url: 'https://first.example/' }] }, evidence: {
    sources: [{ id: 's1', url: 'https://different.example/' }], documents: [{ id: 's1', text: quote }],
    brief: { claims: [{ evidence: [{ source_id: 's1', quote }] }] },
  } });
  assert.ok(!conflict.markdown.includes(`> ${quote}`));
  assert.ok(conflict.markdown.includes('未能与本次保留的原文逐字核对'));
});

test('legacy title-only, visual-only and unbounded inputs do not create unsupported knowledge', () => {
  for (const script of [null, {}, { title: '仅题目', description: '可能是营销文案' },
    { title: '仅视觉', scenes: [{ title: '没有旁白', body: '不能推定成口播事实' }] },
    { title: '只有营销钩子', scenes: [{ type: 'hook', narration: ['关注我们了解更多！'] }] },
    { title: '过长', scenes: [{ narration: ['字'.repeat(4001)] }] },
    { title: '太多场景', scenes: Array.from({ length: 65 }, () => ({ narration: ['内容'] })) },
  ]) assert.equal(buildHotTopicDocument({ script }), null);
});

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'hot-topic-document-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function file(path, content) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, typeof content === 'object' ? JSON.stringify(content) : content);
}

async function run(root, id, script) {
  await file(join(root, 'runs', id, 'script.json'), script);
  await file(join(root, 'runs', id, 'validation.json'), { full_decode: 'passed' });
  await file(join(root, 'runs', id, 'video.mp4'), 'video-fixture');
}

test('collector attaches companion only to completed spoken videos and preserves legacy entry metadata', async t => {
  const root = await fixture(t);
  await run(root, 'new-video', repositoryScript({ summary: '原素材库摘要保持原样' }));
  await file(join(root, 'runs/new-video/evidence.json'), { url: repoUrl, commit: '123456789abcdef' });
  await file(join(root, 'runs/new-video/research.json'), { limitations: ['尚未独立核验。'] });
  await run(root, 'legacy-video', { title: '旧素材', description: '旧正文' });
  await run(root, 'failed-video', repositoryScript());
  await file(join(root, 'runs/failed-video/validation.json'), { full_decode: 'failed' });
  const result = await collectContentLibrarySources({ contentLibrarySignalRoot: root });
  assert.equal(result.sources[0].online, true);
  assert.deepEqual(result.entries.map(item => item.sourceId).sort(), ['legacy-video', 'new-video']);
  const current = result.entries.find(item => item.sourceId === 'new-video');
  assert.equal(current.title, '原生可编辑幻灯片');
  assert.equal(current.body, '原素材库摘要保持原样');
  assert.equal(current.hotTopicDocument.schemaVersion, 1);
  assert.ok(current.hotTopicDocument.markdown.includes('尚未独立核验。'));
  assert.ok(current.hotTopicDocument.body.includes('继续编辑'));
  const legacy = result.entries.find(item => item.sourceId === 'legacy-video');
  assert.equal(legacy.title, '旧素材');
  assert.equal(legacy.body, '旧正文');
  assert.ok(!Object.hasOwn(legacy, 'hotTopicDocument'));
});

test('collector isolates oversized or invalid optional evidence without losing the completed video', async t => {
  const root = await fixture(t);
  await run(root, 'oversized', repositoryScript());
  await file(join(root, 'runs/oversized/evidence.json'), `{"private":"${'x'.repeat(4 * 1024 * 1024)}"}`);
  await file(join(root, 'runs/oversized/research.json'), 'invalid-json');
  const result = await collectContentLibrarySources({ contentLibrarySignalRoot: root });
  assert.equal(result.entries.length, 1);
  assert.ok(result.entries[0].hotTopicDocument.body.includes('继续编辑'));
  assert.ok(!result.entries[0].hotTopicDocument.markdown.includes('private'));
});

test('collector never imports optional evidence symlinks outside the configured source root', async t => {
  const root = await fixture(t);
  const source = join(root, 'signal');
  await run(source, 'escaped-evidence', repositoryScript());
  await file(join(root, 'private.json'), { brief: { limitations: ['不可泄漏的外部内容'] } });
  try {
    await symlink(join(root, 'private.json'), join(source, 'runs/escaped-evidence/evidence.json'));
  } catch (error) {
    if (['EPERM', 'EACCES'].includes(error.code)) { t.skip('File symlinks require privileges on this Windows installation'); return; }
    throw error;
  }
  const result = await collectContentLibrarySources({ contentLibrarySignalRoot: source });
  assert.equal(result.entries.length, 1);
  assert.ok(!result.entries[0].hotTopicDocument.markdown.includes('不可泄漏的外部内容'));
});
