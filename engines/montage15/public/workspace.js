(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const seconds = value => `${Number(Number(value || 0).toFixed(2))}s`;

  window.MontageWorkspace = class {
    constructor(adapters) {
      Object.assign(this, adapters);
      this.previewEpoch = 0;
      this.gallerySignature = '';
      this.bind();
    }

    get selected() {
      const project = this.state.project;
      const index = Math.max(0, project?.slots.findIndex(slot => slot.id === this.production.focusedSlot) ?? 0);
      return { project, index, slot: project?.slots[index], definition: project?.templateSnapshot.slots[index] };
    }

    candidates() {
      const project = this.state.project;
      return project?.brief?.sourceId ? this.state.sourceItems || [] : this.state.assets.filter(asset => asset.type !== 'audio');
    }

    asset(id) { return this.state.assets.find(asset => asset.id === id) || this.candidates().find(asset => asset.id === id); }

    home() {
      document.body.classList.add('is-home');
      $('project-home').hidden = false;
      const url = new URL(location.href); url.searchParams.delete('project'); url.searchParams.delete('new'); url.searchParams.set('home', '1'); history.replaceState(null, '', url);
      this.renderHome();
    }

    renderHome() {
      const query = $('project-search').value.trim().toLowerCase();
      $('home-templates').innerHTML = this.state.templates.map(template => `<article class="home-template"><div class="home-template-art"><img src="${esc(this.resource('/posters/' + template.id + '.jpg'))}" alt="${esc(template.name)}模板封面"><button class="home-template-preview" data-preview-template="${esc(template.id)}" aria-label="预览${esc(template.name)}"><span>▶</span></button></div><div class="home-template-body"><div><h3>${esc(template.name.replace(/^\d+ · /,''))}</h3><p>${template.slots.length} 个镜头 · 15 秒 · 原配乐与转场</p></div><button class="button button-secondary" data-create-template="${esc(template.id)}">使用模板 ＋</button></div></article>`).join('');
      $('home-templates').querySelectorAll('[data-create-template]').forEach(button => button.onclick = () => this.newFromTemplate(button.dataset.createTemplate));
      $('home-templates').querySelectorAll('[data-preview-template]').forEach(button => button.onclick = () => {
        this.previewTemplate = button.dataset.previewTemplate;
        $('template-preview-title').textContent = this.state.templates.find(template => template.id === this.previewTemplate).name;
        $('template-preview-frame').src = this.resource('/api/templates/' + this.previewTemplate + '/preview');
        $('template-preview-dialog').showModal();
      });
      const projects = [...this.state.projects].sort((a,b) => new Date(b.updatedAt)-new Date(a.updatedAt));
      $('home-project-count').textContent = this.state.projects.length;
      $('home-projects').innerHTML = projects.filter(project => project.name.toLowerCase().includes(query)).map(project => {
        const asset = project.slots.map(slot => this.state.assets.find(asset => asset.id === slot.assetId)).find(Boolean);
        const image = asset?.thumbnailUrl || this.resource('/posters/' + project.templateId + '.jpg');
        const template = this.state.templateCatalog.find(item => item.id === project.templateId);
        return `<button class="home-project" data-open-project="${esc(project.id)}" aria-label="进入工程 ${esc(project.name)}"><div class="project-cover"><img loading="lazy" src="${esc(image)}" alt=""><span>15 秒 · ${project.width > project.height ? '16:9' : '9:16'}</span></div><div class="project-card-copy"><strong>${esc(project.name)}</strong><p><span>${esc(template?.name.replace(/^\d+ · /,'') || '混剪工程')}</span><span>${new Date(project.updatedAt).toLocaleDateString('zh-CN',{month:'numeric',day:'numeric'})} · 进入工程 →</span></p></div></button>`;
      }).join('') || '<p class="section-help">暂无匹配工程。选择上方模板即可新建。</p>';
      $('home-projects').querySelectorAll('[data-open-project]').forEach(button => button.onclick = this.action(() => this.openProject(button.dataset.openProject)));
      const sources = this.state.sourceFolders || [];
      $('home-source-summary').textContent = sources.length ? `${sources.length} 个素材集 · ${sources.reduce((count,source) => count + source.count,0)} 份素材` : '创建工程时连接文件夹';
    }

    newFromTemplate(id) { this.state.templateId = id; this.openNewProjectDialog(); }

    render() {
      const project = this.state.project;
      if (!project) { this.home(); return; }
      if (document.body.classList.contains('is-home')) { this.renderHome(); return; }
      $('project-home').hidden = true;
      $('current-project-name').textContent = project.name;
      $('current-template-name').textContent = project.templateSnapshot.name.replace(/^\d+ · /,'');
      $('timeline-ruler').innerHTML = [0,3,6,9,12,15].map(value => `<span>00:${String(value).padStart(2,'0')}</span>`).join('');
      $('music-track').firstElementChild.textContent = $('creation-music').textContent.replace('配乐：','♫ ') || '♫ 模板配乐';
      this.renderGallery();
      this.renderShot();
    }

    entered() { document.body.classList.remove('is-home'); $('project-home').hidden = true; this.render(); }

    renderGallery() {
      const candidates = this.candidates();
      const query = $('media-search').value.trim().toLowerCase();
      const type = $('media-filter').value;
      const selected = new Set(this.state.project?.brief?.assetIds || []);
      const used = new Set(this.state.project?.slots.map(slot => slot.assetId));
      const filtered = candidates.filter(asset => (type === 'all' || asset.type === type) && [asset.name,asset.description,asset.visualDescription,this.asset(asset.id)?.description,...(asset.tags || [])].join(' ').toLowerCase().includes(query));
      $('media-count').textContent = `${filtered.length} 份`;
      const signature = JSON.stringify([filtered.map(asset=>[asset.id,asset.thumbnailUrl,asset.name]),[...used],[...selected]]);
      if (signature === this.gallerySignature) return;
      this.gallerySignature = signature;
      $('media-grid').innerHTML = filtered.map(asset => `<button type="button" class="media-card${selected.has(asset.id) ? '' : ' disabled-candidate'}" draggable="false" data-preview-asset="${esc(asset.id)}" aria-label="预览素材 ${esc(asset.name)}"><img loading="lazy" draggable="false" src="${esc(asset.thumbnailUrl)}" alt=""><span class="media-duration">${asset.type === 'video' ? seconds(asset.duration) : '图片'}</span>${used.has(asset.id) ? '<span class="used-indicator">已使用</span>' : ''}<strong title="${esc(asset.name)}">${esc(asset.name)}</strong><small>${selected.has(asset.id) ? 'AI 可选' : '已排除 AI 选材'} · 点击预览 / 拖入镜头</small></button>`).join('') || '<p class="section-help">连接素材文件夹后，即可在这里预览画面。</p>';
      $('media-grid').querySelectorAll('[data-preview-asset]').forEach(button => {
        button.onclick = this.action(() => {
          if (performance.now() < (this.suppressPreviewUntil || 0)) return;
          return this.previewAsset(button.dataset.previewAsset);
        });
        button.onpointerdown = event => {
          if (event.button !== 0 || this.state.workflowBusy) return;
          this.cancelDrag();
          this.drag = {id:button.dataset.previewAsset,projectId:this.state.project.id,button,pointerId:event.pointerId,x:event.clientX,y:event.clientY};
          button.setPointerCapture(event.pointerId);
        };
      });
    }

    cancelDrag() {
      const drag = this.drag;
      if (!drag) return;
      drag.target?.classList.remove('drop-target');
      drag.ghost?.remove();
      if (drag.button.hasPointerCapture(drag.pointerId)) drag.button.releasePointerCapture(drag.pointerId);
      document.body.classList.remove('dragging-media');
      this.drag = null;
    }

    moveDrag(event) {
      const drag = this.drag;
      if (!drag || drag.pointerId !== event.pointerId) return;
      if (!drag.ghost && Math.hypot(event.clientX-drag.x,event.clientY-drag.y) < 8) return;
      event.preventDefault();
      if (!drag.ghost) {
        drag.ghost = document.createElement('div');
        drag.ghost.className = 'media-drag-ghost';
        drag.ghost.textContent = this.asset(drag.id)?.name || '替换镜头';
        document.body.append(drag.ghost);
        document.body.classList.add('dragging-media');
      }
      drag.ghost.style.left = `${event.clientX+12}px`;
      drag.ghost.style.top = `${event.clientY+12}px`;
      drag.target?.classList.remove('drop-target');
      drag.target = document.elementFromPoint(event.clientX,event.clientY)?.closest('#shot-timeline [data-slot-id]');
      drag.target?.classList.add('drop-target');
    }

    frameUrl(asset, inPoint) { return asset.type === 'video' && this.state.assets.some(item => item.id === asset.id) ? this.resource(`/api/assets/${asset.id}/frame?time=${Number(inPoint || 0).toFixed(2)}`) : asset.thumbnailUrl; }

    renderShot() {
      const {project,index,slot,definition} = this.selected;
      if (!project || !slot) return;
      const asset = this.asset(slot.assetId);
      $('shot-inspector-title').textContent = `镜头 ${String(index+1).padStart(2,'0')}`;
      const start = definition.startFrame / project.fps;
      const duration = definition.durationFrames / project.fps;
      $('shot-inspector-range').textContent = `${seconds(start)}–${seconds(start+duration)}`;
      $('shot-inspector-name').textContent = asset?.name || '等待 AI 选择素材';
      $('shot-inspector-name').title = asset?.name || '';
      $('shot-inspector-description').textContent = asset?.description && asset.description !== asset.name ? asset.description : '点击画面可预览原片，取材区间包含模板转场所需的重叠画面。';
      $('shot-trim-controls').hidden = !asset;
      for(const [id,value] of [['shot-inpoint',slot.inPoint || 0],['shot-focus-x',slot.focusX ?? .5],['shot-focus-y',slot.focusY ?? .5]]) {
        if(document.activeElement !== $(id)) $(id).value = value;
        $(id).disabled = this.state.workflowBusy || (id === 'shot-inpoint' && asset?.type !== 'video');
      }
      $('shot-original-duration').textContent = asset?.type === 'video' ? `原片 ${seconds(asset.duration)}` : '图片';
      $('shot-inpoint').max = Math.max(0,(asset?.duration || 0)-duration).toFixed(2);
      $('shot-used-range').textContent = asset?.type === 'video' ? `只使用原片 ${seconds(slot.inPoint)}–${seconds((slot.inPoint || 0)+duration)}，共 ${seconds(duration)}` : `图片显示 ${seconds(duration)}`;
      const signature = JSON.stringify([project.id,slot.id,asset?.id,slot.inPoint]);
      if(signature !== this.shotSignature) {
        this.shotSignature = signature;
        $('shot-inspector-preview').replaceChildren();
        if(asset) {
          const image = document.createElement('img'); image.src = this.frameUrl(asset,slot.inPoint); image.alt = `镜头 ${index+1} 的取材起点`;
          image.addEventListener('click',this.action(()=>this.previewAsset(asset.id,{start:slot.inPoint || 0})));
          $('shot-inspector-preview').append(image);
        } else $('shot-inspector-preview').textContent='先生成初稿，或拖入一份素材';
      }
      $('shot-lock-control').replaceChildren(this.workflow.makeLock('slots',slot.id,'锁定当前镜头'));
      $('shot-ai-replace').disabled = this.state.workflowBusy || project.locks.slots.includes(slot.id);
      $('shot-browse').disabled = this.state.workflowBusy;
      $('ai-scope-hint').textContent = $('ai-adjust-scope').value === 'selected' ? `只允许改镜头 ${index+1}（${seconds(start)}–${seconds(start+duration)}）` : '明确指定镜头时，其他镜头保持原样。';
    }

    async ensureAsset(id) {
      const existing = this.state.assets.find(asset => asset.id === id);
      if(existing) return existing;
      const sourceId = this.state.project?.brief?.sourceId;
      if(!sourceId || !this.candidates().some(item=>item.id===id)) throw Error('素材不在当前素材集中');
      const {asset} = await this.api(`/api/source-folders/${sourceId}/import`,{method:'POST',body:JSON.stringify({id})});
      const index = this.state.assets.findIndex(item=>item.id===id);
      if(index<0) this.state.assets.push(asset); else this.state.assets[index]=asset;
      return asset;
    }

    async previewAsset(id,{start=0}={}) {
      const {project,slot,definition,index} = this.selected;
      if(!project) return;
      const epoch=++this.previewEpoch;
      this.previewTarget={projectId:project.id,slotId:slot.id,id};
      $('media-preview-title').textContent=this.asset(id)?.name || '素材预览';
      $('media-preview-stage').textContent='正在准备本机预览…';
      $('media-preview-apply').disabled=true;
      $('media-preview-apply').textContent=`替换镜头 ${index+1}`;
      $('media-preview-trim').hidden=true;
      $('media-preview-dialog').showModal();
      try {
        const asset=await this.ensureAsset(id);
        if(epoch!==this.previewEpoch || !$('media-preview-dialog').open) return;
        this.previewTarget.asset=asset;
        $('media-preview-meta').textContent=`${asset.type==='video'?'视频':'图片'} · ${asset.width} × ${asset.height}${asset.type==='video'?' · 原片 '+seconds(asset.duration):''}`;
        $('media-preview-description').textContent=asset.description || '预览画面后，选择取材起点，再替换到指定镜头。';
        const media=document.createElement(asset.type==='video'?'video':'img'); media.src=asset.url;
        if(asset.type==='video') {media.controls=true;media.muted=true;media.playsInline=true;media.preload='metadata';media.addEventListener('loadedmetadata',()=>{media.currentTime=Number($('media-preview-start').value)});}
        $('media-preview-stage').replaceChildren(media);
        const duration=definition.durationFrames/project.fps;
        const maximum=Math.max(0,(asset.duration || 0)-duration);
        $('media-preview-start').max=maximum.toFixed(2);
        $('media-preview-start').value=Math.min(maximum,start);
        $('media-preview-trim').hidden=asset.type!=='video';
        $('media-preview-apply').disabled=asset.type==='video' && asset.duration+.035<duration;
        this.updatePreviewRange();
        this.renderGallery();
      } catch(error) {if(epoch===this.previewEpoch) $('media-preview-stage').textContent=error.message;}
    }

    updatePreviewRange() {
      const {projectId,slotId,asset}=this.previewTarget || {};
      const project=this.state.project;
      if(!asset || project?.id!==projectId) return;
      const definition=project.templateSnapshot.slots.find(item=>item.id===slotId);
      const duration=definition.durationFrames/project.fps;
      const start=Number($('media-preview-start').value);
      const valid=Number.isFinite(start)&&start>=0&&(asset.type!=='video'||start+duration<=asset.duration+.035);
      $('media-preview-range').textContent=valid?`替换时只截取 ${seconds(start)}–${seconds(start+duration)}（${seconds(duration)}）`:`素材不足 ${seconds(duration)}，请提前起点或更换素材`;
      $('media-preview-apply').disabled=!valid||this.state.workflowBusy;
      const media=$('media-preview-stage').querySelector('video');
      if(media&&valid) {media.currentTime=start;media.ontimeupdate=()=>{if(media.currentTime>start+duration){media.pause();media.currentTime=start;}};}
    }

    async replaceAsset(id,slotId,start=0,projectId=this.state.project?.id) {
      if(this.state.workflowBusy) return;
      const asset=await this.ensureAsset(id);
      const project=this.state.project;
      if(project?.id!==projectId || this.state.workflowBusy) throw Error('工程状态已变化，请重新选择镜头');
      const slot=project.slots.find(item=>item.id===slotId);
      const definition=project.templateSnapshot.slots.find(item=>item.id===slotId);
      const duration=definition.durationFrames/project.fps;
      if(!Number.isFinite(start)||start<0||asset.type==='video'&&start+duration>asset.duration+.035) throw Error('取材区间超出原片，请重新选择起点');
      Object.assign(slot,{assetId:id,inPoint:asset.type==='image'?0:start,focusX:.5,focusY:.5});
      project.brief.assetIds=[...new Set([...project.brief.assetIds,id])];
      this.production.focusedSlot=slot.id;
      this.workflow.lock('slots',slot.id);
      this.markDirty(); this.refreshEditor(); this.render();
      this.toast(`已替换镜头 ${project.slots.indexOf(slot)+1}，其他镜头保持原样；保存后更新成片预览`);
    }

    closePreview() {++this.previewEpoch;$('media-preview-stage').querySelector('video')?.pause();$('media-preview-dialog').close();}

    bind() {
      document.addEventListener('pointermove',event=>this.moveDrag(event));
      document.addEventListener('pointerup',event=>{
        const drag=this.drag;
        if(!drag || drag.pointerId!==event.pointerId) return;
        const slotId=drag.target?.dataset.slotId;
        if(drag.ghost) this.suppressPreviewUntil=performance.now()+400;
        this.cancelDrag();
        if(slotId) this.action(()=>this.replaceAsset(drag.id,slotId,0,drag.projectId))();
      });
      document.addEventListener('pointercancel',()=>this.cancelDrag());
      document.addEventListener('keydown',event=>{if(event.key==='Escape')this.cancelDrag()});
      $('back-to-projects').onclick=this.action(async()=>{if(this.state.dirty)await this.saveProject({quiet:true});if(!this.state.dirty)this.home();});
      $('project-search').oninput=()=>this.renderHome();
      $('media-search').oninput=()=>this.renderGallery(); $('media-filter').onchange=()=>this.renderGallery();
      $('template-preview-close').onclick=()=>{$('template-preview-dialog').close();$('template-preview-frame').src='about:blank'};
      $('template-preview-use').onclick=()=>{$('template-preview-close').click();this.newFromTemplate(this.previewTemplate)};
      $('template-preview-dialog').addEventListener('close',()=>{$('template-preview-frame').src='about:blank'});
      for(const id of ['media-preview-close','media-preview-cancel']) $(id).onclick=()=>this.closePreview();
      $('media-preview-dialog').addEventListener('close',()=>{++this.previewEpoch;$('media-preview-stage').querySelector('video')?.pause()});
      $('media-preview-start').oninput=()=>this.updatePreviewRange();
      $('media-preview-apply').onclick=this.action(async()=>{const target=this.previewTarget;await this.replaceAsset(target.id,target.slotId,Number($('media-preview-start').value),target.projectId);this.closePreview()});
      $('shot-browse').onclick=()=>{$('media-search').focus();document.querySelector('.media-browser').scrollIntoView({block:'center'});document.querySelector('.media-browser').classList.add('is-target');setTimeout(()=>document.querySelector('.media-browser').classList.remove('is-target'),1800)};
      for(const [id,key]of [['shot-inpoint','inPoint'],['shot-focus-x','focusX'],['shot-focus-y','focusY']]) $(id).onchange=()=>{
        if(this.state.workflowBusy)return;
        const {slot,definition,project}=this.selected;
        const value=Number($(id).value),asset=this.asset(slot.assetId),maximum=key==='inPoint'?Math.max(0,(asset?.duration||0)-definition.durationFrames/project.fps):1;
        if(!Number.isFinite(value)||value<0||value>maximum+.001){this.toast('数值超出可用范围');this.renderShot();return;}
        slot[key]=value;this.workflow.lock('slots',slot.id);this.markDirty();this.refreshEditor();this.renderShot();
      };
      $('shot-ai-replace').onclick=this.action(()=>{const {slot}=this.selected;return this.workflow.start('regenerate',{kind:'slots',ids:[slot.id]},'只更换这个镜头的素材或取材区间，尽量选择不同且符合制作要求的画面。')});
      $('ai-adjust-scope').onchange=()=>this.renderShot();
    }
  };
})();
