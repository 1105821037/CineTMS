const MAX_VISIBLE_TOASTS = 4;
const EXIT_ANIMATION_MS = 220;

const toastState = {
  container: null,
  items: [],
};

const toastTypes = {
  success: { icon: "fa-circle-check", title: "操作成功", duration: 2600 },
  error: { icon: "fa-circle-xmark", title: "操作失败", duration: 5600 },
  warning: { icon: "fa-triangle-exclamation", title: "请注意", duration: 4200 },
  info: { icon: "fa-circle-info", title: "提示", duration: 3600 },
  critical: { icon: "fa-circle-exclamation", title: "紧急通知", duration: 0 },
};

export const toast = {
  show,
  success(message, options = {}) {
    return show({ ...options, message, type: "success" });
  },
  error(message, options = {}) {
    return show({ ...options, message, type: "error" });
  },
  warning(message, options = {}) {
    return show({ ...options, message, type: "warning" });
  },
  info(message, options = {}) {
    return show({ ...options, message, type: "info" });
  },
  critical(message, options = {}) {
    return show({ ...options, message, type: "critical" });
  },
  dismiss,
  clear,
};

export function initToast() {
  ensureToastContainer();
}

export function show(options) {
  const normalized = normalizeOptions(options);
  const container = ensureToastContainer();
  const existing = toastState.items.find((item) => item.id === normalized.id);

  if (existing) {
    updateToast(existing, normalized);
    return existing.id;
  }

  const node = createToastNode(normalized);
  const item = {
    id: normalized.id,
    node,
    timer: null,
    remaining: normalized.duration,
    startedAt: 0,
    options: normalized,
    exiting: false,
  };

  toastState.items.push(item);
  container.appendChild(node);
  pruneVisibleToasts();
  scheduleToast(item);

  return item.id;
}

