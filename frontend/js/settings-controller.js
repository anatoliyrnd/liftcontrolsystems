import { offlineDB } from "./offline-db.js";
import { notify } from "./components/notify.js";
import { logHistoryAction } from "./history-logger.js";
import { userStore } from "./user-store.js"; // Добавлен импорт для проверки ролей

export class SettingsController {
  constructor(api, router) {
    this.api = api;
    this.router = router;
  }

  async mount() {
    await this._initLocalSettings();
    this._initOrgKey();
  }

  // --- ЛОГИКА КЛЮЧА ОРГАНИЗАЦИИ ---
  _initOrgKey() {
    const block = document.getElementById("orgKeyBlock");
    const input = document.getElementById("orgKeyInput");
    const btnEdit = document.getElementById("editOrgKeyBtn");
    const btnSave = document.getElementById("saveOrgKeyBtn");
    const btnCancel = document.getElementById("cancelOrgKeyBtn");

    if (!block || !input) return;

    const currentKey = localStorage.getItem("org_key");
    const isAdmin = userStore.isAdmin();
    const isDispatcher = userStore.isDispatcher();

    // 1. Логика отображения блока (кто видит)
    if (isAdmin || isDispatcher) {
      block.style.display = "block";
    } else {
      block.style.display = "none"; // Инженеры и гости не видят
      return;
    }

    // 2. Начальное состояние UI
    const setDisplayMode = () => {
      const key = localStorage.getItem("org_key");
      input.value = key ? "********" : ""; // Звездочки, если ключ есть
      input.disabled = true;
      input.type = "text"; // Или 'password' если хочешь реальные звездочки, но мы договорились текст

      btnEdit.style.display = "none";
      btnSave.style.display = "none";
      btnCancel.style.display = "none";

      // Кнопку "Редактировать" видит админ всегда, а диспетчер - только если ключ пуст
      if (isAdmin || (isDispatcher && !key)) {
        btnEdit.style.display = "inline-block";
      }
    };

    setDisplayMode();

    // 3. Обработчик кнопки "Редактировать"
    btnEdit.onclick = () => {
      input.disabled = false;
      input.value = localStorage.getItem("org_key") || ""; // Показываем реальный ключ для правки
      input.focus();

      btnEdit.style.display = "none";
      btnSave.style.display = "inline-block";
      btnCancel.style.display = "inline-block";
    };

    // 4. Обработчик кнопки "Отмена"
    btnCancel.onclick = () => {
      setDisplayMode();
    };

    // 5. Обработчик кнопки "Сохранить ключ"
    btnSave.onclick = async () => {
      const newKey = input.value.trim();

      if (newKey === "") {
        // Удаление ключа
        if (
          confirm(
            "Вы уверены, что хотите удалить ключ организации с этого устройства?",
          )
        ) {
          localStorage.removeItem("org_key");
          notify.success("Ключ организации удален");
          logHistoryAction("Удален ключ организации");
          setDisplayMode();
        }
        return;
      }

      if (newKey === localStorage.getItem("org_key")) {
        setDisplayMode();
        return; // Ключ не изменился
      }

      btnSave.disabled = true;
      btnSave.textContent = "Проверка...";

      try {
        const resp = await this.api.post(
          { data: "check_org_key", org_key: newKey },
          "Проверка ключа...",
        );

        if (resp && resp.status === "ok") {
          localStorage.setItem("org_key", newKey);
          notify.success("Ключ организации успешно сохранен");
          logHistoryAction("Обновлен ключ организации");
          setDisplayMode();
        } else {
          notify.error(resp.message || "Неверный ключ организации");
        }
      } catch (e) {
        console.error(e);
        notify.error("Сбой сети при проверке ключа");
      } finally {
        btnSave.disabled = false;
        btnSave.textContent = "Сохранить ключ";
      }
    };
  }

  // --- СТАРАЯ ЛОГИКА (Город и Кэш) ---
  async _initLocalSettings() {
    const cities = await offlineDB.getCities();
    const select = document.getElementById("settingsDefaultCity");
    if (select) {
      select.innerHTML = '<option value="">— Не выбран —</option>';
      cities.forEach((c) => {
        const opt = document.createElement("option");
        opt.value = c.id;
        opt.textContent = c.name;
        select.appendChild(opt);
      });

      const current = await offlineDB.getConfig("default_city_id");
      if (current) select.value = current;
    }

    const saveCityBtn = document.getElementById("saveDefaultCityBtn");
    if (saveCityBtn) {
      saveCityBtn.onclick = async () => {
        const val = select.value ? Number(select.value) : null;
        await offlineDB.setConfig("default_city_id", val);
        notify.success("Город по умолчанию сохранен");
        logHistoryAction("Изменен город по умолчанию");
      };
    }

    const clearBtn = document.getElementById("clearAddressCacheBtn");
    if (clearBtn) {
      clearBtn.onclick = async () => {
        if (
          confirm(
            "Вы уверены, что хотите удалить кэш адресов? Придется скачать их заново.",
          )
        ) {
          await offlineDB.saveAddresses([]);
          localStorage.removeItem("recent_addresses");
          notify.warning("Кэш адресов очищен. Перезагрузка...");
          setTimeout(() => window.location.reload(), 1500);
        }
      };
    }
  }
}
