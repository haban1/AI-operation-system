import { hasQuestionSignal } from './social-reply.js';
// 业务回复编排层：RAG 没有给出可靠答案时，决定“怎么回”。
//
// 边界：这里只组织话术，不陈述任何业务事实，不降低 RAG 证据门槛，也不把候选
// 当作答案或引用。候选标题只用来确认用户想问的方向；真正作答仍须用户确认后
// 再走一次完整 RAG。所有转人工的话术都只是邀请，实际转接由 server 的既有链路执行。

const UNNAMED_TITLES = new Set(['未命名内容', '未命名', 'untitled']);
const MAX_TOPICS = 3;
const MAX_TOPIC_CHARS = 40;
// 字面有一个词重合时，候选至少要有这个相关度才会被当作“可能想问的方向”。
const RELATED_MIN_SCORE = 0.12;
// 相关档：低于 RAG 作答门槛（默认 0.38）但达到该值的候选，即使字面不重合也可以拿来确认方向。
// 口语化提问（“要钱不”“咋整”）和标题字面差异大，主要靠这一档兜住。
export const DEFAULT_RELATED_BAND_SCORE = 0.25;

export const NO_ANSWER_KIND = Object.freeze({
  OUT_OF_SCOPE: 'OUT_OF_SCOPE',
  RELATED: 'RELATED',
  GAP: 'GAP'
});

// 明显与业务无关、且知识里也没有相关内容的问题。只在 RAG 已经返回无答案后使用，
// 因此误判的代价只是换一种更友好的说法，不会挡住任何业务问题进入检索。
const OFF_DOMAIN = /(?:天气|气温|下雨|下雪|台风|股票|股价|基金|汇率|币价|比特币|彩票|双色球|新闻|热搜|八卦|明星|比赛|比分|球赛|世界杯|星座|运势|算命|塔罗|讲个?笑话|说个?笑话|脑筋急转弯|写(?:一)?(?:首|篇|段|个)?(?:诗|作文|小说|情书)|帮我(?:算|解|做)(?:一下)?(?:题|数学|作业)|数学题|作业答案|菜谱|怎么做菜|好吃的|(?:推荐|推薦|找|想看|有没有|有沒有)[^。！!？?]{0,24}(?:电影|電影|电视剧|電視劇|综艺|綜藝|片子|喜剧片|悬疑片|动画片|纪录片|游戏|遊戲|歌|小说|小說|剧|番|餐厅|餐廳|美食|景点|景點)|(?:电影|電影|片子|喜剧|悬疑片|电视剧).{0,12}(?:推荐|推薦|好看|看啥|看什么)|(?:电影|电视剧|综艺|游戏|小说|动漫).{0,6}(?:推荐|好看|看啥|看什么)|好看的(?:电影|剧|电视剧)|(?:周末|晚上).{0,6}(?:看|玩|吃).{0,4}(?:什么|啥)|失恋|分手|吵架|心情不好|好无聊|彩票号码|运势|你(?:多大|几岁|结婚|有对象|喜欢我)|男朋友|女朋友|谈恋爱|天氣|氣溫|股價|匯率|新聞|熱搜|比賽|比分|星座|運勢|笑話|作業|電影|電視劇|遊戲)/u;

function compact(value) {
  return String(value || '').normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
}

function stableIndex(seed, size) {
  let hash = 0;
  for (const char of String(seed || '')) hash = (hash * 31 + char.codePointAt(0)) >>> 0;
  return size > 0 ? hash % size : 0;
}

function lastAssistantText(context = []) {
  return [...(context || [])].reverse().find(turn => String(turn?.role).toUpperCase() === 'ASSISTANT')?.text || '';
}

// 同一问题给固定的说法（便于复现和测试），但避免和上一轮机器人回复一字不差。
function pickVariant(variants, { seed = '', context = [] } = {}) {
  if (!variants.length) return '';
  const previous = compact(lastAssistantText(context));
  const start = stableIndex(seed, variants.length);
  for (let offset = 0; offset < variants.length; offset += 1) {
    const candidate = variants[(start + offset) % variants.length];
    if (compact(candidate) !== previous) return candidate;
  }
  return variants[start];
}

