# WazzOCR Multi-Tenant SaaS — Design

Status: draft for review. No code changed yet.

Turns the current single-tenant Ayu Borneo app into a multi-tenant platform where
many customers each have their own accounts, Xero organisations, Wazzup channels,
chart of accounts and bill history, with a FusionETA admin layer on top.

---

## 1. Goals

1. Multiple customer **accounts**, identified by **email**.
2. Login by **Google sign-in** and **email + password** (both supported).
3. **Invite-based onboarding**: FusionETA pre-creates an account, invites the
   customer over **WhatsApp (Wazzup)**, not email (DigitalOcean blocks SMTP).
4. Each account connects **multiple Xero orgs** and **multiple Wazzup channels**.
5. Per-account **bill success counter** for normal users.
6. **Admin dashboard** (FusionETA): see every account's health, drill into each
   account's success / failed / why-failed, and edit their configuration.
7. **Layered AI prompt**: one general base prompt (admin), plus a per-account
   add-on (admin), plus the account's own COA list.
8. Per-account **chart of accounts** uploaded via **CSV** (user or admin).

---

## 2. Architecture

Account context is established two ways:

- **Dashboard requests**: from the logged-in user's session.
- **Incoming bills (Wazzup webhook)**: from the channel id in the webhook, which
  maps to exactly one account.

Every row of data carries an `account_id`, and every query is scoped by it, so
no customer can ever see another's data.

