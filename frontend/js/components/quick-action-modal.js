/**
 * Модалка быстрых действий из контекстного меню журнала.
 * Два режима: comment (AddComment) и close (CloseTicket).
 *
 * Живёт дольше меню: меню закрывается при выборе пункта, модалка
 * остаётся со снапшотом id + адрес. Строка под ней могла быть
 * пересоздана поллером — это не влияет на операцию.
 *
 * Запись данных не зависит от активности экрана: после isStale()
 * пропускаются DOM и навигация, но запись в outbox, тост и история
 * выполняются. Иначе набранное теряется при навигации или автовыходе.
 *
 * DOM строго через createElement + textContent.
 */
import { notify } from "./notify.js";
import { logHistoryAction } from "../history-logger.js";
import { VALIDATION, BUSINESS } from "../config.js";
import { ticketRepository } from "../details/ticket-repository.js";
import { outboxQueue } from "../outbox-queue.js";
import { userStore } from "../user-store.js";
import { authStore } from "../auth-store.js";

const MIN_LEN = VALIDATION.MIN_SOLUTION_LEN;
const CAPS_REGEX = VALIDATION.CAPS_REGEX;
/** Порог защиты от случайного закрытия по backdrop. */
const BACKDROP_GUARD_LEN = 3;

let api = null;
let root = null;
let backdrop = null;
let textarea = null;
let submitBtn = null;
let counterEl = null;
let warnEl = null;
let chipsWrap = null;
let mountId = 0;
let busy = false;
let ctx = null;
let returnFocusTo = null;
let keyAbort = null;

/** Подключение зависимостей один раз при старте приложения. */
export function init(apiInstance) {
    api = apiInstance;
}

function validate(raw) {
    const value = String(raw ?? "").trim();
    if (value.length < MIN_LEN) {
        return { ok: false, reason: "length", value };
    }
    if (CAPS_REGEX.test(value)) {
        return { ok: false, reason: "caps", value };
    }
    return { ok: true, reason: null, value };
}

function refreshState() {
    if (!textarea || !submitBtn || busy) return;
    const raw = textarea.value;
    const result = validate(raw);
    submitBtn.disabled = !result.ok;

    const left = Math.max(0, MIN_LEN - raw.trim().length);
    if (counterEl) {
        counterEl.textContent =
            left > 0 ? `Ещё ${left} симв.` : `${raw.trim().length} симв.`;
        counterEl.classList.toggle("is-ok", left === 0);
    }
    if (warnEl) {
        if (result.reason === "caps") {
            warnEl.textContent =
                "Слишком много заглавных букв подряд — напишите обычным текстом.";
            warnEl.style.display = "block";
        } else {
            warnEl.style.display = "none";
        }
    }
}

function setBusy(state) {
    busy = state;
    if (textarea) textarea.disabled = state;
    if (submitBtn) {
        submitBtn.disabled = state;
        submitBtn.textContent = state ? "Сохранение..." : "Сохранить";
    }
    if (chipsWrap) {
        chipsWrap.querySelectorAll("button").forEach((b) => {
            b.disabled = state;
        });
    }
    const cancel = root?.querySelector("[data-role='cancel']");
    if (cancel) cancel.disabled = state;
}

