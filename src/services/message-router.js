import { detectRisk } from './decision.js';
import { automationDisabledForHandlingMode } from './operation-state.js';
import { detectManualHandoffCommand, detectSmallTalkIntent, isGreetingOnlyMessage } from './conversation-intent.js';

export const MESSAGE_ROUTE = Object.freeze({
  RAG_QUERY: 'RAG_QUERY',
  DIRECT_REPLY: 'DIRECT_REPLY',
  HUMAN_HANDOFF: 'HUMAN_HANDOFF',
  IGNORE: 'IGNORE'
});

const abuseRules = [
  ['THREAT', /(?:弄死|杀了|砍死|炸掉|报复|威胁|人肉|开盒)/i],
  ['ABUSE', /(?:傻[逼比]|垃圾客服|废物|妈的|去死|滚蛋|操你|草你)/i],
  ['MALICIOUS_SPAM', /(?:刷单|代开(?:发票|票)|博彩|赌场|裸聊|加群返利|高额返现)/i]
];

export function detectMaliciousMessage(content) {
  const text = String(content || '').trim();
  for (const [code, pattern] of abuseRules) {
    if (pattern.test(text)) return { malicious: true, code, reason: `命中恶意消息规则：${code}` };
  }
  return { malicious: false, code: null, reason: null };
}

