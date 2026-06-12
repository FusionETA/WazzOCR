// Express auth middleware: attach the logged-in user/account from the session
// cookie, and guards for protected routes.
const sessions = require('./sessions');
const accountsModel = require('../models/accounts');

function parseCookies(header) {
  const out = {};
  String(header || '').split(';').forEach((part) => {
    const idx = part.indexOf('=');
    if (idx > -1) {
      const k = part.slice(0, idx).trim();
      const v = part.slice(idx + 1).trim();
      if (k) out[k] = decodeURIComponent(v);
    }
  });
  return out;
}

// Sets req.user (+ req.account if the user belongs to one) when a valid session
// cookie is present. No-op (and cheap) when there's no cookie.
async function attachUser(req, res, next) {
  try {
    const raw = parseCookies(req.headers.cookie)[sessions.COOKIE_NAME];
    if (raw) {
      const user = await sessions.resolveUser(raw);
      if (user) {
        req.user = user;
        req.sessionToken = raw;
        if (user.account_id) req.account = await accountsModel.getById(user.account_id);
      }
    }
  } catch (err) {
    console.error('[auth] attachUser error:', err.message);
  }
  next();
}

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Not authenticated.' });
  next();
}

function requireSuperAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Not authenticated.' });
  if (!req.user.is_super_admin) return res.status(403).json({ error: 'Admin access required.' });
  next();
}

function setSessionCookie(req, res, rawToken) {
  res.cookie(sessions.COOKIE_NAME, rawToken, {
    httpOnly: true,
    secure: req.secure || process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: sessions.TTL_DAYS * 86400000,
    path: '/'
  });
}

function clearSessionCookie(res) {
  res.clearCookie(sessions.COOKIE_NAME, { path: '/' });
}

module.exports = {
  attachUser, requireAuth, requireSuperAdmin,
  setSessionCookie, clearSessionCookie, parseCookies
};
