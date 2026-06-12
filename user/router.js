// User-facing (non-admin) API. Scoped to the logged-in user's own account.
//   GET /api/me/summary  -> { user, account, successCount }
const express = require('express');
const router = express.Router();

const db = require('../db');
const coa = require('../models/coa');
const bills = require('../models/bills');
const wazzupChannels = require('../models/wazzupChannels');
const xeroConnections = require('../models/xeroConnections');
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
    "SELECT COUNT(*) AS n FROM bills WHERE account_id = ? AND status = 'success'",
    [u.account_id]
  );
  res.json({
    user: { id: u.id, email: u.email, name: u.name, isSuperAdmin: false },
    account: req.account ? { id: req.account.id, name: req.account.name } : null,
    successCount: row ? Number(row.n) : 0
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

// Connected Wazzup channels (read-only for the user).
router.get('/channels', async (req, res) => {
  const accountId = needAccount(req, res); if (!accountId) return;
  res.json({ channels: await wazzupChannels.listByAccount(accountId) });
});

// Connected Xero organisations.
router.get('/connections', async (req, res) => {
  const accountId = needAccount(req, res); if (!accountId) return;
  res.json({ connections: await xeroConnections.listByAccount(accountId) });
});

// Recent bill attempts for this account.
router.get('/bills', async (req, res) => {
  const accountId = needAccount(req, res); if (!accountId) return;
  res.json({ bills: await bills.recent(accountId, req.query.limit) });
});

module.exports = router;
