let activeRequest;
let revision = 0;
const chat = { turns: [], draft: '', platform: 'DOUYIN', channelType: 'DIRECT_MESSAGE', sessionId: null };
const noAnswerText = '当前知识不足以可靠回答，可检查知识资料或换一种问法。';

export function cleanupKnowledgeTools() {
  revision++;
  activeRequest?.abort();
  activeRequest = null;
}

export function resetKnowledgeTools() {
  cleanupKnowledgeTools();
  Object.assign(chat, { turns: [], draft: '', platform: 'DOUYIN', channelType: 'DIRECT_MESSAGE', sessionId: null });
}

export async function renderAnswerProfile(root, { api, esc, isCurrent }) {
  root.innerHTML = '<section class="panel knowledge-tools-page"><p role="status">正在读取人设配置…</p></section>';
  let saved;
  try {
    const data = await api('/api/rag/answer-profile');
    if (!isCurrent()) return;
    saved = data.profile;
    if (!saved) throw new Error('未能读取已保存的人设配置');
  } catch (error) {
    if (!isCurrent()) return;
    root.innerHTML = `<section class="panel knowledge-tools-page"><p role="alert">${esc(error.message)}</p><button class="btn" id="answerProfileRetry">重新加载</button></section>`;
    root.querySelector('button').onclick = () => renderAnswerProfile(root, { api, esc, isCurrent });
    return;
  }
  root.innerHTML = `<section class="panel knowledge-tools-page"><h2>回答风格 / 人设配置</h2><p class="muted">保存后用于正式知识问答和本地 RAG 测试，从下一次提问开始生效。</p>
    <form id="answerProfileForm"><fieldset><div class="knowledge-profile-grid">
      <label>助手名称<input name="assistantName" maxlength="60" required></label><label>公司 / 组织名称<input name="companyName" maxlength="80" required></label>
      <label class="wide">回答风格与人设<textarea name="stylePrompt" maxlength="4000" rows="7" placeholder="例如：你是耐心的答疑助手。先简短回答，再说明必要条件，使用自然的口语。"></textarea></label>
      <label class="wide">问候语<textarea name="greeting" maxlength="240" rows="2" required></textarea></label></div>
      <p class="muted">人设控制称呼、语气和表达；业务事实仍以知识库证据为准。</p><div class="button-row"><button class="btn" type="submit">保存配置</button><button class="btn secondary" type="button" id="answerProfileCancel">撤销未保存修改</button></div></fieldset><p id="answerProfileStatus" role="status" aria-live="polite"></p></form></section>`;
  const form = root.querySelector('form');
  const fill = () => { for (const key of ['assistantName', 'companyName', 'stylePrompt', 'greeting']) form.elements[key].value = saved[key] || ''; };
  fill();
  const status = root.querySelector('#answerProfileStatus');
  root.querySelector('#answerProfileCancel').onclick = () => { fill(); status.textContent = '已撤销未保存的修改'; };
  form.onsubmit = async event => {
    event.preventDefault();
    const profile = Object.fromEntries(['assistantName', 'companyName', 'stylePrompt', 'greeting'].map(key => [key, form.elements[key].value.trim()]));
    form.querySelector('fieldset').disabled = true;
    status.textContent = '正在保存…';
    try {
      const result = await api('/api/rag/answer-profile', { method: 'PUT', body: JSON.stringify(profile) });
      if (!isCurrent()) return;
      if (!result.profile) throw new Error('服务未确认保存结果');
      saved = result.profile;
      fill(); status.textContent = '已保存。可切换到 RAG 问答测试查看效果。';
    } catch (error) {
      if (isCurrent()) status.textContent = '保存未确认：' + error.message + '。输入已保留，可重试。';
    } finally { if (isCurrent()) form.querySelector('fieldset').disabled = false; }
  };
}

