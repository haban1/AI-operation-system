function normalizedContext(input = {}) {
  if (input.context && typeof input.context === 'object') return input.context;
  if (input.messageContext && typeof input.messageContext === 'object') return input.messageContext;
  return {};
}

export function assessDouyinPrivatePreview(input = {}) {
  const context = normalizedContext(input);
  const platformCode = String(input.platformCode || input.platform_code || context.platformCode || '').trim().toLowerCase();
  const messageType = String(input.messageType || input.message_type || '').trim().toUpperCase();
  if (platformCode !== 'douyin' || messageType !== 'PRIVATE_MESSAGE') {
    return { ok: true, applicable: false, reason: 'NOT_DOUYIN_PRIVATE_MESSAGE' };
  }
  if (context.previewOnly !== true) {
    return { ok: true, applicable: true, reason: 'FULL_MESSAGE_OR_NON_PREVIEW_CONTEXT' };
  }
  const unreadCount = Number(context.unreadCount);
  if (!Number.isInteger(unreadCount) || unreadCount < 1) {
    return {
      ok: false,
      applicable: true,
      reason: 'PRIVATE_PREVIEW_UNREAD_COUNT_UNVERIFIED',
      unreadCount: Number.isFinite(unreadCount) ? unreadCount : null,
      message: '抖音私信当前只有列表预览，且未读数量未经可靠核验，禁止自动回复，请人工逐条确认。'
    };
  }
  if (unreadCount > 1) {
    return {
      ok: false,
      applicable: true,
      reason: 'PRIVATE_PREVIEW_MULTIPLE_UNREAD',
      unreadCount,
      message: `抖音私信会话有 ${unreadCount} 条未读，但当前仅采集到列表最后一条预览，尚未取得逐条消息正文，禁止自动回复。`
    };
  }
  return { ok: true, applicable: true, reason: 'SINGLE_UNREAD_PREVIEW_VERIFIED', unreadCount };
}
