import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AssistedPlatformRpaAdapter,
  recoveryCollectionTargets
} from '../agent/rpa-adapters/assisted-platform.js';
import { DouyinAssistedRpaAdapter } from '../agent/rpa-adapters/douyin-assisted.js';
import { WeiboAssistedRpaAdapter } from '../agent/rpa-adapters/weibo-assisted.js';
import { WechatChannelsAssistedRpaAdapter } from '../agent/rpa-adapters/wechat-channels-assisted.js';
import { selectBilibiliRecoverySessions } from '../agent/rpa-adapters/bilibili-assisted.js';

const recoveryPayload = overrides => ({
  recoveryScan: true,
  oldConversationScan: true,
  types: ['PRIVATE_MESSAGE'],
  recoveryTargets: [{
    conversationId: 1,
    conversationNamespace: 'douyin:1:target-user',
    externalConversationKey: 'stable-target-1',
    userName: '目标用户'
  }],
  ...overrides
});

test('恢复目标必须包含稳定会话 ID，去重后每批最多两个', () => {
  assert.equal(recoveryCollectionTargets({ types: ['PRIVATE_MESSAGE'] }), null);
  assert.equal(recoveryCollectionTargets(recoveryPayload({ recoveryTargets: [{ userName: '只有用户名' }] })).code, 'RECOVERY_STABLE_TARGET_REQUIRED');
  const normalized = recoveryCollectionTargets(recoveryPayload({
    recoveryTargets: [
      { externalConversationKey: 'A', userName: '甲' },
      { externalConversationKey: 'a', userName: '重复项' },
      { externalConversationKey: 'B', userName: '乙' },
      { externalConversationKey: 'C', userName: '丙' }
    ]
  }));
  assert.deepEqual(normalized.targets.map(item => item.externalConversationKey), ['A', 'B']);
  assert.equal(normalized.requestedTargetCount, 3);
  assert.equal(normalized.truncatedTargetCount, 1);
});

test('通用采集器拒绝把旧会话恢复任务降级为评论或混合范围扫描', async () => {
  const adapter = Object.create(AssistedPlatformRpaAdapter.prototype);
  adapter.getPage = async () => { throw new Error('不应打开页面'); };
  const output = await adapter.collectMessages(recoveryPayload({ types: ['COMMENT'] }));
  assert.equal(output.status, 'NEEDS_CONFIRMATION');
  assert.equal(output.result.code, 'RECOVERY_PRIVATE_MESSAGE_ONLY');
});

test('抖音恢复任务只打开稳定 ID 目标，不进入常规或近期已读泛扫', async () => {
  const adapter = Object.create(DouyinAssistedRpaAdapter.prototype);
  adapter.assertRuntimeAllowed = async () => {};
  adapter.getPage = async () => ({ url: () => 'https://creator.douyin.com/creator-micro/data/following/chat' });
  let openedPayload = null;
  adapter.openPrivateConversationForPayload = async (_page, payload) => {
    openedPayload = payload;
    return { ok: true, conversationId: 'stable-target-1', headerName: '目标用户', rowIdentity: { evidence: ['attribute:data-id'] } };
  };
  adapter.collectLatestIncomingFromOpenPrivateConversation = async () => ({
    reason: 'OPEN_CHAT_LATEST_INCOMING_VERIFIED',
    messages: [{ messageType: 'PRIVATE_MESSAGE', externalId: 'm1', context: { conversationId: 'stable-target-1', messageId: 'msg-1' } }]
  });
  adapter.collectIncomingFromRecentReadPrivateConversations = async () => { throw new Error('禁止近期已读泛扫'); };
  adapter.evidence = async (_payload, message, _page, stage, extra) => ({ message, stage, ...extra });

  const output = await adapter.collectMessages(recoveryPayload());
  assert.equal(output.status, 'SUCCESS');
  assert.equal(output.result.messages.length, 1);
  assert.equal(openedPayload.messageContext.conversationId, 'stable-target-1');
  assert.equal(openedPayload.messageContext.conversationKey, 'stable-target-1');
});

