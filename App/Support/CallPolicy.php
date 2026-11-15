<?php

declare(strict_types=1);

namespace App\Support;

/**
 * Права на действия с заявками — единая точка истины для online и offline.
 *
 * Зачем отдельный класс: права жили в двух копиях (checkCommandPermissions
 * для sync и can_* в репозитории для карточки), а online-путь не проверялся
 * вовсе — guest закрывал чужую заявку прямым callClose. Третья копия матрицы
 * гарантированно разъехалась бы с остальными.
 *
 * Политика чистая: только bool, без исключений и без обращения к БД.
 * Это нужно, чтобы те же предикаты отдавали can_* в карточку заявки,
 * где 403 неуместен — отказ там показывает UI.
 *
 * Порядок слоёв в can():
 *   0. неизвестное действие           → отказ (deny by default);
 *   1. guest                          → отказ ДО всех грантов;
 *   2. administrator                  → разрешено (уровень тенанта);
 *   3. ядро роли (ROLE_CORE)          → разрешено;
 *   4. доп. права (extra_permissions) → разрешено, аддитивно;
 *   5. legacy user_add_call           → разрешено только call.create, аддитивно.
 * Слои 4 и 5 равноправны (ИЛИ). Ни один грант не может отнять право ядра:
 * отзыв права делается изменением ядра/гранта, а не «запретом поверх».
 *
 * === КАК РАСШИРЯТЬ (точки помечены в коде маркерами) ===
 * A. Новое действие (например, переназначение ответственного):
 *    1) константа ACTION_*; 2) строка в ACTIONS; 3) строки в ROLE_CORE для
 *    тех ролей, кому право положено по ядру; 4) предикат-обёртка canXxx()
 *    по образцу существующих. Вызывающие места не меняются.
 * B. Доп. права от Админа (гибридная модель, bisness.md §1.3):
 *    слой 4 уже работает — достаточно начать отдавать
 *    $user['extra_permissions'] из AuthService::formatUser (транспорт).
 *    Сам этот файл при этом не правится вообще.
 * C. Группы лифтов и назначенность (bisness.md §3.1, §5.1):
 *    контекст уже принят сигнатурами предикатов и доезжает до can().
 *    Заполняется один слой внутри can() — сигнатуры, вызовы и матрица
 *    остаются прежними.
 * D. Переезд на user_group_access (bisness.md §4.2.4, флаг deprecated):
 *    удалить hasLegacyCreateFlag() и его вызов в can(). Больше ничего.
 *
 * Чего здесь сознательно нет:
 *   - прав на чтение списков (user_read_all_calls) — это CallScope, B3.2;
 *   - проверки «свои заявки» для engineer — известное ограничение,
 *     закрывается точкой C, а не отдельной копией матрицы.
 *
 * ЗАМЕТКА ДЛЯ РЕФАКТОРИНГА: комментарии этого файла — зафиксированные
 * решения, а не пересказ синтаксиса. Код восстанавливается из тестов,
 * решения — нет. Комментарии СОХРАНЯТЬ и переносить вместе с логикой;
 * удалять только вместе с той логикой, к которой они относятся
 * (блок «УДАЛИТЬ» — вместе с legacy-флагом).
 */
final class CallPolicy
{
    public const string ACTION_CREATE = 'call.create';
    public const string ACTION_EDIT = 'call.edit';
    public const string ACTION_CLOSE = 'call.close';
    public const string ACTION_COMMENT = 'call.comment';

    private const string ROLE_ADMIN = 'administrator';
    private const string ROLE_DISPATCHER = 'dispatcher';
    private const string ROLE_ENGINEER = 'engineer';
    private const string ROLE_GUEST = 'guest';

    /**
     * Реестр известных действий.
     *
     * Без строки здесь действие получит отказ у всех, включая админа:
     * опечатка в вызове не должна превращаться в разрешённое действие,
     * а «админ может всё» не должно распространяться на несуществующее.
     *
     * РАСШИРЕНИЕ A: новое действие добавляется сюда обязательно.
     */
    private const array ACTIONS = [
        self::ACTION_CREATE,
        self::ACTION_EDIT,
        self::ACTION_CLOSE,
        self::ACTION_COMMENT,
    ];

    /**
     * Ядро роли: только то, что положено по должности без доп. прав.
     *
     * administrator здесь нет намеренно — он разрешается отдельным слоем,
     * иначе каждое новое действие требовало бы «не забыть дописать админу».
     * guest здесь нет — он отсекается до матрицы.
     *
     * У engineer нет call.create: право выдаёт слой 4 (доп. право) или
     * слой 5 (legacy-флаг). Нет call.edit — механик не редактирует заявку
     * (bisness.md §5.1, §6.3), это не недосмотр.
     *
     * РАСШИРЕНИЕ A: строки для ролей, которым новое право положено по ядру.
     */
    private const array ROLE_CORE = [
        self::ROLE_DISPATCHER => [
            self::ACTION_CREATE => true,
            self::ACTION_EDIT => true,
            self::ACTION_CLOSE => true,
            self::ACTION_COMMENT => true,
        ],
        self::ROLE_ENGINEER => [
            self::ACTION_CLOSE => true,
            self::ACTION_COMMENT => true,
        ],
    ];

