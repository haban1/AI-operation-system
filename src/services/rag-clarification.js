import { applicationClarificationReply, isNegativeReply, knowledgeGapReply } from './conversation-intent.js';

function compact(value) {
  return String(value || '').normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
}

function subjectTerms(value) {
  const text = String(value || '').normalize('NFKC').toLowerCase()
    .replace(/就是|请问|請問|这个|這個|那个|那個|什么|什麼|哪些|哪一些|怎么|怎麼|如何|哪里|哪裡|在哪|多少|有没有|有沒有|想了解|想问|想問|一下|一些|可以|需要/gu, ' ');
  const terms = new Set(text.match(/[a-z][a-z0-9]+/g) || []);
  for (const part of text.match(/[\p{Script=Han}]+/gu) || []) {
    for (let index = 0; index < part.length - 1; index += 1) terms.add(part.slice(index, index + 2));
  }
  return terms;
}

function candidateTopic(title) {
  return String(title || '').trim().replace(/^(?:什么是|什麼是)/u, '').replace(/[？?。！!]+$/u, '').trim();
}

export function businessSubjectClarificationReply(question, { script = 'auto' } = {}) {
  const application = applicationClarificationReply(question, { script });
  if (application) return application;
  const text = compact(question).replace(/^(?:请问|請問|我想问|我想問|我想知道)/u, '').replace(/^(?:这个|這個|那个|那個)/u, '').replace(/(?:吗|嗎|呢)$/u, '');
  const traditional = script === 'traditional';
  if (/^(?:(?:要|需要)?多少(?:钱|錢)|(?:费用|費用|价格|價格|收费|收費)(?:是多少|多少|怎么样|怎麼樣)?|怎么收费|怎麼收費)$/u.test(text)) {
    return traditional ? '你問的是哪項服務的費用？發個名字我看看。' : '你问的是哪项服务的费用？发个名字我看看。';
  }
  if (/^(?:(?:要|需要|需准备|需準備|要准备|要準備)?(?:什么|什麼|哪些)(?:材料|资料|資料|证件|證件)|(?:材料|资料|資料|证件|證件)(?:要|需要)?(?:什么|什麼|哪些))$/u.test(text)) {
    return traditional ? '你想辦哪件事？告訴我名字，我看看要準備什麼。' : '你想办哪件事？告诉我名字，我看看要准备什么。';
  }
  if (/^(?:(?:地址|地点|地點)(?:(?:是|在)?(?:哪|哪里|哪裡|哪儿|哪兒))?|(?:在|是)?(?:哪里|哪裡|哪儿|哪兒))$/u.test(text)) {
    return traditional ? '想找哪個機構或活動的地址？發個名字我看看。' : '想找哪个机构或活动的地址？发个名字我看看。';
  }
  if (/^(?:(?:怎么|怎麼|如何|怎样|怎樣)(?:报名|報名)|(?:我)?(?:想|要)(?:报名|報名)|(?:在)?(?:哪里|哪裡|哪儿|哪兒)(?:报名|報名|申请|申請|办理|辦理))$/u.test(text)) {
    if (/报名|報名/u.test(text)) return traditional ? '想報哪個活動或課程？發個名字就行。' : '想报哪个活动或课程？发个名字就行。';
    return traditional ? '你問的是哪項業務？發個名字就行。' : '你问的是哪项业务？发个名字就行。';
  }
  // A broad catalogue question has a useful default scope: the selected KB.
  // Only an unresolved explicit referent needs the customer to name its object.
  const vaguePolicy = /^(?:请问|請問)?(?:这个|這個|那个|那個)(?:(?:有)?(?:什么|什麼|哪些|哪一些)政策|政策(?:有)?(?:什么|什麼|哪些|哪一些))(?:吗|嗎|呢)?$/u;
  if (!vaguePolicy.test(compact(question))) return null;
  return script === 'traditional'
    ? '你想問哪方面的政策？說下政策名或相關業務。'
    : '你想问哪方面的政策？说下政策名或相关业务。';
}

function relevantCandidate(response, question, context) {
  const terms = subjectTerms(question);
  const references = [
    ...(response?.diagnostics?.selectedCandidates || []).filter(item => item.selected === true),
    ...(response?.grounding?.sourceReferences || response?.sourceReferences || []).filter(item => item.verificationStatus === 'VERIFIED')
  ];
  const candidates = new Map();
  for (const item of references) {
    const title = String(item.title || '').trim();
    const documentId = item.documentId || item.document_id;
    const chunkId = item.chunkId || item.chunk_id;
    if (!documentId || !chunkId || !title || title.length > 120) continue;
    const topic = candidateTopic(title);
    if (!topic || context.some(turn => String(turn.role).toUpperCase() === 'ASSISTANT' && compact(turn.text).includes(compact(topic)))) continue;
    const candidateTerms = subjectTerms([title, ...(item.sectionPath || item.section_path || [])].join(' '));
    // A single broad word such as “政策” is not enough to choose a business.
    // This chooses a question to confirm, never an answer or a lower RAG threshold.
    if ([...terms].filter(term => candidateTerms.has(term)).length < 2) continue;
    candidates.set(compact(title), { documentId, documentVersion: item.documentVersion || item.document_version || 1, chunkId, candidateQuestion: title, topic });
  }
  return candidates.size === 1 ? [...candidates.values()][0] : null;
}

export function ragClarificationReply(response, { question = '', context = [], script = 'auto' } = {}) {
  const traditional = script === 'traditional';
  const denied = isNegativeReply(question) || /^(?:不是|不对|不對)[，,。\s]/u.test(String(question));
  const candidate = denied ? null : relevantCandidate(response, question, context);
  if (candidate) {
    const { topic, ...clarificationCandidate } = candidate;
    return {
      replyText: traditional ? `你問的是「${topic}」嗎？` : `你问的是「${topic}」吗？`,
      clarificationCandidate
    };
  }
  const followup = denied || /^(?:这个|這個|那个|那個|那|还有|還有|其他|哪些|有哪些)/u.test(String(question));
  const sourceTopic = followup ? context.filter(item => String(item.role).toUpperCase() === 'USER').slice(-3).map(item => item.text).join(' ') : '';
  const topic = `${question} ${sourceTopic}`;
  let replyText;
  if (/社区|社區/u.test(topic) && /政策/u.test(topic)) {
    replyText = traditional ? '你問的是哪個社區的政策？說下社區名或所在地。' : '你问的是哪个社区的政策？说下社区名或所在地。';
  } else if (/政策/u.test(topic)) {
    replyText = traditional ? '你想問哪方面的政策？說下政策名或相關業務。' : '你想问哪方面的政策？说下政策名或相关业务。';
  } else {
    replyText = applicationClarificationReply(question, { script }) || knowledgeGapReply(question, { script, sourceTopic });
  }
  return { replyText, clarificationCandidate: null };
}
