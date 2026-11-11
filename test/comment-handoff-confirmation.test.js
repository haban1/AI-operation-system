import test from 'node:test';
import assert from 'node:assert/strict';
import { commentHandoffConfirmation, findCommentHandoffOffer } from '../src/services/comment-handoff-confirmation.js';

const reference = Date.parse('2026-11-03T10:00:00Z');
function message(context = {}, overrides = {}) {
  return { id: 20, platform_code: 'douyin', account_id: 1, message_type: 'COMMENT', identity_confidence: 'LOW', user_name: '同名用户', created_at: '2026-11-03T09:59:59Z', collected_at: '2026-11-03T09:59:59Z', context_json: JSON.stringify(context), ...overrides };
}
function offer(context = { actorPlatformId: 'actor-1', sourceVideoKey: 'work-1', commentStableId: 'comment-1' }, sourceOverrides = {}, intentOverrides = {}) {
  const sourceMessage = message(context, { id: 10, status: 'AUTO_REPLIED', handled_at: '2026-11-03T09:59:58Z', reply_context_json: JSON.stringify({ handoffOffered: true }), ...sourceOverrides });
  return { intent: { id: 1, status: 'WAITING_USER_CONFIRMATION', source_message_id: sourceMessage.id, expires_at: '2026-11-03T10:30:00Z', ...intentOverrides }, sourceMessage };
}
const current = context => message({ actorPlatformId: 'actor-1', sourceVideoKey: 'work-1', ...context });

test('单轮 LOW 评论凭稳定用户和同一作品关联已发送的人工邀约', () => {
  const candidate = offer();
  assert.equal(findCommentHandoffOffer(current({}), [candidate], reference), candidate);
  const aliased = offer({ actorMid: 'actor-1', oid: 'work-1' });
  assert.equal(findCommentHandoffOffer(current({}), [aliased], reference), aliased);
});

test('不同用户、作品、账号、平台及昵称相同均不能确认他人的邀约', () => {
  const candidate = offer();
  for (const incoming of [current({ actorPlatformId: 'actor-2' }), current({ sourceVideoKey: 'work-2' }), message({}, { user_name: '同名用户' }), message({ actorPlatformId: 'actor-1' })]) {
    assert.equal(findCommentHandoffOffer(incoming, [candidate], reference), null);
  }
  assert.equal(findCommentHandoffOffer(message({ actorPlatformId: 'actor-1', sourceVideoKey: 'work-1' }, { account_id: 2 }), [candidate], reference), null);
  assert.equal(findCommentHandoffOffer(message({ actorPlatformId: 'actor-1', sourceVideoKey: 'work-1' }, { platform_code: 'weibo' }), [candidate], reference), null);
  assert.equal(findCommentHandoffOffer(message({ actorPlatformId: 'actor-1', sourceVideoKey: 'work-1' }, { message_type: 'PRIVATE_MESSAGE' }), [candidate], reference), null);
});

test('排队、失败、缺少真实邀约、已取消或通知、过期意图不能复用', () => {
  for (const status of ['REPLY_QUEUED', 'REPLY_RUNNING', 'MANUAL_REQUIRED', 'SUPERSEDED']) {
    assert.equal(findCommentHandoffOffer(current({}), [offer(undefined, { status })], reference), null, status);
  }
  for (const status of ['CANCELLED', 'DECLINED', 'NOTIFY_QUEUED', 'NOTIFIED', 'RESOLVED_BY_KNOWLEDGE']) {
    assert.equal(findCommentHandoffOffer(current({}), [offer(undefined, {}, { status })], reference), null, status);
  }
  for (const reply_context_json of ['{}', '{broken', '{"handoffOffered":"true"}']) {
    assert.equal(findCommentHandoffOffer(current({}), [offer(undefined, { reply_context_json })], reference), null);
  }
  for (const expires_at of ['2026-11-03T09:59:59Z', '2026-11-03T10:00:00Z', '', 'invalid']) {
    assert.equal(findCommentHandoffOffer(current({}), [offer(undefined, {}, { expires_at })], reference), null);
  }
});

test('同用户多个邀约没有唯一精确父评论指向时不猜测', () => {
  const first = offer();
  const second = offer({ actorPlatformId: 'actor-1', sourceVideoKey: 'work-1', commentId: 'comment-2' }, { id: 11 }, { id: 2 });
  assert.equal(findCommentHandoffOffer(current({}), [first, second], reference), null);
  assert.equal(findCommentHandoffOffer(current({ parentCommentId: 'comment-2' }), [first, second], reference), second);
  assert.equal(findCommentHandoffOffer(current({ parent: 'comment-1' }), [first, second], reference), first);
  assert.equal(findCommentHandoffOffer(current({ parentCommentId: 'unrelated' }), [first, second], reference), null);
  assert.equal(findCommentHandoffOffer(current({}), [first, first], reference), first);
});

test('明确回复另一条评论时不能退回唯一人工邀约，顶层零值和 root 不作为指向', () => {
  const candidate = offer();
  for (const parent of [{ parentCommentId: 'unrelated' }, { parent: 'unrelated' }, { replyToCommentId: 'unrelated' }]) {
    assert.equal(findCommentHandoffOffer(current(parent), [candidate], reference), null);
  }
  for (const parent of [{ parent: 0 }, { parent: '0' }, { parent: 'root' }, { root: 'unrelated' }]) {
    assert.equal(findCommentHandoffOffer(current(parent), [candidate], reference), candidate);
  }
  assert.equal(findCommentHandoffOffer(current({ parent: 0, replyToCommentId: 'comment-1' }), [candidate], reference), candidate);
});

