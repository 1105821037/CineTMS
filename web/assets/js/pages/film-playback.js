import { apiDelete, apiGet, apiPost, getRuntimeHalls } from "../api.js";
import { toast } from "../toast.js";

const DEFAULT_FPS = 24;
const TIMELINE_PIXELS_PER_SECOND = 0.08;
const MIN_SEGMENT_WIDTH = 118;
const MAX_SEGMENT_WIDTH = 620;
const MARKER_CLUSTER_THRESHOLD_PERCENT = 4;
const TIME_POINT_TYPES = [
  { value: "head", label: "片头" },
  { value: "tail", label: "片尾" },
  { value: "point", label: "时间点" },
  { value: "range", label: "时间段" },
];
const TIME_POINT_ACTIONS = [
  { value: "", label: "无操作" },
  { value: "executeCommand", label: "执行指令" },
  { value: "pausePlayback", label: "暂停播放" },
  { value: "stopPlayback", label: "停止播放" },
  { value: "seek", label: "快进/快退" },
  { value: "switchCpl", label: "切换 CPL" },
  { value: "httpRequest", label: "HTTP 请求" },
];
const RANGE_ONLY_ACTIONS = [
  { value: "skipRange", label: "跳过该时间段" },
];

const state = {
  rules: [],
  ruleOccupancies: [],
  films: [],
  filterFilms: [],
  halls: [],
  showsByHallId: new Map(),
  showDetailsByRef: new Map(),
  automationLabelsByHallId: new Map(),
  commonAutomationLabels: [],
  commonAutomationLabelsLoading: false,
  selectedPlaylistCheck: null,
  playlistInspectSeq: 0,
  filters: {
    search: "",
    hallId: "",
    filmCd: "",
  },
  page: 1,
  pageSize: 10,
  totalRules: 0,
  totalPages: 1,
  summary: {
    ruleCount: 0,
    filmCount: 0,
    hallCount: 0,
  },
  editingRule: null,
  busy: false,
  saving: false,
  timeEditTouched: false,
  timeEditError: "",
  timePoints: [],
  editingHttpPointId: "",
};

const dom = {};

export function initFilmPlaybackPage() {
  cacheDom();
  bindEvents();
  void loadPageData(true);
}

export function disposeFilmPlaybackPage() {
  invalidateFilmPlaybackPlaylistCache();
}

export function invalidateFilmPlaybackPlaylistCache() {
  state.showsByHallId.clear();
  state.showDetailsByRef.clear();
  state.selectedPlaylistCheck = null;
}

function cacheDom() {
  Object.assign(dom, {
    root: document.getElementById("filmPlaybackRoot"),
    refreshBtn: document.getElementById("filmPlaybackRefreshBtn"),
    addBtn: document.getElementById("filmPlaybackAddBtn"),
    error: document.getElementById("filmPlaybackError"),
    ruleCount: document.getElementById("filmPlaybackRuleCount"),
    filmCount: document.getElementById("filmPlaybackFilmCount"),
    hallCount: document.getElementById("filmPlaybackHallCount"),
    searchInput: document.getElementById("filmPlaybackSearchInput"),
    hallFilter: document.getElementById("filmPlaybackHallFilter"),
    filmFilter: document.getElementById("filmPlaybackFilmFilter"),
    resetFilterBtn: document.getElementById("filmPlaybackResetFilterBtn"),
    tableWrap: document.getElementById("filmPlaybackTableWrap"),
    pagination: document.getElementById("filmPlaybackPagination"),
    pageInfo: document.getElementById("filmPlaybackPageInfo"),
    pageSize: document.getElementById("filmPlaybackPageSize"),
    pageNumber: document.getElementById("filmPlaybackPageNumber"),
    dialog: document.getElementById("filmPlaybackRuleDialog"),
    dialogTitle: document.getElementById("filmPlaybackDialogTitle"),
    dialogCloseBtn: document.getElementById("filmPlaybackDialogCloseBtn"),
    form: document.getElementById("filmPlaybackRuleForm"),
    ruleId: document.getElementById("filmPlaybackRuleId"),
    filmSelect: document.getElementById("filmPlaybackFilmSelect"),
    filmPicker: document.getElementById("filmPlaybackFilmPicker"),
    filmButton: document.getElementById("filmPlaybackFilmButton"),
    filmButtonLabel: document.querySelector("#filmPlaybackFilmButton [data-role='film-button-label']"),
    filmButtonTags: document.querySelector("#filmPlaybackFilmButton [data-role='film-button-tags']"),
    filmList: document.getElementById("filmPlaybackFilmList"),
    hallList: document.getElementById("filmPlaybackHallList"),
    playlistHint: document.getElementById("filmPlaybackPlaylistHint"),
    playlistSelect: document.getElementById("filmPlaybackPlaylistSelect"),
    playlistCheck: document.getElementById("filmPlaybackPlaylistCheck"),
    addTimePointBtn: document.getElementById("filmPlaybackAddTimePointBtn"),
    timePointList: document.getElementById("filmPlaybackTimePointList"),
    httpDialog: document.getElementById("filmPlaybackHttpDialog"),
    httpForm: document.getElementById("filmPlaybackHttpForm"),
    httpCloseBtn: document.getElementById("filmPlaybackHttpCloseBtn"),
    httpCancelBtn: document.getElementById("filmPlaybackHttpCancelBtn"),
    httpMethod: document.getElementById("filmPlaybackHttpMethod"),
    httpUrl: document.getElementById("filmPlaybackHttpUrl"),
    httpTimeout: document.getElementById("filmPlaybackHttpTimeout"),
    httpHeaders: document.getElementById("filmPlaybackHttpHeaders"),
    httpQuery: document.getElementById("filmPlaybackHttpQuery"),
    httpBody: document.getElementById("filmPlaybackHttpBody"),
    httpError: document.getElementById("filmPlaybackHttpError"),
    formError: document.getElementById("filmPlaybackFormError"),
    cancelBtn: document.getElementById("filmPlaybackCancelBtn"),
    saveBtn: document.getElementById("filmPlaybackSaveBtn"),
  });
}

function bindEvents() {
  if (!dom.root || dom.root.dataset.bound === "true") {
    return;
  }
  dom.root.dataset.bound = "true";

  dom.refreshBtn.addEventListener("click", () => loadPageData(true));
  dom.addBtn.addEventListener("click", () => openRuleDialog());
  dom.resetFilterBtn.addEventListener("click", resetFilters);
  dom.searchInput.addEventListener("input", () => {
    state.filters.search = dom.searchInput.value.trim();
    state.page = 1;
    void loadRulesData();
  });
  dom.hallFilter.addEventListener("change", () => {
    state.filters.hallId = dom.hallFilter.value;
    state.page = 1;
    void loadRulesData();
  });
  dom.filmFilter.addEventListener("change", () => {
    state.filters.filmCd = dom.filmFilter.value;
    state.page = 1;
    void loadRulesData();
  });
  dom.pageSize.addEventListener("change", () => {
    state.pageSize = readPageSize(dom.pageSize.value);
    state.page = 1;
    void loadRulesData();
  });

  dom.dialogCloseBtn.addEventListener("click", () => dom.dialog.close());
  dom.cancelBtn.addEventListener("click", () => dom.dialog.close());
  dom.filmButton.addEventListener("click", () => {
    toggleFilmOptions();
  });
  dom.filmList.addEventListener("click", (event) => {
    const option = event.target.closest("[data-film-option]");
    if (!option) return;
    selectFilmOption(option.dataset.filmOption || "");
  });
  document.addEventListener("click", (event) => {
    if (!dom.filmPicker?.contains(event.target)) {
      closeFilmOptions();
    }
  });
  dom.filmSelect.addEventListener("change", () => {
    renderSelectedFilmButton();
    renderHallChoices();
    void loadPlaylistChoices();
  });
  dom.hallList.addEventListener("change", () => {
    state.commonAutomationLabels = [];
    void loadPlaylistChoices();
    if (state.timePoints.some((point) => point.action?.type === "executeCommand")) {
      void loadCommonAutomationLabelsForSelectedHalls();
    }
  });
  dom.playlistSelect.addEventListener("change", () => {
    void inspectSelectedPlaylistChoice();
  });
  dom.addTimePointBtn.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    state.timeEditTouched = true;
    state.timePoints.push(createTimePoint("point"));
    renderTimePoints();
    renderPlaylistCheck();
  });
  dom.timePointList.addEventListener("click", (event) => {
    const button = event.target.closest("[data-remove-time-point], [data-configure-http]");
    if (!button) return;
    if (button.dataset.removeTimePoint) {
      state.timePoints = state.timePoints.filter((item) => item.id !== button.dataset.removeTimePoint);
      state.timeEditTouched = true;
      renderTimePoints();
      renderPlaylistCheck();
      return;
    }
    if (button.dataset.configureHttp) {
      openHttpDialog(button.dataset.configureHttp);
    }
  });
  dom.timePointList.addEventListener("input", handleTimePointEdit);
  dom.timePointList.addEventListener("change", handleTimePointEdit);
  dom.httpCloseBtn.addEventListener("click", () => closeHttpDialog());
  dom.httpCancelBtn.addEventListener("click", () => closeHttpDialog());
  dom.httpDialog.addEventListener("close", () => {
    state.editingHttpPointId = "";
  });
  dom.httpForm.addEventListener("submit", saveHttpConfig);
  dom.form.addEventListener("submit", saveRule);

  dom.tableWrap.addEventListener("click", (event) => {
    const editButton = event.target.closest("[data-edit-rule]");
    const deleteButton = event.target.closest("[data-delete-rule]");
    if (editButton) {
      const rule = state.rules.find((item) => item.id === editButton.dataset.editRule);
      if (rule) openRuleDialog(rule);
    }
    if (deleteButton) {
      void deleteRule(deleteButton.dataset.deleteRule);
    }
  });
  dom.pagination.addEventListener("click", (event) => {
    const button = event.target.closest("[data-film-playback-page-action]");
    if (!button) return;
    changePage(button.dataset.filmPlaybackPageAction);
  });
}

async function loadPageData(force = false) {
  setBusy(true);
  renderPageError("");
  try {
    if (force) {
      invalidateFilmPlaybackPlaylistCache();
      state.automationLabelsByHallId.clear();
    }
    const [rulesPayload, filmsPayload, halls] = await Promise.all([
      fetchRulesPayload(),
      apiGet("/api/film-playback/films").catch((error) => ({ films: [], error: error.message })),
      getRuntimeHalls(force).catch(() => []),
    ]);
    applyRulesPayload(rulesPayload);
    state.films = Array.isArray(filmsPayload.films) ? filmsPayload.films : [];
    state.halls = normalizeRuntimeHalls(halls);
    if (filmsPayload.error) {
      renderPageError(filmsPayload.error);
    }
    renderFilters();
    renderRules();
  } catch (error) {
    renderPageError(error.message || "影片放映模板加载失败。");
    dom.tableWrap.innerHTML = `<div class="film-playback-table-empty">${escapeHtml(error.message || "加载失败")}</div>`;
    renderPagination(getPaginationState(0, 1, state.pageSize), 0);
  } finally {
    setBusy(false);
  }
}

