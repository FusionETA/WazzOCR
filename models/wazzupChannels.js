// Per-account Wazzup channels. channel_id is globally unique and is how an
// inbound webhook is routed to the right account.
const db = require('../db');
const { encrypt, decrypt } = require('../lib/crypto');

// Mask a secret for display: keep the first 4 and last 4 chars.
function maskKey(k) {
  if (!k) return null;
  return k.length <= 8 ? '••••' : k.slice(0, 4) + '••••••' + k.slice(-4);
}

async function listByAccount(accountId) {
  const rows = await db.query(
    'SELECT id, account_id, channel_id, api_key, label, status, webhook_registered FROM wazzup_channels WHERE account_id = ?',
    [accountId]
  );
  return rows.map((r) => {
    let apiKeyMasked = null;
    if (r.api_key) { try { apiKeyMasked = maskKey(decrypt(r.api_key)); } catch { apiKeyMasked = '••••'; } }
    const { api_key, ...rest } = r; // never expose the encrypted/plain key in a list
    return { ...rest, hasApiKey: Boolean(r.api_key), apiKeyMasked, webhookRegistered: Boolean(r.webhook_registered) };
  });
}

// Mark a channel's webhook as registered (called after a successful registerWebhook).
async function markWebhookRegistered(accountId, id) {
  const r = await db.execute(
    'UPDATE wazzup_channels SET webhook_registered = 1 WHERE id = ? AND account_id = ?',
    [id, accountId]
  );
  return r.affectedRows;
}

// Resolve a channel id to its account id (active channels only).
async function resolveAccountId(channelId) {
  if (!channelId) return null;
  const row = await db.getOne(
    "SELECT account_id FROM wazzup_channels WHERE channel_id = ? AND status = 'active'",
    [channelId]
  );
  return row ? row.account_id : null;
}

// Full channel record incl. decrypted api key, for sending replies.
async function getByChannelId(channelId) {
  const row = await db.getOne('SELECT * FROM wazzup_channels WHERE channel_id = ?', [channelId]);
  if (!row) return null;
  return { ...row, api_key: row.api_key ? decrypt(row.api_key) : null };
}

// Decrypted API key for one channel (scoped to its account). Null if none.
async function getDecryptedApiKey(accountId, id) {
  const row = await db.getOne('SELECT api_key FROM wazzup_channels WHERE id = ? AND account_id = ?', [id, accountId]);
  return row && row.api_key ? decrypt(row.api_key) : null;
}

async function add(accountId, { channelId, apiKey = null, label = null }) {
  if (!channelId) throw new Error('channelId is required.');
  return db.insert(
    'INSERT INTO wazzup_channels (account_id, channel_id, api_key, label) VALUES (?,?,?,?)',
    [accountId, channelId, apiKey ? encrypt(apiKey) : null, label]
  );
}

async function remove(accountId, id) {
  const r = await db.execute('DELETE FROM wazzup_channels WHERE id = ? AND account_id = ?', [id, accountId]);
  return r.affectedRows;
}

module.exports = { listByAccount, resolveAccountId, getByChannelId, getDecryptedApiKey, add, remove, markWebhookRegistered };
