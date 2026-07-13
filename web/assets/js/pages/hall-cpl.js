import { apiGet, apiPost } from "../api.js";
import { getHallOfflineMessage, getHallStatusErrorMessage, renderStatusAlert } from "../hall-status-alert.js";
import { toast } from "../toast.js";

const legacyExternalFtpStorageKey = "tms.hallCpl.externalFtpSources";

const hallCplState = {
  hallId: "",
  hall: null,
  deviceCpls: [],
  repositoryCpls: [],
  tasks: [],
  selectedRepositoryKeys: new Set(),
  externalFtp: {
    systemSources: [],
    customSources: [],
    selectedSourceId: "",
    currentPath: "",
    rootEntries: [],
    nodes: new Map(),
    package: null,
    selectedPackagePath: "",
    selectedCplUuid: "",
    loadingSources: false,
    loadingEntries: false,
    loadingPackage: false,
    submitting: false,
    error: "",
  },
  loading: false,
  taskRefreshing: false,
  taskRefreshTimer: null,
};

export async function initHallCplPage() {
  clearLegacyExternalFtpStorage();
  hallCplState.hallId = decodeURIComponent(window.location.hash.split("/")[2] || "");
  hallCplState.selectedRepositoryKeys.clear();
  bindHallCplEvents();
  await refreshHallCplData();
}

export function disposeHallCplPage() {
  if (hallCplState.taskRefreshTimer) {
    window.clearInterval(hallCplState.taskRefreshTimer);
    hallCplState.taskRefreshTimer = null;
  }
}

function bindHallCplEvents() {
  const root = document.querySelector(".hall-cpl-shell");
  if (!root || root.dataset.bound === "true") {
    return;
  }
  root.dataset.bound = "true";

  document.getElementById("hallCplRefresh")?.addEventListener("click", () => {
    void refreshHallCplData();
  });
  document.getElementById("hallCplRepositoryImport")?.addEventListener("click", openRepositoryModal);
  document.getElementById("hallCplRepositoryClose")?.addEventListener("click", closeRepositoryModal);
  document.getElementById("hallCplRepositoryCancel")?.addEventListener("click", closeRepositoryModal);
  document.getElementById("hallCplExternalImport")?.addEventListener("click", () => {
    void openExternalModal();
  });
  document.getElementById("hallCplExternalClose")?.addEventListener("click", closeExternalModal);
  document.getElementById("hallCplExternalCancel")?.addEventListener("click", closeExternalModal);
  document.getElementById("hallCplExternalReload")?.addEventListener("click", () => {
    void loadExternalRootDirectory({ force: true });
  });
  document.getElementById("hallCplExternalRemoveSource")?.addEventListener("click", () => {
    void removeSelectedCustomExternalFtpSource();
  });
  document.getElementById("hallCplExternalOpenAddSource")?.addEventListener("click", openExternalAddModal);
  document.getElementById("hallCplExternalAddClose")?.addEventListener("click", closeExternalAddModal);
  document.getElementById("hallCplExternalAddCancel")?.addEventListener("click", closeExternalAddModal);
  document.getElementById("hallCplExternalSource")?.addEventListener("change", (event) => {
    hallCplState.externalFtp.selectedSourceId = event.target.value || "";
    resetExternalTree();
    renderExternalModal();
    void loadExternalRootDirectory({ force: true });
  });
  document.getElementById("hallCplExternalAddSource")?.addEventListener("click", () => {
    void addCustomExternalFtpSource();
  });
  document.getElementById("hallCplExternalConfirm")?.addEventListener("click", (event) => {
    void importExternalCpl(event.currentTarget);
  });
  document.getElementById("hallCplTaskTrigger")?.addEventListener("click", openTaskModal);
  document.getElementById("hallCplTaskClose")?.addEventListener("click", closeTaskModal);
  document.getElementById("hallCplTaskCancel")?.addEventListener("click", closeTaskModal);
  document.getElementById("hallCplBatchImport")?.addEventListener("click", () => {
    void importSelectedRepositoryCpls();
  });
  document.getElementById("hallCplSelectAll")?.addEventListener("change", (event) => {
    const checked = event.target.checked;
    for (const item of getImportableRepositoryCpls()) {
      if (checked) {
        hallCplState.selectedRepositoryKeys.add(getRepositoryKey(item));
      } else {
        hallCplState.selectedRepositoryKeys.delete(getRepositoryKey(item));
      }
    }
    renderRepositoryTable();
  });

  root.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const importButton = target?.closest("[data-hall-cpl-import]");
    if (importButton) {
      const key = importButton.dataset.hallCplImport || "";
      const item = hallCplState.repositoryCpls.find((candidate) => getRepositoryKey(candidate) === key);
      if (item) {
        void importRepositoryCpls([item], importButton);
      }
      return;
    }

    const deleteButton = target?.closest("[data-hall-cpl-delete-device]");
    if (deleteButton) {
      void deleteDeviceCpl(deleteButton.dataset.hallCplDeleteDevice || "", deleteButton);
      return;
    }

    const cancelTaskButton = target?.closest("[data-hall-cpl-task-cancel]");
    if (cancelTaskButton) {
      void cancelCplTask(cancelTaskButton.dataset.hallCplTaskCancel || "", cancelTaskButton);
      return;
    }

    const externalNode = target?.closest("[data-hall-cpl-external-node]");
    if (externalNode) {
      void handleExternalTreeNode(externalNode.dataset.hallCplExternalNode || "");
      return;
    }
  });

  root.addEventListener("change", (event) => {
    const checkbox = event.target instanceof Element ? event.target.closest("[data-hall-cpl-select]") : null;
    if (!checkbox) {
      return;
    }
    const key = checkbox.dataset.hallCplSelect || "";
    if (checkbox.checked) {
      hallCplState.selectedRepositoryKeys.add(key);
    } else {
      hallCplState.selectedRepositoryKeys.delete(key);
    }
    renderRepositoryActions();
  });

  root.addEventListener("change", (event) => {
    const radio = event.target instanceof Element ? event.target.closest("[data-hall-cpl-external-cpl]") : null;
    if (!radio) {
      return;
    }
    hallCplState.externalFtp.selectedCplUuid = radio.dataset.hallCplExternalCpl || "";
    renderExternalActions();
  });
}

async function refreshHallCplData() {
  if (!hallCplState.hallId) {
    setStatus("error", "请先从左侧选择一个影厅。");
    return;
  }

  hallCplState.loading = true;
  renderAll();
  setStatus("info", "正在加载影厅 CPL 信息...");

  try {
    const [hallPayload, dcpPayload] = await Promise.all([
      apiGet(`/api/runtime/halls/${encodeURIComponent(hallCplState.hallId)}`),
      apiGet("/api/dcp/assets"),
    ]);
    hallCplState.hall = normalizeHall(hallPayload.hall);
    applyRepositoryPayload(dcpPayload);

    if (hallCplState.hall?.online) {
      const cplPayload = await apiPost(`/api/runtime/halls/${encodeURIComponent(hallCplState.hallId)}/cpls`, {});
      hallCplState.deviceCpls = Array.isArray(cplPayload.cpls) ? cplPayload.cpls : [];
      setStatus("success", `已加载 ${hallCplState.deviceCpls.length} 个设备内 CPL。`);
    } else {
      hallCplState.deviceCpls = [];
      setStatus("warning", getHallOfflineMessage("cpl"));
    }
  } catch (error) {
    setStatus("error", getHallStatusErrorMessage(error, "加载影厅 CPL 失败。"), { toast: true });
  } finally {
    hallCplState.loading = false;
    pruneSelectedRepositoryKeys();
    renderAll();
    syncTaskPolling();
  }
}

