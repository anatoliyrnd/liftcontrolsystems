/* Реестр организаций: поиск, фильтры, сортировка, виды, выбор, CSV, карточка. */
(function (window, document) {
  "use strict";
  var L = window.LIFT;

  L.ready(function () {
    var $ = L.$,
      $$ = L.$$;

    var MATRIX = L.json("levelMatrix", {});
    var META = L.json("levelMeta", {
      levels: [],
      features: [],
      groups: [],
      scopes: {},
    });

    var TIER = {
      light: { c: "#22d3ee", cls: "lv-light" },
      standard: { c: "#3b82f6", cls: "lv-standard" },
      extended: { c: "#ec4899", cls: "lv-extended" },
    };
    function tier(l) {
      return TIER[l] || { c: "#61758c", cls: "lv-unknown" };
    }
    function lvlLabel(l) {
      return (MATRIX[l] && MATRIX[l].label) || l;
    }

    L.clock($("#clock"));

    /* ---------------- состояние ---------------- */
    var tbody = $("#tbody");
    var rows = tbody ? $$("#tbody > tr") : [];
    var state = { q: "", f: "all", lv: "", sort: "id-desc" };

    function apply() {
      var q = state.q.trim().toLowerCase(),
        shown = 0;
      rows.forEach(function (tr) {
        var ok = true;
        if (q && tr.dataset.search.indexOf(q) === -1) ok = false;
        if (ok && state.f === "active" && tr.dataset.active !== "1") ok = false;
        if (ok && state.f === "inactive" && tr.dataset.active === "1")
          ok = false;
        if (ok && state.f === "legacy" && tr.dataset.legacy !== "1") ok = false;
        if (ok && state.lv && tr.dataset.level !== state.lv) ok = false;
        tr.classList.toggle("gone", !ok);
        if (ok) shown++;
        else {
          var cb = tr.querySelector(".row-check");
          if (cb && cb.checked) {
            cb.checked = false;
            tr.classList.remove("sel");
          }
        }
      });

      var key = state.sort.split("-"),
        field = key[0],
        dir = key[1] === "asc" ? 1 : -1;
      var vis = rows.filter(function (t) {
        return !t.classList.contains("gone");
      });
      vis.sort(function (a, b) {
        var r;
        if (field === "id") r = +a.dataset.id - +b.dataset.id;
        else if (field === "rev") r = +a.dataset.rev - +b.dataset.rev;
        else if (field === "level")
          r =
            +a.dataset.rank - +b.dataset.rank || +a.dataset.id - +b.dataset.id;
        else
          r = String(a.dataset[field] || "").localeCompare(
            String(b.dataset[field] || ""),
            "ru",
          );
        return r * dir;
      });
      vis.forEach(function (tr) {
        tbody.appendChild(tr);
      });

      var c = $("#count");
      if (c) c.innerHTML = "<b>" + shown + "</b> / " + rows.length;
      var nm = $("#noMatch");
      if (nm) nm.hidden = shown !== 0 || rows.length === 0;

      $$("#tbl thead th.sortable").forEach(function (th) {
        if (th.dataset.s === field)
          th.setAttribute("data-dir", dir === 1 ? "asc" : "desc");
        else th.removeAttribute("data-dir");
        var a = th.querySelector(".arw");
        if (a) a.textContent = dir === 1 ? "▴" : "▾";
      });

      syncBulk();
      var sa = $("#selAll");
      if (sa) {
        var vc = vis
          .map(function (t) {
            return t.querySelector(".row-check");
          })
          .filter(Boolean);
        var on = vc.filter(function (x) {
          return x.checked;
        }).length;
        sa.checked = vc.length > 0 && on === vc.length;
        sa.indeterminate = on > 0 && on < vc.length;
      }
    }

    var qi = $("#q");
    if (qi)
      qi.addEventListener("input", function () {
        state.q = this.value;
        apply();
      });

    $$("#chips .chip").forEach(function (ch) {
      ch.addEventListener("click", function () {
        var isLv = ch.hasAttribute("data-lv");
        var wasOn = ch.getAttribute("aria-pressed") === "true";
        $$("#chips .chip").forEach(function (o) {
          o.setAttribute("aria-pressed", "false");
        });
        if (isLv) {
          state.lv = wasOn ? "" : ch.getAttribute("data-lv");
          state.f = "all";
          if (!wasOn) ch.setAttribute("aria-pressed", "true");
          else
            $('#chips .chip[data-f="all"]').setAttribute(
              "aria-pressed",
              "true",
            );
        } else {
          state.f = ch.getAttribute("data-f");
          state.lv = "";
          ch.setAttribute("aria-pressed", "true");
        }
        apply();
      });
    });

    var sortSel = $("#sort");
    if (sortSel)
      sortSel.addEventListener("change", function () {
        state.sort = this.value;
        apply();
      });

    $$("#tbl thead th.sortable").forEach(function (th) {
      th.addEventListener("click", function () {
        var f = th.dataset.s,
          cur = state.sort.split("-");
        state.sort =
          f + "-" + (cur[0] === f && cur[1] === "asc" ? "desc" : "asc");
        if (sortSel) {
          var has = $$("option", sortSel).some(function (o) {
            return o.value === state.sort;
          });
          sortSel.value = has ? state.sort : "";
        }
        apply();
      });
    });

    function resetAll() {
      state = { q: "", f: "all", lv: "", sort: "id-desc" };
      if (qi) qi.value = "";
      if (sortSel) sortSel.value = "id-desc";
      $$("#chips .chip").forEach(function (o) {
        o.setAttribute(
          "aria-pressed",
          o.getAttribute("data-f") === "all" ? "true" : "false",
        );
      });
      apply();
    }
    var ra = $("#resetAll");
    if (ra) ra.addEventListener("click", resetAll);
    $$("[data-reset]").forEach(function (b) {
      b.addEventListener("click", resetAll);
    });

    /* ---------------- плотность ---------------- */
    var DKEY = "liftcs.tenants.density";
    function setDensity(v) {
      document.body.classList.toggle("compact", v === "compact");
      var l = $("#densityLabel");
      if (l) l.textContent = v === "compact" ? "Свободно" : "Плотно";
      try {
        localStorage.setItem(DKEY, v);
      } catch (e) {}
    }
    try {
      setDensity(localStorage.getItem(DKEY) === "compact" ? "compact" : "cozy");
    } catch (e) {
      setDensity("cozy");
    }
    var dbtn = $("#density");
    if (dbtn)
      dbtn.addEventListener("click", function () {
        setDensity(
          document.body.classList.contains("compact") ? "cozy" : "compact",
        );
      });

    /* ---------------- выбор ---------------- */
    function selected() {
      return rows.filter(function (t) {
        var c = t.querySelector(".row-check");
        return c && c.checked && !t.classList.contains("gone");
      });
    }
    function syncBulk() {
      var n = selected().length;
      var bar = $("#bulkbar");
      if (bar) bar.classList.toggle("on", n > 0);
      var lbl = $("#bulkN");
      if (lbl) lbl.textContent = n + " выбрано";
    }
    rows.forEach(function (tr) {
      var cb = tr.querySelector(".row-check");
      if (!cb) return;
      cb.addEventListener("change", function () {
        tr.classList.toggle("sel", cb.checked);
        apply();
      });
      cb.addEventListener("click", function (e) {
        e.stopPropagation();
      });
    });
    var selAll = $("#selAll");
    if (selAll)
      selAll.addEventListener("change", function () {
        var on = selAll.checked;
        rows.forEach(function (tr) {
          if (tr.classList.contains("gone")) return;
          var c = tr.querySelector(".row-check");
          if (c) {
            c.checked = on;
            tr.classList.toggle("sel", on);
          }
        });
        apply();
      });
    var bc = $("#bulkClear");
    if (bc)
      bc.addEventListener("click", function () {
        rows.forEach(function (tr) {
          var c = tr.querySelector(".row-check");
          if (c) c.checked = false;
          tr.classList.remove("sel");
        });
        apply();
      });

    /* ---------------- CSV ---------------- */
    function toCSV(list) {
      var head = [
        "id",
        "subdomain",
        "org_name",
        "db_host",
        "db_port",
        "db_name",
        "db_user",
        "is_active",
        "legacy_compat",
        "reports_level",
        "reports_access_rev",
        "created_at",
      ];
      function q(v) {
        return '"' + String(v == null ? "" : v).replace(/"/g, '""') + '"';
      }
      var lines = [head.join(";")];
      list.forEach(function (tr) {
        var d = tr.dataset;
        lines.push(
          [
            d.id,
            d.sub,
            d.org,
            d.host,
            d.port,
            d.db,
            d.user,
            d.active,
            d.legacy,
            d.level,
            d.rev,
            d.created,
          ]
            .map(q)
            .join(";"),
        );
      });
      return "\uFEFF" + lines.join("\r\n");
    }
    function download(name, text) {
      try {
        var blob = new Blob([text], { type: "text/csv;charset=utf-8" });
        var url = URL.createObjectURL(blob);
        var a = document.createElement("a");
        a.href = url;
        a.download = name;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(function () {
          URL.revokeObjectURL(url);
        }, 1500);
        return true;
      } catch (e) {
        return false;
      }
    }
    function stamp() {
      var d = new Date();
      function p(n) {
        return n < 10 ? "0" + n : "" + n;
      }
      return (
        d.getFullYear() +
        p(d.getMonth() + 1) +
        p(d.getDate()) +
        "-" +
        p(d.getHours()) +
        p(d.getMinutes())
      );
    }
    var ea = $("#exportAll");
    if (ea)
      ea.addEventListener("click", function () {
        var list = rows.filter(function (t) {
          return !t.classList.contains("gone");
        });
        if (!list.length) {
          L.toast("warn", "Нечего выгружать", "В текущем виде нет строк.");
          return;
        }
        if (download("organizations-" + stamp() + ".csv", toCSV(list)))
          L.toast(
            "ok",
            "Выгрузка готова",
            list.length + " строк. Пароли БД в файл не попадают.",
          );
        else
          L.toast(
            "err",
            "Выгрузка не удалась",
            "Браузер заблокировал скачивание.",
          );
      });
    var be = $("#bulkExport");
    if (be)
      be.addEventListener("click", function () {
        var list = selected();
        if (!list.length) return;
        if (download("organizations-selected-" + stamp() + ".csv", toCSV(list)))
          L.toast(
            "ok",
            "Выгрузка готова",
            list.length + " выбранных организаций.",
          );
      });
    var bcp = $("#bulkCopy");
    if (bcp)
      bcp.addEventListener("click", function () {
        var list = selected();
        if (!list.length) return;
        L.copy(
          list
            .map(function (t) {
              return t.dataset.sub;
            })
            .join("\n"),
          list.length + " поддоменов",
        );
      });

    /* ---------------- сохранённые виды ---------------- */
    var VKEY = "liftcs.tenants.views";
    function readViews() {
      try {
        return JSON.parse(localStorage.getItem(VKEY)) || [];
      } catch (e) {
        return [];
      }
    }
    function writeViews(v) {
      try {
        localStorage.setItem(VKEY, JSON.stringify(v));
      } catch (e) {}
    }
    function renderViews() {
      var box = $("#views");
      if (!box) return;
      var list = readViews();
      box.innerHTML = "";
      list.forEach(function (v, i) {
        var el = document.createElement("span");
        el.className = "view-pill";
        el.innerHTML =
          '<button type="button" class="apply">' +
          L.esc(v.name) +
          "</button>" +
          '<button type="button" class="del" aria-label="Удалить вид">' +
          L.svg('<path d="M18 6L6 18M6 6l12 12"/>', 2.6) +
          "</button>";
        el.querySelector(".apply").addEventListener("click", function () {
          state = {
            q: v.q || "",
            f: v.f || "all",
            lv: v.lv || "",
            sort: v.sort || "id-desc",
          };
          if (qi) qi.value = state.q;
          if (sortSel) sortSel.value = state.sort;
          $$("#chips .chip").forEach(function (o) {
            var on = state.lv
              ? o.getAttribute("data-lv") === state.lv
              : o.getAttribute("data-f") === state.f;
            o.setAttribute("aria-pressed", on ? "true" : "false");
          });
          apply();
          L.toast("info", "Вид применён", v.name);
        });
        el.querySelector(".del").addEventListener("click", function () {
          var cur = readViews(),
            removed = cur[i];
          cur.splice(i, 1);
          writeViews(cur);
          renderViews();
          L.toast("warn", "Вид удалён", removed ? removed.name : "", {
            action: "Вернуть",
            ms: 7000,
            onAction: function () {
              var c = readViews();
              c.splice(i, 0, removed);
              writeViews(c);
              renderViews();
              L.toast("ok", "Вид восстановлен", removed.name);
            },
          });
        });
        box.appendChild(el);
      });
    }
    var sv = $("#saveView");
    if (sv)
      sv.addEventListener("click", function () {
        var name = window.prompt(
          "Название вида:",
          state.lv ? lvlLabel(state.lv) : state.q || "Мой вид",
        );
        if (!name) return;
        name = name.trim().slice(0, 28);
        if (!name) return;
        var list = readViews();
        list.push({
          name: name,
          q: state.q,
          f: state.f,
          lv: state.lv,
          sort: state.sort,
        });
        if (list.length > 8) list = list.slice(-8);
        writeViews(list);
        renderViews();
        L.toast("ok", "Вид сохранён", name);
      });
    renderViews();

    /* ---------------- панель добавления ---------------- */
    var addPanel = $("#addPanel");
    var oa = $("#openAdd");
    if (oa)
      oa.addEventListener("click", function () {
        L.open(addPanel);
      });
    $$("[data-open-add]").forEach(function (b) {
      b.addEventListener("click", function () {
        L.open(addPanel);
      });
    });

    var fsub = $("#f_sub"),
      fprev = $("#subPreview");
    if (fsub && fprev)
      fsub.addEventListener("input", function () {
        fprev.textContent =
          (this.value.trim().toLowerCase() || "…") + ".liftcs.ru";
      });

    /* ---------------- статус + отмена ---------------- */
    var UKEY = "liftcs.tenants.undo";
    $$(".js-toggle").forEach(function (form) {
      form.addEventListener("submit", function (e) {
        e.preventDefault();
        var act = form.dataset.active === "1";
        var name = form.dataset.name || "";
        var id = form.querySelector("[name=id]").value;
        L.confirm({
          head: act ? "Отключить организацию?" : "Включить организацию?",
          html: act
            ? "Тенант <b>" +
              L.esc(name) +
              "</b> перестанет обслуживаться: вход и API по его поддомену будут недоступны. Данные не удаляются."
            : "Тенант <b>" +
              L.esc(name) +
              "</b> снова станет доступен по своему поддомену.",
          label: act ? "Отключить" : "Включить",
          cls: act ? "btn-danger" : "btn-go",
          tone: act ? "danger" : "warn",
          onYes: function () {
            try {
              sessionStorage.setItem(
                UKEY,
                JSON.stringify({
                  id: id,
                  name: name,
                  from: act ? 1 : 0,
                  to: act ? 0 : 1,
                  ts: Date.now(),
                }),
              );
            } catch (err) {}
            form.submit();
          },
        });
      });
    });

    (function offerUndo() {
      var raw = null;
      try {
        raw = sessionStorage.getItem(UKEY);
        sessionStorage.removeItem(UKEY);
      } catch (e) {}
      if (!raw) return;
      var u;
      try {
        u = JSON.parse(raw);
      } catch (e) {
        return;
      }
      if (!u || Date.now() - u.ts > 45000) return;
      var tr = rows.filter(function (t) {
        return t.dataset.id === String(u.id);
      })[0];
      if (!tr || +tr.dataset.active !== u.to) return;
      L.toast(
        u.to ? "ok" : "warn",
        u.to ? "Организация включена" : "Организация отключена",
        u.name,
        {
          action: "Отменить",
          sticky: true,
          onAction: function () {
            var f = document.createElement("form");
            f.method = "POST";
            f.action = "/admin/tenants_save.php";
            f.style.display = "none";
            [
              ["id", u.id],
              ["action", "toggle"],
              ["current_status", u.to],
            ].forEach(function (p) {
              var i = document.createElement("input");
              i.type = "hidden";
              i.name = p[0];
              i.value = p[1];
              f.appendChild(i);
            });
            document.body.appendChild(f);
            f.submit();
          },
        },
      );
    })();

    /* ---------------- очистка уведомлений ---------------- */
    $$(".js-cleanup").forEach(function (btn) {
      btn.addEventListener("click", function (e) {
        e.stopPropagation();
        if (btn.disabled) return;
        L.confirm({
          head: "Очистить уведомления?",
          html:
            "Для тенанта <b>" +
            L.esc(btn.dataset.tenantName) +
            "</b> будет выполнена очистка очереди уведомлений. Операция необратима.",
          label: "Очистить",
          cls: "btn-danger",
          tone: "danger",
          onYes: function () {
            runCleanup(btn, btn.dataset.tenantId, btn.dataset.tenantName);
          },
        });
      });
    });

    function runCleanup(btn, id, name) {
      var lbl = btn.querySelector(".lbl");
      var original = lbl ? lbl.textContent : btn.textContent;
      btn.disabled = true;
      if (lbl) lbl.textContent = "Очистка…";

      var fd = new FormData();
      fd.append("id", id);
      fetch("/admin/cleanup_tenant.php", {
        method: "POST",
        body: fd,
        credentials: "same-origin",
      })
        .then(function (r) {
          return r.json();
        })
        .then(function (data) {
          if (data && data.success)
            L.toast("ok", "Очистка завершена", (data && data.message) || name);
          else
            L.toast(
              "err",
              "Ошибка очистки",
              (data && data.error) || "Неизвестная ошибка",
            );
        })
        .catch(function (err) {
          L.toast(
            "err",
            "Сеть недоступна",
            String((err && err.message) || err),
          );
        })
        .then(function () {
          var left = 60;
          if (lbl)
            lbl.innerHTML =
              'Повтор через <span class="cd">' + left + "</span> с";
          var t = setInterval(function () {
            left--;
            var cd = btn.querySelector(".cd");
            if (cd) cd.textContent = left;
            if (left <= 0) {
              clearInterval(t);
              btn.disabled = false;
              if (lbl) lbl.textContent = original;
            }
          }, 1000);
        });
    }

    /* ---------------- карточка ---------------- */
    var drawer = $("#drawer");

    function kvRow(k, v, mask, copyable) {
      return (
        "<dt>" +
        L.esc(k) +
        "</dt><dd" +
        (mask ? ' class="mask"' : "") +
        ">" +
        L.esc(v) +
        (copyable
          ? ' <button type="button" class="copy" data-copy="' +
            L.esc(v) +
            '" title="Скопировать">' +
            L.svg(
              '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/>',
              2,
            ) +
            "</button>"
          : "") +
        "</dd>"
      );
    }

    function openDrawer(tr) {
      if (!drawer) return;
      var d = tr.dataset,
        t = tier(d.level),
        m = MATRIX[d.level];

      $("#drOrg").textContent = d.org;
      $("#drSub").textContent = d.sub + ".liftcs.ru";
      $("#drHero").style.setProperty("--hc", t.c);

      $("#drTags").innerHTML =
        (d.active === "1"
          ? '<span class="badge b-on"><i class="lamp-s"></i>Активен</span>'
          : '<span class="badge b-off"><i class="lamp-s"></i>Отключён</span>') +
        (d.legacy === "1"
          ? '<span class="badge b-legacy">Legacy</span>'
          : '<span class="badge b-modern">Современный трек</span>') +
        '<span class="lvl-pill ' +
        t.cls +
        '">' +
        L.esc(lvlLabel(d.level)) +
        '<span class="rk">r' +
        (m ? m.rank : "—") +
        "</span></span>";

      $("#drIdent").innerHTML =
        kvRow("ID", d.id) +
        kvRow("Поддомен", d.sub, false, true) +
        kvRow("Название", d.org) +
        kvRow("Создана", d.created || "—");

      $("#drConn").innerHTML =
        kvRow("Хост", d.host, false, true) +
        kvRow("Порт", d.port) +
        kvRow("Имя БД", d.db, false, true) +
        kvRow("Логин", d.user, false, true) +
        kvRow("Пароль", "••••••••••••", true, false) +
        kvRow("Legacy", d.legacy === "1" ? "включён" : "выключен") +
        kvRow("Статус", d.active === "1" ? "активен" : "отключён");

      var editUrl = "/admin/tenant_edit.php?id=" + encodeURIComponent(d.id);
      $("#drEdit").href = editUrl;
      $("#drEdit2").href = editUrl;
      $("#drOpen").href = "https://" + d.sub + ".liftcs.ru";
      $("#drCopySub").onclick = function () {
        L.copy(d.sub, "Поддомен " + d.sub);
      };
      $("#drCopyDb").onclick = function () {
        L.copy(d.db, "Имя БД " + d.db);
      };

      $("#drLevelHead").innerHTML =
        '<div class="dr-hero" style="--hc:' +
        t.c +
        '"><h3>' +
        L.esc(lvlLabel(d.level)) +
        "</h3>" +
        '<div class="sub">reports_level = ' +
        L.esc(d.level) +
        "</div>" +
        '<div class="tags"><span class="rev">reports_access_rev <b>' +
        L.esc(d.rev) +
        "</b></span>" +
        '<span class="badge b-modern">ранг ' +
        (m ? m.rank : "—") +
        "</span></div></div>";

      var feats = (m && m.features) || [];
      $("#drCaps").innerHTML =
        (META.features || [])
          .map(function (f) {
            var yes = feats.indexOf(f.key) !== -1;
            return (
              '<div class="cap ' +
              (yes ? "yes" : "no") +
              '"><span class="mk">' +
              (yes ? "✓" : "✕") +
              "</span><span>" +
              L.esc(f.label) +
              "</span></div>"
            );
          })
          .join("") || '<div class="cap no">Нет данных</div>';

      var groups = (m && m.limits && m.limits.filter_groups) || [];
      $("#drGroups").innerHTML =
        (META.groups || [])
          .map(function (g) {
            var yes = groups.indexOf(g.key) !== -1;
            return (
              '<div class="cap ' +
              (yes ? "yes" : "no") +
              '"><span class="mk">' +
              (yes ? "✓" : "✕") +
              "</span><span>" +
              L.esc(g.label) +
              "</span></div>"
            );
          })
          .join("") || '<div class="cap no">Нет данных</div>';

      if (m) {
        var Lm = m.limits || {};
        var scope =
          (META.scopes && META.scopes[Lm.address_scope]) ||
          Lm.address_scope ||
          "—";
        $("#drLims").innerHTML =
          '<div class="lim"><div class="k">Период</div><div class="v">' +
          L.esc(Lm.max_period_days) +
          " <small>дн.</small></div></div>" +
          '<div class="lim"><div class="k">Экспорт</div><div class="v">' +
          L.esc(Lm.max_rows) +
          " <small>строк</small></div></div>" +
          '<div class="lim"><div class="k">Список</div><div class="v">' +
          (m.list_cap == null
            ? '<span class="v txt">Без потолка</span>'
            : L.esc(m.list_cap) + " <small>строк</small>") +
          "</div></div>" +
          '<div class="lim"><div class="k">Адреса</div><div class="v txt">' +
          L.esc(scope) +
          "</div></div>";
      } else {
        $("#drLims").innerHTML =
          '<div class="lim"><div class="k">Данные</div><div class="v txt">недоступны</div></div>';
      }

      var lv = META.levels || [];
      var head =
        "<tr><th>Параметр</th>" +
        lv
          .map(function (l) {
            return (
              '<th class="' +
              (l === d.level ? "cur" : "") +
              '">' +
              L.esc(lvlLabel(l)) +
              "</th>"
            );
          })
          .join("") +
        "</tr>";

      function row(label, cells) {
        return (
          "<tr><td>" +
          L.esc(label) +
          "</td>" +
          cells
            .map(function (c, i) {
              return (
                '<td class="' +
                (lv[i] === d.level ? "cur " : "") +
                c.cls +
                '">' +
                c.v +
                "</td>"
              );
            })
            .join("") +
          "</tr>"
        );
      }
      var body = "";
      (META.features || []).forEach(function (f) {
        body += row(
          f.label,
          lv.map(function (l) {
            var on = MATRIX[l] && MATRIX[l].features.indexOf(f.key) !== -1;
            return { cls: on ? "y" : "n", v: on ? "✓" : "—" };
          }),
        );
      });
      (META.groups || []).forEach(function (g) {
        body += row(
          g.label,
          lv.map(function (l) {
            var on =
              MATRIX[l] && MATRIX[l].limits.filter_groups.indexOf(g.key) !== -1;
            return { cls: on ? "y" : "n", v: on ? "✓" : "—" };
          }),
        );
      });
      body += row(
        "Период, дн.",
        lv.map(function (l) {
          return {
            cls: "",
            v: MATRIX[l] ? MATRIX[l].limits.max_period_days : "—",
          };
        }),
      );
      body += row(
        "Экспорт, строк",
        lv.map(function (l) {
          return { cls: "", v: MATRIX[l] ? MATRIX[l].limits.max_rows : "—" };
        }),
      );
      body += row(
        "Потолок списка",
        lv.map(function (l) {
          return {
            cls: "",
            v: MATRIX[l]
              ? MATRIX[l].list_cap == null
                ? "∞"
                : MATRIX[l].list_cap
              : "—",
          };
        }),
      );
      $("#drMtx").innerHTML = head + body;

      $$(".dr-tab").forEach(function (tb) {
        tb.setAttribute(
          "aria-selected",
          tb.dataset.pane === "ov" ? "true" : "false",
        );
      });
      $$(".dr-pane").forEach(function (p) {
        p.classList.toggle("on", p.dataset.pane === "ov");
      });

      L.open(drawer);
    }

    $$(".dr-tab").forEach(function (tb) {
      tb.addEventListener("click", function () {
        $$(".dr-tab").forEach(function (o) {
          o.setAttribute("aria-selected", "false");
        });
        tb.setAttribute("aria-selected", "true");
        $$(".dr-pane").forEach(function (p) {
          p.classList.toggle("on", p.dataset.pane === tb.dataset.pane);
        });
      });
    });

    $$(".js-detail").forEach(function (b) {
      b.addEventListener("click", function (e) {
        e.stopPropagation();
        var tr = b.closest("tr");
        if (tr) openDrawer(tr);
      });
    });
    rows.forEach(function (tr) {
      tr.addEventListener("click", function (e) {
        if (e.target.closest("a, button, input, form, label")) return;
        openDrawer(tr);
      });
    });

    /* ---------------- горячие клавиши ---------------- */
    document.addEventListener("keydown", function (e) {
      var tag = ((e.target && e.target.tagName) || "").toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select") return;
      if (L.current()) return;
      if (e.key === "/") {
        e.preventDefault();
        if (qi) qi.focus();
      }
      if (e.key === "n" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        L.open(addPanel);
      }
    });

    var lo = $("#logout");
    if (lo)
      lo.addEventListener("click", function () {
        try {
          sessionStorage.removeItem(UKEY);
        } catch (e) {}
      });

    if (rows.length) apply();
    else {
      var c0 = $("#count");
      if (c0) c0.innerHTML = "<b>0</b> / 0";
    }
  });
})(window, document);
