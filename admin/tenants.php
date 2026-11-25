<?php
declare(strict_types=1);
define('APP_ENTRY_POINT', true);

require_once __DIR__ . '/../autoload.php';
require_once __DIR__ . '/_reports_levels.php';

session_start();

if (empty($_SESSION['admin_logged_in'])) {
    header('Location: /admin/');
    exit;
}

header('Content-Type: text/html; charset=utf-8');

function esc(null|string|int|float $v): string
{
    return htmlspecialchars((string) $v, ENT_QUOTES, 'UTF-8');
}

$registry = new \App\Registry();
$tenants  = $registry->listAll();

$rows = [];
foreach ($tenants as $t) {
    $rows[] = [
        'id'         => (int) ($t['id'] ?? 0),
        'subdomain'  => (string) ($t['subdomain'] ?? ''),
        'org_name'   => (string) ($t['org_name'] ?? ''),
        'db_host'    => (string) ($t['db_host'] ?? ''),
        'db_port'    => (int) ($t['db_port'] ?? 3306),
        'db_name'    => (string) ($t['db_name'] ?? ''),
        'db_user'    => (string) ($t['db_user'] ?? ''),
        'is_active'  => !empty($t['is_active']) ? 1 : 0,
        'legacy'     => !empty($t['legacy_compat']) ? 1 : 0,
        'created_at' => (string) ($t['created_at'] ?? ''),
        'level'      => \App\Support\ReportsAccess::normalizeLevel($t['reports_level'] ?? null),
        'rev'        => (int) ($t['reports_access_rev'] ?? 1),
    ];
}

$total    = count($rows);
$active   = count(array_filter($rows, static fn(array $r): bool => $r['is_active'] === 1));
$inactive = $total - $active;
$legacy   = count(array_filter($rows, static fn(array $r): bool => $r['legacy'] === 1));

$levels  = admin_reports_levels();
$matrix  = admin_reports_matrix();
$byLevel = array_count_values(array_column($rows, 'level'));

$tierColor = [
    'light'    => 'linear-gradient(90deg,#22d3ee,#0ea5b7)',
    'standard' => 'linear-gradient(90deg,#3b82f6,#2563eb)',
    'extended' => 'linear-gradient(90deg,#ec4899,#a78bfa)',
];

$jsonFlags = JSON_UNESCAPED_UNICODE | JSON_HEX_TAG | JSON_HEX_AMP | JSON_HEX_APOS | JSON_HEX_QUOT;
$v = static fn(string $f): string => '/admin/' . $f . '?v=1';
?>
<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="dark">
<title>Организации · LIFT·CS Platform</title>
<link rel="stylesheet" href="<?= $v('css/platform.css') ?>">
<link rel="stylesheet" href="<?= $v('css/tenants.css') ?>">
</head>
<body data-page="tenants">

<div class="bg" aria-hidden="true">
  <div class="bg-base"></div><div class="bg-rails"></div><div class="bg-ticks"></div>
  <div class="bg-car"></div><div class="bg-car b"></div><div class="bg-grain"></div>
</div>

<header class="head">
  <a class="brand" href="/admin/tenants.php">
    <span class="mark">
      <svg viewBox="0 0 24 24" fill="none" stroke="url(#g1)" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
        <defs><linearGradient id="g1" x1="0" y1="0" x2="24" y2="24">
          <stop offset="0" stop-color="#22d3ee"/><stop offset="1" stop-color="#a78bfa"/>
        </linearGradient></defs>
        <rect x="4" y="2.5" width="16" height="19" rx="2.2"/>
        <path d="M12 2.5v19M8.4 8.2l1.5-2 1.5 2M15.6 15.8l-1.5 2-1.5-2"/>
      </svg>
    </span>
    <span class="brand-txt">
      <span class="brand-name">LIFT·CS</span>
      <span class="brand-sub">Platform Admin</span>
    </span>
  </a>

  <div class="head-spacer"></div>

  <div class="head-meta">
    <div class="clock" id="clock">MSK <b>--:--:--</b></div>
    <button type="button" class="btn btn-primary" id="openAdd">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>
      Организация
    </button>
    <a href="/admin/?logout=1" class="btn btn-danger" id="logout">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9"/></svg>
      Выйти
    </a>
  </div>
