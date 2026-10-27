const routes = {
  automatic: { title: "自动化成片", product: "AI Signal Studio", number: "01", url: "", notice: "选题、制作与挑选都在下方工作区完成。切换线路会保留当前页面。" },
  editing: { title: "素材智剪", product: "OpenChatCut", number: "02", url: "", notice: "上传实拍素材，在原工作区用自然语言剪辑、预览与导出。切换线路会保留当前工程页面。" },
  creation: { title: "AIGC 创作", product: "Toonflow", number: "03", url: "", notice: "文案与文生图已接入。图片请选择「GPT Image 2 · 公司文生图」，尺寸与比例使用自动；参考图编辑、视频生成尚待接入。" },
};
const pickerMode = new URLSearchParams(location.search).get("picker") === "1";
document.body.classList.toggle("libraryPicker", pickerMode);
let currentRoute = "overview";
let latestStatus = null;
let refreshing = false;
let statusFailed = false;
const frames = new Map();
const byId = (id) => document.getElementById(id);

function navigate() {
  const requested = pickerMode ? "library" : (window.location.hash.slice(1) || "overview");
  currentRoute = ["overview", "library", ...Object.keys(routes)].includes(requested) ? requested : "overview";
  document.querySelectorAll(".navItem").forEach((link) => {
    const selected = link.dataset.route === currentRoute;
    link.classList.toggle("selected", selected);
    if (selected) link.setAttribute("aria-current", "page"); else link.removeAttribute("aria-current");
  });
  byId("overview").hidden = currentRoute !== "overview";
  byId("library").hidden = currentRoute !== "library";
  byId("embedded").hidden = !routes[currentRoute];
  byId("pageName").textContent = routes[currentRoute]?.title || (currentRoute === "library" ? "素材库" : "总览");
  document.title = `${byId("pageName").textContent} · 视频创作工作台`;
  if (routes[currentRoute]) {
    const route = routes[currentRoute];
    byId("activeRouteNumber").textContent = route.number;
    byId("activeTitle").textContent = route.title;
    byId("activeProduct").textContent = route.product;
    byId("workspaceNotice").textContent = route.notice;
    showWorkspace();
  } else {
    frames.forEach((frame) => { frame.hidden = true; });
    document.body.classList.remove("focusMode");
    updateFocusButton();
  }
  window.dispatchEvent(new CustomEvent("workbench:route-change", { detail: { route: currentRoute } }));
}

function setBadge(element, online, pending = false, configured = true) {
  element.textContent = pending ? "检查中" : !configured ? "未配置" : online ? "服务在线" : "服务离线";
  element.classList.toggle("online", !!online && !pending);
  element.classList.toggle("offline", !online && !pending);
}

function setServiceLink(element, url) {
  if (!element) return;
  if (url) {
    element.href = url;
    element.removeAttribute("aria-disabled");
    element.removeAttribute("tabindex");
  } else {
    element.removeAttribute("href");
    element.setAttribute("aria-disabled", "true");
    element.setAttribute("tabindex", "-1");
  }
}

function showWorkspace() {
  if (!routes[currentRoute]) return;
  const route = routes[currentRoute];
  const status = latestStatus?.services.find((item) => item.id === currentRoute);
  setBadge(byId("activeStatus"), status?.online, !latestStatus && !statusFailed, !!route.url);
  if (statusFailed) byId("activeStatus").textContent = "状态未知";
  setServiceLink(byId("standaloneLink"), route.url);
  let frame = frames.get(currentRoute);
  if (status?.online && route.url) {
    if (!frame) {
      frame = document.createElement("iframe");
      frame.title = `${route.title} — ${route.product}`;
      frame.allowFullscreen = true;
      frame.referrerPolicy = "no-referrer";
      byId("frameArea").append(frame);
      frames.set(currentRoute, frame);
    }
    if (frame.getAttribute("src") !== route.url) frame.src = route.url;
  }
  const visibleFrame = route.url && frame?.getAttribute("src") === route.url ? frame : null;
  frames.forEach((item) => { item.hidden = item !== visibleFrame; });
  byId("connectionPlaceholder").hidden = !!visibleFrame;
  if (!visibleFrame) {
    const unconfigured = latestStatus && !route.url;
    const offline = statusFailed || (latestStatus && !status?.online);
    byId("placeholderTitle").textContent = unconfigured ? `${route.product} 尚未配置` : offline ? `${route.product} 暂未连接` : "正在连接工作区";
    byId("placeholderText").textContent = unconfigured ? "工作区地址尚未配置，请联系管理员完成接入后重新检查。" : offline ? "启动对应的服务后，点击重新检查即可进入。" : "请稍候，正在检查服务。";
    byId("retryConnection").hidden = !offline && !unconfigured;
  }
}