function normalizeRuntimeHalls(halls) {
  return halls.map((hall) => ({
    id: hall?.registration?.hallId || hall?.id || "",
    name: hall?.registration?.hallName || hall?.name || hall?.registration?.hallId || "未命名影厅",
    online: hall?.snapshot?.connectivity?.state === "online",
  })).filter((hall) => hall.id);
}

function renderFilters() {
  dom.hallFilter.innerHTML = `<option value="">全部影厅</option>${state.halls.map((hall) => (
    `<option value="${escapeAttr(hall.id)}">${escapeHtml(hall.name)}</option>`
  )).join("")}`;
  dom.hallFilter.value = state.filters.hallId;

  const films = [...new Map(state.filterFilms.map((film) => [film.filmCd, film])).values()]
    .sort((left, right) => left.filmName.localeCompare(right.filmName, "zh-Hans-CN"));
  dom.filmFilter.innerHTML = `<option value="">全部影片版本</option>${films.map((film) => (
    `<option value="${escapeAttr(film.filmCd)}">${escapeHtml(formatFilmLabel(film))}</option>`
  )).join("")}`;
  dom.filmFilter.value = state.filters.filmCd;
}

function renderRules() {
  const pagination = getPaginationState(state.totalRules, state.page, state.pageSize);

  dom.ruleCount.textContent = String(state.summary.ruleCount);
  dom.filmCount.textContent = String(state.summary.filmCount);
  dom.hallCount.textContent = String(state.summary.hallCount);
  renderPagination(pagination, state.totalRules);

  if (state.rules.length === 0) {
    dom.tableWrap.innerHTML = `<div class="film-playback-table-empty">暂无匹配的放映模板</div>`;
    return;
  }

  dom.tableWrap.innerHTML = `
    <table class="table table-sm data-table">
      <thead>
        <tr>
          <th>影片版本</th>
          <th>适用影厅</th>
          <th>播放表</th>
          <th>时间点信息</th>
          <th>更新</th>
          <th class="text-right">操作</th>
        </tr>
      </thead>
      <tbody>
        ${state.rules.map(renderRuleRow).join("")}
      </tbody>
    </table>
  `;
}

function renderPagination(pagination, total) {
  if (!dom.pagination) {
    return;
  }
  const firstItem = total > 0 ? pagination.startIndex + 1 : 0;
  const lastItem = total > 0 ? pagination.endIndex : 0;
  const prevButton = dom.pagination.querySelector("[data-film-playback-page-action='prev']");
  const nextButton = dom.pagination.querySelector("[data-film-playback-page-action='next']");

  dom.pagination.classList.toggle("hidden", total === 0);
  if (dom.pageInfo) {
    dom.pageInfo.textContent = `${firstItem}-${lastItem} / ${total}`;
  }
  if (dom.pageNumber) {
    dom.pageNumber.textContent = `${pagination.page} / ${pagination.totalPages}`;
  }
  if (dom.pageSize) {
    dom.pageSize.value = String(pagination.pageSize);
  }
  if (prevButton instanceof HTMLButtonElement) {
    prevButton.disabled = pagination.page <= 1;
  }
  if (nextButton instanceof HTMLButtonElement) {
    nextButton.disabled = pagination.page >= pagination.totalPages;
  }

  const mobileSummary = document.getElementById("filmPlaybackMobileFilterSummary");
  if (mobileSummary) {
    mobileSummary.textContent = total > 0
      ? `${firstItem}-${lastItem} / ${total} 个模板`
      : "暂无匹配模板";
  }
}

async function loadRulesData() {
  setBusy(true);
  renderPageError("");
  try {
    applyRulesPayload(await fetchRulesPayload());
    renderFilters();
    renderRules();
  } catch (error) {
    renderPageError(error.message || "影片放映模板加载失败。");
    dom.tableWrap.innerHTML = `<div class="film-playback-table-empty">${escapeHtml(error.message || "加载失败")}</div>`;
    renderPagination(getPaginationState(0, 1, state.pageSize), 0);
  } finally {
    setBusy(false);
  }
}

function fetchRulesPayload() {
  const params = new URLSearchParams();
  params.set("page", String(state.page));
  params.set("pageSize", String(state.pageSize));
  if (state.filters.search) params.set("search", state.filters.search);
  if (state.filters.hallId) params.set("hallId", state.filters.hallId);
  if (state.filters.filmCd) params.set("filmCd", state.filters.filmCd);
  return apiGet(`/api/film-playback/rules?${params.toString()}`);
}

function applyRulesPayload(payload) {
  const pagination = payload?.pagination || {};
  const summary = payload?.summary || {};

  state.rules = Array.isArray(payload?.rules) ? payload.rules : [];
  state.ruleOccupancies = Array.isArray(payload?.occupancies) ? payload.occupancies : [];
  state.filterFilms = Array.isArray(payload?.filterFilms) ? payload.filterFilms : [];
  state.page = Number(pagination.page) || state.page;
  state.pageSize = readPageSize(pagination.pageSize);
  state.totalRules = Number(pagination.total) || 0;
  state.totalPages = Math.max(1, Number(pagination.totalPages) || 1);
  state.summary = {
    ruleCount: Number(summary.ruleCount) || 0,
    filmCount: Number(summary.filmCount) || 0,
    hallCount: Number(summary.hallCount) || 0,
  };
}

function changePage(action) {
  const pagination = getPaginationState(state.totalRules, state.page, state.pageSize);
  state.page = action === "next"
    ? Math.min(pagination.page + 1, pagination.totalPages)
    : Math.max(pagination.page - 1, 1);
  void loadRulesData();
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
  return [10, 20, 50].includes(numeric) ? numeric : 10;
}

function renderRuleRow(rule) {
  const playlistIds = (rule.playlistRefs || []).map((ref) => ref.playlistId).join(" / ");
  const timeSummary = renderTimePointSummary(rule);
  return `
    <tr>
      <td class="film-playback-mobile-card-cell" colspan="6">
        <details class="collapse collapse-arrow bg-base-100 border border-base-300">
          <summary class="collapse-title film-playback-mobile-card-title">
            <div class="min-w-0">
              <div class="film-playback-mobile-card-name">${escapeHtml(rule.filmName)}</div>
              <div class="film-playback-mobile-card-meta">${escapeHtml(rule.playlistName || "未绑定播放表")}</div>
            </div>
          </summary>
          <div class="collapse-content film-playback-mobile-card-content">
            <dl>
              <div>
                <dt>影片版本</dt>
                <dd>
                  <div class="film-playback-pill-row">
                    <span class="badge badge-ghost badge-sm">${escapeHtml(rule.filmCd)}</span>
                    ${rule.filmVisual ? `<span class="badge badge-info badge-sm">${escapeHtml(rule.filmVisual)}</span>` : ""}
                    ${rule.filmLanguage ? `<span class="badge badge-outline badge-sm">${escapeHtml(rule.filmLanguage)}</span>` : ""}
                  </div>
                </dd>
              </div>
              <div>
                <dt>适用影厅</dt>
                <dd>${renderHallBadges(rule.hallIds)}</dd>
              </div>
              <div>
                <dt>播放表</dt>
                <dd>
                  <div class="font-medium">${escapeHtmlPreservingSpaces(rule.playlistName)}</div>
                  <div class="text-xs text-base-content/50">${escapeHtml(playlistIds)}</div>
                </dd>
              </div>
              <div>
                <dt>时间点</dt>
                <dd>${timeSummary}</dd>
              </div>
              <div>
                <dt>更新</dt>
                <dd>${escapeHtml(formatDate(rule.updatedAt))}</dd>
              </div>
            </dl>
            <div class="film-playback-mobile-card-actions">
              <button class="btn btn-ghost btn-sm" data-edit-rule="${escapeAttr(rule.id)}">编辑</button>
              <button class="btn btn-ghost btn-sm text-error" data-delete-rule="${escapeAttr(rule.id)}">删除</button>
            </div>
          </div>
        </details>
      </td>
      <td class="film-playback-film-cell" data-label="影片版本">
        <div class="film-playback-film-name">${escapeHtml(rule.filmName)}</div>
        <div class="film-playback-pill-row">
          <span class="badge badge-ghost badge-sm">${escapeHtml(rule.filmCd)}</span>
          ${rule.filmVisual ? `<span class="badge badge-info badge-sm">${escapeHtml(rule.filmVisual)}</span>` : ""}
          ${rule.filmLanguage ? `<span class="badge badge-outline badge-sm">${escapeHtml(rule.filmLanguage)}</span>` : ""}
        </div>
      </td>
      <td data-label="适用影厅">${renderHallBadges(rule.hallIds)}</td>
      <td data-label="播放表">
        <div class="font-medium">${escapeHtmlPreservingSpaces(rule.playlistName)}</div>
        <div class="text-xs text-base-content/50">${escapeHtml(playlistIds)}</div>
      </td>
      <td data-label="时间点信息">${timeSummary}</td>
      <td class="text-xs text-base-content/60" data-label="更新">${escapeHtml(formatDate(rule.updatedAt))}</td>
      <td data-label="操作">
        <div class="film-playback-rule-actions justify-end">
          <button class="btn btn-ghost btn-xs" data-edit-rule="${escapeAttr(rule.id)}">编辑</button>
          <button class="btn btn-ghost btn-xs text-error" data-delete-rule="${escapeAttr(rule.id)}">删除</button>
        </div>
      </td>
    </tr>
  `;
}

function renderHallBadges(hallIds = []) {
  return `<div class="film-playback-pill-row">${hallIds.map((hallId) => (
    `<span class="badge badge-outline badge-sm">${escapeHtml(getHallName(hallId))}</span>`
  )).join("")}</div>`;
}

function renderTimePointSummary(rule) {
  const points = normalizeRuleTimePoints(rule).filter((point) => !(isFixedTimePoint(point) && point.startSeconds === 0));
  if (!points.length) {
    return `<span class="text-xs text-base-content/50">无</span>`;
  }
  return `<div class="film-playback-time-summary-list">${points.map((point) => (
    `<span class="badge badge-ghost badge-sm">${escapeHtml(formatTimePointSummary(point))}</span>`
  )).join("")}</div>`;
}

function formatTimePointSummary(point) {
  const note = point.note || getDefaultTimePointNote(point.type);
  const timeText = point.type === "range"
    ? formatTimeRange(point.startSeconds, point.endSeconds)
    : formatSecondsClock(point.startSeconds);
  return `${note} ${timeText}`;
}

function openRuleDialog(rule = null) {
  state.editingRule = rule;
  dom.form.reset();
  dom.formError.classList.add("hidden");
  dom.ruleId.value = rule?.id || "";
  dom.dialogTitle.textContent = rule ? "编辑放映模板" : "新增放映模板";
  state.selectedPlaylistCheck = null;
  state.timeEditTouched = false;
  state.timeEditError = "";
  state.commonAutomationLabels = [];
  state.commonAutomationLabelsLoading = false;
  state.editingHttpPointId = "";
  state.timePoints = normalizeRuleTimePoints(rule);
  renderTimePoints();
  renderPlaylistCheck();
  renderFilmOptions(rule);
  renderHallChoices(rule);
  renderSelectedFilmButton();
  void loadPlaylistChoices(rule);
  if (state.timePoints.some((point) => point.action?.type === "executeCommand")) {
    void loadCommonAutomationLabelsForSelectedHalls();
  }
  dom.dialog.showModal();
}

