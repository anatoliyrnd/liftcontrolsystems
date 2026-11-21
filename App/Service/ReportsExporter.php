<?php
declare(strict_types=1);

namespace App\Service;

use App\Exceptions\ApiException;
use App\Http\ErrorCode;
/**
 * Сборка CSV отчёта. Потоково в php://temp: 2000 строк не держим в
 * памяти единой строкой до base64.
 *
 * Суффиксы каналов — зеркало §1.3 БЕЗ эмодзи: те же слова, что рисует
 * body-render в таблице, иначе UI и CSV разойдутся. getStatusWord() из
 * карточки не используем: он даёт «web онлайн» — третью формулировку.
 *
 * «Wrap text» и «автофильтр» не заявляются: CSV метаданных форматирования
 * не хранит, это перенесено в волну 3 (XLSX).
 */
final class ReportsExporter
{
    private const SUFFIXES = [
        1 => 'по телефону',
        2 => 'онлайн',
        3 => 'в телеграм',
        4 => 'в макс',
        5 => 'в вк',
        6 => 'по смс',
        7 => 'по email',
    ];

    public function renderCsv(array $rows): string
    {
        $h = fopen('php://temp', 'r+');
        if ($h === false) {
            // Пустая строка уехала бы в base64 как валидный файл:
            // rows_count = N, содержимое нулевое. Пользователь не отличит
            // сбой формирования от «данных нет» и решит, что выборка пуста.
            throw new ApiException(
                ErrorCode::InternalError,
                'Не удалось сформировать файл выгрузки'
            );
        }
        fwrite($h, "\xEF\xBB\xBF");
        fputcsv($h, ['ID', 'Адрес', 'Описание', 'Закрытие', 'Отв. 1', 'Отв. 2', 'Отв. 3'], ';', '"', '');

        foreach ($rows as $r) {
            $closed = (int) ($r['call_status'] ?? 0) === 1;
            $address = (string) ($r['call_adres'] ?? '')
                . "\n" . date('d.m.Y H:i', (int) ($r['call_date'] ?? 0))
                . ' · ' . (string) ($r['call_first_name'] ?? '');
            $close = $closed
                ? date('d.m.Y H:i', (int) ($r['call_date2'] ?? 0)) . "\n"
                . (((string) ($r['call_last_name'] ?? '')) !== ''
                    ? (string) $r['call_last_name']
                    : (((string) ($r['call_last_name_close'] ?? '')) !== '' ? (string) $r['call_last_name_close'] : '—'))
                : '—';

            fputcsv($h, [
                self::cell((string) ($r['call_id'] ?? '')),
                self::cell($address),
                self::cell((string) ($r['call_details'] ?? '')),
                self::cell($close),
                self::cell($this->staffCell($r, 1)),
                self::cell($this->staffCell($r, 2)),
                self::cell($this->staffCell($r, 3)),
            ], ';', '"', '');
        }

        rewind($h);
        $out = stream_get_contents($h);
        fclose($h);
        if ($out === false || ($rows !== [] && $out === '')) {
            throw new ApiException(
                ErrorCode::InternalError,
                'Не удалось сформировать файл выгрузки'
            );
        }
        return $out;
    }

    private function staffCell(array $r, int $slot): string
    {
        // Первый слот в selectRows() без суффикса: c.call_staff,
        // c.call_staff_status, c.call_staff_date, u1.user_name AS staff_name.
        // Обращение по staff_name1/call_staff1 давало id = 0 и ранний
        // return '—' — первый ответственный терялся во всех строках.
        $s = $slot === 1 ? '' : (string) $slot;
        $name = (string) ($r["staff_name$s"] ?? '');
        $id = (int) ($r["call_staff$s"] ?? 0);
        if ($id <= 0 || $name === '') {
            return '—';
        }
        // ?? обязателен: без него отсутствующий ключ даёт warning,
        // а set_error_handler из bootstrap превращает его в исключение.
        $status = (int) ($r["call_staff_status$s"] ?? 0);
        $date = (int) ($r["call_staff_date$s"] ?? 0);
        if ($status <= 0) {
            return $name . "\nНе уведомлен";
        }
        $suffix = self::SUFFIXES[$status] ?? 'неизвестный канал (' . $status . ')';
        $line = $date > 0
            ? 'Статус: ' . $suffix . ' · ' . date('d.m.Y H:i', $date)
            : 'Статус: ' . $suffix;
        return $name . "\n" . $line;
    }

    /**
     * Защита от CSV-инъекции: Excel трактует ведущие = + - @ как формулу.
     * Префикс-апостроф виден в ячейке, но формула не выполняется.
     */
    private static function cell(string $value): string
    {
        return $value !== '' && str_contains('=+-@', $value[0]) ? "'" . $value : $value;
    }
}