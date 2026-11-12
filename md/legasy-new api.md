Проверка перед миграцией легаси — критично
Вы правы, и риск больше, чем кажется. В исходном дампе 10_0_0_3.sql у lift_users вообще нет колонки user_role — она появилась позже. На реальной легаси-базе она может быть NULL или пустой у всех.
Тогда старая логика раздавала роли через user_level, а новая — вернёт guest всем, кроме явных user_localadmin / user_disppermission. То есть после выкатки B1.5 диспетчеры и механики могут потерять доступ разом.
Отдельная ловушка: (int)$u['user_level'] === 0 — если user_level окажется NULL, приведение даёт 0, и пользователь становится администратором. В дампе колонка NOT NULL DEFAULT 2, но на легаси-базе стоит проверить.
Диагностический запрос — старая роль против новой
Прогнать на копии продовой базы до выкатки кода:
sql
SELECT
user_id, user_login, user_name,
user_role, user_position, user_level, user_localadmin, user_disppermission,
CASE
WHEN user_role IS NOT NULL AND user_role <> '' AND user_role <> 'guest' THEN user_role
WHEN COALESCE(user_localadmin, 0) <> 0 OR COALESCE(user_level, 0) = 0 THEN 'administrator'
WHEN COALESCE(user_disppermission, 0) <> 0 OR user_level = 3 THEN 'dispatcher'
WHEN user_level = 2 THEN 'engineer'
ELSE 'guest'
END AS role_old,
CASE
WHEN user_role = 'mechanic' THEN 'engineer'
WHEN user_role = 'foreman' THEN 'dispatcher'
WHEN user_role IS NOT NULL AND user_role <> '' AND user_role <> 'guest' THEN user_role
WHEN COALESCE(user_localadmin, 0) <> 0 THEN 'administrator'
WHEN COALESCE(user_disppermission, 0) <> 0 THEN 'dispatcher'
ELSE 'guest'
END AS role_new
FROM lift_users
WHERE user_block <> 1
HAVING role_old <> role_new
ORDER BY user_id;
Пустая выборка — миграция безопасна. Непустая — видим точный список тех, у кого роль изменится, и решаем по каждому.
Предложение по backfill (требует отдельного согласования)
Если выборка непустая, правильнее не оставлять fallback в коде, а один раз проставить user_role из legacy-полей. Порядок важен — каждый следующий UPDATE защищён условием «ещё пусто»:
sql

UPDATE lift_users SET user_role = 'administrator'
WHERE (user_role IS NULL OR user_role = '')
AND (COALESCE(user_localadmin,0) <> 0 OR COALESCE(user_level,0) = 0);

UPDATE lift_users SET user_role = 'dispatcher'
WHERE (user_role IS NULL OR user_role = '')
AND (COALESCE(user_disppermission,0) <> 0 OR user_level = 3);

UPDATE lift_users SET user_role = 'engineer'
WHERE (user_role IS NULL OR user_role = '') AND user_level = 2;
Это изменение данных, поэтому в текущий объём не входит — как и решено по пунктам 1–2 модификаций, уйдёт в admin-плоскость setting. Но выполнить его надо до выкатки B1.5 на прод, иначе получим массовую потерю прав.
Нормализация mechanic → engineer и foreman → dispatcher остаётся на чтении — данные для неё править не нужно.
