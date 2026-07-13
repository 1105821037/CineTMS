import {
  apiGet,
  apiPost,
  getActivities,
  getNotificationSummary,
  getNotifications,
  getRuntimeHalls,
  openEventStream,
  openRealtimeSocket,
} from "../api.js";
import { appState } from "../state.js";

const INTERPOLATION_INTERVAL_MS = 250;
const REALTIME_RECONNECT_MS = 5_000;
const dismissedReminderStorageKey = "tms.dismissedConfigReminders";

const homeState = {
  halls: [],
  stream: null,
  realtimeSocket: null,
  realtimeReconnectTimer: null,
  realtimeActive: false,
  interpolationTimer: null,
  playbackSamples: new Map(),
  showMetaByHallId: new Map(),
  notifications: [],
  notificationSummary: null,
  activities: [],
  repositoryCapacity: null,
  configStatus: {
    settings: null,
    ticketing: null,
    notifications: null,
  },
  assetCounts: {
    kdm: null,
    dcp: null,
  },
  loading: false,
  error: "",
  lastUpdatedAt: "",
};

const homeDom = {
  root: null,
  stats: null,
  grid: null,
  empty: null,
  error: null,
  configReminders: null,
  summary: null,
  refreshButton: null,
  lastUpdated: null,
  notificationList: null,
  notificationBadge: null,
  activityTableBody: null,
};

export async function initHomePage() {
  cacheHomeDom();
  bindHomeEvents();
  await refreshHomeOverview();
  syncPlaybackSamples();
  void hydrateHomeShowMeta();
  await refreshHomeFeed();
  connectRuntimeStream();
  homeState.realtimeActive = true;
  connectRealtimeSocket();
  startInterpolationTicker();
  renderHomeOverview();
}

export function disposeHomePage() {
  homeState.stream?.close();
  homeState.stream = null;
  homeState.realtimeSocket?.close();
  homeState.realtimeSocket = null;
  homeState.realtimeActive = false;
  clearRealtimeReconnectTimer();
  stopInterpolationTicker();
  homeState.playbackSamples.clear();
}

function cacheHomeDom() {
  homeDom.root = document.getElementById("homeOverviewPage");
  homeDom.stats = document.getElementById("homeOverviewStats");
  homeDom.grid = document.getElementById("homeOverviewGrid");
  homeDom.empty = document.getElementById("homeOverviewEmpty");
  homeDom.error = document.getElementById("homeOverviewError");
  homeDom.configReminders = document.getElementById("homeConfigReminders");
  homeDom.summary = document.getElementById("homeOverviewSummary");
  homeDom.refreshButton = document.getElementById("homeOverviewRefresh");
  homeDom.lastUpdated = document.getElementById("homeOverviewLastUpdated");
  homeDom.notificationList = document.getElementById("homeNotificationList");
  homeDom.notificationBadge = document.getElementById("homeNotificationBadge");
  homeDom.activityTableBody = document.getElementById("homeActivityTableBody");
}

function bindHomeEvents() {
  if (!homeDom.root || homeDom.root.dataset.bound === "true") {
    return;
  }

  homeDom.root.dataset.bound = "true";

  homeDom.refreshButton?.addEventListener("click", async () => {
    await withRefreshButton(async () => {
      await refreshHomeOverview(true);
      await refreshHomeFeed();
      renderHomeOverview();
    });
  });

  homeDom.grid?.addEventListener("click", (event) => {
    if (!(event.target instanceof Element)) {
      return;
    }

    const card = event.target.closest("[data-hall-link]");
    if (!(card instanceof HTMLElement)) {
      return;
    }

    const href = card.dataset.hallLink;
    if (!href) {
      return;
    }

    window.location.hash = href;
  });

  homeDom.grid?.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") {
      return;
    }

    if (!(event.target instanceof Element)) {
      return;
    }

    const card = event.target.closest("[data-hall-link]");
    if (!(card instanceof HTMLElement) || !card.dataset.hallLink) {
      return;
    }

    event.preventDefault();
    window.location.hash = card.dataset.hallLink;
  });

  homeDom.configReminders?.addEventListener("click", (event) => {
    if (!(event.target instanceof Element)) {
      return;
    }

    const button = event.target.closest("[data-dismiss-config-reminder]");
    if (!(button instanceof HTMLElement)) {
      return;
    }

    event.preventDefault();
    dismissConfigReminder(button.dataset.dismissConfigReminder);
  });
}

async function refreshHomeFeed() {
  const [notifications, summary, activities] = await Promise.all([
    getNotifications({ activeOnly: true, limit: 5 }).catch(() => []),
    getNotificationSummary().catch(() => null),
    getActivities({ limit: 10 }).catch(() => []),
  ]);

  homeState.notifications = notifications;
  homeState.notificationSummary = summary;
  homeState.activities = activities;
}

