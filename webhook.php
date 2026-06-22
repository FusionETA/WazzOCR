<?php
/**
 * WazzOCR Webhook Handler v3
 * - Image OCR (jpg/png/gif/webp)
 * - PDF extraction
 * - Smart invoice formatting
 * - AI chat for text messages (Gemini)
 */

// ─── CONFIG ──────────────────────────────────────────────────────────────────
function env_value(string $key, string $default = ''): string
{
    static $env = null;
    if ($env === null) {
        $env = [];
        $envPath = __DIR__ . '/.env';
        if (is_readable($envPath)) {
            foreach (file($envPath, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) as $line) {
                $line = trim($line);
                if ($line === '' || str_starts_with($line, '#') || !str_contains($line, '=')) {
                    continue;
                }
                [$name, $value] = explode('=', $line, 2);
                $env[trim($name)] = trim($value, " \t\n\r\0\x0B\"'");
            }
        }
    }

    $value = getenv($key);
    if ($value !== false && $value !== '') {
        return $value;
    }
    return $env[$key] ?? $default;
}

define('GEMINI_API_KEY',    env_value('GEMINI_API_KEY'));
define('WAZZUP_API_KEY',    env_value('WAZZUP_API_KEY'));
define('WAZZUP_CHANNEL_ID', env_value('WAZZUP_CHANNEL_ID'));
define('WEBHOOK_SECRET',    env_value('WEBHOOK_SECRET'));
define('XERO_BRIDGE_URL',   env_value('XERO_BRIDGE_URL', 'http://localhost:3000/api/whatsapp/analyze-ocr'));
// File → AI pipeline endpoints (added 2026-05-18)
define('XERO_BRIDGE_BASE',  env_value('XERO_BRIDGE_BASE', 'http://localhost:3000'));
define('BRIDGE_PROCESS_URL', XERO_BRIDGE_BASE . '/api/whatsapp/process-file');
define('BRIDGE_CHAT_URL',    XERO_BRIDGE_BASE . '/api/whatsapp/chat');
define('WHATSAPP_AUTO_CREATE_XERO_BILLS', env_value('WHATSAPP_AUTO_CREATE_XERO_BILLS', 'false') === 'true');
define('MAX_FILE_BYTES',    15 * 1024 * 1024); // 15 MB upload limit
define('WEBHOOK_LOG_FILE',  __DIR__ . '/webhook.log');

function wlog(string $msg): void
{
    $line = '[' . date('Y-m-d H:i:s') . '] ' . $msg . PHP_EOL;
    @file_put_contents(WEBHOOK_LOG_FILE, $line, FILE_APPEND | LOCK_EX);
}

// ─── WELCOME MESSAGE ─────────────────────────────────────────────────────────
define('WELCOME_MSG',
"👋 *Welcome to WazzOCR!*\n\n" .
"I'm your AI-powered document assistant. Here's what I can do:\n\n" .
"📸 *Send me an image* of:\n" .
"  • 🪪 ID card / MyKad / Passport\n" .
"  • 🧾 Invoice, receipt or bill\n" .
"  • 🚗 Car plate / number plate\n" .
"  • 📋 Any document or form\n" .
"  • 🏷️ Labels, business cards, signs\n\n" .
"📄 *Send me a PDF* of:\n" .
"  • 🧾 Invoices or purchase orders\n" .
"  • 📑 Contracts or reports\n" .
"  • 📝 Any text document\n\n" .
"💬 *Or just chat with me* — ask me anything!\n\n" .
"_For invoices, I'll automatically detect and format the output with vendor, line items, totals and payment details._\n\n" .
"➡️ *To start: just send any image or PDF now!*"
);

// ─── CAPABILITY MESSAGE ───────────────────────────────────────────────────────
define('CAPABILITY_MSG',
"🤖 *WazzOCR Capabilities*\n\n" .
"*1️⃣ Image OCR*\n" .
"Send any photo and I'll extract all text from it:\n" .
"• ID cards, MyKad, NRIC, passports\n" .
"• Car / vehicle number plates\n" .
"• Invoices, receipts, bills\n" .
"• Forms, labels, business cards\n" .
"• Handwritten or printed text\n" .
"• 100+ languages supported\n\n" .
"*2️⃣ PDF Extraction*\n" .
"Send any PDF document and I'll read all pages:\n" .
"• Multi-page invoices & POs\n" .
"• Contracts & agreements\n" .
"• Reports & statements\n\n" .
"*3️⃣ Smart Invoice Detection*\n" .
"When I detect an invoice or receipt, I auto-structure the output with:\n" .
"• Vendor & buyer details\n" .
"• Line items with quantities & prices\n" .
"• Subtotal, tax & total amount\n" .
"• Payment terms & bank details\n\n" .
"*4️⃣ AI Chat*\n" .
"Ask me anything! I can answer questions, help you understand documents, translate text, and more.\n\n" .
"📤 *Just send an image or PDF to get started!*"
);

// ─── ENTRY POINT ─────────────────────────────────────────────────────────────
header('Content-Type: application/json');

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    exit(json_encode(['error' => 'Method not allowed']));
}

$raw  = file_get_contents('php://input');
$data = json_decode($raw, true);

wlog("WAZZOCR RAW: " . $raw);

