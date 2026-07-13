
const setupState = {
  step: 0,
  tests: [false, false, false, false],
  account: null,
  hallsLoaded: false,
  halls: [],
  removedHalls: [],
  databaseExisted: false,
  finixxCinemaInfo: null,
  hallsWarning: "",
};

function initSetupWizard() {
  resetSetupState();

  document.querySelectorAll("[data-test-step]").forEach((button) => {
    button.addEventListener("click", () => testSetupStep(Number(button.dataset.testStep)));
  });

  ["mysqlHost", "mysqlPort", "mysqlDatabase", "mysqlUser", "mysqlPassword"].forEach((id) => {
    document.getElementById(id).addEventListener("input", () => resetSetupTest(0));
  });

  ["accountUsername", "accountPassword", "accountPasswordConfirm"].forEach((id) => {
    document.getElementById(id).addEventListener("input", () => resetSetupTest(1));
  });

  document.getElementById("finixxBaseUrl").addEventListener("input", () => {
    resetSetupTest(2);
    setupState.hallsLoaded = false;
    setupState.halls = [];
    setupState.finixxCinemaInfo = null;
    renderFinixxCinemaInfo();
  });

  document.getElementById("setupBack").addEventListener("click", () => {
    if (setupState.step > 0) {
      setupState.step -= 1;
      renderSetupStep();
      void saveCurrentDraft();
    }
  });

  document.getElementById("setupNext").addEventListener("click", () => {
    if (setupState.step < 3) {
      setupState.step += 1;
      renderSetupStep();
      if (setupState.step === 3 && !setupState.hallsLoaded) {
        void fetchFinixxHalls();
      }
      void saveCurrentDraft();
      return;
    }

    void completeSetup();
  });

  document.getElementById("setupSkipHalls").addEventListener("click", () => {
    setupState.removedHalls = setupState.removedHalls.concat(setupState.halls);
    setupState.halls = [];
    void completeSetup();
  });

  document.getElementById("fetchHallsButton").addEventListener("click", fetchFinixxHalls);

  applySetupDraft(appState.setupDraftCache);
  renderSetupStep();
  renderHallList();
  renderFinixxCinemaInfo();
  updateDatabaseExistsWarning();
}

function resetSetupState() {
  setupState.step = 0;
  setupState.tests = [false, false, false, false];
  setupState.account = null;
  setupState.hallsLoaded = false;
  setupState.halls = [];
  setupState.removedHalls = [];
  setupState.databaseExisted = false;
  setupState.finixxCinemaInfo = null;
  setupState.hallsWarning = "";
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

  if (draft.finixx) {
    setInputValue("finixxBaseUrl", draft.finixx.baseUrl);
    setupState.finixxCinemaInfo = draft.finixx.cinemaInfo || null;
  }

  setupState.step = Number.isInteger(draft.step) ? Math.max(0, Math.min(3, draft.step)) : 0;
  setupState.tests = Array.isArray(draft.tests) ? [
    Boolean(draft.tests[0]),
    Boolean(draft.tests[1]),
    Boolean(draft.tests[2]),
    Boolean(draft.tests[3]),
  ] : setupState.tests;
  setupState.databaseExisted = Boolean(draft.databaseExisted);
  setupState.halls = Array.isArray(draft.halls) ? draft.halls : [];
  setupState.removedHalls = Array.isArray(draft.removedHalls) ? draft.removedHalls : [];
  setupState.hallsLoaded = setupState.tests[2] || setupState.halls.length > 0 || setupState.removedHalls.length > 0;
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
  const skipHalls = document.getElementById("setupSkipHalls");

  back.disabled = setupState.step === 0;
  skipHalls.classList.toggle("hidden", setupState.step !== 3);
  next.innerHTML = setupState.step === 3
    ? '瀹屾垚鍚戝 <i class="fas fa-check"></i>'
    : '涓嬩竴姝?<i class="fas fa-angle-right"></i>';

  updateSetupNextState();
}

function updateSetupNextState() {
  const next = document.getElementById("setupNext");
  if (!next) {
    return;
  }

  if (setupState.step < 3) {
    next.disabled = !setupState.tests[setupState.step];
    return;
  }

  next.disabled = !setupState.hallsLoaded || !setupState.halls.every((hall) => hall.tested);
}

