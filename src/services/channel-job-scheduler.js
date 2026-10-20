import { config } from '../config.js';
import { normalizeChannelType } from './message-channel.js';

const PLATFORM_FLAG_KEYS = {
  douyin: 'platformChannelSplitDouyin',
  xiaohongshu: 'platformChannelSplitXiaohongshu',
  wechat_channels: 'platformChannelSplitWechatChannels',
  bilibili: 'platformChannelSplitBilibili',
  weibo: 'platformChannelSplitWeibo'
};

export function platformChannelSplitEnabled(platformCode, featureConfig = config) {
  const code = String(platformCode || '').trim().toLowerCase();
  const platformFlag = PLATFORM_FLAG_KEYS[code];
  return Boolean(featureConfig?.channelSplitEnabled && platformFlag && featureConfig?.[platformFlag]);
}

export function normalizeRequestedCollectionTypes(types) {
  const source = Array.isArray(types) && types.length ? types : ['COMMENT', 'PRIVATE_MESSAGE'];
  const normalized = [];
  for (const item of source) {
    try {
      const channel = normalizeChannelType(item);
      if (!normalized.includes(channel)) normalized.push(channel);
    } catch {}
  }
  return normalized.length ? normalized : ['COMMENT', 'PRIVATE_MESSAGE'];
}

/**
 * 保留现有 COLLECT_MESSAGES 物理 Job，先把私信/评论拆成两个互不覆盖的逻辑队列。
 * 默认开关关闭时返回原来的合并任务，确保上线前行为不变。
 */
export function buildCollectionChannelPlans({ platformCode, requestedTypes, featureConfig = config } = {}) {
  const types = normalizeRequestedCollectionTypes(requestedTypes);
  if (!platformChannelSplitEnabled(platformCode, featureConfig) || types.length === 1) {
    const singleChannel = types.length === 1 ? types[0] : null;
    return [{
      channelType: singleChannel,
      queueLane: singleChannel || 'COMBINED',
      types,
      idempotencySuffix: singleChannel ? `:${singleChannel.toLowerCase()}` : ''
    }];
  }
  return types.map(channelType => ({
    channelType,
    queueLane: channelType,
    types: [channelType],
    idempotencySuffix: `:${channelType.toLowerCase()}`
  }));
}

export function collectionPlanAlreadyActive(activePayloads, accountId, plan) {
  const payloads = Array.isArray(activePayloads) ? activePayloads : [];
  return payloads.some(payload => {
    if (Number(payload?.accountId) !== Number(accountId)) return false;
    const activeChannel = String(payload?.channelType || payload?.queueLane || '').trim().toUpperCase();
    if (!activeChannel || activeChannel === 'COMBINED') return true;
    if (!plan?.channelType) return true;
    return activeChannel === plan.channelType;
  });
}

