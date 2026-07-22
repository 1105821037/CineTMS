import { apiGet, apiPost, getRuntimeHalls } from "../api.js";
import { toast } from "../toast.js";

export async function initSettingsPage() {
  const tasks = [];

  if (document.getElementById("miscSettingsRoot")) {
    tasks.push(initMiscSettings());
  }

  if (document.getElementById("storageSettingsRoot")) {
    tasks.push(initStorageSettings());
  }

  if (document.getElementById("ticketingSettingsRoot")) {
    tasks.push(initTicketingSettings());
  }

  if (document.getElementById("hallSettingsRoot")) {
    tasks.push(initHallSettings());
  }

  if (document.getElementById("externalNotificationSettingsRoot")) {
    tasks.push(initExternalNotificationSettings());
  }

  await Promise.all(tasks);
}

// ── External Notification Settings ──────────────────────────────

const notificationSeverityOptions = [
  ["info", "提示"],
  ["warning", "警告"],
  ["error", "错误"],
  ["critical", "严重"],
];

const externalNotificationChannelOptions = [
  ["serverchan-v3", "ServerChan v3"],
  ["serverchan-turbo", "ServerChan Turbo"],
];

const externalNotificationEventTree = [
  {
    key: "all",
    label: "全部通知",
    children: [
      {
        key: "runtime.device",
        label: "设备状态",
        children: [
          { key: "runtime.device.offline", label: "设备离线" },
          { key: "runtime.device.online", label: "设备上线" },
        ],
      },
      {
        key: "runtime.ingest",
        label: "内容导入",
        children: [
          { key: "runtime.ingest.completed", label: "导入完成" },
          { key: "runtime.ingest.failed", label: "导入失败" },
        ],
      },
      {
        key: "ticketing.schedule-auto",
        label: "自动排期",
        children: [
          { key: "ticketing.schedule-auto.added", label: "自动添加排期" },
          { key: "ticketing.schedule-auto.cancelled", label: "自动取消排期" },
          { key: "ticketing.schedule-auto.failed", label: "自动排期失败" },
        ],
      },
      {
        key: "system.film-schedule",
        label: "排期执行",
        children: [
          { key: "system.film-schedule.play-started", label: "开始播放" },
          { key: "system.film-schedule.show-corrected", label: "播放表自动修正" },
          { key: "system.film-schedule.temporary-show", label: "创建临时播放表" },
          { key: "system.film-schedule.action-failed", label: "排程动作失败" },
          { key: "system.film-schedule.failed", label: "排期未执行" },
          { key: "system.film-schedule.monitor-lost", label: "场次监控中断" },
          { key: "system.film-schedule.monitor-timeout", label: "场次监控超时" },
          { key: "system.film-schedule.aborted", label: "场次异常退出" },
        ],
      },
    ],
  },
];

const externalNotificationEventOptions = flattenExternalNotificationEventTree(externalNotificationEventTree);

const externalNotificationState = {
  settings: {
    enabled: true,
    channels: [],
    policies: [],
  },
};

async function initExternalNotificationSettings() {
  bindExternalNotificationEvents();
  renderExternalNotificationLoading();

  try {
    const payload = await apiGet("/api/external-notifications/settings");
    externalNotificationState.settings = normalizeExternalNotificationSettings(payload.settings);
    renderExternalNotificationSettings();
  } catch (error) {
    showError("externalNotificationStatus", errorMessage(error, "加载外部通知设置失败。"));
    externalNotificationState.settings = normalizeExternalNotificationSettings(null);
    renderExternalNotificationSettings();
  }
}

function bindExternalNotificationEvents() {
  const root = document.getElementById("externalNotificationSettingsRoot");
  if (!root || root.dataset.bound === "true") return;
  root.dataset.bound = "true";

  document.getElementById("externalNotificationEnabled")?.addEventListener("change", (event) => {
    externalNotificationState.settings.enabled = Boolean(event.target.checked);
  });
  document.getElementById("externalNotificationSave")?.addEventListener("click", () => void saveExternalNotificationSettings());
  document.getElementById("addExternalNotificationChannel")?.addEventListener("click", addExternalNotificationChannel);
  document.getElementById("addExternalNotificationPolicy")?.addEventListener("click", addExternalNotificationPolicy);

  root.addEventListener("input", (event) => {
    if (!(event.target instanceof HTMLElement)) return;
    handleExternalNotificationInput(event.target);
  });
  root.addEventListener("change", (event) => {
    if (!(event.target instanceof HTMLElement)) return;
    handleExternalNotificationChange(event.target);
  });
  root.addEventListener("click", (event) => {
    if (!(event.target instanceof Element)) return;
    const button = event.target.closest("button");
    if (button instanceof HTMLElement) {
      void handleExternalNotificationButton(button);
    }
  });
}

function renderExternalNotificationLoading() {
  const channels = document.getElementById("externalNotificationChannels");
  const policies = document.getElementById("externalNotificationPolicies");
  const loading = `
    <div class="external-notification-empty">
      <span class="loading loading-spinner loading-sm"></span>
    </div>
  `;
  if (channels) channels.innerHTML = loading;
  if (policies) policies.innerHTML = loading;
}

function normalizeExternalNotificationSettings(settings) {
  return {
    enabled: settings?.enabled !== false,
    channels: Array.isArray(settings?.channels) ? settings.channels.map(normalizeExternalNotificationChannel) : [],
    policies: Array.isArray(settings?.policies) ? settings.policies.map(normalizeExternalNotificationPolicy) : [],
  };
}

function normalizeExternalNotificationChannel(channel) {
  const type = normalizeExternalNotificationChannelType(channel?.type);
  return {
    id: channel?.id || newClientId("channel"),
    name: channel?.name || describeExternalNotificationChannelType(type),
    type,
    enabled: channel?.enabled !== false,
    config: {
      sendKey: channel?.config?.sendKey || "",
    },
    createdAt: channel?.createdAt,
    updatedAt: channel?.updatedAt,
  };
}

function normalizeExternalNotificationChannelType(type) {
  if (type === "serverchan-v3" || type === "serverchan-turbo") {
    return type;
  }
  return "serverchan-v3";
}

function describeExternalNotificationChannelType(type) {
  return type === "serverchan-turbo" ? "ServerChan Turbo" : "ServerChan v3";
}

function getExternalNotificationChannelHelpUrl(type) {
  return type === "serverchan-turbo" ? "https://sct.ftqq.com/" : "https://sc3.ft07.com/";
}

function normalizeExternalNotificationPolicy(policy) {
  const eventKeys = Array.isArray(policy?.eventKeys)
    ? policy.eventKeys.filter((key) => externalNotificationEventOptions.some((item) => item.key === key))
    : [];
  return {
    id: policy?.id || newClientId("policy"),
    name: policy?.name || "未命名策略",
    enabled: policy?.enabled !== false,
    channelIds: Array.isArray(policy?.channelIds) ? [...policy.channelIds] : [],
    eventKeys: eventKeys.length ? eventKeys : ["all"],
    minSeverity: normalizeNotificationSeverity(policy?.minSeverity),
    createdAt: policy?.createdAt,
    updatedAt: policy?.updatedAt,
  };
}

function normalizeNotificationSeverity(severity) {
  return notificationSeverityOptions.some(([value]) => value === severity) ? severity : "warning";
}

function renderExternalNotificationSettings() {
  const enabled = document.getElementById("externalNotificationEnabled");
  if (enabled) enabled.checked = externalNotificationState.settings.enabled;
  renderExternalNotificationChannels();
  renderExternalNotificationPolicies();
}

function renderExternalNotificationChannels() {
  const container = document.getElementById("externalNotificationChannels");
  if (!container) return;

  const channels = externalNotificationState.settings.channels;
  if (channels.length === 0) {
    container.innerHTML = `
      <div class="external-notification-empty">
        <span>暂无通知渠道</span>
      </div>
    `;
    return;
  }

  container.innerHTML = channels.map((channel) => `
    <article class="external-notification-item" data-channel-id="${escapeHtml(channel.id)}">
      <div class="external-notification-item-head">
        <div class="external-notification-item-title">
          <i class="fas fa-paper-plane"></i>
          <span>${escapeHtml(channel.name || describeExternalNotificationChannelType(channel.type))}</span>
          <span class="badge badge-sm">${escapeHtml(describeExternalNotificationChannelType(channel.type))}</span>
          <span class="badge badge-sm">${channel.enabled ? "启用" : "禁用"}</span>
        </div>
        <input type="checkbox" class="toggle toggle-primary toggle-sm" data-channel-enabled ${channel.enabled ? "checked" : ""}>
      </div>
      <div class="external-notification-form-grid">
        <label class="external-notification-field">
          <span>渠道名称</span>
          <input class="input input-bordered input-sm" data-channel-field="name" value="${escapeHtml(channel.name)}" autocomplete="off">
        </label>
        <label class="external-notification-field">
          <span>通知渠道</span>
          <select class="select select-bordered select-sm" data-channel-field="type">
            ${externalNotificationChannelOptions.map(([value, label]) => `
              <option value="${escapeHtml(value)}" ${channel.type === value ? "selected" : ""}>${escapeHtml(label)}</option>
            `).join("")}
          </select>
          <a class="external-notification-help-link" href="${escapeHtml(getExternalNotificationChannelHelpUrl(channel.type))}" target="_blank" rel="noopener noreferrer">
            <i class="fas fa-arrow-up-right-from-square"></i>
            打开${escapeHtml(describeExternalNotificationChannelType(channel.type))}官网
          </a>
        </label>
        <label class="external-notification-field">
          <span>Key</span>
          <input class="input input-bordered input-sm" data-channel-field="sendKey" value="${escapeHtml(channel.config.sendKey)}" autocomplete="off" placeholder="${channel.type === "serverchan-v3" ? "sctp... 格式 SendKey" : "ServerChan Turbo SendKey"}">
        </label>
      </div>
      <div class="external-notification-actions">
        <button class="btn btn-ghost btn-sm" type="button" data-channel-test="${escapeHtml(channel.id)}">
          <i class="fas fa-vial"></i>
          测试
        </button>
        <button class="btn btn-ghost btn-sm text-error" type="button" data-channel-delete="${escapeHtml(channel.id)}">
          <i class="fas fa-trash"></i>
        </button>
      </div>
    </article>
  `).join("");
}

