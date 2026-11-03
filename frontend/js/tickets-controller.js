import { rebuildTableHeaders } from "./table/header-render.js";
import { renderTableBody } from "./table/body-render.js";
import { sortRows } from "./table/sorting.js";
import { buildRowsCache, applyFilter } from "./table/filtering.js";
import { renderPeriodSelector } from "./table/period-selector.js";
import { API, UI } from "./config.js";
import { logHistoryAction } from "./history-logger.js";
import { offlineDB } from "./offline-db.js";
import { nowTs } from "./utils/date-utils.js";

export class TicketsController {
  /**
   * @param {ApiService} apiInstance
   * @param {Router} routerInstance
   * @param {string} dataType - 'open' | 'close'
   */
  constructor(apiInstance, routerInstance, dataType = "open") {
    this.api = apiInstance;
    this.router = routerInstance;
    this.dataType = dataType;
    this.selectedDays =
      localStorage.getItem("tablePeriod_" + this.dataType) || "1";
    this.rowsCache = [];

    // ВОССТАНАВЛИВАЕМ СОРТИРОВКУ ИЗ LOCALSTORAGE
    const savedSortId = localStorage.getItem(
      "tableSortColumn_" + this.dataType,
    );
    this.currentSortColumnId = savedSortId ? parseInt(savedSortId, 10) : -1;
    const savedSortDir = localStorage.getItem("tableSortDir_" + this.dataType);
    this.isAscending = savedSortDir !== "desc"; // По умолчанию true (по возрастанию)

    this.refreshIntervalId = null;
    this.isLoaded = false;
    this._searchDebounceTimer = null;
    this._isPolling = false;
    this._filtersAbort = null;
    this._filters = {
      cities: [],
      hideLongRepair: false,
    };
    this._allCities = [];

    // 🔥 ДОБАВЛЕНО: Защита от повторной подписки и биндинг обработчика
    this._isSubscribedToAddresses = false;
    this._onAddressesUpdated = this._onAddressesUpdated.bind(this);
    
  }

  async mount(globalTicketsArrayRef) {
    const dataTable = document.getElementById("dataTable");
    if (!dataTable) return;
await this._loadPendingState();
    dataTable.setAttribute("data-mode", this.dataType);

    if (this.dataType === "open") {
      await this._initFilters();
      await this._updateSyncButton();
    } else {
      const filtersBlock = document.getElementById("openOnlyFilters");
      if (filtersBlock) filtersBlock.style.display = "none";
    }

    this._initPeriodSelector(globalTicketsArrayRef);

    // ПРИНУДИТЕЛЬНО УДАЛЯЕМ СТАРУЮ ШАПКУ.
    // Это гарантирует, что если пользователь поменял порядок колонок в ЛК,
    // при возврате на главную таблица перестроится с новым порядком.
    const oldThead = dataTable.querySelector("thead");
    if (oldThead) oldThead.remove();

    const hadData = globalTicketsArrayRef.length > 0;
    this._renderTableFull(dataTable, globalTicketsArrayRef);

    if (this.currentSortColumnId !== -1) {
      this._reApplyCurrentSort();
    }

    const needBlockingLoad = !this.isLoaded || !hadData;

    const loadData = async (isSilent) => {
      const fresh = await this._loadDataFromServer(isSilent);
      let offlineTickets = [];

      if (this.dataType === "open") {
        const outbox = await offlineDB.getAllFromOutbox();
        offlineTickets = outbox.map((o) => {
          const createdAt = Number(o.created_at);
          // Защита от миллисекунд в офлайн-заявках
          const dateInSeconds =
            createdAt > 9999999999 ? Math.floor(createdAt / 1000) : createdAt;
          return {
            ...o.payload,
            id: o.uuid,
            type: "open",
            isOffline: true,
            address: o.payload.fullAddress || o.payload.address,
            date: dateInSeconds,
          };
        });
      }

      if (fresh) {
        // 1. Если сеть есть — показываем свежие данные
        globalTicketsArrayRef.length = 0;
        globalTicketsArrayRef.push(...offlineTickets, ...fresh);
        // И сохраняем их в кэш (на случай, если следующий раз откроем без сети)
        await offlineDB.saveTickets(this.dataType, fresh);
      } else {
        // 2. Если сети нет (fresh === null) — берем данные из кэша!
        logHistoryAction("Нет соединения. Загрузка из офлайн-кэша...");
        const cached = await offlineDB.getTickets(this.dataType);
        if (cached.length > 0) {
          globalTicketsArrayRef.length = 0;
          globalTicketsArrayRef.push(...offlineTickets, ...cached);
        } else {
          logHistoryAction("Кэш пуст. Нет данных для отображения.");
        }
      }

      this._renderTableFull(dataTable, globalTicketsArrayRef);

      if (this.currentSortColumnId !== -1) {
        this._reApplyCurrentSort();
      }
    };

    if (needBlockingLoad) {
      await loadData(false);
    } else {
      loadData(true);
    }

    if (this.refreshIntervalId) {
      clearInterval(this.refreshIntervalId);
      this.refreshIntervalId = null;
    }

    if (this.dataType === "open") {
      this.refreshIntervalId = setInterval(async () => {
        const hash = window.location.hash || "#/";
        if (hash !== "#/") {
          this.unmount();
          return;
        }

        if (this._isPolling) return;
        this._isPolling = true;

        try {
          await loadData(true);
        } catch (e) {
          console.error("[TicketsController] Background refresh failed:", e);
          logHistoryAction("Фоновое обновление: " + (e.message || "ошибка"));
        } finally {
          this._isPolling = false;
        }
      }, API.TICKETS_REFRESH_MS);
    }

    // 🔥 ДОБАВЛЕНО: Подписка на событие обновления адресов (с защитой от дублей)
    if (!this._isSubscribedToAddresses) {
      window.addEventListener("addresses:updated", this._onAddressesUpdated);
      this._isSubscribedToAddresses = true;
    }
  }

