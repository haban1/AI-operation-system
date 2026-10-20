import { BUSINESS_GUIDANCE_MAX_ATTEMPTS } from './conversation-policy.js';
export { BUSINESS_GUIDANCE_MAX_ATTEMPTS };

const GREETING_TOKEN = /^(?:你好|您好|你好呀|您好呀|哈喽|嗨|hi|hello|在吗|在不在|有人吗|有人在吗|请问在吗|客服在吗|工作人员在吗|早上好|上午好|中午好|下午好|晚上好|早安|晚安)(?:啊|呀|啦|哟|哦|喔|诶|欸|嘛|哈|呢|呐|咯)*[!！。,.，？?～~\s]*$/i;
const LEADING_GREETING = /^(?:(?:你好呀|您好呀|你好|您好|哈喽|嗨|hi|hello|在吗|在不在|有人吗|有人在吗|请问在吗|客服在吗|工作人员在吗|早上好|上午好|中午好|下午好|晚上好|早安|晚安)(?:啊|呀|啦|哟|哦|喔|诶|欸|嘛|哈|呢|呐|咯)*[!！。,.，？?～~\s]*)+/i;
const HANDOFF_MENTION = '(?:转(?:接|到)?(?:一下|个|一个|一位)?(?:人工|真人|客服)|找(?:一下|个|一个|一位)?(?:人工|客服|工作人员|真人)|接(?:一下|个|一个|一位)?(?:人工|客服|工作人员|真人)|联系(?:一下|个|一个|一位)?(?:人工|客服|工作人员|真人)|人工处理|人工回复|客服处理|真人回复)';
const NEGATED_HANDOFF = new RegExp(`(?:不想|不要|不用|无需|别|不需要|暂时不|先不|取消).{0,8}${HANDOFF_MENTION}`);
const QUOTED_HANDOFF = new RegExp(`(?:输入|说|提示|写着|刚才|你说).{0,12}[“"']?${HANDOFF_MENTION}[”"']?`);
const QUESTION_HANDOFF = new RegExp(`(?:是不是|是否|要不要|需要吗|可以吗|能不能).{0,10}${HANDOFF_MENTION}|${HANDOFF_MENTION}.{0,8}(?:吗|呢|么)(?:[?？])?$`);

const SMALL_TALK_BUSINESS_SIGNAL = /(?:活动|报名|收费|费用|价格|多少钱|地址|地点|时间|几点|什么时候|电话|联系方式|材料|证件|资格|条件|政策|规定|流程|办理|退款|取消|修改|账号|账户|登录|密码|支付|支付宝|微信|银行卡|视频|帖子|评论|私信|转载|授权|发布|审核|社区|志愿者|孩子|小孩|儿童|办公|营业|开放|预约|名额|发票|合同|投诉|售后|订单|物流)/i;
const SMALL_TALK_REALTIME_OR_FACT = /(?:天气|气温|股票|汇率|新闻|热搜|比赛|比分|今天几号|现在几点|总统|市长|政策最新)/i;
const SMALL_TALK_PATTERNS = Object.freeze([
  ['GREETING', /^(?:(?:你好|您好|哈喽|嗨|hi|hello|在吗|在不在|有人吗|有人在吗|请问在吗|客服在吗|工作人员在吗|早上好|上午好|中午好|下午好|晚上好|早安|晚安|你好呀|您好呀)(?:啊|呀|啦|哟|哦|喔|诶|欸|嘛|哈|呢|呐|咯)*[!！。,.，？?～~\s]*)+$/i],
  ['THANKS', /^(?:谢谢|多谢|感谢|谢啦|谢谢你|谢谢您|辛苦了|麻烦你了|麻烦您了|好的谢谢|好嘞谢谢|收到谢谢|thank you|thanks)[!！。,.，～~\s]*$/i],
  ['ACKNOWLEDGEMENT', /^(?:好的|好嘞|好呀|好吧|行|可以|知道了|明白了|了解了|收到|嗯|嗯嗯|哦|哦哦|没问题|不客气|没事了)[!！。,.，～~\s]*$/i],
  ['FAREWELL', /^(?:再见|拜拜|bye|下次见|回头见|先这样|不聊了|我先走了|晚安啦)[!！。,.，～~\s]*$/i],
  ['APOLOGY', /^(?:不好意思|抱歉|对不起|打扰了|不好意思打扰了)[!！。,.，～~\s]*$/i],
  ['PRAISE', /^(?:不错|很好|真好|可以的|挺好的|厉害|真棒|太棒了|你真好|你真厉害|服务不错|回复得不错)[!！。,.，～~\s]*$/i],
  ['LAUGHTER', /^(?:哈+|哈哈+|呵呵+|嘿嘿+|嘻嘻+|笑死|好玩|有意思|[😀-🙏🌀-🫿❤♥]+)[!！。,.，～~\s]*$/iu],
  ['IDENTITY', /^(?:你是谁|你叫什么|你叫什么名字|你的名字是什么|怎么称呼你|你是机器人吗|你是人工智能吗|你是真人吗|你是客服吗)[!！。,.，？?～~\s]*$/i],
  ['CAPABILITY', /^(?:你能做什么|你会做什么|你可以做什么|能陪我聊聊吗|可以陪我聊天吗|陪我聊会儿|聊聊天吧|说句话|你在干嘛|你忙吗)[!！。,.，？?～~\s]*$/i],
  ['EMOTION', /^(?:我(?:今天)?心情(?:不太)?好|我(?:今天)?心情不好|我有点难过|我有点开心|我好无聊|有点无聊|我累了|今天好累|烦死了|好烦啊|开心|难过)[!！。,.，～~\s]*$/i]
]);