function renderExternalNotificationPolicies() {
  const container = document.getElementById("externalNotificationPolicies");
  if (!container) return;

  const policies = externalNotificationState.settings.policies;
  if (policies.length === 0) {
    container.innerHTML = `
      <div class="external-notification-empty">
        <span>暂无通知策略</span>
      </div>
    `;
    return;
  }

  container.innerHTML = policies.map((policy) => `
    <article class="external-notification-item" data-policy-id="${escapeHtml(policy.id)}">
      <div class="external-notification-item-head">
        <div class="external-notification-item-title">
          <i class="fas fa-filter"></i>
          <span>${escapeHtml(policy.name || "未命名策略")}</span>
          <span class="badge badge-sm">${escapeHtml(describeExternalNotificationPolicyEvents(policy.eventKeys))}</span>
          <span class="badge badge-sm">${policy.enabled ? "启用" : "禁用"}</span>
        </div>
        <input type="checkbox" class="toggle toggle-primary toggle-sm" data-policy-enabled ${policy.enabled ? "checked" : ""}>
      </div>
      <div class="external-notification-form-grid">
        <label class="external-notification-field">
          <span>策略名称</span>
          <input class="input input-bordered input-sm" data-policy-field="name" value="${escapeHtml(policy.name)}" autocomplete="off">
        </label>
        <label class="external-notification-field">
          <span>最低级别</span>
          <select class="select select-bordered select-sm" data-policy-field="minSeverity">
            ${notificationSeverityOptions.map(([value, label]) => `
              <option value="${escapeHtml(value)}" ${policy.minSeverity === value ? "selected" : ""}>${escapeHtml(label)}</option>
            `).join("")}
          </select>
        </label>
      </div>
      ${renderExternalNotificationEventTree(policy)}
      ${renderExternalNotificationChannelChecks(policy)}
      <div class="external-notification-actions">
        <button class="btn btn-ghost btn-sm text-error" type="button" data-policy-delete="${escapeHtml(policy.id)}">
          <i class="fas fa-trash"></i>
        </button>
      </div>
    </article>
  `).join("");
  syncExternalNotificationEventTreeState();
}

function renderExternalNotificationChannelChecks(policy) {
  const channels = externalNotificationState.settings.channels;
  return `
    <div class="external-notification-field">
      <span>转发渠道</span>
      <div class="external-notification-check-grid">
        ${channels.length === 0 ? '<span class="text-xs text-base-content/55">暂无可选渠道</span>' : channels.map((channel) => `
          <label>
            <input type="checkbox" class="checkbox checkbox-xs" data-policy-channel="${escapeHtml(channel.id)}" ${policy.channelIds.includes(channel.id) ? "checked" : ""}>
            ${escapeHtml(channel.name || describeExternalNotificationChannelType(channel.type))}
          </label>
        `).join("")}
      </div>
    </div>
  `;
}

function renderExternalNotificationEventTree(policy) {
  return `
    <div class="external-notification-field">
      <span>事件选择</span>
      <div class="external-notification-event-tree">
        ${externalNotificationEventTree.map((node) => renderExternalNotificationEventNode(node, policy.eventKeys, 0)).join("")}
      </div>
    </div>
  `;
}

function renderExternalNotificationEventNode(node, selectedKeys, depth) {
  const hasChildren = Array.isArray(node.children) && node.children.length > 0;
  const checked = isExternalNotificationEventNodeChecked(node, selectedKeys);
  const depthClass = `is-depth-${Math.min(Math.max(Number(depth) || 0, 0), 2)}`;
  return `
    <div class="external-notification-event-node ${depthClass}">
      <label>
        <input type="checkbox" class="checkbox checkbox-xs" data-policy-event="${escapeHtml(node.key)}" ${checked ? "checked" : ""}>
        <span>${escapeHtml(node.label)}</span>
      </label>
    </div>
    ${hasChildren ? node.children.map((child) => renderExternalNotificationEventNode(child, selectedKeys, depth + 1)).join("") : ""}
  `;
}

function handleExternalNotificationInput(target) {
  const channelId = target.closest("[data-channel-id]")?.dataset.channelId;
  if (channelId && target.dataset.channelField) {
    const channel = findExternalNotificationChannel(channelId);
    if (!channel) return;
    if (target.dataset.channelField === "sendKey") {
      channel.config.sendKey = target.value;
    } else if (target.dataset.channelField === "type") {
      channel.type = normalizeExternalNotificationChannelType(target.value);
      if (!channel.name || externalNotificationChannelOptions.some(([, label]) => label === channel.name)) {
        channel.name = describeExternalNotificationChannelType(channel.type);
      }
    } else {
      channel[target.dataset.channelField] = target.value;
    }
    return;
  }

  const policyId = target.closest("[data-policy-id]")?.dataset.policyId;
  if (policyId && target.dataset.policyField) {
    const policy = findExternalNotificationPolicy(policyId);
    if (!policy) return;
    policy[target.dataset.policyField] = target.value;
  }
}

function handleExternalNotificationChange(target) {
  const channelId = target.closest("[data-channel-id]")?.dataset.channelId;
  if (channelId && target.dataset.channelField) {
    handleExternalNotificationInput(target);
    if (target.dataset.channelField === "type") {
      renderExternalNotificationSettings();
    }
    return;
  }

  if (channelId && target.dataset.channelEnabled !== undefined) {
    const channel = findExternalNotificationChannel(channelId);
    if (channel) {
      channel.enabled = target.checked;
      renderExternalNotificationChannels();
    }
    return;
  }

  const policyId = target.closest("[data-policy-id]")?.dataset.policyId;
  if (!policyId) return;
  const policy = findExternalNotificationPolicy(policyId);
  if (!policy) return;

  if (target.dataset.policyEnabled !== undefined) {
    policy.enabled = target.checked;
    renderExternalNotificationPolicies();
  } else if (target.dataset.policyChannel) {
    toggleListValue(policy.channelIds, target.dataset.policyChannel, target.checked);
  } else if (target.dataset.policyEvent) {
    togglePolicyEventKey(policy, target.dataset.policyEvent, target.checked);
    renderExternalNotificationPolicies();
  } else if (target.dataset.policyField) {
    handleExternalNotificationInput(target);
    renderExternalNotificationPolicies();
  }
}

async function handleExternalNotificationButton(button) {
  if (button.dataset.channelDelete) {
    deleteExternalNotificationChannel(button.dataset.channelDelete);
  } else if (button.dataset.policyDelete) {
    deleteExternalNotificationPolicy(button.dataset.policyDelete);
  } else if (button.dataset.channelTest) {
    await testExternalNotificationChannel(button.dataset.channelTest, button);
  }
}

function addExternalNotificationChannel() {
  externalNotificationState.settings.channels.push({
    id: newClientId("channel"),
    name: "ServerChan v3",
    type: "serverchan-v3",
    enabled: true,
    config: { sendKey: "" },
  });
  renderExternalNotificationSettings();
}

function addExternalNotificationPolicy() {
  const firstChannel = externalNotificationState.settings.channels[0]?.id;
  externalNotificationState.settings.policies.push({
    id: newClientId("policy"),
    name: "关键故障通知",
    enabled: true,
    channelIds: firstChannel ? [firstChannel] : [],
    eventKeys: ["runtime.device.offline", "system.film-schedule.aborted"],
    minSeverity: "error",
  });
  renderExternalNotificationPolicies();
}

function deleteExternalNotificationChannel(channelId) {
  externalNotificationState.settings.channels = externalNotificationState.settings.channels.filter((channel) => channel.id !== channelId);
  externalNotificationState.settings.policies = externalNotificationState.settings.policies.map((policy) => ({
    ...policy,
    channelIds: policy.channelIds.filter((id) => id !== channelId),
  }));
  renderExternalNotificationSettings();
}

function deleteExternalNotificationPolicy(policyId) {
  externalNotificationState.settings.policies = externalNotificationState.settings.policies.filter((policy) => policy.id !== policyId);
  renderExternalNotificationPolicies();
}

async function saveExternalNotificationSettings() {
  const button = document.getElementById("externalNotificationSave");
  const original = button?.innerHTML || "";
  hideExternalNotificationStatus();
  if (button) {
    button.disabled = true;
    button.innerHTML = '<span class="loading loading-spinner loading-sm"></span> 保存中';
  }

  try {
    const payload = await apiPost("/api/external-notifications/settings", externalNotificationState.settings);
    externalNotificationState.settings = normalizeExternalNotificationSettings(payload.settings);
    renderExternalNotificationSettings();
    toast.success("外部通知设置已保存。");
  } catch (error) {
    showError("externalNotificationStatus", errorMessage(error, "保存外部通知设置失败。"));
  } finally {
    if (button) {
      button.disabled = false;
      button.innerHTML = original;
    }
  }
}

async function testExternalNotificationChannel(channelId, button) {
  const channel = findExternalNotificationChannel(channelId);
  if (!channel) return;
  hideExternalNotificationStatus();

  const original = button.innerHTML;
  button.disabled = true;
  button.innerHTML = '<span class="loading loading-spinner loading-xs"></span> 测试中';

  try {
    await apiPost("/api/external-notifications/test", { channel });
    toast.success("测试通知已发送。");
  } catch (error) {
    showError("externalNotificationStatus", errorMessage(error, "测试发送失败。"));
  } finally {
    button.disabled = false;
    button.innerHTML = original;
  }
}

function findExternalNotificationChannel(channelId) {
  return externalNotificationState.settings.channels.find((channel) => channel.id === channelId);
}

function findExternalNotificationPolicy(policyId) {
  return externalNotificationState.settings.policies.find((policy) => policy.id === policyId);
}

function toggleListValue(list, value, checked) {
  const index = list.indexOf(value);
  if (checked && index === -1) {
    list.push(value);
  } else if (!checked && index !== -1) {
    list.splice(index, 1);
  }
}

function togglePolicyEventKey(policy, eventKey, checked) {
  const node = findExternalNotificationEventNode(externalNotificationEventTree, eventKey);
  if (!node) return;

  if (checked && node.key === "all") {
    policy.eventKeys = ["all"];
    return;
  }

  const selectedKeys = policy.eventKeys.includes("all")
    ? collectExternalNotificationEventKeys(externalNotificationEventTree[0])
    : policy.eventKeys.filter((key) => externalNotificationEventOptions.some((item) => item.key === key));
  const affectedKeys = collectExternalNotificationEventKeys(node);

  if (checked) {
    affectedKeys.forEach((key) => toggleListValue(selectedKeys, key, true));
  } else {
    const removedKeys = new Set([
      ...affectedKeys,
      ...collectExternalNotificationEventAncestorKeys(eventKey),
    ]);
    policy.eventKeys = selectedKeys.filter((key) => !removedKeys.has(key));
    return;
  }

  policy.eventKeys = compactExternalNotificationEventKeys(selectedKeys);
}

