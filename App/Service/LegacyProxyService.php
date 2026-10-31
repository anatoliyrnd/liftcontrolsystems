<?php
declare(strict_types=1);
namespace App\Service;

use App\Support\Logger;
use RuntimeException;

final class LegacyProxyService
{
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

        Logger::info('LegacyProxy: Отправка запроса', [
            'action' => $legacyAction,
            'user_id' => $userId,
            'fields' => array_keys($payload),
        ]);

        $ch = curl_init($this->legacyUrl);
        if ($ch === false) {
            Logger::error('LegacyProxy: Не удалось инициализировать cURL');
            return $this->errorResponse('Ошибка инициализации клиента');
        }

        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_POST => true,
            CURLOPT_POSTFIELDS => json_encode($payload, JSON_UNESCAPED_UNICODE),
            CURLOPT_HTTPHEADER => [
                'Content-Type: application/json',
                'Accept: application/json',
                'X-Legacy-Secret: ' . $this->secret,
                'X-Legacy-User-Id: ' . $userId,
            ],
            CURLOPT_CONNECTTIMEOUT_MS => 3000,
            CURLOPT_TIMEOUT_MS => 10000,
            CURLOPT_NOSIGNAL => true,
            CURLOPT_SSL_VERIFYPEER => true,
            CURLOPT_SSL_VERIFYHOST => 2,
        ]);

        $response = curl_exec($ch);
        $errno = curl_errno($ch);
        $error = curl_error($ch);
        $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
        curl_close($ch);

        if ($errno !== 0) {
            Logger::error('LegacyProxy: Ошибка cURL', ['errno' => $errno, 'error' => $error]);
            return $this->errorResponse('Ошибка связи с сервером: ' . $error);
        }

        if ($httpCode < 200 || $httpCode >= 300) {
            Logger::error('LegacyProxy: HTTP ошибка от шлюза', [
                'http' => $httpCode,
                'response_preview' => is_string($response) ? mb_substr($response, 0, 500) : null,
            ]);
            return $this->errorResponse('Ошибка сервера обработки заявок');
        }

        $decoded = json_decode($response, true);
        if (json_last_error() !== JSON_ERROR_NONE || !is_array($decoded)) {
            Logger::error('LegacyProxy: Некорректный JSON', ['response_preview' => mb_substr((string) $response, 0, 500)]);
            return $this->errorResponse('Некорректный формат ответа сервера');
        }

        return $decoded;
    }

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

        // --- ЛОГИКА ДЛЯ ЗАКРЫТИЯ ЗАЯВКИ ---
        if (strtolower($originalAction) === 'callclose' && isset($payload['solution'])) {
            $payload['call_close'] = $payload['solution'];
            unset($payload['solution']);
        }

        // --- ЛОГИКА ДЛЯ РЕДАКТИРОВАНИЯ ЗАЯВКИ ---
        if (strtolower($originalAction) === 'calledit') {
            // 1. Переводим статус уведомления (notify_status -> staff_status)
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

            // 2. Переводим Unix-время ремонта в ID (0-9), который понимает старый код
            if (isset($payload['repair_time'])) {
                $targetTime = (int) $payload['repair_time'];
                $payload['repair_time_id'] = $this->mapRepairTimeToId($targetTime);
                unset($payload['repair_time']);
            }
        }
        // --- ЛОГИКА ДЛЯ СОЗДАНИЯ НОВОЙ ЗАЯВКИ ---
        if (strtolower($originalAction) === 'callnew') {
            // Переводим ID-шники в формат старого API
            if (isset($payload['city_id'])) {
                $payload['city'] = $payload['city_id'];
                unset($payload['city_id']);
            }
            if (isset($payload['street_id'])) {
                $payload['street'] = $payload['street_id'];
                unset($payload['street_id']);
            }
            if (isset($payload['home_id'])) {
                $payload['home'] = $payload['home_id'];
                unset($payload['home_id']);
            }
            if (isset($payload['object_id'])) {
                $payload['object'] = $payload['object_id'];
                unset($payload['object_id']);
            }
            if (isset($payload['group_id'])) {
                $payload['group'] = $payload['group_id'];
                unset($payload['group_id']);
            }
            if (isset($payload['request_id'])) {
                $payload['request'] = $payload['request_id'];
                unset($payload['request_id']);
            }
            if (isset($payload['department_id'])) {
                $payload['department'] = $payload['department_id'];
                unset($payload['department_id']);
            }
            if (isset($payload['staff_id'])) {
                $payload['staff'] = $payload['staff_id'];
                unset($payload['staff_id']);
            }

            // Старый API ждет "fullAdress" (с одной 'd')
            if (isset($payload['fullAddress'])) {
                $payload['fullAdress'] = $payload['fullAddress'];
                unset($payload['fullAddress']);
            }

            // Старый API в callnew ждет ID срока ремонта (0-9), а не Unix-время!
            if (isset($payload['repair_time'])) {
                $targetTime = (int) $payload['repair_time'];
                $payload['repair_time'] = $this->mapRepairTimeToId($targetTime);
            }
        }
        // --- ЛОГИКА ДЛЯ СОЗДАНИЯ НОВОЙ ЗАЯВКИ ---
        if (strtolower($originalAction) === 'callnew') {
            // Переводим ID-шники в формат старого API
            if (isset($payload['city_id'])) {
                $payload['city'] = $payload['city_id'];
                unset($payload['city_id']);
            }
            if (isset($payload['street_id'])) {
                $payload['street'] = $payload['street_id'];
                unset($payload['street_id']);
            }
            if (isset($payload['home_id'])) {
                $payload['home'] = $payload['home_id'];
                unset($payload['home_id']);
            }
            if (isset($payload['object_id'])) {
                $payload['object'] = $payload['object_id'];
                unset($payload['object_id']);
            }
            if (isset($payload['group_id'])) {
                $payload['group'] = $payload['group_id'];
                unset($payload['group_id']);
            }
            if (isset($payload['request_id'])) {
                $payload['request'] = $payload['request_id'];
                unset($payload['request_id']);
            }
            if (isset($payload['department_id'])) {
                $payload['department'] = $payload['department_id'];
                unset($payload['department_id']);
            }
            if (isset($payload['staff_id'])) {
                $payload['staff'] = $payload['staff_id'];
                unset($payload['staff_id']);
            }

            // Старый API ждет "fullAdress" (с одной 'd')
            if (isset($payload['fullAddress'])) {
                $payload['fullAdress'] = $payload['fullAddress'];
                unset($payload['fullAddress']);
            }

            // Старый API в callnew ждет ID срока ремонта (0-9), а не Unix-время!
            if (isset($payload['repair_time'])) {
                $targetTime = (int) $payload['repair_time'];
                $payload['repair_time'] = $this->mapRepairTimeToId($targetTime);
            }
        }
        return $payload;
    }

    /**
     * Находит ближайший ID срока ремонта из старой системы
     */
    private function mapRepairTimeToId(int $targetTime): int
    {
        if ($targetTime === 0)
            return 0;

        $now = time();
        // Массив из старого main.php (со сдвигом на текущее время)
        $presets = [
            1 => $now + 1800,                 // 30 мин
            2 => strtotime("today 23:00"),    // Сегодня
            3 => strtotime("today +1day 23:00"), // Завтра
            4 => strtotime("today +3day 23:00"), // Три дня
            5 => strtotime("today +7day"),    // 7 дней
            6 => strtotime("today +10day"),   // 10 дней
            7 => strtotime("today +15day"),   // 15 дней
            8 => strtotime("today +1month"),  // 1 месяц
            9 => strtotime("today +3month"),  // 3 месяца
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