import { searchKnowledge } from './knowledge.js';
import { selectKnowledgeForReply, suggestKnowledgeClarification, composeReply, composeMultiReply, composeSmallTalkReply, composeGroundedMockReply } from './qwen.js';
import { validateReply, validateMultiReply } from './decision.js';
import { getReplyLimit } from './platform-reply-policy.js';
import { CONVERSATION_HISTORY_MAX_TURNS } from './conversation-policy.js';
import { commentSourceTopicAnchor } from './message-source-context.js';
export { commentSourceTopicAnchor } from './message-source-context.js';
import { BUSINESS_GUIDANCE_MAX_ATTEMPTS, clarificationQuestion, composeGroundedMultiReply, detectGreetingIntent, detectSmallTalkIntent, ensureNaturalReplyGreeting, isAffirmativeReply, isNegativeReply, knowledgeGapReply, smallTalkFallbackReply, splitUserQuestions } from './conversation-intent.js';

const TOPIC_SWITCH = /(?:另外(?:想)?问|换个问题|再问个(?:别的)?|还有一件事|说到别的|顺便问|不说这个|另一个问题)/i;
const ELLIPSIS = /^(?:那|那么|这个|这个呢|那个|然后)?\s*(?:收费|免费|多少钱|费用|地址|在哪|哪里|时间|几点|什么时候|怎么报名|如何报名|孩子|小孩|儿童|能带孩子|可以吗|行吗|能不能|可不可以|是否可以|要什么|需要什么|怎么办|怎么弄|呢|吗)[？?。！!\s]*$/i;
const EXPLICIT_TOPIC = /(?:活动|报名|地址|地点|收费|费用|孩子|小孩|支付宝|银行卡|志愿者|社区|视频|转发|开放时间|办公时间|联系方式|电话)/i;

const NON_BUSINESS_CONTEXT_DECISIONS = new Set([
  'SMALL_TALK', 'GREETING_GUIDANCE', 'HANDOFF_NOT_FOUND', 'HANDOFF_ALREADY_SUBMITTED', 'HANDOFF_SUBMITTED'
]);
const BUSINESS_GUIDANCE_DECISIONS = new Set(['SMALL_TALK', 'GREETING_GUIDANCE', 'KNOWLEDGE_GAP_GUIDANCE', 'AUTO_REPLY_PARTIAL_KNOWLEDGE', 'RAG_NEED_CLARIFICATION', 'RAG_CLARIFICATION_LIMIT']);
const BUSINESS_GUIDANCE_SIGNAL = /(?:具體|具体|業務|业务|諮詢|咨询|辦理|办理|活動|活动|報名|报名|流程|時間|时间|地點|地点|費用|费用|材料|知識庫|知识库)/;

export function consecutiveBusinessGuidanceAttempts(recentMessages = []) {
  let attempts = 0;
  for (let index = (recentMessages || []).length - 1; index >= 0; index -= 1) {
    const decision = String(recentMessages[index]?.decision || '').toUpperCase();
    if (!BUSINESS_GUIDANCE_DECISIONS.has(decision)) break;
    attempts += 1;
  }
  return attempts;
}

function isBusinessGuidingReply(value = '') {
  return BUSINESS_GUIDANCE_SIGNAL.test(clean(value));
}

export function businessConversationContext(recentMessages = []) {
  return (recentMessages || []).slice(-CONVERSATION_HISTORY_MAX_TURNS).filter(item => !NON_BUSINESS_CONTEXT_DECISIONS.has(String(item?.decision || '').toUpperCase()));
}

export function smallTalkConversationContext(recentMessages = []) {
  return (recentMessages || []).slice(-CONVERSATION_HISTORY_MAX_TURNS).filter(item => ['SMALL_TALK', 'GREETING_GUIDANCE'].includes(String(item?.decision || '').toUpperCase()));
}

function clean(value = '') { return String(value || '').normalize('NFC').replace(/\s+/g, ' ').trim(); }

