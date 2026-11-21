<?php

declare(strict_types=1);

/**
 * Обновление демо-базы заявок: полная очистка + генерация заново.
 * 0 8 * * * /usr/bin/php8.4 /home/users/z/zamotaev/domains/_cron/demo_seed.php --confirm=zamotaev_demo_liftcs >> /home/users/z/zamotaev/domains/_demoseed/cron.log 2>&1
 * ЗАЧЕМ: посетители демо создают свои заявки, база засоряется. Проще
 * снести все заявки и наполнить свежими, привязанными к текущей дате,
 * чем чистить выборочно. Крон в 08:00.
 * план без записи
 * /usr/bin/php8.4 demo_seed.php --confirm=zamotaev_demo_liftcs --dry-run
 * полное обновление
 * /usr/bin/php8.4 demo_seed.php --confirm=zamotaev_demo_liftcs
 * только очистка
 * /usr/bin/php8.4 demo_seed.php --confirm=zamotaev_demo_liftcs --wipe-only
 * РАЗМЕЩЕНИЕ НЕ ВАЖНО. Все пути — данные:
 *   - учётные данные и app_root берутся из файла вне web-root;
 *   - каталог состояния = каталог этого файла;
 *   - Address.php подключается по app_root напрямую.
 * Bootstrap проекта НЕ подключается: он тянет config/admin.php с ключом
 * шифрования и тенантный автозагрузчик, которые генератору не нужны.
 * Address — чистый final class без импортов проекта и без guard
 * APP_ENTRY_POINT (проверено по файлу), поэтому прямой require работает.
 * Если Address когда-нибудь обзаведётся зависимостью, require упадёт
 * громко на первом же запуске — это устраивает.
 *
 * ПОДКЛЮЧЕНИЕ ПРЯМОЕ, без Tenant и DB::forTenant. Пользователь MySQL
 * имеет гранты ТОЛЬКО на демо-БД и не видит master-реестр тенантов:
 * резолв тенанта с такими правами невозможен в принципе. Обходить
 * наименьшие привилегии ради красивого DI нельзя.
 *
 * Побочная выгода: PDOException отдаёт настоящий текст SQL-ошибки.
 * Обёртка DB прячет его в лог и наружу даёт фиксированную строку.
 *
 * Распределения — из агрегатов рабочей легаси-базы (90 дней, 2859
 * заявок, 568 лифтов): объём, перекос по лифтам, смесь отдел×тип×группа,
 * длительности закрытия, профиль часа и дня недели, длины текстов,
 * сами формулировки решений и заметок.
 *
 * СИНТЕТИКА (в легаси этих данных нет), помечена в коде:
 *   repair_time_is_default, слоты 2/3, notify_status 0..7,
 *   длительность закрытия застреваний, хвосты СПульт-описаний.
 * alert_level — правило CallService, не синтетика.
 *
 * ИНВАРИАНТЫ:
 *   - закрытые заметки живут ТОЛЬКО в call_full_note_history,
 *     открытых — только в lift_notes;
 *   - call_adres собирается тем же Address::formatDisplay, что и
 *     CallService, иначе демо разойдётся с боевым форматом;
 *   - lift_notes.note_body и lift_history.history_info — utf8mb3,
 *     4-байтные символы туда не пишем никогда;
 *   - offline_uuid UNIQUE: пустая строка недопустима, только NULL
 *     или уникальное значение;
 *   - версии слоёв инкрементятся ПОСЛЕ коммита.
 *
 * ЗАПУСК:
 *   /usr/bin/php8.4 demo_seed.php --confirm=zamotaev_demo_liftcs
 */

// Guard ДО всего: при HTTP-запросе файл не должен ничего подключать.
// Если файл лежит вне docroot (domains/_cron), URL на него нет вовсе,
// и этот guard — второй барьер, а не единственный.
if (PHP_SAPI !== 'cli') {
    http_response_code(404);
    exit;
}

// Единая бизнес-зона. Владелец решения — bootstrap.php; здесь дубль
// осознан: bootstrap не подключается. При смене зоны править оба места.
date_default_timezone_set('Europe/Moscow');

// Обработчик ошибок — копия из bootstrap.php.
//
// Проверка error_reporting() ОБЯЗАТЕЛЬНА: в PHP 8 оператор @ выставляет
// маску, и без этой проверки каждое @mkdir/@fopen/@filemtime бросало бы
// ErrorException. Все деградации скрипта построены на @-подавлении.
set_error_handler(static function (int $severity, string $message, string $file, int $line): bool {
    if (!(error_reporting() & $severity)) {
        return false;
    }
    throw new ErrorException($message, 0, $severity, $file, $line);
});

/**
 * Данные генератора: веса и тексты из легаси.
 *
 * Отделены от логики намеренно: это единственное, что будут править
 * при добавлении новых формулировок. Логика рядом с ними не живёт —
 * иначе правка словаря рисковала задеть распределения.
 */
final class DemoSeedData
{
    /** Смесь отдел×тип×группа: 19 комбинаций, топ-3 = 91.8% потока. */
    public const COMBOS = [
        ['dep' => 22, 'req' => 2, 'grp' => 6,  'w' => 1275],
        ['dep' => 23, 'req' => 2, 'grp' => 6,  'w' => 822],
        ['dep' => 23, 'req' => 1, 'grp' => 4,  'w' => 526],
        ['dep' => 22, 'req' => 3, 'grp' => 5,  'w' => 136],
        ['dep' => 22, 'req' => 1, 'grp' => 4,  'w' => 45],
        ['dep' => 22, 'req' => 2, 'grp' => 5,  'w' => 14],
        ['dep' => 23, 'req' => 3, 'grp' => 5,  'w' => 12],
        ['dep' => 23, 'req' => 1, 'grp' => 6,  'w' => 6],
        ['dep' => 22, 'req' => 2, 'grp' => 4,  'w' => 6],
        ['dep' => 23, 'req' => 2, 'grp' => 5,  'w' => 4],
        ['dep' => 22, 'req' => 1, 'grp' => 6,  'w' => 3],
        ['dep' => 22, 'req' => 2, 'grp' => 7,  'w' => 2],
        ['dep' => 22, 'req' => 2, 'grp' => 9,  'w' => 2],
        ['dep' => 23, 'req' => 2, 'grp' => 4,  'w' => 1],
        ['dep' => 22, 'req' => 2, 'grp' => 24, 'w' => 1],
        ['dep' => 22, 'req' => 3, 'grp' => 7,  'w' => 1],
        ['dep' => 23, 'req' => 3, 'grp' => 6,  'w' => 1],
        ['dep' => 23, 'req' => 2, 'grp' => 9,  'w' => 1],
        ['dep' => 22, 'req' => 3, 'grp' => 9,  'w' => 1],
    ];

    /** Сколько лифтов дают N заявок за квартал. 568 лифтов, 2859 заявок. */
    public const LIFT_HISTOGRAM = [
        1 => 141, 2 => 92, 3 => 66, 4 => 61, 5 => 35, 6 => 37, 7 => 19,
        8 => 19, 9 => 15, 10 => 14, 11 => 12, 12 => 8, 13 => 10, 14 => 4,
        15 => 5, 16 => 7, 17 => 2, 18 => 4, 19 => 4, 20 => 1, 22 => 2,
        23 => 1, 24 => 2, 26 => 2, 30 => 1, 31 => 1, 32 => 2, 40 => 1,
    ];

    /** Профиль часа создания. Ночь ~1%, пик 6–8 и 11–19. */
    public const HOUR_WEIGHTS = [
        0 => 10, 1 => 7, 2 => 5, 3 => 2, 4 => 0, 5 => 6, 6 => 200, 7 => 285,
        8 => 152, 9 => 146, 10 => 165, 11 => 205, 12 => 174, 13 => 190,
        14 => 141, 15 => 166, 16 => 179, 17 => 180, 18 => 175, 19 => 198,
        20 => 142, 21 => 82, 22 => 35, 23 => 14,
    ];