function subjectTerms(value) {
  const text = String(value || '').normalize('NFKC').toLowerCase()
    .replace(/就是|请问|請問|这个|這個|那个|那個|什么|什麼|哪些|哪一些|怎么|怎麼|如何|哪里|哪裡|在哪|多少|有没有|有沒有|想了解|想问|想問|一下|一些|可以|需要|你们|你們|我们|我們|咋|啥|呗|嘛|呢|吗|嗎|啊|呀|哈/gu, ' ');
  const terms = new Set(text.match(/[a-z][a-z0-9]+/g) || []);
  for (const part of text.match(/[\p{Script=Han}]+/gu) || []) {
    for (let index = 0; index < part.length - 1; index += 1) terms.add(part.slice(index, index + 2));
  }
  return terms;
}

function topicFromTitle(title) {
  const text = String(title || '').trim()
    .replace(/^(?:什么是|什麼是|关于|關於)/u, '')
    .replace(/[？?。！!]+$/u, '')
    .trim();
  if (!text || UNNAMED_TITLES.has(text.toLowerCase())) return '';
  return [...text].length > MAX_TOPIC_CHARS ? '' : text;
}

function items(response) {
  return [
    ...(response?.diagnostics?.selectedCandidates || []),
    ...(response?.grounding?.sourceReferences || [])
  ];
}

function score(item) {
  const value = Number(item?.rerankerScoreNormalized ?? item?.reranker_score_normalized);
  return Number.isFinite(value) ? value : 0;
}

/**
 * 从无答案响应的候选里挑出“可能是用户想问的方向”。
 * 只返回标题，不返回正文；已经在上一轮问过的方向不再重复。
 */
export function relatedTopics(response, { question = '', context = [], limit = MAX_TOPICS, minScore = DEFAULT_RELATED_BAND_SCORE } = {}) {
  // RAG 已把口语改写成标准问法（canonicalQuestion）并抽取关键词，一并用于字面匹配。
  const analysis = response?.diagnostics?.queryAnalysis || {};
  const rewritten = [analysis.canonicalQuestion, analysis.resolvedQuestion, ...(Array.isArray(analysis.keywords) ? analysis.keywords : [])]
    .filter(item => typeof item === 'string' && item.trim());
  const terms = subjectTerms([question, ...rewritten].join(' '));
  const bandScore = Number.isFinite(Number(minScore)) && Number(minScore) > 0 ? Number(minScore) : DEFAULT_RELATED_BAND_SCORE;
  if (!terms.size && !items(response).some(item => score(item) >= bandScore)) return [];
  const askedBefore = (context || [])
    .filter(turn => String(turn?.role).toUpperCase() === 'ASSISTANT')
    .map(turn => compact(turn.text));
  const topics = new Map();
  for (const item of items(response)) {
    const topic = topicFromTitle(item?.title);
    const documentId = item?.documentId || item?.document_id;
    const chunkId = item?.chunkId || item?.chunk_id;
    if (!topic || !documentId || !chunkId) continue;
    const key = compact(topic);
    if (topics.has(key) || askedBefore.some(text => text.includes(key))) continue;
    const sectionPath = item.sectionPath || item.section_path || [];
    const candidateTerms = subjectTerms([topic, ...sectionPath].join(' '));
    const overlap = [...terms].filter(term => candidateTerms.has(term)).length;
    // 单个宽泛词（如“政策”）不足以确定方向，除非候选本身相关度已经不低；落在相关档的候选直接保留。
    const inBand = score(item) >= bandScore;
    if (!inBand && overlap < 2 && !(overlap >= 1 && score(item) >= RELATED_MIN_SCORE)) continue;
    topics.set(key, {
      topic, overlap, score: score(item),
      candidate: { documentId, documentVersion: item.documentVersion || item.document_version || 1, chunkId, candidateQuestion: topic }
    });
  }
  return [...topics.values()]
    .sort((left, right) => right.score - left.score || right.overlap - left.overlap)
    .slice(0, Math.max(1, limit));
}

export function isOffDomainQuestion(question = '') {
  return OFF_DOMAIN.test(String(question || '').normalize('NFKC'));
}

