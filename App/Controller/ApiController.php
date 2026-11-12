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
            'ticket' => Response::ok(['data' => $this->getTicket($request, $user)]),
            'syncCommands'  => Response::ok($this->handleSyncCommands($user, $request)),
            default         => throw new ApiException(ErrorCode::UnknownAction, 'Неизвестное действие: ' . $request->action)
        };
    }

    /**
     * Эндпоинт одной заявки (§12.2).
     *
     * Старая реализация перебирала списки open + close('365'):
     * это тяжело при тысячах заявок и не находило закрытые старше года.
     * Теперь — прямой запрос по ID через сервис и репозиторий.
     *
     * Особые случаи протокола:
     * - call_id = 0, заявка не найдена или нет прав → data: null (не ошибка);
     * - идентификаторы offline_* сюда не доходят: фронтенд читает их из offlineDB.
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
        $clientVersions = $request->input('versions') ?? [];

        $pollingData = $this->notificationsService->getSince($sinceId);
        $pollingData['versions'] = $this->addressCacheService->getVersions();
        $pollingData['outdated'] = $this->addressCacheService->getOutdated($clientVersions);

        return $pollingData;
    }
    /**
     * Пакетная обработка офлайн-команд с гарантией идемпотентности.
     * Протокол v5.2: Декомпозированная архитектура без глубокой вложенности try-catch
     */
    /**
     * Пакетная обработка офлайн-команд с гарантией идемпотентности.
     * Протокол v5.2: Декомпозированная архитектура без глубокой вложенности try-catch
     */
    private function handleSyncCommands(array $user, Request $request): array
    {
        $batchId = (string) ($request->input('batch_id') ?? '');
        $commands = $request->input('commands') ?? [];

        // 🛡️ Валидация лимитов пачки
        $this->validateBatchRequests($batchId, $commands);

        // 🛡️ Уровень 1: Идемпотентность всей пачки (Кэш ответа §9.1)
        $cachedResponse = $this->db->fetchOne(
            "SELECT response_payload FROM offline_sync_log WHERE batch_id = :batch_id",
            ['batch_id' => $batchId]
        );
        if ($cachedResponse && !empty($cachedResponse['response_payload'])) {
            $decoded = json_decode($cachedResponse['response_payload'], true);
            if ($decoded) return $decoded;
        }

        // 🌟 ИСПРАВЛЕНО: 'created_tickets' теперь гарантированно инициализируется как объект {}, а не массив []
        $context = [
            'batch_id' => $batchId,
            'results' => [],
            'summary' => ['success' => 0, 'archived' => 0, 'ignored' => 0, 'failed' => 0, 'duplicate_detected' => 0],
            'created_tickets' => (object)[]
        ];

        // Временный массив для накопления созданных тикетов внутри прохода
        $createdTicketsMap = [];

        // 🔄 НАЧИНАЕМ ТРАНЗАКЦИЮ СУБД
        $this->db->beginTransaction();
        try {
            foreach ($commands as $cmd) {
                $this->processSingleSyncCommand($user, $cmd, $context, $createdTicketsMap);
            }

            // Переносим собранную мапу в контекст ответа
            if (!empty($createdTicketsMap)) {
                $context['created_tickets'] = $createdTicketsMap;
            }

            // 💾 Сохраняем слепок ответа для идемпотентности верхнего уровня
            $this->db->execute(
                "INSERT INTO offline_sync_log (batch_id, tenant_id, user_id, response_payload) VALUES (?, ?, ?, ?)",
                [$batchId, $this->tenant?->id ?? 'unknown', (int)$user['id'], json_encode($context, JSON_UNESCAPED_UNICODE)]
            );

            $this->db->commit();

            // 🚨 Инкремент числовой версии слоя заявок строго ПОСЛЕ коммита
            if ($context['summary']['success'] > 0) {
                $this->addressCacheService->invalidateTickets();
            }

            return $context;

        } catch (\Throwable $e) {
            $this->db->rollBack();
            throw new ApiException(ErrorCode::InternalError, 'Ошибка синхронизации офлайн-команд: ' . $e->getMessage());
        }
    }


    /**
     * Валидация ограничений входящего пакета команд
     */
    private function validateBatchRequests(string $batchId, array $commands): void
    {
        if ($batchId === '' || mb_strlen($batchId) > 64) {
            throw new ApiException(ErrorCode::InvalidInput, 'invalid_input: invalid_batch_id');
        }
        if (empty($commands)) {
            throw new ApiException(ErrorCode::InvalidInput, 'invalid_input: commands_empty');
        }
        if (count($commands) > 20) {
            throw new ApiException(ErrorCode::InvalidInput, 'invalid_input: commands_too_many');
        }
        $uuids = array_column($commands, 'command_uuid');
        if (count($uuids) !== count(array_unique($uuids))) {
            throw new ApiException(ErrorCode::InvalidInput, 'invalid_input: duplicate_command_uuid');
        }
    }
    /**
     * Обработка одной изолированной команды пакета
     */
    /**
     * Обработка одной изолированной команды пакета с умной идемпотентностью и пробросом ticket_id
     */
    private function processSingleSyncCommand(array $user, array $cmd, array &$context, array &$createdTicketsMap): void
    {
        $uuid = (string) ($cmd['command_uuid'] ?? '');
        $type = (string) ($cmd['command_type'] ?? '');
        $ticketId = (int) ($cmd['ticket_id'] ?? 0);
        $offlineUuid = $cmd['offline_uuid'] ?? null;
        $batchId = $context['batch_id'];

        // Формируем payload сущности
        $payload = $cmd['payload'] ?? [];
        if (isset($cmd['force_create'])) {
            $payload['force_create'] = (bool)$cmd['force_create'];
        }
        $payload['offline_author_id'] = $cmd['offline_author_id'] ?? $user['id'];
        $payload['offline_author_name'] = $cmd['offline_author_name'] ?? $user['name'];
        $payload['offline_uuid'] = $offlineUuid;

        // 🌟 ИСПРАВЛЕНО (Фикс Причины №1): Принудительно пробрасываем ticket_id из корня команды в payload для CallService
        $payload['call_id'] = $ticketId;

        // 🌟 ИСПРАВЛЕНО (Фикс Причины №2): Умная проверка идемпотентности на основе статуса лога
        $existing = $this->db->fetchOne("SELECT status, ticket_id FROM offline_command_log WHERE command_uuid = :uuid", ['uuid' => $uuid]);
        if ($existing) {
            $pastStatus = (string)($existing['status'] ?? '');

            // Если статус терминальный (success, archived, duplicate_detected) -> возвращаем ignored
            if (in_array($pastStatus, ['success', 'archived', 'duplicate_detected'], true)) {
                $context['summary']['ignored']++;
                $context['results'][] = [
                    'command_uuid' => $uuid, 'status' => 'ignored',
                    'ticket_id' => (int)($existing['ticket_id'] ?? 0), 'message' => 'Команда уже была успешно обработана ранее'
                ];
                return;
            }
            // Если статус 'failed', мы НЕ выходим через return, а затираем старый лог и выполняем команду заново по Retry-контракту
            $this->db->execute("DELETE FROM offline_command_log WHERE command_uuid = ?", [$uuid]);
        }

        // 🛡️ Валидация отсутствия ticket_id для команд изменений (§11.2)
        if ($type !== 'CreateTicket' && $ticketId === 0) {
            $context['summary']['failed']++;
            $context['results'][] = [
                'command_uuid' => $uuid, 'status' => 'failed', 'reason' => 'missing_ticket_id', 'message' => 'ticket_id обязателен для этой команды'
            ];
            $this->db->execute(
                "INSERT INTO offline_command_log (command_uuid, batch_id, command_type, status, ticket_id) VALUES (?, ?, ?, 'failed', NULL)",
                [$uuid, $batchId, $type]
            );
            return;
        }

        try {
            // Проверка прав ролей пользователей
            $this->checkCommandPermissions($user, $type);

            // Проброс исполнения в сервис бизнес-логики с явным оффлайн источником
            $res = $this->executeCommandBusinessLogic($user, $type, $payload);

            $context['summary']['success']++;
            $serverTicketId = (int) ($res['call_id'] ?? $ticketId);

            $this->db->execute(
                "INSERT INTO offline_command_log (command_uuid, batch_id, command_type, status, ticket_id) VALUES (?, ?, ?, 'success', ?)",
                [$uuid, $batchId, $type, $serverTicketId]
            );

            $context['results'][] = [
                'command_uuid' => $uuid, 'status' => 'success', 'ticket_id' => $serverTicketId,
                'server_id' => $serverTicketId, 'offline_uuid' => $offlineUuid, 'message' => $res['message'] ?? 'Команда выполнена'
            ];

            if ($type === 'CreateTicket' && $offlineUuid) {
                $createdTicketsMap[$offlineUuid] = $serverTicketId;
            }

        } catch (ApiException $e) {
            $this->archiveApiException($uuid, $batchId, $type, $payload, $e, $context);
        } catch (\Throwable $e) {
            $this->handleFatalThrowable($uuid, $batchId, $type, $payload, $e, $context);
        }
    }

    /**
     * Контроль уровней прав доступа ролей к типам команд (§2.2)
     */
    private function checkCommandPermissions(array $user, string $type): void
    {
        $role = $user['role'] ?? 'guest';

        if ($type === 'CreateTicket' || $type === 'EditTicket') {
            if ($role !== 'administrator' && $role !== 'dispatcher') {
                throw new ApiException(ErrorCode::Forbidden, 'no_rights: роль не имеет прав на это действие');
            }
        } elseif ($type === 'CloseTicket' || $type === 'AddComment') {
            if ($role !== 'administrator' && $role !== 'dispatcher' && $role !== 'engineer') {
                throw new ApiException(ErrorCode::Forbidden, 'no_rights: роль не имеет прав на это действие');
            }
        } else {
            throw new \InvalidArgumentException('unknown_command_type');
        }
    }

    /**
     * Вызов методов CallService с явным указанием источника действия
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
     * Изолированная обработка ожидаемых бизнес-ошибок (Валидация, Дубликаты, Закрытые тикеты)
     */
    private function archiveApiException(string $uuid, string $batchId, string $type, array $payload, ApiException $e, array &$context): void
    {
        $message = $e->getMessage();

        // 🛡️ Фиксация обнаружения 100% дубликатов на объекте (§5)
        if (str_starts_with($message, 'duplicate_detected:')) {
            $context['summary']['duplicate_detected']++;
            $existingTickets = json_decode(substr($message, 19), true) ?: [];

            $this->db->execute(
                "INSERT INTO offline_command_log (command_uuid, batch_id, command_type, status, ticket_id) VALUES (?, ?, ?, 'duplicate_detected', NULL)",
                [$uuid, $batchId, $type]
            );

            $context['results'][] = [
                'command_uuid' => $uuid,
                'status' => 'duplicate_detected',
                'existing_tickets' => $existingTickets,
                'message' => 'Обнаружена активная заявка на данном объекте'
            ];
            return;
        }

        // Стандартная бизнес-ошибка (Команда отбрасывается в архив и удаляется из outbox на клиенте)
        $context['summary']['archived']++;
        $reason = $this->mapErrorCodeToReason($e->errorCode);

        $this->db->execute(
            "INSERT INTO offline_actions_archive (command_uuid, batch_id, command_type, reason, message, payload_snapshot) VALUES (?, ?, ?, ?, ?, ?)",
            [$uuid, $batchId, $type, $reason, $message, json_encode($payload, JSON_UNESCAPED_UNICODE)]
        );

        $this->db->execute(
            "INSERT INTO offline_command_log (command_uuid, batch_id, command_type, status, ticket_id) VALUES (?, ?, ?, 'archived', NULL)",
            [$uuid, $batchId, $type]
        );

        $context['results'][] = [
            'command_uuid' => $uuid,
            'status' => 'archived',
            'reason' => $reason,
            'message' => $message
        ];
    }

    /**
     * Изолированная обработка системных сбоев (Маркируется как failed для повтора на клиенте §3.3)
     */
    private function handleFatalThrowable(string $uuid, string $batchId, string $type, array $payload, \Throwable $e, array &$context): void
    {
        $context['summary']['failed']++;
        $reason = 'internal_error';

        $this->db->execute(
            "INSERT INTO offline_actions_archive (command_uuid, batch_id, command_type, reason, message, payload_snapshot) VALUES (?, ?, ?, ?, ?, ?)",
            [$uuid, $batchId, $type, $reason, 'Внутренняя ошибка: ' . $e->getMessage(), json_encode($payload, JSON_UNESCAPED_UNICODE)]
        );

        $this->db->execute(
            "INSERT INTO offline_command_log (command_uuid, batch_id, command_type, status, ticket_id) VALUES (?, ?, ?, 'failed', NULL)",
            [$uuid, $batchId, $type]
        );

        $context['results'][] = [
            'command_uuid' => $uuid,
            'status' => 'failed',
            'reason' => $reason,
            'message' => 'Внутренняя ошибка сервера'
        ];
    }

    /**
     * Маппинг кодов внутренней архитектуры на строковые причины для архива
     */
    private function mapErrorCodeToReason(ErrorCode $code): string
    {
        return match ($code) {
            ErrorCode::InvalidInput => 'validation_error',
            ErrorCode::NotFound     => 'not_found',
            ErrorCode::Closed       => 'ticket_closed',
            ErrorCode::Forbidden    => 'no_rights',
            ErrorCode::MissingToken => 'auth_error',
            default                 => 'unknown_error'
        };
    }
}


