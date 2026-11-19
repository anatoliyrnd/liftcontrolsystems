<?php
declare(strict_types=1);
namespace Company\Admin\Support;

final class Router
{
    /**
     * @param array<string, array{0:class-string,1:string}> $routes
     */
    public function __construct(
        private readonly array $routes,
        private readonly Container $container,
    ) {}

    public function dispatch(string $page, string $action): void
    {
        $key = $page . '.' . $action;
        $target = $this->routes[$key] ?? null;

        if ($target === null) {
            http_response_code(404);
            echo 'Not Found';
            return;
        }

        [$class, $method] = $target;
        $controller = $this->instantiate($class);

        if (!method_exists($controller, $method)) {
            http_response_code(500);
            echo 'Handler not found';
            return;
        }

        $controller->{$method}();
    }

    private function instantiate(string $class): object
    {
        $reflection = new \ReflectionClass($class);
        $ctor = $reflection->getConstructor();
        if ($ctor === null) {
            return $reflection->newInstance();
        }

        $args = [];
        foreach ($ctor->getParameters() as $param) {
            $type = $param->getType();
            if (!$type instanceof \ReflectionNamedType || $type->isBuiltin()) {
                throw new \RuntimeException("Cannot autowire {$class}::\${$param->getName()}");
            }
            $args[] = $this->container->get($type->getName());
        }
        return $reflection->newInstanceArgs($args);
    }
}