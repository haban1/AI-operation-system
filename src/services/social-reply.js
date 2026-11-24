// 私信里的社交性消息：问候、夸奖、道谢收尾、发错对象、问身份。
// 这些消息不该进入知识库检索——检索不到时会被当成“知识缺口”，回出“答不准，回我转人工”这种很怪的话。
// 只在消息里没有任何提问信号时生效；夹带真实问题的一律交回正常检索。

const EMOJI = /[\p{Extended_Pictographic}\u{1F3FB}-\u{1F3FF}\u{FE0F}\u{200D}]/gu;
// 颜文字和装饰符号：(๑•̀ㅂ•́)و✧ (≧▽≦) (｡･ω･｡)ﾉ♡ 等。
const KAOMOJI = /[(（][^()（）]{1,14}[)）][^\s，,。!！？?]{0,3}|[✧✨♡♥☆★~～]+/gu;
const QUESTION_SIGNAL = /[？?]|吗|嗎|还是(?!挺|很|蛮|不错|算|有点)|還是(?!挺|很|蠻|不錯|算|有點)|再问|再問|问细|問細|我问的是|我問的是|(?<!已经|已經|会|會)(?:推荐|推薦)(?!给|給)|想请|想請|请你|請你|请您|請您|想找|想要|求推荐|(?<!谢谢|謝謝|多谢|多謝|感谢|感謝|谢谢你的|謝謝你的|谢谢你们的)(?:帮忙|幫忙)|(?<![这那這多怎什甚])[么麼](?=[\s，,。！!～~]|$)|怎么|怎麼|咋|如何|多少|几[个點点号號天时時]|哪|什么|什麼|啥|是否|能不能|可不可以|可以.{0,8}[吗嗎]|有没有|有沒有|会不会|會不會|要不要|是不是|请问|請問|想问|想問|问一下|問一下|问下|問下|问个|問個|咨询|諮詢|确认一下|確認一下|确认下|確認下|帮我|幫我|麻烦你|麻煩你|能否|求助|告诉我|告訴我|介绍一下|介紹一下|\b(?:what|how|when|where|which|why|can|could|do|does|is|are|will)\b/iu;
// 投诉、不满不能当成社交消息一笔带过。
const NEGATIVE_SIGNAL = /差评|差評|失望|生气|生氣|垃圾|骗|騙|退款|退費|退费|投诉|投訴|不满|不滿|坑|太慢|没人理|沒人理/u;

const MISDIRECTED = /发错|發錯|传错|傳錯|撳錯|撳错|按错|按錯|点错|點錯|打错|打錯|发错人|發錯人|不是(?:发|發)给你|不是(?:發|发)畀你|send\s*畀|send\s*给|错咗|錯咗|错了对话框|錯了對話框|wrong (?:chat|person)|sent (?:this|it) by mistake/iu;
const FAMILY_ADDRESS = /^(?:妈|媽|妈妈|媽媽|老妈|老媽|爸|爸爸|老爸|老公|老婆|宝贝|寶貝|儿子|兒子|女儿|女兒|阿妈|阿媽|阿爸)[，,、\s]/u;
const THANKS = /谢谢|謝謝|多谢|多謝|感谢|感謝|谢啦|謝啦|谢了|謝了|辛苦了|唔該|唔该|thank|thx/iu;
const CLOSING = /明白了|知道了|懂了|了解了|清楚了|收到|好的|好嘞|拜拜|再见|再見|不打扰|不打擾|晚安|先这样|先這樣|祝.{0,10}(?:愉快|顺利|順利|开心|開心)|有问题再|有問題再|再来问|再來問|回头再|回頭再|我自己(?:再)?(?:找|看|去)|就不麻烦|就不麻煩|bye/iu;
const PRAISE = /点赞|點讚|點贊|点个赞|點個讚|夸|誇|讲得|講得|接地气|接地氣|听懂|聽懂|看懂|好懂|厉害|厲害|很棒|真棒|太棒|好棒|加油|继续更|繼續更|期待|支持你们|支持你們|喜欢你们|喜歡你們|great|awesome|love (?:it|your)/iu;
const GREETING = /哈喽|哈囉|你好|您好|嗨|打个招呼|打個招呼|路过|路過|来报到|來報到|^hi\b|^hello\b|^hey\b/iu;
const IDENTITY = /(?:你|您)(?:是|係)(?:不是)?(?:谁|誰|边个|邊個|哪位|人工|真人|机器人|機器人|智能|自动|自動|ai|AI|客服|小助手|助手)|(?:人工|真人)(?:客服)?(?:还是|還是|或者|定係)(?:机器人|機器人|智能|自动|自動|ai|AI|助手)|(?:机器人|機器人|智能|自动|自動|ai|AI)(?:客服|助手|回复|回覆)?(?:还是|還是|或者|定係)(?:人工|真人)|(?:怎么|怎麼|如何)称呼(?:你|您)|(?:你|您)(?:叫|叫做)(?:什么|什麼|啥)|are you (?:a )?(?:bot|robot|human|real person|ai)/iu;
const CAPABILITY = /(?:你|您)(?:能|可以|会|會)(?:帮我|幫我)?(?:解答|回答|做|干|處理|处理)(?:哪些|什么|什麼|啥)|(?:能|可以)(?:帮|幫)(?:我)?(?:解答|回答)(?:哪些|什么|什麼)|哪些问题(?:可以|能)|哪些問題(?:可以|能)|what can you (?:do|help)/iu;
const CANTONESE = /[唔咗嘅㗎啲冇嗰撳睇乜嘢喺咁哋]/u;

