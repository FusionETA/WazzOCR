// Critical-error notifier for WazzOCR. Mirrors ClaimGuard's lib/error-notify.ts:
// when the pipeline fails, we (1) record a support ticket, (2) WhatsApp an alert
// to the on-call admin phone(s), and (3) hand back a generic, client-safe message
// carrying the ticket code. The customer never sees the raw error again.
//
// Env:
//   WAZZUP_ERROR_NOTIFY_PHONES  comma-separated admin phones in international
//                               digits-only form ("60123456789,60198765432").
//                               Empty → tickets still recorded, no WhatsApp alert.
//   FUSION_WAZZUP_* / WAZZUP_*  used by lib/wazzup.js to send from the system channel.
//
// reportError() NEVER throws — a failing notifier must not turn an already-failed
// request into a worse one. If even the DB insert fails it still returns a code so
// the client gets a consistent message.

const wazzup = require('./wazzup');
const tickets = require('../models/supportTickets');

// In-memory dedupe so one repeatedly-failing thing doesn't spam the on-call phone.
const recentlyAlerted = new Map(); // key -> timestamp(ms)
const DEDUPE_WINDOW_MS = 10 * 60 * 1000;
const MAX_TRACKED = 200;

function recipients() {
  const raw = (process.env.WAZZUP_ERROR_NOTIFY_PHONES || '').trim();
  if (!raw) return [];
  return raw.split(',').map((s) => s.replace(/[^\d]/g, '')).filter(Boolean);
}

function pruneStale(now) {
  if (recentlyAlerted.size <= MAX_TRACKED) return;
  const cutoff = now - DEDUPE_WINDOW_MS;
  for (const [k, t] of recentlyAlerted) if (t < cutoff) recentlyAlerted.delete(k);
}

// The generic, client-facing message. Single source of truth so server.js and
// the webhook ticket endpoint stay consistent.
function clientMessage(code) {
  return (
    '⚠️ Sorry — something went wrong while processing your message, and our team ' +
    'has automatically been notified.\n\n' +
    (code ? `Your reference: *${code}*\nPlease quote this code when you contact us so we can help you faster.` :
            'Please try again shortly, or contact us if it keeps happening.')
  );
}

function adminAlertText({ code, stage, accountLabel, chatId, fileName, errMsg }) {
  const lines = [`🚨 WazzOCR error — ${code || '(no ticket)'}`];
  if (accountLabel) lines.push(`account: ${accountLabel}`);
  lines.push(`stage: ${stage || 'other'}`);
  if (chatId) lines.push(`chat: ${chatId}`);
  if (fileName) lines.push(`file: ${fileName}`);
  lines.push('');
  lines.push(`Error: ${String(errMsg || 'unknown').slice(0, 500)}`);
  return lines.join('\n').slice(0, 900);
}

// Main entry. Returns { code, id, clientMessage } — always, even on internal failure.
async function reportError({ stage = 'other', error = null, context = {} } = {}) {
  const errMsg = error && error.message ? error.message : String(error || 'Unknown error');
  const {
    accountId = null, accountName = null, channelDbId = null, chatId = null,
    fileName = null, mime = null, model = null, ocrText = null
  } = context || {};

  // 1) Record the ticket (best-effort).
  let code = null;
  let id = null;
  try {
    const detail = {};
    if (error && error.stack) detail.stack = String(error.stack).split('\n').slice(0, 8).join('\n');
    if (fileName) detail.fileName = fileName;
    if (mime) detail.mime = mime;
    if (model) detail.model = model;
    if (ocrText) detail.ocrSnippet = String(ocrText).slice(0, 1000);
    const created = await tickets.create({
      accountId, channelDbId, chatId, stage,
      clientMessage: 'Generic error message shown to client (with ticket code).',
      errorMessage: errMsg,
      errorDetail: Object.keys(detail).length ? detail : null
    });
    id = created.id;
    code = created.code;
  } catch (dbErr) {
    // DB unreachable — still mint an ephemeral code so the client gets a reference,
    // and the admin alert below still carries the raw error.
    console.error('[errorNotify] ticket insert failed:', dbErr.message);
    try { code = tickets.randomCode(); } catch { code = null; }
  }

  // 2) Fire the admin WhatsApp alert (deduped, fire-and-forget, never throws).
  try {
    const phones = recipients();
    if (phones.length) {
      const now = Date.now();
      const key = `${stage}|${errMsg}`;
      const seen = recentlyAlerted.get(key);
      if (!seen || now - seen >= DEDUPE_WINDOW_MS) {
        recentlyAlerted.set(key, now);
        pruneStale(now);
        const accountLabel = accountName
          ? `${accountName}${accountId ? ` (#${accountId})` : ''}`
          : (accountId ? `#${accountId}` : null);
        const text = adminAlertText({ code, stage, accountLabel, chatId, fileName, errMsg });
        for (const to of phones) {
          // sendSystemMessage already swallows HTTP errors and returns false.
          Promise.resolve(wazzup.sendSystemMessage(to, text)).catch((e) =>
            console.error('[errorNotify] alert send failed:', e && e.message));
        }
      }
    } else {
      console.warn('[errorNotify] WAZZUP_ERROR_NOTIFY_PHONES empty — error not alerted:', stage, errMsg);
    }
  } catch (alertErr) {
    console.error('[errorNotify] alert path failed:', alertErr.message);
  }

  return { code, id, clientMessage: clientMessage(code) };
}

module.exports = { reportError, clientMessage };
