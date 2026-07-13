
const pageInitializers = {
  login: initLoginPage,
  setup: initSetupWizard,
};

function initRouter() {
  window.addEventListener("hashchange", handleRoute);
  window.addEventListener("load", handleRoute);
}

async function handleRoute() {
  const route = await resolveRoute();
  if (!route) {
    return;
  }

  await loadPage(route);

  if (window.innerWidth < 768) {
    closeSidebar();
  }
}

async function resolveRoute() {
  const hash = window.location.hash.slice(2) || "home";
  const page = hash.split("/")[0];
  const route = routes[page] ? page : "home";
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

  if (route === "login") {
    window.location.replace("#/home");
    return null;
  }

  return route;
}

function redirectUnless(currentRoute, expectedRoute) {
  if (currentRoute === expectedRoute) {
    return currentRoute;
  }
  window.location.replace(`#/${expectedRoute}`);
  return null;
}

async function loadPage(page) {
  const contentArea = document.getElementById("contentArea");
  const breadcrumb = document.getElementById("breadcrumb");
  document.body.classList.toggle("setup-mode", page === "setup" || page === "login");

  contentArea.innerHTML = `
    <div class="flex items-center justify-center h-full">
      <span class="loading loading-spinner loading-lg text-primary"></span>
    </div>
  `;

  try {
    const response = await fetch(routes[page], { cache: "no-cache" });
    if (!response.ok) {
      throw new Error("页面加载失败");
    }

    const html = await response.text();
    contentArea.innerHTML = `<div class="content-fade-in">${html}</div>`;
    breadcrumb.innerHTML = `<li><a href="#/home">首页</a></li><li>${pageTitles[page]}</li>`;
    updateActiveNav(page);
    pageInitializers[page]?.();
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
