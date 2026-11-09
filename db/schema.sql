-- WazzOCR multi-tenant schema. Safe to re-run (CREATE TABLE IF NOT EXISTS).
-- Apply with: node scripts/db-migrate.js

CREATE TABLE IF NOT EXISTS accounts (
  id                BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name              VARCHAR(255) NOT NULL,
  status            ENUM('active','suspended','trial') DEFAULT 'active',
  ai_provider       VARCHAR(32)  DEFAULT 'gemini',
  ai_model          VARCHAR(64)  DEFAULT 'gemini-2.5-flash',
  ai_prompt_addon   TEXT,
  auto_create_bills TINYINT(1) DEFAULT 0,
  -- Billing plan. New accounts default to 'trial' (they share the system trial
  -- Wazzup channel and are routed by sender phone). 'paid' accounts use their own
  -- channel(s). The migration backfills all pre-existing accounts to 'paid'.
  plan              ENUM('trial','paid') NOT NULL DEFAULT 'trial',
  -- 0 = the owner still needs to complete onboarding (org name + phone) via the
  -- forced modal after first login. Self-service signups start at 0; admin-created
  -- accounts (named on creation) default to 1.
  setup_complete    TINYINT(1) NOT NULL DEFAULT 1,
  created_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at        DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS app_settings (
  `key`      VARCHAR(64) PRIMARY KEY,
  value      MEDIUMTEXT,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Modular AI prompt blocks. account_id NULL = a GENERAL block applied to every
-- account; account_id set = a per-account add-on. Enabled blocks are concatenated
-- (ordered by position) to build the extraction prompt. Replaces the single
-- app_settings.general_ai_prompt / accounts.ai_prompt_addon text fields (which
-- remain as a fallback for backward compatibility).
CREATE TABLE IF NOT EXISTS ai_prompt_blocks (
  id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  account_id BIGINT UNSIGNED NULL,
  title      VARCHAR(255) NOT NULL,
  body       MEDIUMTEXT NOT NULL,
  enabled    TINYINT(1) DEFAULT 1,
  position   INT DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_apb_account (account_id, enabled, position),
  CONSTRAINT fk_apb_account FOREIGN KEY (account_id) REFERENCES accounts(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Per-call Gemini token usage, for AI usage/cost analytics. One row per AI call.
-- account_id NULL = a call made outside any account context (legacy/global path).
CREATE TABLE IF NOT EXISTS ai_usage (
  id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  account_id    BIGINT UNSIGNED NULL,
  model         VARCHAR(64),
  purpose       VARCHAR(32),            -- extraction | coa | chat | other
  prompt_tokens INT DEFAULT 0,
  output_tokens INT DEFAULT 0,
  total_tokens  INT DEFAULT 0,
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_aiusage_acct_created (account_id, created_at),
  CONSTRAINT fk_aiusage_account FOREIGN KEY (account_id) REFERENCES accounts(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS users (
  id             BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  account_id     BIGINT UNSIGNED NULL,
  email          VARCHAR(255) NOT NULL UNIQUE,
  google_sub     VARCHAR(255) NULL UNIQUE,
  xero_sub       VARCHAR(255) NULL UNIQUE,
  password_hash  VARBINARY(255) NULL,
  phone_number   VARCHAR(32) NULL,
  name           VARCHAR(255),
  avatar_url     VARCHAR(512),
  role           ENUM('owner','member') DEFAULT 'owner',
  is_super_admin TINYINT(1) DEFAULT 0,
  status         ENUM('invited','active','disabled') DEFAULT 'invited',
  created_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_login_at  DATETIME,
  CONSTRAINT fk_users_account FOREIGN KEY (account_id) REFERENCES accounts(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS sessions (
  id         CHAR(64) PRIMARY KEY,
  user_id    BIGINT UNSIGNED NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  expires_at DATETIME NOT NULL,
  ip         VARCHAR(45),
  user_agent VARCHAR(255),
  CONSTRAINT fk_sessions_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS auth_tokens (
  id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id    BIGINT UNSIGNED NOT NULL,
  type       ENUM('invite','password_reset') NOT NULL,
  token_hash CHAR(64) NOT NULL,
  expires_at DATETIME NOT NULL,
  used_at    DATETIME NULL,
  CONSTRAINT fk_authtokens_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS xero_grants (
  id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  account_id    BIGINT UNSIGNED NOT NULL,
  refresh_token VARBINARY(1024) NOT NULL,
  scope         TEXT,
  obtained_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_xerogrants_account FOREIGN KEY (account_id) REFERENCES accounts(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS xero_connections (
  id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  account_id      BIGINT UNSIGNED NOT NULL,
  grant_id        BIGINT UNSIGNED NOT NULL,
  xero_tenant_id  VARCHAR(64) NOT NULL,
  tenant_name     VARCHAR(255),
  status          ENUM('active','expired','revoked') DEFAULT 'active',
  needs_reconnect TINYINT(1) DEFAULT 0,
  UNIQUE KEY uq_acct_tenant (account_id, xero_tenant_id),
  CONSTRAINT fk_xeroconn_account FOREIGN KEY (account_id) REFERENCES accounts(id),
  CONSTRAINT fk_xeroconn_grant   FOREIGN KEY (grant_id)   REFERENCES xero_grants(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS wazzup_channels (
  id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  account_id BIGINT UNSIGNED NOT NULL,
  channel_id VARCHAR(128) NOT NULL UNIQUE,
  api_key    VARBINARY(512),
  label      VARCHAR(255),
  status     ENUM('active','disabled') DEFAULT 'active',
  webhook_registered TINYINT(1) NOT NULL DEFAULT 0,
  -- When 1, only sender phones in wazzup_channel_phones may use this channel; all
  -- other senders are silently ignored. When 0 (default), anyone can use it.
  phone_restriction_enabled TINYINT(1) NOT NULL DEFAULT 0,
  CONSTRAINT fk_wazzup_account FOREIGN KEY (account_id) REFERENCES accounts(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Per-channel allowed sender phones. Doubles as the trial routing map: on the
-- shared trial channel, each row maps a sender phone to the trial account that
-- registered it (so one channel serves many trial accounts). On a normal paid
-- channel, rows are the whitelist of numbers allowed to use that account's channel.
CREATE TABLE IF NOT EXISTS wazzup_channel_phones (
  id                BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  wazzup_channel_id BIGINT UNSIGNED NOT NULL,
  account_id        BIGINT UNSIGNED NOT NULL,
  phone             VARCHAR(32) NOT NULL,           -- digits only, no + / spaces
  label             VARCHAR(255),
  created_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_channel_phone (wazzup_channel_id, phone),
  INDEX idx_wcp_account (account_id),
  CONSTRAINT fk_wcp_channel FOREIGN KEY (wazzup_channel_id) REFERENCES wazzup_channels(id) ON DELETE CASCADE,
  CONSTRAINT fk_wcp_account FOREIGN KEY (account_id) REFERENCES accounts(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS coa_accounts (
  id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  account_id BIGINT UNSIGNED NOT NULL,
  code       VARCHAR(32) NOT NULL,
  name       VARCHAR(255) NOT NULL,
  category   VARCHAR(64),
  UNIQUE KEY uq_acct_code (account_id, code),
  CONSTRAINT fk_coa_account FOREIGN KEY (account_id) REFERENCES accounts(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS bills (
  id                 BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  account_id         BIGINT UNSIGNED NOT NULL,
  xero_connection_id BIGINT UNSIGNED NULL,
  wazzup_channel_id  BIGINT UNSIGNED NULL,
  chat_id            VARCHAR(128),
  status             ENUM('success','failed','pending','skipped') NOT NULL,
  failure_reason     VARCHAR(512),
  supplier           VARCHAR(255),
  invoice_no         VARCHAR(128),
  total              DECIMAL(14,2),
  currency           VARCHAR(8),
  document_type      VARCHAR(32),
  xero_invoice_id    VARCHAR(64),
  xero_url           VARCHAR(512),
  xero_tenant_name   VARCHAR(255),           -- which Xero org the bill was created in
  source             VARCHAR(32),
  payload            JSON NULL,              -- full bill data, kept for pending bills so they can be resolved
  created_at         DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_acct_status_created (account_id, status, created_at),
  CONSTRAINT fk_bills_account FOREIGN KEY (account_id) REFERENCES accounts(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Support tickets — one row per pipeline error surfaced to a WhatsApp client.
-- The client only ever sees `ticket_code` (e.g. WZ-7K3M9Q) + a generic message;
-- the raw error and context are kept here for the admin to investigate. account_id
-- NULL = error happened before/outside any resolved account (e.g. unregistered channel).
CREATE TABLE IF NOT EXISTS support_tickets (
  id                BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  ticket_code       VARCHAR(20) NOT NULL UNIQUE,    -- shown to the client
  account_id        BIGINT UNSIGNED NULL,
  wazzup_channel_id BIGINT UNSIGNED NULL,
  chat_id           VARCHAR(128),
  stage             VARCHAR(32),                    -- extraction | xero | download | bridge | chat | other
  client_message    VARCHAR(512),                   -- the generic text the client was shown
  error_message     TEXT,                           -- the raw error (admin-only)
  error_detail      JSON NULL,                      -- stack, fileName, mime, model, ocr snippet
  status            ENUM('open','investigating','resolved') DEFAULT 'open',
  created_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
  resolved_at       DATETIME NULL,
  INDEX idx_ticket_acct_created (account_id, created_at),
  INDEX idx_ticket_status_created (status, created_at),
  CONSTRAINT fk_ticket_account FOREIGN KEY (account_id) REFERENCES accounts(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS whatsapp_chat_state (
  chat_id    VARCHAR(128) PRIMARY KEY,
  account_id BIGINT UNSIGNED NOT NULL,
  state      JSON,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_chatstate_account FOREIGN KEY (account_id) REFERENCES accounts(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Email channel (Gmail Apps Script → /api/email/intake). See
-- scripts/add-email-channel-tables.js and lib/emailIntake.js.
CREATE TABLE IF NOT EXISTS email_settings (
  account_id        BIGINT UNSIGNED PRIMARY KEY,
  enabled           TINYINT(1) NOT NULL DEFAULT 1,
  gmail_address     VARCHAR(255) NULL,
  gmail_password    VARBINARY(512) NULL,           -- encrypted (lib/crypto); shown to the team in Settings, never used by the intake
  notify_phone      VARCHAR(32) NULL,               -- gets the WhatsApp org picker for emailed bills
  notify_failures   TINYINT(1) NOT NULL DEFAULT 1,
  script_version    VARCHAR(32) NULL,               -- reported by the Apps Script heartbeat
  last_heartbeat_at DATETIME NULL,
  updated_at        DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_email_settings_account FOREIGN KEY (account_id) REFERENCES accounts(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS email_messages (
  id               BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  account_id       BIGINT UNSIGNED NOT NULL,
  gmail_message_id VARCHAR(64) NOT NULL,
  from_name        VARCHAR(255) NULL,
  from_email       VARCHAR(255) NULL,
  subject          VARCHAR(512) NULL,
  received_at      DATETIME NULL,
  skip_reason      VARCHAR(512) NULL,               -- set when the email had no PDF or photo
  created_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_email_msg (account_id, gmail_message_id),
  INDEX idx_email_msg_acct_received (account_id, received_at),
  CONSTRAINT fk_email_msg_account FOREIGN KEY (account_id) REFERENCES accounts(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS email_attachments (
  id               BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  account_id       BIGINT UNSIGNED NOT NULL,
  email_message_id BIGINT UNSIGNED NOT NULL,
  file_name        VARCHAR(255) NOT NULL,
  mime             VARCHAR(100) NULL,
  size             INT UNSIGNED NOT NULL DEFAULT 0,
  bill_index       SMALLINT UNSIGNED NOT NULL DEFAULT 0, -- > 0 when one file holds several bills
  stored_file      VARCHAR(255) NULL,               -- kept under data/email until no longer needed
  status           ENUM('queued','processing','created','pending','failed','duplicate','dismissed') NOT NULL DEFAULT 'queued',
  message          VARCHAR(1024) NULL,
  bill_id          BIGINT UNSIGNED NULL,            -- bills.id (Unmatched tab, monthly count)
  pending_uuid     VARCHAR(64) NULL,                -- pending-bills store id (WhatsApp org picker)
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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- How long each Gmail script run took (reported on the next heartbeat), summed
-- over 24 hours against Google's daily trigger allowance. Pruned after 3 days.
CREATE TABLE IF NOT EXISTS email_script_runs (
  account_id  BIGINT UNSIGNED NOT NULL,
  run_at      DATETIME NOT NULL,
  duration_ms INT UNSIGNED NOT NULL,
  PRIMARY KEY (account_id, run_at),                 -- a run reported twice is stored once
  CONSTRAINT fk_email_runs_account FOREIGN KEY (account_id) REFERENCES accounts(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
