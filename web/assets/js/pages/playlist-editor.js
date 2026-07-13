import { apiPost, getRuntimeHalls } from "../api.js";
import { getHallNotFoundMessage, getHallOfflineMessage, getHallStatusErrorMessage, renderStatusAlert } from "../hall-status-alert.js";
import { toast } from "../toast.js";
import { invalidateFilmPlaybackPlaylistCache } from "./film-playback.js";

const DEFAULT_EDIT_RATE = "24 1";
const DEFAULT_FPS = 24;
const SHOW_TITLE_PATTERN = /^[A-Za-z0-9 ,./\-_@#%]+$/;
const CHINESE_TEXT_PATTERN = /[\u3400-\u9fff\uf900-\ufaff]/u;
const TIMELINE_PIXELS_PER_SECOND = 0.08;
const MIN_SEGMENT_WIDTH = 118;
const MAX_SEGMENT_WIDTH = 620;
const MARKER_CLUSTER_THRESHOLD_PERCENT = 4;
const TIMELINE_SEGMENT_DRAG_TYPE = "timeline-segment";

const playlistState = {
  halls: [],
  hallId: "",
  shows: [],
  cpls: [],
  commands: [],
  editor: createEmptyEditor(),
  selectedSegmentIndex: -1,
  busy: false,
  commandEditModes: {},
  copyWizard: createCopyWizardState(),
  drag: {
    type: "",
    sourceSegmentIndex: -1,
  },
};

const playlistDom = {
  hallName: null,
  showSelect: null,
  refreshButton: null,
  newButton: null,
  copyButton: null,
  copyToHallButton: null,
  deleteButton: null,
  saveButton: null,
  validateButton: null,
  error: null,
  cplList: null,
  commandList: null,
  timeline: null,
  timelineSummary: null,
  titleInput: null,
  issuerInput: null,
  creatorInput: null,
  playCountInput: null,
  cplInfo: null,
  selectedCplIndex: null,
  copyWizardDialog: null,
  copyWizardBody: null,
  copyWizardSubtitle: null,
  copyWizardBack: null,
  copyWizardNext: null,
  copyWizardImport: null,
  counts: {},
};

export async function initPlaylistEditorPage() {
  cachePlaylistDom();
  bindPlaylistEvents();
  resetPlaylistEditor();
  await loadPlaylistHalls();
  await loadPlaylistData(true);
  const defaultShowUuid = getDefaultPlaylistShowUuid();
  if (defaultShowUuid) {
    await openPlaylistShow(defaultShowUuid);
  } else {
    renderPlaylistPage();
  }
}

export function disposePlaylistEditorPage() {}

function cachePlaylistDom() {
  playlistDom.hallName = document.getElementById("playlistHallName");
  playlistDom.showSelect = document.getElementById("playlistShowSelect");
  playlistDom.refreshButton = document.getElementById("playlistRefreshButton");
  playlistDom.newButton = document.getElementById("playlistNewButton");
  playlistDom.copyButton = document.getElementById("playlistCopyButton");
  playlistDom.copyToHallButton = document.getElementById("playlistCopyToHallButton");
  playlistDom.deleteButton = document.getElementById("playlistDeleteButton");
  playlistDom.saveButton = document.getElementById("playlistSaveButton");
  playlistDom.validateButton = document.getElementById("playlistValidateButton");
  playlistDom.error = document.getElementById("playlistError");
  playlistDom.cplList = document.getElementById("playlistCplList");
  playlistDom.commandList = document.getElementById("playlistCommandList");
  playlistDom.timeline = document.getElementById("playlistTimeline");
  playlistDom.timelineSummary = document.getElementById("playlistTimelineSummary");
  playlistDom.titleInput = document.getElementById("playlistTitleInput");
  playlistDom.issuerInput = document.getElementById("playlistIssuerInput");
  playlistDom.creatorInput = document.getElementById("playlistCreatorInput");
  playlistDom.playCountInput = document.getElementById("playlistPlayCountInput");
  playlistDom.cplInfo = document.getElementById("playlistCplInfo");
  playlistDom.selectedCplIndex = document.getElementById("playlistSelectedCplIndex");
  playlistDom.copyWizardDialog = document.getElementById("playlistCopyWizardDialog");
  playlistDom.copyWizardBody = document.getElementById("playlistCopyWizardBody");
  playlistDom.copyWizardSubtitle = document.getElementById("playlistCopyWizardSubtitle");
  playlistDom.copyWizardBack = document.getElementById("playlistCopyWizardBack");
  playlistDom.copyWizardNext = document.getElementById("playlistCopyWizardNext");
  playlistDom.copyWizardImport = document.getElementById("playlistCopyWizardImport");
  playlistDom.counts = {
    cpls: document.getElementById("playlistCplCount"),
    commands: document.getElementById("playlistCommandCount"),
  };
}

function bindPlaylistEvents() {
  const root = document.querySelector(".playlist-page-shell");
  if (!root || root.dataset.bound === "true") {
    return;
  }
  root.dataset.bound = "true";

  playlistDom.showSelect?.addEventListener("change", async () => {
    const showUuid = playlistDom.showSelect.value;
    if (showUuid) {
      await openPlaylistShow(showUuid);
    } else {
      playlistState.editor = createEmptyEditor();
      playlistState.selectedSegmentIndex = -1;
      renderPlaylistPage();
    }
  });

  playlistDom.refreshButton?.addEventListener("click", async () => {
    await loadPlaylistData(true);
    await reloadCurrentPlaylistShow();
    toast.info("已刷新设备数据。");
  });

  playlistDom.newButton?.addEventListener("click", () => {
    resetPlaylistEditor();
    renderPlaylistPage();
  });

  playlistDom.copyButton?.addEventListener("click", () => {
    copyCurrentPlaylist();
  });
  playlistDom.copyToHallButton?.addEventListener("click", () => {
    openCopyWizard();
  });
  playlistDom.deleteButton?.addEventListener("click", () => {
    void deleteCurrentPlaylist();
  });
  playlistDom.saveButton?.addEventListener("click", saveCurrentPlaylist);
  playlistDom.validateButton?.addEventListener("click", validateCurrentPlaylist);
  playlistDom.copyWizardBack?.addEventListener("click", () => {
    if (playlistState.copyWizard.step > 1) {
      playlistState.copyWizard.step -= 1;
      renderCopyWizard();
    }
  });
  playlistDom.copyWizardNext?.addEventListener("click", () => {
    void advanceCopyWizard();
  });
  playlistDom.copyWizardImport?.addEventListener("click", () => {
    void importCopyWizardShow();
  });
  playlistDom.copyWizardDialog?.querySelector("[data-copy-wizard-close]")?.addEventListener("click", () => {
    closeCopyWizard();
  });

  playlistDom.titleInput?.addEventListener("input", () => {
    updateEditorFromInputs();
    syncInputValidity();
  });

  root.addEventListener("click", (event) => {
    const target = event.target.closest("[data-select-segment], [data-remove-segment], [data-remove-command], [data-move-segment], [data-command-shortcut], [data-command-mode]");
    if (!target) {
      return;
    }

    if (target.dataset.selectSegment !== undefined) {
      playlistState.selectedSegmentIndex = Number(target.dataset.selectSegment);
      renderTimeline();
      renderCplInfo();
      return;
    }

    if (target.dataset.removeSegment !== undefined) {
      playlistState.editor.segments.splice(Number(target.dataset.removeSegment), 1);
      clampSelectedSegment();
      renderPlaylistPage();
      return;
    }

    if (target.dataset.moveSegment) {
      moveSegment(Number(target.dataset.segmentIndex), target.dataset.moveSegment);
      renderPlaylistPage();
      return;
    }

    if (target.dataset.removeCommand) {
      removeCommand(Number(target.dataset.segmentIndex), Number(target.dataset.commandIndex));
      renderPlaylistPage();
      return;
    }

    if (target.dataset.commandMode) {
      setCommandEditMode(Number(target.dataset.segmentIndex), Number(target.dataset.commandIndex), target.dataset.commandMode);
      renderCplInfo();
      return;
    }

    if (target.dataset.commandShortcut) {
      applyCommandShortcut(
        Number(target.dataset.segmentIndex),
        Number(target.dataset.commandIndex),
        target.dataset.commandShortcut,
      );
    }
  });

  root.addEventListener("input", (event) => {
    const input = event.target.closest("[data-command-frames], [data-command-timecode-part]");
    if (!input) {
      return;
    }
    const segmentIndex = Number(input.dataset.segmentIndex);
    const commandIndex = Number(input.dataset.commandIndex);
    const command = readCommandTarget(segmentIndex, commandIndex);
    if (!command) {
      return;
    }
    const row = input.closest(".playlist-command-row");
    const fps = getSegmentFps(segmentIndex);
    const frames = input.dataset.commandFrames !== undefined
      ? setCommandOffsetFrames(command, Number(input.value || 0), segmentIndex)
      : setCommandOffsetFrames(command, readTimecodePartsFrames(row, fps), segmentIndex);
    syncCommandRowInputs(row, frames, fps);
    renderTimeline();
  });

  root.addEventListener("change", (event) => {
    const sourceSelect = event.target.closest("[data-copy-source-show]");
    if (sourceSelect) {
      playlistState.copyWizard.sourceShowUuid = sourceSelect.value;
      playlistState.copyWizard.check = null;
      renderCopyWizard();
      return;
    }

    const targetSelect = event.target.closest("[data-copy-target-hall]");
    if (targetSelect) {
      playlistState.copyWizard.targetHallId = targetSelect.value;
      playlistState.copyWizard.check = null;
      renderCopyWizard();
    }
  });

  root.addEventListener("dragstart", (event) => {
    const card = event.target.closest("[data-drag-type]");
    if (!card) {
      return;
    }
    const isTimelineSegment = card.dataset.dragType === TIMELINE_SEGMENT_DRAG_TYPE;
    playlistState.drag = {
      type: card.dataset.dragType || "",
      sourceSegmentIndex: isTimelineSegment ? Number(card.dataset.segmentIndex) : -1,
    };
    event.dataTransfer.effectAllowed = isTimelineSegment ? "move" : "copy";
    event.dataTransfer.setData("application/json", JSON.stringify(card.dataset));
    card.classList.add("is-dragging");
  });

  root.addEventListener("dragover", (event) => {
    const dropTarget = event.target.closest("[data-drop-zone]");
    if (!dropTarget) {
      return;
    }

    if (playlistState.drag.type === TIMELINE_SEGMENT_DRAG_TYPE || playlistState.drag.type === "cpl") {
      const segmentTarget = event.target.closest(".playlist-cpl-segment");
      if (segmentTarget) {
        event.preventDefault();
        event.dataTransfer.dropEffect = playlistState.drag.type === TIMELINE_SEGMENT_DRAG_TYPE ? "move" : "copy";
        clearTimelineDropState();
        segmentTarget.classList.add(getSegmentDropPlacement(segmentTarget, event.clientX) === "after" ? "is-drop-after" : "is-drop-before");
        return;
      }

      if (dropTarget.dataset.dropZone === "timeline") {
        event.preventDefault();
        event.dataTransfer.dropEffect = playlistState.drag.type === TIMELINE_SEGMENT_DRAG_TYPE ? "move" : "copy";
        clearTimelineDropState();
        dropTarget.classList.add("playlist-drop-active");
      }
      return;
    }

    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    dropTarget.classList.add("playlist-drop-active");
  });

  root.addEventListener("dragleave", (event) => {
    const dropTarget = event.target.closest("[data-drop-zone]");
    if (dropTarget) {
      dropTarget.classList.remove("playlist-drop-active");
    }
  });

  root.addEventListener("drop", (event) => {
    const dropTarget = event.target.closest("[data-drop-zone]");
    if (!dropTarget) {
      return;
    }
    event.preventDefault();
    dropTarget.classList.remove("playlist-drop-active");
    handleDrop(dropTarget, event.dataTransfer.getData("application/json"), event);
    clearTimelineDropState();
    resetPlaylistDragState();
  });

  root.addEventListener("dragend", (event) => {
    event.target.closest("[data-drag-type]")?.classList.remove("is-dragging");
    clearTimelineDropState();
    resetPlaylistDragState();
  });
}

async function loadPlaylistHalls() {
  playlistState.halls = await getRuntimeHalls(true).catch(() => []);
  const routeHallId = decodeURIComponent(window.location.hash.split("/")[2] || "");
  const fallback = playlistState.halls.find((hall) => hall.snapshot?.connectivity?.state === "online")
    || playlistState.halls[0];
  playlistState.hallId = routeHallId || fallback?.registration?.hallId || "";
}

async function loadPlaylistData(force = false) {
  if (!playlistState.hallId) {
    playlistState.shows = [];
    playlistState.cpls = [];
    playlistState.commands = [];
    resetPlaylistEditor();
    return;
  }

  if (isSelectedPlaylistHallOffline()) {
    playlistState.shows = [];
    playlistState.cpls = [];
    playlistState.commands = [];
    resetPlaylistEditor();
    renderError(getHallOfflineMessage("playlist"), "warning");
    renderPlaylistPage();
    return;
  }

  if (isSelectedPlaylistHallMissing()) {
    playlistState.shows = [];
    playlistState.cpls = [];
    playlistState.commands = [];
    resetPlaylistEditor();
    renderError(getHallNotFoundMessage());
    renderPlaylistPage();
    return;
  }

  setBusy(true);
  clearError();
  try {
    const hallId = encodeURIComponent(playlistState.hallId);
    const [shows, cpls, automations] = await Promise.all([
      apiPost(`/api/runtime/halls/${hallId}/shows`, {}),
      apiPost(`/api/runtime/halls/${hallId}/cpls`, {}),
      apiPost(`/api/runtime/halls/${hallId}/automations`, { force }),
    ]);
    playlistState.shows = Array.isArray(shows.shows) ? shows.shows : [];
    playlistState.cpls = Array.isArray(cpls.cpls) ? cpls.cpls : [];
    playlistState.commands = Array.isArray(automations.automationLabels) ? automations.automationLabels : [];
  } catch (error) {
    playlistState.shows = [];
    playlistState.cpls = [];
    playlistState.commands = [];
    resetPlaylistEditor();
    renderError(getHallStatusErrorMessage(error, "读取播放表数据失败。"));
  } finally {
    setBusy(false);
  }
}

async function reloadCurrentPlaylistShow() {
  const showUuid = playlistState.editor.showUuid || playlistDom.showSelect?.value || "";
  if (showUuid && playlistState.shows.some((show) => show.showUuid === showUuid)) {
    await openPlaylistShow(showUuid);
    return;
  }

  const defaultShowUuid = getDefaultPlaylistShowUuid();
  if (defaultShowUuid) {
    await openPlaylistShow(defaultShowUuid);
    return;
  }

  resetPlaylistEditor();
  renderPlaylistPage();
}

function renderPlaylistPage() {
  renderHallName();
  renderShowSelect();
  renderAssets();
  syncEditorInputs();
  renderTimeline();
  renderCplInfo();
  syncButtons();
}

function renderHallName() {
  const hall = getSelectedPlaylistHall();
  setText(playlistDom.hallName, hall?.registration?.hallName || playlistState.hallId || "未选择影厅");
}

function getDefaultPlaylistShowUuid() {
  if (playlistState.shows.length === 0) {
    return "";
  }

  const loadedShowUuid = getCurrentLoadedShowUuid();
  if (loadedShowUuid && playlistState.shows.some((show) => show.showUuid === loadedShowUuid)) {
    return loadedShowUuid;
  }

  return playlistState.shows[0]?.showUuid || "";
}

function getCurrentLoadedShowUuid() {
  const hall = getSelectedPlaylistHall();
  const showUuid = String(hall?.snapshot?.playback?.status?.showUuid || "").trim();
  if (!showUuid || /^urn:uuid:0{8}-0{4}-0{4}-0{4}-0{12}$/i.test(showUuid)) {
    return "";
  }
  return showUuid;
}

function renderShowSelect() {
  if (!playlistDom.showSelect) {
    return;
  }

  playlistDom.showSelect.replaceChildren();
  playlistDom.showSelect.appendChild(createOption("", "请选择放映表"));
  for (const show of playlistState.shows) {
    const option = createOption(show.showUuid, show.title || "UNTITLED");
    option.selected = show.showUuid === playlistState.editor.showUuid;
    playlistDom.showSelect.appendChild(option);
  }
}

function renderAssets() {
  renderCplAssets();
  renderCommandAssets();
  setText(playlistDom.counts.cpls, String(playlistState.cpls.length));
  setText(playlistDom.counts.commands, String(playlistState.commands.length));
}

function renderCplAssets() {
  playlistDom.cplList.replaceChildren();
  if (playlistState.cpls.length === 0) {
    playlistDom.cplList.appendChild(createEmpty("当前影厅没有可拖入的 CPL。"));
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const cpl of playlistState.cpls) {
    const meta = [formatSeconds(cpl.durationSeconds), cpl.contentKind || "CPL"];
    const aspectLabel = getCplAspectRatioLabel(cpl);
    if (aspectLabel) {
      meta.push(`画幅 ${aspectLabel}`);
    }
    const node = document.createElement("div");
    node.className = "playlist-asset-card";
    node.draggable = true;
    node.dataset.dragType = "cpl";
    node.dataset.cplUuid = cpl.cplUuid || "";
    node.innerHTML = `
      ${renderCplTitleLine(cpl, getCplTitle(cpl), "playlist-asset-title", true)}
      <div class="playlist-asset-meta">${escapeHtml(meta.join(" · "))}</div>
    `;
    fragment.appendChild(node);
  }
  playlistDom.cplList.appendChild(fragment);
}

function renderCommandAssets() {
  playlistDom.commandList.replaceChildren();
  if (playlistState.commands.length === 0) {
    playlistDom.commandList.appendChild(createEmpty("当前影厅没有可用自动化命令。"));
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const command of playlistState.commands) {
    const node = document.createElement("div");
    node.className = "playlist-asset-card playlist-command-card";
    node.draggable = true;
    node.dataset.dragType = "command";
    node.dataset.commandLabel = command;
    node.innerHTML = `
      <strong class="playlist-asset-title">${escapeHtml(command)}</strong>
      <div class="playlist-asset-meta">PlaylistMarker</div>
    `;
    fragment.appendChild(node);
  }
  playlistDom.commandList.appendChild(fragment);
}

function renderTimeline() {
  playlistDom.timeline.replaceChildren();
  const totalDuration = getEditorDurationSeconds();
  setText(playlistDom.timelineSummary, `${playlistState.editor.segments.length} CPL · ${formatSeconds(totalDuration)}`);

  if (playlistState.editor.segments.length === 0) {
    playlistDom.timeline.appendChild(createEmpty("将左侧 CPL 拖到这里开始编排。", "playlist-empty playlist-timeline-empty"));
    return;
  }

  const fragment = document.createDocumentFragment();
  playlistState.editor.segments.forEach((segment, index) => {
    fragment.appendChild(createSegmentNode(segment, index));
  });
  playlistDom.timeline.appendChild(fragment);
}

function createSegmentNode(segment, index) {
  const cpl = getCplByUuid(segment.cplUuid);
  const duration = getCplDurationSeconds(segment.cplUuid);
  const width = Math.min(Math.max(duration * TIMELINE_PIXELS_PER_SECOND, MIN_SEGMENT_WIDTH), MAX_SEGMENT_WIDTH);
  const node = document.createElement("article");
  node.className = `playlist-cpl-segment${index === playlistState.selectedSegmentIndex ? " is-selected" : ""}`;
  node.draggable = true;
  node.dataset.dragType = TIMELINE_SEGMENT_DRAG_TYPE;
  node.dataset.dropZone = "segment-command";
  node.dataset.segmentIndex = String(index);
  node.style.setProperty("--segment-width", `${Math.round(width)}px`);
  node.innerHTML = `
    <button type="button" class="playlist-segment-main" data-select-segment="${index}">
      ${renderCplTitleLine(cpl, getCplTitle(cpl) || shortUuid(segment.cplUuid), "playlist-segment-title")}
      <span class="playlist-segment-time">${escapeHtml(formatTimelineDuration(duration))}</span>
    </button>
    <div class="playlist-segment-markers"></div>
    <div class="playlist-segment-actions" aria-label="CPL 操作">
      <button type="button" data-move-segment="left" data-segment-index="${index}" title="左移"><i class="fas fa-arrow-left"></i></button>
      <button type="button" data-move-segment="right" data-segment-index="${index}" title="右移"><i class="fas fa-arrow-right"></i></button>
      <button type="button" data-remove-segment="${index}" title="移除 CPL"><i class="fas fa-trash"></i></button>
    </div>
  `;

  const markers = node.querySelector(".playlist-segment-markers");
  if (segment.commands?.length) {
    clusterCommands(segment.commands, duration, getSegmentFps(index)).forEach((cluster) => {
      markers.appendChild(createMarkerNode(cluster, index, duration));
    });
  } else {
    const empty = document.createElement("span");
    empty.className = "playlist-marker-empty";
    empty.textContent = "拖入命令";
    markers.appendChild(empty);
  }

  return node;
}

function createMarkerNode(cluster, segmentIndex, durationSeconds) {
  const left = durationSeconds > 0 ? Math.min(Math.max(cluster.percent, 0), 100) : 0;
  const node = document.createElement("button");
  node.type = "button";
  node.className = "playlist-command-marker";
  node.classList.toggle("is-cluster", cluster.items.length > 1);
  node.style.left = `${left}%`;
  node.title = cluster.items
    .map((item) => `${item.command.label} · ${formatSeconds(item.offsetSeconds)}`)
    .join("\n");
  node.innerHTML = `
    <span class="playlist-command-triangle"></span>
    ${cluster.items.length > 1 ? `<span class="playlist-command-count">${cluster.items.length}</span>` : ""}
    <span class="sr-only">${escapeHtml(cluster.items.map((item) => item.command.label).join(", "))}</span>
  `;
  node.dataset.selectSegment = String(segmentIndex);
  return node;
}

function renderCplInfo() {
  const segment = playlistState.editor.segments[playlistState.selectedSegmentIndex];
  if (!segment) {
    setText(playlistDom.selectedCplIndex, "未选择");
    playlistDom.cplInfo.innerHTML = `<div class="playlist-empty">选择时间轴上的 CPL 后查看详细信息。</div>`;
    return;
  }

  const cpl = getCplByUuid(segment.cplUuid);
  const title = getCplTitle(cpl) || segment.cplUuid;
  setText(playlistDom.selectedCplIndex, `CPL ${playlistState.selectedSegmentIndex + 1}`);
  playlistDom.cplInfo.innerHTML = `
    <div class="playlist-cpl-info-title">
      <span>${escapeHtml(title)}</span>
    </div>
    <dl class="playlist-cpl-info-grid">
      <dt>UUID</dt><dd>${escapeHtml(segment.cplUuid)}</dd>
      <dt>视觉</dt><dd>${escapeHtml(formatCplDimensionMode(cpl))}</dd>
      <dt>分辨率</dt><dd>${escapeHtml(formatCplResolution(cpl))}</dd>
      <dt>画幅</dt><dd>${escapeHtml(getCplAspectRatioLabel(cpl) || "-")}</dd>
      <dt>时长</dt><dd>${escapeHtml(formatSeconds(getCplDurationSeconds(segment.cplUuid)))}</dd>
      <dt>帧数</dt><dd>${escapeHtml(cpl?.durationFrames || "-")}</dd>
      <dt>EditRate</dt><dd>${escapeHtml(cpl?.editRate || "-")}</dd>
      <dt>类型</dt><dd>${escapeHtml(cpl?.contentKind || "-")}</dd>
      <dt>Issuer</dt><dd>${escapeHtml(cpl?.issuer || "-")}</dd>
    </dl>
    <div class="playlist-cpl-command-editor">
      <div class="playlist-cpl-info-subhead">命令标记</div>
      <div class="playlist-cpl-command-drop" data-drop-zone="segment-command" data-segment-index="${playlistState.selectedSegmentIndex}">
        ${segment.commands?.length ? "" : '<div class="playlist-empty">将左侧命令拖到这里或拖到时间轴 CPL 上。</div>'}
      </div>
    </div>
  `;

  const drop = playlistDom.cplInfo.querySelector(".playlist-cpl-command-drop");
  segment.commands?.forEach((command, commandIndex) => {
    drop.appendChild(createCommandEditorNode(command, playlistState.selectedSegmentIndex, commandIndex));
  });
}

function createCommandEditorNode(command, segmentIndex, commandIndex) {
  const fps = getSegmentFps(segmentIndex);
  const maxFrames = getSegmentMaxOffsetFrames(segmentIndex);
  const frames = clampCommandOffsetFrames(getCommandOffsetFrames(command), segmentIndex);
  const parts = getTimecodeParts(frames, fps);
  const maxHours = maxFrames > 0 ? Math.floor(maxFrames / Math.max(1, Math.round(fps)) / 3600) : 999;
  const frameMax = Math.max(0, Math.round(fps) - 1);
  const mode = getCommandEditMode(segmentIndex, commandIndex);
  const node = document.createElement("div");
  node.className = "playlist-command-row";
  node.dataset.commandEditMode = mode;
  node.innerHTML = `
    <strong title="${escapeHtml(command.label)}">${escapeHtml(command.label)}</strong>
    <div class="playlist-command-mode" role="group" aria-label="命令时间编辑方式">
      <button type="button" class="btn btn-xs ${mode === "timecode" ? "btn-primary" : "btn-outline"}" data-command-mode="timecode" data-segment-index="${segmentIndex}" data-command-index="${commandIndex}">时间码</button>
      <button type="button" class="btn btn-xs ${mode === "frames" ? "btn-primary" : "btn-outline"}" data-command-mode="frames" data-segment-index="${segmentIndex}" data-command-index="${commandIndex}">帧</button>
    </div>
    <div class="playlist-command-time-fields">
      <div class="playlist-command-timecode-panel" ${mode === "timecode" ? "" : "hidden"}>
        ${renderTimecodePartInput("hours", parts.hours, 0, maxHours, segmentIndex, commandIndex, "时")}
        <span class="playlist-timecode-separator">:</span>
        ${renderTimecodePartInput("minutes", parts.minutes, 0, 59, segmentIndex, commandIndex, "分")}
        <span class="playlist-timecode-separator">:</span>
        ${renderTimecodePartInput("seconds", parts.seconds, 0, 59, segmentIndex, commandIndex, "秒")}
        <span class="playlist-timecode-bracket">[</span>
        ${renderTimecodePartInput("frames", parts.frames, 0, frameMax, segmentIndex, commandIndex, "帧")}
        <span class="playlist-timecode-bracket">]</span>
      </div>
      <label class="playlist-command-frame-panel" ${mode === "frames" ? "" : "hidden"}>
        <span>总帧</span>
        <input
          class="input input-bordered input-xs"
          type="number"
          min="0"
          ${maxFrames > 0 ? `max="${maxFrames}"` : ""}
          step="1"
          value="${frames}"
          data-command-frames="1"
          data-segment-index="${segmentIndex}"
          data-command-index="${commandIndex}"
        >
      </label>
    </div>
    <div class="playlist-command-actions">
      <button type="button" class="btn btn-xs btn-outline" data-command-shortcut="head" data-segment-index="${segmentIndex}" data-command-index="${commandIndex}">片头</button>
      <button type="button" class="btn btn-xs btn-outline" data-command-shortcut="tail" data-segment-index="${segmentIndex}" data-command-index="${commandIndex}" ${maxFrames > 0 ? "" : "disabled"}>片尾</button>
      <button type="button" class="btn btn-xs btn-ghost" data-remove-command="1" data-segment-index="${segmentIndex}" data-command-index="${commandIndex}" title="移除命令">
        <i class="fas fa-xmark"></i>
      </button>
    </div>
  `;
  return node;
}

function renderTimecodePartInput(part, value, min, max, segmentIndex, commandIndex, label) {
  return `
    <label class="playlist-timecode-part" title="${label}">
      <span class="sr-only">${label}</span>
      <input
        class="playlist-timecode-input"
        type="number"
        inputmode="numeric"
        min="${min}"
        max="${max}"
        step="1"
        value="${value}"
        data-command-timecode-part="${part}"
        data-segment-index="${segmentIndex}"
        data-command-index="${commandIndex}"
      >
    </label>
  `;
}

async function openPlaylistShow(showUuid) {
  if (!playlistState.hallId || !showUuid) {
    return;
  }

  setBusy(true);
  clearError();
  try {
    const payload = await apiPost(
      `/api/runtime/halls/${encodeURIComponent(playlistState.hallId)}/shows/${encodeURIComponent(showUuid)}`,
      {},
    );
    playlistState.editor = normalizeEditorFromShow(payload.show);
    playlistState.selectedSegmentIndex = playlistState.editor.segments.length > 0 ? 0 : -1;
    renderPlaylistPage();
  } catch (error) {
    renderError(error instanceof Error ? error.message : "读取播放表失败。");
  } finally {
    setBusy(false);
  }
}

async function saveCurrentPlaylist() {
  updateEditorFromInputs();
  const validationError = validateEditorForSave();
  if (validationError) {
    renderError(validationError);
    return;
  }

  setBusy(true);
  clearError();
  try {
    const payload = await apiPost(
      `/api/runtime/halls/${encodeURIComponent(playlistState.hallId)}/shows/save`,
      playlistState.editor,
    );
    playlistState.editor.showUuid = payload.result?.showUuid || playlistState.editor.showUuid;
    playlistState.editor.contentVersionId = payload.result?.contentVersionId || playlistState.editor.contentVersionId;
    invalidateFilmPlaybackPlaylistCache();
    await loadPlaylistData(true);
    renderPlaylistPage();
    toast.success("播放表已保存到 GDC。");
  } catch (error) {
    renderError(error instanceof Error ? error.message : "保存播放表失败。");
  } finally {
    setBusy(false);
  }
}

async function deleteCurrentPlaylist() {
  const showUuid = playlistState.editor.showUuid || playlistDom.showSelect?.value;
  if (!playlistState.hallId || !showUuid) {
    return;
  }
  if (!window.confirm("确认删除这个放映表？不会删除 CPL 内容。")) {
    return;
  }

  setBusy(true);
  clearError();
  try {
    await apiPost(
      `/api/runtime/halls/${encodeURIComponent(playlistState.hallId)}/shows/${encodeURIComponent(showUuid)}/delete`,
      {},
    );
    playlistState.editor = createEmptyEditor();
    playlistState.selectedSegmentIndex = -1;
    invalidateFilmPlaybackPlaylistCache();
    await loadPlaylistData(true);
    renderPlaylistPage();
    toast.success("放映表已删除。");
  } catch (error) {
    renderError(error instanceof Error ? error.message : "删除放映表失败。");
  } finally {
    setBusy(false);
  }
}

function copyCurrentPlaylist() {
  if (playlistState.editor.segments.length === 0) {
    return;
  }
  playlistState.editor = {
    ...structuredClone(playlistState.editor),
    showUuid: "",
    contentVersionId: "",
    playlistPackId: "",
    title: createCopyTitle(playlistState.editor.title),
  };
  renderPlaylistPage();
  toast.success("已复制为新的未保存放映表。");
}

async function validateCurrentPlaylist() {
  if (!playlistState.hallId || !playlistState.editor.showUuid) {
    return;
  }

  setBusy(true);
  clearError();
  try {
    const payload = await apiPost(
      `/api/runtime/halls/${encodeURIComponent(playlistState.hallId)}/shows/${encodeURIComponent(playlistState.editor.showUuid)}/validate`,
      {},
    );
    if (payload.validation?.ok) {
      toast.success("播放表校验通过。", { title: "校验通过" });
    } else {
      toast.warning("播放表校验未通过，请检查 CPL/KDM。", { title: "校验未通过" });
    }
  } catch (error) {
    renderError(error instanceof Error ? error.message : "校验播放表失败。");
  } finally {
    setBusy(false);
  }
}

function openCopyWizard() {
  playlistState.copyWizard = createCopyWizardState();
  playlistState.copyWizard.sourceShowUuid = playlistState.editor.showUuid || playlistDom.showSelect?.value || playlistState.shows[0]?.showUuid || "";
  playlistState.copyWizard.targetHallId = getOnlineTargetHalls()[0]?.registration?.hallId || "";
  renderCopyWizard();
  playlistDom.copyWizardDialog?.showModal?.();
}

function closeCopyWizard() {
  if (playlistDom.copyWizardDialog?.open) {
    playlistDom.copyWizardDialog.close();
  }
}

async function advanceCopyWizard() {
  if (playlistState.copyWizard.busy) {
    return;
  }

  if (playlistState.copyWizard.step === 1) {
    if (!playlistState.copyWizard.sourceShowUuid) {
      renderError("请先选择要复制的放映表。");
      return;
    }
    playlistState.copyWizard.step = 2;
    renderCopyWizard();
    return;
  }

  if (playlistState.copyWizard.step === 2) {
    if (!playlistState.copyWizard.targetHallId) {
      renderError("请选择一个在线目标影厅。");
      return;
    }
    await checkCopyWizardShow();
  }
}

async function checkCopyWizardShow() {
  playlistState.copyWizard.busy = true;
  playlistState.copyWizard.check = null;
  renderCopyWizard();
  clearError();
  try {
    const sourceHallId = encodeURIComponent(playlistState.hallId);
    const showUuid = encodeURIComponent(playlistState.copyWizard.sourceShowUuid);
    const payload = await apiPost(`/api/runtime/halls/${sourceHallId}/shows/${showUuid}/copy/check`, {
      targetHallId: playlistState.copyWizard.targetHallId,
    });
    playlistState.copyWizard.check = payload.check || null;
    playlistState.copyWizard.step = 3;
  } catch (error) {
    renderError(error instanceof Error ? error.message : "检查目标影厅失败。");
  } finally {
    playlistState.copyWizard.busy = false;
    renderCopyWizard();
  }
}

async function importCopyWizardShow() {
  if (!playlistState.copyWizard.check?.canImport || playlistState.copyWizard.busy) {
    return;
  }

  playlistState.copyWizard.busy = true;
  renderCopyWizard();
  clearError();
  try {
    const sourceHallId = encodeURIComponent(playlistState.hallId);
    const showUuid = encodeURIComponent(playlistState.copyWizard.sourceShowUuid);
    await apiPost(`/api/runtime/halls/${sourceHallId}/shows/${showUuid}/copy/import`, {
      targetHallId: playlistState.copyWizard.targetHallId,
    });
    invalidateFilmPlaybackPlaylistCache();
    closeCopyWizard();
    toast.success("放映表已导入目标影厅。");
  } catch (error) {
    renderError(error instanceof Error ? error.message : "导入放映表失败。");
  } finally {
    playlistState.copyWizard.busy = false;
    renderCopyWizard();
  }
}

function renderCopyWizard() {
  if (!playlistDom.copyWizardBody) {
    return;
  }

  const step = playlistState.copyWizard.step;
  setText(playlistDom.copyWizardSubtitle, ["选择放映表", "选择在线目标影厅", "检查目标影厅内容"][step - 1] || "");

  if (step === 1) {
    renderCopyWizardShowStep();
  } else if (step === 2) {
    renderCopyWizardHallStep();
  } else {
    renderCopyWizardCheckStep();
  }

  playlistDom.copyWizardBack.disabled = playlistState.copyWizard.busy || step === 1;
  playlistDom.copyWizardNext.hidden = step === 3;
  playlistDom.copyWizardNext.disabled = playlistState.copyWizard.busy
    || (step === 1 && !playlistState.copyWizard.sourceShowUuid)
    || (step === 2 && !playlistState.copyWizard.targetHallId);
  playlistDom.copyWizardImport.hidden = step !== 3;
  playlistDom.copyWizardImport.disabled = playlistState.copyWizard.busy || !playlistState.copyWizard.check?.canImport;
  playlistDom.copyWizardImport.textContent = playlistState.copyWizard.busy ? "处理中" : "导入";
}

function renderCopyWizardShowStep() {
  playlistDom.copyWizardBody.innerHTML = `
    <label class="playlist-copy-field">
      <span>放映表</span>
      <select class="select select-bordered" data-copy-source-show>
        <option value="">请选择放映表</option>
        ${playlistState.shows.map((show) => `
          <option value="${escapeHtml(show.showUuid)}" title="${escapeHtml(show.title || "UNTITLED")}" ${show.showUuid === playlistState.copyWizard.sourceShowUuid ? "selected" : ""}>
            ${escapeHtmlPreservingSpaces(show.title || "UNTITLED")}
          </option>
        `).join("")}
      </select>
    </label>
  `;
}

function renderCopyWizardHallStep() {
  const halls = getOnlineTargetHalls();
  playlistDom.copyWizardBody.innerHTML = `
    <label class="playlist-copy-field">
      <span>目标影厅</span>
      <select class="select select-bordered" data-copy-target-hall ${halls.length ? "" : "disabled"}>
        ${halls.length ? "" : '<option value="">没有其它在线影厅</option>'}
        ${halls.map((hall) => `
          <option value="${escapeHtml(hall.registration.hallId)}" ${hall.registration.hallId === playlistState.copyWizard.targetHallId ? "selected" : ""}>
            ${escapeHtml(hall.registration.hallName || hall.registration.hallId)}
          </option>
        `).join("")}
      </select>
    </label>
    <p class="playlist-copy-hint">只显示当前在线且不是当前页面的影厅。</p>
  `;
}

function renderCopyWizardCheckStep() {
  const check = playlistState.copyWizard.check;
  if (playlistState.copyWizard.busy && !check) {
    playlistDom.copyWizardBody.innerHTML = `<div class="playlist-copy-loading"><span class="loading loading-spinner loading-sm"></span> 正在检查目标影厅...</div>`;
    return;
  }

  if (!check) {
    playlistDom.copyWizardBody.innerHTML = `<div class="playlist-empty">尚未完成检查。</div>`;
    return;
  }

  const conflicts = check.conflictingShows || [];
  const missingCpls = check.missingCpls || [];
  const missingCommands = check.missingCommands || [];
  playlistDom.copyWizardBody.innerHTML = `
    <div class="playlist-copy-summary ${check.canImport ? "is-ok" : "is-blocked"}">
      <i class="fas ${check.canImport ? "fa-circle-check" : "fa-circle-exclamation"}"></i>
      <span>${check.canImport ? "目标影厅内容完整，可以导入。" : "目标影厅暂不能导入，请处理以下问题。"}</span>
    </div>
    ${renderCopyIssueList("同名放映表", conflicts.map((show) => show.title || show.showUuid))}
    ${renderCopyIssueList("缺失 CPL", missingCpls.map((cpl) => `${cpl.title || "CPL"} · ${cpl.cplUuid}`))}
    ${renderCopyIssueList("缺失命令", missingCommands)}
  `;
}

function renderCopyIssueList(title, items) {
  if (!items.length) {
    return `
      <section class="playlist-copy-check-section is-ok">
        <h4>${escapeHtml(title)}</h4>
        <p><i class="fas fa-check"></i> 无问题</p>
      </section>
    `;
  }

  return `
    <section class="playlist-copy-check-section">
      <h4>${escapeHtml(title)}</h4>
      <ul>
        ${items.map((item) => `<li>${escapeHtmlPreservingSpaces(item)}</li>`).join("")}
      </ul>
    </section>
  `;
}

function getOnlineTargetHalls() {
  return playlistState.halls.filter((hall) =>
    hall.registration?.hallId
    && hall.registration.hallId !== playlistState.hallId
    && hall.snapshot?.connectivity?.state === "online"
  );
}

function handleDrop(dropTarget, rawData, event) {
  const data = parseDragData(rawData);
  if (!data) {
    return;
  }

  if (data.dragType === TIMELINE_SEGMENT_DRAG_TYPE) {
    const sourceIndex = Number(data.segmentIndex);
    const segmentTarget = event?.target.closest(".playlist-cpl-segment");
    const targetIndex = segmentTarget ? Number(segmentTarget.dataset.segmentIndex) : playlistState.editor.segments.length;
    const placement = segmentTarget ? getSegmentDropPlacement(segmentTarget, event.clientX) : "after";
    reorderSegment(sourceIndex, placement === "after" ? targetIndex + 1 : targetIndex);
    renderPlaylistPage();
    return;
  }

  if (data.dragType === "cpl") {
    const segmentTarget = event?.target.closest(".playlist-cpl-segment");
    const targetIndex = segmentTarget
      ? Number(segmentTarget.dataset.segmentIndex) + (getSegmentDropPlacement(segmentTarget, event.clientX) === "after" ? 1 : 0)
      : playlistState.editor.segments.length;
    playlistState.editor.segments.splice(targetIndex, 0, {
      cplUuid: data.cplUuid,
      commands: [],
    });
    playlistState.selectedSegmentIndex = targetIndex;
    renderPlaylistPage();
    return;
  }

  if (dropTarget.dataset.dropZone === "segment-command" && data.dragType === "command") {
    const segmentIndex = Number(dropTarget.dataset.segmentIndex);
    const segment = playlistState.editor.segments[segmentIndex];
    if (!segment) {
      return;
    }
    if (CHINESE_TEXT_PATTERN.test(data.commandLabel || "")) {
      renderError("自动化指令包含中文，不能写入播放表 XML。");
      return;
    }
    segment.commands.push(createCommand(data.commandLabel));
    playlistState.selectedSegmentIndex = segmentIndex;
    renderPlaylistPage();
  }
}

function createCommand(label) {
  return {
    label,
    annotationText: label,
    editRate: DEFAULT_EDIT_RATE,
    offsetFrames: undefined,
  };
}

function moveSegment(index, direction) {
  const nextIndex = direction === "left" ? index - 1 : index + 1;
  if (nextIndex < 0 || nextIndex >= playlistState.editor.segments.length) {
    return;
  }
  const [segment] = playlistState.editor.segments.splice(index, 1);
  playlistState.editor.segments.splice(nextIndex, 0, segment);
  playlistState.selectedSegmentIndex = nextIndex;
}

function reorderSegment(sourceIndex, targetIndex) {
  const segments = playlistState.editor.segments;
  if (!Number.isInteger(sourceIndex) || sourceIndex < 0 || sourceIndex >= segments.length) {
    return;
  }

  const normalizedTargetIndex = Math.min(Math.max(targetIndex, 0), segments.length);
  const insertIndex = sourceIndex < normalizedTargetIndex ? normalizedTargetIndex - 1 : normalizedTargetIndex;
  if (insertIndex === sourceIndex) {
    playlistState.selectedSegmentIndex = sourceIndex;
    return;
  }

  const [segment] = segments.splice(sourceIndex, 1);
  segments.splice(insertIndex, 0, segment);
  playlistState.selectedSegmentIndex = insertIndex;
}

function applyCommandShortcut(segmentIndex, commandIndex, shortcut) {
  const command = readCommandTarget(segmentIndex, commandIndex);
  if (!command) {
    return;
  }
  const frames = shortcut === "tail" ? getSegmentMaxOffsetFrames(segmentIndex) : 0;
  setCommandOffsetFrames(command, frames, segmentIndex);
  playlistState.selectedSegmentIndex = segmentIndex;
  renderTimeline();
  renderCplInfo();
}

function removeCommand(segmentIndex, commandIndex) {
  playlistState.editor.segments[segmentIndex]?.commands.splice(commandIndex, 1);
}

function readCommandTarget(segmentIndex, commandIndex) {
  return playlistState.editor.segments[segmentIndex]?.commands[commandIndex];
}

function getCommandEditMode(segmentIndex, commandIndex) {
  return playlistState.commandEditModes[getCommandKey(segmentIndex, commandIndex)] || "timecode";
}

function setCommandEditMode(segmentIndex, commandIndex, mode) {
  playlistState.commandEditModes[getCommandKey(segmentIndex, commandIndex)] = mode === "frames" ? "frames" : "timecode";
}

function getCommandKey(segmentIndex, commandIndex) {
  return `${segmentIndex}:${commandIndex}`;
}

function syncEditorInputs() {
  playlistDom.titleInput.value = playlistState.editor.title;
  playlistDom.issuerInput.value = playlistState.editor.issuer;
  playlistDom.creatorInput.value = playlistState.editor.creator;
  playlistDom.playCountInput.value = String(playlistState.editor.playCount || 1);
  syncInputValidity();
}

function updateEditorFromInputs() {
  playlistState.editor.title = playlistDom.titleInput?.value || "";
  playlistState.editor.issuer = playlistDom.issuerInput?.value || "GDC";
  playlistState.editor.creator = playlistDom.creatorInput?.value || "SMS";
  playlistState.editor.playCount = Math.max(1, Number(playlistDom.playCountInput?.value || 1));
}

function normalizeEditorFromShow(show) {
  return {
    title: show?.title || "",
    showUuid: show?.showUuid || "",
    contentVersionId: show?.contentVersionId || "",
    playlistPackId: show?.playlistPackId || "",
    issuer: show?.issuer || "GDC",
    creator: show?.creator || "SMS",
    playCount: show?.playCount || 1,
    preShowCommands: [],
    segments: Array.isArray(show?.segments)
      ? show.segments.map((segment) => ({
          cplUuid: segment.cplUuid,
          commands: cloneCommands(segment.commands),
        }))
      : [],
  };
}

function createEmptyEditor() {
  return {
    title: "",
    showUuid: "",
    contentVersionId: "",
    playlistPackId: "",
    issuer: "GDC",
    creator: "SMS",
    playCount: 1,
    preShowCommands: [],
    segments: [],
  };
}

function resetPlaylistEditor() {
  playlistState.editor = createEmptyEditor();
  playlistState.selectedSegmentIndex = -1;
  playlistState.commandEditModes = {};
  resetPlaylistDragState();
  clearTimelineDropState();
}

function createCopyWizardState() {
  return {
    step: 1,
    sourceShowUuid: "",
    targetHallId: "",
    busy: false,
    check: null,
  };
}

function cloneCommands(commands) {
  return Array.isArray(commands)
    ? commands.map((command) => ({
        markerUuid: command.markerUuid || "",
        label: command.label || "",
        annotationText: command.annotationText || command.label || "",
        offsetFrames: Number.isFinite(command.offsetFrames) ? command.offsetFrames : undefined,
        editRate: command.editRate || DEFAULT_EDIT_RATE,
      }))
    : [];
}

function validateEditorForSave() {
  if (!playlistState.hallId) {
    return "请先选择影厅。";
  }
  if (!playlistState.editor.title.trim()) {
    return "播放表名称不能为空。";
  }
  const xmlTextError = validateEditorXmlText(playlistState.editor);
  if (xmlTextError) {
    return xmlTextError;
  }
  if (playlistState.editor.segments.length === 0) {
    return "播放表至少需要一个 CPL。";
  }
  return "";
}

function validateEditorXmlText(editor) {
  const title = editor.title.trim();
  if (CHINESE_TEXT_PATTERN.test(title)) {
    return "播放表名称不能包含中文。";
  }
  if (!SHOW_TITLE_PATTERN.test(title)) {
    return "播放表名称只能包含英文、数字、空格以及 ,./-_@#%。";
  }
  if (CHINESE_TEXT_PATTERN.test(editor.issuer || "")) {
    return "Issuer 不能包含中文。";
  }
  if (CHINESE_TEXT_PATTERN.test(editor.creator || "")) {
    return "Creator 不能包含中文。";
  }
  for (const segment of editor.segments) {
    for (const command of segment.commands || []) {
      if (CHINESE_TEXT_PATTERN.test(command.label || "") || CHINESE_TEXT_PATTERN.test(command.annotationText || "")) {
        return `自动化指令“${command.label || ""}”包含中文，不能写入播放表 XML。`;
      }
    }
  }
  return "";
}

function syncInputValidity() {
  if (playlistDom.titleInput) {
    const title = playlistState.editor.title.trim();
    const invalid = Boolean(title) && (!SHOW_TITLE_PATTERN.test(title) || CHINESE_TEXT_PATTERN.test(title));
    playlistDom.titleInput.classList.toggle("input-error", invalid);
  }
}

function syncButtons() {
  const disabled = playlistState.busy || !playlistState.hallId;
  playlistDom.refreshButton.disabled = disabled;
  playlistDom.saveButton.disabled = disabled;
  playlistDom.newButton.disabled = playlistState.busy;
  playlistDom.copyButton.disabled = playlistState.busy || playlistState.editor.segments.length === 0;
  playlistDom.copyToHallButton.disabled = playlistState.busy || playlistState.shows.length === 0 || getOnlineTargetHalls().length === 0;
  playlistDom.deleteButton.disabled = disabled || !playlistState.editor.showUuid;
  playlistDom.validateButton.disabled = disabled || !playlistState.editor.showUuid;
}

function setBusy(busy) {
  playlistState.busy = busy;
  syncButtons();
}

function clampSelectedSegment() {
  if (playlistState.editor.segments.length === 0) {
    playlistState.selectedSegmentIndex = -1;
    return;
  }
  playlistState.selectedSegmentIndex = Math.min(
    Math.max(playlistState.selectedSegmentIndex, 0),
    playlistState.editor.segments.length - 1,
  );
}

function getCplByUuid(cplUuid) {
  return playlistState.cpls.find((item) => item.cplUuid === cplUuid) || null;
}

function getCplTitle(cpl) {
  return cpl?.contentTitleText || cpl?.annotationText || cpl?.cplUuid || "";
}

function renderCplTitleLine(cpl, title, className, showTags = false) {
  return `
    <strong class="${className} playlist-title-with-tags">
      ${showTags ? renderCplFormatTags(getCplListTags(cpl)) : ""}
      <span class="playlist-title-text">${escapeHtml(title)}</span>
    </strong>
  `;
}

function renderCplFormatTags(tags) {
  return tags
    .map((tag) => `<span class="playlist-cpl-format-tag${tag === "3D" ? " is-3d" : ""}">${escapeHtml(tag)}</span>`)
    .join("");
}

function getCplListTags(cpl) {
  const title = getCplTitle(cpl);
  const rawXml = cpl?.rawCplXml || "";
  const tags = [];
  const addTag = (tag) => {
    if (!tags.includes(tag)) {
      tags.push(tag);
    }
  };

  if (cpl?.isStereoscopic === true || hasCplToken(title, "3D") || /MainStereoscopicPicture|Stereoscopic/i.test(rawXml)) {
    addTag("3D");
  }

  if (cpl?.resolutionLabel === "4K" || hasCplToken(title, "4K") || getCplPictureWidth(rawXml) >= 3500) {
    addTag("4K");
  }

  return tags;
}

function formatCplDimensionMode(cpl) {
  if (cpl?.isStereoscopic === true) {
    return "3D";
  }
  if (cpl?.isStereoscopic === false) {
    return "2D";
  }
  if (hasCplToken(getCplTitle(cpl), "3D")) {
    return "3D";
  }
  if (hasCplToken(getCplTitle(cpl), "2D")) {
    return "2D";
  }
  return "-";
}

function formatCplResolution(cpl) {
  const label = cpl?.resolutionLabel
    || (hasCplToken(getCplTitle(cpl), "4K") ? "4K" : hasCplToken(getCplTitle(cpl), "2K") ? "2K" : undefined);
  const size = cpl?.pictureWidth && cpl?.pictureHeight ? ` (${cpl.pictureWidth}x${cpl.pictureHeight})` : "";
  return label ? `${label}${size}` : "-";
}

function getCplAspectRatioLabel(cpl) {
  return cpl?.aspectRatioLabel || cpl?.screenAspectRatio || inferCplAspectRatioLabel(getCplTitle(cpl));
}

function inferCplAspectRatioLabel(title) {
  if (hasCplToken(title, "185")) {
    return "1.85";
  }
  if (hasCplToken(title, "239") || hasCplToken(title, "240") || hasCplToken(title, "235")) {
    return "2.39";
  }
  return "";
}

function hasCplToken(value, token) {
  return new RegExp(`(^|[^A-Za-z0-9])${token}([^A-Za-z0-9]|$)`, "i").test(String(value || ""));
}

function getCplPictureWidth(rawXml) {
  const match = /<(?:StoredWidth|Width|HorizontalPixels)>\s*(\d+)\s*<\/(?:StoredWidth|Width|HorizontalPixels)>/i.exec(rawXml || "");
  return match ? Number(match[1]) : 0;
}

function getCplDurationSeconds(cplUuid) {
  const cpl = getCplByUuid(cplUuid);
  return Number.isFinite(cpl?.durationSeconds) ? cpl.durationSeconds : 0;
}

function getSegmentCpl(segmentIndex) {
  const segment = playlistState.editor.segments[segmentIndex];
  return segment ? getCplByUuid(segment.cplUuid) : null;
}

function getSegmentFps(segmentIndex) {
  return parseEditRateFps(getSegmentCpl(segmentIndex)?.editRate) || DEFAULT_FPS;
}

function getSegmentEditRate(segmentIndex) {
  return getSegmentCpl(segmentIndex)?.editRate || DEFAULT_EDIT_RATE;
}

function getSegmentDurationFrames(segmentIndex) {
  const cpl = getSegmentCpl(segmentIndex);
  if (Number.isFinite(cpl?.durationFrames) && cpl.durationFrames > 0) {
    return Math.round(cpl.durationFrames);
  }
  const fps = getSegmentFps(segmentIndex);
  return Number.isFinite(cpl?.durationSeconds) && cpl.durationSeconds > 0
    ? Math.round(cpl.durationSeconds * fps)
    : 0;
}

function getSegmentMaxOffsetFrames(segmentIndex) {
  const durationFrames = getSegmentDurationFrames(segmentIndex);
  return durationFrames > 0 ? durationFrames - 1 : 0;
}

function getCommandOffsetFrames(command) {
  return Math.max(0, Math.round(Number(command?.offsetFrames || 0)));
}

function setCommandOffsetFrames(command, value, segmentIndex) {
  const frames = clampCommandOffsetFrames(value, segmentIndex);
  command.offsetFrames = frames > 0 ? frames : undefined;
  command.editRate = getSegmentEditRate(segmentIndex);
  return frames;
}

function clampCommandOffsetFrames(value, segmentIndex) {
  const frames = Math.max(0, Math.round(Number.isFinite(value) ? value : 0));
  const maxFrames = getSegmentMaxOffsetFrames(segmentIndex);
  return maxFrames > 0 ? Math.min(frames, maxFrames) : frames;
}

function syncCommandRowInputs(row, frames, fps) {
  if (!row) {
    return;
  }
  const frameInput = row.querySelector("[data-command-frames]");
  const parts = getTimecodeParts(frames, fps);
  if (frameInput) {
    frameInput.value = String(frames);
  }
  for (const [part, value] of Object.entries(parts)) {
    const input = row.querySelector(`[data-command-timecode-part="${part}"]`);
    if (input) {
      input.value = String(value);
    }
  }
}

function readTimecodePartsFrames(row, fps) {
  const normalizedFps = Math.max(1, Math.round(fps || DEFAULT_FPS));
  const readPart = (part) => {
    const input = row?.querySelector(`[data-command-timecode-part="${part}"]`);
    const min = Number(input?.min || 0);
    const max = Number(input?.max || 999999);
    const value = Math.round(Number(input?.value || 0));
    return Math.min(Math.max(Number.isFinite(value) ? value : 0, min), max);
  };
  const hours = readPart("hours");
  const minutes = readPart("minutes");
  const seconds = readPart("seconds");
  const framePart = readPart("frames");
  return ((hours * 3600 + minutes * 60 + seconds) * normalizedFps) + framePart;
}

function getEditorDurationSeconds() {
  return playlistState.editor.segments.reduce((total, segment) => total + getCplDurationSeconds(segment.cplUuid), 0);
}

function clusterCommands(commands, durationSeconds, fps = DEFAULT_FPS) {
  const positioned = commands
    .map((command, commandIndex) => {
      const offsetSeconds = (command.offsetFrames || 0) / fps;
      const percent = durationSeconds > 0 ? Math.min(Math.max((offsetSeconds / durationSeconds) * 100, 0), 100) : 0;
      return { command, commandIndex, offsetSeconds, percent };
    })
    .sort((left, right) => left.percent - right.percent);

  const clusters = [];
  for (const item of positioned) {
    const last = clusters[clusters.length - 1];
    if (!last || Math.abs(item.percent - last.percent) > MARKER_CLUSTER_THRESHOLD_PERCENT) {
      clusters.push({
        percent: item.percent,
        items: [item],
      });
      continue;
    }

    last.items.push(item);
    last.percent = last.items.reduce((sum, entry) => sum + entry.percent, 0) / last.items.length;
  }

  return clusters;
}

function createCopyTitle(title) {
  const base = String(title || "UNTITLED").trim() || "UNTITLED";
  const next = `${base}_copy`;
  return next.replace(/[^A-Za-z0-9 ,./\-_@#%]/g, "").slice(0, 80) || "UNTITLED_copy";
}

function createOption(value, text) {
  const option = document.createElement("option");
  option.value = value;
  option.textContent = preserveVisibleSpaces(text);
  option.title = text;
  option.dataset.rawText = text;
  return option;
}

function preserveVisibleSpaces(text) {
  return String(text).replace(/ {2,}/g, (spaces) => "\u00a0".repeat(spaces.length));
}

function escapeHtmlPreservingSpaces(value) {
  return escapeHtml(value).replace(/ {2,}/g, (spaces) => "&nbsp;".repeat(spaces.length));
}

function createEmpty(text, className = "playlist-empty") {
  const node = document.createElement("div");
  node.className = className;
  node.textContent = text;
  return node;
}

function parseDragData(rawData) {
  try {
    return JSON.parse(rawData);
  } catch {
    return null;
  }
}

function getSegmentDropPlacement(segmentNode, clientX) {
  const rect = segmentNode.getBoundingClientRect();
  return clientX > rect.left + rect.width / 2 ? "after" : "before";
}

function clearTimelineDropState() {
  playlistDom.timeline?.classList.remove("playlist-drop-active");
  document.querySelectorAll(".playlist-cpl-segment.is-drop-before, .playlist-cpl-segment.is-drop-after").forEach((node) => {
    node.classList.remove("is-drop-before", "is-drop-after");
  });
}

function resetPlaylistDragState() {
  playlistState.drag = {
    type: "",
    sourceSegmentIndex: -1,
  };
}

function getSelectedPlaylistHall() {
  return playlistState.halls.find((item) => item.registration?.hallId === playlistState.hallId) || null;
}

function isSelectedPlaylistHallOffline() {
  const hall = getSelectedPlaylistHall();
  return Boolean(hall) && hall.snapshot?.connectivity?.state !== "online";
}

function isSelectedPlaylistHallMissing() {
  return playlistState.halls.length > 0 && !getSelectedPlaylistHall();
}

function renderError(message, type = "error") {
  renderStatusAlert(playlistDom.error, { type, message });
}

function clearError() {
  playlistDom.error.innerHTML = "";
}

function setText(node, value) {
  if (node) {
    node.textContent = value;
  }
}

function shortUuid(value) {
  const text = String(value || "");
  return text.replace(/^urn:uuid:/, "").slice(0, 8) || "-";
}

function formatSeconds(value) {
  if (!Number.isFinite(value) || value <= 0) {
    return "00:00:00";
  }
  const totalSeconds = Math.round(value);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return [hours, minutes, seconds].map((part) => String(part).padStart(2, "0")).join(":");
}

function formatTimecodeFrames(value, fps) {
  const parts = getTimecodeParts(value, fps);
  const frameDigits = String(Math.max(1, Math.round(fps || DEFAULT_FPS)) - 1).length;
  return `${String(parts.hours).padStart(2, "0")}:${String(parts.minutes).padStart(2, "0")}:${String(parts.seconds).padStart(2, "0")}[${String(parts.frames).padStart(frameDigits, "0")}]`;
}

function getTimecodeParts(value, fps) {
  const normalizedFps = Math.max(1, Math.round(fps || DEFAULT_FPS));
  const frames = Math.max(0, Math.round(Number(value || 0)));
  const totalSeconds = Math.floor(frames / normalizedFps);
  const framePart = frames % normalizedFps;
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return {
    hours,
    minutes,
    seconds,
    frames: framePart,
  };
}

function parseEditRateFps(editRate) {
  const parts = String(editRate || "").trim().split(/\s+/).map((part) => Number(part));
  if (!Number.isFinite(parts[0]) || parts[0] <= 0) {
    return undefined;
  }
  const denominator = Number.isFinite(parts[1]) && parts[1] > 0 ? parts[1] : 1;
  return parts[0] / denominator;
}

function formatTimelineDuration(value) {
  const clock = formatSeconds(value);
  return clock.startsWith("00:") ? clock.slice(3) : clock;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
