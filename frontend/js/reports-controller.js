import { REPORTS } from "./config.js";
import { userStore } from "./user-store.js";
import { authStore } from "./auth-store.js";
import { notify } from "./components/notify.js";
import { logHistoryAction } from "./history-logger.js";
import { offlineDB } from "./offline-db.js";
import { createReportsRepository } from "./reports/reports-repository.js";
import {
  loadReportState,
  saveReportState,
  defaultReportState,
} from "./reports/reports-state.js";
import { publishResultRequest, resultsUrl } from "./reports/result-channel.js";
import { createSummaryView } from "./reports/views/summary-view.js";
import { createFiltersView } from "./reports/views/filters-view.js";

/**
 * Страница отчётов: сводка + фильтры. Таблицы здесь нет.
 *
 * «Найти» publishes запрос в localStorage и открывает вкладку
 * браузера. Порядок критичен: window.open вызывается СИНХРОННО
 * внутри клика, до любого await — иначе браузер теряет пользовательский
 * жест и блокирует вкладку.
 *
 * Повторный клик по живому окну не перезагружает его: запрос уже
 * ушёл событием storage, остаётся только focus(). Закрытая вкладка
 * определяется по win.closed и открывается заново. Handle хранится
 * на инстансе и переживает unmount — возврат на экран не теряет окно.
 */
export class ReportsController {
  constructor(apiInstance, routerInstance) {
    this.api = apiInstance;
    this.router = routerInstance;
    this.repo = createReportsRepository(apiInstance);
    this._mountId = 0;
    this._isActive = false;
    this._filtersData = null;
    this.summaryView = null;
    this.filtersView = null;
    this.state = null;
    this._summaryDebounce = null;
    this._eventsAbort = null;
    this._els = null;
    this._summarySeq = 0;
    // Не сбрасывается в unmount: вкладка браузера живёт своей жизнью.
    this._resultsWindow = null;
  }

  get isActive() {
    return this._isActive === true;
  }

  async mount() {
    const myMountId = ++this._mountId;
    const isStale = () => this._mountId !== myMountId;
    this._isActive = true;
    this.state = loadReportState();
    if (!REPORTS.TABS[this.state.tab]) this.state.tab = REPORTS.TAB_DEFAULT;

    if (!this._grabElements()) return;
    this._subscribeNetwork();

    if (!this._canView()) {
      this._els.stub.dataset.denied = "1";
      this._showStub("Отчёты недоступны для вашей роли.");
      return;
    }
    this._bindTabs();
    this._bindById();
    this._bindResultHint();
    this._applyTab(this.state.tab);
    if (isStale()) return;
  }

  refreshColumns() {
    // Таблицы на этом экране больше нет — переподтверждать нечего.
  }

  unmount() {
    this._mountId++;
    this._isActive = false;
    if (this._summaryDebounce) clearTimeout(this._summaryDebounce);
    this._summaryDebounce = null;
    if (this._eventsAbort) this._eventsAbort.abort();
    this._eventsAbort = null;
    this.api.abortTag("reports");
    this.api.abortTag("reports_summary");
    this.summaryView?.destroy();
    this.summaryView = null;
    this.filtersView?.destroy();
    this.filtersView = null;
    this._filtersData = null;
    this._els = null;
    // _resultsWindow намеренно сохранён.
  }

  // ------------------------------------------------------------------
  _grabElements() {
    const get = (id) => document.getElementById(id);
    const els = {
      stub: get("repOfflineStub"),
      tabs: get("repTabs"),
      tabSummary: get("repTabSummary"),
      tabAdvanced: get("repTabAdvanced"),
      tabById: get("repTabById"),
      summaryHost: get("repSummaryHost"),
      filtersHost: get("repFiltersHost"),
      hintText: get("repResultHintText"),
      showBtn: get("repResultShowBtn"),
      byIdInput: get("repTicketId"),
      byIdBtn: get("repByIdBtn"),
    };
    for (const [name, node] of Object.entries(els)) {
      if (!node) {
        console.warn("[ReportsController] нет элемента:", name);
        return false;
      }
    }
    this._els = els;
    return true;
  }

  _canView() {
    const position = authStore.getUser()?.user_position ?? null;
    return userStore.can("view_reports") || position === "foreman";
  }

  _userId() {
    return userStore.userId ?? authStore.getUser()?.id ?? null;
  }

  _bindTabs() {
    this._els.tabs.querySelectorAll(".rep-tab").forEach((btn) => {
      btn.addEventListener("click", () => {
        const tab = btn.getAttribute("data-tab");
        if (!tab || tab === this.state.tab) return;
        this.state.tab = tab;
        this._applyTab(tab);
        this._saveState();
      });
    });
  }

