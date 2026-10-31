<?php
declare(strict_types=1);
namespace App\Support;

final class MagicLower
{
    public static function format(string $text): string
    {
        $txtL = mb_strlen(preg_replace("/[^а-яёa-z]+/u", "", $text));
        $txtU = mb_strlen(preg_replace("/[^А-ЯЁA-Z]+/u", "", $text));

        if (!$txtL)
            $txtL = 0.01;
        if ($txtU / $txtL < 0.1)
            return $text;

        return preg_replace_callback("/(?<=[A-ZА-ЯЁ])([A-ZА-ЯЁ\s]+)/u", function ($match) {
            return mb_convert_case($match[0], MB_CASE_LOWER, "UTF-8");
        }, $text);
    }
}