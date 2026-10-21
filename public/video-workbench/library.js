(() => {
  "use strict";

  const sourceNames = { automatic: "自动化成片", editing: "素材智剪", creation: "AIGC 创作" };
  const roleNames = {
    final: "最终导出", final_video: "最终视频", video_clip: "视频片段", export: "导出作品", exported_video: "导出视频",
    node: "画布节点", node_output: "节点输出", node_video: "节点视频", node_image: "节点图片",
    video: "视频", image: "图片", storyboard: "分镜素材", preview: "预览作品",
  };
  const get = (id) => document.getElementById(id);
  let items = [];
  let selectedSource = "all";
  let syncing = false;
  let loaded = false;
  let lastSyncedAt = null;
  let toastTimer;

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
      return url.origin === location.origin && url.pathname.startsWith("/api/content-library/")
        ? url.href : null;
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
    if (!response.ok) throw new Error(response.status === 403 ? "当前账号无法读取成片库。" : "成片库暂时无法连接，请稍后重试。");
    return response.json();
  }

  function toast(message) {
    const element = get("notification");
    element.textContent = message;
    element.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { element.hidden = true; }, 4000);
  }

  function roleLabel(item) {
    if (typeof item.artifactType === "string" && roleNames[item.artifactType]) return roleNames[item.artifactType];
    const details = [...new Set([item.sourceKind, item.mediaRole]
      .filter((value) => typeof value === "string" && value.trim())
      .map((value) => roleNames[value] || value.slice(0, 64)))];
    if (!details.length && item.source === "creation") return "画布素材 · 是否为最终成片请预览确认";
    return details.join(" · ");
  }

  function renderSources(sources) {
    const values = Array.isArray(sources) ? sources : (sources && typeof sources === "object"
      ? Object.entries(sources).map(([id, value]) => ({ id, ...(value && typeof value === "object" ? value : {}) })) : []);
    const unavailable = values.filter((source) => source && (source.error || source.online === false
      || ["error", "offline", "unavailable", "failed"].includes(source.status)));
    const count = (value) => Number.isFinite(Number(value)) ? Math.max(0, Math.floor(Number(value))) : 0;
    const rejectedCount = values.reduce((total, source) => total + count(source?.rejectedCount), 0);
    const pendingCount = values.reduce((total, source) => total + count(source?.pendingCount), 0);
    const notices = [];
    if (rejectedCount) notices.push(`${rejectedCount} 项暂时无法读取，请确认源文件已下载到本机后重新同步。`);
    if (pendingCount) notices.push(`${pendingCount} 项待后续同步，可再次点击“同步作品”继续。`);
    if (unavailable.length) notices.push(`${unavailable.map((source) => sourceNames[source.id || source.source] || "部分来源").join("、")}暂未完成同步；已有作品仍可查看。`);
    get("librarySources").hidden = notices.length === 0;
    get("librarySources").textContent = notices.join(" ");
    if (!items.length && (rejectedCount || pendingCount)) {
      get("libraryEmptyTitle").textContent = "已发现作品，尚未完成收录";
      get("libraryEmptyText").textContent = rejectedCount
        ? "请先将源文件下载到本机，再点击“同步作品”。"
        : "点击“同步作品”继续处理待同步的作品。";
    }
    return { rejectedCount, pendingCount };
  }

  function renderItems() {
    const visible = items.filter((item) => selectedSource === "all" || item.source === selectedSource);
    get("libraryCount").textContent = `${visible.length} 个作品${selectedSource === "all" ? "" : ` / 共 ${items.length} 个`}`;
    get("libraryEmpty").hidden = !loaded || visible.length > 0;
    get("libraryEmptyTitle").textContent = selectedSource === "all" ? "还没有可展示的作品" : "这条路径暂未收录作品";
    get("libraryEmptyText").textContent = selectedSource === "all"
      ? "先在任一路径生成或导出作品，再同步到这里。"
      : `在${sourceNames[selectedSource]}工作区完成生成或导出后，点击“同步作品”。`;
    get("libraryGrid").innerHTML = visible.map((item) => {
      const url = mediaUrl(item);
      const isImage = item.mediaType === "image";
      const selected = item.reviewStatus === "selected";
      const role = roleLabel(item);
      const metadata = [dateLabel(item.createdAt), isImage ? "图片" : "视频", sizeLabel(item.sizeBytes)].filter(Boolean).join(" · ");
      const preview = !url ? '<div class="libraryMediaUnavailable">预览暂不可用</div>' : isImage
        ? `<a class="libraryImageLink" href="${escape(url)}" target="_blank" rel="noopener noreferrer" aria-label="查看图片：${escape(item.title || "未命名作品")}"><img src="${escape(url)}" alt="${escape(item.title || "作品预览")}" loading="lazy"><span>查看大图 ↗</span></a>`
        : `<video controls preload="none" playsinline src="${escape(url)}" aria-label="预览：${escape(item.title || "未命名作品")}">当前浏览器无法播放此视频。</video>`;
      return `<article class="libraryCard" data-library-id="${escape(item.id)}">
        <div class="libraryMedia">${preview}</div>
        <div class="libraryCardBody"><div class="libraryCardLabels"><span class="librarySourceTag source-${sourceNames[item.source] ? escape(item.source) : "unknown"}">${escape(sourceNames[item.source] || "其他来源")}</span><span class="libraryReviewTag${selected ? " selected" : ""}">${selected ? "源工作台已选中" : "待挑选"}</span></div>
        <h2>${escape(item.title || "未命名作品")}</h2>${role ? `<p class="libraryRole">${escape(role)}</p>` : ""}
        ${item.body ? `<p class="libraryDescription">${escape(item.body)}</p>` : ""}
        <p class="libraryMetadata">${escape(metadata)}</p>
        <div class="libraryCardFoot"><span>发布前继续核对内容</span><button type="button" class="routeButton" data-publish-id="${escape(item.id)}">用于发布 <span aria-hidden="true">↗</span></button></div></div>
      </article>`;
    }).join("");

    get("libraryGrid").querySelectorAll("video, img").forEach((media) => {
      media.addEventListener("error", () => {
        if (!media.closest(".libraryMedia")?.querySelector(".libraryPreviewError")) {
          const notice = document.createElement("p");
          notice.className = "libraryPreviewError";
          notice.textContent = "暂时无法读取预览，请同步后重试。";
          media.closest(".libraryMedia")?.append(notice);
        }
      }, { once: true });
    });
  }

  async function syncLibrary() {
    if (syncing) return;
    syncing = true;
    get("syncLibrary").disabled = true;
    get("syncLibrary").textContent = "正在同步…";
    get("libraryGrid").setAttribute("aria-busy", "true");
    get("librarySyncState").textContent = "正在从三条创作路径同步作品…";
    let syncFailure = null;
    try {
      try {
        const sync = await request("/api/content-library/sync", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
        lastSyncedAt = sync.lastSyncedAt || lastSyncedAt;
      } catch (error) {
        if (error.status === 401) throw error;
        syncFailure = error;
      }
      const result = await request("/api/content-library");
      if (!Array.isArray(result.items)) throw new Error("成片库返回了无法识别的数据，请稍后重试。");
      items = result.items.filter((item) => item && item.id != null);
      lastSyncedAt = result.lastSyncedAt || lastSyncedAt;
      loaded = true;
      renderItems();
      const { rejectedCount, pendingCount } = renderSources(result.sources);
      const incomplete = [rejectedCount ? `${rejectedCount} 项暂时无法读取` : "", pendingCount ? `${pendingCount} 项待同步` : ""].filter(Boolean).join(" · ");
      get("librarySyncState").textContent = syncFailure
        ? `本次同步未完成，当前显示 ${items.length} 个已收录作品${incomplete ? ` · ${incomplete}` : ""}。${syncFailure.message}`
        : `当前显示 ${items.length} 个作品${incomplete ? ` · ${incomplete}` : ""}${lastSyncedAt ? ` · 最近同步 ${dateLabel(lastSyncedAt)}` : ""}。来源选择不代表发布审核通过。`;
    } catch (error) {
      get("librarySyncState").textContent = error.message || "成片库暂时无法连接，请稍后重试。";
      if (!loaded) {
        get("libraryCount").textContent = "暂未读取作品";
        get("libraryEmpty").hidden = false;
        get("libraryEmptyTitle").textContent = "暂时无法读取成片库";
        get("libraryEmptyText").textContent = "请确认服务已启动，再点击“同步作品”。";
      }
    } finally {
      syncing = false;
      get("syncLibrary").disabled = false;
      get("syncLibrary").innerHTML = '同步作品 <span aria-hidden="true">↻</span>';
      get("libraryGrid").setAttribute("aria-busy", "false");
    }
  }

  get("syncLibrary").addEventListener("click", syncLibrary);
  document.querySelectorAll("[data-library-source]").forEach((button) => {
    button.addEventListener("click", () => {
      selectedSource = button.dataset.librarySource;
      document.querySelectorAll("[data-library-source]").forEach((item) => item.setAttribute("aria-pressed", String(item === button)));
      renderItems();
    });
  });
  get("libraryGrid").addEventListener("click", (event) => {
    const button = event.target.closest("[data-publish-id]");
    if (!button) return;
    const item = items.find((entry) => String(entry.id) === button.dataset.publishId);
    if (!item) return;
    get("libraryGrid").querySelectorAll("video").forEach((video) => video.pause());
    window.parent.postMessage({ type: "content-library:publish", id: item.id }, location.origin);
    toast(window.parent === window ? "请从主应用的创作工作台进入发布编辑。" : "已选择作品，正在打开发布编辑。" );
  });
  window.addEventListener("workbench:route-change", (event) => {
    if (event.detail?.route === "library") syncLibrary();
    else get("libraryGrid").querySelectorAll("video").forEach((video) => video.pause());
  });
  if (location.hash === "#library" || new URLSearchParams(location.search).get("picker") === "1") syncLibrary();
})();
