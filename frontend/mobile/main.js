import { ListController } from "./controllers/list-controller.js";
import { CardController } from "./controllers/card-controller.js";
import { LoginController } from "./controllers/login-controller.js";
import { ClosedController } from "./controllers/closed-controller.js";
import { ProfileController } from "./controllers/profile-controller.js";
import { syncManager } from "./sync-manager.js";
import { authStore } from "./auth-store.js";

const closedController = new ClosedController();
const listController = new ListController();
const cardController = new CardController();
const loginController = new LoginController();
const profileController = new ProfileController();

function updateBottomNav(route) {
  document.querySelectorAll(".nav-item").forEach((el) => {
    el.classList.remove("active");
    const href = el.getAttribute("href");
    if (href === route || (route.startsWith("#/detail") && href === "#/list")) {
      el.classList.add("active");
    }
  });
}
async function handleRoute() {
  let hash = window.location.hash || "#/list";

  // 1. Проверка авторизации
  let isAuthorized = authStore.hasAccess();
  if (!isAuthorized) {
    const offlineToken = localStorage.getItem("mob_offline_token");
    const offlineUser = localStorage.getItem("mob_offline_user");
    if (offlineToken && offlineUser) {
      authStore.setSession(offlineToken, null, JSON.parse(offlineUser));
      isAuthorized = true;
    }
  }

  if (!isAuthorized && hash !== "#/login") {
    window.location.hash = "#/login";
    return;
  }

  if (isAuthorized && hash === "#/login") {
    window.location.hash = "#/list";
    return;
  }

  // 2. ЕДИНАЯ ОЧИСТКА ВСЕХ ЭКРАНОВ (без дублей)
  cardController.unmount();
  profileController.unmount();
  listController.unmount();
  closedController.unmount();
  loginController.unmount();

  document
    .querySelectorAll(".view")
    .forEach((el) => el.classList.remove("active"));
  const bottomNav = document.querySelector(".bottom-nav");

  // 3. Роутинг
  if (hash === "#/login") {
    bottomNav.style.display = "none";
    loginController.mount();
  } else {
    bottomNav.style.display = "flex";
    updateBottomNav(hash);

    if (hash === "#/list") {
      await listController.mount();
    } else if (hash === "#/closed") {
      await closedController.mount();
    } else if (hash.startsWith("#/detail/")) {
      const ticketId = hash.split("/")[2];
      await cardController.mount(ticketId);
    } else if (hash === "#/tasks") {
      const main = document.querySelector(".app-content");
      let tasksView = document.getElementById("view-tasks");
      if (!tasksView) {
        tasksView = document.createElement("div");
        tasksView.id = "view-tasks";
        tasksView.className = "view";
        tasksView.innerHTML = `<div style="text-align:center; padding: 40px; color: var(--text-muted);">Раздел Задачи (в разработке)...</div>`;
        main.appendChild(tasksView);
      }
      tasksView.classList.add("active");
    } else if (hash === "#/profile") {
      profileController.mount();
    }
  }
}
document.addEventListener("DOMContentLoaded", () => {
  window.addEventListener("hashchange", handleRoute);
  handleRoute();

  if ("serviceWorker" in navigator) {
    // Если при загрузке страницы уже есть контроллер, значит это не первый запуск
    let isFirstInstall = !navigator.serviceWorker.controller;

    navigator.serviceWorker.register("./sw.js").then((reg) => {
      // Проверяем, не ждет ли уже новый SW (например, пользователь отказался от обновления в прошлый раз)
      if (reg.waiting && navigator.serviceWorker.controller) {
        promptUpdate(reg);
      }

      // Слушаем фоновую установку нового SW
      reg.addEventListener("updatefound", () => {
        const newWorker = reg.installing;

        newWorker.addEventListener("statechange", () => {
          // Если новый SW установлен и есть активный контроллер (старая версия)
          if (
            newWorker.state === "installed" &&
            navigator.serviceWorker.controller
          ) {
            promptUpdate(reg);
          }
        });
      });
    });

    // Перезагружаем страницу ТОЛЬКО когда SW фактически сменился
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (isFirstInstall) return;
      window.location.reload();
    });

    function promptUpdate(reg) {
      ui.confirm(
        "Доступна новая версия приложения. Перезагрузить страницу сейчас?",
        "Обновление",
      ).then((yes) => {
        if (yes) {
          // Отправляем команду новому SW активироваться
          reg.waiting.postMessage("SKIP_WAITING");
        }
      });
    }
  }
  // ==========================================================================
  // ПРИНУДИТЕЛЬНАЯ СИНХРОНИЗАЦИЯ ПО КНОПКЕ
  // ==========================================================================
  const syncBtn = document.getElementById("syncBtn");
  if (syncBtn) {
    syncBtn.addEventListener("click", async () => {
      if (syncManager.isSyncing) return; // Защита от спама кликами

      // Визуальный отклик: крутим иконку
      const svgIcon = syncBtn.querySelector("svg");
      if (svgIcon) {
        svgIcon.style.transition = "transform 1s linear";
        svgIcon.style.transform = "rotate(360deg)";
      }

      console.log("[UI] Принудительная синхронизация...");
      await syncManager.startSync();

      // Возвращаем иконку в исходное положение
      setTimeout(() => {
        if (svgIcon) {
          svgIcon.style.transition = "none";
          svgIcon.style.transform = "rotate(0deg)";
        }
      }, 1000);
    });
  }
  if (authStore.hasAccess() || localStorage.getItem("mob_offline_token")) {
    if (navigator.onLine) {
      syncManager.updateNetworkStatus("online");
      setTimeout(() => syncManager.startSync(), 1000);
    } else {
      syncManager.updateNetworkStatus("offline");
    }
  }
  // ==========================================================================
  // ОБРАБОТКА ПОТЕРИ СЕССИИ (Токен протух, устройство не совпало и т.д.)
  // ==========================================================================
  window.addEventListener("auth:lost", (e) => {
    console.warn("[App] Сессия потеряна. Причина:", e.detail?.reason);

    // Очищаем локальные данные
    authStore.clear();
    localStorage.removeItem("mob_offline_token");
    localStorage.removeItem("mob_offline_user");

    // Показываем уведомление и редиректим на логин
    ui.alert(
      "Сессия истекла. Пожалуйста, авторизуйтесь снова.",
      "Доступ закрыт",
    ).then(() => {
      window.location.hash = "#/login";
      window.location.reload(); // Перезагрузка очистит состояние в памяти
    });
  });
});
