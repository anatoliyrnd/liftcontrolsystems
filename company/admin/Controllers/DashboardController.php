<?php
declare(strict_types=1);
namespace Company\Admin\Controllers;

final class DashboardController extends BaseController
{
    public function index(): void
    {
        // Виджеты добавим отдельной итерацией: каждая цифра — свой запрос
        // через репозиторий, не в этом файле.
        $this->render('dashboard', ['title' => 'Дашборд']);
    }
}