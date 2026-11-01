<?php
declare(strict_types=1);

namespace App\Service;

use App\Repository\CallRepository;
use App\Repository\NoteRepository;
use App\Repository\HistoryRepository;
use App\Exceptions\ApiException;
use App\Http\ErrorCode;
use App\Tenant;

class CallService
{
    public function __construct(
        private readonly CallRepository $callRepo,
        private readonly NoteRepository $noteRepo,
        private readonly HistoryRepository $historyRepo,
        private readonly LegacyProxyService $legacyProxy,
        private readonly ConfigService $configService,
        private readonly ?Tenant $tenant = null
    ) {
    }

    /**
     * Список открытых заявок
     */
    public function open(array $user): array
    {
        return $this->callRepo->listOpen($user);
    }

    /**
     * Список закрытых заявок за период
     */
    public function close(array $user, string|int|null $period): array
    {
        return $this->callRepo->listClosed($user, $period);
    }

    /**
     * Создание новой заявки (с поддержкой legacy-прокси)
     * 
     * Фронтенд отправляет данные в формате API v4.0:
     * - city_id, street_id, home_id, object_id (вместо address_*)
     * - department_id, request_id, group_id (вместо call_*)
     * - repair_time (Unix timestamp)
     * - staff_id (вместо call_staff)
     */
    public function callnew(array $user, array $data): array
    {
        // === Если тенант на legacy — проксируем ===
        // LegacyProxyService сам конвертирует новый формат в legacy
        if ($this->tenant && $this->tenant->legacyCompat) {
            $result = $this->legacyProxy->send('callnew', $data, $user['id']);

            if (($result['status'] ?? '') === 'error') {
                throw new ApiException(
                    ErrorCode::InternalError,
                    $result['message'] ?? 'Ошибка legacy-системы'
                );
            }

            return [
                'message' => $result['message'] ?? 'Заявка создана в legacy',
                'call_id' => (int) ($result['generated_id'] ?? $result['call_id'] ?? 0)
            ];
        }

        // === Прямое создание заявки в БД (новый формат) ===
        $this->validateCallData($data);

        // Минимальная длина описания (ТЕХДОЛГ: читать из lift_options.min_length_text)
        $minLength = 6;

        $details = trim($data['details'] ?? '');
        if (mb_strlen($details) < $minLength) {
            throw new ApiException(
                ErrorCode::InvalidInput,
                "Описание должно содержать минимум {$minLength} символов"
            );
        }

        // Валидация адреса одним JOIN-запросом
        // Используем новые имена полей от фронтенда
        $address = $this->validateAddress($data);

        // Используем fullAddress из фронтенда
        $fullAddress = $data['fullAddress'] ?? $address['full_address'];

        // Определение alert_level
        $alertLevel = $this->determineAlertLevel($data);

        // Срок ремонта: repair_time приходит как Unix timestamp
        $expectedRepairTime = $this->resolveRepairTime($data);

        // Формирование данных для INSERT (маппинг в поля БД)
        $callData = [
            'call_status' => 0,
            'call_date' => time(),
            'call_first_name' => $data['call_first_name'] ?? '',
            'call_last_name' => $data['call_last_name'] ?? '',
            'call_phone' => $data['call_phone'] ?? '',
            'call_email' => $data['call_email'] ?? '',
            'call_department' => (int) ($data['department_id'] ?? 22),  // department_id → call_department
            'call_request' => (int) ($data['request_id'] ?? 0),      // request_id → call_request
            'call_group' => (int) ($data['group_id'] ?? 0),        // group_id → call_group
            'call_adres' => $fullAddress,
            'call_details' => $details,
            'call_solution' => '',
            'call_staff' => (int) ($data['staff_id'] ?? 0),        // staff_id → call_staff
            'address_city' => (int) ($data['city_id'] ?? 0),         // city_id → address_city
            'address_street' => (int) ($data['street_id'] ?? 0),       // street_id → address_street
            'address_home' => (int) ($data['home_id'] ?? 0),         // home_id → address_home
            'address_lift' => (int) ($data['object_id'] ?? 0),       // object_id → address_lift
            'elevator_group_id' => (int) $address['group_id'],
            'address_not_verified' => 0,
            'expected_repair_time' => $expectedRepairTime,
            'alert_level' => $alertLevel,
            'call_user' => (int) $user['id'],
        ];

        // Создание заявки
        $callId = $this->callRepo->create($callData);

        // Запись в историю
        $historyText = "Создана заявка пользователем {$user['name']}";
        $this->historyRepo->add($callId, $historyText, (int) $user['id']);

        return [
            'message' => "Заявка №{$callId} успешно создана",
            'call_id' => $callId,
        ];
    }

