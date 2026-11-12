// One-time migration: tables for the email channel (Gmail Apps Script intake).
// Safe to re-run; CREATE TABLE IF NOT EXISTS is a no-op once they exist.
//   node scripts/add-email-channel-tables.js
require('dotenv').config({ path: __dirname + '/../.env' });
const db = require('../db');

// MySQL 8 has no ADD COLUMN IF NOT EXISTS, so check first.
async function addColumn(table, column, definition) {
  const rows = await db.query(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [table, column]
  );
  if (rows.length) return;
  await db.execute(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  console.log(`Added ${table}.${column}.`);
}

(async () => {
  // Per-account email channel settings. The Gmail mailbox itself is read by an
  // Apps Script running inside that Gmail account, so no mailbox password is
  // stored here — the script authenticates with accounts.external_api_key.
  await db.execute(
    `CREATE TABLE IF NOT EXISTS email_settings (
      account_id        BIGINT UNSIGNED PRIMARY KEY,
      enabled           TINYINT(1) NOT NULL DEFAULT 1,
      gmail_address     VARCHAR(255) NULL,
      gmail_password    VARBINARY(512) NULL,
      notify_phone      VARCHAR(32) NULL,
      notify_failures   TINYINT(1) NOT NULL DEFAULT 1,
      script_version    VARCHAR(32) NULL,
      last_heartbeat_at DATETIME NULL,
      updated_at        DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      CONSTRAINT fk_email_settings_account FOREIGN KEY (account_id) REFERENCES accounts(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
  );

  // Added after the first release: the mailbox's password, kept so the team can
  // see it in Settings. Encrypted at rest; the intake never uses it.
  const pw = await db.query(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'email_settings' AND COLUMN_NAME = 'gmail_password'`
  );
  if (!pw.length) {
    await db.execute('ALTER TABLE email_settings ADD COLUMN gmail_password VARBINARY(512) NULL AFTER gmail_address');
    console.log('Added email_settings.gmail_password.');
  }

  // One row per Gmail message the script reported. skip_reason is set when the
  // email carried nothing to read (no PDF or photo).
  await db.execute(
    `CREATE TABLE IF NOT EXISTS email_messages (
      id               BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      account_id       BIGINT UNSIGNED NOT NULL,
      gmail_message_id VARCHAR(64) NOT NULL,
      from_name        VARCHAR(255) NULL,
      from_email       VARCHAR(255) NULL,
      subject          VARCHAR(512) NULL,
      received_at      DATETIME NULL,
      skip_reason      VARCHAR(512) NULL,
      created_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_email_msg (account_id, gmail_message_id),
      INDEX idx_email_msg_acct_received (account_id, received_at),
      CONSTRAINT fk_email_msg_account FOREIGN KEY (account_id) REFERENCES accounts(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
  );

  // One row per bill read from an attachment (bill_index > 0 when one PDF holds
  // several bills). bill_id links to the bills row (the Unmatched tab and the
  // monthly count); pending_uuid links to the pending-bills store the WhatsApp
  // org picker answers.
  await db.execute(
    `CREATE TABLE IF NOT EXISTS email_attachments (
      id               BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      account_id       BIGINT UNSIGNED NOT NULL,
      email_message_id BIGINT UNSIGNED NOT NULL,
      file_name        VARCHAR(255) NOT NULL,
      mime             VARCHAR(100) NULL,
      size             INT UNSIGNED NOT NULL DEFAULT 0,
      bill_index       SMALLINT UNSIGNED NOT NULL DEFAULT 0,
      stored_file      VARCHAR(255) NULL,
      status           ENUM('queued','processing','created','pending','failed','duplicate','dismissed') NOT NULL DEFAULT 'queued',
      message          VARCHAR(1024) NULL,
      bill_id          BIGINT UNSIGNED NULL,
      pending_uuid     VARCHAR(64) NULL,
      supplier         VARCHAR(255) NULL,
      invoice_no       VARCHAR(128) NULL,
      total            DECIMAL(14,2) NULL,
      currency         VARCHAR(8) NULL,
      xero_tenant_name VARCHAR(255) NULL,
      xero_url         VARCHAR(512) NULL,
      resolved_by_user TINYINT(1) NOT NULL DEFAULT 0,
      resolved_at      DATETIME NULL,
      created_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at       DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_email_att (email_message_id, file_name, size, bill_index),
      INDEX idx_email_att_acct_status (account_id, status),
      CONSTRAINT fk_email_att_msg FOREIGN KEY (email_message_id) REFERENCES email_messages(id),
      CONSTRAINT fk_email_att_account FOREIGN KEY (account_id) REFERENCES accounts(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
  );

  // How long each Gmail script run took, as reported on its next heartbeat.
  // Summed over 24 hours against Google's daily trigger allowance; rows older
  // than 3 days are pruned by the app.
  await db.execute(
    `CREATE TABLE IF NOT EXISTS email_script_runs (
      account_id  BIGINT UNSIGNED NOT NULL,
      run_at      DATETIME NOT NULL,
      duration_ms INT UNSIGNED NOT NULL,
      PRIMARY KEY (account_id, run_at),
      CONSTRAINT fk_email_runs_account FOREIGN KEY (account_id) REFERENCES accounts(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
  );

  // A copy of every bill file received (email or WhatsApp) waiting for the
  // Gmail script to save it to that Gmail's Google Drive, filed by month and
  // result. The local copy is deleted once Drive has it.
  await db.execute(
    `CREATE TABLE IF NOT EXISTS drive_archive (
      id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      account_id    BIGINT UNSIGNED NOT NULL,
      channel       ENUM('email','whatsapp') NOT NULL,
      file_name     VARCHAR(255) NOT NULL,
      mime          VARCHAR(100) NULL,
      stored_file   VARCHAR(255) NULL,
      sender        VARCHAR(255) NULL,
      received_at   DATETIME NOT NULL,
      result        ENUM('created','review','duplicate','failed') NULL,
      supplier      VARCHAR(255) NULL,
      invoice_no    VARCHAR(128) NULL,
      ready         TINYINT(1) NOT NULL DEFAULT 0,
      archived_at   DATETIME NULL,
      drive_file_id VARCHAR(128) NULL,
      created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_drive_archive_todo (account_id, ready, archived_at),
      CONSTRAINT fk_drive_archive_account FOREIGN KEY (account_id) REFERENCES accounts(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
  );
  await addColumn('email_settings', 'drive_archive', 'TINYINT(1) NOT NULL DEFAULT 1 AFTER notify_failures');
  await addColumn('email_attachments', 'archive_id', 'BIGINT UNSIGNED NULL AFTER bill_index');
  // What was left out of an email (pictures inside it, other file types) and why.
  await addColumn('email_messages', 'ignored_files', 'VARCHAR(1024) NULL AFTER skip_reason');

  console.log('Email channel tables ready: email_settings, email_messages, email_attachments, email_script_runs, drive_archive.');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