async function refreshHomeOverview(force = false) {
  homeState.loading = true;
  homeState.error = "";

  try {
    const [halls, settings, ticketing, notificationSettings, kdmPayload, dcpPayload] = await Promise.all([
      getRuntimeHalls(force),
      apiGet("/api/system/settings").catch(() => null),
      apiGet("/api/system/ticketing").catch(() => null),
      apiGet("/api/external-notifications/settings").catch(() => null),
      apiGet("/api/kdm/assets").catch(() => null),
      apiGet("/api/dcp/assets").catch(() => null),
    ]);
    homeState.halls = halls;
    homeState.repositoryCapacity = settings?.repositoryCapacity || homeState.repositoryCapacity;
    homeState.configStatus = {
      settings,
      ticketing,
      notifications: notificationSettings?.settings || null,
    };
    homeState.assetCounts = {
      kdm: Array.isArray(kdmPayload?.assets) ? kdmPayload.assets.length : homeState.assetCounts.kdm,
      dcp: Array.isArray(dcpPayload?.packages) ? dcpPayload.packages.length : homeState.assetCounts.dcp,
    };
    homeState.lastUpdatedAt = new Date().toISOString();
    if (force) {
      homeState.showMetaByHallId.clear();
    }
    syncPlaybackSamples();
  } catch (error) {
    homeState.error = error instanceof Error ? error.message : "加载影厅状态失败。";
  } finally {
    homeState.loading = false;
  }
}

function connectRuntimeStream() {
  homeState.stream?.close();
  homeState.stream = openEventStream("/api/runtime/stream");

  homeState.stream.addEventListener("bootstrap", (event) => {
    const payload = parseSseData(event.data);
    homeState.halls = Array.isArray(payload?.halls) ? payload.halls : [];
    homeState.lastUpdatedAt = new Date().toISOString();
    appState.runtimeHallsCache = Promise.resolve(homeState.halls);
    syncPlaybackSamples();
    void hydrateHomeShowMeta();
    renderHomeOverview();
  });

  homeState.stream.addEventListener("snapshot", (event) => {
    const record = parseSseData(event.data);
    if (!record?.registration?.hallId) {
      return;
    }

    const next = [...homeState.halls];
    const index = next.findIndex((hall) => hall.registration.hallId === record.registration.hallId);
    if (index >= 0) {
      next[index] = record;
    } else {
      next.push(record);
    }

    homeState.halls = next;
    homeState.lastUpdatedAt = new Date().toISOString();
    appState.runtimeHallsCache = Promise.resolve(homeState.halls);
    syncPlaybackSampleForHall(record);
    void hydrateHomeShowMeta([record.registration.hallId]);
    renderHomeOverview();
  });

  homeState.stream.onerror = () => {
    if (!homeState.halls.length) {
      homeState.error = "实时连接中断，正在等待重新建立连接。";
      renderHomeOverview();
    }
  };
}

function connectRealtimeSocket() {
  if (!homeState.realtimeActive) {
    return;
  }

  clearRealtimeReconnectTimer();
  homeState.realtimeSocket?.close();

  const socket = openRealtimeSocket();
  homeState.realtimeSocket = socket;

  socket.addEventListener("message", (event) => {
    const message = parseSseData(event.data);
    if (!message?.type) {
      return;
    }

    if (message.type === "notification") {
      mergeNotification(message.payload);
      renderHomeFeed();
      return;
    }

    if (message.type === "notification-summary") {
      homeState.notificationSummary = message.payload || null;
      renderHomeNotifications();
      return;
    }

    if (message.type === "activity") {
      mergeActivity(message.payload);
      renderHomeActivities();
    }
  });

  socket.addEventListener("close", scheduleRealtimeReconnect);
  socket.addEventListener("error", scheduleRealtimeReconnect);
}

function scheduleRealtimeReconnect() {
  if (!homeState.realtimeActive) {
    return;
  }

  if (homeState.realtimeReconnectTimer) {
    return;
  }

  homeState.realtimeReconnectTimer = window.setTimeout(() => {
    homeState.realtimeReconnectTimer = null;
    connectRealtimeSocket();
  }, REALTIME_RECONNECT_MS);
}

function clearRealtimeReconnectTimer() {
  if (homeState.realtimeReconnectTimer) {
    window.clearTimeout(homeState.realtimeReconnectTimer);
    homeState.realtimeReconnectTimer = null;
  }
}

