<?php
declare(strict_types=1);
namespace Company\Admin\Support;

final class View
{
    public function render(string $template, array $data = [], ?string $layout = 'layout'): void
    {
        $content = $this->renderFile($template, $data);
        if ($layout !== null) {
            $content = $this->renderFile($layout, $data + ['content' => $content]);
        }
        echo $content;
    }

    private function renderFile(string $name, array $data): string
    {
        $path = __DIR__ . '/../Views/' . str_replace('.', '/', $name) . '.php';
        if (!file_exists($path)) {
            throw new \RuntimeException("View not found: {$name}");
        }
        extract($data, EXTR_SKIP);
        ob_start();
        require $path;
        return (string) ob_get_clean();
    }
}