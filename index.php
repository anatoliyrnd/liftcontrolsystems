<?php declare(strict_types=1);

echo <<<'HTML'
<!DOCTYPE html>
<html lang="ru">
<head>
    <meta charset="UTF-8">
    <title>Lift Control Systems</title>
    <meta name="robots" content="noindex, nofollow">
    <script>
        (function() {
            var isMobile = window.matchMedia('(max-width: 768px)').matches
                        && ('ontouchstart' in window || navigator.maxTouchPoints > 0);
            window.location.replace(isMobile ? '/mobile/' : '/ui/');
        })();
    </script>
</head>
<body></body>
</html>
HTML;