function newClientId(prefix) {
  const id = window.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${prefix}-${id}`;
}

function hideExternalNotificationStatus() {
  document.getElementById("externalNotificationStatus")?.classList.add("hidden");
}

function flattenExternalNotificationEventTree(nodes) {
  return nodes.flatMap((node) => [
    { key: node.key, label: node.label },
    ...flattenExternalNotificationEventTree(node.children || []),
  ]);
}

function findExternalNotificationEventNode(nodes, eventKey) {
  for (const node of nodes) {
    if (node.key === eventKey) {
      return node;
    }
    const child = findExternalNotificationEventNode(node.children || [], eventKey);
    if (child) {
      return child;
    }
  }
  return null;
}

function collectExternalNotificationEventKeys(node) {
  return [
    node.key,
    ...(node.children || []).flatMap((child) => collectExternalNotificationEventKeys(child)),
  ];
}

function collectExternalNotificationEventAncestorKeys(eventKey, nodes = externalNotificationEventTree, ancestors = []) {
  for (const node of nodes) {
    if (node.key === eventKey) {
      return ancestors;
    }
    const childAncestors = collectExternalNotificationEventAncestorKeys(
      eventKey,
      node.children || [],
      [...ancestors, node.key],
    );
    if (childAncestors.length > 0) {
      return childAncestors;
    }
  }
  return [];
}

function compactExternalNotificationEventKeys(eventKeys) {
  const validKeys = [...new Set(eventKeys)]
    .filter((key) => externalNotificationEventOptions.some((item) => item.key === key));
  const allKeys = collectExternalNotificationEventKeys(externalNotificationEventTree[0]);
  if (validKeys.includes("all") || allKeys.every((key) => validKeys.includes(key))) {
    return ["all"];
  }
  return validKeys;
}

function isExternalNotificationEventNodeChecked(node, selectedKeys) {
  if (!Array.isArray(selectedKeys) || selectedKeys.includes("all")) {
    return true;
  }
  if (selectedKeys.includes(node.key)) {
    return true;
  }
  if (collectExternalNotificationEventAncestorKeys(node.key).some((key) => selectedKeys.includes(key))) {
    return true;
  }
  const children = node.children || [];
  return children.length > 0 && children.every((child) => isExternalNotificationEventNodeChecked(child, selectedKeys));
}

function isExternalNotificationEventNodeIndeterminate(node, selectedKeys) {
  const children = node.children || [];
  if (children.length === 0 || isExternalNotificationEventNodeChecked(node, selectedKeys)) {
    return false;
  }
  return children.some((child) => (
    isExternalNotificationEventNodeChecked(child, selectedKeys)
    || isExternalNotificationEventNodeIndeterminate(child, selectedKeys)
  ));
}

function syncExternalNotificationEventTreeState() {
  document.querySelectorAll("#externalNotificationPolicies [data-policy-event]").forEach((input) => {
    if (!(input instanceof HTMLInputElement)) return;
    const policyId = input.closest("[data-policy-id]")?.dataset.policyId;
    const policy = findExternalNotificationPolicy(policyId);
    const node = findExternalNotificationEventNode(externalNotificationEventTree, input.dataset.policyEvent);
    input.checked = Boolean(policy && node && isExternalNotificationEventNodeChecked(node, policy.eventKeys));
    input.indeterminate = Boolean(policy && node && isExternalNotificationEventNodeIndeterminate(node, policy.eventKeys));
  });
}

function describeExternalNotificationPolicyEvents(eventKeys) {
  const compactedEventKeys = compactExternalNotificationEventKeys(Array.isArray(eventKeys) ? eventKeys : []);
  if (compactedEventKeys.includes("all")) {
    return "全部通知";
  }
  if (compactedEventKeys.length === 0) {
    return "未选择事件";
  }

  const labels = compactedEventKeys
    .map((key) => externalNotificationEventOptions.find((item) => item.key === key)?.label || key)
    .filter(Boolean);
  if (labels.length <= 2) {
    return labels.join("、");
  }
  return `${labels.slice(0, 2).join("、")} 等 ${labels.length} 项`;
}

// ── Misc Settings ──────────────────────────────────────────────

const miscSettingsItems = [
  {
    key: "hideDangerousAutomationCommands",
    label: "过滤危险自动化指令",
    desc: "隐藏高风险自动化标签（火警、GPI/GPO 等），防止在运行时页面误触发。",
    type: "toggle",
  },
  {
    key: "autoCorrectShowUuid",
    label: "尝试自动修正放映表",
    desc: "排期载入播放表失败时，优先在 GDC 内寻找与快照 CPL 和命令一致的播放表并改用它。",
    type: "toggle",
  },
  {
    key: "allowTemporaryShow",
    label: "未找到放映表时允许使用临时放映表",
    desc: "排期载入播放表失败且快照中的 CPL 和自动化命令可用时，允许临时创建播放表继续执行排期。",
    type: "toggle",
  },
];

async function initMiscSettings() {
  renderMiscSettings();

  try {
    const settings = await apiGet("/api/system/settings");
    setChecked("setting_hideDangerousAutomationCommands", Boolean(settings.automation?.hideDangerousCommands));
    setChecked("setting_autoCorrectShowUuid", Boolean(settings.filmScheduler?.recovery?.autoCorrectShowUuid));
    setChecked("setting_allowTemporaryShow", Boolean(settings.filmScheduler?.recovery?.allowTemporaryShow));
    const usernameInput = document.getElementById("zyhxKdmUsername");
    const passwordInput = document.getElementById("zyhxKdmPassword");
    const status = document.getElementById("zyhxKdmAccountStatus");
    if (usernameInput) usernameInput.value = settings.zyhxKdm?.username || "";
    if (passwordInput) passwordInput.placeholder = settings.zyhxKdm?.hasPassword ? "已保存，留空则不修改" : "请输入中影华夏密码";
    if (status) status.textContent = settings.zyhxKdm?.hasPassword ? "已配置" : "未配置";
  } catch (error) {
    showError("miscSettingsStatus", errorMessage(error, "加载设置失败。"));
  }
}

function renderMiscSettings() {
  const container = document.getElementById("miscSettingsList");
  if (!container) return;

  container.innerHTML = miscSettingsItems.map((item) => {
    if (item.type === "toggle") {
      return `
        <div class="misc-settings-item">
          <div class="misc-settings-copy">
            <div class="item-label">${escapeHtml(item.label)}</div>
            <div class="item-desc">${escapeHtml(item.desc)}</div>
          </div>
          <input type="checkbox" id="setting_${item.key}" class="toggle toggle-primary" data-setting-key="${item.key}">
        </div>
      `;
    }
    return "";
  }).join("") + `
    <form id="zyhxKdmAccountForm" class="misc-settings-item misc-settings-account">
      <div class="misc-settings-copy">
        <div class="item-label">中影华夏密钥账户</div>
        <div class="item-desc">用于在 KDM 管理页拉取、搜索和下载中影华夏密钥包。（测试功能）</div>
      </div>
      <div class="misc-settings-account-fields">
        <input id="zyhxKdmUsername" class="input input-bordered input-sm" autocomplete="off" placeholder="账号">
        <input id="zyhxKdmPassword" class="input input-bordered input-sm" type="password" autocomplete="new-password" placeholder="密码">
        <div class="misc-settings-account-actions">
          <span id="zyhxKdmAccountStatus" class="text-xs text-base-content/55">未配置</span>
          <button id="zyhxKdmAccountSave" type="submit" class="btn btn-primary btn-sm">
            <i class="fas fa-floppy-disk"></i>
            保存
          </button>
        </div>
      </div>
    </form>
  `;

  container.querySelectorAll("[data-setting-key]").forEach((toggle) => {
    toggle.addEventListener("change", () => void saveMiscSetting(toggle.dataset.settingKey, toggle.checked));
  });

  document.getElementById("zyhxKdmAccountForm")?.addEventListener("submit", (event) => {
    event.preventDefault();
    void saveZyhxKdmAccount();
  });
}

async function saveMiscSetting(key, value) {
  const toggle = document.querySelector(`[data-setting-key="${key}"]`);
  if (toggle) toggle.disabled = true;

  try {
    await apiPost("/api/system/settings", { [key]: value });
  } catch (error) {
    if (toggle) toggle.checked = !value;
    showError("miscSettingsStatus", errorMessage(error, "保存失败。"));
  } finally {
    if (toggle) toggle.disabled = false;
  }
}

async function saveZyhxKdmAccount() {
  const usernameInput = document.getElementById("zyhxKdmUsername");
  const passwordInput = document.getElementById("zyhxKdmPassword");
  const button = document.getElementById("zyhxKdmAccountSave");
  const status = document.getElementById("zyhxKdmAccountStatus");
  const username = usernameInput?.value.trim() || "";
  const password = passwordInput?.value || "";

  if (!username) {
    showError("miscSettingsStatus", "请填写中影华夏账号。");
    return;
  }

  const original = button?.innerHTML || "";
  if (button) {
    button.disabled = true;
    button.innerHTML = '<span class="loading loading-spinner loading-sm"></span> 保存中';
  }

  try {
    const payload = { zyhxKdmUsername: username };
    if (password) payload.zyhxKdmPassword = password;
    await apiPost("/api/system/settings", payload);
    if (passwordInput) {
      passwordInput.value = "";
      passwordInput.placeholder = "已保存，留空则不修改";
    }
    if (status) status.textContent = "已配置";
    toast.success("中影华夏密钥账户已保存。");
  } catch (error) {
    showError("miscSettingsStatus", errorMessage(error, "保存失败。"));
  } finally {
    if (button) {
      button.disabled = false;
      button.innerHTML = original;
    }
  }
}

// ── Storage Settings ──────────────────────────────────────────────

const repositoryPickerState = {
  currentPath: "",
  displayPath: "",
  rootPath: "",
  parentPath: null,
  selectable: false,
  highlightPath: "",
  entries: [],
};

async function initStorageSettings() {
  const form = document.getElementById("storageForm");
  if (form && form.dataset.bound !== "true") {
    form.dataset.bound = "true";
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      void saveStorageSettings();
    });
  }

  bindStorageAccessMode();
  bindStorageCopyButton();
  bindRepositoryPicker();

  try {
    const payload = await apiGet("/api/system/settings");
    const repositoryInput = document.getElementById("repositoryPath");
    if (repositoryInput) repositoryInput.value = payload.repositoryPath || "";
    const projectorHostInput = document.getElementById("projectorAccessHost");
    if (projectorHostInput) projectorHostInput.value = payload.projectorAccessHost || "";
    setStorageAccessMode(payload.projectorAccessHost ? "manual" : "auto");
    renderRepositoryCapacity(payload.repositoryCapacity);
    renderFtpStatus(payload.ftp, payload.projectorAccessHost, payload.repositoryCapacity);
  } catch (error) {
    renderRepositoryCapacity(null);
    renderFtpStatus(null);
    showError("systemSettingsStatus", errorMessage(error, "加载系统设置失败。"));
  }
}

async function saveStorageSettings() {
  const repositoryPath = document.getElementById("repositoryPath")?.value.trim() || "";
  const accessMode = document.querySelector('input[name="storageAccessMode"]:checked')?.value || "auto";
  const projectorAccessHost = accessMode === "manual"
    ? document.getElementById("projectorAccessHost")?.value.trim() || ""
    : "";
  if (!repositoryPath && !projectorAccessHost) return;
  if (projectorAccessHost && !isValidProjectorAccessHost(projectorAccessHost)) {
    toast.warning("放映机访问地址需为 IPv4 地址或域名。", { title: "地址格式不正确" });
    return;
  }

  const btn = document.getElementById("storageSubmit");
  const original = btn?.innerHTML || "";
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<span class="loading loading-spinner loading-sm"></span> 保存中';
  }

  try {
    const payload = await apiPost("/api/system/settings", { repositoryPath, projectorAccessHost });
    const repositoryInput = document.getElementById("repositoryPath");
    if (repositoryInput) repositoryInput.value = payload.repositoryPath || repositoryPath;
    const projectorHostInput = document.getElementById("projectorAccessHost");
    if (projectorHostInput) projectorHostInput.value = payload.projectorAccessHost || "";
    setStorageAccessMode(payload.projectorAccessHost ? "manual" : "auto");
    renderRepositoryCapacity(payload.repositoryCapacity);
    renderFtpStatus(payload.ftp, payload.projectorAccessHost, payload.repositoryCapacity);
    if (payload.warning) {
      showError("systemSettingsStatus", payload.warning);
    }
  } catch (error) {
    showError("systemSettingsStatus", errorMessage(error, "保存系统设置失败。"));
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = original;
    }
  }
}

function bindStorageAccessMode() {
  document.querySelectorAll('input[name="storageAccessMode"]').forEach((radio) => {
    if (radio.dataset.bound === "true") return;
    radio.dataset.bound = "true";
    radio.addEventListener("change", () => syncStorageAccessMode());
  });
  syncStorageAccessMode();
}

function setStorageAccessMode(mode) {
  const selected = mode === "manual" ? "manual" : "auto";
  const radio = document.querySelector(`input[name="storageAccessMode"][value="${selected}"]`);
  if (radio) radio.checked = true;
  syncStorageAccessMode();
}

function syncStorageAccessMode() {
  const mode = document.querySelector('input[name="storageAccessMode"]:checked')?.value || "auto";
  const input = document.getElementById("projectorAccessHost");
  const field = input?.closest(".storage-host-field");
  if (!input || !field) return;

  const isManual = mode === "manual";
  input.disabled = !isManual;
  input.placeholder = isManual ? "" : "由服务自动检测";
  field.classList.toggle("is-disabled", !isManual);
}

function isValidProjectorAccessHost(value) {
  return isValidIpv4Address(value) || isValidDomainName(value);
}

function isValidIpv4Address(value) {
  const parts = value.split(".");
  if (parts.length !== 4) return false;

  return parts.every((part) => {
    if (!/^\d{1,3}$/.test(part)) return false;
    if (part.length > 1 && part.startsWith("0")) return false;
    const octet = Number(part);
    return Number.isInteger(octet) && octet >= 0 && octet <= 255;
  });
}

function isValidDomainName(value) {
  if (value.length > 253 || value.includes("..")) return false;

  const normalized = value.endsWith(".") ? value.slice(0, -1) : value;
  if (!normalized.includes(".")) return false;

  return normalized.split(".").every((label) => (
    label.length >= 1
    && label.length <= 63
    && /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label)
  ));
}

function bindStorageCopyButton() {
  const button = document.getElementById("ftpCopyEndpoint");
  if (!button || button.dataset.bound === "true") return;

  button.dataset.bound = "true";
  button.addEventListener("click", async () => {
    const endpoint = button.dataset.endpoint || "";
    if (!endpoint) return;

    const original = button.innerHTML;
    try {
      await copyText(endpoint);
      button.innerHTML = '<i class="fas fa-check"></i>已复制';
      window.setTimeout(() => {
        button.innerHTML = original;
      }, 1400);
    } catch {
      button.innerHTML = '<i class="fas fa-triangle-exclamation"></i>复制失败';
      window.setTimeout(() => {
        button.innerHTML = original;
      }, 1400);
    }
  });
}

function bindRepositoryPicker() {
  const openButton = document.getElementById("openRepositoryPicker");
  const modal = document.getElementById("repositoryPickerModal");
  if (!openButton || !modal || modal.dataset.bound === "true") return;

  modal.dataset.bound = "true";
  openButton.addEventListener("click", () => {
    void openRepositoryPicker();
  });

  modal.querySelectorAll("[data-picker-close]").forEach((button) => {
    button.addEventListener("click", closeRepositoryPicker);
  });

  document.getElementById("repositoryPickerRoot")?.addEventListener("click", () => {
    if (repositoryPickerState.rootPath) {
      void loadRepositoryPickerDirectory(repositoryPickerState.rootPath);
    }
  });
  document.getElementById("repositoryPickerUp")?.addEventListener("click", () => {
    if (repositoryPickerState.parentPath) {
      void loadRepositoryPickerDirectory(repositoryPickerState.parentPath);
    }
  });
  document.getElementById("repositoryPickerNewFolder")?.addEventListener("click", showRepositoryCreateForm);
  document.getElementById("repositoryPickerCreateCancel")?.addEventListener("click", hideRepositoryCreateForm);
  document.getElementById("repositoryPickerCreateConfirm")?.addEventListener("click", () => {
    void createRepositoryFolder();
  });
  document.getElementById("repositoryPickerFolderName")?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void createRepositoryFolder();
    }
  });
  document.getElementById("repositoryPickerUse")?.addEventListener("click", () => {
    if (!repositoryPickerState.currentPath) return;
    const input = document.getElementById("repositoryPath");
    if (input) input.value = repositoryPickerState.currentPath;
    closeRepositoryPicker();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !modal.classList.contains("hidden")) {
      closeRepositoryPicker();
    }
  });
}

async function openRepositoryPicker() {
  const modal = document.getElementById("repositoryPickerModal");
  if (!modal) return;

  modal.classList.remove("hidden");
  const currentPath = document.getElementById("repositoryPath")?.value.trim() || "";
  hideRepositoryCreateForm();
  await loadRepositoryPickerDirectory(currentPath);
}

function closeRepositoryPicker() {
  document.getElementById("repositoryPickerModal")?.classList.add("hidden");
  hideRepositoryCreateForm();
}

async function loadRepositoryPickerDirectory(path) {
  const list = document.getElementById("repositoryPickerList");
  if (!list) return;

  list.innerHTML = `
    <div class="storage-picker-empty">
      <span class="loading loading-spinner loading-sm"></span>
      正在读取目录
    </div>
  `;

  try {
    const query = path ? `?path=${encodeURIComponent(path)}` : "";
    const payload = await apiGet(`/api/system/directories${query}`);
    repositoryPickerState.currentPath = payload.path || "";
    repositoryPickerState.displayPath = payload.displayPath || payload.path || "";
    repositoryPickerState.rootPath = payload.rootPath || "";
    repositoryPickerState.parentPath = payload.parentPath || null;
    repositoryPickerState.selectable = Boolean(payload.selectable);
    repositoryPickerState.entries = Array.isArray(payload.entries) ? payload.entries : [];
    if (!repositoryPickerState.entries.some((entry) => entry.path === repositoryPickerState.highlightPath)) {
      repositoryPickerState.highlightPath = "";
    }
    hideRepositoryCreateForm();
    renderRepositoryPicker();
  } catch (error) {
    repositoryPickerState.currentPath = path || "";
    repositoryPickerState.displayPath = path || "";
    repositoryPickerState.rootPath = "";
    repositoryPickerState.parentPath = null;
    repositoryPickerState.selectable = false;
    repositoryPickerState.highlightPath = "";
    repositoryPickerState.entries = [];
    renderRepositoryPicker(errorMessage(error, "读取目录失败。"));
  }
}

function showRepositoryCreateForm() {
  const form = document.getElementById("repositoryPickerCreate");
  const input = document.getElementById("repositoryPickerFolderName");
  if (!form || !input || !repositoryPickerState.currentPath) return;

  form.classList.remove("hidden");
  input.value = "";
  input.focus();
}

function hideRepositoryCreateForm() {
  const form = document.getElementById("repositoryPickerCreate");
  const input = document.getElementById("repositoryPickerFolderName");
  form?.classList.add("hidden");
  if (input) input.value = "";
}

async function createRepositoryFolder() {
  const input = document.getElementById("repositoryPickerFolderName");
  const button = document.getElementById("repositoryPickerCreateConfirm");
  const name = input?.value.trim() || "";
  if (!name || !repositoryPickerState.currentPath) return;

  const original = button?.innerHTML || "";
  if (button) {
    button.disabled = true;
    button.innerHTML = '<span class="loading loading-spinner loading-xs"></span> 创建中';
  }

  try {
    const payload = await apiPost("/api/system/directories", {
      parentPath: repositoryPickerState.currentPath,
      name,
    });
    repositoryPickerState.highlightPath = payload.createdPath || "";
    hideRepositoryCreateForm();
    await loadRepositoryPickerDirectory(repositoryPickerState.currentPath);
  } catch (error) {
    renderRepositoryPicker(errorMessage(error, "创建文件夹失败。"));
  } finally {
    if (button) {
      button.disabled = false;
      button.innerHTML = original;
    }
  }
}

function renderRepositoryPicker(errorText = "") {
  const currentLabel = document.getElementById("repositoryPickerCurrentLabel");
  const currentPath = document.getElementById("repositoryPickerCurrentPath");
  const list = document.getElementById("repositoryPickerList");
  const rootButton = document.getElementById("repositoryPickerRoot");
  const upButton = document.getElementById("repositoryPickerUp");
  const useButton = document.getElementById("repositoryPickerUse");
  const createButton = document.getElementById("repositoryPickerNewFolder");
  if (!currentLabel || !currentPath || !list || !rootButton || !upButton || !useButton || !createButton) return;

  currentLabel.textContent = "当前位置";
  currentPath.textContent = repositoryPickerState.displayPath || repositoryPickerState.currentPath || "正在读取当前仓库目录";
  rootButton.disabled = !repositoryPickerState.rootPath || repositoryPickerState.rootPath === repositoryPickerState.currentPath;
  upButton.disabled = !repositoryPickerState.parentPath;
  useButton.disabled = !repositoryPickerState.selectable;
  createButton.disabled = !repositoryPickerState.currentPath || repositoryPickerState.currentPath === repositoryPickerState.rootPath;

  if (errorText) {
    list.innerHTML = `
      <div class="storage-picker-empty">
        <i class="fas fa-triangle-exclamation"></i>
        ${escapeHtml(errorText)}
      </div>
    `;
    return;
  }

  if (repositoryPickerState.entries.length === 0) {
    list.innerHTML = `
      <div class="storage-picker-empty">
        <i class="fas fa-folder-open"></i>
        当前目录没有可继续浏览的子目录
      </div>
    `;
    return;
  }

  list.innerHTML = repositoryPickerState.entries.map((entry) => `
    <button class="storage-picker-row ${entry.path === repositoryPickerState.highlightPath ? "is-created" : ""}" type="button" data-picker-path="${escapeHtml(entry.path)}">
      <i class="fas ${entry.type === "drive" ? "fa-hard-drive" : "fa-folder"}"></i>
      <span>
        <strong>${escapeHtml(entry.name)}</strong>
        <span>${escapeHtml(entry.path)}</span>
      </span>
      <i class="fas fa-chevron-right"></i>
    </button>
  `).join("");

  list.querySelectorAll("[data-picker-path]").forEach((button) => {
    button.addEventListener("click", () => {
      void loadRepositoryPickerDirectory(button.dataset.pickerPath || "");
    });
  });
}

async function copyText(value) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand("copy");
  textarea.remove();
}

function formatBytes(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return "-";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = numeric;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  return `${size.toFixed(size >= 10 || index === 0 ? 0 : 1)} ${units[index]}`;
}

function getStorageCapacityPercent(capacity) {
  const used = Number(capacity?.usedSpace);
  const total = Number(capacity?.totalSpace);
  if (!Number.isFinite(used) || !Number.isFinite(total) || total <= 0) {
    return 0;
  }
  return Math.min(100, Math.max(0, Math.round((used / total) * 100)));
}

function renderRepositoryCapacity(capacity) {
  const value = document.getElementById("repositoryCapacityValue");
  const progress = document.getElementById("repositoryCapacityProgress");
  const desc = document.getElementById("repositoryCapacityDesc");

  if (!value || !progress || !desc) return;

  if (!capacity) {
    value.textContent = "正在读取";
    progress.value = 0;
    desc.textContent = "等待存储库容量数据。";
    return;
  }

  if (capacity.error) {
    value.textContent = "读取失败";
    progress.value = 0;
    desc.textContent = capacity.error;
    return;
  }

  const percent = getStorageCapacityPercent(capacity);
  value.textContent = `${formatBytes(capacity.usedSpace)} / ${formatBytes(capacity.totalSpace)}`;
  progress.value = percent;
  desc.textContent = `已用 / 总容量 · 可用 ${formatBytes(capacity.availableSpace)} · ${percent}% 已用`;
}

function renderFtpStatus(ftp, projectorAccessHost = "", repositoryCapacity = null) {
  const badge = document.getElementById("ftpBadge");
  const meta = document.getElementById("ftpMeta");
  const warning = document.getElementById("ftpWarning");
  const hero = document.getElementById("storageServiceHero");
  const endpointEl = document.getElementById("ftpEndpoint");
  const accessSummary = document.getElementById("ftpAccessSummary");
  const message = document.getElementById("ftpServiceMessage");
  const copyButton = document.getElementById("ftpCopyEndpoint");
  if (!badge || !meta || !warning) return;

  if (!ftp) {
    badge.className = "badge badge-outline";
    badge.textContent = "未知";
    hero?.setAttribute("data-state", "unknown");
    if (endpointEl) endpointEl.textContent = "ftp://--";
    if (accessSummary) accessSummary.textContent = "等待服务状态";
    if (message) message.textContent = "配置仓库后，TMS 会把这个目录作为放映内容入口。";
    if (copyButton) {
      copyButton.disabled = true;
      copyButton.dataset.endpoint = "";
    }
    meta.innerHTML = "";
    warning.classList.add("hidden");
    return;
  }

  const labels = { running: "运行中", starting: "启动中", stopped: "已停止", error: "异常" };
  const badges = { running: "badge badge-success", starting: "badge badge-warning", stopped: "badge badge-ghost", error: "badge badge-error" };

  badge.className = badges[ftp.state] || "badge badge-outline";
  badge.textContent = labels[ftp.state] || ftp.state || "未知";
  hero?.setAttribute("data-state", ftp.state || "unknown");

  const endpoint = `ftp://${ftp.passiveHost || ftp.host}:${ftp.port}`;
  const login = ftp.anonymous ? "anonymous（只读）" : "-";
  const passive = ftp.passiveHost
    ? `${ftp.passiveHost}:${ftp.passivePortRange?.min}-${ftp.passivePortRange?.max}`
    : "-";
  const accessHost = projectorAccessHost || ftp.passiveHost || ftp.host || "";

  if (endpointEl) endpointEl.textContent = endpoint;
  if (accessSummary) {
    accessSummary.textContent = projectorAccessHost
      ? `放映机走手动地址 ${projectorAccessHost}`
      : `自动检测访问地址 ${accessHost || "-"}`;
  }
  if (message) {
    message.textContent = ftp.state === "running"
      ? `放映机可通过 ${endpoint} 读取当前内容仓库。`
      : "服务状态变化时，这里会显示放映机应使用的 FTP 入口。";
  }
  if (copyButton) {
    copyButton.disabled = !endpoint || ftp.state !== "running";
    copyButton.dataset.endpoint = endpoint;
  }

  meta.innerHTML = `
    ${renderStorageDiagnosticItem("FTP 地址", endpoint)}
    ${renderStorageDiagnosticItem("放映机访问地址", projectorAccessHost || "自动检测")}
    ${renderStorageDiagnosticItem("登录方式", login)}
    ${renderStorageDiagnosticItem("根目录", ftp.rootPath || "-")}
    ${renderStorageDiagnosticItem("总容量", repositoryCapacity?.error ? "读取失败" : formatBytes(repositoryCapacity?.totalSpace))}
    ${renderStorageDiagnosticItem("已用容量", repositoryCapacity?.error ? "-" : formatBytes(repositoryCapacity?.usedSpace))}
    ${renderStorageDiagnosticItem("可用容量", repositoryCapacity?.error ? "-" : formatBytes(repositoryCapacity?.availableSpace))}
    ${renderStorageDiagnosticItem("被动模式地址", passive)}
  `;

  if (ftp.message) {
    warning.classList.remove("hidden");
    warning.querySelector("span").textContent = ftp.message;
  } else {
    warning.classList.add("hidden");
  }
}

