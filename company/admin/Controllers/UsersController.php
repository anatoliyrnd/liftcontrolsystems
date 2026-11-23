<?php

declare(strict_types=1);

namespace Company\Admin\Controllers;

use App\Repository\UserRepository;
use App\Support\Password;
use Company\Admin\Repositories\Contracts\TokenRepositoryInterface;
use Company\Admin\Repositories\Contracts\UserRepositoryInterface;
use Company\Admin\Services\AuditService;
use Company\Admin\Services\SessionAuth;
use Company\Admin\Support\Flash;
use Company\Admin\Support\Position;
use Company\Admin\Support\View;

/**
 * Раздел «Пользователи». Роль не выбирается: выводится из должности
 * через Position::role() — единственный источник карты.
 *
 * user_block здесь НЕ редактируется: только action=block, где стоит
 * guard последнего администратора.
 */
final class UsersController extends BaseController
{
    private const MIN_PASSWORD = 8;

    /** Чекбоксы формы. Снятый не приходит в POST — проставляем 0 явно. */
    private const FLAGS = [
        'allow_dispatcher_quick_login',
        'user_hiden',
        'user_add_call',
        'user_read_all_calls',
        'user_disppermission',
        'user_edit_obj',
        'user_edit_user',
    ];

    /** Числовые идентификаторы мессенджеров: nullable bigint в схеме. */
    private const ID_FIELDS = [
        'user_telegram',
        'user_max',
        'user_vk',
    ];

    /**
     * Лимиты из SHOW COLUMNS рабочей базы. sql_mode без STRICT, поэтому
     * MySQL не откажет, а молча обрежет строку — эта проверка единственная.
     */
    private const LIMITS = [
        'user_login' => 30,
        'user_email' => 200,
        'user_surname' => 100,
        'user_firstname' => 100,
        'user_patronymic' => 100,
        'user_phone' => 39,
        'user_address' => 200,
    ];

    public function __construct(
        View $view,
        SessionAuth $auth,
        AuditService $audit,
        private readonly UserRepositoryInterface $users,
        private readonly TokenRepositoryInterface $tokens
    ) {
        parent::__construct($view, $auth, $audit);
    }

    public function index(): void
    {
        $this->render('users.list', [
            'title' => 'Пользователи',
            'users' => $this->users->list(),
        ]);
    }

    public function create(): void
    {
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
            $this->renderForm(null, [], []);
            return;
        }

        [$fields, $errors] = $this->collect();

        $password = (string) ($_POST['password'] ?? '');
        if (mb_strlen($password) < self::MIN_PASSWORD) {
            $errors['password'] = 'Пароль не короче ' . self::MIN_PASSWORD . ' символов';
        }

        if ($errors === []) {
            $conflict = $this->users->findIdentityConflict(
                $fields['user_login'],
                $fields['user_email']
            );
            if ($conflict !== null) {
                $errors[$conflict === 'login' ? 'user_login' : 'user_email'] =
                    $conflict === 'login' ? 'Логин уже занят' : 'Email уже занят';
            }
        }

        if ($errors !== []) {
            $this->renderForm(null, $_POST, $errors);
            return;
        }

        $id = $this->users->create($fields, Password::hash($password));

        $this->audit->log('user.create', [
            'user_id'  => $id,
            'login'    => $fields['user_login'],
            'position' => $fields['user_position'],
            'role'     => $fields['user_role'],
        ]);

