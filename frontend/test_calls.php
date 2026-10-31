<?php
sleep(2); // Заставляем сервер спать 20 секунд
error_reporting(E_ALL);
ini_set('display_errors', 1);

// ============================================================
// БЛОК ОТЛАДКИ (с защитой от переполнения)
// ============================================================
$debugLog = __DIR__ . '/debug_log.txt';
$incoming = file_get_contents('php://input');

// Если лог существует и весит больше 2 Мегабайт — очищаем его
if (file_exists($debugLog) && filesize($debugLog) > 2 * 1024 * 1024) {
    file_put_contents($debugLog, "");
}
// Записываем запрос
file_put_contents($debugLog, date('Y-m-d H:i:s') . " ВХОДЯЩИЙ ЗАПРОС:\n" . $incoming . "\n-------------------\n", FILE_APPEND);


// ============================================================
// ФУНКЦИЯ КОНВЕРТАЦИИ ДАТ В UNIX TIMESTAMP
// ============================================================
function convertDatesToUnix(&$data)
{
    // Только массивы, объекты игнорируем, чтобы не ломать структуру
    if (!is_array($data))
        return;

    // Жестко задаем поля, где точно лежат даты (и не трогаем текст в истории)
    static $dateKeys = [
    'date',
    'close_date',
    'repair_time',
    'notify_date',
    'notify_date2',
    'notify_date3'
    ];

    foreach ($data as $key => &$value) {
        if (is_array($value)) {
            convertDatesToUnix($value); // Рекурсия для вложенных массивов (например, note)
        } elseif (is_string($value) && in_array($key, $dateKeys, true)) {
            // Приводим форматы к стандартному: 
            // 22/10/2026 14:07 -> 22.10.2026 14:07
            // 22.10.2026@14:08 -> 22.10.2026 14:08
            $normalized = str_replace(['/', '@'], ['.', ' '], $value);
            $timestamp = strtotime($normalized);

            if ($timestamp !== false && $timestamp > 0) {
                $value = $timestamp; // Заменяем строку на целое число (Unix time)
            }
        }
    }
}

// ============================================================
// НАСТРОЙКИ CORS
// ============================================================
header('Access-Control-Allow-Origin: http://lift.local');
header('Access-Control-Allow-Credentials: true');
header('Access-Control-Allow-Methods: POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type, Authorization');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(200);
    exit;
}

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    echo json_encode(['status' => 'error', 'code' => 'method_not_allowed', 'message' => 'Только POST']);
    exit;
}

$rawBody = file_get_contents('php://input');
$input = json_decode($rawBody, true);

// ============================================================
// 0. НОВЫЕ ЗАГЛУШКИ
// ============================================================
if (isset($input['data']) && $input['data'] === 'check_org_key') {
    $key = $input['org_key'] ?? '';
    if ($key === '1234') {
        echo json_encode(['status' => 'ok', 'message' => 'Ключ действителен']);
    } else {
        echo json_encode(['status' => 'error', 'code' => 'invalid_key', 'message' => 'Неверный ключ организации']);
    }
    exit;
}

if (isset($input['data']) && $input['data'] === 'get_org_users') {
    echo json_encode([
        'status' => 'ok',
        'users' => [
            ['user_id' => 1, 'name' => 'Администратор'],
            ['user_id' => 2, 'name' => 'Диспетчер Петрова'],
            ['user_id' => 3, 'name' => 'Сергеенко Сергей'],
            ['user_id' => 4, 'name' => 'Тест Истечения'],
            ['user_id' => 5, 'name' => 'Заблокированный']
        ]
    ]);
    exit;
}

// ============================================================
// 1. ЗАГЛУШКА: Адреса
// ============================================================
if (isset($input['data']) && $input['data'] === 'loadAddress') {
    $jsonFile = __DIR__ . '/address.json';
    if (file_exists($jsonFile)) {
        header('Content-Type: application/json; charset=utf-8');
        echo file_get_contents($jsonFile);
        exit;
    }
}