  unmount() {
    if (this.refreshIntervalId) {
      clearInterval(this.refreshIntervalId);
      this.refreshIntervalId = null;
    }
    if (this._filtersAbort) {
      this._filtersAbort.abort();
      this._filtersAbort = null;
    }
    this.isPolling = false;
    this.api.abortTag("tickets_" + this.dataType);

    if (this._searchDebounceTimer) {
      clearTimeout(this._searchDebounceTimer);
      this._searchDebounceTimer = null;
    }

    // 🔥 ДОБАВЛЕНО: Отписка от события обновления адресов
    if (this._isSubscribedToAddresses) {
      window.removeEventListener("addresses:updated", this._onAddressesUpdated);
      this._isSubscribedToAddresses = false;
    }
  }

  // 🔥 ДОБАВЛЕНО: Обработчик фонового обновления справочника адресов
  async _onAddressesUpdated() {
    await this._loadPendingState();
    console.log("[TicketsController] Адреса загружены в фоне, обновляем фильтр городов.");
    this._allCities = await offlineDB.getCities();

    if (this._allCities.length > 0) {
      // Если фильтр был пуст (так как кэш был пуст при старте), выбираем все города
      if (this._filters.cities.length === 0) {
        this._filters.cities = this._allCities.map((c) => c.id);
      }
      this._renderCityDropdown();
      this._applyLocalFilters(); // Перерисовываем таблицу с новыми городами
    }
  }
/**
 * Кэширует pending-команды в памяти контроллера:
 *   _pendingCommandMap: Map<ticket_id, cmd[]>  (Edit/Close/Comment для серверных заявок)
 *   _pendingCloseMap:   Map<ticket_id, cmd>    (только CloseTicket)
 *   _openCache:         Array (для синтетических закрытых из pending)
 */
async _loadPendingState() {
    const all = await offlineDB.getAllPending();
    this._pendingCommandMap = new Map();
    this._pendingCloseMap = new Map();

    for (const cmd of all) {
        if (cmd.status !== 'pending') continue;
        if (cmd.ticket_id == null) continue; // офлайн-созданные обрабатываются отдельно
        const key = String(cmd.ticket_id);
        if (!this._pendingCommandMap.has(key)) this._pendingCommandMap.set(key, []);
        this._pendingCommandMap.get(key).push(cmd);

        if (cmd.command_type === 'CloseTicket') {
            this._pendingCloseMap.set(key, cmd);
        }
    }

    if (this.dataType === 'close' && this._pendingCloseMap.size > 0) {
        this._openCache = await offlineDB.getTickets('open');
    }
}
  async _loadDataFromServer(isSilent = false) {
    try {
      const postPayload = { data: this.dataType };
      const statusMessage = isSilent ? null : "Синхронизация инцидентов...";

      if (this.dataType === "close") {
        postPayload.period = this.selectedDays;
      }

      const data = await this.api.post(
        postPayload,
        statusMessage,
        "tickets_" + this.dataType,
      );

      if (data && data.code === "aborted") return null;
      if (!data || data.status === "error") {
        throw new Error((data && data.message) || "Сбой структуры БД");
      }
      if (!Array.isArray(data)) {
        throw new Error("Ожидался массив заявок, получено: " + typeof data);
      }

      data.forEach((item) => {
        item.type = this.dataType; // Принудительно
        if (!item.address && item.fullAddress) {
          item.address = item.fullAddress;
        }
      });

      this.isLoaded = true;
      if (!isSilent) logHistoryAction("Журнал успешно импортирован.");
      return data;
    } catch (error) {
      console.error("[TicketsController] Load error:", error);
      logHistoryAction("Сбой сети: " + (error.message || "нет соединения"));
      return null;
    }
  }

