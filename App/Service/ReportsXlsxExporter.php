<?php

declare(strict_types=1);

namespace App\Service;

/**
 * XLSX без библиотек: ZipArchive + минимальный SpreadsheetML.
 *
 * why не HTML с MIME vnd.ms-excel (как легаси): Excel ругается на
 * несоответствие расширения, ширины и переносы не переносятся,
 * защиты от формул нет. Здесь t="inlineStr" — значение "=SUM(...)"
 * остаётся текстом, защита встроена в тип ячейки.
 *
 * Плоский набор: одно значение = одна колонка, иначе автофильтр и
 * сводные не работают. Пустой слот — пустая ячейка, не прочерк.
 * Даты — настоящие Excel-даты с numFmt, offset берётся из DateTime
 * в Europe/Moscow, а не хардкодом +3.
 */
class ReportsXlsxExporter
{
    private const DATE_FMT_ID = 164;
    private const EXCEL_EPOCH = 25569.0;
    private const TZ = 'Europe/Moscow';

    private const S_HEADER = 1;
    private const S_WRAP = 2;
    private const S_TEXT = 3;
    private const S_DATE = 4;
    private const S_NUM = 5;

    /**
     * Суффиксы каналов — тот же набор §1.3, что CSV и body-render.
     * getStatusWord() из карточки не используется: он даёт третью
     * формулировку и разъезжается с журналом.
     */
    private const CHANNELS = [
        1 => 'по телефону',
        2 => 'онлайн',
        3 => 'в телеграм',
        4 => 'в макс',
        5 => 'в вк',
        6 => 'по смс',
        7 => 'по email',
    ];

    /** Заголовок, ширина в символах, стиль данных. Порядок = порядок rowValues(). */
    private const COLUMNS = [
        ['№', 8, self::S_NUM],
        ['Адрес', 42, self::S_WRAP],
        ['Статус', 10, self::S_TEXT],
        ['Дата создания', 18, self::S_DATE],
        ['Кто открыл', 22, self::S_TEXT],
        ['Срок ремонта', 18, self::S_DATE],
        ['Просрочена', 12, self::S_TEXT],
        ['Описание', 60, self::S_WRAP],
        ['Отдел', 22, self::S_TEXT],
        ['Группа', 20, self::S_TEXT],
        ['Тип запроса', 18, self::S_TEXT],
        ['Уровень тревоги', 10, self::S_NUM],
        ['Отв. 1', 24, self::S_TEXT],
        ['Отв. 1 канал', 16, self::S_TEXT],
        ['Отв. 1 уведомлён', 18, self::S_DATE],
        ['Отв. 2', 24, self::S_TEXT],
        ['Отв. 2 канал', 16, self::S_TEXT],
        ['Отв. 2 уведомлён', 18, self::S_DATE],
        ['Отв. 3', 24, self::S_TEXT],
        ['Отв. 3 канал', 16, self::S_TEXT],
        ['Отв. 3 уведомлён', 18, self::S_DATE],
        ['Дата закрытия', 18, self::S_DATE],
        ['Кто закрыл', 22, self::S_TEXT],
        ['Решение', 50, self::S_WRAP],
        ['Время до закрытия, мин', 14, self::S_NUM],
        ['Комментариев, шт', 14, self::S_NUM],
        ['Комментарии', 70, self::S_WRAP],
    ];

    public function renderXlsx(array $items): string
    {
        $now = time();
        $rows = [];
        $rows[] = $this->headerRow();
        $n = 1;
        foreach ($items as $item) {
            if (!is_array($item)) {
                continue;
            }
            $n++;
            $rows[] = $this->dataRow($n, $this->rowValues($item, $now));
        }
        $last = $this->colLetter(count(self::COLUMNS) - 1) . $n;

        $tmp = tempnam(sys_get_temp_dir(), 'liftxlsx');
        if ($tmp === false) {
            throw new \RuntimeException('Не удалось создать временный файл XLSX');
        }
        $zip = new \ZipArchive();
        if ($zip->open($tmp, \ZipArchive::CREATE | \ZipArchive::OVERWRITE) !== true) {
            unlink($tmp);
            throw new \RuntimeException('ZipArchive не открыл временный файл');
        }
        $zip->addFromString('[Content_Types].xml', $this->contentTypes());
        $zip->addFromString('_rels/.rels', $this->rootRels());
        $zip->addFromString('xl/workbook.xml', $this->workbook());
        $zip->addFromString('xl/_rels/workbook.xml.rels', $this->workbookRels());
        $zip->addFromString('xl/styles.xml', $this->styles());
        $zip->addFromString('xl/worksheets/sheet1.xml', $this->sheet($rows, $last));
        $zip->close();

        $data = file_get_contents($tmp);
        unlink($tmp);
        if ($data === false) {
            throw new \RuntimeException('Не удалось прочитать собранный XLSX');
        }
        return $data;
    }