test('确认消息必须严格晚于邀约实际发送时间，迟采集和缺失时间都不算确认', () => {
  const candidate = offer();
  const identity = { actorPlatformId: 'actor-1', sourceVideoKey: 'work-1' };
  for (const times of [
    { created_at: '2026-11-03T09:59:57Z', collected_at: '2026-11-03T09:59:59Z' },
    { created_at: '2026-11-03T09:59:58Z', collected_at: '2026-11-03T09:59:59Z' },
    { created_at: '2026-11-03T09:59:59Z', collected_at: '2026-11-03T09:59:57Z' },
    { created_at: null, collected_at: null },
    { created_at: 'invalid', collected_at: '' }
  ]) assert.equal(findCommentHandoffOffer(message(identity, times), [candidate], reference), null);
  for (const handled_at of [null, '', 'invalid']) {
    assert.equal(findCommentHandoffOffer(current({}), [offer(undefined, { handled_at })], reference), null);
  }
  assert.equal(findCommentHandoffOffer(message(identity, { created_at: null }), [candidate], reference), candidate);
  assert.equal(findCommentHandoffOffer(message(identity, { collected_at: null }), [candidate], reference), candidate);
});

test('可信平台事件时间早于邀约时，较晚的入库时间不能把它当成确认', () => {
  const candidate = offer();
  for (const time of [
    { eventTimeMs: Date.parse('2026-11-03T09:59:57Z') },
    { eventTime: '2026-11-03T09:59:57Z' },
    { eventTimeMs: Date.parse('2026-11-03T09:59:58Z') }
  ]) assert.equal(findCommentHandoffOffer(current({ sourceVerified: true, ...time }), [candidate], reference), null);
  assert.equal(findCommentHandoffOffer(current({ sourceVerified: true, eventTimeMs: Date.parse('2026-11-03T09:59:59Z') }), [candidate], reference), candidate);
  assert.equal(findCommentHandoffOffer(current({ sourceVerified: false, eventTimeMs: Date.parse('2026-11-03T09:59:57Z') }), [candidate], reference), candidate);
});

test('稳定用户会话可关联；全帖 thread、昵称头像会话和冲突用户不回退', () => {
  const stable = { conversation_key_snapshot: 'REAL:douyin:1:COMMENT:user-conversation', identity_confidence: 'HIGH', identity_source: 'conversationId' };
  const candidate = offer({}, stable);
  assert.equal(findCommentHandoffOffer(message({}, stable), [candidate], reference), candidate);
  for (const identity_source of ['threadId', 'thread_id', 'nickname_avatar_entry', 'nickname_current_message_only', '']) {
    assert.equal(findCommentHandoffOffer(message({}, { ...stable, identity_source }), [candidate], reference), null);
  }
  assert.equal(findCommentHandoffOffer(message({}, { ...stable, identity_confidence: 'LOW' }), [candidate], reference), null);
  const actorOffer = offer({ actorPlatformId: 'actor-1', postId: 'work-1' }, stable);
  assert.equal(findCommentHandoffOffer(message({ actorPlatformId: 'actor-2', postId: 'work-1' }, stable), [actorOffer], reference), null);
  assert.equal(findCommentHandoffOffer(message({ actorPlatformId: 'actor-1', postId: 'work-2' }, stable), [actorOffer], reference), null);
});

test('损坏或不一致的来源意图不能形成确认', () => {
  assert.equal(findCommentHandoffOffer(current({}), [null, {}], reference), null);
  assert.equal(findCommentHandoffOffer(current({}), [offer(undefined, {}, { source_message_id: 99 })], reference), null);
  assert.equal(findCommentHandoffOffer(current({}), [offer(undefined, {}, { account_id: 2 })], reference), null);
  assert.equal(findCommentHandoffOffer(current({}), [offer(undefined, { context_json: '{broken' })], reference), null);
  assert.equal(findCommentHandoffOffer(current({}), [offer()], NaN), null);
});

test('仅纯肯定或否定回答人工邀约，保留混合业务问题和明确人工指令给路由', () => {
  for (const content of ['好', '好的！', '是', '是的', '需要', '可以', '麻烦了', '麻煩您了', '好的，谢谢', '那就麻烦了。']) {
    assert.equal(commentHandoffConfirmation(content), 'ACCEPT', content);
  }
  for (const content of ['不用', '不需要', '不要', '暂时不用', '不用了！', '先不需要', '暫時不用', '不用了，谢谢', '不用麻烦了']) {
    assert.equal(commentHandoffConfirmation(content), 'DECLINE', content);
  }
  for (const content of ['', '谢谢', '好的，怎么报名？', '需要什么材料', '可以几点办理', '不用了，地址在哪', '不要转人工', '转人工', '可以吗', '可以？', '你说“好的”', '“好的”', '好，垃圾客服']) {
    assert.equal(commentHandoffConfirmation(content), null, content);
  }
});

test('仅整句详情意向确认站内沟通邀约，疑问、否定和混合业务问题保持原路由', () => {
  for (const content of ['详情', '詳情', '了解详情', '了解詳情', '想了解详情', '想了解詳情', '详情！', '了解一下详情', '我想了解详情', '想看详情', '查看詳情', '详情，谢谢']) {
    assert.equal(commentHandoffConfirmation(content), 'ACCEPT', content);
  }
  for (const content of ['详情在哪', '不用详情', '详情私聊是什么意思', '查询详情多少钱', '详情？', '想了解详情吗', '不想了解详情', '详情，怎么报名', '先不用详情', '你说“详情”', '“详情”']) {
    assert.equal(commentHandoffConfirmation(content), null, content);
  }
});