  _renderTableFull(dataTable, globalTicketsArrayRef) {
    this._currentTicketsRef = globalTicketsArrayRef;
    let filteredData = [...globalTicketsArrayRef];

    if (this.dataType === "open") {
      // Фильтрация по timestamp (в секундах)
      // Явно переводим Date.now() в секунды
      const nowSeconds = Math.floor(Date.now() / 1000);
      const maxDateTs = nowSeconds + UI.FILTER_REPAIR_DAYS * 24 * 60 * 60;

      const cityFilterActive =
        this._allCities.length > 0 && this._filters.cities.length > 0;

   filteredData = filteredData.filter((t) => {
    if (
        cityFilterActive &&
        t.city_id &&
        !this._filters.cities.includes(Number(t.city_id))
    ) {
        return false;
    }

    if (this._filters.hideLongRepair) {
        const rTs = Number(t.repair_time);
        if (rTs && rTs > maxDateTs) {
            return false;
        }
    }

    // Pending offline close — не показываем в «Открытых»
    if (this._pendingCloseMap && this._pendingCloseMap.has(String(t.id))) {
        return false;
    }

    return true;
});
    }
    if (
        this.dataType === "close" &&
        this._pendingCloseMap &&
        this._pendingCloseMap.size > 0
    ) {
        const synthetic = [];
        for (const [ticketId, cmd] of this._pendingCloseMap) {
            const original = (this._openCache || []).find(
                (t) => String(t.id) === ticketId
            );
            if (!original) continue;
            synthetic.push({
                ...original,
                type: "close",
                _isOfflineClose: true,
                solution: cmd.payload.solution || "",
                close_date: cmd.created_at,
                close_name: cmd.offline_author_name || "—",
            });
        }
        if (synthetic.length > 0) {
            filteredData = [...synthetic, ...filteredData];
        }
    }
    // Пересоздаем шапку, если ее нет
    const thead = dataTable.querySelector("thead");
    if (!thead || !thead.firstElementChild) {
      rebuildTableHeaders(
        dataTable,
        (th, colId, type) => this._handleSort(th, colId, type),
        () => this._refreshRowsCache(),
      );
    }

    // Рендерим тело таблицы
    renderTableBody(dataTable, filteredData);
this._applyPendingRowDecorations(dataTable)
    // Восстанавливаем индикатор сортировки
    if (this.currentSortColumnId !== -1) {
      const sortedTh = dataTable.querySelector(
        `th[data-id="${this.currentSortColumnId}"]`,
      );
      if (sortedTh) {
        dataTable
          .querySelectorAll("th.sortable")
          .forEach((h) => h.classList.remove("sort-asc", "sort-desc"));
        sortedTh.classList.add(this.isAscending ? "sort-asc" : "sort-desc");
      }
    }

    this._refreshRowsCache();
    this._initSearch();

    // Навешиваем клики на строки
    dataTable.querySelectorAll("tbody tr").forEach((row) => {
      row.style.cursor = "pointer";
      row.addEventListener("click", (e) => {
        if (e.target.classList.contains("resizer")) return;
        this.unmount();
        const idCell = row.querySelector('td[data-col-id="id"]');
        if (!idCell) return;
        this.router.navigate("#/ticket/" + idCell.textContent);
      });
    });

    const searchInput = document.getElementById("searchInput");
    if (searchInput && searchInput.value.trim() !== "") {
      applyFilter(this.rowsCache, searchInput.value.trim().toLowerCase());
    }
  }
_applyPendingRowDecorations(dataTable) {
    if (!this._pendingCommandMap || this._pendingCommandMap.size === 0) return;

    dataTable.querySelectorAll('tbody tr').forEach(row => {
        const idCell = row.querySelector('td[data-col-id="id"]');
        if (!idCell) return;
        const ticketId = idCell.textContent.trim();
        const cmds = this._pendingCommandMap.get(ticketId);
        if (!cmds || cmds.length === 0) return;

        const types = cmds.map(c => c.command_type);

        if (types.includes('CloseTicket')) {
            row.classList.add('row-offline-close');
            row.title = '⏳ Закрыта локально. Ожидает синхронизации.';
        } else if (types.includes('EditTicket')) {
            row.classList.add('row-offline-edit');
            row.title = '⏳ Изменена локально. Ожидает синхронизации.';
        } else if (types.includes('AddComment')) {
            row.classList.add('row-offline-comment');
            row.title = '⏳ Есть неотправленный комментарий.';
        }
    });
}
  _initPeriodSelector(globalTicketsArrayRef) {
    if (this.dataType !== "close") return;

    const container = document.getElementById("periodSelectorContainer");
    renderPeriodSelector(container, this.selectedDays, (value) => {
      this.unmount();
      this.selectedDays = value;
      localStorage.setItem("tablePeriod_" + this.dataType, value);
      this.isLoaded = false;
      this.mount(globalTicketsArrayRef);
    });
  }

