// Read-only: print every WazzOCR account and the Xero orgs currently attached.
// Use this to spot orgs wrongly attached to the wrong account before cleanup.
//   node scripts/list-xero-connections.js
require('dotenv').config({ path: __dirname + '/../.env' });
const db = require('../db');

(async () => {
  const rows = await db.query(
    `SELECT c.account_id, a.name AS account_name,
            c.id AS conn_id, c.xero_tenant_id, c.tenant_name, c.status
     FROM xero_connections c
     LEFT JOIN accounts a ON a.id = c.account_id
     ORDER BY c.account_id, c.tenant_name`
  );

  const byAccount = new Map();
  for (const r of rows) {
    if (!byAccount.has(r.account_id)) byAccount.set(r.account_id, { name: r.account_name, orgs: [] });
    byAccount.get(r.account_id).orgs.push(r);
  }

  // Flag orgs that appear under more than one account (the leak).
  const tenantCount = new Map();
  for (const r of rows) tenantCount.set(r.xero_tenant_id, (tenantCount.get(r.xero_tenant_id) || 0) + 1);

  console.log(`\n${rows.length} connection row(s) across ${byAccount.size} account(s):\n`);
  for (const [accId, info] of byAccount) {
    console.log(`Account ${accId} — ${info.name || '(no name)'}`);
    for (const o of info.orgs) {
      const dup = tenantCount.get(o.xero_tenant_id) > 1 ? '  ⚠️ ALSO ON ANOTHER ACCOUNT' : '';
      console.log(`   [conn ${o.conn_id}] ${o.tenant_name || '(unnamed)'}  (${o.status})  tenant=${o.xero_tenant_id}${dup}`);
    }
    console.log('');
  }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
