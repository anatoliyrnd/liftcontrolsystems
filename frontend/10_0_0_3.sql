-- phpMyAdmin SQL Dump
-- version 4.9.7
-- https://www.phpmyadmin.net/
--
-- Хост: 10.0.0.3:3306
-- Время создания: Окт 21 2026 г., 22:42
-- Версия сервера: 10.11.18-MariaDB-cll-lve-log
-- Версия PHP: 7.4.11

SET SQL_MODE = "NO_AUTO_VALUE_ON_ZERO";
SET AUTOCOMMIT = 0;
START TRANSACTION;
SET time_zone = "+00:00";


/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;
/*!40101 SET @OLD_CHARACTER_SET_RESULTS=@@CHARACTER_SET_RESULTS */;
/*!40101 SET @OLD_COLLATION_CONNECTION=@@COLLATION_CONNECTION */;
/*!40101 SET NAMES utf8mb4 */;

--
-- База данных: `zamotaev_bdom`
--
CREATE DATABASE IF NOT EXISTS `zamotaev_bdom` DEFAULT CHARACTER SET utf8mb3 COLLATE utf8mb3_general_ci;
USE `zamotaev_bdom`;

-- --------------------------------------------------------

--
-- Структура таблицы `lift_calls`
--

CREATE TABLE `lift_calls` (
  `call_id` int(11) NOT NULL,
  `call_first_name` varchar(100) NOT NULL DEFAULT '',
  `call_last_name` varchar(100) NOT NULL DEFAULT '',
  `call_phone` varchar(100) NOT NULL DEFAULT '',
  `call_email` varchar(200) NOT NULL DEFAULT '',
  `call_department` int(11) NOT NULL DEFAULT 0,
  `call_request` int(11) NOT NULL DEFAULT 0,
  `call_group` int(11) NOT NULL DEFAULT 0,
  `call_adres` varchar(100) NOT NULL DEFAULT '',
  `address_city` int(3) NOT NULL DEFAULT 0,
  `address_street` int(11) NOT NULL DEFAULT 0,
  `address_home` int(11) NOT NULL DEFAULT 0,
  `address_lift` int(11) NOT NULL DEFAULT 0,
  `call_details` text NOT NULL,
  `call_date` int(11) NOT NULL DEFAULT 0,
  `call_date2` int(11) NOT NULL DEFAULT 0,
  `call_status` int(11) NOT NULL DEFAULT 0,
  `call_solution` text NOT NULL,
  `call_user` int(11) NOT NULL DEFAULT 0,
  `call_staff` int(11) NOT NULL DEFAULT 0,
  `call_staff2` int(11) DEFAULT NULL,
  `call_staff3` int(11) DEFAULT NULL,
  `call_staff_status` int(11) DEFAULT NULL,
  `call_staff_status2` tinyint(4) DEFAULT NULL,
  `call_staff_status3` tinyint(4) DEFAULT NULL,
  `call_staff_date` int(11) DEFAULT NULL,
  `call_staff_date2` int(11) DEFAULT NULL,
  `call_staff_date3` int(11) DEFAULT NULL,
  `expected_repair_time` int(11) DEFAULT 0,
  `read_md5` varchar(32) NOT NULL DEFAULT '',
  `call_fullhistory` text NOT NULL DEFAULT '' COMMENT 'хранит всю историю изменений по заявке после ее закрытия',
  `call_full_note_history` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL DEFAULT '{}' COMMENT 'Данные по всем заметкам к заявке'
) ENGINE=InnoDB AVG_ROW_LENGTH=2340 DEFAULT CHARSET=utf8mb3 COLLATE=utf8mb3_unicode_ci;

-- --------------------------------------------------------

--
-- Структура таблицы `lift_city`
--