if (!$data) {
    http_response_code(400);
    exit(json_encode(['error' => 'Invalid JSON']));
}

if (WEBHOOK_SECRET !== '') {
    $sig      = $_SERVER['HTTP_X_WAZZUP_SIGNATURE'] ?? '';
    $expected = hash_hmac('sha256', $raw, WEBHOOK_SECRET);
    if (!hash_equals($expected, $sig)) {
        http_response_code(401);
        exit(json_encode(['error' => 'Invalid signature']));
    }
}

// Acknowledge immediately
http_response_code(200);
echo json_encode(['status' => 'ok']);

if (function_exists('fastcgi_finish_request')) {
    fastcgi_finish_request();
} else {
    ob_flush();
    flush();
}

wlog("WAZZOCR POST-ACK: alive, about to loop " . count($data['messages'] ?? []) . " messages");
set_error_handler(function($severity, $message, $file, $line) {
    wlog("WAZZOCR PHP-ERR: [$severity] $message in $file:$line");
    return false;
});
register_shutdown_function(function() {
    $e = error_get_last();
    if ($e && in_array($e['type'], [E_ERROR, E_PARSE, E_CORE_ERROR, E_COMPILE_ERROR, E_USER_ERROR])) {
        wlog("WAZZOCR FATAL: {$e['message']} in {$e['file']}:{$e['line']}");
    }
});

// ─── PROCESS MESSAGES ────────────────────────────────────────────────────────
foreach ($data['messages'] ?? [] as $message) {
    process_message($message);
}

// ─── MAIN ROUTER ─────────────────────────────────────────────────────────────

function process_message(array $msg): void
{
    $type     = $msg['type']     ?? '';
    $chatType = $msg['chatType'] ?? 'whatsapp';
    $isEcho   = $msg['isEcho']   ?? false;
    $status   = $msg['status']   ?? '';
    $chatId   = preg_replace('/@[a-z.]+$/i', '', $msg['chatId'] ?? '');

    // Reply on the SAME channel the message arrived on. Wazzup delivers every
    // channel on the account to this one webhook, so without this the reply would
    // always go out on the single env channel (WAZZUP_CHANNEL_ID).
    $inChannel = trim($msg['channelId'] ?? '');
    $GLOBALS['REPLY_CHANNEL'] = $inChannel !== '' ? $inChannel : WAZZUP_CHANNEL_ID;

    wlog("WAZZOCR PROCESS: type=$type chatId=$chatId channel={$GLOBALS['REPLY_CHANNEL']} isEcho=" . ($isEcho ? 'true' : 'false') . " status=$status");

    if ($isEcho === true || $status === 'outbound') {
        wlog("WAZZOCR SKIP: outbound echo.");
        return;
    }

    if (empty($chatId)) {
        wlog("WAZZOCR SKIP: empty chatId.");
        return;
    }

    // ── Route by message type ──────────────────────────────────────────────
    if ($type === 'text') {
        handle_text($chatId, $chatType, $msg);
        return;
    }

    if (in_array($type, ['image', 'document'], true)) {
        handle_file($chatId, $chatType, $msg, $type);
        return;
    }

    // Unsupported type — guide user
    if (in_array($type, ['audio', 'video', 'sticker', 'location', 'contact'], true)) {
        wazzup_send($chatId, $chatType,
            "⚠️ I received a *{$type}* message, but I can only process:\n\n" .
            "📸 *Images* — photos of documents, IDs, invoices\n" .
            "📄 *PDFs* — invoice files, reports\n" .
            "💬 *Text* — chat or ask me anything\n\n" .
            "Please send an image or PDF to extract text."
        );
    }
}

// ─── TEXT MESSAGE HANDLER ────────────────────────────────────────────────────

function handle_text(string $chatId, string $chatType, array $msg): void
{
    $text = trim($msg['text'] ?? $msg['body'] ?? '');

    if ($text === '') return;

    wlog("WAZZOCR TEXT: chatId=$chatId text=" . substr($text, 0, 100));

    // ── Local keyword shortcuts (cheap, no bridge call) ───────────────────
    $lower = mb_strtolower($text);

    // Greetings → welcome message
    $greetings = ['hi', 'hello', 'hey', 'halo', 'hai', 'start', 'helo', 'yo'];
    foreach ($greetings as $g) {
        if ($lower === $g || str_starts_with($lower, $g . ' ') || str_starts_with($lower, $g . ',')) {
            wazzup_send($chatId, $chatType, WELCOME_MSG);
            return;
        }
    }

    // ── Everything else → bridge (handles picker reply, commands, Groq chat)
    $reply = forward_text_to_bridge($chatId, $text);

    if ($reply === null) {
        wazzup_send($chatId, $chatType,
            "❌ Sorry, I had trouble processing your message. Please try again.\n\n" .
            "Or send me an image or PDF to extract text from!"
        );
        return;
    }

    wazzup_send($chatId, $chatType, $reply);
}

