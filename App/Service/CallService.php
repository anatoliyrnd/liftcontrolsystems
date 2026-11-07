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
        private readonly AddressCacheService $cacheService, // 🌟 Чистое внедрение зависимости
        private readonly ?Tenant $tenant = null
    ) {
        
    }


    public function open(array $user): array
    {
        return $this->callRepo->listOpen($user);
    }

    public function close(array $user, string|int|null $period): array
    {
        return $this->callRepo->listClosed($user, $period);
    }

    public function callnew(array $user, array $data): array
    {
        $this->validateCallData($data);
        $addr = $this->validateAddress($data);

        $callId = $this->callRepo->create([
            'call_first_name'      => $user['name'],
            'call_details'         => trim((string) $data['details']),
            'address_city'         => $addr['city'],
            'address_street'       => $addr['street'],
            'address_home'         => $addr['home'],
            'address_lift'         => $addr['lift'],
            'call_adres'           => $addr['full_address'],
            'call_department'      => (int) ($data['department_id'] ?? 22),
            'call_request'         => (int) ($data['request_id'] ?? 3),
            'call_group'           => (int) ($data['group_id'] ?? 9),
            'call_staff'           => (int) ($data['staff_id'] ?? 0),
            'call_date'            => time(),
            'call_status'          => 0,
            'alert_level'          => $this->determineAlertLevel($data),
            'expected_repair_time' => $this->resolveRepairTime($data),
            'call_user'            => $user['id']
        ]);

        $this->historyRepo->add($callId, "Заявка создана пользователем {$user['name']}", (int) $user['id']);

        $this->cacheService->invalidateTickets();

        $this->notificationsService->ticketCreated($callId, $addr['full_address'], $user['name'], (int) $user['id']);

        return ['status' => 'ok', 'call_id' => $callId, 'message' => 'Заявка успешно создана.'];
    }

    public function calledit(array $user, array $data): array
    {
        $callId = (int) ($data['call_id'] ?? 0);
        if (!$callId) {
            throw new ApiException(ErrorCode::InvalidInput, 'call_id обязателен');
        }

        $call = $this->callRepo->findById($callId);
        if (!$call) {
            throw new ApiException(ErrorCode::NotFound, "Заявка не найдена");
        }
        if ((int) $call['call_status'] === 1) {
            throw new ApiException(ErrorCode::Closed, "Заявка уже закрыта");
        }

       $fields = [];
       $newDetails = trim((string) ($data['description_delta'] ?? $data['details'] ?? ''));
       $currentDetails = (string) ($call['call_details'] ?? '');

       if ($newDetails !== '') {
           if ($currentDetails === '' || str_contains($newDetails, $currentDetails)) {
               $fields['call_details'] = $newDetails;
           } else {
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

            $this->cacheService->invalidateTickets();
        }

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

        $this->historyRepo->add($callId, "Закрыта пользователем {$user['name']}. Решение: {$solution}", (int) $user['id']);

        $this->cacheService->invalidateTickets();

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

        $this->noteRepo->add($callId, $user['id'], $note);
        $this->historyRepo->add($callId, "Добавлена заметка: {$note}", (int) $user['id']);

        $this->cacheService->invalidateTickets();

        $this->notificationsService->ticketNote($callId, $user['name'], (int) $user['id']);

        return ['message' => "Комментарий добавлен к заявке №{$callId}."];
    }

    private function validateCallData(array $data): void
    {
        if (empty($data['details'])) {
            throw new ApiException(ErrorCode::InvalidInput, 'Описание заявки обязательно');
        }
        if (empty($data['city_id']) || empty($data['street_id']) || empty($data['home_id']) || empty($data['object_id'])) {
            throw new ApiException(ErrorCode::InvalidInput, 'Полный адрес обязателен (город, улица, дом, лифт)');
        }
    }

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
            'city'         => $cityId,
            'street'       => $streetId,
            'home'         => $homeId,
            'lift'         => $liftId,
            'full_address' => $fullAddress,
            'group_id'     => (int) ($address['group_id'] ?? 1),
            'vis'          => (bool) ($address['vis'] ?? true),
        ];
    }

    private function determineAlertLevel(array $data): int
    {
        if ((int) ($data['department_id'] ?? 0) === 23) {
            return 3;
        }
        if ((int) ($data['request_id'] ?? 0) === 1) {
            return 2;
        }
        return 1;
    }

    private function resolveRepairTime(array $data): int
    {
        if (isset($data['repair_time']) && is_numeric($data['repair_time']) && $data['repair_time'] > 1000000000) {
            return (int) $data['repair_time'];
        }
        return time() + (3 * 86400);
    }
}
