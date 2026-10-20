import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-alias-'));
process.env.DATABASE_PATH = path.join(dir, 'test.db');
process.env.QWEN_MODE = 'mock';
process.env.LOCAL_AGENT_AUTO_START = 'false';
process.env.AUTO_COLLECT_ENABLED = 'false';

const dbModule = await import('../src/db.js');
const aliasModule = await import('../src/services/knowledge-alias.js');
const knowledgeModule = await import('../src/services/knowledge.js');
const { db, now, row, rows, run } = dbModule;
const {
  applySemanticRules,
  normalizeAliasText,
  processKnowledgeAliasQueue,
  queueKnowledgeAliasGeneration,
  setKnowledgeAliasSelections
} = aliasModule;
const { searchKnowledge } = knowledgeModule;
const { detectChineseScript } = await import('../src/services/qwen.js');

test.after(() => {
  try { db.close(); } catch {}
  fs.rmSync(dir, { recursive: true, force: true });
});

test('公共同义规则统一“行不行/可不可以”等表达', () => {
  assert.equal(normalizeAliasText(applySemanticRules('这个行不行？')), normalizeAliasText(applySemanticRules('这个可不可以')));
  assert.equal(normalizeAliasText(applySemanticRules('活动要不要钱')), normalizeAliasText(applySemanticRules('活动是否收费')));
});

test('生成相似问法后可召回对应知识，删除知识会级联删除问法和任务', async () => {
  const stamp = now();
  const knowledgeId = Number(run(`INSERT INTO knowledge(question,answer,keywords,status,version,source,review_status,category,subcategory,created_at,updated_at)
    VALUES(?,?,?,'PUBLISHED',1,'MANUAL','APPROVED','公共知识库','活动咨询',?,?)`,
    '参加社区活动是否可以带孩子？', '可以带孩子参加，现场请由监护人照看。', '活动,孩子,小孩', stamp, stamp).lastInsertRowid);

  const task = queueKnowledgeAliasGeneration(knowledgeId, { requestedBy: 'test' });
  assert.equal(task.status, 'QUEUED');
  await processKnowledgeAliasQueue();

  const completed = row('SELECT * FROM knowledge_alias_generation_tasks WHERE id=?', task.id);
  assert.equal(completed.status, 'COMPLETED');
  assert.ok(completed.generated_count > 0);
  assert.ok(rows('SELECT * FROM knowledge_aliases WHERE knowledge_id=?', knowledgeId).length > 0);

  const candidates = searchKnowledge('社区活动能不能带小孩？', 3, 'douyin');
  assert.equal(candidates[0]?.id, knowledgeId);
  assert.ok(candidates[0]?.score >= 0.58);

  run('DELETE FROM knowledge WHERE id=?', knowledgeId);
  assert.equal(row('SELECT id FROM knowledge_aliases WHERE knowledge_id=?', knowledgeId), undefined);
  assert.equal(row('SELECT id FROM knowledge_alias_generation_tasks WHERE knowledge_id=?', knowledgeId), undefined);
});


test('能识别简体和繁体知识的主要文字形式', () => {
  assert.equal(detectChineseScript('內地支付寶如何綁定銀行卡？'), 'traditional');
  assert.equal(detectChineseScript('内地支付宝如何绑定银行卡？'), 'simplified');
});

test('运营人员可以按知识批量勾选启用相似问法', () => {
  const stamp = now();
  const knowledgeId = Number(run(`INSERT INTO knowledge(question,answer,keywords,status,version,source,review_status,category,subcategory,created_at,updated_at)
    VALUES(?,?,?,'PUBLISHED',1,'MANUAL','APPROVED','公共知识库','测试',?,?)`, '报名结果怎么查询？', '请在报名记录中查询。', '报名,查询', stamp, stamp).lastInsertRowid);
  const first = Number(run(`INSERT INTO knowledge_aliases(knowledge_id,knowledge_version,alias_text,normalized_text,source,status,confidence,validation_status,created_at,updated_at)
    VALUES(?,1,'怎么查看报名结果','怎么查看报名结果','AI','ENABLED',0.92,'VALID',?,?)`, knowledgeId, stamp, stamp).lastInsertRowid);
  const second = Number(run(`INSERT INTO knowledge_aliases(knowledge_id,knowledge_version,alias_text,normalized_text,source,status,confidence,validation_status,created_at,updated_at)
    VALUES(?,1,'报名成功了吗','报名成功了吗','AI','ENABLED',0.92,'VALID',?,?)`, knowledgeId, stamp, stamp).lastInsertRowid);
  const result = setKnowledgeAliasSelections(knowledgeId, [second]);
  assert.equal(result.enabled, 1);
  assert.equal(row('SELECT status FROM knowledge_aliases WHERE id=?', first).status, 'DISABLED');
  assert.equal(row('SELECT status FROM knowledge_aliases WHERE id=?', second).status, 'ENABLED');
});
