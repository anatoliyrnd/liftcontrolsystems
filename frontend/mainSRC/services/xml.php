<?php
include("include/autoload.php");
$main=new mainSRC\main();
const PATH='XML';
const FILE='SPult';
const CHECK_ORGANIZATION=true; 
const debug_xml = false; // если нужна отладочная информация то ставим в true
$DATE_REPAIR=3;//срок ремонта из массива
if (strcasecmp($_SERVER['REQUEST_METHOD'], 'POST') != 0) {
    //If it isn't, send back a 405 Method Not Allowed header.
  //  header($_SERVER["SERVER_PROTOCOL"] . " 405 Method Not Allowed", true, 405);
  //  exit;
}
//include("./include/ldisp_config.php");
//include("./include/function.php");
//include("./include/static_data.php");
//require_once("./include/PDO.class.php");
//Get the raw POST data from PHP's input stream.
//This raw data should contain XML.
$parameters=[];
$XML_parameters=$main->DB->query("SELECT option_name,option_value FROM lift_options WHERE option_name='city_default' OR option_name='city_separator' OR option_name='spult_organization_name' OR option_name='XML_add'") ;
foreach ($XML_parameters as $XML_parameter) {
    $parameters[$XML_parameter['option_name']]=$XML_parameter['option_value'];
}
$postData = trim(file_get_contents('php://input'));
// внутренние ошибки для лучшей обработки ошибок.
libxml_use_internal_errors(true);
// данные POST в формате XML.
$xml = simplexml_load_string($postData);
//Если XML не удалось проанализировать должным образом.
if ($xml === false) {
    // 400 Bad Request error.
    $log='';
    header($_SERVER["SERVER_PROTOCOL"] . " 400 Bad Request", true, 400);
    // подробную информацию об ошибке и завершим работу скрипта.
    foreach (libxml_get_errors() as $xmlError) {
        $log .= $xmlError->message . "\n";
    }
    $log = " Ошибка XML" . $log;
    $main->logsave($log.$postData, FILE,PATH);
    exit;
}
$reader = new XMLReader();

$doc = new DOMDocument;
//
if (!$reader->xml($postData)) {
    $main->logsave("Failed to open xml", FILE,PATH);
    exit();
}
// reading xml data...
while ($reader->read()) {
    if ($reader->nodeType == XMLReader::ELEMENT && $reader->name == 'PULT') {

        $node = simplexml_import_dom($doc->importNode($reader->expand(), true));

        $disp = $reader->getAttribute('Name');
        if ($disp != $parameters['spult_organization_name'] && CHECK_ORGANIZATION) { // укажите имя организации
               die("Failed");
        }

    }
    if ($reader->nodeType == XMLReader::ELEMENT && $reader->name == 'STREET') {
        $node = simplexml_import_dom($doc->importNode($reader->expand(), true));
        $street = $reader->getAttribute('Name');
    }
    if ($reader->nodeType == XMLReader::ELEMENT && $reader->name == 'HOME') {
        $node = simplexml_import_dom($doc->importNode($reader->expand(), true));
        $home = $reader->getAttribute('Name');
    }
    if ($reader->nodeType == XMLReader::ELEMENT && $reader->name == 'LIFT') {
        $node = simplexml_import_dom($doc->importNode($reader->expand(), true));
        $lift      = $reader->getAttribute('Name');
        $note      = $reader->getAttribute('Note');
        $user      = $reader->getAttribute('User');
        $lkds_name = $reader->getAttribute('ID');

    }
    if ($reader->nodeType == XMLReader::ELEMENT && $reader->name == 'Status') {
        $node = simplexml_import_dom($doc->importNode($reader->expand(), true));
        $discription = $discription . " " . $reader->getAttribute('Name');
    }
}
$reader->close();
//file_put_contents($file, $address);

