// Bill attempt records (the analytics core). One row per processed document.
const db = require('../db');

async function record({
  accountId, status, failureReason = null,
  xeroConnectionId = null, wazzupChannelId = null, chatId = null,
  supplier = null, invoiceNo = null, total = null, currency = null,
  documentType = null, xeroInvoiceId = null, xeroUrl = null, xeroTenantName = null, source = null,
  payload = null
}) {
  if (!accountId || !status) throw new Error('accountId and status are required.');
  return db.insert(
    `INSERT INTO bills
      (account_id, xero_connection_id, wazzup_channel_id, chat_id, status, failure_reason,
       supplier, invoice_no, total, currency, document_type, xero_invoice_id, xero_url, xero_tenant_name, source, payload)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [accountId, xeroConnectionId, wazzupChannelId, chatId, status, failureReason,
     supplier, invoiceNo, total, currency, documentType, xeroInvoiceId, xeroUrl, xeroTenantName, source,
     payload ? JSON.stringify(payload) : null]
  );
}

// One pending bill (account-scoped) with its full payload parsed.
async function getResolvable(id, accountId) {
  const row = await db.getOne(
    "SELECT * FROM bills WHERE id = ? AND account_id = ? AND status = 'pending'",
    [id, accountId]
  );
  if (!row) return null;
  let payload = null;
  if (row.payload) { try { payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload; } catch { /* ignore */ } }
  return { ...row, payload };
}

// Mark a pending bill as successfully created in Xero.
async function markResolved(id, accountId, { xeroInvoiceId = null, xeroUrl = null, xeroConnectionId = null, xeroTenantName = null } = {}) {
  await db.execute(
    `UPDATE bills SET status = 'success', failure_reason = NULL, payload = NULL,
            xero_invoice_id = ?, xero_url = ?, xero_connection_id = ?, xero_tenant_name = ?
     WHERE id = ? AND account_id = ?`,
    [xeroInvoiceId, xeroUrl, xeroConnectionId, xeroTenantName, id, accountId]
  );
}

async function successCount(accountId) {
  const r = await db.getOne("SELECT COUNT(*) AS n FROM bills WHERE account_id = ? AND status = 'success'", [accountId]);
  return r ? Number(r.n) : 0;
}

// Success bills created in the current calendar month.
async function successCountThisMonth(accountId) {
  const r = await db.getOne(
    `SELECT COUNT(*) AS n FROM bills
     WHERE account_id = ? AND status = 'success'
       AND created_at >= DATE_FORMAT(NOW(), '%Y-%m-01')`,
    [accountId]
  );
  return r ? Number(r.n) : 0;
}

function statusCounts(accountId) {
  return db.query('SELECT status, COUNT(*) AS n FROM bills WHERE account_id = ? GROUP BY status', [accountId]);
}

function failureReasons(accountId) {
  return db.query(
    `SELECT failure_reason, COUNT(*) AS n FROM bills
     WHERE account_id = ? AND status = 'failed'
     GROUP BY failure_reason ORDER BY n DESC LIMIT 20`,
    [accountId]
  );
}

function recent(accountId, limit = 50, status = null) {
  const lim = Math.min(500, Math.max(1, Number(limit) || 50)); // inline (validated) for LIMIT
  const cols = `id, status, failure_reason, supplier, invoice_no, total, currency,
            document_type, xero_invoice_id, xero_url, xero_tenant_name, source, created_at`;
  if (status) {
    return db.query(
      `SELECT ${cols} FROM bills WHERE account_id = ? AND status = ? ORDER BY created_at DESC LIMIT ${lim}`,
      [accountId, status]
    );
  }
  return db.query(
    `SELECT ${cols} FROM bills WHERE account_id = ? ORDER BY created_at DESC LIMIT ${lim}`,
    [accountId]
  );
}

module.exports = { record, successCount, successCountThisMonth, statusCounts, failureReasons, recent, getResolvable, markResolved };