// ============================================================
// 2. ЗАГЛУШКА: Личный кабинет
// ============================================================
$profileFile = __DIR__ . '/mock_profile.json';

if (isset($input['data']) && $input['data'] === 'get_user_settings') {
    $defaultProfile = [
        "status" => "ok",
        "profile" => [
            "id" => 1,
            "surname" => "Иванов",
            "name" => "Иван",
            "patronymic" => "Иванович",
            "role" => "administrator"
        ],
        "column_settings" => [
            "order" => ["id", "address", "details", "staff_name", "notify_status", "department", "date", "repair_time"],
            "hidden" => ["solution", "close_name", "close_date"]
        ]
    ];

    if (file_exists($profileFile)) {
        header('Content-Type: application/json; charset=utf-8');
        echo file_get_contents($profileFile);
    } else {
        file_put_contents($profileFile, json_encode($defaultProfile, JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT));
        header('Content-Type: application/json; charset=utf-8');
        echo json_encode($defaultProfile, JSON_UNESCAPED_UNICODE);
    }
    exit;
}

if (isset($input['action']) && $input['action'] === 'save_user_settings') {
    file_put_contents($profileFile, json_encode($input, JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT));
    echo json_encode(['status' => 'ok', 'message' => 'Mock: Настройки профиля и таблицы сохранены.']);
    exit;
}

// ============================================================
// 3. ЗАГЛУШКИ ДЛЯ ЗАЯВОК (Только запись)
// ============================================================
$mockFile = __DIR__ . '/mock_tickets.json';

function getMockTickets($file)
{
    if (!file_exists($file))
        return [];
    $data = json_decode(file_get_contents($file), true);
    return is_array($data) ? $data : [];
}

function saveMockTicket($file, $ticketData, $authorName = null)
{
    $existing = getMockTickets($file);

    $ticketData['id'] = rand(100000, 999999);
    $ticketData['type'] = 'open';
    $ticketData['date'] = time();
    $ticketData['alert_level'] = 1;
    $ticketData['address'] = $ticketData['fullAddress'] ?? '—';
    $ticketData['staff_name'] = $ticketData['staff_id'] ? 'Механик ' . $ticketData['staff_id'] : null;
    $ticketData['department'] = 'Mock Отдел';
    $ticketData['request'] = 'Mock Запрос';
    $ticketData['group'] = 'Mock Группа';
    $ticketData['solution'] = '—';
    $ticketData['close_name'] = '—';
    $ticketData['close_date'] = null;
    $ticketData['note_num'] = 0;
    $ticketData['note'] = [];

    if ($authorName) {
        $ticketData['details'] .= "\n\n[Создано офлайн: " . $authorName . "]";
    }

    unset($ticketData['offline_uuid'], $ticketData['offline_author_id'], $ticketData['offline_author_name']);

    $existing[] = $ticketData;
    file_put_contents($file, json_encode($existing, JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT));
}

if (isset($input['action']) && $input['action'] === 'callnew') {
    saveMockTicket($mockFile, $input);
    echo json_encode(['status' => 'ok', 'message' => 'Mock: Заявка создана', 'generated_id' => rand(100000, 999999)]);
    exit;
}

if (isset($input['action']) && $input['action'] === 'callNewOffline') {
    $tickets = $input['tickets'] ?? [];
    foreach ($tickets as $ticket) {
        $authorName = $ticket['offline_author_name'] ?? null;
        saveMockTicket($mockFile, $ticket, $authorName);
    }
    echo json_encode(['status' => 'ok', 'message' => 'Mock: Пачка синхронизирована']);
    exit;
}

if (isset($input['action']) && in_array($input['action'], ['calledit', 'callClose', 'callnote'])) {
    echo json_encode(['status' => 'ok', 'message' => 'Mock: Действие ' . $input['action'] . ' выполнено']);
    exit;
}

