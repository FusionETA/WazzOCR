// Per-channel allowed sender phones (the phone-restriction allow-list, which also
// doubles as the trial routing map). See db/schema.sql `wazzup_channel_phones`.
const db = require('../db');

// Normalise a phone to digits only (drop +, spaces, dashes, and any @suffix).
// Both stored numbers and inbound sender ids are normalised the same way so they
// compare reliably.
function normalizePhone(raw) {
  return String(raw || '').replace(/@[a-z.]+$/i, '').replace(/[^\d]/g, '');
}

// All allowed phones for one channel (db id).
function listByChannel(channelDbId) {
  return db.query(
    'SELECT id, wazzup_channel_id, account_id, phone, label, created_at FROM wazzup_channel_phones WHERE wazzup_channel_id = ? ORDER BY created_at',
    [channelDbId]
  );
}

// All phones an account has registered (across channels). For trial accounts these
// live on the shared trial channel.
function listByAccount(accountId) {
  return db.query(
    'SELECT id, wazzup_channel_id, account_id, phone, label, created_at FROM wazzup_channel_phones WHERE account_id = ? ORDER BY created_at',
    [accountId]
  );
}

// Resolve a sender phone on a given channel to the account it belongs to.
// Returns { account_id } or null. This is the routing key for the shared trial
// channel and the gate for a restricted paid channel.
async function resolveAccount(channelDbId, phone) {
  const p = normalizePhone(phone);
  if (!p) return null;
  return db.getOne(
    'SELECT account_id FROM wazzup_channel_phones WHERE wazzup_channel_id = ? AND phone = ?',
    [channelDbId, p]
  );
}

// Add a phone to a channel for an account. Throws on duplicate (caller maps to 409).
async function add({ channelDbId, accountId, phone, label = null }) {
  const p = normalizePhone(phone);
  if (!p) throw new Error('A valid phone number is required.');
  return db.insert(
    'INSERT INTO wazzup_channel_phones (wazzup_channel_id, account_id, phone, label) VALUES (?,?,?,?)',
    [channelDbId, accountId, p, label]
  );
}

// Remove a phone row, scoped to the owning account so one account can't delete
// another's mapping.
async function remove(accountId, id) {
  const r = await db.execute(
    'DELETE FROM wazzup_channel_phones WHERE id = ? AND account_id = ?',
    [id, accountId]
  );
  return r.affectedRows;
}

module.exports = { normalizePhone, listByChannel, listByAccount, resolveAccount, add, remove };
