import { REPORTS } from "./config.js";
import { userStore } from "./user-store.js";
import { authStore } from "./auth-store.js";
import { notify } from "./components/notify.js";
import { logHistoryAction } from "./history-logger.js";
import { createReportsRepository } from "./reports/reports-repository.js";
import {
  readResultRequest,
  subscribeResultRequests,
} from "./reports/result-channel.js";
import { renderStats } from "./reports/views/stats-view.js";
import { createTableView } from "./reports/views/table-view.js";
import { formatTsMsk } from "./utils/date-utils.js";
import { renderPrintDocument } from "./reports/print-document.js";

/**
 * Вкладка браузера с таблицей результатов.
 *
 * Запрос приходит из вкладки фильтров: при загрузке читается ключ
 * localStorage, дальше — событие storage. Собственных фильтров нет,
 * поэтому таблица всегда показывает ровно то, что запросил диспетчер,
 * а не то, что успели поменять в форме после поиска.
 *
 * Экспорт работает по последнему принятому payload. Кулдаун свой:
 * обновление таблицы его не сбрасывает.
 *
 * После каждого await — isStale() (правило 2). Офлайн — по флагу
 * resp.offline === true, не по кодам (правило 6).
 */
export class ReportsResultsController {
  constructor(apiInstance, routerInstance) {
    this.api = apiInstance;
    this.router = routerInstance;
    this.repo = createReportsRepository(apiInstance);
    this._mountId = 0;
    this._isActive = false;
    this._els = null;
    this.tableView = null;
    this._unsubscribe = null;
    this._eventsAbort = null;
    this._cooldownTimer = null;
    this._cooldownUntil = 0;
    this._exportBusy = false;
    this._printBusy = false;
    this._xlsxBusy = false;
    this._payload = null;
    this._isEmpty = false;
    this._page = 1;
    this._seq = 0;
    this._baseTitle = document.title;
  }

  get isActive() {
    return this._isActive === true;
  }

  async mount() {
    const myMountId = ++this._mountId;
    const isStale = () => this._mountId !== myMountId;
    this._isActive = true;
    if (!this._grabElements()) return;

    if (!this._canView()) {
      this._showStub("Отчёты недоступны для вашей роли.");
      return;
    }

    this.tableView = createTableView(this._els.table, this.router);
    this.tableView.rebuildHeaders();
    this.tableView.bindRowClick();
    this._bindButtons();
    this._subscribeNetwork();

    const uid = this._userId();
    this._unsubscribe = subscribeResultRequests(uid, (req) => {
      if (!this._isActive) return;
      this._accept(req);
    });

    const req = readResultRequest(uid);
    if (!req || !req.payload) {
      this._showStub(
        "Запрос не получен. Вернитесь во вкладку отчётов, задайте фильтры и нажмите «Найти».",
      );
      return;
    }
    this._accept(req);
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
    if (this._unsubscribe) this._unsubscribe();
    this._unsubscribe = null;
    if (this._eventsAbort) this._eventsAbort.abort();
    this._eventsAbort = null;
    this.api.abortTag("reports");
    this.tableView?.destroy();
    this.tableView = null;
    this._els = null;
    document.title = this._baseTitle;
  }

