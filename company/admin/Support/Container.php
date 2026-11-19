<?php
declare(strict_types=1);
namespace Company\Admin\Support;

final class Container
{
    /** @var array<string, callable> */
    private array $bindings = [];
    /** @var array<string, mixed> */
    private array $instances = [];

    public function bind(string $id, callable $factory): void
    {
        $this->bindings[$id] = $factory;
    }

    public function get(string $id): mixed
    {
        if (isset($this->instances[$id])) {
            return $this->instances[$id];
        }
        if (!isset($this->bindings[$id])) {
            throw new \RuntimeException("No binding for {$id}");
        }
        return $this->instances[$id] = ($this->bindings[$id])($this);
    }
}
