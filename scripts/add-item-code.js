// One-time migration: add enable_item_code column to accounts table.
//   node scripts/add-item-code.js
// Idempotent: safe to re-run.
require('dotenv').config({ path: __dirname + '/../.env' });
const db = require('../db');

(async () => {
  const rows = await db.query(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'accounts' AND COLUMN_NAME = 'enable_item_code'`
  );
  if (rows.length) {
    console.log('accounts.enable_item_code already exists — skipping.');
  } else {
    await db.execute(
      `ALTER TABLE accounts ADD COLUMN enable_item_code TINYINT(1) NOT NULL DEFAULT 0 AFTER auto_create_bills`
    );
    console.log('Added accounts.enable_item_code (off by default).');
  }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
