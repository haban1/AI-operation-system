/* 文案时间轴：把模板里的每段文字当作“镜头”一样处理。
   - 镜头时间轴下方按出现时间排列文案块，点一下定位预览并在右栏编辑；
   - 手动修改复用“精细调整”里原有的输入框事件（写入工程、自动锁定、标记未保存）；
   - “AI 改写这句”先解锁这段文案，再以 fields 范围发起 AI 修改，其他文案、镜头和音乐不变。 */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const P = window.MontageProduction?.prototype;
  if (!P) return;

  const FIELDS = {
    title: { label: '主标题', max: 28, rows: 2 },
    subtitle: { label: '副标题', max: 56, rows: 2 },
    brand: { label: '品牌 / 署名', max: 24, rows: 1 },
    beat1: { label: '穿插短句 1', max: 16, rows: 1 },
    beat2: { label: '穿插短句 2', max: 16, rows: 1 },
    beat3: { label: '收尾短句', max: 16, rows: 1 },
  };
  const CARD_NAMES = { title: '开场标题', beat1: '短句 1', beat2: '短句 2', beat3: '收尾短句' };
  // 开场标题卡同时显示品牌（小字）、主标题和副标题；其他卡只显示一句
  const cardFields = key => key === 'title' ? ['title', 'subtitle', 'brand'] : [key];
  const aiFields = key => key === 'title' ? ['title', 'subtitle'] : [key];
  const QUICK = ['更简洁', '更有活力', '更口语', '更正式'];
  const sec = value => `${Number(value).toFixed(1)}s`;

  P.captionCards = function () {
    const project = this.state.project;
    if (!project) return [];
    const cards = project.templateSnapshot?.cards || this.state.templates?.find(item => item.id === project.templateId)?.cards || [];
    const offset = Number(project.settings?.textOffset) || 0;
    return cards.map(card => ({ ...card, start: Math.max(0, card.start + offset), end: Math.min(15, card.end + offset) }))
      .filter(card => card.end > card.start && FIELDS[card.key]);
  };

  P.captionLane = function () {
    const track = $('caption-track');
    if (!track) return;
    track.replaceChildren();
    const project = this.state.project;
    const cards = this.captionCards();
    track.hidden = !project || !cards.length;
    if (track.hidden) { this.showCaptionPanel(null); return; }
    const off = project.settings?.titles === false;
    track.classList.toggle('is-off', off);
    const label = document.createElement('span');
    label.className = 'caption-track-label';
    label.textContent = off ? '文案（动态文字已关闭）' : '文案';
    track.append(label);
    const lane = document.createElement('div');
    lane.className = 'caption-lane';
    track.append(lane);
    const locks = project.locks?.fields || [];
    cards.forEach(card => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'caption-chip' + (card.key === this.focusedCaption ? ' selected' : '');
      button.dataset.captionKey = card.key;
      button.style.left = `${(card.start / 15) * 100}%`;
      button.style.width = `${Math.max(6, ((card.end - card.start) / 15) * 100)}%`;
      const text = (project.fields?.[card.key] || '').trim();
      const name = document.createElement('small');
      name.textContent = CARD_NAMES[card.key] + (cardFields(card.key).some(key => locks.includes(key)) ? ' · 已锁定' : '');
      const value = document.createElement('span');
      value.textContent = text || '（空）';
      button.append(name, value);
      button.title = `${CARD_NAMES[card.key]}：${sec(card.start)}–${sec(card.end)}，点击编辑`;
      button.setAttribute('aria-label', `文案 ${CARD_NAMES[card.key]}：${text || '空'}`);
      button.addEventListener('click', () => {
        this.focusedCaption = card.key;
        this.seek(Math.min(449, Math.round((card.start + Math.min(.5, (card.end - card.start) / 2)) * 30)));
        this.timeline();
      });
      lane.append(button);
    });
    if (this.focusedCaption && !cards.some(card => card.key === this.focusedCaption)) this.focusedCaption = null;
    this.showCaptionPanel(cards.find(card => card.key === this.focusedCaption) || null);
  };

  P.showCaptionPanel = function (card) {
    const panel = $('caption-panel'), shot = $('shot-panel');
    if (!panel || !shot) return;
    panel.hidden = !card;
    shot.hidden = !!card;
    document.querySelectorAll('.timeline-shot.selected').forEach(item => item.classList.toggle('dimmed', !!card));
    if (!card) { this.captionSignature = null; return; }
    const project = this.state.project;
    const busy = !!this.state.workflowBusy;
    $('caption-panel-title').textContent = `文案 · ${CARD_NAMES[card.key]}`;
    $('caption-panel-range').textContent = `${sec(card.start)}–${sec(card.end)}`;
    const signature = project.id + ':' + card.key;
    if (signature !== this.captionSignature) {
      this.captionSignature = signature;
      const fields = $('caption-fields');
      fields.replaceChildren();
      for (const key of cardFields(card.key)) {
        const meta = FIELDS[key];
        const wrap = document.createElement('div');
        wrap.className = 'caption-field';
        const head = document.createElement('label');
        head.className = 'field-label';
        head.htmlFor = 'caption-input-' + key;
        head.innerHTML = `<span>${meta.label}</span><span class="caption-count" id="caption-count-${key}"></span>`;
        const input = document.createElement('textarea');
        input.id = 'caption-input-' + key;
        input.rows = meta.rows;
        input.maxLength = meta.max;
        input.dataset.fieldKey = key;
        input.placeholder = key === 'brand' ? '可留空' : `最多 ${meta.max} 字`;
        input.addEventListener('input', () => {
          // 交给精细调整里的原输入框：写入工程、锁定该文案、标记未保存
          const source = $('field-' + key);
          if (!source) return;
          source.value = input.value;
          source.dispatchEvent(new Event('input', { bubbles: true }));
          this.updateCaptionCounts();
        });
        wrap.append(head, input);
        fields.append(wrap);
      }
      $('caption-ai-instruction').value = '';
    }
    for (const key of cardFields(card.key)) {
      const input = $('caption-input-' + key);
      if (input && document.activeElement !== input) input.value = project.fields?.[key] || '';
      if (input) input.disabled = busy;
    }
    this.updateCaptionCounts();
    const lockWrap = $('caption-lock-control');
    lockWrap.replaceChildren();
    const locks = project.locks?.fields || [];
    const keys = aiFields(card.key);
    const lock = document.createElement('label');
    lock.className = 'lock-control';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = keys.some(key => locks.includes(key));
    box.disabled = busy;
    box.addEventListener('change', () => {
      const current = this.workflow.locks();
      current.fields = box.checked ? [...new Set([...current.fields, ...keys])] : current.fields.filter(key => !keys.includes(key));
      this.markDirty(); this.timeline();
    });
    lock.append(box, document.createTextNode('锁定这段文案，AI 重做其他内容时保留'));
    lockWrap.append(lock);
    $('caption-ai-rewrite').disabled = busy;
    $('caption-ai-instruction').disabled = busy;
    document.querySelectorAll('#caption-ai-quick button').forEach(button => { button.disabled = busy; });
  };

  P.updateCaptionCounts = function () {
    document.querySelectorAll('#caption-fields textarea').forEach(input => {
      const count = $('caption-count-' + input.dataset.fieldKey);
      if (count) count.textContent = `${[...input.value].length}/${input.maxLength}`;
    });
  };

  P.rewriteCaption = async function () {
    const key = this.focusedCaption;
    const project = this.state.project;
    if (!key || !project || this.state.workflowBusy) return;
    const keys = aiFields(key);
    const want = $('caption-ai-instruction').value.trim() || '保持原意，表达更简洁、更有吸引力';
    const limits = keys.map(item => `${FIELDS[item].label}不超过 ${FIELDS[item].max} 字`).join('，');
    // 用户明确要求 AI 改这一句：先解锁，否则服务端会拒绝修改已锁定文案
    const locks = this.workflow.locks();
    if (keys.some(item => locks.fields.includes(item))) { locks.fields = locks.fields.filter(item => !keys.includes(item)); this.markDirty(); }
    await this.workflow.start('instruction', { kind: 'fields', ids: keys },
      `只改写「${CARD_NAMES[key]}」的文案（${keys.map(item => FIELDS[item].label).join('、')}）：${want}。${limits}。其他文案、镜头、音乐与设置保持不变。`);
  };

  const timeline = P.timeline;
  P.timeline = function (...args) {
    const result = timeline.apply(this, args);
    this.captionLane();
    return result;
  };

  const bind = P.bind;
  P.bind = function (...args) {
    const result = bind.apply(this, args);
    // 点镜头时回到镜头面板
    $('shot-timeline')?.addEventListener('click', event => {
      if (event.target.closest('[data-slot-id]') && this.focusedCaption) { this.focusedCaption = null; }
    }, true);
    $('caption-back')?.addEventListener('click', () => { this.focusedCaption = null; this.timeline(); });
    $('caption-ai-rewrite')?.addEventListener('click', this.action(() => this.rewriteCaption()));
    const quick = $('caption-ai-quick');
    if (quick) {
      quick.replaceChildren(...QUICK.map(text => {
        const button = document.createElement('button');
        button.type = 'button'; button.className = 'caption-quick'; button.textContent = text;
        button.addEventListener('click', () => { $('caption-ai-instruction').value = text; $('caption-ai-instruction').focus(); });
        return button;
      }));
    }
    return result;
  };
})();