function correctedBusinessQuestion(value = '') {
  const text = clean(value);
  const corrected = text.match(/^(?:不是|不对|不對|不是这个|不是這個)[，,。；;：:\s]*(?:我)?(?:问|問|想问|想問)(?:的)?(?:是)?[：:\s]*(.+)$/i)?.[1];
  return clean(corrected || '');
}
function topicAnchor(recentMessages = []) {
  for (let index = recentMessages.length - 1; index >= 0; index -= 1) {
    const item = recentMessages[index] || {};
    const snapshot = clean(item.knowledge_question_snapshot);
    if (snapshot) return { text: snapshot, sourceMessageId: item.id || null, source: 'knowledge_snapshot' };
    const content = clean(item.content);
    if (content) return { text: content, sourceMessageId: item.id || null, source: 'previous_user_message' };
  }
  return null;
}

function isElliptical(question) {
  const text = clean(question);
  if (!text || TOPIC_SWITCH.test(text)) return false;
  if (ELLIPSIS.test(text)) return true;
  return text.length <= 8 && /(?:呢|吗|么|如何|怎么|在哪|多少|几点)/.test(text) && !EXPLICIT_TOPIC.test(text);
}
function contextualQuestion(question, anchor) {
  const text = clean(question).replace(/^(?:那|那么|这个|那个)\s*/, '');
  return anchor ? `${anchor.text}；用户追问：${text}` : text;
}
async function matchQuestion({ question, platformCode, searchOptions, taskId, minimumConfidence, anchor }) {
  // 省略式追问在存在有效上下文时直接做一次上下文匹配，
  // 不再先执行一次注定缺信息的直接匹配，避免同一问题串行调用两次 AI。
  const contextUsed = Boolean(anchor && isElliptical(question));
  const resolvedQuestion = contextUsed ? contextualQuestion(question, anchor) : question;
  const candidates = searchKnowledge(resolvedQuestion, 10, platformCode, searchOptions);
  const result = await selectKnowledgeForReply({
    userMessage: resolvedQuestion,
    candidates,
    taskId: `${taskId}:${contextUsed ? 'context' : 'direct'}`,
    minimumConfidence
  });
  const confidence = Number(result.confidence || 0);
  const candidateKnowledge = result.knowledge || candidates[0] || null;
  const matched = Boolean(result.matched && result.knowledge && confidence >= minimumConfidence);
  return {
    question,
    resolvedQuestion,
    contextUsed,
    contextAnchor: contextUsed ? anchor : null,
    matchMethod: contextUsed ? `context:${result.model || (matched ? 'semantic' : 'unmatched')}` : (result.model || (matched ? 'direct' : 'unmatched')),
    candidateKnowledge,
    candidates,
    ...result,
    matched,
    knowledge: matched ? result.knowledge : null,
    confidence
  };
}
export function analyzeContextNeed(currentMessage, recentMessages = [], fallbackAnchor = null) {
  const text = clean(currentMessage);
  const topicSwitched = TOPIC_SWITCH.test(text);
  const anchor = topicSwitched ? null : (topicAnchor(recentMessages) || fallbackAnchor);
  return { topicSwitched, elliptical: !topicSwitched && isElliptical(text), anchor };
}