    /** День недели: 0 = понедельник … 6 = воскресенье. Выходные −20%. */
    public const WEEKDAY_WEIGHTS = [0 => 410, 1 => 486, 2 => 420, 3 => 415, 4 => 435, 5 => 363, 6 => 330];

    /** Длительности закрытия: <30м / 30–60м / 1–5ч / 5–24ч / >24ч. */
    public const CLOSE_BUCKETS = [0 => 474, 1 => 339, 2 => 1017, 3 => 626, 4 => 374];

    /** Решения — реальные формулировки с частотами. */
    public const SOLUTIONS = [
        'лифт запущен,в работе' => 105,
        'Механиком лифт пущен в работу.' => 72,
        'Лифт в работе.' => 71,
        'Перезапуск' => 68,
        'Лифт запущен норма.' => 66,
        'Перезапуск.' => 54,
        'эвакуация,лифт в работе' => 44,
        'лифт в работе' => 40,
        'перезапуск,лифт в работе' => 36,
        'дубль' => 30,
        'Лифт запущен в нормальную работу.' => 29,
        'Эвакуация. Лифт в работе.' => 28,
        'Лифт в норме.' => 21,
        'Восстановление Цб' => 18,
        'эвакуация' => 18,
        'Смазка направляющих.' => 18,
        'Повтор' => 17,
        'ошибочно' => 17,
        'Повтор.' => 17,
        'эвакуация,лифт запущен,в работе' => 16,
        'Промер Дк' => 16,
        'Ремонт Дк' => 16,
        'настройка привода ДК,лифт в работе' => 15,
        'Лифт в норме. Проверено механиком.' => 14,
        'Ревизия Дк.' => 13,
    ];

    /** Застревания закрываются эвакуацией — отдельный пул. */
    public const SOLUTIONS_ENTRAPMENT = [
        'эвакуация,лифт в работе' => 44,
        'Эвакуация. Лифт в работе.' => 28,
        'эвакуация' => 18,
        'эвакуация,лифт запущен,в работе' => 16,
        'лифт запущен,в работе' => 20,
        'Перезапуск' => 12,
    ];

    /** Быстрое закрытие: дубль/ошибочно/повтор. Для заявок у границы «сейчас». */
    public const SOLUTIONS_FAST = [
        'дубль' => 30, 'ошибочно' => 17, 'Повтор' => 17, 'Повтор.' => 17, 'Перезапуск' => 20,
    ];

    /** Заметки — реальные формулировки с частотами. */
    public const NOTES = [
        'Эвакуация' => 206,
        'Эвакуация.' => 49,
        'Перенос на завтра.' => 18,
        'Кнопка заказана.' => 17,
        'ремонт на завтра' => 16,
        'Требуется ремонт платы ПЗМП' => 13,
        'Требуется ремонт дк' => 12,
        'Сроки ремонта продлены.' => 12,
        'Требуется замена тросика дк' => 11,
        'Требуются сварочные работы' => 11,
        'лифт в работе.' => 11,
        'лифт остановлен на ревизию.' => 10,
        'Кнопка заказана.Ждем поставку.' => 10,
        'лифт в работе' => 10,
        'Требуется замена пускателя.' => 10,
        'лифт остановлен на ремонт.' => 9,
        'кнопка заказана' => 9,
        'Требуется ремонт привода дк буад' => 8,
        'ремонт на завтра.' => 8,
        'Требуется замена канатов и КВШ' => 8,
        'Лифт остановлен на ремонт' => 8,
        'лифт не работает' => 8,
        'Сроки ремонта переносятся.' => 8,
        'Требуются сварочные работы.' => 7,
        'Требуется замена тормозных колодок' => 7,
    ];

    /** Описания, набранные диспетчером. */
    public const DETAILS_MANUAL = [
        'лифт не работает,по звонку' => 119,
        'Застревание' => 60,
        'Лифт не работает' => 28,
        'Лифт не работает.' => 14,
        'Не работает' => 9,
    ];

    /**
     * Описания СПульта с числовым кодом события.
     * Хвосты РЕКОНСТРУИРОВАНЫ: phpMyAdmin обрезал вывод на «...».
     * Заменить на точные — только данные, логика не изменится.
     */
    public const DETAILS_SPULT_CODE = [
        '44 - Охрана шахты Проникновение в шахту на 1 этаже' => 90,
        '44 - Охрана шахты Проникновение в шахту Аварийная сигнализация' => 17,
        '44 - Охрана шахты Проникновение в шахту на 6 этаже' => 8,
        '57 - Превышение контрольного времени ожидания включения' => 18,
        '48 - 8 реверсов Многократный реверс дверей Аварийная сигнализация' => 11,
        '50 - Превышено контрольное время включения привода ДК' => 9,
        '49 - Превышено контрольное время включения привода' => 8,
    ];

    /** Описания СПульта текстовыми статусами. */
    public const DETAILS_SPULT_STATUS = [
        'Отсутствует напряжение в цепи управления' => 12,
        'Отсутствует связь с MCS' => 8,
        'Кабина на 1 этаже' => 8,
    ];

    /**
     * Добивка длины описания. «Нет связи» и «Кабина стоит» сюда
     * НЕ входят намеренно: это телеметрия, её гасит status_exclude
     * в config/spult.php, и в демо её быть не должно.
     */
    public const DETAILS_TAILS = [
        'Кабина на 3 этаже', 'Кабина на 6 этаже', 'Двери закрыты',
        'Пассажиров в кабине нет', 'по звонку', 'застревание',
    ];

    /** Длинный хвост (~3% описаний): легаси max = 563 символа. */
    public const DETAILS_LONG =
        'Обращение по телефону, заявитель сообщает о повторной остановке кабины. '
        . 'Ранее по этому объекту уже выезжали, устранение было временным. '
        . 'Просьба взять на контроль и проверить состояние привода дверей, '
        . 'при необходимости заказать запчасти. Диспетчер уведомил ответственного, '
        . 'срок уточняется по факту осмотра.';

    public const NOTES_TAIL = ' Уточнено у диспетчера, заявка на контроле.';
}

/**
 * Подключение, барьеры и тонкие обёртки запросов.
 *
 * Отдельный класс, а не DB::forTenant: у скрипта свой контур доступа —
 * один пользователь MySQL, одна БД, никакой мультиарендности. Смешивать
 * его с тенантным DB значило бы вернуть зависимость от реестра, к которому
 * у этого пользователя нет прав.
 *
 * Атрибуты PDO повторяют DB один в один: EMULATE_PREPARES=false и
 * FOUND_ROWS=false. Иначе генератор проверял бы не те ограничения,
 * под которыми работает приложение, и «прошло на генераторе» ничего
 * бы не значило.
 */
final class DemoSeedDb
{
    /**
     * Файл учётных данных вне web-root. Абсолютный путь — данные,
     * а не арифметика от __DIR__: скрипт можно положить в любой домен.
     * Переопределяется флагом --config=.
     */
    public const DEFAULT_CONFIG = '/home/users/z/zamotaev/domains/_demoseed/db.php';

    /**
     * Разрешение хранится в ЦЕЛЕВОЙ базе, а не в конфиге скрипта.
     * Единственный барьер, который проверяет саму цель: при подмене
     * учётных данных на рабочую базу маркера там нет, и запуск отменяется.
     */
    private const MARKER_OPTION = 'demo_seed_allowed';

    private function __construct(
        private readonly PDO $pdo,
        private readonly string $dbName
    ) {
    }

