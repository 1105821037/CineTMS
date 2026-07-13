import { apiDelete, apiGet, apiPost, getRuntimeHalls, openRealtimeSocket } from "../api.js";
import { toast } from "../toast.js";

const DEFAULT_START_HOUR = 9;
const DEFAULT_END_HOUR = 24;
const MIN_BLOCK_MINUTES = 28;
const RULE_TIMELINE_PIXELS_PER_SECOND = 0.08;
const RULE_TIMELINE_MIN_SEGMENT_WIDTH = 118;
const RULE_TIMELINE_MAX_SEGMENT_WIDTH = 620;
const NOW_REFRESH_INTERVAL_MS = 30_000;
const SCHEDULE_DATA_REFRESH_INTERVAL_MS = 60_000;
const MONITORED_SCHEDULE_STATUSES = new Set(["pending", "preparing", "ready", "playing", "manual_hold", "monitor_lost", "transitioning"]);
const FILM_ACCENT_PALETTE = [
  { hue: 198, accent: 198 },
  { hue: 142, accent: 142 },
  { hue: 36, accent: 36 },
  { hue: 326, accent: 326 },
  { hue: 262, accent: 262 },
  { hue: 18, accent: 18 },
  { hue: 174, accent: 174 },
  { hue: 52, accent: 52 },
  { hue: 286, accent: 286 },
  { hue: 222, accent: 222 },
  { hue: 96, accent: 96 },
  { hue: 348, accent: 348 },
];

const state = {
  showDate: "",
  ticketingSessions: [],
  ticketingWarnings: [],
  entries: [],
  gdcSchedules: [],
  gdcWarnings: [],
  rules: [],
  halls: [],
  managedHallIds: new Set(),
  managedHallOptions: new Map(),
  managedHallSavingIds: new Set(),
  lastManagedAutoDisableAt: "",
  pendingManagedHallId: "",
  pendingDeleteRuntime: null,
  filmColors: new Map(),
  selectedSession: null,
  editingEntry: null,
  busy: false,
  syncingTimelineScroll: false,
  nowTimer: null,
  dataRefreshTimer: null,
  dataRefreshInFlight: false,
  realtimeSocket: null,
  realtimeActive: false,
  realtimeReconnectTimer: null,
  realtimeRefreshTimer: null,
  realtimeRefreshInFlight: false,
  pendingTimelineRender: false,
  shouldAutoCenterTimeline: true,
};

const dom = {};

export function initFilmSchedulePage() {
  cacheDom();
  bindEvents();
  state.showDate = todayDate();
  state.shouldAutoCenterTimeline = true;
  dom.dateInput.value = state.showDate;
  startNowTimer();
  startScheduleDataTimer();
  state.realtimeActive = true;
  connectScheduleRealtimeSocket();
  void loadPageData();
}

export function disposeFilmSchedulePage() {
  stopNowTimer();
  stopScheduleDataTimer();
  state.realtimeActive = false;
  state.lastManagedAutoDisableAt = "";
  disconnectScheduleRealtimeSocket();
}

function cacheDom() {
  Object.assign(dom, {
    root: document.getElementById("filmScheduleRoot"),
    dateInput: document.getElementById("filmScheduleDateInput"),
    refreshBtn: document.getElementById("filmScheduleRefreshBtn"),
    error: document.getElementById("filmScheduleError"),
    ticketingMeta: document.getElementById("filmScheduleTicketingMeta"),
    ticketingStatus: document.getElementById("filmScheduleTicketingStatus"),
    ticketingTimeline: document.getElementById("filmScheduleTicketingTimeline"),
    previewMeta: document.getElementById("filmSchedulePreviewMeta"),
    previewTimeline: document.getElementById("filmSchedulePreviewTimeline"),
    customBtn: document.getElementById("filmScheduleCustomBtn"),
    customDialog: document.getElementById("filmScheduleCustomDialog"),
    customTitle: document.getElementById("filmScheduleCustomTitle"),
    customSubtitle: document.getElementById("filmScheduleCustomSubtitle"),
    customCloseBtn: document.getElementById("filmScheduleCustomCloseBtn"),
    customCancelBtn: document.getElementById("filmScheduleCustomCancelBtn"),
    customForm: document.getElementById("filmScheduleCustomForm"),
    customSessionSummary: document.getElementById("filmScheduleCustomSessionSummary"),
    ruleSelect: document.getElementById("filmScheduleRuleSelect"),
    ruleHallSelect: document.getElementById("filmScheduleRuleHallSelect"),
    customHallWarning: document.getElementById("filmScheduleCustomHallWarning"),
    customStartInput: document.getElementById("filmScheduleCustomStartInput"),
    customAlignFeatureInput: document.getElementById("filmScheduleCustomAlignFeatureInput"),
    customAlignFeatureText: document.getElementById("filmScheduleCustomAlignFeatureText"),
    customEstimate: document.getElementById("filmScheduleCustomEstimate"),
    customRulePreview: document.getElementById("filmScheduleCustomRulePreview"),
    customNotesInput: document.getElementById("filmScheduleCustomNotesInput"),
    customError: document.getElementById("filmScheduleCustomError"),
    customSaveBtn: document.getElementById("filmScheduleCustomSaveBtn"),
    managedDialog: document.getElementById("filmScheduleManagedDialog"),
    managedCloseBtn: document.getElementById("filmScheduleManagedCloseBtn"),
    managedCancelBtn: document.getElementById("filmScheduleManagedCancelBtn"),
    managedForm: document.getElementById("filmScheduleManagedForm"),
    managedHallName: document.getElementById("filmScheduleManagedHallName"),
    managedAlignFeatureInput: document.getElementById("filmScheduleManagedAlignFeatureInput"),
    managedAutoDisableEnabledInput: document.getElementById("filmScheduleManagedAutoDisableEnabledInput"),
    managedAutoDisableInput: document.getElementById("filmScheduleManagedAutoDisableInput"),
    managedError: document.getElementById("filmScheduleManagedError"),
    managedSaveBtn: document.getElementById("filmScheduleManagedSaveBtn"),
    editDialog: document.getElementById("filmScheduleEditDialog"),
    editSubtitle: document.getElementById("filmScheduleEditSubtitle"),
    editCloseBtn: document.getElementById("filmScheduleEditCloseBtn"),
    editCancelBtn: document.getElementById("filmScheduleEditCancelBtn"),
    editForm: document.getElementById("filmScheduleEditForm"),
    editRuleSelect: document.getElementById("filmScheduleEditRuleSelect"),
    editHallSelect: document.getElementById("filmScheduleEditHallSelect"),
    editHallWarning: document.getElementById("filmScheduleEditHallWarning"),
    editStartInput: document.getElementById("filmScheduleEditStartInput"),
    editEstimate: document.getElementById("filmScheduleEditEstimate"),
    editRulePreview: document.getElementById("filmScheduleEditRulePreview"),
    editNotesInput: document.getElementById("filmScheduleEditNotesInput"),
    editError: document.getElementById("filmScheduleEditError"),
    deleteMonitorWarning: document.getElementById("filmScheduleDeleteMonitorWarning"),
    deleteMonitorMeta: document.getElementById("filmScheduleDeleteMonitorMeta"),
    deleteMonitorCancelBtn: document.getElementById("filmScheduleDeleteMonitorCancelBtn"),
    deleteMonitorConfirmBtn: document.getElementById("filmScheduleDeleteMonitorConfirmBtn"),
    editSaveBtn: document.getElementById("filmScheduleEditSaveBtn"),
    deleteBtn: document.getElementById("filmScheduleDeleteBtn"),
  });
}

function bindEvents() {
  if (!dom.root || dom.root.dataset.bound === "true") {
    return;
  }
  dom.root.dataset.bound = "true";

  dom.dateInput.addEventListener("change", () => {
    state.showDate = dom.dateInput.value || todayDate();
    state.shouldAutoCenterTimeline = true;
    void loadPageData();
  });
  dom.refreshBtn.addEventListener("click", () => loadPageData(true, { autoCenter: false, preserveScroll: true }));
  dom.ticketingTimeline.addEventListener("click", (event) => {
    const button = event.target.closest("[data-ticketing-session]");
    if (!button) return;
    const session = state.ticketingSessions.find((item) => item.id === button.dataset.ticketingSession);
    if (session) openTicketingCustomDialog(session);
  });
  dom.previewTimeline.addEventListener("click", (event) => {
    const button = event.target.closest("[data-preview-entry]");
    if (!button) return;
    const entry = state.entries.find((item) => item.id === button.dataset.previewEntry);
    if (entry) openEditDialog(entry);
  });
  dom.ticketingTimeline.addEventListener("scroll", handleTimelineScroll, true);
  dom.previewTimeline.addEventListener("scroll", handleTimelineScroll, true);
  dom.ticketingTimeline.addEventListener("change", (event) => {
    const input = event.target.closest("[data-managed-hall-toggle]");
    if (!input) return;
    handleManagedHallToggleChange(input);
  });

  dom.customBtn.addEventListener("click", () => openCustomDialog());
  dom.customCloseBtn.addEventListener("click", () => dom.customDialog.close());
  dom.customCancelBtn.addEventListener("click", () => dom.customDialog.close());
  dom.customDialog.addEventListener("close", renderPendingTimelineRefresh);
  dom.ruleSelect.addEventListener("change", () => {
    renderRuleHallOptions();
    renderCustomFeatureAlignOption();
    renderCustomEstimate();
    renderCustomRulePreview();
    renderCustomHallWarning();
    renderCustomSessionSummary();
    syncCustomSaveButtonState();
  });
  dom.ruleHallSelect.addEventListener("change", () => {
    renderCustomHallWarning();
    syncCustomSaveButtonState();
  });
  dom.customStartInput.addEventListener("input", () => {
    updateCustomFeatureAlignText();
    renderCustomEstimate();
    syncCustomSaveButtonState();
  });
  dom.customAlignFeatureInput.addEventListener("change", () => {
    updateCustomStartMinimum();
    updateCustomFeatureAlignText();
    renderCustomEstimate();
    syncCustomSaveButtonState();
  });
  dom.customForm.addEventListener("submit", saveCustomEntry);
  dom.managedCloseBtn.addEventListener("click", () => closeManagedDialog());
  dom.managedCancelBtn.addEventListener("click", () => closeManagedDialog());
  dom.managedDialog.addEventListener("close", () => {
    state.pendingManagedHallId = "";
    renderAll({ preserveScroll: true });
  });
  dom.managedForm.addEventListener("submit", saveManagedHallOptions);
  dom.managedAutoDisableEnabledInput.addEventListener("change", syncManagedAutoDisableInput);

  dom.editCloseBtn.addEventListener("click", () => dom.editDialog.close());
  dom.editCancelBtn.addEventListener("click", () => dom.editDialog.close());
  dom.editDialog.addEventListener("close", () => {
    state.pendingDeleteRuntime = null;
    renderDeleteMonitorWarning();
    renderPendingTimelineRefresh();
  });
  dom.editRuleSelect.addEventListener("change", () => {
    renderEditHallOptions();
    renderEditEstimate();
    renderEditRulePreview();
    renderEditHallWarning();
  });
  dom.editHallSelect.addEventListener("change", renderEditHallWarning);
  dom.editStartInput.addEventListener("input", renderEditEstimate);
  dom.editForm.addEventListener("submit", saveEntryAdjustment);
  dom.deleteBtn.addEventListener("click", deleteEditingEntry);
  dom.deleteMonitorCancelBtn.addEventListener("click", () => {
    state.pendingDeleteRuntime = null;
    renderDeleteMonitorWarning();
  });
  dom.deleteMonitorConfirmBtn.addEventListener("click", () => {
    void performDeleteEditingEntry(dom.deleteMonitorConfirmBtn);
  });
}

