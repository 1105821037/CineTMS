import { apiDelete, apiGet, apiPost } from "../api.js";
import { toast } from "../toast.js";

const KDM_UPLOAD_MAX_BYTES = 1024 * 1024;
const KDM_UPLOAD_ZIP_MAX_BYTES = 5 * 1024 * 1024;
const KDM_UPLOAD_ALLOWED_EXTENSIONS = new Set([".xml", ".zip"]);
const KDM_RECIPIENT_SERIAL_PATTERN = /^[A-Z]\d{4,}$/;
const KDM_EXPIRING_SOON_MS = 3 * 24 * 60 * 60 * 1000;

const kdmState = {
  assets: [],
  tasks: [],
  selectedIds: new Set(),
  activeTab: "assets",
  assetPage: 1,
  taskPage: 1,
  assetPageSize: 10,
  taskPageSize: 10,
  filters: {
    query: "",
    status: "all",
    hall: "all",
    validity: "all",
    sortBy: "issueDate",
    sortDir: "desc",
  },
  loading: false,
  uploadQueue: [],
  uploadingQueue: false,
  taskRefreshTimer: null,
  zyhx: {
    items: [],
    selectedIds: new Set(),
    loading: false,
    downloading: false,
    keyword: "",
    downloaded: "",
    page: 1,
    pageSize: 20,
    total: 0,
    totalPages: 1,
  },
};

export async function initKdmPage() {
  bindKdmEvents();
  await refreshKdmAssets();
}

function bindKdmEvents() {
  const uploadTrigger = document.getElementById("kdmUploadTrigger");
  const uploadInput = document.getElementById("kdmUploadInput");
  const refreshButton = document.getElementById("kdmRefreshButton");
  const zyhxOpen = document.getElementById("kdmZyhxOpen");
  const zyhxClose = document.getElementById("kdmZyhxClose");
  const zyhxBackdrop = document.getElementById("kdmZyhxBackdrop");
  const zyhxDetailClose = document.getElementById("kdmZyhxDetailClose");
  const zyhxDetailBackdrop = document.getElementById("kdmZyhxDetailBackdrop");
  const zyhxSearch = document.getElementById("kdmZyhxSearch");
  const zyhxRefresh = document.getElementById("kdmZyhxRefresh");
  const zyhxDownloadSelected = document.getElementById("kdmZyhxDownloadSelected");
  const zyhxKeyword = document.getElementById("kdmZyhxKeyword");
  const zyhxDownloaded = document.getElementById("kdmZyhxDownloaded");
  const zyhxSelectAll = document.getElementById("kdmZyhxSelectAll");
  const zyhxTableBody = document.getElementById("kdmZyhxTableBody");
  const zyhxPageSize = document.getElementById("kdmZyhxPageSize");
  const zyhxPrevPage = document.getElementById("kdmZyhxPrevPage");
  const zyhxNextPage = document.getElementById("kdmZyhxNextPage");
  const tableBody = document.getElementById("kdmTableBody");
  const taskTableBody = document.getElementById("kdmTaskTableBody");
  const selectAll = document.getElementById("kdmSelectAll");
  const batchImport = document.getElementById("kdmBatchImport");
  const batchDelete = document.getElementById("kdmBatchDelete");
  const batchCancel = document.getElementById("kdmBatchCancel");
  const tabButtons = document.querySelectorAll("[data-kdm-tab]");
  const pageButtons = document.querySelectorAll("[data-kdm-page-target]");
  const assetPageSize = document.getElementById("kdmAssetPageSize");
  const taskPageSize = document.getElementById("kdmTaskPageSize");
  const filterQuery = document.getElementById("kdmFilterQuery");
  const filterStatus = document.getElementById("kdmFilterStatus");
  const filterHall = document.getElementById("kdmFilterHall");
  const filterValidity = document.getElementById("kdmFilterValidity");
  const sortBy = document.getElementById("kdmSortBy");
  const sortDirection = document.getElementById("kdmSortDirection");
  const filterReset = document.getElementById("kdmFilterReset");
  const uploadQueueAdd = document.getElementById("kdmUploadQueueAdd");
  const uploadQueueClear = document.getElementById("kdmUploadQueueClear");
  const uploadQueueCancel = document.getElementById("kdmUploadQueueCancel");
  const uploadQueueClose = document.getElementById("kdmUploadQueueClose");
  const uploadQueueConfirm = document.getElementById("kdmUploadQueueConfirm");
  const uploadQueueList = document.getElementById("kdmUploadQueueList");
  const uploadQueueBackdrop = document.getElementById("kdmUploadQueueBackdrop");
  const uploadQueueModal = document.getElementById("kdmUploadQueueModal");
  const shell = document.querySelector(".kdm-shell");

  if (uploadTrigger && uploadTrigger.dataset.bound !== "true") {
    uploadTrigger.dataset.bound = "true";
    uploadTrigger.addEventListener("click", () => uploadInput?.click());
  }

  if (uploadInput && uploadInput.dataset.bound !== "true") {
    uploadInput.dataset.bound = "true";
    uploadInput.addEventListener("change", () => {
      if (!uploadInput.files?.length) {
        return;
      }
      addFilesToUploadQueue(uploadInput.files);
      openUploadQueueModal();
      uploadInput.value = "";
    });
  }

  if (uploadQueueAdd && uploadQueueAdd.dataset.bound !== "true") {
    uploadQueueAdd.dataset.bound = "true";
    uploadQueueAdd.addEventListener("click", () => uploadInput?.click());
  }

  if (uploadQueueClear && uploadQueueClear.dataset.bound !== "true") {
    uploadQueueClear.dataset.bound = "true";
    uploadQueueClear.addEventListener("click", () => {
      if (kdmState.uploadingQueue) return;
      kdmState.uploadQueue = [];
      renderUploadQueue();
    });
  }

  for (const closeButton of [uploadQueueCancel, uploadQueueClose, uploadQueueBackdrop]) {
    if (!closeButton || closeButton.dataset.bound === "true") {
      continue;
    }
    closeButton.dataset.bound = "true";
    closeButton.addEventListener("click", (event) => {
      event.preventDefault();
      closeUploadQueueModal({ discardPending: true });
    });
  }

  if (uploadQueueConfirm && uploadQueueConfirm.dataset.bound !== "true") {
    uploadQueueConfirm.dataset.bound = "true";
    uploadQueueConfirm.addEventListener("click", async () => {
      await uploadQueuedKdms();
    });
  }

  if (uploadQueueList && uploadQueueList.dataset.bound !== "true") {
    uploadQueueList.dataset.bound = "true";
    uploadQueueList.addEventListener("click", (event) => {
      const target = event.target instanceof Element ? event.target : null;
      const removeButton = target?.closest("[data-kdm-upload-remove]");
      if (!(removeButton instanceof HTMLButtonElement) || kdmState.uploadingQueue) {
        return;
      }
      removeUploadQueueItem(removeButton.dataset.kdmUploadRemove);
    });
  }

  if (uploadQueueModal && uploadQueueModal.dataset.bound !== "true") {
    uploadQueueModal.dataset.bound = "true";
    uploadQueueModal.addEventListener("cancel", (event) => {
      if (kdmState.uploadingQueue) {
        event.preventDefault();
        return;
      }
      closeUploadQueueModal({ discardPending: true });
    });
  }

  if (shell && shell.dataset.dragBound !== "true") {
    shell.dataset.dragBound = "true";
    let dragDepth = 0;

    shell.addEventListener("dragenter", (event) => {
      if (!hasDraggedFiles(event)) return;
      event.preventDefault();
      dragDepth += 1;
      shell.classList.add("is-dragging");
    });

    shell.addEventListener("dragover", (event) => {
      if (!hasDraggedFiles(event)) return;
      event.preventDefault();
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = "copy";
      }
    });

    shell.addEventListener("dragleave", (event) => {
      if (!hasDraggedFiles(event)) return;
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) {
        shell.classList.remove("is-dragging");
      }
    });

    shell.addEventListener("drop", (event) => {
      if (!hasDraggedFiles(event)) return;
      event.preventDefault();
      dragDepth = 0;
      shell.classList.remove("is-dragging");
      if (!event.dataTransfer?.files?.length) {
        return;
      }
      addFilesToUploadQueue(event.dataTransfer.files);
      openUploadQueueModal();
    });
  }

  if (uploadQueueModal && uploadQueueModal.dataset.dropBound !== "true") {
    uploadQueueModal.dataset.dropBound = "true";
    let modalDragDepth = 0;

    uploadQueueModal.addEventListener("dragenter", (event) => {
      if (!hasDraggedFiles(event)) return;
      event.preventDefault();
      modalDragDepth += 1;
      uploadQueueModal.classList.add("is-dragging");
    });

    uploadQueueModal.addEventListener("dragover", (event) => {
      if (!hasDraggedFiles(event)) return;
      event.preventDefault();
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = "copy";
      }
    });

    uploadQueueModal.addEventListener("dragleave", (event) => {
      if (!hasDraggedFiles(event)) return;
      modalDragDepth = Math.max(0, modalDragDepth - 1);
      if (modalDragDepth === 0) {
        uploadQueueModal.classList.remove("is-dragging");
      }
    });

    uploadQueueModal.addEventListener("drop", (event) => {
      if (!hasDraggedFiles(event)) return;
      event.preventDefault();
      modalDragDepth = 0;
      uploadQueueModal.classList.remove("is-dragging");
      if (!event.dataTransfer?.files?.length) {
        return;
      }
      addFilesToUploadQueue(event.dataTransfer.files);
      openUploadQueueModal();
    });
  }

  if (refreshButton && refreshButton.dataset.bound !== "true") {
    refreshButton.dataset.bound = "true";
    refreshButton.addEventListener("click", async () => {
      await refreshKdmAssets();
    });
  }

  if (tableBody && tableBody.dataset.bound !== "true") {
    tableBody.dataset.bound = "true";
    tableBody.addEventListener("click", async (event) => {
      const target = event.target instanceof Element ? event.target : null;
      if (!target) return;

      const detailBtn = target.closest("[data-kdm-detail]");
      if (detailBtn instanceof HTMLButtonElement) {
        showKdmDetail(detailBtn.dataset.kdmDetail);
        return;
      }

      const importBtn = target.closest("[data-kdm-import]");
      if (importBtn instanceof HTMLButtonElement) {
        await importKdmToGdc(importBtn.dataset.kdmImport, importBtn);
        return;
      }

      const deleteBtn = target.closest("[data-kdm-delete]");
      if (deleteBtn instanceof HTMLButtonElement) {
        await handleDeleteKdm(deleteBtn.dataset.kdmDelete);
      }
    });

    tableBody.addEventListener("change", (event) => {
      const target = event.target instanceof Element ? event.target : null;
      const checkbox = target?.closest("[data-kdm-select]");
      if (!(checkbox instanceof HTMLInputElement)) {
        return;
      }

      if (checkbox.checked) {
        kdmState.selectedIds.add(checkbox.dataset.kdmSelect);
      } else {
        kdmState.selectedIds.delete(checkbox.dataset.kdmSelect);
      }

      renderKdmTable();
    });
  }

  if (zyhxOpen && zyhxOpen.dataset.bound !== "true") {
    zyhxOpen.dataset.bound = "true";
    zyhxOpen.addEventListener("click", () => void openZyhxKdmModal());
  }

  for (const closeButton of [zyhxClose, zyhxBackdrop]) {
    if (!closeButton || closeButton.dataset.bound === "true") continue;
    closeButton.dataset.bound = "true";
    closeButton.addEventListener("click", (event) => {
      event.preventDefault();
      closeZyhxKdmModal();
    });
  }

  for (const closeButton of [zyhxDetailClose, zyhxDetailBackdrop]) {
    if (!closeButton || closeButton.dataset.bound === "true") continue;
    closeButton.dataset.bound = "true";
    closeButton.addEventListener("click", (event) => {
      event.preventDefault();
      document.getElementById("kdmZyhxDetailModal")?.close();
    });
  }

  if (zyhxSearch && zyhxSearch.dataset.bound !== "true") {
    zyhxSearch.dataset.bound = "true";
    zyhxSearch.addEventListener("click", () => {
      kdmState.zyhx.page = 1;
      void loadZyhxKdmList();
    });
  }

  if (zyhxRefresh && zyhxRefresh.dataset.bound !== "true") {
    zyhxRefresh.dataset.bound = "true";
    zyhxRefresh.addEventListener("click", () => void loadZyhxKdmList({ forceList: true }));
  }

  if (zyhxDownloadSelected && zyhxDownloadSelected.dataset.bound !== "true") {
    zyhxDownloadSelected.dataset.bound = "true";
    zyhxDownloadSelected.addEventListener("click", () => void downloadSelectedZyhxKdms());
  }

  if (zyhxKeyword && zyhxKeyword.dataset.bound !== "true") {
    zyhxKeyword.dataset.bound = "true";
    zyhxKeyword.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        kdmState.zyhx.page = 1;
        void loadZyhxKdmList();
      }
    });
  }

  if (zyhxDownloaded && zyhxDownloaded.dataset.bound !== "true") {
    zyhxDownloaded.dataset.bound = "true";
    zyhxDownloaded.addEventListener("change", () => {
      kdmState.zyhx.page = 1;
      void loadZyhxKdmList();
    });
  }

  if (zyhxPageSize && zyhxPageSize.dataset.bound !== "true") {
    zyhxPageSize.dataset.bound = "true";
    zyhxPageSize.value = String(kdmState.zyhx.pageSize);
    zyhxPageSize.addEventListener("change", () => {
      kdmState.zyhx.pageSize = readPageSize(zyhxPageSize.value);
      kdmState.zyhx.page = 1;
      void loadZyhxKdmList();
    });
  }

  if (zyhxPrevPage && zyhxPrevPage.dataset.bound !== "true") {
    zyhxPrevPage.dataset.bound = "true";
    zyhxPrevPage.addEventListener("click", () => {
      if (kdmState.zyhx.page <= 1) return;
      kdmState.zyhx.page -= 1;
      void loadZyhxKdmList();
    });
  }

  if (zyhxNextPage && zyhxNextPage.dataset.bound !== "true") {
    zyhxNextPage.dataset.bound = "true";
    zyhxNextPage.addEventListener("click", () => {
      if (kdmState.zyhx.page >= kdmState.zyhx.totalPages) return;
      kdmState.zyhx.page += 1;
      void loadZyhxKdmList();
    });
  }

  if (zyhxSelectAll && zyhxSelectAll.dataset.bound !== "true") {
    zyhxSelectAll.dataset.bound = "true";
    zyhxSelectAll.addEventListener("change", () => {
      if (zyhxSelectAll.checked) {
        for (const item of kdmState.zyhx.items) {
          if (item.id) kdmState.zyhx.selectedIds.add(String(item.id));
        }
      } else {
        kdmState.zyhx.selectedIds.clear();
      }
      renderZyhxKdmTable();
    });
  }

  if (zyhxTableBody && zyhxTableBody.dataset.bound !== "true") {
    zyhxTableBody.dataset.bound = "true";
    zyhxTableBody.addEventListener("change", (event) => {
      const checkbox = event.target instanceof Element ? event.target.closest("[data-zyhx-select]") : null;
      if (!(checkbox instanceof HTMLInputElement)) return;
      if (checkbox.checked) {
        kdmState.zyhx.selectedIds.add(checkbox.dataset.zyhxSelect);
      } else {
        kdmState.zyhx.selectedIds.delete(checkbox.dataset.zyhxSelect);
      }
      renderZyhxKdmTable();
    });
    zyhxTableBody.addEventListener("click", (event) => {
      const target = event.target instanceof Element ? event.target : null;
      const detailButton = target?.closest("[data-zyhx-detail]");
      if (detailButton instanceof HTMLButtonElement) {
        showZyhxKdmDetail(detailButton.dataset.zyhxDetail);
        return;
      }

      const downloadButton = target?.closest("[data-zyhx-download]");
      if (downloadButton instanceof HTMLButtonElement) {
        void downloadZyhxKdms([downloadButton.dataset.zyhxDownload], downloadButton);
      }
    });
  }

  if (taskTableBody && taskTableBody.dataset.bound !== "true") {
    taskTableBody.dataset.bound = "true";
    taskTableBody.addEventListener("click", (event) => {
      const target = event.target instanceof Element ? event.target : null;
      const cancelButton = target?.closest("[data-kdm-task-cancel]");
      if (cancelButton instanceof HTMLButtonElement) {
        void cancelKdmTask(cancelButton.dataset.kdmTaskCancel || "", cancelButton);
      }
    });
  }

  if (selectAll && selectAll.dataset.bound !== "true") {
    selectAll.dataset.bound = "true";
    selectAll.addEventListener("change", () => {
      const selectableAssets = getCurrentPageSelectableAssets();
      if (selectAll.checked) {
        for (const asset of selectableAssets) {
          kdmState.selectedIds.add(asset.id);
        }
      } else {
        for (const asset of selectableAssets) {
          kdmState.selectedIds.delete(asset.id);
        }
      }
      renderKdmTable();
    });
  }

  if (batchImport && batchImport.dataset.bound !== "true") {
    batchImport.dataset.bound = "true";
    batchImport.addEventListener("click", async () => {
      await handleBatchImport(batchImport);
    });
  }

  if (batchDelete && batchDelete.dataset.bound !== "true") {
    batchDelete.dataset.bound = "true";
    batchDelete.addEventListener("click", async () => {
      await handleBatchDelete(batchDelete);
    });
  }

  if (batchCancel && batchCancel.dataset.bound !== "true") {
    batchCancel.dataset.bound = "true";
    batchCancel.addEventListener("click", () => {
      clearKdmSelection();
      renderKdmTable();
    });
  }

  for (const tabButton of tabButtons) {
    if (tabButton.dataset.bound === "true") {
      continue;
    }
    tabButton.dataset.bound = "true";
    tabButton.addEventListener("click", () => {
      setKdmActiveTab(tabButton.dataset.kdmTab || "assets");
    });
  }

  for (const pageButton of pageButtons) {
    if (pageButton.dataset.bound === "true") {
      continue;
    }
    pageButton.dataset.bound = "true";
    pageButton.addEventListener("click", () => {
      changeKdmPage(pageButton.dataset.kdmPageTarget, pageButton.dataset.kdmPageAction);
    });
  }

  if (assetPageSize && assetPageSize.dataset.bound !== "true") {
    assetPageSize.dataset.bound = "true";
    assetPageSize.addEventListener("change", () => {
      kdmState.assetPageSize = readPageSize(assetPageSize.value);
      kdmState.assetPage = 1;
      renderKdmTable();
    });
  }

  if (taskPageSize && taskPageSize.dataset.bound !== "true") {
    taskPageSize.dataset.bound = "true";
    taskPageSize.addEventListener("change", () => {
      kdmState.taskPageSize = readPageSize(taskPageSize.value);
      kdmState.taskPage = 1;
      renderKdmTasks();
    });
  }

  if (filterQuery && filterQuery.dataset.bound !== "true") {
    filterQuery.dataset.bound = "true";
    filterQuery.addEventListener("input", () => {
      updateKdmFilter("query", filterQuery.value);
    });
  }

  if (filterStatus && filterStatus.dataset.bound !== "true") {
    filterStatus.dataset.bound = "true";
    filterStatus.addEventListener("change", () => {
      updateKdmFilter("status", filterStatus.value);
    });
  }

  if (filterHall && filterHall.dataset.bound !== "true") {
    filterHall.dataset.bound = "true";
    filterHall.addEventListener("change", () => {
      updateKdmFilter("hall", filterHall.value);
    });
  }

  if (filterValidity && filterValidity.dataset.bound !== "true") {
    filterValidity.dataset.bound = "true";
    filterValidity.addEventListener("change", () => {
      updateKdmFilter("validity", filterValidity.value);
    });
  }

  if (sortBy && sortBy.dataset.bound !== "true") {
    sortBy.dataset.bound = "true";
    sortBy.addEventListener("change", () => {
      updateKdmFilter("sortBy", sortBy.value);
    });
  }

  if (sortDirection && sortDirection.dataset.bound !== "true") {
    sortDirection.dataset.bound = "true";
    sortDirection.addEventListener("click", () => {
      updateKdmFilter("sortDir", kdmState.filters.sortDir === "asc" ? "desc" : "asc");
    });
  }

  if (filterReset && filterReset.dataset.bound !== "true") {
    filterReset.dataset.bound = "true";
    filterReset.addEventListener("click", () => {
      resetKdmFilters();
    });
  }
}

