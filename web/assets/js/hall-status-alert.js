const STATUS_CONFIG = {
  info: {
    className: "alert alert-info",
    icon: "fa-circle-info",
  },
  success: {
    className: "alert alert-success",
    icon: "fa-circle-check",
  },
  warning: {
    className: "alert alert-warning",
    icon: "fa-triangle-exclamation",
  },
  error: {
    className: "alert alert-error",
    icon: "fa-circle-xmark",
  },
};

const HALL_OFFLINE_MESSAGES = {
  playlist: "当前影厅设备离线，无法读取播放表、CPL 与自动化命令。",
  cpl: "当前影厅设备离线，无法读取设备内 CPL。",
  kdm: "当前影厅设备离线，无法读取设备内 KDM。",
  log: "当前影厅设备离线，无法读取 GDC 日志。",
};

const HALL_NOT_FOUND_MESSAGE = "未找到当前影厅，请从左侧重新选择影厅。";
const HALL_NOT_FOUND_PATTERNS = [
  /runtime hall not found/i,
  /unknown hall runtime/i,
  /未找到目标影厅/,
];

export function getHallOfflineMessage(section) {
  return HALL_OFFLINE_MESSAGES[section] || "当前影厅设备离线，无法读取设备数据。";
}

export function getHallNotFoundMessage() {
  return HALL_NOT_FOUND_MESSAGE;
}

export function getHallStatusErrorMessage(error, fallback) {
  const message = error instanceof Error ? error.message : String(error || "");
  if (HALL_NOT_FOUND_PATTERNS.some((pattern) => pattern.test(message))) {
    return HALL_NOT_FOUND_MESSAGE;
  }
  return message || fallback;
}

export function renderStatusAlert(node, { type = "info", message = "", icon = "" } = {}) {
  if (!node) {
    return;
  }

  const config = STATUS_CONFIG[type] || STATUS_CONFIG.info;
  node.className = config.className;
  node.innerHTML = `<i class="fas ${icon || config.icon}"></i><span>${escapeHtml(message)}</span>`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