async function loadPageData(force = false, options = {}) {
  if (options.autoCenter !== undefined) {
    state.shouldAutoCenterTimeline = options.autoCenter === true;
  }
  const preserveScroll = options.preserveScroll === true;
  setBusy(true);
  renderError("");
  try {
    const query = `?date=${encodeURIComponent(state.showDate)}`;
    const [ticketingPayload, entriesPayload, gdcPayload, halls, managedPayload] = await Promise.all([
      apiGet(`/api/film-schedule/ticketing${query}`).catch((error) => ({
        sessions: [],
        warnings: [{ message: formatTicketingFetchWarning(error) }],
      })),
      apiGet(`/api/film-schedule/entries${query}`),
      apiGet(`/api/film-schedule/gdc${query}`).catch((error) => ({
        schedules: [],
        warnings: [{ message: error.message || "GDC排期拉取失败。" }],
      })),
      getRuntimeHalls(force).catch(() => []),
      apiGet("/api/film-scheduler/managed-halls").catch(() => ({ managedHalls: [] })),
    ]);

    state.ticketingSessions = Array.isArray(ticketingPayload.sessions) ? ticketingPayload.sessions : [];
    state.ticketingWarnings = Array.isArray(ticketingPayload.warnings) ? ticketingPayload.warnings : [];
    state.entries = Array.isArray(entriesPayload.entries) ? entriesPayload.entries : [];
    state.gdcSchedules = Array.isArray(gdcPayload.schedules) ? gdcPayload.schedules : [];
    state.gdcWarnings = Array.isArray(gdcPayload.warnings) ? gdcPayload.warnings : [];
    state.rules = await loadRelevantPlaybackRules();
    state.halls = normalizeRuntimeHalls(halls);
    const managedHalls = managedPayload.managedHalls || [];
    state.managedHallOptions = new Map(managedHalls
      .filter((item) => item?.hallId)
      .map((item) => [item.hallId, {
        hallId: item.hallId,
        enabled: item.enabled === true,
        alignFeatureStart: item.alignFeatureStart !== false,
        autoDisableAt: normalizeDateTimeLocalValue(String(item.autoDisableAt || "")),
      }]));
    state.managedHallIds = new Set(managedHalls
      .filter((item) => item?.enabled && item?.hallId)
      .map((item) => item.hallId));

    renderAll({ preserveScroll });
  } catch (error) {
    renderError(error.message || "排期加载失败。");
    state.ticketingSessions = [];
    state.ticketingWarnings = [];
    state.entries = [];
    state.gdcSchedules = [];
    state.gdcWarnings = [];
    renderAll({ preserveScroll });
  } finally {
    setBusy(false);
  }
}

async function refreshScheduleDataSilently() {
  if (state.busy || state.dataRefreshInFlight) {
    return;
  }

  state.dataRefreshInFlight = true;
  try {
    const query = `?date=${encodeURIComponent(state.showDate)}`;
    const [ticketingPayload, entriesPayload, gdcPayload] = await Promise.all([
      apiGet(`/api/film-schedule/ticketing${query}`).catch((error) => ({
        sessions: [],
        warnings: [{ message: formatTicketingFetchWarning(error) }],
      })),
      apiGet(`/api/film-schedule/entries${query}`),
      apiGet(`/api/film-schedule/gdc${query}`).catch((error) => ({
        schedules: [],
        warnings: [{ message: error.message || "GDC排期拉取失败。" }],
      })),
    ]);

    state.ticketingSessions = Array.isArray(ticketingPayload.sessions) ? ticketingPayload.sessions : [];
    state.ticketingWarnings = Array.isArray(ticketingPayload.warnings) ? ticketingPayload.warnings : [];
    state.entries = Array.isArray(entriesPayload.entries) ? entriesPayload.entries : [];
    state.gdcSchedules = Array.isArray(gdcPayload.schedules) ? gdcPayload.schedules : [];
    state.gdcWarnings = Array.isArray(gdcPayload.warnings) ? gdcPayload.warnings : [];
    state.rules = await loadRelevantPlaybackRules();

    if (isAnyScheduleDialogOpen()) {
      state.pendingTimelineRender = true;
      return;
    }

    renderAll({ preserveScroll: true });
  } catch (error) {
    console.warn("Film schedule silent refresh failed:", error);
  } finally {
    state.dataRefreshInFlight = false;
  }
}

async function loadRelevantPlaybackRules() {
  const request = buildRelevantPlaybackRuleRequest();
  if (request.filmCds.length === 0 && request.ruleIds.length === 0) {
    return [];
  }
  const payload = await apiPost("/api/film-playback/rules/resolve", request);
  return Array.isArray(payload.rules) ? payload.rules : [];
}

function buildRelevantPlaybackRuleRequest() {
  const filmCds = new Set();
  const ruleIds = new Set();
  for (const item of [...state.ticketingSessions, ...state.entries, ...state.gdcSchedules]) {
    if (typeof item?.filmCd === "string" && item.filmCd.trim()) {
      filmCds.add(item.filmCd.trim());
    }
    if (typeof item?.ruleId === "string" && item.ruleId.trim()) {
      ruleIds.add(item.ruleId.trim());
    }
  }
  return {
    filmCds: [...filmCds],
    ruleIds: [...ruleIds],
  };
}

function renderPendingTimelineRefresh() {
  if (!state.pendingTimelineRender || isAnyScheduleDialogOpen()) {
    return;
  }
  state.pendingTimelineRender = false;
  renderAll({ preserveScroll: true });
}

function formatTicketingFetchWarning(error) {
  const message = error instanceof Error ? error.message : String(error || "");
  if (!message || message === "fetch failed") {
    return "售票系统排期拉取失败，请检查售票系统连接。";
  }
  return `售票系统排期拉取失败：${message}`;
}

function isAnyScheduleDialogOpen() {
  return Boolean(dom.customDialog?.open || dom.managedDialog?.open || dom.editDialog?.open);
}

function renderAll(options = {}) {
  const preservedScrollLeft = options.preserveScroll ? getCurrentTimelineScrollLeft() : null;
  const range = getTimelineRange([...state.ticketingSessions, ...state.entries, ...state.gdcSchedules]);
  refreshFilmColorMap();
  renderTicketingTimeline(range);
  renderPreviewTimeline(range);
  if (state.shouldAutoCenterTimeline) {
    syncTimelineInitialScroll(range);
    state.shouldAutoCenterTimeline = false;
  } else if (preservedScrollLeft !== null) {
    restoreTimelineScroll(preservedScrollLeft);
  }
}

function renderTicketingTimeline(range) {
  dom.ticketingMeta.textContent = [
    `${state.ticketingSessions.length} 个售票场次`,
    state.ticketingWarnings.length ? `${state.ticketingWarnings.length} 个拉取失败` : "",
  ].filter(Boolean).join(" · ");
  dom.ticketingMeta.title = state.ticketingWarnings.map((item) => item.message || String(item)).join("\n");
  dom.ticketingStatus.textContent = state.busy ? "加载中" : `${state.showDate}`;
  dom.ticketingStatus.classList.toggle("badge-warning", state.ticketingWarnings.length > 0);
  dom.ticketingStatus.classList.toggle("badge-ghost", state.ticketingWarnings.length === 0);
  dom.ticketingTimeline.innerHTML = renderTimeline({
    kind: "ticketing",
    emptyText: "暂无售票系统排期",
    items: state.ticketingSessions,
    halls: groupHalls(state.ticketingSessions),
    range,
    renderItem: renderTicketingItem,
  });
}

function renderPreviewTimeline(range) {
  dom.previewMeta.textContent = [
    `${state.entries.length} 个已保存排期`,
    `${state.gdcSchedules.length} 个GDC占用`,
    state.gdcWarnings.length ? `${state.gdcWarnings.length} 个影厅拉取失败` : "",
  ].filter(Boolean).join(" · ");
  dom.previewMeta.title = state.gdcWarnings.map((item) => `${item.hallName || "GDC"}：${item.message}`).join("\n");
  dom.previewTimeline.innerHTML = renderTimeline({
    kind: "preview",
    emptyText: "暂无排期预览",
    items: [...state.entries, ...state.gdcSchedules],
    halls: getPreviewHalls(),
    range,
    renderItem: renderPreviewItem,
  });
}

function renderTimeline({ kind, emptyText, items, halls, range, renderItem }) {
  if (!items.length && !halls.length) {
    return `<div class="film-schedule-empty">${escapeHtml(emptyText)}</div>`;
  }
  const width = Math.max(840, Math.round((range.end - range.start) * 1.8));
  return `
    <div class="film-schedule-timeline-scroll">
      <div class="film-schedule-timeline ${kind === "preview" ? "is-preview" : ""}" style="--timeline-width: ${width}px">
        <div class="film-schedule-ruler">
          <div class="film-schedule-ruler-corner"></div>
          <div class="film-schedule-ruler-track">
            ${renderHourTicks(range)}
          </div>
        </div>
        <div class="film-schedule-now-layer" data-range-start="${escapeAttr(range.start)}" data-range-end="${escapeAttr(range.end)}" data-timeline-width="${escapeAttr(width)}">
          ${renderNowOverlay(range, width)}
        </div>
        ${halls.map((hall) => renderTimelineRow(kind, hall, items.filter((item) => item.hallId === hall.id), range, renderItem)).join("")}
      </div>
    </div>
  `;
}

