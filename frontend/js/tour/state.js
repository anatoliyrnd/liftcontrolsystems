import { scenarioContainer } from "./selectors.js";

const STATE_KEY = "lift_tour_state";

/** Порядок экранов сквозного тура. */
export const SCENARIO_ORDER = [
    "journal",
    "create",
    "ticket",
    "closed",
    "queue",
    "profile",
];

export function loadState() {
    try {
        return JSON.parse(sessionStorage.getItem(STATE_KEY) || "null");
    } catch (e) {
        return null;
    }
}

export function saveState(state) {
    try {
        sessionStorage.setItem(STATE_KEY, JSON.stringify(state));
    } catch (e) {
        /* приватный режим — тур не переживёт переход */
    }
}

export function clearState() {
    try {
        sessionStorage.removeItem(STATE_KEY);
    } catch (e) {
        /* игнорируем */
    }
}

export function scenarioHash(key, state) {
    switch (key) {
        case "journal":
            return "#/";
        case "create":
            return "#/create";
        case "ticket":
            return "#/ticket/" + encodeURIComponent(state.ticketId);
        case "closed":
            return "#/closed";
        case "queue":
            return "#/queue";
        case "profile":
            return "#/profile";
        default:
            return "#/";
    }
}

/** Первый шаг карточки берём из журнала — иначе сценарий пропускается. */
export function captureTicketId(tableSelector) {
    const cell = document.querySelector(
        tableSelector + ' tbody tr td[data-col-id="id"]',
    );
    const id = cell ? cell.textContent.trim() : "";
    // offline_ строки в карточку не ведут корректно — берём серверную.
    if (!id || id.startsWith("offline_")) {
        const rows = document.querySelectorAll(
            tableSelector + ' tbody tr td[data-col-id="id"]',
        );
        for (const c of rows) {
            const v = c.textContent.trim();
            if (v && !v.startsWith("offline_")) return v;
        }
        return null;
    }
    return id;
}

/**
 * Ожидание отрисовки экрана после смены hash.
 * Контейнер появляется раньше данных — даём контроллеру дорисовать таблицу.
 */
export function waitForScenario(scenario, onReady, onTimeout, timeoutMs = 5000) {
    const selector = scenarioContainer(scenario);
    const deadline = Date.now() + timeoutMs;
    let cancelled = false;

    const tick = async () => {
        if (cancelled) return;
        if (document.querySelector(selector)) {
            await new Promise((r) => setTimeout(r, 400));
            if (!cancelled) onReady();
            return;
        }
        if (Date.now() < deadline) setTimeout(tick, 100);
        else if (!cancelled) onTimeout();
    };
    setTimeout(tick, 50);

    return () => {
        cancelled = true;
    };
}