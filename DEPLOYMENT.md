# WazzOCR — Deployment & Migration Handoff

This release adds a **multi-tenant management layer** (accounts, login, admin
dashboard, per-account config, bill analytics) on top of the existing WhatsApp →
Xero pipeline, backed by a **MySQL database on DigitalOcean**.

The existing live flow is **not changed in behaviour** — see "Safety" below.
This document is for whoever deploys on the server. No secrets are included here;
get the actual values from the project's local `.env`.

---

## 0b. Latest update — plans & phone restriction (server checklist)

Adds a **plan** per account (`trial` / `paid`) and a per-channel **phone
restriction** (only listed sender numbers may use a channel; others are silently
ignored). Trial accounts share one Wazzup channel and are routed by sender phone.

Changed files: `server.js` (new `/api/whatsapp/authorize`), `webhook.php` (auth
gate), `admin.html`, `account.html`, plus new models/libs. **Deploy both
`server.js` and `webhook.php`.**

1. Run the migration (idempotent). It **backfills every existing account to
   `paid`** and leaves phone restriction **off**, so live clients (Ayu Borneo)
   are unaffected. New accounts default to `trial`.
   ```bash
   node scripts/add-plans-and-phone-restriction.js
   ```
   No new env vars.
2. **Activate the trial plan when ready** (optional, in the Admin UI):
   - Accounts page → *Trial default channel* → confirm the channel id
     (seeded to the Fusion Demo Wazzup channel).
   - Open that channel's account (Zi Rong Test) → Connections → set the channel
     to **🔒 Restricted**, and add the numbers allowed on it (including your own
     test number, or it'll stop processing your messages).
   - For each trial account: set plan = `trial`, then add their phone number(s)
     under Connections → *Allowed phone numbers*.
3. Restart the Node app.

Verify: `node scripts/db-test.js` lists `wazzup_channel_phones`; the admin account
page shows a **Plan** dropdown; a restricted channel ignores messages from
unlisted numbers.

---

## 0. Latest update — error tickets (server checklist)

This release adds **support-ticket error tracking + admin WhatsApp alerts**.
Customers now get a generic message with a reference code (e.g. `WZ-7K3M9Q`)
instead of raw errors like "JSON not parsed"; every error is recorded in a new
`support_tickets` table and you look codes up in **Admin → Tickets**.

**Two files changed: `server.js` (Node bridge) AND `webhook.php` (public
webhook receiver) — deploy BOTH.** If they're served from different locations,
upload each to its own location. After pulling the new code on the server:

1. Create the new table (idempotent — safe to re-run):
   ```bash
   node scripts/add-support-tickets-table.js
   ```
2. Add **one** new line to `.env` — the admin phone(s) to alert on each error
   (comma-separated, international digits only, no `+` or spaces):
   ```
   WAZZUP_ERROR_NOTIFY_PHONES=60123456789,60198765432
   ```
   - This is the **only** new env var. Leave it **empty** (or omit it) to still
     record tickets in the DB but send no WhatsApp alert.
   - No other credentials are needed: the alert is sent from the **existing**
     system Wazzup channel already configured via `WAZZUP_CHANNEL_ID` /
     `WAZZUP_API_KEY` (or `FUSION_WAZZUP_CHANNEL_ID` / `FUSION_WAZZUP_API_KEY`
     if you set those). If neither is set, tickets are still recorded — only the
     WhatsApp alert is skipped (logged as a warning).
3. Make sure the updated **`webhook.php`** is in place wherever the public
   webhook is served (it calls the Node bridge to mint tickets).
4. Restart the Node app (your usual PM2 / systemd command).

**How to verify the server supports this upgrade** (after the steps above):
- `node scripts/db-test.js` → the printed table list now includes
  **`support_tickets`**.
- Re-running `node scripts/add-support-tickets-table.js` prints
  *"Table support_tickets already exists — nothing to do."*
- Log in to the admin dashboard → the top bar shows a **Tickets** tab and the
  Tickets page loads (empty until the first error).
- End-to-end (optional): send a deliberately bad file on a registered channel →
  the customer gets the generic *"reference WZ-…"* message (not a raw error), a
  row appears under **Admin → Tickets**, and — if `WAZZUP_ERROR_NOTIFY_PHONES`
  is set — the admin phone receives a WhatsApp alert.

Nothing else changes; no data migration, no behaviour change to the happy path.

---

## 1. What changed (code)

New backend modules and pages were added; the core pipeline (`server.js`,
`webhook.php`) is mostly unchanged except for additive hooks.

New / changed:
- `db/` — MySQL connection (verified TLS) + `schema.sql`.
- `models/` — accounts, users, bills, coa, wazzup channels, xero connections, settings.
- `auth/`, `admin/`, `user/` — login/session/invite + admin & user API routers.
- `lib/` — crypto (token/key encryption), csv, wazzup sender, tokens.
- `scripts/` — `db-migrate.js`, `create-admin.js`, `migrate-legacy-data.js`, `db-test.js`.
- HTML pages: `login.html`, `claim.html`, `reset.html`, `account.html`, `admin.html`.
- `server.js` — mounts `/auth`, `/admin`, `/api/me`; logs bill outcomes to MySQL
  **only when a Wazzup channel is registered in the DB** (otherwise no-op).
- `webhook.php` — forwards `channelId` to the bridge; now shows customers a
  generic message + ticket code on error instead of the raw error text.
- `index.html` — Scan tab removed; now requires login (redirects to `/login.html`).
- **Error tickets (this release):** `support_tickets` table, `models/supportTickets.js`,
  `lib/errorNotify.js`, `scripts/add-support-tickets-table.js`, a Tickets view in
  `admin.html`, and `/admin/tickets` API routes. See section 0 for the deploy steps.
- New dependency: **`mysql2`** (run `npm install`).

---

## 2. New runtime requirements

### a) Install the new dependency
```bash
npm install        # picks up mysql2 from package.json
```

### b) Environment variables (add to the server's `.env`)
These are **gitignored**, so they are NOT pushed — add them on the server:
```
DB_HOST=<digitalocean mysql host>
DB_PORT=25060
DB_NAME=wazzocr
DB_USER=<db user>
DB_PASSWORD=<db password>
DB_CA_CERT=./certs/do-ca.crt
APP_ENCRYPTION_KEY=<64-hex-char key — MUST match the value used locally>
```
> `APP_ENCRYPTION_KEY` is critical: Wazzup API keys and Xero tokens are stored
> AES-encrypted in the shared DB. The server must use the **same key** that
> encrypted them, or it can't decrypt. Copy it verbatim from local `.env`.

**Error alerting (optional but recommended):**
```
WAZZUP_ERROR_NOTIFY_PHONES=60123456789,60198765432
```
> When the pipeline errors, the customer now gets a generic message with a
> ticket code (e.g. `WZ-7K3M9Q`) instead of a raw stack/JSON error, and the
> failure is recorded in the `support_tickets` table. If this var is set, the
> on-call admin phone(s) also get a WhatsApp alert (sent from the FusionETA
> system channel; deduped to one per identical error / 10 min). Leave empty to
> record tickets without sending alerts. Run the migration once:
> `node scripts/add-support-tickets-table.js`.

### c) The DigitalOcean CA certificate (file)
DigitalOcean MySQL requires verified TLS. Provide the CA cert one of two ways:
- **File:** upload `certs/do-ca.crt` to the server (it's gitignored), keep
  `DB_CA_CERT=./certs/do-ca.crt`, **or**
- **Inline:** set `DB_CA_CERT_PEM="-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----"`
  in `.env` (the code checks this first, falls back to the file).

Upload over SSH:
```bash
ssh USER@SERVER 'mkdir -p /path/to/app/certs'
scp certs/do-ca.crt USER@SERVER:/path/to/app/certs/do-ca.crt
```

### d) Database schema
The schema already exists on the shared DB, but the migrate script is
idempotent (`CREATE TABLE IF NOT EXISTS`), so it's safe to (re)run:
```bash
node scripts/db-migrate.js
```

### e) Verify connectivity
```bash
node scripts/db-test.js     # prints "Connected OK" + lists every table by name
```
The list should include `support_tickets` once this release's migration has run.

---

## 3. Safety — why the live flow will NOT break

- **Bill logging is additive and lazy.** The pipeline writes to MySQL only when
  the incoming Wazzup channel is **registered in the DB**. Until you register
  Ayu Borneo's channel, the WhatsApp → Xero flow runs exactly as before and
  nothing is written to MySQL. Any DB error in logging is swallowed and never
  blocks bill creation.
- **The `data/` JSON files are untouched.** `xero-tokens.json`, `bills.json`,
  `pending-bills.json`, etc. are still read/written by the live flow. The
  migration script reads them **read-only**.
- **`db/index.js` is lazy** — it only connects on the first auth/admin request,
  so a missing DB config can't crash startup of the existing endpoints.
- **One behaviour change to confirm:** `index.html` (the web dashboard) now
  requires a login. After deploy, dashboard users need an account (create the
  first admin with `node scripts/create-admin.js <email> <password> "<name>"`).
  The WhatsApp webhook flow itself needs no login.

---

## 4. Migrating the old data → new database

### What old data exists (in `data/` on the server)
| File | Contents | Target |
|---|---|---|
| `bills.json` | created Xero bills history | `bills` (status=success) |
| `pending-bills.json` | unmatched/queued bills | `bills` (status=pending) |
| `ai-settings.json` | provider + model | account settings |
| `master-coa.json` (repo root) | Ayu Borneo COA | `coa_accounts` |
| `.env WAZZUP_CHANNEL_ID` | the WhatsApp channel | `wazzup_channels` |
| `xero-tokens.json` | Xero OAuth tokens | **NOT migrated** (reconnect fresh) |

### The migration script (idempotent, safe to re-run)
```bash
node scripts/migrate-legacy-data.js
# optional: --account="Ayu Borneo"   (default name)
```
It will:
1. Create the "Ayu Borneo" account (if missing).
2. Apply `ai-settings.json` to the account.
3. Seed the account's COA from `master-coa.json` (only if empty).
4. Register the Wazzup channel from `.env` (only if not already linked).
5. Import historical bills from `bills.json` + `pending-bills.json`
   (only if the account currently has zero bills, to avoid duplicates).

It does **not** migrate Xero tokens and does **not** modify any `data/` file.

### Recommended cutover order (zero downtime)
1. Deploy code, `npm install`, add `.env` vars + CA cert, run `db-test.js`.
2. `node scripts/create-admin.js <you@…> <password> "<name>"` (your admin login).
3. `node scripts/migrate-legacy-data.js` (seeds account + COA + channel + history).
4. Restart the Node app.
5. Send one test bill on the registered channel → confirm it appears in the
   admin dashboard and the WhatsApp reply is unchanged.

---

## 5. Questions for the server/ops side

1. **Process manager & restart:** how is `server.js` run (PM2 / systemd /
   Passenger / pm2-cpanel)? We need the correct restart command after deploy.
2. **App directory** on the server (where `server.js` lives) — for the scp paths.
3. **Outbound network:** can the server reach `*.db.ondigitalocean.com:25060`
   (TLS)? DigitalOcean DBs often need the server's IP added to the **trusted
   sources / firewall**. Please confirm or add the server IP.
4. **`.env` + cert transfer:** confirm the secure method to place `.env` values
   and `certs/do-ca.crt` on the server (we'll provide them out-of-band).
5. Any objection to `index.html` now requiring login for the web dashboard?

Once 1–4 are confirmed we can do the cutover in the order in section 4.
