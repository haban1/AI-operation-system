import { createHash } from 'node:crypto';

const MAX_SCENES = 64;
const MAX_BODY_LENGTH = 20000;
const MAX_SOURCES = 32;

function text(value, limit = 500) {
  return typeof value === 'string'
    ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, limit)
    : '';
}

function list(value, limit = 64) {
  return Array.isArray(value) ? value.slice(0, limit) : [];
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function narration(value) {
  // Visual design, scene headings and creative prompts are deliberately not
  // read. Strip only explicit production cues inside the spoken-text field.
  return text(value, 4000)
    .replace(/【(?:画面|镜头|字幕|音效|配乐|转场|停顿|语速|BGM)\s*[:：][^】]{0,300}】/gi, '')
    .replace(/\[(?:画面|镜头|字幕|音效|配乐|转场|停顿|语速|BGM)\s*[:：][^\]]{0,300}\]/gi, '')
    .split(/\r?\n/)
    .filter(line => !/^\s*(?:画面|镜头|字幕|音效|配乐|转场|语速|BGM)\s*[:：]/i.test(line))
    .map(line => line.replace(/^\s*(?:旁白|口播|解说|narration|voiceover)\s*[:：]\s*/i, '').trim())
    .filter(Boolean).join('\n').trim();
}

function sourceUrl(value) {
  try {
    const url = new URL(text(value, 2000));
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : '';
  } catch { return ''; }
}

function normalized(value) {
  return text(value, 20000).replace(/\s+/g, '');
}

