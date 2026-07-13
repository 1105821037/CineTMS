import { getAuthStatus, getRuntimeHalls, getSetupStatus } from "./api.js";
import { closeSidebar, renderHallNavigation, updateActiveNav } from "./layout.js";
import { pageTitles, routes } from "./state.js";
import { initAboutPage } from "./pages/about.js";
import { disposeCinemaPage, initCinemaPage } from "./pages/cinema.js";
import { disposeDcpPage, initDcpPage } from "./pages/dcp.js";
import { disposeFilmPlaybackPage, initFilmPlaybackPage } from "./pages/film-playback.js";
import { disposeFilmSchedulePage, initFilmSchedulePage } from "./pages/film-schedule.js";
import { disposeFilmScheduleMobilePage, initFilmScheduleMobilePage } from "./pages/film-schedule-mobile.js";
import { disposeHomePage, initHomePage } from "./pages/home.js";
import { disposeHallCplPage, initHallCplPage } from "./pages/hall-cpl.js";
import { disposeHallKdmPage, initHallKdmPage } from "./pages/hall-kdm.js";
import { disposeHallLogPage, initHallLogPage } from "./pages/hall-log.js";
import { initKdmPage } from "./pages/kdm.js";
import { initLoginPage } from "./pages/login.js";
import { disposePlaylistEditorPage, initPlaylistEditorPage } from "./pages/playlist-editor.js";
import { initSettingsPage } from "./pages/settings.js";
import { initSetupWizard } from "./pages/setup.js";
import { initUserPage } from "./pages/user.js";

const pageInitializers = {
  "hall-control": initCinemaPage,
  "hall-playlists": initPlaylistEditorPage,
  "hall-cpl": initHallCplPage,
  "hall-kdm": initHallKdmPage,
  "hall-log": initHallLogPage,
  "film-playback": initFilmPlaybackPage,
  "film-schedule": initFilmSchedulePage,
  "film-schedule-mobile": initFilmScheduleMobilePage,
  home: initHomePage,
  dcp: initDcpPage,
  kdm: initKdmPage,
  login: initLoginPage,
  settings: initSettingsPage,
  "settings-storage": initSettingsPage,
  "settings-halls": initSettingsPage,
  "settings-ticketing": initSettingsPage,
  "settings-notifications": initSettingsPage,
  setup: initSetupWizard,
  user: initUserPage,
  about: initAboutPage,
};

const pageDisposers = {
  "hall-control": disposeCinemaPage,
  "hall-playlists": disposePlaylistEditorPage,
  "hall-cpl": disposeHallCplPage,
  "hall-kdm": disposeHallKdmPage,
  "hall-log": disposeHallLogPage,
  "film-playback": disposeFilmPlaybackPage,
  "film-schedule": disposeFilmSchedulePage,
  "film-schedule-mobile": disposeFilmScheduleMobilePage,
  dcp: disposeDcpPage,
  home: disposeHomePage,
};

let currentPage = null;
let currentRoutePage = null;

export function initRouter() {
  window.addEventListener("hashchange", handleRoute);
  window.matchMedia("(max-width: 760px)").addEventListener("change", () => {
    if (currentRoutePage === "film-schedule") {
      void handleRoute();
    }
  });
  void handleRoute();
}

async function handleRoute() {
  let route;
  try {
    route = await resolveRoute();
  } catch (error) {
    renderRouteError(error);
    return;
  }

  if (!route) {
    return;
  }

  const halls = await syncHallNavigation(route);
  await loadPage(route, halls);

  if (window.innerWidth < 768) {
    closeSidebar();
  }
}

function renderRouteError(error) {
  const contentArea = document.getElementById("contentArea");
  const message = error instanceof Error ? error.message : "系统状态加载失败，请稍后重试。";
  if (contentArea) {
    contentArea.innerHTML = `
      <div class="content-fade-in">
        <div class="alert alert-error">
          <i class="fas fa-exclamation-circle"></i>
          <span class="text-sm">${escapeHtml(message)}</span>
        </div>
      </div>
    `;
  }
  document.body.classList.remove("app-booting");
}