  _applyTab(tab) {
    const panels = {
      summary: this._els.tabSummary,
      advanced: this._els.tabAdvanced,
      byId: this._els.tabById,
    };
    // ?.() обязателен: ?. на получателе не проверяет наличие метода.
    // Без него несовпадение версий вьюхи и контроллера роняло клик
    // по вкладке целиком, а не деградировало до «оверлей не закрыт».
    if (tab !== "summary") this.summaryView?.closeOverlays?.();
    if (tab !== "advanced") this.filtersView?.closeOverlays?.();
    for (const [key, node] of Object.entries(panels)) {
      node.style.display = key === tab ? "" : "none";
    }
    this._els.tabs.querySelectorAll(".rep-tab").forEach((btn) => {
      btn.classList.toggle(
        "rep-tab-active",
        btn.getAttribute("data-tab") === tab,
      );
    });
    if (tab === "summary") this._ensureSummary();
    if (tab === "advanced") this._ensureFilters();
  }

  _bindById() {
    const go = () => {
      const raw = String(this._els.byIdInput.value || "").trim();
      if (!/^\d+$/.test(raw)) {
        notify.warning("Введите номер заявки числом.");
        return;
      }
      this.router.navigate("#/ticket/" + encodeURIComponent(raw));
    };
    this._els.byIdBtn.addEventListener("click", go);
    this._els.byIdInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") go();
    });
  }

  _bindResultHint() {
    this._els.showBtn.addEventListener("click", () => {
      // Жест пользователя: фокус и переоткрытие разрешены.
      this._focusOrReopen();
    });
    this._updateResultHint();
  }

  _resultsAlive() {
    return !!(this._resultsWindow && !this._resultsWindow.closed);
  }

  _updateResultHint() {
    if (!this._els) return;
    const alive = this._resultsAlive();
    this._els.hintText.textContent = alive
      ? "Таблица открыта в отдельной вкладке. «Найти» обновит её и переведёт фокус."
      : "Таблица откроется в отдельной вкладке браузера.";
    this._els.showBtn.style.display = alive ? "" : "none";
  }

  _focusOrReopen() {
    if (this._resultsAlive()) {
      try {
        this._resultsWindow.focus();
      } catch (e) {
        console.warn("[ReportsController] focus:", e);
      }
      return;
    }
    const win = window.open(resultsUrl(), REPORTS.RESULTS_WINDOW_NAME);
    if (!win) {
      notify.warning(
        "Браузер заблокировал вкладку. Разрешите всплывающие окна для этого сайта.",
      );
      return;
    }
    this._resultsWindow = win;
    try {
      win.focus();
    } catch (e) {}
    this._updateResultHint();
  }

  /**
   * Публикация запроса + открытие/фокус вкладки. Строго синхронно.
   * Порядок: сначала пишем запрос, потом открываем — свежая вкладка
   * читает ключ при загрузке и не ждёт события.
   */
  _dispatchResults(payload) {
    const uid = this._userId();
    const req = publishResultRequest(uid, payload);
    if (!req) {
      notify.error(
        "Не удалось передать запрос в таблицу: хранилище недоступно.",
      );
      return;
    }
    if (this._resultsAlive()) {
      // Живая вкладка получит storage-событие и обновится сама.
      try {
        this._resultsWindow.focus();
      } catch (e) {}
      this._updateResultHint();
      return;
    }
    const win = window.open(resultsUrl(), REPORTS.RESULTS_WINDOW_NAME);
    if (!win) {
      notify.warning(
        "Браузер заблокировал новую вкладку. Разрешите всплывающие окна и нажмите «Найти» снова.",
        { timeout: 0 },
      );
      logHistoryAction("Отчёты: браузер заблокировал вкладку таблицы.");
      return;
    }
    this._resultsWindow = win;
    try {
      win.focus();
    } catch (e) {}
    this._updateResultHint();
  }

  _subscribeNetwork() {
    this._eventsAbort = new AbortController();
    const signal = this._eventsAbort.signal;
    window.addEventListener("offline", () => this._setOffline(true), {
      signal,
    });
    window.addEventListener(
      "online",
      () => {
        this._setOffline(false);
        if (!this._isActive) return;
        if (this.state.tab === "summary")
          this._refreshSummary({ skeleton: true });
      },
      { signal },
    );
    // Возврат из вкладки таблицы — обновляем подпись состояния.
    window.addEventListener("focus", () => this._updateResultHint(), {
      signal,
    });
  }

  // ------------------------------------------------------------------
  // Сводка
  // ------------------------------------------------------------------
  async _ensureSummary() {
    if (this.summaryView) {
      this._refreshSummary({ skeleton: true });
      return;
    }
    const myMountId = this._mountId;
    const isStale = () => !this._isActive || this._mountId !== myMountId;
    let cities = [];
    try {
      cities = await offlineDB.getCities();
    } catch (e) {
      console.warn("[ReportsController] getCities failed:", e);
    }
    if (isStale() || this.state.tab !== "summary") return;
    this.summaryView = createSummaryView({
      cities,
      initialPeriod: this.state.summaryPeriod,
      initialCities: this.state.summaryCities,
      onPeriodChange: () => {
        this._saveState();
        this._refreshSummary({ skeleton: true });
      },
      onCitiesChange: () => {
        this._saveState();
        if (this._summaryDebounce) clearTimeout(this._summaryDebounce);
        this._summaryDebounce = setTimeout(() => {
          this._summaryDebounce = null;
          this._refreshSummary({ skeleton: false });
        }, REPORTS.SUMMARY_DEBOUNCE_MS);
      },
      onRefresh: () => this._refreshSummary({ skeleton: false }),
    });
    this._els.summaryHost.innerHTML = "";
    this._els.summaryHost.appendChild(this.summaryView.element);
    this._refreshSummary({ skeleton: true });
  }

  async _refreshSummary({ skeleton = false } = {}) {
    if (!this.summaryView || !navigator.onLine) return;
    const myMountId = this._mountId;
    const isStale = () => !this._isActive || this._mountId !== myMountId;
    const seq = ++this._summarySeq;
    if (skeleton) this.summaryView.showSkeleton();
    else this.summaryView.setUpdating(true);

    const resp = await this.repo.fetchSummary(
      this.summaryView.getPeriod(),
      this.summaryView.getCityIds(),
    );
    if (isStale() || seq !== this._summarySeq) return;
    if (resp?._authLost) return;
    if (resp?.offline === true) {
      this._setOffline(true);
      return;
    }
    if (resp?.code === "aborted") return;
    if (!resp || resp.status !== "ok") {
      this.summaryView.setUpdating(false);
      const msg = resp?.message || "Не удалось загрузить сводку.";
      logHistoryAction("Отчёты: " + msg);
      notify.error(msg);
      return;
    }
    this._setOffline(false);
    this.summaryView.render(resp.data ?? null);
  }

  // ------------------------------------------------------------------
  // Фильтры
  // ------------------------------------------------------------------
  async _ensureFilters() {
    if (this.filtersView) {
      this._updateResultHint();
      return;
    }
    const myMountId = this._mountId;
    const isStale = () => !this._isActive || this._mountId !== myMountId;
    if (!this._filtersData) {
      const resp = await this.repo.fetchFiltersData();
      if (isStale()) return;
      if (resp?._authLost) return;
      if (resp?.offline === true) {
        this._setOffline(true);
        return;
      }
      if (!resp || resp.status !== "ok" || !resp.data) {
        const msg =
          resp?.message || "Не удалось загрузить справочники отчётов.";
        logHistoryAction("Отчёты: " + msg);
        notify.error(msg);
        return;
      }
      this._filtersData = resp.data;
    }
    if (isStale() || this.state.tab !== "advanced") return;
    this.filtersView = createFiltersView({
      departments: this._filtersData.departments || [],
      staff: this._filtersData.staff || [],
      canStaffFilter: this._canView(),
      initial: this.state,
      onSubmit: (payload) => {
        this.state.sort = payload.sort;
        this._saveState();
        this._dispatchResults(payload);
      },
      onReset: () => this._onReset(),
    });
    this._els.filtersHost.innerHTML = "";
    this._els.filtersHost.appendChild(this.filtersView.element);
    this._updateResultHint();
  }

  _onReset() {
    const def = defaultReportState();
    this.state = {
      ...def,
      tab: this.state.tab,
      summaryPeriod: this.state.summaryPeriod,
      summaryCities: this.state.summaryCities,
    };
    this.filtersView?.setValues(this.state);
    this._saveState();
  }

  // ------------------------------------------------------------------
  _setOffline(flag) {
    if (!this._els) return;
    if (flag) {
      if (this._els.stub.dataset.denied === "1") return;
      this._showStub("Отчёты доступны только при наличии интернета.");
      this.summaryView?.setControlsEnabled(false);
      if (this.filtersView) {
        this.filtersView.element.style.pointerEvents = "none";
        this.filtersView.element.style.opacity = "0.55";
      }
    } else if (this._els.stub.dataset.denied !== "1") {
      this._els.stub.style.display = "none";
      this.summaryView?.setControlsEnabled(true);
      if (this.filtersView) {
        this.filtersView.element.style.pointerEvents = "";
        this.filtersView.element.style.opacity = "";
      }
    }
  }

  _showStub(text) {
    if (!this._els) return;
    this._els.stub.textContent = text;
    this._els.stub.style.display = "";
  }

  _saveState() {
    const summary = this.summaryView?.snapshot() ?? {
      summaryPeriod: this.state.summaryPeriod,
      summaryCities: this.state.summaryCities,
    };
    const advanced = this.filtersView?.snapshot() ?? {};
    saveReportState({
      ...this.state,
      ...advanced,
      ...summary,
      tab: this.state.tab,
    });
  }
}
