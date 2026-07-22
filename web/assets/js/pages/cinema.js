import { apiGet, apiPost, getRuntimeHalls, openEventStream } from "../api.js";
import { appState } from "../state.js";
import { toast } from "../toast.js";

const DEFAULT_FPS = 24;
const EMPTY_SHOW_UUID = "urn:uuid:00000000-0000-0000-0000-000000000000";
const INTERPOLATION_INTERVAL_MS = 250;
const SCHEDULE_STATUS_REFRESH_MS = 5_000;
const ACTIVE_SCHEDULE_STATUSES = new Set(["preparing", "ready", "playing", "manual_hold", "monitor_lost", "transitioning"]);

const cinemaState = {
  selectedHallId: null,
  selectedHall: null,
  selectedShowUuid: "",
  automationLabels: [],
  selectedAutomationLabel: "",
  loadedShowInspection: null,
  pendingLoadShow: null,
  pendingLoadInspection: null,
  pendingSeekTarget: null,
  pendingExitScheduleRuntime: null,
  shows: [],
  stream: null,
  interpolationTimer: null,
  scheduleStatusTimer: null,
  playbackSample: null,
  playbackUiOverride: null,
  scheduleMonitorExitBusy: false,
  scheduleStatus: {
    showDate: "",
    runtimes: [],
    actions: [],
    entries: [],
    loadedAt: 0,
  },
  isSeeking: false,
  controlPanelBusy: false,
  controlPanelBusyText: "正在处理...",
  selectedTimepointId: "",
};

const cinemaDom = {
  root: null,
  emptyState: null,
  hallInfo: null,
  error: null,
  playbackCard: null,
  scheduleStatusPanel: null,
  controlBusyMask: null,
  controlBusyText: null,
  showPickerDropdown: null,
  showList: null,
  loadedCplList: null,
  automationSelect: null,
  playbackSlider: null,
  progressMarkers: null,
  timepointList: null,
  timepointSummary: null,
  seekPreview: null,
  loadDialog: null,
  loadDialogList: null,
  seekDialog: null,
  seekInput: null,
  exitScheduleDialog: null,
  showItemTemplate: null,
  cplItemTemplate: null,
  fields: {},
  loadDialogFields: {},
  seekDialogFields: {},
  exitScheduleDialogFields: {},
};

const cinemaListeners = {
  documentPointerDown: null,
};

export async function initCinemaPage() {
  cacheCinemaDom();
  bindCinemaEvents();
  startInterpolationTicker();
  await loadSelectedHall();
  renderAll();

  if (!cinemaState.selectedHallId) {
    return;
  }

  if (!cinemaState.selectedHall) {
    renderCinemaError(`影厅 "${cinemaState.selectedHallId}" 已失效或不存在，请重新选择影厅。`);
    return;
  }

  connectHallStream(cinemaState.selectedHallId);
  startScheduleStatusPolling();
  void hydrateCinemaSecondaryData(cinemaState.selectedHallId);
  void loadScheduleStatus();
}

export function disposeCinemaPage() {
  cinemaState.stream?.close();
  cinemaState.stream = null;
  cinemaState.pendingLoadShow = null;
  cinemaState.pendingLoadInspection = null;
  cinemaState.pendingSeekTarget = null;
  cinemaState.pendingExitScheduleRuntime = null;
  cinemaState.automationLabels = [];
  cinemaState.selectedAutomationLabel = "";
  cinemaState.playbackSample = null;
  cinemaState.playbackUiOverride = null;
  cinemaState.scheduleMonitorExitBusy = false;
  cinemaState.isSeeking = false;
  cinemaState.controlPanelBusy = false;
  cinemaState.controlPanelBusyText = "正在处理...";
  cinemaState.selectedTimepointId = "";
  cinemaState.scheduleStatus = createEmptyScheduleStatus();
  stopInterpolationTicker();
  stopScheduleStatusPolling();
  if (cinemaListeners.documentPointerDown) {
    document.removeEventListener("pointerdown", cinemaListeners.documentPointerDown);
    cinemaListeners.documentPointerDown = null;
  }
}

async function loadSelectedHall() {
  const halls = await getRuntimeHalls();
  const hallId = decodeURIComponent(window.location.hash.split("/")[2] || "");

  cinemaState.selectedHallId = hallId || null;
  cinemaState.selectedHall = halls.find((hall) => hall.registration.hallId === hallId) || null;
  cinemaState.shows = hallId ? appState.cinemaShowsCache.get(hallId) || [] : [];
  syncAutomationLabelsFromHall();
  cinemaState.loadedShowInspection = null;
  cinemaState.pendingLoadShow = null;
  cinemaState.pendingLoadInspection = null;
  cinemaState.pendingSeekTarget = null;
  cinemaState.pendingExitScheduleRuntime = null;
  cinemaState.playbackUiOverride = null;
  cinemaState.scheduleMonitorExitBusy = false;
  cinemaState.selectedTimepointId = "";
  cinemaState.scheduleStatus = createEmptyScheduleStatus();
  syncSelectedShow();
}

function cacheCinemaDom() {
  cinemaDom.root = document.getElementById("cinemaControlPage");
  cinemaDom.emptyState = document.getElementById("cinemaEmptyState");
  cinemaDom.hallInfo = document.getElementById("cinemaHallInfo");
  cinemaDom.error = document.getElementById("cinemaControlError");
  cinemaDom.playbackCard = document.querySelector(".cinema-playback-card");
  cinemaDom.scheduleStatusPanel = document.getElementById("cinemaScheduleStatusPanel");
  cinemaDom.controlBusyMask = document.getElementById("cinemaControlBusyMask");
  cinemaDom.controlBusyText = cinemaDom.controlBusyMask?.querySelector('[data-role="control-busy-text"]') || null;
  cinemaDom.showPickerDropdown = document.querySelector(".cinema-show-picker-dropdown");
  cinemaDom.showList = document.getElementById("cinemaShowPickerList");
  cinemaDom.loadedCplList = document.getElementById("cinemaLoadedCplList");
  cinemaDom.automationSelect = document.getElementById("cinemaAutomationSelect");
  cinemaDom.playbackSlider = document.querySelector("[data-playback-slider]");
  cinemaDom.progressMarkers = document.getElementById("cinemaProgressMarkers");
  cinemaDom.timepointList = document.getElementById("cinemaTimepointList");
  cinemaDom.timepointSummary = document.getElementById("cinemaTimepointSummary");
  cinemaDom.seekPreview = document.getElementById("cinemaSeekPreview");
  cinemaDom.loadDialog = document.getElementById("cinemaLoadDialog");
  cinemaDom.loadDialogList = document.getElementById("cinemaLoadDialogList");
  cinemaDom.seekDialog = document.getElementById("cinemaSeekDialog");
  cinemaDom.seekInput = document.querySelector("[data-seek-input]");
  cinemaDom.exitScheduleDialog = document.getElementById("cinemaExitScheduleDialog");
  cinemaDom.showItemTemplate = document.getElementById("cinemaShowItemTemplate");
  cinemaDom.cplItemTemplate = document.getElementById("cinemaCplItemTemplate");

  cinemaDom.fields = mapFieldNodes([
    "hall-name",
    "hall-id",
    "gdc-state",
    "projector-state",
    "server-model",
    "server-serial",
    "server-ip-list",
    "software-version",
    "firmware-version",
    "storage-total",
    "storage-free",
    "playback-state",
    "loaded-show-title",
    "control-unavailable-reason",
    "automation-unavailable-reason",
    "current-cpl-badge",
    "played-timecode",
  ]);

  cinemaDom.loadDialogFields = mapDialogFieldNodes(["show-title"]);
  cinemaDom.seekDialogFields = mapDialogFieldNodes(["seek-current-info"]);
  cinemaDom.exitScheduleDialogFields = mapDialogFieldNodes(["exit-schedule-title", "exit-schedule-meta"]);
}

function mapFieldNodes(names) {
  return Object.fromEntries(
    names.map((name) => [name, document.querySelector(`[data-field="${name}"]`)]),
  );
}

function mapDialogFieldNodes(names) {
  return Object.fromEntries(
    names.map((name) => [name, document.querySelector(`[data-dialog="${name}"]`)]),
  );
}