function buildDom(mode, snapshot) {
    const bd = document.createElement("div");
    bd.className = "quick-modal-backdrop";

    const box = document.createElement("div");
    box.className = "quick-modal";
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-modal", "true");
    box.setAttribute("tabindex", "-1");

    const title = document.createElement("h3");
    title.className = "quick-modal-title";
    title.textContent =
        mode === "close" ? "Закрытие заявки" : "Комментарий к заявке";
    box.appendChild(title);

    const head = document.createElement("div");
    head.className = "quick-modal-head";
    const num = document.createElement("div");
    num.className = "quick-modal-num";
    num.textContent = snapshot.title;
    const addr = document.createElement("div");
    addr.className = "quick-modal-addr";
    addr.textContent = snapshot.subtitle || "";
    addr.title = snapshot.subtitle || "";
    head.appendChild(num);
    head.appendChild(addr);
    box.appendChild(head);

    if (mode === "close") {
        const templates = BUSINESS.QUICK_CLOSE_TEMPLATES || [];
        if (templates.length > 0) {
            const chips = document.createElement("div");
            chips.className = "quick-modal-chips";
            for (const label of templates) {
                const chip = document.createElement("button");
                chip.type = "button";
                chip.className = "quick-chip";
                chip.textContent = label;
                chip.addEventListener("click", () => {
                    if (busy || !textarea) return;
                    // Чипс задаёт текст целиком: шаблоны короче MIN_LEN
                    // дополняются пробелом нельзя — пользователь дописывает.
                    textarea.value = label;
                    textarea.focus();
                    refreshState();
                });
                chips.appendChild(chip);
            }
            box.appendChild(chips);
            chipsWrap = chips;
        }
    }

    const area = document.createElement("textarea");
    area.className = "quick-modal-textarea";
    area.rows = 4;
    area.placeholder =
        mode === "close"
            ? `Опишите, что было сделано (минимум ${MIN_LEN} символов)...`
            : `Текст комментария (минимум ${MIN_LEN} символов)...`;
    area.addEventListener("input", refreshState);
    box.appendChild(area);
    textarea = area;

    const warn = document.createElement("div");
    warn.className = "quick-modal-warn";
    warn.style.display = "none";
    box.appendChild(warn);
    warnEl = warn;

    const footer = document.createElement("div");
    footer.className = "quick-modal-footer";

    const counter = document.createElement("span");
    counter.className = "quick-modal-counter";
    footer.appendChild(counter);
    counterEl = counter;

    const actions = document.createElement("div");
    actions.className = "quick-modal-actions";

    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "quick-btn quick-btn-cancel";
    cancel.dataset.role = "cancel";
    cancel.textContent = "Отмена";
    cancel.addEventListener("click", () => close());

    const submit = document.createElement("button");
    submit.type = "button";
    submit.className = "quick-btn quick-btn-submit";
    submit.textContent = "Сохранить";
    submit.disabled = true;
    submit.addEventListener("click", () => submitForm());

    actions.appendChild(cancel);
    actions.appendChild(submit);
    footer.appendChild(actions);
    box.appendChild(footer);
    submitBtn = submit;

    bd.appendChild(box);
    bd.addEventListener("pointerdown", (e) => {
        if (e.target !== bd) return;
        // Защита от случайного закрытия: набранный текст не теряем.
        if ((textarea?.value || "").trim().length >= BACKDROP_GUARD_LEN) return;
        close();
    });

    return { bd, box };
}

function bindKeys() {
    if (keyAbort) keyAbort.abort();
    keyAbort = new AbortController();
    document.addEventListener(
        "keydown",
        (e) => {
            if (!root) return;
            if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                if (!busy) close();
                return;
            }
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                submitForm();
                return;
            }
            if (e.key === "Tab") {
                // Фокус-трап внутри модалки.
                const focusables = root.querySelectorAll(
                    "button:not([disabled]), textarea:not([disabled])",
                );
                if (focusables.length === 0) return;
                const first = focusables[0];
                const last = focusables[focusables.length - 1];
                if (e.shiftKey && document.activeElement === first) {
                    e.preventDefault();
                    last.focus();
                } else if (!e.shiftKey && document.activeElement === last) {
                    e.preventDefault();
                    first.focus();
                }
            }
        },
        { capture: true, signal: keyAbort.signal },
    );
}

/** Офлайн-ветка: запись выполняется даже если модалку уже закрыли. */
async function saveOffline(mode, ticketId, value, myMountId) {
    try {
        if (mode === "close") {
            await outboxQueue.enqueueClose(ticketId, value);
        } else {
            await outboxQueue.enqueueComment(ticketId, value);
        }
    } catch (e) {
        console.error("[QuickModal] Offline enqueue failed:", e);
        notify.error(
            mode === "close"
                ? "Не удалось закрыть заявку локально."
                : "Не удалось сохранить комментарий локально.",
        );
        if (mountId === myMountId && root) setBusy(false);
        return false;
    }

    logHistoryAction(
        mode === "close"
            ? `Заявка №${ticketId} закрыта локально.`
            : `Комментарий к заявке №${ticketId} сохранён локально.`,
    );
    notify.offline(
        mode === "close"
            ? "Заявка закрыта. Будет синхронизирована при восстановлении сети."
            : "Комментарий сохранён. Будет синхронизирован при восстановлении сети.",
    );

    const done = ctx?.onDone;
    if (mountId === myMountId) close();
    // Колбэк обновления журнала вызываем всегда: данные изменились,
    // даже если пользователь уже ушёл с экрана.
    try {
        await done?.({ mode, offline: true, ticketId });
    } catch (e) {
        console.warn("[QuickModal] onDone failed:", e);
    }
    return true;
}