export function routeIncomingMessage({ message = {}, conversation = null, sourceAssessment = null, customHandoffPhrases = [] } = {}) {
  const messageType = String(message.message_type || message.messageType || '').trim().toUpperCase();
  const content = String(message.content || '').trim();
  if (automationDisabledForHandlingMode(conversation?.handling_mode, conversation?.human_followup_state)) {
    return { route: MESSAGE_ROUTE.HUMAN_HANDOFF, reasonCode: 'EXISTING_HUMAN_CONVERSATION', reason: conversation?.handoff_reason || '该会话已进入人工处理流程', riskLevel: 'HIGH', allowRag: false, allowAutoReply: false };
  }
  if (sourceAssessment?.isOfficial === true && sourceAssessment?.confidence === 'HIGH') {
    return { route: MESSAGE_ROUTE.IGNORE, reasonCode: 'OFFICIAL_OR_SELF_MESSAGE', reason: '平台官方或账号自身消息不参与自动回复', riskLevel: 'LOW', allowRag: false, allowAutoReply: false };
  }
  if (!content) {
    return { route: MESSAGE_ROUTE.IGNORE, reasonCode: 'EMPTY_MESSAGE', reason: '空消息不进入 RAG', riskLevel: 'LOW', allowRag: false, allowAutoReply: false };
  }
  const handoffCommand = ['PRIVATE_MESSAGE', 'COMMENT'].includes(messageType)
    ? detectManualHandoffCommand(messageType === 'COMMENT' ? content.replaceAll('轉', '转') : content, { customPhrases: messageType === 'PRIVATE_MESSAGE' ? customHandoffPhrases : [] }) : null;
  if (handoffCommand?.matched) {
    return { route: MESSAGE_ROUTE.HUMAN_HANDOFF, reasonCode: handoffCommand.reason, reason: '用户明确要求转人工', handoffCommand, riskLevel: 'HIGH', allowRag: false, allowAutoReply: false };
  }
  const malicious = detectMaliciousMessage(content);
  if (malicious.malicious) {
    return { route: MESSAGE_ROUTE.HUMAN_HANDOFF, reasonCode: malicious.code, reason: malicious.reason, riskLevel: 'HIGH', allowRag: false, allowAutoReply: false };
  }
  const risk = detectRisk(content);
  if (risk.risk) {
    return { route: MESSAGE_ROUTE.HUMAN_HANDOFF, reasonCode: risk.code, reason: risk.reason, riskLevel: 'HIGH', allowRag: false, allowAutoReply: false };
  }
  if (messageType === 'COMMENT' && (message.platform_code || message.platformCode) === 'douyin') {
    const socialReplies = {
      THANKS: '不客气，能帮上忙就好。',
      PRAISE: '谢谢，喜欢就好。',
      ACKNOWLEDGEMENT: '好，收到。',
      GREETING: '你好，想了解什么？',
      FAREWELL: '下次聊。',
      APOLOGY: '没事，不用客气。',
      LAUGHTER: '哈哈，开心就好。'
    };
    // Douyin renders these positive reactions as text tokens after images load.
    const socialContent = content.replace(/\[(?:666|赞|强|鼓掌|比心|爱心|抱拳)\]/gu, '').trim();
    const intent = detectSmallTalkIntent(socialContent);
    // Exact social expressions only; mixed questions still require grounded RAG.
    const learned = /^(?:学到了|学到啦|学到了新知识|涨知识了|长知识了|受教了|受益匪浅)[!！。,.，～~\s]*$/u.test(socialContent);
    const replyText = learned ? '有帮助就好。' : intent.smallTalkOnly ? socialReplies[intent.category] : null;
    if (replyText) return {
      route: MESSAGE_ROUTE.DIRECT_REPLY, reasonCode: 'COMMENT_SOCIAL_REPLY',
      reason: '纯互动评论自动自然回应，无需查询业务知识库', riskLevel: 'LOW',
      allowRag: false, allowAutoReply: true, replyText
    };
  }
  const privateSmallTalk = messageType !== 'COMMENT' ? detectSmallTalkIntent(content) : null;
  if (messageType !== 'COMMENT' && (isGreetingOnlyMessage(content) || privateSmallTalk.smallTalkOnly)) {
    const checkingPresence = /^(?:在吗|在不在|有人吗|有人在吗|客服在吗|工作人员在吗)[？?！!。\s]*$/u.test(content);
    const replies = {
      GREETING: checkingPresence ? '在的，想问什么？' : '你好，想了解什么？',
      THANKS: '不客气，有问题再问我。',
      ACKNOWLEDGEMENT: '好。',
      PRAISE: '谢谢，喜欢就好。',
      FAREWELL: '好，有需要再聊。',
      APOLOGY: '没事，不用客气。',
      LAUGHTER: '哈哈。',
      IDENTITY: '我是小智，这里的智能助手。',
      CAPABILITY: '可以帮你查资料、回答问题。你想了解什么？',
      EMOTION: '想聊的话，可以慢慢说。'
    };
    const category = isGreetingOnlyMessage(content) ? 'GREETING' : privateSmallTalk.category;
    return {
      route: MESSAGE_ROUTE.DIRECT_REPLY,
      reasonCode: ['GREETING', 'THANKS'].includes(category) ? 'SIMPLE_GREETING' : 'PRIVATE_SOCIAL_REPLY',
      reason: '纯日常对话无需查询业务知识库',
      riskLevel: 'LOW',
      allowRag: false,
      allowAutoReply: true,
      replyText: replies[category]
    };
  }
  return { route: MESSAGE_ROUTE.RAG_QUERY, reasonCode: 'BUSINESS_QUESTION', reason: '正常业务咨询进入 RAG', riskLevel: 'LOW', allowRag: true, allowAutoReply: true };
}

export function outerRouteReplyResult(route) {
  if (route.route === MESSAGE_ROUTE.RAG_QUERY) return null;
  const handoff = route.route === MESSAGE_ROUTE.HUMAN_HANDOFF;
  return {
    action: handoff ? 'HANDOFF' : route.route === MESSAGE_ROUTE.IGNORE ? 'IGNORE' : 'REPLY',
    decision: route.reasonCode, replyText: route.replyText || null, reason: route.reason,
    confidence: handoff ? 0 : 1, responseMode: 'ROUTER_STATIC', matchMethod: 'OUTER_ROUTER',
    guidanceAttempt: 0, handoffOffered: false, handoffRequested: handoff, ragStatus: 'NOT_QUERIED'
  };
}
