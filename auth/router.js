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
const accounts = require('../models/accounts');
const channelPhones = require('../models/channelPhones');
const trialChannel = require('../lib/trialChannel');
const sessions = require('./sessions');
const invites = require('./invites');
const google = require('./google');
const { randomToken } = require('../lib/tokens');
const { hashPassword, verifyPassword } = require('./passwords');
const { attachUser, requireAuth, setSessionCookie, clearSessionCookie, parseCookies } = require('./middleware');

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

// ── Self-service registration ────────────────────────────────────────────────
// A new signup always creates a TRIAL account and whitelists the registrant's
// phone on the shared trial channel (so their WhatsApp routes to them once the
// channel's restriction is on). Two paths: email+password (here) and Google.

// Is this phone already registered on the trial channel? Prevents ambiguous
// routing (two accounts can't share one number on the same channel).
async function trialPhoneTaken(phone) {
  const channelDbId = await trialChannel.trialChannelDbId();
  if (!channelDbId) return false; // trial channel not configured — nothing to clash with
  const hit = await channelPhones.resolveAccount(channelDbId, phone);
  return Boolean(hit);
}

// Add the registrant's phone to the trial channel's allow-list / routing map.
async function whitelistTrialPhone(accountId, phone) {
  const channelDbId = await trialChannel.trialChannelDbId();
  if (!channelDbId) return; // not configured yet — skip silently
  try { await channelPhones.add({ channelDbId, accountId, phone, label: 'Registered' }); }
  catch (err) { if (!/Duplicate/i.test(err.message)) throw err; }
}

router.post('/register', async (req, res) => {
  const { orgName, email, phone, password } = req.body || {};
  const cleanPhone = channelPhones.normalizePhone(phone);
  if (!orgName || !String(orgName).trim()) return res.status(400).json({ error: 'Organisation name is required.' });
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required.' });
  if (String(password).length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  if (!cleanPhone) return res.status(400).json({ error: 'A valid phone number is required.' });
  if (rateLimited('register:' + req.ip)) return res.status(429).json({ error: 'Too many attempts. Please try again later.' });

  if (await users.getByEmail(email)) return res.status(409).json({ error: 'An account with that email already exists.' });
  if (await trialPhoneTaken(cleanPhone)) return res.status(409).json({ error: 'That phone number is already registered.' });

  const accountId = await accounts.create({ name: String(orgName).trim(), plan: 'trial' });
  const userId = await users.createOwner({
    accountId, email, phone: cleanPhone,
    name: String(orgName).trim(),
    passwordHash: await hashPassword(password)
  });
  await whitelistTrialPhone(accountId, cleanPhone);

  const raw = await sessions.create(userId, { ip: req.ip, userAgent: req.headers['user-agent'] });
  setSessionCookie(req, res, raw);
  await users.markLogin(userId);
  res.json({ ok: true, user: publicUser(await users.getById(userId)) });
});

// Start a Google signup: stash org name + phone in a short-lived cookie, then the
// page sends the user through the normal /auth/google flow. The callback reads
// this cookie to create the account for a brand-new Google user.
router.post('/register/google-init', async (req, res) => {
  const { orgName, phone } = req.body || {};
  const cleanPhone = channelPhones.normalizePhone(phone);
  if (!orgName || !String(orgName).trim()) return res.status(400).json({ error: 'Organisation name is required.' });
  if (!cleanPhone) return res.status(400).json({ error: 'A valid phone number is required.' });
  if (await trialPhoneTaken(cleanPhone)) return res.status(409).json({ error: 'That phone number is already registered.' });

  const payload = Buffer.from(JSON.stringify({ orgName: String(orgName).trim(), phone: cleanPhone })).toString('base64');
  res.cookie('g_register', payload, {
    httpOnly: true, secure: req.secure || process.env.NODE_ENV === 'production',
    sameSite: 'lax', maxAge: 10 * 60 * 1000, path: '/auth'
  });
  res.json({ ok: true });
});

function readRegisterCookie(req) {
  const raw = parseCookies(req.headers.cookie).g_register;
  if (!raw) return null;
  try {
    const d = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
    if (d && d.orgName && d.phone) return d;
  } catch { /* ignore */ }
  return null;
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

// ── Google sign-in ──────────────────────────────────────────────────────────
router.get('/google', (req, res) => {
  if (!google.isConfigured()) return res.status(503).send('Google sign-in is not configured.');
  const state = randomToken(16);
  res.cookie('g_state', state, {
    httpOnly: true, secure: req.secure || process.env.NODE_ENV === 'production',
    sameSite: 'lax', maxAge: 10 * 60 * 1000, path: '/auth'
  });
  res.redirect(google.buildAuthUrl(state));
});

router.get('/google/callback', async (req, res) => {
  try {
    const { code, state } = req.query;
    const savedState = parseCookies(req.headers.cookie).g_state;
    if (!code || !state || !savedState || state !== savedState) {
      return res.redirect('/login.html?error=google');
    }
    res.clearCookie('g_state', { path: '/auth' });

    const tokens = await google.exchangeCode(code);
    const claims = google.validateClaims(google.decodeIdToken(tokens.id_token));
    const email = String(claims.email || '').toLowerCase();
    if (!email || claims.email_verified === false) return res.redirect('/login.html?error=unverified');

    // Claim-on-login: match by Google id, else by verified email (invited user).
    let user = await users.getByGoogleSub(claims.sub);
    if (!user) {
      const byEmail = await users.getByEmail(email);
      if (byEmail) {
        await users.attachGoogle(byEmail.id, { googleSub: claims.sub, name: claims.name, avatarUrl: claims.picture });
        user = await users.getById(byEmail.id);
      }
    }
    // Self-service Google signup: a brand-new Google user carrying a pending
    // registration cookie gets a fresh trial account + whitelisted phone.
    if (!user) {
      const pending = readRegisterCookie(req);
      if (pending) {
        res.clearCookie('g_register', { path: '/auth' });
        if (await trialPhoneTaken(pending.phone)) return res.redirect('/login.html?error=phone_taken');
        const accountId = await accounts.create({ name: pending.orgName, plan: 'trial' });
        const userId = await users.createOwner({
          accountId, email, name: claims.name || pending.orgName,
          googleSub: claims.sub, avatarUrl: claims.picture, phone: pending.phone
        });
        await whitelistTrialPhone(accountId, pending.phone);
        user = await users.getById(userId);
      }
    }
    if (!user) return res.redirect('/login.html?error=notinvited'); // reject unless invited/registered
    if (user.status === 'disabled') return res.redirect('/login.html?error=disabled');

    const raw = await sessions.create(user.id, { ip: req.ip, userAgent: req.headers['user-agent'] });
    setSessionCookie(req, res, raw);
    await users.markLogin(user.id);
    res.redirect(user.is_super_admin ? '/admin.html' : '/account.html');
  } catch (err) {
    console.error('[auth] google callback error:', err.message);
    res.redirect('/login.html?error=google');
  }
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
