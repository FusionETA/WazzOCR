// One-time migration: add accounts.setup_complete.
//   node scripts/add-account-setup-complete.js
//
// 0 = the account owner still needs to complete onboarding (org name + phone) via
// the forced modal after login. Adding the column with DEFAULT 1 marks every
// EXISTING account as complete (they're already set up); only new self-service
// signups insert 0.
//
// Idempotent: safe to re-run.
require('dotenv').config({ path: __dirname + '/../.env' });
const db = require('../db');

(async () => {
  const existing = await db.query(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'accounts' AND COLUMN_NAME = 'setup_complete'`
  );
  if (existing.length) {
    console.log('accounts.setup_complete already exists — nothing to do.');
    process.exit(0);
  }
  await db.execute(
    `ALTER TABLE accounts ADD COLUMN setup_complete TINYINT(1) NOT NULL DEFAULT 1 AFTER plan`
  );
  console.log('Added accounts.setup_complete (existing accounts marked complete).');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
