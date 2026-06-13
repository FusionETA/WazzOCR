// Admin HTTP routes (FusionETA super admins only).
//   GET  /admin/accounts                 list accounts
//   POST /admin/accounts                 { name }                 create account
//   GET  /admin/accounts/:id             account detail + stats
//   POST /admin/accounts/:id/invite      { email, phone, name }   invite a user (WhatsApp)
const express = require('express');
const router = express.Router();

const db = require('../db');
const accounts = require('../models/accounts');
const users = require('../models/users');
const bills = require('../models/bills');
const coa = require('../models/coa');
const wazzupChannels = require('../models/wazzupChannels');
const xeroConnections = require('../models/xeroConnections');
const appSettings = require('../models/appSettings');
const aiPrompts = require('../models/aiPrompts');
const invites = require('../auth/invites');
const wazzup = require('../lib/wazzup');
const { parseCoa } = require('../lib/csv');
const { attachUser, requireAuth, requireSuperAdmin } = require('../auth/middleware');

const GENERAL_PROMPT_KEY = 'general_ai_prompt';

router.use(attachUser, requireAuth, requireSuperAdmin);

router.get('/accounts', async (req, res) => {
  res.json({ accounts: await accounts.list() });
});

// Global general AI prompt (shared base for all accounts).
router.get('/settings/general-prompt', async (req, res) => {
  res.json({ generalPrompt: await appSettings.get(GENERAL_PROMPT_KEY, '') });
});
router.put('/settings/general-prompt', async (req, res) => {
  await appSettings.set(GENERAL_PROMPT_KEY, String((req.body && req.body.generalPrompt) || ''));
  res.json({ ok: true });
});

// ── AI prompt blocks (modular general + per-account add-on prompts) ──
// General blocks (account_id NULL) apply to every account.
router.get('/prompts', async (req, res) => {
  res.json({ prompts: await aiPrompts.listGeneral() });
});
router.post('/prompts', async (req, res) => {
  const { title, body, enabled } = req.body || {};
  if (!title || !title.trim()) return res.status(400).json({ error: 'Title is required.' });
  const id = await aiPrompts.create({ accountId: null, title, body, enabled: enabled !== false });
  res.json({ ok: true, id });
});
// Per-account add-on blocks.
router.get('/accounts/:id/prompts', async (req, res) => {
  res.json({ prompts: await aiPrompts.listByAccount(Number(req.params.id)) });
});
router.post('/accounts/:id/prompts', async (req, res) => {
  const accountId = Number(req.params.id);
  if (!(await accounts.getById(accountId))) return res.status(404).json({ error: 'Account not found.' });
  const { title, body, enabled } = req.body || {};
  if (!title || !title.trim()) return res.status(400).json({ error: 'Title is required.' });
  const id = await aiPrompts.create({ accountId, title, body, enabled: enabled !== false });
  res.json({ ok: true, id });
});
// Update / delete any block by id (works for both general and per-account).
router.put('/prompts/:pid', async (req, res) => {
  const updated = await aiPrompts.update(Number(req.params.pid), req.body || {});
  res.json({ ok: true, updated });
});
router.delete('/prompts/:pid', async (req, res) => {
  const removed = await aiPrompts.remove(Number(req.params.pid));
  res.json({ ok: true, removed });
});

router.post('/accounts', async (req, res) => {
  const { name } = req.body || {};
  if (!name) return res.status(400).json({ error: 'Account name is required.' });
  const id = await accounts.create({ name });
  res.json({ ok: true, accountId: id });
});