function normalizeHall(raw) {
  if (!raw?.registration) {
    return null;
  }
  return {
    hallId: raw.registration.hallId,
    hallName: raw.registration.hallName || raw.registration.hallId,
    deviceId: raw.registration.deviceId,
    online: raw.snapshot?.connectivity?.state === "online",
    host: raw.registration.host,
    port: raw.registration.port,
  };
}

function applyRepositoryPayload(payload) {
  const cpls = Array.isArray(payload.cpls) ? payload.cpls : [];
  const tasks = Array.isArray(payload.tasks) ? payload.tasks : [];
  hallCplState.repositoryCpls = cpls
    .filter((cpl) => cpl?.packageId && (cpl.cplUuid || cpl.uuid))
    .sort((left, right) => compareText(getCplTitle(left), getCplTitle(right)));
  applyTaskPayload(tasks);
}

function applyTaskPayload(tasks) {
  hallCplState.tasks = tasks.filter((task) => task.type === "DCP" && task.hallId === hallCplState.hallId);
}

async function importSelectedRepositoryCpls() {
  const selected = getSelectedRepositoryCpls();
  await importRepositoryCpls(selected);
}

async function importRepositoryCpls(items, button = null) {
  const importable = items.filter((item) => !getRepositoryCplStatus(item).importDisabled);
  if (importable.length === 0) {
    setStatus("warning", "请先选择可导入的 CPL。", { toast: true });
    return;
  }

  if (button) {
    button.disabled = true;
  }
  setStatus("info", `正在为 ${importable.length} 个 CPL 创建导入任务...`);

  try {
    const payload = await apiPost("/api/dcp/ingest", {
      items: importable.map((item) => ({
        packageId: item.packageId,
        cplUuid: item.cplUuid || item.uuid,
      })),
      hallIds: [hallCplState.hallId],
    });
    applyRepositoryPayload(payload);
    hallCplState.selectedRepositoryKeys.clear();
    const imported = Array.isArray(payload.imported) ? payload.imported.length : 0;
    const failed = Array.isArray(payload.failed) ? payload.failed : [];
    if (failed.length > 0) {
      setStatus("warning", `已创建 ${imported} 个导入任务，${failed.length} 个失败。${failed[0]?.error || ""}`, { toast: true });
    } else {
      setStatus("success", `已创建 ${imported} 个 CPL 导入任务。`, { toast: true });
    }
    renderAll();
    syncTaskPolling();
    closeRepositoryModal();
  } catch (error) {
    setStatus("error", error instanceof Error ? error.message : "导入 CPL 失败。", { toast: true });
    await refreshHallCplData().catch(() => undefined);
  } finally {
    if (button) {
      button.disabled = false;
    }
    renderAll();
  }
}

function renderAll() {
  renderHallSummary();
  renderStats();
  renderDeviceTable();
  renderRepositoryTable();
  renderTaskTable();
  renderModalSummaries();
  renderExternalModal();
}

function renderHallSummary() {
  const hallName = hallCplState.hall?.hallName || hallCplState.hallId || "当前影厅";
  setText("hall-name", hallName);
  const badge = document.getElementById("hallCplOnlineBadge");
  if (badge) {
    const online = hallCplState.hall?.online === true;
    badge.className = `badge ${online ? "badge-success" : "badge-warning"}`;
    badge.textContent = online ? "设备在线" : "设备离线";
  }
}

function renderStats() {
  setNodeText("hallCplDeviceCount", hallCplState.deviceCpls.length);
  setNodeText("hallCplImportableCount", getImportableRepositoryCpls().length);
  setNodeText("hallCplTaskCount", hallCplState.tasks.length);
}

function renderDeviceTable() {
  const table = document.getElementById("hallCplDeviceTable");
  if (!table) return;
  if (hallCplState.loading) {
    table.innerHTML = '<tr><td colspan="6" class="text-center text-base-content/60">正在加载设备内 CPL...</td></tr>';
    return;
  }
  if (!hallCplState.hall?.online) {
    table.innerHTML = `<tr><td colspan="6" class="text-center text-base-content/60">${escapeHtml(getHallOfflineMessage("cpl"))}</td></tr>`;
    return;
  }
  if (hallCplState.deviceCpls.length === 0) {
    table.innerHTML = '<tr><td colspan="6" class="text-center text-base-content/60">设备内暂无 CPL。</td></tr>';
    return;
  }

  table.innerHTML = hallCplState.deviceCpls.map((cpl) => {
    const title = getCplTitle(cpl);
    const specs = getCplSpecBadges(cpl);
    const cplUuid = cpl.cplUuid || cpl.uuid || "";
    const contentKind = formatContentKind(cpl.contentKind);
    const duration = formatDuration(cpl.durationSeconds, cpl.durationFrames);
    return `
      <tr>
        <td class="hall-cpl-mobile-card-cell" colspan="6">
          <details class="collapse collapse-arrow bg-base-100 border border-base-300">
            <summary class="collapse-title hall-cpl-mobile-card-title">
              <div class="min-w-0">
                <div class="hall-cpl-mobile-card-name">${escapeHtml(title)}</div>
                <div class="hall-cpl-mobile-card-meta">${escapeHtml([contentKind, duration].filter(Boolean).join(" · "))}</div>
              </div>
            </summary>
            <div class="collapse-content hall-cpl-mobile-card-content">
              <dl>
                <div>
                  <dt>类型</dt>
                  <dd>${escapeHtml(contentKind)}</dd>
                </div>
                <div>
                  <dt>规格</dt>
                  <dd><div class="flex flex-wrap gap-1">${renderBadges(specs)}</div></dd>
                </div>
                <div>
                  <dt>时长</dt>
                  <dd>${escapeHtml(duration)}</dd>
                </div>
                <div>
                  <dt>导入时间</dt>
                  <dd>${formatDateTime(cpl.ingestDateTime)}</dd>
                </div>
              </dl>
              <div class="hall-cpl-mobile-card-actions">
                <button class="btn btn-sm btn-error btn-outline" data-hall-cpl-delete-device="${escapeHtml(cplUuid)}">
                  <i class="fas fa-trash"></i>
                  删除
                </button>
              </div>
            </div>
          </details>
        </td>
        <td data-label="影片版本">
          <div class="font-medium">${escapeHtml(title)}</div>
        </td>
        <td data-label="类型">${escapeHtml(contentKind)}</td>
        <td data-label="规格">
          <div class="flex flex-wrap gap-1">
            ${renderBadges(specs)}
          </div>
        </td>
        <td data-label="时长">${escapeHtml(duration)}</td>
        <td data-label="导入时间">${formatDateTime(cpl.ingestDateTime)}</td>
        <td data-label="操作" class="text-right">
          <button class="btn btn-sm btn-error btn-outline" data-hall-cpl-delete-device="${escapeHtml(cplUuid)}">
            <i class="fas fa-trash"></i>
          </button>
        </td>
      </tr>
    `;
  }).join("");
}

async function deleteDeviceCpl(cplUuid, button = null) {
  const cpl = hallCplState.deviceCpls.find((item) => (item.cplUuid || item.uuid) === cplUuid);
  const title = cpl ? getCplTitle(cpl) : cplUuid;
  if (!cplUuid || !confirm(`确定要从当前影厅删除 "${title}" 吗？此操作不可撤销。`)) {
    return;
  }

  if (button) {
    button.disabled = true;
  }
  setStatus("info", `正在删除 ${title}...`);
  try {
    await apiPost(
      `/api/runtime/halls/${encodeURIComponent(hallCplState.hallId)}/cpls/${encodeURIComponent(cplUuid)}/delete`,
      { title },
    );
    setStatus("success", `已删除 ${title}。`, { toast: true });
    await refreshHallCplData();
  } catch (error) {
    setStatus("error", errorMessage(error, "删除设备内 CPL 失败。"), { toast: true });
    if (button) {
      button.disabled = false;
    }
  }
}