function renderStorageDiagnosticItem(label, value) {
  return `
    <div class="storage-diagnostic-item">
      <span>${escapeHtml(label)}</span>
      <strong title="${escapeHtml(value)}">${escapeHtml(value)}</strong>
    </div>
  `;
}

// ── Ticketing Settings ──────────────────────────────────────────

const ticketingState = {
  editing: false,
  baseUrl: "",
  serviceUsername: "",
  hasPassword: false,
  hasApiKey: false,
  cinemaInfo: null,
  draft: createTicketingDraft(),
};

function createTicketingDraft(overrides = {}) {
  return {
    baseUrl: "",
    serviceUsername: "",
    servicePassword: "",
    serviceApiKey: "",
    hasPassword: false,
    hasApiKey: false,
    tested: false,
    cinemaInfo: null,
    ...overrides,
  };
}

async function initTicketingSettings() {
  try {
    const response = await apiGet("/api/system/ticketing");
    if (response.finixx?.baseUrl) {
      ticketingState.baseUrl = response.finixx.baseUrl;
      ticketingState.serviceUsername = response.finixx.serviceUsername || "";
      ticketingState.hasPassword = Boolean(response.finixx.hasPassword);
      ticketingState.hasApiKey = Boolean(response.finixx.hasApiKey);
      ticketingState.cinemaInfo = response.finixx.cinemaInfo || null;
    }
  } catch (error) {
    showError("ticketingSettingsStatus", errorMessage(error, "加载售票系统配置失败。"));
  }
  renderTicketingCard();
}