// Forward a text message to server.js — it decides if it's a picker reply,
// a command (orgs/pending/help), or a general Groq chat.
function forward_text_to_bridge(string $chatId, string $text): ?string
{
    // Pass the inbound channelId so the bridge resolves the account and runs the
    // picker / draft creation against THAT account's Xero connections.
    $payload = ['chatId' => $chatId, 'text' => $text, 'channelId' => $GLOBALS['REPLY_CHANNEL'] ?? WAZZUP_CHANNEL_ID];

    $ch = curl_init(BRIDGE_CHAT_URL);
    curl_setopt_array($ch, [
        CURLOPT_POST           => true,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_HTTPHEADER     => ['Content-Type: application/json'],
        CURLOPT_POSTFIELDS     => json_encode($payload),
        CURLOPT_TIMEOUT        => 45,
    ]);
    $response = curl_exec($ch);
    $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $curlErr  = curl_error($ch);
    curl_close($ch);

    if ($curlErr || $httpCode < 200 || $httpCode >= 300) {
        wlog("WAZZOCR BRIDGE CHAT ERROR: http=$httpCode err=$curlErr resp=" . substr((string)$response, 0, 300));
        return null;
    }
    $data = json_decode($response, true);
    return $data['reply'] ?? null;
}

// ─── FILE HANDLER (IMAGE / PDF) ───────────────────────────────────────────────

function handle_file(string $chatId, string $chatType, array $msg, string $type): void
{
    $fileUrl  = $msg['contentUri'] ?? ($msg['media']['url'] ?? '') ?? '';
    $filename = $msg['text'] ?? $msg['fileName'] ?? $msg['media']['filename'] ?? '';

    wlog("WAZZOCR FILE: url=$fileUrl filename=$filename");

    if (empty($fileUrl)) {
        wazzup_send($chatId, $chatType, "⚠️ Received your file but couldn't get the download URL. Please try again.");
        return;
    }

    $isPdf     = ($type === 'document') || str_ends_with_ci($filename, '.pdf');
    $typeLabel = $isPdf ? 'PDF' : 'image';

    wazzup_send($chatId, $chatType, "🔍 Reading your {$typeLabel}...");

    wlog("WAZZOCR DOWNLOAD: starting — $fileUrl");
    $file = download_file($fileUrl);

    if ($file === null) {
        wlog("WAZZOCR ERROR: download failed for $fileUrl");
        wazzup_send($chatId, $chatType, "❌ Could not download the file. Please try again.");
        return;
    }

    wlog("WAZZOCR DOWNLOAD OK: mime={$file['mime']} size=" . strlen($file['bytes']) . " bytes");

    if (strlen($file['bytes']) > MAX_FILE_BYTES) {
        wazzup_send($chatId, $chatType, "⚠️ File too large (max 15MB). Please send a smaller file.");
        return;
    }

    if ($isPdf) {
        $file['mime'] = 'application/pdf';
    }

    // Pipeline: send the raw file to server.js → extract/Gemini-vision → AI → match
    wlog("WAZZOCR BRIDGE PROCESS: posting file to " . BRIDGE_PROCESS_URL);
    $channelId = $msg['channelId'] ?? '';
    $result = process_file_via_bridge($chatId, $file, $filename, $channelId);

    if ($result === null) {
        wazzup_send($chatId, $chatType,
            "❌ Sorry, I had trouble reading the {$typeLabel}. Please try again.\n\n" .
            "_(The OCR server may be down or busy.)_"
        );
        return;
    }

    if (!empty($result['error'])) {
        wazzup_send($chatId, $chatType, "❌ {$result['error']}");
        return;
    }

    $status = $result['status'] ?? 'unknown';

    if ($status === 'empty') {
        wazzup_send($chatId, $chatType, "📄 I couldn't find any text in this {$typeLabel}.");
        return;
    }

    $output = format_bridge_outcome($result);

    // If pending → also send picker
    if ($status === 'pending' && !empty($result['candidates'])) {
        wazzup_send($chatId, $chatType, $output);
        send_org_picker($chatId, $chatType, $result['candidates'], $result['bill']['billedTo'] ?? '');
        return;
    }

    wazzup_send($chatId, $chatType, $output);
}

// POSTs the binary file to server.js as JSON (base64) along with chatId,
// so the bridge can remember "this chat is awaiting picker reply" if needed.
function process_file_via_bridge(string $chatId, array $file, string $filename = '', string $channelId = ''): ?array
{
    $payload = [
        'chatId'     => $chatId,
        'channelId'  => $channelId,   // lets the bridge route to the right account
        'fileBase64' => base64_encode($file['bytes']),
        'mime'       => $file['mime'],
        'fileName'   => $filename,
    ];

    $ch = curl_init(BRIDGE_PROCESS_URL);
    curl_setopt_array($ch, [
        CURLOPT_POST           => true,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_HTTPHEADER     => ['Content-Type: application/json'],
        CURLOPT_POSTFIELDS     => json_encode($payload),
        CURLOPT_TIMEOUT        => 180, // vision/multi-page PDFs can be slow
    ]);
    $response = curl_exec($ch);
    $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $curlErr  = curl_error($ch);
    curl_close($ch);

    if ($curlErr) {
        wlog("WAZZOCR BRIDGE PROCESS CURL ERROR: $curlErr");
        return null;
    }
    if ($httpCode < 200 || $httpCode >= 300) {
        $data = json_decode((string)$response, true);
        wlog("WAZZOCR BRIDGE PROCESS HTTP $httpCode: " . substr((string)$response, 0, 400));
        return ['error' => $data['error'] ?? "Bridge server returned HTTP {$httpCode}"];
    }
    $data = json_decode((string)$response, true);
    if (!is_array($data)) {
        return ['error' => 'Bridge server returned an invalid response.'];
    }
    return $data;
}

