// Email channel records: per-account settings, the Gmail messages the Apps Script
// reported, and one row per bill read from their attachments. See
// scripts/add-email-channel-tables.js for the tables.
const db = require('../db');
const { encrypt, decrypt } = require('../lib/crypto');

// ── Settings ────────────────────────────────────────────────────────────────

// gmail_password comes back decrypted (null when unset or unreadable).
async function getSettings(accountId) {
  const row = await db.getOne('SELECT * FROM email_settings WHERE account_id = ?', [accountId]);
  if (!row) {
    return {
      account_id: accountId, enabled: 1, gmail_address: null, gmail_password: null, notify_phone: null,
      notify_failures: 1, script_version: null, last_heartbeat_at: null
    };
  }
  let password = null;
  if (row.gmail_password) {
    try { password = decrypt(row.gmail_password); }
    catch (err) { console.error('[email] could not decrypt the Gmail password:', err.message); }
  }
  return { ...row, gmail_password: password };
}

async function saveSettings(accountId, { enabled, gmailAddress, gmailPassword, notifyPhone, notifyFailures }) {
  await db.execute(
    `INSERT INTO email_settings (account_id, enabled, gmail_address, gmail_password, notify_phone, notify_failures)
     VALUES (?,?,?,?,?,?)
     ON DUPLICATE KEY UPDATE enabled = VALUES(enabled), gmail_address = VALUES(gmail_address),
       gmail_password = VALUES(gmail_password), notify_phone = VALUES(notify_phone),
       notify_failures = VALUES(notify_failures)`,
    [accountId, enabled ? 1 : 0, gmailAddress || null, gmailPassword ? encrypt(gmailPassword) : null,
     notifyPhone || null, notifyFailures ? 1 : 0]
  );
}

async function heartbeat(accountId, version) {
  await db.execute(
    `INSERT INTO email_settings (account_id, script_version, last_heartbeat_at) VALUES (?,?,UTC_TIMESTAMP())
     ON DUPLICATE KEY UPDATE script_version = VALUES(script_version), last_heartbeat_at = UTC_TIMESTAMP()`,
    [accountId, version ? String(version).slice(0, 32) : null]
  );
}

// ── Script run time ─────────────────────────────────────────────────────────

// One Gmail script run. INSERT IGNORE: the same run can be reported twice
// (setup() also sends a heartbeat).
async function recordRun(accountId, runAt, durationMs) {
  await db.execute(
    'INSERT IGNORE INTO email_script_runs (account_id, run_at, duration_ms) VALUES (?,?,?)',
    [accountId, runAt, Math.max(0, Math.min(Math.round(durationMs), 30 * 60 * 1000))]
  );
}

// Runs in the last 24 hours, for the usage line in Settings. Also drops rows
// older than 3 days, so the table stays small (about 1,440 rows a day).
async function runUsage(accountId) {
  await db.execute('DELETE FROM email_script_runs WHERE account_id = ? AND run_at < UTC_TIMESTAMP() - INTERVAL 3 DAY', [accountId]);
  const row = await db.getOne(
    `SELECT COUNT(*) AS runs, COALESCE(SUM(duration_ms), 0) AS total_ms, COALESCE(MAX(duration_ms), 0) AS max_ms
     FROM email_script_runs WHERE account_id = ? AND run_at >= UTC_TIMESTAMP() - INTERVAL 1 DAY`,
    [accountId]
  );
  return { runs: Number(row.runs), totalMs: Number(row.total_ms), maxMs: Number(row.max_ms) };
}

// ── Messages ────────────────────────────────────────────────────────────────

// Insert-or-get by Gmail message id, so the script can report the same email
// again (a retry, or one call per attachment) without making duplicates.
async function upsertMessage(accountId, { gmailMessageId, fromName, fromEmail, subject, receivedAt, skipReason = null }) {
  await db.execute(
    `INSERT INTO email_messages (account_id, gmail_message_id, from_name, from_email, subject, received_at, skip_reason)
     VALUES (?,?,?,?,?,?,?)
     ON DUPLICATE KEY UPDATE skip_reason = COALESCE(VALUES(skip_reason), skip_reason)`,
    [accountId, gmailMessageId, fromName || null, fromEmail || null, subject ? String(subject).slice(0, 512) : null,
     receivedAt || null, skipReason]
  );
  return db.getOne('SELECT * FROM email_messages WHERE account_id = ? AND gmail_message_id = ?', [accountId, gmailMessageId]);
}

// ── Attachments ─────────────────────────────────────────────────────────────