async function withRefreshButton(action) {
  if (!homeDom.refreshButton) {
    await action();
    return;
  }

  const original = homeDom.refreshButton.innerHTML;
  homeDom.refreshButton.disabled = true;
  homeDom.refreshButton.innerHTML = '<span class="loading loading-spinner loading-sm"></span>刷新中';

  try {
    await action();
  } catch (error) {
    homeState.error = error instanceof Error ? error.message : "刷新影厅状态失败。";
    renderHomeOverview();
  } finally {
    homeDom.refreshButton.disabled = false;
    homeDom.refreshButton.innerHTML = original;
  }
}

function renderHomeOverview() {
  renderError();
  renderConfigReminders();
  renderStats();
  renderMeta();
  renderGrid();
  renderRepositoryStorage();
  renderHomeFeed();
}

function renderConfigReminders() {
  if (!homeDom.configReminders) {
    return;
  }

  const reminders = buildConfigReminders();
  if (reminders.length === 0) {
    homeDom.configReminders.classList.add("hidden");
    homeDom.configReminders.innerHTML = "";
    return;
  }

  homeDom.configReminders.classList.remove("hidden");
  homeDom.configReminders.innerHTML = `
    <div class="home-config-reminders-head">
      <div>
        <h3><i class="fas fa-screwdriver-wrench"></i> 配置提醒</h3>
        <p>这些配置可以稍后完成，但会影响对应功能。</p>
      </div>
      <span class="badge badge-warning">${reminders.length}</span>
    </div>
    <div class="home-config-reminder-list">
      ${reminders.map((item) => `
        <article class="home-config-reminder">
          <span class="home-config-reminder-icon ${escapeHtml(item.tone)}"><i class="fas ${escapeHtml(item.icon)}"></i></span>
          <a class="home-config-reminder-copy" href="${escapeHtml(item.href)}">
            <strong>${escapeHtml(item.title)}</strong>
            <span>${escapeHtml(item.description)}</span>
          </a>
          ${item.dismissible ? `
            <button class="btn btn-ghost btn-xs" type="button" data-dismiss-config-reminder="${escapeHtml(item.id)}">
              不再提醒
            </button>
          ` : '<i class="fas fa-arrow-right"></i>'}
        </article>
      `).join("")}
    </div>
  `;
}

function buildConfigReminders() {
  const reminders = [];
  const settings = homeState.configStatus.settings;
  const ticketing = homeState.configStatus.ticketing;
  const notifications = homeState.configStatus.notifications;
  const dismissed = readDismissedConfigReminders();

  if (!ticketing?.finixx?.baseUrl) {
    reminders.push({
      title: "售票系统尚未配置",
      description: "售票排期同步、影片列表和从售票系统选择影厅需要先连接凤凰佳影。",
      href: "#/settings-ticketing",
      icon: "fa-ticket",
      tone: "is-warning",
    });
  }

  if (homeState.halls.length === 0) {
    reminders.push({
      title: "影厅与 GDC 尚未接入",
      description: "影厅控制、播放表、DCP/KDM 导入和自动放映需要配置影厅连接。",
      href: "#/settings-halls",
      icon: "fa-video",
      tone: "is-error",
    });
  }

  if (settings?.repositoryCapacity?.error) {
    reminders.push({
      title: "存储库不可访问",
      description: settings.repositoryCapacity.error,
      href: "#/settings-storage",
      icon: "fa-folder-tree",
      tone: "is-error",
    });
  } else if (settings?.ftp?.message) {
    reminders.push({
      title: "FTP 访问地址需要确认",
      description: settings.ftp.message,
      href: "#/settings-storage",
      icon: "fa-network-wired",
      tone: "is-warning",
    });
  }

  const enabledChannels = Array.isArray(notifications?.channels)
    ? notifications.channels.filter((channel) => channel.enabled !== false && channel.config?.sendKey)
    : [];
  if (notifications && enabledChannels.length === 0 && !dismissed.has("external-notifications")) {
    reminders.push({
      id: "external-notifications",
      title: "外部通知渠道未配置",
      description: "设备离线、导入失败和排期异常等事件将只保留在系统内。",
      href: "#/settings-notifications",
      icon: "fa-bell",
      tone: "is-info",
      dismissible: true,
    });
  }

  return reminders;
}

function dismissConfigReminder(id) {
  if (!id) {
    return;
  }

  const dismissed = readDismissedConfigReminders();
  dismissed.add(id);
  localStorage.setItem(dismissedReminderStorageKey, JSON.stringify([...dismissed]));
  renderConfigReminders();
}

function readDismissedConfigReminders() {
  try {
    const parsed = JSON.parse(localStorage.getItem(dismissedReminderStorageKey) || "[]");
    return new Set(Array.isArray(parsed) ? parsed.filter((item) => typeof item === "string") : []);
  } catch {
    return new Set();
  }
}

