<?php
/**
 * auth-stub.php — заглушка авторизации для разработки SPA.
 *
 * ⚠️ Все ответы — HTTP 200. Код ошибки в теле JSON (`code`).
 * Причина: Nginx в OpenServer перехватывает 4xx/5xx от PHP и заменяет
 * на свою HTML-страницу. Чтобы этого избежать — только 200.
 */

header('Content-Type: application/json; charset=utf-8');

// ============================================================
// CORS
// ============================================================
$allowed_origins = [
    'http://localhost:3000',
    'http://localhost:5173',
    'http://localhost:8080',
    'http://127.0.0.1:5500',
    'https://sh.e-rcs.ru',
    'http://lift.local',
    'https://lift.local',
];

$origin = $_SERVER['HTTP_ORIGIN'] ?? '';
if (in_array($origin, $allowed_origins, true)) {
    header("Access-Control-Allow-Origin: $origin");
    header('Access-Control-Allow-Credentials: true');
    header('Access-Control-Allow-Methods: POST, OPTIONS');
    header('Access-Control-Allow-Headers: Content-Type, Authorization');
    header('Vary: Origin');
}

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(200);
    exit;
}

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    echo json_encode(['status' => 'error', 'code' => 'method_not_allowed', 'message' => 'Только POST']);
    exit;
}

// ============================================================
// Константы
// ============================================================
const STORAGE_FILE = __DIR__ . '/lift-auth-stub.json';
const ACCESS_TTL = 7200;
const REFRESH_TTL = 2592000;
const SHORT_TTL = 5;
const REFRESH_COOKIE = 'lift_refresh';
const COOKIE_SECURE = false;

const TEST_USERS = [
    'admin' => ['id' => 1, 'password' => 'admin', 'name' => 'Администратор', 'role' => 'administrator', 'blocked' => false, 'short_ttl' => false],
    'disp' => ['id' => 2, 'password' => 'disp', 'name' => 'Диспетчер Петрова', 'role' => 'dispatcher', 'blocked' => false, 'short_ttl' => false],
    'eng' => ['id' => 3, 'password' => 'eng', 'name' => 'Сергеенко Сергей', 'role' => 'engineer', 'blocked' => false, 'short_ttl' => false],
    'expired' => ['id' => 4, 'password' => 'expired', 'name' => 'Тест Истечения', 'role' => 'dispatcher', 'blocked' => false, 'short_ttl' => true],
    'blocked' => ['id' => 5, 'password' => 'blocked', 'name' => 'Заблокированный', 'role' => 'dispatcher', 'blocked' => true, 'short_ttl' => false],
];

// ============================================================
// Хелперы
// ============================================================
function readStorage(): array
{
    if (!file_exists(STORAGE_FILE))
        return ['refresh' => [], 'access' => []];
    $data = json_decode(file_get_contents(STORAGE_FILE), true);
    if (!is_array($data))
        return ['refresh' => [], 'access' => []];
    return $data + ['refresh' => [], 'access' => []];
}
function writeStorage(array $data): void
{
    file_put_contents(STORAGE_FILE, json_encode($data, JSON_PRETTY_PRINT), LOCK_EX);
}
function genToken(): string
{
    return bin2hex(random_bytes(32));
}
function hashToken(string $t): string
{
    return hash('sha256', $t);
}

/** Ответ с ошибкой — всегда HTTP 200, код в теле. */
function fail(string $code, string $message = ''): void
{
    echo json_encode(['status' => 'error', 'code' => $code, 'message' => $message ?: $code]);
    exit;
}
function ok(array $payload): void
{
    echo json_encode(['status' => 'ok'] + $payload);
    exit;
}
function readJsonBody(): array
{
    $raw = file_get_contents('php://input');
    if (!$raw)
        return [];
    $d = json_decode($raw, true);
    return is_array($d) ? $d : [];
}
function getBearerToken(): ?string
{
    $h = $_SERVER['HTTP_AUTHORIZATION'] ?? '';
    if (preg_match('/^Bearer\s+(.+)$/i', $h, $m))
        return trim($m[1]);
    return null;
}
function getRefreshCookie(): ?string
{
    return $_COOKIE[REFRESH_COOKIE] ?? null;
}

