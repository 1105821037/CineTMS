import { getSetupStatus, apiPost } from "../api.js";
import { updateUserDisplay } from "../layout.js";
import { setAuthenticatedUser } from "../state.js";

export function initLoginPage() {
  const form = document.getElementById("loginForm");
  const errorBox = document.getElementById("loginError");
  if (!form) {
    return;
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const submit = form.querySelector('button[type="submit"]');
    const username = document.getElementById("loginUsername").value.trim();
    const password = document.getElementById("loginPassword").value;

    errorBox?.classList.add("hidden");
    submit.disabled = true;
    submit.innerHTML = '<span class="loading loading-spinner loading-sm"></span> 登录中';

    try {
      const result = await apiPost("/api/auth/login", { username, password });
      setAuthenticatedUser(result.user);
      updateUserDisplay(result.user.username);
      const setupStatus = await getSetupStatus();
      window.location.replace(setupStatus.completed ? "#/home" : "#/setup");
    } catch (error) {
      if (errorBox) {
        errorBox.classList.remove("hidden");
        errorBox.querySelector("span").textContent = error instanceof Error
          ? error.message
          : "登录失败，请检查用户名和密码。";
      }
      submit.disabled = false;
      submit.innerHTML = '<i class="fas fa-right-to-bracket"></i> 登录';
    }
  });
}