Storage: **MySQL on DigitalOcean** (managed, SSL required). Outbound WhatsApp for
invites and system notifications goes through a single **FusionETA system Wazzup
channel** (separate from each customer's bill-receiving channels).

---

## 3. Database schema (MySQL)

```sql
-- Customers. Ayu Borneo becomes the first row.
CREATE TABLE accounts (
  id                BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name              VARCHAR(255) NOT NULL,
  status            ENUM('active','suspended','trial') DEFAULT 'active',
  ai_provider       VARCHAR(32)  DEFAULT 'gemini',
  ai_model          VARCHAR(64)  DEFAULT 'gemini-2.5-flash',
  ai_prompt_addon   TEXT,                          -- per-account prompt extra (ADMIN only)
  auto_create_bills TINYINT(1) DEFAULT 0,
  created_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at        DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- Global key/value, ADMIN only. Holds the general base AI prompt, etc.
CREATE TABLE app_settings (
  `key`      VARCHAR(64) PRIMARY KEY,              -- e.g. 'general_ai_prompt'
  value      MEDIUMTEXT,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- Login identities. Email is the identifier. Supports Google AND password.
CREATE TABLE users (
  id             BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  account_id     BIGINT UNSIGNED NULL,             -- NULL for super admins
  email          VARCHAR(255) NOT NULL UNIQUE,
  google_sub     VARCHAR(255) NULL UNIQUE,         -- Google id; NULL until claimed / password-only
  password_hash  VARBINARY(255) NULL,              -- bcrypt/argon2; NULL if Google-only
  phone_number   VARCHAR(32) NULL,                 -- intl, e.g. 60123456789, for Wazzup invites
  name           VARCHAR(255),
  avatar_url     VARCHAR(512),
  role           ENUM('owner','member') DEFAULT 'owner',
  is_super_admin TINYINT(1) DEFAULT 0,
  status         ENUM('invited','active','disabled') DEFAULT 'invited',
  created_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_login_at  DATETIME,
  FOREIGN KEY (account_id) REFERENCES accounts(id)
);

-- Server-side sessions (revocable).
CREATE TABLE sessions (
  id         CHAR(64) PRIMARY KEY,                 -- random session token
  user_id    BIGINT UNSIGNED NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  expires_at DATETIME NOT NULL,
  ip         VARCHAR(45),
  user_agent VARCHAR(255),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

-- One-time links sent over WhatsApp (invite / password reset).
CREATE TABLE auth_tokens (
  id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id    BIGINT UNSIGNED NOT NULL,
  type       ENUM('invite','password_reset') NOT NULL,
  token_hash CHAR(64) NOT NULL,                    -- store hash, send raw token in link
  expires_at DATETIME NOT NULL,
  used_at    DATETIME NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

-- One OAuth grant per Xero "Connect" action (holds the refresh token).
CREATE TABLE xero_grants (
  id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  account_id    BIGINT UNSIGNED NOT NULL,
  refresh_token VARBINARY(1024) NOT NULL,          -- encrypted at rest
  scope         TEXT,
  obtained_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (account_id) REFERENCES accounts(id)
);

-- One row per connected Xero organisation.
CREATE TABLE xero_connections (
  id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  account_id      BIGINT UNSIGNED NOT NULL,
  grant_id        BIGINT UNSIGNED NOT NULL,
  xero_tenant_id  VARCHAR(64) NOT NULL,
  tenant_name     VARCHAR(255),
  status          ENUM('active','expired','revoked') DEFAULT 'active',
  needs_reconnect TINYINT(1) DEFAULT 0,            -- admin dashboard can flag this
  UNIQUE KEY uq_acct_tenant (account_id, xero_tenant_id),
  FOREIGN KEY (account_id) REFERENCES accounts(id),
  FOREIGN KEY (grant_id)   REFERENCES xero_grants(id)
);

-- The routing key for incoming bills.
CREATE TABLE wazzup_channels (
  id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  account_id BIGINT UNSIGNED NOT NULL,
  channel_id VARCHAR(128) NOT NULL UNIQUE,         -- maps inbound webhook to one account
  api_key    VARBINARY(512),                       -- encrypted at rest
  label      VARCHAR(255),
  status     ENUM('active','disabled') DEFAULT 'active',
  FOREIGN KEY (account_id) REFERENCES accounts(id)
);

-- Per-account chart of accounts. Uploaded via CSV by user OR admin.
CREATE TABLE coa_accounts (
  id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  account_id BIGINT UNSIGNED NOT NULL,
  code       VARCHAR(32) NOT NULL,
  name       VARCHAR(255) NOT NULL,
  category   VARCHAR(64),
  UNIQUE KEY uq_acct_code (account_id, code),
  FOREIGN KEY (account_id) REFERENCES accounts(id)
);

-- Every bill attempt and its outcome. The analytics core.
CREATE TABLE bills (
  id                 BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  account_id         BIGINT UNSIGNED NOT NULL,
  xero_connection_id BIGINT UNSIGNED NULL,         -- NULL if failed before routing
  wazzup_channel_id  BIGINT UNSIGNED NULL,         -- NULL for web uploads
  chat_id            VARCHAR(128),
  status             ENUM('success','failed','pending','skipped') NOT NULL,
  failure_reason     VARCHAR(512),                 -- the "why failed"
  supplier           VARCHAR(255),
  invoice_no         VARCHAR(128),
  total              DECIMAL(14,2),
  currency           VARCHAR(8),
  document_type      VARCHAR(32),
  xero_invoice_id    VARCHAR(64),
  xero_url           VARCHAR(512),
  source             VARCHAR(32),                  -- whatsapp / web
  created_at         DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (account_id) REFERENCES accounts(id),
  INDEX idx_acct_status_created (account_id, status, created_at)
);

-- Per-chat picker state. Replaces whatsapp-state.json.
CREATE TABLE whatsapp_chat_state (
  chat_id    VARCHAR(128) PRIMARY KEY,
  account_id BIGINT UNSIGNED NOT NULL,
  state      JSON,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (account_id) REFERENCES accounts(id)
);
```

---

## 4. Auth and onboarding

Both Google sign-in and email/password are supported. Email is the shared
identifier, so a user can use either method to reach the same account.

### Invite flow (managed onboarding, WhatsApp not email)
1. Admin creates the account and a user row with the customer's **email + phone**
   (`status = 'invited'`).
2. System creates a one-time `auth_tokens` row (`type = 'invite'`) and sends a
   WhatsApp message from the **FusionETA system channel**:
   "You've been set up on [app]. Tap to log in / set your password: <link?token=...>"
3. Customer taps the link and either:
   - signs in with **Google** using the invited email, or
   - sets a **password**.
   Either way they match on the invited email and land in the pre-set account.
   On success the user becomes `status = 'active'`.

### Claim-on-first-login (Google)
On Google login we read `email`, `google_sub`, `email_verified`:
1. Look up by `google_sub`. Found -> log in.
2. Else look up by **verified email**. If a pending invited user exists, attach
   the `google_sub` to it and log in (claims the pre-set account).
3. Else -> reject (see policy below).

### Signup policy
**Reject unless invited.** No stray self-serve accounts. Can be switched to
auto-create-trial later if self-serve signup is ever wanted.

### Password handling
- Hashed with bcrypt or argon2, never plaintext.
- Reset works like invite: WhatsApp a `password_reset` token link to the
  registered phone.
- Login rate limiting / lockout to prevent brute force.

---

## 5. AI prompt layering and COA

The prompt the model sees is assembled at bill time as:

```
[general base prompt]  +  [account admin add-on]  +  [account COA list]  +  [account Xero org list]
```

| Piece                    | Who manages it          | Where it lives                  |
|--------------------------|-------------------------|---------------------------------|
| General base AI prompt   | Admin only (shared)     | app_settings 'general_ai_prompt'|
| Per-account prompt add-on| Admin only              | accounts.ai_prompt_addon        |
| COA list (CSV upload)    | User and Admin          | coa_accounts rows (per account) |

- Users never edit prompt text. They only upload their COA CSV.
- COA CSV format: `code,name,category` (one row per account). Each upload
  replaces that account's `coa_accounts`.
- The COA injected into the prompt is whatever that account uploaded, so each
  customer gets their own accounts, not Ayu Borneo's.

---

## 6. Request flows

### Incoming bill (Wazzup webhook)
1. Webhook arrives with a channel id.
2. Look up `wazzup_channels.channel_id` -> account.
3. Load that account's Xero connections, COA, AI settings, prompt add-on.
4. Run the existing extraction pipeline (Gemini vision, discount, COA matching,
   invoice number, document routing).
5. Write one `bills` row with `status` success / failed / pending / skipped and a
   `failure_reason` when it fails.

### Dashboard
- User logs in, sees only their account's connections, settings, success counter.
- Admin logs in, sees the list of all accounts and can drill into any one.

---

## 7. Counters and analytics

No stored counter to drift. Everything is derived from `bills`:

- User success counter:
  `SELECT COUNT(*) FROM bills WHERE account_id = ? AND status = 'success'`
- Admin drilldown:
  `SELECT status, failure_reason, COUNT(*) FROM bills
   WHERE account_id = ? GROUP BY status, failure_reason`

Because each bill row is written in one atomic transaction, counts stay correct
even under concurrent load. This is the accuracy problem JSON could not solve.

---

## 8. Admin (FusionETA)

`is_super_admin` users get a cross-account view:
- List of all accounts with health (success rate, last activity, reconnect flags).
- Per-account drilldown: success / failed / pending counts, failure reasons.
- Edit per-account config: AI model, prompt add-on, Wazzup channels, COA, status.
- Manage the global general AI prompt.
- Send / resend invites.

---

## 9. Security

- Xero refresh tokens and Wazzup API keys **encrypted at rest** (AES-256-GCM,
  key from env), never plaintext.
- DigitalOcean managed MySQL requires **SSL**; connection uses their CA cert.
- Passwords hashed (bcrypt/argon2). Sessions are server-side and revocable.
- Every query scoped by `account_id`; admin routes gated by `is_super_admin`.
- One-time tokens (invite/reset) are single-use and expiring; only the hash is
  stored.

---

## 10. Secrets / env

```
DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD, DB_CA_CERT     # DigitalOcean MySQL
APP_ENCRYPTION_KEY                                              # AES key for token encryption
SESSION_SECRET
GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI
XERO_CLIENT_ID, XERO_CLIENT_SECRET, XERO_REDIRECT_URI           # existing
GEMINI_API_KEY                                                  # existing
FUSION_WAZZUP_CHANNEL_ID, FUSION_WAZZUP_API_KEY                 # system channel for invites/notices
PUBLIC_APP_URL
```

---

## 11. Codebase restructure

`server.js` (~3000 lines) is split into modules, plus a data layer:

```
/db          mysql2 pool (SSL), query helpers, schema + migrations
/auth        Google OAuth, email/password, sessions, requireAuth / requireSuperAdmin
/accounts    account + user model, invites (Wazzup), claim flow
/xero        connect, token refresh, bill creation (existing logic, now account-scoped)
/wazzup      channel config, inbound webhook routing, system-channel sender
/bills       create, log outcome, list, stats
/coa         per-account COA, CSV import, matching (existing logic)
/admin       cross-account views and config editing
/web         dashboard routes + existing UI, now behind auth
```

The extraction logic already built (Gemini vision, discount handling, COA
matching, invoice-number, document routing) stays the same. What changes is
**where data is read/written** and that **everything runs in an account context**.

---

## 12. Migration of Ayu Borneo (JSON -> MySQL)

One-time migration script:
- Create account "Ayu Borneo".
- `xero-tokens.json` -> `xero_grants` + `xero_connections`.
- `bills.json` -> `bills` (status success).
- `pending-bills.json` -> `bills` (status pending).
- `master-coa.json` -> `coa_accounts`.
- `ai-settings.json` -> account settings.
- `.env` Wazzup channel -> `wazzup_channels`.

### Will the Xero connection break?
No, if we cut over cleanly. The connection is just OAuth tokens; moving the exact
refresh token + tenant ids into MySQL preserves it (same client creds and
redirect URI, no re-consent). The one risk: **Xero refresh tokens are single-use
and rotate on every refresh**. So:
1. Build and test the DB layer.
2. Briefly stop the old app.
3. Run the migration (copies the current valid token).
4. Start the new DB-backed app as the only token refresher.

Never run old (JSON) and new (DB) at once, or one rotates the token and breaks the
other. Worst-case fallback is a one-click "Connect to Xero" re-auth. No data lost
either way.

---

## 13. Phased rollout

Each step is shippable and does not break the existing flow.

1. **DB foundation**: schema + mysql2 pool (SSL) + migrate Ayu Borneo. No
   behaviour change; app now DB-backed.
2. **Bills logging**: write every attempt with success/failed/reason, so the
   counter and admin data start filling.
3. **Auth + accounts**: Google + password login, invite via Wazzup, dashboard
   scoped to the logged-in account, user success counter.
4. **Self-serve config**: per-account Xero connect, Wazzup channels, COA CSV
   upload.
5. **Admin dashboard**: all accounts, per-account drilldown of success/failed/why,
   edit config, manage general prompt, send invites.

---

## 14. Open items to confirm

- Final hosting target for the Node app (same cPanel, or move to DigitalOcean
  alongside the DB).
- Whether multiple users per account is needed now, or one user per account to
  start (schema already supports many).
- Data retention for `bills` (keep forever vs archive old rows).