function handleTimelineScroll(event) {
  const source = event.target.closest?.(".film-schedule-timeline-scroll");
  if (!source || state.syncingTimelineScroll) {
    return;
  }
  const target = getTimelineScrollElements().find((element) => element !== source);
  if (!target) {
    return;
  }

  state.syncingTimelineScroll = true;
  target.scrollLeft = source.scrollLeft;
  requestAnimationFrame(() => {
    state.syncingTimelineScroll = false;
  });
}

function syncTimelineInitialScroll(range) {
  requestAnimationFrame(() => {
    const elements = getTimelineScrollElements();
    if (!elements.length) {
      return;
    }
    const targetLeft = getInitialTimelineScrollLeft(elements[0], range);
    state.syncingTimelineScroll = true;
    elements.forEach((element) => {
      element.scrollLeft = targetLeft;
    });
    requestAnimationFrame(() => {
      state.syncingTimelineScroll = false;
    });
  });
}

function startNowTimer() {
  stopNowTimer();
  state.nowTimer = window.setInterval(updateNowLayers, NOW_REFRESH_INTERVAL_MS);
}

function stopNowTimer() {
  if (state.nowTimer) {
    window.clearInterval(state.nowTimer);
    state.nowTimer = null;
  }
}

function startScheduleDataTimer() {
  stopScheduleDataTimer();
  state.dataRefreshTimer = window.setInterval(() => {
    void refreshScheduleDataSilently();
  }, SCHEDULE_DATA_REFRESH_INTERVAL_MS);
}

function stopScheduleDataTimer() {
  if (state.dataRefreshTimer) {
    window.clearInterval(state.dataRefreshTimer);
    state.dataRefreshTimer = null;
  }
  state.dataRefreshInFlight = false;
  state.pendingTimelineRender = false;
}

function connectScheduleRealtimeSocket() {
  if (!state.realtimeActive) {
    return;
  }
  disconnectScheduleRealtimeSocket();
  const socket = openRealtimeSocket();
  state.realtimeSocket = socket;

  socket.addEventListener("message", (event) => {
    const message = parseJson(event.data);
    if (message?.type !== "film-schedule-entry") {
      return;
    }
    const payload = message.payload || {};
    if (payload.showDate && payload.showDate !== state.showDate) {
      return;
    }
    scheduleRealtimeEntriesRefresh();
  });

  socket.addEventListener("close", scheduleScheduleRealtimeReconnect);
  socket.addEventListener("error", scheduleScheduleRealtimeReconnect);
}

function disconnectScheduleRealtimeSocket() {
  if (state.realtimeReconnectTimer) {
    window.clearTimeout(state.realtimeReconnectTimer);
    state.realtimeReconnectTimer = null;
  }
  if (state.realtimeRefreshTimer) {
    window.clearTimeout(state.realtimeRefreshTimer);
    state.realtimeRefreshTimer = null;
  }
  if (state.realtimeSocket) {
    state.realtimeSocket.close();
    state.realtimeSocket = null;
  }
  state.realtimeRefreshInFlight = false;
}

function scheduleScheduleRealtimeReconnect() {
  if (!state.realtimeActive || state.realtimeReconnectTimer || !dom.root?.isConnected) {
    return;
  }
  state.realtimeReconnectTimer = window.setTimeout(() => {
    state.realtimeReconnectTimer = null;
    connectScheduleRealtimeSocket();
  }, 5_000);
}

function scheduleRealtimeEntriesRefresh() {
  if (state.realtimeRefreshTimer) {
    window.clearTimeout(state.realtimeRefreshTimer);
  }
  state.realtimeRefreshTimer = window.setTimeout(() => {
    state.realtimeRefreshTimer = null;
    void refreshEntriesFromRealtime();
  }, 150);
}

async function refreshEntriesFromRealtime() {
  if (state.busy || state.realtimeRefreshInFlight) {
    scheduleRealtimeEntriesRefresh();
    return;
  }

  state.realtimeRefreshInFlight = true;
  try {
    const payload = await apiGet(`/api/film-schedule/entries?date=${encodeURIComponent(state.showDate)}`);
    state.entries = Array.isArray(payload.entries) ? payload.entries : [];
    state.rules = await loadRelevantPlaybackRules();
    if (isAnyScheduleDialogOpen()) {
      state.pendingTimelineRender = true;
      return;
    }
    renderAll({ preserveScroll: true });
  } catch (error) {
    console.warn("Film schedule realtime refresh failed:", error);
  } finally {
    state.realtimeRefreshInFlight = false;
  }
}

function updateNowLayers() {
  let firstRange = null;
  dom.root.querySelectorAll(".film-schedule-now-layer").forEach((layer) => {
    const range = {
      start: Number(layer.dataset.rangeStart),
      end: Number(layer.dataset.rangeEnd),
    };
    const width = Number(layer.dataset.timelineWidth);
    if (!Number.isFinite(range.start) || !Number.isFinite(range.end) || !Number.isFinite(width)) {
      layer.innerHTML = "";
      return;
    }
    firstRange ??= range;
    layer.innerHTML = renderNowOverlay(range, width);
  });

  if (firstRange) {
    // Keep user-controlled scroll position stable during clock refreshes.
  }
}

function getTimelineScrollElements() {
  return [
    dom.ticketingTimeline.querySelector(".film-schedule-timeline-scroll"),
    dom.previewTimeline.querySelector(".film-schedule-timeline-scroll"),
  ].filter(Boolean);
}

function getCurrentTimelineScrollLeft() {
  const elements = getTimelineScrollElements();
  return elements.length ? elements[0].scrollLeft : null;
}

function restoreTimelineScroll(scrollLeft) {
  requestAnimationFrame(() => {
    state.syncingTimelineScroll = true;
    getTimelineScrollElements().forEach((element) => {
      const maxScrollLeft = Math.max(0, element.scrollWidth - element.clientWidth);
      element.scrollLeft = Math.min(Math.max(0, scrollLeft), maxScrollLeft);
    });
    requestAnimationFrame(() => {
      state.syncingTimelineScroll = false;
    });
  });
}

function getInitialTimelineScrollLeft(element, range) {
  const currentMinute = getCurrentTimelineMinute();
  const focusMinute = Number.isFinite(currentMinute) && currentMinute >= range.start && currentMinute <= range.end
    ? currentMinute
    : range.start;
  const timelineWidth = Number.parseFloat(element.querySelector(".film-schedule-timeline")?.style.getPropertyValue("--timeline-width") || "0");
  const hallColumnWidth = element.querySelector(".film-schedule-hall-label")?.getBoundingClientRect().width || 0;
  const focusX = hallColumnWidth + (toPercent(focusMinute, range) / 100) * timelineWidth;
  const centered = focusX - element.clientWidth / 2;
  return Math.max(0, Math.min(centered, element.scrollWidth - element.clientWidth));
}

function renderTimelineRow(kind, hall, items, range, renderItem) {
  return `
    <div class="film-schedule-row">
      <div class="film-schedule-hall-label">
        <strong>${escapeHtml(hall.name)}</strong>
        ${renderHallStatus(hall)}
        ${kind === "ticketing" ? renderManagedHallToggle(hall) : ""}
      </div>
      <div class="film-schedule-lane">
        ${items.map((item) => renderItem(item, range)).join("")}
      </div>
    </div>
  `;
}

function renderHourTicks(range) {
  const ticks = [];
  const first = Math.ceil(range.start / 60) * 60;
  for (let minute = first; minute <= range.end; minute += 60) {
    const left = toPercent(minute, range);
    ticks.push(`
      <span class="film-schedule-hour" style="left: ${left}%">
        <b>${formatAxisHour(minute)}</b>
      </span>
    `);
  }
  return ticks.join("");
}

function renderTicketingItem(session, range) {
  const scheduled = isSessionScheduled(session);
  const left = toPercent(readItemStartMinutes(session), range);
  const width = toWidthPercent(readItemStartMinutes(session), readItemEndMinutes(session), range);
  const color = getFilmColor(session.filmCd);
  const title = buildScheduleBlockTitle(session.filmName, session.filmVisual, session.filmLanguage);
  return `
    <button
      type="button"
      class="film-schedule-block is-ticketing ${scheduled ? "is-scheduled" : ""}"
      style="left: ${left}%; width: ${width}%; --film-hue: ${color.hue}; --film-accent: ${color.accent}"
      data-ticketing-session="${escapeAttr(session.id)}"
      title="${escapeAttr(title)}"
    >
      <span class="film-schedule-block-title">${escapeHtml(session.filmName)}</span>
      <span class="film-schedule-block-meta">
        ${escapeHtml(formatClock(session.startTime))}-${escapeHtml(formatClock(session.endTime))}
      </span>
      <span class="film-schedule-block-tags">
        ${session.filmVisual ? `<b>${escapeHtml(session.filmVisual)}</b>` : ""}
        ${session.filmLanguage ? `<b>${escapeHtml(session.filmLanguage)}</b>` : ""}
        ${session.soldSeatsCount !== undefined ? `<em>${escapeHtml(String(session.soldSeatsCount))}人</em>` : ""}
        ${session.leastPrice !== undefined ? `<em>${escapeHtml(String(session.leastPrice))}元</em>` : ""}
        ${scheduled ? "<i>已加</i>" : ""}
      </span>
    </button>
  `;
}

function renderPreviewItem(entry, range) {
  if (entry.source === "gdc") {
    return renderGdcScheduleItem(entry, range);
  }

  const left = toPercent(readItemStartMinutes(entry), range);
  const width = toWidthPercent(readItemStartMinutes(entry), readItemEndMinutes(entry), range);
  const color = getFilmColor(entry.filmCd);
  const playlistName = getEntryPlaylistName(entry);
  const title = buildScheduleBlockTitle(entry.filmName, entry.filmVisual, entry.filmLanguage, playlistName);
  return `
    <button
      type="button"
      class="film-schedule-block is-preview"
      style="left: ${left}%; width: ${width}%; --film-hue: ${color.hue}; --film-accent: ${color.accent}"
      data-preview-entry="${escapeAttr(entry.id)}"
      title="${escapeAttr(title)}"
    >
      <span class="film-schedule-block-title">${escapeHtml(entry.filmName)}</span>
      <span class="film-schedule-block-meta">${escapeHtml(formatClock(entry.startTime))}-${escapeHtml(formatClock(getEntryEstimatedEndTime(entry)))}</span>
      ${renderFilmInfoTags(entry)}
    </button>
  `;
}