test('微博恢复定位只接受 conversationKey，不能按相同用户名回退', async () => {
  const rows = [{ index: 0 }, { index: 1 }];
  const page = {
    locator: selector => {
      assert.equal(selector, 'li.sessionlist');
      return { count: async () => rows.length, nth: index => rows[index] };
    }
  };
  const adapter = Object.create(WeiboAssistedRpaAdapter.prototype);
  adapter.readConversationRow = async row => row.index === 0
    ? { userName: '同名用户', preview: '问题一', conversationKey: 'stable-other' }
    : { userName: '同名用户', preview: '问题二', conversationKey: 'stable-target-1' };

  const located = await adapter.locateRecoveryConversationByStableKey(page, 'stable-target-1');
  assert.equal(located.ok, true);
  assert.equal(located.index, 1);
  const missing = await adapter.locateRecoveryConversationByStableKey(page, '同名用户');
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, 'RECOVERY_TARGET_NOT_FOUND');
});

test('视频号恢复任务只检查平台直接会话 ID，派生身份和用户名不能代替', async () => {
  const adapter = Object.create(WechatChannelsAssistedRpaAdapter.prototype);
  adapter.wechatPrivateInboxDefinition = inboxType => ({ inboxType, label: inboxType });
  adapter.selectWechatPrivateInbox = async (_page, inboxType) => ({ ok: true, inboxType, scope: {} });
  adapter.waitForMessageContentReady = async () => ({ ready: true, reason: 'READY', scope: {}, pageCheck: { valid: true, reason: 'READY' } });
  let reads = 0;
  adapter.readWechatPrivateConversations = async (_scope, inboxType) => {
    reads += 1;
    return inboxType === 'MAIN'
      ? [
          { inboxType, name: '目标用户', preview: '派生身份会话', conversationId: null },
          { inboxType, name: '目标用户', preview: '稳定身份会话', conversationId: 'stable-target-1' }
        ]
      : [];
  };
  adapter.assertRuntimeAllowed = async () => {};
  adapter.inspectWechatPrivateConversationCandidate = async (_page, conversation) => ({
    status: 'VERIFIED',
    reason: 'WECHAT_CHAT_LATEST_INCOMING_VERIFIED',
    message: { messageType: 'PRIVATE_MESSAGE', externalId: 'wx-1', context: { conversationId: conversation.conversationId, conversationKey: conversation.conversationId, inboxType: conversation.inboxType } }
  });
  const page = { url: () => 'https://channels.weixin.qq.com/platform/private_msg' };
  const recovery = recoveryCollectionTargets(recoveryPayload());
  const output = await adapter.collectTargetedWechatPrivateMessages(page, recoveryPayload(), recovery);
  assert.equal(reads, 2);
  assert.equal(output.ok, true);
  assert.equal(output.messages.length, 1);
  assert.equal(output.messages[0].context.conversationId, 'stable-target-1');
});

test('B站恢复会话只按 talkerId 唯一选择并报告缺失目标', () => {
  const sessions = [
    { session_type: 1, talker_id: 1001, unread_count: 0 },
    { session_type: 1, talker_id: 1002, unread_count: 4 },
    { session_type: 2, talker_id: 1003, unread_count: 1 }
  ];
  const selected = selectBilibiliRecoverySessions(sessions, [{ externalConversationKey: '1001' }, { externalConversationKey: '1002' }]);
  assert.equal(selected.ok, true);
  assert.deepEqual(selected.sessions.map(item => String(item.talker_id)), ['1001', '1002']);
  const missing = selectBilibiliRecoverySessions(sessions, [{ externalConversationKey: '9999' }]);
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, 'RECOVERY_TARGET_NOT_FOUND');
  assert.deepEqual(missing.missingTargetIds, ['9999']);
});
