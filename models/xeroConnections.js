// Per-account Xero OAuth grants and connected organisations.
const db = require('../db');
const { encrypt, decrypt } = require('../lib/crypto');

// Store a new OAuth grant (refresh token encrypted). Returns grant id.
async function saveGrant(accountId, refreshToken, scope = null) {
  return db.insert(
    'INSERT INTO xero_grants (account_id, refresh_token, scope) VALUES (?,?,?)',
    [accountId, encrypt(refreshToken), scope]
  );
}

// Update a grant's refresh token (Xero rotates it on every refresh).
async function updateGrantToken(grantId, refreshToken) {
  await db.execute('UPDATE xero_grants SET refresh_token = ? WHERE id = ?', [encrypt(refreshToken), grantId]);
}

// Link (or re-activate) a connected org under a grant.
async function upsertConnection(accountId, grantId, tenantId, tenantName) {
  await db.execute(
    `INSERT INTO xero_connections (account_id, grant_id, xero_tenant_id, tenant_name, status)
     VALUES (?,?,?,?,'active')
     ON DUPLICATE KEY UPDATE grant_id = VALUES(grant_id), tenant_name = VALUES(tenant_name),
                             status = 'active', needs_reconnect = 0`,
    [accountId, grantId, tenantId, tenantName]
  );
}

function listByAccount(accountId) {
  return db.query(
    `SELECT id, account_id, grant_id, xero_tenant_id, tenant_name, status, needs_reconnect
     FROM xero_connections WHERE account_id = ?`,
    [accountId]
  );
}

// Returns { grantId, refreshToken } for a given account+tenant, or null.
async function getGrantForTenant(accountId, tenantId) {
  const row = await db.getOne(
    `SELECT g.id AS grant_id, g.refresh_token
     FROM xero_connections c JOIN xero_grants g ON g.id = c.grant_id
     WHERE c.account_id = ? AND c.xero_tenant_id = ? AND c.status = 'active'`,
    [accountId, tenantId]
  );
  return row ? { grantId: row.grant_id, refreshToken: decrypt(row.refresh_token) } : null;
}

// Resolve which account owns an active connection to this Xero tenant.
// Lets context-less callers (e.g. the bill-status cron) use the DB token path
// instead of the retired file store. Returns accountId or null.
async function findAccountByTenant(tenantId) {
  const row = await db.getOne(
    "SELECT account_id FROM xero_connections WHERE xero_tenant_id = ? AND status = 'active' LIMIT 1",
    [tenantId]
  );
  return row ? row.account_id : null;
}

async function markNeedsReconnect(accountId, tenantId) {
  await db.execute(
    "UPDATE xero_connections SET needs_reconnect = 1, status = 'expired' WHERE account_id = ? AND xero_tenant_id = ?",
    [accountId, tenantId]
  );
}

// One connection row scoped to an account (null if not found / not theirs).
function getById(accountId, id) {
  return db.getOne('SELECT * FROM xero_connections WHERE id = ? AND account_id = ?', [id, accountId]);
}

// Delete a connection row. Returns affectedRows.
async function deleteConnection(accountId, id) {
  const res = await db.execute('DELETE FROM xero_connections WHERE id = ? AND account_id = ?', [id, accountId]);
  return res.affectedRows;
}

// Delete a grant once no connections reference it (so the refresh token isn't
// left dangling). Returns true if it was removed.
async function deleteGrantIfOrphaned(grantId) {
  const row = await db.getOne('SELECT COUNT(*) AS n FROM xero_connections WHERE grant_id = ?', [grantId]);
  if (row && Number(row.n) === 0) {
    await db.execute('DELETE FROM xero_grants WHERE id = ?', [grantId]);
    return true;
  }
  return false;
}

module.exports = {
  saveGrant, updateGrantToken, upsertConnection,
  listByAccount, getGrantForTenant, findAccountByTenant, markNeedsReconnect,
  getById, deleteConnection, deleteGrantIfOrphaned
};