</header>

<div class="bar">
  <div class="search">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.6-3.6"/></svg>
    <input type="search" id="q" class="inp" placeholder="Поддомен, название, БД…" autocomplete="off" aria-label="Поиск по организациям">
    <kbd>/</kbd>
  </div>

  <div class="chips" id="chips">
    <button type="button" class="chip" data-f="all" aria-pressed="true">Все <span class="n"><?= (int) $total ?></span></button>
    <button type="button" class="chip" data-f="active" aria-pressed="false"><i class="dot"></i>Активные <span class="n"><?= (int) $active ?></span></button>
    <button type="button" class="chip" data-f="inactive" aria-pressed="false"><i class="dot"></i>Отключённые <span class="n"><?= (int) $inactive ?></span></button>
    <button type="button" class="chip" data-f="legacy" aria-pressed="false"><i class="dot"></i>Legacy <span class="n"><?= (int) $legacy ?></span></button>
    <?php foreach ($levels as $lv): ?>
      <button type="button" class="chip" data-lv="<?= esc($lv) ?>" aria-pressed="false">
        <i class="dot"></i><?= esc(admin_reports_level_label($lv)) ?>
        <span class="n"><?= (int) ($byLevel[$lv] ?? 0) ?></span>
      </button>
    <?php endforeach; ?>
  </div>

  <select class="inp sel" id="sort" aria-label="Сортировка">
    <option value="id-desc">ID ↓</option>
    <option value="id-asc">ID ↑</option>
    <option value="sub-asc">Поддомен А→Я</option>
    <option value="sub-desc">Поддомен Я→А</option>
    <option value="org-asc">Название А→Я</option>
    <option value="level-desc">Уровень: выше</option>
    <option value="level-asc">Уровень: ниже</option>
    <option value="rev-desc">Ревизия ↓</option>
  </select>

  <button type="button" class="btn btn-ghost btn-sm" id="density" title="Плотность строк">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M3 6h18M3 12h18M3 18h18"/></svg>
    <span id="densityLabel">Плотно</span>
  </button>

  <button type="button" class="btn btn-ghost btn-sm" id="saveView" title="Сохранить набор фильтров">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21l-7-5-7 5V5a2 2 0 012-2h10a2 2 0 012 2z"/></svg>
    Вид
  </button>

  <div class="views" id="views"></div>
  <div class="head-spacer"></div>
  <div class="bar-count" id="count"><b><?= (int) $total ?></b> / <?= (int) $total ?></div>
</div>

