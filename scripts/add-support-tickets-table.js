// One-time migration: create the support_tickets table (error → ticket tracking).
// Safe to re-run; CREATE TABLE IF NOT EXISTS is a no-op once it exists.
//   node scripts/add-support-tickets-table.js
require('dotenv').config({ path: __dirname + '/../.env' });
const db = require('../db');

(async () => {
  const existing = await db.query(
    `SELECT TABLE_NAME FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'support_tickets'`
  );
  if (existing.length) {
    console.log('Table support_tickets already exists — nothing to do.');
    process.exit(0);
  }

  await db.execute(
    `CREATE TABLE support_tickets (
      id                BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      ticket_code       VARCHAR(20) NOT NULL UNIQUE,
      account_id        BIGINT UNSIGNED NULL,
      wazzup_channel_id BIGINT UNSIGNED NULL,
      chat_id           VARCHAR(128),
      stage             VARCHAR(32),
      client_message    VARCHAR(512),
      error_message     TEXT,
      error_detail      JSON NULL,
      status            ENUM('open','investigating','resolved') DEFAULT 'open',
      created_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
      resolved_at       DATETIME NULL,
      INDEX idx_ticket_acct_created (account_id, created_at),
      INDEX idx_ticket_status_created (status, created_at),
      CONSTRAINT fk_ticket_account FOREIGN KEY (account_id) REFERENCES accounts(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
  );
  console.log('Created table support_tickets.');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
