import { apiDelete, apiGet, apiPost } from "../api.js";
import { getHallOfflineMessage, getHallStatusErrorMessage, renderStatusAlert } from "../hall-status-alert.js";
import { toast } from "../toast.js";

const KDM_UPLOAD_MAX_BYTES = 1024 * 1024;
const KDM_UPLOAD_ZIP_MAX_BYTES = 5 * 1024 * 1024;
const KDM_UPLOAD_ALLOWED_EXTENSIONS = new Set([".xml", ".zip"]);

const hallKdmState = {
  hallId: "",
  hall: null,
  deviceKdms: [],
  repositoryAssets: [],
  tasks: [],
  selectedRepositoryIds: new Set(),
  uploadFiles: [],
  loading: false,
  uploading: false,
  taskRefreshing: false,
  taskRefreshTimer: null,
};

export async function initHallKdmPage() {
  hallKdmState.hallId = decodeURIComponent(window.location.hash.split("/")[2] || "");
  hallKdmState.selectedRepositoryIds.clear();
  hallKdmState.uploadFiles = [];
  bindHallKdmEvents();
  await refreshHallKdmData();
}

export function disposeHallKdmPage() {
  if (hallKdmState.taskRefreshTimer) {
    window.clearInterval(hallKdmState.taskRefreshTimer);
    hallKdmState.taskRefreshTimer = null;
  }
}

function bindHallKdmEvents() {
  const root = document.querySelector(".hall-kdm-shell");
  if (!root || root.dataset.bound === "true") {
    return;
  }
  root.dataset.bound = "true";

  document.getElementById("hallKdmRefresh")?.addEventListener("click", () => {
    void refreshHallKdmData();
  });
  document.getElementById("hallKdmRepositoryImport")?.addEventListener("click", () => {
    openRepositoryModal();
  });
  document.getElementById("hallKdmRepositoryClose")?.addEventListener("click", closeRepositoryModal);
  document.getElementById("hallKdmRepositoryCancel")?.addEventListener("click", closeRepositoryModal);
  document.getElementById("hallKdmTaskTrigger")?.addEventListener("click", () => {
    openTaskModal();
  });
  document.getElementById("hallKdmTaskClose")?.addEventListener("click", closeTaskModal);
  document.getElementById("hallKdmTaskCancel")?.addEventListener("click", closeTaskModal);
  document.getElementById("hallKdmBatchImport")?.addEventListener("click", () => {
    void importSelectedRepositoryKdms();
  });
  document.getElementById("hallKdmUploadTrigger")?.addEventListener("click", () => {
    document.getElementById("hallKdmUploadInput")?.click();
  });
  document.getElementById("hallKdmUploadAdd")?.addEventListener("click", () => {
    document.getElementById("hallKdmUploadInput")?.click();
  });
  document.getElementById("hallKdmUploadInput")?.addEventListener("change", (event) => {
    addUploadFiles(event.target.files);
    event.target.value = "";
  });
  document.getElementById("hallKdmUploadClear")?.addEventListener("click", () => {
    if (hallKdmState.uploading) return;
    hallKdmState.uploadFiles = [];
    renderUploadModal();
  });
  document.getElementById("hallKdmUploadCancel")?.addEventListener("click", closeUploadModal);
  document.getElementById("hallKdmUploadClose")?.addEventListener("click", closeUploadModal);
  document.getElementById("hallKdmUploadConfirm")?.addEventListener("click", () => {
    void uploadAndImportKdms();
  });

  document.getElementById("hallKdmSelectAll")?.addEventListener("change", (event) => {
    const checked = event.target.checked;
    for (const asset of getImportableAssets()) {
      if (checked) {
        hallKdmState.selectedRepositoryIds.add(asset.id);
      } else {
        hallKdmState.selectedRepositoryIds.delete(asset.id);
      }
    }
    renderRepositoryTable();
  });

  root.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const removeUpload = target?.closest("[data-hall-kdm-upload-remove]");
    if (removeUpload && !hallKdmState.uploading) {
      hallKdmState.uploadFiles = hallKdmState.uploadFiles.filter((item) => item.id !== removeUpload.dataset.hallKdmUploadRemove);
      renderUploadModal();
      return;
    }

    const importButton = target?.closest("[data-hall-kdm-import]");
    if (importButton) {
      void importRepositoryKdms([importButton.dataset.hallKdmImport], importButton);
      return;
    }

    const deleteButton = target?.closest("[data-hall-kdm-delete-device]");
    if (deleteButton) {
      void deleteDeviceKdm(deleteButton.dataset.hallKdmDeleteDevice);
      return;
    }

    const cancelTaskButton = target?.closest("[data-hall-kdm-task-cancel]");
    if (cancelTaskButton) {
      void cancelKdmTask(cancelTaskButton.dataset.hallKdmTaskCancel || "", cancelTaskButton);
    }
  });

  root.addEventListener("change", (event) => {
    const checkbox = event.target instanceof Element ? event.target.closest("[data-hall-kdm-select]") : null;
    if (!checkbox) {
      return;
    }
    if (checkbox.checked) {
      hallKdmState.selectedRepositoryIds.add(checkbox.dataset.hallKdmSelect);
    } else {
      hallKdmState.selectedRepositoryIds.delete(checkbox.dataset.hallKdmSelect);
    }
    renderRepositoryActions();
  });
}

