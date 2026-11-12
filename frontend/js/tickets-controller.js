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
  constructor(apiInstance, routerInstance, dataType = "open") {
    this.api = apiInstance;
    this.router = routerInstance;
    this.dataType = dataType;
    this.selectedDays =
      localStorage.getItem("tablePeriod_" + this.dataType) || "1";
    this.rowsCache = [];

    const savedSortId = localStorage.getItem(
      "tableSortColumn_" + this.dataType,
    );
    this.currentSortColumnId = savedSortId ? parseInt(savedSortId, 10) : -1;
    const savedSortDir = localStorage.getItem("tableSortDir_" + this.dataType);
    this.isAscending = savedSortDir !== "desc";

    this.refreshIntervalId = null;
    this.isLoaded = false;
    this._searchDebounceTimer = null;
    this._isPolling = false;
    // 1.15: флаг активности экрана. Снимается в unmount, проверяется
    // в обработчике sync:fetch_open_tickets (main.js), чтобы
    // refreshSilently не трогал DOM, когда пользователь на #/create.
    this._isActive = false;
    this._mountId = 0;
    this._filtersAbort = null;
    this._filters = {
      cities: [],
      hideLongRepair: false,
    };
    this._allCities = [];

    this._isSubscribedToAddresses = false;
    this._onAddressesUpdated = this._onAddressesUpdated.bind(this);
    this._rowClickAbort = null;
  }

  async mount(globalTicketsArrayRef) {
    const myMountId = ++this._mountId;
    const isStale = () => this._mountId !== myMountId;

    if (!Array.isArray(globalTicketsArrayRef)) {
      globalTicketsArrayRef = [];
    }
    const dataTable = document.getElementById("dataTable");
    if (!dataTable) return;

    this._isActive = true;

    await this._loadPendingState();
    if (isStale()) return;
    dataTable.setAttribute("data-mode", this.dataType);

    if (this.dataType === "open") {
      await this._initFilters();
      if (isStale()) return;
    } else {
      const filtersBlock = document.getElementById("openOnlyFilters");
      if (filtersBlock) filtersBlock.style.display = "none";
    }

    // 1.11: _updateSyncButton — для обоих типов (open и close).
    await this._updateSyncButton();
    if (isStale()) return;

    this._initPeriodSelector(globalTicketsArrayRef);

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
      if (isStale()) return;
      let offlineTickets = [];

      if (this.dataType === "open") {
        const outbox = await offlineDB.getAllPending();
        offlineTickets = outbox
          .filter(
            (o) => o.command_type === "CreateTicket" && o.status === "pending",
          )
          .map((o) => {
            const createdAt = Number(o.created_at);
            const dateInSeconds =
              createdAt > 9999999999 ? Math.floor(createdAt / 1000) : createdAt;
            return {
              ...o.payload,
              id: o.offline_uuid || o.command_uuid,
              type: "open",
              isOffline: true,
              address: o.payload.fullAddress || o.payload.address,
              date: dateInSeconds,
            };
          });
      }

      if (fresh) {
        globalTicketsArrayRef.splice(
          0,
          globalTicketsArrayRef.length,
          ...offlineTickets,
          ...fresh,
        );
        await offlineDB.saveTickets(this.dataType, fresh);
        if (isStale()) return;
      } else {
        logHistoryAction("Нет соединения. Загрузка из офлайн-кэша...");
        const cached = await offlineDB.getTickets(this.dataType);
        if (isStale()) return;
        if (cached.length > 0) {
          globalTicketsArrayRef.splice(
            0,
            globalTicketsArrayRef.length,
            ...offlineTickets,
            ...cached,
          );
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
      if (isStale()) return;
    } else {
      loadData(true);
    }

    if (this.refreshIntervalId) {
      clearInterval(this.refreshIntervalId);
      this.refreshIntervalId = null;
    }

    if (!this._isSubscribedToAddresses) {
      window.addEventListener("addresses:updated", this._onAddressesUpdated);
      this._isSubscribedToAddresses = true;
    }
  }

  unmount() {
    this._mountId++;
    this._isActive = false;

    if (this.refreshIntervalId) {
      clearInterval(this.refreshIntervalId);
      this.refreshIntervalId = null;
    }
    if (this._filtersAbort) {
      this._filtersAbort.abort();
      this._filtersAbort = null;
    }
    this._isPolling = false;
    this.api.abortTag("tickets_" + this.dataType);

    if (this._searchDebounceTimer) {
      clearTimeout(this._searchDebounceTimer);
      this._searchDebounceTimer = null;
    }

    if (this._isSubscribedToAddresses) {
      window.removeEventListener("addresses:updated", this._onAddressesUpdated);
      this._isSubscribedToAddresses = false;
    }

    if (this._rowClickAbort) {
      this._rowClickAbort.abort();
      this._rowClickAbort = null;
    }

    // 1.14: удаляем backdrop городов. Иначе после возврата на главную
    // замыкание onclick держит удалённый cityDropdown.
    const backdrop = document.getElementById("cityFilterBackdrop");
    if (backdrop) {
      backdrop.onclick = null;
      backdrop.remove();
    }

    this.rowsCache = [];
    this._currentTicketsRef = null;
  }

  async _onAddressesUpdated() {
    await this._loadPendingState();
    console.log(
      "[TicketsController] Адреса загружены в фоне, обновляем фильтр городов.",
    );
    this._allCities = await offlineDB.getCities();

    if (this._allCities.length > 0) {
      if (this._filters.cities.length === 0) {
        this._filters.cities = this._allCities.map((c) => c.id);
      }
      this._renderCityDropdown();
      this._applyLocalFilters();
    }
  }

  async _loadPendingState() {
    const all = await offlineDB.getAllPending();
    this._pendingCommandMap = new Map();
    this._pendingCloseMap = new Map();

    for (const cmd of all) {
      if (cmd.status !== "pending") continue;
      if (cmd.ticket_id == null) continue;
      const key = String(cmd.ticket_id);
      if (!this._pendingCommandMap.has(key))
        this._pendingCommandMap.set(key, []);
      this._pendingCommandMap.get(key).push(cmd);

      if (cmd.command_type === "CloseTicket") {
        this._pendingCloseMap.set(key, cmd);
      }
    }

    if (this.dataType === "close" && this._pendingCloseMap.size > 0) {
      this._openCache = await offlineDB.getTickets("open");
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
      if (data && data._authLost) return null;
      if (!data || data.status === "error") {
        throw new Error((data && data.message) || "Сбой структуры БД");
      }
      if (!Array.isArray(data)) {
        throw new Error("Ожидался массив заявок, получено: " + typeof data);
      }

      data.forEach((item) => {
        item.type = this.dataType;
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
    if (!Array.isArray(globalTicketsArrayRef)) {
      globalTicketsArrayRef = [];
    }
    this._currentTicketsRef = globalTicketsArrayRef;
    let filteredData = [...globalTicketsArrayRef];

    if (this.dataType === "open") {
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
          (t) => String(t.id) === ticketId,
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
    const thead = dataTable.querySelector("thead");
    if (!thead || !thead.firstElementChild) {
      rebuildTableHeaders(
        dataTable,
        (th, colId, type) => this._handleSort(th, colId, type),
        () => this._refreshRowsCache(),
      );
    }

    renderTableBody(dataTable, filteredData);
    this._applyPendingRowDecorations(dataTable);
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

    if (this._rowClickAbort) this._rowClickAbort.abort();
    this._rowClickAbort = new AbortController();

    const tbody = dataTable.querySelector("tbody");
    if (tbody) {
      tbody.addEventListener(
        "click",
        (e) => {
          if (e.target.classList.contains("resizer")) return;
          const row = e.target.closest("tr");
          if (!row) return;
          const idCell = row.querySelector('td[data-col-id="id"]');
          if (!idCell) return;
          this.unmount();
          this.router.navigate("#/ticket/" + idCell.textContent);
        },
        { signal: this._rowClickAbort.signal },
      );
    }

    const searchInput = document.getElementById("searchInput");
    if (searchInput && searchInput.value.trim() !== "") {
      applyFilter(this.rowsCache, searchInput.value.trim().toLowerCase());
    }
  }

  _applyPendingRowDecorations(dataTable) {
    if (!this._pendingCommandMap || this._pendingCommandMap.size === 0) return;

    dataTable.querySelectorAll("tbody tr").forEach((row) => {
      const idCell = row.querySelector('td[data-col-id="id"]');
      if (!idCell) return;
      const ticketId = idCell.textContent.trim();
      const cmds = this._pendingCommandMap.get(ticketId);
      if (!cmds || cmds.length === 0) return;

      const types = cmds.map((c) => c.command_type);

      if (types.includes("CloseTicket")) {
        row.classList.add("row-offline-close");
        row.title = "⏳ Закрыта локально. Ожидает синхронизации.";
      } else if (types.includes("EditTicket")) {
        row.classList.add("row-offline-edit");
        row.title = "⏳ Изменена локально. Ожидает синхронизации.";
      } else if (types.includes("AddComment")) {
        row.classList.add("row-offline-comment");
        row.title = "⏳ Есть неотправленный комментарий.";
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

    if (!Array.isArray(ticketsArrayRef)) {
      console.warn("[TicketsController] refreshFromMemory получил null.");
      return;
    }

    this._renderTableFull(dataTable, ticketsArrayRef);
    if (this.currentSortColumnId !== -1) {
      this._reApplyCurrentSort();
    }
  }

  // 1.16: поколение в refreshSilently. Без этого после await рисуем в DOM
  // без проверки, что пользователь ещё на этом экране.
  async refreshSilently(globalTicketsArrayRef) {
    if (this._isPolling) return;
    const myMountId = this._mountId;
    const isStale = () => this._mountId !== myMountId;
    this._isPolling = true;
    try {
      const fresh = await this._loadDataFromServer(true);
      if (!fresh || isStale()) return;

      let offlineTickets = [];
      if (this.dataType === "open") {
        const outbox = await offlineDB.getAllPending();
        if (isStale()) return;
        offlineTickets = outbox
          .filter(
            (o) => o.command_type === "CreateTicket" && o.status === "pending",
          )
          .map((o) => {
            const createdAt = Number(o.created_at);
            const dateInSeconds =
              createdAt > 9999999999 ? Math.floor(createdAt / 1000) : createdAt;
            return {
              ...o.payload,
              id: o.offline_uuid || o.command_uuid,
              type: "open",
              isOffline: true,
              address: o.payload.fullAddress || o.payload.address,
              date: dateInSeconds,
            };
          });
      }

      if (!Array.isArray(globalTicketsArrayRef)) return;

      globalTicketsArrayRef.splice(
        0,
        globalTicketsArrayRef.length,
        ...offlineTickets,
        ...fresh,
      );
      await offlineDB.saveTickets(this.dataType, fresh);
      if (isStale()) return;

      const dataTable = document.getElementById("dataTable");
      if (dataTable) {
        this._renderTableFull(dataTable, globalTicketsArrayRef);
        if (this.currentSortColumnId !== -1) this._reApplyCurrentSort();
      }
    } catch (e) {
      console.error(`[TicketsController] refreshSilently failed:`, e);
    } finally {
      this._isPolling = false;
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

    // 1.14: всегда перепривязываем onclick. Старое замыкание держит
    // удалённый cityDropdown после возврата на главную.
    let backdrop = document.getElementById("cityFilterBackdrop");
    if (!backdrop) {
      backdrop = document.createElement("div");
      backdrop.id = "cityFilterBackdrop";
      backdrop.className = "filter-backdrop";
      document.body.appendChild(backdrop);
    }
    backdrop.onclick = () => {
      cityDropdown.style.display = "none";
      backdrop.style.display = "none";
    };

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

    // 1.19: «Снять все» — снимаем все, не оставляем первый город.
    // Фильтр по городам не активен при пустом массиве (см. cityFilterActive),
    // поэтому таблица показывает все города.
    const selectAllCb = document.getElementById("citySelectAll");
    if (selectAllCb) {
      selectAllCb.onchange = (e) => {
        if (this._allCities.length === 0) return;
        if (e.target.checked) {
          this._filters.cities = this._allCities.map((c) => c.id);
        } else {
          this._filters.cities = [];
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

      const item = document.createElement("label");
      item.className = "city-checkbox-item";

      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.value = city.id;
      cb.checked = isChecked;

      const span = document.createElement("span");
      span.textContent = city.name;

      item.appendChild(cb);
      item.appendChild(span);

      cb.onchange = (e) => {
        if (e.target.checked) {
          if (!this._filters.cities.includes(city.id))
            this._filters.cities.push(city.id);
        } else {
          if (this._filters.cities.length === 1) {
            // 1.20: e.preventDefault() на change не работает — возвращаем checked явно.
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

    if (allSelected || noneSelected) {
      // Пустой массив = фильтр не активен = показаны все.
      // Подпись должна это отражать, иначе подсвеченная «0 из N» врёт.
      btnText.textContent = "Города: Все";
      btn.classList.remove("filter-active");
      if (selectAllCb) {
        selectAllCb.checked = allSelected;
        selectAllCb.indeterminate = false;
      }
    } else {
      btnText.textContent = `Города: ${this._filters.cities.length} из ${this._allCities.length}`;
      btn.classList.add("filter-active");
      if (selectAllCb) {
        selectAllCb.checked = false;
        selectAllCb.indeterminate = true;
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
    if (!this._currentTicketsRef) return;

    this._renderTableFull(dataTable, this._currentTicketsRef);
  }

  async _updateSyncButton() {
    const [pending, failed] = await Promise.all([
      offlineDB.getOutboxCount(),
      offlineDB.getFailedCount(),
    ]);

    const total = pending + failed;

    const headerBadge = document.querySelector(".sync-indicator-badge");
    const headerBtn = document.getElementById("syncIndicator");

    if (headerBadge && headerBtn) {
      if (total > 0) {
        const isError = failed > 0;
        headerBadge.textContent = total;
        headerBadge.style.display = "block";
        headerBadge.style.background = isError ? "#ef4444" : "#f59e0b";
        headerBtn.title = isError
          ? `Ошибка синхронизации: ${failed} действий`
          : `Ожидает синхронизации: ${total} действий`;
      } else {
        headerBadge.style.display = "none";
        headerBtn.title = "Все данные синхронизированы";
      }
    }

    const tableBtn = document.getElementById("refreshBtn");
    if (tableBtn) {
      if (window.syncManagerInstance && window.syncManagerInstance.isSyncing) {
        tableBtn.disabled = true;
        tableBtn.title = "Идет синхронизация...";
        return;
      }

      tableBtn.disabled = false;
      tableBtn.style.color = "var(--text-primary)";
      tableBtn.title = "Обновить список заявок";

      tableBtn.onclick = (e) => {
        if (e) e.preventDefault();
        this.unmount();
        this.isLoaded = false;
        this.mount(this._currentTicketsRef);
      };
    }
  }
}
