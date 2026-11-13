<?php
declare(strict_types=1);

namespace App\Controller;

use App\Database\DB;
use App\Http\{Request, Response, ErrorCode};
use App\Tenant;
use App\Exceptions\ApiException;
use App\Repository\{UserRepository, CallRepository, NoteRepository, HistoryRepository};
use App\Service\{
    AuthService,
    CallService,
    LegacyProxyService,
    ConfigService,
    AddressService,
    NotificationsService,
    AddressCacheService
};

final class ApiController
{
    /**
     * TTL логов идемпотентности (API_syncCommands §11.4).
     * Фильтр обязателен при чтении: истёкшая, но не удалённая cron'ом строка
     * иначе даёт ложный ignored — команда, пролежавшая офлайн 8 дней,
     * выбрасывается вместо выполнения.
     */
    private const COMMAND_LOG_TTL_DAYS = 7;
    private const SYNC_LOG_TTL_DAYS    = 30;

    private AuthService $authService;
    private CallService $callService;
    private ConfigService $configService;
    private AddressService $addressService;
    private DB $db;
    private NotificationsService $notificationsService;
    private AddressCacheService $addressCacheService;
    private ?Tenant $tenant;

    private function __construct(
        AuthService $authService,
        CallService $callService,
        ConfigService $configService,
        AddressService $addressService,
        DB $db,
        NotificationsService $notificationsService,
        AddressCacheService $addressCacheService,
        ?Tenant $tenant
    ) {
        $this->authService = $authService;
        $this->callService = $callService;
        $this->configService = $configService;
        $this->addressService = $addressService;
        $this->db = $db;
        $this->notificationsService = $notificationsService;
        $this->addressCacheService = $addressCacheService;
        $this->tenant = $tenant;
    }

    public static function create(): self
    {
        $tenant = Tenant::fromRequest();
        $db = DB::forTenant($tenant);

        $userRepo    = new UserRepository($db);
        $callRepo    = new CallRepository($db);
        $noteRepo    = new NoteRepository($db);
        $historyRepo = new HistoryRepository($db);
        $legacyProxy = new LegacyProxyService(\LEGACY_API_URL ?? '', \LEGACY_API_SECRET ?? '');

        $configService = new ConfigService($db, $tenant);
        $addressService = new AddressService($db);
        $notificationsService = new NotificationsService($db);
        $addressCacheService = new AddressCacheService($db);

        $callService = new CallService(
            $callRepo,
            $noteRepo,
            $historyRepo,
            $legacyProxy,
            $configService,
            $notificationsService,
            $addressCacheService,
            $tenant
        );

        return new self(
            new AuthService($userRepo),
            $callService,
            $configService,
            $addressService,
            $db,
            $notificationsService,
            $addressCacheService,
            $tenant
        );
    }

    public function handle(Request $request): Response
    {
        if ($request->bearer === null) {
            throw new ApiException(ErrorCode::MissingToken, 'Требуется авторизация');
        }

        $user = $this->authService->validate($request->bearer);

        return match ($request->action) {
            'config'        => new Response(['status' => 'ok'] + $this->configService->getConfig($user)),
            'loadAddress'   => Response::ok(['action' => 'loadAddress', 'message' => $this->addressService->getAddresses()]),
            'open'          => new Response($this->callService->open($user)),
            'close'         => new Response($this->callService->close($user, $request->input('period'))),
            'calledit'      => Response::ok($this->callService->calledit($user, $request->body)),
            'callClose'     => Response::ok($this->callService->callClose($user, $request->body)),
            'callnote'      => Response::ok($this->callService->callnote($user, $request->body)),
            'callnew'       => Response::ok($this->callService->callnew($user, $request->body)),
            'notifications' => Response::ok($this->getNotifications($request)),
            'ticket'        => Response::ok(['data' => $this->getTicket($request, $user)]),

            // B2.6: результат пачки — под data, как у ticket (§0.3).
            // Клиент поддерживает оба варианта (resp.data || resp), так что
            // выкатка не ломает уже открытый SPA.
            'syncCommands'  => Response::ok(['data' => $this->handleSyncCommands($user, $request)]),

            default => throw new ApiException(ErrorCode::UnknownAction, 'Неизвестное действие: ' . $request->action)
        };
    }

