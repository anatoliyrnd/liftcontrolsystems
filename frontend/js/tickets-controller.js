import { rebuildTableHeaders } from "./table/header-render.js";
import { renderTableBody } from "./table/body-render.js";
import { sortRows } from "./table/sorting.js";
import { buildRowsCache, applyFilter } from "./table/filtering.js";
import { renderPeriodSelector } from "./table/period-selector.js";
import { UI } from "./config.js";
import { logHistoryAction } from "./history-logger.js";
import { offlineDB } from "./offline-db.js";

/** Unix-метка в секундах; миллисекунды outbox приводим. */
function toSeconds(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n > 9999999999 ? Math.floor(n / 1000) : n;
}

export class TicketsController {
  constructor(apiInstance, routerInstance, dataType = "open") {
    this.api = apiInstance;
    this.router = routerInstance;
    this.dataType = dataType;

    this.selectedDays =
      localStorage.getItem("tablePeriod_" + this.dataType) || "1";
    this.rowsCache = [];

   const savedSortId = localStorage.getItem("tableSortColumn_" + this.dataType);
this.currentSortColumnId = savedSortId || -1;
    this.isAscending =
      localStorage.getItem("tableSortDir_" + this.dataType) !== "desc";

    this.refreshIntervalId = null;
    this.isLoaded = false;
    this._searchDebounceTimer = null;
    this._isPolling = false;

    this._isActive = false;
    this._mountId = 0;
    this._filtersAbort = null;
    this._filters = { cities: [], hideLongRepair: false };
    this._allCities = [];
    this._isSubscribedToAddresses = false;
    this._onAddressesUpdated = this._onAddressesUpdated.bind(this);
    this._rowClickAbort = null;
    this._currentTicketsRef = null;
    this._pendingCommandMap = new Map();
    this._pendingCloseMap = new Map();
    this._openCache = [];
  }

  /** Публичный флаг активности для main.js (п. 1.15). */
  get isActive() {
    return this._isActive === true;
  }