async function refreshHallKdmData() {
  if (!hallKdmState.hallId) {
    setStatus("error", "请先从左侧选择一个影厅。");
    return;
  }

  hallKdmState.loading = true;
  renderAll();
  setStatus("info", "正在加载影厅 KDM 信息...");

  try {
    const payload = await apiGet(`/api/kdm/halls/${encodeURIComponent(hallKdmState.hallId)}`);
    applyHallKdmPayload(payload);
    if (!hallKdmState.hall?.online) {
      setStatus("warning", getHallOfflineMessage("kdm"));
    } else if (payload.deviceReadError) {
      setStatus("warning", payload.deviceReadError);
    } else {
      setStatus("success", `已加载 ${hallKdmState.deviceKdms.length} 个设备内 KDM。`);
    }
  } catch (error) {
    setStatus("error", getHallStatusErrorMessage(error, "加载影厅 KDM 失败。"));
  } finally {
    hallKdmState.loading = false;
    renderAll();
    syncTaskPolling();
  }
}

function applyHallKdmPayload(payload) {
  hallKdmState.hall = payload.hall || null;
  hallKdmState.deviceKdms = Array.isArray(payload.deviceKdms) ? payload.deviceKdms : [];
  hallKdmState.repositoryAssets = Array.isArray(payload.repositoryAssets) ? payload.repositoryAssets : [];
  applyTaskPayload(Array.isArray(payload.tasks) ? payload.tasks : []);
  pruneSelectedRepositoryIds();
}

function applyTaskPayload(tasks) {
  hallKdmState.tasks = tasks.filter((task) => task.type === "KDM" && task.hallId === hallKdmState.hallId);
}

async function importSelectedRepositoryKdms() {
  await importRepositoryKdms([...hallKdmState.selectedRepositoryIds]);
}

async function importRepositoryKdms(ids, button = null) {
  const cleanIds = [...new Set(ids.filter(Boolean))];
  if (cleanIds.length === 0) {
    setStatus("warning", "请先选择可导入的 KDM。", { toast: true });
    return;
  }

  if (button) {
    button.disabled = true;
  }
  setStatus("info", `正在为 ${cleanIds.length} 个 KDM 创建导入任务...`);

  try {
    const payload = await apiPost(`/api/kdm/halls/${encodeURIComponent(hallKdmState.hallId)}/import`, { ids: cleanIds });
    applyHallKdmPayload(payload);
    hallKdmState.selectedRepositoryIds.clear();
    const imported = Array.isArray(payload.imported) ? payload.imported.length : 0;
    const failed = Array.isArray(payload.failed) ? payload.failed : [];
    if (failed.length > 0) {
      setStatus("warning", `已创建 ${imported} 个导入任务，${failed.length} 个失败。`, { toast: true });
    } else {
      setStatus("success", `已创建 ${imported} 个导入任务。`, { toast: true });
    }
  } catch (error) {
    setStatus("error", error instanceof Error ? error.message : "导入 KDM 失败。", { toast: true });
  } finally {
    if (button) {
      button.disabled = false;
    }
    renderAll();
    syncTaskPolling();
  }
}

