import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { AssistedPlatformRpaAdapter, recoveryCollectionFailure, recoveryCollectionTargets } from './assisted-platform.js';
import { normalizeContentOrigin } from '../../src/services/content-origin.js';
import { validateReplyTextLength } from '../../src/services/platform-reply-policy.js';
import sharp from 'sharp';

const COMMENT_FEED_URL = 'https://api.bilibili.com/x/msgfeed/reply?platform=web&build=0&mobi_app=web';
const SESSION_LIST_URL = 'https://api.vc.bilibili.com/session_svr/v1/session_svr/get_sessions?session_type=1&group_fold=1&unfollow_fold=0&sort_rule=2&build=0&mobi_app=web';
const SESSION_MESSAGES_URL = 'https://api.vc.bilibili.com/svr_sync/v1/svr_sync/fetch_session_msgs';
const COMMENT_REPLY_URL = 'https://api.bilibili.com/x/v2/reply/add';
const PRIVATE_REPLY_URL = 'https://api.vc.bilibili.com/web_im/v1/web_im/send_msg';

function clean(value) { return String(value ?? '').replace(/\s+/g, ' ').trim(); }
function cleanMultiline(value) { return String(value ?? '').replace(/\r\n?/g, '\n').replace(/[\t\f\v]+/g, ' ').trim(); }
function escapeXml(value) { return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char]); }
function asNumber(value) { const n = Number(value); return Number.isFinite(n) ? n : null; }
function first(...values) { return values.find(value => value !== undefined && value !== null && value !== ''); }
function dataOf(response) { return response?.data && typeof response.data === 'object' ? response.data : {}; }
function listOf(value) { return Array.isArray(value) ? value : []; }
function bilibiliCommentFeedCursor(response) {
  const data = dataOf(response);
  const cursor = data?.cursor && typeof data.cursor === 'object' ? data.cursor : {};
  const isEnd = cursor.is_end === true || cursor.isEnd === true || Number(cursor.is_end) === 1 || data.is_end === true || Number(data.is_end) === 1;
  const id = firstPositiveIntegerId(cursor.id, cursor.cursor_id, cursor.max_id, data.cursor_id, data.max_id);
  const time = firstPositiveIntegerId(cursor.time, cursor.reply_time, cursor.timestamp, data.reply_time, data.cursor_time);
  return { isEnd, id: id || null, time: time || null, rawKeys: Object.keys(cursor).sort() };
}

