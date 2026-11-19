<?php
declare(strict_types=1);
namespace Company\Admin\Controllers;

use Company\Admin\Services\AuditService;
use Company\Admin\Services\SessionAuth;
use Company\Admin\Support\Flash;
use Company\Admin\Support\View;

abstract class BaseController
{
    public function __construct(
        protected readonly View $view,
        protected readonly SessionAuth $auth,
        protected readonly AuditService $audit,
    ) {}

    protected function render(string $template, array $data = [], ?string $layout = 'layout'): void
    {
        $this->view->render($template, $data + [
            'user'  => $this->auth->user(),
            'flash' => Flash::take(),
        ], $layout);
    }

    protected function redirect(string $url): never
    {
        header('Location: ' . $url);
        exit;
    }
}