async function deleteDeviceKdm(assetUuid) {
  const kdm = hallKdmState.deviceKdms.find((item) => item.assetUuid === assetUuid);
  const title = kdm?.contentTitleText || kdm?.annotationText || "所选 KDM";
  if (!assetUuid || !confirm(`确定要从当前影厅设备删除以下 KDM 吗？\n\n${title}`)) {
    return;
  }

  setStatus("info", "正在从影厅设备删除 KDM...");
  try {
    const payload = await apiDelete(`/api/kdm/halls/${encodeURIComponent(hallKdmState.hallId)}/device/${encodeURIComponent(assetUuid)}`);
    applyHallKdmPayload(payload);
    removeDeviceKdmFromState(assetUuid);
    setStatus("success", "已从影厅设备删除 KDM。", { toast: true });
  } catch (error) {
    setStatus("error", error instanceof Error ? error.message : "删除设备内 KDM 失败。", { toast: true });
  } finally {
    renderAll();
  }
}

function removeDeviceKdmFromState(assetUuid) {
  const normalized = normalizeKdmUuid(assetUuid);
  if (!normalized) {
    return;
  }

  hallKdmState.deviceKdms = hallKdmState.deviceKdms.filter((item) =>
    normalizeKdmUuid(item.assetUuid) !== normalized,
  );
  hallKdmState.repositoryAssets = hallKdmState.repositoryAssets.map((asset) => {
    if (normalizeKdmUuid(asset.messageId || asset.id) !== normalized || !asset.targetHall) {
      return asset;
    }
    return {
      ...asset,
      targetHall: {
        ...asset.targetHall,
        existingKdmStatus: "absent",
      },
    };
  });
}

