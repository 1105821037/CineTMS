import { apiGet, apiPost } from "../api.js";
import { getHallOfflineMessage, getHallStatusErrorMessage, renderStatusAlert } from "../hall-status-alert.js";
import { toast } from "../toast.js";

const hallLogState = {
  hallId: "",
  hall: null,
  date: getLocalDateString(),
  entries: [],
  rawXml: "",
  loading: false,
  loaded: false,
};

export async function initHallLogPage() {
  hallLogState.hallId = decodeURIComponent(window.location.hash.split("/")[2] || "");
  hallLogState.date = getLocalDateString();
  hallLogState.entries = [];
  hallLogState.rawXml = "";
  hallLogState.loaded = false;
  bindHallLogEvents();
  await refreshHallLogData();
}

export function disposeHallLogPage() {}

function bindHallLogEvents() {
  const root = document.querySelector(".hall-log-shell");
  if (!root || root.dataset.bound === "true") {
    return;
  }
  root.dataset.bound = "true";

  document.getElementById("hallLogRefresh")?.addEventListener("click", () => {
    hallLogState.date = normalizeLogDate(document.getElementById("hallLogDate")?.value);
    void fetchHallLogs();
  });

  document.getElementById("hallLogDate")?.addEventListener("change", (event) => {
    hallLogState.date = normalizeLogDate(event.target.value);
    renderAll();
  });
}

async function refreshHallLogData() {
  if (!hallLogState.hallId) {
    setStatus("error", "请先从左侧选择一个影厅。");
    renderAll();
    return;
  }

  hallLogState.loading = true;
  renderAll();
  setStatus("info", "正在加载影厅信息...");

  try {
    const hallPayload = await apiGet(`/api/runtime/halls/${encodeURIComponent(hallLogState.hallId)}`);
    hallLogState.hall = normalizeHall(hallPayload.hall);
    renderAll();

    if (!hallLogState.hall?.online) {
      setStatus("warning", getHallOfflineMessage("log"));
      return;
    }

    await fetchHallLogs();
  } catch (error) {
    setStatus("error", getHallStatusErrorMessage(error, "加载 GDC 日志失败。"), { toast: true });
  } finally {
    hallLogState.loading = false;
    renderAll();
  }
}

async function fetchHallLogs() {
  if (!hallLogState.hall?.online) {
    setStatus("warning", getHallOfflineMessage("log"));
    renderAll();
    return;
  }

  hallLogState.loading = true;
  hallLogState.loaded = false;
  renderAll();
  setStatus("info", `正在读取 ${hallLogState.date} 的 GDC 日志...`);

  try {
    const payload = await apiPost(`/api/runtime/halls/${encodeURIComponent(hallLogState.hallId)}/logs`, {
      date: hallLogState.date,
    });
    const logs = payload.logs || {};
    hallLogState.entries = Array.isArray(logs.entries) ? logs.entries : [];
    hallLogState.rawXml = logs.rawXml || "";
    hallLogState.loaded = true;
    setStatus("success", `已读取 ${hallLogState.entries.length} 条 GDC 事件日志。`);
  } catch (error) {
    hallLogState.entries = [];
    hallLogState.rawXml = "";
    hallLogState.loaded = false;
    setStatus("error", error instanceof Error ? error.message : "读取 GDC 日志失败。", { toast: true });
  } finally {
    hallLogState.loading = false;
    renderAll();
  }
}

function normalizeHall(raw) {
  if (!raw) {
    return null;
  }

  return {
    id: raw.registration?.hallId || "",
    name: raw.registration?.hallName || raw.registration?.hallId || "当前影厅",
    host: raw.registration?.host || "",
    port: raw.registration?.port || "",
    online: raw.snapshot?.connectivity?.state === "online",
    connectivityState: raw.snapshot?.connectivity?.state || "unknown",
  };
}

function renderAll() {
  const dateInput = document.getElementById("hallLogDate");
  if (dateInput) {
    dateInput.value = normalizeLogDate(hallLogState.date);
    dateInput.disabled = hallLogState.loading;
  }

  const refreshButton = document.getElementById("hallLogRefresh");
  if (refreshButton) {
    refreshButton.disabled = hallLogState.loading || !hallLogState.hall?.online;
    refreshButton.innerHTML = hallLogState.loading
      ? '<span class="loading loading-spinner loading-xs"></span> 获取日志'
      : '<i class="fas fa-magnifying-glass"></i> 获取日志';
  }

  setText("hall-name", hallLogState.hall?.name || "当前影厅");
  setElementText("hallLogDateStat", hallLogState.date || "-");
  setElementText("hallLogCount", hallLogState.loaded ? String(hallLogState.entries.length) : "-");
  setElementText("hallLogOnlineState", describeConnectivityState(hallLogState.hall?.connectivityState));
  renderBadge();
  renderLogList();
}

