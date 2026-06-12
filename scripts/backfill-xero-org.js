// One-off backfill: fill in `xero_tenant_name` for historical bills that were
// imported/logged before that column existed.
//
// It reads data/bills.json (the legacy created-bills history, which records the
// Xero org as `tenantName`) and matches each entry to its DB row by the Xero
// invoice id (`invoiceId` -> bills.xero_invoice_id, which is globally unique).
//
// Idempotent: only fills rows where xero_tenant_name is currently empty.
// Run on the server where data/bills.json exists:
//   node scripts/backfill-xero-org.js

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const db = require('../db');

const BILLS_FILE = path.join(__dirname, '..', 'data', 'bills.json');

(async () => {
  let bills;
  try {
    bills = JSON.parse(fs.readFileSync(BILLS_FILE, 'utf8'));
  } catch (err) {
    console.error(`Could not read ${BILLS_FILE}: ${err.message}`);
    process.exit(1);
  }
  if (!Array.isArray(bills)) {
    console.error('bills.json is not an array.');
    process.exit(1);
  }

  let updated = 0, skipped = 0, noMatch = 0;
  for (const r of bills) {
    const invoiceId = r.invoiceId;
    const tenantName = r.tenantName;
    if (!invoiceId || !tenantName) { skipped++; continue; }
    const res = await db.execute(
      `UPDATE bills SET xero_tenant_name = ?
       WHERE xero_invoice_id = ? AND (xero_tenant_name IS NULL OR xero_tenant_name = '')`,
      [tenantName, invoiceId]
    );
    if (res.affectedRows) updated += res.affectedRows; else noMatch++;
  }

  console.log(`Backfill done. Filled ${updated} bills.`);
  console.log(`  (skipped ${skipped} entries with no invoiceId/tenantName; ${noMatch} had no matching/empty DB row.)`);
  await db.close();
})().catch((err) => {
  console.error('Backfill failed:', err.message);
  process.exit(1);
});
