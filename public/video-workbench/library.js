(() => {
  "use strict";

  const sourceNames = { automatic: "自动化成片", editing: "素材智剪", creation: "AIGC 创作" };
  const roleNames = { final_video: "最终视频", video_clip: "视频片段", image: "图片" };
  const statusNames = { pending: "待确认", approved: "已入库", rejected: "已排除" };
  const get = (id) => document.getElementById(id);
  const picker = new URLSearchParams(location.search).get("picker") === "1";
  let buckets = { approved: [], pending: [], rejected: [] };
  let selectedView = picker ? "approved" : "pending";
  let selectedSource = "all";
  let syncing = false;
  let loaded = false;
  let lastSyncedAt = null;
  let toastTimer;
  const reviewing = new Set();
  let receiving = false;
  const escape = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[character]));

  function dateLabel(value) {
    const date = new Date(value);
    return value && Number.isFinite(date.getTime())
      ? date.toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false })
      : "时间未提供";
  }
  function sizeLabel(value) {
    const size = Number(value);
    if (!Number.isFinite(size) || size <= 0) return "";
    if (size < 1024 * 1024) return `${Math.max(1, Math.round(size / 1024))} KB`;
    return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  }
  function mediaUrl(item) {
    if (typeof item.mediaUrl !== "string" || !item.mediaUrl) return null;
    try {
      const url = new URL(item.mediaUrl, location.origin);
      return url.origin === location.origin && url.pathname.startsWith("/api/content-library/") ? url.href : null;
    } catch { return null; }
  }
  async function request(path, options = {}) {
    const response = await fetch(path, {
      cache: "no-store", credentials: "same-origin", signal: AbortSignal.timeout(options.method === "POST" ? 60000 : 15000),
      ...options,
    });
    if (response.status === 401) {
      window.parent.postMessage({ type: "content-workbench:unauthorized" }, location.origin);
      const error = new Error("登录已失效，请重新登录。");
      error.status = 401;
      throw error;
    }
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.message || body.error?.message || (typeof body.error === "string" ? body.error : "素材库暂时无法连接，请稍后重试。"));
    }
    return response.json();
  }
  function toast(message) {
    const element = get("notification");
    element.textContent = message;
    element.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { element.hidden = true; }, 4000);
  }
  function applySnapshot(result) {
    if (![result.items, result.pendingItems, result.rejectedItems].every(Array.isArray)) {
      throw new Error("素材库返回了无法识别的数据，请刷新页面后重试。");
    }
    buckets = { approved: result.items, pending: result.pendingItems, rejected: result.rejectedItems };
    lastSyncedAt = result.lastSyncedAt || lastSyncedAt;
    loaded = true;
    renderItems();
    renderSources(result.sources);
  }
  function renderSources(sources) {
    const values = Array.isArray(sources) ? sources : [];
    const unavailable = values.filter((source) => source && source.online === false);
    const count = (value) => Number.isFinite(Number(value)) ? Math.max(0, Math.floor(Number(value))) : 0;
    const unreadable = values.reduce((total, source) => total + count(source?.rejectedCount), 0);
    const pending = values.reduce((total, source) => total + count(source?.pendingCount), 0);
    const notices = [];
    if (unreadable) notices.push(`${unreadable} 项文件暂时无法读取。`);
    if (pending) notices.push(`${pending} 项产物尚待同步。`);
    if (unavailable.length) notices.push(`${unavailable.map((source) => sourceNames[source.id] || "部分来源").join("、")}暂不可用。`);
    get("librarySources").hidden = notices.length === 0;
    get("librarySources").textContent = notices.join(" ");
  }
  function renderTabs() {
    document.querySelectorAll("[data-library-view]").forEach((button) => {
      const active = button.dataset.libraryView === selectedView;
      button.setAttribute("aria-selected", String(active));
      button.tabIndex = active ? 0 : -1;
      button.hidden = picker && !active;
      button.querySelector("[data-view-count]").textContent = String(buckets[button.dataset.libraryView].length);
      if (active) get("libraryGrid").setAttribute("aria-labelledby", button.id);
    });
  }
  function actions(item) {
    const id = escape(item.id);
    const disabled = reviewing.has(item.id) ? " disabled" : "";
    if (selectedView === "pending") {
      return `<button type="button" class="librarySecondaryAction" data-admission-id="${id}" data-decision="rejected"${disabled}>暂不入库</button><button type="button" class="routeButton" data-admission-id="${id}" data-decision="approved"${disabled}>确认入库 <span aria-hidden="true">✓</span></button>`;
    }
    if (selectedView === "rejected") return `<button type="button" class="librarySecondaryAction" data-admission-id="${id}" data-decision="pending"${disabled}>移回待确认</button>`;
    const unsupported = ["video/webm", "video/x-m4v"].includes(item.mimeType);
    return `${picker ? "" : `<button type="button" class="libraryUndo" data-admission-id="${id}" data-decision="pending" title="撤回入库确认" aria-label="撤回入库确认：${escape(item.title)}"${disabled}>↶</button>`}<button type="button" class="routeButton" data-publish-id="${id}"${unsupported ? ' disabled title="发布前请导出 MP4 或 MOV"' : ""}>用于发布 <span aria-hidden="true">↗</span></button>`;
  }
  function renderItems() {
    renderTabs();
    const items = buckets[selectedView];
    const visible = items.filter((item) => selectedSource === "all" || item.source === selectedSource);
    get("libraryCount").textContent = `${visible.length} 项${selectedSource === "all" ? "" : ` / 共 ${items.length} 项`}`;
    get("libraryEmpty").hidden = !loaded || visible.length > 0;
    get("libraryEmptyTitle").textContent = selectedView === "approved" ? "暂无已入库素材" : selectedView === "rejected" ? "暂无已排除产物" : "暂无待确认产物";
    get("libraryEmptyText").textContent = selectedSource === "all" ? "" : `${sourceNames[selectedSource]} · ${statusNames[selectedView]}`;
    get("libraryGrid").innerHTML = visible.map((item) => {
      const url = mediaUrl(item);
      const isImage = item.mediaType === "image";
      const role = roleNames[item.artifactType] || (isImage ? "图片" : "视频");
      const metadata = [dateLabel(item.createdAt), sizeLabel(item.sizeBytes)].filter(Boolean).join(" · ");
      const audit = selectedView === "approved" && item.admittedBy
        ? `<p class="libraryAudit">${escape(item.admittedBy)} · ${escape(dateLabel(item.admittedAt))} 确认入库</p>` : "";
      const sourceSelection = item.reviewStatus === "selected" ? '<span class="librarySourceSelection">源工作台已选中</span>' : "";
      const preview = !url ? '<div class="libraryMediaUnavailable">预览暂不可用</div>' : isImage
        ? `<a class="libraryImageLink" href="${escape(url)}" target="_blank" rel="noopener noreferrer" aria-label="查看图片：${escape(item.title || "未命名产物")}"><img src="${escape(url)}" alt="${escape(item.title || "产物预览")}" loading="lazy"><span>查看大图 ↗</span></a>`
        : `<video controls preload="metadata" playsinline src="${escape(url)}" aria-label="预览：${escape(item.title || "未命名产物")}">当前浏览器无法播放此视频。</video>`;
      return `<article class="libraryCard" data-library-id="${escape(item.id)}">
        <div class="libraryMedia">${preview}</div>
        <div class="libraryCardBody"><div class="libraryCardLabels"><span class="librarySourceTag source-${sourceNames[item.source] ? escape(item.source) : "unknown"}">${escape(sourceNames[item.source] || "其他来源")}</span><span class="libraryReviewTag ${selectedView}">${statusNames[selectedView]}</span></div>
        <h2>${escape(item.title || "未命名产物")}</h2><p class="libraryRole">${escape(role)}${sourceSelection}</p>
        ${item.body ? `<p class="libraryDescription">${escape(item.body)}</p>` : ""}
        <p class="libraryMetadata">${escape(metadata)}</p>${audit}
        <div class="libraryCardFoot">${actions(item)}</div></div>
      </article>`;
    }).join("");
    get("libraryGrid").querySelectorAll("video, img").forEach((media) => {
      media.addEventListener("error", () => {
        if (media.closest(".libraryMedia")?.querySelector(".libraryPreviewError")) return;
        const notice = document.createElement("p");
        notice.className = "libraryPreviewError";
        notice.textContent = "暂时无法读取预览，请同步后重试。";
        media.closest(".libraryMedia")?.append(notice);
      }, { once: true });
    });
  }
  async function syncLibrary() {
    if (syncing) return;
    syncing = true;
    get("syncLibrary").disabled = true;
    get("syncLibrary").textContent = "正在同步…";
    get("libraryGrid").setAttribute("aria-busy", "true");
    get("librarySyncState").textContent = "正在同步产物…";
    try {
      applySnapshot(await request("/api/content-library/sync", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }));
      get("librarySyncState").textContent = lastSyncedAt ? `最近同步 ${dateLabel(lastSyncedAt)}` : "同步完成";
    } catch (error) {
      get("librarySyncState").textContent = error.message;
      if (!loaded) { get("libraryEmpty").hidden = false; get("libraryEmptyTitle").textContent = "素材库暂时无法连接"; }
    } finally {
      syncing = false;
      get("syncLibrary").disabled = false;
      get("syncLibrary").innerHTML = '同步产物 <span aria-hidden="true">↻</span>';
      get("libraryGrid").setAttribute("aria-busy", "false");
    }
  }
  async function reviewItem(id, decision) {
    if (reviewing.has(id)) return;
    reviewing.add(id);
    renderItems();
    try {
      await request(`/api/content-library/${encodeURIComponent(id)}/admission`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ decision }),
      });
      applySnapshot(await request("/api/content-library"));
      toast(decision === "approved" ? "已确认入库" : decision === "rejected" ? "已暂不入库，产物保留" : "已移回待确认");
    } catch (error) { toast(error.message); }
    finally { reviewing.delete(id); renderItems(); }
  }
  get("receiveOutput").hidden = picker;
  get("receiveOutput").addEventListener("click", () => {
    get("receiveOutputForm").reset();
    get("receiveOutputStatus").textContent = "";
    if (selectedSource !== "all") get("receiveSource").value = selectedSource;
    get("receiveOutputDialog").showModal();
  });
  get("receiveOutputCancel").addEventListener("click", () => get("receiveOutputDialog").close());
  get("receiveOutputDialog").addEventListener("cancel", (event) => { if (receiving) event.preventDefault(); });
  get("receiveFile").addEventListener("change", () => {
    const file = get("receiveFile").files[0];
    if (!file) return;
    get("receiveTitle").value = file.name.replace(/\.[^.]+$/, "");
    get("receiveKind").value = /\.(png|jpe?g|webp)$/i.test(file.name) ? "image" : "final_video";
  });
  get("receiveOutputForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (receiving) return;
    const file = get("receiveFile").files[0];
    if (!file) return;
    receiving = true;
    const controls = [...get("receiveOutputForm").querySelectorAll("input, select, button")];
    controls.forEach((control) => { control.disabled = true; });
    get("receiveOutputStatus").textContent = "正在接收并校验文件…";
    const params = new URLSearchParams({ source: get("receiveSource").value, filename: file.name,
      title: get("receiveTitle").value.trim(), artifactType: get("receiveKind").value });
    try {
      await request(`/api/content-library/receive?${params}`, { method: "POST", headers: { "Content-Type": "application/octet-stream" },
        body: file, signal: AbortSignal.timeout(300000) });
      selectedView = "pending";
      selectedSource = "all";
      document.querySelectorAll("[data-library-source]").forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.librarySource === "all")));
      applySnapshot(await request("/api/content-library"));
      get("receiveOutputDialog").close();
      toast("产物已接收，等待确认入库");
    } catch (error) { get("receiveOutputStatus").textContent = error.message; }
    finally { receiving = false; controls.forEach((control) => { control.disabled = false; }); }
  });
  get("syncLibrary").addEventListener("click", syncLibrary);
  document.querySelectorAll("[data-library-source]").forEach((button) => {
    button.addEventListener("click", () => {
      selectedSource = button.dataset.librarySource;
      document.querySelectorAll("[data-library-source]").forEach((item) => item.setAttribute("aria-pressed", String(item === button)));
      renderItems();
    });
  });
  const tabs = [...document.querySelectorAll("[data-library-view]")];
  tabs.forEach((button, index) => {
    button.addEventListener("click", () => { selectedView = button.dataset.libraryView; renderItems(); });
    button.addEventListener("keydown", (event) => {
      if (picker || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
      tabs[next].click(); tabs[next].focus();
    });
  });
  get("libraryGrid").addEventListener("click", (event) => {
    const admission = event.target.closest("[data-admission-id]");
    if (admission && !picker) { reviewItem(admission.dataset.admissionId, admission.dataset.decision); return; }
    const button = event.target.closest("[data-publish-id]");
    if (!button || button.disabled) return;
    const item = buckets.approved.find((entry) => String(entry.id) === button.dataset.publishId && entry.admissionStatus === "approved");
    if (!item) return;
    get("libraryGrid").querySelectorAll("video").forEach((video) => video.pause());
    window.parent.postMessage({ type: "content-library:publish", id: item.id }, location.origin);
    toast(window.parent === window ? "请从主应用进入发布编辑。" : "正在打开发布编辑。" );
  });
  window.addEventListener("workbench:route-change", (event) => {
    if (event.detail?.route === "library") syncLibrary();
    else get("libraryGrid").querySelectorAll("video").forEach((video) => video.pause());
  });
  renderTabs();
  if (location.hash === "#library" || picker) syncLibrary();
})();