function renderBadge() {
  const badge = document.getElementById("hallLogBadge");
  if (!badge) {
    return;
  }

  badge.className = "badge";
  if (hallLogState.loading) {
    badge.classList.add("badge-info");
    badge.textContent = "读取中";
    return;
  }
  if (!hallLogState.hall?.online) {
    badge.classList.add("badge-error");
    badge.textContent = "离线";
    return;
  }
  if (hallLogState.loaded) {
    badge.classList.add("badge-success");
    badge.textContent = `${hallLogState.entries.length} 条`;
    return;
  }
  badge.classList.add("badge-ghost");
  badge.textContent = "未加载";
}

function renderLogList() {
  const list = document.getElementById("hallLogList");
  if (!list) {
    return;
  }

  if (hallLogState.loading) {
    list.innerHTML = `
      <div class="hall-log-empty">
        <span class="loading loading-spinner loading-sm"></span>
        <span>正在读取日志...</span>
      </div>
    `;
    return;
  }

  if (!hallLogState.hall) {
    list.innerHTML = '<div class="hall-log-empty">请先从左侧选择一个影厅。</div>';
    return;
  }

  if (!hallLogState.hall.online) {
    list.innerHTML = `<div class="hall-log-empty">${escapeHtml(getHallOfflineMessage("log"))}</div>`;
    return;
  }

  if (!hallLogState.loaded) {
    list.innerHTML = '<div class="hall-log-empty">请选择日期并获取日志。</div>';
    return;
  }

  if (hallLogState.entries.length === 0) {
    list.innerHTML = '<div class="hall-log-empty">该日期没有返回 event 日志。</div>';
    return;
  }

  list.innerHTML = hallLogState.entries.map(renderLogEntry).join("");
}

function renderLogEntry(entry) {
  const title = entry.contentName || entry.annotation || entry.contentUuid || "-";
  const meta = [
    entry.status ? `状态：${entry.status}` : "",
    Number.isFinite(entry.reelIndex) ? `Reel：${entry.reelIndex}` : "",
    Number.isFinite(entry.cplIndex) ? `CPL：${entry.cplIndex}` : "",
    Number.isFinite(entry.cplDuration) ? `时长：${entry.cplDuration}` : "",
  ].filter(Boolean);
  const uuids = [
    entry.contentUuid ? `Content ${entry.contentUuid}` : "",
    entry.splUuid ? `SPL ${entry.splUuid}` : "",
    entry.kdmUuid ? `KDM ${entry.kdmUuid}` : "",
    entry.performanceUuid ? `Performance ${entry.performanceUuid}` : "",
  ].filter(Boolean);

  return `
    <article class="hall-log-item">
      <div class="hall-log-item-head">
        <div class="hall-log-item-title">
          <strong>${escapeHtml(entry.time || "--:--:--")}</strong>
          <span class="badge badge-outline badge-sm">${escapeHtml(entry.type || "Unknown")}</span>
        </div>
        <span class="text-xs text-base-content/55">${escapeHtml(entry.date || hallLogState.date)}</span>
      </div>
      <div class="hall-log-message">${escapeHtml(title)}</div>
      ${meta.length ? `<div class="hall-log-meta">${meta.map(escapeHtml).join(" · ")}</div>` : ""}
      ${uuids.length ? `<div class="hall-log-uuid-list">${uuids.map((item) => `<div>${escapeHtml(item)}</div>`).join("")}</div>` : ""}
      ${renderLogDetails(entry)}
    </article>
  `;
}

function renderLogDetails(entry) {
  if (!entry.detailsXml && !entry.rawXml) {
    return "";
  }

  return `
    <details class="hall-log-details">
      <summary>原始事件片段</summary>
      <pre>${escapeHtml(entry.rawXml || entry.detailsXml || "")}</pre>
    </details>
  `;
}

function setStatus(type, message, options = {}) {
  const node = document.getElementById("hallLogStatus");
  if (!node) {
    return;
  }

  renderStatusAlert(node, { type, message });
  if (options.toast && type === "error") {
    toast.error(message);
  }
}

function setText(field, value) {
  const node = document.querySelector(`[data-hall-log-field="${field}"]`);
  if (node) {
    node.textContent = value;
  }
}

function setElementText(id, value) {
  const node = document.getElementById(id);
  if (node) {
    node.textContent = value;
  }
}

function describeConnectivityState(state) {
  if (state === "online") {
    return "在线";
  }
  if (!state || state === "unknown") {
    return "未知";
  }
  return "离线";
}

function normalizeLogDate(value) {
  const normalized = String(value || "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(normalized) ? normalized : getLocalDateString();
}

function getLocalDateString(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
