// Tests for choosing the Xero organisation from the name on a bill.
// No network, no DB — the org list below mirrors the Ayu Borneo group.
// Run: node scripts/test-org-matching.js
const assert = require('assert');
const { matchTenantByName, scoreMatch, isUtilitySupplier } = require('../server');

const ORGS = [
  'Ayu Borneo Sdn Bhd', 'Ayu Borneo Nova Sdn Bhd', 'Ayu Borneo (KK) Sdn Bhd',
  'Ayu Borneo (KJ) Sdn Bhd', 'Ayu Borneo (KJ TTDI) Sdn. Bhd.', 'Ayu Borneo (SP) Sdn Bhd',
  'Ayu Borneo (Management) Sdn Bhd', 'Ayu Borneo (Sabah) Sdn Bhd', 'Ayu Borneo (Bangi) Sdn Bhd',
  'EMJ Renovation Sdn Bhd', 'EM J Design & Build Sdn Bhd', 'Universe Wellness (HQ) Sdn Bhd'
].map((tenantName) => ({ tenantName, tenantId: tenantName }));

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok  ${name}`); }
  catch (err) { console.error(`  FAIL ${name}\n       ${err.message}`); process.exitCode = 1; }
}
const match = (s) => { const m = matchTenantByName(s, ORGS); return m ? m.tenantName : null; };

console.log('branch codes');

// The bug this suite exists for: (MK) is not a connected org, but
// "Ayu Borneo Nova" is "Ayu Borneo" plus a word, so prefix matching scored it
// 95 and every unconnected branch was filed into Nova.
test('a branch that is not connected goes to a human, not to Nova', () => {
  for (const s of ['AYU BORNEO (MK) SDN BHD', 'Ayu Borneo (XYZ) Sdn Bhd', 'Ayu Borneo (VC99) Sdn Bhd'])
    assert.strictEqual(match(s), null, `${s} should not match anything`);
});

test('a branch bill never falls back to the plain parent company', () => {
  assert.strictEqual(scoreMatch('Ayu Borneo (MK) Sdn Bhd', 'Ayu Borneo Sdn Bhd').reason, 'branch-missing');
  assert.ok(scoreMatch('Ayu Borneo (MK) Sdn Bhd', 'Ayu Borneo Sdn Bhd').score < 70);
});

test('a connected branch still matches itself', () => {
  for (const o of ORGS) assert.strictEqual(match(o.tenantName), o.tenantName);
});

test('branch codes are not interchangeable', () => {
  assert.strictEqual(match('Ayu Borneo (KJ) Sdn Bhd'), 'Ayu Borneo (KJ) Sdn Bhd');
  assert.strictEqual(match('Ayu Borneo (KJ TTDI) Sdn Bhd'), 'Ayu Borneo (KJ TTDI) Sdn. Bhd.');
});

// Suppliers write the branch however they like; all three forms are one company.
test('a branch spelled out, abbreviated or bracketed all reach the same org', () => {
  assert.strictEqual(match('Ayu Borneo Sri Petaling Sdn Bhd'), 'Ayu Borneo (SP) Sdn Bhd');
  assert.strictEqual(match('Ayu Borneo SP'), 'Ayu Borneo (SP) Sdn Bhd');
  assert.strictEqual(match('AYU BORNEO (SP) SDN.BHD'), 'Ayu Borneo (SP) Sdn Bhd');
  assert.strictEqual(match('Ayu Borneo KK Sdn Bhd'), 'Ayu Borneo (KK) Sdn Bhd');
  assert.strictEqual(match('AYU BORNEO MANAGEMENT SDN BHD'), 'Ayu Borneo (Management) Sdn Bhd');
});

test('a plain name matches the plain entity, not a branch', () => {
  assert.strictEqual(match('AYU BORNEO SDN.BHD'), 'Ayu Borneo Sdn Bhd');
});

test('a dead former name is not matched to the live lookalike', () => {
  // "Universe Wellness (HQ)" is a different, active company; the plain former
  // name belongs to Ayu Borneo Sdn Bhd and only the AI knows that mapping.
  assert.strictEqual(match('Universe Wellness Sdn Bhd'), null);
});

console.log('\nprefix collisions and typos');

test('EMJ Renovation and EM J Design & Build stay apart', () => {
  assert.strictEqual(match('EMJ Renovation Sdn Bhd'), 'EMJ Renovation Sdn Bhd');
  assert.strictEqual(match('EM J Design & Build Sdn Bhd'), 'EM J Design & Build Sdn Bhd');
});

test("the supplier's typo still resolves", () => {
  assert.strictEqual(match('EMJ Renovaton Sdn Bhd'), 'EMJ Renovation Sdn Bhd');
});

test('each half of a c/o bill matches its own company', () => {
  assert.strictEqual(match('Ayu Borneo ( KJ TTDI ) Sdn Bhd'), 'Ayu Borneo (KJ TTDI) Sdn. Bhd.');
  assert.strictEqual(match('EMJ Renovaton Sdn Bhd'), 'EMJ Renovation Sdn Bhd');
});

console.log('\nutility suppliers');

// These four bill by premises. isUtilitySupplier decides one thing only: that
// the printed BILL TO text must not override the org already chosen, because
// on these bills it is usually the landlord's name and, where it does name one
// of ours, the account-number table outranks it. Name matching itself still
// runs — a utility bill addressed to a connected company files to it.
test('the four premises-billed utilities are recognised', () => {
  for (const s of ['Tenaga Nasional Berhad', 'TENAGA NASIONAL BERHAD - WM 1-1',
                   'Pengurusan Air Selangor Sdn. Bhd.', 'Air Selangor',
                   'RANHILL SAJ SDN. BHD.', 'INDAH WATER KONSORTIUM SDN BHD'])
    assert.strictEqual(isUtilitySupplier(s), true, s);
});

test('ordinary suppliers are not treated as utilities', () => {
  for (const s of ['J & L ELECTRICAL ENTERPRISE', 'CUZCO WATER SDN. BHD.',
                   'FEEL COOL AIR-CONDITIONING & ELECTRICAL', 'EPITRONIC SDN BHD',
                   'GENTING UTILITIES & SERVICES SDN. BHD', ''])
    assert.strictEqual(isUtilitySupplier(s), false, s);
});

console.log(`\n${passed} passed${process.exitCode ? ' (with failures)' : ''}`);
process.exit(process.exitCode || 0);