function shortTopic(question = '') {
  const text = stripVocative(question)
    .replace(/^(?:请问|請問|我想问|我想問|想问下|想問下|问下|問下|那个|那個|就是)[，,\s]*/u, '')
    .replace(/[？?。！!~～\s]+$/u, '')
    .replace(/(?:吗|嗎|呢|呀|啊|哈|嘛)+$/u, '');
  const length = [...text].length;
  // 带标点的长句、以“不/没”结尾的正反问（“要钱不”）截出来会走样，宁可不引用。
  if (/[，,。；;、\s]/u.test(text) || /[不没]$/u.test(text)) return '';
  return length >= 2 && length <= 14 ? text : '';
}

const TEXT = {
  simplified: {
    outOfScope: [
      '哈哈，这个有点超出我的范围啦～我主要帮大家解答活动、课程和业务办理这类问题，这方面有想了解的随时问我。',
      '这个问题我就不乱说啦，怕误导你～活动报名、课程安排、业务办理这些我比较在行，有需要直接问我就好。',
      '这个我帮不上忙哈，不过关于我们的活动、课程或者业务办理，你想了解什么都可以问我。'
    ],
    guarded: '这个我就不方便聊啦～如果是活动、课程或者业务办理方面的问题，我很乐意帮你看看。',
    singleTopic: topic => [
      `你是想了解「${topic}」吗？是的话回我一声，我把这部分跟你说说。`,
      `我先确认一下方向：你问的是「${topic}」相关的内容吗？是的话我接着跟你说。`
    ],
    multiTopic: list => [
      `你问的这个，我这边有几个相关的方向：\n${list}\n你想了解哪个？回我序号或者直接说都行。`,
      `我先帮你缩小一下范围，你是想了解下面哪一个？\n${list}\n回个序号就行～`
    ],
    price: '费用这块我这边还没有准确的数，不想给你报错。需要的话回我「转人工」，让同事把最新价格和优惠发给你。',
    contact: '联系方式这块我这边没法直接给你。需要的话回我「转人工」，我请同事来跟你对接；你也可以先说说想咨询什么，我先帮你看看。',
    location: '具体楼层和房间我这边还确认不了，怕说错耽误你。需要的话回我「转人工」，让同事跟你确认准确位置。',
    signup: '这个的报名方式我这边还没有准确的信息，不想给你说错。需要的话回我「转人工」，让同事直接告诉你怎么报。',
    schedule: '具体的时间和名额会有变动，我这边没法给你准话。回我「转人工」的话，同事可以帮你确认最新安排。',
    firstGap: topic => [
      `${topic ? `关于「${topic}」，` : '这个问题'}我暂时还答不准，不想随便说误导你。你可以多说一点细节，比如是哪个活动、课程或业务，我再帮你找找；着急的话也可以回我「转人工」。`,
      `${topic ? `「${topic}」这个` : '这个'}我这边还没法给你准确答复。方便的话再补充一点情况，我接着帮你看；想直接找同事的话，回我「转人工」就行。`
    ],
    repeatedGap: [
      '还是没能帮你把这个问题确认清楚，抱歉～我请同事来帮你看看吧？回我「转人工」就行，他们看到会尽快回复你。',
      '这个问题我这边一直答不准，不想耽误你。回我「转人工」，我请同事来跟你详细说。'
    ],
    // 用户已经说过不用转人工：不再反复邀请，只如实说明并留出继续问的口子。
    declinedGap: [
      '这个我手上的资料里暂时还没有准确答案，不想随便说误导你～换个问题或者多说点细节，我再帮你找找。',
      '这个我这边暂时确认不了，抱歉～有其他想了解的随时问我。'
    ]
  },
  traditional: {
    outOfScope: [
      '哈哈，這個有點超出我的範圍啦～我主要幫大家解答活動、課程和業務辦理這類問題，這方面有想了解的隨時問我。',
      '這個問題我就不亂說啦，怕誤導你～活動報名、課程安排、業務辦理這些我比較在行，有需要直接問我就好。',
      '這個我幫不上忙哈，不過關於我們的活動、課程或者業務辦理，你想了解什麼都可以問我。'
    ],
    guarded: '這個我就不方便聊啦～如果是活動、課程或者業務辦理方面的問題，我很樂意幫你看看。',
    singleTopic: topic => [
      `你是想了解「${topic}」嗎？是的話回我一聲，我把這部分跟你說說。`,
      `我先確認一下方向：你問的是「${topic}」相關的內容嗎？是的話我接著跟你說。`
    ],
    multiTopic: list => [
      `你問的這個，我這邊有幾個相關的方向：\n${list}\n你想了解哪個？回我序號或者直接說都行。`,
      `我先幫你縮小一下範圍，你是想了解下面哪一個？\n${list}\n回個序號就行～`
    ],
    price: '費用這塊我這邊還沒有準確的數，不想給你報錯。需要的話回我「轉人工」，讓同事把最新價格和優惠發給你。',
    contact: '聯繫方式這塊我這邊沒法直接給你。需要的話回我「轉人工」，我請同事來跟你對接；你也可以先說說想諮詢什麼，我先幫你看看。',
    location: '具體樓層和房間我這邊還確認不了，怕說錯耽誤你。需要的話回我「轉人工」，讓同事跟你確認準確位置。',
    signup: '這個的報名方式我這邊還沒有準確的信息，不想給你說錯。需要的話回我「轉人工」，讓同事直接告訴你怎麼報。',
    schedule: '具體的時間和名額會有變動，我這邊沒法給你準話。回我「轉人工」的話，同事可以幫你確認最新安排。',
    firstGap: topic => [
      `${topic ? `關於「${topic}」，` : '這個問題'}我暫時還答不準，不想隨便說誤導你。你可以多說一點細節，比如是哪個活動、課程或業務，我再幫你找找；著急的話也可以回我「轉人工」。`,
      `${topic ? `「${topic}」這個` : '這個'}我這邊還沒法給你準確答覆。方便的話再補充一點情況，我接著幫你看；想直接找同事的話，回我「轉人工」就行。`
    ],
    repeatedGap: [
      '還是沒能幫你把這個問題確認清楚，抱歉～我請同事來幫你看看吧？回我「轉人工」就行，他們看到會盡快回覆你。',
      '這個問題我這邊一直答不準，不想耽誤你。回我「轉人工」，我請同事來跟你詳細說。'
    ],
    declinedGap: [
      '這個我手上的資料裡暫時還沒有準確答案，不想隨便說誤導你～換個問題或者多說點細節，我再幫你找找。',
      '這個我這邊暫時確認不了，抱歉～有其他想了解的隨時問我。'
    ]
  },
  english: {
    outOfScope: [
      'Ha, that\'s a bit outside what I can help with! I mainly answer questions about our courses, events and sign-ups, so feel free to ask about those anytime.',
      'I\'d rather not guess on that one. Questions about our courses, events or sign-ups are where I can really help!'
    ],
    guarded: 'That\'s not something I can discuss, but I\'m happy to help with anything about our courses, events or sign-ups.',
    singleTopic: topic => [`Just to check, are you asking about "${topic}"? If so, reply yes and I\'ll walk you through it.`],
    multiTopic: list => [`I found a few related topics:\n${list}\nWhich one would you like to know about? Just reply with the number.`],
    firstGap: () => [
      'I don\'t have a reliable answer to that yet and don\'t want to mislead you. Could you share a bit more detail? If you\'d like a colleague to follow up, just reply "human".'
    ],
    repeatedGap: [
      'Sorry, I still can\'t confirm that for you. Reply "human" and I\'ll ask a colleague to get back to you.'
    ],
    declinedGap: [
      'I don\'t have a reliable answer to that one yet, sorry! Feel free to ask me anything else.'
    ]
  }
};

