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
$id = (int) ($_GET['id'] ?? $_POST['id'] ?? 0);
if ($id <= 0) {
    header('Location: /admin/tenants.php');
    exit;
}

$tenant = null;
foreach ($registry->listAll() as $t) {
    if ((string) $t['id'] === (string) $id) {
        $tenant = $t;
        break;
    }
}
if (!$tenant) {
    http_response_code(404);
    die('Организация не найдена. <a href="/admin/tenants.php">Назад к списку</a>');
}

$originalLevel = \App\Support\ReportsAccess::normalizeLevel($tenant['reports_level'] ?? null);

$form = [
    'subdomain'     => (string) ($tenant['subdomain'] ?? ''),
    'org_name'      => (string) ($tenant['org_name'] ?? ''),
    'db_host'       => (string) ($tenant['db_host'] ?? ''),
    'db_port'       => (string) ($tenant['db_port'] ?? '3306'),
    'db_name'       => (string) ($tenant['db_name'] ?? ''),
    'db_user'       => (string) ($tenant['db_user'] ?? ''),
    'legacy_compat' => !empty($tenant['legacy_compat']) ? 1 : 0,
    'reports_level' => $originalLevel,
];

$error = '';
$reportsLevel = $originalLevel;

if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $post = $_POST;
    $post['legacy_compat'] = isset($post['legacy_compat']) ? 1 : 0;

    $required = [
        'subdomain' => 'Поддомен',
        'org_name'  => 'Название организации',
        'db_host'   => 'Хост БД',
        'db_port'   => 'Порт БД',
        'db_name'   => 'Имя БД',
        'db_user'   => 'Логин БД',
    ];
    foreach ($required as $field => $label) {
        if (trim((string) ($post[$field] ?? '')) === '') {
            $error = "Поле «{$label}» обязательно для заполнения";
            break;
        }
    }

    $subdomain = trim((string) ($post['subdomain'] ?? ''));
    if ($error === '' && !\App\Registry::isValidSubdomain($subdomain)) {
        $error = strlen($subdomain) > 63
            ? 'Поддомен длиннее 63 символов'
            : 'Поддомен может содержать только строчные латинские буквы, цифры и дефисы';
    }

    if ($error === '' && !ctype_digit((string) ($post['db_port'] ?? ''))) {
        $error = 'Порт БД должен быть числом';
    }

    $reportsLevel = (string) ($post['reports_level'] ?? '');
    if ($error === '' && !admin_reports_is_level($reportsLevel)) {
        $error = 'Недопустимый уровень отчётов';
    }

    if ($error === '') {
        foreach ($registry->listAll() as $t) {
            if ((string) $t['id'] !== (string) $id && ($t['subdomain'] ?? '') === $subdomain) {
                $error = 'Поддомен «' . $subdomain . '» уже занят другой организацией';
                break;
            }
        }
    }

    if ($error === '') {
        $data = [
            'id'            => $id,
            'subdomain'     => $subdomain,
            'org_name'      => trim((string) $post['org_name']),
            'db_host'       => trim((string) $post['db_host']),
            'db_port'       => (int) $post['db_port'],
            'db_name'       => trim((string) $post['db_name']),
            'db_user'       => trim((string) $post['db_user']),
            'legacy_compat' => (int) $post['legacy_compat'],
            'is_active'     => (int) ($tenant['is_active'] ?? 1),
        ];

        $data['db_password'] = trim((string) ($post['db_password'] ?? '')) === ''
            ? \App\Support\Crypto::decrypt((string) $tenant['db_password'])
            : (string) $post['db_password'];

        try {
            $registry->save($data);
            $registry->setReportsLevel($id, $reportsLevel);
            header('Location: /admin/tenants.php');
            exit;
        } catch (\Throwable $e) {
            // Конфликт UNIQUE определяем по факту владельца имени, а не по
            // тексту SQLSTATE — тот же приём, что в DB::execute для 1062.
            // listAll(), не findBySubdomain(): последний фильтрует is_active=1
            // и не увидел бы отключённого владельца.
            $owner = null;
            try {
                foreach ($registry->listAll() as $t) {
                    if ((string) $t['id'] !== (string) $id && ($t['subdomain'] ?? '') === $subdomain) {
                        $owner = $t;
                        break;
                    }
                }
            } catch (\Throwable $ignore) {
                // БД недоступна — факт не проверить, показываем исходную ошибку.
            }

            if ($owner !== null) {
                $error = 'Поддомен «' . $subdomain . '» уже занят другой организацией';
            } else {
                \App\Support\Logger::error('tenant_edit: save failed', [
                    'tenant_id' => $id,
                    'subdomain' => $subdomain,
                    'exception' => $e::class,
                    'message'   => $e->getMessage(),
                ]);
                $error = 'Ошибка сохранения: ' . $e->getMessage();
            }
        }
    }

    if ($error !== '') {
        $form = [
            'subdomain'     => (string) ($post['subdomain'] ?? ''),
            'org_name'      => (string) ($post['org_name'] ?? ''),
            'db_host'       => (string) ($post['db_host'] ?? ''),
            'db_port'       => (string) ($post['db_port'] ?? ''),
            'db_name'       => (string) ($post['db_name'] ?? ''),
            'db_user'       => (string) ($post['db_user'] ?? ''),
            'legacy_compat' => (int) ($post['legacy_compat'] ?? 0),
            'reports_level' => admin_reports_is_level($reportsLevel) ? $reportsLevel : $originalLevel,
        ];
    }
}