  _initSearch() {
    const searchInput = document.getElementById("searchInput");
    if (!searchInput) return;

    if (this._searchDebounceTimer) {
      clearTimeout(this._searchDebounceTimer);
      this._searchDebounceTimer = null;
    }

    searchInput.oninput = (e) => {
      const value = e.target.value;
      if (this._searchDebounceTimer) clearTimeout(this._searchDebounceTimer);
      this._searchDebounceTimer = setTimeout(() => {
        applyFilter(this.rowsCache, value.trim().toLowerCase());
        this._searchDebounceTimer = null;
      }, 200);
    };
  }

  _refreshRowsCache() {
    const dataTable = document.getElementById("dataTable");
    this.rowsCache = buildRowsCache(dataTable);
  }

  _handleSort(headerElement, columnId, dataType) {
    if (this.currentSortColumnId === columnId) {
      this.isAscending = !this.isAscending;
    } else {
      this.isAscending = true;
      this.currentSortColumnId = columnId;
    }

    // СОХРАНЯЕМ В LOCALSTORAGE
    localStorage.setItem(
      "tableSortColumn_" + this.dataType,
      this.currentSortColumnId,
    );
    localStorage.setItem(
      "tableSortDir_" + this.dataType,
      this.isAscending ? "asc" : "desc",
    );

    const dataTable = document.getElementById("dataTable");
    dataTable
      .querySelectorAll("th.sortable")
      .forEach((h) => h.classList.remove("sort-asc", "sort-desc"));
    headerElement.classList.add(this.isAscending ? "sort-asc" : "sort-desc");

    this._applySort(columnId, this.isAscending);
  }

  _reApplyCurrentSort() {
    if (this.currentSortColumnId === -1) return;

    this._applySort(this.currentSortColumnId, this.isAscending);

    const dataTable = document.getElementById("dataTable");
    if (!dataTable) return;

    const sortedTh = dataTable.querySelector(
      `th[data-id="${this.currentSortColumnId}"]`,
    );
    if (sortedTh) {
      dataTable
        .querySelectorAll("th.sortable")
        .forEach((h) => h.classList.remove("sort-asc", "sort-desc"));
      sortedTh.classList.add(this.isAscending ? "sort-asc" : "sort-desc");
    }
  }