// Account detail with per-status bill counts (the admin drilldown data).
router.get('/accounts/:id', async (req, res) => {
  const accountId = Number(req.params.id);
  const account = await accounts.getById(accountId);
  if (!account) return res.status(404).json({ error: 'Account not found.' });
  const statusCounts = await db.query(
    'SELECT status, COUNT(*) AS n FROM bills WHERE account_id = ? GROUP BY status',
    [accountId]
  );
  const monthRow = await db.getOne(
    "SELECT COUNT(*) AS n FROM bills WHERE account_id = ? AND status = 'success' AND created_at >= DATE_FORMAT(NOW(), '%Y-%m-01')",
    [accountId]
  );
  const failureReasons = await db.query(
    `SELECT failure_reason, COUNT(*) AS n FROM bills
     WHERE account_id = ? AND status = 'failed'
     GROUP BY failure_reason ORDER BY n DESC LIMIT 20`,
    [accountId]
  );
  const accountUsers = await users.listByAccount(accountId);
  const channels = await wazzupChannels.listByAccount(accountId);
  const connections = await xeroConnections.listByAccount(accountId);
  const coaCount = (await coa.list(accountId)).length;
  res.json({
    account,
    statusCounts,
    successThisMonth: monthRow ? Number(monthRow.n) : 0,
    failureReasons,
    channels,
    connections,
    coaCount,
    users: accountUsers.map((u) => ({
      id: u.id, email: u.email, name: u.name, status: u.status, role: u.role
    }))
  });
});

// Update account configuration (AI model, prompt add-on, status, etc.).
router.put('/accounts/:id', async (req, res) => {
  const accountId = Number(req.params.id);
  if (!(await accounts.getById(accountId))) return res.status(404).json({ error: 'Account not found.' });
  const affected = await accounts.update(accountId, req.body || {});
  res.json({ ok: true, updated: affected });
});

// Recent bill attempts for the drilldown.
router.get('/accounts/:id/bills', async (req, res) => {
  res.json({ bills: await bills.recent(Number(req.params.id), req.query.limit) });
});

// Monthly analytics series (last 12 months) for the Stats charts.
//   processed = every bill row (≈ one Gemini extraction run per document → AI usage)
//   created   = bills successfully pushed to Xero
//   amount    = total MYR of created bills
router.get('/accounts/:id/analytics', async (req, res) => {
  const accountId = Number(req.params.id);
  if (!(await accounts.getById(accountId))) return res.status(404).json({ error: 'Account not found.' });
  const rows = await db.query(
    `SELECT DATE_FORMAT(created_at, '%Y-%m') AS ym,
            SUM(status = 'success')                                AS created,
            COUNT(*)                                               AS processed,
            SUM(CASE WHEN status = 'success' THEN total ELSE 0 END) AS amount
       FROM bills
      WHERE account_id = ?
        AND created_at >= DATE_FORMAT(DATE_SUB(NOW(), INTERVAL 11 MONTH), '%Y-%m-01')
      GROUP BY ym ORDER BY ym`,
    [accountId]
  );
  // AI token usage → cost (derived from token counts × price table).
  const aiUsage = require('../models/aiUsage');
  const pricing = require('../lib/geminiPricing');
  const aiMonthlyRows = await aiUsage.monthlyByModel(accountId);
  const aiTotalsRows = await aiUsage.totalsByModel(accountId);
  const round2 = (n) => Math.round(n * 100) / 100;
  const aiByMonth = {};
  for (const r of aiMonthlyRows) {
    const b = aiByMonth[r.ym] || (aiByMonth[r.ym] = { tokens: 0, costMyr: 0 });
    b.tokens += Number(r.ttl || 0);
    b.costMyr += pricing.costMyr(r.model, r.pin, r.pout);
  }
  let totalTokens = 0, totalCostMyr = 0;
  for (const r of aiTotalsRows) { totalTokens += Number(r.ttl || 0); totalCostMyr += pricing.costMyr(r.model, r.pin, r.pout); }

  res.json({
    monthly: rows.map((r) => ({
      ym: r.ym, created: Number(r.created || 0), processed: Number(r.processed || 0), amount: Number(r.amount || 0)
    })),
    ai: {
      monthly: Object.entries(aiByMonth).map(([ym, v]) => ({ ym, tokens: v.tokens, costMyr: round2(v.costMyr) })),
      totalTokens, totalCostMyr: round2(totalCostMyr), myrPerUsd: pricing.myrPerUsd()
    }
  });
});

