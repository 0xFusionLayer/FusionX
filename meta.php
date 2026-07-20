<?php
/**
 * FusionX — link previews for crawlers (Discord, X, Telegram…).
 *
 * .htaccess routes pretty URLs here:
 *   /username              -> meta.php?user=username
 *   /post/14               -> meta.php?post=14
 *   /post/14/comment/3     -> meta.php?post=14&comment=3
 *
 * The entity is read straight from the FusionLayer RPC (the chain is the
 * backend), proper Open Graph / Twitter meta is emitted, and real browsers
 * are instantly redirected into the app's hash route. Responses are cached
 * on disk for a few minutes so crawler bursts don't hammer the RPC.
 *
 * Meta rules:
 *  - descriptions show the content with markdown converted to readable text
 *    (line breaks kept, lists as bullets, syntax stripped)
 *  - og:image is used ONLY when the content contains an image (markdown
 *    image or bare image URL) — never the default site card
 *  - profiles use the avatar as og:image when set
 */

const SITE_ORIGIN   = "https://fusionx.social";
const SITE_NAME     = "FusionX";
const DEFAULT_DESC  = "Decentralized social on FusionLayer — permanent, permissionless, censorship-free. Built-in wallet, no extensions.";
const CONTRACT      = "0x13e4b3fE79388C6eF206481655c8557320811104";
const RPC_URLS      = ["https://rpc.fusionlayer.org/", "https://rpc.fusionscan.net/"];
const CACHE_TTL     = 300; // seconds

/* function selectors (first 4 bytes of keccak-256 of the signature) */
const SEL_GET_POST      = "0x40731c24"; // getPost(uint256)
const SEL_GET_COMMENT   = "0x48892753"; // getComment(uint256,uint256)
const SEL_GET_BASIC     = "0x15c160f5"; // getUserBasic(address)
const SEL_GET_PROFILE   = "0x987ee156"; // getUserProfile(address)
const SEL_GET_STATS     = "0x4e43603a"; // getUserStats(address)
const SEL_ADDR_BY_NAME  = "0xe47c5e33"; // getUserAddressByUsername(string)

/* ---------------- RPC + ABI helpers ---------------- */

function rpc_eth_call(string $data): ?string {
    foreach (RPC_URLS as $url) {
        $ch = curl_init($url);
        curl_setopt_array($ch, [
            CURLOPT_POST           => true,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT        => 6,
            CURLOPT_HTTPHEADER     => ["Content-Type: application/json"],
            CURLOPT_POSTFIELDS     => json_encode([
                "jsonrpc" => "2.0", "id" => 1, "method" => "eth_call",
                "params"  => [["to" => CONTRACT, "data" => $data], "latest"],
            ]),
        ]);
        $raw = curl_exec($ch);
        curl_close($ch);
        if ($raw === false) continue;               // network issue — try fallback RPC
        $j = json_decode($raw, true);
        if (isset($j["result"]) && is_string($j["result"]) && strlen($j["result"]) > 2) {
            return substr($j["result"], 2);
        }
        if (isset($j["error"])) return null;        // revert — don't retry
    }
    return null;
}

function abi_word(string $hex, int $slot): string { return substr($hex, $slot * 64, 64); }
function abi_uint(string $hex, int $slot): int    { return (int) hexdec(abi_word($hex, $slot)); }
function abi_bool(string $hex, int $slot): bool   { return abi_uint($hex, $slot) === 1; }
function abi_addr(string $hex, int $slot): string { return "0x" . substr(abi_word($hex, $slot), 24); }
function abi_str(string $hex, int $slot): string {
    $off = hexdec(abi_word($hex, $slot)) * 2;
    if ($off + 64 > strlen($hex)) return "";
    $len = hexdec(substr($hex, $off, 64)) * 2;
    $bin = hex2bin(substr($hex, $off + 64, $len));
    return $bin === false ? "" : $bin;
}
function pad_uint(int $n): string    { return str_pad(dechex($n), 64, "0", STR_PAD_LEFT); }
function pad_addr(string $a): string { return str_pad(strtolower(substr($a, 2)), 64, "0", STR_PAD_LEFT); }
function enc_string(string $s): string {
    /* single dynamic string argument: offset word + length word + padded data */
    $hex = bin2hex($s);
    $padded = str_pad($hex, (int) (ceil(strlen($hex) / 64) ?: 1) * 64, "0", STR_PAD_RIGHT);
    return pad_uint(32) . pad_uint(strlen($s)) . $padded;
}

function cached(string $key, callable $fn): ?array {
    $file = sys_get_temp_dir() . "/fusionx_meta_" . md5($key) . ".json";
    if (is_file($file) && time() - filemtime($file) < CACHE_TTL) {
        $c = json_decode((string) file_get_contents($file), true);
        if (is_array($c)) return $c;
    }
    $v = $fn();
    if ($v !== null) @file_put_contents($file, json_encode($v), LOCK_EX);
    return $v;
}

