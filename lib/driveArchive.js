// Google Drive archive: a copy of every bill file WazzOCR receives — by email
// or WhatsApp, created, duplicate, needing review or failed — saved to the
// account's email-channel Gmail under
//
//   WazzOCR Bills / 2026-11 / Created | Needs review | Duplicate | Failed
//
// WazzOCR has no Google login of its own. It keeps the file locally and the
// Gmail Apps Script (integrations/gmail-intake/Code.gs), which already runs
// every minute inside that Gmail, collects waiting files and saves them to
// its Drive, then tells us to delete the local copy.
//
// A file is captured the moment it arrives (before any processing, so a crash
// or a failed read still keeps it) and becomes "ready" once its result is
// known. Accounts are only captured while their Gmail script is checking in,
// so files never pile up for an account with no script to collect them.

const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const db = require('../db');

const ARCHIVE_DIR = path.join(__dirname, '..', 'data', 'archive');
const RESULT_FOLDER = { created: 'Created', review: 'Needs review', duplicate: 'Duplicate', failed: 'Failed' };
// If a WhatsApp reply never reaches us (webhook.php gave up and the result went
// out over WhatsApp instead, or the app restarted), settleStale() files the
// file from the bills table once it is this old.
const WHATSAPP_SETTLE_MS = Number(process.env.ARCHIVE_WHATSAPP_SETTLE_MS) || 15 * 60 * 1000;
// Files the script has not collected by then are dropped, so a script that was
// removed cannot fill the disk.
const KEEP_DAYS = 30;
const PICKUP_BATCH = 5;
const MY_TZ = 'Asia/Kuala_Lumpur';

let sniffMime = (buf, declared) => declared;

function configure({ sniffMime: s } = {}) { if (s) sniffMime = s; }

// ── Who gets archived ───────────────────────────────────────────────────────

// Switched on in Settings AND a Gmail script that has checked in recently.
async function enabledFor(accountId) {
  if (!accountId) return false;
  const row = await db.getOne(
    `SELECT 1 AS ok FROM email_settings
     WHERE account_id = ? AND enabled = 1 AND drive_archive = 1
       AND last_heartbeat_at >= UTC_TIMESTAMP() - INTERVAL 2 DAY`,
    [accountId]
  );
  return Boolean(row);
}

// ── Capture and settle ──────────────────────────────────────────────────────