function bindCinemaEvents() {
  const root = document.getElementById("cinemaControlPage");
  if (!root || root.dataset.bound === "true") {
    return;
  }

  root.dataset.bound = "true";

  root.addEventListener("click", async (event) => {
    const target = event.target.closest(
      "[data-refresh-runtime], [data-refresh-shows], [data-refresh-automations], [data-trigger-automation], [data-show-item], [data-cinema-action], [data-offset-seconds], [data-exit-schedule-monitoring], [data-dialog-close], [data-dialog-confirm], [data-seek-adjust], [data-timepoint-select], [data-timepoint-jump]",
    );
    if (!target) {
      return;
    }

    if (target.dataset.timepointJump) {
      openTimepointSeekDialog(target.dataset.timepointJump, target.dataset.timepointEdge || "start");
      return;
    }

    if (target.dataset.timepointSelect) {
      selectTimepoint(target.dataset.timepointSelect);
      return;
    }

    if (target.dataset.dialogClose !== undefined) {
      closeDialogs();
      return;
    }

    if (target.dataset.dialogConfirm === "load-show") {
      await confirmLoadShow(target);
      return;
    }

    if (target.dataset.dialogConfirm === "seek") {
      await confirmSeek(target);
      return;
    }

    if (target.dataset.dialogConfirm === "exit-schedule-monitoring") {
      await confirmExitScheduleMonitoring(target);
      return;
    }

    if (target.dataset.seekAdjust !== undefined) {
      adjustSeekTarget(Number(target.dataset.seekAdjust));
      return;
    }

    if (!cinemaState.selectedHallId) {
      return;
    }

    if (target.dataset.refreshRuntime !== undefined) {
      await withBusyButton(target, async () => {
        await refreshSelectedHall(true);
        await hydrateLoadedShowInspection(true);
        clearCinemaError();
        renderAll();
      }, "刷新影厅信息失败。");
      return;
    }

    if (target.dataset.refreshShows !== undefined) {
      await loadShows(cinemaState.selectedHallId, true);
      syncSelectedShow();
      await hydrateLoadedShowInspection();
      renderShowList();
      renderPlaybackInfo();
      return;
    }

    if (target.dataset.refreshAutomations !== undefined) {
      await withBusyButton(target, async () => {
        await loadAutomationLabels(cinemaState.selectedHallId, true);
        clearCinemaError();
        renderAll();
      }, "刷新自动化指令失败。");
      return;
    }

    if (target.dataset.triggerAutomation !== undefined) {
      await runAutomation(target);
      return;
    }

    if (target.dataset.exitScheduleMonitoring) {
      openExitScheduleDialog(target.dataset.exitScheduleMonitoring);
      return;
    }

    if (target.dataset.showItem) {
      setShowPickerOpen(false);
      await openLoadShowDialog(target.dataset.showItem);
      return;
    }

    if (target.dataset.offsetSeconds !== undefined) {
      await runMovePlayback({ offset: Number(target.dataset.offsetSeconds) }, target);
      return;
    }

    if (target.dataset.cinemaAction) {
      await runControlAction(target.dataset.cinemaAction, target);
    }
  });

  cinemaListeners.documentPointerDown = (event) => {
    if (!cinemaDom.showPickerDropdown) {
      return;
    }

    const target = event.target;
    if (target instanceof Node && !cinemaDom.showPickerDropdown.contains(target)) {
      setShowPickerOpen(false);
    }
  };
  document.addEventListener("pointerdown", cinemaListeners.documentPointerDown);

  root.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      setShowPickerOpen(false);
    }
  });

  root.addEventListener("pointerdown", (event) => {
    if (cinemaState.controlPanelBusy) {
      return;
    }

    const slider = event.target.closest("[data-playback-slider]");
    if (!slider) {
      return;
    }

    cinemaState.isSeeking = true;
    const value = clampSeconds(Number(slider.value), 0, getPlayedTotal());
    cinemaState.pendingSeekTarget = value;
    updateSeekPreview(value, true);
  });

  root.addEventListener("pointerup", (event) => {
    if (cinemaState.controlPanelBusy) {
      return;
    }

    const slider = event.target.closest("[data-playback-slider]");
    if (!slider) {
      return;
    }
    cinemaState.isSeeking = false;
    hideSeekPreview();
  });

  root.addEventListener("pointercancel", (event) => {
    if (cinemaState.controlPanelBusy) {
      return;
    }

    const slider = event.target.closest("[data-playback-slider]");
    if (!slider) {
      return;
    }
    cinemaState.isSeeking = false;
    hideSeekPreview();
  });

  root.addEventListener("input", (event) => {
    if (cinemaState.controlPanelBusy) {
      return;
    }

    const slider = event.target.closest("[data-playback-slider]");
    const seekInput = event.target.closest("[data-seek-input]");

    if (slider) {
      cinemaState.isSeeking = true;
      cinemaState.pendingSeekTarget = clampSeconds(Number(slider.value), 0, getPlayedTotal());
      updateSeekPreview(cinemaState.pendingSeekTarget, true);
      return;
    }

    if (seekInput) {
      const parsed = parseClockTime(seekInput.value);
      const valid = parsed !== null;
      seekInput.classList.toggle("input-error", !valid);
      if (valid) {
        cinemaState.pendingSeekTarget = clampSeconds(parsed, 0, getPlayedTotal());
      }
    }
  });

  root.addEventListener("change", (event) => {
    const automationSelect = event.target.closest("#cinemaAutomationSelect");
    if (automationSelect) {
      cinemaState.selectedAutomationLabel = automationSelect.value;
      renderAutomationPanel();
      return;
    }

    const slider = event.target.closest("[data-playback-slider]");
    if (!slider || !cinemaState.selectedHall || !canControl() || cinemaState.controlPanelBusy) {
      return;
    }

    cinemaState.isSeeking = false;
    cinemaState.pendingSeekTarget = clampSeconds(Number(slider.value), 0, getPlayedTotal());
    hideSeekPreview();
    openSeekDialog();
  });
}

function connectHallStream(hallId) {
  cinemaState.stream?.close();
  cinemaState.stream = openEventStream(`/api/runtime/halls/${encodeURIComponent(hallId)}/stream`);

  cinemaState.stream.addEventListener("bootstrap", (event) => {
    const payload = parseSseData(event.data);
    const hall = payload?.halls?.[0];
    if (hall) {
      void applyIncomingHallRecord(hall);
    }
  });

  cinemaState.stream.addEventListener("snapshot", (event) => {
    const payload = parseSseData(event.data);
    if (payload) {
      void applyIncomingHallRecord(payload);
    }
  });
}

async function applyIncomingHallRecord(record) {
  const isSelectedHall = record?.registration?.hallId === cinemaState.selectedHallId;
  const wasOnline = isHallRuntimeOnline();
  updateHallRecord(record);
  syncAutomationLabelsFromHall();
  syncSelectedShow();
  renderAll();
  if (isSelectedHall && !wasOnline && isHallRuntimeOnline()) {
    void hydrateShowListForCurrentHall(true);
  }
  void hydrateLoadedShowInspection();
}

function updateHallRecord(record) {
  const hallsPromise = appState.runtimeHallsCache;
  if (hallsPromise) {
    appState.runtimeHallsCache = hallsPromise.then((halls) => {
      const next = [...halls];
      const index = next.findIndex((hall) => hall.registration.hallId === record.registration.hallId);
      if (index >= 0) {
        next[index] = record;
      } else {
        next.push(record);
      }
      return next;
    });
  }

  if (cinemaState.selectedHallId === record.registration.hallId) {
    cinemaState.selectedHall = record;
    syncAutomationLabelsFromHall();
  }
}

function syncAutomationLabelsFromHall() {
  const labels = Array.isArray(cinemaState.selectedHall?.snapshot?.automation?.labels)
    ? cinemaState.selectedHall.snapshot.automation.labels
    : [];

  cinemaState.automationLabels = [...labels];
  if (!cinemaState.automationLabels.includes(cinemaState.selectedAutomationLabel)) {
    cinemaState.selectedAutomationLabel = cinemaState.automationLabels[0] || "";
  }
}

async function loadShows(hallId, force = false) {
  if (!isHallRuntimeOnline()) {
    cinemaState.shows = appState.cinemaShowsCache.get(hallId) || [];
    return;
  }

  if (!force && appState.cinemaShowsCache.has(hallId)) {
    cinemaState.shows = appState.cinemaShowsCache.get(hallId);
    return;
  }

  const result = await apiPost(`/api/runtime/halls/${encodeURIComponent(hallId)}/shows`, {});
  cinemaState.shows = Array.isArray(result.shows) ? result.shows : [];
  appState.cinemaShowsCache.set(hallId, cinemaState.shows);
}

async function loadShowInspection(hallId, showUuid) {
  if (!isHallRuntimeOnline()) {
    return null;
  }

  const result = await apiPost(
    `/api/runtime/halls/${encodeURIComponent(hallId)}/shows/${encodeURIComponent(showUuid)}/cpls`,
    {},
  );
  return result.inspection || null;
}

async function loadAutomationLabels(hallId, force = false) {
  if (!hallId) {
    cinemaState.automationLabels = [];
    cinemaState.selectedAutomationLabel = "";
    return;
  }

  if (!isHallRuntimeOnline()) {
    cinemaState.automationLabels = Array.isArray(cinemaState.selectedHall?.snapshot?.automation?.labels)
      ? [...cinemaState.selectedHall.snapshot.automation.labels]
      : [];
    cinemaState.selectedAutomationLabel = cinemaState.automationLabels[0] || "";
    return;
  }

  if (!force && cinemaState.automationLabels.length > 0) {
    return;
  }

  const result = await apiPost(`/api/runtime/halls/${encodeURIComponent(hallId)}/automations`, { force });
  cinemaState.automationLabels = Array.isArray(result.automationLabels) ? result.automationLabels : [];

  if (!cinemaState.automationLabels.includes(cinemaState.selectedAutomationLabel)) {
    cinemaState.selectedAutomationLabel = cinemaState.automationLabels[0] || "";
  }
}

async function hydrateLoadedShowInspection(force = false) {
  if (!cinemaState.selectedHallId) {
    return;
  }

  if (!isHallRuntimeOnline()) {
    cinemaState.loadedShowInspection = null;
    renderLoadedCplList();
    renderPlaybackInfo();
    renderTimepointNavigation();
    return;
  }

  const loadedShowUuid = getLoadedShowUuid();
  if (!loadedShowUuid) {
    cinemaState.loadedShowInspection = null;
    renderLoadedCplList();
    renderPlaybackInfo();
    renderTimepointNavigation();
    return;
  }

  if (!force && cinemaState.loadedShowInspection?.showUuid === loadedShowUuid) {
    return;
  }

  if (cinemaState.loadedShowInspection?.showUuid !== loadedShowUuid) {
    cinemaState.loadedShowInspection = null;
    renderTimepointNavigation();
  }
  cinemaState.loadedShowInspection = await loadShowInspection(cinemaState.selectedHallId, loadedShowUuid).catch(() => null);
  renderLoadedCplList();
  renderPlaybackInfo();
  renderTimepointNavigation();
}

async function hydrateCinemaSecondaryData(hallId) {
  if (!isHallRuntimeOnline()) {
    cinemaState.shows = appState.cinemaShowsCache.get(hallId) || [];
    cinemaState.loadedShowInspection = null;
    syncSelectedShow();
    renderAll();
    return;
  }

  await loadShows(hallId, true).catch(() => {
    cinemaState.shows = [];
  });
  syncSelectedShow();
  renderShowList();
  renderPlaybackInfo();

  await loadAutomationLabels(hallId).catch(() => {
    cinemaState.automationLabels = [];
    cinemaState.selectedAutomationLabel = "";
  });
  renderAutomationPanel();

  await hydrateLoadedShowInspection().catch(() => undefined);
  renderAll();
}

async function hydrateShowListForCurrentHall(force = false) {
  const hallId = cinemaState.selectedHallId;
  if (!hallId) {
    return;
  }

  try {
    await loadShows(hallId, force);
    if (cinemaState.selectedHallId !== hallId) {
      return;
    }
    syncSelectedShow();
    renderShowList();
    renderPlaybackInfo();
  } catch (error) {
    console.warn("Failed to load hall show list:", error);
  }
}

function createEmptyScheduleStatus() {
  return {
    showDate: "",
    runtimes: [],
    actions: [],
    entries: [],
    loadedAt: 0,
  };
}

function startScheduleStatusPolling() {
  stopScheduleStatusPolling();
  cinemaState.scheduleStatusTimer = window.setInterval(() => {
    void loadScheduleStatus();
  }, SCHEDULE_STATUS_REFRESH_MS);
}

function stopScheduleStatusPolling() {
  if (cinemaState.scheduleStatusTimer) {
    window.clearInterval(cinemaState.scheduleStatusTimer);
    cinemaState.scheduleStatusTimer = null;
  }
}

async function loadScheduleStatus() {
  if (!cinemaState.selectedHallId) {
    cinemaState.scheduleStatus = createEmptyScheduleStatus();
    renderScheduleStatusPanel();
    return;
  }

  const showDate = formatLocalDate(new Date());
  try {
    const [statusPayload, entriesPayload] = await Promise.all([
      apiGet(`/api/film-scheduler/status?date=${encodeURIComponent(showDate)}`),
      apiGet(`/api/film-schedule/entries?date=${encodeURIComponent(showDate)}`),
    ]);

    cinemaState.scheduleStatus = {
      showDate,
      runtimes: Array.isArray(statusPayload.runtimes) ? statusPayload.runtimes : [],
      actions: Array.isArray(statusPayload.actions) ? statusPayload.actions : [],
      entries: Array.isArray(entriesPayload.entries) ? entriesPayload.entries : [],
      loadedAt: Date.now(),
    };
    renderScheduleStatusPanel();
    renderTimepointNavigation();
  } catch (error) {
    console.warn("Failed to load film scheduler status:", error);
  }
}