function normalizeOptions(options) {
  const source = typeof options === "string" ? { message: options } : (options || {});
  const type = toastTypes[source.type] ? source.type : "info";
  const message = String(source.message || "").trim();
  const config = toastTypes[type];
  const title = source.title
    ? String(source.title).trim()
    : (message ? "" : config.title);
  const persistent = source.persistent === true || source.duration === 0;
  const duration = persistent
    ? 0
    : (Number.isFinite(source.duration) ? Math.max(0, source.duration) : config.duration);

  return {
    id: source.id || `toast-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    type,
    title,
    message,
    icon: source.icon || config.icon,
    duration,
    action: normalizeAction(source.action),
    dismissible: source.dismissible !== false,
  };
}

function normalizeAction(action) {
  if (!action || typeof action !== "object") {
    return null;
  }

  const label = String(action.label || "").trim();
  if (!label) {
    return null;
  }

  return {
    label,
    href: typeof action.href === "string" ? action.href : "",
    onClick: typeof action.onClick === "function" ? action.onClick : null,
    dismissOnClick: action.dismissOnClick !== false,
  };
}

function ensureToastContainer() {
  if (toastState.container?.isConnected) {
    return toastState.container;
  }

  let container = document.getElementById("appToastContainer");
  if (!container) {
    container = document.createElement("div");
    container.id = "appToastContainer";
    container.className = "app-toast-container";
    container.setAttribute("aria-live", "polite");
    container.setAttribute("aria-atomic", "false");
    document.body.appendChild(container);
  }

  toastState.container = container;
  return container;
}

function createToastNode(options) {
  const node = document.createElement("div");
  node.dataset.toastId = options.id;
  node.addEventListener("mouseenter", () => pauseToast(options.id));
  node.addEventListener("mouseleave", () => resumeToast(options.id));
  node.addEventListener("focusin", () => pauseToast(options.id));
  node.addEventListener("focusout", () => resumeToast(options.id));
  renderToastNode(node, options);
  return node;
}

function renderToastNode(node, options) {
  node.className = `app-toast app-toast-${options.type}`;
  node.setAttribute("role", options.type === "error" || options.type === "critical" ? "alert" : "status");
  node.replaceChildren();

  const icon = document.createElement("span");
  icon.className = "app-toast-icon";
  icon.setAttribute("aria-hidden", "true");
  icon.innerHTML = `<i class="fas ${options.icon}"></i>`;

  const body = document.createElement("span");
  body.className = "app-toast-body";

  if (options.title) {
    const title = document.createElement("span");
    title.className = "app-toast-title";
    title.textContent = options.title;
    body.appendChild(title);
  }

  if (options.message) {
    const message = document.createElement("span");
    message.className = "app-toast-message";
    message.textContent = options.message;
    body.appendChild(message);
  }

  const controls = document.createElement("span");
  controls.className = "app-toast-controls";

  if (options.action) {
    const actionButton = document.createElement("button");
    actionButton.className = "app-toast-action";
    actionButton.type = "button";
    actionButton.textContent = options.action.label;
    actionButton.addEventListener("click", () => {
      options.action.onClick?.();
      if (options.action.href) {
        window.location.href = options.action.href;
      }
      if (options.action.dismissOnClick) {
        dismiss(options.id);
      }
    });
    controls.appendChild(actionButton);
  }

  if (options.dismissible) {
    controls.appendChild(createCloseButton(options.id));
  }

  node.append(icon, body, controls);
}

function createCloseButton(id) {
  const closeButton = document.createElement("button");
  closeButton.className = "app-toast-close";
  closeButton.type = "button";
  closeButton.setAttribute("aria-label", "关闭提示");
  closeButton.innerHTML = '<i class="fas fa-xmark"></i>';
  closeButton.addEventListener("click", () => dismiss(id));
  return closeButton;
}

function updateToast(item, options) {
  item.options = options;
  item.remaining = options.duration;
  item.exiting = false;
  item.node.classList.remove("app-toast-exit");
  item.node.style.maxHeight = "";
  renderToastNode(item.node, options);
  scheduleToast(item);
}

function pruneVisibleToasts() {
  while (toastState.items.length > MAX_VISIBLE_TOASTS) {
    const dismissibleIndex = toastState.items.findIndex((item) => item.options.duration > 0);
    const index = dismissibleIndex >= 0 ? dismissibleIndex : 0;
    dismiss(toastState.items[index].id);
  }
}

function scheduleToast(item) {
  if (item.timer) {
    window.clearTimeout(item.timer);
    item.timer = null;
  }

  if (item.options.duration <= 0) {
    item.remaining = 0;
    item.startedAt = 0;
    return;
  }

  item.remaining = item.remaining > 0 ? item.remaining : item.options.duration;
  item.startedAt = Date.now();
  item.timer = window.setTimeout(() => {
    dismiss(item.id);
  }, item.remaining);
}

function pauseToast(id) {
  const item = toastState.items.find((entry) => entry.id === id);
  if (!item?.timer) {
    return;
  }

  window.clearTimeout(item.timer);
  item.timer = null;
  item.remaining = Math.max(0, item.remaining - (Date.now() - item.startedAt));
}

function resumeToast(id) {
  const item = toastState.items.find((entry) => entry.id === id);
  if (!item || item.timer || item.options.duration <= 0 || item.remaining <= 0) {
    return;
  }

  scheduleToast(item);
}

function dismiss(id) {
  const index = toastState.items.findIndex((item) => item.id === id);
  if (index < 0) {
    return;
  }

  const [item] = toastState.items.splice(index, 1);
  if (item.timer) {
    window.clearTimeout(item.timer);
    item.timer = null;
  }

  animateToastExit(item);
}

function clear() {
  for (const item of [...toastState.items]) {
    dismiss(item.id);
  }
}

function animateToastExit(item) {
  if (!item.node.isConnected) {
    return;
  }

  if (item.exiting) {
    return;
  }

  item.exiting = true;
  const height = item.node.getBoundingClientRect().height;
  item.node.style.maxHeight = `${height}px`;
  item.node.style.pointerEvents = "none";

  window.requestAnimationFrame(() => {
    item.node.classList.add("app-toast-exit");
    item.node.style.maxHeight = "0px";
  });

  window.setTimeout(() => {
    item.node.remove();
  }, EXIT_ANIMATION_MS);
}