function renderFilmOptions(rule = null) {
  const options = [...state.films];
  if (rule && !options.some((film) => film.filmCd === rule.filmCd)) {
    options.unshift({
      filmCd: rule.filmCd,
      filmName: rule.filmName,
      visual: rule.filmVisual,
      language: rule.filmLanguage,
      label: formatFilmLabel(rule),
      sessionCount: 0,
      showDates: [],
      rawFilm: rule.rawFilm,
    });
  }

  dom.filmSelect.value = rule?.filmCd || "";
  dom.filmList.innerHTML = options.length
    ? options.map((film) => renderFilmOption(film)).join("")
    : `<div class="film-playback-film-empty">暂无可选影片版本</div>`;
  renderSelectedFilmButton();
}

function renderFilmOption(film) {
  const selected = film.filmCd === dom.filmSelect.value;
  return `
    <button type="button" class="film-playback-film-option ${selected ? "is-selected" : ""}" data-film-option="${escapeAttr(film.filmCd)}">
      <span class="film-playback-film-option-main">
        <strong>${escapeHtml(formatFilmOptionText(film))}</strong>
        ${renderFilmOptionTags(film)}
      </span>
    </button>
  `;
}

function renderSelectedFilmButton() {
  const film = getSelectedFilm();
  if (!film) {
    dom.filmButtonLabel.textContent = "请选择影片版本";
    dom.filmButtonTags.innerHTML = "";
    dom.filmList.querySelectorAll("[data-film-option]").forEach((node) => node.classList.remove("is-selected"));
    return;
  }
  dom.filmButtonLabel.innerHTML = `
    <span class="film-playback-film-button-title">${escapeHtml(formatFilmOptionText(film))}</span>
    ${renderFilmOptionTags(film)}
  `;
  dom.filmButtonTags.innerHTML = "";
  dom.filmList.querySelectorAll("[data-film-option]").forEach((node) => {
    node.classList.toggle("is-selected", node.dataset.filmOption === film.filmCd);
  });
}

function renderFilmOptionTags(film) {
  const tags = [
    { label: film.visual || film.filmVisual, type: "visual" },
    { label: film.language || film.filmLanguage, type: "language" },
  ].filter((tag) => tag.label);
  return tags.length
    ? `<span class="film-playback-film-option-tags">${tags.map((tag) => (
      `<span class="film-playback-film-tag is-${tag.type}">${escapeHtml(tag.label)}</span>`
    )).join("")}</span>`
    : "";
}

function toggleFilmOptions() {
  if (dom.filmList.hidden) {
    openFilmOptions();
  } else {
    closeFilmOptions();
  }
}

function openFilmOptions() {
  dom.filmList.hidden = false;
  dom.filmPicker.classList.add("is-open");
}

function closeFilmOptions() {
  dom.filmList.hidden = true;
  dom.filmPicker.classList.remove("is-open");
}

function selectFilmOption(filmCd) {
  dom.filmSelect.value = filmCd;
  closeFilmOptions();
  dom.filmSelect.dispatchEvent(new Event("change", { bubbles: true }));
}

function renderHallChoices(rule = state.editingRule) {
  const filmCd = dom.filmSelect.value;
  const selected = new Set(rule?.hallIds || []);
  const occupied = getOccupiedHallIds(filmCd, rule?.id);

  if (state.halls.length === 0) {
    dom.hallList.innerHTML = `<div class="film-playback-muted">暂无已配置影厅。</div>`;
    return;
  }

  dom.hallList.innerHTML = state.halls.map((hall) => {
    const disabled = (!hall.online && !selected.has(hall.id)) || occupied.has(hall.id) && !selected.has(hall.id);
    const meta = !hall.online ? "未在线/未知" : disabled ? "该影片版本已配置" : "在线";
    return `
      <label class="film-playback-check-item ${disabled ? "is-disabled" : ""}">
        <input type="checkbox" class="checkbox checkbox-sm" value="${escapeAttr(hall.id)}" ${selected.has(hall.id) ? "checked" : ""} ${disabled ? "disabled" : ""}>
        <span>
          <span class="name">${escapeHtml(hall.name)}</span>
          <span class="meta">${escapeHtml(meta)}</span>
        </span>
      </label>
    `;
  }).join("");
}

async function loadPlaylistChoices(rule = state.editingRule) {
  const selectedHallIds = getSelectedHallIds();
  state.playlistInspectSeq += 1;
  state.selectedPlaylistCheck = null;
  renderPlaylistCheck();
  dom.playlistSelect.disabled = true;
  dom.playlistSelect.innerHTML = `<option value="">${selectedHallIds.length ? "正在加载播放表..." : "请先选择影厅"}</option>`;
  renderPlaylistHint(selectedHallIds.length ? "正在读取所选影厅的播放表。" : "选择影厅后加载可用播放表。");

  if (selectedHallIds.length === 0) {
    return;
  }

  try {
    const onlineHallIds = selectedHallIds.filter((hallId) => isHallOnline(hallId));
    await Promise.all(onlineHallIds.map((hallId) => loadShowsForHall(hallId)));
    const choices = buildPlaylistChoicesForSelectedHalls(selectedHallIds, onlineHallIds, rule);
    const selectedChoiceKey = rule ? resolveRulePlaylistChoiceKey(rule, choices, selectedHallIds) : "";
    if (rule && !selectedChoiceKey) {
      choices.unshift({
        key: getRulePlaylistKey(rule),
        name: rule.playlistName,
        refs: rule.playlistRefs || [],
        stale: true,
      });
    }

    if (choices.length === 0) {
      dom.playlistSelect.innerHTML = `<option value="">所选影厅没有共同播放表</option>`;
      renderPlaylistHint(selectedHallIds.some((hallId) => !isHallOnline(hallId))
        ? "部分影厅离线，无法读取共同播放表。"
        : "所选影厅没有同名播放表，请拆分规则或先复制播放表。");
      return;
    }

    dom.playlistSelect.innerHTML = `<option value="">请选择播放表</option>${choices.map((choice) => (
      `<option value="${escapeAttr(choice.key)}" data-name="${escapeAttr(choice.name)}" data-refs="${escapeAttr(JSON.stringify(choice.refs))}">${escapeHtmlPreservingSpaces(choice.name)}${choice.stale ? "（当前保存，未在设备中找到）" : ""}</option>`
    )).join("")}`;
    dom.playlistSelect.value = selectedChoiceKey || (rule ? getRulePlaylistKey(rule) : "");
    dom.playlistSelect.disabled = false;
    renderPlaylistHint(selectedHallIds.some((hallId) => !isHallOnline(hallId))
      ? "离线影厅使用已保存的播放表快照。"
      : selectedHallIds.length === 1 ? "显示所选影厅的播放表。" : "仅显示所有所选影厅中同名的播放表。");
    if (dom.playlistSelect.value) {
      void inspectSelectedPlaylistChoice();
    }
  } catch (error) {
    dom.playlistSelect.innerHTML = `<option value="">播放表加载失败</option>`;
    renderPlaylistHint(error.message || "播放表加载失败。");
    renderPlaylistCheck();
  }
}

function buildPlaylistChoicesForSelectedHalls(selectedHallIds, onlineHallIds, rule = null) {
  const offlineHallIds = selectedHallIds.filter((hallId) => !onlineHallIds.includes(hallId));
  if (offlineHallIds.length === 0) {
    return buildPlaylistChoices(selectedHallIds);
  }

  const offlineRefs = [];
  for (const hallId of offlineHallIds) {
    const ref = (rule?.playlistRefs || []).find((item) => item.hallId === hallId);
    if (!ref) {
      return [];
    }
    offlineRefs.push(ref);
  }

  const offlineKey = getCommonPlaylistNameKey(offlineRefs.map((ref) => ref.playlistName));
  if (!offlineKey) {
    return [];
  }

  if (onlineHallIds.length === 0) {
    return [{
      key: `title:${offlineKey}`,
      name: offlineRefs[0]?.playlistName || rule?.playlistName || "已保存播放表",
      refs: offlineRefs,
      snapshotOnly: true,
    }];
  }

  return buildPlaylistChoices(onlineHallIds)
    .filter((choice) => normalizePlaylistName(choice.name) === offlineKey)
    .map((choice) => ({
      ...choice,
      key: `title:${offlineKey}`,
      refs: [...choice.refs, ...offlineRefs],
      snapshotOnly: choice.snapshotOnly === true,
    }));
}

function renderPlaylistHint(message) {
  if (dom.playlistHint) {
    dom.playlistHint.textContent = message;
  }
}

async function loadShowsForHall(hallId) {
  if (state.showsByHallId.has(hallId)) return state.showsByHallId.get(hallId);
  const payload = await apiPost(`/api/runtime/halls/${encodeURIComponent(hallId)}/shows`, {});
  const shows = Array.isArray(payload.shows) ? payload.shows : [];
  state.showsByHallId.set(hallId, shows);
  return shows;
}

function buildPlaylistChoices(hallIds) {
  const showLists = hallIds.map((hallId) => ({
    hallId,
    shows: state.showsByHallId.get(hallId) || [],
  }));
  if (showLists.length === 1) {
    return showLists[0].shows.map((show) => ({
      key: show.showUuid,
      name: show.title || show.showUuid,
      refs: [{ hallId: showLists[0].hallId, playlistId: show.showUuid, playlistName: show.title || show.showUuid }],
    })).sort(comparePlaylistChoice);
  }

  const byName = new Map();
  for (const { hallId, shows } of showLists) {
    const seenInHall = new Set();
    for (const show of shows) {
      const name = (show.title || show.showUuid || "").trim();
      const normalized = normalizePlaylistName(name);
      if (!normalized || seenInHall.has(normalized)) continue;
      seenInHall.add(normalized);
      const entry = byName.get(normalized) || { name, refs: [] };
      entry.refs.push({ hallId, playlistId: show.showUuid, playlistName: name });
      byName.set(normalized, entry);
    }
  }

  return [...byName.entries()]
    .filter(([, entry]) => entry.refs.length === hallIds.length)
    .map(([key, entry]) => ({ key: `title:${key}`, name: entry.name, refs: entry.refs }))
    .sort(comparePlaylistChoice);
}

function comparePlaylistChoice(left, right) {
  return left.name.localeCompare(right.name, "zh-Hans-CN");
}