// Wazzup channels (the routing key). Add / remove.
router.post('/accounts/:id/channels', async (req, res) => {
  const accountId = Number(req.params.id);
  const { channelId, apiKey, label } = req.body || {};
  if (!channelId) return res.status(400).json({ error: 'channelId is required.' });
  if (!(await accounts.getById(accountId))) return res.status(404).json({ error: 'Account not found.' });
  try {
    const id = await wazzupChannels.add(accountId, { channelId, apiKey, label });
    res.json({ ok: true, id });
  } catch (err) {
    const dup = /Duplicate/.test(err.message);
    res.status(dup ? 409 : 500).json({ error: dup ? 'That channel is already linked to an account.' : err.message });
  }
});
router.delete('/accounts/:id/channels/:cid', async (req, res) => {
  const removed = await wazzupChannels.remove(Number(req.params.id), Number(req.params.cid));
  res.json({ ok: true, removed });
});

// Reveal the full (decrypted) API key for one channel (for the View modal).
router.get('/accounts/:id/channels/:cid/api-key', async (req, res) => {
  const apiKey = await wazzupChannels.getDecryptedApiKey(Number(req.params.id), Number(req.params.cid));
  if (!apiKey) return res.status(404).json({ error: 'No API key stored for this channel.' });
  res.json({ apiKey });
});

// One-click: point this channel's Wazzup account at our webhook.php.
router.post('/accounts/:id/channels/:cid/register-webhook', async (req, res) => {
  const apiKey = await wazzupChannels.getDecryptedApiKey(Number(req.params.id), Number(req.params.cid));
  if (!apiKey) return res.status(400).json({ error: 'No API key stored for this channel. Add the API key first.' });
  const result = await wazzup.registerWebhook(apiKey, process.env.PUBLIC_WEBHOOK_URL);
  if (!result.ok) return res.status(502).json({ error: result.error });
  res.json({ ok: true });
});

// Disconnect one of an account's Xero orgs: revoke at Xero, then remove locally.
router.delete('/accounts/:id/connections/:cid', async (req, res) => {
  const accountId = Number(req.params.id);
  if (!(await accounts.getById(accountId))) return res.status(404).json({ error: 'Account not found.' });
  try {
    const result = await require('../lib/xeroRevoke').disconnectOrg(accountId, Number(req.params.cid));
    res.json(result);
  } catch (err) {
    res.status(err.message === 'Connection not found.' ? 404 : 500).json({ error: err.message });
  }
});

// Admin can also upload an account's COA (CSV: code, name, category).
router.post('/accounts/:id/coa', async (req, res) => {
  const accountId = Number(req.params.id);
  if (!(await accounts.getById(accountId))) return res.status(404).json({ error: 'Account not found.' });
  const rows = parseCoa((req.body && req.body.csv) || '');
  if (!rows.length) return res.status(400).json({ error: 'No valid rows. Expected columns: code, name, category.' });
  const count = await coa.replaceAll(accountId, rows);
  res.json({ ok: true, count });
});

// Download the account's COA as CSV — prefilled with its current rows (so admins
// edit and re-upload), or a single example row as a blank template if empty.
router.get('/accounts/:id/coa.csv', async (req, res) => {
  const accountId = Number(req.params.id);
  if (!(await accounts.getById(accountId))) return res.status(404).json({ error: 'Account not found.' });
  const rows = await coa.list(accountId);
  const cell = (v) => { const s = String(v == null ? '' : v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const lines = ['code,name,category'];
  if (rows.length) for (const r of rows) lines.push([r.code, r.name, r.category].map(cell).join(','));
  else lines.push('926-0000,Utilities Expenses,Expense');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="chart-of-accounts.csv"');
  res.send(lines.join('\n') + '\n');
});

// Invite a user to an account: create (or reuse) the user, then WhatsApp the link.
router.post('/accounts/:id/invite', async (req, res) => {
  const accountId = Number(req.params.id);
  const { email, phone, name } = req.body || {};
  if (!email || !phone) return res.status(400).json({ error: 'Email and phone are required.' });
  const account = await accounts.getById(accountId);
  if (!account) return res.status(404).json({ error: 'Account not found.' });

  let user = await users.getByEmail(email);
  let userId;
  if (user) {
    userId = user.id; // reuse existing (e.g. re-invite)
  } else {
    userId = await users.createInvited({ accountId, email, phone, name });
  }
  const { link, sent } = await invites.sendInvite(userId);
  // Return the link only if the WhatsApp send failed, so the admin can share it manually.
  res.json({ ok: true, userId, sent, link: sent ? undefined : link });
});

module.exports = router;
