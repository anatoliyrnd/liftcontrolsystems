<?php
declare(strict_types=1);
define('APP_ENTRY_POINT', true);
require_once __DIR__ . '/bootstrap.php';

use App\Tenant;
use App\Database\DB;
use App\Repository\{CallRepository, NoteRepository, HistoryRepository, SpultEventRepository};
use App\Service\{CallService, LegacyProxyService, ConfigService, NotificationsService, AddressCacheService};
use App\Support\{SpultClassifier, AdminAlert};
use App\Exceptions\ApiException;

/**
 * Приём сигналов пульта СПульт.
 *
 * ЖЁСТКИЙ ИНВАРИАНТ: непустое тело → всегда HTTP 200.
 * Пульт не разбирает ответ и НЕ ретраит: любой другой код попадает в его
 * журнал как «сервер отказал», сигнал теряется навсегда. Диспетчер в этот
 * момент может не смотреть в журнал — спросить не у кого.
 *
 * Вместо отказа — деградация:
 *   - короткое описание дополняется префиксом, а не отклоняется;
 *   - дубликат → заметка в существующую заявку;
 *   - неразрешимые данные → quarantine/, системный сбой → failed/;
 *   - сырой XML сохраняется ДО разбора и никогда не перезаписывается.
 *
 * Приоритет объекта: GUID → адрес. Привязка GUID только при пустом поле
 * либо в INSERT нового объекта; чужая привязка не перезаписывается.
 */

// ---------------------------------------------------------------------------
// Спул
// ---------------------------------------------------------------------------

/** Корень вне web-root: в XML ФИО операторов и адреса. */
function spult_spool_root(): string
{
    $root = dirname(__DIR__) . '/_spult';
    if (!is_dir($root)) {
        @mkdir($root, 0750, true);
    }
    if (is_dir($root) && is_writable($root)) {
        return $root;
    }

    // Фолбэк внутри web-root: публичный файл лучше потерянного сигнала.
    // Требует deny-правила в .htaccess.
    $fallback = __DIR__ . '/uploads/spult-xml';
    if (!is_dir($fallback)) {
        @mkdir($fallback, 0750, true);
    }
    if (is_dir($fallback) && is_writable($fallback)) {
        error_log('SPult SPOOL WARNING: root unavailable, web-root fallback: ' . $fallback);
        return $fallback;
    }

    return '';
}

/**
 * Сохранить сырой сигнал в incoming/ до любого разбора.
 * Имя уникальное: прежний date('Y-m-d_H-i-s') давал коллизию — два
 * сигнала в одну секунду затирали друг друга.
 */
function spult_store(string $xml): ?string
{
    $root = spult_spool_root();
    if ($root === '') {
        error_log('SPult SPOOL CRITICAL: no writable dir, raw_b64=' . base64_encode($xml));
        return null;
    }

    $dir = $root . '/incoming';
    if (!is_dir($dir)) {
        @mkdir($dir, 0750, true);
    }

    $path = $dir . '/' . date('Ymd_His') . '_' . uniqid() . '_' . mt_rand(1000, 9999) . '.xml';

    if (@file_put_contents($path, $xml) === false) {
        error_log('SPult SPOOL CRITICAL: write failed, raw_b64=' . base64_encode($xml));
        return null;
    }

    return $path;
}

/**
 * Переложить сигнал в итоговую корзину, вернуть относительный путь.
 * failed — вина сервера, quarantine — вина данных, processed — обработан.
 * Автоповторов нет: разбор вручную через админ-панель.
 */
function spult_settle(?string $file, string $bucket, string $reason, array $meta): ?string
{
    if ($file === null || !is_file($file)) {
        return null;
    }

    $dir = dirname($file, 2) . '/' . $bucket;
    if (!is_dir($dir)) {
        @mkdir($dir, 0750, true);
    }

    $target = $dir . '/' . basename($file);
    if (!@rename($file, $target)) {
        error_log('SPult SPOOL WARNING: move failed ' . $file . ' -> ' . $bucket);
        return null;
    }

    if ($reason !== '') {
        @file_put_contents(
            $target . '.meta.json',
            (string) json_encode(
                ['reason' => $reason, 'at' => date('c')] + $meta,
                JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE
            )
        );
    }

    return $bucket . '/' . basename($file);
}

