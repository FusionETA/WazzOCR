// Cleanup: enforce the correct Xero-org -> WazzOCR-account ownership after the
// "auto-attach every org" leak. DRY-RUN by default; pass --commit to delete.
//
//   node scripts/fix-xero-connections.js            # preview only, no changes
//   node scripts/fix-xero-connections.js --commit   # actually delete the wrong rows
//
// Edit OWNERSHIP below if you need to fix more accounts. For each account name,
// list the EXACT tenant_name(s) that legitimately belong to it. The script then:
//   (a) removes any OTHER org sitting under that account, and
//   (b) removes those orgs if they're wrongly attached to a different account.
require('dotenv').config({ path: __dirname + '/../.env' });
const db = require('../db');

const OWNERSHIP = {
  'Zi Rong Test': ['Fusion VC4 BT Sdn Bhd'],
};

const COMMIT = process.argv.includes('--commit');
const norm = (s) => String(s || '').trim().toLowerCase();

(async () => {
  const rows = await db.query(
    `SELECT c.id AS conn_id, c.account_id, a.name AS account_name,
            c.xero_tenant_id, c.tenant_name, c.status
     FROM xero_connections c
     LEFT JOIN accounts a ON a.id = c.account_id
     ORDER BY c.account_id, c.tenant_name`
  );

  console.log(`\nCurrent state — ${rows.length} connection row(s):\n`);
  let lastAcc = null;
  for (const r of rows) {
    if (r.account_id !== lastAcc) { console.log(`Account ${r.account_id} — ${r.account_name || '(no name)'}`); lastAcc = r.account_id; }
    console.log(`   [conn ${r.conn_id}] ${r.tenant_name || '(unnamed)'}  (${r.status})  tenant=${r.xero_tenant_id}`);
  }

  // Build the deletion plan.
  const toDelete = [];
  for (const [accName, keepOrgs] of Object.entries(OWNERSHIP)) {
    const keepSet = new Set(keepOrgs.map(norm));
    for (const r of rows) {
      const onThisAccount = norm(r.account_name) === norm(accName);
      const isOwnedOrg = keepSet.has(norm(r.tenant_name));
      // (a) wrong org sitting under the owner account
      if (onThisAccount && !isOwnedOrg) toDelete.push({ ...r, why: `not owned by "${accName}"` });
      // (b) an owned org wrongly attached to some OTHER account
      if (!onThisAccount && isOwnedOrg) toDelete.push({ ...r, why: `belongs to "${accName}", not "${r.account_name}"` });
    }
  }

  console.log(`\n${toDelete.length} row(s) to delete:\n`);
  for (const d of toDelete) {
    console.log(`   [conn ${d.conn_id}] ${d.tenant_name} — under "${d.account_name}" — ${d.why}`);
  }

  if (!toDelete.length) { console.log('\nNothing to delete.\n'); process.exit(0); }

  if (!COMMIT) {
    console.log('\nDRY RUN — no changes made. Re-run with --commit to apply.\n');
    process.exit(0);
  }

  for (const d of toDelete) {
    await db.execute('DELETE FROM xero_connections WHERE id = ?', [d.conn_id]);
  }
  console.log(`\nDeleted ${toDelete.length} row(s). Done.\n`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