function renderGdcScheduleItem(schedule, range) {
  const left = toPercent(readItemStartMinutes(schedule), range);
  const width = toWidthPercent(readItemStartMinutes(schedule), readItemEndMinutes(schedule), range);
  const color = getFilmColor(schedule.filmCd);
  const durationHint = schedule.durationEstimated ? " · 时长估算" : "";
  const title = buildScheduleBlockTitle(schedule.filmName, schedule.filmVisual, schedule.filmLanguage, `${schedule.playlistName}${durationHint}`);
  return `
    <div
      class="film-schedule-block is-preview is-gdc"
      style="left: ${left}%; width: ${width}%; --film-hue: ${color.hue}; --film-accent: ${color.accent}"
      title="${escapeAttr(title)}"
    >
      <span class="film-schedule-block-title">${escapeHtml(schedule.filmName)}</span>
      <span class="film-schedule-block-meta">${escapeHtml(formatClock(schedule.startTime))}-${escapeHtml(formatClock(schedule.endTime))}</span>
      ${renderFilmInfoTags(schedule)}
    </div>
  `;
}

function renderFilmInfoTags(item) {
  const tags = [
    item.filmVisual ? `<b>${escapeHtml(item.filmVisual)}</b>` : "",
    item.filmLanguage ? `<b>${escapeHtml(item.filmLanguage)}</b>` : "",
  ].filter(Boolean);
  return tags.length ? `<span class="film-schedule-block-tags">${tags.join("")}</span>` : "";
}

function buildScheduleBlockTitle(...parts) {
  return parts
    .map((part) => String(part || "").trim())
    .filter(Boolean)
    .join(" · ");
}

function openTicketingCustomDialog(session) {
  openCustomDialog(session);
}

function openCustomDialog(session = null) {
  const ticketingSession = isTicketingSessionRecord(session) ? session : null;
  state.selectedSession = ticketingSession;
  clearDialogError(dom.customError);
  dom.customForm.reset();
  renderRuleOptions();
  const matchingRule = ticketingSession ? findRuleForSession(ticketingSession) : null;
  if (matchingRule) {
    dom.ruleSelect.value = matchingRule.id;
  }
  const start = ticketingSession ? normalizeDateTimeLocalValue(ticketingSession.startTime) : getDefaultCustomStartTime();
  dom.customStartInput.value = start;
  renderRuleHallOptions();
  if (ticketingSession && ruleIncludesHall(matchingRule, ticketingSession.hallId)) {
    dom.ruleHallSelect.value = ticketingSession.hallId;
  }
  renderCustomDialogHeading();
  renderCustomSessionSummary();
  renderCustomFeatureAlignOption();
  renderCustomEstimate();
  renderCustomRulePreview();
  renderCustomHallWarning();
  syncCustomSaveButtonState();
  dom.customDialog.showModal();
}

function isTicketingSessionRecord(value) {
  return Boolean(
    value
    && typeof value === "object"
    && typeof value.id === "string"
    && typeof value.hallId === "string"
    && typeof value.filmCd === "string",
  );
}

function renderCustomDialogHeading() {
  const session = state.selectedSession;
  if (session) {
    dom.customTitle.textContent = "添加售票场次";
    dom.customSubtitle.textContent = `${session.hallName} · ${formatClock(session.startTime)}-${formatClock(session.endTime)}`;
    return;
  }
  dom.customTitle.textContent = "自定义排期";
  dom.customSubtitle.textContent = "选择影片放映模板和开始时间";
}

function renderCustomSessionSummary() {
  const session = state.selectedSession;
  if (!session) {
    dom.customSessionSummary.innerHTML = "";
    dom.customSessionSummary.classList.add("hidden");
    return;
  }

  const notices = [];
  if (isSessionScheduled(session)) {
    notices.push(`
      <div class="film-schedule-notice is-muted">
        <i class="fas fa-circle-check"></i>
        <span>该售票场次已经添加到排期预览。</span>
      </div>
    `);
  }
  if (!getSelectedCustomRule()) {
    notices.push(`
      <div class="film-schedule-notice is-warning">
        <i class="fas fa-triangle-exclamation"></i>
        <span>未找到该影片版本对应的影片放映模板，<a href="#/film-playback">前往影片放映模板</a>。</span>
      </div>
    `);
  } else if (shouldRequireManualHallSelection(session)) {
    notices.push(`
      <div class="film-schedule-notice is-warning">
        <i class="fas fa-triangle-exclamation"></i>
        <span>该售票场次原影厅未配置当前影片放映模板，请手动选择实际放映画厅。</span>
      </div>
    `);
  }

  dom.customSessionSummary.innerHTML = `
    ${notices.join("")}
    ${renderSessionSummary(session)}
  `;
  dom.customSessionSummary.classList.remove("hidden");
}

function renderRuleOptions() {
  const rules = [...state.rules].sort((left, right) => (
    left.filmName.localeCompare(right.filmName, "zh-Hans-CN")
    || left.playlistName.localeCompare(right.playlistName, "zh-Hans-CN")
  ));
  const options = rules.map((rule) => `<option value="${escapeAttr(rule.id)}">${escapeHtmlPreservingSpaces(formatRuleSelectLabel(rule))}</option>`);
  if (state.selectedSession && !findRuleForSession(state.selectedSession)) {
    options.unshift(`<option value="">未找到对应影片放映模板</option>`);
  }
  dom.ruleSelect.innerHTML = options.length ? options.join("") : `<option value="">暂无影片放映模板</option>`;
}

function renderEditRuleOptions(entry) {
  const rules = [...state.rules].sort((left, right) => (
    left.filmName.localeCompare(right.filmName, "zh-Hans-CN")
    || left.playlistName.localeCompare(right.playlistName, "zh-Hans-CN")
  ));
  const hasCurrentRule = rules.some((rule) => rule.id === entry.ruleId);
  const options = rules.map((rule) => (
    `<option value="${escapeAttr(rule.id)}">${escapeHtmlPreservingSpaces(formatRuleSelectLabel(rule))}</option>`
  ));
  if (!hasCurrentRule && entry.ruleId) {
    options.unshift(
      `<option value="${escapeAttr(entry.ruleId)}">${escapeHtmlPreservingSpaces(formatRuleSelectLabel(entry.ruleSnapshot || entry))}</option>`,
    );
  }
  dom.editRuleSelect.innerHTML = options.length ? options.join("") : `<option value="">暂无影片放映模板</option>`;
  dom.editRuleSelect.value = entry.ruleId || "";
}

function renderRuleHallOptions() {
  const rule = getSelectedCustomRule();
  if (!rule) {
    dom.ruleHallSelect.innerHTML = `<option value="">请先选择影片放映模板</option>`;
    return;
  }
  const hallIds = Array.isArray(rule.hallIds) ? rule.hallIds : [];
  const requiresManualHall = shouldRequireManualHallSelection(state.selectedSession, rule);
  const hallOptions = hallIds.map((hallId) => (
    `<option value="${escapeAttr(hallId)}">${escapeHtml(getHallName(hallId))}${isHallOffline(hallId) ? "（离线）" : ""}</option>`
  ));
  dom.ruleHallSelect.innerHTML = hallIds.length
    ? `${requiresManualHall ? `<option value="">请选择影厅（售票影厅未配置该模板）</option>` : ""}${hallOptions.join("")}`
    : `<option value="">该影片放映模板未配置影厅</option>`;
  if (state.selectedSession && ruleIncludesHall(rule, state.selectedSession.hallId)) {
    dom.ruleHallSelect.value = state.selectedSession.hallId;
  } else if (requiresManualHall) {
    dom.ruleHallSelect.value = "";
  }
}

function renderEditHallOptions() {
  if (!state.editingEntry) return;
  const rule = getSelectedEditRule();
  if (!rule) {
    dom.editHallSelect.innerHTML = `<option value="">请先选择影片放映模板</option>`;
    return;
  }

  const hallIds = Array.isArray(rule.hallIds) ? [...rule.hallIds] : [];
  if (
    dom.editRuleSelect.value === state.editingEntry.ruleId
    && state.editingEntry.hallId
    && !hallIds.includes(state.editingEntry.hallId)
  ) {
    hallIds.unshift(state.editingEntry.hallId);
  }
  dom.editHallSelect.innerHTML = hallIds.length
    ? hallIds.map((hallId) => (
      `<option value="${escapeAttr(hallId)}">${escapeHtml(getHallName(hallId))}${isHallOffline(hallId) ? "（离线）" : ""}</option>`
    )).join("")
    : `<option value="">该影片放映模板未配置影厅</option>`;
  dom.editHallSelect.value = hallIds.includes(state.editingEntry.hallId)
    ? state.editingEntry.hallId
    : (hallIds[0] || "");
}

function renderCustomEstimate() {
  const rule = getSelectedCustomRule();
  const actualStartTime = getAlignedScheduleStartTime(dom.customStartInput.value, rule, isCustomFeatureAlignChecked());
  dom.customEstimate.textContent = formatScheduleEstimate(actualStartTime, rule);
}

function renderCustomRulePreview() {
  dom.customRulePreview.innerHTML = renderRulePreview(getSelectedCustomRule());
}

function renderEditEstimate() {
  if (!state.editingEntry) {
    dom.editEstimate.textContent = "--";
    return;
  }
  dom.editEstimate.textContent = formatScheduleEstimate(
    dom.editStartInput.value,
    getSelectedEditRule() || state.editingEntry.ruleSnapshot || state.editingEntry,
  );
}

function renderEditRulePreview() {
  dom.editRulePreview.innerHTML = renderRulePreview(getSelectedEditRule() || state.editingEntry?.ruleSnapshot || null);
}

function renderCustomHallWarning() {
  const hallId = dom.ruleHallSelect.value;
  const warning = getOfflineWarningText(hallId);
  if (!warning) {
    dom.customHallWarning.classList.add("hidden");
    dom.customHallWarning.querySelector("span").textContent = "";
    return;
  }
  dom.customHallWarning.querySelector("span").textContent = warning;
  dom.customHallWarning.classList.remove("hidden");
}

function syncCustomSaveButtonState() {
  const session = state.selectedSession;
  const rule = getSelectedCustomRule();
  const hallId = dom.ruleHallSelect.value;
  dom.customSaveBtn.disabled = Boolean(
    !rule || !hallId || (session && isSessionScheduled(session)),
  );
}

function renderCustomFeatureAlignOption() {
  const rule = getSelectedCustomRule();
  const offsetSeconds = getFeatureStartOffsetSeconds(rule);
  const canAlign = offsetSeconds > 0;
  dom.customAlignFeatureInput.disabled = !canAlign;
  dom.customAlignFeatureInput.checked = canAlign;
  updateCustomStartMinimum();
  updateCustomFeatureAlignText();
}

function updateCustomStartMinimum() {
  const rule = getSelectedCustomRule();
  const offsetSeconds = isCustomFeatureAlignChecked() ? getFeatureStartOffsetSeconds(rule) : 0;
  dom.customStartInput.min = addSeconds(getMinimumScheduleStartInputValue(), offsetSeconds);
}

