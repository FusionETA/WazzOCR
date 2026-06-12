// Seed the AI prompts into the database.
//
//   • app_settings.general_ai_prompt  ← the shipped DEFAULT_GENERAL_PROMPT
//       (the account-agnostic base instructions; admin-editable afterwards).
//   • accounts.ai_prompt_addon (Ayu Borneo) ← the Ayu-Borneo-specific name /
//       branch / "fka" matching rules.
//
// SAFE / IDEMPOTENT: re-running just rewrites the same values. By default it
// does NOT overwrite a general prompt that's already customised in the DB —
// pass --force-general to overwrite it with the shipped default.
//
//   node scripts/seed-ai-prompts.js
//   node scripts/seed-ai-prompts.js --account="Ayu Borneo" --force-general

require('dotenv').config();
const db = require('../db');
const accounts = require('../models/accounts');
const appSettings = require('../models/appSettings');
const { DEFAULT_GENERAL_PROMPT } = require('../lib/defaultPrompts');

const GENERAL_PROMPT_KEY = 'general_ai_prompt';
const ACCOUNT_NAME = (process.argv.find((a) => a.startsWith('--account=')) || '').split('=')[1] || 'Ayu Borneo';
const FORCE_GENERAL = process.argv.includes('--force-general');

// Account-specific add-on for the Ayu Borneo group. These are the rules that
// used to be hardcoded inside buildBillPrompt and are specific to this account's
// connected Xero organisations (their branch codes and renamed entities).
const AYU_BORNEO_ADDON = `These rules apply to the Ayu Borneo group's connected organisations listed above.

"c/o" examples for this group:
- "AYU BORNEO (SP) SDN BHD C/O EMJ RENOVATION SDN BHD"
    → billedTo = "Ayu Borneo (SP) Sdn Bhd"   (match this in the list)
    → billedToVerbatim = "AYU BORNEO (SP) SDN BHD C/O EMJ RENOVATION SDN BHD"
- "Nova Spa & Wellness Sdn Bhd c/o Universe Wellness HQ"
    → billedTo = "Ayu Borneo Nova SB fka Nova Spa & Wellness Sdn Bhd"
    → billedToVerbatim = "Nova Spa & Wellness Sdn Bhd c/o Universe Wellness HQ"

Branch abbreviations map to these organisations:
    (SP) = Sri Petaling → "Ayu Borneo (SP) Sdn Bhd"
    (KL) = Kuala Lumpur     (PJ) = Petaling Jaya     (JB) = Johor Bahru
    (KK) = Kota Kinabalu    (KCH) = Kuching          (KJ) = Kelana Jaya
    (SJ) = Subang Jaya      (AP) = Ampang            (BLK) = Bandar Bukit Tinggi
    (BSP) = Bandar Sri Permaisuri
If the invoice says "Ayu Borneo Sri Petaling" or "Ayu Borneo SP" → return "Ayu Borneo (SP) Sdn Bhd". Apply the same branch logic to whichever listed entry carries that branch code.
Plain "Ayu Borneo Sdn Bhd" with NO branch indicator → match the plain "Ayu Borneo Sdn Bhd" entry only (not a branch entry).

"fka" (formerly known as) mappings for this group:
- "Borneo Oasis Wellness SB fka Ayu Borneo (VC3) Sdn Bhd" — current name Borneo Oasis Wellness Sdn Bhd, formerly Ayu Borneo (VC3) Sdn Bhd.
    * Invoice "Borneo Oasis Wellness Sdn Bhd" → this entry.
    * Invoice "Ayu Borneo (VC3) Sdn Bhd" → this entry.
- "Ayu Borneo Nova SB fka Nova Spa & Wellness Sdn Bhd" — current name Ayu Borneo Nova Sdn Bhd, formerly Nova Spa & Wellness Sdn Bhd.
    * Invoice "Ayu Borneo Nova Sdn Bhd" → this entry.
    * Invoice "Nova Spa & Wellness Sdn Bhd" → this entry.

Prefix-collision in this list (different companies sharing a prefix):
- "Borneo Oasis Wellness SB fka …(VC3)…"      → current = Borneo Oasis Wellness Sdn Bhd
- "Borneo Oasis Wellness & Spa SB fka …(VC4)…" → current = Borneo Oasis Wellness & Spa Sdn Bhd
If the invoice says exactly "Borneo Oasis Wellness Sdn Bhd" (no "& Spa"), it is the VC3 entity, NOT the VC4 "& Spa" entity. Only pick "& Spa" when the invoice itself contains "& Spa" or "and Spa".`;

(async () => {
  console.log('\n=== Seeding AI prompts ===');

  // 1. General base prompt → app_settings.
  const existingGeneral = (await appSettings.get(GENERAL_PROMPT_KEY, '')) || '';
  if (existingGeneral.trim() && !FORCE_GENERAL) {
    console.log(`  General prompt already set (${existingGeneral.length} chars) — leaving as-is (pass --force-general to overwrite).`);
  } else {
    await appSettings.set(GENERAL_PROMPT_KEY, DEFAULT_GENERAL_PROMPT);
    console.log(`  General prompt seeded (${DEFAULT_GENERAL_PROMPT.length} chars).`);
  }

  // 2. Ayu Borneo add-on → accounts.ai_prompt_addon.
  const account = (await accounts.list()).find((a) => a.name === ACCOUNT_NAME);
  if (!account) {
    console.log(`  Account "${ACCOUNT_NAME}" not found — skipped the add-on. (Run the legacy migration first, or pass --account=.)`);
  } else {
    const updated = await accounts.update(account.id, { aiPromptAddon: AYU_BORNEO_ADDON });
    console.log(`  Add-on seeded for "${ACCOUNT_NAME}" (id=${account.id}, ${AYU_BORNEO_ADDON.length} chars, ${updated} row updated).`);
  }

  console.log('\nDone.\n');
  await db.close();
})().catch((err) => { console.error('Seed FAILED:', err.message); process.exit(1); });