function renderTicketingCard() {
  const container = document.getElementById("ticketingCard");
  if (!container) return;

  if (!ticketingState.baseUrl && !ticketingState.editing) {
    container.innerHTML = `
      <div class="rounded-box border border-dashed border-base-300 bg-base-100 p-6 text-center">
        <p class="text-sm text-base-content/70">尚未配置售票系统连接。</p>
        <button type="button" class="btn btn-primary btn-sm mt-3" id="ticketingStartEdit">
          <i class="fas fa-plus"></i>
          配置连接
        </button>
      </div>
    `;
    document.getElementById("ticketingStartEdit").addEventListener("click", () => {
      ticketingState.editing = true;
      ticketingState.draft = createTicketingDraft();
      renderTicketingCard();
    });
    return;
  }

  container.innerHTML = ticketingState.editing
    ? renderTicketingEdit()
    : renderTicketingReadonly();
  bindTicketingCardEvents();
}

function renderTicketingReadonly() {
  const info = ticketingState.cinemaInfo;
  const cinemaName = info?.locationName ? escapeHtml(info.locationName) : "-";
  const cinemaCode = info?.locationCode ? escapeHtml(info.locationCode) : "-";
  const wsName = info?.workstationName ? escapeHtml(info.workstationName) : "-";
  const wsId = info?.workstationId ? escapeHtml(info.workstationId) : "-";

  return `
    <article class="module-card settings-connection-card">
      <div class="icon-box"><i class="fas fa-ticket"></i></div>
      <div class="flex-1 min-w-0">
        <div class="settings-connection-head">
          <h4>${cinemaName}</h4>
          ${info ? '<span class="badge badge-success badge-sm">已连接</span>' : '<span class="badge badge-ghost badge-sm">未验证</span>'}
        </div>
        <div class="settings-connection-meta">
          <span>地址：${escapeHtml(ticketingState.baseUrl)}</span>
          <span>服务账户：${escapeHtml(ticketingState.serviceUsername || "-")}</span>
          <span>服务密码：${ticketingState.hasPassword ? "已配置" : "未配置"}</span>
          <span>API Key：${ticketingState.hasApiKey ? "已配置" : "未配置"}</span>
          <span>影院编码：${cinemaCode}</span>
          <span>工作站：${wsName}（${wsId}）</span>
        </div>
      </div>
      <div class="flex gap-1 flex-shrink-0 self-start">
        <button type="button" class="btn btn-ghost btn-sm" id="ticketingEditBtn" title="编辑">
          <i class="fas fa-pen"></i>
        </button>
      </div>
    </article>
  `;
}