async function submitForm() {
    if (busy || !ctx || !textarea) return;
    const result = validate(textarea.value);
    if (!result.ok) {
        refreshState();
        notify.info(
            result.reason === "caps"
                ? "Напишите обычным текстом, без длинных последовательностей заглавных."
                : `Минимум ${MIN_LEN} символов.`,
        );
        return;
    }

    const { mode, ticketId } = ctx;
    const value = result.value;
    const myMountId = mountId;
    const isStale = () => mountId !== myMountId || !root;

    setBusy(true);

    if (!navigator.onLine) {
        await saveOffline(mode, ticketId, value, myMountId);
        return;
    }

    let response = null;
    try {
        if (mode === "close") {
            const userId = userStore.userId || authStore.getUser()?.id || 0;
            response = await ticketRepository.saveClose(
                api,
                ticketId,
                value,
                userId,
            );
        } else {
            response = await ticketRepository.addNote(api, ticketId, value);
        }
    } catch (e) {
        console.error("[QuickModal] Request failed:", e);
        await saveOffline(mode, ticketId, value, myMountId);
        return;
    }

    // Отказ канала: три кода (network_error, aborted/timeout,
    // invalid_response) — все помечены api-service как offline: true.
    if (response && response.offline === true) {
        const uncertain = response.code !== "network_error";
        if (uncertain) {
            notify.offline(
                "Сервер не подтвердил сохранение. Данные уйдут в очередь; при синхронизации возможен повтор.",
                { timeout: 0, persistent: true },
            );
        }
        await saveOffline(mode, ticketId, value, myMountId);
        return;
    }

    if (response && response._authLost) {
        if (!isStale()) setBusy(false);
        return;
    }

    if (response && response.status === "ok") {
        const msg =
            response.message ||
            (mode === "close" ? "Заявка закрыта." : "Комментарий добавлен.");
        logHistoryAction(`№${ticketId}: ${msg}`);
        notify.success(msg);
        const done = ctx?.onDone;
        if (!isStale()) close();
        try {
            await done?.({ mode, offline: false, ticketId });
        } catch (e) {
            console.warn("[QuickModal] onDone failed:", e);
        }
        return;
    }

    // Сервер отказал: closed / forbidden / ticket_already_closed.
    const msg =
        (response && response.message) ||
        (mode === "close"
            ? "Не удалось закрыть заявку."
            : "Не удалось добавить комментарий.");
    logHistoryAction(`№${ticketId}: ${msg}`);
    notify.error(msg);
    if (!isStale()) setBusy(false);
    // Статус мог измениться пока модалка была открыта — обновляем журнал.
    try {
        await ctx?.onDone?.({ mode, offline: false, ticketId, failed: true });
    } catch (e) {
        /* игнорируем */
    }
}

/**
 * @param {Object} options
 * @param {"comment"|"close"} options.mode
 * @param {Object} options.ticket — объект заявки (для id)
 * @param {{title:string, subtitle:string}} options.snapshot
 * @param {Function} [options.onDone] — ({mode, offline, ticketId, failed}) => void
 * @param {HTMLElement} [options.returnFocus]
 */
export function show({ mode, ticket, snapshot, onDone, returnFocus }) {
    close();
    if (!api) {
        console.error("[QuickModal] init(api) не вызван");
        return;
    }
    const ticketId = ticket?.id ?? ticket?.call_number ?? null;
    if (ticketId == null) return;

    mountId++;
    ctx = { mode, ticketId, onDone };
    returnFocusTo = returnFocus || null;

    const built = buildDom(mode, snapshot || { title: `№${ticketId}`, subtitle: "" });
    backdrop = built.bd;
    root = built.box;
    document.body.appendChild(backdrop);
    bindKeys();
    refreshState();
    setTimeout(() => textarea?.focus(), 30);
}

/** Закрытие не отменяет начатое сохранение — только убирает DOM. */
export function close() {
    mountId++;
    if (keyAbort) {
        keyAbort.abort();
        keyAbort = null;
    }
    if (backdrop) {
        backdrop.remove();
        backdrop = null;
    }
    root = null;
    textarea = null;
    submitBtn = null;
    counterEl = null;
    warnEl = null;
    chipsWrap = null;
    busy = false;
    ctx = null;
    if (returnFocusTo && returnFocusTo.isConnected) {
        try {
            returnFocusTo.focus({ preventScroll: true });
        } catch (e) {
            /* строка могла быть пересоздана */
        }
    }
    returnFocusTo = null;
}

export function destroy() {
    close();
    api = null;
}

export const quickActionModal = { init, show, close, destroy };