<main class="wrap">

  <section class="stats">
    <div class="stat rise" style="--c:var(--electric);animation-delay:.02s">
      <div class="stat-k">Организаций</div>
      <div class="stat-v"><?= (int) $total ?></div>
      <div class="stat-f">в центральном реестре</div>
      <div class="spark"><?php for ($i = 0; $i < 12; $i++): ?><i style="height:<?= 22 + (($i * 37) % 62) ?>%"></i><?php endfor; ?></div>
    </div>

    <div class="stat rise" style="--c:var(--signal);animation-delay:.07s">
      <div class="stat-k">Активны</div>
      <div class="stat-v"><?= (int) $active ?><small>/ <?= (int) $total ?></small></div>
      <div class="stat-f">
        <span class="badge b-on"><i class="lamp-s"></i>в работе</span>
        <?php if ($inactive > 0): ?><span class="badge b-off"><?= (int) $inactive ?> откл.</span><?php endif; ?>
      </div>
      <div class="dist">
        <i style="width:<?= $total ? round($active / $total * 100, 2) : 0 ?>%;background:linear-gradient(90deg,#34d399,#22d3ee)"></i>
        <i style="width:<?= $total ? round($inactive / $total * 100, 2) : 0 ?>%;background:linear-gradient(90deg,#fb4d6d,#e11d48)"></i>
      </div>
    </div>

    <div class="stat rise" style="--c:var(--amber);animation-delay:.12s">
      <div class="stat-k">Legacy-режим</div>
      <div class="stat-v"><?= (int) $legacy ?></div>
      <div class="stat-f"><?= $legacy > 0 ? 'прокси совместимости включён' : 'все на современном треке' ?></div>
      <div class="dist">
        <i style="width:<?= $total ? round($legacy / $total * 100, 2) : 0 ?>%;background:linear-gradient(90deg,#fbbf24,#f59e0b)"></i>
        <i style="width:<?= $total ? round(($total - $legacy) / $total * 100, 2) : 0 ?>%;background:#243040"></i>
      </div>
    </div>

    <div class="stat rise" style="--c:var(--magenta);animation-delay:.17s">
      <div class="stat-k">Уровни отчётов</div>
      <div class="stat-v"><?= (int) ($byLevel['extended'] ?? 0) ?><small>extended</small></div>
      <div class="dist">
        <?php foreach ($levels as $lv): ?>
          <i style="width:<?= $total ? round(($byLevel[$lv] ?? 0) / $total * 100, 2) : 0 ?>%;background:<?= $tierColor[$lv] ?? '#243040' ?>"></i>
        <?php endforeach; ?>
      </div>
      <div class="dist-lg">
        <?php foreach ($levels as $lv): ?>
          <span><i style="background:<?= $tierColor[$lv] ?? '#243040' ?>"></i><?= esc(admin_reports_level_label($lv)) ?> · <?= (int) ($byLevel[$lv] ?? 0) ?></span>
        <?php endforeach; ?>
      </div>
    </div>
  </section>

  <section class="panel rise" style="animation-delay:.22s">
    <div class="panel-head">
      <div class="panel-title"><i class="lamp"></i>Реестр организаций</div>
      <div class="grow"></div>
      <button type="button" class="btn btn-ghost btn-sm" id="exportAll">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg>
        CSV
      </button>
      <button type="button" class="btn btn-ghost btn-sm" id="resetAll">Сбросить</button>
    </div>

    <div class="bulkbar" id="bulkbar">
      <span class="n" id="bulkN">0 выбрано</span>
      <div class="grow"></div>
      <button type="button" class="btn btn-cyan btn-sm" id="bulkCopy">Скопировать поддомены</button>
      <button type="button" class="btn btn-cyan btn-sm" id="bulkExport">Выгрузить выбранные</button>
      <button type="button" class="btn btn-ghost btn-sm" id="bulkClear">Снять выбор</button>
    </div>

    <?php if ($rows === []): ?>
      <div class="empty">
        <div class="empty-ic">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="2.5" width="16" height="19" rx="2"/><path d="M12 2.5v19"/></svg>
        </div>
        <h3>Реестр пуст</h3>
        <p>В центральной базе нет ни одной организации. Добавьте первую — она появится в списке и станет доступна по поддомену.</p>
        <button type="button" class="btn btn-primary" data-open-add>Добавить организацию</button>
      </div>
    <?php else: ?>
      <div class="tbl-scroll">
        <table class="grid" id="tbl">
          <thead>
            <tr>
              <th style="width:38px"><input type="checkbox" class="cbox" id="selAll" aria-label="Выбрать все видимые"></th>
              <th class="sortable" data-s="sub">Поддомен<span class="arw">▾</span></th>
              <th class="sortable" data-s="org">Название<span class="arw">▾</span></th>
              <th class="col-db">БД</th>
              <th>Legacy</th>
              <th>Статус</th>
              <th class="sortable" data-s="level">Отчёты<span class="arw">▾</span></th>
              <th style="width:1%">Действия</th>
            </tr>
          </thead>
          <tbody id="tbody">
          <?php foreach ($rows as $i => $r):
              $lv    = $r['level'];
              $lvCls = isset($matrix[$lv]) ? 'lv-' . $lv : 'lv-unknown';
              $host  = $r['subdomain'] . '.liftcs.ru';
              $search = mb_strtolower($r['subdomain'] . ' ' . $r['org_name'] . ' ' . $r['db_name'] . ' ' . $r['db_user']);
          ?>
            <tr class="rise"
                style="animation-delay:<?= min(0.26 + $i * 0.028, 0.9) ?>s"
                data-id="<?= (int) $r['id'] ?>"
                data-sub="<?= esc($r['subdomain']) ?>"
                data-org="<?= esc($r['org_name']) ?>"
                data-host="<?= esc($r['db_host']) ?>"
                data-port="<?= (int) $r['db_port'] ?>"
                data-db="<?= esc($r['db_name']) ?>"
                data-user="<?= esc($r['db_user']) ?>"
                data-active="<?= (int) $r['is_active'] ?>"
                data-legacy="<?= (int) $r['legacy'] ?>"
                data-level="<?= esc($lv) ?>"
                data-rev="<?= (int) $r['rev'] ?>"
                data-created="<?= esc($r['created_at']) ?>"
                data-rank="<?= (int) admin_reports_level_rank($lv) ?>"
                data-search="<?= esc($search) ?>">

              <td class="c-check"><input type="checkbox" class="cbox row-check" aria-label="Выбрать <?= esc($r['org_name']) ?>"></td>

              <td class="c-sub" data-l="Поддомен">
                <a class="sub-link" href="https://<?= esc($host) ?>" target="_blank" rel="noopener noreferrer">
                  <?= esc($r['subdomain']) ?>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6M15 3h6v6M10 14L21 3"/></svg>
                </a>
              </td>

              <td data-l="Название"><div class="org"><?= esc($r['org_name']) ?></div></td>

              <td class="col-db" data-l="БД">
                <div class="tech">
                  <code title="<?= esc($r['db_name']) ?>"><?= esc($r['db_name']) ?></code>
                  <button type="button" class="copy" data-copy="<?= esc($r['db_name']) ?>" title="Скопировать имя БД">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>
                  </button>
                </div>
              </td>

              <td data-l="Legacy">
                <span class="badge <?= $r['legacy'] ? 'b-legacy' : 'b-modern' ?>"><?= $r['legacy'] ? 'Legacy' : '—' ?></span>
              </td>

              <td data-l="Статус">
                <span class="badge <?= $r['is_active'] ? 'b-on' : 'b-off' ?>"><i class="lamp-s"></i><?= $r['is_active'] ? 'Активен' : 'Отключён' ?></span>
              </td>

              <td data-l="Отчёты">
                <div class="lvl">
                  <span class="lvl-pill <?= esc($lvCls) ?>">
                    <?= esc(admin_reports_level_label($lv)) ?>
                    <span class="rk">r<?= (int) admin_reports_level_rank($lv) ?></span>
                  </span>
                  <span class="rev" title="reports_access_rev — счётчик доставки, только авто-инкремент">rev <b><?= (int) $r['rev'] ?></b></span>
                </div>
              </td>

              <td data-l="Действия">
                <div class="acts">
                  <a class="btn btn-violet btn-sm" href="/admin/tenant_edit.php?id=<?= (int) $r['id'] ?>">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 013 3L12 15l-4 1 1-4z"/></svg>
                    Изменить
                  </a>

                  <form action="/admin/tenants_save.php" method="POST" class="js-toggle"
                        data-name="<?= esc($r['org_name']) ?>" data-active="<?= (int) $r['is_active'] ?>">
                    <input type="hidden" name="id" value="<?= (int) $r['id'] ?>">
                    <input type="hidden" name="action" value="toggle">
                    <input type="hidden" name="current_status" value="<?= (int) $r['is_active'] ?>">
                    <button type="submit" class="btn btn-sm <?= $r['is_active'] ? 'btn-warn' : 'btn-go' ?>"><?= $r['is_active'] ? 'Выкл' : 'Вкл' ?></button>
                  </form>

                  <?php if (!$r['legacy'] && $r['is_active']): ?>
                    <button type="button" class="btn btn-cyan btn-sm js-cleanup"
                            data-tenant-id="<?= (int) $r['id'] ?>" data-tenant-name="<?= esc($r['org_name']) ?>">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/></svg>
                      <span class="lbl">Очистка уведомлений</span>
                    </button>
                  <?php endif; ?>

                  <button type="button" class="btn btn-ghost btn-sm btn-icon js-detail" title="Карточка организации" aria-label="Карточка организации">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 16v-4M12 8h.01"/></svg>
                  </button>
                </div>
              </td>
            </tr>
          <?php endforeach; ?>
          </tbody>
        </table>
      </div>

      <div class="empty" id="noMatch" hidden>
        <div class="empty-ic">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.6-3.6"/></svg>
        </div>
        <h3>Ничего не найдено</h3>
        <p>Под текущий поиск и фильтры не подходит ни одна организация. Сбросьте условия — реестр снова покажет все записи.</p>
        <button type="button" class="btn btn-ghost" data-reset>Сбросить фильтры</button>
      </div>
    <?php endif; ?>
  </section>
