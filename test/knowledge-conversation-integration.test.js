import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const root = path.resolve(import.meta.dirname, '..');

async function freePort() {
  const server = http.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function request(base, pathname, options = {}) {
  const response = await fetch(base + pathname, { ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } });
  const data = await response.json();
  return { response, data };
}

async function waitFor(base) {
  for (let i = 0; i < 80; i += 1) {
    try { const response = await fetch(base + '/api/health'); if (response.ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('测试服务启动超时');
}

async function waitUntil(check, message) {
  for (let i = 0; i < 80; i += 1) {
    const value = await check();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(message);
}

test('知识缺口先引导、转人工后每条新增消息通知人工，并支持问候与相似问法', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-conversation-int-'));
  const dbPath = path.join(dir, 'test.db');
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port), DATABASE_PATH: dbPath, QWEN_MODE: 'mock', RPA_MODE: 'simulated',
      AUTO_COLLECT_ENABLED: 'false', LOCAL_AGENT_AUTO_START: 'false', WECOM_WEBHOOK_URL: '', AUTH_ENABLED: 'false', BUSINESS_GUIDANCE_MAX_ATTEMPTS: '3',
      RAG_FORMAL_ROUTING_ENABLED: 'false', RAG_BASE_URL: ''
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await Promise.race([new Promise(resolve => child.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 2000))]);
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await waitFor(base).catch(error => { throw new Error(`${error.message}\n${stderr}`); });
  const bootstrap = (await request(base, '/api/bootstrap')).data;
  const account = bootstrap.accounts.find(item => item.platform_code === 'douyin');
  assert.ok(account);
  const hiddenReplyDb = new DatabaseSync(dbPath);
  const hiddenReplyStamp = new Date().toISOString();
  hiddenReplyDb.prepare(`INSERT INTO messages
    (platform_code,account_id,message_type,external_id,user_name,content,status,decision,reply_text,created_at,updated_at,handled_at,handled_by,wecom_notification_status)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    'douyin', account.id, 'COMMENT', 'hidden-auto-reply', '历史用户', '历史消息', 'AUTO_REPLIED', 'HANDOFF_SUBMITTED',
    '历史自动回复', hiddenReplyStamp, hiddenReplyStamp, hiddenReplyStamp, 'AI_RPA', 'PENDING'
  );
  hiddenReplyDb.close();
  const simulate = async (content, suffix, conversationId = 'semantic-conversation-1', messageType = 'PRIVATE_MESSAGE') => {
    const result = await request(base, '/api/messages/simulate', {
      method: 'POST',
      body: JSON.stringify({
        platformCode: 'douyin', accountId: account.id, messageType,
        externalId: `semantic-${suffix}`, userName: '语义测试用户', content,
        context: { conversationId, messageId: `semantic-message-${suffix}`, direction: 'incoming', sourceVerified: true, chatTitleVerified: true, previewOnly: false, unreadCount: 1, noteId: `note-${conversationId}`, commentId: messageType === 'COMMENT' ? `comment-${suffix}` : undefined }
      })
    });
    assert.equal(result.response.status, 201, JSON.stringify(result.data));
    return result.data.message;
  };

  const greeting = await simulate('你好', 'greeting');
  assert.equal(greeting.decision, 'SIMPLE_GREETING');
  assert.equal(greeting.status, 'REPLY_QUEUED');
  assert.equal(greeting.response_mode, 'ROUTER_STATIC');
  assert.match(greeting.reply_text, /想了解哪方面/);

  const gap = await simulate('可以带孩子吗', 'gap');
  assert.equal(gap.decision, 'KNOWLEDGE_GAP_GUIDANCE');
  assert.equal(gap.status, 'REPLY_QUEUED');
  assert.match(gap.reply_text, /哪场活动|活动名字/);
  assert.doesNotMatch(gap.reply_text, /转人工/);

  const activity = await request(base, '/api/knowledge', {
    method: 'POST',
    body: JSON.stringify({
      question: '近期有什么社区活动？',
      answer: '近期活动请查看账号置顶内容或最新发布的活动通知。',
      keywords: '近期,活动,社区', category: '公共知识库', subcategory: '活动咨询'
    })
  });
  assert.equal(activity.response.status, 201, JSON.stringify(activity.data));
  const activityPublished = await request(base, `/api/knowledge/${activity.data.knowledge.id}/publish`, { method: 'POST', body: JSON.stringify({ reviewedBy: 'integration-test' }) });
  assert.equal(activityPublished.response.status, 200, JSON.stringify(activityPublished.data));
  const mixed = await simulate('最近有什么活动，能带小孩参加吗', 'mixed-activity-child');
  assert.equal(mixed.decision, 'AUTO_REPLY_PARTIAL_KNOWLEDGE');
  assert.doesNotMatch(mixed.reply_text, /^你好~，/);
  assert.match(mixed.reply_text, /近期活动请查看账号置顶内容或最新发布的活动通知/);
  assert.match(mixed.reply_text, /哪场活动|孩子能不能一起去/);
  assert.doesNotMatch(mixed.reply_text, /从知识库准确|关于你提出的问题/);

  const answeredComment = await simulate('近期有什么社区活动？', 'comment-answer', 'comment-answer', 'COMMENT');
  assert.equal(answeredComment.decision, 'AUTO_REPLY');
  assert.equal(answeredComment.status, 'REPLY_QUEUED');
  assert.equal(answeredComment.reply_text, '近期活动请查看账号置顶内容或最新发布的活动通知。');
  const unanswerableComments = [];
  for (const [suffix, content] of [['missing', '可以带孩子吗'], ['partial', '最近有什么活动，能带小孩参加吗'], ['greeting', '你好']]) {
    const message = await simulate(content, `comment-${suffix}`, `comment-${suffix}`, 'COMMENT');
    assert.equal(message.status, 'MANUAL_REQUIRED', JSON.stringify(message));
    assert.match(message.decision, /HUMAN_FOLLOWUP_NOTIFICATION_PENDING|HUMAN_FOLLOWUP_NOTIFIED/);
    assert.equal(message.reply_text, null);
    assert.equal(message.reply_job_id, null);
    unanswerableComments.push(message);
  }
  const commentDb = new DatabaseSync(dbPath, { readOnly: true });
  try {
    for (const message of unanswerableComments) {
      assert.equal(commentDb.prepare("SELECT COUNT(*) AS count FROM agent_jobs WHERE job_type='REPLY' AND CAST(json_extract(payload,'$.messageId') AS INTEGER)=?").get(message.id).count, 0);
      assert.equal(commentDb.prepare("SELECT COUNT(*) AS count FROM notifications WHERE message_id=? AND type='COMMENT_KNOWLEDGE_GAP' AND json_extract(metadata_json,'$.handoff')=1").get(message.id).count, 1);
      assert.equal(commentDb.prepare('SELECT handling_mode FROM conversations WHERE id=?').get(message.conversation_id).handling_mode, 'HANDOFF_PENDING');
    }
  } finally {
    commentDb.close();
  }

  const guidanceConversationId = 'five-round-guidance-conversation';
  const guidanceInputs = ['你好', '哈哈', '谢谢', '你是谁', '你能做什么'];
  const guidanceReplies = [];
  for (let index = 0; index < guidanceInputs.length; index += 1) {
    guidanceReplies.push(await simulate(guidanceInputs[index], `guidance-${index + 1}`, guidanceConversationId));
  }
  for (const item of guidanceReplies.slice(0, 4)) assert.doesNotMatch(item.reply_text, /转人工/);
  assert.equal(guidanceReplies[4].status, 'MANUAL_REQUIRED');
  assert.equal(guidanceReplies[4].reply_text, null);
  assert.equal(guidanceReplies[4].reply_job_id, null);
  const thirdGuidanceContext = JSON.parse(guidanceReplies[4].reply_context_json || '{}');
  assert.equal(thirdGuidanceContext.guidanceAttempt, 3);
  assert.equal(thirdGuidanceContext.handoffRequested, true);

  const missingJob = await request(base, '/api/jobs/999999999');
  assert.equal(missingJob.response.status, 404);
  assert.equal(missingJob.data.ok, false);
  assert.ok(gap.reply_job_id);
  const replyJob = await request(base, `/api/jobs/${gap.reply_job_id}`);
  assert.equal(replyJob.response.status, 200);
  assert.equal(replyJob.data.ok, true);
  assert.equal(replyJob.data.job.id, gap.reply_job_id);
  assert.equal(typeof replyJob.data.job.result, 'object');

  let db = new DatabaseSync(dbPath, { readOnly: true });
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM notifications WHERE type='KNOWLEDGE_GAP_CONFIRMED'").get().count, 0);
  db.close();

  const directHandoff = await simulate('帮我转个人工', 'direct-handoff', 'direct-handoff-conversation');
  assert.equal(directHandoff.decision, 'HUMAN_FOLLOWUP_NOTIFICATION_PENDING');
  assert.equal(directHandoff.status, 'MANUAL_REQUIRED');
  assert.equal(directHandoff.reply_job_id, null);
  assert.ok(!directHandoff.reply_text);
  assert.ok(directHandoff.manual_handoff_intent_id);

  const handoff = await simulate('转人工', 'handoff', guidanceConversationId);
  assert.equal(handoff.decision, 'HUMAN_FOLLOWUP_NOTIFICATION_PENDING');
  assert.equal(handoff.status, 'MANUAL_REQUIRED');
  assert.equal(handoff.reply_job_id, null);
  assert.ok(!handoff.reply_text);
  const repeated = await simulate('请转人工处理', 'handoff-repeat', guidanceConversationId);
  assert.equal(repeated.decision, 'HUMAN_FOLLOWUP_NOTIFICATION_PENDING');
  assert.equal(repeated.status, 'MANUAL_REQUIRED');
  assert.equal(repeated.reply_job_id, null);
  assert.ok(!repeated.reply_text);

  db = new DatabaseSync(dbPath, { readOnly: true });
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM notifications WHERE type='KNOWLEDGE_GAP_CONFIRMED'").get().count, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM notifications WHERE type='KNOWLEDGE_GUIDANCE_LIMIT' AND message_id=?").get(guidanceReplies[4].id).count, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM notifications WHERE type='HUMAN_FOLLOWUP_MESSAGE' AND message_id=?").get(handoff.id).count, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM notifications WHERE type='HUMAN_FOLLOWUP_MESSAGE' AND message_id=?").get(repeated.id).count, 1);
  for (const item of [directHandoff, handoff, repeated]) {
    const conversation = db.prepare('SELECT handling_mode,human_followup_state FROM conversations WHERE id=?').get(item.conversation_id);
    assert.equal(conversation.handling_mode, 'HANDOFF_PENDING');
    assert.equal(conversation.human_followup_state, 'WAITING');
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM agent_jobs WHERE job_type='REPLY' AND CAST(json_extract(payload,'$.messageId') AS INTEGER)=?").get(item.id).count, 0);
  }
  db.close();

  const handoffList = await request(base, '/api/manual-handoffs?limit=500');
  assert.equal(handoffList.response.status, 200);
  const refreshedBootstrap = await request(base, '/api/bootstrap');
  assert.equal(refreshedBootstrap.response.status, 200);
  assert.equal(refreshedBootstrap.data.stats.handoffRecords, handoffList.data.totalHandoffs);
  assert.equal(refreshedBootstrap.data.stats.handoffRecords, handoffList.data.handoffs.length);
  const visibleMessages = (await request(base, '/api/messages')).data.messages;
  const visibleAiReplies = visibleMessages.filter(item => item.reply_status?.ai?.replied).length;
  assert.equal(refreshedBootstrap.data.stats.autoReplies, visibleAiReplies);

  const created = await request(base, '/api/knowledge', {
    method: 'POST',
    body: JSON.stringify({
      question: '参加社区活动是否可以带孩子？', answer: '可以带孩子参加，现场请由监护人照看。',
      keywords: '活动,孩子,小孩', category: '公共知识库', subcategory: '活动咨询'
    })
  });
  assert.equal(created.response.status, 201, JSON.stringify(created.data));
  const knowledgeId = created.data.knowledge.id;
  const published = await request(base, `/api/knowledge/${knowledgeId}/publish`, { method: 'POST', body: JSON.stringify({ reviewedBy: 'integration-test' }) });
  assert.equal(published.response.status, 200, JSON.stringify(published.data));

  await waitUntil(async () => {
    const tasks = (await request(base, '/api/knowledge-alias-generation-tasks')).data.tasks || [];
    return tasks.some(item => Number(item.knowledge_id) === Number(knowledgeId) && item.status === 'COMPLETED');
  }, '相似问法生成超时');

  const semantic = await simulate('社区活动能不能带小孩？', 'semantic-match');
  assert.equal(semantic.decision, 'AUTO_REPLY');
  assert.equal(semantic.knowledge_id, knowledgeId);
  assert.equal(semantic.reply_text, '可以带孩子参加，现场请由监护人照看。');

  // 新消息不再自动沉淀到 knowledge_gaps；该表和旧 API 只保留历史兼容。
  const initialGaps = (await request(base, '/api/knowledge-gaps')).data.gaps;
  assert.ok(!initialGaps.some(item => item.message_id === gap.id));
  assert.ok(!initialGaps.some(item => item.message_id === semantic.id));

  db = new DatabaseSync(dbPath);
  const semanticRow = db.prepare('SELECT id FROM messages WHERE external_id=?').get('semantic-semantic-match');
  assert.ok(semanticRow);
  const stamp = new Date().toISOString();
  db.prepare("INSERT INTO knowledge_gaps(message_id,normalized_question,status,created_at,updated_at) VALUES(?,?,'PENDING',?,?)")
    .run(semanticRow.id, '社区活动能不能带小孩？', stamp, stamp);
  const legacyGapInsert = db.prepare("INSERT INTO knowledge_gaps(message_id,normalized_question,status,created_at,updated_at) VALUES(?,?,'PENDING',?,?)")
    .run(gap.id, '可以带孩子吗', stamp, stamp);
  const gapRecord = { id: Number(legacyGapInsert.lastInsertRowid) };
  db.close();

  const afterLegacyInsert = (await request(base, '/api/knowledge-gaps')).data.gaps;
  assert.ok(!afterLegacyInsert.some(item => item.message_id === semantic.id));
  assert.ok(afterLegacyInsert.some(item => item.id === gapRecord.id));

  // 采集页面不可用造成的历史记录不属于可展示的知识缺口。
  db = new DatabaseSync(dbPath);
  db.prepare("UPDATE messages SET status='DEFERRED_PAGE_UNAVAILABLE',decision='DEFERRED_PAGE_UNAVAILABLE' WHERE id=?").run(gap.id);
  db.close();
  const afterDeferred = (await request(base, '/api/knowledge-gaps')).data.gaps;
  assert.ok(!afterDeferred.some(item => item.message_id === gap.id));

  const deletedGap = await request(base, '/api/knowledge-gaps/' + gapRecord.id, {
    method: 'DELETE',
    body: JSON.stringify({ deletedBy: 'integration-test', reason: '删除功能测试' })
  });
  assert.equal(deletedGap.response.status, 200, JSON.stringify(deletedGap.data));
  assert.equal(deletedGap.data.deleted, true);
  assert.equal(deletedGap.data.alreadyDeleted, false);
  const afterDelete = (await request(base, '/api/knowledge-gaps')).data.gaps;
  assert.ok(!afterDelete.some(item => item.id === gapRecord.id));
  db = new DatabaseSync(dbPath, { readOnly: true });
  const deletedGapRow = db.prepare('SELECT deleted_at,deleted_by,delete_reason FROM knowledge_gaps WHERE id=?').get(gapRecord.id);
  assert.ok(deletedGapRow.deleted_at);
  assert.equal(deletedGapRow.deleted_by, 'integration-test');
  assert.equal(deletedGapRow.delete_reason, '删除功能测试');
  assert.ok(db.prepare('SELECT id FROM messages WHERE id=?').get(gap.id));
  db.close();
});
