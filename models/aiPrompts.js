// Modular AI prompt blocks (ai_prompt_blocks).
//   • account_id NULL  → GENERAL block, applied to every account.
//   • account_id set    → per-account add-on block.
// Enabled blocks are concatenated (ordered by position, then id) to build the
// general prompt / per-account add-on used by buildBillPrompt.
const db = require('../db');

function listGeneral() {
  return db.query('SELECT * FROM ai_prompt_blocks WHERE account_id IS NULL ORDER BY position, id');
}

function listByAccount(accountId) {
  return db.query('SELECT * FROM ai_prompt_blocks WHERE account_id = ? ORDER BY position, id', [accountId]);
}

function getById(id) {
  return db.getOne('SELECT * FROM ai_prompt_blocks WHERE id = ?', [id]);
}

async function create({ accountId = null, title, body, enabled = true } = {}) {
  if (!title || !title.trim()) throw new Error('Title is required.');
  return db.insert(
    'INSERT INTO ai_prompt_blocks (account_id, title, body, enabled) VALUES (?, ?, ?, ?)',
    [accountId, title.trim(), body || '', enabled ? 1 : 0]
  );
}

// Update a whitelisted set of fields. Returns affectedRows.
async function update(id, fields = {}) {
  const allowed = { title: 'title', body: 'body', enabled: 'enabled', position: 'position' };
  const sets = [], params = [];
  for (const [key, col] of Object.entries(allowed)) {
    if (key in fields) { sets.push(`${col} = ?`); params.push(key === 'enabled' ? (fields[key] ? 1 : 0) : fields[key]); }
  }
  if (!sets.length) return 0;
  params.push(id);
  const res = await db.execute(`UPDATE ai_prompt_blocks SET ${sets.join(', ')} WHERE id = ?`, params);
  return res.affectedRows;
}

async function remove(id) {
  const res = await db.execute('DELETE FROM ai_prompt_blocks WHERE id = ?', [id]);
  return res.affectedRows;
}

// Concatenated body of all ENABLED general blocks (empty string if none).
async function generalText() {
  const rows = await db.query('SELECT body FROM ai_prompt_blocks WHERE account_id IS NULL AND enabled = 1 ORDER BY position, id');
  return rows.map((r) => String(r.body || '').trim()).filter(Boolean).join('\n\n');
}

// Concatenated body of all ENABLED add-on blocks for one account.
async function accountText(accountId) {
  const rows = await db.query('SELECT body FROM ai_prompt_blocks WHERE account_id = ? AND enabled = 1 ORDER BY position, id', [accountId]);
  return rows.map((r) => String(r.body || '').trim()).filter(Boolean).join('\n\n');
}

module.exports = { listGeneral, listByAccount, getById, create, update, remove, generalText, accountText };