// Format the response from /api/whatsapp/process-file into a WhatsApp message.
function format_bridge_outcome(array $result): string
{
    if (!empty($result['outcomes']) && is_array($result['outcomes']) && count($result['outcomes']) > 1) {
        $lines = [
            "🤖 *AI bill analysis*",
            "Detected " . count($result['outcomes']) . " separate bills in this file.",
        ];
        foreach ($result['outcomes'] as $index => $outcome) {
            if (!is_array($outcome)) continue;
            $bill = $outcome['bill'] ?? [];
            if (!is_array($bill)) $bill = [];
            $xero = $outcome['xero'] ?? null;
            $pending = $outcome['pending'] ?? null;
            $status = $outcome['status'] ?? '';
            $lines[] = "";
            $lines[] = "*Bill " . ($index + 1) . "/" . count($result['outcomes']) . "*";
            $lines[] = "Supplier: " . ($bill['supplier'] ?? 'Unknown');
            $lines[] = "Bill To: " . ($bill['billedTo'] ?? '-');
            $lines[] = "Invoice No: " . ($bill['invoiceNo'] ?? '-');
            $lines[] = "Tax: " . format_money_value($bill['tax'] ?? 0);
            $lines[] = "*Total: " . format_money_value($bill['total'] ?? 0) . "*";
            if ($status === 'created' && is_array($xero) && !empty($xero['invoiceId'])) {
                $orgName = $xero['tenantName'] ?? 'Xero';
                $lines[] = "✅ Created in " . $orgName;
                $lines[] = "View: https://go.xero.com/AccountsPayable/View.aspx?InvoiceID=" . $xero['invoiceId'];
            } elseif ($status === 'pending' && is_array($pending)) {
                $lines[] = "⚠️ Pending: " . ($pending['reason'] ?? 'Organisation assignment needed.');
            } elseif ($status === 'xero-error') {
                $lines[] = "❌ Xero rejected: " . ($outcome['xeroError'] ?? 'Unknown error');
            }
        }
        return implode("\n", $lines);
    }

    $bill = $result['bill'] ?? [];
    if (!is_array($bill)) $bill = [];

    // Surface which extraction path was used (helps debug bad invoices)
    $extractedBy = '';
    switch ($result['extractionMethod'] ?? '') {
        case 'pdf-text':       $extractedBy = "_(extracted via PDF text — exact)_"; break;
        case 'gemini-vision':  $extractedBy = "_(read directly by Gemini vision)_"; break;
    }

    $lines = ["🤖 *AI bill analysis*"];
    if ($extractedBy !== '') $lines[] = $extractedBy;
    $lines = array_merge($lines, [
        "Supplier: " . ($bill['supplier'] ?? 'Unknown'),
        "Bill To: " . ($bill['billedTo'] ?? '-'),
    ]);

    // Show the original BILL TO text from the invoice when it differs from
    // the AI's mapped Xero org name (helps spot wrong mappings).
    if (!empty($bill['billedToVerbatim']) && $bill['billedToVerbatim'] !== ($bill['billedTo'] ?? '')) {
        $lines[] = "  _(invoice said: " . $bill['billedToVerbatim'] . ")_";
    }

    $lines = array_merge($lines, [
        "Invoice No: " . ($bill['invoiceNo'] ?? '-'),
        "Date: " . ($bill['date'] ?? '-'),
        "Currency: " . ($bill['currency'] ?? 'MYR'),
        "Subtotal: " . format_money_value($bill['subtotal'] ?? 0),
        "Tax: " . format_money_value($bill['tax'] ?? 0),
        "*Total: " . format_money_value($bill['total'] ?? 0) . "*",
    ]);

    if (!empty($bill['lineItems']) && is_array($bill['lineItems'])) {
        $lines[] = "";
        $lines[] = "*Line items*";
        foreach (array_slice($bill['lineItems'], 0, 20) as $index => $item) {
            $description = $item['description'] ?? ('Item ' . ($index + 1));
            $amount = format_money_value($item['amount'] ?? 0);
            $lines[] = ($index + 1) . ". {$description} — {$amount}";
        }
    }

    $status = $result['status'] ?? '';
    $matched = $result['matchedTenant'] ?? null;
    $xero    = $result['xero'] ?? null;
    $pending = $result['pending'] ?? null;

    if ($status === 'created' && is_array($xero) && !empty($xero['invoiceId'])) {
        $lines[] = "";
        $lines[] = "✅ *Xero draft bill created*";
        $orgName = $xero['tenantName'] ?? ($matched['tenantName'] ?? 'Xero');
        $lines[] = "Organisation: " . $orgName;
        if (!empty($xero['contactName'])) {
            $lines[] = "Supplier: " . $xero['contactName'];
        }
        $lines[] = "Invoice: " . ($xero['invoiceNumber'] ?? $xero['invoiceId']);
        if (isset($xero['total']) && $xero['total'] !== null) {
            $currency = $xero['currency'] ?? '';
            $lines[] = "Total: " . trim($currency . ' ' . format_money_value($xero['total']));
        }
        $lines[] = "Status: " . ($xero['status'] ?? 'DRAFT');
        $lines[] = "View: https://go.xero.com/AccountsPayable/View.aspx?InvoiceID=" . $xero['invoiceId'];
    } elseif ($status === 'pending' && is_array($pending)) {
        $lines[] = "";
        $lines[] = "⚠️ *Action needed: pick the organisation*";
        $lines[] = $pending['reason'] ?? 'Could not match this bill to any connected Xero organisation.';
    } elseif ($status === 'xero-error') {
        // AI matched the org confidently — Xero rejected the bill DATA.
        // No picker (picking another org won't help); user fixes from dashboard.
        $orgName = $matched['tenantName'] ?? 'the matched organisation';
        $lines[] = "";
        $lines[] = "❌ *Xero rejected this bill*";
        $lines[] = "Matched org: " . $orgName . " (AI was confident — not an org problem)";
        if (!empty($result['xeroError'])) {
            $lines[] = "Reason: " . $result['xeroError'];
        }
        $lines[] = "";
        $lines[] = "_The bill is in *Pending* — fix it from the dashboard, or send a corrected file._";
    } elseif ($status === 'no-xero') {
        $lines[] = "";
        $lines[] = "⚠️ Xero is not connected yet. Open the dashboard to connect.";
    }

    return implode("\n", $lines);
}