async function inspectSelectedPlaylistChoice() {
  const selectedOption = dom.playlistSelect.selectedOptions[0];
  const refs = readSelectedPlaylistRefs();
  const requestSeq = ++state.playlistInspectSeq;
  const selectedKey = selectedOption?.value || "";
  const refsSignature = buildPlaylistRefsSignature(refs);
  state.selectedPlaylistCheck = null;
  if (!selectedOption?.value || refs.length === 0) {
    renderPlaylistCheck();
    return null;
  }

  state.selectedPlaylistCheck = {
    key: selectedOption.value,
    loading: true,
    consistent: false,
    refs,
    issues: [],
    details: [],
  };
  renderPlaylistCheck();

  try {
    const { details, warnings } = await loadPlaylistDetailsWithSnapshot(refs);
    if (!isCurrentPlaylistInspectRequest(requestSeq, selectedKey, refsSignature)) {
      return state.selectedPlaylistCheck;
    }
    const check = comparePlaylistDetails(refs, details);
    state.selectedPlaylistCheck = {
      key: selectedOption.value,
      loading: false,
      refs,
      refsSignature,
      details,
      warnings,
      ...check,
    };
  } catch (error) {
    if (!isCurrentPlaylistInspectRequest(requestSeq, selectedKey, refsSignature)) {
      return state.selectedPlaylistCheck;
    }
    state.selectedPlaylistCheck = {
      key: selectedOption.value,
      loading: false,
      consistent: false,
      refs,
      refsSignature,
      issues: [error.message || "播放表详情读取失败。"],
      warnings: [],
      details: [],
    };
  }
  renderPlaylistCheck();
  renderTimePoints();
  return state.selectedPlaylistCheck;
}

async function loadPlaylistDetailsWithSnapshot(refs) {
  const details = [];
  const warnings = [];
  const snapshot = state.editingRule?.playlistSnapshot || null;

  for (const ref of refs) {
    const snapshotDetail = getSnapshotDetailForRef(snapshot, ref);
    if (!isHallOnline(ref.hallId)) {
      if (!snapshotDetail) {
        throw new Error(`${getHallName(ref.hallId)} 离线且没有可用播放表快照。`);
      }
      details.push({ ...snapshotDetail, hallId: ref.hallId, snapshotSource: true });
      continue;
    }

    try {
      const liveDetail = await loadShowDetail(ref.hallId, ref.playlistId);
      details.push(liveDetail);
      if (snapshotDetail && !isSamePlaylistDetail(liveDetail, snapshotDetail)) {
        throw new Error(`${getHallName(ref.hallId)} 播放表与上次保存快照不一致。`);
      }
    } catch (error) {
      if (snapshotDetail) {
        if (isSnapshotDriftError(error)) {
          throw error;
        }
        warnings.push(`${getHallName(ref.hallId)} 当前无法读取播放表，已使用上次保存的快照。`);
        details.push({ ...snapshotDetail, hallId: ref.hallId, snapshotSource: true });
        continue;
      }
      throw error;
    }
  }

  return { details, warnings };
}

function getSnapshotDetailForRef(snapshot, ref) {
  const details = Array.isArray(snapshot?.details) ? snapshot.details : [];
  return details.find((detail) => detail.hallId === ref.hallId && detail.showUuid === ref.playlistId)
    || (isSavedPlaylistRef(ref) ? details.find((detail) => detail.hallId === ref.hallId) : null)
    || null;
}

function isSavedPlaylistRef(ref) {
  return (state.editingRule?.playlistRefs || []).some((savedRef) => (
    savedRef.hallId === ref?.hallId
    && normalizeUuid(savedRef.playlistId) === normalizeUuid(ref?.playlistId)
  ));
}

function isSamePlaylistDetail(left, right) {
  return JSON.stringify(buildPlaylistSignature(left)) === JSON.stringify(buildPlaylistSignature(right));
}

function readSelectedPlaylistRefs() {
  const selectedOption = dom.playlistSelect.selectedOptions[0];
  if (!selectedOption?.dataset.refs) {
    return [];
  }
  try {
    const refs = JSON.parse(selectedOption.dataset.refs);
    return Array.isArray(refs) ? refs : [];
  } catch {
    return [];
  }
}

async function loadShowDetail(hallId, showUuid) {
  const cacheKey = `${hallId}::${showUuid}`;
  if (state.showDetailsByRef.has(cacheKey)) {
    return state.showDetailsByRef.get(cacheKey);
  }
  const payload = await apiPost(
    `/api/runtime/halls/${encodeURIComponent(hallId)}/shows/${encodeURIComponent(showUuid)}`,
    {},
  );
  const detail = normalizeShowDetail(payload.show, hallId);
  state.showDetailsByRef.set(cacheKey, detail);
  return detail;
}

function normalizeShowDetail(show, hallId) {
  return {
    hallId,
    showUuid: show?.showUuid || "",
    title: show?.title || "",
    segments: Array.isArray(show?.segments) ? show.segments.map((segment) => ({
      cplUuid: segment.cplUuid || "",
      commands: Array.isArray(segment.commands) ? segment.commands.map((command) => ({
        label: command.label || "",
        annotationText: command.annotationText || command.label || "",
        offsetFrames: Number.isFinite(command.offsetFrames) ? command.offsetFrames : undefined,
        editRate: command.editRate || "",
      })) : [],
    })) : [],
    segmentDetails: Array.isArray(show?.segmentDetails) ? show.segmentDetails : [],
  };
}

function comparePlaylistDetails(refs, details) {
  const issues = [];
  const base = details[0];
  if (!base) {
    return { consistent: false, issues: ["没有读取到播放表详情。"] };
  }

  const baseSignature = buildPlaylistSignature(base);
  details.slice(1).forEach((detail, index) => {
    const ref = refs[index + 1];
    const hallName = getHallName(ref?.hallId || detail.hallId);
    const signature = buildPlaylistSignature(detail);
    if (signature.cplUuids.join("|") !== baseSignature.cplUuids.join("|")) {
      issues.push(`${hallName} 的 CPL 顺序或数量不一致。`);
    }
    if (JSON.stringify(signature.commands) !== JSON.stringify(baseSignature.commands)) {
      issues.push(`${hallName} 的命令或命令时间点不一致。`);
    }
  });

  return {
    consistent: issues.length === 0,
    issues,
  };
}

function buildPlaylistSignature(detail) {
  return {
    cplUuids: detail.segments.map((segment) => normalizeUuid(segment.cplUuid)),
    commands: detail.segments.map((segment, segmentIndex) => (
      (segment.commands || []).map((command) => ({
        label: command.label || "",
        annotationText: command.annotationText || command.label || "",
        offsetFrames: getCommandOffsetFramesForCompare(command, detail.segmentDetails[segmentIndex]),
        editRate: command.editRate || "",
      }))
    )),
  };
}

function getCommandOffsetFramesForCompare(command, cpl) {
  const rawOffset = Number(command?.offsetFrames);
  const offset = Number.isFinite(rawOffset) ? Math.max(0, Math.round(rawOffset)) : 0;
  const durationFrames = Number(cpl?.durationFrames);
  if (!Number.isFinite(durationFrames) || durationFrames <= 0) {
    return offset;
  }
  return Math.min(offset, Math.max(0, Math.round(durationFrames) - 1));
}

function buildPlaylistRefsSignature(refs) {
  return JSON.stringify((Array.isArray(refs) ? refs : []).map((ref) => ({
    hallId: String(ref?.hallId || ""),
    playlistId: normalizeUuid(ref?.playlistId),
  })).sort((left, right) => left.hallId.localeCompare(right.hallId)));
}

function isCurrentPlaylistInspectRequest(requestSeq, selectedKey, refsSignature) {
  return requestSeq === state.playlistInspectSeq
    && dom.playlistSelect.value === selectedKey
    && buildPlaylistRefsSignature(readSelectedPlaylistRefs()) === refsSignature;
}

function isSnapshotDriftError(error) {
  const message = error instanceof Error ? error.message : String(error || "");
  return message.includes("播放表与上次保存快照不一致");
}

function renderPlaylistCheck() {
  if (!dom.playlistCheck) {
    return;
  }
  const check = state.selectedPlaylistCheck;
  if (!check) {
    updateTimeEditingState(null);
    dom.playlistCheck.innerHTML = "";
    return;
  }
  if (check.loading) {
    updateTimeEditingState(null);
    dom.playlistCheck.innerHTML = `
      <div class="film-playback-playlist-summary is-loading">
        <span class="loading loading-spinner loading-xs"></span>
        <span>正在检查同名播放表内容...</span>
      </div>
    `;
    return;
  }

  const reference = check.details?.[0];
  updateTimeEditingState(reference);
  dom.playlistCheck.innerHTML = `
    ${check.consistent ? "" : `
      <div class="film-playback-playlist-summary is-blocked">
        <i class="fas fa-circle-exclamation"></i>
        <span>播放表检查未通过，请先处理下方问题。</span>
      </div>
    `}
    ${check.warnings?.length ? `
      <div class="film-playback-playlist-summary is-warning">
        <i class="fas fa-triangle-exclamation"></i>
        <span>${escapeHtml(check.warnings[0])}</span>
      </div>
      ${check.warnings.length > 1 ? `<ul class="film-playback-playlist-issues">${check.warnings.slice(1).map((warning) => `<li>${escapeHtml(warning)}</li>`).join("")}</ul>` : ""}
    ` : ""}
    ${check.issues?.length ? `<ul class="film-playback-playlist-issues">${check.issues.map((issue) => `<li>${escapeHtml(issue)}</li>`).join("")}</ul>` : ""}
    ${check.consistent && reference ? renderPlaylistTimeline(reference) : ""}
  `;
}

function updateTimeEditingState(referenceShow) {
  clearTimeInputErrors();
  applyTimeInputLimits(referenceShow);
  clampAllTimeInputs();
  applyTimeInputLimits(referenceShow);
  clampAllTimeInputs();
  applyTimeInputLimits(referenceShow);
  let error = "";
  if (referenceShow) {
    try {
      error = validateRuleTimes(referenceShow);
    } catch (validationError) {
      error = validationError.message || "时间格式不正确。";
    }
  }
  state.timeEditError = error;
  if (error) {
    markInvalidTimeInputs(error);
  }
  renderTimeEditError(error);
  syncSaveButtonState();
}

function applyTimeInputLimits(referenceShow) {
  const totalDuration = referenceShow ? getPlaylistDurationSeconds(referenceShow) : 0;
  const max = totalDuration > 0 ? formatSecondsClock(totalDuration) : "";
  const setLimit = (input, minSeconds = 0, options = {}) => {
    if (!input) return;
    input.dataset.effectiveMinSeconds = String(Math.max(0, Math.round(minSeconds)));
    input.dataset.allowZeroEmpty = options.allowZeroEmpty ? "true" : "false";
    input.min = formatSecondsClock(options.allowZeroEmpty ? 0 : minSeconds);
    if (max) {
      input.max = max;
    } else {
      input.removeAttribute("max");
    }
  };

  const head = state.timePoints.find((point) => point.type === "head");
  const headSeconds = Number.isFinite(head?.startSeconds) ? head.startSeconds : 0;
  dom.timePointList.querySelectorAll("[data-time-point-id]").forEach((row) => {
    const point = state.timePoints.find((item) => item.id === row.dataset.timePointId);
    const startInput = row.querySelector("[data-time-point-field='startSeconds']");
    const endInput = row.querySelector("[data-time-point-field='endSeconds']");
    setLimit(startInput, point?.type === "tail" && headSeconds > 0 ? headSeconds + 1 : 0, { allowZeroEmpty: isFixedTimePoint(point) });
    const startSeconds = readTimeInputSafe(startInput);
    if (endInput) {
      setLimit(endInput, Number.isFinite(startSeconds) ? startSeconds + 1 : 1);
    }
  });
}

