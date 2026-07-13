import { apiDelete, apiGet, apiPost, getRuntimeHalls } from "../api.js";
import { toast } from "../toast.js";

const REFRESH_INTERVAL_MS = 60_000;
const PALETTE = [198, 142, 36, 326, 262, 18, 174, 52, 286, 222, 96, 348];
const MONITORED_SCHEDULE_STATUSES = new Set(["pending", "preparing", "ready", "playing", "manual_hold", "monitor_lost", "transitioning"]);
const RULE_TIMELINE_PIXELS_PER_SECOND = 0.024;
const RULE_TIMELINE_MIN_SEGMENT_WIDTH = 44;
const RULE_TIMELINE_MAX_SEGMENT_WIDTH = 220;

const state = {
  showDate: "",
  activeSource: "ticketing",
  activeHallId: "all",
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
  pendingManagedHallId: "",
  lastManagedAutoDisableAt: "",
  selectedSession: null,
  addRules: [],
  editingEntry: null,
  editRules: [],
  pendingDeleteRuntime: null,
  pendingRender: false,
  timer: null,
  busy: false,
};

const dom = {};

export function initFilmScheduleMobilePage() {
  cacheDom();
  bindEvents();
  state.showDate = todayDate();
  state.activeSource = "ticketing";
  state.activeHallId = "all";
  dom.dateInput.value = state.showDate;
  startTimer();
  void loadMobileData();
}

export function disposeFilmScheduleMobilePage() {
  stopTimer();
}

function cacheDom() {
  Object.assign(dom, {
    root: document.getElementById("filmScheduleMobileRoot"),
    refreshBtn: document.getElementById("filmScheduleMobileRefreshBtn"),
    dateInput: document.getElementById("filmScheduleMobileDateInput"),
    hallFilter: document.getElementById("filmScheduleMobileHallFilter"),
    notice: document.getElementById("filmScheduleMobileNotice"),
    title: document.getElementById("filmScheduleMobileTitle"),
    subtitle: document.getElementById("filmScheduleMobileSubtitle"),
    count: document.getElementById("filmScheduleMobileCount"),
    customBtn: document.getElementById("filmScheduleMobileCustomBtn"),
    content: document.getElementById("filmScheduleMobileContent"),
    managedDialog: document.getElementById("filmScheduleMobileManagedDialog"),
    managedForm: document.getElementById("filmScheduleMobileManagedForm"),
    managedHallName: document.getElementById("filmScheduleMobileManagedHallName"),
    managedCloseBtn: document.getElementById("filmScheduleMobileManagedCloseBtn"),
    managedCancelBtn: document.getElementById("filmScheduleMobileManagedCancelBtn"),
    managedAlignFeatureInput: document.getElementById("filmScheduleMobileManagedAlignFeatureInput"),
    managedAutoDisableEnabledInput: document.getElementById("filmScheduleMobileManagedAutoDisableEnabledInput"),
    managedAutoDisableInput: document.getElementById("filmScheduleMobileManagedAutoDisableInput"),
    managedError: document.getElementById("filmScheduleMobileManagedError"),
    managedSaveBtn: document.getElementById("filmScheduleMobileManagedSaveBtn"),
    addDialog: document.getElementById("filmScheduleMobileAddDialog"),
    addForm: document.getElementById("filmScheduleMobileAddForm"),
    addTitle: document.getElementById("filmScheduleMobileAddTitle"),
    addSubtitle: document.getElementById("filmScheduleMobileAddSubtitle"),
    addCloseBtn: document.getElementById("filmScheduleMobileAddCloseBtn"),
    addCancelBtn: document.getElementById("filmScheduleMobileAddCancelBtn"),
    addSessionSummary: document.getElementById("filmScheduleMobileAddSessionSummary"),
    addRuleSelect: document.getElementById("filmScheduleMobileAddRuleSelect"),
    addHallSelect: document.getElementById("filmScheduleMobileAddHallSelect"),
    addStartInput: document.getElementById("filmScheduleMobileAddStartInput"),
    addHallWarning: document.getElementById("filmScheduleMobileAddHallWarning"),
    addEstimate: document.getElementById("filmScheduleMobileAddEstimate"),
    addRulePreview: document.getElementById("filmScheduleMobileAddRulePreview"),
    addAlignFeatureInput: document.getElementById("filmScheduleMobileAddAlignFeatureInput"),
    addAlignFeatureText: document.getElementById("filmScheduleMobileAddAlignFeatureText"),
    addNotesInput: document.getElementById("filmScheduleMobileAddNotesInput"),
    addError: document.getElementById("filmScheduleMobileAddError"),
    addSaveBtn: document.getElementById("filmScheduleMobileAddSaveBtn"),
    editDialog: document.getElementById("filmScheduleMobileEditDialog"),
    editForm: document.getElementById("filmScheduleMobileEditForm"),
    editSubtitle: document.getElementById("filmScheduleMobileEditSubtitle"),
    editCloseBtn: document.getElementById("filmScheduleMobileEditCloseBtn"),
    editCancelBtn: document.getElementById("filmScheduleMobileEditCancelBtn"),
    editRuleSelect: document.getElementById("filmScheduleMobileEditRuleSelect"),
    editHallSelect: document.getElementById("filmScheduleMobileEditHallSelect"),
    editStartInput: document.getElementById("filmScheduleMobileEditStartInput"),
    editHallWarning: document.getElementById("filmScheduleMobileEditHallWarning"),
    editEstimate: document.getElementById("filmScheduleMobileEditEstimate"),
    editRulePreview: document.getElementById("filmScheduleMobileEditRulePreview"),
    editNotesInput: document.getElementById("filmScheduleMobileEditNotesInput"),
    editError: document.getElementById("filmScheduleMobileEditError"),
    editDeleteWarning: document.getElementById("filmScheduleMobileEditDeleteWarning"),
    editDeleteMeta: document.getElementById("filmScheduleMobileEditDeleteMeta"),
    editDeleteCancelBtn: document.getElementById("filmScheduleMobileEditDeleteCancelBtn"),
    editDeleteConfirmBtn: document.getElementById("filmScheduleMobileEditDeleteConfirmBtn"),
    editDeleteBtn: document.getElementById("filmScheduleMobileEditDeleteBtn"),
    editSaveBtn: document.getElementById("filmScheduleMobileEditSaveBtn"),
  });
}