  async mount(globalTicketsArrayRef) {
    const myMountId = ++this._mountId;
    const isStale = () => this._mountId !== myMountId;

    let ref = Array.isArray(globalTicketsArrayRef)
      ? globalTicketsArrayRef
      : this._currentTicketsRef;
    if (!Array.isArray(ref)) ref = [];

    const dataTable = document.getElementById("dataTable");
    if (!dataTable) return;

    this._isActive = true;

    await this._loadPendingState();
    if (isStale()) return;

    dataTable.setAttribute("data-mode", this.dataType);
    dataTable.setAttribute("data-scope", this.dataType);

    if (this.dataType === "open") {
      await this._initFilters();
      if (isStale()) return;
    } else {
      const filtersBlock = document.getElementById("openOnlyFilters");
      if (filtersBlock) filtersBlock.style.display = "none";
    }

    await this._updateSyncButton();
    if (isStale()) return;

    this._initPeriodSelector(ref);

    const oldThead = dataTable.querySelector("thead");
    if (oldThead) oldThead.remove();

    const hadData = ref.length > 0;
    this._renderTableFull(dataTable, ref);
    if (this.currentSortColumnId !== -1) this._reApplyCurrentSort();

    const needBlockingLoad = !this.isLoaded || !hadData;

    const loadData = async (isSilent) => {
      try {
        const fresh = await this._loadDataFromServer(isSilent);
        if (isStale()) return;

        const offlineTickets =
          this.dataType === "open" ? await this._collectOfflineCreates() : [];
        if (isStale()) return;

        if (fresh) {
          ref.splice(0, ref.length, ...offlineTickets, ...fresh);
          await offlineDB.saveTickets(this.dataType, fresh);
          if (isStale()) return;
        } else {
          logHistoryAction("Нет соединения. Загрузка из офлайн-кэша...");
          const cached = await offlineDB.getTickets(this.dataType);
          if (isStale()) return;
          if (cached.length > 0) {
            ref.splice(0, ref.length, ...offlineTickets, ...cached);
          } else if (offlineTickets.length > 0) {
            ref.splice(0, ref.length, ...offlineTickets);
          } else {
            logHistoryAction("Кэш пуст. Нет данных для отображения.");
          }
        }

        this._renderTableFull(dataTable, ref);
        if (this.currentSortColumnId !== -1) this._reApplyCurrentSort();
      } catch (e) {
        console.error("[TicketsController] loadData failed:", e);
      }
    };

    if (needBlockingLoad) {
      await loadData(false);
      if (isStale()) return;
    } else {
      loadData(true);
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

    const searchInput = document.getElementById("searchInput");
    if (searchInput) searchInput.oninput = null;

    // 1.14: backdrop живёт ровно столько, сколько экран.
    const backdrop = document.getElementById("cityFilterBackdrop");
    if (backdrop) {
      backdrop.onclick = null;
      backdrop.remove();
    }

    this.rowsCache = [];
    this._currentTicketsRef = null;
  }

  /** Локальные CreateTicket со статусом pending → строки журнала. */
  async _collectOfflineCreates() {
    const outbox = await offlineDB.getAllPending();
    return outbox
      .filter(
        (o) => o.command_type === "CreateTicket" && o.status === "pending",
      )
      .map((o) => {
        const p = o.payload || {};
        return {
          ...p,
          id: o.offline_uuid || o.command_uuid,
          offline_uuid: o.offline_uuid,
          call_number: o.offline_uuid || o.command_uuid,
          type: p.solution ? "close" : "open",
          isOffline: true,
          address: p.fullAddress || p.address || "",
          fullAddress: p.fullAddress || p.address || "",
          date: toSeconds(p.opened_at) ?? toSeconds(o.created_at),
          repair_time: null,
        };
      });
  }

  async _onAddressesUpdated() {
    if (!this._isActive) return;
    const myMountId = this._mountId;
    await this._loadPendingState();
    const cities = await offlineDB.getCities();
    if (!this._isActive || this._mountId !== myMountId) return;

    this._allCities = cities;
    if (cities.length > 0 && this._filters.cities.length === 0) {
      // Пустой массив = «Все»; нормализуем к полному списку для чекбоксов.
      this._filters.cities = cities.map((c) => c.id);
      this._saveFilters();
    }
    this._renderCityDropdown();
    this._applyLocalFilters();
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
      if (cmd.command_type === "CloseTicket")
        this._pendingCloseMap.set(key, cmd);
    }

    this._openCache =
      this.dataType === "close" && this._pendingCloseMap.size > 0
        ? await offlineDB.getTickets("open")
        : [];
  }