function gapCategory(question, context) {
  const current = String(question || '').normalize('NFKC');
  const previous = (context || []).filter(turn => String(turn?.role).toUpperCase() === 'USER').at(-1)?.text || '';
  const followup = /^(?:那|这个|這個|那个|那個|还有|還有|具体|具體|怎么|怎麼|咋|要|能)/u.test(current.trim());
  const text = followup ? `${current} ${previous}` : current;
  if (/电话|電話|联系方式|聯繫方式|联系谁|聯繫誰|聯絡|微信号|微信號|客服号|客服號/u.test(current)) return 'contact';
  // 开票、退款、报销问的是办理规则，不是价格。
  const billingProcedure = /发票|發票|开票|開票|专票|專票|普票|抬头|抬頭|退款|退費|退费|报销|報銷|到账|到賬|打款/u.test(current);
  if (!billingProcedure && /多少钱|多少錢|几钱|幾錢|费用|費用|学费|學費|报名费|報名費|价格|價格|价位|價位|收费|收費|要钱|要錢|优惠|優惠|折扣/u.test(current)) return 'price';
  if (/楼层|樓層|几楼|幾樓|房间|房間|门牌|門牌|楼栋|樓棟/u.test(text)) return 'location';
  if (/报名|報名|报班|報班|咋参加|怎么参加|怎麼參加|咋报|咋報/u.test(text)) return 'signup';
  if (/名额|名額|排期|哪天|几号|幾號|这期|這期|下期|还有位|還有位/u.test(text)) return 'schedule';
  return null;
}