function markdownText(value) {
  // Keep data such as source titles and spoken text from creating headings or
  // links in the generated document. The document never evaluates source text.
  return value.replace(/\\/g, '\\\\').replace(/([`*_{}\[\]<>#])/g, '\\$1');
}

function publicationTitle(fullTitle, topicTitle) {
  const subject = text(topicTitle, 200);
  const candidate = fullTitle.length <= 20 ? fullTitle
    : (subject && subject.length <= 20 ? subject : fullTitle.split(/[，。！？：|]/u).find(part => part.trim().length >= 4) || fullTitle);
  let shortened = '';
  for (const character of candidate.trim()) {
    if (shortened.length + character.length > 20) break;
    shortened += character;
  }
  return shortened;
}

/** Build a private companion from a completed video's actual spoken script.
 * No AI calls, network reads, timestamps, or publication/knowledge side effects.
 * Media decode and source-root checks belong to the caller.
 */
export function buildHotTopicDocument({ script, evidence, research, sourceId } = {}) {
  if (!script || typeof script !== 'object' || !Array.isArray(script.scenes)
      || !script.scenes.length || script.scenes.length > MAX_SCENES) return null;
  const fullTitle = text(script.title, 200);
  if (!fullTitle) return null;
  const title = publicationTitle(fullTitle, script.topic_title);

  const paragraphs = [];
  for (const scene of script.scenes) {
    const lines = Array.isArray(scene?.narration) ? scene.narration : [scene?.narration];
    if (lines.length > 32 || lines.some(line => typeof line === 'string' && line.length > 4000)) return null;
    const spoken = lines.map(narration).filter(Boolean).join(' ').trim();
    if (!spoken) continue;
    paragraphs.push({ text: spoken, sceneType: text(scene.type, 30), sourceIds: unique(list(scene.sourceIds, MAX_SOURCES).map(id => text(id, 100))) });
  }
  // Publication copy uses the actual explanatory narration. Cover/hook scenes
  // usually contain questions or calls to action rather than the topic itself.
  const contentParagraphs = paragraphs.filter(part => !['cover', 'hook'].includes(part.sceneType));
  const body = contentParagraphs.map(part => part.text).join('\n\n');
  if (!body || paragraphs.map(part => part.text).join('\n\n').length > MAX_BODY_LENGTH) return null;

  const citedIds = unique(paragraphs.flatMap(part => part.sourceIds)).slice(0, MAX_SOURCES);
  const records = new Map();
  for (const item of [...list(script.sources, MAX_SOURCES), ...list(evidence?.sources, MAX_SOURCES), ...list(research?.sources, MAX_SOURCES)]) {
    const id = text(item?.id, 100);
    if (!id || !citedIds.includes(id)) continue;
    const previous = records.get(id) || {};
    records.set(id, {
      id, url: previous.url || sourceUrl(item.url), title: previous.title || text(item.title, 300),
      retrievedAt: previous.retrievedAt || text(item.retrieved_at || item.collected_at, 100),
    });
  }
  if (citedIds.includes('readme') && !records.get('readme')?.url && sourceUrl(evidence?.url)) {
    records.set('readme', { id: 'readme', title: '项目 README', url: sourceUrl(evidence.url), retrievedAt: text(evidence.collected_at, 100) });
  }

  const limitations = unique([
    ...list(evidence?.brief?.limitations, 12), ...list(research?.brief?.limitations, 12),
    ...list(research?.limitations, 12), ...list(script.review_flags, 12),
  ].map(value => text(value, 600)));
  if (!citedIds.length || citedIds.some(id => !records.get(id)?.url)) {
    limitations.push('部分视频表述缺少完整的来源链接，不能视为已核实事实。');
  }
  const topicSource = script.source_kind === 'topic' || evidence?.kind === 'topic';
  if (!topicSource && (script.repo || evidence?.readme)) {
    limitations.push('项目能力和示例依据项目方资料及视频表述整理，不代表本系统已独立实测；热度数据以原采集时间为准。');
  }
  if (topicSource && [...records.values()].filter(item => item.url).length < 2) {
    limitations.push('可追溯来源少于两个，尚未完成跨来源核实。');
  }

  // Copy only bounded verbatim quotes that can still be checked against the
  // saved source body. A valid source ID alone is not evidence of entailment.
  const documents = new Map(list(evidence?.documents, MAX_SOURCES)
    .map(item => [text(item?.id, 100), normalized(item?.text)]));
  const quotes = [];
  const claims = list(evidence?.brief?.claims || research?.brief?.claims, 30);
  for (const claim of claims) {
    for (const reference of list(claim?.evidence, 8)) {
      const id = text(reference?.source_id, 100);
      const quote = text(reference?.quote, 351);
      const record = records.get(id);
      const originalUrl = sourceUrl(list(evidence?.sources, MAX_SOURCES).find(item => item?.id === id)?.url);
      if (!record?.url || !documents.get(id) || quote.length < 12 || quote.length > 350
          || (originalUrl && originalUrl !== record.url) || !documents.get(id).includes(normalized(quote))) continue;
      if (!quotes.some(item => item.id === id && item.quote === quote)) quotes.push({ id, quote });
      if (quotes.length >= 30) break;
    }
    if (quotes.length >= 30) break;
  }
  if (claims.length && !quotes.length) limitations.push('研究引文未能与本次保留的原文逐字核对，因此未收入知识正文。');

  const subject = text(script.topic_title || evidence?.topic?.title || (!topicSource ? script.repo : ''), 200);
  const questions = [subject && subject !== fullTitle
    ? `视频《${fullTitle}》对“${subject}”有哪些具体介绍？`
    : `《${fullTitle}》这条视频主要介绍了什么？`];
  const answerExcerpt = contentParagraphs.find(part => part.sceneType !== 'stats') || contentParagraphs[0];
  const lines = [
    `# ${markdownText(fullTitle)}`, '', '## 内容范围', '',
    '本文仅整理这条视频的实际旁白和对应资料。旁白属于创作表述；来源编号表示资料归属，不代表已逐句完成事实核验。',
    '只能据此回答本视频涉及的话题；未提及的社区业务政策、个人信息、实时数据和其他事项不在本文范围内。', '',
    '## 视频内容', '',
  ];
  for (const part of paragraphs) {
    lines.push(markdownText(part.text), `来源编号：${part.sourceIds.length ? part.sourceIds.map(markdownText).join('、') : '原脚本未标明'}`, '');
  }
  if (quotes.length) {
    lines.push('## 对应资料引文', '', '以下仅为已保存原文中的逐字引文，不能代替对视频表述的独立核实。', '');
    for (const item of quotes) lines.push(`来源 ${markdownText(item.id)}：`, ...item.quote.split(/\r?\n/).map(line => `> ${markdownText(line)}`), '');
  }
  lines.push('## 来源记录', '');
  for (const id of citedIds) {
    const item = records.get(id);
    lines.push(`- ${markdownText(id)}${item?.title ? `（${markdownText(item.title)}）` : ''}：${item?.url || '原脚本未保留完整链接'}`);
    if (item?.retrievedAt) lines.push(`  采集时间：${markdownText(item.retrievedAt)}`);
  }
  if (!citedIds.length) lines.push('原脚本未保留来源编号。');
  const collectedAt = text(evidence?.collected_at || research?.collected_at, 100);
  if (collectedAt) lines.push(`资料采集时间：${markdownText(collectedAt)}`);
  const commit = text(evidence?.commit, 100);
  if (/^[a-f0-9]{7,64}$/i.test(commit)) lines.push(`README 版本：${commit}`);
  const createdAt = text(script.created_at, 100);
  if (createdAt) lines.push(`脚本生成时间：${markdownText(createdAt)}`);
  lines.push('', '## 限制与待核实事项', '', '视频解码通过仅说明媒体文件完整，不证明内容事实正确。');
  const editorialStatus = text(script.editorial_status, 300);
  if (editorialStatus) lines.push(`原脚本状态：${markdownText(editorialStatus)}`);
  for (const item of unique(limitations)) lines.push(`- ${markdownText(item)}`);
  // Markdown ingestion splits on headings. Keep the validation question with
  // its literal spoken answer, so exact lexical matches cannot retrieve an
  // isolated question-only chunk. This is an excerpt, not an invented FAQ.
  lines.push('', '## 知识问答', '', `问题：${markdownText(questions[0])}`,
    `答案（摘录实际旁白）：${markdownText(answerExcerpt.text)}`,
    `来源编号：${answerExcerpt.sourceIds.length ? answerExcerpt.sourceIds.map(markdownText).join('、') : '原脚本未标明'}`);

  const document = { schemaVersion: 1, sourceId: text(sourceId, 250), title, body, markdown: `${lines.join('\n')}\n`, questions };
  return { ...document, contentHash: createHash('sha256').update(JSON.stringify(document)).digest('hex') };
}
