<?php
declare(strict_types=1);

require_once __DIR__ . '/bootstrap.php';

use App\Tenant;
use App\Database\DB;
use App\Repository\{CallRepository, NoteRepository, HistoryRepository};
use App\Service\{CallService, LegacyProxyService, ConfigService};
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

    // Город
    $city = $parameters['city_default'] ?? 'г. Ростов-на-Дону';
    $street = $streetRaw;
    $pos = strpos($streetRaw, $parameters['city_separator'] ?? '#');
    if ($pos !== false) {
        $city = trim(substr($streetRaw, $pos + 1));
        $street = trim(substr($streetRaw, 0, $pos));
    }

    // Формируем полный адрес
    $fullAddress = "{$city}, {$street}, {$homeRaw}, {$liftName}";

    // Разрешение адреса
    $cityNameClean = str_replace([' ', '.'], '', $city);
    $cityRow = $db->fetchOne(
        "SELECT id FROM lift_city WHERE REPLACE(REPLACE(city_name,' ',''),'.','') = ?",
        [$cityNameClean]
    );

    if (!$cityRow && ($parameters['XML_add'] ?? '0') === '1') {
        $db->execute("INSERT INTO lift_city (city_name, vis) VALUES (?, 1)", [$city]);
        $cityRow = $db->fetchOne(
            "SELECT id FROM lift_city WHERE REPLACE(REPLACE(city_name,' ',''),'.','') = ?",
            [$cityNameClean]
        );
    }
    $cityId = (int) ($cityRow['id'] ?? 0);

    $streetNameClean = str_replace([' ', '.'], '', $street);
    $streetRow = $cityId ? $db->fetchOne(
        "SELECT id FROM lift_street WHERE REPLACE(REPLACE(street_name,' ',''),'.','') = ? AND city_id = ?",
        [$streetNameClean, $cityId]
    ) : null;

    if (!$streetRow && $cityId && ($parameters['XML_add'] ?? '0') === '1') {
        $db->execute(
            "INSERT INTO lift_street (street_name, city_id, timestamp, vis) VALUES (?, ?, CURRENT_TIMESTAMP, 1)",
            [$street, $cityId]
        );
        $streetRow = $db->fetchOne(
            "SELECT id FROM lift_street WHERE REPLACE(REPLACE(street_name,' ',''),'.','') = ? AND city_id = ?",
            [$streetNameClean, $cityId]
        );
    }
    $streetId = (int) ($streetRow['id'] ?? 0);

    $homeClean = str_replace([' ', '.', 'д', 'д.'], '', $homeRaw);
    $homeRow = $streetId ? $db->fetchOne(
        "SELECT id FROM lift_home WHERE REPLACE(REPLACE(home_name,' ',''),'.','') = ? AND street_id = ?",
        [$homeClean, $streetId]
    ) : null;

    if (!$homeRow && $streetId && ($parameters['XML_add'] ?? '0') === '1') {
        $db->execute(
            "INSERT INTO lift_home (home_name, street_id, timestamp, vis) VALUES (?, ?, CURRENT_TIMESTAMP, 1)",
            [$homeRaw, $streetId]
        );
        $homeRow = $db->fetchOne(
            "SELECT id FROM lift_home WHERE REPLACE(REPLACE(home_name,' ',''),'.','') = ? AND street_id = ?",
            [$homeClean, $streetId]
        );
    }
    $homeId = (int) ($homeRow['id'] ?? 0);

    $liftNameClean = str_replace([' ', '.'], '', $liftName);
    $liftRow = $homeId ? $db->fetchOne(
        "SELECT id FROM lift_object WHERE REPLACE(REPLACE(object_name,' ',''),'.','') = ? AND home_id = ?",
        [$liftNameClean, $homeId]
    ) : null;

    if (!$liftRow && $homeId && ($parameters['XML_add'] ?? '0') === '1') {
        $db->execute(
            "INSERT INTO lift_object (object_name, home_id, timestamp, vis, abbreviated_name, group_id) VALUES (?, ?, CURRENT_TIMESTAMP, 1, ?, 1)",
            [$liftName, $homeId, $spultId]
        );
        $liftRow = $db->fetchOne(
            "SELECT id FROM lift_object WHERE REPLACE(REPLACE(object_name,' ',''),'.','') = ? AND home_id = ?",
            [$liftNameClean, $homeId]
        );
    }
    $liftId = (int) ($liftRow['id'] ?? 0);

    // Классификация
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

    // Создаём заявку через CallService
    $callService = new CallService(
        new CallRepository($db),
        new NoteRepository($db),
        new HistoryRepository($db),
        new LegacyProxyService(\LEGACY_API_URL ?? '', \LEGACY_API_SECRET ?? ''),
        new ConfigService($db),
        $tenant
    );

    $result = $callService->callnew($systemUser, $callData);

    http_response_code(200);
    header('Content-Type: text/plain');
    echo "OK: " . ($result['message'] ?? 'Created');

} catch (ApiException $e) {
    error_log('SPult ApiException: ' . $e->getMessage());
    http_response_code(400);
    exit('Error: ' . $e->getMessage());
} catch (Throwable $e) {
    error_log('SPult Fatal: ' . $e->getMessage() . ' at ' . $e->getFile() . ':' . $e->getLine());
    http_response_code(500);
    exit('Internal server error');
}