/* Редактирование организации: живой diff, дельта уровня, подтверждения, guard. */
(function (window, document) {
  "use strict";
  var L = window.LIFT;

  L.ready(function () {
    var $ = L.$,
      $$ = L.$$;

    var form = $("#editForm");
    if (!form) return;

    var original = L.json("editOriginal", {});
    var MATRIX = L.json("levelMatrix", {});
    var META = L.json("levelMeta", {
      levels: [],
      features: [],
      groups: [],
      scopes: {},
    });

    var TIER = { light: "#22d3ee", standard: "#3b82f6", extended: "#ec4899" };
    function tierColor(l) {
      return TIER[l] || "#61758c";
    }
    function lvlLabel(l) {
      return (MATRIX[l] && MATRIX[l].label) || l;
    }

    var LABELS = {
      subdomain: "Поддомен",
      org_name: "Название",
      db_host: "Хост БД",
      db_port: "Порт БД",
      db_name: "Имя БД",
      db_user: "Логин БД",
      db_password: "Пароль БД",
      legacy_compat: "Legacy режим",
      reports_level: "Уровень отчётов",
    };
    var FIELDS = [
      "subdomain",
      "org_name",
      "db_host",
      "db_port",
      "db_name",
      "db_user",
    ];

    var approved = false;

    function el(name) {
      return form.querySelector('[name="' + name + '"]');
    }
    function val(name) {
      var e = el(name);
      return e ? String(e.value).trim() : "";
    }
    function level() {
      var r = form.querySelector('[name="reports_level"]:checked');
      return r ? r.value : original.level;
    }
    function legacy() {
      var e = el("legacy_compat");
      return e && e.checked ? 1 : 0;
    }
    function password() {
      var e = el("db_password");
      return e ? e.value : "";
    }

    /* ---------------- diff ---------------- */
    function changes() {
      var out = [];
      FIELDS.forEach(function (f) {
        var now = val(f),
          was = String(original[f] == null ? "" : original[f]);
        if (now !== was)
          out.push({
            key: f,
            label: LABELS[f],
            from: was || "—",
            to: now || "—",
          });
      });
      if (password() !== "") {
        out.push({
          key: "db_password",
          label: LABELS.db_password,
          from: "без изменений",
          to: "новый пароль",
        });
      }
      if (legacy() !== Number(original.legacy)) {
        out.push({
          key: "legacy_compat",
          label: LABELS.legacy_compat,
          from: original.legacy ? "включён" : "выключен",
          to: legacy() ? "включён" : "выключен",
        });
      }
      if (level() !== original.level) {
        out.push({
          key: "reports_level",
          label: LABELS.reports_level,
          from: lvlLabel(original.level),
          to: lvlLabel(level()),
        });
      }
      return out;
    }

    function renderDiff() {
      var list = changes();
      var box = $("#diffList"),
        n = $("#diffN");
      if (n) n.textContent = list.length;

      if (box) {
        if (!list.length) {
          box.innerHTML =
            '<div class="diff-empty">' +
            L.svg('<path d="M20 6L9 17l-5-5"/>', 1.8) +
            "Значения совпадают с сохранёнными.<br>Измените любое поле — оно появится здесь.</div>";
        } else {
          box.innerHTML = list
            .map(function (c) {
              return (
                '<div class="diff-row"><div class="diff-k">' +
                L.esc(c.label) +
                "</div>" +
                '<div class="diff-v"><span class="from">' +
                L.esc(c.from) +
                "</span>" +
                L.svg('<path d="M5 12h14M13 6l6 6-6 6"/>', 2.2) +
                '<span class="to">' +
                L.esc(c.to) +
                "</span></div></div>"
              );
            })
            .join("");
        }
      }

      FIELDS.forEach(function (f) {
        var e = el(f);
        if (!e) return;
        e.classList.toggle(
          "dirty",
          val(f) !== String(original[f] == null ? "" : original[f]),
        );
      });
      var pw = el("db_password");
      if (pw) pw.classList.toggle("dirty", pw.value !== "");

      var st = $("#footState"),
        cnt = $("#footCount"),
        save = $("#saveBtn");
      if (st) st.classList.toggle("dirty", list.length > 0);
      if (cnt) cnt.textContent = list.length;
      if (save) save.disabled = list.length === 0;

      var lf = $("#legacyFlag");
      if (lf) {
        lf.classList.toggle("on", legacy() === 1);
        lf.textContent = legacy() ? "включён" : "выключен";
      }
      var pf = $("#passFlag");
      if (pf) {
        pf.classList.toggle("on", password() !== "");
        pf.textContent = password() !== "" ? "будет заменён" : "без изменений";
      }
      var sf = $("#subFlag");
      if (sf) {
        var changed = val("subdomain") !== String(original.subdomain || "");
        sf.classList.toggle("on", changed);
        sf.textContent = changed ? "переименование" : "идентификатор";
      }
      var subWarn = $("#subWarn");
      if (subWarn)
        subWarn.hidden = val("subdomain") === String(original.subdomain || "");
    }

    /* ---------------- превью поддомена ---------------- */
    var sub = el("subdomain"),
      prev = $("#hostPreview");
    function syncHost() {
      if (!prev) return;
      prev.textContent = (val("subdomain") || "…") + ".liftcs.ru";
    }

    /* ---------------- пароль ---------------- */
    var pwToggle = $("#pwToggle"),
      pw = el("db_password");
    if (pwToggle && pw)
      pwToggle.addEventListener("click", function () {
        var show = pw.type === "password";
        pw.type = show ? "text" : "password";
        pwToggle.classList.toggle("on", show);
        pwToggle.setAttribute(
          "aria-label",
          show ? "Скрыть пароль" : "Показать пароль",
        );
        pwToggle.innerHTML = show
          ? L.svg(
              '<path d="M17.9 17.9A10.4 10.4 0 0112 19c-7 0-10-7-10-7a18 18 0 015.1-5.9M9.9 4.2A10.6 10.6 0 0112 4c7 0 10 7 10 7a18 18 0 01-2.2 3.2M1 1l22 22M9.9 9.9a3 3 0 004.2 4.2"/>',
              2,
            )
          : L.svg(
              '<path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/>',
              2,
            );
      });

    /* ---------------- тарифные карты ---------------- */
    function syncTiers() {
      var cur = level();
      $$(".tier").forEach(function (t) {
        t.classList.toggle("on", t.dataset.tier === cur);
      });
      var head = $("#recHead");
      if (head) head.style.setProperty("--hc", tierColor(cur));
      renderDelta();
    }

    function renderDelta() {
      var box = $("#levelDelta");
      if (!box) return;
      var from = original.level,
        to = level();
      var A = MATRIX[from],
        B = MATRIX[to];
      if (!A || !B) {
        box.hidden = true;
        return;
      }
      box.hidden = false;

      var same = from === to;
      var up = B.rank > A.rank;

      $("#deltaFrom").textContent = lvlLabel(from);
      $("#deltaFrom").className = "lvl-pill lv-" + from;
      $("#deltaTo").textContent = lvlLabel(to);
      $("#deltaTo").className = "lvl-pill lv-" + to;
      $("#deltaTone").textContent = same
        ? "без изменений"
        : up
          ? "повышение"
          : "понижение";
      $("#deltaTone").className =
        "badge " + (same ? "b-modern" : up ? "b-on" : "b-off");

      function diffKeys(a, b) {
        return b.filter(function (k) {
          return a.indexOf(k) === -1;
        });
      }
      function labelOf(key, arr) {
        var hit = arr.filter(function (x) {
          return x.key === key;
        })[0];
        return hit ? hit.label : key;
      }

      var fGain = diffKeys(A.features, B.features);
      var fLoss = diffKeys(B.features, A.features);
      var gGain = diffKeys(A.limits.filter_groups, B.limits.filter_groups);
      var gLoss = diffKeys(B.limits.filter_groups, A.limits.filter_groups);

      function fill(sel, keys, arr, sign, empty) {
        var node = $(sel);
        if (!node) return;
        node.innerHTML = keys.length
          ? keys
              .map(function (k) {
                return (
                  '<div class="delta-item"><span class="s">' +
                  sign +
                  "</span><span>" +
                  L.esc(labelOf(k, arr)) +
                  "</span></div>"
                );
              })
              .join("")
          : '<div class="delta-none">' + empty + "</div>";
      }
      fill(
        "#gainList",
        fGain.concat(gGain),
        (META.features || []).concat(META.groups || []),
        "+",
        "Ничего не добавится",
      );
      fill(
        "#lossList",
        fLoss.concat(gLoss),
        (META.features || []).concat(META.groups || []),
        "−",
        "Ничего не пропадёт",
      );

      var lims = [
        {
          k: "Период",
          a: A.limits.max_period_days,
          b: B.limits.max_period_days,
          u: "дн.",
        },
        {
          k: "Экспорт",
          a: A.limits.max_rows,
          b: B.limits.max_rows,
          u: "строк",
        },
        {
          k: "Список",
          a: A.list_cap == null ? "∞" : A.list_cap,
          b: B.list_cap == null ? "∞" : B.list_cap,
          u: "",
        },
      ];
      $("#deltaLims").innerHTML =
        lims
          .map(function (x) {
            var an = x.a === "∞" ? Infinity : Number(x.a);
            var bn = x.b === "∞" ? Infinity : Number(x.b);
            var cls = bn > an ? "up" : bn < an ? "down" : "";
            return (
              '<span class="dlim ' +
              cls +
              '">' +
              L.esc(x.k) +
              ' <span class="ar">' +
              L.esc(x.a) +
              " →</span> <b>" +
              L.esc(x.b) +
              "</b>" +
              (x.u ? " " + L.esc(x.u) : "") +
              "</span>"
            );
          })
          .join("") +
        '<span class="dlim">Адреса <b>' +
        L.esc(
          (META.scopes && META.scopes[B.limits.address_scope]) ||
            B.limits.address_scope,
        ) +
        "</b></span>" +
        '<span class="dlim">rev <span class="ar">' +
        L.esc(original.rev) +
        " →</span> <b>" +
        (same ? L.esc(original.rev) : Number(original.rev) + 1) +
        "</b></span>";
    }

    $$('[name="reports_level"]').forEach(function (r) {
      r.addEventListener("change", function () {
        syncTiers();
        renderDiff();
      });
    });

    /* ---------------- реакция на ввод ---------------- */
    FIELDS.forEach(function (f) {
      var e = el(f);
      if (!e) return;
      e.addEventListener("input", function () {
        if (f === "subdomain") syncHost();
        renderDiff();
      });
      e.addEventListener("change", renderDiff);
    });
    if (pw) pw.addEventListener("input", renderDiff);
    var lg = el("legacy_compat");
    if (lg) lg.addEventListener("change", renderDiff);

    /* ---------------- сброс ---------------- */
    var resetBtn = $("#resetBtn");
    if (resetBtn)
      resetBtn.addEventListener("click", function () {
        if (!changes().length) {
          L.toast(
            "info",
            "Нечего сбрасывать",
            "Все значения уже совпадают с сохранёнными.",
          );
          return;
        }
        L.confirm({
          head: "Вернуть сохранённые значения?",
          html: "Все несохранённые правки в форме будут отменены. В базе ничего не изменится.",
          label: "Сбросить",
          cls: "btn-warn",
          onYes: function () {
            FIELDS.forEach(function (f) {
              var e = el(f);
              if (e) e.value = original[f] == null ? "" : original[f];
            });
            if (pw) {
              pw.value = "";
              pw.type = "password";
            }
            if (pwToggle) {
              pwToggle.classList.remove("on");
              pwToggle.innerHTML = L.svg(
                '<path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/>',
                2,
              );
            }
            if (lg) lg.checked = !!Number(original.legacy);
            var r = form.querySelector(
              '[name="reports_level"][value="' + original.level + '"]',
            );
            if (r) r.checked = true;
            syncHost();
            syncTiers();
            renderDiff();
            L.toast("ok", "Форма сброшена", "Показаны значения из базы.");
          },
        });
      });

    /* ---------------- отправка ---------------- */
    form.addEventListener("submit", function (e) {
      if (approved) return;
      e.preventDefault();

      if (!form.checkValidity()) {
        form.reportValidity();
        return;
      }
      if (!changes().length) {
        L.toast("info", "Нет изменений", "Сохранять нечего.");
        return;
      }

      var checks = [];
      var newSub = val("subdomain");

      if (newSub !== String(original.subdomain || "")) {
        checks.push({
          head: "Переименовать поддомен?",
          html:
            "Адрес <b>" +
            L.esc(original.subdomain) +
            ".liftcs.ru</b> перестанет обслуживаться. " +
            "Новый — <b>" +
            L.esc(newSub) +
            ".liftcs.ru</b> — должен уже обслуживаться веб-сервером и DNS. " +
            "Пользователям потребуется войти заново.",
          label: "Переименовать",
          cls: "btn-danger",
          tone: "danger",
        });
      }

      var A = MATRIX[original.level],
        B = MATRIX[level()];
      if (A && B && B.rank < A.rank) {
        checks.push({
          head: "Понизить уровень отчётов?",
          html:
            "Уровень <b>" +
            L.esc(lvlLabel(original.level)) +
            "</b> → <b>" +
            L.esc(lvlLabel(level())) +
            "</b>. Часть отчётов и выгрузок станет недоступна всем пользователям организации. Данные не удаляются.",
          label: "Понизить",
          cls: "btn-danger",
          tone: "danger",
        });
      }

      if (legacy() !== Number(original.legacy)) {
        checks.push({
          head: "Изменить режим совместимости?",
          html:
            "Legacy-режим влияет на работу уведомлений и прокси. Организация <b>" +
            L.esc(original.org_name) +
            "</b> будет переведена в режим <b>" +
            (legacy() ? "legacy" : "современный") +
            "</b>.",
          label: "Изменить",
          cls: "btn-warn",
        });
      }

      if (password() !== "") {
        checks.push({
          head: "Заменить пароль БД?",
          html: "Текущий пароль будет перезаписан новым. Если он не совпадёт с паролем пользователя MariaDB, тенант потеряет подключение к базе.",
          label: "Заменить",
          cls: "btn-warn",
        });
      }

      L.chain(checks, function () {
        approved = true;
        var btn = $("#saveBtn");
        if (btn) {
          btn.disabled = true;
          btn.innerHTML =
            L.svg(
              '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
              2.4,
            ) + "Сохранение…";
        }
        form.submit();
      });
    });

    /* ---------------- guard несохранённых правок ---------------- */
    window.addEventListener("beforeunload", function (e) {
      if (approved || !changes().length) return;
      e.preventDefault();
      e.returnValue = "";
      return "";
    });

    $$("[data-guard]").forEach(function (a) {
      a.addEventListener("click", function (e) {
        if (approved || !changes().length) return;
        e.preventDefault();
        var href = a.getAttribute("href");
        L.confirm({
          head: "Уйти без сохранения?",
          html:
            "В форме <b>" +
            changes().length +
            "</b> несохранённых изменений. При переходе они будут потеряны.",
          label: "Уйти",
          cls: "btn-danger",
          tone: "danger",
          cancel: "Остаться",
          onYes: function () {
            approved = true;
            window.location.href = href;
          },
        });
      });
    });

    /* ---------------- горячие клавиши ---------------- */
    document.addEventListener("keydown", function (e) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (changes().length)
          form.requestSubmit
            ? form.requestSubmit()
            : form.dispatchEvent(new Event("submit", { cancelable: true }));
        else L.toast("info", "Нет изменений", "Сохранять нечего.");
      }
    });

    /* ---------------- старт ---------------- */
    var head = $("#recHead");
    if (head) head.style.setProperty("--hc", tierColor(original.level));
    syncHost();
    syncTiers();
    renderDiff();
  });
})(window, document);