function renderHomeFeed() {
  renderHomeNotifications();
  renderHomeActivities();
}

function renderError() {
  if (!homeDom.error) {
    return;
  }

  if (!homeState.error) {
    homeDom.error.classList.add("hidden");
    homeDom.error.innerHTML = "";
    return;
  }

  homeDom.error.classList.remove("hidden");
  homeDom.error.innerHTML = `
    <div class="alert alert-error shadow-sm">
      <i class="fas fa-circle-xmark"></i>
      <span>${escapeHtml(homeState.error)}</span>
    </div>
  `;
}

function renderStats() {
  if (!homeDom.stats) {
    return;
  }

  const metrics = summarizeHalls(homeState.halls);
  const values = [
    `${metrics.online} / ${metrics.total || 0}`,
    metrics.playing,
    homeState.assetCounts.kdm,
    homeState.assetCounts.dcp,
  ];

  homeDom.stats.querySelectorAll(".stat-value").forEach((node, index) => {
    node.textContent = String(values[index] ?? "-");
  });
}

function renderMeta() {
  const metrics = summarizeHalls(homeState.halls);

  if (homeDom.summary) {
    homeDom.summary.textContent = metrics.total
      ? `在线 ${metrics.online} 个，放映中 ${metrics.playing} 个，暂停 ${metrics.paused} 个，离线 ${metrics.offline} 个，未知 ${metrics.unknown} 个`
      : "暂无运行态数据";
  }

  if (homeDom.lastUpdated) {
    if (homeState.loading) {
      homeDom.lastUpdated.textContent = "正在刷新数据...";
      return;
    }

    homeDom.lastUpdated.textContent = homeState.lastUpdatedAt
      ? `最后更新：${formatDateTime(homeState.lastUpdatedAt)}`
      : "等待数据...";
  }
}

function renderGrid() {
  if (!homeDom.grid || !homeDom.empty) {
    return;
  }

  if (!homeState.halls.length) {
    homeDom.empty.classList.remove("hidden");
    homeDom.grid.innerHTML = "";
    return;
  }

  homeDom.empty.classList.add("hidden");
  homeDom.grid.innerHTML = homeState.halls
    .map((hall) => buildHallCard(hall))
    .join("");
}

function renderHomeNotifications() {
  if (homeDom.notificationBadge) {
    const unread = homeState.notificationSummary?.unread ?? homeState.notifications.filter((item) => item.status === "unread").length;
    homeDom.notificationBadge.textContent = String(unread);
    homeDom.notificationBadge.className = unread > 0
      ? "badge badge-error"
      : "badge badge-ghost";
  }

  if (!homeDom.notificationList) {
    return;
  }

  if (!homeState.notifications.length) {
    homeDom.notificationList.innerHTML = `
      <div class="alert alert-success">
        <i class="fas fa-circle-check"></i>
        <span class="text-sm">暂无待关注通知</span>
      </div>
    `;
    return;
  }

  homeDom.notificationList.innerHTML = homeState.notifications
    .slice(0, 5)
    .map((notification) => `
      <article class="home-notification-item ${notification.status === "unread" ? "is-unread" : ""}">
        <div class="home-notification-icon ${getNotificationSeverityClass(notification.severity)}">
          <i class="fas ${getNotificationSeverityIcon(notification.severity)}"></i>
        </div>
        <div class="min-w-0">
          <div class="home-notification-title">${escapeHtml(notification.title)}</div>
          <div class="home-notification-message home-clamp-2">${escapeHtml(notification.message)}</div>
          <div class="home-notification-meta">${formatDateTime(notification.occurredAt)}</div>
        </div>
      </article>
    `)
    .join("");
}

function renderHomeActivities() {
  if (!homeDom.activityTableBody) {
    return;
  }

  if (!homeState.activities.length) {
    homeDom.activityTableBody.innerHTML = `
      <tr>
        <td colspan="4" class="text-sm text-base-content/60">暂无最近活动</td>
      </tr>
    `;
    return;
  }

  homeDom.activityTableBody.innerHTML = homeState.activities
    .slice(0, 10)
    .map((activity) => `
      <tr>
        <td data-label="时间" class="text-sm text-base-content/70">${formatDateTime(activity.occurredAt)}</td>
        <td data-label="操作">
          <span class="badge badge-ghost">${escapeHtml(formatActivityAction(activity.action))}</span>
        </td>
        <td data-label="对象">
          <div class="font-medium">${escapeHtml(resolveActivityObject(activity))}</div>
          <div class="text-xs text-base-content/55">${escapeHtml(activity.actorName || activity.actorType || "-")}</div>
        </td>
        <td data-label="状态">
          <span class="badge ${activity.status === "success" ? "badge-success" : "badge-error"}">
            ${activity.status === "success" ? "成功" : "失败"}
          </span>
          ${activity.resultMessage ? `<div class="mt-1 max-w-md text-xs text-error">${escapeHtml(activity.resultMessage)}</div>` : ""}
        </td>
      </tr>
    `)
    .join("");
}