async function refreshStatus() {
  if (refreshing) return;
  refreshing = true;
  byId("refreshStatus").classList.add("spinning");
  byId("refreshStatus").disabled = true;
  try {
    const response = await fetch("/api/creative-workbench/status", { cache: "no-store", signal: AbortSignal.timeout(7000) });
    if (response.status === 401) window.parent.postMessage({ type: "content-workbench:unauthorized" }, location.origin);
    if (!response.ok) throw new Error("Status unavailable");
    const status = await response.json();
    if (!Array.isArray(status.services)) throw new Error("Invalid status response");
    latestStatus = status;
    statusFailed = false;
    let onlineCount = 0;
    for (const [id, route] of Object.entries(routes)) {
      const service = latestStatus.services.find((item) => item.id === id);
      route.url = typeof service?.url === "string" ? service.url : "";
      const online = !!route.url && !!service?.online;
      if (online) onlineCount++;
      document.querySelectorAll(`[data-status="${id}"]`).forEach((element) => setBadge(element, online, false, !!route.url));
      const connection = document.querySelector(`[data-connection="${id}"]`);
      if (connection) {
        connection.textContent = !route.url ? "未配置" : online ? "已连接" : "未启动";
        connection.classList.toggle("online", online);
      }
      setServiceLink(connection?.parentElement.querySelector("a"), route.url);
      document.querySelector(`[data-dot="${id}"]`)?.classList.toggle("online", online);
    }
    byId("serviceSummary").textContent = `${onlineCount} / ${Object.keys(routes).length} 个服务在线`;
    byId("serviceSummary").classList.toggle("allOnline", onlineCount === Object.keys(routes).length);
    byId("checkedAt").textContent = `检查于 ${new Date(latestStatus.checkedAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false })}`;
  } catch {
    statusFailed = true;
    latestStatus = null;
    byId("serviceSummary").textContent = "连接状态暂不可用";
    byId("serviceSummary").classList.remove("allOnline");
    byId("checkedAt").textContent = "状态检查失败，可重试";
    document.querySelectorAll("[data-status]").forEach((element) => { setBadge(element, false); element.textContent = "状态未知"; });
    document.querySelectorAll("[data-connection]").forEach((element) => { element.textContent = "状态未知"; element.classList.remove("online"); });
    document.querySelectorAll("[data-dot]").forEach((element) => element.classList.remove("online"));
  } finally {
    refreshing = false;
    byId("refreshStatus").classList.remove("spinning");
    byId("refreshStatus").disabled = false;
    showWorkspace();
  }
}

function updateFocusButton() {
  const focused = document.body.classList.contains("focusMode");
  byId("focusMode").textContent = focused ? "收起工作区" : "展开工作区";
  byId("focusMode").setAttribute("aria-pressed", String(focused));
}
byId("focusMode").addEventListener("click", () => { document.body.classList.toggle("focusMode"); updateFocusButton(); });
byId("refreshStatus").addEventListener("click", refreshStatus);
byId("retryConnection").addEventListener("click", refreshStatus);
document.querySelector(".skipLink").addEventListener("click", (event) => { event.preventDefault(); byId("main").focus(); });
window.addEventListener("hashchange", navigate);
window.addEventListener("keydown", (event) => { if (event.key === "Escape" && document.body.classList.contains("focusMode")) { document.body.classList.remove("focusMode"); updateFocusButton(); } });
document.addEventListener("visibilitychange", () => { if (!document.hidden) refreshStatus(); });
document.querySelectorAll("[data-connection]").forEach((element) => setServiceLink(element.parentElement.querySelector("a"), ""));
navigate();
refreshStatus();
setInterval(() => { if (!document.hidden) refreshStatus(); }, 30000);