function syncSelectedShow() {
  const loadedShowUuid = getLoadedShowUuid();
  if (loadedShowUuid) {
    cinemaState.selectedShowUuid = loadedShowUuid;
    return;
  }

  if (cinemaState.selectedShowUuid && cinemaState.shows.some((show) => show.showUuid === cinemaState.selectedShowUuid)) {
    return;
  }

  cinemaState.selectedShowUuid = cinemaState.shows[0]?.showUuid || "";
}

function isOptimisticPlaybackAction(action) {
  return action === "play" || action === "resume" || action === "pause" || action === "stop";
}

function isControlPanelBusyAction(action) {
  return action === "previous-cpl" || action === "next-cpl";
}

function setControlPanelBusy(busy, text = "正在处理...") {
  cinemaState.controlPanelBusy = busy;
  cinemaState.controlPanelBusyText = text;
  if (busy) {
    setShowPickerOpen(false);
  }
}

function setPlaybackUiOverride(state, played, total) {
  cinemaState.playbackUiOverride = {
    state,
    played,
    total,
    affectsTime: true,
    appliedAt: Date.now(),
  };
}

function resolvePlaybackUiOverride(actualState) {
  const override = cinemaState.playbackUiOverride;
  if (!override) {
    return null;
  }

  if (normalizePlaybackState(actualState) === normalizePlaybackState(override.state)) {
    cinemaState.playbackUiOverride = null;
    return null;
  }

  if ((Date.now() - override.appliedAt) > 4_000) {
    cinemaState.playbackUiOverride = null;
    return null;
  }

  return override;
}

function applyOptimisticPlaybackAction(action) {
  const currentPlayed = getInterpolatedPlayedSeconds();
  const total = cinemaState.playbackSample?.total || getPlayedTotal();

  if (action === "play" || action === "resume") {
    cinemaState.playbackUiOverride = {
      state: "PLAYING",
      played: currentPlayed,
      total,
      affectsTime: false,
      appliedAt: Date.now(),
    };
    return;
  }

  if (action === "pause") {
    setPlaybackUiOverride("PAUSED", currentPlayed, total);
    return;
  }

  if (action === "stop") {
    setPlaybackUiOverride("STOPPED", 0, total);
  }
}

function isSeekDialogActive() {
  return Boolean(cinemaDom.seekDialog?.open && cinemaState.pendingSeekTarget !== null);
}

async function runControlAction(action, button) {
  if (!canControl()) {
    renderCinemaError(getControlUnavailableReason() || "当前不可控制。");
    return;
  }

  if (isControlPanelBusyAction(action)) {
    await withControlPanelBusy(async () => {
      await apiPost(`/api/runtime/halls/${encodeURIComponent(cinemaState.selectedHallId)}/control/${action}`, {});
      await refreshSelectedHall();
      await hydrateLoadedShowInspection(true);
    }, "正在切换 CPL...", "播放控制执行失败。");
    return;
  }

  if (isOptimisticPlaybackAction(action)) {
    const wasDisabled = button.disabled;
    button.disabled = true;

    try {
      const result = await apiPost(`/api/runtime/halls/${encodeURIComponent(cinemaState.selectedHallId)}/control/${action}`, {});

      if (result?.hall) {
        updateHallRecord(result.hall);
        syncSelectedShow();
      }

      applyOptimisticPlaybackAction(action);
      clearCinemaError();
      renderAll();

      await refreshSelectedHall();
      await hydrateLoadedShowInspection(true);
      renderAll();
    } catch (error) {
      cinemaState.playbackUiOverride = null;
      renderAll();
      renderCinemaError(error instanceof Error ? error.message : "播放控制执行失败。");
    } finally {
      button.disabled = wasDisabled;
    }
    return;
  }

  await withBusyButton(button, async () => {
    await apiPost(`/api/runtime/halls/${encodeURIComponent(cinemaState.selectedHallId)}/control/${action}`, {});
    await refreshSelectedHall();
    await hydrateLoadedShowInspection(true);
    clearCinemaError();
    renderAll();
  }, "播放控制执行失败。");
}

async function runMovePlayback(payload, button) {
  if (!canControl()) {
    renderCinemaError(getControlUnavailableReason() || "当前不可控制。");
    return;
  }

  await withControlPanelBusy(async () => {
    await apiPost(`/api/runtime/halls/${encodeURIComponent(cinemaState.selectedHallId)}/control/move-playback`, payload);
    await refreshSelectedHall();
  }, "正在调整播放进度...", "调整播放位置失败。");
}

async function runAutomation(button) {
  if (!canTriggerAutomation()) {
    renderCinemaError(getAutomationUnavailableReason() || "当前不可执行自动化指令。");
    return;
  }

  const eventLabel = cinemaState.selectedAutomationLabel || cinemaDom.automationSelect?.value || "";
  if (!eventLabel) {
    renderCinemaError("请先选择自动化指令。");
    return;
  }

  await withBusyButton(button, async () => {
    await apiPost(`/api/runtime/halls/${encodeURIComponent(cinemaState.selectedHallId)}/control/trigger-automation`, {
      eventLabel,
    });
    await refreshSelectedHall();
    await hydrateLoadedShowInspection(true);
    clearCinemaError();
    renderAll();
    toast.success(`已执行命令“${eventLabel}”`, { title: "命令已执行" });
  }, "执行自动化指令失败。");
}

function openExitScheduleDialog(scheduleId) {
  const runtime = cinemaState.scheduleStatus.runtimes.find((item) => item.scheduleId === scheduleId);
  if (!runtime || !ACTIVE_SCHEDULE_STATUSES.has(runtime.status)) {
    renderCinemaError("当前没有可退出监控的排程。");
    return;
  }

  cinemaState.pendingExitScheduleRuntime = runtime;
  renderExitScheduleDialog();
  cinemaDom.exitScheduleDialog?.showModal?.();
}

async function confirmExitScheduleMonitoring(button) {
  const runtime = cinemaState.pendingExitScheduleRuntime;
  if (!runtime || !cinemaState.selectedHallId) {
    return;
  }

  button.disabled = true;
  cinemaState.scheduleMonitorExitBusy = true;
  renderExitScheduleDialog();

  try {
    const result = await apiPost(
      `/api/film-scheduler/schedules/${encodeURIComponent(runtime.scheduleId)}/exit-monitoring`,
      {
        hallId: cinemaState.selectedHallId,
        reason: "已人工退出排程监控，后续自动化动作将不会执行。",
      },
    );

    if (result?.runtime) {
      cinemaState.scheduleStatus.runtimes = cinemaState.scheduleStatus.runtimes.map((item) => (
        item.scheduleId === result.runtime.scheduleId ? result.runtime : item
      ));
    }

    clearCinemaError();
    toast.success("已退出当前排程监控，后续自动化动作将不会执行。", { title: "排程已退出" });
    closeDialogs();
    renderScheduleStatusPanel();
    await loadScheduleStatus();
  } catch (error) {
    renderCinemaError(error instanceof Error ? error.message : "退出排程监控失败。");
    renderExitScheduleDialog();
  } finally {
    cinemaState.scheduleMonitorExitBusy = false;
    button.disabled = false;
    renderExitScheduleDialog();
  }
}

async function withBusyButton(button, action, fallbackMessage) {
  button.disabled = true;
  const original = button.innerHTML;
  button.innerHTML = '<span class="loading loading-spinner loading-sm"></span>';

  try {
    await action();
  } catch (error) {
    renderCinemaError(error instanceof Error ? error.message : fallbackMessage);
  } finally {
    button.disabled = false;
    button.innerHTML = original;
  }
}

async function withControlPanelBusy(action, busyText, fallbackMessage) {
  setControlPanelBusy(true, busyText);
  renderAll();

  try {
    await action();
    clearCinemaError();
  } catch (error) {
    renderCinemaError(error instanceof Error ? error.message : fallbackMessage);
  } finally {
    setControlPanelBusy(false);
    renderAll();
  }
}

async function openLoadShowDialog(showUuid) {
  if (!cinemaState.selectedHallId) {
    return;
  }

  if (showUuid === getLoadedShowUuid()) {
    return;
  }

  const show = cinemaState.shows.find((item) => item.showUuid === showUuid);
  if (!show) {
    return;
  }

  cinemaState.selectedShowUuid = show.showUuid;
  cinemaState.pendingLoadShow = show;
  cinemaState.pendingLoadInspection = null;
  renderShowList();
  renderLoadDialog();

  if (!cinemaDom.loadDialog.open) {
    cinemaDom.loadDialog.showModal();
  }

  try {
    cinemaState.pendingLoadInspection = await loadShowInspection(cinemaState.selectedHallId, show.showUuid);
    clearCinemaError();
  } catch (error) {
    renderCinemaError(error instanceof Error ? error.message : "加载放映表校验信息失败。");
  }

  renderLoadDialog();
}

async function confirmLoadShow(button) {
  if (!cinemaState.pendingLoadShow || !canControl()) {
    renderCinemaError("当前条件不允许载入放映表。");
    return;
  }

  button.disabled = true;

  try {
    if (!cinemaState.pendingLoadInspection) {
      cinemaState.pendingLoadInspection = await loadShowInspection(
        cinemaState.selectedHallId,
        cinemaState.pendingLoadShow.showUuid,
      );
    }

    if (!cinemaState.pendingLoadInspection?.allValid) {
      throw new Error("所选放映表存在未通过校验的 CPL，无法载入。");
    }

    await apiPost(`/api/runtime/halls/${encodeURIComponent(cinemaState.selectedHallId)}/control/load-show`, {
      showUuid: cinemaState.pendingLoadShow.showUuid,
    });
    await refreshSelectedHall();
    await hydrateLoadedShowInspection(true);
    clearCinemaError();
    closeDialogs();
    renderAll();
  } catch (error) {
    renderCinemaError(error instanceof Error ? error.message : "载入放映表失败。");
    renderLoadDialog();
  } finally {
    button.disabled = false;
  }
}

function openSeekDialog() {
  renderSeekDialog();
  cinemaDom.seekDialog?.showModal?.();
}

async function confirmSeek(button) {
  if (!cinemaState.selectedHall || cinemaState.pendingSeekTarget === null) {
    return;
  }

  const parsedTarget = parseClockTime(cinemaDom.seekInput?.value || "");
  if (parsedTarget === null) {
    cinemaDom.seekInput?.classList.add("input-error");
    renderCinemaError("\u8bf7\u8f93\u5165 hh:mm:ss \u683c\u5f0f\u7684\u65f6\u95f4\u3002");
    return;
  }

  const target = clampSeconds(parsedTarget, 0, getPlayedTotal());
  cinemaState.pendingSeekTarget = target;
  closeDialogs();
  await runMovePlayback({ absolute: formatFrameTimecode(target) }, button);
}

