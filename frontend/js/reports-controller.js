import { REPORTS } from "./config.js";
import { userStore } from "./user-store.js";
import { authStore } from "./auth-store.js";
import { notify } from "./components/notify.js";
import { logHistoryAction } from "./history-logger.js";
import { createReportsRepository } from "./reports/reports-repository.js";
import {
    loadReportState,
    saveReportState,
    defaultReportState,
} from "./reports/reports-state.js";
import { createFiltersView } from "./reports/views/filters-view.js";
import { renderStats } from "./reports/views/stats-view.js";
import { createTableView } from "./reports/views/table-view.js";

/**
 * Экран отчётов. Владение DOM — по образцу журналов: _mountId растёт
 * в mount/unmount, после каждого await isStale() перед обращением
 * к вьюхам или навигацией. leaveAll() в main.js вызывает unmount ДО
 * замены разметки, поэтому picker успевает снять подложку.
 *
 * Офлайн: превентивно по navigator.onLine и по факту ответа
 * resp.offline === true (правило 6: флаг, не коды). code:"aborted"
 * без offline — отмена при unmount, молча. http_* — тост ошибки,
 * НЕ заглушка: сервер жив, путать с обрывом канала нельзя.
 *
 * Данные при ошибке НЕ очищаются (§16.5): пользователь продолжает
 * видеть последний успешный срез, заглушка лишь объясняет причину.
 */
export class ReportsController {
    constructor(apiInstance, routerInstance) {
        this.api = apiInstance;
        this.router = routerInstance;
        this.repo = createReportsRepository(apiInstance);
        this._mountId = 0;
        this._isActive = false;
        this._filtersData = null;
        this.filtersView = null;
        this.tableView = null;
        this.state = null;
        this._cooldownTimer = null;
        this._eventsAbort = null;
        this._els = null;
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
        this._bindTabs();
        this._bindById();
        this._subscribeNetwork();

        // Серверные права приоритетны (правило 7): локальная проверка —
        // лишь UX. Инженер с position=foreman получает фильтр по
        // ответственному (§15.6), меню ему не показываем.
        if (!this._canView()) {
            this._showStub("Отчёты недоступны для вашей роли.");
            return;
        }
        if (!navigator.onLine) {
            this._setOffline(true);
            return;
        }

        const resp = await this.repo.fetchFiltersData();
        if (isStale() || !this._isActive) return;
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
        this._buildViews();
        if (isStale()) return;
        this.tableView.rebuildHeaders();
        this.tableView.bindRowClick();
        this._applyTab(this.state.tab);
        await this._runSearch(1);
    }

    /**
     * Перечитывание настроек в смонтированный экран (auth:loggedin,
     * смена пользователя). Гарантия та же, что у журналов: scope и
     * источник колонок переподтверждаются, чужой набор не наследуется.
     */
    refreshColumns() {
        if (!this._isActive) return;
        this.tableView?.rebuildHeaders();
    }

    unmount() {
        this._mountId++;
        this._isActive = false;
        if (this._cooldownTimer) {
            clearTimeout(this._cooldownTimer);
            this._cooldownTimer = null;
        }
        if (this._eventsAbort) {
            this._eventsAbort.abort();
            this._eventsAbort = null;
        }
        this.api.abortTag("reports");
        this.filtersView?.destroy();
        this.filtersView = null;
        this.tableView?.destroy();
        this.tableView = null;
        this._filtersData = null;
        this._els = null;
    }