    public static function connect(string $configPath, string $confirm): self
    {
        if (!is_file($configPath)) {
            throw new RuntimeException(
                "Нет файла учётных данных: {$configPath}\n"
                . "Каталог 0750, файл 0600, владелец — пользователь PHP. Содержимое:\n"
                . "<?php return [\n"
                . "  'host' => '10.0.0.3', 'port' => 3306,\n"
                . "  'name' => 'zamotaev_demo_liftcs',\n"
                . "  'user' => '...', 'pass' => '...',\n"
                . "  'app_root' => '/home/users/z/zamotaev/domains/liftcs.ru',\n"
                . "];\n"
                . 'Пользователь MySQL должен иметь гранты ТОЛЬКО на эту БД.'
            );
        }

        // require, не require_once: повторный вернул бы true вместо массива.
        $cfg = require $configPath;
        if (!is_array($cfg)) {
            throw new RuntimeException("Файл учётных данных не вернул массив: {$configPath}");
        }

        $name = trim((string) ($cfg['name'] ?? ''));
        if ($name === '') {
            throw new RuntimeException('В файле учётных данных не задано name (имя БД).');
        }

        // Барьер: намерение оператора против фактического имени БД.
        if ($confirm !== $name) {
            throw new RuntimeException(
                "--confirm не совпал с именем БД в файле учётных данных.\nВ файле: " . $name
            );
        }

        $host = (string) ($cfg['host'] ?? 'localhost');
        $port = (int) ($cfg['port'] ?? 3306);
        $dsn = "mysql:host={$host};port={$port};dbname={$name};charset=utf8mb4";

        $pdo = new PDO($dsn, (string) ($cfg['user'] ?? ''), (string) ($cfg['pass'] ?? ''), [
            PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
            PDO::ATTR_EMULATE_PREPARES => false,
            PDO::MYSQL_ATTR_FOUND_ROWS => false,
        ]);

        $db = new self($pdo, $name);

        // Соединение могло уйти не туда (прокси, переопределение в my.cnf).
        // Проверяем факт, а не намерение DSN.
        $actual = (string) $pdo->query('SELECT DATABASE()')->fetchColumn();
        if ($actual !== $name) {
            throw new RuntimeException("Подключились к «{$actual}», ожидали «{$name}». Отказ.");
        }

        // Барьер цели: разрешение в самой базе.
        $marker = $db->fetchColumn(
            'SELECT option_value FROM lift_options WHERE option_name = ? LIMIT 1',
            [self::MARKER_OPTION]
        );

        if ((string) $marker !== '1') {
            throw new RuntimeException(
                "В БД «{$name}» нет разрешения на пересев.\n"
                . 'Ожидается lift_options.' . self::MARKER_OPTION . " = '1'.\n"
                . 'Защита от подмены учётных данных: в рабочей базе такой строки нет.'
            );
        }

        return $db;
    }

    public function dbName(): string
    {
        return $this->dbName;
    }

    public function fetchAll(string $sql, array $params = []): array
    {
        $st = $this->pdo->prepare($sql);
        $st->execute($params);
        return $st->fetchAll();
    }

    public function fetchOne(string $sql, array $params = []): ?array
    {
        $st = $this->pdo->prepare($sql);
        $st->execute($params);
        $row = $st->fetch();
        return $row === false ? null : $row;
    }

    public function fetchColumn(string $sql, array $params = []): mixed
    {
        $st = $this->pdo->prepare($sql);
        $st->execute($params);
        return $st->fetchColumn();
    }

    public function execute(string $sql, array $params = []): int
    {
        $st = $this->pdo->prepare($sql);
        $st->execute($params);
        return $st->rowCount();
    }

    public function insert(string $table, array $data): int
    {
        $keys = array_keys($data);
        $sql = "INSERT INTO `$table` (`" . implode('`,`', $keys) . "`) VALUES (:" . implode(',:', $keys) . ")";
        $this->execute($sql, $data);
        return (int) $this->pdo->lastInsertId();
    }

    public function transaction(callable $fn): void
    {
        $this->pdo->beginTransaction();
        try {
            $fn();
            $this->pdo->commit();
        } catch (Throwable $e) {
            $this->pdo->rollBack();
            throw $e;
        }
    }

    /**
     * Версии слоёв заявок — после коммита.
     *
     * Владелец семантики версий — AddressCacheService. Его upsert повторён
     * дословно и осознанно: экземпляр сервиса требует тенантный DB, которого
     * у скрипта нет по построению. Ключи — литералы из его белого списка KEYS.
     * При смене схемы версий править ОБА места.
     *
     * Требует UNIQUE(dict_name) — в демо есть uniq_dict_name.
     */
    public function bumpTicketVersions(): void
    {
        foreach (['open_tickets', 'closed_tickets'] as $key) {
            $this->execute(
                "INSERT INTO lift_dict_versions (dict_name, version, updated_at)
                 VALUES (:name, 1, UNIX_TIMESTAMP())
                 ON DUPLICATE KEY UPDATE
                    version    = version + 1,
                    updated_at = UNIX_TIMESTAMP()",
                ['name' => $key]
            );
        }
    }
}

final class DemoSeeder
{
    /** Таблицы под очистку. Сессии, справочники и spult_events не входят. */
    private const WIPE_TABLES = [
        'lift_calls', 'lift_notes', 'lift_history', 'lift_notifications',
        'lift_upload', 'offline_command_log', 'offline_sync_log', 'offline_actions_archive',
    ];

    /** Среднее число заявок на лифт за квартал: 2859 / 568. */
    private const TICKETS_PER_LIFT = 5.03;

    /** Корзины просрочки: сумма = 18, как в легаси (17 из 29 открытых). */
    private const OVERDUE_PLAN = [
        'lt_hour'   => [2, 60, 3599],
        'lt_5hours' => [3, 3600, 17999],
        'lt_day'    => [4, 18000, 86399],
        'lt_week'   => [6, 86400, 604799],
        'gte_week'  => [3, 604800, 1209600],
    ];

    private const BATCH = 500;

    /** @var resource|null */
    private $lockHandle = null;

    private int $now;
    private int $windowStart;
    private int $todayStart;
    private int $currentHour;

    private array $objects = [];
    private array $liftQueue = [];
    private array $staff = [];
    private array $creators = [];
    private array $combos = [];
    private array $comboWeights = [];
    private array $entrapmentIds = [];
    private array $dayWeights = [];
    private array $overdueQueue = [];

    private array $noteBuffer = [];
    private array $historyBuffer = [];
    private int $snapshotNoteId = 1;

    private array $stats = [
        'calls' => 0, 'open' => 0, 'closed' => 0, 'notes' => 0, 'history' => 0,
        'overdue' => 0, 'slow_entrapment' => 0, 'entrapment' => 0,
        'offline' => 0, 'flat' => 0, 'orphan' => 0, 'unassigned' => 0,
        'deleted' => [],
    ];

    public function __construct(
        private readonly DemoSeedDb $db,
        private readonly array $opts,
        private readonly string $stateDir
    ) {
        $this->now         = time();
        $this->todayStart  = (int) strtotime('today 00:00:00');
        $this->currentHour = (int) date('G');
        $this->windowStart = $this->todayStart - ((int) $opts['days'] - 1) * 86400;

        // Очередь корзин строится один раз в конструкторе, а не static
        // внутри метода: скрытое состояние метода пережило бы второй
        // запуск в том же процессе и сдвинуло бы распределение.
        foreach (self::OVERDUE_PLAN as $name => [$count, $lo, $hi]) {
            for ($i = 0; $i < $count; $i++) {
                $this->overdueQueue[] = [$name, $lo, $hi];
            }
        }
    }

    // -------------------------------------------------------------------
    // Запуск
    // -------------------------------------------------------------------

