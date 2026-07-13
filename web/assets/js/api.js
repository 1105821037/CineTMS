import { appState } from "./state.js";

export async function getSetupStatus() {
  if (!appState.setupStatusCache) {
    appState.setupStatusCache = apiGet("/api/setup/status").catch((error) => {
      appState.setupStatusCache = null;
      throw error;
    });
  }

  const status = await appState.setupStatusCache;
  appState.setupDraftCache = status.draft || null;
  return status;
}

export async function getAuthStatus() {
  if (!appState.authStatusCache) {
    appState.authStatusCache = apiGet("/api/auth/me").catch((error) => {
      appState.authStatusCache = null;
      throw error;
    });
  }

  return appState.authStatusCache;
}

export async function getRuntimeHalls(force = false) {
  if (!force && appState.runtimeHallsCache) {
    return appState.runtimeHallsCache;
  }

  appState.runtimeHallsCache = apiGet("/api/runtime/halls")
    .then((payload) => (Array.isArray(payload.halls) ? payload.halls : []))
    .catch((error) => {
      appState.runtimeHallsCache = null;
      throw error;
    });

  return appState.runtimeHallsCache;
}

export async function getNotifications(params = {}) {
  const query = buildQuery(params);
  const payload = await apiGet(`/api/notifications${query}`);
  return Array.isArray(payload.notifications) ? payload.notifications : [];
}

export async function getNotificationSummary() {
  const payload = await apiGet("/api/notifications/summary");
  return payload.summary || {
    total: 0,
    unread: 0,
    active: 0,
    warning: 0,
    error: 0,
    critical: 0,
  };
}

export async function markNotificationRead(id) {
  return apiPost(`/api/notifications/${encodeURIComponent(id)}/read`, {});
}

export async function markAllNotificationsRead() {
  return apiPost("/api/notifications/read-all", {});
}

export async function getActivities(params = {}) {
  const query = buildQuery(params);
  const payload = await apiGet(`/api/activities${query}`);
  return Array.isArray(payload.activities) ? payload.activities : [];
}

export async function apiGet(path) {
  const response = await fetch(path, { cache: "no-cache" });
  return readApiResponse(response);
}

export async function apiPost(path, body) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return readApiResponse(response);
}

export async function apiDelete(path) {
  const response = await fetch(path, { method: "DELETE" });
  return readApiResponse(response);
}

export function openEventStream(path) {
  return new EventSource(path, { withCredentials: true });
}

export function openRealtimeSocket(path = "/api/realtime/ws") {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return new WebSocket(`${protocol}//${window.location.host}${path}`);
}

async function readApiResponse(response) {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok === false) {
    throw new Error(payload.error || `请求失败：HTTP ${response.status}`);
  }
  return payload;
}

function buildQuery(params) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") {
      continue;
    }
    query.set(key, Array.isArray(value) ? value.join(",") : String(value));
  }
  const serialized = query.toString();
  return serialized ? `?${serialized}` : "";
}