function bindEvents() {
  if (!dom.root || dom.root.dataset.bound === "true") return;
  dom.root.dataset.bound = "true";

  dom.refreshBtn.addEventListener("click", () => loadMobileData(true));
  dom.customBtn.addEventListener("click", () => openCustomAddDialog());
  dom.dateInput.addEventListener("change", () => {
    state.showDate = dom.dateInput.value || todayDate();
    void loadMobileData();
  });
  dom.root.querySelectorAll("[data-schedule-mobile-source]").forEach((button) => {
    button.addEventListener("click", () => {
      state.activeSource = button.dataset.scheduleMobileSource || "ticketing";
      renderMobilePage();
    });
  });
  dom.hallFilter.addEventListener("click", (event) => {
    const button = event.target.closest("[data-schedule-mobile-hall]");
    if (!button) return;
    state.activeHallId = button.dataset.scheduleMobileHall || "all";
    renderMobilePage();
  });
  dom.content.addEventListener("change", (event) => {
    const input = event.target.closest("[data-managed-hall-toggle]");
    if (!input) return;
    handleManagedHallToggleChange(input);
  });
  dom.content.addEventListener("click", (event) => {
    const addCard = event.target.closest("[data-schedule-mobile-add]");
    if (addCard) {
      void openAddDialog(addCard.dataset.scheduleMobileAdd || "");
      return;
    }
    const editCard = event.target.closest("[data-schedule-mobile-edit]");
    if (editCard) {
      void openEditDialog(editCard.dataset.scheduleMobileEdit || "");
      return;
    }
  });
  dom.content.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const addCard = event.target.closest("[data-schedule-mobile-add]");
    const editCard = event.target.closest("[data-schedule-mobile-edit]");
    const card = addCard || editCard;
    if (!card) return;
    event.preventDefault();
    if (addCard) {
      void openAddDialog(addCard.dataset.scheduleMobileAdd || "");
    } else {
      void openEditDialog(editCard.dataset.scheduleMobileEdit || "");
    }
  });
  dom.managedCloseBtn.addEventListener("click", closeManagedDialog);
  dom.managedCancelBtn.addEventListener("click", closeManagedDialog);
  dom.managedDialog.addEventListener("close", () => {
    state.pendingManagedHallId = "";
    clearManagedError();
    renderMobilePage();
  });
  dom.managedForm.addEventListener("submit", saveManagedHallOptions);
  dom.managedAutoDisableEnabledInput.addEventListener("change", syncManagedAutoDisableInput);
  dom.addCloseBtn.addEventListener("click", closeAddDialog);
  dom.addCancelBtn.addEventListener("click", closeAddDialog);
  dom.addDialog.addEventListener("close", () => {
    state.selectedSession = null;
    state.addRules = [];
    clearAddError();
    renderPendingMobileRefresh();
  });
  dom.addRuleSelect.addEventListener("change", () => {
    renderAddHallOptions();
    if (state.selectedSession) {
      dom.addSessionSummary.innerHTML = renderAddSessionSummary(state.selectedSession);
    }
    syncAddAlignOption();
    renderAddEstimate();
    renderAddRulePreview();
    renderAddHallWarning();
    syncAddSaveState();
  });
  dom.addHallSelect.addEventListener("change", () => {
    renderAddHallWarning();
    syncAddSaveState();
  });
  dom.addStartInput.addEventListener("input", () => {
    renderAddEstimate();
    updateAddAlignText();
  });
  dom.addAlignFeatureInput.addEventListener("change", () => {
    updateAddStartMinimum();
    updateAddAlignText();
    renderAddEstimate();
  });
  dom.addForm.addEventListener("submit", saveAddEntry);
  dom.editCloseBtn.addEventListener("click", closeEditDialog);
  dom.editCancelBtn.addEventListener("click", closeEditDialog);
  dom.editDialog.addEventListener("close", () => {
    state.editingEntry = null;
    state.editRules = [];
    state.pendingDeleteRuntime = null;
    clearEditError();
    renderEditDeleteWarning();
    renderPendingMobileRefresh();
  });
  dom.editRuleSelect.addEventListener("change", () => {
    renderEditHallOptions();
    renderEditEstimate();
    renderEditRulePreview();
    renderEditHallWarning();
  });
  dom.editHallSelect.addEventListener("change", renderEditHallWarning);
  dom.editStartInput.addEventListener("input", renderEditEstimate);
  dom.editForm.addEventListener("submit", saveEditEntry);
  dom.editDeleteBtn.addEventListener("click", deleteEditingEntry);
  dom.editDeleteCancelBtn.addEventListener("click", () => {
    state.pendingDeleteRuntime = null;
    renderEditDeleteWarning();
  });
  dom.editDeleteConfirmBtn.addEventListener("click", () => {
    void performDeleteEditingEntry(dom.editDeleteConfirmBtn);
  });
}

