import { authStore } from "../auth-store.js";
import { notify } from "./notify.js";
import { logHistoryAction } from "../history-logger.js";
import { NotificationsPoller } from "../notifications-poller.js";
import { InactivityTracker } from "../route/inactivity-tracker.js";
import { ApiService } from "../api-service.js"; // Для AUTH_LOST_EVENT

let notifPoller = null;
let inactivityTracker = null;

export function initNavbar(api, router) {
  const historyWrapper = document.getElementById("historyWrapper");
  const userProfileWrapper = document.getElementById("userProfileWrapper");
  const navUserAvatar = document.getElementById("navUserAvatar");
  const navUserName = document.getElementById("navUserName");
  const userProfileBtn = document.getElementById("userProfileBtn");
  const userDropdown = document.getElementById("userDropdown");
  const logoutBtn = document.getElementById("logoutBtn");
  const navLogo = document.getElementById("navLogo");

  // 1. Функция синхронизации UI
  const syncAuthUI = () => {
    const user = authStore.getUser();
    const isAuth = authStore.hasAccess();

    if (isAuth && user) {
      if (historyWrapper) historyWrapper.style.display = "flex";
      if (userProfileWrapper) userProfileWrapper.style.display = "flex";

      if (navUserName) navUserName.textContent = user.name || "Пользователь";
      if (navUserAvatar) {
        navUserAvatar.textContent = user.name
          ? user.name.charAt(0).toUpperCase()
          : "U";
      }

      if (!notifPoller) {
        notifPoller = new NotificationsPoller(api);
        notifPoller.start();
      }
      if (!inactivityTracker) {
        inactivityTracker = new InactivityTracker(router, 30 * 60 * 1000);
        inactivityTracker.startTracking();
      }
    } else {
      if (historyWrapper) historyWrapper.style.display = "none";
      if (userProfileWrapper) userProfileWrapper.style.display = "none";

      if (notifPoller) {
        notifPoller.stop();
        notifPoller = null;
      }
      if (inactivityTracker) {
        inactivityTracker.stopTracking();
        inactivityTracker = null;
      }
      const menu = document.getElementById("dynamicMenu");
      if (menu) menu.innerHTML = "";
    }
  };

  // 2. Обработчики
  if (userProfileBtn && userDropdown) {
    userProfileBtn.onclick = (e) => {
      e.stopPropagation();
      const isOpen = userDropdown.classList.contains("show");
      if (isOpen) {
        userDropdown.classList.remove("show");
        userProfileWrapper.classList.remove("open");
      } else {
        userDropdown.classList.add("show");
        userProfileWrapper.classList.add("open");
      }
    };

    document.addEventListener("click", (e) => {
      if (!userProfileWrapper.contains(e.target)) {
        userDropdown.classList.remove("show");
        userProfileWrapper.classList.remove("open");
      }
    });
  }

  if (logoutBtn) {
    logoutBtn.onclick = async () => {
      await api.logout();
      authStore.clear();
      syncAuthUI();
      logHistoryAction("Вы вышли из системы");
      notify.info("Вы вышли из системы");
      router.navigate("#/login");
    };
  }

  if (navLogo) {
    navLogo.addEventListener("click", () => router.navigate("#/"));
  }

  // 3. Подписка на потерю сессии
  window.addEventListener(ApiService.AUTH_LOST_EVENT, (e) => {
    authStore.clear();
    syncAuthUI();
    const reason = e.detail && e.detail.reason;
    let msg = "Сессия истекла, войдите заново";
    if (reason === "device_mismatch")
      msg = "Устройство изменилось, войдите заново";
    logHistoryAction(msg);
    notify.warning(msg);
    router.navigate("#/login");
  });

  // Возвращаем функцию, чтобы main.js мог вызвать её при старте
  return syncAuthUI;
}