    /** Значения в порядке COLUMNS. Прочерки mapItem гасятся в пустоту. */
    private function rowValues(array $it, int $now): array
    {
        $closed = ($it['type'] ?? '') === 'close';
        $created = (int) ($it['date'] ?? 0);
        $repair = (int) ($it['repair_time'] ?? 0);
        $closeTs = (int) ($it['close_date'] ?? 0);
        $notes = is_array($it['notes'] ?? null) ? $it['notes'] : [];

        return [
            (int) ($it['id'] ?? 0),
            (string) ($it['fullAddress'] ?? ''),
            $closed ? 'Закрыта' : 'Открыта',
            $created,
            (string) ($it['created_by'] ?? ''),
            $repair,
            !$closed && $repair > 0 && $repair < $now ? 'Да' : '',
            (string) ($it['details'] ?? ''),
            $this->plain($it['department'] ?? null),
            $this->plain($it['group'] ?? null),
            $this->plain($it['request'] ?? null),
            (int) ($it['alert_level'] ?? 0),
            $this->staff($it, ''),
            $this->channel($it, ''),
            $this->notifyTs($it, ''),
            $this->staff($it, '2'),
            $this->channel($it, '2'),
            $this->notifyTs($it, '2'),
            $this->staff($it, '3'),
            $this->channel($it, '3'),
            $this->notifyTs($it, '3'),
            $closeTs,
            $closed ? $this->plain($it['close_name'] ?? null) : '',
            $closed ? $this->plain($it['solution'] ?? null) : '',
            $closed && $closeTs > 0 && $created > 0
                ? (int) round(($closeTs - $created) / 60)
                : null,
            count($notes),
            $this->commentsCell($notes),
        ];
    }

    private function plain(mixed $v): string
    {
        $s = trim((string) ($v ?? ''));
        return $s === '—' ? '' : $s;
    }

    private function staff(array $it, string $sfx): string
    {
        $id = (int) ($it['staff_id' . $sfx] ?? 0);
        $name = trim((string) ($it['staff_name' . $sfx] ?? ''));
        return $id > 0 && $name !== '' && $name !== '—' ? $name : '';
    }

    private function channel(array $it, string $sfx): string
    {
        if ($this->staff($it, $sfx) === '') {
            return '';
        }
        $status = (int) ($it['notify_status' . $sfx] ?? 0);
        return $status > 0 ? (self::CHANNELS[$status] ?? 'канал ' . $status) : 'Не уведомлен';
    }

    private function notifyTs(array $it, string $sfx): int
    {
        if ($this->staff($it, $sfx) === '') {
            return 0;
        }
        return (int) ($it['notify_date' . $sfx] ?? 0);
    }

    /** Автор и дата в ячейке; дата 0 не выводится — иначе 01.01.1970. */
    private function commentsCell(array $notes): string
    {
        $parts = [];
        foreach ($notes as $n) {
            if (!is_array($n)) {
                continue;
            }
            $ts = (int) ($n['ts'] ?? 0);
            $author = trim((string) ($n['author'] ?? ''));
            $who = $author !== '' ? $author : '—';
            $head = $ts > 0 ? $this->fmtDate($ts) . ' · ' . $who : $who;
            $parts[] = $head . "\n" . (string) ($n['body'] ?? '');
        }
        return implode("\n\n", $parts);
    }

    private function fmtDate(int $ts): string
    {
        return (new \DateTimeImmutable('@' . $ts))
            ->setTimezone(new \DateTimeZone(self::TZ))
            ->format('d.m.Y H:i');
    }

    private function serial(int $ts): string
    {
        $offset = (new \DateTimeImmutable('@' . $ts))
            ->setTimezone(new \DateTimeZone(self::TZ))
            ->getOffset();
        return sprintf('%.10F', ($ts + $offset) / 86400 + self::EXCEL_EPOCH);
    }

    private function colLetter(int $i): string
    {
        $s = '';
        $i++;
        while ($i > 0) {
            $s = chr(65 + (($i - 1) % 26)) . $s;
            $i = intdiv($i - 1, 26);
        }
        return $s;
    }

    private function esc(string $s): string
    {
        // Управляющие символы вне диапазона XML 1.0 ломают файл целиком.
        $s = preg_replace('/[\x00-\x08\x0B\x0C\x0E-\x1F]/', '', $s) ?? '';
        return htmlspecialchars($s, ENT_QUOTES | ENT_XML1 | ENT_SUBSTITUTE, 'UTF-8');
    }

    private function headerRow(): string
    {
        $cells = '';
        foreach (self::COLUMNS as $i => $col) {
            $ref = $this->colLetter($i) . '1';
            $cells .= '<c r="' . $ref . '" s="' . self::S_HEADER . '" t="inlineStr"><is><t>'
                . $this->esc((string) $col[0]) . '</t></is></c>';
        }
        return '<row r="1">' . $cells . '</row>';
    }