async function testSetupStep(step) {
  const button = document.querySelector(`[data-test-step="${step}"]`);
  button.disabled = true;
  button.innerHTML = '<span class="loading loading-spinner loading-sm"></span> 处理中';
  setTestResult(step, "", step === 1 ? "正在保存系统账号..." : "正在测试连接...");

  try {
    if (step === 0) {
      const result = await apiPost("/api/setup/database/test", readDatabaseForm());
      setupState.databaseExisted = Boolean(result.databaseExisted);
      updateDatabaseExistsWarning();
    } else if (step === 1) {
      const account = readAccountForm();
      const result = await apiPost("/api/setup/account", account);
      setupState.account = { username: account.username };
      setAuthenticatedUser(result.user);
    } else if (step === 2) {
      const result = await apiPost("/api/setup/finixx/test", readFinixxForm());
      setupState.halls = Array.isArray(result.halls) ? result.halls : [];
      setupState.hallsLoaded = true;
      setupState.removedHalls = [];
      setupState.finixxCinemaInfo = result.cinemaInfo || null;
      setupState.hallsWarning = result.hallsWarning || "";
      renderFinixxCinemaInfo();
    }

    setupState.tests[step] = true;
    setTestResult(step, "success", [
      "数据库连接测试通过，目标数据库已确认可用。",
      "系统账号已创建，可以继续下一步。",
      "售票系统连接成功，请核对下方影院信息。",
      "GDC放映服务器连接测试通过。",
    ][step]);
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

function getSetupTestButtonLabel(step, retest) {
  if (step === 0) {
    return retest
      ? '<i class="fas fa-plug"></i> 閲嶆柊娴嬭瘯骞跺垱寤烘暟鎹簱'
      : '<i class="fas fa-plug"></i> 娴嬭瘯骞跺垱寤烘暟鎹簱';
  }

  if (step === 1) {
    return retest
      ? '<i class="fas fa-floppy-disk"></i> 閲嶆柊淇濆瓨绯荤粺璐﹀彿'
      : '<i class="fas fa-floppy-disk"></i> 淇濆瓨绯荤粺璐﹀彿';
  }

  return retest
    ? '<i class="fas fa-link"></i> 閲嶆柊娴嬭瘯鍑ゅ嚢浣冲奖杩炴帴'
    : '<i class="fas fa-link"></i> 娴嬭瘯鍑ゅ嚢浣冲奖杩炴帴';
}

async function fetchFinixxHalls() {
  const hallList = document.getElementById("hallList");
  const button = document.getElementById("fetchHallsButton");

  button.disabled = true;
  button.innerHTML = '<span class="loading loading-spinner loading-sm"></span> 获取中';
  hallList.innerHTML = `
    <div class="flex items-center justify-center py-12">
      <span class="loading loading-spinner loading-lg text-primary"></span>
    </div>
  `;

  try {
    const result = await apiPost("/api/setup/finixx/test", readFinixxForm());
    setupState.hallsLoaded = true;
    setupState.halls = Array.isArray(result.halls) ? result.halls : [];
    setupState.removedHalls = [];
    setupState.finixxCinemaInfo = result.cinemaInfo || null;
    setupState.hallsWarning = result.hallsWarning || "";
    renderFinixxCinemaInfo();
    renderHallList();
    void saveCurrentDraft();
    button.innerHTML = '<i class="fas fa-rotate"></i> 重新获取影厅列表';
  } catch (error) {
    hallList.innerHTML = `
      <div class="alert alert-error">
        <i class="fas fa-circle-xmark"></i>
        <span>${error instanceof Error ? error.message : "获取影厅列表失败。"}</span>
      </div>
    `;
    button.innerHTML = '<i class="fas fa-cloud-arrow-down"></i> 获取影厅列表';
  } finally {
    button.disabled = false;
    updateSetupNextState();
  }
}

function renderHallList() {
  const hallList = document.getElementById("hallList");
  const notice = document.getElementById("removedHallNotice");

  notice?.classList.toggle("hidden", setupState.removedHalls.length === 0);

  if (setupState.halls.length === 0) {
    hallList.innerHTML = `
      <div class="alert alert-warning">
        <i class="fas fa-circle-info"></i>
        <span>${setupState.hallsWarning || "当前没有从售票系统获取到影厅列表。之后可以到“系统设置 > 影厅配置”中添加 GDC放映服务器连接。"}</span>
      </div>
    `;
    bindHallEvents();
    return;
  }

  hallList.innerHTML = setupState.halls.map((hall, index) => `
    <div class="hall-setup-row" data-hall-id="${escapeHtml(hall.id)}">
      <div class="hall-name-cell">
        <h4>${escapeHtml(hall.name)}</h4>
        <p>售票系统影厅编码：${escapeHtml(hall.id)}</p>
      </div>
      <input class="input input-bordered input-sm" data-hall-host="${index}" value="${escapeHtml(hall.host || "")}" placeholder="192.168.10.11">
      <input class="input input-bordered input-sm" data-hall-port="${index}" value="${escapeHtml(String(hall.port || ""))}" placeholder="5000">
      <div class="hall-status-cell">
        <div class="setup-test-result ${hall.tested ? "success" : ""}" data-hall-result="${index}">
          ${hall.tested ? `
            <div class="hall-test-result-summary">
              <i class="fas fa-check-circle"></i>
              <span>连接成功</span>
            </div>
            ${renderGdcDeviceInfo(hall.gdcDeviceInfo)}
          ` : `
            <i class="fas fa-circle-info"></i>
            待测试
          `}
        </div>
      </div>
      <div class="hall-actions-cell">
        <button type="button" class="btn btn-primary btn-sm" data-hall-test="${index}">
          <i class="fas fa-plug"></i>
          测试
        </button>
        <button type="button" class="btn btn-ghost btn-sm text-error" data-hall-remove="${index}" title="从本次向导移除">
          <i class="fas fa-trash"></i>
        </button>
      </div>
    </div>
  `).join("");

  bindHallEvents();
  setupState.halls.forEach((hall, index) => {
    if (hall.tested) {
      renderHallTestResult(index);
    }
  });
}

function bindHallEvents() {
  document.querySelectorAll("[data-hall-host], [data-hall-port]").forEach((input) => {
    input.addEventListener("input", () => {
      const index = Number(input.dataset.hallHost ?? input.dataset.hallPort);
      if (input.dataset.hallHost !== undefined) {
        setupState.halls[index].host = input.value;
      } else {
        setupState.halls[index].port = input.value;
      }
      setupState.halls[index].tested = false;
      setupState.halls[index].gdcDeviceInfo = null;
      renderHallTestResult(index);
      updateSetupNextState();
      void saveCurrentDraft();
    });
  });

  document.querySelectorAll("[data-hall-test]").forEach((button) => {
    button.addEventListener("click", () => testHallConnection(Number(button.dataset.hallTest), button));
  });

  document.querySelectorAll("[data-hall-remove]").forEach((button) => {
    button.addEventListener("click", () => {
      const [removedHall] = setupState.halls.splice(Number(button.dataset.hallRemove), 1);
      if (removedHall) {
        setupState.removedHalls.push(removedHall);
      }
      renderHallList();
      updateSetupNextState();
      void saveCurrentDraft();
    });
  });
}

async function testHallConnection(index, button) {
  const hall = setupState.halls[index];
  const result = document.querySelector(`[data-hall-result="${index}"]`);

  if (!hall.host || !hall.port) {
    result.classList.remove("success");
    result.classList.add("error");
    result.innerHTML = '<i class="fas fa-circle-xmark"></i>请先填写 GDC放映服务器地址和端口。';
    return;
  }

  button.disabled = true;
  button.innerHTML = '<span class="loading loading-spinner loading-sm"></span> 测试中';
  result.classList.remove("success", "error");
  result.innerHTML = '<i class="fas fa-circle-info"></i>正在测试 GDC放映服务器连接...';

  try {
    const response = await apiPost("/api/setup/gdc/test", { host: hall.host, port: hall.port });
    hall.tested = true;
    hall.gdcDeviceInfo = response.deviceInfo || null;
    renderHallTestResult(index);
    button.innerHTML = '<i class="fas fa-rotate"></i> 重测';
  } catch (error) {
    hall.tested = false;
    hall.gdcDeviceInfo = null;
    result.classList.add("error");
    result.innerHTML = `<i class="fas fa-circle-xmark"></i>${error instanceof Error ? error.message : "GDC放映服务器连接测试失败。"}`;
    button.innerHTML = '<i class="fas fa-plug"></i> 测试';
  } finally {
    button.disabled = false;
    updateSetupNextState();
    void saveCurrentDraft();
  }
}

async function saveCurrentDraft() {
  if (!setupState.tests[0]) {
    return;
  }

  await apiPost("/api/setup/draft", {
    step: setupState.step,
    tests: setupState.tests,
    databaseExisted: setupState.databaseExisted,
    account: setupState.account,
    finixx: readFinixxForm(),
    halls: setupState.halls,
    removedHalls: setupState.removedHalls,
  }).catch(() => undefined);
}

async function completeSetup() {
  const next = document.getElementById("setupNext");
  const skipHalls = document.getElementById("setupSkipHalls");
  next.disabled = true;
  skipHalls.disabled = true;

  try {
    await apiPost("/api/setup/complete", {
      finixx: readFinixxForm(),
      halls: setupState.halls,
      removedHalls: setupState.removedHalls,
    });
    clearSetupStatusCache();
    document.body.classList.remove("setup-mode");
    window.location.replace("#/home");
  } catch (error) {
    next.disabled = false;
    skipHalls.disabled = false;
    document.getElementById("hallList").insertAdjacentHTML("beforebegin", `
      <div class="alert alert-error mb-4">
        <i class="fas fa-circle-xmark"></i>
        <span>${error instanceof Error ? error.message : "保存配置失败。"}</span>
      </div>
    `);
  }
}

function resetSetupTest(step) {
  if (!setupState.tests[step]) {
    return;
  }

  setupState.tests[step] = false;
  if (step === 0) {
    setupState.databaseExisted = false;
    updateDatabaseExistsWarning();
    void saveCurrentDraft();
  } else if (step === 1) {
    setupState.account = null;
  }
  setTestResult(step, "", "配置已修改，继续下一步前需要重新测试或保存。");
  updateSetupNextState();
}

function setTestResult(step, type, message) {
  const result = document.querySelector(`[data-test-result="${step}"]`);
  if (!result) {
    return;
  }

  result.classList.remove("success", "error");
  if (type) {
    result.classList.add(type);
  }
  const icon = type === "success" ? "fa-check-circle" : type === "error" ? "fa-circle-xmark" : "fa-circle-info";
  result.innerHTML = `<i class="fas ${icon}"></i>${message}`;
}

function updateDatabaseExistsWarning() {
  document.getElementById("databaseExistsWarning")?.classList.toggle("hidden", !setupState.databaseExisted);
}

function renderFinixxCinemaInfo() {
  const card = document.getElementById("finixxCinemaInfo");
  if (!card) {
    return;
  }

  const info = setupState.finixxCinemaInfo;
  card.classList.toggle("hidden", !info);
  if (!info) {
    return;
  }

  ["locationCode", "locationName", "workstationId", "workstationName"].forEach((key) => {
    const target = card.querySelector(`[data-finixx-info="${key}"]`);
    if (target) {
      target.textContent = info[key] || "-";
    }
  });
}

function renderHallTestResult(index) {
  const hall = setupState.halls[index];
  const result = document.querySelector(`[data-hall-result="${index}"]`);
  if (!hall || !result) {
    return;
  }

  result.classList.remove("success", "error");

  if (!hall.tested) {
    result.innerHTML = '<i class="fas fa-circle-info"></i>待测试';
    return;
  }

  result.classList.add("success");
  result.innerHTML = `
    <div class="hall-test-result-summary">
      <i class="fas fa-check-circle"></i>
      <span>连接成功</span>
    </div>
    ${renderGdcDeviceInfo(hall.gdcDeviceInfo)}
  `;
}

function renderGdcDeviceInfo(deviceInfo) {
  const fields = [
    { label: "设备码", value: deviceInfo?.serial, emphasized: true },
    { label: "型号", value: deviceInfo?.model },
    { label: "软件版本", value: deviceInfo?.softwareVersion },
    { label: "固件版本", value: deviceInfo?.firmwareVersion },
  ].filter((item) => item.value);

  if (fields.length === 0) {
    return `
      <div class="hall-device-info">
        <div class="is-serial">
          <span>设备码</span>
          <strong>未获取到</strong>
        </div>
      </div>
    `;
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
    throw new Error("请填写系统账号用户名。");
  }
  if (password.length < 4) {
    throw new Error("密码至少需要 4 位。");
  }
  if (password !== confirmPassword) {
    throw new Error("两次输入的密码不一致。");
  }
  return { username, password };
}

function readFinixxForm() {
  return {
    baseUrl: document.getElementById("finixxBaseUrl").value.trim(),
    cinemaInfo: setupState.finixxCinemaInfo,
  };
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