  refreshFromMemory(ticketsArrayRef) {
    const dataTable = document.getElementById("dataTable");
    if (!dataTable) return;

    this._renderTableFull(dataTable, ticketsArrayRef);
    if (this.currentSortColumnId !== -1) {
      this._reApplyCurrentSort();
    }
  }

  _applySort(columnId, isAscending) {
    const dataTable = document.getElementById("dataTable");
    if (!dataTable) return;

    const tbody = dataTable.querySelector("tbody");
    const rows = Array.from(tbody.querySelectorAll("tr"));
    sortRows(rows, columnId, isAscending);
    rows.forEach((row) => tbody.appendChild(row));

    this._refreshRowsCache();
  }

  async _initFilters() {
    const filtersBlock = document.getElementById("openOnlyFilters");
    if (filtersBlock) filtersBlock.style.display = "flex";

    const label = document.getElementById("hideLongRepairLabel");
    if (label) label.textContent = UI.FILTER_REPAIR_LABEL;

    const savedCities = localStorage.getItem("filter_cities");
    const savedHideLong = localStorage.getItem("filter_hide_long");
    this._filters.hideLongRepair = savedHideLong === "true";

    const hideCheck = document.getElementById("hideLongRepair");
    if (hideCheck) hideCheck.checked = this._filters.hideLongRepair;

    this._allCities = await offlineDB.getCities();

    if (savedCities) {
      this._filters.cities = JSON.parse(savedCities);
    } else {
      this._filters.cities = this._allCities.map((c) => c.id);
    }

    this._renderCityDropdown();

    const cityBtn = document.getElementById("cityFilterBtn");
    const cityDropdown = document.getElementById("cityFilterDropdown");

    if (!cityBtn || !cityDropdown) return;

    let backdrop = document.getElementById("cityFilterBackdrop");
    if (!backdrop) {
      backdrop = document.createElement("div");
      backdrop.id = "cityFilterBackdrop";
      backdrop.className = "filter-backdrop";
      document.body.appendChild(backdrop);
      backdrop.onclick = () => {
        cityDropdown.style.display = "none";
        backdrop.style.display = "none";
      };
    }

    cityBtn.onclick = (e) => {
      e.stopPropagation();
      const isHidden =
        cityDropdown.style.display === "none" || !cityDropdown.style.display;
      if (isHidden) {
        cityDropdown.style.display = "block";
        backdrop.style.display = "block";
      } else {
        cityDropdown.style.display = "none";
        backdrop.style.display = "none";
      }
    };

    if (this._filtersAbort) this._filtersAbort.abort();
    this._filtersAbort = new AbortController();

    document.addEventListener(
      "click",
      (e) => {
        if (!cityBtn.contains(e.target) && !cityDropdown.contains(e.target)) {
          cityDropdown.style.display = "none";
          backdrop.style.display = "none";
        }
      },
      { signal: this._filtersAbort.signal },
    );

    const selectAllCb = document.getElementById("citySelectAll");
    if (selectAllCb) {
      selectAllCb.onchange = (e) => {
        if (this._allCities.length === 0) return;
        if (e.target.checked) {
          this._filters.cities = this._allCities.map((c) => c.id);
        } else {
          this._filters.cities = [this._allCities[0].id];
        }
        this._saveFilters();
        this._renderCityDropdown();
        this._applyLocalFilters();
      };
    }

    const hideCb = document.getElementById("hideLongRepair");
    if (hideCb) {
      hideCb.onchange = (e) => {
        this._filters.hideLongRepair = e.target.checked;
        this._saveFilters();
        this._applyLocalFilters();
      };
    }
  }

