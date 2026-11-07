<?php
declare(strict_types=1);

require_once __DIR__ . '/bootstrap.php';

use App\Tenant;
use App\Database\DB;
use App\Repository\{CallRepository, NoteRepository, HistoryRepository};
use App\Service\{
    CallService,
    LegacyProxyService,
    ConfigService,
    NotificationsService,
    AddressCacheService
};
use App\Support\SpultClassifier;
use App\Exceptions\ApiException;
use App\Http\ErrorCode;

try {
    // Только POST
    if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
        http_response_code(405);
        header('Allow: POST');
        exit('Method Not Allowed');
    }

    // Читаем XML
    $xmlRaw = trim(file_get_contents('php://input'));
    if (empty($xmlRaw)) {
        http_response_code(400);
        exit('Empty request body');
    }

    // Сохраняем XML для отладки
    $debugDir = __DIR__ . '/uploads/spult-xml';
    if (!is_dir($debugDir)) {
        @mkdir($debugDir, 0755, true);
    }
    @file_put_contents($debugDir . '/' . date('Y-m-d_H-i-s') . '.xml', $xmlRaw);

    // Парсинг
    libxml_use_internal_errors(true);
    $xml = simplexml_load_string($xmlRaw);
    if ($xml === false) {
        http_response_code(400);
        $errors = [];
        foreach (libxml_get_errors() as $error) {
            $errors[] = $error->message;
        }
        error_log('SPult XML parse error: ' . implode(', ', $errors));
        exit('Bad XML');
    }

    // Подключение к БД тенанта
    $tenant = Tenant::fromRequest();
    $db = DB::forTenant($tenant);

    // Настройки
    $parameters = [];
    $xmlParams = $db->fetchAll(
        "SELECT option_name, option_value FROM lift_options WHERE option_name IN ('city_default','city_separator','spult_organization_name','XML_add')"
    );
    foreach ($xmlParams as $p) {
        $parameters[$p['option_name']] = $p['option_value'];
    }

    // Проверка организации
    $pultName = (string) $xml['Name'];
    if ($pultName !== ($parameters['spult_organization_name'] ?? '')) {
        http_response_code(403);
        exit('Failed: Organization mismatch');
    }

    // Извлечение данных из XML
    $streetRaw = (string) ($xml->DISP->STREET['Name'] ?? '');
    $homeRaw = (string) ($xml->DISP->STREET->HOME['Name'] ?? '');
    $liftName = (string) ($xml->DISP->STREET->HOME->LIFT['Name'] ?? '');
    $spultId = (string) ($xml->DISP->STREET->HOME->LIFT['ID'] ?? '');
    $userSpult = (string) ($xml->DISP->STREET->HOME->LIFT['User'] ?? '');
    $note = (string) ($xml->DISP->STREET->HOME->LIFT['Note'] ?? '');

    // Собираем статусы
    $statuses = [];
    if (isset($xml->DISP->STREET->HOME->LIFT->ListStatus->Status)) {
        foreach ($xml->DISP->STREET->HOME->LIFT->ListStatus->Status as $status) {
            $statuses[] = (string) $status['Name'];
        }
    }
    $description = !empty($statuses) ? implode(', ', $statuses) : $note;

    // ========================================
    // Разрешение адреса (логика как в legacy xml.php)
    // ========================================
    $addressChanged = false;  // ← ИНИЦИАЛИЗАЦИЯ

    // Город (из настроек по умолчанию или из улицы через разделитель)
    $city = $parameters['city_default'] ?? 'г. Ростов-на-Дону';
    $street = $streetRaw;
    $pos = strpos($streetRaw, $parameters['city_separator'] ?? '#');
    if ($pos !== false) {
        $city = trim(substr($streetRaw, $pos + 1));
        $street = trim(substr($streetRaw, 0, $pos));
    }

    $fullAddress = "{$city}, {$street}, {$homeRaw}, {$liftName}";

    error_log(sprintf(
        'SPult ADDR: raw city="%s" street="%s" home="%s" lift="%s"',
        $city,
        $street,
        $homeRaw,
        $liftName
    ));

    // --- ГОРОД ---
    $cityNameClean = str_replace([' ', '.'], '', $city);
    $cityRow = $db->fetchOne(
        "SELECT id FROM lift_city WHERE REPLACE(REPLACE(city_name,' ',''),'.','') = ?",
        [$cityNameClean]
    );

    if (!$cityRow) {
        if (($parameters['XML_add'] ?? '0') === '1') {
            error_log("SPult ADDR: Creating city '$city'");
            $db->execute("INSERT INTO lift_city (city_name, vis) VALUES (?, 1)", [$city]);
            $cityRow = $db->fetchOne(
                "SELECT id FROM lift_city WHERE REPLACE(REPLACE(city_name,' ',''),'.','') = ?",
                [$cityNameClean]
            );
            $addressChanged = true;
        } else {
            error_log("SPult ADDR: City '$city' not found, XML_add disabled");
        }
    }
    $cityId = (int) ($cityRow['id'] ?? 0);
    error_log("SPult ADDR: city_id = $cityId");

    // --- УЛИЦА ---
    $streetNameClean = str_replace([' ', '.'], '', $street);
    $streetRow = $cityId ? $db->fetchOne(
        "SELECT id FROM lift_street WHERE REPLACE(REPLACE(street_name,' ',''),'.','') = ? AND city_id = ?",
        [$streetNameClean, $cityId]
    ) : null;

    if (!$streetRow && $cityId) {
        if (($parameters['XML_add'] ?? '0') === '1') {
            error_log("SPult ADDR: Creating street '$street' in city_id=$cityId");
            $db->execute(
                "INSERT INTO lift_street (street_name, city_id, vis) VALUES (?, ?, 1)",
                [$street, $cityId]
            );
            $streetRow = $db->fetchOne(
                "SELECT id FROM lift_street WHERE REPLACE(REPLACE(street_name,' ',''),'.','') = ? AND city_id = ?",
                [$streetNameClean, $cityId]
            );
            $addressChanged = true;
        } else {
            error_log("SPult ADDR: Street '$street' not found, XML_add disabled");
        }
    }
    $streetId = (int) ($streetRow['id'] ?? 0);
    error_log("SPult ADDR: street_id = $streetId");

    // --- ДОМ (нормализация как в legacy xml.php) ---
    $homeNormalized = str_replace('д.', '', $homeRaw);
    $homeNameClean = str_replace([' ', '.'], '', $homeNormalized);

    $homeRow = $streetId ? $db->fetchOne(
        "SELECT id FROM lift_home WHERE REPLACE(REPLACE(REPLACE(home_name,'д.',''),' ',''),'.','') = ? AND street_id = ?",
        [$homeNameClean, $streetId]
    ) : null;

    if (!$homeRow && $streetId) {
        if (($parameters['XML_add'] ?? '0') === '1') {
            error_log(sprintf(
                "SPult ADDR: Creating home '%s' (clean: '%s') on street_id=%d",
                $homeRaw,
                $homeNameClean,
                $streetId
            ));
            $db->execute(
                "INSERT INTO lift_home (home_name, street_id, vis) VALUES (?, ?, 1)",
                [$homeRaw, $streetId]
            );
            $homeRow = $db->fetchOne(
                "SELECT id FROM lift_home WHERE REPLACE(REPLACE(REPLACE(home_name,'д.',''),' ',''),'.','') = ? AND street_id = ?",
                [$homeNameClean, $streetId]
            );
            error_log(sprintf(
                "SPult ADDR: After INSERT homeRow = %s",
                $homeRow ? "id=" . $homeRow['id'] : "NULL"
            ));
            $addressChanged = true;
        } else {
            error_log("SPult ADDR: Home '$homeRaw' not found, XML_add disabled");
        }
    }
    $homeId = (int) ($homeRow['id'] ?? 0);
    error_log("SPult ADDR: home_id = $homeId");

    // --- ЛИФТ (нормализация как в legacy xml.php) ---
    $liftNameClean = str_replace([' ', '.'], '', $liftName);

    $liftRow = $homeId ? $db->fetchOne(
        "SELECT id FROM lift_object WHERE REPLACE(REPLACE(object_name,' ',''),'.','') = ? AND home_id = ?",
        [$liftNameClean, $homeId]
    ) : null;

    if (!$liftRow && $homeId) {
        if (($parameters['XML_add'] ?? '0') === '1') {
            error_log(sprintf(
                "SPult ADDR: Creating lift '%s' (spult_id=%s) in home_id=%d",
                $liftName,
                $spultId,
                $homeId
            ));
            $db->execute(
                "INSERT INTO lift_object (object_name, home_id, vis, abbreviated_name, group_id) 
                 VALUES (?, ?, 1, ?, 1)",
                [$liftName, $homeId, $spultId]
            );
            $liftRow = $db->fetchOne(
                "SELECT id FROM lift_object WHERE REPLACE(REPLACE(object_name,' ',''),'.','') = ? AND home_id = ?",
                [$liftNameClean, $homeId]
            );
            error_log(sprintf(
                "SPult ADDR: After INSERT liftRow = %s",
                $liftRow ? "id=" . $liftRow['id'] : "NULL"
            ));
            $addressChanged = true;
        } else {
            error_log("SPult ADDR: Lift '$liftName' not found, XML_add disabled");
        }
    }
    $liftId = (int) ($liftRow['id'] ?? 0);
    error_log("SPult ADDR: object_id = $liftId");

    // --- КЛАССИФИКАЦИЯ ---
    $classification = SpultClassifier::classify($note);

    // ========================================
    // Формируем данные для callnew() (НОВЫЙ ФОРМАТ API v4.0)
    // ========================================
    $callData = [
        'call_first_name' => 'SPult ' . ($userSpult ?: 'Auto'),
        'call_last_name' => '',
        'call_phone' => '',
        'call_email' => 'spult@auto.local',
        'department_id' => $classification['call_department'],
        'request_id' => $classification['call_request'],
        'group_id' => $classification['call_group'],
        'details' => $description,
        'fullAddress' => $fullAddress,
        'city_id' => $cityId,
        'street_id' => $streetId,
        'home_id' => $homeId,
        'object_id' => $liftId,
        'repair_time' => time() + ($classification['repair_days'] * 86400),
        'staff_id' => 0,
    ];

    // Системный пользователь
    $systemUser = [
        'id' => 1,
        'name' => 'SPult System',
        'role' => 'administrator',
    ];

    // === ИНВАЛИДАЦИЯ КЭША ДО создания заявки ===
    // Фронтенд поллит notifications endpoint каждые 120 сек,
    // и должен увидеть обновление версий справочников сразу
    $addressCache = new \App\Service\AddressCacheService($db);

    if ($addressChanged) {
        $addressCache->invalidateCache();
        error_log('SPult ADDR: Address cache invalidated (version incremented)');
    }

    // Создаём заявку через CallService (с NotificationsService и явным кэш-сервисом)
    $notificationsService = new \App\Service\NotificationsService($db);
    $configService = new \App\Service\ConfigService($db, $tenant);

    // 🌟 ИСПРАВЛЕНО: Сборка CallService приведена к общему паттерну Dependency Injection
    $callService = new CallService(
        new CallRepository($db),
        new NoteRepository($db),
        new HistoryRepository($db),
        new LegacyProxyService(\LEGACY_API_URL ?? '', \LEGACY_API_SECRET ?? ''),
        $configService,
        $notificationsService,
        $addressCache, // ← 🌟 Передаем седьмым аргументом для авто-синхронизации версий заявок
        $tenant
    );

    $result = $callService->callnew($systemUser, $callData);

    http_response_code(200);
    header('Content-Type: text/plain');
    echo "OK: " . ($result['message'] ?? 'Created');
} catch (ApiException $e) {
    $msg = $e->getMessage();

    // Проверяем, это дубликат?
    if (str_starts_with($msg, 'duplicate_detected:')) {
        $jsonPart = substr($msg, strlen('duplicate_detected:'));
        $duplicates = json_decode($jsonPart, true);

        if (!empty($duplicates) && isset($duplicates[0]['ticket_id'])) {
            $existingCallId = (int) $duplicates[0]['ticket_id'];

            // Добавляем комментарий к существующей заявке
            try {
                $noteRepo = new NoteRepository($db);
                $noteText = sprintf(
                    "[СПульт %s] %s\nСтатусы: %s\nАдрес: %s",
                    date('d.m.Y H:i'),
                    $userSpult ?: 'Дубликат',
                    'Дубликат - ' . $description,
                    $fullAddress
                );

                $noteRepo->add($existingCallId, 0, $noteText);

                error_log(sprintf(
                    'SPult DUPLICATE: Updated existing ticket #%d with note',
                    $existingCallId
                ));

                http_response_code(200);
                header('Content-Type: text/plain');
                echo "OK: Updated existing ticket #{$existingCallId}";
                exit;
            } catch (Throwable $noteError) {
                error_log('SPult DUPLICATE NOTE ERROR: ' . $noteError->getMessage());
                // Если не удалось добавить комментарий — возвращаем оригинальную ошибку
            }
        }
    }

    // Обычная ошибка
    error_log('SPult ApiException: ' . $msg);
    http_response_code(400);
    exit('Error: ' . $msg);
} catch (Throwable $e) {
    error_log('SPult Fatal: ' . $e->getMessage() . ' at ' . $e->getFile() . ':' . $e->getLine());
    http_response_code(500);
    exit('Internal server error');
}