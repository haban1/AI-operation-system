(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const media = /\.(mp4|mov|m4v|webm|jpg|jpeg|png|webp)$/i;
  window.MontageFolderUpload = class {
    constructor(production) {
      this.production = production;
      $('folder-input').addEventListener('change', production.action(() => this.upload()));
    }

    choose(forNewProject = false, relink = false) {
      if (this.busy) return;
      this.forNewProject = forNewProject;
      this.relink = relink;
      $('folder-input').value = '';
      $('folder-input').click();
    }

    async upload() {
      if (this.busy) return;
      const selected = Array.from($('folder-input').files);
      if (!selected.length) return;
      const files = selected.filter(file => media.test(file.name) && !file.webkitRelativePath.split('/').some(part => part.startsWith('.')));
      if (!files.length) throw new Error('文件夹内没有支持的照片或视频。支持 JPG、PNG、WebP、MP4、MOV、M4V、WebM。');
      if (files.length > 5000 || files.some(file => !file.size || file.size > 512 * 1024 ** 2)
        || files.reduce((sum, file) => sum + file.size, 0) > 5 * 1024 ** 3) {
        throw new Error('单个文件须为 1 字节至 512 MB，文件夹最多 5000 个素材、合计 5 GB。');
      }
      const p = this.production, projectId = p.state.project?.id;
      const controls = ['source-choose', 'source-connect', 'new-project-folder', 'create-project-submit', 'source-select', 'new-project-source', 'source-refresh', 'relink-sources'];
      const previous = controls.map(id => [$(id), $(id).disabled]);
      this.busy = true;
      previous.forEach(([node]) => { node.disabled = true; });
      const status = $(this.forNewProject ? 'new-project-source-status' : 'source-status');
      const name = files[0].webkitRelativePath.split('/')[0];
      let imported = 0, source;
      try {
        status.textContent = '正在准备导入…';
        ({ source } = await p.api('/api/source-folders/upload', { method: 'POST', body: JSON.stringify({ name, fileCount: files.length, totalBytes: files.reduce((sum, file) => sum + file.size, 0) }) }));
        for (const file of files) {
          status.textContent = `正在导入 ${imported + 1}/${files.length}：${file.name}`;
          await p.api(`/api/source-folders/${source.id}/files`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'x-file-name': encodeURIComponent(file.webkitRelativePath.split('/').slice(1).join('/')) }, body: file });
          imported += 1;
        }
        ({ source } = await p.api(`/api/source-folders/${source.id}/scan`, { method: 'POST', body: '{}' }));
        while (source.status === 'indexing') {
          status.textContent = `${name} · ${source.message || '正在准备预览…'}`;
          await new Promise(resolve => setTimeout(resolve, 900));
          ({ source } = await p.api(`/api/source-folders/${source.id}`));
        }
        if (source.status !== 'ready' || !source.count) throw new Error(source.warnings?.[0] || '未找到可用照片或视频，请换一个文件夹。');
        if (!this.forNewProject && projectId !== p.state.project?.id) {
          p.state.sourceFolders.unshift(source);
          p.renderSources();
          return p.toast('文件夹已导入，请在素材来源中选择。');
        }
        await p.connect(false, this.forNewProject, source);
        if (this.relink) {
          const repaired = await p.api('/api/assets/relink-folder', { method: 'POST', body: JSON.stringify({ sourceId: source.id }) });
          p.state.assets = repaired.assets;
          p.refreshEditor();
          p.toast(`已恢复 ${repaired.restored} 份同内容素材`);
        } else p.toast(`已准备 ${source.count} 个素材${source.warnings?.length ? `，${source.warnings.length} 个文件无法读取` : ''}。`);
      } catch (error) {
        status.textContent = source ? `导入未完成：${imported}/${files.length} 个。${error.message} 请重新选择文件夹。` : error.message;
        throw error;
      } finally {
        this.busy = false;
        previous.forEach(([node, disabled]) => { node.disabled = disabled; });
        $('folder-input').value = '';
      }
    }
  };
})();