function renderRepositoryTable() {
  const table = document.getElementById("hallCplRepositoryTable");
  if (!table) return;
  if (hallCplState.loading) {
    table.innerHTML = '<tr><td colspan="6" class="text-center text-base-content/60">正在加载存储库 CPL...</td></tr>';
    return;
  }
  if (hallCplState.repositoryCpls.length === 0) {
    table.innerHTML = '<tr><td colspan="6" class="text-center text-base-content/60">存储库中暂无可识别的 CPL。</td></tr>';
    renderRepositoryActions();
    return;
  }

  table.innerHTML = hallCplState.repositoryCpls.map((cpl) => {
    const status = getRepositoryCplStatus(cpl);
    const key = getRepositoryKey(cpl);
    const display = getCplDisplayParts(cpl);
    const checked = hallCplState.selectedRepositoryKeys.has(key);
    const duration = formatDuration(cpl.durationSeconds, cpl.durationFrames);
    return `
      <tr>
        <td class="hall-cpl-repository-mobile-card-cell" colspan="6">
          <details class="collapse collapse-arrow bg-base-100 border border-base-300">
            <summary class="collapse-title hall-cpl-mobile-card-title">
              <div class="hall-cpl-mobile-card-title-main">
                <input
                  type="checkbox"
                  class="checkbox checkbox-sm"
                  data-hall-cpl-select="${escapeHtml(key)}"
                  ${checked ? "checked" : ""}
                  ${status.importDisabled ? "disabled" : ""}
                  onclick="event.stopPropagation()"
                >
                <div class="min-w-0">
                  <div class="hall-cpl-mobile-card-name">${escapeHtml(display.movieName)}</div>
                  <div class="hall-cpl-mobile-card-meta">${escapeHtml(display.version || cpl.packageName || "-")}</div>
                </div>
              </div>
              <span class="badge badge-sm ${status.className}">${status.label}</span>
            </summary>
            <div class="collapse-content hall-cpl-mobile-card-content">
              <dl>
                <div>
                  <dt>影片包</dt>
                  <dd>${escapeHtml(cpl.packageName || "-")}</dd>
                </div>
                <div>
                  <dt>信息</dt>
                  <dd>
                    <div class="flex flex-wrap gap-1">
                      ${display.badges.map((badge) => `<span class="badge badge-ghost badge-sm">${escapeHtml(badge)}</span>`).join("")}
                    </div>
                    <div class="mt-1 text-xs text-base-content/55">${escapeHtml(duration)}</div>
                  </dd>
                </div>
                ${status.message ? `
                  <div>
                    <dt>状态说明</dt>
                    <dd>${escapeHtml(status.message)}</dd>
                  </div>
                ` : ""}
              </dl>
              <div class="hall-cpl-mobile-card-actions">
                <button class="btn btn-sm btn-primary" data-hall-cpl-import="${escapeHtml(key)}" ${status.importDisabled ? "disabled" : ""}>
                  <i class="fas fa-download"></i>
                  导入
                </button>
              </div>
            </div>
          </details>
        </td>
        <td data-label="选择">
          <input
            type="checkbox"
            class="checkbox checkbox-sm"
            data-hall-cpl-select="${escapeHtml(key)}"
            ${checked ? "checked" : ""}
            ${status.importDisabled ? "disabled" : ""}
          >
        </td>
        <td data-label="影片版本">
          <div class="font-medium">${escapeHtml(display.movieName)}</div>
          <div class="text-xs text-base-content/65">${escapeHtml(display.version)}</div>
        </td>
        <td data-label="影片包">
          <div class="font-medium">${escapeHtml(cpl.packageName || "-")}</div>
        </td>
        <td data-label="信息">
          <div class="flex flex-wrap gap-1">
            ${display.badges.map((badge) => `<span class="badge badge-ghost badge-sm">${escapeHtml(badge)}</span>`).join("")}
          </div>
          <div class="mt-1 text-xs text-base-content/55">${escapeHtml(duration)}</div>
        </td>
        <td data-label="状态">
          <span class="badge ${status.className}">${status.label}</span>
          ${status.message ? `<div class="mt-1 max-w-52 text-xs text-base-content/55">${escapeHtml(status.message)}</div>` : ""}
        </td>
        <td data-label="操作">
          <button class="btn btn-sm btn-primary" data-hall-cpl-import="${escapeHtml(key)}" ${status.importDisabled ? "disabled" : ""}>
            <i class="fas fa-download"></i>
            导入
          </button>
        </td>
      </tr>
    `;
  }).join("");
  renderRepositoryActions();
}

function renderTaskTable() {
  const table = document.getElementById("hallCplTaskTable");
  if (!table) return;
  if (hallCplState.tasks.length === 0) {
    table.innerHTML = '<tr><td colspan="5" class="text-center text-base-content/60">暂无 CPL 导入任务。</td></tr>';
    return;
  }

  table.innerHTML = hallCplState.tasks.map((task) => {
    const status = getTaskStatus(task);
    const canCancel = isCancellableTaskStatus(task.status);
    const title = getTaskTitle(task);
    const subtitle = getTaskSubtitle(task, title);
    const progress = formatTaskProgress(task);
    return `
      <tr>
        <td class="hall-cpl-task-mobile-card-cell" colspan="5">
          <details class="collapse collapse-arrow bg-base-100 border border-base-300">
            <summary class="collapse-title hall-cpl-mobile-card-title">
              <div class="min-w-0">
                <div class="hall-cpl-mobile-card-name">${escapeHtml(title)}</div>
                <div class="hall-cpl-mobile-card-meta">${escapeHtml(subtitle || formatDateTime(task.updatedAt || task.createdAt))}</div>
              </div>
              <span class="badge badge-sm ${status.className}">${status.label}</span>
            </summary>
            <div class="collapse-content hall-cpl-mobile-card-content">
              <dl>
                ${subtitle ? `
                  <div>
                    <dt>内容</dt>
                    <dd>${escapeHtml(subtitle)}</dd>
                  </div>
                ` : ""}
                ${task.description ? `
                  <div>
                    <dt>状态说明</dt>
                    <dd>${escapeHtml(task.description)}</dd>
                  </div>
                ` : ""}
                <div>
                  <dt>进度</dt>
                  <dd>${progress}</dd>
                </div>
                <div>
                  <dt>更新时间</dt>
                  <dd>${formatDateTime(task.updatedAt || task.createdAt)}</dd>
                </div>
              </dl>
              ${formatTaskError(task)}
              <div class="hall-cpl-mobile-card-actions">
                ${canCancel
                  ? `<button type="button" class="btn btn-sm btn-ghost gap-1" data-hall-cpl-task-cancel="${escapeHtml(task.id || "")}">
                      <i class="fas fa-ban"></i>
                      取消
                    </button>`
                  : '<span class="text-sm text-base-content/45">-</span>'}
              </div>
            </div>
          </details>
        </td>
        <td data-label="影片版本">
          <div class="font-medium">${escapeHtml(title)}</div>
          ${subtitle ? `<div class="text-xs text-base-content/55">${escapeHtml(subtitle)}</div>` : ""}
          ${formatTaskError(task)}
        </td>
        <td data-label="状态">
          <span class="badge ${status.className}">${status.label}</span>
          ${task.description ? `<div class="mt-1 text-xs text-base-content/60">${escapeHtml(task.description)}</div>` : ""}
        </td>
        <td data-label="进度">${progress}</td>
        <td data-label="更新时间">${formatDateTime(task.updatedAt || task.createdAt)}</td>
        <td data-label="操作">
          ${canCancel
            ? `<button type="button" class="btn btn-sm btn-ghost gap-1" data-hall-cpl-task-cancel="${escapeHtml(task.id || "")}">
                <i class="fas fa-ban"></i>
                取消
              </button>`
            : '<span class="text-sm text-base-content/45">-</span>'}
        </td>
      </tr>
    `;
  }).join("");
}