function updateCustomFeatureAlignText() {
  dom.customAlignFeatureText.textContent = getFeatureAlignHelpText(
    getSelectedCustomRule(),
    dom.customStartInput.value,
    isCustomFeatureAlignChecked(),
  );
}

function renderEditHallWarning() {
  const hallId = dom.editHallSelect.value;
  const warning = getOfflineWarningText(hallId);
  if (!warning) {
    dom.editHallWarning.classList.add("hidden");
    dom.editHallWarning.querySelector("span").textContent = "";
    return;
  }
  dom.editHallWarning.querySelector("span").textContent = warning;
  dom.editHallWarning.classList.remove("hidden");
}

async function saveCustomEntry(event) {
  event.preventDefault();
  const session = state.selectedSession;
  const rule = getSelectedCustomRule();
  const hallId = dom.ruleHallSelect.value;
  if (!rule || !hallId) {
    showDialogError(dom.customError, "请选择影片放映模板和影厅。");
    return;
  }
  if (session && isSessionScheduled(session)) {
    showDialogError(dom.customError, "该售票场次已经添加到排期预览。");
    return;
  }
  const actualStartTime = getAlignedScheduleStartTime(dom.customStartInput.value, rule, isCustomFeatureAlignChecked());
  const scheduleTimeWarning = getScheduleTimeWarning(actualStartTime);
  if (scheduleTimeWarning) {
    showDialogError(dom.customError, scheduleTimeWarning);
    return;
  }

  const payload = {
    showDate: state.showDate,
    startTime: actualStartTime,
    endTime: estimateEndTime(actualStartTime, rule),
    hallId,
    hallName: getHallName(hallId),
    finixxHallId: getFinixxHallId(hallId),
    filmCd: rule.filmCd,
    filmName: rule.filmName,
    filmVisual: rule.filmVisual,
    filmLanguage: rule.filmLanguage,
    ruleId: rule.id,
    source: session ? "ticketing" : "custom",
    notes: dom.customNotesInput.value.trim(),
    ...(session ? {
      ticketingSessionId: session.ticketingSessionId || session.id,
      ticketingRaw: session.raw,
    } : {}),
  };
  const overlapWarning = getOverlapWarning(payload.hallId, payload.startTime, payload.endTime);
  if (overlapWarning) {
    showDialogError(dom.customError, overlapWarning);
    return;
  }

  setButtonLoading(dom.customSaveBtn, true);
  clearDialogError(dom.customError);
  try {
    await apiPost("/api/film-schedule/entries", payload);
    toast.success(session ? "排期已添加" : "自定义排期已保存");
    dom.customDialog.close();
    await reloadEntries();
  } catch (error) {
    showDialogError(dom.customError, error.message || (session ? "排期保存失败。" : "自定义排期保存失败。"));
  } finally {
    setButtonLoading(dom.customSaveBtn, false);
    syncCustomSaveButtonState();
  }
}

function openEditDialog(entry) {
  state.editingEntry = entry;
  state.pendingDeleteRuntime = null;
  clearDialogError(dom.editError);
  dom.editSubtitle.textContent = `${entry.hallName} · ${entry.filmName}`;
  renderEditRuleOptions(entry);
  renderEditHallOptions();
  dom.editStartInput.value = entry.startTime;
  dom.editStartInput.min = getMinimumScheduleStartInputValue();
  dom.editNotesInput.value = entry.notes || "";
  renderEditEstimate();
  renderEditRulePreview();
  renderEditHallWarning();
  renderDeleteMonitorWarning();
  dom.editDialog.showModal();
}

async function saveEntryAdjustment(event) {
  event.preventDefault();
  if (!state.editingEntry) return;

  setButtonLoading(dom.editSaveBtn, true);
  clearDialogError(dom.editError);
  try {
    const scheduleTimeWarning = getScheduleTimeWarning(dom.editStartInput.value);
    if (scheduleTimeWarning) {
      throw new Error(scheduleTimeWarning);
    }
    const rule = getSelectedEditRule();
    const hallId = dom.editHallSelect.value;
    if (!rule || !hallId) {
      throw new Error("请选择影片放映模板和影厅。");
    }
    const nextStartTime = dom.editStartInput.value;
    const nextEndTime = estimateEndTime(nextStartTime, rule);
    const overlapWarning = getOverlapWarning(
      hallId,
      nextStartTime,
      nextEndTime,
      state.editingEntry.id,
    );
    if (overlapWarning) {
      throw new Error(overlapWarning);
    }
    await apiPost(`/api/film-schedule/entries/${encodeURIComponent(state.editingEntry.id)}`, {
      showDate: state.showDate,
      startTime: nextStartTime,
      endTime: nextEndTime,
      hallId,
      hallName: getHallName(hallId),
      finixxHallId: getFinixxHallId(hallId),
      filmCd: rule.filmCd,
      filmName: rule.filmName,
      filmVisual: rule.filmVisual,
      filmLanguage: rule.filmLanguage,
      ruleId: rule.id,
      notes: dom.editNotesInput.value.trim(),
    });
    toast.success("排期已调整");
    dom.editDialog.close();
    await reloadEntries();
  } catch (error) {
    showDialogError(dom.editError, error.message || "排期调整失败。");
  } finally {
    setButtonLoading(dom.editSaveBtn, false);
  }
}

async function deleteEditingEntry() {
  if (!state.editingEntry) return;
  setButtonLoading(dom.deleteBtn, true);
  clearDialogError(dom.editError);
  try {
    const runtime = await findActiveScheduleRuntime(state.editingEntry);
    if (runtime) {
      state.pendingDeleteRuntime = runtime;
      renderDeleteMonitorWarning();
      return;
    }
    await performDeleteEditingEntry(dom.deleteBtn);
  } catch (error) {
    showDialogError(dom.editError, error.message || "排期删除失败。");
  } finally {
    setButtonLoading(dom.deleteBtn, false);
  }
}

async function performDeleteEditingEntry(button) {
  if (!state.editingEntry) return;
  setButtonLoading(button, true);
  clearDialogError(dom.editError);
  try {
    await apiDelete(`/api/film-schedule/entries/${encodeURIComponent(state.editingEntry.id)}`);
    toast.success(state.pendingDeleteRuntime ? "排期已删除，播放监控已退出" : "排期已删除");
    state.pendingDeleteRuntime = null;
    dom.editDialog.close();
    await reloadEntries();
  } catch (error) {
    showDialogError(dom.editError, error.message || "排期删除失败。");
  } finally {
    setButtonLoading(button, false);
    renderDeleteMonitorWarning();
  }
}

async function findActiveScheduleRuntime(entry) {
  const payload = await apiGet(`/api/film-scheduler/status?date=${encodeURIComponent(entry.showDate || state.showDate)}`);
  const runtimes = Array.isArray(payload.runtimes) ? payload.runtimes : [];
  return runtimes.find((runtime) => (
    runtime.scheduleId === entry.id
    && runtime.hallId === entry.hallId
    && MONITORED_SCHEDULE_STATUSES.has(runtime.status)
  )) || null;
}

function renderDeleteMonitorWarning() {
  if (!dom.deleteMonitorWarning) {
    return;
  }

  const runtime = state.pendingDeleteRuntime;
  dom.deleteMonitorWarning.classList.toggle("hidden", !runtime);
  if (!runtime) {
    if (dom.deleteMonitorMeta) {
      dom.deleteMonitorMeta.textContent = "";
    }
    return;
  }

  const entry = state.editingEntry;
  const status = getScheduleRuntimeStatusLabel(runtime.status);
  const position = Number.isFinite(runtime.lastPositionSeconds)
    ? formatSeconds(runtime.lastPositionSeconds)
    : "--:--:--";
  if (dom.deleteMonitorMeta && entry) {
    dom.deleteMonitorMeta.textContent = `${entry.hallName} · ${entry.filmName} · ${status} · 位置 ${position}`;
  }
}

function getScheduleRuntimeStatusLabel(status) {
  return {
    pending: "待执行",
    preparing: "准备载入",
    ready: "待开场",
    playing: "场次进行中",
    manual_hold: "人工干预",
    monitor_lost: "监控中断",
    transitioning: "检测中",
  }[status] || "监控中";
}

async function reloadEntries() {
  const payload = await apiGet(`/api/film-schedule/entries?date=${encodeURIComponent(state.showDate)}`);
  state.entries = Array.isArray(payload.entries) ? payload.entries : [];
  state.rules = await loadRelevantPlaybackRules();
  renderAll({ preserveScroll: true });
}

function renderSessionSummary(session) {
  return `
    <div class="film-schedule-summary">
      <strong>${escapeHtml(session.filmName)}</strong>
      <span>${escapeHtml(session.hallName)}</span>
      <span>${escapeHtml(formatClock(session.startTime))}-${escapeHtml(formatClock(session.endTime))}</span>
      <span>${escapeHtml([session.filmVisual, session.filmLanguage].filter(Boolean).join(" · ") || session.filmCd)}</span>
    </div>
  `;
}

function renderRulePreview(rule) {
  if (!rule) {
    return `
      <div class="film-schedule-rule-preview is-empty">
        <span>请选择影片放映模板</span>
      </div>
    `;
  }
  return `
    <div class="film-schedule-rule-preview">
      <div class="film-schedule-rule-preview-head">
        <i class="fas fa-circle-play"></i>
        <div>
          <strong>${escapeHtmlPreservingSpaces(rule.playlistName)}</strong>
          <span>${escapeHtml(formatRuleLabel(rule))}</span>
        </div>
      </div>
      ${renderRuleTimePointTimeline(rule)}
    </div>
  `;
}

function renderRuleTimePointTimeline(rule) {
  const durationSeconds = getEstimatedScheduleDurationSeconds(rule);
  const timeline = getRuleTimelineLayout(rule, durationSeconds);
  const points = Array.isArray(rule.timePoints) ? rule.timePoints : [];
  const markers = points.filter((point) => point.type !== "range" && Number.isFinite(Number(point.startSeconds)));
  const ranges = points.filter((point) => (
    point.type === "range"
    && Number.isFinite(Number(point.startSeconds))
    && Number.isFinite(Number(point.endSeconds))
  ));

  return `
    <div class="film-schedule-timepoint-preview">
      <div class="film-schedule-timepoint-preview-head">
        <span>时间点预览</span>
        <strong>${escapeHtml(formatSecondsClock(durationSeconds))}</strong>
      </div>
      <div class="film-schedule-rule-timeline" style="--rule-timeline-width: ${Math.round(timeline.totalPixelWidth)}px" aria-label="时间点预览">
        <div class="film-schedule-rule-segments">
          ${timeline.segments.map((segment) => `
            <span
              class="film-schedule-rule-segment"
              style="width: ${Math.round(segment.widthPixels)}px"
              title="${escapeAttr(`${segment.title} · ${formatSecondsClock(segment.durationSeconds)}`)}"
            >
              <b>${escapeHtml(segment.title)}</b>
              <span class="film-schedule-rule-command-markers">
                ${segment.commandClusters.length
                  ? segment.commandClusters.map((cluster) => renderRuleCommandMarker(cluster)).join("")
                  : ""}
              </span>
            </span>
          `).join("")}
        </div>
        <div class="film-schedule-rule-timeline-overlay">
          ${ranges.map((range, index) => renderRuleRangeMarker(range, index, timeline)).join("")}
          ${markers.map((marker) => renderRulePointMarker(marker, timeline)).join("")}
        </div>
      </div>
      <div class="film-schedule-rule-point-list">
        ${points.length
          ? points.map((point) => `<span class="is-${escapeAttr(point.type)}">${escapeHtml(formatRulePoint(point))}</span>`).join("")
          : "<span>无时间点</span>"}
      </div>
    </div>
  `;
}