export function hasQuestionSignal(value = '') {
  return QUESTION_SIGNAL.test(cleanSocialText(value));
}

export function detectReplyLanguage(value = '') {
  const text = String(value || '').normalize('NFKC');
  const han = (text.match(/\p{Script=Han}/gu) || []).length;
  const latin = (text.match(/[A-Za-z]/g) || []).length;
  return latin >= 12 && latin > han * 3 ? 'english' : 'chinese';
}

// “有课程方面的问题再来咨询您”“回头再问”是告别语，不是提问。
function withoutDeferredAsk(text) {
  return text
    .replace(/(?:我)?(?:暂时|暫時|今天|现在|現在)?(?:没|沒)(?:啥|什么|什麼|甚麼|有)?(?:要|想)?(?:问|問|咨询|諮詢|请教|請教)(?:的|题|題)?/gu, '')
    .replace(/(?:我)?(?:没|沒)(?:啥|什么|什麼|甚麼|有)(?:问题|問題|事)/gu, '')
    .replace(/(?:有|等)(?:想|要)?(?:问|問|咨询|諮詢)的?[^，,。！!]{0,6}再/gu, '')
    .replace(/(?:有|有什么|有啥)?[^，,。！!]{0,10}(?:问题|問題|需要)?(?:再来|再來|再|回头再|回頭再|以后再|以後再)(?:来)?(?:咨询|諮詢|问|問|请教|請教|找)(?:您|你|你们|你們)?/gu, '');
}

function cleanSocialText(value = '') {
  return String(value || '').normalize('NFKC').replace(EMOJI, ' ').replace(KAOMOJI, ' ').replace(/\s+/g, ' ').trim();
}

/** 去掉身份问句后，剩余部分是否还带着真正的业务问题。 */
function stripIdentityClauses(text) {
  return text
    .split(/[，,。.!！？?；;\n]/u)
    .filter(part => part.trim() && !IDENTITY.test(part) && !CAPABILITY.test(part) && !/^(?:你好|您好|请问|請問|好的|谢谢|謝謝|我想了解一下|我想了解下)$/u.test(part.trim()))
    .join('，');
}

/**
 * 返回 { kind, language, cantonese } 或 null。
 * kind: MISDIRECTED / FAMILY_MESSAGE / IDENTITY / CLOSING / PRAISE / GREETING
 */
/** 身份类子句（“你是人工客服还是机器人”“怎么称呼你”），用于转人工识别时排除。 */
export function isIdentityClause(value = '') {
  return IDENTITY.test(String(value || '').normalize('NFKC'));
}

/** 去掉身份类子句后的文本，供转人工识别使用。 */
export function withoutIdentityClauses(value = '') {
  return String(value || '').split(/[，,。.!！？?；;\n]/u).filter(part => !isIdentityClause(part)).join('，');
}