    public function run(): int
    {
        $this->readDictionaries();

        if ($this->staff === []) {
            fwrite(STDERR, "ОШИБКА: нет ни одного ответственного (mechanic/engineer без блокировки).\n"
                . "Сначала добавьте механиков — иначе все заявки уйдут неназначенными.\n");
            return 1;
        }

        $this->buildLiftQueue();
        $this->buildDayWeights();

        if ($this->opts['dry_run']) {
            $this->printPlan();
            return 0;
        }

        $started = microtime(true);

        // Очистка и наполнение — ОДНА транзакция. Сбой на середине
        // откатывает всё, и демо остаётся со старыми данными, а не
        // с половиной новых. TRUNCATE не используется: он сбросил бы
        // AUTO_INCREMENT, и IndexedDB посетителя связал бы старый id
        // с другой заявкой.
        $this->db->transaction(function (): void {
            $this->wipe();

            if (!$this->opts['wipe_only']) {
                $this->generate();
                $this->flushNotes();
                $this->flushHistory();
            }
        });

        // Версии — строго ПОСЛЕ коммита: иначе клиент увидит новую
        // версию и придёт за данными, которых ещё нет.
        $this->db->bumpTicketVersions();

        $this->report(microtime(true) - $started);

        return 0;
    }

    private function readDictionaries(): void
    {
        // Пул ответственных = staff_list минус foreman. Прораб назначать
        // нельзя по решению; если назначить человека вне staff_list,
        // диспетчер не сможет перевыбрать его в выпадающем списке.
        // user_role может быть и 'mechanic', и 'engineer' — отбор идёт
        // по user_position, поэтому ручная правка роли ничего не ломает.
        $this->staff = $this->db->fetchAll(
            "SELECT user_id, user_name FROM lift_users
             WHERE user_block <> 1
               AND (
                 user_position IN ('mechanic','signalman','electronic-engineer')
                 OR ((user_position IS NULL OR user_position = '') AND user_role IN ('mechanic','engineer'))
               )
             ORDER BY user_id"
        );

        $this->creators = $this->db->fetchAll(
            "SELECT user_id, user_name FROM lift_users
             WHERE user_block <> 1 AND user_role IN ('administrator','dispatcher')
             ORDER BY user_id"
        );

        // Комбинации, которых нет в справочнике тенанта, отбрасываем:
        // иначе генератор плодил бы осиротевшие ссылки случайно, а они
        // нужны только как намеренный краевой случай.
        $types = [];
        foreach ($this->db->fetchAll("SELECT type_id, type FROM lift_types") as $t) {
            $types[(int) $t['type_id']] = (int) $t['type'];
        }

        foreach (DemoSeedData::COMBOS as $c) {
            if (($types[$c['dep']] ?? 0) === 1
                && ($types[$c['req']] ?? 0) === 2
                && ($types[$c['grp']] ?? 0) === 3) {
                $this->combos[] = $c;
                $this->comboWeights[count($this->combos) - 1] = $c['w'];
            }
        }

        if ($this->combos === []) {
            throw new RuntimeException('В lift_types нет ни одной валидной комбинации отдел/тип/группа.');
        }

        // Правило то же, что ReportsRepository::ENTRAPMENT_NAME_LIKE.
        // Владелец правила — репозиторий; дубль литерала осознан:
        // константа приватная, а тянуть репозиторий в генератор незачем.
        // При смене формулировки группы править ОБА места.
        foreach ($this->db->fetchAll(
            "SELECT type_id FROM lift_types WHERE type = 3 AND type_name LIKE ?",
            ['%астреван%']
        ) as $g) {
            $this->entrapmentIds[] = (int) $g['type_id'];
        }

        // Id объектов читаем один раз и перемешиваем в PHP: RAND() в SQL
        // не сидируется mt_srand, воспроизводимость по seed потерялась бы.
        $ids = array_map(
            static fn (array $r): int => (int) $r['id'],
            $this->db->fetchAll("SELECT id FROM lift_object WHERE vis = 1 ORDER BY id")
        );

        if ($ids === []) {
            throw new RuntimeException('В lift_object нет видимых объектов — генерировать не на чем.');
        }

        shuffle($ids);
        $poolSize = min(count($ids), max(20, (int) round((int) $this->opts['tickets'] / self::TICKETS_PER_LIFT)));
        $pool = array_slice($ids, 0, $poolSize);

        $ph = implode(',', array_fill(0, count($pool), '?'));
        $this->objects = $this->db->fetchAll(
            "SELECT o.id AS object_id, o.object_name,
                    h.id AS home_id, h.home_name,
                    s.id AS street_id, s.street_name, s.street_type,
                    c.id AS city_id, c.city_name, c.city_type
             FROM lift_object o
             JOIN lift_home   h ON h.id = o.home_id
             JOIN lift_street s ON s.id = h.street_id
             JOIN lift_city   c ON c.id = s.city_id
             WHERE o.id IN ($ph)
             ORDER BY o.id",
            array_values($pool)
        );

        if ($this->objects === []) {
            throw new RuntimeException('Адресная иерархия не собралась JOINом — генерировать не на чем.');
        }
    }

    /**
     * Очередь объектов с перекосом как в легаси: меньшинство лифтов
     * даёт большую часть потока. Каждому лифту назначается цель из
     * гистограммы, список разворачивается и перемешивается.
     */
    private function buildLiftQueue(): void
    {
        $need = (int) $this->opts['tickets'];
        $queue = [];

        foreach ($this->objects as $obj) {
            $target = (int) self::pick(DemoSeedData::LIFT_HISTOGRAM);
            for ($i = 0; $i < $target; $i++) {
                $queue[] = $obj;
            }
            if (count($queue) >= $need * 2) {
                break;
            }
        }

        if ($queue === []) {
            $queue = $this->objects;
        }

        shuffle($queue);

        // Недобор добираем случайными, избыток срезаем. Срезка чуть
        // уплощает хвост распределения — осознанно, объём важнее.
        while (count($queue) < $need) {
            $queue[] = $this->objects[mt_rand(0, count($this->objects) - 1)];
        }

        $this->liftQueue = array_slice($queue, 0, $need);
    }

    private function buildDayWeights(): void
    {
        $days = (int) $this->opts['days'];
        for ($d = 0; $d < $days; $d++) {
            $ts = $this->todayStart - $d * 86400;
            $wd = (int) date('N', $ts) - 1;
            $this->dayWeights[$d] = DemoSeedData::WEEKDAY_WEIGHTS[$wd];
        }
    }

    // -------------------------------------------------------------------
    // Очистка
    // -------------------------------------------------------------------

    private function wipe(): void
    {
        // existence-проверка обязательна: часть таблиц офлайн-синхронизации
        // может отсутствовать, и DELETE по несуществующей уронил бы всю
        // транзакцию вместе с наполнением.
        $ph = implode(',', array_fill(0, count(self::WIPE_TABLES), '?'));
        $present = array_map(
            static fn (array $r): string => (string) $r['TABLE_NAME'],
            $this->db->fetchAll(
                "SELECT TABLE_NAME FROM information_schema.TABLES
                 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN ($ph)",
                self::WIPE_TABLES
            )
        );

        foreach (self::WIPE_TABLES as $table) {
            if (!in_array($table, $present, true)) {
                $this->stats['deleted'][$table] = 'нет таблицы';
                continue;
            }
            $this->stats['deleted'][$table] = $this->db->execute("DELETE FROM `$table`");
        }
        // Файлы lift_upload с диска НЕ удаляем: строки убраны, файлы
        // остаются сиротами. Удалять без подтверждения нельзя.
    }

    // -------------------------------------------------------------------
    // Генерация
    // -------------------------------------------------------------------

