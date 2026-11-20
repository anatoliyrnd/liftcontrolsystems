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
import { createSummaryView } from "./reports/views/summary-view.js";
import { createFiltersView } from "./reports/views/filters-view.js";
import { renderStats } from "./reports/views/stats-view.js";
import { createTableView } from "./reports/views/table-view.js";

/**
 * Экран отчётов, волна 1.1.
 *
 * Сводка — дашборд (пресет + города + KPI + графики), расширенный
 * поиск — фильтры + таблица + экспорт. Вьюхи ленивые: пикер адреса
 * создаётся только при входе в расширенный поиск и уничтожается при
 * уходе — подложка не переживает вкладку.
 *
 * Теги раздельные: reports_summary и reports. Уход с вкладки гасит
 * только её запросы. После каждого await — isStale() (правило 2).
 * Офлайн — по resp.offline === true, не по кодам (правило 6).
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
        this.tableView = null;
        this.state = null;
        this._cooldownTimer = null;
        this._summaryDebounce = null;
        this._eventsAbort = null;
        this._els = null;
        this._summarySeq = 0;
    }

    get isActive() {
        return this._isActive === true;
    }

    async mount() {
        const myMountId = ++this._mountId;
        const isStale = () => this._mountId !== myMountId;
        this._isActive = true;
        this.state = loadReportState();

        if (!this._grabElements()) return;
        this._subscribeNetwork();

        if (!this._canView()) {
            this._els.stub.dataset.denied = "1";
            this._showStub("Отчёты недоступны для вашей роли.");
            return;
        }
        this._bindTabs();
        this._bindById();
        this._applyTab(this.state.tab);
        if (isStale()) return;
    }

    refreshColumns() {
        if (!this._isActive) return;
        this.tableView?.rebuildHeaders();
    }

    unmount() {
        this._mountId++;
        this._isActive = false;
        if (this._cooldownTimer) clearTimeout(this._cooldownTimer);
        this._cooldownTimer = null;
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
        this.tableView?.destroy();
        this.tableView = null;
        this._filtersData = null;
        this._els = null;
    }

    // ------------------------------------------------------------------
    _grabElements() {
        const get = (id) => document.getElementById(id);
        const els = {
            stub: get("repOfflineStub"),
            tabs: get("repTabs"),
            tabSummary: get("repTabSummary"),
            tabById: get("repTabById"),
            tabAdvanced: get("repTabAdvanced"),
            summaryHost: get("repSummaryHost"),
            filtersHost: get("repFiltersHost"),
            statsHost: get("repStatsHost"),
            table: get("reportsTable"),
            pagination: get("repPagination"),
            empty: get("repEmptyStub"),
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
        const isSummary = tab === "summary";
        const isAdvanced = tab === "advanced";
        this._els.tabSummary.style.display = isSummary ? "" : "none";
        this._els.tabById.style.display = tab === "byId" ? "" : "none";
        this._els.tabAdvanced.style.display = isAdvanced ? "" : "none";
        this._els.tabs.querySelectorAll(".rep-tab").forEach((btn) => {
            btn.classList.toggle("rep-tab-active", btn.getAttribute("data-tab") === tab);
        });

        if (!isAdvanced) this._destroyAdvanced();
        if (!isSummary && this.summaryView) {
            this.api.abortTag("reports_summary");
            this.summaryView.destroy();
            this.summaryView = null;
        }
        if (isSummary) this._ensureSummary();
        if (isAdvanced) this._ensureAdvanced();
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

    _subscribeNetwork() {
        this._eventsAbort = new AbortController();
        window.addEventListener("offline", () => this._setOffline(true), {
            signal: this._eventsAbort.signal,
        });
        window.addEventListener(
            "online",
            () => {
                this._setOffline(false);
                if (!this._isActive) return;
                if (this.state.tab === "summary") this._refreshSummary({ skeleton: true });
                else if (this.state.tab === "advanced" && this.filtersView) this._runSearch(this.state.page || 1);
            },
            { signal: this._eventsAbort.signal },
        );
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
    // Расширенный поиск
    // ------------------------------------------------------------------
    async _ensureAdvanced() {
        if (this.filtersView) return;
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
                const msg = resp?.message || "Не удалось загрузить справочники отчётов.";
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
            onSubmit: () => this._runSearch(1),
            onExport: (payload) => this._onExport(payload),
            onReset: () => this._onReset(),
        });
        this._els.filtersHost.innerHTML = "";
        this._els.filtersHost.appendChild(this.filtersView.element);
        this.tableView = createTableView(this._els.table, this.router);
        this.tableView.rebuildHeaders();
        this.tableView.bindRowClick();
        this._runSearch(this.state.page || 1);
    }

    _destroyAdvanced() {
        if (!this.filtersView && !this.tableView) return;
        this.api.abortTag("reports");
        this.filtersView?.destroy();
        this.filtersView = null;
        this.tableView?.destroy();
        this.tableView = null;
        if (this._els) {
            this._els.filtersHost.innerHTML = "";
            this._els.statsHost.innerHTML = "";
            this._els.pagination.innerHTML = "";
            const tbody = this._els.table.querySelector("tbody");
            if (tbody) tbody.innerHTML = "";
            this._els.empty.style.display = "none";
        }
    }

    async _runSearch(page) {
        if (!this.filtersView) return;
        const myMountId = this._mountId;
        const isStale = () => !this._isActive || this._mountId !== myMountId;
        const payload = this.filtersView.getPayload();
        this.state.page = page;
        this.state.sort = payload.sort;
        this._saveState();
        this.filtersView.setBusy(true);

        const [statsResp, listResp] = await Promise.all([
            this.repo.fetchStats(payload),
            this.repo.fetchList(payload, page, REPORTS.LIMIT_DEFAULT),
        ]);
        if (isStale()) return;
        this.filtersView.setBusy(false);
        if (statsResp?._authLost || listResp?._authLost) return;
        if (statsResp?.offline === true || listResp?.offline === true) {
            this._setOffline(true);
            return;
        }
        if (statsResp?.code === "aborted" || listResp?.code === "aborted") return;
        const err = [statsResp, listResp].find((r) => r && r.status === "error");
        if (err) {
            const msg = err.message || "Не удалось построить отчёт.";
            logHistoryAction("Отчёты: " + msg);
            notify.error(msg);
            return;
        }
        this._setOffline(false);
        renderStats(this._els.statsHost, statsResp?.data ?? null);
        const list = listResp?.data;
        const items = Array.isArray(list?.items) ? list.items.map(mapRow) : [];
        this.tableView.renderRows(items);
        this._els.empty.style.display = items.length === 0 ? "" : "none";
        this.tableView.renderPagination(
            this._els.pagination,
            list?.pagination ?? null,
            (next) => this._runSearch(next),
        );
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
        this._runSearch(1);
    }

    // ------------------------------------------------------------------
    // Экспорт
    // ------------------------------------------------------------------
    async _onExport(payload) {
        const myMountId = this._mountId;
        const isStale = () => !this._isActive || this._mountId !== myMountId;
        this.filtersView.setBusy(true);
        const resp = await this.repo.exportCsv(payload);
        if (isStale()) return;
        this.filtersView.setBusy(false);
        if (resp?._authLost) return;
        if (resp?.offline === true) {
            this._setOffline(true);
            return;
        }
        if (resp?.code === "rate_limited") {
            const sec = Number(resp.retryAfterSec) || REPORTS.EXPORT_COOLDOWN_SEC;
            notify.warning(`Слишком часто. Повторите выгрузку через ${sec} с.`);
            this._startCooldown(sec);
            return;
        }
        if (!resp || resp.status !== "ok") {
            if (resp?.reason === "export_too_many_rows") {
                notify.warning("Слишком много результатов. Сузьте период поиска.");
            } else {
                notify.error(resp?.message || "Не удалось выгрузить отчёт.");
            }
            logHistoryAction("Экспорт отчёта: " + (resp?.message || resp?.code || "ошибка"));
            return;
        }
        if (!resp.data) {
            notify.info(resp.message || "По вашему запросу ничего не найдено");
            return;
        }
        try {
            const bin = atob(resp.data.file_base64);
            const bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
            const blob = new Blob([bytes], { type: resp.data.mime_type || "text/csv" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = resp.data.filename || "report.csv";
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 5000);
            notify.success(`Выгружено строк: ${resp.data.rows_count ?? 0}`);
            logHistoryAction(`Выгрузка CSV отчёта (${resp.data.rows_count ?? 0} строк).`);
            this._startCooldown(REPORTS.EXPORT_COOLDOWN_SEC);
        } catch (e) {
            console.warn("[ReportsController] save file failed:", e);
            notify.error("Не удалось сохранить файл выгрузки.");
        }
    }

    _startCooldown(sec) {
        if (this._cooldownTimer) clearTimeout(this._cooldownTimer);
        this.filtersView?.setCooldown(sec);
        this._cooldownTimer = setTimeout(() => {
            this._cooldownTimer = null;
            if (this._isActive) this.filtersView?.validate();
        }, Math.max(1, sec) * 1000);
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
            page: this.state.page,
        });
    }
}

/** body-render читает колонку «Адрес» как rowData.address. */
function mapRow(item) {
    return { ...item, address: item.fullAddress ?? item.address ?? "" };
}