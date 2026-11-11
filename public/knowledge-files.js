let pollTimer;
let searchText = '';
const accept = '.pdf,.docx,.xlsx,.txt,.md,.markdown,.csv,.tsv,.json,.jsonl';
const labels = { ACTIVE: '已生效', PROCESSING: '处理中', FAILED: '处理失败', INACTIVE: '待更新' };

export function cleanupKnowledgeFiles() { clearTimeout(pollTimer); }

export function renderKnowledgeFiles(root, options) {
  cleanupKnowledgeFiles();
  const { api, esc, fmt, toast, confirmDelete, data, isCurrent, onRefresh } = options;
  const documents = data.documentData?.documents || [];
  if (!data.rag?.enabled || !data.rag?.configured) {
    root.innerHTML = '<section class="panel"><div class="v2-state is-warn" role="status"><span class="v2-state-icon" aria-hidden="true">!</span><div><b>知识库服务没有响应</b><p>文件列表保存在知识库服务（RAG）中，暂时读取不到。确认 RAG 服务已经启动后刷新页面。</p></div></div></section>';
    return;
  }
  root.innerHTML = `<section class="knowledge-files-page">
    <section class="panel knowledge-files-upload"><h2>上传文件</h2>
      <form id="knowledgeFileUpload"><label class="knowledge-files-drop" for="knowledgeFileInput"><span aria-hidden="true">⇧</span><b id="knowledgeFileName">点击选择或拖拽文件</b><small>PDF、DOCX、XLSX、TXT、MD、CSV、TSV、JSON · 最大 50MB</small><input id="knowledgeFileInput" name="file" type="file" accept="${accept}" required></label><button class="btn" type="submit">上传文件</button></form>
      <p class="muted">文件处理完成后自动生效。</p>
    </section>
    <section class="panel knowledge-files-list"><div class="panel-head"><h2>文件列表 <small>${documents.length}</small></h2><input type="search" id="knowledgeFileSearch" placeholder="搜索文件名" aria-label="搜索文件名" value="${esc(searchText)}"></div>
      <div id="knowledgeFileRows">${documents.map(item => {
        const busy = item.usageStatus === 'PROCESSING';
        return `<article class="knowledge-file-row" data-file-id="${esc(item.documentId)}" data-filename="${esc(item.filename || item.title || '')}"><div class="knowledge-file-info"><b>${esc(item.filename || item.title || '未命名文件')}</b><small>${fmt(item.createdAt)}</small>${item.error?.message ? `<p class="knowledge-file-error" role="status">${esc(item.error.message)}</p>` : ''}</div><span class="knowledge-file-status ${item.usageStatus === 'FAILED' ? 'is-error' : ''}" role="status">${labels[item.usageStatus] || '处理中'}</span><div class="button-row compact"><button class="btn secondary" type="button" data-file-action="view">查看</button><button class="btn secondary" type="button" data-file-action="edit" ${busy ? 'disabled' : ''}>修改</button><button class="btn danger" type="button" data-file-action="delete" ${busy ? 'disabled' : ''}>删除</button></div></article>`;
      }).join('')}</div><p class="empty" id="knowledgeFileEmpty" ${documents.length ? 'hidden' : ''}>${documents.length ? '没有匹配的文件' : '还没有文件，请先上传。'}</p>
    </section></section>`;

  const search = root.querySelector('#knowledgeFileSearch');
  const filter = () => {
    searchText = search.value;
    const rows = [...root.querySelectorAll('.knowledge-file-row')];
    for (const row of rows) row.hidden = !row.dataset.filename.toLocaleLowerCase().includes(searchText.trim().toLocaleLowerCase());
    root.querySelector('#knowledgeFileEmpty').hidden = rows.some(row => !row.hidden);
  };
  search.oninput = filter;
  filter();
  const input = root.querySelector('#knowledgeFileInput');
  input.onchange = () => { root.querySelector('#knowledgeFileName').textContent = input.files[0]?.name || '点击选择或拖拽文件'; };
  const zone = root.querySelector('.knowledge-files-drop');
  zone.ondragover = event => { event.preventDefault(); zone.classList.add('is-dragging'); };
  zone.ondragleave = () => zone.classList.remove('is-dragging');
  zone.ondrop = event => {
    event.preventDefault(); zone.classList.remove('is-dragging');
    if (event.dataTransfer.files.length !== 1) return toast('每次请选择一个文件', true);
    input.files = event.dataTransfer.files; input.onchange();
  };
  const save = async (file, documentId = null) => {
    if (!file?.size) throw new Error('请选择非空文件');
    if (file.size > 50 * 1024 * 1024) throw new Error('文件不能超过 50MB');
    const contentBase64 = await new Promise((resolve, reject) => {
      const reader = new FileReader(); reader.onerror = () => reject(new Error('读取文件失败'));
      reader.onload = () => resolve(String(reader.result).split(',')[1]); reader.readAsDataURL(file);
    });
    await api('/api/rag/files' + (documentId ? '/' + encodeURIComponent(documentId) : ''), {
      method: documentId ? 'PUT' : 'POST', body: JSON.stringify({ filename: file.name, mimeType: file.type, contentBase64 })
    });
  };
  root.querySelector('#knowledgeFileUpload').onsubmit = async event => {
    event.preventDefault(); const button = event.target.querySelector('button'); button.disabled = true; button.textContent = '上传中…';
    try { await save(input.files[0]); toast('文件已上传，处理完成后自动生效'); if (isCurrent()) await onRefresh(); }
    catch (error) { toast(error.message, true); button.disabled = false; button.textContent = '上传文件'; }
  };
  root.querySelector('#knowledgeFileRows').onclick = async event => {
    const button = event.target.closest('[data-file-action]'); if (!button) return;
    const row = button.closest('[data-file-id]');
    const item = documents.find(item => item.documentId === row.dataset.fileId);
    const action = button.dataset.fileAction;
    if (action === 'delete') {
      if (!await confirmDelete({ title: '删除文件？', message: item.filename || item.title, details: ['删除后，该文件不再用于知识问答。'], confirmLabel: '删除文件' })) return;
      button.disabled = true;
      try { await api('/api/rag/files/' + encodeURIComponent(item.documentId), { method: 'DELETE' }); toast('文件已删除'); if (isCurrent()) await onRefresh(); }
      catch (error) { toast(error.message, true); button.disabled = false; }
      return;
    }
    if (document.querySelector('.knowledge-file-modal')) return;
    const overlay = document.createElement('div'); overlay.className = 'confirm-overlay knowledge-file-modal';
    overlay.innerHTML = `<div class="confirm-dialog rag-content-dialog" role="dialog" aria-modal="true" aria-labelledby="knowledgeFileDialogTitle"><div class="knowledge-edit-heading"><h3 id="knowledgeFileDialogTitle">${action === 'edit' ? '修改文件' : '查看文件'}</h3><button class="knowledge-edit-close" type="button" aria-label="关闭">×</button></div><p>${esc(item.filename || item.title)}</p><div class="knowledge-file-dialog-body"></div></div>`;
    const close = () => { document.removeEventListener('keydown', keydown); overlay.remove(); if (button.isConnected) button.focus(); };
    const keydown = event => { if (event.key === 'Escape') close(); };
    overlay.onclick = event => { if (event.target === overlay || event.target.closest('.knowledge-edit-close')) close(); };
    document.addEventListener('keydown', keydown); document.body.append(overlay); overlay.querySelector('button').focus();
    const body = overlay.querySelector('.knowledge-file-dialog-body');
    if (action === 'view') {
      body.innerHTML = '<p role="status">正在读取内容…</p>';
      try {
        const result = await api('/api/rag/files/' + encodeURIComponent(item.documentId) + '/chunks');
        body.innerHTML = (result.chunks || []).map(chunk => `<pre>${esc(chunk.text || chunk.excerpt || '')}</pre>`).join('') || '<p>文件正在处理或暂无可查看的内容。</p>';
      } catch (error) { body.innerHTML = `<p role="alert">${esc(error.message)}</p>`; }
    } else {
      body.innerHTML = `<form class="knowledge-file-edit"><label>选择修改后的文件<input type="file" name="file" accept="${accept}" required></label><p class="muted">新文件处理成功后替换当前内容。</p><div class="confirm-actions"><button type="button" class="btn secondary" data-cancel>取消</button><button type="submit" class="btn">保存修改</button></div><p role="status" class="knowledge-file-save-status"></p></form>`;
      body.querySelector('[data-cancel]').onclick = close;
      body.querySelector('form').onsubmit = async event => {
        event.preventDefault(); const form = event.target; const submit = form.querySelector('[type=submit]'); submit.disabled = true;
        try { await save(form.elements.file.files[0], item.documentId); close(); toast('修改已保存，处理完成后自动生效'); if (isCurrent()) await onRefresh(); }
        catch (error) { form.querySelector('[role=status]').textContent = error.message; submit.disabled = false; }
      };
    }
  };
  if (documents.some(item => item.usageStatus === 'PROCESSING')) {
    const poll = () => {
      if (!isCurrent()) return;
      if (document.hidden || input.files.length || document.querySelector('.knowledge-file-modal') || (root.contains(document.activeElement) && document.activeElement.matches('input,textarea'))) { pollTimer = setTimeout(poll, 2500); return; }
      onRefresh().catch(() => { if (isCurrent()) pollTimer = setTimeout(poll, 2500); });
    };
    pollTimer = setTimeout(poll, 2500);
  }
}