/* ---------------- entity loaders ---------------- */

function author_names(string $addr): array {
    $nickname = ""; $username = "";
    $b = rpc_eth_call(SEL_GET_BASIC . pad_addr($addr));
    if ($b !== null) $username = abi_str($b, 1);
    $p = rpc_eth_call(SEL_GET_PROFILE . pad_addr($addr));
    if ($p !== null) $nickname = abi_str($p, 0);
    return [$nickname, $username];
}

function load_post(int $id): ?array {
    return cached("post$id", function () use ($id) {
        /* [0]=id [1]=author [2]=authorPostId [3]=time [4]=content
           [5]=comments [6]=likes [7]=dislikes [8]=hidden [9]=isRepost [10]=originalId [11]=reposts */
        $r = rpc_eth_call(SEL_GET_POST . pad_uint($id));
        if ($r === null || strlen($r) < 12 * 64) return null;
        [$nickname, $username] = author_names(abi_addr($r, 1));
        return [
            "content" => abi_str($r, 4), "hidden" => abi_bool($r, 8),
            "isRepost" => abi_bool($r, 9), "originalId" => abi_uint($r, 10),
            "nickname" => $nickname, "username" => $username,
        ];
    });
}

function load_comment(int $postId, int $commentId): ?array {
    return cached("comment$postId-$commentId", function () use ($postId, $commentId) {
        /* [0]=postId [1]=id [2]=author [3]=time [4]=text [5]=likes [6]=dislikes [7]=hidden */
        $r = rpc_eth_call(SEL_GET_COMMENT . pad_uint($postId) . pad_uint($commentId));
        if ($r === null || strlen($r) < 8 * 64) return null;
        [$nickname, $username] = author_names(abi_addr($r, 2));
        return [
            "content" => abi_str($r, 4), "hidden" => abi_bool($r, 7),
            "nickname" => $nickname, "username" => $username,
        ];
    });
}

function load_profile(string $name): ?array {
    return cached("user" . strtolower($name), function () use ($name) {
        $r = rpc_eth_call(SEL_ADDR_BY_NAME . enc_string(strtolower($name)));
        if ($r === null) return null;
        $addr = abi_addr($r, 0);
        if ($addr === "0x0000000000000000000000000000000000000000") return null;
        /* profile: [0]=nickname [1]=about [2]=website [3]=location [4]=avatar [5]=cover [6]=pinned */
        $p = rpc_eth_call(SEL_GET_PROFILE . pad_addr($addr));
        $b = rpc_eth_call(SEL_GET_BASIC . pad_addr($addr));
        $s = rpc_eth_call(SEL_GET_STATS . pad_addr($addr));
        return [
            "nickname" => $p !== null ? abi_str($p, 0) : "",
            "about"    => $p !== null ? abi_str($p, 1) : "",
            "avatar"   => $p !== null ? abi_str($p, 4) : "",
            "username" => $b !== null ? abi_str($b, 1) : strtolower($name),
            "posts"     => $s !== null ? abi_uint($s, 0) : 0,
            "followers" => $s !== null ? abi_uint($s, 2) : 0,
        ];
    });
}

/* ---------------- markdown -> preview text / image ---------------- */

function extract_image(string $md): ?string {
    if (preg_match('/!\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/i', $md, $m)) return $m[1];
    if (preg_match('/(https?:\/\/[^\s<>"\')]+\.(?:png|jpe?g|gif|webp)(?:\?[^\s<>"\')]*)?)/i', $md, $m)) return $m[1];
    return null;
}

function md_to_text(string $md, int $max = 340): string {
    $t = preg_replace_callback('/```[\s\S]*?```/', function ($m) {
        return preg_replace('/```[^\n]*\n?/', "", $m[0]);          // keep code, drop fences
    }, $md);
    $t = preg_replace('/!\[[^\]]*\]\([^)]*\)/', "", $t);            // images (become og:image)
    $t = preg_replace('/\[([^\]]*)\]\([^)]*\)/', '$1', $t);         // links -> text
    $t = preg_replace('/^#{1,6}\s+/m', "", $t);                     // headings
    $t = preg_replace('/^\s*[-*+]\s+/m', "• ", $t);                 // lists -> bullets
    $t = preg_replace('/(\*\*|__)(.*?)\1/s', '$2', $t);             // bold
    $t = preg_replace('/(\*|_)(.*?)\1/s', '$2', $t);                // italic
    $t = preg_replace('/~~(.*?)~~/s', '$1', $t);                    // strikethrough
    $t = preg_replace('/`([^`]*)`/', '$1', $t);                     // inline code
    $t = preg_replace('/^\s*>\s?/m', "", $t);                       // blockquotes
    $t = trim(preg_replace('/\n{3,}/', "\n\n", preg_replace('/[ \t]+/', " ", $t)));
    if (mb_strlen($t) > $max) $t = rtrim(mb_substr($t, 0, $max - 1)) . "…";
    return $t;
}

