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

// SESSION_COOKIE_DOMAIN widens the cookie to a parent domain — set it to
// ".fusioneta.com.my" and the browser sends this session to Bills Hub on
// billhub.fusioneta.com.my too, which is how somebody signed in here is
// signed in there without a second password existing at all.
//
// Unset, the cookie stays host-only exactly as before. Only widen it to a
// domain whose subdomains you control: every one of them can then read it.
const COOKIE_DOMAIN = String(process.env.SESSION_COOKIE_DOMAIN || '').trim() || undefined;

function setSessionCookie(req, res, rawToken) {
  res.cookie(sessions.COOKIE_NAME, rawToken, {
    httpOnly: true,
    secure: req.secure || process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    domain: COOKIE_DOMAIN,
    maxAge: sessions.TTL_DAYS * 86400000,
    path: '/'
  });
}

function clearSessionCookie(res) {
  // Both variants, and this is not belt-and-braces.
  //
  // A cookie is keyed by name AND domain, so a host-only `wz_session` and a
  // `.fusioneta.com.my` one are two different cookies. Clearing with the
  // domain set leaves a host-only one behind — which is exactly what every
  // session issued before SESSION_COOKIE_DOMAIN was introduced is. Signing
  // out would appear to work, the stale cookie would still be sent, and the
  // next sign-in would leave the browser holding two of them with no way to
  // say which the server should believe.
  res.clearCookie(sessions.COOKIE_NAME, { path: '/' });
  if (COOKIE_DOMAIN) {
    res.clearCookie(sessions.COOKIE_NAME, { path: '/', domain: COOKIE_DOMAIN });
  }
}

module.exports = {
  attachUser, requireAuth, requireSuperAdmin,
  setSessionCookie, clearSessionCookie, parseCookies
};
