export const routes = {
  setup: "./pages/setup.html",
  login: "./pages/login.html",
  home: "./pages/home.html",
  "hall-control": "./pages/cinema.html",
  "hall-playlists": "./pages/playlist-editor.html",
  "hall-cpl": "./pages/hall-cpl.html",
  "hall-kdm": "./pages/hall-kdm.html",
  "hall-log": "./pages/hall-log.html",
  kdm: "./pages/kdm.html",
  dcp: "./pages/dcp.html",
  "film-playback": "./pages/film-playback.html",
  "film-schedule": "./pages/film-schedule.html",
  settings: "./pages/settings.html",
  "settings-storage": "./pages/settings-storage.html",
  "settings-halls": "./pages/settings-halls.html",
  "settings-ticketing": "./pages/settings-ticketing.html",
  "settings-notifications": "./pages/settings-notifications.html",
  user: "./pages/user.html",
  about: "./pages/about.html",
};

export const pageTitles = {
  login: "登录",
  setup: "设置向导",
  home: "首页",
  "hall-control": "影厅控制",
  "hall-playlists": "播放表编辑",
  "hall-cpl": "CPL 管理",
  "hall-kdm": "KDM 管理",
  "hall-log": "GDC 日志",
  kdm: "KDM 管理",
  dcp: "DCP 管理",
  "film-playback": "影片放映模板",
  "film-schedule": "影片排期",
  settings: "其它设置",
  "settings-storage": "存储库与 FTP",
  "settings-halls": "影厅连接",
  "settings-ticketing": "售票系统连接",
  "settings-notifications": "外部通知",
  user: "用户管理",
  about: "关于系统",
};

export const appState = {
  setupStatusCache: null,
  setupDraftCache: null,
  authStatusCache: null,
  cinemaShowsCache: new Map(),
  runtimeHallsCache: null,
};

export function clearSetupStatusCache() {
  appState.setupStatusCache = null;
  appState.setupDraftCache = null;
}

export function clearRuntimeHallsCache() {
  appState.runtimeHallsCache = null;
}

export function clearAuthenticatedUser() {
  appState.authStatusCache = Promise.resolve({ authenticated: false });
}

export function setAuthenticatedUser(user) {
  appState.authStatusCache = Promise.resolve({
    authenticated: true,
    user,
  });
}