    /**
     * Редактирование заявки
     * 
     * Фронтенд отправляет: call_id, department_id, request_id, group_id, staff_id, notify_status, repair_time, details
     */
    public function calledit(array $user, array $data): array
    {
        $callId = (int) ($data['call_id'] ?? 0);
        if (!$callId) {
            throw new ApiException(ErrorCode::InvalidInput, 'call_id обязателен');
        }

        // Legacy-режим
        if ($this->tenant && property_exists($this->tenant, 'legacyCompat') && $this->tenant->legacyCompat) {
            $result = $this->legacyProxy->send('calledit', $data, $user['id']);
            if (($result['status'] ?? '') === 'error') {
                throw new ApiException(ErrorCode::InternalError, $result['message'] ?? 'Ошибка');
            }
            return ['message' => "Изменения по заявке №{$callId} сохранены (Legacy)."];
        }

        $call = $this->callRepo->findById($callId);
        if (!$call) {
            throw new ApiException(ErrorCode::NotFound, "Заявка не найдена");
        }
        if ((int) $call['call_status'] === 1) {
            throw new ApiException(ErrorCode::Closed, "Заявка уже закрыта");
        }

        // Маппинг полей из нового формата в поля БД
        $fields = [];

        if (array_key_exists('details', $data)) {
            $fields['call_details'] = $data['details'];
        }
        if (array_key_exists('department_id', $data)) {
            $fields['call_department'] = (int) $data['department_id'];
        }
        if (array_key_exists('request_id', $data)) {
            $fields['call_request'] = (int) $data['request_id'];
        }
        if (array_key_exists('group_id', $data)) {
            $fields['call_group'] = (int) $data['group_id'];
        }
        if (array_key_exists('staff_id', $data)) {
            $fields['call_staff'] = $data['staff_id'] === null ? 0 : (int) $data['staff_id'];
        }
        if (array_key_exists('notify_status', $data)) {
            $fields['call_staff_status'] = (int) $data['notify_status'];
            $fields['call_staff_date'] = $fields['call_staff_status'] !== 0 ? time() : 0;
        }
        if (array_key_exists('repair_time', $data)) {
            $fields['expected_repair_time'] = (int) $data['repair_time'];
        }

        if (!empty($fields)) {
            $this->callRepo->updateFields($callId, $fields);
            $this->historyRepo->add($callId, "Отредактирована пользователем {$user['name']}", (int) $user['id']);
        }

        return ['message' => "Изменения по заявке №{$callId} сохранены."];
    }

    /**
     * Закрытие заявки
     * 
     * Фронтенд отправляет: call_id, solution, user_id
     */
    public function callClose(array $user, array $data): array
    {
        $callId = (int) ($data['call_id'] ?? 0);
        $solution = trim((string) ($data['solution'] ?? ''));

        if (!$callId) {
            throw new ApiException(ErrorCode::InvalidInput, 'call_id обязателен');
        }
        if (mb_strlen($solution) < 6) {
            throw new ApiException(ErrorCode::InvalidInput, 'Решение минимум 6 символов');
        }

        // Legacy-режим
        if ($this->tenant && property_exists($this->tenant, 'legacyCompat') && $this->tenant->legacyCompat) {
            $result = $this->legacyProxy->send('callClose', $data, $user['id']);
            if (($result['status'] ?? '') === 'error') {
                throw new ApiException(ErrorCode::InternalError, $result['message'] ?? 'Ошибка');
            }
            return ['message' => "Заявка №{$callId} закрыта (Legacy)."];
        }

        $call = $this->callRepo->findById($callId);
        if (!$call) {
            throw new ApiException(ErrorCode::NotFound, "Заявка не найдена");
        }
        if ((int) $call['call_status'] === 1) {
            throw new ApiException(ErrorCode::Closed, "Заявка уже закрыта");
        }

        $this->callRepo->updateFields($callId, [
            'call_status' => 1,
            'call_date2' => time(),
            'call_solution' => $solution,
            'call_last_name' => $user['name'],
        ]);

        $this->historyRepo->add(
            $callId,
            "Закрыта пользователем {$user['name']}. Решение: {$solution}",
            (int) $user['id']
        );

        return ['message' => "Заявка №{$callId} успешно закрыта."];
    }

