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
  created_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at        DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS app_settings (
  `key`      VARCHAR(64) PRIMARY KEY,
  value      MEDIUMTEXT,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS users (
  id             BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  account_id     BIGINT UNSIGNED NULL,
  email          VARCHAR(255) NOT NULL UNIQUE,
  google_sub     VARCHAR(255) NULL UNIQUE,
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
  CONSTRAINT fk_wazzup_account FOREIGN KEY (account_id) REFERENCES accounts(id)
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
  source             VARCHAR(32),
  created_at         DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_acct_status_created (account_id, status, created_at),
  CONSTRAINT fk_bills_account FOREIGN KEY (account_id) REFERENCES accounts(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS whatsapp_chat_state (
  chat_id    VARCHAR(128) PRIMARY KEY,
  account_id BIGINT UNSIGNED NOT NULL,
  state      JSON,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_chatstate_account FOREIGN KEY (account_id) REFERENCES accounts(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