function renderModalSummaries() {
  const repositorySummary = document.getElementById("hallCplRepositorySummary");
  const repositorySelection = document.getElementById("hallCplRepositorySelection");
  const taskSummary = document.getElementById("hallCplTaskSummary");
  const importableCount = getImportableRepositoryCpls().length;
  const selectedCount = getSelectedRepositoryCpls().length;

  if (repositorySummary) {
    repositorySummary.textContent = hallCplState.repositoryCpls.length === 0
      ? "存储库中暂无可导入的 CPL"
      : `${hallCplState.repositoryCpls.length} 个存储库 CPL，${importableCount} 个可导入当前影厅`;
  }
  if (repositorySelection) {
    repositorySelection.textContent = `已选 ${selectedCount} 项`;
  }
  if (taskSummary) {
    taskSummary.textContent = hallCplState.tasks.length === 0
      ? "当前影厅暂无 CPL 导入任务"
      : `当前影厅共有 ${hallCplState.tasks.length} 条 CPL 导入任务`;
  }
}

function renderRepositoryActions() {
  const selected = getSelectedRepositoryCpls();
  const openButton = document.getElementById("hallCplRepositoryImport");
  if (openButton) {
    openButton.disabled = hallCplState.loading;
  }

  const taskButton = document.getElementById("hallCplTaskTrigger");
  if (taskButton) {
    taskButton.disabled = hallCplState.loading;
  }

  const batchButton = document.getElementById("hallCplBatchImport");
  if (batchButton) {
    batchButton.disabled = selected.length === 0 || hallCplState.loading || hallCplState.hall?.online !== true;
  }

  const selectAll = document.getElementById("hallCplSelectAll");
  if (selectAll) {
    const importable = getImportableRepositoryCpls();
    selectAll.disabled = importable.length === 0;
    selectAll.checked = importable.length > 0 && importable.every((item) => hallCplState.selectedRepositoryKeys.has(getRepositoryKey(item)));
    selectAll.indeterminate = selected.length > 0 && !selectAll.checked;
  }
  renderModalSummaries();
}

function renderExternalModal() {
  const state = hallCplState.externalFtp;
  const sources = getExternalFtpSources();
  const sourceSelect = document.getElementById("hallCplExternalSource");
  if (sourceSelect) {
    const hasSelectedSource = sources.some((source) => source.id === state.selectedSourceId && isExternalFtpSourceSelectable(source));
    sourceSelect.innerHTML = `
      <option value="" ${hasSelectedSource ? "" : "selected"} disabled>请选择 FTP 来源</option>
      ${sources.map((source) => `
        <option
          value="${escapeHtml(source.id)}"
          ${source.id === state.selectedSourceId && isExternalFtpSourceSelectable(source) ? "selected" : ""}
          ${isExternalFtpSourceSelectable(source) ? "" : "disabled"}
        >
          ${escapeHtml(formatExternalFtpLabel(source))}
        </option>
      `).join("")}
    `;
    sourceSelect.disabled = state.loadingSources || state.submitting || sources.length === 0;
  }

  const summary = document.getElementById("hallCplExternalSummary");
  if (summary) {
    const source = getSelectedExternalFtpSource();
    summary.textContent = source
      ? `${formatExternalFtpLabel(source)}${source.rootPath ? ` / ${source.rootPath}` : ""}`
      : "选择外部 FTP 中的 DCP 包";
  }

  const pathNode = document.getElementById("hallCplExternalPath");
  if (pathNode) {
    pathNode.textContent = `/${state.currentPath || ""}`;
  }
  renderExternalTree();
  renderExternalCplTable();
  renderExternalActions();
}

function renderExternalTree() {
  const tree = document.getElementById("hallCplExternalTree");
  if (!tree) return;
  const state = hallCplState.externalFtp;
  if (state.loadingEntries) {
    tree.innerHTML = '<div class="py-8 text-center text-base-content/60">正在读取 FTP 根目录...</div>';
    return;
  }
  if (state.error && !state.loadingPackage) {
    tree.innerHTML = `<div class="py-8 text-center text-error">${escapeHtml(state.error)}</div>`;
    return;
  }
  if (!state.selectedSourceId) {
    tree.innerHTML = '<div class="py-8 text-center text-base-content/60">请选择可用 FTP 来源。</div>';
    return;
  }
  const source = getSelectedExternalFtpSource();
  if (!isExternalFtpSourceSelectable(source)) {
    tree.innerHTML = `<div class="py-8 text-center text-base-content/60">${escapeHtml(source?.disabledReason || "该 FTP 来源不可用。")}</div>`;
    return;
  }
  if (state.rootEntries.length === 0) {
    tree.innerHTML = '<div class="py-8 text-center text-base-content/60">根目录为空。</div>';
    return;
  }

  tree.innerHTML = state.rootEntries
    .map((entry) => renderExternalTreeNode(entry, 0))
    .join("");
}

function renderExternalTreeNode(entry, depth) {
  const state = hallCplState.externalFtp;
  const node = state.nodes.get(entry.path) || ensureExternalTreeNode(entry);
  const selected = state.selectedPackagePath === entry.path;
  const icon = node.isDcp
    ? "fa-box-open text-success"
    : node.expanded
      ? "fa-folder-open text-warning"
      : "fa-folder text-warning";
  const status = node.loading
    ? '<span class="loading loading-spinner loading-xs"></span>'
    : node.isDcp
      ? '<span class="badge badge-success badge-xs">DCP</span>'
      : "";
  const children = node.expanded && node.children.length > 0
    ? `<div>${node.children.map((child) => renderExternalTreeNode(child, depth + 1)).join("")}</div>`
    : "";
  const empty = node.expanded && node.loaded && node.children.length === 0 && !node.isDcp
    ? `<div class="py-1 text-xs text-base-content/45" style="padding-left:${(depth + 1) * 18 + 28}px">空目录</div>`
    : "";
  const error = node.error
    ? `<div class="py-1 text-xs text-error" style="padding-left:${depth * 18 + 28}px">${escapeHtml(node.error)}</div>`
    : "";

  return `
    <div>
      <button
        type="button"
        class="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-base-200 ${selected ? "bg-primary/10 text-primary" : ""}"
        style="padding-left:${depth * 18 + 8}px"
        data-hall-cpl-external-node="${escapeHtml(entry.path)}"
      >
        <i class="fas ${icon} w-4"></i>
        <span class="min-w-0 flex-1 truncate">${escapeHtml(entry.name)}</span>
        ${status}
      </button>
      ${error}
      ${children}
      ${empty}
    </div>
  `;
}