function closeDialogs() {
  safeCloseDialog(cinemaDom.loadDialog);
  safeCloseDialog(cinemaDom.seekDialog);
  safeCloseDialog(cinemaDom.exitScheduleDialog);
  setShowPickerOpen(false);
  cinemaState.pendingLoadShow = null;
  cinemaState.pendingLoadInspection = null;
  cinemaState.pendingSeekTarget = null;
  cinemaState.pendingExitScheduleRuntime = null;
  cinemaState.isSeeking = false;
  hideSeekPreview();
  renderDialogs();
  renderPlaybackInfo();
  renderShowList();
}

async function refreshSelectedHall(forceRefresh = false) {
  const fresh = forceRefresh
    ? await apiPost(`/api/runtime/halls/${encodeURIComponent(cinemaState.selectedHallId)}/refresh`, {})
    : await apiGet(`/api/runtime/halls/${encodeURIComponent(cinemaState.selectedHallId)}`);
  if (fresh.hall) {
    updateHallRecord(fresh.hall);
    syncSelectedShow();
  }
}

function canControl() {
  const hall = cinemaState.selectedHall;
  if (!hall) {
    return false;
  }

  return (
    hall.snapshot.connectivity?.state === "online"
    && hall.snapshot.serverInfo?.projectorStatus?.connectionState === "Connected"
  );
}

function isHallRuntimeOnline() {
  return cinemaState.selectedHall?.snapshot.connectivity?.state === "online";
}

function canTriggerAutomation() {
  const hall = cinemaState.selectedHall;
  if (!hall) {
    return false;
  }

  return (
    hall.snapshot.connectivity?.state === "online"
    && hall.snapshot.serverInfo?.projectorStatus?.connectionState === "Connected"
  );
}

function canOperatePlayback() {
  return canControl() && Boolean(getLoadedShowUuid());
}

function canGoPreviousCpl() {
  const currentIndex = getCurrentCplIndex();
  return canOperatePlayback() && currentIndex > 0;
}

function canGoNextCpl() {
  const currentIndex = getCurrentCplIndex();
  const cplCount = cinemaState.loadedShowInspection?.cpls?.length || 0;
  return canOperatePlayback() && currentIndex >= 0 && currentIndex < cplCount - 1;
}

function getControlUnavailableReason() {
  const hall = cinemaState.selectedHall;
  if (!hall) {
    return "请先选择影厅。";
  }

  if (hall.snapshot.connectivity?.state !== "online") {
    return describeConnectivityUnavailableReason(hall.snapshot.connectivity?.state, "播放控制");
  }

  if (hall.snapshot.serverInfo?.projectorStatus?.connectionState !== "Connected") {
    return "放映机未连接，播放控制已禁用。";
  }

  if (!getLoadedShowUuid()) {
    return "未载入放映表，播放控制已禁用。";
  }

  return "";
}