// Send a numbered org-picker over WhatsApp. The user replies with a number;
// /api/whatsapp/chat picks that up via the stored picker state.
//
// TODO(interactive-buttons): Wazzup24 docs are gated; once the exact JSON
// schema for WhatsApp interactive buttons is confirmed, swap the text body
// below for wazzup_send_buttons() — webhook.php will still see the reply as
// regular text, so the resolver stays unchanged.
function send_org_picker(string $chatId, string $chatType, array $candidates, string $billedTo = ''): void
{
    $lines = [];
    $lines[] = "👉 *Which Xero organisation should this go to?*";
    if ($billedTo !== '') {
        $lines[] = "Bill says: _" . $billedTo . "_";
    }
    $lines[] = "";
    foreach ($candidates as $i => $c) {
        $name = $c['tenantName'] ?? '(unnamed)';
        $lines[] = ($i + 1) . ". " . $name;
    }
    $lines[] = "";
    $lines[] = "_Reply with the number (e.g. *1*), or type *cancel* to skip._";

    wazzup_send($chatId, $chatType, implode("\n", $lines));
}

// ─── GEMINI: AI CHAT ─────────────────────────────────────────────────────────

function gemini_chat(string $userText): ?string
{
    $systemPrompt = <<<'PROMPT'
You are WazzOCR, a friendly and helpful AI assistant for FusionETA, a Malaysian technology company.

Your primary specialties are:
1. Reading and extracting text from images (ID cards, passports, invoices, car plates, forms)
2. Extracting text from PDF documents
3. Automatically detecting and structuring invoice data
4. Answering questions about documents and business processes

Personality:
- Friendly, professional, and concise
- You support English, Malay (Bahasa Malaysia), and Chinese
- Keep answers brief and practical — this is a WhatsApp chat
- When relevant, remind users they can send images or PDFs for OCR extraction
- Do not answer questions unrelated to business, documents, or general knowledge

If asked who you are: "I'm WazzOCR, an AI document assistant by FusionETA. I extract text from images and PDFs, and I can chat too!"

Always respond in the same language the user is writing in.
PROMPT;

    $payload = [
        'system_instruction' => [
            'parts' => [['text' => $systemPrompt]],
        ],
        'contents' => [[
            'role'  => 'user',
            'parts' => [['text' => $userText]],
        ]],
        'generationConfig' => [
            'maxOutputTokens' => 800,
            'temperature'     => 0.7,
        ],
    ];

    $url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=' . GEMINI_API_KEY;

    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_POST           => true,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_HTTPHEADER     => ['Content-Type: application/json'],
        CURLOPT_POSTFIELDS     => json_encode($payload),
        CURLOPT_TIMEOUT        => 30,
    ]);

    $response = curl_exec($ch);
    $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $curlErr  = curl_error($ch);
    curl_close($ch);

    if ($curlErr || $httpCode !== 200) {
        wlog("WAZZOCR CHAT ERROR: http=$httpCode curlErr=$curlErr resp=" . substr($response, 0, 300));
        return null;
    }

    $result = json_decode($response, true);
    $text   = $result['candidates'][0]['content']['parts'][0]['text'] ?? '';

    return trim($text) !== '' ? $text : null;
}

// ─── GEMINI: FILE OCR ─────────────────────────────────────────────────────────