    /**
     * Эндпоинт одной заявки (§12.2).
     *
     * Прямой запрос по ID через сервис и репозиторий: старый перебор
     * open + close('365') не находил закрытые старше года.
     *
     * call_id = 0, заявка не найдена или нет прав → data: null (не ошибка).
     * Идентификаторы offline_* сюда не доходят: фронт читает их из offlineDB.
     */
    private function getTicket(Request $request, array $user): ?array
    {
        $callId = (int) ($request->input('call_id') ?? 0);
        if (!$callId) {
            return null;
        }
        return $this->callService->ticketDetailed($callId, $user);
    }

    private function getNotifications(Request $request): array
    {
        $sinceId = (int) ($request->input('since_id') ?? 0);

        // Приводим к массиву: клиент может прислать null или строку,
        // а getOutdated типизирован array — иначе TypeError → internal_error.
        $clientVersions = $request->input('versions');
        $clientVersions = is_array($clientVersions) ? $clientVersions : [];

        $pollingData = $this->notificationsService->getSince($sinceId);
        $pollingData['versions'] = $this->addressCacheService->getVersions();
        $pollingData['outdated'] = $this->addressCacheService->getOutdated($clientVersions);

        return $pollingData;
    }

    /**
     * Пакетная обработка офлайн-команд с гарантией идемпотентности.
     *
     * v5.4: клиент шлёт по одной команде, сервер принимает 1–20 для
     * совместимости. Структура намеренно сохранена — упрощения (удаление
     * кэша пачки, summary, batch_id) идут после стабилизации.
     */
    private function handleSyncCommands(array $user, Request $request): array
    {
        $batchId = (string) ($request->input('batch_id') ?? '');
        $commands = $request->input('commands') ?? [];

        $this->validateBatchRequests($batchId, is_array($commands) ? $commands : []);

        // Уровень 1: идемпотентность всей пачки (§11.2, deprecated).
        // B2.5: TTL 30 дней — иначе протухший кэш ответа вернёт старый
        // результат вместо выполнения команды.
        $cachedResponse = $this->db->fetchOne(
            sprintf(
                "SELECT response_payload FROM offline_sync_log
                 WHERE batch_id = :batch_id
                   AND created_at > NOW() - INTERVAL %d DAY",
                self::SYNC_LOG_TTL_DAYS
            ),
            ['batch_id' => $batchId]
        );

        if ($cachedResponse && !empty($cachedResponse['response_payload'])) {
            $decoded = json_decode($cachedResponse['response_payload'], true);
            if (is_array($decoded)) {
                return $decoded;
            }
        }

        // created_tickets — объект {}, а не массив []: пустой PHP-массив
        // уехал бы в JSON как [], и клиент не смог бы читать его по ключу.
        $context = [
            'batch_id' => $batchId,
            'results' => [],
            'summary' => [
                'success' => 0,
                'archived' => 0,
                'ignored' => 0,
                'failed' => 0,
                'duplicate_detected' => 0,
            ],
            'created_tickets' => (object) [],
        ];

        $createdTicketsMap = [];

        // B2.4: какие слои заявок затронуты успешными командами.
        // Копим внутри транзакции, инкрементим строго после коммита.
        $touched = ['open' => false, 'closed' => false];

        $this->db->beginTransaction();
        try {
            foreach ($commands as $cmd) {
                if (!is_array($cmd)) {
                    continue;
                }
                $this->processSingleSyncCommand($user, $cmd, $context, $createdTicketsMap, $touched);
            }

            if (!empty($createdTicketsMap)) {
                $context['created_tickets'] = $createdTicketsMap;
            }

            // Слепок ответа для идемпотентности верхнего уровня.
            // INVALID_UTF8_SUBSTITUTE: битая кодировка в payload не должна
            // валить json_encode в false — колонка имеет CHECK(json_valid),
            // и вся пачка откатилась бы из-за одного мусорного символа.
            $this->upsertSyncLog(
                $batchId,
                (int) $user['id'],
                (string) json_encode($context, JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE)
            );

            $this->db->commit();
        } catch (\Throwable $e) {
            $this->db->rollBack();
            throw new ApiException(
                ErrorCode::InternalError,
                'Ошибка синхронизации офлайн-команд: ' . $e->getMessage()
            );
        }

        // B2.4: инкремент версий строго ПОСЛЕ коммита — иначе клиент
        // увидит новую версию и придёт за данными, которых ещё нет.
        //
        // Переходно: CallService пока зовёт invalidateTickets() (оба ключа)
        // внутри себя, поэтому до шага 8 будет двойной инкремент. Это не
        // ошибка — версии монотонны, клиент просто перечитает слой лишний раз.
        if ($touched['open']) {
            $this->addressCacheService->invalidateOpenTickets();
        }
        if ($touched['closed']) {
            $this->addressCacheService->invalidateClosedTickets();
        }

        return $context;
    }