/** Единственная точка ответа пульту. Тело тоже с OK: «Error:» выглядело бы отказом. */
function spult_ok(string $text): never
{
    http_response_code(200);
    header('Content-Type: text/plain; charset=utf-8');
    echo $text;
    exit;
}

// ---------------------------------------------------------------------------
// Диагностика: журнал + письмо + лента
// ---------------------------------------------------------------------------

/** Нормализация для словаря статусов и сравнения адресов. */
function spult_norm(string $s): string
{
    $s = trim($s);
    // /u на битой кодировке вернёт null — оставляем исходную строку.
    $s = preg_replace('/\s+/u', ' ', $s) ?? $s;
    return mb_strtolower($s, 'UTF-8');
}

function spult_mail_event(string $kind): string
{
    return match ($kind) {
        'guid_mismatch' => 'spult_guid_mismatch',
        'guid_conflict' => 'spult_guid_conflict',
        default         => 'spult_signal_lost',
    };
}

/**
 * Разослать накопленные расхождения по трём каналам.
 * Каждый канал изолирован: сбой одного не отменяет остальные и не роняет приём.
 */
function spult_flush(array $st): void
{
    foreach ($st['diag'] as $d) {
        $kind = (string) $d['kind'];
        $msg  = (string) $d['message'];

        // История заявки — только когда заявка есть и расхождение того требует.
        if (!empty($d['history']) && $st['ticket'] !== null && $st['history'] !== null) {
            try {
                $st['history']->add((int) $st['ticket'], '[SPult:' . $kind . '] ' . $msg, 1, 'online');
            } catch (\Throwable $e) {
                error_log('SPult HISTORY failed: ' . $e->getMessage());
            }
        }

        if ($st['events'] !== null) {
            $st['events']->record(
                $kind,
                message:    $msg,
                liftId:     $st['lift_id'],
                ticketId:   $st['ticket'],
                guid:       $st['guid'],
                spultId:    $st['spult_id'],
                xmlAddress: $st['xml_addr'],
                dbAddress:  $st['db_addr'],
                spoolFile:  $st['spool_rel'],
                meta:       $st['meta']
            );
        }

        if (SpultEventRepository::shouldAlertAdmin($kind)) {
            AdminAlert::notify(
                spult_mail_event($kind),
                $msg,
                ['reason' => $kind, 'address' => $st['xml_addr'], 'ticket_id' => $st['ticket']] + $st['meta'],
                $st['db'],
                $st['tenant']
            );
        }

        if ($st['notify'] !== null) {
            $st['notify']->spultError($kind, $msg, $st['ticket']);
        }
    }
}

/** Завершить приём: разослать диагностику, разложить спул, ответить 200. */
function spult_finish(array $st, string $bucket, string $okText, ?string $kind = null, string $message = ''): never
{
    if ($kind !== null) {
        $st['diag'][] = ['kind' => $kind, 'message' => $message, 'history' => false];
    }

    $st['spool_rel'] = spult_settle($st['spool'], $bucket, $kind ?? '', $st['meta']);
    spult_flush($st);
    spult_ok($okText);
}

// ---------------------------------------------------------------------------
// Приём
// ---------------------------------------------------------------------------

// Не-POST — не сигнал (мониторинг, probe), терять нечего.
if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    http_response_code(405);
    header('Allow: POST');
    exit('Method Not Allowed');
}

$xmlRaw = trim((string) @file_get_contents('php://input'));

// Пустое тело — сигнала нет.
if ($xmlRaw === '') {
    http_response_code(400);
    exit('Empty request body');
}

// Всё состояние — в одном массиве, инициализировано ДО try.
// Обращение к неопределённой переменной дало бы Warning, а set_error_handler
// из bootstrap превратил бы его в ErrorException — фатал внутри catch.
$st = [
    'spool'     => null,
    'spool_rel' => null,
    'db'        => null,
    'tenant'    => '',
    'events'    => null,
    'notify'    => null,
    'history'   => null,
    'lift_id'   => null,
    'guid'      => null,
    'spult_id'  => null,
    'xml_addr'  => '',
    'db_addr'   => '',
    'ticket'    => null,
    'diag'      => [],
    'meta'      => [],
];