function renderExternalCplTable() {
  const list = document.getElementById("hallCplExternalCplTable");
  if (!list) return;
  const state = hallCplState.externalFtp;
  const meta = document.getElementById("hallCplExternalPackageMeta");
  if (state.loadingPackage) {
    list.innerHTML = '<div class="py-8 text-center text-base-content/60">正在解析 DCP 包...</div>';
    if (meta) meta.textContent = state.selectedPackagePath ? `/${state.selectedPackagePath}` : "正在解析 DCP 包...";
    return;
  }
  if (state.error && state.selectedPackagePath) {
    list.innerHTML = `<div class="py-8 text-center text-error">${escapeHtml(state.error)}</div>`;
    if (meta) meta.textContent = state.selectedPackagePath ? `/${state.selectedPackagePath}` : "读取失败";
    return;
  }
  const dcpPackage = state.package;
  if (!dcpPackage) {
    list.innerHTML = '<div class="py-8 text-center text-base-content/60">读取 DCP 包后显示版本。</div>';
    if (meta) meta.textContent = "尚未选择 DCP 包。";
    return;
  }

  const cpls = Array.isArray(dcpPackage.cpls) ? dcpPackage.cpls : [];
  if (meta) {
    meta.textContent = `${dcpPackage.name || "DCP 包"} · ${cpls.length} 个版本 · ${formatBytes(dcpPackage.size)}`;
  }
  if (cpls.length === 0) {
    list.innerHTML = '<div class="py-8 text-center text-base-content/60">未识别到可导入版本。</div>';
    return;
  }

  list.innerHTML = cpls.map((cpl, index) => {
    const status = getExternalCplStatus(cpl, dcpPackage);
    const checked = state.selectedCplUuid && normalizeUuid(state.selectedCplUuid) === normalizeUuid(cpl.cplUuid || cpl.uuid);
    const title = getCplTitle(cpl);
    const badges = getCplDisplayParts(cpl).badges;
    const duration = formatDuration(cpl.durationSeconds, cpl.durationFrames);
    return `
      <label class="flex gap-3 p-3 ${index > 0 ? "border-t border-base-300" : ""} ${status.importDisabled ? "opacity-80" : "cursor-pointer hover:bg-base-200"}">
        <input
          type="radio"
          name="hallCplExternalCpl"
          class="radio radio-sm mt-1 shrink-0"
          data-hall-cpl-external-cpl="${escapeHtml(cpl.cplUuid || cpl.uuid || "")}"
          ${checked ? "checked" : ""}
          ${status.importDisabled ? "disabled" : ""}
        >
        <div class="min-w-0 flex-1 space-y-2">
          <div class="flex flex-wrap items-start justify-between gap-2">
            <div class="min-w-0 flex-1">
              <div class="break-words text-sm font-medium leading-relaxed">${escapeHtml(title)}</div>
            </div>
            <span class="badge ${status.className} shrink-0 whitespace-nowrap">${status.label}</span>
          </div>
          <div class="flex flex-wrap items-center gap-1.5">
            ${renderBadges(badges)}
            ${duration ? `<span class="badge badge-ghost badge-sm whitespace-nowrap">${escapeHtml(duration)}</span>` : ""}
          </div>
          ${status.message ? `<div class="text-xs leading-relaxed text-base-content/55">${escapeHtml(status.message)}</div>` : ""}
        </div>
      </label>
    `;
  }).join("");
}

function renderExternalActions() {
  const state = hallCplState.externalFtp;
  const selection = document.getElementById("hallCplExternalSelection");
  const confirm = document.getElementById("hallCplExternalConfirm");
  const selectedCpl = getSelectedExternalCpl();
  if (selection) {
    selection.textContent = selectedCpl ? getCplTitle(selectedCpl) : "未选择版本";
  }
  if (confirm) {
    confirm.disabled = !selectedCpl || state.submitting || state.loadingPackage || hallCplState.hall?.online !== true;
  }
  const reload = document.getElementById("hallCplExternalReload");
  if (reload) {
    reload.disabled = !isExternalFtpSourceSelectable(getSelectedExternalFtpSource()) || state.loadingEntries || state.submitting;
  }
  const remove = document.getElementById("hallCplExternalRemoveSource");
  if (remove) {
    const source = getSelectedExternalFtpSource();
    remove.disabled = source?.kind !== "custom" || state.submitting;
  }
  const add = document.getElementById("hallCplExternalOpenAddSource");
  if (add) {
    add.disabled = state.submitting;
  }
}

function openRepositoryModal() {
  renderRepositoryTable();
  const modal = document.getElementById("hallCplRepositoryModal");
  if (modal instanceof HTMLDialogElement && !modal.open) {
    modal.showModal();
  }
}

function closeRepositoryModal() {
  const modal = document.getElementById("hallCplRepositoryModal");
  if (modal instanceof HTMLDialogElement && modal.open) {
    modal.close();
  }
}

async function openExternalModal() {
  hallCplState.externalFtp.selectedSourceId = "";
  resetExternalTree();
  renderExternalModal();
  const modal = document.getElementById("hallCplExternalModal");
  if (modal instanceof HTMLDialogElement && !modal.open) {
    modal.showModal();
  }
  await loadExternalSources();
}

function closeExternalModal() {
  if (hallCplState.externalFtp.submitting) return;
  closeExternalAddModal();
  const modal = document.getElementById("hallCplExternalModal");
  if (modal instanceof HTMLDialogElement && modal.open) {
    modal.close();
  }
}

function openExternalAddModal() {
  resetExternalAddForm();
  clearExternalAddError();
  const modal = document.getElementById("hallCplExternalAddModal");
  if (modal instanceof HTMLDialogElement && !modal.open) {
    modal.showModal();
  }
}

function closeExternalAddModal() {
  const modal = document.getElementById("hallCplExternalAddModal");
  if (modal instanceof HTMLDialogElement && modal.open) {
    modal.close();
  }
}

function resetExternalAddForm() {
  const values = {
    hallCplExternalName: "",
    hallCplExternalHost: "",
    hallCplExternalPort: "21",
    hallCplExternalRoot: "",
    hallCplExternalUser: "",
    hallCplExternalPassword: "",
  };
  for (const [id, value] of Object.entries(values)) {
    const input = document.getElementById(id);
    if (input instanceof HTMLInputElement) {
      input.value = value;
    }
  }
}

function setExternalAddError(message) {
  const node = document.getElementById("hallCplExternalAddError");
  if (!node) return;
  node.textContent = message;
  node.classList.toggle("hidden", !message);
}

function clearExternalAddError() {
  setExternalAddError("");
}

async function loadExternalSources() {
  hallCplState.externalFtp.loadingSources = true;
  hallCplState.externalFtp.error = "";
  renderExternalModal();
  try {
    const payload = await apiGet(`/api/dcp/external-ftp/sources?hallId=${encodeURIComponent(hallCplState.hallId)}`);
    hallCplState.externalFtp.systemSources = Array.isArray(payload.sources) ? payload.sources : [];
    hallCplState.externalFtp.customSources = [];
    const sources = getExternalFtpSources();
    if (!sources.some((source) => source.id === hallCplState.externalFtp.selectedSourceId && isExternalFtpSourceSelectable(source))) {
      hallCplState.externalFtp.selectedSourceId = "";
      resetExternalTree();
    }
  } catch (error) {
    hallCplState.externalFtp.error = error instanceof Error ? error.message : "加载外部 FTP 来源失败。";
  } finally {
    hallCplState.externalFtp.loadingSources = false;
    renderExternalModal();
  }
}

async function loadExternalRootDirectory(options = {}) {
  if (hallCplState.externalFtp.rootEntries.length > 0 && !options.force) {
    return;
  }
  await loadExternalDirectory("", { root: true });
}

async function handleExternalTreeNode(path) {
  const node = hallCplState.externalFtp.nodes.get(path);
  if (!node || node.loading) {
    return;
  }
  if (node.isDcp) {
    await inspectExternalPackage(path);
    return;
  }
  if (node.loaded) {
    node.expanded = !node.expanded;
    hallCplState.externalFtp.currentPath = path;
    if (node.expanded) {
      clearExternalPackageSelection();
    }
    renderExternalModal();
    return;
  }
  clearExternalPackageSelection();
  await loadExternalDirectory(path, { node });
}

