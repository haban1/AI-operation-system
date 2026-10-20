import { isAiReplyTimeout } from './ai-reply-error.js';

const PLATFORM_FALLBACK_NAMES = {
  xiaohongshu: '小红书',
  douyin: '抖音',
  wechat_channels: '视频号',
  bilibili: 'B站',
  weibo: '微博',
  mini_program: '小程序'
};

const MANUAL_REASON_LABELS = Object.freeze({
  STABLE_POST_ID_REQUIRED: '未能确认该评论所属的平台作品，暂时无法安全自动回复',
  STABLE_COMMENT_ID_REQUIRED: '未能确认该评论的稳定编号，暂时无法安全自动回复',
  STABLE_MESSAGE_ID_REQUIRED: '未能确认该私信的稳定编号，暂时无法安全自动回复',
  STABLE_CONVERSATION_ID_REQUIRED: '未能确认该私信所属的唯一会话，暂时无法安全自动回复',
  SOURCE_PAGE_NOT_VERIFIED: '评论来源页面尚未完成核验，暂时无法安全自动回复',
  FULL_MESSAGE_SOURCE_NOT_VERIFIED: '私信原文来源尚未完成核验，暂时无法安全自动回复',
  CONVERSATION_TITLE_NOT_VERIFIED: '私信会话对象尚未完成核验，暂时无法安全自动回复',
  SIDEBAR_PREVIEW_NOT_SENDABLE: '当前只获取到私信列表预览，尚未取得可安全回复的完整消息',
  TARGET_NOT_UNIQUE: '平台页面中存在多个相似目标，无法确保回复到正确消息',
  TARGET_DOM_CHANGED: '定位后平台页面内容发生变化，无法确保回复到正确消息',
  PAGE_SECURITY_OR_ERROR_STATE: '平台页面出现安全验证或异常状态，自动回复已暂停',
  AUTO_REPLY_INELIGIBLE: '当前消息的定位证据不足，暂时无法安全自动回复'
});

export function humanizeManualReason(value) {
  const reason = inlineText(value);
  if (isAiReplyTimeout(reason)) return 'AI回复超时';
  return MANUAL_REASON_LABELS[reason] || reason || '系统判定需人工处理';
}

function inlineText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function firstValue(source, keys) {
  for (const key of keys) {
    const value = inlineText(source?.[key]);
    if (value) return value;
  }
  return '';
}

export function normalizePlatformUserName(value) {
  const parts = String(value ?? '')
    .split(/\r?\n/)
    .map(inlineText)
    .filter(Boolean)
    .filter(part => !/^(你的好友|已关注|关注|粉丝|用户)$/.test(part));
  return parts[0] || '未知用户';
}

export function platformDisplayName(code, name = '') {
  return inlineText(name) || PLATFORM_FALLBACK_NAMES[inlineText(code)] || inlineText(code) || '未知平台';
}