    /**
     * Валидация ограничений входящего пакета (§3.3).
     * B2.8: конкретика уходит в reason, а не префиксом в message.
     */
    private function validateBatchRequests(string $batchId, array $commands): void
    {
        if ($batchId === '' || mb_strlen($batchId) > 64) {
            throw new ApiException(ErrorCode::InvalidInput, 'Некорректный batch_id', reason: 'invalid_batch_id');
        }
        if (empty($commands)) {
            throw new ApiException(ErrorCode::InvalidInput, 'Пакет не содержит команд', reason: 'commands_empty');
        }
        if (count($commands) > 20) {
            throw new ApiException(ErrorCode::InvalidInput, 'Слишком много команд в пакете', reason: 'commands_too_many');
        }

        $uuids = array_column($commands, 'command_uuid');
        if (count($uuids) !== count(array_unique($uuids))) {
            throw new ApiException(ErrorCode::InvalidInput, 'Повторяющийся command_uuid в пакете', reason: 'duplicate_command_uuid');
        }
    }

    /**
     * Обработка одной изолированной команды пакета.
     *
     * @param array $touched флаги затронутых слоёв заявок для матрицы B2.4
     */
    private function processSingleSyncCommand(
        array $user,
        array $cmd,
        array &$context,
        array &$createdTicketsMap,
        array &$touched
    ): void {
        $uuid = (string) ($cmd['command_uuid'] ?? '');
        $type = (string) ($cmd['command_type'] ?? '');
        $ticketId = (int) ($cmd['ticket_id'] ?? 0);
        $offlineUuid = $cmd['offline_uuid'] ?? null;
        $batchId = $context['batch_id'];

        $rawPayload = $cmd['payload'] ?? [];
        $payload = is_array($rawPayload) ? $rawPayload : [];

        // B2.12: AcceptTicket зарезервирован за мобильным клиентом.
        // Архивируем ДО проверки прав и ticket_id: иначе команда уходит в
        // failed и клиент повторяет её вечно, блокируя свою заявку.
        if ($type === 'AcceptTicket') {
            $this->pushArchived(
                $uuid,
                $batchId,
                $type,
                $payload,
                'reserved_for_mobile',
                'Команда зарезервирована для мобильного клиента',
                $context
            );
            return;
        }

        // B2.9: force_create из входящего payload вырезаем безусловно.
        // Иначе клиент (или подделанный запрос) обходит проверку дублей
        // без подтверждения диспетчера. Источник истины — уровень команды,
        // и только для CreateTicket (§3.2).
        unset($payload['force_create']);
        if ($type === 'CreateTicket' && isset($cmd['force_create'])) {
            $payload['force_create'] = (bool) $cmd['force_create'];
        }

        $payload['offline_author_id'] = $cmd['offline_author_id'] ?? $user['id'];
        $payload['offline_author_name'] = $cmd['offline_author_name'] ?? $user['name'];
        $payload['offline_uuid'] = $offlineUuid;

        // ticket_id из корня команды прокидываем в payload: CallService
        // читает call_id, а не ticket_id.
        $payload['call_id'] = $ticketId;

        // Уровень 2: идемпотентность команды (§11.1) + B2.5 TTL 7 дней.
        $existing = $this->db->fetchOne(
            sprintf(
                "SELECT status, ticket_id FROM offline_command_log
                 WHERE command_uuid = :uuid
                   AND created_at > NOW() - INTERVAL %d DAY",
                self::COMMAND_LOG_TTL_DAYS
            ),
            ['uuid' => $uuid]
        );

        if ($existing) {
            $pastStatus = (string) ($existing['status'] ?? '');

            // B2.1: терминальные — только success и archived.
            // duplicate_detected исключён: он означает «ждёт решения»,
            // заявка не создана. Иначе повтор с force_create и тем же uuid
            // вернёт ignored, и заявка не создастся, хотя клиент покажет успех.
            if (in_array($pastStatus, ['success', 'archived'], true)) {
                $context['summary']['ignored']++;

                $resolvedId = (int) ($existing['ticket_id'] ?? 0);

                // B2.13: связываем локальную заявку с серверным номером.
                // Без этого после обрыва связи клиент не может перевести
                // карточку с offline_uuid на серверный ID.
                if ($type === 'CreateTicket' && $offlineUuid) {
                    if ($resolvedId === 0) {
                        $resolvedId = $this->findTicketIdByOfflineUuid((string) $offlineUuid);
                    }
                    if ($resolvedId > 0) {
                        $createdTicketsMap[(string) $offlineUuid] = $resolvedId;
                    }
                }

                $result = [
                    'command_uuid' => $uuid,
                    'status' => 'ignored',
                    'reason' => 'already_processed',
                    'ticket_id' => $resolvedId,
                    'message' => 'Команда уже была обработана ранее',
                ];
                if ($resolvedId > 0) {
                    $result['server_id'] = $resolvedId;
                }

                $context['results'][] = $result;
                return;
            }

            // failed и duplicate_detected → лог удаляем, команда выполняется
            // заново по Retry-контракту (§11.1).
            $this->db->execute(
                "DELETE FROM offline_command_log WHERE command_uuid = ?",
                [$uuid]
            );
        }

        // Валидация ticket_id для команд изменений (§3.2).
        if ($type !== 'CreateTicket' && $ticketId === 0) {
            $context['summary']['failed']++;
            $context['results'][] = [
                'command_uuid' => $uuid,
                'status' => 'failed',
                'reason' => 'missing_ticket_id',
                'message' => 'ticket_id обязателен для этой команды',
            ];
            $this->writeCommandLog($uuid, $batchId, $type, 'failed', null);
            return;
        }

        try {
            $this->checkCommandPermissions($user, $type);

            $res = $this->executeCommandBusinessLogic($user, $type, $payload);

            $context['summary']['success']++;
            $serverTicketId = (int) ($res['call_id'] ?? $ticketId);

            $this->writeCommandLog($uuid, $batchId, $type, 'success', $serverTicketId);

            $context['results'][] = [
                'command_uuid' => $uuid,
                'status' => 'success',
                'ticket_id' => $serverTicketId,
                'server_id' => $serverTicketId,
                'offline_uuid' => $offlineUuid,
                'message' => $res['message'] ?? 'Команда выполнена',
            ];

            if ($type === 'CreateTicket' && $offlineUuid) {
                $createdTicketsMap[(string) $offlineUuid] = $serverTicketId;
            }

            // B2.4: матрица затронутых слоёв.
            // Закрытость создания определяем по solution — ровно то же
            // условие, по которому CallService ставит call_status = 1.
            if ($type === 'CloseTicket') {
                // Заявка уходит из открытых в закрытые — меняются оба слоя.
                $touched['open'] = true;
                $touched['closed'] = true;
            } elseif ($type === 'CreateTicket' && trim((string) ($payload['solution'] ?? '')) !== '') {
                $touched['closed'] = true;
            } else {
                // CreateTicket (открытая), EditTicket, AddComment.
                $touched['open'] = true;
            }
        } catch (ApiException $e) {
            $this->archiveApiException($uuid, $batchId, $type, $payload, $e, $context);
        } catch (\Throwable $e) {
            $this->handleFatalThrowable($uuid, $batchId, $type, $payload, $e, $context);
        }
    }