    // ------------------------------------------------------------------
    // Сборка DOM и вьюх
    // ------------------------------------------------------------------
    _grabElements() {
        const get = (id) => document.getElementById(id);
        const els = {
            table: get("reportsTable"),
            filtersHost: get("repFiltersHost"),
            statsHost: get("repStatsHost"),
            pagination: get("repPagination"),
            stub: get("repOfflineStub"),
            empty: get("repEmptyStub"),
            tabs: get("repTabs"),
            tabMain: get("repTabMain"),
            tabById: get("repTabById"),
            byIdInput: get("repTicketId"),
            byIdBtn: get("repByIdBtn"),
        };
        for (const [name, el] of Object.entries(els)) {
            if (!el) {
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

    _buildViews() {
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
    }

    _bindTabs() {
        const buttons = this._els.tabs.querySelectorAll(".rep-tab");
        buttons.forEach((btn) => {
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
        const isById = tab === "byId";
        this._els.tabMain.style.display = isById ? "none" : "";
        this._els.tabById.style.display = isById ? "" : "none";
        // Сводка видна только на своей вкладке: на «Расширенном поиске»
        // место под таблицу дороже карточек.
        this._els.statsHost.style.display = tab === "summary" ? "" : "none";
        this._els.tabs.querySelectorAll(".rep-tab").forEach((btn) => {
            btn.classList.toggle("rep-tab-active", btn.getAttribute("data-tab") === tab);
        });
    }

    _bindById() {
        const go = () => {
            const raw = String(this._els.byIdInput.value || "").trim();
            if (!/^\d+$/.test(raw)) {
                notify.warning("Введите номер заявки числом.");
                return;
            }
            // Сервер сам вернёт null без прав — карточка покажет 404 (§6.4).
            this.router.navigate("#/ticket/" + encodeURIComponent(raw));
        };
        this._els.byIdBtn.addEventListener("click", go);
        this._els.byIdInput.addEventListener("keydown", (e) => {
            if (e.key === "Enter") go();
        });
    }

    _subscribeNetwork() {
        this._eventsAbort = new AbortController();
        window.addEventListener(
            "offline",
            () => this._setOffline(true),
            { signal: this._eventsAbort.signal },
        );
        window.addEventListener(
            "online",
            () => this._setOffline(false),
            { signal: this._eventsAbort.signal },
        );
    }

    // ------------------------------------------------------------------
    // Поиск
    // ------------------------------------------------------------------
    async _runSearch(page) {
        const myMountId = this._mountId;
        const isStale = () => !this._isActive || this._mountId !== myMountId;
        if (!this.filtersView) return;
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
        this.state = { ...def, tab: this.state.tab };
        this.filtersView.setValues(this.state);
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
            const blob = new Blob([bytes], {
                type: resp.data.mime_type || "text/csv",
            });
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
            // Кулдаун ставим и на успех: окно 30 с на сервере всё равно идёт.
            this._startCooldown(REPORTS.EXPORT_COOLDOWN_SEC);
        } catch (e) {
            console.warn("[ReportsController] save file failed:", e);
            notify.error("Не удалось сохранить файл выгрузки.");
        }
    }

    _startCooldown(sec) {
        if (this._cooldownTimer) clearTimeout(this._cooldownTimer);
        this.filtersView?.setBusy(true);
        this._cooldownTimer = setTimeout(() => {
            this._cooldownTimer = null;
            if (this._isActive) this.filtersView?.setBusy(false);
        }, Math.max(1, sec) * 1000);
    }

    // ------------------------------------------------------------------
    // Служебное
    // ------------------------------------------------------------------
    _setOffline(flag) {
        if (!this._els) return;
        if (flag) {
            this._showStub("Отчёты доступны только при наличии интернета.");
        } else if (this._els.stub.dataset.denied !== "1") {
            this._els.stub.style.display = "none";
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
        // Кнопки гасим целиком: офлайн-экран не должен принимать ввод.
        if (this.filtersView) {
            this.filtersView.element.style.pointerEvents = "none";
            this.filtersView.element.style.opacity = "0.55";
        }
    }

    _saveState() {
        if (!this.filtersView) return;
        saveReportState({ ...this.filtersView.snapshot(), tab: this.state.tab, page: this.state.page });
    }
}

/** body-render читает колонку «Адрес» как rowData.address. */
function mapRow(item) {
    return { ...item, address: item.fullAddress ?? item.address ?? "" };
}