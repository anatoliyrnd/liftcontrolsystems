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
    NotificationsService,      // ← ДОБАВЛЕНО
    AddressCacheService        // ← ДОБАВЛЕНО
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

    // Конструктор приватный, создание только через create()
    private function __construct(
        AuthService $authService,
        CallService $callService,
        ConfigService $configService,
        AddressService $addressService,
        DB $db,
        NotificationsService $notificationsService,
        AddressCacheService $addressCacheService
    ) {
        $this->authService = $authService;
        $this->callService = $callService;
        $this->configService = $configService;
        $this->addressService = $addressService;
        $this->db = $db;
        $this->notificationsService = $notificationsService;
        $this->addressCacheService = $addressCacheService;
    }

    public static function create(): self
    {
        $tenant = Tenant::fromRequest();
        $db = DB::forTenant($tenant);

        $userRepo = new UserRepository($db);
        $callRepo = new CallRepository($db);
        $noteRepo = new NoteRepository($db);
        $historyRepo = new HistoryRepository($db);

        $legacyProxy = new LegacyProxyService(\LEGACY_API_URL ?? '', \LEGACY_API_SECRET ?? '');
       $configService = new ConfigService($db, $tenant); 
        $addressService = new AddressService($db);
        $notificationsService = new NotificationsService($db);
        $addressCacheService = new AddressCacheService($db);

        return new self(
            new AuthService($userRepo),
            new CallService(
                $callRepo,
                $noteRepo,
                $historyRepo,
                $legacyProxy,
                $configService,
                $notificationsService,
                $tenant
            ),
            $configService,
            $addressService,
            $db,
            $notificationsService,
            $addressCacheService
        );
    }

    public function handle(Request $request): Response
    {
        if ($request->bearer === null)
            throw new ApiException(ErrorCode::MissingToken, 'Требуется авторизация');

        $user = $this->authService->validate($request->bearer);

        return match ($request->action) {
            'config' => new Response(['status' => 'ok'] + $this->configService->getConfig($user)),
               'loadAddress' => Response::ok(['action' => 'loadAddress', 'message' => $this->addressService->getAddresses()]),
            'open' => new Response($this->callService->open($user)),
            'close' => new Response($this->callService->close($user, $request->input('period'))),
            'calledit' => Response::ok($this->callService->calledit($user, $request->body)),
            'callClose' => Response::ok($this->callService->callClose($user, $request->body)),
            'callnote' => Response::ok($this->callService->callnote($user, $request->body)),
            'callnew' => Response::ok($this->callService->callnew($user, $request->body)),
            'notifications' => Response::ok($this->getNotifications($request)),
            default => throw new ApiException(ErrorCode::UnknownAction, 'Неизвестное действие: ' . $request->action)
        };
    }

    private function getNotifications(Request $request): array
    {
        $sinceId = (int) ($request->input('since_id') ?? 0);
        $clientVersions = $request->input('versions') ?? [];

        // Используем уже созданные сервисы (не создаём новые!)
        $notifications = $this->notificationsService->getSince($sinceId);
        $outdated = $this->addressCacheService->getOutdated($clientVersions);
        $versions = $this->addressCacheService->getVersions();

        return [
            'notifications' => $notifications['notifications'],
            'last_id' => $notifications['last_id'],
            'versions' => $versions,
            'outdated' => $outdated,
        ];
    }
}