async function loadExternalDirectory(path, options = {}) {
  const source = getSelectedExternalFtpSource();
  if (!isExternalFtpSourceSelectable(source)) {
    resetExternalTree();
    renderExternalModal();
    return;
  }

  const node = options.node || null;
  if (node) {
    node.loading = true;
    node.error = "";
  } else {
    hallCplState.externalFtp.loadingEntries = true;
  }
  hallCplState.externalFtp.error = "";
  renderExternalModal();
  try {
    const payload = await apiPost("/api/dcp/external-ftp/list", {
      sourceId: source.id,
      hallId: hallCplState.hallId,
      path,
    });
    const entries = Array.isArray(payload.entries) ? payload.entries : [];
    const directoryEntries = entries.filter((entry) => entry.type === "directory");
    if (node && isExternalDcpDirectory(entries)) {
      hallCplState.externalFtp.currentPath = path;
      node.loading = false;
      node.loaded = true;
      node.expanded = false;
      node.isDcp = true;
      await inspectExternalPackage(path);
      return;
    }
    if (options.root) {
      hallCplState.externalFtp.rootEntries = directoryEntries;
      hallCplState.externalFtp.currentPath = "";
      for (const entry of directoryEntries) {
        ensureExternalTreeNode(entry);
      }
    } else if (node) {
      hallCplState.externalFtp.currentPath = path;
      node.children = directoryEntries;
      node.loaded = true;
      node.expanded = true;
      for (const entry of directoryEntries) {
        ensureExternalTreeNode(entry);
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "读取外部 FTP 目录失败。";
    if (node) {
      node.error = message;
    } else {
      hallCplState.externalFtp.error = message;
      hallCplState.externalFtp.rootEntries = [];
    }
  } finally {
    if (node) {
      node.loading = false;
    } else {
      hallCplState.externalFtp.loadingEntries = false;
    }
    renderExternalModal();
  }
}

async function inspectExternalPackage(path) {
  const source = getSelectedExternalFtpSource();
  if (!source) {
    return;
  }

  hallCplState.externalFtp.loadingPackage = true;
  hallCplState.externalFtp.error = "";
  hallCplState.externalFtp.package = null;
  hallCplState.externalFtp.currentPath = path;
  hallCplState.externalFtp.selectedPackagePath = path;
  hallCplState.externalFtp.selectedCplUuid = "";
  renderExternalModal();
  try {
    const payload = await apiPost("/api/dcp/external-ftp/package", {
      sourceId: source.id,
      hallId: hallCplState.hallId,
      path,
    });
    hallCplState.externalFtp.package = payload.package || null;
  } catch (error) {
    hallCplState.externalFtp.error = error instanceof Error ? error.message : "读取 DCP 包失败。";
  } finally {
    hallCplState.externalFtp.loadingPackage = false;
    renderExternalModal();
  }
}

async function importExternalCpl(button) {
  const source = getSelectedExternalFtpSource();
  const cplUuid = hallCplState.externalFtp.selectedCplUuid;
  const path = hallCplState.externalFtp.selectedPackagePath;
  if (!isExternalFtpSourceSelectable(source) || !path || !cplUuid) {
    setStatus("warning", "请选择外部 DCP 包和影片版本。", { toast: true });
    return;
  }

  if (button instanceof HTMLButtonElement) {
    button.disabled = true;
  }
  hallCplState.externalFtp.submitting = true;
  renderExternalModal();
  try {
    const payload = await apiPost("/api/dcp/external-ftp/ingest", {
      sourceId: source.id,
      path,
      cplUuid,
      hallId: hallCplState.hallId,
    });
    const tasks = Array.isArray(payload.tasks) ? payload.tasks : [];
    applyTaskPayload(tasks);
    const imported = Array.isArray(payload.imported) ? payload.imported.length : 0;
    const failed = Array.isArray(payload.failed) ? payload.failed : [];
    if (failed.length > 0) {
      setStatus("warning", `外部导入任务创建失败。${failed[0]?.error || ""}`, { toast: true });
    } else {
      setStatus("success", `已创建 ${imported} 个外部 DCP 导入任务。`, { toast: true });
      closeExternalModal();
    }
    renderAll();
    syncTaskPolling();
  } catch (error) {
    setStatus("error", error instanceof Error ? error.message : "创建外部导入任务失败。", { toast: true });
  } finally {
    hallCplState.externalFtp.submitting = false;
    if (button instanceof HTMLButtonElement) {
      button.disabled = false;
    }
    renderExternalModal();
  }
}

function openTaskModal() {
  renderTaskTable();
  renderModalSummaries();
  const modal = document.getElementById("hallCplTaskModal");
  if (modal instanceof HTMLDialogElement && !modal.open) {
    modal.showModal();
  }
}

function closeTaskModal() {
  const modal = document.getElementById("hallCplTaskModal");
  if (modal instanceof HTMLDialogElement && modal.open) {
    modal.close();
  }
}

async function addCustomExternalFtpSource() {
  clearExternalAddError();
  const name = document.getElementById("hallCplExternalName")?.value?.trim() || "";
  const host = document.getElementById("hallCplExternalHost")?.value?.trim() || "";
  const port = Number(document.getElementById("hallCplExternalPort")?.value || 21);
  const rootPath = document.getElementById("hallCplExternalRoot")?.value?.trim() || "";
  const username = document.getElementById("hallCplExternalUser")?.value?.trim() || "";
  const password = document.getElementById("hallCplExternalPassword")?.value || "";
  if (!host) {
    setExternalAddError("请输入 FTP 主机地址。");
    return;
  }
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    setExternalAddError("FTP 端口无效。");
    return;
  }

  try {
    const payload = await apiPost("/api/dcp/external-ftp/sources", {
      source: {
        label: name || host,
        host,
        port,
        rootPath: normalizeRemoteDisplayPath(rootPath),
        username,
        password,
      },
      hallId: hallCplState.hallId,
    });
    hallCplState.externalFtp.systemSources = Array.isArray(payload.sources) ? payload.sources : [];
    hallCplState.externalFtp.customSources = [];
    hallCplState.externalFtp.selectedSourceId = payload.source?.id || "";
    resetExternalTree();
    hallCplState.externalFtp.error = "";
    closeExternalAddModal();
    renderExternalModal();
    void loadExternalRootDirectory({ force: true });
  } catch (error) {
    setExternalAddError(error instanceof Error ? error.message : "添加外部 FTP 来源失败。");
  }
}

async function removeSelectedCustomExternalFtpSource() {
  const selectedId = hallCplState.externalFtp.selectedSourceId;
  const source = getSelectedExternalFtpSource();
  if (!source || source.kind !== "custom") {
    return;
  }
  try {
    const payload = await apiPost("/api/dcp/external-ftp/sources/remove", {
      sourceId: selectedId,
      hallId: hallCplState.hallId,
    });
    hallCplState.externalFtp.systemSources = Array.isArray(payload.sources) ? payload.sources : [];
    hallCplState.externalFtp.customSources = [];
    const fallback = getExternalFtpSources().find((item) => item.id !== selectedId) || null;
    hallCplState.externalFtp.selectedSourceId = fallback?.id || "";
    resetExternalTree();
    hallCplState.externalFtp.error = "";
    renderExternalModal();
    if (fallback) {
      void loadExternalRootDirectory({ force: true });
    }
  } catch (error) {
    hallCplState.externalFtp.error = error instanceof Error ? error.message : "移除外部 FTP 来源失败。";
    renderExternalModal();
  }
}

function getExternalCplStatus(cpl, dcpPackage) {
  const activeTask = findActiveTaskForCpl(cpl);
  if (activeTask) {
    const taskStatus = getTaskStatus(activeTask);
    return { label: taskStatus.label, className: taskStatus.className, importDisabled: true, message: "" };
  }
  if (hallCplState.hall?.online !== true) {
    return { label: "设备离线", className: "badge-warning", importDisabled: true, message: "" };
  }
  if (isDeviceCplPresent(cpl.cplUuid || cpl.uuid)) {
    return { label: "已在影厅内", className: "badge-info", importDisabled: true, message: "" };
  }
  if (dcpPackage?.status === "error") {
    return {
      label: "异常",
      className: "badge-error",
      importDisabled: true,
      message: (dcpPackage.validationMessages || []).join("；") || "影片包校验未通过。",
    };
  }
  if (!cpl.assetMapPath && !dcpPackage?.assetMapPath) {
    return { label: "不可导入", className: "badge-error", importDisabled: true, message: "缺少 ASSETMAP。" };
  }
  if (!cpl.pklUuid) {
    return { label: "不可导入", className: "badge-error", importDisabled: true, message: "未关联 PKL。" };
  }
  if (dcpPackage?.status === "warning") {
    return {
      label: "有警告",
      className: "badge-warning",
      importDisabled: false,
      message: (dcpPackage.validationMessages || []).join("；"),
    };
  }
  return { label: "可导入", className: "badge-success", importDisabled: false, message: "" };
}

function getRepositoryCplStatus(cpl) {
  const activeTask = findActiveTaskForCpl(cpl);
  if (activeTask) {
    const taskStatus = getTaskStatus(activeTask);
    return { label: taskStatus.label, className: taskStatus.className, importDisabled: true, message: "" };
  }
  if (hallCplState.hall?.online !== true) {
    return { label: "设备离线", className: "badge-warning", importDisabled: true, message: "" };
  }
  if (isDeviceCplPresent(cpl.cplUuid || cpl.uuid)) {
    return { label: "已在影厅内", className: "badge-info", importDisabled: true, message: "" };
  }
  if (cpl.packageStatus === "error") {
    return {
      label: "异常",
      className: "badge-error",
      importDisabled: true,
      message: (cpl.packageValidationMessages || []).join("；") || "影片包校验未通过。",
    };
  }
  if (!cpl.assetMapPath || !cpl.pklUuid) {
    return { label: "不可导入", className: "badge-error", importDisabled: true, message: "缺少 ASSETMAP 或 PKL 关联。" };
  }
  if (cpl.packageStatus === "warning") {
    return {
      label: "有警告",
      className: "badge-warning",
      importDisabled: false,
      message: (cpl.packageValidationMessages || []).join("；"),
    };
  }
  return { label: "可导入", className: "badge-success", importDisabled: false, message: "" };
}

function getImportableRepositoryCpls() {
  return hallCplState.repositoryCpls.filter((item) => !getRepositoryCplStatus(item).importDisabled);
}

function getSelectedRepositoryCpls() {
  const importableKeys = new Set(getImportableRepositoryCpls().map(getRepositoryKey));
  return hallCplState.repositoryCpls.filter((item) => {
    const key = getRepositoryKey(item);
    return importableKeys.has(key) && hallCplState.selectedRepositoryKeys.has(key);
  });
}

function pruneSelectedRepositoryKeys() {
  const valid = new Set(hallCplState.repositoryCpls.map(getRepositoryKey));
  for (const key of [...hallCplState.selectedRepositoryKeys]) {
    if (!valid.has(key)) {
      hallCplState.selectedRepositoryKeys.delete(key);
    }
  }
}

function findActiveTaskForCpl(cpl) {
  const cplUuid = normalizeUuid(cpl.cplUuid || cpl.uuid);
  const pklUuid = normalizeUuid(cpl.pklUuid);
  const packageId = String(cpl.packageId || "");
  return hallCplState.tasks.find((task) => {
    if (isTerminalTaskStatus(task.status)) {
      return false;
    }
    const taskCplUuid = normalizeUuid(task.metadata?.cplUuid);
    const taskPklUuid = normalizeUuid(task.metadata?.pklUuid);
    return taskCplUuid === cplUuid
      || (pklUuid && taskPklUuid === pklUuid)
      || String(task.assetId || "") === `${packageId}:${pklUuid}`;
  });
}

function isDeviceCplPresent(cplUuid) {
  const target = normalizeUuid(cplUuid);
  return Boolean(target) && hallCplState.deviceCpls.some((cpl) => normalizeUuid(cpl.cplUuid || cpl.uuid) === target);
}

function getRepositoryKey(cpl) {
  return `${cpl.packageId}||${cpl.cplUuid || cpl.uuid}`;
}

function getExternalFtpSources() {
  return [
    ...hallCplState.externalFtp.systemSources,
    ...hallCplState.externalFtp.customSources,
  ];
}

function resetExternalTree() {
  hallCplState.externalFtp.currentPath = "";
  hallCplState.externalFtp.rootEntries = [];
  hallCplState.externalFtp.nodes = new Map();
  clearExternalPackageSelection();
  hallCplState.externalFtp.loadingEntries = false;
  hallCplState.externalFtp.loadingPackage = false;
}

function clearExternalPackageSelection() {
  hallCplState.externalFtp.package = null;
  hallCplState.externalFtp.selectedPackagePath = "";
  hallCplState.externalFtp.selectedCplUuid = "";
}

function createExternalTreeNode(entry) {
  return {
    entry,
    children: [],
    loaded: false,
    expanded: false,
    loading: false,
    isDcp: false,
    error: "",
  };
}

function ensureExternalTreeNode(entry) {
  const existing = hallCplState.externalFtp.nodes.get(entry.path);
  if (existing) {
    existing.entry = entry;
    return existing;
  }
  const node = createExternalTreeNode(entry);
  hallCplState.externalFtp.nodes.set(entry.path, node);
  return node;
}

function isExternalDcpDirectory(entries) {
  return entries.some((entry) => entry.type === "file" && String(entry.name || "").toLowerCase() === "assetmap");
}

function getSelectedExternalFtpSource() {
  const selectedId = hallCplState.externalFtp.selectedSourceId;
  return getExternalFtpSources().find((source) => source.id === selectedId) || null;
}

function isExternalFtpSourceSelectable(source) {
  return Boolean(source && source.selectable !== false);
}

function formatExternalFtpLabel(source) {
  const label = source.label || source.id || "外部 FTP";
  return source.disabledReason ? `${label}（${source.disabledReason}）` : label;
}

function getSelectedExternalCpl() {
  const dcpPackage = hallCplState.externalFtp.package;
  const cplUuid = normalizeUuid(hallCplState.externalFtp.selectedCplUuid);
  if (!dcpPackage || !cplUuid || !Array.isArray(dcpPackage.cpls)) {
    return null;
  }
  return dcpPackage.cpls.find((cpl) => normalizeUuid(cpl.cplUuid || cpl.uuid) === cplUuid) || null;
}

function normalizeRemoteDisplayPath(value) {
  return String(value || "")
    .replaceAll("\\", "/")
    .replace(/^\/+/, "")
    .split("/")
    .filter((segment) => segment && segment !== "." && segment !== "..")
    .join("/");
}

function clearLegacyExternalFtpStorage() {
  try {
    window.localStorage.removeItem(legacyExternalFtpStorageKey);
  } catch {
    // Ignore browsers that disallow localStorage access.
  }
}

function syncTaskPolling() {
  const hasActiveTasks = hallCplState.tasks.some((task) => !isTerminalTaskStatus(task.status));
  if (hasActiveTasks && !hallCplState.taskRefreshTimer) {
    hallCplState.taskRefreshTimer = window.setInterval(() => {
      void refreshHallCplTasks();
    }, 5000);
  }
  if (!hasActiveTasks && hallCplState.taskRefreshTimer) {
    window.clearInterval(hallCplState.taskRefreshTimer);
    hallCplState.taskRefreshTimer = null;
  }
}

async function refreshHallCplTasks() {
  if (hallCplState.taskRefreshing) {
    return;
  }
  hallCplState.taskRefreshing = true;
  const hadActiveTasks = hallCplState.tasks.some((task) => !isTerminalTaskStatus(task.status));

  try {
    const payload = await apiGet("/api/dcp/ingest-tasks");
    if (Array.isArray(payload.tasks)) {
      applyTaskPayload(payload.tasks);
    }
    renderTaskRefreshViews();
    syncTaskPolling();

    const hasActiveTasks = hallCplState.tasks.some((task) => !isTerminalTaskStatus(task.status));
    if (hadActiveTasks && !hasActiveTasks) {
      await refreshHallCplData();
    }
  } catch {
    syncTaskPolling();
  } finally {
    hallCplState.taskRefreshing = false;
  }
}

function renderTaskRefreshViews() {
  renderStats();
  renderTaskTable();
  renderModalSummaries();
}

function getTaskStatus(task) {
  const status = String(task.status || "").toLowerCase();
  if (status === "complete") return { label: "已完成", className: "badge-success" };
  if (status === "failed") return { label: "失败", className: "badge-error" };
  if (status === "cancelled" || status === "canceled") return { label: "已取消", className: "badge-neutral" };
  if (status === "removed") return { label: "已移除", className: "badge-neutral" };
  if (status === "paused") return { label: "已暂停", className: "badge-warning" };
  if (status === "unreachable") return { label: "设备离线", className: "badge-warning" };
  if (status === "running") return { label: "摄取中", className: "badge-warning" };
  if (status === "queued" || status === "accepted") return { label: "排队中", className: "badge-info" };
  return { label: "等待确认", className: "badge-ghost" };
}

async function cancelCplTask(taskId, button) {
  if (!taskId) return;
  const task = hallCplState.tasks.find((item) => item.id === taskId);
  if (!task || !isCancellableTaskStatus(task.status)) return;

  if (button instanceof HTMLButtonElement) {
    button.disabled = true;
  }
  try {
    const payload = await apiPost(`/api/dcp/ingest-tasks/${encodeURIComponent(taskId)}/cancel`, {});
    if (Array.isArray(payload.tasks)) {
      applyTaskPayload(payload.tasks);
    }
    setStatus("success", "已取消 CPL 导入任务。", { toast: true });
    renderAll();
    syncTaskPolling();
  } catch (error) {
    setStatus("error", errorMessage(error, "取消 CPL 导入任务失败。"), { toast: true });
  } finally {
    if (button instanceof HTMLButtonElement) {
      button.disabled = false;
    }
  }
}

function isTerminalTaskStatus(status) {
  return ["complete", "failed", "cancelled", "canceled", "removed"].includes(String(status || "").toLowerCase());
}

function isCancellableTaskStatus(status) {
  return !isTerminalTaskStatus(status);
}

function formatTaskProgress(task) {
  const transferred = Number(task.transferredSize);
  const total = Number(task.totalSize);
  if (Number.isFinite(transferred) && Number.isFinite(total) && total > 0) {
    const percent = Math.min(100, Math.round((transferred / total) * 100));
    return `
      <div class="flex min-w-36 flex-col gap-1">
        <progress class="progress progress-primary w-full" value="${percent}" max="100"></progress>
        <span class="text-xs text-base-content/60">${percent}% · ${formatBytes(transferred)} / ${formatBytes(total)}</span>
      </div>
    `;
  }
  return '<span class="text-sm text-base-content/60">等待 GDC 更新</span>';
}

function formatTaskError(task) {
  const errors = Array.isArray(task.errorList) ? task.errorList : [];
  const text = errors.map((item) => item.description || item.code || item.assetUri).filter(Boolean).join("；");
  return text ? `<div class="text-xs text-error mt-1">${escapeHtml(text)}</div>` : "";
}

function getCplTitle(cpl) {
  return cpl.contentTitleText || cpl.annotationText || cpl.fileName || "未命名 CPL";
}

function getCplDisplayParts(cpl) {
  const rawTitle = getCplTitle(cpl);
  const parts = rawTitle.split("_").map((part) => part.trim()).filter(Boolean);
  const movieName = parts[0] || rawTitle;
  const version = parts.length > 1
    ? parts.slice(1).join(" · ")
    : cpl.annotationText && cpl.annotationText !== rawTitle
      ? cpl.annotationText
      : cpl.packageName || "-";
  const badges = [
    formatContentKind(cpl.contentKind),
    ...getCplSpecBadges(cpl),
    formatBytes(cpl.requiredSize),
  ].filter((value) => value && value !== "-");
  return { movieName, version, badges };
}

function getCplSpecBadges(cpl) {
  return uniqueDisplayValues([
    formatEditRate(cpl.editRate),
    cpl.resolutionLabel || cpl.resolution,
    cpl.aspectRatioLabel || cpl.screenAspectRatio || cpl.aspectRatio,
    ...(Array.isArray(cpl.formatTags) ? cpl.formatTags : []),
  ]);
}

function renderBadges(values) {
  return values.length > 0
    ? values.map((item) => `<span class="badge badge-ghost badge-sm">${escapeHtml(item)}</span>`).join("")
    : '<span class="text-sm text-base-content/55">-</span>';
}

function uniqueDisplayValues(values) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const text = formatDisplayValue(value);
    const key = text.toLowerCase();
    if (!text || text === "-" || seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(text);
  }
  return result;
}

