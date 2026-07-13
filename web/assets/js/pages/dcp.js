import { apiGet, apiPost } from "../api.js";
import { toast } from "../toast.js";

const dcpState = {
  packages: [],
  cpls: [],
  halls: [],
  tasks: [],
  repositoryCapacity: null,
  uploadQueue: [],
  uploading: false,
  loading: false,
  activeTab: "assets",
  filters: {
    query: "",
    status: "all",
  },
  taskRefreshTimer: null,
  detailModal: {
    open: false,
    item: null,
  },
  importModal: {
    open: false,
    loading: false,
    submitting: false,
    items: [],
    selectedKeys: new Set(),
    check: null,
    checkRequestId: 0,
    selectedHallIds: new Set(),
    error: "",
  },
};

export async function initDcpPage() {
  bindDcpEvents();
  await refreshDcpAssets();
}

export function disposeDcpPage() {
  if (dcpState.taskRefreshTimer) {
    window.clearInterval(dcpState.taskRefreshTimer);
    dcpState.taskRefreshTimer = null;
  }
}

function bindDcpEvents() {
  const uploadTrigger = document.getElementById("dcpUploadTrigger");
  const uploadInput = document.getElementById("dcpUploadInput");
  const uploadAdd = document.getElementById("dcpUploadAdd");
  const uploadClear = document.getElementById("dcpUploadClear");
  const uploadCancel = document.getElementById("dcpUploadCancel");
  const uploadClose = document.getElementById("dcpUploadClose");
  const uploadBackdrop = document.getElementById("dcpUploadBackdrop");
  const uploadConfirm = document.getElementById("dcpUploadConfirm");
  const refreshButton = document.getElementById("dcpRefreshButton");
  const cplTableBody = document.getElementById("dcpCplTableBody");
  const taskTableBody = document.getElementById("dcpTaskTableBody");
  const query = document.getElementById("dcpFilterQuery");
  const status = document.getElementById("dcpFilterStatus");
  const batchImport = document.getElementById("dcpBatchImport");
  const importVersionList = document.getElementById("dcpImportVersionList");
  const importHallList = document.getElementById("dcpImportHallList");
  const importClose = document.getElementById("dcpImportClose");
  const importCancel = document.getElementById("dcpImportCancel");
  const importBackdrop = document.getElementById("dcpImportBackdrop");
  const importRefresh = document.getElementById("dcpImportRefresh");
  const importConfirm = document.getElementById("dcpImportConfirm");
  const detailClose = document.getElementById("dcpDetailClose");
  const detailDone = document.getElementById("dcpDetailDone");
  const detailBackdrop = document.getElementById("dcpDetailBackdrop");
  const tabButtons = document.querySelectorAll("[data-dcp-tab]");
  const shell = document.querySelector(".dcp-shell");

  for (const button of [uploadTrigger, uploadAdd]) {
    if (button && button.dataset.bound !== "true") {
      button.dataset.bound = "true";
      button.addEventListener("click", () => uploadInput?.click());
    }
  }

  if (uploadInput && uploadInput.dataset.bound !== "true") {
    uploadInput.dataset.bound = "true";
    uploadInput.addEventListener("change", () => {
      if (uploadInput.files?.length) {
        addFilesToUploadQueue(uploadInput.files);
        openUploadModal();
      }
      uploadInput.value = "";
    });
  }

  if (uploadClear && uploadClear.dataset.bound !== "true") {
    uploadClear.dataset.bound = "true";
    uploadClear.addEventListener("click", () => {
      if (dcpState.uploading) return;
      dcpState.uploadQueue = [];
      renderUploadQueue();
    });
  }

  for (const closeButton of [uploadCancel, uploadClose, uploadBackdrop]) {
    if (!closeButton || closeButton.dataset.bound === "true") continue;
    closeButton.dataset.bound = "true";
    closeButton.addEventListener("click", (event) => {
      event.preventDefault();
      closeUploadModal();
    });
  }

  if (uploadConfirm && uploadConfirm.dataset.bound !== "true") {
    uploadConfirm.dataset.bound = "true";
    uploadConfirm.addEventListener("click", () => {
      void uploadQueuedDcps();
    });
  }

  if (refreshButton && refreshButton.dataset.bound !== "true") {
    refreshButton.dataset.bound = "true";
    refreshButton.addEventListener("click", () => {
      void refreshDcpAssets();
    });
  }

  if (cplTableBody && cplTableBody.dataset.bound !== "true") {
    cplTableBody.dataset.bound = "true";
    cplTableBody.addEventListener("click", (event) => {
      const target = event.target instanceof Element ? event.target : null;
      const importButton = target?.closest("[data-dcp-import]");
      if (importButton instanceof HTMLButtonElement) {
        const dcpPackage = getPackageById(importButton.dataset.dcpImport || "");
        const items = getPackageImportItems(dcpPackage);
        void openImportModal(items, []);
        return;
      }
      const detailButton = target?.closest("[data-dcp-detail]");
      if (detailButton instanceof HTMLButtonElement) {
        openDetailModal(detailButton.dataset.dcpDetail || "");
      }
    });
  }

  if (taskTableBody && taskTableBody.dataset.bound !== "true") {
    taskTableBody.dataset.bound = "true";
    taskTableBody.addEventListener("click", (event) => {
      const target = event.target instanceof Element ? event.target : null;
      const cancelButton = target?.closest("[data-dcp-task-cancel]");
      if (cancelButton instanceof HTMLButtonElement) {
        void cancelDcpTask(cancelButton.dataset.dcpTaskCancel || "", cancelButton);
      }
    });
  }

  if (query && query.dataset.bound !== "true") {
    query.dataset.bound = "true";
    query.addEventListener("input", () => {
      dcpState.filters.query = query.value.trim();
      renderDcpTables();
    });
  }

  if (status && status.dataset.bound !== "true") {
    status.dataset.bound = "true";
    status.addEventListener("change", () => {
      dcpState.filters.status = status.value;
      renderDcpTables();
    });
  }

  if (batchImport && batchImport.dataset.bound !== "true") {
    batchImport.dataset.bound = "true";
    batchImport.addEventListener("click", () => {
      const items = getVisiblePackages().flatMap(getPackageImportItems);
      void openImportModal(items, []);
    });
  }

  if (importVersionList && importVersionList.dataset.bound !== "true") {
    importVersionList.dataset.bound = "true";
    importVersionList.addEventListener("change", (event) => {
      const target = event.target instanceof Element ? event.target : null;
      const checkbox = target?.closest("[data-dcp-import-version]");
      if (!(checkbox instanceof HTMLInputElement)) return;
      if (checkbox.checked) {
        dcpState.importModal.selectedKeys.add(checkbox.dataset.dcpImportVersion || "");
      } else {
        dcpState.importModal.selectedKeys.delete(checkbox.dataset.dcpImportVersion || "");
      }
      void loadImportCheck();
    });
  }

  if (importHallList && importHallList.dataset.bound !== "true") {
    importHallList.dataset.bound = "true";
    importHallList.addEventListener("change", (event) => {
      const target = event.target instanceof Element ? event.target : null;
      const checkbox = target?.closest("[data-dcp-import-hall]");
      if (!(checkbox instanceof HTMLInputElement)) return;
      if (checkbox.checked) {
        dcpState.importModal.selectedHallIds.add(checkbox.dataset.dcpImportHall || "");
      } else {
        dcpState.importModal.selectedHallIds.delete(checkbox.dataset.dcpImportHall || "");
      }
      renderImportModal();
    });
  }

  for (const closeButton of [importClose, importCancel, importBackdrop]) {
    if (!closeButton || closeButton.dataset.bound === "true") continue;
    closeButton.dataset.bound = "true";
    closeButton.addEventListener("click", (event) => {
      event.preventDefault();
      closeImportModal();
    });
  }

  if (importRefresh && importRefresh.dataset.bound !== "true") {
    importRefresh.dataset.bound = "true";
    importRefresh.addEventListener("click", () => {
      void loadImportCheck();
    });
  }

  if (importConfirm && importConfirm.dataset.bound !== "true") {
    importConfirm.dataset.bound = "true";
    importConfirm.addEventListener("click", () => {
      void confirmImportSelection(importConfirm);
    });
  }

  for (const closeButton of [detailClose, detailDone, detailBackdrop]) {
    if (!closeButton || closeButton.dataset.bound === "true") continue;
    closeButton.dataset.bound = "true";
    closeButton.addEventListener("click", (event) => {
      event.preventDefault();
      closeDetailModal();
    });
  }

  for (const tabButton of tabButtons) {
    if (tabButton.dataset.bound === "true") continue;
    tabButton.dataset.bound = "true";
    tabButton.addEventListener("click", () => {
      dcpState.activeTab = tabButton.dataset.dcpTab || "assets";
      renderDcpTabs();
    });
  }

  if (shell && shell.dataset.dragBound !== "true") {
    shell.dataset.dragBound = "true";
    shell.addEventListener("dragover", (event) => {
      if (!event.dataTransfer?.types.includes("Files")) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
      shell.classList.add("is-dragging");
    });
    shell.addEventListener("dragleave", () => shell.classList.remove("is-dragging"));
    shell.addEventListener("drop", async (event) => {
      if (!event.dataTransfer?.items?.length) return;
      event.preventDefault();
      shell.classList.remove("is-dragging");
      const files = await collectDroppedFiles(event.dataTransfer.items);
      addFilesToUploadQueue(files);
      openUploadModal();
    });
  }
}