function renderTicketingEdit() {
  const draft = ticketingState.draft;
  return `
    <article class="panel space-y-4">
      <div class="flex items-center gap-3">
        <div class="icon-box"><i class="fas fa-ticket"></i></div>
        <h4 class="font-bold">售票系统连接配置</h4>
      </div>

      <label class="setup-field">
        <span>售票系统地址</span>
        <input class="input input-bordered w-full" id="ticketingDraftUrl" value="${escapeHtml(draft.baseUrl)}" placeholder="http://127.0.0.1:8080">
      </label>

      <label class="setup-field">
        <span>服务用户名</span>
        <input class="input input-bordered w-full" id="ticketingDraftUsername" value="${escapeHtml(draft.serviceUsername)}" autocomplete="username" placeholder="请输入厂商提供的服务用户名">
      </label>

      <label class="setup-field">
        <span>服务密码</span>
        <input class="input input-bordered w-full" id="ticketingDraftPassword" type="password" value="${escapeHtml(draft.servicePassword)}" autocomplete="new-password" placeholder="${draft.hasPassword ? "已保存，留空则保持不变" : "请输入厂商提供的服务密码"}">
      </label>

      <label class="setup-field">
        <span>API Key</span>
        <input class="input input-bordered w-full" id="ticketingDraftApiKey" type="password" value="${escapeHtml(draft.serviceApiKey)}" autocomplete="off" placeholder="${draft.hasApiKey ? "已保存，留空则保持不变" : "请输入厂商提供的 API Key"}">
        <small class="text-base-content/60">请填写厂商提供的售票系统接入凭据。</small>
      </label>

      <div class="setup-test-panel">
        <button type="button" class="btn btn-primary btn-sm" id="ticketingTestBtn">
          <i class="fas fa-plug"></i>
          ${draft.tested ? "重新测试" : "测试连接"}
        </button>
        <div id="ticketingTestResult" class="setup-test-result${draft.tested ? " success" : ""}">
          ${draft.tested ? '<i class="fas fa-check-circle"></i>连接成功' : '<i class="fas fa-circle-info"></i>保存前需要先完成连接测试。'}
        </div>
      </div>

      ${draft.tested && draft.cinemaInfo ? renderTicketingDeviceInfo(draft.cinemaInfo) : ""}

      <div class="flex justify-end gap-2 border-t border-base-300 pt-3">
        <button type="button" class="btn btn-ghost btn-sm" id="ticketingCancelBtn">取消</button>
        <button type="button" class="btn btn-primary btn-sm" id="ticketingSaveBtn" ${draft.tested ? "" : "disabled"}>
          <i class="fas fa-floppy-disk"></i>
          保存
        </button>
      </div>
    </article>
  `;
}

function renderTicketingDeviceInfo(info) {
  if (!info) return "";
  const fields = [
    { label: "影院名称", value: info.locationName },
    { label: "影院编码", value: info.locationCode },
    { label: "工作站名称", value: info.workstationName },
    { label: "工作站编号", value: info.workstationId },
  ].filter((f) => f.value);
  if (fields.length === 0) return "";
  return `
    <div class="setup-info-card">
      <div class="setup-info-title"><i class="fas fa-building"></i><span>已连接影院</span></div>
      <div class="setup-info-grid">
        ${fields.map((f) => `<div><span>${f.label}</span><strong>${escapeHtml(String(f.value))}</strong></div>`).join("")}
      </div>
    </div>
  `;
}

function bindTicketingCardEvents() {
  const editBtn = document.getElementById("ticketingEditBtn");
  if (editBtn) {
    editBtn.addEventListener("click", () => {
      ticketingState.editing = true;
      ticketingState.draft = createTicketingDraft({
        baseUrl: ticketingState.baseUrl,
        serviceUsername: ticketingState.serviceUsername,
        hasPassword: ticketingState.hasPassword,
        hasApiKey: ticketingState.hasApiKey,
        tested: false,
        cinemaInfo: null,
      });
      renderTicketingCard();
    });
  }

  bindTicketingDraftInput("ticketingDraftUrl", "baseUrl");
  bindTicketingDraftInput("ticketingDraftUsername", "serviceUsername");
  bindTicketingDraftInput("ticketingDraftPassword", "servicePassword");
  bindTicketingDraftInput("ticketingDraftApiKey", "serviceApiKey");

  const testBtn = document.getElementById("ticketingTestBtn");
  if (testBtn) testBtn.addEventListener("click", () => void testTicketingConnection());

  const cancelBtn = document.getElementById("ticketingCancelBtn");
  if (cancelBtn) {
    cancelBtn.addEventListener("click", () => {
      ticketingState.editing = false;
      renderTicketingCard();
    });
  }

  const saveBtn = document.getElementById("ticketingSaveBtn");
  if (saveBtn) saveBtn.addEventListener("click", () => void saveTicketingConfig());
}

function bindTicketingDraftInput(elementId, draftKey) {
  const input = document.getElementById(elementId);
  if (!input) return;
  input.addEventListener("input", () => {
    ticketingState.draft[draftKey] = input.value;
    ticketingState.draft.tested = false;
    ticketingState.draft.cinemaInfo = null;
    const result = document.getElementById("ticketingTestResult");
    if (result) {
      result.classList.remove("success", "error");
      result.innerHTML = '<i class="fas fa-circle-info"></i>配置已修改，请重新测试连接。';
    }
    const saveBtn = document.getElementById("ticketingSaveBtn");
    if (saveBtn) saveBtn.disabled = true;
  });
}

async function testTicketingConnection() {
  const btn = document.getElementById("ticketingTestBtn");
  const baseUrl = ticketingState.draft.baseUrl.trim();
  const serviceUsername = ticketingState.draft.serviceUsername.trim();
  const servicePassword = ticketingState.draft.servicePassword;
  const serviceApiKey = ticketingState.draft.serviceApiKey;
  if (!baseUrl) {
    setHallTestResult(document.getElementById("ticketingTestResult"), "error", "请先填写售票系统地址。");
    return;
  }
  if (!serviceUsername) {
    setHallTestResult(document.getElementById("ticketingTestResult"), "error", "请填写服务用户名。");
    return;
  }
  if (!servicePassword && !ticketingState.draft.hasPassword) {
    setHallTestResult(document.getElementById("ticketingTestResult"), "error", "请填写服务密码。");
    return;
  }
  if (!serviceApiKey && !ticketingState.draft.hasApiKey) {
    setHallTestResult(document.getElementById("ticketingTestResult"), "error", "请填写 API Key。");
    return;
  }

  btn.disabled = true;
  btn.innerHTML = '<span class="loading loading-spinner loading-sm"></span> 测试中';
  setHallTestResult(document.getElementById("ticketingTestResult"), "", "正在测试连接...");

  try {
    const result = await apiPost("/api/setup/finixx/test", {
      baseUrl,
      serviceUsername,
      servicePassword,
      serviceApiKey,
    });
    ticketingState.draft.tested = true;
    ticketingState.draft.cinemaInfo = result.cinemaInfo || null;
    renderTicketingCard();
  } catch (error) {
    ticketingState.draft.tested = false;
    ticketingState.draft.cinemaInfo = null;
    setHallTestResult(document.getElementById("ticketingTestResult"), "error", errorMessage(error, "连接测试失败。"));
    btn.innerHTML = '<i class="fas fa-plug"></i> 测试连接';
    btn.disabled = false;
  }
}

async function saveTicketingConfig() {
  const btn = document.getElementById("ticketingSaveBtn");
  if (!ticketingState.draft.tested) return;

  btn.disabled = true;
  btn.innerHTML = '<span class="loading loading-spinner loading-sm"></span> 保存中';

  try {
    const response = await apiPost("/api/system/ticketing", {
      baseUrl: ticketingState.draft.baseUrl.trim(),
      serviceUsername: ticketingState.draft.serviceUsername.trim(),
      servicePassword: ticketingState.draft.servicePassword,
      serviceApiKey: ticketingState.draft.serviceApiKey,
      cinemaInfo: ticketingState.draft.cinemaInfo,
    });
    ticketingState.baseUrl = response.finixx.baseUrl;
    ticketingState.serviceUsername = response.finixx.serviceUsername || "";
    ticketingState.hasPassword = Boolean(response.finixx.hasPassword);
    ticketingState.hasApiKey = Boolean(response.finixx.hasApiKey);
    ticketingState.cinemaInfo = response.finixx.cinemaInfo || null;
    ticketingState.editing = false;
    renderTicketingCard();
  } catch (error) {
    showError("ticketingSettingsStatus", errorMessage(error, "保存失败。"));
    btn.disabled = false;
    btn.innerHTML = '<i class="fas fa-floppy-disk"></i> 保存';
  }
}

// ── Hall Settings ──────────────────────────────────────────────

const hallsState = {
  halls: [],
  editingIndex: -1,
  editDraft: null,
};

const addHallState = {
  step: 0,
  ticketingHalls: [],
  selectedHall: null,
  host: "",
  port: "5000",
  tested: false,
  gdcDeviceInfo: null,
};

async function initHallSettings() {
  const addBtn = document.getElementById("hallAddBtn");
  if (addBtn && addBtn.dataset.bound !== "true") {
    addBtn.dataset.bound = "true";
    addBtn.addEventListener("click", () => void openAddHallModal());
  }
  bindAddHallModalEvents();

  try {
    const response = await apiGet("/api/system/halls");
    hallsState.halls = Array.isArray(response.halls) ? response.halls : [];
    try {
      const runtimeHalls = await getRuntimeHalls();
      mergeRuntimeStatus(runtimeHalls);
    } catch { /* optional */ }
    renderHallList();
  } catch (error) {
    showError("hallSettingsStatus", errorMessage(error, "加载影厅配置失败。"));
  }
}