function call_gemini_with_file(array $file): ?array
{
    $payload = [
        'contents' => [[
            'parts' => [
                ['inline_data' => [
                    'mime_type' => $file['mime'],
                    'data'      => base64_encode($file['bytes']),
                ]],
                ['text' => build_ocr_prompt()],
            ],
        ]],
        'generationConfig' => [
            'maxOutputTokens' => 4096,
            'temperature'     => 0.1,
        ],
    ];

    $url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=' . GEMINI_API_KEY;

    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_POST           => true,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_HTTPHEADER     => ['Content-Type: application/json'],
        CURLOPT_POSTFIELDS     => json_encode($payload),
        CURLOPT_TIMEOUT        => 90,
    ]);

    $response = curl_exec($ch);
    $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $curlErr  = curl_error($ch);
    curl_close($ch);

    if ($curlErr) {
        wlog("WAZZOCR GEMINI CURL ERROR: $curlErr");
        return null;
    }

    if ($httpCode !== 200) {
        wlog("WAZZOCR GEMINI HTTP ERROR: $httpCode — " . substr($response, 0, 500));
        return null;
    }

    $result = json_decode($response, true);
    $text   = $result['candidates'][0]['content']['parts'][0]['text'] ?? '';

    if (trim($text) === '') {
        wlog("WAZZOCR GEMINI EMPTY: " . substr($response, 0, 1000));
        return ['text' => '', 'output' => ''];
    }

    $isInvoice = stripos($text, 'INVOICE DETECTED') !== false;
    $header    = $isInvoice ? "📋 *Invoice extracted:*\n\n" : "📝 *Extracted text:*\n\n";

    return ['text' => $text, 'output' => $header . $text];
}

// ─── LOCAL XERO / AI BRIDGE ─────────────────────────────────────────────────

function analyze_with_xero_bridge(string $ocrText, ?string $fileBytes = null, ?string $mime = null, ?string $filename = null): ?array
{
    if (XERO_BRIDGE_URL === '' || trim($ocrText) === '') {
        return null;
    }

    $payload = [
        'text'       => $ocrText,
        'createBill' => WHATSAPP_AUTO_CREATE_XERO_BILLS,
    ];

    if ($fileBytes !== null && $fileBytes !== '') {
        $payload['imageBase64'] = base64_encode($fileBytes);
        $payload['imageMime']   = $mime ?: 'application/octet-stream';
        if ($filename) {
            $payload['fileName'] = $filename;
        }
    }

    $ch = curl_init(XERO_BRIDGE_URL);
    curl_setopt_array($ch, [
        CURLOPT_POST           => true,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_HTTPHEADER     => ['Content-Type: application/json'],
        CURLOPT_POSTFIELDS     => json_encode($payload),
        CURLOPT_TIMEOUT        => 90,
    ]);

    $response = curl_exec($ch);
    $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $curlErr  = curl_error($ch);
    curl_close($ch);

    if ($curlErr || !$response) {
        wlog("WAZZOCR XERO BRIDGE SKIP: http=$httpCode curlErr=$curlErr response=" . substr((string)$response, 0, 300));
        return [
            'ok'    => false,
            'error' => $curlErr ? "Could not reach the local AI/Xero server: {$curlErr}" : 'No response from local AI/Xero server.',
        ];
    }

    $data = json_decode($response, true);
    if (!is_array($data)) {
        return [
            'ok'    => false,
            'error' => 'Local AI/Xero server returned an invalid response.',
        ];
    }

    if ($httpCode < 200 || $httpCode >= 300) {
        return [
            'ok'    => false,
            'error' => $data['error'] ?? ('Local AI/Xero server failed with HTTP ' . $httpCode),
        ];
    }

    return $data;
}

function format_bridge_analysis(array $analysis): string
{
    $bill = $analysis['bill'] ?? [];
    if (!is_array($bill) || !$bill) {
        return '';
    }

    $lines = [
        "🤖 *AI bill analysis*",
        "Supplier: " . ($bill['supplier'] ?? 'Unknown'),
        "Bill To: " . ($bill['billedTo'] ?? '-'),
        "Invoice No: " . ($bill['invoiceNo'] ?? '-'),
        "Date: " . ($bill['date'] ?? '-'),
        "Currency: " . ($bill['currency'] ?? 'MYR'),
        "Subtotal: " . format_money_value($bill['subtotal'] ?? 0),
        "Tax: " . format_money_value($bill['tax'] ?? 0),
        "*Total: " . format_money_value($bill['total'] ?? 0) . "*",
    ];

    if (!empty($bill['lineItems']) && is_array($bill['lineItems'])) {
        $lines[] = "";
        $lines[] = "*Line items*";
        foreach (array_slice($bill['lineItems'], 0, 20) as $index => $item) {
            $description = $item['description'] ?? ('Item ' . ($index + 1));
            $amount = format_money_value($item['amount'] ?? 0);
            $lines[] = ($index + 1) . ". {$description} — {$amount}";
        }
    }

    $matched = $analysis['matchedTenant'] ?? null;
    $xero    = $analysis['xero'] ?? null;
    $pending = $analysis['pending'] ?? null;

    if (is_array($xero) && !empty($xero['invoiceId'])) {
        $lines[] = "";
        $lines[] = "✅ *Xero draft bill created*";
        $orgName = $xero['tenantName'] ?? ($matched['tenantName'] ?? 'Xero');
        $lines[] = "Organisation: " . $orgName;
        if (!empty($xero['contactName'])) {
            $lines[] = "Supplier: " . $xero['contactName'];
        }
        $lines[] = "Invoice: " . ($xero['invoiceNumber'] ?? $xero['invoiceId']);
        if (isset($xero['total']) && $xero['total'] !== null) {
            $currency = $xero['currency'] ?? '';
            $lines[] = "Total: " . trim($currency . ' ' . format_money_value($xero['total']));
        }
        $lines[] = "Status: " . ($xero['status'] ?? 'DRAFT');
        $lines[] = "View: https://go.xero.com/AccountsPayable/View.aspx?InvoiceID=" . $xero['invoiceId'];
    } elseif (is_array($pending)) {
        $lines[] = "";
        $lines[] = "⚠️ *Action needed: assign organisation*";
        $lines[] = $pending['reason'] ?? 'Could not match this bill to any connected Xero organisation.';
        if (!empty($pending['candidates']) && is_array($pending['candidates'])) {
            $names = array_map(fn($c) => $c['tenantName'] ?? '', $pending['candidates']);
            $names = array_filter($names);
            if ($names) {
                $lines[] = "Connected orgs: " . implode(', ', $names);
            }
        }
        $lines[] = "Open the dashboard → *Unmatched Bills* to pick the right organisation and create the draft.";
    } elseif (WHATSAPP_AUTO_CREATE_XERO_BILLS) {
        $lines[] = "";
        $lines[] = "⚠️ Xero draft creation was requested but no bill was returned.";
    }

    return implode("\n", $lines);
}