export async function evaluateReply({ message, platformCode, messageType = 'PRIVATE_MESSAGE', recentMessages = [], searchOptions = {}, taskId = null, minimumConfidence = 0.58, script = 'auto', maxGuidanceAttempts = BUSINESS_GUIDANCE_MAX_ATTEMPTS, guidanceAttemptOverride = null, pendingIntent = null, composeReplyFn = composeReply, composeMultiReplyFn = composeMultiReply, composeSmallTalkReplyFn = composeSmallTalkReply } = {}) {
  const startedAt = Date.now();
  const content = clean(message?.content ?? message);
  const normalizedMessageType = String(messageType).toUpperCase();
  const replyPolicy = getReplyLimit(platformCode, messageType);
  const maxLength = replyPolicy?.safeMax || 500;
  const replyBodyMaxLength = maxLength;
  const greeting = detectGreetingIntent(content);
  const pendingCandidateQuestion = clean(pendingIntent?.candidateQuestion || '');
  const pendingAffirmed = Boolean(pendingCandidateQuestion) && isAffirmativeReply(content);
  const pendingDenied = Boolean(pendingCandidateQuestion) && isNegativeReply(content);
  const correctedQuestion = correctedBusinessQuestion(content);
  const smallTalk = detectSmallTalkIntent(content);
  const safeMaxGuidanceAttempts = Math.max(1, Number(maxGuidanceAttempts) || BUSINESS_GUIDANCE_MAX_ATTEMPTS);
  const guidanceAttempt = Math.min(safeMaxGuidanceAttempts, guidanceAttemptOverride == null ? consecutiveBusinessGuidanceAttempts(recentMessages) + 1 : Math.max(1, Number(guidanceAttemptOverride) || 1));
  const isPrivateMessage = normalizedMessageType === 'PRIVATE_MESSAGE';
  const isComment = normalizedMessageType === 'COMMENT';
  // “对/不是”有待确认意图时必须先承接上一轮；“不是，我问的是……”属于业务纠正，不走闲聊。
  if (!isComment && smallTalk.smallTalkOnly && !pendingAffirmed && !pendingDenied && !correctedQuestion) {
    const smallTalkMaxLength = Math.min(replyBodyMaxLength, String(messageType).toUpperCase() === 'COMMENT' ? 80 : 120);
    let generated;
    try {
      generated = await composeSmallTalkReplyFn({
        userMessage: content,
        category: smallTalk.category,
        taskId,
        maxLength: smallTalkMaxLength,
        platformCode,
        messageType,
        recentContext: smallTalkConversationContext(recentMessages),
        script,
        guidanceAttempt,
        maxGuidanceAttempts: safeMaxGuidanceAttempts
      });
    } catch (error) {
      generated = {
        text: smallTalkFallbackReply(smallTalk.category, { messageType, script, attempt: guidanceAttempt, maxAttempts: safeMaxGuidanceAttempts }),
        businessDetected: false,
        model: `smalltalk-safe-fallback:${error?.name === 'AbortError' ? 'AI_TIMEOUT' : 'AI_UNAVAILABLE'}`
      };
    }
    if (!generated.businessDetected) {
      let replyText = clean(generated.text);
      if (!replyText || !isBusinessGuidingReply(replyText) || (isPrivateMessage && guidanceAttempt >= safeMaxGuidanceAttempts && !/(?:转人工|轉人工)/.test(replyText))) {
        replyText = smallTalkFallbackReply(smallTalk.category, { messageType, script, attempt: guidanceAttempt, maxAttempts: safeMaxGuidanceAttempts });
      }
      if (!replyText) throw new Error('闲聊回复为空');
      if ([...replyText].length > smallTalkMaxLength) throw new Error(`闲聊回复超过当前场景上限 ${smallTalkMaxLength} 个字符`);
      replyText = ensureNaturalReplyGreeting(replyText);
      return { decision: 'SMALL_TALK', replyText, confidence: 1, reason: `业务意图引导 ${guidanceAttempt}/${safeMaxGuidanceAttempts}：${smallTalk.category} / ${generated.model}`, matches: [], unknownQuestions: [], bestKnowledge: null, responseMode: 'BUSINESS_GUIDANCE', contextUsed: smallTalkConversationContext(recentMessages).length > 0, resolvedQuestions: [], topicSwitched: false, matchMethod: `smalltalk:${smallTalk.category}`, guidanceAttempt, maxGuidanceAttempts: safeMaxGuidanceAttempts, handoffOffered: isPrivateMessage && guidanceAttempt >= safeMaxGuidanceAttempts, elapsedMs: Date.now() - startedAt };
    }
  }
  // “是的/不是”只在会话存在待确认意图时有特殊含义；带明确纠正内容时优先使用用户纠正后的问题。
  const effective = pendingAffirmed ? pendingCandidateQuestion : (correctedQuestion || greeting.effectiveQuestion || content);
  const split = splitUserQuestions(effective);
  const questions = split.questions.length ? split.questions : [effective];
  const businessRecentMessages = businessConversationContext(recentMessages);
  const sourceAnchor = commentSourceTopicAnchor(message, normalizedMessageType);
  const contextState = analyzeContextNeed(effective, businessRecentMessages, sourceAnchor);
  const matches = [];
  const unknownQuestions = [];
  const diagnostics = [];
  for (let index = 0; index < questions.length; index += 1) {
    const item = await matchQuestion({ question: questions[index], platformCode, searchOptions, taskId: `${taskId || 'reply'}:${index + 1}`, minimumConfidence, anchor: contextState.anchor });
    diagnostics.push(item);
    if (item.matched && item.knowledge) matches.push(item);
    else unknownQuestions.push(item.question);
  }
  const bestMatch = matches.slice().sort((a, b) => b.confidence - a.confidence)[0] || null;
  if (isComment && unknownQuestions.length) {
    return {
      action: 'HANDOFF', decision: 'COMMENT_KNOWLEDGE_GAP', replyText: null, confidence: 0,
      reason: `评论知识库未提供完整可靠答案，直接转人工：${unknownQuestions.join('；')}`,
      matches, unknownQuestions, bestKnowledge: bestMatch?.knowledge || null, responseMode: 'COMMENT_HANDOFF',
      contextUsed: diagnostics.some(item => item.contextUsed), resolvedQuestions: diagnostics.map(item => item.resolvedQuestion),
      topicSwitched: contextState.topicSwitched, matchMethod: diagnostics.map(item => item.matchMethod).join(','),
      diagnostics, elapsedMs: Date.now() - startedAt, truncated: split.truncated,
      guidanceAttempt: 0, maxGuidanceAttempts: safeMaxGuidanceAttempts, handoffOffered: false
    };
  }
  if (!bestMatch) {
    let clarification = null;
    if (isPrivateMessage && !pendingDenied && guidanceAttempt < safeMaxGuidanceAttempts) {
      const candidateSource = diagnostics.find(item => item.candidates?.length)?.candidates || [];
      clarification = await suggestKnowledgeClarification({ userMessage: effective, candidates: candidateSource, taskId: `${taskId}:clarification`, platformCode, messageType, script });
    }
    const clarificationText = clarification?.candidateQuestion
      ? clarificationQuestion(clarification.candidateQuestion, { script })
      : pendingDenied
        ? (script === 'traditional' ? '明白，那您想問的是哪方面？' : '明白，那你想问的是哪方面？')
        : knowledgeGapReply(unknownQuestions[0] || effective || content, { messageType: normalizedMessageType, script, attempt: guidanceAttempt, maxAttempts: safeMaxGuidanceAttempts, sourceTopic: sourceAnchor?.text || '' });
    return {
      decision: 'KNOWLEDGE_GAP_GUIDANCE',
      replyText: ensureNaturalReplyGreeting(clarificationText),
      confidence: 0,
      reason: '没有可靠知识答案',
      matches: [],
      unknownQuestions,
      bestKnowledge: null,
      responseMode: 'BUSINESS_CLARIFICATION',
      contextUsed: diagnostics.some(item => item.contextUsed),
      resolvedQuestions: diagnostics.map(item => item.resolvedQuestion),
      topicSwitched: contextState.topicSwitched,
      matchMethod: diagnostics.map(item => item.matchMethod).join(','),
      diagnostics,
      elapsedMs: Date.now() - startedAt,
      truncated: split.truncated,
      guidanceAttempt,
      maxGuidanceAttempts: safeMaxGuidanceAttempts,
      handoffOffered: isPrivateMessage && guidanceAttempt >= safeMaxGuidanceAttempts, clarificationCandidate: clarification ? { knowledgeId: clarification.candidateKnowledgeId, candidateQuestion: clarification.candidateQuestion, confidence: clarification.confidence, model: clarification.model } : null, clarificationDenied: pendingDenied, clarificationConfirmed: pendingAffirmed
    };
  }
  let replyText;
  let generatedModel;
  if (matches.length === 1 && !unknownQuestions.length) {
    let generated;
    try {
      generated = await composeReplyFn({ userMessage: bestMatch.resolvedQuestion, knowledge: bestMatch.knowledge, taskId, maxLength: replyBodyMaxLength, platformCode, messageType, recentContext: businessRecentMessages, script });
    } catch (error) {
      // 千问超时或临时不可用时，仍可安全返回知识库原答案，避免整条消息变成服务器错误。
      // 该兜底不扩写任何事实，后续仍会经过与正式回复相同的完整性和长度校验。
      generated = {
        text: composeGroundedMockReply(bestMatch.knowledge.answer, replyBodyMaxLength),
        model: `grounded-safe-fallback:${error?.name === 'AbortError' ? 'AI_TIMEOUT' : 'AI_UNAVAILABLE'}`
      };
    }
    const validation = validateReply(generated.text, bestMatch.knowledge.answer, { maxLength: replyBodyMaxLength, groundingVerified: generated.groundingVerified === true });
    if (!validation.ok) throw new Error(validation.reason);
    replyText = ensureNaturalReplyGreeting(generated.text);
    generatedModel = generated.model;
  } else {
    const unknownGuidance = unknownQuestions.length
      ? [knowledgeGapReply(unknownQuestions[0], { messageType: normalizedMessageType, script, attempt: guidanceAttempt, maxAttempts: safeMaxGuidanceAttempts, sourceTopic: sourceAnchor?.text || '' })]
      : [];
    let generated;
    try {
      generated = await composeMultiReplyFn({
        // 用户只回复“对的”时，必须把恢复后的完整候选问题交给多问题回复器，
        // 不能把确认词本身当成新的业务问题。
        userMessage: effective,
        matches,
        unknownQuestions,
        unknownGuidance,
        taskId,
        maxLength: replyBodyMaxLength,
        platformCode,
        messageType,
        recentContext: businessRecentMessages,
        script
      });
      const validation = validateMultiReply(generated.text, matches.map(item => item.knowledge.answer), { maxLength: replyBodyMaxLength, requiredParts: unknownGuidance, groundingVerified: generated.groundingVerified === true });
      if (!validation.ok) throw new Error(validation.reason);
    } catch (error) {
      generated = {
        text: composeGroundedMultiReply(matches, unknownQuestions, { messageType: normalizedMessageType, script, attempt: guidanceAttempt, maxAttempts: safeMaxGuidanceAttempts, sourceTopic: sourceAnchor?.text || '' }),
        model: `grounded-multi-safe-fallback:${error?.name === 'AbortError' ? 'AI_TIMEOUT' : 'AI_UNAVAILABLE'}`
      };
      const validation = validateMultiReply(generated.text, matches.map(item => item.knowledge.answer), { maxLength: replyBodyMaxLength, requiredParts: unknownGuidance });
      if (!validation.ok) throw new Error(validation.reason);
    }
    replyText = ensureNaturalReplyGreeting(generated.text);
    generatedModel = generated.model;
  }
  const averageConfidence = matches.reduce((sum, item) => sum + item.confidence, 0) / matches.length;
  return { decision: unknownQuestions.length ? 'AUTO_REPLY_PARTIAL_KNOWLEDGE' : 'AUTO_REPLY', replyText, confidence: averageConfidence, reason: `命中知识：${matches.map(item => `#${item.knowledge.id}`).join(',')} / ${generatedModel}${unknownQuestions.length ? ` / ${unknownQuestions.length}个问题待确认` : ''}`, matches, unknownQuestions, bestKnowledge: bestMatch.knowledge, responseMode: matches.length > 1 || unknownQuestions.length ? 'MULTI_QUESTION' : 'SINGLE_KNOWLEDGE', contextUsed: diagnostics.some(item => item.contextUsed), resolvedQuestions: diagnostics.map(item => item.resolvedQuestion), topicSwitched: contextState.topicSwitched, matchMethod: diagnostics.map(item => item.matchMethod).join(','), diagnostics, guidanceAttempt: unknownQuestions.length ? guidanceAttempt : 0, maxGuidanceAttempts: safeMaxGuidanceAttempts, handoffOffered: isPrivateMessage && unknownQuestions.length > 0 && guidanceAttempt >= safeMaxGuidanceAttempts, clarificationConfirmed: pendingAffirmed, clarificationDenied: pendingDenied, elapsedMs: Date.now() - startedAt, truncated: split.truncated };
}

