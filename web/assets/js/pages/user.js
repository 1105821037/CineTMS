import { apiDelete, apiGet, apiPost } from "../api.js";

export function initUserPage() {
  loadUserList();
  bindChangePassword();
  bindAddUser();
  bindResetPassword();

  document.getElementById("addUserBtn")?.addEventListener("click", () => {
    document.getElementById("addUserError").classList.add("hidden");
    document.getElementById("addUserForm").reset();
    document.getElementById("addUserModal").showModal();
  });
}

let currentUserId = null;

async function loadUserList() {
  const container = document.getElementById("userListContainer");
  try {
    const payload = await apiGet("/api/users");
    currentUserId = payload.currentUserId;
    renderUserList(container, payload.users);
  } catch (error) {
    container.innerHTML = `<div class="text-error text-sm">${escapeHtml(error.message)}</div>`;
  }
}

function renderUserList(container, users) {
  if (!users || users.length === 0) {
    container.innerHTML = `<p class="text-sm text-base-content/60">暂无用户</p>`;
    return;
  }

  const rows = users.map((user) => {
    const isSelf = user.id === currentUserId;
    return `
      <tr>
        <td class="text-sm">${escapeHtml(user.username)}${isSelf ? ' <span class="badge badge-xs badge-primary">当前</span>' : ""}</td>
        <td class="text-sm text-base-content/60">${formatDate(user.createdAt)}</td>
        <td class="text-right">
          <button class="btn btn-ghost btn-xs" data-reset-id="${user.id}" data-reset-name="${escapeHtml(user.username)}" ${isSelf ? "disabled" : ""}>重置密码</button>
          <button class="btn btn-ghost btn-xs text-error" data-delete-id="${user.id}" ${isSelf ? "disabled" : ""}>删除</button>
        </td>
      </tr>
    `;
  }).join("");

  container.innerHTML = `
    <div class="overflow-x-auto">
      <table class="table table-sm">
        <thead>
          <tr>
            <th>用户名</th>
            <th>创建时间</th>
            <th class="text-right">操作</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;

  container.querySelectorAll("[data-delete-id]").forEach((btn) => {
    btn.addEventListener("click", () => handleDeleteUser(Number(btn.dataset.deleteId)));
  });

  container.querySelectorAll("[data-reset-id]").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.getElementById("resetPasswordUserId").value = btn.dataset.resetId;
      document.getElementById("resetPasswordUsername").textContent = btn.dataset.resetName;
      document.getElementById("resetPasswordError").classList.add("hidden");
      document.getElementById("resetPasswordForm").reset();
      document.getElementById("resetPasswordUserId").value = btn.dataset.resetId;
      document.getElementById("resetPasswordModal").showModal();
    });
  });
}

function bindChangePassword() {
  const form = document.getElementById("changePasswordForm");
  form?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const errorEl = document.getElementById("changePasswordError");
    const successEl = document.getElementById("changePasswordSuccess");
    errorEl.classList.add("hidden");
    successEl.classList.add("hidden");

    const oldPassword = document.getElementById("oldPassword").value;
    const newPassword = document.getElementById("newPassword").value;
    const confirmPassword = document.getElementById("confirmPassword").value;

    if (newPassword !== confirmPassword) {
      errorEl.textContent = "两次输入的新密码不一致。";
      errorEl.classList.remove("hidden");
      return;
    }

    try {
      await apiPost(`/api/users/${currentUserId}/password`, { oldPassword, newPassword });
      successEl.textContent = "密码修改成功。";
      successEl.classList.remove("hidden");
      form.reset();
    } catch (error) {
      errorEl.textContent = error.message;
      errorEl.classList.remove("hidden");
    }
  });
}

function bindAddUser() {
  const form = document.getElementById("addUserForm");
  form?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const errorEl = document.getElementById("addUserError");
    errorEl.classList.add("hidden");

    const username = document.getElementById("newUsername").value.trim();
    const password = document.getElementById("newUserPassword").value;

    try {
      await apiPost("/api/users", { username, password });
      document.getElementById("addUserModal").close();
      loadUserList();
    } catch (error) {
      errorEl.textContent = error.message;
      errorEl.classList.remove("hidden");
    }
  });
}

function bindResetPassword() {
  const form = document.getElementById("resetPasswordForm");
  form?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const errorEl = document.getElementById("resetPasswordError");
    errorEl.classList.add("hidden");

    const userId = document.getElementById("resetPasswordUserId").value;
    const newPassword = document.getElementById("resetNewPassword").value;

    try {
      await apiPost(`/api/users/${userId}/password`, { newPassword });
      document.getElementById("resetPasswordModal").close();
    } catch (error) {
      errorEl.textContent = error.message;
      errorEl.classList.remove("hidden");
    }
  });
}

async function handleDeleteUser(userId) {
  if (!confirm("确定要删除该用户吗？此操作不可撤销。")) {
    return;
  }
  try {
    await apiDelete(`/api/users/${userId}`);
    loadUserList();
  } catch (error) {
    alert(error.message);
  }
}

function formatDate(isoString) {
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return "-";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
