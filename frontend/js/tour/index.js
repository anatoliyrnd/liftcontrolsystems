/**
 * Сквозной обучающий тур (driver.js 1.14).
 *
 * Вариант C: тур ничего не заполняет, не выбирает и не сохраняет.
 * Единственное программное действие — раскрытие <details> в профиле.
 * disableActiveInteraction: "clicks" блокирует клики по подсвеченному
 * элементу, оставляя скролл и выделение текста доступными.
 *
 * Курсор-призрак показывает, куда смотреть; реальных событий не шлёт.
 */
import "driver.js/dist/driver.css";

import { SEL } from "./selectors.js";
import { stepsFor } from "./scenarios/index.js";
import { updateGlobalProgress } from "./progress.js";
import {
    insertDemoRow,
    watchDemoRow,
    removeDemoRow,
} from "./scenarios/queue.js";
import { expandProfileBlock, collapseProfileBlock } from "./scenarios/profile.js";
import {
    SCENARIO_ORDER,
    loadState,
    saveState,
    clearState,
    scenarioHash,
    captureTicketId,
    waitForScenario,
} from "./state.js";
import { pointAt, hide as hideGhost, destroyGhost, resetGhost } from "./effects/ghost-cursor.js";
import {
    openEditMode,
    cancelEditMode,
    openCloseBlock,
} from "./scenarios/ticket.js";
let driverObj = null;
let driverLib = null;
let selfNav = false;
let advancing = false;
let hashListener = null;
let cancelWait = null;
let activeNotify = null;

async function loadDriver() {
    if (!driverLib) {
        const mod = await import("driver.js");
        driverLib = mod.driver;
    }
    return driverLib;
}

/**
 * Шаги с несуществующими элементами пропускаем. Исключения:
 * функции-резолверы и элементы блоков, которые тур откроет сам
 * (форма правки, блок решения) — на момент старта их нет в DOM
 * или они скрыты, но появятся к своему шагу.
 */
const DEFERRED = new Set([
    SEL.editDetails,
    SEL.editRepair,
    SEL.cardSaveBtn,
    SEL.cancelEditBtn,
    SEL.solutionInput,
    SEL.solutionMic,
    SEL.closeAndCreate,
]);

function filterAvailable(steps) {
    return steps
        .map((s, i) => ({ s, i }))
        .filter(({ s }) => {
            if (!s.element) return true;
            if (typeof s.element === "function") return true;
            if (DEFERRED.has(s.element)) return true;
            return document.querySelector(s.element) !== null;
        });
}

function destroyDriverInstance() {
    if (cancelWait) {
        cancelWait();
        cancelWait = null;
    }
    hideGhost();
    if (driverObj) {
        try {
            driverObj.destroy();
        } catch (e) {
            /* уже уничтожен */
        }
        driverObj = null;
    }
}

/** Из leaveAll(): гасит инстанс, состояние тура не трогает. */
export function stopTour() {
    destroyDriverInstance();
}

function dropHashListener() {
    if (hashListener) {
        window.removeEventListener("hashchange", hashListener);
        hashListener = null;
    }
}

function abortTour() {
    destroyDriverInstance();
    dropHashListener();
    removeDemoRow();
    destroyGhost();
    clearState();
    advancing = false;
    selfNav = false;
}

function finishTour() {
    destroyDriverInstance();
    dropHashListener();
    removeDemoRow();
    destroyGhost();
    clearState();
    advancing = false;
    selfNav = false;
    activeNotify?.success(
        "Обучение завершено. Запустить его снова можно из меню пользователя.",
    );
}

function goNextScenario(state) {
    const idx = SCENARIO_ORDER.indexOf(state.scenario);
    let next = SCENARIO_ORDER[idx + 1] || null;

    if (state.scenario === "journal") {
        state.ticketId = captureTicketId(SEL.table);
    }
    if (next === "ticket" && !state.ticketId) {
        next = SCENARIO_ORDER[idx + 2] || null;
    }
    if (state.scenario === "queue") removeDemoRow();

    if (!next) {
        finishTour();
        return;
    }

    state.scenario = next;
    saveState(state);
    selfNav = true;
    window.location.hash = scenarioHash(next, state).slice(1);
}

