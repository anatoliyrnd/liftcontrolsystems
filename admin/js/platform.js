/* LIFT·CS Platform Admin — общий рантайм: тосты, буфер, оверлеи, confirm, часы. */
(function (window, document) {
  "use strict";

  var ICON = {
    ok: '<path d="M20 6L9 17l-5-5"/>',
    err: '<path d="M18 6L6 18M6 6l12 12"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 16v-4M12 8h.01"/>',
    warn: '<path d="M10.3 3.9L1.8 18a2 2 0 001.7 3h17a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z"/><path d="M12 9v4M12 17h.01"/>',
  };

  function $(s, r) {
    return (r || document).querySelector(s);
  }
  function $$(s, r) {
    return Array.prototype.slice.call((r || document).querySelectorAll(s));
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return {
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      }[c];
    });
  }

  function svg(paths, w) {
    return (
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="' +
      (w || 2.4) +
      '" stroke-linecap="round" stroke-linejoin="round">' +
      paths +
      "</svg>"
    );
  }

  function json(id, fallback) {
    var el = document.getElementById(id);
    if (!el) return fallback;
    try {
      return JSON.parse(el.textContent) || fallback;
    } catch (e) {
      return fallback;
    }
  }

  /* ---------- инфраструктура оверлеев ---------- */
  var scrim,
    modal,
    toastBox,
    mounted = false;

  function mount() {
    if (mounted) return;
    mounted = true;

    scrim = $("#scrim");
    if (!scrim) {
      scrim = document.createElement("div");
      scrim.className = "scrim";
      scrim.id = "scrim";
      document.body.appendChild(scrim);
    }

    toastBox = $("#toasts");
    if (!toastBox) {
      toastBox = document.createElement("div");
      toastBox.className = "toasts";
      toastBox.id = "toasts";
      toastBox.setAttribute("aria-live", "polite");
      document.body.appendChild(toastBox);
    }

    modal = $("#confirm");
    if (!modal) {
      modal = document.createElement("div");
      modal.className = "modal";
      modal.id = "confirm";
      modal.setAttribute("role", "alertdialog");
      modal.setAttribute("aria-modal", "true");
      modal.setAttribute("aria-hidden", "true");
      modal.innerHTML =
        '<h3><span class="cf-ic">' +
        svg(ICON.warn, 2.2) +
        '</span><span id="cfHead">Подтверждение</span></h3>' +
        '<p id="cfText"></p>' +
        '<div class="row"><button type="button" class="btn btn-ghost" id="cfNo">Отмена</button>' +
        '<button type="button" class="btn btn-warn" id="cfYes">Продолжить</button></div>';
      document.body.appendChild(modal);
    }

    scrim.addEventListener("click", function () {
      closeConfirm();
      close();
    });
    $("#cfNo").addEventListener("click", closeConfirm);
    $("#cfYes").addEventListener("click", function () {
      var fn = cfCb;
      closeConfirm();
      if (fn) fn();
    });

    $$("[data-close]").forEach(function (b) {
      b.addEventListener("click", function () {
        close();
      });
    });

    document.addEventListener("keydown", function (e) {
      if (e.key !== "Escape") return;
      if (modal.classList.contains("on")) {
        closeConfirm();
        return;
      }
      if (opened) {
        close();
      }
    });
  }

  /* ---------- тосты ---------- */
  function toast(kind, title, msg, opts) {
    mount();
    opts = opts || {};
    var el = document.createElement("div");
    el.className = "toast " + kind;
    el.innerHTML =
      '<div class="ti">' +
      svg(ICON[kind] || ICON.info) +
      "</div>" +
      '<div class="tc"><div class="tt">' +
      esc(title) +
      "</div>" +
      (msg ? '<div class="tm">' + esc(msg) + "</div>" : "") +
      (opts.action
        ? '<div class="ta"><button type="button" class="btn btn-cyan btn-sm">' +
          esc(opts.action) +
          "</button></div>"
        : "") +
      "</div>" +
      '<button type="button" class="tx" aria-label="Закрыть">' +
      svg('<path d="M18 6L6 18M6 6l12 12"/>') +
      "</button>";
    toastBox.appendChild(el);

    var timer = null;
    function kill() {
      if (timer) clearTimeout(timer);
      if (!el.parentNode) return;
      el.classList.add("out");
      setTimeout(function () {
        if (el.parentNode) el.parentNode.removeChild(el);
      }, 260);
    }
    el.querySelector(".tx").addEventListener("click", kill);
    if (opts.action) {
      el.querySelector(".ta .btn").addEventListener("click", function () {
        kill();
        if (typeof opts.onAction === "function") opts.onAction();
      });
    }
    if (!opts.sticky) timer = setTimeout(kill, opts.ms || 4800);
    return { close: kill };
  }

  /* ---------- буфер обмена ---------- */
  function copy(text, label) {
    function done() {
      toast("ok", "Скопировано", label || text);
    }
    function fail() {
      toast("err", "Не удалось скопировать", "Скопируйте значение вручную.");
    }
    function legacy() {
      try {
        var ta = document.createElement("textarea");
        ta.value = text;
        ta.setAttribute("readonly", "");
        ta.style.cssText = "position:fixed;left:-9999px;top:0";
        document.body.appendChild(ta);
        ta.select();
        var ok = document.execCommand("copy");
        document.body.removeChild(ta);
        ok ? done() : fail();
      } catch (e) {
        fail();
      }
    }
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(done, legacy);
    } else {
      legacy();
    }
  }

  /* ---------- оверлеи ---------- */
  var opened = null,
    lastFocus = null;

  function open(el) {
    mount();
    if (!el) return;
    if (opened && opened !== el) close(true);
    lastFocus = document.activeElement;
    opened = el;
    el.classList.add("on");
    el.setAttribute("aria-hidden", "false");
    scrim.classList.add("on");
    document.body.classList.add("is-locked");
    var f = el.querySelector("input:not([type=hidden]), button, a[href]");
    if (f)
      setTimeout(function () {
        try {
          f.focus();
        } catch (e) {}
      }, 120);
  }

  function close(silent) {
    if (!opened) return;
    opened.classList.remove("on");
    opened.setAttribute("aria-hidden", "true");
    opened = null;
    if (!modal || !modal.classList.contains("on")) {
      scrim.classList.remove("on");
      document.body.classList.remove("is-locked");
    }
    if (!silent && lastFocus && lastFocus.focus) {
      try {
        lastFocus.focus();
      } catch (e) {}
    }
  }

  /* ---------- подтверждение ---------- */
  var cfCb = null;

  function confirm(opts) {
    mount();
    $("#cfHead").textContent = opts.head || "Подтверждение";
    $("#cfText").innerHTML = opts.html || "";
    var ic = modal.querySelector(".cf-ic");
    if (ic)
      ic.style.color =
        opts.tone === "danger" ? "var(--danger)" : "var(--amber)";
    var yes = $("#cfYes");
    yes.className = "btn " + (opts.cls || "btn-warn");
    yes.textContent = opts.label || "Продолжить";
    $("#cfNo").textContent = opts.cancel || "Отмена";
    cfCb = opts.onYes || null;
    modal.classList.add("on");
    modal.setAttribute("aria-hidden", "false");
    scrim.classList.add("on");
    document.body.classList.add("is-locked");
    setTimeout(function () {
      try {
        yes.focus();
      } catch (e) {}
    }, 100);
  }

  function closeConfirm() {
    if (!modal || !modal.classList.contains("on")) return;
    modal.classList.remove("on");
    modal.setAttribute("aria-hidden", "true");
    cfCb = null;
    if (!opened) {
      scrim.classList.remove("on");
      document.body.classList.remove("is-locked");
    }
  }

  /** Последовательная цепочка подтверждений; onDone — если все приняты. */
  function chain(list, onDone) {
    if (!list.length) {
      onDone();
      return;
    }
    var i = 0;
    (function next() {
      if (i >= list.length) {
        onDone();
        return;
      }
      var item = list[i++];
      item.onYes = next;
      confirm(item);
    })();
  }

  /* ---------- часы MSK ---------- */
  function clock(el) {
    if (!el) return;
    var b = el.querySelector("b") || el;
    function p(n) {
      return n < 10 ? "0" + n : "" + n;
    }
    function tick() {
      var d = new Date(
        Date.now() + new Date().getTimezoneOffset() * 60000 + 10800000,
      );
      b.textContent =
        p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
    }
    tick();
    setInterval(tick, 1000);
  }

  /* ---------- делегированное копирование ---------- */
  document.addEventListener("click", function (e) {
    var b = e.target.closest ? e.target.closest("[data-copy]") : null;
    if (!b) return;
    e.preventDefault();
    e.stopPropagation();
    copy(b.getAttribute("data-copy"));
  });

  function ready(fn) {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", function () {
        mount();
        fn();
      });
    } else {
      mount();
      fn();
    }
  }

  window.LIFT = {
    $: $,
    $$: $$,
    esc: esc,
    svg: svg,
    json: json,
    toast: toast,
    copy: copy,
    open: open,
    close: close,
    confirm: confirm,
    chain: chain,
    closeConfirm: closeConfirm,
    clock: clock,
    ready: ready,
    current: function () {
      return opened;
    },
  };
})(window, document);
