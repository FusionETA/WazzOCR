// Register Wazzup24 webhook URL
// Run: node register-webhook.js
// Reads WAZZUP_API_KEY and PUBLIC_WEBHOOK_URL from .env

require('dotenv').config({ path: __dirname + '/.env' });

const apiKey     = process.env.WAZZUP_API_KEY;
const webhookUrl = process.env.PUBLIC_WEBHOOK_URL;

if (!apiKey)     { console.error('Missing WAZZUP_API_KEY in .env');     process.exit(1); }
if (!webhookUrl) { console.error('Missing PUBLIC_WEBHOOK_URL in .env'); process.exit(1); }

(async () => {
  const res = await fetch('https://api.wazzup24.com/v3/webhooks', {
    method: 'PATCH',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({
      webhooksUri:   webhookUrl,
      subscriptions: { messagesAndStatuses: true },
    }),
  });

  const body = await res.text();
  console.log(`HTTP ${res.status}`);
  console.log(`Webhook URL set to: ${webhookUrl}`);
  console.log('Response body:', body || '(empty)');
  process.exit(res.ok ? 0 : 1);
})();