async function refreshKdmAssets() {
  kdmState.loading = true;
  renderKdmTable();
  setUploadStatus("info", "正在加载 KDM 列表...");

  try {
    const payload = await apiGet("/api/kdm/assets");
    kdmState.assets = Array.isArray(payload.assets) ? payload.assets : [];
    kdmState.tasks = Array.isArray(payload.tasks) ? payload.tasks : kdmState.tasks;
    setUploadStatus("success", `已加载 ${kdmState.assets.length} 个 KDM。`);
  } catch (error) {
    setUploadStatus("error", error instanceof Error ? error.message : "加载 KDM 列表失败。");
  } finally {
    kdmState.loading = false;
    renderKdmSummary();
    renderKdmTable();
    renderKdmTasks();
    syncTaskPolling();
  }
}

function addFilesToUploadQueue(fileList) {
  const incomingFiles = [...fileList].filter((file) => file instanceof File);
  if (incomingFiles.length === 0) {
    return 0;
  }

  const existingKeys = new Set(kdmState.uploadQueue.map((item) => getUploadQueueFileKey(item.file)));
  const newItems = [];
  const rejectedItems = [];
  for (const file of incomingFiles) {
    const validationError = validateKdmUploadFile(file);
    if (validationError) {
      rejectedItems.push(`${file.name}（${validationError}）`);
      continue;
    }

    const key = getUploadQueueFileKey(file);
    if (existingKeys.has(key)) {
      continue;
    }
    existingKeys.add(key);
    newItems.push({
      id: `upload-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      file,
      status: "pending",
      error: "",
    });
  }

  if (newItems.length === 0) {
    setUploadStatus(
      "warning",
      rejectedItems.length > 0
        ? `没有可加入队列的文件。${rejectedItems.join("；")}`
        : "这些文件已在上传队列中。",
      { toast: true },
    );
    renderUploadQueue();
    return 0;
  }

  kdmState.uploadQueue = [...kdmState.uploadQueue, ...newItems];
  setUploadStatus(
    rejectedItems.length > 0 ? "warning" : "info",
    rejectedItems.length > 0
      ? `已加入 ${newItems.length} 个文件，${rejectedItems.length} 个被拦截：${rejectedItems.join("；")}`
      : `已加入 ${newItems.length} 个文件到上传队列。`,
    { toast: true },
  );
  renderUploadQueue();
  return newItems.length;
}

async function uploadQueuedKdms() {
  if (kdmState.uploadingQueue) {
    return;
  }

  const uploadItems = kdmState.uploadQueue.filter((item) => item.status !== "success");
  if (uploadItems.length === 0) {
    setUploadStatus("warning", "上传队列为空，请先添加 KDM 文件。", { toast: true });
    renderUploadQueue();
    return;
  }

  kdmState.uploadingQueue = true;
  for (const item of uploadItems) {
    item.status = "pending";
    item.error = "";
  }
  renderUploadQueue();
  setUploadStatus("info", `正在逐个上传 ${uploadItems.length} 个 KDM 文件...`);

  let successCount = 0;
  let failedCount = 0;
  try {
    for (const item of uploadItems) {
      item.status = "uploading";
      renderUploadQueue();
      setUploadStatus("info", `正在上传 ${item.file.name}...`);

      try {
        const extension = getFileExtension(item.file.name);
        const content = extension === ".zip"
          ? await readFileAsBase64(item.file)
          : await item.file.text();
        if (extension === ".xml") {
          validateKdmUploadContent(content, item.file.name);
        }
        const payload = await apiPost("/api/kdm/upload", {
          files: [{
            name: item.file.name,
            content,
            encoding: extension === ".zip" ? "base64" : "text",
          }],
        });
        kdmState.assets = Array.isArray(payload.assets) ? payload.assets : kdmState.assets;
        kdmState.tasks = Array.isArray(payload.tasks) ? payload.tasks : kdmState.tasks;

        const rejected = Array.isArray(payload.rejected) ? payload.rejected : [];
        const rejection = rejected.find((entry) => entry.name === item.file.name) || rejected[0];
        if (rejection) {
          throw new Error(rejection.error || "KDM 校验失败。");
        }

        item.status = "success";
        successCount += Array.isArray(payload.uploaded) && payload.uploaded.length > 0 ? payload.uploaded.length : 1;
      } catch (error) {
        item.status = "error";
        item.error = error instanceof Error ? error.message : "上传 KDM 失败。";
        failedCount += 1;
      }

      renderKdmSummary();
      renderKdmTable();
      renderKdmTasks();
      renderUploadQueue();
    }
  } finally {
    kdmState.uploadingQueue = false;
    kdmState.uploadQueue = failedCount > 0
      ? kdmState.uploadQueue.filter((item) => item.status === "error")
      : [];
    renderKdmSummary();
    renderKdmTable();
    renderKdmTasks();
    renderUploadQueue();
    syncTaskPolling();
  }

  if (failedCount > 0) {
    setUploadStatus("warning", `上传完成：成功处理 ${successCount} 个 KDM，失败 ${failedCount} 个上传项。失败项已保留在队列中。`, {
      toast: true,
      toastTitle: "上传部分失败",
    });
    openUploadQueueModal();
    return;
  }

  closeUploadQueueModal();
  setUploadStatus("success", `已成功处理 ${successCount} 个 KDM 文件。`, { toast: true });
}

async function openZyhxKdmModal() {
  const modal = document.getElementById("kdmZyhxModal");
  if (!(modal instanceof HTMLDialogElement)) return;
  modal.showModal();
  if (kdmState.zyhx.items.length === 0) {
    await loadZyhxKdmList({ forceList: true });
  } else {
    renderZyhxKdmTable();
  }
}

function closeZyhxKdmModal() {
  document.getElementById("kdmZyhxModal")?.close();
}

async function loadZyhxKdmList(options = {}) {
  if (kdmState.zyhx.loading || kdmState.zyhx.downloading) return;
  const keywordInput = document.getElementById("kdmZyhxKeyword");
  const downloadedInput = document.getElementById("kdmZyhxDownloaded");
  const keyword = options.forceList ? "" : (keywordInput?.value || "").trim();
  const downloaded = downloadedInput?.value || "";
  if (options.forceList && keywordInput) keywordInput.value = "";
  if (options.forceList) {
    kdmState.zyhx.page = 1;
  }

  kdmState.zyhx.loading = true;
  kdmState.zyhx.keyword = keyword;
  kdmState.zyhx.downloaded = downloaded;
  kdmState.zyhx.selectedIds.clear();
  renderZyhxKdmTable();
  setZyhxStatus("info", keyword ? "正在搜索中影华夏密钥..." : "正在拉取中影华夏密钥列表...");

  try {
    const params = new URLSearchParams();
    params.set("page", String(kdmState.zyhx.page));
    params.set("pagesize", String(kdmState.zyhx.pageSize));
    if (keyword) params.set("keyword", keyword);
    if (downloaded) params.set("downloaded", downloaded);
    let payload;
    try {
      payload = await zyhxApiGet(`/api/kdm/zyhx/list?${params.toString()}`);
    } catch (error) {
      if (!isZyhxLoginRequired(error)) throw error;
      setZyhxStatus("info", "登录状态已失效，正在登录中...");
      await zyhxApiPost("/api/kdm/zyhx/login", {});
      setZyhxStatus("info", "登录成功，正在重新拉取密钥列表...");
      payload = await zyhxApiGet(`/api/kdm/zyhx/list?${params.toString()}`);
    }
    kdmState.zyhx.items = normalizeZyhxItems(payload.result);
    updateZyhxPagination(payload.result);
    setZyhxStatus("success", `已获取第 ${kdmState.zyhx.page} 页 ${kdmState.zyhx.items.length} 条中影华夏密钥。`);
  } catch (error) {
    kdmState.zyhx.items = [];
    kdmState.zyhx.total = 0;
    kdmState.zyhx.totalPages = 1;
    setZyhxStatus("error", error instanceof Error ? error.message : "拉取中影华夏密钥失败。");
  } finally {
    kdmState.zyhx.loading = false;
    renderZyhxKdmTable();
  }
}

async function downloadSelectedZyhxKdms() {
  await downloadZyhxKdms([...kdmState.zyhx.selectedIds]);
}

async function downloadZyhxKdms(ids, button) {
  const packIds = ids.map((id) => String(id || "").trim()).filter(Boolean);
  if (packIds.length === 0 || kdmState.zyhx.downloading) return;

  kdmState.zyhx.downloading = true;
  const original = button?.innerHTML || "";
  if (button) {
    button.disabled = true;
    button.innerHTML = '<span class="loading loading-spinner loading-sm"></span>';
  }
  renderZyhxKdmTable();
  setZyhxStatus("info", `正在下载 ${packIds.length} 个中影华夏密钥包...`);

  try {
    let payload;
    try {
      payload = await zyhxApiPost("/api/kdm/zyhx/download", { ids: packIds });
    } catch (error) {
      if (!isZyhxLoginRequired(error)) throw error;
      setZyhxStatus("info", "登录状态已失效，正在登录中...");
      await zyhxApiPost("/api/kdm/zyhx/login", {});
      setZyhxStatus("info", "登录成功，正在继续下载密钥包...");
      payload = await zyhxApiPost("/api/kdm/zyhx/download", { ids: packIds });
    }
    kdmState.assets = Array.isArray(payload.assets) ? payload.assets : kdmState.assets;
    kdmState.tasks = Array.isArray(payload.tasks) ? payload.tasks : kdmState.tasks;
    const downloaded = Array.isArray(payload.downloaded) ? payload.downloaded : [];
    const failed = Array.isArray(payload.failed) ? payload.failed : [];
    for (const item of downloaded) {
      if (item.id) kdmState.zyhx.selectedIds.delete(String(item.id));
      const zyhxItem = kdmState.zyhx.items.find((candidate) => candidate.id === String(item.id || ""));
      if (zyhxItem && Array.isArray(item.uploaded) && item.uploaded.length >= zyhxItem.localStatus.requiredCount) {
        zyhxItem.localStatus.presentCount = zyhxItem.localStatus.requiredCount;
        zyhxItem.localStatus.missingCount = 0;
        zyhxItem.localStatus.complete = true;
        zyhxItem.worksheet = zyhxItem.worksheet.map((entry) => ({
          ...entry,
          localPresent: true,
        }));
      }
    }
    renderKdmSummary();
    renderKdmTable();
    renderKdmTasks();
    syncTaskPolling();

    const uploadedCount = downloaded.reduce((sum, item) => sum + (Array.isArray(item.uploaded) ? item.uploaded.length : 0), 0);
    const rejectedCount = downloaded.reduce((sum, item) => sum + (Array.isArray(item.rejected) ? item.rejected.length : 0), 0);
    const failedText = failed.length > 0
      ? `。失败原因：${failed.slice(0, 2).map((item) => `${item.id || "-"} ${item.error || "下载失败"}`).join("；")}`
      : "";
    const message = `下载完成：成功 ${downloaded.length} 个密钥包，入库 ${uploadedCount} 个 KDM，失败 ${failed.length} 个${rejectedCount ? `，拆包拒绝 ${rejectedCount} 个` : ""}${failedText}。`;
    setZyhxStatus(failed.length > 0 ? "warning" : "success", message);
    toast[failed.length > 0 ? "warning" : "success"](message);
  } catch (error) {
    setZyhxStatus("error", error instanceof Error ? error.message : "下载中影华夏密钥失败。");
  } finally {
    kdmState.zyhx.downloading = false;
    if (button) {
      button.disabled = false;
      button.innerHTML = original;
    }
    renderZyhxKdmTable();
  }
}

function normalizeZyhxItems(result) {
  const data = Array.isArray(result?.data) ? result.data : [];
  return data.map((item) => ({
    id: item?.id ? String(item.id) : "",
    movieName: item?.movie_name || item?.main_pid?.movie_name || item?.main_pid?.name || item?.task_name || "-",
    pid: item?.pid || item?.main_pid?.pid || item?.issue_pid || "",
    batchName: item?.batch_name || "",
    taskName: item?.task_name || "",
    notValidBefore: item?.not_valid_before || "",
    notValidAfter: item?.not_valid_after || "",
    kdmCount: Number(item?.kdmcount || item?.workcount || 0),
    worksheet: Array.isArray(item?.worksheet) ? item.worksheet : [],
    localStatus: normalizeZyhxLocalStatus(item?.localStatus, item),
  })).filter((item) => item.id);
}

function normalizeZyhxLocalStatus(status, item) {
  const requiredCount = Number(status?.requiredCount ?? item?.kdmcount ?? item?.workcount ?? 0);
  const presentCount = Number(status?.presentCount ?? 0);
  const missingCount = Number(status?.missingCount ?? Math.max(0, requiredCount - presentCount));
  return {
    requiredCount: Number.isFinite(requiredCount) ? requiredCount : 0,
    presentCount: Number.isFinite(presentCount) ? presentCount : 0,
    missingCount: Number.isFinite(missingCount) ? missingCount : 0,
    complete: status?.complete === true,
  };
}

function updateZyhxPagination(result) {
  const pageinfo = result?.pageinfo && typeof result.pageinfo === "object" ? result.pageinfo : null;
  const total = Number(pageinfo?.total);
  const page = Number(pageinfo?.page);
  const pageSize = Number(pageinfo?.pagesize || pageinfo?.page_size || kdmState.zyhx.pageSize);
  kdmState.zyhx.total = Number.isFinite(total) && total >= 0 ? total : kdmState.zyhx.items.length;
  kdmState.zyhx.page = Number.isInteger(page) && page > 0 ? page : kdmState.zyhx.page;
  kdmState.zyhx.pageSize = Number.isInteger(pageSize) && pageSize > 0 ? pageSize : kdmState.zyhx.pageSize;
  kdmState.zyhx.totalPages = Math.max(1, Math.ceil(kdmState.zyhx.total / kdmState.zyhx.pageSize));
}

function renderZyhxKdmTable() {
  const body = document.getElementById("kdmZyhxTableBody");
  const summary = document.getElementById("kdmZyhxSummary");
  const mobileSummary = document.getElementById("kdmZyhxMobileSummary");
  const selectAll = document.getElementById("kdmZyhxSelectAll");
  const downloadSelected = document.getElementById("kdmZyhxDownloadSelected");
  const pageInfo = document.getElementById("kdmZyhxPageInfo");
  const pageSize = document.getElementById("kdmZyhxPageSize");
  const prevPage = document.getElementById("kdmZyhxPrevPage");
  const nextPage = document.getElementById("kdmZyhxNextPage");
  if (!body) return;

  if (summary) {
    summary.textContent = kdmState.zyhx.loading
      ? "正在加载"
      : `共 ${kdmState.zyhx.total || kdmState.zyhx.items.length} 条，已选 ${kdmState.zyhx.selectedIds.size} 条`;
  }
  if (mobileSummary) {
    mobileSummary.textContent = kdmState.zyhx.loading
      ? "正在加载密钥列表"
      : `共 ${kdmState.zyhx.total || kdmState.zyhx.items.length} 条`;
  }
  if (pageInfo) {
    pageInfo.textContent = `第 ${kdmState.zyhx.page} / ${kdmState.zyhx.totalPages} 页`;
  }
  if (pageSize) {
    pageSize.value = String(kdmState.zyhx.pageSize);
    pageSize.disabled = kdmState.zyhx.loading || kdmState.zyhx.downloading;
  }
  if (prevPage) {
    prevPage.disabled = kdmState.zyhx.loading || kdmState.zyhx.downloading || kdmState.zyhx.page <= 1;
  }
  if (nextPage) {
    nextPage.disabled = kdmState.zyhx.loading || kdmState.zyhx.downloading || kdmState.zyhx.page >= kdmState.zyhx.totalPages;
  }
  if (downloadSelected) {
    downloadSelected.disabled = kdmState.zyhx.selectedIds.size === 0 || kdmState.zyhx.downloading || kdmState.zyhx.loading;
  }
  if (selectAll) {
    selectAll.checked = kdmState.zyhx.items.length > 0 && kdmState.zyhx.items.every((item) => kdmState.zyhx.selectedIds.has(item.id));
    selectAll.indeterminate = !selectAll.checked && kdmState.zyhx.items.some((item) => kdmState.zyhx.selectedIds.has(item.id));
    selectAll.disabled = kdmState.zyhx.items.length === 0 || kdmState.zyhx.downloading || kdmState.zyhx.loading;
  }

  if (kdmState.zyhx.loading) {
    body.innerHTML = '<tr><td colspan="6" class="text-center py-6"><span class="loading loading-spinner loading-sm"></span></td></tr>';
    return;
  }

  if (kdmState.zyhx.items.length === 0) {
    body.innerHTML = '<tr><td colspan="6" class="text-center text-base-content/60 py-6">暂无可下载密钥</td></tr>';
    return;
  }

  body.innerHTML = kdmState.zyhx.items.map((item) => {
    const complete = item.localStatus.complete === true;
    const missingAll = !complete && item.localStatus.presentCount === 0;
    const statusText = complete
      ? "已下载"
      : missingAll
        ? "未下载"
        : `缺少 ${item.localStatus.missingCount} 个`;
    const badgeClass = complete ? "badge-success" : missingAll ? "badge-ghost" : "badge-warning";
    const detailId = escapeHtml(item.id);
    const keyCount = escapeHtml(String(item.localStatus.requiredCount || item.kdmCount || item.worksheet.length));
    const movieName = escapeHtml(item.movieName);
    const metaText = escapeHtml([item.pid, item.batchName].filter(Boolean).join(" · ") || "-");
    const periodText = escapeHtml(formatZyhxPeriod(item));
    return `
      <tr>
        <td class="kdm-zyhx-mobile-card-cell" colspan="6">
          <div class="collapse collapse-arrow bg-base-100 border border-base-300">
            <input type="checkbox" aria-label="展开密钥详情">
            <div class="collapse-title kdm-zyhx-mobile-card-title">
              <div class="min-w-0">
                <div class="kdm-zyhx-mobile-card-name">${movieName}</div>
                <div class="kdm-zyhx-mobile-card-meta">${metaText}</div>
              </div>
              <span class="badge badge-sm ${badgeClass}">${escapeHtml(statusText)}</span>
            </div>
            <div class="collapse-content kdm-zyhx-mobile-card-content">
              <dl>
                <div>
                  <dt>有效期</dt>
                  <dd>${periodText}</dd>
                </div>
                <div>
                  <dt>密钥数</dt>
                  <dd>${keyCount}</dd>
                </div>
                <div>
                  <dt>本地库</dt>
                  <dd>${escapeHtml(`${item.localStatus.presentCount}/${item.localStatus.requiredCount} 已在本地`)}</dd>
                </div>
              </dl>
              <div class="kdm-zyhx-mobile-card-actions">
                <button type="button" class="btn btn-ghost btn-sm gap-1" data-zyhx-detail="${detailId}">
                  <i class="fas fa-circle-info"></i>
                  详情
                </button>
                <button type="button" class="btn btn-primary btn-sm gap-1" data-zyhx-download="${detailId}" ${kdmState.zyhx.downloading || complete ? "disabled" : ""}>
                  <i class="fas fa-download"></i>
                  下载
                </button>
              </div>
            </div>
          </div>
        </td>
        <td data-zyhx-column="movie">
          <div class="font-medium">${movieName}</div>
          <div class="text-xs text-base-content/55">${metaText}</div>
        </td>
        <td data-zyhx-column="period">${periodText}</td>
        <td data-zyhx-column="detail">
          <button type="button" class="btn btn-ghost btn-xs gap-1" data-zyhx-detail="${detailId}">
            <i class="fas fa-circle-info"></i>
            查看
          </button>
        </td>
        <td data-zyhx-column="count">
          <span class="font-medium">${keyCount}</span>
        </td>
        <td data-zyhx-column="status"><span class="badge badge-sm ${badgeClass}">${escapeHtml(statusText)}</span></td>
        <td data-zyhx-column="action" class="text-right">
          <button type="button" class="btn btn-primary btn-xs gap-1" data-zyhx-download="${detailId}" ${kdmState.zyhx.downloading || complete ? "disabled" : ""}>
            <i class="fas fa-download"></i>
            下载
          </button>
        </td>
      </tr>
    `;
  }).join("");
}

function showZyhxKdmDetail(packId) {
  const item = kdmState.zyhx.items.find((candidate) => candidate.id === packId);
  if (!item) return;

  const modal = document.getElementById("kdmZyhxDetailModal");
  const title = document.getElementById("kdmZyhxDetailTitle");
  const summary = document.getElementById("kdmZyhxDetailSummary");
  const body = document.getElementById("kdmZyhxDetailBody");
  if (!(modal instanceof HTMLDialogElement) || !body) return;

  if (title) title.textContent = `${item.movieName} 密钥详情`;
  if (summary) {
    summary.textContent = `${formatZyhxPeriod(item)} · ${item.localStatus.presentCount}/${item.localStatus.requiredCount} 已在本地库`;
  }

  if (!item.worksheet.length) {
    body.innerHTML = '<div class="text-sm text-base-content/60 py-6 text-center">该密钥包没有返回影厅明细。</div>';
  } else {
    body.innerHTML = `
      <div class="overflow-x-auto rounded-box border border-base-300">
        <table class="table table-sm">
          <thead>
            <tr>
              <th>适用影厅</th>
              <th>设备码</th>
              <th>CPL</th>
              <th>有效期</th>
              <th>本地状态</th>
              <th>影厅内状态</th>
            </tr>
          </thead>
          <tbody>
            ${item.worksheet.map((entry) => {
              const present = entry?.localPresent === true;
              const hallName = entry?.hallName || "未匹配影厅";
              const localHint = present
                ? `已存在${entry.localFileName ? `：${entry.localFileName}` : ""}`
                : "缺少";
              const deviceStatus = describeZyhxDeviceKdmStatus(entry?.deviceKdmStatus, entry?.deviceKdmMessage);
              return `
                <tr>
                  <td data-label="适用影厅">${escapeHtml(hallName)}</td>
                  <td data-label="设备码">${escapeHtml(entry?.sn || "-")}</td>
                  <td data-label="CPL" class="max-w-md whitespace-normal break-words">${escapeHtml(entry?.cpl || "-")}</td>
                  <td data-label="有效期">${escapeHtml(`${entry?.nvb || "-"} 至 ${entry?.nva || "-"}`)}</td>
                  <td data-label="本地状态"><span class="badge badge-sm ${present ? "badge-success" : "badge-warning"}">${escapeHtml(localHint)}</span></td>
                  <td data-label="影厅内状态"><span class="badge badge-sm ${escapeHtml(deviceStatus.className)}">${escapeHtml(deviceStatus.label)}</span></td>
                </tr>
              `;
            }).join("")}
          </tbody>
        </table>
      </div>
    `;
  }

  modal.showModal();
}

function describeZyhxDeviceKdmStatus(status, message) {
  const map = {
    present: { label: "影厅内已存在", className: "badge-success" },
    absent: { label: "影厅内缺少", className: "badge-warning" },
    offline: { label: "影厅离线", className: "badge-ghost" },
    unknown: { label: message || "无法确认", className: "badge-ghost" },
    "local-missing": { label: "本地缺少，无法确认", className: "badge-ghost" },
  };
  return map[status] || { label: message || "无法确认", className: "badge-ghost" };
}

function setZyhxStatus(type, message) {
  const node = document.getElementById("kdmZyhxStatus");
  if (!node) return;
  const classMap = { success: "alert alert-success", error: "alert alert-error", warning: "alert alert-warning", info: "alert alert-info" };
  const iconMap = { success: "fa-circle-check", error: "fa-circle-xmark", warning: "fa-triangle-exclamation", info: "fa-circle-info" };
  node.className = `${classMap[type] || classMap.info} mt-4`;
  node.innerHTML = `<i class="fas ${iconMap[type] || iconMap.info}"></i><span>${escapeHtml(message)}</span>`;
}

function formatZyhxPeriod(item) {
  return `${item.notValidBefore || "-"} 至 ${item.notValidAfter || "-"}`;
}

function describeZyhxDownloaded(value) {
  return Number(value) === 0 ? "未下载" : "已下载";
}

async function zyhxApiGet(path) {
  const response = await fetch(path, { cache: "no-cache" });
  return readZyhxApiResponse(response);
}

async function zyhxApiPost(path, body) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return readZyhxApiResponse(response);
}

async function readZyhxApiResponse(response) {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok === false) {
    const error = new Error(payload.error || `请求失败：HTTP ${response.status}`);
    error.code = payload.code || "";
    error.payload = payload;
    throw error;
  }
  return payload;
}

function isZyhxLoginRequired(error) {
  return error?.code === "zyhx-login-required";
}

function openUploadQueueModal() {
  renderUploadQueue();
  const modal = document.getElementById("kdmUploadQueueModal");
  if (modal instanceof HTMLDialogElement && !modal.open) {
    modal.showModal();
  }
}

function closeUploadQueueModal(options = {}) {
  if (kdmState.uploadingQueue) {
    return;
  }
  if (options.discardPending) {
    kdmState.uploadQueue = kdmState.uploadQueue.filter((item) => item.status === "error");
  }
  renderUploadQueue();
  const modal = document.getElementById("kdmUploadQueueModal");
  if (modal instanceof HTMLDialogElement && modal.open) {
    modal.close();
  }
}

function removeUploadQueueItem(itemId) {
  if (!itemId) {
    return;
  }
  kdmState.uploadQueue = kdmState.uploadQueue.filter((item) => item.id !== itemId);
  renderUploadQueue();
}

function renderUploadQueue() {
  const list = document.getElementById("kdmUploadQueueList");
  const summary = document.getElementById("kdmUploadQueueSummary");
  const addButton = document.getElementById("kdmUploadQueueAdd");
  const clearButton = document.getElementById("kdmUploadQueueClear");
  const cancelButton = document.getElementById("kdmUploadQueueCancel");
  const closeButton = document.getElementById("kdmUploadQueueClose");
  const confirmButton = document.getElementById("kdmUploadQueueConfirm");
  const queue = kdmState.uploadQueue;
  const pendingCount = queue.filter((item) => item.status === "pending" || item.status === "error").length;
  const uploadingCount = queue.filter((item) => item.status === "uploading").length;
  const successCount = queue.filter((item) => item.status === "success").length;
  const errorCount = queue.filter((item) => item.status === "error").length;

  if (summary) {
    if (queue.length === 0) {
      summary.textContent = "暂无待上传文件";
    } else if (kdmState.uploadingQueue) {
      summary.textContent = `正在上传，剩余 ${pendingCount + uploadingCount} 个，已完成 ${successCount} 个`;
    } else {
      summary.textContent = `队列中 ${queue.length} 个文件${errorCount > 0 ? `，${errorCount} 个失败可重试` : ""}`;
    }
  }

  if (list) {
    list.innerHTML = queue.length === 0
      ? '<div class="kdm-upload-queue-empty">拖拽 KDM 文件到页面，或点击“继续添加”选择文件。</div>'
      : queue.map((item) => renderUploadQueueItem(item)).join("");
  }

  if (addButton instanceof HTMLButtonElement) {
    addButton.disabled = kdmState.uploadingQueue;
  }
  if (clearButton instanceof HTMLButtonElement) {
    clearButton.disabled = kdmState.uploadingQueue || queue.length === 0;
  }
  if (cancelButton instanceof HTMLButtonElement) {
    cancelButton.disabled = kdmState.uploadingQueue;
  }
  if (closeButton instanceof HTMLButtonElement) {
    closeButton.disabled = kdmState.uploadingQueue;
  }
  if (confirmButton instanceof HTMLButtonElement) {
    confirmButton.disabled = kdmState.uploadingQueue || pendingCount === 0;
    confirmButton.innerHTML = kdmState.uploadingQueue
      ? '<span class="loading loading-spinner loading-sm"></span> 上传中'
      : '<i class="fas fa-cloud-arrow-up"></i> 确定上传';
  }
}

function renderUploadQueueItem(item) {
  const status = getUploadQueueStatus(item.status);
  const removeDisabled = kdmState.uploadingQueue ? "disabled" : "";
  const iconHtml = item.status === "uploading"
    ? '<span class="loading loading-spinner loading-sm"></span>'
    : `<i class="fas ${status.icon}"></i>`;

  return `
    <div class="kdm-upload-queue-item">
      <div class="kdm-upload-queue-file">
        <div class="kdm-upload-queue-icon">${iconHtml}</div>
        <div class="min-w-0">
          <div class="font-medium truncate">${escapeHtml(item.file.name)}</div>
          <div class="text-xs text-base-content/55">${formatBytes(item.file.size)}</div>
          ${item.error ? `<div class="text-xs text-error mt-1">${escapeHtml(item.error)}</div>` : ""}
        </div>
      </div>
      <div class="kdm-upload-queue-meta">
        <span class="badge ${status.className}">${escapeHtml(status.label)}</span>
        <button
          type="button"
          class="btn btn-xs btn-circle btn-ghost"
          data-kdm-upload-remove="${escapeHtml(item.id)}"
          title="移出队列"
          aria-label="移出队列"
          ${removeDisabled}
        >
          <i class="fas fa-xmark"></i>
        </button>
      </div>
    </div>
  `;
}

function getUploadQueueStatus(status) {
  if (status === "uploading") {
    return { label: "上传中", className: "badge-info", icon: "fa-cloud-arrow-up" };
  }
  if (status === "success") {
    return { label: "已完成", className: "badge-success", icon: "fa-circle-check" };
  }
  if (status === "error") {
    return { label: "失败", className: "badge-error", icon: "fa-triangle-exclamation" };
  }
  return { label: "待上传", className: "badge-ghost", icon: "fa-clock" };
}

function getUploadQueueFileKey(file) {
  return `${file.name}:${file.size}:${file.lastModified}`;
}

function validateKdmUploadFile(file) {
  const extension = getFileExtension(file.name);
  if (!KDM_UPLOAD_ALLOWED_EXTENSIONS.has(extension)) {
    return "只允许上传 XML 文件或 ZIP 密钥包";
  }
  if (file.size <= 0) {
    return "文件为空";
  }
  if (extension === ".zip" && file.size >= KDM_UPLOAD_ZIP_MAX_BYTES) {
    return "ZIP 密钥包大小必须小于 5MB";
  }
  if (extension === ".xml" && file.size >= KDM_UPLOAD_MAX_BYTES) {
    return "文件大小必须小于 1MB";
  }
  return "";
}

function validateKdmUploadContent(content, fileName) {
  const normalized = String(content || "").replace(/^\uFEFF/, "").trim();
  if (!normalized) {
    throw new Error(`文件 ${fileName} 内容为空。`);
  }
  if (!normalized.startsWith("<?xml") && !normalized.includes("<DCinemaSecurityMessage")) {
    throw new Error(`文件 ${fileName} 不是有效的 XML。`);
  }
  if (!normalized.includes("<DCinemaSecurityMessage")) {
    throw new Error(`文件 ${fileName} 缺少 DCinemaSecurityMessage 根节点。`);
  }
  if (!normalized.includes("<AuthenticatedPublic")) {
    throw new Error(`文件 ${fileName} 缺少 AuthenticatedPublic 段。`);
  }

  const messageType = readKdmXmlTag(normalized, "MessageType");
  if (!messageType || !messageType.toLowerCase().includes("kdm")) {
    throw new Error(`文件 ${fileName} 不是有效的 KDM 密钥。`);
  }

  for (const tagName of [
    "MessageId",
    "ContentTitleText",
    "CompositionPlaylistId",
    "ContentKeysNotValidBefore",
    "ContentKeysNotValidAfter",
  ]) {
    if (!readKdmXmlTag(normalized, tagName)) {
      throw new Error(`文件 ${fileName} 缺少必填字段 ${tagName}。`);
    }
  }

  const recipientSubject = readKdmXmlTagInSection(normalized, "Recipient", "X509SubjectName");
  if (!extractKdmDeviceCode(recipientSubject)) {
    throw new Error(`文件 ${fileName} 无法识别目标设备码。`);
  }
}

function readKdmXmlTag(xml, tagName) {
  const match = new RegExp(`<(?:\\w+:)?${tagName}[^>]*>([\\s\\S]*?)</(?:\\w+:)?${tagName}>`, "i").exec(xml);
  return match?.[1]?.trim() || "";
}

function readKdmXmlTagInSection(xml, sectionTagName, tagName) {
  const sectionMatch = new RegExp(
    `<(?:\\w+:)?${sectionTagName}[^>]*>([\\s\\S]*?)</(?:\\w+:)?${sectionTagName}>`,
    "i",
  ).exec(xml);
  return sectionMatch ? readKdmXmlTag(sectionMatch[1], tagName) : "";
}

function extractKdmDeviceCode(subjectName) {
  if (!subjectName) {
    return "";
  }
  const cn = /CN=([^,]+)/i.exec(subjectName)?.[1] ?? subjectName;
  return cn
    .split(".")
    .map((token) => token.trim())
    .find((token) => KDM_RECIPIENT_SERIAL_PATTERN.test(token)) || "";
}

function getFileExtension(fileName) {
  const normalized = String(fileName || "").trim().toLowerCase();
  const dotIndex = normalized.lastIndexOf(".");
  return dotIndex >= 0 ? normalized.slice(dotIndex) : "";
}

async function readFileAsBase64(file) {
  const buffer = await file.arrayBuffer();
  let binary = "";
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

function hasDraggedFiles(event) {
  return [...(event.dataTransfer?.types || [])].includes("Files");
}

async function importKdmToGdc(assetId, button) {
  if (!assetId) {
    return;
  }

  const originalLabel = button.innerHTML;
  button.disabled = true;
  button.innerHTML = '<span class="loading loading-spinner loading-sm"></span> 导入中';
  let accepted = false;

  try {
    const payload = await apiPost(`/api/kdm/assets/${encodeURIComponent(assetId)}/import`, {});
    accepted = true;
    const hallName = payload.hall?.hallName || payload.hall?.deviceCode || "目标设备";
    const task = payload.task || buildFallbackTask(assetId, payload);
    upsertTask(task);
    const prefix = payload.reused ? "已有未完成的 KDM 摄取任务" : "已创建 KDM 摄取任务";
    setUploadStatus("success", `${hallName} ${prefix}。`, {
      toast: true,
      toastTitle: "导入任务已创建",
    });
    kdmState.taskPage = 1;
    setKdmActiveTab("tasks");
    renderKdmTable();
    renderKdmTasks();
    syncTaskPolling();
    await refreshKdmAssets();
  } catch (error) {
    setUploadStatus("error", error instanceof Error ? error.message : "导入 GDC 失败。", { toast: true });
  } finally {
    if (!accepted) {
      button.disabled = false;
      button.innerHTML = originalLabel;
    }
  }
}

async function handleBatchImport(button) {
  const selectedIds = getSelectedKdmIds();
  const ids = getSelectedImportableIds();
  if (selectedIds.length === 0) {
    setUploadStatus("warning", "请先勾选状态为“可导入”的 KDM。", { toast: true });
    return;
  }
  if (ids.length !== selectedIds.length) {
    setUploadStatus("warning", "部分密钥不可导入", { toast: true });
    return;
  }

  const originalLabel = button.innerHTML;
  button.disabled = true;
  button.innerHTML = '<span class="loading loading-spinner loading-sm"></span> 创建任务中';
  setUploadStatus("info", `正在为 ${ids.length} 个 KDM 创建导入任务...`);

  try {
    const payload = await apiPost("/api/kdm/batch-import", { ids });
    kdmState.assets = Array.isArray(payload.assets) ? payload.assets : kdmState.assets;
    kdmState.tasks = Array.isArray(payload.tasks) ? payload.tasks : kdmState.tasks;
    clearKdmSelection();

    const imported = Array.isArray(payload.imported) ? payload.imported : [];
    const failed = Array.isArray(payload.failed) ? payload.failed : [];
    if (failed.length > 0) {
      setUploadStatus(
        imported.length > 0 ? "warning" : "error",
        `批量导入任务创建完成：成功 ${imported.length} 个，失败 ${failed.length} 个。${failed.map((item) => `${item.id}（${item.error}）`).join("；")}`,
        {
          toast: true,
          toastMessage: imported.length > 0 ? "批量导入部分失败，请查看页面提示。" : "批量导入失败，请查看页面提示。",
        },
      );
    } else {
      setUploadStatus("success", `已按 KDM 对应影厅创建 ${imported.length} 个导入任务。`, { toast: true });
    }
    if (imported.length > 0) {
      kdmState.taskPage = 1;
      setKdmActiveTab("tasks");
    }
  } catch (error) {
    setUploadStatus("error", error instanceof Error ? error.message : "批量导入失败。", { toast: true });
  } finally {
    button.disabled = false;
    button.innerHTML = originalLabel;
    renderKdmSummary();
    renderKdmTable();
    renderKdmTasks();
    syncTaskPolling();
  }
}

async function handleBatchDelete(button) {
  const ids = getSelectedKdmIds();
  if (ids.length === 0) {
    setUploadStatus("warning", "请先勾选需要删除的 KDM。", { toast: true });
    return;
  }

  const confirmed = await showConfirmDialog(
    "确认批量删除 KDM",
    `确定要删除已选中的 ${ids.length} 个 KDM 文件吗？\n\n此操作不可撤销。`,
  );
  if (!confirmed) return;

  const originalLabel = button.innerHTML;
  button.disabled = true;
  button.innerHTML = '<span class="loading loading-spinner loading-sm"></span> 删除中';

  try {
    const payload = await apiPost("/api/kdm/batch-delete", { ids });
    kdmState.assets = Array.isArray(payload.assets) ? payload.assets : kdmState.assets;
    kdmState.tasks = Array.isArray(payload.tasks) ? payload.tasks : kdmState.tasks;
    clearKdmSelection();

    const deleted = Array.isArray(payload.deleted) ? payload.deleted : [];
    const failed = Array.isArray(payload.failed) ? payload.failed : [];
    setUploadStatus(
      failed.length > 0 ? "warning" : "success",
      `批量删除完成：成功 ${deleted.length} 个，失败 ${failed.length} 个。`,
      { toast: true },
    );
  } catch (error) {
    setUploadStatus("error", error instanceof Error ? error.message : "批量删除 KDM 失败。", { toast: true });
  } finally {
    button.disabled = false;
    button.innerHTML = originalLabel;
    renderKdmSummary();
    renderKdmTable();
    renderKdmTasks();
  }
}

async function handleDeleteKdm(assetId) {
  if (!assetId) return;

  const asset = kdmState.assets.find((item) => item.id === assetId || item.messageId === assetId);
  const title = asset?.contentTitleText || asset?.annotationText || asset?.fileName || assetId;

  const confirmed = await showConfirmDialog(
    "确认删除 KDM",
    `确定要删除以下 KDM 文件吗？\n\n${title}\n\n此操作不可撤销。`,
  );
  if (!confirmed) return;

  try {
    const payload = await apiDelete(`/api/kdm/assets/${encodeURIComponent(assetId)}`);
    kdmState.assets = Array.isArray(payload.assets) ? payload.assets : [];
    kdmState.tasks = Array.isArray(payload.tasks) ? payload.tasks : kdmState.tasks;
    setUploadStatus("success", `已删除 KDM: ${title}`, { toast: true });

    const deleted = payload.deleted;
    if (deleted?.targetHall?.existingKdmStatus === "present" && deleted.targetHall.online) {
      const deleteFromDevice = await showConfirmDialog(
        "设备内存在此 KDM",
        `该 KDM 已存在于设备「${deleted.targetHall.hallName}」中。\n是否同时从设备中删除该 KDM？`,
      );
      if (deleteFromDevice) {
        await deleteKdmFromDevice(deleted);
      }
    }
  } catch (error) {
    setUploadStatus("error", error instanceof Error ? error.message : "删除 KDM 失败。", { toast: true });
  } finally {
    renderKdmSummary();
    renderKdmTable();
    renderKdmTasks();
  }
}

async function deleteKdmFromDevice(asset) {
  const uuid = asset.messageId || asset.id;
  const hallId = asset.targetHall?.hallId;
  if (!hallId || !uuid) return;

  try {
    await apiPost(`/api/kdm/assets/${encodeURIComponent(uuid)}/delete-from-device`, {
      hallId,
      uuid,
      title: asset.contentTitleText || asset.annotationText || asset.fileName,
    });
    setUploadStatus("success", `已从设备「${asset.targetHall.hallName}」中删除 KDM。`, { toast: true });
  } catch (error) {
    setUploadStatus("error", error instanceof Error ? error.message : "从设备删除 KDM 失败。", { toast: true });
  }
}

function showKdmDetail(assetId) {
  const asset = kdmState.assets.find((item) => item.id === assetId || item.messageId === assetId);
  if (!asset) {
    setUploadStatus("warning", "未找到 KDM 详情。", { toast: true });
    return;
  }

  document.getElementById("kdmDetailModal")?.remove();

  const title = asset.contentTitleText || asset.annotationText || asset.fileName || "KDM 详情";
  const status = getAssetStatus(asset);
  const targetHall = asset.targetHall?.hallName || "未匹配影厅";
  const detailSections = [
    {
      title: "业务信息",
      items: [
        ["影片", title],
        ["目标影厅", targetHall],
        ["状态", status.label],
        ["有效期", `${formatDateTime(asset.validBefore)} 至 ${formatDateTime(asset.validAfter)}`],
      ],
    },
    {
      title: "密钥信息",
      items: [
        ["文件名", asset.fileName],
        ["Message ID", asset.messageId],
        ["CPL ID", asset.compositionPlaylistId],
        ["目标设备码", asset.targetHall?.deviceCode || asset.targetDeviceCode],
        ["签发时间", formatDateTime(asset.issueDate)],
      ],
    },
    {
      title: "存储信息",
      items: [
        ["存储位置", asset.relativePath],
        ["文件大小", formatBytes(asset.size)],
        ["识别时间", formatDateTime(asset.createdAt)],
        ["原始文件名", asset.originalFileName],
      ],
    },
    {
      title: "接收方证书",
      items: [
        ["证书序列号", asset.recipientCertificateSerialNumber],
        ["Subject", asset.recipientSubjectName],
        ["Issuer", asset.recipientIssuerName],
      ],
    },
  ];

  const modal = document.createElement("dialog");
  modal.id = "kdmDetailModal";
  modal.className = "modal";
  modal.innerHTML = `
    <div class="modal-box kdm-detail-modal">
      <div class="kdm-upload-modal-head">
        <div>
          <h3 class="text-lg font-bold">KDM 详情</h3>
          <p class="mt-1 text-sm text-base-content/60">${escapeHtml(title)}</p>
        </div>
        <button type="button" class="btn btn-sm btn-circle btn-ghost" data-kdm-detail-close aria-label="关闭详情">
          <i class="fas fa-xmark"></i>
        </button>
      </div>
      <div class="kdm-detail-content">
        ${detailSections.map(renderKdmDetailSection).join("")}
      </div>
      <div class="modal-action">
        <button type="button" class="btn btn-sm btn-ghost" data-kdm-detail-close>关闭</button>
      </div>
    </div>
    <form method="dialog" class="modal-backdrop"><button data-kdm-detail-close>close</button></form>
  `;

  modal.querySelectorAll("[data-kdm-detail-close]").forEach((button) => {
    button.addEventListener("click", () => {
      if (modal.open) {
        modal.close();
      }
      modal.remove();
    });
  });

  document.body.appendChild(modal);
  modal.showModal();
}

function renderKdmDetailSection(section) {
  return `
    <section class="kdm-detail-section">
      <h4>${escapeHtml(section.title)}</h4>
      <dl class="kdm-detail-grid">
        ${section.items.map(([label, value]) => `
          <div class="kdm-detail-item">
            <dt>${escapeHtml(label)}</dt>
            <dd>${escapeHtml(value || "-")}</dd>
          </div>
        `).join("")}
      </dl>
    </section>
  `;
}

function showConfirmDialog(title, message) {
  return new Promise((resolve) => {
    const existing = document.getElementById("kdmConfirmModal");
    if (existing) existing.remove();

    const modal = document.createElement("dialog");
    modal.id = "kdmConfirmModal";
    modal.className = "modal modal-open";
    modal.innerHTML = `
      <div class="modal-box">
        <h3 class="text-lg font-bold">${escapeHtml(title)}</h3>
        <p class="py-4 whitespace-pre-line">${escapeHtml(message)}</p>
        <div class="modal-action">
          <button class="btn btn-ghost" data-action="cancel">取消</button>
          <button class="btn btn-error" data-action="confirm">确认删除</button>
        </div>
      </div>
      <form method="dialog" class="modal-backdrop"><button>close</button></form>
    `;

    const cleanup = (result) => {
      modal.remove();
      resolve(result);
    };

    modal.querySelector("[data-action=cancel]").addEventListener("click", () => cleanup(false));
    modal.querySelector("[data-action=confirm]").addEventListener("click", () => cleanup(true));
    modal.querySelector(".modal-backdrop button").addEventListener("click", () => cleanup(false));

    document.body.appendChild(modal);
  });
}

async function refreshKdmTasks() {
  try {
    const payload = await apiGet("/api/kdm/ingest-tasks");
    kdmState.tasks = Array.isArray(payload.tasks) ? payload.tasks : [];
    renderKdmTasks();
    renderKdmTabs();
  } catch {
    // The main status banner is reserved for user actions; transient polling
    // failures should not hide the last known task state.
  } finally {
    syncTaskPolling();
  }
}

function renderKdmSummary() {
  const total = kdmState.assets.length;
  const expiringSoon = kdmState.assets.filter((asset) => isExpiringSoon(asset.validAfter)).length;
  const importable = kdmState.assets.filter((asset) => getAssetStatusKey(asset) === "importable").length;

  setText("kdmStatTotal", total);
  setText("kdmStatExpiring", expiringSoon);
  setText("kdmStatImportable", importable);
  setText("kdmAssetTabCount", total);
  setText("kdmTaskTabCount", kdmState.tasks.length);
}

function renderKdmTable() {
  const tableBody = document.getElementById("kdmTableBody");
  if (!tableBody) {
    return;
  }

  renderKdmFilterControls();
  pruneKdmSelection();
  const visibleAssets = getVisibleKdmAssets();

  if (kdmState.loading) {
    tableBody.innerHTML = '<tr><td colspan="6" class="text-center text-base-content/60">正在加载 KDM 列表...</td></tr>';
    renderKdmBatchToolbar();
    renderKdmPagination("assets", visibleAssets.length);
    renderKdmTabs();
    return;
  }

  if (visibleAssets.length === 0) {
    const message = kdmState.assets.length === 0 ? "当前还没有已识别的 KDM 文件。" : "没有符合筛选条件的 KDM。";
    tableBody.innerHTML = `<tr><td colspan="6" class="text-center text-base-content/60">${message}</td></tr>`;
    renderKdmBatchToolbar();
    renderKdmPagination("assets", 0);
    renderKdmTabs();
    return;
  }

  const pagination = getPaginationState(visibleAssets.length, kdmState.assetPage, kdmState.assetPageSize);
  kdmState.assetPage = pagination.page;
  const pageAssets = visibleAssets.slice(pagination.startIndex, pagination.endIndex);

  tableBody.innerHTML = pageAssets.map((asset) => {
    const targetText = asset.targetHall
      ? escapeHtml(asset.targetHall.hallName)
      : "未匹配影厅";
    const periodText = `${formatDateTime(asset.validBefore)} 至 ${formatDateTime(asset.validAfter)}`;
    const status = getAssetStatus(asset);
    const importDisabled = status.importDisabled;
    const checked = kdmState.selectedIds.has(asset.id);
    const mobileMetaText = `${asset.targetHall ? asset.targetHall.hallName : "未匹配影厅"} · ${periodText}`;
    const titleText = asset.contentTitleText || asset.annotationText || asset.fileName;

    return `
      <tr>
        <td class="kdm-mobile-card-cell" colspan="6">
          <details class="collapse collapse-arrow bg-base-100 border border-base-300">
            <summary class="collapse-title kdm-mobile-card-title">
              <div class="kdm-mobile-card-title-main">
                <input
                  type="checkbox"
                  class="checkbox checkbox-sm"
                  data-kdm-select="${escapeHtml(asset.id)}"
                  ${checked ? "checked" : ""}
                  title="选择此 KDM"
                  aria-label="选择 KDM"
                  onclick="event.stopPropagation()"
                >
                <div class="min-w-0">
                  <div class="kdm-mobile-card-name">${escapeHtml(titleText)}</div>
                  <div class="kdm-mobile-card-meta">
                    <span>${escapeHtml(mobileMetaText)}</span>
                  </div>
                </div>
              </div>
              <span class="badge badge-sm ${status.className}">${status.label}</span>
            </summary>
            <div class="collapse-content kdm-mobile-card-content">
              <dl>
                <div>
                  <dt>目标影厅</dt>
                  <dd>${targetText}</dd>
                </div>
                <div>
                  <dt>有效期</dt>
                  <dd>${escapeHtml(periodText)}</dd>
                </div>
              </dl>
              <div class="kdm-mobile-card-actions">
                <button class="btn btn-sm btn-ghost" data-kdm-detail="${escapeHtml(asset.id)}" title="查看详情">
                  <i class="fa-solid fa-circle-info"></i>
                  详情
                </button>
                <button class="btn btn-sm btn-primary" data-kdm-import="${escapeHtml(asset.id)}" ${importDisabled ? "disabled" : ""}>
                  <i class="fa-solid fa-download"></i>
                  ${escapeHtml(status.actionLabel)}
                </button>
                <button class="btn btn-sm btn-error btn-outline" data-kdm-delete="${escapeHtml(asset.id)}" title="删除此 KDM">
                  <i class="fa-solid fa-trash-can"></i>
                  删除
                </button>
              </div>
            </div>
          </details>
        </td>
        <td data-label="选择">
          <input
            type="checkbox"
            class="checkbox checkbox-sm"
            data-kdm-select="${escapeHtml(asset.id)}"
            ${checked ? "checked" : ""}
            title="选择此 KDM"
            aria-label="选择 KDM"
          >
        </td>
        <td data-label="影片">
          <div class="font-medium">${escapeHtml(titleText)}</div>
        </td>
        <td data-label="目标影厅">
          <div>${targetText}</div>
        </td>
        <td data-label="有效期">${escapeHtml(periodText)}</td>
        <td data-label="状态"><span class="badge ${status.className}">${status.label}</span></td>
        <td data-label="操作">
          <div class="flex gap-1">
            <button class="btn btn-sm btn-ghost" data-kdm-detail="${escapeHtml(asset.id)}" title="查看详情">
              <i class="fa-solid fa-circle-info"></i>
              详情
            </button>
            <button class="btn btn-sm btn-primary" data-kdm-import="${escapeHtml(asset.id)}" ${importDisabled ? "disabled" : ""}>
              <i class="fa-solid fa-download"></i>
              ${escapeHtml(status.actionLabel)}
            </button>
            <button class="btn btn-sm btn-error btn-outline" data-kdm-delete="${escapeHtml(asset.id)}" title="删除此 KDM">
              <i class="fa-solid fa-trash-can"></i>
            </button>
          </div>
        </td>
      </tr>
    `;
  }).join("");
  renderKdmBatchToolbar();
  renderKdmPagination("assets", visibleAssets.length);
  renderKdmTabs();
}

function renderKdmTasks() {
  const tableBody = document.getElementById("kdmTaskTableBody");
  if (!tableBody) {
    return;
  }

  if (kdmState.tasks.length === 0) {
    tableBody.innerHTML = '<tr><td colspan="6" class="text-center text-base-content/60">暂无 KDM 导入任务。</td></tr>';
    renderKdmPagination("tasks", 0);
    renderKdmTabs();
    return;
  }

  const pagination = getPaginationState(kdmState.tasks.length, kdmState.taskPage, kdmState.taskPageSize);
  kdmState.taskPage = pagination.page;
  const pageTasks = kdmState.tasks.slice(pagination.startIndex, pagination.endIndex);

  tableBody.innerHTML = pageTasks.map((task) => {
    const status = getTaskStatus(task);
    const progress = formatTaskProgress(task);
    const canCancel = isCancellableTaskStatus(task.status);
    return `
      <tr>
        <td data-label="影片">
          <div class="font-medium">${escapeHtml(task.assetTitle || task.metadata?.fileName || task.assetId)}</div>
        </td>
        <td data-label="影厅">${escapeHtml(task.hallName || task.hallId || "-")}</td>
        <td data-label="状态">
          <span class="badge ${status.className}">${escapeHtml(status.label)}</span>
          ${task.description ? `<div class="text-xs text-base-content/60 mt-1">${escapeHtml(task.description)}</div>` : ""}
          ${formatTaskError(task)}
        </td>
        <td data-label="进度">${progress}</td>
        <td data-label="更新时间">${escapeHtml(formatDateTime(task.updatedAt))}</td>
        <td data-label="操作">
          ${canCancel
            ? `<button type="button" class="btn btn-sm btn-ghost gap-1" data-kdm-task-cancel="${escapeHtml(task.id || "")}">
                <i class="fas fa-ban"></i>
                取消
              </button>`
            : '<span class="text-sm text-base-content/45">-</span>'}
        </td>
      </tr>
    `;
  }).join("");
  renderKdmPagination("tasks", kdmState.tasks.length);
  renderKdmTabs();
}

function upsertTask(task) {
  const index = kdmState.tasks.findIndex((item) => item.id === task.id || item.ingestUuid === task.ingestUuid);
  if (index >= 0) {
    kdmState.tasks[index] = task;
  } else {
    kdmState.tasks = [task, ...kdmState.tasks];
  }
}

function renderKdmBatchToolbar() {
  const toolbar = document.getElementById("kdmBatchToolbar");
  const count = document.getElementById("kdmBatchCount");
  const selectAll = document.getElementById("kdmSelectAll");
  const batchImport = document.getElementById("kdmBatchImport");
  const batchDelete = document.getElementById("kdmBatchDelete");
  const selectedCount = getSelectedKdmIds().length;
  const selectedImportableCount = getSelectedImportableIds().length;
  const hasNonImportableSelection = selectedCount > 0 && selectedImportableCount < selectedCount;
  const selectableAssets = getCurrentPageSelectableAssets();
  const selectedSelectableCount = selectableAssets.filter((asset) => kdmState.selectedIds.has(asset.id)).length;

  if (toolbar) {
    toolbar.classList.toggle("hidden", selectedCount === 0);
  }
  if (count) {
    count.textContent = hasNonImportableSelection
      ? `已选 ${selectedCount} 项，部分密钥不可导入`
      : `已选 ${selectedCount} 项`;
  }
  if (batchImport) {
    batchImport.disabled = selectedCount === 0 || hasNonImportableSelection;
    batchImport.title = hasNonImportableSelection ? "部分密钥不可导入" : "";
  }
  if (batchDelete) {
    batchDelete.disabled = selectedCount === 0;
  }
  if (selectAll) {
    selectAll.disabled = selectableAssets.length === 0 || kdmState.loading;
    selectAll.checked = selectableAssets.length > 0 && selectedSelectableCount === selectableAssets.length;
    selectAll.indeterminate = selectedSelectableCount > 0 && selectedSelectableCount < selectableAssets.length;
  }
}

function renderKdmPagination(target, total) {
  const isTaskTarget = target === "tasks";
  const page = isTaskTarget ? kdmState.taskPage : kdmState.assetPage;
  const pageSize = isTaskTarget ? kdmState.taskPageSize : kdmState.assetPageSize;
  const pagination = getPaginationState(total, page, pageSize);

  if (isTaskTarget) {
    kdmState.taskPage = pagination.page;
  } else {
    kdmState.assetPage = pagination.page;
  }

  const prefix = isTaskTarget ? "kdmTask" : "kdmAsset";
  const paginationNode = document.getElementById(`${prefix}Pagination`);
  const infoNode = document.getElementById(`${prefix}PageInfo`);
  const numberNode = document.getElementById(`${prefix}PageNumber`);
  const sizeSelect = document.getElementById(`${prefix}PageSize`);
  const prevButton = document.querySelector(`[data-kdm-page-target="${target}"][data-kdm-page-action="prev"]`);
  const nextButton = document.querySelector(`[data-kdm-page-target="${target}"][data-kdm-page-action="next"]`);
  const firstItem = total > 0 ? pagination.startIndex + 1 : 0;
  const lastItem = total > 0 ? pagination.endIndex : 0;

  if (paginationNode) {
    paginationNode.classList.toggle("hidden", total === 0);
  }
  if (infoNode) {
    infoNode.textContent = `${firstItem}-${lastItem} / ${total}`;
  }
  if (numberNode) {
    numberNode.textContent = `${pagination.page} / ${pagination.totalPages}`;
  }
  if (sizeSelect) {
    sizeSelect.value = String(pageSize);
  }
  if (prevButton instanceof HTMLButtonElement) {
    prevButton.disabled = pagination.page <= 1;
  }
  if (nextButton instanceof HTMLButtonElement) {
    nextButton.disabled = pagination.page >= pagination.totalPages;
  }
}

function changeKdmPage(target, action) {
  if (target === "tasks") {
    const pagination = getPaginationState(kdmState.tasks.length, kdmState.taskPage, kdmState.taskPageSize);
    kdmState.taskPage = action === "next"
      ? Math.min(pagination.page + 1, pagination.totalPages)
      : Math.max(pagination.page - 1, 1);
    renderKdmTasks();
    return;
  }

  const pagination = getPaginationState(kdmState.assets.length, kdmState.assetPage, kdmState.assetPageSize);
  kdmState.assetPage = action === "next"
    ? Math.min(pagination.page + 1, pagination.totalPages)
    : Math.max(pagination.page - 1, 1);
  renderKdmTable();
}

function getPaginationState(total, page, pageSize) {
  const safePageSize = readPageSize(pageSize);
  const totalPages = Math.max(1, Math.ceil(total / safePageSize));
  const safePage = Math.min(Math.max(Number(page) || 1, 1), totalPages);
  const startIndex = total > 0 ? (safePage - 1) * safePageSize : 0;
  const endIndex = total > 0 ? Math.min(startIndex + safePageSize, total) : 0;
  return { page: safePage, pageSize: safePageSize, totalPages, startIndex, endIndex };
}

function readPageSize(value) {
  const numeric = Number(value);
  return [10, 20, 50, 100].includes(numeric) ? numeric : 10;
}

function updateKdmFilter(key, value) {
  if (!Object.prototype.hasOwnProperty.call(kdmState.filters, key)) {
    return;
  }

  kdmState.filters[key] = key === "query" ? String(value || "").trim() : String(value || "all");
  kdmState.assetPage = 1;
  clearKdmSelection();
  renderKdmTable();
}

function resetKdmFilters() {
  kdmState.filters = {
    query: "",
    status: "all",
    hall: "all",
    validity: "all",
    sortBy: "issueDate",
    sortDir: "desc",
  };
  kdmState.assetPage = 1;
  clearKdmSelection();
  renderKdmTable();
}

function renderKdmFilterControls() {
  const query = document.getElementById("kdmFilterQuery");
  const status = document.getElementById("kdmFilterStatus");
  const hall = document.getElementById("kdmFilterHall");
  const validity = document.getElementById("kdmFilterValidity");
  const sortBy = document.getElementById("kdmSortBy");
  const sortDirection = document.getElementById("kdmSortDirection");
  const summary = document.getElementById("kdmFilterSummary");

  if (query && query.value !== kdmState.filters.query) {
    query.value = kdmState.filters.query;
  }
  if (status) {
    status.value = kdmState.filters.status;
  }
  if (hall) {
    const currentValue = kdmState.filters.hall;
    hall.innerHTML = [
      '<option value="all">全部影厅</option>',
      ...getKdmHallFilterOptions().map((item) =>
        `<option value="${escapeHtml(item.value)}">${escapeHtml(item.label)}</option>`
      ),
    ].join("");
    hall.value = [...hall.options].some((option) => option.value === currentValue) ? currentValue : "all";
    if (hall.value !== currentValue) {
      kdmState.filters.hall = "all";
    }
  }
  if (validity) {
    validity.value = kdmState.filters.validity;
  }
  if (sortBy) {
    sortBy.value = kdmState.filters.sortBy;
  }
  if (sortDirection) {
    const isAsc = kdmState.filters.sortDir === "asc";
    sortDirection.dataset.sortDir = isAsc ? "asc" : "desc";
    sortDirection.innerHTML = `
      <i class="fas ${isAsc ? "fa-arrow-up-wide-short" : "fa-arrow-down-wide-short"}"></i>
      ${isAsc ? "升序" : "降序"}
    `;
  }
  if (summary) {
    const visibleCount = getVisibleKdmAssets().length;
    const summaryText = visibleCount === kdmState.assets.length
      ? `显示全部 ${kdmState.assets.length} 个 KDM`
      : `已筛选出 ${visibleCount} / ${kdmState.assets.length} 个 KDM`;
    summary.textContent = summaryText;
    setText("kdmMobileFilterSummary", summaryText);
  }
}

function getKdmHallFilterOptions() {
  const options = new Map();
  for (const asset of kdmState.assets) {
    const hallId = asset.targetHall?.hallId;
    if (hallId) {
      options.set(`hall:${hallId}`, asset.targetHall.hallName || hallId);
      continue;
    }
    if (asset.targetDeviceCode) {
      options.set("unmatched", "未匹配影厅");
    }
  }

  return [...options.entries()]
    .map(([value, label]) => ({ value, label }))
    .sort((left, right) => left.label.localeCompare(right.label, "zh-CN"));
}

function getVisibleKdmAssets() {
  const query = kdmState.filters.query.toLowerCase();
  const statusFilter = kdmState.filters.status;
  const hallFilter = kdmState.filters.hall;
  const validityFilter = kdmState.filters.validity;

  return [...kdmState.assets]
    .filter((asset) => {
      if (query && !getKdmSearchText(asset).includes(query)) {
        return false;
      }
      if (statusFilter !== "all" && getAssetStatusKey(asset) !== statusFilter) {
        return false;
      }
      if (hallFilter !== "all" && getKdmHallFilterValue(asset) !== hallFilter) {
        return false;
      }
      if (validityFilter !== "all" && getKdmValidityKey(asset) !== validityFilter) {
        return false;
      }
      return true;
    })
    .sort(compareKdmAssets);
}

function getKdmSearchText(asset) {
  return [
    asset.contentTitleText,
    asset.annotationText,
    asset.fileName,
    asset.messageId,
    asset.compositionPlaylistId,
    asset.targetDeviceCode,
    asset.targetHall?.hallName,
    asset.targetHall?.deviceCode,
  ].filter(Boolean).join(" ").toLowerCase();
}

function getKdmHallFilterValue(asset) {
  if (asset.targetHall?.hallId) {
    return `hall:${asset.targetHall.hallId}`;
  }
  return "unmatched";
}

function getKdmValidityKey(asset) {
  const now = Date.now();
  const before = Date.parse(asset.validBefore || "");
  const after = Date.parse(asset.validAfter || "");
  if (Number.isFinite(after) && after < now) {
    return "expired";
  }
  if (Number.isFinite(before) && before > now) {
    return "not-yet-valid";
  }
  return "valid";
}

function compareKdmAssets(left, right) {
  const direction = kdmState.filters.sortDir === "asc" ? 1 : -1;
  const sortBy = kdmState.filters.sortBy;
  let result = 0;

  if (sortBy === "title") {
    result = compareText(getKdmTitle(left), getKdmTitle(right));
  } else if (sortBy === "hall") {
    result = compareText(left.targetHall?.hallName || "", right.targetHall?.hallName || "");
  } else if (sortBy === "device") {
    result = compareText(left.targetHall?.deviceCode || left.targetDeviceCode || "", right.targetHall?.deviceCode || right.targetDeviceCode || "");
  } else if (sortBy === "validBefore") {
    result = compareDate(left.validBefore, right.validBefore);
  } else if (sortBy === "validAfter") {
    result = compareDate(left.validAfter, right.validAfter);
  } else if (sortBy === "status") {
    result = compareText(getAssetStatus(left).label, getAssetStatus(right).label);
  } else {
    result = compareDate(left.issueDate || left.createdAt, right.issueDate || right.createdAt);
  }

  if (result === 0) {
    result = compareText(getKdmTitle(left), getKdmTitle(right));
  }
  return result * direction;
}

function getKdmTitle(asset) {
  return asset.contentTitleText || asset.annotationText || asset.fileName || "";
}

function compareText(left, right) {
  return String(left || "").localeCompare(String(right || ""), "zh-CN", { numeric: true, sensitivity: "base" });
}

function compareDate(left, right) {
  const leftTime = Date.parse(left || "");
  const rightTime = Date.parse(right || "");
  const safeLeft = Number.isFinite(leftTime) ? leftTime : 0;
  const safeRight = Number.isFinite(rightTime) ? rightTime : 0;
  return safeLeft - safeRight;
}

function setKdmActiveTab(tabName) {
  kdmState.activeTab = tabName === "tasks" ? "tasks" : "assets";
  renderKdmTabs();
}

function renderKdmTabs() {
  const activeTab = kdmState.activeTab === "tasks" ? "tasks" : "assets";
  const assetPanel = document.getElementById("kdmAssetPanel");
  const taskPanel = document.getElementById("kdmTaskPanel");
  const assetTab = document.getElementById("kdmAssetTab");
  const taskTab = document.getElementById("kdmTaskTab");

  if (assetPanel) {
    assetPanel.classList.toggle("hidden", activeTab !== "assets");
  }
  if (taskPanel) {
    taskPanel.classList.toggle("hidden", activeTab !== "tasks");
  }
  if (assetTab) {
    assetTab.classList.toggle("tab-active", activeTab === "assets");
    assetTab.setAttribute("aria-selected", activeTab === "assets" ? "true" : "false");
  }
  if (taskTab) {
    taskTab.classList.toggle("tab-active", activeTab === "tasks");
    taskTab.setAttribute("aria-selected", activeTab === "tasks" ? "true" : "false");
  }

  setText("kdmAssetTabCount", kdmState.assets.length);
  setText("kdmTaskTabCount", kdmState.tasks.length);
}

function getBatchSelectableAssets() {
  return getVisibleKdmAssets().filter((asset) => isAssetBatchSelectable(asset));
}

function getCurrentPageSelectableAssets() {
  const visibleAssets = getVisibleKdmAssets();
  const pagination = getPaginationState(visibleAssets.length, kdmState.assetPage, kdmState.assetPageSize);
  return visibleAssets.slice(pagination.startIndex, pagination.endIndex);
}

function isAssetBatchSelectable(asset) {
  const status = getAssetStatus(asset);
  return status.label === "可导入" && status.importDisabled === false;
}

function getSelectedImportableIds() {
  const selectableIds = new Set(getBatchSelectableAssets().map((asset) => asset.id));
  return [...kdmState.selectedIds].filter((id) => selectableIds.has(id));
}

function getSelectedKdmIds() {
  const existingIds = new Set(kdmState.assets.map((asset) => asset.id));
  return [...kdmState.selectedIds].filter((id) => existingIds.has(id));
}

function pruneKdmSelection() {
  const selectableIds = new Set(kdmState.assets.map((asset) => asset.id));
  for (const id of [...kdmState.selectedIds]) {
    if (!selectableIds.has(id)) {
      kdmState.selectedIds.delete(id);
    }
  }
}

function clearKdmSelection() {
  kdmState.selectedIds.clear();
}

function syncTaskPolling() {
  const hasActiveTasks = kdmState.tasks.some((task) => !isTerminalTaskStatus(task.status));
  if (hasActiveTasks && !kdmState.taskRefreshTimer) {
    kdmState.taskRefreshTimer = window.setInterval(() => {
      void refreshKdmTasks();
    }, 5000);
  }
  if (!hasActiveTasks && kdmState.taskRefreshTimer) {
    window.clearInterval(kdmState.taskRefreshTimer);
    kdmState.taskRefreshTimer = null;
  }
}

async function cancelKdmTask(taskId, button) {
  if (!taskId) return;
  const task = kdmState.tasks.find((item) => item.id === taskId);
  if (!task || !isCancellableTaskStatus(task.status)) return;

  if (button instanceof HTMLButtonElement) {
    button.disabled = true;
  }
  try {
    const payload = await apiPost(`/api/kdm/ingest-tasks/${encodeURIComponent(taskId)}/cancel`, {});
    kdmState.tasks = Array.isArray(payload.tasks) ? payload.tasks : kdmState.tasks;
    setUploadStatus("success", "已取消 KDM 导入任务。", { toast: true });
    renderKdmSummary();
    renderKdmTable();
    renderKdmTasks();
    syncTaskPolling();
  } catch (error) {
    setUploadStatus("error", error instanceof Error ? error.message : "取消 KDM 导入任务失败。", { toast: true });
  } finally {
    if (button instanceof HTMLButtonElement) {
      button.disabled = false;
    }
  }
}

function getTaskStatus(task) {
  const status = String(task.status || "").toLowerCase();
  if (status === "complete") {
    return { label: "已完成", className: "badge-success", actionLabel: "已完成" };
  }
  if (status === "failed") {
    return { label: "失败", className: "badge-error", actionLabel: "重新导入" };
  }
  if (status === "cancelled" || status === "canceled") {
    return { label: "已取消", className: "badge-neutral", actionLabel: "重新导入" };
  }
  if (status === "removed") {
    return { label: "已移除", className: "badge-neutral", actionLabel: "重新导入" };
  }
  if (status === "paused") {
    return { label: "已暂停", className: "badge-warning", actionLabel: "已暂停" };
  }
  if (status === "unreachable") {
    return { label: "设备离线", className: "badge-warning", actionLabel: "设备离线" };
  }
  if (status === "running") {
    return { label: "摄取中", className: "badge-warning", actionLabel: "摄取中" };
  }
  if (status === "queued" || status === "accepted") {
    return { label: "排队中", className: "badge-info", actionLabel: "排队中" };
  }
  return { label: "等待确认", className: "badge-ghost", actionLabel: "等待确认" };
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
  if (errors.length === 0) {
    return "";
  }

  const text = errors.map((item) => item.description || item.code || item.assetUri).filter(Boolean).join("；");
  return text ? `<div class="text-xs text-error mt-1">${escapeHtml(text)}</div>` : "";
}

function getAssetStatus(asset) {
  const task = findTaskForAsset(asset);
  if (task && !isTerminalTaskStatus(task.status)) {
    const taskStatus = getTaskStatus(task);
    return {
      label: taskStatus.label,
      className: taskStatus.className,
      importDisabled: true,
      actionLabel: taskStatus.actionLabel,
    };
  }
  if (!asset.targetHall) {
    return { label: "未匹配", className: "badge-error", importDisabled: true, actionLabel: "不可导入" };
  }
  if (!asset.targetHall.online) {
    return { label: "影厅离线", className: "badge-warning", importDisabled: true, actionLabel: "不可导入" };
  }
  if (asset.targetHall.existingKdmStatus === "present") {
    return { label: "已在影厅内", className: "badge-info", importDisabled: true, actionLabel: "已存在" };
  }
  if (asset.targetHall.existingKdmStatus === "unknown") {
    return { label: "无法确认", className: "badge-warning", importDisabled: true, actionLabel: "刷新后重试" };
  }
  if (isExpired(asset.validAfter)) {
    return { label: "已过期", className: "badge-error", importDisabled: true, actionLabel: "不可导入" };
  }
  return { label: "可导入", className: "badge-success", importDisabled: false, actionLabel: "导入到 GDC" };
}

function getAssetStatusKey(asset) {
  const task = findTaskForAsset(asset);
  if (task && !isTerminalTaskStatus(task.status)) {
    return "active-task";
  }
  if (!asset.targetHall) {
    return "unmatched";
  }
  if (!asset.targetHall.online) {
    return "offline";
  }
  if (asset.targetHall.existingKdmStatus === "present") {
    return "present";
  }
  if (asset.targetHall.existingKdmStatus === "unknown") {
    return "unknown";
  }
  if (isExpired(asset.validAfter)) {
    return "expired";
  }
  return "importable";
}

function findTaskForAsset(asset) {
  const assetId = String(asset.messageId || asset.id || "").toLowerCase();
  const hallId = String(asset.targetHall?.hallId || "").toLowerCase();
  return kdmState.tasks.find((task) =>
    String(task.assetId || "").toLowerCase() === assetId
    && (!hallId || String(task.hallId || "").toLowerCase() === hallId)
    && !isTerminalTaskStatus(task.status)
  );
}

function isTerminalTaskStatus(status) {
  return ["complete", "failed", "cancelled", "canceled", "removed"].includes(String(status || "").toLowerCase());
}

function isCancellableTaskStatus(status) {
  return !isTerminalTaskStatus(status);
}

function buildFallbackTask(assetId, payload) {
  const asset = kdmState.assets.find((item) => item.id === assetId || item.messageId === assetId);
  const now = new Date().toISOString();
  return {
    id: `local-${payload.ingestUuid || Date.now()}`,
    type: "KDM",
    hallId: payload.hall?.hallId || asset?.targetHall?.hallId || "",
    hallName: payload.hall?.hallName || asset?.targetHall?.hallName || "",
    assetId: asset?.messageId || asset?.id || assetId,
    assetTitle: asset?.contentTitleText || asset?.annotationText || asset?.fileName || assetId,
    ingestUuid: payload.ingestUuid || "",
    status: "accepted",
    errorList: [],
    warningList: [],
    metadata: {
      fileName: asset?.fileName,
    },
    createdAt: now,
    updatedAt: now,
  };
}

function isExpired(value) {
  const time = Date.parse(value || "");
  return Number.isFinite(time) && time < Date.now();
}

function isExpiringSoon(value) {
  const time = Date.parse(value || "");
  if (!Number.isFinite(time)) {
    return false;
  }
  const now = Date.now();
  return time >= now && time <= now + KDM_EXPIRING_SOON_MS;
}

function setUploadStatus(type, message, options = {}) {
  const node = document.getElementById("kdmUploadStatus");
  if (!node) {
    return;
  }

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
  node.innerHTML = `
    <i class="fas ${iconMap[type] || iconMap.info}"></i>
    <span>${escapeHtml(message)}</span>
  `;

  if (options.toast) {
    const toastType = toast[type] ? type : "info";
    toast[toastType](options.toastMessage || message, options.toastTitle ? { title: options.toastTitle } : {});
  }
}

function setText(id, value) {
  const node = document.getElementById(id);
  if (node) {
    node.textContent = String(value);
  }
}

function formatDateTime(value) {
  const date = new Date(value || "");
  if (Number.isNaN(date.getTime())) {
    return "-";
  }
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function formatBytes(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return "-";
  }
  if (numeric < 1024) {
    return `${numeric} B`;
  }
  if (numeric < 1024 * 1024) {
    return `${(numeric / 1024).toFixed(1)} KB`;
  }
  if (numeric < 1024 * 1024 * 1024) {
    return `${(numeric / 1024 / 1024).toFixed(1)} MB`;
  }
  return `${(numeric / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
