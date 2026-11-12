(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const storage = 'montage-production:' + location.pathname;
  const content = project => JSON.stringify({ name: project.name, fields: project.fields, slots: project.slots, audio: project.audio, settings: project.settings, locks: project.locks, brief: project.brief });

  window.MontageProduction = class {
    constructor(adapters) {
      Object.assign(this, adapters);
      this.snapshots = [];
      this.cursor = -1;
      this.sourceEpoch = 0;
      this.sourceTimer = null;
      this.restoring = false;
      this.bind();
    }

    action(callback) {
      return async event => {
        try { await callback(event); }
        catch (error) { this.showError(error); }
      };
    }

    candidates() {
      const sourceId = this.state.project?.brief?.sourceId;
      return sourceId ? this.state.sourceItems || [] : this.state.assets.filter(asset => asset.type !== 'audio');
    }

    renderSources() {
      const sources = this.state.sourceFolders || [];
      const preferred = this.state.project?.brief?.sourceId || $('source-select').value || localStorage.getItem(storage + ':source') || sources.find(source => source.status === 'ready')?.id || '';
      const selected = this.state.project ? this.state.project.brief?.sourceId || '' : preferred;
      for (const id of ['source-select', 'new-project-source']) {
        const select = $(id);
        select.replaceChildren(new Option(id === 'source-select' ? '选择素材文件夹' : '使用项目已有素材', ''));
        sources.forEach(source => select.add(new Option(source.name + ` · ${source.count} 份素材`, source.id)));
        const value = id === 'new-project-source' ? preferred : selected;
        if (sources.some(source => source.id === value)) select.value = value;
      }
    }

    async loadSource(id, { useAll = false, excluded = [] } = {}) {
      const epoch = ++this.sourceEpoch;
      clearTimeout(this.sourceTimer);
      if (!id) {
        this.state.sourceItems = [];
        $('source-status').textContent = '连接一次，新工程可继续使用。';
        return;
      }
      const { source } = await this.api('/api/source-folders/' + id);
      if (epoch !== this.sourceEpoch) return;
      $('source-status').textContent = `${source.name} · ${source.message || source.status}`;
      $('source-status').title = source.folderPath;
      const index = this.state.sourceFolders.findIndex(item => item.id === id);
      if (index >= 0) this.state.sourceFolders[index] = source;
      else this.state.sourceFolders.push(source);
      if (source.status === 'indexing') {
        $('ai-generate').disabled = true;
        this.sourceTimer = setTimeout(() => this.loadSource(id, { useAll, excluded }).catch(this.showError), 900);
        return;
      }
      const { items } = await this.api(`/api/source-folders/${id}/items`);
      if (epoch !== this.sourceEpoch) return;
      this.state.sourceItems = items;
      this.renderSources();
      const project = this.state.project;
      if (useAll && project) {
        project.brief ||= { request: '', facts: '', subject: '', assetIds: [] };
        const previous = JSON.stringify([project.brief.sourceId, project.brief.assetIds]);
        project.brief.sourceId = id;
        project.brief.assetIds = items.filter(item => !excluded.includes(item.id)).map(item => item.id);
        if (JSON.stringify([project.brief.sourceId, project.brief.assetIds]) !== previous) this.markDirty();
      }
      if (source.warnings.length) $('source-status').textContent += `，${source.warnings.length} 项跳过`;
      $('ai-generate').disabled = !project || this.state.workflowBusy || source.status !== 'ready';
      this.refreshEditor();
    }

    async connect(picker, forNewProject = false) {
      $('source-choose').disabled = true;
      $('source-connect').disabled = true;
      if (forNewProject) $('create-project-submit').disabled = true;
      try {
        const route = picker ? '/api/source-folders/choose' : '/api/source-folders';
        const { source } = await this.api(route, { method: 'POST', body: JSON.stringify(picker ? {} : { folderPath: $('source-path').value.trim() }) });
        localStorage.setItem(storage + ':source', source.id);
        this.state.sourceFolders = [source, ...this.state.sourceFolders.filter(item => item.id !== source.id)];
        this.renderSources();
        if (forNewProject) {
          let indexed = source;
          while (indexed.status === 'indexing') {
            $('new-project-source-status').textContent = indexed.message;
            await new Promise(resolve => setTimeout(resolve, 800));
            indexed = (await this.api('/api/source-folders/' + source.id)).source;
          }
          this.state.sourceFolders[this.state.sourceFolders.findIndex(item => item.id === source.id)] = indexed;
          this.renderSources();
          $('new-project-source').value = source.id;
          $('new-project-source-status').textContent = indexed.message;
          return;
        }
        $('source-select').value = source.id;
        $('new-project-source').value = source.id;
        $('source-path-form').hidden = true;
        await this.loadSource(source.id, { useAll: !forNewProject });
      } catch (error) {
        if (error.code === 'FOLDER_PICKER_UNAVAILABLE') $('source-path-form').hidden = false;
        throw error;
      } finally {
        $('source-choose').disabled = false;
        $('source-connect').disabled = false;
        if (forNewProject) $('create-project-submit').disabled = false;
      }
    }

    render() {
      const project = this.state.project;
      $('review-tools').hidden = !project;
      if (!project) { this.onWorkspace?.(); return; }
      if (!this.state.dirty && !this.restoring) this.savedContent = content(project);
      $('audio-offset').value = project.audio.offset || 0;
      $('text-offset').value = project.settings.textOffset || 0;
      $('layer-order').value = (project.settings.layerOrder || ['brand', 'text', 'media']).join(',');
      $('adjust-source-status').textContent = project.brief?.sourceId ? '素材来源保存在工程内，可重新扫描或更换文件夹。' : '当前工程使用已导入的本地素材。';
      if (this.projectId !== project.id) {
        this.projectId = project.id;
        this.snapshots = [structuredClone(project)];
        this.cursor = 0;
        this.showDraft();
        this.renderSources();
        this.loadSource(project.brief?.sourceId).catch(this.showError);
      } else if (!this.restoring && content(this.snapshots[this.cursor]) !== content(project)) {
        this.snapshots = this.snapshots.slice(0, this.cursor + 1);
        this.snapshots.push(structuredClone(project));
        this.cursor += 1;
      }
      this.updateUndo();
      this.timeline();
    }

    changed() {
      if (!this.state.project || this.restoring) return;
      const project = this.state.project;
      localStorage.setItem(storage + ':draft:' + project.id, JSON.stringify({ revision: project.revision, project }));
      if (content(this.snapshots[this.cursor] || project) !== content(project)) {
        this.snapshots = this.snapshots.slice(0, this.cursor + 1);
        this.snapshots.push(structuredClone(project));
        if (this.snapshots.length > 80) this.snapshots.shift();
        this.cursor = this.snapshots.length - 1;
      }
      this.updateUndo();
      this.timeline();
    }

    updateUndo() {
      $('undo-button').disabled = this.cursor <= 0 || this.state.workflowBusy;
      $('redo-button').disabled = this.cursor >= this.snapshots.length - 1 || this.state.workflowBusy;
    }

    saved(project) {
      this.savedContent = content(project);
      localStorage.removeItem(storage + ':draft:' + project.id);
      $('draft-recovery').hidden = true;
    }

    showDraft() {
      let draft;
      try { draft = JSON.parse(localStorage.getItem(storage + ':draft:' + this.state.project.id)); } catch {}
      this.draft = draft?.revision === this.state.project.revision ? draft.project : null;
      $('draft-recovery').hidden = !this.draft;
    }

    applyLocal(snapshot) {
      const current = this.state.project;
      const restored = { ...structuredClone(snapshot), id: current.id, revision: current.revision, updatedAt: current.updatedAt };
      this.restoring = true;
      this.setProject(restored);
      this.markDirty();
      this.state.dirty = content(restored) !== this.savedContent;
      this.refreshEditor();
      this.restoring = false;
      if (this.state.dirty) {
        localStorage.setItem(storage + ':draft:' + current.id, JSON.stringify({ revision: current.revision, project: restored }));
      } else {
        this.setProject(restored);
        this.saved(restored);
      }
      this.updateUndo();
    }

    timeline() {
      const project = this.state.project;
      $('shot-timeline').replaceChildren();
      if (!project) return;
      const selectedIndex = Math.max(0, project.slots.findIndex(slot => slot.id === this.focusedSlot));
      this.focusedSlot = project.slots[selectedIndex].id;
      project.slots.forEach((slot, index) => {
        const asset = this.state.assets.find(item => item.id === slot.assetId);
        const definition = project.templateSnapshot.slots[index];
        const button = document.createElement('button');
        button.className = 'timeline-shot' + (slot.id === this.focusedSlot ? ' selected' : '');
        button.type = 'button'; button.draggable = true;
        button.dataset.slotId = slot.id;
        const segmentFrames = (project.templateSnapshot.slots[index + 1]?.startFrame ?? project.durationFrames) - definition.startFrame;
        button.style.flexGrow = segmentFrames;
        button.title = `镜头 ${index + 1}：${(definition.startFrame / 30).toFixed(1)}–${((definition.startFrame + definition.durationFrames) / 30).toFixed(1)} 秒，含模板转场重叠；原片取材 ${(slot.inPoint || 0).toFixed(2)} 秒开始`;
        button.setAttribute('aria-label', `镜头 ${index + 1}，${asset?.name || '等待 AI 选择'}`);
        if (asset?.thumbnailUrl) {
          const img = document.createElement('img'); img.src = asset.type === 'video' ? this.resource(`/api/assets/${asset.id}/frame?time=${Number(slot.inPoint || 0).toFixed(2)}`) : asset.thumbnailUrl; img.alt = ''; button.append(img);
        }
        const text = document.createElement('span');
        text.textContent = `${String(index + 1).padStart(2,'0')} · ${(segmentFrames / 30).toFixed(1)}s`;
        button.append(text);
        button.addEventListener('click', () => { this.seek(definition.startFrame); $('adjust-open').textContent = `调整镜头 ${index + 1}`; this.focusedSlot = slot.id; this.timeline(); });
        button.addEventListener('dragstart', event => event.dataTransfer.setData('text/plain', slot.id));
        button.addEventListener('keydown', event => {
          if (!event.altKey || !['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
          event.preventDefault();
          const target = project.slots[index + (event.key === 'ArrowLeft' ? -1 : 1)];
          if (target) this.swapSlots(slot.id, target.id);
        });
        button.addEventListener('dragover', event => { event.preventDefault(); event.dataTransfer.dropEffect = event.dataTransfer.types.includes('application/x-montage-asset') ? 'copy' : 'move'; button.classList.add('drop-target'); });
        button.addEventListener('dragleave', () => button.classList.remove('drop-target'));
        button.addEventListener('drop', this.action(async event => {
          event.preventDefault();
          button.classList.remove('drop-target');
          if (this.state.workflowBusy) return;
          const plain = event.dataTransfer.getData('text/plain');
          const assetId = event.dataTransfer.getData('application/x-montage-asset') || (plain.startsWith('montage-asset:') ? plain.slice(14) : '');
          if (assetId) return this.replaceAsset(assetId, slot.id);
          const from = project.slots.find(item => item.id === event.dataTransfer.getData('text/plain'));
          if (!from || from.id === slot.id) return;
          this.swapSlots(from.id, slot.id);
        }));
        $('shot-timeline').append(button);
      });
      this.onWorkspace?.();
    }

    swapSlots(fromId, toId) {
      if (this.state.workflowBusy) return;
      const from = this.state.project.slots.find(slot => slot.id === fromId);
      const to = this.state.project.slots.find(slot => slot.id === toId);
      const first = { ...from }, second = { ...to };
      Object.assign(from, second, { id: first.id }); Object.assign(to, first, { id: second.id });
      this.workflow.lock('slots', from.id); this.workflow.lock('slots', to.id);
      this.markDirty(); this.refreshEditor();
    }

    bind() {
      $('new-project-folder').addEventListener('click', this.action(() => this.connect(true, true)));
      $('creation-music-restore').addEventListener('click', () => $('restore-template-music').click());
      $('source-choose').addEventListener('click', this.action(() => this.connect(true)));
      $('source-connect').addEventListener('click', this.action(() => this.connect(false)));
      $('source-path-toggle').addEventListener('click', () => { $('source-path-form').hidden = !$('source-path-form').hidden; });
      $('source-select').addEventListener('change', this.action(() => {
        const id = $('source-select').value;
        localStorage.setItem(storage + ':source', id);
        if (!id && this.state.project?.brief) {
          delete this.state.project.brief.sourceId;
          this.state.project.brief.assetIds = this.state.assets.filter(asset => asset.type !== 'audio').map(asset => asset.id);
          this.markDirty(); this.workflow.render();
        }
        return this.loadSource(id, { useAll: true });
      }));
      $('source-refresh').addEventListener('click', this.action(async () => {
        const id = $('source-select').value;
        if (!id) return this.toast('先选择素材来源文件夹');
        await this.api(`/api/source-folders/${id}/scan`, { method: 'POST', body: '{}' });
        const selected = new Set(this.state.project?.brief?.assetIds || []);
        const excluded = this.state.project ? (this.state.sourceItems || []).filter(item => !selected.has(item.id)).map(item => item.id) : [];
        await this.loadSource(id, { useAll: true, excluded });
      }));
      $('adjust-open').addEventListener('click', () => {
        $('adjust-dialog').showModal();
        if (this.focusedSlot) document.querySelector(`[data-slot-id="${this.focusedSlot}"]`)?.scrollIntoView({ block: 'center' });
      });
      $('adjust-close').addEventListener('click', () => $('adjust-dialog').close());
      $('manual-import').addEventListener('click', () => $('file-input').click());
      $('relink-sources').addEventListener('click', this.action(async () => {
        const { source } = await this.api('/api/source-folders/choose', { method: 'POST', body: '{}' });
        const repaired = await this.api('/api/assets/relink-folder', { method: 'POST', body: JSON.stringify({ sourceId: source.id }) });
        this.state.assets = repaired.assets;
        this.toast(`已恢复 ${repaired.restored} 份同内容素材`);
        await this.loadSource(source.id, { useAll: true });
      }));
      $('restore-template-music').addEventListener('click', () => {
        Object.assign(this.state.project.audio, { assetId: null, trackId: 'template', inPoint: 0, offset: 0 });
        this.workflow.lock('audio'); this.markDirty(); this.refreshEditor();
      });
      for (const [id, group, key] of [['audio-offset', 'audio', 'offset'], ['text-offset', 'settings', 'textOffset']]) {
        $(id).addEventListener('input', () => { this.state.project[group][key] = Number($(id).value); this.workflow.lock(group === 'audio' ? 'audio' : 'settings', key); this.markDirty(); });
      }
      $('layer-order').addEventListener('change', () => { this.state.project.settings.layerOrder = $('layer-order').value.split(','); this.workflow.lock('settings', 'layerOrder'); this.markDirty(); });
      $('undo-button').addEventListener('click', () => { if (this.cursor > 0) this.applyLocal(this.snapshots[--this.cursor]); });
      $('redo-button').addEventListener('click', () => { if (this.cursor < this.snapshots.length - 1) this.applyLocal(this.snapshots[++this.cursor]); });
      $('draft-restore').addEventListener('click', () => { if (this.draft) this.applyLocal(this.draft); $('draft-recovery').hidden = true; });
      $('draft-discard').addEventListener('click', () => this.saved(this.state.project));
      $('render-retry').addEventListener('click', this.action(() => this.renderProject()));
      $('render-cancel').addEventListener('click', this.action(async () => { await this.api('/api/jobs/' + this.state.job.id + '/cancel', { method: 'POST', body: '{}' }); }));
      window.addEventListener('keydown', event => {
        if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'z' || /INPUT|TEXTAREA|SELECT/.test(event.target.tagName)) return;
        event.preventDefault(); $(event.shiftKey ? 'redo-button' : 'undo-button').click();
      });
    }
  };
})();