export function renderRagPlayground(root, options) {
  const { api, esc, isCurrent } = options;
  const generation = ++revision;
  chat.sessionId ||= crypto.randomUUID();
  root.innerHTML = `<section class="knowledge-tools-page knowledge-playground"><section class="panel"><div class="panel-head"><h2>RAG 问答测试</h2><button class="btn secondary" id="ragTestClear">清空对话</button></div>
    <p class="muted">使用当前生效的知识与已保存的人设，仅在此测试，不向平台发送消息。私信支持最近三轮连续追问，评论按单轮测试。</p>
    <div class="knowledge-test-settings"><label>平台<select id="ragTestPlatform"><option value="DOUYIN">抖音</option><option value="WEIBO">微博</option><option value="BILIBILI">B站</option><option value="WECHAT_CHANNELS">视频号</option></select></label><label>问答场景<select id="ragTestChannel"><option value="DIRECT_MESSAGE">私信 · 连续对话</option><option value="COMMENT">评论 · 单轮问答</option></select></label></div>
    <div id="ragTestMessages" class="knowledge-test-messages" role="log" aria-label="测试问答记录"></div>
    <form id="ragTestForm"><label for="ragTestQuestion">测试问题</label><textarea id="ragTestQuestion" maxlength="4000" rows="3" required placeholder="输入问题，查看知识库会如何回答…"></textarea><div class="knowledge-test-submit"><p id="ragTestStatus" role="status" aria-live="polite"></p><button class="btn" type="submit">开始测试</button></div></form></section></section>`;
  const messages = root.querySelector('#ragTestMessages');
  const display = () => {
    messages.innerHTML = chat.turns.length ? chat.turns.map(({ question, response }) => {
      const sources = response.grounding?.sourceReferences || [];
      const answered = response.result === 'ANSWERED';
      return `<article class="knowledge-test-turn"><div class="knowledge-test-question"><b>我的提问</b><p>${esc(question)}</p></div><div class="knowledge-test-answer"><b>${answered ? '知识库回答' : '未找到可靠答案'}</b><p>${esc(answered ? response.answer?.text || '' : noAnswerText)}</p>
        ${sources.length ? `<details><summary>查看引用来源（${sources.length}）</summary>${sources.map(source => `<div class="knowledge-test-source"><strong>${esc(source.title || source.documentId)}</strong><small>${esc([source.page && '第 ' + source.page + ' 页', source.sheet, source.rowStart && '第 ' + source.rowStart + ' 行'].filter(Boolean).join(' · '))}</small><p>${esc(source.excerpt || '')}</p></div>`).join('')}</details>` : ''}
        <details><summary>测试详情</summary><dl><dt>结果</dt><dd>${esc(response.result)}</dd>${response.reasonCode ? `<dt>原因</dt><dd>${esc(response.reasonCode)}</dd>` : ''}<dt>耗时</dt><dd>${esc(response.meta?.latencyMs ?? '—')} ms</dd><dt>知识索引</dt><dd>${esc(response.meta?.knowledgeVersion || '—')}</dd><dt>追踪 ID</dt><dd>${esc(response.traceId || '—')}</dd></dl></details></div></article>`;
    }).join('') : '<div class="empty">输入一个问题，开始测试知识库问答效果。</div>';
  };
  display();
  messages.scrollTop = messages.scrollHeight;
  const form = root.querySelector('form'), question = root.querySelector('#ragTestQuestion');
  const platform = root.querySelector('#ragTestPlatform'), channel = root.querySelector('#ragTestChannel');
  platform.value = chat.platform; channel.value = chat.channelType; question.value = chat.draft;
  question.oninput = () => { chat.draft = question.value; };
  const reset = () => {
    cleanupKnowledgeTools(); chat.turns = []; chat.draft = ''; chat.sessionId = crypto.randomUUID();
    renderRagPlayground(root, options);
  };
  root.querySelector('#ragTestClear').onclick = reset;
  platform.onchange = () => { chat.platform = platform.value; reset(); };
  channel.onchange = () => { chat.channelType = channel.value; reset(); };
  form.onsubmit = async event => {
    event.preventDefault();
    const text = question.value.trim(); if (!text || activeRequest) return;
    const status = root.querySelector('#ragTestStatus');
    const current = () => isCurrent() && revision === generation;
    const controller = new AbortController(); activeRequest = controller;
    form.querySelector('button').disabled = true; question.disabled = true; platform.disabled = true; channel.disabled = true;
    status.textContent = '正在检索知识并生成回答…';
    // Include the actual displayed no-answer response so topic continuity is honest.
    const turns = chat.turns.slice(-3);
    let context = turns.flatMap(turn => [{ role: 'USER', text: turn.question }, { role: 'ASSISTANT', text: turn.response.answer?.text || noAnswerText }]);
    while (context.reduce((n, item) => n + [...item.text].length, 0) > 12000) context.splice(0, 2);
    try {
      const result = await api('/api/rag/test-query', { method: 'POST', signal: controller.signal, body: JSON.stringify({ text, sessionId: chat.sessionId, platform: chat.platform, channelType: chat.channelType, context: chat.channelType === 'COMMENT' ? [] : context }) });
      if (!current()) return;
      if (!['ANSWERED', 'NO_ANSWER'].includes(result.response?.result)) throw new Error('测试服务未返回有效结果');
      chat.turns.push({ question: text, response: result.response });
      chat.turns = chat.turns.slice(-30);
      chat.draft = ''; question.value = ''; display(); messages.scrollTop = messages.scrollHeight;
      status.textContent = '测试完成'; question.disabled = false; question.focus();
    } catch (error) {
      if (current()) status.textContent = '测试失败：' + error.message + '。问题已保留，可重试。';
    } finally {
      if (activeRequest === controller) activeRequest = null;
      if (current()) { form.querySelector('button').disabled = false; question.disabled = false; platform.disabled = false; channel.disabled = false; }
    }
  };
}
