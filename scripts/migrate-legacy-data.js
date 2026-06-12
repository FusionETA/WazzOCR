// One-time migration of the existing single-tenant Ayu Borneo data (JSON files
// in data/) into the multi-tenant MySQL database.
//
// SAFE / IDEMPOTENT:
//   - Creates the "Ayu Borneo" account only if it doesn't exist.
//   - Seeds COA only if the account has none.
//   - Registers the Wazzup channel only if not already present.
//   - Imports historical bills only if the account currently has zero bills
//     (so re-running won't create duplicates).
//   - Migrates the Xero refresh token + connections (only if the account has
//     none yet) so the existing Xero link carries over with no re-consent.
//   - Does NOT touch the live data/ JSON files (read-only).
//
// CLEAN CUTOVER (Xero refresh tokens are single-use and rotate): stop the old
// app before running this, then start the new DB-based app as the only token
// refresher — otherwise the old and new apps fight over the rotating token.
//
// Run on the server (where data/ holds the live files):
//   node scripts/migrate-legacy-data.js
//
// Add --account="Name" to override the account name (default "Ayu Borneo").

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const db = require('../db');
const accounts = require('../models/accounts');
const coa = require('../models/coa');
const wazzupChannels = require('../models/wazzupChannels');
const xeroConnections = require('../models/xeroConnections');

const DATA_DIR = path.join(__dirname, '..', 'data');
const ACCOUNT_NAME = (process.argv.find((a) => a.startsWith('--account=')) || '').split('=')[1] || 'Ayu Borneo';

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8')); }
  catch { return fallback; }
}
function readRootJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, '..', file), 'utf8')); }
  catch { return fallback; }
}
const asDate = (iso) => { const d = new Date(iso); return isNaN(d) ? new Date() : d; };

(async () => {
  const log = (m) => console.log('  ' + m);
  console.log(`\n=== Legacy data migration → account "${ACCOUNT_NAME}" ===`);

  // 1. Account (find or create)
  let account = (await accounts.list()).find((a) => a.name === ACCOUNT_NAME);
  let accountId;
  if (account) { accountId = account.id; log(`Account exists (id=${accountId}).`); }
  else { accountId = await accounts.create({ name: ACCOUNT_NAME }); log(`Created account id=${accountId}.`); }

  // 2. AI settings (ai-settings.json → account)
  const ai = readJson('ai-settings.json', null);
  if (ai && ai.provider) {
    await accounts.update(accountId, { aiProvider: ai.provider, aiModel: ai.model || undefined });
    log(`AI settings: provider=${ai.provider} model=${ai.model || '(default)'}.`);
  } else { log('No ai-settings.json — leaving account AI defaults.'); }

  // 3. COA (master-coa.json → coa_accounts) — only if empty
  const existingCoa = await coa.list(accountId);
  if (existingCoa.length === 0) {
    const master = readRootJson('master-coa.json', { accounts: [] });
    const rows = (master.accounts || master || []).map((a) => ({ code: a.code, name: a.name, category: a.category }));
    const n = await coa.replaceAll(accountId, rows);
    log(`COA seeded: ${n} codes.`);
  } else { log(`COA already present (${existingCoa.length} codes) — skipped.`); }

  // 4. Wazzup channel (.env WAZZUP_CHANNEL_ID → wazzup_channels) — only if new
  const channelId = process.env.WAZZUP_CHANNEL_ID;
  if (channelId) {
    const already = await wazzupChannels.resolveAccountId(channelId);
    if (already) { log(`Channel ${channelId} already linked (account ${already}) — skipped.`); }
    else {
      await wazzupChannels.add(accountId, { channelId, apiKey: process.env.WAZZUP_API_KEY || null, label: `${ACCOUNT_NAME} (migrated)` });
      log(`Registered Wazzup channel ${channelId}.`);
    }
  } else { log('No WAZZUP_CHANNEL_ID in env — no channel registered.'); }

  // 4b. Xero tokens (xero-tokens.json → xero_grants + xero_connections).
  //     Migrates the refresh token directly so the existing connection carries
  //     over with no re-consent. Only if the account has no connections yet.
  const existingConns = await xeroConnections.listByAccount(accountId);
  if (existingConns.length === 0) {
    const store = readJson('xero-tokens.json', null);
    const grants = (store && Array.isArray(store.grants)) ? store.grants : [];
    let nG = 0, nT = 0;
    for (const g of grants) {
      if (!g.refreshToken) continue;
      const grantId = await xeroConnections.saveGrant(accountId, g.refreshToken, g.scope || null);
      nG++;
      for (const conn of (g.connections || [])) {
        if (!conn.tenantId) continue;
        await xeroConnections.upsertConnection(accountId, grantId, conn.tenantId, conn.tenantName || null);
        nT++;
      }
    }
    log(`Xero migrated: ${nG} grant(s), ${nT} organisation(s).`);
    if (nG) log('IMPORTANT: do a clean cutover — stop the old app first so only the new DB-based app refreshes the (single-use) Xero token.');
  } else {
    log(`Xero already has ${existingConns.length} connection(s) — skipped.`);
  }

  // 5. Historical bills — only if the account has none yet
  const billCountRow = await db.getOne('SELECT COUNT(*) AS n FROM bills WHERE account_id = ?', [accountId]);
  if (Number(billCountRow.n) > 0) {
    log(`Account already has ${billCountRow.n} bills — skipping bill import (avoids duplicates).`);
  } else {
    const created = readJson('bills.json', []);
    const pending = readJson('pending-bills.json', []);
    let nC = 0, nP = 0;
    for (const r of (Array.isArray(created) ? created : [])) {
      await db.execute(
        `INSERT INTO bills (account_id, status, supplier, invoice_no, total, currency, xero_invoice_id, xero_url, xero_tenant_name, source, created_at)
         VALUES (?, 'success', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [accountId, r.supplier || null, r.invoiceNo || r.invoiceNumber || null, r.total ?? null,
         r.currency || null, r.invoiceId || null, r.xeroUrl || null, r.tenantName || null, r.source || 'whatsapp', asDate(r.createdAt)]
      );
      nC++;
    }
    for (const r of (Array.isArray(pending) ? pending : [])) {
      const b = r.bill || {};
      await db.execute(
        `INSERT INTO bills (account_id, status, failure_reason, supplier, invoice_no, total, currency, source, created_at)
         VALUES (?, 'pending', ?, ?, ?, ?, ?, ?, ?)`,
        [accountId, (r.reason || 'Unmatched').slice(0, 500), b.supplier || null, b.invoiceNo || null,
         b.total ?? null, b.currency || null, r.source || 'whatsapp', asDate(r.createdAt)]
      );
      nP++;
    }
    log(`Imported bills: ${nC} created (success) + ${nP} pending.`);
  }

  console.log('\nDone. Xero refresh token migrated — no reconnect needed (clean cutover required).\n');
  await db.close();
})().catch((err) => { console.error('Migration FAILED:', err.message); process.exit(1); });