async function resolveRoute() {
  const route = parseRoute();
  const setupStatus = await getSetupStatus();
  const setupCompleted = Boolean(setupStatus.completed);
  const hasAccount = Boolean(setupStatus.hasAccount);

  if (!setupCompleted) {
    if (!hasAccount) {
      return redirectUnless(route, "setup");
    }

    const auth = await getAuthStatus();
    if (!auth.authenticated) {
      return redirectUnless(route, "login");
    }

    return redirectUnless(route, "setup");
  }

  const auth = await getAuthStatus();
  if (!auth.authenticated) {
    return redirectUnless(route, "login");
  }

  if (route.page === "login") {
    window.location.replace("#/home");
    return;
  }

  return route;
}

function parseRoute() {
  const hash = window.location.hash.slice(2) || "home";
  const [rawPage, rawHallId] = hash.split("/");
  const page = routes[rawPage] ? rawPage : "home";

  return {
    page,
    hallId: rawHallId ? decodeURIComponent(rawHallId) : null,
  };
}

function redirectUnless(currentRoute, expectedRoute) {
  if (currentRoute.page === expectedRoute) {
    return currentRoute;
  }

  window.location.replace(`#/${expectedRoute}`);
  return null;
}

async function syncHallNavigation(route) {
  if (route.page === "setup" || route.page === "login") {
    renderHallNavigation([], null);
    updateActiveNav(route.page, route);
    return [];
  }

  try {
    const halls = await getRuntimeHalls();
    renderHallNavigation(halls, isHallScopedPage(route.page) ? route.hallId : null);
    updateActiveNav(route.page, route);
    return halls;
  } catch {
    renderHallNavigation([], null);
    updateActiveNav(route.page, route);
    return [];
  }
}

async function loadPage(route, halls) {
  const contentArea = document.getElementById("contentArea");
  const breadcrumb = document.getElementById("breadcrumb");
  const resolvedPage = resolvePageAsset(route);
  document.body.classList.toggle("setup-mode", route.page === "setup" || route.page === "login");

  if (currentPage) {
    pageDisposers[currentPage]?.();
  }

  contentArea.innerHTML = `
    <div class="flex items-center justify-center h-full">
      <span class="loading loading-spinner loading-lg text-primary"></span>
    </div>
  `;

  try {
    const response = await fetch(resolvedPage.path, { cache: "no-cache" });
    if (!response.ok) {
      throw new Error("页面加载失败");
    }

    const html = await response.text();
    contentArea.innerHTML = `<div class="content-fade-in">${html}</div>`;
    breadcrumb.innerHTML = buildBreadcrumb(route, halls);
    updateActiveNav(route.page, route);
    pageInitializers[resolvedPage.key]?.();
    currentPage = resolvedPage.key;
    currentRoutePage = route.page;
    contentArea.scrollTop = 0;
  } catch (error) {
    contentArea.innerHTML = `
      <div class="content-fade-in">
        <div class="alert alert-error">
          <i class="fas fa-exclamation-circle"></i>
          <span class="text-sm">${error instanceof Error ? error.message : "页面加载失败"}</span>
        </div>
      </div>
    `;
  } finally {
    document.body.classList.remove("app-booting");
  }
}

function buildBreadcrumb(route, halls) {
  const items = ['<li><a href="#/home">首页</a></li>'];

  if (isHallScopedPage(route.page)) {
    const hall = halls.find((item) => item.registration.hallId === route.hallId);
    items.push("<li>影厅管理</li>");
    if (hall) {
      items.push(`<li>${escapeHtml(hall.registration.hallName || hall.registration.hallId)}</li>`);
    }
    items.push(`<li>${pageTitles[route.page] || route.page}</li>`);
    return items.join("");
  }

  if (route.page.startsWith("settings")) {
    items.push("<li>系统设置</li>");
    items.push(`<li>${pageTitles[route.page] || route.page}</li>`);
    return items.join("");
  }

  if (route.page === "film-playback" || route.page === "film-schedule") {
    items.push("<li>自动放映</li>");
    items.push(`<li>${pageTitles[route.page] || route.page}</li>`);
    return items.join("");
  }

  items.push(`<li>${pageTitles[route.page] || route.page}</li>`);
  return items.join("");
}

function resolvePageAsset(route) {
  if (route.page === "film-schedule" && window.matchMedia("(max-width: 760px)").matches) {
    return {
      key: "film-schedule-mobile",
      path: "./pages/film-schedule-mobile.html",
    };
  }

  return {
    key: route.page,
    path: routes[route.page],
  };
}

function isHallScopedPage(page) {
  return page === "hall-control" || page === "hall-playlists" || page === "hall-cpl" || page === "hall-kdm" || page === "hall-log";
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