function formatDisplayValue(value) {
  if (Array.isArray(value)) {
    return value.map(formatDisplayValue).filter(Boolean).join("/");
  }
  return String(value ?? "").trim();
}

function formatEditRate(value) {
  if (Array.isArray(value)) {
    const numerator = Number(value[0]);
    const denominator = Number(value[1] || 1);
    if (Number.isFinite(numerator) && Number.isFinite(denominator) && denominator > 0) {
      const rate = numerator / denominator;
      return `${Number.isInteger(rate) ? rate : rate.toFixed(2)} fps`;
    }
  }
  const text = formatDisplayValue(value);
  const rationalMatch = text.match(/^(\d+(?:\.\d+)?)[,\s/]+(\d+(?:\.\d+)?)$/);
  if (rationalMatch) {
    const numerator = Number(rationalMatch[1]);
    const denominator = Number(rationalMatch[2]);
    if (Number.isFinite(numerator) && Number.isFinite(denominator) && denominator > 0) {
      const rate = numerator / denominator;
      return `${Number.isInteger(rate) ? rate : rate.toFixed(2)} fps`;
    }
  }
  return text && !/fps$/i.test(text) ? `${text} fps` : text;
}

function formatContentKind(value) {
  const text = String(value || "").trim();
  return text || "CPL";
}

