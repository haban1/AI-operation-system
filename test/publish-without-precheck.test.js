import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { buildMockAiReview } from '../src/services/ai-compliance.js';
import { readMaterialInfo } from '../src/services/material-info.js';
import { startServer, stopChild, cleanupDir, jsonRequest } from './helpers/runtime.js';

test('发布接口无需素材预检，保留审核绑定、账号验证和防重发', async t => {
  const runtime = await startServer({ env: { RAG_AUTO_START: 'false', RAG_ADMIN_ENABLED: 'false', CONTENT_LIBRARY_SEED_ENABLED: 'false' } });
  const db = new DatabaseSync(runtime.dbPath);
  t.after(async () => { db.close(); await stopChild(runtime.child); cleanupDir(runtime.dir); });
  db.prepare("UPDATE accounts SET login_status='READY' WHERE platform_code='douyin'").run();
  const account = db.prepare("SELECT id FROM accounts WHERE platform_code='douyin' AND enabled=1 LIMIT 1").get();
  const file = path.join(runtime.dir, 'without-parser.mp4');
  fs.writeFileSync(file, 'video bytes without a successful media preflight');
  const payload = {
    title: '社区服务介绍', body: '欢迎了解社区服务和活动安排。', materialPath: file,
    contentOrigin: 'HUMAN_ORIGINAL', targets: [{ platformCode: 'douyin', accountId: account.id }],
    materialMeta: { durationSeconds: 15 }, publishMode: 'DRAFT_ONLY', complianceConfirmed: true
  };
  const post = body => jsonRequest(runtime.base, '/api/publish/tasks', { method: 'POST', body });
  const created = await post(payload);
  assert.equal(created.response.status, 201, created.text);
  const id = created.data.task.id;
  const stored = JSON.parse(db.prepare('SELECT material_meta FROM publish_tasks WHERE id=?').get(id).material_meta);
  assert.equal(stored.precheck, undefined);
  assert.equal(stored.meta.type, 'video');
  assert.equal(stored.meta.durationSeconds, 15);
  const job = JSON.parse(db.prepare("SELECT payload FROM agent_jobs WHERE job_type='PUBLISH' ORDER BY id DESC LIMIT 1").get().payload);
  assert.equal(job.precheck, undefined);
  assert.equal(job.materialSha256, readMaterialInfo(file).sha256);
  assert.equal(job.publishMode, 'DRAFT_ONLY');
  const duplicate = await post(payload);
  assert.equal(duplicate.response.status, 409);
  assert.equal(duplicate.data.code, 'PUBLISH_DUPLICATE');
  const legacy = await post({ ...payload, title: '社区活动介绍', precheck: { overall: 'BLOCKED', results: [] } });
  assert.equal(legacy.response.status, 201, legacy.text);
  const automatic = await post({ ...payload, title: '自动发布介绍', publishMode: 'AUTO', managementConfirmed: true });
  assert.equal(automatic.response.status, 201, automatic.text);
  const automaticJob = JSON.parse(db.prepare("SELECT payload FROM agent_jobs WHERE job_type='PUBLISH' ORDER BY id DESC LIMIT 1").get().payload);
  assert.equal(automaticJob.publishMode, 'AUTO');
  assert.equal(automaticJob.precheck, undefined);
  const invalid = await post({ ...payload, title: '账号检查', targets: [{ platformCode: 'douyin', accountId: -1 }] });
  assert.equal(invalid.response.status, 400);
  const input = { title: '核对后的活动介绍', body: payload.body, contentOrigin: payload.contentOrigin, materialSha256: readMaterialInfo(file).sha256, sourceType: 'video' };
  const review = buildMockAiReview(input);
  fs.appendFileSync(file, 'changed');
  const changed = await post({ ...payload, title: input.title, aiReview: review });
  assert.equal(changed.response.status, 409);
  assert.match(changed.data.message, /审核|变化|一致/);
});