function renderRulePointMarker(point, timeline) {
  const left = timelinePositionPixels(point.startSeconds, timeline);
  return `
    <span class="film-schedule-rule-marker is-${escapeAttr(point.type)}" style="left: ${left}px">
      <span>${escapeHtml(getRulePointShortLabel(point))}</span>
    </span>
  `;
}

function renderRuleRangeMarker(point, index, timeline) {
  const start = Math.min(Number(point.startSeconds), Number(point.endSeconds));
  const end = Math.max(Number(point.startSeconds), Number(point.endSeconds));
  const left = timelinePositionPixels(start, timeline);
  const right = timelinePositionPixels(end, timeline);
  return `
    <span class="film-schedule-rule-range" style="left: ${left}px; width: ${Math.max(right - left, 4)}px">
      <span>${escapeHtml(point.note || `时间段 ${index + 1}`)}</span>
    </span>
  `;
}

function renderRuleCommandMarker(cluster) {
  const left = Math.min(Math.max(cluster.percent, 0), 100);
  const title = cluster.items
    .map((item) => `${item.command.label} · ${formatSecondsClock(item.offsetSeconds)}`)
    .join("\n");
  return `
    <span class="film-schedule-rule-command-marker ${cluster.items.length > 1 ? "is-cluster" : ""}" style="left: ${left}%" title="${escapeAttr(title)}">
      <span class="film-schedule-rule-command-triangle"></span>
      ${cluster.items.length > 1 ? `<span class="film-schedule-rule-command-count">${cluster.items.length}</span>` : ""}
    </span>
  `;
}

function findRuleForSession(session) {
  return getRulesForSession(session)[0] || null;
}

function getRulesForSession(session) {
  return state.rules.filter((rule) => ruleMatchesSession(rule, session));
}

function ruleMatchesSession(rule, session) {
  return Boolean(
    rule
    && session
    && rule.filmCd === session.filmCd
  );
}

function ruleIncludesHall(rule, hallId) {
  return Boolean(rule && hallId && Array.isArray(rule.hallIds) && rule.hallIds.includes(hallId));
}

function shouldRequireManualHallSelection(session, rule = getSelectedCustomRule()) {
  return Boolean(session && rule && !ruleIncludesHall(rule, session.hallId));
}

function getSelectedCustomRule() {
  return state.rules.find((rule) => rule.id === dom.ruleSelect.value) || null;
}

function isCustomFeatureAlignChecked() {
  return Boolean(dom.customAlignFeatureInput && !dom.customAlignFeatureInput.disabled && dom.customAlignFeatureInput.checked);
}

function canAlignFeatureStart(rule) {
  return getFeatureStartOffsetSeconds(rule) > 0;
}

function getFeatureStartOffsetSeconds(rule) {
  const point = Array.isArray(rule?.timePoints)
    ? rule.timePoints.find((item) => item?.type === "head")
    : null;
  const seconds = Number(point?.startSeconds);
  return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds) : 0;
}

function getAlignedScheduleStartTime(startTime, rule, alignFeatureStart) {
  if (!startTime) {
    return startTime;
  }
  const offsetSeconds = alignFeatureStart ? getFeatureStartOffsetSeconds(rule) : 0;
  return offsetSeconds > 0 ? addSeconds(startTime, -offsetSeconds) : startTime;
}

function getFeatureAlignHelpText(rule, intendedStartTime, checked) {
  if (!canAlignFeatureStart(rule)) {
    return "影片放映模板未设置正片开始时间";
  }
  if (!checked) {
    return "按填写时间创建排期";
  }
  const actualStartTime = getAlignedScheduleStartTime(intendedStartTime, rule, true);
  return `实际会在 ${formatDateTimeText(actualStartTime)} 创建排期`;
}

function getSelectedEditRule() {
  const ruleId = dom.editRuleSelect.value;
  const rule = state.rules.find((item) => item.id === ruleId);
  if (rule) {
    return rule;
  }
  if (state.editingEntry?.ruleId === ruleId) {
    return {
      ...(state.editingEntry.ruleSnapshot || {}),
      id: state.editingEntry.ruleId,
      filmCd: state.editingEntry.filmCd,
      filmName: state.editingEntry.filmName,
      filmVisual: state.editingEntry.filmVisual,
      filmLanguage: state.editingEntry.filmLanguage,
    };
  }
  return null;
}

function getEntryPlaylistName(entry) {
  const rule = state.rules.find((item) => item.id === entry.ruleId);
  return entry.ruleSnapshot?.playlistName || rule?.playlistName || "未命名播放表";
}

function isSessionScheduled(session) {
  return state.entries.some((entry) => (
    (session.ticketingSessionId && entry.ticketingSessionId === session.ticketingSessionId)
    || (entry.hallId === session.hallId && entry.filmCd === session.filmCd && entry.startTime === session.startTime)
  ));
}

function getOverlapWarning(hallId, startTime, endTime, ignoreEntryId = "") {
  const conflict = findScheduleOverlap(hallId, startTime, endTime, ignoreEntryId);
  if (!conflict) {
    return "";
  }
  if (conflict.source === "gdc") {
    return `该影厅 ${formatClock(startTime)}-${formatClock(endTime)} 已与 GDC内置排期 ${formatClock(conflict.startTime)}-${formatClock(getEntryEstimatedEndTime(conflict))} 重叠。`;
  }
  return `该影厅 ${formatClock(startTime)}-${formatClock(endTime)} 已与 ${conflict.filmName} ${formatClock(conflict.startTime)}-${formatClock(getEntryEstimatedEndTime(conflict))} 重叠。`;
}

function findScheduleOverlap(hallId, startTime, endTime, ignoreEntryId = "") {
  const start = new Date(startTime).getTime();
  const end = new Date(endTime).getTime();
  if (!hallId || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    return null;
  }
  return [...state.entries, ...state.gdcSchedules].find((entry) => {
    if (entry.id === ignoreEntryId || entry.hallId !== hallId) {
      return false;
    }
    const entryStart = new Date(entry.startTime).getTime();
    const entryEnd = new Date(getEntryEstimatedEndTime(entry)).getTime();
    if (!Number.isFinite(entryStart) || !Number.isFinite(entryEnd) || entryEnd <= entryStart) {
      return false;
    }
    return start < entryEnd && end > entryStart;
  }) || null;
}

function groupHalls(items) {
  return [...new Map(items.map((item) => [
    item.hallId,
    {
      id: item.hallId,
      name: item.hallName || getHallName(item.hallId),
      finixxHallId: item.finixxHallId || getFinixxHallId(item.hallId),
      online: getHallOnline(item.hallId),
    },
  ])).values()].sort((left, right) => left.name.localeCompare(right.name, "zh-Hans-CN"));
}

function getPreviewHalls() {
  const configured = state.halls.map((hall) => ({ ...hall }));
  const missingEntryHalls = groupHalls([...state.entries, ...state.gdcSchedules])
    .filter((hall) => !configured.some((item) => item.id === hall.id));
  return [...configured, ...missingEntryHalls]
    .sort((left, right) => left.name.localeCompare(right.name, "zh-Hans-CN"));
}

function getTimelineRange(items) {
  const minutes = items.flatMap((item) => [readItemStartMinutes(item), readItemEndMinutes(item)])
    .filter((value) => Number.isFinite(value));
  if (!minutes.length) {
    return { start: DEFAULT_START_HOUR * 60, end: DEFAULT_END_HOUR * 60 };
  }
  const start = Math.max(0, Math.floor((Math.min(...minutes) - 30) / 60) * 60);
  const end = Math.max(DEFAULT_END_HOUR * 60, Math.ceil((Math.max(...minutes) + 30) / 60) * 60);
  return { start, end };
}

function readItemStartMinutes(item) {
  if (Number.isFinite(item.startMinutes)) return item.startMinutes;
  return minutesFromDateTime(item.startTime);
}

function readItemEndMinutes(item) {
  if (Number.isFinite(item.endMinutes)) return item.endMinutes;
  return minutesFromDateTime(getEntryEstimatedEndTime(item));
}

function getEntryEstimatedEndTime(entry) {
  if (entry?.source === "gdc" && entry.endTime) {
    return entry.endTime;
  }
  return estimateEndTime(entry.startTime, entry.ruleSnapshot || entry);
}

function estimateEndTime(startTime, ruleLike) {
  const durationSeconds = getEstimatedScheduleDurationSeconds(ruleLike);
  return addSeconds(startTime, durationSeconds);
}

function getEstimatedScheduleDurationSeconds(ruleLike) {
  const directDurationSeconds = Number(ruleLike?.durationSeconds);
  if (Number.isFinite(directDurationSeconds) && directDurationSeconds > 0) {
    return Math.max(1, Math.round(directDurationSeconds));
  }

  const playlistDurationSeconds = getRulePlaylistDurationSeconds(ruleLike);
  if (playlistDurationSeconds > 0) {
    return Math.max(1, Math.round(playlistDurationSeconds));
  }

  const filmDuration = readNestedNumber(ruleLike?.rawFilm, ["filmDuration", "duration", "runningTime"]);
  if (filmDuration > 0) {
    return Math.max(1, Math.round(filmDuration * 60));
  }

  return 120 * 60;
}

function getRulePlaylistDurationSeconds(ruleLike) {
  const details = Array.isArray(ruleLike?.playlistSnapshot?.details)
    ? ruleLike.playlistSnapshot.details
    : [];
  const detail = details[0];
  const segmentDetails = Array.isArray(detail?.segmentDetails) ? detail.segmentDetails : [];
  const duration = segmentDetails.reduce((sum, cpl) => {
    const seconds = Number(cpl?.durationSeconds);
    return Number.isFinite(seconds) && seconds > 0 ? sum + seconds : sum;
  }, 0);

  if (duration > 0) {
    return duration;
  }

  const segments = Array.isArray(detail?.segments) ? detail.segments : [];
  return segments.reduce((sum, segment) => {
    const seconds = readNestedNumber(segment, ["durationSeconds"]);
    return seconds > 0 ? sum + seconds : sum;
  }, 0);
}

