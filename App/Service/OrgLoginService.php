<?php
declare(strict_types=1);

namespace App\Service;

use App\Database\DB;
use App\Exceptions\ApiException;
use App\Http\ErrorCode;
use App\Repository\UserRepository;
use App\Support\Logger;
use App\Support\OrgKeyGuard;
use App\Tenant;

/**
 * Быстрый вход диспетчера по ключу организации (B4.3 / B4.4).
 *
 * Оба действия публичные — без bearer. Единственный барьер — знание
 * ключа, поэтому порядок проверок здесь важнее самой логики:
 * сначала лимит перебора, только потом сравнение. Обратный порядок
 * позволял бы подбирать ключ, не увеличивая счётчик отказов.
 *
 * Отдельный сервис, а не методы AuthService: у AuthService нет DB,
 * только UserRepository. Чтение lift_options потребовало бы либо
 * инъекции DB (правка конструктора в двух контроллерах), либо чтения
 * чужой таблицы в репозитории пользователей. Здесь зависимости свои,
 * AuthService не тронут.
 */
final class OrgLoginService
{
    private const OPTION = 'org_key';

    /**
     * Предел длины ввода. Нормализованный ключ — 12 символов, поэтому
     * более длинная строка совпасть не может физически: обрезка не
     * ослабляет проверку, но не даёт гонять mb_strtoupper по мегабайтам.
     */
    private const MAX_INPUT = 128;

    public function __construct(
        private readonly DB $db,
        private readonly UserRepository $userRepo,
        private readonly Tenant $tenant
    ) {
    }

    /**
     * Проверка ключа и информация об организации.
     *
     * org_name отдаётся ВСЕГДА: он читается из тенанта по поддомену,
     * а домен и так идентифицирует организацию. Экран входа показывает
     * название до ввода ключа — гейтить его проверкой нечего.
     *
     * Пустой ввод — запрос информации, а не попытка подбора: ни лимит,
     * ни счётчик отказов не трогаем. Иначе открытие экрана входа
     * копило бы блокировку на добросовестного диспетчера.
     *
     * Несовпадение ключа — не исключение: фронту нужен inline-ответ
     * «ключ не подошёл». Исключение здесь только одно — лимит перебора.
     *
     * @return array{enabled:bool,valid:bool,org_name:string}
     */
    public function checkKey(string $input): array
    {
        $base = [
            'enabled'  => false,
            'valid'    => false,
            'org_name' => $this->tenant->orgName,
        ];

        $stored = $this->storedKey();

        // B4.4: пустой ключ в настройках = функция выключена.
        // Название организации при этом всё равно отдаём.
        if ($stored === '') {
            return $base;
        }

        $base['enabled'] = true;

        // Информационный вызов: экран входа ещё не получил ключ.
        if (trim($input) === '') {
            return $base;
        }

        $this->assertNotBlocked();
        $base['valid'] = $this->attempt($input, $stored);

        return $base;
    }

    /**
     * Список для быстрого входа. Ключ обязателен и проверяется полностью.
     *
     * Пустой список — не ошибка: ключ верный, диспетчеров с флагом нет.
     * Фронт показывает «нет доступных сотрудников», а не сбой.
     *
     * @return array{org_name:string,users:list<array{id:int,name:string}>}
     */
    public function listUsers(string $input): array
    {
        $stored = $this->storedKey();

        if ($stored === '') {
            throw new ApiException(
                ErrorCode::Forbidden,
                'Быстрый вход по ключу организации выключен',
                reason: 'org_key_disabled'
            );
        }

        $this->assertNotBlocked();

        if (!$this->attempt($input, $stored)) {
            throw new ApiException(
                ErrorCode::Forbidden,
                'Неверный ключ организации',
                reason: 'invalid_org_key'
            );
        }

        return [
            'org_name' => $this->tenant->orgName,
            'users'    => $this->userRepo->listQuickLogin(),
        ];
    }

    // -----------------------------------------------------------------------
    // Внутреннее
    // -----------------------------------------------------------------------

    /**
     * Сравнение с фиксацией исхода в лимитере.
     *
     * Пустой и сверхдлинный ввод попыткой перебора не считаем: это
     * ошибка ввода, а не подбор. Совпасть они не могут, информации
     * не дают, а счётчик прирос бы к добросовестному пользователю,
     * нажавшему «Проверить» на пустом поле.
     */
    private function attempt(string $input, string $stored): bool
    {
        $raw = trim($input);

        if ($raw === '' || mb_strlen($raw) > self::MAX_INPUT) {
            return false;
        }

        if (OrgKeyGuard::matches($raw, $stored)) {
            OrgKeyGuard::recordSuccess($this->tenant->id);
            return true;
        }

        OrgKeyGuard::recordFailure($this->tenant->id);

        Logger::warning('Неверный ключ организации', [
            'tenant' => $this->tenant->id,
            'ip'     => $_SERVER['REMOTE_ADDR'] ?? '',
        ]);

        return false;
    }

    /**
     * Лимит проверяется ДО сравнения — иначе перебор не учитывается.
     *
     * retry_after кладём в details: клиент читает и верхний уровень,
     * и error.details, и details —Envelope любой из трёх он разберёт.
     */
    private function assertNotBlocked(): void
    {
        $state = OrgKeyGuard::isBlocked($this->tenant->id);

        if ($state['blocked']) {
            throw new ApiException(
                ErrorCode::RateLimited,
                'Слишком много неверных попыток. Повторите позже.',
                reason: 'org_key_rate_limited',
                details: ['retry_after' => $state['retry_after']]
            );
        }
    }

    /**
     * Ключ из настроек тенанта.
     *
     * option_name в lift_options — обычный KEY, не UNIQUE. Дубли
     * возможны, поэтому порядок задан явно: новейшая строка (id DESC).
     * Без ORDER BY при дублях возвращалась бы произвольная, и ключ
     * «работал бы через раз».
     *
     * Значение берём строго из новейшей строки, не «первое непустое»:
     * админ, очистивший ключ, выключает функцию. Поиск непустого среди
     * старых строк включил бы её обратно против его воли.
     */
    private function storedKey(): string
    {
        $rows = $this->db->fetchAll(
            "SELECT option_value FROM lift_options
             WHERE option_name = :name
             ORDER BY id DESC",
            ['name' => self::OPTION]
        );

        if ($rows === []) {
            return '';
        }

        if (count($rows) > 1) {
            Logger::warning('lift_options: дубли org_key, используется новейшая строка', [
                'tenant' => $this->tenant->id,
                'count'  => count($rows),
            ]);
        }

        return trim((string) ($rows[0]['option_value'] ?? ''));
    }
}