async function loadMobileData(force = false) {
  if (state.busy) return;
  setBusy(true);
  try {
    const query = `?date=${encodeURIComponent(state.showDate)}`;
    const [ticketingPayload, entriesPayload, gdcPayload, halls, managedPayload] = await Promise.all([
      apiGet(`/api/film-schedule/ticketing${query}`).catch((error) => ({
        sessions: [],
        warnings: [{ message: formatFetchWarning("售票系统排期", error) }],
      })),
      apiGet(`/api/film-schedule/entries${query}`),
      apiGet(`/api/film-schedule/gdc${query}`).catch((error) => ({
        schedules: [],
        warnings: [{ message: formatFetchWarning("GDC排期", error) }],
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
    applyManagedHallPayload(managedPayload);
    ensureActiveHallExists();
    if (isAnyScheduleDialogOpen()) {
      state.pendingRender = true;
    } else {
      renderMobilePage();
    }
  } catch (error) {
    dom.notice.classList.remove("hidden");
    dom.notice.innerHTML = `<span>${escapeHtml(error.message || "排期加载失败。")}</span>`;
  } finally {
    setBusy(false);
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

function renderPendingMobileRefresh() {
  if (!state.pendingRender || isAnyScheduleDialogOpen()) {
    return;
  }
  state.pendingRender = false;
  renderMobilePage();
}

function isAnyScheduleDialogOpen() {
  return Boolean(dom.addDialog?.open || dom.managedDialog?.open || dom.editDialog?.open);
}

function renderMobilePage() {
  renderSourceSwitch();
  renderHallFilter();
  renderNotice();

  const items = getFilteredItems();
  dom.title.textContent = state.activeSource === "ticketing" ? "售票系统排期" : "排期预览";
  dom.subtitle.textContent = `${state.showDate} · ${getActiveHallName()} · ${formatRefreshTime()}`;
  dom.count.textContent = `${items.length}项`;
  dom.customBtn.classList.toggle("hidden", state.activeSource !== "preview");
  dom.content.innerHTML = items.length
    ? renderResultContent(items)
    : `<div class="film-schedule-mobile-empty">${escapeHtml(getEmptyText())}</div>`;
}

function renderSourceSwitch() {
  dom.root.querySelectorAll("[data-schedule-mobile-source]").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.scheduleMobileSource === state.activeSource);
  });
}

function renderHallFilter() {
  const halls = getFilterHalls();
  dom.hallFilter.innerHTML = [
    renderHallFilterButton({ id: "all", name: "全部" }),
    ...halls.map(renderHallFilterButton),
  ].join("");
}

function renderHallFilterButton(hall) {
  return `
    <button type="button" class="${hall.id === state.activeHallId ? "is-active" : ""}" data-schedule-mobile-hall="${escapeAttr(hall.id)}">
      ${escapeHtml(hall.name)}
    </button>
  `;
}

function renderNotice() {
  const warnings = state.activeSource === "ticketing"
    ? state.ticketingWarnings.map((item) => item.message || String(item))
    : state.gdcWarnings.map((item) => `${item.hallName || "GDC"}：${item.message}`);
  const visibleWarnings = warnings.filter(Boolean);
  if (!visibleWarnings.length) {
    dom.notice.classList.add("hidden");
    dom.notice.innerHTML = "";
    return;
  }
  dom.notice.classList.remove("hidden");
  dom.notice.innerHTML = visibleWarnings.slice(0, 3).map((message) => `<span>${escapeHtml(message)}</span>`).join("");
}

function renderResultContent(items) {
  if (state.activeSource === "ticketing") {
    return renderTicketingContent(items);
  }

  if (state.activeHallId !== "all") {
    return `<section class="film-schedule-mobile-stream">${items.map(renderScheduleCard).join("")}</section>`;
  }

  return groupItemsByHall(items).map((section) => `
    <section class="film-schedule-mobile-hall-group">
      <div class="film-schedule-mobile-hall-head">
        <h3>${escapeHtml(section.hall.name)}</h3>
        <span>${escapeHtml(section.hall.online ? "在线" : "离线")} · ${section.items.length}项</span>
      </div>
      <div class="film-schedule-mobile-stream">
        ${section.items.map(renderScheduleCard).join("")}
      </div>
    </section>
  `).join("");
}

function renderTicketingContent(items) {
  if (state.activeHallId !== "all") {
    const hall = getHallById(state.activeHallId) || { id: state.activeHallId, name: state.activeHallId, online: false };
    return `
      ${renderManagedPanel(hall)}
      ${items.length
        ? `<section class="film-schedule-mobile-stream">${items.map(renderScheduleCard).join("")}</section>`
        : `<div class="film-schedule-mobile-empty">暂无售票系统排期</div>`}
    `;
  }

  return getFilterHalls().map((hall) => {
    const hallItems = items.filter((item) => item.hallId === hall.id);
    return `
      <section class="film-schedule-mobile-hall-group">
        <div class="film-schedule-mobile-hall-head">
          <div>
            <h3>${escapeHtml(hall.name)}</h3>
            <span>${escapeHtml(hall.online ? "在线" : "离线")} · ${hallItems.length}项</span>
          </div>
          ${renderManagedToggle(hall)}
        </div>
        ${hallItems.length
          ? `<div class="film-schedule-mobile-stream">${hallItems.map(renderScheduleCard).join("")}</div>`
          : `<div class="film-schedule-mobile-empty is-compact">暂无售票场次</div>`}
      </section>
    `;
  }).join("");
}

function renderManagedPanel(hall) {
  const enabled = state.managedHallIds.has(hall.id);
  return `
    <section class="film-schedule-mobile-managed-panel ${enabled ? "is-enabled" : ""}">
      <div>
        <strong>${enabled ? "自动托管中" : "未开启自动托管"}</strong>
        <span>${enabled ? "已自动同步该影厅已售票场次" : "开启后自动添加该影厅已售票场次"}</span>
      </div>
      ${renderManagedToggle(hall)}
    </section>
  `;
}

function renderManagedToggle(hall) {
  const enabled = state.managedHallIds.has(hall.id);
  const saving = state.managedHallSavingIds.has(hall.id);
  const options = state.managedHallOptions.get(hall.id);
  const autoDisableText = options?.autoDisableAt ? `，自动关闭：${formatDateTimeText(options.autoDisableAt)}` : "";
  const title = enabled
    ? `自动托管售票排期${options?.alignFeatureStart === false ? "" : "，对齐正片时间"}${autoDisableText}`
    : "自动托管售票排期";
  return `
    <label class="film-schedule-mobile-managed-toggle ${enabled ? "is-enabled" : ""}" title="${escapeAttr(title)}">
      <input
        type="checkbox"
        class="toggle toggle-xs"
        value="${escapeAttr(hall.id)}"
        data-managed-hall-toggle="1"
        ${enabled ? "checked" : ""}
        ${saving ? "disabled" : ""}
      >
      <span>${saving ? "保存中" : enabled ? "托管中" : "托管"}</span>
    </label>
  `;
}

function renderScheduleCard(item) {
  const color = getFilmHue(item.filmCd || item.id);
  const endTime = item.mobileKind === "scheduled" ? item.endTime || item.startTime : item.endTime;
  const hallName = getHallById(item.hallId)?.name || item.hallName || item.hallId || "未知影厅";
  const progress = getScheduleProgressPercent(item.startTime, endTime);
  const progressClass = progress >= 100 ? " is-ended" : progress > 0 ? " is-playing" : "";
  const scheduled = item.mobileKind === "ticketing" && isSessionScheduled(item);
  const addAttrs = item.mobileKind === "ticketing"
    ? ` data-schedule-mobile-add="${escapeAttr(item.id)}" role="button" tabindex="0"`
    : "";
  const editAttrs = item.mobileKind === "scheduled"
    ? ` data-schedule-mobile-edit="${escapeAttr(item.id)}" role="button" tabindex="0"`
    : "";
  const scheduledClass = scheduled ? " is-scheduled" : "";
  return `
    <article class="film-schedule-mobile-card ${item.mobileKind === "gdc" ? "is-gdc" : ""}${progressClass}${scheduledClass}"${addAttrs}${editAttrs} style="--film-accent:${color}; --schedule-progress:${progress}%">
      ${progress > 0 ? `<div class="film-schedule-mobile-card-progress" aria-hidden="true"></div>` : ""}
      <div class="film-schedule-mobile-card-time">
        <strong>${escapeHtml(formatClock(item.startTime))}</strong>
        <span>${escapeHtml(formatClock(endTime))}</span>
      </div>
      <div class="film-schedule-mobile-card-main">
        <div class="film-schedule-mobile-card-title-row">
          <strong>${escapeHtml(item.filmName || "未命名影片")}</strong>
        </div>
        <p>${escapeHtml(hallName)}</p>
        <div class="film-schedule-mobile-card-tags">
          ${item.filmVisual ? `<span>${escapeHtml(item.filmVisual)}</span>` : ""}
          ${item.filmLanguage ? `<span>${escapeHtml(item.filmLanguage)}</span>` : ""}
          ${item.soldSeatsCount !== undefined ? `<span>${escapeHtml(String(item.soldSeatsCount))}人</span>` : ""}
          ${item.leastPrice !== undefined ? `<span>${escapeHtml(String(item.leastPrice))}元</span>` : ""}
          ${scheduled ? `<span>已添加</span>` : ""}
        </div>
      </div>
    </article>
  `;
}

function getScheduleProgressPercent(startTime, endTime) {
  if (state.showDate !== todayDate() || !startTime || !endTime) {
    return 0;
  }
  const start = new Date(startTime).getTime();
  const end = new Date(endTime).getTime();
  const now = Date.now();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || now <= start) {
    return 0;
  }
  if (now >= end) {
    return 100;
  }
  return Math.max(0, Math.min(100, ((now - start) / (end - start)) * 100));
}

async function openAddDialog(sessionId) {
  const session = state.ticketingSessions.find((item) => item.id === sessionId);
  if (!session) return;
  state.selectedSession = session;
  state.addRules = state.rules;
  dom.addForm.reset();
  clearAddError();
  dom.addTitle.textContent = "添加售票场次";
  dom.addSubtitle.textContent = `${session.hallName} · ${formatClock(session.startTime)}-${formatClock(session.endTime)}`;
  dom.addSessionSummary.classList.remove("hidden");
  dom.addStartInput.value = normalizeDateTimeLocalValue(session.startTime);
  dom.addNotesInput.value = "";
  renderAddRuleOptions();
  const matchingRule = findRuleForSession(session);
  if (matchingRule) {
    dom.addRuleSelect.value = matchingRule.id;
  }
  renderAddHallOptions();
  dom.addSessionSummary.innerHTML = renderAddSessionSummary(session);
  syncAddAlignOption();
  renderAddEstimate();
  renderAddRulePreview();
  renderAddHallWarning();
  syncAddSaveState();
  dom.addDialog.showModal();
}

function openCustomAddDialog() {
  state.selectedSession = null;
  state.addRules = state.rules;
  dom.addForm.reset();
  clearAddError();
  dom.addTitle.textContent = "自定义排期";
  dom.addSubtitle.textContent = "选择影片放映模板和开始时间";
  dom.addSessionSummary.innerHTML = "";
  dom.addSessionSummary.classList.add("hidden");
  dom.addStartInput.value = getDefaultCustomStartTime();
  dom.addNotesInput.value = "";
  renderAddRuleOptions();
  renderAddHallOptions();
  syncAddAlignOption();
  renderAddEstimate();
  renderAddRulePreview();
  renderAddHallWarning();
  syncAddSaveState();
  dom.addDialog.showModal();
}

function closeAddDialog() {
  dom.addDialog.close();
}

function renderAddSessionSummary(session) {
  const notices = [];
  if (isSessionScheduled(session)) {
    notices.push(`<div class="film-schedule-mobile-add-warning is-muted">该售票场次已经添加到排期预览。</div>`);
  }
  if (!getSelectedAddRule()) {
    notices.push(`<div class="film-schedule-mobile-add-warning">未找到该影片版本对应的影片放映模板。</div>`);
  } else if (shouldRequireManualHallSelection(session)) {
    notices.push(`<div class="film-schedule-mobile-add-warning">该售票场次原影厅未配置当前影片放映模板，请手动选择实际放映画厅。</div>`);
  }
  return `
    ${notices.join("")}
    <div class="film-schedule-mobile-add-summary-card">
      <strong>${escapeHtml(session.filmName)}</strong>
      <span>${escapeHtml(session.hallName)} · ${escapeHtml(formatClock(session.startTime))}-${escapeHtml(formatClock(session.endTime))}</span>
      <span>${escapeHtml([session.filmVisual, session.filmLanguage].filter(Boolean).join(" · ") || session.filmCd)}</span>
    </div>
  `;
}

function renderAddRuleOptions() {
  const rules = [...state.addRules].sort((left, right) => (
    String(left.filmName || "").localeCompare(String(right.filmName || ""), "zh-Hans-CN")
    || String(left.playlistName || "").localeCompare(String(right.playlistName || ""), "zh-Hans-CN")
  ));
  const options = rules.map((rule) => `<option value="${escapeAttr(rule.id)}">${escapeHtml(formatRuleSelectLabel(rule))}</option>`);
  if (state.selectedSession && !findRuleForSession(state.selectedSession)) {
    options.unshift(`<option value="">未找到对应影片放映模板</option>`);
  }
  dom.addRuleSelect.innerHTML = options.length ? options.join("") : `<option value="">暂无影片放映模板</option>`;
}

function renderAddHallOptions() {
  const rule = getSelectedAddRule();
  if (!rule) {
    dom.addHallSelect.innerHTML = `<option value="">请先选择影片放映模板</option>`;
    return;
  }
  const hallIds = Array.isArray(rule.hallIds) ? rule.hallIds : [];
  const session = state.selectedSession;
  const requiresManualHall = Boolean(session && !ruleIncludesHall(rule, session.hallId));
  const options = hallIds.map((hallId) => `<option value="${escapeAttr(hallId)}">${escapeHtml(getHallName(hallId))}${isHallOffline(hallId) ? "（离线）" : ""}</option>`);
  dom.addHallSelect.innerHTML = hallIds.length
    ? `${requiresManualHall ? `<option value="">请选择影厅（售票影厅未配置该模板）</option>` : ""}${options.join("")}`
    : `<option value="">该影片放映模板未配置影厅</option>`;
  if (session && ruleIncludesHall(rule, session.hallId)) {
    dom.addHallSelect.value = session.hallId;
  }
}

function shouldRequireManualHallSelection(session, rule = getSelectedAddRule()) {
  return Boolean(session && rule && !ruleIncludesHall(rule, session.hallId));
}

function syncAddAlignOption() {
  const rule = getSelectedAddRule();
  const canAlign = getFeatureStartOffsetSeconds(rule) > 0;
  dom.addAlignFeatureInput.disabled = !canAlign;
  dom.addAlignFeatureInput.checked = canAlign;
  updateAddStartMinimum();
  updateAddAlignText();
}

function updateAddStartMinimum() {
  const rule = getSelectedAddRule();
  const offsetSeconds = isAddAlignChecked() ? getFeatureStartOffsetSeconds(rule) : 0;
  dom.addStartInput.min = addSeconds(getMinimumScheduleStartInputValue(), offsetSeconds);
}

function updateAddAlignText() {
  const rule = getSelectedAddRule();
  if (getFeatureStartOffsetSeconds(rule) <= 0) {
    dom.addAlignFeatureText.textContent = "影片放映模板未设置正片开始时间";
    return;
  }
  if (!isAddAlignChecked()) {
    dom.addAlignFeatureText.textContent = "按填写时间创建排期";
    return;
  }
  dom.addAlignFeatureText.textContent = `实际会在 ${formatDateTimeText(getAlignedScheduleStartTime(dom.addStartInput.value, rule, true))} 创建排期`;
}

function renderAddEstimate() {
  const rule = getSelectedAddRule();
  const actualStartTime = getAlignedScheduleStartTime(dom.addStartInput.value, rule, isAddAlignChecked());
  dom.addEstimate.textContent = formatScheduleEstimate(actualStartTime, rule);
}

function renderAddRulePreview() {
  dom.addRulePreview.innerHTML = renderRulePreview(getSelectedAddRule());
}

function renderAddHallWarning() {
  const warning = getOfflineWarningText(dom.addHallSelect.value);
  dom.addHallWarning.textContent = warning;
  dom.addHallWarning.classList.toggle("hidden", !warning);
}

function syncAddSaveState() {
  dom.addSaveBtn.disabled = Boolean(!getSelectedAddRule() || !dom.addHallSelect.value || (state.selectedSession && isSessionScheduled(state.selectedSession)));
}

async function saveAddEntry(event) {
  event.preventDefault();
  const session = state.selectedSession;
  const rule = getSelectedAddRule();
  const hallId = dom.addHallSelect.value;
  if (!rule || !hallId) {
    showAddError("请选择影片放映模板和影厅。");
    return;
  }
  if (session && isSessionScheduled(session)) {
    showAddError("该售票场次已经添加到排期预览。");
    return;
  }
  const actualStartTime = getAlignedScheduleStartTime(dom.addStartInput.value, rule, isAddAlignChecked());
  const scheduleTimeWarning = getScheduleTimeWarning(actualStartTime);
  if (scheduleTimeWarning) {
    showAddError(scheduleTimeWarning);
    return;
  }
  const endTime = estimateEndTime(actualStartTime, rule);
  const overlapWarning = getOverlapWarning(hallId, actualStartTime, endTime);
  if (overlapWarning) {
    showAddError(overlapWarning);
    return;
  }

  setAddSaveLoading(true);
  clearAddError();
  try {
    await apiPost("/api/film-schedule/entries", {
      showDate: state.showDate,
      startTime: actualStartTime,
      endTime,
      hallId,
      hallName: getHallName(hallId),
      finixxHallId: getFinixxHallId(hallId),
      filmCd: rule.filmCd,
      filmName: rule.filmName,
      filmVisual: rule.filmVisual,
      filmLanguage: rule.filmLanguage,
      ruleId: rule.id,
      source: session ? "ticketing" : "custom",
      notes: dom.addNotesInput.value.trim(),
      ...(session ? {
        ticketingSessionId: session.ticketingSessionId || session.id,
        ticketingRaw: session.raw,
      } : {}),
    });
    toast.success(session ? "排期已添加" : "自定义排期已保存");
    closeAddDialog();
    state.activeSource = "preview";
    await loadMobileData(true);
  } catch (error) {
    showAddError(error.message || (session ? "排期保存失败。" : "自定义排期保存失败。"));
  } finally {
    setAddSaveLoading(false);
    syncAddSaveState();
  }
}

function setAddSaveLoading(loading) {
  dom.addSaveBtn.disabled = loading;
  dom.addSaveBtn.classList.toggle("loading", loading);
}

function clearAddError() {
  dom.addError.textContent = "";
  dom.addError.classList.add("hidden");
}

function showAddError(message) {
  dom.addError.textContent = message;
  dom.addError.classList.remove("hidden");
}

async function openEditDialog(entryId) {
  const entry = state.entries.find((item) => item.id === entryId);
  if (!entry) return;
  state.editingEntry = entry;
  state.editRules = mergeEditRules(state.rules, entry);
  state.pendingDeleteRuntime = null;
  dom.editForm.reset();
  clearEditError();
  renderEditDeleteWarning();
  dom.editSubtitle.textContent = `${entry.hallName || getHallName(entry.hallId)} · ${entry.filmName}`;
  dom.editStartInput.value = normalizeDateTimeLocalValue(entry.startTime);
  dom.editStartInput.min = getMinimumScheduleStartInputValue();
  dom.editNotesInput.value = entry.notes || "";
  renderEditRuleOptions();
  renderEditHallOptions();
  renderEditEstimate();
  renderEditRulePreview();
  renderEditHallWarning();
  dom.editDialog.showModal();
}

function closeEditDialog() {
  dom.editDialog.close();
}

function mergeEditRules(rules, entry) {
  const merged = [...rules];
  if (entry.ruleId && !merged.some((rule) => rule.id === entry.ruleId)) {
    merged.unshift({
      ...(entry.ruleSnapshot || {}),
      id: entry.ruleId,
      filmCd: entry.filmCd,
      filmName: entry.filmName,
      filmVisual: entry.filmVisual,
      filmLanguage: entry.filmLanguage,
      hallIds: entry.ruleSnapshot?.hallIds || [entry.hallId].filter(Boolean),
    });
  }
  return merged;
}

function renderEditRuleOptions() {
  const entry = state.editingEntry;
  const rules = [...state.editRules].sort((left, right) => (
    String(left.filmName || "").localeCompare(String(right.filmName || ""), "zh-Hans-CN")
    || String(left.playlistName || "").localeCompare(String(right.playlistName || ""), "zh-Hans-CN")
  ));
  dom.editRuleSelect.innerHTML = rules.length
    ? rules.map((rule) => `<option value="${escapeAttr(rule.id)}">${escapeHtml(formatRuleSelectLabel(rule))}</option>`).join("")
    : `<option value="">暂无影片放映模板</option>`;
  dom.editRuleSelect.value = entry?.ruleId || "";
}

function renderEditHallOptions() {
  const entry = state.editingEntry;
  if (!entry) return;
  const rule = getSelectedEditRule();
  if (!rule) {
    dom.editHallSelect.innerHTML = `<option value="">请先选择影片放映模板</option>`;
    return;
  }
  const hallIds = Array.isArray(rule.hallIds) ? [...rule.hallIds] : [];
  if (dom.editRuleSelect.value === entry.ruleId && entry.hallId && !hallIds.includes(entry.hallId)) {
    hallIds.unshift(entry.hallId);
  }
  dom.editHallSelect.innerHTML = hallIds.length
    ? hallIds.map((hallId) => `<option value="${escapeAttr(hallId)}">${escapeHtml(getHallName(hallId))}${isHallOffline(hallId) ? "（离线）" : ""}</option>`).join("")
    : `<option value="">该影片放映模板未配置影厅</option>`;
  dom.editHallSelect.value = hallIds.includes(entry.hallId) ? entry.hallId : (hallIds[0] || "");
}

function renderEditEstimate() {
  const entry = state.editingEntry;
  if (!entry) {
    dom.editEstimate.textContent = "--";
    return;
  }
  dom.editEstimate.textContent = formatScheduleEstimate(
    dom.editStartInput.value,
    getSelectedEditRule() || entry.ruleSnapshot || entry,
  );
}

function renderEditRulePreview() {
  dom.editRulePreview.innerHTML = renderRulePreview(getSelectedEditRule() || state.editingEntry?.ruleSnapshot || null);
}

function renderEditHallWarning() {
  const warning = getOfflineWarningText(dom.editHallSelect.value);
  dom.editHallWarning.textContent = warning;
  dom.editHallWarning.classList.toggle("hidden", !warning);
}

async function saveEditEntry(event) {
  event.preventDefault();
  const entry = state.editingEntry;
  if (!entry) return;
  setEditSaveLoading(true);
  clearEditError();
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
    const nextStartTime = normalizeDateTimeLocalValue(dom.editStartInput.value);
    const nextEndTime = estimateEndTime(nextStartTime, rule);
    const overlapWarning = getOverlapWarning(hallId, nextStartTime, nextEndTime, entry.id);
    if (overlapWarning) {
      throw new Error(overlapWarning);
    }
    await apiPost(`/api/film-schedule/entries/${encodeURIComponent(entry.id)}`, {
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
    closeEditDialog();
    await loadMobileData(true);
  } catch (error) {
    showEditError(error.message || "排期调整失败。");
  } finally {
    setEditSaveLoading(false);
  }
}

async function deleteEditingEntry() {
  const entry = state.editingEntry;
  if (!entry) return;
  setEditDeleteLoading(true);
  clearEditError();
  try {
    const runtime = await findActiveScheduleRuntime(entry);
    if (runtime) {
      state.pendingDeleteRuntime = runtime;
      renderEditDeleteWarning();
      return;
    }
    await performDeleteEditingEntry(dom.editDeleteBtn);
  } catch (error) {
    showEditError(error.message || "排期删除失败。");
  } finally {
    setEditDeleteLoading(false);
  }
}

async function performDeleteEditingEntry(button) {
  const entry = state.editingEntry;
  if (!entry) return;
  setButtonLoading(button, true);
  clearEditError();
  try {
    await apiDelete(`/api/film-schedule/entries/${encodeURIComponent(entry.id)}`);
    toast.success(state.pendingDeleteRuntime ? "排期已删除，播放监控已退出" : "排期已删除");
    state.pendingDeleteRuntime = null;
    closeEditDialog();
    await loadMobileData(true);
  } catch (error) {
    showEditError(error.message || "排期删除失败。");
  } finally {
    setButtonLoading(button, false);
    renderEditDeleteWarning();
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

function renderEditDeleteWarning() {
  const runtime = state.pendingDeleteRuntime;
  dom.editDeleteWarning.classList.toggle("hidden", !runtime);
  if (!runtime) {
    dom.editDeleteMeta.textContent = "";
    return;
  }
  const entry = state.editingEntry;
  const position = Number.isFinite(runtime.lastPositionSeconds)
    ? formatSeconds(runtime.lastPositionSeconds)
    : "--:--";
  dom.editDeleteMeta.textContent = `${entry?.hallName || getHallName(entry?.hallId)} · ${entry?.filmName || ""} · ${getScheduleRuntimeStatusLabel(runtime.status)} · 位置 ${position}`;
}

function getSelectedEditRule() {
  const ruleId = dom.editRuleSelect.value;
  const rule = state.editRules.find((item) => item.id === ruleId);
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

function setEditSaveLoading(loading) {
  setButtonLoading(dom.editSaveBtn, loading);
}

function setEditDeleteLoading(loading) {
  setButtonLoading(dom.editDeleteBtn, loading);
}

function setButtonLoading(button, loading) {
  button.disabled = loading;
  button.classList.toggle("loading", loading);
}

function clearEditError() {
  dom.editError.textContent = "";
  dom.editError.classList.add("hidden");
}

function showEditError(message) {
  dom.editError.textContent = message;
  dom.editError.classList.remove("hidden");
}

function applyManagedHallPayload(payload) {
  const managedHalls = Array.isArray(payload?.managedHalls) ? payload.managedHalls : [];
  state.managedHallOptions = new Map(managedHalls
    .filter((item) => item?.hallId)
    .map((item) => [item.hallId, {
      hallId: item.hallId,
      enabled: item.enabled === true,
      alignFeatureStart: item.alignFeatureStart !== false,
      autoDisableAt: typeof item.autoDisableAt === "string" ? item.autoDisableAt : "",
    }]));
  state.managedHallIds = new Set(managedHalls
    .filter((item) => item?.enabled && item?.hallId)
    .map((item) => item.hallId));
}

function handleManagedHallToggleChange(input) {
  const hallId = input.value;
  if (!hallId || state.managedHallSavingIds.has(hallId)) {
    renderMobilePage();
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
  clearManagedError();
  dom.managedHallName.textContent = getHallById(hallId)?.name || hallId;
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
  setManagedSaveLoading(true);
  clearManagedError();
  try {
    await toggleManagedHall(hallId, true, {
      alignFeatureStart: dom.managedAlignFeatureInput.checked,
      autoDisableAt: readManagedAutoDisableAtOrEmpty(),
      suppressRender: true,
    });
    closeManagedDialog();
  } catch (error) {
    showManagedError(error.message || "托管设置保存失败。");
  } finally {
    setManagedSaveLoading(false);
  }
}

async function toggleManagedHall(hallId, enabled, options = {}) {
  if (!hallId || state.managedHallSavingIds.has(hallId)) return;
  state.managedHallSavingIds.add(hallId);
  if (!options.suppressRender) {
    renderMobilePage();
  }
  try {
    const payload = await apiPost(`/api/film-scheduler/managed-halls/${encodeURIComponent(hallId)}`, {
      enabled,
      alignFeatureStart: options?.alignFeatureStart !== false,
      autoDisableAt: enabled ? options?.autoDisableAt || "" : "",
    });
    if (payload.managedHall?.hallId) {
      state.managedHallOptions.set(payload.managedHall.hallId, {
        hallId: payload.managedHall.hallId,
        enabled: payload.managedHall.enabled === true,
        alignFeatureStart: payload.managedHall.alignFeatureStart !== false,
        autoDisableAt: typeof payload.managedHall.autoDisableAt === "string" ? payload.managedHall.autoDisableAt : "",
      });
    }
    if (payload.managedHall?.enabled) {
      state.managedHallIds.add(hallId);
      toast.success(`${getHallById(hallId)?.name || hallId} 已开启自动托管`);
    } else {
      state.managedHallIds.delete(hallId);
      toast.info(`${getHallById(hallId)?.name || hallId} 已关闭自动托管`);
    }
  } catch (error) {
    if (options.suppressRender) {
      throw error;
    }
    toast.error(error.message || "托管设置保存失败。");
  } finally {
    state.managedHallSavingIds.delete(hallId);
    if (!options.suppressRender) {
      renderMobilePage();
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

function getDefaultCustomStartTime() {
  const dateStart = `${state.showDate}T10:00:00`;
  const minimum = getMinimumScheduleStartInputValue();
  if (new Date(dateStart).getTime() >= new Date(minimum).getTime()) {
    return dateStart;
  }
  return floorDateTimeToMinute(minimum);
}

function getMinimumScheduleStartInputValue() {
  const date = new Date();
  date.setMinutes(date.getMinutes() + 1, 0, 0);
  return formatDateTimeLocal(date);
}

function normalizeDateTimeLocalValue(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/.exec(String(value || "").trim());
  if (!match) return "";
  return `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6] || "00"}`;
}

function floorDateTimeToMinute(value) {
  const date = new Date(value);
  date.setSeconds(0, 0);
  return formatDateTimeLocal(date);
}

function formatDateTimeLocal(date) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-") + "T" + [
    String(date.getHours()).padStart(2, "0"),
    String(date.getMinutes()).padStart(2, "0"),
    String(date.getSeconds()).padStart(2, "0"),
  ].join(":");
}

function setManagedSaveLoading(loading) {
  dom.managedSaveBtn.disabled = loading;
  dom.managedSaveBtn.classList.toggle("loading", loading);
}

function clearManagedError() {
  dom.managedError.textContent = "";
  dom.managedError.classList.add("hidden");
}

function showManagedError(message) {
  dom.managedError.textContent = message;
  dom.managedError.classList.remove("hidden");
}

function getFilteredItems() {
  const sourceItems = state.activeSource === "ticketing"
    ? state.ticketingSessions.map((session) => ({ ...session, mobileKind: "ticketing" }))
    : [
      ...state.entries.map((entry) => ({ ...entry, mobileKind: "scheduled" })),
      ...state.gdcSchedules.map((schedule) => ({ ...schedule, mobileKind: "gdc" })),
    ];
  return sourceItems
    .filter((item) => state.activeHallId === "all" || item.hallId === state.activeHallId)
    .sort((left, right) => readStartMinutes(left) - readStartMinutes(right) || getHallSortName(left).localeCompare(getHallSortName(right), "zh-Hans-CN"));
}

function groupItemsByHall(items) {
  const sections = new Map();
  for (const item of items) {
    const hallId = item.hallId || "unknown";
    if (!sections.has(hallId)) {
      sections.set(hallId, {
        hall: getHallById(hallId) || { id: hallId, name: item.hallName || hallId, online: false },
        items: [],
      });
    }
    sections.get(hallId).items.push(item);
  }
  return [...sections.values()].sort((left, right) => left.hall.name.localeCompare(right.hall.name, "zh-Hans-CN"));
}

function getFilterHalls() {
  const map = new Map(state.halls.map((hall) => [hall.id, hall]));
  for (const item of [...state.ticketingSessions, ...state.entries, ...state.gdcSchedules]) {
    if (item.hallId && !map.has(item.hallId)) {
      map.set(item.hallId, { id: item.hallId, name: item.hallName || item.hallId, online: false });
    }
  }
  return [...map.values()].sort((left, right) => left.name.localeCompare(right.name, "zh-Hans-CN"));
}

function ensureActiveHallExists() {
  if (state.activeHallId === "all") return;
  if (!getFilterHalls().some((hall) => hall.id === state.activeHallId)) {
    state.activeHallId = "all";
  }
}

function getActiveHallName() {
  if (state.activeHallId === "all") return "全部影厅";
  return getHallById(state.activeHallId)?.name || state.activeHallId;
}

function getHallById(hallId) {
  return getFilterHalls().find((hall) => hall.id === hallId) || null;
}

function getHallName(hallId) {
  return getHallById(hallId)?.name || hallId;
}

function getFinixxHallId(hallId) {
  return state.halls.find((hall) => hall.id === hallId)?.finixxHallId || "";
}

function isHallOffline(hallId) {
  const hall = getHallById(hallId);
  return hall ? hall.online !== true : false;
}

function getHallSortName(item) {
  return getHallById(item.hallId)?.name || item.hallName || item.hallId || "";
}

function getEmptyText() {
  return state.activeSource === "ticketing" ? "暂无售票系统排期" : "暂无排期预览";
}

function normalizeRuntimeHalls(halls) {
  return halls.map((hall) => ({
    id: hall?.registration?.hallId || hall?.id || "",
    name: hall?.registration?.hallName || hall?.name || hall?.registration?.hallId || "未命名影厅",
    finixxHallId: hall?.registration?.finixxHallId || hall?.finixxHallId || hall?.registration?.hallId || "",
    online: hall?.snapshot?.connectivity?.state === "online",
  })).filter((hall) => hall.id);
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
          <strong>${escapeHtml(rule.playlistName || "未命名播放表")}</strong>
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
  return state.addRules.find((rule) => rule?.filmCd === session?.filmCd) || null;
}

function getRulesForSession(session) {
  return state.rules.filter((rule) => ruleMatchesSession(rule, session));
}

function ruleMatchesSession(rule, session) {
  return Boolean(rule && session && rule.filmCd === session.filmCd);
}

function ruleIncludesHall(rule, hallId) {
  return Boolean(rule && hallId && Array.isArray(rule.hallIds) && rule.hallIds.includes(hallId));
}

function getSelectedAddRule() {
  return state.addRules.find((rule) => rule.id === dom.addRuleSelect.value) || null;
}

function isAddAlignChecked() {
  return Boolean(dom.addAlignFeatureInput && !dom.addAlignFeatureInput.disabled && dom.addAlignFeatureInput.checked);
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

function isSessionScheduled(session) {
  if (!session) return false;
  return state.entries.some((entry) => (
    (session.ticketingSessionId && entry.ticketingSessionId === session.ticketingSessionId)
    || (entry.hallId === session.hallId && entry.filmCd === session.filmCd && entry.startTime === session.startTime)
  ));
}

function getOfflineWarningText(hallId) {
  if (!hallId || !isHallOffline(hallId)) {
    return "";
  }
  return `${getHallName(hallId)} 当前离线，仍可保存排期；实际执行需要确保影厅在线。`;
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

function getEntryEstimatedEndTime(entry) {
  if (entry?.source === "gdc" && entry.endTime) {
    return entry.endTime;
  }
  return entry.endTime || estimateEndTime(entry.startTime, entry.ruleSnapshot || entry);
}

function estimateEndTime(startTime, ruleLike) {
  return addSeconds(startTime, getEstimatedScheduleDurationSeconds(ruleLike));
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
  }).filter((item) => item.durationSeconds > 0);

  if (!items.length) {
    const widthPixels = getRuleSegmentPixelWidth(fallbackDurationSeconds);
    return {
      segments: [{ durationSeconds: fallbackDurationSeconds, title: ruleLike?.playlistName || "播放表", widthPixels, commandClusters: [] }],
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

function formatRuleSelectLabel(rule) {
  return `${formatRuleLabel(rule)} (${rule.playlistName || "未命名播放表"})`;
}

function formatRuleLabel(rule) {
  return `${rule.filmName}${rule.filmVisual ? ` · ${rule.filmVisual}` : ""}${rule.filmLanguage ? ` · ${rule.filmLanguage}` : ""}`;
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

function readStartMinutes(item) {
  if (Number.isFinite(item.startMinutes)) return item.startMinutes;
  const date = new Date(item.startTime);
  return Number.isNaN(date.getTime()) ? 0 : date.getHours() * 60 + date.getMinutes();
}

function getFilmHue(seed) {
  const text = String(seed || "");
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 31 + text.charCodeAt(index)) >>> 0;
  }
  return PALETTE[hash % PALETTE.length];
}

function startTimer() {
  stopTimer();
  state.timer = window.setInterval(() => {
    void loadMobileData();
  }, REFRESH_INTERVAL_MS);
}

function stopTimer() {
  if (state.timer) {
    window.clearInterval(state.timer);
    state.timer = null;
  }
}

function setBusy(busy) {
  state.busy = busy;
  dom.refreshBtn.disabled = busy;
  dom.refreshBtn.classList.toggle("loading", busy);
  if (busy && !dom.content.innerHTML) {
    dom.content.innerHTML = `<div class="film-schedule-mobile-loading"><span class="loading loading-spinner loading-lg text-primary"></span></div>`;
  }
}

function formatFetchWarning(label, error) {
  const message = error instanceof Error ? error.message : String(error || "");
  if (!message || message === "fetch failed") {
    return `${label}拉取失败，请检查连接。`;
  }
  return `${label}拉取失败：${message}`;
}

function formatRefreshTime() {
  const date = new Date();
  return `更新 ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function formatClock(value) {
  if (!value) return "--:--:--";
  const match = /T(\d{2}):(\d{2})(?::(\d{2}))?/.exec(String(value));
  return match ? `${match[1]}:${match[2]}:${match[3] || "00"}` : "--:--:--";
}

function formatDateTimeText(value) {
  const normalized = normalizeDateTimeLocalValue(String(value || ""));
  return normalized ? normalized.replace("T", " ") : "--";
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

function addSeconds(value, seconds) {
  const date = new Date(value);
  date.setSeconds(date.getSeconds() + seconds);
  return formatDateTimeLocal(date);
}

function todayDate() {
  const date = new Date();
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

function escapeAttr(value) {
  return escapeHtml(value);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