$levels = admin_reports_levels();
$matrix = admin_reports_matrix();

$tierColor = ['light' => '#22d3ee', 'standard' => '#3b82f6', 'extended' => '#ec4899'];

$original = [
    'subdomain' => (string) ($tenant['subdomain'] ?? ''),
    'org_name'  => (string) ($tenant['org_name'] ?? ''),
    'db_host'   => (string) ($tenant['db_host'] ?? ''),
    'db_port'   => (string) ($tenant['db_port'] ?? '3306'),
    'db_name'   => (string) ($tenant['db_name'] ?? ''),
    'db_user'   => (string) ($tenant['db_user'] ?? ''),
    'legacy'    => !empty($tenant['legacy_compat']) ? 1 : 0,
    'level'     => $originalLevel,
    'rev'       => (int) ($tenant['reports_access_rev'] ?? 1),
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
<title><?= esc($tenant['org_name']) ?> · Редактирование · LIFT·CS</title>
<link rel="stylesheet" href="<?= $v('css/platform.css') ?>">
<link rel="stylesheet" href="<?= $v('css/tenant-edit.css') ?>">
</head>
<body data-page="edit">

<div class="bg" aria-hidden="true">
  <div class="bg-base"></div><div class="bg-rails"></div><div class="bg-ticks"></div>
  <div class="bg-car"></div><div class="bg-car b"></div><div class="bg-grain"></div>
</div>

<header class="head">
  <a class="brand" href="/admin/tenants.php">
    <span class="mark">
      <svg viewBox="0 0 24 24" fill="none" stroke="url(#g2)" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
        <defs><linearGradient id="g2" x1="0" y1="0" x2="24" y2="24">
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

  <nav class="crumbs" aria-label="Навигация">
    <span class="sep">/</span>
    <a href="/admin/tenants.php" data-guard>Организации</a>
    <span class="sep">/</span>
    <span class="cur"><?= esc($tenant['subdomain']) ?></span>
  </nav>

  <div class="head-spacer"></div>

  <div class="head-meta">
    <a class="btn btn-ghost btn-sm" href="https://<?= esc($tenant['subdomain']) ?>.liftcs.ru" target="_blank" rel="noopener noreferrer">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6M15 3h6v6M10 14L21 3"/></svg>
      Открыть
    </a>
    <a href="/admin/tenants.php" class="btn btn-ghost btn-sm" data-guard>← К списку</a>
  </div>
</header>

<main class="wrap">

  <?php if ($error !== ''): ?>
    <div class="note note-d rise" role="alert">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16h.01"/></svg>
      <div><b>Сохранение не выполнено.</b><br><?= esc($error) ?></div>
    </div>
  <?php endif; ?>

  <form method="POST" id="editForm" novalidate>
    <input type="hidden" name="id" value="<?= (int) $id ?>">

    <div class="edit-grid">
      <div class="edit-main">

        <div class="rec-head rise" id="recHead" style="--hc:<?= esc($tierColor[$originalLevel] ?? '#22d3ee') ?>;animation-delay:.02s">
          <div class="eyebrow">Организация № <?= (int) $id ?></div>
          <h1><?= esc($tenant['org_name']) ?></h1>
          <div class="host">
            <?= esc($tenant['subdomain']) ?>.liftcs.ru
            <button type="button" class="copy" data-copy="<?= esc($tenant['subdomain']) ?>" title="Скопировать поддомен">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>
            </button>
          </div>
          <div class="tags">
            <span class="badge <?= !empty($tenant['is_active']) ? 'b-on' : 'b-off' ?>">
              <i class="lamp-s"></i><?= !empty($tenant['is_active']) ? 'Активен' : 'Отключён' ?>
            </span>
            <span class="badge <?= $original['legacy'] ? 'b-legacy' : 'b-modern' ?>"><?= $original['legacy'] ? 'Legacy' : 'Современный трек' ?></span>
            <span class="lvl-pill lv-<?= esc($originalLevel) ?>">
              <?= esc(admin_reports_level_label($originalLevel)) ?>
              <span class="rk">r<?= (int) admin_reports_level_rank($originalLevel) ?></span>
            </span>
            <span class="rev">rev <b><?= (int) $original['rev'] ?></b></span>
          </div>
        </div>

        <!-- 01 -->
        <section class="sect rise" style="animation-delay:.07s">
          <div class="sect-head">
            <span class="sect-n">01</span>
            <div class="sect-t">
              <h2>Идентификация</h2>
              <p>Поддомен определяет адрес тенанта и резолв по Host.</p>
            </div>
            <span class="sect-flag" id="subFlag">идентификатор</span>
          </div>
          <div class="sect-body">
            <div class="fg">
              <label for="subdomain">Поддомен<span class="req">*</span></label>
              <input type="text" id="subdomain" name="subdomain" class="inp mono"
                     value="<?= esc($form['subdomain']) ?>" required pattern="[a-z0-9-]+"
                     maxlength="63" autocomplete="off" spellcheck="false">
              <div class="host-preview" id="hostPreview"><?= esc($form['subdomain']) ?>.liftcs.ru</div>
              <div class="hint">Строчные латинские буквы, цифры и дефис. До 63 символов.</div>
            </div>

            <div class="note note-w" id="subWarn" hidden>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.3 3.9L1.8 18a2 2 0 001.7 3h17a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z"/><path d="M12 9v4M12 17h.01"/></svg>
              <div>Поддомен изменён. Старый адрес перестанет обслуживаться, пользователям потребуется войти заново. Новый адрес должен уже обслуживаться веб-сервером и DNS — запись в реестре сама по себе не создаёт vhost.</div>
            </div>

            <div class="fg">
              <label for="org_name">Название организации<span class="req">*</span></label>
              <input type="text" id="org_name" name="org_name" class="inp" value="<?= esc($form['org_name']) ?>" required autocomplete="off">
            </div>
          </div>
        </section>

        <!-- 02 -->
        <section class="sect rise" style="animation-delay:.12s">
          <div class="sect-head">
            <span class="sect-n">02</span>
            <div class="sect-t">
              <h2>Подключение к БД</h2>
              <p>Реквизиты базы тенанта. Пароль шифруется на сервере.</p>
            </div>
            <span class="sect-flag" id="passFlag">без изменений</span>
          </div>
          <div class="sect-body">
            <div class="frow">
              <div class="fg">
                <label for="db_host">Хост БД<span class="req">*</span></label>
                <input type="text" id="db_host" name="db_host" class="inp mono" value="<?= esc($form['db_host']) ?>" required autocomplete="off">
              </div>
              <div class="fg">
                <label for="db_port">Порт<span class="req">*</span></label>
                <input type="number" id="db_port" name="db_port" class="inp mono" value="<?= esc($form['db_port']) ?>" min="1" max="65535" required>
              </div>
            </div>

            <div class="fgrid">
              <div class="fg">
                <label for="db_name">Имя БД<span class="req">*</span></label>
                <input type="text" id="db_name" name="db_name" class="inp mono" value="<?= esc($form['db_name']) ?>" required autocomplete="off" spellcheck="false">
              </div>
              <div class="fg">
                <label for="db_user">Логин БД<span class="req">*</span></label>
                <input type="text" id="db_user" name="db_user" class="inp mono" value="<?= esc($form['db_user']) ?>" required autocomplete="off" spellcheck="false">
              </div>
            </div>

            <div class="fg">
              <label for="db_password">Пароль БД</label>
              <div class="inp-wrap">
                <input type="password" id="db_password" name="db_password" class="inp"
                       placeholder="Оставьте пустым, чтобы не менять" autocomplete="new-password">
                <button type="button" class="inp-act" id="pwToggle" aria-label="Показать пароль">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></svg>
                </button>
              </div>
              <div class="hint">Текущий пароль не отображается и не передаётся в браузер. Пустое поле — пароль остаётся прежним.</div>
            </div>

            <div class="note note-w" style="margin-bottom:0">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>
              <div>Реквизиты должны совпадать с пользователем MariaDB. Ошибка в пароле или имени базы лишит тенант подключения.</div>
            </div>
          </div>
        </section>

        <!-- 03 -->
        <section class="sect rise" style="animation-delay:.17s">
          <div class="sect-head">
            <span class="sect-n">03</span>
            <div class="sect-t">
              <h2>Уровень отчётов</h2>
              <p>Применяется ко всей организации, не зависит от ролей пользователей.</p>
            </div>
            <span class="rev">rev <b><?= (int) $original['rev'] ?></b></span>
          </div>
          <div class="sect-body">
            <div class="tiers" role="radiogroup" aria-label="Уровень отчётов">
              <?php foreach ($levels as $lv):
                  $m = $matrix[$lv];
                  $capCount = count($m['features']) + count($m['limits']['filter_groups']);
                  $maxCaps  = count(admin_reports_all_features()) + count(admin_reports_all_groups());
              ?>
                <label class="tier <?= $lv === $form['reports_level'] ? 'on' : '' ?>"
                       data-tier="<?= esc($lv) ?>" style="--tc:<?= esc($tierColor[$lv] ?? '#61758c') ?>">
                  <input type="radio" name="reports_level" value="<?= esc($lv) ?>" <?= $lv === $form['reports_level'] ? 'checked' : '' ?>>
                  <span class="tier-mark"></span>
                  <span class="tier-name"><?= esc(admin_reports_level_label($lv)) ?></span>
                  <span class="tier-rank">ранг <?= (int) $m['rank'] ?></span>
                  <span class="tier-lims">
                    <span class="tier-lim">Период <b><?= (int) $m['limits']['max_period_days'] ?> дн.</b></span>
                    <span class="tier-lim">Экспорт <b><?= (int) $m['limits']['max_rows'] ?></b></span>
                    <span class="tier-lim">Список <b><?= $m['list_cap'] === null ? '∞' : (int) $m['list_cap'] ?></b></span>
                  </span>
                  <span class="tier-caps" aria-hidden="true">
                    <?php for ($i = 0; $i < $maxCaps; $i++): ?><i class="<?= $i < $capCount ? 'on' : '' ?>"></i><?php endfor; ?>
                  </span>
                  <?php if ($lv === $originalLevel): ?><span class="tier-cur">текущий</span><?php endif; ?>
                </label>
              <?php endforeach; ?>
            </div>

            <div class="delta" id="levelDelta">
              <div class="delta-head">
                <span class="t">Что изменится</span>
                <span class="delta-arrow">
                  <span class="lvl-pill lv-<?= esc($originalLevel) ?>" id="deltaFrom"></span>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>
                  <span class="lvl-pill lv-<?= esc($form['reports_level']) ?>" id="deltaTo"></span>
                </span>
                <span class="badge b-modern" id="deltaTone">без изменений</span>
              </div>
              <div class="delta-cols">
                <div class="delta-col gain">
                  <h4>Станет доступно</h4>
                  <div class="delta-list" id="gainList"></div>
                </div>
                <div class="delta-col loss">
                  <h4>Станет недоступно</h4>
                  <div class="delta-list" id="lossList"></div>
                </div>
              </div>
              <div class="delta-lims" id="deltaLims"></div>
            </div>

            <div class="hint" style="margin-top:14px">
              Изменение вступает в силу в открытых вкладках автоматически в течение одного цикла опроса уведомлений;
              перелогин не требуется. Понижение уровня скрывает часть отчётов и выгрузок — данные не удаляются.
              Счётчик <code>reports_access_rev</code> увеличивается только при реальной смене уровня.
            </div>
          </div>
        </section>

        <!-- 04 -->
        <section class="sect rise" style="animation-delay:.22s">
          <div class="sect-head">
            <span class="sect-n">04</span>
            <div class="sect-t">
              <h2>Режим совместимости</h2>
              <p>Legacy-прокси для старых интеграций тенанта.</p>
            </div>
            <span class="sect-flag <?= $form['legacy_compat'] ? 'on' : '' ?>" id="legacyFlag"><?= $form['legacy_compat'] ? 'включён' : 'выключен' ?></span>
          </div>
          <div class="sect-body">
            <label class="switch">
              <input type="checkbox" name="legacy_compat" value="1" <?= $form['legacy_compat'] ? 'checked' : '' ?>>
              <span class="track"></span>
              <span class="sw-txt">
                <span class="sw-t">Legacy режим</span>
                <span class="sw-d">Влияет на работу уведомлений и прокси совместимости. К уровню отчётов отношения не имеет. Отключение переводит тенант на современный трек.</span>
              </span>
            </label>
          </div>
        </section>
      </div>

      <aside class="inspector">
        <div class="insp rise" style="animation-delay:.1s">
          <div class="insp-head">Состояние записи</div>
          <div class="insp-body">
            <dl class="mini">
              <dt>ID</dt><dd><?= (int) $id ?></dd>
              <dt>Создана</dt><dd><?= esc($tenant['created_at'] ?? '—') ?></dd>
              <dt>Статус</dt><dd><?= !empty($tenant['is_active']) ? 'активен' : 'отключён' ?></dd>
              <dt>Уровень</dt><dd><?= esc(admin_reports_level_label($originalLevel)) ?></dd>
              <dt>Ревизия</dt><dd><?= (int) $original['rev'] ?></dd>
            </dl>
            <div class="hint" style="margin-top:12px">Статус переключается отдельной кнопкой в реестре и здесь не меняется.</div>
          </div>
        </div>

        <div class="insp rise" style="animation-delay:.16s">
          <div class="insp-head">Изменения <span class="n" id="diffN">0</span></div>
          <div class="insp-body flush">
            <div class="diff-list" id="diffList"></div>
          </div>
        </div>

        <div class="insp rise" style="animation-delay:.22s">
          <div class="insp-head">Подсказка</div>
          <div class="insp-body">
            <div class="hint" style="margin:0">
              <b>Ctrl / ⌘ + S</b> — сохранить.<br>
              Несохранённые правки подсвечиваются янтарной рамкой и попадают в список выше.
              Кнопка «Сохранить» активна только при наличии изменений.
            </div>
          </div>
        </div>
      </aside>
    </div>
  </form>
</main>

<div class="foot">
  <div class="foot-state" id="footState">
    <span class="dot"></span>
    <span class="txt">Изменений:</span> <b id="footCount">0</b>
  </div>
  <div class="grow"></div>
  <button type="button" class="btn btn-ghost" id="resetBtn">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 109-9 9 9 0 00-6.4 2.6L3 8"/><path d="M3 3v5h5"/></svg>
    Сбросить
  </button>
  <a href="/admin/tenants.php" class="btn btn-ghost" data-guard>Отмена</a>
  <button type="submit" form="editForm" class="btn btn-primary" id="saveBtn" disabled>
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21H5a2 2 0 01-2-2V5a2 2 0 012-2h11l5 5v11a2 2 0 01-2 2z"/><path d="M17 21v-8H7v8M7 3v5h8"/></svg>
    Сохранить
  </button>
</div>

<script type="application/json" id="editOriginal"><?= json_encode($original, $jsonFlags) ?></script>
<script type="application/json" id="levelMatrix"><?= json_encode($matrix, $jsonFlags) ?></script>
<script type="application/json" id="levelMeta"><?= json_encode(admin_reports_meta(), $jsonFlags) ?></script>
<script src="<?= $v('js/platform.js') ?>" defer></script>
<script src="<?= $v('js/tenant-edit.js') ?>" defer></script>
</body>
</html>