async function add({ accountId, channel, fileName, mime, buffer, sender = null, receivedAt = new Date() }) {
  if (!buffer || !buffer.length || !(await enabledFor(accountId))) return null;
  await fsp.mkdir(ARCHIVE_DIR, { recursive: true });
  const ext = path.extname(String(fileName || '')).slice(0, 10).replace(/[^.a-z0-9]/gi, '');
  const stored = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`;
  await fsp.writeFile(path.join(ARCHIVE_DIR, stored), buffer);
  return db.insert(
    `INSERT INTO drive_archive (account_id, channel, file_name, mime, stored_file, sender, received_at)
     VALUES (?,?,?,?,?,?,?)`,
    [accountId, channel, String(fileName || 'bill').slice(0, 255), sniffMime(buffer, mime || 'application/octet-stream'),
     stored, sender ? String(sender).slice(0, 255) : null, receivedAt]
  );
}

// Record the result and release the file for pickup. Only the first result
// counts: a later retry of the same file does not file a second copy.
async function finish(id, { result, supplier = null, invoiceNo = null }) {
  if (!id) return;
  await db.execute(
    `UPDATE drive_archive SET result = ?, supplier = ?, invoice_no = ?, ready = 1
     WHERE id = ? AND ready = 0`,
    [RESULT_FOLDER[result] ? result : 'failed', supplier ? String(supplier).slice(0, 255) : null,
     invoiceNo ? String(invoiceNo).slice(0, 128) : null, id]
  );
}

async function drop(id) {
  if (!id) return;
  const row = await db.getOne('SELECT stored_file FROM drive_archive WHERE id = ?', [id]);
  if (row) await removeFile(row.stored_file);
  await db.execute('DELETE FROM drive_archive WHERE id = ?', [id]);
}

async function removeFile(name) {
  if (!name) return;
  try { await fsp.unlink(path.join(ARCHIVE_DIR, path.basename(name))); }
  catch (err) { if (err.code !== 'ENOENT') console.error('[archive] could not delete local copy:', err.message); }
}

// One file can hold several bills; the folder follows the one that most needs
// a person: review, then failed, then created, then duplicate.
function combine(results) {
  for (const r of ['review', 'failed', 'created', 'duplicate']) if (results.includes(r)) return r;
  return 'failed';
}

// A processBillForChat outcome → archive result.
function outcomeResult(o) {
  if (!o) return 'failed';
  if (o.status === 'created') return o.xero && o.xero.invoiceId ? 'created' : 'failed';
  if (o.status === 'pending' || o.status === 'xero-error') return 'review';
  if (o.status === 'duplicate') return 'duplicate';
  return 'failed';
}

// ── WhatsApp ────────────────────────────────────────────────────────────────

// Called once at the top of /api/whatsapp/process-file. Copies the file and
// reads the result from the handler's own JSON reply; the handler itself is
// not changed. Never throws and never delays the handler.
function captureWhatsapp(req, res) {
  try {
    const body = req.body || {};
    const buffer = req.file && req.file.buffer ? req.file.buffer
      : (body.fileBase64 || body.imageBase64) ? Buffer.from(String(body.fileBase64 || body.imageBase64), 'base64') : null;
    if (!buffer || !buffer.length) return;
    const chatId = String(body.chatId || '').trim();
    const channelId = String(body.channelId || '').trim();
    const fileName = body.fileName || body.filename || (req.file && req.file.originalname) || 'whatsapp-bill';
    const mime = body.mime || body.imageMime || (req.file && req.file.mimetype) || '';
    const receivedAt = new Date();

    const captured = (async () => {
      const r = await require('./inboundRouting').resolveInbound({ channelId, phone: chatId });
      if (!r || !r.allowed || !r.accountId) return null;
      return add({ accountId: r.accountId, channel: 'whatsapp', fileName, mime, buffer, sender: chatId ? '+' + chatId.replace(/\D/g, '') : null, receivedAt });
    })().catch((err) => { console.error('[archive] WhatsApp capture failed:', err.message); return null; });

    let settled = false;
    const settle = (payload) => {
      if (settled) return;
      settled = true;
      captured.then(async (id) => {
        if (!id) return;
        if (payload && payload.status === 'ignored') return drop(id);   // not this account's bill
        const outcomes = (payload && Array.isArray(payload.outcomes)) ? payload.outcomes : [];
        const first = outcomes[0] || payload || {};
        const bill = first.bill || {};
        const result = payload && !payload.error && outcomes.length ? combine(outcomes.map(outcomeResult)) : 'failed';
        await finish(id, { result, supplier: bill.supplier, invoiceNo: bill.invoiceNo });
      }).catch((err) => console.error('[archive] WhatsApp settle failed:', err.message));
    };

    const json = res.json.bind(res);
    res.json = (payload) => { settle(payload); return json(payload); };

    // If no reply comes (webhook.php gave up and the result went out over
    // WhatsApp), settleStale() files it from the bills table later.
  } catch (err) {
    console.error('[archive] WhatsApp capture skipped:', err.message);
  }
}

// WhatsApp files still without a result after WHATSAPP_SETTLE_MS: read what
// the handler wrote to the bills table for that sender since the file arrived.
// Runs every minute, so an app restart loses nothing. (Email files are settled
// by the email queue, which resumes after a restart.)
async function settleStale() {
  const rows = await db.query(
    `SELECT id, account_id, sender, created_at FROM drive_archive
     WHERE channel = 'whatsapp' AND ready = 0 AND created_at < NOW() - INTERVAL ? SECOND`,
    [Math.round(WHATSAPP_SETTLE_MS / 1000)]
  );
  const map = { success: 'created', pending: 'review', failed: 'failed' };
  for (const r of rows) {
    const chatId = String(r.sender || '').replace(/\D/g, '');
    // Both times are on the database's clock (created_at defaults to it).
    const bills = await db.query(
      `SELECT status, supplier, invoice_no FROM bills
       WHERE account_id = ? AND chat_id = ? AND created_at >= ? - INTERVAL 1 MINUTE
         AND created_at <= ? + INTERVAL ? SECOND ORDER BY id`,
      [r.account_id, chatId, r.created_at, r.created_at, Math.round(WHATSAPP_SETTLE_MS / 1000)]
    );
    await finish(r.id, {
      result: bills.length ? combine(bills.map((b) => map[b.status] || 'failed')) : 'failed',
      supplier: bills[0] && bills[0].supplier,
      invoiceNo: bills[0] && bills[0].invoice_no
    });
  }
}

// ── Pickup by the Gmail script ──────────────────────────────────────────────

function safe(s) {
  return String(s || '').replace(/[\\/]+/g, '-').replace(/[:*?"<>|#\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
}

function extFor(row) {
  const fromName = path.extname(row.file_name || '').toLowerCase();
  if (/^\.(pdf|jpe?g|png|webp|heic|heif|gif|tiff?)$/.test(fromName)) return fromName;
  const m = { 'application/pdf': '.pdf', 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp',
    'image/heic': '.heic', 'image/gif': '.gif', 'image/tiff': '.tiff' };
  return m[row.mime] || '';
}

// "2026-11-10 KSL PROPERTIES SDN BHD KSLP-R-IV-000232 - email #42.pdf"
function driveName(row) {
  const day = new Date(row.received_at).toLocaleDateString('en-CA', { timeZone: MY_TZ });
  const what = [safe(row.supplier), safe(row.invoice_no)].filter(Boolean).join(' ') || safe(path.parse(row.file_name).name) || 'bill';
  return `${day} ${what} - ${row.channel} #${row.id}${extFor(row)}`;
}