    private function generate(): void
    {
        $total = (int) $this->opts['tickets'];
        $openCount = max(5, min(300, (int) round($total * 0.01)));

        $open = [];
        for ($i = 0; $i < $openCount; $i++) {
            $open[] = $this->makeOpen($i);
        }

        // Намеренные дубликаты: активная заявка на том же объекте и
        // в том же отделе. Без них модалку force_create не проверить.
        foreach ([[0, 1], [2, 3]] as [$a, $b]) {
            if (isset($open[$a], $open[$b])) {
                $open[$b]['address_lift']    = $open[$a]['address_lift'];
                $open[$b]['address_home']    = $open[$a]['address_home'];
                $open[$b]['address_street']  = $open[$a]['address_street'];
                $open[$b]['address_city']    = $open[$a]['address_city'];
                $open[$b]['call_adres']      = $open[$a]['call_adres'];
                $open[$b]['call_department'] = $open[$a]['call_department'];
            }
        }

        foreach ($open as $row) {
            $this->persist($row, true);
        }

        $closedCount = $total - $openCount;
        for ($i = 0; $i < $closedCount; $i++) {
            $this->persist($this->makeClosed($i, $openCount + $i), false);
        }
    }

    /** Открытая заявка: срок и просрочка задаются явно по корзинам. */
    private function makeOpen(int $index): array
    {
        $obj = $this->liftQueue[$index] ?? $this->objects[0];
        $row = $this->baseRow($obj);

        $isDefault = mt_rand(1, 100) <= 25;
        $span = $this->drawAssignedSpan($isDefault);

        if (isset($this->overdueQueue[$index])) {
            [, $lo, $hi] = $this->overdueQueue[$index];
            $od = mt_rand($lo, $hi);
            $expected = $this->now - $od;
            $created  = $expected - $span;
            $this->stats['overdue']++;
        } else {
            $created  = $this->now - mt_rand(600, 3 * 86400);
            $expected = $created + $span;
            if ($expected <= $this->now) {
                $expected = $this->now + mt_rand(3600, 86400);
            }
            // Краевой случай: срок не задан → просрочкой не считается,
            // repair_time в контракте null.
            if ($index === count($this->overdueQueue) + 1) {
                $expected = 0;
            }
        }
        if ($created < $this->windowStart) {
            $created = $this->windowStart + mt_rand(0, 86400);

            // Срок привязан к now — он ЗАДАЁТ корзину просрочки, сдвигать
            // его нельзя. Если кламп поставил создание не раньше срока,
            // отодвигаем назад само создание: выйти за окно для одной
            // заявки честнее, чем потерять корзину и соврать в stats.
            // expected = 0 не трогаем — это «срок не задан», не дедлайн.
            if ($expected > 0 && $created >= $expected) {
                $created = $expected - mt_rand(1800, 7200);
            }
        }

        $row['call_date']            = $created;
        // Без max(): created < expected верно по построению
        // (created = expected - span, span >= 1800), а подъём срока
        // увёл бы заявку из корзины, при od < 3600 — вообще в будущее.
        $row['expected_repair_time'] = $expected;
        $row['repair_time_is_default'] = $isDefault ? 1 : 0;
        $row['call_status']            = 0;
        $row['call_date2']             = 0;
        $row['call_solution']          = '';
        $row['call_last_name']         = '';
        $row['closed_by_id']           = null;

        return $row;
    }

    private function makeClosed(int $i, int $queueIndex): array
    {
        $obj = $this->liftQueue[$queueIndex] ?? $this->objects[0];
        $row = $this->baseRow($obj);

        $created = $this->drawCreatedAt();
        $isEntrapment = in_array((int) $row['call_group'], $this->entrapmentIds, true);
        $duration = $this->drawDuration($isEntrapment);

        // Заявка не может закрыться в будущем. Для свежих заявок срок
        // ужимается до доступного — и решение берётся из «быстрого»
        // пула (дубль/ошибочно/повтор), как это и бывает в жизни.
        $available = $this->now - $created;
        $fast = false;
        if ($duration > $available) {
            $duration = max(0, $available);
            $fast = true;
        }

        $closedAt = $created + $duration;

        $isDefault = mt_rand(1, 100) <= 25;
        $row['call_date']              = $created;
        $row['expected_repair_time']   = $created + $this->drawAssignedSpan($isDefault);
        $row['repair_time_is_default'] = $isDefault ? 1 : 0;
        $row['call_status']            = 1;
        $row['call_date2']             = $closedAt;

        $pool = $fast
            ? DemoSeedData::SOLUTIONS_FAST
            : ($isEntrapment ? DemoSeedData::SOLUTIONS_ENTRAPMENT : DemoSeedData::SOLUTIONS);
        $solution = (string) self::pick($pool);
        if (mt_rand(1, 100) <= 2) {
            $solution .= ' ' . DemoSeedData::NOTES_TAIL . ' ' . DemoSeedData::DETAILS_LONG;
            $solution = mb_substr($solution, 0, 320, 'UTF-8');
        }
        $row['call_solution'] = $solution;

        // Закрывает назначенный механик, иначе диспетчер.
        $closerId = (int) ($row['call_staff'] ?? 0);
        $closerName = '';
        if ($closerId > 0) {
            foreach ($this->staff as $s) {
                if ((int) $s['user_id'] === $closerId) {
                    $closerName = (string) $s['user_name'];
                    break;
                }
            }
        }
        if ($closerName === '' && $this->creators !== []) {
            $c = $this->creators[mt_rand(0, count($this->creators) - 1)];
            $closerId = (int) $c['user_id'];
            $closerName = (string) $c['user_name'];
        }
        $row['closed_by_id']   = $closerId > 0 ? $closerId : null;
        $row['call_last_name'] = $closerName;

        // Краевой случай легаси-фолбэка: основное поле пустое, имя
        // закрывшего только в call_last_name_close.
        if ($i < 3) {
            $row['call_last_name_close'] = $closerName;
            $row['call_last_name'] = '';
        }

        if ($isEntrapment) {
            $this->stats['entrapment']++;
            if ($duration > 50 * 60) {
                $this->stats['slow_entrapment']++;
            }
        }

        // Краевые случаи: плоский адрес и осиротевшие ссылки.
        if ($i >= 3 && $i < 8) {
            $row['address_city'] = $row['address_street'] = $row['address_home'] = $row['address_lift'] = 0;
            $row['call_adres'] = 'г. Ростов-на-Дону, ул. Ленина, д. 5, п.1 пасс.';
            $this->stats['flat']++;
        } elseif ($i >= 8 && $i < 12) {
            $row['call_department'] = 9999;
            $this->stats['orphan']++;
        } elseif ($i >= 12 && $i < 15) {
            $row['call_group'] = 9999;
            $this->stats['orphan']++;
        }

        return $row;
    }