function getAutomationUnavailableReason() {
  const hall = cinemaState.selectedHall;
  if (!hall) {
    return "请先选择影厅。";
  }

  if (hall.snapshot.connectivity?.state !== "online") {
    return describeConnectivityUnavailableReason(hall.snapshot.connectivity?.state, "自动化指令");
  }

  if (hall.snapshot.serverInfo?.projectorStatus?.connectionState !== "Connected") {
    return "放映机未连接，自动化指令已禁用。";
  }

  return "";
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

function describeProjectorConnectionState(state) {
  if (state === "Connected" || state === "已连接") {
    return "已连接";
  }
  if (state === "Disconnected" || state === "未连接") {
    return "未连接";
  }
  return "未知";
}

function describeConnectivityUnavailableReason(state, capability) {
  if (!state || state === "unknown") {
    return `放映服务器连接状态尚未确认，${capability}已禁用。`;
  }
  return `放映服务器离线，${capability}已禁用。`;
}

function getLoadedShowUuid() {
  const showUuid = cinemaState.selectedHall?.snapshot.playback?.status?.showUuid;
  if (!showUuid || showUuid === EMPTY_SHOW_UUID) {
    return "";
  }
  return showUuid;
}

function getLoadedShowTitle() {
  const playback = cinemaState.selectedHall?.snapshot.playback?.status;
  const loadedShowUuid = getLoadedShowUuid();
  return playback?.showName
    || cinemaState.shows.find((show) => show.showUuid === loadedShowUuid)?.title
    || "";
}

function getCurrentCplIndex() {
  const playback = cinemaState.selectedHall?.snapshot.playback?.status;
  const index = playback?.cplPosition?.cplIndex;
  if (Number.isInteger(index)) {
    return index;
  }

  const currentCplUuid = playback?.cplUuid;
  if (currentCplUuid && cinemaState.loadedShowInspection?.cpls?.length) {
    return cinemaState.loadedShowInspection.cpls.findIndex((item) => item.cplUuid === currentCplUuid);
  }

  return -1;
}

function getTimelineDurations(playbackStatus) {
  const cpl = playbackStatus?.cplPosition || {};
  const show = playbackStatus?.showPosition || {};

  const total = safeNumber(cpl.totalDuration, safeNumber(show.totalDuration, 0));
  const played = safeNumber(cpl.playedDuration, safeNumber(show.playedDuration, 0));

  return {
    total: clampSeconds(total, 0, Number.MAX_SAFE_INTEGER),
    played: clampSeconds(played, 0, Number.MAX_SAFE_INTEGER),
  };
}

function getPlayedTotal() {
  const playback = cinemaState.selectedHall?.snapshot.playback?.status;
  return getTimelineDurations(playback).total;
}

function renderAll() {
  renderVisibility();
  renderHallInfo();
  renderScheduleStatusPanel();
  renderPlaybackInfo();
  renderTimepointNavigation();
  renderAutomationPanel();
  renderControlBusyState();
  renderLoadedCplList();
  renderShowList();
  renderDialogs();
}

function renderControlBusyState() {
  cinemaDom.playbackCard?.classList.toggle("is-busy", cinemaState.controlPanelBusy);
  cinemaDom.controlBusyMask?.classList.toggle("hidden", !cinemaState.controlPanelBusy);
  if (cinemaDom.controlBusyText) {
    cinemaDom.controlBusyText.textContent = cinemaState.controlPanelBusyText;
  }
}

function renderVisibility() {
  const hasHall = Boolean(cinemaState.selectedHall);
  const shouldShowEmptyState = !cinemaState.selectedHallId;
  cinemaDom.emptyState?.classList.toggle("hidden", !shouldShowEmptyState);
  cinemaDom.hallInfo?.classList.toggle("hidden", !hasHall);
  if (cinemaDom.emptyState) {
    cinemaDom.emptyState.innerHTML = shouldShowEmptyState
      ? '<i class="fas fa-circle-info"></i><span>请先从左侧选择一个影厅。</span>'
      : "";
  }
}

function renderAutomationPanel() {
  const reason = getAutomationUnavailableReason();
  setText("automation-unavailable-reason", reason || "自动化指令将直接发送到当前 GDC。");

  if (cinemaDom.automationSelect) {
    cinemaDom.automationSelect.replaceChildren();

    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = cinemaState.selectedHall ? "请选择自动化指令" : "请先选择影厅";
    cinemaDom.automationSelect.appendChild(placeholder);

    for (const label of cinemaState.automationLabels) {
      const option = document.createElement("option");
      option.value = label;
      option.textContent = label;
      cinemaDom.automationSelect.appendChild(option);
    }

    cinemaDom.automationSelect.value = cinemaState.selectedAutomationLabel || "";
    cinemaDom.automationSelect.disabled = cinemaState.controlPanelBusy || !canTriggerAutomation();
  }

  const triggerButton = cinemaDom.root?.querySelector("[data-trigger-automation]");
  if (triggerButton) {
    triggerButton.disabled =
      cinemaState.controlPanelBusy || !canTriggerAutomation() || !cinemaState.selectedAutomationLabel;
  }

  const refreshButton = cinemaDom.root?.querySelector("[data-refresh-automations]");
  if (refreshButton) {
    refreshButton.disabled = cinemaState.controlPanelBusy || !cinemaState.selectedHallId || !canTriggerAutomation();
  }
}

function renderHallInfo() {
  if (!cinemaState.selectedHall) {
    setText("hall-name", "-");
    setText("hall-id", "-");
    setStatusText("gdc-state", "-", false);
    setStatusText("projector-state", "-", false);
    setText("server-model", "-");
    setText("server-serial", "-");
    setText("server-ip-list", "-");
    setText("software-version", "-");
    setText("firmware-version", "-");
    setText("storage-total", "-");
    setText("storage-free", "-");
    return;
  }

  const hall = cinemaState.selectedHall;
  const info = hall.snapshot.serverInfo?.info || {};
  const ipList = hall.snapshot.serverInfo?.ipList?.ipAddresses || [];
  const storage = hall.snapshot.serverInfo?.storageInfo || {};
  const projectorStatus = hall.snapshot.serverInfo?.projectorStatus;
  const connectivityState = hall.snapshot.connectivity?.state;
  const isGdcOnline = connectivityState === "online";
  const projectorConnected = projectorStatus?.connectionState === "Connected";

  setText("hall-name", hall.registration.hallName || hall.registration.hallId);
  setText("hall-id", hall.registration.hallId);
  setStatusText("gdc-state", `GDC${describeConnectivityState(connectivityState)}`, isGdcOnline);
  setStatusText("projector-state", `放映机 ${describeProjectorConnectionState(projectorStatus?.connectionState)}`, projectorConnected);
  setText("server-model", info.model || "-");
  setText("server-serial", info.serial || "-");
  setText("server-ip-list", ipList.length > 0 ? ipList.join(" / ") : `${hall.registration.host}:${hall.registration.port}`);
  setText("software-version", info.version?.software || "-");
  setText("firmware-version", info.version?.firmware || "-");
  setText("storage-total", formatBytes(storage.totalSpace));
  setText("storage-free", formatBytes(storage.freeSpace));
}

function renderScheduleStatusPanel() {
  const panel = cinemaDom.scheduleStatusPanel;
  if (!panel) {
    return;
  }

  const active = getActiveScheduleRuntime();
  if (!active) {
    panel.classList.add("hidden");
    panel.innerHTML = "";
    return;
  }

  const entry = getScheduleEntry(active.scheduleId);
  const actions = getScheduleActions(active.scheduleId);
  const failedActionCount = actions.filter((action) => action.status === "failed").length;
  const successActionCount = actions.filter((action) => action.status === "success").length;
  const status = getScheduleStatusDisplay(active.status);
  const title = entry?.filmName || "当前排程";
  const startTime = entry?.startTime ? formatDateTimeShort(entry.startTime) : "--:--";
  const position = Number.isFinite(active.lastPositionSeconds) ? formatSeconds(active.lastPositionSeconds) : "--:--:--";
  const updatedAt = active.updatedAt ? formatDateTimeShort(active.updatedAt) : "--:--";
  const exitDisabled = cinemaState.scheduleMonitorExitBusy ? " disabled" : "";

  panel.className = `cinema-schedule-status is-${escapeAttr(status.tone)}`;
  panel.innerHTML = `
    <div class="cinema-schedule-status-row">
      <div class="cinema-schedule-status-main">
        <span class="cinema-schedule-status-icon"><i class="fas ${escapeAttr(status.icon)}"></i></span>
        <div class="cinema-schedule-status-copy">
          <div class="cinema-schedule-status-head">
            <strong>${escapeHtml(title)}</strong>
            <span>${escapeHtml(status.label)}</span>
          </div>
          <div class="cinema-schedule-status-meta">
            <span>开场 ${escapeHtml(startTime)}</span>
            <span>位置 ${escapeHtml(position)}</span>
            <span>动作 ${successActionCount} 成功 / ${failedActionCount} 失败</span>
            <span>更新 ${escapeHtml(updatedAt)}</span>
          </div>
        </div>
      </div>
      <button
        type="button"
        class="btn btn-outline btn-error btn-sm cinema-schedule-exit-button"
        data-exit-schedule-monitoring="${escapeAttr(active.scheduleId)}"
        title="退出当前排程监控"
        ${exitDisabled}
      >
        <i class="fas fa-right-from-bracket"></i>
        <span>退出排程</span>
      </button>
    </div>
    ${active.lastError ? `<p class="cinema-schedule-status-error">${escapeHtml(active.lastError)}</p>` : ""}
  `;
}

function getActiveScheduleRuntime() {
  const hallId = cinemaState.selectedHallId;
  if (!hallId) {
    return null;
  }

  const runtimes = cinemaState.scheduleStatus.runtimes
    .filter((runtime) => runtime.hallId === hallId && ACTIVE_SCHEDULE_STATUSES.has(runtime.status))
    .sort((left, right) => {
      const leftEntry = getScheduleEntry(left.scheduleId);
      const rightEntry = getScheduleEntry(right.scheduleId);
      return getScheduleRuntimeSortTime(left, leftEntry) - getScheduleRuntimeSortTime(right, rightEntry);
    });

  return runtimes[0] || null;
}

function getScheduleRuntimeSortTime(runtime, entry) {
  const parsed = Date.parse(entry?.startTime || runtime.updatedAt || "");
  return Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER;
}

function getScheduleEntry(scheduleId) {
  return cinemaState.scheduleStatus.entries.find((entry) => entry.id === scheduleId) || null;
}

function renderTimepointNavigation() {
  renderProgressMarkers();
  renderTimepointPanel();
}

function renderTimepointPanel() {
  if (!cinemaDom.timepointList) {
    return;
  }

  const items = getTimepointItems();
  if (cinemaState.selectedTimepointId && !items.some((item) => item.id === cinemaState.selectedTimepointId)) {
    cinemaState.selectedTimepointId = "";
  }

  const currentCplIndex = getCurrentCplIndex();
  const currentCplCount = items.filter((item) => isTimepointInCpl(item, currentCplIndex)).length;
  const scheduleCount = items.filter((item) => item.source === "schedule").length;
  const playlistCount = items.filter((item) => item.source === "playlist").length;
  const mismatch = hasScheduleShowMismatch();
  if (cinemaDom.timepointSummary) {
    cinemaDom.timepointSummary.textContent = mismatch
      ? `放映模板播放表与当前播放表不一致；共 ${items.length} 个时间点，时间点不可定位`
      : `影片放映模板 ${scheduleCount} 个 · 播放表 ${playlistCount} 个 · 当前 CPL ${currentCplCount} 个`;
  }

  if (items.length === 0) {
    const message = getLoadedShowUuid()
      ? "当前筛选条件下没有时间点。"
      : "载入播放表后显示命令标记；进入活动排期后显示模板时间点。";
    cinemaDom.timepointList.innerHTML = `<div class="cinema-timepoint-empty">${escapeHtml(message)}</div>`;
    return;
  }

  const currentPlayed = getInterpolatedPlayedSeconds();
  const previousScrollTop = cinemaDom.timepointList.scrollTop;
  cinemaDom.timepointList.innerHTML = items.map((item) => {
    const startTarget = getTimepointTarget(item, "start");
    const endTarget = getTimepointTarget(item, "end");
    const canJumpStart = canJumpToTimepointTarget(startTarget, currentCplIndex);
    const canJumpEnd = item.type === "range" && canJumpToTimepointTarget(endTarget, currentCplIndex);
    const isPast = Number.isInteger(endTarget.cplIndex)
      && (endTarget.cplIndex < currentCplIndex
        || (endTarget.cplIndex === currentCplIndex && endTarget.localSeconds < currentPlayed));
    const selected = item.id === cinemaState.selectedTimepointId;
    const sourceIcon = item.type === "range" ? "fa-arrows-left-right" : item.source === "schedule" ? "fa-calendar-day" : "fa-bolt";
    const rangeClass = item.type === "range" ? " is-range" : "";
    const actions = item.type === "range"
      ? `
        <div class="cinema-timepoint-actions">
          ${renderTimepointJumpButton(item, "start", canJumpStart, currentCplIndex, "定位开始")}
          ${renderTimepointJumpButton(item, "end", canJumpEnd, currentCplIndex, "定位结束")}
        </div>
      `
      : renderTimepointJumpButton(item, "start", canJumpStart, currentCplIndex, "定位");
    return `
      <div
        class="cinema-timepoint-item is-${escapeAttr(item.source)}${rangeClass}${selected ? " is-selected" : ""}${isPast ? " is-past" : ""}"
      >
        <button
          type="button"
          class="cinema-timepoint-select-button"
          data-timepoint-select="${escapeAttr(item.id)}"
          aria-pressed="${selected}"
        >
          <span class="cinema-timepoint-source-icon"><i class="fas ${sourceIcon}"></i></span>
          <span class="cinema-timepoint-copy">
            <span class="cinema-timepoint-title">${item.type === "range" ? '<span class="cinema-timepoint-type-badge">时间段</span>' : ""}${escapeHtml(item.label)}</span>
            <span class="cinema-timepoint-meta">${escapeHtml(formatTimepointMeta(item))}</span>
          </span>
        </button>
        ${actions}
      </div>
    `;
  }).join("");
  cinemaDom.timepointList.scrollTop = previousScrollTop;
}

function renderTimepointJumpButton(item, edge, canJump, currentCplIndex, label) {
  const target = getTimepointTarget(item, edge);
  const jumpReason = getTimepointJumpUnavailableReason(target, currentCplIndex);
  return `
    <button
      type="button"
      class="btn btn-xs ${canJump ? "btn-primary" : "btn-ghost"} cinema-timepoint-action"
      data-timepoint-jump="${escapeAttr(item.id)}"
      data-timepoint-edge="${escapeAttr(edge)}"
      title="${escapeAttr(canJump ? `${label}：${formatSeconds(target.localSeconds)}` : jumpReason)}"
      ${canJump ? "" : "disabled"}
    >${escapeHtml(label)}</button>
  `;
}

function renderProgressMarkers() {
  if (!cinemaDom.progressMarkers) {
    return;
  }

  const currentCplIndex = getCurrentCplIndex();
  const total = getPlayedTotal();
  if (currentCplIndex < 0 || total <= 0) {
    cinemaDom.progressMarkers.replaceChildren();
    return;
  }

  const items = getTimepointItems();
  const currentBoundary = getCplBoundaries()[currentCplIndex];
  const rangeBands = items.flatMap((item) => {
    if (item.type !== "range" || item.mappingUnavailable || !currentBoundary
      || !Number.isFinite(currentBoundary.start) || !Number.isFinite(currentBoundary.end)
      || !Number.isFinite(item.showSeconds) || !Number.isFinite(item.endSeconds)) {
      return [];
    }
    const overlapStart = Math.max(item.showSeconds, currentBoundary.start);
    const overlapEnd = Math.min(item.endSeconds, currentBoundary.end);
    if (overlapEnd <= overlapStart) {
      return [];
    }
    const localStart = clampSeconds(overlapStart - currentBoundary.start, 0, total);
    const localEnd = clampSeconds(overlapEnd - currentBoundary.start, 0, total);
    const left = clampSeconds((localStart / total) * 100, 0, 100);
    const width = clampSeconds(((localEnd - localStart) / total) * 100, 0, 100 - left);
    const selected = item.id === cinemaState.selectedTimepointId;
    const title = `${item.label} · 当前 CPL ${formatSeconds(localStart)}–${formatSeconds(localEnd)}`;
    return [`
      <button
        type="button"
        class="cinema-progress-range${selected ? " is-selected" : ""}"
        style="left:${left.toFixed(3)}%;width:${width.toFixed(3)}%"
        data-timepoint-select="${escapeAttr(item.id)}"
        title="${escapeAttr(title)}"
        aria-label="${escapeAttr(title)}"
      ></button>
    `];
  }).join("");

  const groups = new Map();
  for (const item of items) {
    if (item.type === "range") {
      continue;
    }
    if (item.cplIndex !== currentCplIndex || !Number.isFinite(item.localSeconds)) {
      continue;
    }
    const localSeconds = clampSeconds(item.localSeconds, 0, total);
    const key = String(Math.round(localSeconds));
    const group = groups.get(key) || { localSeconds, items: [] };
    group.items.push(item);
    groups.set(key, group);
  }

  const pointMarkers = [...groups.values()].map((group) => {
    const sources = new Set(group.items.map((item) => item.source));
    const sourceClass = sources.size > 1 ? "mixed" : group.items[0].source;
    const selected = group.items.some((item) => item.id === cinemaState.selectedTimepointId);
    const labels = group.items.map((item) => item.label).join("、");
    const title = `${formatSeconds(group.localSeconds)} · ${labels}`;
    const left = clampSeconds((group.localSeconds / total) * 100, 0, 100);
    return `
      <button
        type="button"
        class="cinema-progress-marker is-${sourceClass}${group.items.length > 1 ? " is-cluster" : ""}${selected ? " is-selected" : ""}"
        style="left:${left.toFixed(3)}%"
        data-timepoint-select="${escapeAttr(group.items[0].id)}"
        title="${escapeAttr(title)}"
        aria-label="${escapeAttr(title)}"
      ></button>
    `;
  }).join("");
  cinemaDom.progressMarkers.innerHTML = rangeBands + pointMarkers;
}

function selectTimepoint(id) {
  cinemaState.selectedTimepointId = id;
  renderTimepointNavigation();
  const selected = [...(cinemaDom.timepointList?.querySelectorAll("[data-timepoint-select]") || [])]
    .find((node) => node.dataset.timepointSelect === id);
  selected?.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
}

function openTimepointSeekDialog(id, edge = "start") {
  const item = getTimepointItems().find((candidate) => candidate.id === id);
  const currentCplIndex = getCurrentCplIndex();
  const target = item ? getTimepointTarget(item, edge) : null;
  if (!item || !target || target.cplIndex !== currentCplIndex || !Number.isFinite(target.localSeconds)) {
    const positionLabel = item?.type === "range" ? `该时间段的${edge === "end" ? "结束" : "开始"}位置` : "该时间点";
    renderCinemaError(`${positionLabel}不属于当前 CPL，不能执行定位。`);
    renderTimepointNavigation();
    return;
  }
  if (!canOperatePlayback()) {
    renderCinemaError(getControlUnavailableReason() || "当前播放状态不可定位。");
    return;
  }

  cinemaState.selectedTimepointId = id;
  cinemaState.pendingSeekTarget = clampSeconds(target.localSeconds, 0, getPlayedTotal());
  openSeekDialog();
  renderTimepointNavigation();
}

function getTimepointItems() {
  const boundaries = getCplBoundaries();
  const items = [];
  const active = getActiveScheduleRuntime();
  const entry = active ? getScheduleEntry(active.scheduleId) : null;
  const scheduleMismatch = hasScheduleShowMismatch();
  const rule = entry?.ruleSnapshot && typeof entry.ruleSnapshot === "object" ? entry.ruleSnapshot : null;
  const schedulePoints = Array.isArray(rule?.timePoints) ? rule.timePoints : [];

  schedulePoints.forEach((point, index) => {
    const showSeconds = Number(point?.startSeconds);
    if (!Number.isFinite(showSeconds) || showSeconds < 0) {
      return;
    }
    const mapped = scheduleMismatch ? null : mapShowSecondsToCpl(showSeconds, boundaries);
    const type = ["head", "tail", "range"].includes(point?.type) ? point.type : "point";
    const endSeconds = type === "range" && Number.isFinite(Number(point?.endSeconds)) ? Number(point.endSeconds) : null;
    const endMapped = !scheduleMismatch && Number.isFinite(endSeconds)
      ? mapShowSecondsToCpl(endSeconds, boundaries)
      : null;
    items.push({
      id: `schedule:${point?.id || index}`,
      source: "schedule",
      type,
      label: String(point?.note || getSchedulePointTypeLabel(type)),
      showSeconds,
      endSeconds,
      cplIndex: mapped?.cplIndex ?? null,
      localSeconds: mapped?.localSeconds ?? null,
      endCplIndex: endMapped?.cplIndex ?? null,
      endLocalSeconds: endMapped?.localSeconds ?? null,
      startMappingUnavailable: scheduleMismatch || !mapped,
      endMappingUnavailable: scheduleMismatch || (type === "range" && !endMapped),
      mappingUnavailable: scheduleMismatch || !mapped || (type === "range" && !endMapped),
    });
  });

  for (const boundary of boundaries) {
    const commands = Array.isArray(boundary.cpl?.commands) ? boundary.cpl.commands : [];
    commands.forEach((command, commandIndex) => {
      const fps = parseEditRateFps(command?.editRate || boundary.cpl?.editRate);
      const frames = Number(command?.offsetFrames);
      const rawSeconds = Number.isFinite(frames) ? Math.max(frames, 0) / fps : 0;
      const localSeconds = Number.isFinite(boundary.duration)
        ? clampSeconds(rawSeconds, 0, boundary.duration)
        : rawSeconds;
      items.push({
        id: `playlist:${boundary.index}:${command?.markerUuid || commandIndex}`,
        source: "playlist",
        type: "command",
        label: String(command?.annotationText || command?.label || `命令 ${commandIndex + 1}`),
        showSeconds: Number.isFinite(boundary.start) ? boundary.start + localSeconds : null,
        endSeconds: null,
        cplIndex: boundary.index,
        localSeconds,
        endCplIndex: null,
        endLocalSeconds: null,
        startMappingUnavailable: false,
        endMappingUnavailable: false,
        mappingUnavailable: false,
      });
    });
  }

  return items.sort(compareTimepoints);
}

function getCplBoundaries() {
  const cpls = Array.isArray(cinemaState.loadedShowInspection?.cpls) ? cinemaState.loadedShowInspection.cpls : [];
  let start = 0;
  let timelineKnown = true;
  return cpls.map((cpl, index) => {
    const duration = getCplDuration(cpl);
    const boundary = {
      index,
      cpl,
      start: timelineKnown ? start : null,
      duration,
      end: timelineKnown && Number.isFinite(duration) ? start + duration : null,
    };
    if (timelineKnown && Number.isFinite(duration)) {
      start += duration;
    } else {
      timelineKnown = false;
    }
    return boundary;
  });
}

function getCplDuration(cpl) {
  const durationSeconds = Number(cpl?.durationSeconds);
  if (Number.isFinite(durationSeconds) && durationSeconds >= 0) {
    return durationSeconds;
  }
  const durationFrames = Number(cpl?.durationFrames);
  if (Number.isFinite(durationFrames) && durationFrames >= 0) {
    return durationFrames / parseEditRateFps(cpl?.editRate);
  }
  return null;
}

function mapShowSecondsToCpl(showSeconds, boundaries) {
  for (let index = 0; index < boundaries.length; index += 1) {
    const boundary = boundaries[index];
    if (!Number.isFinite(boundary.start) || !Number.isFinite(boundary.end)) {
      continue;
    }
    const isLast = index === boundaries.length - 1;
    if (showSeconds < boundary.end || (isLast && showSeconds <= boundary.end)) {
      return {
        cplIndex: boundary.index,
        localSeconds: clampSeconds(showSeconds - boundary.start, 0, boundary.duration),
      };
    }
  }
  return null;
}

function hasScheduleShowMismatch() {
  const active = getActiveScheduleRuntime();
  if (!active) {
    return false;
  }
  const entry = getScheduleEntry(active.scheduleId);
  const expected = active.activeShowUuid || getRuleShowUuidForHall(entry?.ruleSnapshot, cinemaState.selectedHallId);
  const loaded = getLoadedShowUuid();
  return Boolean(expected && loaded && normalizeUuid(expected) !== normalizeUuid(loaded));
}

function getRuleShowUuidForHall(rule, hallId) {
  if (!rule || typeof rule !== "object" || !Array.isArray(rule.playlistRefs)) {
    return "";
  }
  return rule.playlistRefs.find((ref) => String(ref?.hallId || "") === String(hallId || ""))?.playlistId || "";
}

function normalizeUuid(value) {
  return String(value || "").trim().replace(/^urn:uuid:/i, "").toLowerCase();
}

function parseEditRateFps(editRate) {
  const parts = String(editRate || "").trim().split(/\s+/).map((part) => Number(part));
  const numerator = parts[0];
  const denominator = parts[1] || 1;
  return Number.isFinite(numerator) && numerator > 0 && Number.isFinite(denominator) && denominator > 0
    ? numerator / denominator
    : DEFAULT_FPS;
}

function compareTimepoints(left, right) {
  const leftKey = Number.isFinite(left.showSeconds)
    ? left.showSeconds
    : (Number.isInteger(left.cplIndex) ? (left.cplIndex * 1_000_000) + (left.localSeconds || 0) : Number.MAX_SAFE_INTEGER);
  const rightKey = Number.isFinite(right.showSeconds)
    ? right.showSeconds
    : (Number.isInteger(right.cplIndex) ? (right.cplIndex * 1_000_000) + (right.localSeconds || 0) : Number.MAX_SAFE_INTEGER);
  return leftKey - rightKey || left.source.localeCompare(right.source);
}

function formatTimepointMeta(item) {
  if (item.type === "range") {
    if (!Number.isInteger(item.cplIndex) || !Number.isFinite(item.localSeconds)
      || !Number.isInteger(item.endCplIndex) || !Number.isFinite(item.endLocalSeconds)) {
      return "放映模板时间段 · 无法映射到当前播放表";
    }
    if (item.cplIndex === item.endCplIndex) {
      return `放映模板时间段 · CPL ${item.cplIndex + 1} 内 ${formatSeconds(item.localSeconds)}–${formatSeconds(item.endLocalSeconds)}`;
    }
    return `放映模板时间段 · 开始 CPL ${item.cplIndex + 1} ${formatSeconds(item.localSeconds)} · 结束 CPL ${item.endCplIndex + 1} ${formatSeconds(item.endLocalSeconds)}`;
  }
  if (item.source === "schedule") {
    const mapped = Number.isInteger(item.cplIndex) && Number.isFinite(item.localSeconds)
      ? `CPL ${item.cplIndex + 1} 内 ${formatSeconds(item.localSeconds)}`
      : "无法映射到当前播放表";
    return `放映模板 · ${mapped}`;
  }
  return `播放表命令 · CPL ${item.cplIndex + 1} 内 ${formatSeconds(item.localSeconds)}`;
}

function getSchedulePointTypeLabel(type) {
  if (type === "head") return "片头时间点";
  if (type === "tail") return "片尾时间点";
  if (type === "range") return "放映时间段";
  return "放映时间点";
}

function getTimepointTarget(item, edge = "start") {
  if (item?.type === "range" && edge === "end") {
    return {
      cplIndex: item.endCplIndex,
      localSeconds: item.endLocalSeconds,
      mappingUnavailable: item.endMappingUnavailable,
    };
  }
  return {
    cplIndex: item?.cplIndex,
    localSeconds: item?.localSeconds,
    mappingUnavailable: item?.startMappingUnavailable ?? item?.mappingUnavailable,
  };
}

function canJumpToTimepointTarget(target, currentCplIndex) {
  return !target.mappingUnavailable
    && target.cplIndex === currentCplIndex
    && Number.isFinite(target.localSeconds)
    && canOperatePlayback();
}

function isTimepointInCpl(item, cplIndex) {
  if (cplIndex < 0) {
    return false;
  }
  if (item.type !== "range") {
    return item.cplIndex === cplIndex;
  }
  return Number.isInteger(item.cplIndex) && Number.isInteger(item.endCplIndex)
    && cplIndex >= item.cplIndex && cplIndex <= item.endCplIndex;
}

function getTimepointJumpUnavailableReason(target, currentCplIndex) {
  if (target.mappingUnavailable || !Number.isInteger(target.cplIndex)) {
    return "无法将整场时间换算到当前播放表的 CPL。";
  }
  if (target.cplIndex !== currentCplIndex) {
    return currentCplIndex >= 0
      ? `该位置属于 CPL ${target.cplIndex + 1}，当前正在播放 CPL ${currentCplIndex + 1}。`
      : "当前 CPL 尚未确定。";
  }
  return getControlUnavailableReason() || "当前播放状态不可定位。";
}

function getScheduleActions(scheduleId) {
  return cinemaState.scheduleStatus.actions.filter((action) => action.scheduleId === scheduleId);
}

function getScheduleStatusDisplay(status) {
  return {
    preparing: { label: "准备载入", icon: "fa-spinner", tone: "preparing" },
    ready: { label: "待开场", icon: "fa-circle-check", tone: "ready" },
    playing: { label: "场次进行中", icon: "fa-circle-play", tone: "playing" },
    manual_hold: { label: "人工干预", icon: "fa-hand", tone: "hold" },
    monitor_lost: { label: "监控中断", icon: "fa-triangle-exclamation", tone: "warning" },
    transitioning: { label: "检测中", icon: "fa-repeat", tone: "transitioning" },
  }[status] || { label: "排程中", icon: "fa-clock", tone: "ready" };
}

function renderPlaybackInfo() {
  const hall = cinemaState.selectedHall;
  const playback = hall?.snapshot.playback?.status || {};
  const playbackUiOverride = resolvePlaybackUiOverride(playback.state);
  const loadedShowTitle = getLoadedShowTitle();
  const loadedShowUuid = getLoadedShowUuid();
  const actualTimeline = getTimelineDurations(playback);
  const affectsTime = playbackUiOverride?.affectsTime !== false;
  const timeline = playbackUiOverride && affectsTime
    ? {
        total: clampSeconds(playbackUiOverride.total || actualTimeline.total, 0, Number.MAX_SAFE_INTEGER),
        played: clampSeconds(
          playbackUiOverride.state === "PLAYING" ? actualTimeline.played : playbackUiOverride.played,
          0,
          playbackUiOverride.total || actualTimeline.total || 0,
        ),
      }
    : actualTimeline;
  const playbackState = playbackUiOverride?.state || playback.state;
  const samplePlaybackState = affectsTime ? playbackState : playback.state;
  const currentCplIndex = getCurrentCplIndex();
  const cplCount = cinemaState.loadedShowInspection?.cpls?.length || 0;
  const cplCountDisplay = Math.max(cplCount, currentCplIndex >= 0 ? currentCplIndex + 1 : 0) || '-';
  const reason = getControlUnavailableReason();
  const nextPlaybackSample = {
    played: timeline.played,
    total: timeline.total,
    playbackState: String(samplePlaybackState || ''),
    sampledAt: playbackUiOverride && affectsTime ? playbackUiOverride.appliedAt : Date.now(),
  };
  const previousPlaybackSample = cinemaState.playbackSample;
  const shouldRefreshPlaybackSample = !previousPlaybackSample
    || previousPlaybackSample.played !== nextPlaybackSample.played
    || previousPlaybackSample.total !== nextPlaybackSample.total
    || previousPlaybackSample.playbackState !== nextPlaybackSample.playbackState
    || (playbackUiOverride && affectsTime);

  if (shouldRefreshPlaybackSample) {
    cinemaState.playbackSample = nextPlaybackSample;
  }

  renderPlaybackState(playbackState);
  setText('loaded-show-title', preserveVisibleSpaces(loadedShowTitle || '\u5f53\u524d\u672a\u8f7d\u5165\u653e\u6620\u8868'));
  setText('current-cpl-badge', `\u5f53\u524d CPL ${currentCplIndex >= 0 ? currentCplIndex + 1 : '-'} / ${cplCountDisplay}`);
  setText('control-unavailable-reason', reason);
  setFieldHidden('control-unavailable-reason', !reason);

  renderInterpolatedPlaybackProgress();

  if (cinemaDom.playbackSlider) {
    cinemaDom.playbackSlider.max = String(Math.max(Math.round(timeline.total), 1));
    cinemaDom.playbackSlider.disabled = cinemaState.controlPanelBusy || !canOperatePlayback() || timeline.total <= 0;
  }

  if (!cinemaState.isSeeking) {
    hideSeekPreview();
  }

  syncControlButtons(playbackState, loadedShowUuid);
}

function renderInterpolatedPlaybackProgress() {
  if (!cinemaState.playbackSample) {
    return;
  }

  const total = cinemaState.playbackSample.total || 0;
  const played = isSeekDialogActive()
    ? clampSeconds(cinemaState.pendingSeekTarget ?? 0, 0, total)
    : getInterpolatedPlayedSeconds();
  setText('played-timecode', `${formatSeconds(played)} / ${formatSeconds(total)}`);

  if (cinemaDom.playbackSlider && !cinemaState.isSeeking) {
    cinemaDom.playbackSlider.value = String(Math.round(Math.min(played, Math.max(total, 1))));
  }
}

function getInterpolatedPlayedSeconds() {
  const sample = cinemaState.playbackSample;
  if (!sample) {
    return 0;
  }

  if (!isPlaybackAdvancing(sample.playbackState) || !canOperatePlayback()) {
    return clampSeconds(sample.played, 0, sample.total || 0);
  }

  const elapsed = Math.max((Date.now() - sample.sampledAt) / 1000, 0);
  return clampSeconds(sample.played + elapsed, 0, sample.total || 0);
}

function startInterpolationTicker() {
  stopInterpolationTicker();
  cinemaState.interpolationTimer = window.setInterval(() => {
    renderInterpolatedPlaybackProgress();
  }, INTERPOLATION_INTERVAL_MS);
}

function stopInterpolationTicker() {
  if (cinemaState.interpolationTimer) {
    window.clearInterval(cinemaState.interpolationTimer);
    cinemaState.interpolationTimer = null;
  }
}

function syncControlButtons(playbackState, loadedShowUuid) {
  const playButton = cinemaDom.root?.querySelector('[data-role="play-toggle"]');
  const playLabel = cinemaDom.root?.querySelector("[data-play-toggle-label]");
  const playIcon = playButton?.querySelector("i");
  const isPlaying = isPlaybackAdvancing(playbackState);
  const controlsLocked = cinemaState.controlPanelBusy;

  if (playButton) {
    if (isPlaying) {
      playButton.dataset.cinemaAction = "pause";
    } else if (String(playbackState || "").toUpperCase() === "PAUSED") {
      playButton.dataset.cinemaAction = "resume";
    } else {
      playButton.dataset.cinemaAction = "play";
    }
    playButton.disabled = controlsLocked || !canOperatePlayback();
  }

  if (playLabel) {
    playLabel.textContent = isPlaying ? "\u6682\u505c\u64ad\u653e" : "\u5f00\u59cb\u64ad\u653e";
  }

  if (playIcon) {
    playIcon.className = isPlaying ? "fas fa-pause" : "fas fa-play";
  }

  for (const button of cinemaDom.root?.querySelectorAll("[data-cinema-action]") || []) {
    const action = button.dataset.cinemaAction;
    if (action === "play" || action === "resume" || action === "pause" || action === "stop") {
      button.disabled = controlsLocked || !canOperatePlayback();
      continue;
    }
    if (action === "previous-cpl") {
      button.disabled = controlsLocked || !canGoPreviousCpl();
      continue;
    }
    if (action === "next-cpl") {
      button.disabled = controlsLocked || !canGoNextCpl();
    }
  }

  for (const button of cinemaDom.root?.querySelectorAll("[data-offset-seconds]") || []) {
    button.disabled = controlsLocked || !canOperatePlayback();
  }

  const refreshButton = cinemaDom.root?.querySelector("[data-refresh-shows]");
  if (refreshButton) {
    refreshButton.disabled = controlsLocked || !cinemaState.selectedHallId || !canControl();
  }

  const refreshRuntimeButton = cinemaDom.root?.querySelector("[data-refresh-runtime]");
  if (refreshRuntimeButton) {
    refreshRuntimeButton.disabled = controlsLocked || !cinemaState.selectedHallId || !cinemaState.selectedHall;
  }

  if (!loadedShowUuid) {
    for (const button of cinemaDom.root?.querySelectorAll("[data-offset-seconds], [data-cinema-action]") || []) {
      if (!["previous-cpl", "next-cpl"].includes(button.dataset.cinemaAction || "")) {
        button.disabled = true;
      }
    }
  }
}

function isPlaybackAdvancing(playbackState) {
  const state = String(playbackState || "").toUpperCase();
  return state === "PLAYING" || state === "RUNNING" || state === "PLAY";
}

function renderLoadedCplList() {
  if (!cinemaDom.loadedCplList) {
    return;
  }

  cinemaDom.loadedCplList.replaceChildren();

  if (!cinemaState.loadedShowInspection?.cpls?.length) {
    cinemaDom.loadedCplList.appendChild(createEmptyBlock('\u5f53\u524d\u672a\u8f7d\u5165\u653e\u6620\u8868\uff0c\u6682\u65e0 CPL \u5217\u8868\u3002', 'cinema-cpl-empty'));
    return;
  }

  const currentIndex = getCurrentCplIndex();
  const fragment = document.createDocumentFragment();

  for (const item of cinemaState.loadedShowInspection.cpls) {
    const node = createCplItemNode({
      title: `${item.index + 1}. ${item.contentTitleText || item.annotationText || `CPL ${item.index + 1}`}`,
      valid: item.validation.ok,
      current: item.index === currentIndex,
    });
    fragment.appendChild(node);
  }

  cinemaDom.loadedCplList.appendChild(fragment);
}

function renderShowList() {
  if (!cinemaDom.showList) {
    return;
  }

  cinemaDom.showList.replaceChildren();

  if (!cinemaState.selectedHall) {
    cinemaDom.showList.appendChild(createEmptyBlock('\u8bf7\u5148\u4ece\u5de6\u4fa7\u5bfc\u822a\u9009\u62e9\u5f71\u5385\u3002', 'cinema-picker-empty'));
    return;
  }

  if (cinemaState.shows.length === 0) {
    cinemaDom.showList.appendChild(createEmptyBlock('\u5f53\u524d\u6ca1\u6709\u53ef\u7528\u653e\u6620\u8868\u3002', 'cinema-picker-empty'));
    return;
  }

  const loadedShowUuid = getLoadedShowUuid();
  const fragment = document.createDocumentFragment();

  for (const show of cinemaState.shows) {
    const node = cinemaDom.showItemTemplate.content.firstElementChild.cloneNode(true);
    const button = node.querySelector('[data-show-item]');
    button.dataset.showItem = show.showUuid;
    button.disabled = cinemaState.controlPanelBusy || !canControl();
    button.classList.toggle('is-current', show.showUuid === loadedShowUuid);
    button.querySelector('[data-role="title"]').textContent = preserveVisibleSpaces(show.title || '\u672a\u547d\u540d\u653e\u6620\u8868');
    fragment.appendChild(node);
  }

  cinemaDom.showList.appendChild(fragment);
}

function renderDialogs() {
  renderLoadDialog();
  renderSeekDialog();
  renderExitScheduleDialog();
}

function renderLoadDialog() {
  if (!cinemaDom.loadDialog) {
    return;
  }

  const show = cinemaState.pendingLoadShow;
  const confirmButton = cinemaDom.loadDialog.querySelector('[data-dialog-confirm="load-show"]');

  if (!show) {
    safeCloseDialog(cinemaDom.loadDialog);
    cinemaDom.loadDialogFields["show-title"].textContent = "-";
    cinemaDom.loadDialogList.replaceChildren();
    if (confirmButton) {
      confirmButton.disabled = true;
    }
    return;
  }

  cinemaDom.loadDialogFields["show-title"].textContent = preserveVisibleSpaces(show.title || "未命名放映表");
  cinemaDom.loadDialogList.replaceChildren();

  const inspection = cinemaState.pendingLoadInspection;
  if (!inspection) {
    cinemaDom.loadDialogList.appendChild(createEmptyBlock("正在加载 CPL 校验结果...", "cinema-cpl-empty"));
  } else {
    const fragment = document.createDocumentFragment();
    for (const item of inspection.cpls) {
      fragment.appendChild(createCplItemNode({
        title: `${item.index + 1}. ${item.contentTitleText || item.annotationText || `CPL ${item.index + 1}`}`,
        valid: item.validation.ok,
      }));
    }
    cinemaDom.loadDialogList.appendChild(fragment);
  }

  if (confirmButton) {
    confirmButton.disabled = !(inspection?.allValid && canControl());
  }
}

function renderSeekDialog() {
  if (!cinemaDom.seekDialog || !cinemaDom.seekInput) {
    return;
  }

  if (!cinemaState.selectedHall || cinemaState.pendingSeekTarget === null) {
    safeCloseDialog(cinemaDom.seekDialog);
    return;
  }

  const playback = cinemaState.selectedHall.snapshot.playback?.status || {};
  const timeline = getTimelineDurations(playback);
  const target = clampSeconds(cinemaState.pendingSeekTarget, 0, timeline.total);

  cinemaDom.seekDialogFields['seek-current-info'].textContent = `${formatSeconds(timeline.played)} / ${formatSeconds(timeline.total)}`;
  cinemaDom.seekInput.max = String(Math.max(Math.round(timeline.total), 0));
  cinemaDom.seekInput.value = formatSeconds(target);
  cinemaDom.seekInput.disabled = !canOperatePlayback();
  cinemaDom.seekInput.classList.remove('input-error');

  const confirmButton = cinemaDom.seekDialog.querySelector('[data-dialog-confirm="seek"]');
  if (confirmButton) {
    confirmButton.disabled = !canOperatePlayback();
  }
}

function renderExitScheduleDialog() {
  if (!cinemaDom.exitScheduleDialog) {
    return;
  }

  const runtime = cinemaState.pendingExitScheduleRuntime;
  const confirmButton = cinemaDom.exitScheduleDialog.querySelector('[data-dialog-confirm="exit-schedule-monitoring"]');
  if (!runtime) {
    safeCloseDialog(cinemaDom.exitScheduleDialog);
    if (cinemaDom.exitScheduleDialogFields["exit-schedule-title"]) {
      cinemaDom.exitScheduleDialogFields["exit-schedule-title"].textContent = "-";
    }
    if (cinemaDom.exitScheduleDialogFields["exit-schedule-meta"]) {
      cinemaDom.exitScheduleDialogFields["exit-schedule-meta"].textContent = "";
    }
    if (confirmButton) {
      confirmButton.disabled = true;
      confirmButton.innerHTML = "确认退出";
    }
    return;
  }

  const entry = getScheduleEntry(runtime.scheduleId);
  const status = getScheduleStatusDisplay(runtime.status);
  const title = entry?.filmName || "当前排程";
  const startTime = entry?.startTime ? formatDateTimeShort(entry.startTime) : "--:--";
  const position = Number.isFinite(runtime.lastPositionSeconds)
    ? formatSeconds(runtime.lastPositionSeconds)
    : "--:--:--";

  if (cinemaDom.exitScheduleDialogFields["exit-schedule-title"]) {
    cinemaDom.exitScheduleDialogFields["exit-schedule-title"].textContent = title;
  }
  if (cinemaDom.exitScheduleDialogFields["exit-schedule-meta"]) {
    cinemaDom.exitScheduleDialogFields["exit-schedule-meta"].textContent =
      `开场 ${startTime} · ${status.label} · 位置 ${position}`;
  }
  if (confirmButton) {
    confirmButton.disabled = cinemaState.scheduleMonitorExitBusy;
    confirmButton.innerHTML = cinemaState.scheduleMonitorExitBusy
      ? '<span class="loading loading-spinner loading-sm"></span>正在退出'
      : "确认退出";
  }
}

function createCplItemNode({ title, valid = false, current = false }) {
  const node = cinemaDom.cplItemTemplate.content.firstElementChild.cloneNode(true);
  const statusIcon = node.querySelector('[data-role="status-icon"]');
  node.classList.toggle("current", current);
  node.querySelector('[data-role="title"]').textContent = title;
  if (statusIcon) {
    statusIcon.className = `fas ${valid ? "fa-circle-check is-valid" : "fa-circle-xmark is-invalid"}`;
    statusIcon.title = valid ? "校验通过" : "校验失败";
    statusIcon.setAttribute("aria-label", valid ? "校验通过" : "校验失败");
  }
  return node;
}

function createEmptyBlock(message, className) {
  const node = document.createElement("div");
  node.className = className;
  node.textContent = message;
  return node;
}

function safeCloseDialog(dialog) {
  if (dialog?.open) {
    dialog.close();
  }
}

function adjustSeekTarget(deltaSeconds) {
  if (cinemaState.pendingSeekTarget === null) {
    return;
  }

  cinemaState.pendingSeekTarget = clampSeconds(
    cinemaState.pendingSeekTarget + deltaSeconds,
    0,
    getPlayedTotal(),
  );
  renderSeekDialog();
}

function updateSeekPreview(value, visible) {
  if (!cinemaDom.seekPreview) {
    return;
  }

  const total = getPlayedTotal();
  if (!visible || !total) {
    hideSeekPreview();
    return;
  }

  const clamped = clampSeconds(value, 0, total);
  const percent = total > 0 ? (clamped / total) * 100 : 0;
  const safePercent = clampSeconds(percent, 3, 97);

  cinemaDom.seekPreview.textContent = `\u76ee\u6807 ${formatSeconds(clamped)}`;
  cinemaDom.seekPreview.style.left = `${safePercent}%`;
  cinemaDom.seekPreview.classList.remove('hidden');
}

function renderPlaybackState(state) {
  const node = cinemaDom.fields['playback-state'];
  if (!node) {
    return;
  }

  const normalized = normalizePlaybackState(state);
  const config = {
    PLAYING: { icon: 'fa-circle-play', label: '\u64ad\u653e\u4e2d', className: 'is-playing' },
    PAUSED: { icon: 'fa-circle-pause', label: '\u5df2\u6682\u505c', className: 'is-paused' },
    STOP: { icon: 'fa-stop-circle', label: '\u505c\u6b62', className: 'is-stopped' },
  }[normalized];

  node.classList.remove('is-playing', 'is-paused', 'is-stopped');
  node.classList.add(config.className);
  node.innerHTML = `<i class="fas ${config.icon}"></i><span>${config.label}</span>`;
}

function normalizePlaybackState(state) {
  const normalized = String(state || '').toUpperCase();
  if (normalized === 'PLAYING' || normalized === 'RUNNING' || normalized === 'PLAY') {
    return 'PLAYING';
  }
  if (normalized === 'PAUSED' || normalized === 'PAUSE') {
    return 'PAUSED';
  }
  return 'STOP';
}

function setShowPickerOpen(open) {
  if (cinemaDom.showPickerDropdown) {
    cinemaDom.showPickerDropdown.open = open;
  }
}

function hideSeekPreview() {
  if (!cinemaDom.seekPreview) {
    return;
  }
  cinemaDom.seekPreview.classList.add("hidden");
}

function renderCinemaError(message) {
  if (!cinemaDom.error) {
    return;
  }

  cinemaDom.error.innerHTML = `
    <div class="alert alert-error">
      <i class="fas fa-circle-xmark"></i>
      <span>${escapeHtml(message)}</span>
    </div>
  `;
}

function clearCinemaError() {
  if (cinemaDom.error) {
    cinemaDom.error.innerHTML = "";
  }
}

function parseSseData(data) {
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}

function setText(name, value) {
  const node = cinemaDom.fields[name];
  if (node) {
    node.textContent = value;
  }
}

function setFieldHidden(name, hidden) {
  const node = cinemaDom.fields[name];
  if (node) {
    node.classList.toggle("hidden", hidden);
  }
}

function setStatusText(name, value, ok) {
  const node = cinemaDom.fields[name];
  if (!node) {
    return;
  }
  node.textContent = value;
  node.classList.toggle("cinema-ok", ok);
  node.classList.toggle("cinema-danger", !ok);
}

function formatFrameTimecode(value, fps = DEFAULT_FPS) {
  if (!Number.isFinite(value) || value < 0) {
    return "00:00:00:00";
  }

  const totalFrames = Math.round(value * fps);
  const framesPerHour = fps * 60 * 60;
  const framesPerMinute = fps * 60;
  const hours = Math.floor(totalFrames / framesPerHour);
  const minutes = Math.floor((totalFrames % framesPerHour) / framesPerMinute);
  const seconds = Math.floor((totalFrames % framesPerMinute) / fps);
  const frames = totalFrames % fps;

  return [
    String(hours).padStart(2, "0"),
    String(minutes).padStart(2, "0"),
    String(seconds).padStart(2, "0"),
    String(frames).padStart(2, "0"),
  ].join(":");
}

function formatSeconds(value) {
  if (!Number.isFinite(value) || value <= 0) {
    return '00:00:00';
  }

  const totalSeconds = Math.max(Math.round(value), 0);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  return [
    String(hours).padStart(2, '0'),
    String(minutes).padStart(2, '0'),
    String(seconds).padStart(2, '0'),
  ].join(':');
}

function formatDateTimeShort(value) {
  if (!value) {
    return "--:--";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    const match = /(\d{2}):(\d{2})(?::(\d{2}))?/.exec(String(value));
    return match ? `${match[1]}:${match[2]}${match[3] ? `:${match[3]}` : ""}` : String(value).slice(0, 16);
  }

  return [
    String(date.getHours()).padStart(2, "0"),
    String(date.getMinutes()).padStart(2, "0"),
    String(date.getSeconds()).padStart(2, "0"),
  ].join(":");
}

function formatLocalDate(date) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

function parseClockTime(value) {
  const normalized = String(value || '').trim();
  if (!normalized) {
    return null;
  }

  if (!/^\d{1,3}(?::\d{1,2}){0,2}$/.test(normalized)) {
    return null;
  }

  const parts = normalized.split(':').map((part) => Number(part));
  if (parts.some((part) => !Number.isInteger(part) || part < 0)) {
    return null;
  }

  if (parts.length === 3) {
    const [hours, minutes, seconds] = parts;
    if (minutes > 59 || seconds > 59) {
      return null;
    }
    return (hours * 3600) + (minutes * 60) + seconds;
  }

  if (parts.length === 2) {
    const [minutes, seconds] = parts;
    if (seconds > 59) {
      return null;
    }
    return (minutes * 60) + seconds;
  }

  return parts[0];
}

function safeNumber(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

function formatBytes(value) {
  if (!Number.isFinite(value) || value <= 0) {
    return "-";
  }

  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(size >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function clampSeconds(value, min, max) {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(Math.max(value, min), max);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function preserveVisibleSpaces(value) {
  return String(value).replace(/ {2,}/g, (spaces) => "\u00a0".repeat(spaces.length));
}

function escapeAttr(value) {
  return escapeHtml(value);
}