export function buildBilibiliCommentFeedPageUrl(response) {
  const cursor = bilibiliCommentFeedCursor(response);
  if (cursor.isEnd || (!cursor.id && !cursor.time)) return null;
  const url = new URL(COMMENT_FEED_URL);
  if (cursor.id) url.searchParams.set('id', cursor.id);
  if (cursor.time) url.searchParams.set('reply_time', cursor.time);
  return url.href;
}
function isoFromSeconds(value) {
  const seconds = asNumber(value);
  return seconds && seconds > 0 ? new Date(seconds * 1000).toISOString() : null;
}
function parseTextContent(value) {
  if (value && typeof value === 'object') return cleanMultiline(first(value.content, value.text, value.message));
  const raw = cleanMultiline(value);
  if (!raw) return '';
  try {
    const parsed = JSON.parse(raw);
    return cleanMultiline(first(parsed?.content, parsed?.text, parsed?.message));
  } catch { return raw; }
}
function responseCode(response) { return Number(first(response?.code, response?.status, -1)); }
function requireApiSuccess(response, operation) {
  const code = responseCode(response);
  if (code !== 0) {
    const error = new Error(`${operation}失败（B站 API code=${code}）：${clean(first(response?.message, response?.msg, '未知错误'))}`);
    error.apiRejected = true;
    error.apiCode = code;
    throw error;
  }
  return response;
}
function mapMessageResponses(messageResponses, talkerId) {
  if (messageResponses instanceof Map) return messageResponses.get(String(talkerId)) || messageResponses.get(Number(talkerId));
  return messageResponses?.[String(talkerId)] || messageResponses?.[Number(talkerId)];
}
function firstPositiveIntegerId(...values) {
  for (const value of values) {
    const normalized = clean(value);
    if (/^[1-9]\d*$/.test(normalized)) return normalized;
  }
  return '';
}
function positiveIntegerId(value, field) {
  const normalized = firstPositiveIntegerId(value);
  if (!normalized) throw new Error(`B\u7ad9\u7cbe\u786e\u76ee\u6807\u7f3a\u5c11\u6709\u6548\u7684 ${field}`);
  return normalized;
}
function isPlatformStopError(error) {
  return ['PLATFORM_STOPPED', 'PLATFORM_OPERATION_CANCELLED'].includes(error?.code);
}
function dedupeMessages(messages) {
  const seen = new Set();
  return messages.filter(message => {
    const key = clean(message?.externalId);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function selectBilibiliRecoverySessions(sessions = [], targets = []) {
  const requested = [...new Set(targets.map(target => clean(target?.externalConversationKey)).filter(Boolean))];
  const invalidTargetIds = requested.filter(value => !/^[1-9]\d*$/.test(value));
  if (!requested.length || invalidTargetIds.length) {
    return { ok: false, reason: 'RECOVERY_STABLE_TARGET_REQUIRED', sessions: [], missingTargetIds: [], invalidTargetIds };
  }
  const matches = sessions.filter(session => {
    const talkerId = firstPositiveIntegerId(session?.talker_id, session?.receiver_id, session?.uid);
    return Number(first(session?.session_type, 1)) === 1 && requested.includes(talkerId);
  });
  const counts = new Map();
  for (const session of matches) {
    const talkerId = firstPositiveIntegerId(session?.talker_id, session?.receiver_id, session?.uid);
    counts.set(talkerId, (counts.get(talkerId) || 0) + 1);
  }
  const missingTargetIds = requested.filter(talkerId => !counts.has(talkerId));
  const ambiguousTargetIds = requested.filter(talkerId => (counts.get(talkerId) || 0) > 1);
  if (missingTargetIds.length || ambiguousTargetIds.length) {
    return { ok: false, reason: ambiguousTargetIds.length ? 'RECOVERY_TARGET_AMBIGUOUS' : 'RECOVERY_TARGET_NOT_FOUND', sessions: [], missingTargetIds, ambiguousTargetIds, invalidTargetIds: [] };
  }
  return { ok: true, reason: 'TARGETED_RECOVERY_SESSIONS_SELECTED', sessions: matches, missingTargetIds: [], ambiguousTargetIds: [], invalidTargetIds: [] };
}

function bilibiliSessionWatermark(session = {}) {
  const talkerId = firstPositiveIntegerId(session?.talker_id, session?.receiver_id, session?.uid);
  const seqno = asNumber(first(session?.last_msg_seqno, session?.last_msg?.msg_seqno, session?.last_seqno, session?.msg_seqno));
  const msgKey = firstPositiveIntegerId(session?.last_msg_key, session?.last_msg?.msg_key, session?.msg_key, session?.key);
  const timestamp = asNumber(first(session?.last_msg_time, session?.last_msg?.timestamp, session?.updated_at, session?.timestamp));
  return { talkerId: talkerId || null, seqno, msgKey: msgKey || null, timestamp };
}

function bilibiliSessionHasAdvanced(session, previous = {}) {
  const current = bilibiliSessionWatermark(session);
  const prior = previous && typeof previous === 'object' ? previous : {};
  if (!current.talkerId) return false;
  if (current.seqno !== null && Number(prior.seqno) > 0 && current.seqno > Number(prior.seqno)) return true;
  if (current.msgKey && Number(prior.msgKey) > 0 && Number(current.msgKey) > Number(prior.msgKey)) return true;
  if (current.timestamp !== null && Number(prior.timestamp) > 0 && current.timestamp > Number(prior.timestamp)) return true;
  return false;
}

function buildBilibiliCollectionWatermarks(messages = [], { commentMessages = [] } = {}) {
  const privateSessionWatermarks = {};
  const commentNotificationIds = [];
  const addPrivateSession = (session = {}) => {
    const current = bilibiliSessionWatermark(session);
    if (!current.talkerId) return;
    const key = String(current.talkerId);
    const previous = privateSessionWatermarks[key] || {};
    const maxSeqno = Math.max(Number(previous.seqno || 0), Number(current.seqno || 0));
    const maxMsgKey = Math.max(Number(previous.msgKey || 0), Number(current.msgKey || 0));
    const maxTimestamp = Math.max(Number(previous.timestamp || 0), Number(current.timestamp || 0));
    privateSessionWatermarks[key] = {
      talkerId: key,
      seqno: maxSeqno > 0 ? maxSeqno : null,
      msgKey: maxMsgKey > 0 ? String(maxMsgKey) : null,
      timestamp: maxTimestamp > 0 ? maxTimestamp : null
    };
  };
  for (const message of messages) {
    const context = message?.context && typeof message.context === 'object' ? message.context : {};
    if (String(message?.messageType || '').toUpperCase() === 'PRIVATE_MESSAGE' && context.talkerId) {
      addPrivateSession({
        talker_id: context.talkerId,
        last_msg_seqno: context.msgSeqno,
        last_msg_key: context.msgKey,
        last_msg_time: context.messageTimestamp
      });
    }
    if (String(message?.messageType || '').toUpperCase() === 'COMMENT' && context.notificationId) {
      commentNotificationIds.push(String(context.notificationId));
    }
  }
  for (const message of commentMessages || []) {
    const context = message?.context && typeof message.context === 'object' ? message.context : {};
    if (context.notificationId) commentNotificationIds.push(String(context.notificationId));
  }
  return {
    COMMENT: { notificationIds: [...new Set(commentNotificationIds)].filter(Boolean).slice(-100) },
    PRIVATE_MESSAGE: { sessions: privateSessionWatermarks }
  };
}

function localDateParts(date) {
  return {
    year: date.getFullYear(), month: date.getMonth() + 1, day: date.getDate(),
    hour: date.getHours(), minute: date.getMinutes(), second: date.getSeconds()
  };
}

function localIso(year, month, day, hour = 0, minute = 0, second = 0) {
  const date = new Date(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second), 0);
  if (Number.isNaN(date.getTime())) return null;
  if (date.getFullYear() !== Number(year) || date.getMonth() + 1 !== Number(month) || date.getDate() !== Number(day)) return null;
  return date.toISOString();
}

export function parseBilibiliDuration(value, expectedSeconds = null) {
  const text = clean(value);
  const expected = expectedSeconds === null || expectedSeconds === undefined || expectedSeconds === '' ? null : Number(expectedSeconds);
  const candidates = [];
  for (const match of text.matchAll(/(?:^|\s)(\d{1,3}:\d{2}(?::\d{2})?)(?=\s|$)/g)) {
    const durationText = match[1];
    const index = Number(match.index || 0) + match[0].indexOf(durationText);
    const prefix = text.slice(Math.max(0, index - 24), index);
    if (/(?:\d{4}[\u5e74./-]\d{1,2}[\u6708./-]\d{1,2}\u65e5?|\u4eca\u5929|\u6628\u65e5|\u6628\u5929)\s*$/.test(prefix)) continue;
    const parts = durationText.split(':').map(Number);
    if (parts.some(part => !Number.isFinite(part)) || parts.at(-1) >= 60 || (parts.length === 3 && parts[1] >= 60)) continue;
    const seconds = parts.length === 3 ? parts[0] * 3600 + parts[1] * 60 + parts[2] : parts[0] * 60 + parts[1];
    candidates.push({ text: durationText, seconds, index });
  }
  if (!candidates.length) return null;
  const selected = Number.isFinite(expected) && expected >= 0
    ? candidates.slice().sort((left, right) => Math.abs(left.seconds - expected) - Math.abs(right.seconds - expected) || left.index - right.index)[0]
    : candidates[0];
  return { ...selected, candidates: candidates.map(({ text: itemText, seconds }) => ({ text: itemText, seconds })) };
}

export function parseBilibiliSubmittedAt(value, referenceDate = new Date()) {
  const text = clean(value);
  const nowDate = referenceDate instanceof Date ? referenceDate : new Date(referenceDate);
  if (!text || Number.isNaN(nowDate.getTime())) return null;

  const relative = text.match(/(?:^|\s)(\d+)\s*(\u5206\u949f\u524d|\u5c0f\u65f6\u524d|\u5929\u524d)(?:\s|$)/);
  if (relative) {
    const amount = Number(relative[1]);
    const unitMs = relative[2] === '\u5206\u949f\u524d' ? 60_000 : relative[2] === '\u5c0f\u65f6\u524d' ? 3_600_000 : 86_400_000;
    return { text: relative[0].trim(), iso: new Date(nowDate.getTime() - amount * unitMs).toISOString(), precision: 'minute' };
  }

  const relativeDay = text.match(/(?:^|\s)(\u4eca\u5929|\u6628\u65e5|\u6628\u5929)(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (relativeDay) {
    const date = new Date(nowDate);
    if (relativeDay[1] !== '\u4eca\u5929') date.setDate(date.getDate() - 1);
    const parts = localDateParts(date);
    const hasTime = relativeDay[2] !== undefined;
    const iso = localIso(parts.year, parts.month, parts.day, hasTime ? relativeDay[2] : 0, hasTime ? relativeDay[3] : 0, hasTime ? (relativeDay[4] || 0) : 0);
    return iso ? { text: relativeDay[0].trim(), iso, precision: hasTime ? 'minute' : 'day' } : null;
  }

  const full = text.match(/(20\d{2})[\u5e74./-](\d{1,2})[\u6708./-](\d{1,2})\u65e5?(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (full) {
    const hasTime = full[4] !== undefined;
    const iso = localIso(full[1], full[2], full[3], hasTime ? full[4] : 0, hasTime ? full[5] : 0, hasTime ? (full[6] || 0) : 0);
    return iso ? { text: full[0], iso, precision: hasTime ? 'minute' : 'day' } : null;
  }

  const short = text.match(/(?:^|\s)(\d{1,2})[\u6708./-](\d{1,2})\u65e5?(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (short) {
    const parts = localDateParts(nowDate);
    const hasTime = short[3] !== undefined;
    const iso = localIso(parts.year, short[1], short[2], hasTime ? short[3] : 0, hasTime ? short[4] : 0, hasTime ? (short[5] || 0) : 0);
    return iso ? { text: short[0].trim(), iso, precision: hasTime ? 'minute' : 'day' } : null;
  }
  return null;
}

function managementRecordPredatesTask(submittedAt, taskCreatedAt, toleranceMs = 15 * 60 * 1000) {
  if (!submittedAt?.iso || !taskCreatedAt) return false;
  const submitted = new Date(submittedAt.iso);
  const created = new Date(taskCreatedAt);
  if (Number.isNaN(submitted.getTime()) || Number.isNaN(created.getTime())) return false;
  if (submittedAt.precision === 'day') {
    return submitted.getFullYear() < created.getFullYear()
      || (submitted.getFullYear() === created.getFullYear() && submitted.getMonth() < created.getMonth())
      || (submitted.getFullYear() === created.getFullYear() && submitted.getMonth() === created.getMonth() && submitted.getDate() < created.getDate());
  }
  return submitted.getTime() < created.getTime() - toleranceMs;
}


export function assessBilibiliManagementRecord(payload = {}, record = {}, referenceDate = new Date()) {
  const reviewStatus = String(record.reviewStatus || 'UNKNOWN').toUpperCase();
  const text = clean(record.text);
  const platformUrl = clean(record.platformUrl || record.href);
  const platformPostId = first(platformUrl.match(/\/video\/(BV[0-9A-Za-z]+)/i)?.[1], text.match(/\b(BV[0-9A-Za-z]{10,})\b/i)?.[1]) || null;
  const expectedDurationSeconds = asNumber(first(payload.materialMeta?.durationSeconds, payload.draftFingerprint?.durationSeconds));
  const duration = parseBilibiliDuration(text, expectedDurationSeconds);
  const taskCreatedAt = first(payload.taskCreatedAt, payload.draftFingerprint?.createdAt);
  const submittedAt = parseBilibiliSubmittedAt(text, referenceDate);
  const managementMatch = {
    title: clean(payload.title),
    durationText: duration?.text || null,
    durationSeconds: duration?.seconds ?? null,
    expectedDurationSeconds,
    submittedText: submittedAt?.text || null,
    submittedAt: submittedAt?.iso || null,
    submittedAtPrecision: submittedAt?.precision || null,
    taskCreatedAt: taskCreatedAt || null,
    platformPostId,
    platformUrl: platformUrl || null,
    reviewStatus,
    recordText: text,
    href: platformUrl || null
  };
  const blocked = reason => ({ checked: true, matched: false, titleMatched: true, blocked: true, reason, managementMatch, match: managementMatch });
  if (!['PUBLISHED', 'REVIEWING', 'REJECTED'].includes(reviewStatus)) return blocked('TITLE_MATCH_STATUS_UNKNOWN');
  if (expectedDurationSeconds !== null) {
    if (!duration) return blocked('DURATION_UNAVAILABLE');
    if (Math.abs(duration.seconds - expectedDurationSeconds) > 3) return blocked('DURATION_MISMATCH');
  }
  if (taskCreatedAt) {
    if (!submittedAt) return blocked('SUBMITTED_TIME_UNAVAILABLE');
    if (managementRecordPredatesTask(submittedAt, taskCreatedAt)) return blocked('RECORD_PREDATES_TASK');
  }
  return {
    checked: true,
    matched: true,
    reviewStatus,
    platformPostId,
    platformUrl: platformUrl || null,
    submittedAt: submittedAt?.iso || null,
    managementMatch,
    match: managementMatch
  };
}

export function extractBilibiliReplyReceipt(response, messageType) {
  if (responseCode(response) !== 0) return null;
  const data = dataOf(response);
  const type = String(messageType || '').toUpperCase();
  const candidate = type === 'COMMENT'
    ? first(data?.rpid, data?.reply?.rpid, data?.reply_id, data?.id)
    : first(data?.msg_key, data?.msgKey, data?.message_id, data?.message?.msg_key, data?.message?.msgKey);
  const normalized = clean(candidate);
  return /^[1-9]\d*$/.test(normalized) ? normalized : null;
}

export function parseBilibiliCommentFeed(response, selfUid = null) {
  if (responseCode(response) !== 0) return [];
  const data = dataOf(response);
  const items = listOf(first(data.items, data.replies, data.list));
  const ownUid = clean(selfUid);
  return items.map((entry, index) => {
    const item = entry?.item && typeof entry.item === 'object' ? entry.item : {};
    const user = entry?.user && typeof entry.user === 'object' ? entry.user : {};
    const content = cleanMultiline(first(
      entry?.reply_content,
      entry?.content,
      item?.source_content,
      item?.reply_content,
      item?.content,
      entry?.message
    ));
    const oid = clean(first(item?.subject_id, entry?.subject_id, entry?.oid));
    const replyType = clean(first(item?.business_id, entry?.business_id, item?.type, entry?.type));
    const sourceReplyId = clean(first(item?.source_id, entry?.source_id));
    const targetReplyId = clean(first(item?.target_id, entry?.target_id));
    const rawRootReplyId = clean(first(item?.root_id, entry?.root_id));
    // Bilibili uses root_id=0/target_id=0 for a top-level comment notification.
    // In that case source_id is the target comment rpid, so both root and parent
    // must resolve to source_id when constructing an exact reply target.
    const root = firstPositiveIntegerId(rawRootReplyId, targetReplyId, sourceReplyId);
    const parent = firstPositiveIntegerId(sourceReplyId, targetReplyId, root);
    const notificationId = clean(first(entry?.id, entry?.notification_id, entry?.reply_id));
    const stableEventId = notificationId || (oid && sourceReplyId ? `${oid}:${sourceReplyId}` : '');
    if (!content || !stableEventId) return null;
    const replyable = [oid, replyType, root, parent].every(value => /^[1-9]\d*$/.test(value));
    return {
      messageType: 'COMMENT',
      externalId: `bili-comment:${stableEventId}`,
      userName: clean(first(user?.nickname, user?.name, entry?.nickname, `B站用户${first(user?.mid, entry?.mid, '')}`)) || 'B站用户',
      content,
      externalUrl: clean(first(item?.uri, item?.native_uri, entry?.uri, 'https://message.bilibili.com/#/reply')),
      parentExternalId: oid || null,
      context: {
        source: 'bilibili-api:msgfeed-reply',
        notificationId: notificationId || null,
        oid: oid || null,
        // 统一回复资格检查使用的字段。B站接口返回的是 oid/rpid，
        // 不能只保留平台原始字段，否则服务端会误判为“缺少稳定帖子编号”。
        postId: oid || null,
        commentId: firstPositiveIntegerId(sourceReplyId, targetReplyId, parent, root) || null,
        replyType: replyType || null,
        root: root || null,
        parent: parent || null,
        sourceReplyId: sourceReplyId || null,
        targetReplyId: targetReplyId || null,
        subjectTitle: clean(first(item?.title, entry?.title)) || null,
        actorMid: clean(first(user?.mid, entry?.mid)) || null,
        actorPlatformId: clean(first(user?.mid, entry?.mid)) || null,
        accountPlatformId: ownUid || null,
        actorIsSelf: Boolean(ownUid && clean(first(user?.mid, entry?.mid)) === ownUid),
        direction: ownUid && clean(first(user?.mid, entry?.mid)) === ownUid ? 'OUTGOING' : 'INCOMING',
        eventTime: isoFromSeconds(first(entry?.reply_time, entry?.timestamp, item?.timestamp)),
        feedIndex: index,
        previewOnly: false,
        replyable,
        sourceVerified: replyable,
        precision: replyable ? 'EXACT_API_TARGET' : 'READ_ONLY_INCOMPLETE_TARGET'
      }
    };
  }).filter(Boolean);
}

function bilibiliPrivateMessageAfterWatermark(message = {}, previous = {}) {
  const msgSeqno = asNumber(first(message?.msg_seqno, message?.seqno));
  const previousSeqno = asNumber(previous?.seqno);
  if (msgSeqno !== null && previousSeqno !== null) return msgSeqno > previousSeqno;
  const msgKey = asNumber(first(message?.msg_key, message?.key));
  const previousMsgKey = asNumber(previous?.msgKey);
  if (msgKey !== null && previousMsgKey !== null) return msgKey > previousMsgKey;
  const timestamp = asNumber(message?.timestamp);
  const previousTimestamp = asNumber(previous?.timestamp);
  if (timestamp !== null && previousTimestamp !== null) return timestamp > previousTimestamp;
  // When the platform omits one of the comparable fields, keep the message and
  // let the server's stable externalId deduplication decide. Dropping it here
  // would be irreversible; accepting it is safe and idempotent.
  return true;
}

export function parseBilibiliPrivateFeed({ sessionsResponse, messageResponses = {}, selfUid = null, userCards = {}, previousSessionWatermarks = {} } = {}) {
  if (responseCode(sessionsResponse) !== 0) return [];
  const data = dataOf(sessionsResponse);
  const sessions = listOf(first(data.session_list, data.sessions, data.list));
  const ownUid = clean(selfUid);
  const collected = [];
  for (const session of sessions) {
    const unreadCount = Math.max(0, Number(first(session?.unread_count, session?.unread, 0)) || 0);
    const sessionType = Number(first(session?.session_type, 1));
    const talkerId = clean(first(session?.talker_id, session?.receiver_id, session?.uid));
    if (sessionType !== 1 || !/^[1-9]\d*$/.test(talkerId)) continue;
    const response = mapMessageResponses(messageResponses, talkerId);
    if (responseCode(response) !== 0) continue;
    const messageData = dataOf(response);
    const messages = listOf(first(messageData.messages, messageData.msg_list, messageData.list));
    const previous = previousSessionWatermarks?.[talkerId] && typeof previousSessionWatermarks[talkerId] === 'object'
      ? previousSessionWatermarks[talkerId]
      : {};
    const hasSystemWatermark = [previous.seqno, previous.msgKey, previous.timestamp].some(value => Number(value) > 0);
    const candidates = messages.filter(message => {
      const senderUid = clean(first(message?.sender_uid, message?.sender_id));
      const receiverId = clean(first(message?.receiver_id, message?.receiver_uid));
      const msgType = Number(first(message?.msg_type, message?.type));
      const msgKey = clean(first(message?.msg_key, message?.key));
      if (msgType !== 1 || !parseTextContent(message?.content)) return false;
      if (senderUid !== talkerId || !/^[1-9]\d*$/.test(msgKey)) return false;
      if (ownUid && receiverId && receiverId !== ownUid) return false;
      if (ownUid && senderUid === ownUid) return false;
      return !hasSystemWatermark || bilibiliPrivateMessageAfterWatermark(message, previous);
    });
    const selected = hasSystemWatermark
      ? candidates.sort((a, b) => Number(first(a?.msg_seqno, a?.timestamp, 0)) - Number(first(b?.msg_seqno, b?.timestamp, 0)))
      : candidates.sort((a, b) => Number(first(b?.timestamp, b?.msg_seqno, 0)) - Number(first(a?.timestamp, a?.msg_seqno, 0))).slice(0, unreadCount).reverse();
    const accountInfo = session?.account_info || session?.talker_info || {};
    const card = userCards?.[talkerId] || userCards?.[Number(talkerId)] || {};
    const userName = clean(first(accountInfo?.name, accountInfo?.uname, card?.name, card?.uname, session?.talker_name, `B站用户${talkerId}`));
    for (const message of selected) {
      const msgKey = clean(first(message?.msg_key, message?.key));
      const msgSeqno = clean(first(message?.msg_seqno, message?.seqno));
      collected.push({
        messageType: 'PRIVATE_MESSAGE',
        externalId: `bili-private:${msgKey}`,
        userName,
        content: parseTextContent(message?.content),
        externalUrl: 'https://message.bilibili.com/#/whisper',
        parentExternalId: talkerId,
        context: {
          source: 'bilibili-api:session-sync',
          talkerId,
          conversationId: talkerId,
          conversationKey: talkerId,
          senderUid: clean(first(message?.sender_uid, message?.sender_id)) || talkerId,
          receiverId: clean(first(message?.receiver_id, message?.receiver_uid)) || ownUid || null,
          direction: 'INCOMING',
          sessionType,
          unreadCount,
          msgKey,
          msgSeqno: msgSeqno || null,
          messageId: msgKey || null,
          eventTime: isoFromSeconds(message?.timestamp),
          messageTimestamp: asNumber(message?.timestamp),
          previewOnly: false,
          fullSource: true,
          sourceVerified: true,
          chatTitleVerified: true,
          replyable: true,
          precision: 'EXACT_API_SESSION_MESSAGE',
          collectedBySystemWatermark: hasSystemWatermark
        }
      });
    }
  }
  return collected;
}

export function buildBilibiliCommentReplyForm(payload, csrf) {
  const context = payload?.messageContext || payload?.context || {};
  const oid = positiveIntegerId(first(context.oid, payload?.oid, payload?.parentExternalId), 'oid');
  const type = positiveIntegerId(first(context.replyType, context.type, payload?.replyType), 'type');
  const root = positiveIntegerId(firstPositiveIntegerId(context.root, context.sourceReplyId, context.targetReplyId), 'root');
  const parent = positiveIntegerId(firstPositiveIntegerId(context.parent, context.sourceReplyId, context.targetReplyId, root), 'parent');
  const message = cleanMultiline(payload?.replyText).normalize('NFC');
  const token = clean(csrf);
  if (!message) throw new Error('B站评论回复内容为空，已停止发送');
  const lengthCheck = validateReplyTextLength({ platformCode: 'bilibili', messageType: 'COMMENT', text: message });
  if (!lengthCheck.ok) throw new Error(lengthCheck.message);
  if (!token) throw new Error('B站评论回复缺少 csrf，已停止发送');
  return { oid, type, message, root, parent, plat: '1', csrf: token, csrf_token: token };
}

export function buildBilibiliPrivateReplyForm(payload, csrf, selfUid, nowSeconds = Math.floor(Date.now() / 1000), deviceId = randomUUID()) {
  const context = payload?.messageContext || payload?.context || {};
  const receiverId = positiveIntegerId(first(context.talkerId, payload?.talkerId, payload?.parentExternalId), 'talkerId');
  const senderUid = positiveIntegerId(selfUid, 'selfUid');
  const message = cleanMultiline(payload?.replyText).normalize('NFC');
  const token = clean(csrf);
  if (!message) throw new Error('B站私信回复内容为空，已停止发送');
  const lengthCheck = validateReplyTextLength({ platformCode: 'bilibili', messageType: 'PRIVATE_MESSAGE', text: message });
  if (!lengthCheck.ok) throw new Error(lengthCheck.message);
  if (!token) throw new Error('B站私信回复缺少 csrf，已停止发送');
  return {
    'msg[sender_uid]': senderUid,
    'msg[receiver_id]': receiverId,
    'msg[receiver_type]': '1',
    'msg[msg_type]': '1',
    'msg[msg_status]': '0',
    'msg[content]': JSON.stringify({ content: message }),
    'msg[timestamp]': String(Math.floor(Number(nowSeconds))),
    'msg[new_face_version]': '0',
    'msg[dev_id]': clean(deviceId),
    csrf: token,
    csrf_token: token,
    build: '0',
    mobi_app: 'web'
  };
}

async function firstVisibleByText(page, labels) {
  for (const label of labels) {
    const locator = page.getByText(label, { exact: true });
    const count = Math.min(await locator.count().catch(() => 0), 20);
    for (let index = 0; index < count; index += 1) {
      const item = locator.nth(index);
      if (await item.isVisible().catch(() => false)) return item;
    }
  }
  return null;
}

export function detectBilibiliPendingDraft(text) {
  const value = clean(text);
  const countMatch = value.match(/(?:存在|有)\s*(\d+)\s*个未提交的(?:视频|稿件)/);
  const blocked = /未提交的(?:视频|稿件)/.test(value) && /继续编辑/.test(value) && /不用了|放弃|丢弃/.test(value);
  return { blocked, count: countMatch ? Number(countMatch[1]) : null };
}


const BILIBILI_DRAFT_STATE_VERSION = 2;
const BILIBILI_DRAFT_OWNER = 'codex-bilibili-agent';
const RESUMABLE_DRAFT_STATES = new Set(['DRAFT_READY']);
const TERMINAL_DRAFT_STATES = new Set(['SUBMITTING', 'SUBMIT_ATTEMPTED', 'SUBMITTED']);

function normalizedDraftState(value) {
  return clean(value).toUpperCase() || 'UNKNOWN';
}

function draftMaterialSha(payload = {}) {
  return clean(payload.materialSha256 || payload.draftFingerprint?.materialSha256).toLowerCase();
}

function draftMaterialName(payload = {}) {
  const value = clean(payload.materialPath || payload.expectedMaterial || payload.materialName || payload.draftFingerprint?.materialName);
  return value ? path.basename(value) : '';
}

function draftDuration(payload = {}) {
  const value = first(payload.materialMeta?.durationSeconds, payload.draftFingerprint?.durationSeconds, payload.durationSeconds);
  const duration = Number(value);
  return Number.isFinite(duration) && duration >= 0 ? duration : null;
}

function payloadFromDraftState(state = {}) {
  return {
    taskId: state.taskId || state.fingerprint?.taskId,
    targetId: state.targetId || state.fingerprint?.targetId,
    accountId: state.accountId || state.fingerprint?.accountId,
    profileName: state.profileName,
    title: state.title || state.fingerprint?.title,
    materialPath: state.materialPath || state.materialName || state.fingerprint?.materialName,
    materialSha256: state.materialSha256 || state.fingerprint?.materialSha256,
    durationSeconds: first(state.durationSeconds, state.fingerprint?.durationSeconds),
    draftFingerprint: state.fingerprint
  };
}

function draftContentFingerprint(payload = {}) {
  const value = {
    platformCode: 'bilibili',
    accountId: Number(payload.accountId || payload.draftFingerprint?.accountId) || null,
    materialSha256: draftMaterialSha(payload),
    durationSeconds: draftDuration(payload)
  };
  if (!value.materialSha256) return null;
  return { ...value, contentFingerprintHash: createHash('sha256').update(JSON.stringify(value)).digest('hex') };
}

export function isManagedBilibiliDraftState(state) {
  if (!state || typeof state !== 'object') return false;
  const fingerprint = state.fingerprint && typeof state.fingerprint === 'object' ? state.fingerprint : {};
  if (state.owner === BILIBILI_DRAFT_OWNER && Number(state.version) >= 2) {
    return clean(state.platformCode || fingerprint.platformCode).toLowerCase() === 'bilibili'
      && Boolean(fingerprint.fingerprintHash);
  }
  // Version 1 files were only written by this adapter. Treat them as managed only
  // when they contain the complete legacy identity; sparse/hand-made files remain protected.
  return !state.owner
    && clean(fingerprint.platformCode).toLowerCase() === 'bilibili'
    && Boolean(fingerprint.fingerprintHash && fingerprint.materialSha256 && fingerprint.title)
    && Number(fingerprint.taskId || state.taskId) > 0
    && Number(fingerprint.targetId || state.targetId) > 0;
}

export function bilibiliDraftContentMatches(payload = {}, state = null) {
  if (!state || typeof state !== 'object') return false;
  const expected = draftContentFingerprint(payload);
  // Recompute from the stored fields instead of trusting a cached hash. This keeps
  // malformed or partially edited state files from bypassing account/content checks.
  const actual = draftContentFingerprint({
    accountId: first(state.accountId, state.contentFingerprint?.accountId, state.fingerprint?.accountId),
    materialSha256: first(state.materialSha256, state.contentFingerprint?.materialSha256, state.fingerprint?.materialSha256),
    durationSeconds: first(state.durationSeconds, state.contentFingerprint?.durationSeconds, state.fingerprint?.durationSeconds)
  });
  if (!expected?.contentFingerprintHash || !actual?.contentFingerprintHash) return false;
  if (expected.contentFingerprintHash === actual.contentFingerprintHash) return true;
  // Duration metadata may be absent in legacy state. SHA-256 + account is still a
  // stable content identity; never fall back to title or filename alone.
  return expected.materialSha256 === actual.materialSha256
    && (!expected.accountId || (Boolean(actual.accountId) && expected.accountId === actual.accountId))
    && (expected.durationSeconds === null || actual.durationSeconds === null || Math.abs(expected.durationSeconds - actual.durationSeconds) <= 1);
}

export function canSafelyDiscardBilibiliManagedDraft(state) {
  if (!isManagedBilibiliDraftState(state)) return false;
  if (normalizedDraftState(state.state) !== 'DRAFT_READY') return false;
  return !state.submitAttemptedAt && !state.submitAuthorization && state.submitAttempted !== true;
}

export class BilibiliAssistedRpaAdapter extends AssistedPlatformRpaAdapter {
  constructor(options) {
    super({
      ...options,
      platformCode: 'bilibili',
      spec: {
        ...(options?.spec || {}),
        verificationPolicyId: 'bilibili-publish-status-v1',
        verifyPageUrlPattern: /^https:\/\/member\.bilibili\.com\/platform\/upload-manager/i,
        authenticatedUrlPattern: /(?:member|message)\.bilibili\.com\//i,
        authenticatedTextPattern: /创作中心|稿件管理|投稿管理|消息中心|我的消息|回复我的/i,
        loginTextPattern: /扫码登录|短信登录|密码登录|请先登录/i,
        titleMaxLength: 80,
        contentDeclarationRequired: true,
        // Bilibili wrapper buttons emit unreliable filechooser events.
        // Target the real video input directly and avoid the .txt subtitle input.
        fileSelectors: [
          '.bcc-upload-wrapper input[type="file"][accept*=".mp4"]',
          '.bcc-upload-wrapper input[type="file"][accept*=".mov"]'
        ],
        fileChooserLabels: [],
        fileChooserSelectors: [],
        // The page also creates preload/subtitle file inputs. Never fall back to
        // a generic input for Bilibili; only the primary upload wrapper is valid.
        allowGenericFileInputFallback: false,
        // A populated input.files value is not enough: Bilibili has occasionally
        // stayed on the initial uploader without dispatching the actual upload.
        retryInitialFileInputOnce: true,
        uploadEvidenceTimeoutMs: 15000,
        metadataFieldTimeoutMs: 30000,
        titleSelectors: ['input[placeholder*="\u7a3f\u4ef6\u6807\u9898"]', 'input[placeholder*="\u6807\u9898"]', 'textarea[placeholder*="\u6807\u9898"]'],
        captionSelectors: ['textarea[placeholder*="\u7b80\u4ecb"]', '[contenteditable="true"].ql-editor', '[contenteditable="true"]'],
        verifyRecordTimeoutMs: 6000,
        publishLabels: ['\u7acb\u5373\u6295\u7a3f'],
        publishSuccessUrlPattern: /\/platform\/upload-manager(?:\/[^?#]*)?(?:[?#]|$)/i,
        successPattern: /\u7a3f\u4ef6\u6295\u9012\u6210\u529f|\u6295\u7a3f\u6210\u529f|\u53d1\u5e03\u6210\u529f|\u7a3f\u4ef6\u5df2\u63d0\u4ea4|\u63d0\u4ea4\u6210\u529f/i,
        publishBlockedTextPattern: /\u7ed1\u5b9a\u624b\u673a\u53f7|\u5b89\u5168\u9a8c\u8bc1|\u626b\u7801\u9a8c\u8bc1|\u4eba\u8138\u9a8c\u8bc1|\u9a8c\u8bc1\u7801|\u73af\u5883\u5f02\u5e38|\u64cd\u4f5c\u9891\u7e41/i,
        verifyTabs: [
          { label: '\u5df2\u901a\u8fc7', labels: [/^\u5df2\u901a\u8fc7(?:\s*\d+)?$/], reviewStatus: 'PUBLISHED' },
          { label: '\u8fdb\u884c\u4e2d', labels: [/^\u8fdb\u884c\u4e2d(?:\s*\d+)?$/], reviewStatus: 'REVIEWING' },
          { label: '\u672a\u901a\u8fc7', labels: [/^\u672a\u901a\u8fc7(?:\s*\d+)?$/], reviewStatus: 'REJECTED' }
        ],
        commentPageUrlPattern: /message\.bilibili\.com\/#\/reply/i,
        privateMessagePageUrlPattern: /message\.bilibili\.com\/#\/whisper/i,
        commentPageTextPattern: /回复我的|消息中心/i,
        privateMessagePageTextPattern: /我的消息|消息中心/i,
        messageCardSelectorsByType: {
          COMMENT: ['[class*="reply-item"]', '[class*="replyItem"]'],
          PRIVATE_MESSAGE: ['[class*="_SessionItem_"][data-id]']
        }
      }
    });
  }

  async runtimeCheckpoint(generation = this.lifecycleGeneration) {
    await this.assertRuntimeAllowed();
    if (generation !== this.lifecycleGeneration) throw this.platformStoppedError();
    return generation;
  }

  async findFinalPublishControl(page) {
    const scopes = typeof page.frames === 'function' ? page.frames() : [page];
    const labels = this.spec.publishLabels || ['\u7acb\u5373\u6295\u7a3f'];
    const roleMatches = [];
    for (const scope of scopes) {
      if (typeof scope.getByRole !== 'function') continue;
      for (const label of labels) {
        const locator = scope.getByRole('button', { name: label, exact: true });
        const count = Math.min(await locator.count().catch(() => 0), 10);
        for (let index = 0; index < count; index += 1) {
          const item = locator.nth(index);
          if (!await item.isVisible().catch(() => false)) continue;
          if (!await item.isEnabled().catch(() => false)) continue;
          roleMatches.push({ label, locator: item, method: 'role-button' });
        }
      }
    }
    if (roleMatches.length === 1) return { status: 'UNIQUE', ...roleMatches[0] };
    if (roleMatches.length > 1) return { status: 'AMBIGUOUS', count: roleMatches.length, method: 'role-button' };

    // Bilibili's current uploader renders the final action as exact text inside a
    // non-native clickable control. Use a conservative exact-text fallback and
    // still require exactly one visible, enabled target before clicking.
    const textMatches = [];
    for (const scope of scopes) {
      if (typeof scope.getByText !== 'function') continue;
      for (const label of labels) {
        const locator = scope.getByText(label, { exact: true });
        const count = Math.min(await locator.count().catch(() => 0), 20);
        for (let index = 0; index < count; index += 1) {
          const textNode = locator.nth(index);
          if (!await textNode.isVisible().catch(() => false)) continue;
          const ancestor = textNode.locator('xpath=ancestor-or-self::*[self::button or self::a or @role="button"][1]');
          const target = await ancestor.count().catch(() => 0) ? ancestor.first() : textNode;
          if (!await target.isVisible().catch(() => false)) continue;
          if (!await target.isEnabled().catch(() => false)) continue;
          textMatches.push({ label, locator: target, method: 'exact-text' });
        }
      }
    }
    if (textMatches.length === 1) return { status: 'UNIQUE', ...textMatches[0] };
    return { status: textMatches.length ? 'AMBIGUOUS' : 'MISSING', count: textMatches.length, method: 'exact-text' };
  }

  async inspectLoginState(page) {
    const url = page.url();
    let hostname = '';
    try { hostname = new URL(url).hostname.toLowerCase(); } catch {}
    if (hostname === 'message.bilibili.com') {
      const cookies = await page.context().cookies(['https://bilibili.com', 'https://message.bilibili.com']).catch(() => []);
      const names = new Set(cookies.map(cookie => cookie.name));
      const text = clean(await page.locator('body').innerText({ timeout: 8000 }).catch(() => '')).slice(0, 20000);
      const explicitLoggedOut = /扫码登录|短信登录|密码登录|请先登录/.test(text)
        || await page.locator('input[placeholder*="手机号"],.login-scan-box').first().isVisible().catch(() => false);
      if (explicitLoggedOut) return { state: 'LOGIN', evidence: ['message-domain-login-control'] };
      if (names.has('DedeUserID') && names.has('bili_jct') && /消息中心|我的消息|回复我的/.test(text)) {
        return { state: 'READY', evidence: ['message-domain-auth-cookies', 'message-domain-auth-text'] };
      }
      return { state: 'UNKNOWN', evidence: names.has('DedeUserID') ? ['message-domain-user-cookie-only'] : ['message-domain-no-auth-evidence'] };
    }
    return super.inspectLoginState(page);
  }

  async auth() {
    await this.runtimeCheckpoint();
    const context = await this.ensureContext();
    const cookies = await context.cookies(['https://www.bilibili.com', 'https://api.bilibili.com', 'https://message.bilibili.com']);
    const byName = new Map(cookies.map(cookie => [cookie.name, cookie.value]));
    const selfUid = clean(byName.get('DedeUserID'));
    const csrf = clean(byName.get('bili_jct'));
    if (!/^[1-9]\d*$/.test(selfUid) || !csrf) throw new Error('B站登录 Cookie 不完整，请重新登录后再试');
    return { context, selfUid, csrf };
  }

  async apiGet(url, operation) {
    await this.runtimeCheckpoint();
    const { context } = await this.auth();
    await this.runtimeCheckpoint();
    const response = await context.request.get(url, { headers: { Referer: 'https://message.bilibili.com/', Origin: 'https://message.bilibili.com' }, timeout: 30000 });
    if (!response.ok()) throw new Error(`${operation}失败（HTTP ${response.status()}）`);
    return requireApiSuccess(await response.json(), operation);
  }

  async apiPost(url, form, operation, referer = 'https://message.bilibili.com/') {
    await this.runtimeCheckpoint();
    const { context } = await this.auth();
    await this.runtimeCheckpoint();
    const response = await context.request.post(url, { form, headers: { Referer: referer, Origin: new URL(referer).origin }, timeout: 30000 });
    if (!response.ok()) throw new Error(`${operation}失败（HTTP ${response.status()}）`);
    return requireApiSuccess(await response.json(), operation);
  }

  async applyContentDeclaration(page, payload) {
    const origin = normalizeContentOrigin(payload?.contentOrigin);
    if (!origin) throw new Error('B站投稿缺少明确的内容来源，已禁止系统猜测');

    const optionLabels = origin === 'AI_GENERATED'
      ? ['含AI生成内容', '含有AI生成内容', 'AI生成内容', '由AI生成']
      : ['内容无需标注'];
    const expectedPattern = origin === 'AI_GENERATED' ? /AI/i : /无需标注/;
    const declarationSelector = 'input.bcc-select-input-inner, input[placeholder*="创作声明"], .bcc-select';

    let declarationFallbackTrigger = null;
    const readDeclarationState = async () => {
      const selected = [];
      const selectedLocator = page.locator('.bcc-option.selected');
      // Keep lightweight test doubles and older page wrappers compatible; real Playwright
      // locators always provide count(). Without it, defer to the trigger/option path.
      if (typeof selectedLocator.count !== 'function') { declarationFallbackTrigger = typeof selectedLocator.first === 'function' ? selectedLocator.first() : selectedLocator; return { selected: [], observed: [], supported: false }; }
      const controls = page.locator(declarationSelector);
      if (typeof controls.count !== 'function') return { selected: [], observed: [], supported: false };
      const selectedCount = Math.min(await selectedLocator.count().catch(() => 0), 20);
      for (let index = 0; index < selectedCount; index += 1) {
        const item = selectedLocator.nth(index);
        if (!await item.isVisible().catch(() => false)) continue;
        const text = clean(await item.innerText().catch(() => ''));
        if (text) selected.push(text);
      }

      const observed = [];
      const controlCount = Math.min(await controls.count().catch(() => 0), 10);
      for (let index = 0; index < controlCount; index += 1) {
        const item = controls.nth(index);
        if (!await item.isVisible().catch(() => false)) continue;
        const value = clean(await item.inputValue().catch(() => ''));
        const ownText = clean(await item.innerText().catch(() => ''));
        const wrapperText = clean(await item.locator('xpath=..').innerText().catch(() => ''));
        observed.push({ value, ownText, wrapperText });
      }
      return { selected, observed, supported: true };
    };

    const matchesExpected = state => {
      const text = [...(state?.selected || []), ...(state?.observed || []).flatMap(item => [item.value, item.ownText, item.wrapperText])]
        .filter(Boolean).join(' ');
      return expectedPattern.test(text) && (origin !== 'AI_GENERATED' || !/无需标注/.test(text));
    };

    // B站页面通常默认选中“内容无需标注”。先读真实选中状态，不能因为没有重新打开下拉框就误报失败。
    const initialState = await readDeclarationState();
    if (matchesExpected(initialState)) {
      const selectedLabel = initialState.selected[0] || initialState.observed.find(item => item.value || item.ownText || item.wrapperText)?.value || optionLabels[0];
      return {
        applied: true,
        verified: true,
        alreadySelected: true,
        contentOrigin: origin,
        selectedLabel,
        observedValue: selectedLabel,
        aiDeclarationApplied: origin === 'AI_GENERATED'
      };
    }

    const declarationTriggers = [
      declarationFallbackTrigger,
      page.locator('input.bcc-select-input-inner').first(),
      page.locator('input[placeholder*="创作声明"]').first(),
      page.locator('.bcc-select').first(),
      page.getByText('请选择符合您视频内容的创作声明', { exact: true }).first(),
      page.locator('[role="combobox"]').filter({ hasText: /创作声明/ }).first(),
      page.locator('[class*="select"]').filter({ hasText: /创作声明/ }).first()
    ];
    let selectedOption = null;
    let clickedTrigger = null;
    for (const trigger of declarationTriggers) {
      if (!trigger || !await trigger.isVisible().catch(() => false)) continue;
      clickedTrigger = trigger;
      await trigger.click({ force: true }).catch(() => {});
      await page.waitForTimeout(350);
      selectedOption = await firstVisibleByText(page, optionLabels);
      if (selectedOption) break;
    }
    if (!selectedOption) {
      const debugLocator = page.locator('input,button,[role="button"],[role="option"],[class*="select"],[class*="dropdown"]');
      const controls = typeof debugLocator.evaluateAll === 'function'
        ? await debugLocator.evaluateAll(elements => elements.slice(0, 200).map(element => ({
            tag: element.tagName,
            text: String(element.innerText || element.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 160),
            placeholder: element.getAttribute('placeholder') || '',
            role: element.getAttribute('role') || '',
            className: typeof element.className === 'string' ? element.className.slice(0, 180) : ''
          })).filter(item => item.text || item.placeholder)).catch(() => [])
        : [];
      const debugPath = path.join(this.logsDir, `bilibili-declaration-controls-${Date.now()}.json`);
      fs.writeFileSync(debugPath, JSON.stringify({ url: typeof page.url === 'function' ? page.url() : null, origin, initialState, controls }, null, 2), 'utf8');
      throw new Error(`未找到与内容来源匹配的B站创作声明，已停止在草稿页面；控件快照：${debugPath}`);
    }

    const selectedLabel = clean(await selectedOption.innerText().catch(() => optionLabels[0])) || optionLabels[0];
    await selectedOption.click({ force: true });
    await page.waitForTimeout(450);
    let finalState = await readDeclarationState();
    // Some embedded page wrappers do not expose locator.count(). In that case the
    // clicked input is still a useful, scoped readback and avoids a false failure.
    if (!matchesExpected(finalState) && finalState.supported === false && clickedTrigger) {
      const value = clean(await clickedTrigger.inputValue().catch(() => ''));
      const ownText = typeof clickedTrigger.innerText === 'function' ? clean(await clickedTrigger.innerText().catch(() => '')) : '';
      const wrapper = typeof clickedTrigger.locator === 'function' ? clickedTrigger.locator('xpath=..') : null;
      const wrapperText = wrapper && typeof wrapper.innerText === 'function' ? clean(await wrapper.innerText().catch(() => '')) : '';
      finalState = { ...finalState, observed: [{ value, ownText, wrapperText }] };
    }
    if (matchesExpected(finalState)) {
      const observedValue = finalState.selected[0] || finalState.observed.find(item => item.value || item.ownText || item.wrapperText)?.value || selectedLabel;
      return { applied: true, verified: true, alreadySelected: false, contentOrigin: origin, selectedLabel, observedValue, aiDeclarationApplied: origin === 'AI_GENERATED' };
    }
    throw new Error(`B站创作声明点击后未能回读到已选状态，已禁止投稿：${JSON.stringify(finalState)}`);
  }

  draftFingerprintStatePath() {
    return path.join(this.profileDir, '.codex-bilibili-draft-fingerprint.json');
  }

  readDraftFingerprintState() {
    try {
      const state = JSON.parse(fs.readFileSync(this.draftFingerprintStatePath(), 'utf8'));
      return state && typeof state === 'object' ? state : null;
    } catch { return null; }
  }

  writeDraftFingerprintState(payload = {}, state = 'DRAFT_READY', extra = {}) {
    const fingerprint = payload.draftFingerprint;
    if (!fingerprint?.fingerprintHash) return null;
    const previous = this.readDraftFingerprintState();
    const updatedAt = new Date().toISOString();
    const contentFingerprint = draftContentFingerprint(payload);
    const transition = {
      from: previous?.state || null,
      to: normalizedDraftState(state),
      at: updatedAt,
      taskId: Number(payload.taskId) || null,
      targetId: Number(payload.targetId) || null
    };
    const output = {
      version: BILIBILI_DRAFT_STATE_VERSION,
      owner: BILIBILI_DRAFT_OWNER,
      platformCode: 'bilibili',
      profileName: clean(payload.profileName) || previous?.profileName || path.basename(this.profileDir),
      state: normalizedDraftState(state),
      fingerprint,
      contentFingerprint,
      taskId: Number(payload.taskId) || null,
      targetId: Number(payload.targetId) || null,
      accountId: Number(payload.accountId || fingerprint.accountId) || null,
      title: clean(payload.title || payload.expectedTitle || fingerprint.title),
      materialPath: clean(payload.materialPath || payload.expectedMaterial),
      materialName: draftMaterialName(payload),
      materialSha256: draftMaterialSha(payload),
      durationSeconds: draftDuration(payload),
      createdAt: previous?.createdAt || updatedAt,
      updatedAt,
      history: [...(Array.isArray(previous?.history) ? previous.history : []), transition].slice(-20),
      ...extra
    };
    // Ownership and transactional identity cannot be overridden by caller extras.
    output.version = BILIBILI_DRAFT_STATE_VERSION;
    output.owner = BILIBILI_DRAFT_OWNER;
    output.platformCode = 'bilibili';
    output.state = normalizedDraftState(state);
    const targetPath = this.draftFingerprintStatePath();
    const tempPath = `${targetPath}.${process.pid}.tmp`;
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(tempPath, JSON.stringify(output, null, 2), 'utf8');
    fs.renameSync(tempPath, targetPath);
    return output;
  }

  draftFingerprintMatches(payload = {}, state = this.readDraftFingerprintState()) {
    const expected = payload.draftFingerprint?.fingerprintHash;
    const actual = state?.fingerprint?.fingerprintHash;
    return Boolean(expected && actual && expected === actual);
  }

  assessLocalDraft(payload = {}, state = this.readDraftFingerprintState()) {
    const exactFingerprint = this.draftFingerprintMatches(payload, state);
    const managed = isManagedBilibiliDraftState(state);
    const contentMatched = bilibiliDraftContentMatches(payload, state);
    const localState = normalizedDraftState(state?.state);
    return {
      managed,
      exactFingerprint,
      contentMatched,
      matchType: exactFingerprint ? 'EXACT_FINGERPRINT' : contentMatched ? 'CONTENT_FINGERPRINT' : 'NONE',
      state: localState,
      resumeAllowed: managed && RESUMABLE_DRAFT_STATES.has(localState) && (exactFingerprint || contentMatched),
      verifyOnly: TERMINAL_DRAFT_STATES.has(localState),
      safeDiscardCandidate: canSafelyDiscardBilibiliManagedDraft(state) && !exactFingerprint && !contentMatched
    };
  }

  async fillExistingDraftField(page, selectors = [], value = '') {
    if (!clean(value)) return false;
    for (const selector of selectors) {
      const locator = page.locator(selector);
      const count = Math.min(await locator.count().catch(() => 0), 10);
      for (let index = 0; index < count; index += 1) {
        const item = locator.nth(index);
        if (!await item.isVisible().catch(() => false) || !await item.isEnabled().catch(() => false)) continue;
        await item.fill(value);
        let actualValue = '';
        if (typeof item.inputValue === 'function') actualValue = await item.inputValue().catch(() => '');
        if (!actualValue && typeof item.evaluate === 'function') {
          actualValue = await item.evaluate(element => String('value' in element ? element.value : (element.innerText || element.textContent || ''))).catch(() => '');
        }
        if (cleanMultiline(actualValue) === cleanMultiline(value)) return true;
      }
    }
    return false;
  }

  async verifyManagedDraftPage(page, state) {
    const text = clean(await page.locator('body').innerText({ timeout: 10000 }).catch(() => ''));
    const title = clean(state?.title || state?.fingerprint?.title);
    const materialName = clean(state?.materialName || state?.fingerprint?.materialName || (state?.materialPath ? path.basename(state.materialPath) : ''));
    return {
      matched: Boolean(title && materialName && text.includes(title) && text.includes(materialName) && text.includes('\u4e0a\u4f20\u5b8c\u6210')),
      title,
      materialName,
      uploadComplete: text.includes('\u4e0a\u4f20\u5b8c\u6210')
    };
  }

  async discardVerifiedManagedDraft(page, pending, state, generation) {
    if (!pending?.continueEditingVisible || !pending?.discardVisible || !canSafelyDiscardBilibiliManagedDraft(state)) {
      return { discarded: false, reason: 'DISCARD_NOT_AUTHORIZED' };
    }
    const continueEditing = await firstVisibleByText(page, ['\u7ee7\u7eed\u7f16\u8f91']);
    if (!continueEditing) return { discarded: false, reason: 'CONTINUE_CONTROL_MISSING' };
    await continueEditing.click();
    await page.waitForTimeout(1600);
    await this.runtimeCheckpoint(generation);
    const verification = await this.verifyManagedDraftPage(page, state);
    if (!verification.matched) return { discarded: false, reason: 'ACTUAL_DRAFT_IDENTITY_MISMATCH', verification };

    await page.goto(this.spec.publishUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    if (this.spec.publishPageSettleMs) await page.waitForTimeout(this.spec.publishPageSettleMs);
    let refreshed = await this.inspectPendingDraft(page);
    for (let attempt = 0; attempt < 6 && (!refreshed.blocked || !refreshed.discardVisible); attempt += 1) {
      await page.waitForTimeout(400);
      refreshed = await this.inspectPendingDraft(page);
    }
    if (!refreshed.blocked || !refreshed.discardVisible) return { discarded: false, reason: 'DISCARD_CONTROL_MISSING_AFTER_VERIFICATION', verification };
    const discard = await firstVisibleByText(page, ['\u4e0d\u7528\u4e86', '\u653e\u5f03\u8349\u7a3f', '\u4e22\u5f03\u8349\u7a3f']);
    if (!discard) return { discarded: false, reason: 'DISCARD_CONTROL_MISSING_AFTER_VERIFICATION', verification };
    await this.runtimeCheckpoint(generation);
    await discard.click();
    await page.waitForTimeout(1000);
    const after = await this.inspectPendingDraft(page);
    if (after.blocked) return { discarded: false, reason: 'DISCARD_NOT_CONFIRMED', verification, after };
    const discardedState = this.writeDraftFingerprintState({
      ...payloadFromDraftState(state),
      draftFingerprint: state.fingerprint
    }, 'DISCARDED', { discardedAt: new Date().toISOString(), discardReason: 'REPLACED_BY_DIFFERENT_MANAGED_TASK' });
    return { discarded: true, verification, discardedState };
  }

  async preflightManagementReconciliation(payload) {
    const verification = await super.verifyPublish({ ...payload, reconciliationMode: 'PRE_SUBMIT' });
    const result = verification?.result || {};
    if (result.stage !== 'verify') {
      return { checked: false, blocked: true, verification, reason: 'MANAGEMENT_PAGE_NOT_READY' };
    }
    const matchedRecord = result.matchedRecord || null;
    if (!matchedRecord) return { checked: true, matched: false, verification };
    if (matchedRecord.ambiguous === true) {
      return { checked: true, matched: false, titleMatched: true, blocked: true, verification, reason: 'MULTIPLE_TITLE_MATCHES', managementMatch: { title: clean(payload.title), candidateCount: matchedRecord.candidateCount || null, signaledCandidateCount: matchedRecord.signaledCandidateCount || null } };
    }

    const assessment = assessBilibiliManagementRecord(payload, {
      reviewStatus: result.reviewStatus,
      text: matchedRecord.text,
      platformUrl: result.platformUrl,
      href: matchedRecord.href
    });
    return { ...assessment, verification };

  }

  async inspectPendingDraft(page) {
    const text = await page.locator('body').innerText({ timeout: 8000 }).catch(() => '');
    const pending = detectBilibiliPendingDraft(text);
    if (!pending.blocked) return { ...pending, continueEditingVisible: false, discardVisible: false, localDraftFingerprint: this.readDraftFingerprintState() };
    const continueEditing = await firstVisibleByText(page, ['继续编辑']);
    const discard = await firstVisibleByText(page, ['不用了', '放弃草稿', '丢弃草稿']);
    return {
      ...pending,
      continueEditingVisible: Boolean(continueEditing),
      discardVisible: Boolean(discard),
      localDraftFingerprint: this.readDraftFingerprintState()
    };
  }

  async inspectMainCoverState(page) {
    const coverContent = page.locator('.cover-content').first();
    if (!await coverContent.count().catch(() => 0)) {
      return { found: false, saved: false, emptyCount: null, addCoverVisible: false, imageCount: 0, backgroundCount: 0, coverList: null, text: '' };
    }
    return coverContent.evaluate(element => {
      const visible = node => {
        const style = window.getComputedStyle(node);
        const rect = node.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) !== 0 && rect.width > 0 && rect.height > 0;
      };
      const emptyCount = [...element.querySelectorAll('.cover-slot .cover-empty')].filter(visible).length;
      const addCoverVisible = [...element.querySelectorAll('.cover-slot .add-text')]
        .some(node => visible(node) && /\u6dfb\u52a0\u5c01\u9762/.test(String(node.textContent || '')));
      const images = [...element.querySelectorAll('.cover-slot img')].filter(node => visible(node) && !node.classList.contains('add-icon'));
      const backgroundCount = [...element.querySelectorAll('.cover-slot, .cover-slot *')].filter(node => {
        if (!visible(node)) return false;
        const value = window.getComputedStyle(node).backgroundImage || '';
        return value && value !== 'none' && /url\(/i.test(value);
      }).length;
      const coverList = element.getAttribute('cover-list');
      const text = String(element.innerText || element.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 500);
      const saved = emptyCount === 0 && !addCoverVisible && (images.length > 0 || backgroundCount > 0 || Boolean(coverList) || /\u66f4\u6362\u5c01\u9762|\u91cd\u65b0\u5236\u4f5c/.test(text));
      return { found: true, saved, emptyCount, addCoverVisible, imageCount: images.length, backgroundCount, coverList: coverList || null, text };
    }).catch(error => ({ found: true, saved: false, error: error.message }));
  }

  async waitForMainCoverSaved(page, generation, timeoutMs = 20000) {
    const deadline = Date.now() + timeoutMs;
    let state = await this.inspectMainCoverState(page);
    while (Date.now() < deadline && state.saved !== true) {
      await this.runtimeCheckpoint(generation);
      await page.waitForTimeout(500);
      state = await this.inspectMainCoverState(page);
    }
    return state;
  }

  async resolveBilibiliCoverPath(payload = {}, materialPath = '') {
    const supplied = clean(payload.coverPath);
    if (supplied) {
      const resolved = path.resolve(supplied);
      if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) return resolved;
    }
    const title = clean(payload.title || payload.expectedTitle || 'B\u7ad9\u89c6\u9891\u6295\u7a3f').slice(0, 28);
    const identity = createHash('sha256').update(`${title}|${clean(materialPath)}`).digest('hex').slice(0, 16);
    const coverDir = path.join(this.logsDir, 'generated-covers');
    fs.mkdirSync(coverDir, { recursive: true });
    const generatedPath = path.join(coverDir, `bilibili-${identity}.png`);
    if (!fs.existsSync(generatedPath)) {
      const safeTitle = escapeXml(title);
      const svg = `<svg width="1280" height="720" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#111c44"/><stop offset="1" stop-color="#00a1d6"/></linearGradient></defs><rect width="1280" height="720" fill="url(#g)"/><circle cx="1080" cy="120" r="180" fill="#fb7299" opacity=".35"/><text x="640" y="330" text-anchor="middle" font-size="64" font-family="Microsoft YaHei,Arial" font-weight="700" fill="white">${safeTitle}</text><text x="640" y="425" text-anchor="middle" font-size="34" font-family="Microsoft YaHei,Arial" fill="#dff7ff">B\u7ad9\u89c6\u9891\u6295\u7a3f</text></svg>`;
      await sharp(Buffer.from(svg)).png().toFile(generatedPath);
    }
    return generatedPath;
  }

  async ensureBilibiliCover(page, payload = {}, materialPath = '', generation = this.lifecycleGeneration) {
    let coverState = await this.inspectMainCoverState(page);
    if (coverState.saved === true) return { coverState, coverPath: null, generated: false, alreadySaved: true };
    const coverPath = await this.resolveBilibiliCoverPath(payload, materialPath);
    const addCover = await firstVisibleByText(page, ['\u6dfb\u52a0\u5c01\u9762']);
    if (!addCover) throw new Error('B\u7ad9\u4e3b\u8868\u5355\u672a\u627e\u5230\u201c\u6dfb\u52a0\u5c01\u9762\u201d\u5165\u53e3');
    await addCover.click();
    await page.waitForTimeout(900);
    const coverDialogs = page.locator('.cover-editor.bcc-dialog__wrap, .cover-editor');
    let coverDialog = null;
    for (let index = 0; index < Math.min(await coverDialogs.count().catch(() => 0), 10); index += 1) {
      const candidate = coverDialogs.nth(index);
      if (await candidate.isVisible().catch(() => false)) { coverDialog = candidate; break; }
    }
    if (!coverDialog) throw new Error('\u672a\u68c0\u6d4b\u5230B\u7ad9\u5c01\u9762\u7f16\u8f91\u5f39\u7a97');
    const coverModal = coverDialog.locator('xpath=ancestor-or-self::*[contains(concat(" ", normalize-space(@class), " "), " bcc-dialog__wrap ")][1]').first();
    const imageInputs = () => coverDialog.locator('input[type="file"][accept*="image"]');
    let uploadedCoverCount = 0;
    if (await imageInputs().count().catch(() => 0)) {
      await imageInputs().first().setInputFiles(coverPath);
      uploadedCoverCount += 1;
      await page.waitForTimeout(1100);
    }
    const personalCanvas = coverDialog.locator('#editor_16_9').first();
    const personalLabel = coverDialog.getByText(/\u4e2a\u6027\u5c01\u9762.*16:9/).first();
    if (await personalCanvas.isVisible().catch(() => false)) await personalCanvas.click({ force: true }).catch(() => {});
    else if (await personalLabel.isVisible().catch(() => false)) await personalLabel.click({ force: true }).catch(() => {});
    await page.waitForTimeout(350);
    if (await imageInputs().count().catch(() => 0)) {
      await imageInputs().first().setInputFiles(coverPath);
      uploadedCoverCount += 1;
      await page.waitForTimeout(1300);
    }
    if (!uploadedCoverCount) throw new Error('B\u7ad9\u5c01\u9762\u7f16\u8f91\u5668\u672a\u627e\u5230\u56fe\u7247\u4e0a\u4f20\u5165\u53e3');
    const editorSubmit = coverDialog.locator('.cover-editor-button .submit').first();
    let editorSubmitState = null;
    const coverReadyDeadline = Date.now() + 60000;
    while (Date.now() < coverReadyDeadline) {
      await this.runtimeCheckpoint(generation);
      if (!await coverDialog.isVisible().catch(() => false)) break;
      if (await editorSubmit.isVisible().catch(() => false)) {
        editorSubmitState = await editorSubmit.evaluate(element => ({
          text: String(element.innerText || element.textContent || '').trim().replace(/\s+/g, ' '),
          className: typeof element.className === 'string' ? element.className : '',
          disabled: Boolean(element.disabled || element.getAttribute('aria-disabled') === 'true')
        })).catch(() => null);
        const processing = /\u5236\u4f5c\u4e2d/.test(editorSubmitState?.text || '');
        const disabled = editorSubmitState?.disabled === true || /(?:^|\s)submit-disabled(?:\s|$)/.test(editorSubmitState?.className || '');
        if (!processing && !disabled) break;
      }
      await page.waitForTimeout(500);
    }
    if (await coverDialog.isVisible().catch(() => false)) {
      const processing = /\u5236\u4f5c\u4e2d/.test(editorSubmitState?.text || '');
      const disabled = editorSubmitState?.disabled === true || /(?:^|\s)submit-disabled(?:\s|$)/.test(editorSubmitState?.className || '');
      if (!await editorSubmit.isVisible().catch(() => false) || processing || disabled) throw new Error(`\u7b49\u5f85B\u7ad9\u5c01\u9762\u5236\u4f5c\u5b8c\u6210\u8d85\u65f6\uff1a${JSON.stringify(editorSubmitState || {})}`);
      await editorSubmit.click();
      const outerConfirmDeadline = Date.now() + 15000;
      while (Date.now() < outerConfirmDeadline && await coverModal.isVisible().catch(() => false)) {
        await this.runtimeCheckpoint(generation);
        const buttons = coverModal.locator(':scope > .bcc-dialog > .bcc-dialog__footer button.bcc-button--primary');
        let clicked = false;
        for (let index = 0; index < Math.min(await buttons.count().catch(() => 0), 10); index += 1) {
          const candidate = buttons.nth(index);
          if (!await candidate.isVisible().catch(() => false) || !await candidate.isEnabled().catch(() => true)) continue;
          if (clean(await candidate.innerText().catch(() => '')) !== '\u786e\u5b9a') continue;
          await candidate.click(); clicked = true; break;
        }
        if (clicked) break;
        await page.waitForTimeout(250);
      }
      await coverModal.waitFor({ state: 'hidden', timeout: 15000 }).catch(() => {});
    }
    if (await coverModal.isVisible().catch(() => false)) throw new Error('B\u7ad9\u5c01\u9762\u7f16\u8f91\u5f39\u7a97\u672a\u5173\u95ed\uff0c\u5df2\u7981\u6b62\u6295\u7a3f');
    coverState = await this.waitForMainCoverSaved(page, generation, 20000);
    if (coverState.saved !== true) throw new Error(`\u5c01\u9762\u672a\u771f\u6b63\u4fdd\u5b58\u5230B\u7ad9\u4e3b\u8868\u5355\uff0c\u5df2\u7981\u6b62\u6295\u7a3f\uff1a${JSON.stringify(coverState)}`);
    return { coverState, coverPath, generated: !clean(payload.coverPath), alreadySaved: false, uploadedCoverCount };
  }

  async waitForPrimaryVideoUploadInput(page, generation = this.lifecycleGeneration, timeoutMs = 20000) {
    const selectors = this.spec.fileSelectors || [];
    const deadline = Date.now() + timeoutMs;
    let last = { count: 0, selector: null };
    while (Date.now() < deadline) {
      await this.runtimeCheckpoint(generation);
      const scopes = typeof page.frames === 'function' ? page.frames() : [page];
      for (const scope of scopes) {
        for (const selector of selectors) {
          const locator = scope.locator(selector);
          const count = await locator.count().catch(() => 0);
          last = { count, selector };
          for (let index = 0; index < count; index += 1) {
            const input = locator.nth(index);
            const ready = await input.evaluate(element => ({
              connected: element.isConnected,
              disabled: Boolean(element.disabled),
              accept: element.getAttribute('accept') || '',
              insidePrimaryWrapper: Boolean(element.closest('.bcc-upload-wrapper'))
            })).catch(() => null);
            if (ready?.connected && !ready.disabled && ready.insidePrimaryWrapper && /\.(?:mp4|mov)(?:,|$)/i.test(ready.accept)) {
              return { ready: true, selector, index, accept: ready.accept };
            }
          }
        }
      }
      await page.waitForTimeout(250);
    }
    throw new Error(`\u672a\u68c0\u6d4b\u5230B\u7ad9\u4e3b\u4e0a\u4f20\u533a\u7684\u89c6\u9891\u8f93\u5165\u6846\uff0c\u5df2\u7981\u6b62\u5c06\u7d20\u6750\u5199\u5165\u9884\u52a0\u8f7d\u6216\u5b57\u5e55\u8f93\u5165\u6846\uff1a${JSON.stringify(last)}`);
  }

  async prepareDraft(page, payload, materialPath) {
    const uploadInput = await this.waitForPrimaryVideoUploadInput(page, this.lifecycleGeneration, 20000);
    const prepared = await super.prepareDraft(page, payload, materialPath);
    const cover = await this.ensureBilibiliCover(page, payload, materialPath, this.lifecycleGeneration);
    const finalReadiness = await this.waitForUploadAndPublishReady(page, 30000, { allowDisabled: false });
    return { ...prepared, uploadInput, cover, readiness: finalReadiness };
  }

  async waitForSubmittedManagementRecord(payload, generation = this.lifecycleGeneration, timeoutMs = 60000) {
    const deadline = Date.now() + timeoutMs;
    let last = null;
    while (Date.now() < deadline) {
      await this.runtimeCheckpoint(generation);
      last = await this.preflightManagementReconciliation(payload);
      if (last?.matched) return { confirmed: true, ...last };
      const page = await this.getPage();
      await page.waitForTimeout(2500);
    }
    return { confirmed: false, ...(last || {}) };
  }

  async publish(payload) {
    const materialPath = path.resolve(clean(payload?.materialPath));
    const extension = path.extname(materialPath).toLowerCase();
    if (!['.mp4', '.mov'].includes(extension)) {
      return { status: 'FAILED', result: await this.evidence(payload, 'B站仅允许上传 MP4/MOV 视频素材，已在打开投稿页前阻断', null, 'material_blocked', { extension }) };
    }
    if (!fs.existsSync(materialPath) || !fs.statSync(materialPath).isFile()) {
      return { status: 'FAILED', result: await this.evidence(payload, '本地素材不存在，无法准备B站草稿', null, 'material_missing') };
    }
    const contentOrigin = normalizeContentOrigin(payload?.contentOrigin);
    if (!contentOrigin) {
      return { status: 'FAILED', result: await this.evidence(payload, 'B站投稿缺少明确的内容来源，已在上传前阻断', null, 'content_origin_missing', { uploadAttempted: false }) };
    }

    const generation = this.lifecycleGeneration;
    await this.runtimeCheckpoint(generation);
    if (payload.publishMode === 'AUTO' && payload.managementConfirmed === true) {
      const preflight = await this.preflightManagementReconciliation(payload);
      if (preflight.blocked) {
        return { status: 'NEEDS_CONFIRMATION', result: { ...(preflight.verification?.result || {}), message: `B\u7ad9\u7ba1\u7406\u9875\u67e5\u91cd\u65e0\u6cd5\u53ef\u9760\u786e\u8ba4\uff0c\u5df2\u5728\u6700\u7ec8\u6295\u7a3f\u524d\u963b\u65ad\uff08${preflight.reason || 'UNKNOWN'}\uff09`, stage: 'management_precheck_blocked', managementPrecheck: preflight, submitAttempted: false } };
      }
      if (preflight.matched) {
        const submittedDraftState = this.writeDraftFingerprintState(payload, 'SUBMITTED', { reconciledBeforeSubmit: true, submittedAt: preflight.submittedAt || new Date().toISOString(), platformPostId: preflight.platformPostId || null, platformUrl: preflight.platformUrl || null });
        return { status: 'SUCCESS', result: { ...(preflight.verification?.result || {}), message: 'B\u7ad9\u7ba1\u7406\u9875\u5df2\u627e\u5230\u4e0e\u672c\u4efb\u52a1\u4e00\u81f4\u7684\u6295\u7a3f\u8bb0\u5f55\uff0c\u672c\u6b21\u672a\u518d\u6b21\u6295\u7a3f', stage: 'management_precheck_reconciled', reviewStatus: preflight.reviewStatus, submissionStatus: 'SUBMITTED', platformPostId: preflight.platformPostId, platformUrl: preflight.platformUrl, submittedAt: preflight.submittedAt, managementMatch: preflight.managementMatch, match: preflight.match, reconciledBeforeSubmit: true, submitAttempted: false, submittedDraftState } };
      }
    }
    const page = await this.getPage();
    await page.goto(this.spec.publishUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    if (!await this.waitForReady(page)) {
      return { status: 'NEEDS_CONFIRMATION', result: await this.evidence(payload, '等待人工登录B站超时；浏览器页面已保留', page, 'login_required') };
    }
    if (this.spec.publishPageSettleMs) await page.waitForTimeout(this.spec.publishPageSettleMs);
    await this.runtimeCheckpoint(generation);

    const pendingDraft = await this.inspectPendingDraft(page);
    let managedDraftResolution = null;
    if (pendingDraft.blocked) {
      const draftAssessment = this.assessLocalDraft(payload, pendingDraft.localDraftFingerprint);
      if (draftAssessment.verifyOnly) {
        return {
          status: 'NEEDS_CONFIRMATION',
          result: await this.evidence(payload, '\u68c0\u6d4b\u5230B\u7ad9\u672c\u5730\u8349\u7a3f\u5df2\u8fdb\u5165\u6295\u7a3f\u5c1d\u8bd5\u9636\u6bb5\uff1b\u7981\u6b62\u5220\u9664\u6216\u91cd\u6295\uff0c\u8bf7\u5148\u901a\u8fc7\u7a3f\u4ef6\u7ba1\u7406\u9875\u6838\u9a8c', page, 'existing_draft_requires_verification', {
            ...pendingDraft, draftProtected: true, uploadAttempted: false, submitAttempted: true, verificationRequired: true,
            draftAssessment, expectedDraftFingerprint: payload.draftFingerprint || null
          })
        };
      }
      if (draftAssessment.resumeAllowed && payload.publishMode === 'AUTO' && payload.managementConfirmed === true) {
        return this.submitExistingDraft({
          ...payload,
          authorized: true,
          expectedTitle: clean(payload.title),
          expectedMaterial: path.basename(materialPath),
          autoResume: true
        });
      }
      if (draftAssessment.safeDiscardCandidate) {
        const discardResult = await this.discardVerifiedManagedDraft(page, pendingDraft, pendingDraft.localDraftFingerprint, generation);
        if (discardResult.discarded) managedDraftResolution = discardResult;
        else {
          return {
            status: 'NEEDS_CONFIRMATION',
            result: await this.evidence(payload, '\u68c0\u6d4b\u5230\u53e6\u4e00\u4e2a\u7cfb\u7edf\u8349\u7a3f\uff0c\u4f46\u65e0\u6cd5\u53ef\u9760\u786e\u8ba4\u9875\u9762\u8349\u7a3f\u8eab\u4efd\uff0c\u5df2\u4fdd\u7559\u8349\u7a3f\u5e76\u963b\u6b62\u4e0a\u4f20', page, 'existing_managed_draft_discard_blocked', {
              ...pendingDraft, draftProtected: true, uploadAttempted: false, submitAttempted: false,
              draftAssessment, discardResult, expectedDraftFingerprint: payload.draftFingerprint || null
            })
          };
        }
      } else {
        return {
          status: 'NEEDS_CONFIRMATION',
          result: await this.evidence(
            payload,
            draftAssessment.resumeAllowed
              ? '\u68c0\u6d4b\u5230\u4e0e\u5f53\u524d\u4efb\u52a1\u5339\u914d\u7684\u7cfb\u7edf\u8349\u7a3f\uff0c\u53ef\u7ee7\u7eed\u8349\u7a3f\uff1b\u5f53\u524d\u672a\u83b7\u5f97\u81ea\u52a8\u7eed\u63a5\u786e\u8ba4'
              : '\u68c0\u6d4b\u5230B\u7ad9\u672a\u63d0\u4ea4\u8349\u7a3f\uff0c\u4f46\u65e0\u6cd5\u786e\u8ba4\u5c5e\u4e8e\u5f53\u524d\u7cfb\u7edf\u4efb\u52a1\uff0c\u5df2\u4fdd\u7559\u8349\u7a3f\u5e76\u963b\u6b62\u4e0a\u4f20',
            page,
            'existing_draft_blocked',
            {
              ...pendingDraft,
              draftProtected: true,
              uploadAttempted: false,
              submitAttempted: false,
              draftAssessment,
              draftResumeAvailable: draftAssessment.resumeAllowed,
              draftFingerprintMatched: draftAssessment.exactFingerprint,
              draftContentMatched: draftAssessment.contentMatched,
              expectedDraftFingerprint: payload.draftFingerprint || null
            }
          )
        };
      }
    }

    let uploadEvidenceConfirmed = false;
    let submitAttempted = false;
    try {
      await this.runtimeCheckpoint(generation);
      const prepared = await this.prepareDraft(page, { ...payload, contentOrigin }, materialPath);
      uploadEvidenceConfirmed = prepared?.materialAttachment?.attached === true;
      const draftReadyEvidence = uploadEvidenceConfirmed === true && prepared?.readiness?.ready === true;
      const draftFingerprintState = draftReadyEvidence
        ? this.writeDraftFingerprintState(payload, 'DRAFT_READY', { preparedAt: new Date().toISOString(), managedDraftResolution })
        : null;
      await this.runtimeCheckpoint(generation);
      const draftEvidence = await this.evidence(payload, 'B站草稿已准备完成', page, 'draft_ready', { ...prepared, uploadAttempted: uploadEvidenceConfirmed, draftReadyEvidence, draftFingerprintState });
      if (payload.publishMode !== 'AUTO') {
        return { status: 'NEEDS_CONFIRMATION', result: { ...draftEvidence, message: 'B站草稿已准备，等待人工检查并提交', finalActionAuthorized: false } };
      }
      if (payload.managementConfirmed !== true) {
        return { status: 'NEEDS_CONFIRMATION', result: { ...draftEvidence, message: 'B站草稿已准备，但缺少本次最终投稿确认，未点击投稿', finalActionAuthorized: false } };
      }

      const submit = await this.findFinalPublishControl(page);
      if (submit.status !== 'UNIQUE') {
        return { status: 'NEEDS_CONFIRMATION', result: { ...draftEvidence, message: submit.status === 'AMBIGUOUS' ? 'B站最终投稿按钮不唯一，已禁止点击' : '未找到唯一可用的B站最终投稿按钮，请人工核对页面', publishControl: { status: submit.status, count: submit.count || 0 } } };
      }
      await this.runtimeCheckpoint(generation);
      const submitAuthorization = await this.authorizeFinalSubmit(payload, { reason: 'BILIBILI_FINAL_PUBLISH_CLICK', source: 'PUBLISH_JOB' });
      submitAttempted = true;
      this.writeDraftFingerprintState(payload, 'SUBMITTING', { submitAuthorization, submitAttemptedAt: new Date().toISOString() });
      await submit.locator.click();
      this.writeDraftFingerprintState(payload, 'SUBMIT_ATTEMPTED', { submitAuthorization, submitAttemptedAt: new Date().toISOString() });
      const signal = await this.waitForPublishSignal(page);
      const managementVerification = await this.waitForSubmittedManagementRecord(
        { ...payload, title: clean(payload.title) },
        generation
      );
      const evidencePage = await this.getPage();
      if (managementVerification.confirmed === true) {
        const submittedDraftState = this.writeDraftFingerprintState(payload, 'SUBMITTED', {
          submitAuthorization,
          submittedAt: managementVerification.submittedAt || new Date().toISOString(),
          publishSignal: signal?.source || null,
          platformPostId: managementVerification.platformPostId || null,
          platformUrl: managementVerification.platformUrl || null
        });
        return { status: 'SUCCESS', result: await this.evidence(payload, '\u0042\u7ad9\u5df2\u70b9\u51fb\u7acb\u5373\u6295\u7a3f\uff0c\u5e76\u5df2\u5728\u7a3f\u4ef6\u7ba1\u7406\u9875\u627e\u5230\u5bf9\u5e94\u7a3f\u4ef6', evidencePage, 'published', { publishSignal: signal?.source || null, submissionStatus: 'SUBMITTED', reviewStatus: managementVerification.reviewStatus || 'REVIEWING', platformPostId: managementVerification.platformPostId || null, platformUrl: managementVerification.platformUrl || null, managementVerification, finalActionAuthorized: true, submitAttempted: true, submitAuthorization, submittedDraftState }) };
      }
      return { status: 'NEEDS_CONFIRMATION', result: await this.evidence(payload, '\u5df2\u70b9\u51fbB\u7ad9\u7acb\u5373\u6295\u7a3f\uff0c\u4f46\u7a3f\u4ef6\u7ba1\u7406\u9875\u5c1a\u672a\u627e\u5230\u5bf9\u5e94\u7a3f\u4ef6\uff1b\u6295\u7a3f\u9501\u4fdd\u6301\uff0c\u7981\u6b62\u81ea\u52a8\u91cd\u8bd5', evidencePage, 'publish_unconfirmed', { publishSignal: signal?.source || null, submissionStatus: 'UNKNOWN', managementVerification, finalActionAuthorized: true, submitAttempted: true, submitAuthorization }) };
    } catch (error) {
      if (isPlatformStopError(error) && !uploadEvidenceConfirmed) throw error;
      if (submitAttempted) {
        return { status: 'NEEDS_CONFIRMATION', result: await this.evidence(payload, `B站投稿请求结果不确定：${error.message}；为防止重复发布，请人工核对`, page, 'publish_unconfirmed', { submissionStatus: 'UNKNOWN', submitAttempted: true, interruptedByPlatformStop: isPlatformStopError(error) }) };
      }
      if (error.code === 'MATERIAL_UPLOAD_NOT_STARTED' && error.uploadDefinitelyNotStarted === true) {
        const noDraftFingerprintState = this.writeDraftFingerprintState(payload, 'UPLOAD_NOT_STARTED', {
          uploadNotStartedAt: new Date().toISOString(),
          noDraftConfirmed: true,
          attachAttempts: Number(error.materialAttachment?.attachAttempts || 0) || null
        });
        return {
          status: 'FAILED',
          result: await this.evidence(payload, 'B站文件选择动作已执行两次，但页面始终停留在初始上传区域；确认没有生成草稿或启动上传，可安全重新发送', page, 'upload_not_started', {
            submitAttempted: false,
            submissionStatus: 'NOT_SUBMITTED',
            publishAttemptState: 'UPLOAD_NOT_STARTED',
            reviewStatus: 'UNKNOWN',
            uploadAttempted: true,
            uploadMayHaveStarted: false,
            uploadDefinitelyNotStarted: true,
            retrySafe: true,
            safeToRetry: true,
            manualActionRequired: false,
            draftSaved: false,
            draftPreservedInBrowser: false,
            draftExists: false,
            errorCode: error.code,
            failedStage: error.draftPrepareStage || null,
            materialAttachment: error.materialAttachment || null,
            noDraftFingerprintState
          })
        };
      }
      if (error.code === 'PLATFORM_UPLOAD_FAILED') {
        return {
          status: 'FAILED',
          result: await this.evidence(payload, `B站视频尚未提交平台：上传过程中出现网络异常${error.platformMessage ? `（${error.platformMessage}）` : ''}，当前未创建草稿，请检查网络后重新发送`, page, 'upload_failed', {
            submitAttempted: false,
            submissionStatus: 'NOT_SUBMITTED',
            publishAttemptState: 'UPLOAD_FAILED',
            reviewStatus: 'UNKNOWN',
            uploadAttempted: uploadEvidenceConfirmed,
            uploadMayHaveStarted: uploadEvidenceConfirmed,
            uploadFailed: true,
            platformState: 'UPLOAD_FAILED',
            errorCode: error.code,
            failedStage: error.draftPrepareStage || null,
            platformMessage: error.platformMessage || null,
            retrySafe: true,
            safeToRetry: true,
            manualActionRequired: false,
            draftSaved: false,
            draftPreservedInBrowser: false,
            draftExists: false
          })
        };
      }
      // A hard file-injection timeout is intentionally treated as uncertain:
      // Playwright/CDP may have handed the file to Chromium just before the
      // acknowledgement stalled. Preserve the page and block blind retries.
      const fileInjectionOutcomeUnknown = error.code === 'MATERIAL_FILE_INJECTION_TIMEOUT';
      const uploadMayHaveStarted = uploadEvidenceConfirmed === true || error.materialAttachment?.attached === true || fileInjectionOutcomeUnknown;
      const draftFingerprintState = uploadMayHaveStarted
        ? this.writeDraftFingerprintState(payload, 'DRAFT_PREPARE_UNCONFIRMED', { prepareError: error.message, prepareFailedAt: new Date().toISOString() })
        : null;
      return {
        status: 'NEEDS_CONFIRMATION',
        result: await this.evidence(payload, `B站尚未完成草稿创建，未执行最终投稿：${error.message}`, page, 'draft_prepare_blocked', {
          submissionStatus: 'NOT_SUBMITTED',
          publishAttemptState: 'DRAFT_PREPARE_BLOCKED',
          uploadAttempted: uploadMayHaveStarted,
          uploadMayHaveStarted,
          interruptedByPlatformStop: isPlatformStopError(error),
          errorCode: error.code || null,
          failedStage: error.draftPrepareStage || null,
          fileInjectionOutcomeUnknown,
          draftFingerprintState,
          draftSaved: false,
          draftPreservedInBrowser: false,
          draftExists: false,
          manualActionRequired: false,
          safeToRetry: !uploadMayHaveStarted
        })
      };
    }
  }

  async submitExistingDraft(payload = {}) {
    const expectedTitle = clean(payload.expectedTitle);
    const expectedMaterial = clean(payload.expectedMaterial);
    if (payload.authorized !== true || !expectedTitle || !expectedMaterial) {
      throw new Error('\u5fc5\u987b\u660e\u786e\u6388\u6743\u5e76\u63d0\u4f9b\u65e2\u6709\u8349\u7a3f\u7684\u6807\u9898\u4e0e\u7d20\u6750\u540d\u79f0');
    }
    if (!payload.draftFingerprint?.fingerprintHash) throw new Error('\u63d0\u4ea4\u65e2\u6709\u8349\u7a3f\u5fc5\u987b\u63d0\u4f9b\u6709\u6548\u7684\u8349\u7a3f\u6307\u7eb9');
    if (payload.prepareOnly !== true && (!Number.isInteger(Number(payload.targetId)) || Number(payload.targetId) <= 0)) throw new Error('\u6700\u7ec8\u63d0\u4ea4\u65e2\u6709\u8349\u7a3f\u5fc5\u987b\u63d0\u4f9b\u6709\u6548\u7684 targetId \u4ee5\u83b7\u53d6\u6295\u7a3f\u9501');
    const preflightPayload = { ...payload, title: expectedTitle };
    if (payload.prepareOnly !== true) {
      const preflight = await this.preflightManagementReconciliation(preflightPayload);
      if (preflight.blocked) return { status: 'NEEDS_CONFIRMATION', result: { ...(preflight.verification?.result || {}), message: `B\u7ad9\u7ba1\u7406\u9875\u67e5\u91cd\u65e0\u6cd5\u53ef\u9760\u786e\u8ba4\uff0c\u5df2\u5728\u6700\u7ec8\u6295\u7a3f\u524d\u963b\u65ad\uff08${preflight.reason || 'UNKNOWN'}\uff09`, stage: 'management_precheck_blocked', managementPrecheck: preflight, submitAttempted: false } };
      if (preflight.matched) {
        const submittedDraftState = this.writeDraftFingerprintState(payload, 'SUBMITTED', { reconciledBeforeSubmit: true, submittedAt: preflight.submittedAt || new Date().toISOString(), platformPostId: preflight.platformPostId || null, platformUrl: preflight.platformUrl || null });
        return { status: 'SUCCESS', result: { ...(preflight.verification?.result || {}), message: 'B\u7ad9\u7ba1\u7406\u9875\u5df2\u627e\u5230\u4e0e\u672c\u4efb\u52a1\u4e00\u81f4\u7684\u6295\u7a3f\u8bb0\u5f55\uff0c\u672c\u6b21\u672a\u518d\u6b21\u6295\u7a3f', stage: 'management_precheck_reconciled', reviewStatus: preflight.reviewStatus, submissionStatus: 'SUBMITTED', platformPostId: preflight.platformPostId, platformUrl: preflight.platformUrl, submittedAt: preflight.submittedAt, managementMatch: preflight.managementMatch, match: preflight.match, reconciledBeforeSubmit: true, submitAttempted: false, submittedDraftState } };
      }
    }
    const generation = this.lifecycleGeneration;
    await this.runtimeCheckpoint(generation);
    const page = await this.getPage();
    await page.goto(this.spec.publishUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    if (!await this.waitForReady(page)) throw new Error('\u7b49\u5f85\u4eba\u5de5\u767b\u5f55B\u7ad9\u8d85\u65f6');
    let pending = await this.inspectPendingDraft(page);
    for (let attempt = 0; attempt < 6 && (!pending.blocked || !pending.continueEditingVisible); attempt += 1) {
      await page.waitForTimeout(400);
      pending = await this.inspectPendingDraft(page);
    }
    if (!pending.blocked || !pending.continueEditingVisible) throw new Error('\u672a\u68c0\u6d4b\u5230\u53ef\u7ee7\u7eed\u7f16\u8f91\u7684B\u7ad9\u672c\u5730\u8349\u7a3f');
    const draftAssessment = this.assessLocalDraft(payload, pending.localDraftFingerprint);
    const exactOrManagedContentMatch = draftAssessment.exactFingerprint || (draftAssessment.managed && draftAssessment.contentMatched);
    if (draftAssessment.verifyOnly) {
      return { status: 'NEEDS_CONFIRMATION', result: await this.evidence(payload, '\u0042\u7ad9\u672c\u5730\u8349\u7a3f\u5df2\u8fdb\u5165\u6295\u7a3f\u5c1d\u8bd5\u9636\u6bb5\uff0c\u7981\u6b62\u7ee7\u7eed\u7f16\u8f91\u6216\u91cd\u590d\u6295\u7a3f\uff0c\u8bf7\u6539\u7528\u7ba1\u7406\u9875\u6838\u9a8c', page, 'existing_draft_requires_verification', { expectedDraftFingerprint: payload.draftFingerprint, localDraftFingerprint: pending.localDraftFingerprint, draftAssessment, verificationRequired: true, submitAttempted: true }) };
    }
    if (!exactOrManagedContentMatch) {
      return { status: 'NEEDS_CONFIRMATION', result: await this.evidence(payload, '\u0042\u7ad9\u672c\u5730\u8349\u7a3f\u6307\u7eb9\u4e0e\u5f53\u524d\u4efb\u52a1\u4e0d\u4e00\u81f4\uff0c\u5df2\u7981\u6b62\u7ee7\u7eed\u7f16\u8f91\u548c\u6295\u7a3f', page, 'existing_draft_fingerprint_mismatch', { expectedDraftFingerprint: payload.draftFingerprint, localDraftFingerprint: pending.localDraftFingerprint, draftAssessment, submitAttempted: false }) };
    }
    const continueEditing = await firstVisibleByText(page, ['\u7ee7\u7eed\u7f16\u8f91']);
    if (!continueEditing) throw new Error('\u672a\u627e\u5230\u552f\u4e00\u53ef\u7528\u7684\u7ee7\u7eed\u7f16\u8f91\u5165\u53e3');
    await continueEditing.click();
    await page.waitForTimeout(1800);
    await this.runtimeCheckpoint(generation);
    let draftText = clean(await page.locator('body').innerText({ timeout: 10000 }).catch(() => ''));
    let managedPageVerification = null;
    if (draftAssessment.managed && draftAssessment.contentMatched) {
      managedPageVerification = await this.verifyManagedDraftPage(page, pending.localDraftFingerprint);
      if (!managedPageVerification.matched) {
        return { status: 'NEEDS_CONFIRMATION', result: await this.evidence(payload, '\u0042\u7ad9\u9875\u9762\u4e2d\u7684\u5b9e\u9645\u8349\u7a3f\u4e0e\u7cfb\u7edf\u5185\u5bb9\u6307\u7eb9\u4e0d\u4e00\u81f4\uff0c\u5df2\u7981\u6b62\u6295\u7a3f', page, 'existing_draft_actual_identity_mismatch', { expectedTitle, expectedMaterial, draftAssessment, managedPageVerification, submitAttempted: false }) };
      }
      if (!draftText.includes(expectedTitle)) {
        const titleUpdated = await this.fillExistingDraftField(page, this.spec.titleSelectors || [], expectedTitle);
        const description = cleanMultiline([expectedTitle, payload.body].filter(Boolean).join('\n'));
        const captionUpdated = description ? await this.fillExistingDraftField(page, this.spec.captionSelectors || [], description) : false;
        if (!titleUpdated) {
          return { status: 'NEEDS_CONFIRMATION', result: await this.evidence(payload, '\u5df2\u786e\u8ba4\u662f\u540c\u4e00\u7d20\u6750\u7684\u7cfb\u7edf\u8349\u7a3f\uff0c\u4f46\u65e0\u6cd5\u53ef\u9760\u66f4\u65b0\u4e3a\u5f53\u524d\u4efb\u52a1\u6807\u9898\uff0c\u5df2\u7981\u6b62\u6295\u7a3f', page, 'existing_draft_metadata_update_blocked', { expectedTitle, expectedMaterial, draftAssessment, managedPageVerification, titleUpdated, captionUpdated, submitAttempted: false }) };
        }
        await page.waitForTimeout(350);
        draftText = clean(await page.locator('body').innerText({ timeout: 10000 }).catch(() => draftText));
      }
    } else if (!draftText.includes(expectedTitle) || !draftText.includes(expectedMaterial) || !draftText.includes('\u4e0a\u4f20\u5b8c\u6210')) {
      return { status: 'NEEDS_CONFIRMATION', result: await this.evidence(payload, '\u65e2\u6709\u0042\u7ad9\u8349\u7a3f\u4e0e\u9884\u671f\u6807\u9898/\u7d20\u6750\u4e0d\u5339\u914d\uff0c\u5df2\u7981\u6b62\u6295\u7a3f', page, 'existing_draft_mismatch', { expectedTitle, expectedMaterial, draftAssessment, submitAttempted: false }) };
    }
    const declaration = await this.applyContentDeclaration(page, { contentOrigin: payload.contentOrigin || 'AI_GENERATED' });
    const coverResult = await this.ensureBilibiliCover(
      page,
      { ...payload, title: expectedTitle },
      payload.materialPath || expectedMaterial,
      generation
    );
    const coverState = coverResult.coverState;

    const coverStamp = Date.now();
    const coverStatePath = path.join(this.logsDir, `bilibili-cover-state-${coverStamp}.json`);
    const coverStateScreenshotPath = path.join(this.logsDir, `bilibili-cover-state-${coverStamp}.png`);
    fs.writeFileSync(
      coverStatePath,
      JSON.stringify({
        url: page.url(),
        coverState,
        coverResult,
        prepareOnly: payload.prepareOnly === true
      }, null, 2),
      'utf8'
    );
    await page.screenshot({ path: coverStateScreenshotPath, fullPage: false }).catch(() => {});
    const draftFingerprintState = this.writeDraftFingerprintState(payload, 'DRAFT_READY', { coverConfirmedAt: new Date().toISOString(), coverStatePath });
    if (payload.prepareOnly === true) {
      return { status: 'SUCCESS', result: await this.evidence(payload, '\u5df2\u786e\u8ba4B\u7ad9\u65e2\u6709\u8349\u7a3f\u5c01\u9762\u771f\u6b63\u4fdd\u5b58\u5230\u4e3b\u8868\u5355\uff0c\u672a\u6267\u884c\u6700\u7ec8\u6295\u7a3f', page, 'existing_draft_cover_ready', { submissionStatus: 'NOT_SUBMITTED', submitAttempted: false, expectedTitle, expectedMaterial, declaration, coverState, coverStatePath, coverStateScreenshotPath, draftFingerprintState }) };
    }

    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(700);
    const publishControl = await this.findFinalPublishControl(page);
    if (publishControl.status !== 'UNIQUE' || !publishControl.locator) {
      return { status: 'NEEDS_CONFIRMATION', result: await this.evidence(payload, '\u672a\u627e\u5230\u552f\u4e00\u53ef\u7528\u7684B\u7ad9\u6700\u7ec8\u6295\u7a3f\u5165\u53e3', page, 'existing_draft_submit_blocked', { publishControl: { status: publishControl.status, count: publishControl.count || 0, method: publishControl.method || null }, submitAttempted: false }) };
    }
    await this.runtimeCheckpoint(generation);
    const submitAuthorization = await this.authorizeFinalSubmit(preflightPayload, { reason: 'BILIBILI_EXISTING_DRAFT_FINAL_CLICK', source: payload.autoResume === true ? 'AUTO_RESUME_EXISTING_DRAFT' : 'MANUAL_EXISTING_DRAFT' });
    this.writeDraftFingerprintState(payload, 'SUBMITTING', { submitAuthorization, resumedFromDraft: true, submitAttemptedAt: new Date().toISOString() });
    await publishControl.locator.click();
    this.writeDraftFingerprintState(payload, 'SUBMIT_ATTEMPTED', { submitAuthorization, resumedFromDraft: true, submitAttemptedAt: new Date().toISOString() });
    const signal = await this.waitForPublishSignal(page);
    const managementVerification = await this.waitForSubmittedManagementRecord(preflightPayload, generation);
    const evidencePage = await this.getPage();
    if (managementVerification.confirmed === true) {
      const submittedDraftState = this.writeDraftFingerprintState(payload, 'SUBMITTED', {
        submitAuthorization,
        resumedFromDraft: true,
        submittedAt: managementVerification.submittedAt || new Date().toISOString(),
        publishSignal: signal?.source || null,
        platformPostId: managementVerification.platformPostId || null,
        platformUrl: managementVerification.platformUrl || null
      });
      return { status: 'SUCCESS', result: await this.evidence(payload, '\u5df2\u63d0\u4ea4\u7ecf\u7cbe\u786e\u5339\u914d\u7684B\u7ad9\u65e2\u6709\u8349\u7a3f\uff0c\u5e76\u5df2\u5728\u7a3f\u4ef6\u7ba1\u7406\u9875\u627e\u5230\u5bf9\u5e94\u7a3f\u4ef6', evidencePage, 'published', { publishSignal: signal?.source || null, submissionStatus: 'SUBMITTED', reviewStatus: managementVerification.reviewStatus || 'REVIEWING', platformPostId: managementVerification.platformPostId || null, platformUrl: managementVerification.platformUrl || null, managementVerification, finalActionAuthorized: true, submitAttempted: true, expectedTitle, expectedMaterial, submitAuthorization, draftAssessment, managedPageVerification, autoResumed: payload.autoResume === true, submittedDraftState }) };
    }
    return { status: 'NEEDS_CONFIRMATION', result: await this.evidence(payload, '\u5df2\u70b9\u51fbB\u7ad9\u7acb\u5373\u6295\u7a3f\uff0c\u4f46\u7a3f\u4ef6\u7ba1\u7406\u9875\u5c1a\u672a\u627e\u5230\u5bf9\u5e94\u7a3f\u4ef6\uff1b\u6295\u7a3f\u9501\u4fdd\u6301\uff0c\u7981\u6b62\u81ea\u52a8\u91cd\u8bd5', evidencePage, 'publish_unconfirmed', { publishSignal: signal?.source || null, submissionStatus: 'UNKNOWN', managementVerification, finalActionAuthorized: true, submitAttempted: true, expectedTitle, expectedMaterial, submitAuthorization, draftAssessment, managedPageVerification, autoResumed: payload.autoResume === true }) };
  }

  async inspectMessageApi() {
    const { selfUid } = await this.auth();
    const comments = await this.apiGet(COMMENT_FEED_URL, '读取B站评论通知');
    const sessions = await this.apiGet(SESSION_LIST_URL, '读取B站私信会话');
    const sessionList = listOf(first(dataOf(sessions).session_list, dataOf(sessions).sessions, dataOf(sessions).list));
    const unreadSessions = sessionList.filter(item => Number(item?.unread_count || 0) > 0 && Number(item?.session_type || 1) === 1);
    let messageSample = null;
    if (unreadSessions[0]?.talker_id) {
      const params = new URLSearchParams({ talker_id: String(unreadSessions[0].talker_id), session_type: '1', size: '20', build: '0', mobi_app: 'web' });
      const response = await this.apiGet(`${SESSION_MESSAGES_URL}?${params}`, '读取B站私信消息');
      const messages = listOf(first(dataOf(response).messages, dataOf(response).msg_list, dataOf(response).list));
      messageSample = { code: responseCode(response), count: messages.length, itemKeys: Object.keys(messages[0] || {}).sort() };
    }
    const commentItems = listOf(first(dataOf(comments).items, dataOf(comments).replies, dataOf(comments).list));
    return {
      authenticated: true,
      selfUidPresent: Boolean(selfUid),
      comments: { code: responseCode(comments), count: commentItems.length, itemKeys: Object.keys(commentItems[0] || {}).sort(), nestedItemKeys: Object.keys(commentItems[0]?.item || {}).sort() },
      sessions: { code: responseCode(sessions), count: sessionList.length, unreadCount: unreadSessions.length, itemKeys: Object.keys(sessionList[0] || {}).sort() },
      messages: messageSample,
      redacted: true,
      inspectionOnly: true
    };
  }

  async collectMessages(payload) {
    const generation = this.lifecycleGeneration;
    await this.runtimeCheckpoint(generation);
    const page = await this.getPage();
    const types = new Set((payload?.types || ['COMMENT', 'PRIVATE_MESSAGE']).map(value => String(value).toUpperCase()));
    const targetedRecovery = recoveryCollectionTargets(payload);
    if (targetedRecovery && !targetedRecovery.ok) return recoveryCollectionFailure(targetedRecovery.code, 'B站旧会话恢复任务缺少平台稳定会话标识，已禁止泛扫历史会话');
    if (targetedRecovery && (types.size !== 1 || !types.has('PRIVATE_MESSAGE'))) {
      return recoveryCollectionFailure('RECOVERY_PRIVATE_MESSAGE_ONLY', 'B站旧会话恢复任务只允许定向采集私信');
    }
    const unsupportedTypes = [...types].filter(type => !['COMMENT', 'PRIVATE_MESSAGE'].includes(type));
    if (unsupportedTypes.length) {
      return { status: 'FAILED', result: await this.evidence(payload, `B站消息采集包含不支持的类型：${unsupportedTypes.join(', ')}`, page, 'message_collection_invalid') };
    }
    const messages = [];
    const apiEvidence = { collectionErrors: [], privateSessionErrors: [] };
    const successfulScopeNames = [];
    const partialScopeNames = [];
    const failedScopeNames = [];
    let successfulScopes = 0;
    let requestedScopes = 0;
    let commentWatermarkMessages = [];
    let privateWatermarkSessions = [];
    try {
      const { selfUid } = await this.auth();
      const boundUid = firstPositiveIntegerId(payload?.platformUserId, payload?.boundPlatformUserId);
      const identityMode = boundUid ? 'ENFORCED' : 'OBSERVE_ONLY';
      if (boundUid && boundUid !== selfUid) {
        return { status: 'FAILED', result: await this.evidence(payload, `B站当前登录账号 UID（${selfUid}）与系统绑定 UID（${boundUid}）不一致，已停止采集`, page, 'account_identity_mismatch', {
          sendMethod: 'bilibili-api:read-only', apiConfirmed: false, accountIdentityMode: identityMode,
          currentPlatformUserId: selfUid, boundPlatformUserId: boundUid, safeToRetry: false
        }) };
      }
      await this.runtimeCheckpoint(generation);

      if (types.has('COMMENT')) {
        requestedScopes += 1;
        const maxPages = Math.max(1, Math.min(10, Number(payload?.maxCommentPages || 5) || 5));
        const parsedComments = [];
        const visitedUrls = new Set();
        let nextUrl = COMMENT_FEED_URL;
        let scannedPages = 0;
        let stopReason = 'MAX_PAGES';
        try {
          while (nextUrl && scannedPages < maxPages) {
            if (visitedUrls.has(nextUrl)) { stopReason = 'CURSOR_LOOP'; break; }
            await this.runtimeCheckpoint(generation);
            visitedUrls.add(nextUrl); scannedPages += 1;
            const response = await this.apiGet(nextUrl, `采集B站评论通知（第 ${scannedPages} 页）`);
            parsedComments.push(...parseBilibiliCommentFeed(response, selfUid));
            const candidate = buildBilibiliCommentFeedPageUrl(response);
            if (!candidate) { stopReason = 'CURSOR_END'; nextUrl = null; break; }
            nextUrl = candidate;
          }
          const parsed = dedupeMessages(parsedComments);
          commentWatermarkMessages = parsedComments;
          messages.push(...parsed);
          apiEvidence.commentCount = parsed.length;
          apiEvidence.replyableCommentCount = parsed.filter(item => item.context?.replyable === true).length;
          apiEvidence.commentPagesScanned = scannedPages;
          apiEvidence.commentPageScanStopReason = stopReason;
          apiEvidence.commentPageScanTruncated = Boolean(nextUrl && scannedPages >= maxPages);
          apiEvidence.commentPagePartial = Boolean(apiEvidence.commentPageScanTruncated || stopReason === 'CURSOR_LOOP');
          successfulScopes += 1;
          successfulScopeNames.push('COMMENT');
          if (apiEvidence.commentPagePartial) partialScopeNames.push('COMMENT');
        } catch (error) {
          if (isPlatformStopError(error)) throw error;
          apiEvidence.collectionErrors.push({ scope: 'COMMENT', retryable: true, reason: error.message });
          apiEvidence.commentCollectionError = error.message;
          failedScopeNames.push('COMMENT');
        }
      }

      if (types.has('PRIVATE_MESSAGE')) {
        requestedScopes += 1;
        try {
          const sessionsResponse = await this.apiGet(SESSION_LIST_URL, '采集B站私信会话');
          const sessions = listOf(first(dataOf(sessionsResponse).session_list, dataOf(sessionsResponse).sessions, dataOf(sessionsResponse).list));
          const previousSessionWatermarks = payload?.collectionWatermarks?.PRIVATE_MESSAGE?.sessions && typeof payload.collectionWatermarks.PRIVATE_MESSAGE.sessions === 'object'
            ? payload.collectionWatermarks.PRIVATE_MESSAGE.sessions
            : {};
          const recoverySelection = targetedRecovery ? selectBilibiliRecoverySessions(sessions, targetedRecovery.targets) : null;
          if (recoverySelection && !recoverySelection.ok) {
            return {
              status: 'NEEDS_CONFIRMATION',
              result: await this.evidence(payload, 'B站旧会话恢复任务无法按稳定用户 UID 唯一定位目标会话', page, 'recovery_target_unverified', {
                code: recoverySelection.reason,
                messages: [],
                recoveryTargeted: true,
                recoverySelection,
                sendMethod: 'bilibili-api:read-only',
                apiConfirmed: true
              })
            };
          }
          const unreadSessions = sessions.filter(item => Number(first(item?.unread_count, item?.unread, 0)) > 0 && Number(first(item?.session_type, 1)) === 1);
          const advancedReadSessions = payload?.collectionMode === 'SAFE_INCREMENTAL_OBSERVATION'
            ? sessions.filter(item => {
              if (Number(first(item?.unread_count, item?.unread, 0)) > 0 || Number(first(item?.session_type, 1)) !== 1) return false;
              const talkerId = bilibiliSessionWatermark(item).talkerId;
              return Boolean(talkerId && bilibiliSessionHasAdvanced(item, previousSessionWatermarks[talkerId]));
            })
            : [];
          const candidateSessions = targetedRecovery
            ? recoverySelection.sessions
            : [...unreadSessions, ...advancedReadSessions.filter(item => !unreadSessions.includes(item))];
          const maxSessions = targetedRecovery
            ? targetedRecovery.targets.length
            : Math.max(1, Math.min(50, Number(payload?.maxPrivateSessions || 30) || 30));
          const selectedSessions = candidateSessions.slice(0, maxSessions);
          const messageResponses = {};
          for (const session of selectedSessions) {
            await this.runtimeCheckpoint(generation);
            const talkerId = clean(first(session?.talker_id, session?.receiver_id, session?.uid));
            if (!/^[1-9]\d*$/.test(talkerId)) {
              apiEvidence.privateSessionErrors.push({ talkerId: null, retryable: false, reason: '会话缺少有效用户UID' });
              continue;
            }
            const unreadCount = Math.max(0, Number(first(session?.unread_count, session?.unread, 0)) || 0);
            const hasAdvancedWatermark = unreadCount === 0 && bilibiliSessionHasAdvanced(session, previousSessionWatermarks[talkerId]);
            const size = String(targetedRecovery || hasAdvancedWatermark ? 50 : Math.max(20, Math.min(50, Math.max(1, unreadCount) + 5)));
            const params = new URLSearchParams({ talker_id: talkerId, session_type: '1', size, build: '0', mobi_app: 'web' });
            try {
              messageResponses[talkerId] = await this.apiGet(`${SESSION_MESSAGES_URL}?${params}`, `采集B站私信消息（用户 ${talkerId}）`);
            } catch (error) {
              if (isPlatformStopError(error)) throw error;
              apiEvidence.privateSessionErrors.push({ talkerId, retryable: true, reason: error.message });
            }
          }
          privateWatermarkSessions = selectedSessions.filter(session => {
            const talkerId = clean(first(session?.talker_id, session?.receiver_id, session?.uid));
            return Boolean(talkerId && messageResponses[talkerId]);
          });
          const parsed = parseBilibiliPrivateFeed({ sessionsResponse, messageResponses, selfUid, previousSessionWatermarks });
          messages.push(...parsed);
          apiEvidence.privateCount = parsed.length;
          apiEvidence.unreadSessions = unreadSessions.length;
          apiEvidence.advancedReadSessions = advancedReadSessions.length;
          apiEvidence.scannedUnreadSessions = selectedSessions.length;
          apiEvidence.privateSessionScanTruncated = targetedRecovery ? false : candidateSessions.length > selectedSessions.length;
          apiEvidence.recoveryTargeted = Boolean(targetedRecovery);
          apiEvidence.recoveryTargetCount = targetedRecovery?.targets.length || 0;
          apiEvidence.recoveryTargetIds = targetedRecovery?.targets.map(item => item.externalConversationKey) || [];
          apiEvidence.privatePartial = Boolean(apiEvidence.privateSessionScanTruncated || apiEvidence.privateSessionErrors.length);
          successfulScopes += 1;
          successfulScopeNames.push('PRIVATE_MESSAGE');
          if (apiEvidence.privatePartial) partialScopeNames.push('PRIVATE_MESSAGE');
        } catch (error) {
          if (isPlatformStopError(error)) throw error;
          apiEvidence.collectionErrors.push({ scope: 'PRIVATE_MESSAGE', retryable: true, reason: error.message });
          apiEvidence.privateCollectionError = error.message;
          failedScopeNames.push('PRIVATE_MESSAGE');
        }
      }

      await this.runtimeCheckpoint(generation);
      const uniqueMessages = dedupeMessages(messages);
      const partial = apiEvidence.collectionErrors.length > 0
        || apiEvidence.privateSessionErrors.length > 0
        || apiEvidence.commentPagePartial === true
        || apiEvidence.privateSessionScanTruncated === true;
      const status = partial
        ? (successfulScopes > 0 || uniqueMessages.length > 0 ? 'PARTIAL_SUCCESS' : 'FAILED')
        : 'SUCCESS';
      const message = status === 'PARTIAL_SUCCESS'
        ? `B站消息部分采集完成：${uniqueMessages.length} 条，仍有范围需要补采或重试`
        : status === 'FAILED'
          ? 'B站消息采集失败，请检查登录状态或网络后重试'
          : `B站消息采集完成：${uniqueMessages.length} 条`;
      const result = await this.evidence(payload, message, page, status === 'SUCCESS' ? 'messages_collected' : 'messages_partially_collected', {
        ...apiEvidence,
        requestedScopes,
        successfulScopes,
        partialCollection: partial,
        successfulScopeNames,
        partialScopeNames,
        failedScopeNames,
        collectionWatermarks: buildBilibiliCollectionWatermarks(uniqueMessages, {
          commentMessages: commentWatermarkMessages
        }),
        accountIdentityMode: identityMode,
        currentPlatformUserId: selfUid,
        boundPlatformUserId: boundUid || null,
        sendMethod: 'bilibili-api:read-only',
        apiConfirmed: true
      });
      return { status, result: { ...result, messages: uniqueMessages } };
    } catch (error) {
      if (isPlatformStopError(error)) throw error;
      return { status: 'FAILED', result: await this.evidence(payload, `B站评论/私信采集失败：${error.message}`, page, 'message_collection_failed', { ...apiEvidence, apiConfirmed: false }) };
    }
  }

  async replyToMessage(payload) {
    const generation = this.lifecycleGeneration;
    const type = String(payload?.messageType || '').toUpperCase();
    if (!['COMMENT', 'PRIVATE_MESSAGE'].includes(type)) {
      return { status: 'FAILED', result: await this.evidence(payload, `不支持的B站消息类型：${type || 'unknown'}`, null, 'reply_validation_failed', { sendAttempted: false }) };
    }
    if (!cleanMultiline(payload?.replyText)) {
      return { status: 'FAILED', result: await this.evidence(payload, 'B站回复内容为空，已禁止发送', null, 'reply_validation_failed', { sendAttempted: false }) };
    }
    const lengthCheck = validateReplyTextLength({ platformCode: 'bilibili', messageType: type, text: cleanMultiline(payload.replyText) });
    if (!lengthCheck.ok) {
      return { status: 'NEEDS_CONFIRMATION', result: await this.evidence(payload, lengthCheck.message, null, 'reply_length_blocked', {
        sendAttempted: false, characterCount: lengthCheck.count, characterLimit: lengthCheck.limit
      }) };
    }
    await this.runtimeCheckpoint(generation);
    const page = await this.getPage();
    let attempted = false;
    let sendMethod = type === 'COMMENT' ? 'bilibili-api:reply-add' : 'bilibili-api:web-im-send-msg';
    try {
      const { csrf, selfUid } = await this.auth();
      const boundUid = firstPositiveIntegerId(payload?.platformUserId, payload?.boundPlatformUserId);
      if (boundUid && boundUid !== selfUid) {
        return { status: 'FAILED', result: await this.evidence(payload, `B站当前登录账号 UID（${selfUid}）与系统绑定 UID（${boundUid}）不一致，已禁止回复`, page, 'account_identity_mismatch', {
          sendMethod, sendAttempted: false, verified: false, safeToRetry: false,
          currentPlatformUserId: selfUid, boundPlatformUserId: boundUid, accountIdentityMode: 'ENFORCED'
        }) };
      }
      const form = type === 'COMMENT'
        ? buildBilibiliCommentReplyForm(payload, csrf)
        : buildBilibiliPrivateReplyForm(payload, csrf, selfUid);
      const url = type === 'COMMENT' ? COMMENT_REPLY_URL : PRIVATE_REPLY_URL;
      const operation = type === 'COMMENT' ? '发送B站评论回复' : '发送B站私信回复';
      await this.runtimeCheckpoint(generation);
      attempted = true;
      const response = await this.apiPost(url, form, operation, 'https://message.bilibili.com/');
      requireApiSuccess(response, operation);
      const platformMessageId = extractBilibiliReplyReceipt(response, type);
      if (!platformMessageId) {
        return { status: 'NEEDS_CONFIRMATION', result: await this.evidence(payload, 'B站 API 返回成功但缺少平台消息 ID；为防止重复发送，请人工核对', page, 'reply_unconfirmed', { sendMethod, apiCode: 0, verified: false, sendAttempted: true, receiptMissing: true }) };
      }
      return {
        status: 'SUCCESS',
        result: await this.evidence(payload, 'B站回复已发送，并取得平台成功回执与消息 ID', page, 'reply_sent', {
          sendMethod,
          apiCode: 0,
          platformMessageId,
          verified: true,
          sendAttempted: true,
          targetPrecision: type === 'COMMENT' ? 'OID_TYPE_ROOT_PARENT' : 'TALKER_ID'
        })
      };
    } catch (error) {
      if (isPlatformStopError(error) && !attempted) throw error;
      if (error?.apiRejected === true) {
        return { status: 'FAILED', result: await this.evidence(payload, `B站明确拒绝回复请求：${error.message}`, page, 'reply_rejected', { sendMethod, apiCode: error.apiCode, verified: false, sendAttempted: attempted, sendRejected: true }) };
      }
      const status = attempted ? 'NEEDS_CONFIRMATION' : 'FAILED';
      return { status, result: await this.evidence(payload, attempted ? `B站回复请求结果不确定：${error.message}；为防止重复发送，请人工核对` : `B站回复发送前校验失败：${error.message}`, page, attempted ? 'reply_unconfirmed' : 'reply_validation_failed', { sendMethod, sendAttempted: attempted, verified: false, interruptedByPlatformStop: isPlatformStopError(error) }) };
    }
  }

  async detectManualReply(payload) {
    const generation = this.lifecycleGeneration;
    const expected = cleanMultiline(payload?.expectedReply);
    if (!expected) return { status: 'FAILED', result: await this.evidence(payload, '缺少需要检测的人工回复内容', null, 'manual_detect_invalid', { handled: false }) };
    await this.runtimeCheckpoint(generation);
    const page = await this.getPage();
    try {
      const { selfUid } = await this.auth();
      if (String(payload?.messageType).toUpperCase() !== 'PRIVATE_MESSAGE') {
        return { status: 'NEEDS_CONFIRMATION', result: await this.evidence(payload, 'B站评论人工回复检测尚无可靠只读线程接口，必须在平台评论线程中复核', page, 'manual_detect_requires_review', { handled: false }) };
      }
      const context = payload?.messageContext || payload?.context || {};
      const talkerId = positiveIntegerId(context?.talkerId, 'talkerId');
      const sourceSeqno = asNumber(context?.msgSeqno);
      const sourceTimestamp = asNumber(context?.messageTimestamp);
      const params = new URLSearchParams({ talker_id: talkerId, session_type: '1', size: '50', build: '0', mobi_app: 'web' });
      const response = await this.apiGet(`${SESSION_MESSAGES_URL}?${params}`, '检测B站人工私信回复');
      const messages = listOf(first(dataOf(response).messages, dataOf(response).msg_list, dataOf(response).list));
      const matched = messages.find(item => {
        const senderUid = clean(first(item?.sender_uid, item?.sender_id));
        const receiverId = clean(first(item?.receiver_id, item?.receiver_uid));
        const msgSeqno = asNumber(first(item?.msg_seqno, item?.seqno));
        const timestamp = asNumber(item?.timestamp);
        if (senderUid !== selfUid || (receiverId && receiverId !== talkerId) || Number(first(item?.msg_type, item?.type)) !== 1) return false;
        if (sourceSeqno !== null && msgSeqno !== null && msgSeqno <= sourceSeqno) return false;
        if (sourceTimestamp !== null && timestamp !== null && timestamp < sourceTimestamp) return false;
        return parseTextContent(item?.content) === expected;
      });
      const platformMessageId = matched ? clean(first(matched?.msg_key, matched?.key)) || null : null;
      const handled = Boolean(matched && platformMessageId && /^[1-9]\d*$/.test(platformMessageId));
      return { status: 'SUCCESS', result: await this.evidence(payload, handled ? '已在B站精确私信会话检测到指定人工回复' : '未在B站精确私信会话检测到指定人工回复', page, 'manual_reply_detected', { handled, platformMessageId: handled ? platformMessageId : null, sendMethod: 'bilibili-api:read-only', targetPrecision: 'TALKER_ID_AND_AFTER_SOURCE' }) };
    } catch (error) {
      if (isPlatformStopError(error)) throw error;
      return { status: 'FAILED', result: await this.evidence(payload, `B站人工回复检测失败：${error.message}`, page, 'manual_detect_failed', { handled: false }) };
    }
  }
}