        Flash::set('success', 'Пользователь создан');
        $this->redirect('?page=users');
    }

    public function edit(): void
    {
        $id = (int) ($_POST['id'] ?? $_GET['id'] ?? 0);
        $user = $this->users->findById($id);

        if ($user === null) {
            http_response_code(404);
            echo 'Пользователь не найден';
            return;
        }

        if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
            $this->renderForm($user, $user, []);
            return;
        }

        [$fields, $errors] = $this->collect();

        $position = Position::tryFrom($fields['user_position']);
        if ($position !== null) {
            $guard = $this->guardPosition($user, $position);
            if ($guard !== null) {
                $errors['user_position'] = $guard;
            }
        }

        // Пустой пароль при редактировании = не меняем.
        $password = (string) ($_POST['password'] ?? '');
        if ($password !== '' && mb_strlen($password) < self::MIN_PASSWORD) {
            $errors['password'] = 'Пароль не короче ' . self::MIN_PASSWORD . ' символов';
        }

        if ($errors === []) {
            $conflict = $this->users->findIdentityConflict(
                $fields['user_login'],
                $fields['user_email'],
                $id
            );
            if ($conflict !== null) {
                $errors[$conflict === 'login' ? 'user_login' : 'user_email'] =
                    $conflict === 'login' ? 'Логин уже занят' : 'Email уже занят';
            }
        }

        if ($errors !== []) {
            $this->renderForm($user, $_POST, $errors);
            return;
        }

        $this->users->update($id, $fields);

        if ($password !== '') {
            $this->users->updatePasswordHash($id, Password::hash($password));

            // Смена пароля обязана выбросить все устройства: иначе
            // украденный пароль оставляет вору живые сессии на 30 дней,
            // и сброс не лечит компрометацию, ради которой его делают.
            //
            // Все семьи, а не «кроме текущей»: cookie lift_refresh
            // целевого пользователя у панели нет — админ в своей сессии,
            // опознать чужую текущую семью нечем. Сессия панели отдельная.
            $this->tokens->revokeAllForUser($id);
        }

        $this->audit->log('user.update', [
            'user_id'  => $id,
            'login'    => $fields['user_login'],
            'position' => $fields['user_position'],
            'role'     => $fields['user_role'],
            'password' => $password !== '' ? 'changed' : 'kept',
            'sessions' => $password !== '' ? 'revoked' : 'kept',
        ]);

        Flash::set(
            'success',
            $password !== ''
                ? 'Сохранено. Пароль сменён, все сессии пользователя завершены'
                : 'Изменения сохранены'
        );
        $this->redirect('?page=users');
    }

    public function block(): void
    {
        // Только POST: на GET не проверяется CSRF, действие было бы
        // вызываемо картинкой со стороннего сайта.
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
            $this->redirect('?page=users');
        }

        $id = (int) ($_POST['id'] ?? 0);
        $user = $this->users->findById($id);

        if ($user === null) {
            http_response_code(404);
            echo 'Пользователь не найден';
            return;
        }

        $blocked = (int) ($_POST['blocked'] ?? 0) === 1;

        if ($blocked) {
            if ($id === $this->actorId()) {
                Flash::set('danger', 'Нельзя заблокировать самого себя');
                $this->redirect('?page=users');
            }

            $position = Position::tryFrom((string) ($user['user_position'] ?? ''));
            if ($position !== null && $position->grantsPanelAccess() && $this->activeAdmins() <= 1) {
                Flash::set('danger', 'Нельзя заблокировать последнего администратора');
                $this->redirect('?page=users');
            }
        }

        $this->users->setBlocked($id, $blocked);

        if ($blocked) {
            // Блокировка обязана гасить сессии на сервере, а не ждать
            // клиента: user_block проверяется только в login() и validate()
            // (AuthService:59, :93). validate — cooperative, вор может его
            // не звать. Ротация refresh флаг не читает вовсе и выдаёт
            // преемнику новые 30 дней — цепочка продлевается бесконечно.
            $this->tokens->revokeAllForUser($id);
        } else {
            // Разблокировка снимает и rate-limit: иначе человек выйдет из
            // административного блока прямо в блокировку по попыткам.
            $this->users->resetLoginState($id);
        }

        $this->audit->log('user.block', [
            'user_id'  => $id,
            'blocked'  => $blocked ? 1 : 0,
            'sessions' => $blocked ? 'revoked' : 'untouched',
        ]);

        Flash::set(
            'success',
            $blocked
                ? 'Пользователь заблокирован, все его сессии завершены'
                : 'Пользователь разблокирован'
        );
        $this->redirect('?page=users');
    }

    /**
     * Сброс авторизации на всех устройствах: гасим refresh и access SPA.
     *
     * Сессия самой панели отдельная (LIFTCS_ADMIN, PHP-session), токены
     * SPA её не касаются — админ может погасить свои же SPA-сессии и
     * остаться в панели. Поэтому self-guard здесь не нужен.
     *
     * Легаси api_token / user_token вне охвата по решению владельца.
     */
    public function revoke(): void
    {
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
            $this->redirect('?page=users');
        }

        $id = (int) ($_POST['id'] ?? 0);
        $user = $this->users->findById($id);

        if ($user === null) {
            http_response_code(404);
            echo 'Пользователь не найден';
            return;
        }

        // Возврат не используем намеренно: форма результата зависит от
        // нерешённой развилки «делегируем отзыв владельцу или свои DELETE».
        // Аудит фиксирует кто/кому/что, число строк ему не нужно.
        $this->tokens->revokeAllForUser($id);

        $this->audit->log('user.revoke_sessions', [
            'user_id' => $id,
            'login'   => (string) $user['user_login'],
        ]);

        Flash::set('success', 'Сессии завершены на всех устройствах');
        $this->redirect('?page=users');
    }

    /**
     * Принудительная перезагрузка клиента одного пользователя.
     *
     * SPA флаг пока не читает — чтение и сброс в 0 записаны в техдолг.
     * Сообщение говорит об этом прямо, иначе админ ищет несуществующий дефект.
     */
    public function reload(): void
    {
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
            $this->redirect('?page=users');
        }

        $id = (int) ($_POST['id'] ?? 0);
        $user = $this->users->findById($id);

        if ($user === null) {
            http_response_code(404);
            echo 'Пользователь не найден';
            return;
        }

        $this->users->setForceReload($id);

        $this->audit->log('user.force_reload', [
            'user_id' => $id,
            'login'   => (string) $user['user_login'],
        ]);

        Flash::set('success', 'Флаг перезагрузки выставлен. SPA применит его после доработки фронта');
        $this->redirect('?page=users');
    }

    /**
     * Массовая перезагрузка: force_reload = 1 у всех записей тенанта.
     *
     * Маркер confirm=all — защита от случайной отправки формы, не граница
     * безопасности: её держат CSRF и авторизация. Без маркера отказ.
     */
    public function reloadAll(): void
    {
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
            $this->redirect('?page=users');
        }

        if (($_POST['confirm'] ?? '') !== 'all') {
            Flash::set('danger', 'Массовая перезагрузка не подтверждена');
            $this->redirect('?page=users');
        }

        $count = $this->users->setForceReloadAll();

        $this->audit->log('user.force_reload_all', ['affected' => $count]);

        // changed, не found: у кого флаг уже был 1, в число не попал.
        Flash::set('success', 'Флаг выставлен у ' . $count . ' записей, у остальных он уже был');
        $this->redirect('?page=users');
    }

    /**
     * Сбор и валидация полей. Роль выводится из должности, не приходит из формы.
     *
     * @return array{0: array<string, mixed>, 1: array<string, string>}
     */
    private function collect(): array
    {
        $errors = [];

        $read = static fn(string $key): string => trim((string) ($_POST[$key] ?? ''));

        // Первая буква заглавная, остальное как введено: принудительный
        // lower испортил бы «оглы», «МакКлейн» и дефисные фамилии.
        $ucFirst = static function (string $v): string {
            return $v === ''
                ? ''
                : mb_strtoupper(mb_substr($v, 0, 1, 'UTF-8'), 'UTF-8') . mb_substr($v, 1);
        };

        $fields = [
            'user_login'      => $read('user_login'),
            'user_email'      => $read('user_email'),
            'user_surname'    => $ucFirst($read('user_surname')),
            'user_firstname'  => $ucFirst($read('user_firstname')),
            // NULL, не '': updateProfile и get_user_settings отдают null,
            // два разных «пусто» в колонке разошлись бы при чтении.
            'user_patronymic' => $ucFirst($read('user_patronymic')) ?: null,
            'user_address'    => $read('user_address'),
        ];

        foreach (['user_login', 'user_email', 'user_surname', 'user_firstname'] as $required) {
            if ($fields[$required] === '') {
                $errors[$required] = 'Поле обязательно';
            }
        }

        // Логин не ограничиваем по алфавиту: легаси-учётки могут содержать
        // символы вне [a-z0-9], запрет сломал бы их редактирование.
        if ($fields['user_email'] !== '' && !filter_var($fields['user_email'], FILTER_VALIDATE_EMAIL)) {
            $errors['user_email'] = 'Некорректный email';
        }

        // Телефон: храним цифры, маска — представление. 8 → 7,
        // десять цифр дополняются кодом страны.
        $phone = preg_replace('/\D+/', '', $read('user_phone')) ?? '';
        if ($phone !== '') {
            if (strlen($phone) === 11 && $phone[0] === '8') {
                $phone = '7' . substr($phone, 1);
            } elseif (strlen($phone) === 10) {
                $phone = '7' . $phone;
            }
            if (preg_match('/^7\d{10}$/', $phone) !== 1) {
                $errors['user_phone'] = 'Мобильный: 11 цифр с кодом 7 или 10 цифр без кода';
            }
        }
        $fields['user_phone'] = $phone;

        // Числовые ID: пусто → NULL, не 0 и не ''. Без STRICT MySQL
        // молча прижмёт значение вне диапазона bigint к границе.
        foreach (self::ID_FIELDS as $key) {
            $raw = $read($key);
            if ($raw === '') {
                $fields[$key] = null;
                continue;
            }
            $value = filter_var($raw, FILTER_VALIDATE_INT, [
                'options' => ['min_range' => 1, 'max_range' => PHP_INT_MAX],
            ]);
            if ($value === false) {
                $errors[$key] = 'Только цифры, от 1 до ' . PHP_INT_MAX;
                $fields[$key] = null;
            } else {
                $fields[$key] = $value;
            }
        }

        foreach (self::LIMITS as $key => $max) {
            if (isset($fields[$key]) && mb_strlen((string) $fields[$key]) > $max) {
                $errors[$key] = 'Не длиннее ' . $max . ' символов';
            }
        }

        // Формат «Фамилия И.О.» принадлежит App\Repository\UserRepository:
        // его docblock обязывает админку звать composeDisplayName, а не
        // собирать строку заново. Вызов статический, без БД — шов Db→Api
        // не затрагивает. Обрезка не нужна: фамилия ≤100, инициалы ≤4.
        $fields['user_name'] = UserRepository::composeDisplayName(
            $fields['user_surname'],
            $fields['user_firstname'],
            $fields['user_patronymic']
        );

        $position = Position::tryFrom($read('user_position'));
        if ($position === null) {
            $errors['user_position'] = 'Выберите должность из списка';
            $fields['user_position'] = '';
            $fields['user_role'] = '';
        } else {
            $fields['user_position'] = $position->value;
            $fields['user_role'] = $position->role();
        }

        foreach (self::FLAGS as $flag) {
            $fields[$flag] = isset($_POST[$flag]) ? 1 : 0;
        }

        return [$fields, $errors];
    }

    /**
     * Своя должность неизменяема: админ, сменивший её, теряет вход в панель
     * на следующем же запросе. Последний админ не понижается.
     *
     * @param array<string, mixed> $user
     */
    private function guardPosition(array $user, Position $new): ?string
    {
        $current = (string) ($user['user_position'] ?? '');

        if ($new->value === $current) {
            return null;
        }

        if ((int) $user['user_id'] === $this->actorId()) {
            return 'Нельзя менять свою должность — потеряете вход в панель';
        }

        $wasAdmin = Position::tryFrom($current)?->grantsPanelAccess() ?? false;

        if ($wasAdmin && !$new->grantsPanelAccess() && $this->activeAdmins() <= 1) {
            return 'Нельзя понизить последнего администратора';
        }

        return null;
    }

    /**
     * Админы, способные войти: заблокированные не считаем, иначе понижение
     * активного оставит ноль рабочих входов в панель.
     */
    private function activeAdmins(): int
    {
        $count = 0;

        foreach ($this->users->list() as $row) {
            if ((int) ($row['user_block'] ?? 0) === 1) {
                continue;
            }
            $position = Position::tryFrom((string) ($row['user_position'] ?? ''));
            if ($position !== null && $position->grantsPanelAccess()) {
                $count++;
            }
        }

        return $count;
    }

    private function actorId(): int
    {
        return (int) ($this->auth->user()['user_id'] ?? 0);
    }

    /**
     * @param array<string, mixed>|null $user
     * @param array<string, mixed>      $old
     * @param array<string, string>     $errors
     */
    private function renderForm(?array $user, array $old, array $errors): void
    {
        // BaseController::render() кладёт 'user' = авторизованный админ,
        // и layout рисует по нему шапку. Редактируемую запись отдаём как
        // 'record': иначе шапка покажет имя редактируемого вместо вошедшего.
        //
        // Из записи и из POST берём только поля формы: findById возвращает
        // SELECT *, то есть user_password, api_token, user_token — в область
        // видимости шаблона они попадать не должны. Заодно 'password' из POST
        // не возвращается в форму: пароль никогда не переотрисовывается.
        $keys = array_flip(array_merge([
            'user_id',
            'user_login',
            'user_email',
            'user_surname',
            'user_firstname',
            'user_patronymic',
            'user_phone',
            'user_address',
            'user_telegram',
            'user_max',
            'user_vk',
            'user_position',
        ], self::FLAGS));

        $this->render('users.form', [
            'title'     => $user === null ? 'Новый пользователь' : 'Редактирование пользователя',
            'record'    => $user === null ? null : array_intersect_key($user, $keys),
            'old'       => array_intersect_key($old, $keys),
            'errors'    => $errors,
            'positions' => Position::options(),
        ]);
    }
}