try {
    // Спул ПЕРВЫМ действием: даже если дальше упадёт разбор, тенант или БД —
    // сигнал уже на диске и восстановим.
    $st['spool'] = spult_store($xmlRaw);

    // Конфиг. require, не require_once: повторный вернул бы true вместо массива.
    // Отсутствие файла не должно давать фатал — работаем на дефолтах.
    $cfg = [
        'verify_pult_guid'   => false,
        'description_prefix' => 'Создана из SPult',
        'status_exclude'     => [],
    ];
    $cfgFile = __DIR__ . '/config/spult.php';
    if (is_file($cfgFile)) {
        $loaded = require $cfgFile;
        if (is_array($loaded)) {
            $cfg = array_merge($cfg, $loaded);
        }
    } else {
        error_log('SPult CONFIG: config/spult.php missing, defaults in use');
    }

    libxml_use_internal_errors(true);
    $xml = simplexml_load_string($xmlRaw);
    if ($xml === false) {
        $errors = [];
        foreach (libxml_get_errors() as $error) {
            $errors[] = trim($error->message);
        }
        error_log('SPult XML parse error: ' . implode(', ', $errors));
        $st['meta']['errors'] = $errors;
        spult_finish($st, 'quarantine', 'OK: accepted', 'bad_xml', 'XML не распарсился, сигнал сохранён в карантин');
    }

    $tenant = Tenant::fromRequest();
    $st['tenant'] = $tenant->id;
    $db = DB::forTenant($tenant);
    $st['db'] = $db;

    $callRepo     = new CallRepository($db);
    $noteRepo     = new NoteRepository($db);
    $historyRepo  = new HistoryRepository($db);
    $st['events']  = new SpultEventRepository($db);
    $st['notify']  = new NotificationsService($db);
    $st['history'] = $historyRepo;

    $parameters = [];
    foreach ($db->fetchAll(
        "SELECT option_name, option_value FROM lift_options
         WHERE option_name IN ('city_default','city_separator','spult_organization_name','XML_add','spult_pult_guid')"
    ) as $p) {
        $parameters[$p['option_name']] = $p['option_value'];
    }

    // --- Проверка организации ---
    $pultName = (string) $xml['Name'];
    if ($pultName !== ($parameters['spult_organization_name'] ?? '')) {
        // Не 403: при опечатке в настройке пульт получил бы отказ на каждый сигнал.
        $st['meta']['got'] = $pultName;
        $st['meta']['expected'] = $parameters['spult_organization_name'] ?? '';
        spult_finish(
            $st, 'quarantine', 'OK: accepted', 'org_mismatch',
            'Сигнал отклонён: имя организации не совпало с настройкой («' . $pultName . '»)'
        );
    }

    // --- Опциональная проверка GUID пульта ---
    if (!empty($cfg['verify_pult_guid'])) {
        $expectedPult = CallRepository::normalizeGuid($parameters['spult_pult_guid'] ?? null);
        if ($expectedPult === null) {
            // Включили флаг, но значение не задано — проверять нечем.
            // Карантинить весь поток нельзя.
            error_log('SPult PULT GUID: check enabled but spult_pult_guid empty, skipped');
        } else {
            $actualPult = CallRepository::normalizeGuid((string) ($xml['GUID'] ?? ''));
            if ($actualPult !== $expectedPult) {
                $st['meta']['pult_guid_got'] = (string) ($xml['GUID'] ?? '');
                $st['meta']['pult_guid_expected'] = $expectedPult;
                spult_finish(
                    $st, 'quarantine', 'OK: accepted', 'pult_guid_mismatch',
                    'Сигнал отклонён: GUID пульта не совпал с ожидаемым'
                );
            }
        }
    }

    // --- Данные сигнала ---
    $liftNode  = $xml->DISP->STREET->HOME->LIFT;
    $streetRaw = (string) ($xml->DISP->STREET['Name'] ?? '');
    $homeRaw   = (string) ($xml->DISP->STREET->HOME['Name'] ?? '');
    $liftName  = (string) ($liftNode['Name'] ?? '');
    $spultId   = CallRepository::normalizeSpultId((string) ($liftNode['ID'] ?? ''));
    $userSpult = (string) ($liftNode['User'] ?? '');
    $note      = (string) ($liftNode['Note'] ?? '');
    $st['spult_id'] = $spultId;

    $statuses = [];
    if (isset($liftNode->ListStatus->Status)) {
        foreach ($liftNode->ListStatus->Status as $status) {
            $statuses[] = (string) $status['Name'];
        }
    }

    // --- GUID лифта: первичный ключ поиска ---
    $guidRaw = (string) ($liftNode['GUID'] ?? '');
    $guid = CallRepository::normalizeGuid($guidRaw);
    $st['guid'] = $guid;
    if ($guid === null && trim($guidRaw) !== '') {
        error_log('SPult GUID: invalid format "' . $guidRaw . '", address path in use');
        $st['meta']['guid_raw'] = mb_substr($guidRaw, 0, 64);
    }

    // --- Город/улица из XML: нужны для адреса и для сравнения ---
    $city   = $parameters['city_default'] ?? 'г. Ростов-на-Дону';
    $street = $streetRaw;
    $pos = strpos($streetRaw, $parameters['city_separator'] ?? '#');
    if ($pos !== false) {
        $city   = trim(substr($streetRaw, $pos + 1));
        $street = trim(substr($streetRaw, 0, $pos));
    }
    $xmlAddress = "{$city}, {$street}, {$homeRaw}, {$liftName}";
    $st['xml_addr'] = $xmlAddress;

    $addressChanged = false;
    $cityId = $streetId = $homeId = $liftId = 0;
    $dbAddress = $xmlAddress;

    $byGuid = $guid !== null ? $callRepo->findObjectByGuid($guid) : null;

    if ($byGuid !== null) {
        // GUID найден — адрес из XML не резолвим вообще. Переименование
        // улицы или лифта в пульте больше не отправляет сигнал в карантин.
        $liftId    = $byGuid['object_id'];
        $homeId    = $byGuid['home_id'];
        $streetId  = $byGuid['street_id'];
        $cityId    = $byGuid['city_id'];
        $dbAddress = $byGuid['full_address'];

        error_log('SPult GUID: matched object_id=' . $liftId);

        if (spult_norm($xmlAddress) !== spult_norm($dbAddress)) {
            $st['diag'][] = [
                'kind'    => 'guid_mismatch',
                'message' => 'Адрес в сигнале отличается от справочника. Пульт: ' . $xmlAddress
                             . '. В базе: ' . $dbAddress . '. Заявка создана на объект по GUID.',
                'history' => true,
            ];
        }

        // spult_id дозаполняем, существующий не меняем.
        if (($byGuid['spult_id'] ?? null) === null || $byGuid['spult_id'] === '') {
            $callRepo->fillSpultId($liftId, $spultId);
        } elseif ($spultId !== null && (string) $byGuid['spult_id'] !== $spultId) {
            $st['diag'][] = [
                'kind'    => 'spult_id_conflict',
                'message' => 'LIFT@ID отличается от сохранённого: пульт ' . $spultId
                             . ', в базе ' . $byGuid['spult_id'] . '. Значение не изменено.',
                'history' => false,
            ];
        }
    } else {
        // --- Адресный путь (логика legacy xml.php) ---
        $allowAdd = (($parameters['XML_add'] ?? '0') === '1');

        // ГОРОД
        $cityClean = str_replace([' ', '.'], '', $city);
        $cityRow = $db->fetchOne(
            "SELECT id FROM lift_city WHERE REPLACE(REPLACE(city_name,' ',''),'.','') = ?",
            [$cityClean]
        );
        if (!$cityRow && $allowAdd) {
            $db->execute("INSERT INTO lift_city (city_name, vis) VALUES (?, 1)", [$city]);
            $cityRow = $db->fetchOne(
                "SELECT id FROM lift_city WHERE REPLACE(REPLACE(city_name,' ',''),'.','') = ?",
                [$cityClean]
            );
            $addressChanged = true;
        }
        $cityId = (int) ($cityRow['id'] ?? 0);

        // УЛИЦА
        $streetClean = str_replace([' ', '.'], '', $street);
        $streetRow = $cityId ? $db->fetchOne(
            "SELECT id FROM lift_street WHERE REPLACE(REPLACE(street_name,' ',''),'.','') = ? AND city_id = ?",
            [$streetClean, $cityId]
        ) : null;
        if (!$streetRow && $cityId && $allowAdd) {
            $db->execute("INSERT INTO lift_street (street_name, city_id, vis) VALUES (?, ?, 1)", [$street, $cityId]);
            $streetRow = $db->fetchOne(
                "SELECT id FROM lift_street WHERE REPLACE(REPLACE(street_name,' ',''),'.','') = ? AND city_id = ?",
                [$streetClean, $cityId]
            );
            $addressChanged = true;
        }
        $streetId = (int) ($streetRow['id'] ?? 0);

        // ДОМ
        $homeClean = str_replace([' ', '.'], '', str_replace('д.', '', $homeRaw));
        $homeRow = $streetId ? $db->fetchOne(
            "SELECT id FROM lift_home WHERE REPLACE(REPLACE(REPLACE(home_name,'д.',''),' ',''),'.','') = ? AND street_id = ?",
            [$homeClean, $streetId]
        ) : null;
        if (!$homeRow && $streetId && $allowAdd) {
            $db->execute("INSERT INTO lift_home (home_name, street_id, vis) VALUES (?, ?, 1)", [$homeRaw, $streetId]);
            $homeRow = $db->fetchOne(
                "SELECT id FROM lift_home WHERE REPLACE(REPLACE(REPLACE(home_name,'д.',''),' ',''),'.','') = ? AND street_id = ?",
                [$homeClean, $streetId]
            );
            $addressChanged = true;
        }
        $homeId = (int) ($homeRow['id'] ?? 0);

        // ЛИФТ
        $liftClean = str_replace([' ', '.'], '', $liftName);
        $liftRow = $homeId ? $db->fetchOne(
            "SELECT id FROM lift_object WHERE REPLACE(REPLACE(object_name,' ',''),'.','') = ? AND home_id = ?",
            [$liftClean, $homeId]
        ) : null;

        if (!$liftRow && $homeId && $allowAdd) {
            // GUID и spult_id — сразу в INSERT, не отдельным UPDATE: иначе
            // между операциями второй сигнал не найдёт GUID и создаст дубль.
            // abbreviated_name не передаём: у колонки есть DEFAULT, а числовой
            // тип давал отказ на нечисловом LIFT@ID.
            try {
                $db->execute(
                    "INSERT INTO lift_object (object_name, home_id, vis, group_id, guid, spult_id)
                     VALUES (?, ?, 1, 1, ?, ?)",
                    [$liftName, $homeId, $guid, $spultId]
                );
                $liftRow = $db->fetchOne(
                    "SELECT id FROM lift_object WHERE REPLACE(REPLACE(object_name,' ',''),'.','') = ? AND home_id = ?",
                    [$liftClean, $homeId]
                );
                $addressChanged = true;
            } catch (\Throwable $e) {
                // UNIQUE(guid): GUID успел привязаться к другому объекту.
                // Не падаем — ниже перечитаем по GUID и создадим на владельца.
                error_log('SPult ADDR: object insert failed, will retry by GUID — ' . $e->getMessage());
            }
        }
        $liftId = (int) ($liftRow['id'] ?? 0);

        // Гонка при создании: GUID занят — берём владельца.
        if ($liftId === 0 && $guid !== null) {
            $retry = $callRepo->findObjectByGuid($guid);
            if ($retry !== null) {
                $liftId = $retry['object_id'];
                $homeId = $retry['home_id'];
                $streetId = $retry['street_id'];
                $cityId = $retry['city_id'];
                $dbAddress = $retry['full_address'];
            }
        }

        if ($liftId > 0) {
            $obj = $callRepo->findObjectById($liftId);
            $dbAddress = $xmlAddress;   // адрес собран из XML, объект найден по нему

            // Привязка GUID: только если поле пустое.
            if ($guid !== null) {
                $bind = $callRepo->bindSpultGuid($liftId, $guid, $spultId);

                if ($bind['status'] === 'conflict') {
                    $st['diag'][] = [
                        'kind'    => 'guid_conflict',
                        'message' => 'У объекта уже другой GUID (' . $bind['existing_guid']
                                     . '), привязка не изменена. Сигнал: ' . $xmlAddress,
                        'history' => true,
                    ];
                } elseif (in_array($bind['status'], ['guid_taken', 'lost_race'], true)) {
                    // GUID принадлежит другому объекту — по правилу приоритета
                    // создаём заявку на него.
                    $holder = $callRepo->findObjectByGuid($guid);
                    if ($holder !== null) {
                        $liftId = $holder['object_id'];
                        $homeId = $holder['home_id'];
                        $streetId = $holder['street_id'];
                        $cityId = $holder['city_id'];
                        $dbAddress = $holder['full_address'];
                        $st['diag'][] = [
                            'kind'    => 'guid_mismatch',
                            'message' => 'GUID привязан к другому объекту, заявка создана на него. Пульт: '
                                         . $xmlAddress . '. В базе: ' . $dbAddress,
                            'history' => true,
                        ];
                    }
                }
            } elseif ($spultId !== null) {
                $callRepo->fillSpultId($liftId, $spultId);
            }

            // spult_id отличается — только журнал, без письма.
            if ($obj && $spultId !== null && ($obj['spult_id'] ?? null) !== null
                && (string) $obj['spult_id'] !== '' && (string) $obj['spult_id'] !== $spultId) {
                $st['diag'][] = [
                    'kind'    => 'spult_id_conflict',
                    'message' => 'LIFT@ID отличается от сохранённого: пульт ' . $spultId
                                 . ', в базе ' . $obj['spult_id'] . '. Значение не изменено.',
                    'history' => false,
                ];
            }
        }
    }

    $st['lift_id'] = $liftId > 0 ? $liftId : null;
    $st['db_addr'] = $dbAddress;

    // Адрес не собран — заявку создать нельзя (FK на объект).
    // Не 400: сигнал уходит в карантин и будет разобран.
    if ($cityId === 0 || $streetId === 0 || $homeId === 0 || $liftId === 0) {
        $st['meta'] += [
            'city_id' => $cityId, 'street_id' => $streetId,
            'home_id' => $homeId, 'object_id' => $liftId,
            'xml_add' => $parameters['XML_add'] ?? '0',
        ];
        spult_finish(
            $st, 'quarantine', 'OK: accepted', 'address_unresolved',
            'Сигнал не обработан: адрес не распознан — ' . $xmlAddress
        );
    }

    // --- Классификация (по Note, как раньше) ---
    $classification = SpultClassifier::classify($note);

    // --- Описание: фильтр статусов + обязательный префикс ---
    $exclude = array_map('spult_norm', (array) $cfg['status_exclude']);
    $kept = [];
    $dropped = [];
    foreach ($statuses as $s) {
        $s = trim($s);
        if ($s === '') {
            continue;
        }
        if (in_array(spult_norm($s), $exclude, true)) {
            $dropped[] = $s;
        } else {
            $kept[] = $s;
        }
    }

    $body = $kept !== [] ? implode(', ', $kept) : trim($note);
    $prefix = trim((string) $cfg['description_prefix']);
    if ($prefix === '') {
        $prefix = 'Создана из SPult';   // страховка от пустого описания
    }
    $description = $body !== '' ? $prefix . '. ' . $body : $prefix;

    if ($dropped !== []) {
        $st['diag'][] = [
            'kind'    => 'info_status',
            'message' => 'Информационные статусы пульта (не включены в описание): ' . implode(', ', $dropped),
            'history' => true,
        ];
    }

    $st['meta']['statuses'] = $statuses;
    $st['meta']['classification'] = $classification;

    // --- Создание заявки ---
    $callData = [
        'call_first_name' => 'SPult ' . ($userSpult !== '' ? $userSpult : 'Auto'),
        'call_last_name'  => '',
        'call_phone'      => '',
        'call_email'      => 'spult@auto.local',
        'department_id'   => $classification['call_department'],
        'request_id'      => $classification['call_request'],
        'group_id'        => $classification['call_group'],
        'details'         => $description,
        'fullAddress'     => $dbAddress,
        'city_id'         => $cityId,
        'street_id'       => $streetId,
        'home_id'         => $homeId,
        'object_id'       => $liftId,
        'repair_time'     => time() + ($classification['repair_days'] * 86400),
        'staff_id'        => 0,
        'alert_level'     => $classification['alert_level'],
    ];

    $systemUser = ['id' => 1, 'name' => 'SPult System', 'role' => 'administrator'];

    $addressCache = new AddressCacheService($db);
    if ($addressChanged) {
        // Инкремент только при изменении справочника. Одна привязка GUID
        // не меняет то, что видит фронт, — версия не нужна.
        $addressCache->invalidateCache();
        error_log('SPult ADDR: address cache version incremented');
    }

    $callService = new CallService(
        $callRepo,
        $noteRepo,
        $historyRepo,
        new LegacyProxyService(\LEGACY_API_URL ?? '', \LEGACY_API_SECRET ?? ''),
        new ConfigService($db, $tenant),
        $st['notify'],
        $addressCache,
        $tenant
    );

    $result = $callService->callnew($systemUser, $callData);
    $st['ticket'] = (int) ($result['call_id'] ?? 0) ?: null;

    spult_finish(
        $st, 'processed',
        'OK: ' . ($result['message'] ?? 'Created') . ($st['ticket'] ? ' #' . $st['ticket'] : '')
    );

} catch (ApiException $e) {
    $reason  = $e->reason ?? '';
    $message = $e->getMessage();
    $details = $e->details;

    // Дубликат определяем по reason. Разбор префикса — переходная мера,
    // работает и со старым CallService.
    $legacyPrefix = 'duplicate_detected:';
    $isDuplicate = $reason === 'duplicate_detected' || str_starts_with($message, $legacyPrefix);

    if ($isDuplicate) {
        $duplicates = $details['existing_tickets'] ?? [];
        if (!is_array($duplicates) || $duplicates === []) {
            $decoded = json_decode(substr($message, strlen($legacyPrefix)), true);
            $duplicates = is_array($decoded) ? $decoded : [];
        }

        $existingId = (int) ($duplicates[0]['ticket_id'] ?? 0);

        if ($existingId > 0 && $st['db'] !== null) {
            try {
                $noteText = sprintf(
                    "[СПульт %s] %s\nСтатусы: %s\nАдрес: %s",
                    date('d.m.Y H:i'),
                    $st['meta']['user'] ?? 'Дубликат',
                    implode(', ', (array) ($st['meta']['statuses'] ?? [])),
                    $st['xml_addr']
                );
                (new NoteRepository($st['db']))->add($existingId, 0, $noteText);

                error_log('SPult DUPLICATE: note added to ticket #' . $existingId);
                $st['ticket'] = $existingId;
                spult_finish($st, 'processed', 'OK: Updated existing ticket #' . $existingId);
            } catch (\Throwable $noteError) {
                // Заметка не легла (БД моргнула) — вина сервера, сигнал сохраняем.
                error_log('SPult DUPLICATE NOTE ERROR: ' . $noteError->getMessage());
                $st['ticket'] = $existingId;
                spult_finish(
                    $st, 'failed', 'OK: accepted', 'duplicate_note_failed',
                    'Дубликат заявки №' . $existingId . ', заметка не записана: ' . $noteError->getMessage()
                    . '. Адрес: ' . $st['xml_addr']
                );
            }
        }

        // Список пуст — привязать не к чему. CallService бросает дубликат
        // только с непустым списком, значит это внутреннее расхождение.
        spult_finish(
            $st, 'quarantine', 'OK: accepted', 'fatal',
            'Дубликат без целевой заявки, сигнал сохранён. Адрес: ' . $st['xml_addr']
        );
    }

    // Адрес не разрешился JOIN'ом — семантика та же, что у пре-проверки.
    if ($reason === 'object_not_found') {
        spult_finish(
            $st, 'quarantine', 'OK: accepted', 'address_unresolved',
            'Сигнал не обработан: объект не найден в справочнике — ' . $st['xml_addr']
        );
    }

    // Прочие бизнес-ошибки (категория справочника и т.п.) — данные требуют правки.
    spult_finish(
        $st, 'quarantine', 'OK: accepted', 'fatal',
        'Сигнал не обработан (' . ($reason !== '' ? $reason : 'api_error') . '): ' . $message
        . '. Адрес: ' . $st['xml_addr']
    );

} catch (Throwable $e) {
    // Системный сбой: БД, тенант, фатал. Вина сервера → failed/.
    error_log('SPult FAILED: ' . $e->getMessage() . ' at ' . $e->getFile() . ':' . $e->getLine());
    $st['meta']['exception'] = $e->getMessage();
    $st['meta']['at'] = $e->getFile() . ':' . $e->getLine();
    spult_finish(
        $st, 'failed', 'OK: accepted', 'fatal',
        'Системный сбой приёма сигнала: ' . $e->getMessage() . '. Адрес: ' . $st['xml_addr']
    );
}