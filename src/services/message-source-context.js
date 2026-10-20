function clean(value = '') { return String(value || '').normalize('NFC').replace(/\s+/g, ' ').trim(); }

function messageContext(message = {}) {
  const context = {};
  for (const value of [message.context_json, message.context]) {
    try {
      const parsed = typeof value === 'string' ? JSON.parse(value) : value;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) Object.assign(context, parsed);
    } catch {}
  }
  return context;
}

// The source topic identifies the business being discussed; it is never answer evidence.
export function commentSourceTopicAnchor(message = {}, messageType = 'COMMENT', { requireVerified = false } = {}) {
  if (String(messageType).toUpperCase() !== 'COMMENT') return null;
  const context = messageContext(message);
  if (context.sourceVerified === false || (requireVerified && context.sourceVerified !== true)) return null;
  const topic = [context.sourceVideoTitle, context.postTitle, context.noteTitle, context.sourceTitle,
    context.videoTitle, context.workTitle, context.subjectTitle,
    context.source_video_title, context.post_title, context.note_title, context.source_title, context.subject_title]
    .map(clean).find(Boolean);
  return topic ? { text: [...topic].slice(0, 600).join(''), sourceMessageId: message.id || null, source: 'source_post' } : null;
}

export function ragQuestionForMessage(message = {}) {
  const question = String(message.content || '').trim();
  const anchor = commentSourceTopicAnchor(message, message.message_type, { requireVerified: true });
  if (!question || !anchor) return question;
  const prefix = `用户评论：${question}\n评论所属作品（仅用于识别咨询对象，不是回答依据）：`;
  // V1 caps query.text at 4000 code points. Preserve the complete current question.
  const remaining = 4000 - [...prefix].length - 2;
  if (remaining < 20) return question;
  const topic = [...anchor.text].slice(0, remaining).join('');
  return `${prefix}「${topic}」`;
}
