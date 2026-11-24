import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { startServer, stopChild, cleanupDir, jsonRequest } from './helpers/runtime.js';

const candidate = { documentId: 'policy-document', documentVersion: 1, chunkId: 'policy-chunk', title: '什么是“七免两低”扶持政策？', sectionPath: ['OPC港澳服务社区介绍及入驻流程', '常见问题'], verificationStatus: 'VERIFIED' };
const queryAnalysis = question => ({ originalQuestion: question, resolvedQuestion: question, keywords: ['社区', '政策'], contextUsed: true });

test('各平台私信区分缺对象澄清、相关方向确认与证据缺口，话术和计数一致', async t => {
  const requests = [];
  const rag = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const input = JSON.parse(Buffer.concat(chunks).toString() || '{}');
    const send = data => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
    const formal = req.url === '/rag-api/v1/query';
    const question = formal ? input.query.text : input.question;
    requests.push({ formal, question, context: input.context });
    const known = question.includes('七免两低');
    const analysis = queryAnalysis(question);
    send({
      result: known ? 'ANSWERED' : 'NO_ANSWER', reasonCode: known ? null : 'INSUFFICIENT_EVIDENCE',
      snapshot: input.snapshot, answerId: 'guidance-answer',
      answer: known ? { text: '这是社区的创业扶持政策。' } : null,
      grounding: { confidence: known ? 0.9 : 0.41, sourceReferences: formal && !known ? [] : [candidate] },
      meta: { knowledgeVersion: 'same-release', ...(formal ? {} : { queryAnalysis: analysis }) },
      ...(formal ? { diagnostics: { queryAnalysis: analysis, selectedCandidates: [{ document_id: candidate.documentId, document_version: 1, chunk_id: candidate.chunkId, title: candidate.title, section_path: candidate.sectionPath, selected: true }] } } : {})
    });
  });
  await new Promise(resolve => rag.listen(0, '127.0.0.1', resolve));
  const runtime = await startServer({ env: { RAG_BASE_URL: `http://127.0.0.1:${rag.address().port}`, RAG_ADMIN_ENABLED: 'true', RAG_FORMAL_ROUTING_ENABLED: 'true', WECOM_WEBHOOK_URL: '', BUSINESS_GUIDANCE_MAX_ATTEMPTS: '3' } });
  const db = new DatabaseSync(runtime.dbPath);
  db.exec('PRAGMA busy_timeout=5000');
  t.after(async () => { db.close(); await stopChild(runtime.child); cleanupDir(runtime.dir); await new Promise(resolve => rag.close(resolve)); });
  db.prepare("UPDATE accounts SET enabled=1 WHERE platform_code IN ('douyin','weibo','wechat_channels','bilibili','xiaohongshu')").run();
  const accounts = (await jsonRequest(runtime.base, '/api/accounts')).data.accounts;
  let sequence = 0;
  const simulate = async (platformCode, conversationId, content) => {
    const id = `guidance-${++sequence}`;
    const result = await jsonRequest(runtime.base, '/api/messages/simulate', { method: 'POST', body: {
      platformCode, accountId: accounts.find(a => a.platform_code === platformCode).id, messageType: 'PRIVATE_MESSAGE',
      externalId: id, userName: '引导回归用户', content,
      context: { conversationId, messageId: id, direction: 'incoming', sourceVerified: true, chatTitleVerified: true, previewOnly: false, unreadCount: 1 }
    } });
    assert.equal(result.response.status, 201, `${platformCode}: ${JSON.stringify(result.data)}`);
    const message = result.data.message;
    // Simulate the customer having seen the prior reply without running an Agent.
    if (message.reply_job_id) {
      db.prepare("UPDATE agent_jobs SET status='SUCCESS' WHERE id=?").run(message.reply_job_id);
      db.prepare("UPDATE messages SET status='AUTO_REPLIED',handled_at=?,handled_by='AI' WHERE id=?").run(new Date().toISOString(), message.id);
    }
    return message;
  };
  const platforms = ['douyin', 'weibo', 'wechat_channels', 'bilibili', 'xiaohongshu'];
  const conversation = id => db.prepare('SELECT handling_mode,clarification_attempts,pending_intent_json FROM conversations WHERE id=?').get(id);
  const handoffNotifications = id => db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE message_id=? AND json_extract(metadata_json,'$.handoff')=1").get(id).n;
  // ADR 0003: missing subject → outer clarification (no RAG); low-score related
  // candidate → one direction confirmation (title only, no facts, no citation);
  // a denied candidate is not offered again and the gap counts toward the limit.
  const questions = ['这个有什么政策？', '就是社区政策有哪一些', '不是，还有其他政策吗？', '什么是七免两低政策'];
  const expected = [
    { decision: 'KNOWLEDGE_GAP_GUIDANCE', attempts: 1 },
    { decision: 'RAG_RELATED_CLARIFICATION', attempts: 2 },
    { decision: 'RAG_KNOWLEDGE_GAP', attempts: 3 },
    { decision: 'RAG_ANSWERED', attempts: 0 }
  ];
  let reference = null;
  for (const platform of platforms) {
    const conversationId = `${platform}-guidance`;
    const replies = [];
    for (let index = 0; index < questions.length; index += 1) {
      const message = await simulate(platform, conversationId, questions[index]);
      const state = conversation(message.conversation_id);
      assert.equal(message.decision, expected[index].decision, `${platform} ${questions[index]}`);
      assert.equal(message.status, 'REPLY_QUEUED', platform);
      assert.ok(message.reply_job_id, platform);
      assert.equal(state.handling_mode, 'BOT_ACTIVE', platform);
      assert.equal(state.clarification_attempts, expected[index].attempts, `${platform} ${questions[index]}`);
      assert.equal(handoffNotifications(message.id), 0, '知识缺口只邀请转人工，不自行通知人工');
      if (index === 1) {
        assert.match(message.reply_text, /「“七免两低”扶持政策」/);
        assert.doesNotMatch(message.reply_text, /创业扶持政策。|转人工/, '候选只确认方向，不陈述内容');
        assert.equal(JSON.parse(state.pending_intent_json).candidateQuestion, '“七免两低”扶持政策');
      } else {
        assert.equal(state.pending_intent_json, null, platform);
      }
      if (index === 2) {
        assert.doesNotMatch(message.reply_text, /七免两低/, '用户否认后不再提同一候选');
        assert.match(message.reply_text, /「转人工」/);
      }
      replies.push(message.reply_text);
    }
    assert.equal(replies[3], '这是社区的创业扶持政策。');
    if (reference) assert.deepEqual(replies, reference, `${platform} 与其他平台话术一致`);
    reference = replies;
  }
  assert.ok(!requests.some(item => item.question === questions[0]), '真缺对象的首问仍不让 RAG 猜测');
  assert.ok(requests.some(item => item.formal && item.question === questions[1]));

  for (const platform of platforms) {
    const conversationId = `${platform}-confirm`;
    assert.equal((await simulate(platform, conversationId, '就是社区政策有哪一些')).decision, 'RAG_RELATED_CLARIFICATION');
    const before = requests.length;
    const confirmed = await simulate(platform, conversationId, '是的');
    assert.equal(confirmed.decision, 'RAG_ANSWERED', platform);
    assert.equal(confirmed.reply_text, '这是社区的创业扶持政策。');
    assert.equal(requests.length, before + 1, '确认后重新走一次完整 RAG');
    assert.notEqual(requests.at(-1).question, '是的', '确认后的问题是候选方向，不是“是的”');
    assert.match(requests.at(-1).question, /七免两低/);
    assert.equal(conversation(confirmed.conversation_id).pending_intent_json, null);
    assert.equal(conversation(confirmed.conversation_id).clarification_attempts, 0);
  }

  const broad = await simulate('douyin', 'douyin-broad', '有哪些政策？');
  assert.ok(requests.some(item => item.question === '有哪些政策？'), '宽泛目录请求按知识库默认范围查询');
  assert.equal(broad.decision, 'RAG_RELATED_CLARIFICATION');
});

// 小智测试会话（/api/xiaozhi/*）已于 2026-11-10 下线（docs/changes/2026-11-10-knowledge-files.md），
// 评论人工邀约与严格确认由 test/comment-handoff-*.test.js 在平台评论链路上覆盖。
