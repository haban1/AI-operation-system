(() => {
  'use strict';
  const fieldNames = { title: '主标题', subtitle: '副标题', brand: '品牌', accent: '主题色', beat1: '短句 1', beat2: '短句 2', beat3: '收尾短句' };
  const settingNames = { titles: '动态文字', brand: '品牌标记', intensity: '动效强度', textOffset: '文字时间', layerOrder: '图层顺序' };
  const $ = id => document.getElementById(id);

  window.MontageWorkflow = class {
    constructor({ state, api, saveProject, setProject, markDirty, renderAssets, toast, showError, resource, updateStatus }) {
      Object.assign(this, { state, api, saveProject, setProject, markDirty, renderAssets, toast, showError, resource, updateStatus });
      this.busy = false;
      this.projectId = null;
      this.run = null;
      this.timer = null;
      this.bind();
    }

    action(callback) {
      return async event => {
        try { await callback(event); }
        catch (error) { this.showError(error); }
      };
    }

    locks() {
      const project = this.state.project;
      project.locks ||= { slots: [], fields: [], audio: false, settings: [] };
      return project.locks;
    }

    lock(kind, target) {
      if (!this.state.project) return;
      const locks = this.locks();
      if (kind === 'audio') locks.audio = true;
      else if (!locks[kind].includes(target)) locks[kind].push(target);
      this.renderLocks();
    }

    makeLock(kind, target, label) {
      const wrapper = document.createElement('label');
      wrapper.className = 'lock-control';
      wrapper.dataset.lockKind = kind;
      wrapper.dataset.lockTarget = target || '';
      const input = document.createElement('input');
      input.type = 'checkbox';
      const locks = this.locks();
      input.checked = kind === 'audio' ? locks.audio : locks[kind].includes(target);
      input.addEventListener('change', () => {
        if (kind === 'audio') locks.audio = input.checked;
        else locks[kind] = input.checked ? [...new Set([...locks[kind], target])] : locks[kind].filter(id => id !== target);
        this.markDirty();
        if (kind === 'slots') this.decorateSlots();
      });
      wrapper.append(input, document.createTextNode(label));
      return wrapper;
    }

    renderLocks() {
      if (!this.state.project) return;
      document.querySelectorAll('.lock-control').forEach(element => element.remove());
      for (const key of Object.keys(fieldNames)) $('field-' + key)?.after(this.makeLock('fields', key, '锁定，AI 重做时保留'));
      for (const key of Object.keys(settingNames)) {
        const element = $(key === 'textOffset' ? 'text-offset' : key === 'layerOrder' ? 'layer-order' : 'setting-' + key);
        const anchor = ['intensity', 'textOffset', 'layerOrder'].includes(key) ? element : element?.closest('label');
        anchor?.after(this.makeLock('settings', key, '锁定此设置'));
      }
      $('soundtrack-info').after(this.makeLock('audio', null, '锁定音乐与音量'));
      this.decorateSlots();
    }

    decorateSlots() {
      if (!this.state.project) return;
      document.querySelectorAll('.slot-card').forEach(card => {
        card.querySelectorAll('.lock-control, .slot-ai-redo').forEach(element => element.remove());
        const id = card.dataset.slotId;
        const wrapper = document.createElement('div');
        wrapper.className = 'ai-actions slot-ai-redo';
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'text-button';
        button.textContent = 'AI 换一个镜头';
        button.disabled = this.busy || this.locks().slots.includes(id);
        button.title = this.locks().slots.includes(id) ? '取消画面锁定后可重新生成' : '仅重新选择此画面';
        button.addEventListener('click', this.action(() => this.start('regenerate', { kind: 'slots', ids: [id] }, '为这个画面重新挑选合适的镜头，尽量使用不同素材或不同取材区间。')));
        wrapper.append(this.makeLock('slots', id, '锁定画面'), button);
        card.append(wrapper);
      });
    }

    render() {
      const project = this.state.project;
      $('ai-workflow').hidden = !project;
      $('history-button').disabled = !project || this.busy;
      if (!project) {
        clearTimeout(this.timer);
        this.projectId = null;
        this.busy = false;
        this.run = null;
        this.updateBusy();
        return;
      }
      const brief = project.brief || { request: '', facts: '', subject: '', assetIds: [] };
      $('ai-brief').value = brief.request;
      $('ai-facts').value = brief.facts;
      $('ai-subject').value = brief.subject;
      $('ai-candidate-summary').textContent = `AI 可从 ${brief.assetIds.length} 份素材中挑选`;
      const scope = $('ai-scope');
      const previous = scope.value;
      scope.replaceChildren();
      const choices = [['all', '全部未锁定内容'], ['fields', '仅文案'], ['audio', '仅音乐'],
        ...project.slots.map((slot, index) => [slot.id, `仅第 ${index + 1} 个镜头`])];
      choices.forEach(([value, text]) => { const option = document.createElement('option'); option.value = value; option.textContent = text; scope.append(option); });
      if (choices.some(([value]) => value === previous)) scope.value = previous;
      this.renderLocks();
      if (this.projectId !== project.id) {
        this.projectId = project.id;
        clearTimeout(this.timer);
        this.busy = false;
        this.run = null;
        this.refreshRuns().catch(error => this.showError(error));
      }
      this.updateBusy();
    }

    updateBrief() {
      const project = this.state.project;
      if (!project) return;
      project.brief ||= { request: '', facts: '', subject: '', assetIds: [] };
      project.brief.request = $('ai-brief').value;
      project.brief.facts = $('ai-facts').value;
      project.brief.subject = $('ai-subject').value;
      this.markDirty();
    }

    updateBusy() {
      this.state.workflowBusy = this.busy;
      $('editor-form').inert = this.busy;
      for (const id of ['ai-brief', 'ai-facts', 'ai-subject', 'ai-candidates-button', 'ai-generate', 'ai-regenerate', 'ai-scope', 'ai-instruction', 'ai-adjust', 'ai-adjust-scope', 'history-button','back-to-projects']) {
        $(id).disabled = this.busy || !this.state.project;
      }
      $('ai-cancel').hidden = !this.busy || !this.run;
      const source = this.state.sourceFolders?.find(item => item.id === this.state.project?.brief?.sourceId);
      if (source && source.status !== 'ready') $('ai-generate').disabled = true;
      this.updateStatus();
    }

    scope() {
      const value = $('ai-scope').value;
      if (value === 'fields') return { kind: 'fields', ids: Object.keys(fieldNames) };
      if (value.startsWith('shot-')) return { kind: 'slots', ids: [value] };
      return { kind: value, ids: [] };
    }

    async start(mode, scope, instruction) {
      if (this.busy || !this.state.project) return;
      this.busy = true;
      this.updateBusy();
      const id = this.state.project.id;
      try {
        const project = this.state.dirty ? await this.saveProject({ quiet: true }) : this.state.project;
        if (!project || this.state.project?.id !== id || this.state.dirty) throw new Error('工程已切换或有未保存修改，请重新操作。');
        const { run } = await this.api(`/api/projects/${id}/ai-runs`, { method: 'POST', body: JSON.stringify({
          expectedRevision: project.revision, mode, scope, instruction, requestId: crypto.randomUUID(),
        }) });
        this.run = run;
        this.displayRun(run);
        $('ai-instruction').value = '';
        this.updateBusy();
        await this.poll(run.id, id);
      } catch (error) {
        this.busy = false;
        this.updateBusy();
        throw error;
      }
    }

    displayRun(run) {
      const element = $('ai-run-status');
      const scope = run.scope?.kind === 'slots' ? `仅修改${run.scope.ids.map(id => '镜头 '+(this.state.project.slots.findIndex(slot=>slot.id===id)+1)).join('、')}。` : '';
      element.textContent = scope + (run.error || run.message || '') + (run.warnings?.length ? ` 提示：${run.warnings.join('；')}` : '');
      element.classList.toggle('is-error', ['failed', 'conflict'].includes(run.status));
    }

    async poll(id, projectId) {
      clearTimeout(this.timer);
      if (this.state.project?.id !== projectId) return;
      try {
        const { run } = await this.api('/api/ai-runs/' + id);
        if (this.state.project?.id !== projectId) return;
        this.run = run;
        this.displayRun(run);
        this.busy = ['queued', 'running'].includes(run.status);
        this.updateBusy();
        if (this.busy) this.timer = setTimeout(() => this.poll(id, projectId), 1200);
        else {
          if (run.status === 'succeeded') {
            const bootstrap = await this.api('/api/bootstrap');
            this.state.assets = bootstrap.assets;
            this.renderAssets();
            const { project } = await this.api('/api/projects/' + projectId);
            this.setProject(project);
            this.toast(run.changes.length ? `AI 修改已保存为修订 ${project.revision}` : '本次没有修改工程');
          }
          await this.refreshRuns();
        }
      } catch (error) {
        if (this.state.project?.id !== projectId) return;
        $('ai-run-status').textContent = '任务状态暂时无法读取，正在重试';
        this.timer = setTimeout(() => this.poll(id, projectId), 3500);
      }
    }

    async refreshRuns() {
      const projectId = this.state.project?.id;
      if (!projectId) return;
      const { runs } = await this.api(`/api/projects/${projectId}/ai-runs`);
      if (this.state.project?.id !== projectId) return;
      $('ai-conversation').replaceChildren();
      const labels = { succeeded: '已应用', cancelled: '已取消', failed: '未应用', conflict: '修订冲突', running: '处理中', queued: '等待中' };
      runs.slice(0, 5).forEach(run => {
        const article = document.createElement('article');
        const title = document.createElement('small');
        title.textContent = `${labels[run.status] || run.status}${run.resultRevision ? ` · 修订 ${run.resultRevision}` : ''}`;
        const instruction = document.createElement('p');
        instruction.textContent = run.instruction || '按制作要求生成初稿';
        const response = document.createElement('p');
        response.textContent = run.error || run.message;
        article.append(title, instruction, response);
        if (run.changes.length) {
          const changes = document.createElement('small');
          changes.textContent = '已修改 ' + run.changes.map(change => fieldNames[change.target] || settingNames[change.target] || (change.target.startsWith('shot-') ? `镜头 ${change.target.slice(5)}` : '音乐')).join('、');
          article.append(changes);
        }
        run.warnings.forEach(message => { const warning = document.createElement('p'); warning.textContent = message; article.append(warning); });
        $('ai-conversation').append(article);
      });
      const active = runs.find(run => ['queued', 'running'].includes(run.status));
      if (active) {
        this.run = active;
        this.busy = true;
        this.updateBusy();
        this.poll(active.id, projectId);
      }
    }

    openCandidates() {
      const project = this.state.project;
      if (!project) return;
      project.brief ||= { request: '', facts: '', subject: '', assetIds: [] };
      const chosen = new Set(project.brief.assetIds);
      $('candidate-list').replaceChildren();
      (this.state.project.brief?.sourceId ? this.state.sourceItems || [] : this.state.assets.filter(asset => asset.type !== 'audio')).forEach(asset => {
        const label = document.createElement('label'); label.className = 'candidate-row';
        const input = document.createElement('input'); input.type = 'checkbox'; input.value = asset.id; input.checked = chosen.has(asset.id);
        const name = document.createElement('strong'); name.textContent = asset.name;
        const detail = document.createElement('small'); detail.textContent = [asset.description, asset.subject, ...(asset.tags || [])].filter(Boolean).join(' · ') || '可在我的素材中添加画面说明';
        const text = document.createElement('span'); text.append(name, detail); label.append(input); if (asset.thumbnailUrl) { const image = document.createElement('img'); image.src = asset.thumbnailUrl; image.alt = ''; label.append(image); } label.append(text); $('candidate-list').append(label);
      });
      $('candidate-dialog').showModal();
    }

    async openNotes(id) {
      const asset = this.state.assets.find(item => item.id === id);
      if (!asset) return;
      this.notesAsset = asset;
      $('asset-notes-name').textContent = asset.name;
      $('asset-description').value = asset.description || '';
      $('asset-subject').value = asset.subject || '';
      $('asset-tags').value = (asset.tags || []).join('，');
      $('asset-notes-status').textContent = '';
      $('asset-notes-dialog').showModal();
    }

    async openHistory() {
      if (!this.state.project || this.busy) return;
      if (this.state.dirty) await this.saveProject({ quiet: true });
      const id = this.state.project.id;
      const { revisions } = await this.api(`/api/projects/${id}/revisions`);
      $('history-list').replaceChildren();
      revisions.forEach(revision => {
        const row = document.createElement('div'); row.className = 'history-row';
        const text = document.createElement('div');
        const title = document.createElement('strong'); title.textContent = `修订 ${revision.revision}${revision.revision === this.state.project.revision ? ' · 当前' : ''}`;
        const description = document.createElement('p'); description.textContent = revision.summary;
        const time = document.createElement('small'); time.textContent = new Date(revision.updatedAt).toLocaleString(); text.append(title, description, time);
        const preview = document.createElement('a'); preview.className = 'text-button'; preview.target = '_blank'; preview.rel = 'noopener'; preview.textContent = '预览'; preview.href = this.resource(`/api/projects/${id}/preview?revision=${revision.revision}`);
        const restore = document.createElement('button'); restore.className = 'button button-quiet'; restore.textContent = '恢复'; restore.disabled = revision.revision === this.state.project.revision;
        restore.addEventListener('click', this.action(async () => {
          if (this.state.project?.id !== id) throw new Error('当前工程已切换，请重新打开修订记录');
          restore.disabled = true;
          try {
            const { project } = await this.api(`/api/projects/${id}/restore`, { method: 'POST', body: JSON.stringify({ expectedRevision: this.state.project.revision, revision: revision.revision }) });
            this.setProject(project); $('history-dialog').close(); this.toast(`已恢复为新修订 ${project.revision}`);
          } finally { restore.disabled = false; }
        }));
        row.append(text, preview, restore); $('history-list').append(row);
      });
      $('history-dialog').showModal();
    }

    async status() {
      try {
        const result = await this.api('/api/ai/status');
        $('ai-provider-status').textContent = result.message;
        $('ai-provider-status').title = result.version || '';
      } catch { $('ai-provider-status').textContent = 'AI 连接暂不可用'; }
    }

    bind() {
      ['ai-brief', 'ai-facts', 'ai-subject'].forEach(id => $(id).addEventListener('input', () => this.updateBrief()));
      $('ai-candidates-button').addEventListener('click', () => this.openCandidates());
      $('candidate-close').addEventListener('click', () => $('candidate-dialog').close());
      $('candidate-all').addEventListener('click', () => $('candidate-list').querySelectorAll('input').forEach(input => { input.checked = true; }));
      $('candidate-none').addEventListener('click', () => $('candidate-list').querySelectorAll('input').forEach(input => { input.checked = false; }));
      $('candidate-done').addEventListener('click', () => {
        this.state.project.brief.assetIds = [...$('candidate-list').querySelectorAll('input:checked')].map(input => input.value);
        this.markDirty(); this.render(); this.onWorkspace?.(); $('candidate-dialog').close();
      });
      $('ai-generate').addEventListener('click', this.action(() => this.start('generate', { kind: 'all', ids: [] }, '')));
      $('ai-regenerate').addEventListener('click', this.action(() => this.start('regenerate', this.scope(), '按当前制作要求重新生成选定范围，尽量使用不同的合适候选。')));
      $('ai-adjust').addEventListener('click', this.action(() => {
        const value = $('ai-adjust-scope').value;
        const scope = value === 'selected' ? { kind: 'slots', ids: [document.querySelector('.timeline-shot.selected')?.dataset.slotId || this.state.project.slots[0].id] } : value === 'fields' ? { kind: 'fields', ids: Object.keys(fieldNames) } : { kind: value, ids: [] };
        return this.start('instruction', scope, $('ai-instruction').value.trim());
      }));
      $('ai-cancel').addEventListener('click', this.action(async () => { if (this.run) await this.api(`/api/ai-runs/${this.run.id}/cancel`, { method: 'POST', body: '{}' }); }));
      $('asset-notes-close').addEventListener('click', () => $('asset-notes-dialog').close());
      $('asset-notes-form').addEventListener('submit', this.action(async event => {
        event.preventDefault();
        $('asset-notes-save').disabled = true;
        try {
          const { asset } = await this.api(`/api/assets/${this.notesAsset.id}/notes`, { method: 'PUT', body: JSON.stringify({ expectedRevision: this.notesAsset.notesRevision || 0, description: $('asset-description').value, subject: $('asset-subject').value, tags: $('asset-tags').value.split(/[,，]/).map(value => value.trim()).filter(Boolean) }) });
          this.state.assets[this.state.assets.findIndex(item => item.id === asset.id)] = asset;
          this.renderAssets(); $('asset-notes-dialog').close(); this.toast('素材说明已保存');
        } finally { $('asset-notes-save').disabled = false; }
      }));
      $('history-button').addEventListener('click', this.action(() => this.openHistory()));
      $('history-close').addEventListener('click', () => $('history-dialog').close());
    }
  };
})();