    /**
     * Единственная точка принятия решения.
     *
     * @param array{group_id?: int|null, call?: array|null}|null $context
     *        Контекст действия зарезервирован под группы и назначенность
     *        (точка C). Сейчас не читается: в Треке А групп нет, а
     *        назначенность engineer — известное ограничение. Принимается
     *        уже сегодня, чтобы завтра не переписывать вызовы.
     */
    public static function can(array $user, string $action, ?array $context = null): bool
    {
        if (!in_array($action, self::ACTIONS, true)) {
            return false;
        }

        $role = self::roleOf($user);

        // Гость — жёсткий отказ до всех грантов: ни legacy-флаг, ни доп.
        // право не должны давать ему запись (принятое решение по матрице).
        if ($role === self::ROLE_GUEST) {
            return false;
        }

        if ($role === self::ROLE_ADMIN) {
            return true;
        }

        if (self::ROLE_CORE[$role][$action] ?? false) {
            return true;
        }

        // РАСШИРЕНИЕ C: сюда, между ядром и грантами, встаёт слой контекста
        // (группа лифта / назначенность). Он читает $context и разрешает
        // действие в своей группе либо отказывает вне её. Пока слой
        // отсутствует, но контекст уже доезжает до этой точки — добавление
        // не потребует правок ни в предикатах, ни у вызывающих.

        if (self::hasExtraPermission($user, $action)) {
            return true;
        }

        return self::hasLegacyCreateFlag($user, $action);
    }

    /**
     * @param int|null $groupId группа лифта заявки; см. точку C в can().
     */
    public static function canCreate(array $user, ?int $groupId = null): bool
    {
        return self::can($user, self::ACTION_CREATE, ['group_id' => $groupId]);
    }

    /**
     * @param array|null $call строка заявки; см. точку C в can().
     */
    public static function canEdit(array $user, ?array $call = null): bool
    {
        return self::can($user, self::ACTION_EDIT, ['call' => $call]);
    }

    /**
     * @param array|null $call строка заявки; см. точку C в can().
     */
    public static function canClose(array $user, ?array $call = null): bool
    {
        return self::can($user, self::ACTION_CLOSE, ['call' => $call]);
    }

    /**
     * @param array|null $call строка заявки; см. точку C в can().
     */
    public static function canComment(array $user, ?array $call = null): bool
    {
        return self::can($user, self::ACTION_COMMENT, ['call' => $call]);
    }

    /**
     * Роль берётся как есть: нормализацию (mechanic→engineer,
     * foreman→dispatcher, fallback по флагам) делает AuthService::formatUser
     * — единственная точка сборки $user. Дублировать её здесь нельзя:
     * два словаря ролей разъедутся, и политика начнёт отказывать
     * легитимным пользователям.
     *
     * Пустая роль трактуется как guest: неизвестный пользователь не должен
     * получать права по умолчанию.
     */
    private static function roleOf(array $user): string
    {
        $role = (string) ($user['role'] ?? '');

        return $role === '' ? self::ROLE_GUEST : $role;
    }

    /**
     * Слой доп. прав от Админа (гибридная модель, bisness.md §1.3).
     *
     * Ожидаемая форма — плоский список строковых ключей в том же словаре,
     * что и ACTION_*. Если админка хранит права под другими именами
     * (can_reassign_staff, object_core_edit) или отдаёт JSON-объект вместо
     * списка, нормализацию делает ТРАНСПОРТ (formatUser / репозиторий
     * прав), а не политика: иначе здесь появится второй словарь и слой
     * перестанет быть предсказуемым.
     *
     * РАСШИРЕНИЕ B: поля пока нет в $user — слой молчит. Включение =
     * добавить транспорт, этот метод не меняется.
     */
    private static function hasExtraPermission(array $user, string $action): bool
    {
        $extra = $user['extra_permissions'] ?? [];

        if (!is_array($extra)) {
            return false;
        }

        return in_array($action, $extra, true);
    }

    /**
     * Legacy-флаг user_add_call → право на создание.
     *
     * Изолирован в одном методе намеренно: bisness.md §4.2.4 объявил флаг
     * deprecated, а принятое решение требует уважать его и в online, и в
     * offline. Когда права переедут в user_group_access.extra_permissions,
     * удаление не должно превращаться в поиск по всему коду.
     *
     * УДАЛИТЬ (точка D): этот метод и его вызов в can(). Предикаты,
     * матрица и вызывающие места при этом не трогаются.
     */
    private static function hasLegacyCreateFlag(array $user, string $action): bool
    {
        if ($action !== self::ACTION_CREATE) {
            return false;
        }

        return (int) ($user['user_add_call'] ?? 0) === 1;
    }
}