  _renderCityDropdown() {
    const list = document.getElementById("cityCheckboxList");
    const btn = document.getElementById("cityFilterBtn");
    const btnText = document.getElementById("cityFilterText");
    const selectAllCb = document.getElementById("citySelectAll");

    if (!list || !btn) return;
    list.innerHTML = "";

    if (this._allCities.length === 0) {
      if (btnText) btnText.textContent = "Города: нет данных";
      btn.classList.add("filter-active");
      if (selectAllCb) {
        selectAllCb.checked = false;
        selectAllCb.indeterminate = false;
        selectAllCb.disabled = true;
      }
      return;
    }

    if (selectAllCb) selectAllCb.disabled = false;

    this._allCities.forEach((city) => {
      const isChecked = this._filters.cities.includes(city.id);

      // Безопасное создание элементов вместо innerHTML (защита от XSS)
      const item = document.createElement("label");
      item.className = "city-checkbox-item";

      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.value = city.id;
      cb.checked = isChecked;

      const span = document.createElement("span");
      span.textContent = city.name; // Используем textContent

      item.appendChild(cb);
      item.appendChild(span);

      cb.onchange = (e) => {
        if (e.target.checked) {
          if (!this._filters.cities.includes(city.id))
            this._filters.cities.push(city.id);
        } else {
          if (this._filters.cities.length === 1) {
            e.preventDefault();
            e.target.checked = true;
            return;
          }
          this._filters.cities = this._filters.cities.filter(
            (id) => id !== city.id,
          );
        }
        this._saveFilters();
        this._renderCityDropdown();
        this._applyLocalFilters();
      };

      list.appendChild(item);
    });

    const allSelected = this._filters.cities.length === this._allCities.length;
    const noneSelected = this._filters.cities.length === 0;

    if (allSelected) {
      btnText.textContent = "Города: Все";
      btn.classList.remove("filter-active");
      if (selectAllCb) {
        selectAllCb.checked = true;
        selectAllCb.indeterminate = false;
      }
    } else {
      btnText.textContent = `Города: ${this._filters.cities.length} из ${this._allCities.length}`;
      btn.classList.add("filter-active");
      if (selectAllCb) {
        selectAllCb.checked = false;
        selectAllCb.indeterminate = !noneSelected;
      }
    }
  }

  _saveFilters() {
    localStorage.setItem("filter_cities", JSON.stringify(this._filters.cities));
    localStorage.setItem(
      "filter_hide_long",
      this._filters.hideLongRepair.toString(),
    );
  }

  _applyLocalFilters() {
    const dataTable = document.getElementById("dataTable");
    if (!dataTable) return;

    // Убрали пустой цикл, оставили только перерисовку
    this._renderTableFull(dataTable, this._currentTicketsRef);
  }

  async _updateSyncButton() {
    const [pending, failed] = await Promise.all([
        offlineDB.getOutboxCount(),
        offlineDB.getFailedCount()
    ]);
    const btn = document.getElementById("refreshBtn");
    const badge = document.getElementById("syncBadge");

    if (!btn || !badge) return;

    if (window.syncManagerInstance && window.syncManagerInstance.isSyncing) {
        btn.disabled = true;
        btn.title = "Идет синхронизация...";
        return;
    }

    if (
        window.syncManagerInstance &&
        Date.now() < window.syncManagerInstance._cooldownUntil
    ) {
        const waitMins = Math.ceil(
            (window.syncManagerInstance._cooldownUntil - Date.now()) / 60000,
        );
        btn.disabled = true;
        btn.title = `Синхронизация заблокирована на ${waitMins} мин. из-за ошибки.`;
        btn.style.color = "var(--text-secondary)";
        return;
    }

    btn.disabled = false;

    const total = pending + failed;

    if (total > 0) {
        // 🔴 если есть failed, 🟡 если только pending
        const isError = failed > 0;
        btn.style.color = isError ? "#ef4444" : "#f59e0b";
        btn.title = isError
            ? `Ошибка синхронизации: ${failed} действий. Нажмите, чтобы повторить.`
            : `Нажмите, чтобы синхронизировать ${pending} офлайн-действий`;
        badge.textContent = total;
        badge.style.display = "block";
        badge.style.background = isError ? "#ef4444" : "#f59e0b";
        btn.onclick = (e) => {
            e.preventDefault();
            window.dispatchEvent(new Event("triggerSync"));
        };
    } else {
        btn.style.color = "var(--text-primary)";
        btn.title = "Перезагрузить данные";
        badge.style.display = "none";
        btn.onclick = (e) => {
            if (e) e.preventDefault();
            this.unmount();
            this.isLoaded = false;
            this.mount(this._currentTicketsRef);
        };
    }
}
}