function renderRepositoryStorage() {
  const label = document.getElementById("homeRepositoryStorageLabel");
  const value = document.getElementById("homeRepositoryStorageValue");
  const progress = document.getElementById("homeRepositoryStorageProgress");
  const desc = document.getElementById("homeRepositoryStorageDesc");
  const capacity = homeState.repositoryCapacity;

  if (label) label.textContent = "存储库容量";
  if (!capacity) {
    if (value) value.textContent = "正在读取";
    if (progress instanceof HTMLProgressElement) progress.value = 0;
    if (desc) desc.textContent = "等待存储库容量数据。";
    return;
  }

  if (capacity.error) {
    if (value) value.textContent = "读取失败";
    if (progress instanceof HTMLProgressElement) progress.value = 0;
    if (desc) desc.textContent = capacity.error;
    return;
  }

  const percent = getStoragePercent(capacity);
  if (value) value.textContent = `${formatStorage(capacity.usedSpace)} / ${formatStorage(capacity.totalSpace)}`;
  if (progress instanceof HTMLProgressElement) progress.value = percent;
  if (desc) {
    desc.textContent = `已用 / 总容量 · 可用 ${formatStorage(capacity.availableSpace)} · ${percent}% 已用`;
  }
}

function buildHallCard(hall) {
  const hallId = hall.registration.hallId;
  const hallName = hall.registration.hallName || hallId;
  const playback = hall.snapshot.playback?.status || {};
  const showMeta = homeState.showMetaByHallId.get(hallId) || null;
  const serverInfo = hall.snapshot.serverInfo || {};
  const progress = getHomeInterpolatedPlayback(hallId, playback);
  const status = getHallStatus(hall);
  const projectorStatus = serverInfo.projectorStatus?.connectionState || "Unknown";
  const storage = serverInfo.storageInfo || {};
  const href = `#/hall-control/${encodeURIComponent(hallId)}`;

  return `
    <article
      class="card home-hall-card bg-base-100 transition hover:-translate-y-0.5 hover:shadow-xl cursor-pointer"
      data-hall-link="${escapeHtml(href)}"
      tabindex="0"
      role="link"
      aria-label="进入 ${escapeHtml(hallName)}"
    >
      <div class="card-body gap-4">
        <div class="home-hall-top">
          <div class="min-w-0 space-y-2">
            <h3 class="card-title text-xl">${escapeHtml(hallName)}</h3>
            <p class="home-clamp-2 text-sm leading-6 text-base-content/60">${escapeHtmlPreservingSpaces(resolveCurrentTitle(hall))}</p>
          </div>
          <div class="badge ${status.badgeClass}">${status.label}</div>
        </div>

        <div class="home-hall-panels">
          <div class="home-soft-panel home-progress-panel">
            <div class="home-progress-head">
              <span>播放进度</span>
              <span class="home-progress-time" data-playback-label="${escapeHtml(hallId)}">${progress.label}</span>
            </div>
            <progress
              class="progress ${status.progressClass} w-full"
              value="${progress.value}"
              max="100"
              data-playback-progress="${escapeHtml(hallId)}"
            ></progress>
            <div class="home-cpl-inline home-clamp-2">
              <strong>${escapeHtml(resolveCplLabel(playback, showMeta))}</strong>
            </div>
          </div>
          <div class="home-device-panel">
            <div class="home-device-badges">
              <div class="badge ${getConnectivityBadgeClass(hall)} badge-outline">${getConnectivityLabel(hall)}</div>
              <div class="badge ${projectorStatus === "Connected" ? "badge-success" : "badge-ghost"} badge-outline">
                放映机 ${escapeHtml(projectorStatus)}
              </div>
            </div>
            <div class="home-device-storage">存储 ${formatStorage(storage.totalSpace - storage.freeSpace)} / ${formatStorage(storage.totalSpace)}</div>
          </div>
        </div>

        <div class="home-footer card-actions justify-between items-center border-t border-base-300 pt-3 text-sm text-base-content/60">
          <span>${escapeHtml(resolveServerLabel(hall))}</span>
          <span class="home-footer-link inline-flex items-center gap-2 text-primary">
            进入影厅页
            <i class="fas fa-arrow-right"></i>
          </span>
        </div>
      </div>
    </article>
  `;
}

