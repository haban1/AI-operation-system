const SYSTEM_CONVERSATION_NAMES = new Set([
  '创作者小助手', '服务通知', '系统通知', '活动通知', '钱包通知', '微博小秘书',
  '微博客服', '微博管理员', '微博安全中心', '微博服务', '粉丝服务', '留言板', '阿里巴巴云客服',
  // 微博消息页中的一方资讯/运营会话可能没有 V 标，但仍不是用户咨询。
  '热搜简报', '微博热搜', '微博热点', '微博热议', '微博视频', '微博积分'
]);

const PLATFORM_OFFICIAL_NAME_RE = /^(?:微博(?:小秘书|客服|管理员|安全中心|服务|健康|医美|会员|钱包)|新浪(?:新闻|赛事|客服|微博)|创作者小助手)$/;
const SYSTEM_NAME_RE = /(?:系统|服务|活动|钱包|创作者).{0,4}通知$|^(?:通知|公告)$/;
const BROADCAST_PREVIEW_RE = /(?:发来了一条链接消息|发布了一条链接消息|系统消息|系统通知|服务通知|活动通知|查看详情|点击进入|戳这里|获得更多曝光|广告分成|权益及功能服务)/i;

function clean(value) {
  return String(value ?? '').replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\s+/g, ' ').trim();
}

function configuredNames(value) {
  if (Array.isArray(value)) return new Set(value.map(clean).filter(Boolean));
  return new Set(String(value || '').split(/[,，;；\n]/).map(clean).filter(Boolean));
}

/**
 * Classifies a Weibo private conversation before it enters risk/knowledge/reply processing.
 * Only HIGH confidence classifications are automatically ignored. REVIEW is retained so that
 * verified real users are not silently discarded merely because they have a V badge.
 */
export function assessWeiboConversationSource(candidate = {}, options = {}) {
  const userName = clean(candidate.userName || candidate.user_name);
  const preview = clean(candidate.preview || candidate.content);
  const messageType = clean(candidate.messageType || candidate.message_type || 'PRIVATE_MESSAGE').toUpperCase();
  const verifiedAccount = candidate.verifiedAccount === true || candidate.verified_account === true;
  const configuredExclude = configuredNames(options.excludeNames || process.env.WEIBO_EXCLUDED_CONVERSATIONS);
  const configuredAllow = configuredNames(options.allowNames || process.env.WEIBO_USER_CONVERSATION_ALLOWLIST);
  const signals = [];

  if (messageType !== 'PRIVATE_MESSAGE') {
    return { applicable: false, isOfficial: false, confidence: 'NONE', reason: 'NOT_WEIBO_PRIVATE_CONVERSATION', signals };
  }
  if (!userName) {
    return { applicable: true, isOfficial: false, confidence: 'REVIEW', reason: 'CONVERSATION_NAME_MISSING', signals: ['NAME_MISSING'] };
  }
  if (configuredAllow.has(userName)) {
    return { applicable: true, isOfficial: false, confidence: 'HIGH', reason: 'CONFIGURED_USER_ALLOWLIST', signals: ['ALLOWLIST_NAME'] };
  }
  if (configuredExclude.has(userName)) signals.push('CONFIGURED_EXCLUDE_NAME');
  if (SYSTEM_CONVERSATION_NAMES.has(userName)) signals.push('SYSTEM_EXACT_NAME');
  if (SYSTEM_NAME_RE.test(userName)) signals.push('SYSTEM_NAME_PATTERN');
  if (PLATFORM_OFFICIAL_NAME_RE.test(userName)) signals.push('PLATFORM_OFFICIAL_NAME');
  if (verifiedAccount) signals.push('VERIFIED_BADGE');
  if (BROADCAST_PREVIEW_RE.test(preview)) signals.push('BROADCAST_PREVIEW');

  const highConfidence = signals.includes('CONFIGURED_EXCLUDE_NAME')
    || signals.includes('SYSTEM_EXACT_NAME')
    || signals.includes('SYSTEM_NAME_PATTERN')
    || signals.includes('PLATFORM_OFFICIAL_NAME')
    || (signals.includes('VERIFIED_BADGE') && signals.includes('BROADCAST_PREVIEW'));

  if (highConfidence) {
    return {
      applicable: true,
      isOfficial: true,
      confidence: 'HIGH',
      reason: signals.includes('CONFIGURED_EXCLUDE_NAME') ? 'WEIBO_CONFIGURED_OFFICIAL_CONVERSATION' : 'WEIBO_OFFICIAL_OR_SYSTEM_CONVERSATION',
      signals
    };
  }
  if (verifiedAccount) {
    return { applicable: true, isOfficial: false, confidence: 'REVIEW', reason: 'VERIFIED_ACCOUNT_WITHOUT_SYSTEM_EVIDENCE', signals };
  }
  return { applicable: true, isOfficial: false, confidence: 'HIGH', reason: 'WEIBO_USER_CONVERSATION', signals };
}

export function isHighConfidenceWeiboOfficialConversation(candidate = {}, options = {}) {
  const assessment = assessWeiboConversationSource(candidate, options);
  return assessment.isOfficial === true && assessment.confidence === 'HIGH';
}