function numberedList(topics) {
  return topics.map((item, index) => `${index + 1}. ${item.topic}`).join('\n');
}

/**
 * RAG 未给出可靠答案时的私信回复。
 * attempt 是本轮在会话里累计的第几次引导（从 1 开始）。
 */
export function composeNoAnswerReply(response, { question = '', context = [], script = 'auto', attempt = 1, denied = false, handoffDeclined = false, relatedMinScore = DEFAULT_RELATED_BAND_SCORE } = {}) {
  const english = script === 'english';
  const text = english ? TEXT.english : script === 'traditional' ? TEXT.traditional : TEXT.simplified;
  const seed = compact(question);
  const reasonCode = String(response?.reasonCode || '').toUpperCase();
  if (reasonCode === 'OUT_OF_SCOPE') {
    return { kind: NO_ANSWER_KIND.OUT_OF_SCOPE, replyText: text.guarded, handoffOffered: false, clarificationCandidate: null, topics: [] };
  }
  const topics = denied ? [] : relatedTopics(response, { question, context, minScore: relatedMinScore });
  if (topics.length) {
    const replyText = topics.length === 1
      ? pickVariant(text.singleTopic(topics[0].topic), { seed, context })
      : pickVariant(text.multiTopic(numberedList(topics)), { seed, context });
    return {
      kind: NO_ANSWER_KIND.RELATED, replyText, handoffOffered: false,
      clarificationCandidate: { ...topics[0].candidate, options: topics.map(item => item.candidate.candidateQuestion) },
      topics: topics.map(item => item.topic)
    };
  }
  if (isOffDomainQuestion(question)) {
    return { kind: NO_ANSWER_KIND.OUT_OF_SCOPE, replyText: pickVariant(text.outOfScope, { seed, context }), handoffOffered: false, clarificationCandidate: null, topics: [] };
  }
  if (handoffDeclined) {
    return { kind: NO_ANSWER_KIND.GAP, replyText: pickVariant(text.declinedGap, { seed, context }), handoffOffered: false, clarificationCandidate: null, topics: [] };
  }
  const category = english ? null : gapCategory(question, context);
  let replyText;
  if (category) replyText = text[category];
  else if (Number(attempt) >= 2) replyText = pickVariant(text.repeatedGap, { seed, context });
  else replyText = pickVariant(text.firstGap(shortTopic(question)), { seed, context });
  // 话术里已经邀请“转人工”，因此同时登记待确认的人工意图，让人工能看到原问题。
  return { kind: NO_ANSWER_KIND.GAP, replyText, handoffOffered: true, clarificationCandidate: null, topics: [] };
}

const ORDINALS = [
  /^(?:第?(?:1|一|①)(?:个|個|项|項|条|條)?|前面那个|前面那個|第一个吧|第一個吧)$/u,
  /^(?:第?(?:2|二|②)(?:个|個|项|項|条|條)?)$/u,
  /^(?:第?(?:3|三|③)(?:个|個|项|項|条|條)?)$/u
];

/**
 * 用户回应上一轮“你是想了解…吗”的确认，返回应当查询的问题；无法确定时返回 null。
 * 只接受明确的肯定、序号或与某个选项完全一致的文字，不做模糊猜测。
 */