</main>

<aside class="slide" id="addPanel" role="dialog" aria-modal="true" aria-labelledby="addTitle" aria-hidden="true">
  <div class="slide-head">
    <h2 id="addTitle">Новая организация</h2>
    <button type="button" class="btn btn-ghost btn-icon" data-close aria-label="Закрыть">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
    </button>
  </div>

  <form action="/admin/tenants_save.php" method="POST" id="addForm" style="display:flex;flex-direction:column;flex:1;min-height:0">
    <input type="hidden" name="action" value="add">
    <div class="slide-body">
      <div class="note note-i">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 16v-4M12 8h.01"/></svg>
        <div>Запись создаётся в центральном реестре. Пароль БД шифруется на сервере. Уровень отчётов примет значение по умолчанию — <b>Стандарт</b>; меняется в карточке организации.</div>
      </div>

      <div class="fg">
        <label for="f_sub">Поддомен<span class="req">*</span></label>
        <input type="text" id="f_sub" name="subdomain" class="inp mono" placeholder="sh" required
               pattern="[a-z0-9-]+" maxlength="63" autocomplete="off" spellcheck="false">
        <div class="hint">Строчные латинские буквы, цифры и дефис. До 63 символов. Адрес: <span id="subPreview" class="mono" style="color:var(--electric)">…liftcs.ru</span></div>
      </div>

      <div class="fg">
        <label for="f_org">Название организации<span class="req">*</span></label>
        <input type="text" id="f_org" name="org_name" class="inp" placeholder="ООО БДОМ" required autocomplete="off">
      </div>

      <div class="frow">
        <div class="fg">
          <label for="f_host">Хост БД<span class="req">*</span></label>
          <input type="text" id="f_host" name="db_host" class="inp mono" value="localhost" required autocomplete="off">
        </div>
        <div class="fg">
          <label for="f_port">Порт<span class="req">*</span></label>
          <input type="number" id="f_port" name="db_port" class="inp mono" value="3306" min="1" max="65535" required>
        </div>
      </div>

      <div class="fg">
        <label for="f_db">Имя БД<span class="req">*</span></label>
        <input type="text" id="f_db" name="db_name" class="inp mono" placeholder="zamotaev_sh_liftcs" required autocomplete="off" spellcheck="false">
      </div>

      <div class="fg">
        <label for="f_user">Логин БД<span class="req">*</span></label>
        <input type="text" id="f_user" name="db_user" class="inp mono" placeholder="zamotaev_sh" required autocomplete="off" spellcheck="false">
      </div>

      <div class="fg">
        <label for="f_pass">Пароль БД<span class="req">*</span></label>
        <input type="password" id="f_pass" name="db_password" class="inp" placeholder="••••••••" required autocomplete="new-password">
        <div class="hint">Хранится только в зашифрованном виде и никогда не отображается в интерфейсе.</div>
      </div>

      <div class="note note-w" style="margin-bottom:0">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.3 3.9L1.8 18a2 2 0 001.7 3h17a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z"/><path d="M12 9v4M12 17h.01"/></svg>
        <div>Поддомен должен обслуживаться веб-сервером и DNS. Запись в реестре сама по себе не создаёт vhost.</div>
      </div>
    </div>

    <div class="slide-foot">
      <button type="button" class="btn btn-ghost" data-close>Отмена</button>
      <button type="submit" class="btn btn-primary">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>
        Создать
      </button>
    </div>
  </form>
