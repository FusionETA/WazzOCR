// Auth HTTP routes (email/password). Google OAuth is added later.
//   POST /auth/login    { email, password }
//   POST /auth/logout
//   GET  /auth/me
//   POST /auth/claim    { token, password }   (accept invite, set password, log in)
//   POST /auth/forgot   { email }             (send reset link over WhatsApp)
//   POST /auth/reset    { token, password }
const express = require('express');
const router = express.Router();

const users = require('../models/users');
const sessions = require('./sessions');
const invites = require('./invites');
const { hashPassword, verifyPassword } = require('./passwords');
const { attachUser, requireAuth, setSessionCookie, clearSessionCookie } = require('./middleware');

router.use(attachUser);

// Basic per-key rate limit (10 tries / 15 min) to slow brute force.
const attempts = new Map();
function rateLimited(key) {
  const now = Date.now();
  const rec = attempts.get(key) || { count: 0, ts: now };
  if (now - rec.ts > 15 * 60 * 1000) { rec.count = 0; rec.ts = now; }
  rec.count += 1;
  attempts.set(key, rec);
  return rec.count > 10;
}

function publicUser(u) {
  return {
    id: u.id, email: u.email, name: u.name, role: u.role,
    isSuperAdmin: Boolean(u.is_super_admin), accountId: u.account_id
  };
}

router.post('/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required.' });
  if (rateLimited('login:' + String(email).toLowerCase())) {
    return res.status(429).json({ error: 'Too many attempts. Please try again later.' });
  }
  const user = await users.getByEmail(email);
  const ok = user && user.password_hash && user.status !== 'disabled'
    && await verifyPassword(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: 'Invalid email or password.' });

  const raw = await sessions.create(user.id, { ip: req.ip, userAgent: req.headers['user-agent'] });
  setSessionCookie(req, res, raw);
  await users.markLogin(user.id);
  res.json({ ok: true, user: publicUser(user) });
});

router.post('/logout', requireAuth, async (req, res) => {
  await sessions.destroy(req.sessionToken);
  clearSessionCookie(res);
  res.json({ ok: true });
});

router.get('/me', requireAuth, (req, res) => {
  res.json({
    user: publicUser(req.user),
    account: req.account ? { id: req.account.id, name: req.account.name } : null
  });
});

// Accept an invite: set the password, activate, and log in.
router.post('/claim', async (req, res) => {
  const { token, password } = req.body || {};
  if (!token || !password) return res.status(400).json({ error: 'Token and password are required.' });
  const userId = await invites.consumeToken(token, 'invite');
  if (!userId) return res.status(400).json({ error: 'This invite link is invalid or has expired.' });
  await users.setPasswordHash(userId, await hashPassword(password));
  const raw = await sessions.create(userId, { ip: req.ip, userAgent: req.headers['user-agent'] });
  setSessionCookie(req, res, raw);
  await users.markLogin(userId);
  const user = await users.getById(userId);
  res.json({ ok: true, user: publicUser(user) });
});

// Request a reset link. Always returns ok to avoid leaking which emails exist.
router.post('/forgot', async (req, res) => {
  const { email } = req.body || {};
  try {
    const user = email && await users.getByEmail(email);
    if (user && user.phone_number) await invites.sendPasswordReset(user.id);
  } catch (err) {
    console.error('[auth] forgot error:', err.message);
  }
  res.json({ ok: true });
});

router.post('/reset', async (req, res) => {
  const { token, password } = req.body || {};
  if (!token || !password) return res.status(400).json({ error: 'Token and password are required.' });
  const userId = await invites.consumeToken(token, 'password_reset');
  if (!userId) return res.status(400).json({ error: 'This reset link is invalid or has expired.' });
  await users.setPasswordHash(userId, await hashPassword(password));
  res.json({ ok: true });
});

module.exports = router;
