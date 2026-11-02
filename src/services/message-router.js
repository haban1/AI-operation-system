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
  const handoffCommand = messageType === 'PRIVATE_MESSAGE' ? detectManualHandoffCommand(content, { customPhrases: customHandoffPhrases }) : null;
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
      THANKS: '不客气，能帮上忙就好！',
      PRAISE: '谢谢你的认可！',
      ACKNOWLEDGEMENT: '好呀，感谢你的留言！',
      GREETING: '你好呀，很高兴见到你！',
      FAREWELL: '下次见呀！',
      APOLOGY: '没关系呀！',
      LAUGHTER: '哈哈，开心就好！'
    };
    // Douyin renders these positive reactions as text tokens after images load.
    const socialContent = content.replace(/\[(?:666|赞|强|鼓掌|比心|爱心|抱拳)\]/gu, '').trim();
    const intent = detectSmallTalkIntent(socialContent);
    // Exact social expressions only; mixed questions still require grounded RAG.
    const learned = /^(?:学到了|学到啦|学到了新知识|涨知识了|长知识了|受教了|受益匪浅)[!！。,.，～~\s]*$/u.test(socialContent);
    const replyText = learned ? '能对你有帮助就好！' : intent.smallTalkOnly ? socialReplies[intent.category] : null;
    if (replyText) return {
      route: MESSAGE_ROUTE.DIRECT_REPLY, reasonCode: 'COMMENT_SOCIAL_REPLY',
      reason: '纯互动评论自动自然回应，无需查询业务知识库', riskLevel: 'LOW',
      allowRag: false, allowAutoReply: true, replyText
    };
  }
  if (messageType !== 'COMMENT' && (isGreetingOnlyMessage(content) || detectSmallTalkIntent(content).category === 'THANKS')) {
    return {
      route: MESSAGE_ROUTE.DIRECT_REPLY,
      reasonCode: 'SIMPLE_GREETING',
      reason: '简单招呼无需查询知识库',
      riskLevel: 'LOW',
      allowRag: false,
      allowAutoReply: true,
      replyText: '您好，请问您想了解哪方面的内容？'
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
