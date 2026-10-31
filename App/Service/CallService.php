<?php
declare(strict_types=1);
namespace App\Service;

use App\Tenant;
use App\Repository\{CallRepository, NoteRepository, HistoryRepository};
use App\Exceptions\ApiException;
use App\Http\ErrorCode;
use App\Support\MagicLower;

final class CallService
{
    public function __construct(
        private readonly CallRepository $callRepo,
        private readonly NoteRepository $noteRepo,
        private readonly HistoryRepository $historyRepo,
        private readonly LegacyProxyService $legacyProxy,
        private readonly Tenant $tenant
    ) {
    }

    /**
     * Получение списка открытых заявок
     */
    public function open(array $user): array
    {
        return $this->callRepo->listOpen($user);
    }

    /**
     * Получение списка закрытых заявок за период
     */
    public function close(array $user, mixed $period): array
    {
        return $this->callRepo->listClosed($user, (string) $period);
    }

    /**
     * Создание новой заявки
     */
    public function callnew(array $user, array $data): array
    {
        // Если включен режим Legacy — отправляем на старый сервер
        if ($this->tenant->legacyCompat) {
            $result = $this->legacyProxy->send('callnew', $data, $user['id']);

            if (($result['status'] ?? '') === 'error') {
                throw new ApiException(ErrorCode::InternalError, $result['message'] ?? 'Ошибка создания заявки');
            }

            return ['message' => $result['message'] ?? 'Заявка успешно создана (Legacy).'];
        }

        // Прямая работа с БД (когда отключим Legacy)
        // Здесь в будущем будет SQL INSERT в lift_calls
        throw new ApiException(ErrorCode::InternalError, 'Создание заявок напрямую пока не реализовано');
    }

    /**
     * Редактирование заявки
     */
    public function calledit(array $user, array $data): array
    {
        $callId = (int) ($data['call_id'] ?? 0);
        if (!$callId)
            throw new ApiException(ErrorCode::InvalidInput, 'call_id обязателен');

        if ($this->tenant->legacyCompat) {
            $result = $this->legacyProxy->send('calledit', $data, $user['id']);
            if (($result['status'] ?? '') === 'error') {
                throw new ApiException(ErrorCode::InternalError, $result['message'] ?? 'Ошибка');
            }
            return ['message' => "Изменения по заявке №$callId сохранены (Legacy)."];
        }

        $call = $this->callRepo->findById($callId);
        if (!$call)
            throw new ApiException(ErrorCode::NotFound, "Заявка не найдена");
        if ((int) $call['call_status'] === 1)
            throw new ApiException(ErrorCode::Closed, "Заявка уже закрыта");

        $fields = [];
        if (array_key_exists('details', $data)) {
            $fields['call_details'] = MagicLower::format((string) $data['details']);
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
            $this->historyRepo->add($callId, "Отредактирована пользователем {$user['name']}");
        }

        return ['message' => "Изменения по заявке №$callId сохранены."];
    }

    /**
     * Закрытие заявки
     */
    public function callClose(array $user, array $data): array
    {
        $callId = (int) ($data['call_id'] ?? 0);
        $solution = MagicLower::format(trim((string) ($data['solution'] ?? '')));

        if (!$callId)
            throw new ApiException(ErrorCode::InvalidInput, 'call_id обязателен');
        if (mb_strlen($solution) < 6)
            throw new ApiException(ErrorCode::InvalidInput, 'Решение минимум 6 символов');

        if ($this->tenant->legacyCompat) {
            $result = $this->legacyProxy->send('callClose', $data, $user['id']);
            if (($result['status'] ?? '') === 'error') {
                throw new ApiException(ErrorCode::InternalError, $result['message'] ?? 'Ошибка');
            }
            return ['message' => "Заявка №$callId закрыта (Legacy)."];
        }

        $call = $this->callRepo->findById($callId);
        if (!$call)
            throw new ApiException(ErrorCode::NotFound, "Заявка не найдена");
        if ((int) $call['call_status'] === 1)
            throw new ApiException(ErrorCode::Closed, "Заявка уже закрыта");

        $this->callRepo->updateFields($callId, [
            'call_status' => 1,
            'call_date2' => time(),
            'call_solution' => $solution,
            'call_last_name' => $user['name']
        ]);
        $this->historyRepo->add($callId, "Закрыта пользователем {$user['name']}. Решение: $solution");

        return ['message' => "Заявка №$callId успешно закрыта."];
    }

    /**
     * Добавление комментария (заметки)
     */
    public function callnote(array $user, array $data): array
    {
        $callId = (int) ($data['call_id'] ?? 0);
        $note = MagicLower::format(trim((string) ($data['note'] ?? '')));

        if (!$callId)
            throw new ApiException(ErrorCode::InvalidInput, 'call_id обязателен');
        if (mb_strlen($note) < 6)
            throw new ApiException(ErrorCode::InvalidInput, 'Текст минимум 6 символов');

        if ($this->tenant->legacyCompat) {
            $result = $this->legacyProxy->send('callnote', $data, $user['id']);
            if (($result['status'] ?? '') === 'error') {
                throw new ApiException(ErrorCode::InternalError, $result['message'] ?? 'Ошибка');
            }
            return ['message' => "Комментарий добавлен (Legacy)."];
        }

        $this->noteRepo->add($callId, $user['id'], $note);
        $this->historyRepo->add($callId, "Добавлена заметка: $note");

        return ['message' => "Комментарий добавлен к заявке №$callId."];
    }
}