import test from 'node:test';
import assert from 'node:assert/strict';
import { JOB_PRIORITY, isOldConversationRecoveryJob, priorityForJob } from '../src/services/job-priority.js';
import { RagClient, RAG_RESULT } from '../src/services/rag-client.js';

test('任务优先级保证新增私信和回复优先于评论、发布及旧会话恢复', () => {
  assert.equal(priorityForJob('REPLY', { messageType: 'PRIVATE_MESSAGE' }), JOB_PRIORITY.PRIVATE_REPLY);
  assert.equal(priorityForJob('COLLECT_MESSAGES', { channelType: 'PRIVATE_MESSAGE' }), JOB_PRIORITY.PRIVATE_INCREMENTAL_COLLECTION);
  assert.equal(priorityForJob('REPLY', { messageType: 'COMMENT' }), JOB_PRIORITY.COMMENT_REPLY);
  assert.equal(priorityForJob('COLLECT_MESSAGES', { channelType: 'COMMENT' }), JOB_PRIORITY.COMMENT_COLLECTION);
  assert.equal(priorityForJob('PUBLISH', {}), JOB_PRIORITY.PUBLISH);
  assert.equal(priorityForJob('COLLECT_MESSAGES', { recoveryScan: true }), JOB_PRIORITY.OLD_CONVERSATION_RECOVERY);
  assert.ok(JOB_PRIORITY.PRIVATE_REPLY < JOB_PRIORITY.COMMENT_REPLY);
  assert.ok(JOB_PRIORITY.PRIVATE_INCREMENTAL_COLLECTION < JOB_PRIORITY.PUBLISH);
  assert.ok(JOB_PRIORITY.PUBLISH < JOB_PRIORITY.OLD_CONVERSATION_RECOVERY);
  assert.equal(isOldConversationRecoveryJob('COLLECT_MESSAGES', { collectionScope: 'OLD_CONVERSATIONS' }), true);
});

test('RAG 未配置时返回明确状态且不调用任何本地知识库回退', async () => {
  let calls = 0;
  const client = new RagClient({ baseUrl: '', fetchImpl: async () => { calls += 1; throw new Error('不应调用'); } });
  const result = await client.queryFormalKnowledge({ question: '测试问题' });
  assert.equal(result.status, RAG_RESULT.NOT_CONFIGURED);
  assert.equal(result.answerable, false);
  assert.equal(result.retryable, false);
  assert.equal(calls, 0);
});

test('RAG 正式查询遵循合同路径、请求头和结果归一化', async () => {
  let observed;
  const client = new RagClient({
    baseUrl: 'http://127.0.0.1:18080/', token: 'test-token',
    fetchImpl: async (url, options) => {
      observed = { url, options, body: JSON.parse(options.body) };
      return new Response(JSON.stringify({ result: 'ANSWERED', answer: { text: '合同答案' } }), { status: 200 });
    }
  });
  const result = await client.queryFormalKnowledge({ requestId: 'req-1', question: '问题' });
  assert.equal(observed.url, 'http://127.0.0.1:18080/rag-api/v1/query');
  assert.equal(observed.options.headers.Authorization, 'Bearer test-token');
  assert.equal(observed.options.headers['X-Contract-Version'], '1.0');
  assert.equal(observed.body.contractVersion, '1.0');
  assert.equal(result.status, RAG_RESULT.ANSWERED);
  assert.equal(result.answerable, true);
});