  // ------------------------------------------------------------------
  _grabElements() {
    const get = (id) => document.getElementById(id);
    const els = {
      stub: get("rrStub"),
      echo: get("rrEcho"),
      period: get("rrPeriod"),
      count: get("rrCount"),
      statsDetails: get("rrStatsDetails"),
      statsSummary: get("rrStatsSummary"),
      statsHost: get("rrStatsHost"),
      table: get("reportsTable"),
      empty: get("rrEmpty"),
      pagination: get("rrPagination"),
      refreshBtn: get("rrRefreshBtn"),
      exportBtn: get("rrExportBtn"),
      printBtn: get("rrPrintBtn"),
    };
    for (const [name, node] of Object.entries(els)) {
      if (!node) {
        console.warn("[ReportsResults] нет элемента:", name);
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

  _bindButtons() {
    this._els.refreshBtn.addEventListener("click", () => {
      if (!this._payload) {
        const req = readResultRequest(this._userId());
        if (req?.payload) this._accept(req);
        return;
      }
      this._run(this._page);
    });
    this._els.exportBtn.addEventListener("click", () => this._onExport());
    // Кнопка ищется по id, а не через _grabElements: правка grab
    // потребовала бы ещё одного якоря, а элемент статический.
    document
      .getElementById("rrXlsxBtn")
      ?.addEventListener("click", () => this._onXlsx());
    this._els.printBtn.addEventListener("click", () => this._onPrint());
    this._syncExport();
  }

  /**
   * Печать — третье окно с чистым документом, не window.print()
   * по экранной таблице: там липкие колонки, ширины ресайзера
   * и только текущая страница.
   *
   * Окно открывается СИНХРОННО в клике, до первого await — иначе
   * блокировщик попапов. noopener нельзя: нужен win.document.
   * Данные — по _payload последнего принятого поиска, не по форме.
   */
  async _onPrint() {
    if (this._printBusy) return;

    const win = window.open(
      "",
      REPORTS.PRINT_WINDOW_NAME,
      "width=1280,height=900,resizable=yes,scrollbars=yes",
    );
    if (!win) {
      notify.warning(
        "Браузер заблокировал окно печати. Разрешите всплывающие окна для этого сайта.",
      );
      return;
    }

    if (!this._payload) {
      const req = readResultRequest(this._userId());
      if (req?.payload) this._payload = req.payload;
    }
    if (!this._payload) {
      this._printMessage(
        win,
        "Нет данных для печати. Сначала выполните поиск во вкладке фильтров.",
      );
      return;
    }

    const myMountId = this._mountId;
    const sheetId =
      document.getElementById("rrPrintSheet")?.value ??
      REPORTS.PRINT_SHEET_DEFAULT;
    const meta = {
      tenant: this._baseTitle,
      period: document.getElementById("rrPeriod")?.textContent?.trim() ?? "",
      filters: document.getElementById("rrEcho")?.textContent?.trim() ?? "",
      generated: `Сформировано: ${formatTsMsk(Math.floor(Date.now() / 1000))} (МСК)`,
    };

    this._printBusy = true;
    this._printMessage(win, "Загрузка данных для печати…");

    try {
      const resp = await this.repo.fetchPrintRows(this._payload);
      // Правило 2: после каждого await. Плюс окно мог закрыть сам пользователь.
      if (this._mountId !== myMountId || !this._isActive) return;
      if (win.closed) return;

      // Правило 6: отказ канала — по флагу, не по коду.
      if (resp?.offline === true) {
        this._printMessage(
          win,
          "Нет соединения. Печать доступна только онлайн.",
        );
        return;
      }
      if (resp?.code === "aborted" || resp?._authLost) return;
      // retryAfterSec и reason лежат на верхнем уровне — как в _onExport.
      if (resp?.code === "rate_limited") {
        const sec = Number(resp.retryAfterSec) || REPORTS.PRINT_COOLDOWN_SEC;
        this._printMessage(
          win,
          `Слишком частые запросы печати. Повторите через ${sec} с.`,
        );
        return;
      }
      if (!resp || resp.status !== "ok") {
        this._printMessage(
          win,
          resp?.reason === "export_too_many_rows"
            ? "Слишком много результатов. Сузьте период поиска и повторите печать."
            : resp?.message || "Не удалось получить данные для печати.",
        );
        return;
      }

      const rows = Array.isArray(resp?.data?.rows) ? resp.data.rows : null;
      if (!rows || rows.length === 0) {
        this._printMessage(
          win,
          "По этому запросу ничего не найдено — печатать нечего.",
        );
        return;
      }

      renderPrintDocument(win, { rows, meta, sheetId });
    } finally {
      this._printBusy = false;
    }
  }

  /**
   * XLSX. Кулдаун НЕ клиентский: серверные бакеты csv и xlsx разведены,
   * а _startCooldown() гасит кнопку CSV. Вызов его здесь сомкнул бы
   * бакеты обратно — после книги CSV молчал бы 30 с без причины.
   */
  async _onXlsx() {
    if (!this._payload || this._xlsxBusy) return;
    const btn = document.getElementById("rrXlsxBtn");
    const myMountId = this._mountId;
    const isStale = () => !this._isActive || this._mountId !== myMountId;

    this._xlsxBusy = true;
    if (btn) btn.disabled = true;
    try {
      const resp = await this.repo.exportXlsx(this._payload);
      if (isStale()) return;
      if (resp?._authLost) return;
      if (resp?.offline === true) {
        this._showStub("Нет соединения. Выгрузка недоступна.");
        return;
      }
      if (resp?.code === "rate_limited") {
        const sec = Number(resp.retryAfterSec) || REPORTS.EXPORT_COOLDOWN_SEC;
        notify.warning(
          `Слишком часто. Повторите выгрузку XLSX через ${sec} с.`,
        );
        return;
      }
      if (!resp || resp.status !== "ok") {
        if (resp?.reason === "export_too_many_rows") {
          notify.warning("Слишком много результатов. Сузьте период поиска.");
        } else {
          notify.error(resp?.message || "Не удалось выгрузить книгу.");
        }
        logHistoryAction(
          "Выгрузка XLSX отчёта: " + (resp?.message || resp?.code || "ошибка"),
        );
        return;
      }
      if (!resp.data) {
        notify.info(resp.message || "По вашему запросу ничего не найдено");
        return;
      }
      if (this._saveFile(resp.data, "report.xlsx")) {
        notify.success(`Выгружено строк: ${resp.data.rows_count ?? 0}`);
        logHistoryAction(
          `Выгрузка XLSX отчёта (${resp.data.rows_count ?? 0} строк).`,
        );
      }
    } finally {
      this._xlsxBusy = false;
      if (btn && !isStale()) btn.disabled = false;
    }
  }

  /** base64 → blob → ссылка. Копия образца из _onExport. */
  _saveFile(data, fallbackName) {
    try {
      const bin = atob(data.file_base64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const blob = new Blob([bytes], {
        type: data.mime_type || "application/octet-stream",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = data.filename || fallbackName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      return true;
    } catch (e) {
      console.warn("[ReportsResults] save file failed:", e);
      notify.error("Не удалось сохранить файл выгрузки.");
      return false;
    }
  }

  /** Сообщение в окне печати: статический каркас + textContent. */
  _printMessage(win, text) {
    if (!win || win.closed) return;
    const doc = win.document;
    doc.open();
    doc.write(
      "<!doctype html><html lang='ru'><head><meta charset='utf-8'><title>Отчёт</title></head><body></body></html>",
    );
    doc.close();
    const p = doc.createElement("p");
    p.style.cssText = "font:12pt Arial,sans-serif;padding:16px;margin:0;";
    p.textContent = text;
    doc.body.appendChild(p);
  }

  _subscribeNetwork() {
    this._eventsAbort = new AbortController();
    const signal = this._eventsAbort.signal;
    window.addEventListener(
      "offline",
      () =>
        this._showStub(
          "Нет соединения. Таблица показывает последние полученные данные.",
        ),
      { signal },
    );
    window.addEventListener(
      "online",
      () => {
        this._hideStub();
        if (this._isActive && this._payload) this._run(this._page);
      },
      { signal },
    );
  }

  _accept(req) {
    if (!req || !req.payload || typeof req.payload !== "object") return;
    // Чужой аккаунт в этой же вкладке — запрос не применяем.
    const uid = this._userId();
    if (
      req.userId != null &&
      uid != null &&
      String(req.userId) !== String(uid)
    ) {
      this._showStub(
        "Запрос принадлежит другому пользователю. Обновите его во вкладке отчётов.",
      );
      return;
    }
    this._payload = req.payload;
    this._page = 1;
    this._hideStub();
    this._run(1);
  }

  _echoText(p, pg) {
    const parts = [];
    parts.push(
      p.date_type === "closed" ? "по дате закрытия" : "по дате создания",
    );
    const deps = Array.isArray(p.department_ids) ? p.department_ids.length : 0;
    parts.push(deps ? `отделов: ${deps}` : "все отделы");
    parts.push(
      p.status === "open"
        ? "открытые"
        : p.status === "close"
          ? "закрытые"
          : "все статусы",
    );
    if (p.city_only) parts.push("только город");
    else if (p.object_id) parts.push("конкретный лифт");
    else if (p.home_id) parts.push("конкретный дом");
    else if (p.city_id) parts.push("город");
    if (p.staff_id) parts.push("по ответственному");
    if (p.details_text) parts.push("поиск в описании");
    if (p.solution_text) parts.push("поиск в решении");
    parts.push(REPORTS.SORTS[p.sort]?.toLowerCase() || "по дате");
    if (pg)
      parts.push(`стр. ${pg.current_page} из ${Math.max(1, pg.total_pages)}`);
    return parts.join(" · ");
  }

  async _run(page) {
    if (!this._payload || !this.tableView) return;
    const myMountId = this._mountId;
    const isStale = () => !this._isActive || this._mountId !== myMountId;
    const seq = ++this._seq;
    this._page = page;
    this._els.refreshBtn.disabled = true;

    const [statsResp, listResp] = await Promise.all([
      this.repo.fetchStats(this._payload),
      this.repo.fetchList(this._payload, page, REPORTS.LIMIT_DEFAULT),
    ]);
    if (isStale() || seq !== this._seq) return;
    this._els.refreshBtn.disabled = false;
    if (statsResp?._authLost || listResp?._authLost) return;
    if (statsResp?.offline === true || listResp?.offline === true) {
      this._showStub("Нет соединения. Показаны последние полученные данные.");
      return;
    }
    if (statsResp?.code === "aborted" || listResp?.code === "aborted") return;
    const err = [statsResp, listResp].find((r) => r && r.status === "error");
    if (err) {
      const msg = err.message || "Не удалось построить отчёт.";
      logHistoryAction("Отчёты: " + msg);
      notify.error(msg);
      this._showStub(msg);
      return;
    }

    this._hideStub();
    const stats = statsResp?.data ?? null;
    const list = listResp?.data;
    const pg = list?.pagination ?? null;
    const items = Array.isArray(list?.items) ? list.items.map(mapRow) : [];

    renderStats(this._els.statsHost, stats);
    this._els.statsSummary.textContent = stats
      ? `Сводка по выборке · всего ${stats.total ?? 0} · открыто ${stats.open ?? 0} · закрыто ${stats.closed ?? 0}`
      : "Сводка по выборке";

    this.tableView.renderRows(items);
    this._isEmpty = items.length === 0;
    this._els.empty.style.display = this._isEmpty ? "" : "none";
    this.tableView.renderPagination(this._els.pagination, pg, (next) =>
      this._run(next),
    );

    this._els.echo.textContent = this._echoText(this._payload, pg);
    this._els.period.textContent = `Период МСК: ${formatTsMsk(this._payload.date_from)} — ${formatTsMsk(this._payload.date_to)}`;
    this._els.count.textContent = pg ? `Найдено: ${pg.total_items}` : "";
    // Номер в заголовке вкладки: диспетчер находит нужную вкладку
    // среди десятка открытых по одному взгляду.
    document.title = pg
      ? `Отчёт (${pg.total_items}) — LiftCS`
      : "Таблица отчёта — LiftCS";
    this._syncExport();
  }

  // ------------------------------------------------------------------
  async _onExport() {
    if (!this._payload || this._exportBusy) return;
    const myMountId = this._mountId;
    const isStale = () => !this._isActive || this._mountId !== myMountId;
    this._exportBusy = true;
    this._syncExport();
    const resp = await this.repo.exportCsv(this._payload);
    if (isStale()) return;
    this._exportBusy = false;
    this._syncExport();
    if (resp?._authLost) return;
    if (resp?.offline === true) {
      this._showStub("Нет соединения. Выгрузка недоступна.");
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
      logHistoryAction(
        "Экспорт отчёта: " + (resp?.message || resp?.code || "ошибка"),
      );
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
      logHistoryAction(
        `Выгрузка CSV отчёта (${resp.data.rows_count ?? 0} строк).`,
      );
      this._startCooldown(REPORTS.EXPORT_COOLDOWN_SEC);
    } catch (e) {
      console.warn("[ReportsResults] save file failed:", e);
      notify.error("Не удалось сохранить файл выгрузки.");
    }
  }

  _startCooldown(sec) {
    if (this._cooldownTimer) clearTimeout(this._cooldownTimer);
    this._cooldownUntil = Date.now() + Math.max(1, Number(sec) || 1) * 1000;
    this._syncExport();
    this._cooldownTimer = setTimeout(
      () => {
        this._cooldownTimer = null;
        if (this._isActive) this._syncExport();
      },
      Math.max(1, sec) * 1000,
    );
  }

  _syncExport() {
    if (!this._els) return;
    const cooling = Date.now() < this._cooldownUntil;
    // Пустая выборка: сервер вернёт data:null, но окно 30 с уже
    // сгорит — лимит стоит до запроса намеренно (защита от перебора
    // широких периодов). Гасим кнопку здесь, чтобы честный пустой
    // поиск не блокировал следующую выгрузку.
    const blocked =
      !this._payload || this._exportBusy || cooling || this._isEmpty;
    this._els.exportBtn.disabled = blocked;
    this._els.exportBtn.textContent = this._exportBusy
      ? "Генерация..."
      : "Выгрузить CSV";
    this._els.exportBtn.title = this._isEmpty
      ? "В выборке нет строк — выгружать нечего"
      : "";
    this._els.printBtn.disabled = !this._payload || this._isEmpty;
  }

  _showStub(text) {
    if (!this._els) return;
    this._els.stub.textContent = text;
    this._els.stub.style.display = "";
  }

  _hideStub() {
    if (this._els) this._els.stub.style.display = "none";
  }
}

/** body-render читает колонку «Адрес» как rowData.address. */
function mapRow(item) {
  return { ...item, address: item.fullAddress ?? item.address ?? "" };
}