export function detectSocialMessage(value = '') {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const text = cleanSocialText(raw);
  const language = detectReplyLanguage(raw);
  const cantonese = CANTONESE.test(raw);
  const base = { language, cantonese };
  if ([...text].length > 160) return null;
  if (NEGATIVE_SIGNAL.test(text)) return null;
  if (MISDIRECTED.test(text) && !/(?:课|課|报名|報名|活动|活動|价格|價格)/u.test(text)) return { kind: 'MISDIRECTED', ...base };
  if (FAMILY_ADDRESS.test(text) && !QUESTION_SIGNAL.test(text.replace(/^[^，,、\s]+[，,、\s]/u, ''))) return { kind: 'FAMILY_MESSAGE', ...base };
  if (IDENTITY.test(text) || CAPABILITY.test(text)) {
    const rest = stripIdentityClauses(text);
    // 身份问题 + 具体业务问题：身份部分交给回复前缀，具体问题仍要检索，这里不拦截。
    if (rest && QUESTION_SIGNAL.test(rest) && [...rest].length > 8 && !CAPABILITY.test(text)) return null;
    return { kind: 'IDENTITY', ...base };
  }
  // “懂了…这下清楚了，谢啦”：表示已明白、以道谢收尾且没有问号或吗/呢，是收尾不是提问。
  const understoodClosing = /(?:懂了|明白了|清楚了|了解了|知道了|get了)/u.test(text)
    && /(?:谢谢|謝謝|谢啦|謝啦|谢了|多谢|多謝|感谢|感謝|thx|thanks)[^，,。]{0,6}[。.!！～~\s]*$/iu.test(text)
    && !/[？?]|吗|嗎|还是|還是/u.test(text)
    && (!/呢/u.test(text) || /那就行|那就好|放心了|这下清楚|這下清楚|这下明白|這下明白/u.test(text));
  if (!understoodClosing && QUESTION_SIGNAL.test(withoutDeferredAsk(text))) return null;
  if (MISDIRECTED.test(text)) return { kind: 'MISDIRECTED', ...base };
  if (THANKS.test(text)) return { kind: 'CLOSING', ...base, praise: PRAISE.test(text) };
  if (PRAISE.test(text)) return { kind: 'PRAISE', ...base };
  if (CLOSING.test(text)) return { kind: 'CLOSING', ...base };
  if (GREETING.test(text) && [...text].length <= 40) return { kind: 'GREETING', ...base };
  return null;
}

