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

// One-click: point this channel's Wazzup account at our webhook.php.
router.post('/accounts/:id/channels/:cid/register-webhook', async (req, res) => {
  const apiKey = await wazzupChannels.getDecryptedApiKey(Number(req.params.id), Number(req.params.cid));
  if (!apiKey) return res.status(400).json({ error: 'No API key stored for this channel. Add the API key first.' });
  const result = await wazzup.registerWebhook(apiKey, process.env.PUBLIC_WEBHOOK_URL);
  if (!result.ok) return res.status(502).json({ error: result.error });
  res.json({ ok: true });
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
