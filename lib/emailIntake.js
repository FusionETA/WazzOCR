// Email channel: supplier bills emailed to an account's Gmail mailbox.
//
// The mailbox is read by a Google Apps Script running inside that Gmail account
// (integrations/gmail-intake/Code.gs), the same way Signum Unidash does it. The
// script POSTs every attachment here with the account's external API key; we
// answer straight away and process in the background, so Apps Script's run-time
// limit never races the AI.
//
// Processing reuses the WhatsApp pipeline as it is — analyzeFileToBills (same
// prompt blocks, COA and org list) and processBillForChat (org matching,
// duplicate check, Xero draft) — and writes the same `bills` rows with
// source = 'email', so the monthly count, the Bills tab and the Unmatched tab
// all include email without any change to the WhatsApp code.
//
// When the org is unclear the bill goes to Unmatched and, if the account set a
// WhatsApp number, that number is asked with the existing numbered org picker
// (the picker queue is keyed by phone, so the reply resolves through the normal
// WhatsApp path).
//
//   const emailIntake = require('./lib/emailIntake');
//   emailIntake.mount(app, { ...functions from server.js });

const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const express = require('express');

const db = require('../db');
const store = require('../models/emailInbox');
const billsModel = require('../models/bills');
const accounts = require('../models/accounts');
const trialChannel = require('./trialChannel');
const channelPhones = require('../models/channelPhones');
const { attachUser, requireAuth } = require('../auth/middleware');
const driveArchive = require('./driveArchive');

// Kept in step with SCRIPT_VERSION in integrations/gmail-intake/Code.gs, so the
// Settings card can say when the pasted script is out of date.
const EXPECTED_SCRIPT_VERSION = '2026-11-10c';
const EMAIL_DIR = path.join(__dirname, '..', 'data', 'email');
const SCRIPT_TEMPLATE = path.join(__dirname, '..', 'integrations', 'gmail-intake', 'Code.gs');
const RECONCILE_EVERY_MS = 60 * 1000;
// Google's daily trigger run-time allowance on a free Gmail account.
const DAILY_TRIGGER_MINUTES = 90;
const ACCEPTED_MIME = /^(application\/pdf|image\/(jpeg|png|webp|heic|heif|gif|tiff))$/i;

let deps = null;

// ── Small helpers ───────────────────────────────────────────────────────────

// "Ah Seng <ahseng@mail.com>" → { name: 'Ah Seng', email: 'ahseng@mail.com' }
function parseFrom(raw) {
  const s = String(raw || '').trim();
  const m = s.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  if (m) return { name: m[1].trim() || null, email: m[2].trim().toLowerCase() };
  return { name: null, email: s.toLowerCase() || null };
}

function toDate(v) {
  const d = v ? new Date(v) : null;
  return d && !isNaN(d) ? d : new Date();
}

function xeroLink(o) {
  const x = o.xero || {};
  return x.url || x.xeroUrl || (x.invoiceId ? `https://go.xero.com/AccountsPayable/View.aspx?InvoiceID=${x.invoiceId}` : null);
}

