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

// Delete a non-success bill (pending/failed/skipped) scoped to its account.
// Success bills are protected — they're the created-in-Xero audit trail + counter.
async function remove(accountId, id) {
  const r = await db.execute(
    "DELETE FROM bills WHERE id = ? AND account_id = ? AND status <> 'success'",
    [id, accountId]
  );
  return r.affectedRows;
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
            document_type, xero_invoice_id, xero_url, xero_tenant_name, source, chat_id, created_at`;
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

// One page of an account's bills, filtered in SQL so every bill stays reachable
// however many the account has (recent() caps at 500, which hid older months).
// from/to are Date bounds (the browser sends its local day edges); senderPhones
// are normalised numbers whose Settings label matched the search text.
async function search(accountId, {
  status = null, q = '', org = '', from = null, to = null, senderPhones = [],
  page = 1, pageSize = 15
} = {}) {
  const size = Math.min(100, Math.max(1, Number(pageSize) || 15));
  const where = ['account_id = ?'];
  const params = [accountId];
  if (status) { where.push('status = ?'); params.push(status); }
  if (org) { where.push('xero_tenant_name = ?'); params.push(org); }
  if (from) { where.push('created_at >= ?'); params.push(from); }
  if (to) { where.push('created_at <= ?'); params.push(to); }
  const text = String(q || '').trim();
  if (text) {
    const like = `%${text.replace(/[\\%_]/g, (c) => '\\' + c)}%`;
    const ors = ['supplier LIKE ?', 'invoice_no LIKE ?', 'xero_tenant_name LIKE ?', 'chat_id LIKE ?'];
    params.push(like, like, like, like);
    for (const phone of senderPhones) { ors.push('chat_id LIKE ?'); params.push(`${phone}%`); }
    where.push(`(${ors.join(' OR ')})`);
  }
  const whereSql = where.join(' AND ');
  const countRow = await db.getOne(`SELECT COUNT(*) AS n FROM bills WHERE ${whereSql}`, params);
  const total = countRow ? Number(countRow.n) : 0;
  const pages = Math.max(1, Math.ceil(total / size));
  const current = Math.min(pages, Math.max(1, Number(page) || 1));
  const cols = `id, status, failure_reason, supplier, invoice_no, total, currency,
            document_type, xero_invoice_id, xero_url, xero_tenant_name, source, chat_id, created_at`;
  const rows = await db.query(
    `SELECT ${cols} FROM bills WHERE ${whereSql}
     ORDER BY created_at DESC, id DESC LIMIT ${size} OFFSET ${(current - 1) * size}`,
    params
  );
  return { rows, total, page: current, pages, pageSize: size };
}

module.exports = { record, successCount, successCountThisMonth, statusCounts, failureReasons, recent, search, getResolvable, markResolved, remove };
