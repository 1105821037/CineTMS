import {
  getAuthStatus,
  getNotificationSummary,
  getNotifications,
  apiGet,
  apiPost,
  markAllNotificationsRead,
  markNotificationRead,
  openRealtimeSocket,
} from "./api.js";
import { clearAuthenticatedUser } from "./state.js";
import { toast } from "./toast.js";

const sidebarLogoutIcon = '<i class="fas fa-right-from-bracket"></i>';

export function initLayout() {
  initTheme();
  initSidebar();
  initFullscreen();
  initTopNotifications();
  initUserDisplay();
  initVersionDisplay();
}

export function updateActiveNav(page, options = {}) {
  const activeHallId = options.hallId || null;
  const isAssetsPage = page === "kdm" || page === "dcp";
  const isAutoPlaybackPage = page === "film-playback";
  const isSettingsPage = page.startsWith("settings");

  document.querySelectorAll(".nav-item").forEach((item) => {
    const matchesPage = item.dataset.page === page;
    const matchesHall = !item.dataset.hallId || item.dataset.hallId === activeHallId;
    item.classList.toggle("active", matchesPage && matchesHall);
  });

  const cinemaGroup = document.getElementById("cinemaNavGroup");
  if (cinemaGroup) {
    cinemaGroup.open = isHallScopedPage(page) || cinemaGroup.open;
  }

  const assetsGroup = document.getElementById("assetsNavGroup");
  if (assetsGroup) {
    assetsGroup.open = isAssetsPage || assetsGroup.open;
  }

  const autoPlaybackGroup = document.getElementById("autoPlaybackNavGroup");
  if (autoPlaybackGroup) {
    autoPlaybackGroup.open = isAutoPlaybackPage || autoPlaybackGroup.open;
  }

  const settingsGroup = document.getElementById("settingsNavGroup");
  if (settingsGroup) {
    settingsGroup.open = isSettingsPage || settingsGroup.open;
  }

  document.querySelectorAll("[data-hall-group]").forEach((group) => {
    group.open = group.dataset.hallGroup === activeHallId;
  });
}

export function renderHallNavigation(halls, activeHallId = null) {
  const navRoot = document.getElementById("cinemaHallNav");
  if (!navRoot) {
    return;
  }

  if (!Array.isArray(halls) || halls.length === 0) {
    navRoot.innerHTML = `
      <li class="cinema-nav-empty">
        <span>暂无已配置影厅</span>
      </li>
    `;
    return;
  }

  navRoot.innerHTML = halls.map((hall) => {
    const hallId = escapeHtml(hall.registration.hallId);
    const hallName = escapeHtml(hall.registration.hallName || hall.registration.hallId);
    const isActive = hall.registration.hallId === activeHallId;

    return `
      <li class="cinema-nav-hall">
        <details data-hall-group="${hallId}" ${isActive ? "open" : ""}>
          <summary class="cinema-hall-summary">
            <i class="fas fa-clapperboard"></i>
            <span class="cinema-hall-name">${hallName}</span>
          </summary>
          <ul class="cinema-hall-links">
            <li>
              <a
                href="#/hall-control/${encodeURIComponent(hall.registration.hallId)}"
                class="nav-item cinema-subnav-item"
                data-page="hall-control"
                data-hall-id="${hallId}"
              >
                <i class="fas fa-sliders"></i>
                <span>影厅控制</span>
              </a>
            </li>
            <li>
              <a
                href="#/hall-playlists/${encodeURIComponent(hall.registration.hallId)}"
                class="nav-item cinema-subnav-item"
                data-page="hall-playlists"
                data-hall-id="${hallId}"
              >
                <i class="fas fa-list-check"></i>
                <span>播放表编辑</span>
              </a>
            </li>
            <li>
              <a
                href="#/hall-cpl/${encodeURIComponent(hall.registration.hallId)}"
                class="nav-item cinema-subnav-item"
                data-page="hall-cpl"
                data-hall-id="${hallId}"
              >
                <i class="fas fa-film"></i>
                <span>CPL 管理</span>
              </a>
            </li>
            <li>
              <a
                href="#/hall-kdm/${encodeURIComponent(hall.registration.hallId)}"
                class="nav-item cinema-subnav-item"
                data-page="hall-kdm"
                data-hall-id="${hallId}"
              >
                <i class="fas fa-key"></i>
                <span>KDM 管理</span>
              </a>
            </li>
            <li>
              <a
                href="#/hall-log/${encodeURIComponent(hall.registration.hallId)}"
                class="nav-item cinema-subnav-item"
                data-page="hall-log"
                data-hall-id="${hallId}"
              >
                <i class="fas fa-file-lines"></i>
                <span>GDC 日志</span>
              </a>
            </li>
          </ul>
        </details>
      </li>
    `;
  }).join("");
}

