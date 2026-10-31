<?php
header('Content-Type: application/json');
http_response_code(405);
echo json_encode(['status' => 'error', 'code' => 'test405']);