function clearTimeInputErrors() {
  [...getEditorTimeInputs(), ...getEditorActionInputs()].forEach((input) => {
    input?.classList.remove("input-error");
    input?.removeAttribute("title");
  });
}

function clampAllTimeInputs() {
  getEditorTimeInputs().forEach((input) => {
    clampTimeInputValue(input);
    syncStateTimeFieldFromInput(input);
  });
}

function clampTimeInputValue(input) {
  if (!input) {
    return false;
  }
  const seconds = readTimeInputSafe(input);
  if (!Number.isFinite(seconds)) {
    return false;
  }
  if (seconds === 0 && input.dataset.allowZeroEmpty === "true") {
    return false;
  }

  const minSeconds = Number(input.dataset.effectiveMinSeconds);
  const maxSeconds = parseClockSeconds(input.max);
  let nextSeconds = seconds;
  if (Number.isFinite(minSeconds) && nextSeconds < minSeconds) {
    nextSeconds = minSeconds;
  }
  if (Number.isFinite(maxSeconds) && nextSeconds > maxSeconds) {
    nextSeconds = maxSeconds;
  }
  if (nextSeconds !== seconds) {
    setTimeInput(input, nextSeconds);
    return true;
  }
  return false;
}

function markInvalidTimeInputs(error) {
  const mark = (...inputs) => {
    inputs.forEach((input) => {
      if (!input) return;
      input.classList.add("input-error");
      input.title = error;
    });
  };

  if (error.includes("片尾字幕") && !error.includes("彩蛋")) {
    dom.timePointList.querySelectorAll("[data-time-point-id]").forEach((row) => {
      const point = state.timePoints.find((item) => item.id === row.dataset.timePointId);
      if (point?.type === "head" || point?.type === "tail") {
        mark(row.querySelector("[data-time-point-field='startSeconds']"));
      }
    });
    return;
  }

  if (error.includes("播放表总时长")) {
    getEditorTimeInputs().forEach((input) => {
      const seconds = readTimeInputSafe(input);
      const maxSeconds = parseClockSeconds(input?.max);
      if (Number.isFinite(seconds) && Number.isFinite(maxSeconds) && seconds > maxSeconds) {
        mark(input);
      }
    });
    return;
  }

  if (error.includes("结束时间")) {
    dom.timePointList.querySelectorAll("[data-time-point-id]").forEach((row) => {
      const endInput = row.querySelector("[data-time-point-field='endSeconds']");
      if (endInput) mark(endInput);
    });
  }
}

function markInvalidActionInput(pointId, selector, message) {
  const row = dom.timePointList.querySelector(`[data-time-point-id="${cssEscape(pointId)}"]`);
  const input = row?.querySelector(selector);
  if (!input) {
    return;
  }
  input.classList.add("input-error");
  input.title = message;
}

function getEditorTimeInputs() {
  return [...dom.timePointList.querySelectorAll("input[type='time']")];
}

function getEditorActionInputs() {
  return [...dom.timePointList.querySelectorAll("[data-time-point-action-field], [data-time-point-field='actionType']")];
}

function syncStateTimeFieldFromInput(input) {
  const row = input?.closest("[data-time-point-id]");
  const id = row?.dataset.timePointId;
  const point = state.timePoints.find((item) => item.id === id);
  const field = input?.dataset.timePointField;
  if (!point || !field) {
    return;
  }
  point[field] = readTimeInputSafe(input);
}