function isHallScopedPage(page) {
  return page === "hall-control" || page === "hall-playlists" || page === "hall-cpl" || page === "hall-kdm" || page === "hall-log";
}

export function closeSidebar() {
  const sidebar = document.getElementById("sidebar");
  const sidebarOverlay = document.getElementById("sidebarOverlay");
  if (!sidebar || !sidebarOverlay) {
    return;
  }

  sidebar.classList.remove("active");
  sidebarOverlay.classList.remove("active");
  document.body.style.overflow = "";
}

export function updateUserDisplay(username) {
  const nameEl = document.getElementById("sidebarUserName");
  const avatarEl = document.getElementById("sidebarUserAvatar");
  resetSidebarLogoutButton();

  if (nameEl) {
    nameEl.textContent = username || "未登录";
  }
  if (avatarEl) {
    avatarEl.textContent = username ? username.slice(0, 2) : "--";
  }
}

async function initUserDisplay() {
  try {
    const auth = await getAuthStatus();
    if (auth.authenticated && auth.user) {
      updateUserDisplay(auth.user.username);
    }
  } catch {
    updateUserDisplay(null);
  }
}

async function initVersionDisplay() {
  const target = document.getElementById("sidebarVersion");
  if (!target) {
    return;
  }

  try {
    const payload = await apiGet("/api/system/version");
    const version = payload.version || {};
    const label = formatVersionLabel(version);
    if (!label) {
      return;
    }
    target.textContent = label;
    target.title = formatVersionTitle(version);
    target.classList.remove("hidden");
  } catch {
    target.classList.add("hidden");
  }
}

function formatVersionLabel(version) {
  const value = typeof version.version === "string" ? version.version.trim() : "";
  if (!value) {
    return "";
  }

  const channel = typeof version.channel === "string" ? version.channel.trim() : "";
  const buildTime = typeof version.buildTime === "string" ? version.buildTime.trim() : "";
  if (buildTime) {
    return `${value} · biuld${buildTime}`;
  }

  return channel && channel !== "production"
    ? `${value} · ${channel}`
    : `${value}`;
}

function formatVersionTitle(version) {
  const parts = [
    typeof version.name === "string" ? version.name : "CineTMS",
    formatVersionLabel(version),
    version.commit ? `commit ${version.commit}` : "",
    version.buildTime ? `build ${version.buildTime}` : "",
  ].filter(Boolean);
  return parts.join(" · ");
}

function initSidebar() {
  const menuToggle = document.getElementById("menuToggle");
  const sidebar = document.getElementById("sidebar");
  const sidebarOverlay = document.getElementById("sidebarOverlay");
  const sidebarClose = document.getElementById("sidebarClose");
  const logoutButton = document.getElementById("sidebarLogout");

  const openSidebar = () => {
    sidebar.classList.add("active");
    sidebarOverlay.classList.add("active");
    document.body.style.overflow = "hidden";
  };

  menuToggle?.addEventListener("click", openSidebar);
  sidebarClose?.addEventListener("click", closeSidebar);
  sidebarOverlay?.addEventListener("click", closeSidebar);
  logoutButton?.addEventListener("click", () => {
    void logoutCurrentUser(logoutButton);
  });

  document.addEventListener("click", (event) => {
    if (!event.target.closest(".nav-item")) {
      return;
    }

    if (window.innerWidth < 768) {
      closeSidebar();
    }
  });

  let resizeTimer;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (window.innerWidth >= 768) {
        closeSidebar();
      }
    }, 250);
  });
}

function initFullscreen() {
  const fullscreenToggle = document.getElementById("fullscreenToggle");
  fullscreenToggle?.addEventListener("click", () => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen();
      fullscreenToggle.querySelector("i").className = "fas fa-compress";
    } else {
      document.exitFullscreen();
      fullscreenToggle.querySelector("i").className = "fas fa-expand";
    }
  });

  document.addEventListener("fullscreenchange", () => {
    const icon = fullscreenToggle?.querySelector("i");
    if (icon) {
      icon.className = document.fullscreenElement ? "fas fa-compress" : "fas fa-expand";
    }
  });
}

function initTheme() {
  const manager = new ThemeManager();
  document.querySelectorAll(".theme-option").forEach((button) => {
    const theme = getThemeOptionValue(button);
    button.addEventListener("click", () => {
      manager.setTheme(theme);
    });
  });
  manager.updateThemeOptions();
}

