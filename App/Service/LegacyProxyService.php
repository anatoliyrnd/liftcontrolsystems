<?php
declare(strict_types=1);
namespace App\Service;

use App\Support\Logger;
use RuntimeException;

final class LegacyProxyService
{
    /**
     * Действия, которые меняют состояние (write).
     * Для них таймаут длиннее, чем для чтения.
     */
    private const WRITE_ACTIONS = [
        'callnew',
        'calledit',
        'callclose',
        'callnote',
    ];

    public function __construct(
        private readonly string $legacyUrl,
        private readonly string $secret
    ) {
        if ($this->secret === '' || $this->legacyUrl === '') {
            throw new RuntimeException('Legacy API URL и Secret должны быть настроены');
        }
    }

    public function send(string $action, array $data, int $userId): array
    {
        $legacyAction = $this->mapAction($action);
        $payload = $this->preparePayload($legacyAction, $action, $data);

        $isWrite = in_array(strtolower($action), self::WRITE_ACTIONS, true);
        $timeoutMs = $isWrite ? 10000 : 5000;
        $connectTimeoutMs = 2000;

        // Сериализация ДО создания cURL — fail fast
        try {
            $jsonPayload = json_encode(
                $payload,
                JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR
            );
        } catch (\JsonException $e) {
            Logger::error('LegacyProxy: Ошибка сериализации payload', [
                'action' => $legacyAction,
                'user_id' => $userId,
                'error' => $e->getMessage(),
                'payload_keys' => array_keys($payload),   // только ключи, не значения
            ]);
            return $this->errorResponse('Ошибка подготовки данных для отправки');
        }

        Logger::info('LegacyProxy: Отправка запроса', [
            'action' => $legacyAction,
            'user_id' => $userId,
            'fields' => array_keys($payload),
            'is_write' => $isWrite,
            'timeout_ms' => $timeoutMs,
        ]);

        $ch = curl_init($this->legacyUrl);
        if ($ch === false) {
            Logger::error('LegacyProxy: Не удалось инициализировать cURL');
            return $this->errorResponse('Ошибка инициализации клиента');
        }

        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_POST => true,
            CURLOPT_POSTFIELDS => $jsonPayload,   // ← гарантированно строка
            CURLOPT_HTTPHEADER => [
                'Content-Type: application/json',
                'Accept: application/json',
                'X-Legacy-Secret: ' . $this->secret,
                'X-Legacy-User-Id: ' . $userId,
            ],
            CURLOPT_CONNECTTIMEOUT_MS => $connectTimeoutMs,
            CURLOPT_TIMEOUT_MS => $timeoutMs,
            CURLOPT_NOSIGNAL => true,
            CURLOPT_SSL_VERIFYPEER => true,
            CURLOPT_SSL_VERIFYHOST => 2,
        ]);
        $response = curl_exec($ch);
        $errno = curl_errno($ch);
        $error = curl_error($ch);
        $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
        $totalTime = curl_getinfo($ch, CURLINFO_TOTAL_TIME);
        curl_close($ch);

        if ($errno !== 0) {
            Logger::error('LegacyProxy: Ошибка cURL', [
                'errno' => $errno,
                'error' => $error,
                'action' => $legacyAction,
                'total_time' => $totalTime,
            ]);
            return $this->errorResponse('Ошибка связи с сервером: ' . $error);
        }

        // Логируем медленные ответы — сигнал, что legacy «подвисает»
        if ($totalTime > 5.0) {
            Logger::warning('LegacyProxy: медленный ответ', [
                'action' => $legacyAction,
                'total_time' => $totalTime,
                'http' => $httpCode,
            ]);
        }

        if ($httpCode < 200 || $httpCode >= 300) {
            Logger::error('LegacyProxy: HTTP ошибка от шлюза', [
                'http' => $httpCode,
                'action' => $legacyAction,
                'total_time' => $totalTime,
                'response_preview' => is_string($response) ? mb_substr($response, 0, 500) : null,
            ]);
            return $this->errorResponse('Ошибка сервера обработки заявок');
        }

        $decoded = json_decode($response, true);
        if (json_last_error() !== JSON_ERROR_NONE || !is_array($decoded)) {
            Logger::error('LegacyProxy: Некорректный JSON', [
                'action' => $legacyAction,
                'response_preview' => mb_substr((string) $response, 0, 500),
            ]);
            return $this->errorResponse('Некорректный формат ответа сервера');
        }

        return $decoded;
    }

    /**
     * Маппинг action нового API → action legacy.
     * Сейчас identity; оставлен как задел на будущее,
     * если понадобится переименование (например, calls.create → callnew).
     */
    private function mapAction(string $action): string
    {
        return match (strtolower($action)) {
            'callclose' => 'callclose',
            'calledit' => 'calledit',
            'callnote' => 'callnote',
            'callnew' => 'callnew',
            default => strtolower($action),
        };
    }

    private function preparePayload(string $legacyAction, string $originalAction, array $data): array
    {
        $payload = array_merge(['action' => $legacyAction], $data);

        $actionLower = strtolower($originalAction);

        // --- ЗАКРЫТИЕ ЗАЯВКИ ---
        if ($actionLower === 'callclose' && isset($payload['solution'])) {
            $payload['call_close'] = $payload['solution'];
            unset($payload['solution']);
        }

        // --- РЕДАКТИРОВАНИЕ ЗАЯВКИ ---
        if ($actionLower === 'calledit') {
            // 1. Статус уведомления: notify_status → staff_status
            if (isset($payload['notify_status'])) {
                $payload['staff_status'] = (int) $payload['notify_status'];
                unset($payload['notify_status']);
            }
            if (isset($payload['notify_status2'])) {
                $payload['staff_status2'] = (int) $payload['notify_status2'];
                unset($payload['notify_status2']);
            }
            if (isset($payload['notify_status3'])) {
                $payload['staff_status3'] = (int) $payload['notify_status3'];
                unset($payload['notify_status3']);
            }

            // 2. Unix-время ремонта → ID (0-9), который понимает legacy
            if (isset($payload['repair_time'])) {
                $targetTime = (int) $payload['repair_time'];
                $payload['repair_time_id'] = $this->mapRepairTimeToId($targetTime);
                unset($payload['repair_time']);
            }
        }

        // --- СОЗДАНИЕ ЗАЯВКИ ---
        if ($actionLower === 'callnew') {
            // ID-шники → формат legacy
            $idMap = [
                'city_id' => 'city',
                'street_id' => 'street',
                'home_id' => 'home',
                'object_id' => 'object',
                'group_id' => 'group',
                'request_id' => 'request',
                'department_id' => 'department',
                'staff_id' => 'staff',
            ];
            foreach ($idMap as $newKey => $legacyKey) {
                if (isset($payload[$newKey])) {
                    $payload[$legacyKey] = $payload[$newKey];
                    unset($payload[$newKey]);
                }
            }

            // Legacy ждёт "fullAdress" (с одной 'd')
            if (isset($payload['fullAddress'])) {
                $payload['fullAdress'] = $payload['fullAddress'];
                unset($payload['fullAddress']);
            }

            // Legacy в callnew ждёт ID срока ремонта (0-9), а не Unix-время
            if (isset($payload['repair_time'])) {
                $targetTime = (int) $payload['repair_time'];
                $payload['repair_time'] = $this->mapRepairTimeToId($targetTime);
            }
        }

        return $payload;
    }

    /**
     * Находит ближайший ID срока ремонта из старой системы.
     * Пресеты соответствуют старому main.php (со сдвигом на текущее время).
     */
    private function mapRepairTimeToId(int $targetTime): int
    {
        if ($targetTime === 0) {
            return 0;
        }

        $now = time();
        $presets = [
            1 => $now + 1800,                     // 30 мин
            2 => strtotime("today 23:00"),        // Сегодня
            3 => strtotime("today +1day 23:00"),  // Завтра
            4 => strtotime("today +3day 23:00"),  // Три дня
            5 => strtotime("today +7day"),        // 7 дней
            6 => strtotime("today +10day"),       // 10 дней
            7 => strtotime("today +15day"),       // 15 дней
            8 => strtotime("today +1month"),      // 1 месяц
            9 => strtotime("today +3month"),      // 3 месяца
        ];

        $closestId = 1;
        $minDiff = PHP_INT_MAX;

        foreach ($presets as $id => $time) {
            $diff = abs($time - $targetTime);
            if ($diff < $minDiff) {
                $minDiff = $diff;
                $closestId = $id;
            }
        }

        return $closestId;
    }

    private function errorResponse(string $message): array
    {
        return ['status' => 'error', 'message' => $message];
    }
}