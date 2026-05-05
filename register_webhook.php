<?php
/**
 * One-time Wazzup24 webhook registration
 * Upload to your server, visit it once in browser, then delete it.
 */

function env_value(string $key, string $default = ''): string
{
    $envPath = __DIR__ . '/.env';
    if (is_readable($envPath)) {
        foreach (file($envPath, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) as $line) {
            $line = trim($line);
            if ($line === '' || str_starts_with($line, '#') || !str_contains($line, '=')) {
                continue;
            }
            [$name, $value] = explode('=', $line, 2);
            if (trim($name) === $key) {
                return trim($value, " \t\n\r\0\x0B\"'");
            }
        }
    }

    $value = getenv($key);
    return ($value !== false && $value !== '') ? $value : $default;
}

$apiKey     = env_value('WAZZUP_API_KEY');
$webhookUrl = env_value('PUBLIC_WEBHOOK_URL', 'https://fusioneta.com.my/app/ocr/webhook.php');

$payload = json_encode([
    'webhooksUri'   => $webhookUrl,
    'subscriptions' => ['messagesAndStatuses' => true],
]);

$ch = curl_init('https://api.wazzup24.com/v3/webhooks');
curl_setopt_array($ch, [
    CURLOPT_CUSTOMREQUEST  => 'PATCH',
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_HTTPHEADER     => [
        'Authorization: Bearer ' . $apiKey,
        'Content-Type: application/json',
    ],
    CURLOPT_POSTFIELDS     => $payload,
    CURLOPT_TIMEOUT        => 15,
]);

$response = curl_exec($ch);
$httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
curl_close($ch);

$result = json_decode($response, true);
$ok     = ($httpCode >= 200 && $httpCode < 300);
?>
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Wazzup Webhook Registration</title>
  <style>
    body { font-family: monospace; padding: 40px; background: #0d0f12; color: #e2e8f0; }
    .box { background: #1a1e26; border: 1px solid #272c38; border-radius: 10px; padding: 24px; max-width: 600px; }
    .ok  { color: #25d366; }
    .err { color: #fc8181; }
    pre  { background: #0a0c0f; padding: 16px; border-radius: 8px; overflow-x: auto; font-size: 13px; color: #a0aec0; }
    h2   { margin-top: 0; }
  </style>
</head>
<body>
<div class="box">
  <h2 class="<?= $ok ? 'ok' : 'err' ?>">
    <?= $ok ? '✓ Webhook registered successfully' : '✗ Registration failed (HTTP ' . $httpCode . ')' ?>
  </h2>
  <p>Webhook URL: <strong><?= htmlspecialchars($webhookUrl) ?></strong></p>
  <p>HTTP Status: <strong><?= $httpCode ?></strong></p>
  <p>Response:</p>
  <pre><?= htmlspecialchars(json_encode($result, JSON_PRETTY_PRINT)) ?></pre>
  <?php if ($ok): ?>
  <p class="ok">✓ Wazzup will now POST incoming messages to your webhook.php</p>
  <p style="color:#718096">You can now delete this file from your server.</p>
  <?php endif; ?>
</div>
</body>
</html>