function cssEscape(value) {
  if (globalThis.CSS?.escape) {
    return globalThis.CSS.escape(String(value));
  }
  return String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function renderTimeEditError(error) {
  if (!dom.formError) {
    return;
  }
  if (!error || !state.timeEditTouched) {
    dom.formError.classList.add("hidden");
    dom.formError.textContent = "";
    return;
  }
  dom.formError.textContent = error;
  dom.formError.classList.remove("hidden");
}

function renderPlaylistTimeline(detail) {
  const totalDuration = getPlaylistDurationSeconds(detail);
  const timelineWidth = getTimelinePixelWidth(detail);
  return `
    <div class="playlist-section-head">
      <div>
        <h2><i class="fas fa-timeline"></i> 播放表时间轴</h2>
        <p>${detail.segments.length} CPL · ${escapeHtml(formatSecondsClock(totalDuration))}</p>
      </div>
    </div>
    <div class="film-playback-playlist-timeline" style="--timeline-width: ${Math.round(timelineWidth)}px">
      ${detail.segments.length ? detail.segments.map((segment, index) => renderPlaylistSegment(detail, segment, index)).join("") : '<div class="playlist-empty playlist-timeline-empty">播放表没有 CPL。</div>'}
      ${detail.segments.length ? renderRuleTimelineAnnotations(detail) : ""}
    </div>
  `;
}

function renderPlaylistSegment(detail, segment, index) {
  const cpl = detail.segmentDetails[index] || {};
  const duration = getSegmentDurationSeconds(detail, index);
  const width = Math.min(Math.max(duration * TIMELINE_PIXELS_PER_SECOND, MIN_SEGMENT_WIDTH), MAX_SEGMENT_WIDTH);
  const title = getCplTitle(cpl) || shortUuid(segment.cplUuid);
  return `
    <article class="playlist-cpl-segment" style="--segment-width: ${Math.round(width)}px">
      <button type="button" class="playlist-segment-main">
        <strong class="playlist-segment-title">${escapeHtml(title)}</strong>
        <span class="playlist-segment-time">${escapeHtml(formatTimelineDuration(duration))}</span>
      </button>
      <div class="playlist-segment-markers">
        ${(segment.commands || []).length
          ? clusterCommands(segment.commands, duration, cpl).map((cluster) => renderMarker(cluster)).join("")
          : '<span class="playlist-marker-empty"></span>'}
      </div>
    </article>
  `;
}

function renderMarker(cluster) {
  const left = Math.min(Math.max(cluster.percent, 0), 100);
  const title = cluster.items
    .map((item) => `${item.command.label} · ${formatSecondsClock(item.offsetSeconds)}`)
    .join("\n");
  return `
    <button type="button" class="playlist-command-marker ${cluster.items.length > 1 ? "is-cluster" : ""}" style="left: ${left}%" title="${escapeAttr(title)}">
      <span class="playlist-command-triangle"></span>
      ${cluster.items.length > 1 ? `<span class="playlist-command-count">${cluster.items.length}</span>` : ""}
    </button>
  `;
}

function renderRuleTimelineAnnotations(detail) {
  const points = readTimePointsFromEditor({ allowPartial: true });
  const markers = points
    .filter((point) => point.type !== "range")
    .filter((point) => Number.isFinite(point.startSeconds) && (!isFixedTimePoint(point) || point.startSeconds > 0))
    .map((point) => ({
      type: point.type,
      label: getTimelinePointLabel(point),
      seconds: point.startSeconds,
    }));
  const ranges = points
    .filter((point) => point.type === "range")
    .filter((point) => Number.isFinite(point.startSeconds) && Number.isFinite(point.endSeconds));

  return `
    <div class="film-playback-timeline-overlay" aria-hidden="true">
      ${markers.map((marker) => renderTimelinePointMarker(marker, detail)).join("")}
      ${ranges.map((range, index) => renderTimelineRangeMarker(range, index, detail)).join("")}
    </div>
  `;
}

function renderTimelinePointMarker(marker, detail) {
  const left = timelinePositionPercent(marker.seconds, detail);
  return `
    <span class="film-playback-time-marker is-${marker.type}" style="left: ${left}%">
      <span>${escapeHtml(marker.label)}</span>
    </span>
  `;
}

function renderTimelineRangeMarker(range, index, detail) {
  const start = Math.min(range.startSeconds, range.endSeconds);
  const end = Math.max(range.startSeconds, range.endSeconds);
  const left = timelinePositionPercent(start, detail);
  const right = timelinePositionPercent(end, detail);
  const width = Math.max(right - left, 0.8);
  return `
    <span class="film-playback-time-range" style="left: ${left}%; width: ${width}%">
      <span>${escapeHtml(range.note || `时间段 ${index + 1}`)}</span>
    </span>
  `;
}

function getTimelinePixelWidth(detail) {
  return detail.segments.reduce((sum, _segment, index) => {
    const duration = getSegmentDurationSeconds(detail, index);
    return sum + Math.min(Math.max(duration * TIMELINE_PIXELS_PER_SECOND, MIN_SEGMENT_WIDTH), MAX_SEGMENT_WIDTH);
  }, 0);
}

function timelinePositionPercent(seconds, detail) {
  const totalWidth = getTimelinePixelWidth(detail);
  if (!Number.isFinite(seconds) || totalWidth <= 0) {
    return 0;
  }
  return Math.min(Math.max((timelinePositionPixels(seconds, detail) / totalWidth) * 100, 0), 100);
}

function timelinePositionPixels(seconds, detail) {
  let remainingSeconds = Math.max(0, Number(seconds) || 0);
  let offsetPixels = 0;

  for (let index = 0; index < detail.segments.length; index += 1) {
    const duration = getSegmentDurationSeconds(detail, index);
    const width = Math.min(Math.max(duration * TIMELINE_PIXELS_PER_SECOND, MIN_SEGMENT_WIDTH), MAX_SEGMENT_WIDTH);
    if (duration <= 0) {
      offsetPixels += width;
      continue;
    }
    if (remainingSeconds <= duration) {
      return offsetPixels + (remainingSeconds / duration) * width;
    }
    remainingSeconds -= duration;
    offsetPixels += width;
  }

  return offsetPixels;
}

async function saveRule(event) {
  event.preventDefault();
  dom.formError.classList.add("hidden");

  try {
    let playlistCheck = state.selectedPlaylistCheck;
    const currentRefs = readSelectedPlaylistRefs();
    const currentRefsSignature = buildPlaylistRefsSignature(currentRefs);
    if (
      !playlistCheck
      || playlistCheck.loading
      || playlistCheck.key !== dom.playlistSelect.value
      || playlistCheck.refsSignature !== currentRefsSignature
    ) {
      playlistCheck = await inspectSelectedPlaylistChoice();
    }
    if (!playlistCheck?.consistent) {
      throw new Error("请选择内容一致的播放表。");
    }
    const timeError = validateRuleTimes(playlistCheck.details?.[0]);
    if (timeError) {
      throw new Error(timeError);
    }
    const payload = buildRulePayload();
    state.saving = true;
    syncSaveButtonState();
    if (state.editingRule) {
      await apiPost(`/api/film-playback/rules/${encodeURIComponent(state.editingRule.id)}`, payload);
      toast.success("放映模板已更新");
    } else {
      await apiPost("/api/film-playback/rules", payload);
      state.page = 1;
      toast.success("放映模板已创建");
    }
    dom.dialog.close();
    await loadRulesData();
  } catch (error) {
    dom.formError.textContent = error.message || "保存失败。";
    dom.formError.classList.remove("hidden");
  } finally {
    state.saving = false;
    syncSaveButtonState();
  }
}

function buildRulePayload() {
  const film = getSelectedFilm();
  if (!film) throw new Error("请选择影片版本。");
  const hallIds = getSelectedHallIds();
  if (hallIds.length === 0) throw new Error("请至少选择一个适用影厅。");
  const selectedOption = dom.playlistSelect.selectedOptions[0];
  if (!selectedOption?.value) throw new Error("请选择对应播放表。");
  const playlistRefs = JSON.parse(selectedOption.dataset.refs || "[]");
  const timePoints = readTimePointsFromEditor();

  return {
    filmCd: film.filmCd,
    filmName: film.filmName,
    filmVisual: film.visual,
    filmLanguage: film.language,
    hallIds,
    playlistName: selectedOption.dataset.name || selectedOption.textContent.replace("（当前保存，未在设备中找到）", "").trim(),
    playlistRefs,
    timePoints,
    playlistSnapshot: buildPlaylistSnapshot(playlistRefs),
    rawFilm: film.rawFilm,
  };
}

function buildPlaylistSnapshot(playlistRefs) {
  const check = state.selectedPlaylistCheck;
  const details = Array.isArray(check?.details) ? check.details : [];
  if (details.length === 0) {
    return state.editingRule?.playlistSnapshot || null;
  }
  return {
    capturedAt: new Date().toISOString(),
    playlistName: dom.playlistSelect.selectedOptions[0]?.dataset.name
      || dom.playlistSelect.selectedOptions[0]?.textContent?.replace("（当前保存，未在设备中找到）", "").trim()
      || "",
    refs: playlistRefs,
    details: details.map(sanitizePlaylistDetailForSnapshot),
  };
}

function sanitizePlaylistDetailForSnapshot(detail) {
  return {
    hallId: detail.hallId || "",
    showUuid: detail.showUuid || "",
    title: detail.title || "",
    segments: (detail.segments || []).map((segment) => ({
      cplUuid: segment.cplUuid || "",
      commands: (segment.commands || []).map((command) => ({
        label: command.label || "",
        annotationText: command.annotationText || command.label || "",
        offsetFrames: Number.isFinite(command.offsetFrames) ? command.offsetFrames : undefined,
        editRate: command.editRate || "",
      })),
    })),
    segmentDetails: (detail.segmentDetails || []).map((cpl) => ({
      index: cpl.index,
      cplUuid: cpl.cplUuid || "",
      annotationText: cpl.annotationText,
      contentTitleText: cpl.contentTitleText,
      contentKind: cpl.contentKind,
      durationSeconds: cpl.durationSeconds,
      durationFrames: cpl.durationFrames,
      editRate: cpl.editRate,
      isStereoscopic: cpl.isStereoscopic,
      resolutionLabel: cpl.resolutionLabel,
      pictureWidth: cpl.pictureWidth,
      pictureHeight: cpl.pictureHeight,
      screenAspectRatio: cpl.screenAspectRatio,
      aspectRatioLabel: cpl.aspectRatioLabel,
      formatTags: cpl.formatTags,
    })),
  };
}

function validateRuleTimes(referenceShow) {
  const totalDuration = referenceShow ? getPlaylistDurationSeconds(referenceShow) : 0;
  const timePoints = readTimePointsFromEditor();
  const headStartSeconds = getFixedTimePointSeconds(timePoints, "head");
  const tailStartSeconds = getFixedTimePointSeconds(timePoints, "tail");
  if (timePoints.filter((point) => point.type === "head").length > 1) {
    return "片头时间点不能重复。";
  }
  if (timePoints.filter((point) => point.type === "tail").length > 1) {
    return "片尾时间点不能重复。";
  }

  const overLimit = timePoints.flatMap((point) => [
    { label: `${point.note || getDefaultTimePointNote(point.type)}${point.type === "range" ? "开始时间" : ""}`, seconds: point.startSeconds },
    ...(point.type === "range" ? [{ label: `${point.note || "时间段"}结束时间`, seconds: point.endSeconds }] : []),
  ]).find((item) => totalDuration > 0 && item.seconds > totalDuration);
  if (overLimit) {
    return `${overLimit.label}不能超过播放表总时长 ${formatSecondsClock(totalDuration)}。`;
  }

  if (headStartSeconds > 0 && tailStartSeconds > 0 && tailStartSeconds <= headStartSeconds) {
    return "片尾字幕出现时间必须晚于正片出现时间。";
  }

  for (const point of timePoints) {
    if (point.type === "range" && point.endSeconds <= point.startSeconds) {
      return `${point.note || "时间段"}结束时间必须晚于开始时间。`;
    }
    const actionError = validateTimePointAction(point);
    if (actionError) {
      return actionError;
    }
  }

  return "";
}

function validateTimePointAction(point) {
  const action = point.action || {};
  const note = point.note || getDefaultTimePointNote(point.type);
  if (!action.type) {
    return "";
  }
  if (action.type === "executeCommand" && !String(action.eventLabel || "").trim()) {
    markInvalidActionInput(point.id, "[data-time-point-action-field='eventLabel']", `${note}的执行指令不能为空。`);
    return `${note}的执行指令不能为空。`;
  }
  if (action.type === "seek" && Math.round(Number(action.durationSeconds) || 0) <= 0) {
    markInvalidActionInput(point.id, "[data-time-point-action-field='durationSeconds']", `${note}的快进/快退时长必须大于 0。`);
    return `${note}的快进/快退时长必须大于 0。`;
  }
  if (action.type === "switchCpl" && Math.round(Number(action.cplIndex) || 0) <= 0) {
    markInvalidActionInput(point.id, "[data-time-point-action-field='cplIndex']", `${note}的 CPL 序号不能为空。`);
    return `${note}的 CPL 序号不能为空。`;
  }
  if (action.type === "httpRequest") {
    if (!String(action.method || "").trim()) {
      markInvalidActionInput(point.id, "[data-configure-http]", `${note}的 HTTP 请求方法不能为空。`);
      return `${note}的 HTTP 请求方法不能为空。`;
    }
    const url = String(action.url || "").trim();
    if (!url) {
      markInvalidActionInput(point.id, "[data-configure-http]", `${note}的 HTTP 请求 URL 不能为空。`);
      return `${note}的 HTTP 请求 URL 不能为空。`;
    }
    if (!isValidHttpUrl(url)) {
      markInvalidActionInput(point.id, "[data-configure-http]", `${note}的 HTTP 请求 URL 格式不正确。`);
      return `${note}的 HTTP 请求 URL 格式不正确。`;
    }
  }
  return "";
}

function isValidHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

async function deleteRule(id) {
  const rule = state.rules.find((item) => item.id === id);
  if (!rule || !confirm(`确定要删除《${rule.filmName}》的放映模板吗？`)) {
    return;
  }
  try {
    await apiDelete(`/api/film-playback/rules/${encodeURIComponent(id)}`);
    await loadRulesData();
    toast.success("放映模板已删除");
  } catch (error) {
    toast.error(error.message || "删除失败");
  }
}

function getSelectedFilm() {
  const filmCd = dom.filmSelect.value;
  if (!filmCd) return null;
  return state.films.find((film) => film.filmCd === filmCd)
    || (state.editingRule?.filmCd === filmCd ? {
      filmCd: state.editingRule.filmCd,
      filmName: state.editingRule.filmName,
      visual: state.editingRule.filmVisual,
      language: state.editingRule.filmLanguage,
      rawFilm: state.editingRule.rawFilm,
    } : null);
}

function getSelectedHallIds() {
  return [...dom.hallList.querySelectorAll("input[type='checkbox']:checked")].map((input) => input.value);
}

function getOccupiedHallIds(filmCd, ignoreRuleId) {
  const occupied = new Set();
  if (!filmCd) return occupied;
  for (const rule of state.ruleOccupancies) {
    if (rule.filmCd !== filmCd || rule.id === ignoreRuleId) continue;
    for (const hallId of rule.hallIds || []) occupied.add(hallId);
  }
  return occupied;
}

function renderTimePoints() {
  if (!dom.timePointList) {
    return;
  }
  if (!state.timePoints.length) {
    dom.timePointList.innerHTML = `<div class="film-playback-muted">暂无时间点信息。</div>`;
    return;
  }
  dom.timePointList.innerHTML = state.timePoints.map((point, index) => renderTimePointRow(point, index)).join("");
}

function renderTimePointRow(point, index) {
  const noteLocked = isFixedTimePoint(point);
  const actionType = point.action?.type || "";
  return `
    <article class="film-playback-time-point-row" data-time-point-id="${escapeAttr(point.id)}">
      <div class="film-playback-time-point-main">
        <label>
          <span>类型</span>
          <select class="select select-bordered select-sm" data-time-point-field="type">
            ${renderTimePointTypeOptions(point)}
          </select>
        </label>
        <label>
          <span>备注</span>
          <input type="text" class="input input-bordered input-sm" data-time-point-field="note" value="${escapeAttr(point.note)}" ${noteLocked ? "disabled" : ""}>
        </label>
        <div class="film-playback-time-point-times">
          <label>
            <span>${point.type === "range" ? "开始时间" : "时间点"}</span>
            <input type="time" step="1" class="input input-bordered input-sm" data-time-point-field="startSeconds" value="${escapeAttr(formatSecondsClock(point.startSeconds))}">
          </label>
        ${point.type === "range" ? `
          <label>
            <span>结束时间</span>
            <input type="time" step="1" class="input input-bordered input-sm" data-time-point-field="endSeconds" value="${escapeAttr(formatSecondsClock(point.endSeconds ?? point.startSeconds + 1))}">
          </label>
        ` : ""}
        </div>
        <button type="button" class="btn btn-ghost btn-sm text-error" data-remove-time-point="${escapeAttr(point.id)}" aria-label="删除时间点信息">
          <i class="fas fa-trash"></i>
        </button>
      </div>
      <div class="film-playback-time-point-action-row">
        <label>
          <span>操作</span>
          <select class="select select-bordered select-sm" data-time-point-field="actionType">
            ${getActionOptionsForPoint(point).map((action) => (
              `<option value="${escapeAttr(action.value)}" ${actionType === action.value ? "selected" : ""}>${escapeHtml(action.label)}</option>`
            )).join("")}
          </select>
        </label>
        ${renderActionFields(point, index)}
      </div>
    </article>
  `;
}

function renderTimePointTypeOptions(point) {
  return TIME_POINT_TYPES.map((type) => {
    const disabled = isUniqueTimePointType(type.value)
      && point.type !== type.value
      && state.timePoints.some((item) => item.type === type.value);
    return `<option value="${escapeAttr(type.value)}" ${point.type === type.value ? "selected" : ""} ${disabled ? "disabled" : ""}>${escapeHtml(type.label)}</option>`;
  }).join("");
}

function getActionOptionsForPoint(point) {
  return point.type === "range" ? [...TIME_POINT_ACTIONS, ...RANGE_ONLY_ACTIONS] : TIME_POINT_ACTIONS;
}

function renderActionFields(point, index) {
  const action = point.action || {};
  if (point.type === "range" && !getActionOptionsForPoint(point).some((option) => option.value === (action.type || ""))) {
    return "";
  }
  const timingField = point.type === "range" && action.type ? renderRangeExecutionTiming(action.executeAt || "start") : "";
  switch (action.type || "") {
    case "executeCommand":
      return `${timingField}${renderAutomationSelect(action.eventLabel || "")}`;
    case "pausePlayback":
      return `${timingField}${renderActionField("暂停时长（单位:秒, 0表示永久暂停）", "durationSeconds", action.durationSeconds ?? 0, "number")}`;
    case "seek":
      return `
        ${timingField}
        <div class="film-playback-action-params">
          <label>
            <span>方向</span>
            <select class="select select-bordered select-sm" data-time-point-action-field="direction">
              <option value="forward" ${action.direction !== "backward" ? "selected" : ""}>快进</option>
              <option value="backward" ${action.direction === "backward" ? "selected" : ""}>快退</option>
            </select>
          </label>
          <label>
            <span>时长（秒）</span>
            <input type="number" min="0" step="1" class="input input-bordered input-sm" data-time-point-action-field="durationSeconds" value="${escapeAttr(action.durationSeconds ?? 0)}">
          </label>
        </div>
      `;
    case "switchCpl":
      return `${timingField}${renderCplSelect(action.cplIndex ?? 1)}`;
    case "httpRequest":
      return `
        ${timingField}
        <div class="film-playback-action-params">
          <label>
            <span>请求参数</span>
            <button type="button" class="btn btn-ghost btn-sm" data-configure-http="${escapeAttr(point.id)}">
              <i class="fas fa-sliders"></i>
              配置请求参数
            </button>
          </label>
          <span class="film-playback-http-summary">${escapeHtml(formatHttpSummary(action))}</span>
        </div>
      `;
    case "skipRange":
      return "";
    default:
      return "";
  }
}

function renderRangeExecutionTiming(value) {
  return `
    <div class="film-playback-action-params">
      <label>
        <span>执行时间</span>
        <select class="select select-bordered select-sm" data-time-point-action-field="executeAt">
          <option value="start" ${value !== "end" ? "selected" : ""}>开始</option>
          <option value="end" ${value === "end" ? "selected" : ""}>结束</option>
        </select>
      </label>
    </div>
  `;
}

function renderActionField(label, field, value, type = "text", options = {}) {
  return `
    <div class="film-playback-action-params">
      <label>
        <span>${escapeHtml(label)}</span>
        <input type="${escapeAttr(type)}" ${options.min !== undefined ? `min="${escapeAttr(options.min)}"` : ""} step="1" class="input input-bordered input-sm" data-time-point-action-field="${escapeAttr(field)}" value="${escapeAttr(value)}">
      </label>
    </div>
  `;
}

function renderAutomationSelect(value) {
  const options = state.commonAutomationLabels.map((label) => (
    `<option value="${escapeAttr(label)}" ${value === label ? "selected" : ""}>${escapeHtml(label)}</option>`
  )).join("");
  const placeholder = state.commonAutomationLabelsLoading ? "正在读取共有 Automation 标签..." : "请选择共有 Automation 标签";
  return `
    <div class="film-playback-action-params">
      <label>
        <span>Automation 标签</span>
        <select class="select select-bordered select-sm" data-time-point-action-field="eventLabel" ${state.commonAutomationLabelsLoading ? "disabled" : ""}>
          <option value="">${escapeHtml(placeholder)}</option>
          ${options}
        </select>
      </label>
    </div>
  `;
}

function renderCplSelect(value) {
  const cpls = getPlaylistCplOptions();
  return `
    <div class="film-playback-action-params">
      <label>
        <span>CPL 序号</span>
        <select class="select select-bordered select-sm" data-time-point-action-field="cplIndex">
          <option value="">${cpls.length ? "请选择 CPL" : "请先选择播放表"}</option>
          ${cpls.map((cpl) => (
            `<option value="${escapeAttr(cpl.index)}" ${Number(value) === cpl.index ? "selected" : ""}>${escapeHtml(cpl.label)}</option>`
          )).join("")}
        </select>
      </label>
    </div>
  `;
}

function getPlaylistCplOptions() {
  const detail = state.selectedPlaylistCheck?.details?.[0];
  if (!detail) {
    return [];
  }
  return (detail.segments || []).map((segment, index) => {
    const cpl = detail.segmentDetails?.[index] || {};
    const title = getCplTitle(cpl) || shortUuid(segment.cplUuid);
    return {
      index: index + 1,
      label: `${index + 1}. ${title}`,
    };
  });
}

function formatHttpSummary(action) {
  const method = action.method || "GET";
  const url = action.url || "未配置 URL";
  return `${method} ${url}`;
}

function openHttpDialog(pointId) {
  const point = state.timePoints.find((item) => item.id === pointId);
  if (!point || point.action?.type !== "httpRequest") {
    return;
  }
  state.editingHttpPointId = pointId;
  const action = point.action || {};
  dom.httpError.classList.add("hidden");
  dom.httpError.textContent = "";
  dom.httpMethod.value = action.method || "GET";
  dom.httpUrl.value = action.url || "";
  dom.httpTimeout.value = String(action.timeoutSeconds ?? 10);
  dom.httpHeaders.value = formatKeyValueLines(action.headers);
  dom.httpQuery.value = formatKeyValueLines(action.query);
  dom.httpBody.value = action.body || "";
  dom.httpDialog.showModal();
}

function closeHttpDialog() {
  state.editingHttpPointId = "";
  dom.httpDialog.close();
}

function saveHttpConfig(event) {
  event.preventDefault();
  const index = state.timePoints.findIndex((point) => point.id === state.editingHttpPointId);
  if (index < 0) {
    closeHttpDialog();
    return;
  }
  try {
    const url = dom.httpUrl.value.trim();
    if (!url) {
      throw new Error("请填写 HTTP 请求 URL。");
    }
    if (!isValidHttpUrl(url)) {
      throw new Error("HTTP 请求 URL 格式不正确。");
    }
    const timeoutSeconds = Math.max(1, Math.round(Number(dom.httpTimeout.value) || 10));
    state.timePoints[index] = {
      ...state.timePoints[index],
      action: {
        type: "httpRequest",
        method: dom.httpMethod.value || "GET",
        url,
        timeoutSeconds,
        headers: parseKeyValueLines(dom.httpHeaders.value, "请求头"),
        query: parseKeyValueLines(dom.httpQuery.value, "Query 参数"),
        body: dom.httpBody.value,
      },
    };
    state.timeEditTouched = true;
    closeHttpDialog();
    renderTimePoints();
    renderPlaylistCheck();
  } catch (error) {
    dom.httpError.textContent = error.message || "HTTP 请求配置不正确。";
    dom.httpError.classList.remove("hidden");
  }
}

function parseKeyValueLines(value, label) {
  const result = {};
  String(value || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean).forEach((line) => {
    const separatorIndex = line.includes(":") ? line.indexOf(":") : line.indexOf("=");
    if (separatorIndex <= 0) {
      throw new Error(`${label}格式应为 key: value 或 key=value。`);
    }
    const key = line.slice(0, separatorIndex).trim();
    const itemValue = line.slice(separatorIndex + 1).trim();
    if (!key) {
      throw new Error(`${label}包含空键名。`);
    }
    result[key] = itemValue;
  });
  return result;
}

function formatKeyValueLines(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return "";
  }
  return Object.entries(value).map(([key, itemValue]) => `${key}: ${itemValue}`).join("\n");
}