function getRuleTimelineLayout(ruleLike, fallbackDurationSeconds) {
  const details = Array.isArray(ruleLike?.playlistSnapshot?.details)
    ? ruleLike.playlistSnapshot.details
    : [];
  const detail = details[0] || {};
  const segmentDetails = Array.isArray(detail.segmentDetails) ? detail.segmentDetails : [];
  const segments = Array.isArray(detail.segments) ? detail.segments : [];
  const count = Math.max(segmentDetails.length, segments.length);
  const items = Array.from({ length: count }, (_, index) => {
    const cpl = segmentDetails[index] || {};
    const segment = segments[index] || {};
    const durationSeconds = getRuleSegmentDurationSeconds(detail, index);
    const title = cpl.contentTitleText
        || cpl.annotationText
        || cpl.title
        || cpl.cplUuid
        || segment.title
        || segment.cplUuid
        || `CPL ${index + 1}`;
      return {
        commandClusters: clusterRuleCommands(segment.commands || [], durationSeconds, cpl),
        durationSeconds,
        title: String(title),
      };
    })
    .filter((item) => item.durationSeconds > 0);

  if (!items.length) {
    const widthPixels = getRuleSegmentPixelWidth(fallbackDurationSeconds);
    return {
      segments: [{ durationSeconds: fallbackDurationSeconds, title: ruleLike?.playlistName || "播放表", widthPixels }],
      totalPixelWidth: widthPixels,
    };
  }

  const timelineSegments = items.map((item) => ({
    ...item,
    widthPixels: getRuleSegmentPixelWidth(item.durationSeconds),
  }));
  return {
    segments: timelineSegments,
    totalPixelWidth: timelineSegments.reduce((sum, item) => sum + item.widthPixels, 0),
  };
}

function getRuleSegmentDurationSeconds(detail, index) {
  const cpl = detail.segmentDetails?.[index] || {};
  const segment = detail.segments?.[index] || {};
  const fromCpl = Number(cpl.durationSeconds);
  if (Number.isFinite(fromCpl) && fromCpl > 0) {
    return fromCpl;
  }
  const fromSegment = Number(segment.durationSeconds);
  if (Number.isFinite(fromSegment) && fromSegment > 0) {
    return fromSegment;
  }
  return 0;
}

function getRuleSegmentPixelWidth(durationSeconds) {
  return Math.min(
    Math.max(durationSeconds * RULE_TIMELINE_PIXELS_PER_SECOND, RULE_TIMELINE_MIN_SEGMENT_WIDTH),
    RULE_TIMELINE_MAX_SEGMENT_WIDTH,
  );
}

function timelinePositionPixels(seconds, timeline) {
  let remainingSeconds = Math.max(0, Number(seconds) || 0);
  let offsetPixels = 0;

  for (const segment of timeline.segments) {
    if (segment.durationSeconds <= 0) {
      offsetPixels += segment.widthPixels;
      continue;
    }
    if (remainingSeconds <= segment.durationSeconds) {
      return offsetPixels + (remainingSeconds / segment.durationSeconds) * segment.widthPixels;
    }
    remainingSeconds -= segment.durationSeconds;
    offsetPixels += segment.widthPixels;
  }

  return Math.min(offsetPixels, timeline.totalPixelWidth);
}

function clusterRuleCommands(commands, durationSeconds, cpl) {
  if (!Array.isArray(commands) || commands.length === 0) {
    return [];
  }
  const positioned = commands
    .map((command) => {
      const offsetSeconds = getRuleCommandOffsetSeconds(command, cpl);
      const percent = durationSeconds > 0 ? Math.min(Math.max((offsetSeconds / durationSeconds) * 100, 0), 100) : 0;
      return {
        command: {
          ...command,
          label: command.label || command.annotationText || "命令",
        },
        offsetSeconds,
        percent,
      };
    })
    .sort((left, right) => left.percent - right.percent);

  const clusters = [];
  for (const item of positioned) {
    const last = clusters[clusters.length - 1];
    if (!last || Math.abs(item.percent - last.percent) > 4) {
      clusters.push({ percent: item.percent, items: [item] });
      continue;
    }
    last.items.push(item);
    last.percent = last.items.reduce((sum, entry) => sum + entry.percent, 0) / last.items.length;
  }
  return clusters;
}

function getRuleCommandOffsetSeconds(command, cpl) {
  const explicitSeconds = Number(command?.offsetSeconds);
  if (Number.isFinite(explicitSeconds)) {
    return Math.max(0, Math.round(explicitSeconds));
  }
  const fps = parseEditRateFps(command?.editRate) || parseEditRateFps(cpl?.editRate) || 24;
  return Math.max(0, Math.round((Number(command?.offsetFrames) || 0) / fps));
}

function parseEditRateFps(editRate) {
  const parts = String(editRate || "").trim().split(/\s+/).map((part) => Number(part));
  if (!Number.isFinite(parts[0]) || parts[0] <= 0) {
    return undefined;
  }
  const denominator = Number.isFinite(parts[1]) && parts[1] > 0 ? parts[1] : 1;
  return parts[0] / denominator;
}

function readNestedNumber(value, keys) {
  const normalizedKeys = new Set(keys.map((key) => key.toLowerCase()));
  const stack = [value];
  const visited = new Set();
  while (stack.length) {
    const current = stack.pop();
    if (!current || typeof current !== "object" || visited.has(current)) continue;
    visited.add(current);
    if (Array.isArray(current)) {
      stack.push(...current);
      continue;
    }
    for (const [key, raw] of Object.entries(current)) {
      if (normalizedKeys.has(key.toLowerCase())) {
        const parsed = Number(raw);
        if (Number.isFinite(parsed)) return parsed;
      }
      if (raw && typeof raw === "object") {
        stack.push(raw);
      }
    }
  }
  return 0;
}

function formatScheduleEstimate(startTime, ruleLike) {
  if (!startTime || !ruleLike) {
    return "--";
  }
  const durationSeconds = getEstimatedScheduleDurationSeconds(ruleLike);
  const hours = Math.floor(durationSeconds / 3600);
  const minutes = Math.floor((durationSeconds % 3600) / 60);
  const seconds = durationSeconds % 60;
  const durationText = [
    hours > 0 ? `${hours}小时` : "",
    minutes > 0 ? `${minutes}分` : "",
    seconds > 0 ? `${seconds}秒` : "",
  ].filter(Boolean).join("") || "0秒";
  return `约 ${durationText}（至 ${formatClock(estimateEndTime(startTime, ruleLike))}）`;
}

function minutesFromDateTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return Number.NaN;
  const base = new Date(`${state.showDate}T00:00:00`);
  return (date.getTime() - base.getTime()) / 60000;
}

function toPercent(minute, range) {
  return ((minute - range.start) / Math.max(1, range.end - range.start)) * 100;
}

function toWidthPercent(start, end, range) {
  const duration = Math.max(MIN_BLOCK_MINUTES, end - start);
  return (duration / Math.max(1, range.end - range.start)) * 100;
}

function normalizeRuntimeHalls(halls) {
  return halls.map((hall) => ({
    id: hall?.registration?.hallId || hall?.id || "",
    name: hall?.registration?.hallName || hall?.name || hall?.registration?.hallId || "未命名影厅",
    finixxHallId: hall?.registration?.finixxHallId || hall?.finixxHallId || hall?.registration?.hallId || "",
    online: hall?.snapshot?.connectivity?.state === "online",
  })).filter((hall) => hall.id);
}

function getHallName(hallId) {
  return state.halls.find((hall) => hall.id === hallId)?.name || hallId;
}

function getFinixxHallId(hallId) {
  return state.halls.find((hall) => hall.id === hallId)?.finixxHallId || "";
}

function getHallOnline(hallId) {
  const hall = state.halls.find((item) => item.id === hallId);
  return hall ? hall.online : false;
}

function isHallOffline(hallId) {
  return !getHallOnline(hallId);
}

function renderHallStatus(hall) {
  const online = hall.online === true;
  const label = online ? "在线" : "离线";
  return `<span class="film-schedule-hall-status ${online ? "is-online" : "is-offline"}">${escapeHtml(label)}</span>`;
}

function renderManagedHallToggle(hall) {
  const enabled = state.managedHallIds.has(hall.id);
  const saving = state.managedHallSavingIds.has(hall.id);
  const options = state.managedHallOptions.get(hall.id);
  const autoDisableText = options?.autoDisableAt ? `，自动关闭：${formatDateTimeText(options.autoDisableAt)}` : "";
  const title = enabled
    ? `自动托管售票排期${options?.alignFeatureStart === false ? "" : "，对齐正片时间"}${autoDisableText}`
    : "自动托管售票排期";
  return `
    <label class="film-schedule-managed-toggle ${enabled ? "is-enabled" : ""}" title="${escapeAttr(title)}">
      <input
        type="checkbox"
        class="toggle toggle-xs"
        value="${escapeAttr(hall.id)}"
        data-managed-hall-toggle="1"
        ${enabled ? "checked" : ""}
        ${saving ? "disabled" : ""}
      >
      <span>${enabled ? "托管中" : "托管"}</span>
    </label>
  `;
}

function handleManagedHallToggleChange(input) {
  const hallId = input.value;
  if (!hallId || state.managedHallSavingIds.has(hallId)) {
    renderAll({ preserveScroll: true });
    return;
  }
  if (input.checked) {
    openManagedDialog(hallId);
    return;
  }
  const options = state.managedHallOptions.get(hallId);
  void toggleManagedHall(hallId, false, {
    alignFeatureStart: options?.alignFeatureStart !== false,
    autoDisableAt: options?.autoDisableAt || "",
  });
}

function openManagedDialog(hallId) {
  state.pendingManagedHallId = hallId;
  clearDialogError(dom.managedError);
  dom.managedHallName.textContent = getHallName(hallId);
  const options = state.managedHallOptions.get(hallId);
  dom.managedAlignFeatureInput.checked = options?.alignFeatureStart !== false;
  dom.managedAutoDisableEnabledInput.checked = true;
  dom.managedAutoDisableInput.value = getManagedAutoDisableInputValue(options?.autoDisableAt, state.lastManagedAutoDisableAt);
  dom.managedAutoDisableInput.min = floorDateTimeToMinute(getMinimumScheduleStartInputValue()).slice(0, 16);
  syncManagedAutoDisableInput();
  dom.managedDialog.showModal();
}