</aside>

<aside class="slide" id="drawer" role="dialog" aria-modal="true" aria-labelledby="drTitle" aria-hidden="true">
  <div class="slide-head">
    <h2 id="drTitle">Карточка организации</h2>
    <a class="btn btn-violet btn-sm" id="drEdit" href="#">Изменить</a>
    <button type="button" class="btn btn-ghost btn-icon" data-close aria-label="Закрыть">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
    </button>
  </div>

  <div class="dr-tabs" role="tablist">
    <button class="dr-tab" role="tab" data-pane="ov" aria-selected="true">Обзор</button>
    <button class="dr-tab" role="tab" data-pane="rp" aria-selected="false">Отчёты</button>
    <button class="dr-tab" role="tab" data-pane="cn" aria-selected="false">Подключение</button>
  </div>

  <div class="slide-body">
    <div class="dr-pane on" data-pane="ov">
      <div class="dr-hero" id="drHero">
        <h3 id="drOrg">—</h3>
        <div class="sub" id="drSub">—</div>
        <div class="tags" id="drTags"></div>
      </div>
      <div class="sec-t">Идентификация</div>
      <dl class="kv" id="drIdent"></dl>
      <div class="sec-t">Быстрые действия</div>
      <div class="acts">
        <a class="btn btn-cyan btn-sm" id="drOpen" href="#" target="_blank" rel="noopener noreferrer">Открыть тенант</a>
        <button type="button" class="btn btn-ghost btn-sm" id="drCopySub">Скопировать поддомен</button>
        <button type="button" class="btn btn-ghost btn-sm" id="drCopyDb">Скопировать имя БД</button>
      </div>
    </div>

    <div class="dr-pane" data-pane="rp">
      <div class="note note-i">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 16v-4M12 8h.01"/></svg>
        <div>Уровень применяется ко всем пользователям организации и не зависит от их ролей. Изменение вступает в силу в открытых вкладках автоматически в течение одного цикла опроса уведомлений; перелогин не требуется. Понижение уровня скрывает часть отчётов и выгрузок — данные не удаляются.</div>
      </div>
      <div id="drLevelHead"></div>
      <div class="sec-t">Способности</div>
      <div class="caps" id="drCaps"></div>
      <div class="sec-t">Лимиты</div>
      <div class="lims" id="drLims"></div>
      <div class="sec-t">Группы фильтров</div>
      <div class="caps" id="drGroups"></div>
      <div class="sec-t">Сравнение уровней</div>
      <div style="overflow-x:auto"><table class="mtx" id="drMtx"></table></div>
      <div class="hint" style="margin-top:10px">Матрица построена из <code>ReportsAccess::configPayload()</code>. Состав уровней и способностей админка не хранит.</div>
    </div>

    <div class="dr-pane" data-pane="cn">
      <div class="note note-w">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>
        <div>Пароль БД хранится зашифрованным и не передаётся в браузер. Правка параметров подключения — только в форме редактирования.</div>
      </div>
      <dl class="kv" id="drConn"></dl>
    </div>
  </div>

  <div class="slide-foot">
    <button type="button" class="btn btn-ghost" data-close>Закрыть</button>
    <a class="btn btn-primary" id="drEdit2" href="#">Редактировать</a>
  </div>
</aside>

<script type="application/json" id="levelMatrix"><?= json_encode($matrix, $jsonFlags) ?></script>
<script type="application/json" id="levelMeta"><?= json_encode(admin_reports_meta(), $jsonFlags) ?></script>
<script src="<?= $v('js/platform.js') ?>" defer></script>
<script src="<?= $v('js/tenants.js') ?>" defer></script>
</body>
</html>