    private function dataRow(int $n, array $values): string
    {
        $cells = '';
        foreach (self::COLUMNS as $i => $col) {
            $ref = $this->colLetter($i) . $n;
            $style = (int) $col[2];
            $v = $values[$i] ?? null;

            if ($style === self::S_DATE) {
                $ts = (int) $v;
                $cells .= $ts > 0
                    ? '<c r="' . $ref . '" s="' . $style . '"><v>' . $this->serial($ts) . '</v></c>'
                    : '<c r="' . $ref . '" s="' . $style . '"/>';
                continue;
            }
            if ($style === self::S_NUM) {
                $cells .= $v === null || $v === ''
                    ? '<c r="' . $ref . '" s="' . $style . '"/>'
                    : '<c r="' . $ref . '" s="' . $style . '"><v>' . (int) $v . '</v></c>';
                continue;
            }
            $s = (string) ($v ?? '');
            $cells .= $s === ''
                ? '<c r="' . $ref . '" s="' . $style . '"/>'
                : '<c r="' . $ref . '" s="' . $style . '" t="inlineStr"><is><t xml:space="preserve">'
                    . $this->esc($s) . '</t></is></c>';
        }
        return '<row r="' . $n . '">' . $cells . '</row>';
    }

    private function sheet(array $rows, string $last): string
    {
        $cols = '';
        foreach (self::COLUMNS as $i => $col) {
            $n = $i + 1;
            $cols .= '<col min="' . $n . '" max="' . $n . '" width="' . (int) $col[1] . '" customWidth="1"/>';
        }
        return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            . '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
            . '<dimension ref="A1:' . $last . '"/>'
            . '<sheetViews><sheetView workbookViewId="0">'
            . '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>'
            . '<selection pane="bottomLeft" activeCell="A2" sqref="A2"/>'
            . '</sheetView></sheetViews>'
            . '<sheetFormatPr defaultRowHeight="15"/>'
            . '<cols>' . $cols . '</cols>'
            . '<sheetData>' . implode('', $rows) . '</sheetData>'
            . '<autoFilter ref="A1:' . $last . '"/>'
            . '</worksheet>';
    }

    private function styles(): string
    {
        $b = '<left style="thin"><color rgb="FFBFBFBF"/></left>'
            . '<right style="thin"><color rgb="FFBFBFBF"/></right>'
            . '<top style="thin"><color rgb="FFBFBFBF"/></top>'
            . '<bottom style="thin"><color rgb="FFBFBFBF"/></bottom><diagonal/>';
        $wrap = '<alignment vertical="top" wrapText="1"/>';
        $top = '<alignment vertical="top"/>';

        return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            . '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
            . '<numFmts count="1"><numFmt numFmtId="' . self::DATE_FMT_ID . '" formatCode="dd.mm.yyyy hh:mm"/></numFmts>'
            . '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font>'
            . '<font><b/><sz val="11"/><name val="Calibri"/></font></fonts>'
            . '<fills count="3"><fill><patternFill patternType="none"/></fill>'
            . '<fill><patternFill patternType="gray125"/></fill>'
            . '<fill><patternFill patternType="solid"><fgColor rgb="FFEFEFEF"/><bgColor indexed="64"/></patternFill></fill></fills>'
            . '<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border>'
            . '<border>' . $b . '</border></borders>'
            . '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
            . '<cellXfs count="6">'
            . '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
            . '<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1">'
            . '<alignment horizontal="left" vertical="top" wrapText="1"/></xf>'
            . '<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1">' . $wrap . '</xf>'
            . '<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1">' . $top . '</xf>'
            . '<xf numFmtId="' . self::DATE_FMT_ID . '" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1">' . $top . '</xf>'
            . '<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1">' . $top . '</xf>'
            . '</cellXfs>'
            . '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>'
            . '</styleSheet>';
    }

    private function contentTypes(): string
    {
        $ns = 'http://schemas.openxmlformats.org/package/2006/content-types';
        $base = 'application/vnd.openxmlformats-officedocument.spreadsheetml';
        return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            . '<Types xmlns="' . $ns . '">'
            . '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
            . '<Default Extension="xml" ContentType="application/xml"/>'
            . '<Override PartName="/xl/workbook.xml" ContentType="' . $base . '.sheet.main+xml"/>'
            . '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="' . $base . '.worksheet+xml"/>'
            . '<Override PartName="/xl/styles.xml" ContentType="' . $base . '.styles+xml"/>'
            . '</Types>';
    }

    private function rootRels(): string
    {
        return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            . '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            . '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
            . '</Relationships>';
    }

    private function workbook(): string
    {
        return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            . '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"'
            . ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
            . '<sheets><sheet name="Отчёт" sheetId="1" r:id="rId1"/></sheets></workbook>';
    }

    private function workbookRels(): string
    {
        $t = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/';
        return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            . '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            . '<Relationship Id="rId1" Type="' . $t . 'worksheet" Target="worksheets/sheet1.xml"/>'
            . '<Relationship Id="rId2" Type="' . $t . 'styles" Target="styles.xml"/>'
            . '</Relationships>';
    }
}