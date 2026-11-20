/**
 * Всплывающая подсказка для плиток сводки.
 *
 * Один общий узел на вьюху, а не по узлу на плитку: пять плиток × два
 * перерендера в минуту иначе плодили бы десятки detached-элементов.
 *
 * Гейт: (min-width) AND (hover: hover) AND (pointer: fine). На телефоне
 * тап открыл бы подсказку и не закрыл её — на тач-устройствах функции
 * нет вовсе, значок «i» скрыт через CSS.
 *
 * Удержание: mouseleave плитки не закрывает сразу, а ставит таймер.
 * Курсор успевает войти в подсказку и проскроллить список — иначе
 * длинный список застреваний нечитаем.
 *
 * DOM только createElement/textContent (правило 1): содержимое
 * собирает вызывающий, адрес приходит с сервера.
 */
export function createHoverTip(opts = {}) {
    const minWidth = Number(opts.minWidth) || 1024;
    const hideDelay = Number(opts.hideDelay) || 140;
    const TIP_ID = "repHoverTip";

    const tip = document.createElement("div");
    tip.className = "rep-tip";
    tip.id = TIP_ID;
    tip.setAttribute("role", "tooltip");
    tip.style.display = "none";
    document.body.appendChild(tip);

    // Два контроллера: собственный (слушатели подсказки живут всю вьюху)
    // и на привязки (пересоздаётся каждый render). Без разделения
    // слушатели на удалённых плитках копились бы до unmount.
    const ownAbort = new AbortController();
    let attachAbort = new AbortController();
    let hideTimer = null;
    let anchorEl = null;

    const mq = window.matchMedia(
        `(min-width: ${minWidth}px) and (hover: hover) and (pointer: fine)`,
    );
    const enabled = () => mq.matches;

    function clearTimer() {
        if (hideTimer) {
            clearTimeout(hideTimer);
            hideTimer = null;
        }
    }

    function hide() {
        clearTimer();
        tip.style.display = "none";
        if (anchorEl) {
            anchorEl.removeAttribute("aria-describedby");
            anchorEl = null;
        }
    }

    function scheduleHide() {
        clearTimer();
        hideTimer = setTimeout(hide, hideDelay);
    }

    function place(anchor) {
        const r = anchor.getBoundingClientRect();
        const pad = 12;
        // Сброс перед замером: прошлая позиция иначе влияет на offsetWidth
        // при max-width от viewport.
        tip.style.left = "0px";
        tip.style.top = "0px";
        const tw = tip.offsetWidth;
        const th = tip.offsetHeight;

        let left = r.left;
        if (left + tw + pad > window.innerWidth) left = window.innerWidth - tw - pad;
        if (left < pad) left = pad;

        let top = r.bottom + 8;
        if (top + th + pad > window.innerHeight) {
            const above = r.top - th - 8;
            top = above >= pad ? above : Math.max(pad, window.innerHeight - th - pad);
        }
        tip.style.left = `${Math.round(left)}px`;
        tip.style.top = `${Math.round(top)}px`;
    }

    function show(anchor, build) {
        if (!enabled()) return;
        clearTimer();
        if (anchorEl && anchorEl !== anchor) {
            anchorEl.removeAttribute("aria-describedby");
        }
        anchorEl = anchor;
        tip.innerHTML = "";
        const node = build();
        if (!node) return;
        tip.appendChild(node);
        tip.style.display = "block";
        place(anchor);
        anchor.setAttribute("aria-describedby", TIP_ID);
    }

    tip.addEventListener("mouseenter", clearTimer, { signal: ownAbort.signal });
    tip.addEventListener("mouseleave", scheduleHide, { signal: ownAbort.signal });

    document.addEventListener(
        "keydown",
        (e) => {
            if (e.key === "Escape") hide();
        },
        { signal: ownAbort.signal },
    );
    window.addEventListener("resize", hide, { signal: ownAbort.signal });
    // Скролл внутри самой подсказки не должен её закрывать — capture
    // ловит события от любого элемента, включая наш список.
    window.addEventListener(
        "scroll",
        (e) => {
            if (e.target instanceof Node && tip.contains(e.target)) return;
            hide();
        },
        { capture: true, signal: ownAbort.signal },
    );
    mq.addEventListener("change", hide, { signal: ownAbort.signal });

    return {
        /** build() возвращает готовый узел; вызывается на каждом показе. */
        attach(anchor, build) {
            if (!anchor || typeof build !== "function") return;
            const signal = attachAbort.signal;
            anchor.addEventListener("mouseenter", () => show(anchor, build), { signal });
            anchor.addEventListener("focus", () => show(anchor, build), { signal });
            anchor.addEventListener("mouseleave", scheduleHide, { signal });
            anchor.addEventListener("blur", hide, { signal });
        },
        /** Вызывать перед перерисовкой плиток: снимает слушатели старых узлов. */
        reset() {
            hide();
            attachAbort.abort();
            attachAbort = new AbortController();
        },
        hide,
        destroy() {
            hide();
            ownAbort.abort();
            attachAbort.abort();
            tip.remove();
        },
    };
}