function e(string $s): string { return htmlspecialchars($s, ENT_QUOTES, "UTF-8"); }

/* ---------------- resolve the requested entity ---------------- */

$postId    = isset($_GET["post"]) ? (int) $_GET["post"] : 0;
$commentId = isset($_GET["comment"]) ? (int) $_GET["comment"] : 0;
$userName  = isset($_GET["user"]) ? (string) $_GET["user"] : "";

$title = SITE_NAME;
$desc  = DEFAULT_DESC;
$image = null;                       // null -> no image tags at all
$path  = "/";
$app   = "/";

if ($postId >= 1 && $commentId >= 1) {
    $c = load_comment($postId, $commentId);
    $path = "/post/$postId/comment/$commentId";
    $app  = "/#post$postId/#comment$commentId";
    if ($c !== null && !$c["hidden"]) {
        $who = $c["nickname"] !== "" ? $c["nickname"] : "Comment";
        $at  = $c["username"] !== "" ? " (@" . $c["username"] . ")" : "";
        $title = $who . $at . " · comment on post #$postId · " . SITE_NAME;
        $desc  = md_to_text($c["content"]);
        $image = extract_image($c["content"]);
        if ($desc === "") $desc = "A comment on " . SITE_NAME . ".";
    } else {
        $desc = "This comment is not available.";
    }
} elseif ($postId >= 1) {
    $p = load_post($postId);
    $path = "/post/$postId";
    $app  = "/#post$postId";
    if ($p !== null && !$p["hidden"]) {
        $who = $p["nickname"] !== "" ? $p["nickname"] : "Post #$postId";
        $at  = $p["username"] !== "" ? " (@" . $p["username"] . ")" : "";
        $title = $who . $at . " on " . SITE_NAME;
        $desc  = md_to_text($p["content"]);
        $image = extract_image($p["content"]);
        if ($desc === "" && $p["isRepost"]) $desc = "Reposted post #" . $p["originalId"] . " on " . SITE_NAME . ".";
        if ($desc === "") $desc = "A post on " . SITE_NAME . ".";
    } else {
        $desc = "This post is not available.";
    }
} elseif ($userName !== "" && preg_match('/^[A-Za-z0-9_]{1,30}$/', $userName)) {
    $u = load_profile($userName);
    $path = "/" . strtolower($userName);
    $app  = "/#" . strtolower($userName);
    if ($u !== null) {
        $who = $u["nickname"] !== "" ? $u["nickname"] : "@" . $u["username"];
        $title = $who . " (@" . $u["username"] . ") on " . SITE_NAME;
        $about = md_to_text($u["about"], 240);
        $stats = $u["posts"] . " posts · " . $u["followers"] . " followers";
        $desc  = $about !== "" ? $about . "\n" . $stats : $stats . " · on-chain profile at " . SITE_NAME . ".";
        if (preg_match('/^https?:\/\//i', $u["avatar"])) $image = $u["avatar"];
    } else {
        $desc = "This profile does not exist (yet) on " . SITE_NAME . ".";
    }
} else {
    header("Location: /", true, 302);
    exit;
}

$pageUrl = SITE_ORIGIN . $path;

header("Content-Type: text/html; charset=utf-8");
header("Cache-Control: public, max-age=300");
?>
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title><?= e($title) ?></title>
  <link rel="icon" type="image/png" href="/img/favicon.ico">
  <link rel="canonical" href="<?= e($pageUrl) ?>">
  <meta name="description" content="<?= e($desc) ?>">

  <meta property="og:site_name" content="<?= e(SITE_NAME) ?>">
  <meta property="og:type" content="<?= $userName !== "" ? "profile" : "article" ?>">
  <meta property="og:title" content="<?= e($title) ?>">
  <meta property="og:description" content="<?= e($desc) ?>">
  <meta property="og:url" content="<?= e($pageUrl) ?>">
<?php if ($image !== null): ?>
  <meta property="og:image" content="<?= e($image) ?>">
  <meta name="twitter:image" content="<?= e($image) ?>">
<?php endif; ?>
  <meta name="twitter:card" content="<?= $image !== null ? "summary_large_image" : "summary" ?>">
  <meta name="twitter:title" content="<?= e($title) ?>">
  <meta name="twitter:description" content="<?= e($desc) ?>">
  <meta name="twitter:site" content="@0xFusionLayer">

  <meta http-equiv="refresh" content="0;url=<?= e($app) ?>">
  <script>location.replace(<?= json_encode($app) ?>);</script>
</head>
<body>
  <p><a href="<?= e($app) ?>">Opening <?= e(SITE_NAME) ?>…</a></p>
</body>
</html>
