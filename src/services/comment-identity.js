import { platformEventAgeMs } from './message-occurrence.js';
import { hashString } from './workflow.js';

function parseContext(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return {}; }
}

export function normalizeCommentIdentityText(value) {
  return String(value || '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLocaleLowerCase('zh-CN');
}

function stableNoteCandidate(candidate = {}) {
  const platformPostId = normalizeCommentIdentityText(candidate.platformPostId);
  if (platformPostId) return `post:${platformPostId}`;
  const platformUrl = normalizeCommentIdentityText(candidate.platformUrl);
  return platformUrl ? `url:${platformUrl}` : '';
}

export function commentSourceIdentity(contextValue = {}) {
  const context = parseContext(contextValue);
  const commentStableId = normalizeCommentIdentityText(context.commentStableId || context.commentId);
  if (commentStableId) return `comment:${commentStableId}`;
  for (const key of ['sourceVideoKey', 'sourceVideoId', 'sourceAwemeId', 'awemeId', 'itemId', 'videoId']) {
    const value = normalizeCommentIdentityText(context[key]);
    if (value) return `video:${value}`;
  }
  const sourceVideoUrl = normalizeCommentIdentityText(context.sourceVideoUrl || context.videoUrl);
  if (sourceVideoUrl) return `video-url:${sourceVideoUrl}`;
  const noteCandidates = Array.isArray(context.noteCandidates) ? context.noteCandidates.map(stableNoteCandidate).filter(Boolean) : [];
  if (noteCandidates.length === 1) return noteCandidates[0];
  const sourceVideoTitle = normalizeCommentIdentityText(context.sourceVideoTitle);
  const sourceVideoTime = normalizeCommentIdentityText(context.sourceVideoTime);
  if (sourceVideoTitle) return `video-title:${sourceVideoTitle}|${sourceVideoTime}`;
  return '';
}

function observedAtMs(existing, fallback) {
  const value = new Date(existing.collected_at || existing.updated_at || existing.created_at || fallback).getTime();
  return Number.isFinite(value) ? value : new Date(fallback).getTime();
}

export function estimatedCommentEventAt(contextValue, observedAt = new Date()) {
  const reference = observedAt instanceof Date ? observedAt : new Date(observedAt);
  if (!Number.isFinite(reference.getTime())) return null;
  const age = platformEventAgeMs(parseContext(contextValue).eventTime, reference);
  return age === null ? null : reference.getTime() - age;
}

export function douyinCommentOccurrenceAnchor(contextOrEventTime, observedAt = new Date()) {
  const context = typeof contextOrEventTime === 'object' ? contextOrEventTime : { eventTime: contextOrEventTime };
  const eventAt = estimatedCommentEventAt(context, observedAt);
  if (eventAt === null) return '';
  const bucketMs = 10 * 60 * 1000;
  return new Date(Math.round(eventAt / bucketMs) * bucketMs).toISOString();
}

export function isSameDouyinCommentSemanticCandidate(existing, incoming = {}, reference = new Date()) {
  if (!existing) return false;
  if (normalizeCommentIdentityText(existing.user_name) !== normalizeCommentIdentityText(incoming.userName || '未知用户')) return false;
  if (normalizeCommentIdentityText(existing.content) !== normalizeCommentIdentityText(incoming.content)) return false;

  const previousContext = parseContext(existing.context_json ?? existing.context);
  const incomingContext = parseContext(incoming.context);
  const previousSource = commentSourceIdentity(previousContext);
  const incomingSource = commentSourceIdentity(incomingContext);
  if (previousSource && incomingSource) return previousSource === incomingSource;

  const previousUrl = normalizeCommentIdentityText(existing.external_url);
  const incomingUrl = normalizeCommentIdentityText(incoming.externalUrl);
  if (previousUrl && incomingUrl && previousUrl !== incomingUrl) return false;

  // 兼容旧采集记录没有作品 ID 的情况：相对时间换算出的事件时刻必须接近，
  // 才允许把不同 externalId 视为同一条评论，避免跨作品永久按“用户+正文”吞消息。
  const incomingObservedAt = reference instanceof Date ? reference : new Date(reference);
  const previousObservedAt = new Date(observedAtMs(existing, incomingObservedAt));
  const previousEventAt = estimatedCommentEventAt(previousContext, previousObservedAt);
  const incomingEventAt = estimatedCommentEventAt(incomingContext, incomingObservedAt);
  if (previousEventAt === null || incomingEventAt === null) return false;
  return Math.abs(previousEventAt - incomingEventAt) <= 5 * 60 * 1000;
}

export function buildReplyIdempotencyKey(message = {}) {
  if (message.platform_code !== 'douyin' || String(message.message_type || '').toUpperCase() !== 'COMMENT') return `reply:message:${message.id}`;
  const context = parseContext(message.context_json);
  const source = commentSourceIdentity(context) || normalizeCommentIdentityText(message.external_url) || 'unknown-source';
  const repeatSuffix = String(message.external_id || '').match(/--repeat-([0-9]+)$/)?.[1] || 'base';
  const semantic = [
    message.platform_code,
    message.account_id,
    source,
    normalizeCommentIdentityText(message.user_name),
    normalizeCommentIdentityText(message.content),
    repeatSuffix
  ].join('|');
  return `reply:comment:${hashString(semantic)}`;
}