    /**
     * Контроль прав ролей к типам команд (§2.2).
     *
     * B2.8: конкретика в reason, без префикса 'no_rights:' в message.
     *
     * Переходно: проверка остаётся ролевой. Флаг user_add_call сюда
     * недоступен — AuthService::formatUser его не возвращает. Уважение
     * флага делаем в B3 вместе с CallPolicy, чтобы не плодить третью
     * копию логики прав (сейчас их две: здесь и can_* в репозитории).
     */
    private function checkCommandPermissions(array $user, string $type): void
    {
        $role = (string) ($user['role'] ?? 'guest');

        if ($type === 'CreateTicket' || $type === 'EditTicket') {
            if ($role !== 'administrator' && $role !== 'dispatcher') {
                throw new ApiException(
                    ErrorCode::Forbidden,
                    'Роль не имеет прав на это действие',
                    reason: 'no_rights'
                );
            }
        } elseif ($type === 'CloseTicket' || $type === 'AddComment') {
            if ($role !== 'administrator' && $role !== 'dispatcher' && $role !== 'engineer') {
                throw new ApiException(
                    ErrorCode::Forbidden,
                    'Роль не имеет прав на это действие',
                    reason: 'no_rights'
                );
            }
        } else {
            throw new \InvalidArgumentException('unknown_command_type');
        }
    }

