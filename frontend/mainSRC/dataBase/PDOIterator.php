<?php
namespace mainSRC\dataBase;

use Iterator;
use PDO;
use PDOStatement;

class PDOIterator implements Iterator
{
    private int $position = 0;
    private PDOStatement $pdo;
    private int $fetchMode;
    private mixed $nextResult = null;

    public function __construct(PDOStatement $pdo, int $fetchMode = PDO::FETCH_ASSOC)
    {
        $this->position = 0;
        $this->pdo = $pdo;
        $this->fetchMode = $fetchMode;
    }

    public function rewind(): void
    {
        $this->position = 0;
        $this->pdo->execute();
        $this->nextResult = $this->pdo->fetch($this->fetchMode, PDO::FETCH_ORI_NEXT);
    }

    public function current(): mixed
    {
        return $this->nextResult;
    }

    public function key(): int
    {
        return $this->position;
    }

    public function next(): void
    {
        ++$this->position;
        $this->nextResult = $this->pdo->fetch($this->fetchMode, PDO::FETCH_ORI_NEXT);
    }

    public function valid(): bool
    {
        $invalid = $this->nextResult === false;
        if ($invalid) {
            $this->pdo->closeCursor();
        }
        return !$invalid;
    }
}