function mergeNotification(notification) {
  if (!notification?.id) {
    return;
  }

  const next = homeState.notifications.filter((item) => item.id !== notification.id);
  if (notification.status === "unread" || notification.status === "read") {
    next.unshift(notification);
  }
  homeState.notifications = next
    .sort((left, right) => Date.parse(right.occurredAt || "") - Date.parse(left.occurredAt || ""))
    .slice(0, 5);
}

function mergeActivity(activity) {
  if (!activity?.id) {
    return;
  }

  homeState.activities = [
    activity,
    ...homeState.activities.filter((item) => item.id !== activity.id),
  ]
    .sort((left, right) => Date.parse(right.occurredAt || "") - Date.parse(left.occurredAt || ""))
    .slice(0, 10);
}

function summarizeHalls(halls) {
  return halls.reduce((summary, hall) => {
    const playbackState = normalizePlaybackState(hall.snapshot.playback?.status?.state);
    const connectivityState = hall.snapshot.connectivity?.state;
    const isOnline = connectivityState === "online";
    const isUnknown = !connectivityState || connectivityState === "unknown";
    const projectorReady = hall.snapshot.serverInfo?.projectorStatus?.connectionState === "Connected";

    summary.total += 1;
    summary.online += isOnline ? 1 : 0;
    summary.unknown += isUnknown ? 1 : 0;
    summary.offline += !isOnline && !isUnknown ? 1 : 0;
    summary.projectorReady += projectorReady ? 1 : 0;
    summary.playing += playbackState === "PLAYING" ? 1 : 0;
    summary.paused += playbackState === "PAUSED" ? 1 : 0;

    return summary;
  }, {
    total: 0,
    online: 0,
    offline: 0,
    unknown: 0,
    projectorReady: 0,
    playing: 0,
    paused: 0,
  });
}

function getHallStatus(hall) {
  const connectivityState = hall.snapshot.connectivity?.state;
  const isOnline = connectivityState === "online";
  const projectorConnected = hall.snapshot.serverInfo?.projectorStatus?.connectionState === "Connected";
  const playback = hall.snapshot.playback?.status || {};
  const playbackState = normalizePlaybackState(playback.state);

  if (!isOnline) {
    if (!connectivityState || connectivityState === "unknown") {
      return {
        label: "检测中",
        detail: "等待 GDC 心跳结果",
        badgeClass: "badge-warning",
        progressClass: "progress-warning",
      };
    }

    return {
      label: "离线",
      detail: hall.snapshot.connectivity?.probePhase === "slowRetry"
        ? "GDC 心跳中断"
        : "后台正在自动探测",
      badgeClass: "badge-error",
      progressClass: "progress-error",
    };
  }

  if (!projectorConnected) {
    return {
      label: "待检查",
      detail: "放映机未连接",
      badgeClass: "badge-warning",
      progressClass: "progress-warning",
    };
  }

  if (playbackState === "PLAYING") {
    return {
      label: "播放中",
      detail: "正在播放当前内容",
      badgeClass: "badge-success",
      progressClass: "progress-success",
    };
  }

  if (playbackState === "PAUSED") {
    return {
      label: "已暂停",
      detail: "播放已暂停",
      badgeClass: "badge-warning",
      progressClass: "progress-warning",
    };
  }

  if (playback.showUuid || playback.showName) {
    return {
      label: "停止",
      detail: "放映表已载入，待执行播放",
      badgeClass: "badge-error",
      progressClass: "progress-primary",
    };
  }

  return {
    label: "停止",
    detail: "当前没有活动播放",
    badgeClass: "badge-error",
    progressClass: "progress-primary",
  };
}

function getPlaybackProgress(playback) {
  const position = playback.cplPosition || playback.showPosition || {};
  const total = safeNumber(position.totalDuration);
  const played = safeNumber(position.playedDuration);

  if (!total) {
    return {
      value: 0,
      label: "暂无进度",
    };
  }

  const percent = Math.min(Math.max((played / total) * 100, 0), 100);
  return {
    value: Math.round(percent),
    label: `${formatSeconds(played)} / ${formatSeconds(total)}`,
  };
}

function getHomeInterpolatedPlayback(hallId, playback) {
  const position = playback.cplPosition || playback.showPosition || {};
  const total = safeNumber(position.totalDuration);
  const fallbackPlayed = safeNumber(position.playedDuration);
  const sample = homeState.playbackSamples.get(hallId);
  const played = sample
    ? getInterpolatedPlayedSeconds(sample)
    : fallbackPlayed;

  if (!total) {
    return {
      value: 0,
      label: "暂无进度",
    };
  }

  const percent = Math.min(Math.max((played / total) * 100, 0), 100);
  return {
    value: Math.round(percent),
    label: `${formatSeconds(played)} / ${formatSeconds(total)}`,
  };
}

