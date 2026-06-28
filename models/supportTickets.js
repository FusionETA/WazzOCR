// Support tickets — error tracking surfaced to WhatsApp clients.
// The client sees only `ticket_code`; the raw error + context stay here so an
// admin can look up a quoted code and see exactly what went wrong.
const db = require('../db');

// Human-friendly code: WZ- + 6 chars from an unambiguous alphabet (no 0/O/1/I/L)
// so it's easy to read aloud / type over WhatsApp. ~30^6 ≈ 729M combinations.
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
function randomCode() {
  let s = '';
  for (let i = 0; i < 6; i++) s += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  return `WZ-${s}`;
}

// Insert a ticket. Retries a few times on the (rare) unique-code collision.
// Returns { id, code }. Throws only if the DB itself is unreachable.
async function create({
  accountId = null, channelDbId = null, chatId = null,
  stage = 'other', clientMessage = null, errorMessage = null, errorDetail = null
} = {}) {
  let lastErr = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = randomCode();
    try {
      const id = await db.insert(
        `INSERT INTO support_tickets
           (ticket_code, account_id, wazzup_channel_id, chat_id, stage, client_message, error_message, error_detail)
         VALUES (?,?,?,?,?,?,?,?)`,
        [code, accountId, channelDbId, chatId, stage,
         clientMessage ? String(clientMessage).slice(0, 512) : null,
         errorMessage ? String(errorMessage).slice(0, 65000) : null,
         errorDetail ? JSON.stringify(errorDetail) : null]
      );
      return { id, code };
    } catch (err) {
      lastErr = err;
      if (!/Duplicate/i.test(err.message)) throw err; // only retry on code collision
    }
  }
  throw lastErr || new Error('Could not allocate a unique ticket code.');
}

async function getByCode(code) {
  return db.getOne(
    `SELECT t.*, a.name AS account_name
       FROM support_tickets t LEFT JOIN accounts a ON a.id = t.account_id
      WHERE t.ticket_code = ?`,
    [String(code || '').trim().toUpperCase()]
  );
}

// Recent tickets (optionally filtered by status) with the account name joined.
// LIMIT/OFFSET are inlined (after integer validation) because this DB layer uses
// prepared `execute`, and mysql2 rejects bound LIMIT/OFFSET placeholders.
async function list({ status = null, limit = 100, offset = 0 } = {}) {
  const lim = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const off = Math.max(Number(offset) || 0, 0);
  const where = status ? 'WHERE t.status = ?' : '';
  const params = status ? [status] : [];
  return db.query(
    `SELECT t.*, a.name AS account_name
       FROM support_tickets t LEFT JOIN accounts a ON a.id = t.account_id
       ${where}
      ORDER BY t.created_at DESC
      LIMIT ${lim} OFFSET ${off}`,
    params
  );
}

// Count by status, for the admin dashboard badges.
async function statusCounts() {
  return db.query('SELECT status, COUNT(*) AS n FROM support_tickets GROUP BY status');
}

async function setStatus(id, status) {
  const valid = ['open', 'investigating', 'resolved'];
  if (!valid.includes(status)) throw new Error('Invalid status.');
  const resolvedAt = status === 'resolved' ? 'NOW()' : 'NULL';
  const r = await db.execute(
    `UPDATE support_tickets SET status = ?, resolved_at = ${resolvedAt} WHERE id = ?`,
    [status, Number(id)]
  );
  return r.affectedRows;
}

module.exports = { create, getByCode, list, statusCounts, setStatus, randomCode };