CREATE TABLE `lift_city` (
  `id` int(11) NOT NULL,
  `city_name` varchar(256) NOT NULL,
  `vis` tinyint(1) NOT NULL DEFAULT 0
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb3 COLLATE=utf8mb3_general_ci;

-- --------------------------------------------------------

--
-- Структура таблицы `lift_history`
--

CREATE TABLE `lift_history` (
  `history_id` int(11) NOT NULL,
  `history_date` int(11) DEFAULT NULL,
  `history_info` text CHARACTER SET utf8mb3 COLLATE utf8mb3_unicode_ci NOT NULL,
  `call_id` int(11) NOT NULL DEFAULT 0
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------

--
-- Структура таблицы `lift_home`
--

CREATE TABLE `lift_home` (
  `id` int(11) NOT NULL,
  `home_name` varchar(64) DEFAULT NULL,
  `street_id` int(11) NOT NULL DEFAULT 0,
  `timestamp` timestamp NOT NULL DEFAULT current_timestamp(),
  `vis` tinyint(1) NOT NULL DEFAULT 0
) ENGINE=InnoDB AVG_ROW_LENGTH=16384 DEFAULT CHARSET=utf8mb3 COLLATE=utf8mb3_general_ci;

-- --------------------------------------------------------

--
-- Структура таблицы `lift_notes`
--

CREATE TABLE `lift_notes` (
  `note_id` int(11) NOT NULL,
  `note_title` varchar(200) NOT NULL DEFAULT '',
  `note_body` text NOT NULL,
  `note_relation` int(11) NOT NULL DEFAULT 0,
  `note_type` int(1) NOT NULL DEFAULT 0,
  `note_post_date` int(11) NOT NULL DEFAULT 0,
  `note_post_ip` varchar(20) NOT NULL DEFAULT '',
  `note_post_user` int(11) NOT NULL DEFAULT 0,
  `img_name` tinytext NOT NULL DEFAULT '\'\'' COMMENT 'Имя файла изображения в завметке'
) ENGINE=InnoDB AVG_ROW_LENGTH=16384 DEFAULT CHARSET=utf8mb3 COLLATE=utf8mb3_general_ci;

-- --------------------------------------------------------

--
-- Структура таблицы `lift_object`
--

CREATE TABLE `lift_object` (
  `id` int(11) NOT NULL,
  `object_name` varchar(255) NOT NULL,
  `home_id` int(11) NOT NULL,
  `timestamp` timestamp NOT NULL DEFAULT current_timestamp(),
  `vis` tinyint(1) NOT NULL DEFAULT 0,
  `abbreviated_name` mediumint(6) NOT NULL DEFAULT 0 COMMENT 'Сокращенное наименование лифта в SPult'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb3 COLLATE=utf8mb3_general_ci;

-- --------------------------------------------------------

--
-- Структура таблицы `lift_options`
--

CREATE TABLE `lift_options` (
  `id` int(11) NOT NULL,
  `option_name` varchar(255) NOT NULL DEFAULT '',
  `option_value` varchar(500) NOT NULL DEFAULT '',
  `timestamp` timestamp NOT NULL DEFAULT current_timestamp(),
  `name` varchar(50) NOT NULL DEFAULT '''''',
  `comment` text NOT NULL DEFAULT ' ' COMMENT 'Подробно о параметре',
  `change_allowed` tinyint(1) NOT NULL DEFAULT 0 COMMENT 'Разрешено редактирование',
  `type` varchar(50) NOT NULL DEFAULT 'text' COMMENT 'тип значения'
) ENGINE=InnoDB AVG_ROW_LENGTH=16384 DEFAULT CHARSET=utf8mb3 COLLATE=utf8mb3_general_ci;

-- --------------------------------------------------------

--
-- Структура таблицы `lift_street`
--

CREATE TABLE `lift_street` (
  `id` int(11) NOT NULL,
  `street_name` varchar(255) NOT NULL DEFAULT '',
  `city_id` int(11) NOT NULL,
  `timestamp` timestamp NOT NULL DEFAULT current_timestamp(),
  `vis` tinyint(1) NOT NULL DEFAULT 0
) ENGINE=InnoDB AVG_ROW_LENGTH=16384 DEFAULT CHARSET=utf8mb3 COLLATE=utf8mb3_general_ci;

-- --------------------------------------------------------

--
-- Структура таблицы `lift_telegram`
--

CREATE TABLE `lift_telegram` (
  `id` int(10) UNSIGNED NOT NULL,
  `user_id` int(10) UNSIGNED NOT NULL COMMENT 'id пользователя',
  `call_id` int(10) UNSIGNED NOT NULL COMMENT 'id заявки',
  `time` int(10) UNSIGNED NOT NULL COMMENT 'unix time stamp',
  `action` varchar(50) NOT NULL COMMENT 'действие на ответное сообщение'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------

--
-- Структура таблицы `lift_types`
--

CREATE TABLE `lift_types` (
  `type_id` int(11) NOT NULL,
  `type` int(1) NOT NULL DEFAULT 0,
  `type_name` varchar(200) DEFAULT NULL,
  `type_report` tinyint(1) NOT NULL DEFAULT 0,
  `type_email` varchar(200) DEFAULT NULL,
  `type_location` text DEFAULT NULL,
  `type_phone` varchar(100) DEFAULT NULL
) ENGINE=InnoDB AVG_ROW_LENGTH=1170 DEFAULT CHARSET=utf8mb3 COLLATE=utf8mb3_general_ci;

-- --------------------------------------------------------

--
-- Структура таблицы `lift_upload`
--

CREATE TABLE `lift_upload` (
  `id` int(11) NOT NULL,
  `call_id` int(11) NOT NULL,
  `file_name` varchar(255) NOT NULL DEFAULT '',
  `file_ext` varchar(4) NOT NULL DEFAULT '',
  `timestamp` timestamp NOT NULL DEFAULT current_timestamp()
) ENGINE=InnoDB AVG_ROW_LENGTH=16384 DEFAULT CHARSET=utf8mb3 COLLATE=utf8mb3_general_ci;

-- --------------------------------------------------------

--
-- Структура таблицы `lift_users`
--

CREATE TABLE `lift_users` (
  `user_id` int(11) NOT NULL,
  `user_login` varchar(30) NOT NULL DEFAULT '',
  `user_password` varchar(225) NOT NULL DEFAULT '',
  `user_name` varchar(200) NOT NULL DEFAULT '',
  `user_telegram` bigint(20) NOT NULL DEFAULT 0,
  `user_address` varchar(200) NOT NULL DEFAULT '',
  `user_city` varchar(100) NOT NULL DEFAULT '',
  `user_state` char(3) NOT NULL DEFAULT '',
  `user_zip` varchar(20) NOT NULL DEFAULT '',
  `user_country` char(3) NOT NULL DEFAULT '',
  `user_phone` varchar(39) NOT NULL DEFAULT '',
  `user_email` varchar(200) NOT NULL DEFAULT '',
  `user_email2` varchar(200) NOT NULL DEFAULT '',
  `user_company` varchar(100) NOT NULL DEFAULT '',
  `user_new_read` int(1) UNSIGNED NOT NULL DEFAULT 0,
  `user_im_icq` varchar(100) NOT NULL DEFAULT '',
  `user_im_msn` varchar(100) NOT NULL DEFAULT '',
  `user_im_yahoo` varchar(100) NOT NULL DEFAULT '',
  `user_im_other` varchar(200) NOT NULL DEFAULT '',
  `user_status` int(1) NOT NULL DEFAULT 0,
  `user_level` int(1) NOT NULL DEFAULT 2,
  `user_pending` int(11) NOT NULL DEFAULT 0,
  `user_date` int(11) NOT NULL DEFAULT 0,
  `last_login` int(11) NOT NULL DEFAULT 0,
  `last_ip` varchar(20) NOT NULL DEFAULT '',
  `user_msg_send` int(1) NOT NULL DEFAULT 0,
  `user_msg_subject` varchar(200) NOT NULL DEFAULT '',
  `user_protect_delete` int(1) DEFAULT 0,
  `user_protect_edit` int(11) NOT NULL DEFAULT 0,
  `user_hiden` tinyint(1) DEFAULT 0,
  `user_localadmin` tinyint(1) DEFAULT 0,
  `user_edit_obj` tinyint(1) NOT NULL DEFAULT 0 COMMENT 'разрешение редактирования объектов',
  `user_edit_user` tinyint(1) NOT NULL DEFAULT 0,
  `user_disppermission` tinyint(1) NOT NULL DEFAULT 0,
  `user_add_call` tinyint(1) NOT NULL DEFAULT 0,
  `user_read_all_calls` tinyint(1) NOT NULL DEFAULT 0,
  `user_block` tinyint(1) NOT NULL DEFAULT 0 COMMENT 'Пользователь Заблокирован ',
  `user_token` varchar(32) NOT NULL DEFAULT '' COMMENT 'токен автоматического входа в акаунт',
  `webgl_info` tinytext DEFAULT ' ' COMMENT 'Информация о графической подсистемы пользователя для идентификации с токеном',
  `force_reload` tinyint(1) NOT NULL DEFAULT 0 COMMENT 'Необходимость принудительного обновления страницы. ',
  `data_reload` tinyint(255) NOT NULL DEFAULT 0 COMMENT 'Флаг изменения конфигурационных данных 1-конфигурационные данные 2- База адресов'
) ENGINE=InnoDB AVG_ROW_LENGTH=2340 DEFAULT CHARSET=utf8mb3 COLLATE=utf8mb3_general_ci;

-- --------------------------------------------------------

--
-- Структура таблицы `users_description_row`
--

CREATE TABLE `users_description_row` (
  `id` int(11) NOT NULL,
  `name_row` varchar(60) NOT NULL COMMENT 'name row from lift_users',
  `type` varchar(20) NOT NULL COMMENT 'тип значения',
  `text` varchar(100) NOT NULL DEFAULT ' ' COMMENT 'отображаемое название поля',
  `description` varchar(1000) NOT NULL DEFAULT ' ' COMMENT 'описание поля',
  `classification` tinyint(1) NOT NULL DEFAULT 3 COMMENT 'Классификация поля :1- авторизация, \r\n2-Основные данные \r\n3- доп. информация',
  `editable` tinyint(1) NOT NULL DEFAULT 1 COMMENT 'возможность редактировать поле',
  `display_order` tinyint(20) NOT NULL COMMENT 'Порядок отображения'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='описание полей';

--
-- Индексы сохранённых таблиц
--

--
-- Индексы таблицы `lift_calls`
--
ALTER TABLE `lift_calls`
  ADD PRIMARY KEY (`call_id`),
  ADD KEY `call_department` (`call_department`),
  ADD KEY `call_request` (`call_request`),
  ADD KEY `call_staff` (`call_staff`),
  ADD KEY `call_status` (`call_status`),
  ADD KEY `call_user` (`call_user`),
  ADD KEY `call_group` (`call_group`) USING BTREE;

--
-- Индексы таблицы `lift_city`
--
ALTER TABLE `lift_city`
  ADD PRIMARY KEY (`id`) USING BTREE;

--
-- Индексы таблицы `lift_history`
--
ALTER TABLE `lift_history`
  ADD PRIMARY KEY (`history_id`) KEY_BLOCK_SIZE=11 USING BTREE,
  ADD KEY `call_id` (`call_id`);
ALTER TABLE `lift_history` ADD FULLTEXT KEY `historytxt` (`history_info`);

--
-- Индексы таблицы `lift_home`
--
ALTER TABLE `lift_home`
  ADD PRIMARY KEY (`id`),
  ADD KEY `street_id` (`street_id`);

--
-- Индексы таблицы `lift_notes`
--
ALTER TABLE `lift_notes`
  ADD PRIMARY KEY (`note_id`),
  ADD KEY `note_post_user` (`note_post_user`),
  ADD KEY `note_relation` (`note_relation`),
  ADD KEY `note_type` (`note_type`);

--
-- Индексы таблицы `lift_object`
--
ALTER TABLE `lift_object`
  ADD PRIMARY KEY (`id`);

--
-- Индексы таблицы `lift_options`
--
ALTER TABLE `lift_options`
  ADD PRIMARY KEY (`id`),
  ADD KEY `option_name` (`option_name`);

--
-- Индексы таблицы `lift_street`
--
ALTER TABLE `lift_street`
  ADD PRIMARY KEY (`id`),
  ADD KEY `street_name` (`street_name`);

--
-- Индексы таблицы `lift_telegram`
--
ALTER TABLE `lift_telegram`
  ADD PRIMARY KEY (`id`);

--
-- Индексы таблицы `lift_types`
--
ALTER TABLE `lift_types`
  ADD PRIMARY KEY (`type_id`),
  ADD KEY `type` (`type`);

--
-- Индексы таблицы `lift_upload`
--
ALTER TABLE `lift_upload`
  ADD PRIMARY KEY (`id`),
  ADD KEY `call_id` (`call_id`);

--
-- Индексы таблицы `lift_users`
--
ALTER TABLE `lift_users`
  ADD PRIMARY KEY (`user_id`),
  ADD KEY `user_level` (`user_level`),
  ADD KEY `user_msg_send` (`user_msg_send`),
  ADD KEY `user_pending` (`user_pending`),
  ADD KEY `user_protect_edit` (`user_protect_edit`),
  ADD KEY `user_status` (`user_status`);

--
-- Индексы таблицы `users_description_row`
--
ALTER TABLE `users_description_row`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `name_row` (`name_row`),
  ADD UNIQUE KEY `display_order` (`display_order`),
  ADD KEY `name_row_2` (`name_row`);

--
-- AUTO_INCREMENT для сохранённых таблиц
--

--
-- AUTO_INCREMENT для таблицы `lift_calls`
--
ALTER TABLE `lift_calls`
  MODIFY `call_id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT для таблицы `lift_city`
--
ALTER TABLE `lift_city`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT для таблицы `lift_history`
--
ALTER TABLE `lift_history`
  MODIFY `history_id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT для таблицы `lift_home`
--
ALTER TABLE `lift_home`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT для таблицы `lift_notes`
--
ALTER TABLE `lift_notes`
  MODIFY `note_id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT для таблицы `lift_object`
--
ALTER TABLE `lift_object`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT для таблицы `lift_options`
--
ALTER TABLE `lift_options`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT для таблицы `lift_street`
--
ALTER TABLE `lift_street`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT для таблицы `lift_telegram`
--
ALTER TABLE `lift_telegram`
  MODIFY `id` int(10) UNSIGNED NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT для таблицы `lift_types`
--
ALTER TABLE `lift_types`
  MODIFY `type_id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT для таблицы `lift_upload`
--
ALTER TABLE `lift_upload`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT для таблицы `lift_users`
--
ALTER TABLE `lift_users`
  MODIFY `user_id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT для таблицы `users_description_row`
--
ALTER TABLE `users_description_row`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT;
COMMIT;

/*!40101 SET CHARACTER_SET_CLIENT=@OLD_CHARACTER_SET_CLIENT */;
/*!40101 SET CHARACTER_SET_RESULTS=@OLD_CHARACTER_SET_RESULTS */;
/*!40101 SET COLLATION_CONNECTION=@OLD_COLLATION_CONNECTION */;