async function reloadHallList() {
  try {
    const response = await apiGet("/api/system/halls");
    hallsState.halls = Array.isArray(response.halls) ? response.halls : [];
    hallsState.editingIndex = -1;
    hallsState.editDraft = null;
    try {
      const runtimeHalls = await getRuntimeHalls(true);
      mergeRuntimeStatus(runtimeHalls);
    } catch { /* optional */ }
    renderHallList();
  } catch { /* keep current list */ }
}

function mergeRuntimeStatus(runtimeHalls) {
  if (!Array.isArray(runtimeHalls)) return;
  const runtimeMap = new Map();
  for (const rh of runtimeHalls) {
    const hallId = rh.registration?.hallId;
    if (hallId) runtimeMap.set(hallId, rh);
  }
  for (const hall of hallsState.halls) {
    const runtime = runtimeMap.get(hall.id) || runtimeMap.get(hall.finixxHallId);
    hall._runtimeState = runtime ? (runtime.snapshot?.connectivity?.state || "unknown") : undefined;
  }
}

// ── Hall List Rendering ──

function renderHallList() {
  const listEl = document.getElementById("hallSettingsList");
  if (!listEl) return;

  if (hallsState.halls.length === 0) {
    listEl.innerHTML = `
      <div class="rounded-box border border-dashed border-base-300 bg-base-100 p-6 text-sm text-base-content/70 text-center">
        当前没有已配置的影厅。
      </div>
    `;
    return;
  }

  listEl.innerHTML = hallsState.halls.map((hall, index) =>
    hallsState.editingIndex === index
      ? renderHallCardEdit(hall, index)
      : renderHallCardReadonly(hall, index)
  ).join("");

  bindHallListEvents();
}

function renderHallCardReadonly(hall, index) {
  const stateBadge = hall._runtimeState
    ? `<span class="${getStateBadgeClass(hall._runtimeState)}">${escapeHtml(describeState(hall._runtimeState))}</span>`
    : '<span class="badge badge-ghost badge-sm">未知</span>';
  const endpoint = hall.host ? `${escapeHtml(hall.host)}:${escapeHtml(String(hall.port || 5000))}` : "未配置";
  const serial = hall.gdcDeviceInfo?.serial ? escapeHtml(hall.gdcDeviceInfo.serial) : "-";

  return `
    <article class="module-card settings-connection-card" data-hall-index="${index}">
      <div class="icon-box"><i class="fas fa-clapperboard"></i></div>
      <div class="flex-1 min-w-0">
        <div class="settings-connection-head">
          <h4>${escapeHtml(hall.name)}</h4>
          ${stateBadge}
        </div>
        <div class="settings-connection-meta">
          <span>GDC 地址：${endpoint}</span>
          <span>设备码：${serial}</span>
        </div>
      </div>
      <div class="flex gap-1 flex-shrink-0 self-start">
        <button type="button" class="btn btn-ghost btn-sm" data-hall-edit="${index}" title="编辑">
          <i class="fas fa-pen"></i>
        </button>
        <button type="button" class="btn btn-ghost btn-sm text-error" data-hall-delete="${index}" title="删除">
          <i class="fas fa-trash"></i>
        </button>
      </div>
    </article>
  `;
}

function renderHallCardEdit(hall, index) {
  const draft = hallsState.editDraft;
  return `
    <article class="panel space-y-4" data-hall-index="${index}">
      <div class="flex items-center justify-between gap-3">
        <div class="flex items-center gap-3">
          <div class="icon-box"><i class="fas fa-clapperboard"></i></div>
          <div>
            <h4 class="font-bold">${escapeHtml(hall.name)}</h4>
            <p class="text-sm text-base-content/60">售票系统影厅 ID：${escapeHtml(hall.finixxHallId || hall.id)}</p>
          </div>
        </div>
      </div>

      <div class="grid grid-cols-[1fr_8rem] gap-3">
        <label class="setup-field">
          <span>GDC 放映服务器地址</span>
          <input class="input input-bordered w-full" data-edit-host="${index}" value="${escapeHtml(draft.host || "")}" placeholder="192.168.10.11">
        </label>
        <label class="setup-field">
          <span>端口</span>
          <input class="input input-bordered w-full" data-edit-port="${index}" value="${escapeHtml(String(draft.port || ""))}" placeholder="5000">
        </label>
      </div>

      <div class="setup-test-panel">
        <button type="button" class="btn btn-primary btn-sm" data-edit-test="${index}">
          <i class="fas fa-plug"></i>
          ${draft.tested ? "重新测试" : "测试连接"}
        </button>
        <div class="setup-test-result${draft.tested ? " success" : ""}" data-edit-result="${index}">
          ${draft.tested ? '<i class="fas fa-check-circle"></i>连接成功' : '<i class="fas fa-circle-info"></i>保存前需要先完成连接测试。'}
        </div>
      </div>

      ${draft.tested ? `<div>${renderGdcDeviceInfo(draft.gdcDeviceInfo)}</div>` : ""}

      <div class="flex justify-end gap-2 border-t border-base-300 pt-3">
        <button type="button" class="btn btn-ghost btn-sm" data-edit-cancel="${index}">取消</button>
        <button type="button" class="btn btn-primary btn-sm" data-edit-save="${index}" ${draft.tested ? "" : "disabled"}>
          <i class="fas fa-floppy-disk"></i>
          保存
        </button>
      </div>
    </article>
  `;
}

function bindHallListEvents() {
  document.querySelectorAll("[data-hall-edit]").forEach((btn) => {
    btn.addEventListener("click", () => startEditHall(Number(btn.dataset.hallEdit)));
  });
  document.querySelectorAll("[data-hall-delete]").forEach((btn) => {
    btn.addEventListener("click", () => void deleteHall(Number(btn.dataset.hallDelete)));
  });

  document.querySelectorAll("[data-edit-host], [data-edit-port]").forEach((input) => {
    input.addEventListener("input", () => {
      if (input.dataset.editHost !== undefined) hallsState.editDraft.host = input.value;
      else hallsState.editDraft.port = input.value;
      hallsState.editDraft.tested = false;
      hallsState.editDraft.gdcDeviceInfo = null;
      renderHallList();
    });
  });
  document.querySelectorAll("[data-edit-test]").forEach((btn) => {
    btn.addEventListener("click", () => void testEditHall(Number(btn.dataset.editTest), btn));
  });
  document.querySelectorAll("[data-edit-cancel]").forEach((btn) => {
    btn.addEventListener("click", () => cancelEditHall());
  });
  document.querySelectorAll("[data-edit-save]").forEach((btn) => {
    btn.addEventListener("click", () => void saveEditHall(Number(btn.dataset.editSave), btn));
  });
}

// ── Per-Hall Edit ──

function startEditHall(index) {
  const hall = hallsState.halls[index];
  if (!hall) return;
  hallsState.editingIndex = index;
  hallsState.editDraft = {
    host: hall.host || "",
    port: hall.port || "5000",
    tested: Boolean(hall.tested),
    gdcDeviceInfo: hall.gdcDeviceInfo || null,
  };
  renderHallList();
}

function cancelEditHall() {
  hallsState.editingIndex = -1;
  hallsState.editDraft = null;
  renderHallList();
}

async function testEditHall(index, btn) {
  const draft = hallsState.editDraft;
  if (!draft.host || !draft.port) {
    const resultEl = document.querySelector(`[data-edit-result="${index}"]`);
    setHallTestResult(resultEl, "error", "请先填写地址和端口。");
    return;
  }

  btn.disabled = true;
  btn.innerHTML = '<span class="loading loading-spinner loading-sm"></span> 测试中';
  const resultEl = document.querySelector(`[data-edit-result="${index}"]`);
  setHallTestResult(resultEl, "", "正在测试连接...");

  try {
    const response = await apiPost("/api/setup/gdc/test", { host: draft.host, port: draft.port });
    draft.tested = true;
    draft.gdcDeviceInfo = response.deviceInfo || null;
    renderHallList();
  } catch (error) {
    draft.tested = false;
    draft.gdcDeviceInfo = null;
    setHallTestResult(resultEl, "error", errorMessage(error, "GDC 连接测试失败。"));
    btn.disabled = false;
    btn.innerHTML = '<i class="fas fa-plug"></i> 测试连接';
  }
}

async function saveEditHall(index, btn) {
  const hall = hallsState.halls[index];
  const draft = hallsState.editDraft;
  if (!hall || !draft?.tested) return;

  btn.disabled = true;
  btn.innerHTML = '<span class="loading loading-spinner loading-sm"></span> 保存中';

  try {
    await apiPost("/api/system/halls/save", {
      id: hall.id,
      name: hall.name,
      finixxHallId: hall.finixxHallId,
      host: draft.host,
      port: draft.port,
      tested: true,
      gdcDeviceInfo: draft.gdcDeviceInfo,
    });
    await reloadHallList();
  } catch (error) {
    showError("hallSettingsStatus", errorMessage(error, "保存失败。"));
    btn.disabled = false;
    btn.innerHTML = '<i class="fas fa-floppy-disk"></i> 保存';
  }
}

// ── Per-Hall Delete ──

async function deleteHall(index) {
  const hall = hallsState.halls[index];
  if (!hall) return;
  if (!confirm(`确定要删除影厅"${hall.name}"的绑定配置吗？`)) return;

  try {
    await apiPost("/api/system/halls/delete", { finixxHallId: hall.finixxHallId || hall.id });
    await reloadHallList();
  } catch (error) {
    showError("hallSettingsStatus", errorMessage(error, "删除失败。"));
  }
}

// ── Add Hall Modal ──

function bindAddHallModalEvents() {
  const modal = document.getElementById("addHallModal");
  if (!modal || modal.dataset.bound === "true") return;
  modal.dataset.bound = "true";

  document.getElementById("addHallCancelBtn").addEventListener("click", closeAddHallModal);
  document.getElementById("addHallBackBtn").addEventListener("click", addHallGoBack);
  document.getElementById("addHallNextBtn").addEventListener("click", addHallGoNext);
  document.getElementById("addHallSaveBtn").addEventListener("click", () => void saveAddHall());
  document.getElementById("addHallTestBtn").addEventListener("click", () => void testAddHall());

  document.getElementById("addHallHost").addEventListener("input", () => {
    addHallState.host = document.getElementById("addHallHost").value;
    addHallState.tested = false;
    addHallState.gdcDeviceInfo = null;
    updateAddHallStep1UI();
  });
  document.getElementById("addHallPort").addEventListener("input", () => {
    addHallState.port = document.getElementById("addHallPort").value;
    addHallState.tested = false;
    addHallState.gdcDeviceInfo = null;
    updateAddHallStep1UI();
  });
}

