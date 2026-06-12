// One-time migration: move the legacy single-field prompts into the modular
// ai_prompt_blocks table.
//   • app_settings.general_ai_prompt  → one GENERAL block titled "Base prompt".
//   • accounts.ai_prompt_addon (each)  → one per-account block "<name> add-on".
//
// SAFE / IDEMPOTENT:
//   - Creates a general block only if there are NO general blocks yet.
//   - Creates an account's add-on block only if that account has NO blocks yet.
//   - Leaves the legacy columns untouched (kept as a fallback).
//
//   node scripts/migrate-prompts-to-blocks.js

require('dotenv').config();
const db = require('../db');
const accounts = require('../models/accounts');
const appSettings = require('../models/appSettings');
const aiPrompts = require('../models/aiPrompts');

(async () => {
  console.log('\n=== Migrating prompts → ai_prompt_blocks ===');

  // 1. General prompt → a single general block (if none exist).
  const generalBlocks = await aiPrompts.listGeneral();
  if (generalBlocks.length) {
    console.log(`  ${generalBlocks.length} general block(s) already exist — skipped.`);
  } else {
    const legacy = (await appSettings.get('general_ai_prompt', '')) || '';
    if (legacy.trim()) {
      const id = await aiPrompts.create({ accountId: null, title: 'Base prompt', body: legacy, enabled: true });
      console.log(`  General "Base prompt" block created (id=${id}, ${legacy.length} chars).`);
    } else {
      console.log('  No legacy general_ai_prompt to migrate — skipped.');
    }
  }

  // 2. Each account's add-on → a per-account block (if that account has none).
  const all = await accounts.list();
  let made = 0, skipped = 0;
  for (const a of all) {
    const existing = await aiPrompts.listByAccount(a.id);
    if (existing.length) { skipped++; continue; }
    const addon = (a.ai_prompt_addon || '').trim();
    if (!addon) { skipped++; continue; }
    await aiPrompts.create({ accountId: a.id, title: `${a.name} add-on`, body: addon, enabled: true });
    made++;
    console.log(`  Add-on block created for "${a.name}" (id=${a.id}, ${addon.length} chars).`);
  }
  console.log(`  Account add-ons: ${made} created, ${skipped} skipped.`);

  console.log('\nDone.\n');
  await db.close();
})().catch((err) => { console.error('Migration FAILED:', err.message); process.exit(1); });
