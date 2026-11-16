/**
 * Курсор-«призрак»: визуальная имитация наведения и клика.
 *
 * Вариант C: НИ ОДНОГО реального click(), ни одного изменения .value.
 * Призрак — собственный div вне потока, pointer-events: none.
 * Единственное воздействие на страницу — класс подсветки на цели,
 * который снимается при уходе с шага.
 */

const GHOST_ID = "tourGhostCursor";
const HIGHLIGHT_CLASS = "tour-ghost-target";
const MOVE_MS = 420;
const PULSE_MS = 340;

let ghostEl = null;
let currentTarget = null;
let pulseTimer = null;
let moveTimer = null;
let repositionHandler = null;
let destroyed = false;

function ensureGhost() {
    if (ghostEl && document.body.contains(ghostEl)) return ghostEl;
    ghostEl = document.createElement("div");
    ghostEl.id = GHOST_ID;
    ghostEl.className = "tour-ghost";
    ghostEl.setAttribute("aria-hidden", "true");

    const arrow = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    arrow.setAttribute("viewBox", "0 0 24 24");
    arrow.setAttribute("width", "26");
    arrow.setAttribute("height", "26");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute(
        "d",
        "M5 2l14 11-6.2 1.1L16 21l-3.2 1.3-3.2-6.8L5 19z",
    );
    path.setAttribute("fill", "#ffffff");
    path.setAttribute("stroke", "#1f2937");
    path.setAttribute("stroke-width", "1.4");
    path.setAttribute("stroke-linejoin", "round");
    arrow.appendChild(path);
    ghostEl.appendChild(arrow);

    const ripple = document.createElement("span");
    ripple.className = "tour-ghost-ripple";
    ghostEl.appendChild(ripple);

    document.body.appendChild(ghostEl);
    return ghostEl;
}

/** Точка «остриё курсора» внутри цели: левый верх + смещение. */
function targetPoint(el) {
    const r = el.getBoundingClientRect();
    const x = Math.min(r.left + Math.max(18, r.width * 0.25), r.right - 8);
    const y = Math.min(r.top + Math.max(14, r.height * 0.4), r.bottom - 8);
    return {
        x: Math.max(8, Math.min(x, window.innerWidth - 30)),
        y: Math.max(8, Math.min(y, window.innerHeight - 30)),
    };
}

function placeAt(x, y, animate) {
    const el = ensureGhost();
    el.style.transition = animate
        ? `transform ${MOVE_MS}ms cubic-bezier(.22,.61,.36,1)`
        : "none";
    el.style.transform = `translate(${x}px, ${y}px)`;
}

function clearPulse() {
    if (pulseTimer) {
        clearTimeout(pulseTimer);
        pulseTimer = null;
    }
    if (ghostEl) ghostEl.classList.remove("is-clicking");
}

function clearHighlight() {
    if (currentTarget) {
        currentTarget.classList.remove(HIGHLIGHT_CLASS);
        currentTarget = null;
    }
}

function bindReposition() {
    if (repositionHandler) return;
    repositionHandler = () => {
        if (destroyed || !currentTarget || !currentTarget.isConnected) return;
        const p = targetPoint(currentTarget);
        placeAt(p.x, p.y, false);
    };
    window.addEventListener("scroll", repositionHandler, true);
    window.addEventListener("resize", repositionHandler);
}

function unbindReposition() {
    if (!repositionHandler) return;
    window.removeEventListener("scroll", repositionHandler, true);
    window.removeEventListener("resize", repositionHandler);
    repositionHandler = null;
}

/**
 * Навести призрак на элемент и «кликнуть» визуально.
 * @param {Element|string|null} target
 */
export function pointAt(target) {
    if (destroyed) return;
    const el =
        typeof target === "string" ? document.querySelector(target) : target;

    clearPulse();
    clearHighlight();

    if (!el || !el.isConnected) {
        hide();
        return;
    }

    ensureGhost();
    ghostEl.classList.add("is-visible");
    currentTarget = el;
    bindReposition();

    const firstRun = !ghostEl.dataset.placed;
    const p = targetPoint(el);

    if (firstRun) {
        // Первый шаг: появляемся сразу у цели, без перелёта из угла.
        placeAt(p.x, p.y, false);
        ghostEl.dataset.placed = "1";
    } else {
        placeAt(p.x, p.y, true);
    }

    if (moveTimer) clearTimeout(moveTimer);
    moveTimer = setTimeout(
        () => {
            if (destroyed || !currentTarget || !currentTarget.isConnected) return;
            currentTarget.classList.add(HIGHLIGHT_CLASS);
            ghostEl.classList.add("is-clicking");
            pulseTimer = setTimeout(() => {
                if (ghostEl) ghostEl.classList.remove("is-clicking");
                pulseTimer = null;
            }, PULSE_MS);
        },
        firstRun ? 60 : MOVE_MS,
    );
}

/** Убрать призрак с экрана, сохранив инстанс для следующего шага. */
export function hide() {
    clearPulse();
    clearHighlight();
    if (moveTimer) {
        clearTimeout(moveTimer);
        moveTimer = null;
    }
    if (ghostEl) ghostEl.classList.remove("is-visible");
}

/** Полная очистка: вызывается при abort / finish / stopTour. */
export function destroyGhost() {
    destroyed = true;
    hide();
    unbindReposition();
    if (ghostEl) {
        ghostEl.remove();
        ghostEl = null;
    }
}

/** Сброс флага уничтожения при новом запуске тура. */
export function resetGhost() {
    destroyed = false;
}