    /** Общие поля: адрес, справочники, ответственные, описание, автор. */
    private function baseRow(array $obj): array
    {
        $combo = $this->combos[(int) self::pick($this->comboWeights)];

        // alert_level — правило CallService, не синтетика.
        $alert = $combo['dep'] === 23 ? 3 : ($combo['req'] === 1 ? 2 : 1);

        $family = (int) self::pick([0 => 45, 1 => 35, 2 => 20]);
        $details = match ($family) {
            0 => (string) self::pick(DemoSeedData::DETAILS_MANUAL),
            1 => (string) self::pick(DemoSeedData::DETAILS_SPULT_CODE),
            default => (string) self::pick(DemoSeedData::DETAILS_SPULT_STATUS),
        };

        $tails = mt_rand(0, 2);
        for ($t = 0; $t < $tails; $t++) {
            $details .= ', ' . DemoSeedData::DETAILS_TAILS[mt_rand(0, count(DemoSeedData::DETAILS_TAILS) - 1)];
        }
        if (mt_rand(1, 100) <= 3) {
            $details .= "\n" . DemoSeedData::DETAILS_LONG;
        }
        $details = mb_substr($details, 0, 563, 'UTF-8');

        // Происхождение связано с семейством описания: СПульт-текст
        // не мог набрать диспетчер. call_user = 0 = система, а не
        // выдуманный id 1 (в демо пользователей с id 1 нет).
        $isSpult = $family !== 0;
        $authorId = 0;
        $authorName = 'SPult Auto';
        if (!$isSpult && $this->creators !== []) {
            $c = $this->creators[mt_rand(0, count($this->creators) - 1)];
            $authorId = (int) $c['user_id'];
            $authorName = (string) $c['user_name'];
        }

        $address = App\Support\Address::formatDisplay(
            (string) $obj['city_name'],
            (string) $obj['street_name'],
            (string) $obj['home_name'],
            (string) $obj['object_name'],
            $obj['city_type'] ?? null,
            $obj['street_type'] ?? null
        );

        $row = [
            'call_first_name' => $authorName,
            'call_last_name'  => '',
            'call_phone'      => '',
            'call_email'      => '',
            'call_department' => $combo['dep'],
            'call_request'    => $combo['req'],
            'call_group'      => $combo['grp'],
            // Обрезка своя, а не надежда на sql_mode: без STRICT длинное
            // значение молча режется сервером, с STRICT — отказ записи.
            'call_adres'      => mb_substr($address, 0, 100, 'UTF-8'),
            'address_city'    => (int) $obj['city_id'],
            'address_street'  => (int) $obj['street_id'],
            'address_home'    => (int) $obj['home_id'],
            'address_lift'    => (int) $obj['object_id'],
            'call_details'    => $details,
            'call_user'       => $authorId,
            'alert_level'     => $alert,
            'call_staff'      => 0,
            'call_staff2'     => null,
            'call_staff3'     => null,
            'call_staff_status'  => null,
            'call_staff_status2' => null,
            'call_staff_status3' => null,
            'call_staff_date'    => null,
            'call_staff_date2'   => null,
            'call_staff_date3'   => null,
            'call_last_name_close' => null,
            'offline_uuid'    => null,
            'call_full_note_history' => '{}',
            'address_not_verified' => 0,
        ];

        // Слот 1 — 96.5% как в легаси. Слоты 2/3 — СИНТЕТИКА:
        // в легаси они не использовались вовсе, а без них не проверить
        // трёхслотовую область чтения и колонки «Отв. 2/3» в CSV.
        if (mt_rand(1, 1000) <= 965) {
            $picked = $this->pickStaff([]);
            $row['call_staff'] = $picked;
            $this->fillNotify($row, '');

            if (mt_rand(1, 100) <= 5) {
                $second = $this->pickStaff([$picked]);
                $row['call_staff2'] = $second;
                $this->fillNotify($row, '2');

                if (mt_rand(1, 100) <= 40) {
                    $third = $this->pickStaff([$picked, $second]);
                    $row['call_staff3'] = $third;
                    $this->fillNotify($row, '3');
                }
            }
        } else {
            $this->stats['unassigned']++;
        }

        return $row;
    }

    /** Один ответственный, не входящий в $exclude. Пул непуст — проверено в run(). */
    private function pickStaff(array $exclude): int
    {
        $pool = [];
        foreach ($this->staff as $s) {
            $id = (int) $s['user_id'];
            if (!in_array($id, $exclude, true)) {
                $pool[] = $id;
            }
        }

        // Все исключены (механик один, а слотов три) — берём из полного
        // списка. Дубль ответственного в слотах не ломает neither SQL,
        // ни контракт, а пустой слот сломал бы генерацию.
        if ($pool === []) {
            $pool = array_map(static fn (array $s): int => (int) $s['user_id'], $this->staff);
        }

        return $pool[mt_rand(0, count($pool) - 1)];
    }

    /**
     * Канал уведомления. Реальность легаси: только 1 и NULL.
     * Разброс 0..7 и вне словаря — СИНТЕТИКА ради проверки суффиксов
     * CSV и ветки «неизвестный канал».
     */
    private function fillNotify(array &$row, string $slot): void
    {
        $roll = mt_rand(1, 100);
        if ($roll <= 5) {
            $status = null;
        } elseif ($roll <= 17) {
            $status = mt_rand(0, 7);
        } elseif ($roll <= 20) {
            $status = mt_rand(8, 9);
        } else {
            $status = 1;
        }

        $row["call_staff_status$slot"] = $status;
        $row["call_staff_date$slot"] = $status === null
            ? null
            : ($status === 0 ? 0 : $this->now - mt_rand(60, 7 * 86400));
    }

    private function drawCreatedAt(): int
    {
        $day = (int) self::pick($this->dayWeights);
        $start = $this->todayStart - $day * 86400;

        // Сегодня — только до текущего часа. Иначе заявки имели бы
        // метку создания в будущем. Утренний пик 6–8 попадает в окно,
        // поэтому к 08:00 «сегодня» получает ~18% суточного объёма.
        $weights = DemoSeedData::HOUR_WEIGHTS;
        if ($day === 0) {
            $weights = array_slice($weights, 0, $this->currentHour + 1, true);
            $weights = array_filter($weights, static fn (int $w): bool => $w > 0);
            if ($weights === []) {
                $weights = [$this->currentHour => 1];
            }
        }

        $hour = (int) self::pick($weights);
        $ts = $start + $hour * 3600 + mt_rand(0, 3599);

        return min($ts, $this->now - 1);
    }

    private function drawDuration(bool $entrapment): int
    {
        if ($entrapment) {
            // СИНТЕТИКА: в легаси время эвакуации не отслеживалось,
            // закрытие могло быть через час после факта. Профиль
            // оценочный: 75% в 15–45 мин, 20% в 51–120 мин, 5% дольше.
            return match ((int) self::pick([0 => 75, 1 => 20, 2 => 5])) {
                0 => mt_rand(900, 2700),
                1 => mt_rand(3060, 7200),
                default => mt_rand(7200, 28800),
            };
        }

        return match ((int) self::pick(DemoSeedData::CLOSE_BUCKETS)) {
            0 => mt_rand(120, 1799),
            1 => mt_rand(1800, 3600),
            2 => mt_rand(3601, 18000),
            3 => mt_rand(18001, 86400),
            default => mt_rand(86401, 5604921),
        };
    }

    /**
     * Назначенный срок. СИНТЕТИКА: колонки repair_time_is_default
     * в легаси нет. Группа «по умолчанию» — это серверные 3 суток
     * из CallService, поэтому общий средний срок выше легаси-14 ч.
     * Зато метрика avg_repair_time.default/custom перестаёт быть пустой.
     */
    private function drawAssignedSpan(bool $isDefault): int
    {
        if ($isDefault) {
            return 3 * 86400;
        }

        return match ((int) self::pick([0 => 20, 1 => 45, 2 => 25, 3 => 10])) {
            0 => mt_rand(1800, 7200),
            1 => mt_rand(7200, 28800),
            2 => mt_rand(28800, 86400),
            default => mt_rand(86400, 259200),
        };
    }

    // -------------------------------------------------------------------
    // Запись
    // -------------------------------------------------------------------