const REPLIES = {
  simplified: {
    MISDIRECTED: ['没关系～看起来是发错对话框啦，有需要的时候随时找我。', '没事没事～有想了解的随时来问我就好。'],
    FAMILY_MESSAGE: ['这条好像是发给家人的哈～如果是想咨询课程或活动，直接问我就行。'],
    IDENTITY: ['我是这里的智能助手小智～课程内容、活动安排、报名这些都可以直接问我；需要真人同事的话，回我「转人工」就行。'],
    CLOSING: ['不客气～后面有问题随时来问我。', '好的，祝你一切顺利～有需要随时找我。', '不客气，能帮上忙就好～有新问题随时问我。'],
    CLOSING_PRAISE: ['谢谢你的认可～能帮上忙就好，有新问题随时来问我。'],
    PRAISE: ['哈哈谢谢你的认可～能帮到你就好！之后有想了解的课程或活动，也可以直接问我。', '谢谢夸奖，我们会继续努力的～有想了解的随时问我。'],
    PRAISE_SUPPORT: ['谢谢关注和支持～我们会继续多做这种好懂的内容，看到不懂的随时来问我！', '收到你的鼓励啦，谢谢～后面有看不懂的地方，直接来问我就好。'],
    GREETING: ['哈喽～谢谢你来打招呼！有想了解的随时问我就好～', '你好呀～想了解课程、活动这些，直接问我就行。']
  },
  traditional: {
    MISDIRECTED: ['沒關係～看起來是發錯對話框啦，有需要的時候隨時找我。', '沒事沒事～有想了解的隨時來問我就好。'],
    FAMILY_MESSAGE: ['這條好像是發給家人的哈～如果是想諮詢課程或活動，直接問我就行。'],
    IDENTITY: ['我是這裡的智能助手小智～課程內容、活動安排、報名這些都可以直接問我；需要真人同事的話，回我「轉人工」就行。'],
    CLOSING: ['不客氣～後面有問題隨時來問我。', '好的，祝你一切順利～有需要隨時找我。', '不客氣，能幫上忙就好～有新問題隨時問我。'],
    CLOSING_PRAISE: ['謝謝你的認可～能幫上忙就好，有新問題隨時來問我。'],
    PRAISE: ['哈哈謝謝你的認可～能幫到你就好！之後有想了解的課程或活動，也可以直接問我。', '謝謝誇獎，我們會繼續努力的～有想了解的隨時問我。'],
    PRAISE_SUPPORT: ['謝謝關注和支持～我們會繼續多做這種好懂的內容，看到不懂的隨時來問我！'],
    GREETING: ['哈囉～謝謝你來打招呼！有想了解的隨時問我就好～', '你好呀～想了解課程、活動這些，直接問我就行。']
  },
  cantonese: {
    MISDIRECTED: ['唔緊要～睇落係撳錯咗對話框，有需要隨時搵我哋就得㗎。'],
    FAMILY_MESSAGE: ['呢條好似係想send畀屋企人㗎～如果想問課程或者活動，直接問我就得。'],
    CLOSING: ['唔使客氣～之後有問題隨時再搵我。'],
    PRAISE: ['多謝你嘅支持～有咩想了解嘅課程或者活動，隨時問我就得。'],
    GREETING: ['哈囉～多謝你嚟打招呼！有咩想了解隨時問我。']
  },
  english: {
    MISDIRECTED: ['No worries! Looks like that one was meant for someone else. Feel free to message me anytime.'],
    FAMILY_MESSAGE: ['Looks like this might have been meant for family. If you have questions about our courses or events, just ask!'],
    IDENTITY: ['I\'m the AI assistant here. I can help with course content, events and sign-ups. If you\'d like a real person, just reply "human".'],
    CLOSING: ['You\'re welcome! Feel free to come back anytime if you have more questions.'],
    CLOSING_PRAISE: ['Thank you, glad it helped! Feel free to ask anytime.'],
    PRAISE: ['Thank you so much! Glad it was helpful. Feel free to ask if you\'d like to know more about our courses.'],
    GREETING: ['Hi there! Thanks for stopping by. Feel free to ask me anything about our courses or events.']
  }
};

function pick(list, seed = '') {
  let hash = 0;
  for (const char of String(seed)) hash = (hash * 31 + char.codePointAt(0)) >>> 0;
  return list[hash % list.length];
}

function looksTraditional(value = '') {
  const text = String(value || '');
  const traditional = (text.match(/[體臺灣為與這個來時會後裡麼問學習開關閉發現應該讓從將還進過內寶綁銀錢費報名資訊聯絡謝嗎們說話對錯傳點讚誇聽講氣]/gu) || []).length;
  const simplified = (text.match(/[体台湾为与这个来时会后里么问学习开关闭发现应该让从将还进过内宝绑银钱费报名资讯联络谢吗们说话对错传点赞夸听讲气]/gu) || []).length;
  return traditional > simplified;
}

/** script 缺省时按用户原文判断繁简。 */
export function socialReplyText(social, { script = 'auto', seed = '', source = '' } = {}) {
  if (!social) return null;
  if (script === 'auto' && looksTraditional(source || seed)) script = 'traditional';
  // 第二次夸奖多半是“点关注、继续更”，换一句回应，避免和上一轮一模一样。
  const key = social.kind === 'CLOSING' && social.praise ? 'CLOSING_PRAISE'
    : social.kind === 'PRAISE' && /关注|關注|收藏|继续更|繼續更|多拍|多发|多發|蹲/u.test(String(source || seed)) ? 'PRAISE_SUPPORT' : social.kind;
  const tables = social.language === 'english'
    ? [REPLIES.english]
    : social.cantonese ? [REPLIES.cantonese, REPLIES.traditional] : [script === 'traditional' ? REPLIES.traditional : REPLIES.simplified];
  for (const table of tables) {
    const list = table[key] || table[social.kind];
    if (list) return pick(list, seed);
  }
  return null;
}