function format_money_value($value): string
{
    return number_format((float)$value, 2, '.', ',');
}

// ─── OCR PROMPT ──────────────────────────────────────────────────────────────

function build_ocr_prompt(): string
{
    return <<<'PROMPT'
You are an OCR and document intelligence assistant.

Step 1 — Extract ALL text from this document or image exactly as it appears.

Step 2 — Determine if this is an INVOICE, RECEIPT, BILL, PURCHASE ORDER, or CREDIT NOTE.
Indicators: invoice number, date, vendor name, buyer name, line items with quantities and prices, subtotal, tax, total amount.

Step 3a — If it IS an invoice/receipt/bill, return this EXACT structured format:

📋 INVOICE DETECTED
━━━━━━━━━━━━━━━━━━━━━━
🏢 VENDOR
Name: [vendor/company name]
Address: [address]
Tel: [phone]
Email: [email]
Reg No: [company reg if present]
━━━━━━━━━━━━━━━━━━━━━━
📄 INVOICE DETAILS
Invoice No: [number]
Date: [date]
Due Date: [due date]
PO No: [PO number if present]
━━━━━━━━━━━━━━━━━━━━━━
👤 BILL TO
Name: [customer name]
Address: [customer address]
━━━━━━━━━━━━━━━━━━━━━━
🛒 LINE ITEMS
[No.] [Description] | Qty: [qty] | Unit: [price] | Total: [amount]
[repeat for each line item]
━━━━━━━━━━━━━━━━━━━━━━
💰 SUMMARY
Subtotal: [amount]
Discount: [if present]
Tax/GST/SST: [amount]
*TOTAL DUE: [total]*
Currency: [currency]
━━━━━━━━━━━━━━━━━━━━━━
📝 NOTES
[payment terms, bank details, account number, any other info]

Omit any field not present in the document.

Step 3b — If it is NOT an invoice, return the extracted text exactly as it appears, preserving line breaks. No extra formatting.
PROMPT;
}

// ─── DOWNLOAD FILE ────────────────────────────────────────────────────────────

function normalize_download_url(string $url): string
{
    $url = trim($url);

    // Wazzup sometimes sends contentUri filename query values with raw spaces.
    // Curl rejects those before it can make the request, so encode only unsafe
    // URL characters while leaving existing reserved characters and % escapes.
    return preg_replace_callback(
        '/[^\w\-\.~:\/?#\[\]@!$&\'()*+,;=%]/u',
        fn(array $match): string => rawurlencode($match[0]),
        $url
    ) ?? $url;
}

function download_file(string $url): ?array
{
    $url = normalize_download_url($url);

    // Wazzup contentUri files can be briefly unavailable while media is being prepared.
    for ($attempt = 1; $attempt <= 5; $attempt++) {
        // Try with auth first, then without (Wazzup CDN URLs vary).
        foreach ([true, false] as $withAuth) {
            $headers = [
                'Accept: application/pdf,image/*,*/*',
                'User-Agent: WazzOCR/3.0',
            ];
            if ($withAuth) {
                array_unshift($headers, 'Authorization: Bearer ' . WAZZUP_API_KEY);
            }

            $ch = curl_init($url);
            curl_setopt_array($ch, [
                CURLOPT_RETURNTRANSFER => true,
                CURLOPT_FOLLOWLOCATION => true,
                CURLOPT_MAXREDIRS      => 5,
                CURLOPT_CONNECTTIMEOUT => 10,
                CURLOPT_TIMEOUT        => 45,
                CURLOPT_HTTPHEADER     => $headers,
            ]);

            $bytes        = curl_exec($ch);
            $httpCode     = curl_getinfo($ch, CURLINFO_HTTP_CODE);
            $mime         = curl_getinfo($ch, CURLINFO_CONTENT_TYPE);
            $effectiveUrl = curl_getinfo($ch, CURLINFO_EFFECTIVE_URL);
            $curlErr      = curl_error($ch);

            $byteCount = is_string($bytes) ? strlen($bytes) : 0;
            wlog(
                "WAZZOCR DOWNLOAD attempt=$attempt " . ($withAuth ? 'WITH' : 'WITHOUT') .
                " AUTH: http=$httpCode mime=$mime bytes=$byteCount err=$curlErr effective=$effectiveUrl"
            );

            if (!$curlErr && $httpCode >= 200 && $httpCode < 300 && is_string($bytes) && $byteCount > 0) {
                // Normalise MIME.
                $mime = strtok($mime ?: '', ';') ?: '';
                $mimeMap = [
                    'image/jpeg'      => 'image/jpeg',
                    'image/jpg'       => 'image/jpeg',
                    'image/png'       => 'image/png',
                    'image/gif'       => 'image/gif',
                    'image/webp'      => 'image/webp',
                    'application/pdf' => 'application/pdf',
                ];
                if (isset($mimeMap[$mime])) {
                    $mime = $mimeMap[$mime];
                } elseif (substr($bytes, 0, 4) === '%PDF') {
                    $mime = 'application/pdf';
                } else {
                    $mime = 'image/jpeg';
                }
                return ['bytes' => $bytes, 'mime' => $mime];
            }

            if (is_string($bytes) && $byteCount > 0 && $byteCount < 1000) {
                wlog("WAZZOCR DOWNLOAD BODY sample: " . substr(str_replace(["\r", "\n"], ' ', $bytes), 0, 300));
            }
        }

        if ($attempt < 5) {
            sleep($attempt);
        }
    }

    wlog("WAZZOCR DOWNLOAD FAILED: both attempts failed for $url");
    return null;
}

