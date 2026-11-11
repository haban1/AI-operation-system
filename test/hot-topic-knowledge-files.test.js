import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHotTopicKnowledge, HOT_TOPIC_KNOWLEDGE_SCHEMA } from '../src/services/hot-topic-knowledge.js';

test('automatic content imports directly as a file without a test session or release', async t => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close()); db.exec(HOT_TOPIC_KNOWLEDGE_SCHEMA);
  let time = Date.now(), status = 'PROCESSING', uploads = 0;
  const client = {
    saveFile: async input => { uploads++; assert.ok(input.requestId); assert.equal(input.knowledgeBaseId, 'main-business-kb'); return { documentId: 'doc-auto', documentVersion: 1 }; },
    listFiles: async () => ({ documents: [{ documentId: 'doc-auto', documentVersion: 1, usageStatus: status }] })
  };
  const worker = createHotTopicKnowledge({ db, ragClient: client, now: () => time, processingPollMs: 1 });
  const material = { id: 'auto-1', sha256: 'a'.repeat(64), source: 'automatic', hotTopicDocument: { schemaVersion: 1, title: '隔离测试', body: '正文', markdown: '# 隔离测试\n正文', questions: ['正文是什么？'] } };
  assert.equal(worker.enqueue({ material }).enqueued, true);
  await worker.tick();
  time += 10; await worker.tick();
  assert.equal(worker.listStatus()[0].status, 'PENDING');
  status = 'ACTIVE'; time += 10; await worker.tick();
  const job = worker.listStatus()[0];
  assert.equal(job.status, 'PUBLISHED');
  assert.equal(job.test_session_id, null);
  assert.equal(job.release_id, null);
  assert.equal(uploads, 1);
  worker.enqueue({ material }); time += 10; await worker.tick();
  assert.equal(uploads, 1, 'reconfirmation must not duplicate the saved file');
});