    /**
     * Добавление комментария
     * 
     * Фронтенд отправляет: call_id, note
     */
    public function callnote(array $user, array $data): array
    {
        $callId = (int) ($data['call_id'] ?? 0);
        $note = trim((string) ($data['note'] ?? ''));

        if (!$callId) {
            throw new ApiException(ErrorCode::InvalidInput, 'call_id обязателен');
        }
        if (mb_strlen($note) < 6) {
            throw new ApiException(ErrorCode::InvalidInput, 'Текст минимум 6 символов');
        }

        // Legacy-режим
        if ($this->tenant && property_exists($this->tenant, 'legacyCompat') && $this->tenant->legacyCompat) {
            $result = $this->legacyProxy->send('callnote', $data, $user['id']);
            if (($result['status'] ?? '') === 'error') {
                throw new ApiException(ErrorCode::InternalError, $result['message'] ?? 'Ошибка');
            }
            return ['message' => "Комментарий добавлен (Legacy)."];
        }

        $this->noteRepo->add($callId, $user['id'], $note);
        $this->historyRepo->add($callId, "Добавлена заметка: {$note}", (int) $user['id']);

        return ['message' => "Комментарий добавлен к заявке №{$callId}."];
    }

    // ==========================================
    // Приватные методы
    // ==========================================

    /**
     * Валидация данных заявки (новый формат API v4.0)
     */
    private function validateCallData(array $data): void
    {
        if (empty($data['details'])) {
            throw new ApiException(ErrorCode::InvalidInput, 'Описание заявки обязательно');
        }
        // Проверяем наличие всех компонентов адреса
        if (
            empty($data['city_id']) || empty($data['street_id'])
            || empty($data['home_id']) || empty($data['object_id'])
        ) {
            throw new ApiException(
                ErrorCode::InvalidInput,
                'Полный адрес обязателен (город, улица, дом, лифт)'
            );
        }
    }

    /**
     * Валидация адреса через репозиторий (использует city_id, street_id, home_id, object_id)
     */
    private function validateAddress(array $data): array
    {
        $cityId = (int) ($data['city_id'] ?? 0);
        $streetId = (int) ($data['street_id'] ?? 0);
        $homeId = (int) ($data['home_id'] ?? 0);
        $liftId = (int) ($data['object_id'] ?? 0);

        $address = $this->callRepo->resolveAddress($cityId, $streetId, $homeId, $liftId);

        if (!$address) {
            throw new ApiException(ErrorCode::NotFound, 'Адрес не найден или целостность нарушена');
        }

        $fullAddress = "{$address['city_name']}, {$address['street_name']}, д.{$address['home_name']}, {$address['object_name']}";

        return [
            'city' => $cityId,
            'street' => $streetId,
            'home' => $homeId,
            'lift' => $liftId,
            'full_address' => $fullAddress,
            'group_id' => (int) ($address['group_id'] ?? 1),
            'vis' => (bool) ($address['vis'] ?? true),
        ];
    }

    private function determineAlertLevel(array $data): int
    {
        $alertLevel = 1;

        // department_id в новом формате
        if ((int) ($data['department_id'] ?? 0) === 23) {
            $alertLevel = 3; // Аварийная служба
        } elseif ((int) ($data['request_id'] ?? 0) === 1) {
            $alertLevel = 2; // Срочная
        }

        return $alertLevel;
    }

    /**
     * Преобразование repair_time (Unix timestamp) в expected_repair_time
     */
    private function resolveRepairTime(array $data): int
    {
        // repair_time приходит как Unix timestamp от фронтенда
        if (isset($data['repair_time']) && is_numeric($data['repair_time']) && $data['repair_time'] > 1000000000) {
            return (int) $data['repair_time'];
        }

        // Дефолт: 3 дня от текущего момента
        return time() + (3 * 86400);
    }
}