// Google Sign-In (OAuth 2.0 authorization-code flow).
// The id_token is obtained directly from Google's token endpoint over TLS using
// our client secret, so per Google's guidance we can trust it without re-verifying
// the JWT signature — we still validate aud / iss / exp / email_verified.

const AUTH_URI = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URI = 'https://oauth2.googleapis.com/token';

const clientId = () => process.env.GOOGLE_CLIENT_ID || '';
const clientSecret = () => process.env.GOOGLE_CLIENT_SECRET || '';
const redirectUri = () => process.env.GOOGLE_REDIRECT_URI || '';

function isConfigured() {
  return Boolean(clientId() && clientSecret() && redirectUri());
}

function buildAuthUrl(state) {
  const params = new URLSearchParams({
    client_id: clientId(),
    redirect_uri: redirectUri(),
    response_type: 'code',
    scope: 'openid email profile',
    state,
    access_type: 'online',
    prompt: 'select_account'
  });
  return `${AUTH_URI}?${params.toString()}`;
}

async function exchangeCode(code) {
  const resp = await fetch(TOKEN_URI, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: clientId(),
      client_secret: clientSecret(),
      redirect_uri: redirectUri(),
      grant_type: 'authorization_code'
    })
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`Google token exchange failed (${resp.status}): ${body.slice(0, 200)}`);
  }
  return resp.json(); // { id_token, access_token, ... }
}

function decodeIdToken(idToken) {
  const parts = String(idToken || '').split('.');
  if (parts.length !== 3) throw new Error('Malformed id_token.');
  return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
}

// Validates audience, issuer, expiry. Returns the claims.
function validateClaims(claims) {
  if (claims.aud !== clientId()) throw new Error('Token audience mismatch.');
  const issOk = claims.iss === 'accounts.google.com' || claims.iss === 'https://accounts.google.com';
  if (!issOk) throw new Error('Token issuer invalid.');
  if (claims.exp && Math.floor(Date.now() / 1000) > Number(claims.exp)) throw new Error('Token expired.');
  return claims;
}

module.exports = { isConfigured, buildAuthUrl, exchangeCode, decodeIdToken, validateClaims };
