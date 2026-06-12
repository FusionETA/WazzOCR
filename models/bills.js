// Bill attempt records (the analytics core). One row per processed document.
const db = require('../db');

async function record({
  accountId, status, failureReason = null,
  xeroConnectionId = null, wazzupChannelId = null, chatId = null,
  supplier = null, invoiceNo = null, total = null, currency = null,
  documentType = null, xeroInvoiceId = null, xeroUrl = null, source = null
}) {
  if (!accountId || !status) throw new Error('accountId and status are required.');
  return db.insert(
    `INSERT INTO bills
      (account_id, xero_connection_id, wazzup_channel_id, chat_id, status, failure_reason,
       supplier, invoice_no, total, currency, document_type, xero_invoice_id, xero_url, source)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [accountId, xeroConnectionId, wazzupChannelId, chatId, status, failureReason,
     supplier, invoiceNo, total, currency, documentType, xeroInvoiceId, xeroUrl, source]
  );
}

async function successCount(accountId) {
  const r = await db.getOne("SELECT COUNT(*) AS n FROM bills WHERE account_id = ? AND status = 'success'", [accountId]);
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

function recent(accountId, limit = 50) {
  const lim = Math.min(500, Math.max(1, Number(limit) || 50)); // inline (validated) for LIMIT
  return db.query(
    `SELECT id, status, failure_reason, supplier, invoice_no, total, currency,
            document_type, xero_invoice_id, xero_url, source, created_at
     FROM bills WHERE account_id = ? ORDER BY created_at DESC LIMIT ${lim}`,
    [accountId]
  );
}

module.exports = { record, successCount, statusCounts, failureReasons, recent };