async function beginScenario(state) {
    const key = state.scenario;

    if (key === "queue") {
        insertDemoRow();
        watchDemoRow();
    }
    if (key === "profile") collapseProfileBlock();

    const all = stepsFor(key).map((s, i) => ({
        ...s,
        origIndex: i,
        scenario: key,
    }));
    const available = filterAvailable(all);

    if (available.length === 0) {
        goNextScenario(state);
        return;
    }

    const shownSteps = available.map(({ s }) => s);
    const lastShownStep = shownSteps[shownSteps.length - 1];
    const driverFn = await loadDriver();

    driverObj = driverFn({
        showProgress: true,
        allowClose: true,
        overlayOpacity: 0.6,
        stagePadding: 6,
        popoverClass: "driver-tour-popover",
        nextBtnText: "Далее →",
        prevBtnText: "← Назад",
        doneBtnText: "Завершить",
        // Клики по подсвеченному элементу запрещены: кнопка «Сохранить»
        // не должна создать заявку во время обучения.
        disableActiveInteraction: "clicks",
        overlayClickBehavior: "none",
        smoothScroll: true,
        steps: shownSteps,

        onHighlighted: (el, step) => {
            updateGlobalProgress(step);
            pointAt(el || step.element);
        },

        onDeselected: () => {
            hideGhost();
        },

       onHighlighted: (el, step) => {
            updateGlobalProgress(step);
            pointAt(el || step.element);
            // Блок мог раскрыться с анимацией — пересчитываем рамку
            // и позицию призрака после завершения раскладки.
            if (key === "ticket" && DEFERRED.has(step.element)) {
                setTimeout(() => {
                    if (!driverObj) return;
                    driverObj.refresh();
                    pointAt(step.element);
                }, 220);
            }
        },

               onNextClick: (_el, step) => {
            if (!driverObj) return;

            // Переключение UI-состояния выполняется ДО moveNext:
            // после перехода оверлей перестроится и клик уйдёт в пустоту.
            let delay = 0;

            if (key === "profile" && step.origIndex === 0) {
                expandProfileBlock();
                delay = 180;
            }
            if (key === "ticket") {
                if (step.origIndex === 1) { openEditMode(); delay = 260; }
                if (step.origIndex === 6) { cancelEditMode(); delay = 200; }
                if (step.origIndex === 8) { openCloseBlock(); delay = 260; }
            }

            const advance = () => {
                if (!driverObj) return;
                if (driverObj.isLastStep()) {
                    advancing = true;
                    driverObj.destroy();
                } else {
                    driverObj.moveNext();
                }
            };

            if (delay > 0) setTimeout(advance, delay);
            else advance();
        },
  onPrevClick: () => {
            driverObj?.movePrevious();
        },
        onDestroyed: () => {
            driverObj = null;
            hideGhost();
            const wasAdvancing = advancing;
            advancing = false;
            if (wasAdvancing) {
                goNextScenario(state);
            } else if (!selfNav) {
                abortTour();
            }
        },
    });

    driverObj.drive(0);
}

export async function startTour() {
    const { notify } = await import("../components/notify.js");
    activeNotify = notify;

    if (driverObj) return;

    resetGhost();

    let state = loadState();
    if (!state) {
        state = { scenario: "journal", ticketId: null };
        saveState(state);
    }

    if (!hashListener) {
        hashListener = () => {
            if (selfNav) {
                selfNav = false;
                if (cancelWait) cancelWait();
                cancelWait = waitForScenario(
                    state.scenario,
                    () => {
                        cancelWait = null;
                        beginScenario(state);
                    },
                    () => {
                        cancelWait = null;
                        abortTour();
                    },
                );
            } else if (loadState()) {
                abortTour();
            }
        };
        window.addEventListener("hashchange", hashListener);
    }

    try {
        await loadDriver();
    } catch (e) {
        console.error("[tour] Не удалось загрузить driver.js:", e);
        notify.error("Обучающий тур недоступен. Проверьте файлы приложения.");
        clearState();
        dropHashListener();
        return;
    }

    const target = scenarioHash(state.scenario, state);
    const current = window.location.hash || "#/";

    if (current !== target) {
        selfNav = true;
        window.location.hash = target.slice(1);
    } else {
        await beginScenario(state);
    }
}