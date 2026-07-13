import { apiPost } from "../api.js";
import { updateUserDisplay } from "../layout.js";
import { appState, clearSetupStatusCache, setAuthenticatedUser } from "../state.js";

const setupState = {
  step: 0,
  tests: [false, false, false],
  account: null,
  databaseExisted: false,
  existingTmsDatabase: null,
  adoptedExistingDatabase: false,
};

export function initSetupWizard() {
  resetSetupState();

  document.querySelectorAll("[data-test-step]").forEach((button) => {
    button.addEventListener("click", () => testSetupStep(Number(button.dataset.testStep)));
  });

  ["mysqlHost", "mysqlPort", "mysqlDatabase", "mysqlUser", "mysqlPassword"].forEach((id) => {
    document.getElementById(id)?.addEventListener("input", () => resetDatabaseStep());
  });

  ["accountUsername", "accountPassword", "accountPasswordConfirm"].forEach((id) => {
    document.getElementById(id)?.addEventListener("input", () => resetSetupTest(1));
  });

  ["existingAdminUsername", "existingAdminPassword"].forEach((id) => {
    document.getElementById(id)?.addEventListener("input", () => {
      setupState.adoptedExistingDatabase = false;
      setupState.tests[0] = false;
      setupState.tests[1] = false;
      setAdoptResult("", "验证通过后会直接使用该 TMS 数据库。");
      updateSetupNextState();
    });
  });

  document.getElementById("adoptDatabaseButton")?.addEventListener("click", () => {
    void adoptExistingDatabase();
  });

  document.getElementById("setupBack").addEventListener("click", () => {
    if (setupState.step > 0) {
      setupState.step -= 1;
      renderSetupStep();
      void saveCurrentDraft();
    }
  });

  document.getElementById("setupNext").addEventListener("click", () => {
    if (setupState.step < 2) {
      setupState.step += setupState.adoptedExistingDatabase && setupState.step === 0 ? 2 : 1;
      renderSetupStep();
      void saveCurrentDraft();
      return;
    }

    void completeSetup();
  });

  applySetupDraft(appState.setupDraftCache);
  renderSetupStep();
  renderExistingTmsPanel();
}

function resetSetupState() {
  setupState.step = 0;
  setupState.tests = [false, false, false];
  setupState.account = null;
  setupState.databaseExisted = false;
  setupState.existingTmsDatabase = null;
  setupState.adoptedExistingDatabase = false;
}

function applySetupDraft(draft) {
  if (!draft) {
    return;
  }

  if (draft.database) {
    setInputValue("mysqlHost", draft.database.host);
    setInputValue("mysqlPort", draft.database.port);
    setInputValue("mysqlDatabase", draft.database.database);
    setInputValue("mysqlUser", draft.database.user);
  }

  if (draft.account) {
    setInputValue("accountUsername", draft.account.username);
    setupState.account = draft.account;
  }

  setupState.step = Number.isInteger(draft.step) ? Math.max(0, Math.min(2, draft.step)) : 0;
  setupState.tests = Array.isArray(draft.tests) ? [
    Boolean(draft.tests[0]),
    Boolean(draft.tests[1]),
    Boolean(draft.tests[2]),
  ] : setupState.tests;
  setupState.databaseExisted = Boolean(draft.databaseExisted);
}

function renderSetupStep() {
  document.querySelectorAll("[data-setup-step]").forEach((section) => {
    section.classList.toggle("hidden", Number(section.dataset.setupStep) !== setupState.step);
  });

  document.querySelectorAll("[data-setup-step-indicator]").forEach((step) => {
    const index = Number(step.dataset.setupStepIndicator);
    step.classList.toggle("step-primary", index <= setupState.step);
  });

  const back = document.getElementById("setupBack");
  const next = document.getElementById("setupNext");

  back.disabled = setupState.step === 0;
  next.innerHTML = setupState.step === 2
    ? '进入系统 <i class="fas fa-check"></i>'
    : '下一步 <i class="fas fa-angle-right"></i>';

  updateSetupNextState();
}

