export function initDocumentKnowledge({ apiUrl, authHeaders, apiErrorMessage }) {
  const $ = (id) => document.getElementById(id);
  let documents = [];
  let selectedId = null;
  let busy = false;
  let generation = 0;
  const toast = (message, error = false) => {
    $("documentToast").textContent = message;
    $("documentToast").classList.toggle("error", error);
  };
  async function request(path, options = {}) {
    const response = await fetch(apiUrl(`/knowledge${path}`), {
      ...options, headers: { ...authHeaders(), ...options.headers },
    });
    if (!response.ok) throw new Error(await apiErrorMessage(response));
    return response.status === 204 ? null : response.json();
  }
  function button(text, action) {
    const el = document.createElement("button");
    el.type = "button";
    el.className = "secondary-btn";
    el.textContent = text;
    el.disabled = busy;
    el.addEventListener("click", action);
    return el;
  }
  function passage(title, text) {
    const article = document.createElement("article");
    article.className = "document-passage";
    const heading = document.createElement("strong");
    heading.textContent = title;
    const body = document.createElement("p");
    body.textContent = text;
    article.append(heading, body);
    return article;
  }
  function render() {
    const filter = $("documentFilter").value.trim().toLowerCase();
    $("documentSummary").textContent = `${documents.length} 份文档 · ${documents.filter(d => d.is_active && d.status === "ready").length} 份参与检索`;
    $("documentRows").replaceChildren();
    const visible = documents.filter(d => d.filename.toLowerCase().includes(filter));
    if (!visible.length) {
      const empty = document.createElement("p");
      empty.className = "empty-state";
      empty.textContent = documents.length ? "没有找到匹配的文档。" : "还没有知识文档。上传课程介绍、报名说明等资料后，客服即可检索回答。";
      $("documentRows").append(empty);
    }
    visible.forEach(doc => {
      const row = document.createElement("article");
      row.className = "document-row";
      row.classList.toggle("selected", doc.id === selectedId);
      const title = document.createElement("strong");
      title.textContent = doc.filename;
      const status = document.createElement("p");
      status.className = "section-note";
      const label = { ready: "可检索", failed: "解析失败", processing: "处理中" }[doc.status] || doc.status;
      status.textContent = `${doc.is_active ? label : "已停用"} · ${doc.chunk_count} 个片段 · ${doc.index_mode === "hybrid" ? "语义 + 关键词" : "关键词"}`;
      const actions = document.createElement("div");
      actions.className = "document-actions";
      actions.append(
        button("查看原文", () => preview(doc.id)),
        button(doc.is_active ? "停用" : "启用", () => mutate(`/documents/${doc.id}`, "PATCH", { is_active: !doc.is_active })),
        button("重新解析", () => mutate(`/documents/${doc.id}/reindex`, "POST")),
        button("删除", () => {
          if (window.confirm(`删除文档“${doc.filename}”及其检索索引？`)) mutate(`/documents/${doc.id}`, "DELETE");
        }),
      );
      row.append(title, status);
      if (doc.error_message) {
        const error = document.createElement("p");
        error.className = "document-notice";
        error.textContent = doc.error_message;
        row.append(error);
      }
      row.append(actions);
      $("documentRows").append(row);
    });
    $("uploadDocumentsBtn").disabled = busy;
    $("documentFiles").disabled = busy;
  }
  async function load() {
    const current = generation;
    try {
      const result = await request("/documents");
      if (current !== generation) return;
      documents = result;
      if (selectedId && !documents.some(d => d.id === selectedId)) {
        selectedId = null;
        $("documentPreview").textContent = "选择一份文档查看解析后的原文。";
        $("documentPreviewTitle").textContent = "原文预览";
      }
      render();
    } catch (e) { if (current === generation) toast(e.message, true); }
  }
  async function preview(id) {
    const current = generation;
    selectedId = id;
    render();
    $("documentPreview").textContent = "正在读取原文…";
    try {
      const doc = await request(`/documents/${id}`);
      if (current !== generation || selectedId !== id) return;
      $("documentPreviewTitle").textContent = doc.filename;
      $("documentPreview").replaceChildren();
      if (!doc.chunks.length) $("documentPreview").textContent = doc.error_message || "尚未生成原文片段。";
      doc.chunks.forEach(c => $("documentPreview").append(passage(c.location, c.text)));
    } catch (e) { if (current === generation && selectedId === id) $("documentPreview").textContent = e.message; }
  }
  async function mutate(path, method, data) {
    if (busy) return;
    const current = generation;
    busy = true; render();
    toast(method === "POST" ? "正在重新解析，请稍候…" : "正在更新…");
    try {
      const result = await request(path, { method, ...(data ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) } : {}) });
      if (current !== generation) return;
      toast(result?.status === "failed" ? result.error_message : "文档已更新。", result?.status === "failed");
      await load();
      if (current === generation && selectedId) await preview(selectedId);
    } catch (e) { if (current === generation) toast(e.message, true); }
    finally { if (current === generation) { busy = false; render(); } }
  }
  $("uploadDocumentsBtn").addEventListener("click", async () => {
    const files = Array.from($("documentFiles").files);
    if (!files.length) return toast("请先选择需要上传的文件。", true);
    if (busy) return;
    const current = generation;
    busy = true; render();
    let success = 0;
    const errors = [];
    for (const [index, file] of files.entries()) {
      toast(`正在上传并解析 ${index + 1}/${files.length}：${file.name}`);
      const data = new FormData(); data.append("file", file);
      try {
        const result = await request("/documents", { method: "POST", body: data });
        if (current !== generation) return;
        if (result.status === "ready") success++;
        else errors.push(`${file.name}：${result.error_message}`);
      } catch (e) {
        if (current !== generation) return;
        errors.push(`${file.name}：${e.message}`);
      }
    }
    busy = false;
    $("documentFiles").value = "";
    await load();
    if (current !== generation) return;
    toast(`已完成 ${success}/${files.length} 份文档。${errors.join("；")}`, errors.length > 0);
  });
  $("refreshDocumentsBtn").addEventListener("click", load);
  $("documentFilter").addEventListener("input", render);
  $("documentSearchForm").addEventListener("submit", async event => {
    event.preventDefault();
    const query = $("documentSearchQuery").value.trim();
    if (!query) return;
    const current = generation;
    $("documentSearchBtn").disabled = true;
    $("documentSearchResults").textContent = "正在检索…";
    try {
      const result = await request("/search", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query }) });
      if (current !== generation) return;
      $("documentSearchResults").replaceChildren();
      if (!result.chunks.length) $("documentSearchResults").textContent = "未检索到相关原文。请检查文档是否已启用，或补充相关资料。";
      result.chunks.forEach(c => $("documentSearchResults").append(passage(`${c.filename} · ${c.page_or_slide}`, c.text)));
    } catch (e) { if (current === generation) $("documentSearchResults").textContent = e.message; }
    finally { if (current === generation) $("documentSearchBtn").disabled = false; }
  });
  return { load, reset() {
    generation++; documents = []; selectedId = null; busy = false;
    $("documentSearchBtn").disabled = false;
    $("documentFilter").value = "";
    $("documentFiles").value = "";
    $("documentPreview").textContent = "选择一份文档查看解析后的原文。";
    $("documentPreviewTitle").textContent = "原文预览";
    $("documentSearchResults").replaceChildren();
    $("documentSearchQuery").value = "";
    toast(""); render();
  } };
}
