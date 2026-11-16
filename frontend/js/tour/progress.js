import { SCENARIO_ORDER } from "./state.js";
import { stepsFor } from "./scenarios/index.js";

/**
 * Общий счётчик шагов сквозь все сценарии: «12 из 38».
 * driver.js показывает свой «N of M» в пределах одного инстанса —
 * подменяем текст после его рендера (он рисует поповер позже хука).
 */
let totalCache = null;

export function totalSteps() {
    if (totalCache == null) {
        totalCache = SCENARIO_ORDER.reduce(
            (n, key) => n + stepsFor(key).length,
            0,
        );
    }
    return totalCache;
}

function scenarioBase(scenario) {
    const idx = SCENARIO_ORDER.indexOf(scenario);
    if (idx <= 0) return 0;
    return SCENARIO_ORDER.slice(0, idx).reduce(
        (n, key) => n + stepsFor(key).length,
        0,
    );
}

export function updateGlobalProgress(step) {
    if (!step || step.origIndex == null) return;
    const text = `${scenarioBase(step.scenario) + step.origIndex + 1} из ${totalSteps()}`;
    requestAnimationFrame(() => {
        const el =
            document.querySelector(".driver-popover-progress-text") ||
            document.querySelector(".driver-popover-progress-txt");
        if (el) el.textContent = text;
    });
}