$actionstatus = "";
$city         = $parameters['city_default'];
$lift_id = 0;
//проверим есть ли в стрке улицы разделитель названия города если есть определим его позицию
$position = strpos($street, $parameters['city_separator']);
if ($position) {
    $city   = substr($street, $position + 1);
    $street = substr($street, 0, $position);
}
$address = $city . " - " . $street . ", " . $home . " -  " . $lift;
$city_name = str_replace([' ', '.'], '', $city);
file_put_contents("xml.txt", "<" . $city . ">" . $city_name);
$qcheck  = "SELECT `id` FROM `lift_city` WHERE (REPLACE(REPLACE(`city_name`, ' ', ''),'.','') =?  ) LIMIT 1 ";
if (debug_xml) {
    $main->debug("Запрос наличия города - ".$qcheck,FILE,PATH);
}
$city_id = $main->DB->single($qcheck,Array($city_name)); //проверим есть ли в базе город
if ($city_id) {
    $city_log = $city . " уже есть в базе данных  (".$city_id.").";
} else {
    $city_log = $city . " не найден ";
    $city_id  = 0;
    if ($parameters['XML_add']) {
        $q = "INSERT INTO lift_city (`city_name` ) VALUES (?)";
        $main->DB->query($q,Array($city));
        $city_log = $city . " успешно добавлен ";
        $city_id  = $main->DB->single($qcheck);
    }
}
//проверим есть ли в базе данный обект, дом и улица если нет то добавим, если есть получим их id
$street_name = str_replace([' ', '.'], '', $street);
$qcheck = "SELECT `id` FROM `lift_street` WHERE (REPLACE(REPLACE(`street_name`, ' ', ''),'.','') =? AND `city_id`='$city_id') LIMIT 1";
//
if (debug_xml) {
    $main->debug("Запрос наличия улицы - ".$qcheck ,FILE,PATH);
}
$street_id = $main->DB->single($qcheck,Array($street_name));
if ($street_id) {
    $street_log = $street . " уже есть в базе данных (".$street_id.").";
} else {
    $street_log = $street . " не найдена в базе для (".$city_id.").";
    $street_id  = 0;
    if ($parameters['XML_add']) {
        $q = ("INSERT INTO lift_street (`street_name`, `timestamp`,`city_id`) VALUES (?, CURRENT_TIMESTAMP,$city_id)");
        if (debug_xml) {
         $main->debug("Вставка  улицы - ".$q ,FILE,PATH);
        }
        $main->DB->query($q,Array($street));
        $street_log = $street . " успешно добавлена ";
        $street_id  = $main->DB->single($qcheck,Array($street_name));
    }
}
//home
$home      = str_replace('д.', '', $home);
$home_name = str_replace([' ', '.'], '', $home); //уберем   пробел из поискового запроса что бы они не влияли на результат
$qcheck    = "SELECT `id` FROM `lift_home` WHERE (REPLACE(REPLACE(`home_name`, ' ', ''),'.','') =? AND `street_id`='$street_id') "; // проерим есть данный дом в базу с привязкой к улице
if (debug_xml) {
    $main->debug ("Запрос наличия home - ".$qcheck,FILE,PATH);
}
$home_id = $main->DB->single($qcheck,Array($home_name));
if ($home_id) {
    $home_log = $home . " уже есть в базе данных  ";
} else {
    $home_id  = 0;
    $home_log = $home . " не найден в базе ";
    if ($parameters['XML_add']) {
        $q = "INSERT INTO lift_home (`home_name`, `timestamp`,`street_id`) VALUES (?, CURRENT_TIMESTAMP,'$street_id') ";
        $main->DB->query($q,Array($home));
        $home_log = $home . " успешно добавлен ";
        $home_id  = $main->DB->single($qcheck,Array($home_name));
    }
}
//;ift
$lift_name = str_replace([' ', '.'], '', $lift); //уберем   пробел из поискового запроса что бы они не влияли на результат
$qcheck    = "SELECT `id` FROM `lift_object` WHERE (REPLACE(REPLACE(`object_name`, ' ', ''),'.','') =? AND `home_id`='$home_id')  "; // проерим есть данный lift в базу с привязкой к home
if (debug_xml) {
    $main->debug ("Запрос наличия lift - ".$qcheck,FILE,PATH);
}
$lift_id = $main->DB->single($qcheck,Array($lift_name));
$main->debug ("lift - ".$lift_id,FILE,PATH);
if ($lift_id) {
    $lift_log = $lift . " уже есть в базе данных  ($lkds_name)";
} else {
    $lift_id  = 0;
    $lift_log = $lift . " не найден в базе ($lkds_name)";
    if ($parameters['XML_add']) {
        $q = ("INSERT INTO lift_object (`object_name`, `timestamp`,`home_id`,`abbreviated_name`) VALUES (?, CURRENT_TIMESTAMP,'$home_id',?)");
        $main->DB->query($q,Array($lift,$lkds_name));
        $lift_log = "$lift ($lkds_name) успешно добавлен  $q ";
        $lift_id  = $main->DB->single($qcheck,Array($lift_name));
    }
}
//Создаем заявку из spult
// Внимание данная классификация сообщений из спульт для названия разделов по умолчанию. В планах вынести в админку возможность управления  у Вас может быть другое.
// таблица бд type lift  столюец id соответсвие названию
//call_request1- Срочная, 2- Обычная , 3- Не срочная
// call_grup 4 застревание, 5- мелькая неисправность 6 - неисправность лифта, 7- доп работы 8 -длительный ремонт, 9- прочее, 24 неисправность дисп оборудования
//call_department 22 -электромеханки 23 Аварийная
$string1  = "Освобождение пассажира, заблокированного в лифте"; // отдел аварийная 23,уровень срочный, группа -застревание
$string2  = "Устранение неисправностей лифта"; //отдел электромеханики , уровень обычный , группа 3. Неисправность лифта
$string3  = "Устранение нештатных ситуаций на лифте"; // отдел электромеханики , уровень обычный , группа 3. Неисправность лифта
$string4  = "Устранение неисправностей диспетчерского оборудования"; // отдел электромеханики , уровень обычный , группа 6. неисправность дисп оборудования
$string5  = "Отключение лифта для проведения технического обслуживания"; // отдел электромеханики , уровень обычный , группа 4. дополнительные работы
$string6  = "Отключение лифта из-за угрозы причинения вреда жизни, здоровью или имуществу граждан"; // // отдел аварийная , уровень обычный , группа 3. Неисправность лифта
$string9  = "Отключение лифта для проведения внепланового ремонта капитального характера"; // отдел электромеханики, уровень не срочная, группа 5 длительный ремонт
$string13 = "Устранение мелких (незначительных) неисправностей"; // // отдел электромеханики , уровень не срочная , группа 2.мелкие неисправности
//все остальное  электромеханник , не срочная  прочее
$call_department = 22;
$call_group      = 9;
$call_request    = 3;
$call_status     = 0;
if (stripos($note, $string1) !== false) {
    $DATE_REPAIR=1;//установим время ремонта в 30 мин.
    $call_department = 23;
    $call_group      = 4;
    $call_request    = 1;
} elseif (stripos($note, $string2) !== false) {
    $DATE_REPAIR=3;
    $call_department = 22;
    $call_group      = 6;
    $call_request    = 2;
} elseif (stripos($note, $string3) !== false) {
    $DATE_REPAIR=3;
    $call_department = 22;
    $call_group      = 6;
    $call_request    = 2;
} elseif (stripos($note, $string4) !== false) {
    $DATE_REPAIR=3;
    $call_department = 22;
    $call_group      = 24;
    $call_request    = 2;
} elseif (stripos($note, $string5) !== false) {
    $DATE_REPAIR=2;
    $call_department = 22;
    $call_group      = 7;
    $call_request    = 2;
} elseif (stripos($note, $string6) !== false) {
    $DATE_REPAIR=3;
    $call_department = 23;
    $call_group      = 6;
    $call_request    = 2;
} elseif (stripos($note, $string9) !== false) {
    $DATE_REPAIR=5;
    $call_department = 22;
    $call_group      = 8;
    $call_request    = 3;
} elseif (stripos($note, $string13) !== false) {
    $DATE_REPAIR=5;
    $call_department = 22;
    $call_group      = 5;
    $call_request    = 3;
}
//0 активная заявка
$call_date       = strtotime(date('Y-m-d H:i:s '));
$call_first_name = 'SPult ' . $user;
$call_email      = 'Adres@company.name';
$call_phone      = 'Phone ';
$call_solution = 0;
$call_staff    = 0;
$call_adres    = $address;
$query_add_call             = "INSERT INTO lift_calls(call_status,call_date,call_first_name,call_email,call_phone,call_department,call_request,call_group,call_adres,call_details,call_solution,call_staff,	address_city,address_street,address_home,address_lift,expected_repair_time )VALUES($call_status,$call_date, ? ,'$call_email','$call_phone',$call_department,$call_request,$call_group, ? , ? ,'$call_solution',$call_staff,$city_id,$street_id,$home_id,$lift_id,".$main->repairTimeUnix($DATE_REPAIR).");";
$query_data=Array($call_first_name, $call_adres, $discription);
if (debug_xml) {
    $main->debug("query add call - ".$query_add_call.print_r($query_data,true),FILE,PATH);
}
$main->DB->query($query_add_call,$query_data);
//  /Создаем заявку из spult
//file_put_contents($file, $q);
$history_date = strtotime(date('Y-m-d H:i:s '));
$call_id      = $main->DB->lastInsertId();;
$sethistory = $call_first_name . " Добавил(а) заявку из SPult по адресу:" . $call_adres; //запись в журнал
$main->DB->query("INSERT INTO lift_history (history_date,history_info, call_id) VALUES( $history_date, ?, $call_id );", Array($sethistory));
//$db->query("UPDATE lift_options SET option_value = 'yes' WHERE  `option_name` = 'newdatacall'"); //утсанавливаем флог о
/*внесении новых данных в базу
$reader = new XMLReader();
$reader->xml($postData);
while($reader->read()) {
    $txt2='street=';
if ($reader->nodeType == XMLReader::ELEMENT && $reader->name == 'STREET') {
    $txt2 = $txt2.$reader->getAttribute('name');

        }
}
$reader->close();
var_dump  - структура которая будет представлять собой объект SimpleXMLElement .
*/
//var_dump($xml);
if(debug_xml){
   $main->debug($city_log.$street_log.$home_log.$lift_log,FILE,PATH);
}
header($_SERVER["SERVER_PROTOCOL"] . " 200 ok", true, 200);

?>