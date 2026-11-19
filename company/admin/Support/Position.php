<?php

declare(strict_types=1);

namespace Company\Admin\Support;

/**
 * Должности организации. Slug'и побайтово из frontend/js/config.js (POSITIONS) —
 * это ключи матрицы прав SPA, «исправлять» их нельзя.
 *
 * Единственный источник карты позиция → роль. Ни контроллер, ни репозиторий
 * роль не выводят: из формы приходит позиция, роль считается здесь.
 *
 * Роли — сырые значения lift_users.user_role, их проверяет user-store.js:
 * administrator | dispatcher | engineer | guest. Нормализация Трека А
 * (mechanic → engineer и т.п.) к панели не применяется.
 */
enum Position: string
{
    case Admin = 'admin';
    case Director = 'director';
    case Dispatcher = 'dispatcher';
    case Foreman = 'foreman';
    case Mechanic = 'mechanic';
    case ElectronicEngineer = 'electronic-engineer';
    case Signalman = 'signalman';
    case Auditor = 'auditor';

    /**
     * Легаси: миграция sqlupdate.txt записала position='guest' для роли guest,
     * а словарь фронта знает только 'auditor'. Принимаем для чтения и
     * сохранения существующих строк; новых создавать не следует.
     */
    case Guest = 'guest';

    /**
     * Роль для lift_users.user_role. match без default: новая позиция без
     * записи в карте даст ошибку компиляции логики, а не тихий null.
     */
    public function role(): string
    {
        return match ($this) {
            self::Admin => 'administrator',
            self::Director, self::Dispatcher, self::Foreman => 'dispatcher',
            self::Mechanic, self::ElectronicEngineer, self::Signalman => 'engineer',
            self::Auditor, self::Guest => 'guest',
        };
    }

    /** Подпись из словаря фронта; для легаси добавлена пометка. */
    public function label(): string
    {
        return match ($this) {
            self::Admin => 'Администратор',
            self::Director => 'Директор',
            self::Dispatcher => 'Диспетчер',
            self::Foreman => 'Прораб',
            self::Mechanic => 'Механик',
            self::ElectronicEngineer => 'Инженер-наладчик',
            self::Signalman => 'Связист',
            self::Auditor => 'Аудитор',
            self::Guest => 'Аудитор (устар.)',
        };
    }

    /**
     * Даёт ли должность вход в панель настроек организации.
     * Для guard'ов «нельзя понизить последнего админа» и «не меняй свою позицию».
     */
    public function grantsPanelAccess(): bool
    {
        return $this->role() === 'administrator';
    }

    /**
     * Список для select: slug => подпись. Порядок — для UI, не порядок словаря.
     * Guest включён намеренно: без него форма редактирования легаси-записи
     * показала бы пустой select и молча сменила должность при сохранении.
     *
     * @return array<string, string>
     */
    public static function options(): array
    {
        $options = [];
        foreach (self::cases() as $case) {
            $options[$case->value] = $case->label();
        }

        return $options;
    }
}