// Queue one attachment. Returns { row, created } — created is false when this
// exact file (same email, name and size) was already reported.
async function queueAttachment(accountId, messageId, { fileName, mime, size, storedFile }) {
  const existing = await db.getOne(
    'SELECT * FROM email_attachments WHERE email_message_id = ? AND file_name = ? AND size = ? AND bill_index = 0',
    [messageId, fileName, size]
  );
  if (existing) return { row: existing, created: false };
  const id = await db.insert(
    `INSERT INTO email_attachments (account_id, email_message_id, file_name, mime, size, stored_file, status)
     VALUES (?,?,?,?,?,?,'queued')`,
    [accountId, messageId, fileName, mime || null, size || 0, storedFile || null]
  );
  return { row: await getAttachment(id), created: true };
}

// Another bill found in the same file (bill_index 1, 2, …).
async function addSiblingBill(base, billIndex, fields) {
  const id = await db.insert(
    `INSERT INTO email_attachments (account_id, email_message_id, file_name, mime, size, bill_index, status)
     VALUES (?,?,?,?,?,?,'processing')`,
    [base.account_id, base.email_message_id, base.file_name, base.mime, base.size, billIndex]
  );
  await updateAttachment(id, fields);
  return id;
}

function getAttachment(id) {
  return db.getOne('SELECT * FROM email_attachments WHERE id = ?', [id]);
}

function getAttachmentForAccount(id, accountId) {
  return db.getOne('SELECT * FROM email_attachments WHERE id = ? AND account_id = ?', [id, accountId]);
}

const UPDATABLE = ['status', 'message', 'bill_id', 'pending_uuid', 'supplier', 'invoice_no', 'total', 'currency',
  'xero_tenant_name', 'xero_url', 'stored_file', 'resolved_by_user', 'resolved_at'];

async function updateAttachment(id, fields) {
  const keys = Object.keys(fields).filter((k) => UPDATABLE.includes(k));
  if (!keys.length) return;
  const sets = keys.map((k) => (k === 'resolved_at' && fields[k] === 'now' ? 'resolved_at = NOW()' : `${k} = ?`));
  const params = keys.filter((k) => !(k === 'resolved_at' && fields[k] === 'now')).map((k) => fields[k]);
  await db.execute(`UPDATE email_attachments SET ${sets.join(', ')} WHERE id = ?`, [...params, id]);
}

// Work left over from a restart: anything queued or mid-processing.
function unfinished() {
  return db.query("SELECT * FROM email_attachments WHERE status IN ('queued','processing') ORDER BY id");
}

// Every bill still waiting on an org, across accounts (for reconciliation).
function allPending(accountId = null) {
  return accountId
    ? db.query("SELECT * FROM email_attachments WHERE status = 'pending' AND account_id = ?", [accountId])
    : db.query("SELECT * FROM email_attachments WHERE status = 'pending'");
}

// ── Inbox listing ───────────────────────────────────────────────────────────

// The newest messages with their attachment rows, newest first.
async function inbox(accountId, { limit = 100 } = {}) {
  const lim = Math.min(500, Math.max(1, Number(limit) || 100));
  const messages = await db.query(
    `SELECT * FROM email_messages WHERE account_id = ?
     ORDER BY COALESCE(received_at, created_at) DESC, id DESC LIMIT ${lim}`,
    [accountId]
  );
  if (!messages.length) return [];
  const ids = messages.map((m) => m.id);
  const atts = await db.query(
    `SELECT * FROM email_attachments WHERE email_message_id IN (${ids.map(() => '?').join(',')})
     ORDER BY email_message_id, file_name, bill_index`,
    ids
  );
  const byMsg = new Map(ids.map((id) => [id, []]));
  for (const a of atts) byMsg.get(a.email_message_id).push(a);
  return messages.map((m) => ({ ...m, attachments: byMsg.get(m.id) || [] }));
}

// Month figures for the dashboard tiles (email-sourced only).
async function monthStats(accountId) {
  // NOW() on purpose: created_at defaults to CURRENT_TIMESTAMP, the same clock
  // the bills counters in user/router.js compare against.
  const row = await db.getOne(
    `SELECT
       SUM(status = 'created' AND created_at >= DATE_FORMAT(NOW(), '%Y-%m-01')) AS bills_month,
       SUM(CASE WHEN status = 'created' AND created_at >= DATE_FORMAT(NOW(), '%Y-%m-01') THEN total ELSE 0 END) AS value_month,
       SUM(status = 'created' AND created_at >= NOW() - INTERVAL 1 DAY) AS bills_day,
       SUM(resolved_by_user = 1 AND resolved_at >= NOW() - INTERVAL 1 DAY) AS resolved_day
     FROM email_attachments WHERE account_id = ?`,
    [accountId]
  );
  return {
    billsMonth: Number(row && row.bills_month || 0),
    valueMonth: Number(row && row.value_month || 0),
    billsDay: Number(row && row.bills_day || 0),
    resolvedDay: Number(row && row.resolved_day || 0)
  };
}

module.exports = {
  getSettings, saveSettings, heartbeat, recordRun, runUsage,
  upsertMessage, queueAttachment, addSiblingBill, getAttachment, getAttachmentForAccount, updateAttachment,
  unfinished, allPending, inbox, monthStats
};
