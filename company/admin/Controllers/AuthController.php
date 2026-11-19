<?php
declare(strict_types=1);
namespace Company\Admin\Controllers;

use Company\Admin\Support\Csrf;
use Company\Admin\Support\Flash;

final class AuthController extends BaseController
{
    public function index(): void
    {
        if ($this->auth->check()) {
            $this->redirect('?page=dashboard');
        }

        if ($_SERVER['REQUEST_METHOD'] === 'POST') {
            $login    = trim((string) ($_POST['login'] ?? ''));
            $password = (string) ($_POST['password'] ?? '');

            if ($this->auth->attempt($login, $password)) {
                Csrf::rotate();
                $user = $this->auth->user();
                $this->audit->log('admin.login', ['login' => $login], (int) ($user['user_id'] ?? 0));
                $this->redirect('?page=dashboard');
            }

            $this->audit->log('admin.login_failed', ['login' => $login], 0);
            Flash::set('error', 'Неверный логин или пароль');
        }

        $this->render('auth.login', ['title' => 'Вход'], null);
    }

    public function logout(): void
    {
        $this->audit->log('admin.logout');
        $this->auth->logout();
        $this->redirect('?page=login');
    }
}