// ============================================================
// 4. ЧТЕНИЕ ОТКРЫТЫХ ЗАЯВОК
// ============================================================
if (isset($input['data']) && $input['data'] === 'open') {
    $realTickets = [];

    if (function_exists('curl_init')) {
        $ch = curl_init('https://sh.e-rcs.ru/test_calls.php');
        curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
        curl_setopt($ch, CURLOPT_POST, true);
        curl_setopt($ch, CURLOPT_POSTFIELDS, $rawBody);

        $forwardHeaders = ['Content-Type: application/json'];
        $authHeader = $_SERVER['HTTP_AUTHORIZATION'] ?? '';
        if (!empty($authHeader)) {
            $forwardHeaders[] = 'Authorization: ' . $authHeader;
        }
        curl_setopt($ch, CURLOPT_HTTPHEADER, $forwardHeaders);
        curl_setopt($ch, CURLOPT_TIMEOUT, 5);
        curl_setopt($ch, CURLOPT_SSL_VERIFYPEER, false);
        $realResponse = curl_exec($ch);
        curl_close($ch);

        $decoded = json_decode($realResponse, true);

        if (is_array($decoded)) {
            convertDatesToUnix($decoded);
            if (empty($decoded) || isset($decoded[0])) {
                $realTickets = $decoded;
            }
        }
    }

    $mockTickets = getMockTickets($mockFile);

    header('Content-Type: application/json; charset=utf-8');
    echo json_encode(array_merge($mockTickets, $realTickets), JSON_UNESCAPED_UNICODE);
    exit;
}

// ============================================================
// 5. ЗАГЛУШКА: Поллинг уведомлений
// ============================================================
if (isset($input['data']) && $input['data'] === 'notifications') {
    echo json_encode([
        'notifications' => [],
        'last_id' => (int) ($input['since_id'] ?? 0),
        'versions' => ['staff' => 0, 'dicts' => 0],
        'outdated' => []
    ]);
    exit;
}

// ============================================================
// 6. ПРОКСИ ДЛЯ ВСЕГО ОСТАЛЬНОГО
// ============================================================
$targetUrl = 'https://sh.e-rcs.ru/test_calls.php';
$forwardHeaders = ['Content-Type: application/json'];

$authHeader = $_SERVER['HTTP_AUTHORIZATION'] ?? '';
if (!empty($authHeader)) {
    $forwardHeaders[] = 'Authorization: ' . $authHeader;
}

$ch = curl_init($targetUrl);
curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
curl_setopt($ch, CURLOPT_POST, true);
curl_setopt($ch, CURLOPT_POSTFIELDS, $rawBody);
curl_setopt($ch, CURLOPT_HTTPHEADER, $forwardHeaders);
curl_setopt($ch, CURLOPT_TIMEOUT, 15);
curl_setopt($ch, CURLOPT_SSL_VERIFYPEER, false);

$response = curl_exec($ch);
$httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
$curlError = curl_error($ch);
curl_close($ch);

if ($curlError) {
    http_response_code(502);
    echo json_encode(['status' => 'error', 'code' => 'proxy_network_error', 'message' => 'Ошибка прокси: ' . $curlError]);
} else {
    // Логируем ответ сервера
    file_put_contents($debugLog, "ОТВЕТ ОТ СЕРВЕРА:\n" . $response . "\n===================\n", FILE_APPEND);

    if (trim($response) === '') {
        http_response_code($httpCode);
        header('Content-Type: application/json; charset=utf-8');
        echo json_encode([], JSON_UNESCAPED_UNICODE);
        exit;
    }

    $decodedResponse = json_decode($response, true);

    if (json_last_error() === JSON_ERROR_NONE) {
        if (is_array($decodedResponse)) {
            convertDatesToUnix($decodedResponse);
        }

        // Отдаем фронтенду числа без экранирования слэшей
        $encoded = json_encode($decodedResponse, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE);

        if ($encoded === false) {
            $encoded = $response;
        }

        http_response_code($httpCode);
        header('Content-Type: application/json; charset=utf-8');
        echo $encoded;
    } else {
        http_response_code($httpCode);
        header('Content-Type: application/json; charset=utf-8');
        echo $response;
    }
}