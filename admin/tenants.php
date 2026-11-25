<?php
declare(strict_types=1);
define('APP_ENTRY_POINT', true);

require_once __DIR__ . '/../autoload.php';
require_once __DIR__ . '/_reports_levels.php';

session_start();

if (empty($_SESSION['admin_logged_in'])) {
    header('Location: /admin/');
    exit;
}

header('Content-Type: text/html; charset=utf-8');

function esc(null|string|int|float $v): string
{
    return htmlspecialchars((string) $v, ENT_QUOTES, 'UTF-8');
}

$registry = new \App\Registry();
$tenants  = $registry->listAll();

/* ---------------------------------------------------------------
 * Витрина. db_password НЕ попадает наружу ни в каком виде.
 * --------------------------------------------------------------- */
$rows = [];
foreach ($tenants as $t) {
    $rows[] = [
        'id'         => (int) ($t['id'] ?? 0),
        'subdomain'  => (string) ($t['subdomain'] ?? ''),
        'org_name'   => (string) ($t['org_name'] ?? ''),
        'db_host'    => (string) ($t['db_host'] ?? ''),
        'db_port'    => (int) ($t['db_port'] ?? 3306),
        'db_name'    => (string) ($t['db_name'] ?? ''),
        'db_user'    => (string) ($t['db_user'] ?? ''),
        'is_active'  => !empty($t['is_active']) ? 1 : 0,
        'legacy'     => !empty($t['legacy_compat']) ? 1 : 0,
        'created_at' => (string) ($t['created_at'] ?? ''),
        'level'      => \App\Support\ReportsAccess::normalizeLevel($t['reports_level'] ?? null),
        'rev'        => (int) ($t['reports_access_rev'] ?? 1),
    ];
}

$total    = count($rows);
$active   = count(array_filter($rows, static fn(array $r): bool => $r['is_active'] === 1));
$inactive = $total - $active;
$legacy   = count(array_filter($rows, static fn(array $r): bool => $r['legacy'] === 1));

$levels  = admin_reports_levels();
$matrix  = admin_reports_matrix();
$byLevel = array_count_values(array_column($rows, 'level'));

$allFeatures = admin_reports_all_features();
$allGroups   = admin_reports_all_groups();

$topRev = $rows === [] ? 0 : max(array_column($rows, 'rev'));

$jsonFlags = JSON_UNESCAPED_UNICODE | JSON_HEX_TAG | JSON_HEX_AMP | JSON_HEX_APOS | JSON_HEX_QUOT;
?>
<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="dark">
<title>Организации · LIFT·CS Platform</title>
<style>
/* ============================================================
   SHAFT & SIGNAL — консоль платформенного администратора
   ============================================================ */
:root{
  --void:#080b11;      --shaft:#0d1219;     --panel:#121a24;
  --panel-2:#18222e;   --raise:#1e2a38;     --steel:#243040;
  --steel-2:#31415480; --line:#1c2634;

  --ink:#e9eff7;       --ink-dim:#93a6bb;   --ink-mute:#61758c;
  --ink-faint:#3d4d61;

  --electric:#22d3ee;  --blue:#3b82f6;      --signal:#34d399;
  --amber:#fbbf24;     --danger:#fb4d6d;    --violet:#a78bfa;
  --magenta:#ec4899;

  --ok-bg:#34d39918;   --warn-bg:#fbbf2418; --bad-bg:#fb4d6d18;

  --r-s:6px; --r-m:10px; --r-l:16px; --r-xl:22px;
  --head-h:64px; --bar-h:60px;

  --mono:ui-monospace,"SF Mono",SFMono-Regular,"JetBrains Mono","Cascadia Mono",Menlo,Consolas,monospace;
  --sans:system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;

  --ease:cubic-bezier(.22,.61,.36,1);
  --ease-out:cubic-bezier(.16,1,.3,1);

  --shadow-1:0 1px 0 #ffffff08 inset, 0 8px 24px -12px #000c;
  --shadow-2:0 1px 0 #ffffff0a inset, 0 24px 60px -24px #000e;
  --shadow-3:0 32px 90px -20px #000f, 0 0 0 1px #ffffff0a inset;
}

*,*::before,*::after{box-sizing:border-box}
html,body{margin:0;padding:0}
html{-webkit-text-size-adjust:100%}
body{
  background:var(--void); color:var(--ink);
  font-family:var(--sans); font-size:14px; line-height:1.5;
  min-height:100vh; overflow-x:hidden;
  -webkit-font-smoothing:antialiased;
  padding-top:calc(var(--head-h) + var(--bar-h));
}
body.is-locked{overflow:hidden}

/* ---------- скроллбары в палитре артефакта ---------- */
*{scrollbar-width:thin;scrollbar-color:var(--steel) transparent}
::-webkit-scrollbar{width:11px;height:11px}
::-webkit-scrollbar-track{background:var(--shaft);border-left:1px solid var(--line)}
::-webkit-scrollbar-thumb{
  background:linear-gradient(180deg,var(--steel-2),var(--steel));
  border:2px solid var(--shaft); border-radius:99px;
}
::-webkit-scrollbar-thumb:hover{background:linear-gradient(180deg,var(--electric),var(--blue))}
::-webkit-scrollbar-thumb:active{background:var(--electric)}
::-webkit-scrollbar-corner{background:var(--shaft)}