async function saveEmailFile(buffer, fileName) {
  await fsp.mkdir(EMAIL_DIR, { recursive: true });
  const ext = path.extname(String(fileName || '')).slice(0, 10).replace(/[^.a-z0-9]/gi, '');
  const name = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`;
  await fsp.writeFile(path.join(EMAIL_DIR, name), buffer);
  return name;
}

async function removeEmailFile(name) {
  if (!name) return;
  try { await fsp.unlink(path.join(EMAIL_DIR, path.basename(name))); }
  catch (err) { if (err.code !== 'ENOENT') console.error('[email] could not delete stored file:', err.message); }
}

// The Wazzup channel this account's WhatsApp messages go out on: its own channel
// on a paid plan, the shared trial channel on trial. Null when it has none.
async function pickerChannelId(accountId) {
  try {
    const account = await accounts.getById(accountId);
    const dbId = await trialChannel.targetChannelForAccount(account);
    if (!dbId) return null;
    const row = await db.getOne("SELECT channel_id FROM wazzup_channels WHERE id = ? AND status = 'active'", [dbId]);
    return row ? row.channel_id : null;
  } catch (err) {
    console.error('[email] could not find a WhatsApp channel:', err.message);
    return null;
  }
}

async function whatsapp(accountId, phone, text) {
  if (!phone || !text) return false;
  const channelId = await pickerChannelId(accountId);
  if (!channelId) return false;
  return deps.sendChatText({ channelId, chatId: phone, text });
}

// ── Recording an outcome ────────────────────────────────────────────────────

// The same bills row the WhatsApp path writes (see logBillOutcomes), returning
// its id so the inbox row can follow it. xero-error is recorded as pending, not
// failed, so the bill can be retried from Unmatched in another org.
async function recordBill(accountId, fromEmail, o) {
  const b = o.bill || {};
  let status;
  let failureReason = null;
  if (deps.hasCreatedXeroBill(o)) status = 'success';
  else if (o.status === 'pending') { status = 'pending'; failureReason = o.pending && o.pending.reason; }
  else if (o.status === 'xero-error') { status = 'pending'; failureReason = `Xero rejected this bill: ${o.xeroError || 'unknown error'}`; }
  else return null;
  return billsModel.record({
    accountId,
    chatId: fromEmail || null,
    status,
    failureReason: failureReason ? String(failureReason).slice(0, 500) : null,
    supplier: b.supplier || null,
    invoiceNo: b.invoiceNo || null,
    total: b.total != null ? b.total : null,
    currency: b.currency || null,
    documentType: b.documentType || null,
    xeroInvoiceId: status === 'success' ? (o.xero && o.xero.invoiceId) || null : null,
    xeroUrl: status === 'success' ? xeroLink(o) : null,
    xeroTenantName: status === 'success' ? (o.xero && o.xero.tenantName) || (o.matchedTenant && o.matchedTenant.tenantName) || null : null,
    source: 'email',
    payload: status === 'pending' ? b : null
  });
}

// Inbox-row fields for one processBillForChat outcome.
function outcomeFields(o) {
  const b = (o && o.bill) || {};
  const base = {
    supplier: b.supplier || null,
    invoice_no: b.invoiceNo || null,
    total: b.total != null && !isNaN(Number(b.total)) ? Number(b.total) : null,
    currency: b.currency || null
  };
  if (!o || o.status === 'error') {
    return { ...base, status: 'failed', message: String((o && o.error && o.error.message) || (o && o.error) || 'Processing failed.').slice(0, 1000) };
  }
  if (deps.hasCreatedXeroBill(o)) {
    return { ...base, status: 'created', message: null,
      xero_tenant_name: (o.xero && o.xero.tenantName) || null, xero_url: xeroLink(o) };
  }
  switch (o.status) {
    case 'created':
      return { ...base, status: 'failed', message: 'Xero did not return an invoice ID for this bill.' };
    case 'duplicate':
      return { ...base, status: 'duplicate', message: 'Already in Xero — not created twice.',
        xero_tenant_name: (o.matchedTenant && o.matchedTenant.tenantName) || null };
    case 'pending':
      return { ...base, status: 'pending', pending_uuid: o.pending && o.pending.id,
        message: (o.pending && o.pending.reason) || 'Could not tell which Xero organisation this bill belongs to.' };
    case 'xero-error':
      return { ...base, status: 'pending', pending_uuid: o.pending && o.pending.id,
        message: `Xero rejected this bill: ${o.xeroError || 'unknown error'}`.slice(0, 1000),
        xero_tenant_name: (o.matchedTenant && o.matchedTenant.tenantName) || null };
    case 'no-xero':
      return { ...base, status: 'failed', message: 'Xero is not connected for this account.' };
    default:
      return { ...base, status: 'failed', message: `Bill was not created (${o.status || 'unknown'}).` };
  }
}

// ── Processing ──────────────────────────────────────────────────────────────

// One attachment at a time across the whole app: each is a Gemini call or two,
// and the WhatsApp path shares the same quota.
const queue = [];
let running = false;

function enqueue(attachmentId) {
  if (!queue.includes(attachmentId)) queue.push(attachmentId);
  if (!running) drain();
}

async function drain() {
  running = true;
  while (queue.length) {
    const id = queue.shift();
    try { await processAttachment(id); }
    catch (err) {
      console.error(`[email] attachment ${id} failed:`, err.message);
      try { await store.updateAttachment(id, { status: 'failed', message: String(err.message || err).slice(0, 1000) }); } catch { /* ignore */ }
    }
    try { await settleArchive(id); }
    catch (err) { console.error(`[email] Drive copy of attachment ${id} not settled:`, err.message); }
  }
  running = false;
}

// File the Drive copy under the result of every bill read from this file.
async function settleArchive(id) {
  const att = await store.getAttachment(id);
  if (!att || !att.archive_id || ['queued', 'processing'].includes(att.status)) return;
  const rows = await db.query(
    'SELECT status, supplier, invoice_no FROM email_attachments WHERE email_message_id = ? AND file_name = ? AND size = ? ORDER BY bill_index',
    [att.email_message_id, att.file_name, att.size]
  );
  const map = { created: 'created', pending: 'review', duplicate: 'duplicate', failed: 'failed', dismissed: 'failed' };
  await driveArchive.finish(att.archive_id, {
    result: driveArchive.combine(rows.map((r) => map[r.status] || 'failed')),
    supplier: rows[0] && rows[0].supplier,
    invoiceNo: rows[0] && rows[0].invoice_no
  });
}

async function processAttachment(id) {
  const att = await store.getAttachment(id);
  if (!att || !['queued', 'processing'].includes(att.status)) return;
  const accountId = att.account_id;
  const msg = await db.getOne('SELECT * FROM email_messages WHERE id = ?', [att.email_message_id]);
  const settings = await store.getSettings(accountId);
  await store.updateAttachment(id, { status: 'processing', message: null });

  let buffer;
  try { buffer = await fsp.readFile(path.join(EMAIL_DIR, path.basename(att.stored_file || ''))); }
  catch { return store.updateAttachment(id, { status: 'failed', message: 'The file was not kept on the server, so it cannot be read. Ask the sender to email it again.' }); }

  const mime = deps.sniffMime(buffer, att.mime || 'application/octet-stream');
  const from = msg ? (msg.from_name || msg.from_email || 'an email') : 'an email';
  const fromEmail = msg ? msg.from_email : null;

  // Only ask on WhatsApp when there is a number AND a channel to send it from;
  // otherwise the bill just waits in Unmatched.
  const pickerPhone = channelPhones.normalizePhone(settings.notify_phone) || null;
  const canAsk = Boolean(pickerPhone && await pickerChannelId(accountId));

  const failNotify = async (text) => {
    if (settings.notify_failures && pickerPhone) {
      await whatsapp(accountId, pickerPhone, `📧 *Emailed bill not processed*\nFrom: ${from}\nFile: ${att.file_name}\n${text}\n\nOpen WazzOCR → Email tab to retry or dismiss it.`);
    }
  };

  await deps.xeroAccountCtx.run({ accountId }, async () => {
    let knownOrgs = [];
    try {
      const { connections } = await deps.getValidConnections();
      knownOrgs = (connections || []).map((c) => c.tenantName).filter(Boolean);
    } catch (err) { console.error('[email] could not fetch Xero orgs (continuing):', err.message); }

    let bills;
    try {
      const out = await deps.analyzeFileToBills({ buffer, mime, knownOrgs });
      bills = out.bills;
    } catch (err) {
      const t = await deps.ticketReply({ stage: 'email-extraction', error: err, logCtx: { accountId, channelDbId: null }, chatId: fromEmail, fileName: att.file_name, mime });
      await store.updateAttachment(id, { status: 'failed', message: t.message });
      await failNotify(t.message);
      return;
    }
    if (!bills || !bills.length) {
      await store.updateAttachment(id, { status: 'failed', message: 'No bill or invoice was found in this document.' });
      return;
    }

    let anyFailed = false;
    for (let i = 0; i < bills.length; i++) {
      const fileName = await deps.saveUploadedBuffer(buffer, mime);
      const attachment = { filename: fileName, mime, originalName: att.file_name };
      let o;
      try {
        o = await deps.processBillForChat({ bill: bills[i], attachment, chatId: canAsk ? pickerPhone : null, source: 'email' });
      } catch (err) {
        await deps.deleteUploadedFile(fileName);
        o = { status: 'error', error: err, bill: bills[i] };
      }

      const fields = outcomeFields(o);
      try { fields.bill_id = await recordBill(accountId, fromEmail, o); }
      catch (err) { console.error('[email] bills record failed:', err.message); }
      if (i === 0) await store.updateAttachment(id, fields);
      else await store.addSiblingBill(att, i, fields);

      if (fields.status === 'failed') { anyFailed = true; await failNotify(fields.message); }

      // The org picker. processBillForChat queued the question under this phone;
      // `pickerAsk` is set only when it is the one to ask now (the rest are asked
      // as each answer comes back, by the existing WhatsApp reply path).
      if (o.pickerAsk && canAsk) {
        const head = await deps.peekPicker(pickerPhone);
        const item = head && head.pendingBillId === o.pickerAsk.pendingBillId ? head : o.pickerAsk;
        await whatsapp(accountId, pickerPhone, `📧 Bill received by email from ${from}\n\n${deps.formatPickerQuestion(item)}`);
      }
    }

    // Keep the original only while there is something to retry.
    if (!anyFailed) {
      await removeEmailFile(att.stored_file);
      await store.updateAttachment(id, { stored_file: null });
    }
  });
}

// ── Reconciliation ──────────────────────────────────────────────────────────
//
// A bill waiting on an org can be settled three ways, two of them outside this
// module: Resolve or Delete in the Unmatched tab (which touch only the bills
// row), or a WhatsApp reply to the picker (which touches only the pending-bills
// store). This brings the inbox row — and whichever side was left behind — in
// line, without changing either of those paths.

async function dropPending(att, phone) {
  if (!att.pending_uuid) return;
  try {
    const p = await deps.getPendingBill(att.pending_uuid);
    if (p) {
      await deps.removePendingBill(att.pending_uuid);
      if (p.attachedFile) await deps.deleteUploadedFile(p.attachedFile.filename);
    }
    if (phone) {
      const head = await deps.peekPicker(phone);
      const wasAsking = head && head.pendingBillId === att.pending_uuid;
      const next = await deps.advancePickerQueue(phone, att.pending_uuid);
      // Only when the open question was this bill does the next one need asking;
      // otherwise the head is unchanged and was asked already.
      if (wasAsking && next) await whatsapp(att.account_id, phone, deps.formatPickerQuestion(next));
    }
  } catch (err) { console.error('[email] could not clear the pending bill:', err.message); }
}

async function reconcile(accountId = null) {
  const rows = await store.allPending(accountId);
  if (!rows.length) return;
  let jsonBills = null;
  const phones = new Map();
  const phoneFor = async (acct) => {
    if (!phones.has(acct)) phones.set(acct, channelPhones.normalizePhone((await store.getSettings(acct)).notify_phone) || null);
    return phones.get(acct);
  };

  for (const att of rows) {
    try {
      const bill = att.bill_id ? await db.getOne('SELECT id, status, xero_url, xero_tenant_name FROM bills WHERE id = ? AND account_id = ?', [att.bill_id, att.account_id]) : null;

      if (att.bill_id && !bill) {
        // Deleted from Unmatched.
        await store.updateAttachment(att.id, { status: 'dismissed', message: 'Deleted from Unmatched.', resolved_by_user: 1, resolved_at: 'now' });
        await dropPending(att, await phoneFor(att.account_id));
        continue;
      }
      if (bill && bill.status === 'success') {
        // Resolved from Unmatched.
        await store.updateAttachment(att.id, { status: 'created', message: null, xero_tenant_name: bill.xero_tenant_name, xero_url: bill.xero_url, resolved_by_user: 1, resolved_at: 'now' });
        await dropPending(att, await phoneFor(att.account_id));
        continue;
      }
      if (att.pending_uuid && !(await deps.getPendingBill(att.pending_uuid))) {
        // Answered on WhatsApp: the picker created the bill and dropped the
        // pending entry. Find the bill it saved to mark the row created.
        // bills.json is newest first, and Xero refuses the same invoice twice, so
        // the first email picker record with this supplier and number is it.
        if (!jsonBills) jsonBills = await deps.loadBills();
        const hit = jsonBills.find((r) => String(r.source || '').startsWith('email') && /picker/.test(String(r.source || ''))
          && (r.invoiceNo || '') === (att.invoice_no || '')
          && (r.supplier || '') === (att.supplier || ''));
        if (hit) {
          if (bill) {
            await billsModel.markResolved(bill.id, att.account_id, { xeroInvoiceId: hit.invoiceId, xeroUrl: hit.xeroUrl, xeroTenantName: hit.tenantName });
          }
          await store.updateAttachment(att.id, { status: 'created', message: null, xero_tenant_name: hit.tenantName, xero_url: hit.xeroUrl, resolved_by_user: 1, resolved_at: 'now' });
        }
      }
    } catch (err) {
      console.error(`[email] reconcile of attachment ${att.id} failed:`, err.message);
    }
  }
}

// ── Inbox view model ────────────────────────────────────────────────────────

function needsAction(a) {
  return a.status === 'pending' || (a.status === 'failed' && Boolean(a.stored_file));
}

async function inboxView(accountId) {
  await reconcile(accountId);
  const [messages, month, settings] = await Promise.all([
    store.inbox(accountId, { limit: 200 }),
    store.monthStats(accountId),
    store.getSettings(accountId)
  ]);
  const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
  let open = 0, openValue = 0, reading = 0, received = 0;
  for (const m of messages) {
    if (new Date(m.received_at || m.created_at).getTime() >= dayAgo) received++;
    for (const a of m.attachments) {
      if (needsAction(a)) { open++; openValue += Number(a.total || 0); }
      if (a.status === 'queued' || a.status === 'processing') reading++;
    }
  }
  return {
    messages: messages.map((m) => ({
      id: m.id,
      from_name: m.from_name, from_email: m.from_email, subject: m.subject,
      received_at: m.received_at || m.created_at, skip_reason: m.skip_reason,
      attachments: m.attachments.map((a) => ({
        id: a.id, file_name: a.file_name, bill_index: a.bill_index, status: a.status, message: a.message,
        bill_id: a.bill_id, supplier: a.supplier, invoice_no: a.invoice_no,
        total: a.total != null ? Number(a.total) : null, currency: a.currency,
        xero_tenant_name: a.xero_tenant_name, xero_url: a.xero_url,
        resolved_by_user: Boolean(a.resolved_by_user),
        can_retry: a.status === 'failed' && Boolean(a.stored_file) && a.bill_index === 0,
        needs_action: needsAction(a)
      }))
    })),
    stats: { received24h: received, needsAction: open, needsActionValue: openValue, reading, ...month },
    channel: {
      enabled: Boolean(settings.enabled),
      gmailAddress: settings.gmail_address,
      lastHeartbeatAt: settings.last_heartbeat_at
    }
  };
}

// ── Routes ──────────────────────────────────────────────────────────────────

function intakeRoutes(app) {
  // Called by the Apps Script once per attachment (or once for an email with
  // nothing to read). Idempotent: the same file reported twice is ignored.
  app.post('/api/email/intake', async (req, res) => {
    try {
      const account = await deps.resolveExternalAccount(req, res);
      if (!account) return;
      const settings = await store.getSettings(account.id);
      if (!settings.enabled) return res.json({ ok: true, status: 'disabled' });

      const b = req.body || {};
      const gmailMessageId = String(b.gmailMessageId || '').trim().slice(0, 64);
      if (!gmailMessageId) return res.status(400).json({ error: 'gmailMessageId is required.' });
      const from = parseFrom(b.from);
      const message = await store.upsertMessage(account.id, {
        gmailMessageId,
        fromName: from.name ? from.name.slice(0, 255) : null,
        fromEmail: from.email ? from.email.slice(0, 255) : null,
        subject: b.subject,
        receivedAt: toDate(b.receivedAt),
        skipReason: b.skipped ? String(b.reason || 'Nothing to read in this email.').slice(0, 512) : null
      });
      if (b.skipped) return res.json({ ok: true, status: 'logged', messageId: message.id });

      const buffer = b.fileBase64 ? Buffer.from(String(b.fileBase64), 'base64') : null;
      if (!buffer || !buffer.length) return res.status(400).json({ error: 'fileBase64 is required.' });
      const fileName = String(b.fileName || 'attachment').slice(0, 255);
      const mime = deps.sniffMime(buffer, String(b.mimeType || 'application/octet-stream'));
      if (!ACCEPTED_MIME.test(mime)) {
        return res.json({ ok: true, status: 'unsupported', message: `${fileName} is not a PDF or photo.` });
      }

      const storedFile = await saveEmailFile(buffer, fileName);
      const { row, created } = await store.queueAttachment(account.id, message.id, { fileName, mime, size: buffer.length, storedFile });
      if (!created) {
        await removeEmailFile(storedFile);
        return res.json({ ok: true, status: 'already-received', attachmentId: row.id });
      }
      // The Drive copy is taken now, before processing, so a failed read is kept too.
      try {
        const archiveId = await driveArchive.add({
          accountId: account.id, channel: 'email', fileName, mime, buffer,
          sender: from.email, receivedAt: toDate(b.receivedAt)
        });
        if (archiveId) await store.updateAttachment(row.id, { archive_id: archiveId });
      } catch (err) { console.error('[email] Drive copy not taken:', err.message); }
      enqueue(row.id);
      res.status(202).json({ ok: true, status: 'queued', attachmentId: row.id });
    } catch (err) {
      console.error('[email] intake failed:', err.message);
      res.status(500).json({ error: 'Could not accept this email. It will be retried.' });
    }
  });

  // Liveness: the script calls this every run, even when the mailbox is quiet.
  app.post('/api/email/heartbeat', async (req, res) => {
    try {
      const account = await deps.resolveExternalAccount(req, res);
      if (!account) return;
      const hb = req.body || {};
      await store.heartbeat(account.id, hb.version);
      // The previous run's duration (scripts older than 2026-11-10b send none).
      const ms = Number(hb.lastRunMs);
      const at = hb.lastRunAt ? new Date(hb.lastRunAt) : null;
      if (ms > 0 && at && !isNaN(at)) await store.recordRun(account.id, at, ms);
      const settings = await store.getSettings(account.id);
      res.json({
        ok: true, enabled: Boolean(settings.enabled), expectedVersion: EXPECTED_SCRIPT_VERSION,
        // Files waiting to be saved to Drive, so a quiet run skips asking.
        archiveWaiting: settings.drive_archive ? await driveArchive.waitingCount(account.id) : 0
      });
    } catch (err) {
      console.error('[email] heartbeat failed:', err.message);
      res.status(500).json({ error: 'Heartbeat failed.' });
    }
  });
}

// Express 4 does not catch a rejected async handler; this sends the error back.
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch((err) => {
  console.error(`[email] ${req.method} ${req.path} failed:`, err.message);
  if (!res.headersSent) res.status(500).json({ error: err.message });
});

function dashboardRoutes(app) {
  const r = express.Router();
  r.use(attachUser, requireAuth);
  r.use((req, res, next) => {
    if (!req.user.account_id) return res.status(400).json({ error: 'This user has no account.' });
    next();
  });

  r.get('/inbox', async (req, res) => {
    try { res.json(await inboxView(req.user.account_id)); }
    catch (err) { console.error('[email] inbox failed:', err.message); res.status(500).json({ error: err.message }); }
  });

  r.get('/settings', wrap(async (req, res) => {
    const accountId = req.user.account_id;
    const s = await store.getSettings(accountId);
    const account = await accounts.getById(accountId);
    res.json({
      enabled: Boolean(s.enabled),
      gmailAddress: s.gmail_address || '',
      // Shown to everyone on the account so the team has the mailbox login in
      // one place. Not used by the intake (the script runs inside the mailbox).
      gmailPassword: s.gmail_password || '',
      notifyPhone: s.notify_phone || '',
      notifyFailures: Boolean(s.notify_failures),
      driveArchive: s.drive_archive == null ? true : Boolean(s.drive_archive),
      driveStats: await driveArchive.stats(accountId),
      scriptVersion: s.script_version,
      expectedScriptVersion: EXPECTED_SCRIPT_VERSION,
      lastHeartbeatAt: s.last_heartbeat_at,
      scriptUsage: { ...(await store.runUsage(accountId)), dailyLimitMinutes: DAILY_TRIGGER_MINUTES },
      hasApiKey: Boolean(account && account.external_api_key),
      hasWhatsAppChannel: Boolean(await pickerChannelId(accountId))
    });
  }));

  r.post('/settings', wrap(async (req, res) => {
    const b = req.body || {};
    const gmail = String(b.gmailAddress || '').trim().toLowerCase();
    if (gmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(gmail)) return res.status(400).json({ error: 'Enter a valid email address.' });
    const phone = channelPhones.normalizePhone(b.notifyPhone);
    if (b.notifyPhone && phone.length < 7) return res.status(400).json({ error: 'Enter the WhatsApp number in international format, digits only (e.g. 60123456789).' });
    await store.saveSettings(req.user.account_id, {
      enabled: b.enabled !== false, gmailAddress: gmail, gmailPassword: String(b.gmailPassword || '').slice(0, 200),
      notifyPhone: phone, notifyFailures: b.notifyFailures !== false, driveArchive: b.driveArchive !== false
    });
    res.json({ ok: true });
  }));

  // The Apps Script, ready to paste: this server's address and the account's API
  // key filled in. Generates the key on first use (same format as Admin's).
  r.get('/script', async (req, res) => {
    try {
      const accountId = req.user.account_id;
      let account = await accounts.getById(accountId);
      if (!account.external_api_key) {
        await accounts.update(accountId, { externalApiKey: crypto.randomBytes(24).toString('hex') });
        account = await accounts.getById(accountId);
      }
      const base = (process.env.PUBLIC_APP_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
      const template = await fsp.readFile(SCRIPT_TEMPLATE, 'utf8');
      const code = template
        .replace("'__WAZZOCR_API_BASE__'", JSON.stringify(base).replace(/"/g, "'"))
        .replace("'__WAZZOCR_API_KEY__'", `'${account.external_api_key}'`);
      res.type('text/plain').set('Content-Disposition', 'attachment; filename="WazzOCR-Gmail-Code.gs"').send(code);
    } catch (err) {
      console.error('[email] script download failed:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // Read a failed attachment again (the original is kept until it succeeds).
  r.post('/attachments/:id/retry', wrap(async (req, res) => {
    const att = await store.getAttachmentForAccount(Number(req.params.id), req.user.account_id);
    if (!att || att.status !== 'failed' || !att.stored_file || att.bill_index !== 0) {
      return res.status(400).json({ error: 'This attachment cannot be processed again.' });
    }
    await store.updateAttachment(att.id, { status: 'queued', message: null, resolved_by_user: 1 });
    enqueue(att.id);
    res.json({ ok: true });
  }));

  // Not a bill / not wanted: clears it from Needs action (and from Unmatched).
  r.post('/attachments/:id/dismiss', wrap(async (req, res) => {
    const accountId = req.user.account_id;
    const att = await store.getAttachmentForAccount(Number(req.params.id), accountId);
    if (!att || !['pending', 'failed'].includes(att.status)) {
      return res.status(400).json({ error: 'Only bills that need action can be dismissed.' });
    }
    if (att.bill_id) await billsModel.remove(accountId, att.bill_id);
    await dropPending(att, channelPhones.normalizePhone((await store.getSettings(accountId)).notify_phone) || null);
    await removeEmailFile(att.stored_file);
    await store.updateAttachment(att.id, { status: 'dismissed', message: 'Dismissed by you.', stored_file: null, resolved_by_user: 1, resolved_at: 'now' });
    res.json({ ok: true });
  }));

  app.use('/api/me/email', r);
}

// ── Mount ───────────────────────────────────────────────────────────────────

function mount(app, injected) {
  const needed = ['analyzeFileToBills', 'processBillForChat', 'xeroAccountCtx', 'getValidConnections',
    'saveUploadedBuffer', 'deleteUploadedFile', 'sendChatText', 'formatPickerQuestion', 'peekPicker',
    'advancePickerQueue', 'getPendingBill', 'removePendingBill', 'loadBills', 'ticketReply', 'sniffMime',
    'resolveExternalAccount', 'hasCreatedXeroBill'];
  const missing = needed.filter((k) => !injected || !injected[k]);
  if (missing.length) throw new Error(`emailIntake.mount: missing ${missing.join(', ')}`);
  deps = injected;
  driveArchive.configure({ sniffMime: deps.sniffMime });
  intakeRoutes(app);
  driveArchive.routes(app, deps.resolveExternalAccount);
  dashboardRoutes(app);

  // Without a database there is nothing to do (local runs without .env).
  if (!process.env.DB_HOST) {
    console.warn('[email] DB_HOST not set — email channel routes mounted, background work off.');
    return;
  }
  // Pick up work a restart interrupted, then keep pending rows in step.
  store.unfinished()
    .then((rows) => rows.forEach((r) => enqueue(r.id)))
    .catch((err) => console.error('[email] could not resume unfinished attachments:', err.message));
  const timer = setInterval(() => {
    reconcile().catch((err) => console.error('[email] reconcile failed:', err.message));
    driveArchive.settleStale().catch((err) => console.error('[archive] settle failed:', err.message));
  }, RECONCILE_EVERY_MS);
  if (timer.unref) timer.unref();
  const daily = setInterval(() => {
    driveArchive.purge().catch((err) => console.error('[archive] purge failed:', err.message));
  }, 24 * 60 * 60 * 1000);
  if (daily.unref) daily.unref();
}

module.exports = { mount, EXPECTED_SCRIPT_VERSION, _test: { parseFrom, outcomeFields, needsAction } };