    private function persist(array $row, bool $isOpen): void
    {
        // Офлайн-подмножество ~2%: UNIQUE-колонка, пустая строка
        // недопустима — два NULL не конфликтуют, два '' конфликтуют.
        $isOffline = mt_rand(1, 100) <= 2;
        if ($isOffline) {
            $row['offline_uuid'] = 'demo-' . $this->opts['seed'] . '-' . $this->stats['calls'];
            $this->stats['offline']++;
        }

        $notes = $this->makeNotes($row, $isOpen, $isOffline);

        if (!$isOpen && $notes !== []) {
            // Закрытые заметки существуют ТОЛЬКО как слепок. Форма —
            // ровно вывод NoteRepository::listByCall (n.* + user_name),
            // иначе mapNote в репозитории не найдёт ключи.
            $snapshot = [];
            foreach ($notes as $n) {
                $snapshot[] = [
                    'note_id'        => $this->snapshotNoteId++,
                    'note_title'     => 'Заметка',
                    'note_body'      => $n['note_body'],
                    'note_relation'  => 0,
                    'note_type'      => 1,
                    'note_post_date' => $n['note_post_date'],
                    'note_post_ip'   => '127.0.0.1',
                    'img_name'       => '',
                    'is_offline'     => $n['is_offline'],
                    'user_name'      => $n['user_name'],
                ];
            }
            $row['call_full_note_history'] = (string) json_encode(
                $snapshot,
                JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE
            );
        }

        // По одной строке: lastInsertId даёт точный id. Батч потребовал
        // бы корреляции или допущения о непрерывности AUTO_INCREMENT,
        // а параллельный сигнал СПульта вклинился бы в нумерацию.
        $callId = $this->db->insert('lift_calls', $row);
        $this->stats['calls']++;
        $isOpen ? $this->stats['open']++ : $this->stats['closed']++;

        if ($isOpen) {
            foreach ($notes as $n) {
                $n['note_relation'] = $callId;
                unset($n['user_name']);
                $this->noteBuffer[] = $n;
            }
        } elseif ($notes !== []) {
            // note_relation в слепке проставляем задним числом: JSON
            // собран до INSERT, когда номера заявки ещё не было.
            $decoded = json_decode((string) $row['call_full_note_history'], true);
            if (is_array($decoded) && $decoded !== []) {
                foreach ($decoded as &$sn) {
                    $sn['note_relation'] = $callId;
                }
                unset($sn);
                $this->db->execute(
                    "UPDATE lift_calls SET call_full_note_history = :j WHERE call_id = :id",
                    [
                        'j' => (string) json_encode($decoded, JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE),
                        'id' => $callId,
                    ]
                );
            }
        }

        $this->makeHistory($callId, $row, $isOpen, $isOffline);

        if (count($this->noteBuffer) >= self::BATCH) {
            $this->flushNotes();
        }
        if (count($this->historyBuffer) >= self::BATCH) {
            $this->flushHistory();
        }
    }

    /** @return array<int,array<string,mixed>> */
    private function makeNotes(array $row, bool $isOpen, bool $isOffline): array
    {
        if (mt_rand(1, 100) > 30) {
            return [];
        }

        $count = (int) self::pick([1 => 68, 2 => 22, 3 => 7, 4 => 2, 5 => 1]);
        if ($this->stats['calls'] === 20) {
            $count = 9;   // легаси max = 9 заметок на заявку
        }

        $from = (int) $row['call_date'];
        $to = $isOpen ? $this->now : (int) $row['call_date2'];
        $to = max($from + 1, $to);

        $notes = [];
        for ($i = 0; $i < $count; $i++) {
            $authorId = (int) ($row['call_staff'] ?? 0);
            $authorName = '';
            foreach ($this->staff as $s) {
                if ((int) $s['user_id'] === $authorId) {
                    $authorName = (string) $s['user_name'];
                    break;
                }
            }
            if ($authorName === '' && $this->creators !== []) {
                $c = $this->creators[mt_rand(0, count($this->creators) - 1)];
                $authorId = (int) $c['user_id'];
                $authorName = (string) $c['user_name'];
            }

            $body = (string) self::pick(DemoSeedData::NOTES);
            if (mt_rand(1, 100) <= 3) {
                $body .= DemoSeedData::NOTES_TAIL;
            }

            $notes[] = [
                'note_title'     => 'Заметка',
                // utf8mb3: 4-байтных символов здесь нет и быть не должно.
                'note_body'      => mb_substr($body, 0, 341, 'UTF-8'),
                'note_relation'  => 0,
                'note_type'      => 1,
                'note_post_date' => mt_rand($from, $to),
                'note_post_ip'   => '127.0.0.1',
                'note_post_user' => $authorId,
                // Флаг ставится здесь, а не в persist: иначе офлайн-заявка
                // имела бы офлайн-историю и обычные заметки, и маркер ⏳
                // в карточке не появился бы ни на одном комментарии.
                'is_offline'     => $isOffline ? 1 : 0,
                'user_name'      => $authorName,
            ];
        }

        usort($notes, static fn (array $a, array $b): int => $a['note_post_date'] <=> $b['note_post_date']);
        $this->stats['notes'] += count($notes);

        return $notes;
    }

    private function makeHistory(int $callId, array $row, bool $isOpen, bool $isOffline): void
    {
        $source = $isOffline ? 'offline_sync' : 'online';
        $author = (string) $row['call_first_name'];

        $this->historyBuffer[] = [
            'history_date' => (int) $row['call_date'],
            'history_info' => $isOffline
                ? "Заявка синхронизирована из офлайна (Автор: {$author})"
                : "Заявка создана пользователем {$author}",
            'call_id' => $callId,
            'source'  => $source,
        ];

        if ($isOffline) {
            $this->historyBuffer[] = [
                'history_date' => (int) $row['call_date'],
                'history_info' => 'Срок ремонта назначен сервером: офлайн-клиент срок не задаёт',
                'call_id' => $callId,
                'source'  => $source,
            ];
        }

        if (!$isOpen) {
            $closer = (string) ($row['call_last_name'] !== ''
                ? $row['call_last_name']
                : ($row['call_last_name_close'] ?? ''));
            $this->historyBuffer[] = [
                'history_date' => (int) $row['call_date2'],
                'history_info' => "Закрыта пользователем {$closer}. Решение: " . (string) $row['call_solution'],
                'call_id' => $callId,
                'source'  => $source,
            ];
        }
    }

    private function flushNotes(): void
    {
        $this->insertBatch('lift_notes', $this->noteBuffer);
        $this->noteBuffer = [];
    }

    private function flushHistory(): void
    {
        $this->stats['history'] += count($this->historyBuffer);
        $this->insertBatch('lift_history', $this->historyBuffer);
        $this->historyBuffer = [];
    }

    /**
     * Мультистрочный INSERT. Плейсхолдеры позиционные и уникальные:
     * EMULATE_PREPARES=false, повтор именованного маркера дал бы HY093.
     */
    private function insertBatch(string $table, array $rows): void
    {
        if ($rows === []) {
            return;
        }

        $cols = array_keys($rows[0]);
        $one = '(' . implode(',', array_fill(0, count($cols), '?')) . ')';
        $sql = "INSERT INTO `$table` (`" . implode('`,`', $cols) . "`) VALUES "
            . implode(',', array_fill(0, count($rows), $one));

        $params = [];
        foreach ($rows as $r) {
            foreach ($cols as $c) {
                $params[] = $r[$c] ?? null;
            }
        }

        $this->db->execute($sql, $params);
    }

    // -------------------------------------------------------------------
    // Служебное
    // -------------------------------------------------------------------

    private static function pick(array $weights): string|int
    {
        $total = array_sum($weights);
        if ($total <= 0) {
            throw new RuntimeException('Пустое распределение в генераторе.');
        }

        $r = mt_rand(1, (int) $total);
        $acc = 0;
        foreach ($weights as $key => $w) {
            $acc += $w;
            if ($r <= $acc) {
                return $key;
            }
        }

        return array_key_first($weights);
    }

