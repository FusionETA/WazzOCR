// Wazzup24 message sender. Mirrors the existing webhook.php call:
//   POST https://api.wazzup24.com/v3/message
//   Authorization: Bearer <apiKey>
//   { channelId, chatId, chatType: 'whatsapp', text }
//
// The "system" channel (FusionETA's own number) is used for outbound admin
// messages like invites and password resets. It falls back to the existing
// WAZZUP_* env vars if the FUSION_* ones are not set.

const WAZZUP_ENDPOINT = 'https://api.wazzup24.com/v3/message';

function systemCreds() {
  const channelId = process.env.FUSION_WAZZUP_CHANNEL_ID || process.env.WAZZUP_CHANNEL_ID || '';
  const apiKey = process.env.FUSION_WAZZUP_API_KEY || process.env.WAZZUP_API_KEY || '';
  return { channelId, apiKey };
}

// Sends one WhatsApp text. Returns true on 2xx. Never throws on HTTP errors
// (returns false and logs), so callers can decide how to handle a failed send.
async function sendMessage({ channelId, apiKey, chatId, text, chatType = 'whatsapp' }) {
  if (!channelId || !apiKey) {
    console.error('[wazzup] missing channelId/apiKey — cannot send.');
    return false;
  }
  if (!chatId) {
    console.error('[wazzup] missing chatId (phone) — cannot send.');
    return false;
  }
  try {
    const resp = await fetch(WAZZUP_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({ channelId, chatId: String(chatId), chatType, text })
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      console.error(`[wazzup] send failed HTTP ${resp.status}: ${body.slice(0, 200)}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error('[wazzup] send error:', err.message);
    return false;
  }
}

// Convenience: send from the FusionETA system channel.
function sendSystemMessage(chatId, text) {
  const { channelId, apiKey } = systemCreds();
  return sendMessage({ channelId, apiKey, chatId, text });
}

module.exports = { sendMessage, sendSystemMessage, systemCreds, WAZZUP_ENDPOINT };
