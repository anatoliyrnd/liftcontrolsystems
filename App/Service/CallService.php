<?php
declare(strict_types=1);

namespace App\Service;

use App\Repository\{CallRepository, NoteRepository, HistoryRepository};
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
        private readonly AddressCacheService $cacheService,
        private readonly ?Tenant $tenant = null
    ) {
    }

    public function open(array $user): array { return $this->callRepo->listOpen($user); }
    public function close(array $user, string|int|null $period): array { return $this->callRepo->listClosed($user, $period); }
    /**
     * Карточка заявки прямым запросом (§12.2).
     *
     * Зачем транзит через сервис, а не прямой вызов из контроллера:
     * - сохраняется слоистость controller → service → repository;
     * - контроллеру не нужна новая зависимость CallRepository;
     * - IDE перестаёт ругаться на неиспользуемый findByIdDetailed:
     *   цепочка вызовов становится getTicket → ticketDetailed → findByIdDetailed.
     *
     * Вся тяжёлая работа (прямой SQL, права, заметки, история, can_*)
     * живёт в репозитории; сервис лишь пропускает вызов.
     *
     * @param int   $callId Номер заявки из запроса
     * @param array $user   Авторизованный пользователь (для проверки прав)
     * @return array|null Контракт заявки по §12.2 или null (не найдена / нет прав)
     */
    public function ticketDetailed(int $callId, array $user): ?array
    {
        return $this->callRepo->findByIdDetailed($callId, $user);
    }
    /**
     * Создание новой заявки с явным указанием источника и полной валидацией (§4.2, §7)
     */
    public function callnew(array $user, array $data, string $source = 'online'): array
    {
        $isOffline = ($source === 'offline_sync');
        $authorName = $data['offline_author_name'] ?? $user['name'];
        $authorId = isset($data['offline_author_id']) ? (int)$data['offline_author_id'] : (int)$user['id'];

        // 🛡️ Валидация обязательных полей
        if ($isOffline && !isset($data['opened_at'])) {
            throw new ApiException(ErrorCode::InvalidInput, 'opened_at обязателен для офлайн-заявки',reason: 'opened_at_required');
        }
        $openedAt = isset($data['opened_at']) ? (int)$data['opened_at'] : time();

        $details = trim((string)($data['details'] ?? ''));
        if (mb_strlen($details) < 6) {
            throw new ApiException(ErrorCode::InvalidInput, 'Описание слишком короткое (минимум 6 символов)', reason: 'details_too_short');
        }
        $comments = trim((string) ($data['comments'] ?? ''));
        $repairTime = isset($data['repair_time']) ? (int) $data['repair_time'] : 0;
// Офлайн срок не задаётся — валидация к нему не применяется.
        if (!$isOffline && $repairTime > 0 && $repairTime < time()) {
            throw new ApiException(
                ErrorCode::InvalidInput,
                'Срок ремонта не может быть в прошлом',
                reason: 'repair_time_in_past'
            );
        }

        $addr = $this->validateAddress($data);

        // 🛡️ Проверка идемпотентности по уникальному offline_uuid
        $offlineUuid = $data['offline_uuid'] ?? null;
        if ($isOffline && $offlineUuid) {
            $existing = $this->callRepo->findByOfflineUuid((string)$offlineUuid);
            if ($existing) {
                return ['status' => 'ok', 'call_id' => (int)$existing['call_id'], 'message' => 'ignored: already_processed'];
            }
        }

        $depId = (int) ($data['department_id'] ?? 22);
        $groupId = (int) ($data['group_id'] ?? 9);
        $forceCreate = (bool) ($data['force_create'] ?? false);

        // 🛡️ ДУБЛИКАТЫ (§5, правило «объект + отдел»).
        // Список снимается ОДИН раз и ДО создания заявки — он нужен сразу
        // для двух веток: и для отказа с модалкой, и для аудита force_create.
        $activeDuplicates = $this->callRepo->findActiveDuplicates($addr['lift'], $depId);

        // Ветка отказа: дубликаты есть, принудительного подтверждения нет.
        // Сообщение исключения несёт JSON-список: ApiController распознаёт
        // префикс 'duplicate_detected:' и собирает ответ с existing_tickets,
        // по которому клиент рисует модалку.
        if (!$forceCreate && !empty($activeDuplicates)) {
            $errorData = [];
            foreach ($activeDuplicates as $dup) {
                $errorData[] = [
                    'ticket_id' => (int)$dup['call_id'],
                    'details'   => $dup['call_details'],
                    'date'      => (int)$dup['call_date'],
                ];
            }
            throw new ApiException(
                ErrorCode::InvalidInput,
                'duplicate_detected:' . json_encode($errorData, JSON_UNESCAPED_UNICODE)
            );
        }
        // Ветка force_create: исключение НЕ бросаем, $activeDuplicates
        // сохраняем для аудита после создания (см. блок после create).

        // 🔄 Подготовка автокоррекций оффлайна
        $now = time();
        $hasDateCorrection = false;
        $originalDateStr = '';

        if ($isOffline && $openedAt > ($now + 86400)) {
            $originalDateStr = date('d.m.Y H:i', $openedAt);
            $openedAt = $now;
            $hasDateCorrection = true;

            // Пометка уходит в comments, а не засоряет описание заявки.
            $correctionNote = "⏳ [Автокоррекция даты] Исходная дата создания офлайн: {$originalDateStr}. "
                . "Скорректировано на системную: " . date('d.m.Y H:i', $now) . ".";

            $comments = $comments === ''
                ? $correctionNote
                : $comments . "\n" . $correctionNote;
        }

        $callStatus = 0;
        $solution = trim((string)($data['solution'] ?? ''));
        $closedAt = isset($data['closed_at']) ? (int)$data['closed_at'] : null;
        $closeName = $data['closed_by_name'] ?? $authorName;
        $hasSolutionCorrection = false;
        $hasClosedAtCorrection = false;

        if ($solution !== '') {
            if (mb_strlen($solution) < 6) {
                throw new ApiException(ErrorCode::InvalidInput,
                    'Решение слишком короткое', reason: 'solution_too_short');
            }
            $callStatus = 1;
            if ($closedAt === null) {
                $closedAt = $now;
                $hasSolutionCorrection = true;
            }
            if ($closedAt < $openedAt) {
                $closedAt = $openedAt;
                $hasClosedAtCorrection = true;
            }
        }
// Онлайн: значение клиента. Офлайн: время синхронизации + флаг «назначен сервером».
        if ($isOffline) {
            $repairFinal = time();
            $repairIsDefault = 1;
        } else {
            $repairFinal = $repairTime > 0 ? $repairTime : time() + (3 * 86400);
            $repairIsDefault = $repairTime > 0 ? 0 : 1;
        }
        $this->assertDictCategory($depId, 1);
        $this->assertDictCategory((int) ($data['request_id'] ?? 0), 2);
        $this->assertDictCategory($groupId, 3);
        $callId = $this->callRepo->create([
            'call_first_name'      => $authorName,
            'call_details'         => $details,
            'address_city'         => $addr['city'],
            'address_street'       => $addr['street'],
            'address_home'         => $addr['home'],
            'address_lift'         => $addr['lift'],
            'call_adres'           => $addr['full_address'],
            'call_department'      => $depId,
            'call_request'         => (int) ($data['request_id'] ?? 3),
            'call_group'           => $groupId,
            'call_staff'           => (int) ($data['staff_id'] ?? 0),
            'call_date'            => $openedAt,
            'call_status'          => $callStatus,
            'call_solution'        => $callStatus === 1 ? $solution : '',
            'call_last_name'       => $callStatus === 1 ? (string)$closeName : '',
            'closed_by_id'   => $callStatus === 1
                ? (isset($data['closed_by_id']) ? (int) $data['closed_by_id'] : $authorId)
                : null,
            'call_date2'           => $callStatus === 1 ? $closedAt : 0,
            'alert_level' => isset($data['alert_level'])
                ? max(1, min(3, (int) $data['alert_level']))
                : $this->determineAlertLevel($data),
            'expected_repair_time'   => $repairFinal,
            'repair_time_is_default' => $repairIsDefault,
            'call_user'            => $authorId,
            'offline_uuid'         => $offlineUuid
        ]);

        // Логирование автокоррекций после получения callId
        if ($isOffline) {
            $this->historyRepo->add(
                $callId,
                'Срок ремонта назначен сервером: офлайн-клиент срок не задаёт',
                $authorId,
                $source
            );
        }
        if ($hasDateCorrection) {
            $this->historyRepo->add($callId, "Автокоррекция даты создания: оффлайн-таймстемп {$originalDateStr} сдвинут на время сервера", $authorId, $source);
        }
        if ($hasSolutionCorrection) {
            $this->historyRepo->add($callId, "Автокоррекция закрытия: решение передано без даты закрытия, выставлено текущее время сервера", $authorId, $source);
        }
        if ($hasClosedAtCorrection) {
            $this->historyRepo->add($callId, "Автокоррекция закрытия: переданная дата закрытия была меньше даты открытия, выровнено по дате открытия", $authorId, $source);
        }

        $this->historyRepo->add($callId, $isOffline ? "Заявка синхронизирована из офлайна (Автор: {$authorName})" : "Заявка создана пользователем {$authorName}", $authorId, $source);

        if (!$addr['vis']) {
            $this->historyRepo->add($callId, "объект выведен из обслуживания на момент синхронизации", $authorId, $source);
        }
        // 🛡️ АУДИТ ПРИНУДИТЕЛЬНОГО ДУБЛИКАТА (пункт 2 плана).
        // Пишется только когда диспетчер осознанно подтвердил создание
        // через модалку дубликата (force_create = true). Список снят ДО
        // создания, поэтому содержит только «чужие» заявки.
        if ($forceCreate) {
            if (!empty($activeDuplicates)) {
                // Склеиваем номера в читаемую строку: «№34, №32».
                $numbers = implode(', ', array_map(
                    static fn (array $dup): string => '№' . (int)$dup['call_id'],
                    $activeDuplicates
                ));
                $this->historyRepo->add(
                    $callId,
                    "Принудительное создание дубликата (подтверждено диспетчером {$authorName}). Возможный дубликат к заявке(ам) {$numbers}",
                    $authorId,
                    $source
                );
            } else {
                // Легальная гонка: пока пачка шла до сервера (или пока была
                // открыта модалка), дубликат закрыл другой пользователь.
                // Заявка создаётся как обычная, но факт подтверждения фиксируем.
                $this->historyRepo->add(
                    $callId,
                    "Принудительное создание дубликата (подтверждено диспетчером {$authorName}). Активных дубликатов на момент создания не было",
                    $authorId,
                    $source
                );
            }
        }
        // 🛡️ ИСПРАВЛЕНО: Теперь оффлайн-комментарии гарантированно получают флаг is_offline=1 (§2.10)
        if ($comments !== '') {
            $noteId = $this->noteRepo->add($callId, $authorId, $comments);
            if ($isOffline) {
                $this->noteRepo->updateOfflineFlag($noteId, $openedAt);
            }
        }
// Заявка создана сразу закрытой: заметки обязаны попасть в слепок,
// иначе карточка их не покажет — она читает call_full_note_history.
        if ($callStatus === 1) {
            $notes = $this->noteRepo->listByCall($callId);
            if (!empty($notes)) {
                $this->callRepo->saveNotesHistory($callId, json_encode($notes, JSON_UNESCAPED_UNICODE));
                $this->noteRepo->deleteByCall($callId);
            }
        }
        $this->cacheService->invalidateTickets();
        // 🔔 ВОЗВРАТ УВЕДОМЛЕНИЙ (фикс регрессии: в v5.2-версии сервиса
        // вызовы NotificationsService исчезли из всех четырёх методов).
        // Если офлайн-заявка пришла сразу закрытой (solution + closed_at),
        // шлём событие ЗАКРЫТИЯ, а не создания: иначе диспетчеры получат
        // тост «новая заявка» о фактически завершённой работе.
        if ($callStatus === 1) {
            $this->notificationsService->ticketClosed($callId, $solution, (string)$closeName, $authorId);
        } else {
            $this->notificationsService->ticketCreated($callId, $addr['full_address'], $authorName, $authorId);
        }
        return ['status' => 'ok', 'call_id' => $callId, 'message' => 'Заявка успешно создана.'];
    }

    /**
     * Редактирование существующей заявки (Онлайн / Офлайн Soft Merge согласно §4.3)
     */
    public function calledit(array $user, array $data, string $source = 'online'): array
    {
        $callId = (int) ($data['call_id'] ?? 0);
        if (!$callId) throw new ApiException(ErrorCode::InvalidInput, 'call_id обязателен',reason: 'call_id_required');

        $call = $this->callRepo->findById($callId);
        if (!$call) throw new ApiException(ErrorCode::NotFound, "Заявка не найдена");
        if ((int) $call['call_status'] === 1) throw new ApiException(ErrorCode::Closed, 'Заявка уже закрыта', reason: 'ticket_already_closed');

        $isOffline = ($source === 'offline_sync');
        $authorName = $data['offline_author_name'] ?? $user['name'];
        $authorId = isset($data['offline_author_id']) ? (int)$data['offline_author_id'] : (int)$user['id'];

        $fields = [];
        $newDetails = trim((string) ($data['description_delta'] ?? $data['details'] ?? ''));
        $currentDetails = (string) ($call['call_details'] ?? '');

        if ($newDetails !== '') {
            if ($isOffline) {
                // Дополнение описания для офлайна: CONCAT(old, '\n\n[Оффлайн <user> <date>]\n', delta)
                $fields['call_details'] = $currentDetails . "\n\n[Оффлайн {$authorName} " . date('d.m.Y H:i') . "]:\n" . $newDetails;
            } else {
                $fields['call_details'] = $currentDetails === '' ? $newDetails : $currentDetails . "\n\n" . $newDetails;
            }
        }

        // 🌟 Маршрутизация Soft Merge: онлайн перезаписывает всё, офлайн — только пустые (0)
        $canUpdate = function(string $fieldName) use ($call, $isOffline): bool {
            if (!$isOffline) return true;
            return (int)($call[$fieldName] ?? 0) === 0;
        };
// Категория справочника проверяется до записи. Отсутствующий id
// не трогаем — легаси мог ссылаться на удалённое значение.
        if (array_key_exists('department_id', $data)) {
            $this->assertDictCategory((int) $data['department_id'], 1);
        }
        if (array_key_exists('request_id', $data)) {
            $this->assertDictCategory((int) $data['request_id'], 2);
        }
        if (array_key_exists('group_id', $data)) {
            $this->assertDictCategory((int) $data['group_id'], 3);
        }
        if (array_key_exists('department_id', $data) && $canUpdate('call_department')) $fields['call_department'] = (int) $data['department_id'];
        if (array_key_exists('request_id', $data) && $canUpdate('call_request')) $fields['call_request'] = (int) $data['request_id'];
        if (array_key_exists('group_id', $data) && $canUpdate('call_group')) $fields['call_group'] = (int) $data['group_id'];
        if (array_key_exists('staff_id', $data) && $canUpdate('call_staff')) $fields['call_staff'] = (int) $data['staff_id'];

        if (array_key_exists('notify_status', $data) && $canUpdate('call_staff_status')) {
            $fields['call_staff_status'] = (int) $data['notify_status'];
            $fields['call_staff_date'] = $fields['call_staff_status'] !== 0 ? time() : 0;
        }
        // Слоты 2 и 3. Колонки nullable, но 0 и NULL одинаково повятся как null
// в formatList/findByIdDetailed, поэтому пишем 0 при снятии — единообразно
// с первым слотом.
        foreach ([2, 3] as $i) {
            $colStaff  = "call_staff{$i}";
            $colStatus = "call_staff_status{$i}";
            $colDate   = "call_staff_date{$i}";

            if (array_key_exists("staff_id{$i}", $data) && $canUpdate($colStaff)) {
                $fields[$colStaff] = (int) $data["staff_id{$i}"];
            }
            if (array_key_exists("notify_status{$i}", $data) && $canUpdate($colStatus)) {
                $fields[$colStatus] = (int) $data["notify_status{$i}"];
                // Дату уведомления ставит сервер, клиентское notify_date игнорируем.
                $fields[$colDate] = $fields[$colStatus] !== 0 ? time() : 0;
            }
        }
        // Офлайн срок ремонта игнорируется молча (не ошибка).
        if (!$isOffline && array_key_exists('repair_time', $data) && $canUpdate('expected_repair_time')) {
            $fields['expected_repair_time'] = (int) $data['repair_time'];
            // Диспетчер задал срок явно — снимаем признак «по умолчанию».
            $fields['repair_time_is_default'] = 0;
        }
        if (!empty($fields)) {
            $this->callRepo->updateFields($callId, $fields);
            $this->historyRepo->add($callId, "Отредактирована пользователем {$authorName}", $authorId, $source);
            $this->cacheService->invalidateTickets();
        }
// 🔔 Событие редактирования шлём ТОЛЬКО при фактических
        // изменениях: пустое редактирование не должно спамить
        // тостами и Telegram остальным пользователям.
        $this->notificationsService->ticketEdited($callId, $authorName, $authorId);

        return ['message' => "Изменения по заявке №{$callId} сохранены."];
    }

    /**
     * Закрытие заявки (§4.4 Сериализация и каноническое удаление заметок)
     */
    public function callClose(array $user, array $data, string $source = 'online'): array
    {
        $callId = (int) ($data['call_id'] ?? 0);
        $solution = trim((string) ($data['solution'] ?? ''));

        if (!$callId) throw new ApiException(ErrorCode::InvalidInput, 'call_id обязателен');
        if (mb_strlen($solution) < 6) throw new ApiException(ErrorCode::InvalidInput, 'validation_error: solution_too_short');

        $call = $this->callRepo->findById($callId);
        if (!$call) throw new ApiException(ErrorCode::NotFound, "Заявка не найдена");
        if ((int) $call['call_status'] === 1) throw new ApiException(ErrorCode::Closed, "validation_error: ticket_already_closed");

        $authorName = $data['offline_author_name'] ?? $user['name'];
        $authorId = isset($data['offline_author_id']) ? (int)$data['offline_author_id'] : (int)$user['id'];
        $closedAt = isset($data['closed_at']) ? (int)$data['closed_at'] : time();

        // 🌟 Безопасное сохранение слепка комментариев через репозиторий до их очистки
        $notes = $this->noteRepo->listByCall($callId);
        if (!empty($notes)) {
            $this->callRepo->saveNotesHistory($callId, json_encode($notes, JSON_UNESCAPED_UNICODE));
            $this->noteRepo->deleteByCall($callId);
        }

        $this->callRepo->updateFields($callId, [
            'call_status'    => 1,
            'call_date2'     => $closedAt,
            'call_solution'  => $solution,
            'call_last_name' => $authorName,
            'closed_by_id'   => $authorId,
        ]);

        $this->historyRepo->add($callId, "Закрыта пользователем {$authorName}. Решение: {$solution}", $authorId, $source);
        $this->cacheService->invalidateTickets();
        // 🔔 Событие закрытия: тосты другим пользователям + Telegram.
        $this->notificationsService->ticketClosed($callId, $solution, $authorName, $authorId);

        return ['message' => "Заявка №{$callId} успешно закрыта."];
    }
    /**
     * Добавление комментария с фиксацией даты устройства (§4.5)
     */
    public function callnote(array $user, array $data, string $source = 'online'): array
    {
        $callId = (int) ($data['call_id'] ?? 0);
        $note = trim((string) ($data['text'] ?? $data['note'] ?? ''));

        if (!$callId) throw new ApiException(ErrorCode::InvalidInput, 'call_id обязателен');
        if (mb_strlen($note) < 6) throw new ApiException(ErrorCode::InvalidInput, 'Комментарий слишком короткий', reason: 'text_too_short');

        $call = $this->callRepo->findById($callId);
        if (!$call) throw new ApiException(ErrorCode::NotFound, "Заявка не найдена");
        if ((int) $call['call_status'] === 1) throw new ApiException(ErrorCode::Closed, "validation_error: ticket_already_closed");

        $authorName = $data['offline_author_name'] ?? $user['name'];
        $authorId = isset($data['offline_author_id']) ? (int)$data['offline_author_id'] : (int)$user['id'];
        $createdAt = isset($data['created_at']) ? (int)$data['created_at'] : time();

        // Сохранение заметки без рефлексии
        $noteId = $this->noteRepo->add($callId, $authorId, $note);

        if ($source === 'offline_sync') {
            $this->noteRepo->updateOfflineFlag($noteId, $createdAt);
        }

        $this->historyRepo->add($callId, "Добавлена заметка от {$authorName}: {$note}", $authorId, $source);
        $this->cacheService->invalidateTickets();
        // 🔔 Событие нового комментария.
        $this->notificationsService->ticketNote($callId, $authorName, $authorId);

        return ['message' => "Комментарий добавлен к заявке №{$callId}."];
    }

    private function validateCallData(array $data): void
    {
        if (empty($data['details'])) throw new ApiException(ErrorCode::InvalidInput, 'Описание заявки обязательно');
        if (empty($data['city_id']) || empty($data['street_id']) || empty($data['home_id']) || empty($data['object_id'])) {
            throw new ApiException(ErrorCode::InvalidInput, 'Полный адрес обязателен');
        }
    }

    private function validateAddress(array $data): array
    {
        $cityId = (int) ($data['city_id'] ?? 0);
        $streetId = (int) ($data['street_id'] ?? 0);
        $homeId = (int) ($data['home_id'] ?? 0);
        $liftId = (int) ($data['object_id'] ?? 0);

        $address = $this->callRepo->resolveAddress($cityId, $streetId, $homeId, $liftId);
        if (!$address) throw new ApiException(ErrorCode::NotFound, 'Объект не найден в справочнике адресов', reason: 'object_not_found');

        return [
            'city' => $cityId, 'street' => $streetId, 'home' => $homeId, 'lift' => $liftId,
            'full_address' => "{$address['city_name']}, {$address['street_name']}, д.{$address['home_name']}, {$address['object_name']}",
            'group_id' => (int) ($address['group_id'] ?? 1),
            'vis' => (bool) ($address['vis'] ?? true),
        ];
    }

    private function determineAlertLevel(array $data): int
    {
        if ((int) ($data['department_id'] ?? 0) === 23) return 3;
        if ((int) ($data['request_id'] ?? 0) === 1) return 2;
        return 1;
    }
    /**
     * Отклоняем id из чужой категории (заявка №8: call_request=7 — это группа).
     * Отсутствующий id не трогаем — легаси-данные могли ссылаться на удалённое.
     */
    private function assertDictCategory(int $typeId, int $expectedType): void
    {
        if ($typeId <= 0) return;
        $row = $this->callRepo->findTypeCategory($typeId);
        if ($row && (int) $row['type'] !== $expectedType) {
            throw new ApiException(
                ErrorCode::InvalidInput,
                'Значение справочника не принадлежит нужной категории',
                reason: 'invalid_dict_category'
            );
        }
    }
}