function updateSetupNextState() {
  const next = document.getElementById("setupNext");
  if (!next) return;

  if (setupState.step === 0) {
    next.disabled = !setupState.tests[0];
  } else if (setupState.step === 1) {
    next.disabled = !setupState.tests[1];
  } else {
    next.disabled = !(setupState.adoptedExistingDatabase || (setupState.tests[0] && setupState.tests[1]));
  }
}

async function testSetupStep(step) {
  const button = document.querySelector(`[data-test-step="${step}"]`);
  button.disabled = true;
  button.innerHTML = '<span class="loading loading-spinner loading-sm"></span> 处理中';
  setTestResult(step, "", step === 0 ? "正在检查数据库..." : "正在保存管理员账号...");

  try {
    if (step === 0) {
      const result = await apiPost("/api/setup/database/test", readDatabaseForm());
      setupState.databaseExisted = Boolean(result.databaseExisted);
      setupState.existingTmsDatabase = result.status === "tms-existing" ? result : null;
      setupState.tests[0] = result.status !== "tms-existing";
      renderExistingTmsPanel();
      setTestResult(0, result.status === "tms-existing" ? "" : "success", getDatabaseStatusMessage(result));
    } else if (step === 1) {
      const account = readAccountForm();
      const result = await apiPost("/api/setup/account", account);
      setupState.account = { username: account.username };
      setupState.tests[1] = true;
      setAuthenticatedUser(result.user);
      updateUserDisplay(result.user?.username);
      setTestResult(1, "success", "管理员账号已创建，可以继续下一步。");
    }

    button.innerHTML = getSetupTestButtonLabel(step, true);
    updateSetupNextState();
    void saveCurrentDraft();
  } catch (error) {
    setupState.tests[step] = false;
    setTestResult(step, "error", error instanceof Error ? error.message : "操作失败。");
    button.innerHTML = getSetupTestButtonLabel(step, false);
    updateSetupNextState();
  } finally {
    button.disabled = false;
  }
}

async function adoptExistingDatabase() {
  const button = document.getElementById("adoptDatabaseButton");
  button.disabled = true;
  button.innerHTML = '<span class="loading loading-spinner loading-sm"></span> 验证中';
  setAdoptResult("", "正在验证已有管理员账号...");

  try {
    const result = await apiPost("/api/setup/database/adopt", {
      ...readDatabaseForm(),
      adminUsername: document.getElementById("existingAdminUsername").value.trim(),
      adminPassword: document.getElementById("existingAdminPassword").value,
    });
    setupState.tests[0] = true;
    setupState.tests[1] = true;
    setupState.adoptedExistingDatabase = true;
    setAuthenticatedUser(result.user);
    updateUserDisplay(result.user?.username);
    setTestResult(0, "success", "已有 TMS 数据库验证通过，可以继续。");
    setAdoptResult("success", "验证通过，系统将继续使用该数据库。");
    updateSetupNextState();
  } catch (error) {
    setupState.tests[0] = false;
    setupState.tests[1] = false;
    setupState.adoptedExistingDatabase = false;
    setAdoptResult("error", error instanceof Error ? error.message : "验证失败。");
    updateSetupNextState();
  } finally {
    button.disabled = false;
    button.innerHTML = '<i class="fas fa-key"></i> 验证并使用此数据库';
  }
}

function getSetupTestButtonLabel(step, retest) {
  if (step === 0) {
    return retest
      ? '<i class="fas fa-plug"></i> 重新检查数据库'
      : '<i class="fas fa-plug"></i> 检查并初始化数据库';
  }

  return retest
    ? '<i class="fas fa-floppy-disk"></i> 重新保存管理员账号'
    : '<i class="fas fa-floppy-disk"></i> 保存管理员账号';
}

function getDatabaseStatusMessage(result) {
  if (result.status === "tms-existing") {
    return "检测到已有 TMS 数据库。请验证该库中的管理员账号后继续。";
  }
  if (result.status === "missing") {
    return "数据库不存在，已创建并初始化为 TMS 数据库。";
  }
  if (result.status === "empty") {
    return "空数据库已初始化为 TMS 数据库。";
  }
  return "数据库连接测试通过。";
}

