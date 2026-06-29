// One-time migration for the plans + phone-restriction features.
//   node scripts/add-plans-and-phone-restriction.js
//
// - accounts.plan ENUM('trial','paid') DEFAULT 'trial'
//     Backfills EVERY existing account to 'paid' so live clients (e.g. Ayu Borneo)
//     keep their current behaviour. Only accounts created after this run default
//     to 'trial'.
// - wazzup_channels.phone_restriction_enabled TINYINT(1) DEFAULT 0
//     Defaults to 0 (off) everywhere — no existing channel changes behaviour.
// - wazzup_channel_phones table (allow-list + trial routing map).
// - app_settings.trial_default_channel_id seeded to the shared trial channel.
//
// Idempotent: safe to re-run.
require('dotenv').config({ path: __dirname + '/../.env' });
const db = require('../db');

const TRIAL_DEFAULT_CHANNEL_ID = '61e245cf-3c1c-4586-a89b-3c1f75de659a'; // "Fusion Demo Wazzup"

async function columnExists(table, column) {
  const rows = await db.query(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [table, column]
  );
  return rows.length > 0;
}

(async () => {
  // 1) accounts.plan
  if (await columnExists('accounts', 'plan')) {
    console.log('accounts.plan already exists — skipping add.');
  } else {
    await db.execute(
      `ALTER TABLE accounts
         ADD COLUMN plan ENUM('trial','paid') NOT NULL DEFAULT 'trial' AFTER auto_create_bills`
    );
    console.log('Added accounts.plan.');
    // Backfill: every existing account is a real/paid account (keeps live clients
    // like Ayu Borneo unchanged).
    const r = await db.execute("UPDATE accounts SET plan = 'paid'");
    console.log(`Backfilled ${r.affectedRows} existing account(s) to 'paid'.`);
    // ...except the account that owns the shared trial channel — keep it on the
    // trial plan so it exercises the trial flow (Zi Rong Test).
    const t = await db.execute(
      `UPDATE accounts a
         JOIN wazzup_channels w ON w.account_id = a.id
          SET a.plan = 'trial'
        WHERE w.channel_id = ?`,
      [TRIAL_DEFAULT_CHANNEL_ID]
    );
    console.log(`Set ${t.affectedRows} trial-channel owner account(s) to 'trial'.`);
  }

  // 2) wazzup_channels.phone_restriction_enabled
  if (await columnExists('wazzup_channels', 'phone_restriction_enabled')) {
    console.log('wazzup_channels.phone_restriction_enabled already exists — skipping.');
  } else {
    await db.execute(
      `ALTER TABLE wazzup_channels
         ADD COLUMN phone_restriction_enabled TINYINT(1) NOT NULL DEFAULT 0`
    );
    console.log('Added wazzup_channels.phone_restriction_enabled (off by default).');
  }

  // 3) wazzup_channel_phones
  await db.execute(
    `CREATE TABLE IF NOT EXISTS wazzup_channel_phones (
      id                BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      wazzup_channel_id BIGINT UNSIGNED NOT NULL,
      account_id        BIGINT UNSIGNED NOT NULL,
      phone             VARCHAR(32) NOT NULL,
      label             VARCHAR(255),
      created_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_channel_phone (wazzup_channel_id, phone),
      INDEX idx_wcp_account (account_id),
      CONSTRAINT fk_wcp_channel FOREIGN KEY (wazzup_channel_id) REFERENCES wazzup_channels(id) ON DELETE CASCADE,
      CONSTRAINT fk_wcp_account FOREIGN KEY (account_id) REFERENCES accounts(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
  );
  console.log('Ensured wazzup_channel_phones table.');

  // 4) Seed the trial default channel pointer (only if not already set).
  const r = await db.execute(
    'INSERT IGNORE INTO app_settings (`key`, value) VALUES (?, ?)',
    ['trial_default_channel_id', TRIAL_DEFAULT_CHANNEL_ID]
  );
  console.log(
    r.affectedRows
      ? `Seeded app_settings.trial_default_channel_id = ${TRIAL_DEFAULT_CHANNEL_ID}.`
      : 'app_settings.trial_default_channel_id already set — left as-is.'
  );

  console.log('\nDone. NOTE: phone restriction on the trial channel is still OFF.');
  console.log('Activate the trial feature from Admin once the phone numbers are added.');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