  async _loadDataFromServer(isSilent = false) {
    try {
      const postPayload = { data: this.dataType };
      if (this.dataType === "close") postPayload.period = this.selectedDays;

      const data = await this.api.post(
        postPayload,
        isSilent ? null : "Синхронизация инцидентов...",
        "tickets_" + this.dataType,
      );

      if (data && (data.code === "aborted" || data._authLost)) return null;
      if (!data || data.status === "error") {
        throw new Error((data && data.message) || "Сбой структуры БД");
      }
      if (!Array.isArray(data)) {
        throw new Error("Ожидался массив заявок, получено: " + typeof data);
      }

      for (const item of data) {
        item.type = this.dataType;
        if (item.id == null) item.id = item.call_id ?? item.call_number;
        if (item.call_number == null) item.call_number = String(item.id ?? "");
        if (!item.address && item.fullAddress) item.address = item.fullAddress;
        if (!item.fullAddress && item.address) item.fullAddress = item.address;
        if (item.close_date != null)
          item.close_date = toSeconds(item.close_date);
      }

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
    const ref = Array.isArray(globalTicketsArrayRef)
      ? globalTicketsArrayRef
      : [];
    this._currentTicketsRef = ref;

    let filteredData = [...ref];

    if (this.dataType === "open") {
      const nowSeconds = Math.floor(Date.now() / 1000);
      const maxDateTs = nowSeconds + UI.FILTER_REPAIR_DAYS * 24 * 60 * 60;
      // Пустой список городов = фильтр не активен = показаны все.
      const cityFilterActive =
        this._allCities.length > 0 &&
        this._filters.cities.length > 0 &&
        this._filters.cities.length < this._allCities.length;

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
          if (rTs && rTs > maxDateTs) return false;
        }
        if (this._pendingCloseMap.has(String(t.id))) return false;
        return true;
      });
    }

    if (this.dataType === "close" && this._pendingCloseMap.size > 0) {
      const synthetic = [];
      for (const [ticketId, cmd] of this._pendingCloseMap) {
        const original = this._openCache.find((t) => String(t.id) === ticketId);
        if (!original) continue;
        synthetic.push({
          ...original,
          type: "close",
          _isOfflineClose: true,
          solution: cmd.payload?.solution || "",
          // created_at команды — секунды; payload.closed_at точнее.
          close_date:
            toSeconds(cmd.payload?.closed_at) ?? toSeconds(cmd.created_at),
          close_name: cmd.offline_author_name || "—",
        });
      }
      if (synthetic.length > 0) filteredData = [...synthetic, ...filteredData];
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
    this._paintSortIndicators(dataTable);
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
          // trim обязател: роутер валидирует param строго (п. 1.2).
          const ticketId = idCell.textContent.trim();
          if (!ticketId) return;
          this.router.navigate("#/ticket/" + encodeURIComponent(ticketId));
        },
        { signal: this._rowClickAbort.signal },
      );
    }

    const searchInput = document.getElementById("searchInput");
    if (searchInput && searchInput.value.trim() !== "") {
      applyFilter(this.rowsCache, searchInput.value.trim().toLowerCase());
    }
  }

  _paintSortIndicators(dataTable) {
    dataTable
      .querySelectorAll("th.sortable")
      .forEach((h) => h.classList.remove("sort-asc", "sort-desc"));
    if (this.currentSortColumnId === -1) return;
    const th = dataTable.querySelector(
      `th[data-id="${this.currentSortColumnId}"]`,
    );
    if (th) th.classList.add(this.isAscending ? "sort-asc" : "sort-desc");
  }

  _applyPendingRowDecorations(dataTable) {
    if (this._pendingCommandMap.size === 0) return;

    dataTable.querySelectorAll("tbody tr").forEach((row) => {
      const idCell = row.querySelector('td[data-col-id="id"]');
      if (!idCell) return;
      const cmds = this._pendingCommandMap.get(idCell.textContent.trim());
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
      const ref = globalTicketsArrayRef || this._currentTicketsRef;
      this.unmount();
      this.selectedDays = value;
      localStorage.setItem("tablePeriod_" + this.dataType, value);
      this.isLoaded = false;
      this.mount(ref);
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

  _handleSort(headerElement, columnId) {
    if (this.currentSortColumnId === columnId) {
      this.isAscending = !this.isAscending;
    } else {
      this.isAscending = true;
      this.currentSortColumnId = columnId;
    }

    localStorage.setItem(
      "tableSortColumn_" + this.dataType,
      String(this.currentSortColumnId),
    );
    localStorage.setItem(
      "tableSortDir_" + this.dataType,
      this.isAscending ? "asc" : "desc",
    );

    const dataTable = document.getElementById("dataTable");
    if (dataTable) {
      dataTable
        .querySelectorAll("th.sortable")
        .forEach((h) => h.classList.remove("sort-asc", "sort-desc"));
    }
    headerElement.classList.add(this.isAscending ? "sort-asc" : "sort-desc");
    this._applySort(columnId, this.isAscending);
  }

  _reApplyCurrentSort() {
    if (this.currentSortColumnId === -1) return;
    this._applySort(this.currentSortColumnId, this.isAscending);
    const dataTable = document.getElementById("dataTable");
    if (dataTable) this._paintSortIndicators(dataTable);
  }

  /**
   * Перерисовка из памяти после синхронизации.
   * Локальные CreateTicket сохраняем: серверный список их не содержит,
   * без этого офлайн-заявка исчезала бы до следующего поллинга.
   */
  async refreshFromMemory(ticketsArrayRef) {
    if (!this._isActive) return;
    if (!Array.isArray(ticketsArrayRef)) return;

    const myMountId = this._mountId;
    const serverRows = ticketsArrayRef.filter((t) => !t.isOffline);

    let offlineTickets = [];
    if (this.dataType === "open") {
      try {
        offlineTickets = await this._collectOfflineCreates();
      } catch (e) {
        console.warn("[TicketsController] outbox read failed:", e);
        offlineTickets = ticketsArrayRef.filter((t) => t.isOffline);
      }
    }
    if (!this._isActive || this._mountId !== myMountId) return;

    await this._loadPendingState();
    if (!this._isActive || this._mountId !== myMountId) return;

    ticketsArrayRef.splice(
      0,
      ticketsArrayRef.length,
      ...offlineTickets,
      ...serverRows,
    );

    const dataTable = document.getElementById("dataTable");
    if (!dataTable) return;
    this._renderTableFull(dataTable, ticketsArrayRef);
    if (this.currentSortColumnId !== -1) this._reApplyCurrentSort();
  }

  // 1.16: поколение + флаг активности после каждого await.
  async refreshSilently(globalTicketsArrayRef) {
    if (this._isPolling || !this._isActive) return;

    const myMountId = this._mountId;
    const isStale = () => !this._isActive || this._mountId !== myMountId;
    this._isPolling = true;

    try {
      const fresh = await this._loadDataFromServer(true);
      if (!fresh || isStale()) return;

      const offlineTickets =
        this.dataType === "open" ? await this._collectOfflineCreates() : [];
      if (isStale()) return;

      if (!Array.isArray(globalTicketsArrayRef)) return;
      globalTicketsArrayRef.splice(
        0,
        globalTicketsArrayRef.length,
        ...offlineTickets,
        ...fresh,
      );

      await offlineDB.saveTickets(this.dataType, fresh);
      if (isStale()) return;

      await this._loadPendingState();
      if (isStale()) return;

      const dataTable = document.getElementById("dataTable");
      if (!dataTable) return;
      this._renderTableFull(dataTable, globalTicketsArrayRef);
      if (this.currentSortColumnId !== -1) this._reApplyCurrentSort();
    } catch (e) {
      console.error("[TicketsController] refreshSilently failed:", e);
    } finally {
      // Не сбрасываем флаг нового запуска, если этот уже устарел.
      if (!isStale()) this._isPolling = false;
    }
  }

  _applySort(columnId, isAscending) {
    const dataTable = document.getElementById("dataTable");
    if (!dataTable) return;
    const tbody = dataTable.querySelector("tbody");
    if (!tbody) return;
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

    this._filters.hideLongRepair =
      localStorage.getItem("filter_hide_long") === "true";
    const hideCheck = document.getElementById("hideLongRepair");
    if (hideCheck) hideCheck.checked = this._filters.hideLongRepair;

    this._allCities = await offlineDB.getCities();

    const savedCities = localStorage.getItem("filter_cities");
    let parsed = null;
    if (savedCities) {
      try {
        const value = JSON.parse(savedCities);
        if (Array.isArray(value))
          parsed = value.map(Number).filter(Number.isFinite);
      } catch (e) {
        console.warn("[TicketsController] Битый filter_cities, сбрасываем.");
      }
    }
    // Пустой массив — валидное состояние «Все», не перезаписываем.
    this._filters.cities =
      parsed === null ? this._allCities.map((c) => c.id) : parsed;

    this._renderCityDropdown();

    const cityBtn = document.getElementById("cityFilterBtn");
    const cityDropdown = document.getElementById("cityFilterDropdown");
    if (!cityBtn || !cityDropdown) return;

    // 1.14: onclick перепривязываем всегда — старое замыкание держит
    // удалённый cityDropdown после возврата на главную.
    let backdrop = document.getElementById("cityFilterBackdrop");
    if (!backdrop) {
      backdrop = document.createElement("div");
      backdrop.id = "cityFilterBackdrop";
      backdrop.className = "filter-backdrop";
      document.body.appendChild(backdrop);
    }

    const closeDropdown = () => {
      cityDropdown.style.display = "none";
      backdrop.style.display = "none";
    };

    backdrop.onclick = closeDropdown;
    cityBtn.onclick = (e) => {
      e.stopPropagation();
      const isHidden =
        cityDropdown.style.display === "none" || !cityDropdown.style.display;
      cityDropdown.style.display = isHidden ? "block" : "none";
      backdrop.style.display = isHidden ? "block" : "none";
    };

    if (this._filtersAbort) this._filtersAbort.abort();
    this._filtersAbort = new AbortController();

    document.addEventListener(
      "click",
      (e) => {
        if (!cityBtn.contains(e.target) && !cityDropdown.contains(e.target)) {
          closeDropdown();
        }
      },
      { signal: this._filtersAbort.signal },
    );

    document.addEventListener(
      "keydown",
      (e) => {
        if (e.key === "Escape") closeDropdown();
      },
      { signal: this._filtersAbort.signal },
    );

    // 1.19: «Снять все» снимает все чекбоксы. Пустой список = фильтр
    // не активен, таблица показывает все города, подпись — «Все».
    const selectAllCb = document.getElementById("citySelectAll");
    if (selectAllCb) {
      selectAllCb.onchange = (e) => {
        if (this._allCities.length === 0) return;
        this._filters.cities = e.target.checked
          ? this._allCities.map((c) => c.id)
          : [];
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
      btn.classList.remove("filter-active");
      if (selectAllCb) {
        selectAllCb.checked = false;
        selectAllCb.indeterminate = false;
        selectAllCb.disabled = true;
      }
      return;
    }

    if (selectAllCb) selectAllCb.disabled = false;

    for (const city of this._allCities) {
      const item = document.createElement("label");
      item.className = "city-checkbox-item";

      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.value = String(city.id);
      cb.checked = this._filters.cities.includes(Number(city.id));

      const span = document.createElement("span");
      span.textContent = city.name;

      item.appendChild(cb);
      item.appendChild(span);

      cb.onchange = (e) => {
        // 1.20: preventDefault на change не работает — состояние задаём явно.
        const checked = e.target.checked === true;
        e.target.checked = checked;

        if (checked) {
          if (!this._filters.cities.includes(Number(city.id)))
            this._filters.cities.push(Number(city.id));
        } else {
          // Последнюю тоже разрешаем снять: ноль = «Все», как и «Снять все».
          this._filters.cities = this._filters.cities.filter(
            (id) => id !== Number(city.id),
          );
        }
        this._saveFilters();
        this._renderCityDropdown();
        this._applyLocalFilters();
      };

      list.appendChild(item);
    }

    const total = this._allCities.length;
    const selected = this._filters.cities.length;
    const allSelected = selected === total;
    const noneSelected = selected === 0;

    if (allSelected || noneSelected) {
      if (btnText) btnText.textContent = "Города: Все";
      btn.classList.remove("filter-active");
      if (selectAllCb) {
        selectAllCb.checked = allSelected;
        selectAllCb.indeterminate = false;
      }
    } else {
      if (btnText) btnText.textContent = `Города: ${selected} из ${total}`;
      btn.classList.add("filter-active");
      if (selectAllCb) {
        selectAllCb.checked = false;
        selectAllCb.indeterminate = true;
      }
    }
  }

  _saveFilters() {
    try {
      localStorage.setItem(
        "filter_cities",
        JSON.stringify(this._filters.cities),
      );
      localStorage.setItem(
        "filter_hide_long",
        String(this._filters.hideLongRepair),
      );
    } catch (e) {
      console.warn("[TicketsController] Не удалось сохранить фильтры:", e);
    }
  }

  _applyLocalFilters() {
    const dataTable = document.getElementById("dataTable");
    if (!dataTable || !this._currentTicketsRef) return;
    this._renderTableFull(dataTable, this._currentTicketsRef);
    if (this.currentSortColumnId !== -1) this._reApplyCurrentSort();
  }

 async _updateSyncButton() {
  // 1.11: кнопка таблицы принадлежит только активному экрану.
  // Шапка (syncIndicator) обновляется одноимённым модулем на refreshSyncState —
  // здесь её не трогаем, чтобы не было двух источников истины.
  const tableBtn = document.getElementById("refreshBtn");
  if (!tableBtn || !this._isActive) return;

  if (window.syncManagerInstance?.isSyncing) {
    tableBtn.disabled = true;
    tableBtn.title = "Идет синхронизация...";
    return;
  }

  tableBtn.disabled = false;
  tableBtn.style.color = "var(--text-primary)";
  tableBtn.title = "Обновить список заявок";
  tableBtn.onclick = (e) => {
    if (e) e.preventDefault();
    const ref = this._currentTicketsRef;
    this.unmount();
    this.isLoaded = false;
    this.mount(ref);
  };
}
}
