<?php

declare(strict_types=1);

namespace Company\Admin\Controllers;

use App\Support\Password;
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

    /** Лимиты из SHOW COLUMNS: превышение в STRICT даст отказ MySQL. */
    private const LIMITS = [
        'user_login' => 30,
        'user_email' => 200,
        'user_surname' => 100,
        'user_firstname' => 100,
        'user_patronymic' => 100,
        'user_phone' => 39,
        'user_name' => 200,
    ];

    public function __construct(
        View $view,
        SessionAuth $auth,
        AuditService $audit,
        private readonly UserRepositoryInterface $users
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

        $this->audit->log($this->actorId(), 'user.create', [
            'user_id'  => $id,
            'login'    => $fields['user_login'],
            'position' => $fields['user_position'],
            'role'     => $fields['user_role'],
        ]);

        Flash::set('success', 'Пользователь создан');
        $this->redirect('users');
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
        }

        $this->audit->log($this->actorId(), 'user.update', [
            'user_id'  => $id,
            'login'    => $fields['user_login'],
            'position' => $fields['user_position'],
            'role'     => $fields['user_role'],
            'password' => $password !== '' ? 'changed' : 'kept',
        ]);

        Flash::set('success', 'Изменения сохранены');
        $this->redirect('users');
    }

    public function block(): void
    {
        // Только POST: на GET не проверяется CSRF, действие было бы
        // вызываемо картинкой со стороннего сайта.
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
            $this->redirect('users');
            return;
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
                $this->redirect('users');
                return;
            }

            $position = Position::tryFrom((string) ($user['user_position'] ?? ''));
            if ($position !== null && $position->grantsPanelAccess() && $this->activeAdmins() <= 1) {
                Flash::set('danger', 'Нельзя заблокировать последнего администратора');
                $this->redirect('users');
                return;
            }
        }

        $this->users->setBlocked($id, $blocked);

        // Разблокировка снимает и rate-limit: иначе человек выйдет из
        // административного блока прямо в блокировку по попыткам.
        if (!$blocked) {
            $this->users->resetLoginState($id);
        }

        $this->audit->log($this->actorId(), 'user.block', [
            'user_id' => $id,
            'blocked' => $blocked ? 1 : 0,
        ]);

        Flash::set('success', $blocked ? 'Пользователь заблокирован' : 'Пользователь разблокирован');
        $this->redirect('users');
    }

    /**
     * Сбор и валидация полей. Роль выводится из должности, не приходит из формы.
     *
     * @return array{0: array<string, mixed>, 1: array<string, string>}
     */
    private function collect(): array
    {
        $errors = [];

        $read = static function (string $key): string {
            return trim((string) ($_POST[$key] ?? ''));
        };

        $fields = [
            'user_login'      => $read('user_login'),
            'user_email'      => $read('user_email'),
            'user_surname'    => $read('user_surname'),
            'user_firstname'  => $read('user_firstname'),
            'user_patronymic' => $read('user_patronymic'),
            'user_phone'      => $read('user_phone'),
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

        foreach (self::LIMITS as $key => $max) {
            if (isset($fields[$key]) && mb_strlen($fields[$key]) > $max) {
                $errors[$key] = 'Не длиннее ' . $max . ' символов';
            }
        }

        $fields['user_name'] = trim((string) preg_replace(
            '/\s+/',
            ' ',
            $fields['user_surname'] . ' ' . $fields['user_firstname'] . ' ' . $fields['user_patronymic']
        ));

        if (mb_strlen($fields['user_name']) > self::LIMITS['user_name']) {
            $errors['user_surname'] = 'ФИО длиннее 200 символов';
        }

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
        $this->render('users.form', [
            'title'     => $user === null ? 'Новый пользователь' : 'Редактирование пользователя',
            'user'      => $user,
            'old'       => $old,
            'errors'    => $errors,
            'positions' => Position::options(),
        ]);
    }
}