const EXPORT_HEADERS = [
  '记录编号', '平台', '账号', '消息类型', '关联帖子/视频', '用户昵称', '用户原消息',
  '回复方式', '回复内容', '回复状态', '回复时间', '处理人', '处理说明', '原消息链接'
];

const MESSAGE_TYPE_LABELS = {
  COMMENT: '评论',
  PRIVATE_MESSAGE: '私信'
};

function inlineText(value) {
  return String(value ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
}

function safeSpreadsheetText(value) {
  const text = inlineText(value);
  return /^[=+\-@]/.test(text) ? `'${text}` : text;
}

function csvCell(value) {
  const text = safeSpreadsheetText(value).replace(/"/g, '""');
  return `"${text}"`;
}

function formatExportTime(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return inlineText(value);
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  }).formatToParts(date).reduce((result, part) => ({ ...result, [part.type]: part.value }), {});
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

function replyMode(item) {
  if (item.status === 'AUTO_REPLIED' || item.handled_by === 'AI_RPA') return 'AI自动回复';
  if (item.handled_by === 'PLATFORM_DETECTED') return '平台人工回复（系统检测）';
  return '人工回复';
}

export function messageReplyExportRows(items = []) {
  return items
    .filter(item => !item?.deleted_at && item?.decision !== 'SELF_MESSAGE' && item?.status !== 'IGNORED_SELF' && item?.handled_at && (item.status === 'AUTO_REPLIED' || item.status === 'MANUAL_HANDLED' || item.handled_by))
    .map(item => [
      item.id,
      item.platform_name || item.platform_code,
      item.account_name || item.account_id,
      MESSAGE_TYPE_LABELS[String(item.message_type || '').toUpperCase()] || item.message_type,
      item.post_title || (String(item.message_type || '').toUpperCase() === 'PRIVATE_MESSAGE' ? '私信会话' : '未识别关联帖子'),
      item.user_name,
      item.content,
      replyMode(item),
      item.reply_text || '',
      '已回复',
      formatExportTime(item.handled_at || item.updated_at),
      item.handled_by || '',
      item.handler_note || '',
      item.external_url || item.post_url || ''
    ]);
}

export function buildMessageReplyCsv(items = []) {
  const bodyRows = messageReplyExportRows(items);
  return `\uFEFF${[EXPORT_HEADERS, ...bodyRows].map(row => row.map(csvCell).join(',')).join('\r\n')}\r\n`;
}

export function messageReplyExportFilename(date = new Date()) {
  const formatter = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  });
  const parts = formatter.formatToParts(date).reduce((result, part) => ({ ...result, [part.type]: part.value }), {});
  return `平台回复记录-${parts.year}${parts.month}${parts.day}-${parts.hour}${parts.minute}${parts.second}.csv`;
}
