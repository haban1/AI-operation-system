function normalizedContext(input = {}) {
  if (input.context && typeof input.context === 'object') return input.context;
  if (input.messageContext && typeof input.messageContext === 'object') return input.messageContext;
  return {};
}

export function assessWeiboMessagePrecision(input = {}) {
  const context = normalizedContext(input);
  const platformCode = String(input.platformCode || input.platform_code || context.platformCode || '').trim().toLowerCase();
  const messageType = String(input.messageType || input.message_type || '').trim().toUpperCase();
  if (platformCode !== 'weibo') {
    return { ok: true, applicable: false, reason: 'NOT_WEIBO_MESSAGE' };
  }

  if (context.historical === true) {
    return {
      ok: false,
      applicable: true,
      reason: 'WEIBO_HISTORICAL_MESSAGE',
      message: '微博消息已判定为历史数据，仅允许进入人工处理，禁止自动向真人发送回复。'
    };
  }

  if (messageType === 'PRIVATE_MESSAGE') {
    if (context.previewOnly === true) {
      return {
        ok: false,
        applicable: true,
        reason: 'WEIBO_PRIVATE_PREVIEW_ONLY',
        message: '微博私信当前只有会话列表预览，未取得唯一原消息气泡，禁止自动回复。'
      };
    }
    if (!String(context.messageId || '').trim()) {
      return {
        ok: false,
        applicable: true,
        reason: 'WEIBO_PRIVATE_MESSAGE_ID_MISSING',
        message: '微博私信缺少稳定消息 ID，无法唯一定位原消息，禁止自动回复。'
      };
    }
    if (String(context.direction || '').trim().toLowerCase() !== 'incoming') {
      return {
        ok: false,
        applicable: true,
        reason: 'WEIBO_PRIVATE_DIRECTION_UNVERIFIED',
        message: '微博私信未确认是对方发来的消息，禁止自动回复。'
      };
    }
    if (context.sourceVerified !== true || context.chatTitleVerified !== true) {
      return {
        ok: false,
        applicable: true,
        reason: 'WEIBO_PRIVATE_SOURCE_UNVERIFIED',
        message: '微博私信的原消息气泡或会话标题未完成精确核验，禁止自动回复。'
      };
    }
    return { ok: true, applicable: true, reason: 'WEIBO_PRIVATE_MESSAGE_VERIFIED' };
  }

  if (messageType === 'COMMENT') {
    if (!String(context.commentId || '').trim()) {
      return {
        ok: false,
        applicable: true,
        reason: 'WEIBO_COMMENT_ID_MISSING',
        message: '微博评论缺少稳定评论 ID，无法唯一定位目标评论，禁止自动回复。'
      };
    }
    if (context.sourceVerified !== true) {
      return {
        ok: false,
        applicable: true,
        reason: 'WEIBO_COMMENT_SOURCE_UNVERIFIED',
        message: '微博评论来源未完成精确核验，禁止自动回复。'
      };
    }
    return { ok: true, applicable: true, reason: 'WEIBO_COMMENT_VERIFIED' };
  }

  return { ok: true, applicable: true, reason: 'WEIBO_MESSAGE_TYPE_NOT_AUTOMATED' };
}