function resolveCurrentTitle(hall) {
  const playback = hall.snapshot.playback?.status || {};

  return playback.showName
    || playback.cplName
    || "当前暂无内容";
}

function resolveCplTitle(playback) {
  return playback.cplName || "未获取";
}

function resolveCplLabel(playback, showMeta) {
  const index = Number.isFinite(playback?.cplPosition?.cplIndex) ? playback.cplPosition.cplIndex + 1 : null;
  const total = Number.isFinite(showMeta?.cplCount) ? showMeta.cplCount : null;
  const range = index && total ? `(${index}/${total})` : index ? `(${index}/-)` : "";
  const title = resolveCplTitle(playback);
  return `当前CPL${range}：${title}`;
}

function resolveServerLabel(hall) {
  const serverInfo = hall.snapshot.serverInfo?.info || {};
  return serverInfo.serial || `${hall.registration.host}:${hall.registration.port}`;
}

function getConnectivityLabel(hall) {
  const state = hall.snapshot.connectivity?.state;
  if (state === "online") {
    return "GDC 在线";
  }
  if (!state || state === "unknown") {
    return "GDC 未知";
  }
  return "GDC 离线";
}

function getConnectivityBadgeClass(hall) {
  const state = hall.snapshot.connectivity?.state;
  if (state === "online") {
    return "badge-success";
  }
  if (!state || state === "unknown") {
    return "badge-warning";
  }
  return "badge-error";
}

function normalizePlaybackState(state) {
  const normalized = String(state || "").toUpperCase();
  if (normalized === "PLAYING" || normalized === "RUNNING" || normalized === "PLAY") {
    return "PLAYING";
  }
  if (normalized === "PAUSED" || normalized === "PAUSE") {
    return "PAUSED";
  }
  return "STOPPED";
}

function isPlaybackAdvancing(playbackState) {
  const state = String(playbackState || "").toUpperCase();
  return state === "PLAYING" || state === "RUNNING" || state === "PLAY";
}

function formatSeconds(value) {
  const totalSeconds = Math.max(Math.round(safeNumber(value)), 0);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  return [
    String(hours).padStart(2, "0"),
    String(minutes).padStart(2, "0"),
    String(seconds).padStart(2, "0"),
  ].join(":");
}

function formatStorage(value) {
  if (!Number.isFinite(value) || value <= 0) {
    return "-";
  }

  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = value;
  let index = 0;

  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }

  return `${size.toFixed(size >= 10 || index === 0 ? 0 : 1)} ${units[index]}`;
}

function getStoragePercent(capacity) {
  const used = Number(capacity?.usedSpace);
  const total = Number(capacity?.totalSpace);
  if (!Number.isFinite(used) || !Number.isFinite(total) || total <= 0) {
    return 0;
  }
  return Math.min(100, Math.max(0, Math.round((used / total) * 100)));
}

function formatDateTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return String(value || "-");
  }

  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function getNotificationSeverityClass(severity) {
  if (severity === "critical" || severity === "error") {
    return "is-error";
  }
  if (severity === "warning") {
    return "is-warning";
  }
  return "is-info";
}

function getNotificationSeverityIcon(severity) {
  if (severity === "critical" || severity === "error") {
    return "fa-triangle-exclamation";
  }
  if (severity === "warning") {
    return "fa-circle-exclamation";
  }
  return "fa-circle-info";
}

function formatActivityAction(action) {
  const labels = {
    "auth.login": "登录",
    "auth.logout": "退出",
    "system.settings.update": "更新系统设置",
    "system.ticketing.update": "更新售票配置",
    "system.halls.replace": "更新影厅列表",
    "system.hall.save": "保存影厅",
    "system.hall.delete": "删除影厅",
    "notification.read": "通知已读",
    "notification.dismiss": "忽略通知",
    "notification.resolve": "解决通知",
    "notification.read-all": "全部已读",
    "runtime.control.load-show": "载入放映表",
    "runtime.control.play": "播放",
    "runtime.control.pause": "暂停",
    "runtime.control.resume": "恢复",
    "runtime.control.stop": "停止",
    "runtime.control.next-cpl": "下一 CPL",
    "runtime.control.previous-cpl": "上一 CPL",
    "runtime.control.move-playback": "跳转播放",
    "runtime.control.trigger-automation": "触发自动化",
    "kdm.ingest.create": "创建 KDM 导入",
    "kdm.ingest.reuse": "复用 KDM 导入",
    "kdm.ingest.complete": "KDM 导入完成",
    "kdm.ingest.fail": "KDM 导入失败",
  };
  return labels[action] || action || "-";
}