// ─── SEND MESSAGE ─────────────────────────────────────────────────────────────

function wazzup_send(string $chatId, string $chatType, string $text): void
{
    // Always reply on the channel the message arrived on (set per message in
    // process_message). Sending is routed through the Node bridge so it can use
    // the channel's own API key from the DB; if the bridge is unreachable we
    // fall back to a direct Wazzup call with the env key.
    $channelId = $GLOBALS['REPLY_CHANNEL'] ?? WAZZUP_CHANNEL_ID;
    $chunks = split_message($text, 4000);
    wlog("WAZZOCR SEND START: chatId=$chatId channel=$channelId chunks=" . count($chunks));

    foreach ($chunks as $i => $chunk) {
        $ok = bridge_send($channelId, $chatId, $chatType, $chunk)
           || wazzup_send_direct($channelId, $chatId, $chatType, $chunk);
        wlog(($ok ? "WAZZOCR SEND OK" : "WAZZOCR SEND ERROR") . ": chunk $i to $chatId on $channelId");
        if (count($chunks) > 1) {
            usleep(400000);
        }
    }
}

// Preferred path: let the Node bridge send using the channel's own API key.
function bridge_send(string $channelId, string $chatId, string $chatType, string $text): bool
{
    $ch = curl_init(XERO_BRIDGE_BASE . '/api/whatsapp/send');
    curl_setopt_array($ch, [
        CURLOPT_POST           => true,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_HTTPHEADER     => ['Content-Type: application/json'],
        CURLOPT_POSTFIELDS     => json_encode([
            'channelId' => $channelId, 'chatId' => $chatId,
            'chatType'  => $chatType,  'text'   => $text,
        ]),
        CURLOPT_TIMEOUT => 20,
    ]);
    $resp = curl_exec($ch);
    $code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);
    if ($code < 200 || $code >= 300) {
        wlog("WAZZOCR BRIDGE SEND MISS: HTTP $code — " . substr((string) $resp, 0, 200));
        return false;
    }
    return true;
}

// Fallback: send directly to Wazzup with the env key (works when the channel is
// under the same Wazzup account as WAZZUP_API_KEY).
function wazzup_send_direct(string $channelId, string $chatId, string $chatType, string $text): bool
{
    $ch = curl_init('https://api.wazzup24.com/v3/message');
    curl_setopt_array($ch, [
        CURLOPT_POST           => true,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_HTTPHEADER     => [
            'Content-Type: application/json',
            'Authorization: Bearer ' . WAZZUP_API_KEY,
        ],
        CURLOPT_POSTFIELDS => json_encode([
            'channelId' => $channelId, 'chatId' => $chatId,
            'chatType'  => $chatType,  'text'   => $text,
        ]),
        CURLOPT_TIMEOUT => 15,
    ]);
    $resp = curl_exec($ch);
    $code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);
    if ($code < 200 || $code >= 300) {
        wlog("WAZZOCR DIRECT SEND ERR: HTTP $code — " . substr((string) $resp, 0, 200));
        return false;
    }
    return true;
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function split_message(string $text, int $maxLen): array
{
    $chunks = [];
    while (mb_strlen($text) > $maxLen) {
        $slice   = mb_substr($text, 0, $maxLen);
        $lastNl  = mb_strrpos($slice, "\n");
        $splitAt = ($lastNl !== false && $lastNl > $maxLen * 0.5) ? $lastNl : $maxLen;
        $chunks[] = mb_substr($text, 0, $splitAt);
        $text     = ltrim(mb_substr($text, $splitAt), "\n");
    }
    if ($text !== '') {
        $chunks[] = $text;
    }
    return $chunks ?: [$text];
}

function str_ends_with_ci(string $haystack, string $needle): bool
{
    return strcasecmp(substr($haystack, -strlen($needle)), $needle) === 0;
}