function addUploadFiles(fileList) {
  const files = [...(fileList || [])].filter((file) => file instanceof File);
  if (files.length === 0) {
    return;
  }

  const existingKeys = new Set(hallKdmState.uploadFiles.map((item) => getUploadFileKey(item.file)));
  const rejected = [];
  for (const file of files) {
    const error = validateUploadFile(file);
    if (error) {
      rejected.push(`${file.name}（${error}）`);
      continue;
    }

    const key = getUploadFileKey(file);
    if (existingKeys.has(key)) {
      continue;
    }
    existingKeys.add(key);
    hallKdmState.uploadFiles.push({
      id: `hall-kdm-upload-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      file,
      status: "pending",
      error: "",
    });
  }

  if (rejected.length > 0) {
    setStatus("warning", `部分文件无法上传：${rejected.join("；")}`, { toast: true });
  }
  openUploadModal();
}

async function uploadAndImportKdms() {
  if (hallKdmState.uploading) {
    return;
  }
  if (hallKdmState.uploadFiles.length === 0) {
    setStatus("warning", "请先添加 KDM 文件。", { toast: true });
    return;
  }

  hallKdmState.uploading = true;
  for (const item of hallKdmState.uploadFiles) {
    item.status = "uploading";
    item.error = "";
  }
  renderUploadModal();
  setStatus("info", "正在上传 KDM 并导入当前影厅...");

  try {
    const files = [];
    for (const item of hallKdmState.uploadFiles) {
      const extension = getFileExtension(item.file.name);
      files.push({
        name: item.file.name,
        content: extension === ".zip" ? await readFileAsBase64(item.file) : await item.file.text(),
        encoding: extension === ".zip" ? "base64" : "text",
      });
    }

    const payload = await apiPost(`/api/kdm/halls/${encodeURIComponent(hallKdmState.hallId)}/upload-import`, { files });
    applyHallKdmPayload(payload);

    const rejected = Array.isArray(payload.rejected) ? payload.rejected : [];
    const failed = Array.isArray(payload.failed) ? payload.failed : [];
    const imported = Array.isArray(payload.imported) ? payload.imported.length : 0;
    if (rejected.length > 0 || failed.length > 0) {
      setStatus("warning", `本地上传完成，已创建 ${imported} 个导入任务，${rejected.length + failed.length} 项未导入。`, { toast: true });
    } else {
      setStatus("success", `本地上传完成，已创建 ${imported} 个导入任务。`, { toast: true });
    }

    hallKdmState.uploadFiles = [];
    closeUploadModal();
  } catch (error) {
    setStatus("error", error instanceof Error ? error.message : "本地上传导入失败。", { toast: true });
    for (const item of hallKdmState.uploadFiles) {
      item.status = "error";
      item.error = error instanceof Error ? error.message : "上传失败";
    }
  } finally {
    hallKdmState.uploading = false;
    renderAll();
    renderUploadModal();
    syncTaskPolling();
  }
}

function renderAll() {
  renderHallSummary();
  renderStats();
  renderDeviceTable();
  renderRepositoryTable();
  renderTaskTable();
  renderModalSummaries();
}

function renderHallSummary() {
  const hallName = hallKdmState.hall?.hallName || hallKdmState.hallId || "当前影厅";
  setText("hall-name", hallName);
  const badge = document.getElementById("hallKdmOnlineBadge");
  if (badge) {
    const online = hallKdmState.hall?.online === true;
    badge.className = `badge ${online ? "badge-success" : "badge-warning"}`;
    badge.textContent = online ? "设备在线" : "设备离线";
  }
}

function renderStats() {
  document.getElementById("hallKdmDeviceCount").textContent = String(hallKdmState.deviceKdms.length);
  document.getElementById("hallKdmImportableCount").textContent = String(getImportableAssets().length);
  document.getElementById("hallKdmTaskCount").textContent = String(hallKdmState.tasks.length);
}

function renderDeviceTable() {
  const table = document.getElementById("hallKdmDeviceTable");
  if (!table) return;
  if (hallKdmState.loading) {
    table.innerHTML = '<tr><td colspan="4" class="text-center text-base-content/60">正在加载设备内 KDM...</td></tr>';
    return;
  }
  if (!hallKdmState.hall?.online) {
    table.innerHTML = `<tr><td colspan="4" class="text-center text-base-content/60">${escapeHtml(getHallOfflineMessage("kdm"))}</td></tr>`;
    return;
  }
  if (hallKdmState.deviceKdms.length === 0) {
    table.innerHTML = '<tr><td colspan="4" class="text-center text-base-content/60">设备内暂无 KDM。</td></tr>';
    return;
  }

  table.innerHTML = hallKdmState.deviceKdms.map((kdm) => {
    const title = kdm.contentTitleText || kdm.annotationText || "未命名 KDM";
    const status = getValidityStatus(kdm.validBefore, kdm.validAfter, kdm.error);
    const validity = formatValidity(kdm.validBefore, kdm.validAfter);
    return `
      <tr>
        <td class="hall-kdm-mobile-card-cell" colspan="4">
          <details class="collapse collapse-arrow bg-base-100 border border-base-300">
            <summary class="collapse-title hall-kdm-mobile-card-title">
              <div class="min-w-0">
                <div class="hall-kdm-mobile-card-name">${escapeHtml(title)}</div>
                <div class="hall-kdm-mobile-card-meta">${validity}</div>
              </div>
              <span class="badge badge-sm ${status.className}">${status.label}</span>
            </summary>
            <div class="collapse-content hall-kdm-mobile-card-content">
              <dl>
                <div>
                  <dt>有效期</dt>
                  <dd>${validity}</dd>
                </div>
                ${kdm.error ? `
                  <div>
                    <dt>状态说明</dt>
                    <dd>${escapeHtml(kdm.error)}</dd>
                  </div>
                ` : ""}
              </dl>
              <div class="hall-kdm-mobile-card-actions">
                <button class="btn btn-sm btn-error btn-outline" data-hall-kdm-delete-device="${escapeHtml(kdm.assetUuid)}" ${kdm.error ? "disabled" : ""}>
                  <i class="fas fa-trash-can"></i>
                  删除
                </button>
              </div>
            </div>
          </details>
        </td>
        <td data-label="影片">
          <div class="font-medium">${escapeHtml(title)}</div>
        </td>
        <td data-label="有效期">${validity}</td>
        <td data-label="状态"><span class="badge ${status.className}">${status.label}</span></td>
        <td data-label="操作">
          <button class="btn btn-sm btn-error btn-outline" data-hall-kdm-delete-device="${escapeHtml(kdm.assetUuid)}" ${kdm.error ? "disabled" : ""}>
            <i class="fas fa-trash-can"></i>
            删除
          </button>
        </td>
      </tr>
    `;
  }).join("");
}

function renderRepositoryTable() {
  const table = document.getElementById("hallKdmRepositoryTable");
  if (!table) return;
  if (hallKdmState.loading) {
    table.innerHTML = '<tr><td colspan="5" class="text-center text-base-content/60">正在加载存储库 KDM...</td></tr>';
    return;
  }
  if (hallKdmState.repositoryAssets.length === 0) {
    table.innerHTML = '<tr><td colspan="5" class="text-center text-base-content/60">存储库中没有匹配当前影厅设备的 KDM。</td></tr>';
    renderRepositoryActions();
    return;
  }

  table.innerHTML = hallKdmState.repositoryAssets.map((asset) => {
    const status = getRepositoryAssetStatus(asset);
    const checked = hallKdmState.selectedRepositoryIds.has(asset.id);
    const title = asset.contentTitleText || asset.annotationText || "未命名 KDM";
    const validity = formatValidity(asset.validBefore, asset.validAfter);
    return `
      <tr>
        <td class="hall-kdm-repository-mobile-card-cell" colspan="5">
          <details class="collapse collapse-arrow bg-base-100 border border-base-300">
            <summary class="collapse-title hall-kdm-mobile-card-title">
              <div class="hall-kdm-mobile-card-title-main">
                <input
                  type="checkbox"
                  class="checkbox checkbox-sm"
                  data-hall-kdm-select="${escapeHtml(asset.id)}"
                  ${checked ? "checked" : ""}
                  ${status.importDisabled ? "disabled" : ""}
                  onclick="event.stopPropagation()"
                >
                <div class="min-w-0">
                  <div class="hall-kdm-mobile-card-name">${escapeHtml(title)}</div>
                  <div class="hall-kdm-mobile-card-meta">${validity}</div>
                </div>
              </div>
              <span class="badge badge-sm ${status.className}">${status.label}</span>
            </summary>
            <div class="collapse-content hall-kdm-mobile-card-content">
              <dl>
                <div>
                  <dt>有效期</dt>
                  <dd>${validity}</dd>
                </div>
              </dl>
              <div class="hall-kdm-mobile-card-actions">
                <button class="btn btn-sm btn-primary" data-hall-kdm-import="${escapeHtml(asset.id)}" ${status.importDisabled ? "disabled" : ""}>
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
            data-hall-kdm-select="${escapeHtml(asset.id)}"
            ${checked ? "checked" : ""}
            ${status.importDisabled ? "disabled" : ""}
          >
        </td>
        <td data-label="影片">
          <div class="font-medium">${escapeHtml(title)}</div>
        </td>
        <td data-label="有效期">${validity}</td>
        <td data-label="状态"><span class="badge ${status.className}">${status.label}</span></td>
        <td data-label="操作">
          <button class="btn btn-sm btn-primary" data-hall-kdm-import="${escapeHtml(asset.id)}" ${status.importDisabled ? "disabled" : ""}>
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
  const table = document.getElementById("hallKdmTaskTable");
  if (!table) return;
  if (hallKdmState.tasks.length === 0) {
    table.innerHTML = '<tr><td colspan="5" class="text-center text-base-content/60">暂无 KDM 导入任务。</td></tr>';
    return;
  }

  table.innerHTML = hallKdmState.tasks.map((task) => {
    const status = getTaskStatus(task);
    const canCancel = isCancellableTaskStatus(task.status);
    const title = task.assetTitle || task.assetId || "-";
    const progress = formatTaskProgress(task);
    return `
      <tr>
        <td class="hall-kdm-task-mobile-card-cell" colspan="5">
          <details class="collapse collapse-arrow bg-base-100 border border-base-300">
            <summary class="collapse-title hall-kdm-mobile-card-title">
              <div class="min-w-0">
                <div class="hall-kdm-mobile-card-name">${escapeHtml(title)}</div>
                <div class="hall-kdm-mobile-card-meta">${formatDateTime(task.updatedAt)}</div>
              </div>
              <span class="badge badge-sm ${status.className}">${status.label}</span>
            </summary>
            <div class="collapse-content hall-kdm-mobile-card-content">
              <dl>
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
                  <dd>${formatDateTime(task.updatedAt)}</dd>
                </div>
              </dl>
              ${formatTaskError(task)}
              <div class="hall-kdm-mobile-card-actions">
                ${canCancel
                  ? `<button type="button" class="btn btn-sm btn-ghost gap-1" data-hall-kdm-task-cancel="${escapeHtml(task.id || "")}">
                      <i class="fas fa-ban"></i>
                      取消
                    </button>`
                  : '<span class="text-sm text-base-content/45">-</span>'}
              </div>
            </div>
          </details>
        </td>
        <td data-label="影片">
          <div class="font-medium">${escapeHtml(title)}</div>
          ${formatTaskError(task)}
        </td>
        <td data-label="状态">
          <span class="badge ${status.className}">${status.label}</span>
          ${task.description ? `<div class="mt-1 text-xs text-base-content/60">${escapeHtml(task.description)}</div>` : ""}
        </td>
        <td data-label="进度">${progress}</td>
        <td data-label="更新时间">${formatDateTime(task.updatedAt)}</td>
        <td data-label="操作">
          ${canCancel
            ? `<button type="button" class="btn btn-sm btn-ghost gap-1" data-hall-kdm-task-cancel="${escapeHtml(task.id || "")}">
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
  const repositorySummary = document.getElementById("hallKdmRepositorySummary");
  const repositorySelection = document.getElementById("hallKdmRepositorySelection");
  const taskSummary = document.getElementById("hallKdmTaskSummary");
  const importableCount = getImportableAssets().length;
  const selectedCount = getSelectedImportableIds().length;

  if (repositorySummary) {
    repositorySummary.textContent = hallKdmState.repositoryAssets.length === 0
      ? "存储库中暂无匹配当前影厅的 KDM"
      : `${hallKdmState.repositoryAssets.length} 个匹配当前影厅，${importableCount} 个可导入`;
  }
  if (repositorySelection) {
    repositorySelection.textContent = `已选 ${selectedCount} 项`;
  }
  if (taskSummary) {
    taskSummary.textContent = hallKdmState.tasks.length === 0
      ? "当前影厅暂无 KDM 导入任务"
      : `当前影厅共有 ${hallKdmState.tasks.length} 条 KDM 导入任务`;
  }
}

function renderRepositoryActions() {
  const selected = getSelectedImportableIds();
  const openButton = document.getElementById("hallKdmRepositoryImport");
  if (openButton) {
    openButton.disabled = hallKdmState.loading;
  }

  const taskButton = document.getElementById("hallKdmTaskTrigger");
  if (taskButton) {
    taskButton.disabled = hallKdmState.loading;
  }

  const batchButton = document.getElementById("hallKdmBatchImport");
  if (batchButton) {
    batchButton.disabled = selected.length === 0 || hallKdmState.loading || hallKdmState.hall?.online !== true;
  }

  const selectAll = document.getElementById("hallKdmSelectAll");
  if (selectAll) {
    const importable = getImportableAssets();
    selectAll.disabled = importable.length === 0;
    selectAll.checked = importable.length > 0 && importable.every((asset) => hallKdmState.selectedRepositoryIds.has(asset.id));
    selectAll.indeterminate = selected.length > 0 && !selectAll.checked;
  }
  renderModalSummaries();
}

function openRepositoryModal() {
  renderRepositoryTable();
  const modal = document.getElementById("hallKdmRepositoryModal");
  if (modal instanceof HTMLDialogElement && !modal.open) {
    modal.showModal();
  }
}

function closeRepositoryModal() {
  const modal = document.getElementById("hallKdmRepositoryModal");
  if (modal instanceof HTMLDialogElement && modal.open) {
    modal.close();
  }
}

function openTaskModal() {
  renderTaskTable();
  renderModalSummaries();
  const modal = document.getElementById("hallKdmTaskModal");
  if (modal instanceof HTMLDialogElement && !modal.open) {
    modal.showModal();
  }
}

function closeTaskModal() {
  const modal = document.getElementById("hallKdmTaskModal");
  if (modal instanceof HTMLDialogElement && modal.open) {
    modal.close();
  }
}

function openUploadModal() {
  renderUploadModal();
  const modal = document.getElementById("hallKdmUploadModal");
  if (modal instanceof HTMLDialogElement && !modal.open) {
    modal.showModal();
  }
}

function closeUploadModal() {
  if (hallKdmState.uploading) return;
  const modal = document.getElementById("hallKdmUploadModal");
  if (modal instanceof HTMLDialogElement && modal.open) {
    modal.close();
  }
}

function renderUploadModal() {
  const list = document.getElementById("hallKdmUploadList");
  const summary = document.getElementById("hallKdmUploadSummary");
  const confirm = document.getElementById("hallKdmUploadConfirm");
  const clear = document.getElementById("hallKdmUploadClear");
  const add = document.getElementById("hallKdmUploadAdd");
  const files = hallKdmState.uploadFiles;

  if (summary) {
    summary.textContent = files.length === 0 ? "暂无待上传文件" : `已选择 ${files.length} 个上传项`;
  }
  if (list) {
    list.innerHTML = files.length === 0
      ? '<div class="kdm-upload-queue-empty">请选择 XML KDM 文件或 ZIP 密钥包。</div>'
      : files.map((item) => `
        <div class="kdm-upload-queue-item">
          <div class="kdm-upload-queue-file">
            <div class="kdm-upload-queue-icon">
              <i class="fas ${item.status === "error" ? "fa-triangle-exclamation" : item.status === "uploading" ? "fa-spinner fa-spin" : "fa-file-code"}"></i>
            </div>
            <div>
              <div class="font-medium">${escapeHtml(item.file.name)}</div>
              <div class="text-xs text-base-content/60">${formatBytes(item.file.size)}${item.error ? ` · ${escapeHtml(item.error)}` : ""}</div>
            </div>
          </div>
          <button class="btn btn-sm btn-ghost btn-circle" data-hall-kdm-upload-remove="${escapeHtml(item.id)}" ${hallKdmState.uploading ? "disabled" : ""} aria-label="移除">
            <i class="fas fa-xmark"></i>
          </button>
        </div>
      `).join("");
  }
  if (confirm) {
    confirm.disabled = hallKdmState.uploading || files.length === 0 || hallKdmState.hall?.online !== true;
    confirm.innerHTML = hallKdmState.uploading
      ? '<span class="loading loading-spinner loading-xs"></span> 正在导入'
      : '<i class="fas fa-cloud-arrow-up"></i> 上传并导入';
  }
  if (clear) clear.disabled = hallKdmState.uploading || files.length === 0;
  if (add) add.disabled = hallKdmState.uploading;
}

function getRepositoryAssetStatus(asset) {
  const activeTask = findActiveTaskForAsset(asset);
  if (activeTask) {
    const taskStatus = getTaskStatus(activeTask);
    return { label: taskStatus.label, className: taskStatus.className, importDisabled: true };
  }
  if (hallKdmState.hall?.online !== true) {
    return { label: "设备离线", className: "badge-warning", importDisabled: true };
  }
  if (asset.targetHall?.existingKdmStatus === "present") {
    return { label: "已在设备内", className: "badge-info", importDisabled: true };
  }
  if (asset.targetHall?.existingKdmStatus === "unknown") {
    return { label: "无法确认", className: "badge-warning", importDisabled: true };
  }
  if (isExpired(asset.validAfter)) {
    return { label: "已过期", className: "badge-error", importDisabled: true };
  }
  return { label: "可导入", className: "badge-success", importDisabled: false };
}

function getImportableAssets() {
  return hallKdmState.repositoryAssets.filter((asset) => !getRepositoryAssetStatus(asset).importDisabled);
}

function getSelectedImportableIds() {
  const importableIds = new Set(getImportableAssets().map((asset) => asset.id));
  return [...hallKdmState.selectedRepositoryIds].filter((id) => importableIds.has(id));
}

function pruneSelectedRepositoryIds() {
  const validIds = new Set(hallKdmState.repositoryAssets.map((asset) => asset.id));
  for (const id of [...hallKdmState.selectedRepositoryIds]) {
    if (!validIds.has(id)) {
      hallKdmState.selectedRepositoryIds.delete(id);
    }
  }
}

function findActiveTaskForAsset(asset) {
  const assetId = String(asset.messageId || asset.id || "").toLowerCase();
  return hallKdmState.tasks.find((task) =>
    String(task.assetId || "").toLowerCase() === assetId
    && !isTerminalTaskStatus(task.status),
  );
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

function getValidityStatus(validBefore, validAfter, error) {
  if (error) return { label: "读取失败", className: "badge-error" };
  if (isExpired(validAfter)) return { label: "已过期", className: "badge-error" };
  const startsAt = Date.parse(validBefore || "");
  if (Number.isFinite(startsAt) && startsAt > Date.now()) return { label: "尚未生效", className: "badge-warning" };
  return { label: "有效", className: "badge-success" };
}

function syncTaskPolling() {
  const hasActiveTasks = hallKdmState.tasks.some((task) => !isTerminalTaskStatus(task.status));
  if (hasActiveTasks && !hallKdmState.taskRefreshTimer) {
    hallKdmState.taskRefreshTimer = window.setInterval(() => {
      void refreshHallKdmTasks();
    }, 5000);
  }
  if (!hasActiveTasks && hallKdmState.taskRefreshTimer) {
    window.clearInterval(hallKdmState.taskRefreshTimer);
    hallKdmState.taskRefreshTimer = null;
  }
}

async function refreshHallKdmTasks() {
  if (hallKdmState.taskRefreshing) {
    return;
  }
  hallKdmState.taskRefreshing = true;
  const hadActiveTasks = hallKdmState.tasks.some((task) => !isTerminalTaskStatus(task.status));

  try {
    const payload = await apiGet("/api/kdm/ingest-tasks");
    if (Array.isArray(payload.tasks)) {
      applyTaskPayload(payload.tasks);
    }
    renderTaskRefreshViews();
    syncTaskPolling();

    const hasActiveTasks = hallKdmState.tasks.some((task) => !isTerminalTaskStatus(task.status));
    if (hadActiveTasks && !hasActiveTasks) {
      await refreshHallKdmData();
    }
  } catch {
    syncTaskPolling();
  } finally {
    hallKdmState.taskRefreshing = false;
  }
}

function renderTaskRefreshViews() {
  renderStats();
  renderTaskTable();
  renderModalSummaries();
}

async function cancelKdmTask(taskId, button) {
  if (!taskId) return;
  const task = hallKdmState.tasks.find((item) => item.id === taskId);
  if (!task || !isCancellableTaskStatus(task.status)) return;

  if (button instanceof HTMLButtonElement) {
    button.disabled = true;
  }
  try {
    const payload = await apiPost(`/api/kdm/ingest-tasks/${encodeURIComponent(taskId)}/cancel`, {});
    if (Array.isArray(payload.tasks)) {
      applyTaskPayload(payload.tasks);
    }
    setStatus("success", "已取消 KDM 导入任务。", { toast: true });
    renderAll();
    syncTaskPolling();
  } catch (error) {
    setStatus("error", error instanceof Error ? error.message : "取消 KDM 导入任务失败。", { toast: true });
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

function validateUploadFile(file) {
  const extension = getFileExtension(file.name);
  if (!KDM_UPLOAD_ALLOWED_EXTENSIONS.has(extension)) return "只允许上传 XML 文件或 ZIP 密钥包";
  if (file.size <= 0) return "文件为空";
  if (extension === ".zip" && file.size >= KDM_UPLOAD_ZIP_MAX_BYTES) return "ZIP 密钥包大小必须小于 5MB";
  if (extension === ".xml" && file.size >= KDM_UPLOAD_MAX_BYTES) return "XML 文件大小必须小于 1MB";
  return "";
}

function getUploadFileKey(file) {
  return `${file.name}::${file.size}::${file.lastModified}`;
}

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || "");
      resolve(result.includes(",") ? result.split(",").pop() || "" : result);
    };
    reader.onerror = () => reject(reader.error || new Error("读取文件失败。"));
    reader.readAsDataURL(file);
  });
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

function formatValidity(before, after) {
  return `
    <div class="text-sm">${formatDateTime(before)}</div>
    <div class="text-xs text-base-content/60">至 ${formatDateTime(after)}</div>
  `;
}

function formatDateTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function formatBytes(value) {
  const size = Number(value);
  if (!Number.isFinite(size) || size <= 0) return "-";
  const units = ["B", "KB", "MB", "GB"];
  let next = size;
  let index = 0;
  while (next >= 1024 && index < units.length - 1) {
    next /= 1024;
    index += 1;
  }
  return `${next.toFixed(next >= 10 || index === 0 ? 0 : 1)} ${units[index]}`;
}

function isExpired(value) {
  const time = Date.parse(value || "");
  return Number.isFinite(time) && time < Date.now();
}

function normalizeKdmUuid(value) {
  return String(value || "").trim().toLowerCase().replace(/^urn:uuid:/, "");
}

function getFileExtension(fileName) {
  const index = String(fileName || "").lastIndexOf(".");
  return index >= 0 ? fileName.slice(index).toLowerCase() : "";
}

function setStatus(type, message, options = {}) {
  const node = document.getElementById("hallKdmStatus");
  if (!node) return;
  renderStatusAlert(node, { type, message });
  if (options.toast) {
    const fn = toast[type] || toast.info;
    fn.call(toast, message);
  }
}

function setText(field, value) {
  const node = document.querySelector(`[data-hall-kdm-field="${field}"]`);
  if (node) node.textContent = value;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