async function saveCurrentDraft() {
  if (!setupState.tests[0] || setupState.adoptedExistingDatabase) {
    return;
  }

  await apiPost("/api/setup/draft", {
    step: setupState.step,
    tests: setupState.tests,
    databaseExisted: setupState.databaseExisted,
    account: setupState.account,
  }).catch(() => undefined);
}

async function completeSetup() {
  const next = document.getElementById("setupNext");
  next.disabled = true;

  try {
    await apiPost("/api/setup/complete", {});
    clearSetupStatusCache();
    document.body.classList.remove("setup-mode");
    window.location.replace("#/home");
  } catch (error) {
    next.disabled = false;
    setTestResult(2, "error", error instanceof Error ? error.message : "保存初始化状态失败。");
  }
}

function resetDatabaseStep() {
  setupState.tests[0] = false;
  setupState.tests[1] = false;
  setupState.account = null;
  setupState.existingTmsDatabase = null;
  setupState.adoptedExistingDatabase = false;
  setTestResult(0, "", "配置已修改，继续下一步前需要重新检查数据库。");
  renderExistingTmsPanel();
  updateSetupNextState();
}

function resetSetupTest(step) {
  if (!setupState.tests[step]) {
    return;
  }

  setupState.tests[step] = false;
  if (step === 1) {
    setupState.account = null;
  }
  setTestResult(step, "", "配置已修改，继续下一步前需要重新保存。");
  updateSetupNextState();
}

function setTestResult(step, type, message) {
  const result = document.querySelector(`[data-test-result="${step}"]`);
  if (!result) {
    return;
  }
  setResultNode(result, type, message);
}

function setAdoptResult(type, message) {
  const result = document.getElementById("adoptDatabaseResult");
  if (result) {
    setResultNode(result, type, message);
  }
}

function setResultNode(result, type, message) {
  result.classList.remove("success", "error");
  if (type) {
    result.classList.add(type);
  }
  const icon = type === "success" ? "fa-check-circle" : type === "error" ? "fa-circle-xmark" : "fa-circle-info";
  result.innerHTML = `<i class="fas ${icon}"></i>${escapeHtml(message)}`;
}

function renderExistingTmsPanel() {
  const panel = document.getElementById("existingTmsPanel");
  const summary = document.getElementById("existingTmsSummary");
  if (!panel || !summary) {
    return;
  }

  const result = setupState.existingTmsDatabase;
  panel.classList.toggle("hidden", !result);
  if (!result) {
    summary.innerHTML = "";
    return;
  }

  const info = result.summary || {};
  summary.innerHTML = [
    ["已有用户数", String(info.userCount ?? 0)],
    ["初始化状态", info.completed ? "已完成" : "未完成"],
    ["配置项", Array.isArray(info.configKeys) && info.configKeys.length ? info.configKeys.join("、") : "-"],
    ["身份标识", info.identity?.app || "旧版 TMS 结构"],
  ].map(([label, value]) => `
    <div>
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
    </div>
  `).join("");
}

function readDatabaseForm() {
  return {
    host: document.getElementById("mysqlHost").value.trim(),
    port: Number(document.getElementById("mysqlPort").value),
    database: document.getElementById("mysqlDatabase").value.trim(),
    user: document.getElementById("mysqlUser").value.trim(),
    password: document.getElementById("mysqlPassword").value,
  };
}

function readAccountForm() {
  const username = document.getElementById("accountUsername").value.trim();
  const password = document.getElementById("accountPassword").value;
  const confirmPassword = document.getElementById("accountPasswordConfirm").value;

  if (!username) {
    throw new Error("请填写管理员用户名。");
  }
  if (password.length < 4) {
    throw new Error("密码至少需要 4 位。");
  }
  if (password !== confirmPassword) {
    throw new Error("两次输入的密码不一致。");
  }
  return { username, password };
}

function setInputValue(id, value) {
  const input = document.getElementById(id);
  if (input && value !== undefined && value !== null) {
    input.value = value;
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