function setRefreshCookie(string $token, bool $persistent): void
{
    setcookie(REFRESH_COOKIE, $token, [
        'expires' => $persistent ? time() + REFRESH_TTL : 0,
        'path' => '/',
        'secure' => COOKIE_SECURE,
        'httponly' => true,
        'samesite' => 'Strict',
    ]);
}
function clearRefreshCookie(): void
{
    setcookie(REFRESH_COOKIE, '', [
        'expires' => time() - 3600,
        'path' => '/',
        'secure' => COOKIE_SECURE,
        'httponly' => true,
        'samesite' => 'Strict',
    ]);
}
function cleanupExpired(array &$storage): void
{
    $now = time();
    foreach ($storage['refresh'] as $h => $i)
        if ($i['expires_at'] <= $now)
            unset($storage['refresh'][$h]);
    foreach ($storage['access'] as $u => $i)
        if ($i['expires_at'] <= $now)
            unset($storage['access'][$u]);
}
function isWeakFingerprint(string $fp): bool
{
    return str_starts_with($fp, 'basic:') || $fp === 'no-webgl' || $fp === 'webgl-error';
}
function fingerprintMatches(string $old, string $new): bool
{
    if ($old === $new)
        return true;
    if (isWeakFingerprint($old) || isWeakFingerprint($new))
        return true;
    if (str_starts_with($old, 'full:') && str_starts_with($new, 'full:')) {
        $len = max(strlen($old), strlen($new));
        if ($len > 0 && levenshtein($old, $new) / $len < 0.2)
            return true;
    }
    return false;
}
function findAccess(array $storage, string $token): ?array
{
    foreach ($storage['access'] as $info)
        if (hash_equals($info['token'], $token))
            return $info;
    return null;
}
function findUserById(int $id): ?array
{
    foreach (TEST_USERS as $u)
        if ($u['id'] === $id)
            return $u;
    return null;
}

// ============================================================
// Роутинг
// ============================================================
$action = $_GET['action'] ?? '';
$body = readJsonBody();
$storage = readStorage();
cleanupExpired($storage);

