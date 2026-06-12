// Disconnect one organisation's Xero connection: revoke it at Xero (so the app
// is removed from that org under Xero's "Connected apps"), then delete it from
// our DB. Best-effort on the Xero side — the local row is always removed so the
// org disappears from the UI even if the remote revoke can't be reached.
//
// Xero's revoke is per-connection: POST refresh_token → access token, GET
// /connections to find the connection id for this tenant, DELETE /connections/{id}.
const xc = require('../models/xeroConnections');

// Same token endpoint the app already uses elsewhere (server.js XERO_IDENTITY_BASE).
const IDENTITY_TOKEN_URL = 'https://login.xero.com/identity/connect/token';
const CONNECTIONS_URL = 'https://api.xero.com/connections';

function basicAuth() {
  return 'Basic ' + Buffer.from(`${process.env.XERO_CLIENT_ID}:${process.env.XERO_CLIENT_SECRET}`).toString('base64');
}

async function disconnectOrg(accountId, connectionRowId) {
  const conn = await xc.getById(accountId, connectionRowId);
  if (!conn) throw new Error('Connection not found.');
  const tenantId = conn.xero_tenant_id;

  let revoked = false;
  let revokeError = null;
  try {
    const grant = await xc.getGrantForTenant(accountId, tenantId);
    if (!grant) {
      revoked = true; // nothing stored to revoke against
    } else {
      // 1. Refresh → access token (and persist the rotated refresh token).
      const tr = await fetch(IDENTITY_TOKEN_URL, {
        method: 'POST',
        headers: { Authorization: basicAuth(), 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: grant.refreshToken }).toString()
      });
      const tp = await tr.json().catch(() => ({}));
      if (!tr.ok || !tp.access_token) {
        revokeError = tp.error_description || tp.error || `token refresh HTTP ${tr.status}`;
      } else {
        if (tp.refresh_token && tp.refresh_token !== grant.refreshToken) {
          await xc.updateGrantToken(grant.grantId, tp.refresh_token).catch(() => {});
        }
        // 2. Find this tenant's Xero connection id.
        const cr = await fetch(CONNECTIONS_URL, { headers: { Authorization: `Bearer ${tp.access_token}`, Accept: 'application/json' } });
        const list = await cr.json().catch(() => []);
        const match = Array.isArray(list) ? list.find((c) => c.tenantId === tenantId) : null;
        if (!match || !match.id) {
          revoked = true; // already absent at Xero
        } else {
          // 3. Revoke it.
          const dr = await fetch(`${CONNECTIONS_URL}/${match.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${tp.access_token}` } });
          revoked = dr.ok || dr.status === 204 || dr.status === 404;
          if (!revoked) revokeError = `Xero revoke HTTP ${dr.status}`;
        }
      }
    }
  } catch (err) {
    revokeError = err.message;
  }

  // Always remove locally so it disappears from the UI; drop the grant if now empty.
  await xc.deleteConnection(accountId, connectionRowId);
  await xc.deleteGrantIfOrphaned(conn.grant_id).catch(() => {});
  return { ok: true, revoked, revokeError, tenantName: conn.tenant_name };
}

module.exports = { disconnectOrg };