    /**
     * Вызов методов CallService с явным указанием источника действия.
     */
    private function executeCommandBusinessLogic(array $user, string $type, array $payload): array
    {
        return match ($type) {
            'CreateTicket' => $this->callService->callnew($user, $payload, 'offline_sync'),
            'EditTicket'   => $this->callService->calledit($user, $payload, 'offline_sync'),
            'CloseTicket'  => $this->callService->callClose($user, $payload, 'offline_sync'),
            'AddComment'   => $this->callService->callnote($user, $payload, 'offline_sync'),
            default        => throw new \InvalidArgumentException('unknown_command_type')
        };
    }

    /**
     * Ожидаемые бизнес-ошибки: валидация, дубликаты, закрытые заявки.
     */
    private function archiveApiException(
        string $uuid,
        string $batchId,
        string $type,
        array $payload,
        ApiException $e,
        array &$context
    ): void {
        $message = $e->getMessage();
        $reason = $e->reason ?? null;
        $details = $e->details ?? [];

        // 8.10: дубликат определяем по reason. Разбор префикса в message
        // оставлен как переходная мера — CallService переедет на reason
        // на шаге 8, после чего фолбэк можно удалить.
        $legacyPrefix = 'duplicate_detected:';
        $isDuplicate = $reason === 'duplicate_detected'
            || str_starts_with($message, $legacyPrefix);

        if ($isDuplicate) {
            $existingTickets = [];

            if (is_array($details) && isset($details['existing_tickets']) && is_array($details['existing_tickets'])) {
                $existingTickets = $details['existing_tickets'];
            } elseif (str_starts_with($message, $legacyPrefix)) {
                $decoded = json_decode(substr($message, strlen($legacyPrefix)), true);
                $existingTickets = is_array($decoded) ? $decoded : [];
            }

            $context['summary']['duplicate_detected']++;

            // Статус не терминальный: повтор с force_create пройдёт мимо
            // проверки идемпотентности и создаст заявку (B2.1).
            $this->writeCommandLog($uuid, $batchId, $type, 'duplicate_detected', null);

            // existing_tickets — плоско, без обёртки details (§10.1,
            // API_PROTOCOL §7.3). Клиент читает result.existing_tickets.
            $context['results'][] = [
                'command_uuid' => $uuid,
                'status' => 'duplicate_detected',
                'reason' => 'duplicate_detected',
                'existing_tickets' => $existingTickets,
                'message' => 'На объект уже есть активная заявка',
            ];
            return;
        }

        // B2.8: явный reason из исключения приоритетнее маппинга по коду —
        // иначе object_not_found превратился бы в ticket_not_found.
        $resolvedReason = $reason ?: $this->mapErrorCodeToReason($e->errorCode);

        $this->pushArchived($uuid, $batchId, $type, $payload, $resolvedReason, $message, $context);
    }

    /**
     * Системные сбои → failed для повтора на клиенте (§3.3).
     * Детали ошибки — только в архив, клиенту generic-текст.
     */
    private function handleFatalThrowable(
        string $uuid,
        string $batchId,
        string $type,
        array $payload,
        \Throwable $e,
        array &$context
    ): void {
        $context['summary']['failed']++;

        $this->writeArchive(
            $uuid,
            $batchId,
            $type,
            'internal_error',
            'Внутренняя ошибка: ' . $e->getMessage(),
            $payload
        );
        $this->writeCommandLog($uuid, $batchId, $type, 'failed', null);

        $context['results'][] = [
            'command_uuid' => $uuid,
            'status' => 'failed',
            'reason' => 'internal_error',
            'message' => 'Внутренняя ошибка сервера',
        ];
    }

    /**
     * Единая точка архивирования отброшенной команды.
     * Используется и бизнес-ошибками, и AcceptTicket (B2.12).
     */
    private function pushArchived(
        string $uuid,
        string $batchId,
        string $type,
        array $payload,
        string $reason,
        string $message,
        array &$context
    ): void {
        $context['summary']['archived']++;

        $this->writeArchive($uuid, $batchId, $type, $reason, $message, $payload);
        $this->writeCommandLog($uuid, $batchId, $type, 'archived', null);

        $context['results'][] = [
            'command_uuid' => $uuid,
            'status' => 'archived',
            'reason' => $reason,
            'message' => $message,
        ];
    }