function closeManagedDialog() {
  dom.managedDialog.close();
}

async function saveManagedHallOptions(event) {
  event.preventDefault();
  const hallId = state.pendingManagedHallId;
  if (!hallId) {
    closeManagedDialog();
    return;
  }
  setButtonLoading(dom.managedSaveBtn, true);
  clearDialogError(dom.managedError);
  try {
    await toggleManagedHall(hallId, true, {
      alignFeatureStart: dom.managedAlignFeatureInput.checked,
      autoDisableAt: readManagedAutoDisableAtOrEmpty(),
      suppressRender: true,
    });
    closeManagedDialog();
  } catch (error) {
    showDialogError(dom.managedError, error.message || "托管设置保存失败。");
  } finally {
    setButtonLoading(dom.managedSaveBtn, false);
  }
}

async function toggleManagedHall(hallId, enabled, options = {}) {
  if (!hallId || state.managedHallSavingIds.has(hallId)) {
    return;
  }

  state.managedHallSavingIds.add(hallId);
  if (!options.suppressRender) {
    renderAll({ preserveScroll: true });
  }
  try {
    const alignFeatureStart = options.alignFeatureStart !== false;
    const autoDisableAt = enabled ? options.autoDisableAt || "" : "";
    const payload = await apiPost(`/api/film-scheduler/managed-halls/${encodeURIComponent(hallId)}`, {
      enabled,
      alignFeatureStart,
      autoDisableAt,
    });
    if (payload.managedHall?.hallId) {
      state.managedHallOptions.set(payload.managedHall.hallId, {
        hallId: payload.managedHall.hallId,
        enabled: payload.managedHall.enabled === true,
        alignFeatureStart: payload.managedHall.alignFeatureStart !== false,
        autoDisableAt: normalizeDateTimeLocalValue(String(payload.managedHall.autoDisableAt || "")),
      });
    }
    if (payload.managedHall?.enabled) {
      state.managedHallIds.add(hallId);
      toast.success(`${getHallName(hallId)} 已开启自动托管`);
    } else {
      state.managedHallIds.delete(hallId);
      toast.info(`${getHallName(hallId)} 已关闭自动托管`);
    }
  } catch (error) {
    if (options.suppressRender) {
      throw error;
    }
    toast.error(error.message || "托管设置保存失败。");
  } finally {
    state.managedHallSavingIds.delete(hallId);
    if (!options.suppressRender) {
      renderAll({ preserveScroll: true });
    }
  }
}

function readManagedAutoDisableAtOrEmpty() {
  if (!dom.managedAutoDisableEnabledInput.checked) {
    state.lastManagedAutoDisableAt = "";
    return "";
  }
  const value = normalizeDateTimeLocalValue(dom.managedAutoDisableInput.value || "");
  if (!value) {
    throw new Error("请选择自动关闭时间。");
  }
  if (new Date(value).getTime() <= Date.now()) {
    throw new Error("自动关闭时间必须晚于当前时间。");
  }
  state.lastManagedAutoDisableAt = value;
  return value;
}

function syncManagedAutoDisableInput() {
  const enabled = dom.managedAutoDisableEnabledInput.checked;
  dom.managedAutoDisableInput.disabled = !enabled;
  dom.managedAutoDisableInput.required = enabled;
  if (enabled && !dom.managedAutoDisableInput.value) {
    dom.managedAutoDisableInput.value = getDefaultManagedAutoDisableAt().slice(0, 16);
  }
}

function getManagedAutoDisableInputValue(...values) {
  for (const value of values) {
    const normalized = normalizeDateTimeLocalValue(String(value || ""));
    if (normalized && new Date(normalized).getTime() > Date.now()) {
      return normalized.slice(0, 16);
    }
  }
  return getDefaultManagedAutoDisableAt().slice(0, 16);
}

function getDefaultManagedAutoDisableAt() {
  const date = new Date();
  date.setHours(23, 59, 0, 0);
  return formatDateTimeLocal(date);
}

function getOfflineWarningText(hallId) {
  if (!hallId || !isHallOffline(hallId)) {
    return "";
  }
  return `${getHallName(hallId)} 当前离线，仍可保存排期；实际执行需要确保影厅在线。`;
}

function renderOfflineWarning(hallId) {
  const warning = getOfflineWarningText(hallId);
  return warning
    ? `<div class="film-schedule-notice is-warning"><i class="fas fa-triangle-exclamation"></i><span>${escapeHtml(warning)}</span></div>`
    : "";
}

function renderNowOverlay(range, width) {
  const currentMinute = getCurrentTimelineMinute();
  if (!Number.isFinite(currentMinute) || currentMinute < range.start || currentMinute > range.end) {
    return "";
  }
  const nowLeft = Math.round((toPercent(currentMinute, range) / 100) * width);
  return `
    <div class="film-schedule-now-shade" style="width: ${nowLeft}px"></div>
    <div class="film-schedule-now-line" style="left: calc(var(--hall-col-width) + ${nowLeft}px)">
      <span>${escapeHtml(formatNowTime(currentMinute))}</span>
    </div>
  `;
}

function getCurrentTimelineMinute() {
  if (state.showDate !== todayDate()) {
    return Number.NaN;
  }
  const now = new Date();
  return now.getHours() * 60 + now.getMinutes();
}

function formatNowTime(minute) {
  return `${formatAxisHour(minute)}:${String(minute % 60).padStart(2, "0")}`;
}

function formatRuleLabel(rule) {
  return `${rule.filmName}${rule.filmVisual ? ` · ${rule.filmVisual}` : ""}${rule.filmLanguage ? ` · ${rule.filmLanguage}` : ""}`;
}

function formatRuleSelectLabel(rule) {
  const playlistName = rule.playlistName || "未命名播放表";
  return `${formatRuleLabel(rule)} (${playlistName})`;
}

function formatRulePoint(point) {
  const note = point.note || "时间点";
  if (point.type === "range") {
    return `${note} ${formatSeconds(point.startSeconds)}-${formatSeconds(point.endSeconds)}`;
  }
  return `${note} ${formatSeconds(point.startSeconds)}`;
}

function getRulePointShortLabel(point) {
  if (point.type === "head") return "正片";
  if (point.type === "tail") return "片尾";
  return point.note || "时间点";
}

function formatSeconds(value) {
  const seconds = Math.max(0, Math.round(Number(value) || 0));
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

function formatSecondsClock(value) {
  const totalSeconds = Math.max(0, Math.round(Number(value) || 0));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function formatAxisHour(minute) {
  const normalized = Math.floor(minute / 60) % 24;
  return String(normalized).padStart(2, "0");
}

function formatClock(value) {
  if (!value) return "--:--";
  const normalized = normalizeDateTimeLocalValue(String(value));
  return normalized ? normalized.slice(11, 19) : "--:--";
}

function formatDateTimeText(value) {
  const normalized = normalizeDateTimeLocalValue(String(value || ""));
  return normalized ? normalized.replace("T", " ") : "--";
}

function addSeconds(value, seconds) {
  const date = new Date(value);
  date.setSeconds(date.getSeconds() + seconds);
  return formatDateTimeLocal(date);
}

function getDefaultCustomStartTime() {
  const dateStart = `${state.showDate}T10:00:00`;
  const minimum = getMinimumScheduleStartInputValue();
  if (new Date(dateStart).getTime() >= new Date(minimum).getTime()) {
    return dateStart;
  }
  return floorDateTimeToMinute(minimum);
}

function getMinimumScheduleStartInputValue() {
  return formatDateTimeLocal(new Date(Date.now() + 60_000));
}

function getScheduleTimeWarning(startTime) {
  const start = new Date(startTime);
  const minimum = new Date(Date.now() + 60_000);
  if (Number.isNaN(start.getTime())) {
    return "排期开始时间格式不正确。";
  }
  if (start.getTime() < minimum.getTime()) {
    return "只能添加未来排期，开始时间不得早于当前时间 1 分钟后。";
  }
  return "";
}

function formatDateTimeLocal(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}T${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}:${String(date.getSeconds()).padStart(2, "0")}`;
}

function floorDateTimeToMinute(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  date.setSeconds(0, 0);
  return formatDateTimeLocal(date);
}

function normalizeDateTimeLocalValue(value) {
  const match = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/.exec(value);
  if (!match) {
    return "";
  }
  return `${match[1]}T${match[2]}:${match[3]}:${match[4] || "00"}`;
}

function todayDate() {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function refreshFilmColorMap() {
  const films = [...new Map([...state.ticketingSessions, ...state.entries, ...state.gdcSchedules].map((item) => [
    item.filmCd,
    {
      filmCd: item.filmCd,
      filmName: item.filmName || item.filmCd,
    },
  ])).values()]
    .filter((film) => film.filmCd)
    .sort((left, right) => left.filmName.localeCompare(right.filmName, "zh-Hans-CN") || left.filmCd.localeCompare(right.filmCd));

  state.filmColors = new Map(films.map((film, index) => [
    film.filmCd,
    FILM_ACCENT_PALETTE[index % FILM_ACCENT_PALETTE.length] || fallbackFilmColor(index),
  ]));
}

function getFilmColor(filmCd) {
  return state.filmColors.get(filmCd) || fallbackFilmColor(hashFilmCode(filmCd));
}

function fallbackFilmColor(seed) {
  const hue = (Number(seed) * 47 + 198) % 360;
  return { hue, accent: hue };
}

function hashFilmCode(filmCd) {
  let hash = 0;
  for (const char of String(filmCd || "")) {
    hash = (hash * 31 + char.charCodeAt(0)) % 997;
  }
  return hash;
}

function setBusy(busy) {
  state.busy = busy;
  dom.refreshBtn.disabled = busy;
  dom.ticketingStatus.textContent = busy ? "加载中" : state.showDate;
}

function setButtonLoading(button, loading) {
  button.disabled = loading;
  button.classList.toggle("loading", loading);
}

function renderError(message) {
  if (!message) {
    dom.error.classList.add("hidden");
    dom.error.querySelector("span").textContent = "";
    return;
  }
  dom.error.querySelector("span").textContent = message;
  dom.error.classList.remove("hidden");
}

function clearDialogError(node) {
  node.textContent = "";
  node.classList.add("hidden");
}

function showDialogError(node, message) {
  node.textContent = message;
  node.classList.remove("hidden");
}

function parseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function escapeHtmlPreservingSpaces(value) {
  return escapeHtml(value).replace(/ {2,}/g, (spaces) => "&nbsp;".repeat(spaces.length));
}

function escapeAttr(value) {
  return escapeHtml(value).replaceAll("'", "&#39;");
}