function getTaskTitle(task) {
  return task.assetTitle
    || task.metadata?.cplTitle
    || task.metadata?.packageName
    || "CPL 导入任务";
}

function getTaskSubtitle(task, title) {
  const packageName = task.metadata?.packageName;
  return packageName && packageName !== title ? packageName : "";
}

function formatDuration(seconds, frames) {
  const numeric = Number(seconds);
  if (Number.isFinite(numeric) && numeric > 0) {
    const total = Math.round(numeric);
    const minutes = Math.floor(total / 60);
    const rest = total % 60;
    return `${minutes}:${String(rest).padStart(2, "0")}`;
  }
  return Number.isFinite(Number(frames)) ? `${frames} 帧` : "-";
}

function formatDateTime(value) {
  const date = new Date(value || "");
  if (Number.isNaN(date.getTime())) return "-";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function formatBytes(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return "-";
  if (numeric < 1024) return `${numeric} B`;
  if (numeric < 1024 * 1024) return `${(numeric / 1024).toFixed(1)} KB`;
  if (numeric < 1024 * 1024 * 1024) return `${(numeric / 1024 / 1024).toFixed(1)} MB`;
  return `${(numeric / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

function normalizeUuid(value) {
  return String(value || "").trim().toLowerCase().replace(/^urn:uuid:/, "");
}

function setStatus(type, message, options = {}) {
  const node = document.getElementById("hallCplStatus");
  if (!node) return;
  renderStatusAlert(node, { type, message });
  if (options.toast) {
    const toastType = toast[type] ? type : "info";
    toast[toastType](message);
  }
}

function setText(field, value) {
  const node = document.querySelector(`[data-hall-cpl-field="${field}"]`);
  if (node) node.textContent = value;
}

function setNodeText(id, value) {
  const node = document.getElementById(id);
  if (node) node.textContent = String(value);
}

function errorMessage(error, fallback) {
  return error instanceof Error ? error.message : fallback;
}

function compareText(left, right) {
  return String(left || "").localeCompare(String(right || ""), "zh-CN", { numeric: true, sensitivity: "base" });
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