export function resolveClarificationSelection(value = '', pendingIntent = null) {
  const options = Array.isArray(pendingIntent?.options) && pendingIntent.options.length
    ? pendingIntent.options.map(String)
    : (pendingIntent?.candidateQuestion ? [String(pendingIntent.candidateQuestion)] : []);
  if (!options.length) return null;
  const text = compact(value).replace(/(?:吧|呀|啊|呢|哈|的|啦)$/u, '');
  if (!text) return null;
  for (let index = 0; index < Math.min(options.length, ORDINALS.length); index += 1) {
    if (ORDINALS[index].test(text)) return options[index];
  }
  const exact = options.find(option => compact(option) === text);
  if (exact) return exact;
  if (options.length === 1 && /^(?:是|是的|对|對|对的|對的|没错|沒錯|嗯|嗯嗯|嗯是的|就是|就是这个|就是這個|是这个|是這個|对就是这个|對就是這個|好|好的|要|想|想了解|可以)$/u.test(text)) return options[0];
  return null;
}

const VOCATIVE = /^(?:(?:哥|姐|亲|老师|同学|宝|宝子|兄弟|老铁|大佬|美女|帅哥|小哥|小姐姐|客服|在吗|在不在|你好|您好|哈喽|嗨|hello|hi)[，,。!！~～\s]*)+/iu;
export function stripVocative(value = '') {
  return String(value || '').normalize('NFKC').trim().replace(VOCATIVE, '');
}

/**
 * 回应“要不要转人工”的邀请。除了“好的”“不用了”这类短句，也接受“好的好的，那麻烦您了，我再补一句…”
 * 这种先表态再补充的说法；先否定的一律视为婉拒。
 */
export function handoffOfferResponse(value = '') {
  const text = String(value || '').normalize('NFKC').trim().replace(/^(?:哦+|噢+|嗯+|emm+|en+|呃+)[，,。\s]*/iu, '');
  if (!text) return null;
  if (/^(?:no\b|nope|not now|no thanks|no need)/iu.test(text)) return 'DECLINE';
  if (/^(?:yes|yeah|yep|sure|ok(?:ay)?|please)\b/iu.test(text) && [...text].length <= 60) return 'ACCEPT';
  if (/^(?:不用|不需要|不要|算了|先不|暂时不|不必|没事|不麻烦)/u.test(text) || /(?:不用|不需要|不要)(?:转|人工|麻烦|找人|同事)/u.test(text)) return 'DECLINE';
  if (/(?:我自己|自己去|自己看|先看看|再说|回头再|以后再|晚点再)/u.test(text)) return null;
  const head = text.slice(0, 8);
  if (/^(?:好|行|可以|要|需要|麻烦|那就|拜托|对|是的|是|ok|嗯嗯|求|帮我)/iu.test(head)) {
    if ([...text].length <= 20 || /(?:麻烦|帮我|帮忙|转|人工|同事|查|看一下|确认|跟进|联系)/u.test(text)) return 'ACCEPT';
  }
  return null;
}

const DECLINE_FILLER = /^(?:不用|不需要|不要|算了|先不|暂时不|暫時不|不必|没事|沒事|不麻烦|不麻煩|谢谢|謝謝|多谢|多謝|哈哈|好的|好啦|嗯|对了|對了|那我|我再问|我再問|换个|換個|no\b|nope|thanks|thank you)|回头再问|回頭再問|先放一放|先不麻烦|先不麻煩|不用转|不用轉|不用帮我查|不用幫我查|问个别的|問個別的|换个问题|換個問題/iu;

/**
 * 婉拒转人工时常顺带问新问题（“不用啦谢谢～对了，我想问…”）。去掉开头的婉拒、道谢和过渡语，
 * 剩下的部分若仍是一个问题就返回它，否则返回空字符串。
 */
export function questionAfterHandoffDecline(value = '') {
  const clauses = String(value || '').normalize('NFKC').split(/(?<=[，,。！!？?～~；;：:\n])/u);
  let index = 0;
  while (index < clauses.length && DECLINE_FILLER.test(clauses[index].replace(/^[\s\p{Extended_Pictographic}]+/gu, '').trim())) index += 1;
  const rest = clauses.slice(index).join('').trim();
  return rest && [...rest].length >= 8 && hasQuestionSignal(rest) ? rest : '';
}
