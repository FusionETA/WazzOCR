// Per-account Wazzup channels. channel_id is globally unique and is how an
// inbound webhook is routed to the right account.
const db = require('../db');
const { encrypt, decrypt } = require('../lib/crypto');

function listByAccount(accountId) {
  return db.query(
    'SELECT id, account_id, channel_id, label, status FROM wazzup_channels WHERE account_id = ?',
    [accountId]
  );
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

module.exports = { listByAccount, resolveAccountId, getByChannelId, add, remove };