/* ---------- фон: шахта, рельсы, дрейф кабины, зерно ---------- */
.bg{position:fixed;inset:0;z-index:0;pointer-events:none;overflow:hidden}
.bg-base{
  position:absolute;inset:0;
  background:
    radial-gradient(1100px 620px at 12% -8%, #16324a 0%, transparent 62%),
    radial-gradient(900px 560px at 92% 4%, #2a1440 0%, transparent 60%),
    radial-gradient(760px 700px at 60% 108%, #0d2b30 0%, transparent 62%),
    linear-gradient(178deg,var(--shaft),var(--void) 70%);
}
.bg-rails{
  position:absolute;inset:-2px;
  background-image:repeating-linear-gradient(90deg,
    transparent 0 118px,
    #ffffff07 118px 119px,
    transparent 119px 120px);
  mask-image:linear-gradient(180deg,transparent,#000 18%,#000 72%,transparent);
}
.bg-ticks{
  position:absolute;left:0;right:0;top:0;height:100%;
  background-image:repeating-linear-gradient(180deg,
    transparent 0 63px,
    #ffffff05 63px 64px);
  mask-image:radial-gradient(70% 60% at 50% 40%,#000,transparent);
}
.bg-car{
  position:absolute;left:0;right:0;height:280px;
  background:linear-gradient(180deg,transparent,#22d3ee14 38%,#a78bfa12 62%,transparent);
  filter:blur(26px);
  animation:carDrift 26s var(--ease) infinite;
}
.bg-car.b{
  height:190px;animation-duration:38s;animation-delay:-13s;
  background:linear-gradient(180deg,transparent,#ec489910 50%,transparent);
}
@keyframes carDrift{
  0%{transform:translate3d(0,-320px,0);opacity:0}
  12%{opacity:1}
  88%{opacity:1}
  100%{transform:translate3d(0,105vh,0);opacity:0}
}
.bg-grain{
  position:absolute;inset:0;opacity:.16;mix-blend-mode:overlay;
  background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='180' height='180'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.85' numOctaves='3'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='.5'/%3E%3C/svg%3E");
}

/* ---------- шапка ---------- */
.head{
  position:fixed;top:0;left:0;right:0;height:var(--head-h);z-index:60;
  display:flex;align-items:center;gap:18px;padding:0 20px;
  background:linear-gradient(180deg,#0f1620f2,#0c131ce6);
  backdrop-filter:blur(18px) saturate(150%);
  -webkit-backdrop-filter:blur(18px) saturate(150%);
  border-bottom:1px solid var(--line);
  box-shadow:0 1px 0 #ffffff08 inset,0 12px 34px -22px #000;
}
.brand{display:flex;align-items:center;gap:12px;min-width:0}
.mark{
  position:relative;width:34px;height:34px;flex:none;border-radius:9px;
  background:linear-gradient(150deg,#1b2b3d,#0e1620);
  border:1px solid #2c3f55;
  display:grid;place-items:center;
  box-shadow:0 0 0 1px #0006,0 6px 18px -8px #22d3ee66;
}
.mark svg{width:19px;height:19px;display:block}
.mark::after{
  content:"";position:absolute;left:5px;right:5px;height:2px;border-radius:2px;
  background:linear-gradient(90deg,var(--electric),var(--violet));
  box-shadow:0 0 9px var(--electric);
  animation:carMini 4.6s var(--ease) infinite;
}
@keyframes carMini{0%,100%{top:7px}50%{top:24px}}
.brand-txt{display:flex;flex-direction:column;line-height:1.15;min-width:0}
.brand-name{
  font-size:14px;font-weight:800;letter-spacing:.14em;
  background:linear-gradient(92deg,var(--ink),var(--electric) 60%,var(--violet));
  -webkit-background-clip:text;background-clip:text;color:transparent;
}
.brand-sub{font-size:10px;letter-spacing:.22em;color:var(--ink-mute);text-transform:uppercase}

.head-spacer{flex:1 1 auto}
.head-meta{display:flex;align-items:center;gap:10px}
.clock{
  font-family:var(--mono);font-size:12px;color:var(--ink-dim);
  padding:6px 11px;border:1px solid var(--line);border-radius:99px;
  background:#0d151f;letter-spacing:.04em;white-space:nowrap;
}
.clock b{color:var(--electric);font-weight:600}

/* ---------- кнопки ---------- */
.btn{
  --bg:var(--raise); --fg:var(--ink); --bd:var(--steel);
  position:relative;display:inline-flex;align-items:center;justify-content:center;gap:7px;
  padding:8px 14px;border-radius:var(--r-m);
  background:var(--bg);color:var(--fg);border:1px solid var(--bd);
  font:inherit;font-size:12.5px;font-weight:600;letter-spacing:.01em;
  cursor:pointer;text-decoration:none;white-space:nowrap;
  transition:transform .14s var(--ease),filter .18s var(--ease),box-shadow .18s var(--ease),background .18s var(--ease);
  box-shadow:0 1px 0 #ffffff0d inset;
}
.btn:hover{filter:brightness(1.22);transform:translateY(-1px)}
.btn:active{transform:translateY(0) scale(.985)}
.btn:focus-visible{outline:2px solid var(--electric);outline-offset:2px}
.btn[disabled]{opacity:.45;cursor:not-allowed;transform:none!important;filter:none!important}
.btn svg{width:14px;height:14px;flex:none}

.btn-primary{
  --bg:linear-gradient(135deg,#22d3ee,#3b82f6 55%,#a78bfa);
  --fg:#04121c;--bd:#5ee7ff80;
  box-shadow:0 8px 24px -12px #22d3eecc,0 1px 0 #ffffff40 inset;
  font-weight:700;
}
.btn-danger{--bg:linear-gradient(135deg,#fb4d6d,#e11d48);--fg:#fff;--bd:#fb7185a0;
  box-shadow:0 8px 22px -14px #fb4d6dcc,0 1px 0 #ffffff26 inset}
.btn-warn{--bg:linear-gradient(135deg,#fbbf24,#f59e0b);--fg:#241703;--bd:#fcd34da0}
.btn-go{--bg:linear-gradient(135deg,#34d399,#10b981);--fg:#03251a;--bd:#6ee7b7a0}
.btn-cyan{--bg:#0e2a33;--fg:#7ee7f7;--bd:#1d5566}
.btn-violet{--bg:#1e1836;--fg:#c9b6ff;--bd:#3d2f66}
.btn-ghost{--bg:#0f1822;--fg:var(--ink-dim);--bd:var(--line)}
.btn-sm{padding:6px 10px;font-size:11.5px;border-radius:var(--r-s)}
.btn-icon{padding:7px;width:32px;height:32px}

/* ---------- строка инструментов ---------- */
.bar{
  position:fixed;top:var(--head-h);left:0;right:0;z-index:55;
  min-height:var(--bar-h);
  display:flex;align-items:center;gap:10px;padding:10px 20px;flex-wrap:wrap;
  background:linear-gradient(180deg,#0c131cf5,#0a1017e8);
  backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);
  border-bottom:1px solid var(--line);
}
.search{position:relative;flex:1 1 260px;min-width:190px;max-width:400px}
.search svg{position:absolute;left:11px;top:50%;transform:translateY(-50%);width:15px;height:15px;color:var(--ink-mute);pointer-events:none}
.search input{
  width:100%;padding:9px 34px 9px 34px;border-radius:var(--r-m);
  background:#0b131c;border:1px solid var(--steel);color:var(--ink);
  font:inherit;font-size:13px;transition:border-color .18s,box-shadow .18s;
}
.search input::placeholder{color:var(--ink-faint)}
.search input:focus{outline:none;border-color:var(--electric);box-shadow:0 0 0 3px #22d3ee22}
.search kbd{
  position:absolute;right:9px;top:50%;transform:translateY(-50%);
  font-family:var(--mono);font-size:10px;color:var(--ink-mute);
  border:1px solid var(--line);border-radius:4px;padding:1px 5px;background:#0e1620;
}
.search input:focus + kbd{opacity:0}

.chips{display:flex;gap:6px;flex-wrap:wrap}
.chip{
  padding:6px 12px;border-radius:99px;font-size:11.5px;font-weight:600;
  background:#0e1620;border:1px solid var(--line);color:var(--ink-dim);
  cursor:pointer;transition:all .16s var(--ease);white-space:nowrap;
  display:inline-flex;align-items:center;gap:6px;
}
.chip:hover{border-color:var(--steel-2);color:var(--ink);transform:translateY(-1px)}
.chip[aria-pressed="true"]{
  background:linear-gradient(135deg,#12303c,#1a2340);
  border-color:#2f6b80;color:#9fe9f8;box-shadow:0 0 0 1px #22d3ee33,0 6px 16px -10px #22d3ee88;
}
.chip .dot{width:7px;height:7px;border-radius:50%;background:currentColor;flex:none}
.chip .n{font-family:var(--mono);font-size:10px;opacity:.72}
.chip[data-f="active"] .dot{background:var(--signal)}
.chip[data-f="inactive"] .dot{background:var(--danger)}
.chip[data-f="legacy"] .dot{background:var(--amber)}
.chip[data-lv="light"] .dot{background:var(--electric)}
.chip[data-lv="standard"] .dot{background:var(--blue)}
.chip[data-lv="extended"] .dot{background:var(--magenta)}

.sel{
  padding:8px 30px 8px 11px;border-radius:var(--r-m);
  background:#0b131c url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%2393a6bb' stroke-width='2.4' stroke-linecap='round'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E") no-repeat right 9px center/13px;
  border:1px solid var(--steel);color:var(--ink);font:inherit;font-size:12.5px;
  cursor:pointer;appearance:none;-webkit-appearance:none;
}
.sel:focus{outline:none;border-color:var(--electric);box-shadow:0 0 0 3px #22d3ee22}
.bar-count{font-family:var(--mono);font-size:11.5px;color:var(--ink-mute);white-space:nowrap}
.bar-count b{color:var(--electric);font-weight:600}

/* ---------- каркас ---------- */
.wrap{position:relative;z-index:1;max-width:1560px;margin:0 auto;padding:22px 20px 90px}

/* ---------- метрики ---------- */
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(196px,1fr));gap:12px;margin-bottom:18px}
.stat{
  position:relative;overflow:hidden;
  background:linear-gradient(160deg,var(--panel-2),var(--panel));
  border:1px solid var(--line);border-radius:var(--r-l);
  padding:15px 16px 14px;box-shadow:var(--shadow-1);
}
.stat::before{content:"";position:absolute;left:0;top:0;bottom:0;width:3px;background:var(--c,var(--electric))}
.stat::after{
  content:"";position:absolute;right:-34px;top:-34px;width:110px;height:110px;border-radius:50%;
  background:radial-gradient(circle,var(--c,var(--electric)),transparent 68%);opacity:.13;
}
.stat-k{font-size:10px;letter-spacing:.18em;text-transform:uppercase;color:var(--ink-mute);margin-bottom:7px}
.stat-v{font-family:var(--mono);font-size:29px;font-weight:700;line-height:1;color:var(--ink);letter-spacing:-.02em}
.stat-v small{font-size:13px;color:var(--ink-mute);font-weight:500;margin-left:5px}
.stat-f{margin-top:9px;font-size:11px;color:var(--ink-dim);display:flex;align-items:center;gap:6px}
.spark{display:flex;gap:3px;height:20px;align-items:flex-end;margin-top:10px}
.spark i{flex:1;border-radius:2px 2px 0 0;background:var(--c,var(--electric));opacity:.5;min-height:3px;transition:height .5s var(--ease-out)}

.dist{display:flex;height:8px;border-radius:99px;overflow:hidden;background:#0b131c;margin-top:11px;border:1px solid var(--line)}
.dist i{height:100%;transition:width .6s var(--ease-out)}
.dist-lg{display:flex;gap:12px;flex-wrap:wrap;margin-top:9px;font-size:10.5px;color:var(--ink-dim)}
.dist-lg span{display:inline-flex;align-items:center;gap:5px}
.dist-lg i{width:8px;height:8px;border-radius:2px;flex:none}

/* ---------- панель таблицы ---------- */
.panel{
  background:linear-gradient(180deg,#131c26,#101821);
  border:1px solid var(--line);border-radius:var(--r-xl);
  box-shadow:var(--shadow-2);overflow:hidden;
}
.panel-head{
  display:flex;align-items:center;gap:12px;flex-wrap:wrap;
  padding:14px 18px;border-bottom:1px solid var(--line);
  background:linear-gradient(180deg,#16202c,#121a24);
}
.panel-title{font-size:13px;font-weight:700;letter-spacing:.04em;display:flex;align-items:center;gap:9px}
.panel-title .lamp{width:8px;height:8px;border-radius:50%;background:var(--signal);box-shadow:0 0 10px var(--signal);animation:pulse 2.4s ease-in-out infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.35}}
.panel-head .grow{flex:1}

.bulkbar{
  display:none;align-items:center;gap:10px;flex-wrap:wrap;
  padding:10px 18px;border-bottom:1px solid var(--line);
  background:linear-gradient(90deg,#12303c,#1a2340);
}
.bulkbar.on{display:flex}
.bulkbar .n{font-family:var(--mono);font-size:12px;color:#9fe9f8;font-weight:600}

.tbl-scroll{overflow-x:auto}
table{width:100%;border-collapse:separate;border-spacing:0;min-width:940px}
thead th{
  position:sticky;top:0;z-index:2;
  background:#0f1720;border-bottom:1px solid var(--steel);
  padding:11px 14px;text-align:left;
  font-size:10px;letter-spacing:.16em;text-transform:uppercase;color:var(--ink-mute);font-weight:700;
  white-space:nowrap;
}
thead th.sortable{cursor:pointer;user-select:none;transition:color .15s}
thead th.sortable:hover{color:var(--electric)}
thead th .arw{opacity:0;margin-left:5px;font-size:9px}
thead th[data-dir] .arw{opacity:1;color:var(--electric)}
tbody tr{transition:background .15s var(--ease)}
tbody tr:nth-child(even){background:#ffffff03}
tbody tr:hover{background:linear-gradient(90deg,#22d3ee0e,#a78bfa08)}
tbody tr.sel{background:linear-gradient(90deg,#22d3ee18,#3b82f610);box-shadow:inset 3px 0 0 var(--electric)}
tbody tr.gone{display:none}
tbody td{padding:12px 14px;border-bottom:1px solid #16202c;vertical-align:middle}
body.compact tbody td{padding:7px 14px}
body.compact .sub-link{font-size:12px}
tbody tr:last-child td{border-bottom:none}

.cbox{
  appearance:none;-webkit-appearance:none;width:16px;height:16px;flex:none;
  border:1.5px solid var(--steel-2);border-radius:4px;background:#0b131c;
  cursor:pointer;position:relative;transition:all .15s;
}
.cbox:hover{border-color:var(--electric)}
.cbox:checked{background:linear-gradient(135deg,var(--electric),var(--blue));border-color:var(--electric)}
.cbox:checked::after{
  content:"";position:absolute;left:4.5px;top:1px;width:4px;height:8px;
  border:solid #04121c;border-width:0 2px 2px 0;transform:rotate(42deg);
}
.cbox:focus-visible{outline:2px solid var(--electric);outline-offset:2px}

.sub-link{
  display:inline-flex;align-items:center;gap:7px;
  font-family:var(--mono);font-size:13px;font-weight:600;
  color:var(--electric);text-decoration:none;transition:color .15s;
}
.sub-link:hover{color:#7ee7f7;text-decoration:underline}
.sub-link svg{width:11px;height:11px;opacity:.55}
.org{font-weight:600;font-size:13.5px;color:var(--ink);max-width:280px}
.tech{display:flex;align-items:center;gap:7px}
.tech code{
  font-family:var(--mono);font-size:11.5px;color:var(--ink-dim);
  background:#0b131c;border:1px solid var(--line);border-radius:5px;padding:3px 7px;
  max-width:210px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
}
.copy{
  border:none;background:none;color:var(--ink-faint);cursor:pointer;padding:3px;
  border-radius:4px;display:grid;place-items:center;transition:all .15s;flex:none;
}
.copy:hover{color:var(--electric);background:#22d3ee14}
.copy svg{width:13px;height:13px;display:block}

.badge{
  display:inline-flex;align-items:center;gap:5px;
  padding:3px 9px;border-radius:99px;font-size:10.5px;font-weight:700;
  letter-spacing:.04em;border:1px solid;white-space:nowrap;
}
.b-legacy{background:var(--warn-bg);color:var(--amber);border-color:#fbbf2440}
.b-modern{background:#0e1620;color:var(--ink-mute);border-color:var(--line)}
.b-on{background:var(--ok-bg);color:var(--signal);border-color:#34d39940}
.b-off{background:var(--bad-bg);color:var(--danger);border-color:#fb4d6d40}
.lamp-s{width:6px;height:6px;border-radius:50%;background:currentColor;box-shadow:0 0 7px currentColor;flex:none}
.b-on .lamp-s{animation:pulse 2.6s ease-in-out infinite}

.lvl{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.lvl-pill{
  display:inline-flex;align-items:center;gap:6px;
  padding:4px 11px;border-radius:99px;font-size:11.5px;font-weight:700;
  border:1px solid;white-space:nowrap;
}
.lvl-pill .rk{font-family:var(--mono);font-size:9px;opacity:.7;font-weight:600}
.lv-light{background:linear-gradient(135deg,#0e2a33,#0d1f2a);color:#7ee7f7;border-color:#1d5566}
.lv-standard{background:linear-gradient(135deg,#12233f,#101a30);color:#93b8ff;border-color:#28457a}
.lv-extended{background:linear-gradient(135deg,#2a1440,#3a1030);color:#f0a6d8;border-color:#6b2a63;
  box-shadow:0 0 0 1px #ec489922,0 5px 14px -8px #ec489988}
.lv-unknown{background:#0e1620;color:var(--ink-dim);border-color:var(--line)}
.rev{
  font-family:var(--mono);font-size:10px;color:var(--ink-mute);
  background:#0b131c;border:1px solid var(--line);border-radius:5px;padding:2px 6px;white-space:nowrap;
}
.rev b{color:var(--violet);font-weight:600}

.acts{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.acts form{display:inline-flex;margin:0}

.cd{font-family:var(--mono);font-size:10px;opacity:.85}

/* ---------- пустые состояния ---------- */
.empty{padding:64px 24px;text-align:center}
.empty-ic{
  width:64px;height:64px;margin:0 auto 18px;border-radius:18px;
  background:linear-gradient(150deg,#16222f,#0d141d);border:1px solid var(--steel);
  display:grid;place-items:center;color:var(--ink-faint);
}
.empty-ic svg{width:28px;height:28px}
.empty h3{margin:0 0 8px;font-size:16px;font-weight:700}
.empty p{margin:0 auto;max-width:400px;color:var(--ink-mute);font-size:13px}
.empty .btn{margin-top:18px}

/* ---------- панель добавления ---------- */
.scrim{
  position:fixed;inset:0;z-index:70;background:#04070cd0;
  backdrop-filter:blur(5px);-webkit-backdrop-filter:blur(5px);
  opacity:0;pointer-events:none;transition:opacity .28s var(--ease);
}
.scrim.on{opacity:1;pointer-events:auto}

.slide{
  position:fixed;top:0;right:0;bottom:0;z-index:80;width:min(520px,100%);
  background:linear-gradient(180deg,#141d28,#0e151e);
  border-left:1px solid var(--steel);box-shadow:var(--shadow-3);
  transform:translate3d(102%,0,0);transition:transform .38s var(--ease-out);
  display:flex;flex-direction:column;
}
.slide.on{transform:translate3d(0,0,0)}
.slide-head{
  display:flex;align-items:center;gap:12px;padding:18px 20px;
  border-bottom:1px solid var(--line);
  background:linear-gradient(135deg,#16222f,#131b26);flex:none;
}
.slide-head h2{margin:0;font-size:15px;font-weight:700;flex:1;letter-spacing:.02em}
.slide-body{flex:1;overflow-y:auto;padding:20px}
.slide-foot{
  flex:none;padding:14px 20px;border-top:1px solid var(--line);
  background:#0d141d;display:flex;gap:10px;
}
.slide-foot .btn{flex:1}

.fg{margin-bottom:15px}
.fg label{display:block;font-size:11px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--ink-mute);margin-bottom:6px}
.fg label .req{color:var(--danger);margin-left:3px}
.fg input{
  width:100%;padding:10px 12px;border-radius:var(--r-m);
  background:#0b131c;border:1px solid var(--steel);color:var(--ink);
  font:inherit;font-size:13px;transition:border-color .16s,box-shadow .16s;
}
.fg input.mono{font-family:var(--mono);font-size:12.5px}
.fg input::placeholder{color:var(--ink-faint)}
.fg input:focus{outline:none;border-color:var(--electric);box-shadow:0 0 0 3px #22d3ee22}
.fg input:invalid:not(:placeholder-shown){border-color:#fb4d6d80}
.fg .hint{font-size:11px;color:var(--ink-mute);margin-top:5px;line-height:1.45}
.frow{display:grid;grid-template-columns:1fr 108px;gap:12px}

.note{
  border-radius:var(--r-m);padding:12px 14px;font-size:12px;line-height:1.55;
  border:1px solid;margin-bottom:18px;display:flex;gap:10px;
}
.note svg{width:16px;height:16px;flex:none;margin-top:1px}
.note-i{background:#22d3ee10;border-color:#22d3ee35;color:#a5e9f5}
.note-w{background:var(--warn-bg);border-color:#fbbf2435;color:#f6d68a}

/* ----------.drawer ---------- */
.dr-tabs{display:flex;gap:4px;padding:0 20px;border-bottom:1px solid var(--line);background:#0f1720;flex:none}
.dr-tab{
  padding:11px 13px;font-size:12px;font-weight:600;color:var(--ink-mute);
  background:none;border:none;border-bottom:2px solid transparent;cursor:pointer;transition:all .16s;
}
.dr-tab:hover{color:var(--ink)}
.dr-tab[aria-selected="true"]{color:var(--electric);border-bottom-color:var(--electric)}
.dr-pane{display:none}
.dr-pane.on{display:block;animation:fadeUp .3s var(--ease-out)}
@keyframes fadeUp{from{opacity:0;transform:translateY(7px)}to{opacity:1;transform:none}}

.dr-hero{
  border-radius:var(--r-l);padding:17px;margin-bottom:18px;
  background:linear-gradient(140deg,#17232f,#111925);border:1px solid var(--steel);
  position:relative;overflow:hidden;
}
.dr-hero::after{
  content:"";position:absolute;right:-40px;top:-40px;width:150px;height:150px;border-radius:50%;
  background:radial-gradient(circle,var(--hc,var(--electric)),transparent 68%);opacity:.15;
}
.dr-hero h3{margin:0 0 4px;font-size:17px;font-weight:700;position:relative}
.dr-hero .sub{font-family:var(--mono);font-size:12px;color:var(--electric);position:relative}
.dr-hero .tags{display:flex;gap:7px;flex-wrap:wrap;margin-top:12px;position:relative}

.kv{display:grid;grid-template-columns:132px 1fr;gap:1px;background:var(--line);border:1px solid var(--line);border-radius:var(--r-m);overflow:hidden;margin-bottom:16px}
.kv dt{background:#0f1720;padding:9px 12px;font-size:11px;color:var(--ink-mute);letter-spacing:.05em;margin:0}
.kv dd{background:#0b131c;padding:9px 12px;margin:0;font-family:var(--mono);font-size:12px;color:var(--ink);word-break:break-all;display:flex;align-items:center;gap:7px}
.kv dd.mask{color:var(--ink-faint);letter-spacing:.16em}

.sec-t{font-size:10px;letter-spacing:.18em;text-transform:uppercase;color:var(--ink-mute);margin:20px 0 10px;font-weight:700;display:flex;align-items:center;gap:9px}
.sec-t::after{content:"";flex:1;height:1px;background:linear-gradient(90deg,var(--line),transparent)}

.caps{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.cap{
  display:flex;align-items:center;gap:9px;padding:9px 11px;border-radius:var(--r-s);
  background:#0b131c;border:1px solid var(--line);font-size:12px;
}
.cap .mk{width:17px;height:17px;border-radius:5px;display:grid;place-items:center;flex:none;font-size:10px;font-weight:800}
.cap.yes{border-color:#34d39930}
.cap.yes .mk{background:var(--ok-bg);color:var(--signal)}
.cap.no{opacity:.5}
.cap.no .mk{background:#fb4d6d14;color:var(--danger)}
.cap span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

.lims{display:grid;grid-template-columns:repeat(auto-fit,minmax(126px,1fr));gap:9px}
.lim{background:#0b131c;border:1px solid var(--line);border-radius:var(--r-m);padding:11px 12px}
.lim .k{font-size:9.5px;letter-spacing:.13em;text-transform:uppercase;color:var(--ink-mute);margin-bottom:5px}
.lim .v{font-family:var(--mono);font-size:17px;font-weight:700;color:var(--ink);line-height:1.1}
.lim .v.txt{font-size:12px;font-family:var(--sans);font-weight:600}
.lim .v small{font-size:10px;color:var(--ink-mute);font-weight:500}

.mtx{width:100%;min-width:0;border:1px solid var(--line);border-radius:var(--r-m);overflow:hidden;border-collapse:collapse}
.mtx th,.mtx td{padding:8px 10px;font-size:11.5px;border-bottom:1px solid var(--line);text-align:center}
.mtx th{background:#0f1720;font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:var(--ink-mute)}
.mtx th:first-child,.mtx td:first-child{text-align:left;color:var(--ink-dim)}
.mtx td{background:#0b131c;font-family:var(--mono)}
.mtx .cur{background:#22d3ee0e;box-shadow:inset 0 0 0 1px #22d3ee30}
.mtx th.cur{color:var(--electric);background:#12262f}
.mtx .y{color:var(--signal);font-weight:700}
.mtx .n{color:var(--ink-faint)}
.mtx tr:last-child td{border-bottom:none}

/* ---------- сохранённые виды ---------- */
.views{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
.view-pill{
  display:inline-flex;align-items:center;gap:6px;padding:5px 6px 5px 11px;
  border-radius:99px;background:#161f2e;border:1px solid var(--steel);
  font-size:11.5px;color:var(--ink-dim);
}
.view-pill button{border:none;background:none;cursor:pointer;padding:2px;border-radius:50%;display:grid;place-items:center;color:var(--ink-faint);transition:all .15s}
.view-pill button:hover{color:var(--danger);background:#fb4d6d18}
.view-pill button svg{width:11px;height:11px;display:block}
.view-pill .apply{color:var(--ink-dim);font-weight:600;padding:0;background:none;border-radius:0}
.view-pill .apply:hover{color:var(--electric);background:none}

/* ---------- тосты ---------- */
.toasts{position:fixed;right:18px;bottom:18px;z-index:120;display:flex;flex-direction:column-reverse;gap:10px;max-width:min(400px,calc(100vw - 36px))}
.toast{
  display:flex;align-items:flex-start;gap:11px;padding:13px 15px;
  border-radius:var(--r-m);border:1px solid var(--steel);
  background:linear-gradient(140deg,#18222e,#111925);
  box-shadow:var(--shadow-3);animation:toastIn .34s var(--ease-out);
}
.toast.out{animation:toastOut .26s var(--ease) forwards}
@keyframes toastIn{from{opacity:0;transform:translateX(28px) scale(.96)}to{opacity:1;transform:none}}
@keyframes toastOut{to{opacity:0;transform:translateX(28px) scale(.96)}}
.toast .ti{width:20px;height:20px;border-radius:6px;display:grid;place-items:center;flex:none;margin-top:1px}
.toast .ti svg{width:12px;height:12px}
.toast.ok{border-color:#34d39945}.toast.ok .ti{background:var(--ok-bg);color:var(--signal)}
.toast.err{border-color:#fb4d6d45}.toast.err .ti{background:var(--bad-bg);color:var(--danger)}
.toast.info{border-color:#22d3ee45}.toast.info .ti{background:#22d3ee14;color:var(--electric)}
.toast.warn{border-color:#fbbf2445}.toast.warn .ti{background:var(--warn-bg);color:var(--amber)}
.toast .tc{flex:1;min-width:0}
.toast .tt{font-size:12.5px;font-weight:700;margin-bottom:2px}
.toast .tm{font-size:11.5px;color:var(--ink-dim);line-height:1.45;word-break:break-word}
.toast .ta{margin-top:9px}
.toast .tx{border:none;background:none;color:var(--ink-faint);cursor:pointer;padding:2px;border-radius:4px;flex:none}
.toast .tx:hover{color:var(--ink)}
.toast .tx svg{width:13px;height:13px;display:block}

/* ---------- диалог ---------- */
.modal{
  position:fixed;z-index:110;left:50%;top:50%;transform:translate(-50%,-46%) scale(.96);
  width:min(430px,calc(100vw - 32px));opacity:0;pointer-events:none;
  background:linear-gradient(160deg,#18222e,#101821);
  border:1px solid var(--steel);border-radius:var(--r-l);
  box-shadow:var(--shadow-3);padding:22px;transition:all .26s var(--ease-out);
}
.modal.on{opacity:1;pointer-events:auto;transform:translate(-50%,-50%) scale(1)}
.modal h3{margin:0 0 9px;font-size:15px;font-weight:700;display:flex;align-items:center;gap:9px}
.modal h3 svg{width:18px;height:18px;flex:none}
.modal p{margin:0 0 18px;font-size:13px;color:var(--ink-dim);line-height:1.55}
.modal p b{color:var(--ink);font-family:var(--mono);font-size:12.5px}
.modal .row{display:flex;gap:9px}
.modal .row .btn{flex:1}

/* ---------- вход ---------- */
.rise{opacity:0;transform:translateY(14px);animation:rise .6s var(--ease-out) forwards}
@keyframes rise{to{opacity:1;transform:none}}
tbody tr.rise{animation-duration:.42s}

.sr{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}

/* ---------- адаптив ---------- */
@media (max-width:1240px){
  .col-db{display:none}
  table{min-width:760px}
}
@media (max-width:980px){
  :root{--head-h:60px}
  .wrap{padding:18px 14px 80px}
  .bar{padding:9px 14px}
  .head{padding:0 14px}
  .clock{display:none}
  .stats{grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}
  .stat-v{font-size:24px}
}
@media (max-width:860px){
  body{padding-top:calc(var(--head-h) + 108px)}
  .tbl-scroll{overflow-x:visible}
  table,thead,tbody,tr,td{display:block;width:100%;min-width:0}
  thead{display:none}
  tbody tr{
    border:1px solid var(--line);border-radius:var(--r-l);margin:12px 14px;
    background:linear-gradient(160deg,#141d28,#101821)!important;padding:6px 0;position:relative;
  }
  tbody tr.sel{box-shadow:inset 0 0 0 1px var(--electric)}
  tbody td{border-bottom:1px solid #16202c;padding:9px 14px;display:flex;align-items:center;gap:12px}
  tbody td:last-child{border-bottom:none}
  tbody td::before{
    content:attr(data-l);flex:none;width:96px;
    font-size:9.5px;letter-spacing:.13em;text-transform:uppercase;color:var(--ink-mute);font-weight:700;
  }
  tbody td.c-check{position:absolute;top:8px;right:10px;padding:0;border:none;width:auto}
  tbody td.c-check::before{display:none}
  tbody td.c-sub{padding-top:12px}
  tbody td.c-sub::before{display:none}
  .col-db{display:flex}
  .org{max-width:none}
  .tech code{max-width:none}
  .acts{flex-wrap:wrap}
  .panel-head{padding:12px 14px}
  .caps{grid-template-columns:1fr}
  .kv{grid-template-columns:1fr}
  .kv dt{border-bottom:1px solid #16202c}
  .toasts{right:12px;left:12px;bottom:12px;max-width:none}
}
@media (max-width:520px){
  .brand-sub{display:none}
  .frow{grid-template-columns:1fr}
  .search{max-width:none;flex:1 1 100%}
  .bar{gap:8px}
  .slide{width:100%}
}
@media (prefers-reduced-motion:reduce){
  *,*::before,*::after{animation-duration:.001ms!important;animation-iteration-count:1!important;transition-duration:.001ms!important}
  .rise{opacity:1;transform:none}
}
</style>
</head>
<body>

<div class="bg" aria-hidden="true">
  <div class="bg-base"></div>
  <div class="bg-rails"></div>
  <div class="bg-ticks"></div>
  <div class="bg-car"></div>
  <div class="bg-car b"></div>
  <div class="bg-grain"></div>
</div>

<header class="head">
  <div class="brand">
    <div class="mark">
      <svg viewBox="0 0 24 24" fill="none" stroke="url(#g1)" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
        <defs><linearGradient id="g1" x1="0" y1="0" x2="24" y2="24">
          <stop offset="0" stop-color="#22d3ee"/><stop offset="1" stop-color="#a78bfa"/>
        </linearGradient></defs>
        <rect x="4" y="2.5" width="16" height="19" rx="2.2"/>
        <path d="M12 2.5v19M8.4 8.2l1.5-2 1.5 2M15.6 15.8l-1.5 2-1.5-2"/>
      </svg>
    </div>
    <div class="brand-txt">
      <span class="brand-name">LIFT·CS</span>
      <span class="brand-sub">Platform Admin</span>
    </div>
  </div>

  <div class="head-spacer"></div>

  <div class="head-meta">
    <div class="clock" id="clock">MSK <b>--:--:--</b></div>
    <button type="button" class="btn btn-primary" id="openAdd">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>
      Организация
    </button>
    <a href="/admin/?logout=1" class="btn btn-danger" id="logout">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9"/></svg>
      Выйти
    </a>
  </div>
</header>

<div class="bar">
  <div class="search">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.6-3.6"/></svg>
    <input type="search" id="q" placeholder="Поддомен, название, БД…" autocomplete="off" aria-label="Поиск по организациям">
    <kbd>/</kbd>
  </div>

  <div class="chips" id="chips">
    <button type="button" class="chip" data-f="all" aria-pressed="true">Все <span class="n"><?= (int) $total ?></span></button>
    <button type="button" class="chip" data-f="active" aria-pressed="false"><i class="dot"></i>Активные <span class="n"><?= (int) $active ?></span></button>
    <button type="button" class="chip" data-f="inactive" aria-pressed="false"><i class="dot"></i>Отключённые <span class="n"><?= (int) $inactive ?></span></button>
    <button type="button" class="chip" data-f="legacy" aria-pressed="false"><i class="dot"></i>Legacy <span class="n"><?= (int) $legacy ?></span></button>
    <?php foreach ($levels as $lv): ?>
      <button type="button" class="chip" data-lv="<?= esc($lv) ?>" aria-pressed="false">
        <i class="dot"></i><?= esc(admin_reports_level_label($lv)) ?>
        <span class="n"><?= (int) ($byLevel[$lv] ?? 0) ?></span>
      </button>
    <?php endforeach; ?>
  </div>

  <select class="sel" id="sort" aria-label="Сортировка">
    <option value="id-desc">ID ↓</option>
    <option value="id-asc">ID ↑</option>
    <option value="sub-asc">Поддомен А→Я</option>
    <option value="sub-desc">Поддомен Я→А</option>
    <option value="org-asc">Название А→Я</option>
    <option value="level-desc">Уровень: выше</option>
    <option value="level-asc">Уровень: ниже</option>
    <option value="rev-desc">Ревизия ↓</option>
  </select>

  <button type="button" class="btn btn-ghost btn-sm" id="density" title="Плотность строк">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M3 6h18M3 12h18M3 18h18"/></svg>
    <span id="densityLabel">Плотно</span>
  </button>

  <button type="button" class="btn btn-ghost btn-sm" id="saveView" title="Сохранить текущий набор фильтров">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21l-7-5-7 5V5a2 2 0 012-2h10a2 2 0 012 2z"/></svg>
    Вид
  </button>

  <div class="views" id="views"></div>

  <div class="head-spacer"></div>
  <div class="bar-count" id="count"><b><?= (int) $total ?></b> / <?= (int) $total ?></div>
</div>

<main class="wrap">

  <section class="stats">
    <div class="stat rise" style="--c:var(--electric);animation-delay:.02s">
      <div class="stat-k">Организаций</div>
      <div class="stat-v"><?= (int) $total ?></div>
      <div class="stat-f">в центральном реестре</div>
      <div class="spark"><?php for ($i = 0; $i < 12; $i++): ?><i style="height:<?= 22 + (($i * 37) % 62) ?>%"></i><?php endfor; ?></div>
    </div>

    <div class="stat rise" style="--c:var(--signal);animation-delay:.07s">
      <div class="stat-k">Активны</div>
      <div class="stat-v"><?= (int) $active ?><small>/ <?= (int) $total ?></small></div>
      <div class="stat-f">
        <span class="badge b-on"><i class="lamp-s"></i>в работе</span>
        <?php if ($inactive > 0): ?><span class="badge b-off"><?= (int) $inactive ?> откл.</span><?php endif; ?>
      </div>
      <div class="dist">
        <i style="width:<?= $total ? round($active / $total * 100, 2) : 0 ?>%;background:linear-gradient(90deg,#34d399,#22d3ee)"></i>
        <i style="width:<?= $total ? round($inactive / $total * 100, 2) : 0 ?>%;background:linear-gradient(90deg,#fb4d6d,#e11d48)"></i>
      </div>
    </div>

    <div class="stat rise" style="--c:var(--amber);animation-delay:.12s">
      <div class="stat-k">Legacy-режим</div>
      <div class="stat-v"><?= (int) $legacy ?></div>
      <div class="stat-f"><?= $legacy > 0 ? 'прокси совместимости включён' : 'все на современном треке' ?></div>
      <div class="dist">
        <i style="width:<?= $total ? round($legacy / $total * 100, 2) : 0 ?>%;background:linear-gradient(90deg,#fbbf24,#f59e0b)"></i>
        <i style="width:<?= $total ? round(($total - $legacy) / $total * 100, 2) : 0 ?>%;background:#243040"></i>
      </div>
    </div>

    <div class="stat rise" style="--c:var(--magenta);animation-delay:.17s">
      <div class="stat-k">Уровни отчётов</div>
      <div class="stat-v"><?= (int) ($byLevel['extended'] ?? 0) ?><small>extended</small></div>
      <div class="dist">
        <?php
        $tierColor = ['light' => 'linear-gradient(90deg,#22d3ee,#0ea5b7)', 'standard' => 'linear-gradient(90deg,#3b82f6,#2563eb)', 'extended' => 'linear-gradient(90deg,#ec4899,#a78bfa)'];
        foreach ($levels as $lv):
            $w = $total ? round(($byLevel[$lv] ?? 0) / $total * 100, 2) : 0; ?>
          <i style="width:<?= $w ?>%;background:<?= $tierColor[$lv] ?? '#243040' ?>"></i>
        <?php endforeach; ?>
      </div>
      <div class="dist-lg">
        <?php foreach ($levels as $lv): ?>
          <span><i style="background:<?= $tierColor[$lv] ?? '#243040' ?>"></i><?= esc(admin_reports_level_label($lv)) ?> · <?= (int) ($byLevel[$lv] ?? 0) ?></span>
        <?php endforeach; ?>
      </div>
    </div>
  </section>

  <section class="panel rise" style="animation-delay:.22s">
    <div class="panel-head">
      <div class="panel-title"><i class="lamp"></i>Реестр организаций</div>
      <div class="grow"></div>
      <button type="button" class="btn btn-ghost btn-sm" id="exportAll">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg>
        CSV
      </button>
      <button type="button" class="btn btn-ghost btn-sm" id="resetAll">Сбросить</button>
    </div>

    <div class="bulkbar" id="bulkbar">
      <span class="n" id="bulkN">0 выбрано</span>
      <div class="grow" style="flex:1"></div>
      <button type="button" class="btn btn-cyan btn-sm" id="bulkCopy">Скопировать поддомены</button>
      <button type="button" class="btn btn-cyan btn-sm" id="bulkExport">Выгрузить выбранные</button>
      <button type="button" class="btn btn-ghost btn-sm" id="bulkClear">Снять выбор</button>
    </div>

    <?php if ($rows === []): ?>
      <div class="empty">
        <div class="empty-ic">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="2.5" width="16" height="19" rx="2"/><path d="M12 2.5v19"/></svg>
        </div>
        <h3>Реестр пуст</h3>
        <p>В центральной базе нет ни одной организации. Добавьте первую — она появится в списке и станет доступна по поддомену.</p>
        <button type="button" class="btn btn-primary" data-open-add>Добавить организацию</button>
      </div>
    <?php else: ?>
      <div class="tbl-scroll">
        <table id="tbl">
          <thead>
            <tr>
              <th style="width:38px"><input type="checkbox" class="cbox" id="selAll" aria-label="Выбрать все видимые"></th>
              <th class="sortable" data-s="sub">Поддомен<span class="arw">▾</span></th>
              <th class="sortable" data-s="org">Название<span class="arw">▾</span></th>
              <th class="col-db">БД</th>
              <th>Legacy</th>
              <th>Статус</th>
              <th class="sortable" data-s="level">Отчёты<span class="arw">▾</span></th>
              <th style="width:1%">Действия</th>
            </tr>
          </thead>
          <tbody id="tbody">
          <?php foreach ($rows as $i => $r):
              $lv     = $r['level'];
              $lvCls  = isset($matrix[$lv]) ? 'lv-' . $lv : 'lv-unknown';
              $host   = $r['subdomain'] . '.liftcs.ru';
              $search = mb_strtolower($r['subdomain'] . ' ' . $r['org_name'] . ' ' . $r['db_name'] . ' ' . $r['db_user']);
          ?>
            <tr class="rise"
                style="animation-delay:<?= min(0.26 + $i * 0.028, 0.9) ?>s"
                data-id="<?= (int) $r['id'] ?>"
                data-sub="<?= esc($r['subdomain']) ?>"
                data-org="<?= esc($r['org_name']) ?>"
                data-host="<?= esc($r['db_host']) ?>"
                data-port="<?= (int) $r['db_port'] ?>"
                data-db="<?= esc($r['db_name']) ?>"
                data-user="<?= esc($r['db_user']) ?>"
                data-active="<?= (int) $r['is_active'] ?>"
                data-legacy="<?= (int) $r['legacy'] ?>"
                data-level="<?= esc($lv) ?>"
                data-rev="<?= (int) $r['rev'] ?>"
                data-created="<?= esc($r['created_at']) ?>"
                data-rank="<?= (int) admin_reports_level_rank($lv) ?>"
                data-search="<?= esc($search) ?>">

              <td class="c-check"><input type="checkbox" class="cbox row-check" aria-label="Выбрать <?= esc($r['org_name']) ?>"></td>

              <td class="c-sub" data-l="Поддомен">
                <a class="sub-link" href="https://<?= esc($host) ?>" target="_blank" rel="noopener noreferrer">
                  <?= esc($r['subdomain']) ?>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6M15 3h6v6M10 14L21 3"/></svg>
                </a>
              </td>

              <td data-l="Название"><div class="org"><?= esc($r['org_name']) ?></div></td>

              <td class="col-db" data-l="БД">
                <div class="tech">
                  <code title="<?= esc($r['db_name']) ?>"><?= esc($r['db_name']) ?></code>
                  <button type="button" class="copy" data-copy="<?= esc($r['db_name']) ?>" title="Скопировать имя БД">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>
                  </button>
                </div>
              </td>

              <td data-l="Legacy">
                <?php if ($r['legacy']): ?>
                  <span class="badge b-legacy">Legacy</span>
                <?php else: ?>
                  <span class="badge b-modern">—</span>
                <?php endif; ?>
              </td>

              <td data-l="Статус">
                <?php if ($r['is_active']): ?>
                  <span class="badge b-on"><i class="lamp-s"></i>Активен</span>
                <?php else: ?>
                  <span class="badge b-off"><i class="lamp-s"></i>Отключён</span>
                <?php endif; ?>
              </td>

              <td data-l="Отчёты">
                <div class="lvl">
                  <span class="lvl-pill <?= esc($lvCls) ?>">
                    <?= esc(admin_reports_level_label($lv)) ?>
                    <span class="rk">r<?= (int) admin_reports_level_rank($lv) ?></span>
                  </span>
                  <span class="rev" title="reports_access_rev — счётчик доставки, только авто-инкремент">rev <b><?= (int) $r['rev'] ?></b></span>
                </div>
              </td>

              <td data-l="Действия">
                <div class="acts">
                  <a class="btn btn-violet btn-sm" href="/admin/tenant_edit.php?id=<?= (int) $r['id'] ?>">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 013 3L12 15l-4 1 1-4z"/></svg>
                    Изменить
                  </a>

                  <form action="/admin/tenants_save.php" method="POST" class="js-toggle"
                        data-name="<?= esc($r['org_name']) ?>" data-active="<?= (int) $r['is_active'] ?>">
                    <input type="hidden" name="id" value="<?= (int) $r['id'] ?>">
                    <input type="hidden" name="action" value="toggle">
                    <input type="hidden" name="current_status" value="<?= (int) $r['is_active'] ?>">
                    <button type="submit" class="btn btn-sm <?= $r['is_active'] ? 'btn-warn' : 'btn-go' ?>">
                      <?= $r['is_active'] ? 'Выкл' : 'Вкл' ?>
                    </button>
                  </form>

                  <?php if (!$r['legacy'] && $r['is_active']): ?>
                    <button type="button" class="btn btn-cyan btn-sm js-cleanup"
                            data-tenant-id="<?= (int) $r['id'] ?>"
                            data-tenant-name="<?= esc($r['org_name']) ?>">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/></svg>
                      <span class="lbl">Очистка уведомлений</span>
                    </button>
                  <?php endif; ?>

                  <button type="button" class="btn btn-ghost btn-sm btn-icon js-detail" title="Карточка организации" aria-label="Карточка организации">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 16v-4M12 8h.01"/></svg>
                  </button>
                </div>
              </td>
            </tr>
          <?php endforeach; ?>
          </tbody>
        </table>
      </div>

      <div class="empty" id="noMatch" hidden>
        <div class="empty-ic">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.6-3.6"/></svg>
        </div>
        <h3>Ничего не найдено</h3>
        <p>Под текущий поиск и фильтры не подходит ни одна организация. Сбросьте условия — реестр снова покажет все записи.</p>
        <button type="button" class="btn btn-ghost" data-reset>Сбросить фильтры</button>
      </div>
    <?php endif; ?>
  </section>
</main>

<!-- ===================== добавление ===================== -->
<div class="scrim" id="scrim"></div>

<aside class="slide" id="addPanel" role="dialog" aria-modal="true" aria-labelledby="addTitle" aria-hidden="true">
  <div class="slide-head">
    <h2 id="addTitle">Новая организация</h2>
    <button type="button" class="btn btn-ghost btn-icon" data-close aria-label="Закрыть">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
    </button>
  </div>

  <form action="/admin/tenants_save.php" method="POST" id="addForm" style="display:flex;flex-direction:column;flex:1;min-height:0">
    <input type="hidden" name="action" value="add">
    <div class="slide-body">
      <div class="note note-i">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 16v-4M12 8h.01"/></svg>
        <div>Запись создаётся в центральном реестре. Пароль БД шифруется на сервере. Уровень отчётов примет значение по умолчанию — <b>Стандарт</b>; меняется в карточке организации.</div>
      </div>

      <div class="fg">
        <label for="f_sub">Поддомен<span class="req">*</span></label>
        <input type="text" id="f_sub" name="subdomain" class="mono" placeholder="sh" required
               pattern="[a-z0-9-]+" maxlength="63" autocomplete="off" spellcheck="false">
        <div class="hint">Строчные латинские буквы, цифры и дефис. До 63 символов. Адрес: <span id="subPreview" style="color:var(--electric);font-family:var(--mono)">…liftcs.ru</span></div>
      </div>

      <div class="fg">
        <label for="f_org">Название организации<span class="req">*</span></label>
        <input type="text" id="f_org" name="org_name" placeholder="ООО БДОМ" required autocomplete="off">
      </div>

      <div class="frow">
        <div class="fg">
          <label for="f_host">Хост БД<span class="req">*</span></label>
          <input type="text" id="f_host" name="db_host" class="mono" value="localhost" required autocomplete="off">
        </div>
        <div class="fg">
          <label for="f_port">Порт<span class="req">*</span></label>
          <input type="number" id="f_port" name="db_port" class="mono" value="3306" min="1" max="65535" required>
        </div>
      </div>

      <div class="fg">
        <label for="f_db">Имя БД<span class="req">*</span></label>
        <input type="text" id="f_db" name="db_name" class="mono" placeholder="zamotaev_sh_liftcs" required autocomplete="off" spellcheck="false">
      </div>

      <div class="fg">
        <label for="f_user">Логин БД<span class="req">*</span></label>
        <input type="text" id="f_user" name="db_user" class="mono" placeholder="zamotaev_sh" required autocomplete="off" spellcheck="false">
      </div>

      <div class="fg">
        <label for="f_pass">Пароль БД<span class="req">*</span></label>
        <input type="password" id="f_pass" name="db_password" placeholder="••••••••" required autocomplete="new-password">
        <div class="hint">Хранится только в зашифрованном виде и никогда не отображается в интерфейсе.</div>
      </div>

      <div class="note note-w" style="margin-bottom:0">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.3 3.9L1.8 18a2 2 0 001.7 3h17a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z"/><path d="M12 9v4M12 17h.01"/></svg>
        <div>Поддомен должен обслуживаться веб-сервером и DNS. Запись в реестре сама по себе не создаёт vhost.</div>
      </div>
    </div>

    <div class="slide-foot">
      <button type="button" class="btn btn-ghost" data-close>Отмена</button>
      <button type="submit" class="btn btn-primary">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>
        Создать
      </button>
    </div>
  </form>
</aside>

<!-- ===================== карточка ===================== -->
<aside class="slide" id="drawer" role="dialog" aria-modal="true" aria-labelledby="drTitle" aria-hidden="true">
  <div class="slide-head">
    <h2 id="drTitle">Карточка организации</h2>
    <a class="btn btn-violet btn-sm" id="drEdit" href="#">Изменить</a>
    <button type="button" class="btn btn-ghost btn-icon" data-close aria-label="Закрыть">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
    </button>
  </div>

  <div class="dr-tabs" role="tablist">
    <button class="dr-tab" role="tab" data-pane="ov" aria-selected="true">Обзор</button>
    <button class="dr-tab" role="tab" data-pane="rp" aria-selected="false">Отчёты</button>
    <button class="dr-tab" role="tab" data-pane="cn" aria-selected="false">Подключение</button>
  </div>

  <div class="slide-body">
    <div class="dr-pane on" data-pane="ov">
      <div class="dr-hero" id="drHero">
        <h3 id="drOrg">—</h3>
        <div class="sub" id="drSub">—</div>
        <div class="tags" id="drTags"></div>
      </div>
      <div class="sec-t">Идентификация</div>
      <dl class="kv" id="drIdent"></dl>
      <div class="sec-t">Быстрые действия</div>
      <div class="acts">
        <a class="btn btn-cyan btn-sm" id="drOpen" href="#" target="_blank" rel="noopener noreferrer">Открыть тенант</a>
        <button type="button" class="btn btn-ghost btn-sm" id="drCopySub">Скопировать поддомен</button>
        <button type="button" class="btn btn-ghost btn-sm" id="drCopyDb">Скопировать имя БД</button>
      </div>
    </div>

    <div class="dr-pane" data-pane="rp">
      <div class="note note-i">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 16v-4M12 8h.01"/></svg>
        <div>Уровень применяется ко всем пользователям организации и не зависит от их ролей. Изменение вступает в силу в открытых вкладках автоматически в течение одного цикла опроса уведомлений; перелогин не требуется. Понижение уровня скрывает часть отчётов и выгрузок — данные не удаляются.</div>
      </div>
      <div id="drLevelHead"></div>
      <div class="sec-t">Способности</div>
      <div class="caps" id="drCaps"></div>
      <div class="sec-t">Лимиты</div>
      <div class="lims" id="drLims"></div>
      <div class="sec-t">Группы фильтров</div>
      <div class="caps" id="drGroups"></div>
      <div class="sec-t">Сравнение уровней</div>
      <div style="overflow-x:auto"><table class="mtx" id="drMtx"></table></div>
      <div class="hint" style="font-size:11px;color:var(--ink-mute);margin-top:10px;line-height:1.5">
        Матрица построена из <code style="font-family:var(--mono)">ReportsAccess::configPayload()</code>. Состав уровней и способностей админка не хранит.
      </div>
    </div>

    <div class="dr-pane" data-pane="cn">
      <div class="note note-w">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>
        <div>Пароль БД хранится зашифрованным и не передаётся в браузер. Правка параметров подключения — только в форме редактирования.</div>
      </div>
      <dl class="kv" id="drConn"></dl>
    </div>
  </div>

  <div class="slide-foot">
    <button type="button" class="btn btn-ghost" data-close>Закрыть</button>
    <a class="btn btn-primary" id="drEdit2" href="#">Редактировать</a>
  </div>
</aside>

<!-- ===================== подтверждение ===================== -->
<div class="modal" id="confirm" role="alertdialog" aria-modal="true" aria-labelledby="cfTitle" aria-hidden="true">
  <h3 id="cfTitle">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="color:var(--amber)"><path d="M10.3 3.9L1.8 18a2 2 0 001.7 3h17a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z"/><path d="M12 9v4M12 17h.01"/></svg>
    <span id="cfHead">Подтверждение</span>
  </h3>
  <p id="cfText"></p>
  <div class="row">
    <button type="button" class="btn btn-ghost" id="cfNo">Отмена</button>
    <button type="button" class="btn btn-warn" id="cfYes">Продолжить</button>
  </div>
</div>

<div class="toasts" id="toasts" aria-live="polite" aria-atomic="false"></div>

<script id="levelMatrix" type="application/json"><?= json_encode($matrix, $jsonFlags) ?></script>
<script id="levelMeta" type="application/json"><?= json_encode([
    'levels'   => $levels,
    'features' => array_map(static fn($k) => ['key' => $k, 'label' => admin_reports_feature_label($k)], $allFeatures),
    'groups'   => array_map(static fn($k) => ['key' => $k, 'label' => admin_reports_group_label($k)], $allGroups),
    'scopes'   => ADMIN_REPORTS_SCOPE_LABELS,
], $jsonFlags) ?></script>

<script>
(function () {
  'use strict';

  var $  = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

  var MATRIX = {}, META = { levels: [], features: [], groups: [], scopes: {} };
  try { MATRIX = JSON.parse($('#levelMatrix').textContent) || {}; } catch (e) {}
  try { META = JSON.parse($('#levelMeta').textContent) || META; } catch (e) {}

  var TIER = {
    light:    { c: '#22d3ee', cls: 'lv-light' },
    standard: { c: '#3b82f6', cls: 'lv-standard' },
    extended: { c: '#ec4899', cls: 'lv-extended' }
  };
  function tier(l) { return TIER[l] || { c: '#61758c', cls: 'lv-unknown' }; }
  function lvlLabel(l) { return (MATRIX[l] && MATRIX[l].label) || l; }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* ---------------- часы MSK ---------------- */
  (function clock() {
    var el = $('#clock'); if (!el) return;
    var b = el.querySelector('b');
    function tick() {
      var d = new Date(Date.now() + (new Date().getTimezoneOffset() * 60000) + 10800000);
      var p = function (n) { return n < 10 ? '0' + n : '' + n; };
      b.textContent = p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
    }
    tick(); setInterval(tick, 1000);
  })();

  /* ---------------- тосты ---------------- */
  var ICON = {
    ok:   '<path d="M20 6L9 17l-5-5"/>',
    err:  '<path d="M18 6L6 18M6 6l12 12"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 16v-4M12 8h.01"/>',
    warn: '<path d="M10.3 3.9L1.8 18a2 2 0 001.7 3h17a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z"/><path d="M12 9v4M12 17h.01"/>'
  };
  function toast(kind, title, msg, opts) {
    opts = opts || {};
    var box = $('#toasts'); if (!box) return null;
    var el = document.createElement('div');
    el.className = 'toast ' + kind;
    el.innerHTML =
      '<div class="ti"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">' + (ICON[kind] || ICON.info) + '</svg></div>' +
      '<div class="tc"><div class="tt">' + esc(title) + '</div>' +
      (msg ? '<div class="tm">' + esc(msg) + '</div>' : '') +
      (opts.action ? '<div class="ta"><button type="button" class="btn btn-cyan btn-sm">' + esc(opts.action) + '</button></div>' : '') +
      '</div>' +
      '<button type="button" class="tx" aria-label="Закрыть"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg></button>';
    box.appendChild(el);

    var timer = null;
    function kill() {
      if (timer) clearTimeout(timer);
      if (!el.parentNode) return;
      el.classList.add('out');
      setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 260);
    }
    el.querySelector('.tx').addEventListener('click', kill);
    if (opts.action) {
      el.querySelector('.ta .btn').addEventListener('click', function () {
        kill();
        if (typeof opts.onAction === 'function') opts.onAction();
      });
    }
    if (!opts.sticky) timer = setTimeout(kill, opts.ms || 4800);
    return { close: kill };
  }

  /* ---------------- буфер ---------------- */
  function copy(text, label) {
    var done = function () { toast('ok', 'Скопировано', label || text); };
    var fail = function () { toast('err', 'Не удалось скопировать', 'Скопируйте значение вручную.'); };
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(done, function () { legacy(); });
    } else { legacy(); }
    function legacy() {
      try {
        var ta = document.createElement('textarea');
        ta.value = text; ta.setAttribute('readonly', '');
        ta.style.cssText = 'position:fixed;left:-9999px;top:0';
        document.body.appendChild(ta); ta.select();
        var ok = document.execCommand('copy');
        document.body.removeChild(ta);
        ok ? done() : fail();
      } catch (e) { fail(); }
    }
  }
  document.addEventListener('click', function (e) {
    var b = e.target.closest ? e.target.closest('[data-copy]') : null;
    if (!b) return;
    e.preventDefault(); e.stopPropagation();
    copy(b.getAttribute('data-copy'));
  });

  /* ---------------- состояние списка ---------------- */
  var tbody = $('#tbody');
  var rows  = tbody ? $$('#tbody > tr') : [];
  var state = { q: '', f: 'all', lv: '', sort: 'id-desc' };

  function apply() {
    var q = state.q.trim().toLowerCase();
    var shown = 0;
    rows.forEach(function (tr) {
      var ok = true;
      if (q && tr.dataset.search.indexOf(q) === -1) ok = false;
      if (ok && state.f === 'active'   && tr.dataset.active !== '1') ok = false;
      if (ok && state.f === 'inactive' && tr.dataset.active === '1') ok = false;
      if (ok && state.f === 'legacy'   && tr.dataset.legacy !== '1') ok = false;
      if (ok && state.lv && tr.dataset.level !== state.lv) ok = false;
      tr.classList.toggle('gone', !ok);
      if (ok) shown++; else {
        var cb = tr.querySelector('.row-check');
        if (cb && cb.checked) { cb.checked = false; tr.classList.remove('sel'); }
      }
    });

    var key = state.sort.split('-'), field = key[0], dir = key[1] === 'asc' ? 1 : -1;
    var vis = rows.filter(function (t) { return !t.classList.contains('gone'); });
    vis.sort(function (a, b) {
      var r;
      if (field === 'id')    r = (+a.dataset.id) - (+b.dataset.id);
      else if (field === 'rev') r = (+a.dataset.rev) - (+b.dataset.rev);
      else if (field === 'level') r = (+a.dataset.rank) - (+b.dataset.rank) || (+a.dataset.id) - (+b.dataset.id);
      else r = String(a.dataset[field] || '').localeCompare(String(b.dataset[field] || ''), 'ru');
      return r * dir;
    });
    vis.forEach(function (tr) { tbody.appendChild(tr); });

    var c = $('#count');
    if (c) c.innerHTML = '<b>' + shown + '</b> / ' + rows.length;
    var nm = $('#noMatch');
    if (nm) nm.hidden = shown !== 0 || rows.length === 0;

    $$('#tbl thead th.sortable').forEach(function (th) {
      if (th.dataset.s === field) th.setAttribute('data-dir', dir === 1 ? 'asc' : 'desc');
      else th.removeAttribute('data-dir');
      var a = th.querySelector('.arw');
      if (a) a.textContent = dir === 1 ? '▴' : '▾';
    });

    syncBulk();
    var sa = $('#selAll');
    if (sa) {
      var vc = vis.map(function (t) { return t.querySelector('.row-check'); }).filter(Boolean);
      var on = vc.filter(function (c2) { return c2.checked; }).length;
      sa.checked = vc.length > 0 && on === vc.length;
      sa.indeterminate = on > 0 && on < vc.length;
    }
  }

  var qi = $('#q');
  if (qi) qi.addEventListener('input', function () { state.q = this.value; apply(); });

  $$('#chips .chip').forEach(function (ch) {
    ch.addEventListener('click', function () {
      var isLv = ch.hasAttribute('data-lv');
      var wasOn = ch.getAttribute('aria-pressed') === 'true';
      $$('#chips .chip').forEach(function (o) { o.setAttribute('aria-pressed', 'false'); });
      if (isLv) {
        state.lv = wasOn ? '' : ch.getAttribute('data-lv');
        state.f = 'all';
        if (!wasOn) ch.setAttribute('aria-pressed', 'true');
        else $('#chips .chip[data-f="all"]').setAttribute('aria-pressed', 'true');
      } else {
        state.f = ch.getAttribute('data-f');
        state.lv = '';
        ch.setAttribute('aria-pressed', 'true');
      }
      apply();
    });
  });

  var sortSel = $('#sort');
  if (sortSel) sortSel.addEventListener('change', function () { state.sort = this.value; apply(); });

  $$('#tbl thead th.sortable').forEach(function (th) {
    th.addEventListener('click', function () {
      var f = th.dataset.s;
      var cur = state.sort.split('-');
      state.sort = f + '-' + (cur[0] === f && cur[1] === 'asc' ? 'desc' : 'asc');
      if (sortSel) {
        var has = $$('option', sortSel).some(function (o) { return o.value === state.sort; });
        sortSel.value = has ? state.sort : '';
      }
      apply();
    });
  });

  function resetAll() {
    state = { q: '', f: 'all', lv: '', sort: 'id-desc' };
    if (qi) qi.value = '';
    if (sortSel) sortSel.value = 'id-desc';
    $$('#chips .chip').forEach(function (o) { o.setAttribute('aria-pressed', o.getAttribute('data-f') === 'all' ? 'true' : 'false'); });
    apply();
  }
  var ra = $('#resetAll'); if (ra) ra.addEventListener('click', resetAll);
  $$('[data-reset]').forEach(function (b) { b.addEventListener('click', resetAll); });

  /* ---------------- плотность ---------------- */
  var DKEY = 'liftcs.tenants.density';
  function setDensity(v) {
    document.body.classList.toggle('compact', v === 'compact');
    var l = $('#densityLabel'); if (l) l.textContent = v === 'compact' ? 'Свободно' : 'Плотно';
    try { localStorage.setItem(DKEY, v); } catch (e) {}
  }
  try { setDensity(localStorage.getItem(DKEY) === 'compact' ? 'compact' : 'cozy'); } catch (e) { setDensity('cozy'); }
  var db = $('#density');
  if (db) db.addEventListener('click', function () {
    setDensity(document.body.classList.contains('compact') ? 'cozy' : 'compact');
  });

  /* ---------------- выбор ---------------- */
  function selected() {
    return rows.filter(function (t) {
      var c = t.querySelector('.row-check');
      return c && c.checked && !t.classList.contains('gone');
    });
  }
  function syncBulk() {
    var n = selected().length;
    var bar = $('#bulkbar'); if (bar) bar.classList.toggle('on', n > 0);
    var lbl = $('#bulkN'); if (lbl) lbl.textContent = n + ' выбрано';
  }
  rows.forEach(function (tr) {
    var cb = tr.querySelector('.row-check');
    if (!cb) return;
    cb.addEventListener('change', function () { tr.classList.toggle('sel', cb.checked); apply(); });
    cb.addEventListener('click', function (e) { e.stopPropagation(); });
  });
  var selAll = $('#selAll');
  if (selAll) selAll.addEventListener('change', function () {
    var on = selAll.checked;
    rows.forEach(function (tr) {
      if (tr.classList.contains('gone')) return;
      var c = tr.querySelector('.row-check');
      if (c) { c.checked = on; tr.classList.toggle('sel', on); }
    });
    apply();
  });
  var bc = $('#bulkClear');
  if (bc) bc.addEventListener('click', function () {
    rows.forEach(function (tr) {
      var c = tr.querySelector('.row-check');
      if (c) c.checked = false;
      tr.classList.remove('sel');
    });
    apply();
  });

  /* ---------------- CSV ---------------- */
  function toCSV(list) {
    var head = ['id', 'subdomain', 'org_name', 'db_host', 'db_port', 'db_name', 'db_user', 'is_active', 'legacy_compat', 'reports_level', 'reports_access_rev', 'created_at'];
    var q = function (v) { return '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"'; };
    var lines = [head.join(';')];
    list.forEach(function (tr) {
      var d = tr.dataset;
      lines.push([d.id, d.sub, d.org, d.host, d.port, d.db, d.user, d.active, d.legacy, d.level, d.rev, d.created].map(q).join(';'));
    });
    return '\uFEFF' + lines.join('\r\n');
  }
  function download(name, text) {
    try {
      var blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url; a.download = name;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 1500);
      return true;
    } catch (e) { return false; }
  }
  function stamp() {
    var d = new Date(), p = function (n) { return n < 10 ? '0' + n : '' + n; };
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes());
  }
  var ea = $('#exportAll');
  if (ea) ea.addEventListener('click', function () {
    var list = rows.filter(function (t) { return !t.classList.contains('gone'); });
    if (!list.length) { toast('warn', 'Нечего выгружать', 'В текущем виде нет строк.'); return; }
    if (download('organizations-' + stamp() + '.csv', toCSV(list)))
      toast('ok', 'Выгрузка готова', list.length + ' строк. Пароли БД в файл не попадают.');
    else toast('err', 'Выгрузка не удалась', 'Браузер заблокировал скачивание.');
  });
  var be = $('#bulkExport');
  if (be) be.addEventListener('click', function () {
    var list = selected();
    if (!list.length) return;
    if (download('organizations-selected-' + stamp() + '.csv', toCSV(list)))
      toast('ok', 'Выгрузка готова', list.length + ' выбранных организаций.');
  });
  var bcp = $('#bulkCopy');
  if (bcp) bcp.addEventListener('click', function () {
    var list = selected(); if (!list.length) return;
    copy(list.map(function (t) { return t.dataset.sub; }).join('\n'), list.length + ' поддоменов');
  });

  /* ---------------- сохранённые виды ---------------- */
  var VKEY = 'liftcs.tenants.views';
  function readViews() { try { return JSON.parse(localStorage.getItem(VKEY)) || []; } catch (e) { return []; } }
  function writeViews(v) { try { localStorage.setItem(VKEY, JSON.stringify(v)); } catch (e) {} }
  function renderViews() {
    var box = $('#views'); if (!box) return;
    var list = readViews();
    box.innerHTML = '';
    list.forEach(function (v, i) {
      var el = document.createElement('span');
      el.className = 'view-pill';
      el.innerHTML = '<button type="button" class="apply">' + esc(v.name) + '</button>' +
                     '<button type="button" class="del" aria-label="Удалить вид"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg></button>';
      el.querySelector('.apply').addEventListener('click', function () {
        state = { q: v.q || '', f: v.f || 'all', lv: v.lv || '', sort: v.sort || 'id-desc' };
        if (qi) qi.value = state.q;
        if (sortSel) sortSel.value = state.sort;
        $$('#chips .chip').forEach(function (o) {
          var on = state.lv ? o.getAttribute('data-lv') === state.lv : o.getAttribute('data-f') === state.f;
          o.setAttribute('aria-pressed', on ? 'true' : 'false');
        });
        apply();
        toast('info', 'Вид применён', v.name);
      });
      el.querySelector('.del').addEventListener('click', function () {
        var cur = readViews(); var removed = cur[i];
        cur.splice(i, 1); writeViews(cur); renderViews();
        toast('warn', 'Вид удалён', removed ? removed.name : '', {
          action: 'Вернуть', ms: 7000,
          onAction: function () { var c = readViews(); c.splice(i, 0, removed); writeViews(c); renderViews(); toast('ok', 'Вид восстановлен', removed.name); }
        });
      });
      box.appendChild(el);
    });
  }
  var sv = $('#saveView');
  if (sv) sv.addEventListener('click', function () {
    var name = window.prompt('Название вида:', state.lv ? lvlLabel(state.lv) : (state.q || 'Мой вид'));
    if (!name) return;
    name = name.trim().slice(0, 28); if (!name) return;
    var list = readViews();
    list.push({ name: name, q: state.q, f: state.f, lv: state.lv, sort: state.sort });
    if (list.length > 8) list = list.slice(-8);
    writeViews(list); renderViews();
    toast('ok', 'Вид сохранён', name);
  });
  renderViews();

  /* ---------------- оверлеи ---------------- */
  var scrim = $('#scrim'), opened = null, lastFocus = null;
  function open(el) {
    if (!el) return;
    if (opened && opened !== el) close(true);
    lastFocus = document.activeElement;
    opened = el;
    el.classList.add('on'); el.setAttribute('aria-hidden', 'false');
    if (scrim) scrim.classList.add('on');
    document.body.classList.add('is-locked');
    var f = el.querySelector('input:not([type=hidden]), button, a[href]');
    if (f) setTimeout(function () { try { f.focus(); } catch (e) {} }, 120);
  }
  function close(silent) {
    if (!opened) return;
    opened.classList.remove('on'); opened.setAttribute('aria-hidden', 'true');
    opened = null;
    if (scrim) scrim.classList.remove('on');
    document.body.classList.remove('is-locked');
    if (!silent && lastFocus && lastFocus.focus) { try { lastFocus.focus(); } catch (e) {} }
  }
  if (scrim) scrim.addEventListener('click', function () { close(); closeConfirm(); });
  $$('[data-close]').forEach(function (b) { b.addEventListener('click', function () { close(); }); });

  var addPanel = $('#addPanel');
  var oa = $('#openAdd'); if (oa) oa.addEventListener('click', function () { open(addPanel); });
  $$('[data-open-add]').forEach(function (b) { b.addEventListener('click', function () { open(addPanel); }); });

  var fsub = $('#f_sub'), fprev = $('#subPreview');
  if (fsub && fprev) fsub.addEventListener('input', function () {
    var v = this.value.trim().toLowerCase();
    fprev.textContent = (v || '…') + '.liftcs.ru';
  });

  /* ---------------- подтверждение ---------------- */
  var cf = $('#confirm'), cfCb = null;
  function askConfirm(head, html, label, cls, cb) {
    if (!cf) { cb(); return; }
    $('#cfHead').textContent = head;
    $('#cfText').innerHTML = html;
    var yes = $('#cfYes');
    yes.className = 'btn ' + (cls || 'btn-warn');
    yes.textContent = label;
    cfCb = cb;
    cf.classList.add('on'); cf.setAttribute('aria-hidden', 'false');
    if (scrim) scrim.classList.add('on');
    document.body.classList.add('is-locked');
    setTimeout(function () { try { yes.focus(); } catch (e) {} }, 100);
  }
  function closeConfirm() {
    if (!cf || !cf.classList.contains('on')) return;
    cf.classList.remove('on'); cf.setAttribute('aria-hidden', 'true');
    cfCb = null;
    if (!opened) {
      if (scrim) scrim.classList.remove('on');
      document.body.classList.remove('is-locked');
    }
  }
  var cno = $('#cfNo'); if (cno) cno.addEventListener('click', closeConfirm);
  var cyes = $('#cfYes');
  if (cyes) cyes.addEventListener('click', function () { var f = cfCb; closeConfirm(); if (f) f(); });

  /* ---------------- переключение статуса + отмена ---------------- */
  var UKEY = 'liftcs.tenants.undo';
  $$('.js-toggle').forEach(function (form) {
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var act = form.dataset.active === '1';
      var name = form.dataset.name || '';
      var id = form.querySelector('[name=id]').value;
      askConfirm(
        act ? 'Отключить организацию?' : 'Включить организацию?',
        act
          ? 'Тенант <b>' + esc(name) + '</b> перестанет обслуживаться: вход и API по его поддомену будут недоступны. Данные не удаляются.'
          : 'Тенант <b>' + esc(name) + '</b> снова станет доступен по своему поддомену.',
        act ? 'Отключить' : 'Включить',
        act ? 'btn-danger' : 'btn-go',
        function () {
          try {
            sessionStorage.setItem(UKEY, JSON.stringify({
              id: id, name: name, from: act ? 1 : 0, to: act ? 0 : 1, ts: Date.now()
            }));
          } catch (err) {}
          form.submit();
        }
      );
    });
  });

  (function offerUndo() {
    var raw = null;
    try { raw = sessionStorage.getItem(UKEY); sessionStorage.removeItem(UKEY); } catch (e) {}
    if (!raw) return;
    var u; try { u = JSON.parse(raw); } catch (e) { return; }
    if (!u || Date.now() - u.ts > 45000) return;
    var tr = rows.filter(function (t) { return t.dataset.id === String(u.id); })[0];
    if (!tr || +tr.dataset.active !== u.to) return;
    toast(u.to ? 'ok' : 'warn',
      u.to ? 'Организация включена' : 'Организация отключена',
      u.name, {
        action: 'Отменить', sticky: true,
        onAction: function () {
          var f = document.createElement('form');
          f.method = 'POST'; f.action = '/admin/tenants_save.php'; f.style.display = 'none';
          [['id', u.id], ['action', 'toggle'], ['current_status', u.to]].forEach(function (p) {
            var i = document.createElement('input');
            i.type = 'hidden'; i.name = p[0]; i.value = p[1]; f.appendChild(i);
          });
          document.body.appendChild(f); f.submit();
        }
      });
  })();

  /* ---------------- очистка уведомлений ---------------- */
  $$('.js-cleanup').forEach(function (btn) {
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      if (btn.disabled) return;
      var id = btn.dataset.tenantId, name = btn.dataset.tenantName;
      askConfirm(
        'Очистить уведомления?',
        'Для тенанта <b>' + esc(name) + '</b> будет выполнена очистка очереди уведомлений. Операция необратима.',
        'Очистить', 'btn-danger',
        function () { runCleanup(btn, id, name); }
      );
    });
  });

  function runCleanup(btn, id, name) {
    var lbl = btn.querySelector('.lbl');
    var original = lbl ? lbl.textContent : btn.textContent;
    btn.disabled = true;
    if (lbl) lbl.textContent = 'Очистка…';

    var fd = new FormData(); fd.append('id', id);

    fetch('/admin/cleanup_tenant.php', { method: 'POST', body: fd, credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data && data.success) toast('ok', 'Очистка завершена', (data && data.message) || name);
        else toast('err', 'Ошибка очистки', (data && data.error) || 'Неизвестная ошибка');
      })
      .catch(function (err) { toast('err', 'Сеть недоступна', String(err && err.message || err)); })
      .then(function () {
        var left = 60;
        if (lbl) lbl.innerHTML = 'Повтор через <span class="cd">' + left + '</span> с';
        var t = setInterval(function () {
          left--;
          var cd = btn.querySelector('.cd');
          if (cd) cd.textContent = left;
          if (left <= 0) {
            clearInterval(t);
            btn.disabled = false;
            if (lbl) lbl.textContent = original;
          }
        }, 1000);
      });
  }

  /* ---------------- карточка ---------------- */
  var drawer = $('#drawer'), current = null;

  function kvRow(k, v, mask, copyable) {
    return '<dt>' + esc(k) + '</dt><dd' + (mask ? ' class="mask"' : '') + '>' + esc(v) +
      (copyable ? ' <button type="button" class="copy" data-copy="' + esc(v) + '" title="Скопировать"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg></button>' : '') +
      '</dd>';
  }

  function openDrawer(tr) {
    current = tr;
    var d = tr.dataset, t = tier(d.level), m = MATRIX[d.level];

    $('#drOrg').textContent = d.org;
    $('#drSub').textContent = d.sub + '.liftcs.ru';
    $('#drHero').style.setProperty('--hc', t.c);

    $('#drTags').innerHTML =
      (d.active === '1'
        ? '<span class="badge b-on"><i class="lamp-s"></i>Активен</span>'
        : '<span class="badge b-off"><i class="lamp-s"></i>Отключён</span>') +
      (d.legacy === '1' ? '<span class="badge b-legacy">Legacy</span>' : '<span class="badge b-modern">Современный трек</span>') +
      '<span class="lvl-pill ' + t.cls + '">' + esc(lvlLabel(d.level)) + '<span class="rk">r' + (m ? m.rank : '—') + '</span></span>';

    $('#drIdent').innerHTML =
      kvRow('ID', d.id) +
      kvRow('Поддомен', d.sub, false, true) +
      kvRow('Название', d.org) +
      kvRow('Создана', d.created || '—');

    $('#drConn').innerHTML =
      kvRow('Хост', d.host, false, true) +
      kvRow('Порт', d.port) +
      kvRow('Имя БД', d.db, false, true) +
      kvRow('Логин', d.user, false, true) +
      kvRow('Пароль', '••••••••••••', true, false) +
      kvRow('Legacy', d.legacy === '1' ? 'включён' : 'выключен') +
      kvRow('Статус', d.active === '1' ? 'активен' : 'отключён');

    var editUrl = '/admin/tenant_edit.php?id=' + encodeURIComponent(d.id);
    $('#drEdit').href = editUrl;
    $('#drEdit2').href = editUrl;
    $('#drOpen').href = 'https://' + d.sub + '.liftcs.ru';
    $('#drCopySub').onclick = function () { copy(d.sub, 'Поддомен ' + d.sub); };
    $('#drCopyDb').onclick  = function () { copy(d.db, 'Имя БД ' + d.db); };

    /* отчёты */
    $('#drLevelHead').innerHTML =
      '<div class="dr-hero" style="--hc:' + t.c + '">' +
        '<h3>' + esc(lvlLabel(d.level)) + '</h3>' +
        '<div class="sub">reports_level = ' + esc(d.level) + '</div>' +
        '<div class="tags"><span class="rev">reports_access_rev <b>' + esc(d.rev) + '</b></span>' +
        '<span class="badge b-modern">ранг ' + (m ? m.rank : '—') + '</span></div>' +
      '</div>';

    var feats = (m && m.features) || [];
    $('#drCaps').innerHTML = (META.features || []).map(function (f) {
      var yes = feats.indexOf(f.key) !== -1;
      return '<div class="cap ' + (yes ? 'yes' : 'no') + '"><span class="mk">' + (yes ? '✓' : '✕') + '</span><span>' + esc(f.label) + '</span></div>';
    }).join('') || '<div class="cap no">Нет данных</div>';

    var groups = (m && m.limits && m.limits.filter_groups) || [];
    $('#drGroups').innerHTML = (META.groups || []).map(function (g) {
      var yes = groups.indexOf(g.key) !== -1;
      return '<div class="cap ' + (yes ? 'yes' : 'no') + '"><span class="mk">' + (yes ? '✓' : '✕') + '</span><span>' + esc(g.label) + '</span></div>';
    }).join('') || '<div class="cap no">Нет данных</div>';

    if (m) {
      var L = m.limits || {};
      var scope = (META.scopes && META.scopes[L.address_scope]) || L.address_scope || '—';
      $('#drLims').innerHTML =
        '<div class="lim"><div class="k">Период</div><div class="v">' + esc(L.max_period_days) + ' <small>дн.</small></div></div>' +
        '<div class="lim"><div class="k">Экспорт</div><div class="v">' + esc(L.max_rows) + ' <small>строк</small></div></div>' +
        '<div class="lim"><div class="k">Список</div><div class="v">' + (m.list_cap == null ? '<span class="v txt">Без потолка</span>' : esc(m.list_cap) + ' <small>строк</small>') + '</div></div>' +
        '<div class="lim"><div class="k">Адреса</div><div class="v txt">' + esc(scope) + '</div></div>';
    } else {
      $('#drLims').innerHTML = '<div class="lim"><div class="k">Данные</div><div class="v txt">недоступны</div></div>';
    }

    var lv = META.levels || [];
    var head = '<tr><th>Параметр</th>' + lv.map(function (l) {
      return '<th class="' + (l === d.level ? 'cur' : '') + '">' + esc(lvlLabel(l)) + '</th>';
    }).join('') + '</tr>';

    function row(label, cells) {
      return '<tr><td>' + esc(label) + '</td>' + cells.map(function (c, i) {
        return '<td class="' + (lv[i] === d.level ? 'cur ' : '') + c.cls + '">' + c.v + '</td>';
      }).join('') + '</tr>';
    }
    var body = '';
    (META.features || []).forEach(function (f) {
      body += row(f.label, lv.map(function (l) {
        var on = MATRIX[l] && MATRIX[l].features.indexOf(f.key) !== -1;
        return { cls: on ? 'y' : 'n', v: on ? '✓' : '—' };
      }));
    });
    (META.groups || []).forEach(function (g) {
      body += row(g.label, lv.map(function (l) {
        var on = MATRIX[l] && MATRIX[l].limits.filter_groups.indexOf(g.key) !== -1;
        return { cls: on ? 'y' : 'n', v: on ? '✓' : '—' };
      }));
    });
    body += row('Период, дн.', lv.map(function (l) { return { cls: '', v: MATRIX[l] ? MATRIX[l].limits.max_period_days : '—' }; }));
    body += row('Экспорт, строк', lv.map(function (l) { return { cls: '', v: MATRIX[l] ? MATRIX[l].limits.max_rows : '—' }; }));
    body += row('Потолок списка', lv.map(function (l) {
      return { cls: '', v: MATRIX[l] ? (MATRIX[l].list_cap == null ? '∞' : MATRIX[l].list_cap) : '—' };
    }));
    $('#drMtx').innerHTML = head + body;

    $$('.dr-tab').forEach(function (tb) { tb.setAttribute('aria-selected', tb.dataset.pane === 'ov' ? 'true' : 'false'); });
    $$('.dr-pane').forEach(function (p) { p.classList.toggle('on', p.dataset.pane === 'ov'); });

    open(drawer);
  }

  $$('.dr-tab').forEach(function (tb) {
    tb.addEventListener('click', function () {
      $$('.dr-tab').forEach(function (o) { o.setAttribute('aria-selected', 'false'); });
      tb.setAttribute('aria-selected', 'true');
      $$('.dr-pane').forEach(function (p) { p.classList.toggle('on', p.dataset.pane === tb.dataset.pane); });
    });
  });

  $$('.js-detail').forEach(function (b) {
    b.addEventListener('click', function (e) {
      e.stopPropagation();
      var tr = b.closest('tr'); if (tr) openDrawer(tr);
    });
  });

  rows.forEach(function (tr) {
    tr.addEventListener('click', function (e) {
      if (e.target.closest('a, button, input, form, label')) return;
      openDrawer(tr);
    });
  });

  /* ---------------- горячие клавиши ---------------- */
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      if (cf && cf.classList.contains('on')) { closeConfirm(); return; }
      if (opened) { close(); return; }
    }
    var tag = (e.target && e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
    if (e.key === '/') { e.preventDefault(); if (qi) qi.focus(); }
    if (e.key === 'n' && !e.metaKey && !e.ctrlKey && !e.altKey) { e.preventDefault(); open(addPanel); }
  });

  /* ---------------- уход со страницы ---------------- */
  var lo = $('#logout');
  if (lo) lo.addEventListener('click', function () {
    try { sessionStorage.removeItem(UKEY); } catch (e) {}
  });

  if (rows.length) apply();
  else { var c0 = $('#count'); if (c0) c0.innerHTML = '<b>0</b> / 0'; }
})();
</script>
</body>
</html>