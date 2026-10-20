import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizeMaterialKnowledgeDraft } from '../src/services/material-knowledge-schema.js';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'material-knowledge-completeness-'));
process.env.DATABASE_PATH = path.join(tempDir, 'test.db');
process.env.QWEN_MODE = 'mock';
process.env.LOCAL_AGENT_AUTO_START = 'false';
process.env.AUTO_COLLECT_ENABLED = 'false';
process.env.INSTANCE_LOCK_ENABLED = 'false';

const { db } = await import('../src/db.js');
const {
  getMaterialKnowledgeDraft,
  listMaterialKnowledgeDrafts,
  saveMaterialKnowledgeDraft,
  updateMaterialKnowledgeDraft
} = await import('../src/services/material-knowledge-drafts.js');

test.after(() => {
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function completeDraft() {
  const sharedFactPrefix = '办理前需要核对完整的材料与身份信息。'.repeat(70);
  return {
    title: '视频中的完整办理说明',
    summary: '视频逐项说明办理流程和适用条件。'.repeat(400) + '总结末尾例外：未成年人须由监护人陪同。',
    keyFacts: [
      `${sharedFactPrefix}仅适用于首次申请。`,
      `${sharedFactPrefix}再次申请时不适用。`,
      ...Array.from({ length: 33 }, (_, index) => `办理规则第 ${index + 3} 条：须保留对应的受理凭证。`)
    ],
    faqs: Array.from({ length: 25 }, (_, index) => ({
      question: index === 0 ? '申请人在办理过程中已经提交材料但未收到通知时，'.repeat(12) + '节假日是否受理？' : `办理问题 ${index + 1}：如何查询？`,
      answer: index === 24 ? '请逐项核对受理记录与补交材料要求。'.repeat(150) + '答案末尾例外：节假日暂停受理。' : `请通过第 ${index + 1} 个查询入口核对。`
    })),
    uncertainFacts: ['尚未确认的费用减免条件'],
    keywords: ['办理流程', '受理条件'],
    confidence: 0.9
  };
}

function saveInput(overrides = {}) {
  return {
    materialSha256: 'a'.repeat(64),
    generatorVersion: 'knowledge-completeness-test',
    title: '完整办理说明',
    contentMarkdown: '# 完整办理说明\n\n请核对申请条件。',
    ...overrides
  };
}

function assertTooLarge(action) {
  assert.throws(action, error => {
    assert.equal(error.code, 'KNOWLEDGE_DRAFT_CONTENT_TOO_LARGE');
    assert.equal(error.statusCode, 400);
    assert.match(error.message, /100000/);
    return true;
  });
}

test('normalization and database round trip retain every confirmed fact and FAQ with their final conditions', () => {
  const raw = completeDraft();
  const normalized = normalizeMaterialKnowledgeDraft({ ...raw, keyFacts: [...raw.keyFacts, raw.keyFacts[0]] }, {
    materialSha256: 'b'.repeat(64),
    materialFilename: '完整说明.mp4'
  });
  assert.equal(normalized.keyFacts.length, 35, 'only exact duplicate facts may be removed');
  assert.equal(normalized.faqs.length, 25);
  assert.equal(normalized.summary.length, raw.summary.length);
  assert.deepEqual(normalized.keyFacts, raw.keyFacts);
  assert.deepEqual(normalized.faqs, raw.faqs);
  assert.ok(normalized.contentMarkdown.includes(raw.summary));
  assert.ok(normalized.contentMarkdown.includes(raw.keyFacts[34]));
  assert.ok(normalized.contentMarkdown.includes(raw.faqs[24].answer));
  assert.doesNotMatch(normalized.contentMarkdown, /尚未确认的费用减免条件/);

  const saved = saveMaterialKnowledgeDraft(normalized);
  const reread = getMaterialKnowledgeDraft(saved.id);
  assert.equal(reread.summary, raw.summary);
  assert.deepEqual(reread.keyFacts, raw.keyFacts);
  assert.deepEqual(reread.faqs, raw.faqs);
  assert.deepEqual(reread.uncertainFacts, raw.uncertainFacts);
  assert.equal(reread.contentMarkdown, normalized.contentMarkdown.trim());
});

test('saving structured drafts directly retains long content and entries beyond the former storage limits', () => {
  const raw = completeDraft();
  const saved = saveMaterialKnowledgeDraft(saveInput(raw));
  const reread = getMaterialKnowledgeDraft(saved.id);
  assert.equal(reread.keyFacts.length, 35);
  assert.equal(reread.faqs.length, 25);
  assert.equal(reread.summary.length, raw.summary.length);
  assert.equal(reread.summary, raw.summary);
  assert.deepEqual(reread.keyFacts, raw.keyFacts);
  assert.deepEqual(reread.faqs, raw.faqs);
});

test('editing a pending draft retains complete structured content', () => {
  const saved = saveMaterialKnowledgeDraft(saveInput({ materialSha256: 'c'.repeat(64) }));
  const raw = completeDraft();
  const updated = updateMaterialKnowledgeDraft(saved.id, raw);
  assert.equal(updated.keyFacts.length, 35);
  assert.equal(updated.faqs.length, 25);
  assert.equal(updated.summary, raw.summary);
  assert.deepEqual(updated.keyFacts, raw.keyFacts);
  assert.deepEqual(updated.faqs, raw.faqs);
  assert.equal(getMaterialKnowledgeDraft(saved.id).faqs[24].answer, raw.faqs[24].answer);
});

test('normalization rejects oversized generated knowledge instead of returning a partial draft', async t => {
  const cases = [
    ['summary', { summary: '说'.repeat(100_001) }],
    ['fact', { keyFacts: ['条'.repeat(100_001)] }],
    ['FAQ question', { faqs: [{ question: '问'.repeat(100_001), answer: '完整答复' }] }],
    ['FAQ answer', { faqs: [{ question: '适用条件？', answer: '答'.repeat(100_001) }] }],
    ['combined content', { summary: '说'.repeat(60_000), keyFacts: ['条'.repeat(40_000)] }],
    ['uncertain facts', { summary: '已确认内容', uncertainFacts: ['待'.repeat(100_001)] }]
  ];
  for (const [name, raw] of cases) {
    await t.test(name, () => assertTooLarge(() => normalizeMaterialKnowledgeDraft(raw)));
  }
});

test('the full 100000-character Markdown boundary is stored without splitting Unicode characters', () => {
  const contentMarkdown = '知'.repeat(99_999) + '😀';
  const saved = saveMaterialKnowledgeDraft(saveInput({ materialSha256: 'd'.repeat(64), contentMarkdown }));
  assert.equal(getMaterialKnowledgeDraft(saved.id).contentMarkdown, contentMarkdown);
});

test('Windows line endings count toward the limit of the Markdown actually stored', () => {
  const contentMarkdown = '知\r\n'.repeat(40_000) + '末尾条件';
  assertTooLarge(() => saveMaterialKnowledgeDraft(saveInput({ materialSha256: '2'.repeat(64), contentMarkdown })));
});

test('oversized Markdown is rejected before inserting or replacing a saved draft', () => {
  const existing = saveMaterialKnowledgeDraft(saveInput({ materialSha256: 'e'.repeat(64) }));
  const countBefore = listMaterialKnowledgeDrafts({ includeImported: true }).length;
  const contentMarkdown = '知'.repeat(100_000) + '必须保留的末尾条件';
  assertTooLarge(() => saveMaterialKnowledgeDraft(saveInput({ materialSha256: 'f'.repeat(64), contentMarkdown })));
  assert.equal(listMaterialKnowledgeDrafts({ includeImported: true }).length, countBefore);
  assertTooLarge(() => saveMaterialKnowledgeDraft(saveInput({ materialSha256: 'e'.repeat(64), contentMarkdown })));
  assert.deepEqual(getMaterialKnowledgeDraft(existing.id), existing);
  assertTooLarge(() => updateMaterialKnowledgeDraft(existing.id, { contentMarkdown }));
  assert.deepEqual(getMaterialKnowledgeDraft(existing.id), existing);
});

test('a short Markdown field cannot bypass size validation of the structured knowledge', async t => {
  const existing = saveMaterialKnowledgeDraft(saveInput({ materialSha256: '1'.repeat(64) }));
  const cases = [
    ['summary', { summary: '说'.repeat(100_001) }],
    ['facts', { keyFacts: ['甲'.repeat(60_000), '乙'.repeat(40_000)] }],
    ['FAQ answers', { faqs: [{ question: '条件？', answer: '答'.repeat(100_001) }] }],
    ['uncertain facts', { uncertainFacts: ['待'.repeat(100_001)] }]
  ];
  for (const [name, fields] of cases) {
    await t.test(name, () => {
      assertTooLarge(() => saveMaterialKnowledgeDraft(saveInput({ materialSha256: '1'.repeat(64), ...fields })));
      assert.deepEqual(getMaterialKnowledgeDraft(existing.id), existing);
      assertTooLarge(() => updateMaterialKnowledgeDraft(existing.id, fields));
      assert.deepEqual(getMaterialKnowledgeDraft(existing.id), existing);
    });
  }
});