switch ($action) {

    case 'login': {
        $userId = isset($body['user_id']) ? (int) $body['user_id'] : null;
        $login = trim((string) ($body['name'] ?? ''));
        $password = (string) ($body['pname'] ?? '');
        $webgl = (string) ($body['webGL'] ?? '');
        $autoLogin = (bool) ($body['autoLogin'] ?? false);

        if ($webgl === '')
            fail('invalid_input', 'Не удалось определить устройство');

        $user = null;
        if ($userId !== null) {
            // Логин по ID из списка организации
            $user = findUserById($userId);
            if (!$user)
                fail('invalid_credentials', 'Пользователь не найден');
        } else {
            // Обычный логин
            if ($login === '' || $password === '')
                fail('invalid_input', 'Логин и пароль обязательны');
            $user = TEST_USERS[$login] ?? null;
            if (!$user || $user['password'] !== $password)
                fail('invalid_credentials', 'Неверное имя или пароль');
        }

        if ($user['blocked'])
            fail('user_blocked', 'Учётная запись заблокирована');

        foreach ($storage['refresh'] as $info) {
            if ($info['user_id'] === $user['id']) {
                if (!fingerprintMatches($info['device_fingerprint'], $webgl)) {
                    fail('device_mismatch', 'Устройство не совпадает с предыдущим');
                }
                break;
            }
        }

        $accessToken = genToken();
        $refreshToken = genToken();
        $accessTtl = $user['short_ttl'] ? SHORT_TTL : ACCESS_TTL;
        $now = time();

        $storage['access'][$user['id']] = [
            'token' => $accessToken,
            'expires_at' => $now + $accessTtl,
            'user_id' => $user['id'],
            'user_name' => $user['name'],
            'role' => $user['role'],
            'webgl_info' => $webgl,
        ];
        $storage['refresh'][hashToken($refreshToken)] = [
            'user_id' => $user['id'],
            'device_fingerprint' => $webgl,
            'expires_at' => $now + REFRESH_TTL,
            'created_at' => $now,
            'last_used_at' => null,
        ];
        writeStorage($storage);
        setRefreshCookie($refreshToken, $autoLogin);

        ok([
            'access_token' => $accessToken,
            'expires_at' => $now + $accessTtl,
            'user' => ['id' => $user['id'], 'name' => $user['name'], 'role' => $user['role']],
        ]);
    }

    case 'refresh': {
        $refreshToken = getRefreshCookie();
        if (!$refreshToken)
            fail('missing_token', 'Сессия не найдена');

        $hash = hashToken($refreshToken);
        $info = $storage['refresh'][$hash] ?? null;
        if (!$info) {
            clearRefreshCookie();
            fail('token_invalid', 'Сессия недействительна');
        }
        if ($info['expires_at'] <= time()) {
            unset($storage['refresh'][$hash]);
            writeStorage($storage);
            clearRefreshCookie();
            fail('token_expired', 'Сессия истекла, войдите заново');
        }

        $user = findUserById($info['user_id']);
        if (!$user || $user['blocked'])
            fail('user_blocked', 'Учётная запись заблокирована');

        $accessToken = genToken();
        $now = time();
        $accessTtl = $user['short_ttl'] ? SHORT_TTL : ACCESS_TTL;

        $storage['access'][$user['id']] = [
            'token' => $accessToken,
            'expires_at' => $now + $accessTtl,
            'user_id' => $user['id'],
            'user_name' => $user['name'],
            'role' => $user['role'],
            'webgl_info' => $info['device_fingerprint'],
        ];
        $storage['refresh'][$hash]['last_used_at'] = $now;
        writeStorage($storage);

        ok([
            'access_token' => $accessToken,
            'expires_at' => $now + $accessTtl,
            'user' => ['id' => $user['id'], 'name' => $user['name'], 'role' => $user['role']],
        ]);
    }

    case 'logout': {
        $refreshToken = getRefreshCookie();
        if ($refreshToken)
            unset($storage['refresh'][hashToken($refreshToken)]);
        $accessToken = getBearerToken();
        if ($accessToken) {
            foreach ($storage['access'] as $uid => $info) {
                if (hash_equals($info['token'], $accessToken)) {
                    unset($storage['access'][$uid]);
                    break;
                }
            }
        }
        writeStorage($storage);
        clearRefreshCookie();
        ok(['message' => 'Вы вышли из системы']);
    }

    case 'validate': {
        $token = getBearerToken();
        if (!$token)
            fail('missing_token', 'Требуется авторизация');
        $found = findAccess($storage, $token);
        if (!$found)
            fail('token_invalid', 'Токен недействителен');
        if ($found['expires_at'] <= time())
            fail('token_expired', 'Токен истёк');
        ok([
            'expires_at' => $found['expires_at'],
            'user' => ['id' => $found['user_id'], 'name' => $found['user_name'], 'role' => $found['role']],
        ]);
    }

    case 'mock_test_calls': {
        $token = getBearerToken();
        if (!$token)
            fail('missing_token', 'Требуется авторизация');
        $found = findAccess($storage, $token);
        if (!$found)
            fail('token_invalid', 'Токен недействителен');
        if ($found['expires_at'] <= time())
            fail('token_expired', 'Токен истёк');
        ok(['message' => 'OK — токен валиден', 'user_id' => $found['user_id'], 'role' => $found['role']]);
    }

    default:
        fail('invalid_input', 'Неизвестное действие: ' . $action);
}