    private function printPlan(): void
    {
        $total = (int) $this->opts['tickets'];
        $open = max(5, min(300, (int) round($total * 0.01)));

        echo "DRY RUN — записи не будет\n";
        echo 'БД: ' . $this->db->dbName() . "\n";
        echo 'Seed: ' . $this->opts['seed'] . ', окно: ' . $this->opts['days'] . " дней\n";
        echo 'Заявок: ' . $total . ' (открытых ' . $open . ', закрытых ' . ($total - $open) . ")\n";
        echo 'Просрочка по корзинам: ';
        foreach (self::OVERDUE_PLAN as $name => [$c]) {
            echo $name . '=' . $c . ' ';
        }
        echo "\n";
        echo 'Лифтов в пуле: ' . count($this->objects) . ', ответственных: ' . count($this->staff) . "\n";
        echo 'Комбинаций справочника: ' . count($this->combos)
            . ', групп «застревание»: ' . (implode(',', $this->entrapmentIds) ?: 'нет') . "\n";
        echo 'Под очистку: ' . implode(', ', self::WIPE_TABLES) . "\n";
    }

    private function report(float $seconds): void
    {
        $lines = [];
        $lines[] = sprintf(
            '[%s] db=%s seed=%d tickets=%d open=%d closed=%d notes=%d history=%d',
            date('c'),
            $this->db->dbName(),
            (int) $this->opts['seed'],
            $this->stats['calls'],
            $this->stats['open'],
            $this->stats['closed'],
            $this->stats['notes'],
            $this->stats['history']
        );
        $lines[] = sprintf(
            '  overdue=%d entrapment=%d slow(>50m)=%d offline=%d flat=%d orphan=%d unassigned=%d elapsed=%.2fs',
            $this->stats['overdue'],
            $this->stats['entrapment'],
            $this->stats['slow_entrapment'],
            $this->stats['offline'],
            $this->stats['flat'],
            $this->stats['orphan'],
            $this->stats['unassigned'],
            $seconds
        );
        $removed = [];
        foreach ($this->stats['deleted'] as $t => $n) {
            $removed[] = $t . '=' . $n;
        }
        $lines[] = '  deleted: ' . implode(' ', $removed);

        $text = implode("\n", $lines) . "\n";
        echo $text;

        if ($this->stateDir !== '') {
            @file_put_contents($this->stateDir . '/seed.log', $text, FILE_APPEND | LOCK_EX);
        }
    }

    /** Лок от параллельного запуска: крон и ручной запуск не пересекутся. */
    public function acquireLock(): bool
    {
        if ($this->stateDir === '') {
            fwrite(STDERR, "Нет каталога состояния — лок невозможен, запуск отменён.\n");
            return false;
        }

        $fp = @fopen($this->stateDir . '/seed.lock', 'c');
        if ($fp === false) {
            return false;
        }
        if (!@flock($fp, LOCK_EX | LOCK_NB)) {
            fclose($fp);
            return false;
        }

        $this->lockHandle = $fp;
        return true;
    }
}

// ---------------------------------------------------------------------------
// Пути, аргументы, точка входа
// ---------------------------------------------------------------------------

/**
 * Каталог состояния = каталог файла учётных данных. Не вычисляется от
 * __DIR__: при переносе скрипта в другой домен арифметика дала бы второй
 * _demoseed не в том месте, и лок с логом разъехались бы по каталогам.
 *
 * Фолбэк в /tmp — только для лога и лока. У учётных данных фолбэка НЕТ:
 * пароль в world-readable каталоге недопустим.
 */
function demoSeedStateDir(string $configPath): string
{
    $dir = dirname($configPath);
    if (is_dir($dir) && is_writable($dir)) {
        return $dir;
    }

    $fallback = sys_get_temp_dir() . '/liftcs_demoseed';
    if (!is_dir($fallback)) {
        @mkdir($fallback, 0750, true);
    }

    return (is_dir($fallback) && is_writable($fallback)) ? $fallback : '';
}

/**
 * Address подключается по app_root из конфига, без bootstrap проекта.
 *
 * Проверяем факт наличия файла, а не полагаемся на фатал require:
 * сообщение должно называть путь и ключ конфига, иначе опечатку в
 * app_root придётся искать по стектрейсу.
 */
function demoSeedLoadAddress(string $configPath): void
{
    $cfg = require $configPath;
    $root = is_array($cfg) ? rtrim(trim((string) ($cfg['app_root'] ?? '')), '/') : '';

    if ($root === '') {
        throw new RuntimeException(
            "В {$configPath} не задан app_root. Добавьте строку:\n"
            . "  'app_root' => '/home/users/z/zamotaev/domains/liftcs.ru',\n"
            . 'Путь не выводится из __DIR__ намеренно: два источника одного пути разошлись бы.'
        );
    }

    $file = $root . '/App/Support/Address.php';
    if (!is_file($file)) {
        throw new RuntimeException("Не найден Address.php по app_root: {$file}");
    }

    require_once $file;
}

$opts = [
    'confirm' => '', 'tickets' => 2900, 'days' => 90,
    'seed' => (int) date('Ymd'), 'dry_run' => false, 'wipe_only' => false,
    'config' => DemoSeedDb::DEFAULT_CONFIG,
];

foreach (array_slice($argv, 1) as $arg) {
    if (!str_starts_with($arg, '--')) {
        continue;
    }
    $parts = explode('=', substr($arg, 2), 2);
    $key = str_replace('-', '_', $parts[0]);
    $val = $parts[1] ?? '';

    match ($key) {
        'confirm' => $opts['confirm'] = $val,
        'config'  => $opts['config'] = $val !== '' ? $val : DemoSeedDb::DEFAULT_CONFIG,
        'tickets' => $opts['tickets'] = max(10, min(50000, (int) $val)),
        'days'    => $opts['days'] = max(2, min(90, (int) $val)),
        'seed'    => $opts['seed'] = (int) $val,
        'dry_run' => $opts['dry_run'] = true,
        'wipe_only' => $opts['wipe_only'] = true,
        default   => fwrite(STDERR, "Неизвестный флаг: --$key\n"),
    };
}

// Имя БД обязательно и вводится руками. Хоста нет: тенант не резолвится,
// цель задаётся файлом учётных данных.
if ($opts['confirm'] === '') {
    fwrite(STDERR, "ОТКАЗ: укажите --confirm=<имя БД демо>.\n"
        . "Скрипт удаляет ВСЕ заявки, подтверждение имени обязательно.\n");
    exit(1);
}

// Подключаемые файлы проекта могут читать REMOTE_ADDR. В CLI его нет.
$_SERVER['REMOTE_ADDR'] = '127.0.0.1';

try {
    // Конфиг проверяется ДО соединения: опечатка в app_root должна
    //被发现 раньше, чем скрипт откроет БД и возьмёт лок.
    demoSeedLoadAddress($opts['config']);

    // mt_srand, а не random_int: нужна воспроизводимость по seed.
    // Секретов генератор не создаёт, криптокачество здесь не требуется.
    mt_srand((int) $opts['seed']);

    $db = DemoSeedDb::connect($opts['config'], $opts['confirm']);
    $seeder = new DemoSeeder($db, $opts, demoSeedStateDir($opts['config']));

    if (!$opts['dry_run'] && !$seeder->acquireLock()) {
        echo "Уже выполняется другой запуск — выходим без действий.\n";
        exit(0);
    }

    exit($seeder->run());
} catch (Throwable $e) {
    // PDOException отдаёт настоящий текст SQL-ошибки — в отличие от
    // обёртки DB, которая прячет его в лог. Для инструмента это и есть
    // диагностика, поэтому пишем сообщение целиком.
    fwrite(STDERR, 'ОШИБКА: ' . $e->getMessage() . "\n"
        . 'в ' . $e->getFile() . ':' . $e->getLine() . "\n");
    error_log('DemoSeed FAILED: ' . $e->getMessage());
    exit(1);
}