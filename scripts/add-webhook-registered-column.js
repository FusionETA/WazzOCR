// One-time migration: add wazzup_channels.webhook_registered and mark every
// EXISTING channel as registered (they were all registered before this column
// existed). New channels added later default to 0 until their webhook is set.
//   node scripts/add-webhook-registered-column.js
require('dotenv').config({ path: __dirname + '/../.env' });
const db = require('../db');

(async () => {
  const existing = await db.query(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'wazzup_channels'
       AND COLUMN_NAME = 'webhook_registered'`
  );

  if (existing.length) {
    console.log('Column webhook_registered already exists — nothing to do.');
    process.exit(0);
  }

  await db.execute(
    `ALTER TABLE wazzup_channels
       ADD COLUMN webhook_registered TINYINT(1) NOT NULL DEFAULT 0`
  );
  console.log('Added column webhook_registered.');

  // Backfill: every channel that exists right now is already registered.
  const r = await db.execute('UPDATE wazzup_channels SET webhook_registered = 1');
  console.log(`Marked ${r.affectedRows} existing channel(s) as registered.`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
