// User-facing (non-admin) API. Scoped to the logged-in user's own account.
//   GET /api/me/summary  -> { user, account, successCount }
const express = require('express');
const router = express.Router();

const db = require('../db');
const coa = require('../models/coa');
const bills = require('../models/bills');
const wazzupChannels = require('../models/wazzupChannels');
const xeroConnections = require('../models/xeroConnections');
const wazzup = require('../lib/wazzup');
const { parseCoa } = require('../lib/csv');
const { attachUser, requireAuth } = require('../auth/middleware');

router.use(attachUser, requireAuth);

// Guard: most endpoints below need the user to belong to an account.
function needAccount(req, res) {
  if (!req.user.account_id) { res.status(400).json({ error: 'This user has no account.' }); return null; }
  return req.user.account_id;
}

router.get('/summary', async (req, res) => {
  const u = req.user;
  // Super admins have no account of their own.
  if (!u.account_id) {
    return res.json({
      user: { id: u.id, email: u.email, name: u.name, isSuperAdmin: true },
      account: null,
      successCount: 0
    });
  }
  const row = await db.getOne(
    `SELECT
        COUNT(*) AS total,
        SUM(created_at >= DATE_FORMAT(NOW(), '%Y-%m-01')) AS this_month
     FROM bills WHERE account_id = ? AND status = 'success'`,
    [u.account_id]
  );
  res.json({
    user: { id: u.id, email: u.email, name: u.name, isSuperAdmin: false },
    account: req.account ? { id: req.account.id, name: req.account.name } : null,
    successCount: row ? Number(row.total) : 0,
    successThisMonth: row ? Number(row.this_month || 0) : 0
  });
});

// Chart of accounts (read + CSV upload).
router.get('/coa', async (req, res) => {
  const accountId = needAccount(req, res); if (!accountId) return;
  res.json({ accounts: await coa.list(accountId) });
});

router.post('/coa', async (req, res) => {
  const accountId = needAccount(req, res); if (!accountId) return;
  const csv = (req.body && req.body.csv) || '';
  if (!csv.trim()) return res.status(400).json({ error: 'No CSV provided.' });
  const rows = parseCoa(csv);
  if (!rows.length) return res.status(400).json({ error: 'No valid rows found. Expected columns: code, name, category.' });
  const count = await coa.replaceAll(accountId, rows);
  res.json({ ok: true, count });
});

// Download the COA as a CSV the customer can edit and re-upload. Includes the
// rows already loaded (so they just add new ones); falls back to an example row
// when the account has no COA yet, so it doubles as the blank template.
router.get('/coa.csv', async (req, res) => {
  const accountId = needAccount(req, res); if (!accountId) return;
  const rows = await coa.list(accountId);
  const cell = (v) => { const s = String(v == null ? '' : v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const lines = ['code,name,category'];
  if (rows.length) for (const r of rows) lines.push([r.code, r.name, r.category].map(cell).join(','));
  else lines.push('926-0000,Utilities Expenses,Expense');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="chart-of-accounts.csv"');
  res.send(lines.join('\n') + '\n');
});

// Wazzup channels — customers who self-manage can add/remove their own.
router.get('/channels', async (req, res) => {
  const accountId = needAccount(req, res); if (!accountId) return;
  res.json({ channels: await wazzupChannels.listByAccount(accountId) });
});

router.post('/channels', async (req, res) => {
  const accountId = needAccount(req, res); if (!accountId) return;
  const { channelId, apiKey, label } = req.body || {};
  if (!channelId) return res.status(400).json({ error: 'Channel ID is required.' });
  try {
    const id = await wazzupChannels.add(accountId, { channelId, apiKey, label });
    res.json({ ok: true, id });
  } catch (err) {
    const dup = /Duplicate/.test(err.message);
    res.status(dup ? 409 : 500).json({ error: dup ? 'That channel is already linked to an account.' : err.message });
  }
});

router.delete('/channels/:id', async (req, res) => {
  const accountId = needAccount(req, res); if (!accountId) return;
  const removed = await wazzupChannels.remove(accountId, Number(req.params.id));
  res.json({ ok: true, removed });
});

// Reveal the full (decrypted) API key for one of this account's channels.
router.get('/channels/:id/api-key', async (req, res) => {
  const accountId = needAccount(req, res); if (!accountId) return;
  const apiKey = await wazzupChannels.getDecryptedApiKey(accountId, Number(req.params.id));
  if (!apiKey) return res.status(404).json({ error: 'No API key stored for this channel.' });
  res.json({ apiKey });
});

// One-click: point this channel's Wazzup account at our webhook.php.
router.post('/channels/:id/register-webhook', async (req, res) => {
  const accountId = needAccount(req, res); if (!accountId) return;
  const apiKey = await wazzupChannels.getDecryptedApiKey(accountId, Number(req.params.id));
  if (!apiKey) return res.status(400).json({ error: 'No API key stored for this channel. Add the API key first.' });
  const result = await wazzup.registerWebhook(apiKey, process.env.PUBLIC_WEBHOOK_URL);
  if (!result.ok) return res.status(502).json({ error: result.error });
  await wazzupChannels.markWebhookRegistered(accountId, Number(req.params.id));
  res.json({ ok: true });
});

// Connected Xero organisations.
router.get('/connections', async (req, res) => {
  const accountId = needAccount(req, res); if (!accountId) return;
  res.json({ connections: await xeroConnections.listByAccount(accountId) });
});

// Disconnect one org: revoke it at Xero, then remove it locally.
router.delete('/connections/:id', async (req, res) => {
  const accountId = needAccount(req, res); if (!accountId) return;
  try {
    const result = await require('../lib/xeroRevoke').disconnectOrg(accountId, Number(req.params.id));
    res.json(result);
  } catch (err) {
    res.status(err.message === 'Connection not found.' ? 404 : 500).json({ error: err.message });
  }
});

// Recent bill attempts for this account. Optional ?status=success|pending|failed.
router.get('/bills', async (req, res) => {
  const accountId = needAccount(req, res); if (!accountId) return;
  res.json({ bills: await bills.recent(accountId, req.query.limit, req.query.status) });
});

// Delete an unmatched/pending (or failed) bill. Created (success) bills are protected.
router.delete('/bills/:id', async (req, res) => {
  const accountId = needAccount(req, res); if (!accountId) return;
  const removed = await bills.remove(accountId, Number(req.params.id));
  if (!removed) return res.status(404).json({ error: 'Bill not found, or it is a created bill that cannot be deleted.' });
  res.json({ ok: true, removed });
});

module.exports = router;