    /**
     * Запись лога команды — upsert.
     *
     * Зачем не INSERT: в таблице UNIQUE(command_uuid). TTL-фильтр в SELECT
     * прячет истёкшую строку, код считает команду новой и делает INSERT —
     * получаем Duplicate entry и failed навсегда. Ровно тот баг, который
     * TTL призван исправить.
     *
     * created_at обновляем принудительно: иначе строка останется с датой
     * восьмидневной давности, сразу будет «истёкшей», и каждый следующий
     * повтор выполнит команду заново. Окно TTL должно считаться от
     * последней записи.
     */
    private function writeCommandLog(
        string $uuid,
        string $batchId,
        string $type,
        string $status,
        ?int $ticketId
    ): void {
        $this->db->execute(
            "INSERT INTO offline_command_log (command_uuid, batch_id, command_type, status, ticket_id)
             VALUES (?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE
                 batch_id     = VALUES(batch_id),
                 command_type = VALUES(command_type),
                 status       = VALUES(status),
                 ticket_id    = VALUES(ticket_id),
                 created_at   = CURRENT_TIMESTAMP",
            [$uuid, $batchId, $type, $status, $ticketId]
        );
    }

    /**
     * Запись архива отброшенных команд — upsert по тому же основанию.
     * Если UNIQUE по command_uuid в таблице нет, ON DUPLICATE не сработает
     * и запрос останется обычным INSERT — поведение корректно в обоих случаях.
     */
    private function writeArchive(
        string $uuid,
        string $batchId,
        string $type,
        string $reason,
        string $message,
        array $payload
    ): void {
        $this->db->execute(
            "INSERT INTO offline_actions_archive
                 (command_uuid, batch_id, command_type, reason, message, payload_snapshot)
             VALUES (?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE
                 batch_id         = VALUES(batch_id),
                 command_type     = VALUES(command_type),
                 reason           = VALUES(reason),
                 message          = VALUES(message),
                 payload_snapshot = VALUES(payload_snapshot)",
            [
                $uuid,
                $batchId,
                $type,
                // Обрезка по фактической ширине колонок: длинный текст
                // SQL-ошибки иначе даст 1406 Data too long → откат пачки.
                mb_substr($reason, 0, 64),
                mb_substr($message, 0, 500),
                (string) json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE),
            ]
        );
    }

    /**
     * Кэш ответа пачки — upsert по UNIQUE(batch_id), TTL обновляется.
     * Причина та же, что у writeCommandLog.
     */
    private function upsertSyncLog(string $batchId, int $userId, string $responseJson): void
    {
        $this->db->execute(
            "INSERT INTO offline_sync_log (batch_id, tenant_id, user_id, response_payload)
             VALUES (?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE
                 tenant_id        = VALUES(tenant_id),
                 user_id          = VALUES(user_id),
                 response_payload = VALUES(response_payload),
                 created_at       = CURRENT_TIMESTAMP",
            [$batchId, $this->tenant?->id ?? 'unknown', $userId, $responseJson]
        );
    }

    /**
     * B2.13: фолбэк поиска серверного номера по offline_uuid.
     *
     * Точечный запрос вместо нового метода CallService — чтобы шаг 9
     * не тянул за собой правку сервиса. Перенесём в репозиторий на шаге 8.
     */
    private function findTicketIdByOfflineUuid(string $offlineUuid): int
    {
        $row = $this->db->fetchOne(
            "SELECT call_id FROM lift_calls WHERE offline_uuid = :uuid LIMIT 1",
            ['uuid' => $offlineUuid]
        );

        return (int) ($row['call_id'] ?? 0);
    }

    /**
     * B2.7: протокольные имена причин (§14).
     * Клиент нормализует старые значения переходной мерой, но новые
     * интеграции должны получать сразу правильные.
     */
    private function mapErrorCodeToReason(ErrorCode $code): string
    {
        return match ($code) {
            ErrorCode::InvalidInput => 'validation_error',
            ErrorCode::NotFound     => 'ticket_not_found',
            ErrorCode::Closed       => 'ticket_already_closed',
            ErrorCode::Forbidden    => 'no_rights',
            ErrorCode::MissingToken => 'auth_error',
            default                 => 'unknown_error'
        };
    }
}