async function refreshDcpAssets() {
  dcpState.loading = true;
  renderDcpTables();
  setStatus("info", "正在加载影片包与影片版本...");
  try {
    const payload = await apiGet("/api/dcp/assets");
    applyDcpPayload(payload);
    setStatus("success", `已加载 ${dcpState.packages.length} 个影片包、${dcpState.cpls.length} 个影片版本。`);
  } catch (error) {
    setStatus("error", error instanceof Error ? error.message : "加载影片包与影片版本失败。", { toast: true });
  } finally {
    dcpState.loading = false;
    renderDcpAll();
    syncTaskPolling();
  }
}

function applyDcpPayload(payload) {
  dcpState.packages = Array.isArray(payload.packages) ? payload.packages : dcpState.packages;
  dcpState.cpls = Array.isArray(payload.cpls) ? payload.cpls : dcpState.cpls;
  dcpState.halls = Array.isArray(payload.halls) ? payload.halls : dcpState.halls;
  dcpState.tasks = Array.isArray(payload.tasks) ? payload.tasks : dcpState.tasks;
  dcpState.repositoryCapacity = payload.repositoryCapacity || dcpState.repositoryCapacity;
  pruneImportSelection();
  syncDetailSelection();
}

function addFilesToUploadQueue(fileList) {
  const files = [...fileList].filter((file) => file instanceof File);
  const grouped = groupDcpFiles(files);
  const rejected = [];
  const incoming = [];
  const existingNames = new Set(dcpState.uploadQueue.map((item) => item.packageName));

  for (const group of grouped) {
    const error = validateDcpUploadGroup(group);
    if (error) {
      rejected.push(`${group.packageName}（${error}）`);
      continue;
    }
    if (existingNames.has(group.packageName)) {
      continue;
    }
    existingNames.add(group.packageName);
    incoming.push({
      id: `dcp-upload-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      ...group,
      status: "pending",
      progress: 0,
      error: "",
    });
  }

  if (incoming.length > 0) {
    dcpState.uploadQueue = [...dcpState.uploadQueue, ...incoming];
  }
  const message = incoming.length > 0
    ? `已加入 ${incoming.length} 个影片包。`
    : "没有可加入上传队列的影片包。";
  setStatus(rejected.length > 0 ? "warning" : "info", rejected.length > 0 ? `${message}${rejected.join("；")}` : message, {
    toast: true,
  });
  renderUploadQueue();
}

async function uploadQueuedDcps() {
  if (dcpState.uploading) return;
  const items = dcpState.uploadQueue.filter((item) => item.status !== "success");
  if (items.length === 0) {
    setStatus("warning", "上传队列为空。", { toast: true });
    return;
  }

  dcpState.uploading = true;
  let successCount = 0;
  let failedCount = 0;
  try {
    for (const item of items) {
      item.status = "uploading";
      item.progress = 0;
      item.error = "";
      renderUploadQueue();
      let uploadId = "";
      try {
        const startPayload = await apiPost("/api/dcp/upload/start", { packageName: item.packageName });
        uploadId = startPayload.upload?.uploadId || "";
        if (!uploadId) throw new Error("上传会话创建失败。");
        for (let index = 0; index < item.files.length; index += 1) {
          const fileItem = item.files[index];
          await uploadDcpFile(uploadId, fileItem.relativePath, fileItem.file);
          item.progress = Math.round(((index + 1) / item.files.length) * 100);
          renderUploadQueue();
        }
        const finishPayload = await apiPost("/api/dcp/upload/finish", { uploadId });
        applyDcpPayload(finishPayload);
        item.status = "success";
        successCount += 1;
      } catch (error) {
        item.status = "error";
        item.error = error instanceof Error ? error.message : "影片包上传失败。";
        failedCount += 1;
        if (uploadId) {
          await apiPost("/api/dcp/upload/cancel", { uploadId }).catch(() => undefined);
        }
      }
      renderDcpAll();
      renderUploadQueue();
    }
  } finally {
    dcpState.uploading = false;
    dcpState.uploadQueue = failedCount > 0
      ? dcpState.uploadQueue.filter((item) => item.status === "error")
      : [];
    renderDcpAll();
    renderUploadQueue();
    syncTaskPolling();
  }

  if (failedCount > 0) {
    setStatus("warning", `上传完成：成功 ${successCount} 个，失败 ${failedCount} 个。失败项已保留。`, { toast: true });
    openUploadModal();
    return;
  }
  closeUploadModal();
  setStatus("success", `已成功上传 ${successCount} 个影片包。`, { toast: true });
}

async function uploadDcpFile(uploadId, relativePath, file) {
  const query = new URLSearchParams({ uploadId, relativePath });
  const response = await fetch(`/api/dcp/upload-file?${query.toString()}`, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: file,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok === false) {
    throw new Error(payload.error || `上传文件失败：${file.name}`);
  }
}

async function openImportModal(items, preselectedItems = items) {
  const normalizedItems = items.filter((item) => item?.packageId && item?.cplUuid);
  if (normalizedItems.length === 0) {
    setStatus("warning", "当前列表没有可导入的影片版本。", { toast: true });
    return;
  }
  const validKeys = new Set(normalizedItems.map(getImportItemKey));
  const selectedKeys = new Set(
    preselectedItems
      .map((item) => getImportItemKey(item))
      .filter((key) => validKeys.has(key))
  );

  dcpState.importModal = {
    open: true,
    loading: selectedKeys.size > 0,
    submitting: false,
    items: normalizedItems,
    selectedKeys,
    check: null,
    checkRequestId: 0,
    selectedHallIds: new Set(),
    error: "",
  };
  renderImportModal();
  const modal = document.getElementById("dcpImportModal");
  if (modal instanceof HTMLDialogElement && !modal.open) {
    modal.showModal();
  }
  if (selectedKeys.size > 0) {
    await loadImportCheck();
  }
}

async function loadImportCheck() {
  const selectedItems = getSelectedImportItems();
  if (dcpState.importModal.items.length === 0) return;
  if (selectedItems.length === 0) {
    dcpState.importModal.loading = false;
    dcpState.importModal.error = "";
    dcpState.importModal.check = null;
    dcpState.importModal.checkRequestId += 1;
    dcpState.importModal.selectedHallIds.clear();
    renderImportModal();
    return;
  }
  dcpState.importModal.loading = true;
  dcpState.importModal.error = "";
  dcpState.importModal.selectedHallIds.clear();
  const requestId = dcpState.importModal.checkRequestId + 1;
  dcpState.importModal.checkRequestId = requestId;
  renderImportModal();
  try {
    const payload = await apiPost("/api/dcp/ingest-check", {
      items: selectedItems.map(toImportPayloadItem),
    });
    if (dcpState.importModal.checkRequestId !== requestId) return;
    dcpState.importModal.check = payload.check || null;
  } catch (error) {
    if (dcpState.importModal.checkRequestId !== requestId) return;
    dcpState.importModal.error = error instanceof Error ? error.message : "检测影厅状态失败。";
  } finally {
    if (dcpState.importModal.checkRequestId === requestId) {
      dcpState.importModal.loading = false;
      renderImportModal();
    }
  }
}

function closeImportModal() {
  if (dcpState.importModal.submitting) return;
  dcpState.importModal.open = false;
  dcpState.importModal.items = [];
  dcpState.importModal.selectedKeys.clear();
  dcpState.importModal.check = null;
  dcpState.importModal.checkRequestId += 1;
  dcpState.importModal.selectedHallIds.clear();
  dcpState.importModal.error = "";
  const modal = document.getElementById("dcpImportModal");
  if (modal instanceof HTMLDialogElement && modal.open) {
    modal.close();
  }
}

async function confirmImportSelection(button) {
  const items = getSelectedImportItems();
  if (items.length === 0) {
    setStatus("warning", "请选择要导入的影片版本。", { toast: true });
    return;
  }
  const hallIds = [...dcpState.importModal.selectedHallIds].filter(Boolean);
  if (hallIds.length === 0) {
    setStatus("warning", "请选择可导入的影厅。", { toast: true });
    return;
  }
  await importCpls(items.map(toImportPayloadItem), hallIds, button);
}

async function importCpls(items, hallIds, button) {
  if (button instanceof HTMLButtonElement) {
    button.disabled = true;
  }
  dcpState.importModal.submitting = true;
  renderImportModal();
  try {
    const payload = await apiPost("/api/dcp/ingest", {
      items,
      hallIds,
    });
    applyDcpPayload(payload);
    const failed = Array.isArray(payload.failed) ? payload.failed : [];
    const imported = Array.isArray(payload.imported) ? payload.imported : [];
    if (failed.length > 0) {
      setStatus("warning", `已创建 ${imported.length} 个任务，失败 ${failed.length} 个。${failed[0]?.error || ""}`, { toast: true });
    } else {
      setStatus("success", `已创建 ${imported.length} 个影片版本导入任务。`, { toast: true });
    }
    dcpState.activeTab = "tasks";
    dcpState.importModal.submitting = false;
    renderDcpAll();
    syncTaskPolling();
    closeImportModal();
  } catch (error) {
    setStatus("error", error instanceof Error ? error.message : "创建影片版本导入任务失败。", { toast: true });
    await loadImportCheck().catch(() => undefined);
  } finally {
    if (dcpState.importModal.submitting) {
      dcpState.importModal.submitting = false;
    }
    if (button instanceof HTMLButtonElement) {
      button.disabled = false;
    }
    renderImportModal();
  }
}

function renderDcpAll() {
  renderDcpStats();
  renderDcpTabs();
  renderDcpTables();
  renderImportModal();
  renderDetailModal();
}

function renderDcpStats() {
  const packageBytes = dcpState.packages.reduce((total, item) => total + Number(item.size || 0), 0);
  setText("dcpStatPackages", dcpState.packages.length);
  setText("dcpStatCpls", dcpState.cpls.length);
  setText("dcpStatSize", formatCapacityPair(dcpState.repositoryCapacity));
  setText("dcpStatSizeDesc", formatDcpCapacityDesc(dcpState.repositoryCapacity, packageBytes));
  setText("dcpAssetTabCount", dcpState.packages.length);
  setText("dcpTaskTabCount", dcpState.tasks.length);
}

function renderDcpTabs() {
  const active = ["assets", "tasks"].includes(dcpState.activeTab) ? dcpState.activeTab : "assets";
  dcpState.activeTab = active;
  for (const name of ["assets", "tasks"]) {
    const panel = document.getElementById(`dcp${capitalize(name === "assets" ? "asset" : name.slice(0, -1))}Panel`);
    if (panel) panel.classList.toggle("hidden", active !== name);
  }
  document.getElementById("dcpAssetTab")?.classList.toggle("tab-active", active === "assets");
  document.getElementById("dcpTaskTab")?.classList.toggle("tab-active", active === "tasks");
}

function renderDcpTables() {
  renderPackageTable();
  renderTaskTable();
}

function renderPackageTable() {
  const body = document.getElementById("dcpCplTableBody");
  const batchImport = document.getElementById("dcpBatchImport");
  const rows = getVisiblePackages();
  const importableRows = rows.filter((dcpPackage) => getPackageImportItems(dcpPackage).length > 0);

  if (!body) return;
  if (dcpState.loading) {
    body.innerHTML = '<tr><td colspan="6" class="text-center text-base-content/60">正在加载影片包...</td></tr>';
  } else if (rows.length === 0) {
    body.innerHTML = '<tr><td colspan="6" class="text-center text-base-content/60">暂无影片包。请先上传影片包目录。</td></tr>';
  } else {
    body.innerHTML = rows.map((dcpPackage) => {
      const status = getPackageStatus(dcpPackage);
      const importable = getPackageImportItems(dcpPackage).length > 0;
      const title = getPackageMovieTitle(dcpPackage);
      const versionSummary = formatPackageVersionSummary(dcpPackage);
      const infoSummary = `${Number(dcpPackage.cplCount || 0)} 个版本 · ${Number(dcpPackage.mxfCount || 0)} MXF · ${formatBytes(dcpPackage.size)}`;
      return `
        <tr>
          <td class="dcp-mobile-card-cell" colspan="6">
            <details class="collapse collapse-arrow bg-base-100 border border-base-300">
              <summary class="collapse-title dcp-mobile-card-title">
                <div class="min-w-0">
                  <div class="dcp-mobile-card-name">${escapeHtml(title)}</div>
                  <div class="dcp-mobile-card-meta">${escapeHtml(infoSummary)}</div>
                </div>
                <span class="badge badge-sm ${status.className}">${status.label}</span>
              </summary>
              <div class="collapse-content dcp-mobile-card-content">
                <dl>
                  <div>
                    <dt>影片包</dt>
                    <dd>${escapeHtml(dcpPackage.name || "-")}</dd>
                  </div>
                  <div>
                    <dt>版本</dt>
                    <dd>${escapeHtml(versionSummary)}</dd>
                  </div>
                  <div>
                    <dt>路径</dt>
                    <dd>${escapeHtml(dcpPackage.relativePath || "-")}</dd>
                  </div>
                  ${status.message ? `
                    <div>
                      <dt>状态说明</dt>
                      <dd>${escapeHtml(status.message)}</dd>
                    </div>
                  ` : ""}
                </dl>
                <div class="dcp-mobile-card-actions">
                  <button type="button" class="btn btn-sm btn-ghost gap-1" data-dcp-detail="${escapeHtml(dcpPackage.id)}">
                    <i class="fas fa-circle-info"></i>
                    详情
                  </button>
                  <button type="button" class="btn btn-sm btn-primary gap-1" data-dcp-import="${escapeHtml(dcpPackage.id)}" ${importable ? "" : "disabled"}>
                    <i class="fas fa-download"></i>
                    导入
                  </button>
                </div>
              </div>
            </details>
          </td>
          <td data-label="影片包">
            <div class="font-medium">${escapeHtml(title)}</div>
            <div class="text-xs text-base-content/55">${escapeHtml(dcpPackage.name || "")}</div>
          </td>
          <td data-label="版本">
            <div class="max-w-80 whitespace-normal text-sm">${escapeHtml(versionSummary)}</div>
          </td>
          <td data-label="信息">
            <div class="flex flex-wrap gap-1">
              <span class="badge badge-ghost badge-sm">${Number(dcpPackage.cplCount || 0)} 个版本</span>
              <span class="badge badge-ghost badge-sm">${Number(dcpPackage.mxfCount || 0)} MXF</span>
              <span class="badge badge-ghost badge-sm">${Number(dcpPackage.xmlCount || 0)} XML</span>
            </div>
            <div class="mt-1 text-xs text-base-content/55">${escapeHtml(dcpPackage.relativePath || "")}</div>
          </td>
          <td data-label="大小">${formatBytes(dcpPackage.size)}</td>
          <td data-label="状态">
            <span class="badge ${status.className}">${status.label}</span>
            ${status.message ? `<div class="mt-1 max-w-52 text-xs text-base-content/55">${escapeHtml(status.message)}</div>` : ""}
          </td>
          <td data-label="操作">
            <div class="flex flex-wrap gap-2">
              <button type="button" class="btn btn-sm btn-ghost gap-1" data-dcp-detail="${escapeHtml(dcpPackage.id)}">
                <i class="fas fa-circle-info"></i>
                详情
              </button>
              <button type="button" class="btn btn-sm btn-primary gap-1" data-dcp-import="${escapeHtml(dcpPackage.id)}" ${importable ? "" : "disabled"}>
                <i class="fas fa-download"></i>
                导入
              </button>
            </div>
          </td>
        </tr>
      `;
    }).join("");
  }

  if (batchImport instanceof HTMLButtonElement) {
    batchImport.disabled = importableRows.length === 0;
  }
  const summary = document.getElementById("dcpFilterSummary");
  if (summary) {
    const summaryText = rows.length === dcpState.packages.length
      ? `显示全部 ${dcpState.packages.length} 个影片包，包含 ${dcpState.cpls.length} 个影片版本`
      : `已筛选出 ${rows.length} / ${dcpState.packages.length} 个影片包`;
    summary.textContent = summaryText;
    setText("dcpMobileFilterSummary", summaryText);
  }
}

function renderImportModal() {
  const modalState = dcpState.importModal;
  const summary = document.getElementById("dcpImportSummary");
  const versionList = document.getElementById("dcpImportVersionList");
  const list = document.getElementById("dcpImportHallList");
  const refresh = document.getElementById("dcpImportRefresh");
  const confirm = document.getElementById("dcpImportConfirm");
  const selectedItems = getSelectedImportItems();
  const selectableHalls = (modalState.check?.halls || []).filter((hall) => hall.selectable);
  const selectedCount = [...modalState.selectedHallIds].filter((hallId) =>
    selectableHalls.some((hall) => hall.hallId === hallId)
  ).length;

  if (summary) {
    if (selectedItems.length === 0) {
      summary.textContent = "请选择要导入的影片版本。";
    } else if (modalState.loading) {
      summary.textContent = "正在检测影厅是否在线、是否已有该版本、剩余空间是否足够...";
    } else if (modalState.error) {
      summary.textContent = modalState.error;
    } else if (modalState.check) {
      summary.textContent = `已选择 ${selectedItems.length} 个版本 · 需要 ${formatBytes(modalState.check.requiredSize)} · ${selectableHalls.length} 个影厅可导入`;
    } else {
      summary.textContent = "请选择要导入的影片版本。";
    }
  }

  if (refresh instanceof HTMLButtonElement) {
    refresh.disabled = modalState.loading || modalState.submitting || selectedItems.length === 0;
  }
  if (confirm instanceof HTMLButtonElement) {
    confirm.disabled = modalState.loading || modalState.submitting || selectedItems.length === 0 || selectedCount === 0;
    confirm.innerHTML = modalState.submitting
      ? '<span class="loading loading-spinner loading-xs"></span> 创建中'
      : '<i class="fas fa-download"></i> 确认导入';
  }

  if (versionList) {
    if (modalState.items.length === 0) {
      versionList.innerHTML = '<div class="kdm-upload-queue-empty">暂无可导入版本。</div>';
    } else {
      versionList.innerHTML = modalState.items.map((item) => {
        const key = getImportItemKey(item);
        const checked = modalState.selectedKeys.has(key);
        const display = getCplDisplayParts(item);
        return `
          <label class="kdm-upload-queue-item dcp-import-version-item ${modalState.submitting ? "opacity-70" : ""}">
            <div class="kdm-upload-queue-file">
              <input type="checkbox" class="checkbox checkbox-sm" data-dcp-import-version="${escapeHtml(key)}" ${checked ? "checked" : ""} ${modalState.submitting ? "disabled" : ""}>
              <span class="kdm-upload-queue-icon"><i class="fas fa-film"></i></span>
              <div class="min-w-0">
                <div class="font-medium">${escapeHtml(display.movieName)}</div>
                <div class="text-xs text-base-content/65">${escapeHtml(display.version)}</div>
                <div class="mt-1 text-xs text-base-content/55">${escapeHtml(display.detail)}</div>
              </div>
            </div>
            <div class="kdm-upload-queue-meta">
              <span class="badge badge-ghost">${formatDuration(item.durationSeconds, item.durationFrames)}</span>
            </div>
          </label>
        `;
      }).join("");
    }
  }

  if (!list) return;

  if (selectedItems.length === 0) {
    list.innerHTML = '<div class="kdm-upload-queue-empty">请选择影片版本后检测影厅状态。</div>';
    return;
  }
  if (modalState.loading) {
    list.innerHTML = '<div class="kdm-upload-queue-empty"><span class="loading loading-spinner loading-sm"></span> 正在检测影厅状态...</div>';
    return;
  }
  if (modalState.error) {
    list.innerHTML = `<div class="kdm-upload-queue-empty text-error">${escapeHtml(modalState.error)}</div>`;
    return;
  }
  const halls = modalState.check?.halls || [];
  if (halls.length === 0) {
    list.innerHTML = '<div class="kdm-upload-queue-empty">暂无已配置影厅。</div>';
    return;
  }

  list.innerHTML = halls.map((hall) => {
    const disabled = !hall.selectable || modalState.submitting;
    const checked = modalState.selectedHallIds.has(hall.hallId) && hall.selectable;
    const status = getHallImportStatus(hall);
    return `
      <label class="kdm-upload-queue-item dcp-import-hall-item ${disabled ? "opacity-70" : ""}">
        <div class="kdm-upload-queue-file">
          <input type="checkbox" class="checkbox checkbox-sm" data-dcp-import-hall="${escapeHtml(hall.hallId)}" ${checked ? "checked" : ""} ${disabled ? "disabled" : ""}>
          <span class="kdm-upload-queue-icon"><i class="fas ${hall.online ? "fa-server" : "fa-plug-circle-xmark"}"></i></span>
          <div class="min-w-0">
            <div class="font-medium">${escapeHtml(hall.hallName || hall.hallId)}</div>
            <div class="text-xs text-base-content/55">${escapeHtml(hall.deviceId || hall.hallId)}</div>
            <div class="mt-1 text-xs text-base-content/60">
              空间 ${formatBytes(hall.storage?.freeSpace)} / ${formatBytes(hall.storage?.totalSpace)}
              · 需要 ${formatBytes(hall.storage?.requiredSize)}
            </div>
          </div>
        </div>
        <div class="kdm-upload-queue-meta">
          <span class="badge ${status.className}">${status.label}</span>
          ${hall.reason ? `<span class="text-xs text-base-content/60">${escapeHtml(hall.reason)}</span>` : ""}
        </div>
      </label>
    `;
  }).join("");
}

function openDetailModal(key) {
  const dcpPackage = getPackageById(key);
  if (!dcpPackage) {
    setStatus("warning", "未找到该影片包。", { toast: true });
    return;
  }
  dcpState.detailModal = {
    open: true,
    item: dcpPackage,
  };
  renderDetailModal();
  const modal = document.getElementById("dcpDetailModal");
  if (modal instanceof HTMLDialogElement && !modal.open) {
    modal.showModal();
  }
}

function closeDetailModal() {
  dcpState.detailModal.open = false;
  dcpState.detailModal.item = null;
  const modal = document.getElementById("dcpDetailModal");
  if (modal instanceof HTMLDialogElement && modal.open) {
    modal.close();
  }
}

function renderDetailModal() {
  const dcpPackage = dcpState.detailModal.item;
  const titleNode = document.getElementById("dcpDetailTitle");
  const summaryNode = document.getElementById("dcpDetailSummary");
  const contentNode = document.getElementById("dcpDetailContent");
  if (!contentNode) return;

  if (!dcpPackage) {
    if (titleNode) titleNode.textContent = "影片详情";
    if (summaryNode) summaryNode.textContent = "影片包信息与包内版本";
    contentNode.innerHTML = '<div class="kdm-upload-queue-empty">请选择影片包。</div>';
    return;
  }

  const status = getPackageStatus(dcpPackage);
  if (titleNode) titleNode.textContent = getPackageMovieTitle(dcpPackage);
  if (summaryNode) summaryNode.textContent = `${dcpPackage.name || "影片包"} · ${Number(dcpPackage.cplCount || 0)} 个版本`;

  contentNode.innerHTML = `
    <section class="dcp-detail-hero">
      <div>
        <div class="text-sm text-base-content/60">影片包</div>
        <div class="mt-1 text-xl font-bold">${escapeHtml(dcpPackage.name || "-")}</div>
        <div class="mt-2 flex flex-wrap gap-1">
          <span class="badge badge-ghost badge-sm">${Number(dcpPackage.cplCount || 0)} 个版本</span>
          <span class="badge badge-ghost badge-sm">${formatBytes(dcpPackage.size)}</span>
          <span class="badge badge-ghost badge-sm">${Number(dcpPackage.fileCount || 0)} 个文件</span>
        </div>
      </div>
      <div class="dcp-detail-status">
        <span class="badge ${status.className}">${status.label}</span>
        <span class="text-xs text-base-content/55">${escapeHtml(status.message || "校验通过，可用于导入检测。")}</span>
      </div>
    </section>
    <section class="dcp-detail-section">
      <h4>影片包信息</h4>
      <div class="dcp-detail-grid">
        ${renderDetailItem("影片包名", dcpPackage.name)}
        ${renderDetailItem("存储路径", dcpPackage.relativePath)}
        ${renderDetailItem("包大小", formatBytes(dcpPackage.size))}
        ${renderDetailItem("包内版本数", dcpPackage.cplCount ? `${dcpPackage.cplCount}` : "")}
        ${renderDetailItem("文件统计", formatPackageFileSummary(dcpPackage))}
        ${renderDetailItem("ASSETMAP", dcpPackage.assetMapPath)}
        ${renderDetailItem("VOLINDEX", dcpPackage.volumeIndexPath)}
        ${renderDetailItem("更新时间", formatFullDateTime(dcpPackage.updatedAt))}
        ${renderDetailItem("校验结果", formatValidationMessages(dcpPackage.validationMessages))}
      </div>
    </section>
    <section class="dcp-detail-section">
      <h4>包内影片版本</h4>
      <div class="dcp-detail-version-list">
        ${renderPackageVersions(dcpPackage)}
      </div>
    </section>
    <section class="dcp-detail-section">
      <h4>打包列表</h4>
      <div class="dcp-detail-grid">
        ${renderPackagePkls(dcpPackage)}
      </div>
    </section>
  `;
}

function getHallImportStatus(hall) {
  if (!hall.online) return { label: "离线", className: "badge-warning" };
  if (hall.reason?.includes("已存在")) return { label: "已存在", className: "badge-info" };
  if (hall.reason?.includes("空间")) return { label: "空间不足", className: "badge-error" };
  if (!hall.selectable) return { label: "不可导入", className: "badge-error" };
  return { label: "可导入", className: "badge-success" };
}

function renderTaskTable() {
  const body = document.getElementById("dcpTaskTableBody");
  if (!body) return;
  if (dcpState.tasks.length === 0) {
    body.innerHTML = '<tr><td colspan="7" class="text-center text-base-content/60">暂无影片版本导入任务。</td></tr>';
    return;
  }
  body.innerHTML = dcpState.tasks.map((task) => {
    const status = getTaskStatus(task);
    const canCancel = isCancellableTaskStatus(task.status);
    return `
      <tr>
        <td data-label="内容">
          <div class="font-medium">${escapeHtml(task.assetTitle || task.assetId || "-")}</div>
          <div class="text-xs text-base-content/55">${escapeHtml(task.metadata?.packageName || task.metadata?.packageRelativePath || "")}</div>
        </td>
        <td data-label="影厅">${escapeHtml(task.hallName || task.hallId || "-")}</td>
        <td data-label="状态"><span class="badge ${status.className}">${status.label}</span>${formatTaskError(task)}</td>
        <td data-label="进度">${formatTaskProgress(task)}</td>
        <td data-label="任务号" class="text-xs">${escapeHtml(task.ingestUuid || "-")}</td>
        <td data-label="更新时间">${formatDateTime(task.updatedAt || task.createdAt)}</td>
        <td data-label="操作">
          ${canCancel
            ? `<button type="button" class="btn btn-sm btn-ghost gap-1" data-dcp-task-cancel="${escapeHtml(task.id || "")}">
                <i class="fas fa-ban"></i>
                取消
              </button>`
            : '<span class="text-sm text-base-content/45">-</span>'}
        </td>
      </tr>
    `;
  }).join("");
}

function renderUploadQueue() {
  const list = document.getElementById("dcpUploadQueueList");
  const summary = document.getElementById("dcpUploadSummary");
  const confirm = document.getElementById("dcpUploadConfirm");
  if (summary) {
    const pending = dcpState.uploadQueue.filter((item) => item.status !== "success").length;
    summary.textContent = pending > 0 ? `${pending} 个影片包等待上传` : "暂无待上传目录";
  }
  if (confirm instanceof HTMLButtonElement) {
    confirm.disabled = dcpState.uploading || dcpState.uploadQueue.filter((item) => item.status !== "success").length === 0;
  }
  if (!list) return;
  if (dcpState.uploadQueue.length === 0) {
    list.innerHTML = '<div class="kdm-upload-queue-empty">选择一个影片包文件夹，或拖拽文件夹到页面。</div>';
    return;
  }
  list.innerHTML = dcpState.uploadQueue.map((item) => `
    <div class="kdm-upload-queue-item">
      <div class="kdm-upload-queue-file">
        <span class="kdm-upload-queue-icon"><i class="fas ${item.status === "error" ? "fa-triangle-exclamation" : "fa-folder"}"></i></span>
        <div class="min-w-0">
          <div class="truncate font-medium">${escapeHtml(item.packageName)}</div>
          <div class="text-xs text-base-content/55">${item.files.length} 个文件 · ${formatBytes(item.size)}</div>
          ${item.error ? `<div class="text-xs text-error">${escapeHtml(item.error)}</div>` : ""}
        </div>
      </div>
      <div class="kdm-upload-queue-meta">
        ${item.status === "uploading" ? `<progress class="progress progress-primary w-28" value="${item.progress}" max="100"></progress>` : ""}
        <span class="badge ${item.status === "success" ? "badge-success" : item.status === "error" ? "badge-error" : item.status === "uploading" ? "badge-warning" : "badge-ghost"}">${formatUploadStatus(item.status)}</span>
      </div>
    </div>
  `).join("");
}

function openUploadModal() {
  renderUploadQueue();
  const modal = document.getElementById("dcpUploadModal");
  if (modal instanceof HTMLDialogElement && !modal.open) {
    modal.showModal();
  }
}

function closeUploadModal() {
  if (dcpState.uploading) return;
  const modal = document.getElementById("dcpUploadModal");
  if (modal instanceof HTMLDialogElement && modal.open) {
    modal.close();
  }
}

function groupDcpFiles(files) {
  const groups = new Map();
  for (const file of files) {
    const rawPath = file.webkitRelativePath || file.relativePath || file.name;
    const normalized = normalizeClientPath(rawPath);
    const parts = normalized.split("/").filter(Boolean);
    if (parts.length < 2) continue;
    const packageName = parts[0];
    const relativePath = parts.slice(1).join("/");
    if (!groups.has(packageName)) {
      groups.set(packageName, { packageName, files: [], size: 0 });
    }
    const group = groups.get(packageName);
    group.files.push({ file, relativePath });
    group.size += file.size || 0;
  }
  return [...groups.values()];
}

function validateDcpUploadGroup(group) {
  if (!group.files.length) return "目录为空";
  const paths = new Set(group.files.map((item) => item.relativePath.toLowerCase()));
  if (!paths.has("assetmap")) return "缺少 ASSETMAP";
  if (!paths.has("volindex")) return "缺少 VOLINDEX";
  const hasXml = [...paths].some((path) => path.endsWith(".xml"));
  const hasMxf = [...paths].some((path) => path.endsWith(".mxf"));
  if (!hasXml) return "缺少 PKL/CPL XML";
  if (!hasMxf) return "缺少 MXF 资源";
  return "";
}

async function collectDroppedFiles(items) {
  const entries = [...items]
    .map((item) => (typeof item.webkitGetAsEntry === "function" ? item.webkitGetAsEntry() : null))
    .filter(Boolean);
  const files = [];
  for (const entry of entries) {
    files.push(...await readDroppedEntry(entry, ""));
  }
  return files;
}

async function readDroppedEntry(entry, prefix) {
  if (entry.isFile) {
    const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
    file.relativePath = `${prefix}${file.name}`;
    return [file];
  }
  if (!entry.isDirectory) return [];
  const reader = entry.createReader();
  const children = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
  const nested = await Promise.all(children.map((child) => readDroppedEntry(child, `${prefix}${entry.name}/`)));
  return nested.flat();
}

function getVisiblePackages() {
  const query = dcpState.filters.query.toLowerCase();
  const status = dcpState.filters.status;
  return [...dcpState.packages]
    .filter((dcpPackage) => {
      if (query && !getPackageSearchText(dcpPackage).includes(query)) return false;
      if (status !== "all" && String(dcpPackage.status || "ok") !== status) return false;
      return true;
    })
    .sort((left, right) => compareText(getPackageMovieTitle(left), getPackageMovieTitle(right)));
}

function getPackageSearchText(dcpPackage) {
  return [
    dcpPackage.name,
    dcpPackage.relativePath,
    ...getPackageCpls(dcpPackage).flatMap((cpl) => [
      cpl.contentTitleText,
      cpl.annotationText,
      cpl.contentKind,
      cpl.editRate,
      cpl.aspectRatio,
    ]),
  ].filter(Boolean).join(" ").toLowerCase();
}

function isCplImportable(cpl) {
  return cpl.packageStatus !== "error" && Boolean(cpl.assetMapPath && cpl.pklUuid);
}

function getCplStatus(cpl) {
  if (cpl.packageStatus === "error") {
    return { label: "异常", className: "badge-error", message: (cpl.packageValidationMessages || []).join("；") };
  }
  if (!cpl.pklUuid) {
    return { label: "异常", className: "badge-error", message: "该版本缺少导入所需的打包列表关联。" };
  }
  if (cpl.packageStatus === "warning") {
    return { label: "有警告", className: "badge-warning", message: (cpl.packageValidationMessages || []).join("；") };
  }
  return { label: "可导入", className: "badge-success", message: "" };
}

function getPackageStatus(dcpPackage) {
  if (dcpPackage.status === "error") {
    return { label: "异常", className: "badge-error", message: formatValidationMessages(dcpPackage.validationMessages) };
  }
  if (dcpPackage.status === "warning") {
    return { label: "有警告", className: "badge-warning", message: formatValidationMessages(dcpPackage.validationMessages) };
  }
  if (getPackageImportItems(dcpPackage).length === 0) {
    return { label: "不可导入", className: "badge-error", message: "该影片包没有可导入的版本。" };
  }
  return { label: "可导入", className: "badge-success", message: "" };
}

function getPackageById(packageId) {
  return dcpState.packages.find((item) => item.id === packageId || item.name === packageId) || null;
}

function getPackageCpls(dcpPackage) {
  if (!dcpPackage) return [];
  if (Array.isArray(dcpPackage.cpls)) {
    return dcpPackage.cpls.map((cpl) => ({
      ...cpl,
      packageId: dcpPackage.id,
      packageName: dcpPackage.name,
      packageRelativePath: dcpPackage.relativePath,
      packageStatus: dcpPackage.status,
      packageValidationMessages: dcpPackage.validationMessages,
      packageSize: dcpPackage.size,
      assetMapPath: dcpPackage.assetMapPath,
    }));
  }
  return dcpState.cpls.filter((cpl) => cpl.packageId === dcpPackage.id || cpl.packageName === dcpPackage.name);
}

function getPackageImportItems(dcpPackage) {
  return getPackageCpls(dcpPackage).filter(isCplImportable).map(toImportItem);
}

function getPackageMovieTitle(dcpPackage) {
  const first = getPackageCpls(dcpPackage)[0];
  return first ? getCplDisplayParts(first).movieName : dcpPackage?.name || "-";
}

function formatPackageVersionSummary(dcpPackage) {
  const cpls = getPackageCpls(dcpPackage);
  if (cpls.length === 0) return "未解析到版本";
  const versions = cpls.map((cpl) => getCplDisplayParts(cpl).version).filter(Boolean);
  const preview = versions.slice(0, 2).join("；");
  return versions.length > 2 ? `${preview} 等 ${versions.length} 个版本` : preview || `${cpls.length} 个版本`;
}

function renderPackageVersions(dcpPackage) {
  const cpls = getPackageCpls(dcpPackage);
  if (cpls.length === 0) {
    return '<div class="kdm-upload-queue-empty">未解析到影片版本。</div>';
  }
  return cpls.map((cpl) => {
    const display = getCplDisplayParts(cpl);
    const status = getCplStatus(cpl);
    return `
      <article class="dcp-detail-version-item">
        <div>
          <div class="font-medium">${escapeHtml(display.version)}</div>
          <div class="mt-1 flex flex-wrap gap-1">
            ${display.badges.map((badge) => `<span class="badge badge-ghost badge-sm">${escapeHtml(badge)}</span>`).join("")}
          </div>
          <div class="mt-1 text-xs text-base-content/55">
            ${escapeHtml(formatDuration(cpl.durationSeconds, cpl.durationFrames))}
            ${cpl.durationFrames ? ` · ${escapeHtml(String(cpl.durationFrames))} 帧` : ""}
            ${cpl.reelCount ? ` · ${escapeHtml(String(cpl.reelCount))} Reels` : ""}
          </div>
          <div class="mt-1 text-xs text-base-content/55">${escapeHtml(cpl.relativePath || cpl.fileName || "")}</div>
        </div>
        <div class="dcp-detail-version-meta">
          <span class="badge ${status.className}">${status.label}</span>
          ${status.message ? `<span class="text-xs text-base-content/55">${escapeHtml(status.message)}</span>` : ""}
        </div>
      </article>
    `;
  }).join("");
}

function renderPackagePkls(dcpPackage) {
  const pkls = Array.isArray(dcpPackage?.pkls) ? dcpPackage.pkls : [];
  if (pkls.length === 0) {
    return renderDetailItem("PKL", "未解析到 PKL");
  }
  return pkls.map((pkl, index) => [
    renderDetailItem(`PKL ${index + 1}`, pkl.relativePath || pkl.fileName),
    renderDetailItem("PKL UUID", pkl.uuid),
    renderDetailItem("关联版本数", pkl.cplUuids?.length ? `${pkl.cplUuids.length}` : ""),
    renderDetailItem("PKL 大小合计", formatBytes(pkl.totalSize)),
  ].join("")).join("");
}

function getPackageForCpl(cpl) {
  return dcpState.packages.find((item) => item.id === cpl.packageId || item.name === cpl.packageName) || null;
}

function getPklForCpl(cpl, dcpPackage = getPackageForCpl(cpl)) {
  const pkls = Array.isArray(dcpPackage?.pkls) ? dcpPackage.pkls : [];
  return pkls.find((pkl) => normalizeUuid(pkl.uuid) === normalizeUuid(cpl.pklUuid)) || null;
}

function renderDetailItem(label, value) {
  return `
    <div class="dcp-detail-item">
      <dt>${escapeHtml(label)}</dt>
      <dd>${escapeHtml(formatDetailValue(value))}</dd>
    </div>
  `;
}

function formatDetailValue(value) {
  if (Array.isArray(value)) {
    const items = value.map((item) => String(item || "").trim()).filter(Boolean);
    return items.length > 0 ? items.join("；") : "-";
  }
  const text = String(value ?? "").trim();
  return text || "-";
}

function formatPackageFileSummary(dcpPackage) {
  if (!dcpPackage) return "-";
  const parts = [
    `${Number(dcpPackage.fileCount || 0)} 个文件`,
    `${Number(dcpPackage.xmlCount || 0)} XML`,
    `${Number(dcpPackage.mxfCount || 0)} MXF`,
    `${Number(dcpPackage.cplCount || 0)} 个版本`,
    `${Number(dcpPackage.pklCount || 0)} 个 PKL`,
  ];
  return parts.join(" · ");
}

function formatValidationMessages(messages) {
  const list = Array.isArray(messages) ? messages.filter(Boolean) : [];
  return list.length > 0 ? list.join("；") : "通过";
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
  if (errors.length === 0) return "";
  const text = errors.map((item) => item.description || item.code || item.assetUri).filter(Boolean).join("；");
  return text ? `<div class="text-xs text-error mt-1">${escapeHtml(text)}</div>` : "";
}

async function refreshDcpTasks() {
  try {
    const payload = await apiGet("/api/dcp/ingest-tasks");
    dcpState.tasks = Array.isArray(payload.tasks) ? payload.tasks : dcpState.tasks;
    renderDcpStats();
    renderTaskTable();
    syncTaskPolling();
  } catch {
    syncTaskPolling();
  }
}

function syncTaskPolling() {
  const hasActiveTasks = dcpState.tasks.some((task) => !isTerminalTaskStatus(task.status));
  if (hasActiveTasks && !dcpState.taskRefreshTimer) {
    dcpState.taskRefreshTimer = window.setInterval(() => {
      void refreshDcpTasks();
    }, 5000);
  }
  if (!hasActiveTasks && dcpState.taskRefreshTimer) {
    window.clearInterval(dcpState.taskRefreshTimer);
    dcpState.taskRefreshTimer = null;
  }
}

async function cancelDcpTask(taskId, button) {
  if (!taskId) return;
  const task = dcpState.tasks.find((item) => item.id === taskId);
  if (!task || !isCancellableTaskStatus(task.status)) return;

  if (button instanceof HTMLButtonElement) {
    button.disabled = true;
  }
  try {
    const payload = await apiPost(`/api/dcp/ingest-tasks/${encodeURIComponent(taskId)}/cancel`, {});
    dcpState.tasks = Array.isArray(payload.tasks) ? payload.tasks : dcpState.tasks;
    setStatus("success", "已取消 DCP 导入任务。", { toast: true });
    renderDcpStats();
    renderTaskTable();
    syncTaskPolling();
  } catch (error) {
    setStatus("error", error instanceof Error ? error.message : "取消 DCP 导入任务失败。", { toast: true });
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

function pruneImportSelection() {
  const valid = new Set(dcpState.cpls.map(getRowKey));
  dcpState.importModal.items = dcpState.importModal.items.filter((item) => valid.has(getImportItemKey(item)));
  for (const key of [...dcpState.importModal.selectedKeys]) {
    if (!valid.has(key)) dcpState.importModal.selectedKeys.delete(key);
  }
}

function syncDetailSelection() {
  const item = dcpState.detailModal.item;
  if (!item) return;
  const next = getPackageById(item.id || item.name) || null;
  dcpState.detailModal.item = next;
}

function getRowKey(cpl) {
  return `${cpl.packageId}||${cpl.uuid}`;
}

function toImportItem(cpl) {
  return {
    ...cpl,
    packageId: cpl.packageId,
    cplUuid: cpl.cplUuid || cpl.uuid,
  };
}

function toImportPayloadItem(item) {
  return {
    packageId: item.packageId,
    cplUuid: item.cplUuid || item.uuid,
  };
}

function getImportItemKey(item) {
  return `${item.packageId}||${item.cplUuid || item.uuid}`;
}

function getSelectedImportItems() {
  const selectedKeys = dcpState.importModal.selectedKeys || new Set();
  return dcpState.importModal.items.filter((item) => selectedKeys.has(getImportItemKey(item)));
}

function getCplTitle(cpl) {
  return cpl.contentTitleText || cpl.annotationText || cpl.fileName || cpl.uuid || "-";
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
    cpl.contentKind,
    cpl.editRate,
    cpl.aspectRatio,
    formatBytes(cpl.requiredSize),
  ].filter((value) => value && value !== "-");
  const detailParts = [
    cpl.packageName ? `包：${cpl.packageName}` : "",
    cpl.reelCount ? `${cpl.reelCount} Reels` : "",
  ].filter(Boolean);
  return {
    movieName,
    version,
    badges,
    detail: detailParts.join(" · ") || "-",
  };
}

function normalizeClientPath(value) {
  return String(value || "").replaceAll("\\", "/").replace(/^\/+/, "");
}

function formatUploadStatus(status) {
  if (status === "success") return "已上传";
  if (status === "error") return "失败";
  if (status === "uploading") return "上传中";
  return "等待";
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

function formatCapacityPair(capacity) {
  if (capacity?.error) return "读取失败";
  return `${formatBytes(capacity?.usedSpace)} / ${formatBytes(capacity?.totalSpace)}`;
}

function formatDcpCapacityDesc(capacity, packageBytes) {
  if (capacity?.error) return capacity.error;
  const percent = getCapacityPercent(capacity);
  const prefix = percent === null ? "已用 / 总容量" : `已用 / 总容量 · ${percent}%`;
  return `${prefix} · 可用 ${formatBytes(capacity?.availableSpace)} · DCP ${formatBytes(packageBytes)}`;
}

function getCapacityPercent(capacity) {
  const used = Number(capacity?.usedSpace);
  const total = Number(capacity?.totalSpace);
  if (!Number.isFinite(used) || !Number.isFinite(total) || total <= 0) return null;
  return Math.min(100, Math.max(0, Math.round((used / total) * 100)));
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

function formatFullDateTime(value) {
  const date = new Date(value || "");
  if (Number.isNaN(date.getTime())) return "-";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(date);
}

function formatBytes(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "-";
  if (numeric < 1024) return `${numeric} B`;
  if (numeric < 1024 * 1024) return `${(numeric / 1024).toFixed(1)} KB`;
  if (numeric < 1024 * 1024 * 1024) return `${(numeric / 1024 / 1024).toFixed(1)} MB`;
  return `${(numeric / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

function normalizeUuid(value) {
  return String(value || "").trim().toLowerCase().replace(/^urn:uuid:/, "");
}

function setStatus(type, message, options = {}) {
  const node = document.getElementById("dcpUploadStatus");
  if (!node) return;
  const classMap = {
    success: "alert alert-success",
    error: "alert alert-error",
    warning: "alert alert-warning",
    info: "alert alert-info",
  };
  const iconMap = {
    success: "fa-circle-check",
    error: "fa-circle-xmark",
    warning: "fa-triangle-exclamation",
    info: "fa-circle-info",
  };
  node.className = classMap[type] || classMap.info;
  node.innerHTML = `<i class="fas ${iconMap[type] || iconMap.info}"></i><span>${escapeHtml(message)}</span>`;
  if (options.toast) {
    const toastType = toast[type] ? type : "info";
    toast[toastType](message);
  }
}

function setText(id, value) {
  const node = document.getElementById(id);
  if (node) node.textContent = String(value);
}

function compareText(left, right) {
  return String(left || "").localeCompare(String(right || ""), "zh-CN", { numeric: true, sensitivity: "base" });
}

function capitalize(value) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
