// Per-account chart of accounts (expense/cost codes for AI line-item coding).
const db = require('../db');

function list(accountId) {
  return db.query('SELECT code, name, category FROM coa_accounts WHERE account_id = ? ORDER BY code', [accountId]);
}

// Replace the whole COA for an account (used by CSV upload). Returns the count.
async function replaceAll(accountId, rows) {
  return db.transaction(async (tx) => {
    await tx.execute('DELETE FROM coa_accounts WHERE account_id = ?', [accountId]);
    for (const r of rows) {
      const code = String(r.code || '').trim();
      const name = String(r.name || '').trim();
      if (!code || !name) continue;
      const category = r.category ? String(r.category).trim() : null;
      // Ignore duplicate codes within the same upload.
      await tx.execute(
        'INSERT IGNORE INTO coa_accounts (account_id, code, name, category) VALUES (?,?,?,?)',
        [accountId, code, name, category]
      );
    }
    const [c] = await tx.execute('SELECT COUNT(*) AS n FROM coa_accounts WHERE account_id = ?', [accountId]);
    return Number(c[0].n);
  });
}

module.exports = { list, replaceAll };