function handleTimePointEdit(event) {
  const target = event.target.closest("[data-time-point-field], [data-time-point-action-field]");
  if (!target) {
    return;
  }
  const row = target.closest("[data-time-point-id]");
  const id = row?.dataset.timePointId;
  const index = state.timePoints.findIndex((item) => item.id === id);
  if (index < 0) {
    return;
  }

  const current = state.timePoints[index];
  let next = { ...current, action: current.action ? { ...current.action } : undefined };
  const field = target.dataset.timePointField;
  const actionField = target.dataset.timePointActionField;
  if (field) {
    next = applyTimePointField(next, field, target.value);
  }
  if (actionField) {
    next.action = applyActionField(next.action || { type: "" }, actionField, target.value);
  }
  state.timePoints[index] = next;
  state.timeEditTouched = true;

  if (field === "type" || field === "actionType") {
    renderTimePoints();
  }
  if (field === "actionType" && target.value === "executeCommand") {
    void loadCommonAutomationLabelsForSelectedHalls();
  }
  renderPlaylistCheck();
}

function applyTimePointField(point, field, value) {
  if (field === "type") {
    const type = TIME_POINT_TYPES.some((item) => item.value === value) ? value : "point";
    const next = {
      ...point,
      type,
      note: getDefaultTimePointNote(type, "", point.id),
    };
    if (type !== "range" && next.action?.type === "skipRange") {
      next.action = undefined;
    }
    if (type === "range" && next.action?.type && !next.action.executeAt) {
      next.action = { ...next.action, executeAt: "start" };
    }
    if (type !== "range") {
      delete next.endSeconds;
    } else if (!Number.isFinite(next.endSeconds)) {
      next.endSeconds = next.startSeconds + 1;
    }
    return next;
  }
  if (field === "note") {
    return { ...point, note: isFixedTimePoint(point) ? getDefaultTimePointNote(point.type) : value };
  }
  if (field === "startSeconds") {
    return { ...point, startSeconds: parseClockSeconds(value) };
  }
  if (field === "endSeconds") {
    return { ...point, endSeconds: parseClockSeconds(value) };
  }
  if (field === "actionType") {
    return { ...point, action: createTimePointAction(value, point.type) };
  }
  return point;
}

function applyActionField(action, field, value) {
  if (field === "durationSeconds" || field === "cplIndex") {
    return { ...action, [field]: Math.max(0, Math.round(Number(value) || 0)) };
  }
  return { ...action, [field]: value };
}

async function loadCommonAutomationLabelsForSelectedHalls() {
  const hallIds = getSelectedHallIds().filter((hallId) => isHallOnline(hallId));
  if (hallIds.length === 0) {
    state.commonAutomationLabels = [];
    state.commonAutomationLabelsLoading = false;
    renderTimePoints();
    return;
  }

  state.commonAutomationLabelsLoading = true;
  renderTimePoints();
  try {
    const labelLists = await Promise.all(hallIds.map((hallId) => loadAutomationLabelsForHall(hallId)));
    const [first = []] = labelLists;
    state.commonAutomationLabels = first
      .filter((label) => labelLists.every((labels) => labels.includes(label)))
      .sort((left, right) => left.localeCompare(right));
  } catch {
    state.commonAutomationLabels = [];
  } finally {
    state.commonAutomationLabelsLoading = false;
    renderTimePoints();
  }
}

async function loadAutomationLabelsForHall(hallId) {
  if (state.automationLabelsByHallId.has(hallId)) {
    return state.automationLabelsByHallId.get(hallId);
  }
  const payload = await apiPost(`/api/runtime/halls/${encodeURIComponent(hallId)}/automations`, { force: true });
  const labels = Array.isArray(payload.automationLabels)
    ? payload.automationLabels.filter((label) => typeof label === "string" && label.trim()).map((label) => label.trim())
    : [];
  state.automationLabelsByHallId.set(hallId, labels);
  return labels;
}

function setTimeInput(input, seconds) {
  input.value = formatSecondsClock(seconds);
}

function readTimeInput(input) {
  const value = String(input.value || "").trim();
  const match = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(value);
  if (!match) {
    throw new Error("时间格式应为 HH:MM:SS。");
  }
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3] || 0);
  if (minutes > 59 || seconds > 59) {
    throw new Error("分钟和秒必须小于 60。");
  }
  return (hours * 3600) + (minutes * 60) + seconds;
}

