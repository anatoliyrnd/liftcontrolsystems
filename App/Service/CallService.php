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
        private readonly NotificationsService $notificationsService,
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
    public function calledit(array $user, array $data): array
    {
        $callId = (int) ($data['call_id'] ?? 0);
        if (!$callId) {
            throw new ApiException(ErrorCode::InvalidInput, 'call_id обязателен');
        }

        // Legacy-режим — БЕЗ уведомлений
        if ($this->tenant && $this->tenant->legacyCompat) {
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

       // === APPEND-ONLY для details / description_delta ===
       // Сервер принимает оба имени: description_delta (каноническое) и details (алиас)
       $newDetails = trim((string) ($data['description_delta'] ?? $data['details'] ?? ''));
       $currentDetails = (string) ($call['call_details'] ?? '');

       if ($newDetails !== '') {
           if ($currentDetails === '' || str_contains($newDetails, $currentDetails)) {
               // Старое пусто ИЛИ новое содержит старое (фронтенд правильно сформировал)
               $fields['call_details'] = $newDetails;
           } else {
               // Новое НЕ содержит старое — добавляем как дополнение
               $fields['call_details'] = $currentDetails . "\n\n" . $newDetails;
           }
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

        // Уведомление ТОЛЬКО для нового API
        $this->notificationsService->ticketEdited($callId, $user['name'], (int) $user['id']);

        return ['message' => "Изменения по заявке №{$callId} сохранены."];
    }

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

        // Legacy-режим — БЕЗ уведомлений
        if ($this->tenant && $this->tenant->legacyCompat) {
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
            'call_status'    => 1,
            'call_date2'     => time(),
            'call_solution'  => $solution,
            'call_last_name' => $user['name'],
        ]);

        $this->historyRepo->add(
            $callId,
            "Закрыта пользователем {$user['name']}. Решение: {$solution}",
            (int) $user['id']
        );

        // Уведомление ТОЛЬКО для нового API
        $this->notificationsService->ticketClosed($callId, $solution, $user['name'], (int) $user['id']);

        return ['message' => "Заявка №{$callId} успешно закрыта."];
    }

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

        // Legacy-режим — БЕЗ уведомлений
        if ($this->tenant && $this->tenant->legacyCompat) {
            $result = $this->legacyProxy->send('callnote', $data, $user['id']);
            if (($result['status'] ?? '') === 'error') {
                throw new ApiException(ErrorCode::InternalError, $result['message'] ?? 'Ошибка');
            }
            return ['message' => "Комментарий добавлен (Legacy)."];
        }

        $this->noteRepo->add($callId, $user['id'], $note);
        $this->historyRepo->add($callId, "Добавлена заметка: {$note}", (int) $user['id']);

        // Уведомление ТОЛЬКО для нового API
        $this->notificationsService->ticketNote($callId, $user['name'], (int) $user['id']);

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