export function normalizeConversationText(value = '') {
  return String(value || '').normalize('NFC').replace(/\s+/g, ' ').trim();
}

export function normalizeManualHandoffPhrase(value = '') {
  return normalizeConversationText(value)
    .toLocaleLowerCase('zh-CN')
    .replace(/[\s，,。.!！?？、；;:：~～“”"'‘’（）()【】\[\]]+/gu, '');
}

export function detectGreetingIntent(value = '') {
  const text = normalizeConversationText(value);
  if (!text) return { greetingOnly: false, effectiveQuestion: '' };
  if (GREETING_TOKEN.test(text)) return { greetingOnly: true, effectiveQuestion: '' };
  const effectiveQuestion = text.replace(LEADING_GREETING, '').trim();
  return { greetingOnly: false, effectiveQuestion: effectiveQuestion || text };
}

function stripCasualToneSuffix(value = '') {
  return normalizeConversationText(value)
    .replace(/[!！。,.，？?～~\s]+$/gu, '')
    .replace(/(?:啊|呀|啦|哟|哦|喔|诶|欸|嘛|呢|呐|咯){1,3}$/gu, '')
    .replace(/[!！。,.，？?～~\s]+$/gu, '')
    .trim();
}

export function detectSmallTalkIntent(value = '') {
  const text = normalizeConversationText(value);
  if (!text) return { smallTalkOnly: false, category: null, reason: 'EMPTY_MESSAGE' };
  if (SMALL_TALK_BUSINESS_SIGNAL.test(text)) return { smallTalkOnly: false, category: 'BUSINESS', reason: 'BUSINESS_SIGNAL_PRESENT' };
  if (SMALL_TALK_REALTIME_OR_FACT.test(text)) return { smallTalkOnly: false, category: 'UNCERTAIN_BUSINESS', reason: 'REALTIME_OR_FACT_REQUEST' };
  const toneNeutralText = stripCasualToneSuffix(text);
  for (const [category, pattern] of SMALL_TALK_PATTERNS) {
    if (pattern.test(text) || (toneNeutralText !== text && pattern.test(toneNeutralText))) {
      return { smallTalkOnly: true, category, reason: `PURE_${category}` };
    }
  }
  return { smallTalkOnly: false, category: 'UNCERTAIN_BUSINESS', reason: 'NOT_EXPLICIT_SMALL_TALK' };
}

/**
 * 只包含问候、没有业务问题的消息。
 *
 * 这里不能只依赖 detectGreetingIntent：用户常会连续说“哈喽，你好呀”，
 * 中间带逗号时虽然仍然是纯问候，但不一定能被单个问候词正则覆盖。
 * 纯问候只会走固定的业务引导话术，不读取历史业务上下文，也不会主动创建人工转接。
 */
export function isGreetingOnlyMessage(value = '') {
  const greeting = detectGreetingIntent(value);
  if (greeting.greetingOnly) return true;
  const smallTalk = detectSmallTalkIntent(value);
  return smallTalk.smallTalkOnly === true && smallTalk.category === 'GREETING';
}

function normalizedAttempt(value, maxAttempts = BUSINESS_GUIDANCE_MAX_ATTEMPTS) {
  const safeMax = Math.max(1, Number(maxAttempts) || BUSINESS_GUIDANCE_MAX_ATTEMPTS);
  return Math.max(1, Math.min(safeMax, Number(value) || 1));
}

export function businessGuidanceEscalationReply({ messageType = 'PRIVATE_MESSAGE', script = 'auto' } = {}) {
  if (String(messageType).toUpperCase() === 'COMMENT') return COMMENT_KNOWLEDGE_GAP_REPLY;
  return script === 'traditional'
    ? '我已嘗試進一步確認，但仍未能定位到具體業務。您可以補充業務名稱和具體問題；如需工作人員協助，請回覆「轉人工」。'
    : '我已经尝试进一步确认，但仍未能定位到具体业务。您可以补充业务名称和具体问题；如需工作人员协助，请回复“转人工”。';
}

export function smallTalkFallbackReply(category = 'CASUAL_CHAT', { messageType = 'PRIVATE_MESSAGE', script = 'auto', attempt = 1, maxAttempts = BUSINESS_GUIDANCE_MAX_ATTEMPTS } = {}) {
  const traditional = script === 'traditional';
  const currentAttempt = normalizedAttempt(attempt, maxAttempts);
  if (String(messageType).toUpperCase() !== 'COMMENT' && currentAttempt >= Math.max(1, Number(maxAttempts) || BUSINESS_GUIDANCE_MAX_ATTEMPTS)) {
    return businessGuidanceEscalationReply({ messageType, script });
  }
  const replies = traditional ? {
    GREETING: '您好，想了解什麼？活動、報名這些都可以直接問。',
    THANKS: '不客氣，有活動或辦理方面的問題再問我就好。',
    ACKNOWLEDGEMENT: '好，有其他活動或辦理問題也可以接著問。',
    FAREWELL: '好，有需要再找我。',
    APOLOGY: '沒關係，您直接說想問什麼就行。',
    PRAISE: '謝謝，有其他業務問題也可以繼續問。',
    LAUGHTER: '哈哈，想問活動、報名或辦理方面的事都可以直接說。',
    IDENTITY: '我是小智，平時幫大家查活動、報名和辦理信息。您直接說想問什麼就行。',
    CAPABILITY: '我可以幫您查活動、報名、時間地點、費用和辦理材料。您想問哪件事？',
    EMOTION: '辛苦了。如果有活動或辦理方面的事情需要確認，您直接告訴我。'
  } : {
    GREETING: '你好呀，想了解什么？活动、报名这些都可以直接问。',
    THANKS: '不客气，有活动或办理方面的问题再问我就好。',
    ACKNOWLEDGEMENT: '好，有其他活动或办理问题也可以接着问。',
    FAREWELL: '好，有需要再找我。',
    APOLOGY: '没关系，你直接说想问什么就行。',
    PRAISE: '谢谢，有其他业务问题也可以继续问。',
    LAUGHTER: '哈哈，想问活动、报名或办理方面的事都可以直接说。',
    IDENTITY: '我是小智，平时帮大家查活动、报名和办理信息。你直接说想问什么就行。',
    CAPABILITY: '我可以帮你查活动、报名、时间地点、费用和办理材料。你想问哪件事？',
    EMOTION: '辛苦了。如果有活动或办理方面的事情需要确认，你直接告诉我。'
  };
  if (String(messageType).toUpperCase() !== 'COMMENT') return replies[category] || replies.GREETING;
  const comments = traditional ? {
    THANKS: '不客氣，有業務問題可以私訊告訴我。',
    FAREWELL: '好的，有業務問題可以再私訊告訴我。'
  } : {
    THANKS: '不客气，有业务问题可以私信告诉我。',
    FAREWELL: '好的，有业务问题可以再私信告诉我。'
  };
  return comments[category] || (traditional ? '您好，想問哪方面？也可以直接私訊告訴我。' : '你好呀，想问哪方面？也可以直接私信告诉我。');
}

export function detectManualHandoffCommand(value = '', options = {}) {
  const text = normalizeConversationText(value);
  if (!text) return { matched: false, command: null, reason: 'NOT_EXPLICIT_HANDOFF' };
  const compact = normalizeManualHandoffPhrase(text);
  const customPhrases = Array.isArray(options) ? options : (Array.isArray(options?.customPhrases) ? options.customPhrases : []);
  const customMatched = customPhrases.some(item => {
    if (item && typeof item === 'object' && String(item.status || 'ENABLED').toUpperCase() === 'DISABLED') return false;
    const candidate = item && typeof item === 'object' ? (item.normalized_phrase || item.phrase || '') : item;
    return Boolean(candidate) && normalizeManualHandoffPhrase(candidate) === compact;
  });
  if (customMatched) return { matched: true, command: '转人工', reason: 'EXPLICIT_CUSTOM_HANDOFF_PHRASE' };
  if (NEGATED_HANDOFF.test(text) || QUOTED_HANDOFF.test(text) || QUESTION_HANDOFF.test(text)) {
    return { matched: false, command: null, reason: 'NOT_EXPLICIT_HANDOFF' };
  }
  const politePrefix = '(?:(?:那|那就|那麻烦|好的|好吧|行吧|行|可以|你|请|麻烦|帮我|请帮我|我要|我想|需要|给我|替我)){0,4}';
  const handoffAction = '(?:转(?:接|到)?(?:一下|个|一个|一位)?(?:人工|真人|客服)(?:处理|回复|服务)?|找(?:一下|个|一个|一位)?(?:人工|客服|工作人员|真人)|接(?:一下|个|一个|一位)?(?:人工|客服|工作人员|真人)|联系(?:一下|个|一个|一位)?(?:人工|客服|工作人员|真人)|人工处理|人工回复|客服处理|真人回复)';
  const politeSuffix = '(?:吧|啊|呀|啦|谢谢|麻烦了)?';
  const matched = new RegExp(`^${politePrefix}${handoffAction}${politeSuffix}$`).test(compact);
  return { matched, command: matched ? '转人工' : null, reason: matched ? 'EXPLICIT_HANDOFF_COMMAND' : 'NOT_EXPLICIT_HANDOFF' };
}

export function isExplicitHumanRequest(value = '') {
  return detectManualHandoffCommand(value).matched;
}

function cleanQuestionPart(value = '') {
  return normalizeConversationText(value)
    .replace(/^(?:另外|还有|然后|顺便|再问一下|我还想问|请问|想问一下|麻烦问下)[，,:：\s]*/i, '')
    .replace(/[。.!！?？；;，,\s]+$/g, '')
    .trim();
}

export function splitUserQuestions(value = '', { maxQuestions = 8 } = {}) {
  const greeting = detectGreetingIntent(value);
  const source = greeting.effectiveQuestion || normalizeConversationText(value);
  if (!source) return { questions: [], truncated: false, source };
  let parts = source
    .replace(/(?:另外|还有|然后|顺便问一下|我还想问|再问一下)/g, '\n')
    .split(/[\n\r；;。！？!?]+/)
    .map(cleanQuestionPart)
    .filter(Boolean);
  if (parts.length <= 1 && /[，,、]/.test(source)) {
    const commaParts = source.split(/[，,、]+/).map(cleanQuestionPart).filter(part => part.length >= 2);
    const questionLikeCount = commaParts.filter(part => /(?:吗|么|呢|什么|多少|怎么|如何|哪里|在哪|何时|什么时候|几点|是否|能否|可不可以|行不行|要不要|需要|能带|可以带|可不可以带|能不能带|是否可以带)/.test(part)).length;
    const sharedActivityReference = /(?:视频|影片|帖子|內容|内容|這條|这条|這個|这个|那個|那个).{0,12}(?:活動|活动|課程|课程|講座|讲座|比賽|比赛)/.test(source);
    const asksActivityAndRegistration = /(?:幹什麼|干什么|做什麼|做什么|什麼內容|什么内容).{0,30}(?:怎麼|怎么|如何).{0,12}(?:報名|报名|參加|参加)/.test(source);
    // 共享同一个尚未明确的业务对象时保持完整，避免拆出“这个活动”并重复追问。
    if (commaParts.length >= 2 && questionLikeCount >= 2 && !(sharedActivityReference && asksActivityAndRegistration)) parts = commaParts;
  }
  const unique = [];
  const seen = new Set();
  for (const part of parts) {
    const key = part.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
    if (!key || seen.has(key)) continue;
    seen.add(key);
    unique.push(part);
  }
  return { questions: unique.slice(0, maxQuestions), truncated: unique.length > maxQuestions, source };
}

export function isAffirmativeReply(value = '') {
  const text = normalizeConversationText(value).replace(/[!！。,.，？?～~\s]+$/gu, '');
  return /^(?:是的|是|对的|對的|对|對|没错|沒錯|没问题|沒問題|嗯是的|嗯对|嗯對|就是|没错就是|是这个|是這個|对就是这个|對就是這個)$/i.test(text);
}

export function isNegativeReply(value = '') {
  const text = normalizeConversationText(value).replace(/[!！。,.，？?～~\s]+$/gu, '');
  return /^(?:不是|不对|不對|不是这个|不是這個|不对的|不對的|不是这个问题|不是這個問題|不|否|错了|錯了|不是这样|不是這樣)$/i.test(text);
}

export function isWaitingAcknowledgement(value = '') {
  const text = normalizeConversationText(value).replace(/[!！。,.，？?～~\s]+$/gu, '');
  return /^(?:好的|好|好嘞|好呀|好吧|行|可以|嗯|嗯嗯|收到|知道了|明白了|了解了|辛苦了|谢谢|謝謝)[!！。,.，？?～~\s]*$/i.test(text);
}

export function clarificationQuestion(candidateQuestion = '', { script = 'auto' } = {}) {
  const question = cleanQuestionPart(candidateQuestion).replace(/[？?。！!]+$/g, '').trim();
  if (!question) return script === 'traditional' ? '您是想問業務相關的內容嗎？' : '你是想问业务相关的内容吗？';
  if (/(?:資格|资格|條件|条件)/.test(question)) {
    return script === 'traditional' ? '您是想問這個活動需要滿足什麼條件才能參加，對嗎？' : '你是想问这个活动需要满足什么条件才能参加，对吗？';
  }
  if (/(?:帶|带|攜帶|携带).*(?:孩子|小孩|兒童|儿童|小朋友)/.test(question)) {
    return script === 'traditional' ? '您是想問這個活動能不能帶孩子參加，對嗎？' : '你是想问这个活动能不能带孩子参加，对吗？';
  }
  return script === 'traditional'
    ? `您是想問「${question}」，對嗎？`
    : `你是想问“${question}”，对吗？`;
}

export function questionTopic(value = '') {
  let text = cleanQuestionPart(value)
    .replace(/^(?:我想咨询|我想问|想问|请问|麻烦问一下|能问一下)/, '')
    .replace(/(?:可以吗|行吗|行不行|可不可以|能不能|是否可以|能否)[？?]?$/g, '')
    .trim();
  const bringChild = /(?:能|可以|可不可以|能不能|能否|是否能|是否可以)?(?:带|携带)(?:小孩|孩子|儿童|小朋友|宝宝|娃)/.test(value);
  if (bringChild) return '是否可以带孩子';
  if (/^(?:能不能|可不可以|是否可以|能否)/.test(value)) text = `是否可以${cleanQuestionPart(value).replace(/^(?:能不能|可不可以|是否可以|能否)/, '').replace(/[吗么呢]$/,'')}`;
  else if (/可以.*[吗么]$/.test(value)) text = `是否可以${cleanQuestionPart(value).replace(/^.*?可以/, '').replace(/[吗么呢]$/,'')}`;
  text = text.replace(/[吗么呢]$/g, '').trim();
  return text || '您咨询的这个问题';
}

export const COMMENT_KNOWLEDGE_GAP_REPLY = '你想问哪场活动或哪项业务？把名字和想了解的内容告诉我就行。';
export const PRIVATE_KNOWLEDGE_GAP_REPLY = '你想问哪件事？把业务或活动名字发我，再说下你想了解什么就行。';

export const NATURAL_GREETING_PREFIX = '';

const LEADING_REPLY_GREETING = /^(?:(?:你好|您好|哈喽|嗨|hello|hi)(?:啊|呀|啦|哟|哦|喔|诶|欸|嘛|呢|呐|咯)?[!！。,.，：:？?～~\s]*)+/i;

/**
 * 清理历史版本遗留的机械问候前缀；当前回复是否需要问候由具体场景决定。
 */
export function ensureNaturalReplyGreeting(value = '') {
  const text = String(value || '').normalize('NFC').trim();
  if (!text) return text;
  // 不再给每条评论和私信机械添加“你好~，”。需要回应问候时由当前场景自然表达。
  return text.replace(/^你好~，[\s]*/u, '').trim() || text;
}

export function applicationClarificationReply(value = '', { script = 'auto' } = {}) {
  if (!/^(?:请问|請問)?(?:怎么|怎麼|如何|怎样|怎樣)(?:申请|申請|办理|辦理)[？?。！!\s]*$/.test(normalizeConversationText(value))) return null;
  return script === 'traditional'
    ? '請問您想申請哪項業務？把業務名稱發我，我再說明申請流程。'
    : '请问你想申请哪项业务？把业务名称发我，我再说明申请流程。';
}

function clarificationTopic(value = '', traditional = false, { messageType = 'PRIVATE_MESSAGE', sourceTopic = '' } = {}) {
  const text = normalizeConversationText(value);
  const source = normalizeConversationText(sourceTopic);
  const isComment = String(messageType).toUpperCase() === 'COMMENT';
  const topicContext = `${text} ${source}`;
  if (/(?:OPC)/i.test(topicContext) && /(?:公司|企業|企业)/.test(text) && /(?:類型|类型|形式|種類|种类|類別|类别)/.test(text)) {
    return traditional
      ? '您是想問OPC社區支持哪些創業項目，還是想問工商註冊時可以選擇哪些公司類型？'
      : '你是想问OPC社区支持哪些创业项目，还是想问工商注册时可以选择哪些公司类型？';
  }
  if (/(?:OPC)/i.test(source) && /(?:多少錢|多少钱|收費|收费|費用|费用|價格|价格|免費|免费)/.test(text)) {
    return traditional
      ? '您是想問OPC社區的入駐費用，還是某項配套服務的費用？說下具體項目，我再幫您查。'
      : '你是想问OPC社区的入驻费用，还是某项配套服务的费用？说下具体项目，我再帮你查。';
  }
  if (/(?:視頻|视频|影片|帖子).{0,18}(?:活動|活动)/.test(text) && /(?:幹什麼|干什么|做什麼|做什么|內容|内容)/.test(text) && /(?:報名|报名|參加|参加)/.test(text)) {
    return traditional
      ? '您說的是哪條視頻裡的活動？把視頻標題或活動名字發我，我確認一下，再跟您說活動內容和怎麼報名。'
      : '你说的是哪条视频里的活动？把视频标题或者活动名字发我，我确认一下，再跟你说活动内容和怎么报名。';
  }
  if (/(?:带|携带)(?:小孩|孩子|儿童|小朋友|宝宝|娃)|能带|可以带|可不可以带|能不能带/.test(text)) {
    return traditional
      ? '您說的是哪場活動？把活動名字發我，我幫您看看孩子能不能一起去。'
      : '你说的是哪场活动？把活动名字发我，我帮你看看孩子能不能一起去。';
  }
  if (/^(?:什麼|什么)?(?:資格|资格|條件|条件)[？?。！!\s]*$/.test(text) || /(?:活動|活动).{0,10}(?:資格|资格|條件|条件)/.test(text)) {
    return traditional
      ? '您是想問這個活動需要滿足什麼條件才能參加嗎？'
      : '你是想问这个活动需要满足什么条件才能参加吗？';
  }
  if (/(?:想|要).{0,4}(?:報名|报名)/.test(text) && !/(?:哪場|哪场|活動名|活动名|課程名|课程名)/.test(text)) {
    return traditional
      ? '想報名哪場活動？把活動名字發我，我幫您看看報名方式。'
      : '想报名哪场活动？把活动名字发我，我帮你看看报名方式。';
  }
  if (/(?:活动|报名|志愿者|课程|讲座|比赛|参观)/.test(text)) {
    return traditional
      ? '您說的是哪場活動？把活動名字發我，再告訴我想問哪方面。'
      : '你说的是哪场活动？把活动名字发我，再告诉我想问哪方面。';
  }
  const applicationReply = applicationClarificationReply(text, { script: traditional ? 'traditional' : 'simplified' });
  if (applicationReply) return applicationReply;
  if (/(?:辦理|办理|申請|申请|證件|证件|材料|資格|资格|條件|条件|流程|政策)/.test(text)) {
    return traditional
      ? '您想辦理哪項業務？把業務名稱發我，再說下想問條件、材料還是流程。'
      : '你想办理哪项业务？把业务名称发我，再说下想问条件、材料还是流程。';
  }
  if (/(?:帳號|账号|登錄|登录|密碼|密码|支付|退款|訂單|订单|售後|售后)/.test(text)) {
    return traditional
      ? '是哪項帳號、支付、退款或訂單出了問題？把現在的情況告訴我就行。'
      : '是哪项账号、支付、退款或订单出了问题？把现在的情况告诉我就行。';
  }
  if (/^(?:那|那個|那个|這個|这个|這樣|这样|可以嗎|可以吗|怎麼辦|怎么办|怎麼弄|怎么弄|要什麼|要什么|需要什麼|需要什么)[？?。！!\s]*$/.test(text)) {
    return traditional
      ? '您指的是哪項業務或哪場活動？把名字發我就行。'
      : '你指的是哪项业务或哪场活动？把名字发我就行。';
  }
  if (isComment) return traditional
    ? '您想問哪場活動或哪項業務？把名字和想了解的內容告訴我就行。'
    : COMMENT_KNOWLEDGE_GAP_REPLY;
  return traditional
    ? '您想問哪件事？把業務或活動名字發我，再說下想了解什麼就行。'
    : PRIVATE_KNOWLEDGE_GAP_REPLY;
}

export function knowledgeGapReply(value = '', { messageType = 'PRIVATE_MESSAGE', script = 'auto', attempt = 1, maxAttempts = BUSINESS_GUIDANCE_MAX_ATTEMPTS, sourceTopic = '' } = {}) {
  if (String(messageType).toUpperCase() === 'COMMENT') {
    return clarificationTopic(value, script === 'traditional', { messageType, sourceTopic });
  }
  if (normalizedAttempt(attempt, maxAttempts) >= Math.max(1, Number(maxAttempts) || BUSINESS_GUIDANCE_MAX_ATTEMPTS)) {
    return businessGuidanceEscalationReply({ messageType, script });
  }
  return clarificationTopic(value, script === 'traditional', { messageType, sourceTopic });
}

export const GREETING_REPLY = '你好呀，想了解什么？活动、报名这些都可以直接问。';
export const HANDOFF_SUBMITTED_REPLY = '好，我帮你转人工，稍等一下。';
export const HANDOFF_ALREADY_SUBMITTED_REPLY = '人工已经收到你的消息了，稍等一下。';
export const HANDOFF_NOT_FOUND_REPLY = '想转人工的话，直接发“转人工”就行。';
export const HANDOFF_NOTIFY_FAILED_REPLY = '刚才没能成功通知到人工，你稍后再发一次“转人工”，我再帮你提交。';
export const HANDOFF_WAITING_ACK_REPLY = '好，稍等一下。';

function decodeGroundedAnswer(value) {
  return String(value || '')
    .replace(/&#(?:10|x0*a);?/gi, '\n')
    .replace(/&#(?:13|x0*d);?/gi, '\n')
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .trim();
}

export function composeGroundedMultiReply(items = [], unknownQuestions = [], { messageType = 'PRIVATE_MESSAGE', script = 'auto', attempt = 1, maxAttempts = BUSINESS_GUIDANCE_MAX_ATTEMPTS, sourceTopic = '' } = {}) {
  const parts = items
    .filter(item => item?.knowledge?.answer)
    .map(item => decodeGroundedAnswer(item.knowledge.answer))
    .filter(Boolean);
  if (unknownQuestions.length) parts.push(knowledgeGapReply(unknownQuestions[0], { messageType, script, attempt, maxAttempts, sourceTopic }));
  return parts.map((part, index) => index === 0 ? part : `另外，${part}`).join('\n\n').trim();
}