function readTimeInputSafe(input) {
  try {
    return input ? readTimeInput(input) : Number.NaN;
  } catch {
    return Number.NaN;
  }
}

function parseClockSeconds(value) {
  const match = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(String(value || "").trim());
  if (!match) {
    return Number.NaN;
  }
  return (Number(match[1]) * 3600) + (Number(match[2]) * 60) + Number(match[3] || 0);
}

function resetFilters() {
  state.filters.search = "";
  state.filters.hallId = "";
  state.filters.filmCd = "";
  state.page = 1;
  dom.searchInput.value = "";
  dom.hallFilter.value = "";
  dom.filmFilter.value = "";
  void loadRulesData();
}

function setBusy(busy) {
  state.busy = busy;
  dom.refreshBtn.disabled = busy;
  dom.addBtn.disabled = busy;
  syncSaveButtonState();
}

function syncSaveButtonState() {
  if (dom.saveBtn) {
    dom.saveBtn.disabled = state.saving || Boolean(state.timeEditError);
  }
}

function renderPageError(message) {
  const span = dom.error?.querySelector("span");
  if (!dom.error || !span) return;
  if (!message) {
    dom.error.classList.add("hidden");
    span.textContent = "";
    return;
  }
  span.textContent = message;
  dom.error.classList.remove("hidden");
}

function getHallName(hallId) {
  return state.halls.find((hall) => hall.id === hallId)?.name || hallId;
}

function isHallOnline(hallId) {
  return state.halls.find((hall) => hall.id === hallId)?.online === true;
}

function getRulePlaylistKey(rule) {
  return rule.playlistRefs?.length === 1 ? rule.playlistRefs[0].playlistId : `title:${normalizePlaylistName(rule.playlistName)}`;
}

function resolveRulePlaylistChoiceKey(rule, choices, selectedHallIds) {
  const savedKey = getRulePlaylistKey(rule);
  if (choices.some((choice) => choice.key === savedKey)) {
    return savedKey;
  }

  if ((selectedHallIds || []).length <= 1) {
    return "";
  }

  const savedName = normalizePlaylistName(rule.playlistName);
  return choices.find((choice) => normalizePlaylistName(choice.name) === savedName)?.key || "";
}

function normalizePlaylistName(value) {
  return String(value || "").trim().toLowerCase();
}

function getCommonPlaylistNameKey(names) {
  const keys = names.map(normalizePlaylistName).filter(Boolean);
  if (keys.length === 0) {
    return "";
  }
  return keys.every((key) => key === keys[0]) ? keys[0] : "";
}

function formatFilmLabel(film) {
  return [film.filmName, film.visual || film.filmVisual, film.language || film.filmLanguage].filter(Boolean).join(" · ") || film.filmCd;
}

function formatFilmOptionText(film) {
  const name = film.filmName || film.filmCd || "";
  const code = film.filmCd ? ` (${film.filmCd})` : "";
  return `${name}${code}`;
}

function normalizeRuleTimePoints(rule) {
  if (!rule) {
    return [];
  }
  return Array.isArray(rule.timePoints)
    ? rule.timePoints.map((point) => createTimePoint(point.type, {
      id: point.id,
      note: point.note,
      startSeconds: Math.max(0, Math.round(Number(point.startSeconds) || 0)),
      endSeconds: point.type === "range" ? Math.max(0, Math.round(Number(point.endSeconds) || 0)) : undefined,
      action: point.action,
    }))
    : [];
}

function createTimePoint(type = "point", overrides = {}) {
  const normalizedType = TIME_POINT_TYPES.some((item) => item.value === type) ? type : "point";
  const hasStart = Object.prototype.hasOwnProperty.call(overrides, "startSeconds");
  const startSeconds = hasStart
    ? (Number.isFinite(overrides.startSeconds) ? Math.max(0, Math.round(overrides.startSeconds)) : Number.NaN)
    : 0;
  const point = {
    id: overrides.id || createLocalId(),
    type: normalizedType,
    note: getDefaultTimePointNote(normalizedType, overrides.note, overrides.id),
    startSeconds,
    action: normalizeTimePointAction(overrides.action, normalizedType),
  };
  if (normalizedType === "range") {
    const hasEnd = Object.prototype.hasOwnProperty.call(overrides, "endSeconds");
    point.endSeconds = hasEnd
      ? (Number.isFinite(overrides.endSeconds) ? Math.max(0, Math.round(overrides.endSeconds)) : Number.NaN)
      : startSeconds + 1;
  }
  return point;
}

function createLocalId() {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }
  return `time-point-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function getDefaultTimePointNote(type, current = "", excludeId = "") {
  if (type === "head") return "正片出现时间";
  if (type === "tail") return "片尾字幕出现时间";
  return String(current || "").trim() || getNextTimePointNote(type, excludeId);
}

function getNextTimePointNote(type, excludeId = "") {
  const prefix = type === "range" ? "时间段" : "时间点";
  const maxNumber = state.timePoints
    .filter((point) => point.type === type && point.id !== excludeId)
    .map((point) => {
      const match = new RegExp(`^${prefix}(\\d+)$`).exec(String(point.note || ""));
      return match ? Number(match[1]) : 0;
    })
    .reduce((max, value) => Math.max(max, value), 0);
  return `${prefix}${maxNumber + 1}`;
}

function isFixedTimePoint(point) {
  return point?.type === "head" || point?.type === "tail";
}

function isUniqueTimePointType(type) {
  return type === "head" || type === "tail";
}

function createTimePointAction(type, pointType = "point") {
  const rangeDefaults = pointType === "range" && type ? { executeAt: "start" } : {};
  switch (type) {
    case "executeCommand":
      return { type, ...rangeDefaults, eventLabel: "" };
    case "pausePlayback":
      return { type, ...rangeDefaults, durationSeconds: 0 };
    case "stopPlayback":
      return { type, ...rangeDefaults };
    case "seek":
      return { type, ...rangeDefaults, direction: "forward", durationSeconds: 0 };
    case "switchCpl":
      return { type, ...rangeDefaults, cplIndex: 1 };
    case "httpRequest":
      return { type, ...rangeDefaults, method: "GET", url: "", timeoutSeconds: 10, headers: {}, query: {}, body: "" };
    case "skipRange":
      return pointType === "range" ? { type } : undefined;
    default:
      return undefined;
  }
}

function normalizeTimePointAction(action, pointType = "point") {
  if (!action || typeof action !== "object") {
    return undefined;
  }
  const base = createTimePointAction(action.type, pointType);
  return base ? { ...base, ...action } : undefined;
}

function readTimePointsFromEditor(options = {}) {
  return state.timePoints.map((point) => {
    const normalized = createTimePoint(point.type, point);
    normalized.note = getDefaultTimePointNote(normalized.type, point.note);
    normalized.action = normalizeTimePointActionForSave(normalized.action, normalized.type);
    if (!options.allowPartial) {
      if (!Number.isFinite(normalized.startSeconds)) {
        throw new Error("时间点格式应为 HH:MM:SS。");
      }
      if (normalized.type === "range" && !Number.isFinite(normalized.endSeconds)) {
        throw new Error("时间段结束时间格式应为 HH:MM:SS。");
      }
    }
    return normalized;
  });
}

function normalizeTimePointActionForSave(action, pointType) {
  if (!action?.type) {
    return undefined;
  }
  if (action.type === "skipRange" && pointType !== "range") {
    return undefined;
  }
  if (pointType !== "range") {
    const { executeAt: _executeAt, ...rest } = action;
    return rest;
  }
  if (action.type === "skipRange") {
    return { type: "skipRange" };
  }
  return {
    ...action,
    executeAt: action.executeAt === "end" ? "end" : "start",
  };
}

function getFixedTimePointSeconds(points, type) {
  const point = points.find((item) => item.type === type);
  return point ? Math.max(0, Math.round(Number(point.startSeconds) || 0)) : 0;
}

function getTimelinePointLabel(point) {
  if (point.type === "head") return "正片出现";
  if (point.type === "tail") return "片尾字幕";
  return point.note || "时间点";
}

function getPlaylistDurationSeconds(detail) {
  return detail.segments.reduce((sum, _segment, index) => sum + getSegmentDurationSeconds(detail, index), 0);
}

function getSegmentDurationSeconds(detail, index) {
  const cpl = detail.segmentDetails[index] || {};
  return Number.isFinite(cpl.durationSeconds) ? cpl.durationSeconds : 0;
}

function getSegmentFps(cpl) {
  return parseEditRateFps(cpl?.editRate) || DEFAULT_FPS;
}

function getCommandOffsetSeconds(command, cpl) {
  const fps = parseEditRateFps(command?.editRate) || getSegmentFps(cpl);
  return Math.round((Number(command?.offsetFrames) || 0) / fps);
}

function getCplTitle(cpl) {
  return cpl?.contentTitleText || cpl?.annotationText || cpl?.cplUuid || "";
}

function clusterCommands(commands, durationSeconds, cpl) {
  const positioned = commands
    .map((command) => {
      const offsetSeconds = getCommandOffsetSeconds(command, cpl);
      const percent = durationSeconds > 0 ? Math.min(Math.max((offsetSeconds / durationSeconds) * 100, 0), 100) : 0;
      return { command, offsetSeconds, percent };
    })
    .sort((left, right) => left.percent - right.percent);

  const clusters = [];
  for (const item of positioned) {
    const last = clusters[clusters.length - 1];
    if (!last || Math.abs(item.percent - last.percent) > MARKER_CLUSTER_THRESHOLD_PERCENT) {
      clusters.push({ percent: item.percent, items: [item] });
      continue;
    }
    last.items.push(item);
    last.percent = last.items.reduce((sum, entry) => sum + entry.percent, 0) / last.items.length;
  }
  return clusters;
}

function parseEditRateFps(editRate) {
  const parts = String(editRate || "").trim().split(/\s+/).map((part) => Number(part));
  if (!Number.isFinite(parts[0]) || parts[0] <= 0) {
    return undefined;
  }
  const denominator = Number.isFinite(parts[1]) && parts[1] > 0 ? parts[1] : 1;
  return parts[0] / denominator;
}

function normalizeUuid(value) {
  return String(value || "").trim().toLowerCase();
}

function shortUuid(value) {
  const text = String(value || "");
  return text.replace(/^urn:uuid:/i, "").slice(0, 8) || "-";
}

function formatSecondsClock(value) {
  const totalSeconds = Math.max(0, Math.round(Number(value) || 0));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${pad2(hours)}:${pad2(minutes)}:${pad2(seconds)}`;
}

function formatTimelineDuration(value) {
  const clock = formatSecondsClock(value);
  return clock.startsWith("00:") ? clock.slice(3) : clock;
}

function formatTimeRange(startSeconds, endSeconds) {
  return `${formatSecondsClock(startSeconds)} / ${formatSecondsClock(endSeconds)}`;
}

function formatDate(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "--";
  return date.toLocaleString("zh-CN", { hour12: false });
}

function pad2(value) {
  return String(value).padStart(2, "0");
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