export function extractPlatformPostId(value) {
  const text = inlineText(value);
  if (!text) return '';
  if (!/^https?:\/\//i.test(text)) return text;
  try {
    const url = new URL(text);
    const patterns = [
      /\/(?:explore|discovery\/item|note|video)\/([^/?#]+)/i,
      /\/(?:item|post)\/([^/?#]+)/i
    ];
    for (const pattern of patterns) {
      const match = url.pathname.match(pattern);
      if (match?.[1]) return decodeURIComponent(match[1]);
    }
    return inlineText(url.searchParams.get('note_id') || url.searchParams.get('item_id') || url.searchParams.get('id'));
  } catch {
    return '';
  }
}

function comparableUrl(value) {
  const text = inlineText(value);
  if (!text) return '';
  try {
    const url = new URL(text);
    return `${url.origin}${url.pathname}`.replace(/\/$/, '').toLowerCase();
  } catch {
    return text.replace(/[?#].*$/, '').replace(/\/$/, '').toLowerCase();
  }
}

function allValues(source, keys) {
  return [...new Set(keys.map(key => inlineText(source?.[key])).filter(Boolean))];
}

function normalizedPublishedAt(value) {
  const text = inlineText(value);
  if (!text) return '';
  if (/^\d{10}$/.test(text)) return new Date(Number(text) * 1000).toISOString();
  if (/^\d{13}$/.test(text)) return new Date(Number(text)).toISOString();
  return text;
}

export function resolveRelatedNote(context = {}, candidates = []) {
  const noteUrls = allValues(context, ['noteUrl', 'note_url', 'platformUrl', 'platform_url', 'postUrl', 'post_url', 'sourceVideoUrl', 'source_video_url']);
  const noteIds = [...new Set([
    ...allValues(context, [
      'noteId', 'note_id', 'platformPostId', 'platform_post_id', 'postId', 'post_id',
      'sourceVideoKey', 'source_video_key', 'sourceVideoCandidateKey', 'source_video_candidate_key',
      'sourceVideoOpaqueKey', 'source_video_opaque_key', 'awemeId', 'aweme_id', 'oid', 'bvid'
    ]),
    ...noteUrls.map(extractPlatformPostId).filter(Boolean)
  ])];
  const noteUrl = noteUrls[0] || '';
  const noteTitle = firstValue(context, [
    'noteTitle', 'note_title', 'postTitle', 'post_title', 'sourceVideoTitle', 'source_video_title',
    'sourceVideoDescription', 'source_video_description', 'subjectTitle', 'subject_title'
  ]);
  const notePublishedAt = normalizedPublishedAt(firstValue(context, [
    'notePublishedAt', 'note_published_at', 'publishedAt', 'published_at', 'postPublishedAt', 'post_published_at',
    'sourceVideoTime', 'source_video_time', 'sourceVideoPublishedAt', 'source_video_published_at'
  ]));
  const normalizedTitle = noteTitle.toLocaleLowerCase('zh-CN');
  const normalizedUrl = comparableUrl(noteUrl);

  const candidateDetails = candidates.map(candidate => ({
    candidate,
    ids: allValues(candidate, ['platformPostId', 'platform_post_id', 'postId', 'post_id', 'opaqueKey', 'opaque_key']),
    url: firstValue(candidate, ['platformUrl', 'platform_url', 'postUrl', 'post_url']),
    title: firstValue(candidate, ['title', 'noteTitle', 'note_title', 'description', 'subjectTitle', 'subject_title']),
    publishedAt: normalizedPublishedAt(firstValue(candidate, [
      'publishedAt', 'published_at', 'submittedAt', 'submitted_at', 'reviewedAt', 'reviewed_at', 'updatedAt', 'updated_at', 'publishedAtRaw', 'published_at_raw'
    ]))
  }));
  for (const detail of candidateDetails) {
    const extracted = extractPlatformPostId(detail.url);
    if (extracted && !detail.ids.includes(extracted)) detail.ids.push(extracted);
  }

  const matchedDetail = candidateDetails.find(detail => noteIds.some(id => detail.ids.includes(id)))
    || candidateDetails.find(detail => normalizedUrl && comparableUrl(detail.url) === normalizedUrl)
    || candidateDetails.find(detail => normalizedTitle && detail.title.toLocaleLowerCase('zh-CN') === normalizedTitle)
    || null;
  const matched = matchedDetail?.candidate || null;

  return {
    id: matchedDetail?.ids[0] || noteIds[0] || null,
    url: noteUrl || matchedDetail?.url || null,
    title: noteTitle || matchedDetail?.title || null,
    publishedAt: notePublishedAt || matchedDetail?.publishedAt || null,
    matched: Boolean(matched)
  };
}

export function formatNotificationDate(value) {
  const text = inlineText(value);
  if (!text) return '未识别';
  if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(text)) return text.replace(/-/g, '/');
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return text;
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric', month: 'numeric', day: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false
  }).format(date).replace(/\s+/g, ' ');
}

export function buildManualNotification({
  message,
  platformName,
  note = {},
  reason,
  titleSuffix = '需要转人工',
  actionText = '需要转人工',
  reasonLabel = '转人工原因'
}) {
  const platform = platformDisplayName(message?.platform_code, platformName);
  const userName = normalizePlatformUserName(message?.user_name);
  const isPrivate = String(message?.message_type || '').toUpperCase() === 'PRIVATE_MESSAGE';
  const sourceName = isPrivate ? '私信' : '评论区';
  const contentLabel = isPrivate ? '私信内容' : '评论内容';
  const messageContent = inlineText(message?.content) || '（内容为空）';
  const reasonText = humanizeManualReason(reason);
  let context = {};
  try { context = typeof message?.context_json === 'string' ? JSON.parse(message.context_json || '{}') : (message?.context_json || {}); } catch {}
  const entryType = firstValue(context, ['messageEntry', 'entryType', 'sourceTab', 'inboxType', 'listType']) || sourceName;
  const identityConfidence = inlineText(message?.identity_confidence) || (firstValue(context, ['conversationKey', 'conversationId', 'chatId', 'sessionId', 'userId', 'senderId']) ? 'HIGH' : 'LOW');
  const conversationNumber = inlineText(message?.conversation_key_snapshot) || firstValue(context, ['conversationKey', 'conversationId', 'chatId', 'sessionId']) || `消息#${message?.id || '未识别'}`;
  let relatedNote;
  if (note?.title || note?.publishedAt) {
    relatedNote = `《${inlineText(note.title) || '标题未识别'}》（发布时间：${formatNotificationDate(note.publishedAt)}）`;
  } else if (!isPrivate && inlineText(note?.id)) {
    relatedNote = `${platform}作品 ${inlineText(note.id)}（标题暂未识别）`;
  } else {
    relatedNote = isPrivate ? '无（私信会话）' : '标题未识别（发布时间：未识别）';
  }

  return {
    title: `【${platform}·${sourceName}】${userName}${inlineText(titleSuffix) || '需要转人工'}`,
    content: [
      `发布平台：${platform}`,
      `用户名称：${userName}`,
      `消息来源：${sourceName}`,
      `关联笔记：${relatedNote}`,
      `${contentLabel}：“${messageContent}”`,
      ...(message?.platform_code === 'mini_program' ? [
        `用户 ID：${inlineText(context.userId) || '未识别'}`,
        `会话 ID：${inlineText(context.conversationId) || '未识别'}`
      ] : []),
      `处理要求：${inlineText(actionText) || '需要转人工'}`,
      `${inlineText(reasonLabel) || '转人工原因'}：${reasonText}`,
      `Web消息编号：#${message?.id || '未识别'}`,
      message?.platform_code === 'mini_program'
        ? '请根据企业微信通知中的用户 ID 和会话 ID，在小程序客服系统中继续对接。'
        : platform === '微博'
        ? '可在 Web 端“评论与私信”中点击“人工回复”，系统会精确定位原消息并核验发送回执。'
        : `请到${platform}官方 App 回复，处理后回到 Web 端标记“人工已处理”。`
    ].join('\n')
  };
}

