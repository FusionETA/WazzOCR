// One-time migration: add external_api_key column to accounts table.
//   node scripts/add-external-api-key.js
// Idempotent: safe to re-run.
require('dotenv').config({ path: __dirname + '/../.env' });
const db = require('../db');

(async () => {
  const rows = await db.query(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'accounts' AND COLUMN_NAME = 'external_api_key'`
  );
  if (rows.length) {
    console.log('accounts.external_api_key already exists — skipping.');
  } else {
    await db.execute(
      `ALTER TABLE accounts ADD COLUMN external_api_key VARCHAR(64) NULL UNIQUE AFTER enable_item_code`
    );
    console.log('Added accounts.external_api_key (NULL by default — generate via admin panel).');
  }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