function monthFolder(row) {
  return new Date(row.received_at).toLocaleDateString('en-CA', { timeZone: MY_TZ }).slice(0, 7);
}

function waitingCount(accountId) {
  return db.getOne(
    'SELECT COUNT(*) AS n FROM drive_archive WHERE account_id = ? AND ready = 1 AND archived_at IS NULL',
    [accountId]
  ).then((r) => Number(r && r.n || 0));
}

async function stats(accountId) {
  const row = await db.getOne(
    `SELECT
       SUM(ready = 1 AND archived_at IS NULL) AS waiting,
       SUM(ready = 0) AS processing,
       SUM(archived_at >= UTC_TIMESTAMP() - INTERVAL 1 DAY) AS saved_day,
       MAX(archived_at) AS last_saved
     FROM drive_archive WHERE account_id = ?`,
    [accountId]
  );
  return {
    waiting: Number(row && row.waiting || 0),
    processing: Number(row && row.processing || 0),
    savedDay: Number(row && row.saved_day || 0),
    lastSavedAt: row && row.last_saved || null
  };
}

// Files the account never collected within KEEP_DAYS.
async function purge() {
  const old = await db.query(
    `SELECT id, stored_file FROM drive_archive
     WHERE archived_at IS NULL AND created_at < UTC_TIMESTAMP() - INTERVAL ${KEEP_DAYS} DAY`
  );
  for (const r of old) {
    await removeFile(r.stored_file);
    await db.execute('DELETE FROM drive_archive WHERE id = ?', [r.id]);
  }
  if (old.length) console.warn(`[archive] dropped ${old.length} file(s) never collected by a Gmail script within ${KEEP_DAYS} days`);
}

// Routes the Gmail script calls, authenticated with the account's API key.
function routes(app, resolveExternalAccount) {
  const owned = async (req, res) => {
    const account = await resolveExternalAccount(req, res);
    if (!account) return null;
    const row = await db.getOne('SELECT * FROM drive_archive WHERE id = ? AND account_id = ?', [Number(req.params.id), account.id]);
    if (!row) { res.status(404).json({ error: 'Not found.' }); return null; }
    return row;
  };
  const guard = (fn) => (req, res) => fn(req, res).catch((err) => {
    console.error(`[archive] ${req.method} ${req.path} failed:`, err.message);
    if (!res.headersSent) res.status(500).json({ error: 'Archive request failed.' });
  });

  // The next few files to save: where to put them and what to call them.
  app.get('/api/email/archive', guard(async (req, res) => {
    const account = await resolveExternalAccount(req, res);
    if (!account) return;
    const rows = await db.query(
      `SELECT * FROM drive_archive WHERE account_id = ? AND ready = 1 AND archived_at IS NULL
       ORDER BY id LIMIT ${PICKUP_BATCH}`,
      [account.id]
    );
    res.json({
      items: rows.map((r) => ({
        id: r.id, month: monthFolder(r), folder: RESULT_FOLDER[r.result] || 'Failed',
        name: driveName(r), mime: r.mime || 'application/octet-stream'
      }))
    });
  }));

  app.get('/api/email/archive/:id/file', guard(async (req, res) => {
    const row = await owned(req, res);
    if (!row) return;
    if (row.archived_at) return res.status(410).json({ error: 'Already saved to Drive.' });
    let buf;
    try { buf = await fsp.readFile(path.join(ARCHIVE_DIR, path.basename(row.stored_file || ''))); }
    catch {
      // Lost locally (disk cleared): nothing left to save, so stop offering it.
      await db.execute('UPDATE drive_archive SET archived_at = UTC_TIMESTAMP(), drive_file_id = ? WHERE id = ?', ['missing', row.id]);
      return res.status(410).json({ error: 'File no longer on the server.' });
    }
    res.type(row.mime || 'application/octet-stream').send(buf);
  }));

  app.post('/api/email/archive/:id/done', guard(async (req, res) => {
    const row = await owned(req, res);
    if (!row) return;
    const driveId = String((req.body || {}).driveFileId || '').slice(0, 128) || null;
    await db.execute('UPDATE drive_archive SET archived_at = UTC_TIMESTAMP(), drive_file_id = ?, stored_file = NULL WHERE id = ?', [driveId, row.id]);
    await removeFile(row.stored_file);
    res.json({ ok: true });
  }));
}

module.exports = {
  configure, enabledFor, add, finish, drop, combine, outcomeResult, captureWhatsapp, settleStale,
  routes, waitingCount, stats, purge,
  _test: { driveName, monthFolder }
};