function resolveActivityObject(activity) {
  return activity.objectName
    || activity.objectId
    || activity.hallId
    || activity.objectType
    || "-";
}

async function hydrateHomeShowMeta(targetHallIds = []) {
  const hallIds = targetHallIds.length > 0
    ? targetHallIds
    : homeState.halls.map((hall) => hall.registration.hallId);

  const tasks = hallIds
    .map((hallId) => homeState.halls.find((hall) => hall.registration.hallId === hallId))
    .filter(Boolean)
    .filter((hall) => hall.snapshot.playback?.status?.showUuid)
    .filter((hall) => !homeState.showMetaByHallId.has(hall.registration.hallId))
    .map(async (hall) => {
      const hallId = hall.registration.hallId;
      const showUuid = hall.snapshot.playback?.status?.showUuid;
      if (!showUuid) {
        return;
      }

      const shows = appState.cinemaShowsCache.get(hallId)
        || await loadShowsForHall(hallId).catch(() => []);
      const current = shows.find((show) => show.showUuid === showUuid);
      if (!current) {
        return;
      }

      homeState.showMetaByHallId.set(hallId, {
        showUuid,
        cplCount: current.cplCount,
      });
    });

  if (tasks.length === 0) {
    return;
  }

  await Promise.allSettled(tasks);
  renderHomeOverview();
}

async function loadShowsForHall(hallId) {
  const result = await apiPost(`/api/runtime/halls/${encodeURIComponent(hallId)}/shows`, {});
  const shows = Array.isArray(result.shows) ? result.shows : [];
  appState.cinemaShowsCache.set(hallId, shows);
  return shows;
}

function syncPlaybackSamples() {
  const activeHallIds = new Set(homeState.halls.map((hall) => hall.registration.hallId));

  for (const hall of homeState.halls) {
    syncPlaybackSampleForHall(hall);
  }

  for (const hallId of homeState.playbackSamples.keys()) {
    if (!activeHallIds.has(hallId)) {
      homeState.playbackSamples.delete(hallId);
    }
  }
}

function syncPlaybackSampleForHall(hall) {
  const hallId = hall.registration.hallId;
  const playback = hall.snapshot.playback?.status || {};
  const position = playback.cplPosition || playback.showPosition || {};
  const total = safeNumber(position.totalDuration);
  const played = safeNumber(position.playedDuration);
  const playbackState = String(playback.state || "");

  if (!total) {
    homeState.playbackSamples.delete(hallId);
    return;
  }

  const previous = homeState.playbackSamples.get(hallId);
  if (
    previous
    && previous.played === played
    && previous.total === total
    && previous.playbackState === playbackState
  ) {
    return;
  }

  homeState.playbackSamples.set(hallId, {
    played,
    total,
    playbackState,
    sampledAt: Date.now(),
  });
}

function getInterpolatedPlayedSeconds(sample) {
  if (!sample) {
    return 0;
  }

  if (!isPlaybackAdvancing(sample.playbackState)) {
    return clampNumber(sample.played, 0, sample.total || 0);
  }

  const elapsed = Math.max((Date.now() - sample.sampledAt) / 1000, 0);
  return clampNumber(sample.played + elapsed, 0, sample.total || 0);
}

function startInterpolationTicker() {
  stopInterpolationTicker();
  homeState.interpolationTimer = window.setInterval(() => {
    renderInterpolatedPlaybackProgress();
  }, INTERPOLATION_INTERVAL_MS);
}

function stopInterpolationTicker() {
  if (homeState.interpolationTimer) {
    window.clearInterval(homeState.interpolationTimer);
    homeState.interpolationTimer = null;
  }
}

function renderInterpolatedPlaybackProgress() {
  for (const hall of homeState.halls) {
    const hallId = hall.registration.hallId;
    const playback = hall.snapshot.playback?.status || {};
    const progress = getHomeInterpolatedPlayback(hallId, playback);
    const progressNode = document.querySelector(`[data-playback-progress="${cssEscape(hallId)}"]`);
    const labelNode = document.querySelector(`[data-playback-label="${cssEscape(hallId)}"]`);

    if (progressNode instanceof HTMLProgressElement) {
      progressNode.value = progress.value;
    }

    if (labelNode) {
      labelNode.textContent = progress.label;
    }
  }
}

function safeNumber(value) {
  return Number.isFinite(value) ? value : 0;
}

function clampNumber(value, min, max) {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(Math.max(value, min), max);
}

function cssEscape(value) {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(value);
  }

  return String(value).replaceAll('"', '\\"');
}

function parseSseData(data) {
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function escapeHtmlPreservingSpaces(value) {
  return escapeHtml(value).replace(/ {2,}/g, (spaces) => "&nbsp;".repeat(spaces.length));
}
