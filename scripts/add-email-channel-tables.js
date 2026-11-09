// One-time migration: tables for the email channel (Gmail Apps Script intake).
// Safe to re-run; CREATE TABLE IF NOT EXISTS is a no-op once they exist.
//   node scripts/add-email-channel-tables.js
require('dotenv').config({ path: __dirname + '/../.env' });
const db = require('../db');

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

  console.log('Email channel tables ready: email_settings, email_messages, email_attachments.');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