async function openAddHallModal() {
  resetAddHallState();
  const modal = document.getElementById("addHallModal");
  modal.showModal();
  showAddHallStep(0);

  setStatusMessage("addHallListStatus", "info", "正在从售票系统获取影厅列表...");
  document.getElementById("addHallList").innerHTML = "";

  try {
    const ticketingConfig = await apiGet("/api/system/ticketing");
    if (!ticketingConfig.finixx?.baseUrl) {
      setStatusMessage("addHallListStatus", "error", '请先在"售票系统连接"页配置售票系统地址。');
      return;
    }
    const result = await apiPost("/api/setup/finixx/test", { baseUrl: ticketingConfig.finixx.baseUrl });
    addHallState.ticketingHalls = Array.isArray(result.halls) ? result.halls : [];

    if (addHallState.ticketingHalls.length === 0) {
      setStatusMessage("addHallListStatus", "warning", "未从售票系统获取到影厅列表。");
      return;
    }

    setStatusMessage("addHallListStatus", "success", `获取到 ${addHallState.ticketingHalls.length} 个影厅。`);
    renderAddHallList();
  } catch (error) {
    setStatusMessage("addHallListStatus", "error", errorMessage(error, "获取影厅列表失败。"));
  }
}

function closeAddHallModal() {
  document.getElementById("addHallModal").close();
  resetAddHallState();
}

function resetAddHallState() {
  addHallState.step = 0;
  addHallState.ticketingHalls = [];
  addHallState.selectedHall = null;
  addHallState.host = "";
  addHallState.port = "5000";
  addHallState.tested = false;
  addHallState.gdcDeviceInfo = null;
}

function showAddHallStep(step) {
  addHallState.step = step;
  document.getElementById("addHallStep0").classList.toggle("hidden", step !== 0);
  document.getElementById("addHallStep1").classList.toggle("hidden", step !== 1);
  document.getElementById("addHallBackBtn").classList.toggle("hidden", step === 0);
  document.getElementById("addHallNextBtn").classList.toggle("hidden", step !== 0);
  document.getElementById("addHallSaveBtn").classList.toggle("hidden", step !== 1);

  if (step === 1) {
    document.getElementById("addHallSelectedName").textContent = addHallState.selectedHall?.name || "-";
    document.getElementById("addHallHost").value = addHallState.host;
    document.getElementById("addHallPort").value = addHallState.port;
    document.getElementById("addHallDeviceInfo").innerHTML = "";
    updateAddHallStep1UI();
  }
}

function renderAddHallList() {
  const listEl = document.getElementById("addHallList");
  const existingIds = new Set(hallsState.halls.map((h) => h.finixxHallId || h.id));

  listEl.innerHTML = addHallState.ticketingHalls.map((hall, i) => {
    const hallId = hall.finixxHallId || hall.id;
    const exists = existingIds.has(hallId);
    const selected = addHallState.selectedHall?.id === hall.id;
    const cls = exists
      ? "opacity-50 cursor-not-allowed"
      : selected
        ? "border-primary bg-primary/8 cursor-pointer"
        : "hover:border-primary/40 cursor-pointer";

    return `
      <div class="rounded-box border border-base-300 p-3 flex items-center gap-3 transition-colors ${cls}"
           data-add-hall-pick="${exists ? "" : i}" ${exists ? "" : 'role="button" tabindex="0"'}>
        <div class="w-8 h-8 bg-primary/12 rounded-lg flex items-center justify-center text-primary text-sm">
          <i class="fas fa-clapperboard"></i>
        </div>
        <div class="flex-1 min-w-0">
          <div class="font-medium text-sm">${escapeHtml(hall.name)}</div>
          <div class="text-xs text-base-content/50">${escapeHtml(hallId)}</div>
        </div>
        ${exists ? '<span class="badge badge-ghost badge-sm">已配置</span>' : ""}
        ${selected ? '<i class="fas fa-check-circle text-primary"></i>' : ""}
      </div>
    `;
  }).join("");

  listEl.querySelectorAll("[data-add-hall-pick]").forEach((el) => {
    const idx = el.dataset.addHallPick;
    if (idx === "") return;
    el.addEventListener("click", () => {
      addHallState.selectedHall = addHallState.ticketingHalls[Number(idx)];
      renderAddHallList();
      document.getElementById("addHallNextBtn").disabled = false;
    });
  });

  document.getElementById("addHallNextBtn").disabled = !addHallState.selectedHall;
}

function addHallGoBack() {
  addHallState.tested = false;
  addHallState.gdcDeviceInfo = null;
  addHallState.host = "";
  addHallState.port = "5000";
  showAddHallStep(0);
}

function addHallGoNext() {
  if (!addHallState.selectedHall) return;
  showAddHallStep(1);
}

function updateAddHallStep1UI() {
  const testResult = document.getElementById("addHallTestResult");
  const saveBtn = document.getElementById("addHallSaveBtn");
  if (addHallState.tested) {
    setHallTestResult(testResult, "success", "连接成功。");
    saveBtn.disabled = false;
  } else {
    setHallTestResult(testResult, "", "保存前需要先完成连接测试。");
    saveBtn.disabled = true;
  }
}

async function testAddHall() {
  const btn = document.getElementById("addHallTestBtn");
  const host = addHallState.host.trim();
  const port = addHallState.port.trim();
  const testResult = document.getElementById("addHallTestResult");

  if (!host || !port) {
    setHallTestResult(testResult, "error", "请先填写地址和端口。");
    return;
  }

  btn.disabled = true;
  btn.innerHTML = '<span class="loading loading-spinner loading-sm"></span> 测试中';
  setHallTestResult(testResult, "", "正在测试连接...");

  try {
    const response = await apiPost("/api/setup/gdc/test", { host, port });
    addHallState.tested = true;
    addHallState.gdcDeviceInfo = response.deviceInfo || null;
    document.getElementById("addHallDeviceInfo").innerHTML = renderGdcDeviceInfo(response.deviceInfo);
    updateAddHallStep1UI();
    btn.innerHTML = '<i class="fas fa-rotate"></i> 重新测试';
  } catch (error) {
    addHallState.tested = false;
    addHallState.gdcDeviceInfo = null;
    document.getElementById("addHallDeviceInfo").innerHTML = "";
    setHallTestResult(testResult, "error", errorMessage(error, "GDC 连接测试失败。"));
    btn.innerHTML = '<i class="fas fa-plug"></i> 测试连接';
  } finally {
    btn.disabled = false;
  }
}

async function saveAddHall() {
  if (!addHallState.selectedHall || !addHallState.tested) return;
  const btn = document.getElementById("addHallSaveBtn");
  btn.disabled = true;
  btn.innerHTML = '<span class="loading loading-spinner loading-sm"></span> 保存中';

  try {
    const hall = addHallState.selectedHall;
    await apiPost("/api/system/halls/save", {
      id: hall.id,
      name: hall.name,
      finixxHallId: hall.finixxHallId || hall.id,
      host: addHallState.host.trim(),
      port: addHallState.port.trim(),
      tested: true,
      gdcDeviceInfo: addHallState.gdcDeviceInfo,
    });
    closeAddHallModal();
    await reloadHallList();
  } catch (error) {
    showError("hallSettingsStatus", errorMessage(error, "添加影厅失败。"));
    btn.disabled = false;
    btn.innerHTML = '<i class="fas fa-floppy-disk"></i> 保存';
  }
}

// ── Hall Shared Helpers ──

function renderGdcDeviceInfo(deviceInfo) {
  const fields = [
    { label: "设备码", value: deviceInfo?.serial, emphasized: true },
    { label: "型号", value: deviceInfo?.model },
    { label: "软件版本", value: deviceInfo?.softwareVersion },
    { label: "固件版本", value: deviceInfo?.firmwareVersion },
  ].filter((item) => item.value);

  if (fields.length === 0) {
    return '<div class="hall-device-info"><div class="is-serial"><span>设备码</span><strong>未获取到</strong></div></div>';
  }

  return `
    <div class="hall-device-info">
      ${fields.map((item) => `
        <div class="${item.emphasized ? "is-serial" : ""}">
          <span>${item.label}</span>
          <strong>${escapeHtml(String(item.value))}</strong>
        </div>
      `).join("")}
    </div>
  `;
}

function setHallTestResult(el, type, message) {
  if (!el) return;
  el.classList.remove("success", "error");
  if (type) el.classList.add(type);
  const icon = type === "success" ? "fa-check-circle" : type === "error" ? "fa-circle-xmark" : "fa-circle-info";
  el.innerHTML = `<i class="fas ${icon}"></i>${escapeHtml(message)}`;
}

function getStateBadgeClass(state) {
  const map = {
    online: "badge badge-success badge-sm",
    offline: "badge badge-error badge-sm",
    unknown: "badge badge-ghost badge-sm",
  };
  return map[state] || map.unknown;
}

function describeState(state) {
  const map = {
    online: "在线", offline: "离线", unknown: "未知",
  };
  return map[state] || "未知";
}

// ── Shared Utilities ──────────────────────────────────────────

function showError(id, message) {
  const node = document.getElementById(id);
  if (!node) return;
  node.classList.remove("hidden");
  node.querySelector("span").textContent = message;
}

function setStatusMessage(id, type, message) {
  const node = document.getElementById(id);
  if (!node) return;

  const classMap = { success: "alert alert-success", error: "alert alert-error", warning: "alert alert-warning", info: "alert alert-info" };
  const iconMap = { success: "fa-circle-check", error: "fa-circle-xmark", warning: "fa-triangle-exclamation", info: "fa-circle-info" };

  node.className = classMap[type] || classMap.info;
  node.innerHTML = `<i class="fas ${iconMap[type] || iconMap.info}"></i><span>${escapeHtml(message)}</span>`;
}

function setChecked(id, value) {
  const input = document.getElementById(id);
  if (input) input.checked = value;
}

function errorMessage(error, fallback) {
  return error instanceof Error ? error.message : fallback;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