function getThemeOptionValue(button) {
  return button.dataset.themeValue || button.dataset.theme;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

class ThemeManager {
  constructor() {
    this.currentTheme = localStorage.getItem("theme") || "system";
    this.applyTheme(this.currentTheme);

    window.matchMedia?.("(prefers-color-scheme: dark)").addEventListener("change", () => {
      if (this.currentTheme === "system") {
        this.applySystemTheme();
        this.updateThemeOptions();
      }
    });
  }

  setTheme(theme) {
    this.currentTheme = theme;
    localStorage.setItem("theme", theme);
    this.applyTheme(theme);
    this.updateThemeOptions();
  }

  applyTheme(theme) {
    if (theme === "system") {
      this.applySystemTheme();
      return;
    }

    document.documentElement.setAttribute("data-theme", theme);
  }

  applySystemTheme() {
    const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    document.documentElement.setAttribute("data-theme", prefersDark ? "dark" : "light");
  }

  updateThemeOptions() {
    const appliedTheme = document.documentElement.getAttribute("data-theme") || "light";
    document.querySelector(".theme-trigger-swatch")?.setAttribute("data-theme", appliedTheme);

    document.querySelectorAll(".theme-option").forEach((button) => {
      const isActive = getThemeOptionValue(button) === this.currentTheme;
      button.classList.toggle("is-active", isActive);
      button.setAttribute("aria-current", isActive ? "true" : "false");
    });
  }
}

const topNotificationState = {
  notifications: [],
  summary: null,
  socket: null,
  reconnectTimer: null,
  active: false,
  toastedNotificationIds: new Set(),
};

const topNotificationDom = {
  badge: null,
  summary: null,
  list: null,
  readAll: null,
};

function initTopNotifications() {
  topNotificationDom.badge = document.getElementById("topNotificationBadge");
  topNotificationDom.summary = document.getElementById("topNotificationSummary");
  topNotificationDom.list = document.getElementById("topNotificationList");
  topNotificationDom.readAll = document.getElementById("topNotificationReadAll");

  if (!topNotificationDom.list || topNotificationState.active) {
    return;
  }

  topNotificationState.active = true;
  bindTopNotificationEvents();
  void refreshTopNotifications();
  connectTopNotificationSocket();
}

function bindTopNotificationEvents() {
  topNotificationDom.readAll?.addEventListener("click", async () => {
    topNotificationDom.readAll.disabled = true;
    try {
      const payload = await markAllNotificationsRead();
      topNotificationState.notifications = topNotificationState.notifications.map((item) => ({
        ...item,
        status: item.status === "unread" ? "read" : item.status,
      }));
      topNotificationState.summary = payload.summary || topNotificationState.summary;
      renderTopNotifications();
    } finally {
      topNotificationDom.readAll.disabled = false;
    }
  });

  topNotificationDom.list?.addEventListener("click", async (event) => {
    if (!(event.target instanceof Element)) {
      return;
    }

    const item = event.target.closest("[data-notification-id]");
    if (!(item instanceof HTMLElement)) {
      return;
    }

    const id = item.dataset.notificationId;
    if (!id) {
      return;
    }

    const notification = topNotificationState.notifications.find((entry) => entry.id === id);
    if (notification?.status === "unread") {
      await markNotificationRead(id).catch(() => undefined);
      mergeTopNotification({ ...notification, status: "read" });
      renderTopNotifications();
    }

    if (notification?.hallId) {
      window.location.hash = `#/hall-control/${encodeURIComponent(notification.hallId)}`;
    }
  });
}

async function refreshTopNotifications() {
  const [notifications, summary] = await Promise.all([
    getNotifications({ activeOnly: true, limit: 5 }).catch(() => []),
    getNotificationSummary().catch(() => null),
  ]);
  topNotificationState.notifications = notifications;
  topNotificationState.summary = summary;
  renderTopNotifications();
}

function connectTopNotificationSocket() {
  clearTopNotificationReconnect();
  topNotificationState.socket?.close();

  const socket = openRealtimeSocket();
  topNotificationState.socket = socket;

  socket.addEventListener("message", (event) => {
    const message = parseJson(event.data);
    if (!message?.type) {
      return;
    }

    if (message.type === "notification") {
      const notification = message.payload;
      const shouldToast = shouldToastTopNotification(notification);
      mergeTopNotification(notification);
      renderTopNotifications();
      if (shouldToast) {
        showTopNotificationToast(notification);
      }
      return;
    }

    if (message.type === "notification-summary") {
      topNotificationState.summary = message.payload || null;
      renderTopNotifications();
    }
  });

  socket.addEventListener("close", scheduleTopNotificationReconnect);
  socket.addEventListener("error", scheduleTopNotificationReconnect);
}

function scheduleTopNotificationReconnect() {
  if (!topNotificationState.active || topNotificationState.reconnectTimer) {
    return;
  }

  topNotificationState.reconnectTimer = window.setTimeout(() => {
    topNotificationState.reconnectTimer = null;
    connectTopNotificationSocket();
  }, 5_000);
}

function clearTopNotificationReconnect() {
  if (topNotificationState.reconnectTimer) {
    window.clearTimeout(topNotificationState.reconnectTimer);
    topNotificationState.reconnectTimer = null;
  }
}

function mergeTopNotification(notification) {
  if (!notification?.id) {
    return;
  }

  const next = topNotificationState.notifications.filter((item) => item.id !== notification.id);
  if (notification.status === "unread" || notification.status === "read") {
    next.unshift(notification);
  }
  topNotificationState.notifications = next
    .sort((left, right) => Date.parse(right.occurredAt || "") - Date.parse(left.occurredAt || ""))
    .slice(0, 5);
}

function shouldToastTopNotification(notification) {
  if (!notification?.id || notification.status !== "unread") {
    return false;
  }

  if (topNotificationState.toastedNotificationIds.has(notification.id)) {
    return false;
  }

  return !topNotificationState.notifications.some((item) => item.id === notification.id);
}

function showTopNotificationToast(notification) {
  topNotificationState.toastedNotificationIds.add(notification.id);

  const type = getTopNotificationToastType(notification.severity);
  const message = String(notification.message || notification.title || "收到一条新的系统通知").trim();
  const title = String(notification.title || "系统通知").trim();
  const action = notification.hallId
    ? {
        label: "查看影厅",
        onClick: () => {
          window.location.hash = `#/hall-control/${encodeURIComponent(notification.hallId)}`;
        },
      }
    : null;

  toast.show({
    id: `notification-toast-${notification.id}`,
    type,
    title,
    message,
    action,
  });
}

async function logoutCurrentUser(button) {
  if (button) {
    button.disabled = true;
    button.innerHTML = '<span class="loading loading-spinner loading-xs"></span>';
  }

  try {
    await apiPost("/api/auth/logout", {});
    clearAuthenticatedUser();
    updateUserDisplay(null);
    closeSidebar();
    window.location.replace("#/login");
  } catch (error) {
    resetSidebarLogoutButton(button);
    toast.error(error instanceof Error ? error.message : "退出登录失败。");
  }
}

function resetSidebarLogoutButton(button = document.getElementById("sidebarLogout")) {
  if (!button) return;
  button.disabled = false;
  button.innerHTML = sidebarLogoutIcon;
}

function getTopNotificationToastType(severity) {
  if (severity === "critical") {
    return "critical";
  }
  if (severity === "error") {
    return "error";
  }
  if (severity === "warning") {
    return "warning";
  }
  return "info";
}

function renderTopNotifications() {
  renderTopNotificationBadge();
  renderTopNotificationList();
}

function renderTopNotificationBadge() {
  const unread = topNotificationState.summary?.unread
    ?? topNotificationState.notifications.filter((item) => item.status === "unread").length;

  if (topNotificationDom.badge) {
    topNotificationDom.badge.textContent = unread > 99 ? "99+" : String(unread);
    topNotificationDom.badge.classList.toggle("hidden", unread <= 0);
    topNotificationDom.badge.classList.toggle("badge-error", unread > 0);
    topNotificationDom.badge.classList.toggle("badge-primary", unread <= 0);
  }

  if (topNotificationDom.summary) {
    const active = topNotificationState.summary?.active ?? topNotificationState.notifications.length;
    topNotificationDom.summary.textContent = unread > 0
      ? `${unread} 条未读，${active} 条待关注`
      : "暂无未读通知";
  }

  if (topNotificationDom.readAll) {
    topNotificationDom.readAll.disabled = unread <= 0;
  }
}

function renderTopNotificationList() {
  if (!topNotificationDom.list) {
    return;
  }

  if (!topNotificationState.notifications.length) {
    topNotificationDom.list.innerHTML = `
      <div class="top-notification-empty">
        <i class="fas fa-circle-check"></i>
        <span>暂无待关注通知</span>
      </div>
    `;
    return;
  }

  topNotificationDom.list.innerHTML = topNotificationState.notifications.map((notification) => `
    <button
      class="top-notification-item ${notification.status === "unread" ? "is-unread" : ""}"
      type="button"
      data-notification-id="${escapeHtml(notification.id)}"
    >
      <span class="top-notification-dot ${getTopNotificationSeverityClass(notification.severity)}"></span>
      <span class="top-notification-body">
        <span class="top-notification-item-title">${escapeHtml(notification.title)}</span>
        <span class="top-notification-item-message">${escapeHtml(notification.message)}</span>
        <span class="top-notification-item-time">${formatTopNotificationTime(notification.occurredAt)}</span>
      </span>
    </button>
  `).join("");
}

function getTopNotificationSeverityClass(severity) {
  if (severity === "critical" || severity === "error") {
    return "is-error";
  }
  if (severity === "warning") {
    return "is-warning";
  }
  return "is-info";
}

function formatTopNotificationTime(value) {
  const date = new Date(value);
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

function parseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
